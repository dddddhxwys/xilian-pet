/**
 * 昔涟桌宠 · 一键安装（给拿到发行包的人用）
 *
 * 目标：把"从零到能跑"压缩成**一次双击**。它做九件事，每一步都幂等，
 * 失败时给人话 + 下一步怎么做（**绝不静默** —— 静默失败是"看到占位图就来报 bug"的根源）。
 *
 * 用法：
 *   node tools/setup.mjs              真正执行（会写 profile patch、必要时下载 Electron）
 *   node tools/setup.mjs --dry-run    只看会做什么，不写任何东西、不下载
 *   node tools/setup.mjs --profile=<名字>   指定 DSH profile（默认 desktop）
 *
 * ⚠️ 本脚本**不需要 pnpm / node_modules**（除 Electron 二进制本身）：
 *    运行时唯一的 npm 依赖是 electron，vendor 已在发行包里预构建好。
 *
 * ⚠️ 只允许用 `stdio: 'inherit'` 起子进程：受限沙箱下管道 stdio 会 EPERM。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  addPluginRow,
  looksLikePluginEntryPath,
  readPluginRowPath,
  removePluginRow,
  ROW_ID,
} from './lib/patch-edit.mjs'
import { checkForUpdate, formatCheckResult, readLocalRelease } from './lib/update-check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
/**
 * `--official`：把手写 patch 行**删掉**，改走 DSH 官方的 bundle 注册路径。
 *
 * 为什么要有这个开关：手写 patch 能一键装（零依赖 ✓），但 DSH 的插件列表是照
 * `profile/package.json` 的 `dsh.profile.bundles` 渲染的 —— 手写的行不在注册表里，
 * **列表里看不到它** ✗。走官方安装（在界面里 install_bundle）才会登记进注册表 ✓。
 *
 * ⚠️ 两条路**只能走一条**：手写行不删就装官方包 → 插件被加载两次（两个实例、
 *    两套 SSE、端口打架）✗
 */
const OFFICIAL = argv.includes('--official')
/**
 * `--patch`：强制走**手写 patch**（旧默认）。
 * 默认路径现在是"能走官方就走官方"（见下面 CLI 那段）—— 留这个开关是为了
 * 出问题时有一条**一定能用**的退路：手写 patch 零依赖，不碰 profile 的 package.json。
 */
const PATCH_ONLY = argv.includes('--patch')
const profileArg = argv.find((a) => a.startsWith('--profile='))?.split('=')[1]

/** 读我们自己包的 name（官方注册表里比对用） */
function readPackageName() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'packages', 'pet-plugin', 'package.json'), 'utf8')).name
  } catch {
    return '@local/xilian-pet-plugin'
  }
}

/**
 * 版本号 —— 复用更新检查那边的读取逻辑（单一来源），并附带形态。
 * 为什么值得单独读：用户报问题时第一句总是"我装的是哪一版"，这个数字必须能一眼打出来。
 */
function readVersion() {
  const local = readLocalRelease(ROOT)
  if (local.version === null) return '(未知)'
  return local.flavor === null ? `v${local.version}` : `v${local.version}（${local.flavor}）`
}

const counts = { ok: 0, warn: 0, fail: 0 }
/** 没找到 DSH profile（不是致命错误，见步骤①） */
let profileMissing = false
/**
 * 输出**同时**进屏幕和日志文件。
 *
 * 为什么必须存日志：朋友是远程的，黑窗口一关，几十行输出就没了 ——
 * 只能靠他截图/复述，而我们连"哪一步失败了"都问不出来（实测就是这样：只拿到
 * 一句"按任意键继续"，什么诊断信息都没有）。
 */
const LOG_PATH = join(ROOT, 'setup-log.txt')
const logLines = []
process.on('exit', () => {
  try {
    writeFileSync(LOG_PATH, `${logLines.join('\n')}\n`, 'utf8')
  } catch {
    /* 写不了就算了，别让收尾逻辑把安装搞挂 */
  }
})
const line = (s = '') => {
  const text = String(s)
  logLines.push(text)
  console.log(text)
}
const ok = (title, detail = '') => {
  counts.ok++
  line(`  ✅ ${title}`)
  if (detail) line(`     ${detail}`)
}
const warn = (title, detail = '') => {
  counts.warn++
  line(`  ⚠️  ${title}`)
  if (detail) line(`     ${detail}`)
}
const bad = (title, detail = '') => {
  counts.fail++
  line(`  ❌ ${title}`)
  if (detail) line(`     ${detail}`)
}

const run = (file, args, label, envExtra) => {
  line(`    → ${label ?? `${file} ${args.join(' ')}`}`)
  if (DRY_RUN) return 0
  const env = envExtra === undefined ? process.env : { ...process.env, ...envExtra }
  const r = spawnSync(file, args, { cwd: ROOT, stdio: 'inherit', env })
  return r.status ?? 1
}

line('昔涟桌宠 · 一键安装')
line('─'.repeat(56))
line(`  版本     : ${readVersion()}`)
line(`  安装目录 : ${ROOT}`)
line(`  Node     : ${process.version}  (${process.platform}/${process.arch})`)
line(`  模式     : ${DRY_RUN ? '只检查（--dry-run，不写任何东西）' : '实际执行'}`)
line('')

// ── ① 找 DSH profile ────────────────────────────────────────────────
// ⚠️ 这里曾经是"**第一个**命中就赢"，而且默认把 `desktop` 排在候选最前面。
//    实机踩过（2026-10-06 第二个朋友的机器）：机器上有多个 profile，而 DSH 实际
//    启动的不是我们选中的那个 → 插件被写进**没人启动的** profile：
//    /xilian-pet/health 返回 404、插件列表里当然也没有，重跑还"幂等跳过"，怎么都修不回来。
//    现在：把所有 profile **都列出来**（这是远程排查最有用的一段），并且**每个都挂上**。
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profilesRoot = join(dshHome, 'profiles')
/** 显式指定的 profile（--profile= / DSH_PROFILE / DSH_PROFILE_DIR）优先 */
const wantedProfile = profileArg ?? process.env.DSH_PROFILE ?? null
const onlyThisProfile = argv.includes('--only-this-profile')

/** 所有带 cordis.patch.yml 的 profile 目录（= 看起来真被 DSH 用过的） */
function listProfileDirs() {
  const found = []
  const add = (dir) => {
    if (typeof dir !== 'string' || dir === '') return
    if (!existsSync(join(dir, 'cordis.patch.yml'))) return
    if (!found.includes(dir)) found.push(dir)
  }
  if (process.env.DSH_PROFILE_DIR) add(process.env.DSH_PROFILE_DIR)
  if (wantedProfile !== null) add(join(profilesRoot, wantedProfile))
  try {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(profilesRoot, entry.name))
    }
  } catch {
    /* profiles 目录不存在就算了，下面会报 */
  }
  return found
}

const allProfiles = listProfileDirs()
/** 本次主挂的 profile：显式指定 > desktop > 唯一/第一个 */
const profileDir =
  (wantedProfile !== null && allProfiles.includes(join(profilesRoot, wantedProfile))
    ? join(profilesRoot, wantedProfile)
    : null) ??
  (allProfiles.includes(join(profilesRoot, 'desktop')) ? join(profilesRoot, 'desktop') : null) ??
  allProfiles[0] ??
  null

line('① 找 DSH profile')
if (profileDir === null) {
  // ⚠️ 这是**警告不是失败**：桌宠可以脱离 DSH 单独跑（待机 + 点击互动 + 拖拽都在渲染端），
  //    只是不会跟随 DSH 状态、没有审批提醒和派活面板。
  //    之前判成失败会让"没装 DSH 的朋友"看到一句 FAILED 却其实装得成。
  profileMissing = true
  warn(
    '没找到 DSH 的 profile —— 她仍能显示和互动，但**不会跟随 DSH 状态**',
    `找过：${profilesRoot}\\<任何带 cordis.patch.yml 的 profile>\n` +
      '  想接上 DSH：装好 DSH 并启动一次，然后重跑本安装即可（幂等）。',
  )
} else {
  ok(`profile：${profileDir}`)
  if (allProfiles.length > 1) {
    line(`     这台机器上有 ${allProfiles.length} 个 profile（打 → 的是本次主挂的）：`)
    for (const one of allProfiles) line(`       ${one === profileDir ? '→' : ' '} ${one}`)
    line('     （下面会把**每一个**都挂上，避免挂到没在启动的那一个）')
  } else {
    line('     （本机只找到一个 profile）')
  }
}
line('')

// ── DSH 自己的 CLI：官方安装（登记进插件列表）靠它 ────────────────────
// find-node.cmd 把 <install>\resources\runtime\cli\bin\dsh.cmd 所在位置传进来
// （PET_DSH_CLI），而**不直接跑那个 .cmd**：
//   · Windows 上 Node **不能直接 spawn .cmd**（Node >=18.20/20.12 起抛 EINVAL）
//   · 绕 cmd.exe 又要趟引号沼泽（路径里有空格和中文）
// dsh.cmd 本体只有三行，做的就是下面这件事；我们照做，参数交给 Node 正常转义：
//   ELECTRON_RUN_AS_NODE=1 "<install>\DeepSeek Harness.exe" --expose-internals
//     "<install>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" ...
// 实测（2026-10-06，本机 desktop profile）：
//   dsh plugin --profile desktop remove <pkg>  → 同时摘掉 link: 依赖与 bundles 项
//   dsh plugin --profile desktop add <本地目录> → 写回 link: 依赖并把包登记进 bundles ✓
const dshInstallDir = process.env.PET_DSH_INSTALL ?? ''
const cliExe = dshInstallDir === '' ? '' : join(dshInstallDir, 'DeepSeek Harness.exe')
const cliJs =
  dshInstallDir === ''
    ? ''
    : join(
        dshInstallDir,
        'resources',
        'app.asar',
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-desktop-host',
        'lib',
        'cli.js',
      )
const cliReady = cliExe !== '' && existsSync(cliExe)
// ⚠️ 不要用 existsSync(cliJs) 判断！cli.js 在 **app.asar 内部**，而 asar 对普通 Node
//    来说只是一个**文件**、不是目录 —— 任何 existsSync 都会返回 false（实测踩过，
//    结果就是 cliReady 永远为假、默认路径白白退回手写 patch）。
//    Electron（也就是那个 exe）自己能读 asar 内部，所以只要 exe 在就交给它去解析。

// ── ② 挂载 Host 插件 ───────────────────────────────────────────────
// 三条路径：
//   · 默认（本机找得到 DSH CLI 时）：走**官方 bundle 注册** → 插件出现在 DSH 插件列表里 ✓
//   · 默认（找不到 CLI）：退回手写 profile patch（零依赖，但列表里看不到）
//   · --patch：强制手写 patch；--official：强制官方（找不到 CLI 时提示去界面装）
// ⚠️ 两条路**只能走一条**：手写行不删就装官方包 → 插件被加载两次（两个实例、
//    两套 SSE、端口打架）✗ —— 所以走官方时会先把手写行摘掉。
const WANT_OFFICIAL = OFFICIAL || (!PATCH_ONLY && cliReady)
line(WANT_OFFICIAL ? '② 官方安装（bundle 注册 → 会出现在 DSH 插件列表里）' : '② 挂载 Host 插件（手写 patch）')
if (!profileDir) {
  warn('跳过（上一步没找到 DSH profile）')
} else if (WANT_OFFICIAL && cliReady) {
  const pkgName = readPackageName()
  const pluginDir = join(ROOT, 'packages', 'pet-plugin')
  const pkgFile = join(profileDir, 'package.json')
  const profileLeaf = basename(profileDir)
  const patchFile = join(profileDir, 'cordis.patch.yml')

  // ① 手写行必须先摘掉：手写 + 官方 = 插件被加载两次（两个实例、两套 SSE）
  const current = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : null
  const removal = current === null ? { changed: false } : removePluginRow(current)
  if (removal.changed && !DRY_RUN) {
    const backup = `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(patchFile, backup)
    writeFileSync(patchFile, removal.text, 'utf8')
    ok('已摘掉手写插件行（避免与官方安装**加载两次**）', `备份：${backup}`)
  } else if (removal.changed) {
    warn('（dry-run）实际执行时会先摘掉手写插件行，避免加载两次')
  }

  // ② 用 DSH 自己的 CLI 做官方安装
  line('  用 DSH 自己的 CLI 登记进插件注册表：')
  line(`    profile「${profileLeaf}」`)
  if (DRY_RUN) {
    warn('（dry-run）不写任何东西 —— 实际执行时会跑上面那条命令，再回读 package.json 校验')
  } else {
    const code = run(cliExe, [cliJs, 'plugin', '--profile', profileLeaf, 'add', pluginDir], undefined, {
      ELECTRON_RUN_AS_NODE: '1',
    })

    // ③ 不信退出码 —— 回读 package.json 校验（官方安装 = link: 依赖 + bundles 两项都要有）
    let good = false
    let detail = ''
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const dep = pkg?.dependencies?.[pkgName] ?? ''
      const bundles = pkg?.dsh?.profile?.bundles
      const listed = Array.isArray(bundles) && bundles.includes(pkgName)
      good = dep.startsWith('link:') && listed
      detail = `dependencies["${pkgName}"] = ${dep || '(缺失)'}；bundles 里${listed ? '有' : '**没有**'}`
    } catch (error) {
      detail = `读不动 ${pkgFile}：${error.message}`
    }
    if (code === 0 && good) {
      ok('官方安装完成 —— 重启 DSH 后插件会出现在插件列表里 ✓', `      ${detail}`)
    } else {
      bad(
        code === 0 ? '官方安装后回读校验没通过' : `官方安装失败（退出码 ${code}）`,
        `      ${detail}\n` +
          '  退路：改用**手写 patch**（零依赖，装在 profile 的 cordis.patch.yml 上）：\n' +
          '      安装.cmd --patch',
      )
    }
  }
} else if (OFFICIAL) {
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const profilePkg = join(profileDir, 'package.json')
  const pkgName = readPackageName()
  // ① 先看官方注册表里有没有我们（官方安装会写进 package.json 的 dsh.profile.bundles）
  let registered = false
  try {
    const pkg = JSON.parse(readFileSync(profilePkg, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    registered = Array.isArray(bundles) && bundles.some((b) => b === pkgName)
  } catch {
    /* package.json 读不了/没有 → 当作未注册 */
  }
  // ② 手写行必须删掉，否则插件会被**加载两次**（两个实例、两套 SSE、端口打架）
  const current = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : null
  const removal = current === null ? { changed: false } : removePluginRow(current)
  if (removal.changed && !DRY_RUN) {
    const backup = `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      copyFileSync(patchFile, backup)
      writeFileSync(patchFile, removal.text, 'utf8')
      ok('已移除手写的插件行（并已备份）', `备份：${backup}`)
    } catch (error) {
      bad(`移除手写行失败：${error.code ?? ''} ${error.message}`, '  请在**你自己的终端**里重跑：node tools/setup.mjs --official')
    }
  } else if (removal.changed) {
    warn('检测到手写行 —— 实际执行时会移除它（先备份）')
  } else {
    ok('没有手写行，无需清理')
  }
  // ③ 官方安装必须**在 DSH 界面里点**（我没有 plugin_manager 工具，不能替你写注册表）
  if (registered) {
    ok(`官方注册表里已有 ${pkgName}`, '插件列表里应该能看到「昔涟桌宠」')
  } else {
    warn(
      `官方注册表里还没有 ${pkgName} —— 需要在 DSH 界面里装一次`,
      '  DSH → 插件 / 扩展 → 安装 bundle（选本地目录）→ 选中这个文件夹：\n' +
        `      ${join(ROOT, 'packages', 'pet-plugin')}\n` +
        '  装完再重跑一次本命令确认（幂等，不会重复）。\n' +
        '  ⚠️ 不要手改 profile 的 package.json —— 官方要求由 install_bundle 完成。',
    )
  }
} else {
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const entry = join(ROOT, 'packages', 'pet-plugin', 'index.js')
  if (!existsSync(entry)) {
    bad('插件入口不存在', `期望位置：${entry}\n  发行包不完整？请重新解压。`)
  } else {
    const current = readFileSync(patchFile, 'utf8')
    /**
     * ⚠️ 光看「有没有那一行」不够：用户换个文件夹解压/运行（很常见）之后，
     *    那一行还指着**旧路径** —— 旧目录在就"插件从旧副本加载"，被删掉就
     *    **静默加载不到**（桌宠连不上 DSH、插件列表里也没有）。
     *    所以要比对**它指向哪个目录**，不一样就改过来。
     */
    const mountedEntry = readPluginRowPath(current)
    const config = { pathPrefix: '/xilian-pet', captureRawShapes: 20, minHoldMs: 500 }
    /**
     * ⚠️ 再分一层：官方 bundle 安装留下的行，`name` 是**包名**
     *    （`@local/xilian-pet-plugin`），不是文件路径。那种行**不属于**手写挂载，
     *    绝不能按"路径变了"去改 —— 那会改坏官方安装的配置覆盖（实测 dry-run 误报过）。
     */
    const mountedIsHandwritten = looksLikePluginEntryPath(mountedEntry)

    if (mountedEntry === entry) {
      // 把路径打出来：远程排查时"已挂载过，跳过"这句话本身没有信息量，
      // 而"跳过的是哪个路径"才决定这次到底能不能加载。
      ok('已挂载过，跳过（幂等）', `      指向：${entry}`)
    } else if (mountedEntry !== null && !mountedIsHandwritten) {
      ok(
        '插件这一行来自**官方 bundle 安装**（name 是包名，不是文件路径）—— 手写挂载不需要，保持原样',
        `      ${mountedEntry}`,
      )
    } else if (DRY_RUN) {
      warn(
        mountedEntry === null
          ? '未挂载 —— 实际执行时会追加插件行并备份原文件'
          : `插件行指向**别的目录** —— 实际执行时会改到当前目录`,
        mountedEntry === null ? '' : `      旧：${mountedEntry}\n      新：${entry}`,
      )
    } else {
      // 指向别的目录：先摘掉旧的那一段，再按当前目录追加（两个纯函数都已自测）
      const base = mountedEntry === null ? current : removePluginRow(current).text
      const { text, changed } = addPluginRow(base, { rowId: ROW_ID, pluginEntry: entry, config })
      if (!changed) {
        ok('已挂载过，跳过（幂等）')
      } else {
        const backup = `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
        try {
          copyFileSync(patchFile, backup)
          writeFileSync(patchFile, text, 'utf8')
          if (mountedEntry === null) {
            ok('已写入插件行（并已备份原文件）', `备份：${backup}`)
          } else {
            ok(
              '插件行原本指着**别的目录**，已改到当前目录（并已备份原文件）',
              `      旧：${mountedEntry}\n      新：${entry}\n      备份：${backup}`,
            )
          }
        } catch (error) {
          bad(
            `写入失败：${error.code ?? ''} ${error.message}`,
            '  目标目录在工作区之外，可能被沙箱或权限拦住了。\n' +
              '  请在**你自己的终端**里重跑这条命令：node tools/setup.mjs',
          )
        }
      }
    }
  }
}

// ── ②b 其它 profile 也顺手挂上 ────────────────────────────────────────
// 为什么：我们**无法知道** DSH 实际启动的是哪个 profile（它没写在任何我们能读的地方）。
// 与其猜，不如把每个有 patch 文件的 profile 都挂上 —— DSH 桌面端同时只跑一个，
// 所以不会出现"双实例"。实现方式是**带 --profile 重新跑一遍自己**，
// 这样每个 profile 都走完全相同的、已被自测覆盖的代码路径（幂等）。
if (!DRY_RUN && !onlyThisProfile && allProfiles.length > 1) {
  const modeArgs = OFFICIAL ? ['--official'] : PATCH_ONLY ? ['--patch'] : []
  for (const other of allProfiles) {
    if (other === profileDir) continue
    line(`  ↻ 也挂到 profile「${basename(other)}」（无法确定 DSH 启动的是哪个，索性都挂）`)
    const code = run(process.execPath, [
      fileURLToPath(import.meta.url),
      `--profile=${basename(other)}`,
      '--only-this-profile',
      ...modeArgs,
    ])
    if (code !== 0) warn(`profile「${basename(other)}」那一次返回了 ${code}`)
  }
  line('')
}
line('')

// ── ③ 渲染端 vendor ────────────────────────────────────────────────
line('③ 渲染端 vendor（pixi + Cubism Core）')
const vendorDir = join(ROOT, 'packages', 'pet-shell', 'renderer', 'vendor')
const vendorFiles = [
  'pixi.min.js',
  'unsafe-eval.min.js',
  'cubism4.min.js',
  'live2dcubismcore.min.js',
  'process-shim.js',
]
const missingVendor = vendorFiles.filter((f) => !existsSync(join(vendorDir, f)))
if (missingVendor.length === 0) {
  ok('5 个文件齐全')
} else if (DRY_RUN) {
  warn(`缺 ${missingVendor.length} 个：${missingVendor.join(', ')}`, '（dry-run）实际执行时会自动补齐')
} else {
  warn(`缺 ${missingVendor.length} 个：${missingVendor.join(', ')}`, '尝试自动补齐（需要联网下 Cubism Core）…')
  const code = run(process.execPath, [join(ROOT, 'tools', 'prepare-renderer-vendor.mjs')], 'node tools/prepare-renderer-vendor.mjs')
  const stillMissing = vendorFiles.filter((f) => !existsSync(join(vendorDir, f)))
  if (code === 0 && stillMissing.length === 0) ok('已补齐')
  else bad('补齐失败', `仍缺：${stillMissing.join(', ')}\n  发行包不完整或网络不通。`)
}
line('')

// ── ④ Electron 二进制 ──────────────────────────────────────────────
line('④ Electron 二进制')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (existsSync(electronExe)) {
  ok('已就绪')
} else if (DRY_RUN) {
  warn('没有，需要下载（约 100 MB）', '（dry-run）实际执行时会自动下载（走华为云镜像）')
} else {
  warn('没有，需要下载（约 100 MB，走华为云镜像，通常 1~2 分钟）', '开始下载…')
  const code = run(process.execPath, [join(ROOT, 'tools', 'fetch-electron.mjs')], 'node tools/fetch-electron.mjs')
  if (code === 0 && existsSync(electronExe)) ok('下载完成')
  else bad('下载失败', '网络不通？可以重跑一次安装；或手动运行：node tools/fetch-electron.mjs')
}
line('')

// ── ⑤ Live2D 模型 ─────────────────────────────────────────────────
line('⑤ Live2D 模型')
const modelDir = join(ROOT, 'assets', 'live2d', 'Cyrene')
const modelNeeds = ['Cyrene.model3.json', 'Cyrene.moc3']
const modelMissing = modelNeeds.filter((f) => !existsSync(join(modelDir, f)))
if (modelMissing.length === 0) {
  ok('模型文件在位')
} else {
  warn(
    '没有模型 —— **桌宠会显示占位形象，这是正常的**，不是故障',
    `  把模型文件夹放到：${modelDir}\n` +
      '  需要的文件：Cyrene.model3.json / Cyrene.moc3 / 纹理目录\n' +
      '  模型由 B站 @是依七哒 制作，署名与用途要求见 NOTICE.md（不入版本库）。',
  )
}
line('')

// ── ⑥ 环境自检 ────────────────────────────────────────────────────
line('⑥ 启动自检（只检查，不开窗）')
if (DRY_RUN) {
  warn('（dry-run）跳过自检', '实际执行时会跑 launch.mjs --check')
} else {
  const checkCode = run(process.execPath, [join(ROOT, 'packages', 'pet-shell', 'scripts', 'launch.mjs'), '--check'], 'launch.mjs --check')
  if (checkCode === 0) ok('自检通过')
  else warn('自检有告警，请看上面的输出')
}
line('')

// ── 汇总 ──────────────────────────────────────────────────────────
line('─'.repeat(56))
line(`结果：${counts.ok} 项就绪 · ${counts.warn} 项告警 · ${counts.fail} 项失败`)
line('')
line(`本次输出已存到：${LOG_PATH}`)
line('（出问题时把这个文件发给我 —— 比截图全，也比复述准）')
line('')
if (counts.fail > 0) {
  line('按上面的提示处理后，**重跑一次本安装即可**（幂等，不会重复挂载）。')
  process.exit(1)
}
line('下一步：')
if (profileMissing) {
  line('  ⚠️ 这台机器上没有 DSH，所以只装好了"桌宠本体"：')
  line('     · 她会出现在桌面上，能点击互动、能拖动（这些都在渲染端，不需要 DSH）')
  line('     · **但不会跟随 DSH 状态**，也没有审批提醒 / 派活面板')
  line('     · 想接上：装好 DSH 并启动一次 → 重跑本安装（幂等，不会重复挂载）')
  line('')
}
line('  1. **重启 DSH**（首次挂载插件需要重新加载；桌宠那侧有自愈，不用管）')
line('  2. 双击仓库根目录的 `start-pet.cmd` → 她会出现在桌面上')
line('  3. 退出：按 Ctrl+Shift+Q')
if (counts.warn > 0) line('\n（上面有告警项，多数不影响运行 —— 比如缺模型时会显示占位形象。）')
line('')

// ── ⑦ 顺带看一眼有没有新版 ────────────────────────────────────────
// ⚠️ **失败必须完全静默**：本文件的输出会**整份写进 install-log.txt**，而那是用户出问题时
//    发给开发者看的。里面冒出一句"检查更新失败"，会被**误读成安装失败** ——
//    一个装饰性功能把安装流程的可信度毁掉，不值。所以用 quiet 模式：
//    只有"确实有新版本"才出一行；已最新 / 网络不通 / 超时，一个字都不打。
//    也**不影响退出码**（这里是直接调函数，不是起子进程）；总预算 4 秒，拖不住安装。
if (!DRY_RUN) {
  const local = readLocalRelease(ROOT)
  const update = await checkForUpdate({
    localVersion: local.version,
    localFlavor: local.flavor,
    timeoutMs: 2500,
    totalBudgetMs: 4000,
  })
  for (const text of formatCheckResult(update, { quiet: true })) line(text)
}
