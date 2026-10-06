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
 *
 * 产物三件：
 *   dist-release/xilian-pet-v<版本>-<形态>-<时间戳>.zip
 *   dist-release/<同一个名字>.sha256      ← **两个空格**分隔，`sha256sum -c` 认这个格式
 *   包内 VERSION.txt                      ← 接收方靠它自证版本，排查时不必问人
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
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
} from './lib/release-files.mjs'
import { writeZipFile } from './lib/zip-writer.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

const argv = process.argv.slice(2)
const withModel = argv.includes('--with-model')
const withElectron = argv.includes('--with-electron')
const withNode = argv.includes('--with-node')
const dryRun = argv.includes('--dry-run')
const outArg = argv.find((a) => a.startsWith('--out='))?.split('=')[1]

const options = { withModel, withElectron, withNode }
const STAGE_ROOT = join(ROOT, '.release')
const PKG_NAME = 'xilian-pet'
const STAGE_DIR = join(STAGE_ROOT, PKG_NAME)
const INFO_NAME = 'VERSION.txt'

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

console.log(`\n✅ 发行包：${zipPath}`)
console.log(`   版本 v${version} · 形态 ${variant} · 文件数 ${copied}（含包内 ${INFO_NAME}）`)
console.log(`   zip 内共 ${zipInfo.entries} 个条目（含目录条目）`)
console.log(`   zip 大小 ${zipMb.toFixed(2)} MB`)
console.log(`   SHA256   ${digest}`)
console.log(`   校验和已写入 ${checksumPath}`)
console.log('\n下一步：')
console.log('   1. 把 zip 和它的 .sha256 一起发出去（接收方可用 `sha256sum -c` 验证完整性）')
console.log('   2. 接收方解压到**一个新目录**（别覆盖旧目录，避免半新半旧的残留文件）')
console.log('   3. 双击「安装.cmd」→ 重启 DSH → 双击 start-pet.cmd')
console.log('（暂存目录 .release/ 留着便于核对；不用了可以删。）')
