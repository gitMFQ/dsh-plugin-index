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
 *   node scripts/update-index.mjs --repo <url>    # 换上游仓库（检测与安装来源一起换）
 *   node scripts/update-index.mjs --detect-repo <url>  # 只换「检测」源，安装来源仍写 --repo
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
 * 粘性（开一次就一直生效，**抬版本号也不退场**）
 * --------------------------------------------
 * 开关一旦在索引里生效，不带 `--commit-version` 的定时任务会**一直沿用**它
 * （见 `detectSyntheticStyle`：只看索引里版本最高的那条）。上游抬版本号时也一样沿用 ——
 * 只是换了版本核心，后缀跟着挂到新版本上：
 * `0.2.0-rc.11.commit.15f2a79` → 上游发布 `0.2.1-rc.2` → `0.2.1-rc.2.commit.e14729c`。
 *
 * 所以「索引里的版本号永远带 commit」是**一次开启、长期有效**的状态；
 * 想退回干净版本号必须**显式**关：`--commit-version never`（手动触发时选「关闭」）。
 * 关掉之后最新那条变成干净版本号，后续定时任务不会再把它粘回来
 * （历史条目里残留的合成后缀不作数）。
 *
 * 检测源与安装来源可以分开：`--detect-repo`
 * -----------------------------------------
 * 上游主仓库在 Gitee，另有一个 commit 完全一致的 GitHub 镜像
 * （`iJetLi/dsh-providers-hub`）。两个地址指向同一份代码，所以可以
 * **从任一源「检测」新版本，却仍按 `--repo` 写「安装来源」**：
 *
 *   node scripts/update-index.mjs \
 *     --repo https://gitee.com/iJetLi/deepseek-harness-codearts \
 *     --detect-repo https://github.com/iJetLi/dsh-providers-hub
 *
 * 这样镜像只当检测通道（API 更稳、更快），索引里每个版本的 `source.url` 仍是 Gitee，
 * 历史条目一个字都不用改，国内用户也不会被迫走 GitHub clone。
 *
 * ⚠️ 两个源的 commit 必须一致才有意义。脚本**不做**一致性比对（那要多打一次 API），
 * 但会把检测到的 commit 打印出来；怀疑镜像落后时用
 * `git ls-remote` 或 `curl` 各自对一下 `master` 的 sha 即可。
 *
 * 代价（说清楚才好决定要不要开）：本机装的 `package.json` 里版本仍是 `0.2.1-rc.2`，
 * 与索引的合成版本永远不等，所以「有新版本」提示在装完后**不会自动消失**（徽标常亮），
 * 装一次即可，是无害的重复安装。**抬版本号也治不好它** —— 因为合成模式是粘性的，
 * 新版本照样带后缀。想要干净的更新提示，就得显式 `--commit-version never` 关掉合成模式。
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
  syntheticVersion,
  upsertPlugin,
  validateIndex,
} from './lib/index-rules.mjs'
import { assertRepoUrl, readRemote } from './lib/remote.mjs'

const repoUrl = assertRepoUrl(arg('repo', DEFAULT_REPO_URL), '--repo ')
// 检测源：默认与安装来源同一个仓库；可指向 commit 完全一致的镜像（见文件头的 `--detect-repo`）。
const detectRepoUrl = assertRepoUrl(arg('detect-repo', repoUrl), '--detect-repo ')
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

console.log(`安装来源（写进索引 source.url）${repoUrl}`)
let fallbackUrl
if (detectRepoUrl === repoUrl) {
  console.log(`检测源（读最新 commit）${detectRepoUrl}`)
} else {
  // 两个地址指向同一份代码时才有意义：镜像落后会让索引钉到旧 commit 上。
  // 镜像整站不可达时退回安装来源（Gitee）检测 —— 两者 commit 一致，结果等价。
  console.log(`检测源（读最新 commit）${detectRepoUrl}  ← 与安装来源不同，请确认两者 commit 一致`)
  fallbackUrl = repoUrl
}
const remote = await readRemote(detectRepoUrl, { fallbackUrl })
console.log(`  最新 commit ${remote.commit}`)
console.log(`  ${remote.manifest.name}@${remote.manifest.version}  ${remote.message}`)

const enginesDsh = arg('engines', '') || dshRangeFromPeers(remote.manifest.peerDependencies)
if (enginesDsh === '') {
  throw new Error('推导不出 engines.dsh（上游 peerDependencies 里没有 @deepseek-ai/dsh*），请用 --engines 显式指定')
}

const document = loadIndexDocument(out)
const plugin = document.plugins.find((candidate) => candidate.name === remote.manifest.name)

// 粘性：没显式指定形态时，沿用索引里已有的合成形态（让定时 CI 不会把手工打开的模式冲掉）。
// **上游抬了版本号也沿用**：抬版本只是换个版本核心，后缀挂到新版本上
// （`0.2.0-rc.11.commit.aaa` → `0.2.1-rc.2.commit.bbb`），而不是退场 ——
// 退场会让「只改代码期间」打开的开关在上游一抬版本时整段丢失，用户又看不出装的是哪个 commit。
// 要退回干净版本号只能显式 `--commit-version never`。
const detected = detectSyntheticStyle(plugin?.versions ?? [])
let commitVersion =
  requestedStyle === false ? (detected === false ? false : detected.style) : requestedStyle === 'never' ? false : requestedStyle
if (requestedStyle === 'never') {
  console.log('  --commit-version never：显式关闭合成版本，回到上游原始版本号')
} else if (requestedStyle === false && detected !== false) {
  const bumped = detected.base !== remote.manifest.version
  console.log(
    bumped
      ? `  上游版本号已从 ${detected.base} 抬到 ${remote.manifest.version}，合成形态沿用（新版本继续编入 commit）`
      : `  沿用索引里已有的合成版本形态：${detected.style}（可用 --commit-version 覆盖）`,
  )
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
  // - 正在关闭（never）：清掉同核心残留的合成条目，让最新条目干净、后续不再被粘回来。
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
