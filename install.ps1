# Sovereign Windows x64 Installer for b8g-production-rack
# Usage: irm https://b8g.app/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$BaseUrl = if ($env:B8G_BASE_URL) { $env:B8G_BASE_URL.TrimEnd('/') } else { 'https://github.com/awesome-os/b8g-production-rack/releases/download/v0.2.0' }
$InstallDir = if ($env:B8G_INSTALL_DIR) { $env:B8G_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'b8g-rack' }
$ZipName = 'b8g-production-rack-win64.zip'
$ZipUrl = "$BaseUrl/$ZipName"
$TempZip = Join-Path $env:TEMP $ZipName

Write-Host "[b8g-rack] Installing self-contained Windows x64 b8g-production-rack -> $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Invoke-WebRequest -Uri $ZipUrl -OutFile $TempZip -UseBasicParsing
Expand-Archive -Path $TempZip -DestinationPath $InstallDir -Force
Remove-Item -Force $TempZip -ErrorAction SilentlyContinue

Write-Host "[b8g-rack] Installed successfully!" -ForegroundColor Green
Write-Host "  Verify shim: & `"$InstallDir\b8g-shim.exe`" --version"
Write-Host "  Run JS (4ms): & `"$InstallDir\sectium-es.exe`" -e `"console.log('b8g-rack ready')`""
Write-Host "  Run JVM (4ms): & `"$InstallDir\sectium-jvm.exe`" --version"
Write-Host "  30-day renewable evaluation lease included (zero lock-in; read-only export always open)."
