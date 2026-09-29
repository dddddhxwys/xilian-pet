/**
 * 程序化生成占位素材（零版权风险）。
 *
 * 产出 packages/pet-shell/renderer/assets/placeholder.png：256×256 RGBA，
 * 一个软萌的圆胖角色，带完整透明通道 —— 供 Electron 窗口做 alpha 掩码命中测试。
 *
 * 后续换成 Live2D 素材时，这个文件只是渲染层的一个可替换输入。
 *
 * 用法：node tools/make-placeholder.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const W = 256
const H = 256
const SS = 3 // 每轴超采样倍数，用来做抗锯齿

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'packages', 'pet-shell', 'renderer', 'assets')
const outFile = join(outDir, 'placeholder.png')

// ── 颜色 ────────────────────────────────────────────────────────────
const C = {
  body: [124, 199, 255],
  bodyDark: [86, 166, 232],
  belly: [226, 243, 255],
  eye: [18, 32, 58],
  eyeGlow: [255, 255, 255],
  blush: [255, 170, 195],
  mouth: [40, 58, 92],
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
/**
 * 距离场 → 覆盖率。d 为「到边界的带符号距离」（内部为负）
 *  d = 0        → 0.5（边界半覆盖）
 *  d ≤ -edge/2  → 1（实心）
 *  d ≥ +edge/2  → 0（全透明）
 */
const cover = (d, edge = 1.2) => clamp01(0.5 - d / edge)

/**
 * 到椭圆边界的带符号距离，**换算回像素单位**。
 * 归一化距离必须乘以短半轴，否则 edge 宽度会被短半轴放大几十倍，
 * 覆盖率会虚高（曾导致整图 85% 不透明）。
 */
const ellipse = (x, y, cx, cy, rx, ry) => {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  return (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry)
}
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r

/** 二次贝塞尔曲线距离的廉价近似：取样求最小距离 */
function quadDistance(x, y, p0, p1, p2) {
  let best = Infinity
  for (let t = 0; t <= 1; t += 0.05) {
    const mt = 1 - t
    const bx = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0]
    const by = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
    const d = Math.hypot(x - bx, y - by)
    if (d < best) best = d
  }
  return best
}

function sample(x, y) {
  // 从上层到下层依次合成，返回 premultiplied 前的 [r,g,b,a]
  let r = 0
  let g = 0
  let b = 0
  let a = 0

  const over = (color, alpha) => {
    if (alpha <= 0) return
    const na = alpha + a * (1 - alpha)
    if (na <= 0) return
    r = (color[0] * alpha + r * a * (1 - alpha)) / na
    g = (color[1] * alpha + g * a * (1 - alpha)) / na
    b = (color[2] * alpha + b * a * (1 - alpha)) / na
    a = na
  }

  // 身体（椭圆）
  const bodyD = ellipse(x, y, 128, 150, 88, 92)
  over(C.body, cover(bodyD))

  // 耳朵（两个圆）
  over(C.body, cover(circle(x, y, 80, 76, 34)))
  over(C.body, cover(circle(x, y, 176, 76, 34)))

  // 肚皮（浅色椭圆，仅在身体内部）
  const bellyD = ellipse(x, y, 128, 176, 56, 58)
  over(C.belly, cover(bellyD) * cover(bodyD) * 0.85)

  // 腮红
  over(C.blush, cover(ellipse(x, y, 76, 168, 16, 10)) * cover(bodyD) * 0.55)
  over(C.blush, cover(ellipse(x, y, 180, 168, 16, 10)) * cover(bodyD) * 0.55)

  // 眼睛
  over(C.eye, cover(circle(x, y, 104, 138, 14)))
  over(C.eye, cover(circle(x, y, 152, 138, 14)))
  // 高光
  over(C.eyeGlow, cover(circle(x, y, 99, 132, 5)) * 0.95)
  over(C.eyeGlow, cover(circle(x, y, 147, 132, 5)) * 0.95)

  // 嘴（二次贝塞尔微笑）
  const mouthD = quadDistance(x, y, [116, 166], [128, 180], [140, 166])
  over(C.mouth, cover(mouthD - 1.4, 1.6) * cover(bodyD))

  // 底部轻微明暗，给体积感
  const shade = clamp01((y - 150) / 120) * 0.18
  if (a > 0 && shade > 0) {
    r *= 1 - shade
    g *= 1 - shade
    b *= 1 - shade
  }

  return [r, g, b, a]
}

// ── 光栅化（超采样 + 透明背景）─────────────────────────────────────
if (process.env.PET_DEBUG_SAMPLE) {
  for (const [label, x, y] of [
    ['身体中心', 128, 150],
    ['左眼', 104, 138],
    ['角落', 4, 4],
  ]) {
    const s = sample(x, y)
    console.log(`  DEBUG ${label} (${x},${y}) = [${s.map((v) => v.toFixed(3)).join(', ')}]`)
  }
  console.log('  DEBUG C.body =', JSON.stringify(C))
}
console.log(`生成 ${W}×${H}，超采样 ${SS}×${SS} …`)
const rgba = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
        r += sr * sa
        g += sg * sa
        b += sb * sa
        a += sa
      }
    }
    const n = SS * SS
    const alpha = a / n
    const i = (y * W + x) * 4
    if (alpha <= 0.0001) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0
      continue
    }
    // 还原为非 premultiplied
    // 注意：clamp01 是给 0..1 用的，别套在 0..255 的颜色值上 —— 否则每个通道都会被夹到 1，
    // 再乘 255 就变成纯白（曾把整只宠物渲染成白块）。
    const byte = (v) => Math.round(Math.min(255, Math.max(0, v)))
    rgba[i] = byte(r / a)
    rgba[i + 1] = byte(g / a)
    rgba[i + 2] = byte(b / a)
    rgba[i + 3] = Math.round(alpha * 255)
  }
}

// ── PNG 编码 ────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const stride = W * 4 + 1
const raw = Buffer.alloc(stride * H)
for (let y = 0; y < H; y++) {
  raw[y * stride] = 0 // filter: none
  rgba.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, png)

// 自检：不透明像素占比
let opaque = 0
for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 8) opaque++
console.log(`已写出 ${outFile}`)
console.log(`大小 ${png.length} 字节；不透明像素 ${opaque} / ${W * H}（${((opaque / (W * H)) * 100).toFixed(1)}%）`)
if (opaque === 0 || opaque === W * H) {
  console.error('异常：全透明或全不透明，alpha 掩码命中测试会失效')
  process.exit(1)
}
