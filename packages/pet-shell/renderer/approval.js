// 审批小窗。只做三件事：显示审批内容、把决定发回主进程、在解决后自动消失。
// 动作由主进程执行（它持有 postControl），见 main.js。
const api = window.xilianApproval

const titleEl = document.getElementById('title')
const commandEl = document.getElementById('command')
const reasonEl = document.getElementById('reason')
const hintEl = document.getElementById('hint')

/** 当前审批 id —— 决定要带上它，主进程据此回审批链 */
let currentId = null
let decided = false

function render(frame) {
  currentId = typeof frame?.id === 'string' ? frame.id : null
  decided = false
  titleEl.textContent = frame?.toolName ? `agent 想执行 ${frame.toolName}` : 'agent 想执行一个操作'
  const command = typeof frame?.command === 'string' && frame.command !== '' ? frame.command : ''
  commandEl.textContent = command !== '' ? command : '（拿不到命令原文，放行前请谨慎）'
  commandEl.title = command
  const reason = typeof frame?.reason === 'string' ? frame.reason : ''
  reasonEl.textContent = reason
  reasonEl.hidden = reason === ''
  // 倒计时按用户要求去掉了 —— 只说"不处理会自动交回 DSH"，不给秒数压力
  hintEl.textContent = '不处理的话，60 秒后会自动交回 DSH 界面'
}

function decide(decision) {
  if (currentId === null || decided) return
  decided = true
  // 先把按钮禁用：防止连点导致"允许 + 拒绝"都发出去
  for (const el of document.querySelectorAll('button')) el.disabled = true
  api.decide({ id: currentId, decision })
}

if (api === undefined) {
  document.getElementById('card').style.borderColor = '#e2686a'
} else {
  api.onApproval((frame) => render(frame))
  // 主进程执行完（或超时交棒）会回报结果 → 关掉自己
  api.onResult(() => window.close())
  document.getElementById('allow').addEventListener('click', () => decide('allow'))
  document.getElementById('deny').addEventListener('click', () => decide('deny'))
  // 页面就绪 → 让主进程补发内容（loadFile 是异步的，先发的那次会丢）
  api.ready()
}
