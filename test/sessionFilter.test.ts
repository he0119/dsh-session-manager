// 「会话」页的筛选判据：五类各自怎么判，以及"行上挂哪几枚标签"。
//
// 这一页的取舍是"筛选按会话**是什么**判"，不是"按它显示成哪枚标签判"：`/state` 的 `hidden` 只报宿主
// 先判的那一条理由（一条会话既是空白又已归档时是 `blank`），而筛选与标签问的是"这条会话是什么"。
// 混用这两者会得到"筛了已归档，却有几行没有归档标签"的界面，所以这里把两边都钉住。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FILTER_KEYS,
  attributeKeys,
  filterCounts,
  filterSessions,
  hasAttribute,
  matchesFilter,
  matchesQuery,
  type FilterKey,
  type SessionFacts,
} from '../src/client/logic/sessionFilter.ts'

// 同 planRows.test.ts：不 import `src/client/api.ts`（它会把 src/client 拉进没有 DOM 的 Host 工程）。
// 判据声明的 `SessionFacts` 只要求它真正读的那几个字段，所以夹具就是最小形状。

/** 一行会话。 */
const s = (id: string, extra: Partial<SessionFacts> = {}): SessionFacts => ({ id, ...extra })

test('五类判据：各自只看自己那个字段，缺省一律为假', () => {
  const ordinary = s('a')
  for (const key of FILTER_KEYS as readonly FilterKey[]) assert.equal(matchesFilter(ordinary, key), false, `${key} 不该命中一条普通会话`)

  assert.equal(matchesFilter(s('a', { origin: 'subagent' }), 'subagent'), true)
  // 只有 header 里真是 subagent 才算：别的 origin 值（宿主以后可能加）不算
  assert.equal(matchesFilter(s('a', { origin: 'user' }), 'subagent'), false)
  assert.equal(matchesFilter(s('a', { blank: true }), 'blank'), true)
  assert.equal(matchesFilter(s('a', { blank: false }), 'blank'), false)
  assert.equal(matchesFilter(s('a', { archived: true }), 'archived'), true)
  assert.equal(matchesFilter(s('a', { live: true }), 'live'), true)
  // 「未分组」读的是宿主算好的结论（侧边栏那一组），不是任何原始事实的组合：
  // 缺省＝不在那一组里；只有宿主说在才算。
  assert.equal(matchesFilter(s('a'), 'unowned'), false)
  assert.equal(matchesFilter(s('a', { ungrouped: true }), 'unowned'), true)
  // 子智能体即使没在册也不是「未分组」——侧边栏把它嵌在父会话下面，从来不放进那一组。
  // 这条以前是反的（只看"有没有工作区认领"），所以钉在这里。
  assert.equal(matchesFilter(s('a', { origin: 'subagent', ungrouped: false }), 'unowned'), false)
  assert.equal(matchesFilter(s('a', { origin: 'subagent', ungrouped: false }), 'subagent'), true)
  // hasAttribute 只认那四类属性键
  assert.equal(hasAttribute(s('a', { archived: true }), 'archived'), true)
})

test('筛选：一枚都不勾＝全都要；勾了几枚＝任一命中', () => {
  const list = [
    s('plain', { ungrouped: true }),
    s('sub', { origin: 'subagent' }),
    s('blank', { blank: true }),
    s('both', { blank: true, archived: true }),
    s('owned'),
  ]
  assert.deepEqual(filterSessions(list, []).map((x) => x.id), ['plain', 'sub', 'blank', 'both', 'owned'])
  assert.deepEqual(filterSessions(list, ['subagent']).map((x) => x.id), ['sub'])
  assert.deepEqual(filterSessions(list, ['blank']).map((x) => x.id), ['blank', 'both'])
  // 「已归档」要把"空白 + 已归档"那条也筛出来（它是真归档了），这就是不按 hidden 判的原因
  assert.deepEqual(filterSessions(list, ['archived']).map((x) => x.id), ['both'])
  // 多选＝任一命中：勾上两类就是把这两类都摆出来
  assert.deepEqual(filterSessions(list, ['subagent', 'archived']).map((x) => x.id), ['sub', 'both'])
  // 「未分组」只筛出侧边栏那一组里的：`plain` 是，别的都不是（它们各自有别的标签可筛）
  assert.deepEqual(filterSessions(list, ['unowned']).map((x) => x.id), ['plain'])
  // 原列表不受影响（纯函数）
  assert.equal(list.length, 5)
})

test('行上的标签：能挂几枚挂几枚，顺序固定；「未分组」不在这里（归属那一格写着它）', () => {
  assert.deepEqual(attributeKeys(s('a')), [])
  assert.deepEqual(attributeKeys(s('a', { origin: 'subagent', live: true })), ['subagent', 'live'])
  // 空白 + 已归档：两枚都挂（只挂宿主先判的那一枚，筛选就没法自证了）
  assert.deepEqual(attributeKeys(s('a', { blank: true, archived: true, origin: 'subagent' })), [
    'subagent',
    'blank',
    'archived',
  ])
  // 顺序固定：与对象字段的写入顺序无关（这里故意倒着写）
  assert.deepEqual(attributeKeys(s('a', { live: true, archived: true, blank: true, origin: 'subagent' })), [
    'subagent',
    'blank',
    'archived',
    'live',
  ])
})

test('每一类各有多少条：对整个库数，且一条会话可以同时算进几类', () => {
  const list = [
    s('plain', { ungrouped: true }),
    s('sub', { origin: 'subagent' }),
    s('both', { blank: true, archived: true, live: true }),
    s('owned', { archived: true }),
    s('stray', { ungrouped: true, archived: true }),
  ]
  // 「未分组」只有 2 条（`plain` 与 `stray`）：`sub`（子智能体）与 `both`（空白+已归档）都不在侧边栏那一组里
  assert.deepEqual(filterCounts(list), { subagent: 1, blank: 1, archived: 3, unowned: 2, live: 1 })
  assert.deepEqual(filterCounts([]), { subagent: 0, blank: 0, archived: 0, unowned: 0, live: 0 })
})

test('关键词命中：标题与 id 都搜，大小写不敏感，空白串 = 没有关键词', () => {
  const session = s('session-9F3C-abcd', { title: '重构迁移编排' })
  // 标题
  assert.equal(matchesQuery(session, '迁移'), true)
  assert.equal(matchesQuery(session, '  迁移  '), true, '两头的空白不算数')
  assert.equal(matchesQuery(session, '别的'), false)
  // id：标题命中的同时也永远能按 id 找（"报 bug 要指名道姓"那条路）
  assert.equal(matchesQuery(session, '9f3c'), true, 'id 搜起来不区分大小写')
  assert.equal(matchesQuery(session, 'SESSION-9F3C'), true)
  // 没有关键词 = 全都算命中
  assert.equal(matchesQuery(session, ''), true)
  assert.equal(matchesQuery(session, '   '), true)
  // 没有标题（老会话）时只剩 id 可搜，不会因为 title 缺省就抛
  const bare = s('session-plain')
  assert.equal(matchesQuery(bare, 'plain'), true)
  assert.equal(matchesQuery(bare, '迁移'), false)
})

test('关键词与类别是两条独立的轴：都要过（与，不是或）', () => {
  const list = [
    s('a', { title: '重构迁移', blank: true }),
    s('b', { title: '重构迁移', live: true }),
    s('c', { title: '别的活', blank: true }),
  ]
  // 关键词单独用
  assert.deepEqual(filterSessions(list, [], '迁移').map((x) => x.id), ['a', 'b'])
  // 类别单独用
  assert.deepEqual(filterSessions(list, ['blank']).map((x) => x.id), ['a', 'c'])
  // 一起用：标题里有"迁移" **且** 是空白
  assert.deepEqual(filterSessions(list, ['blank'], '迁移').map((x) => x.id), ['a'])
  // 组合起来什么都剩不下时就是空列表，不是"退回全都要"
  assert.deepEqual(filterSessions(list, ['archived'], '迁移').map((x) => x.id), [])
  // 空关键词与空类别都不改变结果
  assert.equal(filterSessions(list, [], '').length, 3)
})
