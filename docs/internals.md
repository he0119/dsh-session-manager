# 内部设计

用法看 [README](../README.md)，界面与样式的完整规格看 [design.md](design.md)，目录结构与逐文件职责看
[development.md](development.md)，发布看 [releasing.md](releasing.md)。

每条决策的依据、被否决的备选方案与代价都在 [.agents/notes/](../.agents/notes/AGENTS.md) 下，下面按主题
指过去。这份文件只做这件事：它是入口，不是第二份笔记。

## 迁移是怎么成立的

- [迁移会话是三件事同时改](../.agents/notes/implemented/architecture/2026-09-27-migration-rewrites-three-things.md)：
  宿主没有「移动一条会话」的 API，改 header 的 `cwd`、移动日志目录、改注册表缺一不可。
- [启动不变式违反就报错，不降级](../.agents/notes/implemented/architecture/2026-09-27-startup-invariants-fail-fast.md)：
  宿主启动时校验的四条，本插件在写前与写后各验一次。
- [有损的 projectKey 会撞名，动手前先查](../.agents/notes/implemented/architecture/2026-09-27-lossy-project-key-collision.md)：
  `C:\x\y` 与 `C:\x-y` 编码结果相同，宿主的 `realpath` 检查抓不到。
- [落地目录要写成宿主存的那个拼写](../.agents/notes/implemented/bug-fix/2026-10-04-landing-directory-is-the-hosts-spelling.md)：
  宿主按 `fs.realpath` 归一后的字符串比工作区 `path` 与会话 `cwd`，另一种拼写（git 给的正斜杠、手输的
  结尾分隔符）会变成一条成员表恒为空的工作区；归一在计划那一层，`planSync` / `planImport` /
  `buildRelocationPlan` 三个入口共用 `canonicalDir()`。
- [只重写第一个 frame](../.agents/notes/implemented/architecture/2026-09-27-only-the-first-frame-is-rewritten.md)
  与[写侧不依赖压缩器](../.agents/notes/implemented/architecture/2026-09-27-write-side-has-no-compressor.md)：
  改写只动首帧，而首帧由本包手写一个 raw block 帧；只读的内容指纹另走一条只解首帧前缀的浅路，产出
  与严格路逐字节相同。
- [生效模式如实探测，不假装即时生效](../.agents/notes/implemented/architecture/2026-09-27-effect-mode-tells-the-truth.md)
  与[改完注册表把活儿交给宿主自己做](../.agents/notes/implemented/architecture/2026-10-05-hand-the-change-to-the-host.md)：
  `src/take-effect.ts` 拿到宿主那套动作（`hostRegistryPort()`：先按磁盘刷 header 缓存，再复用 / 新建
  工作区、挂会话、摘会话、删空工作区）就把改动交给它自己做，拿不到就如实说这次改动需要重启 DSH。被
  回退的那条路（重挂加载条目）留在[否决记录](../.agents/notes/rejected/architecture/2026-10-05-reload-the-workspace-entry.md)里。
- [宿主持着的会话不搬，但要说出来](../.agents/notes/implemented/bug-fix/2026-10-08-live-sessions-cannot-move.md)：
  `ctx.sessions.list()` 里那条（活的）会话内存 header 还是旧 `cwd`，挂靠必被回绝，日志也不能搬；计划层
  因此按 `MigrateDeps.liveSessionIds()` 把它们摘出去，`liveSkipped` 一路报到工具返回值与界面，点名点到
  它们、或整个来源都活着时按 problem 拒绝。宿主没接住那一步时，这次算好的注册表整份写回文件
  （`restoreRegistry()`），"重启后一致"才成立。
- [宿主不认的登记不算成员，搬完剩下的要说出来](../.agents/notes/implemented/bug-fix/2026-10-08-stale-registrations-do-not-hold-a-workspace.md)：
  `reHome()` 判"源工作区被搬空了吗"按**认领**算（悬空登记不算数，并在同一次里顺手摘掉），只剩侧边栏
  不显示的会话时那块工作区留着——`strandedSources` / `describeStranded()` 一处措辞，报给预演、结果、
  界面与工具返回值。
- [生效提示先说在事前，且只在需要重启时说话](../.agents/notes/implemented/architecture/2026-10-06-restart-notice-up-front-and-only-on-bad-news.md)：
  `/sync` 与 `sync_sessions` 的预演一律按探测回答"执行时会不会需要重启"（迁移那条路本来就是），界面在
  确认弹窗里先说、落地后只在需要重启时留一条 warn 横幅；长解释只在说明页的 FAQ。

## 文件格式与搬运

- [多帧 zstd 变成启动期硬失败](../.agents/notes/implemented/bug-fix/2026-09-27-multiframe-zstd-is-a-hard-failure.md)：
  只解首帧会静默丢掉整个会话，所以解码器由调用方注入、装配时先验守卫。
- [.dshsess 是一条 gzip 流，不是 tar](../.agents/notes/implemented/architecture/2026-09-27-dshsess-is-one-gzip-stream.md)：
  容器的形状与落地前的四道校验。
- [会话包要把附件对象一起带走](../.agents/notes/implemented/feature/2026-10-13-bundles-carry-attachment-objects.md)：
  日志里只有引用、字节在宿主附件库里，所以包得自己带上那几个对象（v2 起），端口缺席时按"只带日志"降级。
- [同步的附件对象走远端一个共享目录](../.agents/notes/implemented/feature/2026-10-16-sync-carries-attachment-objects.md)：
  同步的包只带日志，对象走远端 `attachments/` 那份内容寻址的共享目录；手动同步还补对象（本机缺的取回、
  远端缺的传上），端口缺席时整块不参与。
- [页内分页那一层自己要留块间距](../.agents/notes/implemented/bug-fix/2026-10-16-inner-blocks-need-their-own-gap.md)：
  `.dsm-root` 那份 16px 只作用于直接子元素，分页本体现在自己带 `gap`——不写这一条相邻两张卡片实测
  间距 0px。
- [动作行里的动作带边框](../.agents/notes/implemented/bug-fix/2026-10-16-actions-carry-their-frame.md)：
  变体按角色分：会动数据的动作走 `outline`（卡片动作行）/ `primary`（这一页的主动作），不动数据的工具
  保持缺省的 `ghost`——原来按"写不写盘"分，一条动作行看着就是一段灰字。
- [文件对象要带上它的名字](../.agents/notes/implemented/bug-fix/2026-10-16-file-objects-need-their-name.md)：
  文件在本机是 `files/<sha 前两位>/<sha>/<名字>`（图片没有名字），所以引用与包清单都要带着它，缺了算不出
  路径、整包按坏包拒掉。
- [导入只跳过，不覆盖](../.agents/notes/implemented/architecture/2026-09-27-import-skips-never-overwrites.md)：
  冲突只报告，落地先写 `.part` 再 rename。
- [产物证据分层，并做两道收窄](../.agents/notes/implemented/architecture/2026-09-27-artifact-evidence-layers.md)：
  权威证据与启发式候选、存在性求交、嵌套剪枝。
- [迁移只有一份编排，两个入口](../.agents/notes/implemented/architecture/2026-09-27-one-orchestration-two-entrances.md)：
  工具与设置页调的是同一个 `runMigration()`。
- [删掉离线 CLI](../.agents/notes/implemented/simplification/2026-09-28-retire-the-offline-cli.md)：
  少一份对外契约，离线能力该另起一个不依赖宿主进程的入口。

## 跨机器同步

- [WebDAV 同步是运输层，只增不覆盖](../.agents/notes/implemented/feature/2026-10-01-webdav-sync-is-a-transport.md)：
  远端只放包与索引（一机一格），落地复用导入那条编排；密码只放引用，值进 DSH 的凭据。
- [两边都有同一个 id 时择新，空白会话不搬](../.agents/notes/implemented/feature/2026-10-04-sync-picks-the-newer-copy.md)：
  按内容与宿主的最后活动时间（提问与消息两枚钟里晚的那枚）择新，远端那份赢时先备份（`kind: replace`）再换；空白会话不上传，并从
  自己那格的索引里撤下。
- [两边各自写过时先看差异，这一页只读](../.agents/notes/implemented/feature/2026-10-16-both-wrote-gets-a-diff-view.md)：
  `diverged` 与那几个"一份会顶掉另一份"的结论各带一枚「看差异」：`GET /sync-diff` 取回远端那一个包、
  逐行比原始日志，header 单独比，结论分成 same / 续写 / 真分叉三类；一个字节都不写。
- [两边各自写过时挑一份当正本，另一份落成新会话](../.agents/notes/implemented/feature/2026-10-16-adjudication-keeps-one-branches-the-other.md)：
  差异页真分叉时给「以本机为准」「以远端为准」两枚，选择随 `decisions` 进预演并触发重算；落地先把
  落选那份落成新会话（新 id，标题带来源），正本再占原 id。看差异仍然只读。
- [落成新会话的标记标题不能打乱事件 seq](../.agents/notes/implemented/bug-fix/2026-10-18-branch-title-keeps-seq-dense.md)：
  标记不能插在最后一条标题之后（后面的 `seq` 会错位，宿主读成 torn JSONL）；改最后一条标题的
  `data.title`，没有标题时才追加到末尾，并校验事件 `seq` 与位置一一对应、标题事件满足 v4 形状。
- [远端第一层是插件自己的命名空间](../.agents/notes/implemented/architecture/2026-10-02-remote-namespace-is-the-plugins.md)：
  `url` 之下固定一层 `dsh-session-manager/`，机器格直接放在里面（逐层 MKCOL 自建），于是 `url` 可以是
  服务器根。
- [远端建目录在同一次同步里只发一轮](../.agents/notes/implemented/simplification/2026-10-07-mkcol-once-per-client.md)：
  客户端实例里记下已确认存在的层级，一次推送的 MKCOL 从「每个文件两行」降到最多两行。
- [同步配置在页面里就地可改，只有 sync 是活字段](../.agents/notes/implemented/architecture/2026-10-01-sync-config-is-live-in-the-page.md)：
  表单读写 profile 那份配置文档，路径映射按行增删（远端 cwd 那一栏带上次预演见过的候选），三个路径
  字段刻意不做成活的。
- [5 个模型工具各自能在插件配置里关掉](../.agents/notes/implemented/feature/2026-10-24-tool-switches-in-plugin-config.md)：
  `tools` 那一节一个键对一个工具，只有显式 `false` 算关；关掉是**不注册**，所以模型那份清单里看不到
  它。不是活字段，改完要重启宿主。
- [跨机器的项目身份是 git remote](../.agents/notes/implemented/feature/2026-10-01-project-identity-is-the-git-remote.md)：
  索引记身份与仓库内相对路径，落 `本机仓库根 + 相对路径`；显式映射优先，认不出来就跳过并点名仓库。
- [工作区组头只摆名字与一枚主机标签，项目身份与本机路径进悬浮提示](../.agents/notes/implemented/feature/2026-10-04-workspace-shows-project-identity.md)：
  列表与同步弹窗的组头、目录字段的候选面板（迁移的目标与导入的落地目录，见
  [目录字段那篇](../.agents/notes/implemented/architecture/2026-10-07-directory-field-picks-from-a-panel.md)）
  共用 `planRows` 的称呼规则（组头与面板只摆名字 + 一枚主机名标签，路径与条数退到第二行与悬浮提示；
  只有一行可用的值控件里身份与路径都在文本里），身份由 `/state` 的 `repos` 报来（注入的入口带进程内缓存）。
- [同步预演按项目分组](../.agents/notes/implemented/feature/2026-10-04-sync-plan-groups-by-project.md)：
  三张表各自按项目目录分组，路径在组头说一次，行里只剩动作、会话名与大小。
- [确认之后照着预演那份数据落地](../.agents/notes/implemented/architecture/2026-10-11-sync-confirm-reuses-the-preview.md)：
  预演算出来的计划连输入一起留下（`SyncPrepared`），响应带回 `planId`，确认那次照它落地；输入那套设置、
  本机的代次文件、投影缓存那两件事、要覆盖的那几条是否还活着、远端索引有一处对不上就从零重算。
- [同步关掉窗口之后接着跑，回来还看得见](../.agents/notes/implemented/feature/2026-10-21-sync-keeps-running-when-the-window-closes.md)：
  落地那一趟的状态搬到模块级（`src/client/logic/syncJob.ts`）：忙碌时弹窗那枚「取消」换成「转到后台」，
  进度与结束结论搬到页面顶上的横幅（切页签、关设置再回来都还在）；刷新之后从面板那条唯一的长连接
  （`GET /panel/events`）上认领还在跑的那一趟。宿主那边同一时间只允许一趟落地（第二趟 409）。自动推送
  那一轮同理：调度器记下"正跑着的那一轮"（`AutoPushTimer.status()`）并把之后的每条进度推给订阅者
  （`subscribe()`），面板连接把每一条都转给页面——后台那一轮不管是自己跑的还是手点发起的，横幅与
  「正在自动推送…」都能一帧不落地接上，不必点一下才吃一句"上一轮还在跑"。

  这一页现在只有**一条**长连接（[一条连接看完这一页](2026-10-21-one-stream-for-the-whole-panel.md)）：
  宿主事实、扫库进度、整库清单、落地那一趟、自动推送那一轮、以及"库变了"的重读通知都从它来，原来
  那几条一次性状态端点与"在跑才开"的小流都不在了。
- [自动推送只往远端推](../.agents/notes/implemented/feature/2026-10-14-auto-push-is-push-only.md)：
  后台跑一轮，计划里摘掉拉取与"覆盖本机"那几类，所以它不覆盖、不备份、不写注册表、也不请宿主折
  检查点；开关是活字段，每次事件来时现读一遍当前配置。
- [自动推送只在写完一轮之后推](../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)
  （原先那两个触发源的分工见[上一篇](../.agents/notes/implemented/architecture/2026-10-14-auto-push-follows-turn-end.md)）：
  兜底的定时器与"隔多久跑一次"那个旋钮一起删了——什么时候推完全由宿主报的会话事件决定；`AutoPushSkip`
  因此只剩 `disabled` / `busy` / `idle`。代价是事件层够不到的三类（别的机器推到远端的、DSH 没开着时
  写下的、事件层漏了）要等用户手点一次「立即推送一次」才带上去。窗口多长见[下一篇](auto-push-waits-for-quiet)。
- [自动推送等安静 5 分钟再跑](../.agents/notes/implemented/bug-fix/2026-10-22-auto-push-waits-for-quiet.md)：
  窗口从"最后一个 `turn/end` 之后 10 秒"改成"最后一个会话事件之后 5 分钟"，且**每个**会话事件都重置
  它（不只是 `turn/end`）：一轮整库推送在千条量级的库上实测 20～90 秒、上行几十 MB，每一轮都跑就等于把
  这段重活儿插在用户下一次说话中间。冲盘仍只在 `turn/end` 那一次。
- [内容判据不占主线程，同一对不重算](../.agents/notes/implemented/bug-fix/2026-10-21-content-relations-off-the-main-thread.md)：
  「两边各自写过」那些对要读整份日志判谁是谁的前缀，原来是一整份同步解压 + 同步读文件，一对大日志
  就能把宿主主线程按住一两秒；现在包走线程池的 `readBundleAsync()`、日志走分块让出的
  `decodeLogTextChunked()`，判出来的关系再按两边全部代次的哈希记进 `contentRelationCache`，两边都没
  再动的那一对第二轮不再从远端重取。
- `src/dav.ts` 是那四种方法与 Basic 鉴权（含宽容的多状态响应解析），`src/sync.ts` 是索引、计划与落地：
  界面那条路是 `prepareSync()` 算计划并把输入留下、确认时 `syncPrepared()` 照它落地（`planId` 指认
  宿主手里那份），`src/tools.ts` 的 `sync_sessions` 走单次调用那条（`runSync()`）。自动推送是同一个
  计划层上的第三条路：`runAutoPush()` 用 `pushOnly` 算一份只推的计划（`narrowToPushOnly()` 把
  `skip` 里那些"本机会被远端顶掉"的行摘出去，拉取整表清空），没有预演与确认那一步，没得推时也落一次
  空计划把本机那格索引收窄；`createAutoPushTimer()` 手里只有安静窗口一个计时器、没有周期唤醒，开关是
  活字段（关掉不必重启），`src/tools.ts` 的 `resolveAutoPushRuntime()` 是它唯一的接线（宿主造一个挂在
  插件生命周期上，`GET /auto-push` 端点用同一个，用户手点那一次就是直接 `tick()`）。
- **自动推送唯一的触发源是"本机安静下来"**：`src/tools.ts` 的 `attachAutoPushToSessions()` 订阅
  `session/event`，**每个**事件都把 `AutoPushTimer.touched()` 叫一下（只重置计时、不读盘）；只有
  `turn/end` 那一次先 `await ctx.sessions.flush(session)` 再叫——推送读的是磁盘字节，别的种类冲盘是白费。
  `touched()` 起/续的是 `AUTO_PUSH_QUIET_MS`（5 分钟）那个安静窗口，所以用户连着写、或者后台还有活儿
  在跑的时候一次都不推，停手满 5 分钟才推一轮。没有兜底的定时器：删掉的理由与代价见[那篇笔记](../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)；
  窗口为什么是 5 分钟见[这篇](../.agents/notes/implemented/bug-fix/2026-10-22-auto-push-waits-for-quiet.md)。
  **为什么 `turn/end` 之后必须显式冲盘**：宿主的 checkpoint 策略只在模型请求、工具派发、agent
  步进三处 flush，`turn/end` 不在其中（它的注释明说读存储的消费者自己冲），而推送读的是磁盘字节——少
  这一步推送出去的会是一份缺最后几步的半截会话。正解就是契约点名的那个入口 `ctx.sessions.flush(session)`
  （不要自己 `ctx.parallel('session/flush', …)`）；它失败只当"这次读得更旧"，照旧推，别把异常抛进宿主
  的事件派发。

## 什么算一族

- [族的那条边只有子智能体，分叉不算](../.agents/notes/implemented/architecture/2026-09-30-only-subagent-edges-are-family.md)：
  判据是 `parentSession` 加 `origin === "subagent"`。
- [点名父会话时子智能体跟着走](../.agents/notes/implemented/architecture/2026-09-28-naming-a-parent-takes-the-family-along.md)：
  迁移、删除、归档、导出四条路按族展开。
- [子智能体不能被单独操作](../.agents/notes/implemented/architecture/2026-09-30-subagents-cannot-be-operated-alone.md)：
  单独点名一律拒并指名父会话，孤儿除外。
- [子智能体缩进到父会话的下一级](../.agents/notes/implemented/architecture/2026-09-30-subagents-indent-under-their-parent.md)：
  缩进只改画法，四条边界各有确定的画法。

## 列表、筛选与分组

- [列整库的两个分页按目录分组](../.agents/notes/implemented/architecture/2026-09-27-group-by-directory-not-workspace.md)：
  分组键是 `cwd`，工作区名称只是路径的标签。
- [「未分组」就是外壳那一组](../.agents/notes/implemented/bug-fix/2026-09-28-ungrouped-means-the-sidebar-group.md)：
  一个名字一个定义，三处读同一个结论。
- [「认领」是宿主那份成员表](../.agents/notes/implemented/bug-fix/2026-10-04-accounted-means-the-hosts-membership.md)：
  注册表里的**登记**不算数，cwd 归一到记录 `path` 才算——判据只在 `src/accounting.ts` 写一遍。
- [迁移的源就是你勾的那些会话](../.agents/notes/implemented/architecture/2026-10-13-source-is-what-you-tick.md)：
  勾选就是源（可以跨目录），目标目录在弹窗里选一次，**没有独立的迁移分页**（那枚「迁移」挂在「会话」
  页的动作行上）；`from` 参数与 `includeUnowned` 开关一并删掉。
  它取代的两条留在否决记录里：[源永远是一个目录](../.agents/notes/rejected/simplification/2026-10-13-ungrouped-is-only-a-label.md)、
  [「未分组」当独立来源](../.agents/notes/rejected/architecture/2026-09-27-unowned-is-a-migration-source.md)。
- [迁移排除侧边栏不显示的会话](../.agents/notes/implemented/architecture/2026-09-28-migration-excludes-what-the-sidebar-hides.md)：
  三条隐藏理由的输入来源、界面上"能勾"与"搬得走"分开管，与「读不到就按会显示处理」。
- [列整库的分页共用一份列表实现](../.agents/notes/implemented/simplification/2026-09-28-one-list-for-the-whole-library.md)：
  共用边界划在一行的解剖结构与列表的框上；今天接这条线的是「会话」与「传输」两个分页。
- [筛选按「它是什么」判](../.agents/notes/implemented/architecture/2026-09-28-filters-read-facts-not-labels.md)：
  读原始事实，不读 `hidden`；「未分组」是唯一例外。
- [折叠只改「画不画」](../.agents/notes/implemented/architecture/2026-09-28-collapsing-changes-only-the-drawing.md)：
  收起来的是显示，不是「算不算」。
- [两级在一眼之内分得开](../.agents/notes/implemented/architecture/2026-09-27-two-levels-in-one-glance.md)：
  底色 / 缩进 / 字号 / 图形四层。
- [标题来自日志事件，id 退到悬浮提示](../.agents/notes/implemented/architecture/2026-09-27-session-title-comes-from-an-event.md)：
  投影缓存优先，解日志只读开头 256 KB。
- [扫描时每样东西只读一次](../.agents/notes/implemented/architecture/2026-10-19-scan-reads-each-thing-once.md)：
  日志只读开头 64 KB（解不出合法 header 才退回整份）；每条会话的投影记录在扫描时读一次，标题、空白判据
  与同步的两枚活动时间都从这一份取。
- [库没变时复用上一次的扫描结果](../.agents/notes/implemented/architecture/2026-10-19-reuse-scan-results-between-refreshes.md)：
  指纹是目录清单加每个日志与投影缓存文件的 `size`/`mtimeMs`；粗粒度时间戳下的漏判由 racy 窗口兜住，
  基准取"上一次取指纹的时刻"。只给 `GET /state` 用，不参与写盘判断。
- [落地之后请宿主补投影检查点](../.agents/notes/implemented/bug-fix/2026-10-07-landing-warms-the-projection-checkpoint.md)：
  侧边栏的标题 / 空白 / 最后活动时间都只认宿主那份记录，而那份记录只在**活着的**会话上被写；导入、同步
  拉取、迁移落地之后借宿主自己的两个服务冷读一遍补上（`src/checkpoint-warm.ts`）。
- [重新生成名称：临时把会话挂回宿主](../.agents/notes/implemented/feature/2026-10-12-retitle-attaches-the-session-to-ask-the-title-service.md)：
  名称服务的显式重算入口只认**活会话**，而这里要处理的是整库里早已不在内存里的那些——端口把一条会话
  临时读出来、挂上、重算、冲盘、再摘掉（`src/tools.ts` 的 `titleRefreshPort()` + `src/retitle.ts`）。
- [会话内容视图：在插件里把日志解析出来](../.agents/notes/implemented/feature/2026-10-12-transcript-view-parses-the-log-itself.md)：
  一条事件一条条目、工具调用只算一次、上限与分页都在解析层（`src/transcript.ts` + `GET /transcript` +
  会话页那枚「内容」）；不走宿主，所以侧边栏看不见的会话也能读。

## 删除与归档

- [删除先备份，且不碰注册表](../.agents/notes/implemented/architecture/2026-09-28-delete-backs-up-and-spares-the-registry.md)：
  整目录进备份、`registry untouched`；归档走的是相反的一条路——只能走宿主能力。
- [备份根落在插件自己的目录下](../.agents/notes/implemented/architecture/2026-10-06-backup-root-lives-under-the-plugin-directory.md)：
  默认根是 `<DSH_HOME>/dsh-session-manager/backups`，`~/.dsh` 根下不再多一层平铺的插件名；插件启动时
  把旧默认根整体搬过去（`src/tools.ts` 的 `adoptLegacyBackupRoot()`），老备份照旧列得出、滚得回。

## 浏览器半侧

界面与样式的完整口径在 [design.md](design.md)；下面索引的是每条规格背后的决策与代价。

- [产物是经典脚本，只 require 基线模块](../.agents/notes/implemented/architecture/2026-09-27-client-artifact-is-a-classic-script.md)
  与 [peer 范围就是宿主的装配门](../.agents/notes/implemented/architecture/2026-09-28-peer-range-is-the-hosts-assembly-gate.md)：
  客户端模块系统的契约，以及收不下就整条 bundle 不装的那道门。
- [这一页只连一条长连接](../.agents/notes/implemented/architecture/2026-10-21-one-stream-for-the-whole-panel.md)：
  整库清单、扫库进度、落地那一趟、自动推送那一轮、以及"库被改过了"都走 `GET /panel/events` 这一条
  SSE；页面不再轮询，也不再有"在跑才开一条流"的那种小流。动作（用户点下去的那一次）的进度仍在它自己
  那条请求上。
- [颜色只走检查面的 token](../.agents/notes/implemented/bug-fix/2026-09-27-token-only-colors.md)：
  写死颜色只会在一种主题下错，附带量出来的对比度。
- [控制件用官方原语，本页只挂布局挂钩](../.agents/notes/implemented/architecture/2026-10-15-controls-come-from-the-official-primitives.md)：
  `Button` / `Input` / `Checkbox` / `Tag` / `SegmentedControl` 的观感归官方那几份 CSS module，本页
  CSS 只留"这一页怎么摆它"的布局挂钩；官方 `Tag` 不转发 `title`，悬浮提示挂包着它的那层 `span`，
  `dsm-tag` 这个挂钩挂在两层中的一层，漏挂只会让布局规格静默失效。
- [页头照内建设置页的规格](../.agents/notes/implemented/architecture/2026-09-28-page-header-matches-the-builtin-settings.md)
  与 [正文与次要文字照内建设置页的两档](../.agents/notes/implemented/architecture/2026-10-07-body-type-matches-the-builtin-settings.md)、
  [版面不跟着滚动条动](../.agents/notes/implemented/architecture/2026-09-28-layout-does-not-move-with-the-scrollbar.md)：
  页头没有官方原语可用，规格只能去真实设置页里量；页头里不放动作，页面级的「刷新」挂页签行的右端。
  正文与次要文字是内建那两档（14px/20px 与 12px/18px），行高不跟着字号放大。
- [弹窗正文层自己写字号](../.agents/notes/implemented/bug-fix/2026-10-12-dialog-body-declares-its-own-type.md)：
  官方 `Modal` portal 到 `document.body`，落在那套 `.dsm-root` 之外——弹窗正文层不写字号就继承文档根
  的 16px（会话内容视图的计数、事件卡脚注、错误句都掉在那儿）。
- [弹窗正文的块间节奏要挂在真正的正文层](../.agents/notes/implemented/bug-fix/2026-10-18-dialog-body-needs-its-own-gap.md)：
  `contentClassName` 落在外层，官方里面那层 body 自己 flex 但没有 gap；只在外层写 `gap` 时块与块实测
  仍是 0px，得在自己的 `.dsm-diffBody` 上给节奏。
- [卡片级的主动作放卡片底部的动作行](../.agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md)：
  动作跟着它的输入走；卡头只留不动数据的工具（刷新、全选 / 清空、收起 / 展开），清单行上的动作不挪位。
- [行上的动作等悬停](../.agents/notes/implemented/architecture/2026-10-12-row-action-waits-for-hover.md)：
  会话页那枚「内容」在行尾那一格里与时刻叠着（`grid-area: 1 / 1`），悬停或键盘落在这一行时出场；
  无盒子、走 `brand-primary`——它不该长成标签那样的小块。
- [选行工具全站只有一对](../.agents/notes/implemented/bug-fix/2026-10-08-one-pair-of-pick-tools.md)：
  两张带勾选的清单共用一对常驻的「全选 / 清空」（同一套作用面与禁用判据），位置是清单之上那一行的
  右端；清单就是整张卡时在卡头，清单是卡片里的一段时在它上方那一行。
- [备份清单是独立分页](../.agents/notes/implemented/architecture/2026-10-07-backups-are-their-own-page.md)：
  迁移 / 删除 / 同步覆盖三种来路共用一张清单，页签排在动作页之后、「说明」之前。
- [页面分两份加载，清单没到之前先说实话](../.agents/notes/implemented/architecture/2026-10-07-page-loads-in-two-phases.md)：
  `GET /meta` 先给「库在哪、这个宿主有哪些能力位」（不扫库），`GET /state` 是它的超集；清单到位前
  那几处说「读取中…」，不把"0 个会话""这个宿主没有这个能力"当成结论画上去。
- [目录字段是一个值控件，三条改值的路](../.agents/notes/implemented/architecture/2026-09-27-directory-field-is-one-value-control.md)
  与 [「浏览…」按宿主的能力走](../.agents/notes/implemented/bug-fix/2026-09-27-browse-follows-the-picker-capability.md)：
  任意绝对路径要一个值控件，而目录选择器是一只互斥的能力位服务。
- [候选里盘上已经没有的目录挂着标签、点不动](../.agents/notes/implemented/bug-fix/2026-10-14-candidates-mark-missing-directories.md)：
  `/state` 的每条工作区报一次 `exists`，目标候选据此把"只剩一条登记的"标出来并置灰。
- [动作页只留当下要做的决定](../.agents/notes/implemented/architecture/2026-09-28-help-page-owns-the-glossary.md)：
  词条进「说明」页，并钉了一条两行的上限。
- [说明页 FAQ 的答案不被挤成零宽](../.agents/notes/implemented/bug-fix/2026-10-07-faq-answers-collapse-to-zero-width.md)：
  FAQ 是"问题一行、答案一行"，那一栏自己声明单列，不能沿用词条表那套两列网格。
- [预演表的状态列只放短标签，整句挂 title](../.agents/notes/implemented/bug-fix/2026-10-03-status-column-holds-a-short-tag.md)：
  窄列装不下整句时改文案与列宽，不是让标签顶到邻居身上；三段清单同形，状态与会话名分成两列。
- [同步预演的三段清单要有段头](../.agents/notes/implemented/bug-fix/2026-10-07-sync-plan-sections-need-headings.md)：
  三行条数原来是与正文同一档的 `.dsm-hint`，改成 `h3` 段头 + 条数药丸；段头贴住它自己那张表。
- [写盘动作是一个按钮开一个确认弹窗](../.agents/notes/implemented/architecture/2026-10-03-one-click-confirm-dialog.md)：
  计划与"做不做"这个决定同框；只有会写盘的动作问，归档与导出不问。
- [同步的预演与落地都走 SSE 报进度](../.agents/notes/implemented/architecture/2026-10-03-sync-progress-streams-over-sse.md)：
  预演与落地回同一个事件流形状；算计划的四段各有各的分母（没有分母的那段不画条），写盘分拉取与推送
  两段，跳过的那些不进分母，也没有中途取消。
- [每个长动作都报进度，段名共用一套词汇](../.agents/notes/implemented/architecture/2026-10-08-every-long-action-streams-progress.md)：
  同步那套地基（`ProgressEvent` + `streamResult()` + `ProgressBlock`）现在六个动作共用（迁移 / 删除 /
  回滚 / 导入 / 归档 / 扫库）；段名是一份封闭词汇，`total: 0` 的段落只说在做什么、不画条；`/export`
  是唯一一次性响应（响应体就是产物）。其余端点"计划不 ok"从 409 变成 200 + `result.ok: false`。
- [插件列表那一行的标题来自包导出的 locale 元信息](../.agents/notes/implemented/bug-fix/2026-10-05-plugin-title-comes-from-exported-locale.md)：
  外壳读 `<包名>/locale/*.json` 的 `meta.title` / `meta.description`（`en.json` 是发现入口），读不到
  就回退成包名——`en.json`、`zh.json`、`exports` 里的 `./locale/*.json` 三样缺一即静默回退。
- [客户端文案按官方 locale 机制接进类型系统](../.agents/notes/implemented/architecture/2026-10-05-client-copy-follows-the-official-locale-mechanism.md)：
  页面文案走客户端 `locale` 服务（命名空间 + 点分键名 + 宿主 `common` 兜底），`t` 由框架按 `locale`
  作为 props 送进组件；字典与键集只 import 类型，产物里字节不变。与上一条是两条链：`locale/*.json`
  服务插件列表那一行，这份服务页面里的字。
- [右下角那枚徽标报的是哪个构建](../.agents/notes/implemented/feature/2026-10-06-version-badge-reports-the-build.md)：
  版本号与短 commit 由 `tsdown.config.ts` 的 `define` 在**编译期**写进客户端产物（判据在
  `scripts/build-identity.ts`：HEAD 上有标签 = 发布构建只报版本号，直接从 git build 的多一个短 commit，
  构建时工作区脏再挂 `-dirty`），页面渲染时只读常量，运行期不碰 git。

## Host 半侧的约束

- [可选服务只能走 ctx.get 或 ctx.inject](../.agents/notes/implemented/bug-fix/2026-09-27-optional-services-need-inject.md)：
  Proxy 只放行声明过 `inject` 的属性，而假 ctx 与根 fiber 都读得到——所以用例跑在真实 fiber 上。
- [设置导航那一行的图标由外壳决定](../.agents/notes/implemented/architecture/2026-09-27-settings-nav-icon-is-the-shells.md)：
  一条已知边界，判据在 `src/client/index.ts` 的模块头注释里。

## 验证

- [每一层测试证明什么](../.agents/notes/implemented/testing/2026-09-27-verification-layers.md)：
  单元 / 产物契约 / 宿主契约 / 端到端 / 真实数据各证一件不同的事。
