<#
.SYNOPSIS
    Register (or re-register) the twice-daily /checkpoint collection in Task Scheduler.

.DESCRIPTION
    Runs `node hooks/collect-checkpoints.mjs --ingest` at each time in -Times
    (default 12:00 and 18:00). The collector fetches the tracked repositories,
    files every /checkpoint note a cloud session pushed into the vault, and
    starts a detached ingest for the notes it wrote, so a session checkpointed
    at noon is searchable by early afternoon rather than after the 03:00
    reconcile. The nightly job still runs the collector as its step 0b, so a
    missed daytime run costs nothing.

    Idempotent (`Register-ScheduledTask -Force`), every path explicit, and
    verified before registering, like register-nightly-ingest.ps1.

.PARAMETER Times
    24-hour HH:mm times, one trigger each. Default @('12:00', '18:00').

.PARAMETER Repos
    Repositories to collect from. Empty means the collector's own defaults
    (~/agentic-harness and ~/projects/bb2dash).

.PARAMETER Unregister
    Remove the task and exit.

.EXAMPLE
    ./register-checkpoint-collect.ps1
    ./register-checkpoint-collect.ps1 -Times @('09:00', '13:00', '17:00')
    ./register-checkpoint-collect.ps1 -Unregister
#>
# PositionalBinding off: `powershell -File … -Authors @('a', 'b')` splits the
# array and would otherwise hand 'b' to -TaskName, registering a task named
# after an email address. With it off, a stray positional value is an error.
[CmdletBinding(PositionalBinding = $false)]
param(
    [string] $TaskName = 'AgenticHarness-CheckpointCollect',
    [string[]] $Times = @('12:00', '18:00'),
    [string] $VaultPath = "C:/Users/$env:USERNAME/OneDrive - Syracuse University/vault",
    [string] $HooksDir = "C:/Users/$env:USERNAME/agentic-harness/hooks",
    [string] $NodePath = '',
    [string[]] $Repos = @(),
    # Author emails whose commits may carry a note; empty accepts any author
    # (see "The trust boundary, stated" in hooks/README.md).
    [string[]] $Authors = @(),
    [switch] $Unregister
)

$ErrorActionPreference = 'Stop'

function Fail {
    param([string] $Message, [string] $Fix)
    Write-Error "$Message`n  Fix: $Fix"
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

$collectScript = Join-Path $HooksDir 'collect-checkpoints.mjs'
if (-not (Test-Path $collectScript)) {
    Fail "The collector was not found at $collectScript." 'Pass -HooksDir with the hooks directory of the agentic-harness checkout.'
}
$collectScript = (Resolve-Path $collectScript).Path

if (-not (Test-Path $VaultPath)) {
    Fail "The vault was not found at $VaultPath." 'Pass -VaultPath with a C:/... path. An MSYS /c/... path will not work here.'
}

if (-not $NodePath) {
    $standard = 'C:/Program Files/nodejs/node.exe'
    if (Test-Path $standard) {
        $NodePath = $standard
    } else {
        $onPath = Get-Command node -ErrorAction SilentlyContinue
        if ($onPath) { $NodePath = $onPath.Source }
    }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) {
    Fail 'node was not found.' 'Pass -NodePath with the full path to node.exe. A scheduled task does not inherit your PATH.'
}
$NodePath = (Resolve-Path $NodePath).Path

foreach ($repo in $Repos) {
    if (-not (Test-Path (Join-Path $repo '.git'))) {
        Fail "Not a git repository: $repo" 'Pass -Repos with checkout directories, or omit it for the defaults.'
    }
}

$triggers = @()
foreach ($time in $Times) {
    try {
        $startTime = [datetime]::ParseExact($time, 'HH:mm', $null)
    } catch {
        Fail "-Times entry '$time' is not a HH:mm time." 'Use 24-hour times, e.g. 12:00.'
    }
    $triggers += New-ScheduledTaskTrigger -Daily -At $startTime
}
if ($triggers.Count -eq 0) {
    Fail '-Times is empty.' 'Give at least one HH:mm time.'
}

# ---------------------------------------------------------------- the task

$argumentList = @(
    "`"$collectScript`""
    '--vault', "`"$VaultPath`""
    '--ingest'
)
foreach ($repo in $Repos) { $argumentList += @('--repo', "`"$repo`"") }
foreach ($author in $Authors) { $argumentList += @('--author', "`"$author`"") }
$arguments = $argumentList -join ' '

$action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $HooksDir

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -RestartCount 1 `
    -RestartInterval (New-TimeSpan -Minutes 15)

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$description = @(
    "Agentic harness: collect /checkpoint notes that cloud sessions pushed into git, file them in the vault, and ingest them."
    "Runs at $($Times -join ', '). Log: $env:USERPROFILE\.claude\hooks\collect-checkpoints.log"
) -join ' '

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -Principal $principal `
    -Description $description `
    -Force | Out-Null

Write-Output "Registered '$TaskName' at $($Times -join ', ')."
Get-ScheduledTask -TaskName $TaskName |
    Select-Object TaskName, State, @{ Name = 'NextRunTime'; Expression = { (Get-ScheduledTaskInfo -TaskName $_.TaskName).NextRunTime } } |
    Format-List

Write-Output 'Verify with:'
Write-Output "  Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Output "  Start-ScheduledTask -TaskName $TaskName   # run it now"
