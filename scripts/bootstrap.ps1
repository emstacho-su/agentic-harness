<#
.SYNOPSIS
    One command brings up a machine (R-H6): clone, build, store, migrate,
    realms, config, install, doctor.

.DESCRIPTION
    Runs the dev-VM runbook of docs/portable.md in order, stopping at the first
    failure. bootstrap.sh does the same steps for Linux, macOS and Git Bash;
    the tests check the two hold the same step list.

      0. preflight      the machine file exists; git, uv, node, npm and docker are found
      1. clone          agentic-harness to ~/agentic-harness (skipped when it is a clone of it)
      2. uv-sync        uv sync in ingest/
      3. mcp-build      npm ci, then npm run build, in mcp-server/
      4. store          docker compose up -d --wait in db/, then pg_isready in the container
      5. embed-migrate  uv run ingest embed-check, db migrate --dry-run, db migrate
      6. realms         clone each realm HARNESS_REALMS names into HARNESS_VAULT (skipped when there)
      7. config         clone claude-config to ~/claude-config, then install.mjs --config --apply
      8. install        node hooks/install.mjs --register-mcp
      9. doctor         node hooks/doctor.mjs; a problem in its report fails the run

    Reads ~/.harness/machine.env (or HARNESS_MACHINE_ENV) through
    lib/machine-env.ps1, the environment winning: HARNESS_VAULT (default
    ~/vault), HARNESS_REALMS (<realm>:<push|local>,...),
    HARNESS_REALM_REMOTE_BASE (a realm is cloned from <base>/vault-<realm>.git),
    HARNESS_REALM_REMOTE_<REALM> (one realm's URL, the name upper-cased with -
    as _; wins over the base), HARNESS_STORE_CONTAINER and HARNESS_STORE_DB
    (default harness-postgres and harness, as backup-store.ps1).

    A dry run runs no tool. It does look: whether each clone target exists and,
    for one that does, `git -C <dir> remote get-url origin` (read-only). A
    failure it can already see (no machine file, a clone of the wrong remote, a
    realm with no remote) stops it the same way it would stop a real run.

    A second run on a finished machine skips every clone and ends at doctor.
    What stays MANUAL is printed at the end: the push credential, the Obsidian
    Front Matter Title plugin, a realm that exists on no remote, the nightly
    job and the store backup.

.PARAMETER DryRun
    Print every step and its exact command; run nothing. `--dry-run` works too.

.OUTPUTS
    Exit 0 every step passed (or the dry run finished).
    Exit 1 a step failed, named on the `bootstrap: step <n> <name> failed (exit <code>)` line.
    Exit 2 a bad argument.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [switch] $DryRun,
    # `--dry-run` arrives here, as does anything unknown (refused below).
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Rest = @()
)

$ErrorActionPreference = 'Stop'

# The steps, in order; the index is the step number. The tests compare this line with bootstrap.sh's.
$StepNames = @('preflight', 'clone', 'uv-sync', 'mcp-build', 'store', 'embed-migrate', 'realms', 'config', 'install', 'doctor')
# The tools the steps call, checked before any of them runs.
$RequiredTools = @('git', 'uv', 'node', 'npm', 'docker')
$HarnessRemote = 'https://github.com/emstacho-su/agentic-harness.git'
$ConfigRemote = 'https://github.com/emstacho-su/claude-config.git'
# The realm name rule of hooks/lib/realm-sync.mjs (REALM_NAME) and its two policies.
$RealmNamePattern = '\A[a-z0-9][a-z0-9-]{0,31}\z'
$RealmPolicies = @('push', 'local')
# How long compose waits for the container's healthcheck (db/docker-compose.yml).
$StoreWaitSeconds = 120
# doctor.mjs exits 0 whatever it finds, so its rows are read for these. The tests compare this line with bootstrap.sh's.
$DoctorProblemMarkers = @('(MISSING', 'ABSENT', '(absent', '(not built', '(not found', 'ingest will refuse')

foreach ($arg in $Rest) {
    if ($arg -ceq '--dry-run') { $DryRun = [switch] $true; continue }
    [Console]::Error.WriteLine("bootstrap: unknown argument '$arg'")
    [Console]::Error.WriteLine('usage: bootstrap.ps1 [-DryRun | --dry-run]')
    exit 2
}

# node prints UTF-8; without this PowerShell 5.1 shows its output in the OEM code page.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Host "note: console encoding not set ($($_.Exception.Message))" }

# Forward slashes throughout: what the runbook prints, and what node and uv take.
function ConvertTo-NativePath {
    param([string] $Path)
    return ($Path -replace '\\', '/')
}

$HomeDir = ConvertTo-NativePath $env:USERPROFILE
$RepoDir = "$HomeDir/agentic-harness"
$ConfigDir = "$HomeDir/claude-config"
$MachineFile = if ($env:HARNESS_MACHINE_ENV) { $env:HARNESS_MACHINE_ENV } else { "$HomeDir/.harness/machine.env" }
$MachineEnvLib = Join-Path $PSScriptRoot 'lib\machine-env.ps1'
$script:Machine = @{}
$script:ToolPaths = @{}

# https://user:token@host -> https://***@host, so a credential never reaches the output.
function Hide-UrlCredential {
    param([string] $Text)
    return ($Text -replace '://[^/@\s]+@', '://***@')
}

function Format-Command {
    param([string] $Dir, [string] $Tool, [string[]] $Arguments)
    $words = @($Tool) + @($Arguments | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } })
    $shown = Hide-UrlCredential ($words -join ' ')
    if ($Dir) { return "(in $Dir) $shown" }
    return $shown
}

# Print the command, and in a real run run it in $Dir. Returns its exit code.
# The tool's output goes to the host, never into the return value.
function Invoke-Step {
    param([string] $Dir, [string] $Tool, [string[]] $Arguments = @())
    $shown = Format-Command $Dir $Tool $Arguments
    if ($DryRun) { Write-Host "  would run: $shown"; return 0 }
    Write-Host "  run: $shown"
    $exe = if ($script:ToolPaths.ContainsKey($Tool)) { $script:ToolPaths[$Tool] } else { $Tool }
    # Continue, not Stop: PowerShell 5.1 turns a native tool's stderr (git's progress,
    # npm's warnings) into error records when its own stderr is redirected.
    $ErrorActionPreference = 'Continue'
    if ($Dir) { Push-Location -LiteralPath $Dir }
    try {
        & $exe @Arguments | Out-Host| Out-Host
        return [int] $LASTEXITCODE
    } finally {
        if ($Dir) { Pop-Location }
    }
}

# A read-only probe: the origin URL of the checkout at $Dir, or '' when there is none.
function Get-OriginUrl {
    param([string] $Dir)
    $ErrorActionPreference = 'Continue'
    $url = & $script:ToolPaths['git'] -C $Dir remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $url) { return '' }
    return "$(@($url)[0])".Trim()
}

# owner/name for a GitHub remote (https or ssh), else the URL; lower case, no .git.
function Get-RemoteSlug {
    param([string] $Url)
    $slug = $Url.ToLowerInvariant().TrimEnd('/') -replace '\.git$', ''
    $match = [regex]::Match($slug, 'github\.com[:/]+(.+)$')
    if ($match.Success) { return $match.Groups[1].Value }
    return $slug
}

# Skip a clone of $Url, refuse anything else in the way, else clone.
function Invoke-EnsureClone {
    param([string] $Url, [string] $Dir)
    $slug = Get-RemoteSlug $Url
    if (Test-Path -LiteralPath (Join-Path $Dir '.git')) {
        $origin = Get-OriginUrl $Dir
        if ($origin -and (Get-RemoteSlug $origin) -eq $slug) {
            Write-Host "  skip: $Dir is already a clone of $slug"
            return 0
        }
        $shownOrigin = if ($origin) { Hide-UrlCredential $origin } else { 'no origin' }
        Write-Host "  $Dir is a clone of '$shownOrigin', not $slug; move it aside and run again"
        return 1
    }
    if ((Test-Path -LiteralPath $Dir) -and @(Get-ChildItem -LiteralPath $Dir -Force).Count -gt 0) {
        Write-Host "  $Dir exists and is not a git clone; move it aside and run again"
        return 1
    }
    return Invoke-Step '' 'git' @('clone', '--', $Url, $Dir)
}

# The full path of a tool on PATH (uv also in ~/.local/bin), or ''.
function Find-Tool {
    param([string] $Name)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $localUv = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if ($Name -eq 'uv' -and (Test-Path -LiteralPath $localUv)) { return $localUv }
    return ''
}

function Invoke-Preflight {
    $problems = 0
    if (Test-Path -LiteralPath $MachineFile -PathType Leaf) {
        Write-Host "  machine file: $MachineFile"
    } else {
        Write-Host "  no machine file at ${MachineFile}: write it first (docs/portable.md, dev-VM runbook)"
        $problems++
    }
    if (Test-Path -LiteralPath $MachineEnvLib) {
        . $MachineEnvLib
        # The lib reads HARNESS_MACHINE_ENV or USERPROFILE; both name $MachineFile here.
        $script:Machine = Read-MachineEnv
    } else {
        Write-Host "  $MachineEnvLib is missing: run the script from a clone of agentic-harness"
        $problems++
    }
    foreach ($tool in $RequiredTools) {
        $found = Find-Tool $tool
        if ($found) {
            $script:ToolPaths[$tool] = $found
            Write-Host "  ${tool}: $found"
        } else {
            Write-Host "  ${tool}: not found on PATH (runbook step 1)"
            $problems++
        }
    }
    if ($problems -gt 0) { return 1 }
    return 0
}

# The environment first, then the machine file, then $Default (Get-MachineSetting's rule).
function Get-Setting {
    param([string] $Key, [string] $Default = '')
    $fromEnv = [Environment]::GetEnvironmentVariable($Key)
    if ($fromEnv) { return $fromEnv }
    if ($script:Machine.ContainsKey($Key) -and $script:Machine[$Key]) { return $script:Machine[$Key] }
    return $Default
}

function Invoke-Clone { return Invoke-EnsureClone $HarnessRemote $RepoDir }

function Invoke-UvSync { return Invoke-Step "$RepoDir/ingest" 'uv' @('sync') }

function Invoke-McpBuild {
    $code = Invoke-Step "$RepoDir/mcp-server" 'npm' @('ci')
    if ($code -ne 0) { return $code }
    return Invoke-Step "$RepoDir/mcp-server" 'npm' @('run', 'build')
}

function Invoke-Store {
    $container = Get-Setting 'HARNESS_STORE_CONTAINER' 'harness-postgres'
    $database = Get-Setting 'HARNESS_STORE_DB' 'harness'
    $code = Invoke-Step "$RepoDir/db" 'docker' @('compose', 'up', '-d', '--wait', '--wait-timeout', "$StoreWaitSeconds")
    if ($code -ne 0) { return $code }
    return Invoke-Step "$RepoDir/db" 'docker' @('exec', $container, 'pg_isready', '-U', 'harness', '-d', $database)
}

function Invoke-EmbedMigrate {
    foreach ($arguments in @(@('run', 'ingest', 'embed-check'), @('run', 'ingest', 'db', 'migrate', '--dry-run'), @('run', 'ingest', 'db', 'migrate'))) {
        $code = Invoke-Step "$RepoDir/ingest" 'uv' $arguments
        if ($code -ne 0) { return $code }
    }
    return 0
}

function Get-RealmKey {
    param([string] $Name)
    return 'HARNESS_REALM_REMOTE_' + ($Name.ToUpperInvariant() -replace '-', '_')
}

# HARNESS_REALM_REMOTE_<REALM>, else <base>/vault-<realm>.git, else ''.
function Get-RealmUrl {
    param([string] $Name)
    $own = Get-Setting (Get-RealmKey $Name)
    if ($own) { return $own }
    $base = Get-Setting 'HARNESS_REALM_REMOTE_BASE'
    if ($base) { return "$($base.TrimEnd('/'))/vault-$Name.git" }
    return ''
}

function Invoke-Realms {
    $vault = ConvertTo-NativePath (Get-Setting 'HARNESS_VAULT' "$HomeDir/vault")
    $listed = Get-Setting 'HARNESS_REALMS'
    if (-not $listed) { Write-Host '  skip: HARNESS_REALMS is not set, so there is no realm to clone'; return 0 }
    # Every entry is checked, and every missing realm's URL found, before anything is cloned.
    $names = @()
    $problems = 0
    foreach ($raw in $listed.Split(',')) {
        $entry = $raw.Trim()
        if (-not $entry) { continue }
        $parts = $entry.Split(':')
        if ($parts.Count -ne 2 -or $parts[0] -cnotmatch $RealmNamePattern -or $RealmPolicies -cnotcontains $parts[1]) {
            Write-Host "  HARNESS_REALMS: '$entry' is not <realm>:<push|local>"
            $problems++
            continue
        }
        $name = $parts[0]
        $names += $name
        if (-not (Test-Path -LiteralPath "$vault/$name") -and -not (Get-RealmUrl $name)) {
            Write-Host "  realm $name has no remote: set HARNESS_REALM_REMOTE_BASE or $(Get-RealmKey $name) in the machine file, or make it with init-realm (runbook step 4)"
            $problems++
        }
    }
    if ($problems -gt 0) { return 1 }
    if (-not (Test-Path -LiteralPath $vault)) {
        if ($DryRun) { Write-Host "  would run: mkdir $vault" } else {
            Write-Host "  run: mkdir $vault"
            [void] [System.IO.Directory]::CreateDirectory($vault)
        }
    }
    foreach ($name in $names) {
        $dir = "$vault/$name"
        if (Test-Path -LiteralPath "$dir/.git") { Write-Host "  skip: realm $name is already cloned at $dir"; continue }
        if (Test-Path -LiteralPath $dir) { Write-Host "  skip: $dir exists and is not a git checkout; left as it is (doctor reports it)"; continue }
        $code = Invoke-Step '' 'git' @('clone', '--', (Get-RealmUrl $name), $dir)
        if ($code -ne 0) { return $code }
    }
    return 0
}

function Invoke-Config {
    $code = Invoke-EnsureClone $ConfigRemote $ConfigDir
    if ($code -ne 0) { return $code }
    return Invoke-Step $RepoDir 'node' @('hooks/install.mjs', '--config', '--apply', '--config-repo', $ConfigDir)
}

function Invoke-Install { return Invoke-Step $RepoDir 'node' @('hooks/install.mjs', '--register-mcp') }

# The rows of doctor's report that name a problem.
function Get-DoctorProblems {
    param([string[]] $Report)
    $rows = @($Report | Where-Object { $_ -match '^realms missing\s' -and $_ -notmatch '\snone\s*$' })
    foreach ($marker in $DoctorProblemMarkers) { $rows += @($Report | Where-Object { $_.Contains($marker) }) }
    return @($rows | Select-Object -Unique)
}

function Invoke-Doctor {
    if ($DryRun) { return Invoke-Step $RepoDir 'node' @('hooks/doctor.mjs') }
    Write-Host "  run: $(Format-Command $RepoDir 'node' @('hooks/doctor.mjs'))"
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $RepoDir
    try {
        $report = @(& $script:ToolPaths['node'] 'hooks/doctor.mjs' | ForEach-Object { "$_" })
        $code = [int] $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $report | Out-Host
    if ($code -ne 0) { return $code }
    $problems = @(Get-DoctorProblems $report)
    if ($problems.Count -eq 0) { return 0 }
    foreach ($row in $problems) { Write-Host "  doctor reports: $row" }
    return 1
}

function Write-Reminders {
    Write-Host 'MANUAL: the push credential (runbook step 8): a fine-grained PAT of the account that owns this machine''s realm, stored once with git credential approve; the nightly sync never prompts.'
    Write-Host 'MANUAL: Obsidian Front Matter Title (runbook step 4): open ~/vault as a vault, install and enable the plugin, turn on its Graph and Explorer features.'
    Write-Host 'MANUAL: a realm that exists on no remote yet is made with hooks/init-realm.mjs, not cloned (runbook step 4).'
    Write-Host 'MANUAL: register the nightly job and the daily store backup (runbook step 7); first night with -RealmSync DryRun.'
    Write-Host 'MANUAL: read the minimum cosine of npm run verify:embedder in mcp-server/ (runbook step 6).'
}

$StepActions = @{
    'preflight' = { Invoke-Preflight }
    'clone' = { Invoke-Clone }
    'uv-sync' = { Invoke-UvSync }
    'mcp-build' = { Invoke-McpBuild }
    'store' = { Invoke-Store }
    'embed-migrate' = { Invoke-EmbedMigrate }
    'realms' = { Invoke-Realms }
    'config' = { Invoke-Config }
    'install' = { Invoke-Install }
    'doctor' = { Invoke-Doctor }
}

for ($n = 0; $n -lt $StepNames.Count; $n++) {
    $name = $StepNames[$n]
    Write-Host "== step $n $name"
    try {
        $code = [int] (@(. $StepActions[$name])[-1])
    } catch {
        Write-Host "  $($_.Exception.Message)"
        $code = 1
    }
    if ($code -ne 0) {
        Write-Host "bootstrap: step $n $name failed (exit $code)"
        Write-Host 'bootstrap: fix it and run again; a finished step is safe to repeat'
        exit 1
    }
}

if ($DryRun) { Write-Host 'bootstrap: dry run, nothing was run' } else { Write-Host 'bootstrap: all steps done' }
Write-Reminders
exit 0
