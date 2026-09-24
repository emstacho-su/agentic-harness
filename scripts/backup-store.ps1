<#
.SYNOPSIS
    Dump the local store (the harness-postgres container) to a host folder, and
    keep the newest -Keep dumps (R-D3).

.DESCRIPTION
    Runs `pg_dump -Fc` inside the running container through `docker exec` and
    writes the dump to -OutDir as harness-<yyyyMMdd-HHmmss>.dump. In order:

      1. docker must be on PATH, and the container must be running. This script
         never starts Docker or the container: a backup that boots the store is
         a side effect nobody asked for, and a stopped store has nothing new to dump.
      2. The dump goes to <name>.dump.partial first, then is checked: it must
         exist, be non-empty, and start with the custom-format magic `PGDMP`.
         Only then is it renamed to <name>.dump. A failed dump is deleted, so a
         bad night never looks like a backup and never counts toward -Keep.
      3. Older dumps are pruned so that -Keep dumps remain, the new one
         included. Newest by last-write time; only names of the exact form
         harness-<8 digits>-<6 digits>.dump are ever touched.

    The dump is written by cmd.exe's `>`, not PowerShell's. PowerShell 5.1 reads
    a native command's output as lines of text and writes them back re-encoded
    (UTF-16 by default), which corrupts a binary dump. cmd's `>` hands the file
    handle to docker itself, so the bytes land unchanged; the self-test proves
    it with all 256 byte values. Start-Process -RedirectStandardOutput was not
    chosen because 5.1 joins its -ArgumentList into one string with no quoting.

    Why a dump and not a copy of the volume: a volume copy is consistent only
    with the server stopped and restores only into the same Postgres major. A
    dump is taken live and restores into the same or any later major.

    -OutDir should be an ordinary host folder. It is never inside the Docker
    VHDX (the disk image the named volume lives in), so the dump survives a
    Docker reset, a broken VHDX, or `docker compose down -v`.

    RESTORE (from cmd.exe or bash; PowerShell 5.1 has no `<` and would re-encode
    a pipe):

        docker exec -i harness-postgres pg_restore -U harness -d harness --clean --if-exists < <file>

    From PowerShell, wrap it: cmd /c "docker exec -i harness-postgres pg_restore -U harness -d harness --clean --if-exists < C:\path\harness-....dump"

.PARAMETER OutDir
    Where dumps go. Default ~\backups\harness-store. Created if missing.

.PARAMETER Keep
    How many dumps remain after the run, the new one included. Default 14:
    two weeks of nightly dumps. At least 1, so the new dump is never pruned.

.PARAMETER Container
    Default harness-postgres (db/docker-compose.yml), or HARNESS_STORE_CONTAINER
    from the environment or ~/.harness/machine.env. An explicit value wins.

.PARAMETER Database
    Default harness, or HARNESS_STORE_DB from the environment or the machine
    file. An explicit value wins.

.PARAMETER User
    The Postgres role pg_dump connects as. Default harness.

.PARAMETER DryRun
    Check docker and the container, then print the exact command and what would
    be pruned. Writes, creates and removes nothing.

.OUTPUTS
    Exit 0 the dump was written and checked (and pruning, if any, worked).
    Exit 1 the dump was written and checked, but pruning an old one failed.
    Exit 2 no backup was made: docker missing, container not running, a bad
    parameter, pg_dump failed, or the dump was empty or not a custom-format dump.

.EXAMPLE
    ./backup-store.ps1
    ./backup-store.ps1 -DryRun
    ./backup-store.ps1 -OutDir D:/backups/harness -Keep 30
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string] $OutDir = '',
    # The range is checked in the body, not by ValidateRange: a binding failure
    # exits 1, which here means "dump good, prune failed". (A non-number still
    # fails binding; nothing can catch that before the script starts.)
    [int] $Keep = 14,
    [string] $Container = '',
    [string] $Database = '',
    [string] $User = 'harness',
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# Exit codes: "a good dump exists" (0 or 1) must never be confused with "no backup" (2).
$script:ExitOk = 0
$script:ExitPruneFailed = 1
$script:ExitNoBackup = 2

# Names from db/docker-compose.yml; the machine file overrides them per machine.
$script:DefaultContainer = 'harness-postgres'
$script:DefaultDatabase = 'harness'

# The first bytes of every pg_dump custom-format (-Fc) file.
$script:DumpMagic = 'PGDMP'

# Container, database and role names go into a cmd.exe command line, so only
# characters with no meaning to cmd are allowed. Docker and Postgres names fit.
$script:SafeNamePattern = '^[A-Za-z0-9][A-Za-z0-9_.-]*$'

# Only files of exactly this form are ever pruned.
$script:DumpNamePattern = '^harness-\d{8}-\d{6}\.dump$'
$script:TimestampFormat = 'yyyyMMdd-HHmmss'
$script:PartialSuffix = '.partial'

# Set once the checked dump has its final name: from then on an unexpected
# error is "dump good, something after it failed" (1), not "no backup" (2).
$script:DumpWritten = ''

function Fail {
    param([string] $Message, [string] $Fix)
    # Not Write-Error: with $ErrorActionPreference = 'Stop' that would end the
    # script before `exit 2`, and the caller would see exit 1 instead.
    [Console]::Error.WriteLine("$Message`n  Fix: $Fix")
    exit $script:ExitNoBackup
}

# ~/.harness/machine.env: what this machine is. KEY=value, the same file the
# hook and ingest read. A parameter passed explicitly still wins.
function Read-MachineEnv {
    $file = if ($env:HARNESS_MACHINE_ENV) { $env:HARNESS_MACHINE_ENV } else { Join-Path $env:USERPROFILE '.harness\machine.env' }
    $values = @{}
    if (-not (Test-Path $file)) { return $values }
    foreach ($raw in Get-Content $file -Encoding UTF8) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
        $at = $line.IndexOf('=')
        if ($at -lt 1) { continue }
        $key = $line.Substring(0, $at).Trim()
        $value = $line.Substring($at + 1).Trim()
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }
    return $values
}

function Get-MachineSetting {
    param([hashtable] $Machine, [string] $Key, [string] $Default)
    $fromEnv = [Environment]::GetEnvironmentVariable($Key)
    if ($fromEnv) { return $fromEnv }
    if ($Machine.ContainsKey($Key) -and $Machine[$Key]) { return $Machine[$Key] }
    return $Default
}

function Assert-SafeName {
    param([string] $Value, [string] $Label)
    if ($Value -notmatch $script:SafeNamePattern) {
        Fail "-$Label '$Value' has characters this script will not pass to cmd.exe." "Use letters, digits, '_', '.' and '-' only."
    }
}

function Resolve-Docker {
    $found = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) {
        Fail 'docker was not found on PATH.' 'Install Docker Desktop (or the docker CLI), or add its bin folder to PATH. A scheduled task does not inherit your login PATH.'
    }
    return $found.Source
}

function Assert-ContainerRunning {
    param([string] $Docker, [string] $Name)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Docker inspect -f '{{.State.Running}}' $Name 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $text = ((@($output) | ForEach-Object { "$_" }) -join ' ').Trim()
    if ($code -ne 0 -or $text -ne 'true') {
        Fail "container $Name is not running (docker inspect exit $code`: $text)." "Start it yourself (cd db; docker compose up -d); this script never starts it."
    }
}

# Every file this script may prune, newest first, except $Skip.
function Get-OldDumps {
    param([string] $Directory, [string] $Skip)
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $Directory -File |
        Where-Object { $_.Name -match $script:DumpNamePattern -and $_.FullName -ne $Skip } |
        Sort-Object -Property @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, @{ Expression = 'Name'; Descending = $true })
}

# The dumps that go so that $KeepTotal remain, counting the new one.
function Get-PruneList {
    param([object[]] $OldDumps, [int] $KeepTotal)
    $keepOld = $KeepTotal - 1
    if ($OldDumps.Count -le $keepOld) { return @() }
    return @($OldDumps | Select-Object -Skip $keepOld)
}

function Test-DumpMagic {
    param([string] $Path)
    $expected = [System.Text.Encoding]::ASCII.GetBytes($script:DumpMagic)
    $buffer = New-Object byte[] $expected.Length
    $stream = [System.IO.File]::OpenRead($Path)
    try { $read = $stream.Read($buffer, 0, $buffer.Length) } finally { $stream.Dispose() }
    if ($read -ne $expected.Length) { return $false }
    for ($i = 0; $i -lt $expected.Length; $i++) { if ($buffer[$i] -ne $expected[$i]) { return $false } }
    return $true
}

# cmd /s /c "<inner>": /s strips exactly the outer quotes, so the quoted docker
# path and dump path inside survive; /d skips any AutoRun command.
function Invoke-Dump {
    param([string] $CommandLine)
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $startInfo.Arguments = "/d /s /c `"$CommandLine`""
    $startInfo.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try { $process.WaitForExit(); return $process.ExitCode } finally { $process.Dispose() }
}

function Remove-Partial {
    param([string] $Path)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
}

# ---------------------------------------------------------------- the backup
# One try around all of it: an error nobody planned for is "no backup" (2),
# never PowerShell's default exit 1, which here means "dump good, prune failed".

try {
    $machine = Read-MachineEnv
    if (-not $OutDir) { $OutDir = Join-Path $env:USERPROFILE 'backups\harness-store' }
    if (-not $PSBoundParameters.ContainsKey('Container')) { $Container = Get-MachineSetting $machine 'HARNESS_STORE_CONTAINER' $script:DefaultContainer }
    if (-not $PSBoundParameters.ContainsKey('Database')) { $Database = Get-MachineSetting $machine 'HARNESS_STORE_DB' $script:DefaultDatabase }

    if ($Keep -lt 1) { Fail "-Keep $Keep keeps nothing, not even the new dump." 'Pass -Keep 1 or more.' }
    Assert-SafeName $Container 'Container'
    Assert-SafeName $Database 'Database'
    Assert-SafeName $User 'User'
    $outRoot = [System.IO.Path]::GetFullPath($OutDir)
    if ($outRoot.Contains('%')) { Fail "-OutDir '$outRoot' contains '%', which cmd.exe would expand." 'Choose a folder without % in its path.' }

    $docker = Resolve-Docker
    Assert-ContainerRunning $docker $Container

    $dumpPath = Join-Path $outRoot ("harness-{0}.dump" -f (Get-Date).ToString($script:TimestampFormat))
    $partialPath = "$dumpPath$($script:PartialSuffix)"
    $dumpCommand = "`"$docker`" exec $Container pg_dump -U $User -Fc $Database > `"$partialPath`""

    if ($DryRun) {
        $pruneList = @(Get-PruneList @(Get-OldDumps $outRoot '') $Keep)
        Write-Output "dry run: would run: $dumpCommand"
        Write-Output "dry run: would check it and rename it to $dumpPath"
        foreach ($old in $pruneList) { Write-Output "dry run: would remove $($old.FullName)" }
        Write-Output "dry run: would keep $Keep, remove $($pruneList.Count); nothing written"
        exit $script:ExitOk
    }

    [void] [System.IO.Directory]::CreateDirectory($outRoot)
    if ((Test-Path -LiteralPath $dumpPath) -or (Test-Path -LiteralPath $partialPath)) {
        Fail "$dumpPath already exists." 'Wait a second and run again; a dump is never overwritten.'
    }

    $dumpCode = Invoke-Dump $dumpCommand
    if ($dumpCode -ne 0) {
        Remove-Partial $partialPath
        Fail "pg_dump failed (exit $dumpCode); nothing was kept." "Check the message above; try: docker exec $Container pg_dump -U $User -Fc $Database --schema-only"
    }
    $size = if (Test-Path -LiteralPath $partialPath) { (Get-Item -LiteralPath $partialPath).Length } else { 0 }
    if ($size -eq 0) {
        Remove-Partial $partialPath
        Fail 'pg_dump exited 0 but wrote nothing; the empty file was removed.' "Check the container's logs: docker logs $Container"
    }
    if (-not (Test-DumpMagic $partialPath)) {
        Remove-Partial $partialPath
        Fail "the dump does not start with $($script:DumpMagic), so it is not a custom-format dump; it was removed." 'Check that the container runs pg_dump, not something that prints to stdout first.'
    }
    Move-Item -LiteralPath $partialPath -Destination $dumpPath
    $script:DumpWritten = $dumpPath

    $pruneFailed = $false
    foreach ($old in @(Get-PruneList @(Get-OldDumps $outRoot $dumpPath) $Keep)) {
        try {
            Remove-Item -LiteralPath $old.FullName -Force
            Write-Output "removed $($old.FullName)"
        } catch {
            $pruneFailed = $true
            [Console]::Error.WriteLine("could not remove $($old.FullName): $($_.Exception.Message)")
        }
    }
    $kept = @(Get-OldDumps $outRoot '').Count
    Write-Output "backup: $dumpPath ($size bytes), kept $kept"
    if ($pruneFailed) { exit $script:ExitPruneFailed }
    exit $script:ExitOk
} catch {
    if ($script:DumpWritten) {
        [Console]::Error.WriteLine("error: the dump $($script:DumpWritten) was written and checked, but: $($_.Exception.Message)")
        exit $script:ExitPruneFailed
    }
    [Console]::Error.WriteLine("error: no backup was made: $($_.Exception.Message)")
    exit $script:ExitNoBackup
}
