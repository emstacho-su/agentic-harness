<#
    ~/.harness/machine.env reader shared by backup-store.ps1, nightly-ingest.ps1,
    register-nightly-ingest.ps1 and register-checkpoint-collect.ps1. Dot-source it:

        . (Join-Path $PSScriptRoot 'lib\machine-env.ps1')

    The file is KEY=value lines, the same file the hooks, ingest and the MCP
    server read, and the same rules as lib/machine-env.sh: a key is read only
    when it is a plain identifier AND starts with HARNESS_ or is one of the few
    un-prefixed settings the scripts use. Keys the file holds for programs that
    read it themselves (DATABASE_URL, ...) are skipped quietly; any other key is
    reported on stderr by name, never with its value. Blank lines and `#`
    comments are skipped, `export ` is stripped, a trailing CR is stripped, and
    a value in matching quotes loses them. A value is never expanded.

    Windows PowerShell 5.1 compatible. Defines functions only: dot-sourcing it
    twice is harmless.
#>

# accept, skip or reject for one key. The lists live here, not in script-scope
# variables, so they cannot collide with a caller's names.
function Get-MachineEnvKeyVerdict {
    param([string] $Key)
    # A plain identifier, the same rule as the bash reader and the hooks' parser.
    $keyPattern = '\A[A-Za-z_][A-Za-z0-9_]*\z'
    # Every harness setting carries this prefix.
    $prefix = 'HARNESS_'
    # The un-prefixed settings the nightly scripts read; exactly those.
    $settings = @('REALM_SYNC', 'TRANSCRIPT_IDLE_HOURS', 'STALE_AFTER_HOURS')
    # Held in the file for ingest, the hooks and the MCP server, which read it themselves.
    $leftToReaders = @('DATABASE_URL', 'DATABASE_SSL', 'DATABASE_CA_CERT', 'FASTEMBED_CACHE_DIR')

    if ($Key -cnotmatch $keyPattern) { return 'reject' }
    if ($Key.StartsWith($prefix, [System.StringComparison]::Ordinal)) { return 'accept' }
    if ($settings -ccontains $Key) { return 'accept' }
    if ($leftToReaders -ccontains $Key) { return 'skip' }
    return 'reject'
}

# ~/.harness/machine.env (or $env:HARNESS_MACHINE_ENV) as a hashtable of the
# accepted keys. An absent file is an empty table, not an error.
function Read-MachineEnv {
    $file = if ($env:HARNESS_MACHINE_ENV) { $env:HARNESS_MACHINE_ENV } else { Join-Path $env:USERPROFILE '.harness\machine.env' }
    $values = @{}
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $values }
    foreach ($raw in Get-Content -LiteralPath $file -Encoding UTF8) {
        $line = $raw.TrimEnd("`r").Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
        $at = $line.IndexOf('=')
        if ($at -lt 0) { continue }
        $key = $line.Substring(0, $at).Trim()
        $verdict = Get-MachineEnvKeyVerdict $key
        if ($verdict -eq 'skip') { continue }
        if ($verdict -ne 'accept') {
            [Console]::Error.WriteLine("machine.env: ignoring key '$key'")
            continue
        }
        $value = $line.Substring($at + 1).Trim()
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }
    return $values
}

# The environment first (when non-empty), then the machine file, then $Default.
function Get-MachineSetting {
    param([hashtable] $Machine, [string] $Key, [string] $Default)
    $fromEnv = [Environment]::GetEnvironmentVariable($Key)
    if ($fromEnv) { return $fromEnv }
    if ($Machine.ContainsKey($Key) -and $Machine[$Key]) { return $Machine[$Key] }
    return $Default
}
