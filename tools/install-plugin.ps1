# ============================================================================
# 在新电脑上安装 dsh-profile-sync 插件（不需要 git，也不需要 dsh 在 PATH 里）
# 由 install-plugin.bat 调用；也可以直接：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-plugin.ps1
# ============================================================================
param(
  [string]$Url = 'https://cdn.jsdelivr.net/gh/vdfxgyfgg/dsh-profile-sync@main/dist/dsh-profile-sync.tgz',
  [string]$Profile = 'desktop',
  [string]$DshRoot = ''
)

$ErrorActionPreference = 'Stop'

function Test-DshRoot([string]$p) {
  if (-not $p) { return $false }
  return (Test-Path (Join-Path $p 'resources\runtime\cli\bin\dsh.cmd'))
}

function Find-DshRoot {
  if ($DshRoot -and (Test-DshRoot $DshRoot)) { return $DshRoot }

  # 1) 注册表的卸载项（正常安装的机器上最可靠）
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    foreach ($e in (Get-ItemProperty $k -ErrorAction SilentlyContinue)) {
      if ($e.DisplayName -match 'DeepSeek|Harness' -and $e.InstallLocation -and (Test-DshRoot $e.InstallLocation)) {
        return $e.InstallLocation
      }
    }
  }

  # 2) 常见安装目录
  $cands = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    'F:\deekseep', 'C:\deekseep', 'D:\deekseep', 'E:\deekseep'
  )
  foreach ($c in $cands) { if (Test-DshRoot $c) { return $c } }

  # 3) 各固定磁盘根下的常见目录名
  foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    foreach ($n in 'deekseep', 'DeepSeek Harness', 'DSH') {
      $p = Join-Path $d.Root $n
      if (Test-DshRoot $p) { return $p }
    }
  }
  return ''
}

$root = Find-DshRoot
if (-not $root) {
  Write-Host ''
  Write-Host '找不到 DeepSeek Harness 的安装目录。' -ForegroundColor Red
  Write-Host '请先在“设置 → 应用”里确认 DSH 已装好；仍不行就把这个脚本的路径告诉我。'
  exit 1
}

$cli = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
Write-Host "DSH 安装在： $root"
Write-Host "profile： $Profile"
Write-Host ''
Write-Host '开始安装插件（第一次要下载，约 10~60 秒）…'
Write-Host ''

& $cli plugin --profile $Profile add $Url 2>&1 | ForEach-Object { Write-Host $_ }
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ''
  Write-Host "安装失败（退出码 $code）。把上面几行贴给我看。" -ForegroundColor Red
  exit $code
}

# 校验：profile 清单里有没有这个包
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$pkgPath = Join-Path $dshHome "profiles\$Profile\package.json"
if (Test-Path $pkgPath) {
  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $hasDep = $null -ne $pkg.dependencies.'dsh-profile-sync'
  $hasBundle = @($pkg.dsh.profile.bundles) -contains 'dsh-profile-sync'
  if (-not $hasBundle) {
    Write-Host '清单里没有把插件加进 bundles，正在补…' -ForegroundColor Yellow
    & $cli plugin --profile $Profile add 'dsh-profile-sync' 2>&1 | ForEach-Object { Write-Host $_ }
  }
  Write-Host ''
  Write-Host ("依赖已登记：{0}" -f $hasDep) -ForegroundColor Green
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' 装好了。接下来：' -ForegroundColor Green
Write-Host ' 1) 关掉 DSH 窗口，重新打开（必须重启才会加载插件）' -ForegroundColor Green
Write-Host ' 2) 左侧进 设置 → 插件同步' -ForegroundColor Green
Write-Host ' 3) 填仓库 vdfxgyfgg/dsh-profile-backup + 一个新建的 token' -ForegroundColor Green
Write-Host ' 4) 点「从仓库拉取并部署」，完了再重启一次 DSH' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
