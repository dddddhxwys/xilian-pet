// 独立菜单小窗 = 桌宠的操作面板。
// 只做三件事：显示数据、把选择发回主进程、管好输入框的键盘行为。
// 真正的动作（派活/打断）由主进程执行（它有 postControl），见 main.js。
const api = window.xilianMenu

const sessionsEl = document.getElementById('sessions')
const inputEl = document.getElementById('input')
const hintEl = document.getElementById('hint')
const tokensEl = document.getElementById('tokens')
const cacheEl = document.getElementById('cache')

let selectedSessionId = null
let hintTimer = null

/** 大数字用人话显示：2.85 亿 比 285000000 好读得多 */
function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`
  return String(Math.round(n))
}

function showHint(text, kind = 'ok') {
  hintEl.textContent = text
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

function renderSessions(data) {
  const list = Array.isArray(data?.sessions) ? data.sessions : []
  selectedSessionId = data?.selectedSessionId ?? null
  sessionsEl.replaceChildren()
  if (list.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'section-label'
    empty.textContent = '（还没有会话）'
    sessionsEl.append(empty)
    return
  }
  for (const s of list) {
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
}

if (api === undefined) {
  // preload 没生效时别静默：把面板描红，一眼看出"桥断了"
  document.getElementById('menu').style.borderColor = '#e2686a'
} else {
  api.onData((data) => {
    renderSessions(data)

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

  sessionsEl.addEventListener('click', (event) => {
    const row = event.target.closest?.('.session')
    if (!row) return
    selectedSessionId = row.dataset.sessionId
    for (const el of sessionsEl.children) {
      if (el.classList?.contains('session')) el.setAttribute('aria-current', String(el === row))
    }
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

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') api.close()
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
