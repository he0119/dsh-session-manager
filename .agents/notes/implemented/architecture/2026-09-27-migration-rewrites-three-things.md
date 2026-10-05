# Agent Note: 迁移会话是三件事同时改

Status: implemented

## Problem

DSH 里「会话属于哪个工作区」不是一个可改字段，而是由会话日志 header 的 `cwd` 推导出来的：

- 宿主用 `projectKey(cwd)` 决定日志所在的项目目录：`<root>/<projectKey(cwd)>/<encodeSegment(id)>/`；
- 加载时校验「文件所在项目目录 == `projectKey(header.cwd)`」，不一致即抛
  `corrupt session log … header id and cwd identify …`——**硬失败，不是降级**；
- `@deepseek-ai/dsh-workspace` 的 README 明写「来自其他目录的会话无法移入」，且公开 API
  （`create` / `get` / `list` / `delete` / `insertBefore` / `archiveSession` / `resolveByPath`）
  **没有任何 reassign / move**。

所以「把这条会话搬到那个目录」在宿主里没有对应的一个调用。

## Decision

迁移由本插件做文件系统操作，一次改三件事，缺一不可：

1. 改写日志 header 的 `cwd`（`relocateHeaderCwd()`，保结构改写，见
   [只重写第一个 frame](2026-09-27-only-the-first-frame-is-rewritten.md)）；
2. 移动日志目录到目标项目目录（`applyPlan()`）；
3. 改工作区注册表（`reHome()`）。

少做一件的后果是确定的：不改 header，宿主加载时直接抛；不移动目录，`projectKey` 对不上；
不改注册表，会话变成「未分组」。

## Alternatives considered

**只用注册表把会话挂到目标工作区。** 这只改了「登记在册」，日志还躺在旧项目目录里，宿主加载时
照样按 `projectKey(header.cwd)` 校验并抛错。

**靠 `dsh-workspace` 的公开 API 搬。** 那份 API 里没有这个动作，而且它的 README 明确说来自其他
目录的会话移不进来——这条路不是没写，是被上游有意关掉了。

**让使用者手动 `mv` 目录 + 手改 `workspace.json`。** 那是把三件事交给人的手，而其中两件（改 header
的 `cwd`、注册表的前后校验）错了都不会立刻报错，只会在下次启动时变成起不来或会话消失。

## Consequences

- 迁移是**本插件拥有**的能力，因此它也拥有对应的责任：写前备份、写后复核、可回滚，见
  [删除先备份、不碰注册表](2026-09-28-delete-backs-up-and-spares-the-registry.md) 与
  `test/engine.test.ts` 的 `plan → apply → verify → rollback` 逐字节还原。
- 三件事的次序与失败处理落在 `src/execute.ts` 的固定步骤里，回滚按同一个计划逆着走。
- 注册表那一件写完之后还得让宿主**重新读**它，否则内存副本与启动时建的索引仍是旧的：见
  [写完注册表就地重挂工作区那一层](2026-10-05-reload-the-workspace-entry.md)。
