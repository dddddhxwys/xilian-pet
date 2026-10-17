/**
 * 桌宠设置的**纯函数层**：默认值 / 校验 / 序列化。
 *
 * 为什么单独一个文件、而且这里**不碰 fs**：
 *  - 这些逻辑要能脱离 Electron 直接单测（自测里 Node 直接 import 本文件）；
 *  - "哪些值算合法"和"文件存在哪、怎么写"是两件事，后者留给 main.js（阶段 2 接）。
 *
 * 设计约定（抄的是 Cyrene-Agent 的设置规范化思路，也是本项目的教训）：
 *  - **每个字段都有默认值**：缺失 / 类型不对一律回退默认，**绝不抛错** ——
 *    一个坏字段不能把整个桌宠拖垮（用户的配置文件是手改得出来的）；
 *  - **数值一律夹紧在范围内**（大小 0.6–1.6、不透明度 0.3–1），越界不报错、直接夹；
 *  - **未知字段直接丢弃**：防止旧版本残留键越滚越多、也防止把别人的配置项写回去；
 *  - **序列化键序固定 + 末尾换行**：git diff 干净（本项目对 diff 洁癖有先例）。
 *
 * 字段来源：用户 2026-10-12 确认的四项需求（大小 / 镜像 / 功能开关 / 亮色主题不做配置）。
 * ⚠️ 刻意**没有**的字段（别顺手加）：
 *  - `theme`：这次只做亮色，等真做暗色再加；
 *  - `hidden`：显示/隐藏是动作，不是持久设置；
 *  - `powerSave`：用户没选，不做。
 */

/** 配置格式版本。以后字段迁移靠它（当前只有 1，没有迁移逻辑）。 */
export const SETTINGS_VERSION = 1

/** 大小倍数范围（用户确认 0.6–1.6，默认 1.0） */
export const SCALE_MIN = 0.6
export const SCALE_MAX = 1.6

/** 不透明度范围（用户确认 30%–100%，默认 100%） */
export const OPACITY_MIN = 0.3
export const OPACITY_MAX = 1

/**
 * 默认设置。**冻结**：任何代码都不该改它 —— 要一份可改的副本用 `defaultSettings()`。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  appearance: Object.freeze({
    scale: 1, // 大小倍数
    opacity: 1, // 不透明度 0.3–1
    mirror: false, // 左右翻转（手动）
    autoFace: true, // 自动朝向：按鼠标左右方向翻（带防抖，实现见阶段 4）
  }),
  behavior: Object.freeze({
    clickInteraction: true, // 点击互动（脸/头顶/秋千）
    bubble: true, // 气泡提示
    approvalViaPet: true, // 审批由桌宠同意（⚠️ 改它要重启 DSH，见设置窗提示）
  }),
})

const isBool = (v) => typeof v === 'boolean'
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 数值夹紧；不是合法数字就回退默认（**不要**接受 "1.5" 这种字符串：会掩盖写错的配置） */
function clampNumber(value, min, max, fallback) {
  if (!isFiniteNum(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 严格布尔：非布尔（含 "true" / 1）一律回退默认 */
function boolOr(value, fallback) {
  return isBool(value) ? value : fallback
}

/** 取一份可改的默认设置（深拷贝，改它不会污染 DEFAULT_SETTINGS） */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    appearance: { ...DEFAULT_SETTINGS.appearance },
    behavior: { ...DEFAULT_SETTINGS.behavior },
  }
}

/**
 * 把任意输入规范化成合法设置。
 * 任何输入都不抛错：`null` / 数组 / 字符串 / 半个对象 / NaN 全部按"缺失"处理。
 *
 * @param {unknown} raw 从 settings.json 读出来的东西（可能已是坏文件）
 * @returns {{version:number, appearance:{scale:number,opacity:number,mirror:boolean,autoFace:boolean}, behavior:{clickInteraction:boolean,bubble:boolean,approvalViaPet:boolean}}}
 */
export function normalizeSettings(raw) {
  const out = defaultSettings()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out

  const app = raw.appearance
  if (app !== null && typeof app === 'object' && !Array.isArray(app)) {
    out.appearance.scale = clampNumber(app.scale, SCALE_MIN, SCALE_MAX, out.appearance.scale)
    out.appearance.opacity = clampNumber(app.opacity, OPACITY_MIN, OPACITY_MAX, out.appearance.opacity)
    out.appearance.mirror = boolOr(app.mirror, out.appearance.mirror)
    out.appearance.autoFace = boolOr(app.autoFace, out.appearance.autoFace)
  }

  const beh = raw.behavior
  if (beh !== null && typeof beh === 'object' && !Array.isArray(beh)) {
    out.behavior.clickInteraction = boolOr(beh.clickInteraction, out.behavior.clickInteraction)
    out.behavior.bubble = boolOr(beh.bubble, out.behavior.bubble)
    out.behavior.approvalViaPet = boolOr(beh.approvalViaPet, out.behavior.approvalViaPet)
  }

  return out
}

/**
 * 序列化成写盘用的 JSON 文本。
 * - 键序固定（version → appearance → behavior，组内顺序也固定）
 * - 2 空格缩进 + **末尾换行**（没换行时 git 会提示 "\ No newline at end of file"）
 * @param {unknown} settings 任意设置对象（会先规范化）
 */
export function serializeSettings(settings) {
  const s = normalizeSettings(settings)
  return (
    JSON.stringify(
      {
        version: s.version,
        appearance: {
          scale: s.appearance.scale,
          opacity: s.appearance.opacity,
          mirror: s.appearance.mirror,
          autoFace: s.appearance.autoFace,
        },
        behavior: {
          clickInteraction: s.behavior.clickInteraction,
          bubble: s.behavior.bubble,
          approvalViaPet: s.behavior.approvalViaPet,
        },
      },
      null,
      2,
    ) + '\n'
  )
}
