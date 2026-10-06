# 内部设计

用法看 [README](../README.md)，目录结构与逐文件职责看 [development.md](development.md)，发布看
[releasing.md](releasing.md)。

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
- [生效提示先说在事前，且只在需要重启时说话](../.agents/notes/implemented/architecture/2026-10-06-restart-notice-up-front-and-only-on-bad-news.md)：
  `/sync` 与 `sync_sessions` 的预演一律按探测回答"执行时会不会需要重启"（迁移那条路本来就是），界面在
  确认弹窗里先说、落地后只在需要重启时留一条 warn 横幅；长解释只在说明页的 FAQ。

## 文件格式与搬运

- [多帧 zstd 变成启动期硬失败](../.agents/notes/implemented/bug-fix/2026-09-27-multiframe-zstd-is-a-hard-failure.md)：
  只解首帧会静默丢掉整个会话，所以解码器由调用方注入、装配时先验守卫。
- [.dshsess 是一条 gzip 流，不是 tar](../.agents/notes/implemented/architecture/2026-09-27-dshsess-is-one-gzip-stream.md)：
  容器的形状与落地前的四道校验。
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
  远端只放包与索引（一机一格），落地复用导入那条编排；密码只放引用，值进宿主机凭据库。
- [两边都有同一个 id 时择新，空白会话不搬](../.agents/notes/implemented/feature/2026-10-04-sync-picks-the-newer-copy.md)：
  按内容与宿主的最后活动时间（提问与消息两枚钟里晚的那枚）择新，远端那份赢时先备份（`kind: replace`）再换；空白会话不上传，并从
  自己那格的索引里撤下。
- [远端第一层是插件自己的命名空间](../.agents/notes/implemented/architecture/2026-10-02-remote-namespace-is-the-plugins.md)：
  `url` 之下固定一层 `dsh-session-manager/`，机器格直接放在里面（逐层 MKCOL 自建），于是 `url` 可以是
  服务器根。
- [同步配置在页面里就地可改，只有 sync 是活字段](../.agents/notes/implemented/architecture/2026-10-01-sync-config-is-live-in-the-page.md)：
  表单读写 profile 那份配置文档，路径映射按行增删（远端 cwd 那一栏带上次预演见过的候选），三个路径
  字段刻意不做成活的。
- [跨机器的项目身份是 git remote](../.agents/notes/implemented/feature/2026-10-01-project-identity-is-the-git-remote.md)：
  索引记身份与仓库内相对路径，落 `本机仓库根 + 相对路径`；显式映射优先，认不出来就跳过并点名仓库。
- [工作区组头只摆名字与一枚主机标签，项目身份与本机路径进悬浮提示](../.agents/notes/implemented/feature/2026-10-04-workspace-shows-project-identity.md)：
  列表与同步弹窗的组头、两个目录下拉框四处共用 `planRows` 的称呼规则（组头只摆名字 + 一枚主机名标签，
  下拉框里身份与路径都在文本里），身份由 `/state` 的 `repos` 报来（注入的入口带进程内缓存）。
- [同步预演按项目分组](../.agents/notes/implemented/feature/2026-10-04-sync-plan-groups-by-project.md)：
  三张表各自按项目目录分组，路径在组头说一次，行里只剩动作、会话名与大小。
- `src/dav.ts` 是那四种方法与 Basic 鉴权（含宽容的多状态响应解析），`src/sync.ts` 是索引、计划与落地，
  `src/tools.ts` 的 `sync_sessions` 与 `src/web.ts` 的 `GET|POST /sync` 调同一份 `runSync()`。

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
  分组键是 `cwd`，工作区标题只是路径的标签。
- [「未分组」就是外壳那一组](../.agents/notes/implemented/bug-fix/2026-09-28-ungrouped-means-the-sidebar-group.md)：
  一个名字一个定义，三处读同一个结论。
- [「认领」是宿主那份成员表](../.agents/notes/implemented/bug-fix/2026-10-04-accounted-means-the-hosts-membership.md)：
  注册表里的**登记**不算数，cwd 归一到记录 `path` 才算——判据只在 `src/accounting.ts` 写一遍。
- [迁移页把「未分组」当独立来源](../.agents/notes/implemented/architecture/2026-09-27-unowned-is-a-migration-source.md)：
  候选、请求、计划、被关掉的开关，四种口径钉在一起。
- [迁移排除侧边栏不显示的会话](../.agents/notes/implemented/architecture/2026-09-28-migration-excludes-what-the-sidebar-hides.md)：
  三条隐藏理由的输入来源，与「读不到就按会显示处理」。
- [三个分页共用一份列表实现](../.agents/notes/implemented/simplification/2026-09-28-three-pages-share-one-list.md)：
  共用边界划在一行的解剖结构与列表的框上。
- [筛选按「它是什么」判](../.agents/notes/implemented/architecture/2026-09-28-filters-read-facts-not-labels.md)：
  读原始事实，不读 `hidden`；「未分组」是唯一例外。
- [折叠只改「画不画」](../.agents/notes/implemented/architecture/2026-09-28-collapsing-changes-only-the-drawing.md)：
  收起来的是显示，不是「算不算」。
- [两级在一眼之内分得开](../.agents/notes/implemented/architecture/2026-09-27-two-levels-in-one-glance.md)：
  底色 / 缩进 / 字号 / 图形四层。
- [标题来自日志事件，id 退到悬浮提示](../.agents/notes/implemented/architecture/2026-09-27-session-title-comes-from-an-event.md)：
  投影缓存优先，解日志只读开头 256 KB。

## 删除与归档

- [删除先备份，且不碰注册表](../.agents/notes/implemented/architecture/2026-09-28-delete-backs-up-and-spares-the-registry.md)：
  整目录进备份、`registry untouched`；归档走的是相反的一条路——只能走宿主能力。
- [备份根落在插件自己的目录下](../.agents/notes/implemented/architecture/2026-10-06-backup-root-lives-under-the-plugin-directory.md)：
  默认根是 `<DSH_HOME>/dsh-session-manager/backups`，`~/.dsh` 根下不再多一层平铺的插件名；插件启动时
  把旧默认根整体搬过去（`src/tools.ts` 的 `adoptLegacyBackupRoot()`），老备份照旧列得出、滚得回。

## 浏览器半侧

- [产物是经典脚本，只 require 基线模块](../.agents/notes/implemented/architecture/2026-09-27-client-artifact-is-a-classic-script.md)
  与 [peer 范围就是宿主的装配门](../.agents/notes/implemented/architecture/2026-09-28-peer-range-is-the-hosts-assembly-gate.md)：
  客户端模块系统的契约，以及收不下就整条 bundle 不装的那道门。
- [颜色只走检查面的 token](../.agents/notes/implemented/bug-fix/2026-09-27-token-only-colors.md)：
  写死颜色只会在一种主题下错，附带量出来的对比度。
- [页头照内建设置页的规格](../.agents/notes/implemented/architecture/2026-09-28-page-header-matches-the-builtin-settings.md)
  与 [版面不跟着滚动条动](../.agents/notes/implemented/architecture/2026-09-28-layout-does-not-move-with-the-scrollbar.md)：
  页头没有官方原语可用，规格只能去真实设置页里量。
- [目录字段是一个值控件，三条改值的路](../.agents/notes/implemented/architecture/2026-09-27-directory-field-is-one-value-control.md)
  与 [「浏览…」按宿主的能力走](../.agents/notes/implemented/bug-fix/2026-09-27-browse-follows-the-picker-capability.md)：
  任意绝对路径要一个值控件，而目录选择器是一只互斥的能力位服务。
- [动作页只留当下要做的决定](../.agents/notes/implemented/architecture/2026-09-28-help-page-owns-the-glossary.md)：
  词条进「说明」页，并钉了一条两行的上限。
- [预演表的状态列只放短标签，整句挂 title](../.agents/notes/implemented/bug-fix/2026-10-03-status-column-holds-a-short-tag.md)：
  窄列装不下整句时改文案与列宽，不是让标签顶到邻居身上；三段清单同形，状态与会话名分成两列。
- [写盘动作是一个按钮开一个确认弹窗](../.agents/notes/implemented/architecture/2026-10-03-one-click-confirm-dialog.md)：
  计划与"做不做"这个决定同框；只有会写盘的动作问，归档与导出不问。
- [同步的预演与落地都走 SSE 报进度](../.agents/notes/implemented/architecture/2026-10-03-sync-progress-streams-over-sse.md)：
  预演与落地回同一个事件流形状；算计划的四段各有各的分母（没有分母的那段不画条），写盘分拉取与推送
  两段，跳过的那些不进分母，也没有中途取消。
- [插件列表那一行的标题来自包导出的 locale 元信息](../.agents/notes/implemented/bug-fix/2026-10-05-plugin-title-comes-from-exported-locale.md)：
  外壳读 `<包名>/locale/*.json` 的 `meta.title` / `meta.description`（`en.json` 是发现入口），读不到
  就回退成包名——`en.json`、`zh.json`、`exports` 里的 `./locale/*.json` 三样缺一即静默回退。
- [客户端文案按官方 locale 机制接进类型系统](../.agents/notes/implemented/architecture/2026-10-05-client-copy-follows-the-official-locale-mechanism.md)：
  页面文案走客户端 `locale` 服务（命名空间 + 点分键名 + 宿主 `common` 兜底），`t` 由框架按 `locale`
  作为 props 送进组件；字典与键集只 import 类型，产物里字节不变。与上一条是两条链：`locale/*.json`
  服务插件列表那一行，这份服务页面里的字。

## Host 半侧的约束

- [可选服务只能走 ctx.get 或 ctx.inject](../.agents/notes/implemented/bug-fix/2026-09-27-optional-services-need-inject.md)：
  Proxy 只放行声明过 `inject` 的属性，而假 ctx 与根 fiber 都读得到——所以用例跑在真实 fiber 上。
- [设置导航那一行的图标由外壳决定](../.agents/notes/implemented/architecture/2026-09-27-settings-nav-icon-is-the-shells.md)：
  一条已知边界，判据在 `src/client/index.ts` 的模块头注释里。

## 验证

- [每一层测试证明什么](../.agents/notes/implemented/testing/2026-09-27-verification-layers.md)：
  单元 / 产物契约 / 宿主契约 / 端到端 / 真实数据各证一件不同的事。
