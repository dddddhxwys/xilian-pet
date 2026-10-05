# 昔涟桌宠（xilian pet）

桌面透明置顶窗桌宠：昔涟的 Live2D 模型待在桌面上，跟着 DSH agent 的状态切换动作，
可拖拽、点击穿透、右键唤出操作面板、审批积压主动提醒。

| | |
|---|---|
| 当前阶段 | **Phase 0 技术验证原型（spike）** —— 能跑；6 项修复 + A9 已经用户实机确认（2026-10-02） |
| 架构 | Cordis Host 插件（大脑）+ Electron 透明窗（显示器），中间走 SSE |
| 模型 | B站 @是依七哒「秋千版」昔涟，**已授权、不入库**，署名见 [`NOTICE.md`](NOTICE.md) |
| 规模 | 插件 5 文件 2253 行 / 外壳 18 文件 4779 行 / 工具 14 文件 3672 行，123 个提交 |
| 自测 | `& $NODE tools\check-plugin.mjs` → **116 项全绿** |

> 📌 **接手/继续开发请先读 [`docs/交接说明.md`](docs/交接说明.md)** —— 那份是给下一个对话窗口的，
> 含架构决策、验证状态、踩坑清单、调试开关。本文偏"环境事实与边界"。
> 方向与验收标准见 [`PLAN.md`](PLAN.md)；环境实测数据见 [`chajian/环境体检报告.md`](chajian/环境体检报告.md)。

---

## 一、本机环境事实（2026-09-29 实测，改动前先核）

| 项 | 值 |
|---|---|
| DSH | `@deepseek-ai/dsh-desktop` **0.1.7-rc.1.20260924.1**（build `55f35f51`，channel `nightly`，DSH 自身 Electron 外壳 44.0.0） |
| DSH_HOME | `C:\Users\怒C大伟出奇迹\.dsh` |
| profile | `desktop` → `C:\Users\怒C大伟出奇迹\.dsh\profiles\desktop` |
| GUI | `http://127.0.0.1:19387`（未鉴权 401 = 已挂载，属正常） |
| 工作区 | `C:\Users\怒C大伟出奇迹\dsh-projects\xilian pet` |
| 桌宠自己的 Electron | **44.5.1**（与 DSH 自带的 44.0.0 无关，独立装在 `node_modules/electron/`） |
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

`curl` / PowerShell `Invoke-WebRequest` / `git` 默认后端做 **HTTPS** 时报
`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`
（系统加密服务正常，是该 shell 的受限令牌所致）。**纯 HTTP 不受影响**（例如探 `/health` 是可以的）。

```powershell
# ❌ 会失败（HTTPS）
curl.exe https://registry.npmjs.org/-/ping
Invoke-WebRequest https://registry.npmjs.org/-/ping
git ls-remote https://gitee.com/...

# ✅ 可用
npm ping
git -c http.sslBackend=openssl ls-remote https://gitee.com/...
& $NODE -e "fetch('https://api.github.com/repos/electron/electron').then(r=>console.log(r.status))"
```

> **Node 的 `fetch` 是最可靠的联网方式**，实测 10/10 个外部站点可达（含 `electronjs.org`、`api.github.com`）。
> harness 的 `web_fetch` 工具多数站点会被"非公网 IP"过滤挡掉，抓网页优先用 Node fetch。

### 3.3 网络可达性（实测）

- **可达**：`registry.npmjs.org`、`registry.npmmirror.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`
- **超时**：`github.com`、`raw.githubusercontent.com`、`www.google.com`
- **推论**：`git clone github.com` 会失败；拿 GitHub 源码走 npm registry / codeload tarball / 镜像。

### 3.4 其他能力缺口

- `Get-CimInstance` / `Get-Volume` **拒绝访问**（WMI 受限）→ 用 `cmd /c vol`、`fsutil fsinfo drivetype`、`Get-PSDrive`
- `ffmpeg` **未安装**
- 工作区路径含**空格**（`xilian pet`）、用户名**非 ASCII**（`怒C大伟出奇迹`）；`LongPathsEnabled=1` 已开。
  脚本路径一律加引号 + `path.resolve`，构建异常时优先怀疑路径。

### 3.5 ⚠️ Electron 无法在 agent shell 里启动（重要）

Chromium 的 Mojo IPC 在 Windows 上用**命名管道**，受限沙箱禁止创建：

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:108] Check failed: 拒绝访问。 (0x5)
```

即使加 `--no-sandbox` 也一样（默认沙箱下更早就以 `0x80000003` STATUS_BREAKPOINT 崩掉）。

- **agent 里跑不起来宠物窗口** → 实机验证必须对该条命令提权（`danger-full-access`，已实测可行）
- **用户自己终端里没有这个限制** → 日常使用让用户双击 `start-pet.cmd`
- 启动脚本内置探测：Chromium 沙箱初始化失败时自动追加 `--no-sandbox --disable-gpu` 并打印原因

---

## 四、快速上手

### 前置条件

| 依赖 | 怎么补 |
|---|---|
| DSH 在跑，插件已挂载 | `/health` 应返回 `{"ok":true,...}` |
| Electron 二进制 | `& $NODE tools\fetch-electron.mjs` |
| 渲染端 vendor（pixi + Cubism Core） | `& $NODE tools\prepare-renderer-vendor.mjs` |
| Live2D 模型 | 手动放到 `assets\live2d\Cyrene\`（**不入库，clone 后没有**） |

> `node_modules/electron/`、`renderer/vendor/`、`assets/live2d/` 都在 `.gitignore` 里。
> **换机器 clone 后必须补上面后两项**，否则只剩占位形象（会走 A10 降级，不会崩）。

### 跑起来

```powershell
# 双击仓库根的 start-pet.cmd，或者：
cd "C:\Users\怒C大伟出奇迹\dsh-projects\xilian pet"
.\start-pet.cmd

# 只自检不开窗
.\start-pet.cmd --check
```

**退出：`Ctrl + Shift + Q`**（启动脚本注册的全局快捷键）
> ⚠️ 窗口没有边框、不在任务栏里，**没有关闭按钮**。关掉控制台窗口也能退，但比较粗暴。

### 操作

| 操作 | 效果 |
|---|---|
| 悬停在角色不透明处 | 窗口接管鼠标（透明区域鼠标**穿过去**，不挡下层） |
| 按住角色拖动 | 移动位置，位置自动记住 |
| **右键角色** | 唤出**操作面板**（独立小窗：会话切换 / 派活 / 打断 / 用量） |
| 单击**两侧秋千** | **弹她一下**（整体位移 + 上跳 + 轻微倾斜 + 身体内部跟着颤） |
| 拖动松手 | **秋千余摆 + 眨一下眼**（像是"被放下后稳了一下"） |

> ⚠️ 单击**其它区域**（头 / 左手 / 右手 / 身体 / 腿）的分区互动**还没做** —— 目前无反应。
> 曾经的"单击清未读"已按用户要求**整体移除**（2026-10-05："把未读功能去除"）。

> 双击曾经也是"唤出面板"，**已按用户要求去掉**（只剩右键一条路）。

---

## 五、架构与目录

```
DSH 宿主
  │  事件（session/event, agent/assistant-stream, agent/status, agent/error）
  ▼
packages/pet-plugin/          ← Cordis Host 插件（零依赖、零构建）
  index.js                    路由 + 4 个监听器 + 提醒 tick
  reducer.js                  纯函数状态机（会话 → 桌宠状态）
  reminders.js                主动提醒策略引擎（纯函数）
  cordis.patch.yml            挂载层（bundle 方式 / 免安装直挂方式）
  │  SSE  /xilian-pet/events
  ▼
packages/pet-shell/           ← Electron 透明置顶窗
  main.js                     透明置顶 + SSE 订阅 + pet:// 协议 + 光标轮询命中测试
                              + 窗口位置/构图缓存持久化 + 自检截图
  preload.cjs                 最小 IPC 桥（只暴露桌宠需要的几件事）
  hit-test.js                 命中测试纯函数（UI 控件矩形 + alpha 掩码 → 是否接管鼠标），可自测
  renderer/
    index.html                CSP + vendor 脚本加载顺序
    pet.css                   透明窗口样式（z-index 分层是踩过坑的）
    pet.js                    命中、拖拽、气泡、派活条（普通脚本）
    live2d.js                 Live2D 渲染层（**ES 模块**，动态 import）
    vendor/                   pixi + unsafe-eval + Cubism Core + cubism4（gitignore）
  scripts/launch.mjs          启动脚本（处理 ELECTRON_RUN_AS_NODE 等本机坑）
  .state/                     窗口位置 / 构图缓存（gitignore）
```

### 为什么是这个架构

| 决定 | 原因 |
|---|---|
| **插件 + 独立窗**，不做 GUI 内嵌 | 内嵌需要 client 插件 bundle（构建链 + 版本耦合）；独立窗零依赖、可独立迭代 |
| **SSE 放主进程** | 渲染端 origin 是自定义协议，EventSource 会撞 CORS；主进程订阅没这问题，重连也好管 |
| **`pet://` 自定义协议**（页面 + 模型同源） | Cubism 要把 `.moc3` 读成 ArrayBuffer（走 XHR），而 Chromium 禁止跨源。同源后 CORS 问题消失，CSP 也能收紧回 `'self'` |
| **CSP 保留 `'wasm-unsafe-eval'`、拒绝 `'unsafe-eval'`** | Cubism Core 是 wasm；PixiJS 需要 eval，用官方 `@pixi/unsafe-eval` 替代（不放宽 CSP） |
| **`live2d.js` 是 ES 模块** | 两个普通 `<script>` 共享全局作用域，撞过两次（见 §十一）。用**动态 import** 是为了保留"失败仍能降级到占位图" |
| **窗口位置/缓存存包内 `.state/`** | Electron 默认 userData 在 AppData，agent shell 沙箱写不进去 |

---

## 六、Live2D 渲染层

### 模型

角色形象用 **B站 @是依七哒** 制作的「秋千版」昔涟。

| 项 | 内容 |
|---|---|
| 模型 | `Cyrene`（**Cubism 5.0**，`.moc3` 版本号 5） |
| 授权 | **注明用途 + 不得收费**（作者要求）；不进 MIT 范围；**入库禁止** |
| 署名 | 见 [`NOTICE.md`](NOTICE.md) 第四节（**必须保留**） |
| 位置 | `assets/live2d/Cyrene/`（整个 `assets/live2d/` 已 gitignore） |
| 体积 | 纹理降采样后 **1.38 MB**（原 8.86 MB） |

### 技术栈（版本钉死，别随手升）

```
Electron 44.5.1
└─ pixi.js@7.4.3
   └─ pixi-live2d-display@0.5.0-beta     ← 必须 beta
      └─ 官方 Cubism Core 5.1.0（含 MocVersion_50）
```

> ⚠️ `pixi-live2d-display` 的 npm `latest` 是 **0.4.0（2022 年，PixiJS v6，不认 moc3 版本号）**，
> 装它会得到"模型版本不支持"。0.5.0-beta 才认 Cubism 5。参考实现：
> `Playa-Cyrene/Cyrene-Agent`（642★，MIT）用的是同一套组合。

### 接入时必须做的三处修复（`tools/fix-live2d-model.mjs` 可重放）

1. **补 `Motions` / `Expressions` 声明** —— 原 `model3.json` 只有 394 字节，没挂动作和表情，
   不改的话运行时 **4 个动作 + 13 个表情一个都不会加载**
2. **补 `LipSync` 分组** —— 原为空，导致说话口型不可用
3. **纹理 8192 → 2048** —— 显示仅约 250px 高，8192 超标 30 倍

> ⚠️ 降采样**不能直接 resize**：该纹理是**直通 alpha**，且 5680 万个全透明像素里存了垃圾 RGB。
> 直接四通道重采样会把这些颜色插值进边缘 → **黑边**（实测 24.5% 的边缘像素差异 > 120）。
> 正确做法是 **预乘 → LANCZOS → 反预乘**，见 `tools/downsample-texture.py`。

> ⚠️ 模型**未声明 `HitAreas`**，不能用 `model.hitTest()`，点击命中需自行实现 alpha 掩码测试。

### 四个动作（都叫 `SceneN`，内容是反推出来的）

| 动作 | 时长 | 内容 | 独有参数 |
|---|---|---|---|
| `Scene[0]` | 3s | **比嘘手势**（半眯眼 wink，手指举到唇边 / 用户看画面描述为"一只手放在下巴处握拳"） | `Param15 嘻嘻` `Param5 星星` `Param12 手指` |
| `Scene[1]` | 4s | **叉腰 + 星光**（闭眼笑） | `Param7 闪耀` `Param17/18 叉腰1/2` |
| `Scene[2]` | 3s | **招牌姿势 + 张嘴说话 + 甩头** | `Param10/11 招牌1/2` `嘴开闭` |
| `Scene[3]` | 180s | **荡秋千**（长期待机用） | `Param13/14 秋千` `Param31/32` 腿鞋摇晃 |

**反推方法**：`PET_SAMPLE_PARAMS=1` 采样各动作驱动的参数（比逐帧截图精确得多，且便宜）。

### 状态 → 动作映射（`live2d.js` 的 `STATE_MAP`）

| 状态 | 动作 | 表情 | 备注 |
|---|---|---|---|
| `idle` | Scene[3] 荡秋千 | reset | 180s 长循环 |
| `running` | **不播动作**（`motion: null`） | reset | + `Param9 思考` → 保持"一只手放下巴"的思考姿势。**为什么不用动作**：`Scene[0]` 内含"右手比嘘"且循环 → 干活时一遍遍比嘘（"很聒噪"）。**"三只手"的真因是"停动作不关道具"**：模型的手/道具是开关参数画的（`Param9`/`Param12`/`Param16`…），`stopAllMotions()` 不会关它们 → 残道具叠上来。所以 `stopAllMotions()` 会 `clearPropParams()` 把 32 个道具开关归零 |
| `approval` | Scene[1] **只播一次** | surprise | `keepEffect: true`（特效留着，表达"还在等你"） |
| `question` | Scene[2] | question | 循环，要一直等回答 |
| `done` | Scene[1] **只播一次** | happy | 演完**特效也撤** |
| `error` | Scene[3] | reset | ⚠️ 模型**没有**"困扰"参数，靠 `ERROR_FACE` 手工凑眉毛 |

### 气泡显示什么（活动摘要，**不显示 AI 正文**）

用户反馈：把 AI 正文逐字灌进气泡，"输出太多，根本看不清"。
现在气泡只回答一个问题 —— **它现在在干什么 / 刚干完什么**：

| 事件 | 气泡文案 |
|---|---|
| `turn/start` | 开始处理新任务 |
| `step/start` | 分析中… |
| `tool/call`（`pwsh` / `shell`） | 执行了命令 |
| `tool/call`（`read` / `edit` / `write` / `grep` / `glob` …） | 读取了文件 / 修改了文件 / 搜索了代码 … |
| `tool/call`（未收录的工具） | 执行了 &lt;工具名&gt; |
| `tool/result` | 这一步完成了（失败则"这一步失败了"） |
| `assistant/message` | 已完成分析 |
| `turn/end` | 这一轮完成了 / 出错了 / 已中断 |

- 映射是**纯函数** `activityLabel()`（`reducer.js`），因此可自测；连续相同的摘要会去重，不刷屏。
- AI 正文仍留在 `/state` 的 `tail` 里供诊断，**只是不再进气泡**。
- 想回到旧的逐字流：配置 `bubbleMode: 'stream'`（`packages/pet-plugin/cordis.patch.yml`）。

### 主动提醒的显示（A7）

插件侧早就在推 `notice` 帧（审批积压 / 久坐 / 花销），但窗口里原来什么都不显示。
现在有独立的**通知条**，与气泡**分层错开**（通知在顶、气泡自动让位）：

| | 气泡 | 通知条 |
|---|---|---|
| 说什么 | "它现在在干什么"的流水 | "要你注意 / 要你动手" |
| 何时消失 | 固定 6 秒 | **urgent 不自动消失**（点它才收）；低优先 8 秒 |

- **urgent**（审批积压）带小圆点脉冲动画，专门等你去处理
- **单击通知条 → 把 DSH 窗口唤到前台**（`main.js` 的 `focusDshWindow()`）。DSH 是**另一个进程**的
  Electron 应用，所以桌宠走 Win32 把它的窗口拉出来，三个要点都是实机踩出来的：
  1. **按标题匹配，不能只按进程名** —— DSH 的窗口**不属于**那两个叫 `DeepSeek Harness` 的进程，
     只按进程名匹配会一个都枚举不到（实测就是"点了没反应"的原因）。
     现在按「PID 在名字集合里 **或** 标题含 `Harness|DSH|DeepSeek`」筛，再取**面积最大**的那个
     （Electron 有多个窗口，挑错了会激活一个看不见的辅助窗）。
  2. **要绕 Windows 前台锁** —— `SetForegroundWindow` 在调用方不是前台进程时会**返回 true
     但只让任务栏闪一下**。所以先 `AllowSetForegroundWindow(-1)` + `AttachThreadInput` 再设置。
  3. **结果写 `.state/focus-log.txt`** —— agent 读不到桌宠控制台，"点了没反应"只能靠这个文件定位。
- 想手动看效果（不必真等一次审批积压）：

```powershell
# ⚠️ 中文**必须发字节**：PowerShell 5.1 的 `-Body <字符串>` 默认按 ASCII 编码，
#    中文会变成 `?????`（实测踩过，渲染端拿到的就是坏字符串）。
$json = '{"text":"有 2 个操作在等你审批","urgent":true}'
Invoke-RestMethod -Method Post http://127.0.0.1:19387/xilian-pet/debug/notice `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
```

### 诊断端点

| 端点 | 用途 |
|---|---|
| `GET /debug/shapes` | 原始事件形状样本。**判断消息来源**：桌宠派活发的 `user/message` 其 `source` 只有 `{kind:'user'}`；GUI 发的带 `rpcId` |
| `GET /debug/agents` | 派活链路诊断（只读）：候选会话 / 活 agent / 各候选能否 `get()` |
| `POST /debug/notice` | 手动放一条通知（A7 显示侧的手动验证入口） |
| `GET /debug/reminders` | 提醒引擎配置 / 免打扰判定 / 已发记录 |

### token 用量与缓存命中率（口径照抄宿主）

宿主 `tokenMeter` 的官方口径是**四个桶**（asar 里 `usage-projection.js`），我们照抄：

```js
{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
//  ← usage.inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
```

实测某一次真实载荷：

```json
{ "inputTokens": 664, "outputTokens": 153, "cacheReadTokens": 9600,
  "cacheWriteTokens": 0, "totalTokens": 10417 }
```

- **用量** = 四桶之和
- **缓存命中率** = `cacheReadTokens / (cacheReadTokens + uncachedInputTokens)`（这里 = 93.5%）
- ⚠️ **不能用 `totalTokens` 累加**：它已经把 `cacheReadTokens` 算进去了，
  而那 9600 是**整个上下文被重发**。逐轮累加 = 把同一段上下文数几十遍
  —— 实测就是这么报出 **3390 万** tokens 的。
- 同一 `(turn, step)` 重复上报要**替换**而不是累加；`llm/retry-started` 则取消去重
  （重试确实又消耗了一次）。这两条都与宿主逐字对齐。

### 数据源：读宿主的 durable projection（不要自己算）

插件自己累加出来的数是"**自插件启动以来**"的 —— **DSH 一重启就归零**。所以数字以宿主为准：

```js
ctx.sessionProjections.stateOf(session, 'tokenUsage').totals   // ← 就是四桶
```

- 宿主的 `tokenUsage` 是 **session projection**：从会话日志重放，**重启不丢** —— 这才是"这个会话一共用了多少"
- 键必须是**宿主给的 session 对象**（投影内部是以对象为键的 `WeakMap`，拿 `sessionId` 字符串查不到）
  → 插件在 `session/event` 里顺手把 session 对象存进 `sessionObjects`
- 读不到（服务缺失 / key 未注册 / 没拿到 session 对象）**不报错**，退回插件自算的兜底值；
  `/state` 里的 `tokenSource` 会告诉你是 `'host'` 还是 `'own'`
- 刷新时机：**数字要被用到之前**（`/state`、SSE 的 snapshot、提醒引擎的定时 tick），
  不必每个事件都刷 —— `stateOf` 只是一次 WeakMap 查表，但没必要浪费

### 操作面板（**独立小窗**）

右键她 / 双击她 → 在她**旁边**弹出一个小窗，**同时她弹一个问号表情**。

| 区域 | 作用 |
|---|---|
| **派活目标** | **可折叠**：折叠态只占一行（当前目标 + 状态点 + 箭头），点它展开最近 5 个会话，选完自动收起。**只切换"活派给谁"，不动 DSH 界面**。标题取自宿主 `title` 投影 |
| **输入框** | 多行；**Enter 发送 / Shift+Enter 换行** |
| **派活 / 打断** | 动作在**主进程**执行（它持有 `postControl`），结果回报给面板 + 桌宠气泡 |
| **本次会话 / 缓存命中** | token 用量（数据来自宿主 durable projection） |

#### 为什么底部输入条被整个删掉

它原来是画在桌宠窗口里的（`#composer`，`bottom:0` 高约 34px）。窗口 300px 高、她本体占
`y ∈ [87,294]`，而输入条占 `y ∈ [266,300]` —— **重叠 28px，正好压住她的裙摆和脚**。
这跟右键菜单当初的问题是同一个：**260×300 里没有多余的地方**。所以：

- 输入条、派活、打断**全部搬进面板** → 桌宠窗口只剩她 + 通知/气泡/徽标，**脚不再被压**
- 面板**只由右键唤出**（双击曾是第二条路，已按用户要求去掉）
- 面板是独立窗口，尺寸自由（300×320），会话列表才放得下

#### 几个刻意的选择

- **HTML 自绘**，不用 Electron 原生 `Menu`（原生是 Windows 灰菜单，风格不搭）
- **竖直与她「身体」居中**：`contentBand()` 从 alpha 掩码算内容范围（实测 86..292 → 中心 189），
  而不是按窗口几何中心（那会比她身体**高 40px**）、也不是跟着右键高度走
  （点得低菜单就吊在她脚下）。掩码还没到时退回窗口中心
- **右优先**定位（右边放不下换左侧），并夹在工作区内
- **`menu:ready` 补发数据**：`loadFile()` 是异步的，`show()` 时主进程就 `send`，
  渲染端监听器还没注册 → **IPC 消息直接丢**，面板里永远是"—"（实测踩到）。
  与桌宠窗口的 `pet:ready` 补发是同一套路
- **输入框非空时失焦不关窗**：字打了一半、鼠标点到别处就关掉，内容全没了。
  所以面板内有未发送内容时只认 Esc 收起（草稿会留着，下次打开还在）
- **问号不会被误清**：`question` 状态（agent 在等你回答）的问号是**常驻**的。
  恢复时是"重新应用当前状态该有的表情"；一次性特效态（`done`）则恢复成**基础表情** ——
  否则会把已撤掉的闭眼笑**复活**（踩过，A/B 抓图验证）
- **会话按 `lastActivityAt` 排序**（`snapshot` 里新暴露的字段）：不能靠插入顺序 ——
  那是"谁先出现"不是"谁最近活跃"
- **会话标题来自宿主的 `title` 投影** —— 这个我**走错过一次路，值得记**：
  插件原来只能从事件里捡 `title`，实测 45 条 `session/event` 样本一条都没带 → 面板显示 `sessionId`。
  第一版改成读 `sessionController.list()` 的 `items[].displayTitle` —— **实测那个字段根本不存在**，
  真实 keys 是 `["sessionId","updatedAt","agentAvailable","running","blank","cwd","projections"]`。
  正解是**同一个 registry 里的 `title` 投影**：
  ```js
  const titleProjectionDefinition = {
    key: 'title',
    stateSchema: z.string().min(1).nullable(),
    apply: (state, event) => (event.type === 'session/title' ? event.data.title : state),
  }
  ```
  即 `ctx.sessionProjections.stateOf(session, 'title')` —— **状态本身就是标题字符串**，
  与 `tokenUsage` 同一机制（从会话日志重放、重启不丢）。
  诊断用 `GET /debug/agents` 的 `titles` 字段一眼可见
- 动作执行后**面板留着**（用户要求），方便连发

### 审批：由桌宠同意（**默认关闭**）

开启后（`config.approval.viaPet: true`），agent 要执行需要审批的操作时，
**一个审批小窗自己弹出来**（就在她旁边，第三个窗口）：

```
┌──────────────────────────────────┐
│ ● agent 想执行 pwsh                │
│ ┌──────────────────────────────┐ │
│ │ npm install --save-dev …      │ │  ← 命令原文（可选中复制）
│ └──────────────────────────────┘ │
│ escalate sandbox to …             │  ← 理由
│   [   允许   ]   [   拒绝   ]      │
│   不处理的话，60 秒后会自动交回 DSH  │
└──────────────────────────────────┘
```

**为什么是独立小窗，而不是画在她身上或塞进操作面板**：

- **不能画在她身上**：她头顶只有约 87px 留白，审批卡（工具名 + 命令 + 两个按钮）
  至少 100px 起 → 必然遮住她本体（用户实测："审批弹窗遮到角色了"）
- **不能塞进操作面板**：那要"先右键开面板、再点允许"，手要动两次，
  正好把"通过桌宠审批就是为了方便"这个初衷抵消掉（**用户指出**）。审批是**突发**的，
  必须自己弹出来
- 所以：**专用小窗 + `showInactive()`** —— 自动弹、不抢你正在打字的窗口的焦点
- **刻意不做"失焦即收起"**：审批是突发的重要决定，窗口一动就来不及点了；
  它只在"已处理 / 超时交棒"时消失

**三种结局**（缺一不可，否则会把审批卡死）：

| 情况 | 行为 |
|---|---|
| 桌宠点「允许」 | 返回 `'allowed-once'`（**唯一**的放行值） |
| 桌宠点「拒绝」 | 返回 `'rejected'` |
| 桌宠**没连上** / **超时**（默认 60s） | `next()` **交棒给 GUI** —— DSH 界面照常弹提示 |

⚠️ **代价（必须知道）**：审批链是**顺序**的 —— 桌宠"持着"请求时，**DSH 界面的提示不会弹**，
要等超时才交棒过去。所以"桌宠上也能审"和"GUI 立刻弹"只能二选一。
桌宠没连上时**立刻交棒**，行为与关闭该功能时**完全一致**。

**只放行一次**：宿主 API 里唯一的放行值就是 `allowed-once` ——
**没有"以后这个工具都别再问我"**。每次都会问，这是设计如此。

**命令是怎么拿到的**（安全底线）：`approval/request` 里**没有命令原文**
（只有 `agent, toolName, callId, reason, signal`），所以插件留存最近 50 条 `tool/call`，
**按 `callId` 关联**出 `arguments.command` 再显示。拿不到就明写"（拿不到命令原文，放行前请谨慎）"，
绝不假装。

**怎么关**：把 profile 配置里的 `approval.viaPet` 改回 `false`（或整段删掉）→ 重启 DSH。
此时插件**连 `ctx.on` 都不调**，审批链路一点不受影响（自测里专门有一条盯着这个）。

### 三条特殊规则（都是实测踩出来的）

1. **开场手势**：启动先演一次 `Scene[0]` 比嘘，**0.6x 慢放**，演完落待机。
   期间到达的状态**排队等它演完**（只有 `approval`/`error` 能打断）。
   而**启动时读到的状态是"现状"不是"转变"** —— 一次性入场动画不为它重放
   （否则上一轮 agent 干完留下的 `done`，会在开场手势后又演一次叉腰）。

2. **眨眼**：库的自动眨眼条件是 `if (!motionUpdated) eyeBlink.updateParameters(...)` ——
   **只有没有动作播放时才眨眼**。而待机用的 `Scene[3]` 又只在前 2.2 秒驱动眼睛，
   两件事叠加 → 待机眼睛一直闭着。
   所以：**只有"不驱动眼睛"的动作（目前只有 Scene[3]）需要我们自己兜底眨眼**；
   Scene[0]/[1]/[2] 全程驱动眼睛，让它们自己演（Scene[0] 是个 wink，强行睁眼会毁掉表情）。

3. **循环开关是双向的**：Scene[0] 既当开场手势（只播一次）又当 `running` 的动作（要循环），
   所以 `setMotionLoop(index, loop)` 必须显式设 true/false，不能只关不开 ——
   否则 `running` 时会只播一遍然后冻在最后一帧。

### 构图适配

按**实际渲染出来的不透明包围盒**适配（取多帧并集），不按模型画布 ——
画布 4200×3500 里角色只占中间一块，按画布适配会显得很小。

- **首次启动**现场测量（约 3 秒），期间**不显示窗口**（否则会出现"打开一会突然变大"）
- 测完**缓存到 `.state/model-fit.json`**，二次启动直接套用、立即显示
- 窗口尺寸变化时用缓存的包围盒重新排布

### 点击穿透的命中测试

⚠️ **不用** `setIgnoreMouseEvents(true, { forward: true })` —— 那是 Electron 在 Windows 上的
**已知 bug**，且正好是我们这个版本（详见 §十一）。

改为：**主进程每 16ms 轮询光标位置**（`screen.getCursorScreenPoint()`，不依赖任何窗口消息转发），
配合渲染端送来的 alpha 掩码（降采样到 130×150，每 250ms 刷新）判断是否让窗口接管鼠标。

⚠️ **光有 alpha 掩码还不够** —— 输入条、气泡是 **HTML 控件**，掩码里根本没有它们。
只按掩码判会出这个 bug：控件上"没有角色像素盖住"的部分被判成透明 → 穿透 → 按钮点不动
（实测：输入条右侧的「打断」点不到，而压在角色上的「派活」能点，很迷惑人）。
所以渲染端把**可见 UI 控件的矩形**跟掩码一起送过去，主进程按"命中控件 **或** 命中不透明像素"
判定。判定逻辑抽在 `packages/pet-shell/hit-test.js`（纯函数，可自测）。

拖拽期间主进程强制保持可交互，否则鼠标快速移出角色时窗口会"甩掉"拖拽。

### 相关工具

| 工具 | 用途 |
|---|---|
| `tools/inspect-live2d-model.mjs` | 解析任意 Cubism 模型：参数/表情/动作/物理/清单完整性 |
| `tools/fix-live2d-model.mjs` | 把"文件夹里有但清单没挂"的动作表情接上；补空分组 |
| `tools/downsample-texture.py` | 纹理降采样（预乘 alpha 正确处理） |
| `tools/prepare-renderer-vendor.mjs` | 生成 `renderer/vendor/`（换机器后必跑） |

---

## 七、插件层

### 路由

```
/xilian-pet/health              插件状态（含 code 修订号、pid、uptimeMs）
/xilian-pet/state               聚合状态 + 各会话 tail / spendTokens
/xilian-pet/events              SSE 事件流
/xilian-pet/debug/shapes        原始事件形状样本（按 channel 分别限量）
/xilian-pet/debug/reminders     提醒引擎配置 / 免打扰判定 / 已发记录
/xilian-pet/debug/agents        派活链路诊断（候选会话 / 活 agent / 能否 get()），只读
/xilian-pet/debug/notice        手动放一条通知（A7 显示侧的手动验证入口）
/xilian-pet/prompt              反向操控：派活
/xilian-pet/interrupt           反向操控：打断
/xilian-pet/approval            审批：桌宠点「允许/拒绝」（body {id, decision}）
/xilian-pet/focus               会话聚焦（Phase 0 未实现，返回 501）
```

### 关键设计决定

| 决定 | 原因 |
|---|---|
| 路由前缀用 `/xilian-pet`，不用 `/api/xilian-pet` | `/api` 是 `dsh-client-connection` 的 prefix 路由，带自己的准入校验；exact 路由挂在它下面会被前缀规则吞掉 |
| 全部注册成 `kind: 'exact'` | 精确匹配优先于前缀匹配，不会被前缀路由抢先 |
| 反向操控拿不到 agent 时返回 **503** 而不是假装成功 | 能区分"插件在但 API 不对"和"插件根本没装" |
| 会话聚焦返回 **501** | Phase 0 未实现，不做假成功 |
| 每个 channel 分别限量样本 | 全局环形缓冲会被高频流式帧刷爆，低频通道（`agent/status`）样本全丢 |
| 载荷预览做安全序列化 | `agent/status` 有循环引用，直接 JSON.stringify 会得到 `<unserializable>` |

### A7 主动提醒（插件侧已完成）

策略引擎在 `packages/pet-plugin/reminders.js`，**纯函数**、可完全脱离 DSH 单测：

| 提醒 | 级别 | 规则 |
|---|---|---|
| **审批积压** | urgent | 待审批数增加即提醒，**可穿透免打扰**；同一批限流 `repeatAfterMs`，**积压清空则重置冷却** |
| **久坐** | 低 | 连续活跃累计 `afterMs` 才提醒；空闲 `idleResetMs` 重置工作段；守免打扰 + 冷却 + **概率门** |
| **花销** | 低 | 每会话每累计 `everyTokens` 提一次；跨过下一个阈值才再提 |

- 提醒以 `notice` 帧经 SSE 推送；**窗口没连时发出的提醒会被暂存**（最多 20 条），连上后补发最近 5 条
- 诊断端点：`GET /xilian-pet/debug/reminders`
- 配置项见 `packages/pet-plugin/cordis.patch.yml`，整块可省略（有代码默认值）

> ⏳ **显示侧未做**：提醒到了窗口，但"冒泡 + 单击跳转到 DSH"的交互还没实现。

---

## 八、开发循环

### 插件源码热重载：**实测无效**，已放弃

profile patch 里保留着 `hmr` 行（现在是惰性配置、无害），但**它不生效**。证据链：

| 步骤 | 结果 |
|---|---|
| 加完 config 后改插件源码 | ❌ `code` 不变 |
| **重启 DSH 后**再改源码（只改一个常量，代码路径完全不变） | ❌ `code` 仍然不变 |

已排除：不是 patch 优先级问题；`root` 用法与官方 README 示例一致。
未定论的三种可能记在 `chajian/环境体检报告.md`。**不要再在这上面盲试。**

### 已定的开发循环

```
改 packages/pet-plugin/*.js  →  把 CODE_REVISION +1  →  重启 DSH  →  看 /health
```

| 观察 | 结论 |
|---|---|
| `code` 变大 **且** `uptimeMs` 归零 | ✅ 新代码已生效 |
| `code` 没变 | ❌ 改的代码没被加载（确认是否真的重启了） |

> 渲染端（`pet-shell/renderer/*`）改完**不需要重启**，但**需要关掉宠物重开**（`Ctrl+Shift+Q` 再启动）。

### ⚠️ 挂载插件前必读：一次真实事故（2026-09-29）

第一次挂载时，本会话**所有**工具调用立刻失效，报 harness 内部错误
`Cannot read properties of undefined (reading 'kind')`，重启 DSH 也不恢复。
原因不是环境，**是插件自身的 bug**：

`tools/pre-execute` 是 **waterfall** 事件，官方约定监听器必须 `return next()`：

```js
const gate = await ctx.waterfall(carrier, 'tools/pre-execute', exec, () => ({ kind: 'allow' }))
const askResolution = gate.kind === 'ask' ? ... : ...   // ← gate 被冲成 undefined 就死在这
```

我原来写的是 `(payload) => { observe(); return undefined }` —— 漏了 `next()`，把链路值冲掉，
于是**整个 profile 的每一次工具调用全废**。已修复，并补了 `runWaterfall()` 回归测试 + 负向对照。

**两条规矩**：

1. 观测插件**只订阅通知型事件**（`session/event`、`agent/assistant-stream`）。
   要订阅 waterfall 事件必须 `return next()`，并且必须在真实宿主上验证过。
2. **改 profile patch 前必备份**：

```powershell
# 安装脚本会自动生成 .bak-<时间戳>，回滚就是拷回去再重启 DSH
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-<时间戳>" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

### 挂载 Host 插件（两种方式，任选其一）

- **方式 1｜bundle 安装**：把 `packages/pet-plugin` 作为 bundle 装进 `desktop` profile（走 GUI 插件管理页最稳）
- **方式 2｜免安装直挂**：把 `cordis.patch.yml` 里的 `name` 换成 `index.js` 的绝对路径或 file URL，
  粘进 profile 的 `cordis.patch.yml`（官方契约明确支持「包标识符 / 绝对文件系统路径 / file URL」）

装好后自检：`GET http://127.0.0.1:19387/xilian-pet/health` 应返回 `{"ok":true,...}`。

### 依赖安装的三个本机坑（实测，换机器会复现）

1. **`pnpm install` 必须走镜像源**：`pnpm-workspace.yaml` 里已配 `registry: https://registry.npmmirror.com`。
   走官方源时单请求要 14–30s，`@electron-internal/extract-zip` 这类包会直接超时。
   同时已配 `nodeLinker: hoisted` + `packageImportMethod: copy`，规避
   `[ERR_PNPM_SYMLINK_FAILED] symlinkAllModules Maximum call stack size exceeded`。

2. **Electron 二进制不会随 `pnpm install` 装好**：它自带的 `install.js` 把 zip 缓存写进
   `%LOCALAPPDATA%\electron\Cache`（沙箱外 → 被拒）。所以改用自研下载器：

```powershell
& $NODE tools\fetch-electron.mjs        # = pnpm run deps:electron
```

   它是「镜像探测 + 8 路分段并行下载 + 纯 JS 解 zip」。实测：npmmirror ~85 KB/s（要半小时），
   **华为云 ~11 MB/s，150.9 MB 共 14 秒**。`tools/probe-mirrors.mjs` 可随时复测。

3. **Electron 无法在 agent shell 内启动** —— 见 §3.5。

---

## 九、安全红线

- **装第三方插件 = 授予宿主进程执行权**。DSH 的插件 vm 沙箱**不是安全边界**
  （Discussion #1441，PoC 已验证：一次批准 = 完整 RCE；#451 沙箱逃逸 + `/api` RPC 仅靠 Host 头围栏；
  #250 沙箱内可经 approval 回环自批准 `danger-full-access`）。三帖至今 open。
- 已知 CVE 与本机关系（2026-09-29 复核）：**CVE-2026-82533**（本地控制 API 鉴权绕过，9.6 CRITICAL）
  修于 `0.1.2-alpha.1`；**CVE-2026-101102**（Code Mode Sandbox，6.3 MEDIUM）
  影响 `0.1.0-rc.0 … 0.1.0-rc.7` —— **本机 0.1.7-rc.1 两条都不命中**。
- `cordis.patch.yml` 允许 `!!js` 表达式（= 配置期代码执行）→ **改 patch 前先备份，且拒绝 `!!js`**。
- 装前扫描：`@shaoshi/dshscan`（静态+语义双通道）+ socket.dev（注意本 shell 抓 socket.dev 会 403）。

### 素材与版权约束（**改代码时别删署名**）

1. **模型授权**：B站 @是依七哒，**注明用途 + 不得收费**。署名在 `NOTICE.md` 第四节。
2. **角色版权**：《崩坏：星穹铁道》昔涟，米哈游。依同人指引 V3.0 三、Q1 A1，
   **非商业个人使用可以制作并发布**，但须：① 同步放法律声明 ② 严格非商业
   ③ 不暗示官方关联 ④ 不用未公开素材 ⑤ 须为二次独创。
3. **不入库**（`.gitignore` 已覆盖）：`assets/live2d/`、`renderer/vendor/`、
   `docs/screenshots/*`（含第三方角色截图，白名单只有占位时代两张）、
   `*.wpk` `*.lpk` `*.moc3` `*.motion3.json` `*.exp3.json` `*.lnk`
4. **Cubism SDK 许可**：Core 受 Live2D 的 SDK Release License 约束（个人非商用属免费档）。

> 历史说明：早期曾规划过「A 档 Live2D 约稿」并整理过一套 36.2 MB 的 2D 素材导出包
> （`E:\xilian_desktop_pet\art_assets_export\`），**该方向已放弃**（改用现成授权模型）。
> 约稿单保留在 [`docs/Live2D约稿单.md`](docs/Live2D约稿单.md)，将来想换自研形象可直接启用。

---

## 十、验证状态（诚实版）

> **每个"已修复"都要有可复现的证据**（截图、参数采样区间、逐条日志）。
> 拿不到证据就老实写"未验证"。请继续按这个标准维护本节。

### ✅ 有截图/日志证据

| 项 | 证据 |
|---|---|
| 插件被加载 | `/health` → `{"ok":true,"code":13,...}`（`messageFactory` 报官方 `module:file:///…app.asar/…/dsh-llm/lib/index.js`） |
| **A6 派活端到端** | 用户在派活框输入的文字**真的到达了 agent**。客观判据：桌宠发的 `user/message` 的 `source` 只有 `{kind:'user'}`，而 GUI 发的带 `rpcId` —— 在 `/debug/shapes` 里一眼可分（实测同一条文案两种来源对比过） |
| 插件自测 96 项 | 状态机 / 归一化 / mock 契约 / 真 HTTP + 真 SSE 往返 / **waterfall 回归 + 负向对照** / **inject 静态扫描 + 负向对照** / **派活兜底 + resolveAgent 恢复 + 宿主会话枚举 + 只读诊断** / **外壳命中测试 + contentBand 身体对齐** / **活动摘要 + 通知帧** / **token 四桶 + 宿主数据源 + 花销基线 + 清未读 + 会话标题** / 清理注销 |
| 版本兼容性 | Cubism Core `05.01.0000`，`MsvGetLatestMocVersion=5`，模型 moc3 版本号 5 |
| 事件协议取自事实 | 59 个真实事件类型名、`SessionEventMap`、`StreamChunk`（正文在 `frame.chunk.text`）均来自 asar 类型清单 |
| Live2D 模型渲染 | 4200×3500 加载成功，截图见 `docs/screenshots/` |
| 4 个动作内容识别 | 参数采样 + 高光截图（见 §六 动作表） |
| 状态→动作映射 | `question` 档出现粉色问号特效，与其他档视觉可区分 |
| 构图适配 + 缓存 | `构图：内容 233×206 CSS px`；二次启动 `找到构图缓存` → 立即显示 |
| 主进程命中测试 | 日志逐条核对坐标换算：窗口外→穿透、角色上→可交互 |
| 开场手势 | 截图确认是**单眼 wink** 的比嘘表情 |
| 眨眼兜底 | `ParamEyeLOpen 活动 0.05~13.00s`（13 秒窗口全程） |
| 慢放倍率 | 参数活动区间比值 1.67x ≈ 1/0.6 |
| A5 逐字流（插件侧） | `/state` 的 `tail` 持续含真实正文 |
| A7 提醒（插件侧） | 30s tick 触发 → `pendingNotices=1` → 重连经 `notices` 帧补发 |
| token 用量 / 缓存命中 | 口径改用宿主 `tokenMeter` 的四桶 + `(turn, step)` 增量替换；**数据源改读宿主的 durable projection `sessionProjections.stateOf(session,'tokenUsage')`**（重启不丢），读不到才退回自算（`tokenSource` 字段可见）；自测 7 项覆盖 |
| A10 降级 | Live2D 失败时自动回退占位图，无白屏 |

### ✅ 用户已在实机确认（2026-10-02 重启后逐项核对）

| # | 修复内容 | 结论 |
|---|---|---|
| 1 | 待机时眼睛一直闭着 → 自己接管眨眼 | ✅ |
| 2 | 有其它窗口时拖不动 → 主进程轮询光标（绕开 Electron 已知 bug） | ✅ |
| 3 | 打开一会突然变大 → 构图缓存 + 测量完成前不显示窗口 | ✅ |
| 4 | 开场动作 → 比嘘手势（0.6x 慢放） | ✅ |
| 5 | 比嘘后接一次叉腰 → 启动时不重放一次性入场动画 | ✅ |
| 6 | 比嘘时眼睛没动作 → 眨眼接管条件写反了，已反过来 | ✅ |
| — | **A9 透明区不挡下层点击** | ✅ |
| — | **A6 双击派活 / 打断** | ✅ 用户实机确认（2026-10-02）："测试成功了，可以打断" |

> 用户原话（第一轮）："**除了双击派活，其他的都 ok**"。
> 于是 A6 从"从来没测过"直接变成了"**一测就测出真 bug**" —— 一共五层，见 §十 与"仍没验证过"。

### ❌ 仍然没验证过

| 项 | 为什么 |
|---|---|
| **A4 的"降回 idle"** | 一执行命令 agent 就是 running，回合内自证不了 |
| **A5 气泡渲染端** | 原来显示 AI 正文（用户反馈"输出太多，看不清"），现改为**活动摘要**；窗口里的实际观感待确认 |
| **A7 显示侧的观感** | 通知条 + 点击唤到 DSH 前台的逻辑已实现（外壳秒级可验证），**实际观感与"跳转是否真的把窗口拉到前台"待你确认** |
| 长时间稳定性 | 没跑过几小时 |
| 多显示器 / DPI 缩放 | 没测过 |

### 验收项 A1–A10 逐项

| # | 验收项 | 状态 |
|---|---|---|
| A1 | 插件能被 profile 加载 | ✅ |
| A2 | ~~设置页出现「桌宠配置」~~ **已砍掉** | ❌ 不适用：不做 GUI 内嵌，配置走 `packages/pet-plugin/cordis.patch.yml` |
| A3 | **独立窗里出现宠物并待机动画**（已重定义） | ✅ 截图 + 参数采样（`Scene[3]` 待机在播） |
| A4 | 真实会话事件驱动状态 | 🟡 四档切换已验证；降回 idle 未观察到 |
| A5 | **活动摘要进气泡**（2026-10-02 重定义） | 🟡 插件侧 ✅（`activity` 帧 + 自测）；渲染端待肉眼确认。原定义"逐字流进气泡"**已按用户要求废弃** |
| A6 | 双击气泡派活 | ✅ 用户实机确认（2026-10-02）：派活 + 打断都可用（修掉五层 bug，见上） |
| A7 | 审批积压主动提醒 | 🟡 插件侧 ✅；**显示侧已做**（通知条 + 点击把 DSH 唤到前台），观感待确认 |
| A8 | Electron 透明置顶窗 | ✅ 可拖动、透明无边框 |
| A9 | 点击穿透 | ✅ 用户实机确认（2026-10-02） |
| A10 | 模型缺失时降级 | ✅ |

**Phase 0 明确不做**：养成数值、语音、多开碰撞、多宠物注册表、打包发布、素材生成链。

> **A2/A3 已于 2026-10-02 重定义**（原判定按 GUI 内嵌写，随该路线作废）：
> **A2 砍掉**（不做设置页卡片，配置项写在 `cordis.patch.yml` 里、整块可省略）；
> **A3 重定义为「独立窗里出现宠物并待机动画」→ ✅**。
> 独立窗路线下 A3 看**内容**、A8 看**窗体**，是同一件事的两半。权威定义见 [`PLAN.md`](PLAN.md) §四。

---

## 十一、踩坑记录

### 环境类

| 坑 | 症状 | 解法 |
|---|---|---|
| Electron 二进制没装 | `require('electron')` 卡在 "Downloading..." | `tools/fetch-electron.mjs`（华为云镜像，15 秒） |
| agent 沙箱里 Electron 起不来 | `Mojo platform_channel.cc:108 拒绝访问 0x5` | 提权；日常让用户自己跑 |
| `cubism4.min.js` 引用 `process` | `ReferenceError: process is not defined` → **整包不执行** | 加载 `vendor/process-shim.js` |
| PixiJS 需要 eval | `Current environment does not allow unsafe-eval` | 加载 `@pixi/unsafe-eval` |
| `web_fetch` 工具被域名过滤 | 几乎全站 `resolves to a non-public IP` | **用 Node 的 `fetch`** |
| 模型渲染成一片绿 | `#halo` 画在了 canvas 上面 | 显式 z-index 分层 |
| `file://` 页面 XHR 被拒 | `Access to XMLHttpRequest ... blocked by CORS` | 改用 `pet://` 同源协议 |

### 代码类

| 坑 | 症状 | 根因 |
|---|---|---|
| **两个 `<script>` 撞名** | 一次 `SyntaxError` 整页静默失效；一次 `function` 静默互相覆盖 | 共享全局作用域 → 改 ES 模块 |
| **模板字符串括号顺序笔误** | `SyntaxError: Missing } in template expression`，**肉眼看不出来** | 写成 `` `Scene[${x]}` `` 而非 `` `Scene[${x}]}` ``。**逐字符 hexdump 才定位到** |
| **`setIgnoreMouseEvents(forward:true)`** | **桌面上有别的窗口就拖不动** | Electron 在 Windows 上的已知 bug，见下 |
| **动作播放时库不自动眨眼** | 待机眼睛一直闭 | 条件 `if (!motionUpdated) eyeBlink...`；自己兜底 |
| **眨眼接管条件写反** | 比嘘的 wink 变成两只眼睁着 | 判据应是"哪些动作持续驱动 `ParamEyeLOpen`"（数据），不是"哪个动作闭眼"（零散现象） |
| **`motionGroups` 懒加载** | 刚调 `motion()` 时取不到 motion 对象 | 50ms × 20 次重试 |
| **外部挂载的插件 import 不到宿主的包** | 派活报 503 `no-message-factory`；`import('@deepseek-ai/dsh-llm')` 必然 `ERR_MODULE_NOT_FOUND` | 裸包名只从插件**自己所在目录**往上找，而该包在宿主 `app.asar/dsh/node_modules/` 里。**实测结论（2026-10-02）**：改用 `file://` 指向 `app.asar` 内那个文件的绝对路径**能成功 import**（Electron 44 支持 asar 内 ESM）—— `/health` 的 `messageFactory` 现在报的就是 `module:file:///F:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`。所以走的是**官方工厂**，内置等价实现只作兜底 |
| **状态只在快照里学一次** | 派活报 503 `no-agent`：渲染端只在 SSE 快照里记 sessionId，而 DSH 刚重启时 `/state` 是空的 → 窗口"先连上、会话后出现"，它手上永远是 `undefined` | 快照只是**连接那一刻**的切片 → 后续每帧都要能补齐（现由 `primarySessionId` 承担），并且**服务端自己兜底**比指望客户端状态更稳 |
| **`ctx.agents.get()` 只找"活着的" agent** | 派活 503 `no-agent`，**而 sessionId 完全正确**（`/state` 里就是它） | 注册表实现是 `store.get(id)?.agent`，store 只放 **entered** 条目，detach 即删 → 会话不活跃时必然 undefined。要**解析或恢复**得走 `ctx.sessionController.agents.resolveAgent(id)`（官方注释 "Resolve or resume one ordinary Session"，GUI 提交消息也是这条） |
| **"我知道的会话"只来自自己观测的事件** | 派活 503 `no-session-known`：DSH 刚重启，插件一个会话都没观测到，空窗期里候选为空 | 观测事件 ≠ 世界全貌。宿主本来就有 `ctx.sessions.list()`（"All live sessions"）与 `ctx.agents.list()`，**别自己攒状态去猜** —— 能问就问 |
| **命中测试只看 alpha 掩码** | 输入条右侧的「打断」点不到（穿透），而压在角色上的「派活」能点 | 掩码里只有 Live2D 像素，**HTML 控件不在其中** → 控件矩形要跟掩码一起送给主进程；判定逻辑抽成 `hit-test.js` 纯函数才测得到 |
| **全局环形缓冲被高频通道刷爆** | `/debug/shapes` 80 条样本全是流式帧 | 按 channel 分别限量 |
| **循环引用载荷预览不可读** | `agent/status` 样本 `<unserializable>` | 安全序列化（循环处标 `[circular]`） |
| **绝不能用 pwsh 改含中文的源码** | 注释变乱码、吞换行 | 一律用 edit/write 工具 |
| **`Invoke-RestMethod -Body <字符串>` 发中文变 `?????`** | 通知 / 派活里的中文到了宿主就是问号 | PowerShell 5.1 对字符串 body 默认按 ASCII 编码 → 传**字节**：`-Body ([Text.Encoding]::UTF8.GetBytes($json))` + `charset=utf-8` |
| **绝对定位 + flex 会把中文挤成一列** | 通知条变成"一个字一行"的高柱，几乎占满整个窗口（实测截图） | 绝对定位元素宽度是"收缩适应"，flex 文本项会被压到近 0 宽 → 改**固定宽度 + 块级布局** |
| **只按进程名找 DSH 窗口找不到** | 点通知没反应：`detail=no-window pids=2` | DSH 的窗口**不属于**那两个同名进程 → 改成「PID 命中 **或** 标题含 `Harness/DSH/DeepSeek`」再取**面积最大**者。另：`Process.MainWindowHandle` 实测恒为 0，**别用它** |
| **`SetForegroundWindow` 返回 true 却没到前台** | 点了只闪一下任务栏 | Windows 前台锁 → 先 `AllowSetForegroundWindow(-1)` + `AttachThreadInput` 再设置；用 `GetForegroundWindow()` **复核**，别信返回值 |
| **拿 `usage.totalTokens` 累加当用量** | `/state` 报出 **3390 万** tokens | `totalTokens` 含 `cacheReadTokens`（重发的整个上下文）→ 改**四桶**分别累加，并按 `(turn,step)` 增量替换（口径对齐宿主 `tokenMeter`） |
| **拿「已报数」当花销提醒的基线** | 总数换成 durable 之后，DSH 一重启就炸一条"本会话已用约 **247040k** tokens" | 总数 durable 了、提醒基线还是易失的 → 改**基线制**：首次看到该会话时把当时的值记成基线，之后只对**新增**部分提醒（实测踩到） |
| **菜单竖直位置按窗口几何中心对齐** | 菜单比她的身体明显偏上 | 她头顶有 ~87px 留白 → 窗口中心比身体中心高 40px。改 `contentBand()`：从 alpha 掩码算内容竖直范围（实测 86..292 → 中心 189）再对齐 |
| **用 PowerShell 的 `WriteAllLines` 删代码块** | 整个文件的行尾被改成 CRLF（仓库约定是 LF）→ diff 噪声：pet.js 实际只改 114 行，git 显示 1206 行 | **改源文件用 edit/write 工具**，别用 PowerShell 写文件；已经栽过两次（上次是改提交信息）。用 `git diff --ignore-all-space` 能看出真实改动量 |
| **`.sessions[hidden]` 必须显式写** | 折叠"没生效"：`hidden=true` 但列表照样显示（抓图才发现） | UA 的 `[hidden]{display:none}` 被自己写的 `.sessions{display:flex}` **覆盖**了 —— 本仓库为这个坑栽过两次（上一次是 `#composer` 默认显示出来） |
| **以为 `setIsLoop(true)` 就能让动作循环** | 用户报："昔涟在长时间待机之后会退出待机动作" | 循环标志**设成功了**（日志可见 `Scene[3] 循环=true`），但库照样在 180 秒后派发 `motionFinish` 结束动作。而 `motionFinish` 处理器对**非一次性状态什么都不做** → 她停在最后一帧。正解：非一次性状态收到 `motionFinish` 就**重开该状态自己的动作**。待机动作 `Scene[3]` 时长 180 秒，所以症状是"待机几分钟后不动"而不是"一看就坏" |
| **修 bug 时只看 `state.currentState`，没看"实际在播哪个动作"** | 第一版修复后用户回"**还是会停**" | agent 干完活后 `currentState` 是 `done`（一次性状态**刻意保留**，未读背板要一直显示），但实际在播的已是待机动作。于是走进"一次性动作演完 → `returnToBaseMotion()`"，而它开头 `if (currentMotion === BASE_MOTION) return` **直接返回、没人重开**。**状态与动作是两件事**：判断必须用 `currentMotion`。修法是把决策抽成纯函数 `motion-policy.js`，自测秒级盯住（不必跑 180 秒） |
| **"等某个事件再补救"，但那个事件根本不派发** | 第二版修复后用户回"**还是没有秋千**" | 改成"等 `motionFinish` 再重开"后实机仍然失效 —— 库在某条路径上停掉动作**却不派发该事件**。**改用主动巡检**（每 3 秒问库"现在有动作在播吗"，看 `motionManager.isFinished()`）。实机 43.8 分钟里 `motionFinish` 路径重开过一次、动作却没真的播起来，正是巡检兜底救回的 |
| **审批卡画在桌宠窗口里** | 用户实测："审批弹窗遮到角色了" | 她头顶只有 ~87px 留白，审批卡（工具名+命令+按钮）≥100px → 必然遮住她。改成**第三个窗口**（`showInactive()` 不抢焦点）。中途还想塞进操作面板，被用户否掉："还要打开菜单才能审批，与初衷违背" |
| **错误被 catch 吞掉 + 关键语句在同一个 try 里** | 用户实测："桌宠上没有弹请求框"；时间线却是 68 秒才放行（> 60s 超时）→ 是 GUI 处理的 | `startSse` 是模块级函数，却直接调了定义在 `createWindow` 里的 `handleApprovalFrame` → `ReferenceError` → 被外层 catch 吞掉，**连同一 try 里的 `send(win,'pet:frame')` 都没执行** → 桌宠收不到任何帧（整个冻住），表象却只是"审批框没弹"。**副作用必须单独 try，关键语句必须无条件执行** |
| **以为会话标题在 `sessionController.list()` 里** | 面板显示成 `session-5f19636e-…`（用户两次反馈"标题有问题"） | 实测 `list()` 的 item keys 是 `["sessionId","updatedAt","agentAvailable","running","blank","cwd","projections"]`，**没有 title/displayTitle**。标题其实是 **key 为 `title` 的 session projection**（`apply: session/title → event.data.title`，状态就是字符串）→ 用 `sessionProjections.stateOf(session,'title')` |
| **以为注册审批应答者就能由桌宠审批** | 探针 `seen=0`：审批真的发生了（`approval/asked` + `decided: allowed-once`），我们却一次都没被调用 | 链路里**前面是"转发给 GUI 的桥"**，它 await 用户在界面上的答复并返回决定 → **链路就此结束**。正解是 `ctx.on('approval/request', fn, { prepend: true })` 抢到最前面（实测：`asked` 与探针收到只差 **1ms**）。代价：我们"持着"时 GUI 不再弹提示 → 必须超时交棒 |
| **以为 `approval/request` 里有命令原文** | 没法显示"你在批准什么"，等于盲批 | 实测字段只有 `agent, toolName, callId, reason, signal`。**命令要用 `callId` 去 `tool/call` 事件里关联**（我们本来就收这个事件，`data.arguments` 就是命令 JSON） |
| **菜单画在桌宠窗口里 → 遮住本体** | 用户实测："菜单的位置不对，会遮住桌宠本体" | 她占满 260×300，**只有头顶约 87px 是空的**，竖排四项菜单放不下 → 最终改成**独立小窗**在她旁边弹出。（中间的试错：先改紧凑两行塞进留白带能work，但样式受限） |
| **`show()` 时 `send` 数据，渲染端监听还没注册** | 菜单里永远显示"—"（首次打开必现） | `loadFile()` 是异步的 → IPC 消息被丢。加 `menu:ready` 让主进程**补发**（与桌宠窗口 `pet:ready` 同一套路） |
| **临时表情恢复时照搬"当前态"的表情** | 右键弹完问号后，她**卡在闭眼笑**上不再恢复（用户实测："问号消失，出现如图表情"） | `done` 是 `{once:true, expression:'happy'}`（闭眼笑，演完就该撤）。恢复时照搬 `STATE_MAP['done'].expression` 等于**把一次性特效复活**，而且不会再有人来清。→ 一次性且无 `keepEffect` 的态恢复成**基础表情**（A/B 抓图对照验证过） |
| **透明窗在屏幕外 `capturePage()` 抛 `UnknownVizError`** | 菜单小窗抓图失败，没法核对布局 | compositor 还没产出帧 → **重试**（等一帧再来）即可，实测第 2 次成功 |
| **清未读"假清"** | 点了徽标不消失，或过一会儿又冒出来 | 两层：① `markRead()` 是**死代码**（`mousedown` 无条件 `dragging=true`，`mouseup` 里 `if(!dragging)` 永远不成立）；② 它只 `setBadge(0)` 清本地显示，**没告诉插件**，下一个 `state` 帧就把 unread 报回来 → 必须加插件端点 `POST /read` |
| **`llm/retry-started` 不在 `EVENT_STATE` 里** | 放在状态映射之后的处理分支变**死代码**，静默失效 | 该事件会被 `target === undefined` 提前 return → 必须在状态映射**之前**单独处理（自测里有专门一条覆盖它） |

### 关于 `setIgnoreMouseEvents` 那个 bug（值得单独记）

我们没有绕过去，是**换掉了整个机制**。查证过程：

| 证据 | 内容 |
|---|---|
| PR **#53026**（target 44-x-y，即本机版本） | **"Mouse forwarding will stop working temporarily if a window with higher privileges (integrity level) is the foreground window"** |
| Issue **#30808**（2021 至今 open） | 「Mouse event forwarding is buggy」事件要么闪烁要么完全不转发 |
| Issue **#49982** | 「mouseenter/mouseleave 振荡 + **click-through 卡住**」 |
| PR **#52633** | 「refactor: mouse forwarding on Windows」声明 `Fixes #30808`，**但至今 open，没进任何发行版** |

症状完全吻合：别的窗口一进前台 → 转发停 → 渲染端收不到 `mousemove` → 永远切不到可交互 → 拖不动。

### 测试方法类（这几条差点让我把 bug 当修好）

| 坑 | 症状 |
|---|---|
| **测试开关和产品行为耦合** | `deferShow` 绑在 `PET_SNAPSHOT` 上 → 快照测试永远走"立即显示"分支，**真实路径从没被验证** |
| **真实状态干扰测试** | `PET_FORCE_STATE` 之外还发了真实快照 → 真实状态先到、消费掉"首次状态"标记，**测不出真实场景** |
| **mock 比真实宿主宽松** | mock ctx 把服务当普通属性发、不复现 Cordis 的 **inject 校验** → 自测 62 项全绿，真机「双击派活」却报 `cannot get property "agents" without inject`。**mock 必须复现真实宿主的契约，否则测的是假象** |
| **把缺陷写成了预期** | 旧自测里有一条「取不到 UserMessage 工厂时 /prompt 降级为 503」，等于把"派活永久失败"当成**正确行为**断言下来 → 全绿反而巩固了 bug。**写降级路径的测试时，要先问一句"这个降级本身可接受吗"** |

> 教训：**测试开关一旦和真实数据/产品行为混在一起，就很容易测到假象。**

### 靠"自我截图"抓到的两个真 bug

窗口看不到屏幕时，`PET_SNAPSHOT=<png>` 让 Electron 截自己的窗口（只截我们的透明窗，不碰用户桌面），
再加 `console-message` 诊断，一次就抓到两类问题：

1. **渲染端 JS 从未执行**：`<img id="pet">` 会自动创建 `window.pet`，与 preload 的
   `exposeInMainWorld('pet', …)` 撞名 → `Uncaught SyntaxError: Identifier 'pet' has already been declared`。
   **整页 JS 静默失效**，而 CSS 正常，肉眼看截图只以为"样式没生效"。
   已改名：桥接对象 `window.xilianPet`、元素 `#petSprite`。
2. **默认隐藏的输入条其实显示了**：HTML 的 `hidden` 靠 UA 样式表的 `display:none`，
   被作者样式里的 `display:flex` 覆盖。已加 `[hidden] { display: none !important }` 兜底。

---

## 十二、调试开关

| 变量 | 作用 |
|---|---|
| `PET_SNAPSHOT=<png>` | **自检截图**（只截自己的透明窗）+ `PET_SNAPSHOT_EXIT=1` 截完退出 |
| `PET_SNAPSHOT_AT_MOTION_MS=<ms>` | 从**动作开始**（不是窗口 ready）精确计时截图 |
| `PET_SNAPSHOT_DELAY_MS=<ms>` | 从 ready-to-show 起算的截图延迟 |
| `PET_FORCE_STATE=<state>` | 强制推一个状态（**不发真实快照**，避免干扰） |
| `PET_FORCE_MOTION=Scene:<i>` | 指定播放哪个动作 |
| `PET_FORCE_MENU=1` | 启动后自动弹出操作面板（配合 `PET_SNAPSHOT_MENU` 就能拍到面板，不必真的去点） |
| `PET_FORCE_APPROVAL=1` | 启动后弹出**假的**审批小窗（只为核对布局，不碰审批链、不放行任何东西） |
| `PET_SNAPSHOT_APPROVAL=<png>` | 把审批小窗拍下来（副窗抓图会自动重试） |
| `PET_SNAPSHOT_MENU=<png>` | 把菜单小窗拍下来（会自动重试，透明窗首帧可能没准备好） |
| `PET_SAMPLE_PARAMS=1` + `PET_SAMPLE_MS` | **参数采样**：反推动作内容 / 验证时序 |
| `PET_HIT_DEBUG=1` | 每秒打印命中判定（坐标换算逐项可见） |
| `PET_DEFER_SHOW=0` | 关掉"构图就绪前不显示窗口" |
| `PET_WIDTH` / `PET_HEIGHT` | 窗口尺寸（默认 260×300） |
| `PET_MODEL_DIR` | 模型目录覆盖 |

---

## 十三、待人工处理的项（沙箱外才能做）

1. `~/.dsh/storages/workspace.json` 仍注册着 `F:\dsh\project\chajian`、`C:\Users\project`、
   `default-workspace` 三个历史工作区 → 可清理。
2. `F:\dsh\project\chajian` 仍有同内容副本 + 上一轮遗留的 `.write-probe` → 可删除
   （**保留 C: 这一份为唯一权威**）。
3. 可选：在你自己终端执行 `git config --global http.sslBackend openssl`，省掉每条 git 命令加参数。
4. 仓库根有两个误建的 `start-pet.cmd - 快捷方式*.lnk`（已 gitignore，可删）；
   想放桌面用「发送到 → 桌面快捷方式」。
5. `Cyrene.zip`（8.2 MB 原始模型包）和 `3597924035_*.wpk`（9.57 MB，加密不可用）
   仍在工作区 → 可移出仓库或删除（`.gitignore` 已排除，不影响仓库干净度）。

---

## 十四、目录

```
PLAN.md                             调研结论与技术验证计划（含验收标准 A1–A10）
README.md                           本文（环境事实 / 边界 / 架构 / 怎么跑）
NOTICE.md                           版权与署名声明（**必读，改动时别删**）
start-pet.cmd                       一键启动入口（双击即可，锁捆绑 node 路径）
package.json · pnpm-workspace.yaml  工作区与 pnpm 配置（storeDir、hoisted、npmmirror）
packages/pet-plugin/                DSH Host 插件（零依赖、零构建）
packages/pet-shell/                 Electron 透明置顶窗 + Live2D 渲染层
docs/
  交接说明.md                        给下一个对话窗口的完整交接（**接手先读这份**）
  Live2D约稿单.md                    委托说明（已暂缓，将来换自研形象可启用）
  screenshots/                      实机自检截图（含第三方角色，默认 gitignore）
tools/
  check-plugin.mjs                  自测（116 项断言，含外壳命中测试，不需要 DSH）
  tap-events.mjs                    SSE 探针：不开窗口也能看插件输出
  install-plugin.mjs                插件挂载助手（检测现状 / 打印方式 / --write 追加）
  fetch-electron.mjs                Electron 二进制下载器（镜像探测 + 8 路并行 + 纯 JS 解压）
  prepare-renderer-vendor.mjs       生成 renderer/vendor/（pixi + Cubism Core）
  inspect-live2d-model.mjs          解析任意 Cubism 模型
  fix-live2d-model.mjs              接上未挂进清单的动作/表情
  downsample-texture.py             纹理降采样（预乘 alpha）
  probe-mirrors.mjs                 Electron 镜像速度实测
  make-placeholder.mjs              程序化生成占位素材
  inspect-png.mjs                   校验素材透明通道
chajian/
  环境体检报告.md                    2026-09-29 环境隐患实测报告（18 项 + 证据）
  dsh-desktop-pet-选型对比.md        独立原生透明置顶窗路线选型
  dsh-vibe-coding-插件清单.md        开发循环插件清单
  backup/                           DSH profile 配置备份（cordis.patch.yml 等）
```
