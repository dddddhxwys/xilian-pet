/**
 * SSE 链路 —— **纯 Node，不依赖 Electron**。
 *
 * 为什么要单独抽一个模块：这样自测里可以用**真 HTTP 服务端**验它的行为，
 * 而不是去 grep main.js 的源码（源码正则断言在本项目已经害过一次，见 `docs/接手复核报告.md`）。
 *
 * ────────────────────────────────────────────────────────────────────
 * ⚠️ 这个模块存在的核心原因，是一个让桌宠"假活"很久的坑：
 *
 *   连接**非正常断开**时，Node 客户端**不会**触发 `res.on('end')`，
 *   也**不会**触发 `req.on('error')`。实测（Node v24）事件序列是：
 *
 *       res.data → res.aborted → req.close → res.error:ECONNRESET → res.close
 *
 *   而早前的实现只监听 `end` + `req.error`，于是断线后：
 *     · **小绿点永远显示"已连接"**（没人调 `onLink({connected:false})`）
 *     · **永不重连**（`scheduleRetry` 挂在那两个永远不会来的事件上）
 *     · **收不到 state 帧 → 状态冻结**（表现为"干活时没有思考动作"）
 *
 *   所以这里：① 该监听的事件**全监听**；② 再加一层"**沉默看门狗**"兜底
 *   （插件每 15s 发一次 `: ping`，超过 3 次没来就判定掉线 —— 半开连接连
 *   aborted/close 都不发时，这是唯一还能抓住它的手段）。
 * ────────────────────────────────────────────────────────────────────
 */
import http from 'node:http'

/** 插件心跳间隔是 15s（`pet-plugin` 的 `HEARTBEAT_MS`），3 次没来就认定死了 */
export const LINK_SILENCE_MS = 45_000
/** 看门狗检查频率 */
export const WATCH_INTERVAL_MS = 5_000
/** 重连退避上限 */
export const MAX_RETRY_MS = 10_000

/**
 * 建一条带自愈能力的 SSE 链路。
 *
 * @param {object} opts
 * @param {string|URL} opts.url             SSE 地址
 * @param {(msg:string)=>void} [opts.log]   日志
 * @param {(frame:object)=>void} [opts.onFrame] 收到一个 `data:` 帧
 * @param {(link:{connected:boolean,url?:string,error?:string})=>void} [opts.onLink] 链路状态变化
 * @param {number} [opts.silenceMs]         沉默多久判定掉线
 * @param {number} [opts.watchIntervalMs]   看门狗检查频率（自测会调小）
 * @param {()=>number} [opts.now]           取时间（自测可注入）
 * @param {Function} [opts.httpGet]         注入 http.get（自测可用假实现）
 * @returns {{start:Function, close:Function, readonly connected:boolean}}
 */
export function createSseLink({
  url,
  log = () => {},
  onFrame = () => {},
  onLink = () => {},
  silenceMs = LINK_SILENCE_MS,
  watchIntervalMs = WATCH_INTERVAL_MS,
  now = () => Date.now(),
  httpGet = http.get,
} = {}) {
  let request = null
  let connected = false
  let retryMs = 1_000
  let retryTimer = null
  let retryPending = false
  let watchTimer = null
  let lastDataAt = 0
  let closed = false

  function stopWatch() {
    if (watchTimer !== null) {
      clearInterval(watchTimer)
      watchTimer = null
    }
  }

  function startWatch() {
    stopWatch()
    watchTimer = setInterval(() => {
      if (!connected) return
      const silent = now() - lastDataAt
      if (silent > silenceMs) {
        linkDown(`心跳静默 ${Math.round(silent / 1000)}s（阈值 ${Math.round(silenceMs / 1000)}s）`)
      }
    }, watchIntervalMs)
    watchTimer.unref?.()
  }

  function scheduleRetry() {
    if (closed) return
    if (retryPending) return // 幂等：一次断开会连着触发好几个事件，别把退避反复翻倍
    retryPending = true
    const delay = retryMs
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
    retryTimer = setTimeout(() => {
      retryPending = false
      if (!closed) start()
    }, delay)
    retryTimer.unref?.()
  }

  /**
   * 链路断开 —— **唯一**入口，幂等。
   * 一次断开会连着触发 `aborted` / `close` / `error`，必须能重复调用而不产生副作用。
   */
  function linkDown(reason) {
    const was = connected
    connected = false
    stopWatch()
    if (request !== null) {
      try {
        request.destroy()
      } catch {
        /* ignore */
      }
      request = null
    }
    if (was) {
      log(`SSE 断开（${reason}）`)
      onLink({ connected: false, error: reason })
    }
    scheduleRetry()
  }

  function start() {
    if (closed) return
    if (request !== null) {
      try {
        request.destroy()
      } catch {
        /* ignore */
      }
      request = null
    }

    request = httpGet(url, (res) => {
      if (res.statusCode !== 200) {
        log(`SSE → HTTP ${res.statusCode}`)
        res.resume()
        linkDown(`HTTP ${res.statusCode}`)
        return
      }

      connected = true
      retryMs = 1_000
      lastDataAt = now()
      log(`SSE 已连接 ${url}`)
      onLink({ connected: true, url: String(url) })
      startWatch()

      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk) => {
        // ⚠️ 插件的 `: ping` 心跳也走这里 —— 它是"链路还活着"的唯一凭据
        lastDataAt = now()
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue // `: ping` 这类注释行直接忽略
            try {
              onFrame(JSON.parse(line.slice(5).trim()))
            } catch (error) {
              log(`帧解析失败：${error?.message ?? error}`)
            }
          }
        }
      })

      // ⚠️⚠️ 这几个**一个都不能少**：非正常断开时 `end` 根本不触发（见文件头注释）
      res.on('end', () => linkDown('end'))
      res.on('aborted', () => linkDown('aborted'))
      res.on('close', () => linkDown('close'))
      res.on('error', (error) => linkDown(`res error: ${error?.message ?? error}`))
    })

    request.on('error', (error) => {
      log(`SSE 连接失败：${error?.message ?? error}`)
      linkDown(error?.message ?? String(error))
    })
  }

  start()

  return {
    start,
    get connected() {
      return connected
    },
    close() {
      closed = true
      clearTimeout(retryTimer)
      retryPending = false
      stopWatch()
      if (request !== null) {
        try {
          request.destroy()
        } catch {
          /* ignore */
        }
        request = null
      }
    },
  }
}
