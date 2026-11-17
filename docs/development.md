# 开发

安装与用法看 [README](../README.md)，决策的依据看 [.agents/notes/](../.agents/notes/AGENTS.md)
（[internals.md](internals.md) 是按主题的索引），界面与样式规格看 [design.md](design.md)，发版流程看
[releasing.md](releasing.md)。

## 依赖、构建、测试

运行期依赖分两类：npm 依赖只有 `fzstd`（纯 JS 的多帧 zstd 解码器）；其余都是**宿主提供**的 peer
——`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-client-ui-primitives`，两个 DSH
peer 写成 `^0.2.0-rc.1` 这一代的范围（`@deepseek-ai/cordis` 按自己那条线写 `^4.0.4`），
`devDependencies` 里带着同代副本供构建与测试使用。`engines.dsh`、两个 DSH peer、两个同名
`devDependency` 写的是同一条范围，而宿主只认 peer 那两处，改版本时别漏（`test/plugin/manifest.test.mjs` 会核）。

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

没设 `DSM_FIXTURE` 时，`test/plugin/real-data.test.ts` 会整组跳过——它是 runner 里默认跳过的两条之一，
另一条是下面那条 `DSM_SMOKE_WORKSPACE`（所以全绿口径是 909 条里 907 通过、2 跳过）。

### 版本声明自检（`test/plugin/manifest.test.mjs`）

`engines.dsh`、两个 DSH peer 与两个同名 `devDependency` 是同一个代次的三个副本，**门只认 peer
那两处**：宿主（`dsh-app-boot` 的 `evaluatePluginCompatibility`）按 peer 范围判运行中的版本收不收得下，
收不下就整条 bundle 不装（日志里一行 `skipping profile bundle …`，插件自己的 `apply` 根本没跑）。
所以这一个文件核"三处写的是同一条范围"与"这条范围收得下 `node_modules` 里装到的那一代"。

### 构建产物冒烟（`test/plugin/artifact.test.mjs`）

其余测试都直接 import `src/**/*.ts`，所以**「源码通过」不等于「产物能装进宿主」**。
`test/plugin/artifact.test.mjs` 加载 `lib/index.js`（`package.json` 的 `main`），断言：

- 入口自描述字段与 `cordis.patch.yml` / `inject` 一致（`name`、`inject: ['tools']`）
- 能注册出 6 个工具，且 `parameters` / `output.render` 形状符合宿主契约
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

`test/run-all.mjs` 递归扫 `test/` 下的子目录（测试与 `src/` 对齐，按操作分文件夹），在同一进程内依次
`import` 各测试文件：`node:test` 在直接运行该模块时同样会注册并执行用例，只是不再经过子进程隔离。
代价是某个文件抛错会影响同进程的其它文件，因此 runner 对每个文件单独 try/catch 汇总。

写盘的测试一律用 `test/fixtures/sandbox.ts` 的 `sandboxDir(名字)` 拿目录（`test/.sandbox/<名字>`，
`.gitignore` 里挡的就是这一个根）：别在自己目录下另起 `.sandbox`，否则几十个目录各留一份，谁也看不出
谁没清干净。

`pnpm run test:runner`（即 `node --test`）保留给不受此限制的环境；CI 上跑的是 `pnpm test`。

### 工具层测试怎么拿到真实的 `dsh-tools`

`@deepseek-ai/dsh-tools` 是宿主的 peer 依赖，但仓库把它**同时列为 devDependency**，所以装了依赖之后
`src/tools.ts` 与各操作的 `tool.ts` 里 `import '@deepseek-ai/dsh-tools'` 直接解析得到真实实现——`test/plugin/tools.test.ts`
因此能断言真正的工具注册契约（schema 归一化、实参校验、render），而不是走桩。

## 结构

目录先按**层**分，再按**操作**分：`src/shared/` 放多个操作共用的零件，`src/operations/<操作>/` 只放那一种操作的编排与它私有的助手；`src/` 根下四个文件是插件外壳（入口、配置、工具、界面端点）。浏览器半侧同一套分法：`src/client/shared/` 是共用件（控件、纯逻辑、钩子、字典），`src/client/operations/<操作>/` 是这个操作自己的弹窗与判据，`src/client/shell/` 是页面骨架。

```
src/                       手写源码（Host 半侧）
├─ index.ts                插件入口 apply()
├─ config.ts               插件配置 schema
├─ tools.ts                6 个工具注册
├─ web.ts                  界面端点
├─ shared/                 多个操作共用的零件
│  ├─ types.ts paths.ts plugin-paths.ts project-key.ts canonical-path.ts registry.ts
│  ├─ accounting.ts visibility.ts family.ts repo.ts attachments.ts journal.ts
│  ├─ log/                 日志的字节、帧与行（含改写）
│  ├─ library/             会话库扫描与它的两级缓存
│  └─ host/                宿主可选服务的探测（ports.ts）与落地后的两步善后
└─ operations/             每种操作一个文件夹
   ├─ migrate/             迁移：计划、执行、产物、编排与四个工具
   ├─ transfer/            导出 / 导入 .dshsess
   ├─ sync/                WebDAV 同步、自动推送与那条工具
   ├─ remove/              删除
   ├─ retitle/             重新生成名称
   ├─ path-repair/         修已经落地的日志路径
   └─ transcript/          会话日志解析（内容视图与差异视图共用）
src/client/                浏览器半侧 → lib/client.js
├─ index.ts plugin.ts navigation.ts build.ts    入口与宿主接缝
├─ api.ts types.ts credentials.ts directory.ts styles.ts
├─ shell/                  页面骨架
├─ shared/                 共用件
│  ├─ ui/                  所有面板共用的控件
│  ├─ logic/               与操作无关的纯逻辑
│  ├─ hooks/               浏览器事件的钩子
│  └─ i18n/                中英两份字典
└─ operations/             每种操作一个文件夹（弹窗 + 它自己的判据）
lib/                       构建产物（tsdown 输出，已 gitignore）
locale/                    插件展示元信息：meta.title / meta.description，en.json 是宿主的发现入口
test/                      测试（run-all.mjs 是进程内 runner）
├─ plugin/                 入口级与门禁：端点、工具、配置、产物、文档检查
├─ shared/                 与 src/shared 对应（含 log/ library/ host/）
├─ operations/             与 src/operations 对应，一个操作一个目录
├─ client/                 浏览器半侧的纯逻辑（shared/logic/ 与 operations/）
└─ fixtures/               共用夹具：DAV 假服务、附件库、sandbox()
docs/                      本目录（formats.md 是落盘格式、design.md 是界面与样式的规格入口）
AGENTS.md                  给 AI 助手与贡献者的协作约定（提交信息口径、验证清单、界面硬约束）
tsdown.config.ts           三份构建配置：host（lib/index.js）、types（lib/types/*.d.ts）、client（lib/client.js，
                           平台基线模块 react / react-jsx-runtime / dsh-client-ui-primitives 保持 require，其余内联）
cordis.patch.yml           插件注册（package.json 的 dsh.bundle.patch 指向它）
tsconfig.client.json       Web Client 自己的类型工程（DOM + JSX；Host 那份没有）
```

### Host 半侧：`src/`

#### 插件外壳（`src/*.ts`）

只有这四份能看到宿主：入口装配、配置 schema、工具注册、界面端点。其余代码一律零 DSH 依赖。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/index.ts` | 插件入口 `apply(ctx, config)`：注册工具与设置页、把 web 路由接上；**自动推送的调度器也在这里造一次**（`resolveAutoPushRuntime()`，挂在插件生命周期上，同一个实例交给界面看状态、也给它当场跑一轮）。事件层的监听与调度器**挂在同一个 promise 上**（凭据与配置要先解析完才作得成，而 `turn/end` 可能来得更早：先拿着 promise、到位再接监听——接晚了不丢这一轮，用户接着写的下一轮马上就会触发），卸载时**先摘监听、再停调度器**（摘晚了会有事件在 `stop()` 之后进来） | `dsh-tools` |
| `src/config.ts` | 插件配置的 schema：`sync` 那一节带 `volatile`（活字段，改完不用重启），三个路径字段不带；`syncSection()` 把"活引用"与"普通对象"两种来路收成一份值；自动那一节的拍平在 `autoPushSection()` 一处（两栏 `autoPush` / `autoSync` → 一档 `{ enabled, mode }`，强的那档赢：`autoSync` 是双向、`autoPush` 是只推、都没写是关；原来那个间隔数与它的下限跟着兜底定时器一起删了） | `@deepseek-ai/schemastery` |
| `src/tools.ts` | 6 个工具注册：读 `tools` 一节的开关、造一份迁移依赖（工具与界面端点同一个形状）、按顺序把定义交给 `ctx.tools.register`；关掉的连 `register` 都不调，卸载时把收下的 disposer 逐个调用 | `dsh-tools` |
| `src/web.ts` | 界面端点（meta / state / transcript / export / import / sync / auto-push / migrate / backups / rollback / delete / archive / retitle），只要求 `{ register }` 形状；`GET /meta` 只答会话库位置与宿主能力位（不扫库），`GET /state` 是它的超集，另报一栏 `repos`（目录 → 项目身份，注入的入口认，见 `src/shared/repo.ts`）；`GET /state` 与 `/sync`（预演与落地）、`/migrate`、`/delete`、`/rollback`、`/import`、`/archive`、`/retitle`（正文带 `includePinned: true` 时连 `user` 源的标题一起重算——那是给一次性清理留的口子，界面不传这个字段）都回 SSE（`streamResult()`：`progress` 逐条、`result` 收尾，见 [决策](../.agents/notes/implemented/architecture/2026-10-08-every-long-action-streams-progress.md)）；`GET /meta`、`GET /backups`、`/export`、`GET /transcript`（一条会话的完整内容：只读、按事件位分页、一次读一份最高代次的日志）与 `GET /remote`（远端各机器格子里每条会话的位置：读的是每台机器那份 `index.json`，不是包；右栏那行「远端」一次刷新读一次，见 `src/client/operations/sync/remoteLibrary.ts`）是一次性响应（`/export` 的响应体就是产物本身，附件对象的条数 / 字节 / 本机缺的那几个报在 `x-dsh-attachment-*` 响应头里）。`POST /delete` 收 `sessionIds` / `mode` / `alsoRemote`（勾了「同时删除远端」才动远端，见 `src/operations/remove/remove.ts`）。`GET /auto-push` 是自动推送那一枚「立即推送一次」：**两种形状**——没配同步或这个宿主没有调度器（`deps.autoPush` 缺席）时是写头之前的 JSON + 409，其余时候当场跑一轮（`tick()`）并按 `/sync` 同一套回 SSE（事件带 `what: 'auto-push'`，`result` 是 `mode: 'auto-push'` + 那个 `AutoPushOutcome`，真跑过才把 `plan` / `pulled` / `pushed` / `bytesIn` / `bytesOut` / `problems` 那几项摊平，与 `/sync` 的 `payloadOf()` 同形）；这条路只推不拉、没有确认那一步，所以没有 `mode=apply` 那种分岔，也没有 `enable` / `disable`——开关只走配置表单。落地跑着的时候第二趟 `mode=apply` 拿到 409。`GET /panel/events` 是这一页**唯一**的长连接：开头 `ready`（宿主事实，不扫库）、两种后台状态的当下（`sync`：落地那一趟 + 上一轮结论；`auto-push`：自动推送那一轮 + 上一轮计数）、扫库的 `progress`、整库清单 `snapshot`（与 `/state` 同一份取值，走同一个 `readState()`），之后跟着推变化与 `stale`（本机会话库被改过了，页面据此重连要新清单），每 15 秒一次 `ping`，客户端断开就退订、退定时器的订阅（见 [决策](../.agents/notes/implemented/architecture/2026-10-21-one-stream-for-the-whole-panel.md)） | 无 |

#### `src/shared/`：跨操作共用的零件

被两个以上操作用到、或者被插件外壳与测试同时用到的代码放这里。它们只回答「这件事按什么口径算」，不含任何一种操作的流程。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/shared/types.ts` | 贯穿各层的共享类型（计划、产物、注册表视图等） | 无 |
| `src/shared/text-chunks.ts` | 大文本/大缓冲的分块工具：`splitLinesAsync()`、`joinTextAsync()`、`concatBuffersAsync()`，结果与整份 `split` / `join` / `Buffer.concat` 逐字符或逐字节相同，段间让出一轮事件循环；请求体拼接、路径改写、差异页与内容关系共用（见 [阻塞预算](../.agents/notes/implemented/architecture/2026-11-17-blocking-budget.md)） | 无 |
| `src/shared/paths.ts` | `encodeSegment()`、代次文件名、会话目录/日志路径 | 无 |
| `src/shared/plugin-paths.ts` | 插件自己的目录：`dshHome()`（`$DSH_HOME`，缺席退到 `~/.dsh`）、`resolvePaths()`（会话库 / 注册表 / 备份根，三个都是对外默认值）、旧默认备份根的一次性整体搬迁 `adoptLegacyBackupRoot()` | 无 |
| `src/shared/project-key.ts` | 逐字符复刻宿主 `projectKey()` + 有损碰撞检测 | 无 |
| `src/shared/canonical-path.ts` | 落地目录的规范拼写（`canonicalDir()`：宿主存工作区 `path` 与会话 `cwd` 用的同一个 realpath），落地那条路上唯一的归一入口；`canonicalDirIfExists()` 是它的"解析不出来就是结论"版本（宿主建成员索引用的那一支） | 无 |
| `src/shared/registry.ts` | 注册表启动不变式校验、`reHome()`、原子落盘 | 无 |
| `src/shared/accounting.ts` | 「这条会话被哪个工作区**认领**」的唯一一份判据（宿主 `Workspace.sessionIds` 的口径：登记过 **且** header 的 cwd 归一到那条记录的 `path`）；`/state` 与迁移计划都读它 | 无 |
| `src/shared/visibility.ts` | 侧边栏可见性与「未分组」判据：子智能体 / 空白 / 已归档三条理由（候选与界面共用一份）、`isUngrouped()`＝没认领（`accounting.ts`）**且** 会显示 | 无 |
| `src/shared/family.ts` | **族**的展开（点名一条会话 → 它自己 + 全部子智能体后代）与「单独点名的子智能体」判据（`loneSubagents()`），删除 / 迁移 / 归档 / 导出共用 | 无 |
| `src/shared/repo.ts` | 跨机器的项目身份：git remote 规范化（`host/owner/repo`，去掉 `.git` 与凭据、端口进身份）与"这条目录属于哪个仓库"（仓库根 + 仓库内相对路径）；跑 git 的入口可注入。`createRepoLookup()` 是界面读身份那条路（进程内缓存：一个目录只问一次 git，`/state` 是热路径） | 无 |
| `src/shared/attachments.ts` | 附件对象（日志里那个 `attachmentId` 指向的字节）：日志逐行扫引用（字符串预筛 + 解析）、按 `kind:id` 去重（引用里带上日志声明的字节数与**文件对象的名字**——前者供「本机这份还在不在」用，后者是文件本机路径的最后一段）、读写宿主附件库的**纯路径端口** `AttachmentPort`（`pathOf()` 只算路径，读与写都在这里）、对象落地的 `.part` + rename 与 `0o400` 规格 | 无 |
| `src/shared/journal.ts` | 字节级备份清单与回滚（迁移与删除两种来源） | 无 |

#### `src/shared/log/`：日志的字节、帧与行

会话日志的读取、解码、改写与缓存都在这一层；它只认格式，不认迁移或同步要拿它做什么。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/shared/log/zstd-frame.ts` | raw 帧编码、首帧边界定位、多帧感知守卫 | 无 |
| `src/shared/log/log-decode.ts` | 日志解码：`decodeAllChunked()` 用 fzstd 的流式解码器按 128 KB 一块推进、块与块之间让出一轮事件循环（块边界切在多字节字符中间由 `StringDecoder` 兜住，输出与 `decodeAll()` 逐字符一致），`decodeLogTextChunked()` 是它与 `decodeLogText()` 同形的入口；同步里「两边各自写过」那些对读整份日志就走它（整份解压一次会把宿主主线程按住一两秒，见 [决策](../.agents/notes/implemented/bug-fix/2026-10-21-content-relations-off-the-main-thread.md)） | 无 |
| `src/shared/log/log-text-cache.ts` | 同一份日志连着读好几页时只解压一次：只留一份切好的行，判据是 `路径 + size + mtimeMs + 压缩方式`，解压走 `log-decode.ts` 的分块版本；解开后超过 64M 字符的不缓存（内容视图翻页用它，见 [决策](../.agents/notes/implemented/architecture/2026-11-10-locate-one-session-without-scanning.md)） | 无 |
| `src/shared/log/session-log.ts` | 单日志读取与**保结构**改写：`relocateHeaderCwd()` 只换 header 的 cwd（迁移用），`relocateSessionPaths()` 连 `working-directory/change` 里那些「本机不认」的路径一起换（导入落地与修日志用，见 [决策](../.agents/notes/implemented/bug-fix/2026-11-13-imported-working-directory-paths.md)）；两者都只重压改动的那几帧，改完整份解码比对 | 无 |
| `src/shared/log/self-root-path.ts` | 事件里「跟着会话根一起搬」的路径：哪几个字段（目前只有 `working-directory/change` 的 `cwd`）、段级前缀映射（`mapUnderRoot()`）、只动那一格的行级改写（`rewriteSelfRootLine()`），以及两边比对时把这类值归一成的占位符。零 node 依赖，日志改写、比对与修日志三处共用 | 无 |
| `src/shared/log/session-title.ts` | 会话名称：宿主投影缓存优先，缺席时有界地解日志开头 | 无 |

#### `src/shared/library/`：会话库扫描

扫库、按 id 找一条会话、以及「库没变就别重扫」的两级缓存。页面、迁移、同步、导出都读这一层。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/shared/library/discovery.ts` | 项目目录扫描 + 只解首帧读 header（发现阶段快，只读文件开头 64 KB，解不出来再退回整份），可注入标题读取器与投影记录读取器；`locateSession()` 按 id 直接找一条会话（目录名就是 `encodeSegment(id)`，找不到才退回整库扫描），内容视图与日志对比走它 | 无 |
| `src/shared/library/scan-cache.ts` | 库没变时复用上一次的扫描结果：指纹 = 目录清单 + 每个日志与投影缓存文件的 `size`/`mtimeMs`，加上粗粒度时间戳的 racy 窗口；页面打开与导出 / 归档 / 重算名称的发现阶段用它 | 无 |
| `src/shared/library/projection-cache.ts` | 读宿主投影缓存的单条记录（标题、`blank` 等列表元数据）；`createProjectionReader()` 按 `size + mtimeMs + 身份` 记住解析结果，重扫时只重解变了的那些 | 无 |

#### `src/shared/host/`：把改动交给宿主

写盘之后的两步善后，迁移、导入、同步三个落地口共用：让宿主认下新的注册表、补上被改写会话的列表元数据。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/shared/host/take-effect.ts` | 「改完注册表之后让宿主立刻认下这处改动」的共用一步：迁移与导入 / 同步拉取都调它（回滚不走——它整份写回文件以保住工作区 id）；探测端口、执行顺序、宿主没接住时把算好的注册表整份写回（`restoreRegistry()`）、以及"要不要重启"的措辞只写在这里，**执行时机**留给各自编排层（批量落地时最后调一次） | 无 |
| `src/shared/host/checkpoint-warm.ts` | 「落地之后请宿主把这批会话的列表元数据折出来」的共用一步：宿主的侧边栏标题不来自日志，只认它自己写的投影检查点，而检查点只在活着的会话上被写；这里借宿主自己的两个服务（`sessionQuery.readSession()` + `sessionProjectionCache.coldSnapshot()`）冷读一遍补上，逐条兜住失败（导入 / 同步拉取 / 迁移三个落地口共用） | 无 |
| `src/shared/host/ports.ts` | 宿主那几件**可选**服务的探测，统一走 `ctx.get(name)`（属性访问在 Cordis 里会同步抛错，即使服务存在）：`optionalService()`、`effectMode()`、`hostRegistryPort()`（注册表实体 API + 会话持久化，收成"改注册表"的端口）、`hostCheckpointPort()`（冷读一条并写回投影检查点）、`titleRefreshPort()`（临时挂载 → 重算 → 自己开写句柄补事件 → 摘掉，见 `src/operations/retitle/retitle.ts`）、`attachmentPort()`（附件库那两个纯路径方法）、`directoryPickerKind()`、`archiveOps()`、`liveSessionIds()`。认形状不认实现，少一件就当"这个宿主没有这套动作" | 无 |

### 操作：`src/operations/<操作>/`

一个操作一个文件夹：编排层（`migrate.ts` / `sync.ts` / `remove.ts` 这类）连同它私有的助手（计划、执行、备份清单、差异比对）放在一起。跨操作的助手不在这里，回到 `src/shared/`。

#### `operations/migrate/`：迁移

点名会话 → 算只读计划 → 备份 → 落地 → 复核，以及跟着会话一起搬的产物。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/operations/migrate/migrate.ts` | 迁移编排：预演 / 执行 / 回滚 / 备份清单（工具与界面两个入口共用）；写盘之后交 `src/shared/host/take-effect.ts` 把改动交给宿主自己做、`src/shared/host/checkpoint-warm.ts` 补上被改写 cwd 那几条的检查点，并拿备份与落盘结果复核「会话 id 不变」 | 无 |
| `src/operations/migrate/plan.ts` | 只读计划：源是**点名的那些会话**（`sessionIds`，每条按自己的 `cwd` 算，所以可以跨目录）、目标推导、阻塞问题、注册表变更（隐藏的会话逐个点名拒绝，点中的那些再向下展开整族；宿主持着的进 `liveSkipped`，按来源目录分组算产物） | 无 |
| `src/operations/migrate/execute.ts` | 执行 + 独立复核（含产物目标位校验） | 无 |
| `src/operations/migrate/artifacts.ts` | 会话产物提取（证据分层）、规划（求交/剪枝）、搬迁 | 无 |
| `src/operations/migrate/tool.ts` | 迁移四个工具的 schema 与执行：只读计划、落地、回滚、复核；返回形状 `PlanToolResult` / `MigrateToolResult` | `dsh-tools` |

#### `operations/transfer/`：导出 / 导入 `.dshsess`

包的格式、校验、导出与落地都在这一份里；同步拉取复用它的落地那一段。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/operations/transfer/transfer.ts` | `.dshsess` 容器（导出/解析/校验，格式 v2：日志之外还带一段**附件对象**，每条是 `{ id, kind, name?, bytes, offset }`，读的时候 1 与 2 都认）、导入预演与落地（**先落对象再写日志**，对象落不了只回报不拦会话）；`attachmentActionOf()` 是「这个对象在本机算什么」的唯一判据（导入预演与同步拉取共用）；落地时 `rewriteCwd()` 改写每条日志（header 的 cwd + 事件里那些「本机不认」的工作目录路径，zstd 走分块让出的 `relocateSessionPathsChunked()`，见 `src/shared/log/session-log.ts`）；`parseBundle()` 是校验与解析那一层，`readBundle()` / `readBundleAsync()` 只负责 gunzip（同步入口给手上已经拿着包的落地路径，异步那一路走线程池、不占主线程）；导出走 `buildBundleAsync()`（读与 gzip 在线程池、附件扫描分块解压），`buildBundle()` 是同一格式的同步版本（测试与小包用） | 无 |

#### `operations/sync/`：WebDAV 同步与自动推送

索引、计划、拉取 / 推送、自动推送的调度与结论，连同远端写入闸门与两种视图共用的日志差异。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/operations/sync/sync.ts` | WebDAV 同步编排：远端索引、映射、计划（四种关系 + 空白与「谁更新」）、拉取 / 覆盖本机那份 / 推送（都复用 transfer 的导入落地）；界面那条路把计划与它的输入一起留下（`prepareSync()` 的 `SyncPrepared`，确认时 `syncPrepared()` 照它落地、只在数据变了时重算），`runSync()` 是单次调用那条；整批拉取改完注册表之后最后调一次 `src/shared/host/take-effect.ts`，再调一次 `src/shared/host/checkpoint-warm.ts`。**自动推送**（只推不拉）也在这里：`narrowToPushOnly()` 是计划层唯一的改判处（拉取整表与 `pullIds` 清空、`bytesIn` 归零、推送表里把"远端更新 / 两边各自写过"那些 `skip` 摘出去，只留 `upload` / `update` / `identical`）；`runAutoPush()` 判定顺序是没开 → 算一份只推的计划 → 一条都推不动且索引也没得收尾就报 `idle`（不落地），否则 `applyPreparedSync()` 落地（没得推也落一次空计划，把本机那格索引收窄成眼下的库）；`AutoPushOutcome` / `AutoPushSkip` 是这一轮的结论与没跑的原因（`AutoPushSkip` 只有 `disabled` / `busy` / `idle` 三个码，**没有**"正在攒连发"那种：空闲窗口只推迟推送，不会让谁问出"没跑"；也没有"间隔未到"——兜底定时器与那个间隔一起删了，见 [决策](../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)）；`createAutoPushTimer()` 是调度器，手里只有空闲窗口一个计时器、**没有周期唤醒**（`AutoPushClock` 只剩开关一个活字段），一次只放一轮（`busy`）；它顺手记下"正跑着的那一轮"（`AutoPushRunning`：开始时刻 + 最后一条进度），`status()` 把这一份与上一轮结论一起交出去，`subscribe()` 把之后的每一条进度与收尾结论推给订阅者——两条发起路（后台写完一轮、界面那枚按钮）共用这一份，界面进同步页时据此接上进度，它同时收着那个触发口 `touched()`——**每个**会话事件都调一下（`turn/end` 那一次是在冲盘之后），起/续 `AUTO_PUSH_QUIET_MS`（300000，5 分钟）那个空闲窗口，所以用户连着写的时候一次都不推、停手满 5 分钟才推一轮；真正在跑时再来事件只记一笔欠账、跑完立刻补一次，关着时什么都不做（不排队、不记账）。**附件对象**不在包里，走远端共享目录（`SYNC_ATTACHMENTS_DIR`，与机器格同级：`attachments/{objects,file-objects}/<sha 前两位>/<sha>`）：推送只补远端缺的、拉取只取本机缺的（一次同步里每个前缀目录只列一次），手动同步还多跑一趟 `repairAttachments()` 去补「库里早就有、图却挂着」的那些会话（后台那条只推不拉的路不跑它；索引条目里的 `attachments` 记着每条会话引用过哪些对象，补对象时按它走，只有老条目才分块扫一遍日志并补写，见 [那篇](../.agents/notes/implemented/bug-fix/2026-11-14-sync-attachment-scan-blocks-the-host.md)）；`reservedMachineIdProblem()` 拦住撞上这个保留名的机器标识。**删除跟着墓碑走**：索引里可选的一串 `deleted`（删除记录）由 `tombstonesOf()` 合成（同一个 id 取最晚那次），计划据此三分——远端那份比墓碑旧的不再拉回来（`code: 'deleted'` 的跳过行）、本机那份比墓碑旧的进 `plan.deleted`（跟着删：先备份，再删目录与自己那一格里的包）、本机那份更新的留着并把自己那份墓碑摘掉（"谁更新谁赢"）；`removeRemoteCopies()` 是删除时清远端那一步（只动自己那一格，见 [那篇](../.agents/notes/implemented/feature/2026-11-15-deletion-travels-with-the-tombstone.md)）。**内容判据**那一步（`contentRelationsOf()`）按对取远端包、读两边最新那份日志判谁是谁的前缀：包走 `readBundleAsync()`、日志走 `decodeLogTextChunked()`（分块解压、对与对之间让出事件循环），判出来的关系按两边全部代次的哈希记进进程级 `contentRelationCache`（同一对没再动就不再重算，见 [决策](../.agents/notes/implemented/bug-fix/2026-10-21-content-relations-off-the-main-thread.md)） | 无 |
| `src/operations/sync/runtime.ts` | 同步运行时：`describeSyncConfig()` 报的 `SyncInfo` 里那栏 `autoPush` 带 `{ enabled: true, mode }`（没开就整个缺席，界面据此补一句话、按 `mode` 换"只推 / 双向"的说法），`syncRuntime()` 把它拍进 `SyncSettings`（密码引用每次现解析：先问宿主 credentials，再退环境变量）；`resolveAutoPushRuntime()` 是全仓**唯一一份**自动推送接线（造 `SyncDeps` 时带 `pushOnly: true` 与 `progressWhat: 'auto-push'`，"连续失败几次"与"正跑着的那一轮"留在它造的调度器闭包里——每个宿主只造一个）；`attachAutoPushToSessions()` 是事件那一层：`session/event` 每种都重置安静窗口，`turn/end` 先 `await sessions.flush(session)`（它不保证落盘，而推送读磁盘字节）再 `timer.touched()`，`flush` 失败吞掉只记一笔；`sessions` 按可选服务收，拿不到就返回空卸载函数 | 无 |
| `src/operations/sync/sync-state.ts` | 上一次手动同步的结论落在哪：`<DSH_HOME>/dsh-session-manager/state.json` 里的 `{ sync: { at, ok, pulled, pushed, error?, problems?, leftovers?, takesEffect? } }`（`pendingRestart` 不落盘，读的时候按进程启动时刻算；`leftovers` 是「没做到」的点名版，带会话 id，见 `src/operations/sync/sync.ts` 的 `collectLeftovers()`）。写是临时文件 + rename，读对坏 JSON / 缺字段 / 时间解不出来一律当没有；写失败静默（同步本身不该因为记不下一句话而失败）。入口在 `src/index.ts` 注入给 `web.ts`（`deps.syncRun`），`/meta` 的同步那一栏带上它 | 无 |
| `src/operations/sync/remote-write.ts` | 远端写入闸门：同一台机器的那一格同一时刻只放一个写者（`createRemoteWriteGate()`），推送与删除清远端共用；见 [决策](../.agents/notes/implemented/architecture/2026-11-16-one-writer-per-remote-cell.md) | 无 |
| `src/operations/sync/dav.ts` | WebDAV 客户端：PROPFIND / GET / PUT / MKCOL + Basic 鉴权 + 多状态响应解析 | 无 |
| `src/operations/sync/session-diff.ts` | 两份日志的**只读**差异：逐行比原始行（不比解析后的事件）、header 单独比（`cwd` 常被迁移改写）、`working-directory/change` 里跟着会话根搬的值先归一成占位符再比（落地改写过的那份与远端那份因此仍算同一份）、尾巴分成「一致 / 一边是前缀 / 真分叉」，预览每条一行且有条数与字数上限；`/sync-diff` 与差异视图共用 | 无 |
| `src/operations/sync/tool.ts` | 「同步」那条工具的 schema、结论措辞（`describeSync()` / `describeLeftovers()` / `describeSyncObjects()`）与执行 | `dsh-tools` |

#### `operations/remove/`：删除

删除编排：预演 → 先备份 → 删目录 → 复核，可选地清掉远端那一份。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/operations/remove/remove.ts` | 删除编排：预演（活着的拒删、单独点名子智能体拒掉；点名一条就按 `family.ts` 把它的**全部子智能体**一起展开）→ 先备份 → 删目录 → 复核；不碰注册表。请求带 `alsoRemote` 时删完本机再调注入的 `remoteRemove`（`src/operations/sync/sync.ts` 的 `removeRemoteCopies()`）清远端：它的失败只进问题清单，不影响本机那一步的复核结论（`verified` 只判本机删干净了没有） | 无 |

#### `operations/retitle/`：重新生成名称

逐条判定要不要重算，再交给宿主那套标题服务。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/operations/retitle/retitle.ts` | 重新生成名称的编排：逐条判定"该不该动它"（子智能体、不在库里的按 `not-found` 跳过）→ 交给 `TitleRefreshPort` → 按四类收（改了 / 算过没变 / 跳过附原因 / 失败附原话）；顺序执行并逐条报进度（每条都要整份解一次日志再跑一次模型调用，不并发） | 无 |

#### `operations/path-repair/`：修已经落地的日志路径

修已导入 / 已迁移日志里那些本机不认的路径：推源根、算只读计划、落地、再规划一遍验空。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/operations/path-repair/path-repair.ts` | 修**已经落地**的日志：从日志里推源根（末段与本机会话根同名的最长前缀，推不出就让调用方用 `from` 给）、算只读计划（有取值映射不上就整条不修）、落地（备份 → 逐文件原子替换 → 修完再规划一遍必须为空）；工具 `repair_session_paths` 的编排在这一层 | 无 |
| `src/operations/path-repair/tool.ts` | 「修日志路径」那条工具的 schema、预演说明（`describePathRepair()`）与执行 | `dsh-tools` |

#### `operations/transcript/`：会话日志解析

把事件行折成能从头读到尾的时间线，分页与上限也在这一层；内容视图与差异视图都取它的类型。

| 文件 | 职责 | DSH 依赖 |
| --- | --- | --- |
| `src/operations/transcript/transcript.ts` | 会话日志的解析：把事件行折成"能从头读到尾的完整时间线"（一条事件一条条目、工具调用只算一次、工具名按 `callId` 从调用那条补到结果那条、助手的思考与正文分格）。**上限与分页是它的职责**：单格文本与整页文本总量都有上限，被截的地方记下原长度（界面据此给「查看全文」），`from` / `limit` 按**事件位**分页（日志里的 `seq` 会跳号，拿它当游标会漏条），整份日志的计数只扫行头（不解析正文，大库上是几百 MB）。纯字符串/JSON，没有 DSH 依赖（浏览器侧只取它的类型） | 无 |

### 浏览器半侧：`src/client/`

#### 根下：入口与宿主接缝

入口只做组装；端点调用、响应类型、凭据与目录两个可选服务、插件名与版本标识、样式表各占一个文件。

| 文件 | 职责 |
| --- | --- |
| `src/client/index.ts` | 入口（注册主栏页面、侧栏那一行与插件页那格配置，装样式，把页面与接缝接起来）。 |
| `src/client/plugin.ts` | 本包的 npm 包名：客户端模块系统的 factory id 与插件配置卡的键都用它，只此一处。 |
| `src/client/navigation.ts` | 宿主插件导航服务（`openList()` / `openBundle(包名)`）的持有处：侧栏那页「插件设置」那一枚走它，服务晚到或不在都不影响页面装配。 |
| `src/client/build.ts` | 构建期写死进产物的三个标识符（版本号、短 commit、脏标记）的声明面；页面右下角徽标读它。源码里这三个名字不存在，只有产物里有。 |
| `src/client/api.ts` | 界面端点调用（meta / state / transcript / export / import / sync / migrate / backups / rollback / delete / archive / retitle，那些长动作按 `content-type` 分流走 `readEventStream()` 读流、其余一次性 JSON）。 |
| `src/client/types.ts` | 端点响应的类型面。 |
| `src/client/credentials.ts` | 宿主凭据服务（`remote.credentials`）的持有处。 |
| `src/client/directory.ts` | 宿主目录选择服务的持有处（可选依赖，`native` / `browse` 两种能力，界面按宿主报来的 `pickerKind` 选一种）。 |
| `src/client/styles.ts` | 样式表正文与注入（`installStyles`）。 |

#### `shell/`：页面骨架

页面这一级只有两个文件：侧栏那一页的外壳，和把它画出来的骨架。

| 文件 | 职责 |
| --- | --- |
| `src/client/shell/SessionManagerPage.tsx` | 主栏那一页的外壳：宿主的 `.mainPanel` 是定高的 flex 列、`overflow: hidden`，滚动视口得由占位方自己给，里面就是 `ManagerPanel`。 |
| `src/client/shell/ManagerPanel.tsx` | 「会话管理」页的骨架（页面上就是会话列表；导出在动作行、导入与备份与回滚在状态栏、同步在页头，各自开弹窗；说明从页头「?」开弹窗）。 |

#### `shared/ui/`：所有面板共用的控件

两个以上操作会画的东西放这里。只服务一种操作的弹窗不在这里，去 `operations/<操作>/`。

| 文件 | 职责 |
| --- | --- |
| `src/client/shared/ui/Hint.tsx` | 悬浮提示：官方 `Tooltip` 的薄壳，全站提示只走它，不写原生 `title`。 |
| `src/client/shared/ui/icons.tsx` | 内联的两个轮廓图标。 |
| `src/client/shared/ui/ProgressBar.tsx` | 那条 6px 进度条的轨道与填充（分母为 0 的那一段不画）。 |
| `src/client/shared/ui/ProgressBlock.tsx` | 六个动作共用的进度块（进度条 + 按 phase 选的那句话 + 当前那一条 + 调用方给的那句「中断了怎么办」，分母为 0 的段落只说话不画条）。 |
| `src/client/shared/ui/ProblemsBlock.tsx` | 六个结果页共用的「没做到 N 条」那一块（淡告警底 + 细线 + 逐条原话，与「上次同步」那张卡里那块同一副长相）。 |
| `src/client/shared/ui/ConfirmDialog.tsx` | 动作页共用的确认弹窗外壳（官方 `Modal` + 标题/正文/底部按钮，计划由调用方取；固定 640，计划表那一档由 `WorkDialog` 的 `wide` 承担）。 |
| `src/client/shared/ui/WorkDialog.tsx` | 同步与备份两个弹窗共用的外壳（`size`：备份 `wide` 1080px；同步跟着那一段走，面板段与没有表的计划段 `narrow` 640px、有计划表与落地段 `wide`；`description` 摆标题下面那行事实，正文层自带 16px 节奏）。 |
| `src/client/shared/ui/RunDialog.tsx` | 那扇**状态窗**与它在状态栏里的入口（`RunDialog`：跑着是进度 +「转到后台」、跑完换成结果页 + 只剩「完成」；`RunChip`：状态栏那一格，点它回到同一扇窗；执行中关窗＝转后台，不是取消）。 |
| `src/client/shared/ui/sessionList.tsx` | 列表骨架（行、列表框、筛选标签与搜索框、那对「全选 / 清空」）。 |
| `src/client/shared/ui/DirectoryField.tsx` | 那枚目录值控件（值 +「手输路径」+ 上面那两份列表，迁移的目标与导入的落地目录共用它，展开状态由 `useDirectoryFields()` 交给页面持有，所以一页里同一时刻只有一个面板开着）。 |
| `src/client/shared/ui/DirectoryPicker.tsx` | 页面内的目录浏览框。 |
| `src/client/shared/ui/CandidatePanel.tsx` | 目录字段那份候选项列表（与浏览框同一套皮，两边互相切）。 |

#### `shared/logic/`：与操作无关的纯逻辑

零 DOM，Host 半侧的 `test/**/*.ts` 能直接引（`exclude` 只挡自动包含，import 一样会把它拉进来）。

| 文件 | 职责 |
| --- | --- |
| `src/client/shared/logic/eventStream.ts` | 长动作事件流的分帧与解释（纯字符串处理、与 DOM 无关，同步与其它动作共用）。 |
| `src/client/shared/logic/groups.ts` | 列表的组织规则（按目录分组、组内把子智能体缩进到父会话下一级）。 |
| `src/client/shared/logic/planRows.ts` | 「一行 / 一格怎么写」（cwd 那一格、会话名，以及一个目录怎么称呼——`projectLabel()` / `pathLabel()` / `repoHost()`：组头只摆名字 + 一枚主机名标签、项目身份与本机路径进悬浮提示，下拉框里两者都摆进文本）。 |
| `src/client/shared/logic/relativeTime.ts` | 页头那枚同步状态上的「多久以前」（刚刚 / 分钟 / 小时 / 天，`test/client/shared/logic/relative-time.test.ts` 钉住边界）。 |
| `src/client/shared/logic/version.ts` | 版本徽标的文本规则（发布构建 `v0.3.1`，直接 build 带短 commit，脏工作区再挂 `-dirty`）；纯函数，`test/client/shared/logic/version.test.ts` 不经构建就能钉住。 |
| `src/client/shared/logic/panelEvents.ts` | 这一页那条唯一的长连接（`GET /panel/events`）与它上面各种状态的那一份内存——模块级，开别的弹窗 / 关设置再回来都还是同一条，断了按 500ms 起、翻倍到 10 秒封顶的退避自己接回来，`stale` 之后重连一次要新清单；`test/client/shared/logic/panel-events.test.ts` 钉住。 |

#### `shared/hooks/`：浏览器事件的钩子

把原生事件收成组件能直接用的状态；目前只有拖放这一份。

| 文件 | 职责 |
| --- | --- |
| `src/client/shared/hooks/useFileDrop.ts` | 把浏览器那四个 `drag*` 事件收成「现在拖没拖进来、松手时给了什么文件」；页面与导入弹窗共用（`dragover` 必须 `preventDefault()`、`dragleave` 用计数器才稳）。 |

#### `shared/i18n/`：中英两份字典

页面文案的唯一来源；`zh` 是键集真源，`en` 逐键核。

| 文件 | 职责 |
| --- | --- |
| `src/client/shared/i18n/locales.ts` | 页面文案：中英两份字典注册进客户端 `locale` 服务，键名点分，命名空间按官方的 `LocaleNamespaceMap` 登记（`en` 由 `LocaleDictOf` 逐键核，取消 / 关闭 / 保存复用宿主 `common`，见 [决策](../.agents/notes/implemented/architecture/2026-10-05-client-copy-follows-the-official-locale-mechanism.md)）。 |

### 操作：`src/client/operations/<操作>/`

每个文件夹里既有这一面的弹窗（`.tsx`），也有它自己的判据（纯 `.ts`）。判据能被 `test/**/*.ts` 直接引，所以它们不 import 组件。

#### `operations/manage/`：会话页（选、看、动手）

左栏、右栏、动作行，以及动作落地后怎么改清单、怎么开状态窗。

| 文件 | 职责 |
| --- | --- |
| `src/client/operations/manage/ManagePanel.tsx` | 「会话」这一页的主体：左边项目树、右边详情、上面动作行。动作行挂着归档 / 取消归档 / 重新生成名称 / 迁移 / 删除，**迁移那一路也在这个文件里**：目标目录字段、预演与落地都在它自己的确认弹窗中，没有单独的迁移页。 |
| `src/client/operations/manage/SessionTree.tsx` | 「会话」页左栏（项目树 + 筛选标签 + 行上整组勾选；宽屏左栏 / 窄屏浮动面板是同一份 DOM）。 |
| `src/client/operations/manage/SessionInspector.tsx` | 「会话」页右栏（标题、标签、项目 / 目录 / 时间 / 大小 / id，打开完整内容、归档、勾选三枚动作；宽屏右栏 / 窄屏浮动面板是同一份 DOM）。 |
| `src/client/operations/manage/manageRows.ts` | 平铺表的筛 / 排与项目行勾选状态（`sessionsInProject` / `sortSessions` / `groupPickState`，`test/client/operations/manage/manageRows.test.ts` 钉住）。 |
| `src/client/operations/manage/sessionFilter.ts` | 背后的筛选与搜索判据。 |
| `src/client/operations/manage/statePatch.ts` | 动作落地之后就地改清单里的那几条（不等宿主重扫整库）；全是纯函数，一条都没变时原样返回同一个 state。 |
| `src/client/operations/manage/runJob.ts` | 六个写盘动作（删除 / 迁移 / 导入 / 回滚 / 整理远端 / 重算名称）共用的那一趟执行——模块级单槽状态：起跑时打开状态窗、进度一条条进来、可以「转到后台」（窗口关掉、活儿照跑）、跑完把结论挂到同一个槽里等用户按「完成」收走，一次只放一趟（第二趟被拒），`test/client/operations/manage/run-job.test.ts` 钉住。 |
| `src/client/operations/manage/runLabel.ts` | 那一扇窗与其入口的说法（标题、状态栏那一格的短标签、失败那句「没做成」，纯函数，同一个 `test/client/operations/manage/run-job.test.ts` 钉住）。 |

#### `operations/sync/`：同步面

同步弹窗、配置表单、插件页那张卡、差异视图，以及它们背后那一组纯判据（分组、阶段、文案、点色、远端地图）。

| 文件 | 职责 |
| --- | --- |
| `src/client/operations/sync/SyncPanel.tsx` | 「同步」弹窗：同步按钮、三张按项目分组的计划表（会话名后面复用 `sessionList.tsx` 的类型标签）、按 phase 说话的进度块（见 `ProgressBlock.tsx`）——自动推送那一轮直接读页面那条连接上的 `auto-push` 一半（不另开流、不轮询：谁发起的一轮都会推过来），页面自己也不再发 `/meta` 与 `/state`，打开页面连一次 `GET /panel/events`、点「刷新」重连一次。 |
| `src/client/operations/sync/SyncConfigForm.tsx` | 同步设置那张表单（自动推送那个开关摆在「超时（毫秒）」之后，用官方 `Switch`；保存走 `syncForm.ts` 那条路径）。 |
| `src/client/operations/sync/PluginConfigCard.tsx` | 插件页那一格配置卡（`plugins.bundle.config`，按包名作键）：里面只有 WebDAV 那张表单——配置一年改两次，不跟操作挤在同一页。 |
| `src/client/operations/sync/SyncDiffDialog.tsx` | 同步页那枚「看差异」打开的**只读**比对视图（官方 `Modal`，三段：共有的折成一句、本机与远端各列一条尾巴，条目沿用内容视图那种事件卡头行）。 |
| `src/client/operations/sync/syncForm.ts` | 同步设置的读写面（宿主设置接缝 `configForms`）与映射草稿的解析（表单上自动是**一行三选一**，草稿里收成 `auto: 'off' \| 'push' \| 'sync'` 一个值；换档时转成最小的那几条编辑——只推送写 `sync.autoPush` 并清掉 `autoSync`，双向反过来，关掉两栏都清）。 |
| `src/client/operations/sync/syncGroups.ts` | 同步预演那三张表按项目目录分组的规则。 |
| `src/client/operations/sync/syncStage.ts` | 同步那一面此刻摆哪一段（面板 / 计划 / 落地 / 结果，三个输入：这一页自己的意图、宿主那边跑没跑、这一趟完了没有；`test/client/operations/sync/sync-stage.test.ts` 逐支钉住——状态栏那枚「同步中 3/7」点开时看的正是它）。 |
| `src/client/operations/sync/syncJob.ts` | 一轮同步（拉取 + 推送）在界面的生命周期——模块级状态，关掉弹窗 / 开别的弹窗 / 关设置都不影响它，刷新之后从 `panelEvents` 上 `sync` 那一半认领，`test/client/operations/sync/sync-job.test.ts` 钉住。 |
| `src/client/operations/sync/syncJobLabel.ts` | 同步那一趟在**状态栏**上说的那一句（跑着 / 刚跑完 / 没跑，三支各一句短话）；纯函数，`test/client/operations/sync/sync-job-label.test.ts` 钉住。 |
| `src/client/operations/sync/syncChipDot.ts` | 那枚点该点哪一档（跑着 / 失败 / 有遗留 / 自动开着（只推或双向）/ 什么都没有，次序即优先级，`test/client/operations/sync/sync-chip-dot.test.ts` 摆开矩阵）与按钮悬浮提示那句短话（`syncChipNote()`）。 |
| `src/client/operations/sync/syncNotice.ts` | 一次同步落地之后页面顶部那句话（结论先说条数，其余项折成一句「另有：A、B、C。」，顶掉 / 删掉本机内容时那句「旧的那份在「备份与回滚」里」只说一次；`test/client/operations/sync/sync-notice.test.ts` 钉住字数与分句）。 |
| `src/client/operations/sync/syncLeftovers.ts` | 「上次同步没做到的那几条」在界面这一侧怎么读：页头那枚状态的悬浮提示与弹窗里那张清单共用一份，旧宿主只给 `problems` 时退到它。 |
| `src/client/operations/sync/autoPush.ts` | 自动推送「没跑」的原因码在**界面这一侧的运行期清单**（`AUTO_PUSH_SKIP_CODES`，与 `src/operations/sync/sync.ts` 的 `AutoPushSkip` 是同一套名字——联合类型编译之后就没了，而界面要按码去字典里挑那句句子；加一个码要四处一起改：core 的联合、这里、中英两份字典，`test/client/operations/sync/sync-form.test.ts` 是唯一那道闸）。 |
| `src/client/operations/sync/diffStats.ts` | 差异视图两边那两块与三格计数的呈现判据（两块都在、0 条那块也摆出来，`test/client/operations/sync/diff-stats.test.ts` 钉住）。 |
| `src/client/operations/sync/diffTags.ts` | 差异视图那两张分类对照表（关系 / 种类 / 两边各落官方 `Tag` 的哪一档——档位是判据，纯数据，`test/client/operations/sync/diff-tags.test.ts` 钉住）。 |
| `src/client/operations/sync/remoteLibrary.ts` | 右栏那行「远端」背后那一份远端地图（模块级：`GET /remote` 一次刷新只读一次、读到就整份留着，切页签 / 开关弹窗不重读；`test/client/operations/sync/remoteLibrary.test.ts` 钉住「连着 load 两下只发一个请求」与「翻新时不闪」）。 |
| `src/client/operations/sync/remoteRows.ts` | 那一格摆什么（位置清单 + 最多一句说明；某台机器的索引没读到时不许说「远端没有」，`test/client/operations/sync/remoteRows.test.ts` 钉住）。 |

#### `operations/transfer/`：导入

导入那一面与它的后缀判据。

| 文件 | 职责 |
| --- | --- |
| `src/client/operations/transfer/ImportPanel.tsx` | 导入那一面：包与目标目录两个字段、只读计划、落地；包可以拖进来，落点与拖放钩子在 `useFileDrop.ts`，后缀判据在 `fileDrop.ts`。 |
| `src/client/operations/transfer/fileDrop.ts` | 「拖进来的那个文件能不能当包用」——判据只有后缀一条（不看 MIME），`test/client/operations/transfer/fileDrop.test.ts` 把三种情形各钉一条。 |

#### `operations/backup/`：备份与回滚

只读清单 + 回滚 / 恢复，没有第二种入口。

| 文件 | 职责 |
| --- | --- |
| `src/client/operations/backup/BackupPanel.tsx` | 「备份与回滚」弹窗：迁移 / 删除 / 同步覆盖留下的那份清单与回滚、恢复。 |

#### `operations/transcript/`：内容视图

完整时间线那一扇弹窗，以及分页、分节与右栏预览的取法。

| 文件 | 职责 |
| --- | --- |
| `src/client/operations/transcript/TranscriptDialog.tsx` | 会话页的**内容视图**（官方 `Modal` 里摆完整时间线：按种类筛选、按轮次分节且节标题点一下就折起来、筛选那一行贴顶、页头右端写着画面正中那一条的位次与总数、滚到贴底自己往下接、「查看全文」把被截断的那一格取回来）。 |
| `src/client/operations/transcript/transcriptScroll.ts` | 会话内容视图「什么时候去接下一页」那一条判断（贴底就接，撑不满一屏也算贴底；正文那一层滚到底与读完每一页的复查共用它）。 |
| `src/client/operations/transcript/transcriptTurns.ts` | 那份时间线按轮次切节的规则（边界取自日志自己的 `turn/start` / `turn/end`，不按 `turn` 字段是否相等——大多数事件不带那个字段；不属于任何一轮的会话级事件自己一节、不折）。 |
| `src/client/operations/transcript/preview.ts` | 右栏开头两轮的取法（按轮次取人的消息与最后一条有文字的回答，跳过标题模型的合成消息；这一页切在第二轮中间时丢掉半截那一节，`test/client/operations/transcript/preview.test.ts` 钉住）。 |

#### `operations/retitle/`：重新生成名称的说法

一次动作之后的几种结论各怎么说。

| 文件 | 职责 |
| --- | --- |
| `src/client/operations/retitle/retitleNotes.ts` | 「重新生成名称」那一次动作该说的几句话（改了 / 算过没变 / 跳过按原因合并计数，不认识的原因退回一句通用的话）。 |

#### `operations/help/`：说明页

问答正文，不碰数据。

| 文件 | 职责 |
| --- | --- |
| `src/client/operations/help/HelpPanel.tsx` | 说明弹窗的正文（不碰数据）。 |

核心层的**编排与判据**（`src/shared/**` 与 `src/operations/**` 里除 `tool.ts` 之外的文件）**不依赖 DSH**，
所以插件外壳与测试共用同一段代码。依赖 `@deepseek-ai/dsh-tools` 的只有 `src/tools.ts`、`src/index.ts`
与各操作的 `tool.ts`（后两者只是把定义交给宿主），`src/web.ts` 连它也不依赖（只认一个 `{ register }`
形状）。`src/config.ts` 依赖 `@deepseek-ai/schemastery`（schema 与 volatile
语义来自它），但不依赖插件外壳。

`src/client/**` 不在 Host 半侧那份 tsconfig 的 include 里：它要 DOM 与 JSX，而 Host 半侧没有。
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
（`dsh <name>` 就是 `dsh --profile <name>`），在另一个端口上起它。Host 半侧的改动必须**重启**才生效。

## 改动后至少跑什么

```sh
pnpm run check        # 类型 + 测试
pnpm run build        # 确认产物能出来（构建不做类型检查，所以两件事都要做）
pnpm run check:package # 确认打包内容与入口自洽（依赖上一步的产物）
```

涉及工具契约的改动，另外跑 `test/plugin/tools.test.ts` 那组；涉及帧/压缩的改动，
`test/shared/log/zstd-frame.test.ts` 里有一条专门的回归防线（`assertMultiFrameAware`
拒绝「只解首帧」的解码器——这正是当初造成数据截断的那个坑）。
