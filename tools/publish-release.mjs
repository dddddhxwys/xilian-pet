#!/usr/bin/env node
/**
 * 把 `versions.json` 里登记的那一版**发布到 GitHub Releases**（建 tag / Release + 传资产）。
 *
 *   node tools/publish-release.mjs                 # 发 versions.json 的 latest
 *   node tools/publish-release.mjs --dry-run       # 只列出要传什么
 *   node tools/publish-release.mjs --tag=v0.2.0    # 指定 tag
 *   node tools/publish-release.mjs --notes=xxx.md  # 指定 Release 说明文件
 *
 * Token：优先 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量；都没有就试着从**本机 git 凭据**里取
 *        （Windows 凭据管理器里存过就能直接用，省得另配 PAT）。
 *        **token 只进内存与请求头，从不打印。**
 *
 * 幂等：Release 已存在就复用；同名资产已传过就跳过 —— 所以 156 MB 那个传一半断了，
 *       直接重跑即可，不会重复上传也不会覆盖半边。
 *
 * 为什么不用 `gh`：本机存的 token 是 classic PAT 且缺 `read:org`，`gh auth login` 会拒；
 * 而建 Release + 传资产只需要 `repo` 权限，走 REST API 就够，还省掉一次交互式登录。
 *
 * ⚠️ 不要用 `process.exit()`：它会在 fetch/定时器还没收尾时强退，Windows 上直接撞
 *    libuv 断言（`!(handle->flags & UV_HANDLE_CLOSING)`，退出码 0xC0000409）。
 *    `检查更新` 就是这么崩过一次。一律用 `process.exitCode` + 从 main() 返回。
 */

import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  CREATE_RELEASE_URL,
  RELEASES_PAGE,
  assetApiUrl,
  assetUploadUrl,
  needsBodySync,
  releaseApiUrl,
  releaseAssetFiles,
  releaseByTagUrl,
  releasePayload,
  releaseTag,
  staleReleaseAssets,
} from './lib/release-publish.mjs'

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const TAG_ARG = argv.find((one) => one.startsWith('--tag='))?.slice('--tag='.length)
const NOTES_ARG = argv.find((one) => one.startsWith('--notes='))?.slice('--notes='.length)

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`

/** 本机 git 里存过 GitHub 凭据的话直接拿来用（沙箱里子进程管道会失败 → 返回 null） */
function tokenFromGitCredential() {
  try {
    const r = spawnSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (r.status !== 0 || typeof r.stdout !== 'string') return null
    const line = r.stdout.split('\n').find((one) => one.startsWith('password='))
    return line === undefined ? null : line.slice('password='.length)
  } catch {
    return null
  }
}

function resolveToken() {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    console.log('token  : 环境变量')
    return fromEnv.trim()
  }
  const fromGit = tokenFromGitCredential()
  if (fromGit !== null) {
    console.log('token  : 本机 git 凭据（不显示内容）')
    return fromGit
  }
  return null
}

async function main() {
  const manifest = JSON.parse(readFileSync('versions.json', 'utf8'))
  const tag = TAG_ARG ?? releaseTag(manifest)
  const notesFile = NOTES_ARG ?? join('dist-release', 'RELEASE-NOTES.md')
  const files = releaseAssetFiles(manifest)

  console.log('昔涟桌宠 · 发布到 GitHub Releases')
  console.log('─'.repeat(52))
  console.log(`标签   : ${tag}`)
  console.log(`说明   : ${notesFile}`)
  console.log(`资产   : ${files.length} 个（来自 versions.json）`)

  if (files.length === 0) {
    console.error('\n❌ versions.json 里没有任何资产 —— 先用 tools/package-release.mjs 打包。')
    process.exitCode = 1
    return
  }
  // 本地文件先全查一遍：别传到一半才发现少东西
  for (const file of files) {
    const path = join('dist-release', file)
    if (!existsSync(path)) {
      console.error(`\n❌ 本地缺文件：${path}\n   先重新打包（tools/package-release.mjs）。`)
      process.exitCode = 1
      return
    }
    console.log(`   · ${file}  ${mb(statSync(path).size)}`)
  }
  if (!existsSync(notesFile)) {
    console.error(`\n❌ 找不到说明文件：${notesFile}\n   用 --notes=<文件> 指定，或先写一份。`)
    process.exitCode = 1
    return
  }
  const notesText = readFileSync(notesFile, 'utf8')

  if (DRY_RUN) {
    console.log('\n--dry-run：什么都没做')
    return
  }

  const token = resolveToken()
  if (token === null) {
    console.error(
      '\n❌ 没有可用的 GitHub token。二选一：\n' +
        '     · 设环境变量：set GITHUB_TOKEN=<你的 PAT>（需要 repo 权限）\n' +
        '     · 或让本机 git 存过 github.com 的凭据（git push 能用就行）',
    )
    process.exitCode = 1
    return
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'xilian-pet-publish-release',
  }

  /** 查当前 tag 的 Release；没有就建一个 */
  async function findRelease() {
    const res = await fetch(releaseByTagUrl(tag), { headers })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`查 Release 失败 ${res.status}：${await res.text()}`)
    return res.json()
  }

  let release = await findRelease()
  if (release === null) {
    const res = await fetch(CREATE_RELEASE_URL, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(releasePayload({ tag, notesText })),
    })
    if (!res.ok) throw new Error(`建 Release 失败 ${res.status}：${await res.text()}`)
    release = await res.json()
    console.log(`\n✓ 已创建 Release：${release.html_url}`)
  } else {
    console.log(`\n已存在 Release，复用它：${release.html_url}`)
    // 说明文件改了就把正文同步过去 —— 否则改错别字都要上网页手改，于是没人改
    if (needsBodySync(release.body, notesText)) {
      const payload = releasePayload({ tag, notesText })
      const res = await fetch(releaseApiUrl(release.id), {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: payload.name, body: payload.body }),
      })
      if (!res.ok) throw new Error(`更新 Release 说明失败 ${res.status}：${await res.text()}`)
      release = await res.json()
      console.log('  ✓ Release 说明与本地文件不一致，已同步更新')
    } else {
      console.log('  说明与本地文件一致，无需更新')
    }
  }

  const uploaded = new Set((release.assets ?? []).map((one) => one.name))
  for (const file of files) {
    if (uploaded.has(file)) {
      console.log(`  跳过（远端已有）：${file}`)
      continue
    }
    const path = join('dist-release', file)
    const size = statSync(path).size
    console.log(`  上传 ${file}（${mb(size)}）…`)
    const res = await fetch(assetUploadUrl(release.id, file), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(size) },
      body: createReadStream(path),
      duplex: 'half',
    })
    if (!res.ok) throw new Error(`上传 ${file} 失败 ${res.status}：${await res.text()}`)
    const done = await res.json()
    console.log(`    ✓ ${done.name}  ${done.size} 字节`)
  }

  // 事后核对：远端每个资产的大小必须与本地逐个一致 —— 别只看"上传成功"四个字
  const after = await findRelease()
  let bad = 0
  console.log('\n远端资产核对：')
  for (const file of files) {
    const remote = (after.assets ?? []).find((one) => one.name === file)
    const local = statSync(join('dist-release', file)).size
    if (remote === undefined) {
      console.log(`  ❌ 远端没有 ${file}`)
      bad += 1
    } else if (remote.size !== local) {
      console.log(`  ❌ ${file} 大小不符：远端 ${remote.size} ≠ 本地 ${local}`)
      bad += 1
    } else {
      console.log(`  ✅ ${file}  ${remote.size} 字节`)
    }
  }

  // 摘掉清单里已经没有的旧资产 —— 否则同一形态会挂着两套，用户不知道该下哪个。
  // ⚠️ 必须在**上传成功之后**才删：万一这次没传上去，旧的那份还得留着兜底。
  //    （上传失败的路径上面已经抛错并结束，走不到这里 ✓）
  if (bad === 0) {
    const staleRemote = staleReleaseAssets(
      (after.assets ?? []).map((one) => one.name),
      files,
    )
    if (staleRemote.length > 0) {
      console.log('\n🧹 摘掉 Release 上清单里已没有的旧资产：')
      for (const name of staleRemote) {
        const asset = (after.assets ?? []).find((one) => one.name === name)
        const res = await fetch(assetApiUrl(asset.id), { method: 'DELETE', headers })
        if (!res.ok && res.status !== 404) {
          throw new Error(`删除旧资产 ${name} 失败 ${res.status}：${await res.text()}`)
        }
        console.log(`     · ${name}`)
      }
    }
  } else {
    console.log('\n（有资产对不上，这次**不删**任何旧资产 —— 先保证有可用的那份）')
  }

  console.log(`\nRelease 页面：${after.html_url}`)
  console.log(`全部发布页：${RELEASES_PAGE}`)
  if (bad === 0) {
    console.log('全部一致 ✓')
  } else {
    console.log(`有 ${bad} 个不符 ✗ —— 重跑本命令会补传缺失的那些`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  process.exitCode = 1
})
