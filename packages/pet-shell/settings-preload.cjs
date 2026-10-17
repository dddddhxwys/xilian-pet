// 设置小窗的桥。只暴露必要的四件事，不开放 node 能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('xilianSettings', {
  /** 读取当前状态：{ appVersion, settings } */
  get: () => ipcRenderer.invoke('settings:get'),
  /** 局部更新（阶段 4 的滑杆/开关用；现在只有恢复默认会用到） */
  patch: (partial) => ipcRenderer.invoke('settings:patch', partial),
  /** 全部恢复默认 */
  reset: () => ipcRenderer.invoke('settings:reset'),
  /** 关闭设置窗（✕ / 完成 / Esc） */
  close: () => ipcRenderer.send('settings:close'),
})
