// test/session-title.test.ts — 会话标题的两条路（宿主投影缓存 / 日志开头的有界前缀）。
//
// 这里要钉死的是三件事：
//   1. 判据是解析出来的 `type === 'session/title'`，不是子串——`session/title-llm-request` 与
//      "日志里引用标题事件"的文本都不能被当成标题（本仓库自己的日志里就同时有这两种东西）；
//   2. 最新一条生效（用户改名压过首条 fallback），且"读不到"必须是 undefined 而不是空串或抛错——
//      标题是装饰，不该让"列出会话"这件事失败；
//   3. 有界：日志再大也只解开头那一段，且截断处不会把整个读取弄崩。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import {
  DEFAULT_TITLE_BUDGET_BYTES,
  createTitleResolver,
  foldTitle,
  foldTitleInFrames,
  readCachedTitle,
  readLogTitle,
} from '../src/session-title.ts'
import type { DecodeAll } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const SANDBOX = join(import.meta.dirname, '.sandbox', 'session-title')

function resetSandbox(): string {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  return SANDBOX
}

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`
}

/** 一条像模像样的日志：header + 几个事件 + 标题。 */
function logText(titles: Array<string | null>, extra: string[] = []): string {
  const parts = [line({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: '/tmp/x' })]
  parts.push(line({ type: 'user/message', seq: 0, data: { text: '你好' } }))
  for (const title of titles) {
    // null = 写一条"有 type 但标题字段不是字符串"的坏事件
    parts.push(line({ type: 'session/title', seq: 1, data: title === null ? { title: 42 } : { title } }))
  }
  parts.push(...extra)
  return parts.join('')
}

function writeLog(name: string, text: string): string {
  const path = join(SANDBOX, name)
  writeFileSync(path, Buffer.concat(text.split('\n').slice(0, -1).map((l) => encodeRawFrame(`${l}\n`))))
  return path
}

test('foldTitle：最新一条生效，改名压过首条', () => {
  assert.equal(foldTitle(logText(['首条 fallback', '用户改的名字'])), '用户改的名字')
})

test('foldTitle：子串不算数——`session/title-llm-request` 与该事件的文本都不是标题', () => {
  const text = [
    line({ type: 'user/message', seq: 0, data: { text: '我在读 "session/title" 这个事件' } }),
    line({ type: 'session/title-llm-request', seq: 1, data: { messages: [{ role: 'user', content: 'session/title' }] } }),
    line({ type: 'session/title', seq: 2, data: { title: '真标题' } }),
  ].join('')
  assert.equal(foldTitle(text), '真标题')
  // 一行标题事件都没有时必须是 undefined，而不是把上面那些凑巧的文本当标题。
  assert.equal(foldTitle(text.split('\n').slice(0, 2).join('\n')), undefined)
})

test('foldTitle：标题不是字符串、或只有空白，都当没有标题', () => {
  assert.equal(foldTitle(logText([null])), undefined)
  assert.equal(foldTitle(logText(['   '])), undefined)
  // 坏事件不该把前面那条好标题抹掉
  assert.equal(foldTitle(logText(['好标题', null])), '好标题')
})

test('foldTitleInFrames：帧边界按魔数找，假边界自己会被试掉', () => {
  const text = logText(['帧里的标题'])
  const frame = encodeRawFrame(text)
  // 载荷里塞一段"看起来像帧头"的字节：真正的帧边界只有一个，假的那个解码失败被跳过。
  const decoy = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not a frame')])
  assert.equal(foldTitleInFrames(Buffer.concat([frame, decoy]), decodeAll), '帧里的标题')
})

test('foldTitleInFrames：前缀被截断也不抛错（最后一帧不完整就当它没有）', () => {
  const frame = encodeRawFrame(logText(['被截断的标题']))
  const truncated = frame.subarray(0, frame.length - 4)
  assert.equal(foldTitleInFrames(truncated, decodeAll), undefined)
  // 截断处之前的完整帧仍然要读出来
  const good = encodeRawFrame(logText(['第一帧的标题']))
  const tail = encodeRawFrame(line({ type: 'session/title', data: { title: '第二帧的标题' } }))
  assert.equal(foldTitleInFrames(Buffer.concat([good, tail.subarray(0, tail.length - 3)]), decodeAll), '第一帧的标题')
  assert.equal(foldTitleInFrames(Buffer.concat([good, tail]), decodeAll), '第二帧的标题')
})

test('readLogTitle：文件不在、空文件都不抛错', () => {
  resetSandbox()
  assert.equal(readLogTitle(join(SANDBOX, '不存在.zstd'), decodeAll), undefined)
  const empty = join(SANDBOX, 'empty.zstd')
  writeFileSync(empty, Buffer.alloc(0))
  assert.equal(readLogTitle(empty, decodeAll), undefined)
})

test('readLogTitle：只解开头那一段——标题在预算之外时读不到（这是有意的代价）', () => {
  resetSandbox()
  // header + 一大段无关内容（每帧 ~530 字节，合计 ~106KB），标题落在最后。
  const parts = [line({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: '/tmp/x' })]
  for (let i = 0; i < 200; i++) {
    parts.push(line({ type: 'tool/output', seq: i, data: { text: 'x'.repeat(500) } }))
  }
  parts.push(line({ type: 'session/title', seq: 999, data: { title: '很后面的标题' } }))
  const path = writeLog('far.zstd', parts.join(''))

  // 默认预算（256KB）够得着；小预算够不着——这就是"有界"的含义。
  assert.equal(readLogTitle(path, decodeAll), '很后面的标题')
  assert.equal(readLogTitle(path, decodeAll, { budgetBytes: 1024 }), undefined)
  assert.equal(readLogTitle(path, decodeAll, { budgetBytes: 16 * 1024 }), undefined)
  assert.equal(
    readLogTitle(path, decodeAll, { budgetBytes: 1024 }),
    readLogTitle(path, decodeAll, { budgetBytes: 1024 }),
    '同样预算下结果稳定',
  )
})

test('readCachedTitle：读宿主投影缓存里的 rows.title.val，并校验身份', () => {
  const dir = resetSandbox()
  const write = (id: string, record: unknown): void => {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(record))
  }
  const identity = { createdAt: 1000, cwd: '/tmp/x' }
  write('session-a', { version: 7, record: { identity, rows: { title: { val: '缓存里的标题' } } } })

  assert.equal(readCachedTitle(dir, { id: 'session-a', createdAt: 1000, cwd: '/tmp/x' }), '缓存里的标题')
  // createdAt 对不上 = 同 id 的另一条生命周期：宁可不给标题
  assert.equal(readCachedTitle(dir, { id: 'session-a', createdAt: 2000, cwd: '/tmp/x' }), undefined)
  assert.equal(readCachedTitle(dir, { id: 'session-a', createdAt: 1000, cwd: '/tmp/y' }), undefined)
  // 文件不在 / 内容不是 JSON / 形状不认识 / 标题不是字符串：一律 undefined，不抛
  assert.equal(readCachedTitle(dir, { id: 'session-b', createdAt: 1000 }), undefined)
  write('session-b', { record: { identity, rows: {} } })
  assert.equal(readCachedTitle(dir, { id: 'session-b', createdAt: 1000, cwd: '/tmp/x' }), undefined)
  writeFileSync(join(dir, 'session-c.json'), '{不是 JSON')
  assert.equal(readCachedTitle(dir, { id: 'session-c', createdAt: 1000 }), undefined)
  // 没有 cwd 的会话：缓存里也没有 cwd 时才算对得上
  write('session-d', { record: { identity: { createdAt: 1000 }, rows: { title: { val: '无 cwd 的标题' } } } })
  assert.equal(readCachedTitle(dir, { id: 'session-d', createdAt: 1000 }), '无 cwd 的标题')
  assert.equal(readCachedTitle(dir, { id: 'session-d', createdAt: 1000, cwd: '/tmp/x' }), undefined)
})

test('createTitleResolver：缓存优先，缺席时回落到最新一代日志', () => {
  const dir = resetSandbox()
  // 缓存里写着"改名后的标题"，日志里只有老标题：应当以缓存为准
  writeFileSync(
    join(dir, 'session-r.json'),
    JSON.stringify({ record: { identity: { createdAt: 1, cwd: '/tmp/x' }, rows: { title: { val: '缓存标题' } } } }),
  )
  const oldLog = writeLog('r-v3.zstd', logText(['老标题']))
  const newLog = writeLog('r-v4.zstd', logText(['新标题']))

  const resolver = createTitleResolver({ cacheDir: dir, decodeAll })
  assert.equal(
    resolver({
      id: 'session-r',
      createdAt: 1,
      cwd: '/tmp/x',
      files: [
        { path: oldLog, version: 3 },
        { path: newLog, version: 4 },
      ],
    }),
    '缓存标题',
  )

  // 缓存里没有这条（比如刚导入的会话）：回落日志，而且只认最新一代
  assert.equal(
    resolver({
      id: 'session-nocache',
      createdAt: 1,
      cwd: '/tmp/x',
      files: [
        { path: oldLog, version: 3 },
        { path: newLog, version: 4 },
      ],
    }),
    '新标题',
  )
  // 文件列表乱序也一样（按 version 挑，不按数组顺序）
  assert.equal(
    resolver({
      id: 'session-nocache',
      createdAt: 1,
      cwd: '/tmp/x',
      files: [
        { path: newLog, version: 4 },
        { path: oldLog, version: 3 },
      ],
    }),
    '新标题',
  )
  // 一个文件都没有（理论上不会有）：undefined
  assert.equal(resolver({ id: 'session-empty', createdAt: 1, files: [] }), undefined)
})

test('默认预算是个常量，别在别处再写一个数', () => {
  assert.equal(DEFAULT_TITLE_BUDGET_BYTES, 256 * 1024)
})
