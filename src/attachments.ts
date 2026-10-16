// src/attachments.ts — 会话日志里引用的附件对象：找出引用、对位本机附件库、把对象原子落进目标库。
//
// 为什么需要这一层：日志里**不存图片字节**，只存一条内容寻址的引用
// （`{"type":"image","attachment":{"attachmentId":"sha256:…"}}`），字节在**宿主自己的附件库**里
// （图片：`$DSH_HOME/attachments/v1/objects/<前两位>/<sha256>`；文件：`files/<前两位>/<sha256>/<名字>`，
// 内容寻址的那一份在 `file-objects/<前两位>/<sha256>`，见宿主的 dsh-attachment-local）。
// 于是只带日志的会话包换一个 `$DSH_HOME` 打开，得到的是"引用在、对象不在"——界面上一句
// 「图片加载失败，点击重试」，点几次都一样。这一层补的就是那段字节：**包把对象一起带走，落地把
// 对象写进目标库**。
//
// 为什么在核心层（零 DSH 依赖）：**引用的形状**（日志 JSON）与**对象放在哪儿**是两件事。前者是格式，
// 后者是宿主的库。核心只认一个端口 `AttachmentPort`（引用 → 本机绝对路径，纯路径计算、不读对象），
// 由宿主实现（`ctx.attachments.imageHostPath()/fileHostPath()`，见 src/tools.ts 的 `attachmentPort()`）。
// 端口缺席（宿主没有附件服务）时这一层整个不生效：包照旧只带日志，与旧版一样。
//
// @module dsh-session-manager/attachments
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { DecodeAll } from './types.ts'

/**
 * 附件的两个库：图片对象与文件对象**分开存**（宿主 dsh-attachment-local 的两个目录），
 * 所以一个引用除了内容寻址 id 之外还必须知道它属于哪个库，落地时才知道往哪儿写。
 */
export type AttachmentKind = 'image' | 'file'

/** 一条内容寻址的附件引用（日志里记的就是它）。 */
export interface AttachmentRef {
  /** `sha256:<64 位小写十六进制>`。 */
  id: string
  kind: AttachmentKind
  /**
   * 日志里记的字节数（宿主写引用时一定带上）。
   *
   * 只有"本机那份还在不在"这一个判据用它（见 `attachmentActionOf()`）：对不上就要重新取。**任何路径
   * 计算都不看它**（`pathOf()` 只认 id 与 kind），所以老日志缺这一项时功能照旧，只是判"在不在"时
   * 只能按"文件在就算在"。
   */
  bytes?: number
  /**
   * **文件**对象在日志里带的名字（图片没有这一项）。它决定本机路径的最后一段：宿主把文件摆在
   * `files/<sha 前两位>/<sha>/<名字>`（图片则是 `objects/<前两位>/<sha>`），只给 id 算不出文件路径
   * ——`ctx.attachments.fileHostPath()` 缺名字会直接抛错（它还要核名字是不是一个合法叶子名）。
   */
  name?: string
}

/**
 * 宿主附件库的端口。
 *
 * 只要求"给我这个引用在本机的绝对路径"——宿主的实现是**纯路径计算**（不读对象、对象不存在也给得出
 * 路径），所以导出侧能拿它定位对象、导入侧能拿它算出目标路径。这样核心不必复刻附件库的目录形状：
 * 库怎么摆是宿主的事，换一个 provider 也照旧成立。
 */
export interface AttachmentPort {
  /** @returns 该引用在本机的绝对路径；宿主不认识这种引用时 undefined。 */
  pathOf(ref: AttachmentRef): string | undefined
}

/** 内容寻址 id：`sha256:` + 64 位小写十六进制。 */
const ATTACHMENT_ID_RE = /^sha256:[0-9a-f]{64}$/

/**
 * 这段值是不是一个合法的附件 id。
 * @param value 日志里读到的任意值。
 */
export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID_RE.test(value)
}

/** 日志里认得的两种附件块。 */
const KINDS: readonly AttachmentKind[] = ['image', 'file']

/**
 * 一条日志行里认出的引用：只有同时满足"块类型是 image/file"与"attachment.attachmentId 合法"才算。
 *
 * 判据是**解析出来的字段**而不是子串：`attachment` 这个词在别处也出现（工具入参、文档正文），
 * 子串判据会把它们当成附件。子串只用作**廉价预筛**（见 `scanAttachmentRefs()`）。
 */
function refsInValue(value: unknown, found: Map<string, AttachmentRef>): void {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }
    if (typeof current !== 'object' || current === null) continue
    const record = current as Record<string, unknown>
    const kind = KINDS.find((candidate) => record['type'] === candidate)
    if (kind !== undefined) {
      const attachment = record['attachment']
      if (typeof attachment === 'object' && attachment !== null) {
        const id = (attachment as Record<string, unknown>)['attachmentId']
        if (isAttachmentId(id)) {
          const declared = (attachment as Record<string, unknown>)['bytes']
          const bytes =
            typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0 ? declared : undefined
          const declaredName = (attachment as Record<string, unknown>)['name']
          const name =
            typeof declaredName === 'string' && declaredName.length > 0 ? declaredName : undefined
          // 同一个 id 在日志里会出现多次（`agent/inbox/spliced` 与随后的 `user/message` 各一份）：
          // 去重键带上 kind——两个库里的对象互不相干，同一个 sha 在两边都有是两件事。字节数以**有值的
          // 那一次**为准：老日志可能不带这一项，不带的那次不能把已知的值抹掉。
          const key = `${kind}:${id}`
          const seen = found.get(key)
          const known = bytes ?? seen?.bytes
          // 名字与字节数同理：不给的那一次不能把已知的值抹掉。
          const knownName = name ?? seen?.name
          found.set(key, {
            id,
            kind,
            ...(known === undefined ? {} : { bytes: known }),
            ...(knownName === undefined ? {} : { name: knownName }),
          })
        }
      }
    }
    for (const inner of Object.values(record)) {
      if (typeof inner === 'object' && inner !== null) stack.push(inner)
    }
  }
}

/**
 * 扫一段**已解开**的日志文本，收集里面引用到的附件对象。
 *
 * 用子串预筛再解析：绝大多数行里没有 `"attachmentId"`，一行不上 JSON.parse；命中的那些才解析成
 * 对象、按**字段**判定（`type` + `attachment.attachmentId`）。整份日志要扫（图片可能在任何一处），
 * 所以这一步是导出/推送里解码之外的主要开销——但它只落在**真的带附件**的那些会话上（见
 * `buildBundle()`：清单里没有引用就不解码）。
 *
 * @param text 日志明文（整份）。
 * @returns 去重后的引用，按首次出现的顺序。
 */
export function scanAttachmentRefs(text: string): AttachmentRef[] {
  const found = new Map<string, AttachmentRef>()
  for (const line of text.split('\n')) {
    if (!line.includes('"attachmentId"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // 半截行（崩在写入中途的日志）不算错，跳过
    }
    refsInValue(parsed, found)
  }
  return [...found.values()]
}

/**
 * 一份日志文件的明文：zstd 外壳的解一次，明文的原样。
 *
 * 与 `relocateHeaderCwd*` / `foldTitleInFrames` 同一口径——日志的压缩形态由文件后缀决定，核心不认识
 * 别的形态。
 * @param buf 磁盘上的原始字节。
 * @param compression `'zstd'` 或 null。
 * @param decodeAll 多帧感知解码器。
 */
export function decodeLogText(buf: Buffer, compression: string | null, decodeAll: DecodeAll): string {
  return compression === 'zstd' ? decodeAll(buf) : buf.toString('utf8')
}

/** 落一个对象的结果：写下去了，还是本机本来就有。 */
export type CommitOutcome = 'written' | 'present'

/**
 * 把一段对象字节落进目标附件库（幂等）。
 *
 * 内容寻址让这件事是安全的：文件名就是内容的 sha256，写下去的东西由读的那一侧再验一遍
 * （宿主 `readImageFile()` / 文件的读取路径都会核 sha256 与引用的元数据），所以"补一个对象"不会
 * 造成"内容对不上引用"这种损坏。因此判定很窄：
 *
 *   - 同名且字节数一致 → `present`，一个字节都不动（对象库是只读的，绝大多数重复导入落在这一支）；
 *   - 其余（不存在，或存在但大小对不上——比如上次崩在半途）→ 原子写：`<名>.part` 写完 rename 过去。
 *
 * `.part` 这个后缀与日志那条路同一套理由：它不是任何合法对象名，宿主按精确路径读对象、也不会去
 * 扫 `objects/` 目录（见宿主 dsh-attachment-local 的 `publishStagedObject()`：它自己用 `<root>/tmp`
 * 暂存再 `link()`），所以崩在中途留下的是一个被忽略的文件，而不是一个看起来正常的半个对象。
 *
 * 权限照抄宿主写对象时的规格（目录 0700、文件 0400）：对象库是**只读**的，读的那一侧不会因为
 * 多一份可写副本而改变行为。
 *
 * @param path 目标绝对路径（由 `AttachmentPort.pathOf()` 给出）。
 * @param bytes 对象字节（已按引用核过 sha256）。
 */
export function commitAttachmentObject(path: string, bytes: Buffer): CommitOutcome {
  if (existsSync(path) && statSync(path).size === bytes.length) return 'present'
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const part = `${path}.part`
  writeFileSync(part, bytes, { mode: 0o400 })
  renameSync(part, path)
  // rename 之后补一次 chmod：目标已存在时 rename 保留的是**旧文件**的权限位，而旧文件可能是别的
  // 来源写下的（权限不对）。对象库的规格只有一条，写下去就照它对齐。
  chmodSync(path, 0o400)
  return 'written'
}
