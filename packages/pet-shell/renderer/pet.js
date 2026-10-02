/**
 * 昔涟桌宠 · 渲染端逻辑
 *
 * 关键点：
 *  1. 窗口默认点击穿透（setIgnoreMouseEvents(true, {forward:true})），
 *     鼠标移动仍会送到本页；这里用 **alpha 掩码** 判断是否落在不透明像素上，
 *     决定要不要让窗口接管鼠标 —— 避免透明区域挡住下层应用（PLAN.md §三 设计要点 2）。
 *  2. 拖动自己做：命中不透明像素后按 mousedown 进入拖拽，用 screenX/screenY 求增量，
 *     经 IPC 让主进程移动窗口（不用 -webkit-app-region，避免与命中测试打架）。
 *  3. 素材是占位图；状态用光环表达。换成 Live2D 时只需替换渲染层。
 *
 * 命名注意：桥接对象叫 window.xilianPet，**不能**叫 window.pet ——
 * HTML 里任何 id="pet" 的元素都会自动创建 window.pet，撞名会让本文件直接
 * SyntaxError 而完全不执行（实测踩过）。
 */

const api = window.xilianPet
const stage = document.getElementById('stage')
const canvas = document.getElementById('live2dCanvas')
const img = document.getElementById('petSprite')
const halo = document.getElementById('halo')
const badge = document.getElementById('badge')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubbleText')
const composer = document.getElementById('composer')
const composerInput = document.getElementById('composerInput')
const interruptBtn = document.getElementById('interruptBtn')
const status = document.getElementById('status')

const ALPHA_THRESHOLD = 24

let alphaMap = null
let mapW = 0
let mapH = 0
let interactive = null
let dragging = false
let dragX = 0
let dragY = 0
let lastClickAt = 0
let bubbleTimer = null
let latestSessionId = undefined
let unread = 0

// Live2D 是否成功接管。失败时保持 false → 用占位图 + 占位图的 alpha 掩码（验收项 A10 降级）
let live2dActive = false
let maskTimer = null

// live2d.js 是 ES 模块，由启动流程动态 import（见文件末尾）。
// 用动态 import 是刻意的：静态 import 一旦失败会连本文件都不执行，降级就没了。
// 命名上刻意**不叫** setState/fit 之类 —— 本文件已有同名函数。
let live2d = null

// ── alpha 掩码 ──────────────────────────────────────────────────────
// Live2D 接管时从 WebGL 画布取样（模型会形变，不能用原始纹理当掩码）；
// 降级时用占位 <img>。两者共用同一套掩码结构。
// 取样实现放在 live2d.js（readAlpha），避免两处各写一份 drawImage 逻辑。
function maskSource() {
  return live2dActive ? canvas : img
}

/**
 * 把掩码降采样后交给主进程做命中测试。
 *
 * 为什么要降采样：主进程每 16ms 查一次，掩码只需"够用"。
 * 520×600 全量送是 31 万字节 × 每秒 4 次 ≈ 1.2MB/s，降 4 倍后只剩 ~78KB/s。
 * 取块内**最大值**而不是平均值 —— 宁可判成不透明，也不能漏掉细小的可点区域
 * （比如发梢、绳子的细线）。
 */
function publishMask() {
  if (!alphaMap || !mapW || !mapH) return
  const step = Math.max(1, Math.ceil(Math.max(mapW, mapH) / 160))
  const w = Math.floor(mapW / step)
  const h = Math.floor(mapH / step)
  if (w < 1 || h < 1) return
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let max = 0
      for (let dy = 0; dy < step; dy++) {
        const sy = y * step + dy
        if (sy >= mapH) break
        const row = sy * mapW
        for (let dx = 0; dx < step; dx++) {
          const sx = x * step + dx
          if (sx >= mapW) break
          const a = alphaMap[row + sx]
          if (a > max) max = a
        }
      }
      out[y * w + x] = max
    }
  }
  api.sendMask(w, h, out)
}

async function buildAlphaMap() {
  if (live2dActive) {
    const shot = live2d?.readAlpha?.()
    if (!shot) return
    mapW = shot.width
    mapH = shot.height
    alphaMap = shot.alpha
    publishMask()
    return
  }

  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) return

  const scratch = document.createElement('canvas')
  scratch.width = w
  scratch.height = h
  const context = scratch.getContext('2d', { willReadFrequently: true })
  context.clearRect(0, 0, w, h)
  context.drawImage(img, 0, 0)

  const { data } = context.getImageData(0, 0, w, h)
  mapW = w
  mapH = h
  alphaMap = new Uint8Array(mapW * mapH)
  for (let i = 0; i < alphaMap.length; i++) alphaMap[i] = data[i * 4 + 3]
  publishMask()
}

function overOpaquePixel(clientX, clientY) {
  if (alphaMap === null) return false
  const rect = maskSource().getBoundingClientRect()
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false
  const u = Math.floor(((clientX - rect.left) / rect.width) * mapW)
  const v = Math.floor(((clientY - rect.top) / rect.height) * mapH)
  if (u < 0 || v < 0 || u >= mapW || v >= mapH) return false
  return alphaMap[v * mapW + u] > ALPHA_THRESHOLD
}

function insideRect(el, clientX, clientY) {
  if (el.hidden) return false
  const r = el.getBoundingClientRect()
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
}

/** 只有「落在不透明像素上」或「悬停在 UI 控件上」时才接管鼠标，其余保持穿透 */
function shouldBeInteractive(clientX, clientY) {
  if (overOpaquePixel(clientX, clientY)) return true
  return insideRect(composer, clientX, clientY) || insideRect(bubble, clientX, clientY)
}

/**
 * 只负责光标样式。
 *
 * ⚠️ **不再**通过 IPC 切换点击穿透 —— 那件事已交给主进程轮询光标。
 * 原因见 main.js 顶部：Electron 在 Windows 上的鼠标转发（forward:true）是已知 bug，
 * 一旦有别的窗口进前台，转发就会停 → 渲染端收不到 mousemove → 窗口永远卡在穿透状态。
 */
function updateCursor(next) {
  if (next === interactive) return
  interactive = next
  document.body.style.cursor = next ? 'grab' : 'default'
}

// ── 鼠标：命中测试 + 拖拽 ───────────────────────────────────────────
window.addEventListener(
  'mousemove',
  (event) => {
    if (dragging) {
      const dx = event.screenX - dragX
      const dy = event.screenY - dragY
      dragX = event.screenX
      dragY = event.screenY
      if (dx !== 0 || dy !== 0) api.moveBy(dx, dy)
      return
    }
    updateCursor(shouldBeInteractive(event.clientX, event.clientY))
  },
  { passive: true },
)

window.addEventListener('mousedown', (event) => {
  if (!shouldBeInteractive(event.clientX, event.clientY)) return
  if (insideRect(composer, event.clientX, event.clientY)) return
  dragging = true
  // 告诉主进程进入拖拽态：拖拽期间它会让窗口一直保持可交互，
  // 否则鼠标快速移出角色（超出不透明区域）的那一瞬间窗口就会变回穿透，拖拽被"甩掉"。
  api.setDragging(true)
  dragX = event.screenX
  dragY = event.screenY
  if (!live2dActive) img.classList.add('squish')
  document.body.style.cursor = 'grabbing'
})

window.addEventListener('mouseup', (event) => {
  if (!dragging) {
    // 未拖动 → 视为点击：清未读
    if (shouldBeInteractive(event.clientX, event.clientY)) markRead()
    return
  }
  dragging = false
  api.setDragging(false)
  if (!live2dActive) img.classList.remove('squish')
  document.body.style.cursor = 'grab'
})

// 双击宠物 → 唤出 / 收起派活输入条
window.addEventListener('dblclick', (event) => {
  if (!overOpaquePixel(event.clientX, event.clientY)) return
  const now = Date.now()
  if (now - lastClickAt < 400) return
  lastClickAt = now
  toggleComposer()
})

// ── UI 状态 ─────────────────────────────────────────────────────────
function setState(state) {
  halo.dataset.state = state
  // 转发给 Live2D。内部做了去重，同一状态重复推送不会重复触发。
  // 注意 live2d 可能还是 null（模块加载中或加载失败），所以用可选链。
  try {
    live2d?.setState(state)
  } catch (error) {
    api.log(`Live2D 状态切换失败：${error.message}`)
  }
}

function setBadge(count) {
  unread = count
  if (count > 0) {
    badge.textContent = `+${count}`
    badge.hidden = false
  } else {
    badge.hidden = true
  }
}

function markRead() {
  if (unread === 0) return
  setBadge(0)
}

function showBubble(text) {
  if (typeof text !== 'string' || text.trim() === '') return
  bubbleText.textContent = text
  bubble.hidden = false
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    bubble.hidden = true
  }, 6000)
}

function toggleComposer() {
  composer.hidden = !composer.hidden
  if (!composer.hidden) {
    composerInput.focus()
    api.log('派活输入条已打开')
  }
}

composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = composerInput.value.trim()
  if (text === '') return
  composerInput.value = ''
  showBubble('收到，正在派活…')
  const result = await api.control('prompt', { text, sessionId: latestSessionId })
  api.log(`prompt → ${result.status} ${JSON.stringify(result.body)}`)
  if (result.status !== 200) {
    showBubble(`派活失败（${result.status}）：${result.body?.message ?? result.error ?? '未知原因'}`)
  }
})

interruptBtn.addEventListener('click', async () => {
  const result = await api.control('interrupt', { sessionId: latestSessionId })
  api.log(`interrupt → ${result.status} ${JSON.stringify(result.body)}`)
  showBubble(result.status === 200 ? '已打断' : `打断失败（${result.status}）`)
})

// ── 与主进程的帧通道 ────────────────────────────────────────────────
api.onLink((link) => {
  status.dataset.link = link.connected ? 'up' : 'down'
  status.title = link.connected ? `已连接 ${link.url ?? ''}` : `未连接${link.error ? `：${link.error}` : ''}`
  // 刻意不把断连映射成 'error' 状态：那是 agent 出错的意思。
  // 连接状态由右下角状态点表达，宠物状态只反映与会话有关的事实。
})

api.onFrame((frame) => {
  switch (frame.type) {
    case 'hello':
      api.log(`hello protocol=${frame.protocol}`)
      break
    case 'snapshot':
      setState(frame.state)
      setBadge(frame.unread ?? 0)
      if (Array.isArray(frame.sessions) && frame.sessions.length > 0) {
        latestSessionId = frame.sessions[frame.sessions.length - 1].sessionId
      }
      break
    case 'state':
      setState(frame.state)
      setBadge(frame.unread ?? 0)
      break
    case 'stream':
      if (frame.sessionId !== undefined) latestSessionId = frame.sessionId
      showBubble(frame.text)
      break
    case 'control':
      api.log(`control ${frame.action} ok=${frame.ok}`)
      break
    default:
      api.log(`未识别的帧：${JSON.stringify(frame).slice(0, 160)}`)
  }
})

// ── 启动 ────────────────────────────────────────────────────────────
/** 尝试用 Live2D 接管；任何一步失败都返回 false → 保持占位图（验收项 A10 降级） */
async function startLive2D() {
  if (!live2d) {
    api.log('Live2D 模块不可用 → 使用占位形象')
    return false
  }
  const info = await api.modelInfo()
  api.log(`模型信息 ${JSON.stringify(info)}`)
  if (!info?.exists || !info.url) {
    api.log('模型文件不存在 → 使用占位形象（A10 降级）')
    return false
  }
  await live2d.init({
    canvas,
    modelUrl: info.url,
    log: (message) => api.log(`[live2d] ${message}`),
    forceMotion: info.forceMotion,
    sampleMs: info.sampleMs,
  })

  // 精确捕捉动作关键帧：从**动作开始**（= init 返回）算起，
  // 而不是从窗口 ready 算起（那会差 1~3 秒且不稳定，实测踩不到高光时刻）。
  if (info.snapshotAtMs > 0) {
    setTimeout(() => {
      api.log(`到达动作 ${info.snapshotAtMs}ms，请求截图`)
      api.snapshotNow()
    }, info.snapshotAtMs)
  }
  return true
}

;(async () => {
  // 动态 import 模块版 live2d.js。失败也不能影响占位图降级。
  try {
    live2d = await import('./live2d.js')
  } catch (error) {
    api.log(`Live2D 模块加载失败：${error.message} → 将使用占位形象`)
    live2d = null
  }

  try {
    live2dActive = await startLive2D()
  } catch (error) {
    api.log(`Live2D 初始化失败：${error.message} → 回退占位形象`)
    live2dActive = false
  }

  // 成功才隐藏占位图；失败时 canvas 保持空白，视觉上等价于没接管
  if (live2dActive) img.hidden = true

  try {
    await buildAlphaMap()
    api.log(`alpha 掩码就绪 ${mapW}×${mapH}（来源：${live2dActive ? 'Live2D 画布' : '占位图'}）`)
  } catch (error) {
    api.log(`alpha 掩码构建失败：${error.message} → 退化为整窗可交互`)
    // 送一张全不透明的掩码给主进程，等价于"整窗可交互"，避免完全点不到
    const side = 8
    api.sendMask(side, side, new Uint8Array(side * side).fill(255))
  }

  // Live2D 模型会形变，掩码要跟着刷新（250ms 一次，开销可忽略）
  if (live2dActive) {
    maskTimer = setInterval(() => {
      buildAlphaMap().catch(() => {})
    }, 250)
  }

  updateCursor(false)
  status.dataset.link = 'down'
  api.log(`渲染端已加载（live2d=${live2dActive}）`)
  // 握手：handler 都注册好了，请主进程补发最近的连接状态与快照。
  // 不做这一步，主进程在页面加载完成前发出的 'pet:link' 会被直接丢掉，
  // 表现就是"日志说 SSE 已连接，状态点却是红的"（实测踩过）。
  api.ready()
})()
