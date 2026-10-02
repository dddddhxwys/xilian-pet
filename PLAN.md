# 昔涟桌宠（xilian pet）· 调研结论与技术验证计划

> 阶段：**Phase 0 技术验证原型（spike）**
> 已确认方向：overlay + Electron 桌面透明置顶窗 · Live2D 素材 · 双向操控 agent · 主动提醒
>
> **本机环境（2026-09-29 实测，详见 [`chajian/环境体检报告.md`](chajian/环境体检报告.md)）**
> - DSH = `@deepseek-ai/dsh-desktop` **0.1.7-rc.1.20260924.1**（build `55f35f51`，channel `nightly`，Electron 外壳 44.0.0）
>   —— **不是本文早前写的 `dsh-v0.1.0-rc.8`**，全文已按实测版本订正
> - `DSH_HOME=C:\Users\怒C大伟出奇迹\.dsh`，profile = `desktop`，GUI = `http://127.0.0.1:19387`（未鉴权返回 401 = 已挂载，属正常）
> - 工作区 = `C:\Users\怒C大伟出奇迹\dsh-projects\xilian pet`（已从 `F:\dsh\project\*` 迁来；**F: 旧路径没有沙箱授权，不要搬回去**）

---

## 一、市场调研结论（摘要）

### 1. DSH 生态内已有 4 个体量不小的同类项目

| 项目 | 形态 | 素材 | 联动方式 | 关键能力 |
|---|---|---|---|---|
| PC2005-cloud/dsh-pet | DSH 插件 | WebM 透明视频 100+ 段 | DSH 会话事件 → 六档工作状态 | 提示词→素材链→插件三件套、余额分档动画、自带 Electron 桌面模式、pet pack、多开 |
| MerZlin/dsh-pet-indesktop | Python + PySide6 独立程序 | 同上 106 段 | 自带 DSH 桥接插件 + Claude hooks | 边缘探头、黄金回旋、灵动岛、待办提醒、语音报时、AI 对话、单进程多开+共享解码、省电模式、安装包 |
| cyanfish-x/dsh-live2d-pets | DSH 插件 | Live2D（内置 5 + 自定义 URL/本地路径） | Host 订阅 `agent/*` → 同源 SSE | 分部位触摸、鼠标跟随、6 人设、动画映射、设置页卡片 |
| Andersen216/dsh-whale-girl-live2d | DSH 插件 + macOS 桌面外壳 | Live2D 44 表情 / 8 动作 | `session/event` + `agent/assistant-stream` → SSE，反向 `sessionController.prompt()` | 按工具类型换脸换动作、逐字输出动嘴、钱包（余额/本轮花费/峰谷）、本地 HTTP 控制 API、alpha 掩码命中测试 |
| Gin-7/dsh-pet-remielle | DSH 插件 + 随包 Electron | GIF 贴纸 + 作品图 | `session/event` → 纯函数 `PetReducer` | 多 Session 优先级聚合 + `+N` 汇总背板、完成/出错未读提醒、双击画画、余额与今日已用双模式、一键更新 |

### 2. 非 DSH 但值得抄设计的项目

- **HaneulOscarLee/claude-pet**（Linux GTK 精灵图）：hook 桥接设计教科书——stdlib-only 桥接脚本写 `state.json`，overlay 轮询；状态有生命周期；多会话按紧急度折叠；**working 用进程 CPU 二次确认**（防中断后卡状态）；点击跳回 tmux pane。
- **Syysean/agent-pet-hub**（Tauri 2 + Rust + React）：Adapter 模式 + EventBus + 31 条转移规则状态机 + 500ms 防抖 + 皮肤插件系统 + WebSocket IPC + TTS。
- **git2968/Desktop-pet**（Electron + PIXI + Live2D）：AI 对话气泡 + 人设 + 回复触发表情动作 + Vosk 离线语音 + MCP 工具扩展。
- **nucket/NekoAI**（Tauri + Rust）：8 向光标跟随、SQLite 持久记忆、心情引擎（时段/空闲/前台应用影响动画与语气）、主动提醒。
- 经典血统：Shimeji-Desktop、Clover_Shimeji；养成型：pocket-mochi。

### 3. 该品类已收敛的"标配"六层

1. 桌面窗口层：透明/无边框/置顶/拖动/贴边/位置持久化/多屏/点击穿透/全屏自动隐藏
2. 动画状态机：待机 + 加权随机动作链 + 朝向镜像 + 交叉淡入 + `prefers-reduced-motion` + 限帧省电
3. 互动：点击 Q 弹、拖拽弹簧、甩抛反弹、抚摸手势、画圈召唤、画星传送、右键点播、滚轮缩放、托盘、音效
4. Agent 联动（核心卖点）：会话/思考/工具/流式/审批/成功/出错 → 档位动画 + 气泡；多会话聚合；未读提醒；余额用量；点击跳回会话
5. 对话与人格：AI 对话、人设台词模板、记忆、TTS/语音输入、主动碎碎念
6. 素材与扩展：宠物包格式（精灵图 / Live2D / WebM）、角色注册表、多开、适配器插件化

### 4. 相对空白的机会（我们要打的差异点）

- **双向操控普遍缺失**：几乎没人做到「点桌宠 → 派活/追问/打断/切会话」。whale-girl 只暴露了 HTTP 控制 API 让人手动调。
- **主动提醒未被认真做**：审批/提问积压、子代理运行数、上下文压缩、token 花销、goal 进度，都没有可爱化且不打扰的呈现。
- **素材门槛**：现有方案要么要会 ffmpeg 抠像，要么受 Live2D 模型版权约束；"丢一张图就能有桌宠"的路径仍缺。
- **零依赖轻量**：多数方案要下载 100–220MB Electron 或装 Python/ffmpeg，纯插件轻量路线仍有空间。

---

## 二、可利用的 DSH 官方扩展点（决定联动上限）

Cordis 插件体系：`ctx.on / once / emit / parallel / serial / bail / waterfall`（[Events API](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/events)），扩展点映射见[扩展手册](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook)。

| 用途 | 扩展点 |
|---|---|
| 状态机输入（持久事件） | `session/event`（Assistant settlement、轮次/步骤边界、工具活动） |
| 气泡打字机（实时流） | `agent/assistant-stream`（`text-delta` chunk） |
| 审批 / 提问感知 | `tools/pre-execute` 返回 `ask` + `ctx.approval`；面向模型的 ask 工具 |
| 工具与轮次边界 | `tools/pre-execute`、`tools/post-execute`、`agent/created`、`agent/pre-step`、`agent/request`、`agent/turn-stopping` |
| 双向操控 | `ctx.agents.get(sessionId).followup(userMessage)` / `.steer()` |
| UI 挂载 | `shell.overlay`（悬浮层）、`settings.section`（设置页「桌宠配置」）、Conversation 自定义节点 |
| 外部进程接入 | 宿主注册同源路由；SSE 推送；受信任栅栏（401 = 已挂载，404 = 未加载） |
| 安装/调试 | **GUI 插件管理页**（`@deepseek-ai/dsh-client-ui-plugin-manager`，本机已确认存在：安装引导、安装源、pending/approved builds 审批）。PATH 里**没有 `dsh` 命令**，npm 上的 `deepseek-harness` 只是占位包；HMR 传输（`dsh-client-hmr`）随包提供，但**重建 watcher `pnpm run dev:web` 需要一份 DSH 源码 checkout，本机没有** |

---

## 三、原型架构（Phase 0 目标）

```
DSH Host 插件 (Node, 零外部依赖)
├─ ctx.on('session/event')            轮次/步骤/工具/最终消息
├─ ctx.on('agent/assistant-stream')   逐字 text-delta
├─ ctx.on('tools/pre-execute')        审批/权限感知（只观察，不拦截）
├─ 归一化为 PetEvent -> PetReducer（纯函数状态机）
├─ 同源 SSE  GET  /api/xilian-pet/events
├─ 反向操控 POST /api/xilian-pet/prompt | /interrupt | /focus
└─ 静态资源   /xilian-pet/*.js, *.json, /model/*
          │
          ├── 渲染端 A：shell.overlay 内的透明浮动 DIV（Live2D，pixi）
          └── 渲染端 B：Electron 透明置顶窗，加载同一份 pet 页面 + 同一 SSE 源
```

> **落地实况（2026-10-02）：只做了渲染端 B，A 已放弃。**
> `shell.overlay` 内嵌需要 client 插件 bundle（构建链 + 与 DSH 版本耦合），
> 独立窗零依赖、可独立迭代 —— 于是选定只走 B。
> 连带三处变化：**A2 砍掉 / A3 重定义**（见 §四）；
> 路由前缀也从 `/api/xilian-pet` 改回 **`/xilian-pet`**
> （`/api` 是 `dsh-client-connection` 的前缀路由，exact 路由挂在它下面会被前缀规则吞掉）。
> 本节 A/B 双端与"设计要点 1"的解耦设想据此**只对 B 生效**。

**设计要点（避免踩已知坑）**

1. **渲染端与事件源解耦**：Live2D 渲染代码只有一份，A/B 两端都通过 SSE 订阅；位置、大小、开关等外观配置按端分别持久化。
2. **命中测试用 alpha 掩码**，不用包围盒——否则透明区域会挡住 DSH 界面点击（whale-girl 的教训）。
3. **多会话聚合用优先级表**（审批 > 提问 > 完成 > 出错 > 运行 > 空闲），并保留 `+N` 汇总背板。
4. **状态防抖**：状态切换加最短保持时间（参考 agent-pet-hub 500ms），避免事件突发导致闪烁。
5. **桥接最小权限**：观测类监听器绝不 `return` 决策，不 `next()`，不影响 agent 行为。
6. **降级路径**：Live2D 加载失败（模型缺失/网络不可达）→ 静态头像 + 气泡，功能不中断。

---

## 四、Phase 0 验收标准（可测的"能跑通"）

| # | 验收项 | 判定方式 |
|---|---|---|
| A1 | 插件能被 profile 加载 | 重启后 `/xilian-pet/pet.js` 返回 401（或满屏 JS） |
| ~~A2~~ | ~~设置页出现「桌宠配置」~~ **已砍掉（2026-10-02）** | 不适用：不走 GUI 内嵌。配置改由 `packages/pet-plugin/cordis.patch.yml` 承载，不对用户暴露 GUI 设置页 |
| A3 | **独立窗里出现宠物并待机动画**（2026-10-02 重定义） | 启动 `start-pet.cmd` → 独立透明窗里出现昔涟并播待机动作 `Scene[3]`（荡秋千），控制台无报错 |
| A4 | 真实会话事件驱动状态 | 发一句话 → 思考/工具/完成 三态可见切换 |
| A5 | 逐字流进气泡 | 回复时气泡文字逐字增加 |
| A6 | **双击气泡派活**（差异点 1） | 打字发送后 agent 收到并回复 |
| A7 | 审批积压主动提醒 | 触发一次需审批的工具 → 宠物冒泡提醒 + 单击跳转 |
| A8 | Electron 透明置顶窗 | 独立小窗显示同一宠物，可拖动，透明无边框 |
| A9 | 点击穿透 | 宠物透明区域不挡 DSH 界面点击 |
| A10 | 模型缺失时降级 | 故意改错模型路径 → 静态头像 + 气泡仍可用 |

**Phase 0 明确不做**：养成数值、语音、多开碰撞、多宠物注册表、打包发布、素材生成链。

> **A2/A3 为什么改（2026-10-02）**：Phase 0 最终路线是「Host 插件 + 独立 Electron 透明窗」，
> 而原 A2/A3 的判定方式都是按 **GUI 内嵌**（`settings.section` / `shell.overlay`）写的，
> 随该路线一起失效。
>
> - **A2 → 砍掉**，不是"待办"：桌宠的配置项本来就只有提醒开关 / 概率门 / 免打扰时段这几项，
>   写在 `packages/pet-plugin/cordis.patch.yml` 里、整块可省略（代码内有默认值）。
>   为它单做一个设置页卡片，收益远小于"要维护一条 client bundle 构建链"的成本。
> - **A3 → 重定义为「独立窗里出现宠物并待机动画」**，状态 **✅**。
>   注意这条在独立窗路线下与 **A8 是同一件事的两半**：A3 看**内容**（模型渲染出来、待机动作在播），
>   A8 看**窗体**（透明、置顶、可拖动）。两者都有截图与参数采样证据（见 `README.md` §十）。

---

## 五、执行顺序

1. ~~**环境与格式确认**~~ → **已于 2026-09-29 完成**：本机 DSH = `0.1.7-rc.1`；`dsh.bundle.patch`、`shell.overlay`(40 处)、`settings.section`(39)、`session/event`(148)、`agent/assistant-stream`(12)、`agent/pre-step`(76)、`tools/pre-execute`(45)、`tools/post-execute`(50)、`agent/turn-stopping`(18) 等扩展点**已在 `app.asar` 内逐一确认存在**；插件安装通道 = GUI 插件管理页。**剩余未决项**：是否需要一份 DSH 源码 checkout 以启用 `dev:web` HMR 重建链。详见 `chajian/环境体检报告.md`。
2. **最小插件骨架**：Host 插件注册 SSE + 静态资源；client 端一个 div 出现在右下角（先不放 Live2D），跑通 A1/A2/A3。
   → **2026-09-29 已按修订决策落地（改为独立 Electron 窗、不写 client 插件）**：Host 插件（纯 ESM、零依赖、零构建）+ Electron 透明置顶窗 + 程序化占位素材 + 28 项自测全部通过。
   ⚠️ ~~尚未装进 profile（沙箱写边界）→ **A1/A2 待验证**；窗口未实际启动（Electron 下载中）→ **A3/A8/A9 待验证**。~~
   → **2026-10-02 已结清**：**A1 ✅**（`/health` 正常）、**A2 砍掉**、
   **A3 ✅**（重定义后）、**A8 ✅**（可拖动、透明无边框）；
   **A9 仍待人工肉眼确认**（机制已重做并逐条核对日志，但"真的穿过去"只能你确认）。
   状态以 `README.md` §十「验证状态（诚实版）」为准。
3. **事件层**：`session/event` + `agent/assistant-stream` 归一化 → `PetReducer` 纯函数 + 单测（Node 内置 `node --test`，零依赖）；跑通 A4/A5。
4. **Live2D 渲染**：引入 Cubism Core + pixi + pixi-live2d-display，实现状态→动作/表情映射；命中测试 alpha 掩码；跑通 A9/A10。
   → **2026-10-02 变更：不再自研模型，改用现成授权模型。**
   经调研找到 **B站 @是依七哒** 的「秋千版」昔涟 Live2D 模型，作者要求**注明用途 + 不得收费**，已获授权。
   **原「A 档约稿」方案冻结**（`docs/Live2D约稿单.md` 转为暂缓备用，将来想换自研形象可直接启用）。

   ⚠️ **技术选型被版本钉死**（实测，见 `README.md` 第六节）：

   | 项 | 结论 |
   |---|---|
   | 模型 | **Cubism 5.0**（`.moc3` 头 `4D 4F 43 33 05`，版本号 5） |
   | Core 支持上限 | 官方最新 Core 定义 `MocVersion_50 = 5` → **刚好支持** |
   | 因此 Must | `pixi.js@^7` + **`pixi-live2d-display@0.5.0-beta`** + 官方最新 Cubism Core |
   | 陷阱 | npm 的 `latest` 是 **0.4.0（2022年，配 PixiJS v6，且完全不感知 moc3 版本）**，绝不能装到它 |
   | 参考实现 | `Playa-Cyrene/Cyrene-Agent`（642★，MIT）用的正是这个组合 |

   模型已修复三处问题（`tools/fix-live2d-model.mjs`）：补 `Motions`/`Expressions` 声明（原清单未挂，
   不改则动作表情全不加载）、补 `LipSync` 分组、纹理 8192→2048。
5. **双向操控**（差异点 1）：气泡输入 → `followup()`；中断按钮 → `cancel()`；跑通 A6。
6. **主动提醒**（差异点 2）：审批/提问积压、待办到点、久坐、本轮花销 → 可配置概率门 + 免打扰时段；跑通 A7。
7. **Electron 桌面窗**：透明置顶 + 点击穿透 + 拖动 + 单实例；跑通 A8。
8. **接线与文档**：本仓库 `AGENTS.md` / `README.md` / 事件协议文档；整理哪些结论要回流到 `PLAN.md`。

---

## 六、待确认/风险

| 风险 | 状态 | 影响 | 应对 |
|---|---|---|---|
| ~~本机 workspace ACL 异常（`SetNamedSecurityInfoW failed (Win32 5)`）~~ | ✅ **已解决** | — | 工作区已迁至 `C:\…\dsh-projects\xilian pet`，沙箱授权 ACE 正常。**注意 F: 旧路径仍无授权，搬回去即复现** |
| **沙箱写边界 = 工作区 + TEMP** | ⚠️ **现存（高）** | `~/.dsh/profiles/desktop`（插件安装目标）与 pnpm store（`%LOCALAPPDATA%\pnpm`）写入均被拒 → 命令行装插件必失败，每步需提权 | 装插件走 **GUI 插件管理页**；纯前端依赖实验用 `pnpm --store-dir .\.pnpm-store add …`；必要时对安装命令提权 |
| **agent shell 内 Schannel TLS 全挂** | ⚠️ **现存（高）** | `curl` / PowerShell / `git` 默认后端的 HTTPS 全部失败（`SEC_E_NO_CREDENTIALS`）→ 任何靠 PS/curl 下载的脚本会静默失败 | 联网固定走 Node 系（npm/pnpm/`node fetch`）；git 加 `-c http.sslBackend=openssl`；网页抓取用 `web_fetch` |
| **Electron / Chromium 无法在 agent shell 内启动** | ⚠️ **现存（高，2026-09-29 实测）** | Chromium 的 Mojo IPC 走**命名管道**，受限沙箱禁止创建 → `FATAL platform_channel.cc: Check failed: 拒绝访问 (0x5)`；`--no-sandbox` 也绕不过。**我无法自己运行宠物窗口做验证** | 启动脚本已内置探测与自动放宽（`--no-sandbox --disable-gpu`）；实机验证需提权单次执行，或由你在自己终端跑（见 `README.md` §3.5） |
| **Electron 二进制安装链路在本机是坏的** | ⚠️ **现存（中）** | postinstall 被 pnpm 拦；放行后 `install.js` 因缓存目录在工作区外而失败、改到工作区内仍空转；镜像速度差 130 倍（npmmirror 85 KB/s vs 华为云 11 MB/s） | 用 `tools/fetch-electron.mjs`（镜像探测 + 8 路分段并行 + 纯 JS 解压）；`tools/probe-mirrors.mjs` 可复测 |
| **`github.com` / `raw.githubusercontent.com` 不可达** | ⚠️ **现存（中）** | GitHub 源码 clone、raw 链接抓取失败 | 走 npm registry、`codeload.github.com` tarball 或镜像 |
| **没有可编辑的 DSH 源码树 → `dev:web` HMR 重建链不可用** | ⚠️ **现存（中）** | 自研插件改代码后无法自动热重载，需重新安装；官方的"改一行就重载"循环拿不到 | 先决定是否需要一份 DSH 源码 checkout；不需要就接受"改→重装"循环 |
| **插件安装命令不存在** | ⚠️ **现存（中）** | 文档里的 `dsh plugin --profile desktop add <name>` 会 command not found（PATH 无 `dsh`；npm 上 `deepseek-harness` 是占位包） | 用 GUI 插件管理页；CLI 调用方式待确认 |
| **DSH 版本漂移 + 精确版本闸门** | ⚠️ **现存（中）** | 本机 `0.1.7-rc.1`，channel = `nightly`（`app-update.yml` 指向 `download.deepseek.com/dsh-desk/feeds/win-x64/`）→ 可能被自动更新悄悄换版；且 DSH 对第三方插件有**精确版本兼容闸门**，不匹配会以 `incompatible-version` 拒绝 | 桥接层集中在一处，事件名与路由做集中常量 + 启动自检；每次开工先核 `asar/dsh/package.json` 版本；确需装不匹配插件用 `dsh plugin allow-version … --accept-risk` |
| **WMI/CIM 被拒** | ⚠️ **现存（低-中）** | `Get-CimInstance` / `Get-Volume` 拒绝访问 → 依赖 WMI 的脚本失败 | 改用 `cmd /c vol`、`fsutil fsinfo drivetype`、`Get-PSDrive` |
| **路径含空格 + 用户名非 ASCII** | ⚠️ **现存（低-中）** | 少数 CLI / node-gyp / 打包器对 `xilian pet`（空格）与 `怒C大伟出奇迹`（中文）处理不当 | 脚本路径一律加引号 + `path.resolve`；构建异常时优先怀疑路径，用纯 ASCII 短路径复测。`LongPathsEnabled=1` 已开，长路径无忧 |
| 当前 profile 是 `desktop` 而非文档常见的 `web` | 保留 | 静态资源路由细节需按 desktop profile 校准 | 以 `DSH_PROFILE_DIR` / `cordis.patch.yml` 实际内容为准（profile 内 `nodeLinker: hoisted`、`autoInstallPeers: false`，peer 不会自动补装） |
| ~~角色/模型版权~~ | ✅ **已按官方条款核实（2026-09-30）** | 曾误判为"不得公开分发" | 依《崩坏：星穹铁道》同人衍生作品创作指引 **V3.0**（2025-07-15）三、Q1 A1：**非商业性质的个人使用可以制作"并发布"衍生内容**。须遵守：① 同步放置指定法律声明；② 严格非商业（不收费/不销售/不做周边）；③ 不得暗示官方关联；④ 不得使用未公开素材；⑤ 须为二次独创。**已落地为仓库根 `NOTICE.md`**。另有两条**不适用**于本项目：二（三）维权范围针对"提取+销售"，我们不销售；四 Q4 禁止的是**该游戏的插件/mod**，我们的 DSH 插件与该游戏无关（文档措辞须避免被误读） |
| 素材是否入库 | ✅ **已随路线作废（2026-10-02）** | — | 原来的 36 MB **自研素材导出包**（含绿幕版与历史版）是"约稿自研形象"路线的产物，**该路线已放弃**（改用现成授权模型），故"素材入不入库"这个问题**不再成立**。现行规则：**第三方模型不入库**（`assets/live2d/` 已 gitignore），版权与署名见 `NOTICE.md` 与 `README.md` §九「素材与版权约束」 |
| Live2D SDK 体积与渲染开销 | 保留 | 影响低配机器与"轻量"定位 | 限帧渲染、页面隐藏暂停、可降级静态头像 |
| ~~角色名不一致~~ | ✅ **已统一为「昔涟」（2026-09-30）** | — | 全仓 24 处中文显示文本已改名。ASCII 标识（目录 `xilian pet`、插件 id `@local/xilian-pet-plugin`、仓库名 `xilian-pet`）**无需改动** —— "西莲"与"昔涟"拼音同为 `xilian` |
| 第三方插件 = 宿主进程执行权 | 保留 | 沙箱不是安全边界（#1441/#451/#250 至今 open）；`cordis.patch.yml` 允许 `!!js` 表达式 = 配置期代码执行 | 装前跑 `@shaoshi/dshscan` + 看 socket.dev；带 ⚠️ 的包先审源码；改 patch 前先备份（备份已放在 `chajian/backup/`）；**拒绝 `!!js`** |
| 工作区无版本控制 | ⚠️ **已处理** | 无回滚 | 已 `git init` 并首次提交；后续每次可运行节点前提交一次 |

---

## 七、调研来源

- DSH 侧：[dsh-pet](https://github.com/PC2005-cloud/dsh-pet)、[dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop)、[dsh-live2d-pets](https://github.com/cyanfish-x/dsh-live2d-pets)、[dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d)、[dsh-pet-remielle](https://github.com/Gin-7/dsh-pet-remielle)
- 其他 agent 桌宠：[claude-pet](https://github.com/HaneulOscarLee/claude-pet)、[agent-pet-hub](https://github.com/Syysean/agent-pet-hub)、[Desktop-pet](https://github.com/git2968/Desktop-pet)、[NekoAI](https://github.com/nucket/NekoAI)、[pocket-mochi](https://github.com/rongtaocheng32-ctrl/pocket-mochi)、[GooglePiggy_DesktopPet](https://github.com/Myf-ricey/GooglePiggy_DesktopPet)、[Shimeji-Desktop](https://github.com/DalekCraft2/Shimeji-Desktop)
- DSH 文档：[扩展手册](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook)、[Events API](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/events)
