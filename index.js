/**
 * dsh-profile-sync —— host 半端
 * ============================================================================
 * 干什么：把这台机器的「插件清单 + 插件配置 + 记忆」打包上传到你自己的私有仓库；
 *         换一台新电脑装上本插件，点一下就从那个仓库全部拉取并部署好。
 *
 * 仓库里放什么（payload 结构）：
 *   profile/          package.json / cordis.patch.yml / cordis.yml / pnpm-workspace.yaml
 *   plugins/<名>/     本地 link: 依赖的插件源码（整包，跳过 node_modules）
 *   memories/         $DSH_HOME/memories 全量
 *   douyin-state/     抖音插件的运行配置与登录态（白名单文件）
 *   douyin-memory/    抖音聊天记忆目录
 *   manifest.json     清单（profile 名、依赖表、来源机器、生成时间）
 *
 * 为什么不用 git：用户机器上可能没装 git。这里全部走 GitHub REST API
 * （git/trees → git/commits → 更新 refs/heads/main），一次上传只有 3 个请求。
 *
 * 为什么不用 dshmarket 自带的「备份与恢复」：它只导配置，对 link: 本地依赖
 * 只告警不搬运，换机必缺那两个插件；而且它没有「把绝对路径改写成新机路径」。
 * ============================================================================
 */
import { execFile } from 'node:child_process'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'profile-sync'
export const inject = ['webServer']

const VERSION = '0.1.0'
const DEFAULT_REPO = 'vdfxgyfgg/dsh-profile-backup'
/* 本插件自己的安装源：用 tarball 地址而不是 github: —— pnpm 解析 github: 要靠 git，
 * 而新电脑往往没装 git。走 jsDelivr（它镜像同一仓库文件；裸 github raw 在国内实测 23s 起） */
const SELF_SPEC = 'https://cdn.jsdelivr.net/gh/vdfxgyfgg/dsh-profile-sync@main/dist/dsh-profile-sync.tgz'
const API = 'https://api.github.com'

/** github:owner/repo#ref → codeload tarball（纯 HTTPS，不需要装 git） */
function gitFreeSpec(spec) {
  const m = /^github:([^#\s]+)(?:#(\S+))?$/.exec(spec)
  if (!m) return spec
  return `https://codeload.github.com/${m[1]}/tar.gz/${m[2] || 'main'}`
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'profile-sync')
const CONFIG_FILE = join(STATE_DIR, 'config.json')
const LOG_FILE = join(STATE_DIR, 'sync.log')

/* 打包时永远跳过的目录（体积大 / 可重建） */
const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.venv', 'chrome-profile',
  '.dsh-market', '.plugin-manager', '.cache',
])
const SKIP_DIR_PATTERNS = [/^_backup-/, /^digest$/, /^inbox$/, /^out$/, /^toast$/, /^\.venv/]
/* 抖音插件运行目录里真正值得带走的文件（白名单，比黑名单安全） */
const DOUYIN_STATE_FILES = [
  'config.json', 'account.json', 'douyin_cookie.txt', 'chat-watch.json',
  'seen.md', 'kw_rotation.json', 'forward-pick.json', 'collector.json',
  'charter.sha256', 'notice.json',
]
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']

/* ── 小工具 ───────────────────────────────────────────────────────────── */
const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return dflt } }
const readText = (p) => readFileSync(p, 'utf8')
const isDir = (p) => { try { return readdirSync(p) !== null } catch { return false } }
const isFile = (p) => { try { readFileSync(p); return true } catch { return false } }
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const folderOf = (dep) => dep.replace(/^@/, '').replace(/\//g, '-')   // @dsh-pet/bridge → dsh-pet-bridge
const fwd = (p) => p.replace(/\\/g, '/')

function writeText(p, s) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, s, 'utf8')
}
function writeJson(p, v) {
  writeText(p, JSON.stringify(v, null, 2) + '\n')
}

function loadConfig() {
  const c = readJson(CONFIG_FILE, {})
  /* token 优先用面板里存的；没有就读 DSH 家目录下的 sync-token.txt（省得粘贴，也不进浏览器） */
  let token = typeof c.token === 'string' ? c.token : ''
  if (!token) {
    try { token = readText(join(DSH_HOME, 'sync-token.txt')).trim() } catch { /* 没有就算了 */ }
  }
  return {
    repo: typeof c.repo === 'string' && c.repo ? c.repo : DEFAULT_REPO,
    token,
    profile: typeof c.profile === 'string' && c.profile ? c.profile : '',
    lastUploadAt: c.lastUploadAt || null,
    lastRestoreAt: c.lastRestoreAt || null,
  }
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  writeJson(CONFIG_FILE, next)
  return next
}

/* ── profile 定位 ─────────────────────────────────────────────────────── */
function profilesRoot() { return join(DSH_HOME, 'profiles') }

function detectProfile(cfg) {
  if (cfg.profile && isDir(join(profilesRoot(), cfg.profile))) return cfg.profile
  // 桌面版就是 desktop；web/headless 是别的形态
  for (const n of ['desktop', 'web', 'headless']) {
    if (isDir(join(profilesRoot(), n))) return n
  }
  const dirs = (() => { try { return readdirSync(profilesRoot()) } catch { return [] } })()
    .filter((n) => isDir(join(profilesRoot(), n)))
  if (!dirs.length) throw new Error(`找不到任何 profile（${profilesRoot()}）`)
  return dirs[0]
}

/* ── 目录拷贝（带排除） ───────────────────────────────────────────────── */
function skipDir(n) {
  return SKIP_DIRS.has(n) || SKIP_DIR_PATTERNS.some((r) => r.test(n))
}
function skipFile(n) {
  return /\.(log|tmp)$/i.test(n) || /\.bak(-|\.|$)/i.test(n) || n === 'pnpm-lock.yaml'
}

/** 把 src 下的文件读成 { 'rel/path': '内容' }（只收 UTF-8 文本，插件/配置全是文本） */
function collect(srcDir, prefix, out = {}) {
  const walk = (dir, rel) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!skipDir(e.name)) walk(abs, r)
      } else if (e.isFile()) {
        if (skipFile(e.name)) continue
        try { out[`${prefix}/${r}`] = readFileSync(abs, 'utf8') } catch { /* 非文本/读不了就跳过 */ }
      }
    }
  }
  walk(srcDir, '')
  return out
}

/* ── GitHub REST ──────────────────────────────────────────────────────── */
async function api(cfg, path, init = {}) {
  if (!cfg.token) throw new Error('还没填 API token（在下面的输入框里填一次、点保存）')
  const res = await fetch(API + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${cfg.token}`,
      'user-agent': 'dsh-profile-sync',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try { msg = JSON.parse(text).message || text } catch { /* 原样 */ }
    const err = new Error(`GitHub ${res.status}：${msg}`)
    err.status = res.status
    throw err
  }
  return text ? JSON.parse(text) : null
}

async function ensureRepo(cfg, log) {
  const [owner, repo] = cfg.repo.split('/')
  if (!owner || !repo) throw new Error(`仓库地址要写成 owner/repo，现在是「${cfg.repo}」`)
  try {
    await api(cfg, `/repos/${owner}/${repo}`)
    log(`仓库 ${owner}/${repo} 已存在`)
    return { owner, repo }
  } catch (e) {
    if (e.status !== 404) throw e
    log(`仓库 ${owner}/${repo} 不存在，创建私有仓库…`)
    try {
      await api(cfg, '/user/repos', {
        method: 'POST',
        body: JSON.stringify({ name: repo, private: true, description: 'DSH 插件配置备份（dsh-profile-sync 自动维护）' }),
      })
    } catch (e2) {
      if (e2.status !== 422) throw e2      // 422 = 同名已存在（可能是别人的 org 权限问题）
    }
    await api(cfg, `/repos/${owner}/${repo}`)
    return { owner, repo }
  }
}

/* ── 打包 ─────────────────────────────────────────────────────────────── */
function buildPayload(cfg, log) {
  const profileName = detectProfile(cfg)
  const profileDir = join(profilesRoot(), profileName)
  log(`profile：${profileName}（${profileDir}）`)

  const files = {}
  for (const f of PROFILE_FILES) {
    const abs = join(profileDir, f)
    if (isFile(abs)) files[`profile/${f}`] = readText(abs)
  }
  if (!files['profile/package.json']) throw new Error(`profile 里没有 package.json：${profileDir}`)

  const pkg = JSON.parse(files['profile/package.json'])
  pkg.dependencies = pkg.dependencies || {}

  /* 本地 link: 依赖 —— 整包搬走，并把 spec 改成自己（本插件）的固定写法 */
  const plugins = []
  for (const [dep, spec] of Object.entries(pkg.dependencies)) {
    if (typeof spec !== 'string') continue
    if (dep === 'dsh-profile-sync') { pkg.dependencies[dep] = SELF_SPEC; continue }
    if (!spec.startsWith('link:')) continue
    const src = spec.slice(5)
    if (!isDir(src)) { log(`⚠ 跳过 ${dep}：link 目标不存在（${src}）`); continue }
    const folder = folderOf(dep)
    collect(src, `plugins/${folder}`, files)
    plugins.push({ dep, folder, source: fwd(src) })
    log(`带上本地插件 ${dep}（${folder}）`)
  }
  /* 本插件自己必须留在清单里：否则新机拉完重启会被 pnpm 当成多余依赖 prune 掉 */
  pkg.dependencies['dsh-profile-sync'] = SELF_SPEC

  /* github: 依赖同样要过 git，改成免 git 的 codeload tarball 地址 */
  for (const [dep, spec] of Object.entries(pkg.dependencies)) {
    if (typeof spec !== 'string' || !spec.startsWith('github:')) continue
    const next = gitFreeSpec(spec)
    if (next !== spec) {
      pkg.dependencies[dep] = next
      log(`github 依赖 ${dep} 改走 tarball（免 git）`)
    }
  }

  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
  if (!pkg.dsh.profile.bundles.includes('dsh-profile-sync')) pkg.dsh.profile.bundles.push('dsh-profile-sync')

  files['profile/package.json'] = JSON.stringify(pkg, null, 2) + '\n'

  /* 记忆 */
  const memDir = join(DSH_HOME, 'memories')
  if (isDir(memDir)) { collect(memDir, 'memories', files); log('带上 memories/') }

  /* 抖音插件的运行配置 + 聊天记忆 */
  const dyState = join(DSH_HOME, 'douyin-duty')
  let dyCfg = {}
  for (const f of DOUYIN_STATE_FILES) {
    const abs = join(dyState, f)
    if (isFile(abs)) files[`douyin-state/${f}`] = readText(abs)
  }
  dyCfg = readJson(join(dyState, 'config.json'), {})
  const memOut = dyCfg.memoryDir || join(DSH_HOME, 'douyin-memory')
  if (isDir(memOut)) { collect(memOut, 'douyin-memory', files); log(`带上抖音聊天记忆（${memOut}）`) }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    profileName,
    source: { home: fwd(DSH_HOME), host: hostname(), platform: process.platform },
    dependencies: pkg.dependencies,
    bundles: (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [],
    plugins,
    douyinMemorySource: fwd(memOut),
    paths: Object.keys(files).sort(),
  }
  files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n'
  return { files, manifest, profileName }
}

async function headSha(cfg, owner, repo, branch) {
  try {
    const ref = await api(cfg, `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
    return ref.object.sha
  } catch (e) {
    if (e.status === 404 || e.status === 409) return null
    throw e
  }
}

async function push(cfg, log) {
  const { owner, repo } = await ensureRepo(cfg, log)
  const info = await api(cfg, `/repos/${owner}/${repo}`)
  const branch = info.default_branch || 'main'
  const { files, manifest } = buildPayload(cfg, log)
  const paths = Object.keys(files)
  log(`打包完成：${paths.length} 个文件 / ${Math.round(paths.reduce((n, p) => n + Buffer.byteLength(files[p]), 0) / 1024)} KB`)

  /* 空仓库不能直接建 tree（409 Git Repository is empty），先用 contents API 铺第一个提交 */
  let parent = await headSha(cfg, owner, repo, branch)
  if (!parent) {
    log('仓库还是空的，先建一个初始提交…')
    await api(cfg, `/repos/${owner}/${repo}/contents/.dsh-sync-init`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'init (dsh-profile-sync)',
        branch,
        content: Buffer.from('init\n', 'utf8').toString('base64'),
      }),
    })
    parent = await headSha(cfg, owner, repo, branch)
    if (!parent) throw new Error('初始化空仓库失败（拿不到 ref）')
  }

  const tree = paths.map((p) => ({ path: p, mode: '100644', type: 'blob', content: files[p] }))
  const created = await api(cfg, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree }),
  })

  const commit = await api(cfg, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `sync from ${manifest.source.host} · ${paths.length} files · ${new Date().toISOString()}`,
      tree: created.sha,
      parents: [parent],
    }),
  })

  await api(cfg, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  })
  log(`已推送 commit ${commit.sha.slice(0, 8)}（分支 ${branch}）`)
  saveConfig({ lastUploadAt: new Date().toISOString() })
  return { files: paths.length, commit: commit.sha, plugins: manifest.plugins.length, profileName: manifest.profileName }
}

/* ── 下载 ─────────────────────────────────────────────────────────────── */
async function fetchRaw(cfg, path) {
  if (!cfg.token) throw new Error('还没填 API token')
  const res = await fetch(`${API}/repos/${cfg.repo}/contents/${encodeURI(path)}?ref=main`, {
    headers: {
      accept: 'application/vnd.github.raw',
      authorization: `Bearer ${cfg.token}`,
      'user-agent': 'dsh-profile-sync',
      'x-github-api-version': '2022-11-28',
    },
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try { msg = JSON.parse(text).message || text } catch { /* 原样 */ }
    throw new Error(`下载 ${path} 失败：GitHub ${res.status} ${msg}`)
  }
  return text
}

async function download(cfg, log) {
  if (!cfg.token) throw new Error('还没填 API token')
  const manifest = JSON.parse(await fetchRaw(cfg, 'manifest.json'))
  if (!manifest || !Array.isArray(manifest.paths)) throw new Error('仓库里的 manifest.json 格式不对')
  log(`清单：${manifest.paths.length} 个文件，来自 ${manifest.source?.host || '?'}（${manifest.createdAt}）`)

  const files = {}
  const queue = manifest.paths.slice()
  const worker = async () => {
    for (;;) {
      const p = queue.shift()
      if (!p) return
      files[p] = await fetchRaw(cfg, p)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  log(`下载完成：${Object.keys(files).length} 个文件`)
  return { manifest, files }
}

/* ── 路径改写 ─────────────────────────────────────────────────────────── */
function rewriteJsonValue(text, key, value) {
  const rx = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`)
  if (!rx.test(text)) return text
  const esc = value.replace(/\\/g, '\\\\')
  return text.replace(rx, `$1"${esc}"`)
}

function rewriteYamlValue(text, key, value) {
  const rx = new RegExp(`^(\\s*${key}\\s*:\\s*)(.*)$`, 'm')
  const m = text.match(rx)
  if (!m) return text
  const old = m[2].trim()
  const hasDouble = /^".*"$/.test(old)
  const hasSingle = /^'.*'$/.test(old)
  const val = hasDouble ? `"${value.replace(/"/g, '\\"')}"` : hasSingle ? `'${value}'` : value
  return text.replace(rx, (_, p1) => `${p1}${val}`)
}

/** 把 link: 依赖的 spec 指向新机器上的 vendor 目录 */
function relinkPackageJson(text, profileDir) {
  let pkg
  try { pkg = JSON.parse(text) } catch { return text }
  const deps = pkg.dependencies || {}
  let changed = false
  for (const [dep, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    if (dep === 'dsh-profile-sync') { deps[dep] = SELF_SPEC; changed = true; continue }
    deps[dep] = `link:${fwd(join(profileDir, 'vendor', folderOf(dep)))}`
    changed = true
  }
  if (deps['dsh-profile-sync'] !== SELF_SPEC) { deps['dsh-profile-sync'] = SELF_SPEC; changed = true }
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
  if (!pkg.dsh.profile.bundles.includes('dsh-profile-sync')) {
    pkg.dsh.profile.bundles.push('dsh-profile-sync')
    changed = true
  }
  return changed ? JSON.stringify(pkg, null, 2) + '\n' : text
}

/* ── 安装依赖 ─────────────────────────────────────────────────────────── */
function cliJsPath() {
  const exeDir = dirname(process.execPath)
  const p = join(exeDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  return p
}

function runInstall(profileName, log) {
  const cli = process.env.DSH_SYNC_CLI || cliJsPath()
  const exe = process.execPath
  log(`装依赖：${exe} ${cli} plugin --profile ${profileName} install`)
  return new Promise((resolve) => {
    execFile(exe, [cli, 'plugin', '--profile', profileName, 'install'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const tail = String(stdout || '').trim().split(/\r?\n/).slice(-6).join('\n')
      const errTail = String(stderr || '').trim().split(/\r?\n/).slice(-8).join('\n')
      if (err) {
        resolve({ ok: false, error: err.message, output: (tail + '\n' + errTail).trim() })
      } else {
        resolve({ ok: true, output: tail })
      }
    })
  })
}

/* ── 恢复 ─────────────────────────────────────────────────────────────── */
async function restore(cfg, log) {
  const { manifest, files } = await download(cfg, log)
  const profileName = cfg.profile || manifest.profileName || 'desktop'
  const profileDir = join(profilesRoot(), profileName)
  const ts = stamp()
  const steps = []

  /* 1. 先备份现有 profile 的 4 个清单文件 */
  if (isDir(profileDir)) {
    const bak = `${profileDir}.bak-${ts}`
    mkdirSync(bak, { recursive: true })
    for (const f of PROFILE_FILES) {
      const abs = join(profileDir, f)
      if (isFile(abs)) writeText(join(bak, f), readText(abs))
    }
    log(`旧配置已备份到 ${bak}`)
  }

  /* 2. 本地插件落到 profile/vendor/<名> */
  for (const p of manifest.plugins || []) {
    const dest = join(profileDir, 'vendor', p.folder)
    rmSync(dest, { recursive: true, force: true })
    let n = 0
    for (const [path, content] of Object.entries(files)) {
      const pre = `plugins/${p.folder}/`
      if (!path.startsWith(pre)) continue
      writeText(join(dest, path.slice(pre.length)), content)
      n++
    }
    log(`插件 ${p.dep} → vendor/${p.folder}（${n} 个文件）`)
    steps.push(`${p.dep} → vendor/${p.folder}`)
  }

  /* 3. profile 清单（改写好 link: 路径） */
  mkdirSync(profileDir, { recursive: true })
  for (const f of PROFILE_FILES) {
    const content = files[`profile/${f}`]
    if (typeof content !== 'string') continue
    let out = content
    if (f === 'package.json') out = relinkPackageJson(out, profileDir)
    if (f === 'cordis.patch.yml') {
      out = rewriteYamlValue(out, 'pythonPath', join(DSH_HOME, 'douyin-duty', '.venv', 'Scripts', 'python.exe'))
      out = rewriteYamlValue(out, 'dshBin', join(profileDir, 'vendor', 'dsh-douyin-scroll', 'bin', 'dsh-electron-shim.cjs'))
      out = rewriteYamlValue(out, 'memoryDir', join(DSH_HOME, 'douyin-memory'))
    }
    writeText(join(profileDir, f), out)
    steps.push(`profile/${f}`)
  }
  log(`profile 清单已写入 ${profileDir}`)

  /* 4. 记忆 */
  const memCount = Object.keys(files).filter((p) => p.startsWith('memories/')).length
  if (memCount) {
    const memDir = join(DSH_HOME, 'memories')
    if (isDir(memDir)) {
      const bak = `${memDir}.bak-${ts}`
      rmSync(bak, { recursive: true, force: true })
      renameSync(memDir, bak)
      log(`旧记忆已备份到 ${bak}`)
    }
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith('memories/')) continue
      writeText(join(memDir, path.slice('memories/'.length)), content)
    }
    log(`记忆已写入：${memCount} 个文件`)
    steps.push(`memories/ ${memCount} 个文件`)
  }

  /* 5. 抖音：运行配置 + 聊天记忆 */
  const dyState = join(DSH_HOME, 'douyin-duty')
  let dyCount = 0
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith('douyin-state/')) continue
    writeText(join(dyState, path.slice('douyin-state/'.length)), content)
    dyCount++
  }
  if (dyCount) {
    const cfgFile = join(dyState, 'config.json')
    if (isFile(cfgFile)) {
      let t = readText(cfgFile)
      t = rewriteJsonValue(t, 'pythonPath', join(DSH_HOME, 'douyin-duty', '.venv', 'Scripts', 'python.exe'))
      t = rewriteJsonValue(t, 'dshBin', join(profileDir, 'vendor', 'dsh-douyin-scroll', 'bin', 'dsh-electron-shim.cjs'))
      t = rewriteJsonValue(t, 'memoryDir', join(DSH_HOME, 'douyin-memory'))
      writeText(cfgFile, t)
    }
    log(`抖音运行配置已写入：${dyCount} 个文件`)
    steps.push(`douyin-state/ ${dyCount} 个文件`)
  }

  const dyMemCount = Object.keys(files).filter((p) => p.startsWith('douyin-memory/')).length
  if (dyMemCount) {
    const dyMem = join(DSH_HOME, 'douyin-memory')
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith('douyin-memory/')) continue
      writeText(join(dyMem, path.slice('douyin-memory/'.length)), content)
    }
    log(`抖音聊天记忆已写入：${dyMemCount} 个文件`)
    steps.push(`douyin-memory/ ${dyMemCount} 个文件`)
  }

  /* 6. 抖音的数据目录环境变量（插件里写死 F: 的兜底就靠它） */
  const dataDir = join(DSH_HOME, 'douyin-duty-data')
  mkdirSync(dataDir, { recursive: true })
  if (process.env.DSH_SYNC_TEST === '1') {
    log('（测试模式：跳过环境变量与依赖安装）')
    return { steps, install: { ok: true, output: 'skipped' }, manifest, profileName }
  }
  await new Promise((resolve) => {
    execFile('setx', ['DOUYIN_DATA_DIR', dataDir], { windowsHide: true }, (err) => {
      log(err ? `⚠ 设置环境变量失败（${err.message}），可手动设 DOUYIN_DATA_DIR=${dataDir}` : `环境变量 DOUYIN_DATA_DIR=${dataDir}`)
      resolve()
    })
  })

  /* 7. 装依赖（pnpm 由 DSH 自带，不需要新机另装） */
  const install = await runInstall(profileName, log)
  if (install.ok) {
    log('依赖安装完成')
    steps.push('依赖安装完成')
  } else {
    log(`依赖安装失败：${install.error}`)
    if (install.output) log(install.output)
  }

  saveConfig({ lastRestoreAt: new Date().toISOString() })
  return { steps, install, manifest, profileName }
}

/* ── 日志 ─────────────────────────────────────────────────────────────── */
let logLines = []
function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}`
  logLines.push(line)
  if (logLines.length > 400) logLines = logLines.slice(-400)
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(LOG_FILE, logLines.join('\n') + '\n', 'utf8')
  } catch { /* 日志写不进去不致命 */ }
}

/* ── HTTP ─────────────────────────────────────────────────────────────── */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

const readBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
  req.on('error', () => resolve({}))
})

export function apply(ctx) {
  let busy = ''

  const handle = async (req, res, url) => {
    const path = url.pathname.replace(/^\/api\/dsh-profile-sync/, '')

    if (req.method === 'GET' && (path === '/status' || path === '')) {
      const cfg = loadConfig()
      const profileName = (() => { try { return detectProfile(cfg) } catch { return '' } })()
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        repo: cfg.repo,
        hasToken: Boolean(cfg.token),
        tokenHint: cfg.token ? `${cfg.token.slice(0, 4)}…${cfg.token.slice(-4)}` : '',
        profile: profileName,
        profileDir: profileName ? join(profilesRoot(), profileName) : '',
        dshHome: fwd(DSH_HOME),
        lastUploadAt: cfg.lastUploadAt,
        lastRestoreAt: cfg.lastRestoreAt,
        busy,
        targetPaths: {
          python: fwd(join(DSH_HOME, 'douyin-duty', '.venv', 'Scripts', 'python.exe')),
          memoryDir: fwd(join(DSH_HOME, 'douyin-memory')),
        },
      })
    }

    if (req.method === 'POST' && path === '/save') {
      const body = await readBody(req)
      const patch = {}
      if (typeof body.repo === 'string') {
        const v = body.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
        if (v && !/^[\w.-]+\/[\w.-]+$/.test(v)) return sendJson(res, 200, { ok: false, error: '仓库地址要写成 owner/repo（例如 vdfxgyfgg/dsh-profile-backup）' })
        if (v) patch.repo = v
      }
      if (typeof body.token === 'string') {
        const t = body.token.trim()
        if (t) patch.token = t
      }
      if (typeof body.clearToken === 'boolean' && body.clearToken) patch.token = ''
      if (typeof body.profile === 'string' && body.profile.trim()) patch.profile = body.profile.trim()
      saveConfig(patch)
      return sendJson(res, 200, { ok: true, repo: loadConfig().repo, hasToken: Boolean(loadConfig().token) })
    }

    if (req.method === 'GET' && path === '/log') {
      let tail = ''
      try { tail = readText(LOG_FILE).split(/\r?\n/).slice(-120).join('\n') } catch { tail = logLines.slice(-120).join('\n') }
      return sendJson(res, 200, { ok: true, tail, busy })
    }

    if (req.method === 'POST' && (path === '/upload' || path === '/restore')) {
      const which = path === '/upload' ? '上传' : '拉取'
      if (busy) return sendJson(res, 200, { ok: false, error: `正在${busy}，等它跑完` })
      busy = which
      log('─'.repeat(60))
      log(`开始${which}`)
      const t0 = Date.now()
      try {
        const cfg = loadConfig()
        if (which === '上传') {
          const r = await push(cfg, log)
          log(`${which}成功：${r.files} 个文件，commit ${r.commit.slice(0, 8)}`)
          return sendJson(res, 200, { ok: true, kind: 'upload', ...r, ms: Date.now() - t0, tail: logLines.slice(-40).join('\n') })
        }
        const r = await restore(cfg, log)
        log(`${which}完成，需要重启 DSH 才生效`)
        return sendJson(res, 200, {
          ok: true,
          kind: 'restore',
          steps: r.steps,
          install: r.install,
          needRestart: true,
          profileName: r.profileName,
          count: Object.keys(r.manifest.paths || {}).length,
          ms: Date.now() - t0,
          tail: logLines.slice(-40).join('\n'),
        })
      } catch (e) {
        log(`${which}失败：${e?.message || e}`)
        return sendJson(res, 200, { ok: false, error: e?.message || String(e), tail: logLines.slice(-40).join('\n') })
      } finally {
        busy = ''
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dsh-profile-sync',
      handler: async (req, res) => {
        try {
          await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) })
        }
      },
    }), 'profile-sync: /api/dsh-profile-sync 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message || e}`)
  }

  mkdirSync(STATE_DIR, { recursive: true })
  log(`已挂载 v${VERSION}（家：${DSH_HOME}）`)
}
