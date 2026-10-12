# AGENTS.md · 给所有 AI 会话的进门须知

这个仓库**主要就是由 AI 会话推进的**，所以这份文件只写"会让你踩坑、且不看就一定踩"的东西。
**现状以 [`docs/接手状态报告-2026-10-11.md`](docs/接手状态报告-2026-10-11.md) 为唯一权威** ——
仓库里其它文档都保留着被推翻但没回滚的旧结论（安装方式、自测项数、`CODE_REVISION`、模型是否入库）。

## 0. 三条最容易犯的错

1. **以为验证过了。** 这是本项目最大的风险（写在 `docs/接手状态报告` 末尾）。
   任何"已修复/已验证"都必须附**可复现的证据**（命令 + 输出 / 文件 + 行号 / 截图）；
   拿不到证据就老实写"未验证"。**绿色本身不算证据** —— 新逻辑要配**变异测试**。
2. **拿文档当事实。** 本仓库文档漂移过很多次。**以代码、`.state/` 里的实跑产物、
   profile 真实文件、活体端点为准。**
3. **以为改完就生效。** 见下面 §2。

## 1. 这是什么

DSH 桌面宠物「昔涟」：Cordis Host 插件（大脑，订阅会话事件）→ 同源 SSE →
Electron 透明置顶窗（显示器）→ IPC → Live2D 渲染端；另有操作面板小窗与审批小窗。

| 目录 | 干什么 |
|---|---|
| `packages/pet-plugin/` | Host 插件（零依赖、零构建）：路由 + `reducer.js` 状态机（**主动提醒引擎 `reminders.js` 已于 2026-10-11 按用户要求整体删除**） |
| `packages/pet-shell/` | Electron 主进程：SSE 订阅、`pet://` 协议、光标轮询命中测试、窗口/构图持久化 |
| `packages/pet-shell/renderer/` | 渲染端：`pet.js`（普通脚本）/ `live2d.js`（**ES 模块**）/ `hit-math.js` / `motion-policy.js` |
| `tools/check-plugin.mjs` | **自测，改任何东西都要跑**（当前 **202 项**，必须全绿；**数字会变，以实际输出为准**） |
| `docs/`·`chajian/` | 文档与研究记录（**大多带历史包袱，先读接手状态报告**） |

## 2. "改什么 → 怎么生效"（实测，别猜）

| 改了什么 | 生效方式 | 怎么确认 |
|---|---|---|
| `packages/pet-plugin/*.js` | **重启 DSH**（`hmr.root` 实测**无效**，ESM 缓存不失效） | `/xilian-pet/health` 的 **`code` 变大**（别看 `uptimeMs`） |
| `packages/pet-shell/**` | **重启桌宠**（`Ctrl+Shift+Q` → `start-pet.cmd`） | `packages/pet-shell/.state/pet.log` 的构建指纹 |
| profile 的 `cordis.patch.yml` | 会让插件重新 `apply()`，**但加载的仍是旧模块** | 同上：**只看 `code`** |

## 3. 硬红线（违反过的都出过真事故）

- **`.cmd` 只能有 ASCII**（注释也算）：cmd 按 GBK 解 UTF-8 → 乱码会变成**命令**。
- **不许用 PowerShell 写含中文的源码**（乱码/吞换行/CRLF 污染 diff）→ 用 edit/write 工具。
- **不许订阅 waterfall 事件却不 `return next()`**：`tools/pre-execute` 漏 `next()` 曾让
  **整个 profile 的每次工具调用全废**，重启 DSH 也不恢复。
- **改 profile patch 前先备份**；**拒绝 `!!js`**（= 配置期代码执行）。
- **素材与署名不许动**：`LICENSE`（必须纯 MIT 正文）、`NOTICE.md`（模型作者 @是依七哒 的署名必须保留）。
  入库的第三方素材只有两处：`assets/live2d/Cyrene/` 与 `packages/pet-plugin/icon.webp`
  （后者是**社区图、作者不明**，不许说成"自绘/原创/官方原画"）。
- **禁止用源码正则断言代替行为断言**（坐标 bug 就是这么被锁死的）。

## 4. 本机（Windows + DSH 沙箱）边界

- 写：**只有工作区和 TEMP 可写**；工作区外要 `danger-full-access`，且**同一条命令里把要做的做完**
  （每次 `pwsh` 都是新进程）。**读**工作区外是允许的。
- **Node 起子进程带管道 stdio → EPERM**（沙箱禁命名管道）→ 用 `stdio:'inherit'`，或交给 pwsh。
- **Electron / Chromium 在 agent shell 里起不来**（Mojo 命名管道被拒）→ 实机验证必须由用户做。
- 网络：`registry.npmmirror.com` 正常；**`github.com` 的 HTTPS 今天坏了**
  （`UNABLE_TO_VERIFY_LEAF_SIGNATURE`，疑似代理）→ 发布脚本会失败。
- 读 JSON/中文文本用 **Node**，不要用 PowerShell（按 GBK 解 UTF-8）。
- 活体端点用**纯 HTTP**：`Invoke-RestMethod http://127.0.0.1:19387/xilian-pet/health`。

## 5. 常用命令

```powershell
node tools/check-plugin.mjs                    # 自测（202 项，必须全绿；不需要 DSH）
Invoke-RestMethod http://127.0.0.1:19387/xilian-pet/health
.\start-pet.cmd   /   .\start-pet.cmd --check  # 桌宠（Ctrl+Shift+Q 退出）
node tools/package-release.mjs --with-model --with-electron
node tools/publish-release.mjs --dry-run
```

## 6. 交接规矩

收工时至少更新 [`docs/接手状态报告-2026-10-11.md`](docs/接手状态报告-2026-10-11.md)
（或它的后继）的**验证状态**与**未完成任务清单**，并注明"哪些是实测、哪些是推断、哪些没验"。
