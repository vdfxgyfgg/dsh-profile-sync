@echo off
cd /d "%~dp0"
echo === DSH plugin sync: RESTORE (this folder -> this PC) ===
echo Close DeepSeek Harness completely first (including the tray icon).
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-profile-sync.ps1" -Action restore -FromLocal "%~dp0"
echo.
pause