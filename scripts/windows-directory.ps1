param(
    [Parameter(Mandatory=$true)][string]$InstallationDirectory,
    [Parameter(Mandatory=$true)][string]$IncomingManifest,
    [string]$LegacyManifest,
    [string]$RegisteredDirectory
)
$ErrorActionPreference='Stop'

function Read-JsonFile([string]$Path, [string]$Description) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Description is missing." }
    try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { throw "$Description is malformed." }
}

function Get-ManifestFiles($Manifest, [string]$Description) {
    if ($null -eq $Manifest -or $Manifest.version -ne 1) { throw "$Description has an unsupported version." }
    $property = $Manifest.PSObject.Properties['files']
    if ($null -eq $property -or $null -eq $property.Value -or $property.Value -is [Array]) { throw "$Description has an invalid files map." }
    $files = [System.Collections.Hashtable]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $property.Value.PSObject.Properties) {
        $relative = ([string]$entry.Name).Replace('\','/')
        $segments = $relative -split '/'
        if (-not $relative -or $relative.StartsWith('/') -or $relative.Contains(':') -or ($segments | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' }).Count -ne 0) { throw "$Description contains an invalid file path." }
        if ($segments[0] -in @('ripple-data','ripple-migration-backup') -or $relative -eq 'ripple-program-files.json') { throw "$Description contains a reserved file path." }
        if ($entry.Value -isnot [string] -or ([string]$entry.Value -notmatch '^[0-9a-fA-F]{64}$')) { throw "$Description contains an invalid SHA-256 hash." }
        $files[$relative] = ([string]$entry.Value).ToLowerInvariant()
    }
    return ,$files
}

function Assert-NoReparsePoint([string]$Root, [string]$Relative) {
    $part = $Root
    foreach ($segment in ($Relative.Replace('\','/') -split '/')) {
        $part = Join-Path $part $segment
        if (Test-Path -LiteralPath $part) {
            if (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '安装目录不能通过链接跳转到其他位置。' }
        }
    }
}

try {
    if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请以当前用户正常权限运行 Ripple 安装器，不要使用管理员权限。' }
    $root=[IO.Path]::GetFullPath($InstallationDirectory).TrimEnd('\')
    if ($root.StartsWith('\\') -or $root -notmatch '^[A-Za-z]:\\.+') { throw '请选择本机固定磁盘上的 Ripple 专用目录。' }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw '不支持可移动磁盘、映射网络盘或网络目录。' }
    $incomingFiles = Get-ManifestFiles (Read-JsonFile $IncomingManifest 'Incoming program ownership manifest') 'Incoming program ownership manifest'
    foreach ($relative in @('ripple-program-files.json','resources/elevate.exe','uninstallerIcon.ico','Uninstall Ripple.exe')) { if (-not $incomingFiles.ContainsKey($relative)) { $incomingFiles[$relative] = $null } }

    $existing=$root
    while (-not (Test-Path -LiteralPath $existing)) { $existing=[IO.Path]::GetDirectoryName($existing) }
    $ancestor=$existing
    while ($ancestor) {
        if (((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '安装目录不能通过链接跳转到其他位置。' }
        $ancestor=[IO.Path]::GetDirectoryName($ancestor)
    }
    $registered = $RegisteredDirectory -and ([IO.Path]::GetFullPath($RegisteredDirectory).TrimEnd('\') -eq $root)
    $ownedFiles = [System.Collections.Hashtable]::new([StringComparer]::OrdinalIgnoreCase)
    $programMarker = Join-Path $root 'ripple-program-files.json'
    $programMarkerValid = $false
    if (Test-Path -LiteralPath $programMarker) {
        Assert-NoReparsePoint $root 'ripple-program-files.json'
        $ownedFiles = Get-ManifestFiles (Read-JsonFile $programMarker 'Existing program ownership manifest') 'Existing program ownership manifest'
        $programMarkerValid = $true
    } elseif ($registered -and $LegacyManifest) {
        $ownedFiles = Get-ManifestFiles (Read-JsonFile $LegacyManifest 'Legacy program ownership manifest') 'Legacy program ownership manifest'
    }
    $dataMarker = Join-Path $root 'ripple-data\ripple-state.json'
    $dataMarkerValid = $false
    if (Test-Path -LiteralPath $dataMarker) {
        Assert-NoReparsePoint $root 'ripple-data\ripple-state.json'
        $data = Read-JsonFile $dataMarker 'Ripple data marker'
        if ($null -eq $data -or $data.version -ne 1 -or $data.state -notin @('active','awaiting-session')) { throw 'Ripple data marker has an invalid version or state.' }
        $dataMarkerValid = $true
    }
    if (Test-Path -LiteralPath $root -PathType Leaf) { throw '安装目录已被文件占用。' }
    if (Test-Path -LiteralPath $root) {
        $items = @(Get-ChildItem -LiteralPath $root -Force)
        if ($items.Count -and -not $registered -and -not $programMarkerValid -and -not $dataMarkerValid) { throw '目标包含无关文件，请新建或选择 Ripple 专用子目录。' }
    }
    foreach ($entry in $incomingFiles.GetEnumerator()) {
        $segments=$entry.Key -split '/'; $part=$root
        for ($index=0; $index -lt $segments.Count; $index++) {
            $part=Join-Path $part $segments[$index]
            if (-not (Test-Path -LiteralPath $part)) { continue }
            $item=Get-Item -LiteralPath $part -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "安装路径包含链接，拒绝覆盖: $($entry.Key)" }
            if ($index -lt ($segments.Count - 1)) { if (-not $item.PSIsContainer) { throw "安装路径被现有文件占用: $($entry.Key)" }; continue }
            if ($item.PSIsContainer) { throw "安装路径被现有目录占用: $($entry.Key)" }
            $actualHash=(Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($entry.Key -eq 'ripple-program-files.json' -and $programMarkerValid) { continue }
            $ownedHash=$null; if ($ownedFiles.ContainsKey($entry.Key)) { $ownedHash=$ownedFiles[$entry.Key] }
            if (($entry.Value -and $actualHash -eq $entry.Value) -or ($ownedHash -and $actualHash -eq $ownedHash)) { continue }
            throw "安装将覆盖独立文件: $($entry.Key)"
        }
    }
    $probe=Join-Path $existing ('.ripple-install-write-'+[Guid]::NewGuid().ToString('N'))
    $stream=[IO.File]::Open($probe,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { $stream.WriteByte(1);$stream.Flush($true) } finally { $stream.Dispose();Remove-Item -LiteralPath $probe }
    exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
