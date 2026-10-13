# Agent Note: 迁移排除侧边栏不显示的会话

Status: implemented

## Problem

同一台机器上，迁移页的「未分组」报 4 条、外壳侧边栏那一组只显示 1 条——差的 3 条是三种不同的隐藏
理由（一条子智能体会话、两条只有 seed 事件的空白会话，其中一条还已归档），而迁移当时把它们都算进了
候选与条数。

这类账对不上不能靠「把判据在界面上再抄一遍」解决。

## Decision

判据收进一处：`src/visibility.ts` 的 `hiddenReasonOf()`。计划层（`src/plan.ts`）与界面
（`src/web.ts` 的 `/state`）读的是同一份结论，`/state` 把结论作为 `hidden` 字段发给各分页，界面只负责
显示。迁移页把这批会话**列出来但勾不动**（勾选框灰着并说明为什么）：列表就是整库，用户要能看见"为什么
这几条没被搬走"，而"能不能勾"与"宿主会不会搬"必须是同一个集合
（见[迁移的源就是你勾的那些会话](2026-10-13-source-is-what-you-tick.md)）。

三处输入各自的来源：

- **子智能体**：`header.origin === "subagent"`——发现阶段本来就在解首帧，不额外读盘；
- **已归档**：注册表 `global.archivedSessionIds`；
- **空白**：只有宿主自己知道（它记在投影缓存的 `sessionListMetadata.blank` 里，初始 `true`、第一个
  `turn/start` 之后翻掉），所以读 `<registryPath 同级的 storages>/session_projcache/sessions/<id>.json`。
  **读不到就按「会显示」处理**（`blank` 缺省 = `false`），与宿主冷会话分支的 `metadata?.blank ?? false`
  同一口径；身份（`createdAt` + `cwd`）对不上也不认。

命令行那条路与界面走同一个编排层，空白读取器由 `src/migrate.ts` 按 `registryPath` 反推缓存目录自己
造一个，所以「工具说 12 条、界面说 10 条」不会再出现。

## Alternatives considered

**让界面自己过滤。** 那就是判据的第二份实现，也正是这次对不上账的原因。

**读不到空白缓存时按「空白」处理。** 反过来假设它空白，就会把用户看得见的会话从候选里悄悄拿掉，
而「少迁一条」是无声的。

**把隐藏的会话直接从清单里删掉、不提。** 点名叫一条隐藏的会话必须如实报
`session <id> is hidden from the host sidebar (<理由>) — migration does not take it`：
「我没选它」和「我选了它但你没动」必须能分辨。

## Consequences

- 可勾的集合与外壳侧边栏显示的那些一一对应；多出来的那几类列在清单里、各报各的理由。
- `test/hidden.test.ts` 把四种输入逐个钉住；`test/visibility.test.ts` 核三条理由的顺序与缓存缺席时
  的回落。
