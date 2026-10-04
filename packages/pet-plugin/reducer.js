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

/** 工具名 → 一句人话。桌宠气泡只显示这个，**不显示 AI 原文**（用户反馈：输出太多看不清）。 */
const TOOL_LABELS = {
  pwsh: '执行了命令',
  shell: '执行了命令',
  read: '读取了文件',
  edit: '修改了文件',
  write: '写了文件',
  grep: '搜索了代码',
  glob: '查找了文件',
  list: '列了目录',
  web_search: '联网搜索了',
  web_fetch: '抓取了网页',
  ask_user_question: '向你提了问题',
  subagent: '派了子任务',
  subagent_fork: '派了子任务',
  goal: '更新了目标',
}

function toolLabel(name) {
  if (typeof name !== 'string' || name === '') return '执行了一步操作'
  return TOOL_LABELS[name.toLowerCase()] ?? `执行了 ${name}`
}

/**
 * 把一条会话事件压成**一句人话**，供桌宠气泡使用。
 * 返回 `null` = 这条事件不该打扰用户（例如流式正文、心跳类事件）。
 *
 * 为什么不直接把 AI 正文放进气泡：实测输出量太大，根本看不清（用户明确要求改掉）。
 * 气泡只回答一个问题：**"它现在在干什么 / 干完什么了"**。
 */
export function activityLabel(ev) {
  if (ev === null || typeof ev !== 'object') return null
  const data = ev.data ?? {}
  switch (ev.kind) {
    case 'turn/start':
      return '开始处理新任务'
    case 'step/start':
      return '分析中…'
    case 'tool/call':
      return toolLabel(data.name)
    case 'tool/result':
      return data.isError === true ? '这一步失败了' : '这一步完成了'
    case 'assistant/message':
      return '已完成分析'
    case 'turn/end': {
      const kind = data.reason?.kind
      if (kind === 'error') return '出错了'
      if (kind === 'aborted' || kind === 'interrupted') return '已中断'
      return '这一轮完成了'
    }
    // 其余（含 request/header、各类 session-log 事件）都不值得打扰
    default:
      return null
  }
}

// ── token 用量：四桶口径（与宿主 `tokenMeter` 的 usage-projection.js 完全一致）──
//
// ⚠️ 这里踩过一个真坑：原来是把每次 `assistant/message` 的 `usage.totalTokens` **直接累加**，
// 结果 `/state` 报出 **3390 万** tokens。原因是 `totalTokens` 里含 `cacheReadTokens`，
// 而缓存命中读的是**整个上下文**。实测某一次的真实载荷：
//     { inputTokens: 664, outputTokens: 153, cacheReadTokens: 9600, cacheWriteTokens: 0, totalTokens: 10417 }
// 664 是新输入，9600 是重发的上下文 —— 逐轮累加等于把同一段上下文数了几十遍。
//
// 正解照抄宿主：四个桶分开记，并且**按 (turn, step) 增量替换**而不是累加
// （同一轮同一步重复上报时，先减掉上一次再加新的；重试则把上一次作废）。
export function zeroBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** 由官方 `usage` 取四桶。注意 `inputTokens` 是**未命中缓存**的那部分。 */
export function bucketsFrom(usage) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    uncachedInputTokens: n(usage?.inputTokens),
    outputTokens: n(usage?.outputTokens),
    cacheReadTokens: n(usage?.cacheReadTokens),
    cacheWriteTokens: n(usage?.cacheWriteTokens),
  }
}

function bucketsEqual(a, b) {
  return (
    a.uncachedInputTokens === b.uncachedInputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens
  )
}

/** totals - previous + next（previous 为 undefined 时即普通累加） */
function addReplacing(totals, previous, next) {
  const base = previous ?? zeroBuckets()
  return {
    uncachedInputTokens: totals.uncachedInputTokens - base.uncachedInputTokens + next.uncachedInputTokens,
    outputTokens: totals.outputTokens - base.outputTokens + next.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - base.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - base.cacheWriteTokens + next.cacheWriteTokens,
  }
}

/** 四桶合计 —— 即"这个会话一共用掉多少 token" */
export function bucketsTotal(b) {
  return b.uncachedInputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens
}

/**
 * 缓存命中率（0~1）。分母只算**输入**（命中 + 未命中），不含输出 —— 输出与缓存无关。
 * 没有任何输入时返回 `null`（而不是 0，免得显示成"0% 命中"误导人）。
 */
export function cacheHitRate(b) {
  const input = b.cacheReadTokens + b.uncachedInputTokens
  return input > 0 ? b.cacheReadTokens / input : null
}

/**
 * 把**宿主权威**的四桶写进会话状态（整体替换，不是累加）。
 *
 * 为什么需要它：插件自己累加出来的是"**自插件启动以来**"的数 —— DSH 一重启就归零。
 * 宿主的 `ctx.sessionProjections.stateOf(session, 'tokenUsage')` 是 **durable projection**
 * （从会话日志重放），重启不丢，才是"这个会话一共用了多少"。
 *
 * 写入后该会话标记为 `host` 源，插件**不再自己累加**（避免两边混着算）。
 * 幂等：值没变就原样返回，免得每次 /state 都换一个新对象。
 */
export function setTokenTotals(state, sessionId, buckets, source = 'host') {
  const prev = state.sessions[sessionId]
  if (prev === undefined) return state
  const clean = { ...zeroBuckets(), ...buckets }
  if (prev.tokenSource === source && prev.tokenBuckets !== undefined && bucketsEqual(prev.tokenBuckets, clean)) {
    return state
  }
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...prev,
        tokenBuckets: clean,
        spendTokens: bucketsTotal(clean),
        tokenSource: source,
        tokenLast: undefined, // 权威值已整体覆盖，自己那套去重游标作废
      },
    },
  }
}

/**
 * "当前最相关那个会话"的 token 视图 —— 状态帧和 snapshot 都带一份。
 *
 * 为什么要塞进**状态帧**：渲染端的右键菜单要显示用量，而 snapshot 只在 SSE 连接时来一次，
 * 靠它数字会一直停在几小时前。状态帧是事件驱动的，跟着它走才是新鲜的。
 */
export function primaryTokens(state) {
  const id = primarySessionId(state)
  const s = id === undefined ? undefined : state.sessions[id]
  const buckets = s?.tokenBuckets ?? zeroBuckets()
  return {
    sessionId: id ?? null,
    spendTokens: bucketsTotal(buckets),
    cacheHitRate: cacheHitRate(buckets),
    tokenSource: s?.tokenSource ?? 'own',
  }
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
 * 标记已读：把会话的 `unread` 清掉（"我看过了"）。
 *
 * 为什么要插件来做：`unread` 是**插件侧**的状态 —— 渲染端自己把徽标设成 0 没用，
 * 下一个 `state` 帧照样会把 `unread: N` 报回来（实测就是这个现象）。
 *
 * @param state 当前状态
 * @param sessionId 只清这个会话；不传 = 全清
 * @returns {{state, frames}} 与 commit() 同形；frames 带一帧 `state`，窗口立刻收掉徽标
 */
export function markRead(state, sessionId) {
  let changed = false
  const sessions = { ...state.sessions }
  for (const [id, s] of Object.entries(sessions)) {
    if (sessionId !== undefined && id !== sessionId) continue
    if (s.unread) {
      sessions[id] = { ...s, unread: false }
      changed = true
    }
  }
  if (!changed) return { state, frames: [] }
  const next = { ...state, sessions }
  return {
    state: next,
    frames: [
      { type: 'state', seq: next.seq, state: aggregate(next), unread: unreadCount(next), tokens: primaryTokens(next) },
    ],
  }
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
    frames.push({ type: 'state', seq: next.seq, state: agg, unread: unreadCount(next), tokens: primaryTokens(next) })
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

  // ⚠️ `llm/retry-started` **不在 EVENT_STATE 里**，所以必须在这里先处理 ——
  // 放到下面会被 `target === undefined` 提前 return 掉（我第一版就写错了，测试才发现）。
  // 它的作用：把上一次上报作废，这样重试的那一次是"重新计"而不是"再加一遍"。
  if (ev.kind === 'llm/retry-started') {
    const prev = sessionOf(state, ev.sessionId, now)
    const last = prev.tokenLast
    if (!last) return { state, frames: [] }
    const { turn, step } = ev.data ?? {}
    if (last.turn !== turn || last.step !== step) return { state, frames: [] }
    return commit(state, { ...prev, tokenLast: undefined }, ev.sessionId, now)
  }

  const target = EVENT_STATE[ev.kind]
  if (target === undefined) return { state, frames: [] }

  const prev = sessionOf(state, ev.sessionId, now)
  const session = { ...prev }
  if (ev.title !== undefined) session.title = ev.title

  const extraFrames = []

  // token 用量：四桶 + 按 (turn, step) 增量替换（口径与宿主一致，见文件上方注释）
  // ⚠️ 一旦该会话已切到宿主的**权威**数据源（durable，重启不丢）就不要再自己累加，
  //    否则两边混着算、数字会飘。自算只作兜底。
  if (session.tokenSource === 'host') {
    // 由 setTokenTotals() 整体覆盖，这里不做任何事
  } else if ((ev.kind === 'assistant/message' || ev.kind === 'assistant/attempt') && ev.data?.usage) {
    const buckets = bucketsFrom(ev.data.usage)
    const { turn, step } = ev.data
    const sameStep =
      Number.isFinite(turn) && Number.isFinite(step) && session.tokenLast?.turn === turn && session.tokenLast?.step === step
    const previous = sameStep ? session.tokenLast.buckets : undefined
    if (previous === undefined || !bucketsEqual(previous, buckets)) {
      const totals = addReplacing(session.tokenBuckets ?? zeroBuckets(), previous, buckets)
      session.tokenBuckets = totals
      // 只有带 turn/step 的上报才记 last —— 否则"替换"会退化成"只留最后一次"，反而不准
      if (Number.isFinite(turn) && Number.isFinite(step)) session.tokenLast = { turn, step, buckets }
      session.spendTokens = bucketsTotal(totals) // 兼容旧消费者（提醒引擎的"花销"、/state）
    }
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
    // 右键菜单要显示的数字（见 primaryTokens 的注释）
    tokens: primaryTokens(state),
    sessions: Object.values(state.sessions).map((s) => {
      const buckets = s.tokenBuckets ?? zeroBuckets()
      return {
        sessionId: s.sessionId,
        state: s.state,
        unread: s.unread,
        pendingApprovals: s.pendingApprovals ?? 0,
        // 四桶口径（见文件上方注释）：spendTokens 只为兼容旧消费者而保留
        spendTokens: bucketsTotal(buckets),
        tokenBuckets: buckets,
        cacheHitRate: cacheHitRate(buckets),
        // 'host' = 来自宿主 durable projection（重启不丢）；否则是插件自算的兜底值
        tokenSource: s.tokenSource ?? 'own',
        title: s.title,
        tail: s.tail,
      }
    }),
  }
}
