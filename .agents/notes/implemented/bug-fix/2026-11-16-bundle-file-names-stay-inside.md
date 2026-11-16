# Agent Note: 导入包里的日志文件名不能带路径

Status: implemented

## Problem

`.dshsess` 的清单里，每条日志只记一个 `name`，落盘时由 `applyImport()` 用它拼目标路径：

```ts
const part = join(entry.dir, `${file.name}.part`)
writeFileSync(part, next)
renameSync(part, join(entry.dir, file.name))
```

读包时 `parseBundle()` 校验了 magic、格式版本、每条文件的偏移与 sha256，也校验了会话目录名必须等于
`encodeSegment(id)`，但**没有校验 `name` 本身**：只要偏移、长度与哈希对得上，`../../x.jsonl.zstd` 这样
的名字也能通过。

后果不是"包坏了导不进来"，而是**包决定了文件写到哪儿**。本机验证时把一个这样的包的 `name` 写成
`../../../escaped-by-import.txt`，`readBundle()` 正常接受，`applyImport()` 把文件写到了会话根外面。
会话包本来就是拿来在机器之间传的（导出给人、同步从远端拉），"看起来正常、实际能写穿目录"不能靠
"用户只导自己的包"来兜。

同一处入口还有第二个问题：`readBundle()` / `readBundleAsync()` 的 `gunzip` 没有限制解压后的长度。
`/import` 允许 512 MB 请求体，一个很小的 gzip 包可以解出几十 GB，把宿主内存吃光。

## Decision

两个判据都放在读包这一层，所有入口（界面导入、同步拉取、工具）共用：

- **文件名必须是单段规范名**：`parseSessionLogName(name)` 必须认得出它，也就是只接受
  `session.jsonl`、`session.vN.jsonl`、以及带 `.zstd` 后缀的这几种。这个正则同时排除了 `/`、`\` 与
  `..`，所以不需要再单独判 `basename`。清单里写的 `version` 还必须与文件名里的代次一致——不一致的包
  会在落盘后让发现阶段读出另一个代次，属于同一类"清单与实际不符"。
- **落盘前再判一次**：`applyImport()` 在 `join(entry.dir, ...)` 之前重新检查 `session.files[].name`。
  正常路径永远走不到这一条（`readBundle()` 已经拒过），但它挡住的是"调用方自己拼了一个 SessionBundle"
  这种绕过读包校验的用法。
- **解压上限 2 GiB**：`MAX_BUNDLE_RAW_BYTES` 作为默认值传给 `gunzipSync` / `gunzip` 的
  `maxOutputLength`；超过时抛"包解压后超过上限"，不再伪装成"不是 gzip"。正常整库包实测在几百 MB
  量级，2 GiB 留了余量；测试用 `ReadBundleOptions.maxRawBytes` 把上限压到 8 字节来验拒绝面。

## Alternatives considered

- **只判 `basename(name) === name`**：在 Linux 上 `..\..\x` 是一个合法文件名，`join` 不会把它当分隔符；
  换到 Windows 上同一个名字就会被拆成路径。用 `parseSessionLogName()` 的白名单一次覆盖两套分隔符，
  也不依赖运行平台。
- **落盘时用 `path.resolve()` 再判是否在 `entry.dir` 下面**：能挡住穿越，但会让"名字长什么样"与
  "包格式允许什么"分成两套判据；白名单更窄，读包时就拒掉，后面的代码不必再考虑这种输入。
- **把解压上限放到调用方（端点）**：同步拉取、工具、界面三个入口都要各写一遍，漏一个就回到原点。
  放在 `readBundle()` 这一层，默认值只写一次。
- **解压到临时文件再流式读**：能进一步降低内存峰值，但读包之后本来就要把整份载荷留在内存里做偏移
  访问（`entryBytes()` 返回的是同一块 Buffer 的切片），这一步单独改收益不大。

## Consequences

- 旧包只要文件名是规范名就照旧能读；`formatVersion` 不变，不需要升版。
- 手工拼清单、或者从别的工具生成的非规范文件名，会在读包时被拒，错误里带着那个名字。这是有意的：
  它们本来也落不成一个宿主认得出来的会话目录。
- 解压上限是 2 GiB；将来单条会话的包真超过这个量级时，要同时改常量与这条笔记。
