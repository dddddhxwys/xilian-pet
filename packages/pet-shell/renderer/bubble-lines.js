/**
 * 「工作时」气泡的文案 —— 6 句话，**逐行照抄用户 2026-11-08 给的 `文本.txt`**（一字未改）。
 *
 * 为什么要单独一个文件：
 *  · 文案是内容，不是逻辑 —— 放在这里，`tools/check-plugin.mjs` 可以直接 import 断言
 *    （「6 句、顺序、轮换不重复」都是行为断言，不是源码正则）。
 *  · `pet.js` 是**普通脚本**（不能 import），所以本模块在浏览器里把接口挂到
 *    `window.XL_BUBBLE_LINES`；`pet.js` 在真正弹气泡时才去读它（模块是 defer 的，
 *    加载顺序不影响 —— 即使第一帧来得特别早，读不到也有原文兜底）。
 *
 * 改文案就改这个数组；顺序 = 轮换顺序。
 */
export const BUBBLE_LINES = [
  '少女思考中...',
  '正在调用工具...',
  '迷迷迷...迷迷！',
  '正在你的电脑中下载崩坏星穹铁道...',
  '正在构思新故事...',
  '正在落笔...',
]

/**
 * 轮换取下一句。
 * @param {number} index 上一次用过的下标（第一句请传 -1）
 * @returns {{index: number, text: string}}
 */
export function nextBubbleLine(index) {
  const last = Number.isInteger(index) ? index : -1
  const next = (last + 1) % BUBBLE_LINES.length
  return { index: next, text: BUBBLE_LINES[next] }
}

/**
 * 气泡行首的「笔 + 笔迹」循环动画（2026-11-09 用户要求：
 * "在笔尖下生成一道曲线来表示笔迹，然后做一段笔沿着笔迹运动，曲线不断浮现的循环动画"）。
 *
 * 纯 SVG/CSS，**没有 JS 定时器**：
 *  · `.bq-ink` 是一条 path（`pathLength="100"` 把长度归一化），靠 stroke-dashoffset 100→0
 *    让墨迹从起点"浮现"到终点；
 *  · `.bq-pen` 是羽毛笔素材，沿同一条 path 用 CSS motion path（offset-path/offset-distance）
 *    从 0% 走到 100%；
 *  · 两者共用同一条 path 与同一段线性时间，所以笔尖和墨迹始终对得上。
 *
 * ⚠️ 这里的 path `d` 必须和 pet.css 里 `.bq-pen { offset-path: path(...) }` 的**完全相同**
 *    （CSS 和 JS 没有共享常量的机制；自测里有一条断言专门盯这个）。
 */
export const QUILL_ROW_HTML =
  '<svg class="bq-ink" viewBox="0 0 40 30" aria-hidden="true" focusable="false">' +
  '<path d="M4 26 C8 15 12 28 17 19 S26 9 31 21 S34 24 37 18" pathLength="100" />' +
  '</svg>' +
  '<i class="bq-pen" aria-hidden="true"></i>'

// 只在浏览器里挂全局（自测里 `window` 不存在，直接 import 上面的导出即可）
if (typeof window !== 'undefined') {
  window.XL_BUBBLE_LINES = { BUBBLE_LINES, nextBubbleLine, QUILL_ROW_HTML }
}

