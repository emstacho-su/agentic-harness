<#
.SYNOPSIS
    Prove a copied tree is byte-for-byte the tree it was copied from (R-C1).

.DESCRIPTION
    Lists every file under -Source and every file under -Destination by the
    path relative to the root (forward slashes, case kept), compares the two
    path sets, and only when they agree reads and hashes the files. It prints
    the first difference it finds, in this order:

      missing in destination: <rel>   a source path the copy does not have
      extra in destination: <rel>     a copied path the source does not have
      link differs: <rel> (...)       same path, a different link target
      hash differs: <rel> (...)       same path, different content

    followed by `mismatch`, and exits 1. A missing or extra path is found
    without reading a single file. When nothing differs it prints
    `identical (<n> files, <bytes> bytes, <algorithm>, <seconds> s)` and exits 0.

    A folder that is a real link (a junction or a symbolic link) is not
    walked into: it is one entry, compared by its target, so the same link on
    both sides is equal and a link on one side only is missing or extra. It
    counts as a file in <n> and adds no bytes.

    Every file counts: hidden files and dotfiles are listed, and `.obsidian` is
    NOT excluded, because Obsidian's settings are part of the vault's content.
    Paths are compared case-sensitively, so a copy that changed the case of a
    name is reported (as missing plus extra), not waved through.

    Other reparse points are read, not skipped. Every file and folder in a
    OneDrive folder is a cloud-files reparse point with no link type and its
    content present, and filtering them out would leave nothing to compare.
    Hash a folder only after "Always keep on this device": a placeholder whose
    content is not local is fetched on read.

    No per-file output. Listing is quick; hashing the live vault (762 files,
    8.9 MB) takes about 8 s a side.

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
    SHA1, SHA256, SHA384, SHA512 or MD5: what Get-FileHash supports in both
    Windows PowerShell 5.1 and PowerShell 7. Default SHA256.

.OUTPUTS
    Exit 0 identical, 1 a difference was found, 2 the check could not run
    (a missing folder, an unreadable file, an unknown algorithm, any other
    error). Nothing but a found difference exits 1.

.EXAMPLE
    ./verify-copy.ps1 -Source "C:/Users/estac/OneDrive - Syracuse University/vault" -Destination C:/Users/estac/vault
    ./verify-copy.ps1 -Source D:/a -Destination D:/b -Exclude @()
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string] $Source = '',
    [string] $Destination = '',
    [string[]] $Exclude = @('.git'),
    # Checked in the body, not by ValidateSet: a binding failure exits 1, which reads as a mismatch.
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

# What Get-FileHash supports in both Windows PowerShell 5.1 and PowerShell 7.
$script:Algorithms = @('SHA1', 'SHA256', 'SHA384', 'SHA512', 'MD5')

# Folder link types recorded as one entry and never walked into. A OneDrive
# cloud folder is a reparse point too, but has no link type, and is walked.
$script:FolderLinkTypes = @('Junction', 'SymbolicLink')

# A link's stand-in for a content hash: equal only for the same target.
$script:LinkHashPrefix = 'LINK:'

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

function Assert-Algorithm {
    param([string] $Name)
    if ($script:Algorithms -notcontains $Name) {
        Stop-CannotRun "-Algorithm $Name is not one of $($script:Algorithms -join ', ')."
    }
}

# A folder's link target, or $null when it is not a junction or a symbolic
# link. `Target` is a string in PowerShell 7 and a list in 5.1.
function Get-FolderLinkTarget {
    param([System.IO.DirectoryInfo] $Folder)
    if ($script:FolderLinkTypes -notcontains $Folder.LinkType) { return $null }
    return (@($Folder.Target) | Where-Object { $_ }) -join ';'
}

# Walk the tree once, iteratively, reading no file: skip any folder or file
# whose name is excluded (so an excluded folder is never entered), and record
# a linked folder as one entry without entering it. Returns the records sorted
# by relative path, ordinal. `LinkTarget` is $null for a file.
function Get-TreeListing {
    param(
        [string] $Root,
        [System.Collections.Generic.HashSet[string]] $ExcludedNames
    )
    $records = New-Object 'System.Collections.Generic.List[object]'
    $pending = New-Object 'System.Collections.Generic.Stack[object]'
    $pending.Push([pscustomobject]@{ Directory = [System.IO.DirectoryInfo]::new($Root); Prefix = '' })

    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($entry in $current.Directory.EnumerateFileSystemInfos()) {
            if ($ExcludedNames.Contains($entry.Name)) { continue }
            $relative = if ($current.Prefix) { "$($current.Prefix)/$($entry.Name)" } else { $entry.Name }
            $linkTarget = $null
            $length = [long] 0
            if ($entry -is [System.IO.DirectoryInfo]) {
                $linkTarget = Get-FolderLinkTarget $entry
                if ($null -eq $linkTarget) {
                    $pending.Push([pscustomobject]@{ Directory = $entry; Prefix = $relative })
                    continue
                }
            } else {
                $length = $entry.Length
            }
            $records.Add([pscustomobject]@{ RelativePath = $relative; FullName = $entry.FullName; Length = $length; LinkTarget = $linkTarget })
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

# The first path one side has and the other does not, as one line, or $null
# when the path sets agree. Reads no file.
function Find-PathMismatch {
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
    return $null
}

# A file's content hash, or the fixed LINK:<target> for a linked folder.
function Get-EntryHash {
    param($Record, [string] $HashAlgorithm)
    if ($null -ne $Record.LinkTarget) { return "$($script:LinkHashPrefix)$($Record.LinkTarget)" }
    return (Get-FileHash -LiteralPath $Record.FullName -Algorithm $HashAlgorithm).Hash
}

function Get-LinkDescription {
    param($Record)
    if ($null -eq $Record.LinkTarget) { return 'not a link' }
    return $Record.LinkTarget
}

# With the path sets equal: hash each pair and return the first difference as
# one line, or $null when every pair agrees.
function Find-ContentMismatch {
    param(
        [System.Collections.Generic.List[object]] $SourceRecords,
        [System.Collections.Generic.List[object]] $DestinationRecords,
        [string] $HashAlgorithm
    )
    $destinationIndex = ConvertTo-PathIndex $DestinationRecords
    foreach ($record in $SourceRecords) {
        $copy = $destinationIndex[$record.RelativePath]
        $sourceHash = Get-EntryHash $record $HashAlgorithm
        $destinationHash = Get-EntryHash $copy $HashAlgorithm
        if ($sourceHash -ceq $destinationHash) { continue }
        if (($null -ne $record.LinkTarget) -or ($null -ne $copy.LinkTarget)) {
            return "link differs: $($record.RelativePath) ($(Get-LinkDescription $record) vs $(Get-LinkDescription $copy))"
        }
        $sourcePreview = $sourceHash.Substring(0, $script:HashPreviewLength)
        $destinationPreview = $destinationHash.Substring(0, $script:HashPreviewLength)
        return "hash differs: $($record.RelativePath) ($sourcePreview... vs $destinationPreview...)"
    }
    return $null
}

function Write-Mismatch {
    param([string] $Line)
    Write-Output $Line
    Write-Output 'mismatch'
    exit $script:ExitMismatch
}

# ---------------------------------------------------------------- the check
# One try around all of it: any error nobody planned for is "the check did not
# run" (2), never PowerShell's default exit 1, which reads as a mismatch.

try {
    Assert-Algorithm $Algorithm
    $sourceRoot = Resolve-TreeRoot $Source 'Source'
    $destinationRoot = Resolve-TreeRoot $Destination 'Destination'
    $excludedNames = Get-ExcludedNames $Exclude
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    $sourceRecords = Get-TreeListing $sourceRoot $excludedNames
    Write-Output "source: $($sourceRecords.Count) files"
    $destinationRecords = Get-TreeListing $destinationRoot $excludedNames
    Write-Output "destination: $($destinationRecords.Count) files"

    $pathMismatch = Find-PathMismatch $sourceRecords $destinationRecords
    if ($pathMismatch) { Write-Mismatch $pathMismatch }
    $contentMismatch = Find-ContentMismatch $sourceRecords $destinationRecords $Algorithm
    if ($contentMismatch) { Write-Mismatch $contentMismatch }

    $totalBytes = [long] 0
    foreach ($record in $sourceRecords) { $totalBytes += $record.Length }
    $seconds = $stopwatch.Elapsed.TotalSeconds.ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture)
    Write-Output "identical ($($sourceRecords.Count) files, $totalBytes bytes, $Algorithm, $seconds s)"
    exit $script:ExitIdentical
} catch {
    Stop-CannotRun "could not compare the trees: $($_.Exception.Message)"
}
