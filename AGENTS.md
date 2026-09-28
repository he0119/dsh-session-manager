# AGENTS.md

本仓库的协作约定，给 AI 助手与贡献者看。安装与用法在 [README](README.md)，实现与取舍的"为什么"在
[docs/internals.md](docs/internals.md)，目录结构与逐文件职责在 [docs/development.md](docs/development.md)。
文档、提交信息、给维护者的报告一律用中文（[README.en.md](README.en.md) 是与 README 对齐的英文版）。

## 文档分工

每条信息只写一处，别处放链接或一句话指过去：

| 文档 | 写什么 |
| --- | --- |
| `README.md` / `README.en.md` | 安装、设置页与四个工具怎么用；两份的键与结构保持对齐 |
| `AGENTS.md` | 本文件：协作约定、提交信息口径、验证清单、界面硬约束 |
| `docs/internals.md` | 为什么这么做：约束、踩过的坑、刻意的取舍 |
| `docs/development.md` | 目录结构、逐文件职责、开发命令 |
| `docs/releasing.md` | 发布流程（推 `v*` 标签触发可信发布） |

## 官方文档

上游口径以官方文档站为准（<https://deepseek-harness.github.io/deepseek-harness/>，中英双语）。与本包
关系最近的四页：

- [Web Client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client)：
  「包边界」规定功能插件包之间不得运行时互导值（跨包走 Cordis service 或 Slots），`ui-primitives`
  这类没有功能生命周期的静态 owner 可以共享；页面里两侧也叫「Host 侧 / Client 侧」「Host face /
  Client face」。
- [客户端模块](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)：
  客户端产物的经典脚本契约，以及 `dsh.client` 里 `inject`（工厂到达与组合顺序）与 `external`
  （非基线模块请求）的分工。
- [客户端 Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)：
  Slot / 注入 / 渲染的生命周期；本插件的设置页就是注册进 `settings.section` 的一个 Slot。
- [新增设置卡片](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)：
  设置页卡片怎么按命名空间配对两侧。官方中文把插件包的两侧叫 **Host 半侧** / **浏览器半侧**，
  英文文档里是 "Host half" / "browser half"，本仓库跟这个说法（不是"半边"，也不是"客户端侧"）。

术语跟着官方走，**代码、注释、界面文案与文档同一套**：注册表（不是「账本」）、项目目录（宿主
`projectDir(root, cwd)`，不是「桶 / 分桶」）、`Slot`（官方保留英文，不译「槽位」）、两侧叫半侧。
新写的东西别再用旧词，旧词只剩历史提交里有。

## 提交信息

**只写这个提交做了什么、为什么这么做、有什么取舍。** 明确不要写：

- 维护者/作者本人的使用面或口述（「我完全没机会用这个东西」这类）；
- 谁报的（「用户报的」「用户截图报的」）——把现象与量到的数字写出来就够了；
- 演化过程（「原本是…后来改成…」）——直接写最终形态。

其余口径：

- 中文 conventional commits：`feat / fix / docs / refactor / test / build / chore`；破坏性变更加
  `!`，并在正文单独写一段 **破坏性**（对外契约、装过旧版的人会遇到什么）。
- 正文手折行，每行 ≤ 100 字符；一段一件事；一次逻辑改动一个提交，连带改动的文档与测试并入同一提交。
- 数字只写实测值：测试条数（`tests / pass / fail / skipped`）、包内文件数、量出来的色值。
  机制细节可以引用文件与函数名，但不要复述 diff。

## 验证（提交前必须全绿）

```sh
pnpm typecheck && pnpm build && pnpm test && pnpm check:package
```

- **新断言要篡改验证**：把被测行为改回去，测试必须变红；报告里说明做了哪些篡改。
  `docs/internals.md` 里那句"反事实都验过会失败"就是这个意思。
- 界面与样式的改动要**在真实 dev GUI 里量**（`getComputedStyle` 的实测值），不要推算色值；
  深浅两套主题各量一遍再下结论。
- 真实会话库上的**写操作**（迁移 `apply`、回滚、导入落地）先问再做；验收优先用只读预演。
- 验收需要临时夹具（假会话等）时用完立刻删干净，并在报告里写明造过什么、清掉了没有。

## 界面与样式的硬约束

- 浏览器半侧只 `require` **平台基线模块**：`react`、`react/jsx-runtime`、官方控件库
  `@deepseek-ai/dsh-client-ui-primitives`——这三个在 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 里保持
  外置，其余内联。控件改用官方控件库（peer 与 devDep 已接线，手写控件逐步替换）；要引非基线模块
  必须在 `dsh.client.external` 里点名。基线模块的 API 变化由 `peerDependencies` 的版本范围拦在激活，
  不会静默走形；`Slot` 条目渲染抛错只会留下一个空 `div`，所以渲染路径上别做会抛的事。
- 颜色只用宿主 `Theme` 检查面列出的 `--dsw-alias-*`（`cordis_inspect_query` → client / Theme /
  listTokens），每条声明都带中性回落值；名单外的 token 要登记进 `test/styles.test.mjs` 的例外表
  并写明理由（现有两例：`label-primary-foreground`、`label-tertiary`）。
- 页头与页内分页**没有官方原语可用**（官方设置页自己手写 `h2` / `p` / 本地 CSS），照内建设置页的规格
  写：`h2` 18px/600 独占一行，隔 12px 一行 13px 说明（`label-tertiary`），整体列布局；规格由
  `test/styles.test.mjs` 与 `test/client.test.mjs` 两处钉住。
- `src/client/styles.ts` 的 CSS 正文里**不许出现反引号**（模板字面量会被提前截断，报错落在很远处）；
  类名一律 `dsm-` 前缀。
- 中英两份字典的键集必须一致（`test/client.test.mjs` 会核）。

## 代码结构

- 核心层（`src/*.ts`，除 `tools.ts` / `index.ts` / `web.ts` 与 `client/**`）**零 DSH 依赖**：
  插件外壳、工具层、界面端点与测试共用同一份编排（`src/migrate.ts`）。
- `src/client/**` 不在 Host 端 tsconfig 的 include 里（它要 DOM 与 JSX，走 `tsconfig.client.json`）。
- `lib/` 是构建产物，不入版本库；`src/`、`test/`、`docs/`、`scripts/`、`.github/` 不进 npm 包
  （`pnpm check:package` 会核，同时核"运行期文件一个都不少"与产物内部相对 import 有没有指到包外）。

## Git

- **main 走 PR**：服务端有一条 `default` ruleset——禁删除、禁强推、要求线性历史（merge commit 会被
  拒，只能 squash / rebase），并要求名为 `check` 的检查通过；没有 bypass，管理员也绕不过。所以改动
  一律「推分支 → 开 PR → squash 合并」，那个检查名就是 `.github/workflows/ci.yml` 里的 job id
  `check`（PR 会自动触发同一个工作流）。
- **PR 标题按约定式提交写**：`.github/workflows/autolabeler.yml` 按 PR 标题给 PR 打标签，Release
  日志的分组（`.github/release.yml`）只认标签，所以标题要是 `feat: …` / `fix: …` 这种形状。
- **不要自己 push**（含 `--force`）；改完把状态与下一步命令交给维护者，由他决定。
- 改写历史前先留一个备份 ref，并在报告里给出新旧 sha 的对应关系，以及"树有没有变化"的核对方式。
