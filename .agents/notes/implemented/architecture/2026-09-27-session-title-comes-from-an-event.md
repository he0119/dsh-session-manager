# Agent Note: 标题来自日志事件，id 退到悬浮提示

Status: implemented

## Problem

列表里显示 `session-24ee5b02-…` 这种 uuid 对人是零信息——使用者是在「我上次问那个问题的会话」这一层
挑会话的。而标题不是 header 字段，是宿主写的**日志事件**：

```json
{"type":"session/title","seq":25,"time":…,"data":{"title":"…","source":{"kind":"fallback"}}}
```

## Decision

行上显示**标题**，id 只在悬浮提示里出现。最新一条生效（用户改名压过首条 fallback），且它**不是模型
输入**，所以只是展示文本：一行、裁掉首尾空白。

读它有两个来源，`src/session-title.ts` 按顺序取：

1. **宿主的投影缓存** `<DSH_HOME>/storages/session_projcache/sessions/<encodeSegment(id)>.json`
   （`record.rows.title.val`）——宿主自己列会话就读它，所以它是「最新一条」的权威副本，零解码、
   零 I/O 放大。读之前核对 `record.identity` 的 `createdAt` 与 `cwd`：同 id 的另一条生命周期不能
   借到标题。
2. 缓存里没有（例如刚被本插件导入的会话、宿主还没重建缓存）才去**解日志开头**：只看**最新一代**文件，
   且只读开头 `DEFAULT_TITLE_BUDGET_BYTES`（256 KB）。预算之外读不到就**不显示标题**（回落 id）。

判据必须是**解析出来的** `type === 'session/title'`，不能是子串：日志里同时存在
`session/title-llm-request` 事件与「引用标题事件」的消息文本（本仓库自己的日志就是如此）。折叠前先用
`"session/title"`（带引号）做一次廉价预筛，再 `JSON.parse` 逐行确认。

## Alternatives considered

**显示 id。** 零信息，而且它本来就是「真要指名道姓时报 bug、对日志用」的那个东西。

**每次都解整份日志取标题。** 量到的：整库 23 条会话、含 6MB 的大日志时，全量解码是 3.6 s 量级；
而带标题的 `/state` 是 79 ms（不读标题 43 ms，单独那条 6 MB 的 12 ms）。

**用子串匹配找标题事件。** 会把 `session/title-llm-request` 与消息正文里的引用一起匹配上——本仓库
自己的日志就同时有两种。

**读不到就报错。** 标题是装饰，不该让「列出会话」失败：解不动、文件不在、形状不认识一律静默回落。

## Consequences

- `/state` 每次刷新列表都会走一遍，所以预算与缓存的先后顺序都是性能取舍的一部分，不是实现细节。
- 导入预演里的标题不走上面这条路：它直接从 `.dshsess` 的**载荷**里折（`src/transfer.ts` 的
  `bundleTitle`），因为那些会话还没落盘、宿主也没有它们的缓存；清单格式没为此改过
  （`BUNDLE_FORMAT_VERSION` 不动），所以旧包、别人的包一样能被折出标题。
