# Agent Note: 迁移、差异与导出不再整份解压 / 压缩日志

Status: implemented

## Problem

宿主是单进程单线程：任何一段同步 CPU 都会让页面的请求、长连接与工具调用排队。按"最大的一份日志"
（压缩后 16.8 MB、解开 48 MB）在本机实测，几条主要长任务各自都有一段按秒计的同步计算：

| 操作 | 同步耗时（单条 16.8 MB 日志） | 原因 |
| --- | --- | --- |
| 迁移改写 | **9.9 秒 / 文件** | `relocateHeaderCwd()` 整份解压、按行重排、再把结果整份解一遍自校验；改完 `applyPlan` 又整份解两遍做落盘复验 |
| 迁移复核 | 1.8 秒 / 文件 | `verifyAppliedPlan()` 为了读 header 解整份日志 |
| 差异页 | 3.1 秒 | 两边日志各 `decodeAll()` 整份解一次 |
| 导出（40 条 / 52 MB） | 1.1 秒，整库导出约 30 秒 | `gzipSync()` 在压缩整包；附件扫描还逐条整份解日志 |
| 拉取（另一台机器的 cwd） | 3.2 秒 / 文件 | `relocateSessionPaths()` 整份解压改写、再把新缓冲整份解一遍自校验 |
| 备份 / 删除（1.2 GB 库） | 0.78 秒 | `cpSync()` 递归复制 |

迁移这一条尤其不合比例：它要改的只有 header 的那一行，却按整份日志的代价付了四次解码。

## Decision

- **迁移改写只解首帧**：`applyPlan()` 改用 `relocateHeaderCwdShallow()`（首帧之外逐字节原样拼回），
  落盘复验改成 `readLogHeader()` 只读 header；`verifyAppliedPlan()` 同样只读 header。实测 9.9 秒 →
  **23 毫秒**（含读文件、写临时文件、复验、rename）。`test/engine.test.ts` 有一条守卫：把送进
  `decodeAll` 的最大一段钉住（超过 64 KB 就红）。
- **差异页分块解压**：`sync-diff` 两边都走 `decodeLogTextChunked()`（128 KB 一块、块间让出）。总耗时
  从 1.6 秒升到 2.9 秒（块间让出的代价），但最长一次停顿从 1.6 秒降到 **110 毫秒**。
- **导出走异步**：新增 `buildBundleAsync()`，读文件走 `fs/promises`、附件扫描走分块解压、最后那次
  gzip 走线程池的 `zlib.gzip`。导出端点与同步推送改用它；`buildBundle()` 留着给测试与小包，两份产物
  逐字节相同（`test/transfer.test.ts` 有等价断言）。40 条 / 52 MB：1.1 秒一次按住 → 1.6 秒但最长
  停顿 **36 毫秒**。
- **路径改写按帧自校验**：`relocateSessionPaths()` 改完不再把整份新缓冲解一遍（16 MB 压缩、48 MB
  文本，1.8 秒），改成"改过的那一帧当场解回比对 + 逐帧文本拼起来等于整份改写结果"。单文件
  4.2 秒 → 3.1 秒；剩下那一次整份解码是改写本身需要的。
- **拉取 / 导入的路径改写走分块**：新增 `relocateSessionPathsChunked()`（整份文本分块解压、帧与帧之间
  让出），`applyImport()` 跟着返回 Promise。16.8 MB 的会话：同步 3.2 秒一次按住 → 4.6 秒总耗时、
  最长一次停顿 **189 毫秒**。
- **备份 / 删除 / 回滚的复制走异步**：`createBackup()` / `rollback()` 换 `fs.promises.cp` / `rm`，
  `applyPlan()` 与 `runRemoval()` 跟着返回 Promise。整库 1.2 GB 备份：原来 0.78 秒一次按住 →
  3.9 秒但最长停顿 **12 毫秒**（`fs.promises.cp` 在线程池里逐文件拷）。
- **整库导出不再先拼一整块**：`bundleBytes()` 的 `Buffer.concat` 会把 1.2 GB 再拷一份（372 MB
  实测 153 毫秒），现在逐段写进 gzip 流、只拼压缩后的输出（372 MB 导出最长停顿 153 毫秒 → 14 毫秒）。
- **改名自检分帧分块**：`branchSessionLog()` 原来把改写后的整份日志解一遍再逐行 `JSON.parse`（16.8 MB
  约 3.5 秒），现在逐帧解码、逐段校验，最长停顿 142 毫秒。
- **迁移勾选产物时分块读日志**：`buildRelocationPlan()` 改为异步、逐文件分块解压，16.8 MB 会话的
  产物定位总耗时 2.7 秒、最长停顿 153 毫秒。
- **路径修复工具走分块**：`planPathRepair()` / `applyPathRepair()` 改成异步分块读日志、异步写临时文件，
  备份复制走 `fs.promises.cp`。16.8 MB 会话的预演：1.8 秒一次按住 → 1.8 秒总耗时、最长一次停顿
  **122 毫秒**；落地里的改写与复验也走同一套分块。
- **扫库记住首帧**：`readLogHeaderForScan()` 按 `size:mtimeMs` 缓存每个日志首帧解出来的 header，
  只给扫描用（写盘路径仍走 `readLogHeader()` 现读）。另加 git 式 racy 规则：记录不足 1 秒的条目不
  信任。整库 1475 个文件：冷扫 0.8 秒 → 库没大改时 **40 毫秒**。
- **导出 / 归档 / 重算名称的发现阶段走缓存扫描**：三处原先直接调同步的 `scanAll()`，整库冷扫
  1 秒以上、每次动作都重扫一遍，而且这一整段没有让出事件循环。改用 `createScanCache().scanAsync()`
  （库没变时直接交上一次的结果，项目目录之间让出）；重算名称那一路带标题，导出与归档不带，
  两套选项各自缓存，库变了都会重扫。

- **导入 / 拉取的大包异步解、异步写**：导入与同步拉取改用 `readBundleAsync()`；导入预演先用
  `bundleTitlesAsync()` 每几条让出一次，再交给 `planImport()`；`applyImport()` 与附件对象提交
  改用 `fs/promises` 的 `mkdir` / `writeFile` / `rename` / `chmod`。几十 MB 的包不再整段按住主线程。
- **日志首次读取与同步差异异步读**：内容视图第一次打开、`/sync-diff` 的两边日志都改用
  `readFile()` / `readBundleAsync()`；后面的分块解码本来就会让出。
- **指纹与附件引用先异步读**：`contentFingerprintChunked()` 与 `attachmentRefsOfFile()` 的整份
  `readFileSync()` 改成 `await readFile()`，哈希与解码仍按块让出。
- **迁移落地与产物复制异步写**：`applyPlan()` 的逐文件读、临时文件写、改名、建目录 / 清空目录，
  以及 `applyArtifactMovesAsync()` 的同卷 rename / 跨卷 copy，都改走 `fs/promises`。
- **扫库在项目目录内部也按会话让出**：`scanProjectDirAsync()` 每 16 条让出一次；`scanAllAsync()`
  不再等整个项目目录读完。

## Alternatives considered

- **把 applyPlan / applyImport 整条改成异步**：能让 `cpSync` 与整份解码都走线程池，但要把
  `migrate.ts`、工具层与十几处测试一起改成 async，收益主要在"备份复制 1.4 秒"这一项；先把按秒计的
  解码去掉，代价小得多。
- **worker 线程跑整份改写**：数据要跨线程拷一份（几十 MB），还要把 `decodeAll` / 附件端口搬过去，
  复杂度高于收益。
- **差异页保留整份解压**：3.1 秒的停顿在"点一下就要等"的地方不可接受；多花 1.3 秒换 110 毫秒的
  最长停顿值得。

## Consequences

- 迁移（含复核）不再按日志体积花时间：只与文件数有关，单文件从秒级降到毫秒级。
- 导出的 CPU 花在线程池里，主线程只做分段拼接；整库导出仍然要等，但 DSH 不会被按住。
- 差异页总耗时略增，最长停顿大幅下降。
- 备份、删除、回滚的复制不再按住主线程；整库 1.2 GB 备份总耗时从 0.78 秒升到 3.9 秒，但最长停顿
  从 0.78 秒降到 12 毫秒。
- 所有已知的按秒计主线程阻塞都已处理：迁移（含产物）、差异、导出（含整库）、路径改写、改名自检、
  备份 / 删除 / 回滚、扫库、路径修复、导入 / 拉取、日志首次读取、指纹 / 附件引用。
- 这里说的是"按秒计"的阻塞；小 JSON、单次 `stat` / `rename` 仍走同步，判据见
  [异步化的边界那篇](../architecture/2026-11-17-blocking-budget.md)。
