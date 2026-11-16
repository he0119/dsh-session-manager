# Agent Note: 远端索引与备份清单在读的一侧校验

Status: implemented

## Problem

两处"从文件里读回来的元数据"原先只要求 JSON 能解析，里面的路径被直接拿去做网络请求或磁盘操作。

**远端索引**：`indexPayload()` 一直在写 `unit` 与 `version`，`docs/formats.md` 也说这两个字段是
自描述，但 `parseIndex()` 从来没看过它们——别的工具往机器格目录里放一份 `index.json`、或者将来格式
升版时，读的一侧会把里面的 `entries` 当成自己人照读。同一段里 `attachments[].id` 只判了"是非空
字符串"，而 `remoteAttachmentPath()` 直接拿 `id.slice('sha256:'.length)` 拼路径；一个写成
`sha256:aa/../../x` 的 id 能让客户端去共享库外面取文件。

**备份清单**：`readManifest()` 只做 `JSON.parse`，`rollback()` 随后按清单里的 `sourceDir` /
`targetDir` 做 `rm` 与 `rename`。清单被改坏、或者有人手工往备份根里放一份 `manifest.json` 时，
回滚能删掉 / 搬动任意目录。备份清单不是从网络来的，但它也不是"只可能由本插件写出来"的东西：
用户会手工清理、复制、恢复备份目录。

## Decision

两处都在**读**这一侧校验，写的一侧不改格式版本，旧文件照旧能读：

- **索引**：`unit` 写了就必须等于 `dsh-session-manager/sync`；`version` 写了就必须是 1..3 的整数；
  `entries` 必须是数组，且不超过 10 万条；整份正文不超过 32 MB。远端 `GET` 也带上
  `maxBytes`（`DavGetOptions`）：先看 `Content-Length`，读完再核实际长度，超限时抛 413，不把整份
  读进内存。`unit` / `version` 缺席按最早那版索引处理（那时还没有这两个字段），不因为"老文件"
  整份拒掉。
- **附件 id**：必须是 `sha256:` 加 64 位十六进制（复用 `isAttachmentId()`）。它决定远端路径，
  别的形状一律跳过，不参与补对象。
- **备份清单**：`version` 必须是 1；`sessions` / `artifacts` 的形状逐项校验；`sourceDir` /
  `targetDir` 必须是绝对路径、原文里不能带 `..`；清单里新写了 `sessionsRoot`（本次备份时本机会话库
  的根），有它时每条 `sourceDir` 必须落在它下面；`registryBackup` 与 `artifact.backupPath` 必须
  在备份目录里；`delete` / `replace` 两类备份的 `targetDir` 必须是备份目录里的那份副本；`files`
  必须是单段日志名（`parseSessionLogName()` 认得的）。
- **新备份写 `sessionsRoot`**：`createBackup()` 多收一个必填的 `sessionsRoot`，三个生产调用方
  （迁移、删除、同步覆盖）各自传自己手里的库根。老清单没有这一项，只能退到"绝对路径 + 不带 `..`"；
  这是有意的兼容面，不是漏判。

## Alternatives considered

- **只校验 `unit` 不校验 `version`**：格式升版时最需要挡住的就是"读不懂的新字段被当成旧字段用"，
  只认名字等于没认版本。
- **让回滚自己判路径，不在 `readManifest()` 里做**：`listBackups()` 也会读清单，两处各写一套判据
  迟早会分叉；放在读清单这一层，列表与回滚看到的是同一份结论。
- **把旧备份一律拒掉（要求 `sessionsRoot`）**：升级之后用户手里的备份会全部失效，而它们多数只是
  缺一个字段；老清单退到"绝对路径 + 不带 `..`"，同时新清单严格判归属，代价与收益更平衡。
- **给附件 id 只判正则不判长度**：`sha256:` 后面 64 位十六进制是内容寻址的名字本身，短了或长了都
  不是本插件写出来的东西；只判"像 sha256" 会让 `aa/../../x` 这种仍然过。
- **索引里 `entries` 超限时截断着读**：截断等于悄悄少看几条会话，同步会据此做出错误裁决；整份跳过
  并报一句更诚实。

## Consequences

- 老索引（没有 `unit` / `version`）照旧读；写了但写错的索引整份跳过，问题清单里点名是哪台机器。
- 老备份（没有 `sessionsRoot`）照旧能列、能回滚，只是判据弱一档；新备份的清单形状多一个字段，
  `readManifest()` 返回的对象里也带上它。
- 坏的备份清单从"回滚时才发现"提前到"列清单时就被跳过"；`rollback_session_migration` 拿到坏清单会
  直接报错，不会先动一个字节。
- 索引与备份清单的上限都是常量（`MAX_INDEX_TEXT_BYTES` / `MAX_INDEX_ENTRIES`）；真出现更大的正常
  数据时要同时改常量与这条笔记。
