/**
 * 读上游插件仓库的「最新 commit + package.json」。
 *
 * 只负责**读**，不碰索引规则（那些在 `index-rules.mjs`）。
 *
 * 为什么需要「两个源」
 * --------------------
 * 上游主仓库在 Gitee，另有 GitHub 镜像 `iJetLi/dsh-providers-hub`。
 * **镜像与 Gitee 是同一份 commit（同 40 位 SHA）**，所以：
 * - **检测**可以从任一源读：谁快、谁稳就用谁（Gitee 偶发 5xx / 限流）；
 * - **安装来源**（写进索引的 `source.url`）是另一件事，默认仍是 Gitee，
 *   历史条目因此一字不改，国内用户也不会被迫走 GitHub clone。
 *
 * 三条读取路径
 * ------------
 * 1. **Gitee OpenAPI**：`commits?per_page=1` + `contents/package.json?ref=<sha>`，实测约 0.5–2 s。
 * 2. **GitHub OpenAPI**：同样的两步，实测约 1–2 s。
 *    必须带 `ref=<sha>`：不带就是「默认分支的最新内容」，与拿到的 sha 可能不是同一棵树。
 * 3. **`git clone --depth 1`** 兜底：任一 API 不可用（限流 / 5xx / 网络）时使用，实测约 10 s / 25 MB。
 *
 * 可达性前提（重要）
 * ------------------
 * GitHub 托管 runner 能直连 Gitee（2026-10-16 实测）。但**国内网络下 `api.github.com`
 * 可能连不上**（实测 `connect ECONNREFUSED 140.82.112.5:443`），而 `github.com` 的 git 协议
 * 仍可用。所以 GitHub 路径失败必须能干净地回落到 clone —— 两条路径都在下面实现了。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { readCheckout } from './index-rules.mjs'

const RETRIES = 3
const RETRY_DELAY_MS = 3000

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 带重试的 JSON GET；上游偶发 5xx / 限流时不要让整个 job 红。 */
export async function fetchJson(url, { retries = RETRIES } = {}) {
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

/**
 * 把仓库地址解析成 `{ host, slug }`。
 *
 * @param repoUrl - 形如 `https://gitee.com/owner/repo` 或 `https://github.com/owner/repo`（可带 `.git`）。
 * @returns `host` 为 `'gitee'` / `'github'`；不是这两个站点时为 `undefined`（只能用 clone）。
 *   `slug` 为 `owner/repo`。
 */
export function parseRepoUrl(repoUrl) {
  const matched = /^https:\/\/(gitee\.com|github\.com)\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/u.exec(
    repoUrl.trim(),
  )
  if (matched === null) return { host: undefined, slug: undefined }
  return { host: matched[1] === 'gitee.com' ? 'gitee' : 'github', slug: `${matched[2]}/${matched[3]}` }
}

/**
 * 校验仓库地址：索引里的 `source.url` 只认这两种 https 仓库地址
 * （format 1 会拒绝 `file://` 等形态），提前拦掉，避免跑完一轮才发现校验不过。
 *
 * @returns 规范化后的地址。
 */
export function assertRepoUrl(repoUrl, label = '仓库地址') {
  const { slug } = parseRepoUrl(repoUrl)
  if (slug === undefined) {
    throw new Error(
      `${label}必须是 https://gitee.com/<owner>/<repo> 或 https://github.com/<owner>/<repo>：${repoUrl}`,
    )
  }
  return repoUrl.trim()
}

/** 两个平台各取所需的 API 前缀。 */
function apiBase(host, slug) {
  return host === 'gitee' ? `https://gitee.com/api/v5/repos/${slug}` : `https://api.github.com/repos/${slug}`
}

/**
 * 从 OpenAPI 读最新 commit 与**该 commit 的** `package.json`，不 clone。
 *
 * @returns `{ manifest, commit, publishTimestamp, message }`。
 */
async function readRemoteByApi(host, slug) {
  const api = apiBase(host, slug)
  const commits = await fetchJson(`${api}/commits?per_page=1`)
  const head = commits?.[0]
  if (head?.sha === undefined) throw new Error('commits 接口没有返回 sha')

  // 必须用 sha 取内容：Gitee 与 GitHub 都支持 `?ref=<sha>`。
  // 省掉 ref 会读到「默认分支当前内容」，与 head.sha 不是同一棵树（并发推送时会错位）。
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
}

/** 兜底路径：`git clone --depth 1` 后按本地 HEAD 读。 */
function readRemoteByClone(repoUrl) {
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

/**
 * 读远端仓库的最新 commit 及其 `package.json`。
 *
 * Gitee / GitHub 地址优先走 OpenAPI（一次 `commits` + 一次 `contents`，不 clone）；
 * 其它站点，或 API 失败（限流 / 5xx / 本机连不上 `api.github.com`）时回落 `git clone --depth 1`。
 *
 * `fallbackUrl` 用于「检测源」场景：镜像整站不可达时，再去读主仓库
 * （两个源 commit 一致，所以结果等价）。**不设**这个参数就不会静默换源，
 * 保持单源语义。
 *
 * @param repoUrl - 上游仓库地址。
 * @param options.fallbackUrl - 主仓库地址；仅在 `repoUrl` 的 API 与 clone **都**失败时使用。
 * @returns `{ manifest, commit, publishTimestamp, message }`。
 */
export async function readRemote(repoUrl, { fallbackUrl } = {}) {
  const { host, slug } = parseRepoUrl(repoUrl)
  if (host === undefined) {
    console.log('  非 Gitee / GitHub 地址，直接用 git clone 读取')
    return readRemoteByClone(repoUrl)
  }
  try {
    return await readRemoteByApi(host, slug)
  } catch (error) {
    console.error(`  ! ${host} API 不可用（${error.message}），回落到 git clone`)
  }
  try {
    return readRemoteByClone(repoUrl)
  } catch (error) {
    if (fallbackUrl === undefined) throw error
    console.error(`  ! ${repoUrl} 完全不可达（${error.message.split('\n')[0]}），改用主仓库 ${fallbackUrl}`)
  }
  return readRemote(fallbackUrl)
}
