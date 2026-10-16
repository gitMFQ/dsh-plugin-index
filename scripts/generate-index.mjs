#!/usr/bin/env node
/**
 * 生成 DSH「自定义插件市场」索引（format 1）。
 *
 * 用法（在**插件仓库**根目录执行，而不是在索引仓库里）：
 *   node /path/to/dsh-market-index/scripts/generate-index.mjs --out /path/to/dsh-market-index/plugin-market.json
 *
 * 设计要点：
 * - 只收录**当前 HEAD 这一个版本**，来源固定到**完整 40 位 commit**：
 *   索引一旦发布就不可变，插件仓库推进后重跑本脚本即可追加新版本。
 * - `engines.dsh` 必须显式写死。DSH 的兼容性判据是
 *   「有 `engines.dsh` 就只认它，没有才回落到 `@deepseek-ai/dsh*` peer」，
 *   而 peer 里混着 `@deepseek-ai/cordis` / `schemastery` 这类**非 DSH 版本号**的
 *   peer，直接照抄 peer 会算出「不兼容」。这里取 `@deepseek-ai/dsh-*` peer 的并集，
 *   版本号相同时取更宽的那个范围。
 * - 校验用官方包 `@deepseek-ai/dsh-plugin-market-index`，有则校验、无则跳过并提示。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PLUGIN_ROOT = process.cwd()

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

function git(...args) {
  return execFileSync('git', args, { cwd: PLUGIN_ROOT, encoding: 'utf8' }).trim()
}

/**
 * 从 `@deepseek-ai/dsh*` peer 里推导 `engines.dsh`。
 *
 * **必须枚举并集，不能合并成 `^0.1.2-rc.1` 这类简写**（本仓库 `docs/agent-notes/misc.md`
 * 的既有规则）：合并会顺带放行同主版本下**从未验证过**的版本，而 `engines.dsh`
 * 是索引里唯一决定「发现」页显不显示安装按钮的判据 —— 宁可窄，不可宽。
 */
function dshRangeFromPeers(peers) {
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

const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const commit = git('rev-parse', 'HEAD')
const publishTimestamp = Number(git('show', '-s', '--format=%ct', 'HEAD'))

if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`HEAD 不是完整 commit：${commit}`)
if (!Number.isInteger(publishTimestamp)) throw new Error('取不到 commit 时间戳')

const enginesDsh = arg('engines', '') || dshRangeFromPeers(manifest.peerDependencies)
if (enginesDsh === '') throw new Error('推导不出 engines.dsh，请用 --engines 显式指定')

const repoUrl = arg('repo', 'https://gitee.com/iJetLi/deepseek-harness-codearts')
const iconFile = resolve(dirname(new URL(import.meta.url).pathname), '..', 'assets', 'icon.svg')

const index = {
  format: 1,
  title: { en: 'Jet Hub Plugins', zh: 'Jet Hub 插件源' },
  description: {
    en: 'Plugins maintained in the deepseek-harness-codearts repository. Git sources are pinned to full commits.',
    zh: 'deepseek-harness-codearts 仓库维护的插件。Git 来源固定到完整 commit。',
  },
  metadata: {
    categories: { model: { title: { en: 'Models & Providers', zh: '模型与账号接入' } } },
    labels: {
      verified: { title: { en: 'Verified on this machine', zh: '本机实测通过' } },
      git: { title: { en: 'Install from Git', zh: '从 Git 安装' } },
    },
    sortKeys: { stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' } },
  },
  plugins: [
    {
      name: manifest.name,
      title: { en: 'Providers Hub (Jet Hub)', zh: 'Providers Hub（Jet Hub）' },
      description: {
        en: 'One hub for AI coding providers: account login, multi-account pools, silent credential refresh, credit claiming, and a local OpenAI-compatible gateway.',
        zh: '一站式 AI 编程渠道中枢：账号登录、多账号池、静默凭据续期、积分领取，以及本地 OpenAI 兼容网关。',
      },
      icon: `data:image/svg+xml;base64,${readFileSync(iconFile).toString('base64')}`,
      author: 'iJetLi',
      homepage: repoUrl,
      repository: { url: repoUrl },
      metadata: {
        category: 'model',
        keywords: ['dsh-plugin', 'providers', 'oauth', 'gateway', 'credentials'],
        labels: ['verified', 'git'],
        sortKeys: { stars: 1 },
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp,
          source: { type: 'git', url: repoUrl, commit },
          engines: { dsh: enginesDsh },
        },
      ],
    },
  ],
}

const out = resolve(arg('out', join(PLUGIN_ROOT, 'plugin-market.json')))
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`已写入 ${out}`)
console.log(`  ${manifest.name}@${manifest.version}  commit ${commit}`)
console.log(`  engines.dsh = ${enginesDsh}`)

// 官方校验器可用时顺手校验一遍：它和「发现」页读索引时用的是同一份规则。
try {
  const require = createRequire(join(PLUGIN_ROOT, 'noop.js'))
  const { parseMarketIndex } = await import(
    require.resolve('@deepseek-ai/dsh-plugin-market-index')
  )
  parseMarketIndex(index, 'https://example.invalid/plugin-market.json')
  console.log('  校验通过（format 1）')
} catch (error) {
  if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('  （未安装 @deepseek-ai/dsh-plugin-market-index，跳过校验）')
  } else {
    throw error
  }
}
