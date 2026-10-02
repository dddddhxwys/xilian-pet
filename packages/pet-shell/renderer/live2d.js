/**
 * 昔涟桌宠 · Live2D 渲染层
 *
 * 职责：加载 Cubism 模型 → 铺满舞台 → 把桌宠状态映射成表情/动作/参数。
 *
 * ── 三个必须知道的技术约束（都是实测踩出来的）────────────────────
 *
 * 1. **模型必须走 `pet://` 协议，不能走 `file://`**
 *    Cubism Core 把 `.moc3` 读成 ArrayBuffer 要经过 fetch/XHR，
 *    而 Chromium 禁止 file:// 页面对 file:// 发 fetch。协议在主进程 main.js 注册。
 *
 * 2. **版本组合是钉死的，不能随手升级**
 *    · 模型是 Cubism 5.0（`.moc3` 版本号 5）
 *    · 官方 Core 的 `MocVersion_50 = 5` 是最新支持上限
 *    · 必须 `pixi.js@7` + `pixi-live2d-display@0.5.0-beta`
 *      （npm 的 `latest` 是 0.4.0/2022 年，配 PixiJS v6 且不感知 moc3 版本）
 *
 * 3. **这个模型没有"情绪表情"，exp3 全是特效开关**
 *    `reset/surprise/spiral/happy/sunglasses/question/ropeOn/ropeOff`
 *    `swingOff/swingOn/swingMid/swingLeft/swingRight`
 *    → 开心、惊喜这些是**道具/卡通特效**，不是眉眼情绪。
 *      眉眼的"情绪"要靠 `ParamBrow*`（8 个参数）自己组合。
 *
 * 命名：挂 window.xilianLive2D。**不要**用 window.pet 之类可能与元素 id 撞名的名字。
 */

/** 各桌宠状态 → 要拉起的表达式 / 参数 */
const STATE_MAP = {
  idle: { expressions: ['reset'] },
  running: { expressions: ['reset'], params: { Param9: 1 } }, // Param9 = 思考
  approval: { expressions: ['reset', 'surprise'] }, // 惊喜 + 待确认
  question: { expressions: ['reset', 'question'] }, // 问号
  done: { expressions: ['reset', 'happy'] }, // 开心
  error: { expressions: ['reset'], params: {} }, // ⚠️ 模型无"困扰"参数，见下方 fallback
}

/** error 档的兜底：模型没有"困扰/失败"参数，用眉毛 + 眼睛手工凑一个皱眉苦脸 */
const ERROR_FACE = {
  ParamBrowLY: -1,
  ParamBrowRY: -1,
  ParamBrowLAngle: -1,
  ParamBrowRAngle: -1,
  ParamBrowLForm: -1,
  ParamBrowRForm: -1,
  ParamEyeLSmile: 0,
  ParamEyeRSmile: 0,
  ParamMouthForm: -1,
}

const state = {
  app: null,
  model: null,
  canvas: null,
  ready: false,
  error: null,
  currentState: null,
  log: () => {},
}

/** 把模型缩放并贴底居中铺进舞台 */
function fit() {
  const { model, canvas } = state
  if (!model || !canvas) return
  const cw = canvas.clientWidth || canvas.width
  const ch = canvas.clientHeight || canvas.height
  const mw = model.width
  const mh = model.height
  if (!mw || !mh) return
  const scale = Math.min(cw / mw, ch / mh)
  model.scale.set(scale)
  // Live2DModel 的 position 是左上角
  model.position.set((cw - mw * scale) / 2, ch - mh * scale)
  state.log(`模型适配 ${mw.toFixed(0)}×${mh.toFixed(0)} → 舞台 ${cw}×${ch}，scale=${scale.toFixed(3)}`)
}

/** 直接写底层 Cubism 参数（模型内部参数 id） */
function setParams(params) {
  const core = state.model?.internalModel?.coreModel
  if (!core) return
  for (const [id, value] of Object.entries(params)) {
    try {
      core.setParameterValueById(id, value)
    } catch (error) {
      state.log(`参数 ${id} 设置失败：${error.message}`)
    }
  }
}

/** 按名字拉起表达式（找得到才拉） */
function setExpressions(names) {
  const model = state.model
  if (!model) return
  const available = new Set((model.internalModel?.settings?.expressions ?? []).map((e) => e.Name))
  for (const name of names) {
    if (!available.has(name)) continue
    try {
      // 先 reset 再叠加，避免上一次的表达式残留
      model.expression(name)
    } catch (error) {
      state.log(`表达式 ${name} 失败：${error.message}`)
    }
  }
}

/**
 * 每帧应用状态参数。
 *
 * ⚠️ 为什么必须挂在 `beforeModelUpdate` 上，而不是用 app.ticker 自己跑：
 *   读 pixi-live2d-display 的 update 流程（从压缩代码里还原）——
 *     emit("beforeMotionUpdate") → motionManager.update()   ← 动作把 37 个参数全写一遍
 *     → expressionManager.update()                          ← 表情在后，所以能压过动作
 *     → eyeBlink（**仅当没有动作播放时**才跑）
 *     → physics / pose
 *     → emit("beforeModelUpdate") → coreModel.update()
 *   所以：
 *     · 用 ticker 写参数会被动作每帧覆写，**根本不生效**；
 *     · `beforeModelUpdate` 是动作/表情/物理都跑完之后、提交渲染之前的最后时机。
 *   另一个后果：**动作在播时库不会自动眨眼**（`if (!motionUpdated) eyeBlink...`），
 *   眨眼由动作自带的 `ParamEyeLOpen` 曲线负责 —— 我们不必也不该另外驱动。
 */
function applyState() {
  const mapped = STATE_MAP[state.currentState] ?? STATE_MAP.idle
  if (mapped.params && Object.keys(mapped.params).length) setParams(mapped.params)
  if (state.currentState === 'error') setParams(ERROR_FACE)
}

/** 初始化：创建 PIXI 应用并加载模型 */
async function init({ canvas, modelUrl, log }) {
  state.canvas = canvas
  state.log = log ?? (() => {})
  if (!window.PIXI?.live2d?.Live2DModel) {
    throw new Error('PIXI.live2d 未就绪 —— vendor 脚本没加载成功？')
  }
  if (typeof Live2DCubismCore === 'undefined') {
    throw new Error('Live2DCubismCore 未就绪 —— live2dcubismcore.min.js 没加载成功？')
  }

  const app = new PIXI.Application({
    view: canvas,
    width: canvas.clientWidth || 260,
    height: canvas.clientHeight || 300,
    backgroundAlpha: 0, // 透明窗，背景必须全透
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    // 必须保留绘制缓冲：alpha 掩码要靠 drawImage(webglCanvas) 取样，
    // 默认 false 时在渲染循环之外读到的是空白（实测坑）。
    preserveDrawingBuffer: true,
  })
  state.app = app

  state.log(`Cubism Core 版本 = ${Live2DCubismCore.Version.csmGetVersion()}`)
  state.log(
    `Core 支持的最新 moc3 版本 = ${Live2DCubismCore.Version.csmGetLatestMocVersion()}（5 = Cubism 5.0）`,
  )

  // autoHitTest / autoFocus 关掉：命中测试我们自己用 alpha 掩码做，
  // 而且模型**没有声明 HitAreas**（实测），库的 hitTest 本来也测不出东西。
  // 注：v0.5.0 起 autoInteract 已废弃，拆成这两个选项。
  const model = await PIXI.live2d.Live2DModel.from(modelUrl, { autoHitTest: false, autoFocus: false })
  state.model = model
  app.stage.addChild(model)

  state.log(`模型已加载：${model.width.toFixed(0)}×${model.height.toFixed(0)}`)
  const groups = model.internalModel?.settings?.groups ?? []
  for (const g of groups) state.log(`  分组 ${g.Name}: ${(g.Ids ?? []).join(', ') || '(空)'}`)
  const exprs = model.internalModel?.settings?.expressions ?? []
  state.log(`  表达式 ${exprs.length} 个：${exprs.map((e) => e.Name).join(', ')}`)
  const motions = Object.entries(model.internalModel?.settings?.motions ?? {})
  for (const [g, arr] of motions) state.log(`  动作组 ${g}: ${arr.length} 个`)

  fit()

  // 状态参数挂在每帧的最后时机（见 applyState 上方注释）
  model.internalModel.on('beforeModelUpdate', applyState)

  // 待机动作：Scene 组，循环播放
  try {
    model.motion('Scene', 0, PIXI.live2d.MotionPriority.IDLE)
    state.log('已启动待机动作 Scene[0]（循环）')
  } catch (error) {
    state.log(`启动动作失败：${error.message}`)
  }

  state.ready = true
  return model
}

/** 切换桌宠状态 */
function setState(next) {
  if (next === state.currentState) return
  state.currentState = next
  const mapped = STATE_MAP[next] ?? STATE_MAP.idle
  state.log(`状态 → ${next}`)
  setExpressions(mapped.expressions ?? ['reset'])
  if (mapped.params && Object.keys(mapped.params).length) setParams(mapped.params)
}

/** 导出给 pet.js 用的接口 */
window.xilianLive2D = {
  init,
  setState,
  fit,
  /** 供 alpha 掩码取样用的渲染画布（空白表示不可交互） */
  getCanvas: () => state.canvas,
  get isReady() {
    return state.ready
  },
  get error() {
    return state.error
  },
  get info() {
    return {
      ready: state.ready,
      state: state.currentState,
      modelSize: state.model ? [state.model.width, state.model.height] : null,
    }
  },
}
