# Agent Note: 「认领」是宿主那份成员表

Status: implemented

## Problem

注册表里登记过一条会话，插件就当它"有主"：`/state` 的「未分组」、行上那枚标签、迁移页那个来源都
这么判。宿主不是这么判的——`Workspace.sessionIds` 把每条登记再过滤一遍，判据是"这条会话 header 的
`cwd` 归一（`realpath`，且必须还是一个目录）之后等于记录的 `path`"，没过的那条**不算成员**。

目录被改名或删掉之后（注册表里那条登记还在、会话日志也还在），同一批会话在外壳侧边栏落进「未分组」，
插件却报"它有主"。本机实测：注册表登记 1043 条、宿主实际认领 1019 条，差额里 8 条是有 `cwd`、侧边栏
看得见的会话（一个被改名的项目目录 7 条，另一个目录没了的 1 条）；迁移页那个来源因此一条候选都不出现，
而侧边栏那一组里明明摆着会话。

## Decision

「认领」只有一个定义，算在 `src/accounting.ts` 的 `accountedOwners()` 里：**登记过** 且 **header 的
`cwd` 归一之后就是那条记录的 `path`**。归一用 `src/canonical-path.ts` 的 `canonicalDirIfExists()`
（`realpathSync.native` + 必须是目录，解析不出来返回 `undefined`）——与宿主 `indexHeader()` 是同一支。

- `/state` 的两处（`sessions[].ungrouped` 与 `workspaces[].sessionIds`）、迁移计划的三处（未分组来源
  的候选、`includeUnowned` 那道拦、`SessionMove.registered`）都读这一份；
- `isUngrouped()` 那两件事里的"谁都没认领"从"不在登记里"改成"不在认领表里"（见
  [「未分组」就是外壳那一组](./2026-09-28-ungrouped-means-the-sidebar-group.md)）；
- 同一个 `cwd` 只解析一次：`realpath` 要碰磁盘，而一个库里上千条会话挤在几十个目录里；
- 库里扫不到的登记项不进结果：判不了"目录还在不在"，也就不声称它被认领。

## Alternatives considered

**继续读注册表里的原始 `sessionIds`。** 那就是这次的现象：目录改名之后插件与外壳对同一批会话各说
各话，迁移页那个来源永远是 0 条。

**只比 `cwd` 字符串与记录 `path`。** 本机那 7 条会话的 `cwd` **逐字就是**记录的 `path`（目录没了，
字符串还一样），这一支照样判它"有主"，一条都修不好。

**自己判"目录还在不在"（`existsSync`）而不做 `realpath`。** 符号链接 / junction 指向同一处时宿主认、
插件不认，两边又分叉；判据必须与宿主同一支。

**把过期的登记从注册表里删掉。** 那是替宿主改账：宿主自己留这条登记（归档位置那类语义要它），只在它
下一次改写这条记录时才顺手剪掉。

## Consequences

- 目录来源与「未分组」来源可能同时给出同一条会话：插件按目录分组、外壳按工作区分组，而那批会话本来
  就住在自己那个目录里，两条路都能把它们搬走（见
  [列整库的两个分页按目录分组](../architecture/2026-09-27-group-by-directory-not-workspace.md)）。
- `/state` 的 `workspaces[].sessionIds` 变成认领的那份，与宿主发给渲染层的取值同源；界面拿它当成员表
  看时不会再多出 `cwd` 已经对不上的登记。
- 迁移的 `registered` 只决定级联带进来的子代理改不改挂，不改变候选口径。
- `test/accounting.test.ts` 钉住四种边界（解析不出来 / 归一后不是同一个字符串 / 没有 `cwd` / 库里没有
  这条会话），并按真实形状跑一次"目录改名"。
