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
const STATE_MAP = {
  // 待机：默认就荡秋千。180 秒长循环，最像"自己待着"
  idle: { motion: 3, expression: 'reset' },
  // 工作中：俏皮小动作 + 打开「思考」特效
  running: { motion: 0, expression: 'reset', params: { Param9: 1 } },
  // 待确认：闭眼笑 + 星光 + 惊喜特效（最能抓住注意力）。**只播一次**再回待机，
  // 否则"等你确认"会一直闪星星，反而变成噪音。
  // 特效刻意**不**撤：它表达的正是"还在等你"，要一直挂着。
  approval: { motion: 1, durationMs: 4000, once: true, expression: 'surprise' },
  // 提问：招牌姿势 + 张嘴 + 问号。**保持循环** —— 要一直等用户回答。
  question: { motion: 2, expression: 'question' },
  // 完成：闭眼笑 + 星光 + 开心。动作**只播一次**，然后回去荡秋千；
  // 注意桌宠状态仍是 done（未读背板继续显示），只是动作不再重复。
  // 笑眼（Param3 开心）在动作结束后**再留 2~4 秒**才撤 ——
  // 一结束就板起脸太突兀，"笑着看你一眼再恢复"更像活的。
  done: { motion: 1, durationMs: 4000, once: true, expression: 'happy', lingerMs: [2000, 4000] },
  // ⚠️ 出错：模型**没有**"困扰/失败"这类参数，只能靠眉毛+眼睛手工凑（见 ERROR_FACE），
  //    动作沿用最平静的荡秋千，避免"出错还蹦得欢"的违和感
  error: { motion: 3, expression: 'reset' },
}

/**
 * ⚠️ 这个模型同一时刻**只能有一个表情生效** ——
 * `model.expression(name)` 是"替换当前表情"，不是叠加。
 * 所以 STATE_MAP 里存的是**单个** expression 名，不要写成数组（写过，是误导）。
 * 需要多个效果同时开时，得用 `params` 直接驱动参数（如 running 的 Param9）。
 */

/** 一次性动作播完之后回到哪个动作（荡秋千） */
const BASE_MOTION = 3

/**
 * 眼神由**动作本身**负责演的动作下标，我们的眨眼要让位。
 *
 * Scene[1]（4s，happy/惊喜）就是"闭眼笑"的表演，眼睛眯起来是它的内容；
 * 如果我们还在那儿输出 ParamEyeLOpen=1，这个表情就毁了。
 */
const EYE_OWNED_MOTIONS = new Set([1])

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

/** 每帧输出眼睛开合（1 = 睁，0 = 闭） */
function applyBlink(now) {
  // 动作自己在演眼神时让位
  if (EYE_OWNED_MOTIONS.has(currentMotion)) return

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
  // 眨眼也在这里输出 —— 位置在动作之后，才能压过被动作冻结的眼睛参数
  applyBlink(performance.now())
}

/** 初始化：创建 PIXI 应用并加载模型 */
export async function init({ canvas, modelUrl, log, forceMotion, sampleMs, cachedFit, onFitReady }) {
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

  // 状态参数 +（可选）参数采样，都挂在每帧的最后一个时机
  model.internalModel.on('beforeModelUpdate', () => {
    applyState()
    samplerSample(model.internalModel.coreModel)
  })

  // 一次性动作播完 → 回基础动作。事件挂在 motionManager 上。
  model.internalModel.motionManager.on('motionFinish', () => {
    const mapped = STATE_MAP[state.currentState]
    if (mapped?.once) returnToBaseMotion()
  })

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
    } catch (error) {
      state.log(`启动调试动作失败 ${g}[${idx}]：${error.message}`)
    }
  } else {
    startMotion(BASE_MOTION, true)
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
  if (loop) return
  disableMotionLoop(index)
}

/**
 * 关掉某个动作的循环。
 *
 * 为什么需要重试：`motionManager.motionGroups[group][index]` 是**懒加载**的，
 * 刚调用 motion() 的那一刻往往还是 null（实测第一版就取不到，只能退回定时器）。
 * 而 `CubismMotion._isLoop` 是每帧读的，所以启动后几十毫秒内设上都来得及。
 */
function disableMotionLoop(index, attempt = 0) {
  const mm = state.model?.internalModel?.motionManager
  const groups = mm?.motionGroups ?? {}
  const motion = groups['Scene']?.[index]
  if (motion && typeof motion.setIsLoop === 'function') {
    motion.setIsLoop(false)
    state.log(`Scene[${index}] 已设为只播一次（第 ${attempt + 1} 次尝试）`)
    return
  }
  if (attempt === 0) {
    // 首次失败时把实际结构打出来，便于区分"还没加载"和"取错了键"
    state.log(`motionGroups 键=${JSON.stringify(Object.keys(groups))}，Scene 组长度=${groups['Scene']?.length ?? '无'}`)
  }
  if (attempt < 20) {
    setTimeout(() => disableMotionLoop(index, attempt + 1), 50)
  } else {
    state.log(`Scene[${index}] 始终取不到 motion 对象，改用定时器兜底`)
  }
}

/** 一次性动作结束后回到基础动作。
 *  ⚠️ 刻意**不**改 state.currentState —— 桌宠仍是 done（未读背板继续显示），
 *     只是动作不再重复播放。状态与动作是两件事。 */
function returnToBaseMotion() {
  if (currentMotion === BASE_MOTION) return
  state.log(`一次性动作播完 → 回到基础动作 Scene[${BASE_MOTION}]（状态仍是 ${state.currentState}）`)
  startMotion(BASE_MOTION, true)
  scheduleLinger()
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

/** 按状态切换动作 */
function playStateMotion(next) {
  const mapped = STATE_MAP[next] ?? STATE_MAP.idle
  clearTimeout(oneShotTimer)
  clearTimeout(lingerTimer) // 切状态时取消上一条待撤的特效
  startMotion(mapped.motion, !mapped.once)
  if (mapped.once) {
    // 兜底：即使 setLoop(false) 没生效，也按已知时长切回，避免一直循环。
    // 时长来自模型解析（Scene1=3s / Scene2=4s / Scene3=3s / Scene4=180s）。
    const wait = (mapped.durationMs ?? 4000) + 250
    oneShotTimer = setTimeout(() => {
      if (state.currentState === next) returnToBaseMotion()
    }, wait)
  }
}

/** 切换桌宠状态 */
export function setState(next) {
  if (next === state.currentState) return
  state.currentState = next
  const mapped = STATE_MAP[next] ?? STATE_MAP.idle
  const onceLabel = mapped.once ? '，只播一次' : ''
  state.log(`状态 → ${next}（动作 Scene[${mapped.motion}]${onceLabel}，表情 ${mapped.expression}）`)
  playStateMotion(next)
  setExpression(mapped.expression)
  if (mapped.params && Object.keys(mapped.params).length) setParams(mapped.params)
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
