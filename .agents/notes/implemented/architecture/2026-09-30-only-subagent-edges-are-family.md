# Agent Note: 族的那条边只有子代理，分叉不算

Status: implemented

## Problem

`parentSession` 有两种来源，而它们的性质完全不同：

- **子代理**（`origin === "subagent"`）：宿主按 (父, 子) 这个地址对投递它，而这条地址要靠**父会话日志
  里的 `subagent/catalog` 投影**才成立；父没了，那条子代理在宿主里根本投不出去了；
- **分叉**（`sessions.fork()`）：把源会话「已完成轮次」的事件拷进新会话（`isSeeded: true`、
  `inheritedEventCount` 记着继承到哪、**没有 `origin`**）。它是**自洽的普通会话**：父删掉 / 搬走，
  它照旧能打开、能继续，宿主也照旧按普通会话投递它。

只判 `parentSession` 会把分叉画成别人的下级、也会在删父会话时把一条独立会话带走。

## Decision

凡是「按族」的地方，判据一律是 `parentSession` **加** `origin === "subagent"`，两条缺一不可。宿主自己
也只在子代理边上往父链走（`dsh-api-session-controller` 的 `underArchivedSession` 一路上溯
`parentSession`、遇到非子代理的边就停；投递子代理必须用 `validateAddress` 认的地址对）。

## Alternatives considered

**只判 `parentSession`。** 分叉会被当成子代理：缩进、级联删除、级联迁移、单独操作的拒绝，四处一起错。

**去读父日志里的 `subagent/catalog` 事件。** 那要把父日志整份解码（一条 6MB 的日志 1～2 秒），而
header 在发现阶段本来就已经解出来了；两者在宿主写出来的库里是同一件事（建子会话时两边一起写）。

**判 `isSeeded`。** 那是分叉的一个实现标记，不是「这条边属于谁」的判据；它的含义是「继承了哪些轮次」，
不是「它依附于谁」。

## Consequences

- 本机就有一条真实的分叉（「还有一个问题需要优化，导出 (1)」挂在「还有一个问题需要优化，导出」下面），
  它在侧边栏里也是正常一条，本插件按普通行画、不缩进、不跟着父走。
- `test/family.test.ts` 专门钉住「分叉不跟着父走，但分叉自己的子代理跟着它」。
