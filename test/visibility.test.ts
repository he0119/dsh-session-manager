// 侧边栏可见性：哪三类会话外壳不显示，以及"宿主说它空白吗"从哪读。
//
// 这条判据在真实库里错过一次：迁移面板的「未分组」报 4 条，而外壳侧边栏那一组只显示 1 条。差额是三
// 条不同的隐藏理由（子代理 597.6KB 那条、两条只有 seed 事件的空白会话，其中一条还已归档），而面板与
// 侧边栏当时各算各的。这里把判据与它的三个输入逐个钉死：
//   - `hiddenReason()` 的**顺序**（宿主的顺序：先子代理、再空白、最后归档）；
//   - 投影缓存里读到什么（`sessionListMetadata.blank`），读不到/身份对不上时按"会显示"处理；
//   - `hiddenReasonOf()` 把 header / 注册表 / 缓存三处拼起来的那一步。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { readProjectionCache } from '../src/projection-cache.ts'
import { createBlankResolver, hiddenReason, hiddenReasonOf } from '../src/visibility.ts'

const SANDBOX = join(import.meta.dirname, '.sandbox', 'visibility')

function resetSandbox(): string {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  return SANDBOX
}

function writeCache(dir: string, id: string, record: unknown): void {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record))
}

test('hiddenReason：三条理由按宿主的顺序判，都不成立才是"会显示"', () => {
  // 宿主那一侧的顺序是 origin → blank → 归档过滤（见 dsh-client-ui-workspace 的 sessionVisible）。
  assert.equal(hiddenReason({}), undefined)
  assert.equal(hiddenReason({ origin: 'subagent' }), 'subagent')
  assert.equal(hiddenReason({ blank: false }), undefined)
  assert.equal(hiddenReason({ blank: true }), 'blank')
  assert.equal(hiddenReason({ archived: true }), 'archived')
  // 同时符合多条时报先判的那条：界面上的说明文字因此与"它在侧边栏为什么没有"的直觉一致。
  assert.equal(hiddenReason({ origin: 'subagent', blank: true, archived: true }), 'subagent')
  assert.equal(hiddenReason({ blank: true, archived: true }), 'blank')
  // `blank` 只有明确 true 才算（undefined = 宿主没说，按会显示处理）。
  assert.equal(hiddenReason({ blank: undefined, archived: undefined }), undefined)
})

test('readProjectionCache：读 sessionListMetadata.blank，身份对不上就不认', () => {
  const dir = resetSandbox()
  writeCache(dir, 'session-blank', {
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: 1000, cwd: '/tmp/x' },
      rows: { sessionListMetadata: { ver: 1, seq: 3, val: { blank: true, lastPromptAt: null } } },
    },
  })
  assert.deepEqual(readProjectionCache(dir, { id: 'session-blank', createdAt: 1000, cwd: '/tmp/x' }), { blank: true })
  // createdAt / cwd 是身份的一部分：同 id 的另一条生命周期（删了重建、缓存残留）不认。
  assert.equal(readProjectionCache(dir, { id: 'session-blank', createdAt: 2000, cwd: '/tmp/x' }), undefined)
  assert.equal(readProjectionCache(dir, { id: 'session-blank', createdAt: 1000, cwd: '/tmp/y' }), undefined)
})

test('readProjectionCache：字段不是布尔 / 文件坏了 / 记录不存在，一律当"读不到"（不抛）', () => {
  const dir = resetSandbox()
  writeCache(dir, 'session-a', { record: { identity: { createdAt: 1, cwd: '/x' }, rows: { sessionListMetadata: { val: { blank: 'yes' } } } } })
  assert.deepEqual(readProjectionCache(dir, { id: 'session-a', createdAt: 1, cwd: '/x' }), {})
  writeCache(dir, 'session-b', { record: { identity: { createdAt: 1, cwd: '/x' } } })
  assert.deepEqual(readProjectionCache(dir, { id: 'session-b', createdAt: 1, cwd: '/x' }), {})
  writeFileSync(join(dir, 'session-c.json'), '{不是 JSON')
  assert.equal(readProjectionCache(dir, { id: 'session-c', createdAt: 1, cwd: '/x' }), undefined)
  assert.equal(readProjectionCache(dir, { id: 'session-missing', createdAt: 1 }), undefined)
})

test('createBlankResolver：没有缓存目录时永远说"不知道"（不许凭空判空白）', () => {
  const resolver = createBlankResolver({})
  assert.equal(resolver({ id: 'session-a', createdAt: 1, cwd: '/x' }), undefined)
})

test('hiddenReasonOf：header 的 origin、注册表的归档集、缓存里的 blank 拼成一条结论', () => {
  const dir = resetSandbox()
  writeCache(dir, 'session-blank', {
    record: { identity: { createdAt: 1000, cwd: '/tmp/x' }, rows: { sessionListMetadata: { val: { blank: true } } } },
  })
  const resolveBlank = createBlankResolver({ cacheDir: dir })
  const subject = (id: string, origin?: string) => ({
    id,
    createdAt: 1000,
    cwd: '/tmp/x',
    header: { ...(origin === undefined ? {} : { origin }) },
  })

  // 缓存里 blank: true 的那条 → 空白
  assert.equal(hiddenReasonOf(subject('session-blank'), { resolveBlank }), 'blank')
  // 没有缓存记录的同 id 会话（createdAt 对不上）→ 读不到 blank，按会显示处理
  assert.equal(hiddenReasonOf({ ...subject('session-blank'), createdAt: 2000 }, { resolveBlank }), undefined)
  // 归档集：Set 与数组两种形状都认（`/state` 与计划层手里各是其中一种）
  assert.equal(hiddenReasonOf(subject('session-archived'), { archived: new Set(['session-archived']) }), 'archived')
  assert.equal(hiddenReasonOf(subject('session-archived'), { archived: ['session-archived'] }), 'archived')
  assert.equal(hiddenReasonOf(subject('session-archived'), { archived: ['session-other'] }), undefined)
  // 子代理优先于归档（宿主先判 origin）
  assert.equal(
    hiddenReasonOf(subject('session-archived', 'subagent'), { archived: ['session-archived'] }),
    'subagent',
  )
  // 什么都不给 = 都不隐藏
  assert.equal(hiddenReasonOf(subject('session-live')), undefined)
})
