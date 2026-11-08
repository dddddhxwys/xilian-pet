# 昔涟桌宠（开发向 README）

贴在 Windows 桌面上的**昔涟（Cyrene）**：DSH Host 插件（大脑）→ 同源 SSE → Electron 透明置顶窗（显示器）
→ IPC → Live2D 渲染端；另有操作面板小窗、设置窗与审批小窗。

> **这份 README 是给开发 / 维护者的。** 普通用户（下载、安装、使用、FAQ）请看
> [Releases 的发布说明](https://github.com/dddddhxwys/xilian-pet/releases) 或
> [在线介绍页](https://ddddddhxwys.github.io/xilian-pet/)。
> **用户向内容不再写回本文件**（约定见 §7）。

> 非官方同人作品，与米哈游无关联、未获其授权，**不用于任何商业用途**。
> 发行包内含第三方素材，**不在 MIT 覆盖范围内** —— 详见 [NOTICE.md](NOTICE.md)。

---

## 1. 架构（一分钟版）

```
┌──────────────────┐   SSE: /xilian-pet/events    ┌─────────────────────┐
│  DSH 本体         │ ──────────────────────────▶ │  pet-shell（外壳）    │
│  Host 插件        │ ◀────────────────────────── │  Electron 透明置顶窗   │
│  /xilian-pet/*    │  POST /approval /prompt      │  Live2D + 命中掩码     │
└──────────────────┘  /interrupt /focus           └─────────────────────┘
```

| 层 | 目录 | 职责 | 关键点 |
|---|---|---|---|
| **Host 插件** | `packages/pet-plugin/` | 注册 `/xilian-pet/*` 路由；把 DSH 会话事件归一化后推给外壳；接管 `approval/request`（`prepend` 抢在转发给 GUI 的桥之前，答不了就交棒）；`reducer.js` 是纯状态机 | 零依赖、零构建；**唯一状态源**；改动需**重启 DSH** |
| **外壳** | `packages/pet-shell/` | SSE 订阅与断线重连；`pet://` 协议；透明置顶窗与窗口/构图持久化；光标轮询命中测试；设置读写；面板/设置/审批三个小窗 | 连不上 DSH 也能独立显示与互动；改动需**重启桌宠** |
| **渲染端** | `packages/pet-shell/renderer/` | `pet.js`（普通脚本，交互/气泡/面板桥）/ `live2d.js`（**ES 模块**，模型与动作）/ `motion-policy.js`（动作策略）/ `hit-math.js`（命中）/ `mirror-math.js` / `peak-time.js`+`holidays.js`（峰谷判定） | 改渲染端不用重启 DSH |
| **工具** | `tools/` | 自测、打包、发布、安装器、模型修复、镜像探测等 | 见 §3/§5 |

数据流三条要点：

- 插件是**唯一状态源**；外壳只消费 SSE，不自己编状态。
- 外壳**连不上 DSH 也能跑**（显示/互动照常），并会**运行期自动重新发现** DSH 端口（约 6 秒一轮）。
- 审批：插件抢到 `approval/request` → 推送审批帧 → 外壳弹小窗 → 用户点允许/拒绝 → `POST /approval`。

## 2. 目录

| 路径 | 说明 |
|---|---|
| `packages/pet-plugin/` | Host 插件（`index.js` 路由/接线、`reducer.js` 状态机、`approval-config.js` 审批开关、`cordis.patch.yml` 包内默认配置） |
| `packages/pet-shell/` | Electron 主进程（`main.js`）、`sse-link.js`、`dsh-discovery.js`、`hit-test.js`、`settings.js`、`window-placement.js`、`tray-model.js`、`launcher-icon.ico` |
| `packages/pet-shell/renderer/` | 渲染端页面与脚本（`index.html`/`pet.js`/`live2d.js`/`menu.*`/`settings.*`/`approval.*`/`tokens.css`） |
| `tools/` | `check-plugin.mjs`（自测，**269 项**，不需要 DSH）、`package-release.mjs`、`publish-release.mjs`、`bump-version.mjs`、`setup.mjs`、`install-plugin.mjs`、`fetch-electron.mjs`、`lib/`（纯逻辑，可单测：`release-files` / `update-check` / `release-publish` / `desktop-shortcut` / `zip-writer` / `patch-edit`） |
| `docs/` | 接手状态报告（**权威现状**）、开发日志、测试指引、交接文档、复核报告 |
| `dist-release/` | 打包产物（zip + `.sha256` + `RELEASE-NOTES.md`）—— **整个目录 gitignore**，不随仓库分发 |
| `assets/live2d/Cyrene/` | 第三方 Live2D 模型（经作者授权，唯一入库的第三方素材之一） |
| `packages/pet-shell/.state/` | 运行时产物（`pet.log`、`settings.json`、`user-data/`、截图）—— **gitignore**，排障先看这里 |
| `*.cmd` | 发行用入口：`start-pet.cmd`（起桌宠）、`安装.cmd`（安装器）、`检查更新.cmd` |

## 3. 改什么 → 怎么生效（实测，别猜）

| 改了什么 | 生效方式 | 怎么确认 |
|---|---|---|
| `packages/pet-plugin/*.js` | **重启 DSH**（`hmr.root` 实测**无效**，ESM 缓存不失效） | `/health` 的 **`code` 变大**（别看 `uptimeMs`） |
| `packages/pet-shell/**`、`renderer/**` | **重启桌宠**（`Ctrl+Shift+Q` → `start-pet.cmd`） | `packages/pet-shell/.state/pet.log` 的**构建指纹**（每个文件 sha1 前 6 位） |
| profile 的 `cordis.patch.yml` | 会让插件重新 `apply()`，**但加载的仍是旧模块** | 同上：**只看 `code`** |

```powershell
node tools/check-plugin.mjs                              # 自测（269 项；不需要 DSH）
Invoke-RestMethod "$env:DSH_WEB_URL/xilian-pet/health"   # 活体；端口会变，别写死
.\start-pet.cmd                                          # 起桌宠（Ctrl+Shift+Q 退出）
```

- `code` = `CODE_REVISION`（**插件代码版本**）：每改一次插件就 +1，用来确认"重启后到底加载的是不是新代码"。
  当前 **28**；自测当前 **269**（数字会变，**以实际输出为准**）。
- 本机环境（2026-11 实测）：Windows 11 25H2、DSH **0.2.1-rc.5**（`F:\dsh`）、Electron **44.5.1**、node 24。
  环境事实/边界/网络/沙箱限制见 [docs/开发日志.md](docs/开发日志.md) §一/§三；接手先看
  [docs/接手状态报告-2026-10-11.md](docs/接手状态报告-2026-10-11.md) §0.1。

## 4. 验证纪律（本项目最大的风险是"以为验证过了"）

- 任何"已修复 / 已验证"都要附**可复现的证据**（命令 + 输出 / 文件 + 行号 / 截图）；拿不到就写"未验证"。
- **绿色不算证据**：新逻辑要配**变异测试**（把逻辑改坏，断言必须变红）。
- **禁止用源码正则断言代替行为断言**；"静态护栏 vs 行为断言"的现状盘点见报告 **§9.5**。
- 改任何东西都跑 `node tools/check-plugin.mjs`；发版前再跑 `node tools/bump-version.mjs --check`。

## 5. 打包与发布

```powershell
node tools/bump-version.mjs --check                            # 三处 package.json 是否一致
node tools/bump-version.mjs 0.2.1                              # 一处改、三处同步
node tools/package-release.mjs --with-model --with-electron    # 产出 dist-release/*.zip + *.sha256 + versions.json
node tools/publish-release.mjs --dry-run                       # 先看要传什么
node tools/publish-release.mjs                                 # 建/复用 tag + 上传资产（幂等，可重跑）
```

- **产物**：`dist-release/xilian-pet-v<版本>-<形态>-<时间戳>.zip`（+ 同名 `.sha256`），包内 `VERSION.txt`。
- **`versions.json` 受版本控制**，由打包脚本写（含 sha256，手抄必然对不上）；**打完包记得提交**。
- **用户向发布说明的唯一来源**：`dist-release/RELEASE-NOTES.md` —— 发布时作为 **GitHub Release 正文**
  （安装/使用/FAQ/许可证摘要都在里面，随每个版本更新）。
- ⚠️ **已知缺口（发布前必做）**：`versions.json` 会保留历史版本条目，而 `publish-release` 把 `assets`
  **全量**当成本次要传的文件 → 发布前要把 assets 手工裁到只剩当前版本两条并补 `notes`。
  来龙去脉见报告 **§9.12 / §9.13**（同一个坑踩过两次）。
- 网络：发布/推送前先 `git ls-remote origin` 自检；连不上先**提醒用户挂代理**、或给 git 加
  `-c http.sslBackend=openssl`，**不要**关证书校验。
- 发布后核对：GitHub API 里每个资产的 `digest`（sha256）应与本地 `.sha256` 逐字一致；再从 Release
  真下一个包复算一次，别只看"上传成功"。

## 6. 接手 / 深入

| 想看什么 | 去哪 |
|---|---|
| **进门须知 / 硬红线 / 本机边界** | [AGENTS.md](AGENTS.md) |
| **权威现状**（已完成、待办、风险、发布记录） | [docs/接手状态报告-2026-10-11.md](docs/接手状态报告-2026-10-11.md)（§0.1 速览、§9 风险与发布） |
| 环境事实 / 架构细节 / 踩坑 / 实机证据 | [docs/开发日志.md](docs/开发日志.md) |
| 给测试者的验收清单（用户向） | [docs/测试指引.md](docs/测试指引.md) |
| 官方 bundle 安装的完整交接 | [docs/交接给插件开发模式.md](docs/交接给插件开发模式.md) |
| 历史复核（验证到什么程度、哪些没做） | [docs/接手复核报告.md](docs/接手复核报告.md) |
| 调某个视觉参数（例：镜像问号倾斜） | `renderer/pet.css` 的 `--qmark-tilt`（当前 20deg，改完重启桌宠；来龙去脉见报告 §4.33） |

## 7. 用户向内容放哪（约定，别搬回 README）

| 内容 | 位置 |
|---|---|
| 下载哪个包 / 安装三步 / 怎么用 / FAQ / 版本说明 | **`dist-release/RELEASE-NOTES.md`** → 作为 GitHub Release 正文 |
| 同一份内容的网页版 | [`docs/index.html`](docs/index.html) → GitHub Pages |
| 给测试者的逐项验收 | [docs/测试指引.md](docs/测试指引.md) |

README 只做**开发入口**：架构、怎么跑、怎么验证、怎么打包发布、接手链接。

## 8. 硬红线（摘要，全文见 [AGENTS.md](AGENTS.md)）

- **`.cmd` 只能有 ASCII**（注释也算）；**不许用 PowerShell 写含中文的源码**（用 edit/write 工具）。
- 订阅 **waterfall** 事件必须 `return next()`（漏过一次，整个 profile 的工具调用全废）。
- 改 profile `cordis.patch.yml` **前先备份**；**拒绝 `!!js`**（配置期代码执行）。
- **素材与署名不许动**：模型（@是依七哒 授权）、插件图标（作者不明）、派生素材（问号图 / 启动图标）、
  角色权利归米哈游；`LICENSE` 必须保持纯 MIT 正文。
- **禁止源码正则断言代替行为断言**（坐标 bug 就是这么被锁死的）。

## 9. 许可证与第三方素材

**代码与文档**按 **MIT** 发布 —— 见 [`LICENSE`](LICENSE)（版权归 `dddddhxwys`）。
**发行包里的第三方素材不在 MIT 覆盖范围内**：Live2D 模型（作者授权，勿单独提取再分发）、
插件图标（社区图，作者不明）、启动图标（由委托素材裁切的派生素材，仅用于桌面快捷方式）、
角色「昔涟」及其美术形象（权利归米哈游）。
完整声明见 [NOTICE.md](NOTICE.md)。
