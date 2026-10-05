# Agent Note: 写完注册表就地重挂工作区那一层

Status: implemented

## Problem

本插件写的 `workspace.json` 是宿主状态的**第三份**拷贝，而只有它是本插件够得着的：

1. 磁盘上那份（本插件写它）；
2. `dsh-storage-json` 单单元里的**内存**副本——它才是权威，之后任何一次宿主侧改动都会用内存里的整份
   文件把磁盘盖回去；
3. `WorkspaceRegistry` 的 header 索引（`headers` / `sessionPaths`），在启动时建一次，`readSessionHeader`
   对不在内存里的 id 直接回缓存里的旧头。

侧边栏读的是第 2、3 层。所以一次迁移、回滚或导入落地之后，磁盘已经是对的，宿主却还停在旧的归属上；
更糟的是此时任何一次工作区改动（新建 / 改名 / 归档）都会用内存副本把这次写盘**覆盖掉**，而这次写盘
没有任何报错。

[生效模式如实探测，不假装即时生效](2026-09-27-effect-mode-tells-the-truth.md) 那篇的初版把这件事押在
上游将来提供 `workspaceRegistry.reassignSessions()` 上，拿不到就要求使用者重启 DSH。而"让宿主重新读
一遍"并不需要新 API：把提供那个服务的那一行加载条目本身重挂一遍即可。

## Decision

写完注册表之后，插件**自己**把提供 `workspaceRegistry` 的那个加载条目重挂一遍
（`src/reload.ts` 的 `reloadWorkspace()`，端口由 `src/tools.ts` 的 `workspaceReloadPort()` 从
`loader.entries()` 里探测）：

- 认的是**模块名**（`options.name === '@deepseek-ai/dsh-workspace'`），因为条目 id（`include:workspace`）
  取决于 profile 的嵌套形状，而模块名是那一行自己声明的；
- 执行的是 `fiber.restart()`（dispose + 重新 init），完成后 `ctx.get('workspaceRegistry')` 拿到的是
  **新实例**：它重读 `workspace.json`、重扫会话日志重建 header 索引——正是整机重启对**这一层**做的事，
  但不动进程、不杀正在跑的回合（会话持久化实例不受影响，`identity` 不变）；
- 依赖 `workspaceRegistry` 的条目会被 Cordis 级联重挂（`disposed` → `mounted`），这是重挂的应有之
  义，不是副作用；
- 三处写注册表的编排都在写完之后调它，但**执行时机由编排层决定**：迁移、回滚各一次，导入 / 同步
  拉取按**整批**收口一次（不是每条会话重挂一次）；
- 探测不到那一行（换过模块名、老宿主、只有工具没有界面的前端）就不重挂，工具与界面如实说
  `restart-required`；重挂**失败也不把迁移说成失败**（文件已经写好了），只报"仍需重启"，并把原因
  原样带给用户。

## Alternatives considered

**等上游提供 `reassignSessions()`。** 初版就是这么做的，代码里留了一条永远走不到的探测分支；上游到
`0.2.1-alpha` 都没有这个 API，而"让宿主重读一遍"这件事不需要它。这条分支随本次改动删除。

**只改 `WorkspaceRegistry` 的内存（公开实体 API + 私有的 `replaceHeaderIndex`）。** 公开 API 里没有
跨工作区改挂（只有 `attachSession` / `detachSession`），补完它得连着调私有方法重建索引；依赖上游私有
方法比依赖 Cordis 的公开加载 API 更脆，而且覆盖不到"内存副本仍然是旧文件"这一层。

**让插件把整个 DSH 进程重启。** `loader.exit()` 是官方的进程级出口，但本仓库没有任何包覆盖它（等于
空操作）；真实部署里 GUI 由 systemd 单元托管（`Restart=on-failure`），`exit(0)` 永远不会被拉起。用
一次进程重启换一次工作区重挂，代价与风险都不成比例。

**只把"重启前别改工作区"写进文档。** 现实里就是这么踩上的：写盘之后随手新建一个工作区，这次迁移
就被静默覆盖。能用一次重挂消掉的手工步骤，不该留给使用者记住。

## Consequences

- 「要不要重启」仍是工具返回值里的一等信息，但默认答案从"要"变成"不要"；探测结果也决定界面怎么
  措辞（两侧读同一个 `EffectMode`）。
- 探测认的是 Cordis 的公开面（`loader.entries()` / `fiber.restart()`），但**不是**本插件的契约：宿主
  换掉条目名或加载器就自动退回"需要重启"，不会静默降级成"以为生效了"。
- 重挂会连带重起依赖工作区的那些条目（本插件的界面半侧、`dsh-api-workspace-controller` 等）。这是
  一次性的：重挂完成后它们的 `ctx.effect` 会重新装配。
- **活着的会话仍然无解**：宿主手里有内存副本与写句柄，重挂也换不回它——所以那条限制照旧由
  `liveSessionIds()` 把守，不因为这次改动放松。
