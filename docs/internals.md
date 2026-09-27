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

## `.dhsess` 包：一条 gzip 流，而不是 tar

容器是「magic + 清单 + 原始载荷」拼起来再整包 gzip：

```
gzip( 'DSHSESS1\n' | u32le 清单长度 | 清单 JSON | 各文件的原始字节 )
```

三个取舍：

- **不用 tar**：这里只需要「清单 + 一段连续载荷」，而 tar 的 512 字节头、路径长度限制与 PAX
  扩展在这个固定用途上全是负担。tar 换来的好处（`tar -xf` 就能拆）在这里也不成立——拆出来
  的单帧文件本身还得按宿主的目录布局摆回去。
- **载荷是原始日志字节，不重新编码**：日志内部本来就是 zstd 帧。解了再压会让「导出的东西」
  与「磁盘上的东西」不再是一回事，而本包的立足点正是字节级可复原。
- **整包 gzip，而不是逐文件压**：日志的 zstd 帧大多已是压缩态，逐文件再压收益接近零，却把
  「解出来看一眼」变成要写代码的事；整包 gzip 对**迁移重写过的 raw-block 帧**（未压缩）是
  实打实的收益，对已压缩的也只是几十字节。

`readBundle()` 在导入之前逐条校验，任何一条不过就直接拒绝，坏包进不了会话库：

| 校验 | 挡下什么 |
|---|---|
| magic 与 `formatVersion` | 不是 `.dhsess`、或是换代后本包读不懂的包 |
| 每个条目的 `[offset, offset+bytes)` 落在载荷内 | 清单被改坏、偏移溢出 |
| 每个条目的 sha256 | 载荷被截断或改动了一个字节 |
| 会话目录名 == `encodeSegment(id)` | 宿主启动时会校验目录名与 header id 一致，不满足的包会污染会话库 |

## 导入为什么「只跳过、不覆盖」

导入是**跨实例**的操作：同一个 id 在源库里是唯一的一条会话，在目标库里可能已经存在（曾经导过、
或本来就是同一台机器）。三种处理里，覆盖最危险（会顶掉目标库里那条会话的历史），合并语义上不可
判定（两条日志没有共同的祖先），所以这里只留一条：**冲突只报告**。预演里那条会话标成 skip 并附上
它在库里的位置，落地时创建数为 0 就直接 409。

无 cwd 的会话（`_no-cwd` 桶）同样不硬塞：保持没有 cwd、不参与注册表重挂。给它编一个 cwd 会让
header 声称一个它从未工作过的目录。

落地时每个文件先写成 `<规范名>.part` 再 rename：`parseSessionLogName` 不认 `.part`，所以中途
崩溃留下的是「发现阶段会忽略的文件」，而不是一个只有半截日志、看起来却正常的会话。

## 同一份迁移编排，三个入口

迁移这件事有三个入口：离线 CLI、模型工具（4 个里的 3 个）、设置里的「会话管理 → 迁移」分页。
它们的**编排只有一份**（`src/migrate.ts`：预演 / 执行 / 回滚 / 备份清单），各入口只负责把结果
翻译成自己的形状。不这样做的代价不是"多写点代码"，而是**同一件事在三个地方给出三种说法**：
工具说"会迁移 3 条"，界面说"会迁移 4 条"，用户就没有理由相信任何一个。

同一条原则落在两处细节上：

- **界面与工具调的是同一个 `runMigration()`**，`apply:false` 就是预演。所以"预览和实做不一致"
  在这种结构下不可能发生——它们本来就是同一次计算，只是一个不落盘。
- **注册表的前置校验（`loadRegistryForWrite`）在这条链路的最前面**：注册表不满足启动不变式时
  一律拒绝，而不是"先在坏账本上叠一层改动，回头再说"。

界面这一侧另加一条**越界拒绝**：回滚只认 `backupRoot` 下面的目录（`assertBackupDir`）。回滚会按
清单里的路径搬目录、按字节还原日志、恢复注册表，等于"以清单为准的任意写"；界面能传的字符串
不该换来这种权力，所以路径检查放在宿主侧，而不是指望前端不乱传。

最后是一个容易被忽略的对称性：`applyPlan` 会删掉空掉的**源**桶（`execute.ts` 第 5 步），
回滚如果不对称地做，就会在会话根下留下一个空目录。`rollback()` 因此也删空掉的**目标**桶
（只删确认为空的），`test/migrate.test.ts` 把这条钉住了。

**"只迁其中几条"的边界在分桶，不在界面**：一次请求只处理**一个源目录**（源桶由 `from` 决定），
`sessionIds` 只做子集筛选——所以界面列的会话**只是勾选面**，真正搬哪些由宿主按源桶里的实际内容算。
两个后果是刻意的：点名的会话不在源桶里时预演直接报 problem（不静默少搬）；`reHome` 只摘走被点名的
id，**源工作区只有在被搬空时才从账本上删掉**——搬走一半却把整条工作区记录删了，等于让剩下那几条
会话变成孤儿。`test/migrate.test.ts`（编排层）与 `test/web.test.ts`（端点层）各钉了一条。

## Web Client 半边的两条硬约束

**一、产物必须是一个经典脚本。** DSH 的客户端模块系统只认
`window.__ModuleLoader__.load({ id, factory })` 这种方式报名的脚本，工厂拿到一个同步的
`require`，返回的 `module.exports` 就是插件的导出面（`inject` 与 `apply`）。因此 tsdown 的
client 一份配置是 `format: 'cjs'` 外面套三行（banner/intro/footer），只有平台基线模块
（`react`、`react/jsx-runtime`）保持 `require`，其余一律内联——客户端模块系统没有旁挂依赖的路由。
`test/client.test.mjs` 用假的加载器与假 `require` 按这份契约执行 `lib/client.js`：契约错了在
源码层面看不出来，只有跑一遍产物才知道。

**二、不 require 宿主的 UI 原语包。** 那份包不是稳定契约（`dsh.client.inject` 的条目只用于
激活排序，不构成依赖保证），而它一旦在某些版本里抛异常，整个槽位条目会被替换成崩溃占位
（控制台里是 `slot entry crashed in '<slot>'`），用户看到的是空白而不是错误。所以控件全部手写，
颜色只用 `Theme` 检查面列出的 `--dsw-alias-*` token（每个都带中性回落值，深浅主题自动跟随），
类名收在自己的 `dsm-` 前缀下。

注册进 `settings.section`：设置左侧导航里的一页，与「通用 / 模型 / 插件 / 账户 / Agent 预设」
并列，`order: 30` 排它们之后。相近的槽位有两个，各有一个真问题，所以都没选：

- `plugins.detail.section`（插件详情页配置/行列表之后的一段）：归属感最贴，但要按 subject
  （`item` / `row` / `bundle`）自过滤，而判断依据是**包在插件管理器里的表示形态**；猜错不报错、
  只是永远不渲染——静默空白最难发现。它还会在包内每一行的页面上各渲染一次，而本页要的是整页宽高。
- `settings.plugins.tab`（「插件」设置区里的一个页签）：那条页签栏的语义是「插件列表的视图」，
  一个功能页挤进去属于借位。

注册走 `ctx.slots.inject(slot, () => ctx.slots.register(...))` 而不是直接 register：目标槽位
由设置外壳在运行时声明，那个声明完全可能晚于本插件 `apply`。`label` 给的是 thunk：外壳投影
导航行时走 `resolveSlotLabel`（是函数就调用），并且订阅了 locale 快照，所以切语言或后到的
字典都会让那一行重新投影，不必自己重新注册——`test/client.test.mjs` 把这条也钉住了。

## 宿主侧的一条硬约束：可选服务只能用 `ctx.get` / `ctx.inject`

Cordis 的 Context 是个 Proxy，**服务属性只有在当前 fiber 的 `inject` 里声明过才可读**，否则同步抛
`cannot get property "X" without inject`——**即使那个服务确实存在**。所以：

- 硬依赖写进 `inject`（本插件是 `tools`）；
- 可选服务（`webServer`、`workspaceRegistry`）走 `ctx.get(name)`，或用 `ctx.inject([name], cb)`
  开一个子 fiber——后者顺带解决顺序问题：服务由别的 bundle 提供、晚于本插件到位时，回调会在它
  到位后跑，端点不会永远缺席；
- 卸载时子 fiber 随父 fiber 一起释放，所以 `ctx.inject` 里注册的路由不需要再手工收集。

这条坑的隐蔽之处在测试里：**根 context（fiber 没有 runtime）走的是非严格路径**，属性读法在
根上、或从根 `provide` 的服务上都能蒙对。纯对象假 ctx 更是完全读得到。本插件因此在真实 profile
里整个起不来（`web-dev` 的日志：`cannot get property "webServer" without inject`），而当时的假
ctx 测试全绿。`test/artifact.test.mjs` 与 `test/tools.test.ts` 现在都在**真实 Cordis 的 fiber 上**、
并由**兄弟** fiber 提供服务，就是为了让这类错误在测试里就炸。

## 验证：哪一层证明什么

| 层 | 证明的事 | 位置 |
|---|---|---|
| 单元 | `projectKey`/`encodeSegment` 与宿主逐字节一致；有损碰撞确实存在 | `test/project-key.test.ts` |
| 单元 | 多帧原语、首帧边界、**多帧感知守卫会拒绝 `node:zlib`** | `test/zstd-frame.test.ts` |
| 单元 | 保结构改写只动 header；拒绝错 cwd / 非 header / 首帧多行 | `test/session-log.test.ts` |
| 单元 | 启动四条不变式逐类可抓；`reHome` 前后校验 | `test/registry.test.ts` |
| 单元 | 产物证据分层、存在性求交、嵌套剪枝 | `test/artifacts.test.ts` |
| 单元 | `.dhsess` 字节往返、包校验的拒绝面、导入预演/落地/冲突跳过 | `test/transfer.test.ts` |
| 单元 | 迁移编排：预演只读、dry-run 零写入、执行后复核、回滚还原、**备份目录越界一律拒** | `test/migrate.test.ts` |
| 单元 | 界面端点：列会话、导出、导入、迁移预演/落地、备份列表、回滚与各条 400/404/409 | `test/web.test.ts` |
| 产物契约 | 按模块加载器契约执行 `lib/client.js`：id、导出面、槽位、字典键集、导航文案跟语言走、页内两个分页都在 | `test/client.test.mjs` |
| 宿主契约 | 在**真实 Cordis fiber** 里加载 `lib/index.js`：激活、可选服务探测、六条路由随 webServer 到位而挂、卸载摘干净 | `test/artifact.test.mjs` |
| 端到端 | 沙箱内造多帧日志 + 注册表，跑 `plan → apply → verify → rollback`，断言**逐字节**还原 | `test/engine.test.ts` |
| 契约 | 用**真实 `@deepseek-ai/dsh-tools`** 走 `defineTool`：schema 归一化、实参校验、真实执行（同样跑在真实 fiber 上） | `test/tools.test.ts` |
| 真实数据 | 本机真实会话日志（多帧）+ 真实注册表（84 个工作区） | `test/real-data.test.ts`、`test/registry.test.ts` |

真实数据那一层是回归锚点：它对着**宿主自己写出来的**文件验，而不是对着我们造的形状验。
