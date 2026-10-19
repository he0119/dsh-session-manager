# AGENTS.md

本仓库的协作约定，给 AI 助手与贡献者看。安装与用法在 [README](README.md)，决策的依据与被否决的备选
方案在 [.agents/notes/](.agents/notes/AGENTS.md)，决策地图在 [docs/internals.md](docs/internals.md)，
界面与样式的完整规格在 [docs/design.md](docs/design.md)，目录结构与逐文件职责在
[docs/development.md](docs/development.md)。
文档、提交信息、给维护者的报告一律用中文（[README.en.md](README.en.md) 是与 README 对齐的英文版）。

## 文档分工

每条信息只写一处，别处放链接或一句话指过去：

| 文档 | 写什么 |
| --- | --- |
| `README.md` / `README.en.md` | 安装、设置页与四个工具怎么用；两份的键与结构保持对齐 |
| `AGENTS.md` | 本文件：协作约定、提交信息口径、验证清单、界面硬约束 |
| `.agents/notes/` | 决策的依据、被否决的备选方案与代价；一条决策一篇，格式由 `test/notes.test.ts` 核 |
| `.agents/skills/` | 给 agent 的可复用流程，一个技能一个目录（`SKILL.md` + 它自己的资源文件），由 DSH 的技能机制发现；不放决策依据 |
| `docs/AGENTS.md` | `docs/` 这一层的文档规范与写作规则 |
| `docs/design.md` | 界面与样式的唯一规格：页面骨架、排版、间距、颜色、控件、文案与验收 |
| `docs/internals.md` | 决策地图（按主题索引到笔记），以及没有笔记承载的当前机制 |
| `docs/development.md` | 目录结构、逐文件职责、开发命令 |
| `docs/releasing.md` | 发布流程（推 `v*` 标签触发可信发布） |

一次改动**引入了新的决策**（安全边界、默认值、对外契约、文件格式、修掉一个有现象可查的缺陷）时，与
代码同一个提交里写一篇笔记，判据见 [.agents/notes/AGENTS.md](.agents/notes/AGENTS.md)；已经有一篇
笔记持有该决策就更新它，不新建重复笔记。措辞调整与纯局部实现细节豁免。

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
`projectDir(root, cwd)`，不是「桶 / 分桶」）、`Slot`（官方保留英文，不译「槽位」）、两侧叫半侧、
子智能体（官方中文界面的叫法，不是「子代理」）。
同步的两个方向叫**拉取 / 推送**（不是「拉下来 / 推上去」，也不是单字「拉 / 推」）；会话的一轮叫
**轮次 / 第 N 轮**（官方客户端就是这么写的：`dsh-client-ui-trajectory` 的「轮次」「展开所有轮次」、
`dsh-client-ui-chat` 的「第 {turn} 轮」、`dsh-client-ui-conversation` 的 `detail.field.turn` 是
「轮次」；只有 `dsh-client-ui-workspace` 的归档确认里写了一次「进行中的回合」）。
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
- **标题一句话说完"改了什么"，不写解释性括号**。main 只走 squash，PR 标题就是 main 上那一句提交主题，
  所以标题得自己站得住；但"（补充说明）"会让它变成一句正文带注脚，读起来像脚注而不是说明。要补充的
  东西——现象、原因、量到的数字、代价——都进正文；确实需要第二个从句就用逗号或破折号接下去
  （`feat: 自动推送跟着轮次走，定时器退成兜底`）；塞不下说明这件事该**拆成两个 PR**，不是该往标题里
  再挤一句。约定式提交的 `type(scope):` 是语法的一部分（`chore(release): 0.6.0`），不在此列。

## 验证（提交前必须全绿）

```sh
pnpm typecheck && pnpm build && pnpm test && pnpm check:package
```

- **新断言要篡改验证**：把被测行为改回去，测试必须变红；报告里说明做了哪些篡改。
  [颜色只走检查面的 token](.agents/notes/implemented/bug-fix/2026-09-27-token-only-colors.md) 里那句
  "反事实都验过会失败"就是这个意思。
- `test/notes.test.ts` 只核**声明**：`.agents/notes/` 下的路径形状、头部三行、`Status:` 与所在目录是否
  一致、`## Problem` 是不是第一个二级标题、必备章节在不在、`implemented/` 里有没有混进提案用语、
  相对链接能不能解析。改笔记格式就同一次改动里改它。
- 界面与样式的改动要**在真实 dev GUI 里量**（`getComputedStyle` 的实测值），不要推算色值；
  深浅两套主题各量一遍再下结论。内容视图有一份现成的端到端自检
  （`bash .agents/skills/transcript-e2e/scripts/run.sh`，驱动真实 dev GUI、只读会话库），动过
  `TranscriptDialog.tsx` / `logic/transcript*` / `src/transcript.ts` 之后跑一遍它。
- 真实会话库上的**写操作**（迁移 `apply`、回滚、导入落地）先问再做；验收优先用只读预演。
- 验收需要临时夹具（假会话等）时用完立刻删干净，并在报告里写明造过什么、清掉了没有。

## 界面与样式的硬约束

完整规格（页面骨架、排版、间距、颜色、控件、文案、反馈、验收）在 [docs/design.md](docs/design.md)；
这里只列违反一次就会静默坏掉、且每轮都要在上下文里的门。

- 浏览器半侧只 `require` **平台基线模块**：`react`、`react/jsx-runtime`、官方控件库
  `@deepseek-ai/dsh-client-ui-primitives`——这三个在 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 里保持
  外置，其余内联。**控制件一律用官方控件库**，本页 CSS 只写布局挂钩、不画控件外观；要引非基线模块
  必须在 `dsh.client.external` 里点名。依据见
  [控制件用官方原语](.agents/notes/implemented/architecture/2026-10-15-controls-come-from-the-official-primitives.md)。
- 官方 `Tag` **不转发 `title`**：悬浮提示挂外层 `<span className="dsm-tag" title={…}>`，每枚标签都必须
  带上这个挂钩，否则 `flex: none`、限宽截断、行高对齐那几条会**静默失效**。
- 颜色只用宿主 Theme 检查面列出的 `--dsw-alias-*`，每条声明都带中性回落值；检查面没有的例外只登记在
  `test/styles.test.mjs`，别处不再列第二份。
- **布局：`gap` 只对直接拥有这些子元素的那一层生效。** 页内分页、弹窗正文都要各自包一层拿节奏；
  官方 `Modal` 的 `contentClassName` 落在**外层**，里面那层官方 body 没有 gap。完整的节奏表与归属规则见
  [design.md §4](docs/design.md#4-间距与布局归属)。
- **卡片级主动作放卡片底部动作行**；带勾选的清单全站只有一对「全选 / 清空」；行上的动作等悬停。
  结构与位置由 `test/client.test.mjs` 的 `primaryPlacements()` / `pickPlacements()` 钉住。
- `src/client/styles.ts` 的 CSS 正文里**不许出现反引号**（模板字面量会被提前截断，报错落在很远处）；
  类名一律 `dsm-` 前缀。
- 文案走官方客户端 locale 机制：`zh` 是键集真源，`en` 逐键核；组件从**框架 props** 拿 `t`，不自己
  `inject`，不留中文兜底；键名点分，通用词复用宿主 `common` 命名空间。
- 界面与样式改动要在**真实 dev GUI** 里量（`getComputedStyle` / `getBoundingClientRect`），深浅两套
  主题各看一遍；具体验收命令见 [design.md §9](docs/design.md#9-验收)。

## 代码结构

- 核心层（`src/*.ts`，除 `tools.ts` / `index.ts` / `web.ts` 与 `client/**`）**零 DSH 依赖**：
  插件外壳、工具层、界面端点与测试共用同一份编排（`src/migrate.ts`）。
- `src/client/**` 不在 Host 端 tsconfig 的 include 里（它要 DOM 与 JSX，走 `tsconfig.client.json`）。
- `lib/` 是构建产物，不入版本库；`src/`、`test/`、`docs/`、`scripts/`、`.github/` 不进 npm 包
  （`pnpm check:package` 会核，同时核"运行期文件一个都不少"与产物内部相对 import 有没有指到包外）。

## Git

- **main 走 PR**：服务端有一条 `default` ruleset——禁删除、禁强推、要求线性历史（`merge` 这类
  会留下 merge commit 的方式被拒，可用的是 `squash` 与 `rebase`），并要求名为 `check` 的检查通过；
  没有 bypass，管理员也绕不过。所以改动一律「推分支 → 开 PR → 合并」，那个检查名就是
  `.github/workflows/ci.yml` 里的 job id `check`（PR 会自动触发同一个工作流）。合并方式在服务端放行
  的两种里选 **squash**：main 上每个 PR 只留一笔，提交信息就是 PR 标题，所以分支内部怎么切、有几个
  提交都不影响 main 的形状。
- **PR 小而单一**：squash 之后 main 上只剩 PR 标题，所以那个标题必须是这一笔改动的完整说明，一个 PR
  一件事。一个分支上凑了几件事就拆成多个 PR；后面的改动依赖前面的改动时**叠成 stacked PR**（各自
  以它前面那个分支为 base，前一个合了再把自己的 base 改回 main），不要为了少开 PR 把它们压进同一个
  标题里。
- **没有明确指示不合并**：推分支、开 PR、把 PR 链接与验证结果交出来是默认动作；合并这件事要等维护者
  明说——那个 `check` 绿了也只说明「可以合」，不说明「该我合」。
- **分支名带类型前缀**：`fix/ledger-label`、`chore/release-notes`、`docs/releasing` 这种，前缀用这个
  分支最终要合的那个提交的类型。仓库里的自动化只读 PR 标题（不看分支名），这条是给人的顺序感。
- **PR 标题按约定式提交写**：`.github/workflows/autolabeler.yml` 按 PR 标题给 PR 打标签，Release
  日志的分组（`.github/release.yml`）只认标签，所以标题要是 `feat: …` / `fix: …` 这种形状。PR 里的
  提交不必是同一件事的碎片，squash 之后 main 上只剩 PR 标题，那个标题就是这一笔的全部说明。
- 改写历史前先留一个备份 ref，并在报告里给出新旧 sha 的对应关系，以及"树有没有变化"的核对方式。
