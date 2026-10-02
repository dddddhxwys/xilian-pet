/**
 * 修复 Cubism 模型的 model3.json —— 把"文件夹里有、但清单没挂"的资源接上。
 *
 * 为什么需要：很多模型（尤其从桌宠软件里导出的）文件夹里有动作/表情文件，
 * 但 model3.json 的 FileReferences 里**没有声明**，运行时就不会加载它们。
 * 本脚本自动发现这些文件并补进清单。
 *
 * 顺带修：
 *   · LipSync / EyeBlink 分组为空时，从 cdi3 里找出对应参数补上
 *
 * 用法：node tools/fix-live2d-model.mjs <模型文件夹>
 *
 * 注意：脚本进 git（修复可复现），模型文件不进 git。原文件会备份为 .bak
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const dir = resolve(process.argv[2] ?? '')
if (!dir || !existsSync(dir)) {
  console.error('用法：node tools/fix-live2d-model.mjs <模型文件夹>')
  process.exit(1)
}

const model3Name = readdirSync(dir).find((f) => f.endsWith('.model3.json'))
if (!model3Name) {
  console.error('❌ 没找到 *.model3.json')
  process.exit(1)
}
const model3Path = join(dir, model3Name)
const model3 = JSON.parse(readFileSync(model3Path, 'utf8'))
const refs = (model3.FileReferences ??= {})

// ── 递归找出所有动作 / 表情文件 ──────────────────────────────────
const walk = (d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const all = walk(dir)
const motionFiles = all.filter((f) => f.endsWith('.motion3.json')).map((f) => relative(dir, f).replace(/\\/g, '/'))
const expFiles = all.filter((f) => f.endsWith('.exp3.json')).map((f) => relative(dir, f).replace(/\\/g, '/'))

console.log(`模型: ${model3Name}`)
console.log(`发现 动作 ${motionFiles.length} 个, 表情 ${expFiles.length} 个`)

const changes = []

// ── 补 Motions ──────────────────────────────────────────────────
if (refs.Motions === undefined && motionFiles.length) {
  // 按子目录分组；没子目录就全放默认组
  const groups = {}
  for (const f of motionFiles) {
    const parts = f.split('/')
    const group = parts.length > 1 ? parts[0] : 'Default'
    ;(groups[group] ??= []).push({ File: f })
  }
  refs.Motions = groups
  changes.push(`补 Motions：${Object.entries(groups).map(([g, a]) => `${g}(${a.length})`).join(', ')}`)
} else if (refs.Motions !== undefined) {
  console.log('  Motions 已声明，跳过')
}

// ── 补 Expressions ──────────────────────────────────────────────
if (refs.Expressions === undefined && expFiles.length) {
  // 表情名：优先用本模型的语义对照表，否则退回文件名
  const SEMANTIC = {
    'Expression/expression0.exp3.json': 'reset',
    'Expression/expression1.exp3.json': 'surprise',
    'Expression/expression2.exp3.json': 'spiral',
    'Expression/expression3.exp3.json': 'happy',
    'Expression/expression4.exp3.json': 'sunglasses',
    'Expression/expression7.exp3.json': 'question',
    'Expression/expression5.exp3.json': 'swingOff',
    'Expression/expression6.exp3.json': 'swingOn',
    'Expression/expression8.exp3.json': 'ropeOn',
    'expressions/expression10.exp3.json': 'ropeOff',
    'expressions/expression5-6.exp3.json': 'swingMid',
    'expressions/expression5.exp3.json': 'swingLeft',
    'expressions/expression6.exp3.json': 'swingRight',
  }
  const used = new Set()
  const list = []
  for (const f of expFiles) {
    let name = SEMANTIC[f] ?? f.split('/').pop().replace(/\.exp3\.json$/, '')
    while (used.has(name)) name += '_2'
    used.add(name)
    list.push({ Name: name, File: f })
  }
  refs.Expressions = list
  changes.push(`补 Expressions：${list.length} 个（${list.map((x) => x.Name).join(', ')}）`)
} else if (refs.Expressions !== undefined) {
  console.log('  Expressions 已声明，跳过')
}

// ── 修 Groups（LipSync / EyeBlink 为空时从 cdi3 找）──────────────
if (refs.DisplayInfo && existsSync(join(dir, refs.DisplayInfo))) {
  const cdi = JSON.parse(readFileSync(join(dir, refs.DisplayInfo), 'utf8'))
  const ids = new Set((cdi.Parameters ?? []).map((p) => p.Id))
  const groups = (model3.Groups ??= [])
  const ensure = (name, wants) => {
    let g = groups.find((x) => x.Name === name)
    if (!g) { g = { Target: 'Parameter', Name: name, Ids: [] }; groups.push(g) }
    if ((g.Ids ?? []).length === 0) {
      const found = wants.filter((w) => ids.has(w))
      if (found.length) {
        g.Ids = found
        changes.push(`补 ${name} 分组：${found.join(', ')}`)
      }
    }
  }
  ensure('LipSync', ['ParamMouthOpenY'])
  ensure('EyeBlink', ['ParamEyeLOpen', 'ParamEyeROpen'])
}

// ── 写回（先备份）──────────────────────────────────────────────
if (!changes.length) {
  console.log('\n✅ 无需修改')
} else {
  copyFileSync(model3Path, model3Path + '.bak')
  writeFileSync(model3Path, JSON.stringify(model3, null, '\t') + '\n', 'utf8')
  console.log('\n已修改（原文件备份为 .bak）：')
  for (const c of changes) console.log('  · ' + c)
}
