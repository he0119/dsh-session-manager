/**
 * Agent Note 的格式契约：`{lifecycle}/{class}/yyyy-mm-dd-title.md` 加固定的前三行。
 *
 * 这套结构只有在被机械核过之后才站得住：状态编码在**目录**里、骨架编码在**头部三行**与章节名里，
 * 两件事都不需要读懂内容就能判定。因此这一份不测行为，只核声明——它盯的是「笔记被搬到了另一层目录
 * 却没改 Status」「implemented/ 里混进了提案用语」这类靠 review 容易漏掉的漂移。
 *
 * 本仓库的 runner（test/run-all.mjs）会把 test/ 下的每一个 .test.ts 在同一进程里 import 一遍，
 * 所以这份用例不需要单独接线。
 *
 * @module dsh-session-manager/test/notes
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const NOTES_ROOT = join(HERE, '..', '.agents', 'notes')

/** 生命周期目录（顶层）与它们各自允许的 `Status:` 行。 */
const LIFECYCLES = ['proposed', 'implemented', 'rejected'] as const
type Lifecycle = (typeof LIFECYCLES)[number]

/** 类别目录（嵌套）。封闭集合：新增一类要同时改这里与 `.agents/notes/AGENTS.md`。 */
const CLASSES = [
  'feature',
  'bug-fix',
  'simplification',
  'architecture',
  'process',
  'testing',
] as const

/** 每层必需的章节——`## Problem` 之外的部分。 */
const REQUIRED: Readonly<Record<Lifecycle, readonly string[]>> = {
  proposed: ['Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks'],
  implemented: ['Decision', 'Alternatives considered', 'Consequences'],
  rejected: ['Proposal', 'Alternatives considered'],
}

/** `implemented/` 里不许出现的提案用语：它们描述的是还没发生的事。 */
const PROPOSAL_SPEAK = ['Proposal', 'Plan', 'Migration plan', 'Acceptance criteria']

/** 一篇形状合法的笔记的路径信息。 */
interface ShapedNote {
  readonly path: string
  readonly rel: string
  readonly lifecycle: Lifecycle
  readonly kind: string
}

/** 递归列出目录下的所有**文件**（笔记只有三层，但爬完更省心）。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** 笔记语料里除各层 `AGENTS.md` 之外的全部文件。 */
const ALL_FILES = existsSync(NOTES_ROOT)
  ? walk(NOTES_ROOT).filter((path) => basename(path) !== 'AGENTS.md')
  : []

/** 把一条路径解析成 `{lifecycle}/{class}/name.md`，失败时给出人话原因。 */
function shapeOf(path: string): { note?: ShapedNote; problem?: string } {
  const rel = relative(NOTES_ROOT, path).split(/[\\/]/).join('/')
  if (rel.endsWith('.zh.md')) return { problem: `${rel}：笔记是中文单语，不建 .zh.md 对侧文件` }
  if (!rel.endsWith('.md')) return { problem: `${rel}：笔记目录里只放 .md` }
  const segments = rel.split('/')
  if (segments.length !== 3) {
    return { problem: `${rel}：路径应当是 {lifecycle}/{class}/yyyy-mm-dd-topic-title.md` }
  }
  const [lifecycle, kind, name] = segments as [string, string, string]
  if (!(LIFECYCLES as readonly string[]).includes(lifecycle)) {
    return { problem: `${rel}：生命周期目录只能是 ${LIFECYCLES.join(' / ')}` }
  }
  if (!(CLASSES as readonly string[]).includes(kind)) {
    return { problem: `${rel}：类别目录只能是 ${CLASSES.join(' / ')}` }
  }
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(name)) {
    return { problem: `${rel}：文件名应当是 yyyy-mm-dd-topic-title.md` }
  }
  return { note: { path, rel, lifecycle: lifecycle as Lifecycle, kind } }
}

/** 形状合法的笔记；形状不合法的那些由「路径形状」那一条用例报出来。 */
const NOTES: readonly ShapedNote[] = ALL_FILES.map(shapeOf)
  .map((result) => result.note)
  .filter((note): note is ShapedNote => note !== undefined)

/** 一篇笔记按行拆开（保留首部的空行）。 */
function linesOf(note: ShapedNote): readonly string[] {
  return readFileSync(note.path, 'utf8').split('\n')
}

/** 二级标题，按出现顺序。 */
function headingsOf(note: ShapedNote): readonly string[] {
  const text = readFileSync(note.path, 'utf8')
  return [...text.matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1] as string)
}

describe('Agent Note 的格式契约', () => {
  it('语料不是空的——门禁不能空转', () => {
    assert.ok(
      NOTES.length > 0,
      `在 ${NOTES_ROOT} 下一篇笔记都没找到；目录搬了、或者门禁的根目录写错了`,
    )
  })

  it('路径形状是 {lifecycle}/{class}/yyyy-mm-dd-topic-title.md', () => {
    const problems = ALL_FILES.map(shapeOf)
      .map((result) => result.problem)
      .filter((problem): problem is string => problem !== undefined)
    assert.deepEqual(problems, [], `笔记目录里有不合契约的路径：\n${problems.join('\n')}`)
  })

  it('前三行固定，且 Status 与所在目录一致', () => {
    const problems: string[] = []
    for (const note of NOTES) {
      const lines = linesOf(note)
      const title = lines[0] ?? ''
      const blank = lines[1] ?? ''
      const status = lines[2] ?? ''
      if (!/^# Agent Note: \S/.test(title)) {
        problems.push(`${note.rel}：第 1 行应当是 \`# Agent Note: <标题>\`，实际是 ${JSON.stringify(title)}`)
      }
      if (blank !== '') {
        problems.push(`${note.rel}：第 2 行应当是空行，实际是 ${JSON.stringify(blank)}`)
      }
      const declared = /^Status: (.+)$/.exec(status)?.[1]
      if (declared === undefined) {
        problems.push(`${note.rel}：第 3 行应当是 \`Status: …\`，实际是 ${JSON.stringify(status)}`)
        continue
      }
      const agreed =
        note.lifecycle === 'rejected'
          ? /^rejected — \S/.test(declared)
          : declared === note.lifecycle
      if (!agreed) {
        problems.push(
          `${note.rel}：Status 与目录不一致——目录是 ${note.lifecycle}，声明是 ${JSON.stringify(declared)}` +
            (note.lifecycle === 'rejected' ? '（rejected 必须在 Status 行写一句原因）' : ''),
        )
      }
      if ((lines[3] ?? '') !== '') {
        problems.push(`${note.rel}：Status 行之后应当跟一个空行`)
      }
    }
    assert.deepEqual(problems, [], `头部三行不合契约：\n${problems.join('\n')}`)
  })

  it('正文以 ## Problem 开头，必备章节齐全、提案用语不在 implemented/ 里', () => {
    const problems: string[] = []
    for (const note of NOTES) {
      const headings = headingsOf(note)
      if (headings[0] !== 'Problem') {
        problems.push(`${note.rel}：第一个二级标题应当是 ## Problem，实际是 ${JSON.stringify(headings[0] ?? '（没有二级标题）')}`)
      }
      const required = ['Problem', ...REQUIRED[note.lifecycle]]
      for (const section of required) {
        if (!headings.includes(section)) problems.push(`${note.rel}：缺 ## ${section}`)
      }
      if (note.lifecycle === 'implemented') {
        for (const section of PROPOSAL_SPEAK) {
          if (headings.includes(section)) {
            problems.push(`${note.rel}：implemented/ 里不许出现 ## ${section}（提案用语，随代码腐烂）`)
          }
        }
      }
    }
    assert.deepEqual(problems, [], `章节不合契约：\n${problems.join('\n')}`)
  })

  it('相对链接都能解析', () => {
    const problems: string[] = []
    for (const note of NOTES) {
      const text = readFileSync(note.path, 'utf8')
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = match[1] as string
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // http(s): / mailto: 之类
        const path = resolve(dirname(note.path), target.split('#')[0] as string)
        if (!existsSync(path)) problems.push(`${note.rel}：链不到 ${target}`)
      }
    }
    assert.deepEqual(problems, [], `笔记里有解析不了的链接：\n${problems.join('\n')}`)
  })
})
