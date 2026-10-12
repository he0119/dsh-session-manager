# 开发

安装与用法看 [README](../README.md)，决策的依据看 [.agents/notes/](../.agents/notes/AGENTS.md)
（[internals.md](internals.md) 是按主题的索引），发版流程看 [releasing.md](releasing.md)。

## 依赖、构建、测试

运行期依赖分两类：npm 依赖只有 `fzstd`（纯 JS 的多帧 zstd 解码器）；其余都是**宿主提供**的 peer
——`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-client-ui-primitives`，两个 DSH
peer 写成 `^0.2.0-rc.1` 这一代的范围（`@deepseek-ai/cordis` 按自己那条线写 `^4.0.4`），
`devDependencies` 里带着同代副本供构建与测试使用。`engines.dsh`、两个 DSH peer、两个同名
`devDependency` 写的是同一条范围，而宿主只认 peer 那两处，改版本时别漏（`test/manifest.test.mjs` 会核）。

另有两只是**只用于类型**的 devDependency：`@deepseek-ai/dsh-client-ui-slots` 与
`@deepseek-ai/dsh-client-locale`——字典与键集按官方类型写（`LocaleDictOf` / `LocaleNamespaceMap` /
`CommonKey`）。两处都只写 `import type`，`verbatimModuleSyntax` 下会被完全擦除：产物里一个 `require`
都不会多，`dsh.client.external` 也不必加条目（见
[决策](../.agents/notes/implemented/architecture/2026-10-05-client-copy-follows-the-official-locale-mechanism.md)）。

```sh
pnpm install          # 或 npm install（本机请用 npm，见「本机安装」）
pnpm run build        # tsdown：三份配置 -> lib/index.js + lib/types/*.d.ts + lib/client.js
pnpm test             # = node test/run-all.mjs
pnpm run typecheck    # Host 与 Web Client 两个工程：tsconfig.test.json + tsconfig.client.json
pnpm run check        # typecheck + test
pnpm run check:package # 打包内容自检（要先 build，见 docs/releasing.md）
```

单边重建：`pnpm run build:host` / `build:types` / `build:client`（三份配置共用 `lib/`，
所以单独重建一端不会删掉另一端）。

`pnpm install` 之前会先过一遍 pnpm 11 的供应链策略：发布不满 24 小时的版本默认不许进安装结果，连
`--frozen-lockfile` 也会逐条验锁文件并失败（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，CI 上就是
这个）。跟着上游换 rc 线时因此要在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里把那一代逐条
放行；条目精确到版本，过了窗口就能整段删掉。

带真实数据回归（指向任一含会话项目目录的 `sessions/` 备份目录）：

```sh
DSM_FIXTURE=/path/to/backup pnpm test
```

没设 `DSM_FIXTURE` 时，`test/real-data.test.ts` 会整组跳过——它是 runner 里默认跳过的两条之一，
另一条是下面那条 `DSM_SMOKE_WORKSPACE`（所以全绿口径是 522 条里 520 通过、2 跳过）。

### 版本声明自检（`test/manifest.test.mjs`）

`engines.dsh`、两个 DSH peer 与两个同名 `devDependency` 是同一个代次的三个副本，**门只认 peer
那两处**：宿主（`dsh-app-boot` 的 `evaluatePluginCompatibility`）按 peer 范围判运行中的版本收不收得下，
收不下就整条 bundle 不装（日志里一行 `skipping profile bundle …`，插件自己的 `apply` 根本没跑）。
所以这一个文件核"三处写的是同一条范围"与"这条范围收得下 `node_modules` 里装到的那一代"。

### 构建产物冒烟（`test/artifact.test.mjs`）

其余测试都直接 import `src/*.ts`，所以**「源码通过」不等于「产物能装进宿主」**。
`test/artifact.test.mjs` 加载 `lib/index.js`（`package.json` 的 `main`），断言：

- 入口自描述字段与 `cordis.patch.yml` / `inject` 一致（`name`、`inject: ['tools']`）
- 能注册出 5 个工具，且 `parameters` / `output.render` 形状符合宿主契约
- `apply()` 返回**单个**卸载函数（Cordis 契约：不是 disposer 数组），调用后不抛

它写成 `.mjs` 而非 `.ts`：要加载 `lib/` 里的产物，用 `.ts` 会让 `tsc` 去解析产物路径。
产物不存在时整组跳过，所以源码开发不必先构建；`pnpm run build && pnpm test` 才是全绿口径。

真实数据那一条额外用环境变量门控（同样默认跳过）：

```sh
DSM_SMOKE_WORKSPACE=/path/to/a/real/workspace pnpm test
```

它会在这个目录上跑一次只读 `plan`，并断言计划自己算出的 `targetProjectDir` 目录**没有被创建**
——把「只读」从口头承诺变成可断言的事实。目标项目目录名取自计划返回值，不硬编码。

### 本机安装（Windows 沙箱下的实测结论）

pnpm 的 isolated 布局在本机**不可用**：它生成的 junction 目标畸形
（`Global\C:\…`，`fs.realpathSync` 也解析不出来），于是运行时报

```
Cannot find package '@deepseek-ai/cosmokit' imported from …/cordis/lib/index.js
```

尽管 `.pnpm/…/node_modules` 下确实链接了它。`pnpm-workspace.yaml` 里写了
`node-linker: hoisted` 想改成扁平真实目录，但**本机 pnpm 会忽略它**
（`pnpm config get node-linker` → `undefined`，在一个只放 `.npmrc` 的干净临时目录里也一样）。
所以这台机器上请用 npm，它天生是 hoisted 的真实目录：

```sh
npm install --no-package-lock --no-audit --no-fund --cache ./.npm-cache
```

`--no-package-lock`：本仓库的锁文件是 `pnpm-lock.yaml`，不要让 npm 另写一份。
`--cache ./.npm-cache`：**沙箱下必需**。npm 默认把缓存与日志写到
`%LOCALAPPDATA%\npm-cache`，那在工作区之外，会被沙箱拒绝：

```
npm error The operation was rejected by your operating system
Log files were not written due to an error writing to the directory: C:\Users\…\npm-cache\_logs
```

把缓存重定向进工作区即可（`.npm-cache/` 已在 `.gitignore` 里）。
Linux/CI 上 symlink 正常，用 `pnpm install` 走 `pnpm-lock.yaml` 即可。

### 为什么测试不用 `node --test`

`node --test` 会为**每个测试文件** spawn 一个子进程（piped stdio）。在 DSH 的 Windows 沙箱下，
子进程无法通过命名管道捕获输出，于是必然 `spawn EPERM`——**与测试内容无关**。

`test/run-all.mjs` 在同进程内依次 `import` 各测试文件：`node:test` 在直接运行该模块时同样会注册并
执行用例，只是不再经过子进程隔离。代价是某个文件抛错会影响同进程的其它文件，因此 runner 对每个文件
单独 try/catch 汇总。

`pnpm run test:runner`（即 `node --test`）保留给不受此限制的环境；CI 上跑的是 `pnpm test`。

### 工具层测试怎么拿到真实的 `dsh-tools`

`@deepseek-ai/dsh-tools` 是宿主的 peer 依赖，但仓库把它**同时列为 devDependency**，所以装了依赖之后
`src/tools.ts` 的 `import '@deepseek-ai/dsh-tools'` 直接解析得到真实实现——`test/tools.test.ts`
因此能断言真正的工具注册契约（schema 归一化、实参校验、render），而不是走桩。

## 结构

```
src/            手写源码（每个文件一个职责，核心层零 DSH 依赖；逐文件见下表）
src/client/     浏览器半侧 → lib/client.js：入口 index.ts、纯逻辑 logic/、渲染 components/，
                根下是端点调用、宿主服务接缝与样式
lib/            构建产物（tsdown 输出，已 gitignore）
locale/         插件展示元信息：meta.title / meta.description，en.json 是宿主的发现入口
test/           测试（run-all.mjs 是进程内 runner）
docs/           本目录
AGENTS.md       给 AI 助手与贡献者的协作约定（提交信息口径、验证清单、界面硬约束）
tsdown.config.ts 三份构建配置：host（lib/index.js）、types（lib/types/*.d.ts）、client（lib/client.js，
                平台基线模块 react / react-jsx-runtime / dsh-client-ui-primitives 保持 require，其余内联）
cordis.patch.yml 插件注册（package.json 的 dsh.bundle.patch 指向它）
tsconfig.client.json Web Client 自己的类型工程（DOM + JSX；Host 那份没有）
```

| 源文件 | 职责 | DSH 依赖 |
|---|---|---|
| `src/project-key.ts` | 逐字符复刻宿主 `projectKey()` + 有损碰撞检测 | 无 |
| `src/canonical-path.ts` | 落地目录的规范拼写（`canonicalDir()`：宿主存工作区 `path` 与会话 `cwd` 用的同一个 realpath），落地那条路上唯一的归一入口；`canonicalDirIfExists()` 是它的"解析不出来就是结论"版本（宿主建成员索引用的那一支） | 无 |
| `src/accounting.ts` | 「这条会话被哪个工作区**认领**」的唯一一份判据（宿主 `Workspace.sessionIds` 的口径：登记过 **且** header 的 cwd 归一到那条记录的 `path`）；`/state` 与迁移计划都读它 | 无 |
| `src/types.ts` | 贯穿各层的共享类型（计划、产物、注册表视图等） | 无 |
| `src/paths.ts` | `encodeSegment()`、代次文件名、会话目录/日志路径 | 无 |
| `src/zstd-frame.ts` | raw 帧编码、首帧边界定位、多帧感知守卫 | 无 |
| `src/session-log.ts` | 单日志读取与**保结构** cwd 改写 | 无 |
| `src/registry.ts` | 注册表启动不变式校验、`reHome()`、原子落盘 | 无 |
| `src/discovery.ts` | 项目目录扫描 + 只解首帧读 header（发现阶段快），可注入标题读取器 | 无 |
| `src/projection-cache.ts` | 读宿主投影缓存的单条记录（标题、`blank` 等列表元数据） | 无 |
| `src/session-title.ts` | 会话名称：宿主投影缓存优先，缺席时有界地解日志开头 | 无 |
| `src/visibility.ts` | 侧边栏可见性与「未分组」判据：子智能体 / 空白 / 已归档三条理由（候选与界面共用一份）、`isUngrouped()`＝没认领（`accounting.ts`）**且** 会显示 | 无 |
| `src/family.ts` | **族**的展开（点名一条会话 → 它自己 + 全部子智能体后代）与「单独点名的子智能体」判据（`loneSubagents()`），删除 / 迁移 / 归档 / 导出共用 | 无 |
| `src/plan.ts` | 只读计划：源是**点名的那些会话**（`sessionIds`，每条按自己的 `cwd` 算，所以可以跨目录）、目标推导、阻塞问题、注册表变更（隐藏的会话逐个点名拒绝，点中的那些再向下展开整族；宿主持着的进 `liveSkipped`，按来源目录分组算产物） | 无 |
| `src/journal.ts` | 字节级备份清单与回滚（迁移与删除两种来源） | 无 |
| `src/execute.ts` | 执行 + 独立复核（含产物目标位校验） | 无 |
| `src/artifacts.ts` | 会话产物提取（证据分层）、规划（求交/剪枝）、搬迁 | 无 |
| `src/attachments.ts` | 附件对象（日志里那个 `attachmentId` 指向的字节）：日志逐行扫引用（字符串预筛 + 解析）、按 `kind:id` 去重、读写宿主附件库的**纯路径端口** `AttachmentPort`（`pathOf()` 只算路径，读与写都在这里）、对象落地的 `.part` + rename 与 `0o400` 规格 | 无 |
| `src/transfer.ts` | `.dshsess` 容器（导出/解析/校验，格式 v2：日志之外还带一段**附件对象**，读的时候 1 与 2 都认）、导入预演与落地（**先落对象再写日志**，对象落不了只回报不拦会话） | 无 |
| `src/config.ts` | 插件配置的 schema：`sync` 那一节带 `volatile`（活字段，改完不用重启），三个路径字段不带；`syncSection()` 把"活引用"与"普通对象"两种来路收成一份值；自动推送那一节的拍平在 `autoPushSection()` 一处（开关只认 `autoPush === true`，间隔缺席 / 非有限数取 `DEFAULT_AUTO_PUSH_INTERVAL_MS`（300000）、小于 `MIN_AUTO_PUSH_INTERVAL_MS`（60000）的抬到下限），它也是这几个数唯一的解释处 | `@deepseek-ai/schemastery` |
| `src/repo.ts` | 跨机器的项目身份：git remote 规范化（`host/owner/repo`，去掉 `.git` 与凭据、端口进身份）与"这条目录属于哪个仓库"（仓库根 + 仓库内相对路径）；跑 git 的入口可注入。`createRepoLookup()` 是界面读身份那条路（进程内缓存：一个目录只问一次 git，`/state` 是热路径） | 无 |
| `src/dav.ts` | WebDAV 客户端：PROPFIND / GET / PUT / MKCOL + Basic 鉴权 + 多状态响应解析 | 无 |
| `src/sync.ts` | WebDAV 同步编排：远端索引、映射、计划（四种关系 + 空白与「谁更新」）、拉取 / 覆盖本机那份 / 推送（都复用 transfer 的导入落地）；界面那条路把计划与它的输入一起留下（`prepareSync()` 的 `SyncPrepared`，确认时 `syncPrepared()` 照它落地、只在数据变了时重算），`runSync()` 是单次调用那条；整批拉取改完注册表之后收口调一次 `src/take-effect.ts`，再调一次 `src/checkpoint-warm.ts`。**自动推送**（只推不拉）也在这里：`narrowToPushOnly()` 是计划层唯一的改判处（拉取整表与 `pullIds` 清空、`bytesIn` 归零、推送表里把"远端更新 / 两边各自写过"那些 `skip` 摘出去，只留 `upload` / `update` / `identical`）；`runAutoPush()` 判定顺序是没开 → 距上次真跑不到间隔 → 算一份只推的计划 → 一条都推不动且索引也没得收尾就报 `idle`（不落地），否则 `applyPreparedSync()` 落地（没得推也落一次空计划，把本机那格索引收窄成眼下的库）；`AutoPushOutcome` / `AutoPushSkip` 是这一轮的结论与没跑的原因（`AutoPushSkip` 只有 `disabled` / `interval` / `busy` / `idle` 四个码，**没有**"正在攒连发"那种：静默窗口只推迟推送，不会让谁问出"没跑"）；`createAutoPushTimer()` 是节拍器，**只按最小粒度醒、每次醒来现读配置**（`AutoPushClock`，开关与间隔是活字段），一次只放一轮（`busy`），它同时收着事件层那个触发口 `touched()`——收到 `turn/end` 之后调一下，起/续 `AUTO_PUSH_SETTLE_MS`（10000）那个静默窗口，窗口里再来事件就重置计时，所以一轮里连发的多个 `turn/end` 只推一次；窗口到点那一轮带 `force` 绕开速度闸，真正在跑时再来事件只记一笔欠账、跑完立刻补一次，关着时什么都不做（不排队、不记账） | 无 |
| `src/migrate.ts` | 迁移编排：预演 / 执行 / 回滚 / 备份清单（工具与界面两个入口共用）；写盘之后交 `src/take-effect.ts` 把改动交给宿主自己做、`src/checkpoint-warm.ts` 补上被改写 cwd 那几条的检查点，并拿备份与落盘结果复核「会话 id 不变」 | 无 |
| `src/take-effect.ts` | 「改完注册表之后让宿主立刻认下这处改动」的共用一步：迁移与导入 / 同步拉取都调它（回滚不走——它整份写回文件以保住工作区 id）；探测端口、执行顺序、宿主没接住时把算好的注册表整份写回（`restoreRegistry()`）、以及"要不要重启"的措辞只写在这里，**执行时机**留给各自编排层（批量落地时收口一次） | 无 |
| `src/checkpoint-warm.ts` | 「落地之后请宿主把这批会话的列表元数据折出来」的共用一步：宿主的侧边栏标题不来自日志，只认它自己写的投影检查点，而检查点只在活着的会话上被写；这里借宿主自己的两个服务（`sessionQuery.readSession()` + `sessionProjectionCache.coldSnapshot()`）冷读一遍补上，逐条兜住失败（导入 / 同步拉取 / 迁移三个落地口共用） | 无 |
| `src/remove.ts` | 删除编排：预演（活着的拒删、单独点名子智能体拒掉；点名一条就按 `family.ts` 把它的**全部子智能体**一起展开）→ 先备份 → 删目录 → 复核；不碰注册表 | 无 |
| `src/transcript.ts` | 会话日志的解析：把事件行折成"能从头读到尾的完整时间线"（一条事件一条条目、工具调用只算一次、工具名按 `callId` 从调用那条补到结果那条、助手的思考与正文分格）。**上限与分页是它的职责**：单格文本与整页文本总量都有上限，被截的地方记下原长度（界面据此给「查看全文」），`from` / `limit` 按**事件位**分页（日志里的 `seq` 会跳号，拿它当游标会漏条），整份日志的计数只扫行头（不解析正文，大库上是几百 MB）。纯字符串/JSON，没有 DSH 依赖（浏览器侧只取它的类型） | 无 |
| `src/retitle.ts` | 重新生成名称的编排：逐条判定"该不该动它"（子智能体、不在库里的按 `not-found` 跳过）→ 交给 `TitleRefreshPort` → 按四类收（改了 / 算过没变 / 跳过附原因 / 失败附原话）；顺序执行并逐条报进度（每条都要整份解一次日志再跑一次模型调用，不并发） | 无 |
| `src/tools.ts` | 5 个工具注册（+ schema、平台解码器实例、可选服务探测（含 `hostRegistryPort()`、`hostCheckpointPort()` 与 `attachmentPort()`：把宿主的注册表实体 API、会话持久化、冷读一条会话并写回投影检查点、以及附件库那两个纯路径方法收成端口，以及 `titleRefreshPort()`：把"重算一条会话的标题"收成端口——见 `src/retitle.ts`）、同步配置与运行时）——`describeSyncConfig()` 报的 `SyncInfo` 里那栏 `autoPush` 只带**间隔毫秒**（没开就整个缺席，界面据此在卡片头下面补一句话），`syncRuntime()` 把它拍进 `SyncSettings`；`resolveAutoPushRuntime()` 是全仓**唯一一份**自动推送接线（造 `SyncDeps` 时带 `pushOnly: true` 与 `progressWhat: 'auto-push'`，`src/index.ts` 与 `/auto-push` 端点都用它），"上一次真跑"与"连续失败几次"两份状态留在它造的节拍器闭包里——每个宿主只造一个，不能每次请求现造；`attachAutoPushToSessions()` 是事件那一层：`ctx.on('session/event', …)` 只认 `turn/end`（`step/end` 太密、`session/created` 还没内容），收到先 `await sessions.flush(session)`（`turn/end` 不保证落盘，而推送读磁盘字节）再 `timer.touched()`，`flush` 失败吞掉只记一笔（它只决定这次读得到多新，照旧推、下轮或兜底会补），返回卸载函数；`sessions` 按**可选服务**收（`optionalService()`，不进 `inject`：没有会话服务的 profile 照旧只有工具，拿不到就返回空卸载函数、事件层缺席而兜底定时器仍在） | `dsh-tools` |
| `src/web.ts` | 界面端点（meta / state / transcript / export / import / sync / auto-push / migrate / backups / rollback / delete / archive / retitle），只要求 `{ register }` 形状；`GET /meta` 只答会话库位置与宿主能力位（不扫库），`GET /state` 是它的超集，另报一栏 `repos`（目录 → 项目身份，注入的入口认，见 `src/repo.ts`）；`GET /state` 与 `/sync`（预演与落地）、`/migrate`、`/delete`、`/rollback`、`/import`、`/archive`、`/retitle`（正文带 `includePinned: true` 时连 `user` 源的标题一起重算——那是给一次性清理留的口子，界面不传这个字段）都回 SSE（`streamResult()`：`progress` 逐条、`result` 收尾，见 [决策](../.agents/notes/implemented/architecture/2026-10-08-every-long-action-streams-progress.md)）；`GET /meta`、`GET /backups`、`/export` 与 `GET /transcript`（一条会话的完整内容：只读、按事件位分页、一次读一份最高代次的日志）是一次性响应（`/export` 的响应体就是产物本身，附件对象的条数 / 字节 / 本机缺的那几个报在 `x-dsh-attachment-*` 响应头里）。`GET /auto-push` 是自动推送那一枚「立即推送一次」：**两种形状**——没配同步或这个宿主没有节拍器（`deps.autoPush` 缺席）时是写头之前的 JSON + 409，其余时候当场跑一轮（`tick({ force: true })`，绕过最小间隔那道闸）并按 `/sync` 同一套回 SSE（事件带 `what: 'auto-push'`，`result` 是 `mode: 'auto-push'` + 那个 `AutoPushOutcome`，真跑过才把 `plan` / `pulled` / `pushed` / `bytesIn` / `bytesOut` / `problems` 那几项摊平，与 `/sync` 的 `payloadOf()` 同形）；这条路只推不拉、没有确认那一步，所以没有 `mode=apply` 那种分岔，也没有 `enable` / `disable`——开关只走配置表单 | 无 |
| `src/client/logic/*` | **零 DOM 的纯逻辑**，Host 侧的 `test/*.ts` 能直接引（`exclude` 只挡自动包含，import 一样会把它拉进来）：`groups.ts` 是列表的组织规则（按目录分组、组内把子智能体缩进到父会话下一级）、`sessionFilter.ts` 是背后的筛选与搜索判据、`planRows.ts` 是"一行 / 一格怎么写"（cwd 那一格、会话名，以及一个目录怎么称呼——`projectLabel()` / `pathLabel()` / `repoHost()`：组头只摆名字 + 一枚主机名标签、项目身份与本机路径进悬浮提示，下拉框里两者都摆进文本）、`syncGroups.ts` 是同步预演那三张表按项目目录分组的规则、`syncForm.ts` 是同步设置的读写面（宿主设置接缝 `configForms`）与映射草稿的解析（草稿里也收着自动推送那两栏：勾选写 `sync.autoPush`、间隔写 `sync.autoPushIntervalMs`，间隔填了但不是正整数就算一处 `autoPushIntervalNotPositive`，小于 60000 的照收——core 会抬到下限；`autoPushMinutes()` 把 `SyncInfo.autoPush` 报来的毫秒折成那句话里的分钟数）、`autoPush.ts` 是自动推送"没跑"的原因码在**界面这一侧的运行期清单**（`AUTO_PUSH_SKIP_CODES`，与 `src/sync.ts` 的 `AutoPushSkip` 是同一套名字——联合类型编译之后就没了，而界面要按码去字典里挑 `sync.autoPush.skip.<码>` 那句句子，所以这份清单是必需的；加一个码要四处一起改：core 的联合、这里、中英两份字典，这条链路上没有编译期保护，`test/sync-form.test.ts` 是唯一那道闸）、`eventStream.ts` 是长动作事件流的分帧与解释（纯字符串处理、与 DOM 无关，同步与其它动作共用）、`transcriptScroll.ts` 是会话内容视图"什么时候去接下一页"那一条判断（贴底就接，撑不满一屏也算贴底；正文那一层滚到底与读完每一页的复查共用它）、`transcriptTurns.ts` 是那份时间线按轮次切节的规则（边界取自日志自己的 `turn/start` / `turn/end`，不按 `turn` 字段是否相等——大多数事件不带那个字段；不属于任何一轮的会话级事件自己一节、不折）、`retitleNotes.ts` 是「重新生成名称」那一次动作该说的几句话（改了 / 算过没变 / 跳过按原因合并计数，不认识的原因退回一句通用的话）、`locales.ts` 是页面文案：中英两份字典注册进客户端 `locale` 服务，键名点分，命名空间按官方的 `LocaleNamespaceMap` 登记（`en` 由 `LocaleDictOf` 逐键核，取消 / 关闭 / 保存复用宿主 `common`，见 [决策](../.agents/notes/implemented/architecture/2026-10-05-client-copy-follows-the-official-locale-mechanism.md)） | 无 |
| `src/client/components/*` | 渲染路径（`.tsx`）：`ManagerPanel.tsx` 是「会话管理」页的骨架（页内「会话 / 传输 / 同步 / 备份 / 说明」五个分页）、`ManagePanel.tsx` / `TransferPanel.tsx` / `SyncPanel.tsx` / `BackupPanel.tsx` 是那四个动作页（`ManagePanel.tsx` 里那张动作行挂着归档 / 取消归档 / 重新生成名称 / 迁移 / 删除，**迁移那一路也在这个文件里**：目标目录字段、预演与落地都在它自己的确认弹窗中，没有单独的迁移分页）（`SyncPanel.tsx` 是「同步」分页：同步按钮、三张按项目分组的计划表（会话名后面复用 `sessionList.tsx` 的类型标签）、按 phase 说话的进度块（见 `ProgressBlock.tsx`）；`BackupPanel.tsx` 是「备份」分页：迁移 / 删除 / 同步覆盖留下的那份清单与回滚、恢复）、`sessionList.tsx` 是「会话」与「传输」共用的列表骨架（行、组头、列表框、筛选条）、`ConfirmDialog.tsx` 是动作页共用的确认弹窗外壳（官方 `Modal` + 标题/正文/底部按钮，计划由调用方取）、`TranscriptDialog.tsx` 是会话页的**内容视图**（官方 `Modal` 里摆完整时间线：按种类筛选、按轮次分节且节标题点一下就折起来、筛选那一行贴顶、页头右端写着画面正中那一条的位次与总数、滚到贴底自己往下接、「查看全文」把被截断的那一格取回来）、`ProgressBar.tsx` 是那条 6px 进度条的轨道与填充（分母为 0 的那一段不画）、`ProgressBlock.tsx` 是六个动作共用的进度块（进度条 + 按 phase 选的那句话 + 当前那一条 + 调用方给的那句「中断了怎么办」，分母为 0 的段落只说话不画条）、`SyncConfigForm.tsx` 是同步设置那张表单（自动推送那两栏摆在「超时（毫秒）」之后：一个复选框 + 一个数字输入，保存走下面 `syncForm.ts` 那两条路径）、`DirectoryPicker.tsx` 是页面内的目录浏览框、`CandidatePanel.tsx` 是目录字段那份候选项列表（与浏览框同一套皮，两边互相切）、`DirectoryField.tsx` 是那枚目录值控件（值 +「手输路径」+ 上面那两份列表，迁移的目标与导入的落地目录共用它，展开状态由 `useDirectoryFields()` 交给页面持有，所以一页里同一时刻只有一个面板开着）、`HelpPanel.tsx` 是那个不碰数据的说明页、`icons.tsx` 是内联的两个轮廓图标 | 无 |
| `src/client/*.ts` | 根下：`index.ts` 是入口（注册 `settings.section`、装样式、把页面与接缝接起来）、`api.ts` 是界面端点调用（meta / state / transcript / export / import / sync / migrate / backups / rollback / delete / archive / retitle，那些长动作按 `content-type` 分流走 `readEventStream()` 读流、其余一次性 JSON）、`credentials.ts` 是宿主机凭据服务（`remote.credentials`）的持有处、`directory.ts` 是宿主目录选择服务的持有处（可选依赖，`native` / `browse` 两种能力，界面按宿主报来的 `pickerKind` 选一种）、`types.ts` 是端点响应的类型面、`styles.ts` 是样式表正文与注入（`installStyles`） | 无 |
| `src/index.ts` | 插件入口 `apply(ctx, config)`：注册工具与设置页、把 web 路由接上；**自动推送的节拍器也在这里造一次**（`resolveAutoPushRuntime()`，挂在插件生命周期上，同一个实例交给界面看状态、也给它当场跑一轮）。事件层的监听与节拍器**挂在同一个 promise 上**（凭据与配置要先解析完才作得成，而 `turn/end` 可能来得更早：先拿着 promise、到位再接监听——接晚了不丢那一轮，后面还有兜底的定时器），卸载时**先摘监听、再停表**（摘晚了会有事件在 `stop()` 之后进来） | `dsh-tools` |

核心层（`project-key` / `canonical-path` / `paths` / `zstd-frame` / `session-log` / `discovery` /
`projection-cache` / `session-title` / `visibility` / `registry` / `plan` / `journal` / `execute` /
`artifacts` / `attachments` / `transfer` / `dav` / `sync` / `migrate` / `remove` / `retitle`）**不依赖 DSH**，
所以插件外壳与测试共用同一段代码。只有 `src/tools.ts` 与 `src/index.ts` 依赖
`@deepseek-ai/dsh-tools`，`src/web.ts` 连它也不依赖（只认一个 `{ register }` 形状）。`src/config.ts` 依赖
`@deepseek-ai/schemastery`（schema 与 volatile 语义来自它），但不依赖插件外壳。

`src/client/**` 不在 Host 端那份 tsconfig 的 include 里：它要 DOM 与 JSX，而 Host 侧没有。
那条边界是有意的——「浏览器 API 出现在 Host 代码里」在类型层面就不成立。

`lib/` 是产物不是源：改代码改 `src/`，`pnpm run build` 重新生成；`lib/` 不进 git。

### tsconfig 上的一处刻意偏离

`noUncheckedIndexedAccess` 关掉了（`tsconfig.json` 里有注释说明）。本项目大量代码是
「按已知长度切 buffer / 按已知形状读 JSON 字段」，开启后会在几十处纯噪音的位置要求非空断言，
反而掩盖真正需要检查的 `undefined`。其余 strict 家族全开。

## 装进一个 profile

用宿主自己的插件命令，不要手写安装器：

```sh
pnpm run build                                    # 产物必须先存在（插件入口指向 lib/index.js）
npx @deepseek-ai/dsh@next plugin --profile <name> add <本目录>
# 然后重启 DSH
```

它负责把包放进 `node_modules`、把包名写进 `dsh.profile.bundles`，并维护依赖与锁文件。
这层「安装」是宿主的职责，自己实现一份只会跟着宿主布局漂移：要么漏掉构建（新克隆的仓库
`lib/` 不存在，入口直接指向空气），要么绕过 `package.json` 的 `files` 白名单把 `src/`、`test/`
整个塞进 profile，而且没有卸载路径。所以本仓库不提供安装脚本。

`DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_HOME` 是宿主真实提供的环境变量，需要时可直接用。

不要用日常在用的实例做开发验证：照 [README](../README.md) 的方式另建一个开发 profile
（`dsh <name>` 就是 `dsh --profile <name>`），在另一个端口上起它。Host 端改动必须**重启**才生效。

## 改动后至少跑什么

```sh
pnpm run check        # 类型 + 测试
pnpm run build        # 确认产物能出来（构建不做类型检查，所以两件事都要做）
pnpm run check:package # 确认打包内容与入口自洽（依赖上一步的产物）
```

涉及工具契约的改动，另外跑 `test/tools.test.ts` 那组；涉及帧/压缩的改动，
`test/zstd-frame.test.ts` 里有一条专门的回归防线（`assertMultiFrameAware`
拒绝「只解首帧」的解码器——这正是当初造成数据截断的那个坑）。
