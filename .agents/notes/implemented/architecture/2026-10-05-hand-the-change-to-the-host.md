# Agent Note: 改完注册表把活儿交给宿主自己做

Status: implemented

取代 [写完注册表就地重挂工作区那一层](../../rejected/architecture/2026-10-05-reload-the-workspace-entry.md)
——那条路在真实宿主上把 `sessionController` 一起拆掉了。

## Problem

本插件写的 `workspace.json` 是宿主状态的**第三份**拷贝，而只有它是本插件直接够得着的：

1. 磁盘上那份（本插件写它）；
2. `dsh-storage-json` 单单元里的**内存**副本——它才是权威，之后任何一次宿主侧改动都会用内存里的整份
   数据把磁盘盖回去；
3. `WorkspaceRegistry` 的派生缓存（header 索引与"这条会话住哪儿"的映射），启动时按第 2 层建一次。

侧边栏读的是第 2、3 层。所以一次迁移、导入落地或同步拉取之后，磁盘已经是对的，宿主却还停在旧的归属上
——侧边栏不动；更糟的是此时任何一次工作区改动（新建 / 改名 / 归档）都会用内存副本把这次写盘**覆盖掉**，
而这次写盘没有任何报错。

[生效模式如实探测，不假装即时生效](2026-09-27-effect-mode-tells-the-truth.md) 那篇的初版把这件事押在
上游将来提供 `workspaceRegistry.reassignSessions()` 上，拿不到就要求使用者重启 DSH。

## Decision

改完注册表之后，插件**把活儿交给宿主自己做**（`src/take-effect.ts` 的 `takeEffectOnHost()`，端口由
`src/tools.ts` 的 `hostRegistryPort()` 从 `ctx.get('workspaceRegistry')` 与
`ctx.get('sessionPersistence')` 上探测并收成形状）：

1. **先让它按磁盘重看一眼**：`sessionPersistence.list()` 拿全部 header → `replaceHeaderIndex()` →
   `indexLiveSessions()`。这正是宿主自己 `[Service.init]()` 在"表里已经有工作区"时做的两步。必须先做，
   否则下一步的 `attachSession()` 会拿缓存里的旧 `cwd` 校验，直接抛
   `its cwd resolves to '<旧路径>'`；
2. **再让它自己改**：`create(path, title)`（同一条路径幂等，已有就返回同一个工作区）→ 逐条
   `attachSession()`（它**前插**，所以紧跟一次 `insertSessionBefore(id)` 挪到末尾，顺序才与预演一致）
   → 逐条 `detachSession()` → 源侧成员为空才 `delete()`。这几件事宿主自己会落盘、也会通知界面，
   侧边栏因此不用刷新就变。

硬约束由代码把守，不靠"应该不会"：

- **会话 id 一个都不变**：全程只有挂靠与摘除，没有 `session/create`，也不动日志 header 的 `id` 与目录名；
  迁移落地之后拿备份里那份（改动前）与落盘结果比一次——少了、多了计划外的 id 都算复核失败
  （`src/registry.ts` 的 `verifyRegistryChange()`）；
- **已存在的工作区 id 不变**：复用目标时，宿主返回的 id 与计划预测的不一致就当场停下报"仍需重启"，
  绝不悄悄换 id。同一批里**前面几笔新建**的目标是唯一例外：新建的目标由宿主分配 id，计划里那个只是
  预测，后面几笔的计划会把预测值当成"已存在"，那种不一致要放行（同步一次拉多条时会走到）；
- **回滚不走这条路**：它要的是"备份里那条记录原样回来"，包括被迁移删掉的那个工作区，而宿主的新建只会
  分配新 id。所以回滚整份写回文件、id 原样保留，并如实报 `file-only` ——文件对了，宿主手里那份还是旧的，
  要重启。

探测不到那套动作（只有工具没有界面的前端、老版本宿主）就如实说 `restart-required`；宿主中途拒绝也
**不把一次成功的迁移说成失败**（文件已经写好了），只报"仍需重启"并把原因原样带给用户——但拒绝之后
要补一件事：宿主只要动过手（最迟的一次是 `create()` 新建工作区）就会拿内存里那份整份落盘，插件写好的
文件当场被盖掉，所以失败路径上要把这次算好的注册表**整份写回**（`TakeEffectOptions.registry` 与
`EffectDeps.registryPath`，见 `take-effect.ts` 的 `restoreRegistry()`），并把结果记进
`EffectOutcome.registryRestored`。措辞只在 `describeEffect()` 一处给出，工具层与界面层不会各说各话。

## Alternatives considered

**把提供注册表的那个加载条目重挂一遍（`fiber.restart()`）。** 这条实现过，也在真实宿主上崩过：
`dsh-base` + `dsh-web-app` 的组合里，重挂把依赖它的条目一起 dispose 掉，而
`@deepseek-ai/dsh-api-session-controller` 没有回到宿主的"活动服务"表里——侧边栏一条会话都不剩，
`session/list` 报 `active Service "sessionController" is unavailable`。文件写对了、进程也没死，坏的是
别人的服务装配；这种代价不该由一次会话搬迁来付。

**等上游提供 `reassignSessions()`。** 初版就是这么做的，代码里留了一条永远走不到的探测分支；上游到
`0.2.1-alpha` 都没有这个 API，而"让宿主自己改"这件事不需要它。这条分支随本次改动删除。

**直接改 `dsh-storage-domain` 的内存表。** 内存副本是权威，改它就等于改宿主的状，但那条路要连着复刻
宿主的派生缓存（header 索引、`sessionPaths`、`domain/changed` 通知），等于把宿主的半个实现抄进插件；
宿主自己那套实体 API 已经在做这件事，抄一遍只会更早腐坏。

**让插件把整个 DSH 进程重启。** `loader.exit()` 是官方的进程级出口，但本仓库没有任何包覆盖它（等于
空操作）；真实部署里 GUI 由 systemd 单元托管（`Restart=on-failure`），`exit(0)` 永远不会被拉起。用
一次进程重启换一次会话搬迁，代价与风险都不成比例。

**只把"重启前别改工作区"写进文档。** 现实里就是这么踩上的：写盘之后随手新建一个工作区，这次迁移
就被静默覆盖。能靠一次真实改动消掉的手工步骤，不该留给使用者记住。

## Consequences

- 「要不要重启」仍是工具返回值里的一等信息，但默认答案从"要"变成"不要"；探测结果也决定界面怎么
  措辞（两侧读同一个 `EffectMode`）。
- 认的是宿主自己的实体 API 与方法形状，**不是**本插件的契约：宿主改了 `create` / `attachSession`
  的形状或去掉 `replaceHeaderIndex`，探测就退回"需要重启"，不会静默降级成"以为生效了"。
- 落到宿主手里之后，**它自己那一步会再写一次文件**：净结果是宿主的内存（含它分配的 id）成为磁盘上的
  最终状态，比"写完就不管"少一个覆盖窗口。
- `replaceHeaderIndex()` / `indexLiveSessions()` 在宿主的类型面里标着 `private`，但运行期是普通原型
  方法，也是宿主自己 `[Service.init]()` 用的两步。这是本插件对宿主内部最靠里的一次触碰，两个名字任一
  变化都会被形状探测抓住。
- **活着的会话仍然无解**：宿主手里有内存副本与写句柄，改注册表也换不回它——所以那条限制照旧由
  `liveSessionIds()` 把守，不因为这次改动放松。这条限制在接管这一层里的落法是[迁移的计划层直接把它们
  摘出去、并如实报出来](../bug-fix/2026-10-08-live-sessions-cannot-move.md)——它们搬不动这件事由计划
  说话，而不是等宿主在第一条上回绝、顺手把写盘盖掉。
