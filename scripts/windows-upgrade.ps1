param(
    [Parameter(Mandatory=$true)][ValidateSet('Protect','Restore')][string]$Action,
    [Parameter(Mandatory=$true)][string]$InstallationDirectory,
    [Parameter(Mandatory=$true)][string]$TransactionDirectory,
    [string]$LegacyManifest
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallationDirectory).TrimEnd('\')
$transaction=[IO.Path]::GetFullPath($TransactionDirectory).TrimEnd('\')
if ($transaction.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Upgrade protection must be outside the directory the old uninstaller deletes.' }
$recoveryKey='HKCU:\Software\Ripple\UpgradeRecovery'
function Write-ProtectionRecord($Record) {
    $journal=Join-Path $transaction 'ripple-protected-files.json'
    $temporary=$journal+'.writing'
    try {
        $Record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $journal -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
try {
    if ($Action -eq 'Protect') {
        if (Test-Path -LiteralPath $transaction) {
            & $PSCommandPath -Action Restore -InstallationDirectory $root -TransactionDirectory $transaction
            if ($LASTEXITCODE -ne 0) { throw 'Previous upgrade content must be recovered before retrying.' }
        }
        $manifestPath=Join-Path $root 'ripple-program-files.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) { $manifestPath=$LegacyManifest }
        if (-not $manifestPath -or -not (Test-Path -LiteralPath $manifestPath)) { throw 'A trusted ownership manifest is required before legacy upgrade.' }
        $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($directory in Get-ChildItem -LiteralPath $root -Directory -Recurse -Force) {
            if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked directories are not supported during upgrade.' }
        }
        New-Item -ItemType Directory -Path $transaction | Out-Null
        Write-ProtectionRecord @{}
        New-Item -Path $recoveryKey -Force | Out-Null
        Set-ItemProperty -Path $recoveryKey -Name InstallationDirectory -Value $root
        $protected=@{}
        foreach ($file in Get-ChildItem -LiteralPath $root -File -Recurse -Force) {
            if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked files are not supported during upgrade.' }
            $relative=$file.FullName.Substring($root.Length+1).Replace('\','/')
            $hash=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            $owned=$manifest.files.PSObject.Properties[$relative]
            if ($owned -and $owned.Value -eq $hash) { continue }
            if ($relative -eq 'ripple-program-files.json') { continue }
            $target=Join-Path (Join-Path $transaction 'files') $relative
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
            $protected[$relative]=$hash
            Write-ProtectionRecord $protected
            [IO.File]::Copy($file.FullName,$target,$false)
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Upgrade backup verification failed.' }
        }
        Write-ProtectionRecord $protected
    } else {
        if (-not (Test-Path -LiteralPath (Join-Path $transaction 'ripple-protected-files.json'))) {
            if (@(Get-ChildItem -LiteralPath $transaction -Force).Count) { throw 'Missing upgrade recovery record; refusing cleanup.' }
            Remove-Item -LiteralPath $transaction
            if ((Get-ItemProperty -Path $recoveryKey -Name InstallationDirectory -ErrorAction SilentlyContinue).InstallationDirectory -eq $root) {
                Remove-ItemProperty -Path $recoveryKey -Name InstallationDirectory
            }
            exit 0
        }
        $record=Get-Content -LiteralPath (Join-Path $transaction 'ripple-protected-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $known=@('ripple-protected-files.json','ripple-protected-files.json.writing') + @($record.PSObject.Properties.Name | ForEach-Object { 'files/'+$_ })
        foreach ($file in Get-ChildItem -LiteralPath $transaction -File -Recurse -Force) {
            $relative=$file.FullName.Substring($transaction.Length+1).Replace('\','/')
            if ($relative -notin $known) { throw 'Unknown upgrade transaction file; refusing cleanup.' }
        }
        foreach ($item in $record.PSObject.Properties) {
            if ([IO.Path]::IsPathRooted($item.Name) -or ($item.Name -split '/') -contains '..') { throw 'Invalid protected-file path.' }
            $source=Join-Path (Join-Path $transaction 'files') $item.Name
            $target=Join-Path $root $item.Name
            $sourceValid=(Test-Path -LiteralPath $source -PathType Leaf) -and ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -eq $item.Value)
            if (Test-Path -LiteralPath $target) {
                if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.Value) { throw "Upgrade would overwrite independent content: $($item.Name)" }
            } else {
                if (-not $sourceValid) { throw 'Protected upgrade content is damaged and no intact original remains.' }
                New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
                $temporary=$target+'.ripple-restore-'+[Guid]::NewGuid().ToString('N')
                try {
                    [IO.File]::Copy($source,$temporary,$false)
                    if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.Value) { throw 'Upgrade restore verification failed.' }
                    [IO.File]::Move($temporary,$target)
                } finally {
                    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
                }
            }
        }
        foreach ($item in $record.PSObject.Properties) {
            $file=Join-Path (Join-Path $transaction 'files') $item.Name
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
        }
        $temporary=Join-Path $transaction 'ripple-protected-files.json.writing'
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        foreach ($directory in Get-ChildItem -LiteralPath $transaction -Directory -Recurse -Force | Sort-Object FullName -Descending) {
            if (@(Get-ChildItem -LiteralPath $directory.FullName -Force).Count -eq 0) { Remove-Item -LiteralPath $directory.FullName }
        }
        Remove-Item -LiteralPath (Join-Path $transaction 'ripple-protected-files.json') -Force
        Remove-Item -LiteralPath $transaction
        if ((Get-ItemProperty -Path $recoveryKey -Name InstallationDirectory -ErrorAction SilentlyContinue).InstallationDirectory -eq $root) {
            Remove-ItemProperty -Path $recoveryKey -Name InstallationDirectory
        }
    }
    exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
