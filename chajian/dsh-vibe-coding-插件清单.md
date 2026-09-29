# DSH Vibe Coding 插件清单（自研桌宠项目）

> 目标：**自己写一个桌宠**，用 DSH 插件把「写代码 → 看效果」的循环压到最短。
> 形态：独立原生透明置顶窗（Rust/Tauri 或 Electron 路线，见第 5 节）。
> 工作区：`C:\Users\怒C大伟出奇迹\dsh-projects\xilian pet`（2026-09-29 已从 `F:\dsh\project\chajian` 迁来）
>
> **修订（2026-09-29）**：§0 两条「不可用」已失效；§1 的 HMR 前提经实测**不成立**；DSH 版本基准已更正（本机 = **0.1.7-rc.1**，非 `rc.8`）。实测数据见 [`环境体检报告.md`](环境体检报告.md)。

---

## 0. 可信度声明（与上一版相同，请务必先读）

| 限制（**2026-09-29 已复核**） | 当时的表现 | 复核结果 |
|---|---|---|
| ~~**shell 完全不可用**~~ | 每次 pwsh 返回 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(F:\dsh\project\chajian)` | ✅ **已消失**：迁到 `C:\Users\怒C大伟出奇迹\dsh-projects\xilian pet` 后读写正常。**但 shell 的沙箱写边界只剩「工作区 + TEMP」**，装插件要写 `~/.dsh/profiles/desktop` 会被拒 → 见 §7 |
| ~~**web_fetch 全被拦**~~ | 所有域名 "resolves to a non-public IP address" | ✅ **已失效**：实测可抓 `api.github.com` / `registry.npmjs.org` / `raw.githubusercontent.com`。抓不到 `github.com` HTML 属网络层问题，不是工具被拦 |

本文是**经过筛选的候选地图 + 安装顺序**，不是「已测试可用」清单。第 7 节是逐项验证清单（含 2026-09-29 已实测勾掉的项）。

---

## 1. 先说一个关键事实：HMR 已内置，不需要装插件

**DSH 自带客户端插件热重载机制。** 据 [官方 HMR 包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/hmr/README.zh.md) 与 [相关提交](https://github.com/deepseek-ai/deepseek-harness/commit/9f33f1d6529a273000bd2f8d7f0ffe958b203b3b)：

> 浏览器侧订阅系统 SSE 通道（`GET /plugins/events`），每收到一个 `rebuilt` 帧就重载**单个**插件。

这意味着：

- **改客户端插件代码 → 自动重载，不用刷新页面、不用重启 DSH** —— 这是整个 vibe coding 循环的地基，你已经有了
- **前提条件**：需要有 dev watcher 在重新构建插件 bundle。DSH 桌面版由 `pnpm run dev:web` 提供
  （**2026-09-29 实测：本机没有在跑** —— 除 `127.0.0.1:19387` 外无任何 vite/dev 端口监听，也无 node 进程；而且本机**没有可编辑的 DSH 源码树**，只有打包好的 `app.asar`（根目录仅 `dsh / node_modules / lib / package.json / renderer`）。因此**这条 HMR 重建链当前不可用**：用现成插件不受影响，但自研插件改完代码需要重新安装才能生效，除非先拿到一份 DSH 源码 checkout）
- 因此 **不要**去装所谓「HMR 插件」：npm 上的 `@harness-desktop/dsh-client-hmr` 带 ⚠️ 告警，而官方已内建，装它是纯风险无收益

**结论：省下一个插件位，把精力放在下面真正缺的能力上。**

---

## 2. 按「能力缺口」分组的推荐清单

自研桌宠的循环是：**写插件/写窗口壳 → 看渲染效果 → 调状态机/动画 → 回代码**。按这条链找缺口：

### A. 开发循环与调试（**最高优先级**）

| 插件 | 解决什么 | 来源 |
|---|---|---|
| [CkEFFAF/dsh-plugin-devkit](https://github.com/CkEFFAF/dsh-plugin-devkit) | **运行时 inspector（`/debug`）+ 隔离 debug-boot + 无需浏览器跑宿主契约测试 + 客户端 slot 预览**。开发期不用反复重启、不靠猜 | GitHub |
| [TEGONG00/dsh-plugin-browser](https://github.com/TEGONG00/dsh-plugin-browser) | 内置浏览器面板：**实时 screencast + 元素拾取（picker）直接变成 composer 附件 + Playwright 驱动的模型工具**。改样式时截图丢给我看，闭环最快 | GitHub |
| [jiaererw/dsh-plugin-chrome](https://github.com/jiaererw/dsh-plugin-chrome) | **每会话一个可见 Chrome 窗口 + 16 个 `chrome_*` 工具 + Web GUI 内实时画面**。需要真浏览器行为时用 | GitHub |
| [@feather_wch/dsh-plugin-ui-debug](https://www.npmjs.com/package/@feather_wch/dsh-plugin-ui-debug) | UI 调试专项 | npm ⚠️ 先看扫描报告 |
| [@tiphareth/dsh-workbench](https://www.npmjs.com/package/@tiphareth/dsh-workbench) | 工作台式集成 | npm ⚠️ 先看扫描报告 |

> **A 组里 devkit 是唯一「装了就改变工作方式」的**，优先级最高。

### B. 代码质量闸门（防 AI 写出静默错误）

| 插件 | 解决什么 | 来源 |
|---|---|---|
| [a179-sanae/dsh-code-check](https://github.com/a179-sanae/dsh-code-check) | **模型每次编辑/新建 TS 文件后自动跑 `tsc --noEmit` 诊断**。vibe coding 最容易出的就是类型错误堆积，这个直接自动拦 | 经 [awesome-dsh-plugin](https://github.com/caoyiwei850/awesome-dsh-plugin) 收录 |
| [Mingxi2077/dsh-plugin-review](https://github.com/Mingxi2077/dsh-plugin-review) | 审查模式：**多维度代码健康评分 + 雷达图 + 审查历史**。适合阶段性体检 | GitHub |
| [shaoshi20/dshscan](https://github.com/shaoshi20/dshscan) | 插件安全扫描（同时也用来扫你自己写的插件的暴露面） | GitHub |
| `dsh-code-review` | 代码审查 | npm ⚠️ |

### C. 视觉与设计（桌宠本体是视觉产品）

| 插件/技能 | 解决什么 | 来源 |
|---|---|---|
| [xulelenlp/dsh-web-artifact-designer](https://github.com/xulelenlp/dsh-web-artifact-designer) | Web artifact 设计器 | GitHub |
| [13 款 DSH 设计插件筛选（Discussion #2187）](https://github.com/deepseek-ai/deepseek-harness/discussions/2187) | 一整个设计插件生态的筛选结果，**先看这篇再挑**，别一个个试 | 官方 Discussion |
| `dsh-commercial-ui-ux` | 商业化 UI/UX | npm（未见 ⚠️） |
| `sheleg-design-skill` | 设计技能包 | npm ⚠️ |

> 注意：桌宠 UI 是**透明窗上的像素动画**，不是常规 Web 页面。设计插件能帮你做**设置面板/状态面板**，但**动画与像素素材本身它们帮不上**，别期待错。

### D. 编辑/终端/Git 集成（少切窗口）

| 插件 | 解决什么 | 来源 |
|---|---|---|
| [meto-ventus/dsh-ventus-plugins](https://github.com/meto-ventus/dsh-ventus-plugins) | 整合包：**右侧重栏（文件树 / 编辑器 / 终端 / Git）+ 多引擎搜索 + 子代理进度 + 提示词优化浮窗**等 11 项，**每模块可单独安装** | GitHub |
| [@all3cn/dsh-better-sidebar-n23](https://www.npmjs.com/package/@all3cn/dsh-better-sidebar-n23) | 增强侧边栏 | npm |
| [@wannanbigpig/dsh-sidebar](https://www.npmjs.com/package/@wannanbigpig/dsh-sidebar) | 侧边栏 | npm ⚠️ |

### E. 可选加装（能力扩展）

| 插件 | 解决什么 |
|---|---|
| [15-plugin family（Discussion #2345）](https://github.com/deepseek-ai/deepseek-harness/discussions/2345) | **checkpoints（存档回滚）、权限规则、记忆、MCP 面板**等。其中 **checkpoints 对自研项目极有价值**——改崩了能回滚 |
| [MYCF711/dsh-plugin-forge](https://github.com/MYCF711/dsh-plugin-forge) | 「插件锻造工坊」：专家 Agent 团队从零把 DSH 插件做到可发布。**如果你要同时写桌宠插件和窗口壳**，这个能省事 |
| [neil-ji/dsh-spark-plugins](https://github.com/neil-ji/dsh-spark-plugins) | 第三方插件 monorepo：连接器、成本统计、跨会话记忆、UI 组件库。**其开发流程值得抄**：`pnpm sandbox:install` 走「通道 B（保真）—— pack → tarball 装进沙箱 profile，与用户安装同路径」 |

---

## 3. 建议的安装顺序（别一次装十个）

```
第 1 步：确认 HMR 循环已通（不装任何东西）
         └─ 改一行客户端插件代码，确认 GUI 自动重载
            ⚠️ 2026-09-29 实测：本机不成立（无 dev watcher、无 DSH 源码树）→ 见 §1 与 §7
第 2 步：装 1 个 —— CkEFFAF/dsh-plugin-devkit
         └─ 拿到 /debug inspector 与 slot 预览
第 3 步：装 1 个 —— TEGONG00/dsh-plugin-browser
         └─ 拿到截图/元素拾取闭环（或选 dsh-plugin-chrome）
第 4 步：装 1 个 —— a179-sanae/dsh-code-check
         └─ 自动 tsc 类型闸门
第 5 步：装 1 个 —— 侧栏类（ventus 整合包按需只装文件树/终端/Git）
第 6 步：跑通桌宠窗口壳的「透明 + 置顶 + 点击穿透」最小 demo 后
         └─ 再按需加 checkpoints / 设计插件
```

**每个插件装完都跑一次扫描 + 重启验证，坏了立刻卸载。**

---

## 4. 重要提醒：桌宠的「窗口壳」部分，这些插件帮不上

DSH 插件生态都在 **DSH GUI 内部**。而你选了**独立原生透明置顶窗**——那部分代码（Tauri/Electron）**运行在 DSH 之外**，DSH 插件只能帮你**写**它，不能帮你**调试**它。

所以你需要的是「**DSH 插件 + 外部工具**」的组合：

| 需求 | DSH 插件能帮 | 必须外部解决 |
|---|---|---|
| 写窗口壳代码 | ✅ 编辑器/终端/侧栏 | — |
| 看窗口渲染效果 | ⚠️ 只能看**浏览器内**的截图 | **透明/置顶/点击穿透必须肉眼在桌面上看** |
| 调像素动画 | ❌ | spritesheet 工具、Aseprite 类编辑器 |
| 桌宠与 DSH 通信 | ✅ 客户端插件 + SSE 是天然接缝 | — |

> **⚠️ 2026-09-29 重要更正（这条原文是错的，会白费功夫）**：原文建议「桌宠壳通过 SSE 订阅 `GET /plugins/events` 来拿 agent 状态」。实测本机 `app.asar` 内该路由的定义是：
>
> > *"The Host half watches each package's stamped entry artifact and serves `/plugins/events`. It forwards existing graph-change and rebuilt notifications; every new connection receives the current full graph."*
>
> 也就是说它推的是**插件图变化与重建通知**（`graph` / `rebuilt` 帧），**与 agent 状态无关**——拿不到"思考中/工具调用/余额"。它能给你的只有"插件重建后自动刷新桌宠前端"。
>
> **要拿 agent 状态，正确做法是按 [`PLAN.md`](../PLAN.md) 第三节自建 Host 插件**：监听 `session/event` + `agent/assistant-stream`（两者均已验证存在于本机版本），再以自己的同源 SSE 路由（如 `/api/xilian-pet/events`）推给桌宠壳。

---

## 5. 技术路线参考（非 DSH 插件，属你要写的代码）

**Windows 上「透明 + 置顶 + 点击穿透」的坑最多，这是你项目的真正难点：**

| 路线 | 现状/坑 | 参考 |
|---|---|---|
| **Tauri** | 透明窗口**支持点击穿透仍在推进中**，是这个技术栈的已知痛点 | [tauri-apps/tauri Issue #13070](https://github.com/tauri-apps/tauri/issues/13070) ｜ [StackOverflow：透明 Tauri + alwaysOnTop 时如何让用户与下层窗口交互](https://stackoverflow.com/feeds/question/76750116) |
| **Electron** | 已有成熟桌宠范例，透明+穿透可落地 | [kirineko/desktop-pet（像素桌面宠物，Electron）](https://github.com/kirineko/desktop-pet) ｜ [`@ganziliang/desktop-pet`](https://www.npmjs.com/package/@ganziliang/desktop-pet) |
| **Windows 原生 API** | 想做全屏透明覆盖层需要 Win32 层处理（`WS_EX_*` 样式） | [screenpipe 的 Win32 overlay 提交](https://github.com/screenpipe/screenpipe/commit/2333f7fa3e5b7d768d200df16a6740872ab7a010)（含 `WS_EX_NOACTIVATE` 取舍注释） |

> **据现有信息，Electron 路线的透明+穿透是已验证可行的；Tauri 的点击穿透可能卡住你。** 若你的核心诉求是「桌面挂件」体感，**建议从 Electron 起步**，把 Tauri 当性能优化选项留到后面。

---

## 6. 安全红线（照抄上一版，因为结论没变）

- [Discussion #1441：vm 沙箱宿主逃逸，PoC 已验证，一次批准 = 完整 RCE](https://github.com/deepseek-ai/deepseek-harness/discussions/1441)
- [Discussion #451：沙箱逃逸 ×2 + 本地 /api RPC 无鉴权](https://github.com/deepseek-ai/deepseek-harness/discussions/451)
- [zzszmyf/dsh-security-pocs](https://github.com/zzszmyf/dsh-security-pocs) ｜ [CVE-2026-101102](https://vuldb.com/zh/cve/CVE-2026-101102)

**2026-09-29 复核更正**：以上链接均真实存在，但**版本判定要改**——本机实测是 **0.1.7-rc.1**（非 `rc.8`），且两个真实 CVE 本机**都不命中**：CVE-2026-82533（9.6 CRITICAL，本地控制 API 鉴权绕过）修于 `0.1.2-alpha.1`；CVE-2026-101102 影响 `0.1.0-rc.0 … 0.1.0-rc.7`。**但红线不变**：#1441/#451/#250 仍是 open 的设计类问题（`node:vm` 不是安全边界；`/api` RPC 仅靠 Host 头围栏；沙箱内可经 Web approval 回环**自批准 `danger-full-access`**）。此外 `cordis.patch.yml` 明确允许 `!!js` 表达式（asar 内出现 148 次）→ **改 patch 文件等同执行代码**，动它之前先备份（备份见 `chajian/backup/`）。补充一个真实可用的扫描器：`@shaoshi/dshscan`（latest 0.5.0，静态+语义双通道，含 DSH 特有规则 R010–R015）。

**本清单中带 ⚠️ 的 npm 包**（装前先看 [socket.dev](https://socket.dev) 报告）：
`@tiphareth/dsh-workbench`、`@feather_wch/dsh-plugin-ui-debug`、`@wannanbigpig/dsh-sidebar`、`@harness-desktop/dsh-client-hmr`、`dsh-code-review`、`sheleg-design-skill`

**对你这个项目的特殊风险**：桌宠壳需要**进程创建 + 文件系统 + 原生窗口**权限，是权限需求最高的一类。开发期更要坚持「装一个、扫一个」。

---

## 7. 安装前验证清单

- [x] ~~**确认 HMR watcher 在跑**~~ → **2026-09-29 实测：没有在跑**（除 19387 外无 dev 端口、无 node 进程），且本机无 DSH 源码树 → **重建链当前不可用**，自研插件改代码需重新安装
- [ ] 确认 `dsh-plugin-devkit` 的 `/debug` 与你的 DSH 版本兼容（**本机实测 = `0.1.7-rc.1`**；注意 DSH 有精确版本兼容闸门，不匹配会以 `incompatible-version` 拒绝安装，需 `dsh plugin allow-version … --accept-risk`）
- [ ] **确认安装通道**：命令行装插件会撞沙箱写边界（`~/.dsh/profiles/desktop` 在工作区外、不可写）→ 走 **GUI 插件管理页**；纯前端依赖实验可在工作区内 `pnpm --store-dir .\.pnpm-store add …`
- [ ] **联网前确认 TLS 路径**：shell 内 `curl` / PowerShell / `git` 默认后端 HTTPS 全挂（`SEC_E_NO_CREDENTIALS`）→ 用 npm/pnpm（Node 自带 OpenSSL），git 加 `-c http.sslBackend=openssl`；`github.com` 与 `raw.githubusercontent.com` 本身也不可达，用 npm registry / codeload tarball
- [ ] 浏览器类插件二选一即可（`dsh-plugin-browser` vs `dsh-plugin-chrome`），**别同时装**
- [ ] `a179-sanae/dsh-code-check` 确认其 `tsc` 调用方式（是否用你项目本地 `tsconfig`）
- [ ] 侧栏类若用 ventus 整合包，确认能否**只装需要的模块**
- [ ] 凡带 ⚠️ 的包，先看 socket.dev 报告再决定
- [ ] 首装前备份 `cordis.patch.yml`
- [ ] 不要装 HMR 类插件（官方已内建）

---

## 8. 一句话总结

> ~~你已经拥有 HMR 这个最重要的地基，**不需要为热重载装任何插件**。~~
> **2026-09-29 实测更正**：HMR **传输**（`@deepseek-ai/dsh-client-hmr`，随包版本 0.1.7-rc.1）确实已内置，所以"不要装 HMR 插件"这条结论**依然成立**；但**重建 watcher（`pnpm run dev:web`）没有在跑，且本机没有可编辑的 DSH 源码树**，所以"改一行就自动重载"的循环**当前拿不到**——自研插件改完代码需要重新安装，除非先解决源码 checkout。
> 真正缺的是三件事：**开发期可观测（devkit）、看效果闭环（browser 面板）、防 AI 静默错误（tsc 闸门）**。
> 先装这 3 个跑通循环，其余按需加。桌宠的窗口壳难题（透明+穿透）在 DSH 插件生态之外，Electron 起步比 Tauri 稳。
