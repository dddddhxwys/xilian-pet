/**
 * 主动提醒策略引擎 —— 纯函数，零依赖，可脱离 DSH 单测。
 *
 * A7 的插件侧：判断"什么时候该提醒你什么"，产出 notice 帧。
 * 显示部分在 Electron 侧（当前冻结中），所以这里只管决策。
 *
 * 设计要点：
 *  1. **分级**：审批积压是 urgent（可穿透免打扰时段）；久坐/花销是低优先（守免打扰 + 冷却 + 概率门）。
 *  2. **概率门**：低优先提醒按 probability 抖动，避免变成烦人的定时器。
 *  3. **免打扰时段**：支持跨午夜（如 ['22:30','08:00']）。
 *  4. **久坐按"工作段"算**，不是按单个回合 —— 连续活跃累积到阈值才算，中间空闲超过 idleResetMs 就重置。
 *  5. 纯函数：now / random 都由调用方注入，测试完全确定。
 */

/** 解析 'HH:MM' → 当天分钟数 */
export function parseClock(text) {
  if (typeof text !== 'string') return undefined
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (m === null) return undefined
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * 解析免打扰时段 `['22:30', '08:00']` → `{ start, end }`（分钟数）。
 * 支持跨午夜：start > end 时表示"从 start 到次日 end"。
 */
export function parseQuietHours(spec) {
  if (!Array.isArray(spec) || spec.length !== 2) return null
  const start = parseClock(spec[0])
  const end = parseClock(spec[1])
  if (start === undefined || end === undefined || start === end) return null
  return { start, end }
}

/** 给定时刻是否处于免打扰时段 */
export function isQuiet(now, quiet) {
  if (quiet === null) return false
  const date = new Date(now)
  const minutes = date.getHours() * 60 + date.getMinutes()
  if (quiet.start < quiet.end) return minutes >= quiet.start && minutes < quiet.end
  // 跨午夜
  return minutes >= quiet.start || minutes < quiet.end
}

export const DEFAULT_REMINDERS = {
  enabled: true,
  /** ['22:30','08:00']；空数组 = 不设免打扰 */
  quietHours: [],
  approvalBacklog: {
    /** 同一批积压多久之后可以再提醒一次 */
    repeatAfterMs: 180_000,
  },
  sedentary: {
    /** 连续活跃累计到这个时长才提醒 */
    afterMs: 5_400_000,
    /** 中间空闲超过这个时长就认为工作段结束 */
    idleResetMs: 600_000,
    /** 两次久坐提醒的最小间隔 */
    cooldownMs: 3_600_000,
    /** 概率门：到点了也只有这个概率真的提醒 */
    probability: 0.35,
  },
  spend: {
    /**
     * 每个会话每累计这么多 token 提一次。
     *
     * ⚠️ **默认 0 = 关闭**（2026-10-05 用户："把这个弹窗去掉" —— 截图是"这段时间又用了约 376k tokens"）。
     * 关掉的只是**默认开关**，机制本身还在：显式配一个正数就能开回来 ✓
     * （`if (everyTokens > 0)` 那段逻辑未改动，见文件末尾「4. 花销（基线制）」）
     */
    everyTokens: 0,
  },
}

/** 把用户配置逐条合并到默认值上（缺失的规则保持默认，不会整体替换） */
export function mergeReminderConfig(user) {
  const source = user !== null && typeof user === 'object' ? user : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_REMINDERS.enabled,
    quietHours: Array.isArray(source.quietHours) ? source.quietHours : DEFAULT_REMINDERS.quietHours,
    approvalBacklog: { ...DEFAULT_REMINDERS.approvalBacklog, ...(source.approvalBacklog ?? {}) },
    sedentary: { ...DEFAULT_REMINDERS.sedentary, ...(source.sedentary ?? {}) },
    spend: { ...DEFAULT_REMINDERS.spend, ...(source.spend ?? {}) },
  }
}

export function createReminderState() {
  return {
    /** 各提醒上次真的发出去的时刻 */
    lastFiredAt: Object.create(null),
    /** 上一轮见到的审批积压数（用于判断"又多了"） */
    lastApprovalCount: 0,
    /** 各会话已汇报过的 token 数 */
    spendBaseline: Object.create(null),
    /** 当前工作段的起点；空闲超时后清空 */
    workStartedAt: undefined,
    lastActivityAt: undefined,
  }
}

/**
 * 评估一轮提醒。
 *
 * @param {object} input
 * @param {number} input.now            当前时刻
 * @param {number} input.pendingApprovals 待审批总数
 * @param {boolean} input.hasActivity   是否有会话在跑（用于维护"工作段"）
 * @param {Record<string, number>} input.spendBySession 各会话累计 token
 * @param {object} input.config         mergeReminderConfig 的结果
 * @param {object} [input.state]        上一轮的 reminder 状态
 * @param {() => number} [input.random] 概率门用的随机源（测试注入）
 * @returns {{ state: object, fires: Array<object>, quiet: boolean }}
 */
export function decideReminders(input) {
  const {
    now,
    pendingApprovals = 0,
    hasActivity = false,
    spendBySession = {},
    config,
    random = Math.random,
  } = input
  const prev = input.state ?? createReminderState()

  const state = {
    lastFiredAt: { ...prev.lastFiredAt },
    lastApprovalCount: prev.lastApprovalCount ?? 0,
    spendBaseline: { ...prev.spendBaseline },
    workStartedAt: prev.workStartedAt,
    lastActivityAt: prev.lastActivityAt,
  }
  const fires = []
  const quiet = isQuiet(now, parseQuietHours(config.quietHours))

  if (!config.enabled) return { state, fires, quiet }

  /** 发一条提醒；返回是否真的发出 */
  const fire = (kind, text, { urgent = false, cooldownMs = 0 } = {}) => {
    const last = state.lastFiredAt[kind]
    if (cooldownMs > 0 && last !== undefined && now - last < cooldownMs) return false
    if (quiet && !urgent) return false
    state.lastFiredAt[kind] = now
    fires.push({ type: 'notice', notice: kind, text, urgent, at: now })
    return true
  }

  // ── 1. 审批积压（urgent，可穿透免打扰）──────────────────────────
  if (pendingApprovals > state.lastApprovalCount) {
    const ok = fire('approval-backlog', `有 ${pendingApprovals} 个操作在等你审批`, {
      urgent: true,
      cooldownMs: config.approvalBacklog.repeatAfterMs,
    })
    if (ok) state.lastApprovalCount = pendingApprovals
  } else if (pendingApprovals === 0) {
    state.lastApprovalCount = 0
    // 积压清空 ⇒ 重置冷却。新一波是新消息，不该被上一波的限流挡住；
    // 只有"持续积压"才需要限流。（这条是测试逼出来的设计修正）
    delete state.lastFiredAt['approval-backlog']
  }

  // ── 2. 工作段维护（久坐的判据）──────────────────────────────────
  if (hasActivity) {
    state.lastActivityAt = now
    if (state.workStartedAt === undefined) state.workStartedAt = now
  } else if (state.lastActivityAt !== undefined && now - state.lastActivityAt >= config.sedentary.idleResetMs) {
    state.workStartedAt = undefined
    state.lastActivityAt = undefined
  }

  // ── 3. 久坐（低优先：免打扰 + 冷却 + 概率门）────────────────────
  if (state.workStartedAt !== undefined && now - state.workStartedAt >= config.sedentary.afterMs) {
    if (random() < config.sedentary.probability) {
      fire('sedentary', '连着干了好一会儿了，起来动动？', { cooldownMs: config.sedentary.cooldownMs })
    }
  }

  // ── 4. 花销（基线制）────────────────────────────────────────────
  //
  // ⚠️ **必须用基线制**：token 总数现在来自宿主的 durable projection（重启不丢），
  //    而本引擎的状态是进程内的（重启归零）。若直接拿"总数 - 已报数"判断，
  //    DSH 一重启就会立刻炸一条"本会话已用约 247040k tokens"——**实测踩到过**。
  //
  // 基线 = 本引擎第一次看到该会话时的累计值（历史账不计入提醒），
  // 之后只对**新增**的部分提醒。语义反而更贴切：提醒说的是"你最近花得有点多"，
  // 而不是"历史总账".
  if (config.spend.everyTokens > 0) {
    for (const [sessionId, tokens] of Object.entries(spendBySession)) {
      if (typeof tokens !== 'number') continue
      if (state.spendBaseline[sessionId] === undefined) {
        state.spendBaseline[sessionId] = tokens
        continue
      }
      const base = state.spendBaseline[sessionId]
      const consumed = tokens - base
      if (consumed >= config.spend.everyTokens) {
        if (fire('spend', `这段时间又用了约 ${Math.round(consumed / 1000)}k tokens`)) {
          // 按整数倍推进，避免"刚好过线一点点"就把余量吞掉
          state.spendBaseline[sessionId] = base + Math.floor(consumed / config.spend.everyTokens) * config.spend.everyTokens
        }
      }
    }
  }

  return { state, fires, quiet }
}
