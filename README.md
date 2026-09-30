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

### 依赖安装的三个本机坑（实测，换机器会复现）

1. **`pnpm install` 必须走镜像源**：`pnpm-workspace.yaml` 里已配 `registry: https://registry.npmmirror.com`。走官方源时单请求要 14–30s，`@electron-internal/extract-zip` 这类包会直接超时失败。同时已配 `nodeLinker: hoisted` + `packageImportMethod: copy`，规避 `[ERR_PNPM_SYMLINK_FAILED] symlinkAllModules Maximum call stack size exceeded`。
2. **Electron 二进制不会随 `pnpm install` 装好**：它自带的 `install.js` 把 zip 缓存写进 `%LOCALAPPDATA%\electron\Cache`（沙箱外 → 被拒），改用工作区缓存后在本机仍会**空转**（CPU 0、无连接、10 分钟无输出）。所以改用自己的下载器：

```powershell
& $NODE tools\fetch-electron.mjs        # = pnpm run deps:electron
```

   它是「镜像探测 + 8 路分段并行下载 + 纯 JS 解 zip」。实测：npmmirror ~85 KB/s（要半小时），**华为云 ~11 MB/s，150.9 MB 共 14 秒**。`tools/probe-mirrors.mjs` 可随时复测各镜像速度。
3. **Electron 无法在 agent shell 的沙箱内启动**（重要）：Chromium 的 Mojo IPC 在 Windows 上用**命名管道**，受限沙箱禁止创建，直接 `FATAL ... platform_channel.cc: Check failed: 拒绝访问 (0x5)`；即使加 `--no-sandbox` 也一样（默认沙箱下更早就以 `0x80000003` STATUS_BREAKPOINT 崩掉）。所以：

   - **我在这个 shell 里跑不起来宠物窗口**，只能靠提权验证过一次；
   - **你自己终端里跑没有这个限制**：`& $NODE packages\pet-shell\scripts\launch.mjs`
   - 启动脚本内置探测：如果 Chromium 沙箱初始化失败会自动追加 `--no-sandbox --disable-gpu` 并打印原因。

### ⚠️ 挂载插件前必读：一次真实事故（2026-09-29）

第一次挂载时，本会话**所有**工具调用立刻失效，报 harness 内部错误 `Cannot read properties of undefined (reading 'kind')`，重启 DSH 也不恢复。原因不是环境，**是插件自身的 bug**：

`tools/pre-execute` 是 **waterfall** 事件，官方约定监听器必须 `return next()`：

```js
const gate = await ctx.waterfall(carrier, 'tools/pre-execute', exec, () => ({ kind: 'allow' }))
const askResolution = gate.kind === 'ask' ? ... : ...   // ← gate 被冲成 undefined 就死在这
```

我原来写的是 `(payload) => { observe(); return undefined }` —— 漏了 `next()`，把链路值冲掉，于是**整个 profile 的每一次工具调用全废**。已修复，并补了 `runWaterfall()` 回归测试 + 负向对照（见 `tools/check-plugin.mjs`）。

顺带修掉的另外两个错（同样靠读源码核实）：`session/event` 的真实签名是 `(session, event)` 两参数、`agent/assistant-stream` 是 `{ agent, frame }`；所有事件类型名也已从"我猜的"换成 asar 里普查出的真实字面量。

**两条规矩**：

1. 观测插件**只订阅通知型事件**（`session/event`、`agent/assistant-stream`）。要订阅 waterfall 事件必须 `return next()`，并且必须在真实宿主上验证过。
2. **改 profile patch 前必备份**，回滚命令事先讲清楚：

```powershell
# 安装脚本会自动生成 .bak-<时间戳>，回滚就是拷回去再重启 DSH
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-<时间戳>" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

### 挂载 Host 插件（两种方式，任选其一）

- **方式 1｜bundle 安装**：把 `packages/pet-plugin` 作为 bundle 装进 `desktop` profile（走 GUI 插件管理页最稳）。包内 `cordis.patch.yml` 已写好 insert 行。
- **方式 2｜免安装直挂**：把 `packages/pet-plugin/cordis.patch.yml` 里的 `name` 换成 `index.js` 的绝对路径或 file URL，粘进 profile 的 `cordis.patch.yml`（官方契约明确支持「包标识符 / 绝对文件系统路径 / file URL」）。

装好后自检：`GET http://127.0.0.1:19387/xilian-pet/health` 应返回 `{"ok":true,...}`。
（本机 shell 里 `curl` 走 Schannel 会失败 —— 见 §三，用 `node -e` 或窗口的启动自检代替。）

### 插件源码热重载（已配置，需一次重启生效）

profile patch 里加了这一行，让**插件源码改动**也能热重载：

```yaml
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  disabled: false
  config:
    root:
      - '<repo>\packages\pet-plugin'
```

⚠️ **官方 README 明确要求 "configure … before launching"** —— chokidar 监视器在 `hmr` 插件初始化时建立，改 config 不会重建它。
**已实测确认**：加完这行后改插件源码，`/health` 的 `startedAt` 与 `uptimeMs` **都没变** → 没重载。**所以要重启一次 DSH 才生效**；之后就是「改代码 → 自动重载」。

判断"到底有没有热重载"的办法：`/health` 里带 `code`（代码修订号，改 `index.js` / `reducer.js` 时手动 +1）：

| 观察 | 结论 |
|---|---|
| `uptimeMs` 归零 **且** `code` 变大 | ✅ 热重载成功 |
| 两者都没变 | ❌ 没重载（需要重启 DSH） |

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

### 已验证 / 尚未验证（2026-09-30 更新）

**已验证**（截图见 `docs/screenshots/`）：

- ✅ **插件自测 43/43 通过**：状态机（优先级聚合、最短保持、`agent/status` 降档、审批计数、错误档）、归一化（三种真实签名）、mock 契约、真 HTTP 往返、真 SSE 读取、**waterfall 回归 + 负向对照**、清理注销
- ✅ **端到端实机跑通**（`phase0-live.png`）：插件热挂载 → SSE 连接 → 状态帧应用 → 绿色 `running` 光环 + 绿色连接点
- ✅ **事件协议从"推测"升级为"事实"**：59 个真实事件类型名、`SessionEventMap`、`agent/status`/`agent/error` 载荷、`SessionAssistantStreamFrame` 与 `StreamChunk`（正文在 `frame.chunk.text`）全部取自 asar 类型清单
- ✅ **窗口实机启动成功**：`260x300` 透明无边框置顶窗，点击穿透已开启，干净退出
- ✅ **alpha 掩码命中测试机制可用**：渲染端日志 `alpha 掩码就绪 256×256`，窗口 95.5% 像素全透明

**已写好代码 + 测试、等一次重启生效**（Electron 侧冻结中）：

- 🟡 **A4 状态收尾**：接上 `agent/status`（权威 `idle`/`running`），治掉"状态卡在 running"；`idle` 刻意不冲掉 `done`/`error` 的未读语义
- 🟡 **A5 逐字气泡**：按 `frame.chunk.text` + `chunkType === 'text-delta'` 取正文
- 🟡 **A6 派活/打断**：按官方调用点构造 `createUserMessage({ content, source: { kind: 'user' } })`，`cancel({ kind: 'user' })`
- 🟡 **A7 原料就位**：`approval/asked` / `approval/decided` 计数 + `notice` 帧（**纯通知事件，不碰 waterfall**）；提醒策略与免打扰时段未做

**尚未验证 / 待接线**：

- ⏳ **插件尚未真正装进 profile**（沙箱写边界 + 没有 `plugin_manager` 工具）→ **A1/A2 未验证**。两条路：GUI 插件管理页填 `packages/pet-plugin` 的绝对路径；或在你自己的终端跑 `& $NODE tools\install-plugin.mjs --write`
- ⏳ **A9「透明区不挡 DSH 界面点击」需人工在桌面上确认** —— 机制已验证，但"点在透明处真的穿过去"只能肉眼+手动试
- ⏳ **事件载荷的真实形状未知**：`session/event` 的字段归一化是**推测**。插件已内置 `GET /xilian-pet/debug/shapes` 记录真实载荷样本，装好后先看它再定案，别照猜测继续加功能
- ⏳ `agent.followup()` / `agent.cancel()` 的确切方法名待真实运行确认（代码已做多候选探测与 503 降级）

### 靠"自我截图"抓到的两个真 bug（留作教训）

窗口看不到屏幕时，`PET_SNAPSHOT=<png>` 让 Electron 截自己的窗口（只截我们的透明窗，不碰用户桌面），再加 `console-message` 诊断，一次就抓到两类问题：

1. **渲染端 JS 从未执行**：`<img id="pet">` 会自动创建 `window.pet`，与 preload 的 `exposeInMainWorld('pet', …)` 撞名 →
   `Uncaught SyntaxError: Identifier 'pet' has already been declared`。**整页 JS 静默失效**，而 CSS 正常，肉眼看截图只以为"样式没生效"。已改名：桥接对象 `window.xilianPet`、元素 `#petSprite`。
2. **默认隐藏的输入条其实显示了**：HTML 的 `hidden` 靠 UA 样式表的 `display:none`，被作者样式里的 `display:flex` 覆盖。已加 `[hidden] { display: none !important }` 兜底。

> 教训：**这个环境里不要用 pwsh 的 `-replace` 改含中文的源码** —— 一次重写把注释写成了乱码，还吞掉一个换行。改源码一律用 edit/write 工具。

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
docs/screenshots/                   实机自检截图（窗口渲染证据）
tools/
  check-plugin.mjs                  插件自测（28 项断言，不需要 DSH）
  install-plugin.mjs                插件挂载助手（检测现状 / 打印方式 / --write 追加）
  fetch-electron.mjs                Electron 二进制下载器（镜像探测 + 8 路并行 + 纯 JS 解压）
  probe-mirrors.mjs                 Electron 镜像速度实测
  make-placeholder.mjs             程序化生成占位素材
  inspect-png.mjs                   校验素材透明通道
chajian/
  环境体检报告.md                    2026-09-29 环境隐患实测报告（13 项 + 证据）
  dsh-desktop-pet-选型对比.md        独立原生透明置顶窗路线选型
  dsh-vibe-coding-插件清单.md        开发循环插件清单
  backup/                           DSH profile 配置备份（cordis.patch.yml 等）
```
