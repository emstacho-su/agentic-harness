<#
.SYNOPSIS
    Self-test for scripts/verify-copy.ps1. No Pester needed.

.DESCRIPTION
    Builds scratch trees under $env:TEMP, runs verify-copy.ps1 against them in
    a child `powershell -NoProfile -File` (so its `exit` codes are the real
    ones), and prints PASS or FAIL per case. The scratch folder is removed in
    `finally`. Exits 1 if any case failed.

    The one case that needs a real empty array (`-Exclude @()`) runs through
    `-Command`, because `-File` hands every argument over as a string.

.EXAMPLE
    powershell -NoProfile -File scripts/tests/verify-copy.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The script under test, one folder up from this one.
$script:VerifyScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'verify-copy.ps1'
# Windows PowerShell 5.1 is the target the migration runs under.
$script:ChildShell = 'powershell'
# "cafe.md" with an e-acute, written as a code point, so this file stays ASCII and parses the
# same whether or not 5.1 reads it as UTF-8.
$script:NonAsciiName = "caf$([char]0x00E9).md"
$script:BracketName = '[draft] c.md'

$script:Failures = 0
$script:ScratchRoot = Join-Path $env:TEMP ("verify-copy-" + [guid]::NewGuid())

# The tree every case starts from: nested folders, a dotfile marked hidden,
# `.obsidian` (content, not excluded), a bracketed name and a non-ASCII one.
$script:BaseFiles = [ordered]@{
    'root.md'                          = 'root note'
    'notes/a.md'                       = 'alpha'
    'notes/sub/b.md'                   = 'bravo'
    ".obsidian/app.json"               = '{"theme":"dark"}'
    '.hidden-dotfile'                  = 'dot'
    "notes/$($script:BracketName)"     = 'charlie'
    "notes/$($script:NonAsciiName)"    = 'delta'
}

function Write-TreeFile {
    param([string] $Root, [string] $Relative, [string] $Content)
    $path = Join-Path $Root ($Relative -replace '/', '\')
    [void] [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($path))
    [System.IO.File]::WriteAllBytes($path, [System.Text.Encoding]::UTF8.GetBytes($Content))
    return $path
}

# A fresh source/destination pair with identical content, one per case.
function New-TreePair {
    param([string] $Name)
    $pair = [pscustomobject]@{
        Source      = Join-Path $script:ScratchRoot "$Name\source"
        Destination = Join-Path $script:ScratchRoot "$Name\destination"
    }
    foreach ($root in @($pair.Source, $pair.Destination)) {
        foreach ($relative in $script:BaseFiles.Keys) {
            $path = Write-TreeFile $root $relative $script:BaseFiles[$relative]
            if ($relative -eq '.hidden-dotfile') {
                [System.IO.File]::SetAttributes($path, [System.IO.FileAttributes]::Hidden)
            }
        }
    }
    return $pair
}

# A folder outside both trees for junctions to point at, holding one file.
function New-JunctionTarget {
    param([string] $Name)
    $target = Join-Path $script:ScratchRoot "$Name\target"
    Write-TreeFile $target 'inside.md' 'behind the link' | Out-Null
    return $target
}

# A junction at <root>/<relative>; junctions need no admin rights, unlike symbolic links.
function New-TreeJunction {
    param([string] $Root, [string] $Relative, [string] $Target)
    New-Item -ItemType Junction -Path (Join-Path $Root ($Relative -replace '/', '\')) -Target $Target | Out-Null
}

# Hold a file open with no sharing while $Action runs: anything that tries to read it fails.
function Invoke-WithFileLocked {
    param([string] $Path, [scriptblock] $Action)
    $handle = [System.IO.File]::Open($Path, 'Open', 'Read', 'None')
    try { return & $Action } finally { $handle.Dispose() }
}

function Get-BaseByteCount {
    $total = 0
    foreach ($content in $script:BaseFiles.Values) { $total += [System.Text.Encoding]::UTF8.GetByteCount($content) }
    return $total
}

# Run verify-copy.ps1 in a child shell; return its exit code and all output
# (stdout and stderr) as one string. `-Command` mode is for `-Exclude @()`.
function Invoke-Verify {
    param([string] $Source, [string] $Destination, [string[]] $ExtraArguments = @(), [switch] $EmptyExclude)
    # Native stderr under 2>&1 is an error record in 5.1; with 'Stop' it would
    # abort the test instead of being captured.
    $ErrorActionPreference = 'Continue'
    if ($EmptyExclude) {
        $command = "& '$script:VerifyScript' -Source '$Source' -Destination '$Destination' -Exclude @(); exit `$LASTEXITCODE"
        $lines = & $script:ChildShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $command 2>&1
    } else {
        $arguments = @('-Source', $Source, '-Destination', $Destination) + $ExtraArguments
        $lines = & $script:ChildShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:VerifyScript @arguments 2>&1
    }
    $code = $LASTEXITCODE
    $text = (@($lines) | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{ Code = $code; Output = $text }
}

# Plain substring checks: -like would read the brackets in a name as a pattern.
function Test-Case {
    param([string] $Name, $Result, [int] $ExpectedCode, [string[]] $Expected = @(), [string[]] $NotExpected = @())
    $problems = @()
    if ($Result.Code -ne $ExpectedCode) { $problems += "exit $($Result.Code), expected $ExpectedCode" }
    foreach ($fragment in $Expected) {
        if (-not $Result.Output.Contains($fragment)) { $problems += "output lacks '$fragment'" }
    }
    foreach ($fragment in $NotExpected) {
        if ($Result.Output.Contains($fragment)) { $problems += "output has '$fragment'" }
    }
    if ($problems.Count -eq 0) {
        Write-Output "PASS $Name"
        return
    }
    $script:Failures++
    Write-Output "FAIL $Name -- $($problems -join '; ')"
    foreach ($line in $Result.Output.Split("`n")) { Write-Output "     | $line" }
}

try {
    if (-not (Test-Path -LiteralPath $script:VerifyScript)) {
        throw "verify-copy.ps1 not found at $script:VerifyScript"
    }
    $fileCount = $script:BaseFiles.Count
    $byteCount = Get-BaseByteCount

    $pair = New-TreePair 'identical'
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case 'identical trees' $result 0 @(
        "source: $fileCount files", "destination: $fileCount files",
        "identical ($fileCount files, $byteCount bytes, SHA256, ")

    $pair = New-TreePair 'one-byte'
    Write-TreeFile $pair.Destination 'notes/a.md' 'alphb' | Out-Null
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case 'one byte altered' $result 1 @('hash differs: notes/a.md (', 'mismatch')

    $pair = New-TreePair 'missing'
    Remove-Item -LiteralPath (Join-Path $pair.Destination 'notes\sub\b.md')
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case 'file missing in destination' $result 1 @('missing in destination: notes/sub/b.md', 'mismatch')

    $pair = New-TreePair 'extra'
    Write-TreeFile $pair.Destination 'notes/extra.md' 'echo' | Out-Null
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case 'extra file in destination' $result 1 @('extra in destination: notes/extra.md', 'mismatch')

    $pair = New-TreePair 'git-only-in-destination'
    Write-TreeFile $pair.Destination '.git/HEAD' 'ref: refs/heads/main' | Out-Null
    Write-TreeFile $pair.Destination 'notes/sub/.git/config' '[core]' | Out-Null
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case '.git (root and nested) excluded by default' $result 0 @("identical ($fileCount files, ")

    $result = Invoke-Verify $pair.Source $pair.Destination -EmptyExclude
    Test-Case '-Exclude @() makes .git an extra' $result 1 @('extra in destination: .git/HEAD', 'mismatch')

    $pair = New-TreePair 'comma-exclude'
    Write-TreeFile $pair.Destination '.obsidian/app.json' '{"theme":"light"}' | Out-Null
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case '.obsidian is compared by default' $result 1 @('hash differs: .obsidian/app.json (')
    $result = Invoke-Verify $pair.Source $pair.Destination @('-Exclude', '.git,.obsidian')
    Test-Case '-Exclude as one comma string under -File' $result 0 @("identical ($($fileCount - 1) files, ")

    $pair = New-TreePair 'brackets'
    Write-TreeFile $pair.Destination "notes/$($script:BracketName)" 'charliE' | Out-Null
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case 'bracketed name is hashed literally' $result 1 @("hash differs: notes/$($script:BracketName) (")

    $pair = New-TreePair 'non-ascii'
    Write-TreeFile $pair.Destination "notes/$($script:NonAsciiName)" 'deltA' | Out-Null
    $result = Invoke-Verify $pair.Source $pair.Destination
    # The child's output crosses the console code page, so match on the ASCII
    # part of the name; the exit code and the verdict line are what matter.
    Test-Case 'non-ASCII name is hashed' $result 1 @('hash differs: notes/caf', '.md (', 'mismatch')

    # Links: a junction is compared as a link to its target, never walked into.
    $junctions = @()
    $target = New-JunctionTarget 'junction-extra'
    $pair = New-TreePair 'junction-extra'
    New-TreeJunction $pair.Destination 'notes/linked' $target
    $junctions += Join-Path $pair.Destination 'notes\linked'
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case 'junction only in destination is one extra entry' $result 1 @('extra in destination: notes/linked', 'mismatch') @('notes/linked/')

    $pair = New-TreePair 'junction-both'
    foreach ($root in @($pair.Source, $pair.Destination)) {
        New-TreeJunction $root 'notes/linked' $target
        $junctions += Join-Path $root 'notes\linked'
    }
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case 'same junction on both sides is identical, and not walked into' $result 0 @(
        "source: $($fileCount + 1) files", "identical ($($fileCount + 1) files, $byteCount bytes, ")

    $otherTarget = New-JunctionTarget 'junction-other'
    $pair = New-TreePair 'junction-differs'
    New-TreeJunction $pair.Source 'notes/linked' $target
    New-TreeJunction $pair.Destination 'notes/linked' $otherTarget
    $junctions += @((Join-Path $pair.Source 'notes\linked'), (Join-Path $pair.Destination 'notes\linked'))
    $result = Invoke-Verify $pair.Source $pair.Destination
    Test-Case 'junctions to different targets differ' $result 1 @('link differs: notes/linked (', 'mismatch')
    foreach ($junction in $junctions) { [System.IO.Directory]::Delete($junction) }

    # Path sets are compared before any file is read: an unreadable source file
    # cannot hide a missing one, and is never hashed when a path is missing.
    $pair = New-TreePair 'missing-before-hash'
    Remove-Item -LiteralPath (Join-Path $pair.Destination 'notes\sub\b.md')
    $result = Invoke-WithFileLocked (Join-Path $pair.Source 'notes\a.md') { Invoke-Verify $pair.Source $pair.Destination }
    Test-Case 'missing file is reported before hashing' $result 1 @('missing in destination: notes/sub/b.md', 'mismatch') @('hash differs', 'error:')

    $pair = New-TreePair 'unreadable'
    $result = Invoke-WithFileLocked (Join-Path $pair.Source 'notes\a.md') { Invoke-Verify $pair.Source $pair.Destination }
    Test-Case 'unreadable file is exit 2, never a verdict' $result 2 @('error: ') @('mismatch', 'identical (')

    $pair = New-TreePair 'bad-algorithm'
    $result = Invoke-Verify $pair.Source $pair.Destination @('-Algorithm', 'MD4')
    Test-Case 'unknown algorithm is exit 2, not 1' $result 2 @('error: ', 'MD4')

    $pair = New-TreePair 'missing-dir'
    $result = Invoke-Verify $pair.Source (Join-Path $script:ScratchRoot 'does-not-exist')
    Test-Case 'missing destination directory' $result 2 @('Destination directory not found')
    $result = Invoke-Verify (Join-Path $script:ScratchRoot 'does-not-exist') $pair.Destination
    Test-Case 'missing source directory' $result 2 @('Source directory not found')
} catch {
    $script:Failures++
    Write-Output "FAIL harness -- $($_.Exception.Message)"
} finally {
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
