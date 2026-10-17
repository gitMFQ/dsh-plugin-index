# 索引自动同步（GitHub Actions）

把「上游插件仓库推进了」这件事自动化：GitHub 上的定时任务主动去读 **Gitee** 上的上游仓库，
发现新版本就更新 `plugin-market.json` 并提交回本仓库。

```
Gitee: iJetLi/deepseek-harness-codearts        GitHub: gitMFQ/dsh-plugin-index
        （上游插件，只读）          ──拉──▶          plugin-market.json
                                                        │
                              DSH「发现」页 / plugin_market 工具读取
```

## 为什么是「拉」而不是「推」

上游在 Gitee、索引在 GitHub。让 GitHub 托管 runner 主动去读 Gitee，不需要在上游仓库放任何
凭据，也不用维护 webhook；反过来（Gitee Go 推到 GitHub）要额外保管一个 GitHub token。

## 探针结论（实测，2026-10-16）

GitHub 托管 runner（`ubuntu-latest`）**可以直连 Gitee**，四种方式全部实测通过：

| 方式 | 结果 |
|---|---|
| `GET gitee.com/api/v5/repos/{owner}/{repo}/commits?per_page=1` | 200，约 2.1 s |
| `GET .../contents/package.json?ref={sha}`（返回 base64） | 200，约 2.1 s |
| `GET gitee.com/{owner}/{repo}/raw/master/package.json` | 200，但**有 1 次 302**（跳到 `raw.giteeusercontent.com`） |
| `git ls-remote https://gitee.com/...` | 成功，约 1.7 s |

两点必须记住：

1. **raw 地址是 302**。DSH 读索引时用 `redirect: "error"`，所以带跳转的地址**不能**当索引源
   （索引源必须是本仓库的 GitHub raw / jsDelivr 直链，见 README）。但在 CI 里用 `curl -L`
   读上游 `package.json` 是没问题的 —— 这里不受 DSH 的 `redirect: "error"` 约束。
2. **优先走 OpenAPI**：一次 `commits` + 一次 `contents` 就能拿到 sha、committer 日期和
   指定 commit 的 `package.json`，不需要 clone（clone `--depth 1` 实测约 10 s / 25 MB）。
   脚本里仍保留了 `git clone` 兜底。

## 工作流

### `.github/workflows/sync-plugin-index.yml`

- **触发**：`schedule` 每 6 小时一次（`17 */6 * * *`，**UTC**；GitHub 高峰期会排队，可能延迟几分钟到几十分钟），
  外加 `workflow_dispatch` 手动触发（可临时换上游仓库、可关掉「同版本重定 commit」）。
- **权限**：`permissions: contents: write` —— 默认 token 是只读，必须显式提权。
- **并发**：`concurrency: sync-plugin-index`，避免两个 run 抢着 push。
- **行为**：跑 `scripts/update-index.mjs` → 复核 → 有变化才 `git commit` + `git push`；
  无变化直接结束（不会产生空提交）。

### `.github/workflows/validate-index.yml`

`plugin-market.json` / `scripts/**` 一旦被改（push 或 PR）就用**官方校验器**跑一遍。
值得单独跑的原因：DSH「发现」页对非法索引只显示一条「读取失败」，不告诉你哪一行错了，
本地/CI 先卡住能省很多排查时间。

## 关键语义：什么时候用户才会看到「有新版本」

**DSH 的更新判据是 SemVer 比较，不是 commit 比较。** 看 `dsh-plugin-market` 的实现：

```js
status: semver.valid(installedVersion) !== null && semver.gt(version, installedVersion)
  ? "update-available" : "different-version"
```

`installedVersion` 取自本机已安装包的 `package.json.version`。于是：

| 上游动作 | 索引动作 | 用户看到 |
|---|---|---|
| 抬了版本号（`rc.11` → `rc.12`） | **追加**一条新版本 | ✅「有新版本」，点「安装」即升到新 commit |
| 只改代码、没抬版本号 | **重定 commit**（改写最新那条） | ❌ 仍显示「已安装」（版本号没变）；但**新安装**的用户会拿到新 commit 的代码 |

所以默认情况下：**想让老用户拿到更新，上游必须抬版本号。** 索引这一侧能做的只是
「版本号一动就自动收录」+「版本号没动时保证新装用户拿到最新代码（repin）」。

### 不抬版本号也想能点升级：`--commit-version`

DSH 判断有没有新版本**只比 SemVer 字符串，从不看 commit**：

- 卡片徽标「有新版本」= `semver.gt(索引版本, 已安装版本)`
- 版本行「安装」按钮 = `installedVersion !== version.version`（**字符串**比较）

于是上游只改代码时，本机 `0.2.0-rc.11` 与索引 `0.2.0-rc.11` 完全相等，按钮不出现。
`--commit-version` 把 commit 编进版本号，制造出一个「既大于当前版本、又小于未来真版本」的字符串：

| 形态 | 写法 | 徽标 | 按钮 | 会不会压住未来的 `rc.12` |
|---|---|---|---|---|
| `prerelease`（默认） | `0.2.0-rc.11.commit.15f2a79` | ✅「有新版本」 | ✅ 出现 | ✅ 不会（第 2 段 `11` < `12`） |
| `build` | `0.2.0-rc.11+commit.15f2a79` | ⚠️ 只显示「已安装」 | ✅ 出现 | ✅ 不会（build metadata 不参与比较） |

**绝对不要**写成连字符形态 `0.2.0-rc.11-15f2a79`：prerelease 会被切成 `["rc","11-15f2a79"]`，
而 SemVer 规定**纯数字标识符优先级低于含字母标识符**，`11-15f2a79` **大于** `12` ——
合成版本会永久压住上游未来的真版本，索引里永远选中旧的那条。代码里已按点号形态实现。

同一版本核心只保留一条（`pruneBase`）：上游在同一版本号上又推了代码时，
旧的 `0.2.0-rc.11` 与 `0.2.0-rc.11.commit.aaaaaaa` 都会被新 commit 取代，索引不会无限膨胀。

代价：本机 `package.json` 里的版本仍是 `0.2.0-rc.11`，与索引的 `0.2.0-rc.11.commit.xxx`
永远不等，所以装完后「有新版本」提示**不会自动消失**。装一次即可，无害。
想要干净的更新提示，仍应让上游抬版本号。

### repin 的边界

- **只重定最新版本那一条**；历史版本条目永不改写 —— 索引一旦发布就不该被悄悄改变。
- 想彻底关掉：`workflow_dispatch` 勾选 `no_repin`，或本地加 `--no-repin`。
- 不想让 CI 碰「人工润色过的文案」？插件已存在时**只改 `versions[]`**，
  标题/描述/图标/关键词都保留；只有 `--rebuild` 才整体重建。

### 安装按钮的另一半：`engines.dsh`

「发现」页显示安装按钮还要过**兼容性**这一关：索引条目里写了 `engines.dsh` 就只认它，
没写才回落到 `@deepseek-ai/dsh*` peer。上游 peer 里混着 `@deepseek-ai/cordis`、
`schemastery` 这类**与 DSH 版本号无关**的 peer，照抄会算出「不兼容」、按钮变灰。

因此脚本按**枚举并集**推导，例如：

```
^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1
```

**不要**简化成 `^0.1.2-rc.1`：那会顺带放行同主版本下从未验证过的版本。宁可窄，不可宽。
上游哪天新增了 `@deepseek-ai/dsh-xxx` peer，重跑一次脚本就会自动把新范围并进来。

## 本地怎么跑

```sh
npm install                       # 只装官方校验器
npm run sync:dry                  # 只看结果，不写文件
npm run sync                      # 写 plugin-market.json
npm run validate                  # 只校验现有索引
node scripts/update-index.mjs --check   # 有变化则退出码 1（给 CI / 脚本做门禁）
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--repo <url>` | 换上游仓库（只支持 `https://gitee.com/<owner>/<repo>`） |
| `--out <path>` | 输出索引路径，默认 `plugin-market.json` |
| `--no-repin` | 同版本不重定 commit |
| `--commit-version [prerelease\|build]` | 把 commit 编进版本号，让「只改代码没抬版本号」也能点升级；不写形态时用 `prerelease` |
| `--engines <range>` | 显式指定 `engines.dsh`，覆盖自动推导 |
| `--dry-run` | 只报告，不写文件 |
| `--check` | 有变化则退出码 1 |
| `--require-validator` | 校验器缺失时报错（CI 用，避免「跳过校验」被当成通过） |

## 手动发布（备选路径）

在**插件仓库**里（有完整 Git 历史）跑 `scripts/generate-index.mjs`，它读本地 `HEAD`
而不是远端 —— 适合你在插件仓库本地改完想立刻发布、不想等定时任务的情况。
两个脚本共用 `scripts/lib/index-rules.mjs`，所以交替使用不会互相打架。

## 已知限制

- **只有 Gitee 上游**：`--repo` 目前只认 `gitee.com` 形式。上游若迁到 GitHub，
  换成 `gh api` / 直接 `git ls-remote` 即可，规则文件不用动。
- **cron 不精确**：GitHub 的 `schedule` 在高峰期会延迟，且仓库 60 天无活动会自动停用定时任务
  （本仓库由 CI 自己提交，一般不会闲置到 60 天）。
- **`publishTimestamp` 取的是 commit 的 committer 时间**，不是「发布版本的时间」。
  上游 rebase / amend 会让它变化，于是 repin 判定会把该版本视作「目标变了」而重写最新条目
  —— 行为安全（只影响最新版本），但会让索引出现一次无意义改动。
- **索引条目 ≠ 安全审计**：只声明「从哪里、以哪个 commit 安装」。安装前请在 DSH 的确认框里
  核对来源与 commit。
