/**
 * 最小 ZIP 写入器（**自己写的原因**：Windows 上 `Compress-Archive` 和
 * `System.IO.Compression.ZipFile.CreateFromDirectory` **都把条目名写成反斜杠**
 * （`xilian-pet\安装.cmd`），而 ZIP 规范要求正斜杠 `/`。
 * Windows 自带解压能容忍，但 7-Zip / macOS / WSL 可能解出一个叫
 * `xilian-pet\安装.cmd` 的怪文件 —— 给朋友的东西不能带这种地雷。）
 *
 * 只实现需要的部分：deflate/store、UTF-8 名字（bit 11）、目录条目、EOCD。
 * 不支持 ZIP64（本用途不需要：单文件 < 4 GB、总数 < 65535）。
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间格式（ZIP 用） */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** 用到的父目录条目（含结尾的 `/`），让解压工具不依赖"隐式建目录" */
function directoryEntries(names) {
  const dirs = new Set()
  for (const name of names) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  return [...dirs].sort()
}

function localHeader({ nameBuf, crc, bodyLength, rawLength, method, time, day, isDir }) {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4) // version needed
  header.writeUInt16LE(0x0800, 6) // ⚠️ bit 11 = 文件名是 UTF-8（中文路径必需）
  header.writeUInt16LE(method, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(day, 12)
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(bodyLength, 18)
  header.writeUInt32LE(rawLength, 22)
  header.writeUInt16LE(nameBuf.length, 26)
  header.writeUInt16LE(0, 28)
  void isDir
  return header
}

function centralHeader({ nameBuf, crc, bodyLength, rawLength, method, time, day, isDir, offset }) {
  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt16LE(20, 4) // version made by
  cd.writeUInt16LE(20, 6) // version needed
  cd.writeUInt16LE(0x0800, 8)
  cd.writeUInt16LE(method, 10)
  cd.writeUInt16LE(time, 12)
  cd.writeUInt16LE(day, 14)
  cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(bodyLength, 20)
  cd.writeUInt32LE(rawLength, 24)
  cd.writeUInt16LE(nameBuf.length, 28)
  cd.writeUInt16LE(0, 30) // extra
  cd.writeUInt16LE(0, 32) // comment
  cd.writeUInt16LE(0, 34) // disk start
  cd.writeUInt16LE(0, 36) // internal attrs
  cd.writeUInt32LE(isDir ? 0x10 : 0, 38) // external attrs：目录位
  cd.writeUInt32LE(offset, 42)
  return cd
}

/** 把一个 raw buffer 变成 (method, body) —— 压不小就原样存 */
function encode(raw) {
  if (raw.length === 0) return { method: 0, body: raw }
  const deflated = deflateRawSync(raw, { level: 6 })
  if (deflated.length >= raw.length) return { method: 0, body: raw }
  return { method: 8, body: deflated }
}

/**
 * 流式写 zip 到文件（**不把整包读进内存**：完整版有 371 MB）。
 * @param {string} outPath
 * @param {{name:string, absPath:string}[]} files name 用 `/` 分隔
 * @param {{mtime?:Date, log?:Function}} [options]
 * @returns {{entries:number, bytes:number}}
 */
export function writeZipFile(outPath, files, options = {}) {
  const log = options.log ?? (() => {})
  const date = options.mtime ?? new Date()
  const { time, day } = dosDateTime(date)
  const fd = openSync(outPath, 'w')
  let offset = 0
  const central = []
  const write = (buf) => {
    writeSync(fd, buf)
    offset += buf.length
  }
  try {
    const all = [
      ...directoryEntries(files.map((f) => f.name)).map((name) => ({ name, absPath: null })),
      ...files,
    ]
    for (const entry of all) {
      const isDir = entry.absPath === null
      const nameBuf = Buffer.from(entry.name, 'utf8')
      const raw = isDir ? Buffer.alloc(0) : readFileSync(entry.absPath)
      const { method, body } = encode(raw)
      const crc = crc32(raw)
      const start = offset
      write(localHeader({ nameBuf, crc, bodyLength: body.length, rawLength: raw.length, method, time, day, isDir }))
      write(nameBuf)
      if (body.length > 0) write(body)
      central.push(
        centralHeader({ nameBuf, crc, bodyLength: body.length, rawLength: raw.length, method, time, day, isDir, offset: start }),
        nameBuf,
      )
    }
    const centralOffset = offset
    for (const buf of central) write(buf)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(all.length, 8)
    eocd.writeUInt16LE(all.length, 10)
    eocd.writeUInt32LE(offset - centralOffset, 12)
    eocd.writeUInt32LE(centralOffset, 16)
    eocd.writeUInt16LE(0, 20)
    write(eocd)
    log(`  写入 ${all.length} 个条目（含 ${all.length - files.length} 个目录）`)
    return { entries: all.length, bytes: offset }
  } finally {
    closeSync(fd)
  }
}

/**
 * 纯函数版（小输入用，便于自测）：返回 zip 的 Buffer。
 * @param {{name:string, data:Buffer}[]} entries
 */
export function writeZipToBuffer(entries, options = {}) {
  const { time, day } = dosDateTime(options.mtime ?? new Date())
  const chunks = []
  const central = []
  let offset = 0
  const all = [
    ...directoryEntries(entries.map((e) => e.name)).map((name) => ({ name, data: Buffer.alloc(0), isDir: true })),
    ...entries.map((e) => ({ ...e, isDir: false })),
  ]
  for (const entry of all) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const { method, body } = encode(raw)
    const crc = crc32(raw)
    const start = offset
    const lh = localHeader({ nameBuf, crc, bodyLength: body.length, rawLength: raw.length, method, time, day, isDir: entry.isDir })
    chunks.push(lh, nameBuf, body)
    offset += lh.length + nameBuf.length + body.length
    central.push(
      centralHeader({
        nameBuf, crc, bodyLength: body.length, rawLength: raw.length, method, time, day,
        isDir: entry.isDir, offset: start,
      }),
      nameBuf,
    )
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(all.length, 8)
  eocd.writeUInt16LE(all.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, eocd])
}
