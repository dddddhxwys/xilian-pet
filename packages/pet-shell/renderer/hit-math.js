/**
 * 部件级命中测试的**纯数学 + 纯数据** —— 放在 `renderer/` 里是**刻意的**。
 *
 * ⚠️ 教训（2026-10-05，实机踩到）：`pet://app/` 协议**只服务 `renderer/` 目录**
 * （见 `main.js` 的 `RENDERER_DIR`）。所以渲染端能 import 的只有**同目录及子目录**的文件。
 * 我一开始把这段逻辑放在 `packages/pet-shell/hit-test.js`、让 `renderer/live2d.js` 用
 * `import '../hit-test.js'` —— 浏览器把它解析成 `pet://app/hit-test.js` → **404**
 * → **整个 live2d.js 模块加载失败** → 静默降级成占位图（用户只看到"桌宠变成小熊了"）✗
 *
 * 现在：本文件（同目录，可被渲染端 fetch）是**唯一真源**；
 * `packages/pet-shell/hit-test.js`（主进程与自测用）从它 re-export。
 * 自测里有一条「渲染端所有相对 import 必须落在 renderer/ 内」的守卫，防止同类再来一次。
 */
import { inTriangle } from './motion-policy.js'

// ── 部件级命中测试（左键分区互动）────────────────────────────────────

/**
 * raw 画层顶点 → **模型局部像素**。
 *
 * ⚠️ 这一条必须与库**逐字一致**，否则点击判定会整体错位。
 * 权威来源：pixi-live2d-display 的 `Cubism4InternalModel.getDrawableVertices()`
 * （`node_modules/pixi-live2d-display/dist/cubism4.js`）：
 *
 * ```js
 * arr[i]     =  arr[i]     * this.pixelsPerUnit + this.originalWidth  / 2;
 * arr[i + 1] = -arr[i + 1] * this.pixelsPerUnit + this.originalHeight / 2;
 * ```
 *
 * 两个坑（都踩过，见 docs/接手复核报告.md §2）：
 *  1. 系数是 **`PixelsPerUnit`**，不是 `CanvasWidth`。本模型 4200 vs 3500 → 差 1.2 倍。
 *  2. Y **必须取负**。漏了负号 = 整体上下镜像 → 点下半身会去上半身找图形。
 *
 * @param {number} rawX Cubism Core 的顶点 x（以画布中心为原点，约 ±0.5）
 * @param {number} rawY 同上
 * @param {{ppu:number, canvasWidth:number, canvasHeight:number}} canvas
 * @returns {{x:number, y:number}} 模型局部像素（原点在画布左上，Y 向下）
 */
export function rawToLocal(rawX, rawY, canvas) {
  const { ppu, canvasWidth, canvasHeight } = canvas
  return { x: rawX * ppu + canvasWidth / 2, y: -rawY * ppu + canvasHeight / 2 }
}

/**
 * 点是否落在某个画层的三角形网格里（局部像素坐标系，**精确判定，不是包围盒**）。
 * 退化三角形由 `inTriangle` 排除（零面积画层否则会吞掉点击）。
 */
export function pointInDrawableLocal(positions, indices, x, y, canvas) {
  if (!positions) return false
  const count = positions.length / 2
  if (count < 3) return false
  const px = (vi) => rawToLocal(positions[vi * 2], positions[vi * 2 + 1], canvas).x
  const py = (vi) => rawToLocal(positions[vi * 2], positions[vi * 2 + 1], canvas).y
  if (indices && indices.length >= 3) {
    for (let k = 0; k + 2 < indices.length; k += 3) {
      const a = indices[k]
      const b = indices[k + 1]
      const c = indices[k + 2]
      if (a >= count || b >= count || c >= count) continue
      if (inTriangle(x, y, px(a), py(a), px(b), py(b), px(c), py(c))) return true
    }
    return false
  }
  // 没有索引（理论上不会）：退回画层包围盒
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let v = 0; v < count; v++) {
    minX = Math.min(minX, px(v)); maxX = Math.max(maxX, px(v))
    minY = Math.min(minY, py(v)); maxY = Math.max(maxY, py(v))
  }
  return x >= minX && x <= maxX && y >= minY && y <= maxY
}

/**
 * 取点击处"最前面"的部件。
 *
 * ⚠️ **z 序用 `renderOrder`，不是数组下标。** Cubism 的 `renderOrder` 是"画的先后"，
 * 大 = 后画 = 在上面；而**本模型的 renderOrder 是下标的一个置换**（实测 `renderOrder[0]=112`），
 * 所以按下标迭代会取到"最后面"的那个 ✗（原实现就是这么写的）。
 *
 * 两种"没配区"语义：
 *  - `skipUnzoned: false`（默认，**现行**）：**最前面的部件说了算** —— 它没配区就什么都不发生。
 *    行为可预测；用户 2026-10-05 选的「两侧发不响应」正是靠这条。
 *  - `skipUnzoned: true`（旧行为）：跳过没配区的部件继续往后面找，
 *    于是点到身体/头发可能穿透到最底层的秋千背景板 —— 已弃用，仅保留作对照。
 *
 * @param {Array} drawables [{ index, partId, renderOrder, positions, indices, visible }]
 * @param {(partId:string)=>string|null} [zoneOf] 部件 → 分区名；不传 = 只找最前部件（调试用）
 * @returns {{index:number, partId:string, zone:string|null}|null}
 */
export function pickPartAt(drawables, x, y, canvas, { zoneOf = null, skipUnzoned = false } = {}) {
  if (!Array.isArray(drawables) || !drawables.length) return null
  const ordered = [...drawables].sort((a, b) => (b.renderOrder ?? 0) - (a.renderOrder ?? 0))
  for (const d of ordered) {
    if (d.visible === false) continue
    if (!pointInDrawableLocal(d.positions, d.indices, x, y, canvas)) continue
    if (!zoneOf) return { index: d.index, partId: d.partId, zone: null }
    const zone = zoneOf(d.partId) ?? null
    if (zone) return { index: d.index, partId: d.partId, zone }
    if (!skipUnzoned) return null // 最前面的部件没配区 → 什么都不发生
  }
  return null
}

// ── 部件表与交互区（**纯数据**，放这里是为了自测能直接断言）──────────────

/**
 * 部件 id → 中文名。**逐条抄自 `Cyrene.cdi3.json` 的 `Parts` 表**，顺序与运行时一致。
 *
 * ⚠️ 2026-10-05 补全：原表只列了 24 个，漏了 7 个，其中 **`Part2 模组`** 盖着额头/刘海
 * 一大片 —— 漏掉它会让"点脸"有一大半区域把最前面的部件认成 `(未收录)` → 点了没反应 ✗
 */
export const PART_NAMES = {
  Part: '整体',
  Part2: '模组',
  Part4: '前置动作',
  Part5: '秋千',
  Part6: '眉毛',
  Part7: '头饰',
  Part8: '头发',
  Part11: '眼睛',
  Part18: '脸',
  Part23: '身体',
  Part30: '后发',
  Part31: '背饰',
  Part3: '闪耀',
  Part9: '外侧发1',
  Part10: '外侧发2',
  Part12: '开心',
  Part13: '白眼',
  Part14: '左眼',
  Part16: '右眼',
  Part32: '嘴',
  Part33: '嘴',
  Part21: '腮红',
  Part22: '头发阴影',
  Part24: '右手动作',
  Part25: '左手动作',
  Part26: '裙摆',
  Part27: '右腿',
  Part28: '左腿',
  Part29: '后裙',
  Part15: '(0)',
  Part17: '(0)',
}

/**
 * 部件 → 交互区。**未列出 = 点了没反应**（最前面的部件说了算，见 `pickPartAt`）。
 *
 * 用户 2026-10-05 定的三区：**点脸 → 墨镜**、**点头顶 → 惊喜**、**点秋千 → 弹一下**。
 *
 * ⚠️ **历史教训（务必别再犯）**：上一版把 `Part29 后裙` 当"头顶"，并由此得出
 * 「部件名与渲染位置完全对不上、作者复用/改过部件」的结论 —— **那是假的**。
 * 真因是顶点换算 Y 没取负、X 用错系数（见 docs/接手复核报告.md §2），普查整体上下镜像了。
 * 坐标修对之后名字与位置**完全自洽**，不需要"作者改过部件"这种解释。
 *
 * 本表按修正坐标 + 逐像素「最前部件」普查重新定（脚本见 `.audit/zonesem.py`）。
 */
export const PART_ZONES = {
  // ── 脸 → 墨镜 ──
  // 「脸」不只是 `Part18`：额头/刘海那片最前面的是 `Part2 模组`，五官又各自盖在脸上
  // （点眼睛时最前面的并不是 Part18）。所以整个"面部簇"都归 face，
  // 否则点她的脸会有一大半"没反应" ✓
  Part18: 'face', // 脸
  Part2: 'face', // 模组（额头/刘海那一层）
  Part3: 'face', // 闪耀
  Part6: 'face', // 眉毛
  Part11: 'face', // 眼睛
  Part12: 'face', // 开心
  Part13: 'face', // 白眼
  Part14: 'face', // 左眼
  Part15: 'face', // (0)
  Part16: 'face', // 右眼
  Part17: 'face', // (0)
  Part21: 'face', // 腮红
  Part22: 'face', // 头发阴影
  Part32: 'face', // 嘴
  Part33: 'face', // 嘴

  // ── 头顶 → 惊喜 ──
  // 用户 2026-10-05 明确收窄：**只保留 头饰 / 头发 / 背饰**。
  // `Part9/10 外侧发`、`Part30 后发` **刻意不配区** → 点两侧长发什么都不发生 ✓
  // （这正是"最前面的部件说了算"这条语义的用途：它们不会穿透到后面的秋千背景板）
  Part7: 'head', // 头饰
  Part8: 'head', // 头发
  Part31: 'head', // 背饰（头顶那丛白叶饰）

  // ── 秋千 → 弹一下 ──
  Part5: 'swing', // 秋千（紫羽毛翅膀 + 绳 + 背景板；模型最底层）

  // ── 其余一律不响应（用户 2026-10-05 定）──
  // Part 整体 / Part4 前置动作 / Part23 身体 / Part24,25 左右手 /
  // Part26 裙摆 / Part27,28 左右腿 / Part29 后裙 → 点了没反应 ✓
}
