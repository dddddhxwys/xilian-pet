/**
 * 蚊香眼（ぐるぐる目 / 圈圈眼）的几何 —— **纯函数**，自测可直接 import。
 *
 * 这是什么：ACG 里表示"晕、被转晕、说胡话"的符号 —— 把**整个眼睛**换成一支螺旋：
 * 没有眼白、没有白底，螺旋本身就是眼睛（粗细约眼宽 1/10、约 2.5 圈、深色、略倾斜）。
 * 参考：萌娘百科「圈圈眼」条目插图、pixiv 百科「ぐるぐる目」。
 *
 * 为什么不复用模型自带的 `Param2「圈圈」`：那只是作者留的开关参数，用户明确说不是那个效果。
 * 实现路线（2026-11-09 用户确认"先试试 A"）：触发时把 `ParamEyeLOpen/ROpen` 压成 0
 * （眼白+紫瞳孔一起消失，只剩眼睑皮肤），再在这块皮肤上画螺旋。
 *
 * ⚠️ 位置/尺寸**只从脸（Part18）算**，不量眼睛画层：
 *    眼睛被压闭合后，眼睛画层可能被缩小/隐藏，量出来的包围盒会塌成一条线 → 螺旋跟着缩没。
 */

/** 螺旋画布的边长（viewBox 单位） */
export const DIZZY_VIEW = 40

/**
 * 生成阿基米德螺旋的 path（蚊香形状）。
 * @param {{turns?:number, steps?:number, rStart?:number, rEnd?:number, cx?:number, cy?:number}} [options]
 * @returns {string} SVG path d
 */
export function spiralPath({
  turns = 2.6,
  steps = 96,
  rStart = 2.4,
  rEnd = 16.4,
  cx = DIZZY_VIEW / 2,
  cy = DIZZY_VIEW / 2,
} = {}) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const theta = t * turns * Math.PI * 2
    const r = rStart + (rEnd - rStart) * t
    points.push(`${(cx + r * Math.cos(theta)).toFixed(1)} ${(cy + r * Math.sin(theta)).toFixed(1)}`)
  }
  return `M${points.join(' L')}`
}

/**
 * 图层要不要切换（`hidden` 是 DOM 上的当前值，`on` 是"该不该显示"）。
 * 抽出来是为了别在每帧重复写 DOM / 重复打日志 —— 这个判断写反过一次
 * （`hidden !== !on` 取反 → 进入审批反而永远不显示），所以用纯函数 + 自测盯住。
 */
export function shouldToggleDizzy(currentHidden, on) {
  return currentHidden !== (on !== true)
}

/**
 * 由**眼睛包围盒**（屏幕 CSS px）算出两只螺旋眼的尺寸与位置。
 *
 * 2026-11-09 第二次实机反馈"一只眼睛的跟随效果不好"：
 * 上一版为了强制对称，把两只眼都摆到"脸中心 ± 偏置、同一高度" —— 她歪头/摆动时
 * 两只眼并不在同一高度，于是有一只必然偏掉。
 * 现在改成：**位置各用各的眼睛包围盒中心**（跟得准），只有**尺寸取较小值**（防一大一小）。
 * 只有一只眼能量到时，才用脸中心镜像补另一只（兜底）。
 *
 * @param {{eyes: Array<{cx:number,cy:number,w:number,h:number}>, face?:{cx:number,cy:number}}} input
 * @returns {{size:{w:number,h:number}, positions:Array<{x:number,y:number}>}|null}
 */
export function dizzyLayout({ eyes, face }, { cover = 1.22, minSize = 6 } = {}) {
  const valid = (Array.isArray(eyes) ? eyes : []).filter(
    (e) => e && [e.cx, e.cy, e.w, e.h].every((v) => Number.isFinite(v)) && e.w > 0 && e.h > 0,
  )
  if (valid.length === 0) return null
  const size = {
    w: Math.max(minSize, Math.min(...valid.map((e) => e.w)) * cover),
    h: Math.max(minSize * 0.6, Math.min(...valid.map((e) => e.h)) * cover),
  }
  const left = valid[0]
  const right = valid[1] ?? null
  const positions = [{ x: left.cx, y: left.cy }]
  if (right) {
    positions.push({ x: right.cx, y: right.cy })
  } else if (face && Number.isFinite(face.cx)) {
    // 兜底：只量到一只眼时，按脸中心镜像出另一只
    positions.push({ x: face.cx * 2 - left.cx, y: left.cy })
  } else {
    positions.push({ x: left.cx, y: left.cy })
  }
  return { size, positions }
}
