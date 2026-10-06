/**
 * 更新检查 —— 逻辑与抓取都在这里，**抓取可注入**，所以能完全离线自测。
 *
 * 设计要点（都是有意为之，别随手改）：
 *
 * 1. **"检查失败" 与 "已是最新" 是两件事**，永远不能合并成一句话。
 *    更新检查器最经典的谎言就是网络不通时显示"已是最新" —— 用户于是错过更新，
 *    还以为自己查过了。这里用 `status` 明确区分 `failed` / `up-to-date` / `available` / `ahead`。
 *
 * 2. **两个入口的失败策略相反**（见 `formatCheckResult` 的 `quiet`）：
 *    · 用户主动跑（桌面上的「检查更新.cmd」）→ 失败要**如实说出来**
 *    · 安装时顺手跑（setup.mjs 结尾）→ 失败**一个字都不打**
 *    因为安装那侧的输出会整份写进 `install-log.txt`，而那是用户出问题时发给开发者看的；
 *    里面冒出一句 `❌ 检查更新失败`，会被**误读成安装失败**。宁可不说话。
 *
 * 3. **只读**：不改用户任何文件、不下载 zip、不碰 profile。最坏结果是打印一段废话。
 *
 * 4. **来源是有序数组**：逐个试、谁通用谁。加镜像（如 Gitee）= 往数组里加一行。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 仓库标识 —— 清单地址与发布地址都由它推导，改名只改这一处 */
export const PROJECT_SLUG = 'dddddhxwys/xilian-pet'

/** 发布页（清单里没给 releaseUrl，或没找到同形态的包时，让用户去这里自己挑） */
export const RELEASES_PAGE = `https://github.com/${PROJECT_SLUG}/releases`

/**
 * 清单来源，**按顺序试**。
 * ⚠️ 选型理由：`raw.githubusercontent.com` 在国内经常不可达（本仓库自己的踩坑记录里就有），
 *    所以主源用 jsDelivr 的 GitHub CDN（一般可达）。代价：分支引用**最长缓存 12 小时** ——
 *    刚发新版时可能还看到旧的，所以输出里永远同时给发布页链接。
 *    将来开 Gitee 镜像就在这里加一行，扫描顺序即优先级。
 */
export const UPDATE_SOURCES = [
  `https://cdn.jsdelivr.net/gh/${PROJECT_SLUG}@main/versions.json`,
  `https://raw.githubusercontent.com/${PROJECT_SLUG}/main/versions.json`,
]

/** 仓库里的清单文件名（打包脚本会写它；它**不进发行包**，见 release-files.mjs） */
export const MANIFEST_FILE = 'versions.json'

/** 退出码：0 已最新 / 10 有新版本 / 1 检查失败（`--quiet` 下失败也是 0） */
export const UPDATE_EXIT = { UP_TO_DATE: 0, AVAILABLE: 10, FAILED: 1 }

/** 某个版本的 GitHub Releases 资源地址（按标准规则推导；未发布前会 404，属正常） */
export function releaseAssetUrl(version, file) {
  return `https://github.com/${PROJECT_SLUG}/releases/download/v${version}/${file}`
}

// ─────────────────────────────────────────────────────────────
// 版本比较（semver 语义，含预发布）

function parseSemver(value) {
  const matched = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim())
  if (matched === null) return null
  return {
    main: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
    pre: matched[4] === undefined ? null : matched[4].split('.'),
  }
}

/** 预发布标识符的比较（照 semver 规范：数字按数值、字母数字按字典序、数字 < 字母数字） */
function comparePrerelease(a, b) {
  for (let i = 0; ; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y)
      if (delta !== 0) return delta > 0 ? 1 : -1
      continue
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x > y ? 1 : -1
  }
}

/**
 * 版本比较。a > b → 1；a < b → -1；相等 → 0。
 * ⚠️ **不能拿字符串比**：`"0.1.10" > "0.1.9"` 在字符串下是 false，而语义上是 true。
 * @throws 版本号不符合 semver 时抛错（**不猜**，让调用方当失败处理）
 */
export function compareVersions(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === null || pb === null) {
    throw new Error(`compareVersions: 版本号不符合 semver：${pa === null ? JSON.stringify(a) : JSON.stringify(b)}`)
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa.main[i] !== pb.main[i]) return pa.main[i] > pb.main[i] ? 1 : -1
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1 // 正式版 > 预发布（1.0.0 > 1.0.0-rc.1）
  if (pb.pre === null) return -1
  return comparePrerelease(pa.pre, pb.pre)
}

// ─────────────────────────────────────────────────────────────
// 清单：解析 / 挑选 / 更新

/**
 * 解析清单。**结构不对必须抛错** —— 调用方会把它当"检查失败"，
 * 绝不能悄悄当成"没有新版本"（那正是第 1 条要防的谎言）。
 */
export function parseManifest(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`清单不是合法 JSON：${error.message}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('清单必须是 JSON 对象')
  if (data.schema !== 1) throw new Error(`不认识的清单版本 schema=${JSON.stringify(data.schema)}（本工具只认 1）`)
  if (typeof data.latest !== 'string' || parseSemver(data.latest) === null) {
    throw new Error(`清单的 latest 不是合法版本号：${JSON.stringify(data.latest)}`)
  }
  const rawAssets = data.assets === undefined ? [] : data.assets
  if (!Array.isArray(rawAssets)) throw new Error('清单的 assets 必须是数组')
  const assets = rawAssets.map((asset, index) => {
    const at = `assets[${index}]`
    if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) throw new Error(`${at} 必须是对象`)
    // ⚠️ version 是**必填**：清单里会留住历史版本的条目，靠它区分"这个文件是哪一版的"
    //    （没有它就只能按文件名猜，而同一版重新打包会换文件名 —— 实测踩到过）
    if (typeof asset.version !== 'string' || parseSemver(asset.version) === null) {
      throw new Error(`${at}.version 缺失或不是 semver`)
    }
    if (typeof asset.flavor !== 'string' || asset.flavor.trim() === '') throw new Error(`${at}.flavor 缺失`)
    if (typeof asset.file !== 'string' || asset.file.trim() === '') throw new Error(`${at}.file 缺失`)
    // sha256 是**必填**：它就是让用户能验证"下到的是不是我要的那份"
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error(`${at}.sha256 必须是 64 位小写十六进制`)
    }
    if (asset.size !== undefined && (!Number.isInteger(asset.size) || asset.size <= 0)) {
      throw new Error(`${at}.size 必须是正整数`)
    }
    // url 可以省略、也可以是 null（那表示"按标准规则推导"），但给了就必须是非空字符串
    if (asset.url !== undefined && asset.url !== null && (typeof asset.url !== 'string' || asset.url.trim() === '')) {
      throw new Error(`${at}.url 必须是字符串或 null`)
    }
    return {
      version: asset.version,
      flavor: asset.flavor.trim(),
      file: asset.file.trim(),
      size: asset.size ?? null,
      sha256: asset.sha256,
      url: asset.url ?? null,
    }
  })
  return {
    schema: 1,
    latest: data.latest,
    releasedAt: typeof data.releasedAt === 'string' ? data.releasedAt : null,
    notes: typeof data.notes === 'string' ? data.notes : '',
    releaseUrl: typeof data.releaseUrl === 'string' ? data.releaseUrl : null,
    assets,
  }
}

/**
 * 按形态挑**最新版本**的包；没有就返回 null（**不去凑一个别的形态、也不给旧版本的文件**）。
 *
 * ⚠️ 必须同时匹配 `latest`：清单里为方便追溯会留住历史版本的条目，
 *    只按 flavor 找会挑到**旧版本的文件**（实测撞到：同一形态有两个构建时挑到了旧的）。
 */
export function pickAsset(manifest, flavor) {
  if (typeof flavor !== 'string' || flavor.trim() === '') return null
  const wanted = flavor.trim()
  return manifest.assets.find((asset) => asset.flavor === wanted && asset.version === manifest.latest) ?? null
}

/** 读仓库里的清单；文件不存在时给一个空壳（首次打包用） */
export function readManifest(root) {
  try {
    return parseManifest(readFileSync(join(root, MANIFEST_FILE), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { schema: 1, latest: '0.0.0', releasedAt: null, notes: '', releaseUrl: RELEASES_PAGE, assets: [] }
    }
    throw error
  }
}

/** 序列化清单（固定键序 + 2 空格缩进 + 结尾换行）—— 稳定输出才能让 git diff 只显示真正的变化 */
export function serializeManifest(manifest) {
  const data = {
    schema: 1,
    latest: manifest.latest,
    releasedAt: manifest.releasedAt,
    notes: manifest.notes,
    releaseUrl: manifest.releaseUrl ?? RELEASES_PAGE,
    assets: [...manifest.assets]
      .sort((a, b) => (a.flavor === b.flavor ? a.file.localeCompare(b.file) : a.flavor.localeCompare(b.flavor)))
      .map((asset) => ({
        version: asset.version,
        flavor: asset.flavor,
        file: asset.file,
        size: asset.size,
        sha256: asset.sha256,
        url: asset.url,
      })),
  }
  return `${JSON.stringify(data, null, 2)}\n`
}

/** 写清单。序列化在 `serializeManifest` 里（纯函数，可离线往返测试） */
export function writeManifest(root, manifest) {
  writeFileSync(join(root, MANIFEST_FILE), serializeManifest(manifest), 'utf8')
  return parseManifest(serializeManifest(manifest))
}

/**
 * 打包脚本用：把这一版写进清单。**纯函数**（不改磁盘），返回改了什么。
 *
 * 三条规则：
 *   · 同一个 `file` 重新打包 → **原地替换**（sha256 变了要跟上），不新增条目
 *   · 只在该版本 ≥ 现有 latest 时才抬 latest —— 补打旧版**不会**把线上版本降级
 *   · latest 变了但没给 notes → 返回 `notesMissing`，让打包脚本**大声提醒**（别静默发布空说明）
 */
export function upsertManifest(manifest, entry) {
  const changed = []
  const assets = [...manifest.assets]
  // ⚠️ 按 **(版本, 形态)** 定位，不是按文件名 —— 同一版重新打包会换文件名（时间戳变了），
  //    按文件名找就会累积成多条同形态条目，而挑包时可能拿到**旧的那条**（实测撞到过）
  const at = assets.findIndex((asset) => asset.version === entry.version && asset.flavor === entry.flavor)
  const next = {
    version: entry.version,
    flavor: entry.flavor,
    file: entry.file,
    size: entry.size,
    sha256: entry.sha256,
    url: entry.url,
  }
  if (at === -1) {
    assets.push(next)
    changed.push(`新增 ${entry.flavor} → ${entry.file}`)
  } else {
    const same = JSON.stringify(assets[at]) === JSON.stringify(next)
    assets[at] = next
    if (!same) changed.push(`更新 ${entry.flavor} → ${entry.file}（sha256 已刷新）`)
  }

  let latest = manifest.latest
  let releasedAt = manifest.releasedAt
  let notes = manifest.notes
  let notesMissing = false
  if (compareVersions(entry.version, manifest.latest) >= 0) {
    if (entry.version !== manifest.latest) {
      latest = entry.version
      releasedAt = entry.releasedAt ?? null
      changed.push(`latest ${manifest.latest} → ${entry.version}`)
      if (typeof entry.notes === 'string' && entry.notes.trim() !== '') {
        notes = entry.notes.trim()
      } else {
        notes = ''
        notesMissing = true
      }
    } else if (typeof entry.notes === 'string' && entry.notes.trim() !== '' && entry.notes.trim() !== notes) {
      notes = entry.notes.trim()
      changed.push('更新 notes')
    }
  } else {
    changed.push(`保留 latest=${manifest.latest}（本次打的是更旧的 v${entry.version}）`)
  }

  return {
    manifest: { schema: 1, latest, releasedAt, notes, releaseUrl: manifest.releaseUrl ?? RELEASES_PAGE, assets },
    changed,
    notesMissing,
  }
}

// ─────────────────────────────────────────────────────────────
// 本地版本与形态

/**
 * 读本地"这一版是什么"。
 * 发行包里优先 `VERSION.txt`（它**带形态**，所以能推荐同形态的包）；仓库里退回根 package.json。
 */
export function readLocalRelease(root) {
  try {
    const info = readFileSync(join(root, 'VERSION.txt'), 'utf8')
    const version = /^版本\s*:\s*v?(\S+)/m.exec(info)?.[1] ?? null
    const flavor = /^形态\s*:\s*(\S+)/m.exec(info)?.[1] ?? null
    if (version !== null) return { version, flavor, from: 'VERSION.txt' }
  } catch {
    /* 仓库里没有 VERSION.txt —— 正常 */
  }
  try {
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null
    return { version, flavor: null, from: 'package.json' }
  } catch {
    return { version: null, flavor: null, from: null }
  }
}

// ─────────────────────────────────────────────────────────────
// 检查

/**
 * 跑一次检查。
 * @param {object} options
 * @param {string|null} options.localVersion 本地版本（读不到就报 failed，不猜）
 * @param {string|null} [options.localFlavor] 本地形态，用来挑同形态的包
 * @param {string[]} [options.sources] 清单地址，按顺序试
 * @param {number} [options.timeoutMs] 单个来源的超时
 * @param {number} [options.totalBudgetMs] 全部来源**加起来**的预算（避免安装时卡太久）
 * @param {Function} [options.fetchImpl] 注入用（自测传假的；默认全局 fetch）
 * @param {Date} [options.now] 注入用
 * @returns {Promise<object>} status: 'up-to-date' | 'available' | 'ahead' | 'failed'
 */
export async function checkForUpdate({
  localVersion,
  localFlavor = null,
  sources = UPDATE_SOURCES,
  timeoutMs = 3500,
  totalBudgetMs = timeoutMs * Math.max(1, sources.length),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const attempts = []
  const base = { localVersion: localVersion ?? null, localFlavor: localFlavor ?? null, attempts }

  if (parseSemver(localVersion) === null) {
    return { ...base, status: 'failed', reason: `本地版本号读不到或不是 semver：${JSON.stringify(localVersion ?? null)}` }
  }
  if (typeof fetchImpl !== 'function') {
    return { ...base, status: 'failed', reason: '这个 Node 没有 fetch（本工具需要 Node 18+）' }
  }

  const startedAt = now()
  for (const source of sources) {
    const remaining = totalBudgetMs - (now() - startedAt)
    if (remaining <= 0) {
      attempts.push({ source, ok: false, reason: `超出总预算 ${totalBudgetMs}ms，没轮到它` })
      continue
    }
    try {
      const response = await fetchImpl(source, {
        signal: AbortSignal.timeout(Math.max(200, Math.min(timeoutMs, remaining))),
        redirect: 'follow',
      })
      if (response.ok !== true) throw new Error(`HTTP ${response.status}`)
      const manifest = parseManifest(await response.text())
      attempts.push({ source, ok: true })

      const delta = compareVersions(manifest.latest, localVersion)
      const asset = pickAsset(manifest, localFlavor)
      return {
        ...base,
        status: delta > 0 ? 'available' : delta < 0 ? 'ahead' : 'up-to-date',
        latest: manifest.latest,
        releasedAt: manifest.releasedAt,
        notes: manifest.notes,
        releaseUrl: manifest.releaseUrl,
        asset,
        assetMissingForFlavor: delta > 0 && localFlavor !== null && asset === null,
        source,
      }
    } catch (error) {
      attempts.push({ source, ok: false, reason: error?.message ?? String(error) })
    }
  }

  return { ...base, status: 'failed', reason: `所有来源都没问到（试了 ${sources.length} 个）` }
}

// ─────────────────────────────────────────────────────────────
// 打印（**返回行数组**，所以"安静模式什么都不说"能被自测直接断言）

function mb(bytes) {
  return bytes === null ? null : `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 把检查结果变成要打印的行。
 * @param {object} result `checkForUpdate` 的返回值
 * @param {{quiet?: boolean}} [options] `quiet: true` = 安装时用：**只在"确实有新版"时出声**
 */
export function formatCheckResult(result, { quiet = false } = {}) {
  if (result.status === 'failed') {
    if (quiet) return [] // ⚠️ 安装时失败必须静默：否则 install-log 里那句"失败"会被当成安装失败
    return [
      '  ⚠️  没能检查成功 —— 这**不等于**"已是最新"，只是这次没问到。',
      `      原因：${result.reason}`,
      ...result.attempts.map((a) => `      · ${a.source} → ${a.ok ? 'OK' : a.reason}`),
      `      手动看这里：${RELEASES_PAGE}`,
    ]
  }

  if (result.status === 'up-to-date') {
    if (quiet) return []
    return [`  最新版本 : v${result.latest}`, `  检查来源 : ${result.source}`, '', '  ✅ 已是最新']
  }

  if (result.status === 'ahead') {
    if (quiet) return []
    return [
      `  最新版本 : v${result.latest}`,
      `  你的是   : v${result.localVersion}`,
      '',
      '  ℹ️  你本地比线上还新 —— 大概是开发版，或者清单还没更新。',
      `      清单来源：${result.source}`,
    ]
  }

  // available
  if (quiet) {
    return [`  ℹ️  你装的是 v${result.localVersion}；线上已经有 v${result.latest} —— 双击「检查更新.cmd」看详情`]
  }

  const lines = [
    `  当前版本 : v${result.localVersion}`,
    result.localFlavor === null ? null : `  当前形态 : ${result.localFlavor}`,
    `  检查来源 : ${result.source}`,
    `  最新版本 : v${result.latest}${result.releasedAt === null ? '' : `   （${result.releasedAt} 发布）`}`,
    '',
    '  🆕 有新版本！',
  ].filter((line) => line !== null)
  if (result.notes !== '') lines.push(`     更新内容 : ${result.notes}`)
  if (result.asset !== null) {
    const size = mb(result.asset.size)
    lines.push(`     推荐下载 : ${result.asset.file}${size === null ? '' : `\n                （${size} —— 与你当前形态相同）`}`)
    lines.push(`     下载地址 : ${result.asset.url ?? releaseAssetUrl(result.latest, result.asset.file)}`)
    lines.push(`     SHA256  : ${result.asset.sha256}`)
    lines.push('                下载后核对：certutil -hashfile <文件> SHA256')
  } else if (result.assetMissingForFlavor) {
    lines.push(`     ⚠️  线上没有与你同形态（${result.localFlavor}）的包，去发布页自己挑一个。`)
  }
  lines.push(`     发布页   : ${result.releaseUrl ?? RELEASES_PAGE}`)
  lines.push('')
  lines.push('  更新方法：解压到**一个新目录**（别覆盖旧的）→ 双击 安装.cmd → 重启 DSH')
  return lines
}
