/**
 * 桌面快捷方式：**路径规划**（纯函数，`tools/check-plugin.mjs` 直接 import 做断言）。
 *
 * 为什么单独抽出来：
 *  · Windows 解析快捷方式图标走的是老接口，**`IconLocation` 里只要出现非 ASCII 字符，
 *    图标就画成"白纸"**（2026-11-08 实测：同一个 .ico 放 `C:\Users\Public` 正常显示，
 *    放仓库路径（含中文）就是通用图标；`LoadImage`/`ExtractIconEx` 单独读它却是好的，
 *    所以当年一直是按"图标文件有问题"去查的，方向全错）。
 *    → 图标必须落在一个**机器无关、纯 ASCII** 的目录：`%PUBLIC%\XilianPet\`，
 *      退回 `%ProgramData%\XilianPet\`。
 *  · 「生成 .lnk」只能交给 Windows API（Node 没有这能力），实现在
 *    `tools/make-desktop-shortcut.ps1`；但"选哪个目录 / 能不能做"这类决策留在这里，
 *    才能被自测覆盖（观感靠实机、逻辑靠断言 —— 本仓库的老规矩）。
 */
import { join } from 'node:path'

/** 随发行包走的启动图标（相对仓库根） */
export const LAUNCHER_ICON_REL = 'packages/pet-shell/launcher-icon.ico'
/** 图标落点的子目录名（ASCII） */
export const ICON_SUBDIR = 'XilianPet'
/** 落点的文件名（ASCII） */
export const ICON_FILE = 'xilian-peek.ico'
/** 桌面上的快捷方式名（可以是中文：这是文件名，不是 IconLocation） */
export const LINK_NAME = '昔涟.lnk'

/**
 * 是否纯可打印 ASCII。
 * 只用来判断**图标目录**：链接名、目标路径都可以带中文（目标本来就在中文路径下）。
 */
export function isAsciiPath(value) {
  return typeof value === 'string' && value !== '' && /^[\x20-\x7e]+$/.test(value)
}

/**
 * 选图标落点：`%PUBLIC%`（= `C:\Users\Public`，所有 Windows 都有）优先，`%ProgramData%` 兜底。
 * 两个都不是 ASCII 就明确失败 —— 宁可不建快捷方式，也不要建一个"白纸图标"的快捷方式。
 */
export function pickIconRoot(env = process.env) {
  const candidates = [
    { via: 'PUBLIC', value: env.PUBLIC },
    { via: 'ProgramData', value: env.ProgramData },
  ]
  for (const candidate of candidates) {
    if (typeof candidate.value !== 'string' || candidate.value === '') continue
    const dir = join(candidate.value, ICON_SUBDIR)
    if (!isAsciiPath(dir)) continue
    return { ok: true, via: candidate.via, dir }
  }
  return {
    ok: false,
    reason: '没有可用的纯 ASCII 图标落点（%PUBLIC% / %ProgramData% 都缺失，或路径含非 ASCII 字符）',
  }
}

/**
 * 生成建快捷方式需要的一整套路径。
 * @param {{repoRoot: string, env?: Record<string, string|undefined>}} options
 */
export function planShortcut({ repoRoot, env = process.env } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '') throw new TypeError('planShortcut: repoRoot 必填')
  const root = pickIconRoot(env)
  if (!root.ok) return { ok: false, reason: root.reason }
  return {
    ok: true,
    via: root.via,
    iconSource: join(repoRoot, LAUNCHER_ICON_REL),
    iconDest: join(root.dir, ICON_FILE),
    target: join(repoRoot, 'start-pet.cmd'),
    linkName: LINK_NAME,
  }
}
