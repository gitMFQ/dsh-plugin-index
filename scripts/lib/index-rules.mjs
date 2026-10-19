/**
 * DSH「自定义插件市场」索引（format 1）的构建规则。
 *
 * 两个入口共用本文件，避免「本地手动生成」与「CI 自动同步」两处规则漂移：
 * - `scripts/generate-index.mjs`：在**插件仓库**里执行，版本取自本地 HEAD。
 * - `scripts/update-index.mjs`：在 CI 里执行，版本取自**远端仓库**的最新 commit。
 *
 * 规则要点（改这里之前先读 README 的「索引格式要点」）：
 * - `engines.dsh` 必须是 `@deepseek-ai/dsh*` peer 的**枚举并集**，不能写成 `^0.1.2-rc.1` 这类简写：
 *   简写会顺带放行同主版本下**从未验证过**的版本，而它是「发现」页决定安装按钮可不可用的唯一判据。
 * - `source.commit` 必须是**完整 40 位小写 commit**。
 * - 索引条目一旦发布就不应被悄悄改写：同版本重定 commit（repin）是显式开关，且只作用于**最新版本**。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件仓库地址；索引里的 `source.url` / `homepage` / `repository` 都用它。 */
export const DEFAULT_REPO_URL = 'https://gitee.com/iJetLi/deepseek-harness-codearts'

/** 本仓库原创图标，内联成 `data:` SVG，避免向第三方图床暴露 IP。 */
export const ICON_PATH = fileURLToPath(new URL('../../assets/icon.svg', import.meta.url))

/** 校验时用的索引地址：只影响相对 icon 的解析，本索引用内联 data: 图标，故取占位地址。 */
const INDEX_URL = 'https://example.invalid/plugin-market.json'

const TITLE = { en: 'Jet Hub Plugins', zh: 'Jet Hub 插件源' }

const DESCRIPTION = {
  en: 'Plugins maintained in the deepseek-harness-codearts repository. Git sources are pinned to full commits.',
  zh: 'deepseek-harness-codearts 仓库维护的插件。Git 来源固定到完整 commit。',
}

const METADATA = {
  categories: { model: { title: { en: 'Models & Providers', zh: '模型与账号接入' } } },
  labels: {
    verified: { title: { en: 'Verified on this machine', zh: '本机实测通过' } },
    git: { title: { en: 'Install from Git', zh: '从 Git 安装' } },
  },
  sortKeys: { stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' } },
}

/**
 * 从一个已检出的插件仓库读出「当前 HEAD 这一个版本」。
 *
 * @param directory - 插件仓库根目录（含 package.json 与完整 Git 元数据）。
 * @returns 该仓库的 manifest、完整 commit 与 commit 时间戳（Unix 秒）。
 */
export function readCheckout(directory) {
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const commit = git('rev-parse', 'HEAD')
  const publishTimestamp = Number(git('show', '-s', '--format=%ct', 'HEAD'))
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`HEAD 不是完整 commit：${commit}`)
  if (!Number.isInteger(publishTimestamp)) throw new Error('取不到 commit 时间戳')
  return { manifest, commit, publishTimestamp }
}

/**
 * 从 `@deepseek-ai/dsh*` peer 里推导 `engines.dsh`。
 *
 * **必须枚举并集，不能合并成 `^0.1.2-rc.1` 这类简写**：合并会顺带放行同主版本下
 * 从未验证过的版本，而 `engines.dsh` 是索引里唯一决定「发现」页显不显示安装按钮的判据
 * —— 宁可窄，不可宽。
 *
 * @param peers - `manifest.peerDependencies`。
 * @returns `a || b || c` 形式的范围；推不出来时返回空串，由调用方决定是否报错。
 */
export function dshRangeFromPeers(peers) {
  const parts = new Set()
  for (const [name, range] of Object.entries(peers ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range !== 'string') continue
    for (const part of range.split('||')) {
      const text = part.trim()
      if (text !== '') parts.add(text)
    }
  }
  return [...parts].sort().join(' || ')
}

/** 解析精确 SemVer（只处理索引里会出现的形态）。 */
function parseVersion(text) {
  const matched = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(text)
  if (matched === null) throw new Error(`不是精确 SemVer：${text}`)
  return {
    numbers: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
    prerelease: matched[4] === undefined ? [] : matched[4].split('.'),
  }
}

/**
 * SemVer 2.0.0 优先级比较（build metadata 不参与），用于让 `versions[]` 稳定地降序排列。
 *
 * @returns 负数表示 left 优先级更低。
 */
export function compareSemver(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i]
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/u.test(x)
    const yNumeric = /^\d+$/u.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (xNumeric) {
      return -1
    } else if (yNumeric) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** 按 SemVer 优先级降序就地排序 `versions[]`。 */
function sortVersionsDescending(versions) {
  versions.sort((left, right) => compareSemver(right.version, left.version))
}

/**
 * 去掉合成 commit 标记，得到上游的「版本核心」。
 *
 * 同时认得两种合成形态：`0.2.0-rc.11.commit.7a3b64a`（点号）与 `0.2.0-rc.11+commit.7a3b64a`（build metadata）。
 * 上游自己写了 build metadata（如 `1.0.0+nightly`）时，点号形态会把整串当核心保留。
 */
export function baseVersionOf(version) {
  const dotted = /^(.+?)\.commit\.[0-9a-f]{4,40}$/u.exec(version)
  if (dotted !== null) return dotted[1]
  const at = version.indexOf('+')
  return at === -1 ? version : version.slice(0, at)
}

/**
 * 把 commit 编进版本号，让「commit 不同」也能点升级。
 *
 * **动机**：DSH 判断有没有新版本只比 SemVer 字符串，**从不看 commit**
 * （市场卡片徽标是 `semver.gt(索引版本, 已安装版本)`；版本行的「安装」按钮是
 * `installedVersion === version.version` 的**字符串**相等判断）。
 * 所以上游只改代码、不抬版本号时，本机 `0.2.0-rc.11` 和索引 `0.2.0-rc.11` 完全相等，
 * 按钮根本不出现——这是本次改造要解决的唯一问题。
 *
 * **两种形态**（`style`）：
 * - `'prerelease'`（默认）→ `0.2.0-rc.11.commit.7a3b64a`
 *   prerelease 按点切开是 `["rc","11","commit","7a3b64a"]`，
 *   因为第 3 段多了标识符，所以**大于** `0.2.0-rc.11`（徽标显示「有新版本」），
 *   又因为第 2 段 `11` < `12`，所以**小于**上游未来的 `0.2.0-rc.12`，不会盖住真版本。
 * - `'build'` → `0.2.0-rc.11+commit.7a3b64a`
 *   build metadata 按规范**不参与优先级比较**，天生压不住任何版本，最保守；
 *   代价是 `semver.gt` 恒为 false，卡片徽标只显示「已安装」，得点进详情页才看到安装按钮。
 *
 * **绝对不能用**连字符形态 `0.2.0-rc.11-7a3b64a`：prerelease 会被切成 `["rc","11-7a3b64a"]`，
 * 而 SemVer 规定**纯数字标识符优先级低于含字母标识符**，于是 `11-7a3b64a` **大于** `12`，
 * 合成版本会永久压住上游未来的真版本，索引里永远选中旧的那条。
 *
 * @param version - 上游 `package.json` 里的版本。
 * @param commit - 完整 40 位 commit；只取前 7 位写进版本号（完整值仍在 `source.commit` 里）。
 * @param style - `'prerelease'`（默认）或 `'build'`。
 * @returns 合成后的版本字符串；上游自带 build metadata 时追加而不是覆盖。
 */
export function syntheticVersion(version, commit, style = 'prerelease') {
  if (style !== 'prerelease' && style !== 'build') {
    throw new Error(`未知的合成版本形态：${style}（应为 prerelease 或 build）`)
  }
  const at = version.indexOf('+')
  const base = at === -1 ? version : version.slice(0, at)
  const existing = at === -1 ? '' : version.slice(at + 1)
  const short = commit.slice(0, 7)
  if (style === 'build') {
    const tag = `commit.${short}`
    return `${base}+${existing === '' ? tag : `${existing}.${tag}`}`
  }
  // 点号形态：上游自带 build metadata 时把 `+` 换成 `.`，避免把 `+` 放进 prerelease 段。
  return existing === '' ? `${base}.commit.${short}` : `${base}.${existing}.commit.${short}`
}

/**
 * 从既有 `versions[]` 里认出**当前正在用哪种合成形态**，以及它挂在哪个版本核心上。
 *
 * 用途：让 `--commit-version` 变成「粘性」的。定时 CI 只跑不带开关的
 * `node scripts/update-index.mjs`，如果不做识别，它会把上游原始版本号写回去，
 * 把手工打开的合成形态冲掉、索引里又会多出一条同版本号的普通条目。
 * 认出形态后，不带开关的运行也会沿用，人工只需开一次。
 *
 * **只认版本最高的那一条**（`base` 随之返回，便于日志说明「挂在哪个版本核心上」）：
 * 模式是「索引现状」的声明，最新条目长什么样就是什么模式。历史条目里残留的合成后缀
 * **没有投票权** —— 否则 `--commit-version never` 清掉当前那条之后，更旧的合成条目会立刻
 * 把模式粘回来，开关就再也关不掉了。
 *
 * **上游抬版本号也不退场**：这是调用方（`update-index.mjs`）的行为 —— 抬版本只是换了
 * 版本核心，合成形态照旧挂到新版本上（`0.2.0-rc.11.commit.aaa` → `0.2.1-rc.2.commit.bbb`）。
 * 代价是本机装出来的干净版本号与索引的合成版本永远不等，「有新版本」徽标不会自动消失；
 * 想回到干净版本号只能显式 `--commit-version never`。
 *
 * @param versions - 现有 `versions[]`。
 * @returns `{ style, base }`；最新条目不是合成版本（或数组为空）时返回 `false`。
 */
export function detectSyntheticStyle(versions) {
  let latest
  for (const version of versions) {
    if (typeof version?.version !== 'string') continue
    if (latest === undefined || compareSemver(version.version, latest) > 0) latest = version.version
  }
  if (latest === undefined) return false
  const dotted = /^(.+?)\.commit\.[0-9a-f]{4,40}$/u.exec(latest)
  if (dotted !== null) return { style: 'prerelease', base: dotted[1] }
  const built = /^(.+?)\+.*commit\.[0-9a-f]{4,40}$/u.exec(latest)
  if (built !== null) return { style: 'build', base: built[1] }
  return false
}

/**
 * 构造一个版本条目。
 *
 * @param entry - `version` / `publishTimestamp` / `commit` / `repoUrl` / `enginesDsh`。
 * @returns 可直接写进 `versions[]` 的对象。
 */
export function buildVersionEntry({ version, publishTimestamp, commit, repoUrl, enginesDsh }) {
  return {
    version,
    publishTimestamp,
    source: { type: 'git', url: repoUrl, commit },
    engines: { dsh: enginesDsh },
  }
}

/**
 * 把一个新条目并入既有 `versions[]`。
 *
 * 四种结局：
 * - `appended`：该 version 尚不存在 → 追加（「发现」页会显示「有新版本」）；
 * - `repinned`：该 version 已存在、且是**最新版本**，但 commit/时间戳变了 → 改写这一个条目；
 * - `replaced`：`--commit-version` 模式下，同一 commit 核心的旧合成版本被新 commit 顶掉；
 * - `kept` / `unchanged`：保持不动（同 version 且非最新版本的历史条目**不可变**）。
 *
 * @param existing - 现有 `versions[]`（可为空数组）。
 * @param entry - `buildVersionEntry()` 的产物。
 * @param options.repin - 是否允许同版本重定 commit，默认允许。
 * @param options.pruneBase - 是否清掉「同一版本核心、但 commit 已被顶替」的旧合成条目
 *   （`--commit-version` 模式用，避免索引无限增长）。
 * @returns `{ versions, action }`；`versions` 已按 SemVer 降序排列。
 */
export function mergeVersion(existing, entry, { repin = true, pruneBase = false } = {}) {
  let versions = existing.map((version) => structuredClone(version))

  // 合成版本模式下，同一版本核心只保留**目标那一条**：
  // 上游在 `0.2.0-rc.11` 上又推了代码时，旧的 `0.2.0-rc.11` 与
  // `0.2.0-rc.11.commit.aaaaaaa` 都会被 `0.2.0-rc.11.commit.bbbbbbb` 取代。
  // 判据是「版本核心相同、但版本字符串不同」——同一版本号留两条没有意义，
  // 而核心不同的历史版本（如未来的 `0.2.0-rc.12`）照旧保留。
  let replaced = false
  if (pruneBase) {
    const base = baseVersionOf(entry.version)
    const before = versions.length
    versions = versions.filter(
      (version) => baseVersionOf(version.version) !== base || version.version === entry.version,
    )
    replaced = versions.length !== before
  }

  const at = versions.findIndex((version) => version.version === entry.version)

  if (at === -1) {
    versions.push(structuredClone(entry))
    sortVersionsDescending(versions)
    return { versions, action: replaced ? 'replaced' : 'appended' }
  }

  const current = versions[at]
  const sameTarget =
    current.source?.commit === entry.source.commit &&
    current.publishTimestamp === entry.publishTimestamp
  if (sameTarget) return { versions, action: 'unchanged' }

  const latest = [...versions].sort((left, right) => compareSemver(right.version, left.version))[0]
  if (!repin || current.version !== latest?.version) return { versions, action: 'kept' }

  versions[at] = structuredClone(entry)
  sortVersionsDescending(versions)
  return { versions, action: 'repinned' }
}

/** 一个空索引（`format: 1`），保留本仓库既有的标题 / 描述 / 元数据声明。 */
export function emptyIndexDocument() {
  return {
    format: 1,
    title: structuredClone(TITLE),
    description: structuredClone(DESCRIPTION),
    metadata: structuredClone(METADATA),
    plugins: [],
  }
}

/** 读取现有索引；不存在则返回空索引。 */
export function loadIndexDocument(path) {
  if (!existsSync(path)) return emptyIndexDocument()
  const document = JSON.parse(readFileSync(path, 'utf8'))
  if (document.format !== 1) throw new Error(`${path} 不是 format 1 索引`)
  if (!Array.isArray(document.plugins)) throw new Error(`${path} 缺少 plugins 数组`)
  return document
}

/** 生成插件的展示块（标题 / 描述 / 图标 / 元数据），不含 `versions`。 */
function pluginBlock(manifest, repoUrl) {
  return {
    name: manifest.name,
    title: { en: 'Providers Hub (Jet Hub)', zh: 'Providers Hub（Jet Hub）' },
    description: {
      en: 'One hub for AI coding providers: account login, multi-account pools, silent credential refresh, credit claiming, and a local OpenAI-compatible gateway.',
      zh: '一站式 AI 编程渠道中枢：账号登录、多账号池、静默凭据续期、积分领取，以及本地 OpenAI 兼容网关。',
    },
    icon: `data:image/svg+xml;base64,${readFileSync(ICON_PATH).toString('base64')}`,
    author: 'iJetLi',
    homepage: repoUrl,
    repository: { url: repoUrl },
    metadata: {
      category: 'model',
      keywords: ['dsh-plugin', 'providers', 'oauth', 'gateway', 'credentials'],
      labels: ['verified', 'git'],
      sortKeys: { stars: 1 },
    },
  }
}

/**
 * 把某个插件的 `versions[]` 写回索引文档。
 *
 * 插件已存在时**只改 `versions`**，保留既有的展示字段（人工润色过的文案不会被流水线覆盖）；
 * `rebuild` 为真时才用内置模板整体重建该插件块。
 *
 * @param document - 现有索引文档（会被就地修改并返回）。
 * @param options - `manifest` / `versions` / `repoUrl` / `rebuild`。
 */
export function upsertPlugin(document, { manifest, versions, repoUrl, rebuild = false }) {
  const block = pluginBlock(manifest, repoUrl)
  const at = document.plugins.findIndex((plugin) => plugin.name === manifest.name)
  if (at === -1) {
    document.plugins.push({ ...block, versions })
  } else if (rebuild) {
    document.plugins[at] = { ...block, versions }
  } else {
    document.plugins[at].versions = versions
  }
  return document
}

/**
 * 用官方校验器校验（与「发现」页读索引时是同一份规则）。
 *
 * @param document - 待校验的索引文档。
 * @param options.require - 校验器缺失时是否报错；为假则跳过并返回 `'skipped'`。
 * @returns `'ok'` 或 `'skipped'`。
 */
export async function validateIndex(document, { require = false } = {}) {
  try {
    const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')
    parseMarketIndex(document, INDEX_URL)
    return 'ok'
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
      if (require) {
        throw new Error(
          '未安装 @deepseek-ai/dsh-plugin-market-index，无法校验：先执行 npm install',
        )
      }
      return 'skipped'
    }
    throw error
  }
}

/** 解析 `--flag value` 形式的参数。 */
export function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

/** 解析 `--flag` 形式的布尔开关。 */
export function flag(name) {
  return process.argv.includes(`--${name}`)
}
