/**
 * 检查更新（命令行）—— 只读：不改任何文件、不下载 zip、不碰 profile。
 *
 * 用法：
 *   node tools/check-update.mjs                  用户主动查：**失败如实说出来**
 *   node tools/check-update.mjs --quiet          安装时用：**只在"确实有新版"时出声**
 *   node tools/check-update.mjs --json           机器可读（给以后的自动化用）
 *   node tools/check-update.mjs --source=<url>   指定清单地址（自测 / 自建源）
 *   node tools/check-update.mjs --timeout=<ms>   单个来源超时（默认 3500，--quiet 时 2500）
 *
 * 退出码：0 已最新 / 10 有新版本 / 1 检查失败（**--quiet 下失败也是 0** —— 见下面注释）
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UPDATE_EXIT, checkForUpdate, formatCheckResult, readLocalRelease } from './lib/update-check.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const asJson = argv.includes('--json')
const sourceArg = argv.find((a) => a.startsWith('--source='))
const timeoutArg = argv.find((a) => a.startsWith('--timeout='))

const local = readLocalRelease(ROOT)
const result = await checkForUpdate({
  localVersion: local.version,
  localFlavor: local.flavor,
  // undefined → 用库里的默认来源表（有序，加镜像即加一行）
  sources: sourceArg === undefined ? undefined : [sourceArg.slice('--source='.length)],
  timeoutMs: timeoutArg === undefined ? (quiet ? 2500 : 3500) : Number(timeoutArg.slice('--timeout='.length)),
  // ⚠️ 安装时（--quiet）总预算卡在 4 秒：不能让一个装饰性检查把安装流程拖住
  totalBudgetMs: quiet ? 4000 : undefined,
})

/**
 * 退出码。
 * ⚠️ `--quiet` 下**失败也返回 0**：它被 setup.mjs 的安装流程调用，
 *    非零退出码会被上层读成"安装有问题"。安静模式的设计前提就是"失败了也当没这回事"。
 */
const exitCode =
  result.status === 'available'
    ? UPDATE_EXIT.AVAILABLE
    : result.status === 'failed'
      ? quiet
        ? UPDATE_EXIT.UP_TO_DATE
        : UPDATE_EXIT.FAILED
      : UPDATE_EXIT.UP_TO_DATE

if (asJson) {
  console.log(JSON.stringify({ ...result, exitCode, localFrom: local.from }, null, 2))
} else {
  if (!quiet) {
    console.log('昔涟桌宠 · 检查更新')
    console.log('─'.repeat(46))
  }
  for (const line of formatCheckResult(result, { quiet })) console.log(line)
  if (!quiet && result.status === 'failed') {
    console.log('')
    console.log('  （这份输出可以直接发给开发者，它说明了"试过哪些来源、各自怎么失败"）')
  }
}

process.exit(exitCode)
