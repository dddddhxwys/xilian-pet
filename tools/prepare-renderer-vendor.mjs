/**
 * 准备渲染端 vendor —— 把 Live2D 渲染需要的三个脚本放进 renderer/vendor/。
 *
 * 为什么用 <script> 标签而不是打包器：
 *   本项目渲染端是零构建的（file:// 直载 pet.js）。引入打包器会牵动整个工具链，
 *   而 pixi.js 与 pixi-live2d-display 都提供 UMD 构建，直接挂全局即可。
 *
 * 三个文件：
 *   1. pixi.min.js                  —— UMD，挂 window.PIXI
 *   2. live2dcubismcore.min.js      —— Live2D 官方 Core（**从官方 CDN 下载，不入库**）
 *   3. cubism4.min.js               —— pixi-live2d-display 的 Cubism4 运行时，挂 window.PIXI.live2d
 *
 * ⚠️ 版本陷阱（实测）：pixi-live2d-display 的 npm `latest` 是 **0.4.0（2022-09）**，
 *    它配 PixiJS **v6** 且**完全不感知 moc3 版本**。本项目必须锁 **0.5.0-beta**（配 PixiJS v7）。
 *
 * ⚠️ Core 版本：模型是 **Cubism 5.0（moc3 版本号 5）**。官方 Core 定义了 `MocVersion_50 = 5`，
 *    是最新支持上限 —— 所以**必须用官方 CDN 上的最新 Core**，旧版 Core（只到 4.2）会拒绝加载。
 *
 * 用法：node tools/prepare-renderer-vendor.mjs [--force]
 */
import { copyFileSync, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const vendor = join(repo, 'packages', 'pet-shell', 'renderer', 'vendor')
const force = process.argv.includes('--force')

mkdirSync(vendor, { recursive: true })

const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'

/** 从 node_modules 里复制 UMD 构建 */
function copyFromNodeModules(rel, destName) {
  const src = join(repo, 'node_modules', rel)
  if (!existsSync(src)) throw new Error(`找不到 ${rel} —— 先跑：pnpm add pixi.js@^7 pixi-live2d-display@0.5.0-beta`)
  const dst = join(vendor, destName)
  if (existsSync(dst) && !force) {
    console.log(`· ${destName} 已存在，跳过（--force 可覆盖）`)
    return
  }
  copyFileSync(src, dst)
  console.log(`· ${destName}  ← node_modules/${rel}  (${(statSync(dst).size / 1024).toFixed(0)} KB)`)
}

/** 下载官方 Cubism Core */
async function fetchCore() {
  const dst = join(vendor, 'live2dcubismcore.min.js')
  if (existsSync(dst) && !force) {
    console.log(`· live2dcubismcore.min.js 已存在，跳过（--force 可覆盖）`)
    return
  }
  console.log(`· 下载 Cubism Core ← ${CORE_URL}`)
  const res = await fetch(CORE_URL, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`Core 下载失败 HTTP ${res.status}`)
  const body = await res.text()
  // 校验：确认它声明了 MocVersion_50（即支持 Cubism 5.0），否则模型加载不了
  if (!/MocVersion_50/.test(body)) {
    throw new Error('下载到的 Core 没有 MocVersion_50 —— 版本过旧，无法加载 Cubism 5.0 模型')
  }
  writeFileSync(dst, body, 'utf8')
  console.log(`· live2dcubismcore.min.js  (${(body.length / 1024).toFixed(0)} KB)  含 MocVersion_50 ✅`)
}

console.log('准备渲染端 vendor…')
copyFromNodeModules(join('pixi.js', 'dist', 'pixi.min.js'), 'pixi.min.js')
// ⚠️ CSP 里没有 'unsafe-eval'，而 PixiJS 默认用 new Function 生成着色器 →
//    会抛 "Current environment does not allow unsafe-eval"（实测）。
//    @pixi/unsafe-eval 是官方提供的替代实现（原本给微信小游戏这类禁 eval 环境用）。
//    必须紧跟在 pixi.min.js 之后加载。
copyFromNodeModules(join('@pixi', 'unsafe-eval', 'dist', 'unsafe-eval.min.js'), 'unsafe-eval.min.js')
copyFromNodeModules(join('pixi-live2d-display', 'dist', 'cubism4.min.js'), 'cubism4.min.js')

// ⚠️ 必须补 process 垫片（实测踩过）：
//   pixi-live2d-display 的 UMD 构建内部引用了 `process.env.NODE_ENV`。
//   浏览器环境没有 process → 抛 `ReferenceError: process is not defined`，
//   **整个 cubism4.min.js 不执行** → window.PIXI.live2d 不存在 → 模型加载不了。
//   而 CSP 是 script-src 'self'（禁内联），所以只能用独立文件。
writeFileSync(
  join(vendor, 'process-shim.js'),
  `// 自动生成，请勿手改（tools/prepare-renderer-vendor.mjs）
// 浏览器没有 process，而 pixi-live2d-display 的 UMD 构建引用了 process.env.NODE_ENV。
// 不补这个垫片，cubism4.min.js 会抛 ReferenceError 并整包不执行。
window.process = window.process || {
  env: { NODE_ENV: 'production' },
  platform: 'browser',
  version: '',
  nextTick: (fn) => setTimeout(fn, 0),
};
`,
  'utf8',
)
console.log('· process-shim.js  已生成（CSP 禁内联，必须独立文件）')

await fetchCore()

console.log('\nvendor 目录内容：')
for (const f of ['process-shim.js', 'pixi.min.js', 'unsafe-eval.min.js', 'live2dcubismcore.min.js', 'cubism4.min.js']) {
  const p = join(vendor, f)
  console.log(`  ${existsSync(p) ? '✅' : '❌'} ${f}  ${existsSync(p) ? (statSync(p).size / 1024).toFixed(0) + ' KB' : ''}`)
}
