/**
 * 「同步设置」表单的数据面：宿主设置接缝的配置读写面收在这里，外加映射表那段草稿的解析/格式化。
 *
 * 为什么用宿主的设置接缝（`configForms.get(entryId)`）而不是插件自己存一份：配置只有一个来源。
 * 接缝读的是 profile 那一层（组合层 + 用户层），写回去的是**用户层**——也就是设置对话框右上角
 * 「Open configuration file」打开的那份文档。插件另存一份状态文件就会有两个真相，用户改哪一个
 * 都只对一半。
 *
 * 为什么写卡在这里而不是照官方那样注册 `plugins.bundle.config` 槽位：那个槽位的贡献面（`hooks`
 * 约定、`view: 'page'` 投影）是给"插件管理器里本插件那一页"用的，而本插件的同步设置与同步确认
 * 是同一件事——分开两页会让"我改了 URL，去看计划"多一次跳转。接缝本身是命名空间寻址的（同一份
 * 控制器，谁取都是那一份），所以放在本页不改变读写语义。
 *
 * 字段那一层刻意只留**结构**：不 import 宿主客户端包的类型，`ctx` 的成员只在运行期成立，由
 * `test/client.test.mjs` 的注册面断言兜住。这是本包客户端半侧的统一口径。
 *
 * @module dsh-session-manager/client/syncForm
 */

/** 本插件在 profile 里的 entry id：设置接缝按它寻址（`cordis.patch.yml` 里那个 insert 的 id）。 */
export const SYNC_SECTION = 'session-manager'

/**
 * `passwordRef` 没写时用的凭据引用名，与核心层 `src/config.ts` 的 `DEFAULT_PASSWORD_REF` 同一个值。
 *
 * 这里是**副本**而不是 import：浏览器半侧不 import 核心层（那会把 schemastery 之类拖进客户端产物），
 * 同一个形状的两侧各留一份字面量是本包既有的做法（`api.ts` 的 `API_PREFIX` 同理）。
 * `test/sync-form.test.ts` 钉住两份相等——算不出同一个名字，界面存进去的密码宿主就不会去读。
 */
export const DEFAULT_PASSWORD_REF = 'DSH_DAV_PASSWORD'

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

/**
 * 一份表单草稿：与磁盘上的值分开，保存时才写。
 *
 * 没有 `passwordRef`：那一栏不在这张表单上（引用名属于插件配置，见 [passwordRefOf](#passwordrefof)），
 * 所以草稿里也不该有一份"表单版本"的引用名——它只会与磁盘上那份悄悄分叉。
 */
export interface SyncDraft {
  url: string
  machineId: string
  username: string
  mapping: MappingRow[]
  timeoutMs: string
}

/** 从快照里取出这一节的值。 */
export function syncSectionOf(snapshot: SyncFormSnapshot | undefined): SyncSectionValue {
  return snapshot?.value?.sync ?? {}
}

/**
 * 这次表单按哪个引用名读写密码：配置里写了就用它，没写（或只有空白）用缺省名。
 *
 * 引用名**只来自插件配置**（`sync.passwordRef`，在插件配置页那份 volatile 表单里改），这张表单上
 * 没有它那一栏——这是官方那几个要密钥的卡片的口径（网页搜索那张卡只摆密钥，`apiKeyEnv` 留在配置里）：
 * 卡片问的是"密码是什么"，"放在哪个名字下"是配置的事。
 *
 * 与核心层 `passwordRefOf()`（src/tools.ts）同一套规则：两边得算出同一个名字，否则界面存进去的
 * 密码宿主不会去读。
 * @param value 当前生效的那一节。
 * @returns 凭据引用名（环境变量名）。
 */
export function passwordRefOf(value: Pick<SyncSectionValue, 'passwordRef'>): string {
  const declared = value.passwordRef?.trim() ?? ''
  return declared === '' ? DEFAULT_PASSWORD_REF : declared
}

/**
 * 密码框里的草稿 → 这次保存要写进凭据库的值。
 *
 * 空白（含只有空格）表示"这次不写"——留着已存的那一个，而不是拿空值去覆盖它：那既是官方那个
 * 只写控件的口径（空草稿不写），也是"改 URL 时不想动密码"这条最平常的用法。
 * @param draft 密码框里的原文。
 * @returns 要写的密码；空白时 undefined。
 */
export function passwordValueOf(draft: string): string | undefined {
  const typed = draft.trim()
  return typed === '' ? undefined : typed
}

/** 快照 → 草稿（打开表单、以及放弃编辑时都回到这里）。 */
export function draftFrom(value: SyncSectionValue): SyncDraft {
  return {
    url: value.url ?? '',
    machineId: value.machineId ?? '',
    username: value.username ?? '',
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
 * `passwordRef` 不在这份草稿里（表单上没有那一栏），所以这里也不会去写它——它只由插件配置页那份
 * 通用表单改。
 *
 * @param draft 草稿。
 * @param value 当前生效值。
 * @returns 路径编辑；全都一样时是空数组。
 */
export function draftOps(draft: SyncDraft, value: SyncSectionValue): SyncPathOp[] {
  const ops: SyncPathOp[] = []
  const text = (key: 'url' | 'machineId' | 'username'): void => {
    const next = draft[key].trim()
    const before = value[key] ?? ''
    if (next === before) return
    ops.push(next === '' ? { op: 'unset', path: ['sync', key] } : { op: 'set', path: ['sync', key], value: next })
  }
  text('url')
  text('machineId')
  text('username')

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

/**
 * 一次保存要发出去的两件事：配置文档里的路径编辑，以及要写进凭据库的那一笔密码。
 *
 * 两件事走的是**两条不同的通道**——编辑走设置接缝（写用户层的配置文档），密码走宿主机的凭据服务
 * （值不进配置）——所以这里把它们一起算好交给界面，界面只管按顺序发。写密码用的引用名取自**生效值**
 * （`passwordRefOf`）：表单上没有引用名那一栏，它只由插件配置决定，所以保存与解析读的是同一份。
 */
export interface SyncSavePlan {
  /** 发往设置接缝的路径编辑。 */
  ops: SyncPathOp[]
  /** 要写进凭据库的那一笔；密码框留空、或宿主没有凭据服务时不发。 */
  password?: { ref: string; value: string }
}

/**
 * 草稿 + 生效值 + 密码框 → 这次保存的全部写入。
 * @param draft 草稿。
 * @param value 当前生效值。
 * @param password 密码框里的原文（空白表示这次不动密码）。
 * @param credentialsAvailable 宿主有没有给出凭据服务（没有就只改配置，密码那一笔不发）。
 * @returns 两部分写入；都为空就是不脏。
 */
export function savePlan(
  draft: SyncDraft,
  value: SyncSectionValue,
  password: string,
  credentialsAvailable: boolean,
): SyncSavePlan {
  const typed = passwordValueOf(password)
  return {
    ops: draftOps(draft, value),
    ...(credentialsAvailable && typed !== undefined ? { password: { ref: passwordRefOf(value), value: typed } } : {}),
  }
}

/**
 * 「测试连接」的结论里界面用得上的那几个字段（宿主响应的形状见 api.ts 的 `SyncTestResponse`）。
 *
 * 只留结构、不 import 那一侧：与 `SyncSectionValue` 同一个口径，宿主多带几个字段也不影响这里。
 */
export interface SyncTestOutcome {
  code: string
  status: number
  namespaceExists: boolean
  machines: readonly string[]
  entries: number
  detail?: string
  username: string | null
  hasPassword: boolean
}

/** 一句界面文案：字典键 + 占位符（`t(key, params)`）。 */
export interface SyncTestSentence {
  key: string
  params?: Record<string, string | number>
}

/**
 * 结论 → 一句话：判定在宿主侧给的 `code` 上，这一层只挑句子（句子在字典里，两种语言各一份）。
 *
 * 401 分成三句，因为处置完全不同：没填用户名 / 引用名里没有值 / 服务器不认这套。前两句是"缺东西"，
 * 第三句才是"名字或密码不对"——把它们混成一句，用户就只能在服务器与配置之间来回猜。
 *
 * @param outcome 宿主给的结论。
 * @param passwordRef 这次用的是哪个凭据引用名（界面自己算出来的那个，与宿主同一条规则）。
 * @returns 字典键与占位符。
 */
export function testVerdict(outcome: SyncTestOutcome, passwordRef: string): SyncTestSentence {
  const detail = outcome.detail ?? ''
  switch (outcome.code) {
    case 'ok':
      if (!outcome.namespaceExists) return { key: 'syncTestOkFirst' }
      if (outcome.machines.length === 0) return { key: 'syncTestOkEmpty' }
      return { key: 'syncTestOk', params: { machines: outcome.machines.join(', ') } }
    case 'unauthenticated':
      if (outcome.username === null) return { key: 'syncTestNoUser', params: { status: outcome.status } }
      if (!outcome.hasPassword) return { key: 'syncTestNoPassword', params: { ref: passwordRef } }
      return { key: 'syncTestUnauthorized', params: { status: outcome.status } }
    case 'forbidden':
      return { key: 'syncTestForbidden', params: { status: outcome.status } }
    case 'notFound':
      return { key: 'syncTestNotFound', params: { status: outcome.status } }
    case 'unsupported':
      return { key: 'syncTestUnsupported', params: { status: outcome.status } }
    case 'unreachable':
      return { key: 'syncTestUnreachable', params: { detail } }
    case 'serverError':
      return { key: 'syncTestServerError', params: { status: outcome.status, detail } }
    default:
      // 认不出来的码也照实说：带上状态码与原始原因，好过悄悄显示成"成功"。
      return { key: 'syncTestOther', params: { status: outcome.status, detail } }
  }
}
