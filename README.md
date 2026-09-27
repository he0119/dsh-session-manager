# dsh-session-manager

把 DSH 的工作区与会话迁移到新目录：改写会话日志 `cwd`、迁移日志目录、重挂 workspace 归属，
并可选择性搬迁"会话中创建的文件"。

[中文](README.md) | [English](README.en.md)

> **状态**
> - ✅ 核心层 / 迁移引擎 / 离线 CLI / 插件外壳与 4 个工具
> - ✅ 会话管理：设置里的一页（`settings.section`，页内分导入导出与迁移）+ 6 个端点
> - ✅ 工具契约用**真实的 `@deepseek-ai/dsh-tools`** 验证（`defineTool` 归一化 + 实参校验 + 真实执行）
> - ✅ 会话产物搬迁（`artifacts.mjs`）：证据分层 + 存在性求交 + 嵌套剪枝，可随会话一起回滚
> - ✅ 源码为 TypeScript，`src/*.ts` → tsdown → `lib/`（构建产物不进 git）；`tsc` 类型检查与构建均通过
> - ✅ **99 个用例通过 97 条**（含真实日志、真实注册表、端到端回滚的字节级断言、构建产物冒烟；
>   另 2 条按环境变量门控跳过）
> - ✅ 仓库工程化对齐参考项目：`.gitattributes`(全 LF)、`.gitignore`、`docs/`、双语 README、
>   `.github/workflows/ci.yml`、`pnpm-workspace.yaml`、`icon.svg`、`LICENSE`、engines/scripts 约定
> - ⏳ 待你确认：装进哪个 profile 并重启 DSH，在真实实例里加载这 4 个工具、打开设置里那一页
>   （页面样式只做到构建与产物契约级验证，还没在真实 GUI 里看过）

## 它解决什么问题

DSH 里"会话属于哪个工作区"**不是**一个可改的字段，而是由日志 header 的 `cwd` 推导：

- 宿主用 `projectKey(cwd)` 决定日志目录：`<root>/<projectKey(cwd)>/<encodeSegment(id)>/`
- 加载时校验"文件所在分桶 == `projectKey(header.cwd)`"，不一致即抛
  `corrupt session log ... header id and cwd identify ...`（**硬失败**）
- `@deepseek-ai/dsh-workspace` 的 README 明确写着"来自其他目录的会话无法移入"，
  且公开 API（`create/get/list/delete/insertBefore/archiveSession/resolveByPath`）
  **没有任何 reassign / move**

所以迁移必须三件事同时一致地做：**改 header cwd + 移动日志目录 + 改注册表账本**。

## 用法

### CLI（离线，今天就能用）

```bash
pnpm install && pnpm run build    # 源码是 TypeScript，CLI 由构建产出 lib/cli.js

# 只读计划：不写任何字节
node lib/cli.js plan   --from '<源目录>' --to '<目标目录>'

# 执行：先字节级备份，再改写首帧、移动目录、原子落盘注册表
node lib/cli.js apply  --from '<源目录>' --to '<目标目录>'

# 复核：检查目标桶里每个日志是否与 header cwd 一致（等价宿主的 corrupt 判据）
node lib/cli.js verify --to '<目标目录>'

# 回滚：目录搬回 + 文件字节还原 + 注册表还原
node lib/cli.js rollback --backup '<apply 输出的备份目录>'
```

装好之后也可以直接用 bin（`dsh-session-manager plan …`）。

缺省路径为 `$DSH_HOME/sessions`、`$DSH_HOME/storages/workspace.json`，
可用 `--root` / `--registry` / `--backup` 覆盖。`plan` 有问题时退出码 2，不执行任何写。

### 插件工具（模型可调用）

| 工具 | 写盘 | 说明 |
|---|---|---|
| `plan_session_migration` | 否 | 只读计划：会话/文件数、目标桶、账本变更、阻塞问题 |
| `migrate_sessions` | 需 `apply:true` | 默认 dry-run；执行前做字节级备份，事后自动复核 |
| `rollback_session_migration` | 是 | 按备份目录字节级回滚 |
| `verify_workspace_sessions` | 否 | 复核某目录桶内日志与 header 的一致性 |

### 会话管理（Web 界面）

装进 profile 后，**设置** 的左侧导航里会多出一页「会话管理」（本包自带 Web Client 半边），
页内分两页：

**导入导出**（把会话带走/带回来）

- **导出**：勾选会话 → 浏览器下载一个 `.dhsess` 包。包里是这些会话**所有代次日志的原始字节**
  （逐条带 sha256），不含会话创建过的普通文件。
- **导入**：选包 + 选目标工作区 → **先预演**（逐条列出会创建什么、cwd 会被改写成什么、哪些会被
  跳过、注册表会怎么变）→ 再确认落盘。导入**永不覆盖**：库里已有同 id 的会话只跳过并报告；
  包里没有 cwd 的会话落 `_no-cwd` 分桶，也不挂账本。

**迁移**（把一个工作区的会话搬到另一个目录）

以前只有 CLI 与模型工具能做这件事，现在同一份编排（`src/migrate.ts`，三个入口共用）也摆在界面上：

- 源目录可以从下拉里挑（候选＝已登记工作区 **+ 库里真有会话的目录**，后者带会话条数），不必凭记忆手输路径；
- 目标目录（必须已存在）、可选的新建工作区标题、是否连带**会话创建过的文件**、是否连带未登记的会话；
- **整个源目录一起搬，或只挑其中几条**：源目录下的会话会列出来，勾任意一条即切到"只选其中几条"，
  一次只处理一个源目录（一个请求对一个分桶）；
- **预演**：会话数、日志数、字节数、源桶 → 目标桶、**注册表会怎么变**（新建还是复用目标工作区、
  登记几条、从哪些工作区搬出、是否移除空工作区）、产物计划与跳过原因；
- **确认迁移**：改写每个日志 header 的 `cwd`（只动首帧，其余字节不变）→ 搬会话目录 → 重新登记 →
  **独立复核**（等价于宿主的 corrupt 判据）→ 留下字节级备份；
- **备份与回滚**：列出本插件的每一份备份（时间、会话数、源 → 目标），先看**回滚动作清单**再确认；
  回滚把目录、日志字节与注册表一起还原（空掉的目标桶也会删掉，与迁移清理空源桶对称）。

端点都在 `/dsh-session-manager/api` 下（`state` / `export` / `import` / `migrate` / `backups` /
`rollback`），写盘只发生在宿主进程里；宿主没有 `webServer` 服务时（例如只用工具的前端）插件照常起，
只是这一页不出现。包的形状、越界与不变式见 [docs/internals.md](docs/internals.md)。

### 何时生效（双模式）

`workspaceRegistry` 持有**内存**注册表与一个 header 索引，重建索引的
`replaceHeaderIndex` 是私有方法。因此：

- **上游提供 `workspaceRegistry.reassignSessions()` 时** → `effectMode()` 探测到后走即时生效；
- **否则** → 离线落盘正确，但**必须重启 DSH** 才会被承认。

工具返回值里的 `takesEffect` 会如实告诉调用方当前处于哪种模式，而不是假装即时生效。

## 安装到 profile

从 npm 装（推荐）：

```bash
# 用 DSH 自带的插件命令（它会替你建/填充 profile，并维护依赖与锁文件）
npx @deepseek-ai/dsh@next plugin --profile desktop add @he0119/dsh-session-manager
# 然后重启 DSH
```

开发时装本目录（`lib/` 不进 git，所以先构建）：

```bash
pnpm run build
npx @deepseek-ai/dsh@next plugin --profile desktop add /path/to/dsh-session-manager
# 然后重启 DSH
```

本包**不支持** `github:` 形式的安装（那需要包里有 `prepare` 脚本；本仓库把构建放在
`prepublishOnly`，`lib/` 不入库，git 装法拿不到产物）。

机制：`profiles/<name>/cordis.yml` 本身是空的 `[]`，实际由「`package.json` 的
`dsh.profile.bundles`（每个 bundle 贡献自己的 `cordis.patch.yml`）」+「profile 自己的
`cordis.patch.yml`（id 定向配置）」+ `--patch` 叠加而成。所以装插件 = 把包放进
`node_modules` + 把包名加进 `dsh.profile.bundles`。

`--profile <name>` 选目标 profile（`dsh <name>` 就是 `dsh --profile <name>`）。
**不要在日常在用的实例上做开发验证**：另建一个开发 profile、在另一个端口上起它（见
[docs/development.md](docs/development.md)）。

## 会话产物（可选）

`includeArtifacts` 打开时，会从会话日志里还原"这个会话创建了哪些文件"并随之搬迁。
证据**分层**（这是本模块的核心取舍）：

| 证据 | 强度 | 语义 |
|---|---|---|
| `write` 工具的 `file_path` | 权威 | 创建 |
| `deliverables/presented` | 权威 | 主动交付 |
| `edit` 工具的 `file_path` | 权威 | **修改**（非创建，默认也搬，可用 `includeKinds` 排除） |
| `pwsh`/`bash` 命令里的造物路径 | 启发式 | 需含造物动词才计为候选 |

两个必须做的收窄，否则计划会很难用：

- **与磁盘存在性求交**——实测 51 个候选里 39 个早已被会话自己删掉；
- **嵌套剪枝**——某目录要整体搬走时，它内部的文件不再单独搬一遍。

产物会被纳入同一份备份清单，因此 `rollback` 能把它们一起字节级还原。

> 注意：提取需要**全量解码**会话日志（多帧全解），比只解首帧的发现阶段慢得多，
> 因此只在显式要求时才做。

## 关键设计约束

### 1. 多帧 zstd：只用多帧感知的解码器

宿主按"一条事件一次 flush"追加写日志，磁盘上的 `.zstd` 是**多帧拼接**（实测单文件可达上千帧）。
`node:zlib` 的 `zstdDecompress(Sync)` / `createZstdDecompress` **只解第一帧、其余静默丢弃**，
连截断都不报错——只解首帧就只剩 session 头一行，整个会话看起来"没有内容"。

本插件不自己挑解码器，而是由调用方注入，并用 `assertMultiFrameAware()` 在启动期
**主动探测**该解码器是否只解首帧（构造两个 raw 帧，期望读回 `"AB"`）。
这条守卫把静默数据丢失变成启动期硬失败；回归用例里直接用 `node:zlib` 验证它确实会拒绝。

### 2. 只重写第一个 frame

改写时只重新压缩**首个 frame**，其余 frame 字节**原样保留**。因此产出结构与宿主自己写出的
多帧布局一致，且尾部在字节层面可审计地不变（端到端用例逐行比对，回滚后逐字节断言还原）。

首帧边界不靠猜魔数，而是用自洽性判定：找最小偏移 `i` 使
`decodeAll(buf[0..i)) + decodeAll(buf[i..)) === decodeAll(buf)`，且首帧以换行结尾。

### 3. 写侧零依赖

`fzstd` 只能解压、不能压缩；`node:zlib` 内置 zstd 有 Node 版本下限（本包 `engines` 仍写 `>=22.13`）。
因此 `encodeRawFrame()` 手写了一个只含单个 **raw（未压缩）block** 的合法 zstd 帧
（Single_Segment=1、Block_Type=Raw），使写侧不依赖任何压缩器或外部二进制。

### 4. 启动不变式（违反 = 启动直接报错）

`validateRegistry()` 复刻宿主的启动校验，`reHome()` 在操作**前**与操作**后**各校验一次：

- 两个 workspace 记录的 `path` 不得相同
- 同一个 `sessionId` 不得出现在多个工作区账本里
- `global.workspaceIds` 不得有重复
- `global.workspaceIds` 的集合必须 == `tables.workspaces` 的键集合（顺序漂移即报错）

### 5. 有损编码的碰撞

`projectKey` 会把 `/`、`\`、`:` 折叠成 `-` 并截断到 251 字符，因此
`C:\x\y` 与 `C:\x-y` 编码结果**相同**，而宿主的 `realpath` 唯一性检查抓不到。
`detectProjectKeyCollision()` 与计划层的碰撞检查用于在动手前拦住它。

## 目录结构

`src/` 是源码（TypeScript），`lib/` 是构建产物（tsdown 输出，不进 git）。

| 文件 | 职责 | DSH 依赖 |
|---|---|---|
| `src/project-key.ts` | 逐字符复刻宿主 `projectKey()` + 有损碰撞检测 | 无 |
| `src/paths.ts` | `encodeSegment()`、代次文件名、会话目录/日志路径 | 无 |
| `src/zstd-frame.ts` | raw 帧编码、首帧边界定位、多帧感知守卫 | 无 |
| `src/session-log.ts` | 单日志读取与**保结构** cwd 改写 | 无 |
| `src/registry.ts` | 注册表启动不变式校验、`reHome()`、原子落盘 | 无 |
| `src/discovery.ts` | 分桶扫描 + 只解首帧读 header（发现阶段快） | 无 |
| `src/plan.ts` | 只读计划：目标推导、阻塞问题、账本变更 | 无 |
| `src/journal.ts` | 字节级备份清单与回滚 | 无 |
| `src/execute.ts` | 执行 + 独立复核（含产物目标位校验） | 无 |
| `src/artifacts.ts` | 会话产物提取（证据分层）、规划（求交/剪枝）、搬迁 | 无 |
| `src/transfer.ts` | `.dhsess` 容器（导出/解析/校验）、导入预演与落地 | 无 |
| `src/migrate.ts` | 迁移编排：预演 / 执行 / 回滚 / 备份清单（CLI、工具、界面三个入口共用） | 无 |
| `src/cli.ts` | 离线 CLI（plan/apply/verify/rollback）→ `lib/cli.js` | 无 |
| `src/tools.ts` | 4 个工具注册 | `dsh-tools` |
| `src/web.ts` | 界面端点（列会话 / 导出 / 导入 / 迁移 / 备份 / 回滚），只要求 `{ register }` 形状 | 无 |
| `src/client/*` | Web Client 半边：「会话管理」页（页内分导入导出与迁移）、字典、样式、端点调用 → `lib/client.js` | 无 |
| `src/index.ts` | 插件入口 `apply(ctx, config)` | `dsh-tools` |

核心层保持零 DSH 依赖，所以既能被插件复用，也能被 CLI 复用，还能被独立测试。

## 测试

```bash
pnpm install          # 测试直接 import src/*.ts（原生类型剥离），只需装好 peer 依赖 dsh-tools
node test/run-all.mjs
# 带真实数据回归（指向任一含会话桶的 sessions/ 备份目录）：
DSM_FIXTURE=/path/to/backup node test/run-all.mjs
```

**不要用 `node --test`**：它会为每个测试文件 spawn 子进程（piped stdio），
在 DSH 的 Windows 沙箱下必然 `spawn EPERM`，与测试内容无关。
`test/run-all.mjs` 在同一进程内依次 import 各测试文件，绕开该边界。

`test/engine.test.ts` 是真正的端到端：在隔离沙箱里造多帧日志与注册表，
跑 `plan → apply → verify → rollback`，并断言回滚后**逐字节**回到原状。
它用真实的沙箱目录作为 cwd，因为计划层会用 `existsSync(to)` 校验目标目录真实存在。

`test/tools.test.ts` 会 `import '@deepseek-ai/dsh-tools'`（列为 devDependency）来断言真实的
工具注册契约，因此装好依赖后这组不会跳过。

`pnpm test` = `node test/run-all.mjs`；`pnpm run check` = `tsc` 类型检查 + 测试。

`test/artifact.test.mjs` 是**构建产物**冒烟：加载 `lib/index.js`，断言入口字段、4 个工具注册、
界面端点注册与 `apply()` 的卸载函数契约——补上「源码通过」与「产物能装进宿主」之间那一环。
`test/client.test.mjs` 是同一件事在 Web Client 半边的版本：用假的 `window.__ModuleLoader__`
按模块加载器的契约执行 `lib/client.js`，断言工厂 id、导出面、注册到的槽位与两份字典的键集。
两者的产物都不存在时跳过；`pnpm run build && pnpm test` 是全绿口径。

`test/transfer.test.ts` 覆盖 `.dhsess` 的字节往返、包校验的拒绝面（sha256/截断/magic/版本）、
导入预演与落地、同 id 冲突只跳过、无 cwd 与明文 v0 日志两条分支；`test/web.test.ts` 用假
req/res 直接打端点，覆盖列会话、导出、导入（预演/落地）与各条 400/404/409 拒绝面。
真实数据那一条用 `DSM_SMOKE_WORKSPACE` 门控，会额外断言只读 `plan` 没有创建目标桶。

## 文档

- [docs/internals.md](docs/internals.md)——「为什么是现在这样」：不变式、多帧陷阱、生效模式，
  以及「验证：哪一层证明什么」
- [docs/development.md](docs/development.md)——本地流程：依赖、测试、为什么不用 `node --test`、
  工具层测试怎么拿到真实的 `dsh-tools`、开发实例

## 许可证

MIT
