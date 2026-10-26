/**
 * dsh-profile-sync —— 浏览器半端（「设置 → 插件同步」一页）
 * ============================================================================
 * 左边这台（现在用的）：填仓库地址 + token → 点「上传本机配置」。
 * 新电脑：装好本插件 → 填同样的仓库地址 + token → 点「从仓库拉取并部署」→ 重启 DSH。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-profile-sync',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/dsh-profile-sync'

    const CSS = `
      [data-ps-wrap] { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }
      [data-ps-card] { border: 1px solid var(--dsw-border, rgba(127,127,127,.28)); border-radius: 10px; padding: 14px 16px; background: var(--dsw-surface, transparent); }
      [data-ps-title] { font-weight: 600; font-size: 14px; margin-bottom: 8px; }
      [data-ps-sub] { opacity: .72; line-height: 1.6; }
      [data-ps-row] { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
      [data-ps-grow] { flex: 1 1 260px; min-width: 0; }
      [data-ps-input] { width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--dsw-border, rgba(127,127,127,.4)); background: transparent; color: inherit; font-size: 13px; font-family: inherit; }
      [data-ps-btn] { padding: 7px 14px; border-radius: 7px; border: 1px solid var(--dsw-border, rgba(127,127,127,.4)); background: transparent; color: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
      [data-ps-btn][data-primary] { background: var(--dsw-accent, #2b6cf6); border-color: transparent; color: #fff; font-weight: 600; }
      [data-ps-btn][disabled] { opacity: .5; cursor: default; }
      [data-ps-kv] { display: flex; gap: 8px; line-height: 1.7; flex-wrap: wrap; }
      [data-ps-k] { opacity: .6; min-width: 74px; }
      [data-ps-v] { font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
      [data-ps-pre] { margin: 8px 0 0; padding: 10px; border-radius: 8px; background: rgba(127,127,127,.1); font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow: auto; }
      [data-ps-msg] { margin-top: 10px; padding: 9px 11px; border-radius: 8px; line-height: 1.6; }
      [data-ps-msg][data-ok] { background: rgba(46,160,67,.14); }
      [data-ps-msg][data-bad] { background: rgba(214,72,60,.14); }
      [data-ps-msg][data-warn] { background: rgba(214,160,40,.16); }
    `

    const jget = async (p) => {
      const res = await fetch(API + p, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const jpost = async (p, body) => {
      const res = await fetch(API + p, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      render() {
        if (this.state.err) {
          return h('div', { 'data-ps-wrap': '' },
            h('div', { 'data-ps-msg': '', 'data-bad': '' }, '这页出错了：' + String(this.state.err && this.state.err.message || this.state.err)),
            h('div', { 'data-ps-row': '' },
              h('button', { 'data-ps-btn': '', onClick: () => this.setState({ err: null }) }, '重试')))
        }
        return this.props.children
      }
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [repo, setRepo] = React.useState('')
      const [token, setToken] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [logOpen, setLogOpen] = React.useState(false)
      const [log, setLog] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const s = await jget('/status')
          setSt(s)
          setRepo((r) => r || s.repo || '')
        } catch (e) {
          setMsg({ kind: 'bad', text: '读状态失败：' + e.message })
        }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      const onSave = async () => {
        setBusy('save')
        setMsg(null)
        try {
          const r = await jpost('/save', { repo, token })
          if (!r.ok) setMsg({ kind: 'bad', text: r.error })
          else {
            setToken('')
            setMsg({ kind: 'ok', text: '已保存。仓库：' + r.repo + (r.hasToken ? '　token 已记住' : '　（还没填 token）') })
          }
          await refresh()
        } catch (e) {
          setMsg({ kind: 'bad', text: '保存失败：' + e.message })
        } finally { setBusy('') }
      }

      const onUpload = async () => {
        if (!st || !st.hasToken) { setMsg({ kind: 'bad', text: '先填 API token 并保存' }); return }
        setBusy('upload')
        setMsg({ kind: 'warn', text: '正在打包上传（约 10～40 秒）…' })
        try {
          const r = await jpost('/upload')
          if (!r.ok) setMsg({ kind: 'bad', text: '上传失败：' + r.error })
          else {
            setMsg({
              kind: 'ok',
              text: `上传成功：${r.files} 个文件（含 ${r.plugins} 个本地插件），commit ${String(r.commit).slice(0, 8)}，耗时 ${Math.round(r.ms / 1000)} 秒。`,
            })
            setLog(r.tail || '')
          }
          await refresh()
        } catch (e) {
          setMsg({ kind: 'bad', text: '上传失败：' + e.message })
        } finally { setBusy('') }
      }

      const onRestore = async () => {
        if (!st || !st.hasToken) { setMsg({ kind: 'bad', text: '先填 API token 并保存' }); return }
        const ok = window.confirm(
          '确定要从仓库拉取并覆盖本机的插件配置吗？\n\n'
          + '· 会覆盖：' + (st.profileDir || 'profile') + ' 的清单文件\n'
          + '· 会覆盖：' + st.dshHome + '\\memories 与抖音配置\n'
          + '· 旧文件会先备份成 .bak-时间戳\n\n'
          + '拉完需要手动重启 DSH 才生效。',
        )
        if (!ok) return
        setBusy('restore')
        setMsg({ kind: 'warn', text: '正在拉取并部署（1～3 分钟，别关页面）…' })
        try {
          const r = await jpost('/restore')
          if (!r.ok) setMsg({ kind: 'bad', text: '拉取失败：' + r.error })
          else {
            const ins = r.install && r.install.ok
              ? '依赖安装完成。'
              : '依赖安装没成功（' + ((r.install && r.install.error) || '未知原因') + '），重启 DSH 后到「插件市场」里点一次修复，或再点一次本按钮。'
            setMsg({
              kind: r.install && r.install.ok ? 'ok' : 'warn',
              text: `拉取完成，共 ${r.steps.length} 项。${ins}\n👉 现在请手动重启 DSH（关闭窗口再打开），新配置和插件才会加载。`,
            })
            setLog(r.tail || '')
          }
          await refresh()
        } catch (e) {
          setMsg({ kind: 'bad', text: '拉取失败：' + e.message })
        } finally { setBusy('') }
      }

      const onLog = async () => {
        setLogOpen((v) => !v)
        try { const r = await jget('/log'); setLog(r.tail || '') } catch (e) { setLog('读日志失败：' + e.message) }
      }

      if (!st) return h('div', { 'data-ps-wrap': '' }, h('div', { 'data-ps-sub': '' }, '读状态中…'))

      const btn = (label, onClick, primary, key) => h('button', {
        key,
        'data-ps-btn': '',
        ...(primary ? { 'data-primary': '' } : {}),
        disabled: Boolean(busy) || Boolean(st.busy),
        onClick,
      }, busy === key ? '跑着呢…' : label)

      const msgBox = msg
        ? h('div', {
          'data-ps-msg': '',
          ...(msg.kind === 'ok' ? { 'data-ok': '' } : msg.kind === 'bad' ? { 'data-bad': '' } : { 'data-warn': '' }),
          style: { whiteSpace: 'pre-wrap' },
        }, msg.text)
        : null

      return h('div', { 'data-ps-wrap': '' },

        h('div', { 'data-ps-card': '' },
          h('div', { 'data-ps-title': '' }, '这台机器'),
          h('div', { 'data-ps-kv': '' }, h('span', { 'data-ps-k': '' }, 'DSH 家目录'), h('span', { 'data-ps-v': '' }, st.dshHome)),
          h('div', { 'data-ps-kv': '' }, h('span', { 'data-ps-k': '' }, 'profile'), h('span', { 'data-ps-v': '' }, st.profile || '?')),
          h('div', { 'data-ps-kv': '' }, h('span', { 'data-ps-k': '' }, '上次上传'), h('span', { 'data-ps-v': '' }, st.lastUploadAt ? st.lastUploadAt.replace('T', ' ').slice(0, 19) : '还没传过')),
          h('div', { 'data-ps-kv': '' }, h('span', { 'data-ps-k': '' }, '上次拉取'), h('span', { 'data-ps-v': '' }, st.lastRestoreAt ? st.lastRestoreAt.replace('T', ' ').slice(0, 19) : '还没拉过'))),

        h('div', { 'data-ps-card': '' },
          h('div', { 'data-ps-title': '' }, '备份仓库'),
          h('div', { 'data-ps-sub': '' }, '插件配置、本地插件源码、记忆都会传到这个仓库。建议设成私有仓库：只要写 owner/repo，仓库不存在时点上传会自动建一个私有的。'),
          h('div', { 'data-ps-row': '' },
            h('div', { 'data-ps-grow': '' },
              h('input', {
                'data-ps-input': '',
                value: repo,
                placeholder: 'vdfxgyfgg/dsh-profile-backup',
                spellCheck: false,
                onChange: (e) => setRepo(e.target.value),
              })),
            h('span', { 'data-ps-sub': '' }, 'token')),
          h('div', { 'data-ps-row': '' },
            h('div', { 'data-ps-grow': '' },
              h('input', {
                'data-ps-input': '',
                type: 'password',
                value: token,
                spellCheck: false,
                placeholder: st.hasToken ? `已保存（${st.tokenHint}），要换就粘新的` : 'ghp_… 或 github_pat_…（只需 repo 权限）',
                onChange: (e) => setToken(e.target.value),
              })),
            btn('保存', onSave, false, 'save')),
          h('div', { 'data-ps-sub': '', style: { marginTop: '8px' } },
            'token 只存在本机 ', h('code', null, st.dshHome + '\\profile-sync\\config.json'), '，不会进仓库、不会进插件配置。')),

        h('div', { 'data-ps-card': '' },
          h('div', { 'data-ps-title': '' }, '两台机器各点一下'),
          h('div', { 'data-ps-sub': '' },
            '① 现在这台：点「上传本机配置」→ 全部打包进仓库。',
            h('br'),
            '② 新电脑先装本插件（终端里跑一行，不用装 git）：',
            h('br'),
            h('code', null, 'dsh plugin --profile desktop add https://cdn.jsdelivr.net/gh/vdfxgyfgg/dsh-profile-sync@main/dist/dsh-profile-sync.tgz'),
            h('br'),
            '装完重启 DSH，回到这一页填同一个仓库 + 新 token，点「从仓库拉取并部署」，再重启一次 DSH。'),
          h('div', { 'data-ps-row': '' },
            btn('上传本机配置', onUpload, true, 'upload'),
            btn('从仓库拉取并部署', onRestore, false, 'restore'),
            btn(logOpen ? '收起日志' : '看日志', onLog, false, 'log'))),

        msgBox,

        logOpen && log
          ? h('div', { 'data-ps-card': '' },
            h('div', { 'data-ps-title': '' }, '日志'),
            h('pre', { 'data-ps-pre': '' }, log))
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-profile-sync')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-profile-sync: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'profile-sync', order: 33, label: '插件同步' },
          () => h(Boundary, null, h(Panel)),
        ))
      },
    }
  },
})
