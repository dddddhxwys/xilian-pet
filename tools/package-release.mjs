/**
 * 打一个**给人用的发行包**（zip）—— 带版本号、形态、时间戳与 SHA256 校验和。
 *
 * 用法：
 *   node tools/package-release.mjs                     # 精简版（不含 Electron / 模型）
 *   node tools/package-release.mjs --with-model        # 带上 Live2D 模型（+1.4 MB）
 *   node tools/package-release.mjs --with-electron     # 完整版（+367 MB，接收方无需联网下 Electron）
 *   node tools/package-release.mjs --with-node         # 三合一（再内置便携 Node）
 *   node tools/package-release.mjs --dry-run           # 只列清单，不复制不压缩
 *   node tools/package-release.mjs --out=<zip 路径>     # 覆盖输出路径（默认已带版本+时间戳）
 *   node tools/package-release.mjs --notes="改了什么"   # 写进发行清单的更新说明
 *
 * 产物四件：
 *   dist-release/xilian-pet-v<版本>-<形态>-<时间戳>.zip
 *   dist-release/<同一个名字>.sha256      ← **两个空格**分隔，`sha256sum -c` 认这个格式
 *   包内 VERSION.txt                      ← 接收方靠它自证版本，排查时不必问人
 *   versions.json（仓库根，**受版本控制**）← 「检查更新」比对用的发布清单，打完包记得提交
 *
 * 为什么由打包脚本写 versions.json：清单里最要命的字段是 `sha256`，手抄一定和实际 zip
 * 对不上 —— 而用户正是拿它核对下载完整性。顺带把 latest / 发布日期一起抬上去。
 *
 * 为什么名字里必须有版本与时间戳（2026-10-06）：
 *   原来叫 `xilian-pet{,-full,-allinone}.zip`，既没有版本也没有时间戳，而且
 *   `--with-electron` 与 `--with-electron --with-model` 会**生成同一个名字** ——
 *   正是交接文档里记过的那个坑（"同一补丁文件名反复用 ✗"）。
 *
 * 为什么不用 git 取文件清单：沙箱下 Node 跑 `git` 需要管道 stdio（会 EPERM），
 * 而且 gitignore 掉的东西里恰好有**发行必需**的 vendor —— 直接走文件系统更简单可靠。
 */
import { createHash } from 'node:crypto'
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectReleaseFiles,
  describeVariant,
  formatSha256Sidecar,
  nodeRuntimeFiles,
  readGitCommit,
  readVersions,
  releaseInfoText,
  releaseVariant,
  releaseZipName,
  requiredInRelease,
  staleByFlavor,
  staleReleaseArtifacts,
} from './lib/release-files.mjs'
import { MANIFEST_FILE, readManifest, releaseAssetUrl, upsertManifest, writeManifest } from './lib/update-check.mjs'
import { writeZipFile } from './lib/zip-writer.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

const argv = process.argv.slice(2)
const withModel = argv.includes('--with-model')
const withElectron = argv.includes('--with-electron')
const withNode = argv.includes('--with-node')
const dryRun = argv.includes('--dry-run')
const outArg = argv.find((a) => a.startsWith('--out='))?.split('=')[1]
/** 这一版的更新说明。不传的话清单里 notes 会留空，并在结尾**大声提醒**（别静默发布空说明） */
const notesArg = argv.find((a) => a.startsWith('--notes='))?.slice('--notes='.length)
/** 默认打完包**顺手清掉同形态的旧包**；`--no-prune` 可关掉（比如想留几个历史版本） */
const noPrune = argv.includes('--no-prune')
/** 不打包，只收拾 dist-release/：每种形态留最新一份，其余删掉 */
const pruneOnly = argv.includes('--prune-only')

const options = { withModel, withElectron, withNode }
const STAGE_ROOT = join(ROOT, '.release')
const PKG_NAME = 'xilian-pet'
const STAGE_DIR = join(STAGE_ROOT, PKG_NAME)
const INFO_NAME = 'VERSION.txt'
const RELEASE_DIR = join(ROOT, 'dist-release')

// ── `--prune-only`：不打包，只收拾目录 ─────────────────────────────
// 放在版本检查**之前**：收拾旧包跟"版本号一致不一致"没关系，不该被那个拦住。
// ⚠️ 这里是纯同步代码（没有 pending 的 fetch/定时器），所以 process.exit 是安全的 ——
//    强退撞 libuv 断言那种事只发生在还有异步句柄没收尾的时候。
if (pruneOnly) {
  console.log('昔涟桌宠 · 清理旧发行包')
  console.log('─'.repeat(52))
  if (!existsSync(RELEASE_DIR)) {
    console.log('  没有 dist-release/ 目录，无需清理 ✓')
    process.exit(0)
  }
  const names = readdirSync(RELEASE_DIR)
  const stale = staleByFlavor(names)
  console.log(`  目录 : ${RELEASE_DIR}`)
  console.log(`  文件 : ${names.length} 个；按形态"各留最新一份"该删 ${stale.length} 个`)
  if (stale.length === 0) {
    console.log('\n没有要删的 ✓')
    process.exit(0)
  }
  for (const one of stale) console.log(`   · ${one}`)
  if (dryRun) {
    console.log('\n（--dry-run）没有真删')
    process.exit(0)
  }
  for (const one of stale) rmSync(join(RELEASE_DIR, one), { force: true })
  console.log(`\n已删除 ${stale.length} 个 ✓`)
  process.exit(0)
}

// ── 版本：根 package.json 是唯一来源；三处不一致就**直接拒绝打包** ──────
const versions = readVersions(ROOT)
if (typeof versions.source !== 'string') {
  console.error('❌ 读不到版本号：根 package.json 缺 version 字段')
  process.exit(1)
}
const drifted = versions.mirrors.filter((m) => m.version !== versions.source)
if (drifted.length > 0) {
  console.error('❌ 版本号不一致 —— 先跑 `node tools/bump-version.mjs <版本>`：')
  for (const m of drifted) console.error(`     ${m.rel} = ${m.version ?? '(缺失)'}  （根 = ${versions.source}）`)
  process.exit(1)
}
const version = versions.source
const builtAt = new Date()
const commit = readGitCommit(ROOT)
const variant = releaseVariant(options)
const zipPath = outArg ?? join(ROOT, 'dist-release', releaseZipName({ version, ...options }, builtAt))
const checksumPath = `${zipPath}.sha256`

console.log('昔涟桌宠 · 打发行包')
console.log('─'.repeat(56))
console.log(`  仓库根   : ${ROOT}`)
console.log(`  版本     : v${version}${commit === null ? '（读不到 git 提交）' : `  (${commit})`}`)
console.log(`  形态     : ${variant} —— ${describeVariant(options)}`)
console.log(`  输出     : ${zipPath}`)
console.log(`  模式     : ${dryRun ? '只列清单（--dry-run）' : '实际打包'}`)
console.log('')

const all = collectReleaseFiles(ROOT, { withModel, withElectron })
const included = all

// 便携 Node 从 .cache/ 拷进来（名字与源路径不同，所以单独处理）
const extras = []
if (withNode) {
  for (const entry of nodeRuntimeFiles(ROOT)) {
    if (!existsSync(entry.src)) {
      console.error(`❌ 缺少 ${entry.src}`)
      console.error('   先跑一次：node tools/fetch-node.mjs')
      process.exit(1)
    }
    extras.push(entry)
  }
}

let bytes = 0
for (const rel of included) {
  try {
    bytes += statSync(join(ROOT, rel)).size
  } catch {
    /* 忽略读不到的 */
  }
}
for (const e of extras) bytes += statSync(e.src).size
console.log(`  收录 ${included.length + extras.length} 个文件，共 ${(bytes / 1024 / 1024).toFixed(2)} MB（未压缩）`)
console.log(`  （整目录级的排除在遍历时就跳过了；这里的数字是**逐个判定过**的文件）`)
if (extras.length > 0) console.log(`  其中便携 Node：${extras.map((e) => e.name).join(', ')}`)
console.log('  另有包内 ${INFO_NAME}（版本/形态/构建时间/提交，由本脚本生成）')
console.log('')

// ── 自检：必需文件都在吗 ──────────────────────────────────────────
const includedNames = [...included, ...extras.map((e) => e.name)]
const missing = requiredInRelease({ withModel, withElectron, withNode }).filter((rel) => !includedNames.includes(rel))
if (missing.length > 0) {
  console.error('❌ 缺少必需文件，发行包会跑不起来：')
  for (const m of missing) console.error(`     ${m}`)
  process.exit(1)
}
console.log('  ✅ 必需文件齐全')

// ── 体积提示 ─────────────────────────────────────────────────────
if (withNode && !withElectron) {
  console.log('  ⚠️  只带便携 Node、不带 Electron：接收方首次运行**仍然要下 100 MB Electron**，')
  console.log('      这 35 MB 的 Node 只对"没有 DSH 的人"有意义。要三合一请加 --with-electron。')
}
if (withNode) {
  console.log('  ℹ️  内含便携 Node：接收方**不需要**预装 Node.js')
} else {
  console.log('  ℹ️  不含 Node：用 DSH 自带的运行时（`安装.cmd` 会去找 %USERPROFILE%\\.dsh\\dsh-runtimes）')
}
if (withElectron) {
  console.log('  ⚠️  含 367 MB Electron，zip 后约 140~160 MB —— 适合网盘 / GitHub Releases，不适合聊天软件直发')
} else {
  console.log('  ℹ️  不含 Electron：接收方首次运行会自动下载（约 100 MB，走华为云镜像）')
}

if (dryRun) {
  console.log('\n（--dry-run 到此为止，没有写任何文件。）')
  process.exit(0)
}

// ── 暂存 → 压缩 ──────────────────────────────────────────────────
console.log('\n复制到暂存目录…')
rmSync(STAGE_ROOT, { recursive: true, force: true })
mkdirSync(STAGE_DIR, { recursive: true })
let copied = 0
for (const rel of included) {
  const from = join(ROOT, rel)
  const to = join(STAGE_DIR, rel)
  try {
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
    copied++
  } catch (error) {
    console.warn(`  ⚠️  跳过 ${rel}：${error.message}`)
  }
}
// 便携 Node：源在 .cache/，包内名字是 node/（见 nodeRuntimeFiles 的注释）
for (const entry of extras) {
  const to = join(STAGE_DIR, entry.name)
  try {
    mkdirSync(dirname(to), { recursive: true })
    cpSync(entry.src, to)
    copied++
  } catch (error) {
    console.error(`❌ 复制便携 Node 失败（${entry.name}）：${error.message}`)
    process.exit(1)
  }
}

// 包内 VERSION.txt：接收方靠它自证版本
const infoText = releaseInfoText({ version, options, builtAt, commit })
writeFileSync(join(STAGE_DIR, INFO_NAME), infoText, 'utf8')
copied++
console.log(`  复制了 ${copied} 个文件（含生成的 ${INFO_NAME}）`)

console.log('\n压缩…')
mkdirSync(dirname(zipPath), { recursive: true })
rmSync(zipPath, { force: true })
const files = [
  ...included.map((rel) => ({ name: `${PKG_NAME}/${rel}`, absPath: join(STAGE_DIR, rel) })),
  ...extras.map((e) => ({ name: `${PKG_NAME}/${e.name}`, absPath: join(STAGE_DIR, e.name) })),
  { name: `${PKG_NAME}/${INFO_NAME}`, absPath: join(STAGE_DIR, INFO_NAME) },
]
const zipInfo = writeZipFile(zipPath, files, { log: (m) => console.log(m) })
if (!existsSync(zipPath)) {
  console.error('\n❌ 压缩失败：没有生成 zip')
  process.exit(1)
}
const zipMb = statSync(zipPath).size / 1024 / 1024

// ── SHA256 校验和（流式算，190 MB 的包也不吃内存）─────────────────
const hash = createHash('sha256')
for await (const chunk of createReadStream(zipPath)) hash.update(chunk)
const digest = hash.digest('hex')
writeFileSync(checksumPath, formatSha256Sidecar(digest, basename(zipPath)), 'utf8')

// ── 更新发布清单 versions.json ────────────────────────────────────
// 为什么交给打包脚本写：清单里最要命的字段是 `sha256` —— 手抄一定会和实际 zip 对不上，
// 而用户正是拿它核对"下到的这份是不是完整的那份"。这里直接用刚算出来的值。
// ⚠️ 它会**改动一个受版本控制的文件**（versions.json），打完包记得提交。
const pad = (n) => String(n).padStart(2, '0')
const manifestBefore = readManifest(ROOT)
const upserted = upsertManifest(manifestBefore, {
  version,
  flavor: variant,
  file: basename(zipPath),
  size: statSync(zipPath).size,
  sha256: digest,
  url: releaseAssetUrl(version, basename(zipPath)),
  releasedAt: `${builtAt.getFullYear()}-${pad(builtAt.getMonth() + 1)}-${pad(builtAt.getDate())}`,
  notes: notesArg,
})
writeManifest(ROOT, upserted.manifest)

// ── 顺手清掉**同形态**的旧包 ──────────────────────────────────────
// 白名单式：只删"名字是这一种格式、同一形态、但不是这一份"的文件（见 staleReleaseArtifacts）。
// 2026-10-06 的教训：以前这里用的是"不在保留列表里就删"，于是把
// `dist-release/RELEASE-NOTES.md` 一起扫掉了 ✗ —— 所以那个函数里有两条保守规则
// （拿不准就一个都不删），并且**绝不**匹配我们自己的产物名以外的任何文件。
if (!noPrune) {
  const builtName = basename(zipPath)
  const stale = staleReleaseArtifacts(readdirSync(dirname(zipPath)), {
    keepNames: [builtName, `${builtName}.sha256`],
    flavor: variant,
  })
  if (stale.length > 0) {
    for (const one of stale) rmSync(join(dirname(zipPath), one), { force: true })
    console.log(`\n🧹 清掉 ${stale.length} 个同形态旧包（只留刚打出来的这一份）：`)
    for (const one of stale) console.log(`     · ${one}`)
  }
}

console.log(`\n✅ 发行包：${zipPath}`)
console.log(`   版本 v${version} · 形态 ${variant} · 文件数 ${copied}（含包内 ${INFO_NAME}）`)
console.log(`   zip 内共 ${zipInfo.entries} 个条目（含目录条目）`)
console.log(`   zip 大小 ${zipMb.toFixed(2)} MB`)
console.log(`   SHA256   ${digest}`)
console.log(`   校验和已写入 ${checksumPath}`)
console.log(`\n📋 ${MANIFEST_FILE} 已更新（latest=${upserted.manifest.latest}）：`)
for (const item of upserted.changed) console.log(`     · ${item}`)
if (upserted.changed.length === 0) console.log('     · （无变化 —— 同一个包、同一版，重建了而已）')
if (upserted.notesMissing) {
  console.log('')
  console.log(`⚠️  ${MANIFEST_FILE} 的 notes 还是空的 —— 那是用户会在「检查更新」里看到的**更新说明**。`)
  console.log('    补上再发布：重跑一次并带 --notes="这一版改了什么"')
}
console.log('')
console.log('下一步：')
console.log(`   1. 提交 ${MANIFEST_FILE}（它变了，检查更新靠它）`)
console.log(`   2. 发布到 GitHub Releases（一条命令，幂等可重跑）：node tools/publish-release.mjs`)
console.log(`      —— 它按清单里的下载地址发布，tag 用 v${version}；重复执行不会重复上传`)
console.log('   3. 接收方解压到**一个新目录**（别覆盖旧目录，避免半新半旧的残留文件）')
console.log('   4. 双击「安装.cmd」→ 重启 DSH → 双击 start-pet.cmd')
console.log('（暂存 .release/ 留着核对；不打包时用 --prune-only 收拾旧包；想留历史版本加 --no-prune）')
