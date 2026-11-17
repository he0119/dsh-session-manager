# Agent Note: 目录按操作分，共用件收进 shared

Status: implemented

## Problem

`src/` 根下平铺着 40 个模块：迁移的计划与执行、同步的编排、导入导出的容器、删除、改名、修日志、日志
解码、会话库扫描、注册表校验全在同一层。想找「同步怎么算计划」要先知道它叫 `sync.ts`，想找「备份清单
谁写的」得先猜是 `journal.ts` 还是 `execute.ts`——文件名与操作之间没有可以照着走的结构。

浏览器半侧同一种病，只是换了两堆：`src/client/logic/` 平铺 30 个文件、`src/client/components/` 平铺 26
个文件，`Hint` / `ProgressBar` / `ConfirmDialog` 这种所有面板共用的控件，与 `SyncPanel` / `SyncDiffDialog`
这种只服务同步的弹窗挨着放；`syncForm.ts` 与 `groups.ts` 并列，读者看不出前者只给同步用、后者全站都用。

于是「新文件放哪儿」每次都要重新决定一次，决定结果只能靠记忆维持；`docs/development.md` 那张逐文件
职责表也只能是一张平铺的长表。

## Decision

目录先按**层**分，再按**操作**分。工具定义也照这条走：每个操作的 schema、返回形状与结论措辞放在
`src/operations/<操作>/tool.ts`，`src/tools.ts` 只剩开关、依赖与注册顺序。

| 位置 | 放什么 | 判据 |
| --- | --- | --- |
| `src/index.ts`、`config.ts`、`tools.ts`、`web.ts` | 插件外壳：入口装配、配置 schema、工具注册、界面端点 | 只有这四份能看见宿主 |
| `src/shared/` | 被两个以上操作用到、或插件外壳与测试同时用到的零件 | 只回答「按什么标准算」，不含任何一种操作的流程 |
| `src/operations/<操作>/` | 那一种操作的编排，加上只有它用的助手 | 删掉这个文件夹，别的操作照旧能跑 |
| `src/client/shell/` | 页面外壳 | 页面这一级，不服务单个弹窗 |
| `src/client/shared/{ui,logic,hooks,i18n}/` | 共用控件、与操作无关的纯逻辑、浏览器事件钩子、两份字典 | 两个以上操作会画 / 会用 |
| `src/client/operations/<操作>/` | 这一面的弹窗（`.tsx`）与它自己的判据（纯 `.ts`） | 只服务这一面；判据不 import 组件 |

分成 7 个操作：`migrate`（迁移：计划、执行、产物）、`transfer`（导出 / 导入 `.dshsess`）、`sync`
（WebDAV 同步与自动推送）、`remove`（删除）、`retitle`（重新生成名称）、`path-repair`（修已应用的日志
路径）、`transcript`（会话日志解析）。浏览器半侧按同一批操作切，另加 `manage`（会话页与六个写盘动作的
状态窗）、`backup`（备份与回滚）、`help`（说明页）。

测试跟着 `src/` 走：`test/{shared,operations,client}/` 与源码同构，入口级与门禁那一批（端点、工具、
配置、产物冒烟、文档检查）收进 `test/plugin/`，共用的测试数据在 `test/fixtures/`。runner 改成递归扫描——
目录名不是判据，新加一层不该让文件悄悄不跑。测试写盘的临时目录收成一个根 `test/.sandbox/<名字>`
（`test/fixtures/sandbox.ts` 的 `sandboxDir()`），不再每个文件在自己目录下各起一个 `.sandbox`。

日志格式单独一层 `src/shared/log/`：字节与帧、解码、行缓存、保结构改写、跟随会话根搬的路径、会话名；
会话库扫描单独一层 `src/shared/library/`：扫库、按 id 定位、两级缓存。应用之后请宿主认下改动的两步
（`take-effect` / `checkpoint-warm`）放 `src/shared/host/`，因为迁移、导入、同步三个应用口都调它。

这一轮**只移动、不改名、不拆内容**：92 个源码文件与 77 个测试文件、测试数据按上表换位置，导入说明符按
新位置重算，正文一个字不改。`sync.ts`（4803 行）、`web.ts`（2230 行）、`tools.ts`（1739 行）的拆分
是另一件事，混在移动里出错时无法区分「路径写错」与「拆逻辑写错」。

## Alternatives considered

- **顶层并列功能目录**（`src/migrate/`、`src/sync/`… 与 `src/shared/` 并列）：少一层嵌套，但「哪些是
  操作、哪些是共用件」只能靠记文件名；`operations/` 这一层本身就是那条判据，留着它让「删掉这个文件夹
  别的操作照旧能跑」可以照着看。
- **按技术层分**（`domain/`、`io/`、`web/`）：本仓库的读者是按操作来问的（「迁移为什么先备份再搬」），
  按技术层切会把一种操作的编排与它的助手拆到两处，读者要来回跳。
- **保留 `logic/` 与 `components/` 两组平铺，只把共用件挑出去**：共用与专用的边界仍然要靠读内容判断，
  新文件仍要猜；而一份 `SyncPanel` 与它那 11 份判据本来就该一起看。
- **只搬源码、测试仍平铺**：`test/` 还留在 77 个文件一层，找「同步那一面的判据测在哪儿」仍然要翻整张
  清单；而测试与它测的模块本来就该并排看。拆成两个提交时多出的那次 review 也不划算——同一份映射表
  能用两次。

## Consequences

- 92 个源码文件与 77 个测试文件、测试数据移动，707 处导入说明符改写；`docs/development.md` 的逐文件表
  改成按目录的 25 个小节，每个文件一行；`AGENTS.md`、`docs/design.md`、`docs/internals.md`、
  `docs/formats.md` 与 `.agents/notes/` 里指路的路径一并改到新位置。
- `test/plugin/client.test.mjs` 里那三条「扫 `src/client/components` 的源码守卫」（JSX 裸注释、原生 `title`、
  `variant="ghost"`）改成递归扫 `src/client`：按目录名写死路径的判据会随目录结构静默漏扫。
- 源码注释里的相对链接按新位置重算；原先就指错地方的几处（`./api.ts` 写在 `components/` 里、
  `../.agents/…` 少一层）一并改成能解析的路径。
- 代价：跨目录的相对导入多一层 `../`；文档里引用的路径变长。换来的是「新文件放哪儿」有一条可以照做的
  判据，而不是每次重新决定。
- 工具层按同一判据拆开：`src/tools.ts` 从 1742 行降到约 90 行，可选宿主服务的探测进
  `src/shared/host/ports.ts`，插件自己的目录进 `src/shared/plugin-paths.ts`，同步运行时进
  `src/operations/sync/runtime.ts`，6 个工具的定义进各自操作目录的 `tool.ts`。
- 没做：`web.ts`（2230 行）仍把 12 个端点写在一个文件里，`sync.ts`（4803 行）仍把索引、计划、应用、
  自动推送与附件对象放在同一份；测试目录与源码目录的层级完全同构，但测试文件名没有跟着模块改名。
