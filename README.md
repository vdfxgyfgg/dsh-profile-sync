# dsh-profile-sync

**DSH 插件：把一台电脑上的 DSH 配置，一键搬到另一台电脑。**

老机器：装好本插件 → 填一次仓库地址和 token → 点「上传本机配置」。
新电脑：装好本插件 → 填同样的仓库地址和 token → 点「从仓库拉取并部署」→ 重启 DSH。完事。

面板位置：**设置 → 插件同步**。

---

## 为什么不用「插件市场」自带的备份与恢复

不是重复造轮子，是那套有三个洞（都在 `dshmarket/lib/backup.js` 里能验证）：

| 洞 | 现象 |
| --- | --- |
| `link:` 本地依赖只告警不搬运 | 换成新机，从本地目录 link 装的两个插件直接没了，市场只打印一句「unportable」 |
| 配置里的绝对路径原样恢复 | `cordis.patch.yml` 里的 `pythonPath` / `dshBin` / `memoryDir` 全是旧机器的 `F:\...`，新机上全是死路 |
| 只带配置，不带数据 | 记忆、抖音的登录态与聊天记忆、插件自己的运行配置（cookie）都不在里面 |

本插件把这三件事都做了：**整包搬本地插件源码**、**按新机路径重写所有绝对路径**、**连记忆和数据一起搬**。

## 装法

**推荐（新电脑上不需要装 git）**：在 DSH 的终端里跑一条命令

```bat
dsh plugin --profile desktop add https://cdn.jsdelivr.net/gh/vdfxgyfgg/dsh-profile-sync@main/dist/dsh-profile-sync.tgz
```

国内直连 `raw.githubusercontent.com` 实测 20 秒起、还常断，所以走 jsDelivr 镜像（同一个仓库文件）。
连 jsDelivr 也不通时，换回 GitHub 原地址：

```bat
dsh plugin --profile desktop add https://raw.githubusercontent.com/vdfxgyfgg/dsh-profile-sync/main/dist/dsh-profile-sync.tgz
```

**插件市场**：市场 → 安装 → 输入框填

```
vdfxgyfgg/dsh-profile-sync
```

> 市场这条走的是 `github:` 源，pnpm 解析它需要机器上装了 **git**；没有 git 会报
> `Failed to resolve git dependency ... 'git' 不是内部或外部命令`。所以新电脑上没 git 就用上面那条 tarball 命令。
> 同理，本插件上传时会把清单里所有 `github:` 依赖改写成 `codeload` 的 tarball 地址，新机安装同样不需要 git。

装完重启一次 DSH，设置里就多出「插件同步」一页。

## 用法

1. **建一个私有仓库**放数据（例如 `你的账号/dsh-profile-backup`）。其实不用手动建：点上传时如果仓库不存在，插件会自己建一个**私有**的。
2. **建 token**：GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
   - Repository access：All repositories（或只勾那两个仓库）
   - Permissions → Repository permissions → **Contents: Read and write**；建仓库还需要 **Administration: Read and write**（想省事就用 classic token 勾 `repo` 这一项）
3. 面板里填仓库 `owner/repo` + token → **保存**。token 只写在本机 `~/.dsh/profile-sync/config.json`，不进仓库也不进插件配置。
   - **token 不用搬机器**：GitHub 上的 token 创建后不能再看，新电脑上直接**重新建一个** token（同样勾 `repo`）就行，两个 token 都能用。
   - 也可以把 token 存成 `~/.dsh/sync-token.txt`（直接粘一行），插件会自己读。
4. 老机器点 **上传本机配置**。几十秒，日志里会显示文件数、体积和 commit。
5. 新电脑：装插件 → 填同一个仓库和 token → **从仓库拉取并部署** → **手动重启 DSH**。

## 备份了什么

```
profile/          package.json（插件清单 + 加载顺序）、cordis.patch.yml（所有插件配置）、
                  cordis.yml、pnpm-workspace.yaml
plugins/<名字>/   本地 link: 依赖的插件源码（整包，跳过 node_modules / .venv / 日志）
memories/         ~/.dsh/memories 全量（用户档案、长期记忆、每日/项目日志）
douyin-state/     抖音插件的运行配置与登录态（config.json、cookie、seen.md、聊天监听等白名单文件）
douyin-memory/    抖音聊天记忆目录
manifest.json     清单：profile 名、依赖表、来源机器、生成时间
```

**不带**：会话历史（`~/.dsh/sessions`，体积大且跟本机绑定）、`node_modules`、venv、浏览器的 Chrome profile、插件日志。

恢复时会把旧的 `profiles/desktop` 清单、`memories/` 分别备份成 `.bak-<时间戳>`，再覆盖；绝对路径按新机重写：

| 配置项 | 新机器上的值 |
| --- | --- |
| `pythonPath` | `<DSH_HOME>\douyin-duty\.venv\Scripts\python.exe` |
| `dshBin` | `<profile>\vendor\dsh-douyin-scroll\bin\dsh-electron-shim.cjs` |
| `memoryDir` | `<DSH_HOME>\douyin-memory` |
| `link:` 依赖 | `<profile>\vendor\<插件>` |

另外会设一个用户级环境变量 `DOUYIN_DATA_DIR=<DSH_HOME>\douyin-duty-data`（抖音插件里写死的旧路径就靠它兜底）。

## 安全

- **仓库必须是私有的**。里面有你抖音的 cookie 明文、聊天记忆。
- token 只保存在本机状态文件里，随 `~/.dsh/profile-sync/` 目录，不进任何提交。
- 想让 token 立刻失效：GitHub 上删掉那个 token 即可，插件会报 401。

## 备用方案（不想用插件时）

`fallback/` 里是同一套逻辑的 PowerShell 版本，双击就能跑，走 U 盘/网盘，不需要 GitHub：

- `1-export-backup.bat` —— 把这台机器的配置导出到 `F:\A1895\Projects\dsh-backup`
- `2-restore-newpc.bat` —— 在那台机器的导出目录里双击，装好
- `1b-push-github.bat` —— 直接推到 GitHub（等价于插件里的上传按钮）

> 脚本必须保持 **UTF-8 带 BOM**，否则 PowerShell 5.1 会把中文当 ANSI 读出乱码，报 `The '<' operator is reserved for future use.`

## 已知限制

- 只搬 **UTF-8 文本文件**（配置、记忆、插件源码都满足）；二进制资源不搬。
- 依赖安装用的是 DSH 自带的 pnpm（`dsh plugin --profile <名> install`），新机不需要另装 Node/pnpm，也**不需要 git**（清单里的 `github:` 依赖已改写成 tarball 地址）。
- 恢复后**必须重启 DSH**：插件文件不能在自己跑着的时候热替换。
- 上传按「整棵树替换」提交（不带 base_tree），所以仓库里不会残留已删除的旧文件。
- 新机首次安装依赖大约几分钟（270 个包，看网速），之后都是增量。
- 抖音插件的 Python venv（`.venv`）不搬：新机上它的 `pythonPath` 指向的 venv 需要你自己建一次（`python -m venv <DSH_HOME>\douyin-duty\.venv` 并装依赖），不建只影响抖音那一个插件，不影响其它插件和 DSH 启动。

## 开发

```
node .dev/publish.mjs     # pnpm pack + 把源码和 dist/*.tgz 推到公开仓库（REST，不需要 git）
node .dev/live.mjs        # 用真 token 跑一次真实上传
node .dev/live-restore.mjs # 从真仓库还原到 F:\A1895\Projects\dsh-sync-home（模拟新电脑）
```

## 许可

MIT
