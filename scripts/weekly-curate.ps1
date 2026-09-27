<#
.SYNOPSIS
    The weekly curator run: inventory, extract, ledger, status, history and the
    curation report, then the retrieval provenance report.

.DESCRIPTION
    Sunday 04:30, after the nightly reconcile (03:00) and the store backup, so
    it reads a vault and a store that are both fresh. The steps, in this order
    and for this reason:

      1. inventory  — `ingest curate inventory`: each collection's timeline,
         plan sources and git facts (R-C1). Exit 1 is a count mismatch.
      2. extract    — `ingest curate extract --all`: the judge reads every note
         whose content changed and caches its facts (R-C2). Every later stage
         reads that cache.
      3. ledger     — `ingest curate ledger --all`: issues clustered across
         notes, their events, ledger.md (R-C3).
      4. status     — `ingest curate status --all`: each requirement's state
         against the plan, status.md (R-C4). After the ledger, whose states
         it reads.
      5. history    — `ingest curate history --all`: the week-by-week
         narrative, history.md (R-C5).
      6. report     — `ingest curate report --all`: scores, proposals and the
         tally, curation/<date>.md (R-C6, R-C7). Last of the curator stages,
         because it scores against status and history.
      7. retrievals — `ingest report retrievals`, written as
         retrievals-<date>.json for the week and retrievals-dashboard.html.

    Every stage runs, whatever the one before it did. Exit 1 (findings) and
    exit 3 (stopped by budget: what it finished is kept, the rest waits for
    next week) are logged and the run goes on. Exit 2 (could not run) is logged
    and the run goes on too, because status, history and report can still work
    from the cache the last good week left.

    The exit code is 2 when any stage could not run, else 0: Task Scheduler
    shows it as the last result, and findings or a budget stop are a normal
    week. The finish line in the log lists every stage's code.

    Settings, each from the environment, else ~/.harness/machine.env (once
    lib/machine-env.ps1 accepts the CURATE_* keys), else the default:
      CURATE_MODEL       --model for the stages that call the judge
      CURATE_MAX_CALLS   --max-calls for them (a positive integer)
      CURATE_MAX_TOKENS  --max-tokens for them (a positive integer)
      CURATE_GIT         apply (default) or skip; skip gives --no-git to every
                         stage that reads git
      CURATE_STAGES      the stages to run, space- or comma-separated; default
                         all. They always run in the order above.
    A bad value is refused before anything runs, named by its key only.

    Registered by register-weekly-curate.ps1. Safe to run by hand; -DryRun
    calls no judge and writes nothing.

.PARAMETER VaultPath
    The Obsidian vault. Must be a Windows path (C:/...), not an MSYS /c/... one.

.PARAMETER ProjectDir
    The uv project holding the ingest package (the directory with pyproject.toml).

.PARAMETER ReportsDir
    Where the retrievals JSON and dashboard go (default ~/.harness/reports).

.PARAMETER DryRun
    Pass --dry-run to every curate stage and write no retrievals file; the
    log says what would have been written.

.EXAMPLE
    ./weekly-curate.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string] $VaultPath = '',
    [string] $ProjectDir = '',
    [string] $UvPath = '',
    [string] $LogPath = '',
    [string] $ReportsDir = '',
    [string] $EnvFile = '',
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# uv and ingest print UTF-8. Without this, PowerShell 5.1 decodes captured child
# output as the OEM code page and `café.md` or `…` reach the log as mojibake.
$encodingNote = ''
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { $encodingNote = "console output encoding not set ($($_.Exception.Message)); non-ASCII in child output may log as mojibake" }

# Keep a few weeks of detail without letting the file grow forever.
$LogMaxBytes = 1MB
$LogKeepLines = 2000

# The weekly order (the C-b contract; weekly-curate.sh lists the same).
$script:WeeklyStages = @('inventory', 'extract', 'ledger', 'status', 'history', 'report', 'retrievals')

# ~/.harness/machine.env: what this machine is, through the shared reader
# (Read-MachineEnv, Get-MachineSetting). A parameter passed explicitly still
# wins; then the environment; then the file; then the default.
. (Join-Path $PSScriptRoot 'lib\machine-env.ps1')

$machine = Read-MachineEnv
if (-not $VaultPath)  { $VaultPath  = Get-MachineSetting $machine 'HARNESS_VAULT' "C:/Users/$env:USERNAME/OneDrive - Syracuse University/vault" }
if (-not $ProjectDir) { $ProjectDir = Get-MachineSetting $machine 'HARNESS_INGEST_PROJECT' "C:/Users/$env:USERNAME/agentic-harness/ingest" }
if (-not $UvPath)     { $UvPath     = Get-MachineSetting $machine 'HARNESS_UV' '' }
if (-not $LogPath)    { $LogPath    = Get-MachineSetting $machine 'HARNESS_WEEKLY_LOG' "C:/Users/$env:USERNAME/.claude/hooks/weekly-curate.log" }
if (-not $ReportsDir) { $ReportsDir = Get-MachineSetting $machine 'HARNESS_REPORTS_DIR' "C:/Users/$env:USERNAME/.harness/reports" }
$curateModel     = Get-MachineSetting $machine 'CURATE_MODEL' ''
$curateMaxCalls  = Get-MachineSetting $machine 'CURATE_MAX_CALLS' ''
$curateMaxTokens = Get-MachineSetting $machine 'CURATE_MAX_TOKENS' ''
$curateGit       = Get-MachineSetting $machine 'CURATE_GIT' 'apply'
$curateStages    = Get-MachineSetting $machine 'CURATE_STAGES' 'all'

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

function Invoke-Ingest {
    param([string] $Uv, [string] $Project, [string[]] $IngestArgs, [string] $Label)

    Write-Log "$Label : uv run ingest $($IngestArgs -join ' ')"

    # `ingest` logs at INFO to STDERR, and so does `uv run`. In Windows
    # PowerShell 5.1, merging a native command's stderr into the pipeline while
    # $ErrorActionPreference is 'Stop' turns every one of those lines into a
    # terminating NativeCommandError. Relaxing the preference for exactly this
    # call keeps the merge without the merge being fatal (nightly-ingest.ps1).
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

    # The ONLY thing this function puts on the pipeline.
    return [int] $code
}

# The finish line's codes, in the weekly order; a skipped stage stays 0.
$codes = [ordered]@{}
foreach ($stage in $script:WeeklyStages) { $codes[$stage] = 0 }
$runStatus = 0

# Record a stage's code and say what it means. Exit 2, or any code that is not
# 0, 1 or 3, is "could not run" and makes the whole run exit 2.
function Set-StageCode {
    param([string] $Stage, [int] $Code)
    $codes[$Stage] = $Code
    switch ($Code) {
        0 { }
        1 { Write-Log "$Stage ended with 1 (findings); see the $Stage lines above; continuing" }
        3 { Write-Log "$Stage ended with 3 (stopped by budget); what it finished is kept, the rest waits for next week; continuing" }
        default {
            Write-Log "$Stage ended with $Code (could not run); continuing, the later stages work from the cache"
            $script:runStatus = 2
        }
    }
}

# --------------------------------------------------------------------------

Write-Log '=== weekly curate starting ==='
if ($encodingNote) { Write-Log $encodingNote }

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

# The settings are checked before anything runs. A bad value is named by its
# key only: nothing from the machine file or the environment is echoed.
if (@('apply', 'skip') -cnotcontains $curateGit) {
    Write-Log 'FATAL CURATE_GIT must be apply or skip'
    exit 2
}
if ($curateMaxCalls -and $curateMaxCalls -cnotmatch '\A[1-9][0-9]*\z') {
    Write-Log 'FATAL CURATE_MAX_CALLS must be a positive integer'
    exit 2
}
if ($curateMaxTokens -and $curateMaxTokens -cnotmatch '\A[1-9][0-9]*\z') {
    Write-Log 'FATAL CURATE_MAX_TOKENS must be a positive integer'
    exit 2
}

$selected = @()
foreach ($name in @($curateStages -split '[,\s]+' | Where-Object { $_ })) {
    if ($name -ceq 'all') {
        $selected = $script:WeeklyStages
    } elseif ($script:WeeklyStages -ccontains $name) {
        $selected += $name
    } else {
        Write-Log "FATAL CURATE_STAGES names a stage that does not exist; use all or any of: $($script:WeeklyStages -join ' ')"
        exit 2
    }
}
if ($selected.Count -eq 0) {
    Write-Log "FATAL CURATE_STAGES names no stage; use all or any of: $($script:WeeklyStages -join ' ')"
    exit 2
}
if ($DryRun) { Write-Log 'dry run: --dry-run goes to every curate stage; no report file is written' }

$envArgs = @()
if ($EnvFile) { $envArgs = @('--env-file', $EnvFile) }

# One `ingest curate` stage. The judge stages take the model and the budget
# (inventory calls no judge); every stage but extract reads git.
function Invoke-CurateStage {
    param([string] $Stage, [string[]] $StageArgs = @())
    if ($selected -cnotcontains $Stage) { Write-Log "${Stage}: skipped by CURATE_STAGES"; return }
    $curateArgs = @('curate', $Stage, '--path', $VaultPath) + $StageArgs
    if ($Stage -ne 'inventory') {
        if ($curateModel) { $curateArgs += @('--model', $curateModel) }
        if ($curateMaxCalls) { $curateArgs += @('--max-calls', $curateMaxCalls) }
        if ($curateMaxTokens) { $curateArgs += @('--max-tokens', $curateMaxTokens) }
    }
    if ($Stage -ne 'extract' -and $curateGit -eq 'skip') { $curateArgs += '--no-git' }
    if ($DryRun) { $curateArgs += '--dry-run' }
    $code = Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs ($curateArgs + $envArgs) -Label $Stage
    Set-StageCode -Stage $Stage -Code $code
}

# Steps 1-6: the curator stages, each on the cache the one before it left.
Invoke-CurateStage -Stage 'inventory'
Invoke-CurateStage -Stage 'extract' -StageArgs @('--all')
Invoke-CurateStage -Stage 'ledger' -StageArgs @('--all')
Invoke-CurateStage -Stage 'status' -StageArgs @('--all')
Invoke-CurateStage -Stage 'history' -StageArgs @('--all')
Invoke-CurateStage -Stage 'report' -StageArgs @('--all')

# Step 7: the retrieval provenance report, as JSON for the week and as the
# dashboard page. A dry run writes nothing, so it only says what it would write.
# Forward slashes, so a C:/... folder stays one style of path.
$reportsBase = $ReportsDir.TrimEnd('/', '\')
$day = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$jsonOut = "$reportsBase/retrievals-$day.json"
$htmlOut = "$reportsBase/retrievals-dashboard.html"
if ($selected -cnotcontains 'retrievals') {
    Write-Log 'retrievals: skipped by CURATE_STAGES'
} elseif ($DryRun) {
    Write-Log "retrievals: dry run, would write $jsonOut and $htmlOut"
} else {
    $made = $true
    try {
        if (-not (Test-Path -LiteralPath $reportsBase)) { New-Item -ItemType Directory -Force -Path $reportsBase | Out-Null }
    } catch {
        Write-Log "retrievals: could not create the reports folder $reportsBase ($($_.Exception.Message))"
        $made = $false
    }
    if ($made) {
        $retrievalArgs = @('report', 'retrievals', '--quiet', '--json-out', $jsonOut, '--html', $htmlOut) + $envArgs
        Set-StageCode -Stage 'retrievals' -Code (Invoke-Ingest -Uv $uv -Project $ProjectDir -IngestArgs $retrievalArgs -Label 'retrievals')
    } else {
        Set-StageCode -Stage 'retrievals' -Code 2
    }
}

Write-Log "=== weekly curate finished ($(($codes.Keys | ForEach-Object { "$_ $($codes[$_])" }) -join ', ')) ==="

# Task Scheduler shows this as the last result: 2 when any stage could not run.
# Findings and budget stops are a normal week and report through the log.
exit $runStatus
