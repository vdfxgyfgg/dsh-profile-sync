@echo off
chcp 65001 >nul
setlocal
echo ============================================================
echo  DSH 插件一键同步 - 在新电脑上安装插件
echo  （不需要 git，也不需要会用命令行）
echo ============================================================
echo.
set "PS=%TEMP%\dsh-profile-sync-install.ps1"
echo 正在下载安装脚本…
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest 'https://cdn.jsdelivr.net/gh/vdfxgyfgg/dsh-profile-sync@main/tools/install-plugin.ps1' -OutFile '%PS%' -UseBasicParsing"
if not exist "%PS%" (
  echo.
  echo 下载失败：连不上 cdn.jsdelivr.net。
  echo 换个网络再试，或者把这个窗口截图发给我。
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%"
echo.
pause
