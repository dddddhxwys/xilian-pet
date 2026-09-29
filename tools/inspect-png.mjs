// 解码自己生成的 PNG（filter=0，无需反滤波）并打印关键像素，定位颜色问题。
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
let offset = 8
let W = 0
let H = 0
const idat = []

while (offset < buf.length) {
  const length = buf.readUInt32BE(offset)
  const type = buf.toString('ascii', offset + 4, offset + 8)
  const data = buf.subarray(offset + 8, offset + 8 + length)
  if (type === 'IHDR') {
    W = data.readUInt32BE(0)
    H = data.readUInt32BE(4)
    console.log(`IHDR ${W}x${H} depth=${data[8]} colorType=${data[9]}`)
  } else if (type === 'IDAT') {
    idat.push(data)
  }
  offset += 12 + length
}

const raw = inflateSync(Buffer.concat(idat))
const stride = W * 4 + 1
console.log(`解压 ${raw.length} 字节，预期 ${stride * H}`)

const px = (x, y) => {
  const i = y * stride + 1 + x * 4
  return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]
}

const probes = [
  ['身体中心', 128, 150],
  ['左眼中心', 104, 138],
  ['右眼中心', 152, 138],
  ['左眼高光', 99, 132],
  ['肚皮', 128, 200],
  ['嘴', 128, 173],
  ['左耳', 80, 60],
  ['角落(应全透明)', 4, 4],
  ['身体外左下', 20, 240],
]

if (W === 256 && H === 256) {
  // 这些坐标是针对 256×256 的占位素材标的，换尺寸就不适用
  for (const [label, x, y] of probes) {
    const [r, g, b, a] = px(x, y)
    console.log(`  ${label.padEnd(18)} (${String(x).padStart(3)},${String(y).padStart(3)})  rgba(${r},${g},${b},${a})`)
  }
} else {
  console.log(`  （${W}×${H} 不是 256×256，跳过固定坐标探针，只看整体统计）`)
}

// 统计 alpha 分布
const buckets = { 0: 0, '1-64': 0, '65-192': 0, '193-254': 0, 255: 0 }
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const a = px(x, y)[3]
    if (a === 0) buckets[0]++
    else if (a < 65) buckets['1-64']++
    else if (a < 193) buckets['65-192']++
    else if (a < 255) buckets['193-254']++
    else buckets[255]++
  }
}
console.log('alpha 分布：', JSON.stringify(buckets))
