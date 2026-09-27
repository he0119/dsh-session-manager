<img src="icon.svg" width="56" alt="">

# dsh-session-manager

DSH 的会话管理插件：把工作区与会话**搬到新目录**，以及把会话**导出 / 导入**成 `.dshsess` 包。

[中文](README.md) | [English](README.en.md)

在 DSH 里，「会话属于哪个工作区」不是可改字段，而是由会话日志 header 里的 `cwd` 推导出来的：
宿主既没有 move / reassign API，也不接受分桶与 `cwd` 不一致的日志。所以手工搬目录，轻则会话变成
Ungrouped，重则加载时报 `corrupt session log`。本插件把「改 header cwd + 移动日志目录 + 重挂工作区账本」
三件事一起做，并且每一步都能先预演、事后能逐字节回滚。（为什么必须这样，见
[docs/internals.md](docs/internals.md)。）

## 它能做什么

| 入口 | 适合什么 |
|---|---|
| 设置里的「会话管理」页 | 日常使用：勾选导出 / 导入会话包，用下拉框选目录做迁移，看预演、确认、回滚 |
| 4 个模型工具 | 直接跟会话说「把这个工作区的会话搬到 `~/dev/xxx`」，由模型先预演再落盘 |
| 离线 CLI | DSH 没启动时，或者要写脚本批处理 |

三个入口的迁移编排是同一份代码，所以预演里说会迁移几条，实做就是几条。

## 安装

从 npm 装（推荐）：

```bash
# 用宿主自己的插件命令：它会替你建/填充 profile，并维护依赖与锁文件
npx @deepseek-ai/dsh@next plugin --profile desktop add @he0119/dsh-session-manager
# 然后重启 DSH
```

开发时装本目录（`lib/` 不进 git，所以先构建）：

```bash
pnpm install && pnpm run build
npx @deepseek-ai/dsh@next plugin --profile desktop add /path/to/dsh-session-manager
# 然后重启 DSH
```

装完重启 DSH，**设置** 的左侧导航里会多出一页「会话管理」（排在官方那几页之后）。
本包**不支持** `github:` 形式的安装：仓库把构建放在 `prepublishOnly`、`lib/` 不入库，git 装法拿不到产物。

## 使用

### 设置 → 会话管理

**导入导出**——把会话带走，再带回来

- **导出**：勾选会话 → 浏览器下载一个 `.dshsess` 包。包里是这些会话**所有代次日志的原始字节**
  （逐条带 sha256），不含会话创建过的普通文件。列表**按目录分组**（组名是工作区标题；没登记过的目录
  直接显示路径并标出来），**组头那一下就是整组勾选 / 取消**——「把这个工作区的会话都带走」因此是一次点击。
- **导入**：选包 + 选目标工作区 → **先预演**（逐条列出会创建什么、`cwd` 会被改写成什么、哪些会被跳过、
  注册表会怎么变）→ 再确认落盘。导入**永不覆盖**：库里已有同 id 的会话只跳过并报告；包里没有 `cwd` 的
  会话落 `_no-cwd` 分桶，也不挂账本。

**迁移**——把一个目录的会话搬到另一个目录

- 源目录与目标目录各是一个**下拉框，框里的值就是要用的路径**；候选＝已登记工作区 **＋ 库里真有会话的
  目录**（后者带会话条数），不必凭记忆手输路径。候选之外的路径走「浏览…」或「手输路径」：
  桌面端「浏览…」弹系统目录对话框，浏览器里展开页面内的目录浏览，宿主没提供选择器时这个按钮不出现；
- 目标目录必须已存在；另有可选的新建工作区标题、是否连带**会话创建过的文件**、是否连带未登记在册的会话；
- **整个源目录一起搬，或只挑其中几条**：源目录下的会话会列出来，勾任意一条即切到「只选其中几条」，
  一次只处理一个源目录；
- **预演**：会话数、日志数、字节数、源桶 → 目标桶、**注册表会怎么变**（新建还是复用目标工作区、
  登记几条、从哪些工作区搬出、是否移除已空的工作区）、产物计划与跳过原因；
- **确认迁移**：改写每个日志 header 的 `cwd`（只动首帧，其余字节不变）→ 搬会话目录 → 重新登记 →
  **独立复核**（等价于宿主的 corrupt 判据）→ 留下字节级备份；完成后页面会告诉你这次改动是即时生效
  还是**需要重启 DSH**。

**备份与回滚**——在迁移分页下方，列出本插件写过的每一份备份（时间、会话数、源 → 目标）；
先看**回滚动作清单**再确认。回滚把会话目录、日志字节与工作区账本一起还原（空掉的目标桶也会删掉，
与迁移清理空源桶对称）。

宿主没有 `webServer` 服务时（例如只用工具的前端）这一页不出现，工具照常可用。

### 模型工具

| 工具 | 写盘 | 说明 |
|---|---|---|
| `plan_session_migration` | 否 | 只读计划：会话/文件数、目标桶、账本变更、阻塞问题 |
| `migrate_sessions` | 需 `apply:true` | 默认 dry-run；执行前做字节级备份，事后自动复核 |
| `rollback_session_migration` | 是 | 按备份目录字节级回滚 |
| `verify_workspace_sessions` | 否 | 复核某目录桶内日志与 header 的一致性 |

### 离线 CLI

CLI 由构建产出（`lib/cli.js`），装好之后也可以直接用 bin（`dsh-session-manager …`）：

```bash
pnpm install && pnpm run build

# 只读计划：不写任何字节；计划有问题时退出码 2
node lib/cli.js plan   --from '<源目录>' --to '<目标目录>'

# 执行：先字节级备份，再改写首帧、移动目录、原子落盘注册表
node lib/cli.js apply  --from '<源目录>' --to '<目标目录>'

# 只搬点名的几条（--session 可重复），--json 输出机器可读的计划
node lib/cli.js plan   --from '<源目录>' --to '<目标目录>' --session <会话 id> --json

# 复核：目标桶里每个日志是否与 header cwd 一致
node lib/cli.js verify --to '<目标目录>'

# 回滚：目录搬回 + 文件字节还原 + 注册表还原
node lib/cli.js rollback --backup '<apply 输出的备份目录>'
```

缺省路径是 `$DSH_HOME/sessions`、`$DSH_HOME/storages/workspace.json`，备份落在
`$DSH_HOME/dsh-session-manager-backups`；用 `--root` / `--registry` / `--backup` 覆盖。

## 注意事项

- **离线写盘要重启 DSH 才被承认**：宿主进程内持有一份内存注册表。若上游提供了
  `workspaceRegistry.reassignSessions()`，插件会即时生效并如实告诉你；否则工具与页面都会提示重启
  ——重启前别在旧工作区继续新增会话。
- **先看不写**：`plan` 与页面上的「预演」都不写任何字节；每次真正写盘前都会先留一份字节级备份。
- **只动首帧**：改写只重新压缩 header 那一帧，其余 frame 字节原样保留，回滚可逐字节还原
  （连同可选搬迁的会话产物）。
- **路径**：会话 `cwd` 与账本路径都不带结尾斜杠；`projectKey` 会把 `/`、`\`、`:` 折叠成 `-`，
  极少数路径会因此编码碰撞，这种情况计划层会直接拦下。
- **插件配置**：`sessionsRoot` / `registryPath` / `backupRoot` 三个可选字段可覆盖上述默认路径。

## 文档

- [docs/internals.md](docs/internals.md)——为什么是现在这样：多帧 zstd 的静默丢数据、启动不变式、
  有损编码的碰撞、`.dshsess` 容器的取舍、生效模式，以及界面上的那些取舍
- [docs/development.md](docs/development.md)——本地流程：依赖、构建、测试、开发实例
- [docs/releasing.md](docs/releasing.md)——发版流程

## 许可证

MIT
