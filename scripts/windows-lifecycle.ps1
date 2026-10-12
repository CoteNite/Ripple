param(
    [Parameter(Mandatory = $true)][ValidateSet('RemoveProgram','RegisterProgram')][string]$Action,
    [Parameter(Mandatory = $true)][string]$InstallationDirectory
)
$ErrorActionPreference = 'Stop'

function Get-SafeInternalPath([string]$Root, [string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':') -or
        ($Relative -split '[\\/]') -contains '..') { throw 'Invalid program ownership path' }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $Relative))
    if (-not $full.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Program ownership path escapes installation directory'
    }
    $part = $Root
    foreach ($segment in ($Relative -split '[\\/]')) {
        $part = Join-Path $part $segment
        if (Test-Path -LiteralPath $part) {
            $attributes = (Get-Item -LiteralPath $part -Force).Attributes
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing linked program path: $part"
            }
        }
    }
    return $full
}

try {
    $root = [IO.Path]::GetFullPath($InstallationDirectory).TrimEnd('\')
    $rootItem = Get-Item -LiteralPath $root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Installation directory must not be a link'
    }
    $manifestPath = Join-Path $root 'ripple-program-files.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne 1) { throw 'Unsupported program ownership manifest' }
    if ($Action -eq 'RegisterProgram') {
        foreach ($relative in @('resources/elevate.exe','uninstallerIcon.ico','Uninstall Ripple.exe')) {
            $file = Get-SafeInternalPath $root $relative
            if (Test-Path -LiteralPath $file -PathType Leaf) {
                $manifest.files | Add-Member -NotePropertyName $relative -NotePropertyValue (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -Force
            }
        }
        $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
        exit 0
    }
    $removal = @()
    foreach ($entry in $manifest.files.PSObject.Properties) {
        if (($entry.Name -split '[\\/]')[0] -in @('ripple-data', 'ripple-migration-backup')) {
            throw 'Program ownership manifest includes user data'
        }
        $file = Get-SafeInternalPath $root $entry.Name
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $entry.Value) {
                $removal += $file
            }
        }
    }
    # The helper itself is executed from the NSIS plugin directory, outside this tree.
    foreach ($file in $removal) { Remove-Item -LiteralPath $file -Force }
    foreach ($file in $removal) {
        $directory = [IO.Path]::GetDirectoryName($file)
        while ($directory -ne $root -and (Test-Path -LiteralPath $directory)) {
            if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { break }
            Remove-Item -LiteralPath $directory -Force
            $directory = [IO.Path]::GetDirectoryName($directory)
        }
    }
    Remove-Item -LiteralPath $manifestPath -Force
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
