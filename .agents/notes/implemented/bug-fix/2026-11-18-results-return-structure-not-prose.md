# Agent Note: 结果只回结构，给模型与给人的文字各自渲染

Status: implemented

## Problem

迁移与删除的预览、执行结果里都带着一段 `summary`：Host 半侧拼好的多行中文文本。它有两个读者，却只有
一种写法：

- **界面**把它整段塞进一个 `<div>`。`\n` 在 HTML 里被折成空格——一次「迁 1 条、留 4 条」的运行就是
  四百多字连成一段的绿色字块，里面还夹着四个 36～44 字符的会话 id、备份目录的绝对路径，以及"宿主怎么
  改的注册表"这段过程说明。用户在弹窗里只想知道"搬了几条、搬到哪、哪几条没搬、要不要重启"；
- **模型**要的恰恰是那几样：顺着 id 去处理（取消归档、连着父会话迁），以及备份目录、要不要重启；
- 另外那段是中文硬编码——英文界面照样摆中文。

删除是同一个形状：`RemovalRun.summary` 兼做"将删除 N 个会话"与"已删除 N 个会话、远端怎样、复核过没
过"，界面两处都原样摆。其余动作（同步、导入、回滚、整理远端、重算名称、归档）早就是浏览器半侧按字段
拼文案，只有这两个动作还在 Host 半侧写字。宿主替界面拼文案，等于把"界面怎么说话"这条决定搬进 Host
半侧，还绕过了客户端 locale 机制。

## Decision

**Host 半侧只回结构化数据，一段拼好的文字都不带；谁要文字，谁按自己的读者渲染。**

- **给模型的那一份**在工具层：`src/operations/migrate/report.ts` 的 `describeMigrationPreview()` /
  `describeMigrationRun()` 把预览与执行结果渲染成多行文本（点名会话 id、备份目录、怎么生效），由
  `tool.ts` 填进工具的 `summary` 字段；dry-run 那句"没写任何字节、传 apply:true 执行"也在这里接上。
  工具返回另外给 `liveSkippedIds` / `strandedIds` 两个字符串数组，模型按 id 处理时不必解析正文。
- **界面的那一份**在浏览器半侧，按宿主字段 + locale 键拼，纯函数单独钉住：

  - 迁移（`ManagePanel` + `migrateResult.ts`）：结论 `已迁移 N 条会话到 X。`（复核没过时带出「但复核
    没通过」）、收据 `改写 A 个日志、移动 B 个目录 · 复核通过`、没搬的每类一句（「子智能体 2、已归档 2」，
    不列 id）、标题没补上一句；问题清单、「需重启才生效」、「撤销」照旧。
  - 删除（`ManagePanel` + `deleteResult.ts`）：确认弹窗一句「将删除 N 个会话，先备份再删。」+ 级联
    说明；结果页一句「已删除 N 个会话。」+ 级联说明 + 远端那一步（本机清掉几个包、别的机器上还留着
    哪几台）+「复核没通过」的告警。`manage.delete.*` 那一组键中英两份。
  - 两个模块共用同一条判据：一条事实只在一处措辞（`deleteCascadeNote()` 给确认弹窗与结果页共用）。
- 契约随之改：`MigrationPreview` / `MigrationRun` / `RemovalRun` 去掉 `summary`，
  `POST /migrate` 与 `POST /delete` 的响应不再带 `summary`；浏览器半侧的 `MigrationResponse` /
  `DeleteResponse` 同步去掉，并补上界面对话框要用的字段（`warm`、`preview.cascaded`）。
- 已经在浏览器半侧拼文案的动作**不动**：同步（`describeSyncNotice`）、导入、回滚/恢复、整理远端、
  重算名称（`describeRetitle`）、归档都是字段 + locale 键；只给模型看的 `repair_session_paths` /
  `verify_workspace_sessions` 只有工具一个入口，文字就在 `tool.ts` 里拼。

`describeEffect()` / `describeWarm()` 仍是共用件：它们是"这一步怎样了"的结论，工具与别的动作都在用；
这次只是不再由迁移编排把它们拼进一个整体字符串。

## Alternatives considered

- **保留 `summary`，只给它加 `white-space: pre-line`**：换行回来了，但读的人还是要在一段四百多字里
  找句子，中间夹着会话 id 与备份路径；英文界面照旧是中文。
- **在界面上把 `summary` 的行截短、把 id 过滤掉**：靠"这次没搬："后面跟的是 id 这种字符串模式猜语义，
  宿主改一个字就错位，而且过滤规则会成为第二份格式约定。
- **让宿主 `summary` 直接改成界面要的短句**：模型那份就丢了 id 与备份目录；把 id 摆到弹窗里又正是
  这次要修的乱。
- **只改迁移，删除继续由宿主拼**：同一个界面里两种来源，下次改文案的人分不清该改哪一份；而且删除那段
  同样是中文硬编码。
- **把四个会话 id 也摆在结果页上**：用户要的是"哪几类、怎么办"，而四条 id 换来的是一段折行的十六进制；
  真要按 id 处理，工具那一面与「备份与回滚」都在。

## Consequences

- 迁移结果页在 640 宽的弹窗里是 2～4 行短句，删除结果页是 1～3 行；每行一句话，成功色只落在结论上。
- 英文界面这两处跟着 locale 走；以前不管语言都摆中文。
- 模型那一面的正文与以前逐字一致（同一套句子搬进了 `report.ts`），工具返回的 `summary` 字段照旧。
- 对外契约变化：`POST /migrate`、`POST /delete` 的响应少了 `summary`（本包自己的界面是唯一消费者）；
  `migrate_sessions` / `plan_session_migration` 的输出多了 `liveSkippedIds` / `strandedIds`。
- 测试：`test/plugin/web.test.ts` 钉住两个响应里没有 `summary`；`test/operations/migrate/report.test.ts`
  与 `test/client/operations/manage/{migrateResult,deleteResult}.test.ts` 钉住两份渲染；界面冒烟
  （`test/plugin/client.test.mjs`）钉住结果页按字段拼、不出现宿主那段摘要。
- 以后哪个动作想把同一段字给两个读者，先拆成结构 + 两份渲染；两边的读者不同就别共用一份措辞。
