/**
 * profile patch（`cordis.patch.yml`）的**纯函数**改写逻辑。
 *
 * 为什么单独抽成模块：这是"装插件"里**唯一会写用户文件**的一步，
 * 写坏了很难查（改的是 DSH 的启动配置，写错会导致 DSH 起不来）。
 * 抽成纯函数就能在自测里直接断言：幂等、缩进正确、已有行不重复追加。
 */

export const ROW_ID = 'xilian-pet'

/** 该 patch 文本里是否已经有我们的插件行 */
export function hasPluginRow(text, rowId = ROW_ID) {
  return typeof text === 'string' && text.includes(rowId)
}

/** YAML 标量格式化（只支持扁平值；嵌套 config 请手写，见 packages/pet-plugin/cordis.patch.yml） */
function formatScalar(value) {
  if (typeof value === 'string') return `'${value}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * 生成要追加的那段 YAML。缩进必须与 Loader 的 patch 方言一致
 * （顶层数组项 `- insert:`，其下 4 空格，config 条目 6 空格）。
 */
export function pluginRowSnippet({ rowId = ROW_ID, pluginEntry, config = {} } = {}) {
  if (typeof pluginEntry !== 'string' || pluginEntry.length === 0) {
    throw new Error('pluginRowSnippet: pluginEntry 必填')
  }
  const lines = ['- insert:', `    - id: ${rowId}`, `      name: '${pluginEntry}'`]
  const entries = Object.entries(config ?? {})
  if (entries.length > 0) {
    lines.push('      config:')
    for (const [key, value] of entries) lines.push(`        ${key}: ${formatScalar(value)}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * 幂等追加插件行：已有就原样返回。
 * @returns {{text:string, changed:boolean}}
 */
export function addPluginRow(text, opts = {}) {
  const rowId = opts.rowId ?? ROW_ID
  const source = typeof text === 'string' ? text : ''
  if (hasPluginRow(source, rowId)) return { text: source, changed: false }
  const separator = source.length === 0 ? '' : source.endsWith('\n') ? '\n' : '\n\n'
  return { text: `${source}${separator}${pluginRowSnippet({ ...opts, rowId })}`, changed: true }
}

/** 判断一段文本像不像 profile patch（顶层是数组，条目形如 `- id:` / `- insert:`） */
export function looksLikeProfilePatch(text) {
  return typeof text === 'string' && /^\s*-\s+(id|insert|disabled|config):/m.test(text)
}

/**
 * 幂等**移除**我们那一段 `- insert:` 块（切到官方安装路径时用）。
 *
 * ⚠️ 为什么需要它：走官方安装（bundle 注册表）之后，手写的这段 patch 还在的话
 *    插件会被**加载两次** —— 两个实例、两套 SSE、端口打架 ✗。
 *
 * ⚠️ 安全要点：只能删**包含我们 rowId 的那一个** `- insert:` 块。
 *    patch 里可能有别的插件也用 `- insert:`，必须按"块缩进范围"切割、
 *    再核对块内是否含我们的 id —— 不能找第一个 `- insert:` 就删 ✗。
 *
 * @returns {{text:string, changed:boolean, removed:number}}
 */
export function removePluginRow(text, rowId = ROW_ID) {
  const source = typeof text === 'string' ? text : ''
  const lines = source.split('\n')
  const keep = []
  let removed = 0
  let i = 0
  const escaped = rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ownsRow = new RegExp(`-\\s*id:\\s*${escaped}\\b`)
  while (i < lines.length) {
    const line = lines[i]
    const open = line.match(/^(\s*)-\s*insert:\s*$/)
    if (!open) {
      keep.push(line)
      i++
      continue
    }
    const indent = open[1].length
    // 块 = 本行 + 后续所有"缩进比它深"的行（空行也算块内，继续往后看）
    let end = i + 1
    while (end < lines.length) {
      const next = lines[end]
      if (next.trim() === '') {
        end++
        continue
      }
      const nextIndent = next.match(/^(\s*)/)[1].length
      if (nextIndent <= indent) break
      end++
    }
    if (!ownsRow.test(lines.slice(i, end).join('\n'))) {
      keep.push(line)
      i++
      continue
    }
    // 命中：整块丢掉，并顺带吃掉紧跟其后的空行，避免留下连续空行
    removed++
    i = end
    while (i < lines.length && lines[i].trim() === '') i++
    while (keep.length >= 2 && keep[keep.length - 1].trim() === '' && keep[keep.length - 2].trim() === '') keep.pop()
  }
  const out = keep.join('\n')
  // 原文末尾有换行就要保住（往返测试抓到的：删完最后一段会把结尾换行一起吃掉 ✗）
  const result = source.endsWith('\n') && !out.endsWith('\n') ? `${out}\n` : out
  return { text: result, changed: removed > 0, removed }
}
