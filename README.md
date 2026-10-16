# dsh-plugin-index

DSH（DeepSeek Harness）**自定义插件市场索引**（`format: 1`）。

在 **插件 → 实验性插件 → 更多** 里打开「自定义插件市场」，再到 **发现 → 添加索引源**，
填入下面的地址即可看到本索引收录的插件。

## 索引源地址

```
https://raw.githubusercontent.com/gitMFQ/dsh-plugin-index/master/plugin-market.json
```

国内网络直连 `raw.githubusercontent.com` 不稳定时，可改用 jsDelivr 镜像（内容相同）：

```
https://cdn.jsdelivr.net/gh/gitMFQ/dsh-plugin-index@master/plugin-market.json
```

> ⚠️ **不要用带跳转的地址。** DSH 读取索引时用的是 `redirect: "error"`，
> 遇到 302 直接判为失败，「发现」页只显示一条读取失败、不告诉你原因。
> 实测：上面两个地址都是 **200 + 零跳转**；而 Gitee 的
> `https://gitee.com/<owner>/<repo>/raw/<branch>/<file>` 是 **302**，**不能**用作索引源
> （必须换成它 302 指向的 `raw.giteeusercontent.com` 直链）。
> `cdn.jsdelivr.net/gh/...@<branch>/...` 在浏览器里会 301 到带版本号的地址，
> 但索引是**宿主进程**用 `fetch` 读的，实测直连 200、零跳转。

## 收录内容

| 插件 | 版本 | 来源 |
|---|---|---|
| `dsh-providers-hub` | 见 `plugin-market.json` | 固定到完整 commit 的 Git 来源 |

来源是 `https://gitee.com/iJetLi/deepseek-harness-codearts`，每个版本都锁定到
**完整 40 位 commit**，不是浮动分支 —— 索引一旦发布就不会被上游推进悄悄改变。

## 索引格式要点

DSH 的索引是一个 JSON 文件，`format: 1`，顶层字段：

| 字段 | 说明 |
|---|---|
| `format` | 固定为 `1` |
| `title` | 索引标题，**必须含 `en`**，可另加 `zh` 等语言 |
| `description` | 可选，同上 |
| `metadata` | `categories` / `labels` / `sortKeys` 三组声明；插件里引用未声明的 id 会被判非法 |
| `plugins[]` | 插件数组，每个含 `name`（npm 包名）、`versions[]` 等 |

每个版本必须写清：

| 字段 | 说明 |
|---|---|
| `version` | 精确 SemVer |
| `publishTimestamp` | Unix **秒**（整数） |
| `source` | `{"type":"npm","registry"?:…}` 或 `{"type":"git","url":…,"commit":<40位小写SHA>,"path"?:…}` |
| `engines.dsh` | DSH 版本范围；**写了它就只认它**，不写才回落到 `@deepseek-ai/dsh*` peer |

⚠️ `engines.dsh` 有两条容易踩的坑：

1. **不写会按 peer 判定**，而 peer 里通常混着 `@deepseek-ai/cordis`、`schemastery`
   这类**版本号与 DSH 无关**的 peer，照抄 peer 会算出「不兼容」，安装按钮变灰。
2. **写成 `^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1` 这种简写会放行没验证过的版本**。
   本项目按「枚举并集」写死，宁可窄不可宽。

## 维护

索引由脚本生成，**不要手改**。有两条路径，共用同一份构建规则
（`scripts/lib/index-rules.mjs`），可以交替使用、结果互相叠加：

### 自动（推荐）：GitHub Actions 定时同步

`.github/workflows/sync-plugin-index.yml` 每 6 小时主动去读上游 Gitee 仓库的最新 commit，
有新版本就更新索引并提交回本仓库。**不需要在上游放任何凭据。**

也可以在 **Actions → sync-plugin-index → Run workflow** 手动触发。

⚠️ 一个必须知道的语义：**DSH 判断「有没有新版本」用的是 SemVer 比较，不是 commit 比较**。
所以只有上游**真的抬了版本号**，已安装的用户才会看到「有新版本」；上游只改代码不抬版本号时，
脚本会**重定最新版本那条的 commit**，让**新安装**的用户拿到最新代码，但老用户不会看到更新提示。

详见 [docs/ci-sync.md](docs/ci-sync.md)。

### 手动：在插件仓库里生成

```sh
# 在插件仓库根目录执行（需要该仓库有完整 Git 历史）
node ../dsh-plugin-index/scripts/generate-index.mjs --out ../dsh-plugin-index/plugin-market.json
```

脚本会读取插件仓库的 `package.json` 与 `HEAD`，把该 commit 并入索引并推导 `engines.dsh`。

### 常用命令（在索引仓库里）

```sh
npm install            # 只装官方校验器
npm run sync:dry       # 看会怎么改，不写文件
npm run sync           # 写 plugin-market.json
npm run validate       # 只校验现有索引
```

## 校验

生成后可用官方校验器验证（与「发现」页读索引时用的是同一份规则）：

```sh
npm i -D @deepseek-ai/dsh-plugin-market-index
node -e "
import('@deepseek-ai/dsh-plugin-market-index').then(async (m) => {
  const fs = await import('node:fs')
  const doc = JSON.parse(fs.readFileSync('plugin-market.json', 'utf8'))
  m.parseMarketIndex(doc, 'https://example.invalid/plugin-market.json')
  console.log('format 1 校验通过')
})
"
```

## 安全

- 索引条目 **≠ 安全认证**：本索引只声明「从哪里、以哪个 commit 安装」，
  不构成对插件代码的审计。安装前请在 DSH 的确认框里核对来源、commit 与目录。
- 索引里出现的 `icon` 是内联 `data:` SVG（本仓库原创），不会向第三方图床暴露你的 IP。
- 添加索引源属于**当前 profile**；删掉索引源或关掉实验性市场即可撤销接入。
