<#
.SYNOPSIS
    Self-test for scripts/backup-store.ps1. No Pester, no Docker needed.

.DESCRIPTION
    Puts a fake docker.cmd on a PATH that holds nothing else but System32, runs
    backup-store.ps1 in a child `powershell -NoProfile -File` (so its `exit`
    codes are the real ones), and prints PASS or FAIL per case. The fake answers
    `inspect` with $env:FAKE_INSPECT and does what $env:FAKE_EXEC says for
    `exec`: echo its arguments after PGDMP (default), emit a binary payload,
    write nothing, fail, or print text that is not a dump.

    The machine file is pointed at a path that does not exist and
    HARNESS_STORE_* are cleared, so this machine's settings never leak in. The
    scratch folder and every environment change are undone in `finally`. Exits
    1 if any case failed.

.EXAMPLE
    powershell -NoProfile -File scripts/tests/backup-store.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The script under test, one folder up from this one.
$script:BackupScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'backup-store.ps1'
# Windows PowerShell 5.1 is the target; by full path, because the child's PATH is stripped.
$script:ChildShell = Join-Path $PSHOME 'powershell.exe'
$script:System32 = Join-Path $env:SystemRoot 'System32'
$script:DumpNamePattern = '^harness-\d{8}-\d{6}\.dump$'
$script:DefaultCommand = 'exec harness-postgres pg_dump -U harness -Fc harness'

$script:Failures = 0
$script:ScratchRoot = Join-Path $env:TEMP ("backup-store-" + [guid]::NewGuid())

# Every variable a case may set, saved here and put back in `finally`.
$script:TouchedVariables = @('PATH', 'HARNESS_MACHINE_ENV', 'HARNESS_STORE_CONTAINER', 'HARNESS_STORE_DB', 'FAKE_INSPECT', 'FAKE_EXEC')
$script:SavedEnvironment = @{}
foreach ($name in $script:TouchedVariables) { $script:SavedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

$script:FakeDocker = @(
    '@echo off'
    'if "%~1"=="inspect" goto inspect'
    'if "%~1"=="exec" goto exec'
    'echo fake docker: unexpected command %* 1>&2'
    'exit /b 3'
    ':inspect'
    'echo %FAKE_INSPECT%'
    'exit /b 0'
    ':exec'
    'if "%FAKE_EXEC%"=="binary" (type "%~dp0payload.bin" & exit /b 0)'
    'if "%FAKE_EXEC%"=="empty" exit /b 0'
    'if "%FAKE_EXEC%"=="fail" (echo fake pg_dump: connection refused 1>&2 & exit /b 1)'
    'if "%FAKE_EXEC%"=="text" (echo pg_dump: warning first & exit /b 0)'
    'echo PGDMP FAKE-EXEC %*'
    'exit /b 0'
) -join "`r`n"

function New-ScratchDir {
    param([string] $Name)
    $path = Join-Path $script:ScratchRoot $Name
    [void] [System.IO.Directory]::CreateDirectory($path)
    return $path
}

# A folder holding docker.cmd and, for the binary case, the payload it types:
# PGDMP followed by every byte value, the ones PowerShell's `>` would mangle.
function New-FakeDockerDir {
    $dir = New-ScratchDir 'fake-bin'
    [System.IO.File]::WriteAllText((Join-Path $dir 'docker.cmd'), "$($script:FakeDocker)`r`n", [System.Text.Encoding]::ASCII)
    $payload = [System.Text.Encoding]::ASCII.GetBytes('PGDMP') + [byte[]](0..255)
    [System.IO.File]::WriteAllBytes((Join-Path $dir 'payload.bin'), $payload)
    return $dir
}

function Get-DumpFiles {
    param([string] $Directory)
    if (-not (Test-Path -LiteralPath $Directory)) { return @() }
    return @(Get-ChildItem -LiteralPath $Directory -File | Where-Object { $_.Name -match $script:DumpNamePattern })
}

function Get-PartialFiles {
    param([string] $Directory)
    if (-not (Test-Path -LiteralPath $Directory)) { return @() }
    return @(Get-ChildItem -LiteralPath $Directory -File -Filter '*.partial')
}

# Run backup-store.ps1 in a child shell with PATH = <BinDir>;System32 and the
# given variables; return its exit code and all output as one string.
function Invoke-Backup {
    param([string] $BinDir, [string[]] $Arguments = @(), [hashtable] $Environment = @{})
    $ErrorActionPreference = 'Continue'
    $values = @{ PATH = "$BinDir;$($script:System32)"; HARNESS_MACHINE_ENV = (Join-Path $script:ScratchRoot 'no-machine.env');
                 HARNESS_STORE_CONTAINER = $null; HARNESS_STORE_DB = $null; FAKE_INSPECT = 'true'; FAKE_EXEC = 'args' }
    foreach ($key in $Environment.Keys) { $values[$key] = $Environment[$key] }
    try {
        foreach ($key in $values.Keys) { [Environment]::SetEnvironmentVariable($key, $values[$key]) }
        $lines = & $script:ChildShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:BackupScript @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        [Environment]::SetEnvironmentVariable('PATH', $script:SavedEnvironment['PATH'])
    }
    $text = (@($lines) | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{ Code = $code; Output = $text }
}

# Plain substring checks; $Checks are extra [problem-message] = [bool ok] pairs.
function Test-Case {
    param([string] $Name, $Result, [int] $ExpectedCode, [string[]] $Expected = @(), [string[]] $NotExpected = @(), [hashtable] $Checks = @{})
    $problems = @()
    if ($Result.Code -ne $ExpectedCode) { $problems += "exit $($Result.Code), expected $ExpectedCode" }
    foreach ($fragment in $Expected) {
        if (-not $Result.Output.Contains($fragment)) { $problems += "output lacks '$fragment'" }
    }
    foreach ($fragment in $NotExpected) {
        if ($Result.Output.Contains($fragment)) { $problems += "output has '$fragment'" }
    }
    foreach ($check in $Checks.Keys) { if (-not $Checks[$check]) { $problems += $check } }
    if ($problems.Count -eq 0) {
        Write-Output "PASS $Name"
        return
    }
    $script:Failures++
    Write-Output "FAIL $Name -- $($problems -join '; ')"
    foreach ($line in $Result.Output.Split("`n")) { Write-Output "     | $line" }
}

try {
    if (-not (Test-Path -LiteralPath $script:BackupScript)) { throw "backup-store.ps1 not found at $script:BackupScript" }
    $emptyBin = New-ScratchDir 'empty-bin'
    $fakeBin = New-FakeDockerDir

    # (1) docker absent: nothing on PATH but System32.
    $out = Join-Path $script:ScratchRoot 'no-docker'
    $result = Invoke-Backup $emptyBin @('-OutDir', $out, '-DryRun')
    Test-Case 'dry run without docker on PATH is exit 2 naming docker' $result 2 @('docker was not found on PATH', 'Fix:') `
        -Checks @{ 'OutDir was created' = -not (Test-Path -LiteralPath $out) }

    # (2) dry run with the fake: the exact command, and exec never called.
    $out = Join-Path $script:ScratchRoot 'dry-run'
    $result = Invoke-Backup $fakeBin @('-OutDir', $out, '-DryRun')
    Test-Case 'dry run prints the command and creates nothing' $result 0 @(
        "dry run: would run: ", $script:DefaultCommand, "> `"$out\harness-", 'nothing written') @('FAKE-EXEC') `
        -Checks @{ 'OutDir was created' = -not (Test-Path -LiteralPath $out) }

    # (3) a real run: the file is the fake's stdout, under the final name only.
    $out = Join-Path $script:ScratchRoot 'real'
    $result = Invoke-Backup $fakeBin @('-OutDir', $out)
    $dumps = Get-DumpFiles $out
    $content = if ($dumps.Count -eq 1) { [System.IO.File]::ReadAllText($dumps[0].FullName) } else { '' }
    Test-Case 'a run writes one checked dump' $result 0 @('backup: ', ' bytes), kept 1') -Checks @{
        "expected 1 dump, found $($dumps.Count)"          = $dumps.Count -eq 1
        'dump does not start with PGDMP'                  = $content.StartsWith('PGDMP')
        'dump lacks the pg_dump arguments'                = $content.Contains("FAKE-EXEC $($script:DefaultCommand)")
        'a .partial file was left behind'                 = (Get-PartialFiles $out).Count -eq 0
    }

    # (3b) binary safety: every byte value arrives unchanged.
    $out = Join-Path $script:ScratchRoot 'binary'
    $result = Invoke-Backup $fakeBin @('-OutDir', $out) @{ FAKE_EXEC = 'binary' }
    $dumps = Get-DumpFiles $out
    $expectedHash = (Get-FileHash -LiteralPath (Join-Path $fakeBin 'payload.bin')).Hash
    $actualHash = if ($dumps.Count -eq 1) { (Get-FileHash -LiteralPath $dumps[0].FullName).Hash } else { '' }
    Test-Case 'the dump is byte-for-byte what pg_dump wrote' $result 0 @('(261 bytes), kept 1') -Checks @{
        "dump hash $actualHash differs from payload $expectedHash" = $actualHash -eq $expectedHash
    }

    # (4) pruning: five older dumps, -Keep 2 counts the new one, so four go.
    $out = New-ScratchDir 'prune'
    $old = @()
    for ($i = 1; $i -le 5; $i++) {
        $path = Join-Path $out ("harness-2026090{0}-030000.dump" -f $i)
        [System.IO.File]::WriteAllText($path, "PGDMP old $i")
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddDays($i - 10)
        $old += $path
    }
    $decoys = @((Join-Path $out 'harness-notes.dump'), (Join-Path $out 'other.txt'), (Join-Path $out 'harness-20260901-030000.dump.bak'))
    foreach ($decoy in $decoys) { [System.IO.File]::WriteAllText($decoy, 'not ours') }

    $result = Invoke-Backup $fakeBin @('-OutDir', $out, '-Keep', '2', '-DryRun')
    $wouldRemove = @($result.Output.Split("`n") | Where-Object { $_.StartsWith('dry run: would remove ') }).Count
    Test-Case 'dry run lists the four oldest and removes nothing' $result 0 @(
        "would remove $($old[0])", "would remove $($old[3])", 'would keep 2, remove 4') @("would remove $($old[4])") -Checks @{
        "expected 4 'would remove' lines, found $wouldRemove" = $wouldRemove -eq 4
        'a dump was removed or written'                      = (Get-DumpFiles $out).Count -eq 5
    }

    $result = Invoke-Backup $fakeBin @('-OutDir', $out, '-Keep', '2')
    $remaining = @(Get-DumpFiles $out | ForEach-Object { $_.FullName })
    $newDump = @($remaining | Where-Object { $old -notcontains $_ })
    Test-Case '-Keep 2 leaves the newest old dump and the new one' $result 0 @(
        "removed $($old[0])", "removed $($old[3])", 'kept 2') @("removed $($old[4])") -Checks @{
        "expected 2 dumps, found $($remaining.Count)" = $remaining.Count -eq 2
        'the newest old dump was removed'             = $remaining -contains $old[4]
        'the new dump is missing'                     = $newDump.Count -eq 1
        'a file not named like a dump was touched'    = @($decoys | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0
    }

    # (5) failures leave nothing behind that looks like a backup.
    foreach ($case in @(
            @{ Mode = 'empty'; Name = 'an empty dump is exit 2 and removed'; Text = 'wrote nothing' },
            @{ Mode = 'fail'; Name = 'a failed pg_dump is exit 2 and removed'; Text = 'pg_dump failed (exit 1)' },
            @{ Mode = 'text'; Name = 'output without PGDMP is exit 2 and removed'; Text = 'not a custom-format dump' })) {
        $out = Join-Path $script:ScratchRoot "exec-$($case.Mode)"
        $result = Invoke-Backup $fakeBin @('-OutDir', $out) @{ FAKE_EXEC = $case.Mode }
        Test-Case $case.Name $result 2 @($case.Text, 'Fix:') @('backup: ') -Checks @{
            'a dump file remains'      = (Get-DumpFiles $out).Count -eq 0
            'a .partial file remains'  = (Get-PartialFiles $out).Count -eq 0
        }
    }

    # (6) the container is not running: exit 2, never started, nothing created.
    $out = Join-Path $script:ScratchRoot 'stopped'
    $result = Invoke-Backup $fakeBin @('-OutDir', $out) @{ FAKE_INSPECT = 'false' }
    Test-Case 'a stopped container is exit 2' $result 2 @('container harness-postgres is not running', 'never starts it') -Checks @{
        'OutDir was created' = -not (Test-Path -LiteralPath $out)
    }

    # Settings: the environment overrides the defaults, an explicit parameter wins.
    $out = Join-Path $script:ScratchRoot 'settings'
    $overrides = @{ HARNESS_STORE_CONTAINER = 'other-pg'; HARNESS_STORE_DB = 'otherdb' }
    $result = Invoke-Backup $fakeBin @('-OutDir', $out, '-DryRun') $overrides
    Test-Case 'HARNESS_STORE_CONTAINER and HARNESS_STORE_DB override the defaults' $result 0 @('exec other-pg pg_dump -U harness -Fc otherdb')
    $result = Invoke-Backup $fakeBin @('-OutDir', $out, '-DryRun', '-Container', 'mine', '-Database', 'db2', '-User', 'reader') $overrides
    Test-Case 'explicit parameters win over the environment' $result 0 @('exec mine pg_dump -U reader -Fc db2')

    $result = Invoke-Backup $fakeBin @('-OutDir', $out, '-DryRun', '-Container', 'a&b')
    Test-Case 'a name with a cmd metacharacter is refused' $result 2 @("-Container 'a&b'")
    $result = Invoke-Backup $fakeBin @('-OutDir', $out, '-DryRun', '-Keep', '0')
    Test-Case '-Keep 0 is refused' $result 2 @('-Keep 0 keeps nothing')
} catch {
    $script:Failures++
    Write-Output "FAIL harness -- $($_.Exception.Message)"
} finally {
    foreach ($name in $script:TouchedVariables) { [Environment]::SetEnvironmentVariable($name, $script:SavedEnvironment[$name]) }
    if (Test-Path -LiteralPath $script:ScratchRoot) {
        try {
            Remove-Item -LiteralPath $script:ScratchRoot -Recurse -Force
        } catch {
            Write-Output "warning: could not remove $script:ScratchRoot -- $($_.Exception.Message)"
        }
    }
}

if ($script:Failures -gt 0) {
    Write-Output "$($script:Failures) case(s) failed."
    exit 1
}
Write-Output 'All cases passed.'
exit 0
