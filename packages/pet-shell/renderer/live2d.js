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
 * 命名：挂 window.xilianLive2D（仅便于在 devtools 里调试；实际由 pet.js 动态 import）。
 *
 * ⚠️ 本文件是 **ES 模块**（由 pet.js 用 `await import('./live2d.js')` 加载）。
 *    为什么必须是模块：它和 pet.js 都曾是普通 <script>，**共享同一个全局作用域** ——
 *    实测踩过两次：
 *      1. `const ALPHA_THRESHOLD` 两边都写 → `SyntaxError: Identifier ... has already
 *         been declared` → **pet.js 整个不执行**（整页静默失效）
 *      2. `function setState` 两边都有 → 函数声明**静默互相覆盖**（更危险，不报错）
 *    模块自带作用域，从根上杜绝这类撞名。
 *    用动态 import（而不是静态 import）是刻意的：静态 import 一旦失败会连 pet.js 一起
 *    不执行，降级到占位图（验收项 A10）就没了。
 */

/**
 * 各桌宠状态 → 动作 / 表达式 / 参数。
 *
 * ⚠️ 四个动作原本都叫 `Scene1~4`，名字看不出内容。这里的对应关系是靠
 * **参数采样 + 高光时刻截图**反推出来的（`PET_SAMPLE_PARAMS=1` / `PET_SNAPSHOT_AT_MOTION_MS`），
 * 依据是各动作独有的"特效开关"参数与画面表现：
 *
 *   Scene[0] 3s   → Param15 嘻嘻 + Param5 星星 + Param12 手指
 *                    画面：双手抬到胸前的小动作 + 细碎亮点
 *   Scene[1] 4s   → Param7 闪耀 + Param17/18 叉腰1/2
 *                    画面：闭眼笑 + 张嘴 + 周围明显星光
 *   Scene[2] 3s   → Param10/11 招牌1/2 + 嘴开闭 + 角度X 甩到 -25°
 *                    画面：摆招牌姿势 + 张嘴说话
 *   Scene[3] 180s → Param13/14 秋千1/2 + Param31 秋千特殊 + Param32 秋千开关
 *                    画面：秋千明显倾斜摆动、腿鞋摇晃满量程（±30°）
 */
// 状态→动作映射、动作播完后的决策、参数切换计划 —— 全在纯模块里，
// 好让自测脱离 Electron 也能直接断言（本文件依赖 PIXI 全局，Node 里 import 不了）。
import {
  BASE_MOTION,
  INTRO_MOTION,
  STATE_MAP,
  decideOnMotionFinish,
  fadeProps,
  planParamTransition,
  propFadePhases,
} from './motion-policy.js'

/**
 * ⚠️ 这个模型同一时刻**只能有一个表情生效** ——
 * `model.expression(name)` 是"替换当前表情"，不是叠加。
 * 所以 STATE_MAP 里存的是**单个** expression 名，不要写成数组（写过，是误导）。
 * 需要多个效果同时开时，得用 `params` 直接驱动参数（如 running 的 Param9）。
 */

/** 上一次由 `params` 直接写入的参数 —— 切状态时要把不在新状态里的清零（见 planParamTransition） */
let appliedParams = {}


/**
 * 开场手势的播放速度。用户反馈"比嘘的手放得太快"——
 * 原速 3 秒里手势只维持约 1.5 秒、放下只用 0.85 秒，太赶。
 * 放慢到 0.6 倍后：抬起约 1.05s、维持约 2.5s、放下约 1.4s，从容得多。
 */
const INTRO_SPEED = 0.6
/** 开场手势是否还在演（演完/被打断后置 false） */
let introPending = true
/**
 * 这些状态是"立刻要你注意"的，可以**打断**开场手势；
 * 其余状态（idle/running/question/done…）都排队等手势演完再应用 ——
 * 否则 agent 正在干活（running）时启动，开场手势会被立刻掐掉，等于没做。
 */
const INTRO_INTERRUPT = new Set(['approval', 'error'])
/** 开场手势期间到达的状态，记下来，演完再应用 */
let stateWaitingIntro = null

/**
 * 需要**我们自己接管**眨眼的动作 —— 其余动作自己会演眼睛。
 *
 * 为什么只有 Scene[3]：它是 180 秒的荡秋千长循环，但**只在前 2.2 秒驱动眼睛**
 * （参数采样实测 `ParamEyeLOpen 活动 0.04~2.21s`），之后冻结在闭眼值；
 * 而库的自动眨眼条件是 `if (!motionUpdated)`（有动作在播就不跑），
 * 两件事叠加 → 待机时眼睛一直闭着。所以这个动作需要我们接管。
 *
 * 反过来，Scene[0]/[1]/[2] **全程**都在驱动眼睛（`活动 0.0x~4.5s`），
 * 让它们自己演才对。我们插进去会把动作设计的眼神盖掉 ——
 * 用户反馈的"比嘘的时候眼睛没动作"就是这个：
 * Scene[0] 本来是个**半眯眼的保密表情**，被我们强行写成睁眼 + 自己的眨眼节拍。
 * （第一版把这个集合写反了：只排除 Scene[1]，其余全接管 —— 那是错的。）
 */
const EYE_IDLE_MOTIONS = new Set([3])

// ── 眨眼 ────────────────────────────────────────────────────────────
// ⚠️ 为什么必须自己实现（这是实测踩出来的 bug）：
//   库的自动眨眼条件是 `if (!motionUpdated) eyeBlink.updateParameters(...)`
//   —— **只有没有动作播放时才眨眼**。而我们待机用的是 Scene[3]（180 秒循环），
//   动作永远在播 → 自动眨眼永远不跑。
//   更糟的是 Scene[3] **只在前 2.2 秒驱动眼睛**（参数采样实测：
//   `ParamEyeLOpen 范围 0.00~1.00 活动 0.04~2.21s`），之后冻结在闭眼值，
//   于是待机时眼睛一直闭着。
//   所以挂在 `beforeModelUpdate`（动作之后）自己输出眨眼值，把眼睛接管过来。
const BLINK_MS = 140 // 单次眨眼时长
const BLINK_GAP_MIN_MS = 2400 // 两次眨眼的间隔（随机，避免机械节拍）
const BLINK_GAP_MAX_MS = 6200

let blinkStartAt = 0 // 本次眨眼开始时刻；0 = 当前没在眨
let nextBlinkAt = 0

/** 每帧输出眼睛开合（1 = 睁，0 = 闭）。仅用于"自己不驱动眼睛"的动作 */
function applyBlink(now) {
  // 动作自己在演眼睛时让位（见 EYE_IDLE_MOTIONS 注释）
  if (!EYE_IDLE_MOTIONS.has(currentMotion)) return

  if (blinkStartAt === 0 && now >= nextBlinkAt) {
    blinkStartAt = now
    nextBlinkAt = now + BLINK_GAP_MIN_MS + Math.random() * (BLINK_GAP_MAX_MS - BLINK_GAP_MIN_MS)
  }

  let openness = 1
  if (blinkStartAt !== 0) {
    const p = (now - blinkStartAt) / BLINK_MS
    if (p >= 1) {
      blinkStartAt = 0
    } else {
      // 0→0.5 闭，0.5→1 睁
      openness = p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2
    }
  }
  setParams({ ParamEyeLOpen: openness, ParamEyeROpen: openness })
}

/** 一次性动作的兜底定时器、特效保持定时器、当前动作索引 */
let oneShotTimer = null
let lingerTimer = null
let currentMotion = null
/**
 * 一次性动作的"预计结束时刻"。巡检靠它避开"正在演一次性动作"那段，
 * 免得把叉腰/比嘘打断。
 */
let oneShotUntil = 0
/**
 * 动作巡检定时器 + 心跳计数。
 *
 * ⚠️ 为什么必须有巡检：实机日志显示"她退回默认坐姿"时**根本没有 motionFinish**
 *    —— 库在某个路径上把动作停掉却不派事件，于是"等 motionFinish 再重开"永远等不到。
 *    所以改成主动看"动作管理器是否已空闲"。
 */
let motionWatchdog = null
let watchdogTicks = 0
/** pokeExpression 的恢复定时器（连点右键时只保留最后一次） */
let pokeTimer = null

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

// ── 构图参数 ────────────────────────────────────────────────────────
// 为什么不能按"模型画布"适配：画布是 4200×3500，但角色只占中间一块，
// 四周大量空白 → 按画布适配会让角色显得很小、上方留一大片空（实测就是这个现象）。
// 改成按**渲染出来的实际不透明包围盒**适配。
const FIT_MARGIN_PX = 6 // 四周留白（CSS 像素）
const FIT_FILL = 0.94 // 内容最多占可用区域的比例，留点余量给动作的最大幅度
const FIT_MEASURE_MS = 3000 // 测量窗口：必须覆盖动作的一个周期，否则会按"某一瞬间"适配而裁到动作
const FIT_SAMPLE_MS = 200
const ALPHA_THRESHOLD = 24

/**
 * 从渲染画布读回 alpha 通道。
 * 依赖 PIXI 的 `preserveDrawingBuffer: true` —— 否则在渲染循环之外 drawImage 读到的是空白。
 * 命中测试（pet.js）与构图测量都用它，避免两处各写一份。
 */
export function readAlpha() {
  const c = state.canvas
  if (!c || !c.width || !c.height) return null
  const scratch = document.createElement('canvas')
  scratch.width = c.width
  scratch.height = c.height
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.drawImage(c, 0, 0)
  const { data } = ctx.getImageData(0, 0, c.width, c.height)
  const alpha = new Uint8Array(c.width * c.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
  return { alpha, width: c.width, height: c.height }
}

/** 先把模型整块铺进舞台（保底，保证测量期间角色可见） */
export function fit() {
  const { model, canvas } = state
  if (!model || !canvas) return
  const cw = canvas.clientWidth || canvas.width
  const ch = canvas.clientHeight || canvas.height
  const mw = model.width
  const mh = model.height
  if (!mw || !mh) return
  const scale = Math.min(cw / mw, ch / mh)
  model.scale.set(scale)
  model.position.set((cw - mw * scale) / 2, ch - mh * scale)
  state.log(`初步适配（按画布）${mw.toFixed(0)}×${mh.toFixed(0)} → 舞台 ${cw}×${ch}，scale=${scale.toFixed(4)}`)
}

/** 在测量窗口内反复采样，最后按包围盒并集重新构图 */
function measureAndFitContent() {
  const shots = []
  const t0 = performance.now()
  const step = () => {
    const shot = readAlpha()
    if (shot) shots.push(shot)
    if (performance.now() - t0 < FIT_MEASURE_MS) {
      setTimeout(step, FIT_SAMPLE_MS)
    } else {
      applyContentFit(shots)
    }
  }
  step()
}

/** 内容在**模型局部坐标**里的包围盒（由测量得出；缓存下来供重新布局用） */
let contentLocal = null

/**
 * 按"所有采样帧包围盒的并集"重新构图。
 *
 * 为什么取并集：模型一直在动（荡秋千时翅膀会甩开），
 * 按单帧适配会在动作幅度最大的时候切掉边缘。
 */
function applyContentFit(shots) {
  const { model, canvas } = state
  if (!model || !shots.length) return
  const cssW = canvas.clientWidth || canvas.width
  const cssH = canvas.clientHeight || canvas.height

  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  let mw = 0
  let mh = 0
  for (const { alpha, width, height } of shots) {
    mw = width
    mh = height
    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        if (alpha[row + x] > ALPHA_THRESHOLD) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
  }
  if (maxX < 0) {
    state.log('构图测量：所有像素全透明，跳过适配')
    return
  }

  // 掩码坐标 → CSS 坐标（画布有 devicePixelRatio 缩放），再折算回**模型局部坐标**。
  // ⚠️ 全程只用模型局部坐标做布局计算 —— 之前混用"当前 CSS 尺寸"和"新 scale"，
  //    量纲不对（实测算出"上方留白 281px"而窗口才 300px 高）。
  const kx = cssW / mw
  const ky = cssH / mh
  const s = model.scale.x
  contentLocal = {
    x: (minX * kx - model.position.x) / s,
    y: (minY * ky - model.position.y) / s,
    w: ((maxX - minX + 1) * kx) / s,
    h: ((maxY - minY + 1) * ky) / s,
  }
  state.log(
    `内容包围盒（模型局部）：x=${contentLocal.x.toFixed(0)} y=${contentLocal.y.toFixed(0)} ` +
      `w=${contentLocal.w.toFixed(0)} h=${contentLocal.h.toFixed(0)}（${shots.length} 帧并集）`,
  )
  layoutFromContent()
  // 通知外部"构图已就绪"：主进程据此显示窗口，并把结果写进缓存
  state.onFitReady?.(contentLocal, false)
}

/** 用缓存的包围盒重新排布（窗口尺寸变化时也走这里） */
function layoutFromContent() {
  const { model, canvas } = state
  if (!model || !contentLocal) return
  const cssW = canvas.clientWidth || canvas.width
  const cssH = canvas.clientHeight || canvas.height

  const availW = (cssW - FIT_MARGIN_PX * 2) * FIT_FILL
  const availH = (cssH - FIT_MARGIN_PX * 2) * FIT_FILL
  const s2 = Math.min(availW / contentLocal.w, availH / contentLocal.h)

  model.scale.set(s2)
  const dX = (cssW - contentLocal.w * s2) / 2 // 水平居中
  const dY = cssH - FIT_MARGIN_PX - contentLocal.h * s2 // 贴底（像站在桌面上）
  model.position.set(dX - contentLocal.x * s2, dY - contentLocal.y * s2)

  state.log(
    `构图：内容 ${(contentLocal.w * s2).toFixed(0)}×${(contentLocal.h * s2).toFixed(0)} CSS px / ` +
      `舞台 ${cssW}×${cssH}，scale=${s2.toFixed(4)}，上方留白 ${dY.toFixed(0)}px`,
  )

  // 下次内容尺寸变化时（窗口/DPR 变了）自动重排，不用重新测量
  if (!state.resizeHooked) {
    state.resizeHooked = true
    let pending = false
    window.addEventListener('resize', () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        layoutFromContent()
      })
    })
  }
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

/** 按名字切换表情（找得到才切）。注意：同一时刻只有一个表情生效。 */
function setExpression(name) {
  const model = state.model
  if (!model || !name) return
  const available = new Set((model.internalModel?.settings?.expressions ?? []).map((e) => e.Name))
  if (!available.has(name)) {
    state.log(`表情 ${name} 不存在，跳过`)
    return
  }
  try {
    model.expression(name)
  } catch (error) {
    state.log(`表情 ${name} 失败：${error.message}`)
  }
}

/**
 * 临时弹一个特效表情，过一会儿恢复（右键弹问号就靠它）。
 *
 * ⚠️ **恢复不能让"提问状态"的问号被误清**：agent 在等你回答时，状态就是 `question`，
 * 那个问号是**常驻**的。所以恢复方式是"把当前状态该有的表情重新应用一遍" ——
 * 状态本来就是 question 时，等于再应用一次 question，问号留着。
 *
 * ⚠️ **但"一次性特效"不能被复活**（这个坑我踩了）：
 * `done` 是 `{ once: true, expression: 'happy' }` —— 闭眼笑 + 星光，**演完就该撤**
 * （用户明确要求过"从叉腰切换成待机后笑眼不再留存"）。如果恢复时照搬
 * `STATE_MAP['done'].expression`，右键弹完问号后她就会**卡在闭眼笑**上，
 * 而且不会再有东西来清它（实测反馈："右键之后一段时间，问号消失，出现如图表情"）。
 * 所以：一次性且不带 keepEffect 的态，恢复成**基础表情**（idle 的 reset），
 * 其余（idle/running/error/question，以及 keepEffect 的 approval）照搬自己的。
 *
 * ⚠️ 状态不是 question 时，额外**显式把 Param6 清 0**：`reset` 表情的参数表里
 * **没有** Param6（只有 惊喜/圈圈/开心/墨镜 四个），只靠"替换表情"不保险。
 *
 * @param {string} name 表情名（question / surprise / spiral / happy / sunglasses）
 * @param {number} ms   停留时长
 * @returns {boolean} 是否真的应用了
 */
export function pokeExpression(name, ms = 1700) {
  if (!state.model || !state.ready) return false
  setExpression(name)
  clearTimeout(pokeTimer)
  pokeTimer = setTimeout(() => {
    const mapped = STATE_MAP[state.currentState]
    const transient = mapped === undefined || (mapped.once === true && mapped.keepEffect !== true)
    setExpression(transient ? STATE_MAP.idle.expression : mapped.expression)
    if (state.currentState !== 'question') setParams({ Param6: 0 })
  }, Math.max(200, ms))
  return true
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
/**
 * 参数采样器 —— 用来"看懂"一个动作到底做了什么。
 *
 * 背景：这个模型的 4 个动作都叫 Scene1~4，光看名字不知道是什么。
 * 而它的"表情"其实是**特效开关**（墨镜/星星/问号/闪耀/思考/手指/招牌/秋千…），
 * 所以只要把这些参数**随时间的取值**采下来，就能反推出每个动作的内容 ——
 * 比逐帧截图省事得多，也更准（能看到精确的起止时刻）。
 *
 * 打开方式：PET_SAMPLE_PARAMS=1（可配 PET_SAMPLE_MS 指定采样时长）
 */
const WATCH_PARAMS = {
  Param: '惊喜', Param2: '圈圈', Param3: '开心', Param15: '嘻嘻',
  Param4: '墨镜', Param5: '星星', Param6: '问号', Param7: '闪耀', Param8: '问号WL',
  Param9: '思考', Param10: '招牌1', Param11: '招牌2', Param12: '手指',
  Param13: '秋千1', Param14: '秋千2', Param16: '绳子', Param17: '叉腰1', Param18: '叉腰2',
  Param19: '左腿摇晃', Param20: '右腿摇晃', Param21: '左鞋摇晃', Param22: '右鞋摇晃',
  Param23: '秋千摇晃1', Param24: '秋千摇晃2',
  Param25: '摆动WL1', Param26: '摆动WL2', Param27: '跟随WL1', Param28: '跟随WL2',
  Param29: '头发WL1', Param30: '头发WL2', Param31: '秋千特殊', Param32: '秋千开关',
  ParamEyeLOpen: '左眼开闭', ParamEyeROpen: '右眼开闭',
  ParamMouthOpenY: '嘴开闭', ParamAngleX: '角度X', ParamAngleZ: '角度Z', ParamBreath: '呼吸',
}

let sampler = null

function samplerBegin(durationMs) {
  sampler = { t0: performance.now(), durationMs, data: new Map(Object.keys(WATCH_PARAMS).map((k) => [k, []])) }
}

/** 在 beforeModelUpdate 里调用；顺手把状态参数也应用了 */
function samplerSample(core) {
  if (!sampler) return
  const t = performance.now() - sampler.t0
  for (const id of sampler.data.keys()) {
    let value
    try {
      value = core.getParameterValueById(id)
    } catch {
      value = undefined
    }
    sampler.data.get(id).push([t, value])
  }
}

function samplerFinish() {
  if (!sampler) return
  const { durationMs, data } = sampler
  const lines = []
  for (const [id, series] of data) {
    const valid = series.filter(([, v]) => typeof v === 'number')
    if (!valid.length) continue
    const values = valid.map(([, v]) => v)
    const min = Math.min(...values)
    const max = Math.max(...values)
    // 全程贴着 0 的参数没有信息量，跳过
    if (Math.abs(min) < 0.05 && Math.abs(max) < 0.05) continue
    // 找一个"明显的活动区间"：|v| 超过阈值的第一刻与最后一刻
    const threshold = Math.max(0.15, Math.max(Math.abs(min), Math.abs(max)) * 0.3)
    const active = valid.filter(([, v]) => Math.abs(v) >= threshold)
    const from = active.length ? (active[0][0] / 1000).toFixed(2) : '-'
    const to = active.length ? (active[active.length - 1][0] / 1000).toFixed(2) : '-'
    const steady = Math.abs(max - min) < 0.05
    lines.push(
      `  ${id.padEnd(16)} 「${WATCH_PARAMS[id]}」  范围 ${min.toFixed(2)}~${max.toFixed(2)}` +
        (steady ? ' 恒定' : `  活动 ${from}~${to}s`),
    )
  }
  state.log(`===== 参数采样（${(durationMs / 1000).toFixed(1)}s）=====`)
  for (const l of lines) state.log(l)
  state.log(`===== 采样结束，共 ${lines.length} 个有变化的参数 =====`)
  sampler = null
}

function applyState() {
  const mapped = STATE_MAP[state.currentState] ?? STATE_MAP.idle
  if (mapped.params && Object.keys(mapped.params).length) setParams(mapped.params)
  if (state.currentState === 'error') setParams(ERROR_FACE)
  // 道具渐变（两段式过渡）：位置在状态参数之后，才能盖过它们
  stepPropFade(performance.now())
  // ⚠️ **最后一步**：压掉"动作每帧会写回来"的参数。
  //    本函数就挂在 `beforeModelUpdate`（动作/表情/物理都跑完之后、提交渲染之前），
  //    所以这里的写入能压过动作。
  //    实机教训：秋千动作（Scene4）自己会把 `Param9`「思考」推到 1 →
  //    荡秋千时冒出一只"思考的手"，加上抓绳两只 = **三只手**。
  //    手部姿势优先走"两段式混合"（不跳变、也不重叠）；没在过渡时才直接写 force。
  const mixed = stepHandPoseMix(performance.now())
  if (mixed !== null) {
    setParams(mixed)
  } else if (mapped.force) {
    setParams(mapped.force)
    // ⚠️ **必须同步记下**：稳态也往这些参数里写值，不记的话
    //    下一次过渡会拿"动作的原始值"当起点 —— 于是第一帧先跳回动作值、再往下走 = **弹两下**
    //    （实机日志实测：`阶段0 p=0.00 9=0.987`，而稳态时它明明是 0）。
    lastHandValues = { ...mapped.force }
    lastForce = { ...mapped.force }
  }
  // 眨眼也在这里输出 —— 位置在动作之后，才能压过被动作冻结的眼睛参数
  applyBlink(performance.now())
}

/** 初始化：创建 PIXI 应用并加载模型 */
export async function init({ canvas, modelUrl, log, forceMotion, sampleMs, handDebug: handDebugFlag, cachedFit, onFitReady }) {
  state.canvas = canvas
  state.log = log ?? (() => {})
  handDebug = handDebugFlag === true
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

  // 构图：优先套用缓存（立即可用，不会出现"打开一会突然变大"）；
  // 没有缓存才现场测量（约 3 秒，期间主进程不显示窗口）。
  state.onFitReady = onFitReady
  fit()
  if (cachedFit && cachedFit.w > 0 && cachedFit.h > 0) {
    contentLocal = cachedFit
    layoutFromContent()
    state.log(`构图：套用缓存（模型局部 ${cachedFit.w.toFixed(0)}×${cachedFit.h.toFixed(0)}）`)
    onFitReady?.(cachedFit, true)
  } else {
    state.log('构图：无缓存，开始现场测量（主进程会等测量完成后才显示窗口）')
    setTimeout(measureAndFitContent, 400)
  }

  // 包一层动作时钟，用来给开场手势减速（详见 setMotionTimeScale 注释）。
  // 只包 motionManager —— 表情/眨眼/物理仍走真实时间，不受影响。
  const mm = model.internalModel.motionManager
  const originalMotionUpdate = mm.update.bind(mm)
  mm.update = (coreModel, now) => originalMotionUpdate(coreModel, motionClock(now))

  // 状态参数 +（可选）参数采样，都挂在每帧的最后一个时机
  model.internalModel.on('beforeModelUpdate', () => {
    applyState()
    samplerSample(model.internalModel.coreModel)
  })

  // 一次性动作播完 → 回基础动作。事件挂在 motionManager 上。
  model.internalModel.motionManager.on('motionFinish', () => {
    // 开场手势演完 → 落到待机（或应用排队中的状态）
    if (introPending) {
      finishIntro()
      return
    }

    // 决策抽在 motion-policy.js（纯函数）里，理由与踩坑见那个文件 ——
    // 关键点：**不能只看 state.currentState**。一次性状态（尤其 done）刻意保留
    // currentState 不切走（未读背板要一直显示），此时实际在播的已是待机动作；
    // 只看状态会走进 returnToBaseMotion()，而它那句
    // `if (currentMotion === BASE_MOTION) return` 会直接返回、**没人重开**
    // → 永远停在最后一帧（用户报的"长时间待机之后退出待机动作"）。
    const decision = decideOnMotionFinish({
      currentMotion,
      currentState: state.currentState,
      stateMap: STATE_MAP,
      baseMotion: BASE_MOTION,
    })

    if (decision.action === 'restart') {
      // ⚠️ setIsLoop(true) 在这个模型上**不生效**：标志设得上（日志可见），
      //    但库照样在时长结束后派发 motionFinish。待机动作 Scene[3] 长 180 秒，
      //    所以必须由我们重开 —— 否则"待机几分钟后就不动了"。
      state.log(`⚠️ 动作 Scene[${decision.index}] 播完（setIsLoop 未生效，${decision.why}）→ 重开`)
      startMotion(decision.index, true)
      return
    }
    if (decision.action === 'base') {
      returnToBaseMotion()
    }
  })

  /**
   * 动作巡检（每 3 秒）。
   *
   * ⚠️ 存在的理由：实机里她**退回默认坐姿**（双手空空、秋千消失）时，
   *    日志里**根本没有 motionFinish** —— 库在某条路径上把动作停掉却不派事件。
   *    所以"等 motionFinish 再重开"是等不到的，必须主动看动作管理器是否已空闲。
   *
   * 判空用 `motionManager.isFinished()`（库自己的语义：没有动作在播时为真）。
   * 巡检只在"该有动作在播"时动手：开场手势期间、以及一次性动作的预计时长内都不插手。
   *
   * 另外每 5 次巡检（约 15 秒）记一行心跳 —— 出问题时能直接看到
   * "动作是什么时候变成空闲的、当时是什么状态"。
   */
  clearInterval(motionWatchdog)
  motionWatchdog = setInterval(() => {
    try {
      const mm = model.internalModel?.motionManager
      if (mm === undefined) return
      watchdogTicks += 1
      const finished = mm.isFinished?.() === true
      if (watchdogTicks % 5 === 0) {
        state.log(
          `心跳 动作=Scene[${currentMotion}] 管理器空闲=${finished} 状态=${state.currentState}` +
            `${introPending ? '（开场手势中）' : ''}`,
        )
      }
      if (introPending) return // 开场手势优先演完
      if (Date.now() < oneShotUntil) return // 一次性动作的预计时长内不插手
      if (!finished) return // 有动作在播，正常
      const mapped = STATE_MAP[state.currentState] ?? STATE_MAP.idle
      // `motion === null` = 这个状态**本来就不播动作**（running）→ 巡检不许插手，
      // 否则会把秋千又开起来，跟 Param9 的手叠成三只手。
      if (mapped.motion === null) return
      // 一次性状态的动作已经演完（oneShotUntil 已过）→ 回基础动作；
      // 其余状态 → 重开它自己的动作。绝不让"空转"停留超过一个巡检周期。
      const index = mapped.once ? BASE_MOTION : (mapped.motion ?? BASE_MOTION)
      state.log(`⚠️ 动作管理器已空闲（没有 motionFinish 事件）→ 重开 Scene[${index}]（状态 ${state.currentState}）`)
      startMotion(index, true)
    } catch (error) {
      state.log(`动作巡检出错：${error?.message ?? error}`)
    }
  }, 3000)

  // 起始动作：默认荡秋千。调试时可用 PET_FORCE_MOTION=Scene:N 指定。
  // 注意记下"实际启动了哪个动作" —— 采样日志要用它。
  // （这里曾经引用重构时已删掉的 group/index：一开采样就抛 ReferenceError，
  //   init 中途失败 → state.ready 与构图测量都不执行。排查花了不少时间。）
  let startedMotion = BASE_MOTION
  if (typeof forceMotion === 'string' && forceMotion.includes(':')) {
    const [g, i] = forceMotion.split(':')
    const idx = Number(i) || 0
    startedMotion = idx
    state.log(`调试模式：指定动作 ${g}[${idx}]`)
    try {
      model.motion(g, idx, PIXI.live2d.MotionPriority.IDLE)
      // ⚠️ 必须自己记一下 currentMotion：调试分支绕过了 startMotion()，而
      // `applyBlink()` 靠 currentMotion 判断"这个动作要不要我们接管眨眼"。
      // 漏了这一行的后果：用 PET_FORCE_MOTION=Scene:3 抓帧时待机眼睛是闭的
      // —— 那是**截图假象**，不是产品行为（实机待机会眨眼）。
      currentMotion = idx
    } catch (error) {
      state.log(`启动调试动作失败 ${g}[${idx}]：${error.message}`)
    }
  } else {
    // 启动先演一次"比嘘"手势，演完自动落到待机（荡秋千）。
    // 放慢到 INTRO_SPEED 倍 —— 原速下手放得太快（用户反馈）。
    setMotionTimeScale(INTRO_SPEED)
    state.log(
      `开场手势 Scene[${INTRO_MOTION}]（只演一次，${INTRO_SPEED}x 慢放），之后落到待机 Scene[${BASE_MOTION}]`,
    )
    startMotion(INTRO_MOTION, false)
    // 兜底：万一循环没关掉（motionFinish 不触发），按时长强制结束。
    // 时长要按慢放后的实际用时算。
    setTimeout(
      () => {
        if (introPending) {
          state.log('开场手势未收到 motionFinish，按时长兜底结束')
          finishIntro()
        }
      },
      Math.round(3600 / INTRO_SPEED),
    )
  }

  if (sampleMs > 0) {
    samplerBegin(sampleMs)
    state.log(`开始参数采样 ${sampleMs}ms（动作 Scene[${startedMotion}]）`)
    setTimeout(samplerFinish, sampleMs)
  }

  state.ready = true
  return model
}

/**
 * 所有"道具开关"参数 id（`Param`/`Param2..Param32`）。
 * 模型的手/道具都是这些开关画上去的，切换状态时必须整组处理。
 */
const PROP_PARAM_IDS = Object.keys(WATCH_PARAMS).filter((id) => /^Param\d*$/.test(id))

/**
 * 道具渐变（两段式，共约 340ms）。
 *
 * ⚠️ 为什么是**两段**而不是交叉淡入淡出：道具里有**互斥的手/姿势**，
 *    同时淡出旧手 + 淡入新手会让**两只手同时可见** → 用户实测报"又有三只手了"。
 *    所以：先全部熄掉（`PROP_FADE_OUT_MS`），**再**点起本状态要的（`PROP_FADE_IN_MS`）。
 */
const PROP_FADE_OUT_MS = 140
const PROP_FADE_IN_MS = 200
let propFade = null

/**
 * 用**当前实际值**作为起点，开始一段道具渐变。
 * @param {Record<string, number>} targets
 * @param {number} durationMs
 * @param {(() => void)|null} then 本段结束后接着做的事（用于串第二段）
 */
function startPropFade(targets, durationMs, then = null) {
  const core = state.model?.internalModel?.coreModel
  const from = {}
  for (const id of Object.keys(targets)) {
    let value = 0
    try {
      value = core?.getParameterValueById?.(id) ?? 0
    } catch {
      value = 0
    }
    from[id] = value
  }
  propFade = { from, to: { ...targets }, t0: performance.now(), durationMs, then }
  return propFade
}

/** 每帧推进道具渐变；返回是否还在渐变中 */
function stepPropFade(now) {
  if (propFade === null) return false
  const progress = propFade.durationMs <= 0 ? 1 : (now - propFade.t0) / propFade.durationMs
  setParams(fadeProps(propFade.from, propFade.to, progress))
  if (progress >= 1) {
    const next = propFade.then
    propFade = null
    if (typeof next === 'function') next()
  }
  return true
}

/** 开始"两段式"道具过渡：先全熄，再点起本状态要的 */
function startPropTransition(mapped) {
  const [allOff, targets] = propFadePhases(mapped, PROP_PARAM_IDS)
  startPropFade(allOff, PROP_FADE_OUT_MS, () => startPropFade(targets, PROP_FADE_IN_MS))
}

/** 直接结束渐变（切到有动作的状态时用：接下来交给动作驱动） */
function cancelPropFade() {
  propFade = null
}

/**
 * 停掉所有动作（**不动参数**）—— 参数由调用方决定是渐变还是立即。
 */
function stopAllMotions() {
  try {
    state.model?.internalModel?.motionManager?.stopAllMotions?.()
  } catch (error) {
    state.log(`停动作失败：${error?.message ?? error}`)
  }
  currentMotion = null
}

/**
 * 启动某个动作。
 * @param {number} index   Scene 组里的动作下标
 * @param {boolean} loop   false = 只播一次（播完由 motionFinish / 兜底定时器接手）
 */
function startMotion(index, loop) {
  if (!state.model) return
  currentMotion = index
  try {
    // 用 FORCE 而不是 NORMAL：NORMAL 会被正在播放的动作挡住，
    // 状态切换是显式意图，应该立刻生效（FORCE 仍走模型自带的淡入淡出）。
    state.model.motion('Scene', index, PIXI.live2d.MotionPriority.FORCE)
  } catch (error) {
    state.log(`启动动作 Scene[${index}] 失败：${error.message}`)
    return
  }
  if (loop !== undefined) setMotionLoop(index, loop)
}

/**
 * 关/开某个动作的循环。
 *
 * 为什么需要重试：`motionManager.motionGroups[group][index]` 是**懒加载**的，
 * 刚调用 motion() 的那一刻往往还是 null（实测第一版就取不到，只能退回定时器）。
 * 而 `CubismMotion._isLoop` 是每帧读的，所以启动后几十毫秒内设上都来得及。
 *
 * 为什么要**双向**设置（而不只是关循环）：
 * Scene[0] 既当"启动手势"（只演一次）又当 `running` 的动作（要循环）。
 * 如果把它的循环永久关掉，running 时就会只播一遍然后冻在最后一帧。
 * 所以每次启动动作都显式声明这一次要循环还是不循环。
 *
 * token 用来作废过期的重试：同一动作被连续启动两次时，
 * 前一次的延迟重试不能把后一次的设置覆盖掉。
 */
let loopSetToken = 0

// ── 动作时钟缩放（库没有调速 API，见 setMotionTimeScale 注释）──────────
let motionTimeScale = 1
let scaleRealBase = null
let scaleVirtualBase = null

/**
 * 把"真实时间"换成"动作时钟"。速度倍率不等于 1 时，动作时钟走得更慢。
 *
 * ⚠️ 绝对时间**不能**直接乘系数：动作队列内部记的是 startTime，
 *    若时间轴整体缩放，已记录的 startTime 会与新时间对不上（动作会跳或直接结束）。
 *    所以用"重新基准"的方式：记录变速那一刻的真实/虚拟两个原点，之后线性外推。
 */
function motionClock(nowSeconds) {
  if (motionTimeScale === 1) return nowSeconds
  const realMs = nowSeconds * 1000
  if (scaleRealBase === null) {
    scaleRealBase = realMs
    scaleVirtualBase = realMs
  }
  return (scaleVirtualBase + (realMs - scaleRealBase) * motionTimeScale) / 1000
}

function setMotionTimeScale(next) {
  if (next === motionTimeScale) return
  // 清掉基准 → 下次调用时以当前位置重新锚定，变速瞬间不会跳
  scaleRealBase = null
  scaleVirtualBase = null
  motionTimeScale = next
  state.log(`动作速度 → ${next}x`)
}

function setMotionLoop(index, loop) {
  const token = ++loopSetToken
  const trySet = (attempt) => {
    if (token !== loopSetToken) return // 已被更新的调用取代
    const mm = state.model?.internalModel?.motionManager
    const motion = mm?.motionGroups?.['Scene']?.[index]
    if (motion && typeof motion.setIsLoop === 'function') {
      motion.setIsLoop(loop)
      state.log(`Scene[${index}] 循环=${loop}（第 ${attempt + 1} 次尝试）`)
      return
    }
    if (attempt < 20) {
      setTimeout(() => trySet(attempt + 1), 50)
    } else {
      state.log(`Scene[${index}] 始终取不到 motion 对象，循环设置未生效`)
    }
  }
  trySet(0)
}

/** 一次性动作结束后回到基础动作。
 *  ⚠️ 刻意**不**改 state.currentState —— 桌宠仍是 done（未读背板继续显示），
 *     只是动作不再重复播放。状态与动作是两件事。
 *  ⚠️ 但正因为 currentState 停在 done，这里的 `currentMotion === BASE_MOTION`
 *     判断**必须**保留 —— 它表示"此刻已经在播待机动作了，别重复开"。
 *     而"待机动作播完停住了"那种情况由 motionFinish 里的分支处理（见那里注释），
 *     不能指望这个函数兜底。 */
function returnToBaseMotion() {
  if (currentMotion === BASE_MOTION) return
  state.log(`一次性动作播完 → 回到基础动作 Scene[${BASE_MOTION}]（状态仍是 ${state.currentState}）`)
  startMotion(BASE_MOTION, true)

  const mapped = STATE_MAP[state.currentState]
  if (mapped?.lingerMs) {
    // 特效再保留一小段（目前没有状态用这条，机制留着备用）
    scheduleLinger()
  } else if (mapped?.once && !mapped.keepEffect) {
    // 演完就撤特效：否则回到待机了脸上还挂着笑（用户实测后明确要求撤掉）
    state.log(`一次性动作结束 → 撤掉特效「${mapped.expression}」`)
    setExpression('reset')
  }
}

/**
 * 让一次性状态的特效再保持一会儿再撤。
 *
 * 为什么不是动作一结束就撤：`done` 的笑眼（Param3 开心）是**表情**驱动的，
 * 与动作相互独立。动作 4 秒播完就立刻板起脸太突兀，
 * "笑着看你一眼再恢复"更像个活物。时长在 STATE_MAP 的 `lingerMs` 区间里随机取，
 * 免得每次都是同一个节拍（这个模型的动作本身也都带随机性）。
 */
function scheduleLinger() {
  clearTimeout(lingerTimer)
  const mapped = STATE_MAP[state.currentState]
  if (!mapped?.lingerMs) return
  const [min, max] = mapped.lingerMs
  const wait = Math.round(min + Math.random() * (max - min))
  const expected = state.currentState
  state.log(`特效「${mapped.expression}」再保持 ${wait}ms 后撤回`)
  lingerTimer = setTimeout(() => {
    // 期间状态变了就放弃这条（新状态已经在 playStateMotion 里清了定时器）
    if (state.currentState !== expected) return
    state.log(`特效撤回 → reset（桌宠状态仍是 ${expected}，未读语义不受影响）`)
    setExpression('reset')
  }, wait)
}

/** 开场手势结束（正常演完或超时兜底）→ 应用排队中的状态，没有就落到待机 */
function finishIntro() {
  if (!introPending) return
  introPending = false
  setMotionTimeScale(1) // 手势演完恢复常速，别把后续动作也拖慢
  const next = stateWaitingIntro
  const animate = stateWaitingIntroAnimate
  stateWaitingIntro = null
  stateWaitingIntroAnimate = true
  if (next) {
    state.log(`开场手势结束 → 应用等待中的状态 ${next}`)
    playStateMotion(next, animate)
  } else {
    state.log('开场手势结束 → 落到待机')
    returnToBaseMotion()
  }
}

/**
 * 启动后第一次拿到的状态是**"现状"**（主进程补发的 snapshot），不是一次状态转变。
 * 一次性入场动画（done 的叉腰 + 笑眼）不该为它重放 ——
 * 用户实测报的"比嘘手势后会接一次叉腰"，根源就是上一轮 agent 干完留下的 done 状态：
 * 桌宠刚启动就把一件旧事当成新完成来庆祝。
 * 非一次性状态（running/question…）不受影响，照常切换，
 * 否则启动时显示不出"正在干活"。
 */
let firstStatePending = true
/** 排队等开场手势的那个状态，是否要播入场动画 */
let stateWaitingIntroAnimate = true

/** 按状态切换动作 */
function playStateMotion(next, animate = true) {
  // 开场手势优先演完（这是用户明确要的开场动作）
  if (introPending) {
    if (INTRO_INTERRUPT.has(next)) {
      introPending = false
      state.log(`启动手势被紧急状态 ${next} 打断`)
    } else {
      stateWaitingIntro = next
      stateWaitingIntroAnimate = animate
      state.log(`状态 ${next} 在启动手势期间到达，等手势演完再应用`)
      return
    }
  }
  applyStateMotion(next, animate)
}

/**
 * 手部姿势的两段式**混合**（`running` 切入切出用）。
 *
 * 两个约束同时成立，所以不能简单处理：
 *  ① **手是互斥资源** —— 不能交叉淡化，否则"旧手没淡完、新手已淡入"→ 三只手（踩过）
 *  ② **必须有过渡** —— 直接切参数会跳变（用户："润一下，不要跳变"）
 *  ③ 秋千动作还在每帧写这些参数，所以混合要**跟着动作的当前值**走，不能写死绝对值
 *
 * 做法：
 *  - 第一段 `HAND_MIX_OUT_MS`：把**所有**手部姿势混向"全关"（把手卸掉）
 *  - 第二段 `HAND_MIX_IN_MS`：混向本状态的目标（running 的思考姿势），
 *    或者（离开 running 时）**混回动作自己的值**（让秋千的抓绳姿势自然回来）
 *
 * 每帧公式都是 `lerp(动作刚写下的值, 目标, 进度)` —— 在 `beforeModelUpdate` 里执行，
 * 动作/表情/物理都已跑完，所以读到的是动作本帧的值、写下去也能压住它。
 */
const HAND_MIX_OUT_MS = 160
const HAND_MIX_IN_MS = 220
/** "手部姿势全关"的中性值（第一段目标） */
const NEUTRAL_HANDS = {
  Param9: 0,
  Param16: 0,
  Param10: 0,
  Param11: 0,
  Param12: 0,
  Param13: 0,
  Param14: 0,
  Param17: 0,
  Param18: 0,
}
let handMix = null
/** 上一次"手部姿势特殊"的状态（决定要不要起过渡） */
let handState = null
/** 逐帧诊断开关（`PET_HAND_DEBUG=1`；见 stepHandPoseMix） */
let handDebug = false
/**
 * 我们**上一次真正写下去**的手部参数值。
 *
 * ⚠️ 这是"过渡会弹两下"的修复关键：
 *    原来每帧都写 `lerp(动作本帧的值, 目标, 进度)` —— 到了第二段，起点又变回"动作的值"，
 *    于是两段交界处会**弹回去一次**，一次过渡看起来就是弹两下（用户实测："手会很快速地弹两下"）。
 *    改成以"我们上一次写下的值"为起点后，第二段从第一段的终点接着走，全程单调、无回弹 ✓
 *    （读动作的值只在"从没写过"时用作兜底。）
 */
let lastHandValues = {}
/**
 * 上一个状态在稳态里**压过的参数值**。
 *
 * ⚠️ 这是"过渡第一帧会跳回去"的兜底：启动时状态可能在**第一帧之前**就到达
 *    （模型还没渲染过），此时 `lastHandValues` 还是空的 ✗
 *    若退回"读动作的原始值"，第一帧就会从动作值（实测 `Param9=0.993`）起算 →
 *    先跳一下再往下走 = 弹 ✓
 *    而"她当时实际显示的值"就是上一个状态压过的值 → 用它兜底才对。
 */
let lastForce = null

function readParamValue(id) {
  try {
    return state.model?.internalModel?.coreModel?.getParameterValueById?.(id) ?? 0
  } catch {
    return 0
  }
}

/**
 * 起一段两段式手部过渡。
 * @param {Record<string, number>|null} inTarget 第二段目标；null = 混回动作自己的值（离开 running）
 */
function startHandPoseMix(inTarget) {
  // 从稳态开始时，把"上一个状态压过的值"当作已知的显示值 —— 过渡才不会从动作原始值跳起
  if (handMix === null) lastHandValues = { ...(lastForce ?? {}) }
  const secondStep =
    inTarget === null ? { release: NEUTRAL_HANDS, durMs: HAND_MIX_IN_MS } : { to: inTarget, durMs: HAND_MIX_IN_MS }
  handMix = { steps: [{ to: NEUTRAL_HANDS, durMs: HAND_MIX_OUT_MS }, secondStep], step: 0, t0: performance.now() }
}

/** 推进手部过渡；返回本帧该写的参数（没在过渡则返回 null） */
function stepHandPoseMix(now) {
  if (handMix === null) return null
  const current = handMix.steps[handMix.step]
  const progress = current.durMs <= 0 ? 1 : Math.min(1, (now - handMix.t0) / current.durMs)
  const eased = 1 - Math.pow(1 - progress, 3) // easeOutCubic
  const out = {}
  if (current.to) {
    // 混向目标：起点 = **我们上一次写下的值**（没有才退回动作本帧的值）
    for (const id of Object.keys(current.to)) {
      const start = lastHandValues[id] ?? readParamValue(id)
      out[id] = start + (current.to[id] - start) * eased
    }
  } else if (current.release) {
    // 混回动作：从"我们压住的值"回到动作本帧的值
    for (const id of Object.keys(current.release)) {
      const target = readParamValue(id)
      const start = lastHandValues[id] ?? target
      out[id] = start + (target - start) * eased
    }
  }
  lastHandValues = { ...out }
  // 每段只记**首末两帧**（4~6 行/次过渡）：这样"过渡有没有回弹"可以从用户那边的
  // 日志直接判定，不必让他盯动画数帧。逐帧全量打印另有 `PET_HAND_DEBUG=1`。
  if (handDebug || progress <= 0.08 || progress >= 0.99) {
    const fmt = (id) => (out[id] === undefined ? '—' : out[id].toFixed(3))
    state.log(
      `[手部过渡] 阶段${handMix.step}/${handMix.steps.length - 1} p=${progress.toFixed(2)} ` +
        `9=${fmt('Param9')} 16=${fmt('Param16')} 13=${fmt('Param13')} 17=${fmt('Param17')}`,
    )
  }
  if (progress >= 1) {
    handMix.step += 1
    handMix.t0 = now
    if (handMix.step >= handMix.steps.length) handMix = null
  }
  return out
}

/** 真正切动作。animate=false 表示"只是读到了现状"，不播入场动画 */
function applyStateMotion(next, animate) {
  const mapped = STATE_MAP[next] ?? STATE_MAP.idle
  clearTimeout(oneShotTimer)
  clearTimeout(lingerTimer) // 切状态时取消上一条待撤的特效

  // ── 手部姿势过渡 ─────────────────────────────────────────────
  // `running` 是唯一"手部姿势特殊"的状态（思考的手 + 不抓绳）。
  // 进/出它的时候要**两段式混合**：先把手卸掉、再上新姿势（或混回动作的抓绳姿势）。
  // ⚠️ 不能交叉淡化（手是互斥资源 → 会同时出现两只手），也不能直接切（跳变）。
  if (handState === 'running' && next !== 'running') {
    startHandPoseMix(null) // 离开：混回动作自己的值（秋千的抓绳姿势自然回来）
    state.log('手部姿势：离开 running → 两段式混回动作')
  } else if (next === 'running' && handState !== 'running') {
    startHandPoseMix(STATE_MAP.running.force) // 进入：先卸掉所有手部姿势，再上思考姿势
    state.log('手部姿势：进入 running → 两段式混向思考姿势')
  }
  handState = next === 'running' ? 'running' : null

  // ⚠️ `motion === null` = **这个状态不播任何动作**（目前只有 running）。
  //    停掉当前动作，只留 `Param9`「思考」这类参数效果 —— 她保持"手放下巴"的姿势。
  //    为什么不能播动作：用 Scene[0]（内含右手比嘘）会一遍遍比嘘；
  //    用荡秋千又与 Param9 的手叠加成**三只手**（用户实测）。
  if (mapped.motion === null) {
    stopAllMotions()
    // ⚠️ **两段式**过渡：先把所有道具熄掉，**再**点起本状态自己的（如 Param9）。
    //    交叉淡入淡出会让"旧手 + 新手"同时可见 → 三只手（用户实测）。
    //    也不能瞬间清零（那样就是硬切，"荡秋千到思考中间没有衔接"）。
    startPropTransition(mapped)
    state.log(
      `状态 ${next}：不播动作（道具两段过渡 ${PROP_FADE_OUT_MS}+${PROP_FADE_IN_MS}ms，只保留 Param9「思考」）`,
    )
    oneShotUntil = 0
    return
  }

  // 切到"有动作"的状态：动作会自己驱动参数，先取消道具渐变免得打架
  cancelPropFade()

  // idle 与 running 之外的状态若共用同一动作：来回切时不要重开，避免"画面一顿"。
  // （万一它其实已经停了，巡检 3 秒内会重开，见 motionWatchdog。）
  if (!mapped.once && mapped.motion === currentMotion) {
    state.log(`状态 ${next} 与当前动作相同（Scene[${mapped.motion}]）→ 不重开，继续播`)
    oneShotUntil = 0
    return
  }

  if (!animate) {
    state.log(`启动时状态已是 ${next}：不重放一次性入场动画，停在基础动作`)
    startMotion(BASE_MOTION, true)
    oneShotUntil = 0
    return
  }

  startMotion(mapped.motion, !mapped.once)
  if (mapped.once) {
    // 兜底：即使 setLoop(false) 没生效，也按已知时长切回，避免一直循环。
    // 时长来自模型解析（Scene1=3s / Scene2=4s / Scene3=3s / Scene4=180s）。
    const wait = (mapped.durationMs ?? 4000) + 250
    // 巡检要避开这一段，否则会把正在演的叉腰/比嘘打断
    oneShotUntil = Date.now() + wait
    oneShotTimer = setTimeout(() => {
      if (state.currentState === next) returnToBaseMotion()
    }, wait)
  } else {
    oneShotUntil = 0
  }
}

/** 切换桌宠状态 */
export function setState(next) {
  if (next === state.currentState) return
  state.currentState = next
  const mapped = STATE_MAP[next] ?? STATE_MAP.idle

  // 启动后第一次 + 这是一次性状态 → 只读现状，不播入场动画。
  // 特效也一并撤掉（除非该状态本来就要求留着，如 approval 的 keepEffect）。
  const animate = !(firstStatePending && mapped.once)
  firstStatePending = false

  const onceLabel = mapped.once ? '，只播一次' : ''
  const effect = animate || mapped.keepEffect ? mapped.expression : 'reset'
  state.log(`状态 → ${next}（动作 Scene[${mapped.motion}]${onceLabel}，表情 ${effect}）`)

  playStateMotion(next, animate)
  setExpression(effect)
  // ⚠️ 切状态时要把"上次设过、这次不再设"的参数**清零**：
  //    `setParams` 只写指定参数、不会重置其它的，不这么做的话
  //    running 的 `Param9`「思考」会在离开 running 之后一直挂着
  //    （干完活还一脸"思考"）。见 planParamTransition。
  const plan = planParamTransition(appliedParams, mapped)
  for (const id of plan.clear) setParams({ [id]: 0 })
  if (Object.keys(plan.set).length > 0) setParams(plan.set)
  appliedParams = plan.set
}

/** 导出给 pet.js 用的接口 */
window.xilianLive2D = {
  init,
  setState,
  fit,
  /** 读回渲染画布的 alpha 通道，供命中测试使用（{ alpha, width, height }） */
  readAlpha,
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
