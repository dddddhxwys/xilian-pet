/**
 * 桌宠状态机 —— 纯函数，零依赖，可脱离 DSH 单测。
 *
 * 设计约束（来自 PLAN.md §三 设计要点）：
 *  1. 多会话聚合用优先级表：审批 > 提问 > 完成 > 出错 > 运行 > 空闲
 *  2. 状态切换加最短保持时间（minHoldMs），避免事件突发导致闪烁
 *  3. 纯函数：不读时钟、不碰 IO，now 由调用方传入，便于确定性测试
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

/** 事件种类 → 会话状态 */
export const EVENT_STATE = {
  'session/start': 'running',
  'turn/start': 'running',
  'step/start': 'running',
  'tool/start': 'running',
  'assistant/stream': 'running',
  'tool/end': 'running',
  'turn/end': 'running',
  'attention/approval': 'approval',
  'attention/question': 'question',
  'session/done': 'done',
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

/**
 * 归一化一个原始事件为内部事件。识别不了的形状返回 null —— 不做猜测，
 * 由调用方记入形状样本，供真实运行时确认。
 */
export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const kind = raw.kind ?? raw.type ?? raw.event ?? raw.name
  if (typeof kind !== 'string') return null
  const sessionId = raw.sessionId ?? raw.session?.id ?? raw.session?.sessionId ?? raw.id ?? 'unknown'
  return {
    kind,
    sessionId: String(sessionId),
    text: typeof raw.text === 'string' ? raw.text : typeof raw.delta === 'string' ? raw.delta : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
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

/**
 * 应用一个内部事件。
 * @returns {{ state: object, frames: Array<object> }} 新状态 + 需要推送的帧
 */
export function reducePetEvent(state, ev, now = 0) {
  const target = EVENT_STATE[ev.kind]
  if (target === undefined) return { state, frames: [] }

  const prev = state.sessions[ev.sessionId] ?? {
    sessionId: ev.sessionId,
    state: 'idle',
    unread: false,
    since: now,
    title: undefined,
    tail: '',
  }
  const session = { ...prev }
  if (ev.title !== undefined) session.title = ev.title

  const streamed = ev.kind === 'assistant/stream'
  if (streamed) {
    session.tail = (session.tail + (ev.text ?? '')).slice(-180)
  }

  if (target === 'done' || target === 'error') session.unread = true
  if (target === 'running' || target === 'approval' || target === 'question') session.unread = false
  if (target !== prev.state) session.since = now
  session.state = target

  const next = { ...state, sessions: { ...state.sessions, [ev.sessionId]: session } }

  // 流式增量不改变聚合状态，单独发 stream 帧即可
  if (streamed && aggregate(next) === state.current) {
    return { state: next, frames: [{ type: 'stream', sessionId: ev.sessionId, text: session.tail }] }
  }

  const evaluated = evaluate(next, now)
  const frames = streamed
    ? [{ type: 'stream', sessionId: ev.sessionId, text: session.tail }, ...evaluated.frames]
    : evaluated.frames

  // 状态未变但未读计数可能变了，补一帧让前端跟上
  if (frames.length === 0) {
    frames.push({ type: 'state', seq: evaluated.state.seq, state: evaluated.state.current, unread: unreadCount(evaluated.state) })
  }

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
