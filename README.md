# 西莲桌宠（xilian pet）

DSH 桌面透明置顶窗桌宠。当前阶段：**Phase 0 技术验证原型（spike）**。
方向与验收标准见 [`PLAN.md`](PLAN.md)；环境实测数据见 [`chajian/环境体检报告.md`](chajian/环境体检报告.md)。

---

## 一、本机环境事实（2026-09-29 实测，改动前先核）

| 项 | 值 |
|---|---|
| DSH | `@deepseek-ai/dsh-desktop` **0.1.7-rc.1.20260924.1**（build `55f35f51`，channel `nightly`，Electron 外壳 44.0.0） |
| DSH_HOME | `C:\Users\怒C大伟出奇迹\.dsh` |
| profile | `desktop` → `C:\Users\怒C大伟出奇迹\.dsh\profiles\desktop` |
| GUI | `http://127.0.0.1:19387`（未鉴权 401 = 已挂载，属正常） |
| 工作区 | `C:\Users\怒C大伟出奇迹\dsh-projects\xilian pet` |
| 旧路径 | `F:\dsh\project\*` —— **已弃用，无沙箱授权，勿搬回** |

> 版本以 `F:\dsh\resources\app.asar` 内的 `asar/dsh/package.json` 为准。**不要**再从记忆或旧文档里引用 `dsh-v0.1.0-rc.8`（那是错的，本机 `rc.8` 出现 0 次）。
> DSH 对第三方插件有**精确版本兼容闸门**：不匹配会以 `incompatible-version` 拒绝安装，需 `dsh plugin allow-version <pkg@ver> --dsh-version <runtime> --accept-risk`。

---

## 二、工具链固定路径（不要用全局 node/pnpm）

本机有**三套** node/pnpm（内置 24.21.0 + pnpm 11.7.0、全局 24.18.0 + npm 11.16.0 + pnpm 11.21.0），混用会造成 lockfile / linker 行为漂移。profile 侧是 `nodeLinker: hoisted` + `autoInstallPeers: false`（**peer 不会自动补装**）。

```powershell
$NODE = "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"   # v24.21.0
$PNPM = "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"  # pnpm 11.7.0

& $NODE -v
& $NODE $PNPM install
```

---

## 三、沙箱与网络边界（会直接卡住构建，务必先读）

### 3.1 文件沙箱：只有「工作区 + TEMP」可写

| 目标 | 写入 |
|---|---|
| 本工作区、`%TEMP%` | ✅ |
| `~/.dsh`、`~/.dsh/profiles/desktop` | ❌ 拒绝 |
| `%APPDATA%`、`%LOCALAPPDATA%`（含 pnpm store） | ❌ 拒绝 |

**推论**：命令行装 DSH 插件、以及默认位置的 `pnpm add`，在 agent shell 里**必然失败**。变通：
- 装插件走 **GUI 插件管理页**（`@deepseek-ai/dsh-client-ui-plugin-manager`，本机已确认存在）
- 纯依赖实验放在工作区内：`pnpm --store-dir .\.pnpm-store add …`
- 必要时对安装类命令提权

### 3.2 TLS：agent shell 内 Schannel 全挂，只有 Node 系能联网

`curl` / PowerShell `Invoke-WebRequest` / `git` 默认后端都报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`（系统加密服务正常，是该 shell 的受限令牌所致）。

```powershell
# ❌ 会失败
curl.exe https://registry.npmjs.org/-/ping
Invoke-WebRequest https://registry.npmjs.org/-/ping
git ls-remote https://gitee.com/...

# ✅ 可用
npm ping
git -c http.sslBackend=openssl ls-remote https://gitee.com/...
# 网页抓取用 harness 的 web_fetch，不要用 Invoke-WebRequest
```

### 3.3 网络可达性（实测）

- **可达**：`registry.npmjs.org`、`registry.npmmirror.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`
- **超时**：`github.com`、`raw.githubusercontent.com`、`www.google.com`
- **推论**：`git clone github.com` 会失败；拿 GitHub 源码走 npm registry / codeload tarball / 镜像。

### 3.4 其他能力缺口

- `Get-CimInstance` / `Get-Volume` **拒绝访问**（WMI 受限）→ 用 `cmd /c vol`、`fsutil fsinfo drivetype`、`Get-PSDrive`
- `ffmpeg` **未安装**（只有走 WebM 素材链时才需要）
- 工作区路径含**空格**（`xilian pet`）、用户名**非 ASCII**（`怒C大伟出奇迹`）；`LongPathsEnabled=1` 已开。脚本路径一律加引号 + `path.resolve`，构建异常时优先怀疑路径。

---

## 四、开发循环现状（重要）

- HMR **传输**随包提供（`@deepseek-ai/dsh-client-hmr`），HMR 用的系统通道是 `GET /plugins/events`。
- ⚠️ **缺的不是 Host，而是"重建 + 盖戳"那一步。** 官方 `dsh-client-hmr` README 原文：
  > *Run `pnpm run dev:web`, which starts the host and the rebuild watchers together (`--no-serve` attaches only the watchers to a host started elsewhere, **as does any watch process using the shared Client tsdown preset**). The preset stamps `lib/client.js` after all package-local chunks are written…*
  >
  > *The Host half watches each package's stamped entry artifact and serves `/plugins/events`.*（`pollIntervalMs` 默认 500ms）

  即：**正在跑的桌面版本身就是 Host**，它会 stat-poll **已安装插件**的 `lib/client.js`（比 mtime/ctime/size，不哈希内容）。只要把重建并盖过戳的产物写到插件安装位置，浏览器就会自动热换（**无需刷新、无需重启**）。本机缺的只有两件：① `dev:web` 脚本与"共享 Client tsdown 预设"都在源码仓库里，本机只有 `app.asar`；② 插件安装目录在沙箱写边界之外。
- 另注（原文）：*"Web transport only — Electron installation and backend restart handling do not use this SSE path."*
- ⚠️ **`GET /plugins/events` 推的是插件图变化与重建通知（`graph` / `rebuilt` 帧），不是 agent 状态**，拿不到"思考中/工具调用/余额"。要拿 agent 状态必须按 `PLAN.md` 第三节自建 Host 插件：监听 `session/event` + `agent/assistant-stream`，再以自己的同源 SSE 路由推给桌宠壳。
- 本机已验证**存在**的扩展点：`shell.overlay`、`settings.section`、`session/event`、`agent/assistant-stream`、`agent/pre-step`、`agent/turn-stopping`、`tools/pre-execute`、`tools/post-execute`、`dsh.bundle.patch`。

---

## 五、安全红线

- **装第三方插件 = 授予宿主进程执行权**。DSH 的插件 vm 沙箱**不是安全边界**（Discussion #1441，PoC 已验证：一次批准 = 完整 RCE；#451 沙箱逃逸 + `/api` RPC 仅靠 Host 头围栏；#250 沙箱内可经 approval 回环自批准 `danger-full-access`）。三帖至今 open。
- 已知 CVE 与本机关系（2026-09-29 复核）：**CVE-2026-82533**（本地控制 API 鉴权绕过，9.6 CRITICAL）修于 `0.1.2-alpha.1`；**CVE-2026-101102**（Code Mode Sandbox，6.3 MEDIUM）影响 `0.1.0-rc.0 … 0.1.0-rc.7` —— **本机 0.1.7-rc.1 两条都不命中**。
- `cordis.patch.yml` 允许 `!!js` 表达式（= 配置期代码执行）→ **改 patch 前先备份，且拒绝 `!!js`**。备份见 [`chajian/backup/`](chajian/backup/)。
- 装前扫描：`@shaoshi/dshscan`（静态+语义双通道）+ socket.dev（注意本 shell 抓 socket.dev 会 403，用 `web_search`）。

---

## 六、Phase 0 骨架：怎么跑

```
packages/
  pet-plugin/            DSH Host 插件（纯 ESM、零依赖、零构建）
    index.js             路由 + SSE + 会话事件观测 + 反向操控
    reducer.js           纯函数状态机（优先级聚合 + 最短保持时间）
    cordis.patch.yml     挂载层（bundle 方式 / 免安装直挂方式）
  pet-shell/             Electron 透明置顶窗
    main.js              透明置顶 + 点击穿透 + 窗口状态持久化 + SSE 订阅
    preload.cjs          最小 IPC 桥
    renderer/            宠物页面（alpha 掩码命中、拖拽、气泡、派活输入条）
    scripts/launch.mjs   启动脚本（处理 ELECTRON_RUN_AS_NODE 等本机坑）
tools/
  check-plugin.mjs       插件自测：mock ctx + 真 HTTP + 真 SSE 往返
  make-placeholder.mjs   程序化生成占位素材
  inspect-png.mjs        校验素材透明通道与关键像素
```

### 三条命令

```powershell
# 1. 插件自测（不需要 DSH、不需要安装）
& $NODE tools\check-plugin.mjs

# 2. 生成 / 重生成占位素材
& $NODE tools\make-placeholder.mjs

# 3. 桌面窗（启动时会先自检 Host 插件是否在线）
& $NODE packages\pet-shell\scripts\launch.mjs --check   # 只自检，不开窗
& $NODE packages\pet-shell\scripts\launch.mjs           # 开窗
```

（`$NODE` = 内置 node，见 §二。）

### 挂载 Host 插件（两种方式，任选其一）

- **方式 1｜bundle 安装**：把 `packages/pet-plugin` 作为 bundle 装进 `desktop` profile（走 GUI 插件管理页最稳）。包内 `cordis.patch.yml` 已写好 insert 行。
- **方式 2｜免安装直挂**：把 `packages/pet-plugin/cordis.patch.yml` 里的 `name` 换成 `index.js` 的绝对路径或 file URL，粘进 profile 的 `cordis.patch.yml`（官方契约明确支持「包标识符 / 绝对文件系统路径 / file URL」）。

装好后自检：`GET http://127.0.0.1:19387/xilian-pet/health` 应返回 `{"ok":true,...}`。
（本机 shell 里 `curl` 走 Schannel 会失败 —— 见 §三，用 `node -e` 或窗口的启动自检代替。）

### 关键设计决定（都写在代码注释里）

| 决定 | 原因 |
|---|---|
| 路由前缀用 `/xilian-pet`，不用 `/api/xilian-pet` | `/api` 是 `dsh-client-connection` 的 prefix 路由，带自己的准入校验（不过直接 401）；exact 路由挂在它下面会被前缀规则吞掉 |
| 全部注册成 `kind: 'exact'` | 精确匹配优先于前缀匹配，不会被任何前缀路由抢先 |
| 反向操控拿不到 agent 时返回 **503** 而不是假装成功 | 能区分"插件在但 API 不对"和"插件根本没装" |
| 会话聚焦返回 **501** | Phase 0 未实现，不做假成功 |
| SSE 订阅放在 Electron **主进程** | 渲染端 origin 是 `null`（`file://`），EventSource 会撞 CORS；主进程订阅没这问题，重连也好管 |
| 窗口位置存包内 `.state/` | Electron 默认 userData 在 AppData，agent shell 沙箱写不进去 |
| 点击穿透默认开启 + `forward: true` | 透明区域不挡下层应用，同时仍收得到 `mousemove` 做 alpha 命中测试 |
| 素材用程序化占位图 | 零版权风险，且 alpha 掩码命中测试现在就能验证 |

### 尚未验证 / 待接线（诚实标注）

- **插件尚未真正装进 profile**（沙箱写边界，见 §三）→ 验收项 A1/A2 未验证
- **窗口未在本机实际启动过**（Electron 依赖仍在下载）→ A3/A8/A9 待验
- **事件载荷的真实形状未知**：`session/event` 的字段归一化是**推测**。插件已内置 `GET /xilian-pet/debug/shapes` 记录真实载荷样本，装好后先看它再定案，不要照现在这份猜测继续加功能
- `agent.followup()` / `agent.cancel()` 的确切方法名待真实运行确认（代码已做多候选探测与降级）

---

## 七、待人工处理的项（沙箱外才能做）

1. `~/.dsh/storages/workspace.json` 仍注册着 `F:\dsh\project\chajian`、`C:\Users\project`、`default-workspace` 三个历史工作区 → 可清理。
2. `F:\dsh\project\chajian` 仍有同内容副本 + 上一轮遗留的 `.write-probe` → 可删除（**保留 C: 这一份为唯一权威**）。
3. 可选：在你自己终端执行 `git config --global http.sslBackend openssl`，省掉每条 git 命令加参数。
4. 决策项：**是否需要一份 DSH 源码 checkout**（决定能否用 `dev:web` 的 HMR 重建链）。

---

## 八、目录

```
PLAN.md                             调研结论与技术验证计划（含验收标准 A1–A10）
README.md                           本文（环境事实 / 边界 / 怎么跑）
package.json · pnpm-workspace.yaml  工作区与 pnpm 配置（storeDir、hoisted、npmmirror）
packages/pet-plugin/                DSH Host 插件（零依赖、零构建）
packages/pet-shell/                 Electron 透明置顶窗
tools/                              自测、素材生成、素材校验
chajian/
  环境体检报告.md                    2026-09-29 环境隐患实测报告（13 项 + 证据）
  dsh-desktop-pet-选型对比.md        独立原生透明置顶窗路线选型
  dsh-vibe-coding-插件清单.md        开发循环插件清单
  backup/                           DSH profile 配置备份（cordis.patch.yml 等）
```
