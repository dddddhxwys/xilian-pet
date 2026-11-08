// DeepSeek 峰谷时段判定 —— **纯函数、不碰 DOM**，所以 check-plugin.mjs 能直接 import 做行为断言。
//
// 规则（官方定价页《模型 & 价格》）：
//   「北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
//     其余时段，包括周末及中国法定节假日全天均为空闲时段。」
//
// 三个容易写错的点（都写在下面的实现里）：
//  1. 是**北京时间**，不是"系统本地时间"：一律用 +08:00 换算，换机器/改时区都不影响判定。
//  2. 区间是**左闭右开**：9:00 整已经是高峰、12:00 整已经是空闲、14:00 整是高峰、18:00 整是空闲。
//  3. 周末优先于节假日表：周六周日不管在不在表里都算空闲（补班日也按周末算空闲，与官方口径一致）。

/** 北京时间相对 UTC 的固定偏移（中国无夏令时，可当常量） */
export const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

/** 高峰时段（北京时间，分钟数，左闭右开） */
export const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 一天的四个"状态切换时刻"：峰↔闲只可能在这四个点上翻转 */
export const PEAK_EDGES_MINUTES = [9 * 60, 12 * 60, 14 * 60, 18 * 60]

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 把时间戳换算成北京时间的墙上时钟（与宿主时区无关）。
 * 做法：先加 8 小时，再用 UTC 取值 —— 这样 `new Date()` 落在哪个时区都不影响结果。
 */
export function beijingParts(ms) {
  const d = new Date(ms + BEIJING_UTC_OFFSET_MS)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0 = 周日
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateKey: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
  }
}

/**
 * 节假日数据 → 判定集合。
 * 返回 { keys, years }：keys 查日期，years 用来报"这一年还没录数据"。
 */
export function buildHolidaySet(data) {
  const keys = new Set()
  const years = new Set()
  for (const [year, list] of Object.entries(data?.years ?? {})) {
    years.add(Number(year))
    for (const key of list) keys.add(key)
  }
  return { keys, years }
}

/** 这一分钟是不是高峰时段 */
export function isPeakAt(ms, holidays) {
  const p = beijingParts(ms)
  if (p.weekday === 0 || p.weekday === 6) return false // 周末：全天空闲
  if (holidays.keys.has(p.dateKey)) return false // 法定节假日：全天空闲
  return PEAK_WINDOWS.some(([from, to]) => p.minutes >= from && p.minutes < to)
}

/**
 * 下一次"峰↔闲"翻转的时间戳（毫秒）；找不到（理论上不会）返回 null。
 * 只在四个切换点上找，并逐天往后看（最长要跨 9 天春节假期，所以窗口给到 32 天）。
 */
export function nextSwitchAt(ms, holidays) {
  const nowPeak = isPeakAt(ms, holidays)
  const p = beijingParts(ms)
  for (let i = 0; i < 32; i += 1) {
    for (const minuteOfDay of PEAK_EDGES_MINUTES) {
      // 北京时间第 i 天的 hh:mm 整 → 时间戳（h-8 让 Date.UTC 折算成 UTC，越界会自动进位）
      const t = Date.UTC(
        p.year,
        p.month - 1,
        p.day + i,
        Math.floor(minuteOfDay / 60) - 8,
        minuteOfDay % 60,
        0,
        0,
      )
      if (t <= ms) continue
      if (isPeakAt(t, holidays) !== nowPeak) return t
    }
  }
  return null
}

/** 倒计时文案：够粗就够用（面板只有一行，不需要秒） */
export function describeCountdown(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  return `${minutes} 分钟`
}

/**
 * 面板要用的一整份状态。
 * covered=false 表示这一年的节假日还没录进表里（跨年后会短暂出现），
 * 此时判定退回"周一至周五"，渲染端负责在 tooltip / 控制台里说清楚。
 */
export function peakStatus(ms, holidays) {
  const p = beijingParts(ms)
  const peak = isPeakAt(ms, holidays)
  const next = nextSwitchAt(ms, holidays)
  return {
    peak,
    label: peak ? '高峰' : '空闲',
    countdown: next === null ? '' : describeCountdown(next - ms),
    nextAt: next,
    year: p.year,
    covered: holidays.years.has(p.year),
  }
}
