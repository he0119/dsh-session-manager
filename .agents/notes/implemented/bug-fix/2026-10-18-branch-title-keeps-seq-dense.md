# Agent Note: 落成新会话的标记标题不能打乱事件 seq

Status: implemented

## Problem

同步裁决把落选那份落成新会话后，打开这条新会话，宿主直接报：

```text
stored log is corrupt: Error: corrupt Zstandard session log:
complete frame contains a torn JSONL record
```

日志本身每一帧都能解成完整 JSON 行，帧边界也正确；坏在事件顺序与事件形状。`branchSessionLog()`
原来把标记 `session/title` 插在**最后一条标题所在帧之后**，`seq` 取「全日志最后一条事件 + 1」。真实
日志里标题通常在开头，后面还有大量事件：标记的 `seq` 因此比紧随其后的事件大，v4 的
`event.seq !== index` 校验不通过。宿主用可恢复扫描器时不会为不合法事件推进 `committedBytes`，最后
把"事件没读完"报成"torn JSONL"，现象与真正截断的日志一样。

修完 `seq` 后还有第二层：新写的标题事件本身不是合法的 v4 形状。宿主要求 `time` 是 epoch 毫秒的
数字（不是 ISO 字符串）、`data.messageSeqs` 是数组、`data.source` 是对象；空 `messageSeqs` 恰好对应
`source.kind === "user"`。缺任何一项，事件都不会进 committed 前缀，仍然报同一个 torn JSONL。

## Decision

- **改最后一条标题的 `data.title`，不插新事件**：「原标题 · 来自 <机器> <时刻>」。标题的语义是
  "最新一条生效"（`foldTitle()`），改这一条仍排在所有更早标题之后；`seq` 与事件位置都不动，只重压
  含这条标题的那一帧，其余帧逐字节原样拼回。原标题文字保留在新标题的前缀里。
- **没有标题时才追加到末尾**：末尾之后没有事件，`seq` 仍连续；小日志的标题读取预算够得着，大日志
  本来也没有标题可读。追加的标记按 v4 的 `session/title` 形状写：`time` 为 epoch 毫秒、
  `messageSeqs: []`、`source: { kind: 'user' }`。
- `assertBranched()` 加一条与宿主同口径的校验：header 之后第 i 个事件 `seq` 必须等于 i，不等就拒绝
  产出。这样同类错误在插件自己的测试里就变红，而不是等宿主打开时才报"日志损坏"。

## Alternatives considered

- **把标记插在最后一条标题之后、并把后面事件的 `seq` 全部 +1**：能保住"新增一条标题"的形状，但要
  逐帧解析、重编码后续所有事件，代价随日志变大；也没有必要为一条来源标记改写正文。
- **把标记无条件追加到日志末尾**：`seq` 连续，改动最小；但读标题的两条路都只扫开头，大日志上标记
  会被读不到，落成的新会话看起来没有名字。
- **只插标记、不校验 `seq` 与事件形状**：测试里看起来正常，宿主打开时才坏；这次先漏了 `seq`，补上
  之后又漏了 `time` / `messageSeqs` / `source`，两次都是同一类错误。

## Consequences

- 落成的新会话能正常打开；来源标记仍带机器与时刻，前面的原标题也还在。
- 分支日志的事件 `seq` 与宿主 v4 的连续编号要求一致，标题事件也满足 v4 的 `time` / `messageSeqs` /
  `source` 形状；多代次日志同样只换 id / 只改最新一代的标题。
- 没有标题的会话在末尾多一条标题事件；大日志上它可能超出标题读取预算，这是原本就没有标题时的
  降级，不是新丢的信息。
