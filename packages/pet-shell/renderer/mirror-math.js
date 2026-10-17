/**
 * 构图变换的**纯函数层**：把"内容包围盒"铺进舞台，并支持左右镜像。
 *
 * 为什么单独抽出来：
 *  - 镜像最容易出错的是**坐标**（翻错方向、翻完位置偏了），这和 Electron/Pixi 无关，
 *    完全可以在 Node 里用行为断言钉死（配变异测试）；
 *  - live2d.js 里只负责把算出来的 `scaleX/posX/posY` 塞给 PIXI。
 *
 * 坐标系约定：
 *  - `content`：模型**局部坐标**里的内容包围盒（x,y 可为负）；w/h 是宽高；
 *  - `cssW/cssH`：舞台（画布）的 CSS 尺寸；
 *  - 非镜像：内容水平居中，`dX = (cssW - w*scale)/2` 作为包围盒左边界；
 *  - 镜像：以**包围盒**为轴水平翻（不是以模型原点翻），所以包围盒仍然落在同一块区域，
 *    只是左右互换 —— 这样"她站着的位置"不会因为翻转而跑到别处。
 *
 * @param {{x:number,y:number,w:number,h:number}} content
 * @param {number} cssW
 * @param {number} cssH
 * @param {{mirror?:boolean, marginPx?:number, fill?:number}} [options]
 * @returns {{scale:number, scaleX:number, scaleY:number, posX:number, posY:number, marginPx:number}}
 */
export function fitTransform(content, cssW, cssH, options = {}) {
  const mirror = options.mirror === true
  const marginPx = options.marginPx ?? 0
  const fill = options.fill ?? 1
  const availW = (cssW - marginPx * 2) * fill
  const availH = (cssH - marginPx * 2) * fill
  const scale = Math.min(availW / content.w, availH / content.h)
  const dX = (cssW - content.w * scale) / 2
  const dY = cssH - marginPx - content.h * scale

  // 镜像：scaleX 取负；为了"以包围盒为轴翻转"，posX 要换成包围盒右边界
  //   screenX(localX) = posX + localX * scaleX
  //   非镜像：localX=content.x → dX（左边界）
  //   镜像  ：localX=content.x → posX + content.x * (-scale) = dX + content.w*scale（右边界）✓
  const scaleX = mirror ? -scale : scale
  const posX = mirror ? dX + (content.x + content.w) * scale : dX - content.x * scale
  const posY = dY - content.y * scale
  return { scale, scaleX, scaleY: scale, posX, posY, marginPx }
}

/**
 * 镜像时该用哪个**表情**。
 *
 * 为什么需要（2026-10-12 用户实测）：模型里的「问号」是一张贴图（由 `Param6` 驱动，
 * `expression7.exp3.json` 里 `Param6: 1`）。整模型镜像后**问号字形本身也被镜像了**，
 * 变成"反问号"读不出来。
 * 处理：镜像时**不弹**模型里的问号表情（换成 `reset`，把问号关掉），
 * 改由 DOM 画一个**不镜像**的问号（`#questionMark`，见 pet.css / live2d.js）。
 * 其余表情（墨镜/星星/闭眼笑…）都是无文字图形，镜像后观感正常，不动。
 *
 * @param {string} name 原表情名
 * @param {boolean} mirror 当前是否镜像
 * @returns {string} 实际要应用的表情名
 */
export function expressionForMirror(name, mirror) {
  if (mirror === true && name === 'question') return 'reset'
  return name
}
