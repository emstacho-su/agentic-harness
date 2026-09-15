<#
.SYNOPSIS
    The nightly reconcile: conclude stale sessions, then re-ingest the vault.

.DESCRIPTION
    Two steps, in this order and for this reason:

      1. sweep-concluded  — sets status: concluded and concluded_at on session
         notes still 'active' more than 24 h after their ended_at (R-27.2).
      2. ingest           — a full walk of the vault, which picks up the notes
         the sweep just edited along with anything the per-note hook missed.

    Running the sweep first is what makes the status change visible to search in
    the same night. The other way round, every concluded note would wait a day.

    A complete ingest writes its own last-success timestamp, which is what
    `ingest --health` reads. This script does not write that file; a run that
    fails must not look like a run that worked.

    Registered by register-nightly-ingest.ps1. Safe to run by hand.

.PARAMETER VaultPath
    The Obsidian vault. Must be a Windows path (C:/...), not an MSYS /c/... one.

.PARAMETER ProjectDir
    The uv project holding the ingest package (the directory with pyproject.toml).

.PARAMETER SweepMode
    Apply   - write the concluded status (the point of the nightly run)
    DryRun  - report what it would conclude, change nothing
    Skip    - do not sweep at all

.EXAMPLE
    ./nightly-ingest.ps1 -SweepMode DryRun
#>
[CmdletBinding()]
param(
    [string] $VaultPath = "C:/Users/$env:USERNAME/OneDrive - Syracuse University/vault",
    [string] $ProjectDir = "C:/Users/$env:USERNAME/agentic-harness/ingest",
    [string] $UvPath = '',
    [string] $LogPath = "C:/Users/$env:USERNAME/.claude/hooks/nightly-ingest.log",
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $SweepMode = 'Apply',
    [ValidateRange(1, 8760)]
    [int] $StaleAfterHours = 24,
    [string] $EnvFile = ''
)

$ErrorActionPreference = 'Stop'

# Keep one night's worth of detail without letting the file grow forever.
$LogMaxBytes = 1MB
$LogKeepLines = 2000

function Write-Log {
    param([string] $Message)

    $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
    Write-Output $line
    try {
        $directory = Split-Path -Parent $LogPath
        if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
        if (Test-Path $LogPath) {
            $existing = Get-Item $LogPath
            if ($existing.Length -gt $LogMaxBytes) {
                $kept = Get-Content $LogPath -Tail $LogKeepLines
                Set-Content -Path $LogPath -Value $kept -Encoding utf8
            }
        }
        Add-Content -Path $LogPath -Value $line -Encoding utf8
    } catch {
        # A log that cannot be written must not fail the job it is logging.
        Write-Output "(could not write $LogPath)"
    }
}

function Resolve-Uv {
    param([string] $Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "uv not found at $Explicit" }
        return $Explicit
    }

    $local = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (Test-Path $local) { return $local }

    $onPath = Get-Command uv -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw 'uv was not found. Pass -UvPath, or install it so uv.exe is on PATH.'
}

function Invoke-Ingest {
    param([string] $Uv, [string] $Project, [string[]] $IngestArgs, [string] $Label)

    Write-Log "$Label : uv run ingest $($IngestArgs -join ' ')"
    # Argument array, never a command string: the vault path holds spaces.
    $output = & $Uv --directory $Project run ingest @IngestArgs 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $output) { Write-Log "$Label | $line" }
    Write-Log "$Label : exit $code"
    return $code
}

# --------------------------------------------------------------------------

Write-Log '=== nightly reconcile starting ==='

if (-not (Test-Path $VaultPath)) {
    Write-Log "FATAL vault not found: $VaultPath"
    exit 2
}
if (-not (Test-Path (Join-Path $ProjectDir 'pyproject.toml'))) {
    Write-Log "FATAL no ingest project at $ProjectDir (expected pyproject.toml)"
    exit 2
}

try {
    $uv = Resolve-Uv -Explicit $UvPath
} catch {
    Write-Log "FATAL $($_.Exception.Message)"
    exit 2
}
Write-Log "uv: $uv"
Write-Log "vault: $VaultPath"
Write-Log "project: $ProjectDir"

$envArgs = @()
if ($EnvFile) { $envArgs = @('--env-file', $EnvFile) }

$sweepCode = 0
if ($SweepMode -eq 'Skip') {
    Write-Log 'sweep: skipped by -SweepMode Skip'
} else {
    $sweepArgs = @('sweep-concluded', '--path', $VaultPath, '--stale-after-hours', "$StaleAfterHours")
    if ($SweepMode -eq 'Apply') { $sweepArgs += '--apply' } else { $sweepArgs += '--dry-run' }
    $sweepCode = Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs $sweepArgs -Label 'sweep'
}

# The sweep failing is not a reason to skip the reconcile: the vault still needs
# re-ingesting, and a stale status is a smaller problem than a stale index.
if ($sweepCode -ne 0) { Write-Log "sweep failed with $sweepCode; continuing to the ingest" }

$ingestArgs = @('--source', 'obsidian', '--path', $VaultPath) + $envArgs
$ingestCode = Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs $ingestArgs -Label 'ingest'

Write-Log "=== nightly reconcile finished (sweep $sweepCode, ingest $ingestCode) ==="

# Task Scheduler shows this as the last result, so it has to mean "the reconcile
# worked". Only the ingest decides that.
exit $ingestCode
