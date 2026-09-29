/**
 * 桌宠状态机 —— 纯函数，零依赖，可脱离 DSH 单测。
 *
 * 设计约束（来自 PLAN.md §三 设计要点）：
 *  1. 多会话聚合用优先级表：审批 > 提问 > 完成 > 出错 > 运行 > 空闲
 *  2. 状态切换加最短保持时间（minHoldMs），避免事件突发导致闪烁
 *  3. 纯函数：不读时钟、不碰 IO，now 由调用方传入，便于确定性测试
 *
 * 关于事件形状：本文件里的类型名与参数签名都是**从本机 0.1.7-rc.1 的 app.asar 里核实的**，
 * 不是推测。核实方式：
 *   - `grep` 出所有官方监听器写法 → `ctx.on('session/event', (session, event) => …)`
 *   - `grep` 出所有官方监听器写法 → `ctx.on('agent/assistant-stream', ({ agent, frame }) => …)`
 *   - 普查 `type:` / `kind:` 后面的 `x/y` 字面量，得到真实类型名集合
 * 但**"哪个类型对应桌宠哪一档"仍是暂定的**，装好后要用 `GET /xilian-pet/debug/shapes`
 * 收集的真实样本再定案。
 */

/** 桌宠可见状态，按优先级从高到低 */
export const STATES = ['approval', 'question', 'done', 'error', 'running', 'idle']

export const STATE_PRIORITY = {
  approval: 5,
  question: 4,
  done: 3,
  error: 2,
  running: 1,
  idle: 0,
}

/**
 * 会话事件类型 → 桌宠档位。
 * 左侧全部是 asar 里普查到的真实字面量：
 *   turn/end、step/end、user/message、system/message、tool/result、
 *   tool/code-dispatch(-start)、tool/ptc-dispatch(-start)、session/end-seed
 * 右侧的映射是**暂定**的（见文件头说明）。
 */
export const EVENT_STATE = {
  'turn/start': 'running',
  'step/start': 'running',
  'user/message': 'running',
  'tool/code-dispatch-start': 'running',
  'tool/ptc-dispatch-start': 'running',
  'tool/code-dispatch': 'running',
  'tool/ptc-dispatch': 'running',
  'tool/result': 'running',
  'step/end': 'running',
  'turn/end': 'done',
  'session/end-seed': 'idle',

  // ⚠️ 以下四个是**占位键名，尚未核实**。
  // 审批 / 提问 / 出错 / 取消 这四档在优先级表里必须有（否则状态机不完整），
  // 但我还没从 asar 里确认它们对应的真实 `event.type` 字面量。
  // 装好后先看 `/xilian-pet/debug/shapes` 收集的真实样本，再把这里换成真名。
  'attention/approval': 'approval',
  'attention/question': 'question',
  'session/error': 'error',
  'session/cancel': 'idle',
}

export function createPetState(options = {}) {
  return {
    sessions: Object.create(null),
    minHoldMs: Number.isFinite(options.minHoldMs) ? options.minHoldMs : 500,
    current: 'idle',
    currentSince: 0,
    seq: 0,
  }
}

/** 聚合后的可见状态：取所有会话里优先级最高者 */
export function aggregate(state) {
  let best = 'idle'
  for (const s of Object.values(state.sessions)) {
    if (STATE_PRIORITY[s.state] > STATE_PRIORITY[best]) best = s.state
  }
  return best
}

/** 未读计数：done / error 且未被查看的会话数（用于 +N 背板） */
export function unreadCount(state) {
  return Object.values(state.sessions).filter((s) => s.unread).length
}

function textFrom(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  for (const key of ['text', 'delta', 'content', 'message']) {
    if (typeof value[key] === 'string') return value[key]
  }
  return undefined
}

/**
 * 归一化 `session/event`。
 *
 * ⚠️ 真实签名是 **两个参数**：`(session, event)` —— 已核实所有官方监听器都这么写。
 * 事件本体在第二个参数上，形如 `{ type, seq, data }`。
 */
export function normalizeSessionEvent(session, event) {
  if (event === null || typeof event !== 'object') return null
  if (typeof event.type !== 'string') return null
  const sessionId = session?.id ?? session?.header?.id ?? session?.header?.sessionId ?? 'unknown'
  const title = session?.header?.title
  return {
    kind: event.type,
    sessionId: String(sessionId),
    text: textFrom(event.data),
    title: typeof title === 'string' ? title : undefined,
  }
}

/**
 * 归一化 `agent/assistant-stream`。
 *
 * ⚠️ 真实签名是**一个对象** `({ agent, frame })`（已核实）。
 * 帧结构同样是从 asar 的类型清单里抄出来的，不是猜的：
 *
 *   type SessionAssistantStreamFrame =
 *     | { type: 'start'; attemptId; revision; turn; step; … }
 *     | { type: 'chunk'; attemptId; revision; index; time; chunk: StreamChunk }
 *     | { type: 'end';   attemptId; revision; index; outcome: { kind: 'committed'|'abandoned' } }
 *
 *   type StreamChunk =
 *     | { type: 'block-start'; index; blockType } | { type: 'text-delta'; index; text }
 *     | { type: 'reasoning-delta'; index; text }  | { type: 'tool-call-delta'; … }
 *     | { type: 'block-end'; index; block }       | { type: 'usage'; … } | { type: 'finish'; … }
 *
 * 所以正文文本在 **`frame.chunk.text`**，且 `frame.chunk.type === 'text-delta'`。
 * （第一版找的是 `frame.text`，永远取不到 —— 这也是"先读源码再写"的又一个理由。）
 */
export function normalizeStreamChunk(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const { agent, frame } = payload
  if (frame === null || typeof frame !== 'object') return null
  const sessionId = agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? 'unknown'
  const inner = frame.chunk
  const innerIsObject = inner !== null && typeof inner === 'object'
  return {
    sessionId: String(sessionId),
    frameType: typeof frame.type === 'string' ? frame.type : undefined,
    chunkType: innerIsObject && typeof inner.type === 'string' ? inner.type : undefined,
    text: innerIsObject && typeof inner.text === 'string' ? inner.text : undefined,
    turn: frame.turn,
    step: frame.step,
    outcome: typeof frame.outcome?.kind === 'string' ? frame.outcome.kind : undefined,
  }
}

/**
 * 复核聚合状态并按最短保持时间决定是否切换。
 * 升优先级立即生效；降优先级需等满 minHoldMs。
 * @returns {{ state: object, frames: Array<object> }}
 */
export function evaluate(state, now) {
  const frames = []
  const agg = aggregate(state)
  if (agg === state.current) return { state, frames }

  const held = now - state.currentSince < state.minHoldMs
  const rising = STATE_PRIORITY[agg] > STATE_PRIORITY[state.current]
  if (rising || !held) {
    const next = { ...state, current: agg, currentSince: now, seq: state.seq + 1 }
    frames.push({ type: 'state', seq: next.seq, state: agg, unread: unreadCount(next) })
    return { state: next, frames }
  }
  return { state, frames }
}

/**
 * 没有新事件时释放被最短保持时间压住的状态切换。
 * 必须由调用方周期调用，否则降优先级会永久卡住。
 */
export function releaseHeld(state, now) {
  return evaluate(state, now)
}

function sessionOf(state, sessionId, now) {
  return (
    state.sessions[sessionId] ?? {
      sessionId,
      state: 'idle',
      unread: false,
      since: now,
      title: undefined,
      tail: '',
    }
  )
}

/**
 * 应用一个会话事件。
 * @returns {{ state: object, frames: Array<object> }} 新状态 + 需要推送的帧
 */
export function reducePetEvent(state, ev, now = 0) {
  const target = EVENT_STATE[ev.kind]
  if (target === undefined) return { state, frames: [] }

  const prev = sessionOf(state, ev.sessionId, now)
  const session = { ...prev }
  if (ev.title !== undefined) session.title = ev.title

  if (target === 'done' || target === 'error') session.unread = true
  if (target === 'running' || target === 'approval' || target === 'question') session.unread = false
  if (target !== prev.state) session.since = now
  session.state = target

  const next = { ...state, sessions: { ...state.sessions, [ev.sessionId]: session } }
  const evaluated = evaluate(next, now)
  const frames = [...evaluated.frames]

  // 状态没变但未读计数可能变了，补一帧让前端跟上
  if (frames.length === 0) {
    frames.push({
      type: 'state',
      seq: evaluated.state.seq,
      state: evaluated.state.current,
      unread: unreadCount(evaluated.state),
    })
  }

  return { state: evaluated.state, frames }
}

/**
 * 应用一个逐字流帧。与状态事件分开，是因为它只累积 tail、决定"是否在跑"、发 stream 帧。
 * 帧语义按官方类型定义：
 *   - `start` 帧、`chunk` + `text-delta` → 这一回合在跑
 *   - `end` 帧**不**改状态（一个 attempt 结束不代表整个回合结束，回合边界交给 session/event）
 */
export function reduceStreamChunk(state, chunk, now = 0) {
  const prev = sessionOf(state, chunk.sessionId, now)
  const session = { ...prev }
  const hasText = typeof chunk.text === 'string' && chunk.text !== ''
  if (hasText) session.tail = (prev.tail + chunk.text).slice(-180)

  const looksBusy = chunk.frameType === 'start' || chunk.chunkType === 'text-delta'
  if (looksBusy && (session.state === 'idle' || session.state === 'done')) {
    session.state = 'running'
    session.unread = false
    session.since = now
  }

  const next = { ...state, sessions: { ...state.sessions, [chunk.sessionId]: session } }
  const evaluated = evaluate(next, now)

  const frames = []
  if (hasText) {
    frames.push({
      type: 'stream',
      sessionId: chunk.sessionId,
      text: session.tail,
      chunkType: chunk.chunkType,
    })
  }
  frames.push(...evaluated.frames)
  return { state: evaluated.state, frames }
}

export function snapshot(state) {
  return {
    state: state.current,
    unread: unreadCount(state),
    seq: state.seq,
    sessions: Object.values(state.sessions).map((s) => ({
      sessionId: s.sessionId,
      state: s.state,
      unread: s.unread,
      title: s.title,
      tail: s.tail,
    })),
  }
}
