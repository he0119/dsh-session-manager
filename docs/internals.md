# 内部设计

用法看 [README](../README.md)，本地流程看 [development.md](development.md)。这里放「为什么是现在这样」。

## 迁移会话为什么不是「改一个字段」

DSH 里「会话属于哪个工作区」不是可改字段，而是由会话日志 header 的 `cwd` 推导出来的：

- 宿主用 `projectKey(cwd)` 决定日志所在目录：`<root>/<projectKey(cwd)>/<encodeSegment(id)>/`
- 加载时校验「文件所在分桶 == `projectKey(header.cwd)`」，不一致即抛
  `corrupt session log … header id and cwd identify …`——**硬失败，不是降级**
- `@deepseek-ai/dsh-workspace` 的 README 明确写着「来自其他目录的会话无法移入」，且公开 API
  （`create` / `get` / `list` / `delete` / `insertBefore` / `archiveSession` / `resolveByPath`）
  **没有任何 reassign / move**

所以迁移必须是三件事同时一致地做：**改 header cwd + 移动日志目录 + 改注册表账本**。
少做一件，要么会话加载不了，要么它变成 Ungrouped。

## 多帧 zstd：把静默数据丢失变成启动期硬失败

宿主按「一条事件一次 flush」追加写日志，磁盘上的 `.zstd` 因此是**多帧拼接**（实测单文件可达上千帧，
最大见过 6.5MB 压缩 / 33MB 明文 / 1962 帧）。而 `node:zlib` 的 `zstdDecompress(Sync)` /
`createZstdDecompress` **只解第一帧、其余静默丢弃**，连截断帧都不报错——只解首帧就只剩 session 头
那一行，整个会话看起来「没有内容」。

这个坑在本仓库的开发过程中**真的发生过一次**（21 个日志被截成 ~180 字节），靠执行前的字节级备份才
完整恢复。因此这里不是写注释提醒，而是让它变成硬失败：

- 解码器由调用方注入，核心层自己**不挑**解码器；
- `assertMultiFrameAware()` 构造两个 raw 帧、期望读回 `"AB"`，只解首帧的解码器会让它抛错；
- 回归用例里**直接用 `node:zlib` 验证这条守卫确实会拒绝它**。

## 只重写第一个 frame

改写时只重新压缩**首个 frame**，其余 frame 字节**原样保留**。三个理由：

1. 产出结构与宿主自己写出的多帧布局一致，任何能读宿主日志的解码器都能读；
2. 尾部在字节层面可审计地不变（端到端用例逐行比对，回滚后逐字节断言还原）；
3. 最省——一条 1.8MB 的日志只需重新压缩 ~180 字节。

首帧边界**不靠猜魔数**（压缩载荷里可能偶然出现魔术字节），而是用自洽性判定：找最小偏移 `i` 使

```
decodeAll(buf[0..i)) + decodeAll(buf[i..)) === decodeAll(buf)
```

且前半段是完整的行。截断帧会被解码器抛错或被该等式排除。可解码的输入恒有切分（`i = buf.length`
退化为整份单帧），所以 `null` 分支对可解码输入不可达——这是有意的保守设计，不是遗漏。

## 写侧为什么零依赖

`fzstd` 只能解压、不能压缩；`node:zlib` 内置 zstd 有 Node 版本下限（本包 `engines` 写的是 `>=22.13`，
按 Node 的 zstd 支持时间线，内置 zstd 大约从 22.15 / 23.8 才有）。两者都不能作为写侧依赖。

`encodeRawFrame()` 因此手写了一个只含单个 **raw（未压缩）block** 的合法 zstd 帧
（Single_Segment=1、Block_Type=Raw、无校验和），代价是首帧不压缩——而首帧本来就只有一个 header 行，
压缩收益可忽略。这样写侧不依赖任何压缩器、外部二进制或 Node 版本特性。

## 启动不变式：违反就是启动直接报错

宿主的 `WorkspaceRegistry` 在启动时校验已存状态，以下任一都让**启动失败**（不是静默降级）：

- 两个 workspace 记录的 `path` 相同
- 同一个 `sessionId` 出现在多个工作区账本里
- `global.workspaceIds` 有重复
- `global.workspaceIds` 的集合 != `tables.workspaces` 的键集合（顺序漂移）

`validateRegistry()` 复刻这四条，`reHome()` 在操作**前**与操作**后**各校验一次，因此不可能产出
让宿启动失败的注册表。

## 有损编码的碰撞

`projectKey` 把 `/`、`\`、`:` 折叠成 `-` 并截断到 251 字符，所以 `C:\x\y` 与 `C:\x-y` 编码结果
**相同**，而宿主的 `realpath` 唯一性检查抓不到这种碰撞。计划层因此在动手前显式检查源/目标桶名
是否相同，`detectProjectKeyCollision()` 作为通用工具暴露。

## 产物的证据分层，与两个必须做的收窄

「这个会话创建了哪些文件」只有强弱不同的证据：

| 证据 | 强度 | 语义 |
|---|---|---|
| `write` 工具的 `file_path` | 权威 | 创建 |
| `deliverables/presented` | 权威 | 主动交付 |
| `edit` 工具的 `file_path` | 权威 | 修改（非创建） |
| `pwsh`/`bash` 命令里的造物路径 | 启发式 | 需含造物动词才计为候选 |

不做收窄的计划会很难用，因此有两道：

- **与磁盘存在性求交**——实测 51 个候选里 39 个早已被会话自己删掉；
- **嵌套剪枝**——某目录要整体搬走时，它内部的文件不再单独搬一遍。

## 生效模式：为什么离线落盘要重启

`WorkspaceRegistry` 持有**内存**注册表与一个 header 索引，而重建该索引的 `replaceHeaderIndex`
是**私有**方法。于是离线改写 `workspace.json` 之后：

- 注册表会被宿主的旧内存副本覆盖；
- 即使不覆盖，宿主的索引仍是旧的，被搬走的会话会被过滤成 Ungrouped。

`effectMode(ctx)` 因此**如实探测**：上游若提供 `workspaceRegistry.reassignSessions` 就走进程内
即时生效，否则返回 `restart-required`，由工具返回值告诉调用方「必须重启 DSH」。不假装即时生效。

## 验证：哪一层证明什么

| 层 | 证明的事 | 位置 |
|---|---|---|
| 单元 | `projectKey`/`encodeSegment` 与宿主逐字节一致；有损碰撞确实存在 | `test/project-key.test.mjs` |
| 单元 | 多帧原语、首帧边界、**多帧感知守卫会拒绝 `node:zlib`** | `test/zstd-frame.test.mjs` |
| 单元 | 保结构改写只动 header；拒绝错 cwd / 非 header / 首帧多行 | `test/session-log.test.mjs` |
| 单元 | 启动四条不变式逐类可抓；`reHome` 前后校验 | `test/registry.test.mjs` |
| 单元 | 产物证据分层、存在性求交、嵌套剪枝 | `test/artifacts.test.mjs` |
| 端到端 | 沙箱内造多帧日志 + 注册表，跑 `plan → apply → verify → rollback`，断言**逐字节**还原 | `test/engine.test.mjs` |
| 契约 | 用**真实 `@deepseek-ai/dsh-tools`** 走 `defineTool`：schema 归一化、实参校验、真实执行 | `test/tools.test.mjs` |
| 真实数据 | 本机真实会话日志（多帧）+ 真实注册表（84 个工作区） | `test/real-data.test.mjs`、`test/registry.test.mjs` |

真实数据那一层是回归锚点：它对着**宿主自己写出来的**文件验，而不是对着我们造的形状验。
