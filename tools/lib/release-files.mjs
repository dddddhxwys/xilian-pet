/**
 * 发行包**收哪些文件** —— 纯逻辑，单独放是为了能自测。
 *
 * ⚠️ 两个层次都要管，缺一个就会静默出错（实测踩过）：
 *    · `shouldInclude(路径)`  —— 单个**文件**收不收
 *    · `shouldDescend(目录)`  —— 遍历时**进不进**这个目录
 *   只测前者不够：`node_modules` 整个被剪掉时，`--with-electron` 会静默失效。
 *
 * 设计原则：
 *   1. 默认收"整个源码树"，只排除**体积大 / 机器相关 / 第三方素材 / 开发产物**四类；
 *   2. 三个 gitignore 掉但**发行必需**的东西要显式加回来：
 *        · `packages/pet-shell/renderer/vendor/`  —— 渲染端 5 个脚本（0.78 MB）。
 *          加回来之后朋友**不需要 pnpm install**，这是"开包即用"的前提。
 *        · `assets/live2d/Cyrene/`               —— 模型（1.4 MB），用 --with-model 控制。
 *        · `node_modules/electron/dist/`         —— Electron 二进制（367 MB），用 --with-electron 控制。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 路径里出现任一段就整块排除 */
export const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.state', // 运行状态：窗口位置、日志、快照（机器相关）
  '.audit', // 复核临时产物
  '.cache', // Electron 下载缓存
  '.pnpm-store',
  '.release', // 本脚本自己的暂存目录
  'dist-release', // 本脚本自己的产物目录（不排除的话，重复打包会把上一个 zip 装进去）
  '.vscode',
  'node_modules', // 例外见 withElectron
  'dist', // 已放弃的素材导出包（43 MB）
  'chajian', // 上一轮的开发笔记 + profile 备份（对使用者是噪音）
  'screenshots', // 开发自检截图
  'live2d', // 第三方模型（assets/live2d/**）：默认不收，--with-model 才收（见上面的显式加回）
  // 构建产物（由 tools/prepare-renderer-vendor.mjs 生成）—— 但**发行必需**，下面显式加回。
  // 这条排除规则让"显式加回"成为真正的防护而不是摆设：没有它，
  // 删掉加回语句也不会让任何测试变红（等价变异），那测试就白写了。
  'vendor',
])

/** 文件级排除（正则，针对相对路径） */
export const EXCLUDED_FILE_PATTERNS = [
  /\.wpk$/i, // Live2DViewerEX 加密包（他人作品）
  /\.lpk$/i,
  /\.7z$/i,
  /^Cyrene\.zip$/i,
  /^\.DS_Store$/i,
  /\.bak$/i,
  // 安装脚本自己产生的日志（不该跟着发行包走；它们由 setup.mjs / 安装.cmd 每次运行时重写）
  /^(setup|install)-log\.txt$/i,
]

/** vendor 里的必需文件（少一个 Live2D 就加载不了） */
export const VENDOR_FILES = [
  'packages/pet-shell/renderer/vendor/pixi.min.js',
  'packages/pet-shell/renderer/vendor/unsafe-eval.min.js',
  'packages/pet-shell/renderer/vendor/cubism4.min.js',
  'packages/pet-shell/renderer/vendor/live2dcubismcore.min.js',
  'packages/pet-shell/renderer/vendor/process-shim.js',
]

/**
 * 某个相对路径是否该进发行包。
 * @param {string} rel 相对仓库根的路径（用 / 分隔）
 * @param {{withModel?:boolean, withElectron?:boolean}} [options]
 */
export function shouldInclude(rel, options = {}) {
  const normalized = rel.replace(/\\/g, '/')
  const segments = normalized.split('/')

  // ── 显式加回来的三样 ──
  if (normalized.startsWith('packages/pet-shell/renderer/vendor/')) return true
  if (options.withModel && normalized.startsWith('assets/live2d/')) return true
  if (options.withElectron && (normalized === 'node_modules/electron' || normalized.startsWith('node_modules/electron/'))) {
    return true
  }

  // ── 分段排除 ──
  if (segments.some((s) => EXCLUDED_SEGMENTS.has(s))) return false

  // ── 文件级排除 ──
  const base = segments[segments.length - 1]
  if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(normalized) || re.test(base))) return false

  return true
}

/** 发行包里必须存在的东西（打包后自检用） */
export function requiredInRelease(options = {}) {
  return [
    '安装.cmd',
    'start-pet.cmd',
    'package.json',
    'packages/pet-plugin/index.js',
    'packages/pet-plugin/cordis.patch.yml',
    'packages/pet-shell/main.js',
    'packages/pet-shell/sse-link.js',
    'packages/pet-shell/scripts/launch.mjs',
    'tools/setup.mjs',
    'tools/fetch-electron.mjs',
    ...VENDOR_FILES,
    ...(options.withModel ? ['assets/live2d/Cyrene/Cyrene.model3.json', 'assets/live2d/Cyrene/Cyrene.moc3'] : []),
    ...(options.withElectron ? ['node_modules/electron/dist/electron.exe'] : []),
    ...(options.withNode ? ['node/node.exe'] : []),
  ]
}

/**
 * 便携 Node 的源文件：**在 `.cache/` 里**（不进 git、也不该进包），
 * 打包时会被拷成包内的 `node/` 目录 —— 这样 `安装.cmd` 的
 * `"%~dp0node\node.exe"` 就能找到它，朋友不需要预装任何东西。
 *
 * 名字与源路径不同，所以单独返回 { name, src } 而不是相对路径。
 */
export function nodeRuntimeFiles(root) {
  return [
    { name: 'node/node.exe', src: join(root, '.cache', 'node', 'node.exe') },
    { name: 'node/LICENSE', src: join(root, '.cache', 'node', 'LICENSE') },
  ]
}

/**
 * 遍历时**要不要进入这个目录**。
 *
 * ⚠️ 必须和 `shouldInclude` 分开，不能拿 `shouldInclude(dir + '/__dir__')` 代替 ——
 *    `node_modules` 本身在排除名单里，但它下面有**要显式加回**的 `electron`；
 *    用合成子路径判断会把整棵树剪掉，`--with-electron` 就静默失效了
 *    （实测踩过：完整版打出来和精简版一样大，88 文件 / 1.71 MB）。
 *
 * @param {string} rel 相对仓库根的目录路径（用 / 分隔）
 * @param {{withModel?:boolean, withElectron?:boolean}} [options]
 */
export function shouldDescend(rel, options = {}) {
  const normalized = rel.replace(/\\/g, '/')
  if (options.withElectron && (normalized === 'node_modules' || normalized.startsWith('node_modules/electron'))) {
    return true
  }
  if (options.withModel && (normalized === 'assets' || normalized.startsWith('assets/live2d'))) {
    return true
  }
  if (normalized === 'packages/pet-shell/renderer/vendor' || normalized.startsWith('packages/pet-shell/renderer/vendor/')) {
    return true
  }
  return !normalized.split('/').some((s) => EXCLUDED_SEGMENTS.has(s))
}

/**
 * 采集发行包的全部文件（相对路径，用 / 分隔）。
 * 抽到 lib 里是为了能在自测里**对真实仓库跑一遍** ——
 * 只测 `shouldInclude` 是不够的（上面那个 `--with-electron` 失效就是遍历层漏掉的）。
 *
 * @param {string} root 仓库根
 * @param {{withModel?:boolean, withElectron?:boolean, readdir?:Function}} [options]
 */
export function collectReleaseFiles(root, options = {}) {
  const readdir = options.readdir ?? readdirSync
  const out = []
  const walkDir = (dir, prefix) => {
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (shouldDescend(rel, options)) walkDir(join(root, ...rel.split('/')), rel)
      } else if (shouldInclude(rel, options)) {
        out.push(rel)
      }
    }
  }
  walkDir(root, '')
  return out
}
