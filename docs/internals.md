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
- [只重写第一个 frame](../.agents/notes/implemented/architecture/2026-09-27-only-the-first-frame-is-rewritten.md)
  与[写侧不依赖压缩器](../.agents/notes/implemented/architecture/2026-09-27-write-side-has-no-compressor.md)：
  改写只动首帧，而首帧由本包手写一个 raw block 帧。
- [生效模式如实探测，不假装即时生效](../.agents/notes/implemented/architecture/2026-09-27-effect-mode-tells-the-truth.md)：
  上游有没有进程内重挂入口，决定了这次改动要不要重启 DSH。

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

## 什么算一族

- [族的那条边只有子代理，分叉不算](../.agents/notes/implemented/architecture/2026-09-30-only-subagent-edges-are-family.md)：
  判据是 `parentSession` 加 `origin === "subagent"`。
- [点名父会话时子代理跟着走](../.agents/notes/implemented/architecture/2026-09-28-naming-a-parent-takes-the-family-along.md)：
  迁移、删除、归档、导出四条路按族展开。
- [子代理不能被单独操作](../.agents/notes/implemented/architecture/2026-09-30-subagents-cannot-be-operated-alone.md)：
  单独点名一律拒并指名父会话，孤儿除外。
- [子代理缩进到父会话的下一级](../.agents/notes/implemented/architecture/2026-09-30-subagents-indent-under-their-parent.md)：
  缩进只改画法，四条边界各有确定的画法。

## 列表、筛选与分组

- [列整库的两个分页按目录分组](../.agents/notes/implemented/architecture/2026-09-27-group-by-directory-not-workspace.md)：
  分组键是 `cwd`，工作区标题只是路径的标签。
- [「未分组」就是外壳那一组](../.agents/notes/implemented/bug-fix/2026-09-28-ungrouped-means-the-sidebar-group.md)：
  一个名字一个定义，三处读同一个结论。
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

## Host 半侧的约束

- [可选服务只能走 ctx.get 或 ctx.inject](../.agents/notes/implemented/bug-fix/2026-09-27-optional-services-need-inject.md)：
  Proxy 只放行声明过 `inject` 的属性，而假 ctx 与根 fiber 都读得到——所以用例跑在真实 fiber 上。
- [设置导航那一行的图标由外壳决定](../.agents/notes/implemented/architecture/2026-09-27-settings-nav-icon-is-the-shells.md)：
  一条已知边界，判据在 `src/client/index.ts` 的模块头注释里。

## 验证

- [每一层测试证明什么](../.agents/notes/implemented/testing/2026-09-27-verification-layers.md)：
  单元 / 产物契约 / 宿主契约 / 端到端 / 真实数据各证一件不同的事。
