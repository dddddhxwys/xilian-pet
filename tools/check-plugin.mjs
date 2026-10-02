/**
 * 昔涟桌宠 Host 插件自测 —— 不需要 DSH，不需要安装。
 *
 * 做法：
 *  1. 用 mock ctx 满足官方插件契约（webServer.register / on / effect / logger）
 *  2. 调 apply() 注册路由
 *  3. 起一个真 http server 把请求派发给注册的路由
 *  4. 用真 fetch 做 HTTP 往返与 SSE 读取，断言行为
 *  5. 顺带对纯函数状态机做确定性断言（含最短保持时间）
 *
 * 用法：node tools/check-plugin.mjs
 */

import http from 'node:http'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { apply, inject as pluginInject } from '../packages/pet-plugin/index.js'
import {
  aggregate,
  createPetState,
  hasActivity,
  normalizeAgentError,
  normalizeAgentStatus,
  normalizeSessionEvent,
  normalizeStreamChunk,
  pendingApprovalCount,
  reduceAgentError,
  reduceAgentStatus,
  reducePetEvent,
  reduceStreamChunk,
  releaseHeld,
  snapshot,
  spendBySession,
} from '../packages/pet-plugin/reducer.js'
import {
  DEFAULT_REMINDERS,
  decideReminders,
  isQuiet,
  mergeReminderConfig,
  parseQuietHours,
} from '../packages/pet-plugin/reminders.js'

let passed = 0
let failed = 0
const failures = []

function check(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ✅ ${label}`)
  } catch (error) {
    failed++
    failures.push(`${label}: ${error.message}`)
    console.log(`  ❌ ${label}\n       ${error.message}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✅ ${label}`)
  } catch (error) {
    failed++
    failures.push(`${label}: ${error.message}`)
    console.log(`  ❌ ${label}\n       ${error.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\n[1] 纯函数状态机（确定性，无 IO）')

const emit = (st, kind, sessionId, now, extra = {}) =>
  reducePetEvent(st, { kind, sessionId, ...extra }, now).state

check('初始聚合为 idle', () => {
  assert.equal(aggregate(createPetState()), 'idle')
})

check('turn/start → running', () => {
  const s = emit(createPetState(), 'turn/start', 's1', 0)
  assert.equal(aggregate(s), 'running')
})

check('多会话取最高优先级：running + done → done', () => {
  let s = emit(createPetState(), 'turn/start', 's1', 0)
  s = emit(s, 'turn/end', 's2', 1000)
  assert.equal(aggregate(s), 'done')
})

check('审批压过完成：done + approval → approval', () => {
  let s = emit(createPetState(), 'turn/end', 's1', 0)
  s = emit(s, 'approval/asked', 's2', 1000)
  assert.equal(aggregate(s), 'approval')
})

check('done 记未读，running 清未读', () => {
  let s = emit(createPetState(), 'turn/end', 's1', 0)
  assert.equal(snapshot(s).unread, 1)
  s = emit(s, 'turn/start', 's1', 1000)
  assert.equal(snapshot(s).unread, 0)
})

check('升优先级立即生效', () => {
  const st = createPetState({ minHoldMs: 500 })
  const s = emit(st, 'turn/start', 's1', 0) // running
  const r = reduceAgentError(s, { sessionId: 's1', message: 'boom' }, 100) // error 更高
  assert.equal(r.state.current, 'error')
})

check('降优先级在最短保持时间内被压住', () => {
  const st = createPetState({ minHoldMs: 500 })
  const s = emit(st, 'approval/asked', 's1', 1000) // approval
  assert.equal(s.current, 'approval')
  const r = reduceAgentStatus(s, { sessionId: 's1', status: 'idle' }, 1100) // 仅过 100ms
  assert.equal(r.state.current, 'approval', '未满 500ms 不应降档')
})

check('releaseHeld 在没有新事件时释放被压住的状态', () => {
  const st = createPetState({ minHoldMs: 500 })
  let s = emit(st, 'approval/asked', 's1', 1000)
  s = reduceAgentStatus(s, { sessionId: 's1', status: 'idle' }, 1100).state
  const r = releaseHeld(s, 1600) // 距上次切换 600ms
  assert.equal(r.state.current, 'idle')
  assert.equal(r.frames[0].type, 'state')
})

check('reduceStreamChunk 累积 tail 并产生 stream 帧', () => {
  const r = reduceStreamChunk(createPetState(), { sessionId: 's1', text: '你好' }, 0)
  const r2 = reduceStreamChunk(r.state, { sessionId: 's1', text: '，昔涟' }, 1)
  assert.equal(r2.state.sessions.s1.tail, '你好，昔涟')
  assert.ok(r2.frames.some((f) => f.type === 'stream'))
})

check('归一化：session/event 是 (session, event) 两个参数', () => {
  const ev = normalizeSessionEvent(
    { id: 's1', header: { title: '标题' } },
    { type: 'turn/start', seq: 3, data: { text: 'hi' } },
  )
  assert.equal(ev.kind, 'turn/start')
  assert.equal(ev.sessionId, 's1')
  assert.equal(ev.text, 'hi')
  assert.equal(ev.title, '标题')
  // 签名传错（只给一个对象）时应拒绝，而不是静默产出错误数据
  assert.equal(normalizeSessionEvent({ type: 'turn/start' }, undefined), null)
})

check('归一化：agent/assistant-stream 是 ({ agent, frame })，正文在 frame.chunk.text', () => {
  const chunk = normalizeStreamChunk({
    agent: { session: { id: 's9' } },
    frame: {
      type: 'chunk',
      attemptId: 'a1',
      revision: 1,
      index: 0,
      time: 0,
      chunk: { type: 'text-delta', index: 0, text: '喂' },
    },
  })
  assert.equal(chunk.sessionId, 's9')
  assert.equal(chunk.frameType, 'chunk')
  assert.equal(chunk.chunkType, 'text-delta')
  assert.equal(chunk.text, '喂')
  assert.equal(normalizeStreamChunk({ agent: {} }), null)
})

check('start 帧把会话推到 running；end 帧不改状态', () => {
  const started = reduceStreamChunk(createPetState(), { sessionId: 's1', frameType: 'start' }, 0)
  assert.equal(started.state.sessions.s1.state, 'running')
  const ended = reduceStreamChunk(started.state, { sessionId: 's1', frameType: 'end', outcome: 'committed' }, 10)
  assert.equal(ended.state.sessions.s1.state, 'running')
})

check('只有 text-delta 的 chunk 才累积 tail', () => {
  const usage = reduceStreamChunk(
    createPetState(),
    { sessionId: 's1', frameType: 'chunk', chunkType: 'usage' },
    0,
  )
  assert.equal(usage.state.sessions.s1.tail, '')
  assert.ok(!usage.frames.some((f) => f.type === 'stream'))
})

// ── agent/status：权威的空档信号（治"状态挂住"）──────────────────
check('agent/status idle 把运行中的会话降回空闲', () => {
  let s = emit(createPetState(), 'turn/start', 's1', 0)
  assert.equal(aggregate(s), 'running')
  s = reduceAgentStatus(s, { sessionId: 's1', status: 'idle' }, 1000).state
  assert.equal(aggregate(s), 'idle')
})

check('agent/status idle **不**冲掉 done（未读语义要保留）', () => {
  let s = emit(createPetState(), 'turn/end', 's1', 0)
  assert.equal(aggregate(s), 'done')
  s = reduceAgentStatus(s, { sessionId: 's1', status: 'idle' }, 1000).state
  assert.equal(aggregate(s), 'done', 'done 带未读，不能被 idle 抹掉')
  assert.equal(snapshot(s).unread, 1)
})

check('agent/status running 清未读', () => {
  let s = emit(createPetState(), 'turn/end', 's1', 0)
  s = reduceAgentStatus(s, { sessionId: 's1', status: 'running' }, 2000).state
  assert.equal(aggregate(s), 'running')
  assert.equal(snapshot(s).unread, 0)
})

check('agent/status 非法值被忽略', () => {
  const r = reduceAgentStatus(createPetState(), { sessionId: 's1', status: 'weird' }, 0)
  assert.equal(r.frames.length, 0)
})

// ── 审批：A7 主动提醒的原料 ──────────────────────────────────────
check('approval/asked 计数 +1 并产生 notice 帧', () => {
  const r = reducePetEvent(
    createPetState(),
    { kind: 'approval/asked', sessionId: 's1', data: { toolName: 'bash', reason: '危险命令' } },
    0,
  )
  assert.equal(pendingApprovalCount(r.state), 1)
  const notice = r.frames.find((f) => f.type === 'notice')
  assert.equal(notice?.toolName, 'bash')
  assert.equal(notice?.pending, 1)
  assert.equal(aggregate(r.state), 'approval')
})

check('approval/decided 计数 -1 且不会变负', () => {
  const asked = reducePetEvent(createPetState(), { kind: 'approval/asked', sessionId: 's1', data: {} }, 0)
  const decided = reducePetEvent(asked.state, { kind: 'approval/decided', sessionId: 's1', data: { outcome: 'allowed-once' } }, 10)
  assert.equal(pendingApprovalCount(decided.state), 0)
  const extra = reducePetEvent(decided.state, { kind: 'approval/decided', sessionId: 's1', data: {} }, 20)
  assert.equal(pendingApprovalCount(extra.state), 0, '重复 decided 不应把计数压成负数')
})

// ── agent/error ─────────────────────────────────────────────────
check('agent/error → 出错档 + 未读 + notice 帧', () => {
  const r = reduceAgentError(createPetState(), { sessionId: 's1', message: 'boom' }, 0)
  assert.equal(aggregate(r.state), 'error')
  assert.equal(snapshot(r.state).unread, 1)
  assert.equal(r.frames.find((f) => f.type === 'notice')?.notice, 'error')
})

// ── turn/end 按 reason 分流 ─────────────────────────────────────
check('turn/end completed → done + 未读', () => {
  const s = emit(createPetState(), 'turn/end', 's1', 0, { data: { reason: { kind: 'completed' } } })
  assert.equal(aggregate(s), 'done')
  assert.equal(snapshot(s).unread, 1)
})

check('turn/end interrupted → 空闲且**不**产生未读（用户自己打断的）', () => {
  const s = emit(createPetState(), 'turn/end', 's1', 0, { data: { reason: { kind: 'interrupted' } } })
  assert.equal(aggregate(s), 'idle')
  assert.equal(snapshot(s).unread, 0)
})

check('turn/end error → 出错 + 未读', () => {
  const s = emit(createPetState(), 'turn/end', 's1', 0, {
    data: { reason: { kind: 'error', error: { message: 'llm failed' } } },
  })
  assert.equal(aggregate(s), 'error')
  assert.equal(snapshot(s).unread, 1)
})

check('turn/end 未知 reason 保守当 completed', () => {
  const s = emit(createPetState(), 'turn/end', 's1', 0, { data: { reason: { kind: 'wat' } } })
  assert.equal(aggregate(s), 'done')
})

// ── 花销与提醒引擎需要的视图 ────────────────────────────────────
check('assistant/message 累积 usage（totalTokens 优先）', () => {
  let s = emit(createPetState(), 'assistant/message', 's1', 0, { data: { usage: { totalTokens: 1500 } } })
  s = emit(s, 'assistant/message', 's1', 1, { data: { usage: { inputTokens: 100, outputTokens: 50 } } })
  assert.equal(snapshot(s).sessions[0].spendTokens, 1650)
  assert.equal(spendBySession(s).s1, 1650)
})

check('hasActivity 只在运行/审批/提问时为真', () => {
  assert.equal(hasActivity(createPetState()), false)
  assert.equal(hasActivity(emit(createPetState(), 'turn/start', 's1', 0)), true)
  assert.equal(hasActivity(emit(createPetState(), 'turn/end', 's1', 0, { data: { reason: { kind: 'completed' } } })), false)
})

// ── 归一化 ──────────────────────────────────────────────────────
check('归一化 agent/status 与 agent/error', () => {
  assert.deepEqual(normalizeAgentStatus({ agent: { session: { id: 's1' } }, status: 'idle' }), {
    sessionId: 's1',
    status: 'idle',
  })
  assert.equal(normalizeAgentStatus({ agent: {}, status: 'weird' }), null)
  assert.equal(normalizeAgentStatus(null), null)
  const err = normalizeAgentError({ agent: { id: 's2' }, error: new Error('boom') })
  assert.equal(err.sessionId, 's2')
  assert.equal(err.message, 'boom')
})

// ─────────────────────────────────────────────────────────────
console.log('\n[1b] 提醒策略引擎（A7，纯函数）')

const at = (iso) => new Date(iso).getTime()

check('免打扰时段：同日区间', () => {
  const q = parseQuietHours(['09:00', '12:00'])
  assert.equal(isQuiet(at('2026-09-30T10:00:00'), q), true)
  assert.equal(isQuiet(at('2026-09-30T13:00:00'), q), false)
})

check('免打扰时段：跨午夜', () => {
  const q = parseQuietHours(['22:30', '08:00'])
  assert.equal(isQuiet(at('2026-09-30T23:00:00'), q), true)
  assert.equal(isQuiet(at('2026-09-30T03:00:00'), q), true)
  assert.equal(isQuiet(at('2026-09-30T12:00:00'), q), false)
})

check('免打扰解析：非法输入返回 null', () => {
  assert.equal(parseQuietHours(['25:00', '08:00']), null)
  assert.equal(parseQuietHours(['08:00', '08:00']), null)
  assert.equal(parseQuietHours('22:30'), null)
  assert.equal(parseQuietHours([]), null)
})

check('mergeReminderConfig 逐条合并，不整体替换', () => {
  const merged = mergeReminderConfig({ sedentary: { afterMs: 123 } })
  assert.equal(merged.sedentary.afterMs, 123)
  assert.equal(merged.sedentary.probability, DEFAULT_REMINDERS.sedentary.probability, '未指定字段应保留默认')
  assert.equal(merged.enabled, true)
})

check('审批积压是 urgent：可穿透免打扰时段', () => {
  const config = mergeReminderConfig({ quietHours: ['22:30', '08:00'] })
  const r = decideReminders({ now: at('2026-09-30T23:00:00'), pendingApprovals: 2, config })
  assert.equal(r.quiet, true)
  assert.equal(r.fires.length, 1)
  assert.equal(r.fires[0].notice, 'approval-backlog')
  assert.equal(r.fires[0].urgent, true)
})

check('审批积压：同一批不重复，归零后重置', () => {
  const config = mergeReminderConfig({ approvalBacklog: { repeatAfterMs: 100_000 } })
  const t0 = at('2026-09-30T10:00:00')
  let r = decideReminders({ now: t0, pendingApprovals: 1, config })
  assert.equal(r.fires.length, 1)
  r = decideReminders({ state: r.state, now: t0 + 1000, pendingApprovals: 1, config })
  assert.equal(r.fires.length, 0, '同一批积压不该重复提醒')
  r = decideReminders({ state: r.state, now: t0 + 2000, pendingApprovals: 0, config })
  r = decideReminders({ state: r.state, now: t0 + 3000, pendingApprovals: 1, config })
  assert.equal(r.fires.length, 1, '清零后再积压应重新提醒')
})

check('低优先提醒守免打扰：夜里不发久坐', () => {
  const config = mergeReminderConfig({
    quietHours: ['22:30', '08:00'],
    sedentary: { afterMs: 1000, probability: 1 },
  })
  const night = at('2026-09-30T23:00:00')
  const st = decideReminders({ now: night - 10_000, hasActivity: true, config }).state
  const r = decideReminders({ state: st, now: night, hasActivity: true, config })
  assert.equal(r.quiet, true)
  assert.ok(!r.fires.some((f) => f.notice === 'sedentary'), '免打扰时段的低优先提醒应被压住')
})

check('久坐：概率门与冷却都生效', () => {
  const config = mergeReminderConfig({
    sedentary: { afterMs: 1000, probability: 0.5, cooldownMs: 10_000, idleResetMs: 60_000 },
  })
  const t0 = 1_000_000
  let r = decideReminders({ now: t0, hasActivity: true, config })
  r = decideReminders({ state: r.state, now: t0 + 2000, hasActivity: true, config, random: () => 0.9 })
  assert.ok(!r.fires.some((f) => f.notice === 'sedentary'), '概率门应拦住（0.9 > 0.5）')
  r = decideReminders({ state: r.state, now: t0 + 3000, hasActivity: true, config, random: () => 0.1 })
  assert.ok(r.fires.some((f) => f.notice === 'sedentary'), '概率通过应发出')
  const again = decideReminders({ state: r.state, now: t0 + 4000, hasActivity: true, config, random: () => 0.1 })
  assert.ok(!again.fires.some((f) => f.notice === 'sedentary'), '冷却期内不应重复')
})

check('久坐：空闲超过 idleResetMs 会重置工作段', () => {
  const config = mergeReminderConfig({ sedentary: { afterMs: 1000, probability: 1, idleResetMs: 5000 } })
  const t0 = 2_000_000
  let st = decideReminders({ now: t0, hasActivity: true, config }).state
  assert.notEqual(st.workStartedAt, undefined)
  st = decideReminders({ state: st, now: t0 + 10_000, hasActivity: false, config }).state
  assert.equal(st.workStartedAt, undefined, '空闲超时后工作段应重置')
})

check('花销：跨过阈值才提醒，且同一额度不重复', () => {
  const config = mergeReminderConfig({ spend: { everyTokens: 1000 } })
  const t0 = 3_000_000
  let r = decideReminders({ now: t0, spendBySession: { s1: 999 }, config })
  assert.equal(r.fires.length, 0, '未达阈值不应提醒')
  r = decideReminders({ state: r.state, now: t0 + 1, spendBySession: { s1: 1000 }, config })
  assert.equal(r.fires[0]?.notice, 'spend')
  const again = decideReminders({ state: r.state, now: t0 + 2, spendBySession: { s1: 1000 }, config })
  assert.equal(again.fires.length, 0, '同一额度不应重复提醒')
  const more = decideReminders({ state: r.state, now: t0 + 3, spendBySession: { s1: 2000 }, config })
  assert.equal(more.fires.length, 1, '再跨一个阈值应再提醒')
})

check('reminders.enabled=false 时一条都不发', () => {
  const config = mergeReminderConfig({ enabled: false })
  const r = decideReminders({ now: 4_000_000, pendingApprovals: 5, hasActivity: true, config, random: () => 0 })
  assert.equal(r.fires.length, 0)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[2] 插件契约（mock ctx）')

/** 真实宿主里可注入的服务名（读 ctx.<名字> 受 inject 校验管辖） */
const MOCK_SERVICES = new Set(['webServer', 'agents'])

/**
 * 模拟 Cordis 的 ctx。
 *
 * ⚠️ **必须复现 inject 校验**：真实的 ctx 是 Proxy —— 访问一个**已注册的服务**属性时，
 * 若该名字不在插件的 `inject` 里，它**抛错**而不是返回 undefined：
 *     cannot get property "agents" without inject
 *
 * 这里一开始没模拟这一点（把 `agents` 当普通属性发），后果是：
 * **自测 62 项全绿，真机「双击派活」却 500** ——
 * 又是"mock 比真实宿主宽松 → 测出假象"这一类坑（与 waterfall 那次同源）。
 * 现在按真实语义收紧：服务属性只有在 `inject` 声明过才给。
 *
 * @param {object}  opts
 * @param {Function} [opts.agents]         sessionId → agent 的取用函数
 * @param {string[]} [opts.declaredInject] 覆盖 inject 声明（仅用于负向对照）
 */
function createMockCtx({ agents, declaredInject = pluginInject } = {}) {
  const routes = new Map()
  const listeners = new Map()
  const warnings = []
  const services = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    agents: agents === undefined ? undefined : { get: agents },
  }
  const ctx = new Proxy(
    {
      logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(fn)
        return () => {
          const arr = listeners.get(event)
          const i = arr.indexOf(fn)
          if (i >= 0) arr.splice(i, 1)
        }
      },
      effect(fn) {
        const dispose = fn()
        return () => dispose?.()
      },
    },
    {
      get(target, prop, receiver) {
        if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
        if (MOCK_SERVICES.has(prop)) {
          // 真实语义：没在 inject 里声明就抛，**不是**给 undefined
          if (!declaredInject.includes(prop)) {
            throw new Error(`cannot get property "${String(prop)}" without inject`)
          }
          return services[prop]
        }
        return undefined
      },
    },
  )
  return { ctx, routes, listeners, warnings }
}

/**
 * 模拟 Cordis 的 **waterfall** 语义。
 *
 * 这是本文件最重要的一段：链路里的值靠监听器的**返回值**往下传，
 * 官方约定监听器必须 `return next()`（或返回一个决策对象）。
 *
 * 真实宿主的写法（已从 asar 核实）：
 *   const gate = await ctx.waterfall(carrier, 'tools/pre-execute', exec,
 *                                   () => Promise.resolve({ kind: 'allow' }))
 *   const ask = gate.kind === 'ask' ? ... : ...
 *
 * 之前的 mock 只是把监听器"存起来"，没有瀑布语义，所以**测不出**下面这个真实事故：
 * 监听器 `(payload) => { observe(); return undefined }` 忘了 return next()，
 * 把 carry 冲成 undefined → `gate.kind` 抛 TypeError → 整个 profile 的
 * 每一次工具调用全挂，重启 DSH 也不恢复。
 */
async function runWaterfall(listeners, event, fallback, ...args) {
  let carried = typeof fallback === 'function' ? await fallback() : fallback
  for (const fn of listeners.get(event) ?? []) {
    carried = await fn(...args, () => Promise.resolve(carried))
  }
  return carried
}

const calls = []
const fakeAgent = {
  followup: async (message) => calls.push(['followup', message]),
  cancel: async (cause) => calls.push(['cancel', cause]),
}
const mockAgentGetter = (sessionId) => (sessionId === 'known' ? fakeAgent : undefined)

// 注入 UserMessage 工厂：真实运行时插件会动态 import @deepseek-ai/dsh-llm，
// 但自测环境里没有那个包，所以走注入点（这也是 config.createUserMessage 存在的理由）。
const stubCreateUserMessage = (input) => ({ ...input, id: 'msg-test-1', role: 'user' })

const { ctx, routes, listeners, warnings } = createMockCtx({ agents: mockAgentGetter })
const dispose = apply(ctx, {
  pathPrefix: '/xilian-pet',
  minHoldMs: 0,
  createUserMessage: stubCreateUserMessage,
})

check('inject 声明覆盖了用到的服务（webServer + agents）', () => {
  assert.ok(Array.isArray(pluginInject), 'inject 必须是数组')
  assert.ok(
    pluginInject.includes('webServer'),
    `inject 缺 webServer：${JSON.stringify(pluginInject)}`,
  )
  assert.ok(
    pluginInject.includes('agents'),
    `inject 缺 agents —— 真机会报 cannot get property "agents" without inject：${JSON.stringify(pluginInject)}`,
  )
})

check('回归：源码里每次 ctx.<服务> 访问都在 inject 里声明过', () => {
  // 静态扫一遍。为什么不能只靠上面那个 Proxy：Proxy 只在**真的执行到那一行**时才抛，
  // 而某条路由可能根本没有测试走到 —— 静态扫描覆盖全部代码路径。
  const src = readFileSync(new URL('../packages/pet-plugin/index.js', import.meta.url), 'utf8')
  // 框架自带的 ctx 能力，不受 inject 管辖（含注释里出现的那些）
  const FRAMEWORK = new Set([
    'on', 'effect', 'logger', 'waterfall', 'emit', 'parallel', 'serial',
    'reflect', 'fiber', 'events', 'inject', 'isolate', 'shadow', 'set', 'get',
  ])
  const used = new Set([...src.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
  const services = [...used].filter((n) => !FRAMEWORK.has(n))
  const missing = services.filter((n) => !pluginInject.includes(n))
  assert.deepEqual(
    missing,
    [],
    `这些服务没在 inject 里声明：${missing.join(', ')}（扫到的服务：${services.join(', ')}）`,
  )
  assert.ok(services.length > 0, '静态扫描没扫到任何服务，正则可能失效了')
})

check('负向对照：mock 确实会因缺 inject 而抛错（证明上面两条测得出问题）', () => {
  // 把 inject 缩回出 bug 的那一版（只有 webServer），断言访问 agents 会抛真实宿主的错
  const { ctx: broken } = createMockCtx({ agents: mockAgentGetter, declaredInject: ['webServer'] })
  assert.throws(
    () => broken.agents,
    /cannot get property "agents" without inject/,
    'mock 没有复现 inject 校验，那这个自测就永远测不出这类 bug',
  )
})

check('apply 注册了 8 条 exact 路由', () => {
  assert.equal(routes.size, 8, `实际 ${routes.size}：${[...routes.keys()].join(', ')}`)
})

check('所有路由都是 exact（避免被 /api 之类的前缀路由吞掉）', () => {
  for (const r of routes.values()) assert.equal(r.kind, 'exact')
})

check('只在通知型事件上注册监听器（4 个）', () => {
  assert.equal(listeners.get('session/event')?.length, 1)
  assert.equal(listeners.get('agent/assistant-stream')?.length, 1)
  assert.equal(listeners.get('agent/status')?.length, 1)
  assert.equal(listeners.get('agent/error')?.length, 1)
})

check('绝不订阅 waterfall 事件（tools/pre-execute、tools/post-execute）', () => {
  for (const ev of ['tools/pre-execute', 'tools/post-execute']) {
    assert.equal(listeners.get(ev)?.length ?? 0, 0, `不应订阅 ${ev}：它是 waterfall，乱返回会冲掉链路`)
  }
})

await checkAsync('回归：模拟 waterfall 链路，携带的值不会被冲掉', async () => {
  const gate = await runWaterfall(listeners, 'tools/pre-execute', () => ({ kind: 'allow' }), { name: 'bash' })
  assert.equal(gate?.kind, 'allow', 'gate 被冲成 undefined 会让下游读 .kind 抛 TypeError')
})

await checkAsync('对照：忘写 return next() 的监听器确实会搞挂链路（证明上一条测得出问题）', async () => {
  const bad = new Map([['tools/pre-execute', [(exec) => { /* 故意不 return next() */ }]]])
  const gate = await runWaterfall(bad, 'tools/pre-execute', () => ({ kind: 'allow' }), { name: 'bash' })
  assert.equal(gate, undefined)
  assert.throws(() => gate.kind, TypeError)
})

// ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.get(url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no-route')
    return
  }
  route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

console.log(`\n[3] HTTP 往返（真实 socket，${base}）`)

await checkAsync('GET /health → 200 且 ok:true，并带 code 修订号', async () => {
  const res = await fetch(`${base}/xilian-pet/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'xilian-pet')
  // code 的用途：判断插件有没有热重载（配合 uptimeMs 归零）
  assert.ok(Number.isInteger(body.code) && body.code >= 1, `code 应为整数修订号，实际 ${body.code}`)
  assert.equal(typeof body.pendingApprovals, 'number')
})

await checkAsync('GET /state → 200 且 state:idle', async () => {
  const body = await (await fetch(`${base}/xilian-pet/state`)).json()
  assert.equal(body.state, 'idle')
})

await checkAsync('未注册路径 → 404', async () => {
  const res = await fetch(`${base}/xilian-pet/nope`)
  assert.equal(res.status, 404)
})

await checkAsync('DELETE /health → 405（方法校验生效）', async () => {
  const res = await fetch(`${base}/xilian-pet/health`, { method: 'DELETE' })
  assert.equal(res.status, 405)
})

await checkAsync('POST /focus → 501（不假装成功）', async () => {
  const res = await fetch(`${base}/xilian-pet/focus`, { method: 'POST' })
  assert.equal(res.status, 501)
})

await checkAsync('POST /prompt 无 sessionId → 503 no-agent', async () => {
  const res = await fetch(`${base}/xilian-pet/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' }),
  })
  assert.equal(res.status, 503)
  assert.equal((await res.json()).error, 'no-agent')
})

await checkAsync('POST /prompt 空文本 → 400', async () => {
  const res = await fetch(`${base}/xilian-pet/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'known', text: '   ' }),
  })
  assert.equal(res.status, 400)
})

await checkAsync('POST /prompt 命中 agent → 构造出 UserMessage 再 followup', async () => {
  const res = await fetch(`${base}/xilian-pet/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'known', text: '去写个 README' }),
  })
  assert.equal(res.status, 200)
  const [action, message] = calls.at(-1)
  assert.equal(action, 'followup', 'followup 必须收到消息对象，不是字符串')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: '去写个 README' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

await checkAsync('POST /interrupt 命中 agent → cancel({ kind: "user" })', async () => {
  const res = await fetch(`${base}/xilian-pet/interrupt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'known' }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(calls.at(-1), ['cancel', { kind: 'user' }])
})

await checkAsync('取不到 UserMessage 工厂时 /prompt 降级为 503（而不是让插件加载失败）', async () => {
  // 说明：本测试依赖"自测环境里解析不到 @deepseek-ai/dsh-llm"这一事实 ——
  // 那正是生产环境里唯一可能失败的地方，所以这条测的是真实的降级路径。
  const m = createMockCtx({ agents: mockAgentGetter })
  const teardown = apply(m.ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0 }) // 刻意不注入工厂
  const srv = http.createServer((req, res) => {
    const route = m.routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/xilian-pet/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'known', text: 'hi' }),
    })
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error, 'no-message-factory')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('SSE：连接即收到 connected 注释 + hello + snapshot', async () => {
  const sse = await openSse(`${base}/xilian-pet/events`)
  assert.equal(sse.res.status, 200)
  assert.match(sse.res.headers.get('content-type') ?? '', /text\/event-stream/)
  const text = await sse.readUntil((b) => b.includes('"snapshot"'), 3000)
  sse.close()
  assert.match(text, /^: connected/)
  assert.match(text, /"type":"hello"/)
  assert.match(text, /"type":"snapshot"/)
})

await checkAsync('SSE：观测到 turn/start → 推出 running 状态帧', async () => {
  const sse = await openSse(`${base}/xilian-pet/events`)
  await sse.readUntil((b) => b.includes('"snapshot"'), 3000)
  for (const fn of listeners.get('session/event')) fn({ id: 's1' }, { type: 'turn/start', seq: 1 })
  const text = await sse.readUntil((b) => /"type":"state".*"state":"running"/.test(b), 3000)
  sse.close()
  assert.match(text, /"state":"running"/)
})

await checkAsync('SSE：assistant/stream → 推出 stream 帧', async () => {
  const sse = await openSse(`${base}/xilian-pet/events`)
  await sse.readUntil((b) => b.includes('"snapshot"'), 3000)
  for (const fn of listeners.get('agent/assistant-stream'))
    fn({
      agent: { session: { id: 's1' } },
      frame: { type: 'chunk', index: 0, chunk: { type: 'text-delta', index: 0, text: '昔涟在写' } },
    })
  const text = await sse.readUntil((b) => b.includes('"type":"stream"'), 3000)
  sse.close()
  assert.match(text, /昔涟在写/)
})

await checkAsync('GET /debug/shapes → 记录到原始事件形状样本（按 channel 分别限量）', async () => {
  const body = await (await fetch(`${base}/xilian-pet/debug/shapes`)).json()
  assert.ok(body.count >= 1, '应至少记录一条形状样本')
  assert.ok(body.shapes.some((s) => s.channel === 'session/event'))
  assert.ok(body.byChannel['session/event'] >= 1, 'session/event 的样本不该被高频通道挤掉')
})

await checkAsync('回归：高频通道灌爆也不会挤掉低频通道的样本', async () => {
  // 实测踩过：全局环形缓冲被 agent/assistant-stream（每 token 一帧）刷满，
  // 80 条样本全是它，session/event 与 agent/status 一条不剩，根本没法诊断。
  for (let i = 0; i < 200; i++) {
    for (const fn of listeners.get('agent/assistant-stream')) {
      fn({
        agent: { session: { id: 's1' } },
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'x' } },
      })
    }
  }
  for (const fn of listeners.get('session/event')) fn({ id: 's1' }, { type: 'turn/end' })
  for (const fn of listeners.get('agent/status')) fn({ agent: { session: { id: 's1' } }, status: 'idle' })

  const body = await (await fetch(`${base}/xilian-pet/debug/shapes`)).json()
  assert.ok(
    body.byChannel['agent/assistant-stream'] <= 20,
    `单通道样本应被限制在上限内，实际 ${body.byChannel['agent/assistant-stream']}`,
  )
  assert.ok(body.byChannel['session/event'] >= 1, '低频通道的样本必须还在')
  assert.ok(body.byChannel['agent/status'] >= 1, 'agent/status 的样本必须还在')
})

await checkAsync('回归：循环引用载荷的预览仍可读（不会变成 <unserializable>）', async () => {
  // agent/status 的真实载荷里 agent.ctx 是循环引用 —— 实测曾让预览全丢，
  // 而那恰恰是诊断时最需要的信息。
  const agent = { session: { id: 's1' } }
  agent.ctx = { agent, self: agent }
  for (const fn of listeners.get('agent/status')) fn({ agent, status: 'running' })

  const body = await (await fetch(`${base}/xilian-pet/debug/shapes`)).json()
  const sample = body.shapes.filter((s) => s.channel === 'agent/status').at(-1)
  assert.ok(sample, '应记录到 agent/status 样本')
  assert.ok(!sample.preview.startsWith('<unserializable'), `预览不该不可读：${sample.preview}`)
  assert.match(sample.preview, /"status":"running"/)
  assert.match(sample.preview, /\[circular\]/, '循环处应被标记而不是抛错')
})

await checkAsync('无法识别的载荷不会导致崩溃', async () => {
  for (const fn of listeners.get('session/event')) {
    fn(null, null)
    fn('not-an-object', 'not-an-object')
    fn({}, {})
    fn({ id: 's1' }, { type: 'turn/start' }) // 正常路径也要活下来
  }
  const res = await fetch(`${base}/xilian-pet/health`)
  assert.equal(res.status, 200)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[4] 清理')

check('dispose() 后路由与监听器全部注销', () => {
  dispose()
  assert.equal(routes.size, 0, `仍有路由：${[...routes.keys()].join(', ')}`)
  assert.equal(listeners.get('session/event')?.length ?? 0, 0)
})

await new Promise((resolve) => server.close(resolve))

console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (warnings.length > 0) console.log(`插件告警 ${warnings.length} 条：\n  ${warnings.slice(0, 5).join('\n  ')}`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('全部通过 ✅')

// ─────────────────────────────────────────────────────────────
/** 建立一条 SSE 连接；一个响应只能 getReader() 一次，故把 reader 与累计缓冲封装起来。 */
async function openSse(url) {
  const ac = new AbortController()
  const res = await fetch(url, { signal: ac.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    res,
    close() {
      try {
        reader.cancel()
      } catch {
        /* ignore */
      }
      ac.abort()
    },
    /** 持续读取直到满足条件或超时；返回累计文本 */
    async readUntil(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate(buffer)) return buffer
        const remaining = deadline - Date.now()
        const chunk = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
        ])
        if (chunk.timeout) break
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      return buffer
    },
  }
}
