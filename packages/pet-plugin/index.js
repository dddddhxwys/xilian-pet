/**
 * 昔涟桌宠 · DSH Host 插件
 *
 * 职责：
 *  1. 观测 DSH 会话事件（session/event、agent/assistant-stream、tools/pre-execute）
 *  2. 归一化为桌宠事件 → 纯函数状态机 → 同源 SSE 推给 Electron 窗口
 *  3. 暴露反向操控入口：派活（followup）、中断（cancel）、聚焦（focus）
 *
 * 形态：纯 ESM、零依赖、零构建。官方契约（references/host-plugin.md）：
 *   - Host-only bundle 需要 no dependencies / no install scripts / no build tool
 *   - index.js 导出 `apply(ctx, config)`，可选 `inject` / `Config`，不要混用导出形式
 *   - 所有资源在 apply 内用 ctx.effect / ctx.on 注册，并返回其清理函数
 *
 * 安全约束（PLAN.md §三 设计要点 5）：观测类监听器绝不返回决策、不 next()，
 * 不影响 agent 行为。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
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
} from './reducer.js'
import {
  createReminderState,
  decideReminders,
  isQuiet,
  mergeReminderConfig,
  parseQuietHours,
} from './reminders.js'

export const name = 'xilian-pet'

/**
 * 需要哪些服务就绪后才跑 apply。
 *
 * ⚠️ **用到 `ctx.<服务>` 就必须在这里声明，否则读属性时当场抛**
 * `cannot get property "agents" without inject`。
 * 原因：Cordis 的 ctx 是 Proxy —— 访问一个**已注册的服务**属性时，
 * 若该名字不在 `inject` 列表里，它**抛错**而不是返回 undefined
 * （已从 `app.asar` 里的 Context handler 核实）。
 *
 * 这个坑的真实代价：A6「双击派活」一直报
 * `派活失败 (500)：cannot get property "agents" without inject`；
 * 而 `resolveAgent()` 里那句 `agents === undefined` 的兜底**根本执行不到** ——
 * 异常在"取属性"那一步就抛了。
 *
 * 它还解释了"自测 62 项全绿、真机却失败"：mock ctx 把 `agents` 当普通属性发，
 * 没复现 inject 校验。mock 已按真实语义收紧（见 `tools/check-plugin.mjs`），
 * 并补了静态扫描 + 负向对照，防止再犯。
 */
export const inject = ['webServer', 'agents']

const PROTOCOL_VERSION = 1
const HEARTBEAT_MS = 15_000

/**
 * 代码修订号 —— **每次改本文件 / reducer.js / reminders.js 都要 +1**。
 * 目的：`/health` 会带上它，于是"改动到底有没有被加载"一眼可判：
 *   重启后 code 变大 = 新代码生效；code 没变 = 改的代码没被加载。
 * （注：`hmr.root` 实测无效，源码热重载不可用，只能靠重启。）
 */
const CODE_REVISION = 7

/**
 * 与 `@deepseek-ai/dsh-util-values` 的 `deepFreeze` 等价：递归冻结 + WeakSet 防循环。
 */
function deepFreeze(value) {
  const seen = new WeakSet()
  const stack = [value]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    for (const key of Object.getOwnPropertyNames(node)) stack.push(node[key])
  }
  return value
}

/**
 * 内置的 UserMessage 构造 —— 与官方 `createUserMessage` **逐字等价**。
 *
 * 为什么敢自己造（下面每条都从 `app.asar` 里读出来核实过，不是推测）：
 *   · `createUserMessage(input)` = `createMessage({ ...input, role: 'user' })`
 *   · `createMessage(input)`     = `deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))`
 *   · `brandString(v)` 的实现就是 `return v` —— `@deepseek-ai/dsh-brand` 自述
 *     "Duplicate-install-safe … keeps no runtime identity or mutable state, so
 *      independently installed copies produce interchangeable values"，
 *     即它只是**编译期**标记，运行时恒等。
 *   · `randomUUID()` 是标准 v4 UUID（`crypto.getRandomValues` 生成）。
 *
 * 所以官方产物 == `{ ...input, role: 'user', id: <v4 uuid> }` 的深拷贝 + 深冻结。
 * 字段与官方**完全一致（不多不少）**，`followup()` 收到的对象形状不变。
 */
function makeUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * 安全预览：载荷里常有循环引用（例如 agent.ctx）。
 * 直接 JSON.stringify 会抛，预览就变成 `<unserializable>` —— 而那恰恰是
 * 诊断时最需要的一条信息（实测：agent/status 的样本预览就是这么丢的）。
 */
function safePreview(value, limit = 400) {
  const seen = new WeakSet()
  try {
    const text = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'function') return `[fn ${val.name || 'anonymous'}]`
      if (typeof val === 'bigint') return `${val}n`
      if (val !== null && typeof val === 'object') {
        if (seen.has(val)) return '[circular]'
        seen.add(val)
      }
      return val
    })
    return text === undefined ? '<undefined>' : text.slice(0, limit)
  } catch (error) {
    return `<unserializable: ${error?.message ?? error}>`
  }
}

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
  })
  res.end(text)
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx, config = {}) {
  const pathPrefix =
    typeof config.pathPrefix === 'string' && config.pathPrefix.startsWith('/')
      ? config.pathPrefix.replace(/\/+$/, '')
      : '/xilian-pet'
  const minHoldMs = Number.isFinite(config.minHoldMs) ? config.minHoldMs : 500
  const captureRawShapes = Number.isFinite(config.captureRawShapes) ? config.captureRawShapes : 20

  // A7 主动提醒
  const reminderConfig = mergeReminderConfig(config.reminders)
  let reminderState = createReminderState()
  /** 迟到的提醒：窗口没连时发出的提醒不能丢，等它连上补发 */
  const pendingNotices = []

  let state = createPetState({ minHoldMs })
  const connections = new Set()
  // 形状样本：**按 channel 分别限量**，不是全局环形缓冲。
  // 踩过的坑：全局环形会被高频通道刷爆 —— agent/assistant-stream 每个 token 一帧，
  // 实测 80 条样本全被它占满，session/event 与 agent/status 的样本全被挤出去，
  // 于是"想确认某类事件到底收到没有"根本查不到。
  const rawShapes = new Map()
  const startedAt = Date.now()

  function publish(frame) {
    const line = sseData(frame)
    for (const res of connections) {
      try {
        res.write(line)
      } catch {
        connections.delete(res)
      }
    }
  }

  function publishFrames(frames) {
    for (const f of frames) publish(f)
  }

  function noteRawShape(channel, raw) {
    if (captureRawShapes <= 0) return
    const list = rawShapes.get(channel) ?? []
    list.push({
      channel,
      at: Date.now(),
      keys: raw !== null && typeof raw === 'object' ? Object.keys(raw) : typeof raw,
      preview: safePreview(raw),
    })
    // 只裁剪本通道，其他通道的样本不受影响
    if (list.length > captureRawShapes) list.splice(0, list.length - captureRawShapes)
    rawShapes.set(channel, list)
  }

  function warn(message) {
    try {
      ctx.logger?.warn?.(`xilian-pet: ${message}`)
    } catch {
      /* logger 不可用时静默，绝不让观测逻辑影响宿主 */
    }
  }

  /** 观测 session/event。真实签名是 (session, event) 两个参数。 */
  function observeSession(session, event) {
    try {
      noteRawShape('session/event', { sessionId: session?.id, event })
      const ev = normalizeSessionEvent(session, event)
      if (ev === null) return
      const result = reducePetEvent(state, ev, Date.now())
      state = result.state
      publishFrames(result.frames)
    } catch (error) {
      warn(`observe(session/event) failed: ${error?.message ?? error}`)
    }
  }

  /** 观测 agent/assistant-stream。真实签名是 ({ agent, frame }) 一个对象。 */
  function observeStream(payload) {
    try {
      noteRawShape('agent/assistant-stream', { agentId: payload?.agent?.id, frameType: payload?.frame?.type })
      const chunk = normalizeStreamChunk(payload)
      if (chunk === null) return
      const result = reduceStreamChunk(state, chunk, Date.now())
      state = result.state
      publishFrames(result.frames)
    } catch (error) {
      warn(`observe(assistant-stream) failed: ${error?.message ?? error}`)
    }
  }

  /** 观测 agent/status。载荷 { agent, status }，这是权威的运行/空闲信号。 */
  function observeAgentStatus(payload) {
    try {
      noteRawShape('agent/status', payload)
      const status = normalizeAgentStatus(payload)
      if (status === null) return
      const result = reduceAgentStatus(state, status, Date.now())
      state = result.state
      publishFrames(result.frames)
    } catch (error) {
      warn(`observe(agent/status) failed: ${error?.message ?? error}`)
    }
  }

  /** 观测 agent/error。载荷 { agent, turn, error }。 */
  function observeAgentError(payload) {
    try {
      noteRawShape('agent/error', { agentId: payload?.agent?.id, message: payload?.error?.message })
      const failure = normalizeAgentError(payload)
      if (failure === null) return
      const result = reduceAgentError(state, failure, Date.now())
      state = result.state
      publishFrames(result.frames)
    } catch (error) {
      warn(`observe(agent/error) failed: ${error?.message ?? error}`)
    }
  }

  const disposers = []

  // ── 1. 事件观测（只读通知，返回值无影响）────────────────────────────
  //
  // 🚨 血泪教训，不要再犯：**绝不能订阅 tools/pre-execute 或 tools/post-execute。**
  //
  // 它们是 **waterfall**，官方是这么用的：
  //     const gate = await ctx.waterfall(carrier, 'tools/pre-execute', exec,
  //                                     () => Promise.resolve({ kind: 'allow' }))
  //     const ask = gate.kind === 'ask' ? ... : ...
  // 约定监听器必须返回 `next()`（或一个决策对象）来把链路传下去。
  // 我曾在上面注册 `(payload) => { observe(); return undefined }` —— 没调用 next()，
  // 于是链路里的值被冲成 undefined，下游 `gate.kind` 抛
  //   TypeError: Cannot read properties of undefined (reading 'kind')
  // 后果：**整个 profile 的每一次工具调用全部失败**（read/glob/grep 也不例外），
  // 而且重启 DSH 也不恢复 —— 插件是开机即加载的。
  //
  // 如果以后要做 A7 的审批感知，正确写法是：
  //     ctx.on('tools/pre-execute', (exec, next) => { observe(exec); return next() })
  // 并且必须在真实宿主上验证过再提交。
  disposers.push(ctx.on('session/event', (session, event) => observeSession(session, event)))
  disposers.push(ctx.on('agent/assistant-stream', (payload) => observeStream(payload)))
  // agent/status 是权威的运行/空闲信号 —— 没有它，状态只会单向升档、永远降不回来
  // （实测：插件挂上后 state 卡在 "running" 长达 16 小时）。
  disposers.push(ctx.on('agent/status', (payload) => observeAgentStatus(payload)))
  disposers.push(ctx.on('agent/error', (payload) => observeAgentError(payload)))

  // ── 2. 路由注册 ────────────────────────────────────────────────────
  function register(method, path, handler, label) {
    disposers.push(
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path,
            handler: async (req, res) => {
              if (req.method === 'OPTIONS') {
                res.writeHead(204, CORS)
                res.end()
                return
              }
              if (method !== undefined && req.method !== method) {
                sendJson(res, 405, { error: 'method-not-allowed', allow: method })
                return
              }
              try {
                await handler(req, res)
              } catch (error) {
                if (!res.headersSent) {
                  sendJson(res, 500, { error: 'internal', message: String(error?.message ?? error) })
                } else {
                  res.end()
                }
              }
            },
          }),
        label,
      ),
    )
  }

  // 健康检查：用于确认插件是否被加载（不需要鉴权、不碰 SSE）
  register(
    'GET',
    `${pathPrefix}/health`,
    (req, res) =>
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        protocol: PROTOCOL_VERSION,
        code: CODE_REVISION,
        pid: process.pid,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        subscribers: connections.size,
        pendingApprovals: pendingApprovalCount(state),
        state: state.current,
        // 派活用的 UserMessage 工厂来源：config / module:<路径> / builtin（内置等价实现）
        messageFactory: factorySource,
        messageFactoryAttempts: factoryAttempts,
      }),
    `xilian-pet: GET ${pathPrefix}/health`,
  )

  // 当前状态快照
  register(
    'GET',
    `${pathPrefix}/state`,
    (req, res) => sendJson(res, 200, snapshot(state)),
    `xilian-pet: GET ${pathPrefix}/state`,
  )

  // 原始事件形状样本（用于在真实运行中确认载荷结构，而非猜测）
  register(
    'GET',
    `${pathPrefix}/debug/shapes`,
    (req, res) => {
      const flat = [...rawShapes.values()].flat()
      sendJson(res, 200, {
        count: flat.length,
        byChannel: Object.fromEntries([...rawShapes].map(([c, list]) => [c, list.length])),
        shapes: flat,
      })
    },
    `xilian-pet: GET ${pathPrefix}/debug/shapes`,
  )

  // SSE 事件流（照抄官方 dsh-client-hmr 的实现约定）
  register(
    'GET',
    `${pathPrefix}/events`,
    (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...CORS,
      })
      res.write(': connected\n\n')
      res.write(sseData({ type: 'hello', protocol: PROTOCOL_VERSION, pid: process.pid, startedAt }))
      res.write(sseData({ type: 'snapshot', ...snapshot(state) }))
      // 补发迟到的提醒（窗口没连时发出的那些），最多 5 条
      if (pendingNotices.length > 0) {
        res.write(sseData({ type: 'notices', notices: pendingNotices.slice(-5) }))
      }
      connections.add(res)
      res.on('close', () => connections.delete(res))
    },
    `xilian-pet: GET ${pathPrefix}/events (SSE)`,
  )

  // ── 3. 反向操控 ────────────────────────────────────────────────────
  /**
   * ⚠️ 下面这行 `ctx.agents` 能成立，**前提是顶部 `inject` 里声明了 `'agents'`**。
   * 少了声明不会拿到 undefined，而是当场抛 `cannot get property "agents" without inject`。
   * 所以紧接着那句 undefined 兜底，只在"服务已注入、但没有这个 sessionId"时才轮得到。
   */
  function resolveAgent(sessionId) {
    const agents = ctx.agents
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    if (sessionId === undefined) return undefined
    return agents.get(sessionId)
  }

  /**
   * UserMessage 工厂。
   *
   * 关键：`agent.followup(message: UserMessage)` 收的是**消息对象**，不是字符串。
   * 官方真实调用点（从 asar 抄的）：
   *     const message = createUserMessage({ content, source: { kind: 'user' } })
   *     this.agent.followup(message)
   *
   * 取值顺序：
   *   1. `config.createUserMessage` —— **测试注入点**（YAML 里给不了函数，但自测直接调 apply 可以）
   *   2. 官方工厂：裸包名 `@deepseek-ai/dsh-llm` → 宿主 `app.asar` 内的绝对路径
   *
   * ⚠️ 这里踩过一个真坑（A6「双击派活」报 503 `no-message-factory`）：
   * 插件是**从仓库目录按路径挂载**的，而 `@deepseek-ai/dsh-llm` 只存在于**宿主自己的应用包内**
   * （`app.asar/dsh/node_modules/@deepseek-ai/dsh-llm`）。所以从插件所在目录做
   * `import('@deepseek-ai/dsh-llm')` 必然 `ERR_MODULE_NOT_FOUND` —— 派活永远失败。
   *
   * 两层解法：
   *   1. 尽力拿**官方工厂**：config 注入 → 裸包名 → 宿主应用包内绝对路径
   *      （用 `process.resourcesPath` 定位；Electron 主进程可直接 import asar 内文件）。
   *   2. 全都拿不到时用 **`makeUserMessage` 内置兜底** —— 它是对官方实现的逐字复刻
   *      （等价性证据见该函数注释），**不再降级成 503**。
   *
   * 刻意用**动态 import + 缓存**而不是顶层静态 import：解析失败只影响这一条路径，
   * 而不是让整个插件加载失败。
   */
  let userMessageFactory = typeof config.createUserMessage === 'function' ? config.createUserMessage : undefined
  let factorySource = userMessageFactory === undefined ? null : 'config'
  /** 各候选的失败原因，供 `/health` 诊断（整条链路只在首次 /prompt 时走一次） */
  let factoryAttempts = []

  async function loadOfficialFactory() {
    const attempts = []
    const candidates = ['@deepseek-ai/dsh-llm']
    const { resourcesPath } = process
    if (typeof resourcesPath === 'string' && resourcesPath !== '') {
      const rel = 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
      candidates.push(pathToFileURL(join(resourcesPath, 'app.asar', rel)).href)
      candidates.push(pathToFileURL(join(resourcesPath, 'app.asar.unpacked', rel)).href)
    }
    for (const specifier of candidates) {
      try {
        const mod = await import(specifier)
        if (typeof mod.createUserMessage === 'function') {
          return { factory: mod.createUserMessage, source: `module:${specifier}`, attempts }
        }
        attempts.push(`${specifier} → 模块内无 createUserMessage 导出`)
      } catch (error) {
        attempts.push(`${specifier} → ${error?.code ?? 'ERR'} ${error?.message ?? error}`)
      }
    }
    return { factory: null, source: null, attempts }
  }

  async function getUserMessageFactory() {
    if (userMessageFactory !== undefined) return userMessageFactory
    const { factory, source, attempts } = await loadOfficialFactory()
    factoryAttempts = attempts
    if (factory !== null) {
      userMessageFactory = factory
      factorySource = source
      warn(`UserMessage 用官方 createUserMessage：${source}`)
    } else {
      // 绝不返回 503 —— 内置实现与官方等价，派活必须能用
      userMessageFactory = makeUserMessage
      factorySource = 'builtin'
      warn(`拿不到官方 createUserMessage（${attempts.length} 个候选均失败），改用内置等价实现`)
    }
    return userMessageFactory
  }

  register(
    'POST',
    `${pathPrefix}/prompt`,
    async (req, res) => {
      const body = await readJsonBody(req)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') return sendJson(res, 400, { error: 'empty-text' })
      const agent = resolveAgent(body.sessionId)
      if (agent === undefined) {
        return sendJson(res, 503, {
          error: 'no-agent',
          message: 'ctx.agents.get(sessionId) 不可用或 sessionId 缺失',
        })
      }
      // 一定会拿到工厂：官方解析不到就用内置等价实现（见 getUserMessageFactory），不再 503
      const createUserMessage = await getUserMessageFactory()
      const followup = agent.followup ?? agent.steer
      if (typeof followup !== 'function') {
        return sendJson(res, 503, { error: 'no-followup', message: 'agent 未暴露 followup/steer' })
      }
      // 照抄官方调用点：content 是文本块数组，source.kind = 'user'
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      await followup.call(agent, message)
      publish({ type: 'control', action: 'prompt', sessionId: body.sessionId, ok: true })
      return sendJson(res, 200, { ok: true, messageId: message?.id })
    },
    `xilian-pet: POST ${pathPrefix}/prompt`,
  )

  register(
    'POST',
    `${pathPrefix}/interrupt`,
    async (req, res) => {
      const body = await readJsonBody(req)
      const agent = resolveAgent(body.sessionId)
      if (agent === undefined) {
        return sendJson(res, 503, { error: 'no-agent', message: 'ctx.agents.get(sessionId) 不可用' })
      }
      const cancel = agent.cancel ?? agent.interrupt ?? agent.abort
      if (typeof cancel !== 'function') {
        return sendJson(res, 503, { error: 'no-cancel', message: 'agent 未暴露 cancel/interrupt/abort' })
      }
      // 官方签名：cancel(cause: AgentCancelCause, options?)；
      // AgentCancelCause = { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason } | { kind: 'disposed' }
      await cancel.call(agent, { kind: 'user' })
      publish({ type: 'control', action: 'interrupt', sessionId: body.sessionId, ok: true })
      return sendJson(res, 200, { ok: true })
    },
    `xilian-pet: POST ${pathPrefix}/interrupt`,
  )

  // 聚焦会话：Phase 0 未实现（需要 GUI 侧配合），明确返回未实现而不是假装成功
  register(
    'POST',
    `${pathPrefix}/focus`,
    (req, res) =>
      sendJson(res, 501, { error: 'not-implemented', message: 'Phase 0 未实现会话聚焦' }),
    `xilian-pet: POST ${pathPrefix}/focus`,
  )

  // ── A7：主动提醒的定时评估 ────────────────────────────────────────
  // 久坐这类提醒不依赖任何事件到达，必须有定时器才能触发。
  // 30 秒一次：足够及时，又不会让纯函数引擎的调用成为负担。
  const REMINDER_TICK_MS = 30_000
  disposers.push(
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          const result = decideReminders({
            state: reminderState,
            now: Date.now(),
            pendingApprovals: pendingApprovalCount(state),
            hasActivity: hasActivity(state),
            spendBySession: spendBySession(state),
            config: reminderConfig,
          })
          reminderState = result.state
          for (const frame of result.fires) {
            pendingNotices.push(frame)
            if (pendingNotices.length > 20) pendingNotices.shift()
            publish(frame)
          }
        } catch (error) {
          warn(`提醒引擎失败：${error?.message ?? error}`)
        }
      }, REMINDER_TICK_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'xilian-pet: reminders'),
  )

  // 诊断端点：一眼看出提醒引擎的配置、免打扰判定与已发记录
  register(
    'GET',
    `${pathPrefix}/debug/reminders`,
    (req, res) =>
      sendJson(res, 200, {
        config: reminderConfig,
        quietNow: isQuiet(Date.now(), parseQuietHours(reminderConfig.quietHours)),
        tickMs: REMINDER_TICK_MS,
        pendingNotices: pendingNotices.length,
        state: reminderState,
      }),
    `xilian-pet: GET ${pathPrefix}/debug/reminders`,
  )

  // 心跳也放进 ctx.effect —— 官方契约要求资源都经由 ctx.effect/ctx.on 注册，
  // 这样即使宿主不采用 apply 的返回值，插件销毁时它依然会被清理。
  disposers.push(
    ctx.effect(() => {
      const heartbeat = setInterval(() => {
        // 释放被最短保持时间压住的状态切换：没有新事件也要能降档，
        // 否则"运行中 → 空闲"这类降级会永久卡住。
        try {
          const released = releaseHeld(state, Date.now())
          state = released.state
          publishFrames(released.frames)
        } catch (error) {
          ctx.logger?.warn?.(`xilian-pet: releaseHeld failed: ${error?.message ?? error}`)
        }
        for (const res of connections) {
          try {
            res.write(': ping\n\n')
          } catch {
            connections.delete(res)
          }
        }
      }, HEARTBEAT_MS)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()
      return () => clearInterval(heartbeat)
    }, 'xilian-pet: heartbeat'),
  )

  // ── 4. 清理 ────────────────────────────────────────────────────────
  // 上面每个 ctx.effect/ctx.on 的 disposer 已交由框架管理；这里再返回一个清理函数，
  // 是为了兼容"直接调用 apply 并手动销毁"的宿主（本仓的自测就是这么用的）。
  return () => {
    for (const res of connections) {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    }
    connections.clear()
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
  }
}
