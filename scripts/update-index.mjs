#!/usr/bin/env node
/**
 * 自动同步索引：读取**远端插件仓库**的最新 commit，把它并入 `plugin-market.json`。
 *
 * 与 `generate-index.mjs` 的分工：
 * - `generate-index.mjs`：在**插件仓库**里跑，版本取自本地 HEAD（人工发布用）。
 * - 本脚本：在**索引仓库**里跑（CI 定时任务 / 手动），版本取自远端最新 commit。
 *   两者共用 `scripts/lib/index-rules.mjs` 的构建规则，结果可互相叠加。
 *
 * 关键行为（决定了「发现」页会怎么显示）：
 * - **追加**：远端 `package.json` 的 `version` 在索引里不存在 → 追加一条。
 *   DSH 的「更新」判据是 **SemVer 比较**（`semver.gt(索引版本, 已安装版本)`），
 *   所以只有上游**真的抬了版本号**，用户才会看到「有新版本」。
 * - **重定 commit（repin）**：版本号没变、但最新版本对应的 commit 变了 → 改写**最新那一条**的
 *   commit 与时间戳。这样上游「只改代码不抬版本号」时，新装用户仍能拿到最新代码。
 *   历史版本条目**永不改写**（索引一旦发布就不该被悄悄改变）。
 * - 用 `--no-repin` 可关掉重定行为，只认版本号变化。
 *
 * 用法（在索引仓库根目录执行）：
 *   node scripts/update-index.mjs                 # 写入 plugin-market.json
 *   node scripts/update-index.mjs --dry-run       # 只报告，不写文件
 *   node scripts/update-index.mjs --check         # 有变化则退出码 1（给 CI 做门禁用）
 *   node scripts/update-index.mjs --repo <url>    # 换上游仓库
 *   node scripts/update-index.mjs --no-repin      # 不重定同版本的 commit
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  DEFAULT_REPO_URL,
  arg,
  buildVersionEntry,
  dshRangeFromPeers,
  flag,
  loadIndexDocument,
  mergeVersion,
  readCheckout,
  upsertPlugin,
  validateIndex,
} from './lib/index-rules.mjs'

const RETRIES = 3
const RETRY_DELAY_MS = 3000

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 带重试的 JSON GET；Gitee 偶发 5xx / 限流时不要让整个 job 红。 */
async function fetchJson(url, { retries = RETRIES } = {}) {
  let last
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-index-sync' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      return await response.json()
    } catch (error) {
      last = error
      console.error(`  ! ${url} 第 ${attempt}/${retries} 次失败：${error.message}`)
      if (attempt < retries) await sleep(RETRY_DELAY_MS * attempt)
    }
  }
  throw new Error(`读取失败：${url}（${last?.message}）`)
}

/** `https://gitee.com/owner/repo` → `owner/repo`；不是 Gitee 地址时返回 undefined。 */
function giteeSlug(repoUrl) {
  const matched = /^https:\/\/gitee\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u.exec(repoUrl.trim())
  return matched?.[1]
}

/**
 * 读取远端仓库最新 commit 及其 `package.json`。
 *
 * Gitee 地址优先走 OpenAPI（一次拿到 sha + committer 日期 + 指定 commit 的文件内容，无需 clone，
 * 实测约 2 s；clone `--depth 1` 约 10 s / 25 MB）；其余情况或 API 失败时回落到 `git clone --depth 1`。
 *
 * @returns `{ manifest, commit, publishTimestamp, message }`。
 */
async function readRemote(repoUrl) {
  const slug = giteeSlug(repoUrl)
  if (slug === undefined) {
    console.log('  非 Gitee 地址，直接用 git clone 读取')
    return readRemoteByClone(repoUrl)
  }
  const api = `https://gitee.com/api/v5/repos/${slug}`

  try {
    const commits = await fetchJson(`${api}/commits?per_page=1`)
    const head = commits?.[0]
    if (head?.sha === undefined) throw new Error('commits 接口没有返回 sha')
    const contents = await fetchJson(`${api}/contents/package.json?ref=${head.sha}`)
    if (contents?.content === undefined) throw new Error('contents 接口没有返回内容')
    const manifest = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8'))
    const date = head.commit?.committer?.date ?? head.commit?.author?.date
    const publishTimestamp = Math.floor(new Date(date).getTime() / 1000)
    if (!Number.isInteger(publishTimestamp)) throw new Error(`解析不出 commit 时间：${date}`)
    return {
      manifest,
      commit: head.sha,
      publishTimestamp,
      message: (head.commit?.message ?? '').split('\n')[0],
    }
  } catch (error) {
    console.error(`  ! Gitee API 不可用（${error.message}），回落到 git clone`)
  }

  return readRemoteByClone(repoUrl)
}

/** 兜底路径：`git clone --depth 1` 后按本地 HEAD 读。 */
async function readRemoteByClone(repoUrl) {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { execFileSync } = await import('node:child_process')
  const directory = mkdtempSync(resolve(tmpdir(), 'dsh-plugin-sync-'))
  execFileSync('git', ['clone', '--depth', '1', '--single-branch', repoUrl, directory], {
    stdio: 'inherit',
  })
  const { manifest, commit, publishTimestamp } = readCheckout(directory)
  const message = execFileSync('git', ['show', '-s', '--format=%s', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim()
  return { manifest, commit, publishTimestamp, message }
}

const repoUrl = arg('repo', DEFAULT_REPO_URL)
const out = resolve(arg('out', 'plugin-market.json'))
const repin = !flag('no-repin')
const dryRun = flag('dry-run') || flag('check')

// 索引里的 source.url / homepage 必须是 https 仓库地址（format 1 会拒绝 file:// 等形态），
// 提前拦掉，避免跑完一轮才发现校验不过。
if (!/^https:\/\/[^\s]+$/u.test(repoUrl) || !repoUrl.includes('/', 'https://'.length)) {
  throw new Error(`--repo 必须是 https 仓库地址：${repoUrl}`)
}

console.log(`上游仓库 ${repoUrl}`)
const remote = await readRemote(repoUrl)
console.log(`  最新 commit ${remote.commit}`)
console.log(`  ${remote.manifest.name}@${remote.manifest.version}  ${remote.message}`)

const enginesDsh = arg('engines', '') || dshRangeFromPeers(remote.manifest.peerDependencies)
if (enginesDsh === '') {
  throw new Error('推导不出 engines.dsh（上游 peerDependencies 里没有 @deepseek-ai/dsh*），请用 --engines 显式指定')
}

const entry = buildVersionEntry({
  version: remote.manifest.version,
  publishTimestamp: remote.publishTimestamp,
  commit: remote.commit,
  repoUrl,
  enginesDsh,
})

const document = loadIndexDocument(out)
const plugin = document.plugins.find((candidate) => candidate.name === remote.manifest.name)
const before = JSON.stringify(document)
const { versions, action } = mergeVersion(plugin?.versions ?? [], entry, { repin })
upsertPlugin(document, { manifest: remote.manifest, versions, repoUrl })
const after = JSON.stringify(document)

await validateIndex(document, { require: flag('require-validator') })
console.log(`  engines.dsh = ${enginesDsh}`)
console.log(`  版本条目 ${action}，共 ${versions.length} 个版本`)

const changed = before !== after
if (!changed) {
  console.log('索引无需变更')
} else if (dryRun) {
  console.log(`索引需要变更（${action}），--dry-run / --check 模式不写文件`)
} else {
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  console.log(`已写入 ${out}`)
}

// 给 GitHub Actions 传值；本地执行时这几个环境变量不存在，静默跳过。
if (process.env.GITHUB_OUTPUT !== undefined) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${String(changed)}\naction=${action}\nversion=${remote.manifest.version}\ncommit=${remote.commit}\n`,
  )
}

if (flag('check') && changed) process.exitCode = 1
