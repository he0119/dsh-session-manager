// src/session-diff.ts — 比两条会话日志：共同到哪一条、之后各自写了什么、header 差在哪。
//
// 用途是同步里那个"同一个 id 两边各自写过"（计划里的 `diverged`）：那个判定只说得出"两边不一样"，
// 说不出"哪儿不一样、谁多了什么"，而删掉哪一边、留哪一边是**人**该做的决定。这个模块把那个判定拆成
// 看得懂的三段：共同的、本机多出来的、远端多出来的。
//
// 三点口径：
//
// 1. **按行比，不按"语义"比**。同一份日志在两台机器上是逐字节相同的（复制过去的那一段就是原样），
//    每边新增的事件接在各自后面，所以"共同前缀"可以拿原文字符串直接比——不解析 JSON 就不会把
//    "格式一样但字段顺序不同"这种噪音报成差异。解析只用在**要显示的那几条**上（见 `previewOf()`）。
// 2. **header 单独算一类差异**。迁移与导入落地时会改写 header 里的 `cwd`（见 session-log.ts 的
//    `relocateHeaderCwd()`），于是"同一份会话在另一台机器上"常常只有这一行不同——事件一条不差。
//    这种情形的结论是"两份内容一样、保哪份都一样"，不该跟真分叉混在一起说。
// 3. **尾巴的三种关系要说清**：一边的尾巴是另一边的逐字节前缀时，那不是分叉，是"同一条又往前写了
//    几条"（`local-extends` / `remote-extends`）；只有互相都不是前缀才是真分叉（`forked`）。
//    把前一种报成"分叉"会让人以为两边各写了不同的东西，实际上是同一个延续。

import { readTranscript, type TranscriptItem, type TranscriptKind } from './transcript.ts'

/** 尾巴上一条预览：够界面认出来"这是哪一条"就行，原文照旧按需另取。 */
export interface DiffItem {
  /** 它在**整份日志**里是第几条事件（0 = header 后面第一条）。 */
  index: number
  seq?: number
  time?: number
  turn?: number
  kind: TranscriptKind
  /** 事件类型原文（`user/message` 这种）。 */
  type: string
  /** 一行的摘要：正文首行、工具名 + 入参首行、其余退回类型。界面直接显示它。 */
  brief: string
  /** 这一条自身是不是错误（`tool/result` 的 `isError`）。 */
  isError?: boolean
}

/** 一边的现状（与差异无关的那些事实：这份日志多大、多少条事件）。 */
export interface DiffSideFacts {
  /** 事件条数（不含 header）。 */
  events: number
  /** 日志字节数。 */
  bytes: number
  /** 解析不出来的行数（坏行照旧算进 `events`？不算：它是"读不出来的行"，两回事）。 */
  problems: number
}

/** 一边的尾巴。 */
export interface DiffTail {
  /** 这条尾巴一共几件事。 */
  count: number
  /** 这条尾巴一共多少字节（按行算，不含 header）。 */
  bytes: number
  /** 列出来的前几条（最多 `maxPreview` 条）。 */
  preview: DiffItem[]
  /** 还有几条没列出来。 */
  hidden: number
}

/** header 里一处不同的字段。 */
export interface DiffHeaderField {
  field: string
  local?: string
  remote?: string
}

/** 两份日志的关系。 */
export type DiffRelation =
  /** 事件逐条一致（header 可能有别，见 `header`）。 */
  | 'same'
  /** 远端那份是本机这部分的前缀：同一条往下写，本机写得更远。 */
  | 'local-extends'
  /** 反过来。 */
  | 'remote-extends'
  /** 两边各写各的（互相都不是前缀）。 */
  | 'forked'

export interface SessionDiff {
  relation: DiffRelation
  /** 逐条一致的事件条数（不含 header）。 */
  common: number
  localTail: DiffTail
  remoteTail: DiffTail
  /** header 里对不上的字段（空数组 = header 也一样）。 */
  header: DiffHeaderField[]
  local: DiffSideFacts
  remote: DiffSideFacts
  /** 两边的 header 原文（界面顶上那行要用 id / cwd / 时间）。 */
  localHeader: DiffHeaderFacts
  remoteHeader: DiffHeaderFacts
}

/** header 里界面用得上的那几个字段（核心层只认自己用到的，其余不解释）。 */
export interface DiffHeaderFacts {
  id?: string
  cwd?: string
  createdAt?: number
  parentSession?: string
}

export interface DiffOptions {
  /** 每条尾巴最多列出多少条预览。 */
  maxPreview?: number
  /** 预览里每一格的字符上限（原文按需另取，这里只要够认出来）。 */
  previewChars?: number
}

/** 缺省每条尾巴列 20 条。 */
export const DEFAULT_DIFF_PREVIEW = 20
/** 缺省每格 200 字。 */
export const DEFAULT_DIFF_CHARS = 200

/** header 里逐个字段比一遍用的名单（顺序就是界面里的顺序）。 */
const HEADER_FIELDS = ['id', 'cwd', 'createdAt', 'parentSession'] as const

/**
 * 比两份日志。
 *
 * @param localLines 本机这份日志的每一行（第一行是 header）。
 * @param remoteLines 远端那份的每一行。
 * @param facts 两边的事实（字节数由调用方给：本机是文件大小，远端是包里的那份）。
 */
export function diffSessionLogs(
  localLines: readonly string[],
  remoteLines: readonly string[],
  facts: { localBytes: number; remoteBytes: number; localProblems?: number; remoteProblems?: number },
  options: DiffOptions = {},
): SessionDiff {
  const maxPreview = options.maxPreview ?? DEFAULT_DIFF_PREVIEW
  const previewChars = options.previewChars ?? DEFAULT_DIFF_CHARS

  const local = body(localLines)
  const remote = body(remoteLines)

  // 共同前缀：正文逐行比。header（第 0 行）不参与——它单独算一类差异，原因见文件头第 2 条。
  let common = 0
  while (common < local.length && common < remote.length && local[common] === remote[common]) common += 1

  const localTail = local.slice(common)
  const remoteTail = remote.slice(common)
  const relation: DiffRelation =
    localTail.length === 0 && remoteTail.length === 0
      ? 'same'
      : isPrefix(remoteTail, localTail)
        ? 'local-extends'
        : isPrefix(localTail, remoteTail)
          ? 'remote-extends'
          : 'forked'

  const localHeaderFacts = headerFacts(localLines[0])
  const remoteHeaderFacts = headerFacts(remoteLines[0])

  return {
    relation,
    common,
    localTail: tail(localTail, localLines[0], common, maxPreview, previewChars),
    remoteTail: tail(remoteTail, remoteLines[0], common, maxPreview, previewChars),
    header: headerDiff(localLines[0], remoteLines[0]),
    local: {
      events: local.length,
      bytes: facts.localBytes,
      problems: facts.localProblems ?? 0,
    },
    remote: {
      events: remote.length,
      bytes: facts.remoteBytes,
      problems: facts.remoteProblems ?? 0,
    },
    localHeader: localHeaderFacts,
    remoteHeader: remoteHeaderFacts,
  }
}

/** 日志的正文（去掉 header 与空行）。空行不占事件位，与 `readTranscript()` 同一口径。 */
function body(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue
    out.push(line.trim())
  }
  return out
}

/**
 * 一行占多少字节（含换行那一字节由调用方加）。
 *
 * 不用 node 的 `Buffer`：这个模块的类型会进浏览器那侧的编译单元（差异视图只引它的类型），
 * `TextEncoder` 两边都有。
 */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** `prefix` 是不是 `whole` 的逐字节前缀（等长也算）。 */
function isPrefix(prefix: readonly string[], whole: readonly string[]): boolean {
  if (prefix.length > whole.length) return false
  return prefix.every((line, index) => line === whole[index])
}

/** 一条尾巴的形状 + 前几条预览。 */
function tail(
  lines: readonly string[],
  headerLine: string | undefined,
  common: number,
  maxPreview: number,
  previewChars: number,
): DiffTail {
  const shown = lines.slice(0, Math.max(maxPreview, 0))
  return {
    count: lines.length,
    bytes: lines.reduce((sum, line) => sum + utf8Length(line) + 1, 0),
    preview: previewOf(headerLine, shown, common, previewChars),
    hidden: Math.max(lines.length - shown.length, 0),
  }
}

/**
 * 把前几条尾巴解析成界面能用的一行摘要。
 *
 * 造一份"只有这些行的日志"（header 照旧在第一行）交给 `readTranscript()`：这样条目的种类、轮次、
 * 工具名与截断规则跟内容视图**同一套**，不用在这里再写一遍解析。
 *
 * **坏行只影响它自己那一条**：解析器会把读不出来的行记进 `problems`（行号是这份小日志里的 1 起），
 * 不产出条目——于是"第 k 个条目"与"第 k 行"错位。这里按 `problems` 的行号把两种来源拼回去：坏行给
 * 原文摘要，其余照旧用解析出来的条目。整份都失败（header 也读不出来）时才全退原文。
 */
function previewOf(
  headerLine: string | undefined,
  lines: readonly string[],
  common: number,
  previewChars: number,
): DiffItem[] {
  if (lines.length === 0 || headerLine === undefined) return []
  try {
    const page = readTranscript([headerLine, ...lines], {
      limit: lines.length + 1,
      maxChars: previewChars,
      maxTotalChars: previewChars * (lines.length + 1),
    })
    // 坏行的行号（小日志里 1 起，header 是第 1 行）换算成尾巴里的下标。
    const broken = new Set(page.problems.map((problem) => problem.line - 2))
    const parsed = [...page.items]
    const out: DiffItem[] = []
    for (const [index, line] of lines.entries()) {
      if (broken.has(index)) {
        out.push({ index: common + index, kind: 'event' as TranscriptKind, type: 'unknown', brief: clip(line, previewChars) })
        continue
      }
      const item = parsed.shift()
      if (item === undefined) throw new Error('preview items do not line up with lines')
      out.push({
        index: common + index,
        ...(item.seq === undefined ? {} : { seq: item.seq }),
        ...(item.time === undefined ? {} : { time: item.time }),
        ...(item.turn === undefined ? {} : { turn: item.turn }),
        kind: item.kind,
        type: item.type,
        brief: briefOf(item, previewChars),
        ...(item.isError === undefined ? {} : { isError: item.isError }),
      })
    }
    return out
  } catch {
    return lines.map((line, index) => ({
      index: common + index,
      kind: 'event' as TranscriptKind,
      type: 'unknown',
      brief: clip(line, previewChars),
    }))
  }
}

/**
 * 一条条目压成一行：正文取首行、工具调用带工具名、其余退回类型。
 *
 * `truncated` 是解析器的记账（哪一格被截到上限了）：被截的那一格补一个省略号，否则界面上看起来像
 * "原文就到这里"，而真相是"后面还有、要看就点开那一格"。
 */
function briefOf(item: TranscriptItem, limit: number): string {
  const squeeze = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim()
  let text: string
  let field: 'text' | 'reasoning' | 'args'
  switch (item.kind) {
    case 'tool-call': {
      const args = squeeze(item.args)
      text = args === '' ? (item.name ?? '') : `${item.name ?? ''} ${args}`
      field = 'args'
      break
    }
    case 'tool-result':
      text = `${item.name ?? ''} ${squeeze(item.text)}`.trim()
      field = 'text'
      break
    case 'reasoning':
      text = `（思考）${squeeze(item.text ?? item.reasoning)}`
      field = 'reasoning'
      break
    default:
      text = squeeze(item.text)
      field = 'text'
      if (text === '') {
        text = item.type
        return clip(text, limit)
      }
  }
  if (text.length > limit) return clip(text, limit)
  // 解析器截过的那一格：长度已经贴着上限了（`clip` 对"等于上限"不再补省略号，这里自己切一刀），
  // 界面得看得出来"后面还有"。
  if (wasTruncated(item, field)) {
    return text.length >= limit ? `${text.slice(0, Math.max(limit - 1, 1))}…` : `${text}…`
  }
  return text
}

/** 这一格被截过没有（解析器的 `truncated` 记账里有没有它）。 */
function wasTruncated(item: TranscriptItem, field: 'text' | 'reasoning' | 'args'): boolean {
  return (item.truncated ?? []).some((entry) => entry.field === field)
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 1))}…`
}

/** header 里对不上的字段。 */
function headerDiff(localLine: string | undefined, remoteLine: string | undefined): DiffHeaderField[] {
  const local = parseHeader(localLine)
  const remote = parseHeader(remoteLine)
  const out: DiffHeaderField[] = []
  for (const field of HEADER_FIELDS) {
    const left = textOf(local?.[field])
    const right = textOf(remote?.[field])
    if (left === right) continue
    out.push({
      field,
      ...(left === undefined ? {} : { local: left }),
      ...(right === undefined ? {} : { remote: right }),
    })
  }
  return out
}

function headerFacts(line: string | undefined): DiffHeaderFacts {
  const header = parseHeader(line)
  if (header === undefined) return {}
  return {
    ...(typeof header.id === 'string' ? { id: header.id } : {}),
    ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
    ...(typeof header.createdAt === 'number' ? { createdAt: header.createdAt } : {}),
    ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
  }
}

function parseHeader(line: string | undefined): Record<string, unknown> | undefined {
  if (line === undefined) return undefined
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : String(value)
}
