/**
 * 下载便携版 `node.exe` 到 `.cache/node/` —— 给"**零前置**"发行包用。
 *
 * 为什么要它：桌宠的启动器是 Node 脚本，而朋友的机器上可能
 *   · 没装 Node.js，而且
 *   · 装了 DSH 也**未必**有运行时（实测：DSH 的运行时在首次启动时解包，
 *     但也有人的 DSH 就是没有 dsh-runtimes —— 两轮远程排查都卡在这）
 * 包里自带一个 node.exe，这两个前提就都不需要了。
 *
 * 为什么是一个文件而不是整包：Node 官方为 win-x64 提供**单文件** `node.exe`
 * （约 89 MB），下载即可用，不需要解压。
 *
 * 用法：node tools/fetch-node.mjs [--force]
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const cacheDir = join(root, '.cache', 'node')
const exePath = join(cacheDir, 'node.exe')
const licensePath = join(cacheDir, 'LICENSE')

// 与本机 DSH 运行时一致的版本（`node -v` 实测 v24.21.0）
const VERSION = process.env.PET_NODE_VERSION ?? 'v24.21.0'
const force = process.argv.includes('--force')

const mirrors = [
  process.env.PET_NODE_MIRROR,
  // 国内实测可用（HEAD 200 / 89.2 MB）
  'https://npmmirror.com/mirrors/node',
  'https://registry.npmmirror.com/-/binary/node',
  'https://nodejs.org/dist',
].filter(Boolean)

/**
 * 校验一个候选 node.exe：能跑起来才算数。
 * ⚠️ **不能只看文件大小** —— 下载被打断会留下残包（实测：64.5 MB / 89 MB 的半个文件
 *    也会通过">50 MB"这种粗糙判断），而残包跑到一半才炸，很难查。
 */
function isUsableNode(exe) {
  const check = spawnSync(exe, ['-v'], { stdio: 'ignore', timeout: 30_000 })
  return check.status === 0
}

/** 复用已下载的（除非 --force） */
if (existsSync(exePath) && !force && isUsableNode(exePath)) {
  const size = statSync(exePath).size
  console.log(`✅ 已存在且可用：${exePath}（${(size / 1048576).toFixed(1)} MB）`)
  process.exit(0)
}
if (existsSync(exePath)) {
  console.log('已有文件不可用（残包），删除后重新下载。')
  rmSync(exePath, { force: true })
}

mkdirSync(cacheDir, { recursive: true })

async function download(url, dest, label) {
  console.log(`  ${label} ← ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('没有响应体')
  await pipeline(res.body, createWriteStream(dest))
  const size = statSync(dest).size
  console.log(`    完成：${(size / 1048576).toFixed(1)} MB`)
  return size
}

console.log(`准备便携 Node ${VERSION}（win-x64）…`)
console.log('探测镜像…')

let ok = false
for (const base of mirrors) {
  const url = `${base}/${VERSION}/win-x64/node.exe`
  try {
    const size = await download(url, exePath, 'node.exe')
    if (size < 50 * 1024 * 1024) throw new Error(`文件太小（${size} 字节），可能是错误页`)
    // PE 头校验：'MZ'
    const head = readFileSync(exePath).subarray(0, 2).toString('latin1')
    if (head !== 'MZ') throw new Error(`不是 PE 可执行文件（头=${JSON.stringify(head)}）`)
    ok = true
    break
  } catch (error) {
    console.log(`    失败：${error.message}`)
    rmSync(exePath, { force: true })
  }
}

if (!ok) {
  console.error('\n❌ 所有镜像都失败了。请检查网络，或设 PET_NODE_MIRROR 指向可用镜像。')
  process.exit(1)
}

// 顺手把授权文件也拉下来（Node 是 MIT，随包分发必须带 LICENSE）
for (const base of mirrors) {
  try {
    await download(`${base}/${VERSION}/LICENSE`, licensePath, 'LICENSE')
    break
  } catch {
    /* 拿不到就自己写一份说明，别让整件事失败 */
  }
}
if (!existsSync(licensePath)) {
  writeFileSync(
    licensePath,
    `Node.js is licensed for use as follows:\n\nCopyright Node.js contributors. All rights reserved.\n\n` +
      `Permission is hereby granted, free of charge, to any person obtaining a copy of this software\n` +
      `and associated documentation files (the "Software"), to deal in the Software without\n` +
      `restriction, including without limitation the rights to use, copy, modify, merge, publish,\n` +
      `distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the\n` +
      `Software is furnished to do so, subject to the following conditions:\n\n` +
      `The above copyright notice and this permission notice shall be included in all copies or\n` +
      `substantial portions of the Software.\n\n` +
      `THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n\n` +
      `Full license: https://github.com/nodejs/node/blob/main/LICENSE\n`,
    'utf8',
  )
  console.log('  （镜像上没有 LICENSE，已写入一份 MIT 摘要）')
}

// 功能校验：**真的能跑**才算数（stdio 用 inherit：受限沙箱下管道会 EPERM）
console.log('\n校验：运行 node.exe -v …')
const check = spawnSync(exePath, ['-v'], { stdio: 'inherit' })
if (check.status !== 0) {
  console.error(`\n❌ 下载到的 node.exe 跑不起来（退出码 ${check.status}）`)
  process.exit(1)
}
console.log(`\n✅ 便携 Node 就绪：${exePath}`)
console.log('   打包时加 --with-node 就会把它放进发行包的 node/ 目录。')
