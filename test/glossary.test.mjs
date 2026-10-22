// test/glossary.test.mjs — 术语表的存在性，以及"用户看得见的那一层不写旧词"。
//
// 措辞本身没法自动判对错，但有两件事可以：一是术语表得有个真身、四个列都得填，别处得链到它；二是
// **界面文案里不能再出现术语表点名"别写"的那些词**——这类回归以前只能靠人读，读漏了没人知道。
//
// 旧词名单在下面 `BANNED_IN_COPY` 里维护，与 `docs/glossary.md` 的「别写」那一列是同一批；加词时
// 两边一起改（表里那一列要写清为什么不写，这份名单只负责拦）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

/** 界面文案里不许出现的旧词（`src/client/logic/locales.ts` 两语都要干净）。 */
const BANNED_IN_COPY = [
  ['回合', '会话的一轮的官方说法是「轮次」'],
  ['半边', '两侧的官方说法是「Host 半侧 / 浏览器半侧」，说一侧时用「这一侧」'],
  ['推上去', '会话同步的方向叫「推送」'],
  ['拉下来', '会话同步的方向叫「拉取」'],
  ['宿主机', '宿主进程叫「宿主」；界面里说具体的事（DSH 的凭据），不搬这个词'],
  ['槽位', '`Slot` 官方保留英文，不译'],
  ['分桶', '目录叫「项目目录」，按前两位分的叫「子目录」'],
]

test('术语表在，四个列都填了，每行都有出处', () => {
  const text = read('docs/glossary.md')
  assert.match(text, /^# 术语表$/m, '第一行标题是「术语表」')
  assert.match(text, /\| 概念 \| 官方说法 \| 别写 \| 出处 \|/, '四列固定：概念 / 官方说法 / 别写 / 出处')
  assert.match(text, /## 加新词的时候/, '要写清加新词的三步，否则下一个人还会另开一份说法')

  const rows = text
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('| 概念') && !/^\|\s*-+/.test(line))
  assert.ok(rows.length >= 15, `表里至少得有十几行（现在 ${rows.length} 行）`)

  for (const row of rows) {
    // 单元格里可能有 `|` 之外的 Markdown（链接、代码），这里只核列数与有没有空列。
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim())
    assert.equal(cells.length, 4, `这一行不是四列：${row.slice(0, 60)}`)
    const [concept, official, forbidden, source] = cells
    assert.ok(concept !== '', `缺「概念」：${row.slice(0, 60)}`)
    assert.ok(official !== '', `${concept} 没写官方说法`)
    assert.ok(forbidden !== '', `${concept} 的「别写」列空着（要写清为什么不写，写「——」也算）`)
    assert.match(source, /https?:\/\/|官方包|官方界面|官方文档|本仓库/, `${concept} 的出处得指明是哪一页 / 哪个包`)
  }
})

test('根 AGENTS.md、design.md、docs/AGENTS.md 都链到术语表', () => {
  assert.match(read('AGENTS.md'), /docs\/glossary\.md/, '根 AGENTS.md 要指过去')
  assert.match(read('docs/design.md'), /glossary\.md/, 'design.md 要指过去')
  assert.match(read('docs/AGENTS.md'), /glossary\.md/, 'docs/AGENTS.md 的文档分工表要认这一份')
})

test('界面文案里没有术语表点名"别写"的词（中英两份）', () => {
  const copy = read('src/client/logic/locales.ts')
  for (const [word, why] of BANNED_IN_COPY) {
    assert.ok(!copy.includes(word), `界面文案里还有「${word}」：${why}`)
  }
})

test('两份字典仍然一对一的键，术语表不靠改键名绕过去', () => {
  const copy = read('src/client/logic/locales.ts')
  // 术语表点名的几个键还在原处：改名会让上面那条断言空过（改了键名、文案跟着换词，读者照样看到旧词）。
  for (const key of ['sync.field.autoPushHint', 'sync.autoPush.enabled', 'sync.diff.tail.empty.local', 'sync.diff.tail.empty.remote']) {
    assert.ok(copy.includes(`'${key}'`), `字典里少了 ${key}`)
  }
})
