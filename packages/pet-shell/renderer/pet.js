/**
 * 西莲桌宠 · 渲染端逻辑
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

// ── alpha 掩码 ──────────────────────────────────────────────────────
async function buildAlphaMap() {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  await img.decode()
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  context.drawImage(img, 0, 0)
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  mapW = canvas.width
  mapH = canvas.height
  alphaMap = new Uint8Array(mapW * mapH)
  for (let i = 0; i < alphaMap.length; i++) alphaMap[i] = data[i * 4 + 3]
  api.log(`alpha 掩码就绪 ${mapW}×${mapH}`)
}

function overOpaquePixel(clientX, clientY) {
  if (alphaMap === null) return false
  const rect = img.getBoundingClientRect()
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

function updateInteractive(next) {
  if (next === interactive) return
  interactive = next
  api.setInteractive(next)
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
    updateInteractive(shouldBeInteractive(event.clientX, event.clientY))
  },
  { passive: true },
)

window.addEventListener('mousedown', (event) => {
  if (!shouldBeInteractive(event.clientX, event.clientY)) return
  if (insideRect(composer, event.clientX, event.clientY)) return
  dragging = true
  dragX = event.screenX
  dragY = event.screenY
  img.classList.add('squish')
  document.body.style.cursor = 'grabbing'
})

window.addEventListener('mouseup', (event) => {
  if (!dragging) {
    // 未拖动 → 视为点击：清未读
    if (shouldBeInteractive(event.clientX, event.clientY)) markRead()
    return
  }
  dragging = false
  img.classList.remove('squish')
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
buildAlphaMap().catch((error) => {
  api.log(`alpha 掩码构建失败：${error.message}`)
  // 掩码失败时退化为「整窗可交互」，避免完全点不到
  updateInteractive(true)
})

updateInteractive(false)
status.dataset.link = 'down'
api.log(`渲染端已加载（href=${location.href.slice(-40)}）`)
// 握手：handler 都注册好了，请主进程补发最近的连接状态与快照。
// 不做这一步，主进程在页面加载完成前发出的 'pet:link' 会被直接丢掉，
// 表现就是"日志说 SSE 已连接，状态点却是红的"（实测踩过）。
api.ready()
