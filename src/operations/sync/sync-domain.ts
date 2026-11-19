/**
 * 「上一次同步」那条记录在官方领域存储里的规格与打开流程。
 *
 * 域名 `session_manager`、版本 1、`single` 布局：整个领域一个文件
 * `<$DSH_HOME>/storages/session_manager.json`，里面一张表 `sync_runs`、键固定 `last`。文件形状由
 * 官方 json 后端决定（`{ unit: { name, version }, global: null, tables: { sync_runs: { last: … } } }`），
 * 见 [docs/formats.md](../../../docs/formats.md)。
 *
 * **这个模块只有类型是静态 import 的，模块本身用动态 `import()` 取。** 理由：本仓库要能在没有挂载
 * storage 的宿主上继续工作（同步、备份、迁移是核心功能），而 `@deepseek-ai/dsh-storage-domain` 在
 * 某些安装形态下可能整个解析不到——模块求值阶段的 `ERR_MODULE_NOT_FOUND` 会把插件一起带下去，
 * `ctx.inject` 保护不到那一层。取不到就退回"不记录上次同步"，与读不到记录时的行为一致。
 *
 * @module dsh-session-manager/operations/sync/sync-domain
 */

import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'

import {
  migrateLegacySyncRun,
  SYNC_RUN_KEY,
  syncRunRecordSchema,
  type SyncRunStore,
  type SyncRunTable,
  type StoredSyncRun,
} from './sync-state.ts'

/** 域名：也是 json 后端在 `<storages>` 下那个文件名（`session_manager.json`）。 */
export const SYNC_DOMAIN_NAME = 'session_manager'
/** 领域格式版本（写在文件头部，与后端比较）。 */
export const SYNC_DOMAIN_VERSION = 1
/** 表名：只放上一次同步这一条。 */
export const SYNC_RUNS_TABLE = 'sync_runs'

/**
 * `ctx.storageDomain` 这一面用得到的部分。
 *
 * 签名与官方 `DomainFacility.open()` 一致，所以把真实服务传进来时类型是真的在核对，而不是靠强制转换。
 */
export interface SyncDomainFacility {
  /**
   * 打开一个声明过的领域。
   * @param spec `defineDomain()` 造出来的规格。
   * @returns 领域句柄；调用方负责关掉它。
   */
  open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
}

/** `ctx` 这一面用得到的部分：领域句柄的关闭挂在 effect 上，插件卸载时执行。 */
export interface SyncDomainContext {
  /**
   * 注册一个随插件卸载执行的释放动作。
   * @param dispose 返回释放函数的回调。
   * @param label 诊断用的名字。
   */
  effect(dispose: () => () => void, label: string): unknown
}

/** `@deepseek-ai/dsh-storage-domain` 里这里用到的两个导出。 */
export type SyncDomainModule = Pick<
  typeof import('@deepseek-ai/dsh-storage-domain'),
  'defineDomain' | 'domainTable'
>

/** 打开领域要的东西。 */
export interface OpenSyncRunStoreOptions {
  /** `ctx.storageDomain`（可选注入的回调里读到的那个）。 */
  storageDomain: SyncDomainFacility
  /** 有 `effect()` 的 ctx：那个声明了 `storageDomain` 的子 fiber。 */
  ctx: SyncDomainContext
  /** `$DSH_HOME`：旧 `state.json` 在这里，首次打开时搬进领域。 */
  home: string
  /** 打一行提示（这不是异常，是"少了某项能力"的说明）。 */
  warn: (message: string) => void
  /**
   * 取 storage-domain 模块。默认是真正的动态 `import()`；测试用它模拟"模块解析不到"。
   */
  loadDomainModule?: () => Promise<SyncDomainModule>
}

/**
 * 打开领域，把那张表折成"上一次同步"的读写口。
 *
 * 任何一步失败（模块解析不到、宿主没配后端、领域已被占用、旧数据搬不进去……）都返回 `undefined`：
 * 调用方据此继续用空手柄，插件其余功能不受影响。
 *
 * @param options 见 {@link OpenSyncRunStoreOptions}。
 * @returns 读写口；没有存储可用时 undefined。
 */
export async function openSyncRunStore(options: OpenSyncRunStoreOptions): Promise<SyncRunStore | undefined> {
  const { storageDomain, ctx, home, warn } = options
  const loadDomainModule = options.loadDomainModule ?? (() => import('@deepseek-ai/dsh-storage-domain'))
  try {
    const { defineDomain, domainTable } = await loadDomainModule()
    const domain = await storageDomain.open(defineDomain({
      name: SYNC_DOMAIN_NAME,
      version: SYNC_DOMAIN_VERSION,
      // 一个文件装整个领域：这里只有一条记录，per-record 那套目录没有收益。
      layout: 'single',
      tables: { sync_runs: domainTable<typeof SYNC_RUN_KEY, StoredSyncRun>(syncRunRecordSchema) },
    }))
    // 句柄归本插件管：卸载时关掉它（官方 `WorkspaceRegistry` 同样把关闭挂在 effect 上）。
    ctx.effect(() => () => { void domain.close() }, 'dsh-session-manager: sync-run domain')
    const table: SyncRunTable = domain.table(SYNC_RUNS_TABLE)

    const migration = await migrateLegacySyncRun(home, table, warn)
    if (migration.imported) {
      warn(
        `dsh-session-manager：上次同步的记录已从 state.json 搬进存储` +
          (migration.renamed ? '，旧文件改名为 state.json.migrated' : ''),
      )
    }

    return {
      read: () => {
        try {
          return table.get(SYNC_RUN_KEY)
        } catch {
          // 领域已经关了（卸载途中的请求）：当作没有记录。
          return undefined
        }
      },
      write: (run) => {
        // 不 await：写是持久化之后才 resolve 的，而调用方（同步结果那一步）不该等这一句话。
        // 失败也不冒泡：下一次成功的那趟会覆盖它。
        void table.put(SYNC_RUN_KEY, run).catch(() => {})
      },
    }
  } catch (error) {
    warn(
      `dsh-session-manager：上次同步的记录没有存储可用，页头只说「配没配」：${describe(error)}`,
    )
    return undefined
  }
}

/** 把任意异常说成一句人话（只用于日志）。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
