@echo off
cd /d "%~dp0"
echo === Push to GitHub private repo ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-profile-sync.ps1" -Action push
echo.
pause