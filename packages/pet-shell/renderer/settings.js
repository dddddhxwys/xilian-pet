// 设置小窗的渲染端。
// 真正的设置读写都在主进程（settings.js 纯函数 + .state/settings.json），这里只发请求。
const api = window.xilianSettings

const versionEl = document.getElementById('version')
const scaleEl = document.getElementById('scale')
const scaleValEl = document.getElementById('scaleVal')
const noteEl = document.getElementById('note')
const noteDefault = noteEl.textContent

const fmtScale = (value) => `${Number(value).toFixed(2)}×`

/**
 * 把主进程返回的状态画出来。
 * ⚠️ 滑杆值**必须**用主进程规范化后的值回填（它会把越界值夹回 0.6–1.6），
 *    否则界面和真实设置会分叉。
 */
function paint(state) {
  if (!state) return
  versionEl.textContent = `v${state.appVersion}`
  const scale = state.settings?.appearance?.scale ?? 1
  scaleEl.value = String(scale)
  scaleValEl.textContent = fmtScale(scale)
}

/** 顶部提示条，1.6s 后恢复原文 */
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

// ── 大小滑杆 ────────────────────────────────────────────────────────
// 拖动时先只改数字（不写盘），停 120ms 再发请求 —— 避免每移动 1px 就写一次文件。
let patchTimer = null
scaleEl.addEventListener('input', () => {
  const value = Number(scaleEl.value)
  scaleValEl.textContent = fmtScale(value)
  clearTimeout(patchTimer)
  patchTimer = setTimeout(async () => {
    try {
      paint(await api.patch({ appearance: { scale: value } }))
    } catch (error) {
      flashNote(`保存失败：${error?.message ?? error}`)
    }
  }, 120)
})

document.getElementById('reset').addEventListener('click', async () => {
  try {
    paint(await api.reset())
    flashNote('已恢复默认（大小 1.0×）')
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
