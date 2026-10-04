// 独立菜单小窗的渲染逻辑。刻意极简：只有"显示数据 + 把选择发回去"两件事，
// 真正的动作（派活 / 打断）都由桌宠窗口执行，见 pet.js 的 onMenuAction。
const api = window.xilianMenu
const tokensEl = document.getElementById('tokens')
const cacheEl = document.getElementById('cache')

/** 大数字用人话显示：2.65 亿 比 265000000 好读得多 */
function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`
  return String(Math.round(n))
}

if (api === undefined) {
  // preload 没生效时别静默：至少把面板画出来，能看出"桥断了"
  document.getElementById('menu').style.borderColor = '#e2686a'
} else {
  api.onData((data) => {
    const t = data?.tokens
    tokensEl.textContent = formatTokens(t?.spendTokens)
    const rate = t?.cacheHitRate
    cacheEl.textContent = typeof rate === 'number' ? `${(rate * 100).toFixed(1)}%` : '—'
    // 数据来源放在 tooltip：数字看着离谱时第一眼能判断是不是取错了源
    tokensEl.title = t?.tokenSource === 'host' ? '来源：宿主（重启不丢）' : '来源：插件自算'
  })

  // 监听已注册 → 让主进程补发数据（loadFile 是异步的，它先前发的那次会丢）
  api.ready()

  document.getElementById('menu').addEventListener('click', (event) => {
    const item = event.target.closest?.('.item')
    if (item) api.choose(item.dataset.action)
  })

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') api.close()
  })
}
