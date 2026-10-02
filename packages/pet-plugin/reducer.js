/**
 * 桌宠状态机 —— 纯函数，零依赖，可脱离 DSH 单测。
 *
 * 设计约束（来自 PLAN.md §三 设计要点）：
 *  1. 多会话聚合用优先级表：审批 > 提问 > 完成 > 出错 > 运行 > 空闲
 *  2. 状态切换加最短保持时间（minHoldMs），避免事件突发导致闪烁
 *  3. 纯函数：不读时钟、不碰 IO，now 由调用方传入，便于确定性测试
 *
 * ⚠️ 本文件里的事件名、签名、载荷结构**全部来自本机 0.1.7-rc.1 的 app.asar**，
 * 不是推测。取证方式：读官方类型清单里的 `SessionEventMap` / `KNOWN_SESSION_EVENT_TYPES`、
 * 以及官方监听器的真实写法。改动前请沿用同样的取证方式。
 *
 * 权威依据（摘录）：
 *   type AgentStatus = 'idle' | 'running'
 *   type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
 *   interface SessionEventMap {
 *     'turn/start': { turn } · 'turn/end': { turn; reason } · 'step/start' · 'step/end'
 *     'approval/asked':   { id; toolName; callId?; reason? }
 *     'approval/decided': { id; outcome: ApprovalOutcome }
 *     'assistant/message': { turn; step; message; stream; usage?; interrupted? }
 *     …
 *   }
 *   ctx.on('agent/status', ({ agent, status }) => …)   // 载荷是 { agent, status }
 *   ctx.on('agent/error',  ({ agent, turn, error }) => …)
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
 * 左侧全部是官方 `KNOWN_SESSION_EVENT_TYPES`（共 59 个）里确有其名的类型。
 * 「空闲」不在这里 —— 它由 `agent/status` 权威给出（见 reduceAgentStatus）。
 */
export const EVENT_STATE = {
  // —— 运行中 ——
  'turn/start': 'running',
  'step/start': 'running',
  'user/message': 'running',
  'request/header': 'running',
  'assistant/attempt': 'running',
  'assistant/message': 'running',
  'tool/call': 'running',
  'tool/result': 'running',
  'tool/ptc-dispatch-start': 'running',
  'tool/ptc-dispatch': 'running',
  'tool-workflow/run-start': 'running',
  'tool-workflow/agent-start': 'running',
  'compaction/start': 'running',
  // —— 需要你处理 ——
  'approval/asked': 'approval',
  // 审批有了结论：回到运行，真正的空档交给 agent/status
  'approval/decided': 'running',
  // 注：turn/end 不在这里 —— 它的落点取决于 reason.kind，见 TURN_END_STATE
}

/**
 * `turn/end` 的落点，按官方 `TurnEndReasonMap` 的七种 reason.kind 分流。
 * 依据（asar 类型清单原文）：
 *   completed | aborted{reason} | blocked | error{error} | max-tokens | interrupted | forked
 *
 * 关键区别：**被打断（用户主动）不该亮"完成 + 未读"** —— 那是用户自己干的，
 * 给他一个红点提醒纯属噪音。
 */
export const TURN_END_STATE = {
  completed: { state: 'done', unread: true },
  'max-tokens': { state: 'done', unread: true },
  forked: { state: 'done', unread: true },
  aborted: { state: 'idle', unread: false },
  interrupted: { state: 'idle', unread: false },
  blocked: { state: 'idle', unread: false },
  error: { state: 'error', unread: true },
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

/** 待审批总数（A7 主动提醒的原料） */
export function pendingApprovalCount(state) {
  return Object.values(state.sessions).reduce((sum, s) => sum + (s.pendingApprovals ?? 0), 0)
}

/** 是否有会话在忙（提醒引擎判断"工作段"用） */
export function hasActivity(state) {
  return Object.values(state.sessions).some(
    (s) => s.state === 'running' || s.state === 'approval' || s.state === 'question',
  )
}

/** 各会话累计 token（提醒引擎判断花销用） */
export function spendBySession(state) {
  const out = Object.create(null)
  for (const s of Object.values(state.sessions)) {
    const tokens = s.spendTokens ?? 0
    if (tokens > 0) out[s.sessionId] = tokens
  }
  return out
}

function textFrom(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  for (const key of ['text', 'delta', 'content', 'message']) {
    if (typeof value[key] === 'string') return value[key]
  }
  return undefined
}

function sessionIdOf(session) {
  return String(session?.id ?? session?.header?.id ?? session?.header?.sessionId ?? 'unknown')
}

/**
 * 归一化 `session/event`。
 *
 * ⚠️ 真实签名是**两个参数** `(session, event)` —— 官方监听器一律这么写。
 * 事件本体在第二个参数，形如 `{ type, seq, data }`；`data` 的类型由 SessionEventMap 决定。
 */
export function normalizeSessionEvent(session, event) {
  if (event === null || typeof event !== 'object') return null
  if (typeof event.type !== 'string') return null
  const title = session?.header?.title
  return {
    kind: event.type,
    sessionId: sessionIdOf(session),
    seq: typeof event.seq === 'number' ? event.seq : undefined,
    data: event.data,
    text: textFrom(event.data),
    title: typeof title === 'string' ? title : undefined,
  }
}

/**
 * 归一化 `agent/status`。载荷 `{ agent, status }`，status 只有 'idle' | 'running'。
 * 这是**权威**的运行/空闲信号 —— 官方说明 "agent/status … drive UI and coordination state"。
 */
export function normalizeAgentStatus(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const { agent, status } = payload
  if (status !== 'idle' && status !== 'running') return null
  return {
    sessionId: String(agent?.session?.id ?? agent?.id ?? 'unknown'),
    status,
  }
}

/** 归一化 `agent/error`。载荷 `{ agent, turn, error }`。 */
export function normalizeAgentError(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const { agent, error } = payload
  return {
    sessionId: String(agent?.session?.id ?? agent?.id ?? 'unknown'),
    message: String(error?.message ?? error ?? 'unknown error'),
  }
}

/**
 * 归一化 `agent/assistant-stream`。
 *
 * 真实签名是**一个对象** `({ agent, frame })`。帧结构（官方类型清单原文）：
 *   type SessionAssistantStreamFrame =
 *     | { type: 'start'; attemptId; revision; turn; step; … }
 *     | { type: 'chunk'; attemptId; revision; index; time; chunk: StreamChunk }
 *     | { type: 'end';   attemptId; revision; index; outcome: { kind: 'committed'|'abandoned' } }
 *   type StreamChunk = … | { type: 'text-delta'; index; text } | …
 * 所以正文在 **`frame.chunk.text`**，且 `frame.chunk.type === 'text-delta'`。
 */
export function normalizeStreamChunk(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const { agent, frame } = payload
  if (frame === null || typeof frame !== 'object') return null
  const inner = frame.chunk
  const innerIsObject = inner !== null && typeof inner === 'object'
  return {
    sessionId: String(agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? 'unknown'),
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
      pendingApprovals: 0,
      spendTokens: 0,
    }
  )
}

function commit(state, session, sessionId, now, extraFrames = []) {
  // 打"最近活跃"点 —— primarySessionId() 靠它挑派活目标
  const stamped = { ...session, lastActivityAt: now }
  const next = { ...state, sessions: { ...state.sessions, [sessionId]: stamped } }
  const evaluated = evaluate(next, now)
  const frames = [...extraFrames, ...evaluated.frames]
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
 * 应用 `turn/end`。按 `reason.kind` 分流；识别不了的 reason 保守当作 completed。
 */
export function reduceTurnEnd(state, ev, now = 0) {
  const reasonKind = typeof ev.data?.reason?.kind === 'string' ? ev.data.reason.kind : undefined
  const mapped = TURN_END_STATE[reasonKind] ?? TURN_END_STATE.completed

  const prev = sessionOf(state, ev.sessionId, now)
  const session = { ...prev }
  if (ev.title !== undefined) session.title = ev.title
  session.state = mapped.state
  session.unread = mapped.unread
  session.since = now

  const extraFrames = []
  if (mapped.state === 'error') {
    extraFrames.push({
      type: 'notice',
      notice: 'error',
      sessionId: ev.sessionId,
      message: String(ev.data?.reason?.error?.message ?? 'turn ended with error'),
    })
  } else if (mapped.state === 'done') {
    extraFrames.push({ type: 'notice', notice: 'turn-completed', sessionId: ev.sessionId })
  }
  return commit(state, session, ev.sessionId, now, extraFrames)
}

/**
 * 应用一个会话事件。
 * @returns {{ state: object, frames: Array<object> }} 新状态 + 需要推送的帧
 */
export function reducePetEvent(state, ev, now = 0) {
  // turn/end 的落点取决于 reason.kind，交给专门的分支
  if (ev.kind === 'turn/end') return reduceTurnEnd(state, ev, now)

  const target = EVENT_STATE[ev.kind]
  if (target === undefined) return { state, frames: [] }

  const prev = sessionOf(state, ev.sessionId, now)
  const session = { ...prev }
  if (ev.title !== undefined) session.title = ev.title

  const extraFrames = []

  // 花销累计：assistant/message 带 usage（官方 TokenUsage：inputTokens/outputTokens/totalTokens…）
  if (ev.kind === 'assistant/message' && ev.data?.usage !== null && typeof ev.data?.usage === 'object') {
    const usage = ev.data.usage
    const total =
      typeof usage.totalTokens === 'number'
        ? usage.totalTokens
        : Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0)
    if (Number.isFinite(total) && total > 0) session.spendTokens = (prev.spendTokens ?? 0) + total
  }

  // 审批计数：A7 主动提醒的原料，也是 "+N 背板" 的来源之一
  if (ev.kind === 'approval/asked') {
    session.pendingApprovals = (prev.pendingApprovals ?? 0) + 1
    extraFrames.push({
      type: 'notice',
      notice: 'approval',
      sessionId: ev.sessionId,
      toolName: typeof ev.data?.toolName === 'string' ? ev.data.toolName : undefined,
      reason: typeof ev.data?.reason === 'string' ? ev.data.reason : undefined,
      pending: session.pendingApprovals,
    })
  } else if (ev.kind === 'approval/decided') {
    session.pendingApprovals = Math.max(0, (prev.pendingApprovals ?? 0) - 1)
    extraFrames.push({
      type: 'notice',
      notice: 'approval-decided',
      sessionId: ev.sessionId,
      outcome: typeof ev.data?.outcome === 'string' ? ev.data.outcome : undefined,
      pending: session.pendingApprovals,
    })
  }

  if (target === 'done' || target === 'error') session.unread = true
  if (target === 'running' || target === 'approval' || target === 'question') session.unread = false
  if (target !== prev.state) session.since = now
  session.state = target

  return commit(state, session, ev.sessionId, now, extraFrames)
}

/**
 * 应用 `agent/status`（权威运行/空闲信号）。
 *
 * 刻意**不冲掉** done / error —— 它们携带未读语义，等用户看过再降档。
 * 这条同时治掉了"状态挂住"：以前没有任何事件能把会话降回 idle。
 */
export function reduceAgentStatus(state, { sessionId, status }, now = 0) {
  const prev = sessionOf(state, sessionId, now)
  const session = { ...prev }
  let changed = false

  if (status === 'running') {
    if (session.state !== 'running') {
      session.state = 'running'
      session.unread = false
      session.since = now
      changed = true
    }
  } else if (status === 'idle') {
    if (session.state === 'running' || session.state === 'approval' || session.state === 'question') {
      session.state = 'idle'
      session.since = now
      changed = true
    }
  }
  if (!changed) return { state, frames: [] }
  return commit(state, session, sessionId, now)
}

/** 应用 `agent/error`（agent 级错误，带未读）。 */
export function reduceAgentError(state, { sessionId, message }, now = 0) {
  const prev = sessionOf(state, sessionId, now)
  const session = { ...prev, state: 'error', unread: true, since: now, lastError: message }
  return commit(state, session, sessionId, now, [
    { type: 'notice', notice: 'error', sessionId, message },
  ])
}

/**
 * 应用一个逐字流帧。帧语义按官方类型定义：
 *   - `start` 帧、`chunk` + `text-delta` → 这一回合在跑
 *   - `end` 帧**不**改状态（一个 attempt 结束不代表整个回合结束，空档交给 agent/status）
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

/**
 * 挑出"当前最相关"的会话 id —— 派活/打断在渲染端没给 sessionId（或给的已失效）时的兜底目标。
 *
 * 判据以**最近活跃**为主，而不是状态优先级：桌宠是给"你正在用的那个 agent"派活，
 * 而按优先级挑会挑到一个早已结束的 `done` 会话（`done` 优先级 3 > `running` 1）
 * —— 那等于把活派给一个已经结束的会话。活跃时间打平时才用状态优先级兜底。
 *
 * `lastActivityAt` 由 commit() 打点；极老的会话记录没有该字段时退回 `since`。
 */
export function primarySessionId(state) {
  const list = Object.values(state.sessions).filter(
    (s) => typeof s.sessionId === 'string' && s.sessionId !== '' && s.sessionId !== 'unknown',
  )
  if (list.length === 0) return undefined
  const activity = (s) => s.lastActivityAt ?? s.since ?? 0
  const best = list.reduce((a, b) => {
    const ta = activity(a)
    const tb = activity(b)
    if (ta !== tb) return tb > ta ? b : a
    return (STATE_PRIORITY[b.state] ?? 0) > (STATE_PRIORITY[a.state] ?? 0) ? b : a
  })
  return best.sessionId
}

export function snapshot(state) {
  return {
    state: state.current,
    unread: unreadCount(state),
    pendingApprovals: pendingApprovalCount(state),
    seq: state.seq,
    // 渲染端拿不到 sessionId 时的兜底目标（也是 /prompt、/interrupt 的兜底目标）
    primarySessionId: primarySessionId(state) ?? null,
    sessions: Object.values(state.sessions).map((s) => ({
      sessionId: s.sessionId,
      state: s.state,
      unread: s.unread,
      pendingApprovals: s.pendingApprovals ?? 0,
      spendTokens: s.spendTokens ?? 0,
      title: s.title,
      tail: s.tail,
    })),
  }
}
