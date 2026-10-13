// src/transcript.ts — 把一份会话日志解析成"能从头读到尾的完整时间线"。
//
// 解析这件事本身只认**行**：一行的形状是 `{"type":…,"seq":…,"time":…,"data":…}`，第一行是 session
// header。所以本模块是纯字符串/JSON 处理，不碰文件系统、不碰 DSH，宿主与浏览器两侧都能用（浏览器那边
// 用它渲染、也用它把已读到的部分拼成 Markdown）。
//
// 三条设计取舍：
//
// 1. **一条事件 = 一条条目**，不拆成"每个内容块一条"。事件的 `seq` 是宿主自己的游标，分页游标也用
//    "第几条事件"，两边一一对应，"看这一条的原文"才好实现（见 `TranscriptItem.index`）。助手消息里
//    文本与思考因此在同一条条目里分成两格（`text` / `reasoning`）。
// 2. **工具调用只算一次**。`assistant/message` 的 content 里也带着 tool-call 块，但日志另有独立的
//    `tool/call` 事件（同一次调用、同 `callId`）；时间线上取后者，助手消息里的那些块不再重复成条目。
// 3. **完整优先，但必须有上限**。日志里什么都有：6 MB 的会话、100 KB 的工具输出、几百条 `llm/retry`。
//    所以既不丢事件（不认识的类型也照原样摆出来，只是压成一行 JSON），又给每格文本与整页总量都设上限，
//    被截的地方如实记下原长度（`truncated`），要让用户看全文就按 `index` 单独取那一条。
//
// 字段名沿用日志里的原文（`turn` / `step` / `callId` / `surfaceOp` / `sourceEventSeqs`），不另起一套
// 词汇：出问题时对着日志看就能对上。

/**
 * 内容视图用得上的那几个 header 字段。
 *
 * 刻意**不**从 `src/types.ts` 引 `SessionHeader`：那个模块带着宿主侧的 node 类型，而这个模块浏览器
 * 那侧也要用（类型只影响编译期，但一条 `import type` 会把整份声明拖进客户端的编译单元）。这里只认
 * 自己要用的字段，多出来的照旧在 `header` 里（原样来自日志）。
 */
export interface TranscriptHeader {
  id: string
  createdAt: number
  cwd?: string
  version?: number
  agentPreset?: string
  delegationDepth?: number
  isSeeded?: boolean
  origin?: string
  parentSession?: string
}

/** 条目的种类。界面按它分组配色；`event` 是"其余一切"。 */
export type TranscriptKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'system'
  | 'event'

/** 被截断的一格与它原来的长度（字符数，按码点算）。 */
export interface TranscriptTruncation {
  field: 'text' | 'reasoning' | 'args'
  /** 截断前的字符数。 */
  chars: number
}

/** 时间线上的一条条目：一条事件。 */
export interface TranscriptItem {
  /** 第几条事件（0 = header 后面第一条）。分页游标与"看原文"都用它。 */
  index: number
  /** 事件自己的 seq（日志里可能不连续，所以显示它、不拿它当游标）。 */
  seq?: number
  /** 事件时间（毫秒）。 */
  time?: number
  /** 事件类型原文（`tool/call` 这种）。 */
  type: string
  kind: TranscriptKind
  /** 人类消息正文、助手回答、工具结果、系统消息；其余类型是压缩后的一行 JSON。 */
  text?: string
  /** 助手的思考块（单独一格，界面默认折起来）。 */
  reasoning?: string
  /** 工具名（`tool/call`，以及能按 `callId` 对上调用方的 `tool/result`）。 */
  name?: string
  /** 工具入参原文（JSON 字符串，界面默认折起来）。 */
  args?: string
  callId?: string
  /** 工具结果是不是错误（`tool/result` 的 `isError`）。 */
  isError?: boolean
  /** 这条挂在别的 seq 上（`sourceEventSeqs`），或者 `surfaceOp` 不是 `append`——照实说清楚。 */
  note?: string
  /**
   * 这条人类消息不是人发的。
   *
   * 标题模型那次调用也会以 `user/message` 落进日志（`source.kind` 是 `dsh-session-title-llm`），
   * 时间线上照旧摆出来（"完整"包含它），但标一下，免得被当成用户说过的话。
   */
  synthetic?: boolean
  turn?: number
  step?: number
  /** 哪几格被截断了、原来多长。 */
  truncated?: TranscriptTruncation[]
}

/** 整份日志的计数（与当前页无关：只按行头扫一遍，不解析正文）。 */
export interface TranscriptCounts {
  /** 事件条数（不含 header）。 */
  events: number
  /** 事件类型 → 条数。 */
  byType: Record<string, number>
  /** 人发的消息条数（`user/message` 且 `source.kind === 'user'`）。 */
  human: number
  /** 其余来源的 `user/message`（标题模型、注入的种子内容等）。 */
  synthetic: number
  /** 助手消息条数。 */
  assistant: number
  toolCalls: number
  toolResults: number
  system: number
}

/** 日志里读不出来的行。 */
export interface TranscriptProblem {
  /** 行号（1 起，header 是第 1 行）。 */
  line: number
  error: string
}

/** 一页解析结果。 */
export interface TranscriptPage {
  header: TranscriptHeader
  /** 这次解析的是哪份日志（代次文件名由调用方给，核心层只认内容）。 */
  items: TranscriptItem[]
  counts: TranscriptCounts
  /** 整份日志的事件条数（= 分页的上界）。 */
  totalEvents: number
  /** 这一页从第几条事件开始。 */
  cursor: number
  /** 还没读完时给出下一次该传的 `from`；读完了就没有这个字段。 */
  nextCursor?: number
  problems: TranscriptProblem[]
  /** 因为解析不出 JSON 而被跳过的行数（`problems` 只记前几条的原话）。 */
  problemCount: number
  /** 这一页一共截掉多少字符（> 0 时界面该提示"有内容被截断"）。 */
  truncatedChars: number
}

/** 解析选项。 */
export interface TranscriptOptions {
  /** 从第几条事件开始（负数当 0）。 */
  from?: number
  /** 这一页最多解析几条事件（上限 `MAX_TRANSCRIPT_LIMIT`）。 */
  limit?: number
  /** 单格文本的字符上限。 */
  maxChars?: number
  /** 这一页各格文本的字符总量上限：到了就收尾，`nextCursor` 指向还没读的那条。 */
  maxTotalChars?: number
}

/** 一页最多解析多少条事件。 */
export const MAX_TRANSCRIPT_LIMIT = 500
/** 缺省一页多少条事件。 */
export const DEFAULT_TRANSCRIPT_LIMIT = 80
/** 缺省单格文本上限（字符）。 */
export const DEFAULT_TRANSCRIPT_CHARS = 4000
/** 缺省整页文本总量上限（字符）。 */
export const DEFAULT_TRANSCRIPT_TOTAL_CHARS = 400_000
/** `problems` 里最多记几条原话。 */
const MAX_PROBLEMS = 5

/** header 的必填字段（缺了就当这份日志读不出来，交给调用方报错）。 */
function isHeader(value: unknown): value is TranscriptHeader {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && record['id'] !== '' && typeof record['createdAt'] === 'number'
}

/** 按码点截断（不切开代理对），返回截断后的文本与"被截掉多少字符"。 */
function clamp(text: string, maxChars: number): { text: string; cut: number } {
  // `Array.from` 按码点走：emoji 与 CJK 扩展区都不会被切一半。
  const points = Array.from(text)
  if (points.length <= maxChars) return { text, cut: 0 }
  return { text: points.slice(0, maxChars).join(''), cut: points.length - maxChars }
}

/** 取消息对象里的文本块（`[{type:'text',text}]`），不是这个形状就当空。 */
function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const out: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'text') continue
    if (typeof record['text'] === 'string') out.push(record['text'])
  }
  return out.join('\n')
}

/** 取助手消息里的思考块。 */
function reasoningOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const out: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'reasoning') continue
    if (typeof record['text'] === 'string') out.push(record['text'])
  }
  return out.join('\n')
}

/** 一条事件里能当"正文"的东西：`data.message.content`、`data.content` 或 `data.message` 本身。 */
function messageBlocks(data: Record<string, unknown>): unknown {
  const message = data['message']
  if (message !== null && typeof message === 'object') {
    const content = (message as Record<string, unknown>)['content']
    if (content !== undefined) return content
    // `system/message` 的 `message` 有时直接就是一段文本。
    const text = (message as Record<string, unknown>)['text']
    if (typeof text === 'string') return [{ type: 'text', text }]
  }
  return data['content']
}

/** 一行 JSON 里那点"值得一提"的信息压成一行（其余类型用它当正文）。 */
function compact(data: unknown, maxChars: number): string {
  let raw: string
  try {
    raw = JSON.stringify(data)
  } catch {
    raw = String(data)
  }
  if (raw === undefined) return ''
  // 空的 data（`session/end-seed` 那种）不摆一个 `{}` 出来。
  if (raw === '{}' || raw === 'null') return ''
  return clamp(raw, maxChars).text
}

/** 工具结果的 `callId`：`data.message.source.callId` 或 `data.toolCallId`。 */
function callIdOf(data: Record<string, unknown>): string | undefined {
  const direct = data['toolCallId']
  if (typeof direct === 'string' && direct !== '') return direct
  const message = data['message']
  if (message !== null && typeof message === 'object') {
    const source = (message as Record<string, unknown>)['source']
    if (source !== null && typeof source === 'object') {
      const callId = (source as Record<string, unknown>)['callId']
      if (typeof callId === 'string' && callId !== '') return callId
    }
  }
  return undefined
}

/** 事件行里那个 `type`（不解析 JSON：分页之前要按整份日志数一遍）。 */
const TYPE_PREFIX = /^\{"type":"([^"]+)"/

/**
 * 按行头数一遍整份日志：事件条数、各类型条数、人发的与合成的消息数。
 *
 * 这一步刻意不 `JSON.parse` 正文（大库上正文可能有几百 MB）：`user/message` 要看 `source.kind`
 * 才分得清人发的与标题模型那次的，所以只对这种行多解析一次。
 */
export function countTranscript(lines: readonly string[]): TranscriptCounts {
  const byType: Record<string, number> = {}
  let events = 0
  let human = 0
  let synthetic = 0
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim() === '') continue
    const match = TYPE_PREFIX.exec(line)
    const type = match?.[1] ?? 'unknown'
    byType[type] = (byType[type] ?? 0) + 1
    events += 1
    if (type === 'user/message') {
      let fromHuman = false
      try {
        const event = JSON.parse(line) as { data?: { source?: { kind?: unknown } } }
        fromHuman = event.data?.source?.kind === 'user'
      } catch {
        fromHuman = false
      }
      if (fromHuman) human += 1
      else synthetic += 1
    }
  }
  return {
    events,
    byType,
    human,
    synthetic,
    assistant: byType['assistant/message'] ?? 0,
    toolCalls: byType['tool/call'] ?? 0,
    toolResults: byType['tool/result'] ?? 0,
    system: byType['system/message'] ?? 0,
  }
}

/** `sourceEventSeqs` / `surfaceOp` 那点信息：不是普通的追加就照实说一句。 */
function noteOf(event: Record<string, unknown>): string | undefined {
  const notes: string[] = []
  const source = event['sourceEventSeqs']
  if (Array.isArray(source) && source.length > 0) notes.push(`挂在 seq ${source.join('、')}`)
  const op = event['surfaceOp']
  if (typeof op === 'string' && op !== '' && op !== 'append') notes.push(op === 'replace' ? '替换了前面的内容' : op)
  return notes.length === 0 ? undefined : notes.join('；')
}

/** 解析一条事件。 */
function parseItem(
  line: string,
  index: number,
  maxChars: number,
  names: Map<string, string>,
): { item: TranscriptItem; truncated: number } | { problem: string } {
  let event: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed === null || typeof parsed !== 'object') return { problem: '不是 JSON 对象' }
    event = parsed as Record<string, unknown>
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
  const type = typeof event['type'] === 'string' ? event['type'] : 'unknown'
  const data = (event['data'] ?? {}) as Record<string, unknown>
  const item: TranscriptItem = { index, type, kind: 'event' }
  if (typeof event['seq'] === 'number') item.seq = event['seq']
  if (typeof event['time'] === 'number') item.time = event['time']
  const note = noteOf(event)
  if (note !== undefined) item.note = note
  for (const key of ['turn', 'step'] as const) {
    const value = data[key]
    if (typeof value === 'number') item[key] = value
  }
  const truncated: TranscriptTruncation[] = []
  let cutChars = 0
  /** 截一格：记下原长度。 */
  const put = (field: 'text' | 'reasoning' | 'args', value: string): string => {
    const { text, cut } = clamp(value, maxChars)
    if (cut > 0) {
      truncated.push({ field, chars: Array.from(value).length })
      cutChars += cut
    }
    return text
  }

  switch (type) {
    case 'user/message': {
      item.kind = 'user'
      const source = data['source']
      const kind =
        source !== null && typeof source === 'object'
          ? (source as Record<string, unknown>)['kind']
          : undefined
      if (kind !== 'user') item.synthetic = true
      const text = textOf(data['content'])
      if (text !== '') item.text = put('text', text)
      break
    }
    case 'assistant/message': {
      const blocks = messageBlocks(data)
      const text = textOf(blocks)
      const reasoning = reasoningOf(blocks)
      if (text === '' && reasoning !== '') item.kind = 'reasoning'
      else item.kind = 'assistant'
      if (text !== '') item.text = put('text', text)
      if (reasoning !== '') item.reasoning = put('reasoning', reasoning)
      break
    }
    case 'tool/call': {
      item.kind = 'tool-call'
      const name = data['name']
      if (typeof name === 'string') {
        item.name = name
        const callId = data['callId']
        if (typeof callId === 'string' && callId !== '') names.set(callId, name)
      }
      const callId = data['callId']
      if (typeof callId === 'string') item.callId = callId
      const args = data['arguments']
      if (typeof args === 'string' && args !== '') item.args = put('args', args)
      break
    }
    case 'tool/result': {
      item.kind = 'tool-result'
      const callId = callIdOf(data)
      if (callId !== undefined) {
        item.callId = callId
        const name = names.get(callId)
        if (name !== undefined) item.name = name
      }
      const message = data['message']
      if (message !== null && typeof message === 'object') {
        const record = message as Record<string, unknown>
        if (record['isError'] === true) item.isError = true
        const text = textOf(record['content'])
        if (text !== '') item.text = put('text', text)
      }
      if (item.text === undefined) {
        const text = textOf(data['content'])
        if (text !== '') item.text = put('text', text)
      }
      break
    }
    case 'system/message': {
      item.kind = 'system'
      const text = textOf(messageBlocks(data))
      if (text !== '') item.text = put('text', text)
      break
    }
    default: {
      // `session/title` 与其它"值得一提"的控制事件给一句人话，剩下的照原样压一行 JSON。
      const text = kindText(type, data) ?? compact(data, Math.min(maxChars, 800))
      if (text !== '') item.text = text
      break
    }
  }
  if (truncated.length > 0) item.truncated = truncated
  return { item, truncated: cutChars }
}

/** 给几种常见的控制事件一句人话（`undefined` = 不认识，交给 `compact`）。 */
function kindText(type: string, data: Record<string, unknown>): string | undefined {
  switch (type) {
    case 'session/title': {
      const title = data['title']
      const source = data['source']
      const kind =
        source !== null && typeof source === 'object'
          ? (source as Record<string, unknown>)['kind']
          : undefined
      const who = kind === 'provider' ? '模型' : kind === 'user' ? '人（改名）' : '兜底'
      return typeof title === 'string' ? `标题（${who}）：${title}` : undefined
    }
    case 'session/title-llm-request': {
      const provider = data['titleProvider']
      const route = data['route']
      const model =
        route !== null && typeof route === 'object'
          ? (route as Record<string, unknown>)['model']
          : undefined
      return `标题请求：${String(provider ?? '未知 provider')}｜${String(model ?? '未知模型')}`
    }
    case 'model/selection': {
      return `选了模型：${String(data['provider'] ?? '')}｜${String(data['model'] ?? '')}`
    }
    case 'permission/preset':
      return `权限预设：${String(data['preset'] ?? '')}`
    case 'sandbox/mode':
      return `沙箱：${String(data['mode'] ?? '')}`
    case 'approval/policy':
      return `审批：${String(data['policy'] ?? '')}`
    case 'turn/start':
      return `第 ${String(data['turn'] ?? '?')} 轮开始`
    case 'turn/end': {
      const reason = data['reason']
      const kind =
        reason !== null && typeof reason === 'object'
          ? (reason as Record<string, unknown>)['kind']
          : undefined
      return `第 ${String(data['turn'] ?? '?')} 轮结束${kind === undefined ? '' : `（${String(kind)}）`}`
    }
    case 'step/start':
      return `第 ${String(data['turn'] ?? '?')} 轮第 ${String(data['step'] ?? '?')} 步开始`
    case 'step/end':
      return `第 ${String(data['turn'] ?? '?')} 轮第 ${String(data['step'] ?? '?')} 步结束`
    default:
      return undefined
  }
}

/**
 * 解析一页。
 *
 * @param lines 日志的每一行（第一行是 header）。空行会被跳过（日志尾部通常有一个换行）。
 * @param options 分页与上限（见 `TranscriptOptions`）。
 * @throws 第一行不是合法 session header 时抛错——那是调用方该报的"这份日志读不出来"。
 */
export function readTranscript(lines: readonly string[], options: TranscriptOptions = {}): TranscriptPage {
  const headerLine = lines[0]
  if (headerLine === undefined) throw new Error('session log is empty')
  let header: TranscriptHeader
  try {
    const parsed: unknown = JSON.parse(headerLine)
    if (!isHeader(parsed)) throw new Error('header is missing id/createdAt')
    header = parsed
  } catch (error) {
    throw new Error(`session log header is not valid: ${error instanceof Error ? error.message : String(error)}`)
  }

  /** 事件行的行号（1 起）逐个记下来：空行不占事件位，但 `problems` 要报原始行号。 */
  const eventLines: number[] = []
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() !== '') eventLines.push(index)
  }
  const totalEvents = eventLines.length
  const counts = countTranscript(lines)

  const from = Math.max(0, Math.trunc(options.from ?? 0))
  const limit = Math.min(MAX_TRANSCRIPT_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_TRANSCRIPT_LIMIT)))
  const maxChars = Math.max(1, Math.trunc(options.maxChars ?? DEFAULT_TRANSCRIPT_CHARS))
  const maxTotalChars = Math.max(1, Math.trunc(options.maxTotalChars ?? DEFAULT_TRANSCRIPT_TOTAL_CHARS))

  const items: TranscriptItem[] = []
  const problems: TranscriptProblem[] = []
  let problemCount = 0
  let truncatedChars = 0
  let usedChars = 0
  let nextCursor: number | undefined
  // 工具名先按 `tool/call` 收着：`tool/result` 自己不带工具名，两边靠 `callId` 对上。
  const names = new Map<string, string>()

  for (let at = from; at < totalEvents; at += 1) {
    if (items.length >= limit) {
      nextCursor = at
      break
    }
    // 整页文本总量到顶就收尾（不丢事件：下一条留给下一页）。
    if (usedChars >= maxTotalChars && items.length > 0) {
      nextCursor = at
      break
    }
    const lineNumber = eventLines[at]!
    const line = lines[lineNumber]!
    const parsed = parseItem(line, at, maxChars, names)
    if ('problem' in parsed) {
      problemCount += 1
      if (problems.length < MAX_PROBLEMS) problems.push({ line: lineNumber + 1, error: parsed.problem })
      continue
    }
    items.push(parsed.item)
    truncatedChars += parsed.truncated
    usedChars +=
      Array.from(parsed.item.text ?? '').length +
      Array.from(parsed.item.reasoning ?? '').length +
      Array.from(parsed.item.args ?? '').length
  }
  return {
    header,
    items,
    counts,
    totalEvents,
    cursor: from,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    problems,
    problemCount,
    truncatedChars,
  }
}
