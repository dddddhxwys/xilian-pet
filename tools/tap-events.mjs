/**
 * 桌宠事件探针 —— 连上 Host 插件的 SSE，把收到的帧打印出来。
 *
 * 用途：不开 Electron 窗口也能验证插件的数据源是否正常
 *      （hello / snapshot / notices / state / stream / notice 各帧）。
 *
 * 用法：
 *   node tools/tap-events.mjs          # 连 5 秒
 *   node tools/tap-events.mjs 20       # 连 20 秒
 *   PET_ROUTE_PREFIX=/xilian-pet node tools/tap-events.mjs
 */

const base = process.env.PET_DSH_URL ?? 'http://127.0.0.1:19387'
const prefix = (process.env.PET_ROUTE_PREFIX ?? '/xilian-pet').replace(/\/+$/, '')
const seconds = Number(process.argv[2] ?? 5)
const url = `${base}${prefix}/events`

console.log(`连接 ${url}（${seconds} 秒后自动断开）\n`)

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), seconds * 1000)

try {
  const res = await fetch(url, { signal: controller.signal })
  if (res.status !== 200) {
    console.error(`HTTP ${res.status} —— 插件未加载？先看 ${base}${prefix}/health`)
    process.exit(1)
  }
  console.log(`HTTP ${res.status} ${res.headers.get('content-type')}\n`)

  const decoder = new TextDecoder()
  let buffer = ''
  let count = 0
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) {
          console.log(`  · ${line.slice(1).trim()}`) // SSE 注释（connected / ping）
        } else if (line.startsWith('data:')) {
          count++
          const text = line.slice(5).trim()
          let pretty = text
          try {
            pretty = JSON.stringify(JSON.parse(text))
          } catch {
            /* 原样打印 */
          }
          console.log(`  [${String(count).padStart(2)}] ${pretty.slice(0, 400)}`)
        }
      }
    }
  }
  console.log(`\n共收到 ${count} 帧`)
} catch (error) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    console.log(`\n（到时断开，正常）`)
  } else {
    console.error(`连接失败：${error.message}`)
    process.exit(1)
  }
} finally {
  clearTimeout(timer)
}
