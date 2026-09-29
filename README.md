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
- ⚠️ **但 `pnpm run dev:web` 重建 watcher 没有在跑**，且本机**没有可编辑的 DSH 源码树**（只有打包好的 `app.asar`）。因此"改插件源码 → 浏览器自动热重载"这条链**当前不可用**；自研插件改完代码需要重新安装。
- ⚠️ **`GET /plugins/events` 推的是插件图变化与重建通知（`graph` / `rebuilt` 帧），不是 agent 状态**，拿不到"思考中/工具调用/余额"。要拿 agent 状态必须按 `PLAN.md` 第三节自建 Host 插件：监听 `session/event` + `agent/assistant-stream`，再以自己的同源 SSE 路由推给桌宠壳。
- 本机已验证**存在**的扩展点：`shell.overlay`、`settings.section`、`session/event`、`agent/assistant-stream`、`agent/pre-step`、`agent/turn-stopping`、`tools/pre-execute`、`tools/post-execute`、`dsh.bundle.patch`。

---

## 五、安全红线

- **装第三方插件 = 授予宿主进程执行权**。DSH 的插件 vm 沙箱**不是安全边界**（Discussion #1441，PoC 已验证：一次批准 = 完整 RCE；#451 沙箱逃逸 + `/api` RPC 仅靠 Host 头围栏；#250 沙箱内可经 approval 回环自批准 `danger-full-access`）。三帖至今 open。
- 已知 CVE 与本机关系（2026-09-29 复核）：**CVE-2026-82533**（本地控制 API 鉴权绕过，9.6 CRITICAL）修于 `0.1.2-alpha.1`；**CVE-2026-101102**（Code Mode Sandbox，6.3 MEDIUM）影响 `0.1.0-rc.0 … 0.1.0-rc.7` —— **本机 0.1.7-rc.1 两条都不命中**。
- `cordis.patch.yml` 允许 `!!js` 表达式（= 配置期代码执行）→ **改 patch 前先备份，且拒绝 `!!js`**。备份见 [`chajian/backup/`](chajian/backup/)。
- 装前扫描：`@shaoshi/dshscan`（静态+语义双通道）+ socket.dev（注意本 shell 抓 socket.dev 会 403，用 `web_search`）。

---

## 六、待人工处理的项（沙箱外才能做）

1. `~/.dsh/storages/workspace.json` 仍注册着 `F:\dsh\project\chajian`、`C:\Users\project`、`default-workspace` 三个历史工作区 → 可清理。
2. `F:\dsh\project\chajian` 仍有同内容副本 + 上一轮遗留的 `.write-probe` → 可删除（**保留 C: 这一份为唯一权威**）。
3. 可选：在你自己终端执行 `git config --global http.sslBackend openssl`，省掉每条 git 命令加参数。
4. 决策项：**是否需要一份 DSH 源码 checkout**（决定能否用 `dev:web` 的 HMR 重建链）。

---

## 七、目录

```
PLAN.md                             调研结论与技术验证计划（含验收标准 A1–A10）
chajian/
  环境体检报告.md                    2026-09-29 环境隐患实测报告（13 项 + 证据）
  dsh-desktop-pet-选型对比.md        独立原生透明置顶窗路线选型
  dsh-vibe-coding-插件清单.md        开发循环插件清单
  backup/                           DSH profile 配置备份（cordis.patch.yml 等）
```
