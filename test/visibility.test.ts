// 侧边栏可见性：哪三类会话外壳不显示，以及"宿主说它空白吗"从哪读。
//
// 这条判据在真实库里错过一次：迁移面板的「未分组」报 4 条，而外壳侧边栏那一组只显示 1 条。差额是三
// 条不同的隐藏理由（子代理 597.6KB 那条、两条只有 seed 事件的空白会话，其中一条还已归档），而面板与
// 侧边栏当时各算各的。这里把判据与它的三个输入逐个钉死：
//   - `hiddenReason()` 的**顺序**（宿主的顺序：先子代理、再空白、最后归档）；
//   - 投影缓存里读到什么（`sessionListMetadata.blank`），读不到/身份对不上时按"会显示"处理；
//   - `hiddenReasonOf()` 把 header / 注册表 / 缓存三处拼起来的那一步。
//
// 外加「未分组」那一条判据（`isUngrouped()`）：它是"谁都没认领 **且** 会显示"的合取，也就是宿主造
// 「未分组」那一组时用的条件。以前插件在三个地方各答各的（只看"有没有认领"），于是子代理/空白/已归档
// 那些侧边栏根本不放进那一组的会话也被标成了「未分组」。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { readProjectionCache } from '../src/projection-cache.ts'
import { createBlankResolver, hiddenReason, hiddenReasonOf, isUngrouped, visibilityFacts } from '../src/visibility.ts'

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

test('isUngrouped：「谁都没认领」与「侧边栏会显示」两件事同时成立才算', () => {
  // 不成立的两半各自都要判：认领了就不算，看不见（子代理/空白/已归档）也不算。
  assert.equal(isUngrouped({}), true, '没在册且看得见 = 侧边栏「未分组」那一组里的')
  assert.equal(isUngrouped({ owned: false }), true)
  assert.equal(isUngrouped({ owned: true }), false, '被某个工作区认领了就不是未分组')
  assert.equal(isUngrouped({ origin: 'subagent' }), false, '子代理嵌在父会话下面，侧边栏不把它放进那一组')
  assert.equal(isUngrouped({ blank: true }), false, '空白会话默认不显示（只有当前那条临时 New Session 例外，那件事插件看不到）')
  assert.equal(isUngrouped({ archived: true }), false, '已归档在默认归档过滤下不显示')
  assert.equal(isUngrouped({ origin: 'subagent', owned: true }), false)
  assert.equal(isUngrouped({ blank: undefined }), true, '宿主没说空白 = 按会显示处理，与 hiddenReason 同口径')
})

test('visibilityFacts：三件事实只在一处拼（hiddenReasonOf 与 isUngrouped 读的是同一份）', () => {
  const subject = { id: 'session-a', createdAt: 7, cwd: '/x', header: { origin: 'subagent' as const } }
  const facts = visibilityFacts(subject, { archived: ['session-a'] })
  assert.deepEqual(facts, { origin: 'subagent', archived: true }, '空白读取器缺席时 facts 里不带 blank')
  assert.equal(hiddenReason(facts), 'subagent')
  assert.equal(hiddenReasonOf(subject, { archived: ['session-a'] }), 'subagent')
  assert.equal(isUngrouped(facts), false)
  // 归档集两种形状（数组 / Set）都要认：界面侧给的是 Set
  assert.equal(visibilityFacts({ id: 'x', createdAt: 1, header: {} }, { archived: new Set(['x']) }).archived, true)
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
