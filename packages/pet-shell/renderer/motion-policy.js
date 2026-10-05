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

/** 启动时先演一次的动作：**Scene[0]**（一只手放下巴 + 右手比嘘）。演完落待机。 */
export const INTRO_MOTION = 0

export const STATE_MAP = {
  // 待机：默认就荡秋千。180 秒长循环，最像"自己待着"
  idle: { motion: BASE_MOTION, expression: 'reset' },
  /**
   * 工作中：**荡秋千 + `Param9`「思考」特效**，忙碌感靠特效 + 光球颜色表达。
   *
   * ⚠️ 这里**刻意不用 `Scene[0]`**（用户 2026-10-05 明确要求："running 时没有比嘘"）：
   *    `Scene[0]` 内部就含"右手比嘘"，而它是**循环**播放的 ——
   *    于是干活时右手会一遍又一遍地比嘘，非常聒噪 ✗
   *    改成荡秋千后：她几乎总在荡秋千，干活时多一个思考特效 + 光球变色 ✓
   *
   * ⚠️ 曾有一版注释写成"一直循环 Scene[0]（用户确认）" —— 那是我**误解了
   *    "比嘘是独立动作"**造成的（以为 running 播的是"手放下巴"那个姿势），已作废。
   *    自测里有一条专门盯着"running 不得用 INTRO_MOTION"。
   */
  running: { motion: BASE_MOTION, expression: 'reset', params: { Param9: 1 } },
  // 待确认：闭眼笑 + 星光 + 惊喜特效（最能抓住注意力）。**只播一次**再回待机，
  // 否则"等你确认"会一直闪星星，反而变成噪音。
  // 特效刻意**留着**（keepEffect）：它表达的正是"还在等你"。
  approval: { motion: 1, durationMs: 4000, once: true, expression: 'surprise', keepEffect: true },
  // 提问：招牌姿势 + 张嘴 + 问号。**保持循环** —— 要一直等用户回答。
  question: { motion: 2, expression: 'question' },
  // 完成：闭眼笑 + 星光 + 开心。**只播一次**，然后回去荡秋千；
  // 注意桌宠状态仍是 done（未读背板继续显示），只是动作不再重复。
  // 特效**演完就撤**（不设 keepEffect）—— 用户实测后明确要求：
  //   "从叉腰切换成待机后笑眼不再留存"。
  done: { motion: 1, durationMs: 4000, once: true, expression: 'happy' },
  // ⚠️ 出错：模型**没有**"困扰/失败"这类参数，只能靠眉毛+眼睛手工凑（见 ERROR_FACE），
  //    动作沿用最平静的荡秋千，避免"出错还蹦得欢"的违和感
  error: { motion: BASE_MOTION, expression: 'reset' },
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

  // ③ 其余非一次性状态：重开它自己的动作，别一律回待机
  if (typeof mapped?.motion === 'number') {
    return { action: 'restart', index: mapped.motion, why: '非一次性动作播完' }
  }

  return { action: 'none', index: null, why: '状态表里没有对应动作' }
}
