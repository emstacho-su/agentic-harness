<#
.SYNOPSIS
    Register (or re-register) the nightly reconcile in Windows Task Scheduler.

.DESCRIPTION
    Idempotent: `Register-ScheduledTask -Force` creates the task or replaces it,
    so running this twice leaves exactly one task. Every path is explicit —
    PowerShell, uv, the project and the vault — because a scheduled task
    inherits almost none of a login shell's environment, and a bare `uv` that
    resolves interactively will not resolve at 03:00.

    The task is verified before it is created: a vault that is not there, a
    project without a pyproject.toml, or a uv that cannot be found are all
    refused here rather than becoming a silent nightly failure.

    Health is staleness, not failure. A task that never fires logs nothing at
    all, so the check is `uv run ingest --health`, which reads the last-success
    timestamp a complete run writes and fails past 36 hours.

.PARAMETER SweepMode
    Passed through to nightly-ingest.ps1. Apply is the intended production
    setting (R-27.2). DryRun registers the task without letting it edit notes.

.PARAMETER RealmSync
    Passed through to nightly-ingest.ps1 (steps -1 and 3, hooks/sync-realms.mjs).
    Apply commits, merge-pulls and pushes the realms. DryRun reports what the
    sync would do, so the first night after a cutover can run without writing;
    switching to Apply is then a re-registration, not a script edit. Skip leaves
    the realms alone.

.PARAMETER Unregister
    Remove the task and exit.

.EXAMPLE
    ./register-nightly-ingest.ps1
    ./register-nightly-ingest.ps1 -At 02:30 -SweepMode DryRun
    ./register-nightly-ingest.ps1 -RealmSync DryRun
    ./register-nightly-ingest.ps1 -Unregister
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string] $TaskName = 'AgenticHarness-NightlyIngest',
    [string] $At = '03:00',
    [string] $VaultPath = '',
    [string] $ProjectDir = '',
    [string] $ScriptPath = '',
    [string] $UvPath = '',
    [string] $PowerShellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe",
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $SweepMode = 'Apply',
    [ValidateSet('Apply', 'DryRun', 'Skip')]
    [string] $RealmSync = 'Apply',
    [switch] $Unregister
)

# ~/.harness/machine.env: what this machine is, through the shared reader
# (Read-MachineEnv, Get-MachineSetting). A parameter passed explicitly still
# wins; the file only replaces the defaults that used to name one machine's paths.
. (Join-Path $PSScriptRoot 'lib\machine-env.ps1')

$machine = Read-MachineEnv
if (-not $VaultPath)  { $VaultPath  = Get-MachineSetting $machine 'HARNESS_VAULT' "C:/Users/$env:USERNAME/OneDrive - Syracuse University/vault" }
if (-not $ProjectDir) { $ProjectDir = Get-MachineSetting $machine 'HARNESS_INGEST_PROJECT' "C:/Users/$env:USERNAME/agentic-harness/ingest" }

$ErrorActionPreference = 'Stop'

function Fail {
    param([string] $Message, [string] $Fix)
    # Not Write-Error: with $ErrorActionPreference = 'Stop' that would end the
    # script before `exit 2`, and the caller would see exit 1 instead.
    [Console]::Error.WriteLine("$Message`n  Fix: $Fix")
    exit 2
}

if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Output "No scheduled task named '$TaskName'. Nothing to remove."
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed scheduled task '$TaskName'."
    exit 0
}

# ---------------------------------------------------------------- validation

if (-not $ScriptPath) {
    $ScriptPath = Join-Path $PSScriptRoot 'nightly-ingest.ps1'
}
if (-not (Test-Path $ScriptPath)) {
    Fail "The runner script was not found at $ScriptPath." 'Pass -ScriptPath, or run this from the repo so nightly-ingest.ps1 sits beside it.'
}
$ScriptPath = (Resolve-Path $ScriptPath).Path

if (-not (Test-Path $PowerShellPath)) {
    Fail "PowerShell was not found at $PowerShellPath." 'Pass -PowerShellPath with the full path to powershell.exe.'
}
if (-not (Test-Path $VaultPath)) {
    Fail "The vault was not found at $VaultPath." 'Pass -VaultPath with a C:/... path. An MSYS /c/... path will not work here.'
}
if (-not (Test-Path (Join-Path $ProjectDir 'pyproject.toml'))) {
    Fail "No ingest project at $ProjectDir." 'Pass -ProjectDir with the directory that holds pyproject.toml.'
}

if (-not $UvPath) {
    $candidate = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (Test-Path $candidate) {
        $UvPath = $candidate
    } else {
        $onPath = Get-Command uv -ErrorAction SilentlyContinue
        if ($onPath) { $UvPath = $onPath.Source }
    }
}
if (-not $UvPath -or -not (Test-Path $UvPath)) {
    Fail 'uv was not found.' 'Pass -UvPath with the full path to uv.exe. A scheduled task does not inherit your PATH.'
}

try {
    $startTime = [datetime]::ParseExact($At, 'HH:mm', $null)
} catch {
    Fail "-At '$At' is not a HH:mm time." 'Use 24-hour time, e.g. 03:00.'
}

# ---------------------------------------------------------------- the task

$arguments = @(
    '-NoProfile'
    '-NonInteractive'
    '-ExecutionPolicy', 'Bypass'
    '-File', "`"$ScriptPath`""
    '-VaultPath', "`"$VaultPath`""
    '-ProjectDir', "`"$ProjectDir`""
    '-UvPath', "`"$UvPath`""
    '-SweepMode', $SweepMode
    '-RealmSync', $RealmSync
) -join ' '

$action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $arguments -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -Daily -At $startTime

# StartWhenAvailable is the setting that matters on a laptop: the machine is
# usually asleep at 03:00, and without it a missed run is simply lost.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 30)

# Interactive, not S4U: the job needs no elevation, and a task that runs only
# while the user is logged on is the honest description of a personal laptop.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$description = @(
    "Agentic harness nightly reconcile (R-27.5): conclude stale session notes, then re-ingest the vault into harness-memory."
    "Sweep mode: $SweepMode. Realm sync: $RealmSync. Health check: uv --directory `"$ProjectDir`" run ingest --health (fails past 36 h)."
    "Log: $env:USERPROFILE\.claude\hooks\nightly-ingest.log"
) -join ' '

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description $description `
    -Force | Out-Null

Write-Output "Registered '$TaskName'."
Get-ScheduledTask -TaskName $TaskName |
    Select-Object TaskName, State, @{ Name = 'NextRunTime'; Expression = { (Get-ScheduledTaskInfo -TaskName $_.TaskName).NextRunTime } } |
    Format-List

Write-Output 'Verify with:'
Write-Output "  Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Output "  Start-ScheduledTask -TaskName $TaskName   # run it now"
Write-Output "  uv --directory `"$ProjectDir`" run ingest --health"
