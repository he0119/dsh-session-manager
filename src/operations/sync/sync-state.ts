/**
 * 上一次同步的那条记录：形状、给界面的那一份、以及旧版 `state.json` 的迁移读取。
 *
 * 写它的有两条路：界面上按「确认同步」跑的那一趟，以及后台自动那一档跑完的每一轮（见
 * `autoPushRunRecord()`）。空跑（一条都不用搬）的那一轮不写，见那份函数的说明。
 *
 * 记录本身存在**官方的领域存储**里（`ctx.storageDomain`，域名 `session_manager`、表 `sync_runs`、
 * 键固定 `last`，规格在 [sync-domain.ts](./sync-domain.ts)），不再由这个模块自己拼路径写 JSON。
 *
 * 为什么要有它：同步是这一页唯一"不点也会自己跑"的事，用户关掉窗口、重启 DSH 之后再打开，页头那枚
 * 状态如果只能说"配没配"，就答不了"昨晚那趟成没成"。宿主原来只在内存里记（`web.ts` 的 `lastApply`），
 * 进程一重启就没了。
 *
 * 记录只是**给界面看的一句话**：读不出来、写不进去都不该影响同步本身。所以这张表的 zod schema 带
 * 形状不对时读成"没有"（见 `syncRunRecordSchema`），而不是让整个领域打不开；写失败静默（下一次
 * 成功会覆盖它）。这条宽容也是旧记录能读的原因：`leftovers` / `takesEffect` 是后加的，缺了照样是
 * 一条记录。
 *
 * @module dsh-session-manager/operations/sync/sync-state
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import type { SyncLeftover } from './sync.ts'

/**
 * 这条记录是哪一条路写下的。
 *
 * - `manual`：界面上按「确认同步」跑的那一趟，或模型工具 `sync_sessions`；
 * - `auto-push`：后台「只推」那一档跑完的一轮（不改本机，所以永远拉 0 条）；
 * - `auto-sync`：后台「双向」那一档跑完的一轮（该拉的拉、该推的推）。
 *
 * 为什么要记：界面那行要说清这趟是谁跑的。只推那一档**从来不拉**，写成"拉取 0 条"会被读成
 * "拉了、一条都没拉到"。旧记录没有这一项——那时只有手动那趟会写，缺席一律按 `manual` 读。
 */
export type SyncRunSource = 'manual' | 'auto-push' | 'auto-sync'

/** 一条同步记录。`at` 是 ISO 时间戳，`error` 只在失败时有。 */
export interface SyncRunRecord {
  /** 这一趟结束的时刻（ISO 8601，带时区）。 */
  at: string
  /** 成没成。 */
  ok: boolean
  /** 拉进来几条（失败那趟是 0）。 */
  pulled: number
  /** 推上去几条（失败那趟是 0）。 */
  pushed: number
  /** 失败原因（宿主或远端的原话）。 */
  error?: string
  /**
   * 这一趟**没做到**的事（宿主 `SyncOutcome.problems` 的原话：某条缺映射、某条目标目录不存在……）。
   *
   * 失败那趟不写（那一整趟都没成，`error` 已经说了）。留着它是因为"跑完了、但有几条没做到"既不是成功
   * 也不是失败：页头上那枚状态为它单独留了一档黄点（见 `lastRunView()` 与 `client/logic/syncChipDot.ts`）。
   */
  problems?: string[]
  /**
   * 这一趟「没做到」的条目（点名版，见 `sync.ts` 的 `collectLeftovers()`）。
   *
   * 与 `problems` 并存而不是取代它：`problems` 是几句汇总，页头那枚黄点靠它数条数；这一份带会话 id，
   * 界面上那张「上次同步」的清单靠它给出「只看这一条」。旧记录里没有这一项，界面按"只有汇总"画。
   */
  leftovers?: SyncLeftover[]
  /**
   * 这一趟拉进来的改动什么时候生效：`immediate` 立刻，`restart-required` 要重启 DSH。
   *
   * 存的是**宿主当时的判断**，不是"现在还算不算"——那要看这台宿主之后有没有重启过，由 `lastRunView()`
   * 拿进程启动时刻比一次。
   */
  takesEffect?: 'immediate' | 'restart-required'
  /** 哪一条路写的（缺席 = 旧记录，那时只有手动那趟会写）。 */
  source?: SyncRunSource
}

/** 一条记录摊给界面看的样子：原始记录 + 一条**现在**才成立的事实。 */
export interface SyncRunView extends SyncRunRecord {
  /**
   * 这一趟的改动要重启才算数，而这台宿主从那一趟之后还没重启过。
   *
   * 为什么不在记录里存这个：记录是死的，重启之后它就过期了；"重启过没有"只有当前的进程知道。
   */
  pendingRestart: boolean
}

/**
 * 把一条记录读成界面要的那份：补上"还要不要重启"这一条。
 *
 * 判据：`takesEffect` 是 restart-required，且那趟是在**这个进程里**跑的（`at` 不早于 `bootedAt`）。
 * 反过来说，记录比进程还早 = 中间已经重启过，那一趟早就生效了。
 *
 * @param run 读回来的记录。
 * @param bootedAt 这个宿主进程起来的时刻（毫秒）。
 * @returns 记录本身 + `pendingRestart`。
 */
export function lastRunView(run: SyncRunRecord, bootedAt: number): SyncRunView {
  const at = Date.parse(run.at)
  const pendingRestart =
    run.takesEffect === 'restart-required' && Number.isFinite(at) && at >= bootedAt
  return { ...run, pendingRestart }
}

/** `sync_runs` 表里那条记录的键：只存一条，键固定。 */
export const SYNC_RUN_KEY = 'last' as const

/**
 * 「没做到」的一条在存储里的形状。
 *
 * 字段与 `SyncLeftover` 一一对应，只有 `kind` 故意放宽成"任意字符串"：以后宿主多一种分类时，这一版
 * 读得回来（界面把认不出的归到「其它问题」），不会因为一个字段不属于那五种就丢掉整份清单。
 */
const leftoverSchema = z.object({
  message: z.string(),
  sessionId: z.string().optional(),
  title: z.string().optional(),
  kind: z.custom<SyncLeftover['kind']>((value) => typeof value === 'string').optional(),
  detail: z.string().optional(),
})

/**
 * 一条记录在存储里的形状。
 *
 * 两处刻意的宽松：`leftovers` / `takesEffect` 都是可选的——旧版本写的记录没有它们，读回来照旧是一条
 * 记录；`kind` 只核它是字符串——以后宿主多一种分类时这一版读得回来（界面把认不出的归到「其它问题」）。
 */
const recordShape = z.object({
  at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  ok: z.boolean(),
  pulled: z.number(),
  pushed: z.number(),
  error: z.string().optional(),
  // 与 `leftovers[].kind` 同一条宽容：只核"是个字符串"。以后多一条写入口时，这一版读得回来
  // （界面把认不出的按手动那趟画），不会因为一个字段不属于那三个值就丢掉整份记录。
  source: z.custom<SyncRunSource>((value) => typeof value === 'string').optional(),
  problems: z.array(z.string()).optional(),
  leftovers: z.array(leftoverSchema).optional(),
  takesEffect: z.enum(['immediate', 'restart-required']).optional(),
})

/**
 * 一张表记录在存储里的 schema。
 *
 * 它的职责是**规整**而不是拒绝：存着的本来就是一份 JSON，读得出形状就是一条记录，读不出形状就是
 * `undefined`（=「没有上次同步记录」）。为什么不用一张会拒绝的 schema（也不挂 `.catch()`）：
 * 领域层在打开时校验每条已存记录，一条读不懂的记录会带 `invalid-record` 把整个领域打不开——此后
 * 连"下一次同步"都写不进去，而这一条只是页头上的一句话。
 *
 * 用 `transform` 而不是 `.catch()`：zod 4 的 `.catch()` 只能填一个与输出同类型的值，表达不了
 * "读不懂就当没有"。
 */
export const syncRunRecordSchema = z
  .unknown()
  .transform((value): SyncRunRecord | undefined => {
    const parsed = recordShape.safeParse(value)
    return parsed.success ? parsed.data : undefined
  })

/** 存储里读出来的一条记录：形状对就是它，读不懂是 `undefined`（见 `syncRunRecordSchema`）。 */
export type StoredSyncRun = z.infer<typeof syncRunRecordSchema>

/**
 * 把一个值读成记录。
 *
 * 坏 JSON 由调用方先 `JSON.parse`；这里只管形状。schema 是 `unknown → 记录 | undefined` 的规整，
 * `parse()` 对任何输入都不抛，所以这里不必再套 try。
 *
 * @param value 存着的那个值（JSON 解出来的）。
 * @returns 读得懂就是记录，否则 undefined。
 */
export function parseSyncRun(value: unknown): SyncRunRecord | undefined {
  return syncRunRecordSchema.parse(value)
}

/**
 * 记录读写的口子。
 *
 * 抽成接口是为了测试能换成内存假实现（不必搭真实领域，也不必起宿主）；生产实现只看得到一张领域表。
 */
export interface SyncRunStore {
  /**
   * 读上一次同步的记录。
   *
   * 宽容：没有记录、记录读不懂、存储已经关了，都是 `undefined`。
   */
  read(): SyncRunRecord | undefined
  /**
   * 记下这一趟同步。
   *
   * 失败静默：同步本身不该因为记不下来这一句而失败（下一次成功的那趟会再写一遍）。
   */
  write(run: SyncRunRecord): void
}

/** 没有存储可用时的降级：读永远没有、写丢掉。页头于是只说"配没配"，与读不到记录时一致。 */
export const NO_SYNC_RUN_STORE: SyncRunStore = {
  read: () => undefined,
  write: () => {},
}

/**
 * 领域表里这一层用得到的那两个方法。
 *
 * 值类型带 `undefined` 是 schema 的直接后果（读不懂的记录读成 `undefined`，见
 * `syncRunRecordSchema`）；真实的 `KvTable<'last', StoredSyncRun>` 正好满足这个形状。
 */
export interface SyncRunTable {
  get(key: typeof SYNC_RUN_KEY): StoredSyncRun
  put(key: typeof SYNC_RUN_KEY, value: StoredSyncRun): Promise<void>
}

/** 这个插件在 `$DSH_HOME` 下那一层（旧状态文件、备份根都在这里）。 */
function pluginDir(home: string): string {
  return join(home, 'dsh-session-manager')
}

/**
 * 旧版状态文件的位置：`<DSH_HOME>/dsh-session-manager/state.json`。
 *
 * **只有迁移还读它**：记录现在在领域里（见 `sync-domain.ts`），新代码不再往这个文件写。
 */
export function syncStatePath(home: string): string {
  return join(pluginDir(home), 'state.json')
}

/** 旧状态文件迁完之后的名字：`<DSH_HOME>/dsh-session-manager/state.json.migrated`。 */
export function migratedSyncStatePath(home: string): string {
  return `${syncStatePath(home)}.migrated`
}

/**
 * 读旧版 `state.json` 里的那一条（`{ sync: {...} }`）。
 *
 * 文件不在、JSON 坏了、形状不对都返回 `undefined`——迁移据此决定"没什么可搬的"。
 *
 * @param home DSH 家目录（`$DSH_HOME`）。
 * @returns 旧文件里的记录；没有或读不懂时 undefined。
 */
export function readLegacySyncRunFile(home: string): SyncRunRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(syncStatePath(home), 'utf8')) as { sync?: unknown } | null
    return parseSyncRun(parsed?.sync)
  } catch {
    return undefined
  }
}

/** 一次迁移做了什么（调用方据此决定要不要说一句话）。 */
export interface SyncRunMigration {
  /** 旧文件里的记录搬进了领域。 */
  imported: boolean
  /** 搬完之后旧文件改名成了 `state.json.migrated`。 */
  renamed: boolean
}

/**
 * 把旧版 `state.json` 里的记录搬进领域，并给旧文件改名。
 *
 * 规则：
 *
 * - 旧文件不在 → 什么都不做（大多数机器）；
 * - 领域里已经有 `last` → 不导入（领域是权威的），旧文件也不动；
 * - 旧文件读不懂 → 不导入也不动它（那是用户目录里的东西，留给以后判断），下次启动再试一遍；
 * - 导入成功 → 旧文件改名成 `state.json.migrated`，避免下一次被当成"还有旧数据"。
 *
 * 幂等：搬过一次之后领域里有记录、旧文件也不在原位了，再跑就是什么都不做。失败只打一行提示，不抛
 * （这条记录不该挡住插件启动）。
 *
 * @param home DSH 家目录（`$DSH_HOME`）。
 * @param table 领域里那张 `sync_runs` 表。
 * @param warn 打一行提示（插件入口给的是 logger）。
 * @returns 这次搬了什么。
 */
export async function migrateLegacySyncRun(
  home: string,
  table: SyncRunTable,
  warn: (message: string) => void,
): Promise<SyncRunMigration> {
  const result: SyncRunMigration = { imported: false, renamed: false }
  const path = syncStatePath(home)
  if (!existsSync(path)) return result
  if (table.get(SYNC_RUN_KEY) !== undefined) return result

  const legacy = readLegacySyncRunFile(home)
  // 读不懂的旧文件：不导入、不改名。留着它比悄悄搬走一个看不懂的东西更安全。
  if (legacy === undefined) return result

  try {
    await table.put(SYNC_RUN_KEY, legacy)
    result.imported = true
  } catch (error) {
    warn(`dsh-session-manager：旧 state.json 里的上次同步记录没能搬进存储，留在原处：${describe(error)}`)
    return result
  }

  try {
    renameSync(path, migratedSyncStatePath(home))
    result.renamed = true
  } catch (error) {
    // 没改名也不影响正确性：领域里已经有记录，下次启动会因为"领域里已有一条"而跳过导入。
    warn(`dsh-session-manager：旧 state.json 已导入，但没能改名成 state.json.migrated：${describe(error)}`)
  }
  return result
}

/** 把任意异常说成一句人话（只用于日志）。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
