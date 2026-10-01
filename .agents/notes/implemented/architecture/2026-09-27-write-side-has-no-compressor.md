# Agent Note: 写侧不依赖压缩器

Status: implemented

## Problem

上一条决定了「只重写首帧」。但重写首帧仍然需要**产出**一个 zstd 帧，而可用的两条路都不通：

- `fzstd` 只能解压、不能压缩；
- `node:zlib` 的内置 zstd 有 Node 版本下限（本包 `engines.node` 写的是
  `^22.19.0 || >=24.0.0`，按 Node 的 zstd 支持时间线，内置 zstd 大约从 22.15 / 23.8 才有）。

而本包对「写」这件事的要求很高：它改写的是用户的真实会话日志。

## Decision

`encodeRawFrame()` 手写一个只含单个 **raw（未压缩）block** 的合法 zstd 帧
（Single_Segment=1、Block_Type=Raw、无校验和）。代价是首帧不压缩——而首帧本来就只有一个 header 行，
压缩收益可忽略。

## Alternatives considered

**依赖 `node:zlib` 写、把 `engines.node` 抬到内置 zstd 之后。** 那等于为了写一个 ~180 字节的帧，
把整包的 Node 下限抬高一档，并把它绑在一个当时还很新的 API 上。

**引入一个能压缩的第三方 zstd 包。** 那是往写入路径上加一个运行期依赖，而写错的后果是用户的会话
日志坏掉——写侧零依赖让「这段代码有没有变」变成一件可以在评审里看完的事。

**写一个压缩 block。** 需要选择压缩级别、按 zstd 的块格式排出字面量与序列，而收益只是首帧那百来
字节；raw block 的正确性只需读一遍帧头。

## Consequences

- 写侧不依赖任何压缩器、外部二进制或 Node 版本特性。
- 「首帧不压缩」是这套做法的一个已知代价，并且只落在 header 那一行上，不是整份日志。
- 这个帧由 `test/zstd-frame.test.ts` 用真实解码器读回来验，不是靠格式文档自证。
