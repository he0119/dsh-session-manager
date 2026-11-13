// src/self-root-path.ts — 事件里"跟着会话根一起搬"的那些路径值。
//
// 只有一处：`working-directory/change` 的 `data.cwd`。宿主拿这条事件的**最后一个值**当会话的当前工作
// 目录，而 `dsh-working-directory` 那个投影要求它在本机是绝对路径（`refine(isAbsolute)`）。别的机器、
// 别的系统写下的值在这台机器上不成立，投影因此失败，`sessionQuery` 会把**整条会话**判成读不出来
// （界面上的"历史加载失败"就是这么来的）。所以这类值必须跟着会话根一起搬。
//
// 其余事件里的路径（工具入参、正文里的引用、工作树记录）没有谁去校验，属于历史事实，不在改写范围。
//
// 本模块不碰文件系统、不引 node 自带模块：日志改写（session-log.ts）、两边的比对（session-diff.ts，
// 它的类型会被浏览器那侧引到）与修日志那条路（path-repair.ts）共用这一份，别处不再写第二份。
/** 事件类型 → `data` 里那几个跟着会话根搬的字段名。 */
export const SELF_ROOT_PATH_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['working-directory/change', ['cwd']],
])

/** 值里出现这几个字才值得解析一次（其余行原样返回，省掉逐行 JSON 解析）。 */
export const SELF_ROOT_PATH_MARKERS: readonly string[] = [...SELF_ROOT_PATH_FIELDS.keys()]

/**
 * 比对两份日志时，那些跟着会话根搬的路径归一成的占位符。
 *
 * 与 header 的 cwd 归一化同一套理由（见 sync.ts 的 `CWD_PLACEHOLDER`）：路径写的是"这条会话落在
 * 这台机器的哪儿"，不是"这是哪一份会话"。NUL 不可能出现在真实路径里，所以不会撞上。
 */
export const SELF_ROOT_PLACEHOLDER = '\u0000dsm-self-root'

/** 按分隔符把路径切成段：`C:\a\b` 与 `/a/b` 都切成同样的段序列。 */
function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter((segment) => segment !== '')
}

/** 拼目标路径时用哪个分隔符：跟着 `to` 自己的写法走（Windows 用 `\`，其余用 `/`）。 */
function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/**
 * 一个落在源会话根底下的路径，翻译成目标根底下的同一个位置。
 *
 * 例：`C:\work\repo\.agents\worktrees\fix\x` 在 `C:\work\repo → /home/me/repo` 这条映射下得到
 * `/home/me/repo/.agents/worktrees/fix/x`；值正好等于源根时得到目标根本身。
 *
 * @param value 待翻译的路径（可以是另一台机器、另一种分隔符的写法）。
 * @param root 源会话根。
 * @param to 目标会话根。
 * @returns 翻译结果；不在 `root` 底下（或某一段对不上）时返回 `undefined`。
 */
export function mapUnderRoot(value: string, root: string, to: string): string | undefined {
  const rootSegments = pathSegments(root)
  const segments = pathSegments(value)
  if (rootSegments.length === 0 || segments.length < rootSegments.length) return undefined
  for (const [index, segment] of rootSegments.entries()) {
    if (segments[index] !== segment) return undefined
  }
  const rest = segments.slice(rootSegments.length)
  const trimmed = to.replace(/[\\/]+$/, '')
  const separator = separatorOf(to)
  return rest.length === 0 ? trimmed : `${trimmed}${separator}${rest.join(separator)}`
}

/** 一行事件里被改写的一处。 */
export interface SelfRootChange {
  /** `data` 里的字段名。 */
  field: string
  before: string
  after: string
}

/** 一行事件的改写结果。 */
export interface SelfRootLineRewrite {
  /** 改写后的一行；没改动时与原样相同。 */
  line: string
  /** 改动了哪几处（空数组 = 没改）。 */
  changes: SelfRootChange[]
  /** 看起来该跟着搬、但落在源根之外的取值（原样保留，按值去重）。 */
  unmapped: string[]
}

/** `rewriteSelfRootLine()` 的选项。 */
export interface SelfRootLineOptions {
  /** 源会话根。 */
  root: string
  /** 目标会话根。 */
  to: string
  /** 这个取值要不要改（缺省全改；日志落地那条路只改"本机不认的"，见 session-log.ts）。 */
  accept?: (value: string) => boolean
}

/**
 * 改一行事件里那些跟着会话根搬的路径。
 *
 * 只动 `data` 里那几个字段的值：其余字段靠 JSON 往返保住，随后再核一遍"除了这几个字段，逻辑内容一个
 * 字节都没变"，核不过就抛错——宁可这行不改，也不写坏它。
 *
 * @param line 一行事件原文（不是 JSON、或不是那几种事件时原样返回）。
 * @param options 源根、目标根与"要不要改"的判据。
 * @returns 改写结果（见 {@link SelfRootLineRewrite}）。
 * @throws 改完之后这一行不属于同一个事件时抛错（JSON 往返丢了字段之类）。
 */
export function rewriteSelfRootLine(line: string, options: SelfRootLineOptions): SelfRootLineRewrite {
  const untouched: SelfRootLineRewrite = { line, changes: [], unmapped: [] }
  if (!SELF_ROOT_PATH_MARKERS.some((marker) => line.includes(marker))) return untouched
  let before: unknown
  try {
    before = JSON.parse(line)
  } catch {
    // 坏行不是这里的事：内容视图另外记账（见 transcript.ts），这里原样放过。
    return untouched
  }
  // 改的是副本：核"除这几个字段外没变"要拿未改动的原值来比。
  const event = structuredClone(before) as { type?: unknown; data?: Record<string, unknown> | null }
  const fields = typeof event.type === 'string' ? SELF_ROOT_PATH_FIELDS.get(event.type) : undefined
  if (fields === undefined || event.data === null || typeof event.data !== 'object') return untouched

  const changes: SelfRootChange[] = []
  const unmapped: string[] = []
  for (const field of fields) {
    const value = event.data[field]
    if (typeof value !== 'string' || value === '') continue
    if (options.accept !== undefined && !options.accept(value)) continue
    const mapped = mapUnderRoot(value, options.root, options.to)
    if (mapped === undefined) {
      if (!unmapped.includes(value)) unmapped.push(value)
      continue
    }
    if (mapped === value) continue
    changes.push({ field, before: value, after: mapped })
  }
  if (changes.length === 0) return { ...untouched, unmapped }

  for (const change of changes) event.data[change.field] = change.after
  const next = JSON.stringify(event)
  if (!sameEventApartFrom(before, JSON.parse(next), changes.map((change) => change.field))) {
    throw new Error(`event line changed beyond its path field: ${line.slice(0, 120)}`)
  }
  return { line: next, changes, unmapped }
}

/**
 * 两份事件是不是"除了这几个字段都相同"。
 *
 * 取逻辑内容而非字节：JSON 往返会重排空格与转义，那不是内容变了；字段值本身已经单独核过（见调用方）。
 */
function sameEventApartFrom(before: unknown, after: unknown, fields: readonly string[]): boolean {
  const strip = (value: unknown): string => {
    const copy = JSON.parse(JSON.stringify(value)) as { data?: Record<string, unknown> | null }
    if (copy.data !== undefined && copy.data !== null && typeof copy.data === 'object') {
      for (const field of fields) delete copy.data[field]
    }
    return JSON.stringify(copy)
  }
  return strip(before) === strip(after)
}
