/**
 * 分析 4 个 Scene 动作各自驱动了什么 —— 判断每个 Scene 到底是什么场景。
 * 关注那些有中文名的"效果参数"（墨镜/星星/问号/闪耀/惊喜/开心/叉腰/秋千…）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '')
const cdi = JSON.parse(readFileSync(join(dir, 'Cyrene.cdi3.json'), 'utf8'))
const nameOf = new Map((cdi.Parameters ?? []).map((p) => [p.Id, p.Name]))

const sceneDir = join(dir, 'Scene')
for (const f of readdirSync(sceneDir).filter((x) => x.endsWith('.motion3.json')).sort()) {
  const j = JSON.parse(readFileSync(join(sceneDir, f), 'utf8'))
  const meta = j.Meta ?? {}
  console.log('='.repeat(74))
  console.log(`${f}   时长=${meta.Duration}s  循环=${meta.Loop}  曲线=${(j.Curves ?? []).length}`)
  console.log('='.repeat(74))

  const rows = []
  for (const c of j.Curves ?? []) {
    if (c.Target !== 'Parameter') continue
    const segs = c.Segments ?? []
    // 收集该参数被设置过的所有值
    const values = segs.filter((_, i) => i % 1 === 0 && typeof segs[i] === 'number' && i > 0)
    // Segments 结构：[0, t, v, ...] 混合；粗暴提取所有数字里的数值
    const nums = segs.filter((x) => typeof x === 'number')
    rows.push({ id: c.Id, name: nameOf.get(c.Id) ?? '', min: Math.min(...nums), max: Math.max(...nums), n: nums.length })
  }
  // 只看"有中文名且不是通用骨骼参数"的
  const generic = /^(ParamAngle|ParamBodyAngle|ParamBreath|ParamEye|ParamBrow|ParamMouth|Param\d+$)/
  const interesting = rows.filter((r) => r.name && !generic.test(r.id))
  console.log('\n【有语义名的参数（看得出场景内容）】')
  if (!interesting.length) console.log('  （无）')
  for (const r of interesting) {
    console.log(`  ${r.id.padEnd(12)} 「${r.name}」  取值 ${r.min} ~ ${r.max}`)
  }
  console.log('\n【通用参数（眨眼/头/身体等）】')
  for (const r of rows.filter((x) => generic.test(x.id)).slice(0, 12)) {
    console.log(`  ${r.id.padEnd(18)} 「${r.name || '-'}」  ${r.min} ~ ${r.max}`)
  }
  console.log()
}
