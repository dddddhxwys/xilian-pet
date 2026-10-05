/**
 * 昔涟桌宠 · Electron 透明置顶窗外壳
 *
 * Phase 0 目标：透明 + 无边框 + 置顶 + 可拖动 + 位置持久化，
 * 通过 SSE 订阅 Host 插件事件，点击穿透用 alpha 掩码命中测试。
 *
 * 注意两个本机特有的坑：
 *  1. ELECTRON_RUN_AS_NODE=1 会让 electron 当纯 node 跑、不开窗 —— 启动脚本会删掉它
 *  2. agent shell 的沙箱只允许写工作区，所以窗口位置默认存到包内 .state/，
 *     而不是 Electron 默认的 userData（在 AppData，会被拒）
 */

import { app, BrowserWindow, globalShortcut, ipcMain, protocol, screen } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { contentBand, draggingExpired, hitTest } from './hit-test.js'
import { createSseLink } from './sse-link.js'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const DSH_URL = process.env.PET_DSH_URL ?? 'http://127.0.0.1:19387'
const ROUTE_PREFIX = (process.env.PET_ROUTE_PREFIX ?? '/xilian-pet').replace(/\/+$/, '')
const STATE_DIR = process.env.PET_STATE_DIR ?? join(here, '.state')
const WIDTH = Number(process.env.PET_WIDTH ?? 260)
const HEIGHT = Number(process.env.PET_HEIGHT ?? 300)

// ── Live2D 模型目录 ─────────────────────────────────────────────────
// 默认在仓库内的 assets/live2d/Cyrene（该目录已 gitignore，模型不入库）。
// 模型是第三方作品（B站 @是依七哒），授权要求"注明用途 + 不得收费"，署名见 NOTICE.md。
const MODEL_DIR = process.env.PET_MODEL_DIR ?? join(here, '..', '..', 'assets', 'live2d', 'Cyrene')
const RENDERER_DIR = join(here, 'renderer')

// ⚠️ 为什么整页都走自定义协议（而不是 loadFile + 相对路径）：
//   Cubism Core 要把 .moc3 读成 ArrayBuffer，走 XHR/fetch。
//   而 Chromium 里 **file:// 页面不能 XHR pet:// 或 file://** —— 实测报
//     "Access to XMLHttpRequest at 'pet://…' from origin 'file://' has been blocked by CORS policy"
//   （file:// 是不透明源，不在跨源白名单里）。
//   所以把 **页面本身和模型文件放在同一个协议的同一个 host 下** → 同源，CORS 问题直接消失，
//   而且 CSP 也能收紧回 'self'（比之前显式列 pet: 更严）。
//   必须在 app ready 之前注册，否则 renderer 里 fetch 不认这个 scheme。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
])

const MIME = {
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.html': 'text/html',
}

/** 找到模型清单文件名（*.model3.json） */
function findModelSettings() {
  try {
    return readdirSync(MODEL_DIR).find((f) => f.endsWith('.model3.json')) ?? null
  } catch {
    return null
  }
}

/**
 * pet://app/…            → packages/pet-shell/renderer/…   （页面与静态资源）
 * pet://app/model/…      → assets/live2d/Cyrene/…          （Live2D 模型）
 * 两者同源（都是 pet://app），所以渲染端 XHR 模型文件不会被 CORS 拦。
 */
function registerModelProtocol() {
  protocol.handle('pet', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app') {
        return new Response(`unknown host: ${url.hostname}`, { status: 404 })
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const isModel = rel.startsWith('model/')
      const root = normalize(isModel ? MODEL_DIR : RENDERER_DIR)
      const sub = isModel ? rel.slice('model/'.length) : rel
      const full = normalize(join(root, sub || 'index.html'))

      // 目录穿越防护：解析后必须仍在对应根目录之内
      const sep = process.platform === 'win32' ? '\\' : '/'
      if (full !== root && !full.startsWith(root + sep)) {
        log(`协议拒绝了越界请求：${rel}`)
        return new Response('forbidden', { status: 403 })
      }

      const data = await readFile(full)
      return new Response(data, {
        headers: { 'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream' },
      })
    } catch (error) {
      log(`协议读取失败 ${request.url}：${error.message}`)
      return new Response(`file error: ${error.message}`, { status: 404 })
    }
  })
  log(`页面协议 pet://app/       → ${RENDERER_DIR}`)
  log(`模型协议 pet://app/model/ → ${MODEL_DIR}`)
}


mkdirSync(STATE_DIR, { recursive: true })
const statePath = join(STATE_DIR, 'window.json')

// 构图缓存：第一次启动要现场测量（约 3 秒），把结果存下来，
// 之后启动直接套用 → 既不用等，也不会出现"打开一会突然变大"。
// 键是模型清单的 URL（换模型各存一份）。
const fitCachePath = join(STATE_DIR, 'model-fit.json')
// 默认延迟到"构图就绪"再显示窗口；PET_DEFER_SHOW=0 可关掉（调试用）。
// 刻意不与 PET_SNAPSHOT 绑定 —— 绑过一次，结果快照测试永远走"立即显示"分支，
// 真实路径反而没被验证到。
const deferShow = process.env.PET_DEFER_SHOW !== '0'
let showFallbackTimer = null

function loadFitCache() {
  try {
    return JSON.parse(readFileSync(fitCachePath, 'utf8'))
  } catch {
    return {}
  }
}

function saveFitCache(all) {
  try {
    writeFileSync(fitCachePath, JSON.stringify(all, null, 2))
  } catch (error) {
    log('构图缓存写入失败:', error.message)
  }
}

function showWindow(win) {
  if (win.isDestroyed() || win.isVisible()) return
  clearTimeout(showFallbackTimer)
  win.showInactive()
  log('窗口已显示')
}

/**
 * 日志：控制台 + **落盘**（`.state/pet.log`）。
 *
 * 为什么必须落盘：agent 读不到用户那边的控制台。没有这个文件，
 * 用户报"还是有问题"时我只能靠猜 —— 已经因此**修错两轮**
 * （第一轮复现用强制 idle，真实路径却是 done）。
 * 现在渲染端的 console 也会被主进程转发进来（`[renderer]` 前缀），
 * 所以 Live2D 那边 `state.log` 的内容也一并落盘。
 */
const LOG_FILE = join(STATE_DIR, 'pet.log')
const LOG_MAX_BYTES = 2 * 1024 * 1024
let logBytes = 0
let logReady = false

function initLogFile() {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    // 超过上限就重开一个 —— 免得无限涨（一次长时间待机就能刷不少）
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) writeFileSync(LOG_FILE, '')
    logBytes = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0
    logReady = true
    appendFileSync(LOG_FILE, `\n===== 启动 ${new Date().toISOString()} ${buildStamp()} =====\n`)
  } catch {
    logReady = false
  }
}

/**
 * 构建指纹：用来一眼确认"用户到底重启到新代码没有"。
 * 排查时最怕的就是"修了但跑的还是旧代码"（这个也踩过）。
 */
/**
 * 构建指纹：用来一眼确认"用户到底重启到新代码没有"。
 * 排查时最怕的就是"修了但跑的还是旧代码"（这个也踩过）。
 *
 * ⚠️ 必须把 **UI 文件也纳入** —— 早先只盖 main/live2d/motion-policy 三个，
 *    结果"去掉光晕"（纯 CSS）这类改动**无法从日志判断有没有生效**（这次就踩了）。
 * ⚠️ 短名要保留扩展名：否则 `pet.js` 与 `pet.css` 都缩成 `pet`，行里出现两个 `pet=` 没法分辨。
 */
const STAMP_FILES = [
  'main.js',
  'hit-test.js',
  'sse-link.js',
  'renderer/pet.js',
  'renderer/pet.css',
  'renderer/index.html',
  'renderer/live2d.js',
  'renderer/hit-math.js',
  'renderer/motion-policy.js',
  'renderer/menu.js',
  'renderer/menu.css',
  'renderer/menu.html',
  'renderer/approval.js',
  'renderer/approval.css',
  'renderer/approval.html',
]

function buildStamp() {
  try {
    return STAMP_FILES.map((file) => {
      const short = file.replace(/^renderer\//, '')
      const hash = createHash('sha1').update(readFileSync(join(here, file))).digest('hex').slice(0, 6)
      return `${short}=${hash}`
    }).join(' ')
  } catch {
    return 'build=?'
  }
}

const log = (...args) => {
  console.log('[pet]', ...args)
  if (!logReady) return
  try {
    const text = `${new Date().toISOString()} [pet] ${args.join(' ')}\n`
    appendFileSync(LOG_FILE, text)
    logBytes += text.length
    if (logBytes > LOG_MAX_BYTES) writeFileSync(LOG_FILE, '')
  } catch {
    // 落盘失败不该影响运行
  }
}

/**
 * 把 A7「单击跳转」的结果写进 `.state/focus-log.txt`。
 *
 * 为什么落文件而不是只打控制台：agent 读不到桌宠的控制台，
 * "点了没反应"就只能靠用户手动抄日志。写文件后我自己 tail 一下就知道卡在哪一步。
 */
function appendFocusLog(line) {
  try {
    appendFileSync(join(STATE_DIR, 'focus-log.txt'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 写不进去就算了，绝不能因此影响跳转本身 */
  }
}

/**
 * A7「单击跳转」：把 DSH 窗口唤到前台。
 *
 * 为什么走 PowerShell：DSH 是**另一个进程**的 Electron 应用，桌宠无法直接操作它的窗口。
 *
 * ⚠️ 必须用 `-EncodedCommand`，**不能用 `-Command`**：
 *    命令行传多行脚本时，参数传递会把 here-string 里的 `"` 吃掉，
 *    实测直接变成一堆 PowerShell 解析错误（`Unrecognized token in source text`）。
 *    base64(UTF-16LE) 完全免疫引号/换行问题。
 *
 * ⚠️ 也不能只靠 `Process.MainWindowHandle`：实测本机它一直是 **0**，不可靠。
 *
 * 实现要点（都是被实机问题逼出来的）：
 *  1. **EnumWindows 枚举顶层窗口**，挑「属于 DSH 进程 **或** 标题像 DSH」里**面积最大**的那个
 *     —— Electron 会有多个窗口，随便挑一个可能就是不可见的辅助窗，点了"没反应"。
 *  2. **绕过 Windows 前台锁**：`SetForegroundWindow` 在调用方不是前台进程时会**返回 true
 *     但只让任务栏闪一下**（实测就是这个症状）。所以先 `AllowSetForegroundWindow(-1)`，
 *     再 `AttachThreadInput` 把自己的输入线程挂到当前前台线程上，然后才 SetForegroundWindow。
 *  3. **结果写进 `.state/focus-log.txt`** —— agent 读不到桌宠的控制台，
 *     写文件才能让我事后自己定位（这行日志就是为此存在）。
 *
 * @returns {Promise<{ok: boolean, detail: string}>} 供渲染端决定是否收掉通知
 */
function focusDshWindow() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$names=@('DeepSeek Harness','DeepSeekHarness','deepseek-harness','dsh')",
    'Add-Type @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class WinActivate {',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
    '  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '}',
    '"@',
    "$pids=@(Get-Process | Where-Object { $names -contains $_.ProcessName } | Select-Object -ExpandProperty Id)",
    '$global:best=[IntPtr]::Zero; $global:bestArea=0; $global:bestTitle=""; $global:visible=0; $global:titled=0',
    '$cb=[WinActivate+EnumProc]{ param($h,$l)',
    '  if(-not [WinActivate]::IsWindowVisible($h)){ return $true }',
    '  $global:visible=$global:visible+1',
    '  $p=0; [void][WinActivate]::GetWindowThreadProcessId($h,[ref]$p)',
    '  $sb=[System.Text.StringBuilder]::new(512); [void][WinActivate]::GetWindowTextW($h,$sb,512); $t=$sb.ToString()',
    '  if($t.Length -gt 0){ $global:titled=$global:titled+1 }',
    "  if(($pids -contains $p) -or ($t -match 'Harness|DSH|DeepSeek')){",
    '    $r=[WinActivate+RECT]::new(); [void][WinActivate]::GetWindowRect($h,[ref]$r)',
    '    $area=[math]::Abs(($r.R-$r.L)*($r.B-$r.T))',
    '    if($area -gt $global:bestArea){ $global:bestArea=$area; $global:best=$h; $global:bestTitle=$t }',
    '  }',
    '  return $true }',
    '[void][WinActivate]::EnumWindows($cb,[IntPtr]::Zero)',
    "if($global:best -eq [IntPtr]::Zero){ Write-Output ('ok=False detail=no-window pids=' + $pids.Count + ' visible=' + $global:visible + ' titled=' + $global:titled); exit }",
    '$h=$global:best',
    '[void][WinActivate]::AllowSetForegroundWindow(-1)',
    '[void][WinActivate]::ShowWindow($h,9)',
    '[void][WinActivate]::BringWindowToTop($h)',
    '$fg=[WinActivate]::GetForegroundWindow()',
    '$fgT=0; [void][WinActivate]::GetWindowThreadProcessId($fg,[ref]$fgT)',
    '$cur=[WinActivate]::GetCurrentThreadId()',
    '$att=[WinActivate]::AttachThreadInput($cur,$fgT,$true)',
    '$ok=[WinActivate]::SetForegroundWindow($h)',
    '[void][WinActivate]::AttachThreadInput($cur,$fgT,$false)',
    '$now=[WinActivate]::GetForegroundWindow()',
    "Write-Output ('ok=' + $ok + ' hwnd=' + $h + ' area=' + $global:bestArea + ' attach=' + $att + ' isForeground=' + ($now -eq $h) + ' title=' + $global:bestTitle)",
  ].join('\n')
  // UTF-16LE + base64 —— PowerShell 的 -EncodedCommand 约定
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '').trim()
        const ok = /ok=True/.test(out)
        const detail = out !== '' ? out : String(error?.message ?? stderr ?? 'no-output').trim()
        log(`[focus-dsh] ${ok ? '已唤到前台' : '失败'}：${detail}`)
        appendFocusLog(`${ok ? 'OK  ' : 'FAIL'} ${detail}`)
        resolve({ ok, detail })
      },
    )
  })
}

function loadWindowState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return {}
  }
}

let saveTimer
function saveWindowState(win) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (win.isDestroyed()) return
    const [x, y] = win.getPosition()
    try {
      writeFileSync(statePath, JSON.stringify({ x, y, width: WIDTH, height: HEIGHT }, null, 2))
    } catch (error) {
      log('window state save failed:', error.message)
    }
  }, 300)
}

// ── SSE 订阅（放在主进程：没有 CORS/origin 问题，重连也好管）──────────
// ⚠️ 具体实现在 `sse-link.js`（纯 Node，可被自测用真 HTTP 服务端验行为）。
//    这里**不要再自己写 res.on('end') 那套**：非正常断开时 Node 不发 `end`、
//    也不发 `req.error`（实测事件序列 res.aborted → req.close → res.error → res.close），
//    只监听 end/error 会让桌宠"假活"—— 小绿点常绿 + 永不重连 + 状态冻结。
let sseLink = null

// 实测踩过：createWindow() 之后立刻连 SSE，'pet:link' 会在渲染端注册好 handler
// **之前**发出去，被直接丢掉 —— 于是日志说"SSE 已连接"，右下角状态点却一直是红的。
// 所以主进程记住最近一次的连接状态与快照帧，等渲染端发来 'pet:ready' 时补发。
let lastLink = { connected: false }
let lastSnapshot

/** 页面还在加载时发送会丢，统一走这里判断 */
function send(win, channel, payload) {
  if (win.isDestroyed()) return
  if (win.webContents.isLoading()) return
  win.webContents.send(channel, payload)
}

function pushLink(win, link) {
  lastLink = link
  send(win, 'pet:link', link)
  // 插件在线的小点现在显示在**操作面板**里（用户 2026-10-05 要求），同步推给它。
  // 面板没开 / 还没加载完就跳过 —— 首次打开时会由 `menu:data.link` 带上最新值 ✓
  pushMenuLink(link)
}

/** 把 SSE 连接状态推给菜单小窗（它自己管显示，主进程只负责转发） */
function pushMenuLink(link) {
  if (menuWin === null || menuWin.isDestroyed()) return
  if (menuWin.webContents.isLoading()) return
  menuWin.webContents.send('menu:link', link)
}

/**
 * 帧的"副作用"钩子（当前 = 审批小窗），由 createWindow() 在定义好处理函数后挂上。
 *
 * ⚠️ 为什么用这个间接层、而不是直接在 startSse 里调 handleApprovalFrame：
 *    startSse 是**模块级**函数，而 handleApprovalFrame 定义在 createWindow 内部
 *    （它要用 win / alphaMask / contentBand）。直接调 → ReferenceError。
 *    实测踩到：报错被外层 catch 吞掉，**连后面那句 send(win,'pet:frame') 都执行不到**
 *    → 桌宠收不到任何帧（状态/通知全冻住），而人眼只看到"审批框没弹"。
 */
let frameEffects = null

/**
 * 调试：PET_FORCE_STATE=<state> 期间，**所有**出站状态帧都改写成它。
 *
 * 为什么需要改写而不是只推一次：真实状态帧随后就到、会把强制状态覆盖掉。
 * 实测踩到：强制 idle 之后 agent 一动就变回 running，
 * 于是"长时间待机"这类场景**永远复现不出来**。FORCE 就该是 FORCE。
 */
const FORCED_STATE = process.env.PET_FORCE_STATE ?? null

/**
 * 建立 SSE 订阅。**断线检测与重连全在 `sse-link.js` 里**：
 *   · 非正常断开（宿主重启/进程消失/连接重置）→ 立刻判定掉线并重连
 *   · 心跳静默超阈值（半开连接）→ 看门狗兜底
 * 这里只负责"把帧翻译成窗口动作"。
 */
function startSse(win) {
  const url = new URL(`${ROUTE_PREFIX}/events`, DSH_URL)
  sseLink?.close()
  sseLink = createSseLink({
    url,
    log,
    onLink: (link) => pushLink(win, link),
    onFrame: (frame) => {
      if (frame.type === 'snapshot') lastSnapshot = frame
      // ⚠️ 副作用**单独 try**：它出错绝不能把下面那句 send 带走。
      //    踩过：处理函数作用域不对 → ReferenceError → 外层 catch 吞掉整块
      //    → 每一条帧都被丢弃，桌宠整个冻住（状态/通知/审批全都没了）。
      try {
        frameEffects?.(frame)
      } catch (error) {
        log('frame effect failed:', error?.message ?? error)
      }
      // 调试：强制状态期间改写所有状态帧（否则真实状态会把它覆盖掉）
      if (FORCED_STATE !== null && (frame.type === 'state' || frame.type === 'snapshot')) {
        frame.state = FORCED_STATE
      }
      // 这一句必须**无条件**执行 —— 它是桌宠活着的前提
      send(win, 'pet:frame', frame)
    },
  })
}

/** 启动自检：直接问插件的 /health，一眼看出插件到底装没装 */
function probeHealth() {
  const url = new URL(`${ROUTE_PREFIX}/health`, DSH_URL)
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) })
        } catch {
          resolve({ status: res.statusCode, body })
        }
      })
    })
    req.on('error', (error) => resolve({ status: 0, error: error.message }))
    req.setTimeout(4000, () => {
      req.destroy()
      resolve({ status: 0, error: 'timeout' })
    })
  })
}

// ── 反向操控：把渲染端的意图转成对插件的 POST ──────────────────────
function postControl(action, payload) {
  const url = new URL(`${ROUTE_PREFIX}/${action}`, DSH_URL)
  const body = JSON.stringify(payload ?? {})
  return new Promise((resolve) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = { raw: text }
          }
          resolve({ status: res.statusCode, body: parsed })
        })
      },
    )
    req.on('error', (error) => resolve({ status: 0, error: error.message }))
    req.end(body)
  })
}

/**
 * GET 一个 JSON 端点（插件的 /state 等）。
 * 打开操作面板时要现拉一次会话列表 —— 渲染端的状态帧只带"当前会话"的用量，没有完整列表。
 * 失败不抛：面板照常弹出，只是列表空着（`status: 0` / 非 200 都走这里）。
 */
function getJson(path) {
  return new Promise((resolve) => {
    const req = http.request(new URL(path, DSH_URL), { method: 'GET' }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = { raw: text }
        }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', (error) => resolve({ status: 0, error: error.message }))
    req.end()
  })
}

// ── 点击穿透的命中测试（主进程轮询光标）────────────────────────────
//
// ⚠️ 为什么不用 `setIgnoreMouseEvents(true, { forward: true })` + 渲染端 mousemove：
//    那是 Electron 在 Windows 上的**已知 bug**，而且正好是我们这个版本：
//      · electron/electron#30808（2021-09 起，至今 open）
//        「Mouse event forwarding is buggy」—— 事件要么闪烁要么完全不转发
//      · electron/electron#49982 —— 「mouseenter/mouseleave 振荡 + click-through 卡住」
//      · PR #53026（target 44-x-y，即本机版本）追加的 UIPI 说明：
//        **"Mouse forwarding will stop working temporarily if a window with
//          higher privileges (integrity level) is the foreground window"**
//      · PR #52633「refactor: mouse forwarding on Windows」声明 Fixes #30808，
//        但**至今仍是 open**，没进任何发行版。
//    症状就是用户报的："只要桌面上有其它窗口就拖不动桌宠" ——
//    别的窗口一进前台，转发就停 → 渲染端收不到 mousemove → 永远不会切到可交互 →
//    窗口一直点击穿透 → 拖不动。
//
//    所以改成**主进程自己轮询光标位置**：screen.getCursorScreenPoint() 不依赖任何
//    窗口消息转发，然后用渲染端送来的 alpha 掩码判断光标是否落在角色上。
//    这样一来 forward 那套 buggy 路径完全不参与。
const HIT_TEST_MS = 16 // ≈60Hz，足够跟手
const HIT_ALPHA_THRESHOLD = 24
/** 渲染端送来的 alpha 掩码（已降采样，够用又省 IPC） */
let alphaMask = null
/**
 * 渲染端送来的 HTML 控件矩形（输入条 / 气泡，CSS px 相对视口）。
 *
 * ⚠️ 没有它就会出这个 bug：命中测试只看 Live2D 的 alpha 掩码，
 * 而输入条、气泡是 HTML —— 掩码里根本没有它们。于是"控件在、但角色轮廓没盖住"的位置
 * 被判成透明 → 穿透 → 按钮点不动（实测：输入条右侧的「打断」点不到，
 * 而压在角色上的「派活」能点，很迷惑人）。
 */
let uiRects = []
/** 拖拽中必须一直保持可交互：否则鼠标快速移出角色时窗口会"甩掉"拖拽 */
let draggingNow = false
/**
 * 拖拽态的最后一次续期时间 + 看门狗阈值。
 *
 * ⚠️ 为什么需要看门狗：`draggingNow` 唯一的清零处是渲染端的 `mouseup`。
 *    如果松手发生在窗口之外、或渲染端崩了/卡了，`setDragging(false)` 永远不来
 *    → 窗口**永久**停在"一直可交互"，把落在 260×300 里的所有点击都吞掉
 *    （连给桌面其他窗口的点击也一起吃掉）。
 *
 * ⚠️ 阈值为什么从 6s 放到 15s：续期原本只靠渲染端的 `setInterval(2s)`，
 *    6s 只有 3 倍余量；定时器一旦被拖慢（节流/渲染端卡顿/GC 停顿）就会在
 *    **拖拽进行中**误判成"卡住"并把拖拽掐死 —— 用户报的
 *    "一开始能拖，后面突然拖不动了"正是这个症状。
 *    现在多了一条更可靠的续期：拖拽中的每一次 `pet:move-by` 都续期
 *    （鼠标在动就说明人还在拖，不依赖任何定时器）✓
 */
let draggingLastAt = 0
const DRAG_STALE_MS = 15000
/**
 * 失焦后多久没续期，才认为拖拽真的结束了。
 * 比渲染端的续期间隔（2s）略大：**活跃拖拽期间失焦是常事**
 * （移动窗口、`setIgnoreMouseEvents` 来回切换都可能触发 blur），
 * 无条件复位会把正在进行的拖拽中途掐死。
 */
const DRAG_BLUR_GRACE_MS = 2500
let lastIgnore = null
let ignoreLogs = 0
/** 掩码覆盖率（-1 = 还没收到）；用来判断掩码是不是残缺/空的 */
let maskCoverage = -1
/**
 * 渲染端自己的坐标系尺寸（window.innerWidth/innerHeight），随掩码一起送来。
 *
 * ⚠️ 命中判定必须用它，**不能**用 `win.getBounds()` —— 两者是不同坐标系：
 *    实测某台 150% 缩放的机器上窗口被系统撑到 1077×946 / 1248×1124，
 *    而渲染端舞台一直是 260×300、掩码 130×150；用 getBounds() 映射
 *    等于把掩码拉伸铺满整个大窗口 → 用户报的
 *    "**远离昔涟的位置反而能拖动**、在她身上拖不动"。
 */
let maskStage = { w: 0, h: 0 }
/** 上一次报告"窗口尺寸 ≠ 渲染端舞台"的尺寸，避免刷屏 */
let lastStageMismatch = ''
/**
 * 掩码几乎全透明 → **弃用它**，整窗可交互。
 * 为什么需要这条：掩码是"哪里算她的身体"的唯一依据，一旦渲染端读出来的 alpha
 * 和屏幕画面不一致（软件渲染回读残缺 / DPR 变化 / 模型降级成占位图），
 * 结果就是"只有一部分能拖、最后完全拖不动" —— 比挡住一点桌面严重得多。
 */
let maskUnusable = false

/** 续期：拖拽还在继续（渲染端定时器 / 每一次实际移动都调它） */
function renewDrag() {
  draggingLastAt = Date.now()
}

/**
 * 结束拖拽态，并**通知渲染端**。
 * 不通知的后果是两边状态分叉：主进程已复位（窗口恢复穿透判定），
 * 渲染端还以为在拖 —— 于是她要么在松开鼠标后继续跟着鼠标跑，
 * 要么反过来怎么拖都不动。实测症状就出在这里。
 *
 * @returns {boolean} 是否真的做了复位
 */
function cancelDrag(win, reason) {
  if (!draggingNow) return false
  draggingNow = false
  if (win && !win.isDestroyed()) win.webContents.send('pet:drag-cancel', reason)
  return true
}

function applyIgnore(win, ignore) {
  if (ignore === lastIgnore) return
  const first = lastIgnore === null
  lastIgnore = ignore
  win.setIgnoreMouseEvents(ignore)
  // 前几次切换打出来，便于确认命中测试真的在动（之后静默，避免刷屏）
  if (first || ignoreLogs < 6) {
    ignoreLogs++
    log(`点击穿透 → ${ignore ? '开（鼠标穿过去）' : '关（窗口接管鼠标）'}`)
  }
}

function startHitTestLoop(win) {
  const debug = process.env.PET_HIT_DEBUG === '1'
  let lastDebugAt = 0
  const timer = setInterval(() => {
    if (win.isDestroyed()) return
    if (draggingExpired({ draggingNow, lastAt: draggingLastAt, now: Date.now(), staleMs: DRAG_STALE_MS })) {
      const silent = Math.round((Date.now() - draggingLastAt) / 1000)
      log(`⚠️ 拖拽态卡住 ${silent}s 没有续期（松手丢了 / 渲染端卡了）→ 强制复位，否则窗口会一直吞掉点击`)
      cancelDrag(win, 'stale')
    }
    if (draggingNow || maskUnusable) {
      applyIgnore(win, false)
      return
    }
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    // ⚠️ 映射基准是**渲染端的坐标系**（maskStage），不是窗口的（b）。
    //    两者不一致时以渲染端为准 —— 掩码本来就是照着它的坐标系生成的。
    const stageW = maskStage.w > 0 ? maskStage.w : b.width
    const stageH = maskStage.h > 0 ? maskStage.h : b.height
    // 差得明显就记一行：这本身就是"窗口被系统撑大了"的证据（实测 1248×1124 vs 260×300）
    if (maskStage.w > 0 && (Math.abs(b.width - stageW) > 2 || Math.abs(b.height - stageH) > 2)) {
      const stamp = `${b.width}×${b.height}/${stageW}×${stageH}`
      if (stamp !== lastStageMismatch) {
        lastStageMismatch = stamp
        log(`⚠️ 窗口尺寸 ${b.width}×${b.height} ≠ 渲染端舞台 ${stageW}×${stageH} → 命中判定按渲染端舞台算（否则掩码会被拉伸铺满窗口）`)
      }
    }
    const x = p.x - b.x
    const y = p.y - b.y
    // 判定统一走 hit-test.js 的纯函数（可自测）：
    // ① UI 控件（输入条/气泡）—— HTML，不在 alpha 掩码里；漏了它「打断」会被穿透
    // ② alpha 掩码 —— Live2D 实际渲染出来的不透明区域
    const hit = hitTest({
      mask: alphaMask,
      uiRects,
      winWidth: stageW,
      winHeight: stageH,
      x,
      y,
      threshold: HIT_ALPHA_THRESHOLD,
    })
    // PET_HIT_DEBUG=1 时每秒打一行，肉眼可核对坐标换算对不对
    if (debug && Date.now() - lastDebugAt > 1000) {
      lastDebugAt = Date.now()
      log(
        `[命中] 光标(${p.x},${p.y}) 窗口(${b.x},${b.y} ${b.width}×${b.height}) ` +
          `局部(${x},${y}) 掩码(${hit.u},${hit.v}) alpha=${hit.sampled} ui=${hit.hitUi ? '中' : '-'} ` +
          `→ ${hit.interactive ? '可交互' : '穿透'}`,
      )
    }
    applyIgnore(win, !hit.interactive)
  }, HIT_TEST_MS)
  timer.unref?.()
  return timer
}

// ── 自检截图（只截我们自己的透明窗，不碰用户桌面）──────────────────
// 用法：PET_SNAPSHOT=<png路径> [PET_SNAPSHOT_EXIT=1] [PET_SNAPSHOT_DELAY_MS=2500]
//       PET_SNAPSHOT_AT_MOTION_MS=<ms>  ← 从**动作开始**算起的精确时刻截图
// 有它的意义：agent 看不到屏幕，但可以拿这张图确认"窗口确实渲染出了宠物"，
// 并且能直接检查透明通道是否正确（透明区域必须是 alpha=0）。
//
// 为什么需要 AT_MOTION_MS：PET_SNAPSHOT_DELAY_MS 是从 ready-to-show 起算，
// 而动作要等模型加载完才开始（实测差 1~3 秒且不稳定），踩不准动作里的高光时刻。
// 所以那种情况由渲染端在动作跑到指定时刻时主动请求截图。
async function captureSnapshot(win) {
  const target = process.env.PET_SNAPSHOT
  if (!target || win.isDestroyed()) return
  try {
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, png)
    log(`自检截图已写出：${target}（${png.length} 字节，${image.getSize().width}x${image.getSize().height}）`)
    win.webContents.send('pet:snapshot-done', target)
  } catch (error) {
    log('自检截图失败：', error.message)
  }
  if (process.env.PET_SNAPSHOT_EXIT === '1') {
    setTimeout(() => app.quit(), 300)
  }
}

function maybeSnapshot(win) {
  if (!process.env.PET_SNAPSHOT) return
  // 精确时刻模式：等渲染端发 'pet:snapshot-now'
  if (process.env.PET_SNAPSHOT_AT_MOTION_MS) {
    log(`等待渲染端在动作 ${process.env.PET_SNAPSHOT_AT_MOTION_MS}ms 处触发截图`)
    return
  }
  const delay = Number(process.env.PET_SNAPSHOT_DELAY_MS ?? 2500)
  setTimeout(() => captureSnapshot(win), delay)
}

// ── 窗口 ────────────────────────────────────────────────────────────
/** 右键菜单小窗的固定尺寸（窗口 resizable:false，菜单内容按 100% 铺满）。
 *  比第一版大：现在它是**操作面板** —— 会话列表 + 多行输入 + 按钮 + 用量。 */
const MENU_WIDTH = 300
const MENU_HEIGHT = 320
/** 审批小窗尺寸：要放下工具名 + 多行命令 + 理由（两行）+ 两个按钮 + 提示行 */
const APPROVAL_WIDTH = 340
const APPROVAL_HEIGHT = 218
/** 审批小窗（第三个窗口）：审批来了自动弹，点完就关 */
let approvalWin = null
let lastApprovalFrame = null
/** 会话列表最多列几个（用户要求"最近 3~5 个"） */
const MENU_SESSION_LIMIT = 5
/** 菜单小窗：复用一个实例（hide 而不是 close，避免每次重载闪一下） */
let menuWin = null
/** 最近一次要显示的数据 —— menu:ready 补发用（首次打开时页面还没加载完） */
let lastMenuData = { tokens: null, sessions: [] }
/** 派活目标：用户在菜单里选的那个会话。null = 跟着插件算的主会话 */
let selectedSessionId = null
/** 输入框里有没有没发出去的内容 —— 有的话失焦不收起窗口，免得字丢了 */
let menuDirty = false

function createWindow() {
  const saved = loadWindowState()
  const win = new BrowserWindow({
    width: saved.width ?? WIDTH,
    height: saved.height ?? HEIGHT,
    x: saved.x,
    y: saved.y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility?.(false)

  // 渲染进程诊断：没有这些，"页面到底是没加载、preload 挂了还是 JS 抛错"只能靠猜。
  win.webContents.on('console-message', (event, ...rest) => {
    if (rest.length === 1 && rest[0] !== null && typeof rest[0] === 'object' && 'message' in rest[0]) {
      const d = rest[0]
      log(`[renderer:${d.level}] ${d.message} (${d.sourceId ?? ''}:${d.lineNumber ?? ''})`)
    } else {
      const [level, message, line, sourceId] = rest
      log(`[renderer:${level}] ${message} (${sourceId ?? ''}:${line ?? ''})`)
    }
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log(`[preload-error] ${preloadPath}: ${error?.message ?? error}`)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`[did-fail-load] ${code} ${description} ${url}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`[render-process-gone] ${JSON.stringify(details)}`)
  })

  // 默认点击穿透。命中测试由主进程轮询光标完成（见 startHitTestLoop 上方注释），
  // 刻意**不用** forward:true —— 那是已知 bug 路径。
  win.setIgnoreMouseEvents(true)

  win.once('ready-to-show', () => {
    // ⚠️ 刻意**不立刻显示**：
    //   渲染端要先把内容构图测量出来（约 3 秒，取多帧包围盒并集）。
    //   如果先显示，用户会看到桌宠出现 3 秒后**突然放大一次**
    //   （实测就是这个现象：按画布保底 scale=0.0619 → 测完变 0.0694，+12%）。
    //   所以等渲染端算好构图（'pet:fit-ready'）再显示；同时留兜底，避免异常时窗口永不出现。
    //   快照模式不延迟 —— 那是我自己跑验证用的，保持原有行为。
    log(`窗口已就绪 ${win.getSize().join('x')}（${deferShow ? '等构图测量完成后再显示' : '立即显示'}）`)
    if (deferShow) {
      showFallbackTimer = setTimeout(() => {
        log('构图就绪信号超时（15s），直接显示窗口')
        showWindow(win)
      }, 15_000)
    } else {
      showWindow(win)
    }
    maybeSnapshot(win)
  })

  win.on('moved', () => saveWindowState(win))
  win.on('closed', () => saveWindowState(win))

  win.loadURL('pet://app/index.html')
  return win
}

app.whenReady().then(async () => {
  initLogFile() // 必须最先：之后所有 log 都会同时落盘到 .state/pet.log
  log(`DSH=${DSH_URL} prefix=${ROUTE_PREFIX} state=${statePath}`)
  log(`构建指纹 ${buildStamp()}（用来确认"到底重启到新代码没有"）`)

  // ── 环境指纹 ──────────────────────────────────────────────────────
  // 为什么必须记：同一份代码"这台机器正常、那台机器只有一部分能拖"，
  // 差异只可能在**渲染后端 / 显示缩放 / DPR** 上。这几行 + 掩码覆盖率
  // 合起来，一个 pet.log 就能定位，不用来回问对方"你屏幕缩放多少"。
  try {
    const displays = screen.getAllDisplays()
    log(
      `显示：${displays.length} 个 · ` +
        displays
          .map((d) => `${d.size.width}×${d.size.height}@${d.scaleFactor}x${d.internal ? '(内)' : ''}`)
          .join(' / '),
    )
  } catch (error) {
    log(`显示信息读取失败：${error.message}`)
  }
  log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`)
  log(`启动参数：${process.argv.slice(1).join(' ') || '(无)'}`)
  try {
    // webgl=disabled / software 就说明走了软件渲染 —— 那正好是"回读 alpha 不可靠"的高危场景
    const gpu = app.getGPUFeatureStatus?.()
    if (gpu && typeof gpu === 'object') {
      log(`GPU：${Object.entries(gpu).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    }
  } catch (error) {
    log(`GPU 状态读取失败：${error.message}`)
  }

  registerModelProtocol()
  const settings = findModelSettings()
  if (settings) {
    log(`Live2D 模型：${join(MODEL_DIR, settings)}`)
  } else {
    log(`Live2D 模型缺失（${MODEL_DIR} 下没有 *.model3.json）→ 渲染端会降级为占位形象`)
  }

  const health = await probeHealth()
  if (health.status === 200 && health.body?.ok) {
    log(`插件在线：pid=${health.body.pid} state=${health.body.state}`)
  } else {
    log(`插件不可达（status=${health.status}${health.error ? `, ${health.error}` : ''}）`)
    log('→ 先把 packages/pet-plugin 作为 bundle 装进 profile，或按 cordis.patch.yml 里的方式 2 直挂')
  }

  const win = createWindow()
  startSse(win)

  // 点击穿透的命中测试：主进程轮询光标 + 渲染端送来的 alpha 掩码
  startHitTestLoop(win)
  ipcMain.on('pet:mask', (_event, mask) => {
    // 只做基本校验，避免坏数据让轮询崩掉
    if (mask && mask.width > 0 && mask.height > 0 && mask.data?.length === mask.width * mask.height) {
      if (!alphaMask) log(`收到 alpha 掩码 ${mask.width}×${mask.height}，命中测试交给主进程轮询光标`)
      alphaMask = mask
      // ── 掩码覆盖率 ────────────────────────────────────────────────
      // 这是"只有一部分能拖 / 最后完全拖不动"的**直接判据**：
      // 覆盖率明显偏低 = 渲染端读出来的 alpha 和屏幕上的画面不一致
      // （软件渲染下 WebGL 回读残缺、DPR 变化导致映射错位、模型没加载成占位图…）。
      // 250ms 一次不能刷屏，所以只在变化超过 5 个百分点时打一行。
      let opaque = 0
      for (let i = 0; i < mask.data.length; i++) if (mask.data[i] >= HIT_ALPHA_THRESHOLD) opaque++
      const coverage = opaque / mask.data.length
      if (maskCoverage < 0 || Math.abs(coverage - maskCoverage) > 0.05) {
        maskCoverage = coverage
        // 顺带算出不透明格的**包围盒**：它必须落在"她身体应该在的位置"。
        // 只看覆盖率是不够的 —— 软件渲染（gpu_compositing=disabled_software）下
        // 画布回读可能整幅偏移或翻转，覆盖率照样健康（32.6%），但包围盒会立刻暴露。
        let minU = -1
        let minV = -1
        let maxU = -1
        let maxV = -1
        for (let y = 0; y < mask.height; y++) {
          for (let x = 0; x < mask.width; x++) {
            if (mask.data[y * mask.width + x] >= HIT_ALPHA_THRESHOLD) {
              if (minU < 0 || x < minU) minU = x
              if (maxU < 0 || x > maxU) maxU = x
              if (minV < 0 || y < minV) minV = y
              if (maxV < 0 || y > maxV) maxV = y
            }
          }
        }
        log(
          `掩码覆盖率 ${(coverage * 100).toFixed(1)}%（${mask.width}×${mask.height}，alpha 阈值 ${HIT_ALPHA_THRESHOLD}）` +
            `  不透明范围 u[${minU}..${maxU}] v[${minV}..${maxV}]`,
        )
      }
      // 兜底：几乎全透明比"边缘点不到"糟糕得多（**整只都拖不动**）
      // → 退化为整窗可交互。代价是她会挡住 260×300 范围内的桌面点击，
      //   但那比"完全没法交互"好，而且日志会明确记下这次降级。
      const unusable = coverage < 0.005
      if (unusable !== maskUnusable) {
        maskUnusable = unusable
        log(
          unusable
            ? '⚠️ 掩码几乎全透明 → 退化为**整窗可交互**（否则整只都点不到/拖不动）'
            : '掩码恢复正常 → 恢复按掩码判穿透',
        )
      }
      // UI 矩形与掩码同一批送来（渲染端每 250ms 刷一次），一起更新
      uiRects = (Array.isArray(mask.uiRects) ? mask.uiRects : []).filter(
        (r) => r && [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)),
      )
      // 渲染端坐标系尺寸（命中映射的**权威基准**）
      if (mask.stage && mask.stage.w > 0 && mask.stage.h > 0) maskStage = mask.stage
    }
  })
  ipcMain.on('pet:dragging', (_event, value) => {
    draggingNow = Boolean(value)
    // 续期时间戳：看门狗据此判断拖拽态是不是"卡住了"
    if (draggingNow) renewDrag()
  })
  // 失焦也可能是"Alt+Tab 走了、mouseup 收不到"，但**只在确实没人续期时**才复位：
  // 活跃拖拽期间失焦很常见，无条件复位会把正在进行的拖拽中途掐死。
  win.on('blur', () => {
    if (draggingNow && Date.now() - draggingLastAt > DRAG_BLUR_GRACE_MS) {
      log('窗口失焦且拖拽态已无续期 → 复位拖拽态')
      cancelDrag(win, 'blur')
    }
  })
  // 构图缓存：省掉每次启动的 3 秒测量，也避免"打开一会突然变大"
  ipcMain.handle('pet:fit-cache-get', (_event, modelKey) => {
    const all = loadFitCache()
    return all[modelKey] ?? null
  })
  ipcMain.handle('pet:fit-cache-set', (_event, modelKey, box) => {
    if (!modelKey || !box) return false
    const all = loadFitCache()
    all[modelKey] = box
    saveFitCache(all)
    log(`构图已缓存：${box.w?.toFixed(0)}×${box.h?.toFixed(0)}`)
    return true
  })
  // 渲染端说"构图算好了，可以显示了"
  ipcMain.on('pet:fit-ready', () => {
    if (!win.isDestroyed()) showWindow(win)
  })
  ipcMain.on('pet:move-by', (_event, dx, dy) => {
    if (win.isDestroyed()) return
    // ⚠️ 鼠标真的在动 —— 这是"人还在拖"最可靠的证据，不依赖任何定时器，必须续期。
    //    少这一条，拖拽就只能靠渲染端的 2s 定时器续命，定时器一被拖慢就会被看门狗掐死。
    if (draggingNow) renewDrag()
    closeMenuWindow() // 桌宠一动，菜单就不该留在原地
    const [x, y] = win.getPosition()
    win.setPosition(x + dx, y + dy)
  })
  ipcMain.handle('pet:control', (_event, action, payload) => postControl(action, payload))
  // A7：点击桌宠上的通知 → 把 DSH 窗口唤到前台
  ipcMain.handle('pet:focus-dsh', () => focusDshWindow())

  /**
   * 操作面板（独立小窗）：右键她 / 双击她都弹这个。
   *
   * 为什么是独立窗口：她本体占满 260×300，在里面放输入条必然压住她的裙摆和脚
   * （实测重叠 28px），更没地方放会话列表。
   */
  ipcMain.handle('pet:open-menu', (_event, payload) => openMenuWindow(payload))
  ipcMain.on('menu:close', () => closeMenuWindow())
  // 审批小窗：渲染端就绪 → 补发内容（loadFile 是异步的）；点了决定 → 回审批链
  ipcMain.on('approval:ready', (event) => {
    if (approvalWin !== null && !approvalWin.isDestroyed() && event.sender === approvalWin.webContents) {
      approvalWin.webContents.send('approval:data', lastApprovalFrame)
    }
  })
  ipcMain.on('approval:decide', async (event, payload) => {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const decision = payload?.decision === 'allow' ? 'allow' : payload?.decision === 'deny' ? 'deny' : null
    if (id === '' || decision === null) return
    const result = await postControl('approval', { id, decision })
    log(`审批决定 ${decision}（${id}）→ ${result.status}`)
    if (approvalWin !== null && !approvalWin.isDestroyed() && event.sender === approvalWin.webContents) {
      approvalWin.webContents.send('approval:result', { id, decision, status: result.status })
    }
    // 提交失败（多半是已经超时交棒给 GUI 了）→ 收起窗口，别让它杵在那儿误导人
    if (result.status !== 200) closeApprovalWindow()
  })
  // 渲染端就绪 → 补发数据（首次打开时 show() 那次 send 会因页面未加载而丢）
  ipcMain.on('menu:ready', (event) => {
    if (menuWin !== null && !menuWin.isDestroyed() && event.sender === menuWin.webContents) {
      menuWin.webContents.send('menu:data', lastMenuData)
    }
  })
  // 输入框有未发送内容 → 失焦不收起
  ipcMain.on('menu:dirty', (_event, value) => {
    menuDirty = Boolean(value)
  })
  // 切换**派活目标**（只决定"派给谁"，不动 DSH 界面 —— 宿主没有切会话的 API，
  // sessionController 里 focus/switch/activateSession 全是 0 命中，/focus 因此是 501）
  ipcMain.on('menu:select-session', (_event, sessionId) => {
    selectedSessionId = String(sessionId)
    log(`派活目标 → ${selectedSessionId}`)
  })
  // 派活 / 打断：动作在主进程执行（这里才有 postControl），结果同时回报给小窗和桌宠
  ipcMain.handle('menu:prompt', async (_event, payload) => {
    const target = selectedSessionId ?? lastMenuData?.primarySessionId ?? undefined
    const result = await postControl('prompt', { text: payload?.text, sessionId: target })
    reportMenuResult({ action: 'prompt', status: result.status, message: result.body?.message ?? result.error })
    return result
  })
  ipcMain.handle('menu:interrupt', async () => {
    const target = selectedSessionId ?? lastMenuData?.primarySessionId ?? undefined
    const result = await postControl('interrupt', { sessionId: target })
    reportMenuResult({ action: 'interrupt', status: result.status, message: result.body?.message ?? result.error })
    return result
  })

  /** 执行结果两处都要知道：小窗显示提示，桌宠冒个气泡 */
  function reportMenuResult(result) {
    if (menuWin !== null && !menuWin.isDestroyed()) menuWin.webContents.send('menu:result', result)
    if (win.isDestroyed()) return
    const what = result.action === 'prompt' ? '派活' : '打断'
    const text =
      result.status === 200
        ? result.action === 'prompt'
          ? '收到，正在派活…'
          : '已打断'
        : `${what}失败（${result.status}）${result.message === undefined ? '' : `：${result.message}`}`
    win.webContents.send('pet:bubble', text)
  }

  /**
   * 审批帧 → **专用小窗**（第三个窗口）。
   *
   * ⚠️ 为什么不画在桌宠窗口里：她头顶只有约 87px 留白，审批卡（工具名 + 命令 + 两个按钮）
   * 至少 100px 起 —— 必然遮住她本体（用户实测反馈"审批弹窗遮到角色了"）。
   *
   * ⚠️ 为什么不塞进操作面板：那要"先右键 → 再点允许"，手要动两次，
   * 正好把"通过桌宠审批就是为了方便"这个初衷抵消掉（用户指出）。
   * 审批是**突发**的，必须自己弹出来。
   *
   * 用 `showInactive()`：不抢你正在打字的窗口的焦点 —— 审批卡只需要"看得见、点得到"。
   */
  function handleApprovalFrame(frame) {
    if (frame?.type === 'approval') {
      log(`收到待审批：${frame.toolName ?? '?'}（弹出审批小窗）`)
      openApprovalWindow(frame)
      return
    }
    if (frame?.type === 'approval-resolved') {
      closeApprovalWindow()
    }
  }

  // 挂到模块级的帧副作用钩子上（startSse 在模块作用域，拿不到本函数的局部作用域）。
  // ⚠️ 必须在这里赋值：上面那个函数定义完才能引用。
  frameEffects = handleApprovalFrame

  /**
   * 弹出操作面板。
   * @param {{focusInput?:boolean, inactive?:boolean}} payload
   *        inactive=true 时用 showInactive()（不抢焦点）
   */
  async function openMenuWindow(payload) {
    // 打开时**现拉一次** /state：会话列表要按最近活跃排序、还要 token 用量。
    // 渲染端的状态帧只带"当前会话"的用量，没有完整列表（见 reducer 的 primaryTokens）。
    const state = await getJson(`${ROUTE_PREFIX}/state`)
    const body = state.body
    const sessions = (Array.isArray(body?.sessions) ? body.sessions : [])
      .slice()
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .slice(0, MENU_SESSION_LIMIT)

    // 之前选的目标没了（会话结束/DSH 重启）就退回主会话 ——
    // 否则会一直把活派给一个不存在的会话
    if (selectedSessionId !== null && !sessions.some((s) => s.sessionId === selectedSessionId)) {
      selectedSessionId = null
    }
    const primary = body?.primarySessionId ?? null
    if (selectedSessionId === null) selectedSessionId = primary

    const pet = win.getBounds()
    const center = { x: pet.x + Math.round(pet.width / 2), y: pet.y + Math.round(pet.height / 2) }
    const area = screen.getDisplayNearestPoint(center).workArea

    // 优先放右侧；右边放不下放左侧；两侧都放不下才退回"压在桌宠上面"（这种情况窗口几乎占满屏）
    let x = pet.x + pet.width + 6
    if (x + MENU_WIDTH > area.x + area.width) x = pet.x - MENU_WIDTH - 6
    if (x < area.x) x = pet.x + Math.round((pet.width - MENU_WIDTH) / 2)

    // 竖直：与**她的身体**居中，而不是窗口的几何中心。
    // 她头顶有约 87px 留白（实测构图），窗口中心比她身体中心高约 40px ——
    // 按窗口居中的话菜单会明显偏上；用户实测要求"与昔涟的身体对齐"。
    // 身体范围从 alpha 掩码算（contentBand），掩码还没到就退回窗口中心。
    const band = contentBand(alphaMask?.data, alphaMask?.width, alphaMask?.height, pet.height, HIT_ALPHA_THRESHOLD)
    const bodyCenterY = pet.y + (band === null ? pet.height / 2 : band.centerY)
    const y = Math.min(
      Math.max(area.y + 4, Math.round(bodyCenterY - MENU_HEIGHT / 2)),
      area.y + area.height - MENU_HEIGHT - 4,
    )

    const w = ensureMenuWindow()
    w.setBounds({ x: Math.round(x), y, width: MENU_WIDTH, height: MENU_HEIGHT })
    // 先发数据再 show，避免"先闪一个空面板再填上数字/列表"。
    // 但**首次**打开时页面可能还没加载完 → 那次会丢，靠 menu:ready 补发（见 menu-preload.cjs）。
    lastMenuData = {
      sessions,
      primarySessionId: primary,
      selectedSessionId,
      tokens: body?.tokens ?? payload?.tokens ?? null,
      focusInput: payload?.focusInput === true,
      // 插件在线小点要在**首次打开**时就显示正确状态，不能等下一次连接变化
      // （那时候可能早就连上了，`pushMenuLink` 不会再推）
      link: lastLink,
    }
    w.webContents.send('menu:data', lastMenuData)
    w.show()
    w.focus() // 要焦点才能打字、靠 blur 自动收起（Esc 也才好用）
    log(
      `操作面板：桌宠(${pet.x},${pet.y} ${pet.width}×${pet.height}) → 面板(${Math.round(x)},${y})；` +
        `会话 ${sessions.length} 个，目标 ${selectedSessionId ?? '（无）'}；` +
        `身体竖直范围 ${band === null ? '未知（退回窗口中心）' : `${Math.round(band.top)}..${Math.round(band.bottom)}，中心 ${Math.round(band.centerY)}`}`,
    )
    if (process.env.PET_SNAPSHOT_MENU) captureWindowSnapshot(w, process.env.PET_SNAPSHOT_MENU)
    return { ok: true, bounds: w.getBounds() }
  }

  function closeMenuWindow() {
    if (menuWin !== null && !menuWin.isDestroyed() && menuWin.isVisible()) menuWin.hide()
  }

  // ── 审批小窗（第三个窗口）─────────────────────────────────────────

  /**
   * 弹出审批小窗：**在她旁边**，用 showInactive() 不抢焦点。
   * 位置算法和操作面板一致（右优先 + 与她的身体竖直居中），只是尺寸不同。
   */
  function openApprovalWindow(frame) {
    const pet = win.getBounds()
    const center = { x: pet.x + Math.round(pet.width / 2), y: pet.y + Math.round(pet.height / 2) }
    const area = screen.getDisplayNearestPoint(center).workArea

    let x = pet.x + pet.width + 6
    if (x + APPROVAL_WIDTH > area.x + area.width) x = pet.x - APPROVAL_WIDTH - 6
    if (x < area.x) x = pet.x + Math.round((pet.width - APPROVAL_WIDTH) / 2)

    const band = contentBand(alphaMask?.data, alphaMask?.width, alphaMask?.height, pet.height, HIT_ALPHA_THRESHOLD)
    const bodyCenterY = pet.y + (band === null ? pet.height / 2 : band.centerY)
    const y = Math.min(
      Math.max(area.y + 4, Math.round(bodyCenterY - APPROVAL_HEIGHT / 2)),
      area.y + area.height - APPROVAL_HEIGHT - 4,
    )

    const w = ensureApprovalWindow()
    w.setBounds({ x: Math.round(x), y, width: APPROVAL_WIDTH, height: APPROVAL_HEIGHT })
    lastApprovalFrame = frame
    w.webContents.send('approval:data', frame)
    // showInactive：审批只需要"看得见、点得到"，不该把你正在打字的窗口的焦点抢走
    w.showInactive()
    log(`审批小窗：桌宠(${pet.x},${pet.y}) → 审批(${Math.round(x)},${y})；${frame?.toolName ?? '?'}`)
    return w
  }

  function closeApprovalWindow() {
    if (approvalWin !== null && !approvalWin.isDestroyed() && approvalWin.isVisible()) approvalWin.hide()
  }

  function ensureApprovalWindow() {
    if (approvalWin !== null && !approvalWin.isDestroyed()) return approvalWin
    approvalWin = new BrowserWindow({
      width: APPROVAL_WIDTH,
      height: APPROVAL_HEIGHT,
      transparent: true,
      frame: false,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      webPreferences: {
        preload: join(here, 'approval-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    approvalWin.setAlwaysOnTop(true, 'screen-saver')
    approvalWin.setMenuBarVisibility?.(false)
    approvalWin.loadFile(join(here, 'renderer', 'approval.html'))
    approvalWin.on('closed', () => {
      approvalWin = null
    })
    // ⚠️ 刻意**不做**"失焦即收起"：审批是突发的重要决定，
    //    窗口一动就消失会让你根本来不及点（它只该在"已处理/超时交棒"时消失）。
    approvalWin.webContents.on('console-message', (_event, ...rest) => {
      if (rest.length === 1 && rest[0] !== null && typeof rest[0] === 'object' && 'message' in rest[0]) {
        log(`[approval:${rest[0].level}] ${rest[0].message}`)
      } else {
        const [level, message] = rest
        log(`[approval:${level}] ${message}`)
      }
    })
    approvalWin.webContents.on('preload-error', (_event, path, error) => {
      log(`[approval-preload-error] ${path}: ${error?.message ?? error}`)
    })
    return approvalWin
  }

  function ensureMenuWindow() {
    if (menuWin !== null && !menuWin.isDestroyed()) return menuWin
    menuWin = new BrowserWindow({
      width: MENU_WIDTH,
      height: MENU_HEIGHT,
      transparent: true,
      frame: false,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      webPreferences: {
        preload: join(here, 'menu-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    menuWin.setAlwaysOnTop(true, 'screen-saver')
    menuWin.setMenuBarVisibility?.(false)
    menuWin.loadFile(join(here, 'renderer', 'menu.html'))
    // 失焦即收起 —— 原生菜单也是这个行为。
    // ⚠️ 但输入框**非空时不收**：字打了一半、鼠标点到别处就关掉，内容全没了（用户明确要求留着）。
    menuWin.on('blur', () => {
      if (!menuDirty) closeMenuWindow()
    })
    menuWin.on('closed', () => {
      menuWin = null
    })
    menuWin.webContents.on('console-message', (_event, ...rest) => {
      if (rest.length === 1 && rest[0] !== null && typeof rest[0] === 'object' && 'message' in rest[0]) {
        log(`[menu:${rest[0].level}] ${rest[0].message}`)
      } else {
        const [level, message] = rest
        log(`[menu:${level}] ${message}`)
      }
    })
    menuWin.webContents.on('preload-error', (_event, path, error) => {
      log(`[menu-preload-error] ${path}: ${error?.message ?? error}`)
    })
    return menuWin
  }

  /**
   * 调试：把**副窗口**（菜单/审批）拍下来核对布局。
   *
   * ⚠️ 必须重试：透明窗在屏幕外时 compositor 未必已经产出帧，
   * `capturePage()` 会抛 `UnknownVizError` / `Current display surface not available`（实测踩到）。
   */
  function captureWindowSnapshot(target, file) {
    if (typeof file !== 'string' || file === '') return
    let tries = 0
    const attempt = async () => {
      tries += 1
      try {
        const image = await target.webContents.capturePage()
        writeFileSync(file, image.toPNG())
        log(`副窗截图已写出：${file}`)
      } catch (error) {
        if (tries < 6) {
          setTimeout(attempt, 500)
          return
        }
        log(`副窗截图失败（试了 ${tries} 次）：${error?.message ?? error}`)
      }
    }
    setTimeout(attempt, Number(process.env.PET_SNAPSHOT_MENU_DELAY_MS ?? 1200))
  }

  // 调试：PET_FORCE_APPROVAL=1 → 启动后弹一张**假的**审批小窗（核对布局用，不碰审批链）
  if (process.env.PET_FORCE_APPROVAL === '1') {
    setTimeout(() => {
      log('调试模式：弹出假的审批小窗')
      const w = openApprovalWindow({
        id: 'debug-approval',
        toolName: 'pwsh',
        command: 'npm install --save-dev electron-builder\nnode tools/check-plugin.mjs --verbose',
        reason: 'escalate sandbox to danger-full-access: 需要写工作区外的目录',
        timeoutMs: 60000,
      })
      if (process.env.PET_SNAPSHOT_APPROVAL) captureWindowSnapshot(w, process.env.PET_SNAPSHOT_APPROVAL)
    }, 2500)
  }

  ipcMain.handle('pet:model-info', () => {
    const file = findModelSettings()
    return {
      dir: MODEL_DIR,
      exists: file !== null,
      // 与页面同源（都是 pet://app），所以渲染端 XHR 不会被 CORS 拦
      url: file === null ? null : `pet://app/model/${encodeURIComponent(file)}`,
      // 调试用（agent 看不到屏幕，只能靠日志与截图）：
      //   PET_FORCE_MOTION=Scene:1  指定播放哪个动作
      //   PET_SAMPLE_PARAMS=1       采样动作驱动的参数（用来"看懂"动作内容）
      //   PET_SAMPLE_MS=4000        采样时长
      forceMotion: process.env.PET_FORCE_MOTION ?? null,
      sampleMs: process.env.PET_SAMPLE_PARAMS === '1' ? Number(process.env.PET_SAMPLE_MS ?? 5000) : 0,
      // 逐帧打印手部过渡的数值（排查"弹两下"要的是单调性，肉眼盯动画数不清）
      handDebug: process.env.PET_HAND_DEBUG === '1',
      // 启动后自动弹她一下（核对"被弹"的振荡，不必真的去点秋千）
      forceFlick: process.env.PET_FORCE_FLICK === '1',
      // 把左键分区的部件框画出来（核对部件级命中测试的坐标变换 —— 这是它唯一的风险点）
      zoneDebug: process.env.PET_ZONE_DEBUG === '1',
      // 从动作开始算起的截图时刻（0 = 不用这条路径）
      snapshotAtMs: Number(process.env.PET_SNAPSHOT_AT_MOTION_MS ?? 0),
      // 调试用：启动后自动展开右键菜单（配合 PET_SNAPSHOT 就能拍到菜单长什么样，
      // 不必让用户真的去点一下）
      forceMenu: process.env.PET_FORCE_MENU === '1',
      // 调试用：启动后显示一张**假的**审批卡（只为核对布局，不连审批链）
      // 注意：审批现在是**独立小窗**（openApprovalWindow），所以由主进程直接弹
      forceApproval: process.env.PET_FORCE_APPROVAL === '1',    }
  })
  // 渲染端在动作跑到指定时刻时主动请求截图（见 maybeSnapshot 上方注释）
  ipcMain.on('pet:snapshot-now', () => captureSnapshot(win))
  ipcMain.on('pet:log', (_event, message) => log('[renderer]', message))
  // 渲染端注册好 handler 之后握手一次，补发最近的连接状态与快照帧
  ipcMain.on('pet:ready', () => {
    if (win.isDestroyed()) return
    win.webContents.send('pet:link', lastLink)

    // 调试用 PET_FORCE_STATE=<state>：**不发真实快照**，只推这个状态。
    // 否则插件报的真实状态会先到、把"启动后第一次状态"这个标记消费掉，
    // 于是强制状态被当成一次真实转变 —— 测不出真实场景（实测踩过）。
    // 另外要在开场手势演完之前送达，才能覆盖"状态排队等手势"那条路径。
    if (process.env.PET_FORCE_STATE) {
      const forced = { type: 'state', state: process.env.PET_FORCE_STATE }
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.webContents.send('pet:frame', forced)
          log(`已强制推送状态：${forced.state}（未发真实快照）`)
        }
      }, 600)
      return
    }

    if (lastSnapshot !== undefined) win.webContents.send('pet:frame', lastSnapshot)
    log(`渲染端就绪，补发 lastLink=${JSON.stringify(lastLink)} snapshot=${lastSnapshot !== undefined}`)
  })
  ipcMain.on('pet:quit', () => app.quit())

  // 点击穿透下窗口收不到键盘，用全局快捷键退出
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    log('快捷键退出')
    app.quit()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  sseLink?.close()
})

app.on('window-all-closed', () => app.quit())
