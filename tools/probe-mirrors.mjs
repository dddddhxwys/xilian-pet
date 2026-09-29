/**
 * 实测各 Electron 镜像的下载速度（只取前 3MB），并检查是否支持 Range 分段下载。
 * 支持 Range 是并行下载提速的前提。
 */

const version = '44.4.5'
const file = `electron-v${version}-win32-x64.zip`
const mirrors = [
  ['npmmirror(binary)', `https://registry.npmmirror.com/-/binary/electron/${version}/${file}`],
  ['npmmirror(mirrors)', `https://npmmirror.com/mirrors/electron/${version}/${file}`],
  ['npmmirror(cdn)', `https://cdn.npmmirror.com/binaries/electron/${version}/${file}`],
  ['huaweicloud', `https://mirrors.huaweicloud.com/electron/${version}/${file}`],
  ['tuna', `https://mirrors.tuna.tsinghua.edu.cn/electron/${version}/${file}`],
  ['nju', `https://mirror.nju.edu.cn/electron/${version}/${file}`],
  ['ustc', `https://mirrors.ustc.edu.cn/electron/${version}/${file}`],
  ['aliyun', `https://mirrors.aliyun.com/electron/${version}/${file}`],
]

const PROBE = 3 * 1024 * 1024
const results = []

for (const [name, url] of mirrors) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      headers: { range: `bytes=0-${PROBE - 1}` },
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) {
      console.log(`${name.padEnd(20)} HTTP ${res.status}  ${url}`)
      continue
    }
    const range = res.headers.get('content-range')
    const total = range ? Number(range.split('/')[1]) : Number(res.headers.get('content-length') ?? 0)
    let bytes = 0
    for await (const chunk of res.body) bytes += chunk.length
    const ms = Date.now() - started
    const kbps = Math.round(bytes / 1024 / (ms / 1000))
    results.push({ name, url, kbps, ms, bytes, total, range: range !== null })
    console.log(
      `${name.padEnd(20)} ${String(res.status).padEnd(4)} ${(bytes / 1048576).toFixed(2)} MB  ` +
        `${String(ms).padStart(6)}ms  ${String(kbps).padStart(5)} KB/s  ` +
        `Range=${range !== null ? '支持' : '不支持'}  总大小=${(total / 1048576).toFixed(1)}MB`,
    )
  } catch (error) {
    console.log(`${name.padEnd(20)} FAIL  ${error.message}`)
  }
}

results.sort((a, b) => b.kbps - a.kbps)
console.log('\n按实测速度排序：')
for (const r of results) console.log(`  ${String(r.kbps).padStart(6)} KB/s  ${r.name}`)
if (results.length > 0) {
  console.log(`\n最快：${results[0].name}`)
  console.log(`预计下载 150.9MB 用时：${Math.round(150.9 * 1024 / results[0].kbps / 60 * 10) / 10} 分钟`)
}
