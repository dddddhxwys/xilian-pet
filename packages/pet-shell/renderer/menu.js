// 独立菜单小窗 = 桌宠的操作面板。
// 只做三件事：显示数据、把选择发回主进程、管好输入框的键盘行为
// （外加第四件：画头部的峰谷胶囊）。
// 真正的动作（派活/打断）由主进程执行（它有 postControl），见 main.js。
//
// ⚠️ 本文件是 **ES 模块**（menu.html 里是 type="module"），因为峰谷判定要 import 纯函数模块 ——
//    判定逻辑放 peak-time.js 才能被 tools/check-plugin.mjs 直接测（本仓库的老规矩：
//    观感靠实机、逻辑靠断言）。CSP 是 `script-src 'self'`，同目录 import 不用改 CSP。
import { HOLIDAYS } from './holidays.js'
import { buildHolidaySet, beijingParts, peakStatus } from './peak-time.js'

const api = window.xilianMenu

const targetEl = document.getElementById('target')
const targetTitle = document.getElementById('targetTitle')
const sessionsEl = document.getElementById('sessions')
const inputEl = document.getElementById('input')
const hintEl = document.getElementById('hint')
const tokensEl = document.getElementById('tokens')
const cacheEl = document.getElementById('cache')
const linkStateEl = document.getElementById('linkState')
// 峰谷胶囊（头部的 span#peak），数据不是主进程给的，是本机时间算的
const peakEl = document.getElementById('peak')
const peakTextEl = document.getElementById('peakText')
const holidaySet = buildHolidaySet(HOLIDAYS)

let selectedSessionId = null
let sessionRows = []
let hintTimer = null
let lastPeak = null

const hhmm = (minutesOfDay) =>
  `${String(Math.floor(minutesOfDay / 60)).padStart(2, '0')}:${String(minutesOfDay % 60).padStart(2, '0')}`

/**
 * 峰谷胶囊：此刻是 DeepSeek 的峰价还是空闲价 + 距离下次切换还有多久。
 *
 * 判定/倒计时全在 peak-time.js（纯函数，有自测），这里只负责画和打日志。
 * 文案刻意只有「峰/闲 · N 后切换」两种长度，因为胶囊在头部行里，宽度有限
 * （面板 300px：头像 24 + 名字 + 胶囊 + ⚙ 22，胶囊最多 ~158px）。
 */
function renderPeak() {
  const status = peakStatus(Date.now(), holidaySet)
  peakEl.dataset.peak = status.peak ? 'on' : 'off'
  peakTextEl.textContent =
    status.countdown === '' ? status.label : `${status.label} · ${status.countdown} 后切换`

  const price = status.peak ? '高峰时段（单价是空闲时段的 2 倍）' : '空闲时段（单价是高峰的一半）'
  const lines = [
    `DeepSeek ${price}`,
    '规则：北京时间 周一至周五（不含法定节假日）9:00-12:00、14:00-18:00 为高峰，其余为空闲',
  ]
  if (status.nextAt !== null) {
    const p = beijingParts(status.nextAt)
    lines.push(`下次切换：${p.dateKey} ${hhmm(p.minutes)}（${status.peak ? '转空闲' : '转高峰'}）`)
  }
  if (!status.covered) lines.push(`⚠️ 节假日表没有 ${status.year} 年，暂按"周一至周五"判断`)
  peakEl.title = lines.join('\n')

  // 只在翻转时打日志：pet.log 里能对上"到底几点变的"，不用猜
  if (lastPeak !== status.peak) {
    console.log(`峰谷：${status.label}${status.countdown === '' ? '' : `（${status.countdown} 后切换）`}`)
    lastPeak = status.peak
  }
  if (!status.covered) {
    console.warn(`峰谷：节假日表没有 ${status.year} 年，暂按"周一至周五"判断 —— 该更新 renderer/holidays.js 了`)
  }
}

/** 大数字用人话显示：2.85 亿 比 285000000 好读得多 */
function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`
  return String(Math.round(n))
}

/**
 * 插件（SSE）连接状态 —— 从桌宠身上挪到面板里的小绿点。
 *
 * 用户 2026-10-05："把那个表示插件在线的小绿点整合到菜单里面去"。
 * 状态语义沿用桌宠上那个点：`link.connected` = 插件在线 ✓
 * 文案不用"在线/离线"而用"已连接/未连接"，和原来那个点的 tooltip 保持一致。
 */
function renderLink(link) {
  const up = link?.connected === true
  linkStateEl.dataset.link = up ? 'up' : 'down'
  linkStateEl.textContent = up ? '已连接' : '未连接'
  linkStateEl.title = up ? `已连接 ${link?.url ?? ''}` : `未连接${link?.error ? `：${link.error}` : ''}`
}

function showHint(text, kind = 'ok') {  hintEl.textContent = text
  hintEl.dataset.kind = kind
  hintEl.hidden = false
  clearTimeout(hintTimer)
  // 成功的一秒后淡出；失败留着，让你看清原因
  if (kind === 'ok') hintTimer = setTimeout(() => (hintEl.hidden = true), 1500)
}

/** 输入框是否非空 —— 非空时主进程不会因失焦把窗口收掉（否则打了一半的字就没了） */
function reportDirty() {
  api?.dirty(inputEl.value.trim() !== '')
}

/** 展开/折叠会话列表。折叠态只留一行当前目标（用户要求"折叠起来"）。 */
function setExpanded(expanded) {
  sessionsEl.hidden = !expanded
  targetEl.setAttribute('aria-expanded', String(expanded))
  // 把**实际计算样式**打出来：透明窗抓图不稳定（Current display surface not available），
  // 而"折叠到底有没有生效"恰恰是踩过的坑（[hidden] 被 display:flex 覆盖）——
  // 日志里的 display 值比截图更可靠。
  console.log(`会话列表 ${expanded ? '展开' : '折叠'} → hidden=${sessionsEl.hidden} display=${getComputedStyle(sessionsEl).display}`)
}

/** 折叠态那一行显示的是**当前选中的目标** */
function renderTarget() {
  const row = sessionRows.find((s) => s.sessionId === selectedSessionId) ?? sessionRows[0]
  targetTitle.textContent = row?.title || row?.sessionId || '（还没有会话）'
  targetTitle.title = row?.sessionId ?? ''
  // 状态点颜色靠 data-state（CSS 里是 [data-state="running"] .dot）
  targetEl.dataset.state = row?.state ?? 'idle'
}

function renderSessions(data) {
  sessionRows = Array.isArray(data?.sessions) ? data.sessions : []
  selectedSessionId = data?.selectedSessionId ?? null
  sessionsEl.replaceChildren()

  for (const s of sessionRows) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'session'
    row.dataset.sessionId = s.sessionId
    row.dataset.state = s.state ?? 'idle'
    row.setAttribute('aria-current', String(s.sessionId === selectedSessionId))
    row.title = s.sessionId

    const dot = document.createElement('span')
    dot.className = 'dot'
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = s.title || s.sessionId
    row.append(dot, title)
    if (s.unread) {
      const badge = document.createElement('span')
      badge.className = 'unread'
      badge.textContent = '+'
      row.append(badge)
    }
    sessionsEl.append(row)
  }

  renderTarget()
  setExpanded(false) // 每次打开都是折叠态：列表只在你要切的时候才展开
}

if (api === undefined) {
  // preload 没生效时别静默：把面板描红，一眼看出"桥断了"
  document.getElementById('menu').style.borderColor = '#e2686a'
} else {
  api.onData((data) => {
    renderSessions(data)
    // 首次打开时 link 随数据一起来（主进程补发），之后靠 onLink 增量更新
    renderLink(data?.link)

    const t = data?.tokens
    tokensEl.textContent = formatTokens(t?.spendTokens)
    const rate = t?.cacheHitRate
    cacheEl.textContent = typeof rate === 'number' ? `${(rate * 100).toFixed(1)}%` : '—'
    // 数据来源放 tooltip：数字看着离谱时第一眼能判断是不是取错了源
    tokensEl.title = t?.tokenSource === 'host' ? '来源：宿主（重启不丢）' : '来源：插件自算'

    if (data?.focusInput) inputEl.focus()
  })

  // 监听已注册 → 让主进程补发数据（loadFile 是异步的，它先前发的那次会丢）
  api.ready()

  // 插件连接状态变化（主进程推）—— 面板开着时能实时变绿/变红
  api.onLink((link) => renderLink(link))

  // 点折叠态那一行 = 展开 / 收起列表
  targetEl.addEventListener('click', () => setExpanded(sessionsEl.hidden))

  sessionsEl.addEventListener('click', (event) => {
    const row = event.target.closest?.('.session')
    if (!row) return
    selectedSessionId = row.dataset.sessionId
    for (const el of sessionsEl.children) {
      if (el.classList?.contains('session')) el.setAttribute('aria-current', String(el === row))
    }
    renderTarget()
    setExpanded(false) // 选完就收起来，别一直占地方
    api.selectSession(selectedSessionId)
    showHint('已切换派活目标')
  })

  inputEl.addEventListener('input', reportDirty)

  // Enter 发送 / Shift+Enter 换行（用户指定）。
  // 用 keydown 而不是 form submit：textarea 里 Enter 默认是换行，必须自己拦。
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })

  document.getElementById('send').addEventListener('click', send)
  document.getElementById('interrupt').addEventListener('click', async () => {
    const result = await api.interrupt()
    showHint(result?.status === 200 ? '已打断' : `打断失败（${result?.status ?? '?'}）`, result?.status === 200 ? 'ok' : 'error')
  })

  // 右上角 ⚙ → 打开独立的设置窗（设置项不铺进面板）
  document.getElementById('settingsBtn').addEventListener('click', () => api.openSettings())

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') api.close()
  })

  // 窗口比卡片大一圈（留给阴影淡出），那一圈是**透明的但可点**：
  // 点在那里既不会触发 blur 也不会点到卡片 → 看起来"点了没反应"。
  // 所以把卡片外的点击当作"点外面"→ 关面板（和失焦收起同一个语义）。
  document.addEventListener('mousedown', (event) => {
    const card = document.getElementById('menu')
    if (card && !card.contains(event.target)) api.close()
  })

  // 主进程执行完动作后回报结果（成功/失败都走这里，界面只管显示）
  api.onResult((result) => {
    if (result?.action === 'prompt') {
      if (result.status === 200) {
        inputEl.value = ''
        reportDirty()
        inputEl.focus() // 发完留着，方便连发
        showHint('已派活')
      } else {
        showHint(`派活失败（${result.status}）：${result.message ?? '未知原因'}`, 'error')
      }
    }
  })
}

async function send() {
  const text = inputEl.value.trim()
  if (text === '') {
    inputEl.focus()
    return
  }
  // 先清空再发：失败时靠 hint 提示，不把文字留在框里让你以为发出去了
  inputEl.value = ''
  reportDirty()
  showHint('正在派活…')
  await api.prompt({ text, sessionId: selectedSessionId })
}

// ── 峰谷胶囊什么时候重算 ─────────────────────────────────────────────
// 面板窗口是**复用**的（main.js 失焦只 hide() 不销毁），所以两个时机都要管：
//  · 每次重新弹出 → document.hidden 由 true 变 false → visibilitychange 里重算（否则会看到上次的旧值）
//  · 面板一直开着跨过 9:00 / 12:00 / 14:00 / 18:00 → 30s 轮询兜住（隐藏时直接 return，开销可忽略）
renderPeak()
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) renderPeak()
})
setInterval(() => {
  if (!document.hidden) renderPeak()
}, 30_000)
