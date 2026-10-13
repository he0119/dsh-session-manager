# Agent Note: 源永远是一个目录（「未分组」只是一枚标签）

Status: rejected — 源改成"点名的那些会话"之后，源不再被限制成一个目录；「未分组」仍然只是一枚标签（这一条没变，见后继笔记）

被[迁移的源就是你勾的那些会话](../../implemented/architecture/2026-10-13-source-is-what-you-tick.md)取代。
下面写的是它**落地时的形状**：`BuildPlanOptions.from`、`MigrateRequest.from`、`migrate_*` 工具的两个
`from` 参数、`planRows.migrationSourceRows()` / `migrationMatching()` 与
`test/unowned.test.ts` 这些符号都已经删掉，留在这里是因为"一次迁移只处理一个目录"这条路读起来很干净，
而它办不到的事有现象可查（下面 `## Problem` 里那 8 条会话分在 4 个目录里，一次只能迁一个）。

## Problem

项目文件夹被删掉之后，它那些会话在外壳侧边栏里落到「未分组」那一组里；而迁移页的源字段里另有一条
「未分组」（值控件上的哨兵值 `@unowned`），与目录候选并排摆着。两处名字一样，读起来就是"未分组是一个
源目录"。

它真正的问题不是名字：那条来源横跨库里**所有**没被认领的目录。本机实测的一个 770 条会话的库里，
未分组共 8 条，分散在 4 个目录里（其中 1 条属于一个已经被删掉的项目目录）——而一次迁移只有一个目标。
于是"把刚删掉的那个项目迁到重建后的位置"这件事在界面上反而没有落点：源那一侧给出的是一袋跨目录的
会话，下面那个开关还时灵时不灵（跨目录时"搬迁会话产物"没有基准，界面只能把它藏起来）。

## Proposal

迁移页的源**永远是一个目录**：

- **候选只有目录**：已登记的工作区，加上库里真有会话的 `cwd`（后者带条数）。`cwd` 就是路径本身，
  **不要求那个目录还在盘上**——项目文件夹删掉之后，会话日志与 header 里的 `cwd` 都还在，于是这条目录
  照旧在候选里；把项目重建到别处，选这条旧目录当源、目标指到新目录就迁过去了。真正必须存在的是
  **源项目目录**（会话日志那一层，`projectDirOf(root, from)`），计划层照旧检查它。
- **「未分组」退回它本来的位置**：行上的一枚标签（`list.ungrouped`）与会话页筛选条上的一枚芯片。
  判据没有变，仍是 `src/visibility.ts` 的 `isUngrouped()`（谁都没认领 **且** 侧边栏会显示它），
  见 [「未分组」就是外壳那一组](../../implemented/bug-fix/2026-09-28-ungrouped-means-the-sidebar-group.md)。
- **`unowned` 参数从三处删掉**：计划层（`BuildPlanOptions`）、编排层（`MigrateRequest` /
  `MigrationPreview`）与 `/migrate` 端点；`from` 是必填的（空串 ⇒ 计划报 `from is required`，
  端点 400）。工具层的 `migrate_sessions` 本来就只有 `from`，不受影响。
- **两个开关不再有"这个来源下不适用"的分支**：源是一个目录，所以"连同未分组的会话"与"搬迁会话产物"
  都有基准，照常摆出来。

## Alternatives considered

**留着它当第二种来源，只把值控件显示成人话。** 这就是改前的样子：名字对上了侧边栏，但它在界面上与
目录候选并排，读起来仍是"未分组是一个目录"；而它真正办不到的是跨目录那批在"迁到某个新目录"上没有
意义（一次只有一个目标）。

**在里面按 `cwd` 分节，可只勾某一段。** 那等于把"这些会话的目录是哪里"在候选里说第二遍；按目录各迁
一次已经能做完这件事，多出来的那层壳只是把"来源"这个概念又拿回来了。

**保留 `unowned` 参数、只摘掉界面入口。** 对外契约留下两种形状，说不清哪个是现在时；而且跨目录的源在
产物搬迁那一层仍然没有基准（`planArtifactMoves` 只收一个 `fromDir`），那条拒绝分支会一直挂着。

## Consequences

- 一次迁移只处理一个目录；"这几个目录里没在册的那几条一次收编"要按目录各来一次。
- 源目录已经被删掉这条路上，`registered` 与注册表变更都按宿主的**认领**口径走（目录解析不出来 ⇒ 宿主
  不算成员），而注册表里那条登记还在，所以迁移照旧按"从那块工作区摘走"处理，源记录被摘空后删掉。
  `test/engine.test.ts` 用"项目文件夹删了 → 迁到重建后的目录 → 复核 → 回滚"把这条钉住。
- 界面上少两个字典键（`migrate.from.unownedHint` / `migrate.projectDirsUnowned`），
  `planRows` 少了哨兵值与 `unownedSessions()`，`DirectoryField` 少了只为哨兵存在的 `manualValue`。
- 被取代的那条决策留在[否决记录](../../rejected/architecture/2026-09-27-unowned-is-a-migration-source.md)；
  这一条自己也被[后继决策](../../implemented/architecture/2026-10-13-source-is-what-you-tick.md)取代了。
