@echo off
setlocal
echo ============================================================
echo  DSH plugin sync - install plugin on THIS new computer
echo ============================================================
echo.

set "PS=%~dp0install-plugin.ps1"
if exist "%PS%" goto run

set "PS=%TEMP%\dsh-profile-sync-install.ps1"
echo Installer script not found locally, downloading...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest 'https://cdn.jsdelivr.net/gh/vdfxgyfgg/dsh-profile-sync@main/tools/install-plugin.ps1' -OutFile '%PS%' -UseBasicParsing"
if not exist "%PS%" (
  echo.
  echo Download failed: cannot reach cdn.jsdelivr.net
  echo Fix: put install-plugin.ps1 next to this bat file, then run again.
  echo.
  pause
  exit /b 1
)

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%"
echo.
pause