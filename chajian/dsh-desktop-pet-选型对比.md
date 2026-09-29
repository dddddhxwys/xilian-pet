# DSH 桌宠插件选型对比（独立原生透明置顶窗路线）

> 面向场景：DeepSeek Harness（DSH）桌面版，主力模型 v4.1flash，目标做一个**独立原生透明置顶窗**桌宠。
> 文档生成时间：本会话；作者：DSH Agent（选定「只出选型文档」后产出）。
>
> **修订（2026-09-29）**：本机环境已实测复核。§0 的两条「不可用」已失效、§1 的工作区路径与 DSH 版本已更正、§5 的安全结论已按真实版本重判、§6 的安装通道已改为 GUI 插件管理页。实测数据见 [`环境体检报告.md`](环境体检报告.md)。

---

## 0. 本文的可信度声明（请先读）

**我做了什么**：读取了你机器上的 DSH profile 配置，确认了插件挂载机制与当前已装插件；通过 Web 搜索收集了候选项目。

**当时的限制与 2026-09-29 复核结果**：

| 限制（**2026-09-29 已复核**） | 当时的具体表现 | 复核结果 |
|---|---|---|
| ~~shell 完全不可用~~ | 每次 pwsh 调用返回 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(F:\dsh\project\chajian)` | ✅ **已消失**：工作区迁到 `C:\Users\怒C大伟出奇迹\dsh-projects\xilian pet` 后读写删全部正常。根因是该 F: 旧目录**没有沙箱授权 ACE**，属局部问题而非全局故障 |
| ~~web_fetch 全被拦~~ | `github.com` / `raw.githubusercontent.com` / `npmjs.com` 等均报 "resolves to a non-public IP address" | ✅ **已失效**：实测 `web_fetch` 可抓 `api.github.com`、`registry.npmjs.org`、`raw.githubusercontent.com`（均 200）。抓不到 `github.com` HTML 属**网络层**问题（见下），不是工具被拦 |
| 无法核对版本兼容 | 以 DSH `dsh-v0.1.0-rc.8` 为基准 | ⚠️ **基准是错的**：本机实测为 **`0.1.7-rc.1`**，比文档以为的**新得多** → 多数候选的版本门槛其实**已满足**（见 §1 与 §5） |

**当前仍然存在的网络约束（2026-09-29 实测，直接决定本节能装什么）**

- **可达**：`registry.npmjs.org`、`registry.npmmirror.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`
- **不可达（超时）**：`github.com`、`raw.githubusercontent.com`、`www.google.com` → 拿 GitHub 源码要走 npm registry / codeload tarball / 镜像，**`git clone github.com` 会失败**
- **agent shell 内 Schannel TLS 全挂**（`SEC_E_NO_CREDENTIALS 0x8009030e`）：`curl`、PowerShell `Invoke-WebRequest`、`git` 默认后端都无法建 HTTPS。Node 系（npm/pnpm）自带 OpenSSL 正常；git 可加 `-c http.sslBackend=openssl` 绕过（已验证）

> 结论：本文是**候选筛选地图 + 验证清单**，不是「已测试可用」的推荐。带 ⚠️ 的项目请在安装前看安全扫描页。

---

## 1. 你的环境现状（已核实，非推测）

**Profile 目录**：`C:\Users\怒C大伟出奇迹\.dsh\profiles\desktop\`

**已装插件（第三方插件数 = 0）**，`package.json` 的 bundle 列表：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile"
      ]
    }
  }
}
```

**`cordis.patch.yml` 现有条目**：`ui-chat`、`ui-settings`、`ui-settings-account`（均为官方客户端 UI patch），另有两处个人配置：`transcriptView: standard`、`performanceUsage: detailed`、`developerTools: true`。

**`cordis.yml`**：空数组，顶部注释明确写着 **"Edit cordis.patch.yml, not this file"** —— 后续所有配置改动都改 `cordis.patch.yml`。

**`pnpm-workspace.yaml`**：`nodeLinker: hoisted`、`autoInstallPeers: false` —— peer 依赖不会自动补装。

**工作区**：`C:\Users\怒C大伟出奇迹\dsh-projects\xilian pet`（2026-09-29 起；`F:\dsh\project\chajian` 与 `F:\dsh\project\xilian pet` 为**旧路径，已无沙箱授权，勿搬回**，且其中仍留有一份同内容副本待清理）。工作区现有 `PLAN.md` 与 `chajian/` 三份文档，代码尚未起步。

---

## 2. 为什么「原生透明置顶窗」路线要先做一个架构判断

DSH 客户端插件默认渲染在 **Web GUI 内部**（一个 React 浮动层）。你要的「独立透明置顶窗」有两种实现路径，取舍差别很大：

| | 路径 A：宿主进程内开原生窗口 | 路径 B：独立进程 + 协议连接 |
|---|---|---|
| 典型技术 | Rust（Tauri/wry/tao）在 DSH 宿主进程或紧邻进程内创建窗口 | 独立 Electron / Tauri 可执行文件，通过 SSE / WebSocket / 本地 HTTP 与 DSH 通信 |
| 优点 | 启动快、内存小、与 agent 状态耦合最紧 | 与 DSH 升级解耦，DSH 崩了宠物还在；可独立调试 |
| 缺点 | 强耦合 DSH 版本，DSH 升级可能失效 | 双进程生命周期管理（谁先启动、谁负责拉起谁） |
| 对你的适配 | 想要「DSH 的一部分」 | 想要「桌面常驻挂件」 |

**关键观察**：本路线下的候选项目基本都用 **SSE 推送 agent 状态**（token 用量、思考中/空闲），这说明「状态源」已是事实标准接口。选型时**优先看它走 SSE 还是私有 IPC**——走 SSE 的更容易与第三方/自研前端组合。

---

## 3. 候选对比矩阵（原生窗口路线）

信息来自搜索元描述，**功能描述未经 README 核实**。

| 项目 | 技术栈 | 窗口能力（据描述） | 状态源 | 亮点 | 风险/待确认 |
|---|---|---|---|---|---|
| [HuanLinOTO/dsh-plugin-pet-rs](https://github.com/HuanLinOTO/dsh-plugin-pet-rs) | Rust | **透明置顶窗** + **系统托盘** | **双 SSE 实时推送** | 5 态鲸鱼；**三端支持**；有[实战博客](https://blog.yeyupiaoling.cn/article/1786964971071?lang=zh-cn)与 Releases 页 | Rust 构建链较重；需确认预编译产物是否覆盖你的 Windows 版本 |
| [crossoverthere/dsh-whale-desktop](https://github.com/crossoverthere/dsh-whale-desktop) | Electron | **透明置顶 + 可点击穿透** | 基于 `dsh-whale-widget`（DSH 插件版） | **Windows 专向**，点击穿透是最贴近「桌面挂件」的体验 | Electron 内存占用高；明确标注 Windows-only |
| [@asahimoon/dsh-desktop-pet](https://socket.dev/npm/package/@asahimoon/dsh-desktop-pet) | 未确认 | 未确认 | 未确认 | 有独立安全扫描页可查 | npm 页面带 ⚠️；**须先看 socket.dev 报告** |
| [sereinmono/dsh-desktop-pet](https://github.com/sereinmono/dsh-desktop-pet) | 未确认 | 未确认（疑为 GUI 内嵌） | 未确认 | **支持 Codex pet 格式** | 名字含 desktop 但可能不是原生窗口，**需先确认形态** |
| `dsh-desktop-pet`（npm） | 未确认 | 未确认 | 未确认 | — | 带 ⚠️ |
| `dsh-whale-pet-yjj730`（npm） | 未确认 | 未确认 | 未确认 | — | 带 ⚠️ |

### 已排除 / 不属于本路线

| 项目 | 排除理由 |
|---|---|
| [zhu1090093659/dsh-pet](https://github.com/zhu1090093659/dsh-pet)、[mjw-git/dsh-pet](https://github.com/mjw-git/dsh-pet)、[youzhoujiMrLiu/dsh-codex-compatible-pet](https://github.com/youzhoujiMrLiu/dsh-codex-compatible-pet)、`@kkkey/dsh-client-pet-ui` | 均为 **Web GUI 内嵌**桌宠（你已否决该路线）；但**其 spritesheet / 动画状态机设计仍值得抄**，见第 4 节 |
| [new-256/dsh-desktop](https://github.com/new-256/dsh-desktop)、[anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)、`formycity/dsh-desktop` | 是 **DSH 桌面客户端包装器**，不是桌宠；属宿主环境选项 |
| `@deepseek-ai/dsh-session-log-export`、`@deepseek-ai/libreoffice-kit` | 你本地 `app.asar.unpacked` 里的官方内置件，非桌宠相关 |

---

## 4. 素材与动画：路线确定后你真正要解决的问题

原生窗口只解决「窗子」，桌宠的体验取决于**动画素材 + 状态机**。据我掌握的生态情况：

- **Rust 版 pet-rs** 内置「5 态鲸鱼」——即状态机是**硬编码 5 个状态**，要换形象/加动作大概率需要**改 Rust 代码**，不是丢个素材包就行
- **Codex pet 格式**（`sereinmono/dsh-desktop-pet`、`youzhoujiMrLiu/dsh-codex-compatible-pet` 都提到）是目前生态里**唯一的素材格式事实标准**。若你要自绘角色，**采用 Codex pet 格式能让你的素材在多套宠物实现间复用**，这是重要的可移植性资产
- API 侧对**自定义 spritesheet + 随 token 用量成长**的支持，我目前只在 `mjw-git/dsh-pet`（Web GUI 路线）的描述里看到

**建议的架构结论**：若长期要自己养角色，**把「素材格式」和「窗口壳」解耦**——素材按 Codex pet 格式组织，窗口壳可替换。这样你现在选 Electron 还是 Rust 都不会被锁死。

---

## 5. 安全：本生态的已知高危问题（决定你的安装策略）

**先给结论（2026-09-29 实测复核，取代本节原来的推论）**：本机 DSH 是 **0.1.7-rc.1**，不是 `0.1.0-rc.8`。两个**真实** CVE 的影响区间本机**都不命中**——CVE-2026-82533（本地控制 API 鉴权绕过，CVSS 9.6 CRITICAL）修于 `0.1.2-alpha.1`；CVE-2026-101102（Code Mode Sandbox，6.3 MEDIUM）影响 `0.1.0-rc.0 … 0.1.0-rc.7`。**但"插件 = 宿主进程执行权"这个判断完全不变**：#1441、#451、#250 三个设计类问题至今 open 且无维护者回复。另外两处更正：本节原先引用的 Discussion **#413 与主题无关**（正确引用是 **#4136**）；CSA 研究简报 PDF 连续 403 + Wayback 不可用，**内容未核实，不予采信**。完整证据与版本判定见 [`环境体检报告.md`](环境体检报告.md) §S3/§S13。

搜索结果指向 DSH 插件机制存在**多个已公开、带 PoC 的高危问题**：

- [Discussion #1441：动态插件 vm「沙箱」存在宿主进程逃逸，PoC 已验证，一次批准 = 完整 RCE](https://github.com/deepseek-ai/deepseek-harness/discussions/1441)
- [Discussion #451：高危 —— vm 沙箱逃逸 ×2 + 本地 /api RPC 无鉴权](https://github.com/deepseek-ai/deepseek-harness/discussions/451)
- [zzszmyf/dsh-security-pocs：三个漏洞的 PoC（`!!js` 配置执行 / 只读沙箱全盘可读 / vm 逃逸到宿主无约束 RCE）](https://github.com/zzszmyf/dsh-security-pocs)
- 关联 CVE：[CVE-2026-101102](https://vuldb.com/zh/cve/CVE-2026-101102)；第三方分析：[CSA 研究简报](https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/09/CSA_research_note_deepseek_harness_sandbox_escape_20260910-csa-styled.pdf)

**推论（重要）**：装第三方 DSH 插件 ≈ 授予代码在你宿主上执行的能力。
而**桌宠恰恰是权限需求最大的插件类别**——它需要文件系统、进程、原生窗口、可能还有屏幕/输入。所以：

1. **优先选能自己审源码的项目**（Rust/Electron 独立进程天然比「宿主内插件」更容易隔离）
2. **优先选独立进程方案**：即使 DSH 的插件沙箱被攻破，独立可执行文件的暴露面也更可控
3. **装前跑扫描**：[dshscan](https://github.com/shaoshi20/dshscan)、`@guojin-ai/dsh-plugin-guard`、`dsh-plugin-audit`、[dsh-skill-pack-security](https://github.com/deepseek-ai/deepseek-harness/discussions/4136)（含 `plugin_vet` 供应链闸门）
4. **带 ⚠️ 的 npm 包一律先看 [socket.dev](https://socket.dev) 报告**再决定

> 注意：独立进程方案能降低「DSH 沙箱被逃逸」的影响，但**不降低「这个包本身的恶意代码」风险**——后者只能靠审源码和扫描解决。

---

## 6. 安装机制（供你手动执行）

profile 是**分层组合**结构：`package.json` 的 `dsh.profile.bundles` 逐层叠加 → 再叠加 `cordis.patch.yml` → 再叠加 `--patch` 覆盖。

**推荐顺序**：先装一个插件市场（如 [Minglink/dsh-stream-market](https://github.com/Minglink/dsh-stream-market) 或 [dsh-market](https://github.com/dsh-market/dsh-market)），由它处理 bundle 注册与卸载。

**⚠️ 先看这条本机限制（2026-09-29 实测）**：agent shell 的沙箱写边界只剩「工作区 + TEMP」，而插件要装进 `~/.dsh/profiles/desktop/`（工作区外）——**命令行安装会被直接拒绝**；且 PATH 里**没有 `dsh` 命令**（npm 上的 `deepseek-harness@0.0.1` 只是占位包，无 bin）。

**两条可行通道**
1. **GUI 插件管理页**（推荐）：本机已确认存在 `@deepseek-ai/dsh-client-ui-plugin-manager`（安装引导 + 安装源 + pending/approved builds 审批）。GUI 进程不受 agent shell 的文件沙箱约束。
2. **命令行**：对安装类命令提权后执行，调用方式待确认。

**手动安装两步（提权后）**：
1. 在 `~/.dsh/profiles/desktop/` 下安装包，并把包名加入 `package.json` → `dsh.profile.bundles` 数组
2. 需要改配置时，在 `cordis.patch.yml` 追加 patch 条目（**不要改 `cordis.yml`**）。**改前先备份**——本仓已存一份：`chajian/backup/cordis.patch.yml`

**社区已知坑**：
- 从 git 安装且需构建的插件会跑 `prepare` 脚本，**pnpm 10+ 默认拦截**，首次 `add` 可能失败
- 本 profile `autoInstallPeers: false`，peer 依赖缺失需手动补
- `pnpm-workspace.yaml` 由 DSH 托管，不要手改

---

## 7. 决策建议

> **2026-09-29 复核：本章结论的素材基础有变。** §3 矩阵里隐含的「有预编译产物」假设经核实**不成立**——
> - `dsh-plugin-pet-rs`：唯一 Release `v0.0.1` 的 **assets 为空数组**，README 自述因 Actions 额度问题「请自行构建」→ Rust 构建链得自己扛
> - `dsh-whale-desktop`：**releases 返回 `[]`**，`electron-builder` 打包在路线图里仍未完成 → 只能 `npm install && npm start`
> - `PC2005-cloud/dsh-pet`：v0.1.0→v0.2.12 **全部 release assets 为空**（唯一带资产的 tag 是 82.5MB 的 `.mov` **动画素材**，不是程序）
>
> **真正开箱可用（有 Windows 预编译 + 不卡 DSH 版本）的只有 [`MerZlin/dsh-pet-indesktop`](https://github.com/MerZlin/dsh-pet-indesktop)**：Python/PySide6 独立程序，v4.2.1 附 `setup.exe` + portable zip，不依赖 DSH 运行（安装包未签名，需 SmartScreen 放行）。
>
> 另一个好消息：本机实为 **`0.1.7-rc.1`**（非文档早前写的 rc.8），因此 cyanfish-x（要求 ≥`0.1.5-rc.1`）、whale-girl / remielle 的桌面模式（要求 ≥`0.1.2-alpha.1`）、PC2005（在 `0.1.5-rc.1` 开发）的**版本门槛全部满足**——按旧版本基准做的"不兼容"判定作废。

**若「桌面常驻挂件」体感优先** → [crossoverthere/dsh-whale-desktop](https://github.com/crossoverthere/dsh-whale-desktop)
理由：透明置顶 **+ 点击穿透**是桌面挂件的核心体验，且 Electron 方案改动画素材的门槛最低。

**若「资源占用 / 长期稳定」优先** → [HuanLinOTO/dsh-plugin-pet-rs](https://github.com/HuanLinOTO/dsh-plugin-pet-rs)
理由：Rust 内存与启动优势明显，双 SSE 接口清晰，有博客与 Releases 佐证成熟度。

**若「自己养角色」优先** → 先用任一方案跑通窗口壳，**同时把素材按 Codex pet 格式组织**，为后续替换壳层留后路。

---

## 8. 安装前验证清单（逐项打勾再动手）

- [ ] 打开候选仓库 README，确认**确实是原生透明置顶窗**，而非 Web GUI 内嵌（重名项目较多）
- [ ] 查 Releases 是否有**预编译 Windows 产物**——**实测经验：本批候选中绝大多数 release 的 assets 为空数组**（pet-rs / whale-desktop / dsh-pet / remielle 均是），别按"应该有 exe"做计划
- [ ] 确认支持的 DSH 版本与你本地一致（**本机实测 = `0.1.7-rc.1`，不是 rc.8**；DSH 有精确版本兼容闸门，不匹配会以 `incompatible-version` 拒绝，需 `dsh plugin allow-version <pkg@ver> --dsh-version <runtime> --accept-risk`）
- [ ] 看该包的 **socket.dev 报告**，特别是带 ⚠️ 的（注意：本机 shell 抓 `socket.dev` 会被 Cloudflare 403，改用 `web_search` 或 `api.github.com`）
- [ ] 读源码或跑 `@shaoshi/dshscan`，重点看：网络请求目标、子进程调用、文件读写范围
- [ ] 确认卸载方式彻底（市场类插件可原子卸载最优）
- [ ] **确认安装通道能落地**：命令行装插件会撞沙箱写边界（`~/.dsh/profiles/desktop` 在工作区外不可写）→ 走 GUI 插件管理页；纯前端依赖实验用 `pnpm --store-dir .\.pnpm-store add …`
- [ ] **联网前确认 TLS 路径**：shell 内 `curl`/PowerShell/`git` 默认后端 HTTPS 全挂（`SEC_E_NO_CREDENTIALS`）→ 用 npm/pnpm；git 加 `-c http.sslBackend=openssl`
- [ ] 在**非主力 profile** 或先备份 `cordis.patch.yml` 的情况下首装（本仓已备一份：`chajian/backup/cordis.patch.yml`）

---

## 9. 参考链接

**候选项目**
- [HuanLinOTO/dsh-plugin-pet-rs](https://github.com/HuanLinOTO/dsh-plugin-pet-rs) ｜ [Releases](https://github.com/HuanLinOTO/dsh-plugin-pet-rs/releases) ｜ [实战博客（中文）](https://blog.yeyupiaoling.cn/article/1786964971071?lang=zh-cn)
- [crossoverthere/dsh-whale-desktop](https://github.com/crossoverthere/dsh-whale-desktop)
- [sereinmono/dsh-desktop-pet](https://github.com/sereinmono/dsh-desktop-pet)
- [@asahimoon/dsh-desktop-pet 安全分析](https://socket.dev/npm/package/@asahimoon/dsh-desktop-pet)
- 生态参考（Web GUI 路线，素材设计可借鉴）：[zhu1090093659/dsh-pet](https://github.com/zhu1090093659/dsh-pet) ｜ [mjw-git/dsh-pet](https://github.com/mjw-git/dsh-pet) ｜ [youzhoujiMrLiu/dsh-codex-compatible-pet](https://github.com/youzhoujiMrLiu/dsh-codex-compatible-pet)

**市场与管理**
- [Minglink/dsh-stream-market](https://github.com/Minglink/dsh-stream-market) ｜ [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)
- 中文导航：[gityuanbao/DSH-Plugins](https://github.com/gityuanbao/DSH-Plugins) ｜ [awesome-deepseek-harness](https://github.com/XiaomingX/awesome-deepseek-harness)

**安全**
- [Discussion #1441（vm 沙箱逃逸 → RCE）](https://github.com/deepseek-ai/deepseek-harness/discussions/1441)
- [Discussion #451（沙箱逃逸 ×2 + /api RPC 无鉴权）](https://github.com/deepseek-ai/deepseek-harness/discussions/451)
- [zzszmyf/dsh-security-pocs](https://github.com/zzszmyf/dsh-security-pocs) ｜ [CVE-2026-101102](https://vuldb.com/zh/cve/CVE-2026-101102)
- [shaoshi20/dshscan](https://github.com/shaoshi20/dshscan) ｜ [dsh-skill-pack-security（plugin_vet）](https://github.com/deepseek-ai/deepseek-harness/discussions/4136)

**官方文档**
- [DSH 插件发布指南（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md) ｜ [插件开发 KB](https://github.com/Pasumao/dsh-plugin-dev-kb/blob/main/kb/site/develop/basic/publish.md)
