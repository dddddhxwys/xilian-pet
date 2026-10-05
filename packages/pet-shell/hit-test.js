/**
 * 命中测试的坐标与判定数学 —— **纯函数，不依赖 Electron**。
 *
 * 为什么单独抽出来：这段逻辑原来内联在主进程 60Hz 的轮询回调里，
 * 结果"控件被穿透"这类 bug 只能靠用户肉眼发现、没法自测。
 * 抽出来之后可以直接用 node 断言（见 tools/check-plugin.mjs 的 [5] 段）。
 *
 * ── 2026-10-05 补：部件级命中测试的坐标换算也放这里 ─────────────────────
 * 原来它写在 `renderer/live2d.js` 里（依赖 PIXI 全局），自测**根本 import 不了**，
 * 于是自测只能对源码做正则断言 —— 结果把一条错公式钉死在里面、119 项全绿也发现不了 ✗
 * 搬到这里之后可以真断言（见 check-plugin.mjs 的「坐标换算」段）。
 */
import { inTriangle } from './renderer/motion-policy.js'

/** 点是否落在任一矩形内（矩形为 CSS px，相对窗口左上角） */
export function insideAnyRect(rects, x, y) {
  if (!Array.isArray(rects)) return false
  return rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}

/**
 * 判断窗口在某个局部坐标处是否应该"接管鼠标"（反之穿透）。
 *
 * 两个来源取**或**：
 *  1. `uiRects` —— HTML 控件（输入条 / 气泡）。它们**不在** alpha 掩码里，
 *     少了这一路，控件上"没有角色像素"的部分会被误判成透明 → 穿透 → 按钮点不动。
 *  2. `mask` —— Live2D 渲染出来的 alpha 掩码（降采样）。
 *
 * @param {object}      input
 * @param {{width:number,height:number,data:Uint8Array}|null} input.mask alpha 掩码；可为 null（还没到）
 * @param {Array}       input.uiRects 可见 UI 控件矩形
 * @param {number}      input.winWidth  窗口宽（DIP）
 * @param {number}      input.winHeight 窗口高（DIP）
 * @param {number}      input.x 光标在窗口内的局部 x
 * @param {number}      input.y 光标在窗口内的局部 y
 * @param {number}      [input.threshold] alpha 阈值
 * @returns {{interactive:boolean, inWindow:boolean, hitUi:boolean, u:number, v:number, sampled:number}}
 */
export function hitTest({ mask, uiRects, winWidth, winHeight, x, y, threshold = 24 }) {
  const inWindow = x >= 0 && y >= 0 && x < winWidth && y < winHeight
  const hitUi = inWindow && insideAnyRect(uiRects, x, y)
  let u = -1
  let v = -1
  let sampled = -1
  let hitMask = false
  if (inWindow && mask && mask.width > 0 && mask.height > 0) {
    u = Math.floor((x / winWidth) * mask.width)
    v = Math.floor((y / winHeight) * mask.height)
    if (u >= 0 && v >= 0 && u < mask.width && v < mask.height) {
      sampled = mask.data[v * mask.width + u]
      hitMask = sampled > threshold
    }
  }
  return { interactive: hitUi || hitMask, inWindow, hitUi, u, v, sampled }
}

/**
 * 从 alpha 掩码里算出"角色本体"的竖直范围（CSS px，相对窗口顶）。
 *
 * 用途：右键菜单要跟**她的身体**对齐，而不是跟窗口的几何中心 ——
 * 她头顶有约 87px 留白（实测构图），窗口几何中心比她身体中心高约 40px，
 * 按窗口居中菜单会明显偏上（用户实测要求"与昔涟的身体对齐"）。
 *
 * 为什么用掩码而不是写死数值：换模型、换窗口尺寸、占位图降级时都自动跟着变。
 *
 * @param {Uint8Array|Uint8ClampedArray} mask 行优先的 alpha 掩码
 * @param {number} maskWidth
 * @param {number} maskHeight
 * @param {number} winHeight 窗口高（CSS px / DIP）
 * @param {number} [threshold] alpha 阈值
 * @returns {{top:number, bottom:number, centerY:number}|null}
 *          掩码里一个不透明像素都没有时返回 null（调用方退回窗口中心）
 */
export function contentBand(mask, maskWidth, maskHeight, winHeight, threshold = 24) {
  if (!mask || !maskWidth || !maskHeight || !winHeight) return null
  let first = -1
  let last = -1
  for (let v = 0; v < maskHeight; v++) {
    const row = v * maskWidth
    let hasPixel = false
    for (let u = 0; u < maskWidth; u++) {
      if (mask[row + u] > threshold) {
        hasPixel = true
        break
      }
    }
    if (hasPixel) {
      if (first < 0) first = v
      last = v
    }
  }
  if (first < 0) return null
  const scale = winHeight / maskHeight
  const top = first * scale
  const bottom = (last + 1) * scale // 最后一行也算一格
  return { top, bottom, centerY: (top + bottom) / 2 }
}

/**
 * 拖拽态是否该被**强制复位**。
 *
 * 为什么要这条兜底：`draggingNow` 唯一的清零处是渲染端的 `mouseup`。
 * 松手发生在窗口外、或渲染端崩了/卡了，那个事件永远不来
 * → 窗口永久停在"一直保持可交互"，把落在窗口范围内的点击**全部吞掉**
 * （包括本该给桌面其他窗口的点击）。
 *
 * 抽成纯函数是为了能自测 —— 这种"永远不该发生的那次丢 mouseup"，手动点是验不出来的。
 *
 * @param {{draggingNow:boolean, lastAt:number, now:number, staleMs:number}} input
 * @returns {boolean} true = 已经太久没续期，应当复位
 */
export function draggingExpired({ draggingNow, lastAt, now, staleMs }) {
  if (draggingNow !== true) return false
  // 没记到时间戳（或时间戳不合法）时不复位：宁可多等一轮，也别在刚按下时误伤拖拽
  if (!Number.isFinite(lastAt) || lastAt <= 0) return false
  if (!Number.isFinite(now) || !Number.isFinite(staleMs)) return false
  return now - lastAt > staleMs
}

// ── 部件级命中测试：真源在 `renderer/hit-math.js`（渲染端只能 fetch 到 renderer/ 内的文件）──
// 这里 re-export，好让**主进程**（main.js）与**自测**（tools/check-plugin.mjs）照旧从本文件取。
export {
  PART_NAMES,
  PART_ZONES,
  pickPartAt,
  pointInDrawableLocal,
  rawToLocal,
} from './renderer/hit-math.js'
