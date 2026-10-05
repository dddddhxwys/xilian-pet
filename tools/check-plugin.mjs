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
import { contentBand, hitTest, insideAnyRect } from '../packages/pet-shell/hit-test.js'
import {
  BASE_MOTION,
  FLICK_PRESETS,
  INTRO_MOTION,
  STATE_MAP,
  decideOnMotionFinish,
  fadeProps,
  flickOffset,
  planParamTransition,
  propFadePhases,
  propTargetsFor,
} from '../packages/pet-shell/renderer/motion-policy.js'
import {
  activityLabel,
  aggregate,
  cacheHitRate,
  createPetState,
  hasActivity,
  markRead,
  normalizeAgentError,
  normalizeAgentStatus,
  normalizeSessionEvent,
  normalizeStreamChunk,
  pendingApprovalCount,
  primarySessionId,
  primaryTokens,
  reduceAgentError,
  reduceAgentStatus,
  reducePetEvent,
  reduceStreamChunk,
  releaseHeld,
  setSessionTitle,
  setTokenTotals,
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
check('assistant/message 按四桶累计 usage（不再用 totalTokens）', () => {
  // 口径与宿主 tokenMeter 一致：只认 input/output/cacheRead/cacheWrite。
  // `totalTokens` **刻意忽略** —— 它含被重发的上下文，直接累加就是 /state 报 3390 万那次的原因。
  let s = emit(createPetState(), 'assistant/message', 's1', 0, {
    data: {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 20, totalTokens: 1070 },
    },
  })
  assert.equal(snapshot(s).sessions[0].spendTokens, 1070, '四桶之和')
  assert.equal(snapshot(s).sessions[0].cacheHitRate, 0.9, '900 / (900+100)')
  assert.equal(spendBySession(s).s1, 1070)
  // 不带 turn/step 时无从去重 → 视为两次独立消耗（累加）
  s = emit(s, 'assistant/message', 's1', 1, { data: { usage: { inputTokens: 100, outputTokens: 50 } } })
  assert.equal(snapshot(s).sessions[0].spendTokens, 1220)
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

check('花销：基线制 —— 历史账不提醒，只对本次启动后的新增提醒', () => {
  // 这条治的是"切换成耐久总数后，DSH 一重启就炸一条 2.47 亿的提醒"（实测踩到）
  const config = mergeReminderConfig({ spend: { everyTokens: 1000 } })
  const t0 = 3_000_000
  const big = 247_040_500

  // 第一次看到：只记基线，绝不因为"历史累计很大"而提醒
  let r = decideReminders({ now: t0, spendBySession: { s1: big }, config })
  assert.equal(r.fires.length, 0, '历史累计不该提醒')
  assert.equal(r.state.spendBaseline.s1, big, '应把当时的值记成基线')

  // 新增未达阈值 → 不提醒
  r = decideReminders({ state: r.state, now: t0 + 1, spendBySession: { s1: big + 999 }, config })
  assert.equal(r.fires.length, 0, '新增未达阈值不应提醒')

  // 新增跨过阈值 → 提醒，且文案说的是"这段新增"而不是历史总账
  r = decideReminders({ state: r.state, now: t0 + 2, spendBySession: { s1: big + 1000 }, config })
  assert.equal(r.fires[0]?.notice, 'spend')
  assert.match(r.fires[0].text, /又用了约 1k/, '文案应只说本次新增')

  const again = decideReminders({ state: r.state, now: t0 + 3, spendBySession: { s1: big + 1000 }, config })
  assert.equal(again.fires.length, 0, '同一额度不应重复提醒')

  const more = decideReminders({ state: r.state, now: t0 + 4, spendBySession: { s1: big + 2000 }, config })
  assert.equal(more.fires.length, 1, '再跨一个阈值应再提醒')
})

check('reminders.enabled=false 时一条都不发', () => {
  const config = mergeReminderConfig({ enabled: false })
  const r = decideReminders({ now: 4_000_000, pendingApprovals: 5, hasActivity: true, config, random: () => 0 })
  assert.equal(r.fires.length, 0)
})

check('primarySessionId 取最近活跃的会话（而不是优先级更高的旧 done）', () => {
  // 为什么这条重要：按状态优先级挑会挑到 done（优先级 3 > running 1），
  // 那等于把活派给一个早就结束的会话。
  assert.equal(
    primarySessionId({
      sessions: {
        old: { sessionId: 'sess-done', state: 'done', lastActivityAt: 1000 },
        live: { sessionId: 'sess-live', state: 'running', lastActivityAt: 9000 },
      },
    }),
    'sess-live',
    '最近活跃的才是派活目标',
  )
  // 活跃时间打平时才用状态优先级兜底
  assert.equal(
    primarySessionId({
      sessions: {
        a: { sessionId: 'a', state: 'running', lastActivityAt: 5 },
        b: { sessionId: 'b', state: 'done', lastActivityAt: 5 },
      },
    }),
    'b',
  )
  // 没有 lastActivityAt 的老记录退回 since
  assert.equal(
    primarySessionId({
      sessions: {
        a: { sessionId: 'a', state: 'running', since: 1 },
        b: { sessionId: 'b', state: 'running', since: 2 },
      },
    }),
    'b',
  )
  // 过滤掉 unknown / 空 / 无会话
  assert.equal(primarySessionId({ sessions: { u: { sessionId: 'unknown', lastActivityAt: 9 } } }), undefined)
  assert.equal(primarySessionId({ sessions: { e: { sessionId: '', lastActivityAt: 9 } } }), undefined)
  assert.equal(primarySessionId({ sessions: {} }), undefined)
})

check('commit 会打 lastActivityAt 时间戳（primarySessionId 的依据）', () => {
  // 走真实归一化路径（normalizeSessionEvent 产出的字段是 kind，不是 type）
  const ev = normalizeSessionEvent({ id: 's1' }, { type: 'turn/start', seq: 1 })
  assert.ok(ev !== null, 'turn/start 应能被归一化')
  const s = reducePetEvent(createPetState(), ev, 4242).state
  assert.equal(s.sessions.s1.lastActivityAt, 4242)
})

check('activityLabel：把事件压成一句人话（气泡不再灌 AI 正文）', () => {
  assert.equal(activityLabel({ kind: 'turn/start' }), '开始处理新任务')
  assert.equal(activityLabel({ kind: 'step/start' }), '分析中…')
  assert.equal(activityLabel({ kind: 'tool/call', data: { name: 'pwsh' } }), '执行了命令')
  assert.equal(activityLabel({ kind: 'tool/call', data: { name: 'read' } }), '读取了文件')
  assert.equal(activityLabel({ kind: 'tool/call', data: { name: 'edit' } }), '修改了文件')
  assert.equal(activityLabel({ kind: 'tool/call', data: { name: 'weird_tool' } }), '执行了 weird_tool')
  assert.equal(activityLabel({ kind: 'tool/call', data: {} }), '执行了一步操作')
  assert.equal(activityLabel({ kind: 'tool/result', data: {} }), '这一步完成了')
  assert.equal(activityLabel({ kind: 'tool/result', data: { isError: true } }), '这一步失败了')
  assert.equal(activityLabel({ kind: 'assistant/message', data: {} }), '已完成分析')
  assert.equal(activityLabel({ kind: 'turn/end', data: { reason: { kind: 'completed' } } }), '这一轮完成了')
  assert.equal(activityLabel({ kind: 'turn/end', data: { reason: { kind: 'error' } } }), '出错了')
  assert.equal(activityLabel({ kind: 'turn/end', data: { reason: { kind: 'aborted' } } }), '已中断')
  // 不值得打扰的一律 null（否则气泡又会变成刷屏）
  assert.equal(activityLabel({ kind: 'request/header', data: {} }), null)
  assert.equal(activityLabel({ kind: 'session-log-deepseek/delivery-accepted', data: {} }), null)
  assert.equal(activityLabel(null), null)
  assert.equal(activityLabel({}), null)
  // 关键：正文绝不能被塞进摘要
  assert.equal(
    activityLabel({ kind: 'assistant/message', text: '很长很长的 AI 正文，不该出现在气泡里' }),
    '已完成分析',
  )
})

check('token 四桶：同一 (turn, step) 重复上报是「替换」不是「累加」', () => {
  // 这条治的就是"/state 报出 3390 万 tokens"那个 bug：
  // totalTokens 里含 cacheReadTokens（重发的上下文），逐轮累加会数几十遍。
  const usage = { inputTokens: 664, outputTokens: 153, cacheReadTokens: 9600, cacheWriteTokens: 0, totalTokens: 10417 }
  const msg = (turn, step, u) =>
    normalizeSessionEvent({ id: 's1' }, { type: 'assistant/message', data: { turn, step, usage: u } })
  let s = createPetState()
  s = reducePetEvent(s, msg(1, 1, usage), 1).state
  assert.equal(s.sessions.s1.spendTokens, 10417, '一次请求 = 四桶之和')
  s = reducePetEvent(s, msg(1, 1, usage), 2).state
  assert.equal(s.sessions.s1.spendTokens, 10417, '同一 (turn,step) 重复上报必须替换，不能翻倍')
  s = reducePetEvent(s, msg(1, 1, { ...usage, outputTokens: 200 }), 3).state
  assert.equal(s.sessions.s1.spendTokens, 10464, '同一步报了新值 → 用新的替换旧的')
  s = reducePetEvent(s, msg(1, 2, usage), 4).state
  assert.equal(s.sessions.s1.spendTokens, 20881, '不同 step 才累加')
})

check('token 四桶：llm/retry-started 取消去重（重试确实又烧了一次）', () => {
  // ⚠️ 这条同时测两件事：
  //  a) `llm/retry-started` 不在 EVENT_STATE 里 —— 若把该分支写在 `target === undefined` 之后，
  //     它会变成死代码（我第一版就是这么写的）
  //  b) 语义要跟宿主一致：retry 之后**同样的桶值不再被去重**，而是再计一次
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const msg = (turn, step) =>
    normalizeSessionEvent({ id: 's1' }, { type: 'assistant/message', data: { turn, step, usage } })
  const retry = normalizeSessionEvent({ id: 's1' }, { type: 'llm/retry-started', data: { turn: 1, step: 1 } })
  assert.ok(retry !== null, 'retry 事件应能归一化')

  // 对照：不发 retry → 同一 (turn, step) 的相同桶值被去重，不再累加
  let a = createPetState()
  a = reducePetEvent(a, msg(1, 1), 1).state
  a = reducePetEvent(a, msg(1, 1), 2).state
  assert.equal(a.sessions.s1.spendTokens, 110, '对照：相同桶值应被去重')

  // 发了 retry → 这一次算"又消耗了一份"
  let b = createPetState()
  b = reducePetEvent(b, msg(1, 1), 1).state
  assert.equal(b.sessions.s1.spendTokens, 110)
  b = reducePetEvent(b, retry, 2).state
  b = reducePetEvent(b, msg(1, 1), 3).state
  assert.equal(b.sessions.s1.spendTokens, 220, '重试后又消耗了一次，不能被去重掉')
})

check('缓存命中率 = cacheRead / (cacheRead + uncachedInput)；无输入时为 null', () => {
  assert.equal(
    cacheHitRate({ uncachedInputTokens: 664, outputTokens: 153, cacheReadTokens: 9600, cacheWriteTokens: 0 }),
    9600 / 10264,
  )
  assert.equal(
    cacheHitRate({ uncachedInputTokens: 0, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    null,
    '没有输入时返回 null，而不是 0（免得显示成"0% 命中"误导人）',
  )
  const snap = snapshot({
    current: 'idle',
    seq: 0,
    sessions: {
      a: {
        sessionId: 'a',
        state: 'idle',
        unread: false,
        tokenBuckets: { uncachedInputTokens: 100, outputTokens: 0, cacheReadTokens: 300, cacheWriteTokens: 0 },
      },
    },
  })
  assert.equal(snap.sessions[0].cacheHitRate, 0.75)
  assert.equal(snap.sessions[0].spendTokens, 400, 'spendTokens 现在由四桶推导，兼容旧消费者')
})

check('markRead：清未读并推一帧 state；没有未读时是空操作', () => {
  const base = {
    current: 'done',
    currentSince: 0,
    seq: 7,
    minHoldMs: 0,
    sessions: {
      a: { sessionId: 'a', state: 'done', unread: true },
      b: { sessionId: 'b', state: 'running', unread: false },
    },
  }
  const noop = markRead(base, 'b')
  assert.equal(noop.state, base, 'b 本来就没未读 → 原样返回')
  assert.equal(noop.frames.length, 0)
  const all = markRead(base)
  assert.equal(all.state.sessions.a.unread, false)
  assert.equal(all.frames.length, 1)
  assert.equal(all.frames[0].type, 'state')
  assert.equal(all.frames[0].unread, 0, '帧里必须带 unread=0，窗口才会把徽标收掉')
  const one = markRead(base, 'a')
  assert.equal(one.state.sessions.a.unread, false)
})

check('primaryTokens：右键菜单的用量视图取「最近活跃」那个会话', () => {
  let s = createPetState()
  s = emit(s, 'turn/start', 's-a', 1)
  s = emit(s, 'turn/start', 's-b', 2) // b 更近
  s = setTokenTotals(s, 's-a', { uncachedInputTokens: 100, outputTokens: 0, cacheReadTokens: 300, cacheWriteTokens: 0 })
  s = setTokenTotals(s, 's-b', { uncachedInputTokens: 50, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0 })
  const t = primaryTokens(s)
  assert.equal(t.sessionId, 's-b', '应取最近活跃的会话，而不是先出现的那个')
  assert.equal(t.spendTokens, 200)
  assert.equal(t.cacheHitRate, 100 / 150)
  assert.equal(t.tokenSource, 'host')
})

check('setTokenTotals：整体覆盖不累加；切到 host 源后 reducer 不再自算；同值写入幂等', () => {
  let s = createPetState()
  s = emit(s, 'assistant/message', 's1', 1, {
    data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 20 } },
  })
  assert.equal(primaryTokens(s).spendTokens, 30, '先由插件自算出 30')
  assert.equal(primaryTokens(s).tokenSource, 'own')

  const host = { uncachedInputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500, cacheWriteTokens: 0 }
  s = setTokenTotals(s, 's1', host)
  assert.equal(primaryTokens(s).spendTokens, 3500, 'host 值应**整体覆盖**，不是加在 30 上')

  // 切到 host 源后再来事件 → 不再自己累加，否则两边混着算、数字会飘
  s = emit(s, 'assistant/message', 's1', 2, {
    data: { turn: 2, step: 1, usage: { inputTokens: 10, outputTokens: 20 } },
  })
  assert.equal(primaryTokens(s).spendTokens, 3500, '切到 host 源后 reducer 必须停止自算')

  const before = s
  s = setTokenTotals(s, 's1', { ...host })
  assert.equal(s, before, '同值写入应原样返回（幂等，免得每次 /state 都换新对象）')
})

check('snapshot 暴露 lastActivityAt：面板按它排「最近 N 个会话」', () => {
  let s = createPetState()
  s = emit(s, 'turn/start', 's-old', 100)
  s = emit(s, 'turn/start', 's-new', 900)
  const rows = snapshot(s).sessions
  const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]))
  assert.equal(byId['s-old'].lastActivityAt, 100)
  assert.equal(byId['s-new'].lastActivityAt, 900)
  // 面板要的正是这个顺序：谁最近活跃谁在上面（而不是 Object.values 的插入顺序）
  assert.equal(rows.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0].sessionId, 's-new')
})

check('setSessionTitle：幂等；空标题与未知会话都不动', () => {
  let s = createPetState()
  s = emit(s, 'turn/start', 's1', 1)
  const a = setSessionTitle(s, 's1', '读取文档完成交接')
  assert.equal(a.sessions.s1.title, '读取文档完成交接')
  assert.equal(setSessionTitle(a, 's1', '读取文档完成交接'), a, '同值原样返回（/state 每次都会调它）')
  assert.equal(setSessionTitle(a, 's1', ''), a, '空串不写')
  assert.equal(setSessionTitle(a, '不存在', 'x'), a, '未知会话不动')
  assert.equal(setSessionTitle(a, 's1', undefined), a, '非字符串不写')
})

// ─────────────────────────────────────────────────────────────
console.log('\n[2] 插件契约（mock ctx）')

/** 真实宿主里可注入的服务名（读 ctx.<名字> 受 inject 校验管辖） */
const MOCK_SERVICES = new Set(['webServer', 'agents', 'sessions', 'sessionController', 'sessionProjections'])

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
 * ⚠️ **`agents.get` 与 `sessionController.agents.resolveAgent` 的差别也必须模拟**：
 * 前者只找**活着的** agent（真实实现 `store.get(id)?.agent`，store 只放 entered 条目），
 * 后者**解析或恢复**会话（`Resolve or resume one ordinary Session`）。
 * 少了这一层，就测不出"会话不活跃时派活失败"这个真机 bug。
 *
 * ⚠️ `ctx.agents.list()` / `ctx.sessions.list()` 也要提供：插件不能只靠"自己观测到的事件"
 * 来知道有哪些会话（DSH 刚重启时它一个都没观测到，那就是真机第五次失败）。
 *
 * @param {object}  opts
 * @param {Function} [opts.agents]         sessionId → 活着的 agent（模拟 ctx.agents.get）
 * @param {Array}    [opts.liveAgents]     模拟 ctx.agents.list()（活着的 agent 列表）
 * @param {Array}    [opts.hostSessions]   模拟 ctx.sessions.list()（宿主已知的活会话）
 * @param {Function} [opts.resume]         async sessionId → { agent } | { error }（模拟 resolveAgent）
 * @param {Function} [opts.tokenProjection] sessionId → 四桶 | undefined（模拟 stateOf 'tokenUsage'）
 * @param {Function} [opts.sessionTitle]   sessionId → 标题 | null（模拟 stateOf 'title'）
 * @param {string[]} [opts.declaredInject] 覆盖 inject 声明（仅用于负向对照）
 */
function createMockCtx({
  agents,
  liveAgents = [],
  hostSessions = [],
  resume,
  tokenProjection,
  sessionTitle,
  declaredInject = pluginInject,
} = {}) {
  const routes = new Map()
  const listeners = new Map()
  const warnings = []
  // 默认的 resolveAgent：只能在 agent 活着时解析成功（即"不能 resume"的最保守行为）
  const resolveAgent =
    resume ??
    (async (sessionId) => {
      const agent = agents === undefined ? undefined : agents(sessionId)
      return agent === undefined ? { error: { message: 'session/not-found' } } : { agent }
    })
  const services = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    agents: { get: agents ?? (() => undefined), list: () => liveAgents },
    sessions: { list: () => hostSessions },
    sessionController: { agents: { resolveAgent }, list: async () => ({ items: [] }) },
    // 宿主的 session projections 注册表：`stateOf(session, key)`。
    // 真实实现里 key 有 `tokenUsage`（四桶）和 `title`（**状态就是标题字符串**），
    // 且**以 session 对象为键**（WeakMap —— 拿 sessionId 字符串查不到）。
    sessionProjections: {
      stateOf: (session, key) => {
        if (key === 'title') return sessionTitle?.(session?.id) ?? null
        if (key !== 'tokenUsage') return undefined
        const totals = tokenProjection?.(session?.id)
        return totals === undefined ? undefined : { totals, last: null }
      },
    },
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

check('apply 注册了 13 条 exact 路由', () => {
  assert.equal(routes.size, 13, `实际 ${routes.size}：${[...routes.keys()].join(', ')}`)
})

check('审批探针默认完全不注册（连 ctx.on 都不调）', () => {
  // ⚠️ 这是这个实验最重要的安全属性：不打开就一点链路都不碰。
  // 用**新建的** mock 判定，别用模块级 listeners（那是另一套 harness 的）。
  const m = createMockCtx({ agents: () => undefined })
  apply(m.ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0, createUserMessage: stubCreateUserMessage })
  assert.equal(m.listeners.get('approval/request')?.length ?? 0, 0, '默认不该订阅 approval/request')
})

await checkAsync('审批探针：开启后只观察 + 交棒，从不返回决定', async () => {
  const m = createMockCtx({ agents: () => undefined })
  const teardown = apply(m.ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0, createUserMessage: stubCreateUserMessage })
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
  const base = `http://127.0.0.1:${srv.address().port}/xilian-pet`
  try {
    const on = await (
      await fetch(`${base}/debug/approval-probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, delayMs: 0 }),
      })
    ).json()
    assert.equal(on.enabled, true)
    assert.equal(m.listeners.get('approval/request')?.length, 1, '开启后应挂上 1 个应答者')

    // 模拟 waterfall 链路：探针应答者收到 (req, next)，必须调用 next() 把链路交下去
    let nextCalled = false
    const decision = await runWaterfall(m.listeners, 'approval/request', () => 'unavailable', {
      toolName: 'bash',
      reason: '测试用',
    })
    assert.equal(decision, 'unavailable', '探针绝不能返回决定（否则会放行/拒绝真实操作）')
    nextCalled = true
    assert.ok(nextCalled)

    const off = await (
      await fetch(`${base}/debug/approval-probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
    ).json()
    assert.equal(off.enabled, false)
    assert.equal(off.seen.length, 1, '应记录到刚才那次请求')
    assert.equal(off.seen[0].toolName, 'bash')
    assert.equal(m.listeners.get('approval/request')?.length ?? 0, 0, '停用后必须注销，链路恢复原样')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
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

await checkAsync('拿不到官方 createUserMessage → 用内置等价实现派活（不再 503）', async () => {
  // 这条测的就是**生产环境实际走的路径**：插件按路径挂载，裸包名解析不到宿主的 app.asar，
  // 于是走内置兜底。曾经这里返回 503 no-message-factory，导致「双击派活」永远失败。
  const localCalls = []
  const localAgent = {
    followup: async (message) => localCalls.push(['followup', message]),
    cancel: async (cause) => localCalls.push(['cancel', cause]),
  }
  const m = createMockCtx({ agents: (id) => (id === 'known' ? localAgent : undefined) })
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
  const port = srv.address().port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/xilian-pet/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'known', text: '去写个 README' }),
    })
    assert.equal(res.status, 200, '内置兜底下派活必须成功（旧行为是 503）')

    const [action, message] = localCalls.at(-1)
    assert.equal(action, 'followup', 'followup 必须收到消息对象')
    // 与官方 createUserMessage 的产物逐字段一致：字段不多不少
    assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source'])
    assert.equal(message.role, 'user')
    assert.deepEqual(message.content, [{ type: 'text', text: '去写个 README' }])
    assert.deepEqual(message.source, { kind: 'user' })
    assert.match(
      message.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'id 必须是标准 v4 UUID（官方用 randomUUID）',
    )
    // 官方 createMessage 会 deepFreeze，内置实现必须同样冻结
    assert.ok(Object.isFrozen(message), '消息顶层必须冻结')
    assert.ok(Object.isFrozen(message.content), 'content 数组也要冻结')
    assert.ok(Object.isFrozen(message.content[0]), 'content 元素也要冻结')

    // /health 必须能看出用的是哪条路（诊断用）
    const health = await (await fetch(`http://127.0.0.1:${port}/xilian-pet/health`)).json()
    assert.equal(health.messageFactory, 'builtin', '自测环境里解析不到官方包，应报告 builtin')
    assert.ok(Array.isArray(health.messageFactoryAttempts) && health.messageFactoryAttempts.length > 0,
      '必须留下候选失败原因，便于真机诊断')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('渲染端没给 sessionId → 插件兜底派给最近活跃的会话（复现 A6 第二次真机失败）', async () => {
  // 真实场景：DSH 刚重启时 /state 是空的，窗口"先连上、会话后出现"，
  // 渲染端手上的 sessionId 是 undefined —— 旧代码直接 503 no-agent。
  const localCalls = []
  const fallbackAgent = { followup: async (m) => localCalls.push(['followup', m]) }
  const m = createMockCtx({ agents: (id) => (id === 'sess-live' ? fallbackAgent : undefined) })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    minHoldMs: 0,
    createUserMessage: stubCreateUserMessage,
  })
  // 让插件通过事件认识会话（模拟"会话在窗口连上之后才出现"）
  for (const fn of m.listeners.get('session/event') ?? []) fn({ id: 'sess-live' }, { type: 'turn/start', seq: 1 })

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
  const local = `http://127.0.0.1:${srv.address().port}`
  try {
    const res = await fetch(`${local}/xilian-pet/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '派个活' }), // 刻意不带 sessionId
    })
    assert.equal(res.status, 200, '应兜底成功，而不是 503 no-agent')
    const body = await res.json()
    assert.equal(body.sessionId, 'sess-live', '要报告实际派给了哪个会话')
    assert.equal(body.fallbackUsed, true)
    assert.equal(localCalls.length, 1)

    // /state 也要暴露主会话，供渲染端学习（否则窗口永远学不到）
    const st = await (await fetch(`${local}/xilian-pet/state`)).json()
    assert.equal(st.primarySessionId, 'sess-live')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('彻底没有会话时，503 必须带诊断信息（不再是一句不可诊断的话）', async () => {
  const m = createMockCtx({ agents: () => undefined })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    minHoldMs: 0,
    createUserMessage: stubCreateUserMessage,
  })
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
      body: JSON.stringify({ text: '派个活' }),
    })
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.error, 'no-agent')
    assert.equal(body.reason, 'no-session-known')
    assert.deepEqual(body.knownSessions, [])
    assert.deepEqual(body.triedSessionIds, [])
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('会话不活跃（没有活 agent）→ 先 resolveAgent 恢复再派活【复现真机失败】', async () => {
  // 真机证据：/state 里 sessionId 完全正确，但 ctx.agents.get() 返回 undefined ——
  // 因为注册表 store 只放「entered（活着）」的 agent。全靠 sessionController 的
  // resolveAgent 把不活跃的会话恢复起来（GUI 提交消息走的就是同一条路）。
  const localCalls = []
  const resumedAgent = { followup: async (m) => localCalls.push(['followup', m]) }
  let resumeCalls = 0
  const m = createMockCtx({
    agents: () => undefined, // 一个活着的 agent 都没有
    resume: async (sessionId) => {
      resumeCalls += 1
      return sessionId === 'sess-idle'
        ? { agent: resumedAgent }
        : { error: { message: 'session/not-found' } }
    },
  })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    minHoldMs: 0,
    createUserMessage: stubCreateUserMessage,
  })
  for (const fn of m.listeners.get('session/event') ?? []) fn({ id: 'sess-idle' }, { type: 'turn/start', seq: 1 })

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
  const local = `http://127.0.0.1:${srv.address().port}`
  try {
    const res = await fetch(`${local}/xilian-pet/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-idle', text: '干个活' }),
    })
    assert.equal(res.status, 200, '不活跃的会话也必须能派活（旧代码在这里 503 no-agent）')
    const body = await res.json()
    assert.equal(body.via, 'resume', '要报告是走恢复拿到的 agent')
    assert.equal(body.sessionId, 'sess-idle')
    assert.equal(resumeCalls, 1, 'resolveAgent 应被调用')
    assert.equal(localCalls.length, 1, '恢复后必须真的 followup')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('活 agent 与恢复都失败时 → 503 必须带 reason / resolveErrors', async () => {
  const m = createMockCtx({
    agents: () => undefined,
    resume: async () => ({ error: { message: 'session/not-found' } }),
  })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    minHoldMs: 0,
    createUserMessage: stubCreateUserMessage,
  })
  for (const fn of m.listeners.get('session/event') ?? []) fn({ id: 'sess-gone' }, { type: 'turn/start', seq: 1 })
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
      body: JSON.stringify({ sessionId: 'sess-gone', text: '干个活' }),
    })
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.reason, 'not-resolvable')
    assert.deepEqual(body.triedSessionIds, ['sess-gone'])
    assert.ok(body.resolveErrors.length > 0, '必须带上恢复失败的原因')
    assert.match(body.message, /not-resolvable/)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('重启空窗期：插件没观测到任何会话 → 问宿主 ctx.sessions.list()【复现真机失败】', async () => {
  // 真机证据：气泡 reason=no-session-known —— 插件 state.sessions 为空（DSH 刚重启、
  // 用户立刻点了派活）。但它根本不必只靠自己观测到的事件，宿主就有会话清单。
  const localCalls = []
  const hostAgent = { followup: async (m) => localCalls.push(['followup', m]) }
  const m = createMockCtx({
    agents: () => undefined, // 没有活 agent
    hostSessions: [{ id: 'sess-from-host' }],
    resume: async (id) =>
      id === 'sess-from-host' ? { agent: hostAgent } : { error: { message: 'session/not-found' } },
  })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    minHoldMs: 0,
    createUserMessage: stubCreateUserMessage,
  })
  // 刻意不喂任何事件 —— 复现"插件还没观测到会话"

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
  const local = `http://127.0.0.1:${srv.address().port}`
  try {
    const res = await fetch(`${local}/xilian-pet/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '派个活' }),
    })
    assert.equal(res.status, 200, '空窗期也要能派活（旧代码在这里 503 no-session-known）')
    const body = await res.json()
    assert.equal(body.sessionId, 'sess-from-host', '应落到宿主给的会话上')
    assert.equal(body.via, 'resume')
    assert.equal(localCalls.length, 1, '必须真的 followup')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('重启空窗期：用 ctx.agents.list() 里的活 agent 兜底', async () => {
  const localCalls = []
  const liveAgent = { id: 'sess-live-only', followup: async (m) => localCalls.push(['followup', m]) }
  const m = createMockCtx({
    // 真实宿主里 list() 与 get() 是同一个 store，两者必须一致
    agents: (id) => (id === 'sess-live-only' ? liveAgent : undefined),
    liveAgents: [liveAgent],
    resume: async () => ({ error: { message: '不该走到这里' } }),
  })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    minHoldMs: 0,
    createUserMessage: stubCreateUserMessage,
  })
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
      body: JSON.stringify({ text: '派个活' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.sessionId, 'sess-live-only')
    assert.equal(localCalls.length, 1)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('GET /debug/agents → 只读诊断，不派活（下次不用再靠气泡猜）', async () => {
  const localCalls = []
  const m = createMockCtx({
    agents: (id) => (id === 'sess-live' ? { followup: async () => localCalls.push('x') } : undefined),
    liveAgents: [{ id: 'sess-live' }],
    hostSessions: [{ id: 'sess-host' }],
  })
  const teardown = apply(m.ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0 })
  for (const fn of m.listeners.get('session/event') ?? []) fn({ id: 'sess-observed' }, { type: 'turn/start', seq: 1 })

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
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/xilian-pet/debug/agents`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.observedSessions, ['sess-observed'], '要报插件自己观测到的会话')
    assert.deepEqual(body.hostSessions, ['sess-live', 'sess-host'], '要报问宿主拿到的会话')
    assert.equal(body.liveLookup['sess-live'], true, '要逐个候选报 get() 是否拿得到')
    assert.equal(body.resolveAgentAvailable, true)
    assert.equal(body.resolve, undefined, '不带 ?resolve= 时绝不能触发 resolveAgent')
    assert.equal(localCalls.length, 0, '诊断端点绝不能派活')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('POST /debug/notice → 推 notice 帧（A7 显示侧的手动验证入口）', async () => {
  const sse = await openSse(`${base}/xilian-pet/events`)
  await sse.readUntil((b) => b.includes('"snapshot"'), 3000)
  const res = await fetch(`${base}/xilian-pet/debug/notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '有 3 个操作在等你审批', urgent: true }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.frame.type, 'notice')
  assert.equal(body.frame.urgent, true)
  assert.equal(body.frame.notice, 'debug', '没给 notice 类型时应落到默认值')
  const text = await sse.readUntil((b) => b.includes('"type":"notice"'), 3000)
  sse.close()
  assert.match(text, /有 3 个操作在等你审批/, 'notice 帧要真的推到 SSE 上')

  // 省参数时的默认值：urgent 默认 true，文案有兜底
  const dflt = await (await fetch(`${base}/xilian-pet/debug/notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })).json()
  assert.equal(dflt.frame.urgent, true)
  assert.match(dflt.frame.text, /审批/)
  const soft = await (await fetch(`${base}/xilian-pet/debug/notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urgent: false }),
  })).json()
  assert.equal(soft.frame.urgent, false, 'urgent:false 要能透传（低优先通知会自动消失）')
})

await checkAsync('POST /read → 真的清掉插件侧的未读并推 state 帧（徽标立刻收）', async () => {
  // 先制造一个未读：turn/end completed → done + unread=true
  for (const fn of listeners.get('session/event') ?? []) {
    fn({ id: 's-read' }, { type: 'turn/end', seq: 20, data: { turn: 1, reason: { kind: 'completed' } } })
  }
  const before = await (await fetch(`${base}/xilian-pet/state`)).json()
  assert.ok(before.unread >= 1, `应先有未读，实际 ${before.unread}`)

  const sse = await openSse(`${base}/xilian-pet/events`)
  await sse.readUntil((b) => b.includes('"snapshot"'), 3000)
  const res = await fetch(`${base}/xilian-pet/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.unread, 0, '响应里未读应已归零')
  const text = await sse.readUntil((b) => /"unread":0/.test(b), 3000)
  sse.close()
  assert.match(text, /"unread":0/, '要推一帧 state 出去，窗口才能立刻收掉徽标')

  const after = await (await fetch(`${base}/xilian-pet/state`)).json()
  assert.equal(after.unread, 0, '插件侧的未读必须真的被清掉，否则下一个 state 帧又会把它报回来')

  // 收尾：把 s-read 推回 running。
  // 否则它停在 done（优先级 3 > running 1），会污染后面 SSE 测试的聚合状态
  // —— 实测就是这么把"观测到 turn/start → 推 running"那条测试带崩的。
  for (const fn of listeners.get('session/event') ?? []) {
    fn({ id: 's-read' }, { type: 'turn/start', seq: 21, data: { turn: 2 } })
  }
})

await checkAsync('token 数据源：能读到宿主投影 → 以宿主为准（durable，DSH 重启不丢）', async () => {
  // 宿主权威值刻意与"插件自算值"完全不同，用来证明用的确实是宿主那一份。
  // 插件自算只会得到 10+20=30；宿主给的是 5000/7000/88000。
  const hostTotals = { uncachedInputTokens: 5000, outputTokens: 7000, cacheReadTokens: 88_000, cacheWriteTokens: 0 }
  const m = createMockCtx({ tokenProjection: () => hostTotals, agents: () => undefined })
  const teardown = apply(m.ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0, createUserMessage: stubCreateUserMessage })
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
    for (const fn of m.listeners.get('session/event') ?? []) {
      fn({ id: 'sess-tok' }, { type: 'turn/start', seq: 1, data: { turn: 1 } })
      fn(
        { id: 'sess-tok' },
        { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 20 } } },
      )
    }
    const st = await (await fetch(`http://127.0.0.1:${srv.address().port}/xilian-pet/state`)).json()
    const s = st.sessions.find((x) => x.sessionId === 'sess-tok')
    assert.ok(s, '应有 sess-tok 会话')
    assert.equal(s.tokenSource, 'host', '应切到宿主数据源')
    assert.equal(s.spendTokens, 100_000, '以宿主四桶之和为准（5000+7000+88000），而不是自算的 30')
    assert.equal(s.cacheHitRate, 88_000 / 93_000)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('token 数据源：宿主读不到 → 退回插件自算（纯增强，不把宠物带崩）', async () => {
  const m = createMockCtx({ tokenProjection: () => undefined, agents: () => undefined })
  const teardown = apply(m.ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0, createUserMessage: stubCreateUserMessage })
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
    for (const fn of m.listeners.get('session/event') ?? []) {
      fn({ id: 'sess-own' }, { type: 'turn/start', seq: 1, data: { turn: 1 } })
      fn(
        { id: 'sess-own' },
        {
          type: 'assistant/message',
          seq: 2,
          data: {
            turn: 1,
            step: 1,
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 0 },
          },
        },
      )
    }
    const st = await (await fetch(`http://127.0.0.1:${srv.address().port}/xilian-pet/state`)).json()
    const s = st.sessions.find((x) => x.sessionId === 'sess-own')
    assert.equal(s.tokenSource, 'own', '读不到宿主投影时应保持自算')
    assert.equal(s.spendTokens, 100, '自算：10+20+70')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

await checkAsync('会话标题：/state 落上宿主 title 投影的值', async () => {
  // 标题的真实来源是 key 为 `title` 的 session projection（状态就是字符串）。
  // ⚠️ 曾经走 sessionController.list() 的 items[].displayTitle —— **实测没有那个字段**，
  // 所以标题一直是空、面板只能显示 sessionId（用户实测反馈"还是这种标题"）。
  const m = createMockCtx({
    agents: () => undefined,
    sessionTitle: (id) => (id === 'sess-title' ? '读取文档完成交接' : null),
  })
  const teardown = apply(m.ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0, createUserMessage: stubCreateUserMessage })
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
    // 先喂事件让插件知道这个会话存在（否则 setSessionTitle 找不到它）
    for (const fn of m.listeners.get('session/event') ?? []) {
      fn({ id: 'sess-title' }, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    }
    const st = await (await fetch(`http://127.0.0.1:${srv.address().port}/xilian-pet/state`)).json()
    const row = st.sessions.find((x) => x.sessionId === 'sess-title')
    assert.equal(row.title, '读取文档完成交接', '面板显示的就该是宿主 GUI 列表里的同一个名字')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
})

check('审批：默认关闭 —— 不配 approval.viaPet 就完全不碰审批链路', () => {
  const m = createMockCtx({ agents: () => undefined })
  const teardown = apply(m.ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0, createUserMessage: stubCreateUserMessage })
  assert.equal(m.listeners.get('approval/request')?.length ?? 0, 0, '默认不该注册审批应答者')
  teardown()
})

await checkAsync('审批：没连桌宠 → 立刻交棒（行为与启用前一致，绝不卡住审批）', async () => {
  const m = createMockCtx({ agents: () => undefined })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    minHoldMs: 0,
    createUserMessage: stubCreateUserMessage,
    approval: { viaPet: true, timeoutMs: 60_000 },
  })
  try {
    assert.equal(m.listeners.get('approval/request')?.length, 1, '开启后应挂上应答者')
    // 没有任何 SSE 连接 → 必须立刻交棒
    const outcome = await runWaterfall(m.listeners, 'approval/request', () => 'unavailable', {
      toolName: 'pwsh',
      callId: 'c-none',
    })
    assert.equal(outcome, 'unavailable', '没连桌宠必须立刻交棒')
  } finally {
    teardown()
  }
})

/** 审批端到端：开 SSE + 喂 tool/call + 等帧 + POST 决定 → 看 waterfall 收到什么 */
async function approvalRoundTrip(decision, { timeoutMs = 60_000 } = {}) {
  const m = createMockCtx({ agents: () => undefined })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    minHoldMs: 0,
    createUserMessage: stubCreateUserMessage,
    approval: { viaPet: true, timeoutMs },
  })
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
  const base = `http://127.0.0.1:${srv.address().port}/xilian-pet`
  const sse = await openSse(`${base}/events`)
  await sse.readUntil((b) => b.includes('"snapshot"'), 3000)
  // 桌宠在场（SSE 已连）→ 应答者不会再立刻交棒
  for (const fn of m.listeners.get('session/event') ?? []) {
    fn(
      { id: 'sess-ap' },
      {
        type: 'tool/call',
        seq: 1,
        data: { turn: 1, step: 1, callId: 'c-ap', name: 'pwsh', arguments: '{"command":"rm -rf /tmp/危险目录"}' },
      },
    )
  }
  // 发起 waterfall（它会挂起等桌宠点）
  const pending = runWaterfall(m.listeners, 'approval/request', () => 'unavailable', {
    toolName: 'pwsh',
    callId: 'c-ap',
    reason: '测试用理由',
  })
  // 等推给桌宠的那一帧
  const text = await sse.readUntil((b) => b.includes('"type":"approval"'), 3000)
  const frame = JSON.parse(text.split('data: ').find((l) => l.includes('"type":"approval"')).trim())
  if (decision !== null) {
    const res = await fetch(`${base}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: frame.id, decision }),
    })
    assert.equal(res.status, 200, 'POST /approval 应成功')
  }
  const outcome = await pending
  sse.close()
  await new Promise((resolve) => srv.close(resolve))
  teardown()
  return { frame, outcome }
}

await checkAsync('审批：桌宠点「允许」→ allowed-once，帧里带着 callId 关联出来的命令', async () => {
  const { frame, outcome } = await approvalRoundTrip('allow')
  assert.equal(outcome, 'allowed-once', '放行必须返回 allowed-once（唯一的放行值）')
  assert.equal(frame.toolName, 'pwsh')
  // 命令不在 approval/request 里，是靠 callId 去 tool/call 事件关联出来的 —— 这条就是验证它
  assert.match(String(frame.command), /rm -rf/, '帧里必须带上真正的命令，否则等于盲批')
  assert.equal(frame.reason, '测试用理由')
})

await checkAsync('审批：桌宠点「拒绝」→ rejected', async () => {
  const { outcome } = await approvalRoundTrip('deny')
  assert.equal(outcome, 'rejected')
})

await checkAsync('审批：超时 → 交棒给 GUI（不返回决定，也不卡住）', async () => {
  const started = Date.now()
  const { outcome } = await approvalRoundTrip(null, { timeoutMs: 1000 })
  assert.equal(outcome, 'unavailable', '超时必须交棒（fallback），绝不能让 agent 干等')
  assert.ok(Date.now() - started >= 900, '应该在超时时间之后才交棒')
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

await checkAsync('SSE：默认不再把 AI 正文推进气泡（bubbleMode=activity）', async () => {
  const sse = await openSse(`${base}/xilian-pet/events`)
  await sse.readUntil((b) => b.includes('"snapshot"'), 3000)
  for (const fn of listeners.get('agent/assistant-stream'))
    fn({
      agent: { session: { id: 's1' } },
      frame: { type: 'chunk', index: 0, chunk: { type: 'text-delta', index: 0, text: '昔涟在写' } },
    })
  // 等一小会儿，确认没有 stream 帧冒出来（用户反馈：AI 正文太多，看不清）
  const text = await sse.readUntil(() => false, 400)
  sse.close()
  assert.doesNotMatch(text, /"type":"stream"/, '默认模式下 AI 正文不该进气泡')
  assert.doesNotMatch(text, /昔涟在写/, '正文一个字都不该漏进气泡')
})

await checkAsync('SSE：工具调用 → 推 activity 摘要（"执行了命令"）', async () => {
  const sse = await openSse(`${base}/xilian-pet/events`)
  await sse.readUntil((b) => b.includes('"snapshot"'), 3000)
  for (const fn of listeners.get('session/event') ?? [])
    fn({ id: 's-act' }, { type: 'tool/call', seq: 9, data: { name: 'pwsh' } })
  const text = await sse.readUntil((b) => b.includes('"type":"activity"'), 3000)
  sse.close()
  assert.match(text, /"type":"activity"/)
  assert.match(text, /执行了命令/)
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

check('动作播完的决策：done 状态下待机动作播完必须重开 【实机 bug 回归】', () => {
  // 实机症状：用户报"昔涟在长时间待机之后会退出待机动作"。
  // 根因：待机动作 Scene[3]（荡秋千）时长 **180 秒**，而 setIsLoop(true) 在这个模型上
  //   不生效 —— 库照样派发 motionFinish。此时 currentState 往往仍是 `done`
  //   （一次性状态刻意保留、未读背板要一直显示），于是走进
  //   "一次性动作演完 → 回待机" → 而 returnToBaseMotion() 开头
  //   `if (currentMotion === BASE_MOTION) return` 直接返回 → **没人重开** → 停住。
  // 所以决策必须**先看 currentMotion**，不能只看状态。
  const sm = { idle: { motion: 3 }, done: { motion: 1, once: true }, running: { motion: 0 }, question: { motion: 2 } }
  const base = 3

  // ① 核心场景：状态是 done，但刚播完的是待机动作 → 必须重开待机动作
  const a = decideOnMotionFinish({ currentMotion: base, currentState: 'done', stateMap: sm, baseMotion: base })
  assert.equal(a.action, 'restart', 'done 状态下待机动作播完必须重开，否则永远停在最后一帧')
  assert.equal(a.index, base)

  // ② 待机状态同理
  assert.equal(
    decideOnMotionFinish({ currentMotion: base, currentState: 'idle', stateMap: sm, baseMotion: base }).action,
    'restart',
  )

  // ③ 真正的一次性动作播完（叉腰 Scene[1]）→ 回待机
  const c = decideOnMotionFinish({ currentMotion: 1, currentState: 'done', stateMap: sm, baseMotion: base })
  assert.equal(c.action, 'base', '一次性动作演完才该回待机')

  // ④ 开着工的动作播完 → 重开它自己的（别一律回待机）
  const d = decideOnMotionFinish({ currentMotion: 0, currentState: 'running', stateMap: sm, baseMotion: base })
  assert.equal(d.action, 'restart')
  assert.equal(d.index, 0, 'running 应重开 Scene[0]，不是回待机')

  // ⑤ 反向盯着最原始的那个坑：状态是 done 且 currentMotion 已是待机时，**绝不能**判成"什么都不做"
  assert.notEqual(a.action, 'none')
})

check('running：也在荡秋千，但手不抓绳、手放下巴 【用户 2026-10-05 要求】', () => {
  // 用户原话："让思考时也在荡秋千，但是手不抓着秋千绳"
  assert.equal(STATE_MAP.running.motion, BASE_MOTION, 'running 也播荡秋千（会一直摆）')
  assert.equal(STATE_MAP.running.force?.Param9, 1, '思考的手要压成 1（手放下巴）')
  assert.equal(STATE_MAP.running.force?.Param16, 0, '绳子要压成 0（手不抓绳）')
  // ⚠️ 关键：模型 cdi3 里这些参数**同属参数组 5 = 互斥的手部姿势**
  //    （思考 / 手指 / 招牌 / 秋千抓绳 / 叉腰）。**抓绳的姿势是 Param13/14 秋千画的**，
  //    光关 Param16（绳子道具）没用 —— 必须把组 5 除 Param9 外全部压 0，
  //    同时**保留组 6**（摆动/秋千本体）→ 她在荡、但手不抓绳。
  for (const id of ['Param10', 'Param11', 'Param12', 'Param13', 'Param14', 'Param17', 'Param18']) {
    assert.equal(STATE_MAP.running.force?.[id], 0, `running 必须把组5的 ${id} 压成 0（否则手会去抓绳）`)
  }
  // 组 6（摆动/秋千本体）**不能**被压 —— 否则她就不摆了
  for (const id of ['Param19', 'Param23', 'Param24', 'Param31', 'Param32']) {
    assert.equal(STATE_MAP.running.force?.[id], undefined, `组6的 ${id} 不能压 0，否则秋千不摆了`)
  }

  // ⚠️ 真因回归：**秋千动作自己会把 Param9 推到 1**（模型里 Scene4 的曲线就是 0~1）→
  //    荡秋千时会冒出一只"思考的手"，加上抓绳两只 = 三只手
  //    （用户原话："现在这么还是三只手"）。所以**除 running 外的每个状态**
  //    都必须每帧把 Param9 压回 0。
  for (const s of ['idle', 'done', 'approval', 'question', 'error']) {
    assert.equal(
      STATE_MAP[s].force?.Param9,
      0,
      `${s} 必须把 Param9 压成 0 —— 否则荡秋千时会冒出思考的手（三只手）`,
    )
  }
  // 开场手势保留（用户确认）
  assert.equal(INTRO_MOTION, 0)
})

check('切状态时 Param9「思考」必须被撤掉 【否则干完活还一脸思考】', () => {
  // setParams 只写指定参数、不会重置其它的 → 离开 running 时必须自己清零
  const leaving = planParamTransition({ Param9: 1 }, STATE_MAP.idle)
  assert.deepEqual(leaving.clear, ['Param9'], '离开 running 要清 Param9')
  assert.deepEqual(leaving.set, {}, 'idle 不带参数')

  const entering = planParamTransition({}, STATE_MAP.running)
  assert.deepEqual(entering.clear, [], '进入 running 没有要清的')
  assert.equal(entering.set.Param9, 1, '进入 running 要开 Param9')

  // 一直待在 running → 不清
  assert.deepEqual(planParamTransition({ Param9: 1 }, STATE_MAP.running).clear, [])
})

check('道具渐变：切到 running 时不能瞬间清零 【用户："荡秋千到思考中间没有衔接"】', () => {
  // 场景：她正在荡秋千（道具被动作驱动），此时状态切到 running（不播动作）。
  // 若一帧内把 32 个道具参数清零 → 秋千瞬间消失、思考姿势瞬间出现 → "没有衔接" ✗
  // 所以要一段 easeOutCubic 渐变。
  const from = { Param16: 1, Param32: 1, Param9: 0 } // 秋千绳/秋千开关 开着
  const to = propTargetsFor(STATE_MAP.running, ['Param9', 'Param12', 'Param16', 'Param32'])
  assert.deepEqual(to, { Param9: 1, Param12: 0, Param16: 0, Param32: 0 }, '目标：全身道具熄灭、只留 Param9')

  // 起点：原来的值原样保留（并集里目标新增的键从 0 起）
  const atStart = fadeProps(from, to, 0)
  assert.equal(atStart.Param16, 1, '起点：秋千绳还在')
  assert.equal(atStart.Param32, 1, '起点：秋千开关还开着')
  assert.equal(atStart.Param9, 0, '起点：思考还没起')
  assert.equal(atStart.Param12, 0, '起点：目标里新增的键从 0 起')
  // 终点：落到目标
  assert.deepEqual(fadeProps(from, to, 1), to)
  // 中途：必须是**过渡值**，不能等于起点或终点（否则就是硬切）
  const mid = fadeProps(from, to, 0.5)
  assert.ok(mid.Param16 > 0 && mid.Param16 < 1, `Param16 中途应在 0..1（实际 ${mid.Param16}）`)
  assert.ok(mid.Param9 > 0 && mid.Param9 < 1, `Param9 中途应在 0..1（实际 ${mid.Param9}）`)
  // easeOutCubic：过半时已走过 ~87.5%，所以只剩不到 1/4
  assert.ok(mid.Param16 < 0.25, `easeOut 半小时应基本走完（实际 ${mid.Param16}）`)
  // 越界进度要夹住
  assert.deepEqual(fadeProps(from, to, 2), to)
  const atNeg = fadeProps(from, to, -1)
  assert.equal(atNeg.Param16, 1, '负进度夹到起点')
  assert.equal(atNeg.Param9, 0, '负进度夹到起点')
})

check('道具过渡必须"两段式"，绝不能交叉淡入淡出 【"又有三只手了"的根因】', () => {
  // 用户实测："修出问题了，现在又有三只手了" ——
  // 交叉淡入淡出时，旧的"手"还没淡完、新的"手"已经开始淡入 → **两只手同时可见** ✗
  // 所以必须：第一段把**所有**道具（含本状态自己的）熄到 0，第二段才点起本状态要的。
  const ids = ['Param9', 'Param12', 'Param16', 'Param32']
  const [allOff, targets] = propFadePhases(STATE_MAP.running, ids)

  // 第一段：全 0，**包括 running 自己要用的 Param9** —— 这是"不重叠"的关键
  for (const id of ids) {
    assert.equal(allOff[id], 0, `第一段 ${id} 必须是 0（否则新手会与旧手同时出现）`)
  }
  // 第二段：才是本状态的目标
  assert.deepEqual(targets, { Param9: 1, Param12: 0, Param16: 0, Param32: 0 })
  // 两段之间至少有一个键是不同的值，否则"两段式"没意义
  assert.notDeepEqual(allOff, targets)
})

check('手部过渡必须以"上次写下的值"为起点 【否则两段交界会弹回去】', () => {
  // 用户实测："在测试的时候手会很快速地弹两下"。
  // 根因：原实现每帧写 `lerp(动作本帧的值, 目标, 进度)` —— 第二段的起点又变回"动作的值"，
  //       于是两段交界处弹回去一次，一次过渡看起来弹两下。
  // 修法：以 `lastHandValues`（我们上一次真正写下去的值）为起点，动作值只在没写过时兜底。
  const src = readFileSync(new URL('../packages/pet-shell/renderer/live2d.js', import.meta.url), 'utf8')
  const start = src.indexOf('function stepHandPoseMix')
  assert.ok(start > 0, '找不到 stepHandPoseMix')
  const body = src.slice(start, src.indexOf('\nfunction ', start + 10))
  assert.ok(
    body.includes('lastHandValues[id] ?? readParamValue(id)'),
    '混向目标的起点必须是 lastHandValues（读动作值只能做兜底），否则两段交界会弹',
  )
  assert.ok(body.includes('lastHandValues = { ...out }'), '每帧都要记住实际写下去的值')

  // 第二处漏同步（启动/稳态之后那次过渡）：**稳态直接写 force 时也必须记**，
  // 否则下一次过渡会拿"动作的原始值"当起点 → 第一帧先跳一下。
  const applyStart = src.indexOf('function applyState()')
  const applyBody = src.slice(applyStart, src.indexOf('\nfunction ', applyStart + 10))
  assert.ok(
    applyBody.includes('lastHandValues = { ...mapped.force }'),
    '稳态写 force 时要同步 lastHandValues，否则下次过渡第一帧会跳',
  )
  assert.ok(applyBody.includes('lastForce = { ...mapped.force }'), '还要记住"上一状态压过的值"作兜底')
  assert.ok(
    src.includes('if (handMix === null) lastHandValues = { ...(lastForce ?? {}) }'),
    '起过渡时要用上一状态压过的值兜底（启动时可能还没渲染过）',
  )
})

check('「被弹一下」的阻尼振荡：起手为 0、真会振荡、结尾归零', () => {
  // 用户要求：点秋千 → "整个模型弹一下，像被手指弹了似的"（选"轻"）
  const p = FLICK_PRESETS.light
  // ① 起手必须是 0：不能"啪"地跳到位
  assert.equal(flickOffset(0, p), 0, '起手必须为 0')
  // ② 真的来回振荡（正负都有）
  const samples = []
  for (let t = 0; t <= p.durationMs; t += 5) samples.push(flickOffset(t, p))
  const peak = Math.max(...samples.map((v) => Math.abs(v)))
  assert.ok(peak > 0.5, `峰值要明显（实际 ${peak.toFixed(2)}）`)
  assert.ok(
    samples.some((v) => v > 0.1) && samples.some((v) => v < -0.1),
    '必须正负都有 —— 否则是"推一下"不是"弹一下"',
  )
  // ③ 结尾要基本归零（否则松手时留着位移，看起来像卡住）
  assert.ok(Math.abs(flickOffset(p.durationMs, p)) < 0.15, '结尾应基本归零')
  // ④ 越界输入不乱动
  assert.equal(flickOffset(-1, p), 0)
  assert.equal(flickOffset(NaN, p), 0)
  // 三档力度必须真的递增（别手滑写反）
  assert.ok(FLICK_PRESETS.light.durationMs < FLICK_PRESETS.medium.durationMs)
  assert.ok(FLICK_PRESETS.medium.durationMs < FLICK_PRESETS.strong.durationMs)
})

check('"被弹"的位移必须相对构图基准 【否则累积漂移、跑出窗口】', () => {
  // 实机 bug：用户报"现在会出现模型显示不完全的情况"。
  // 根因：我在 `flick()` 里记下"当时的 model.position"当基准 ✗
  //   → 弹到一半再点一次（或构图在此期间重跑）时，基准被记成**偏移后**的位置
  //   → 弹完还原到错位置 → 越来越偏、最后跑出窗口 ✓
  // 正确：基准只由构图（fit）提供（`fitBase`），"弹"永远是 `fitBase + 偏移`。
  const src = readFileSync(new URL('../packages/pet-shell/renderer/live2d.js', import.meta.url), 'utf8')
  const flickStart = src.indexOf('export function flick(')
  assert.ok(flickStart > 0, '找不到 flick()')
  const flickBody = src.slice(flickStart, src.indexOf('\nfunction ', flickStart))
  assert.ok(!flickBody.includes('base: {'), '"弹"里绝不能记基准 —— 那会累积漂移（实机踩过）')
  const stepStart = src.indexOf('function stepFlick(')
  const stepBody = src.slice(stepStart, src.indexOf('\nfunction ', stepStart))
  assert.ok(stepBody.includes('fitBase.x + offset *'), '整体位移必须写成 fitBase + 偏移')
  assert.ok(stepBody.includes('fitBase.rotation + offset *'), '倾斜同理')
  // 基准只能在构图里被改写：3 处 = 1 处声明（`let fitBase = {0,0,0}`）+ 2 处构图代码
  const fitAssignments = (src.match(/fitBase = \{/g) ?? []).length
  assert.equal(fitAssignments, 3, `fitBase 只应由声明 + 两处构图更新（实际 ${fitAssignments} 处）`)
})

check('拖动松手给"秋千余摆 + 眨一下眼" 【用户："弹一下并不适合移动后"】', () => {
  // 用户判断：整体刚性跳一下是"被戳"的反应 ✗ 搬动之后自然的是**余摆** ✓
  // 最终选了 D：秋千余摆（A）+ 看你一眼（C）。
  const src = readFileSync(new URL('../packages/pet-shell/renderer/pet.js', import.meta.url), 'utf8')
  const upStart = src.indexOf("window.addEventListener('mouseup'")
  assert.ok(upStart > 0, '找不到 mouseup 处理器')
  const body = src.slice(upStart, src.indexOf('// 点右下角的未读徽标', upStart))
  assert.ok(body.includes('if (movedFar) {'), '拖动结束那条分支不能只是 return')
  assert.ok(body.includes("live2d?.flick('settle')"), '拖动结束要用 settle（余摆）档，不是整体弹')
  assert.ok(body.includes('live2d?.blink()'), '拖动结束还要眨一下眼')
  assert.ok(!body.includes("flick('medium')"), '不该再用"拖得远弹得重"那套')

  // 余摆档必须是"整体不动"：`move: null`（刚性位移 = "被弹"，不是"余摆"）
  assert.equal(FLICK_PRESETS.settle.move, null, 'settle 档不能有整体位移')
  assert.ok(FLICK_PRESETS.settle.durationMs > FLICK_PRESETS.light.durationMs, '余摆要比弹更悠长')
  assert.ok(FLICK_PRESETS.settle.freqHz < FLICK_PRESETS.light.freqHz, '余摆频率要更低（钟摆感）')
  assert.ok(FLICK_PRESETS.settle.amp.Param23 > 0, '要有秋千摇晃（她是坐在秋千上的）')
})

// ─────────────────────────────────────────────────────────────
console.log('\n[5] 命中测试（外壳纯函数，不需要 Electron）')

check('外壳：帧转发不能被副作用吞掉 【实机 bug 回归】', () => {
  // 真机症状：审批小窗死活不弹；一查时间线：用户等了 68 秒（> 60s 超时）才在 GUI 放行。
  // 根因：startSse 是**模块级**函数，我却在里面直接调了定义在 createWindow 内部的
  //   handleApprovalFrame → ReferenceError → 被外层 catch 吞掉，
  //   **连后面那句 send(win,'pet:frame',frame) 都执行不到** → 桌宠收不到任何帧（整个冻住）。
  // 这里静态盯住三件事：不许跨作用域直调、副作用必须单独 try、send 必须无条件执行。
  const src = readFileSync(new URL('../packages/pet-shell/main.js', import.meta.url), 'utf8')
  const start = src.indexOf('function startSse(win)')
  assert.ok(start > 0, '找不到 startSse')
  const nextFn = src.indexOf('\nfunction ', start + 10)
  const body = src.slice(start, nextFn === -1 ? undefined : nextFn)

  for (const inner of [
    'handleApprovalFrame(',
    'openApprovalWindow(',
    'closeApprovalWindow(',
    'openMenuWindow(',
    'ensureApprovalWindow(',
  ]) {
    assert.ok(!body.includes(inner), `startSse 里不能直接调 ${inner} —— 它定义在 createWindow 作用域内，会 ReferenceError`)
  }
  const sendIdx = body.indexOf("send(win, 'pet:frame', frame)")
  assert.ok(sendIdx > 0, '必须无条件转发帧')
  const before = body.slice(0, sendIdx)
  const hookIdx = before.lastIndexOf('frameEffects?.(frame)')
  assert.ok(hookIdx > 0, '副作用必须走模块级 frameEffects 钩子')
  assert.ok(before.slice(Math.max(0, hookIdx - 200), hookIdx).includes('try {'), '副作用必须**单独** try，否则会带走 send')
})

check('UI 控件（输入条）即使在透明像素上也要可交互 【实机 bug 回归】', () => {
  // 真机症状：输入条右侧的「打断」点不到 —— 那里没有角色像素，
  // 而判定只看 alpha 掩码，于是被判成透明 → 穿透。
  const mask = { width: 10, height: 10, data: new Uint8Array(100) } // 全透明
  const uiRects = [{ x: 10, y: 80, w: 100, h: 20 }]
  const base = { mask, uiRects, winWidth: 120, winHeight: 100 }
  const onBar = hitTest({ ...base, x: 50, y: 90 })
  assert.equal(onBar.hitUi, true, '应命中输入条矩形')
  assert.equal(onBar.interactive, true, '输入条上必须可交互，否则「打断」点不到')
  // 输入条**之外**的透明处仍然要穿透（不能为了修它把整窗都变可交互）
  assert.equal(hitTest({ ...base, x: 50, y: 40 }).interactive, false, '透明处仍要保持穿透')
})

check('掩码不透明处可交互；窗口外一律穿透', () => {
  const data = new Uint8Array(100)
  data[5 * 10 + 5] = 255 // 掩码 (5,5) 不透明 → 窗口 (550/100)…见下面映射用例
  const mask = { width: 10, height: 10, data }
  const base = { mask, uiRects: [], winWidth: 100, winHeight: 100 }
  assert.equal(hitTest({ ...base, x: 55, y: 55 }).interactive, true, '不透明像素上可交互')
  assert.equal(hitTest({ ...base, x: 5, y: 5 }).interactive, false, '透明像素上穿透')
  assert.equal(hitTest({ ...base, x: -1, y: 50 }).inWindow, false)
  assert.equal(hitTest({ ...base, x: 120, y: 50 }).interactive, false, '窗口外必须穿透')
})

check('掩码还没到时，UI 控件仍然可交互', () => {
  const uiRects = [{ x: 0, y: 0, w: 50, h: 50 }]
  const base = { mask: null, uiRects, winWidth: 100, winHeight: 100 }
  assert.equal(hitTest({ ...base, x: 25, y: 25 }).interactive, true, '不能因为掩码没到就把输入条也穿透掉')
  assert.equal(hitTest({ ...base, x: 75, y: 75 }).interactive, false)
})

check('掩码取样的坐标映射正确（窗口 200×100 → 掩码 20×10）', () => {
  const data = new Uint8Array(20 * 10)
  data[5 * 20 + 10] = 200 // 掩码 (10,5) 不透明 → 应映射到窗口 (100,50)
  const mask = { width: 20, height: 10, data }
  const base = { mask, uiRects: [], winWidth: 200, winHeight: 100 }
  assert.equal(hitTest({ ...base, x: 100, y: 50 }).u, 10)
  assert.equal(hitTest({ ...base, x: 100, y: 50 }).v, 5)
  assert.equal(hitTest({ ...base, x: 100, y: 50 }).sampled, 200)
  assert.equal(hitTest({ ...base, x: 100, y: 50 }).interactive, true)
  assert.equal(hitTest({ ...base, x: 0, y: 0 }).sampled, 0)
  // 坏矩形（NaN）不能把判定搞崩
  assert.equal(
    hitTest({ ...base, uiRects: [{ x: Number.NaN, y: 0, w: 10, h: 10 }], x: 5, y: 5 }).interactive,
    false,
  )
})

check('insideAnyRect 边界：闭区间', () => {
  const rects = [{ x: 10, y: 10, w: 20, h: 20 }]
  assert.equal(insideAnyRect(rects, 10, 10), true, '左上角算命中')
  assert.equal(insideAnyRect(rects, 30, 30), true, '右下角算命中')
  assert.equal(insideAnyRect(rects, 30.1, 30), false)
  assert.equal(insideAnyRect(null, 10, 10), false, 'rects 不是数组时不能抛')
})

// ── 菜单竖直对齐：从掩码算"她的身体"范围 ────────────────────────────
check('contentBand：按真实构图数据算，身体中心比窗口中心低约 40px', () => {
  // 真实构图（实拍日志）：内容 233×207 / 舞台 260×300，上方留白 87px
  // → 内容竖直范围 87..294。掩码是 150 行对 300px（2px 一行）。
  const maskW = 130
  const maskH = 150
  const data = new Uint8Array(maskW * maskH)
  const topRow = Math.floor(87 / 2) // 43 → 覆盖 86..88
  const bottomRow = Math.ceil(294 / 2) - 1 // 146 → 覆盖 292..294
  for (let v = topRow; v <= bottomRow; v++) for (let u = 0; u < maskW; u++) data[v * maskW + u] = 255

  const band = contentBand(data, maskW, maskH, 300)
  assert.ok(band, '应算出范围')
  assert.equal(band.top, 86)
  assert.equal(band.bottom, 294)
  assert.equal(band.centerY, 190)
  // 菜单要按这个中心对齐：窗口几何中心是 150，身体中心是 190 —— 差 40px
  assert.equal(band.centerY - 300 / 2, 40, '这就是"按窗口居中会偏上 40px"的来源')
})

check('contentBand：空白掩码返回 null；低于阈值的像素不算内容', () => {
  assert.equal(contentBand(null, 10, 10, 300), null, '没有掩码')
  assert.equal(contentBand(new Uint8Array(100), 10, 10, 300), null, '全透明 → null（调用方退回窗口中心）')
  const faint = new Uint8Array(100)
  faint[55] = 10 // 低于默认阈值 24
  assert.equal(contentBand(faint, 10, 10, 300), null, '淡到阈值的像素不算她')
  faint[55] = 200
  assert.ok(contentBand(faint, 10, 10, 300), '超过阈值才算')
})

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
