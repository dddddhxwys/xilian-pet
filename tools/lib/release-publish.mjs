/**
 * 发布 GitHub Release 的**纯逻辑**（可自测部分）。
 *
 * 为什么单独放 lib：CLI 那侧一旦 `import` 就会发网络请求，没法在自测里 import；
 * 而"要传哪些文件""Release 标题怎么定""URL 怎么拼"这些全是纯函数，必须能测。
 * 网络与文件系统操作在 `tools/publish-release.mjs`。
 */

import { PROJECT_SLUG, RELEASES_PAGE } from './update-check.mjs'
import { parseReleaseArtifact } from './release-files.mjs'

export { PROJECT_SLUG, RELEASES_PAGE }

/** 建 Release：POST /repos/{owner}/{repo}/releases */
export const CREATE_RELEASE_URL = `https://api.github.com/repos/${PROJECT_SLUG}/releases`

/** 查某个 tag 的 Release（404 = 还没建） */
export function releaseByTagUrl(tag) {
  return `https://api.github.com/repos/${PROJECT_SLUG}/releases/tags/${encodeURIComponent(tag)}`
}

/** PATCH 某个 Release（改说明正文 / 标题） */
export function releaseApiUrl(releaseId) {
  return `https://api.github.com/repos/${PROJECT_SLUG}/releases/${releaseId}`
}

/** 传资产：注意是 uploads.github.com，不是 api.github.com */
export function assetUploadUrl(releaseId, fileName) {
  return `https://uploads.github.com/repos/${PROJECT_SLUG}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`
}

/** 删/改某个已上传的资产（GitHub 删资产是 DELETE 这个 URL，**不是** uploads 那个） */
export function assetApiUrl(assetId) {
  return `https://api.github.com/repos/${PROJECT_SLUG}/releases/assets/${assetId}`
}

/**
 * 挑出该**从 Release 上摘掉**的旧资产。
 *
 * 为什么需要：重打一版之后 `versions.json` 只认新的那几个文件，而 Release 上
 * 旧的那几个还挂着 —— 不摘掉就会出现"同一形态两个包"，用户不知道该下哪个。
 *
 * 与本地清理**同一条白名单规则**（2026-10-06 的教训）：
 *   · 只认 `<前缀>-<形态>-<时间戳>.zip(.sha256)` 这种我们自己的产物名 ——
 *     手工挂上去的截图/额外文件一律不碰
 *   · `keepNames` 为空 → 一个都不删（拿不准就别动线上东西）
 */
export function staleReleaseAssets(remoteNames, keepNames) {
  const keep = new Set((keepNames ?? []).filter((one) => typeof one === 'string' && one !== ''))
  if (keep.size === 0) return []
  return (remoteNames ?? [])
    .filter((name) => typeof name === 'string' && parseReleaseArtifact(name) !== null && !keep.has(name))
    .sort()
}

/**
 * 这次要上传哪些文件：清单里**每个资产**的 zip + 它的 `.sha256`。
 *
 * ⚠️ 单一真相源是 `versions.json`：手工再写一遍文件清单必然迟早对不上
 *    （2026-10-06 就吃过"发了 A、清单里写 B"的亏）。脏数据（缺 file / 空串）
 *    直接跳过 —— 否则会拼出一个 `undefined.sha256` 然后上传失败。
 */
export function releaseAssetFiles(manifest) {
  const files = []
  for (const asset of manifest?.assets ?? []) {
    const file = asset?.file
    if (typeof file !== 'string' || file.trim() === '') continue
    files.push(file)
    files.push(`${file}.sha256`)
  }
  return files
}

/** tag 名：与 `versions.json` 里 url 的约定一致（`…/releases/download/v0.1.0/…`） */
export function releaseTag(manifest) {
  return `v${manifest?.latest ?? '0.0.0'}`
}

/**
 * 已发布 Release 的正文需不需要更新？
 *
 * 为什么要有：Release 正文是**用户看到的那段话**（怎么装、怎么用、许可证）。
 * 发现写错了却只能上网页手改，迟早没人改 —— 而错的说明比没有说明更糟。
 * 比较时 `trimEnd()`：文件末尾多个换行不该触发一次无意义的 PATCH。
 */
export function needsBodySync(currentBody, notesText) {
  return String(currentBody ?? '').trimEnd() !== String(notesText ?? '').trimEnd()
}

/**
 * POST /releases 的 body。
 * 标题取说明文件的**第一个非空行**去掉 `#`（说明第一行本来就是标题）；
 * 说明为空就回退到 tag —— 绝不发一个没名字的 Release。
 */
export function releasePayload({ tag, notesText }) {
  const text = typeof notesText === 'string' ? notesText : ''
  const firstLine = text.split('\n').find((one) => one.trim() !== '') ?? ''
  const name = firstLine.replace(/^#\s*/, '').trim() || tag
  return { tag_name: tag, name, body: text, draft: false, prerelease: false }
}
