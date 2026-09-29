/**
 * 把西莲桌宠 Host 插件挂进当前 DSH profile。
 *
 * 为什么需要这个脚本：agent shell 的文件沙箱只允许写「工作区 + TEMP」，
 * 而 profile 的 patch 文件在 ~/.dsh/profiles/<profile>/ 下 —— 属于工作区外，
 * 在这里面跑 --write 会被拒绝（脚本会明确告诉你）。在**你自己的终端**里跑同样的
 * 命令就能成功。
 *
 * 用法：
 *   node tools/install-plugin.mjs            # 只检查现状 + 打印该怎么做（安全，默认）
 *   node tools/install-plugin.mjs --write    # 备份并追加挂载行（需在沙箱外执行）
 *
 * 官方契约（references/host-plugin.md）：patch 的 insert 条目，name 可以是
 * 包标识符、绝对文件系统路径或 file URL。这里用 file URL，免安装、免打包。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pluginEntry = join(root, 'packages', 'pet-plugin', 'index.js')
const pluginDir = join(root, 'packages', 'pet-plugin')

const ROW_ID = 'xilian-pet'
const write = process.argv.includes('--write')

const DSH_HOME = process.env.DSH_HOME
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const profileDir = process.env.DSH_PROFILE_DIR ?? (DSH_HOME ? join(DSH_HOME, 'profiles', PROFILE) : undefined)

console.log('西莲桌宠 · Host 插件挂载助手')
console.log('─'.repeat(56))
console.log(`插件入口   : ${pluginEntry}`)
console.log(`入口存在   : ${existsSync(pluginEntry) ? '是' : '否 ← 先确认文件在'}`)

if (profileDir === undefined) {
  console.error('\n找不到 profile：需要 DSH_PROFILE_DIR 或 DSH_HOME 环境变量。')
  process.exit(1)
}

const patchFile = join(profileDir, 'cordis.patch.yml')
console.log(`目标 patch : ${patchFile}`)

if (!existsSync(patchFile)) {
  console.error('\n该 patch 文件不存在。请核对 profile 目录是否正确。')
  process.exit(1)
}

const current = readFileSync(patchFile, 'utf8')
const already = current.includes(ROW_ID)

const snippet = `- insert:
    - id: ${ROW_ID}
      name: '${pluginEntry}'
      config:
        pathPrefix: '/xilian-pet'
        captureRawShapes: 20
        minHoldMs: 500
`

const snippetUrl = `- insert:
    - id: ${ROW_ID}
      name: '${pathToFileURL(pluginEntry).href}'
`

console.log(`已挂载     : ${already ? '是（无需重复添加）' : '否'}`)
console.log('\n──── 方式 A｜免安装直挂（追加到上面那个 patch 文件末尾）────\n')
console.log(snippet)
console.log('官方契约支持三种 name：包标识符 / 绝对文件系统路径 / file URL。')
console.log('上面用的是绝对路径（loader 会自行转成 file URL，对含中文的路径最省事）。')
console.log('如果它不认，换成 file URL 形式：\n')
console.log(snippetUrl)
console.log('──── 方式 B｜bundle 安装（GUI 插件管理页）────\n')
console.log(`  在插件管理页的安装框里填这个绝对路径，然后安装：\n  ${pluginDir}\n`)
console.log('  安装后 profile 的 package.json → dsh.profile.bundles 会出现')
console.log('  @local/xilian-pet-plugin，包内 cordis.patch.yml 的 insert 行自动生效。')

if (already) {
  console.log('\n结论：已经挂过，无需操作。')
  process.exit(0)
}

if (!write) {
  console.log('\n（默认只打印。加 --write 才会改写 patch 文件并自动备份。）')
  process.exit(0)
}

const backup = `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
try {
  copyFileSync(patchFile, backup)
  const separator = current.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(patchFile, `${current}${separator}${snippet}`, 'utf8')
  console.log(`\n✅ 已写入。备份：${backup}`)
  console.log('   重启 DSH（或等 HMR 重载）后访问 /xilian-pet/health 验证。')
} catch (error) {
  console.error(`\n❌ 写入失败：${error.code ?? ''} ${error.message}`)
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    console.error('   这是 agent shell 的文件沙箱在拦 —— 目标目录在工作区之外。')
    console.error('   请在**你自己的终端**里执行同一条命令：')
    console.error('     node tools/install-plugin.mjs --write')
  }
  process.exit(1)
}
