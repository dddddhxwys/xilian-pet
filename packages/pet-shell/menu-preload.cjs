// 独立菜单小窗的桥。只暴露三件事，不开放 node 能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('xilianMenu', {
  /** 主进程在弹出前把要显示的数据推过来 */
  onData: (callback) => ipcRenderer.on('menu:data', (_event, data) => callback(data)),
  /**
   * 告诉主进程"渲染端监听已就绪，可以补发数据了"。
   *
   * ⚠️ 为什么必须有这一手：`loadFile()` 是**异步**的，主进程 show() 时就 send，
   * 渲染端的监听器还没注册 —— IPC 消息会被直接丢掉，菜单里永远是"—"（实测踩到）。
   * 与桌宠窗口的 `pet:ready` 补发是同一类问题。
   */
  ready: () => ipcRenderer.send('menu:ready'),
  /** 选了哪一项（'prompt' | 'interrupt'）—— 由主进程转给桌宠窗口去执行 */
  choose: (action) => ipcRenderer.send('menu:choose', String(action)),
  /** 主动收起（Esc） */
  close: () => ipcRenderer.send('menu:close'),
})
