/**
 * 下载并安装 Electron 二进制到 node_modules/electron/dist。
 *
 * 为什么不直接用 electron 自带的 install.js（实测踩坑记录）：
 *  - 它把 zip 缓存写到 `%LOCALAPPDATA%\electron\Cache`（`electron_config_cache`，**小写**），
 *    属于 agent shell 沙箱的写边界之外 → 静默失败；
 *  - 即使把缓存改到工作区内，它在本机也会**空转**（进程 CPU 0、无网络连接、10 分钟无输出），
 *    原因是它内部的重试/回退逻辑撞上不可达的 github.com。
 *
 * 所以这里自己来，全程可观测：
 *  1. 用 node 的 fetch 流式下载（node 自带 OpenSSL，不受本机 Schannel 故障影响）
 *  2. 用纯 JS 解 zip（zlib.inflateRawSync），不依赖外部 unzip / Expand-Archive
 *  3. 写 path.txt，与官方 install.js 的产物保持一致
 *
 * 用法：node tools/fetch-electron.mjs        （= pnpm run deps:electron）
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { inflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const electronDir = join(root, 'node_modules', 'electron')
const distDir = join(electronDir, 'dist')
const cacheDir = join(root, '.cache', 'electron')

if (!existsSync(join(electronDir, 'package.json'))) {
  console.error('找不到 node_modules/electron —— 先在仓库根目录执行 pnpm install')
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version
const platform = process.platform
const arch = process.arch
const exeName = platform === 'win32' ? 'electron.exe' : 'electron'
const zipName = `electron-v${version}-${platform}-${arch}.zip`

if (existsSync(join(distDir, exeName))) {
  console.log(`✅ 已安装：${join(distDir, exeName)}`)
  process.exit(0)
}

const mirrors = [
  process.env.ELECTRON_MIRROR,
  // 实测（tools/probe-mirrors.mjs）：华为云 ~4 MB/s 且支持 Range；npmmirror 只有 ~85 KB/s。
  'https://mirrors.huaweicloud.com/electron/',
  'https://registry.npmmirror.com/-/binary/electron/',
  'https://cdn.npmmirror.com/binaries/electron/',
  'https://npmmirror.com/mirrors/electron/',
].filter(Boolean)

const PARTS = Number(process.env.ELECTRON_DOWNLOAD_PARTS ?? 8)

mkdirSync(cacheDir, { recursive: true })
const zipPath = join(cacheDir, zipName)

// ── 1. 下载（镜像探测 + 分段并行）──────────────────────────────────
// 复用门槛设成 50MB：Electron 的 zip 约 150MB，低于此值必然是上次中断的残包。
// （曾因为门槛设成 1MB，把 2.86MB 的残包当成"已下载"而复用。）
if (existsSync(zipPath) && (await stat(zipPath)).size > 50_000_000) {
  console.log(`复用已下载的 zip：${zipPath}（${(await stat(zipPath)).size} 字节）`)
} else {
  if (existsSync(zipPath)) {
    console.log(`发现疑似残包（${(await stat(zipPath)).size} 字节），删除后重新下载。`)
    const { rmSync } = await import('node:fs')
    rmSync(zipPath, { force: true })
  }

  console.log(`electron 版本 : ${version} (${platform}-${arch})`)
  console.log('探测镜像…')

  let picked
  for (const mirror of mirrors) {
    const candidate = `${mirror.replace(/\/+$/, '')}/${version}/${zipName}`
    const probe = await probeMirror(candidate)
    if (probe) {
      picked = { ...probe, url: candidate }
      console.log(`  可用：${new URL(candidate).host}  总大小 ${(probe.total / 1048576).toFixed(1)} MB  Range=${probe.ranged ? '支持' : '不支持'}`)
      if (probe.ranged) break
    } else {
      console.log(`  不可用：${new URL(candidate).host}`)
    }
  }
  if (!picked) {
    console.error('所有镜像都不可用。检查网络，或手工把 zip 放到：' + zipPath)
    process.exit(1)
  }

  console.log(`\n开始下载：${picked.url}`)
  console.log(`并发分段：${picked.ranged ? PARTS : 1}（不支持 Range 时退化为单连接）\n`)

  const partPath = `${zipPath}.part`
  const startedAt = Date.now()
  let received = 0
  let lastPct = -5

  const onBytes = (n) => {
    received += n
    const pct = Math.floor((received / picked.total) * 100)
    if (pct >= lastPct + 5) {
      lastPct = pct
      const seconds = (Date.now() - startedAt) / 1000
      const kbps = Math.round(received / 1024 / Math.max(seconds, 0.001))
      process.stdout.write(
        `  ${String(pct).padStart(3)}%  ${(received / 1048576).toFixed(1)}/${(picked.total / 1048576).toFixed(1)} MB  ${kbps} KB/s\n`,
      )
    }
  }

  try {
    if (picked.ranged) {
      await downloadParallel(picked.url, picked.total, partPath, PARTS, onBytes)
    } else {
      await downloadSingle(picked.url, partPath, onBytes)
    }
  } catch (error) {
    console.error(`\n下载失败：${error.message}`)
    console.error(`已下 ${(received / 1048576).toFixed(1)} MB。重新执行本脚本会从头再来。`)
    process.exit(1)
  }

  const size = (await stat(partPath)).size
  if (size !== picked.total) {
    console.error(`大小不符（期望 ${picked.total}，实际 ${size}），丢弃。`)
    process.exit(1)
  }
  const { renameSync } = await import('node:fs')
  renameSync(partPath, zipPath)
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  console.log(`\n下载完成：${size} 字节，用时 ${seconds}s`) 
}

// ── 2. 纯 JS 解 zip ─────────────────────────────────────────────────
console.log('\n解压中…')
let count
try {
  count = await extractZip(zipPath, distDir)
} catch (error) {
  const { rmSync } = await import('node:fs')
  rmSync(zipPath, { force: true })
  console.error(`\n❌ 解压失败：${error.message}`)
  console.error('   zip 已删除（可能下载不完整或损坏），重新执行本脚本即可。')
  process.exit(1)
}
console.log(`解出 ${count} 个条目 → ${distDir}`)

// ── 3. path.txt + 校验 ──────────────────────────────────────────────
writeFileSync(join(electronDir, 'path.txt'), exeName)
const exePath = join(distDir, exeName)
if (!existsSync(exePath)) {
  console.error(`❌ 解压后仍找不到 ${exePath}`)
  process.exit(1)
}
const exeStat = await stat(exePath)
console.log(`\n✅ Electron 就绪：${exePath}（${(exeStat.size / 1048576).toFixed(1)} MB）`)
console.log('   下一步：node packages/pet-shell/scripts/launch.mjs --check')

// ─────────────────────────────────────────────────────────────────────
/** 探测镜像：可达性 + 总大小 + 是否支持 Range（支持才能并行分段） */
async function probeMirror(url) {
  try {
    const res = await fetch(url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const contentRange = res.headers.get('content-range')
    const total = contentRange
      ? Number(contentRange.split('/')[1])
      : Number(res.headers.get('content-length') ?? 0)
    await res.body?.cancel()
    if (!Number.isFinite(total) || total <= 0) return null
    return { total, ranged: contentRange !== null }
  } catch {
    return null
  }
}

/** 分段并行下载：预分配文件，每段用 Range 写到自己的偏移位置，各自独立重试 */
async function downloadParallel(url, total, dest, parts, onBytes) {
  const handle = await open(dest, 'w')
  try {
    await handle.truncate(total)
    const span = Math.ceil(total / parts)
    const tasks = []
    for (let i = 0; i < parts; i++) {
      const start = i * span
      const end = Math.min(start + span, total) - 1
      if (start > end) break
      tasks.push(downloadRange(handle, url, start, end, onBytes))
    }
    await Promise.all(tasks)
  } finally {
    await handle.close()
  }
}

async function downloadRange(handle, url, start, end, onBytes) {
  const expected = end - start + 1
  let lastError
  for (let attempt = 1; attempt <= 4; attempt++) {
    let offset = start
    try {
      const res = await fetch(url, {
        headers: { range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      for await (const chunk of res.body) {
        await handle.write(chunk, 0, chunk.length, offset)
        offset += chunk.length
        onBytes(chunk.length)
      }
      const got = offset - start
      if (got !== expected) throw new Error(`分段长度不符 ${got} != ${expected}`)
      return
    } catch (error) {
      lastError = error
      onBytes(-(offset - start)) // 回退该段已计入的字节，避免进度虚高
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  throw new Error(`分段 ${start}-${end} 重试 4 次仍失败：${lastError?.message}`)
}

/** 不支持 Range 时退化为单连接流式下载 */
async function downloadSingle(url, dest, onBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // 用 PassThrough 计数，这样既能报进度又不破坏 pipeline 的背压
  const counter = new PassThrough()
  counter.on('data', (chunk) => onBytes?.(chunk.length))
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest))
}

// ─────────────────────────────────────────────────────────────────────
/** 读中央目录 → 逐个解压。支持 ZIP64 定位器。 */
async function extractZip(zipFile, outDir) {
  const fileSize = (await stat(zipFile)).size
  const tailLength = Math.min(fileSize, 66_000)
  const handle = await open(zipFile, 'r')
  try {
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, fileSize - tailLength)

    const eocdOffset = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (eocdOffset === -1) throw new Error('找不到 EOCD 记录，不是合法 zip')

    let totalEntries = tail.readUInt16LE(eocdOffset + 10)
    let cdSize = tail.readUInt32LE(eocdOffset + 12)
    let cdOffset = tail.readUInt32LE(eocdOffset + 16)

    // ZIP64：EOCD 前 20 字节是 ZIP64 EOCD 定位器
    const locatorOffset = eocdOffset - 20
    if (locatorOffset >= 0 && tail.readUInt32LE(locatorOffset) === 0x07064b50) {
      const z64Offset = Number(tail.readBigUInt64LE(locatorOffset + 8))
      const z64 = Buffer.alloc(56)
      await handle.read(z64, 0, 56, z64Offset)
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 EOCD 签名不符')
      totalEntries = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
      console.log(`  ZIP64：${totalEntries} 个条目`)
    }

    const cd = Buffer.alloc(cdSize)
    await handle.read(cd, 0, cdSize, cdOffset)

    let cursor = 0
    let written = 0
    for (let i = 0; i < totalEntries; i++) {
      if (cd.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`中央目录条目 ${i} 签名不符`)
      const method = cd.readUInt16LE(cursor + 10)
      const compressedSize = cd.readUInt32LE(cursor + 20)
      const uncompressedSize = cd.readUInt32LE(cursor + 24)
      const nameLength = cd.readUInt16LE(cursor + 28)
      const extraLength = cd.readUInt16LE(cursor + 30)
      const commentLength = cd.readUInt16LE(cursor + 32)
      const localOffset = cd.readUInt32LE(cursor + 42)
      const name = cd.toString('utf8', cursor + 46, cursor + 46 + nameLength)
      cursor += 46 + nameLength + extraLength + commentLength

      if (name.endsWith('/')) {
        mkdirSync(join(outDir, ...name.split('/').filter(Boolean)), { recursive: true })
        continue
      }

      // 本地头：跳过它自己的 name/extra（长度可能与中央目录不同）
      const localHeader = Buffer.alloc(30)
      await handle.read(localHeader, 0, 30, localOffset)
      if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new Error(`本地头签名不符：${name}`)
      const dataStart = localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28)

      const compressed = Buffer.alloc(compressedSize)
      await handle.read(compressed, 0, compressedSize, dataStart)

      let content
      if (method === 0) content = compressed
      else if (method === 8) content = inflateRawSync(compressed)
      else throw new Error(`不支持的压缩方法 ${method}（${name}）`)

      if (content.length !== uncompressedSize) {
        throw new Error(`解压大小不符 ${name}：${content.length} != ${uncompressedSize}`)
      }

      const target = join(outDir, ...name.split('/').filter(Boolean))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      written++
    }
    return written
  } finally {
    await handle.close()
  }
}
