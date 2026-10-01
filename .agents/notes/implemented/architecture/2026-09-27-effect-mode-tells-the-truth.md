# Agent Note: 生效模式如实探测，不假装即时生效

Status: implemented

## Problem

`WorkspaceRegistry` 持有**内存**注册表与一个 header 索引，而重建该索引的 `replaceHeaderIndex` 是
**私有**方法。于是绕过宿主直接改写 `workspace.json` 之后：

- 注册表会被宿主的旧内存副本覆盖；
- 即使不覆盖，宿主的索引仍是旧的，被搬走的会话会被过滤成「未分组」。

也就是说「改完文件就立刻生效」这件事**不一定成立**，取决于宿主那一代有没有提供进程内的重挂入口。

## Decision

`effectMode(ctx)` 如实探测：上游若提供 `workspaceRegistry.reassignSessions`，就走进程内即时生效，
返回 `'immediate'`；否则返回 `'restart-required'`，由工具返回值告诉调用方「必须重启 DSH」。

## Alternatives considered

**一律声称即时生效。** 使用者会看到「迁移成功」然后发现侧边栏没变——把一次已知的、可解释的等待
变成一次看起来像失败的成功。

**一律要求重启。** 上游已经给了入口的那一代上，这是凭空多一次重启；而探测本身就是读一个属性。

**探测失败时按「即时生效」猜。** 猜错的方向恰好是「做了却没生效」，与上一条同因。

## Consequences

- 「要不要重启」是工具返回值里的一等信息，不是文档里的一句提醒。
- 探测结果也决定了界面怎么措辞，两侧读的是同一个 `EffectMode`，不会一边说即时、一边说重启。
