// 审批小窗的桥。只暴露必要几件事，不开放 node 能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('xilianApproval', {
  /** 主进程把待审批内容推过来 */
  onApproval: (callback) => ipcRenderer.on('approval:data', (_event, frame) => callback(frame)),
  /**
   * 告诉主进程"监听已就绪，可以补发内容了"。
   * ⚠️ loadFile 是异步的：主进程 show 时就 send 的那次会因页面未加载而丢
   * （操作面板就踩过这个坑，面板里一直显示"—"）。
   */
  ready: () => ipcRenderer.send('approval:ready'),
  /** 提交决定（'allow' | 'deny'）—— 真正回审批链的事在主进程 */
  decide: (payload) => ipcRenderer.send('approval:decide', payload),
  /** 主进程处理完（或超时交棒）→ 关窗 */
  onResult: (callback) => ipcRenderer.on('approval:result', (_event, result) => callback(result)),
})
