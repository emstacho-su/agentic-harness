<#
.SYNOPSIS
    Self-test for scripts/weekly-curate.ps1. No Pester, no uv, no store, no judge.

.DESCRIPTION
    Runs weekly-curate.ps1 in a child `powershell -NoProfile -File` (so its
    `exit` codes are the real ones) against a scratch vault (its name holds a
    space), a scratch project holding an empty pyproject.toml, a scratch
    reports folder, and a fake uv.cmd passed by full path. Nothing real runs:
    the fake records its arguments, one call per line, in $env:FAKE_ARGV_LOG
    and exits with $env:FAKE_CODE_<STAGE> (FAKE_CODE_EXTRACT=3, ...). For
    `report retrievals` it writes the two files named by --json-out and
    --html, the way the real command does, so a dry run that wrote them would
    show. So no judge call, no database, no vault write.

    The cases read the script's own log file and the fake's argument log. They
    cover the stage order, the flags CURATE_* produce and which stages get
    them, that exit 1 and 3 are logged and the run goes on, that exit 2 from
    any stage is logged, the run goes on and the script exits 2, that -DryRun
    reaches every curate stage and writes no report file, that CURATE_STAGES
    narrows the run, that bad settings are refused before anything runs, and
    that the log never holds a value from the machine file. Static checks cover
    the parse, the parameters, `exit $runStatus` as the last statement, and
    that the .ps1 and .sh list the same stages in the same order.

    The machine file is pointed at a path that does not exist unless a case
    names one, so this machine's settings never leak in. The scratch folder
    and every environment change are undone in `finally`. Exits 1 if any case
    failed.

.EXAMPLE
    powershell -NoProfile -File scripts/tests/weekly-curate.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The script under test, its bash twin and the ps1 machine-env reader, one folder up.
$script:ScriptsDir = Split-Path -Parent $PSScriptRoot
$script:WeeklyScript = Join-Path $script:ScriptsDir 'weekly-curate.ps1'
$script:ShScript = Join-Path $script:ScriptsDir 'weekly-curate.sh'
$script:PsLib = Join-Path $script:ScriptsDir 'lib\machine-env.ps1'
# Windows PowerShell 5.1 is the target the scheduled task runs under.
$script:ChildShell = Join-Path $PSHOME 'powershell.exe'

$script:Failures = 0
$script:ScratchRoot = Join-Path $env:TEMP ("weekly-curate-" + [guid]::NewGuid())
$script:Stages = @('inventory', 'extract', 'ledger', 'status', 'history', 'report', 'retrievals')
$script:CurateStages = @('inventory', 'extract', 'ledger', 'status', 'history', 'report')

# Every variable a case may set, saved here and put back in `finally`.
$script:FakeCodeVariables = @($script:Stages | ForEach-Object { "FAKE_CODE_$($_.ToUpperInvariant())" })
$script:SettingVariables = @('CURATE_MODEL', 'CURATE_MAX_CALLS', 'CURATE_MAX_TOKENS', 'CURATE_GIT', 'CURATE_STAGES',
    'HARNESS_WEEKLY_LOG', 'HARNESS_REPORTS_DIR', 'HARNESS_UV', 'HARNESS_VAULT', 'HARNESS_INGEST_PROJECT')
$script:TouchedVariables = @('HARNESS_MACHINE_ENV', 'FAKE_ARGV_LOG') + $script:FakeCodeVariables + $script:SettingVariables
$script:SavedEnvironment = @{}
foreach ($name in $script:TouchedVariables) { $script:SavedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

# uv is called as `uv --directory <project> run ingest <command> <stage> ...`,
# so %6 is the stage (retrievals for the report). Labels, not parenthesised
# blocks: an echo holding `(s)` would end a cmd block early. Every redirection
# comes first, so an argument ending in a digit is never read as a handle.
$script:FakeUv = @(
    '@echo off'
    '>> "%FAKE_ARGV_LOG%" echo %*'
    'echo FAKE-UV %~5 %~6'
    'for %%s in (INVENTORY EXTRACT LEDGER STATUS HISTORY REPORT RETRIEVALS) do if not defined FAKE_CODE_%%s set FAKE_CODE_%%s=0'
    'if "%~6"=="inventory" exit /b %FAKE_CODE_INVENTORY%'
    'if "%~6"=="extract" exit /b %FAKE_CODE_EXTRACT%'
    'if "%~6"=="ledger" exit /b %FAKE_CODE_LEDGER%'
    'if "%~6"=="status" exit /b %FAKE_CODE_STATUS%'
    'if "%~6"=="history" exit /b %FAKE_CODE_HISTORY%'
    'if "%~6"=="report" exit /b %FAKE_CODE_REPORT%'
    'if "%~6"=="retrievals" goto retrievals'
    'exit /b 0'
    ':retrievals'
    'rem %7 --json-out, %8 the JSON path, %9 --html; after one shift, %9 is the HTML path.'
    '> %8 echo {}'
    'shift'
    '> %9 echo ^<html^>^</html^>'
    'exit /b %FAKE_CODE_RETRIEVALS%'
) -join "`r`n"

function New-ScratchDir {
    param([string] $Name)
    $path = Join-Path $script:ScratchRoot $Name
    [void] [System.IO.Directory]::CreateDirectory($path)
    return $path
}

# The folders and the fake every run shares. The vault name holds a space, so
# an argument built as a string instead of an array would show up split.
function New-Fixture {
    $fakeBin = New-ScratchDir 'fake-bin'
    [System.IO.File]::WriteAllText((Join-Path $fakeBin 'uv.cmd'), "$($script:FakeUv)`r`n", [System.Text.Encoding]::ASCII)
    $project = New-ScratchDir 'project'
    [System.IO.File]::WriteAllText((Join-Path $project 'pyproject.toml'), '')
    return [pscustomobject]@{
        Uv = Join-Path $fakeBin 'uv.cmd'
        Project = $project
        Vault = New-ScratchDir 'my vault'
    }
}

# One run of the script in a child shell. Returns its exit code, its log, the
# fake's argument log and the reports folder. -NoPaths leaves -LogPath and
# -ReportsDir off, so the environment or the machine file must supply them.
function Invoke-Weekly {
    param($Fixture, [string] $Name, [string[]] $ExtraArgs = @(), [hashtable] $Environment = @{}, [switch] $NoPaths)
    $logPath = Join-Path $script:ScratchRoot "$Name.log"
    $argvPath = Join-Path $script:ScratchRoot "$Name.argv"
    $reports = Join-Path $script:ScratchRoot "$Name-reports"
    [System.IO.File]::WriteAllText($argvPath, '')
    $scriptArgs = @('-VaultPath', $Fixture.Vault, '-ProjectDir', $Fixture.Project, '-UvPath', $Fixture.Uv)
    if (-not $NoPaths) { $scriptArgs += @('-LogPath', $logPath, '-ReportsDir', $reports) }
    $scriptArgs += $ExtraArgs
    foreach ($name in ($script:FakeCodeVariables + $script:SettingVariables)) {
        [Environment]::SetEnvironmentVariable($name, $Environment[$name])
    }
    $machineFile = if ($Environment.ContainsKey('HARNESS_MACHINE_ENV')) { $Environment['HARNESS_MACHINE_ENV'] } else { Join-Path $script:ScratchRoot 'absent.env' }
    [Environment]::SetEnvironmentVariable('HARNESS_MACHINE_ENV', $machineFile)
    [Environment]::SetEnvironmentVariable('FAKE_ARGV_LOG', $argvPath)

    $ErrorActionPreference = 'Continue'
    $output = @(& $script:ChildShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:WeeklyScript @scriptArgs 2>&1)
    $code = $LASTEXITCODE
    $log = if (Test-Path -LiteralPath $logPath) { @(Get-Content -LiteralPath $logPath -Encoding UTF8) } else { @() }
    $argv = @(Get-Content -LiteralPath $argvPath | Where-Object { $_ })
    return [pscustomobject]@{
        Code = $code; Log = $log; Argv = $argv; Reports = $reports; LogPath = $logPath
        Output = (($output | ForEach-Object { "$_" }) -join "`n")
    }
}

function Test-Check {
    param([string] $Name, [bool] $Ok, [string] $Detail = '')
    if ($Ok) { Write-Output "PASS $Name"; return }
    $script:Failures++
    Write-Output "FAIL $Name$(if ($Detail) { " -- $Detail" })"
}

# The index of the first line holding $Text, or -1.
function Get-LineIndex {
    param([string[]] $Log, [string] $Text)
    for ($i = 0; $i -lt $Log.Count; $i++) { if ($Log[$i].Contains($Text)) { return $i } }
    return -1
}

function Test-LogHas {
    param([string[]] $Log, [string] $Text)
    return (Get-LineIndex $Log $Text) -ge 0
}

# A log that is not there proves nothing, so it lacks nothing.
function Test-LogLacks {
    param([string[]] $Log, [string] $Text)
    return ($Log.Count -gt 0) -and -not (Test-LogHas $Log $Text)
}

# The stages the fake was called for, in call order, as one string.
function Get-CalledStages {
    param($Run)
    $names = foreach ($line in $Run.Argv) {
        $match = [regex]::Match($line, '\brun ingest (?:curate|report) ([a-z]+)\b')
        if ($match.Success) { $match.Groups[1].Value }
    }
    return (@($names) -join ' ')
}

# The fake's argument line for one stage, or ''.
function Get-Call {
    param($Run, [string] $Stage)
    foreach ($line in $Run.Argv) { if ($line -match "\brun ingest (?:curate|report) $Stage\b") { return $line } }
    return ''
}

function Test-CallHas {
    param($Run, [string] $Stage, [string] $Text)
    return (Get-Call $Run $Stage).Contains($Text)
}

function Test-CallLacks {
    param($Run, [string] $Stage, [string] $Text)
    $call = Get-Call $Run $Stage
    return $call -and -not $call.Contains($Text)
}

function Test-NoReports {
    param($Run)
    if (-not (Test-Path -LiteralPath $Run.Reports)) { return $true }
    return @(Get-ChildItem -LiteralPath $Run.Reports -Force).Count -eq 0
}

# The stage list each script runs, as one string.
function Get-StageLists {
    $psText = Get-Content -LiteralPath $script:WeeklyScript -Raw
    $shText = Get-Content -LiteralPath $script:ShScript -Raw
    $psMatch = [regex]::Match($psText, '(?m)^\$script:WeeklyStages\s*=\s*@\(([^)]*)\)')
    $shMatch = [regex]::Match($shText, "(?m)^WEEKLY_STAGES='([^']*)'")
    if (-not $psMatch.Success) { throw "no `$script:WeeklyStages list in $script:WeeklyScript" }
    if (-not $shMatch.Success) { throw "no WEEKLY_STAGES in $script:ShScript" }
    $psNames = @($psMatch.Groups[1].Value -split ',' | ForEach-Object { $_.Trim().Trim("'") } | Where-Object { $_ })
    $shNames = @($shMatch.Groups[1].Value -split '\s+' | Where-Object { $_ })
    return [pscustomobject]@{ Ps = ($psNames -join ' '); Sh = ($shNames -join ' ') }
}

$allCalled = $script:Stages -join ' '

try {
    if (-not (Test-Path -LiteralPath $script:WeeklyScript)) { throw "weekly-curate.ps1 not found at $script:WeeklyScript" }
    [void] [System.IO.Directory]::CreateDirectory($script:ScratchRoot)

    # (1) static: the script parses, ends on the exit-code rule, takes the nightly's parameters.
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:WeeklyScript, [ref] $null, [ref] $parseErrors)
    Test-Check 'the script parses with no errors' (@($parseErrors).Count -eq 0) (($parseErrors | ForEach-Object { $_.Message }) -join '; ')
    $lastStatement = $ast.EndBlock.Statements[$ast.EndBlock.Statements.Count - 1].Extent.Text
    Test-Check 'the last statement is `exit $runStatus`' ($lastStatement -ceq 'exit $runStatus') "got '$lastStatement'"
    $parameters = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    foreach ($name in @('VaultPath', 'ProjectDir', 'UvPath', 'LogPath', 'DryRun')) {
        Test-Check "the script takes -$name" ($parameters -contains $name) ($parameters -join ', ')
    }
    $header = "$($ast.GetHelpContent().Description)"
    foreach ($key in @('CURATE_MODEL', 'CURATE_MAX_CALLS', 'CURATE_MAX_TOKENS', 'CURATE_GIT', 'CURATE_STAGES')) {
        Test-Check "the header names $key" ($header.Contains($key))
    }
    $registerPath = Join-Path $script:ScriptsDir 'register-weekly-curate.ps1'
    $registerErrors = $null
    [void] [System.Management.Automation.Language.Parser]::ParseFile($registerPath, [ref] $null, [ref] $registerErrors)
    Test-Check 'register-weekly-curate.ps1 parses with no errors' (@($registerErrors).Count -eq 0) (($registerErrors | ForEach-Object { $_.Message }) -join '; ')

    # (2) the .ps1 and the .sh run the same stages in the same order: the contract's.
    $lists = Get-StageLists
    Test-Check 'weekly-curate.ps1 and .sh list the same stages in the same order' ($lists.Ps -ceq $lists.Sh) "ps1 '$($lists.Ps)' vs sh '$($lists.Sh)'"
    Test-Check "the stage list is the contract's weekly order" ($lists.Ps -ceq $allCalled) $lists.Ps

    $fixture = New-Fixture
    $today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')

    # (3) a clean week: every stage, in order, with its arguments.
    $r = Invoke-Weekly $fixture 'clean'
    Test-Check "a clean week exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    Test-Check "the stages run in the contract's order" ((Get-CalledStages $r) -ceq $allCalled) (Get-CalledStages $r)
    Test-Check 'inventory is called with the vault path' (Test-LogHas $r.Log "inventory : uv run ingest curate inventory --path $($fixture.Vault)") ($r.Log -join "`n")
    Test-Check 'inventory gets no --all' (Test-CallLacks $r 'inventory' '--all')
    foreach ($stage in @('extract', 'ledger', 'status', 'history', 'report')) {
        Test-Check "$stage gets --path <vault> --all" (Test-LogHas $r.Log "$stage : uv run ingest curate $stage --path $($fixture.Vault) --all")
    }
    foreach ($flag in @('--model', '--max-calls', '--max-tokens', '--no-git', '--dry-run')) {
        Test-Check "with no CURATE_* set, no stage gets $flag" (-not (($r.Argv -join "`n").Contains($flag)))
    }
    $jsonOut = "$($r.Reports)/retrievals-$today.json"
    $htmlOut = "$($r.Reports)/retrievals-dashboard.html"
    Test-Check 'retrievals writes the dated JSON and the dashboard' (Test-LogHas $r.Log "retrievals : uv run ingest report retrievals --quiet --json-out $jsonOut --html $htmlOut") ($r.Log -join "`n")
    Test-Check 'the reports folder is created and both files are there' ((Test-Path -LiteralPath $jsonOut) -and (Test-Path -LiteralPath $htmlOut))
    Test-Check "a stage's own output reaches the log" (Test-LogHas $r.Log 'extract | FAKE-UV curate extract')
    Test-Check "the finish line lists every stage's code" (Test-LogHas $r.Log '(inventory 0, extract 0, ledger 0, status 0, history 0, report 0, retrievals 0) ===')
    Test-Check 'a clean week logs no "ended with"' (Test-LogLacks $r.Log 'ended with')

    # (4) the CURATE_* settings, and which stages take which flag.
    $r = Invoke-Weekly $fixture 'flags' -Environment @{ CURATE_MODEL = 'fake-model'; CURATE_MAX_CALLS = '7'; CURATE_MAX_TOKENS = '9000'; CURATE_GIT = 'skip' }
    Test-Check "a week with every setting exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    foreach ($stage in @('extract', 'ledger', 'history', 'report')) {
        Test-Check "$stage gets --model --max-calls --max-tokens" (Test-CallHas $r $stage '--model fake-model --max-calls 7 --max-tokens 9000') (Get-Call $r $stage)
    }
    Test-Check 'inventory gets no --model (it calls no judge)' (Test-CallLacks $r 'inventory' '--model')
    Test-Check 'inventory gets no --max-calls' (Test-CallLacks $r 'inventory' '--max-calls')
    Test-Check 'status gets no --model (it calls no judge)' (Test-CallLacks $r 'status' '--model')
    Test-Check 'status gets no --max-calls' (Test-CallLacks $r 'status' '--max-calls')
    foreach ($stage in @('inventory', 'ledger', 'status', 'history', 'report')) {
        Test-Check "CURATE_GIT=skip gives $stage --no-git" (Test-CallHas $r $stage '--no-git')
    }
    Test-Check 'extract gets no --no-git (it reads no git)' (Test-CallLacks $r 'extract' '--no-git')
    Test-Check 'retrievals gets none of the curate flags' (Test-CallLacks $r 'retrievals' '--model')

    $r = Invoke-Weekly $fixture 'git-apply' -Environment @{ CURATE_GIT = 'apply' }
    Test-Check 'CURATE_GIT=apply adds no --no-git' (-not (($r.Argv -join "`n").Contains('--no-git')))

    # (5) exit 3 and exit 1 are logged and the run goes on.
    $r = Invoke-Weekly $fixture 'budget' -Environment @{ FAKE_CODE_EXTRACT = '3' }
    Test-Check "extract stopped by budget still exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    Test-Check 'the budget stop is logged' (Test-LogHas $r.Log 'extract ended with 3 (stopped by budget)')
    Test-Check 'every later stage still runs' ((Get-CalledStages $r) -ceq $allCalled) (Get-CalledStages $r)
    Test-Check 'the finish line carries the 3' (Test-LogHas $r.Log '(inventory 0, extract 3, ledger 0,')

    $r = Invoke-Weekly $fixture 'findings' -Environment @{ FAKE_CODE_LEDGER = '1'; FAKE_CODE_INVENTORY = '1' }
    Test-Check "findings still exit 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    Test-Check "the ledger's findings are logged" (Test-LogHas $r.Log 'ledger ended with 1 (findings)')
    Test-Check "inventory's findings are logged" (Test-LogHas $r.Log 'inventory ended with 1 (findings)')
    Test-Check 'every stage still runs after findings' ((Get-CalledStages $r) -ceq $allCalled) (Get-CalledStages $r)

    # (6) exit 2 from any stage: logged, the run goes on, the script exits 2.
    foreach ($stage in $script:Stages) {
        $r = Invoke-Weekly $fixture "fail-$stage" -Environment @{ "FAKE_CODE_$($stage.ToUpperInvariant())" = '2' }
        Test-Check "exit 2 from $stage makes the week exit 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Output
        Test-Check "exit 2 from $stage is logged" (Test-LogHas $r.Log "$stage ended with 2 (could not run)")
        Test-Check "every stage still runs after $stage could not run" ((Get-CalledStages $r) -ceq $allCalled) (Get-CalledStages $r)
    }
    Test-Check 'the finish line carries the 2' (Test-LogHas $r.Log 'retrievals 2) ===')

    $r = Invoke-Weekly $fixture 'odd-code' -Environment @{ FAKE_CODE_HISTORY = '127' }
    Test-Check "an unexpected exit code counts as could not run (exit $($r.Code))" ($r.Code -eq 2) $r.Output

    # (7) -DryRun: every curate stage gets --dry-run, and no report file is written.
    $r = Invoke-Weekly $fixture 'dry' -ExtraArgs @('-DryRun')
    Test-Check "a dry run exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    foreach ($stage in $script:CurateStages) {
        Test-Check "$stage gets --dry-run" (Test-CallHas $r $stage '--dry-run') (Get-Call $r $stage)
    }
    Test-Check 'the retrievals command does not run' (-not (Get-Call $r 'retrievals'))
    Test-Check 'no report file and no reports folder' (Test-NoReports $r)
    Test-Check 'the log says what would be written' (Test-LogHas $r.Log "retrievals: dry run, would write $($r.Reports)/retrievals-")

    # (8) CURATE_STAGES narrows the run; comma or space separated.
    $r = Invoke-Weekly $fixture 'only-comma' -Environment @{ CURATE_STAGES = 'status,report' }
    Test-Check "CURATE_STAGES=status,report exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    Test-Check 'CURATE_STAGES=status,report runs only those' ((Get-CalledStages $r) -ceq 'status report') (Get-CalledStages $r)
    Test-Check 'a stage left out is logged as skipped' (Test-LogHas $r.Log 'extract: skipped by CURATE_STAGES')
    Test-Check 'no report file when retrievals is left out' (Test-NoReports $r)

    $r = Invoke-Weekly $fixture 'only-space' -Environment @{ CURATE_STAGES = 'report status' }
    Test-Check "a space-separated list works, and the order stays the contract's" ((Get-CalledStages $r) -ceq 'status report') (Get-CalledStages $r)

    $r = Invoke-Weekly $fixture 'only-retrievals' -Environment @{ CURATE_STAGES = 'retrievals' }
    Test-Check 'CURATE_STAGES=retrievals runs only the retrievals report' ((Get-CalledStages $r) -ceq 'retrievals') (Get-CalledStages $r)

    # (9) bad settings are refused before anything runs, and never echoed.
    $r = Invoke-Weekly $fixture 'bad-stage' -Environment @{ CURATE_STAGES = 'status,bogus-stage-name' }
    Test-Check "an unknown stage name exits 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Output
    Test-Check 'nothing runs after an unknown stage name' ($r.Argv.Count -eq 0) ($r.Argv -join "`n")
    Test-Check 'the refusal is a FATAL line' (Test-LogHas $r.Log 'FATAL CURATE_STAGES')
    Test-Check 'the unknown name is not echoed' (Test-LogLacks $r.Log 'bogus-stage-name')

    $r = Invoke-Weekly $fixture 'bad-git' -Environment @{ CURATE_GIT = 'sometimes-maybe' }
    Test-Check "a bad CURATE_GIT exits 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Output
    Test-Check 'nothing runs after a bad CURATE_GIT' ($r.Argv.Count -eq 0)
    Test-Check 'the bad CURATE_GIT value is not echoed' (Test-LogLacks $r.Log 'sometimes-maybe')

    $r = Invoke-Weekly $fixture 'bad-calls' -Environment @{ CURATE_MAX_CALLS = 'lots-of-calls' }
    Test-Check "a non-integer CURATE_MAX_CALLS exits 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Output
    Test-Check 'the bad CURATE_MAX_CALLS value is not echoed' (Test-LogLacks $r.Log 'lots-of-calls')

    $r = Invoke-Weekly $fixture 'bad-tokens' -Environment @{ CURATE_MAX_TOKENS = '0' }
    Test-Check "CURATE_MAX_TOKENS=0 exits 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Output

    # (10) the vault, project and uv checks, as in the nightly script.
    $missing = [pscustomobject]@{ Uv = $fixture.Uv; Project = $fixture.Project; Vault = (Join-Path $script:ScratchRoot 'no such vault') }
    $r = Invoke-Weekly $missing 'no-vault'
    Test-Check "a missing vault exits 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Output
    Test-Check 'a missing vault is a FATAL line' (Test-LogHas $r.Log 'FATAL vault not found')
    Test-Check 'nothing runs without a vault' ($r.Argv.Count -eq 0)

    $missing = [pscustomobject]@{ Uv = $fixture.Uv; Project = (Join-Path $script:ScratchRoot 'no-project'); Vault = $fixture.Vault }
    $r = Invoke-Weekly $missing 'no-project'
    Test-Check "a missing project exits 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Output
    Test-Check 'a missing project is a FATAL line' (Test-LogHas $r.Log 'FATAL no ingest project')

    $missing = [pscustomobject]@{ Uv = (Join-Path $script:ScratchRoot 'no-uv.exe'); Project = $fixture.Project; Vault = $fixture.Vault }
    $r = Invoke-Weekly $missing 'no-uv'
    Test-Check "a missing uv exits 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Output
    Test-Check 'a missing uv is a FATAL line' (Test-LogHas $r.Log 'FATAL uv not found')

    # (11) the machine file: its paths are used, its values never reach the log.
    $machineFile = Join-Path $script:ScratchRoot 'machine.env'
    $fileLog = Join-Path $script:ScratchRoot 'from-file\weekly.log'
    $fileReports = Join-Path $script:ScratchRoot 'from-file\reports'
    [System.IO.File]::WriteAllText($machineFile, ((@(
        "HARNESS_WEEKLY_LOG=$fileLog"
        "HARNESS_REPORTS_DIR=$fileReports"
        'DATABASE_URL=postgres://weekly-user:weekly-sekrit-7731@db.invalid:5432/harness'
        'DATABASE_CA_CERT=C:/certs/weekly-ca-cert-7731.pem'
        'ANTHROPIC_API_KEY=sk-ant-weekly-fake-7731'
        'CURATE_MODEL=file-model-x9'
    ) -join "`n") + "`n"))
    $r = Invoke-Weekly $fixture 'machine-file' -NoPaths -Environment @{ HARNESS_MACHINE_ENV = $machineFile }
    $fileLines = if (Test-Path -LiteralPath $fileLog) { @(Get-Content -LiteralPath $fileLog -Encoding UTF8) } else { @() }
    Test-Check "a week configured by the machine file exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Output
    Test-Check 'HARNESS_WEEKLY_LOG from the file names the log' ($fileLines.Count -gt 0)
    Test-Check 'HARNESS_REPORTS_DIR from the file names the reports folder' (Test-Path -LiteralPath (Join-Path $fileReports 'retrievals-dashboard.html'))
    Test-Check 'the database URL never reaches the log' (Test-LogLacks $fileLines 'weekly-sekrit-7731')
    Test-Check 'no machine-file value but the two paths reaches the log' (Test-LogLacks $fileLines '-7731')
    if ((Get-Content -LiteralPath $script:PsLib -Raw).Contains('CURATE_MODEL')) {
        Test-Check 'CURATE_MODEL from the file reaches the judge stages' (Test-CallHas $r 'extract' '--model file-model-x9') (Get-Call $r 'extract')
    } else {
        Write-Output 'SKIP CURATE_MODEL from the file (lib/machine-env.ps1 does not accept CURATE_* keys yet)'
    }

    $envLog = Join-Path $script:ScratchRoot 'env-wins.log'
    $r = Invoke-Weekly $fixture 'env-wins' -NoPaths -Environment @{ HARNESS_MACHINE_ENV = $machineFile; HARNESS_WEEKLY_LOG = $envLog; HARNESS_REPORTS_DIR = (Join-Path $script:ScratchRoot 'env-wins-reports') }
    Test-Check 'the environment wins over the file for the log path' (Test-Path -LiteralPath $envLog)

    # (12) a switch the script does not have is refused before anything runs.
    $r = Invoke-Weekly $fixture 'bad-arg' -ExtraArgs @('-NoSuchSwitch')
    Test-Check "an unknown parameter is refused (exit $($r.Code))" ($r.Code -ne 0 -and $r.Log.Count -eq 0 -and $r.Argv.Count -eq 0) $r.Output
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
