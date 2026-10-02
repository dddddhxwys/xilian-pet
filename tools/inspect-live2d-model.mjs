/**
 * Live2D 模型解析器 —— 读 Cubism 模型，产出"接口契约"。
 *
 * 用途：拿到任何 Cubism 模型文件夹，直接得出
 *   ① 参数清单（名字/分组）  ② 表情清单（各自改哪些参数）  ③ 动作清单（时长/是否循环）
 *   ④ 物理件  ⑤ 清单文件有没有漏挂资源
 *
 * 用法：node tools/inspect-live2d-model.mjs <模型文件夹>
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '')
if (!dir || !existsSync(dir)) {
  console.error('用法：node tools/inspect-live2d-model.mjs <模型文件夹>')
  process.exit(1)
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const listFiles = (d, ext) =>
  existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(ext)).map((f) => join(d, f)) : []

// ── 定位清单文件 ────────────────────────────────────────────────
const model3Path = readdirSync(dir).filter((f) => f.endsWith('.model3.json')).map((f) => join(dir, f))[0]
if (!model3Path) {
  console.error('❌ 没找到 *.model3.json —— 这不是一个 Cubism 模型文件夹')
  process.exit(1)
}
const model3 = readJson(model3Path)
const refs = model3.FileReferences ?? {}
const base = dir

console.log('='.repeat(70))
console.log(`模型: ${model3Path.replace(dir + '\\', '')}`)
console.log('='.repeat(70))

// ── moc3 版本 ───────────────────────────────────────────────────
const mocPath = join(base, refs.Moc ?? '')
if (existsSync(mocPath)) {
  const b = readFileSync(mocPath)
  const ver = b[4]
  const names = { 1: 'Cubism 3.0', 2: 'Cubism 3.3', 3: 'Cubism 4.0', 4: 'Cubism 4.2', 5: 'Cubism 5.0' }
  console.log(`\n【moc3】${refs.Moc}`)
  console.log(`  魔数=${b.subarray(0, 4).toString('ascii')}  版本号=${ver}  →  ${names[ver] ?? '未知'}`)
  console.log(`  Core 支持上限 = 5（MocVersion_50）  →  ${ver <= 5 ? '✅ 可加载' : '❌ 版本过高'}`)
}

// ── 纹理 ────────────────────────────────────────────────────────
console.log(`\n【纹理】共 ${(refs.Textures ?? []).length} 张`)
for (const t of refs.Textures ?? []) {
  const p = join(base, t)
  if (!existsSync(p)) { console.log(`  ❌ 缺失: ${t}`); continue }
  const b = readFileSync(p)
  const w = b.readUInt32BE(16)
  const h = b.readUInt32BE(20)
  const mb = (statSync(p).size / 1048576).toFixed(1)
  const need = 2048
  console.log(`  ${t}  ${w}×${h}  ${mb} MB` + (w > need ? `   ⚠️ 远超所需（显示仅约 250px 高，建议降到 ${need}）` : ''))
}

// ── 参数（来自 cdi3 DisplayInfo）─────────────────────────────────
let paramIds = new Set()
if (refs.DisplayInfo) {
  const cdi = readJson(join(base, refs.DisplayInfo))
  console.log(`\n【参数】来自 ${refs.DisplayInfo}`)
  for (const g of cdi.ParameterGroups ?? []) {
    console.log(`  ── 分组「${g.Name}」(${(g.Ids ?? []).length} 个)`)
    for (const id of g.Ids ?? []) {
      console.log(`       ${id}${g.Name !== 'Parameter' ? '   ← ' + g.Name : ''}`)
    }
    for (const id of g.Ids ?? []) paramIds.add(id)
  }
  if (cdi.Parameters?.length) {
    console.log(`  ── 全部命名参数 (${cdi.Parameters.length} 个)`)
    for (const p of cdi.Parameters) console.log(`       ${p.Id}  「${p.Name}」  组=${p.GroupId ?? '-'}`)
  }
  if (cdi.Parts?.length) console.log(`  ── 部件 (${cdi.Parts.length} 个): ${cdi.Parts.map((p) => p.Id).join(', ')}`)
}

// ── 清单文件的引用完整性 ────────────────────────────────────────
console.log('\n【清单引用检查】')
const hasMotions = refs.Motions !== undefined
const hasExpressions = refs.Expressions !== undefined
console.log(`  Motions    : ${hasMotions ? '✅ 已声明' : '❌ 未声明（文件夹里有动作文件也不会被加载）'}`)
console.log(`  Expressions: ${hasExpressions ? '✅ 已声明' : '❌ 未声明（文件夹里有表情文件也不会被加载）'}`)
if (refs.Physics) console.log(`  Physics    : ${existsSync(join(base, refs.Physics)) ? '✅ ' + refs.Physics : '❌ 缺失'}`)
if (refs.Pose) console.log(`  Pose       : ${existsSync(join(base, refs.Pose)) ? '✅ ' + refs.Pose : '❌ 缺失'}`)

// ── 眨眼 / 口型分组 ─────────────────────────────────────────────
console.log('\n【关键分组】')
for (const g of model3.Groups ?? []) {
  const ids = g.Ids ?? []
  const flag = ids.length === 0 ? '⚠️ 空（该功能不可用）' : `✅ ${ids.join(', ')}`
  console.log(`  ${g.Name}: ${flag}`)
}

// ── 表情 ────────────────────────────────────────────────────────
const expFiles = [...listFiles(join(dir, 'Expression'), '.exp3.json'), ...listFiles(join(dir, 'expressions'), '.exp3.json')]
console.log(`\n【表情】文件夹里共 ${expFiles.length} 个`)
const declaredExp = new Set(
  Array.isArray(refs.Expressions) ? refs.Expressions.map((e) => (typeof e === 'string' ? e : e.Name ?? e.File)) : [],
)
for (const f of expFiles) {
  const j = readJson(f)
  const rel = f.slice(dir.length + 1)
  const declared = declaredExp.has(rel) || [...declaredExp].some((d) => rel.endsWith(String(d)))
  const params = (j.Parameters ?? []).map((p) => `${p.Id}=${p.Value}`).join(', ')
  console.log(`  ${declared ? '✅' : '⚠️未挂'} ${rel}  Name=${j.Name ?? '-'}`)
  console.log(`        改这些参数: ${params || '(空)'}`)
}

// ── 动作 ────────────────────────────────────────────────────────
const motFiles = []
for (const d of ['Scene', 'motions', 'Motion']) motFiles.push(...listFiles(join(dir, d), '.motion3.json'))
console.log(`\n【动作】文件夹里共 ${motFiles.length} 个`)
for (const f of motFiles) {
  const j = readJson(f)
  const meta = j.Meta ?? {}
  const targets = [...new Set((j.Curves ?? []).map((c) => `${c.Target}:${c.Id}`))]
  const rel = f.slice(dir.length + 1)
  console.log(`  ⚠️未挂 ${rel}  Name=${meta.Name ?? '-'}  ${meta.Duration?.toFixed?.(2) ?? '?'}s  循环=${meta.Loop ?? false}`)
  console.log(`        驱动: ${targets.slice(0, 12).join(', ')}${targets.length > 12 ? ` …共${targets.length}` : ''}`)
}

// ── 附加信息 ────────────────────────────────────────────────────
console.log('\n【其他】')
console.log(`  moc3 里声明的参数总数（cdi3 收录 ${paramIds.size} 个）`)
const all = readdirSync(dir)
console.log(`  根目录文件: ${all.join(', ')}`)
