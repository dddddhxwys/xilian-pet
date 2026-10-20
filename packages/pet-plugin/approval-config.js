/**
 * 「审批是否由桌宠同意」的取值来源（**纯函数，可自测**）。
 *
 * 为什么单独一个模块：这项开关的**生效点在插件**（`approval/request` 的应答者注册与否），
 * 但开关的**界面在桌宠外壳**（设置窗写到 `packages/pet-shell/.state/settings.json`）。
 * 插件和外壳是两个进程，插件只在 `apply()`（= DSH 启动）时读一次 ——
 * 所以「改完要重启 DSH」是这条链路的固有事实，不是懒。
 *
 * 优先级（从高到低）：
 *   1. profile 里**显式**写了 `config.approval.viaPet`（布尔）→ 听 profile 的；
 *      （老版本手工 patch / 想强制覆盖的朋友用这条）
 *   2. 桌宠设置窗里的「审批由桌宠同意」（`behavior.approvalViaPet`）；
 *   3. 默认 **true**（opt-out：不写就是开，原因见 index.js 审批一节的长注释）。
 */

/**
 * @param {any} config 插件配置（cordis.patch.yml 里 `xilian-pet` 的 config）
 * @param {{behavior?: {approvalViaPet?: unknown}} | null} petSettings 桌宠外壳的设置文件内容
 * @returns {{value: boolean, source: 'plugin-config'|'settings-window'|'default'}}
 */
export function resolveApprovalViaPet(config, petSettings) {
  const explicit = config?.approval?.viaPet
  if (typeof explicit === 'boolean') return { value: explicit, source: 'plugin-config' }
  const fromWindow = petSettings?.behavior?.approvalViaPet
  if (typeof fromWindow === 'boolean') return { value: fromWindow, source: 'settings-window' }
  return { value: true, source: 'default' }
}

import { join } from 'node:path'

/** 设置文件相对插件目录的位置：`packages/pet-shell/.state/settings.json` */
export function petSettingsPath(pluginDir) {
  return join(pluginDir, '..', 'pet-shell', '.state', 'settings.json')
}

/**
 * 解析桌宠外壳的设置文件（**纯函数**）：坏文件 / 空文件 / 带 BOM 都不能让插件崩。
 * （BOM 是真踩过的坑：外壳那边早先写过带 BOM 的 JSON，`JSON.parse` 直接抛 → 整项静默失效。）
 *
 * @param {string} text 文件内容
 * @returns {any | null} 解析成功返回对象，否则 null
 */
export function parsePetSettings(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const clean = text.replace(/^\uFEFF/, '')
  try {
    const parsed = JSON.parse(clean)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
