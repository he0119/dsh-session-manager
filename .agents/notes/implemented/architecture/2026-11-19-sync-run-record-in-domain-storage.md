# Agent Note: 上一次同步那条记录搬进官方领域存储

Status: implemented

## Problem

「上次同步成没成、拉了几条、哪几条没做到」这条记录，原来由插件自己拼路径写
`<DSH_HOME>/dsh-session-manager/state.json`：`syncStatePath()` 算位置、临时文件 + rename 写盘、自己写一份
判形状的守卫。这带来三件事：

1. `$DSH_HOME` 下多一个只有这个插件认识的文件，而宿主已经有官方的存储设施
   （`ctx.storageDomain`）——`workspace`、`schedule`、会话投影缓存都在它里面，各有版本号与 schema 校验。
   同一类东西两种存法，排查时得分别知道往哪看。
2. 插件目录里同时躺着"几百 MB 的备份目录树"和"一个几十字节的 JSON"两种东西；前者是回滚凭据，
   后者是一句状态。可见性上没有区分，生命周期也不一样。
3. 判形状的守卫要跟着字段一起维护：`leftovers`、`takesEffect` 加过两次，每次都是一份新的
   "宽容读"逻辑。官方设施把这层校验放在领域的声明处（zod schema），声明一次就够。

约束是另一头：这个插件的核心（同步、备份、迁移、导出）必须能在**没有挂载存储**的宿主上继续工作。
那条记录只是页头上的一句话，不能因为它而让插件不激活。

## Decision

领域声明在 [sync-domain.ts](../../../../src/operations/sync/sync-domain.ts)，形状是：

```text
defineDomain({
  name: 'session_manager',
  version: 1,
  layout: 'single',
  tables: { sync_runs: domainTable(syncRunRecordSchema) },
})
```

- `single` 布局：整个领域一个文件 `<storages>/session_manager.json`，表 `sync_runs` 里只有一条记录，
  键固定 `last`；
- 记录值就是 `SyncRunRecord`（[sync-state.ts](../../../../src/operations/sync/sync-state.ts)）：`at`、
  `ok`、`pulled`、`pushed`，可选的 `error`、`problems`、`leftovers`、`takesEffect`；
- 磁盘形状由官方 json 后端决定（`{ unit: { name, version }, global: null, tables: { sync_runs: { last } } }`），
  记在 [formats.md](../../../../docs/formats.md)。

**schema 是规整，不是拒绝。** `syncRunRecordSchema` 的形状是 `unknown → 记录 | undefined`：读得出形状
就是一条记录，读不出就是"没有上次同步记录"。理由很具体——领域层在打开时会校验每条已存记录，
一张会拒绝的 schema 遇到一条坏记录会带 `invalid-record` 让**整个领域打不开**，此后连"下一次同步"都写
不进去；而这一条只是给界面看的一句话，不该有这种后果。没用 `.catch()` 是因为 zod 4 的 `.catch()` 只能
填一个与输出同类型的值，表达不了"读不懂就当没有"。

**降级是显式的三层。** `storageDomain` 不进顶层 `inject`；入口按
[可选服务那篇](../bug-fix/2026-09-27-optional-services-need-inject.md) 的写法开一个
`ctx.inject(['storageDomain'], …)` 子 fiber；模块本身用动态 `import()` 取，并且整个打开流程包在
`try/catch` 里。任何一层拿不到，`syncRunStore` 保持 `NO_SYNC_RUN_STORE`（读永远没有、写丢掉），
所有调用方的行为与"读不到记录"完全一致——页头只说"配没配"，其余功能原样。

**依赖照 `dsh-context` 的写法：`dsh-storage-domain` 放 `peerDependencies`，`zod` 放
`dependencies`。** 本仓库的 `@deepseek-ai/*` 一贯放 peer（cordis、dsh-tools、ui-primitives、
schemastery），`dsh-storage-domain` 归入这一类：宿主动手时装了一层包映射（`dsh-app-boot` 的
`createRuntimeResolution()` + `installRuntimeInterception()`，把整个安装目录的依赖图注册给插件的
ESM/CJS 加载器，这份安装 588 条、含 `dsh-storage-domain@0.2.2-rc.3`），所以 peer 拿到的是宿主那一份（范围与 `engines.dsh` 同一条，照仓库的版本声明房规）；
`dsh-storage` 与本仓库一样不声明——不是我们 import 的包，只是它的 peer。注意这是**加载期**的解析：
脱离 DSH 进程直接 import 产物仍然找不到它，而本插件的打开流程本来就是动态 `import()` 加 `try/catch`，
所以这个边界正好落在既有的降级路径里。`zod` 也放 `dependencies` 并精确锁 `4.6.6`：
`^4.6.6` 会解析到更新的版本，两份 zod 的类型名义上不兼容（`ZodType` 通不过赋值检查），锁成与
`storage-domain` 自带的那份同一个版本，安装时才会共用一份。

**迁移**：插件第一次成功打开领域时，如果 `<DSH_HOME>/dsh-session-manager/state.json` 还在、而领域里
没有 `last`，就把文件里的 `sync` 导入，然后把旧文件改名成 `state.json.migrated`。领域里已经有记录
时不导入、也不动旧文件；旧文件读不懂时也不导入、不改名（用户目录里的东西不悄悄搬走）；写不进去或
改名失败只打一行提示，不抛。幂等由"领域里有记录"与"旧文件已改名"两个条件共同保证。

**测试可注入**：读写抽成 `SyncRunStore`，领域表那一层抽成 `SyncRunTable`（两个方法：`get` / `put`）。
单元测试用内存假实现，`openSyncRunStore()` 的模块加载也做成可注入的 `loadDomainModule`，于是
"模块解析不到 → 退回不记录"这条路径在测试里真的走得通，不必依赖真实 `storageDomain` 或宿主。

## 为什么不把 backups 也搬进去

`backups/` 是几百 MB 的目录树，一个备份由「目录 + 清单 + 若干会话文件」组成，回滚靠目录操作
（列目录、读清单、逐文件写回）。KV 领域是"一张表、键值记录"，`single` 布局还是一份文件整份重写——
把它搬进去等于每次写都重写几百 MB，并且丢掉"目录就是回滚凭据"这个语义。那条同步记录是几十字节、
写多读多、随时可丢的一句话；两者的取舍完全不同，所以只搬后者。

`src/shared/registry.ts` 的 `writeRegistryAtomic()` 这次也没动：它直接改写
`storages/workspace.json`，绕过 `workspace` 领域在宿主内存里的副本，那是"如何安全地改别人的领域"
另一个问题，不在本次范围内。

## Alternatives considered

- **保留自己写 `state.json`**：能跑，但就是上面列的三种成本，而且每次加字段都要再写一份宽容读的守卫。
- **把 `dsh-storage-domain` 放 `dependencies`，让插件自带一份存储实现**：最初这么做过。脱离 DSH
  的纯 Node 也能 import，看起来更自足；代价是 profile 里多一份 `dsh-storage-domain`、一份
  `dsh-storage`、连带多一份 zod，而且两份 zod 已经让 `domainTable()` 的类型在构建期报错，只好把 zod
  锁成精确版本。宿主本来就提供这一份，重复没有收益。
- **静态 `import` 再靠 `ctx.inject` 降级**：模块求值阶段的解析失败发生在 `ctx.inject` 之前，那层保护
  根本轮不到；动态 `import()` 才能把失败收进 `try/catch`。
- **表 schema 用会拒绝的版本（或加 `.catch()`）**：见上，一条坏记录会让领域打不开；`.catch()` 在 zod 4
  里改不了输出类型。
- **迁移用"复制 + 删除"代替 `rename`**：多一步、也不原子；读者可能在复制到一半时看到半个文件。
- **把记录写进插件配置**：配置是用户的，每次同步改一遍会在设置页里攒出一串"已修改"的噪音。
- **不要迁移，直接丢掉旧记录**：升级之后页头会退回"从来没同步过"，看着像功能坏了，而那份数据本来
  就在磁盘上。

## Consequences

- 磁盘上多一份 `<storages>/session_manager.json`；插件目录下的 `state.json` 迁完即改名为
  `state.json.migrated`（内容原样留着，能人工对照）。
- 领域打开是异步的：插件启动后到存储到位之间有一小段窗口，此时页头那条说"配没配"。之后的 `/meta`
  请求读到的就是领域里的记录；没有存储的宿主则一直是这个状态。
- 依赖表新增一个 peer（`@deepseek-ai/dsh-storage-domain`，由宿主提供）与一个精确锁定的
  `zod@4.6.6`（随包安装）；升级 `storage-domain` 时如果它换了 zod 版本，`pnpm install` 会再放一份嵌套副本，
  `pnpm typecheck` 会当场报类型不兼容——这是有意让它在构建期就炸，而不是运行时。
- 测试分两层：单元测试用内存假实现（不碰真实领域、不起宿主），官方设施与 json 后端的真实行为另用
  一个端到端脚本核过一遍（迁移、读写、重启后读回、坏记录容错）。
- `writeRegistryAtomic()` 仍然绕过 `workspace` 领域，属于已知遗留，未在本篇处理。
