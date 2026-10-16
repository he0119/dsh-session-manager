# Agent Note: 文件对象要带上它的名字

Status: implemented

## Problem

图片与文件在本机放的地方**不是一个形状**：

```
$DSH_HOME/attachments/v1/objects/<sha 前两位>/<sha>              图片：路径里只有内容
$DSH_HOME/attachments/v1/files/<sha 前两位>/<sha>/<名字>         文件：最后一段是**用户看到的名字**
$DSH_HOME/attachments/v1/file-objects/<sha 前两位>/<sha>         文件另有一份内容寻址的规范副本
```

`AttachmentPort` 把"引用 → 本机绝对路径"交给宿主（`ctx.attachments.imageHostPath()` /
`fileHostPath()`），而它一直只交 `attachmentId` 一个字段。图片那条没事（`normalizedImagePath()` 只
读 id），**文件那条直接抛错**：`fileHostPath()` 走的 `ensureFileReference()` 会核名字是不是一个合法
叶子名，缺了就 `INVALID_ATTACHMENT_REF`。端口把这次抛出吞成 `undefined`（"宿主不认识这种引用"），
于是文件对象在同步与导出里**永远被当成'本机没有'**：推不上去、也取不下来，只留一句"宿主容不下附件
<id>（file）"。图片完全正常，所以这个缺口在只有图片的会话库上一点动静都没有。

## Decision

引用里带上名字，一路带到路径计算为止：

- 日志扫描（`refsInValue()`）在 `attachment.name` 是非空字符串时把它收进 `AttachmentRef.name`——
  与 `bytes` 同一条"后来那行没写就不抹掉已有的值"的规矩。
- 宿主端口把它交下去（`fileHostPath({ attachmentId, name })`）。**不做任何猜测**：引用里没有名字时
  仍然返回 `undefined`（由调用方如实报"这一个落不了"），不拿 id 去凑一个名字。
- 导出/导入的 v2 清单里那条记录也多一项 `name`（`{ id, kind, name?, bytes, offset }`）：落回来的时候
  要它算路径。**文件条目缺名字整包拒掉**（`file without a name`）——写这个格式的只有本插件，见到就是
  坏包；名字是空串同样拒（`malformed name`）。图片没有这一项。
- 不写 `file-objects/<sha 前两位>/<sha>` 那份内容寻址的规范副本：宿主读文件读的是
  `files/<前两位>/<sha>/<名字>`（`readFile*` 都走 `storedFilePath()`），规范副本只在**它自己**存新
  文件时按需建立。同一个内容的两个名字在本机是两条路径，在远端共享库里仍是同一个对象。
- 测试夹具跟着宿主变严：文件引用缺名字时 `pathOf()` 也抛（真宿主就是抛），否则"引用里丢了名字"只有
  真机上才看得出来。

## Alternatives considered

**让端口改用 `file-objects/<前两位>/<sha>` 那条规范路径。** 那是宿主的**内部**函数
（`storedFileObjectPath()`），没进 `ctx.attachments` 的公开面；而 `readFile*` 读的是带名字的那条，
写进去的字节根本读不着。而且它对同一个内容只留一份、"显示名"是另一个概念——端口绕开宿主自己拼路径
就等于把宿主的布局假设抄进插件，宿主一改就悄悄错。

**拿 `attachmentId` 当名字用**（凑一个 `files/<前两位>/<sha>/<id>`）。宿主读到的是一个名字像
`sha256:…` 的文件，用户在界面上看到的文件名也变成它；而且真名那一份仍然不存在，等于用"能跑"换掉了
"对"。

**在插件里把名字杀掉、只同步内容。** 文件对象不同名字是不同路径（同一份字节可以有多个显示名），只搬
内容就没法把它放回该在的位置——用户拿到的是一个打不开的引用。

## Consequences

- 修前：带文件的会话包导出时少一个对象（`missing` 里那个 file 引用），同步推不上去、拉不下来，界面
  只说"宿主容不下附件 <id>（file）"。修后：文件对象与图片一样按库落进
  `files/<sha 前两位>/<sha>/<名字>`、权限 `0o400`，远端共享库里是 `attachments/file-objects/…`。
- 这条缺口只有**真机上带文件引用的会话**才会碰到：单元测试的假端口以前按 `file-objects/<sha 前两位>/<sha>`
  算路径（比真宿主宽松），所以一直绿。夹具现在与宿主同形（缺名字就抛），这一条从此钉得住。
- v2 清单的多一个可选字段不涉及兼容：v2 这个格式只在**本插件的这次开发里**存在过，线上装得到的版本
  （0.5.0）根本不带 `attachments` 那一节。
- 引用里带的名字是**日志里的原文**，插件不解释它（合法不合法由宿主判）；名字里带路径分隔符之类的东西
  由宿主拒，插件如实报"这一个落不了"，不做替换。
