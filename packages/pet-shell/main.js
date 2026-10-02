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
import http from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const log = (...args) => console.log('[pet]', ...args)

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
let sseRequest
let sseRetryMs = 1000
let sseConnected = false
let retryTimer

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
}

function startSse(win) {
  const url = new URL(`${ROUTE_PREFIX}/events`, DSH_URL)
  sseRequest = http.get(url, (res) => {
    if (res.statusCode !== 200) {
      log(`SSE ${url.pathname} → HTTP ${res.statusCode}（插件未加载或被前缀路由吞掉）`)
      res.resume()
      scheduleRetry(win)
      return
    }
    sseConnected = true
    sseRetryMs = 1000
    log(`SSE 已连接 ${url.href}`)
    pushLink(win, { connected: true, url: url.href })

    res.setEncoding('utf8')
    let buffer = ''
    res.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const frame = JSON.parse(line.slice(5).trim())
            if (frame.type === 'snapshot') lastSnapshot = frame
            send(win, 'pet:frame', frame)
          } catch (error) {
            log('frame parse failed:', error.message)
          }
        }
      }
    })
    res.on('end', () => {
      sseConnected = false
      pushLink(win, { connected: false })
      scheduleRetry(win)
    })
  })
  sseRequest.on('error', (error) => {
    sseConnected = false
    log(`SSE 连接失败：${error.message}`)
    pushLink(win, { connected: false, error: error.message })
    scheduleRetry(win)
  })
}

function scheduleRetry(win) {
  clearTimeout(retryTimer)
  const delay = sseRetryMs
  sseRetryMs = Math.min(sseRetryMs * 2, 10_000)
  retryTimer = setTimeout(() => {
    if (!win.isDestroyed()) startSse(win)
  }, delay)
  retryTimer.unref?.()
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
/** 拖拽中必须一直保持可交互：否则鼠标快速移出角色时窗口会"甩掉"拖拽 */
let draggingNow = false
let lastIgnore = null
let ignoreLogs = 0

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
    if (draggingNow) {
      applyIgnore(win, false)
      return
    }
    if (!alphaMask) {
      applyIgnore(win, true)
      return
    }
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const x = p.x - b.x
    const y = p.y - b.y
    let opaque = false
    let u = -1
    let v = -1
    let sampled = -1
    if (x >= 0 && y >= 0 && x < b.width && y < b.height) {
      u = Math.floor((x / b.width) * alphaMask.width)
      v = Math.floor((y / b.height) * alphaMask.height)
      if (u >= 0 && v >= 0 && u < alphaMask.width && v < alphaMask.height) {
        sampled = alphaMask.data[v * alphaMask.width + u]
        opaque = sampled > HIT_ALPHA_THRESHOLD
      }
    }
    // PET_HIT_DEBUG=1 时每秒打一行，肉眼可核对坐标换算对不对
    if (debug && Date.now() - lastDebugAt > 1000) {
      lastDebugAt = Date.now()
      log(
        `[命中] 光标(${p.x},${p.y}) 窗口(${b.x},${b.y} ${b.width}×${b.height}) ` +
          `局部(${x},${y}) 掩码(${u},${v}) alpha=${sampled} → ${opaque ? '可交互' : '穿透'}`,
      )
    }
    applyIgnore(win, !opaque)
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
  log(`DSH=${DSH_URL} prefix=${ROUTE_PREFIX} state=${statePath}`)

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
    }
  })
  ipcMain.on('pet:dragging', (_event, value) => {
    draggingNow = Boolean(value)
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
    const [x, y] = win.getPosition()
    win.setPosition(x + dx, y + dy)
  })
  ipcMain.handle('pet:control', (_event, action, payload) => postControl(action, payload))
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
      // 从动作开始算起的截图时刻（0 = 不用这条路径）
      snapshotAtMs: Number(process.env.PET_SNAPSHOT_AT_MOTION_MS ?? 0),
    }
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
      const forced = { type: 'state', state: process.env.PET_FORCE_STATE, unread: 0 }
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
  sseRequest?.destroy()
})

app.on('window-all-closed', () => app.quit())
