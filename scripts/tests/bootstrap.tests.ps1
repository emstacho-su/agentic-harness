<#
.SYNOPSIS
    Self-test for scripts/bootstrap.ps1. No Pester, no network, no Docker.

.DESCRIPTION
    Runs bootstrap.ps1 in a child `powershell -NoProfile -File` (so its exit
    codes are the real ones) with USERPROFILE pointed at a scratch home (its
    name holds a space) and fake git, uv, node, npm and docker (.cmd files)
    first on PATH. Every fake appends one line to a calls log
    ("<tool> [<cwd folder>] <args>") and exits with FAKE_EXIT_<TOOL> (0 by
    default). The fake git clone makes the target folder with a .git that
    remembers its URL, which the fake `git -C <dir> remote get-url origin`
    prints back. The fake uv exits FAKE_EXIT_EMBED on embed-check; the fake
    node prints FAKE_DOCTOR_OUTPUT when it runs doctor.mjs, and exits
    FAKE_EXIT_DOCTOR only when it was given --strict. Nothing real runs:
    no clone, no store, no ~/.claude. Before any real run the harness checks,
    from a dry run's preflight lines, that every tool resolved to a fake.

    The cases match scripts/tests/bootstrap.tests.sh: the step list (and that
    bootstrap.sh holds the same one), step order, -DryRun and --dry-run run
    nothing, stop at the first failure with the step named, skip-if-present for
    every clone, the doctor gate, the realm remotes, and the MANUAL reminders.
    The scratch folder and every environment change are undone in `finally`.
    Exits 1 if any case failed.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/bootstrap.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$script:ScriptsDir = Split-Path -Parent $PSScriptRoot
$script:Bootstrap = Join-Path $script:ScriptsDir 'bootstrap.ps1'
$script:ShBootstrap = Join-Path $script:ScriptsDir 'bootstrap.sh'
# Windows PowerShell 5.1 is the target.
$script:ChildShell = Join-Path $PSHOME 'powershell.exe'
# The order R-H6 and the dev-VM runbook in docs/portable.md fix.
$script:ExpectedSteps = 'preflight clone uv-sync mcp-build store embed-migrate realms config install doctor'
$script:HarnessUrl = 'https://github.com/emstacho-su/agentic-harness.git'
$script:ConfigUrl = 'https://github.com/emstacho-su/claude-config.git'
$script:RealmBase = 'https://github.com/work-acct'
$script:Tools = @('git', 'uv', 'node', 'npm', 'docker')

$script:Failures = 0
$script:ScratchRoot = Join-Path $env:TEMP ("bootstrap-tests-" + [guid]::NewGuid())
$script:FakeBin = Join-Path $script:ScratchRoot 'fake-bin'

# Every variable a case may set or the bootstrap may read, saved here and put back in `finally`.
$script:FakeVariables = @('FAKE_CALLS', 'FAKE_EXIT_GIT', 'FAKE_EXIT_UV', 'FAKE_EXIT_EMBED', 'FAKE_EXIT_NODE', 'FAKE_EXIT_NPM', 'FAKE_EXIT_DOCKER', 'FAKE_EXIT_DOCTOR', 'FAKE_DOCTOR_OUTPUT')
$script:ClearedVariables = @('HARNESS_MACHINE_ENV', 'HARNESS_VAULT', 'HARNESS_REALMS', 'HARNESS_REALM_REMOTE_BASE', 'HARNESS_REALM_REMOTE_WORK_VM', 'HARNESS_STORE_CONTAINER', 'HARNESS_STORE_DB')
$script:TouchedVariables = @('USERPROFILE', 'PATH') + $script:FakeVariables + $script:ClearedVariables
$script:SavedEnvironment = @{}
foreach ($name in $script:TouchedVariables) { $script:SavedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

# Shared head of every fake: log "<tool> [<cwd folder>] <args>".
function Get-FakeHead {
    param([string] $Tool)
    $exitVar = "FAKE_EXIT_$($Tool.ToUpperInvariant())"
    return @(
        '@echo off'
        "if not defined $exitVar set $exitVar=0"
        'for %%I in (.) do set "FAKE_CWD=%%~nxI"'
        ">> `"%FAKE_CALLS%`" echo $Tool [%FAKE_CWD%] %*"
    )
}

# `git clone -- <url> <dir>`: %3 the url, %4 the dir. `git -C <dir> remote get-url origin`: %2 the dir.
$script:FakeBodies = @{
    'git' = @(
        'if "%~1"=="clone" goto clone'
        'if "%~1"=="-C" goto probe'
        'exit /b %FAKE_EXIT_GIT%'
        ':clone'
        'set "FAKE_DIR=%~4"'
        'set "FAKE_DIR=%FAKE_DIR:/=\%"'
        'mkdir "%FAKE_DIR%\.git" "%FAKE_DIR%\ingest" "%FAKE_DIR%\mcp-server" "%FAKE_DIR%\db" "%FAKE_DIR%\hooks" 2>nul'
        '> "%FAKE_DIR%\.git\fake-origin" echo %~3'
        'exit /b %FAKE_EXIT_GIT%'
        ':probe'
        'set "FAKE_DIR=%~2"'
        'set "FAKE_DIR=%FAKE_DIR:/=\%"'
        'if not exist "%FAKE_DIR%\.git\fake-origin" exit /b 2'
        'type "%FAKE_DIR%\.git\fake-origin"'
        'exit /b 0'
    )
    'uv' = @(
        'if not defined FAKE_EXIT_EMBED set FAKE_EXIT_EMBED=0'
        'if "%~3"=="embed-check" exit /b %FAKE_EXIT_EMBED%'
        'exit /b %FAKE_EXIT_UV%'
    )
    'node' = @(
        'if not "%~1"=="hooks/doctor.mjs" exit /b %FAKE_EXIT_NODE%'
        'if not defined FAKE_EXIT_DOCTOR set FAKE_EXIT_DOCTOR=0'
        'echo machine file  fake'
        'if defined FAKE_DOCTOR_OUTPUT echo %FAKE_DOCTOR_OUTPUT%'
        'if not "%~2"=="--strict" exit /b 0'
        'exit /b %FAKE_EXIT_DOCTOR%'
    )
    'npm' = @('exit /b %FAKE_EXIT_NPM%')
    'docker' = @('exit /b %FAKE_EXIT_DOCKER%')
}

function New-Fakes {
    [void] [System.IO.Directory]::CreateDirectory($script:FakeBin)
    foreach ($tool in $script:Tools) {
        $text = ((Get-FakeHead $tool) + $script:FakeBodies[$tool]) -join "`r`n"
        [System.IO.File]::WriteAllText((Join-Path $script:FakeBin "$tool.cmd"), "$text`r`n", [System.Text.Encoding]::ASCII)
    }
}

# A fresh scratch home holding only the machine file. Returns its path.
function New-FakeHome {
    param([string] $Name, [string[]] $MachineLines = @())
    $homeDir = Join-Path (Join-Path $script:ScratchRoot $Name) 'fake home'
    [void] [System.IO.Directory]::CreateDirectory((Join-Path $homeDir '.harness'))
    $vault = (Join-Path $homeDir 'vault') -replace '\\', '/'
    $lines = @("HARNESS_VAULT=$vault") + $MachineLines
    [System.IO.File]::WriteAllText((Join-Path $homeDir '.harness\machine.env'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    return $homeDir
}

# One run of the bootstrap in a child shell. Returns its exit code, its output and the fakes' calls.
function Invoke-Bootstrap {
    param([string] $HomeDir, [string] $Name, [string[]] $ScriptArgs = @(), [hashtable] $Environment = @{})
    $calls = Join-Path $script:ScratchRoot "$Name.calls"
    [System.IO.File]::WriteAllText($calls, '')
    foreach ($name in $script:FakeVariables + $script:ClearedVariables) { [Environment]::SetEnvironmentVariable($name, $null) }
    foreach ($key in $Environment.Keys) { [Environment]::SetEnvironmentVariable($key, $Environment[$key]) }
    [Environment]::SetEnvironmentVariable('FAKE_CALLS', $calls)
    [Environment]::SetEnvironmentVariable('USERPROFILE', $HomeDir)
    [Environment]::SetEnvironmentVariable('PATH', "$($script:FakeBin);$($script:SavedEnvironment['PATH'])")

    $ErrorActionPreference = 'Continue'
    $output = @(& $script:ChildShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:Bootstrap @ScriptArgs 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    [Environment]::SetEnvironmentVariable('USERPROFILE', $script:SavedEnvironment['USERPROFILE'])
    [Environment]::SetEnvironmentVariable('PATH', $script:SavedEnvironment['PATH'])
    $callLines = @(Get-Content -LiteralPath $calls | Where-Object { $_ })
    return [pscustomobject]@{ Code = $code; Out = $output; Text = ($output -join "`n"); Calls = $callLines; CallText = ($callLines -join "`n") }
}

function Test-Check {
    param([string] $Name, [bool] $Ok, [string] $Detail = '')
    if ($Ok) { Write-Output "PASS $Name"; return }
    $script:Failures++
    Write-Output "FAIL $Name$(if ($Detail) { " -- $Detail" })"
}

# The index of the first line holding $Text, or -1.
function Get-LineIndex {
    param([string[]] $Lines, [string] $Text)
    for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i].Contains($Text)) { return $i } }
    return -1
}

# Each text's first line comes after the one before.
function Test-InOrder {
    param([string[]] $Lines, [string[]] $Texts)
    $previous = -1
    foreach ($text in $Texts) {
        $at = Get-LineIndex $Lines $text
        if ($at -le $previous) { return $false }
        $previous = $at
    }
    return $true
}

function Test-Reminders {
    param($Run)
    return $Run.Text.Contains('MANUAL') -and $Run.Text.Contains('PAT') -and $Run.Text.Contains('Front Matter Title')
}

# The one-line list literal of each script, as space-separated words.
function Get-StepLists {
    $psMatch = [regex]::Match((Get-Content -LiteralPath $script:Bootstrap -Raw), '(?m)^\$StepNames = @\(([^)]*)\)')
    $shMatch = [regex]::Match((Get-Content -LiteralPath $script:ShBootstrap -Raw), '(?m)^STEP_NAMES=\(([^)]*)\)')
    if (-not $psMatch.Success) { throw "no `$StepNames line in $script:Bootstrap" }
    if (-not $shMatch.Success) { throw "no STEP_NAMES line in $script:ShBootstrap" }
    $ps = @($psMatch.Groups[1].Value -split ',' | ForEach-Object { $_.Trim().Trim("'") } | Where-Object { $_ }) -join ' '
    $sh = @($shMatch.Groups[1].Value -split '\s+' | Where-Object { $_ }) -join ' '
    return [pscustomobject]@{ Ps = $ps; Sh = $sh }
}

try {
    if (-not (Test-Path -LiteralPath $script:Bootstrap)) { throw "bootstrap.ps1 not found at $script:Bootstrap" }
    [void] [System.IO.Directory]::CreateDirectory($script:ScratchRoot)
    New-Fakes

    # (1) static: the parse and the step list, here and in bootstrap.sh.
    $parseErrors = $null
    [void] [System.Management.Automation.Language.Parser]::ParseFile($script:Bootstrap, [ref] $null, [ref] $parseErrors)
    Test-Check 'the script parses with no errors' (@($parseErrors).Count -eq 0) (($parseErrors | ForEach-Object { $_.Message }) -join '; ')
    $lists = Get-StepLists
    Test-Check "bootstrap.ps1's step list is the runbook order" ($lists.Ps -ceq $script:ExpectedSteps) $lists.Ps
    Test-Check 'bootstrap.ps1 and bootstrap.sh hold the same step list' ($lists.Ps -ceq $lists.Sh) "ps1 '$($lists.Ps)' vs sh '$($lists.Sh)'"

    # (2) -DryRun on a fresh machine: every step and command printed, nothing run or made.
    $homeDir = New-FakeHome 'dry' @('HARNESS_REALMS=work-vm:push', "HARNESS_REALM_REMOTE_BASE=$($script:RealmBase)")
    $r = Invoke-Bootstrap $homeDir 'dry' @('-DryRun')
    # Safety: every tool must have resolved to a fake before any real run below.
    $allFake = $true
    foreach ($tool in $script:Tools) { if (-not $r.Text.Contains("  ${tool}: $(Join-Path $script:FakeBin "$tool.cmd")")) { $allFake = $false } }
    if (-not $allFake) { throw "a tool did not resolve to its fake; no real run attempted. Output:`n$($r.Text)" }
    $headers = @(); $n = 0
    foreach ($step in $script:ExpectedSteps.Split(' ')) { $headers += "== step $n $step"; $n++ }
    Test-Check "a dry run exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Text
    Test-Check 'a dry run calls no tool at all' ($r.Calls.Count -eq 0) $r.CallText
    Test-Check 'a dry run prints every step header in order' (Test-InOrder $r.Out $headers) $r.Text
    Test-Check 'a dry run shows the harness clone' ($r.Text.Contains("would run: git clone -- $($script:HarnessUrl)"))
    Test-Check 'a dry run shows uv sync in ingest/' ($r.Text.Contains('ingest) uv sync'))
    Test-Check 'a dry run shows npm ci then the build in mcp-server/' (Test-InOrder $r.Out @('mcp-server) npm ci', 'mcp-server) npm run build'))
    Test-Check 'a dry run shows compose up in db/ and the readiness probe' (Test-InOrder $r.Out @('db) docker compose up -d --wait', 'docker exec harness-postgres pg_isready -U harness -d harness'))
    $plainMigrate = -1
    for ($i = 0; $i -lt $r.Out.Count; $i++) { if ($r.Out[$i].EndsWith('uv run ingest db migrate')) { $plainMigrate = $i; break } }
    Test-Check 'a dry run shows embed-check, migrate --dry-run, then migrate' ((Test-InOrder $r.Out @('uv run ingest embed-check', 'uv run ingest db migrate --dry-run')) -and $plainMigrate -gt (Get-LineIndex $r.Out 'uv run ingest db migrate --dry-run'))
    Test-Check 'a dry run shows the realm clone from the base remote' ($r.Text.Contains("git clone -- $($script:RealmBase)/vault-work-vm.git"))
    Test-Check 'a dry run shows the config clone and install --config' (Test-InOrder $r.Out @("git clone -- $($script:ConfigUrl)", 'node hooks/install.mjs --config --apply --config-repo'))
    Test-Check 'a dry run shows install --register-mcp, then doctor --strict' (Test-InOrder $r.Out @('node hooks/install.mjs --register-mcp', 'node hooks/doctor.mjs --strict'))
    Test-Check 'a dry run creates no repo, vault or config folder' (-not (Test-Path (Join-Path $homeDir 'agentic-harness')) -and -not (Test-Path (Join-Path $homeDir 'vault')) -and -not (Test-Path (Join-Path $homeDir 'claude-config')))
    Test-Check 'a dry run says nothing was run' ($r.Text.Contains('bootstrap: dry run, nothing was run'))
    Test-Check 'a dry run prints the MANUAL reminders' (Test-Reminders $r)
    $r = Invoke-Bootstrap $homeDir 'dry-dashes' @('--dry-run')
    Test-Check "--dry-run is accepted too and runs nothing (exit $($r.Code))" ($r.Code -eq 0 -and $r.Calls.Count -eq 0 -and $r.Text.Contains('nothing was run')) $r.Text

    # (3) a real run on a fresh machine: every step, in order, in the right folder.
    $homeDir = New-FakeHome 'fresh' @('HARNESS_REALMS=work-vm:push', "HARNESS_REALM_REMOTE_BASE=$($script:RealmBase)")
    $r = Invoke-Bootstrap $homeDir 'fresh'
    Test-Check "a fresh run exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Text
    $order = @(
        "clone -- $($script:HarnessUrl)", 'uv [ingest] sync', 'npm [mcp-server] ci', 'npm [mcp-server] run build',
        'docker [db] compose up -d --wait', 'docker [db] exec harness-postgres pg_isready',
        'uv [ingest] run ingest embed-check', 'uv [ingest] run ingest db migrate --dry-run',
        "clone -- $($script:RealmBase)/vault-work-vm.git", "clone -- $($script:ConfigUrl)",
        'node [agentic-harness] hooks/install.mjs --config --apply --config-repo',
        'node [agentic-harness] hooks/install.mjs --register-mcp', 'node [agentic-harness] hooks/doctor.mjs --strict')
    Test-Check 'the calls run in the runbook order' (Test-InOrder $r.Calls $order) $r.CallText
    Test-Check 'the migrate runs for real after its dry run' ($r.Calls -ccontains 'uv [ingest] run ingest db migrate') $r.CallText
    Test-Check 'the realm is cloned into the vault' (Test-Path (Join-Path $homeDir 'vault\work-vm\.git'))
    Test-Check 'the config repo is cloned to ~/claude-config' (Test-Path (Join-Path $homeDir 'claude-config\.git'))
    Test-Check '--config-repo is the config clone''s path' ($r.CallText.Contains('fake home/claude-config'))
    Test-Check "doctor's report is printed" ($r.Text.Contains('machine file  fake'))
    Test-Check 'a fresh run ends with the MANUAL reminders' (Test-Reminders $r)
    Test-Check 'a fresh run says all steps are done' ($r.Text.Contains('bootstrap: all steps done'))

    # (4) a second run on the finished machine skips every clone and still ends at doctor.
    $r = Invoke-Bootstrap $homeDir 'again'
    Test-Check "a second run exits 0 (exit $($r.Code))" ($r.Code -eq 0) $r.Text
    Test-Check 'a second run clones nothing' (-not $r.CallText.Contains(' clone ')) $r.CallText
    Test-Check 'a second run notes the harness clone is there' ($r.Text.Contains('is already a clone of emstacho-su/agentic-harness'))
    Test-Check 'a second run notes the realm is there' ($r.Text.Contains('work-vm is already cloned'))
    Test-Check 'a second run still ends at doctor' ($r.CallText.Contains('hooks/doctor.mjs'))

    # (5) the harness folder is a clone of something else: step 1 stops the run.
    $homeDir = New-FakeHome 'wrong-remote' @('HARNESS_REALMS=')
    [void] [System.IO.Directory]::CreateDirectory((Join-Path $homeDir 'agentic-harness\.git'))
    [System.IO.File]::WriteAllText((Join-Path $homeDir 'agentic-harness\.git\fake-origin'), "https://github.com/someone/other.git`r`n")
    $r = Invoke-Bootstrap $homeDir 'wrong-remote'
    Test-Check "a clone of the wrong remote fails the run (exit $($r.Code))" ($r.Code -ne 0) $r.Text
    Test-Check 'the failure names step 1 clone' ($r.Text.Contains('bootstrap: step 1 clone failed (exit 1)')) $r.Text
    Test-Check 'nothing after step 1 runs' (-not $r.CallText.Contains('uv ')) $r.CallText
    Test-Check 'a failed run prints no "all steps done"' (-not $r.Text.Contains('all steps done'))

    # (6) stop at the first failure: npm fails, so nothing from step 4 on runs.
    $homeDir = New-FakeHome 'npm-fails' @('HARNESS_REALMS=')
    $r = Invoke-Bootstrap $homeDir 'npm-fails' -Environment @{ FAKE_EXIT_NPM = '7' }
    Test-Check "a failing build fails the run (exit $($r.Code))" ($r.Code -ne 0) $r.Text
    Test-Check "the failure names step 3 mcp-build and npm's code" ($r.Text.Contains('bootstrap: step 3 mcp-build failed (exit 7)')) $r.Text
    Test-Check 'npm run build is not attempted after npm ci failed' (-not $r.CallText.Contains('npm [mcp-server] run build'))
    Test-Check 'docker never runs after the failed step' (-not $r.CallText.Contains('docker '))
    Test-Check 'node never runs after the failed step' (-not $r.CallText.Contains('node '))

    # (7) embed-check failing stops before any migrate.
    $homeDir = New-FakeHome 'embed-fails' @('HARNESS_REALMS=')
    $r = Invoke-Bootstrap $homeDir 'embed-fails' -Environment @{ FAKE_EXIT_EMBED = '1' }
    Test-Check "a failing embed-check names step 5 (exit $($r.Code))" ($r.Text.Contains('bootstrap: step 5 embed-migrate failed (exit 1)')) $r.Text
    Test-Check 'no migrate runs after a failed embed-check' (-not $r.CallText.Contains('db migrate'))

    # (8) the store never answers: step 4 stops the run.
    $homeDir = New-FakeHome 'store-fails' @('HARNESS_REALMS=')
    $r = Invoke-Bootstrap $homeDir 'store-fails' -Environment @{ FAKE_EXIT_DOCKER = '1' }
    Test-Check "a store that never comes up names step 4 (exit $($r.Code))" ($r.Text.Contains('bootstrap: step 4 store failed (exit 1)')) $r.Text
    Test-Check 'embed-check never runs without a store' (-not $r.CallText.Contains('embed-check'))

    # (9) doctor decides, by its --strict exit code: 1 fails step 9, 0 passes whatever the report says.
    $homeDir = New-FakeHome 'doctor-problem' @('HARNESS_REALMS=')
    $r = Invoke-Bootstrap $homeDir 'doctor-problem' -Environment @{ FAKE_EXIT_DOCTOR = '1'; FAKE_DOCTOR_OUTPUT = 'problem: mcp-server build' }
    Test-Check "doctor --strict exiting 1 fails step 9 (exit $($r.Code))" ($r.Text.Contains('bootstrap: step 9 doctor failed (exit 1)')) $r.Text
    Test-Check 'the problem row doctor names is shown' ($r.Text.Contains('problem: mcp-server build'))
    Test-Check 'doctor is run with --strict' ($r.CallText.Contains('node [agentic-harness] hooks/doctor.mjs --strict')) $r.CallText
    Test-Check 'a failed doctor prints no "all steps done"' (-not $r.Text.Contains('all steps done'))
    $r = Invoke-Bootstrap $homeDir 'doctor-clean' -Environment @{ FAKE_EXIT_DOCTOR = '0'; FAKE_DOCTOR_OUTPUT = 'mcp-server build  /x/dist/index.js (not built: npm run build)' }
    Test-Check "doctor --strict exiting 0 passes, whatever its text says (exit $($r.Code))" ($r.Code -eq 0) $r.Text
    Test-Check 'the report is printed as doctor wrote it' ($r.Text.Contains('(not built: npm run build)'))
    $r = Invoke-Bootstrap $homeDir 'doctor-usage' -Environment @{ FAKE_EXIT_DOCTOR = '2' }
    Test-Check 'any other doctor exit fails step 9 with that code' ($r.Text.Contains('bootstrap: step 9 doctor failed (exit 2)')) $r.Text

    # (10) preflight: no machine file stops everything before a single call.
    $homeDir = New-FakeHome 'no-machine-file'
    Remove-Item -LiteralPath (Join-Path $homeDir '.harness\machine.env')
    $r = Invoke-Bootstrap $homeDir 'no-machine-file'
    Test-Check "a missing machine file fails step 0 preflight (exit $($r.Code))" ($r.Text.Contains('bootstrap: step 0 preflight failed (exit 1)')) $r.Text
    Test-Check 'the missing file is named' ($r.Text.Contains('.harness/machine.env'))
    Test-Check 'no tool runs when preflight fails' ($r.Calls.Count -eq 0) $r.CallText
    $r = Invoke-Bootstrap $homeDir 'no-machine-file-dry' @('-DryRun')
    Test-Check 'a dry run stops at the same preflight failure' ($r.Text.Contains('bootstrap: step 0 preflight failed (exit 1)')) $r.Text

    # (11) the realm remotes: a per-realm key wins over the base; no remote is a named failure.
    $homeDir = New-FakeHome 'realm-override' @('HARNESS_REALMS=work-vm:local', "HARNESS_REALM_REMOTE_BASE=$($script:RealmBase)", 'HARNESS_REALM_REMOTE_WORK_VM=https://example.test/notes/vm.git')
    $r = Invoke-Bootstrap $homeDir 'realm-override' @('-DryRun')
    Test-Check 'HARNESS_REALM_REMOTE_<NAME> wins over the base' ($r.Text.Contains('git clone -- https://example.test/notes/vm.git')) $r.Text
    $homeDir = New-FakeHome 'realm-no-remote' @('HARNESS_REALMS=work-vm:push')
    $r = Invoke-Bootstrap $homeDir 'realm-no-remote'
    Test-Check "a realm with no remote fails step 6 (exit $($r.Code))" ($r.Text.Contains('bootstrap: step 6 realms failed (exit 1)')) $r.Text
    Test-Check 'the failure names the settings to add' ($r.Text.Contains('HARNESS_REALM_REMOTE_BASE'))
    Test-Check 'no realm clone ran' (-not $r.CallText.Contains('vault-work-vm'))
    Test-Check 'config never runs after the failed realm step' (-not $r.CallText.Contains('claude-config'))
    $homeDir = New-FakeHome 'realm-bad-name' @('HARNESS_REALMS=../evil:push', "HARNESS_REALM_REMOTE_BASE=$($script:RealmBase)")
    $r = Invoke-Bootstrap $homeDir 'realm-bad-name'
    Test-Check 'a realm name outside the pattern fails step 6' ($r.Text.Contains('bootstrap: step 6 realms failed (exit 1)')) $r.Text
    Test-Check 'no clone runs for a bad realm name' (-not $r.CallText.Contains('evil'))
    $homeDir = New-FakeHome 'realm-present' @('HARNESS_REALMS=work-vm:push')
    [void] [System.IO.Directory]::CreateDirectory((Join-Path $homeDir 'vault\work-vm\.git'))
    $r = Invoke-Bootstrap $homeDir 'realm-present'
    Test-Check "a realm already on disk needs no remote and is skipped (exit $($r.Code))" ($r.Code -eq 0) $r.Text
    Test-Check 'the present realm is noted' ($r.Text.Contains('work-vm is already cloned'))

    # (12) a remote carrying a credential is never printed with it.
    $homeDir = New-FakeHome 'redact' @('HARNESS_REALMS=work-vm:push', 'HARNESS_REALM_REMOTE_BASE=https://user:tok3n-secret@github.com/work-acct')
    $r = Invoke-Bootstrap $homeDir 'redact' @('-DryRun')
    Test-Check 'a credential in a remote URL is not printed' (-not $r.Text.Contains('tok3n-secret'))
    Test-Check 'the redacted URL is still shown' ($r.Text.Contains('https://***@github.com/work-acct/vault-work-vm.git')) $r.Text

    # (13) an unknown argument is refused before anything runs.
    $homeDir = New-FakeHome 'bad-arg' @('HARNESS_REALMS=')
    $r = Invoke-Bootstrap $homeDir 'bad-arg' @('--apply')
    Test-Check "an unknown argument exits 2 (exit $($r.Code))" ($r.Code -eq 2) $r.Text
    Test-Check 'an unknown argument runs nothing' ($r.Calls.Count -eq 0)
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
