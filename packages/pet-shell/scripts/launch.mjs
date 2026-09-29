/**
 * 启动脚本 —— 负责处理两个本机特有的坑，然后拉起 Electron。
 *
 * 用法：
 *   node packages/pet-shell/scripts/launch.mjs            # 启动桌面窗
 *   node packages/pet-shell/scripts/launch.mjs --check     # 只做环境自检，不开窗
 *
 * 坑 1：ELECTRON_RUN_AS_NODE=1 由 DSH 宿主注入到本 shell 的环境里，
 *       Electron 见到它就当纯 node 跑（不开窗、静默退出）。
 *       注意必须 **删除** 该变量，设成空字符串没用 —— Electron 在 C++ 侧用
 *       getenv() != nullptr 判断，空串依然算存在。
 * 坑 2：Electron 默认把 userData 放在 AppData（agent shell 的沙箱写不进去），
 *       所以窗口状态与缓存目录都改到工作区内。
 */

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')

const checkOnly = process.argv.includes('--check')

let electronPath
try {
  electronPath = require('electron')
} catch (error) {
  console.error('[launch] 找不到 electron，先在仓库根目录执行 pnpm install：', error.message)
  process.exit(1)
}

const stateDir = join(packageDir, '.state')
const cacheDir = join(stateDir, 'cache')
const userDataDir = join(stateDir, 'user-data')
mkdirSync(cacheDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

env.PET_STATE_DIR = env.PET_STATE_DIR ?? stateDir
env.PET_DSH_URL = env.PET_DSH_URL ?? 'http://127.0.0.1:19387'
env.PET_ROUTE_PREFIX = env.PET_ROUTE_PREFIX ?? '/xilian-pet'

console.log('[launch] electron   =', electronPath)
console.log('[launch] DSH_URL    =', env.PET_DSH_URL)
console.log('[launch] prefix     =', env.PET_ROUTE_PREFIX)
console.log('[launch] state dir  =', env.PET_STATE_DIR)
console.log('[launch] ELECTRON_RUN_AS_NODE 已删除 =', !('ELECTRON_RUN_AS_NODE' in env))

if (checkOnly) {
  console.log('[launch] --check 模式，不启动窗口')
  process.exit(0)
}

// Electron 不认 ELECTRON_USER_DATA_DIR 环境变量，必须用 Chromium 的 --user-data-dir 开关；
// 放在应用路径之前最稳妥。默认 userData 在 AppData，沙箱写不进去。
const child = spawn(
  electronPath,
  [`--user-data-dir=${userDataDir}`, join(packageDir, 'main.js'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env,
    cwd: packageDir,
  },
)

child.on('exit', (code, signal) => {
  console.log(`[launch] electron 退出 code=${code} signal=${signal}`)
  process.exit(code ?? 0)
})
