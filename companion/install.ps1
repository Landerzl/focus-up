# Registers the Focus Up native messaging host for Brave (and Chrome, harmlessly).
# Per-user only: writes HKCU registry keys and two files in this folder. No admin needed.
#   powershell -ExecutionPolicy Bypass -File companion\install.ps1
#   add -StartWithWindows to also open the desktop app when you sign in to Windows
param(
    [string]$ExtensionId = (Get-Content (Join-Path $PSScriptRoot 'extension-id.txt') -Raw).Trim(),
    [switch]$StartWithWindows
)
$ErrorActionPreference = 'Stop'
$HostName = 'com.focusup.host'
$dir = $PSScriptRoot

# 1. Find a real Python (not the Microsoft Store stub).
$python = $null
try { $python = (& py -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1) } catch {}
if (-not $python -or -not (Test-Path $python)) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notlike '*WindowsApps*') { $python = $cmd.Source }
}
if (-not $python -or -not (Test-Path $python)) {
    throw 'Python 3 was not found. Install it from python.org, then run this again.'
}
Write-Host "Using Python: $python"

# 2. host.bat launches host.py with that Python. Browsers can only start an .exe/.bat.
$hostPy = Join-Path $dir 'host.py'
$bat = Join-Path $dir 'host.bat'
[IO.File]::WriteAllText($bat, "@echo off`r`n`"$python`" `"$hostPy`" %*`r`n", [Text.Encoding]::ASCII)

# 3. The native messaging manifest. allowed_origins pins it to this one extension ID.
$manifestPath = Join-Path $dir "$HostName.json"
$manifest = [ordered]@{
    name            = $HostName
    description     = 'Focus Up companion: notifications and distracting apps'
    path            = $bat
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
# UTF-8 without BOM, which is what browsers expect.
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

# 4. Tell the browsers where the manifest is.
foreach ($root in 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts', 'HKCU:\Software\Google\Chrome\NativeMessagingHosts') {
    New-Item -Path "$root\$HostName" -Value $manifestPath -Force | Out-Null
    Write-Host "Registered: $root\$HostName"
}

# 5. Desktop app shortcuts (Start menu + Desktop). pythonw = no console window.
$appDir = Join-Path (Split-Path $dir -Parent) 'app'
$pythonw = Join-Path (Split-Path $python -Parent) 'pythonw.exe'
if (-not (Test-Path $pythonw)) { $pythonw = $python }
$shell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Focus Up.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Focus Up.lnk'
$targets = @($startMenu, $desktop)
if ($StartWithWindows) { $targets += (Join-Path ([Environment]::GetFolderPath('Startup')) 'Focus Up.lnk') }
foreach ($path in $targets) {
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = "`"$(Join-Path $appDir 'focusup_app.py')`""
    $lnk.WorkingDirectory = $appDir
    $lnk.IconLocation = (Join-Path $appDir 'focusup.ico')
    $lnk.Description = 'Focus Up'
    $lnk.Save()
    Write-Host "Shortcut: $path"
}

# 6. Self-check: run the host and ask for its status (this does not change any setting).
$status = & $bat --status
Write-Host "Host says: $status"
Write-Host ''
Write-Host "Done. Extension ID allowed: $ExtensionId"
Write-Host 'Now reload Focus Up in brave://extensions (its ID must match the one above).'
