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
  /**
   * 把 alpha 掩码交给主进程做命中测试。
   * 为什么不在渲染端判断：见 main.js 顶部关于 Electron Windows 鼠标转发 bug 的说明。
   * 掩码请先降采样（主进程按比例取样，不需要全分辨率）。
   * `uiRects` 是 HTML 控件（输入条/气泡）的矩形 —— 它们不在掩码里，
   * 不一起送过去的话，控件上"没有角色像素"的部分会被判成穿透、按钮点不动。
   * `stage` 是**渲染端自己的坐标系尺寸**（window.innerWidth/innerHeight）。
   * ⚠️ 必须送：主进程原来拿 `win.getBounds()` 当映射基准，但那是**窗口**的坐标系 ——
   *    实测某台 150% 缩放的机器上窗口被系统撑到 1248×1124，而渲染端舞台仍是 260×300，
   *    于是 130×150 的掩码被拉伸铺满整个大窗口
   *    → "远离昔涟反而能拖、在她身上拖不动"。
   */
  sendMask: (width, height, data, uiRects, stage) =>
    ipcRenderer.send('pet:mask', { width, height, data, uiRects, stage }),
  /** 拖拽中：主进程会一直保持可交互，避免鼠标快速移出角色时把拖拽甩掉 */
  setDragging: (value) => ipcRenderer.send('pet:dragging', Boolean(value)),
  /**
   * 主进程**放弃**了拖拽态（看门狗判卡住 / 失焦）。
   * 渲染端必须同步清零自己的 dragging —— 否则两边状态分叉：
   * 主进程已恢复穿透判定、渲染端还以为在拖，于是她要么在松开鼠标后继续跟着鼠标跑，
   * 要么反过来怎么拖都不动。
   */
  onDragCancel: (callback) => ipcRenderer.on('pet:drag-cancel', (_event, reason) => callback(String(reason ?? ''))),
  /** 构图缓存读写（按模型 URL 分开存） */
  fitCacheGet: (modelKey) => ipcRenderer.invoke('pet:fit-cache-get', modelKey),
  fitCacheSet: (modelKey, box) => ipcRenderer.invoke('pet:fit-cache-set', modelKey, box),
  /**
   * 通知主进程"构图已就绪"。
   * 主进程会等到这个信号才显示窗口 —— 否则会先按保底尺寸显示，
   * 约 3 秒后测量完成再跳一下（用户实测报的"打开一会突然变大"）。
   */
  fitReady: () => ipcRenderer.send('pet:fit-ready'),
  /** 拖拽：按屏幕坐标增量移动窗口 */
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', Math.round(dx), Math.round(dy)),
  /** 反向操控：prompt / interrupt / focus */
  control: (action, payload) => ipcRenderer.invoke('pet:control', action, payload),
  /** A7：把 DSH 窗口唤到前台（点击通知时用） */
  focusDsh: () => ipcRenderer.invoke('pet:focus-dsh'),
  /**
   * 操作面板：请主进程在桌宠**旁边**弹出独立小窗（含会话切换 + 多行输入 + 派活/打断 + 用量）。
   * 为什么不在本窗口里画：她本体占满 260×300，画在里面必然遮住她 ——
   * 原来的底部输入条就压着她的裙摆和脚（实测重叠 28px），已整个删除。
   * @param {{focusInput?:boolean, tokens?:object}} payload focusInput=true 时把光标放进输入框
   */
  openMenu: (payload) => ipcRenderer.invoke('pet:open-menu', payload ?? {}),
  /** 面板执行完动作后的提示文案 → 用气泡显示（动作在主进程执行，它回报过来） */
  onBubble: (callback) => ipcRenderer.on('pet:bubble', (_event, text) => callback(String(text))),
  /** Live2D 模型信息：{ dir, exists, url } —— url 走 pet:// 协议，避开 file:// 的 fetch 限制 */
  modelInfo: () => ipcRenderer.invoke('pet:model-info'),
  /** 请主进程立刻截一张自检截图（用于精确捕捉动作的关键帧） */
  snapshotNow: () => ipcRenderer.send('pet:snapshot-now'),
  /** 通知主进程：渲染端 handler 已注册完毕，可以补发最近状态了 */
  ready: () => ipcRenderer.send('pet:ready'),
  log: (message) => ipcRenderer.send('pet:log', String(message)),
  quit: () => ipcRenderer.send('pet:quit'),
})
