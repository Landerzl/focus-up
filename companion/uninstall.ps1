# Undoes install.ps1 and makes sure Windows notifications are back as they were.
$ErrorActionPreference = 'Stop'
$HostName = 'com.focusup.host'
$dir = $PSScriptRoot

$bat = Join-Path $dir 'host.bat'
if (Test-Path $bat) {
    Write-Host ("Notifications: " + (& $bat --restore))
}
foreach ($root in 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts', 'HKCU:\Software\Google\Chrome\NativeMessagingHosts') {
    if (Test-Path "$root\$HostName") { Remove-Item "$root\$HostName" -Force; Write-Host "Removed: $root\$HostName" }
}
foreach ($lnk in (Join-Path ([Environment]::GetFolderPath('Programs')) 'Focus Up.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Focus Up.lnk'), (Join-Path ([Environment]::GetFolderPath('Startup')) 'Focus Up.lnk')) {
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed: $lnk" }
}
Remove-Item $bat, (Join-Path $dir "$HostName.json") -Force -ErrorAction SilentlyContinue
Write-Host 'Uninstalled. (Session history lives in the browser and is not touched.)'
