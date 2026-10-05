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
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const rootDir = join(packageDir, '..', '..')

const checkOnly = process.argv.includes('--check')

/**
 * 找 Electron 可执行文件。
 *
 * ⚠️ **不能**只靠 `require('electron')`：发给朋友的**精简包**里没有
 *    `node_modules/electron` 这个 npm 包（只有 `tools/fetch-electron.mjs` 下载来的
 *    `dist/`），那时 `require('electron')` 会抛 —— 启动器直接挂掉。
 *    所以直连 dist 路径，require 只作为"pnpm 正常安装过"时的兜底。
 */
function resolveElectronPath() {
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const candidates = [
    process.env.ELECTRON_OVERRIDE_DIST_PATH
      ? join(process.env.ELECTRON_OVERRIDE_DIST_PATH, exeName)
      : null,
    join(rootDir, 'node_modules', 'electron', 'dist', exeName),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return require('electron')
}

let electronPath
try {
  electronPath = resolveElectronPath()
} catch (error) {
  console.error(
    '[launch] 找不到 Electron 可执行文件。\n' +
      '  先跑一次下载：node tools/fetch-electron.mjs\n' +
      `  原因：${error.message}`,
  )
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

// 坑 3（实测）：Chromium 自带的沙箱在 agent shell 的受限令牌下初始化会直接失败 ——
// `electron.exe --version` 退出码 0x80000003（STATUS_BREAKPOINT）且没有任何输出；
// 加上 `--no-sandbox` 就能正常打印 v44.4.5。所以启动前探测一次，失败就自动放宽。
// 放宽的理由：宠物页面只加载本地文件（CSP 里 connect-src 'none'、img/script 仅 'self'），
// 不加载任何远程内容，renderer 沙箱在这里不是主要防线。你自己终端里跑则会走默认沙箱。
const relaxFlags = []
if (process.env.PET_FORCE_NO_SANDBOX === '1') {
  relaxFlags.push('--no-sandbox', '--disable-gpu')
  console.log('[launch] PET_FORCE_NO_SANDBOX=1，直接使用放宽参数')
} else {
  // stdio: 'ignore' 是刻意的 —— 受限沙箱下管道 stdio 会 EPERM，而我们只需要退出码
  const probe = spawnSync(electronPath, ['--version'], { env, stdio: 'ignore', timeout: 20_000 })
  if (probe.status === 0) {
    console.log('[launch] Chromium 沙箱探测通过，使用默认沙箱设置')
  } else {
    relaxFlags.push('--no-sandbox', '--disable-gpu')
    console.log(`[launch] Chromium 沙箱探测失败（exit=${probe.status}）→ 自动追加 ${relaxFlags.join(' ')}`)
    console.log('[launch] 原因：受限令牌下 Chromium 无法初始化自带沙箱；宠物只加载本地文件，风险可控')
  }
}

if (checkOnly) {
  console.log('[launch] --check 模式，不启动窗口')
  process.exit(0)
}

// Electron 不认 ELECTRON_USER_DATA_DIR 环境变量，必须用 Chromium 的 --user-data-dir 开关；
// 放在应用路径之前最稳妥。默认 userData 在 AppData，沙箱写不进去。
const child = spawn(
  electronPath,
  [
    ...relaxFlags,
    `--user-data-dir=${userDataDir}`,
    join(packageDir, 'main.js'),
    ...process.argv.slice(2),
  ],
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
