# 索引自动同步（GitHub Actions）

把「上游插件仓库推进了」这件事自动化：GitHub 上的定时任务主动去读上游仓库，
发现新版本就更新 `plugin-market.json` 并提交回本仓库。

```
Gitee:  iJetLi/deepseek-harness-codearts   ← 安装来源（source.url 写它）
GitHub: iJetLi/dsh-providers-hub           ← 检测源（commit 与 Gitee 完全一致）

        （检测）──▶ GitHub: gitMFQ/dsh-plugin-index
                            plugin-market.json
                                   │
                     DSH「发现」页 / plugin_market 工具读取
```

## 为什么是「拉」而不是「推」

上游在 Gitee、索引在 GitHub。让 GitHub 托管 runner 主动去读上游，不需要在上游仓库放任何
凭据，也不用维护 webhook；反过来（Gitee Go 推到 GitHub）要额外保管一个 GitHub token。

## 检测源与安装来源分开（`--detect-repo`）

上游主仓库在 Gitee，另有一个**内容完全一致**的 GitHub 镜像 `iJetLi/dsh-providers-hub`。
两者是同一份代码，同一批 commit（同 40 位 SHA），所以可以：

- **从 GitHub 镜像「检测」**最新版本 —— GitHub OpenAPI 更稳、更快；
- **仍按 Gitee 写「安装来源」** —— 索引里每个版本的 `source.url` 不变，
  历史条目一个字都不用改，国内用户也不会被迫走 GitHub clone。

```sh
node scripts/update-index.mjs \
  --repo        https://gitee.com/iJetLi/deepseek-harness-codearts \
  --detect-repo https://github.com/iJetLi/dsh-providers-hub
```

`sync-plugin-index.yml` 已按这个组合作为默认值，**定时任务无需额外配置**。
只想换检测源、不改安装来源时，手动触发填 `detect_repo` 即可；两个输入都留空则用默认。

⚠️ **两个地址必须指向同一份代码。** 镜像落后会让索引钉到旧 commit 上
（版本号可能还是新的，但 `source.commit` 指向旧代码）。镜像是否最新由**镜像仓库自己**
的 workflow 保证；本仓库只负责读。怀疑不一致时对一下两边的 `master`：

```sh
git ls-remote https://gitee.com/iJetLi/deepseek-harness-codearts refs/heads/master
git ls-remote https://github.com/iJetLi/dsh-providers-hub     refs/heads/master
```

## 探针结论（实测，2026-10-16 / 2026-10-18）

**GitHub 托管 runner 可以直连 Gitee**，四种方式全部实测通过（2026-10-16）：

| 方式 | 结果 |
|---|---|
| `GET gitee.com/api/v5/repos/{owner}/{repo}/commits?per_page=1` | 200，约 2.1 s |
| `GET .../contents/package.json?ref={sha}`（返回 base64） | 200，约 2.1 s |
| `GET gitee.com/{owner}/{repo}/raw/master/package.json` | 200，但**有 1 次 302**（跳到 `raw.giteeusercontent.com`） |
| `git ls-remote https://gitee.com/...` | 成功，约 1.7 s |

**GitHub 镜像的 OpenAPI**（2026-10-18 实测）：`commits?per_page=1` 与
`contents/package.json?ref={sha}` 各约 1–2 s，路径与 Gitee 完全对称，
因此两个平台共用 `scripts/lib/remote.mjs` 里的同一段实现。

⚠️ **国内网络可能连不上 `api.github.com`**（实测 `connect ECONNREFUSED 140.82.112.5:443`），
而 `github.com` 的 git 协议仍可用。所以脚本的读取顺序是：

```
GitHub/Gitee API  →  失败则 git clone --depth 1  →  仍失败且配了 fallbackUrl 则改用另一源
```

三级兜底已逐条实测（404 镜像、DNS 不可达、正常路径）。GitHub runner 上通常停在第一级。

两点必须记住：

1. **raw 地址是 302**。DSH 读索引时用 `redirect: "error"`，所以带跳转的地址**不能**当索引源
   （索引源必须是本仓库的 GitHub raw / jsDelivr 直链，见 README）。但在 CI 里用 `curl -L`
   读上游 `package.json` 是没问题的 —— 这里不受 DSH 的 `redirect: "error"` 约束。
2. **优先走 OpenAPI**：一次 `commits` + 一次 `contents` 就能拿到 sha、committer 日期和
   指定 commit 的 `package.json`，不需要 clone（clone `--depth 1` 实测约 10 s / 25 MB）。
   脚本里仍保留了 `git clone` 兜底。

## 工作流

### `.github/workflows/sync-plugin-index.yml`

- **触发**：`schedule` 每 10 分钟一次（`3,13,23,33,43,53 * * * *`，**UTC**；**故意错开整点对齐**，原因见「已知限制」），
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

> 打开下面的 `--commit-version`（把 commit 编进版本号）后，上表两行的版本号都会带
> `.commit.xxxxxxx` 后缀，抬版本号那行也不例外（`0.2.1-rc.2.commit.e14729c`）。

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

**粘性（开一次就一直生效，抬版本号也带）**：开关是「粘性」的 —— 索引里已经在用合成形态时，
不带 `--commit-version` 的定时任务会**一直沿用**它（人工只需开一次，CI 不会冲掉）。
判据只看**索引里版本最高的那一条**：最新条目长什么样，就是什么模式。
**上游抬版本号也不退场** —— 抬版本只是换了版本核心，后缀跟着挂到新版本上：

```
0.2.0-rc.11.commit.15f2a79   上游发布 0.2.1-rc.2   →   0.2.1-rc.2.commit.e14729c
```

所以「索引里每个版本都带 commit」是**一次开启、长期有效**的状态：

```sh
npm run sync:commit-version        # 开（等价于手动触发时选 prerelease / build）
node scripts/update-index.mjs --commit-version never   # 关：显式退回干净版本号
```

关掉后最新那条变成干净版本号，后续定时任务**不会**再把它粘回来
（更旧条目里残留的合成后缀不作数）。

代价：本机 `package.json` 里的版本是干净的 `0.2.1-rc.2`，与索引的 `0.2.1-rc.2.commit.xxx`
永远不等，所以装完后「有新版本」提示**不会自动消失**（徽标常亮）。装一次即可，无害。
**抬版本号也治不好它** —— 新版本照样带后缀；想要干净的更新提示只能 `never` 关掉合成模式。

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

## 事件驱动唤醒（`repository_dispatch`）

`schedule` 会被限流（实测间隔 1.8h / 3.7h / 5h），单靠 cron 追不上上游。因此索引
额外接受一个 **`wake-index`** 事件：

```
gitMFQ/dsh-providers-hub（镜像的 fork，只当哨兵）
        │  每 10 分钟比对「上游 HEAD」与「索引已收录的 commit」
        │  不一致 → POST /repos/gitMFQ/dsh-plugin-index/dispatches
        ▼
gitMFQ/dsh-plugin-index  sync-plugin-index（event: repository_dispatch）
        │  走与定时任务完全相同的 job 与默认参数
        ▼
plugin-market.json 更新并提交
```

要点：

- **cron 保留为兜底**。两条路径互不依赖：dispatch 丢了还有 schedule，schedule 被限流还有 dispatch。
- **哨兵不承载内容**。fork 里存的是 workflow 文件，所以它**永远**比上游多一个 commit，
  不能用来「快进同步上游」；检测源仍是上游镜像 `iJetLi/dsh-providers-hub`。
- **判据必须用 contents API，不能用 raw**。实测索引仓库 push 后，
  `raw.githubusercontent.com` 仍返回旧内容（约 1–2 分钟缓存），会把「已落后」误判成
  「已最新」而漏掉唤醒。哨兵用 `contents?ref=master` + `Cache-Control: no-cache`。
- **取不到索引内容时按「需要唤醒」处理**：多跑一次幂等同步，代价远小于漏更新。

### 凭据

哨兵需要 `INDEX_WAKE_TOKEN`（fork 仓库的 secret）：一个对 `gitMFQ/dsh-plugin-index`
有写权限的 PAT。未配置时工作流**不失败**，只给 warning 并跳过唤醒。

### 手动补一次

```sh
gh workflow run wake-index.yml -R gitMFQ/dsh-providers-hub --ref master
# 或直接叫醒索引（跳过哨兵的比对）
gh workflow run sync-plugin-index.yml -R gitMFQ/dsh-plugin-index --ref master
```

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
| `--repo <url>` | **安装来源**仓库（写进索引的 `source.url`）；支持 `https://gitee.com/<owner>/<repo>` 与 `https://github.com/<owner>/<repo>` |
| `--detect-repo <url>` | **检测源**仓库（读最新 commit）；默认与 `--repo` 相同。指向 commit 一致的镜像即可只换检测通道 |
| `--out <path>` | 输出索引路径，默认 `plugin-market.json` |
| `--no-repin` | 同版本不重定 commit |
| `--commit-version [prerelease\|build\|never]` | 把 commit 编进版本号，让「只改代码没抬版本号」也能点升级；不写形态时用 `prerelease`。开一次即长期有效（抬版本号也带），`never` 显式关闭 |
| `--engines <range>` | 显式指定 `engines.dsh`，覆盖自动推导 |
| `--dry-run` | 只报告，不写文件 |
| `--check` | 有变化则退出码 1 |
| `--require-validator` | 校验器缺失时报错（CI 用，避免「跳过校验」被当成通过） |

## 手动发布（备选路径）

在**插件仓库**里（有完整 Git 历史）跑 `scripts/generate-index.mjs`，它读本地 `HEAD`
而不是远端 —— 适合你在插件仓库本地改完想立刻发布、不想等定时任务的情况。
两个脚本共用 `scripts/lib/index-rules.mjs`，所以交替使用不会互相打架。

## 已知限制

- **只认 Gitee / GitHub 两个站点**：`--repo` / `--detect-repo` 目前只接受
  `https://gitee.com/...` 与 `https://github.com/...`。其它站点会直接报错退出
  （索引的 `source.url` 本来就只允许这两种形态，早报错好过跑完一轮才校验失败）。
  上游若迁到别处，改 `scripts/lib/remote.mjs` 的 `parseRepoUrl` 即可，规则文件不用动。
- **镜像与主仓库的一致性不由本仓库保证**：本索引只负责「读」，不做两边 commit 比对
  （那要多打一次 API）。镜像落后会表现为索引的 `source.commit` 停在旧值，
  日志里能直接看到读到的 commit，对一下 `git ls-remote` 即可确认。
- **cron 不精确，且可能被丢弃**：官方文档（[\`schedule\` 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)）明确：
  > The `schedule` event can be delayed during periods of high loads … High load times include
  > the start of every hour. If the load is sufficiently high enough, **some queued jobs may be dropped**.
  > To decrease the chance of delay, schedule your workflow to run at a different time of the hour.

  所以：① 定时任务可能延迟甚至被丢弃；② **不要**用 `*/10`（精确落在 :00/:10/:20… 这些最拥挤的槽位），
  本仓库用 `3,13,23,33,43,53 * * * *` 错开整点；③ 仓库 60 天无活动会自动停用定时任务
  （本仓库由 CI 自己提交，一般不会闲置到 60 天）。GitHub 的 schedule 最小间隔是 5 分钟。
  **缓解**：`repository_dispatch` 事件驱动（见上），不依赖 cron 的运气。
- **10 分钟一次的代价**：
  - 运行分钟**不花钱**：公共仓库用标准 GitHub 托管 runner 是免费额度外的（
    见 [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)）。
  - API 调用量上来了：每次 run 打两次检测源 OpenAPI（`commits` + `contents`），
    10 分钟一次约 **288 次/天**。未认证调用可能被限流（GitHub 未认证限额约 60 次/小时，
    288 次/天 ≈ 12 次/小时，余量充足；Gitee 侧同理），脚本已有 3 次退避重试 +
    `git clone` 兜底 + 换源兜底，但限流严重时同步会变慢。真被限流可把 cron 放宽（如 `8,38 * * * *`）。
  - 绝大多数 run 都是「无变化、直接结束」，不产生空提交。
- **`publishTimestamp` 取的是 commit 的 committer 时间**，不是「发布版本的时间」。
  上游 rebase / amend 会让它变化，于是 repin 判定会把该版本视作「目标变了」而重写最新条目
  —— 行为安全（只影响最新版本），但会让索引出现一次无意义改动。
- **索引条目 ≠ 安全审计**：只声明「从哪里、以哪个 commit 安装」。安装前请在 DSH 的确认框里
  核对来源与 commit。
