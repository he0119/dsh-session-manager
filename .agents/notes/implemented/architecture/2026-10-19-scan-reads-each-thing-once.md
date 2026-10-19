# Agent Note: 扫描时每样东西只读一次

Status: implemented

## Problem

打开「会话」页（`GET /state`）要扫整库。本机真实库：997 条会话、1005 个代次日志、日志合计 619 MB，
宿主投影缓存 1003 个文件、合计 169 MB。这趟扫描原来在两个地方做了白读：

1. **日志整份读，只用开头一帧。** `scanProjectDir()` 用 `readFileSync()` 把每个日志整个读进来，而
   `readHeaderQuick()` 只解首帧——首帧实测 168～299 字节，1005 个文件里没有一个超过 64 KB。
2. **同一个投影缓存文件每条会话读两遍。** 标题在扫描那一趟读（`createTitleResolver`），空白判据在
   `summarizeSessions()` 里又读一遍（`createBlankResolver`），同步那条路还要读第三遍（`sessionMeta`）。
   一趟是 680～770 ms（读文件 347～370 ms + `JSON.parse` 另外一半），读完就丢。

同一台机器、同一份库、同一个进程里交替量三次：

| 量 | 三次 | 中位 |
| --- | --- | --- |
| 整份读日志 + 解首帧 | 414 / 433 / 621 ms | 433 |
| 只读 64 KB + 解首帧 | 287 / 297 / 297 ms | 297 |
| `/state` 那条路：缓存读**两趟** | 1751 / 2095 / 2099 ms | 2095 |
| `/state` 那条路：缓存读**一趟** | 985 / 1197 / 2359 ms | 1197 |

（页缓存已热的另一组：`scanAll()` 不带标题 356～366 ms，带标题 1041～1096 ms，再加逐条判空白
1741～1799 ms；同样的两个变体是 1704～1739 ms 与 1017～1069 ms。两组的变化方向与比例一致。）

## Decision

两处都改成"读一次就够"。

**日志只读开头一段。** `readLogHeader()` 先 `statSync` 拿整份大小，再只读
`min(size, 64 KB)`；`readHeaderQuick()` 在这个前缀上解不出合法 header 时退回读整份——那条路一直留着，
正确性不依赖"首帧有多小"这个实测结果。`files[].bytes` 报的是 `statSync().size`（整份），不是读到的
长度：界面那一列与同步的内容指纹比的是整份日志。

**投影记录扫描时读一次，挂在会话上。** `ScanOptions.projection` 是"给我一条会话、给你那条记录"，
`scanProjectDir()` 每条会话调它一次，结果挂在 `DiscoveredSession.meta` 上。下游三处都从这一份取：

- 标题：`createTitleResolver()` 见到 `query.meta` 就不再读缓存文件，只借里面的 `title`，没有才去日志
  开头的有界前缀里找；
- 空白判据：`/state` 的 `summarizeSessions()` 与迁移计划的 `hiddenReasonOf()` 都读 `session.meta.blank`；
- 同步的两枚活动时间：`sync.ts` 的 `metaOf()` 用 `sessionMetaOfRecord(session.meta)`。

原来那几个注入点（`api.resolveBlank` / `api.sessionMeta` / `syncDeps.sessionMeta` / `MigrateDeps.resolveBlank`）
都留着，仍然是**显式注入时优先**：测试靠它们钉"读不到"与"读取器坏了"的边界。

## Alternatives considered

**让宿主内存里那份投影来替掉读文件。** 宿主的 `ctx.sessionProjectionCache.cachedSnapshot(header)` 是零
I/O 的。实测它只服务声明了 `wire` 的单元：不带 keys 读一条记录只回来 `title`、`goal`、`tokenUsage` 那
一批，**没有 `sessionListMetadata`，也没有 `timeContext`**——空白与两枚活动时间拿不到。而文件反正要为
空白读一遍，所以那条路做不出比"每会话只读一趟"更好的结果，只会多一个数据来源。实测数据与判断记在
[读结果复用](../../proposed/architecture/2026-10-19-reuse-scan-results-between-refreshes.md) 里。

**每条会话只读一份记录、但照旧从两个注入点取（`resolveTitle` / `resolveBlank` 各读一次，靠记忆化去重）。**
那要求读取器的记忆化生命周期按"一次请求"算，而这些读取器是建进程时造一次、一直用下去的；把生命周期
挂错就会在下次刷新时拿到上一次的标题。挂到会话上不需要这层生命周期，`session.meta` 跟着那一次扫描走。

**只改"少读日志"这一条。** 单独一条也成立（省 619 MB 的读），但投影缓存那两趟是更大的头，而且两处
改动的形状一样（都是"这次已经读过的不再读"），分两个 PR 不划算。

## Consequences

- 本机真实库上，改动前后**逐字段等价**：997 条会话，标题 957 条、空白 40 条，`session.meta` 与
  "一条一条读缓存文件"的结果 0 处差异（用 `/tmp` 下的临时脚本跑过，脚本已删）。
- 日志那一趟从 433 ms 降到 297 ms（热页缓存下从 356～366 ms 降到另一组量级）；`/state` 那条路从
  2095 ms 降到 1197 ms。
- `DiscoveredSession` 多了一个可选字段 `meta`。它只是"这次扫描读到的记录"，不进任何对外契约：没有
  `projection` 的扫描（导出）拿不到它，各调用方按"没有记录"处理。
- 首帧 64 KB 这个上限是余量，不是判据：真超过时退回整份读，测试里有一条专门造这种文件钉住它。
