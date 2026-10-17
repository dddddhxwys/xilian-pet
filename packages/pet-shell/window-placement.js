/**
 * 窗口摆放的**纯函数层**：居中、夹进工作区。
 *
 * 为什么单独抽：多显示器 / DPI / 拔屏这些场景**在单测里能算**，
 * 实机只会让你看见"窗口跑到屏幕外了"——先用纯函数把坐标钉住。
 */

/**
 * 把 width×height 的窗口**居中**放到工作区。
 * 窗口比工作区还大时贴左上（不产生负的越界坐标）。
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {number} width
 * @param {number} height
 * @returns {{x:number,y:number}}
 */
export function centerInWorkArea(workArea, width, height) {
  const dx = Math.max(0, (workArea.width - width) / 2)
  const dy = Math.max(0, (workArea.height - height) / 2)
  return { x: Math.round(workArea.x + dx), y: Math.round(workArea.y + dy) }
}

/**
 * 把矩形**夹进**工作区（拖到屏幕外 / 拔掉显示器后恢复用）。
 * 右上角也不许超出：x ≤ workArea.x + (workArea.width − width)。
 *
 * ⚠️ 阶段 2 还没有调用方：阶段 4 改「大小」时窗口尺寸会变，
 * 重建尺寸前必须先用它把位置夹回工作区，否则会跑出屏幕。
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @returns {{x:number,y:number}}
 */
export function clampIntoWorkArea(workArea, bounds) {
  const maxX = workArea.x + Math.max(0, workArea.width - bounds.width)
  const maxY = workArea.y + Math.max(0, workArea.height - bounds.height)
  return {
    x: Math.round(Math.min(maxX, Math.max(workArea.x, bounds.x))),
    y: Math.round(Math.min(maxY, Math.max(workArea.y, bounds.y))),
  }
}

/**
 * 改变窗口尺寸时**保住她的脚**：以「底边中点」为锚缩放，再夹回工作区。
 *
 * 为什么锚底边中点，而不是窗口中心：
 *  - 她的脚在画面底部、身体水平居中；锚中心放大会让她**往下掉**（脚离开桌面）；
 *  - 锚底边 = "原地长大/缩小"，桌面上的站位不变，拖动/构图缓存都不用跟着改。
 *
 * 为什么必须夹回工作区：放大到 1.6 倍时窗口可能顶出屏幕（尤其她本来就在屏幕边缘）。
 *
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {{x:number,y:number,width:number,height:number}} bounds 当前窗口矩形
 * @param {number} newWidth 新宽度（DIP）
 * @param {number} newHeight 新高度（DIP）
 * @returns {{x:number,y:number}} 新窗口左上角
 */
export function resizeAroundBottomCenter(workArea, bounds, newWidth, newHeight) {
  const centerX = bounds.x + bounds.width / 2
  const bottomY = bounds.y + bounds.height
  return clampIntoWorkArea(workArea, {
    x: Math.round(centerX - newWidth / 2),
    y: Math.round(bottomY - newHeight),
    width: newWidth,
    height: newHeight,
  })
}

