/**
 * 命中测试的坐标与判定数学 —— **纯函数，不依赖 Electron**。
 *
 * 为什么单独抽出来：这段逻辑原来内联在主进程 60Hz 的轮询回调里，
 * 结果"控件被穿透"这类 bug 只能靠用户肉眼发现、没法自测。
 * 抽出来之后可以直接用 node 断言（见 tools/check-plugin.mjs 的 [5] 段）。
 */

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
