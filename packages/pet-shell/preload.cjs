// 预加载桥：只暴露桌宠需要的几件事，不开放 node 能力。
//
// 注意命名：必须避开任何元素的 id —— HTML 里 id="pet" 的元素会自动创建 window.pet，
// 与 exposeInMainWorld('pet', …) 撞名会让渲染端脚本直接 SyntaxError 而完全不执行
// （实测踩过：整页 JS 静默失效，只有截图和 console 诊断能发现）。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('xilianPet', {
  /** 订阅 Host 插件推送的帧（state / stream / snapshot / hello / notice / control） */
  onFrame: (callback) => ipcRenderer.on('pet:frame', (_event, frame) => callback(frame)),
  /** 连接状态变化 */
  onLink: (callback) => ipcRenderer.on('pet:link', (_event, link) => callback(link)),
  /** 命中测试结果：是否让窗口接管鼠标（false = 继续穿透） */
  setInteractive: (interactive) => ipcRenderer.send('pet:set-interactive', Boolean(interactive)),
  /** 拖拽：按屏幕坐标增量移动窗口 */
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', Math.round(dx), Math.round(dy)),
  /** 反向操控：prompt / interrupt / focus */
  control: (action, payload) => ipcRenderer.invoke('pet:control', action, payload),
  log: (message) => ipcRenderer.send('pet:log', String(message)),
  quit: () => ipcRenderer.send('pet:quit'),
})
