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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

import { apply, inject as pluginInject } from '../packages/pet-plugin/index.js'
import {
  PART_NAMES,
  PART_ZONES,
  contentBand,
  draggingExpired,
  hitTest,
  insideAnyRect,
  pickPartAt,
  pointInDrawableLocal,
  rawToLocal,
} from '../packages/pet-shell/hit-test.js'
import { createSseLink } from '../packages/pet-shell/sse-link.js'
import { addPluginRow, looksLikePluginEntryPath, looksLikeProfilePatch, pluginRowSnippet, readPluginRowPath, removePluginRow } from './lib/patch-edit.mjs'
import {
  collectReleaseFiles,
  describeVariant,
  formatSha256Sidecar,
  nodeRuntimeFiles,
  readGitCommit,
  readVersions,
  releaseInfoText,
  releaseTimestamp,
  releaseVariant,
  releaseZipName,
  requiredInRelease,
  shouldDescend,
  shouldInclude,
} from './lib/release-files.mjs'
import {
  checkForUpdate,
  compareVersions,
  formatCheckResult,
  parseManifest,
  pickAsset,
  serializeManifest,
  upsertManifest,
} from './lib/update-check.mjs'
import { writeZipToBuffer } from './lib/zip-writer.mjs'
import {
  BASE_MOTION,
  FLICK_PRESETS,
  HEAD_PAT,
  INTRO_MOTION,
  STATE_MAP,
  SWING_COMBO,
  createSwingCombo,
  decideOnMotionFinish,
  describeFlick,
  easeInOutCubic,
  easeOutCubic,
  fadeProps,
  flickOffset,
  headPatEnvelope,
  inTriangle,
  planParamTransition,
  propFadePhases,
  propTargetsFor,
  resolvePokeParams,
  swingComboClick,
} from '../packages/pet-shell/renderer/motion-policy.js'
import {
  TURN_END_STATE,
  activityLabel,
  aggregate,
  cacheHitRate,
  createPetState,
  hasActivity,
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

check('未读功能已整体移除：快照里不再有 unread 字段 【用户："把未读功能去除"】', () => {
  // 曾经的语义：done / error 记未读、running 清未读、渲染端显示 +N 背板。
  // 2026-10-05 用户要求整体去除 → 这条断言把"真的没了"钉住，
  // 避免哪天有人顺手把它加回来（那会连带恢复一组已经删掉的 UI 和路由）。
  const s = emit(createPetState(), 'turn/end', 's1', 0)
  assert.equal(aggregate(s), 'done', 'done 状态本身要保留（动作靠它触发）')
  assert.equal('unread' in snapshot(s), false, '快照里不该再有 unread')
  assert.equal('sessions' in snapshot(s), true)
  for (const sess of snapshot(s).sessions) {
    assert.equal('unread' in sess, false, '每个会话也不该再有 unread')
  }
  // 状态帧同样不该带 unread（渲染端已经没有徽标可收）
  for (const f of emit(s, 'turn/start', 's1', 1000).frames ?? []) {
    if (f.type === 'state') assert.equal('unread' in f, false, 'state 帧不该带 unread')
  }
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

check('agent/status idle **会把 done 降回 idle** 【未读移除后的新语义】', () => {
  // 以前 done 带"未读"，刻意不让 idle 抹掉它（要等用户看过）。
  // 未读功能移除后，"刚结束"只是一瞬间的事 —— `agent/status: idle` 一到就该回待机 ✓
  // （动作不受影响：done 的一次性动作是在**状态切换时**触发的，
  //   从 done 降回 idle 正是"演完回去荡秋千"的正常路径 ✓）
  let s = emit(createPetState(), 'turn/end', 's1', 0)
  assert.equal(aggregate(s), 'done')
  s = reduceAgentStatus(s, { sessionId: 's1', status: 'idle' }, 1000).state
  assert.equal(aggregate(s), 'idle', 'done 必须能被 idle 降档，否则状态会挂住')
})

check('agent/status idle 也能把 error 降回 idle', () => {
  // error 同理：没有未读就没有"必须等用户看过"的理由
  let s = reduceAgentError(createPetState(), { sessionId: 's1', message: 'boom' }, 0).state
  assert.equal(aggregate(s), 'error')
  s = reduceAgentStatus(s, { sessionId: 's1', status: 'idle' }, 1000).state
  assert.equal(aggregate(s), 'idle')
})

check('agent/status running → running', () => {
  let s = emit(createPetState(), 'turn/end', 's1', 0)
  s = reduceAgentStatus(s, { sessionId: 's1', status: 'running' }, 2000).state
  assert.equal(aggregate(s), 'running')
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
check('agent/error → 出错档 + notice 帧', () => {
  const r = reduceAgentError(createPetState(), { sessionId: 's1', message: 'boom' }, 0)
  assert.equal(aggregate(r.state), 'error')
  assert.equal(r.frames.find((f) => f.type === 'notice')?.notice, 'error')
})

// ── turn/end 按 reason 分流 ─────────────────────────────────────
check('turn/end completed → done', () => {
  const s = emit(createPetState(), 'turn/end', 's1', 0, { data: { reason: { kind: 'completed' } } })
  assert.equal(aggregate(s), 'done')
})

check('turn/end interrupted → 空闲（用户自己打断的）', () => {
  const s = emit(createPetState(), 'turn/end', 's1', 0, { data: { reason: { kind: 'interrupted' } } })
  assert.equal(aggregate(s), 'idle')
})

check('turn/end error → 出错', () => {
  const s = emit(createPetState(), 'turn/end', 's1', 0, {
    data: { reason: { kind: 'error', error: { message: 'llm failed' } } },
  })
  assert.equal(aggregate(s), 'error')
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

check('花销提醒默认关闭 【用户："把这个弹窗去掉"】', () => {
  // 截图里那条"这段时间又用了约 376k tokens" = 花销提醒。
  // 用户要求去掉 → 默认 `everyTokens: 0`（关掉的只是默认开关，机制还在，显式配就能开回来）。
  const config = mergeReminderConfig({})
  assert.equal(config.spend.everyTokens, 0, '默认必须是 0（关闭）')

  // 就算 token 暴涨，默认配置也一条都不该发
  const big = 10_000_000
  let r = decideReminders({ now: 0, spendBySession: { s1: big }, config })
  r = decideReminders({ state: r.state, now: 1000, spendBySession: { s1: big + 5_000_000 }, config })
  r = decideReminders({ state: r.state, now: 2000, spendBySession: { s1: big + 50_000_000 }, config })
  assert.equal(
    r.fires.filter((f) => f.notice === 'spend').length,
    0,
    '默认配置下不该再弹花销提醒',
  )

  // 机制保留：显式配置仍能开回来（上一条测试覆盖了行为）
  assert.equal(mergeReminderConfig({ spend: { everyTokens: 500_000 } }).spend.everyTokens, 500_000)
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
        tokenBuckets: { uncachedInputTokens: 100, outputTokens: 0, cacheReadTokens: 300, cacheWriteTokens: 0 },
      },
    },
  })
  assert.equal(snap.sessions[0].cacheHitRate, 0.75)
  assert.equal(snap.sessions[0].spendTokens, 400, 'spendTokens 现在由四桶推导，兼容旧消费者')
})

check('未读相关代码已从 reducer 彻底删除 【静态钉住，防止被顺手加回来】', () => {
  const src = readFileSync(new URL('../packages/pet-plugin/reducer.js', import.meta.url), 'utf8')
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line)) // 去掉注释行（注释里会提到 unread 说明历史）
    .join('\n')
  assert.equal(/unread/.test(code), false, 'reducer 的**代码**里不该再出现 unread')
  assert.equal(/export function markRead/.test(code), false, 'markRead 已删除')
  assert.equal(/export function unreadCount/.test(code), false, 'unreadCount 已删除')
  // TURN_END_STATE 只表达状态了
  assert.deepEqual(TURN_END_STATE.completed, { state: 'done' })
  assert.deepEqual(TURN_END_STATE.error, { state: 'error' })
})

check('插件不再注册 POST /read 路由 【静态】', () => {
  const src = readFileSync(new URL('../packages/pet-plugin/index.js', import.meta.url), 'utf8')
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
    .join('\n')
  assert.equal(/pathPrefix\}\/read/.test(code), false, '`${pathPrefix}/read` 路由必须已删除')
  assert.equal(/markRead\(/.test(code), false, '不该再引用 markRead')
  assert.equal(/unreadCount\(/.test(code), false, '不该再引用 unreadCount')
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

check('apply 注册了 12 条 exact 路由 【未读移除后由 13 减为 12】', () => {
  assert.equal(routes.size, 12, `实际 ${routes.size}：${[...routes.keys()].join(', ')}`)
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

await checkAsync('GET /health 回显**生效后**的配置（改 profile config 后能一眼验活）', async () => {
  // 为什么必须有：`approval.viaPet` 这类开关只改变插件内部行为，**没有任何端点能读出它**
  // —— 从手写 patch 切到官方 bundle 时，光看文件分不清生效的是包内默认值还是 profile 覆盖。
  const body = await (await fetch(`${base}/xilian-pet/health`)).json()
  assert.equal(typeof body.config, 'object', '/health 必须回显生效配置')
  assert.equal(body.config.pathPrefix, '/xilian-pet')
  assert.equal(body.config.minHoldMs, 0, '必须是**生效后**的值（这里传了 0），不是代码默认 500')
  assert.equal(body.config.captureRawShapes, 20, '没传就该落到代码默认 20')
  assert.equal(body.config.bubbleMode, 'activity')
  assert.equal(body.config.approvalViaPet, false, '默认 false：绝不擅自改变宿主原有的审批行为')
  assert.equal(body.config.remindersEnabled, true)
})

await checkAsync('配置回声的**正向对照**：显式打开 viaPet / 关掉提醒必须如实反映', async () => {
  // 没有这条，"回声永远报默认值"也能让上面那条绿 —— 那回声就是假的（自测骗自己）。
  const m = createMockCtx({ agents: () => undefined })
  const teardown = apply(m.ctx, {
    pathPrefix: '/xilian-pet',
    approval: { viaPet: true, timeoutMs: 12_345 },
    reminders: { enabled: false },
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
    const body = await (await fetch(`http://127.0.0.1:${srv.address().port}/xilian-pet/health`)).json()
    assert.equal(body.config.approvalViaPet, true, 'viaPet=true 必须回声成 true')
    assert.equal(body.config.approvalTimeoutMs, 12_345, 'timeoutMs 也要如实回声')
    assert.equal(body.config.remindersEnabled, false, 'reminders.enabled=false 必须回声成 false')
    // 回声必须**与行为一致**：开了 viaPet 就必须真的挂上审批应答者，不能只改数字
    assert.equal(
      m.listeners.get('approval/request')?.length ?? 0,
      1,
      'viaPet=true 时必须注册 approval/request（回声与行为不许各说各话）',
    )
  } finally {
    await new Promise((resolve) => srv.close(resolve))
    teardown()
  }
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

await checkAsync('POST /read 已随未读功能移除（返回 404，不再有这层副作用）', async () => {
  // 未读移除后，这个路由**必须真的不存在** —— 渲染端也删掉了调用方，
  // 但如果路由还留着，就会出现"接口在、没人用"的半吊子状态（以后容易被误用）。
  const res = await fetch(`${base}/xilian-pet/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 404, 'POST /read 应该已经没有注册了')
  // `/state` 里也不该再有 unread 字段
  const snap = await (await fetch(`${base}/xilian-pet/state`)).json()
  assert.equal('unread' in snap, false, '/state 不该再返回 unread')
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

await checkAsync('回归：载荷里是**会抛错的 Cordis 代理**时，agent/status 预览仍可读 【真机 20/20 全丢】', async () => {
  // ⚠️ 上面那条用的是"普通对象 + 循环引用"，那是**比真实宿主宽松**的造法 ——
  //    真机里 `agent` 是 Cordis context 代理：读**任何**未在 inject 声明的属性都会抛
  //    （含 `JSON.stringify` 一定会读的 `toJSON`）→ 整条预览退化成 `<unserializable>`。
  //    实机实测 `/debug/shapes` 的 agent/status 通道 **20/20 条**全丢，而这是状态机最关键的输入。
  //    这里把 mock 收紧成"会抛的代理"，才测得出真问题（历史教训：mock 比真实宿主宽松 → 假绿）。
  const target = { session: { id: 's1' }, ctx: { whatever: 1 } }
  const agentProxy = new Proxy(target, {
    get(t, prop) {
      if (prop === 'session') return t.session
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
    has: () => true,
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  })
  for (const fn of listeners.get('agent/status')) fn({ agent: agentProxy, status: 'running' })

  const body = await (await fetch(`${base}/xilian-pet/debug/shapes`)).json()
  const sample = body.shapes.filter((s) => s.channel === 'agent/status').at(-1)
  assert.ok(sample, '应记录到 agent/status 样本')
  assert.ok(
    !sample.preview.startsWith('<unserializable'),
    `预览被代理的异常毁掉了（就是真机那个 bug）：${sample.preview}`,
  )
  assert.match(sample.preview, /"status":"running"/, '关键字段 status 必须能看见')
  assert.match(sample.preview, /"session"/, '读得到的属性要保留')
  assert.match(sample.preview, /读取失败/, '读不到的属性要就地标注，而不是拖垮整条预览')
  assert.ok(!/\[object Object\]/.test(sample.preview), '不该退化成无信息量的 [object Object]')
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

check('每一档的启动文案都能安全生成 【settle 的 move 是 null，拼字符串会崩】', () => {
  // 真实 bug：`flick()` 里直接拼 `preset.move.px`，而 settle 档 `move: null`
  // → `null.px` 抛 TypeError → flick 中途崩 → blink 执行不到
  // → 表现是"拖动松手完全无动作"（用户实测）✗
  for (const [level, preset] of Object.entries(FLICK_PRESETS)) {
    let text = null
    assert.doesNotThrow(() => {
      text = describeFlick(level, preset)
    }, `${level} 档的文案生成不能抛异常`)
    assert.ok(typeof text === 'string' && text.includes(`${preset.durationMs}ms`), `${level} 档文案内容不对：${text}`)
  }
  // settle（无整体位移）要明确写出来，别写成一个假的 0px
  assert.ok(describeFlick('settle', FLICK_PRESETS.settle).includes('整体不动'), 'settle 应说明"整体不动"')
  assert.ok(describeFlick('light', FLICK_PRESETS.light).includes('整体位移'), 'light 应说明整体位移')
})

// ─────────────────────────────────────────────────────────────
console.log('\n[5] 命中测试（外壳纯函数，不需要 Electron）')

check('部件级命中测试：坐标换算 / renderOrder z 序 / 分区归属 【点脸=墨镜 / 点头顶=惊喜 / 点秋千=弹一下】', () => {
  // 用户："点脸：墨镜。点头顶：惊喜"
  // 判定是**部件级**的：cdi3 的具名部件（Part18 脸 / Part8 头发 / Part5 秋千…）
  // + 画层三角形，而不是"竖直分段"那种估算 ✓

  // ① 纯几何：点-三角形（命中 / 不命中 / 边界 / 退化）
  assert.equal(inTriangle(0.25, 0.25, 0, 0, 1, 0, 0, 1), true, '内部应命中')
  assert.equal(inTriangle(0.9, 0.9, 0, 0, 1, 0, 0, 1), false, '外部不应命中')
  assert.equal(inTriangle(0.5, 0.5, 0, 0, 1, 0, 0, 1), true, '斜边上算命中（边界归内）')
  assert.equal(inTriangle(0, 0, 0, 0, 0, 0, 0, 0), false, '退化三角形不能命中')

  const live2d = readFileSync(new URL('../packages/pet-shell/renderer/live2d.js', import.meta.url), 'utf8')
  const pet = readFileSync(new URL('../packages/pet-shell/renderer/pet.js', import.meta.url), 'utf8')

  // ② 坐标换算 —— 必须与库 `getDrawableVertices()` 同源。用本模型**实测**的 canvasinfo。
  //    （4200 = CanvasWidth、3500 = CanvasHeight = PixelsPerUnit —— 三者不等，正是当年踩的坑）
  const canvas = { ppu: 3500, canvasWidth: 4200, canvasHeight: 3500 }
  assert.deepEqual(rawToLocal(0, 0, canvas), { x: 2100, y: 1750 }, 'raw 画布中心 → 局部中心')
  assert.deepEqual(rawToLocal(0.5, 0.5, canvas), { x: 3850, y: 0 }, 'raw 右上 → 局部右上角')
  assert.deepEqual(rawToLocal(-0.6, -0.5, canvas), { x: 0, y: 3500 }, 'raw 左下 → 局部左下角')
  // ⚠️ 反面断言 1：X 的系数是 **PixelsPerUnit(3500)**，不是 `CanvasWidth(4200)`。
  //    曾经写成 `(raw+0.5)*originalWidth` → 横向拉伸 1.2 倍，两侧边缘点不中 ✗
  assert.equal(rawToLocal(0.5, 0, canvas).x, 3850, 'X 系数必须是 PixelsPerUnit')
  assert.notEqual(rawToLocal(0.5, 0, canvas).x, (0.5 + 0.5) * 4200, 'X 绝不能用 CanvasWidth 当系数')
  // ⚠️ 反面断言 2：Y **必须取负**。漏负号 = 上下镜像 → 点下半身却去上半身找图形；
  //    用户症状"秋千靠下的部分一直点不到"就是这么来的（偏差最大 ±200px）✗
  assert.ok(rawToLocal(0, 0.4, canvas).y < rawToLocal(0, -0.4, canvas).y, 'raw +Y 必须映射到更小的局部 y')
  assert.equal(rawToLocal(0, 0.5, canvas).y, 0, 'raw 上边 → 局部 y=0')
  assert.equal(rawToLocal(0, -0.5, canvas).y, 3500, 'raw 下边 → 局部 y=画布高')

  // ③ 最前部件用 `renderOrder`（大 = 后画 = 在上），**不是数组下标**
  //    造一个局部正方形：raw x 0..0.1 → 局部 x 2100..2450；raw y 0..-0.1 → 局部 y 1750..2100
  const quad = [0, 0, 0.1, 0, 0.1, -0.1, 0, -0.1]
  const quadIdx = [0, 1, 2, 0, 2, 3]
  const mkDrawable = (index, partId, renderOrder) => ({ index, partId, renderOrder, positions: quad, indices: quadIdx })
  const back = mkDrawable(0, 'PartBack', 10)
  const front = mkDrawable(1, 'PartFront', 20)
  const IN = { x: 2200, y: 1800 }
  assert.equal(pickPartAt([back, front], IN.x, IN.y, canvas).partId, 'PartFront', 'renderOrder 大者在前')
  assert.equal(
    pickPartAt([front, back], IN.x, IN.y, canvas).partId,
    'PartFront',
    '结果与数组顺序无关（本模型的 renderOrder 是下标的置换，按下标当 z 序会取反）',
  )
  assert.equal(pickPartAt([back, front], 100, 100, canvas), null, '不在任何画层里 → null')
  const degenerate = { index: 2, partId: 'PartDegenerate', renderOrder: 99, positions: [0, 0, 0, 0, 0, 0], indices: [0, 1, 2] }
  assert.equal(pickPartAt([degenerate], IN.x, IN.y, canvas), null, '零面积画层不能吞掉点击')

  // ④ 分区语义：**最前面的部件说了算** —— 它没配区就什么都不发生。
  //    （旧语义"跳过没配区的继续往后找"会让点身体/头发穿透到最底层的秋千背景板 ✗）
  const zoneOf = (partId) => (partId === 'PartBack' ? 'swing' : null)
  assert.equal(pickPartAt([back, front], IN.x, IN.y, canvas, { zoneOf }), null, '最前面的没配区 → 什么都不发生')
  assert.equal(
    pickPartAt([back, front], IN.x, IN.y, canvas, { zoneOf, skipUnzoned: true }).zone,
    'swing',
    '旧语义（穿透）才拿得到后面的区 —— 保留作对照',
  )

  // ⑤ 分区表本身：纯数据，直接断言（**不再对源码做正则** —— 那正是上一条错公式被钉死的原因）
  assert.equal(PART_ZONES.Part18, 'face', '脸 → face')
  assert.equal(
    PART_ZONES.Part2,
    'face',
    '模组（额头/刘海那片**最前面**的部件）必须算脸 —— 漏了它点额头就没反应 ✗',
  )
  assert.equal(PART_ZONES.Part5, 'swing', '秋千 → swing')
  for (const p of ['Part7', 'Part8', 'Part31']) assert.equal(PART_ZONES[p], 'head', `${p} 应归 head`)
  // 用户 2026-10-05 明确收窄：两侧发、后发**不响应**
  for (const p of ['Part9', 'Part10', 'Part30']) {
    assert.equal(PART_ZONES[p], undefined, `${p}（两侧发/后发）不该配区 —— 用户要求"点了没反应"`)
  }
  // 身体/手/腿/裙摆/后裙同样不响应
  for (const p of ['Part', 'Part4', 'Part23', 'Part24', 'Part25', 'Part26', 'Part27', 'Part28', 'Part29']) {
    assert.equal(PART_ZONES[p], undefined, `${p} 不该配区`)
  }
  // 名字表必须覆盖 cdi3 里全部 **31** 个部件：漏一个就会把"最前面的部件"认成 `(未收录)` → 点了没反应 ✗
  assert.equal(Object.keys(PART_NAMES).length, 31, 'PART_NAMES 必须覆盖全部 31 个部件')
  for (const p of ['Part', 'Part2', 'Part3', 'Part4', 'Part12', 'Part15', 'Part17']) {
    assert.ok(PART_NAMES[p], `${p} 的名字不能缺`)
  }
  // 数据自洽：分区名只能是这三个；每个配了区的部件都必须有名字（否则气泡/日志里会出现 `undefined`）
  const ZONES = new Set(['face', 'head', 'swing'])
  for (const [part, zone] of Object.entries(PART_ZONES)) {
    assert.ok(ZONES.has(zone), `${part} 的分区名 ${zone} 不在 face/head/swing 里`)
    assert.ok(PART_NAMES[part], `${part} 配了区但 PART_NAMES 里没名字`)
  }

  // ⑥ 接线（wiring：断言"谁调谁"是合理的，数值逻辑已经在上面②③④⑤里真跑过了）
  assert.match(pet, /face: \(\) => live2d\?\.pokeExpression\('sunglasses'/, '点脸 → 墨镜')
  assert.match(pet, /head: \(\) => live2d\?\.patHead\(\)/, '点头顶 → 摸头专属反应（不是 surprise）')
  assert.equal(
    /head: \(\) => live2d\?\.pokeExpression\('surprise'/.test(pet),
    false,
    '点头顶**不能**再用 surprise —— 实测几乎看不出来，且语义不对（用户 2026-10-05 否掉）',
  )
  assert.match(pet, /swing: \(\) => live2d\?\.flick\('light'\)/, '点秋千 → 弹一下')
  assert.match(pet, /live2d\?\.hitPart\?\.\(event\.clientX, event\.clientY\)/, '点击直接把窗口坐标交给 hitPart')
  assert.match(pet, /live2d\.swingComboClick\(/, '秋千连点要走 motion-policy 的纯函数（可自测）')
  assert.match(pet, /pokeExpression\('spiral'/, '连点超过 5 次 → 出晕（spiral）')
  assert.match(pet, /live2d\?\.debugFrontPartName\?\.\(px, py\)/, '部件普查要用 debugFrontPartName')
  assert.match(pet, /function contentBox\(\)/, 'pet.js 仍需从掩码算内容框（普查/剖线用）')
  // 旧的"x 偏离中线"估算、"掩码自标定"、"错公式"必须彻底退休（并存会让行为说不清）
  assert.equal(/SWING_ZONE_RATIO/.test(pet), false, '旧的秋千估算常量必须删掉')
  assert.equal(/isSwingZone/.test(pet), false, '旧的秋千估算函数必须删掉')
  assert.equal(/unitMapper/.test(live2d), false, '旧的"掩码自标定"必须删掉（已由 rawToLocal 取代）')
  assert.equal(
    /\(positions\[vi \* 2\] \+ 0\.5\)/.test(live2d),
    false,
    '错公式 `(raw+0.5)*尺寸` 必须彻底删除（它导致横向拉伸 + 上下镜像）',
  )
})

check('秋千连点：固定 3s 窗口内超过 5 次 → 出晕 【用户 2026-10-05 定】', () => {
  // 用户原话："在 3s 内点击秋千超过 5 次就会触发晕"，并明确选了**固定窗口**（首次点击起算）
  const cfg = { windowMs: 3000, threshold: 5 }
  let st = createSwingCombo()
  const at = (t) => {
    const r = swingComboClick(st, t, cfg)
    st = r.state
    return r
  }
  // 3s 内连点 5 次：都不出晕
  for (let i = 1; i <= 5; i++) {
    const r = at(1000 + i * 100)
    assert.equal(r.count, i, `第 ${i} 次的计数`)
    assert.equal(r.dizzy, false, `第 ${i} 次（≤5）不该出晕`)
  }
  // 第 6 次（>5）→ 出晕，且窗口归零
  const sixth = at(1000 + 600)
  assert.equal(sixth.count, 6, '第 6 次计数为 6')
  assert.equal(sixth.dizzy, true, '3s 内第 6 次必须出晕')
  assert.equal(st.count, 0, '出晕后计数归零（避免"点一下晕一下"）')
  assert.equal(st.windowStart, null, '出晕后窗口关闭')

  // 窗口是**固定**的：从首次点击起算 3s；到点后重新起算
  let s2 = createSwingCombo()
  let r = swingComboClick(s2, 0, cfg)
  s2 = r.state
  assert.equal(r.count, 1, '首次点击从 1 开始')
  r = swingComboClick(s2, 2999, cfg)
  s2 = r.state
  assert.equal(r.count, 2, '仍在窗口内 → 累计')
  r = swingComboClick(s2, 3000, cfg)
  assert.equal(r.count, 1, '距首次点击已满 3000ms → 开新窗口、重新从 1 数')
  // 反面断言：若是**滑动**窗口，这一次会被算成第 3 次
  assert.notEqual(r.count, 3, '必须是固定窗口，不是滑动窗口')
  // 默认参数就是用户定的 3s / 5 次
  assert.equal(SWING_COMBO.windowMs, 3000, '默认窗口 3s')
  assert.equal(SWING_COMBO.threshold, 5, '默认阈值 5 次')
})

check('摸头顶反应：缓动包络 + 混合/叠加语义 + 幅度 【用户 2026-10-05：要先有过渡、幅度要够】', () => {
  // 用户否掉了原来的 surprise（"惊喜的效果并不适配摸头顶"），选了「舒服得眯起眼 + 轻轻歪头」；
  // 实机看过之后又提了两条硬要求：**幅度太小**、**没有过渡**（原来是瞬间贴上、到点瞬间撤掉）。
  // 这条用例就是锁这两条 —— 再退回"瞬间生效"或"幅度缩水"都会红。

  // ① 时长自洽
  assert.equal(
    HEAD_PAT.totalMs,
    HEAD_PAT.riseMs + HEAD_PAT.holdMs + HEAD_PAT.fallMs,
    'totalMs 必须等于 rise+hold+fall（否则包络与生命周期对不上）',
  )
  assert.ok(HEAD_PAT.totalMs >= 1200, `总时长要够长才感觉得到过渡，实际 ${HEAD_PAT.totalMs}ms`)
  assert.ok(HEAD_PAT.riseMs >= 200 && HEAD_PAT.fallMs >= 200, '起、回都要有足够时间，不能是"瞬间"')

  // ② 包络形状：0 → 1 → 0，且单调
  assert.equal(headPatEnvelope(-1, HEAD_PAT), 0, '还没开始 → 0')
  assert.equal(headPatEnvelope(0, HEAD_PAT), 0, 't=0 → 0（不能一开始就贴上去）')
  assert.ok(headPatEnvelope(HEAD_PAT.riseMs * 0.5, HEAD_PAT) > 0, '上升段中间应 > 0')
  assert.equal(headPatEnvelope(HEAD_PAT.riseMs, HEAD_PAT), 1, '上升段结束 → 1')
  assert.equal(headPatEnvelope(HEAD_PAT.riseMs + HEAD_PAT.holdMs / 2, HEAD_PAT), 1, '保持段 → 1')
  const nearEnd = headPatEnvelope(HEAD_PAT.totalMs - 1, HEAD_PAT)
  assert.ok(nearEnd > 0 && nearEnd < 1, `回落段末尾应在 (0,1) 之间，实际 ${nearEnd}`)
  assert.equal(headPatEnvelope(HEAD_PAT.totalMs, HEAD_PAT), 0, '到点 → 0（平滑回正，不是突然撤）')
  assert.equal(headPatEnvelope(HEAD_PAT.totalMs + 500, HEAD_PAT), 0, '超时 → 0')
  // 单调性：上升段严格不减、回落段严格不增
  let prev = -1
  for (let t = 0; t <= HEAD_PAT.riseMs; t += HEAD_PAT.riseMs / 20) {
    const v = headPatEnvelope(t, HEAD_PAT)
    assert.ok(v >= prev - 1e-9, `上升段必须单调不减（t=${t.toFixed(0)}）`)
    prev = v
  }
  prev = 2
  for (let t = HEAD_PAT.riseMs + HEAD_PAT.holdMs; t <= HEAD_PAT.totalMs; t += HEAD_PAT.fallMs / 20) {
    const v = headPatEnvelope(t, HEAD_PAT)
    assert.ok(v <= prev + 1e-9, `回落段必须单调不增（t=${t.toFixed(0)}）`)
    prev = v
  }
  // 过渡必须"平缓起步"：前 10% 时间里的位移不能已经吃掉大半（否则看起来还是瞬移）
  assert.ok(headPatEnvelope(HEAD_PAT.riseMs * 0.1, HEAD_PAT) < 0.35, '起步要平缓（10% 时不该到位）')
  // ⚠️ 关键回归保护：起步必须**两头慢**，不能用 easeOutCubic。
  //    实测 easeOut 在 80ms 就走完 58% → 用户反馈"没有过渡、看着像啪一下贴上去" ✗
  const q = HEAD_PAT.riseMs / 4 // 上升段走过 1/4 时间时
  assert.ok(
    headPatEnvelope(q, HEAD_PAT) < 0.2,
    `上升段 1/4 时间处必须仍很小（两头慢），实际 ${headPatEnvelope(q, HEAD_PAT).toFixed(3)} —— 用 easeOutCubic 会到 0.58`,
  )
  assert.ok(Math.abs(headPatEnvelope(HEAD_PAT.riseMs / 2, HEAD_PAT) - 0.5) < 1e-6, '上升段中点 = 0.5（对称）')
  // 缓动函数本身
  assert.equal(easeInOutCubic(0), 0); assert.equal(easeInOutCubic(1), 1); assert.equal(easeInOutCubic(0.5), 0.5)
  assert.equal(easeOutCubic(0), 0); assert.equal(easeOutCubic(1), 1)
  assert.ok(easeOutCubic(0.25) > easeInOutCubic(0.25), 'easeOut 起步比 easeInOut 猛（这正是要避开它的原因）')

  // ③ 规格语义：`{to}` = 混合、`{add}` = 叠加；两者都随包络缩放
  const cur = { ParamAngleZ: 6, ParamBodyAngleZ: 2, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamEyeLSmile: 0, ParamEyeRSmile: 0 }
  const read = (id) => cur[id] ?? 0
  const atStart = resolvePokeParams(HEAD_PAT, 0, read)
  assert.deepEqual(atStart, {}, 't=0 时**什么都不写** —— 这是"有过渡"的关键（不能瞬间贴上去）')
  const atPeak = resolvePokeParams(HEAD_PAT, HEAD_PAT.riseMs + 10, read)
  assert.ok(Math.abs(atPeak.ParamEyeLOpen - 0.25) < 1e-6, '峰值：眼睑混合到 0.25')
  assert.ok(Math.abs(atPeak.ParamAngleZ - (6 - 16)) < 1e-6, '峰值：ParamAngleZ = 当前 + (-16)')
  assert.ok(Math.abs(atPeak.ParamBodyAngleZ - (2 - 7)) < 1e-6, '峰值：ParamBodyAngleZ = 当前 + (-7)')
  const atMid = resolvePokeParams(HEAD_PAT, (HEAD_PAT.riseMs + HEAD_PAT.holdMs + HEAD_PAT.totalMs) / 2, read)
  assert.ok(Math.abs(atMid.ParamAngleZ - 6) < Math.abs(atPeak.ParamAngleZ - 6), '回落中段应比峰值更接近原状')

  // ④ 幅度：-8° 被用户判为"太小"，这里锁住下限，防止又调回去
  assert.ok(HEAD_PAT.params.ParamAngleZ.add <= -12, `歪头幅度至少要 12°，实际 ${HEAD_PAT.params.ParamAngleZ.add}°`)

  // ⑤ 动作驱动的参数**必须用 `{add}`**：待机动作 Scene4（180s）每帧都在写它们，
  //    用 `{to}` 覆盖会把秋千的头部/身体摆动停掉 ✗
  for (const id of ['ParamAngleZ', 'ParamBodyAngleZ']) {
    assert.ok(HEAD_PAT.params[id] && 'add' in HEAD_PAT.params[id], `${id} 必须用 {add}（动作每帧在写它）`)
    assert.equal('to' in HEAD_PAT.params[id], false, `${id} 不能用 {to} 覆盖`)
  }
  // 眼睑则是**覆盖式混合**（眯眼本来就要接管眼睑）
  for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) {
    assert.ok('to' in HEAD_PAT.params[id], `${id} 应该是 {to} 混合`)
  }

  // ⑥ 接线：pet.js 走 patHead()；live2d.js 每帧在 applyBlink() **之后**应用
  const pet = readFileSync(new URL('../packages/pet-shell/renderer/pet.js', import.meta.url), 'utf8')
  const live2d = readFileSync(new URL('../packages/pet-shell/renderer/live2d.js', import.meta.url), 'utf8')
  assert.match(pet, /head: \(\) => live2d\?\.patHead\(\)/, 'pet.js 头顶走 patHead()')
  assert.match(live2d, /export function patHead\(\)/, 'live2d.js 要导出 patHead()')
  const blinkIdx = live2d.indexOf('applyBlink(performance.now())')
  const pokeIdx = live2d.indexOf('applyPokeParams()')
  assert.ok(blinkIdx >= 0 && pokeIdx >= 0, 'applyBlink / applyPokeParams 都要在 applyState 里')
  assert.ok(pokeIdx > blinkIdx, '参数覆盖必须排在眨眼接管**之后** —— 否则眨眼会把眯眼顶回去')
  // 到点后必须**停止写入**（让动作自然接管），而不是"贴一个新值回去"
  assert.match(live2d, /elapsed > pokeCfg\.totalMs/, 'live2d.js 要按 elapsed 判断结束')
  assert.equal(/pokeParamsTimer/.test(live2d), false, '不应该再用 setTimeout 硬撤（那样没有回落段）')
})

check('渲染端模块守卫：renderer/ 里的相对 import 必须落在 renderer/ 内且文件存在', () => {
  // ⚠️ 实机踩过（2026-10-05）：把 renderer/live2d.js 的 import 写成 '../hit-test.js'。
  //    `pet://app/` 协议**只服务 renderer/ 目录**（main.js 的 RENDERER_DIR），
  //    浏览器把 '../hit-test.js' 解析成 pet://app/hit-test.js → **404**
  //    → **整个 live2d.js 模块加载失败** → 静默降级成占位图。
  //    用户只看到"桌宠变成小熊了"，日志里才有一行 `Live2D 模块加载失败` ✗
  //    所以这里静态扫一遍：宁可在自测里红，也不要到实机上静默降级。
  const dir = new URL('../packages/pet-shell/renderer/', import.meta.url)
  const rootPath = decodeURIComponent(dir.pathname)
  const files = readdirSync(fileURLToPath(dir)).filter((f) => f.endsWith('.js'))
  assert.ok(files.length >= 4, `renderer/ 下应扫到多个模块，实际 ${files.length} 个`)

  const problems = []
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8')
    const specs = []
    // 静态 `import ... from 'x'` / `export ... from 'x'`
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
    // 动态 `import('x')`
    for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue // 裸模块名/绝对 URL：不归本条管
      const target = new URL(spec, new URL(f, dir))
      const rel = decodeURIComponent(target.pathname)
      if (!rel.startsWith(rootPath)) {
        problems.push(`${f} → '${spec}'：跑出了 renderer/（pet:// 只服务 renderer/，会 404 并静默降级）`)
      } else if (!existsSync(fileURLToPath(target))) {
        problems.push(`${f} → '${spec}'：文件不存在`)
      }
    }
  }
  assert.deepEqual(problems, [], `渲染端相对 import 有问题：\n  ${problems.join('\n  ')}`)
})

check('插件在线小点已从桌宠挪进操作面板 【用户："整合到菜单里面去"】', () => {
  // 用户 2026-10-05："把那个表示插件在线的小绿点整合到菜单里面去"。
  // 桌宠窗口只有 260×300、她本体占满，那个点只能压在她身上 ✗ → 挪到面板 ✓
  const read = (rel) => readFileSync(new URL(`../packages/pet-shell/${rel}`, import.meta.url), 'utf8')
  const petJs = read('renderer/pet.js')
  const petHtml = read('renderer/index.html')
  const petCss = read('renderer/pet.css')
  const menuHtml = read('renderer/menu.html')
  const menuJs = read('renderer/menu.js')
  const menuCss = read('renderer/menu.css')
  const preload = read('menu-preload.cjs')

  // ① 桌宠窗口里必须真的没了（元素 / 引用 / 样式三处都要干净 ——
  //    少改一处就会出现"元素没了但 JS 还在 dataset 上写"这类静默错误）
  assert.equal(/id="status"/.test(petHtml), false, 'index.html 不该再有 #status 元素')
  assert.equal(/getElementById\('status'\)/.test(petJs), false, 'pet.js 不该再引用 #status')
  assert.equal(/#status\s*\{/.test(petCss), false, 'pet.css 不该再有 #status 规则')

  // ② 面板里必须真的有了（HTML + CSS + JS + preload 四层齐）
  assert.ok(/id="linkState"/.test(menuHtml), 'menu.html 要有 #linkState')
  assert.ok(/#linkState/.test(menuCss), 'menu.css 要给它样式')
  assert.ok(/data-link="up"/.test(menuCss), '仍然用 data-link 表达在线（语义和原来一致）')
  assert.ok(/function renderLink/.test(menuJs), 'menu.js 要有 renderLink')
  assert.ok(/onLink/.test(preload), 'preload 要暴露 onLink')

  // ③ 首次打开就要显示正确状态，不能等下一次连接变化
  const mainJs = read('main.js')
  assert.ok(/link: lastLink,/.test(mainJs), 'menu:data 里要带 link（否则首开永远显示"未连接"）')
  assert.ok(/function pushMenuLink/.test(mainJs), '连接状态变化时要推给面板')
})

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

// ─────────────────────────────────────────────────────────────
console.log('\n[6] SSE 链路自愈（外壳 sse-link.js，真 HTTP 服务端）')

/** 起服务并拿到端口 */
function listenOnce(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
/** 轮询等待某个条件成立 */
function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (predicate()) return resolve(true)
      if (Date.now() > deadline) return reject(new Error('等待超时'))
      setTimeout(tick, stepMs)
    }
    tick()
  })
}
const sseHead = (res) => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })

await checkAsync('SSE 回归：服务端**非正常断开**时必须判定掉线 【小绿点常绿 + 永不重连的根因】', async () => {
  // ⚠️ 这条是本项目最隐蔽的一个坑：Node 客户端在连接被非正常断开时
  //    **不发** `res.on('end')`、也**不发** `req.on('error')`。
  //    实测事件序列：res.data → res.aborted → req.close → res.error:ECONNRESET → res.close。
  //    老实现只监听 end/req.error ⇒ 断线后：小绿点常绿、永不重连、状态冻结（"没有思考动作"）。
  const server = http.createServer((req, res) => {
    sseHead(res)
    res.write(': ping\n\n')
    setTimeout(() => {
      try {
        res.socket.destroy()
      } catch {
        /* ignore */
      }
    }, 80)
  })
  const port = await listenOnce(server)
  const links = []
  const link = createSseLink({
    url: `http://127.0.0.1:${port}/events`,
    onLink: (l) => links.push(l),
    log: () => {},
  })
  try {
    await waitFor(() => links.some((l) => l.connected), 3000)
    await waitFor(() => links.some((l) => l.connected === false), 3000)
    assert.ok(
      links.some((l) => l.connected === false),
      '连接已经没了却没人通知 ⇒ 小绿点会一直"已连接"，状态也永远冻结',
    )
  } finally {
    link.close()
    server.close()
  }
})

await checkAsync('SSE 自愈：掉线后必须自动重连（不需要用户重启桌宠）', async () => {
  let conns = 0
  const server = http.createServer((req, res) => {
    conns += 1
    sseHead(res)
    res.write(': ping\n\n')
    if (conns === 1) {
      // 第一条故意掐断；之后的都保持
      setTimeout(() => {
        try {
          res.socket.destroy()
        } catch {
          /* ignore */
        }
      }, 60)
    }
  })
  const port = await listenOnce(server)
  const links = []
  const link = createSseLink({
    url: `http://127.0.0.1:${port}/events`,
    onLink: (l) => links.push(l),
    log: () => {},
  })
  try {
    await waitFor(() => links.filter((l) => l.connected).length >= 2, 6000)
    assert.ok(links.filter((l) => l.connected).length >= 2, `掉线后应自动重连，实际只有 ${links.filter((l) => l.connected).length} 次连接`)
    assert.equal(link.connected, true, '重连后应处于已连接')
  } finally {
    link.close()
    server.close()
  }
})

await checkAsync('SSE 看门狗：**心跳静默**超阈值也要判定掉线（半开连接唯一能抓住的手段）', async () => {
  // 服务端接受连接、发一次 ping，然后**永远沉默**（模拟半开：socket 不断但没数据）
  const server = http.createServer((req, res) => {
    sseHead(res)
    res.write(': ping\n\n')
  })
  const port = await listenOnce(server)
  const links = []
  const link = createSseLink({
    url: `http://127.0.0.1:${port}/events`,
    silenceMs: 250, // 自测里把阈值调小，免得等 45s
    watchIntervalMs: 40,
    onLink: (l) => links.push(l),
    log: () => {},
  })
  try {
    await waitFor(() => links.some((l) => l.connected), 2000)
    await waitFor(() => links.some((l) => l.connected === false), 3000)
    assert.ok(links.some((l) => l.connected === false), '静默超过阈值必须判定掉线')
  } finally {
    link.close()
    server.close()
  }
})

await checkAsync('SSE 帧解析：`data:` 帧照常送达，`: ping` 注释行不能干扰', async () => {
  const server = http.createServer((req, res) => {
    sseHead(res)
    res.write(': ping\n\n')
    res.write('data: {"type":"state","state":"running"}\n\n')
    res.write(': ping\n\n')
    res.write('data: {"type":"notice","text":"hi"}\n\n')
  })
  const port = await listenOnce(server)
  const frames = []
  const link = createSseLink({
    url: `http://127.0.0.1:${port}/events`,
    onFrame: (f) => frames.push(f),
    onLink: () => {},
    log: () => {},
  })
  try {
    await waitFor(() => frames.length >= 2, 3000)
    assert.deepEqual(
      frames.map((f) => f.type),
      ['state', 'notice'],
      `注释/心跳行不该被当成帧：${JSON.stringify(frames)}`,
    )
    assert.equal(frames[0].state, 'running')
  } finally {
    link.close()
    server.close()
  }
})

await checkAsync('SSE 连不上时不能谎报"已连接"', async () => {
  const links = []
  // 端口 1 必然连不上
  const link = createSseLink({
    url: 'http://127.0.0.1:1/events',
    onLink: (l) => links.push(l),
    log: () => {},
  })
  try {
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(!links.some((l) => l.connected), '连不上却报了 connected:true')
  } finally {
    link.close()
  }
})

// ─────────────────────────────────────────────────────────────
console.log('\n[7] 一键安装与打包（纯逻辑）')

/**
 * 自测用的 CRC32 —— **故意不复用被测代码里的实现**，否则等于让代码自己证明自己。
 * 独立写一遍才能验出"写 zip 时 CRC 填错"这类问题。
 */
function zipCrc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/** 一份贴近真实的 profile patch 样本（含注释 + 其他插件行） */
const SAMPLE_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard

- insert:
    - id: some-other-plugin
      name: '@local/other'
`

check('patch 改写：幂等（连加两次只多一段）', () => {
  const once = addPluginRow(SAMPLE_PATCH, { pluginEntry: 'C:/x/packages/pet-plugin/index.js', config: { pathPrefix: '/xilian-pet' } })
  assert.equal(once.changed, true, '第一次应当有改动')
  const twice = addPluginRow(once.text, { pluginEntry: 'C:/x/packages/pet-plugin/index.js' })
  assert.equal(twice.changed, false, '第二次不该再追加')
  assert.equal(twice.text, once.text, '第二次应原样返回')
  assert.equal(once.text.split('id: xilian-pet').length - 1, 1, 'xilian-pet 行只应出现一次')
})

check('patch 改写：不破坏原有内容，缩进符合 Loader 方言', () => {
  const { text } = addPluginRow(SAMPLE_PATCH, { pluginEntry: 'C:/x/p/index.js', config: { pathPrefix: '/xilian-pet', captureRawShapes: 20 } })
  assert.ok(text.startsWith(SAMPLE_PATCH), '原有内容必须原样保留在开头')
  assert.match(
    text,
    /\n- insert:\n {4}- id: xilian-pet\n {6}name: 'C:\/x\/p\/index\.js'\n {6}config:\n {8}pathPrefix: '\/xilian-pet'\n {8}captureRawShapes: 20\n$/,
    `产出的 YAML 形状不对：\n${text.slice(-260)}`,
  )
})

check('patch 改写：末尾没有换行时也要正确分隔', () => {
  const noNewline = SAMPLE_PATCH.trimEnd()
  const { text } = addPluginRow(noNewline, { pluginEntry: 'C:/p/index.js' })
  assert.ok(text.includes('\n\n- insert:'), '缺少空行分隔会让 YAML 黏在一起')
  assert.ok(text.startsWith(noNewline), '原有内容仍要完整保留')
})

check('patch 改写：缺 pluginEntry 要大声报错（而不是写出半截 YAML）', () => {
  assert.throws(() => pluginRowSnippet({}), /pluginEntry/)
  assert.throws(() => pluginRowSnippet({ pluginEntry: '' }), /pluginEntry/)
})

check('patch 识别：能认出 patch，不把无关文本当 patch', () => {
  assert.equal(looksLikeProfilePatch(SAMPLE_PATCH), true)
  assert.equal(looksLikeProfilePatch('- id: a\n'), true)
  assert.equal(looksLikeProfilePatch('hello world'), false)
  assert.equal(looksLikeProfilePatch(''), false)
})

check('拖拽看门狗：只在"超时未续期"时复位', () => {
  const base = { draggingNow: true, lastAt: 1000, now: 3000, staleMs: 6000 }
  assert.equal(draggingExpired(base), false, '未超时不该复位')
  assert.equal(draggingExpired({ ...base, now: 7000 }), false, '正好等于阈值不该复位（用 > 判）')
  assert.equal(draggingExpired({ ...base, now: 7001 }), true, '超过阈值必须复位')
  assert.equal(draggingExpired({ ...base, draggingNow: false }), false, '不在拖拽态就无事发生')
  assert.equal(draggingExpired({ ...base, lastAt: 0 }), false, '没记到时间戳时别误伤刚按下的拖拽')
  assert.equal(draggingExpired({ ...base, lastAt: NaN }), false)
  assert.equal(draggingExpired({ ...base, now: NaN }), false)
})

check('拖拽看门狗：阈值必须远大于渲染端的续期间隔（否则正常拖拽会被误复位）', () => {
  const mainSrc = readFileSync(new URL('../packages/pet-shell/main.js', import.meta.url), 'utf8')
  const petSrc = readFileSync(new URL('../packages/pet-shell/renderer/pet.js', import.meta.url), 'utf8')
  const stale = Number(mainSrc.match(/const DRAG_STALE_MS = (\d+)/)?.[1])
  const renew = Number(petSrc.match(/setInterval\(\(\) => \{[\s\S]*?\}, (\d+)\)/)?.[1])
  assert.ok(Number.isFinite(stale), 'main.js 里应有 DRAG_STALE_MS')
  assert.ok(Number.isFinite(renew), 'pet.js 里应能找到续期间隔（setInterval 的第二个参数）')
  assert.ok(stale >= renew * 2, `看门狗阈值(${stale}ms)至少要是续期间隔(${renew}ms)的 2 倍`)
})

check('发行包清单：vendor 必须收（它是 gitignore 掉但发行必需的）', () => {
  for (const rel of ['packages/pet-shell/renderer/vendor/pixi.min.js', 'packages/pet-shell/renderer/vendor/live2dcubismcore.min.js']) {
    assert.equal(shouldInclude(rel, {}), true, `${rel} 必须进包，否则朋友要跑 pnpm`)
  }
})

check('发行包清单：开发产物与机器相关内容一律不收', () => {
  const excluded = [
    '.git/config',
    'node_modules/electron/package.json',
    'packages/pet-shell/.state/pet.log',
    '.audit/report.md',
    '.cache/electron/x.zip',
    '.pnpm-store/x',
    'dist/x.7z',
    'chajian/环境体检报告.md',
    'docs/screenshots/peak-0.png',
  ]
  for (const rel of excluded) {
    assert.equal(shouldInclude(rel, {}), false, `${rel} 不该进包`)
  }
})

check('发行包清单：第三方素材与模型按开关收', () => {
  for (const rel of ['3597924035_Cyrene昔涟前瞻小人桌宠.wpk', 'Cyrene.zip', 'packages/x.bak']) {
    assert.equal(shouldInclude(rel, { withModel: true }), false, `${rel} 永远不该进包`)
  }
  assert.equal(shouldInclude('assets/live2d/Cyrene/Cyrene.moc3', {}), false)
  assert.equal(shouldInclude('assets/live2d/Cyrene/Cyrene.moc3', { withModel: true }), true)
  assert.equal(shouldInclude('node_modules/electron/dist/electron.exe', {}), false)
  assert.equal(shouldInclude('node_modules/electron/dist/electron.exe', { withElectron: true }), true)
  assert.equal(shouldInclude('node_modules/pixi.js/dist/pixi.min.js', { withElectron: true }), false, '--with-electron 不该把整个 node_modules 放进来')
})

check('发行包必需清单：列出的文件**真的都在仓库里**', () => {
  for (const rel of requiredInRelease({ withModel: true })) {
    assert.ok(existsSync(new URL(`../${rel}`, import.meta.url)), `发行包必需文件缺失：${rel}`)
  }
})

check('发行包遍历：`--with-electron` 必须真的**进得去** node_modules', () => {
  // ⚠️ 这条正是补上一个真 bug 的：只测 shouldInclude 是**不够的** ——
  //    遍历时用「合成子路径」判断要不要进目录，`node_modules` 会在那一层被剪掉，
  //    于是 --with-electron 静默失效（完整版打出来和精简版一样大：88 文件 / 1.71 MB）。
  assert.equal(shouldDescend('node_modules', { withElectron: true }), true, '开了 --with-electron 就必须进 node_modules')
  assert.equal(shouldDescend('node_modules', {}), false, '没开就别进（那里有 40 万个文件）')
  assert.equal(shouldDescend('node_modules/electron', { withElectron: true }), true)
  assert.equal(shouldDescend('node_modules/pixi.js', { withElectron: true }), false, '只放 electron，别把整个 node_modules 装进去')
  assert.equal(shouldDescend('node_modules/electron/dist', { withElectron: true }), true)
  // 模型同理：目录层也要放行
  assert.equal(shouldDescend('assets/live2d', { withModel: true }), true)
  assert.equal(shouldDescend('assets/live2d', {}), false, '没开 --with-model 就别进（第三方素材）')
  // vendor 永远要进
  assert.equal(shouldDescend('packages/pet-shell/renderer/vendor', {}), true)
  // 常规排除仍然生效
  for (const dir of ['.git', '.audit', '.cache', '.state', 'dist', 'chajian', 'docs/screenshots']) {
    assert.equal(shouldDescend(dir, { withModel: true, withElectron: true }), false, `${dir} 不该进`)
  }
})

check('发行包遍历：对**真实仓库**跑一遍，开关行为要符合预期', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const slim = collectReleaseFiles(root, {})
  const withModel = collectReleaseFiles(root, { withModel: true })
  const withElectron = collectReleaseFiles(root, { withElectron: true })

  // 基线：必需文件在
  for (const rel of requiredInRelease({})) {
    assert.ok(slim.includes(rel), `精简版少了 ${rel}`)
  }
  // 开关确实改变内容
  assert.ok(!slim.some((r) => r.startsWith('assets/live2d/')), '精简版不该含模型')
  assert.ok(withModel.some((r) => r.startsWith('assets/live2d/')), '--with-model 应含模型')
  assert.ok(
    withElectron.includes('node_modules/electron/dist/electron.exe') ||
      withElectron.some((r) => r.startsWith('node_modules/electron/')),
    '--with-electron 必须真的收进 Electron（这条会抓住"遍历层剪枝"那个 bug）',
  )
  // 而且不能顺手把整个 node_modules 装进去
  assert.ok(
    !withElectron.some((r) => r.startsWith('node_modules/') && !r.startsWith('node_modules/electron/')),
    '--with-electron 不该收 node_modules 下 electron 以外的东西',
  )
  // 精简版绝不含任何 node_modules
  assert.ok(!slim.some((r) => r.startsWith('node_modules/')), '精简版不该含 node_modules')
})

check('zip 写入器：条目名必须是正斜杠 + UTF-8 标志（Windows 那两个 API 会写成反斜杠）', () => {
  // ⚠️ 这条是踩出来的：`Compress-Archive` 与 `ZipFile.CreateFromDirectory` 在 Windows 上
  //    把条目名写成 `xilian-pet\安装.cmd`（反斜杠）。ZIP 规范要求 `/`，
  //    7-Zip / macOS / WSL 可能因此解出一个叫 `xilian-pet\安装.cmd` 的怪文件。
  const zip = writeZipToBuffer([
    { name: 'pkg/安装.cmd', data: Buffer.from('@echo off\n', 'utf8') },
    { name: 'pkg/sub/a.txt', data: Buffer.from('hello', 'utf8') },
  ])
  // 按**字节**找：zip 里是二进制，用 toString 解码再 includes 会自己坑自己（踩过）
  assert.ok(zip.includes(Buffer.from('pkg/安装.cmd', 'utf8')), '中文名条目要按 UTF-8 写进 zip')
  assert.ok(!zip.includes(Buffer.from('pkg\\安装.cmd', 'utf8')), '绝不能用反斜杠分隔')
  assert.ok(zip.includes(Buffer.from('pkg/sub/a.txt', 'utf8')), '子目录也要正斜杠')
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800, '通用标志位要置 UTF-8 位（bit 11）')

  // 用一个**独立写的小解析器**把内容解回来（不假设条目顺序：写入器会先写目录条目）
  const entries = []
  let pos = 0
  while (pos + 30 <= zip.length && zip.readUInt32LE(pos) === 0x04034b50) {
    const method = zip.readUInt16LE(pos + 8)
    const crc = zip.readUInt32LE(pos + 14)
    const compSize = zip.readUInt32LE(pos + 18)
    const rawSize = zip.readUInt32LE(pos + 22)
    const nameLen = zip.readUInt16LE(pos + 26)
    const extraLen = zip.readUInt16LE(pos + 28)
    const name = zip.toString('utf8', pos + 30, pos + 30 + nameLen)
    const dataStart = pos + 30 + nameLen + extraLen
    entries.push({ name, method, crc, rawSize, body: zip.subarray(dataStart, dataStart + compSize) })
    pos = dataStart + compSize
  }
  const target = entries.find((e) => e.name === 'pkg/安装.cmd')
  assert.ok(target, `应能按名字找到条目；实际有：${entries.map((e) => e.name).join(', ')}`)
  const raw = target.method === 8 ? inflateRawSync(target.body) : target.body
  assert.equal(raw.toString('utf8'), '@echo off\n', '内容要能解回来')
  assert.equal(raw.length, target.rawSize, '未压缩长度要对得上')
  assert.equal(target.crc, zipCrc32(raw), 'CRC32 要对得上')
})

check('zip 写入器：目录条目齐全（不依赖解压工具隐式建目录）', () => {
  const zip = writeZipToBuffer([{ name: 'pkg/a/b/c.txt', data: Buffer.from('x') }])
  for (const dir of ['pkg/', 'pkg/a/', 'pkg/a/b/']) {
    assert.ok(zip.includes(Buffer.from(dir, 'utf8')), `缺少目录条目 ${dir}`)
  }
})

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * 仓库根的**全部** `.cmd` —— 自动发现，不硬编码清单。
 * 为什么：实测教育过一次 —— 当初只给 `安装.cmd` 加了"找包内便携 Node"的检查，
 * 忘了 `start-pet.cmd`，于是在"什么都没有"的机器上装完**启动不起来**。
 * 自动发现之后，将来新增的 `.cmd` 会被下面几条护栏自动覆盖。
 */
const rootCmdFiles = readdirSync(repoRoot)
  .filter((name) => name.toLowerCase().endsWith('.cmd'))
  .sort()

/** 所有 .cmd（含 tools/ 下的共享脚本）—— 纯 ASCII / 注释里不能有 `>` 这两条要全覆盖 */
const cmdFilesForSafety = [...rootCmdFiles, 'tools/find-node.cmd']

check('`.cmd` 护栏覆盖仓库根的全部脚本（自动发现，不是硬编码清单）', () => {
  for (const rel of ['安装.cmd', 'start-pet.cmd', '检查更新.cmd']) {
    assert.ok(rootCmdFiles.includes(rel), `没发现 ${rel} —— 自动发现坏了，下面几条护栏会静默跳过它`)
  }
  assert.ok(rootCmdFiles.length >= 3, `只发现 ${rootCmdFiles.length} 个 .cmd，像是发现逻辑坏了`)
})

check('`.cmd` 必须纯 ASCII —— 注释也算（cmd.exe 按 GBK 解析，中文会变成乱码"命令"）', () => {
  // ⚠️ 这条是踩出来的：我在安装脚本里写了中文注释，cmd 把 UTF-8 字节按 GBK 解析，
  //    结果屏幕上冒出 `'串（实测踩过：屏幕打出' is not recognized as an internal
  //    or external command` 这种鬼东西 —— 而脚本本身还"看起来"能跑。
  for (const rel of cmdFilesForSafety) {
    const bytes = readFileSync(new URL(`../${rel}`, import.meta.url))
    const bad = []
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] > 0x7f) bad.push(`${i}:0x${bytes[i].toString(16)}`)
      if (bad.length >= 5) break
    }
    assert.equal(bad.length, 0, `${rel} 含非 ASCII 字节（${bad.join(', ')}）—— 注释也要写英文`)
  }
})

check('发行包清单：安装脚本的日志不该跟着发行包走', () => {
  // 这两个文件是 setup.mjs / 安装.cmd 每次运行时重写的，进了包会让下一批测试者
  // 看到上一批人的日志（也白涨体积）
  for (const rel of ['setup-log.txt', 'install-log.txt']) {
    assert.equal(shouldInclude(rel, { withModel: true }), false, `${rel} 不该进包`)
  }
})

check('发行包：便携 Node 的源在 .cache、包内名字必须是 node/（两者不能混）', () => {
  // 为什么单独一条：node.exe 的来源（.cache，不进 git）和它在包内的位置（node/，
  // 安装脚本按 "%~dp0node\node.exe" 找它）**故意不同** —— 这条约定错了，
  // 朋友会拿到一个"包里明明有 node.exe 但脚本找不到"的版本。
  const files = nodeRuntimeFiles('/repo')
  assert.deepEqual(
    files.map((f) => f.name),
    ['node/node.exe', 'node/LICENSE'],
    '包内路径必须是 node/xxx',
  )
  for (const f of files) {
    assert.ok(f.src.includes('.cache'), `${f.name} 的源应在 .cache 里（不该进 git、也不该被遍历收进包）`)
  }
  assert.ok(requiredInRelease({ withNode: true }).includes('node/node.exe'), 'withNode 时必需清单要含 node/node.exe')
  assert.ok(!requiredInRelease({}).includes('node/node.exe'), '不开 --with-node 时不该要求它')
})

check('Node 探测**只有一处实现**，三个入口都 call 它（以前三份拷贝，已经漏过一次）', () => {
  // 历史教训：以前 安装.cmd / start-pet.cmd 各抄了一份探测逻辑，
  // 给一个加了"找包内 Node"、忘了另一个 → 在"什么都没有"的机器上装完**启动不起来**。
  for (const rel of rootCmdFiles) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    assert.ok(
      src.includes('call "%~dp0tools\\find-node.cmd"'),
      `${rel} 必须 call 共享的 tools/find-node.cmd`,
    )
    // 目录扫描（for /d）属于探测逻辑，只准出现在 find-node.cmd 里
    assert.ok(
      !/for \/d %%D in/.test(src),
      `${rel} 里还有内联的目录扫描 —— 探测逻辑必须集中在 tools/find-node.cmd`,
    )
  }
  const finder = readFileSync(new URL('../tools/find-node.cmd', import.meta.url), 'utf8')
  for (const [needle, why] of [
    ['node\\node.exe', '包内便携 Node（零前置版的关键）'],
    ['dsh-runtimes', 'DSH home 下解包的运行时'],
    ['InstallLocation', 'DSH 安装目录 —— 2026-10-06 实测：机器上 DSH 装着且在跑，但 home 里没有运行时，Node 在安装目录'],
    ['$PATH:N', 'PATH 兜底'],
  ]) {
    assert.ok(finder.includes(needle), `find-node.cmd 缺少 ${needle}（${why}）`)
  }
  // 靠 set 把 PET_NODE 交给调用方 —— 一旦 setlocal，变量就传不回去了
  assert.ok(!/^\s*setlocal/mi.test(finder), 'find-node.cmd 不能 setlocal，否则 PET_NODE 传不回调用方')
})

check('`.cmd` 的注释里不能出现 `>`（cmd 会先做重定向，凭空造出文件）', () => {
  // ⚠️ 实测：`rem    -> keeps the launcher working...` 在运行后于**当前目录**
  //    留下一个名为 `keeps` 的空文件 —— 因为重定向在 rem 执行之前就被处理了。
  //    写 `rem a -> b` 这种箭头注释非常自然，所以必须用测试挡住。
  //    （写这条护栏时我自己就在 find-node.cmd 的注释里写了 `<install>` 被抓过一次。）
  for (const rel of cmdFilesForSafety) {
    const lines = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (/^\s*rem\b/i.test(line)) {
        assert.ok(!line.includes('>'), `${rel}:${index + 1} 注释里有 ">"，会造出文件：${line.trim()}`)
      }
    })
  }
})

check('`.cmd` 的 echo 行里括号必须转义成 ^( ^)（在 if 块里裸括号会截断语句）', () => {
  // ⚠️ 同一个会话里踩到的第三个 .cmd 解析坑：我在 `if not defined PET_TEE (` 块里写了
  //    `echo ... (in this folder) ...` —— 那个 `)` 被当成块的结束符，后面整段崩掉，
  //    报的是 `and was unexpected at this time.`
  //    括号在 echo 里是常见内容，所以必须挡住：允许 `^(` `^)`，裸的一律拦。
  for (const rel of cmdFilesForSafety) {
    const lines = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (!/^\s*echo\b/i.test(line)) return
      const withoutEscaped = line.replace(/\^\(/g, '').replace(/\^\)/g, '')
      assert.ok(
        !/[()]/.test(withoutEscaped),
        `${rel}:${index + 1} 的 echo 里有未转义的括号（要写 ^( ^) ）：${line.trim()}`,
      )
    })
  }
})

check('在压缩包里直接双击运行 → 必须被识别出来，并用人话说明怎么修', () => {
  // 实机踩到（2026-10-06）：朋友在 zip 的浏览视图里直接双击 start-pet.cmd，
  // Windows 只把那一个文件解到 %TEMP%\GUID_name.zip.HEX\ 再运行，于是：
  //   Error: Cannot find module '...\Temp\...zip.8ff\xilian-pet\packages\...\launch.mjs'
  // 这是公开分发时**最可能大量发生**的用户错误，必须给一句人话而不是 Node 堆栈。
  const finder = readFileSync(new URL('../tools/find-node.cmd', import.meta.url), 'utf8')
  assert.match(finder, /PET_ZIP_RUN/, 'find-node.cmd 要检测"在压缩包里运行"')
  assert.ok(finder.includes('/c:".zip"'), '检测依据之一是路径里带 .zip')
  assert.ok(
    finder.includes('/c:"\\Temp"'),
    '还必须同时命中 \\Temp（注意**不能**带尾部反斜杠 —— 它会把引号转义掉）',
  )
  for (const rel of rootCmdFiles) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    assert.ok(src.includes('PET_ZIP_RUN'), `${rel} 必须在 call 之后检查 PET_ZIP_RUN 并中止`)
  }
  // 中文提示靠 base64 承载（.cmd 必须纯 ASCII）—— 顺手解回来确认它没被写坏
  const encoded = /Buffer\.from\('([A-Za-z0-9+/=]{40,})','base64'\)/.exec(finder)?.[1]
  assert.ok(encoded, '应能从 find-node.cmd 里取出那段 base64 提示')
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  assert.match(decoded, /压缩包/, '中文提示要提到"压缩包"')
  assert.match(decoded, /解压缩/, '要告诉用户去"全部解压缩"')
})

check('拖拽链路：移动要续期 + 复位要通知渲染端 + 失焦复位必须有条件', () => {
  // ⚠️ 这三条都是用户实机报出来的（"一开始能拖，后面突然拖不动了"）。
  //    链条：失焦或定时器断档 → 看门狗复位 draggingNow → 主进程恢复"按掩码判穿透"
  //    → 窗口不再收鼠标事件 → 拖拽**静默死掉**；而渲染端还停在 dragging=true。
  //    只测 `draggingExpired` 是抓不到这些的（那是纯函数层，bug 在接线层）。
  const mainSrc = readFileSync(new URL('../packages/pet-shell/main.js', import.meta.url), 'utf8')
  const preSrc = readFileSync(new URL('../packages/pet-shell/preload.cjs', import.meta.url), 'utf8')
  const petSrc = readFileSync(new URL('../packages/pet-shell/renderer/pet.js', import.meta.url), 'utf8')

  const moveBlock = mainSrc.match(/ipcMain\.on\('pet:move-by'[\s\S]*?\n {2}\}\)/)
  assert.ok(moveBlock, '应能定位 pet:move-by 处理器')
  assert.match(moveBlock[0], /renewDrag\(\)/, 'pet:move-by 里必须续期，否则拖拽只能靠 2s 定时器续命')

  const blurBlock = mainSrc.match(/win\.on\('blur'[\s\S]*?\n {2}\}\)/)
  assert.ok(blurBlock, '应能定位 blur 处理器')
  assert.match(blurBlock[0], /DRAG_BLUR_GRACE_MS/, '失焦复位必须先确认"确实没人续期"，不能无条件复位')

  assert.ok(mainSrc.includes("send('pet:drag-cancel'"), 'main.js 复位时要发 pet:drag-cancel')
  // ⚠️ 名字必须完全一致：渲染端调的是 `api.onDragCancel?.(…)`，
  //    可选链会让"preload 没暴露 / 名字写错"**静默失效** —— 修了等于没修。
  assert.match(preSrc, /onDragCancel\s*:/, 'preload 必须以 onDragCancel 这个名字暴露（渲染端就是这么调的）')
  assert.ok(petSrc.includes('onDragCancel'), '渲染端要订阅 onDragCancel 并清零 dragging')

  const stale = Number(mainSrc.match(/const DRAG_STALE_MS = (\d+)/)?.[1])
  assert.ok(stale >= 12000, `看门狗阈值 ${stale}ms 太小：定时器一被拖慢就会在拖拽进行中误杀`)
})

check('启动器不能默认加 `--disable-gpu`（会把掩码回读压到软件路径）', () => {
  // ⚠️ 用户实机报"只有一部分可以拖动，多次拖动之后完全不能拖动"。
  //    根因链：沙箱探测失败 → 自动追加 `--disable-gpu` → 渲染走 SwiftShader 软件路径
  //    → 渲染端回读 WebGL 画布 alpha（掩码的唯一来源）残缺 → 只有一部分身体算"命中"。
  //    探测通过与否只跟 `--no-sandbox` 有关，GPU 起不来 Chromium 自己会优雅退让。
  const src = readFileSync(new URL('../packages/pet-shell/scripts/launch.mjs', import.meta.url), 'utf8')

  const probeElse = src.match(/\} else \{\s*relaxFlags\.push\(([^)]*)\)/)
  assert.ok(probeElse, '应能定位"探测失败 → 放宽参数"的分支')
  assert.ok(!probeElse[1].includes('disable-gpu'), '探测失败的分支里不能加 --disable-gpu')

  const forced = src.match(/PET_FORCE_NO_SANDBOX === '1'[\s\S]{0,120}?relaxFlags\.push\(([^)]*)\)/)
  assert.ok(forced, '应能定位 PET_FORCE_NO_SANDBOX 分支')
  assert.ok(!forced[1].includes('disable-gpu'), 'PET_FORCE_NO_SANDBOX 分支里也不能加 --disable-gpu')

  const guard = src.indexOf("PET_DISABLE_GPU === '1'")
  const push = src.indexOf("push('--disable-gpu')")
  assert.ok(guard > 0 && push > guard, '--disable-gpu 只允许在 PET_DISABLE_GPU 显式开启时才加')
})

check('渲染端不能对 resize 无脑重排（分数 DPI 下会变成抖动循环）', () => {
  // ⚠️ 用户实机报"只有一部分可以拖动，多次拖动之后完全不能拖动"，
  //    而本机正常。对照两份 pet.log 找到差异：
  //      本机  DPR 2.0（窗口 260×300 → canvas 520×600，整数换算）→ 构图日志 2 行
  //      朋友  DPR 1.5（窗口 261×301 → canvas 390×450，261×1.5=391.5 取整）→ 66 秒刷了 2000+ 行
  //    分数 DPI 下 canvas↔CSS 往返有损，resize 反复送来"尺寸没实质变化"的通知，
  //    每次重排又打一行日志（一行 = 一次 IPC + 一次写盘）→ 渲染端被占满
  //    → 掩码回读和鼠标处理被饿死 → "只有一部分能拖、最后完全拖不动"。
  const src = readFileSync(new URL('../packages/pet-shell/renderer/live2d.js', import.meta.url), 'utf8')

  const block = src.match(/window\.addEventListener\('resize'[\s\S]*?\n {4}\}\)/)
  assert.ok(block, '应能定位 resize 处理器')
  // ⚠️ 必须断言**守卫语句本身**，不能只断言变量名存在 ——
  //    只删掉 `return` 而保留赋值时，弱断言照样通过（第一次写这条测试就漏了，变异测试抓出来的）。
  assert.match(block[0], /if\s*\(size === lastResize\)\s*return/, 'resize 必须先判断尺寸是否实质变化再动手')
  assert.match(block[0], /if\s*\(now - lastLayoutAt < \d+\)\s*return/, 'resize 必须限流，不能每帧重排')
  assert.match(src, /layoutStamp === lastLayoutStamp/, '构图日志必须按参数指纹去重')
  assert.match(src, /suppressedLayouts/, '必须统计并汇报被静音掉的重复次数')
})

check('命中映射必须用渲染端坐标系（renderer stage），不能用窗口 bounds', () => {
  // ⚠️ 用户实机（150% 缩放）：窗口被系统撑到 1077×946 / 1248×1124，而渲染端舞台
  //    一直是 260×300、掩码 130×150。[命中] 日志原文：
  //      光标(1490,672) 窗口(639,-112 1248×1124) 局部(851,784) 掩码(88,104) alpha=255 → 可交互
  //    用 win.getBounds() 映射 = 把 130×150 的掩码**拉伸铺满整个大窗口**
  //    → 用户报的"远离昔涟反而能拖、在她身上拖不动"。
  const mainSrc = readFileSync(new URL('../packages/pet-shell/main.js', import.meta.url), 'utf8')
  const preSrc = readFileSync(new URL('../packages/pet-shell/preload.cjs', import.meta.url), 'utf8')
  const petSrc = readFileSync(new URL('../packages/pet-shell/renderer/pet.js', import.meta.url), 'utf8')

  assert.match(preSrc, /sendMask:\s*\([^)]*\bstage\b[^)]*\)/, 'preload 的 sendMask 必须接收 stage 参数')
  // ⚠️ 基准是**画布的 CSS 尺寸**，不是 window.innerWidth：
  //    实测窗口被系统撑到 820×804 时连 innerWidth 都跟着胀，而画布始终 260×300。
  //    用 innerWidth 映射算出来 117÷820×130=18，用画布尺寸才是 58（正确答案）。
  //    （断言用 includes 而非正则：`visibleUiRects()` 里的括号会把 `[^)]*` 截断 ✗）
  assert.ok(petSrc.includes('w: mapCssW'), '渲染端必须送画布 CSS 尺寸 mapCssW')
  assert.ok(
    !/sendMask\([\s\S]{0,120}?window\.innerWidth/.test(petSrc),
    'sendMask 不能用 window.innerWidth（窗口被撑大时会错位）',
  )
  assert.match(
    readFileSync(new URL('../packages/pet-shell/renderer/live2d.js', import.meta.url), 'utf8'),
    /cssWidth:\s*c\.clientWidth/,
    'readAlpha 必须一并返回画布的 CSS 尺寸',
  )
  assert.match(mainSrc, /let maskStage = /, '主进程要保存渲染端送来的基准尺寸')
  assert.match(mainSrc, /winWidth: stageW/, 'hitTest 必须用送来的基准宽，不能用 b.width')
  assert.match(mainSrc, /winHeight: stageH/, 'hitTest 必须用送来的基准高，不能用 b.height')
  assert.ok(mainSrc.includes('≠ 渲染端舞台'), '两者不一致时要记一行（这就是"窗口被撑大"的证据）')
})

check('patch 移除：只删我们那一段，别的插件块一根头发都不能动', () => {
  // ⚠️ 这是"切到官方安装路径"时的关键操作：手写行不删 → 插件被加载两次
  //    （两个实例、两套 SSE、端口打架）。删错则会把别人的插件弄没。
  const src = SAMPLE_PATCH + pluginRowSnippet({ pluginEntry: 'C:/x/packages/pet-plugin/index.js', config: { pathPrefix: '/xilian-pet' } })
  const res = removePluginRow(src)
  assert.equal(res.changed, true, '应当移除')
  assert.equal(res.removed, 1, '只应移除一段')
  assert.ok(!res.text.includes('xilian-pet'), '我们的行要删干净')
  assert.ok(res.text.includes('some-other-plugin'), '别人的 - insert 块必须原样保留')
  assert.ok(res.text.includes('ui-chat'), '普通插件行也要保留')
  assert.equal(res.text, SAMPLE_PATCH.trimEnd() + '\n', '除我们那段外应逐字节不变')
})

check('patch 移除：幂等 + 没有我们的行时不动它', () => {
  const none = removePluginRow(SAMPLE_PATCH)
  assert.equal(none.changed, false, '没有我们的行就不该改')
  assert.equal(none.text, SAMPLE_PATCH, '文本必须原样返回')
  const once = removePluginRow(SAMPLE_PATCH + pluginRowSnippet({ pluginEntry: 'C:/p/index.js' }))
  const twice = removePluginRow(once.text)
  assert.equal(twice.changed, false, '第二次不该再有改动')
  assert.equal(twice.text, once.text)
})

check('patch 改写 ↔ 移除：往返回到原文（这是"可安全切换"的前提）', () => {
  const added = addPluginRow(SAMPLE_PATCH, { pluginEntry: 'C:/p/index.js', config: { pathPrefix: '/xilian-pet' } })
  const back = removePluginRow(added.text)
  assert.equal(back.text, SAMPLE_PATCH.trimEnd() + '\n', `往返后应回到原文，实际：\n${back.text}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[9] 挂载行：指向哪里、以及"官方安装留下的行"不能动')

check('读挂载行：能读出我们那一行指向哪；没有就返回 null', () => {
  const entry = 'C:\\p\\xilian-pet\\packages\\pet-plugin\\index.js'
  assert.equal(readPluginRowPath(SAMPLE_PATCH + pluginRowSnippet({ pluginEntry: entry })), entry)
  assert.equal(readPluginRowPath(SAMPLE_PATCH), null, '没有我们那一行必须返回 null')
  // 官方 bundle 安装留下的配置覆盖行（顶层 - id:，name 是包名）
  const official = "- id: xilian-pet\n  name: '@local/xilian-pet-plugin'\n  config:\n    approval:\n      viaPet: true\n"
  assert.equal(readPluginRowPath(official), '@local/xilian-pet-plugin')
})

check('区分「手写行（文件路径）」与「官方安装行（包名）」—— 后者绝不能按"路径变了"去改', () => {
  // ⚠️ 实测误报过一次：把官方安装那行当成陈旧手写行，会把官方安装的配置覆盖**改坏**。
  //    （setup.mjs --dry-run 当场报了"插件行指向别的目录"）
  assert.equal(looksLikePluginEntryPath('@local/xilian-pet-plugin'), false, '包名不是文件路径')
  assert.equal(looksLikePluginEntryPath('xilian-pet-plugin'), false)
  assert.equal(looksLikePluginEntryPath(null), false)
  assert.equal(looksLikePluginEntryPath('   '), false)
  for (const p of [
    'C:\\a\\index.js',
    'C:/a/index.js',
    'file:///C:/a/index.js',
    '\\\\server\\share\\index.js',
    '/usr/local/a.js',
  ]) {
    assert.equal(looksLikePluginEntryPath(p), true, `${p} 应被认作文件路径`)
  }
})

check('安装脚本：换文件夹之后要**改指向**，是官方安装就**别动**', () => {
  // 两个都是实机踩过的：
  //  · 只判"有没有那一行" → 用户换文件夹后那行还指旧路径 → 插件静默加载不到
  //  · 不区分包名与路径 → 会改坏官方 bundle 安装留下的配置覆盖
  const src = readFileSync(new URL('../tools/setup.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes('readPluginRowPath'), 'setup.mjs 要比对"那一行指向哪个目录"')
  assert.ok(src.includes('looksLikePluginEntryPath'), 'setup.mjs 要区分手写行与官方安装行')
  assert.match(src, /官方 bundle 安装/, '是官方安装时要给出说明，而不是静默跳过')
  assert.match(src, /插件行原本指着\*\*别的目录\*\*/, '换目录时要报出来它改指向了')
})

// ─────────────────────────────────────────────────────────────
console.log('\n[5] 官方 bundle 元数据（插件卡片 / install_bundle 契约）')

const pkgDir = new URL('../packages/pet-plugin/', import.meta.url)
const pkgJson = JSON.parse(readFileSync(new URL('package.json', pkgDir), 'utf8'))
const pkgFile = (rel) => new URL(rel, pkgDir)

check('bundle 声明：dsh.bundle.patch 指向真实存在的补丁文件', () => {
  // 官方定义："bundle = 声明了 dsh.bundle.patch 的包" —— 这是能走 install_bundle 的前提。
  assert.equal(pkgJson.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(pkgFile(pkgJson.dsh.bundle.patch)), '补丁文件必须真的在包里')
})

check('包名/可见性：合法 npm 名 + private（防误发布）', () => {
  assert.match(
    pkgJson.name,
    /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/,
    `包名不是合法 npm 名：${pkgJson.name}`,
  )
  // 官方 bundle 示例本身就是 "@local/xxx" + private —— 本地插件不该被误发到 registry。
  assert.equal(pkgJson.private, true, '本地插件必须 private')
  assert.match(pkgJson.version, /^\d+\.\d+\.\d+/, 'version 必须是 semver')
})

/**
 * 官方宿主认的图标媒体类型 —— 照抄 `app.asar` 里 `dsh-app-boot/lib/index.js`
 * 的 `package-meta.js`：`ICON_MEDIA_TYPES`。**别自己发明白名单**。
 */
const OFFICIAL_ICON_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

check('显示元数据：title / description / icon 齐全，且图标过官方那几道校验', () => {
  assert.ok(pkgJson.meta?.title, 'meta.title 缺失 → 插件卡片没有标题')
  assert.ok(pkgJson.meta?.description, 'meta.description 缺失 → 插件卡片没有描述')
  // 以下逐条复刻宿主的 iconOf()：它抛错 → 卡片的图标位置会退回默认图案（静默，很难发现）。
  const icon = pkgJson.icon
  assert.equal(typeof icon, 'string', 'icon 必须是字符串')
  assert.ok(icon.trim() !== '', 'icon 不能是空白字符串')
  assert.ok(
    !isAbsolute(icon) && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(icon),
    `icon 必须是相对文件路径（不能绝对路径 / 不能带 URL scheme）：${icon}`,
  )
  const mediaType = OFFICIAL_ICON_TYPES.get(extname(icon).toLowerCase())
  assert.ok(mediaType, `扩展名不在官方白名单（SVG / PNG / JPEG / WebP）内：${icon}`)
  // ⚠️ 官方是「先 realpath 再算相对」，所以软链指到目录外也算越界
  const base = realpathSync(fileURLToPath(pkgDir))
  const iconPath = realpathSync(resolve(base, icon))
  const local = relative(base, iconPath)
  assert.ok(
    !(local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)),
    `图标必须留在清单目录内，实际解析到：${local}`,
  )
  const stat = statSync(iconPath)
  assert.ok(stat.isFile(), `图标必须是普通文件：${iconPath}`)
  assert.ok(stat.size <= 256 * 1024, `图标超过官方上限 256 KiB：${stat.size} 字节`)
  const bytes = readFileSync(iconPath)
  assert.ok(bytes.length <= 256 * 1024, `图标读取后超过 256 KiB：${bytes.length} 字节`)
  // 官方**只按扩展名**挑 mediaType、不看内容 —— 所以"扩展名与字节对不上"得由这里把关
  const head = bytes.subarray(0, 4).toString('latin1')
  const isSvg = bytes.subarray(0, 5).toString('utf8').trimStart().startsWith('<')
  const isPng = bytes[0] === 0x89 && head.slice(1) === 'PNG'
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
  const isWebp = head === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  const sniffed = isSvg
    ? 'image/svg+xml'
    : isPng
      ? 'image/png'
      : isJpeg
        ? 'image/jpeg'
        : isWebp
          ? 'image/webp'
          : null
  assert.ok(sniffed, `图标内容不是官方接受的任何格式（前 4 字节：${head}）`)
  assert.equal(
    sniffed,
    mediaType,
    `扩展名声明 ${mediaType}，实际字节是 ${sniffed} —— 宿主会按扩展名发 Content-Type，对不上卡片就裂图`,
  )
})

check('exports / files：官方**不激活插件**就要读的那几条路径都在', () => {
  assert.ok(pkgJson.exports?.['.'], '缺 "." 导出')
  assert.ok(pkgJson.exports?.['./package.json'], '缺 "./package.json" 导出 → 官方读不到 meta')
  // ⚠️ locale 是**经 exports 解析**的（宿主走 ModuleLoader），少了这条卡片就没多语言文案
  assert.ok(pkgJson.exports?.['./locale/*.json'], '缺 locale 导出 → 卡片没有多语言文案')
  // 图标相反：官方按清单目录直接读文件，**不需要** exports 条目，但**必须在 files 里**才进发行包
  const iconName = pkgJson.icon.replace(/^\.\//, '')
  assert.ok(pkgJson.files?.includes(iconName), `files 缺图标 ${iconName} → 发行包里没有它`)
  assert.ok(pkgJson.files?.some((f) => f.startsWith('locale/')), 'files 缺 locale')
  assert.ok(pkgJson.files?.includes('cordis.patch.yml'), 'files 缺补丁 → 装上去是个空包')
})

check('locale 文件：可解析、无 BOM、字段齐全', () => {
  for (const lang of ['zh', 'en']) {
    const raw = readFileSync(pkgFile(`locale/${lang}.json`), 'utf8')
    // BOM 会让 JSON.parse 直接抛 —— 卡片文案就静默退化成包名（实测踩过编码坑）
    assert.ok(!raw.startsWith('\uFEFF'), `${lang}.json 带 BOM → JSON.parse 会抛`)
    const meta = JSON.parse(raw)
    assert.ok(meta.title, `${lang}.json 缺 title`)
    assert.ok(meta.description, `${lang}.json 缺 description`)
  }
})

check('bundle 补丁：insert 行的 name 必须等于包名（否则官方装完解析不到）', () => {
  const patch = readFileSync(pkgFile('cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/, '补丁里必须有 insert')
  assert.ok(
    patch.includes(`name: '${pkgJson.name}'`),
    `补丁里的 name 必须是 ${pkgJson.name}；写成绝对路径会绕过 bundle 注册（插件列表里看不到它）`,
  )
})

// ─────────────────────────────────────────────────────────────
console.log('\n[6] 发行元数据：版本 / 命名 / 校验和')

check('版本号：根是唯一来源，插件与外壳必须与它一致', () => {
  // 为什么要有这条：插件卡片显示的是**插件自己**的版本，发行包名用的是**根**的版本。
  // 两处漂移不会有任何报错，只会让用户看到"插件 0.0.1 / 压缩包 v0.1.0"。
  const versions = readVersions(repoRoot)
  assert.match(versions.source ?? '', /^\d+\.\d+\.\d+/, '根 package.json 必须有 semver 版本')
  for (const mirror of versions.mirrors) {
    assert.equal(
      mirror.version,
      versions.source,
      `${mirror.rel} 的版本与根不一致 —— 跑 node tools/bump-version.mjs ${versions.source}`,
    )
  }
})

check('发行包名：版本 + 形态 + 时间戳，八种开关组合互不撞名', () => {
  const at = new Date(2026, 9, 6, 11, 23) // 本地时间 2026-10-06 11:23（月份从 0 数）
  assert.equal(releaseTimestamp(at), '20261006-1123', '时间戳格式要与既有 patch 包一致')
  const seen = new Map()
  for (const withModel of [false, true]) {
    for (const withElectron of [false, true]) {
      for (const withNode of [false, true]) {
        const options = { withModel, withElectron, withNode }
        const name = releaseZipName({ version: '0.1.0', ...options }, at)
        const variant = releaseVariant(options)
        assert.ok(name.includes(`-v0.1.0-${variant}-`), `名字要含 版本+形态：${name}`)
        assert.ok(name.endsWith('-20261006-1123.zip'), `名字要含时间戳：${name}`)
        // 这条是本次改动的**核心目的**：以前 electron 与 electron+model 会生成同名文件
        assert.equal(seen.get(name), undefined, `两种开关生成了同一个名字：${name}`)
        seen.set(name, options)
      }
    }
  }
  assert.equal(seen.size, 8, '八种组合必须生成 8 个互不相同的名字')
})

check('发行包名：没有版本号时**必须报错**，不能编一个默认值', () => {
  assert.throws(() => releaseZipName({}), /version/)
  assert.throws(() => releaseZipName({ version: '  ' }), /version/)
})

check('校验和旁车：两个空格分隔 + 结尾换行（`sha256sum -c` 认的格式）', () => {
  const line = formatSha256Sidecar('a'.repeat(64), 'xilian-pet-v0.1.0-slim-20261006-1123.zip')
  assert.equal(line, `${'a'.repeat(64)}  xilian-pet-v0.1.0-slim-20261006-1123.zip\n`)
  assert.throws(() => formatSha256Sidecar('not-a-hash', 'x.zip'), /sha256/)
})

check('包内 VERSION.txt：版本 / 形态 / 时间 / 提交 / 非商业声明都在', () => {
  const text = releaseInfoText({
    version: '0.1.0',
    options: { withModel: true },
    builtAt: new Date(2026, 9, 6, 11, 23, 45),
    commit: 'abc1234',
  })
  assert.match(text, /版本\s*:\s*v0\.1\.0/)
  assert.match(text, /形态\s*:\s*slim-model/)
  assert.match(text, /2026-10-06 11:23:45/)
  assert.match(text, /abc1234/, '构建来源要能对上提交，排查时不用问人')
  assert.match(text, /NOTICE\.md/, '必须提醒保留署名声明（公开分发的前提）')
  assert.match(text, /非商业/, '必须写明非商业')
})

check('读 git 提交：对真实仓库能读出 7 位短哈希（且不 spawn git）', () => {
  const commit = readGitCommit(repoRoot)
  assert.ok(commit === null || /^[0-9a-f]{7}$/.test(commit), `提交哈希形状不对：${commit}`)
  assert.ok(commit !== null, '本仓库有 .git，应能读出提交；返回 null 说明 HEAD/refs 解析坏了')
})

check('形态说明：三档都要讲清带不带 Electron / 模型', () => {
  assert.match(describeVariant({}), /不含 Electron/)
  assert.match(describeVariant({}), /不含 Live2D 模型/)
  assert.match(describeVariant({ withElectron: true, withModel: true }), /内置 Electron/)
  assert.match(describeVariant({ withElectron: true, withModel: true }), /含 Live2D 模型/)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[7] 授权：LICENSE 与第三方素材的边界')

check('LICENSE 是本项目代码的 MIT，且**明确排除**第三方素材', () => {
  // 为什么必须有这条：NOTICE/README 三处写着「本项目的 MIT 授权范围」，
  // 而仓库里**曾经根本没有 LICENSE** —— 那等于「默认保留所有权利」，和文档说法正好相反。
  const licensePath = join(repoRoot, 'LICENSE')
  assert.ok(existsSync(licensePath), '仓库根必须有 LICENSE，否则文档里的「MIT 授权范围」是凭空捏造')
  const license = readFileSync(licensePath, 'utf8')
  assert.match(license, /^MIT License/, '正文要是标准 MIT（SPDX 识别用）')
  assert.match(license, /Copyright \(c\) 2026 dddddhxwys/, '版权行要写全（年份 + 权利人）')
  assert.match(license, /WITHOUT WARRANTY OF ANY KIND/, 'MIT 的免责声明段不能省')
  // 关键：不能笼统说"本仓库是 MIT" —— 模型与图标必须被显式排除
  assert.match(license, /NOTICE\.md/, '范围说明必须指向 NOTICE.md，否则读者不知道素材另有约束')
  assert.match(license, /assets\/live2d/, '模型目录必须在排除清单里（作者要求不得收费）')
  assert.match(license, /icon\.webp/, '插件图标必须在排除清单里（作者不明）')
  assert.match(license, /米哈游/, '角色素材的权利人要写明')
})

check('文档互指：NOTICE 与 README 都要能点回 LICENSE', () => {
  const notice = readFileSync(new URL('../NOTICE.md', import.meta.url), 'utf8')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(notice, /\[`LICENSE`\]\(LICENSE\)/, 'NOTICE 要给出 LICENSE 链接')
  assert.match(readme, /\[`LICENSE`\]\(LICENSE\)/, 'README 要给出 LICENSE 链接')
})

check('发行包必需清单：LICENSE 与 NOTICE.md 必须在内（合规不能靠"碰巧被收进来"）', () => {
  for (const options of [{}, { withModel: true }, { withModel: true, withElectron: true }]) {
    const list = requiredInRelease(options)
    for (const rel of ['LICENSE', 'NOTICE.md']) {
      assert.ok(list.includes(rel), `${JSON.stringify(options)} 的必需清单缺 ${rel} —— 发行人漏了就是许可违规`)
      assert.ok(existsSync(join(repoRoot, rel)), `${rel} 不在仓库里，发行包自检会直接失败`)
    }
  }
})

// ─────────────────────────────────────────────────────────────
console.log('\n[8] 更新检查：版本比较 / 清单 / 失败与安静的边界')

check('版本比较：语义正确（不是字符串比较）', () => {
  // ⚠️ 这两条正是"拿字符串比"会错的经典例：字符串下 "0.1.10" < "0.1.9"
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1, '0.1.10 比 0.1.9 新（数值比较）')
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1, 'rc.10 比 rc.9 新（预发布也按数值）')
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  // semver：预发布 < 正式版
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1, '正式版比预发布新')
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha'), 1, '前缀相同则更长的新')
  // 不合法就必须抛错 —— 不能猜一个默认值出来
  assert.throws(() => compareVersions('v0.1.0', '0.1.0'), /semver/)
  assert.throws(() => compareVersions('0.1', '0.1.0'), /semver/)
})

check('清单解析：结构不对**必须抛错**（不能悄悄当成"没有新版本"）', () => {
  const good = JSON.stringify({
    schema: 1,
    latest: '0.2.0',
    releasedAt: '2026-10-08',
    notes: 'x',
    releaseUrl: 'https://example.com',
    assets: [
      { version: '0.2.0', flavor: 'slim-model', file: 'a.zip', size: 10, sha256: 'a'.repeat(64), url: 'https://example.com/a.zip' },
    ],
  })
  assert.equal(parseManifest(good).latest, '0.2.0')
  // 逐条负向对照：这些都是"看起来像清单但其实不能信"的输入
  assert.throws(() => parseManifest('not json'), /JSON/)
  assert.throws(() => parseManifest('[]'), /对象/)
  assert.throws(() => parseManifest(JSON.stringify({ schema: 2, latest: '0.1.0' })), /schema/)
  assert.throws(() => parseManifest(JSON.stringify({ schema: 1, latest: 'latest' })), /latest/)
  assert.throws(() => parseManifest(JSON.stringify({ schema: 1, latest: '0.1.0', assets: {} })), /assets/)
  // version 必填：清单会留住历史版本的条目，没有它就只能按文件名猜"这是哪一版"
  assert.throws(
    () =>
      parseManifest(
        JSON.stringify({ schema: 1, latest: '0.1.0', assets: [{ flavor: 's', file: 'a.zip', sha256: 'a'.repeat(64) }] }),
      ),
    /version/,
  )
  // sha256 必填且必须是 64 位十六进制 —— 用户就拿它核对下载
  assert.throws(
    () =>
      parseManifest(
        JSON.stringify({ schema: 1, latest: '0.1.0', assets: [{ version: '0.1.0', flavor: 's', file: 'a.zip' }] }),
      ),
    /sha256/,
  )
  assert.throws(
    () =>
      parseManifest(
        JSON.stringify({
          schema: 1,
          latest: '0.1.0',
          assets: [{ version: '0.1.0', flavor: 's', file: 'a.zip', sha256: 'XYZ' }],
        }),
      ),
    /sha256/,
  )
})

check('清单挑包：只给**最新版本**的同形态包，不给别的形态、也不给旧版本的文件', () => {
  const manifest = parseManifest(
    JSON.stringify({
      schema: 1,
      latest: '0.2.0',
      assets: [
        // 历史版本的条目（清单会留着便于追溯）—— 形态相同，但**绝不能**被挑出来
        { version: '0.1.0', flavor: 'slim-model', file: 'old.zip', sha256: '0'.repeat(64) },
        { version: '0.2.0', flavor: 'slim-model', file: 'a.zip', sha256: 'a'.repeat(64) },
        { version: '0.2.0', flavor: 'full-model', file: 'b.zip', sha256: 'b'.repeat(64) },
      ],
    }),
  )
  assert.equal(pickAsset(manifest, 'slim-model').file, 'a.zip', '必须挑最新版本那一版的同形态包')
  assert.equal(pickAsset(manifest, 'full-model').file, 'b.zip')
  assert.equal(pickAsset(manifest, 'allinone-model'), null, '没有同形态必须是 null')
  assert.equal(pickAsset(manifest, null), null)
  assert.equal(pickAsset(manifest, '  '), null)
})

check('清单序列化 ↔ 解析：往返一致（固定键序，git diff 才干净）', () => {
  const manifest = parseManifest(
    JSON.stringify({
      schema: 1,
      latest: '0.2.0',
      releasedAt: '2026-10-08',
      notes: '改了拖拽',
      releaseUrl: 'https://example.com/releases',
      // 故意乱序，验证输出会按 flavor 排好
      assets: [
        { version: '0.2.0', flavor: 'slim-model', file: 'a.zip', size: 100, sha256: 'a'.repeat(64), url: 'https://e/a.zip' },
        { version: '0.2.0', flavor: 'full-model', file: 'b.zip', size: 200, sha256: 'b'.repeat(64), url: null },
      ],
    }),
  )
  const text = serializeManifest(manifest)
  assert.ok(text.endsWith('\n'), '结尾要有换行（不然 git 会标记 no newline at end of file）')
  const back = parseManifest(text)
  // 内容必须一字不差（顺序单独断言，见下）
  assert.equal(back.latest, manifest.latest)
  assert.equal(back.notes, manifest.notes)
  assert.equal(back.releaseUrl, manifest.releaseUrl)
  assert.equal(back.releasedAt, manifest.releasedAt)
  assert.deepEqual(
    back.assets.find((a) => a.flavor === 'slim-model'),
    manifest.assets.find((a) => a.flavor === 'slim-model'),
  )
  assert.deepEqual(
    back.assets.find((a) => a.flavor === 'full-model'),
    manifest.assets.find((a) => a.flavor === 'full-model'),
  )
  assert.deepEqual(
    back.assets.map((a) => a.flavor),
    ['full-model', 'slim-model'],
    '按 flavor 排序，输出稳定',
  )
  // 真正的性质：读出来再写回去**逐字节不变** —— 否则每次打包都会在 git 里产生噪音 diff
  assert.equal(serializeManifest(back), text, '序列化必须幂等')
})

// 假的 fetch：按 URL 查表。数字 = HTTP 状态码；字符串 = 响应体；查不到 = 网络错误
function fakeFetch(routes) {
  return async (url) => {
    const value = routes[url]
    if (value === undefined) throw new Error('ENOTFOUND 假装网络不通')
    if (typeof value === 'number') return { ok: false, status: value, text: async () => '' }
    return { ok: true, status: 200, text: async () => value }
  }
}

const MANIFEST_020 = JSON.stringify({
  schema: 1,
  latest: '0.2.0',
  releasedAt: '2026-10-08',
  notes: '修了分数 DPI 下拖拽抖动',
  releaseUrl: 'https://github.com/dddddhxwys/xilian-pet/releases/tag/v0.2.0',
  assets: [
    {
      version: '0.2.0',
      flavor: 'slim-model',
      file: 'xilian-pet-v0.2.0-slim-model-20261008-1200.zip',
      size: 1876543,
      sha256: 'c'.repeat(64),
    },
  ],
})
const SRC_A = 'https://example.invalid/primary/versions.json'
const SRC_B = 'https://example.invalid/fallback/versions.json'

await checkAsync('检查：线上更新 → available，并按形态挑到包', async () => {
  const result = await checkForUpdate({
    localVersion: '0.1.0',
    localFlavor: 'slim-model',
    sources: [SRC_A],
    fetchImpl: fakeFetch({ [SRC_A]: MANIFEST_020 }),
  })
  assert.equal(result.status, 'available')
  assert.equal(result.latest, '0.2.0')
  assert.equal(result.asset?.file, 'xilian-pet-v0.2.0-slim-model-20261008-1200.zip')
  assert.equal(result.source, SRC_A)
})

await checkAsync('检查：版本相同 → up-to-date；本地更新 → ahead（不是"已最新"）', async () => {
  const same = await checkForUpdate({
    localVersion: '0.2.0',
    localFlavor: 'slim-model',
    sources: [SRC_A],
    fetchImpl: fakeFetch({ [SRC_A]: MANIFEST_020 }),
  })
  assert.equal(same.status, 'up-to-date')
  const ahead = await checkForUpdate({
    localVersion: '0.3.0',
    localFlavor: 'slim-model',
    sources: [SRC_A],
    fetchImpl: fakeFetch({ [SRC_A]: MANIFEST_020 }),
  })
  assert.equal(ahead.status, 'ahead', '本地比线上新时既不是"有新版"也不是"已最新"')
})

await checkAsync('多来源回退：第一个坏、第二个好 → 必须成功（加镜像就是加一行）', async () => {
  const result = await checkForUpdate({
    localVersion: '0.1.0',
    sources: [SRC_A, SRC_B],
    fetchImpl: fakeFetch({ [SRC_A]: 503, [SRC_B]: MANIFEST_020 }),
  })
  assert.equal(result.status, 'available')
  assert.equal(result.source, SRC_B, '要报告真正答话的那个来源')
  assert.equal(result.attempts.length, 2)
  assert.equal(result.attempts[0].ok, false)
  assert.equal(result.attempts[1].ok, true)
})

await checkAsync('全部来源不可达 → failed（**绝不能变成 up-to-date**）', async () => {
  const result = await checkForUpdate({
    localVersion: '0.1.0',
    sources: [SRC_A, SRC_B],
    fetchImpl: fakeFetch({}),
  })
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /都没问到/)
  assert.equal(result.attempts.length, 2, '每个来源的失败原因都要留着，用户报问题时能看出堵在哪')
})

await checkAsync('清单结构坏 → 也算检查失败（不能当成"没有新版本"）', async () => {
  const result = await checkForUpdate({
    localVersion: '0.1.0',
    sources: [SRC_A],
    fetchImpl: fakeFetch({ [SRC_A]: '{"schema":1}' }),
  })
  assert.equal(result.status, 'failed')
  assert.match(result.attempts[0].reason, /latest/)
})

await checkAsync('本地版本读不到 → failed（不猜）', async () => {
  const result = await checkForUpdate({ localVersion: null, sources: [SRC_A], fetchImpl: fakeFetch({ [SRC_A]: MANIFEST_020 }) })
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /本地版本/)
})

await checkAsync('总预算用尽 → 后面的来源不再问（安装时不能被网络拖住）', async () => {
  let clock = 0
  const result = await checkForUpdate({
    localVersion: '0.1.0',
    sources: [SRC_A, SRC_B],
    totalBudgetMs: 1000,
    fetchImpl: fakeFetch({ [SRC_A]: MANIFEST_020, [SRC_B]: MANIFEST_020 }),
    now: () => (clock += 1000), // 每问一次时间就跳 1 秒 → 第一次判断预算就已用尽
  })
  assert.equal(result.status, 'failed')
  assert.ok(
    result.attempts.some((a) => /超出总预算/.test(a.reason ?? '')),
    `应有一条"超出总预算"的记录，实际：${JSON.stringify(result.attempts)}`,
  )
  assert.ok(
    result.attempts.every((a) => a.ok === false),
    '预算用尽就不该再去抓 —— 一个来源都不该成功',
  )
})

check('★ 方案 A 的核心：失败在**安装时必须一个字都不打**', () => {
  const failed = { status: 'failed', localVersion: '0.1.0', localFlavor: 'slim', attempts: [{ source: SRC_A, ok: false, reason: 'ECONNRESET' }], reason: '所有来源都没问到（试了 2 个）' }
  assert.deepEqual(formatCheckResult(failed, { quiet: true }), [], '安装时的失败必须完全静默（否则 install-log 里那句"失败"会被当成安装失败）')
  const loud = formatCheckResult(failed, {})
  assert.ok(loud.length > 0, '用户主动查时要说话')
  assert.ok(
    loud.some((line) => /不等于/.test(line)),
    '必须要说清"没查到 ≠ 已是最新" —— 这是更新检查器最经典的谎言',
  )
  // 断言"不能出现 ✅" —— 那是成功确认的标记；失败输出里出现它，用户会以为查过了
  assert.ok(
    !loud.join('\n').includes('✅'),
    '失败输出里不能出现 ✅（成功确认的标记）—— 那会让人以为"已经查过了"',
  )
})

check('★ 已是最新 / 开发版：安装时也不出声；用户主动查时才说', () => {
  const upToDate = { status: 'up-to-date', localVersion: '0.2.0', localFlavor: 'slim', latest: '0.2.0', source: SRC_A, attempts: [] }
  assert.deepEqual(formatCheckResult(upToDate, { quiet: true }), [], '安装时"已是最新"不用打，保持安装输出干净')
  assert.ok(formatCheckResult(upToDate, {}).some((line) => /已是最新/.test(line)))
  const ahead = { status: 'ahead', localVersion: '0.3.0', localFlavor: null, latest: '0.2.0', source: SRC_A, attempts: [] }
  assert.deepEqual(formatCheckResult(ahead, { quiet: true }), [])
  assert.ok(formatCheckResult(ahead, {}).some((line) => /比线上还新/.test(line)))
})

check('★ 有新版本：安装时只出**一行**；用户主动查时给全（说明/下载/sha256）', () => {
  const available = {
    status: 'available',
    localVersion: '0.1.0',
    localFlavor: 'slim-model',
    latest: '0.2.0',
    releasedAt: '2026-10-08',
    notes: '修了分数 DPI 下拖拽抖动',
    releaseUrl: 'https://github.com/dddddhxwys/xilian-pet/releases/tag/v0.2.0',
    asset: { flavor: 'slim-model', file: 'xilian-pet-v0.2.0-slim-model-20261008-1200.zip', size: 1876543, sha256: 'c'.repeat(64), url: null },
    assetMissingForFlavor: false,
    source: SRC_A,
    attempts: [],
  }
  const quietLines = formatCheckResult(available, { quiet: true })
  assert.equal(quietLines.length, 1, '安装时只准出一行')
  assert.match(quietLines[0], /0\.1\.0/)
  assert.match(quietLines[0], /0\.2\.0/)
  assert.match(quietLines[0], /检查更新\.cmd/, '要告诉用户去哪看详情')

  const loudLines = formatCheckResult(available, {})
  const text = loudLines.join('\n')
  assert.match(text, /修了分数 DPI/, '要带更新说明')
  assert.match(text, /SHA256/, '要给校验和')
  assert.match(text, new RegExp('c'.repeat(64)))
  assert.match(text, /1\.79 MB/, '要显示体积')
  assert.match(text, /新目录/, '要提醒解压到新目录，别覆盖')

  // 线上没有同形态的包：如实说，别推荐一个不是他那个形态的
  const missing = { ...available, asset: null, assetMissingForFlavor: true }
  assert.match(formatCheckResult(missing, {}).join('\n'), /没有与你同形态/)
  assert.equal(formatCheckResult(missing, { quiet: true }).length, 1)
})

check('清单更新：新包入账 + latest 抬升；重复打包是**原地替换**不新增条目', () => {
  const empty = { schema: 1, latest: '0.1.0', releasedAt: '2026-10-01', notes: '旧说明', releaseUrl: null, assets: [] }
  const first = upsertManifest(empty, {
    version: '0.2.0',
    flavor: 'slim-model',
    file: 'a.zip',
    size: 100,
    sha256: 'a'.repeat(64),
    url: 'https://e/a.zip',
    releasedAt: '2026-10-08',
    notes: '新说明',
  })
  assert.equal(first.manifest.latest, '0.2.0')
  assert.equal(first.manifest.notes, '新说明')
  assert.equal(first.manifest.assets.length, 1)
  assert.equal(first.notesMissing, false)

  // 同一版重新打包：**文件名会变**（时间戳变了），sha256 也变 —— 必须原地替换，不能变成两条
  // ⚠️ 这条是实测撞出来的：旧逻辑按文件名找，于是清单里累积了两条同形态条目，
  //    而挑包时拿到的是**旧的那条**
  const rebuilt = upsertManifest(first.manifest, {
    version: '0.2.0',
    flavor: 'slim-model',
    file: 'a-2.zip',
    size: 100,
    sha256: 'b'.repeat(64),
    url: 'https://e/a-2.zip',
    releasedAt: '2026-10-08',
    notes: '新说明',
  })
  assert.equal(rebuilt.manifest.assets.length, 1, '同一版同一形态重新打包必须**原地替换**，不能累积成两条')
  assert.equal(rebuilt.manifest.assets[0].file, 'a-2.zip', '替换后的必须是最新那次打出来的文件')
  assert.equal(rebuilt.manifest.assets[0].sha256, 'b'.repeat(64), 'sha256 必须跟着刷新')
  assert.ok(rebuilt.changed.some((c) => /sha256 已刷新/.test(c)))

  // 形态相同但**版本不同**：两条都要在（追溯用），且挑包只挑 latest 那一版
  const mixed = upsertManifest(rebuilt.manifest, {
    version: '0.1.0',
    flavor: 'slim-model',
    file: 'old-slim.zip',
    size: 50,
    sha256: 'f'.repeat(64),
    url: null,
    releasedAt: '2026-10-01',
  })
  assert.equal(mixed.manifest.assets.length, 2, '不同版本的同形态包应各留一条')
  assert.equal(pickAsset(mixed.manifest, 'slim-model').file, 'a-2.zip', '挑包必须挑 latest 那一版')

  // 补打旧版：只入账，**不把 latest 降级**
  const older = upsertManifest(rebuilt.manifest, {
    version: '0.1.0',
    flavor: 'full-model',
    file: 'old.zip',
    size: 50,
    sha256: 'd'.repeat(64),
    url: null,
    releasedAt: '2026-10-01',
  })
  assert.equal(older.manifest.latest, '0.2.0', 'latest 不能被旧版降级')
  assert.equal(older.manifest.assets.length, 2)
  assert.ok(older.changed.some((c) => /保留 latest/.test(c)))

  // latest 抬升但没给说明 → 必须提醒（别静默发布空说明）
  const noNotes = upsertManifest(empty, {
    version: '0.3.0',
    flavor: 'slim',
    file: 'b.zip',
    size: 10,
    sha256: 'e'.repeat(64),
    url: null,
    releasedAt: '2026-10-09',
  })
  assert.equal(noNotes.notesMissing, true, '没给 notes 时必须报出来')
  assert.equal(noNotes.manifest.notes, '')
})

check('仓库里的 versions.json 合法，且**不会宣传一个不存在的版本**', () => {
  const manifest = parseManifest(readFileSync(join(repoRoot, 'versions.json'), 'utf8'))
  const versions = readVersions(repoRoot)
  // latest 可以比当前仓库版本旧（刚 bump 完还没打包），但**绝不能更新** ——
  // 那等于告诉所有用户"有新版本"，而那个版本根本还没做出来。
  assert.ok(
    compareVersions(manifest.latest, versions.source) <= 0,
    `versions.json 的 latest=${manifest.latest} 比 package.json 的 ${versions.source} 还新 —— 会宣传一个不存在的版本`,
  )
  assert.match(manifest.releaseUrl ?? '', /github\.com\/dddddhxwys\/xilian-pet/, '发布页要指向本仓库')
})

check('发行清单不进发行包（用户手里那份的 latest 是打包那一刻的，只会造成困惑）', () => {
  assert.equal(shouldInclude('versions.json', { withModel: true }), false)
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
