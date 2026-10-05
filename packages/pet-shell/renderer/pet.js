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
const badge = document.getElementById('badge')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubbleText')
// 原底部输入条（#composer）已**整个删除** —— 它压着裙摆和脚（实测重叠 28px），
// 派活/打断现在都在独立操作面板里（见 main.js 的 openMenuWindow）。
const notice = document.getElementById('notice')
const noticeText = document.getElementById('noticeText')
const status = document.getElementById('status')
// 审批不在本窗口里画 —— 她头顶只有 ~87px 留白，放不下审批卡（必然遮住她）。
// 审批走**专用小窗**（main.js 的 openApprovalWindow），见 approval.js。

const ALPHA_THRESHOLD = 24

let alphaMap = null
let mapW = 0
let mapH = 0
let interactive = null
let dragging = false
let dragX = 0
let dragY = 0
let bubbleTimer = null
let noticeTimer = null
let latestSessionId = undefined
let unread = 0
// 用量视图：插件在状态帧里带（见 reducer 的 primaryTokens），右键时交给菜单小窗显示
let tokensView = null

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
/**
 * 当前「可见且需要接住鼠标」的 UI 区域（CSS px，相对视口）。
 *
 * 为什么要送给主进程：点击穿透的判定**在主进程**（见 main.js 顶部 —— 绕开 Electron 在
 * Windows 上的鼠标转发 bug），而主进程手上只有 Live2D 的 alpha 掩码，
 * **它不知道输入条 / 气泡这些 HTML 控件**。
 * 于是"控件在、但角色轮廓没盖住"的位置会被判成透明 → 穿透 → 按钮点不动。
 * 实测症状：输入条右侧的「打断」点不到（那儿没有角色像素），
 * 而「派活」恰好压在角色上所以能点 —— 很迷惑人。
 */
function visibleUiRects() {
  const rects = []
  // ⚠️ 只收**能接住点击**的控件。气泡是 pointer-events:none 的被动展示，
  // 把它算进来会在它覆盖的区域形成一个"点了没反应、也不穿透"的死区。
  for (const el of [notice, badge]) {
    if (el.hidden) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    rects.push({ x: r.left, y: r.top, w: r.width, h: r.height })
  }
  return rects
}

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
  api.sendMask(w, h, out, visibleUiRects())
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
  return insideRect(bubble, clientX, clientY) || insideRect(notice, clientX, clientY) || insideRect(badge, clientX, clientY)
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

// ── 鼠标：命中测试 + 拖拽 + 点击 ───────────────────────────────────
// ⚠️ 「点」和「拖」必须分开判 —— 以前是 mousedown 无条件 `dragging = true`，
// 于是 mouseup 里的 `if (!dragging)` 永远不成立，**单击清未读从来没生效过**。
// 现在的判据：按下后位移不超过 CLICK_SLOP_PX 就算"点击"。
const CLICK_SLOP_PX = 4
let pressX = 0
let pressY = 0
let movedFar = false

window.addEventListener(
  'mousemove',
  (event) => {
    if (dragging) {
      if (Math.abs(event.screenX - pressX) > CLICK_SLOP_PX || Math.abs(event.screenY - pressY) > CLICK_SLOP_PX) {
        movedFar = true
      }
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
  if (event.button !== 0) return // 右键留给菜单小窗，不参与拖拽
  if (!shouldBeInteractive(event.clientX, event.clientY)) return
  dragging = true
  movedFar = false
  // 告诉主进程进入拖拽态：拖拽期间它会让窗口一直保持可交互，
  // 否则鼠标快速移出角色（超出不透明区域）的那一瞬间窗口就会变回穿透，拖拽被"甩掉"。
  // （按下就先告诉它，是为了保住拖拽手感；是不是"点击"稍后用 movedFar 判。）
  api.setDragging(true)
  dragX = event.screenX
  dragY = event.screenY
  pressX = event.screenX
  pressY = event.screenY
  if (!live2dActive) img.classList.add('squish')
  document.body.style.cursor = 'grabbing'
})

/**
 * 秋千区判定 —— 她身体**两侧的翅膀/秋千**。
 *
 * 判据：x 偏离画布中线的距离超过 `SWING_ZONE_RATIO × 画布宽`。
 * ⚠️ 用**比例**而不是固定像素：窗口宽度、构图缓存、DPI 都可能变，比例才稳。
 * ⚠️ 只在**不透明像素**上才会收到 click（主进程的 alpha 命中测试已经过滤），
 *    所以这里不用再判 alpha —— 点空白处根本不会进来。
 */
const SWING_ZONE_RATIO = 0.22

function isSwingZone(clientX) {
  const width = document.getElementById('live2dCanvas')?.clientWidth ?? window.innerWidth
  if (!(width > 0)) return false
  return Math.abs(clientX - width / 2) > width * SWING_ZONE_RATIO
}

window.addEventListener('mouseup', (event) => {
  if (!dragging) return
  dragging = false
  api.setDragging(false)
  if (!live2dActive) img.classList.remove('squish')
  document.body.style.cursor = 'grab'
  if (movedFar) return // 拖过了，不算点击
  // ── 左键分区互动 ───────────────────────────────────────────────
  // 秋千区（两侧翅膀）→ 弹她一下（用户要求："像被手指弹了似的"）
  if (isSwingZone(event.clientX)) {
    live2d?.flick('light')
    return
  }
  // 其它区域暂时仍是"清未读"（用户已决定去掉未读，等分区做完一起改）
  markRead()
})

// 点右下角的未读徽标 = 清未读（徽标本身就是"未读"，直接点它最直观）
badge.addEventListener('click', (event) => {
  event.stopPropagation()
  markRead()
})

// ── 操作面板（独立小窗）─────────────────────────────────────────────
// 面板是**独立窗口**（main.js 的 openMenuWindow），不在本窗口里画 ——
// 她本体占满 260×300，画在里面必然遮住她；原来的底部输入条就压着她的裙摆和脚（实测重叠 28px），
// 所以那条输入条**整个删掉了**，操作全搬到面板里。
// 这边只负责：请求弹出面板、把气泡提示显示出来。

// 右键昔涟 → 弹面板 + 问号表情。
// 注意 mousedown 里已按 `event.button !== 0` 挡掉右键，所以右键不会触发拖拽。
window.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (!overOpaquePixel(event.clientX, event.clientY)) return
  live2d?.pokeExpression('question', 1700) // "你想干嘛？"
  openPanel()
})

// 双击她 = **不做任何事**（用户要求去掉"双击唤起面板"）。
// 双击的事件序列是 click, click, dblclick —— 单击仍然是"清未读"。

// 面板执行完动作后的提示，走气泡显示（派活/打断都在主进程执行，那边回报过来）
api.onBubble((text) => showBubble(text))

/** 请求弹出操作面板（**只有右键这一条路** —— 双击已按用户要求去掉） */
function openPanel() {
  api
    .openMenu({ tokens: tokensView })
    .then((result) => api.log(`操作面板：${result?.ok ? '已弹出' : JSON.stringify(result)}`))
    .catch((error) => api.log(`操作面板打开失败：${error?.message ?? error}`))
}

// 审批卡已移到**专用小窗**（approval.html/js）—— 本窗口里画必然遮住她。
// 审批帧由主进程直接处理（见 main.js 的 handleApprovalFrame），本窗口不再参与。

// ── UI 状态 ─────────────────────────────────────────────────────────
function setState(state) {
  // （原来这里会把状态写到 #halo 上做光晕配色；光晕已按用户要求去掉。）
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

/**
 * 清未读 —— **必须告诉插件**，不能只清本地显示。
 *
 * 以前这里只 `setBadge(0)`，是假清：插件的会话 `unread` 还是 true，
 * 下一个 `state` 帧又把 `unread: N` 报回来，徽标立刻复原。
 * 而且它原本还是**死代码** —— `mousedown` 无条件把 `dragging` 置 true，
 * mouseup 里那个 `if (!dragging)` 分支永远走不到（见下面的点击判定）。
 */
async function markRead() {
  const before = unread
  if (before > 0) setBadge(0) // 先本地收掉，手感即时
  try {
    const result = await api.control('read', {})
    if (result?.status === 200 && typeof result.body?.unread === 'number') {
      setBadge(result.body.unread) // 以插件的数字为准
      api.log(`已标记已读（未读剩 ${result.body.unread}）`)
    } else {
      api.log(`清未读失败：${result?.status} ${JSON.stringify(result?.body)}`)
      if (before > 0) setBadge(before)
    }
  } catch (error) {
    api.log(`清未读异常：${error?.message ?? error}`)
    if (before > 0) setBadge(before)
  }
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

// ── A7 主动提醒 ─────────────────────────────────────────────────────
/**
 * 显示一条主动提醒（审批积压 / 久坐 / 花销）。
 *
 * 与气泡的区别：气泡是"它现在在干什么"的流水，固定 6 秒消失；
 * 通知是"要你注意 / 要你动手"：
 *  · `urgent`（审批积压）**不自动消失** —— 它就是要你去处理，点了才收
 *  · 低优先（久坐 / 花销）8 秒后自己收，免得长期霸占桌面
 */
function showNotice({ text, urgent, notice: kind } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return
  noticeText.textContent = text
  notice.dataset.urgent = urgent ? '1' : '0'
  notice.dataset.kind = kind ?? ''
  notice.hidden = false
  document.body.classList.add('has-notice')
  // 量出通知实际高度，交给 CSS 把气泡让开（1 行 / 2 行都能对上，不写死偏移）
  document.body.style.setProperty('--notice-h', `${notice.offsetHeight}px`)
  clearTimeout(noticeTimer)
  if (!urgent) noticeTimer = setTimeout(hideNotice, 8000)
  api.log(`通知：${text}${urgent ? '（urgent）' : ''}`)
}

function hideNotice() {
  clearTimeout(noticeTimer)
  notice.hidden = true
  document.body.classList.remove('has-notice')
  document.body.style.removeProperty('--notice-h')
}

// 点击通知 → 把 DSH 窗口唤到前台（"单击跳转"）。失败就留着，好让你再点一次。
notice.addEventListener('click', async () => {
  const result = await api.focusDsh()
  api.log(`focus-dsh → ${JSON.stringify(result)}`)
  if (result?.ok !== false) hideNotice()
})

// ── 与主进程的帧通道 ────────────────────────────────────────────────
api.onLink((link) => {
  status.dataset.link = link.connected ? 'up' : 'down'
  status.title = link.connected ? `已连接 ${link.url ?? ''}` : `未连接${link.error ? `：${link.error}` : ''}`
  // 刻意不把断连映射成 'error' 状态：那是 agent 出错的意思。
  // 连接状态由右下角状态点表达，宠物状态只反映与会话有关的事实。
})

api.onFrame((frame) => {
  // 任何一帧只要带了主会话 id 就记住它。
  // 为什么不能只在 snapshot 里学：DSH 刚重启时 /state 是空的，窗口可能"先连上、会话后出现"，
  // 那样 snapshot 里没有会话、sessionId 会一直是 undefined → 派活 503。
  // 主会话由插件算（以最近活跃为准），这里只管记住。
  if (typeof frame.primarySessionId === 'string' && frame.primarySessionId !== '') {
    latestSessionId = frame.primarySessionId
  }
  // 用量视图（右键时交给菜单小窗）。状态帧也带 —— 这样数字是新鲜的，
  // 而不是停在 SSE 连接那一刻的 snapshot。
  if (frame.tokens !== undefined) tokensView = frame.tokens
  switch (frame.type) {
    case 'hello':
      api.log(`hello protocol=${frame.protocol}`)
      break
    case 'snapshot':
      setState(frame.state)
      setBadge(frame.unread ?? 0)
      break
    case 'state':
      setState(frame.state)
      setBadge(frame.unread ?? 0)
      break
    // approval / approval-resolved 帧由**主进程**处理（handleApprovalFrame → 审批专用小窗），
    // 本窗口刻意不显示任何审批 UI：她头顶只有 ~87px 留白，放不下，必然遮住她。
    case 'activity':
      // 活动摘要（"执行了命令""已完成分析"…）—— 气泡现在只显示这个，不显示 AI 正文
      showBubble(frame.text)
      break
    case 'stream':
      // 老的逐字流：插件默认已不再推（bubbleMode: 'activity'），保留分支以防切回
      if (frame.sessionId !== undefined) latestSessionId = frame.sessionId
      showBubble(frame.text)
      break
    case 'notice':
      showNotice(frame)
      break
    case 'notices':
      // 窗口没连时发出的提醒，连上后补发最近 5 条 —— 只显示最新的一条，别堆一屏
      if (Array.isArray(frame.notices) && frame.notices.length > 0) {
        showNotice(frame.notices[frame.notices.length - 1])
      }
      break
    case 'control':
      api.log(`control ${frame.action} ok=${frame.ok}`)
      break
    default:
      api.log(`未识别的帧：${JSON.stringify(frame).slice(0, 160)}`)
  }
})

// ── 启动 ────────────────────────────────────────────────────────────
/**
 * 告诉主进程"可以显示窗口了"。
 *
 * 主进程会一直等到这个信号 —— 否则会先按保底尺寸显示，约 3 秒后构图测完再跳一下
 * （用户实测报的"打开一会突然变大"）。所以这里必须保证**任何路径都会发**，
 * 包括 Live2D 失败降级成占位图的情况。
 */
let fitReadySent = false
function signalFitReady() {
  if (fitReadySent) return
  fitReadySent = true
  api.fitReady()
}

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

  // 构图缓存（按模型分开存）：有就直接套用，省掉现场测量
  const cachedFit = await api.fitCacheGet(info.url).catch(() => null)
  if (cachedFit) api.log(`找到构图缓存 ${Math.round(cachedFit.w)}×${Math.round(cachedFit.h)}`)

  await live2d.init({
    canvas,
    modelUrl: info.url,
    log: (message) => api.log(`[live2d] ${message}`),
    forceMotion: info.forceMotion,
    sampleMs: info.sampleMs,
    handDebug: info.handDebug,
    cachedFit,
    onFitReady: (box, fromCache) => {
      if (!fromCache && box) {
        api.fitCacheSet(info.url, box).catch(() => {})
        api.log(`构图测量完成，已缓存 ${Math.round(box.w)}×${Math.round(box.h)}`)
      }
      signalFitReady()
    },
  })

  // 精确捕捉动作关键帧：从**动作开始**（= init 返回）算起，
  // 而不是从窗口 ready 算起（那会差 1~3 秒且不稳定，实测踩不到高光时刻）。
  if (info.snapshotAtMs > 0) {
    setTimeout(() => {
      api.log(`到达动作 ${info.snapshotAtMs}ms，请求截图`)
      api.snapshotNow()
    }, info.snapshotAtMs)
  }
  // 调试用：反复弹她（PET_FORCE_FLICK=1）——
  // 核对"被弹"的效果，不必真的用鼠标去点秋千。
  // ⚠️ 刻意**反复弹**（600ms 一次、每 700ms 一发）：裁剪时机很难对准，
  //    连发才能保证随便抓一帧都能落在振荡里（踩过：抓帧总在弹完之后）。
  if (info.forceFlick) {
    setInterval(() => {
      live2d?.flick('light')
    }, 700)
  }
  // 调试用：启动后自动弹出操作面板（PET_FORCE_MENU=1），配合 PET_SNAPSHOT_MENU 拍面板。
  // 刻意等到 2.5s：要等 SSE 连上并收到带 tokens 的状态帧，拍出来才有真实数字。
  if (info.forceMenu) {
    setTimeout(() => {
      api.log('调试模式：自动弹出操作面板')
      // 和真实右键路径保持一致（否则拍不到 poke 的效果）
      live2d?.pokeExpression('question', 1700)
      openPanel()
    }, 2500)
  }
  // 审批的调试开关（PET_FORCE_APPROVAL）现在由**主进程**处理 ——
  // 审批小窗是独立窗口，不归本渲染端管（见 main.js）。
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

  // 兜底：无论成功失败，8 秒内一定要放行窗口显示，
  // 免得构图回调因为任何意外没触发，窗口永远不出现。
  setTimeout(signalFitReady, 8000)
  // 降级路径没有构图回调，直接放行
  if (!live2dActive) signalFitReady()

  // 成功才隐藏占位图；失败时 canvas 保持空白，视觉上等价于没接管
  if (live2dActive) img.hidden = true

  try {
    await buildAlphaMap()
    api.log(`alpha 掩码就绪 ${mapW}×${mapH}（来源：${live2dActive ? 'Live2D 画布' : '占位图'}）`)
  } catch (error) {
    api.log(`alpha 掩码构建失败：${error.message} → 退化为整窗可交互`)
    // 送一张全不透明的掩码给主进程，等价于"整窗可交互"，避免完全点不到
    const side = 8
    api.sendMask(side, side, new Uint8Array(side * side).fill(255), visibleUiRects())
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
