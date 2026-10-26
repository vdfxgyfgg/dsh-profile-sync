@echo off
cd /d "%~dp0"
echo === Export this PC's DSH setup to F:\A1895\Projects\dsh-backup ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-profile-sync.ps1" -Action push -OutFolder "F:\A1895\Projects\dsh-backup"
echo.
pause