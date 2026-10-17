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
 *   node scripts/update-index.mjs --commit-version              # 把 commit 编进版本号（默认 prerelease 形态）
 *   node scripts/update-index.mjs --commit-version build        # 用 build metadata 形态（更保守）
 *
 * `--commit-version`：让「commit 不同」也能点升级
 * ---------------------------------------------
 * DSH 判断「有没有新版本」**只比 SemVer 字符串，永远不看 commit**：
 * 卡片徽标是 `semver.gt(索引版本, 已安装版本)`，版本行「安装」按钮是
 * `installedVersion !== version.version` 的**字符串**比较。
 * 所以上游只改代码、不抬版本号时，索引版本 == 已安装版本，按钮根本不出现。
 *
 * 打开本开关后，版本写成下面两种形态之一（详细对比见 docs/ci-sync.md）：
 * - `prerelease`（默认）：`0.2.0-rc.11.commit.15f2a79`
 *   大于 `rc.11`（徽标显示「有新版本」），又小于上游未来的 `rc.12`（不压住真版本）。
 * - `build`：`0.2.0-rc.11+commit.15f2a79`
 *   build metadata 按 SemVer 规范不参与优先级比较，天生压不住任何版本，最保守；
 *   代价是 `semver.gt` 恒为 false，卡片徽标只显示「已安装」，得点进详情页才看到安装按钮。
 *
 * **绝不要**用连字符形态 `0.2.0-rc.11-15f2a79`：prerelease 会切成 `["rc","11-15f2a79"]`，
 * 而纯数字标识符优先级低于含字母标识符，`11-15f2a79` **大于** `12`，
 * 合成版本会永久压住上游未来的真版本。
 *
 * 同一版本核心只保留最新那条（pruneBase），上游反复推送不会让索引无限膨胀。
 *
 * 代价（说清楚才好决定要不要开）：本机装的 `package.json` 里版本仍是 `0.2.0-rc.11`，
 * 与索引的合成版本永远不等，所以「有新版本」提示在装完后**不会自动消失**，
 * 装一次即可，是无害的重复安装。想要干净的更新提示，仍应让上游抬版本号。
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  DEFAULT_REPO_URL,
  arg,
  buildVersionEntry,
  dshRangeFromPeers,
  detectSyntheticStyle,
  flag,
  loadIndexDocument,
  mergeVersion,
  readCheckout,
  syntheticVersion,
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

// `--commit-version`（可选形态：`--commit-version prerelease|build|never`，默认 prerelease）。
// 不带该开关时，若索引里**已经在用**合成形态则沿用（粘性），否则保持上游原始版本号。
// `never` 用于显式关掉：否则粘性会让它一直生效，没法手动退回。
const styleIndex = process.argv.indexOf('--commit-version')
const styleArg = styleIndex === -1 ? undefined : process.argv[styleIndex + 1]
// 后面紧跟另一个开关（或没有值）时按默认形态处理，例如 `--commit-version --dry-run`。
const requestedStyle =
  styleIndex === -1 ? false : styleArg === undefined || styleArg.startsWith('--') ? 'prerelease' : styleArg
if (requestedStyle !== false && !['prerelease', 'build', 'never'].includes(requestedStyle)) {
  throw new Error(`--commit-version 只接受 prerelease / build / never，收到：${requestedStyle}`)
}

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

// 粘性：没显式指定形态时，沿用索引里已有的合成形态（让定时 CI 不会把手工打开的模式冲掉）。
// 但**上游一旦抬了版本号**就自动退场：否则本机装回原始版本号后，索引仍挂着
// `0.2.0-rc.11.commit.xxx`，「有新版本」徽标永不消失。抬版本后回到干净的原生版本号。
const detected = detectSyntheticStyle(plugin?.versions ?? [])
let commitVersion =
  requestedStyle === false ? (detected === false ? false : detected.style) : requestedStyle === 'never' ? false : requestedStyle
if (requestedStyle === 'never') {
  console.log('  --commit-version never：显式关闭合成版本，回到上游原始版本号')
} else if (requestedStyle === false && detected !== false) {
  if (detected.base !== remote.manifest.version) {
    console.log(`  上游版本号已从 ${detected.base} 抬到 ${remote.manifest.version}，合成后缀自动退场`)
    commitVersion = false
  } else {
    console.log(`  沿用索引里已有的合成版本形态：${detected.style}（可用 --commit-version 覆盖）`)
  }
}

const entry = buildVersionEntry({
  // 打开合成模式时，版本号编入 commit（只动版本字符串，commit 与时间戳照旧）。
  version:
    commitVersion === false
      ? remote.manifest.version
      : syntheticVersion(remote.manifest.version, remote.commit, commitVersion),
  publishTimestamp: remote.publishTimestamp,
  commit: remote.commit,
  repoUrl,
  enginesDsh,
})

const before = JSON.stringify(document)
const { versions, action } = mergeVersion(plugin?.versions ?? [], entry, {
  repin,
  // 同一版本核心只留一条，但**仅在合成模式相关时**才裁剪：
  // - 正在用合成模式：清掉同核心的旧 commit 条目；
  // - 正在关闭（never）或上游抬版本后自动退场：清掉同核心残留的合成条目。
  // 全程没碰过合成模式的普通仓库保持原有「只追加、不改历史」的行为。
  pruneBase: commitVersion !== false || detected !== false,
})
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
