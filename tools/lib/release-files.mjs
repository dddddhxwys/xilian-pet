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
 *
 * 本文件同时还放**发行包的命名与版本**（下面 §命名），它们是纯函数、自测覆盖。
 */
import { readFileSync, readdirSync } from 'node:fs'
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
  // 发行清单**不进发行包**：它是"线上最新是哪一版"的比对基准，给用户一份副本只会造成困惑
  // （用户手里那份的 latest 是打包那一刻的值）。检查更新永远走网络拿清单。
  /^versions\.json$/i,
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
    // ⚠️ 这两个**不是"顺手带上"，是硬要求**：
    //   · LICENSE    —— MIT 本身要求随分发保留版权声明；也是"代码随便用"的依据
    //   · NOTICE.md  —— 素材权利人（米哈游 / 模型作者）要求随作品呈现版权标识与署名
    //   2026-10-06 之前它们只是"碰巧被收进来"（根目录没被排除），没有任何东西守着 ——
    //   清单规则一改就会静默丢掉，而那是**许可违规**，不是小 bug。
    'LICENSE',
    'NOTICE.md',
    '安装.cmd',
    'start-pet.cmd',
    '检查更新.cmd',
    // ⚠️ 三个 .cmd 全靠它找 Node —— 漏了它，包里三个入口全部跑不起来
    'tools/find-node.cmd',
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

// ─────────────────────────────────────────────────────────────
// §命名与版本 —— 发行包"叫什么、算不算对"
//
// 为什么有这一节（2026-10-06）：发行包原来叫 `xilian-pet{,-full,-allinone}.zip`，
// **既没有版本也没有时间戳**；更糟的是 `--with-electron` 与 `--with-electron --with-model`
// 会生成**同一个文件名** —— 正是交接文档里记过的那个坑（"同一补丁文件名反复用✗"）。
// 现在名字里带 版本 + 形态 + 时间戳，并配一个 `.sha256` 旁车文件。

/** 版本号的**唯一来源**：仓库根的 package.json */
export const VERSION_SOURCE = 'package.json'

/** 必须与它保持一致的镜像（插件卡片会显示插件版本，所以必须同步） */
export const VERSION_MIRRORS = ['packages/pet-plugin/package.json', 'packages/pet-shell/package.json']

/** 各处版本号；读不到就是 null（调用方当失败处理，别静默用默认值） */
export function readVersions(root) {
  const read = (rel) => {
    try {
      return JSON.parse(readFileSync(join(root, ...rel.split('/')), 'utf8')).version ?? null
    } catch {
      return null
    }
  }
  return { source: read(VERSION_SOURCE), mirrors: VERSION_MIRRORS.map((rel) => ({ rel, version: read(rel) })) }
}

/**
 * 形态名：一眼看出包里有什么。
 *
 * ⚠️ `withNode` 不能无条件压过 `withElectron` —— 第一版写成
 *    `withNode ? 'allinone' : withElectron ? 'full' : 'slim'`，于是
 *    **`--with-node` 与 `--with-node --with-electron` 生成同一个名字**
 *    （自测里那条"八种组合互不撞名"当场抓出来）。现在两者都进名字：
 *    `node`（只有便携 Node）≠ `allinone`（Node + Electron）。
 */
export function releaseVariant(options = {}) {
  const base = options.withElectron
    ? options.withNode
      ? 'allinone'
      : 'full'
    : options.withNode
      ? 'node'
      : 'slim'
  return options.withModel ? `${base}-model` : base
}

/** 形态的中文说明 —— 写进包内的 VERSION.txt，也用于控制台 */
export function describeVariant(options = {}) {
  return [
    options.withNode ? '内置便携 Node' : '不含 Node（用 DSH 自带的）',
    options.withElectron ? '内置 Electron' : '不含 Electron（首次运行自动下载约 100 MB）',
    options.withModel ? '含 Live2D 模型' : '不含 Live2D 模型',
  ].join('；')
}

/** 时间戳 `YYYYMMDD-HHMM`（本地时间）—— 与既有 `xilian-pet-patch-R8-20261006-1123.zip` 同格式 */
export function releaseTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** 发行包文件名：`xilian-pet-v<版本>-<形态>-<时间戳>.zip` */
export function releaseZipName({ version, ...options } = {}, date = new Date()) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('releaseZipName: 需要 version（来自 package.json）')
  }
  return `xilian-pet-v${version.trim()}-${releaseVariant(options)}-${releaseTimestamp(date)}.zip`
}

/** `.sha256` 旁车文件的内容：**两个空格**是 `sha256sum -c` 认的格式 */
export function formatSha256Sidecar(hash, filename) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`formatSha256Sidecar: 不是 sha256 十六进制：${hash}`)
  return `${hash}  ${filename}\n`
}

/** 三种形态的名字（给"按形态清理旧包"用） */
export const RELEASE_FLAVORS = ['slim-model', 'full-model', 'allinone-model']

/**
 * 认一个**我们自己的发行产物**：`xilian-pet-v<版本>-<形态>-<时间戳>.zip` 及其 `.sha256`。
 * @returns `{ flavor, stamp }`；不是我们的产物返回 null
 */
export function parseReleaseArtifact(name) {
  if (typeof name !== 'string') return null
  const m = /^xilian-pet-.+-(slim-model|full-model|allinone-model)-(\d{8}-\d{4})\.zip(\.sha256)?$/.exec(name)
  return m === null ? null : { flavor: m[1], stamp: m[2] }
}

/**
 * 挑出**该删的旧产物** —— 只删"和这次打出来的是同一形态、但不是这一份"的那些。
 *
 * ⚠️ 这里必须是**白名单**：只认 `<前缀>-<形态>-<时间戳>.zip(.sha256)` 这一种格式，
 *    其它任何文件一律不碰。2026-10-06 踩过反例 —— 当时的清理脚本用的是"不在保留
 *    列表里就删"，于是把 `dist-release/RELEASE-NOTES.md` 一起扫掉了 ✗。
 *
 * ⚠️ 两条**保守**规则（拿不准就什么都不删）：
 *     · `keepNames` 为空 → 返回 []（否则会把该形态的所有包全删光）
 *     · `keepNames` 里的文件一个都不在 `names` 里 → 返回 []（说明目录不对/打包没成功）
 *
 * @param {string[]} names 目录里的文件名
 * @param {{ keepNames: string[], flavor: string }} options keepNames 含刚打出来的 zip 与它的 .sha256
 * @returns {string[]} 该删的文件名（已排序）
 */
export function staleReleaseArtifacts(names, { keepNames = [], flavor } = {}) {
  const list = Array.isArray(names) ? names : []
  const keep = new Set(keepNames.filter((one) => typeof one === 'string' && one !== ''))
  if (keep.size === 0) return []
  if (!list.some((one) => keep.has(one))) return []
  return list
    .filter((one) => {
      const parsed = parseReleaseArtifact(one)
      return parsed !== null && parsed.flavor === flavor && !keep.has(one)
    })
    .sort()
}

/**
 * 每种形态**保留最新那一份**（按文件名里的时间戳比），返回该删的其它文件。
 * 用于 `--prune-only`：不打包，只收拾目录。
 */
export function staleByFlavor(names) {
  const list = Array.isArray(names) ? names : []
  const newest = new Map()
  for (const one of list) {
    const parsed = parseReleaseArtifact(one)
    if (parsed === null) continue
    const current = newest.get(parsed.flavor)
    if (current === undefined || parsed.stamp > current) newest.set(parsed.flavor, parsed.stamp)
  }
  // 一种形态都没认出来 → 什么都不删（目录里可能全是别的东西）
  if (newest.size === 0) return []
  return list
    .filter((one) => {
      const parsed = parseReleaseArtifact(one)
      return parsed !== null && newest.get(parsed.flavor) !== parsed.stamp
    })
    .sort()
}

/**
 * 读当前 git 提交（短哈希）。
 *
 * ⚠️ **刻意不 spawn `git`**：本沙箱下 Node 起子进程要管道 stdio（会 EPERM），
 *    而且发行脚本不该假设 PATH 上有 git。直接读 `.git/HEAD` + loose ref / `packed-refs`。
 * @returns 7 位短哈希；读不到返回 null（不猜、不编造）
 */
export function readGitCommit(root) {
  const gitDir = join(root, '.git')
  const readText = (rel) => {
    try {
      return readFileSync(join(gitDir, ...rel.split('/')), 'utf8')
    } catch {
      return null
    }
  }
  const head = readText('HEAD')
  if (head === null) return null
  const trimmed = head.trim()
  let hash = null
  if (/^[0-9a-f]{40}$/.test(trimmed)) {
    hash = trimmed // detached HEAD
  } else {
    const matched = /^ref:\s*(.+)$/.exec(trimmed)
    if (matched) {
      const ref = matched[1].trim()
      const loose = readText(ref)
      if (loose !== null) {
        hash = loose.trim()
      } else {
        // ref 被打包进 packed-refs（git gc 之后）
        const packed = readText('packed-refs')
        const line = packed?.split('\n').find((l) => l.endsWith(` ${ref}`))
        if (line) hash = line.split(' ')[0]
      }
    }
  }
  return hash !== null && /^[0-9a-f]{40}$/.test(hash) ? hash.slice(0, 7) : null
}

/** 包内 `VERSION.txt` 的内容 —— 接收方靠它自证版本，排查时也不用问人 */
export function releaseInfoText({ version, options = {}, builtAt = new Date(), commit = null } = {}) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp =
    `${builtAt.getFullYear()}-${pad(builtAt.getMonth() + 1)}-${pad(builtAt.getDate())} ` +
    `${pad(builtAt.getHours())}:${pad(builtAt.getMinutes())}:${pad(builtAt.getSeconds())}`
  return [
    '昔涟桌宠 xilian pet',
    '========================================',
    `版本      : v${version}`,
    `形态      : ${releaseVariant(options)} —— ${describeVariant(options)}`,
    `构建时间  : ${stamp}（本机本地时间）`,
    `构建来源  : ${commit ?? '(未知)'}`,
    '仓库      : https://github.com/dddddhxwys/xilian-pet',
    '',
    '⚠️ 本项目是**非官方的爱好者作品**，与米哈游及《崩坏：星穹铁道》项目组没有任何关联，',
    '   严格限于个人、非商业用途：不收费、不销售、不含广告或赞助。',
    '   角色与素材的权利归各自所有者；署名与使用范围见随包的 NOTICE.md（请勿删除）。',
    '',
    '怎么用：解压后双击 安装.cmd —— 它会打印版本并检查环境。',
    '',
  ].join('\n')
}
