# 会话与同步的文件格式

本文写三处落盘形态：本机会话库（宿主写、本包只读）、远端同步格子（本包写）、会话包 `.dshsess`
（两边之间搬运的那一个）。字段是什么意思、落地前校验哪些不变式，都在这里；**为什么**这么定在
[.agents/notes](../.agents/notes/AGENTS.md) 里，界面与样式的规格在 [design.md](design.md)。

本机现在这个库：1436 条会话、日志合计 1097 MB。

## 本机会话库

路径按宿主的约定（本包复刻同一套口径，见 [src/paths.ts](../src/paths.ts)）：

```
<会话根>/<projectKey(cwd)>/<encodeSegment(id)>/session.vN.jsonl.zstd
```

- `projectKey(cwd)`：把工作目录折叠成一个目录名（`/home/uy_sun/dev/foo` 变成
  `--home-uy_sun-dev-foo--`）。没有 `cwd` 的会话落在 `_no-cwd`。
- `encodeSegment(id)`：把会话 id 编成单个安全路径段（非法字符写成 `~XXXX`，`~002E` 是 `.`）。
- `vN` 是**代次**：日志被整体重写一次就多一代。v0 没有版本后缀，文件名是明文的 `session.jsonl`。
- 目录里还有一枚空的 `session.lock`：宿主用它防并发写，不参与同步。

文件内容是 zstd 帧序列，解出来是「一行 header + 一行一条事件」的 JSONL。一个 323 字节的最小会话：

```json
{"type":"session","version":4,"id":"session-ca624557-…","createdAt":1794399862678,"cwd":"/home/uy_sun/.dsh","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
{"type":"permission/preset","seq":0,"time":1794399862698,"data":{"preset":"danger-full-access"}}
{"type":"sandbox/mode","seq":1,"time":1794399862698,"data":{"mode":"danger-full-access"}}
```

- **header**（首行）：`type: "session"`，带 `id`、`createdAt`、`cwd`，子智能体会话还有
  `origin: "subagent"` 与 `parentSession`。宿主加载时核「目录名 ↔ header 里的 id 与 cwd」，对不上
  直接失败，所以搬会话改路径时只能改这一行的 `cwd`（正文里的旧路径属于历史事实，保持原样）。
- **事件**（之后每行一条）：`type`、`seq`、`time`、`data`。常见的有 `user/message`、
  `assistant/message`、`turn/…`、`session/end-seed`。
- **附件不在日志里**：只有一条内容寻址的引用（`{"attachmentId":"sha256:…"}`），字节在宿主的附件库
  （`$DSH_HOME/attachments/v1/objects/<前两位>/<sha256>` 是图片，`files/…` 是文件）。
- 日志**只追加**写：同代次里文件更长，就是后来续写过。同步判断「两格副本谁更新」时用它，见下面
  「多格合并」。

## 远端同步格子

远端只是「一格格包 + 每格一份索引」，不是会话库（[src/sync.ts](../src/sync.ts)）：

```
<url>/dsh-session-manager/<machineId>/index.json                     这台机器贡献了哪些会话
<url>/dsh-session-manager/<machineId>/<encodeSegment(id)>.dshsess    一条会话一个包
<url>/dsh-session-manager/attachments/{objects,file-objects}/<前两位>/<sha256>  共享对象库
```

一张 `index.json` 只记**一台机器**自己推上去的东西：WebDAV 没有锁，多台共写一份就是后写的盖掉先写
的；各写各的格子、读别人的全部，就不需要锁。机器格名是 `encodeSegment(machineId)`，`attachments`
这个名字留给共享对象库（与机器格同级）。

索引的形状（写的时候两格缩进）：

```json
{
  "unit": "dsh-session-manager/sync",
  "version": 3,
  "machineId": "vibe-coding",
  "updatedAt": "2026-11-11T17:52:51.000Z",
  "pluginVersion": "0.6.4",
  "entries": [
    {
      "id": "session-…",
      "cwd": "/home/uy_sun/dev/dsh-session-manager",
      "title": "会话与SSH加载优化",
      "repo": "github.com/he0119/dsh-session-manager",
      "repoPath": ".",
      "createdAt": 1794399862678,
      "lastActiveAt": 1794403462678,
      "files": [{ "version": 4, "bytes": 3962826, "sha256": "…" }]
    }
  ]
}
```

| 字段 | 意思 |
| --- | --- |
| `unit` / `version` | 自描述：别的工具写进来的 `index.json` 不该被当成自己人；`version` 是索引格式版本（当前 3） |
| `machineId` / `updatedAt` / `pluginVersion` | 谁写的、什么时候、哪一版插件；只用于排查，不参与判定 |
| `entries[].files` | 每个代次一条 `{version, bytes, sha256}`：比对只看它，不必先下包 |
| `entries[].cwd` | 那条会话在这台机器上的工作目录；拉取时按它找目标目录 |
| `entries[].repo` / `repoPath` | 跨机器的项目身份（仓库 remote 归一之后）与会话 cwd 在仓库里的相对路径；没有映射时靠它落地 |
| `entries[].lastActiveAt` | 这条会话在这台机器上的最后活动时间（宿主投影里两枚钟取晚的那枚） |

索引格式的版本：1 没有时间字段；2 加 `lastPromptAt`（最后一次提问）；3 换成 `lastActiveAt`。读的一侧
三种都认——老索引里只有 `lastPromptAt` 的，拿它当活动时间。

**多格合并**：同一条会话在几格里都有时，`readRemoteLibrary()` 按下面的顺序挑一份：

1. 代次是另一个的超集、且共有代次内容一致 → 领先的那份；
2. 代次相同、内容不同 → 最高代次那个文件更长的那份（日志只追加，更长就是续写过的）；
3. 字节数也一样 → `lastActiveAt` 更新的那份；
4. 都判不出来 → 按格子名排序取第一个（结果确定，但不代表"更新"）。

一个条目约 0.4 KB，1400 多条约 0.5～0.7 MB；每次推送都是**整份重写**（WebDAV 没有局部更新）。

## 会话包 `.dshsess`

同步推的是它，界面上的「导出」产出的也是它（[src/transfer.ts](../src/transfer.ts)）：

```
gzip( 'DSHSESS1\n' | u32le 清单长度 | 清单 JSON | 各文件原始字节 | 各附件对象原始字节 )
```

- 载荷是**磁盘上的原始日志字节**，不重新编码：日志内部本来就是 zstd 帧，解了再压只会让包里的东西
  与磁盘上的东西不再是同一回事。
- 整包再 gzip 一层：对迁移重写过的未压缩帧是实打实的收益，对已压缩的大多只是几十字节开销。
- 不塞进 tar：这里只需要「清单 + 一段连续载荷」，tar 那套 512 字节头与路径限制没有用。

一个 323 字节会话打出来的包（包 712 字节，清单 488 字节）：

```json
{
  "formatVersion": 1,
  "createdAt": "2026-11-11T18:25:57.755Z",
  "source": { "sessionsRoot": "/home/uy_sun/.dsh/sessions", "pluginVersion": "0.6.4" },
  "sessions": [
    {
      "id": "session-ca624557-…",
      "cwd": "/home/uy_sun/.dsh",
      "createdAt": 1794399862678,
      "dirName": "session-ca624557-…",
      "files": [
        {
          "name": "session.v4.jsonl.zstd",
          "version": 4,
          "compression": "zstd",
          "bytes": 323,
          "offset": 0,
          "sha256": "73202de0…"
        }
      ]
    }
  ]
}
```

- 一个包里可以有多条会话；每条会话的**所有代次**都在，与磁盘一致。`offset` 是相对载荷起点的位置。
- `formatVersion` 只有两种：包里**没有**附件对象时写 1（清单里连 `attachments` 那一节都没有，装旧版
  的宿主也读得了）；真要带对象才写 2，清单多一节 `attachments`（每条记 `id`、`kind`、`name`、
  `bytes`、`offset`）。同步推的包**只有日志**，对象走上面那个共享库；`导出` 才会把对象装进包。
- 读的时候逐条校验，坏包不进导入流程：magic 认得出；版本落在 1..2；每个
  `[offset, offset + bytes)` 落在载荷内、sha256 对得上；附件对象按它 id 里的 sha 核；`dirName` 必须
  等于 `encodeSegment(id)`（宿主要拿目录名与 header 对得上）。
- 落地走 `planImport()` / `applyImport()`：把 header 里的 `cwd` 改写成**这台机器**的路径，写盘先写
  `.part` 再 rename；导入只跳过、不覆盖。

## 读写顺序

一次同步从扫本机、读远端索引到打包推送、整份重写索引的顺序，画在 [flows.md](flows.md) 的「同步」那张
图里；这里只记格式本身。
