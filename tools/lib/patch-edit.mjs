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
