#!/usr/bin/env node
/**
 * 生成 / 追加 DSH「自定义插件市场」索引条目（format 1）——**在插件仓库里执行**。
 *
 * 用法：
 *   node /path/to/dsh-plugin-index/scripts/generate-index.mjs --out /path/to/dsh-plugin-index/plugin-market.json
 *
 * 与 `update-index.mjs` 的分工：
 * - 本脚本：版本取自**本地 HEAD**，适合人工在插件仓库里发布后重跑。
 * - `update-index.mjs`：版本取自**远端最新 commit**，供 GitHub Actions 定时同步。
 *   两者共用 `scripts/lib/index-rules.mjs`，所以可以交替使用、结果互相叠加。
 *
 * 默认**并入**现有索引（同版本重定 commit 只作用于最新版本，历史版本不可变）；
 * 用 `--rebuild` 可整块重建该插件（丢弃历史版本与人工润色的展示文案）。
 *
 * 参数：
 *   --out <path>       输出索引路径（默认插件仓库下的 plugin-market.json）
 *   --repo <url>       上游仓库地址（默认 Gitee 上的 deepseek-harness-codearts）
 *   --engines <range>  显式指定 engines.dsh（默认从 peerDependencies 推导）
 *   --no-repin         同版本不重定 commit
 *   --rebuild          整体重建该插件的索引块
 *   --require-validator 校验器缺失时报错（CI 用）
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

const PLUGIN_ROOT = process.cwd()
const repoUrl = arg('repo', DEFAULT_REPO_URL)
const out = resolve(arg('out', `${PLUGIN_ROOT}/plugin-market.json`))

const { manifest, commit, publishTimestamp } = readCheckout(PLUGIN_ROOT)

const enginesDsh = arg('engines', '') || dshRangeFromPeers(manifest.peerDependencies)
if (enginesDsh === '') throw new Error('推导不出 engines.dsh，请用 --engines 显式指定')

const entry = buildVersionEntry({
  version: manifest.version,
  publishTimestamp,
  commit,
  repoUrl,
  enginesDsh,
})

const document = loadIndexDocument(out)
const plugin = document.plugins.find((candidate) => candidate.name === manifest.name)
const { versions, action } = mergeVersion(plugin?.versions ?? [], entry, {
  repin: !flag('no-repin'),
})
upsertPlugin(document, {
  manifest,
  versions,
  repoUrl,
  rebuild: flag('rebuild') || plugin === undefined,
})

await validateIndex(document, { require: flag('require-validator') })

writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
console.log(`已写入 ${out}`)
console.log(`  ${manifest.name}@${manifest.version}  commit ${commit}`)
console.log(`  engines.dsh = ${enginesDsh}`)
console.log(`  版本条目 ${action}，共 ${versions.length} 个版本`)
console.log('  校验通过（format 1）')
