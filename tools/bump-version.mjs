/**
 * 版本号：**一处改、三处同步**。
 *
 * 为什么必须有它：版本号散在三个 `package.json` 里 ——
 *   · `package.json`（根）                        → 发行包名 / VERSION.txt 用
 *   · `packages/pet-plugin/package.json`          → **插件卡片上显示的就是它**
 *   · `packages/pet-shell/package.json`           → 外壳版本
 * 手工改三处必然会漏，而且漏了**不会有任何报错** —— 直到用户拿着
 * 「插件列表显示 0.0.1、压缩包叫 v0.1.0」来问你。自测里有一条专门盯这个不变量。
 *
 * 用法：
 *   node tools/bump-version.mjs 0.2.0     三处都写成 0.2.0
 *   node tools/bump-version.mjs --check   只检查是否一致（不一致则退出码 1）
 *   node tools/bump-version.mjs           同 --check
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VERSION_MIRRORS, VERSION_SOURCE, readVersions } from './lib/release-files.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const current = readVersions(ROOT)

function report() {
  console.log('当前版本：')
  console.log(`  ${VERSION_SOURCE.padEnd(34)} ${current.source ?? '(缺 version 字段)'}`)
  for (const m of current.mirrors) console.log(`  ${m.rel.padEnd(34)} ${m.version ?? '(缺 version 字段)'}`)
}

const args = process.argv.slice(2)
const wantsCheck = args.includes('--check') || args.filter((a) => !a.startsWith('-')).length === 0

if (wantsCheck) {
  report()
  const all = [current.source, ...current.mirrors.map((m) => m.version)]
  const consistent = all.every((v) => typeof v === 'string' && v === current.source)
  console.log('')
  if (consistent) {
    console.log(`✅ 三处一致：v${current.source}`)
    process.exit(0)
  }
  console.log('❌ 版本号不一致 —— 跑 `node tools/bump-version.mjs <版本>` 一次写齐')
  process.exit(1)
}

const next = args.find((a) => !a.startsWith('-'))
if (!SEMVER.test(next ?? '')) {
  console.error(`❌ 版本号不合法：${next ?? '(没给)'} —— 期望形如 0.1.0 或 0.2.0-rc.1`)
  process.exit(1)
}

report()
console.log(`\n写入 v${next} …`)
for (const rel of [VERSION_SOURCE, ...VERSION_MIRRORS]) {
  const file = join(ROOT, ...rel.split('/'))
  const text = readFileSync(file, 'utf8')
  // 只认**顶层** version（两空格缩进）；依赖里的同名字段是四空格，不会被碰到
  let replaced = text.replace(/^(\s{2}"version"\s*:\s*)"[^"]*"/m, `$1"${next}"`)
  if (replaced === text) {
    // 还没有 version 字段 → 插在 "name" 那一行之后
    replaced = text.replace(/^(\s{2}"name"\s*:\s*"[^"]*",\n)/m, `$1  "version": "${next}",\n`)
  }
  if (replaced === text) {
    console.error(`❌ ${rel} 里既没有顶层 version，也没找到可插入的 name 字段`)
    process.exit(1)
  }
  writeFileSync(file, replaced, 'utf8')
  console.log(`  ✅ ${rel}`)
}
console.log(`\n✅ 三处都写成 v${next}`)
console.log('   提醒：插件卡片显示的版本要**重启 DSH** 才会刷新。')
