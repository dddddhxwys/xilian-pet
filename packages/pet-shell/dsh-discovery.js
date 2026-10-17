/**
 * 「DSH 在哪」的发现逻辑。
 *
 * 为什么需要（2026-10-12 实机）：桌宠原来把 DSH 地址写死成 `http://127.0.0.1:19387`，
 * 但 DSH 每次重启可能换端口（实测从 19387 变成了 **63974**）→ 桌宠一直
 * `SSE 连接失败：connect ECONNREFUSED 127.0.0.1:19387`，面板里也连不上。
 *
 * 优先级（从强到弱）：
 *  1. `PET_DSH_URL` —— 用户手动指定，永远优先（排障用）；
 *  2. `DSH_WEB_URL` —— 从 DSH 自己的终端里启动时，DSH 会注入这个环境变量；
 *  3. 默认端口 `http://127.0.0.1:19387` —— 老行为，能用就用；
 *  4. **自动发现**：枚举本机 loopback 的监听端口，并行探测 `/xilian-pet/health`，
 *     谁返回 `plugin: xilian-pet` 就是它；
 *  5. 都没找到 → 回退默认端口并**明确告诉用户可能连不上**（不要静默假装成功）。
 *
 * 本文件不碰 Electron，纯函数部分（解析 netstat / 判断响应）都可单测。
 */

import http from 'node:http'

/** 健康端点的响应里，`plugin` 字段是这个名字才认 */
export const PET_PLUGIN_NAME = 'xilian-pet'

/** 没发现时回退的默认地址（保持和老版本一致） */
export const DEFAULT_DSH_URL = 'http://127.0.0.1:19387'

/**
 * 从 `netstat -ano -p TCP` 的输出里解析出本机监听端口（去重、升序）。
 *
 * 真实行长这样（Windows，行首有空格）：
 *   `  TCP    127.0.0.1:63974        0.0.0.0:0              LISTENING       12345`
 *   `  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       912`
 *   `  TCP    [::]:445               [::]:0                 LISTENING       4`
 *
 * @param {string} netstatText
 * @param {{host?: string}} [options] host 只保留这个本机地址（默认 127.0.0.1）
 * @returns {number[]}
 */
export function parseListeningPorts(netstatText, options = {}) {
  const host = options.host ?? '127.0.0.1'
  if (typeof netstatText !== 'string') return []
  const ports = new Set()
  for (const line of netstatText.split(/\r?\n/)) {
    // 状态列：英文系统是 LISTENING；中文系统 netstat 仍输出英文，但保险起见也认"侦听"
    if (!/\bLISTENING\b/.test(line) && !line.includes('侦听')) continue
    const local = line.trim().split(/\s+/)[1]
    if (!local) continue
    const idx = local.lastIndexOf(':')
    if (idx <= 0) continue
    const address = local.slice(0, idx)
    const port = Number(local.slice(idx + 1))
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    // 只看 loopback（0.0.0.0 / [::] 也接受：能连 127.0.0.1 就说明服务在本机）
    if (address !== host && address !== '0.0.0.0' && address !== '[::]') continue
    ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/** 健康响应是不是桌宠插件的（纯函数） */
export function isPetHealthResponse(body) {
  return Boolean(body && typeof body === 'object' && body.plugin === PET_PLUGIN_NAME)
}

/**
 * 探测某个 baseUrl 上的桌宠健康端点。
 * @param {string} baseUrl 例如 http://127.0.0.1:63974
 * @param {string} prefix 路由前缀，默认 /xilian-pet
 * @param {number} timeoutMs
 * @returns {Promise<object|null>} 成功返回解析后的 JSON，失败返回 null（绝不抛错）
 */
export function probePetHealth(baseUrl, prefix = '/xilian-pet', timeoutMs = 300) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let request
    try {
      const url = new URL(`${baseUrl}${prefix}/health`)
      request = http.get({ hostname: url.hostname, port: url.port, path: url.pathname, timeout: timeoutMs }, (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          return done(null)
        }
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
          if (text.length > 200_000) request?.destroy()
        })
        response.on('end', () => {
          try {
            const body = JSON.parse(text)
            done(isPetHealthResponse(body) ? body : null)
          } catch {
            done(null)
          }
        })
      })
      request.on('timeout', () => {
        request.destroy()
        done(null)
      })
      request.on('error', () => done(null))
    } catch {
      done(null)
    }
  })
}

/**
 * 找到 DSH 的地址。
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} prefix 路由前缀
 * @param {{listListeningPorts?: () => number[], probe?: typeof probePetHealth}} [deps]
 *        测试可注入（默认不枚举端口；probe 默认真实探测）
 * @returns {Promise<{url:string, source:string}>}
 */
export async function resolveDshUrl(env, prefix = '/xilian-pet', deps = {}) {
  const { listListeningPorts } = deps
  const probe = deps.probe ?? probePetHealth
  if (env.PET_DSH_URL) return { url: env.PET_DSH_URL, source: 'PET_DSH_URL（手动指定）' }
  if (env.DSH_WEB_URL) return { url: env.DSH_WEB_URL, source: 'DSH_WEB_URL（从 DSH 终端启动）' }

  if (await probe(DEFAULT_DSH_URL, prefix)) {
    return { url: DEFAULT_DSH_URL, source: `默认端口 ${DEFAULT_DSH_URL.split(':').pop()} 可用` }
  }

  let ports = []
  if (typeof listListeningPorts === 'function') {
    try {
      ports = listListeningPorts()
    } catch {
      ports = []
    }
  }
  // 并行探测（每个 300ms 超时）：候选一般几十个，几百毫秒能出结果
  const candidates = ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
  const results = await Promise.all(
    candidates.map(async (port) => ({ port, ok: await probe(`http://127.0.0.1:${port}`, prefix) })),
  )
  const hit = results.find((r) => r.ok)
  if (hit) return { url: `http://127.0.0.1:${hit.port}`, source: `自动发现（扫描 ${candidates.length} 个监听端口）` }

  return {
    url: DEFAULT_DSH_URL,
    source: `⚠️ 没找到在线的 DSH（扫了 ${candidates.length} 个监听端口），回退默认端口 —— 大概率连不上，请确认 DSH 在运行`,
  }
}
