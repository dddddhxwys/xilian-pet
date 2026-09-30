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

import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron'
import http from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const DSH_URL = process.env.PET_DSH_URL ?? 'http://127.0.0.1:19387'
const ROUTE_PREFIX = (process.env.PET_ROUTE_PREFIX ?? '/xilian-pet').replace(/\/+$/, '')
const STATE_DIR = process.env.PET_STATE_DIR ?? join(here, '.state')
const WIDTH = Number(process.env.PET_WIDTH ?? 260)
const HEIGHT = Number(process.env.PET_HEIGHT ?? 300)

mkdirSync(STATE_DIR, { recursive: true })
const statePath = join(STATE_DIR, 'window.json')

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

// ── 自检截图（只截我们自己的透明窗，不碰用户桌面）──────────────────
// 用法：PET_SNAPSHOT=<png路径> [PET_SNAPSHOT_EXIT=1]
// 有它的意义：agent 看不到屏幕，但可以拿这张图确认"窗口确实渲染出了宠物"，
// 并且能直接检查透明通道是否正确（透明区域必须是 alpha=0）。
function maybeSnapshot(win) {
  const target = process.env.PET_SNAPSHOT
  if (!target) return
  const delay = Number(process.env.PET_SNAPSHOT_DELAY_MS ?? 2500)
  setTimeout(async () => {
    try {
      const image = await win.webContents.capturePage()
      const png = image.toPNG()
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
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
  }, delay)
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

  // 默认点击穿透 + 转发鼠标移动，让渲染端能做 alpha 掩码命中测试
  win.setIgnoreMouseEvents(true, { forward: true })

  win.once('ready-to-show', () => {
    win.showInactive()
    log(`窗口就绪 ${win.getSize().join('x')}，点击穿透已开启（悬停不透明像素才接管鼠标）`)
    maybeSnapshot(win)
  })

  win.on('moved', () => saveWindowState(win))
  win.on('closed', () => saveWindowState(win))

  win.loadFile(join(here, 'renderer', 'index.html'))
  return win
}

app.whenReady().then(async () => {
  log(`DSH=${DSH_URL} prefix=${ROUTE_PREFIX} state=${statePath}`)

  const health = await probeHealth()
  if (health.status === 200 && health.body?.ok) {
    log(`插件在线：pid=${health.body.pid} state=${health.body.state}`)
  } else {
    log(`插件不可达（status=${health.status}${health.error ? `, ${health.error}` : ''}）`)
    log('→ 先把 packages/pet-plugin 作为 bundle 装进 profile，或按 cordis.patch.yml 里的方式 2 直挂')
  }

  const win = createWindow()
  startSse(win)

  ipcMain.on('pet:set-interactive', (_event, interactive) => {
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  ipcMain.on('pet:move-by', (_event, dx, dy) => {
    if (win.isDestroyed()) return
    const [x, y] = win.getPosition()
    win.setPosition(x + dx, y + dy)
  })
  ipcMain.handle('pet:control', (_event, action, payload) => postControl(action, payload))
  ipcMain.on('pet:log', (_event, message) => log('[renderer]', message))
  // 渲染端注册好 handler 之后握手一次，补发最近的连接状态与快照帧
  ipcMain.on('pet:ready', () => {
    if (win.isDestroyed()) return
    win.webContents.send('pet:link', lastLink)
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
