/**
 * 托盘菜单的**纯函数层**：菜单项与快捷键都在这里定义，main.js 只负责把模板喂给 Electron。
 *
 * 为什么抽出来：Electron 的 `Menu`/`Tray` 在 Node 单测里 import 不了（要 app ready），
 * 而"菜单里有哪些项、显示隐藏的文案对不对、快捷键是什么"这些恰恰是**会被改坏**的地方。
 */

/** 显示/隐藏她的全局快捷键（与退出的 Q 配对；托盘菜单里也显示它） */
export const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+H'
/** 已有的退出快捷键（保持原样，只是搬到这里当唯一来源） */
export const QUIT_SHORTCUT = 'CommandOrControl+Shift+Q'
/** 托盘悬浮提示 */
export const TRAY_TOOLTIP = '昔涟桌宠'

/**
 * 托盘菜单模板（不含 Electron API，纯数据）。
 * @param {{visible: boolean}} state 桌宠窗口当前是否可见
 * @returns {Array<{ id?: string, type?: string, label?: string, accelerator?: string }>}
 */
export function buildTrayMenuTemplate(state) {
  const visible = state?.visible === true
  return [
    // 一项分两态：她可见时给"隐藏她"，藏起来时给"显示她"——托盘里最常见的操作放第一条
    { id: 'toggle', label: visible ? '隐藏她' : '显示她', accelerator: TOGGLE_SHORTCUT },
    { id: 'settings', label: '设置…' },
    { id: 'recenter', label: '回到她身边' },
    { type: 'separator' },
    { id: 'quit', label: '退出', accelerator: QUIT_SHORTCUT },
  ]
}

/**
 * 点托盘里某一项之后要做什么 —— 也做成纯函数返回一个**动作名**，
 * main.js 拿到动作名再调对应的 Electron 操作（便于单测）。
 * @returns {'toggle'|'settings'|'recenter'|'quit'|null}
 */
export function trayActionFor(id) {
  return ['toggle', 'settings', 'recenter', 'quit'].includes(id) ? id : null
}
