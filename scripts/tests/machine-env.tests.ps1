<#
.SYNOPSIS
    Self-test for scripts/lib/machine-env.ps1. No Pester needed.

.DESCRIPTION
    Writes a scratch machine.env holding every awkward line the reader must
    survive (the same cases as scripts/tests/machine-env.tests.sh), then
    dot-sources the lib in a child `powershell -NoProfile -Command`, so its
    stderr and environment are real and nothing leaks into this shell. Prints
    PASS or FAIL per case. The scratch folder and every environment change are
    undone in `finally`. Exits 1 if any case failed.

.EXAMPLE
    powershell -NoProfile -File scripts/tests/machine-env.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The lib under test, one folder up from this one.
$script:Lib = Join-Path (Split-Path -Parent $PSScriptRoot) 'lib\machine-env.ps1'
# Windows PowerShell 5.1 is the target the scheduled tasks run under.
$script:ChildShell = Join-Path $PSHOME 'powershell.exe'
# A value that must never reach any output: it belongs to a key the reader skips.
$script:Secret = 's3cret-value-never-printed'
# Marks the child's result lines, so they are told apart from its stderr.
$script:ValueTag = 'KV|'
$script:SettingTag = 'SET|'

$script:Failures = 0
$script:ScratchRoot = Join-Path $env:TEMP ("machine-env-" + [guid]::NewGuid())

$script:TouchedVariables = @('HARNESS_MACHINE_ENV', 'HARNESS_ALREADY')
$script:SavedEnvironment = @{}
foreach ($name in $script:TouchedVariables) { $script:SavedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

# Dot-source the lib in a child shell, then print every value it read and what
# Get-MachineSetting answers for a key the environment already holds.
function Invoke-Reader {
    param([string] $MachineFile)
    $childScript = @"
. '$($script:Lib)'
`$machine = Read-MachineEnv
foreach (`$key in (`$machine.Keys | Sort-Object)) { Write-Output ('$($script:ValueTag)' + `$key + '|' + `$machine[`$key]) }
Write-Output ('$($script:SettingTag)HARNESS_ALREADY|' + (Get-MachineSetting `$machine 'HARNESS_ALREADY' 'default'))
Write-Output ('$($script:SettingTag)HARNESS_MISSING|' + (Get-MachineSetting `$machine 'HARNESS_MISSING' 'default'))
"@
    $ErrorActionPreference = 'Continue'
    [Environment]::SetEnvironmentVariable('HARNESS_MACHINE_ENV', $MachineFile)
    [Environment]::SetEnvironmentVariable('HARNESS_ALREADY', 'from-env')
    $lines = @(& $script:ChildShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $childScript 2>&1)
    $code = $LASTEXITCODE
    $values = @{}
    $settings = @{}
    $other = @()
    foreach ($line in $lines) {
        $text = "$line"
        if ($text.StartsWith($script:ValueTag)) {
            $parts = $text.Substring($script:ValueTag.Length).Split([char] '|', 2)
            $values[$parts[0]] = $parts[1]
        } elseif ($text.StartsWith($script:SettingTag)) {
            $parts = $text.Substring($script:SettingTag.Length).Split([char] '|', 2)
            $settings[$parts[0]] = $parts[1]
        } else {
            $other += $text
        }
    }
    return [pscustomobject]@{ Code = $code; Values = $values; Settings = $settings; Stderr = ($other -join "`n"); All = (($lines | ForEach-Object { "$_" }) -join "`n") }
}

function Test-Check {
    param([string] $Name, [bool] $Ok, [string] $Detail = '')
    if ($Ok) { Write-Output "PASS $Name"; return }
    $script:Failures++
    Write-Output "FAIL $Name$(if ($Detail) { " -- $Detail" })"
}

try {
    if (-not (Test-Path -LiteralPath $script:Lib)) { throw "machine-env.ps1 not found at $script:Lib" }
    [void] [System.IO.Directory]::CreateDirectory($script:ScratchRoot)
    $file = Join-Path $script:ScratchRoot 'machine.env'

    # Written as raw text so the CR and the missing final newline are exact.
    $content = (@(
        '# what this machine is'
        ''
        'HARNESS_STORE_DB=other'
        'HARNESS_QUOTED="a value with spaces"'
        "HARNESS_CRLF=crlf-value`r"
        'a[$(echo INJECTED >&2)]=1'
        'LD_PRELOAD=/x'
        'BASH_ENV=/tmp/evil'
        'export HARNESS_X=1'
        'REALM_SYNC=dryrun'
        'HARNESS_ALREADY=from-file'
        'HARNESS_LITERAL=$(Write-Output PWNED)'
        "DATABASE_URL=postgresql://harness:$($script:Secret)@localhost:5433/harness"
    ) -join "`n") + "`nHARNESS_LAST=no-newline"
    [System.IO.File]::WriteAllText($file, $content, (New-Object System.Text.UTF8Encoding($false)))

    $r = Invoke-Reader $file
    $noCr = @($r.Values.Values | Where-Object { $_.Contains("`r") }).Count -eq 0
    Test-Check "the lib dot-sources and reads (exit $($r.Code))" ($r.Code -eq 0) $r.All
    Test-Check 'a last line without a newline is read' ($r.Values['HARNESS_LAST'] -eq 'no-newline')
    Test-Check 'a CRLF line is read without its CR' ($r.Values['HARNESS_CRLF'] -eq 'crlf-value')
    Test-Check 'no value carries a CR' $noCr
    Test-Check 'the injection key is not read' (-not ($r.Values.Keys | Where-Object { $_.Contains('[') }))
    Test-Check 'the injection key is reported as ignored' ($r.Stderr.Contains("machine.env: ignoring key 'a[`$(echo INJECTED >&2)]'")) $r.Stderr
    Test-Check 'nothing ran the injection' (-not ($r.Stderr -split "`n" | Where-Object { $_.Trim() -ceq 'INJECTED' }))
    Test-Check 'LD_PRELOAD is not read' (-not $r.Values.ContainsKey('LD_PRELOAD'))
    Test-Check 'LD_PRELOAD is reported as ignored' ($r.Stderr.Contains("machine.env: ignoring key 'LD_PRELOAD'")) $r.Stderr
    Test-Check 'BASH_ENV is not read' (-not $r.Values.ContainsKey('BASH_ENV'))
    Test-Check 'HARNESS_STORE_DB is read' ($r.Values['HARNESS_STORE_DB'] -eq 'other')
    Test-Check 'a quoted value loses its quotes' ($r.Values['HARNESS_QUOTED'] -eq 'a value with spaces')
    Test-Check 'a key already in the environment wins in Get-MachineSetting' ($r.Settings['HARNESS_ALREADY'] -eq 'from-env') "got '$($r.Settings['HARNESS_ALREADY'])'"
    Test-Check 'Get-MachineSetting falls back to the default' ($r.Settings['HARNESS_MISSING'] -eq 'default')
    Test-Check "an 'export ' line is accepted" ($r.Values['HARNESS_X'] -eq '1')
    Test-Check 'the allowlisted REALM_SYNC is read' ($r.Values['REALM_SYNC'] -eq 'dryrun')
    Test-Check 'a value is never expanded' ($r.Values['HARNESS_LITERAL'] -ceq '$(Write-Output PWNED)')
    Test-Check 'DATABASE_URL is left to its readers, not read' (-not $r.Values.ContainsKey('DATABASE_URL'))
    Test-Check 'DATABASE_URL is not reported as ignored' (-not $r.Stderr.Contains("'DATABASE_URL'"))
    Test-Check 'no value from the file reaches the output unasked' (-not $r.All.Contains($script:Secret))

    $r = Invoke-Reader (Join-Path $script:ScratchRoot 'absent.env')
    Test-Check 'a missing machine file reads nothing, silently' ($r.Code -eq 0 -and $r.Values.Count -eq 0 -and -not $r.Stderr) $r.All
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
