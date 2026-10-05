// 独立菜单小窗的桥。只暴露必要的几件事，不开放 node 能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('xilianMenu', {
  /** 主进程在弹出前把要显示的数据推过来（会话列表 + 用量） */
  onData: (callback) => ipcRenderer.on('menu:data', (_event, data) => callback(data)),
  /**
   * 告诉主进程"渲染端监听已就绪，可以补发数据了"。
   *
   * ⚠️ 为什么必须有这一手：`loadFile()` 是**异步**的，主进程 show() 时就 send，
   * 渲染端的监听器还没注册 —— IPC 消息会被直接丢掉，面板里永远是"—"（实测踩到）。
   * 与桌宠窗口的 `pet:ready` 补发是同一类问题。
   */
  ready: () => ipcRenderer.send('menu:ready'),

  /**
   * 插件（SSE）连接状态 —— 从桌宠身上挪到面板里显示的小绿点。
   * 主进程在连接状态变化时推；首次打开时也会随 `menu:data.link` 一起给（见 onData）。
   */
  onLink: (callback) => ipcRenderer.on('menu:link', (_event, link) => callback(link)),

  /** 切换派活目标（只影响桌宠把活派给谁，不动 DSH 界面） */
  selectSession: (sessionId) => ipcRenderer.send('menu:select-session', String(sessionId)),
  /**
   * 输入框是否有未发送内容。
   * 非空时主进程**不会**因失焦收起窗口 —— 否则打了一半的字就没了。
   */
  dirty: (value) => ipcRenderer.send('menu:dirty', Boolean(value)),

  /** 派活 / 打断（真正执行在主进程，它持有 postControl） */
  prompt: (payload) => ipcRenderer.invoke('menu:prompt', payload),
  interrupt: () => ipcRenderer.invoke('menu:interrupt'),
  /** 执行结果回报（成功/失败都走这里，界面只管显示） */
  onResult: (callback) => ipcRenderer.on('menu:result', (_event, result) => callback(result)),

  /** 主动收起（Esc） */
  close: () => ipcRenderer.send('menu:close'),
})
