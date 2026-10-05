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
  activityLabel,
  createPetState,
  hasActivity,
  normalizeAgentError,
  normalizeAgentStatus,
  normalizeSessionEvent,
  normalizeStreamChunk,
  pendingApprovalCount,
  primarySessionId,
  reduceAgentError,
  reduceAgentStatus,
  reducePetEvent,
  reduceStreamChunk,
  releaseHeld,
  setSessionTitle,
  setTokenTotals,
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
 * 而 `resolveAgentTarget()` 里那句 `agents === undefined` 的兜底**根本执行不到** ——
 * 异常在"取属性"那一步就抛了。
 *
 * 它还解释了"自测 62 项全绿、真机却失败"：mock ctx 把 `agents` 当普通属性发，
 * 没复现 inject 校验。mock 已按真实语义收紧（见 `tools/check-plugin.mjs`），
 * 并补了静态扫描 + 负向对照，防止再犯。
 *
 * `sessionController` 是派活链路里第二个必需服务：`ctx.agents.get()` 只找**活着的** agent，
 * 会话不活跃时必然拿不到；要靠 `ctx.sessionController.agents.resolveAgent()` 解析/恢复
 * （也是 GUI 提交消息走的那条路）。详见 `resolveAgentTarget`。
 *
 * `sessions` 是第三个：插件"知道哪些会话"不能只靠自己观测到的事件 ——
 * **DSH 刚重启时插件还没观测到任何会话**，那个空窗期里派活必然失败。
 * `ctx.sessions.list()`（官方："All live sessions, in creation order"）用来兜掉这个盲区。
 */
export const inject = ['webServer', 'agents', 'sessions', 'sessionController', 'sessionProjections']

const PROTOCOL_VERSION = 1
const HEARTBEAT_MS = 15_000

/**
 * 代码修订号 —— **每次改本文件 / reducer.js / reminders.js 都要 +1**。
 * 目的：`/health` 会带上它，于是"改动到底有没有被加载"一眼可判：
 *   重启后 code 变大 = 新代码生效；code 没变 = 改的代码没被加载。
 * （注：`hmr.root` 实测无效，源码热重载不可用，只能靠重启。）
 */
const CODE_REVISION = 23

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
  /**
   * 气泡显示什么：
   *  - `'activity'`（默认）—— 只显示**一句人话**的活动摘要（"执行了命令""已完成分析"…），
   *    见 reducer.js 的 activityLabel()。用户反馈：直接灌 AI 正文输出太多，根本看不清。
   *  - `'stream'` —— 老的逐字流行为（把 AI 正文的尾巴放进气泡），留着调试用。
   */
  const bubbleMode = config.bubbleMode === 'stream' ? 'stream' : 'activity'
  /** 上一次推给气泡的摘要（按会话去重，避免同一步骤刷屏） */
  const lastActivity = new Map()

  // A7 主动提醒
  const reminderConfig = mergeReminderConfig(config.reminders)
  let reminderState = createReminderState()
  /** 迟到的提醒：窗口没连时发出的提醒不能丢，等它连上补发 */
  const pendingNotices = []

  let state = createPetState({ minHoldMs })
  const connections = new Set()
  /**
   * sessionId → 宿主给的 session 对象。
   * 读 tokenUsage 投影要用它当 key（投影内部是**以 session 对象为键的 WeakMap**，
   * 拿 sessionId 字符串是查不到的）。
   */
  const sessionObjects = new Map()
  // 形状样本：**按 channel 分别限量**，不是全局环形缓冲。
  // 踩过的坑：全局环形会被高频通道刷爆 —— agent/assistant-stream 每个 token 一帧，
  // 实测 80 条样本全被它占满，session/event 与 agent/status 的样本全被挤出去，
  // 于是"想确认某类事件到底收到没有"根本查不到。
  const rawShapes = new Map()
  const startedAt = Date.now()

  function publish(frame) {
    // 统一补上"当前主会话"再发出去。
    // 为什么需要：渲染端只在 SSE `snapshot` 里学到 sessionId，而 DSH 刚重启时 /state 是空的
    // —— 窗口先连上、会话后出现，它手上的 sessionId 就一直是 undefined（派活必失败）。
    // 在这里补，渲染端不必自己猜，也能从任何一帧里学会。
    if (frame !== null && typeof frame === 'object' && (frame.type === 'state' || frame.type === 'control')) {
      frame = { ...frame, primarySessionId: primarySessionId(state) ?? null }
    }
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

  /**
   * ── 审批应答者实验（探针）──────────────────────────────────────────
   *
   * 目的：确认"**插件能不能在 `approval/request` waterfall 上注册应答者，而不挡住 GUI 的审批提示**"。
   * 宿主那条链路（`ApprovalService.decide()`）是：
   *     ctx.waterfall(scopeTarget(agent, agent), 'approval/request', req, () => 'unavailable')
   * 结果 fail-closed：没人返回 `'allowed-once'` 就不放行。
   *
   * ⚠️ **探针永远只观察、永远 `next()` 交棒**，绝不返回任何决定 ——
   *    所以它**不可能**放行/拒绝真实操作，也**不可能**改变 fail-closed 语义。
   *    "真正通过桌宠同意"要等实验结论出来再谈。
   *
   * ⚠️ **默认完全不注册**（连 `ctx.on` 都不调）：只有显式打开才挂上去，
   *    杜绝"实验代码常驻链路"这种最危险的情况。
   */
  const approvalProbe = { enabled: false, delayMs: 0, prepend: false, seen: [], disposer: null }

  /** 探针应答者：记录 → 可选延迟 → **一律交棒** */
  async function approvalProbeListener(req, next) {
    // 记下**完整字段**：桌宠要显示"你在批准什么"，就必须知道 req 里有没有命令原文。
    // 只记 toolName/reason/callId 是不够的 —— 那样批准等于盲批。
    let sample = null
    try {
      sample = JSON.stringify(req, (_k, v) => (typeof v === 'bigint' ? String(v) : v))?.slice(0, 600) ?? null
    } catch {
      sample = '(无法序列化)'
    }
    const entry = {
      at: Date.now(),
      toolName: typeof req?.toolName === 'string' ? req.toolName : null,
      reason: typeof req?.reason === 'string' ? req.reason : null,
      callId: typeof req?.callId === 'string' ? req.callId : null,
      keys: req !== null && typeof req === 'object' ? Object.keys(req) : [],
      sample,
      delayMs: approvalProbe.delayMs,
    }
    approvalProbe.seen.push(entry)
    if (approvalProbe.seen.length > 20) approvalProbe.seen.shift()
    warn(`[审批探针] 收到 approval/request：${entry.toolName ?? '(无工具名)'}；${entry.delayMs}ms 后交棒`)
    if (approvalProbe.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, approvalProbe.delayMs))
      entry.releasedAt = Date.now()
      warn(`[审批探针] 延迟 ${entry.delayMs}ms 到期，交棒给下一个应答者`)
    }
    return next() // 关键：不返回任何决定，交给链路上的下一个应答者（GUI）
  }

  /** 开关探针：enable 才注册；disable 立刻注销，链路恢复原样。 */
  function setApprovalProbe({ enabled, delayMs, prepend }) {
    if (Number.isFinite(delayMs)) approvalProbe.delayMs = Math.max(0, Math.min(10_000, Math.round(delayMs)))
    if (typeof prepend === 'boolean') approvalProbe.prepend = prepend
    if (enabled === true && approvalProbe.disposer === null) {
      // waterfall 的注册方式与普通事件一样是 ctx.on；监听器收到 (…args, next)，next() 交棒。
      //
      // ⚠️ `prepend: true` 是**本实验的关键**：实测（code 20, delayMs=0）发现
      //    我们的应答者**一次都没被调用** —— 因为排在链路上前面的是"转发给 GUI 的桥"，
      //    它 await 用户在界面上的答复并返回决定，**链路就此结束**，轮不到后面的我们。
      //    真实事件为证：approval/asked(seq 7333) → approval/decided(seq 7334, allowed-once)，
      //    而探针 seen=0。只有抢到最前面，才谈得上"由桌宠来答"。
      approvalProbe.disposer = ctx.on(
        'approval/request',
        approvalProbeListener,
        approvalProbe.prepend ? { prepend: true } : undefined,
      )
      approvalProbe.enabled = true
      warn(
        `[审批探针] 已启用（prepend=${approvalProbe.prepend}，延迟 ${approvalProbe.delayMs}ms 后交棒）；永远只观察、不做决定`,
      )
    } else if (enabled === false && approvalProbe.disposer !== null) {
      approvalProbe.disposer()
      approvalProbe.disposer = null
      approvalProbe.enabled = false
      warn('[审批探针] 已停用，链路恢复原样')
    }
    return {
      enabled: approvalProbe.enabled,
      delayMs: approvalProbe.delayMs,
      prepend: approvalProbe.prepend,
      seen: approvalProbe.seen.length,
    }
  }

  // ── 审批：由桌宠同意 ────────────────────────────────────────────────
  //
  // 实机实验结论（见 docs/交接说明.md 的"审批实验"一节）：
  //  · 宿主 `ApprovalService.decide()` 走 `approval/request` waterfall，fail-closed，
  //    `'allowed-once'` 是唯一的放行值；
  //  · **plain 注册轮不到我们** —— 链路前面是"转发给 GUI 的桥"，它 await 用户答复就结束了；
  //    必须 `{ prepend: true }` 抢到最前面（实测 approval/asked 与探针收到只差 1ms）；
  //  · 链路是**顺序**的：我们"持着"请求时 GUI 不会弹提示 → 所以必须能交棒。
  //
  // ⚠️ 默认**关闭**（`config.approval.viaPet`）：不主动改变 DSH 原本的审批行为。
  const approvalConfig = config.approval ?? {}
  const approvalViaPet = approvalConfig.viaPet === true
  const approvalTimeoutMs = Math.max(
    1_000,
    Math.min(300_000, Number.isFinite(approvalConfig.timeoutMs) ? approvalConfig.timeoutMs : 60_000),
  )

  /** 最近 tool/call 的留存（callId → 命令）——审批请求里**没有命令原文**，只能这样关联 */
  const recentToolCalls = new Map()
  const TOOLCALL_KEEP = 50

  /** 待决审批（id → 交卷函数）。桌宠点"允许/拒绝"或超时后从这里 resolve。 */
  const pendingApprovals = new Map()
  let approvalSeq = 0

  function rememberToolCall(ev) {
    if (ev.kind !== 'tool/call') return
    const callId = ev.data?.callId
    if (typeof callId !== 'string' || callId === '') return
    recentToolCalls.set(callId, {
      name: typeof ev.data?.name === 'string' ? ev.data.name : undefined,
      // arguments 是 JSON 字符串，形如 {"command": "…"}
      arguments: typeof ev.data?.arguments === 'string' ? ev.data.arguments : undefined,
      at: Date.now(),
    })
    // 只留最近若干个，别无限涨
    while (recentToolCalls.size > TOOLCALL_KEEP) {
      const oldest = recentToolCalls.keys().next().value
      recentToolCalls.delete(oldest)
    }
  }

  /** 用 callId 反查"这条审批到底要执行什么" */
  function commandOf(callId) {
    const rec = recentToolCalls.get(callId)
    if (rec === undefined) return { toolName: undefined, command: undefined }
    let command
    if (typeof rec.arguments === 'string') {
      try {
        const parsed = JSON.parse(rec.arguments)
        // 常见字段名；取不到就把整串原样（截断后）显示，总比不给看好
        const picked = parsed?.command ?? parsed?.cmd ?? parsed?.script
        command = typeof picked === 'string' ? picked : rec.arguments
      } catch {
        command = rec.arguments
      }
    }
    return { toolName: rec.name, command }
  }

  /**
   * 审批应答者。返回值必须是 `'allowed-once'` / `'rejected'` 之一，
   * 或者 `next()` 交棒给下一个应答者（GUI）。
   */
  async function approvalAnswerer(req, next) {
    // ① 功能没开 / 桌宠没连上 → **立刻交棒**：行为与启用前完全一致，绝不把审批卡死
    if (!approvalViaPet || connections.size === 0) return next()

    const id = `ap-${(approvalSeq += 1)}`
    const { toolName, command } = commandOf(req?.callId)
    const frame = {
      type: 'approval',
      id,
      sessionId: typeof req?.agent?.session?.id === 'string' ? req.agent.session.id : null,
      toolName: toolName ?? (typeof req?.toolName === 'string' ? req.toolName : null),
      command: typeof command === 'string' ? command : null,
      reason: typeof req?.reason === 'string' ? req.reason : null,
      timeoutMs: approvalTimeoutMs,
    }
    warn(`[审批] 交给桌宠决定：${frame.toolName ?? '(未知工具)'}（${approvalTimeoutMs}ms 后超时交棒给 GUI）`)
    publish(frame)

    // ② 等桌宠点"允许/拒绝"；到点没点 → 超时
    const decision = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id)
        warn(`[审批] ${id} 超时（${approvalTimeoutMs}ms）→ 交棒给 GUI`)
        resolve('timeout')
      }, approvalTimeoutMs)
      pendingApprovals.set(id, {
        frame, // 留着：桌宠晚连上时要能补发（见 pendingApprovalFrames）
        settle: (value) => {
          clearTimeout(timer)
          pendingApprovals.delete(id)
          resolve(value)
        },
      })
    })

    publish({ type: 'approval-resolved', id, decision })
    if (decision === 'allow') {
      warn(`[审批] ${id} 桌宠放行 → allowed-once`)
      return 'allowed-once'
    }
    if (decision === 'deny') {
      warn(`[审批] ${id} 桌宠拒绝 → rejected`)
      return 'rejected'
    }
    return next() // 超时/无人应答：交棒，让 GUI 的提示接管
  }

  if (approvalViaPet) {
    // ⚠️ 注册在下面的 disposers 区（这里只留注释，避免重复注册 + TDZ）
  }

  /** 桌宠点了"允许/拒绝" → POST /approval 走这里 */
  function resolveApproval(id, decision) {
    const entry = pendingApprovals.get(id)
    if (entry === undefined) return false
    entry.settle(decision)
    return true
  }

  /** 当前待决的审批帧 —— 桌宠晚连上时和 snapshot 一起补发，否则它会一直看不到 */
  function pendingApprovalFrames() {
    return [...pendingApprovals.values()].map((entry) => entry.frame)
  }

  /** 观测 session/event。真实签名是 (session, event) 两个参数。 */
  function observeSession(session, event) {
    try {
      noteRawShape('session/event', { sessionId: session?.id, event })
      // 存一下 session 对象：读宿主 tokenUsage 投影要用它当 key（WeakMap 以对象为键）
      if (typeof session?.id === 'string' && session.id !== '') sessionObjects.set(session.id, session)
      const ev = normalizeSessionEvent(session, event)
      if (ev === null) return
      // 审批要用 callId 反查命令，所以 tool/call 得留一份（请求里没有命令原文）
      rememberToolCall(ev)
      const result = reducePetEvent(state, ev, Date.now())
      state = result.state
      // 状态帧里带 token 数字（右键菜单要用），所以发之前先刷一次宿主的权威值
      syncAuthoritativeTokens()
      publishFrames(result.frames)
      publishActivity(ev)
    } catch (error) {
      warn(`observe(session/event) failed: ${error?.message ?? error}`)
    }
  }

  /**
   * 读**宿主权威**的 tokenUsage 四桶（durable projection：从会话日志重放，DSH 重启不丢）。
   *
   * 读不到就返回 `undefined`，由调用方退回插件自己累加的值 —— 所以这是个**纯增强**：
   * 宿主换了版本、投影没注册、或我们没拿到 session 对象，都不会把宠物带崩。
   * `stateOf` 内部只是一次 WeakMap 查表，很便宜。
   */
  function authoritativeBuckets(sessionId) {
    const session = sessionObjects.get(sessionId)
    if (session === undefined) return undefined
    try {
      const cell = ctx.sessionProjections.stateOf(session, 'tokenUsage')
      return cell?.totals ?? undefined
    } catch (error) {
      warn(`读宿主 tokenUsage 投影失败（本会话退回自算值）：${error?.message ?? error}`)
      return undefined
    }
  }

  /** 把宿主权威数字刷进 state（幂等）。在"数字要被用到"之前调用即可，不必每事件都刷。 */
  function syncAuthoritativeTokens() {
    for (const sessionId of Object.keys(state.sessions)) {
      const buckets = authoritativeBuckets(sessionId)
      if (buckets !== undefined) state = setTokenTotals(state, sessionId, buckets)
    }
  }

  /**
   * 从宿主拉**权威会话标题**。
   *
   * 为什么必须拉：插件原来只能从事件里捡 title，但实测 45 条 `session/event` 样本
   * **一条都没带 title** —— 于是操作面板里显示成 `session-5f19636e-…`（用户实测反馈"标题有问题"）。
   *
   * 宿主的 `sessionController.list()` 返回的正是 GUI 列表用的那份摘要，字段是
   * `displayTitle = displayTitleOf(title, cwd, sessionId)` —— 和 GUI 里看到的是同一个名字。
   *
   * 读不到**不报错**：标题保持原样（退回显示 sessionId，面板不能因此崩）。
   */
  /**
   * 读**宿主投影**里的会话标题。
   *
   * 宿主把标题实现成一个 key 为 `title` 的 session projection：
   *     const titleProjectionDefinition = {
   *       key: "title",
   *       stateSchema: z.string().min(1).nullable(),
   *       apply: (state, event) => event.type === "session/title" ? event.data.title : state,
   *     }
   * 也就是**状态本身就是标题字符串**，与 tokenUsage 同一机制：从会话日志重放、重启不丢。
   *
   * ⚠️ **不要走 `sessionController.list()`**（第一版就是这么错的）：
   * 它返回的 item 字段实测是
   * `["sessionId","updatedAt","agentAvailable","running","blank","cwd","projections"]`
   * —— **没有 title / displayTitle**，所以标题一直空、面板只能显示 sessionId。
   * 宿主显示层的 `displayTitle` 是从 `projectionValues?.title` 派生的，不是 list() 给的。
   */
  function sessionTitleOf(sessionId) {
    const session = sessionObjects.get(sessionId)
    if (session === undefined) return undefined
    try {
      const title = ctx.sessionProjections.stateOf(session, 'title')
      return typeof title === 'string' && title !== '' ? title : undefined
    } catch (error) {
      warn(`读宿主 title 投影失败（面板退回显示 sessionId）：${error?.message ?? error}`)
      return undefined
    }
  }

  /** 把所有已知会话的权威标题刷进 state（幂等；纯同步查表，很便宜） */
  function syncTitles() {
    for (const sessionId of Object.keys(state.sessions)) {
      const title = sessionTitleOf(sessionId)
      if (title !== undefined) state = setSessionTitle(state, sessionId, title)
    }
  }

  /**
   * 把事件压成一句活动摘要推给气泡（`bubbleMode: 'activity'` 时）。
   * 去重：同一条摘要连着来（例如连续两次 tool/result）不重复推，省得刷屏。
   */
  function publishActivity(ev) {
    if (bubbleMode !== 'activity') return
    const text = activityLabel(ev)
    if (text === null) return
    const key = ev.sessionId ?? 'unknown'
    if (lastActivity.get(key) === text) return
    lastActivity.set(key, text)
    publish({ type: 'activity', sessionId: key, text, kind: ev.kind })
  }

  /** 观测 agent/assistant-stream。真实签名是 ({ agent, frame }) 一个对象。 */
  function observeStream(payload) {
    try {
      noteRawShape('agent/assistant-stream', { agentId: payload?.agent?.id, frameType: payload?.frame?.type })
      const chunk = normalizeStreamChunk(payload)
      if (chunk === null) return
      const result = reduceStreamChunk(state, chunk, Date.now())
      state = result.state
      // activity 模式下**不把 AI 正文推进气泡**（那是用户明确要改掉的噪音）；
      // 状态帧照发，tail 也只是留在 /state 里供诊断。
      publishFrames(
        bubbleMode === 'stream' ? result.frames : result.frames.filter((f) => f.type !== 'stream'),
      )
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
  // "由桌宠同意"的审批应答者。⚠️ 注册写在这里而不是定义处 —— `disposers` 在下面才声明，
  // 定义处直接 push 会踩 TDZ（实测报 Cannot access 'disposers' before initialization）。
  if (approvalViaPet) {
    // prepend：必须抢在"转发给 GUI 的桥"前面，否则永远轮不到我们（实机实验结论）
    disposers.push(ctx.on('approval/request', approvalAnswerer, { prepend: true }))
    warn(`[审批] 已启用"由桌宠同意"（超时 ${approvalTimeoutMs}ms；没连桌宠时立刻交棒给 GUI）`)
  }

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
    (req, res) => {
      syncAuthoritativeTokens() // 数字要被用到了，先把宿主的权威值刷进来
      syncTitles() // 标题同理（面板里显示的就是它；不刷就只有 sessionId）
      return sendJson(res, 200, { ...snapshot(state), approvals: pendingApprovalFrames() })
    },
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

  /**
   * 桌宠点了「允许 / 拒绝」→ 这里交卷。
   *
   * body: `{ id, decision: 'allow' | 'deny' }`
   * - 找不到 id（超时了、或 DSH 重启过）→ 404，桌宠那边把卡片收掉即可
   */
  register(
    'POST',
    `${pathPrefix}/approval`,
    async (req, res) => {
      const body = await readJsonBody(req)
      const id = typeof body?.id === 'string' ? body.id : ''
      const decision = body?.decision === 'allow' ? 'allow' : body?.decision === 'deny' ? 'deny' : null
      if (id === '' || decision === null) return sendJson(res, 400, { error: 'bad-request' })
      if (!resolveApproval(id, decision)) return sendJson(res, 404, { error: 'no-pending-approval', id })
      return sendJson(res, 200, { ok: true, id, decision })
    },
    `xilian-pet: POST ${pathPrefix}/approval`,
  )

  /**
   * 审批应答者实验的开关（**只有显式打开才会注册到 `approval/request` 链路上**）。
   *
   * - `POST { enabled: true, delayMs?: 0..10000 }` → 挂上探针（只观察 + 交棒）
   * - `POST { enabled: false }` → 立刻注销，链路恢复原样
   * - 读状态走只读诊断 `GET /debug/agents` 的 `approvalProbe` 字段
   *   （路由表按**路径**去重，所以同路径不能再注册一个 GET）
   *
   * 探针**永远不返回决定**，所以它不会放行/拒绝任何真实操作。
   */
  register(
    'POST',
    `${pathPrefix}/debug/approval-probe`,
    async (req, res) => {
      const body = await readJsonBody(req)
      const out = setApprovalProbe({
        enabled: body?.enabled === true,
        delayMs: Number(body?.delayMs),
        prepend: typeof body?.prepend === 'boolean' ? body.prepend : undefined,
      })
      return sendJson(res, 200, { ok: true, ...out, seen: approvalProbe.seen })
    },
    `xilian-pet: POST ${pathPrefix}/debug/approval-probe`,
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
      syncAuthoritativeTokens()
      syncTitles() // 标题同理（面板第一次打开就走这条）
      // 待决审批也一起补发：桌宠可能是审批发生之后才连上的
      res.write(sseData({ type: 'snapshot', ...snapshot(state), approvals: pendingApprovalFrames() }))
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
   * 解析派活/打断的目标 agent。**两级，缺一不可**：
   *
   *  1. `ctx.agents.get(id)` —— **只找"活着的" agent**。
   *     注册表实现是 `get(id) { return this.store.get(id)?.agent }`，
   *     而 store 里只放 **entered**（活着）的条目，被 detach 就删掉。
   *     所以**会话不活跃时这里必然返回 undefined** —— 这正是 A6 第三、四次真机失败的原因：
   *     我们手上那个 sessionId 完全正确（`/state` 里就是它），但那一刻没有活着的 agent。
   *
   *  2. `ctx.sessionController.agents.resolveAgent(id)` —— **解析"或恢复"** 会话的 agent。
   *     官方注释：`Owns every operation that may create, resume, or configure a Web Agent`、
   *     `Resolve or resume one ordinary Session, deduplicating concurrent resumes`。
   *     返回 `{ agent }` 或 `{ error }`。
   *     **这也是 GUI 提交消息走的同一条路** —— 宿主把 typert 的 'agent' lookup 换成了它
   *     （`lookups.configure('agent', … resolveAgent …)`，见 sessionController 的构造函数）。
   *     所以"派活给一个不活跃的会话"本来就该走这里，而不是 `agents.get()`。
   *
   * 另外渲染端可能根本没给 id，所以候选里始终带上 `primarySessionId(state)`。
   *
   * ⚠️ 但**只靠自己观测到的事件是不够的**（A6 第五次真机失败）：
   * 插件"知道有哪些会话"完全来自它观测到的事件，而 **DSH 刚重启时它一个会话都还没观测到** ——
   * 那个空窗期里候选为空，直接 503 `no-session-known`（用户在重启后立刻点了派活）。
   * 所以再兜一层**直接问宿主**：`ctx.sessions.list()`（官方注释 "All live sessions,
   * in creation order"）与 `ctx.agents.list()`（活着的 agent = 正在干活的会话，优先）。
   */
  function hostSessionIds() {
    const ids = []
    const push = (id) => {
      if (typeof id === 'string' && id !== '' && id !== 'unknown' && !ids.includes(id)) ids.push(id)
    }
    // ① 活着的 agent —— 正在干活的会话，最可能就是你要派活的那个
    try {
      for (const agent of ctx.agents?.list?.() ?? []) push(agent?.id ?? agent?.session?.id)
    } catch {
      /* 服务不可用就算了，继续用下面的 */
    }
    // ② 宿主的活会话清单（创建顺序）→ 最近创建的排在前面
    try {
      const sessions = ctx.sessions?.list?.() ?? []
      for (const s of [...sessions].reverse()) push(s?.id)
    } catch {
      /* 同上 */
    }
    return ids
  }

  async function resolveAgentTarget(sessionId) {
    const known = Object.values(state.sessions).map((s) => s.sessionId)
    const requested = sessionId ?? null
    // 候选顺序：渲染端给的 → 插件观测到的主会话 → 宿主知道的会话（兜盲区）
    const candidates = []
    const push = (c) => {
      if (typeof c === 'string' && c !== '' && c !== 'unknown' && !candidates.includes(c) && candidates.length < 5) {
        candidates.push(c)
      }
    }
    push(sessionId)
    push(primarySessionId(state))
    for (const id of hostSessionIds()) push(id)

    if (candidates.length === 0) {
      return { agent: undefined, requested, tried: [], knownSessions: known, reason: 'no-session-known' }
    }

    // ① 活着的 agent（快路径，无副作用）
    for (const id of candidates) {
      let live
      try {
        live = ctx.agents?.get?.(id)
      } catch {
        continue
      }
      if (live !== undefined) {
        return { agent: live, sessionId: id, requested, via: 'live', fallbackUsed: id !== sessionId }
      }
    }

    // ② 请 sessionController 解析/恢复（不活跃的会话靠这一步拉起来）
    const resume = ctx.sessionController?.agents?.resolveAgent
    const errors = []
    if (typeof resume === 'function') {
      for (const id of candidates) {
        try {
          const found = await resume.call(ctx.sessionController.agents, id)
          if (found !== null && typeof found === 'object' && found.agent !== undefined) {
            return { agent: found.agent, sessionId: id, requested, via: 'resume', fallbackUsed: id !== sessionId }
          }
          errors.push(`${id} → ${found?.error?.message ?? 'resolveAgent 未返回 agent'}`)
        } catch (error) {
          errors.push(`${id} → ${error?.message ?? error}`)
        }
      }
    } else {
      errors.push('ctx.sessionController.agents.resolveAgent 不可用')
    }
    return {
      agent: undefined,
      requested,
      tried: candidates,
      knownSessions: known,
      hostSessions: hostSessionIds(),
      resolveErrors: errors,
      reason: 'not-resolvable',
    }
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
      const target = await resolveAgentTarget(body.sessionId)
      if (target.agent === undefined) {
        return sendJson(res, 503, {
          error: 'no-agent',
          message: `没有可派活的 agent（${target.reason}）`,
          requestedSessionId: target.requested,
          triedSessionIds: target.tried ?? [],
          knownSessions: target.knownSessions ?? [],
          resolveErrors: target.resolveErrors ?? [],
          reason: target.reason,
        })
      }
      const agent = target.agent
      // 一定会拿到工厂：官方解析不到就用内置等价实现（见 getUserMessageFactory），不再 503
      const createUserMessage = await getUserMessageFactory()
      const followup = agent.followup ?? agent.steer
      if (typeof followup !== 'function') {
        return sendJson(res, 503, { error: 'no-followup', message: 'agent 未暴露 followup/steer' })
      }
      // 照抄官方调用点：content 是文本块数组，source.kind = 'user'
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      await followup.call(agent, message)
      publish({ type: 'control', action: 'prompt', sessionId: target.sessionId, ok: true })
      return sendJson(res, 200, {
        ok: true,
        messageId: message?.id,
        sessionId: target.sessionId,
        via: target.via,
        fallbackUsed: target.fallbackUsed === true,
      })
    },
    `xilian-pet: POST ${pathPrefix}/prompt`,
  )

  register(
    'POST',
    `${pathPrefix}/interrupt`,
    async (req, res) => {
      const body = await readJsonBody(req)
      const target = await resolveAgentTarget(body.sessionId)
      if (target.agent === undefined) {
        return sendJson(res, 503, {
          error: 'no-agent',
          message: `没有可打断的 agent（${target.reason}）`,
          requestedSessionId: target.requested,
          triedSessionIds: target.tried ?? [],
          knownSessions: target.knownSessions ?? [],
          resolveErrors: target.resolveErrors ?? [],
          reason: target.reason,
        })
      }
      const agent = target.agent
      const cancel = agent.cancel ?? agent.interrupt ?? agent.abort
      if (typeof cancel !== 'function') {
        return sendJson(res, 503, { error: 'no-cancel', message: 'agent 未暴露 cancel/interrupt/abort' })
      }
      // 官方签名：cancel(cause: AgentCancelCause, options?)；
      // AgentCancelCause = { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason } | { kind: 'disposed' }
      await cancel.call(agent, { kind: 'user' })
      publish({ type: 'control', action: 'interrupt', sessionId: target.sessionId, ok: true })
      return sendJson(res, 200, { ok: true, sessionId: target.sessionId, via: target.via, fallbackUsed: target.fallbackUsed === true })
    },
    `xilian-pet: POST ${pathPrefix}/interrupt`,
  )

  /**
   * ⚠️ 2026-10-05：**`POST /read`（标记已读）已随"未读功能整体移除"一起删掉**。
   *    用户决策："把未读功能去除"。
   *    去掉了：插件侧的 `unread` 统计、`markRead()`、这里的路由，
   *    以及渲染端的 `+N` 背板和"单击清未读"。
   *    单击现在只做**分区互动**（点秋千 = 弹一下），不再有"清未读"这层副作用 ✓
   */

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
          syncAuthoritativeTokens() // "花销"提醒要用到 token 数，先刷权威值
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

  /**
   * 诊断端点：**派活链路到底卡在哪一环**。
   *
   * 为什么需要：A6 连撞五个 bug，每轮都只能靠"用户点一下 → 气泡里一句话"来定位，
   * 来回代价很高。这个端点是**只读**的，能在不派活、不打断、不污染会话的前提下，
   * 把候选会话、活 agent、各候选能否 `get()` 到、`resolveAgent` 是否可用全列出来。
   *
   * ⚠️ 只有显式传 `?resolve=<sessionId>` 时才会真的调 `resolveAgent` ——
   * 那个调用按官方语义会**解析/恢复**该会话的 agent（有副作用），所以必须显式要求。
   */
  register(
    'GET',
    `${pathPrefix}/debug/agents`,
    async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const observed = Object.values(state.sessions).map((s) => s.sessionId)
      const host = hostSessionIds()
      const candidates = [...new Set([...observed, ...host])].slice(0, 5)
      const liveLookup = {}
      for (const id of candidates) {
        try {
          liveLookup[id] = ctx.agents?.get?.(id) !== undefined
        } catch (error) {
          liveLookup[id] = `error: ${error?.message ?? error}`
        }
      }
      let liveAgentIds = null
      try {
        liveAgentIds = (ctx.agents?.list?.() ?? []).map((a) => a?.id ?? a?.session?.id)
      } catch {
        liveAgentIds = 'unavailable'
      }
      const out = {
        observedSessions: observed,
        primarySessionId: primarySessionId(state) ?? null,
        hostSessions: host,
        liveAgentIds,
        liveLookup,
        resolveAgentAvailable: typeof ctx.sessionController?.agents?.resolveAgent === 'function',
      }
      const wantResolve = url.searchParams.get('resolve')
      if (typeof wantResolve === 'string' && wantResolve !== '') {
        try {
          const found = await ctx.sessionController.agents.resolveAgent(wantResolve)
          out.resolve = {
            id: wantResolve,
            ok: found?.agent !== undefined,
            error: found?.error?.message ?? null,
            via: found?.agent === undefined ? null : 'resolveAgent',
          }
        } catch (error) {
          out.resolve = { id: wantResolve, ok: false, error: String(error?.message ?? error) }
        }
      }
      // 标题的**真实来源**：key 为 `title` 的 session projection（见 sessionTitleOf 注释）。
      // 这里顺便把每个会话读到的标题打出来 —— 标题不对时一眼能定位。
      out.titles = Object.fromEntries(observed.map((id) => [id, sessionTitleOf(id) ?? null]))
      // 审批应答者实验的状态（开关走 POST /debug/approval-probe）
      out.approvalProbe = {
        enabled: approvalProbe.enabled,
        prepend: approvalProbe.prepend,
        delayMs: approvalProbe.delayMs,
        seen: approvalProbe.seen,
      }
      // 会话列表摘要的**真实结构**（`?list=1` 才拉）。
      // 曾经以为标题在这里（items[].displayTitle），实测**没有这个字段** —— 留在这里备查。
      if (url.searchParams.get('list') === '1') {
        try {
          const listed = await ctx.sessionController.list()
          out.list = {
            count: Array.isArray(listed?.items) ? listed.items.length : 0,
            keys: Array.isArray(listed?.items) && listed.items.length > 0 ? Object.keys(listed.items[0]) : [],
            items: (listed?.items ?? []).slice(0, 5).map((it) => ({
              id: it?.id ?? it?.sessionId ?? null,
              displayTitle: it?.displayTitle ?? null,
              title: it?.title ?? null,
              running: it?.running ?? null,
              updatedAt: it?.updatedAt ?? null,
            })),
          }
        } catch (error) {
          out.list = { error: String(error?.message ?? error) }
        }
      }
      return sendJson(res, 200, out)
    },
    `xilian-pet: GET ${pathPrefix}/debug/agents`,
  )

  /**
   * 调试端点：**手动放一条通知**。
   *
   * 为什么需要：A7 的显示侧（冒泡 + 单击跳转）只有"审批积压"这类事件才会触发，
   * 想真等一次几乎不可控 —— 那就等于没法验证。这里给个开关，随手就能看效果。
   * body（都可省）：`{ text?, urgent?, notice? }`
   */
  register(
    'POST',
    `${pathPrefix}/debug/notice`,
    async (req, res) => {
      const body = await readJsonBody(req)
      const frame = {
        type: 'notice',
        notice: typeof body.notice === 'string' && body.notice !== '' ? body.notice : 'debug',
        text:
          typeof body.text === 'string' && body.text !== '' ? body.text : '有 2 个操作在等你审批',
        urgent: body.urgent !== false,
        at: Date.now(),
      }
      // 与真实提醒走同一条路：入队（供重连补发）+ 立即推送
      pendingNotices.push(frame)
      if (pendingNotices.length > 20) pendingNotices.shift()
      publish(frame)
      return sendJson(res, 200, { ok: true, frame, subscribers: connections.size })
    },
    `xilian-pet: POST ${pathPrefix}/debug/notice`,
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
