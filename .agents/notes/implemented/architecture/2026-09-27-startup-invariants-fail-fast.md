# Agent Note: 启动不变式违反就报错，不降级

Status: implemented

## Problem

宿主的 `WorkspaceRegistry` 在启动时走 `validateStoredState()` 校验已存状态，以下任一都让**启动失败**
（报的是 `workspace domain is inconsistent: …`）：

- 两个 workspace 记录的 `path` 相同；
- 同一个 `sessionId` 出现在多个工作区注册表里；
- `global.workspaceIds` 有重复；
- `global.workspaceIds` 的集合 != `tables.workspaces` 的键集合（顺序漂移）。

本插件是少数会**写**注册表的组件之一。

## Decision

`validateRegistry()` 复刻这四条，`reHome()` 在操作**前**与操作**后**各校验一次。因此本插件不可能
产出让宿主起不来的注册表。

写入口只有一条：`loadRegistryForWrite()` 在整条迁移链路的最前面（`runMigration()` 之前）先校验，
不满足就直接拒绝，而不是「先在坏注册表上叠一层改动，回头再说」。

## Alternatives considered

**只在最终提交前校验一次。** 中间状态也会落盘（`writeRegistryAtomic()` 是原子写但不参与事务），
而「前一次校验通过、后一次没通过」正是需要被发现的那种情形。

**让宿主的校验兜底。** 它兜底的代价是下次启动整个 workspace 域起不来，而报错信息指的是注册表文件，
离「本插件上次写了什么」很远。写的人自己先验，报错就落在这里。

**遇到违反时自动修复（去重、重排）。** 那是在猜测用户的数据该长什么样；注册表被外部改坏时，
修好它的收益远小于改错它的代价。

## Consequences

- `reHome()` 的前后校验让「迁移完成」与「迁移留下了合法状态」是同一件事。
- 注册表被外部改坏时迁移会拒绝执行，而不是把坏状态搬着走——`test/registry.test.ts` 把四条不变式
  逐类钉住。
