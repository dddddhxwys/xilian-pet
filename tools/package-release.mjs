/**
 * 打一个**给朋友的发行包**（zip）。
 *
 * 用法：
 *   node tools/package-release.mjs                     # 精简版（不含 Electron / 模型）
 *   node tools/package-release.mjs --with-model        # 带上 Live2D 模型（+1.4 MB）
 *   node tools/package-release.mjs --with-electron     # 完整版（+367 MB，朋友无需联网）
 *   node tools/package-release.mjs --dry-run           # 只列清单，不复制不压缩
 *   node tools/package-release.mjs --out=<zip 路径>
 *
 * 为什么不用 git 取文件清单：沙箱下 Node 跑 `git` 需要管道 stdio（会 EPERM），
 * 而且 gitignore 掉的东西里恰好有**发行必需**的 vendor —— 直接走文件系统更简单可靠。
 *
 * 压缩用 PowerShell 的 Compress-Archive（系统自带，不引依赖）。
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectReleaseFiles, requiredInRelease } from './lib/release-files.mjs'
import { writeZipFile } from './lib/zip-writer.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

const argv = process.argv.slice(2)
const withModel = argv.includes('--with-model')
const withElectron = argv.includes('--with-electron')
const dryRun = argv.includes('--dry-run')
const outArg = argv.find((a) => a.startsWith('--out='))?.split('=')[1]

const STAGE_ROOT = join(ROOT, '.release')
const PKG_NAME = 'xilian-pet'
const STAGE_DIR = join(STAGE_ROOT, PKG_NAME)
const zipPath = outArg ?? join(ROOT, 'dist-release', `${PKG_NAME}${withElectron ? '-full' : ''}.zip`)

/** 递归遍历在 tools/lib/release-files.mjs 里（那边才测得到，见那个文件的注释） */

console.log('昔涟桌宠 · 打发行包')
console.log('─'.repeat(56))
console.log(`  仓库根   : ${ROOT}`)
console.log(`  形态     : ${withElectron ? '完整版（含 Electron 367 MB）' : '精简版'}${withModel ? ' + 模型' : ''}`)
console.log(`  输出     : ${zipPath}`)
console.log(`  模式     : ${dryRun ? '只列清单（--dry-run）' : '实际打包'}`)
console.log('')

const all = collectReleaseFiles(ROOT, { withModel, withElectron })
const included = all
let bytes = 0
for (const rel of included) {
  try {
    bytes += statSync(join(ROOT, rel)).size
  } catch {
    /* 忽略读不到的 */
  }
}
console.log(`  收录 ${included.length} 个文件，共 ${(bytes / 1024 / 1024).toFixed(2)} MB（未压缩）`)
console.log(`  （整目录级的排除在遍历时就跳过了；这里的数字是**逐个判定过**的文件）`)
console.log('')

// ── 自检：必需文件都在吗 ──────────────────────────────────────────
const missing = requiredInRelease({ withModel }).filter((rel) => !included.includes(rel))
if (missing.length > 0) {
  console.error('❌ 缺少必需文件，发行包会跑不起来：')
  for (const m of missing) console.error(`     ${m}`)
  process.exit(1)
}
console.log('  ✅ 必需文件齐全')

// ── 体积提示 ─────────────────────────────────────────────────────
if (withElectron) {
  console.log('  ⚠️  完整版含 367 MB Electron，zip 后约 140~160 MB —— 适合网盘，不适合聊天软件直发')
} else {
  console.log('  ℹ️  精简版不含 Electron：朋友首次运行会自动下载（约 100 MB，走华为云镜像）')
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
console.log(`  复制了 ${copied} 个文件`)

console.log('\n压缩…')
mkdirSync(dirname(zipPath), { recursive: true })
rmSync(zipPath, { force: true })
const files = included.map((rel) => ({ name: `${PKG_NAME}/${rel}`, absPath: join(STAGE_DIR, rel) }))
const zipInfo = writeZipFile(zipPath, files, { log: (m) => console.log(m) })
if (!existsSync(zipPath)) {
  console.error('\n❌ 压缩失败：没有生成 zip')
  process.exit(1)
}
const zipMb = statSync(zipPath).size / 1024 / 1024
console.log(`\n✅ 发行包：${zipPath}`)
console.log(`   文件数 ${included.length}（zip 内 ${zipInfo.entries} 个条目），zip 大小 ${zipMb.toFixed(2)} MB`)
console.log('\n下一步：把 zip 发给朋友 → 让他解压 → 双击「安装.cmd」→ 重启 DSH → 双击 start-pet.cmd')
console.log('（暂存目录 .release/ 留着便于核对；不用了可以删。）')
