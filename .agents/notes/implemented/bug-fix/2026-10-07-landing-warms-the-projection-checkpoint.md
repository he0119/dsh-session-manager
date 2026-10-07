# Agent Note: 落地之后请宿主补投影检查点

Status: implemented

## Problem

导入、同步拉取、迁移之后，那些会话在**外壳侧边栏**里显示成「未命名」，要点开一次才有名字。

原因是标题这一格**不来自日志**：宿主的 `session/list` 对"没活过"的会话只读它自己持久化的投影检查点
（`<storages>/session_projcache/sessions/<id>.json`），读不到就回退成 `session.untitled`；而检查点只在
**活的会话**的三个时刻被宿主写——创建、`turn/end`（或节流）、释放。落到本机的那些会话恰好"从没在本机
活过"（迁移那几条虽然原来有记录，但 `identity.cwd` 已被改写，`cachedSnapshot()` 的生命周期身份校验同样
过不去）。同一份记录里还装着 `blank` 与两枚活动钟，所以缺的不只是名字：本插件自己的可见性判据与同步的
「谁更新」也一起读不到。

本机实测（2026-10-07）：422 条已存会话里 276 条没有身份对得上的检查点（MaaEnd 240/249、
smart-home-deploy 27/48）；`dsh-session-manager` 那 33 个成员里有一条（10-06 15:59 落地）在侧边栏显示
`Untitled 6d`，在真实 GUI 里点开一次之后变成 `准备发布0.1.0版本 6d`，整页刷新后仍在。

## Decision

三处落地（导入 / 同步拉取 / 迁移）在收口时多走一步 `warmCheckpoints()`
（[src/checkpoint-warm.ts](../../../../src/checkpoint-warm.ts)）：对**这次刚落到本机**的会话逐条调用宿主
自己的两个服务——

1. `sessionQuery.readSession(id)`：读完整日志并校验，**不**把它变成活会话；
2. `sessionProjectionCache.coldSnapshot(header, inheritedEventCount, events)`：折叠所有投影单元并写回
   检查点。上游文档写明"第一次冷读会建立缓存行、之后从它播种"；0.2.1-alpha.1 的产物里，这个方法除了
   自己的定义与检查面文档之外**没有任何调用点**。

这两步在一份**真实宿主服务**的沙箱里核过（会话日志从真实库拷出一份，缓存目录是临时的）：`readSession()`
给出 `version=4` / `createdAt=1790781547988` / `cwd=/home/uy_sun/dev/dsh-session-manager` /
`inheritedEventCount=0` 与 298 条事件；`coldSnapshot()` 当场返回
`{asOfSeq: 297, values: {title: '准备发布0.1.0版本'}}`，并写下
`<root>/session_projcache/sessions/<id>.json`（`identity` 与 header 逐字段相同，
`rows.title = {ver: 1, seq: 297}`）；同一份 header 再走 `cachedSnapshot()` 拿到的就是这个标题——补之前
它是 `null`，也就是侧边栏回退成「未命名」的那一步。落盘是宿主自己的 fail-soft 后台写，在那之前值已经在
它内存里那份表上。

端口由宿主那半侧探测（[src/tools.ts](../../../../src/tools.ts) 的 `hostCheckpointPort()`），核心层只认
`{ warm(id) }` 这个形状——与 `hostRegistryPort()` 同一套做法：两个服务少一件就当"这个宿主没有这套动作"，
如实报 `unavailable`，绝不半套上场。

几条硬口径：

- **它不属于落地**：逐条兜住失败，只计数与带原因（最多三条），绝不改落地结论——`verified`、命令返回、
  已写盘的字节都不受它影响；日志已经在盘上，缺的只是宿主那份派生数据。
- **顺序**：与"把注册表改动交给宿主自己做"同一次收口（拉取是整批一次），措辞只在
  `describeWarm()` 一处给出，工具层与界面层不各说各话。
- **只在真有会话落地时才跑**：纯推送、什么都没做的同步连端口都不探（`warmed + failed` 全零且不是
  `unavailable` 时，结论里不摆这一行）。

代价写在明处：每条落地会话要把整份日志读一遍折一遍（≈ 手动点开一次的代价，但换来的是持久的记录）。

## Alternatives considered

**自己写那份检查点文件。** 本仓库已有复刻宿主内部格式的先例（`project-key.ts`、`projection-cache.ts` 的
读、`session-log.ts` 的改写首帧），但那份记录是折叠的**种子**：`identity`
（formatVersion/createdAt/cwd/isSeeded/inheritedEventCount）与每行的 `ver`/`seq` 都归宿主，`ver` 对不上会
被静默丢弃、`seq` 写错会让它跳过真事件。自己写等于把"折叠语义"的实现也抄进来，抄错的方向是**静默算错
状态**，不是报错。

**只让插件自己的页面显示标题。** 插件页面本来就自己解日志开头（[src/session-title.ts](../../../../src/session-title.ts)），
从来不受影响；坏的是外壳侧边栏，它只认宿主那份检查点。

**等上游在列表路径里自己冷读。** 上游 0.2.1-alpha 的冷列表只有"读检查点"这一条路，
[coldSnapshot()](https://github.com/deepseek-ai/deepseek-harness/discussions/8610) 没有调用点；同一现象
的另一半（记录在、冷列表不采用它）在 discussion #8610 里还没定论。等它之前，每条落地的会话都要人点一次。

**落地时把那几条"取成活会话"。** 真实 GUI 点开走的正是这条路（实测留下 `session.lock`、追加一条
`session/end-seed`、写下检查点），代价是宿主持有这些会话的内存副本与写句柄——一次拉 240 条时不可接受，
而冷读只补派生数据、不建活会话、不碰日志。

**在界面上补一句"已请宿主补齐 N 条"。** 这一轮没做：结论已经进了工具的返回与 `JSON` 的 `warm` 字段，
界面文案要动 `locales.ts` 与三个面板，留给下一轮单独一次改动。

## Consequences

- 落地之后不用逐条点开，侧边栏就有标题、`blank` 与最后活动时间；下一次同步的「谁更新」因此也判得出来
  （那条判据读的就是同一份记录的 `lastPromptAt` / `lastMessageTime`）。
- 落地变慢：每条落地会话多一次完整日志读取与折叠。目前**不设上限、不做后台化**——一次拉几条时无感，
  几百条的大批量会明显拉长那次请求。
- 读不动的（老格式、坏日志）逐条跳过并计数，那几条仍旧要等第一次点开；`unavailable` 的宿主（只装了
  工具的前端、老版本）整批跳过。
- 界面这一轮只拿到 `warm` 字段，没有新增文案。
