// 设置小窗的渲染端（阶段 2：只显示版本 / 恢复默认）。
// 真正的设置读写都在主进程（settings.js 纯函数 + .state/settings.json），这里只发请求。
const api = window.xilianSettings

const versionEl = document.getElementById('version')
const noteEl = document.getElementById('note')
const noteDefault = noteEl.textContent

/** 把主进程返回的状态画出来（现在只有版本；阶段 4 会在这里渲染滑杆/开关） */
function paint(state) {
  if (!state) return
  versionEl.textContent = `v${state.appVersion}`
}

/** 顶部提示条（"已恢复默认"），1.6s 后恢复原文 */
let noteTimer = null
function flashNote(text) {
  noteEl.textContent = text
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    noteEl.textContent = noteDefault
  }, 1600)
}

document.getElementById('done').addEventListener('click', () => api.close())
document.getElementById('close').addEventListener('click', () => api.close())

document.getElementById('reset').addEventListener('click', async () => {
  try {
    paint(await api.reset())
    flashNote('已恢复默认（大小 1.0 / 不透明度 100% / 镜像关 / 开关全开）')
  } catch (error) {
    flashNote(`恢复默认失败：${error?.message ?? error}`)
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close()
})

api
  .get()
  .then(paint)
  .catch((error) => {
    versionEl.textContent = '读取失败'
    flashNote(`读取设置失败：${error?.message ?? error}`)
  })
