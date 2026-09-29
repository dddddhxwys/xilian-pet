/**
 * 西莲桌宠 Host 插件自测 —— 不需要 DSH，不需要安装。
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

import { apply } from '../packages/pet-plugin/index.js'
import {
  aggregate,
  createPetState,
  normalizeSessionEvent,
  normalizeStreamChunk,
  reducePetEvent,
  reduceStreamChunk,
  releaseHeld,
  snapshot,
} from '../packages/pet-plugin/reducer.js'

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
  s = emit(s, 'attention/approval', 's2', 1000)
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
  let s = emit(st, 'turn/start', 's1', 0) // running
  const r = reducePetEvent(s, { kind: 'session/error', sessionId: 's1' }, 100) // error 更高
  assert.equal(r.state.current, 'error')
})

check('降优先级在最短保持时间内被压住', () => {
  const st = createPetState({ minHoldMs: 500 })
  let s = emit(st, 'attention/approval', 's1', 1000) // approval
  assert.equal(s.current, 'approval')
  const r = reducePetEvent(s, { kind: 'session/error', sessionId: 's1' }, 1100) // 仅过 100ms
  assert.equal(r.state.current, 'approval', '未满 500ms 不应降档')
})

check('releaseHeld 在没有新事件时释放被压住的状态', () => {
  const st = createPetState({ minHoldMs: 500 })
  let s = emit(st, 'attention/approval', 's1', 1000)
  s = reducePetEvent(s, { kind: 'session/error', sessionId: 's1' }, 1100).state
  const r = releaseHeld(s, 1600) // 距上次切换 600ms
  assert.equal(r.state.current, 'error')
  assert.equal(r.frames[0].type, 'state')
})

check('reduceStreamChunk 累积 tail 并产生 stream 帧', () => {
  const r = reduceStreamChunk(createPetState(), { sessionId: 's1', text: '你好' }, 0)
  const r2 = reduceStreamChunk(r.state, { sessionId: 's1', text: '，西莲' }, 1)
  assert.equal(r2.state.sessions.s1.tail, '你好，西莲')
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

check('归一化：agent/assistant-stream 是 ({ agent, frame })', () => {
  const chunk = normalizeStreamChunk({
    agent: { session: { id: 's9' } },
    frame: { type: 'text-delta', text: '喂' },
  })
  assert.equal(chunk.sessionId, 's9')
  assert.equal(chunk.text, '喂')
  assert.equal(chunk.frameType, 'text-delta')
  assert.equal(normalizeStreamChunk({ agent: {} }), null)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[2] 插件契约（mock ctx）')

function createMockCtx({ agents } = {}) {
  const routes = new Map()
  const listeners = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
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
    agents: agents === undefined ? undefined : { get: agents },
  }
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
  followup: async (text) => calls.push(['followup', text]),
  cancel: async () => calls.push(['cancel']),
}
const mockAgentGetter = (sessionId) => (sessionId === 'known' ? fakeAgent : undefined)

const { ctx, routes, listeners, warnings } = createMockCtx({ agents: mockAgentGetter })
const dispose = apply(ctx, { pathPrefix: '/xilian-pet', minHoldMs: 0 })

check('apply 注册了 7 条 exact 路由', () => {
  assert.equal(routes.size, 7, `实际 ${routes.size}：${[...routes.keys()].join(', ')}`)
})

check('所有路由都是 exact（避免被 /api 之类的前缀路由吞掉）', () => {
  for (const r of routes.values()) assert.equal(r.kind, 'exact')
})

check('只在通知型事件上注册监听器（2 个）', () => {
  assert.equal(listeners.get('session/event')?.length, 1)
  assert.equal(listeners.get('agent/assistant-stream')?.length, 1)
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

await checkAsync('GET /health → 200 且 ok:true', async () => {
  const res = await fetch(`${base}/xilian-pet/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'xilian-pet')
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

await checkAsync('POST /prompt 命中 agent → followup 被调用', async () => {
  const res = await fetch(`${base}/xilian-pet/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'known', text: '去写个 README' }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(calls.at(-1), ['followup', '去写个 README'])
})

await checkAsync('POST /interrupt 命中 agent → cancel 被调用', async () => {
  const res = await fetch(`${base}/xilian-pet/interrupt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'known' }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(calls.at(-1), ['cancel'])
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
    fn({ agent: { session: { id: 's1' } }, frame: { type: 'text-delta', text: '西莲在写' } })
  const text = await sse.readUntil((b) => b.includes('"type":"stream"'), 3000)
  sse.close()
  assert.match(text, /西莲在写/)
})

await checkAsync('GET /debug/shapes → 记录到原始事件形状样本', async () => {
  const body = await (await fetch(`${base}/xilian-pet/debug/shapes`)).json()
  assert.ok(body.count >= 1, '应至少记录一条形状样本')
  assert.ok(body.shapes.some((s) => s.channel === 'session/event'))
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
