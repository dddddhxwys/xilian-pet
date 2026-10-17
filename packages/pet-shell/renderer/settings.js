// 设置小窗的渲染端。
// 真正的设置读写都在主进程（settings.js 纯函数 + .state/settings.json），这里只发请求。
const api = window.xilianSettings

const versionEl = document.getElementById('version')
const scaleEl = document.getElementById('scale')
const scaleValEl = document.getElementById('scaleVal')
const opacityEl = document.getElementById('opacity')
const opacityValEl = document.getElementById('opacityVal')
const mirrorEl = document.getElementById('mirror')
const autoFaceEl = document.getElementById('autoFace')
const noteEl = document.getElementById('note')
const noteDefault = noteEl.textContent

const fmtScale = (value) => `${Number(value).toFixed(2)}×`
const fmtPercent = (value) => `${Math.round(Number(value) * 100)}%`

/**
 * 把主进程返回的状态画出来。
 * ⚠️ 控件的值**必须**用主进程规范化后的值回填（它会把越界值夹回范围内），
 *    否则界面和真实设置会分叉。
 */
function paint(state) {
  if (!state) return
  versionEl.textContent = `v${state.appVersion}`
  const { scale = 1, opacity = 1, mirror = false, autoFace = true } = state.settings?.appearance ?? {}
  scaleEl.value = String(scale)
  scaleValEl.textContent = fmtScale(scale)
  opacityEl.value = String(opacity)
  opacityValEl.textContent = fmtPercent(opacity)
  mirrorEl.checked = mirror === true
  autoFaceEl.checked = autoFace === true
  // 自动朝向开着时，手动翻转会被覆盖 —— 界面上说清楚，避免"点了没反应"
  mirrorEl.closest('.row').classList.toggle('muted', autoFaceEl.checked)
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

// ── 滑杆：拖动时只改数字，停 120ms 再写盘（避免每移动 1px 就写一次文件）──
/** 给一个 range 输入接上"防抖写盘"：onPaint 负责把主进程规范化后的值回填 */
function wireSlider(input, valueEl, format, field, onDone) {
  let timer = null
  input.addEventListener('input', () => {
    const value = Number(input.value)
    valueEl.textContent = format(value)
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        paint(await api.patch({ appearance: { [field]: value } }))
        onDone?.()
      } catch (error) {
        flashNote(`保存失败：${error?.message ?? error}`)
      }
    }, 120)
  })
}

wireSlider(scaleEl, scaleValEl, fmtScale, 'scale')
wireSlider(opacityEl, opacityValEl, fmtPercent, 'opacity', () => flashNote('不透明度已更新'))

// ── 开关（左右翻转 / 自动朝向）──────────────────────────────────────
/** 给一个 checkbox 接上"改动即写盘 + 回填" */
function wireToggle(input, field, onDone) {
  input.addEventListener('change', async () => {
    try {
      paint(await api.patch({ appearance: { [field]: input.checked } }))
      onDone?.()
    } catch (error) {
      flashNote(`保存失败：${error?.message ?? error}`)
    }
  })
}

wireToggle(mirrorEl, 'mirror', () => flashNote(mirrorEl.checked ? '已左右翻转' : '已恢复朝向'))
wireToggle(autoFaceEl, 'autoFace', () => flashNote(autoFaceEl.checked ? '自动朝向已开启' : '自动朝向已关闭（可用手动翻转）'))

document.getElementById('reset').addEventListener('click', async () => {
  try {
    paint(await api.reset())
    flashNote('已恢复默认（大小 1.0× / 不透明度 100%）')
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
