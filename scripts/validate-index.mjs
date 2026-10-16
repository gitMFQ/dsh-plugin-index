#!/usr/bin/env node
/**
 * 只校验 `plugin-market.json`，不改任何文件。
 *
 * 用途：
 * - 本地改完索引先跑一遍；
 * - CI 的 `validate-index.yml` 在每次 push / PR 上跑，防止手改出非法索引
 *   （「发现」页对非法索引只显示一条读取失败，不告诉原因，所以这一步很值）。
 *
 * 用法：
 *   npm install && node scripts/validate-index.mjs [--out plugin-market.json]
 */
import { resolve } from 'node:path'

import { arg, loadIndexDocument, validateIndex } from './lib/index-rules.mjs'

const out = resolve(arg('out', 'plugin-market.json'))
const document = loadIndexDocument(out)

// require: 校验器缺失就报错 —— CI 里绝不能「跳过校验」当成通过。
const result = await validateIndex(document, { require: true })

const versions = document.plugins.reduce((total, plugin) => total + plugin.versions.length, 0)
console.log(`format 1 校验通过（${result}）：${out}`)
for (const plugin of document.plugins) {
  const latest = plugin.versions[0]
  console.log(
    `  ${plugin.name}  最新 ${latest.version}  commit ${latest.source.commit.slice(0, 12)}…  共 ${plugin.versions.length} 个版本`,
  )
}
console.log(`  合计 ${document.plugins.length} 个插件 / ${versions} 个版本`)
