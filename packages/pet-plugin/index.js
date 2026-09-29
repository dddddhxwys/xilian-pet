/**
 * 西莲桌宠 · DSH Host 插件
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

import {
  createPetState,
  normalizeSessionEvent,
  normalizeStreamChunk,
  reducePetEvent,
  reduceStreamChunk,
  releaseHeld,
  snapshot,
} from './reducer.js'

export const name = 'xilian-pet'

/** 需要 webServer 服务就绪后才注册路由 */
export const inject = ['webServer']

const PROTOCOL_VERSION = 1
const HEARTBEAT_MS = 15_000

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

  let state = createPetState({ minHoldMs })
  const connections = new Set()
  const rawShapes = []
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
    if (captureRawShapes <= 0 || rawShapes.length >= captureRawShapes * 4) return
    let preview
    try {
      preview = JSON.stringify(raw).slice(0, 400)
    } catch {
      preview = '<unserializable>'
    }
    rawShapes.push({
      channel,
      at: Date.now(),
      keys: raw !== null && typeof raw === 'object' ? Object.keys(raw) : typeof raw,
      preview,
    })
    if (rawShapes.length > captureRawShapes * 4) rawShapes.splice(0, rawShapes.length - captureRawShapes * 4)
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
        pid: process.pid,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        subscribers: connections.size,
        state: state.current,
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
    (req, res) => sendJson(res, 200, { count: rawShapes.length, shapes: rawShapes.slice(-captureRawShapes) }),
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
      connections.add(res)
      res.on('close', () => connections.delete(res))
    },
    `xilian-pet: GET ${pathPrefix}/events (SSE)`,
  )

  // ── 3. 反向操控 ────────────────────────────────────────────────────
  function resolveAgent(sessionId) {
    const agents = ctx.agents
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    if (sessionId === undefined) return undefined
    return agents.get(sessionId)
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
          message: 'ctx.agents.get(sessionId) 不可用或 sessionId 缺失；反向操控待接线',
        })
      }
      const followup = agent.followup ?? agent.steer
      if (typeof followup !== 'function') {
        return sendJson(res, 503, { error: 'no-followup', message: 'agent 未暴露 followup/steer' })
      }
      await followup.call(agent, text)
      publish({ type: 'control', action: 'prompt', sessionId: body.sessionId, ok: true })
      return sendJson(res, 200, { ok: true })
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
      await cancel.call(agent)
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
