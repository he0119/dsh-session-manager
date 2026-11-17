# Agent Note: 内容视图的整份计数搬出主线程

Status: implemented

## Problem

打开一条会话的内容视图要先知道"这份日志一共有多少条事件、各类各多少"——标题栏与分页都靠它。这份账原先
在 `countTranscript()` 里同步过一遍整个行数组：本机最大的一份日志解开是 150002 行 / 31 MB，实测 **67 ms**、
最长停顿 **62 ms**，直接越过"用户会等的地方 50 ms"的预算（见
[异步化的边界是阻塞预算](../architecture/2026-11-17-blocking-budget.md)）。翻到第 2 页还要再数一遍：同样是
60 ms 上下，明明文件没变。

解的难点在于 `readTranscript()` 也在用这份账，而它是同步函数：不能在里面 `await`，否则解析结果就变成
Promise，浏览器那侧、测试与 `session-diff.ts` 的调用点都要跟着改。

## Decision

把"数一遍"拆成三段，`readTranscript()` 与端点各走一条：

- `countRange(lines, from, to, state)`：真正逐行记账的那一段，两个入口共用，口径不会分叉。
- `countTranscript()`：同步版本，保留给几行的差异子集与测试。
- `countTranscriptAsync()`：每 `COUNT_CHUNK_LINES = 2048` 行 `await` 一次（`setImmediate`）。
  `readTranscriptAsync()` 用它拿账，再走与同步版本**同一个** `parsePage()` 组装这一页。
- `/transcript` 与 `/sync` 的差异端点（`problemsOf`）改走 `readTranscriptAsync()`；同步的
  `readTranscript()` 只留给"行数很少"的调用点。

同一份行数组的账按**数组本身**缓存（`WeakMap<readonly string[], TranscriptCounts>`）：日志没变时
`log-text-cache.ts` 复用同一个数组，因此翻第二页不必再数。调用契约要求把 `lines` 当只读，账不会过期。

实测（`bench/` 的 `full` 档，48 MB 那份日志）：

| 动作 | 改前 | 改后 |
| --- | --- | --- |
| 第一页（冷） | 73 ms 停顿 | 27 ms 停顿（8 ms 是计数那一段） |
| 翻到第 2000 条 | 84 ms 停顿 | 5 ms 停顿、9 ms 耗时 |

`default` 档（12 MB）保持原样（19 ms 停顿）。两条场景的预算都收回 50 ms。

## Alternatives considered

- **只加缓存**：第一页照样要同步数一遍 62 ms，预算仍然破；缓存只解决翻页。
- **把计数改便宜**（正则换 `startsWith`、少 `JSON.parse`）：仍是 O(行数) 的一次同步扫描，只是把 62 ms 压到
  三四十毫秒，日志再长一点又回去；没有结构性的保证。
- **交给 worker**：计数要先把 31 MB 的行数组传过去，而分块已经能把停顿压进 10 ms 量级，不满足"分块压不到
  50 ms"这一道门。
- **同一段逻辑写两份**（同步一份、异步一份）：两份实现迟早分叉，`counts` 与 `items` 的口径必须逐字节一致。

## Consequences

- 端点里 `readTranscriptAsync()` 是异步的：`/transcript` 与 `/sync` 的差异端点的错误处理照旧（抛错仍是
  422），但调用点都要 `await`。
- 账跟着行数组走：同一份日志的新数组（文件变了、缓存被挤掉）会重新数，不共享旧账。
- `countTranscriptAsync()` 每 2048 行让出一次；测试里钉住"超过一块必须已经让出过"，并核两个入口的
  结果逐字段相同。
