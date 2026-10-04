<#
.SYNOPSIS
    Register (or re-register) the weekly curator run in Windows Task Scheduler.

.DESCRIPTION
    Runs weekly-curate.ps1 every Sunday at 04:30: after the nightly reconcile
    (03:00) and the store backup, so the curator reads a vault and a store that
    are both fresh.

    Idempotent: `Register-ScheduledTask -Force` creates the task or replaces it,
    so running this twice leaves exactly one task. Every path is explicit —
    PowerShell, uv, the project and the vault — because a scheduled task
    inherits almost none of a login shell's environment, and a bare `uv` that
    resolves interactively will not resolve at 04:30.

    The task is verified before it is created: a vault that is not there, a
    project without a pyproject.toml, or a uv that cannot be found are all
    refused here rather than becoming a silent weekly failure.

    The model, the budget, git and the stage list are not arguments of the
    task: weekly-curate.ps1 reads them (CURATE_*) from the environment and
    ~/.harness/machine.env at each run, so changing them needs no
    re-registration.

    Stack runs this, with the `!` prefix. No automation registers it.

.PARAMETER At
    24-hour HH:mm start time on Sunday (default 04:30).

.PARAMETER DryRun
    Register the task with -DryRun, so it calls no judge and writes nothing:
    a first week that only shows what it would do. Switching to a live run is
    a re-registration without -DryRun, not a script edit.

.PARAMETER Unregister
    Remove the task and exit.

.EXAMPLE
    ./register-weekly-curate.ps1
    ./register-weekly-curate.ps1 -DryRun
    ./register-weekly-curate.ps1 -At 05:00
    ./register-weekly-curate.ps1 -Unregister
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string] $TaskName = 'AgenticHarness-WeeklyCurate',
    [string] $At = '04:30',
    [string] $VaultPath = '',
    [string] $ProjectDir = '',
    [string] $ScriptPath = '',
    [string] $UvPath = '',
    [string] $PowerShellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe",
    [switch] $DryRun,
    [switch] $Unregister
)

# ~/.harness/machine.env: what this machine is, through the shared reader
# (Read-MachineEnv, Get-MachineSetting). A parameter passed explicitly still
# wins; the file only replaces the defaults that used to name one machine's paths.
. (Join-Path $PSScriptRoot 'lib\machine-env.ps1')

$machine = Read-MachineEnv
if (-not $VaultPath)  { $VaultPath  = Get-MachineSetting $machine 'HARNESS_VAULT' "$($env:USERPROFILE -replace '\\', '/')/vault" }
if (-not $ProjectDir) { $ProjectDir = Get-MachineSetting $machine 'HARNESS_INGEST_PROJECT' "C:/Users/$env:USERNAME/agentic-harness/ingest" }
if (-not $UvPath)     { $UvPath     = Get-MachineSetting $machine 'HARNESS_UV' '' }
$logPath = Get-MachineSetting $machine 'HARNESS_WEEKLY_LOG' "C:/Users/$env:USERNAME/.claude/hooks/weekly-curate.log"

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
    $ScriptPath = Join-Path $PSScriptRoot 'weekly-curate.ps1'
}
if (-not (Test-Path $ScriptPath)) {
    Fail "The runner script was not found at $ScriptPath." 'Pass -ScriptPath, or run this from the repo so weekly-curate.ps1 sits beside it.'
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
    Fail "-At '$At' is not a HH:mm time." 'Use 24-hour time, e.g. 04:30.'
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
)
if ($DryRun) { $arguments += '-DryRun' }
$arguments = $arguments -join ' '

$action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $arguments -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $startTime

# StartWhenAvailable is the setting that matters on a laptop: the machine is
# often asleep on a Sunday morning, and without it a missed week is simply lost.
# Three hours: the extract stage makes judge calls, and its budget, not the
# clock, is meant to be what stops a long week.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 30)

# Interactive, not S4U: the judge runs `claude -p` on the user's own login, and
# a task that runs only while the user is logged on is the honest description
# of a personal laptop.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$mode = if ($DryRun) { 'dry run (no judge call, no write)' } else { 'live' }
$description = @(
    "Agentic harness weekly curator (Phase C): inventory, extract, ledger, status, history and the curation report, then the retrievals report and dashboard."
    "Sunday after the nightly reconcile and the store backup. Mode: $mode. Settings: CURATE_* in ~/.harness/machine.env."
    "Log: $logPath"
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
Write-Output "  Get-Content `"$logPath`" -Tail 40"
