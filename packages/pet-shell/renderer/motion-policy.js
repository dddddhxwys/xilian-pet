/**
 * 动作播完后的决策 —— **纯函数**，好让自测脱离 Electron 也能盯住这个 bug。
 *
 * 背景（实机 bug，2026-10-04）：用户报"昔涟在长时间待机之后会退出待机动作"。
 *  - 待机动作是 `Scene[3]`（荡秋千），模型里时长 **180 秒** → 症状是"待机几分钟后不动"
 *  - `motion.setIsLoop(true)` 设得上（日志可见）但**不生效**，库照样在时长结束后
 *    派发 `motionFinish` 把动作停掉
 *  - 于是必须由我们在 `motionFinish` 里把它重开
 *
 * 这里最容易错的一点：**不能只看 currentState 决定**。
 * 一次性状态（尤其 `done`）刻意保留 `currentState` 不切走（未读背板要一直显示），
 * 此时实际在播的已经是待机动作了。若只看状态 → 走进"一次性动作结束 → 回待机"，
 * 而它开头是 `if (currentMotion === baseMotion) return` → **直接返回、没人重开**
 * → 她就永远停在最后一帧。这正是当时漏掉的路径（我的第一次修复只覆盖了 idle）。
 *
 * ── 状态 → 动作 映射表也放在这里 ──────────────────────────────────
 * 放在纯模块里是为了**能被自测直接断言**（live2d.js 依赖 PIXI 全局，Node 里 import 不了）。
 * 目前被测试锁住的设计决定："**running 不许用含「比嘘」的动作**"（见 running 的注释）。
 */

/** 待机/基础动作：荡秋千（180 秒长循环） */
export const BASE_MOTION = 3

/**
 * 手/姿势类道具：模型 `cdi3.json` 里**同属参数组 5**，是**互斥**的姿势开关。
 *
 * ```
 * 组5: Param9 思考 | Param12 手指 | Param10/11 招牌 | Param13/14 秋千(抓绳) | Param17/18 叉腰
 * 组6: Param32 秋千开关 | Param31 秋千特殊 | Param19~24 摇晃      ← 这才是"摆"
 * ```
 *
 * ⚠️ 这条是"手不抓着秋千绳"的**关键**：光关 `Param16 绳子`（道具）没用 ——
 *    **抓绳的姿势**是组 5 里的 `Param13/14 秋千` 画出来的 ✗
 *    所以在 running 里必须把组 5 **除 `Param9` 外全部压 0**，
 *    同时**保留组 6**（摆动/秋千本体）→ 她在荡、但手不抓绳、手放下巴 ✓
 */
const HAND_POSE_PARAMS = ['Param10', 'Param11', 'Param12', 'Param13', 'Param14', 'Param17', 'Param18']

/** running 的压制：留"思考"，关掉其它手部姿势 + 绳子道具 */
const THINKING_ONLY = {
  Param9: 1,
  Param16: 0, // 绳子不画
  ...Object.fromEntries(HAND_POSE_PARAMS.map((id) => [id, 0])),
}

/** 非 running 状态：把"思考的手"压回 0（秋千动作自己会把它推到 1，会多出一只手） */
const THINKING_OFF = { Param9: 0 }

/** 启动时先演一次的动作：**Scene[0]**（一只手放下巴 + 右手比嘘）。演完落待机。 */
export const INTRO_MOTION = 0

export const STATE_MAP = {
  // 待机：默认就荡秋千。180 秒长循环，最像"自己待着"
  idle: { motion: BASE_MOTION, expression: 'reset', force: THINKING_OFF },
  /**
   * 工作中：**也在荡秋千**，但**不抓绳**、手放在下巴（思考）。
   *
   * 用户 2026-10-05 要求："让思考时也在荡秋千，但是手不抓着秋千绳"。
   *  - 动作 = 荡秋千（`BASE_MOTION`）→ 她一直摆 ✓
   *  - `force.Param9 = 1` → 思考的手（放下巴）✓
   *  - `force.Param16 = 0` → **绳子不画** → 手不去抓绳 ✓
   *
   * ⚠️ 必须用 `force` 而不是 `params`：秋千动作**每帧**都会把这些参数写回去
   *    （模型文件里 Scene4 的 `Param9` 曲线就是 0~1），只有"动作之后、渲染之前"
   *    （`beforeModelUpdate`）再写一遍才压得住。这也是"三只手"反复出现的真因。
   *
   * ⚠️ 历史：这里试过 `motion: null`（完全不播动作）—— 那样不会比嘘，
   *    但荡秋千也一起没了；用户后来要求"思考时也在荡秋千"，所以改回播动作 + 压制道具。
   */
  running: {
    motion: BASE_MOTION,
    expression: 'reset',
    params: { Param9: 1 },
    force: THINKING_ONLY,
  },
  // 待确认：闭眼笑 + 星光 + 惊喜特效（最能抓住注意力）。**只播一次**再回待机，
  // 否则"等你确认"会一直闪星星，反而变成噪音。
  // 特效刻意**留着**（keepEffect）：它表达的正是"还在等你"。
  approval: {
    motion: 1,
    durationMs: 4000,
    once: true,
    expression: 'surprise',
    keepEffect: true,
    force: THINKING_OFF,
  },
  // 提问：招牌姿势 + 张嘴 + 问号。**保持循环** —— 要一直等用户回答。
  question: { motion: 2, expression: 'question', force: THINKING_OFF },
  // 完成：闭眼笑 + 星光 + 开心。**只播一次**，然后回去荡秋千；
  // 注意桌宠状态仍是 done（未读背板继续显示），只是动作不再重复。
  // 特效**演完就撤**（不设 keepEffect）—— 用户实测后明确要求：
  //   "从叉腰切换成待机后笑眼不再留存"。
  done: { motion: 1, durationMs: 4000, once: true, expression: 'happy', force: THINKING_OFF },
  // ⚠️ 出错：模型**没有**"困扰/失败"这类参数，只能靠眉毛+眼睛手工凑（见 ERROR_FACE），
  //    动作沿用最平静的荡秋千，避免"出错还蹦得欢"的违和感
  error: { motion: BASE_MOTION, expression: 'reset', force: THINKING_OFF },
}

/**
 * 由 `params` 直接写入的参数，切状态时要把新状态里没有的那些**清零**。
 *
 * ⚠️ 为什么需要：`setParams` 只写指定参数、**不会重置其它的**。
 *    `running` 的 `Param9`「思考」若不撤，离开 running 之后特效会一直挂着。
 *
 * @param {Record<string, number>} applied 上一次写入的参数
 * @param {{params?: Record<string, number>}|undefined} mapped 新状态
 * @returns {{clear: string[], set: Record<string, number>}}
 */
export function planParamTransition(applied, mapped) {
  const next = mapped?.params ?? {}
  const clear = Object.keys(applied ?? {}).filter((id) => !(id in next))
  return { clear, set: { ...next } }
}

/**
 * 道具渐变的插值 —— 纯函数，便于自测。
 *
 * ⚠️ 为什么需要渐变：切到"不播动作"的状态（running）时，如果把 32 个道具参数
 *    **一帧内清零**，秋千绳/秋千道具会**瞬间消失**、思考姿势**瞬间出现** ——
 *    实机观感就是"荡秋千 → 思考中间没有衔接"（用户原话）。
 *    改成约 300ms 的缓出渐变，两个方向都有过渡。
 *
 * @param {Record<string, number>} from 起始值（一般是"当前实际值"）
 * @param {Record<string, number>} to   目标值
 * @param {number} progress 0..1
 * @returns {Record<string, number>} 该写进模型的参数
 */
export function fadeProps(from, to, progress) {
  const t = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 1))
  const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic：起步快、收尾稳
  const ids = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])
  const out = {}
  for (const id of ids) {
    const a = from?.[id] ?? 0
    const b = to?.[id] ?? 0
    out[id] = a + (b - a) * eased
  }
  return out
}

/**
 * 某个状态的"道具目标值"。
 *
 * 规则：所有道具开关先归 **0**（把上一个动作留下的绳子/手/叉腰等全关掉），
 * 再叠加**本状态自己**要开的（如 running 的 `Param9`）。
 * 这样切到 running 时 = 全身道具平滑熄掉、只剩思考 ✓ 不会出现"残道具叠多手多脚"。
 *
 * @param {{params?: Record<string, number>}|undefined} mapped 状态映射
 * @param {string[]} propIds 道具参数 id 列表（`Param`/`Param2..Param32`）
 */
export function propTargetsFor(mapped, propIds) {
  const out = {}
  for (const id of propIds) out[id] = 0
  for (const [id, value] of Object.entries(mapped?.params ?? {})) out[id] = value
  return out
}

/**
 * 切换状态时的**两段式**道具渐变计划 —— 纯函数，便于自测。
 *
 * ⚠️ 为什么不能"交叉淡入淡出"：道具里包含**互斥的手/姿势**（`Param9` 思考的手、
 *    `Param12` 手指、`Param17/18` 叉腰…）。同时淡出旧手 + 淡入新手 → **两只手同时可见**
 *    → 又变"三只手"（用户实测："修出问题了，现在又有三只手了"）。
 *    所以必须先**全部熄掉**，**再**点起本状态要的 —— 两段错开，绝不重叠。
 *
 * @param {{params?: Record<string, number>}|undefined} mapped 状态映射
 * @param {string[]} propIds 道具参数 id
 * @returns {[Record<string, number>, Record<string, number>]} [第一段：全熄, 第二段：本状态目标]
 */
export function propFadePhases(mapped, propIds) {
  const allOff = {}
  for (const id of propIds) allOff[id] = 0
  return [allOff, propTargetsFor(mapped, propIds)]
}

/**
 * 「被手指弹了一下」的阻尼振荡 —— 纯函数，便于自测。
 *
 * 用户要求：单击秋千 → **整个模型弹一下**，像被手指弹了似的（选"角色本体会颤"、"轻"）。
 *
 * 波形：`e^(-t/decay) · sin(2πft)`，再乘各自的幅度。
 *  - 起手必须是 0（不能"啪"地跳到位）→ `sin(0)=0` ✓
 *  - 结尾必须衰减到 ~0（否则松手时会留位移）→ `e^(-∞)=0` ✓
 *
 * @param {number} elapsedMs 从被弹开始的毫秒数
 * @param {{freqHz:number, decayMs:number}} preset
 * @returns {number} -1..1 的位移倍率（乘幅度后加到参数上）
 */
export function flickOffset(elapsedMs, preset) {
  if (!(elapsedMs >= 0)) return 0
  const decay = Math.exp(-elapsedMs / preset.decayMs)
  const wave = Math.sin((2 * Math.PI * preset.freqHz * elapsedMs) / 1000)
  return decay * wave
}

/**
 * 三档力度。
 *
 * 分三层叠加，从外到内都动起来才像"整个模型被弹了一下"：
 *  1. `move` —— **模型容器整体**的位移/旋转（"整个模型"被弹，最外层）
 *  2. `amp`  —— 身体/头部角度参数（内部跟着颤）
 *  3. 秋千与腿脚摇晃参数（挂着的部件跟着荡）
 *
 * 单位：`px` 是舞台 CSS 像素；`rot` 是弧度；`amp` 里模型角度参数的单位是度（正常范围 ±30）。
 */
export const FLICK_PRESETS = {
  light: {
    durationMs: 600,
    freqHz: 3.3,
    decayMs: 170,
    move: { px: 7, up: 3, rot: 0.018 },
    amp: { ParamAngleZ: 5, ParamBodyAngleZ: 3, ParamBodyAngleX: 2, Param23: 6, Param24: 6, Param19: 4, Param20: 4 },
  },
  medium: {
    durationMs: 1000,
    freqHz: 3.0,
    decayMs: 280,
    move: { px: 14, up: 7, rot: 0.04 },
    amp: { ParamAngleZ: 10, ParamBodyAngleZ: 6, ParamBodyAngleX: 4, Param23: 12, Param24: 12, Param19: 7, Param20: 7 },
  },
  strong: {
    durationMs: 1500,
    freqHz: 2.8,
    decayMs: 420,
    move: { px: 24, up: 12, rot: 0.07 },
    amp: { ParamAngleZ: 16, ParamBodyAngleZ: 10, ParamBodyAngleX: 7, Param23: 18, Param24: 18, Param19: 11, Param20: 11 },
  },
}

/**
 * @param {object} p
 * @param {number|null} p.currentMotion 目前记录的动作下标（startMotion 时写入）
 * @param {string} p.currentState       桌宠状态名
 * @param {Record<string, {motion:number, once?:boolean}>} p.stateMap
 * @param {number} p.baseMotion         待机动作下标
 * @returns {{action:'restart'|'base'|'none', index:number|null, why:string}}
 *   - restart: 直接重开 index 这个动作（它就是刚停下的那个）
 *   - base:    一次性动作演完，切回 baseMotion
 *   - none:    不做任何事
 */
export function decideOnMotionFinish({ currentMotion, currentState, stateMap, baseMotion }) {
  // ① 刚停下的是**待机动作本身** → 重开它。
  //    必须放在看状态之前：done/running/… 都可能正在播待机动作。
  if (currentMotion === baseMotion) {
    return { action: 'restart', index: baseMotion, why: '刚播完的是待机动作' }
  }

  const mapped = stateMap[currentState]

  // ② 一次性动作演完 → 回待机（returnToBaseMotion 会处理特效等）
  if (mapped?.once) {
    return { action: 'base', index: baseMotion, why: '一次性动作演完' }
  }

  // ③ `motion === null` = 这个状态本来就不播动作（running）→ 什么都不做
  if (mapped?.motion === null) {
    return { action: 'none', index: null, why: '该状态不播动作' }
  }

  // ④ 其余非一次性状态：重开它自己的动作，别一律回待机
  if (typeof mapped?.motion === 'number') {
    return { action: 'restart', index: mapped.motion, why: '非一次性动作播完' }
  }

  return { action: 'none', index: null, why: '状态表里没有对应动作' }
}
