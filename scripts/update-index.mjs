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
 * - **版本号只写上游原值**：`version` 恒等于远端 `package.json` 里的字符串，
 *   **绝不把 commit 编进版本号**（早期试过 `0.2.0-rc.11.commit.15f2a79`，已废弃，理由见下）。
 * - **重定 commit（repin）**：版本号没变、但最新版本对应的 commit 变了 → 改写**最新那一条**的
 *   commit 与时间戳。于是索引里的安装目标**始终是上游最新提交**：新装（或点「安装」）拿到的
 *   就是最新代码，不管上游抬没抬版本号。历史版本条目**永不改写**（索引一旦发布就不该被悄悄改变）。
 * - **追加**：远端 `package.json` 的 `version` 在索引里不存在 → 追加一条。
 *   DSH 的「更新」判据是 **SemVer 比较**（`semver.gt(索引版本, 已安装版本)`），
 *   所以只有上游**真的抬了版本号**，已安装的用户才会看到「有新版本」。
 * - 用 `--no-repin` 可关掉重定行为：安装目标会冻结在索引里现有的 commit。
 *
 * 版本号里为什么不写 commit
 * -------------------------
 * DSH 判断「有没有新版本」**只比 SemVer 字符串，从不看 commit**
 * （卡片徽标是 `semver.gt(索引版本, 已安装版本)`，版本行「安装」按钮是
 * `installedVersion !== version.version` 的**字符串**比较）。把 commit 编进版本号
 * 确实能骗出一个可点的按钮，但代价是：
 * - 本机 `package.json` 里的版本仍是 `0.2.0-rc.11`，与索引版本**永不相等**，
 *   装完「有新版本」徽标不会消失 —— 是个永远装不掉的假更新；
 * - 版本号不再是上游发布的值，对版本、排查问题都得先去掉后缀。
 * 所以这里选择**版本号保持干净 + 安装目标跟随最新提交**：更新提示只在
 * **上游抬版本号**时出现；上游不抬版本号时，新装用户照样直接装到最新提交。
 * 需要老用户也看到提示时，正解是让上游抬版本号，而不是在索引里造版本号。
 *
 * 索引里若还留着历史的合成版本条目（`0.2.0-rc.11.commit.xxxxxxx`），同步时会自动清掉。
 *
 * 用法（在索引仓库根目录执行）：
 *   node scripts/update-index.mjs                 # 写入 plugin-market.json
 *   node scripts/update-index.mjs --dry-run       # 只报告，不写文件
 *   node scripts/update-index.mjs --check         # 有变化则退出码 1（给 CI 做门禁用）
 *   node scripts/update-index.mjs --repo <url>    # 换上游仓库
 *   node scripts/update-index.mjs --no-repin      # 不重定同版本的 commit（安装目标冻结）
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

const document = loadIndexDocument(out)
const plugin = document.plugins.find((candidate) => candidate.name === remote.manifest.name)

const entry = buildVersionEntry({
  // 版本号恒为上游 `package.json` 的原值：commit 只写在 `source.commit` 里，
  // 安装目标由它表达（每次同步都会重定到上游最新提交，见文件头「为什么不写 commit」）。
  version: remote.manifest.version,
  publishTimestamp: remote.publishTimestamp,
  commit: remote.commit,
  repoUrl,
  enginesDsh,
})

const before = JSON.stringify(document)
const { versions, action } = mergeVersion(plugin?.versions ?? [], entry, { repin })
upsertPlugin(document, { manifest: remote.manifest, versions, repoUrl })
const after = JSON.stringify(document)

await validateIndex(document, { require: flag('require-validator') })
console.log(`  engines.dsh = ${enginesDsh}`)
console.log(`  版本条目 ${action}，共 ${versions.length} 个版本`)
if (action === 'replaced') {
  console.log('  已清掉索引里历史遗留的合成版本条目（版本号不再编入 commit）')
}

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
