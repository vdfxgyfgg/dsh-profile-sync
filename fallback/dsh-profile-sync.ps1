#requires -Version 5.1
<#
  dsh-profile-sync —— 把本机 DSH 的插件配置搬到另一台电脑

  push    : 导出本机 profile（插件清单 / 每插件配置 / 本地 link 插件 / 记忆 / 抖音数据）到私有 GitHub 仓库
  restore : 在另一台电脑上拉下来，按本机路径重新落到新 profile，并装好依赖

  用法：
    .\dsh-profile-sync.ps1 -Action push
    .\dsh-profile-sync.ps1 -Action restore

  Token 来源优先级：-Token 参数 → $env:DSH_SYNC_TOKEN → $DSH_HOME\sync-token.txt

  设计约定：
  * 仓库只存文本，二进制走 base64 blob
  * 本机绝对路径不进仓库的“生效位置”——restore 时按新机器重算
  * 不动 DSH 源码，只写 profile / DSH_HOME
#>
[CmdletBinding()]
param(
    [ValidateSet('push', 'restore')][string]$Action = 'push',
    [string]$Repo = 'vdfxgyfgg/dsh-profile-backup',
    [string]$Token = '',
    [string]$FromLocal = '',          # restore 时用本地目录代替从 GitHub 下载（自测用）
    [string]$TargetHome = '',         # restore 目标 DSH_HOME（自测用，默认 $HOME\.dsh）
    [string]$OutFolder = '',         # push 时导出到本地文件夹（走 U 盘/网盘，不碰 GitHub）
    [switch]$SkipInstall,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$ProfileName = 'desktop'
$DshHome = if ($TargetHome) { $TargetHome } else { if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
$ProfileDir = Join-Path $DshHome ("profiles\" + $ProfileName)
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ─────────────────────────── 基础工具 ───────────────────────────

function Write-Step([string]$msg) { Write-Host ("`n== " + $msg) -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host ("   [ok] " + $msg) -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host ("   [!]  " + $msg) -ForegroundColor Yellow }
function Write-Err2([string]$msg) { Write-Host ("   [x]  " + $msg) -ForegroundColor Red }

function Read-TextFile([string]$path) {
    # 严格 UTF-8 解码；失败抛异常（调用方据此判定二进制）
    $bytes = [IO.File]::ReadAllBytes($path)
    return $Utf8NoBom.GetString($bytes)
}

function Write-TextFile([string]$path, [string]$text) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}

function Get-Token {
    if ($Token) { return $Token }
    if ($env:DSH_SYNC_TOKEN) { return $env:DSH_SYNC_TOKEN.Trim() }
    $f = Join-Path $DshHome 'sync-token.txt'
    if (Test-Path $f) { return ((Get-Content $f -Raw).Trim()) }
    Write-Host "   [!]  没有 GitHub Token（私有仓库需要它）" -ForegroundColor Yellow
    Write-Host "        GitHub -> Settings -> Developer settings -> Personal access tokens (classic) -> 勾 repo" -ForegroundColor DarkGray
    $t = (Read-Host '把 token 粘进来（直接回车=放弃）').Trim()
    if (-not $t) { throw "没有 token，无法访问私有仓库 $Repo。" }
    New-Item -ItemType Directory -Path $DshHome -Force | Out-Null
    [IO.File]::WriteAllText($f, $t, $Utf8NoBom)
    Write-Ok "token 已保存到 $f（下次不用再输）"
    return $t
}

function Invoke-Api {
    param([string]$Method = 'GET', [string]$Path, $Body)
    $headers = @{
        Authorization          = "token $script:GithubToken"
        Accept                 = 'application/vnd.github+json'
        'User-Agent'           = 'dsh-profile-sync'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $uri = "https://api.github.com$Path"
    $p = @{ Uri = $uri; Method = $Method; Headers = $headers; ErrorAction = 'Stop' }
    if ($PSBoundParameters.ContainsKey('Body') -and $null -ne $Body) {
        $p.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
        $p.ContentType = 'application/json; charset=utf-8'
    }
    return Invoke-RestMethod @p
}

# ─────────────────────────── 路径与清单 ───────────────────────────

function Get-ManifestPaths {
    @{
        package  = Join-Path $ProfileDir 'package.json'
        patch    = Join-Path $ProfileDir 'cordis.patch.yml'
        tree     = Join-Path $ProfileDir 'cordis.yml'
        workspace = Join-Path $ProfileDir 'pnpm-workspace.yaml'
    }
}

function Get-CurrentProfile {
    $paths = Get-ManifestPaths
    if (-not (Test-Path $paths.package)) { throw "不是有效的 profile 目录：$ProfileDir" }
    $pkg = Read-TextFile $paths.package | ConvertFrom-Json
    $links = @()
    foreach ($dep in $pkg.dependencies.PSObject.Properties) {
        if ($dep.Value -like 'link:*') {
            $src = $dep.Value.Substring(5).Trim()
            $src = $src -replace '/', '\'
            if (-not (Test-Path $src)) { Write-Warn2 "link 依赖的源目录不存在：$($dep.Name) -> $src" }
            $folder = ($dep.Name -replace '^@', '' -replace '[\\/]', '-')
            $links += [pscustomobject]@{ dep = $dep.Name; source = $src; folder = $folder }
        }
    }
    [pscustomobject]@{ Package = $pkg; Links = $links }
}

# ─────────────────────────── 导出 ───────────────────────────

$ExcludeDirs = @('node_modules', '__pycache__', '.git', '.venv', 'chrome-profile', '.dsh-market', '.plugin-manager')
$ExcludeDirPatterns = @('_backup-*', 'digest', 'inbox', 'out', 'toast')
$ExcludeFiles = @('*.log', '*.bak', '*.bak-*', '*.tmp', 'pnpm-lock.yaml')

function Test-Excluded([string]$full, [string]$root) {
    $rel = $full.Substring($root.Length).TrimStart('\')
    $parts = $rel -split '\\'
    foreach ($d in $parts[0..([Math]::Max(0, $parts.Count - 2))]) {
        if ($ExcludeDirs -contains $d) { return $true }
        foreach ($pat in $ExcludeDirPatterns) { if ($d -like $pat) { return $true } }
    }
    $name = Split-Path $full -Leaf
    foreach ($pat in $ExcludeFiles) { if ($name -like $pat) { return $true } }
    return $false
}

function Copy-Tree([string]$src, [string]$dst) {
    if (-not (Test-Path $src)) { return 0 }
    $n = 0
    Get-ChildItem $src -Recurse -File -Force | ForEach-Object {
        if (Test-Excluded $_.FullName $src) { return }
        $rel = $_.FullName.Substring($src.Length).TrimStart('\')
        $target = Join-Path $dst $rel
        $dir = Split-Path -Parent $target
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item $_.FullName $target -Force
        $n++
    }
    return $n
}

function Build-Payload([string]$staging) {
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    Write-Step "收集 profile 清单"
    $paths = Get-ManifestPaths
    $prof = Join-Path $staging 'profile'
    New-Item -ItemType Directory -Path $prof -Force | Out-Null
    foreach ($k in 'package', 'patch', 'tree', 'workspace') {
        $f = $paths[$k]
        if (Test-Path $f) { Copy-Item $f (Join-Path $prof (Split-Path $f -Leaf)) -Force; Write-Ok (Split-Path $f -Leaf) }
    }

    $cur = Get-CurrentProfile

    Write-Step "收集本地 link 插件（$(($cur.Links | Measure-Object).Count) 个）"
    $linkInfo = @()
    foreach ($l in $cur.Links) {
        $dst = Join-Path (Join-Path $staging 'plugins') $l.folder
        $n = Copy-Tree $l.source $dst
        Write-Ok ("{0}  ({1} 个文件) <- {2}" -f $l.dep, $n, $l.source)
        $linkInfo += [pscustomobject]@{ dep = $l.dep; folder = $l.folder; files = $n; source = $l.source }
    }

    Write-Step "收集记忆"
    $memSrc = Join-Path $DshHome 'memories'
    $n = Copy-Tree $memSrc (Join-Path $staging 'memories')
    Write-Ok "memories: $n 个文件"

    Write-Step "收集抖音数据"
    $dyState = Join-Path $DshHome 'douyin-duty'
    $dyMemSrc = Join-Path $dyState 'memory'
    $cfgFile = Join-Path $dyState 'config.json'
    if (Test-Path $cfgFile) {
        try {
            $cfg = Read-TextFile $cfgFile | ConvertFrom-Json
            if ($cfg.memoryDir -and (Test-Path $cfg.memoryDir)) { $dyMemSrc = $cfg.memoryDir }
        } catch {}
    }
    $n = Copy-Tree $dyMemSrc (Join-Path $staging 'douyin-memory')
    Write-Ok "抖音聊天记忆: $n 个文件  <- $dyMemSrc"

    $keep = @('config.json', 'account.json', 'douyin_cookie.txt', 'chat-watch.json', 'seen.md',
              'kw_rotation.json', 'forward-pick.json', 'collector.json', 'charter.sha256', 'notice.json')
    $dst = Join-Path $staging 'douyin-state'
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    $kept = 0
    foreach ($k in $keep) {
        $f = Join-Path $dyState $k
        if (Test-Path $f) { Copy-Item $f (Join-Path $dst $k) -Force; $kept++ }
    }
    Write-Ok "抖音状态文件: $kept 个（cookie / 账号 / 人设 / 已看记录）"

    $manifest = [pscustomobject]@{
        createdAt = (Get-Date).ToString('o')
        source    = [pscustomobject]@{ machine = $env:COMPUTERNAME; user = $env:USERNAME; dshHome = $DshHome; profile = $ProfileName }
        links     = $linkInfo
        note      = 'restore 时会按目标机器的 DSH_HOME 重写 link: 路径与 douyin 配置里的三处绝对路径'
    }
    Copy-Item $PSCommandPath (Join-Path $staging 'dsh-profile-sync.ps1') -Force
    $readme = Join-Path (Split-Path -Parent $PSCommandPath) 'README.md'
    if (Test-Path $readme) { Copy-Item $readme (Join-Path $staging 'README.md') -Force }
    Write-TextFile (Join-Path $staging 'manifest.json') ($manifest | ConvertTo-Json -Depth 10)

    $files = @(Get-ChildItem $staging -Recurse -File -Force)
    Write-Ok ("payload 共 {0} 个文件 / {1:N0} KB" -f $files.Count, (($files | Measure-Object Length -Sum).Sum / 1KB))
    return $files
}

# ─────────────────────────── 推送 ───────────────────────────

function Push-Payload([string]$staging) {
    Write-Step "连接 GitHub: $Repo"
    $parts = $Repo -split '/'
    $owner = $parts[0]; $name = $parts[1]

    $exists = $true
    try { Invoke-Api -Path "/repos/$Repo" | Out-Null } catch { $exists = $false }

    if (-not $exists) {
        Write-Warn2 "仓库不存在，尝试创建私有仓库 $name"
        try {
            Invoke-Api -Method POST -Path '/user/repos' -Body @{ name = $name; private = $true; description = 'DSH profile sync (plugins + config + memory)' } | Out-Null
            Write-Ok "已创建私有仓库 $Repo"
        } catch {
            throw "创建仓库失败：$($_.Exception.Message)`n请先手动在 GitHub 建一个私有空仓库 $Repo，再重跑。"
        }
    }

    if ($DryRun) { Write-Warn2 'DryRun：跳过上传'; return }

    $ref = $null
    $parent = $null
    try {
        $ref = Invoke-Api -Path "/repos/$Repo/git/ref/heads/main"
        $parent = $ref.object.sha
    } catch {
        Write-Warn2 '仓库还没有 main 分支，将创建首个提交'
    }

    Write-Step "上传 $((Get-ChildItem $staging -Recurse -File -Force).Count) 个文件（先建 blob）"
    $entries = @()
    $i = 0
    $all = Get-ChildItem $staging -Recurse -File -Force
    foreach ($f in $all) {
        $i++
        $rel = $f.FullName.Substring($staging.Length).TrimStart('\') -replace '\\', '/'
        $bytes = [IO.File]::ReadAllBytes($f.FullName)
        $isText = $true
        try { [void]$Utf8NoBom.GetString($bytes) } catch { $isText = $false }
        if ($isText) {
            $entries += @{ path = $rel; mode = '100644'; type = 'blob'; content = $Utf8NoBom.GetString($bytes) }
        } else {
            $blob = Invoke-Api -Method POST -Path "/repos/$Repo/git/blobs" -Body @{ content = [Convert]::ToBase64String($bytes); encoding = 'base64' }
            $entries += @{ path = $rel; mode = '100644'; type = 'blob'; sha = $blob.sha }
        }
        if ($i % 10 -eq 0) { Write-Host ("   ... {0}/{1}" -f $i, $all.Count) -ForegroundColor DarkGray }
    }

    Write-Step "创建 tree / commit / 更新 main"
    $tree = Invoke-Api -Method POST -Path "/repos/$Repo/git/trees" -Body @{ tree = $entries }
    $commitBody = @{ message = "sync from $($env:COMPUTERNAME) $Stamp"; tree = $tree.sha }
    if ($parent) { $commitBody.parents = @($parent) }
    $commit = Invoke-Api -Method POST -Path "/repos/$Repo/git/commits" -Body $commitBody

    if ($parent) {
        Invoke-Api -Method PATCH -Path "/repos/$Repo/git/refs/heads/main" -Body @{ sha = $commit.sha; force = $false } | Out-Null
    } else {
        try { Invoke-Api -Method POST -Path "/repos/$Repo/git/refs" -Body @{ ref = 'refs/heads/main'; sha = $commit.sha } | Out-Null }
        catch { Invoke-Api -Method PATCH -Path "/repos/$Repo/git/refs/heads/main" -Body @{ sha = $commit.sha } | Out-Null }
    }

    Write-Ok "已推送 commit $($commit.sha.Substring(0,7)) → https://github.com/$Repo"
}

# ─────────────────────────── 恢复 ───────────────────────────

function Set-YamlPath([string]$file, [string]$key, [string]$value) {
    if (-not (Test-Path $file)) { return $false }
    $text = Read-TextFile $file
    $rx = [regex]("(?m)^(\s*" + [regex]::Escape($key) + ":\s*).*$")
    if (-not $rx.IsMatch($text)) { return $false }
    $new = $rx.Replace($text, { param($m) $m.Groups[1].Value + $value }, 1)
    Write-TextFile $file $new
    return $true
}

function Set-JsonPath([string]$file, [string]$key, [string]$value) {
    if (-not (Test-Path $file)) { return $false }
    $text = Read-TextFile $file
    $rx = [regex]('("' + [regex]::Escape($key) + '"\s*:\s*)"(?:[^"\\]|\\.)*"')
    if (-not $rx.IsMatch($text)) { return $false }
    $esc = $value.Replace('\', '\\')
    $new = $rx.Replace($text, { param($m) $m.Groups[1].Value + '"' + $esc + '"' }, 1)
    Write-TextFile $file $new
    return $true
}

function Get-DshRoot {
    if ($env:DSH_SYNC_DSH_ROOT -and (Test-Path $env:DSH_SYNC_DSH_ROOT)) { return $env:DSH_SYNC_DSH_ROOT }
    $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' -and $_.Path } | Select-Object -First 1
    if ($proc) { return (Split-Path -Parent $proc.Path) }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
        (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path (Join-Path $c 'DeepSeek Harness.exe'))) { return $c } }
    return $null
}

function Invoke-PluginInstall {
    if ($SkipInstall) { Write-Warn2 'SkipInstall：跳过 pnpm 安装'; return $false }
    $root = Get-DshRoot
    if (-not $root) { Write-Warn2 '找不到 DSH 安装目录，跳过自动安装'; return $false }
    $cli = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
    if (-not (Test-Path $cli)) { Write-Warn2 "找不到 CLI：$cli"; return $false }
    Write-Step "安装插件依赖（dsh plugin --profile $ProfileName install）"
    Write-Host "   CLI: $cli" -ForegroundColor DarkGray
    if ($TargetHome) { $env:DSH_HOME = $TargetHome }
    $out = & $cli plugin --profile $ProfileName install 2>&1
    $out | Select-Object -Last 25 | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "安装返回码 $LASTEXITCODE，请看上面的输出"; return $false }
    Write-Ok '依赖安装完成'
    return $true
}

function Restore-Payload([string]$src) {
    $manifest = $null
    $mf = Join-Path $src 'manifest.json'
    if (Test-Path $mf) { $manifest = Read-TextFile $mf | ConvertFrom-Json }
    if ($manifest) { Write-Ok ("备份来自 {0} @ {1}" -f $manifest.source.machine, $manifest.createdAt) }

    if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null }

    Write-Step '写入 profile 配置'
    $bak = $ProfileDir + '.bak-' + $Stamp
    $paths = Get-ManifestPaths
    foreach ($k in @('package', 'patch', 'tree', 'workspace')) {
        $f = $paths[$k]
        if (Test-Path $f) {
            if (-not (Test-Path $bak)) { New-Item -ItemType Directory -Path $bak -Force | Out-Null }
            Copy-Item $f (Join-Path $bak (Split-Path $f -Leaf)) -Force
        }
    }
    Write-Ok "旧配置已备份到 $bak"

    $profSrc = Join-Path $src 'profile'
    Get-ChildItem $profSrc -File -Force | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $ProfileDir $_.Name) -Force
        Write-Ok $_.Name
    }

    Write-Step '落地本地 link 插件'
    $vendorRoot = Join-Path $ProfileDir 'vendor'
    $vendorPaths = @{}
    foreach ($l in $manifest.links) {
        $dst = Join-Path $vendorRoot $l.folder
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
        $n = Copy-Tree (Join-Path (Join-Path $src 'plugins') $l.folder) $dst
        $vendorPaths[$l.dep] = $dst
        Write-Ok ("{0}  ({1} 个文件)" -f $l.dep, $n)
    }

    Write-Step '重写 package.json 里的 link: 路径'
    $pkgFile = $paths.package
    $pkgText = Read-TextFile $pkgFile
    foreach ($l in $manifest.links) {
        $p = $vendorPaths[$l.dep] -replace '\\', '/'
        $rx = [regex]('("' + [regex]::Escape($l.dep) + '"\s*:\s*)"link:[^"]*"')
        if ($rx.IsMatch($pkgText)) { $pkgText = $rx.Replace($pkgText, { param($m) $m.Groups[1].Value + '"link:' + $p + '"' }, 1) }
        Write-Ok ("{0} -> link:{1}" -f $l.dep, $p)
    }
    Write-TextFile $pkgFile $pkgText

    Write-Step '重写 douyin 三处本机绝对路径'
    $pyPath = Join-Path $DshHome 'douyin-duty\.venv\Scripts\python.exe'
    $dshBin = Join-Path $vendorRoot 'dsh-douyin-scroll\bin\dsh-electron-shim.cjs'
    $memDir = Join-Path $DshHome 'douyin-memory'
    foreach ($pair in @(@('pythonPath', $pyPath), @('dshBin', $dshBin), @('memoryDir', $memDir))) {
        $hit = Set-YamlPath $paths.patch $pair[0] $pair[1]
        Write-Ok ("cordis.patch.yml  {0} -> {1}{2}" -f $pair[0], $pair[1], $(if ($hit) { '' } else { '  (未出现，跳过)' }))
    }

    Write-Step '落地记忆'
    $memDst = Join-Path $DshHome 'memories'
    if (Test-Path $memDst) { Copy-Item $memDst ($memDst + '.bak-' + $Stamp) -Recurse -Force -ErrorAction SilentlyContinue }
    $n = Copy-Tree (Join-Path $src 'memories') $memDst
    Write-Ok "memories: $n 个文件"

    Write-Step '落地抖音数据'
    $n = Copy-Tree (Join-Path $src 'douyin-memory') $memDir
    Write-Ok "聊天记忆: $n 个文件 -> $memDir"
    $dyState = Join-Path $DshHome 'douyin-duty'
    $n = Copy-Tree (Join-Path $src 'douyin-state') $dyState
    Write-Ok "状态文件: $n 个"
    $cfgFile = Join-Path $dyState 'config.json'
    if (Test-Path $cfgFile) {
        foreach ($pair in @(@('pythonPath', $pyPath), @('dshBin', $dshBin), @('memoryDir', $memDir))) {
            [void](Set-JsonPath $cfgFile $pair[0] $pair[1])
        }
        Write-Ok 'douyin config.json 里的三处路径已改写'
    }

    Write-Step '设置 DOUYIN_DATA_DIR（插件里写死了 F 盘默认值）'
    $dataDir = Join-Path $DshHome 'douyin-duty-data'
    if (-not $DryRun) {
        [Environment]::SetEnvironmentVariable('DOUYIN_DATA_DIR', $dataDir, 'User')
        $env:DOUYIN_DATA_DIR = $dataDir
    }
    Write-Ok $dataDir

    [void](Invoke-PluginInstall)
}

# ─────────────────────────── 主流程 ───────────────────────────

try {
    if ($Action -eq 'push' -and $OutFolder) {
        $keep = @('profile', 'plugins', 'memories', 'douyin-memory', 'douyin-state', 'manifest.json', 'dsh-profile-sync.ps1', 'README.md', '2-restore-newpc.bat')
        if (Test-Path $OutFolder) {
            $extra = Get-ChildItem $OutFolder -Force | Where-Object { $keep -notcontains $_.Name }
            if ($extra) { throw "导出目录 $OutFolder 里还有别的东西（$(($extra.Name) -join ', ')），拒绝清空。请换一个空目录。" }
        }
        Write-Step "导出到本地文件夹 $OutFolder"
        [void](Build-Payload $OutFolder)
        $selfDir = Split-Path -Parent $PSCommandPath
        foreach ($x in @('dsh-profile-sync.ps1', '2-restore-newpc.bat')) {
            $src2 = Join-Path $selfDir $x
            if (Test-Path $src2) { Copy-Item $src2 (Join-Path $OutFolder $x) -Force }
        }
        Write-Ok "已导出：$OutFolder"
        Write-Host "`n把这个文件夹整个拷到新电脑，双击里面的 2-restore-newpc.bat 即可。" -ForegroundColor Green
    }
    elseif ($Action -eq 'push') {
        if ($DryRun) { $script:GithubToken = 'dry-run' } else { $script:GithubToken = Get-Token }
        $staging = Join-Path $env:TEMP ('dsh-sync-push-' + $Stamp)
        [void](Build-Payload $staging)
        if (-not $DryRun) { Push-Payload $staging }
        Write-Host "`n完成。payload 留存于 $staging（可删）" -ForegroundColor Green
    }
    else {
        $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' }
        if ($running -and -not $FromLocal) {
            Write-Err2 'DSH 正在运行。请先完全退出 DSH（含托盘图标），再重跑 restore。'
            exit 1
        }

        if ($FromLocal) {
            $src = $FromLocal
            Write-Warn2 "使用本地 payload：$src"
        } else {
            $script:GithubToken = Get-Token
            Write-Step "下载 $Repo"
            $tmp = Join-Path $env:TEMP ('dsh-sync-restore-' + $Stamp)
            New-Item -ItemType Directory -Path $tmp -Force | Out-Null
            $zip = Join-Path $tmp 'payload.zip'
            $headers = @{ Authorization = "token $script:GithubToken"; 'User-Agent' = 'dsh-profile-sync' }
            Invoke-WebRequest -Uri "https://api.github.com/repos/$Repo/zipball/main" -Headers $headers -OutFile $zip -UseBasicParsing
            Expand-Archive $zip -DestinationPath (Join-Path $tmp 'x') -Force
            $src = (Get-ChildItem (Join-Path $tmp 'x') -Directory | Select-Object -First 1).FullName
            Write-Ok "已解压到 $src"
        }

        Restore-Payload $src

        Write-Host "`n完成。" -ForegroundColor Green
        Write-Host "接下来：" -ForegroundColor Yellow
        Write-Host "  1) 启动 DSH（可能需要重启一次让 DOUYIN_DATA_DIR 生效）" -ForegroundColor Yellow
        Write-Host "  2) 打开抖音插件面板，点「装运行环境」重建 python venv" -ForegroundColor Yellow
        Write-Host "  3) 抖音记忆/配置如果没生效，在面板里重新保存一次" -ForegroundColor Yellow
    }
}
catch {
    Write-Err2 $_.Exception.Message
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
    exit 1
}
