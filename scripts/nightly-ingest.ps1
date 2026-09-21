<#
.SYNOPSIS
    The nightly reconcile: conclude stale sessions, then re-ingest the vault.

.DESCRIPTION
    Three steps, in this order and for this reason:

      0. transcript sweep — hooks/sweep-transcripts.mjs writes a note for every
         idle transcript under ~/.claude/projects that has none: SDK workers,
         sessions killed with their terminal, teleported cloud sessions.
      0b. checkpoints    — hooks/collect-checkpoints.mjs fetches the notes the
         /checkpoint skill pushed from cloud sessions and files them in the vault.
      1. sweep-concluded  — sets status: concluded and concluded_at on session
         notes still 'active' more than 24 h after their ended_at (R-27.2).
      2. ingest           — a full walk of the vault, which picks up the notes
         the sweeps just wrote along with anything the per-note hook missed.

    Running the sweep first is what makes the status change visible to search in
    the same night. The other way round, every concluded note would wait a day.

    The sweep touches frontmatter only, and content_hash is over the body, so
    the ingest reaches those notes through its metadata-only path: it compares
    the stored title and metadata with the freshly parsed ones and issues one
    UPDATE, with no re-chunking and no embedding. They are counted in the run
    summary as 'metadata-updated'.

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
    [string] $EnvFile = '',
    # Step 0: the transcript sweep (hooks/sweep-transcripts.mjs), which writes a
    # note for every idle transcript the SessionEnd hook never saw.
    [string] $HooksDir = "C:/Users/$env:USERNAME/agentic-harness/hooks",
    [string] $NodePath = '',
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $TranscriptSweep = 'Apply',
    [ValidateRange(0, 8760)]
    [int] $TranscriptIdleHours = 6,
    # Step 0b: /checkpoint notes pushed by cloud sessions, collected out of git
    # (hooks/collect-checkpoints.mjs). Empty means the collector's own defaults.
    [string[]] $CheckpointRepos = @(),
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $Checkpoints = 'Apply'
)

$ErrorActionPreference = 'Stop'

# Keep one night's worth of detail without letting the file grow forever.
$LogMaxBytes = 1MB
$LogKeepLines = 2000

function Write-Log {
    param([string] $Message)

    $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
    # Write-Host, not Write-Output: Write-Output emits into the PIPELINE, so
    # every log line inside Invoke-Ingest would become part of that function's
    # return value and the exit code would come back as an array of strings.
    Write-Host $line
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
        Write-Host "(could not write $LogPath)"
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

function Resolve-Node {
    param([string] $Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "node not found at $Explicit" }
        return $Explicit
    }

    $standard = 'C:/Program Files/nodejs/node.exe'
    if (Test-Path $standard) { return $standard }

    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw 'node was not found. Pass -NodePath, or install it so node.exe is on PATH.'
}

function Invoke-TranscriptSweep {
    param([string] $Node, [string] $Script, [string[]] $SweepArgs, [string] $Label)

    Write-Log "$Label : node $(Split-Path -Leaf $Script) $($SweepArgs -join ' ')"

    # Same stderr handling as Invoke-Ingest: merge both streams into the log
    # without a NativeCommandError turning the first line into a fatal one.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Node $Script @SweepArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }

    foreach ($line in $output) { Write-Log "$Label | $line" }
    Write-Log "$Label : exit $code"
    return [int] $code
}

function Invoke-Ingest {
    param([string] $Uv, [string] $Project, [string[]] $IngestArgs, [string] $Label)

    Write-Log "$Label : uv run ingest $($IngestArgs -join ' ')"

    # `ingest` logs at INFO to STDERR, and so does `uv run`. In Windows
    # PowerShell 5.1, merging a native command's stderr into the pipeline while
    # $ErrorActionPreference is 'Stop' turns every one of those lines into a
    # terminating NativeCommandError — the nightly job would abort on its first
    # log line, every night, and the only symptom would be a non-zero exit.
    # Relaxing the preference for exactly this call keeps the merge (we want
    # both streams in the log) without the merge being fatal.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Argument array, never a command string: the vault path holds spaces.
        $output = & $Uv --directory $Project run ingest @IngestArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }

    foreach ($line in $output) { Write-Log "$Label | $line" }
    Write-Log "$Label : exit $code"

    # The ONLY thing this function puts on the pipeline. Everything above logs
    # through Write-Host for exactly that reason.
    return [int] $code
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

# Step 0: transcripts the hook never saw become notes now, so the ingest below
# embeds them tonight. Runs from the checkout, like the ingest project does.
$transcriptCode = 0
if ($TranscriptSweep -eq 'Skip') {
    Write-Log 'transcripts: skipped by -TranscriptSweep Skip'
} else {
    $sweepScript = Join-Path $HooksDir 'sweep-transcripts.mjs'
    if (-not (Test-Path $sweepScript)) {
        Write-Log "transcripts: no sweep script at $sweepScript; continuing to the ingest"
        $transcriptCode = 2
    } else {
        try {
            $node = Resolve-Node -Explicit $NodePath
            Write-Log "node: $node"
            $transcriptArgs = @('--vault', $VaultPath, '--min-idle-hours', "$TranscriptIdleHours")
            if ($TranscriptSweep -eq 'DryRun') { $transcriptArgs += '--dry-run' }
            $transcriptCode = Invoke-TranscriptSweep -Node $node -Script $sweepScript -SweepArgs $transcriptArgs -Label 'transcripts'
        } catch {
            Write-Log "transcripts: $($_.Exception.Message); continuing to the ingest"
            $transcriptCode = 2
        }
    }
}
if ($transcriptCode -ne 0) { Write-Log "transcript sweep failed with $transcriptCode; continuing to the ingest" }

# Step 0b: notes the /checkpoint skill pushed from cloud sessions. Same
# runner as step 0; a refused note or a failed fetch is exit 1, never fatal.
$checkpointCode = 0
if ($Checkpoints -eq 'Skip') {
    Write-Log 'checkpoints: skipped by -Checkpoints Skip'
} else {
    $collectScript = Join-Path $HooksDir 'collect-checkpoints.mjs'
    if (-not (Test-Path $collectScript)) {
        Write-Log "checkpoints: no collector at $collectScript; continuing to the ingest"
        $checkpointCode = 2
    } else {
        try {
            $node = Resolve-Node -Explicit $NodePath
            $collectArgs = @('--vault', $VaultPath)
            foreach ($repo in $CheckpointRepos) { $collectArgs += @('--repo', $repo) }
            if ($Checkpoints -eq 'DryRun') { $collectArgs += '--dry-run' }
            $checkpointCode = Invoke-TranscriptSweep -Node $node -Script $collectScript -SweepArgs $collectArgs -Label 'checkpoints'
        } catch {
            Write-Log "checkpoints: $($_.Exception.Message); continuing to the ingest"
            $checkpointCode = 2
        }
    }
}
if ($checkpointCode -ne 0) { Write-Log "checkpoint collection ended with $checkpointCode; continuing to the ingest" }

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

# --prune drops rows whose note left the vault or stopped qualifying for the
# index (an SDK worker session, a note newly marked ingest: false). It refuses on
# its own after any failed document or an empty load, so a bad night deletes nothing.
$ingestArgs = @('--source', 'obsidian', '--path', $VaultPath, '--prune') + $envArgs
$ingestCode = Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs $ingestArgs -Label 'ingest'

Write-Log "=== nightly reconcile finished (transcripts $transcriptCode, checkpoints $checkpointCode, sweep $sweepCode, ingest $ingestCode) ==="

# Task Scheduler shows this as the last result, so it has to mean "the reconcile
# worked". Only the ingest decides that.
exit $ingestCode
