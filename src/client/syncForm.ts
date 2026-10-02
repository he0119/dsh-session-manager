/**
 * 「同步设置」表单的数据面：宿主设置接缝的配置读写面收在这里，外加映射表那段草稿的解析/格式化。
 *
 * 为什么用宿主的设置接缝（`configForms.get(entryId)`）而不是插件自己存一份：配置只有一个来源。
 * 接缝读的是 profile 那一层（组合层 + 用户层），写回去的是**用户层**——也就是设置对话框右上角
 * 「Open configuration file」打开的那份文档。插件另存一份状态文件就会有两个真相，用户改哪一个
 * 都只对一半。
 *
 * 为什么写卡在这里而不是照官方那样注册 `plugins.bundle.config` 槽位：那个槽位的贡献面（`hooks`
 * 约定、`view: 'page'` 投影）是给"插件管理器里本插件那一页"用的，而本插件的同步设置与预演/确认
 * 是同一件事——分开两页会让"我改了 URL，去看预演"多一次跳转。接缝本身是命名空间寻址的（同一份
 * 控制器，谁取都是那一份），所以放在本页不改变读写语义。
 *
 * 字段那一层刻意只留**结构**：不 import 宿主客户端包的类型，`ctx` 的成员只在运行期成立，由
 * `test/client.test.mjs` 的注册面断言兜住。这是本包客户端半侧的统一口径。
 *
 * @module dsh-session-manager/client/syncForm
 */

/** 本插件在 profile 里的 entry id：设置接缝按它寻址（`cordis.patch.yml` 里那个 insert 的 id）。 */
export const SYNC_SECTION = 'session-manager'

/** 一节同步设置的可读值（只有界面要用的那几个字段）。 */
export interface SyncSectionValue {
  url?: string
  machineId?: string
  username?: string
  passwordRef?: string
  mapping?: Record<string, string>
  timeoutMs?: number
}

/** 控制器快照的最小面（与宿主 `configForms.get()` 的快照同形）。 */
export interface SyncFormSnapshot {
  /** `ready` 才画表单；`loading` / `unavailable` 各有一句话。 */
  status: 'loading' | 'ready' | 'unavailable'
  /** 生效值（用户层 → 组合层 → 默认值解析之后的那一份，只含 volatile 字段）。 */
  value?: { sync?: SyncSectionValue }
  /** 用户层里已经写过的字段：`overridden` 徽标按它算（有过覆盖就是覆盖，哪怕值等于默认）。 */
  user?: unknown
  /** 宿主文档是否接受写入（只读文档下按钮要禁用并说明）。 */
  writable: boolean
  /** 快照读到的版本号；保存时拿它做围栏。 */
  revision?: number
}

/** 一条路径编辑（与宿主 `mutate` 收的形状同形）。 */
export type SyncPathOp = { op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] }

/** 设置接缝给本插件那一节的读写面。 */
export interface SyncConfigApi {
  getSnapshot(): SyncFormSnapshot
  subscribe(listener: () => void): () => void
  /** 一次写入多条编辑，`expectedRevision` 是草稿开始时的版本号。 */
  mutate(ops: readonly SyncPathOp[], expectedRevision?: number): Promise<boolean>
}

let api: SyncConfigApi | undefined

/** 装/卸读写面（服务到位时装，卸载时卸）。 */
export function setSyncConfigApi(next: SyncConfigApi | undefined): void {
  api = next
}

/** 取当前读写面；服务不在时为 undefined，表单据此说明"这个宿主不能在界面里改"。 */
export function getSyncConfigApi(): SyncConfigApi | undefined {
  return api
}

/** 映射表里的一行草稿：左边是远端记下的 cwd，右边是这台机器上的目录。 */
export interface MappingRow {
  from: string
  to: string
}

/**
 * 配置里的映射（字典）→ 行，**保持文档里的顺序**。
 *
 * 不按 key 重排：界面上看到的顺序就是配置文件里的顺序，新加的一行保存后也还留在原地。文档顺序本身
 * 是稳定的（YAML 的键序），而"改没改"的判据走 `canonical()` 的排序形式，不依赖这个顺序。
 */
export function mappingRows(value: unknown): MappingRow[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).map(([from, to]) => ({
    from,
    to: typeof to === 'string' ? to : '',
  }))
}

/** 映射表的规范形式：只用来判"到底改没改"，比较时不受两条来路的顺序影响。 */
function canonical(mapping: Record<string, string>): string {
  return JSON.stringify(Object.entries(mapping).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** 行 → 配置里的映射。两边都空的行忽略（点了「添加一行」又改主意的用户不该因此存不下去）。 */
export function mappingValue(rows: readonly MappingRow[]): Record<string, string> {
  const value: Record<string, string> = {}
  for (const row of rows) {
    const from = row.from.trim()
    const to = row.to.trim()
    if (from === '' && to === '') continue
    value[from] = to
  }
  return value
}

/**
 * 一段映射草稿的问题：能用，或者一个**指到行号的问题**（保存被它挡住，而不是悄悄丢掉）。
 *
 * 问题用码而不是句子：这一层不给文案，界面按码去字典里取——中文界面里冒出英文、或者反过来，都是
 * 最容易被当成 bug 的那种。
 */
export type MappingProblem =
  | { code: 'mapNoFrom'; line: number }
  | { code: 'mapNoTo'; line: number }
  | { code: 'mapDuplicate'; line: number; from: string }

/**
 * 检查映射表的每一行。
 *
 * 只检查"动过的行"（至少填了一边）：点了「添加一行」还没填的空行不算错。同一个远端出现两次算错——
 * 那是"我以为改了这一条、其实被另一条盖掉了"的经典来源。
 *
 * @param rows 草稿里的行。
 * @returns 问题列表，行号从 1 起。
 */
export function mappingProblems(rows: readonly MappingRow[]): MappingProblem[] {
  const problems: MappingProblem[] = []
  const seen = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const from = row.from.trim()
    const to = row.to.trim()
    if (from === '' && to === '') continue
    if (from === '') problems.push({ code: 'mapNoFrom', line: index + 1 })
    else if (seen.has(from)) problems.push({ code: 'mapDuplicate', line: index + 1, from })
    else seen.add(from)
    if (to === '') problems.push({ code: 'mapNoTo', line: index + 1 })
  }
  return problems
}

/** 一份表单草稿：与磁盘上的值分开，保存时才写。 */
export interface SyncDraft {
  url: string
  machineId: string
  username: string
  passwordRef: string
  mapping: MappingRow[]
  timeoutMs: string
}

/** 从快照里取出这一节的值。 */
export function syncSectionOf(snapshot: SyncFormSnapshot | undefined): SyncSectionValue {
  return snapshot?.value?.sync ?? {}
}

/** 快照 → 草稿（打开表单、以及放弃编辑时都回到这里）。 */
export function draftFrom(value: SyncSectionValue): SyncDraft {
  return {
    url: value.url ?? '',
    machineId: value.machineId ?? '',
    username: value.username ?? '',
    passwordRef: value.passwordRef ?? '',
    mapping: mappingRows(value.mapping),
    timeoutMs: value.timeoutMs === undefined ? '' : String(value.timeoutMs),
  }
}

/**
 * 草稿 + 磁盘值 → 要写的路径编辑。
 *
 * 只在**真的改了**的字段上发编辑（空草稿发 `unset`，让它退回组合层）：一次保存里混进几个没动过的
 * 字段，就会在用户层留下一堆"其实等于默认值"的覆盖，而界面上那些字段从此都顶着"已覆盖"徽标。
 *
 * @param draft 草稿。
 * @param value 当前生效值。
 * @returns 路径编辑；全都一样时是空数组。
 */
export function draftOps(draft: SyncDraft, value: SyncSectionValue): SyncPathOp[] {
  const ops: SyncPathOp[] = []
  const text = (key: 'url' | 'machineId' | 'username' | 'passwordRef'): void => {
    const next = draft[key].trim()
    const before = value[key] ?? ''
    if (next === before) return
    ops.push(next === '' ? { op: 'unset', path: ['sync', key] } : { op: 'set', path: ['sync', key], value: next })
  }
  text('url')
  text('machineId')
  text('username')
  text('passwordRef')

  const timeout = draft.timeoutMs.trim()
  const beforeTimeout = value.timeoutMs === undefined ? '' : String(value.timeoutMs)
  if (timeout !== beforeTimeout) {
    ops.push(timeout === '' ? { op: 'unset', path: ['sync', 'timeoutMs'] } : { op: 'set', path: ['sync', 'timeoutMs'], value: Number(timeout) })
  }

  // 映射整表一次写：它是「一整套对应关系」，拆成逐条编辑反而会出现"删了又写回来"的中间态。
  // 有问题的行在场时不发编辑（保存本来就被 draftProblems 挡住了）。
  const next = mappingValue(draft.mapping)
  if (mappingProblems(draft.mapping).length === 0 && canonical(next) !== canonical(mappingValue(mappingRows(value.mapping)))) {
    ops.push(
      Object.keys(next).length === 0
        ? { op: 'unset', path: ['sync', 'mapping'] }
        : { op: 'set', path: ['sync', 'mapping'], value: next },
    )
  }
  return ops
}

/** 草稿里那几个能挡住保存的问题（空数组＝可以保存）；同样是码，文案在字典里。 */
export type DraftProblem = { code: 'timeoutNotPositive' } | { code: 'mapping'; problem: MappingProblem }

/**
 * 检查草稿里能当场看出来的问题。
 * @param draft 草稿。
 * @returns 问题列表；空数组表示可以保存。
 */
export function draftProblems(draft: SyncDraft): DraftProblem[] {
  const problems: DraftProblem[] = []
  const timeout = draft.timeoutMs.trim()
  if (timeout !== '' && (!/^\d+$/.test(timeout) || Number(timeout) <= 0)) problems.push({ code: 'timeoutNotPositive' })
  for (const problem of mappingProblems(draft.mapping)) problems.push({ code: 'mapping', problem })
  return problems
}
