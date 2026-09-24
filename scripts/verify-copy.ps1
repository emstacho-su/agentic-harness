<#
.SYNOPSIS
    Prove a copied tree is byte-for-byte the tree it was copied from (R-C1).

.DESCRIPTION
    Builds a listing of every file under -Source and every file under
    -Destination: the path relative to the root (forward slashes, case kept),
    the file's hash and its length. Both listings are sorted and compared, and
    the script prints the first difference it finds, in this order:

      missing in destination: <rel>   a source file the copy does not have
      extra in destination: <rel>     a copied file the source does not have
      hash differs: <rel> (...)       same path, different content

    followed by `mismatch`, and exits 1. When nothing differs it prints
    `identical (<n> files, <bytes> bytes, <algorithm>, <seconds> s)` and exits 0.

    Every file counts: hidden files and dotfiles are listed, and `.obsidian` is
    NOT excluded, because Obsidian's settings are part of the vault's content.
    Paths are compared case-sensitively, so a copy that changed the case of a
    name is reported (as missing plus extra), not waved through.

    Reparse points are read, not skipped. Every file in a OneDrive folder is a
    cloud-files reparse point with its content present, and filtering them out
    would leave nothing to compare. Hash a folder only after "Always keep on
    this device": a placeholder whose content is not local is fetched on read.

    One pass per side, no per-file output: the live vault (762 files, 8.9 MB)
    takes about 8 s a side.

.PARAMETER Source
    The original tree (for R-C1, the OneDrive vault).

.PARAMETER Destination
    The copy (for R-C1, ~/vault).

.PARAMETER Exclude
    Names skipped on both sides wherever they appear as a path segment, as a
    folder or a file: the default @('.git') skips the root `.git` and a `.git`
    in any subfolder (a realm's checkout), so the check can be re-run after the
    realms are initialised. Matching ignores case. Pass @() to compare
    everything. Under `powershell -File` an array cannot be written as @(...);
    give one comma-separated string instead (`-Exclude .git,.trash`).

.PARAMETER Algorithm
    Any algorithm Get-FileHash supports in both Windows PowerShell 5.1 and
    PowerShell 7. Default SHA256.

.OUTPUTS
    Exit 0 identical, 1 a difference was found, 2 the check could not run
    (a missing folder, an unreadable file).

.EXAMPLE
    ./verify-copy.ps1 -Source "C:/Users/estac/OneDrive - Syracuse University/vault" -Destination C:/Users/estac/vault
    ./verify-copy.ps1 -Source D:/a -Destination D:/b -Exclude @()
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string] $Source = '',
    [string] $Destination = '',
    [string[]] $Exclude = @('.git'),
    [ValidateSet('SHA1', 'SHA256', 'SHA384', 'SHA512', 'MD5')]
    [string] $Algorithm = 'SHA256'
)

$ErrorActionPreference = 'Stop'

# Exit codes: the verdict (0 / 1) and "the check did not run" (2) must never be
# confused by whoever reads them, a person or the migration runbook.
$script:ExitIdentical = 0
$script:ExitMismatch = 1
$script:ExitCannotRun = 2

# How many leading hex digits of each hash a `hash differs` line shows.
$script:HashPreviewLength = 8

function Stop-CannotRun {
    param([string] $Message)
    [Console]::Error.WriteLine("error: $Message")
    exit $script:ExitCannotRun
}

function Resolve-TreeRoot {
    param([string] $Path, [string] $Label)
    if (-not $Path) {
        Stop-CannotRun "-$Label is required."
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        Stop-CannotRun "$Label directory not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).ProviderPath
}

# Accept both a real array and the single comma-separated string that
# `powershell -File` delivers, and drop blanks.
function Get-ExcludedNames {
    param([string[]] $Names)
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($Names)) {
        if ($null -eq $entry) { continue }
        foreach ($part in $entry.Split(',')) {
            $name = $part.Trim()
            if ($name) { [void] $set.Add($name) }
        }
    }
    return , $set
}

# Walk the tree once, iteratively, skipping any folder or file whose name is
# excluded (so an excluded folder is never entered). Returns the records sorted
# by relative path, ordinal.
function Get-TreeListing {
    param(
        [string] $Root,
        [System.Collections.Generic.HashSet[string]] $ExcludedNames,
        [string] $HashAlgorithm
    )
    $records = New-Object 'System.Collections.Generic.List[object]'
    $pending = New-Object 'System.Collections.Generic.Stack[object]'
    $pending.Push([pscustomobject]@{ Directory = [System.IO.DirectoryInfo]::new($Root); Prefix = '' })

    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($entry in $current.Directory.EnumerateFileSystemInfos()) {
            if ($ExcludedNames.Contains($entry.Name)) { continue }
            $relative = if ($current.Prefix) { "$($current.Prefix)/$($entry.Name)" } else { $entry.Name }
            if ($entry -is [System.IO.DirectoryInfo]) {
                $pending.Push([pscustomobject]@{ Directory = $entry; Prefix = $relative })
                continue
            }
            $hash = (Get-FileHash -LiteralPath $entry.FullName -Algorithm $HashAlgorithm).Hash
            $records.Add([pscustomobject]@{ RelativePath = $relative; Hash = $hash; Length = $entry.Length })
        }
    }

    $records.Sort([System.Comparison[object]] { param($a, $b) [string]::CompareOrdinal($a.RelativePath, $b.RelativePath) })
    return , $records
}

function ConvertTo-PathIndex {
    param([System.Collections.Generic.List[object]] $Records)
    $index = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    foreach ($record in $Records) { $index[$record.RelativePath] = $record }
    return , $index
}

# The first difference as one line, or $null when the listings agree.
function Find-FirstMismatch {
    param(
        [System.Collections.Generic.List[object]] $SourceRecords,
        [System.Collections.Generic.List[object]] $DestinationRecords
    )
    $sourceIndex = ConvertTo-PathIndex $SourceRecords
    $destinationIndex = ConvertTo-PathIndex $DestinationRecords

    foreach ($record in $SourceRecords) {
        if (-not $destinationIndex.ContainsKey($record.RelativePath)) {
            return "missing in destination: $($record.RelativePath)"
        }
    }
    foreach ($record in $DestinationRecords) {
        if (-not $sourceIndex.ContainsKey($record.RelativePath)) {
            return "extra in destination: $($record.RelativePath)"
        }
    }
    foreach ($record in $SourceRecords) {
        $copy = $destinationIndex[$record.RelativePath]
        if ($record.Hash -ne $copy.Hash) {
            $sourcePreview = $record.Hash.Substring(0, $script:HashPreviewLength)
            $destinationPreview = $copy.Hash.Substring(0, $script:HashPreviewLength)
            return "hash differs: $($record.RelativePath) ($sourcePreview... vs $destinationPreview...)"
        }
    }
    return $null
}

# ---------------------------------------------------------------- the check

$sourceRoot = Resolve-TreeRoot $Source 'Source'
$destinationRoot = Resolve-TreeRoot $Destination 'Destination'
$excludedNames = Get-ExcludedNames $Exclude
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
    $sourceRecords = Get-TreeListing $sourceRoot $excludedNames $Algorithm
    Write-Output "source: $($sourceRecords.Count) files"
    $destinationRecords = Get-TreeListing $destinationRoot $excludedNames $Algorithm
    Write-Output "destination: $($destinationRecords.Count) files"
} catch {
    Stop-CannotRun "could not list and hash the trees: $($_.Exception.Message)"
}

$mismatch = Find-FirstMismatch $sourceRecords $destinationRecords
if ($mismatch) {
    Write-Output $mismatch
    Write-Output 'mismatch'
    exit $script:ExitMismatch
}

$totalBytes = [long] 0
foreach ($record in $sourceRecords) { $totalBytes += $record.Length }
$seconds = $stopwatch.Elapsed.TotalSeconds.ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture)
Write-Output "identical ($($sourceRecords.Count) files, $totalBytes bytes, $Algorithm, $seconds s)"
exit $script:ExitIdentical
