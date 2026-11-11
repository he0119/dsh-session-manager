// 动作落地之后就地把清单里那几条改对（见 src/client/logic/statePatch.ts）。
//
// 为什么值得单独钉：这几个函数是"不等整库重扫"那一步的全部依据。改错了不会报错，只会让列表安静地显示
// 一条与实际不符的状态——直到下一次整库快照把它盖掉（那可能是几秒之后，也可能用户已经据此点了下一个
// 动作）。
import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionSummary, StateResponse } from '../src/client/api.ts'
import { patchArchived, patchMoved, patchRemoved, patchTitles } from '../src/client/logic/statePatch.ts'

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    createdAt: 1000,
    dir: `/sessions/alpha/${overrides.id}`,
    bytes: 1024,
    files: [],
    ...overrides,
  }
}

function stateOf(sessions: SessionSummary[]): StateResponse {
  return {
    sessionsRoot: '/sessions',
    registryPath: '/registry.json',
    problems: [],
    sessions,
    workspaces: [
      { id: 'ws-a', path: '/work/alpha', title: 'alpha', sessionIds: sessions.map((item) => item.id) },
    ],
  }
}

test('归档：改到的那几条换新对象，hidden 按宿主优先级重算', () => {
  const plain = session({ id: 's-plain' })
  const subagent = session({ id: 's-sub', hidden: 'subagent', origin: 'subagent' })
  const blank = session({ id: 's-blank', hidden: 'blank', blank: true })
  const other = session({ id: 's-other' })
  const state = stateOf([plain, subagent, blank, other])

  const archived = patchArchived(state, ['s-plain', 's-sub', 's-blank'], true)
  const byId = new Map(archived.sessions.map((item) => [item.id, item]))
  assert.equal(byId.get('s-plain')?.archived, true)
  assert.equal(byId.get('s-plain')?.hidden, 'archived', '普通会话归档之后就是"已归档"')
  assert.equal(byId.get('s-sub')?.hidden, 'subagent', '子智能体不会因为归档变成"已归档"')
  assert.equal(byId.get('s-sub')?.archived, true, '但它确实进了归档集')
  assert.equal(byId.get('s-blank')?.hidden, 'blank', '空白那一档在归档之前')
  assert.equal(byId.get('s-other'), other, '没点到的那条保持同一个引用')

  const unarchived = patchArchived(archived.sessions === state.sessions ? state : archived, ['s-plain'], false)
  const plainAfter = unarchived.sessions.find((item) => item.id === 's-plain')
  assert.equal(plainAfter?.archived, false)
  assert.equal(plainAfter?.hidden, undefined, '取消归档之后它重新显示，不再挂"已归档"')
})

test('归档：一条都没变时原样返回同一个 state（不许白重画）', () => {
  const state = stateOf([session({ id: 's-1', archived: true, hidden: 'archived' })])
  assert.equal(patchArchived(state, ['s-1'], true), state)
  assert.equal(patchArchived(state, [], true), state)
  assert.equal(patchArchived(state, ['s-unknown'], true), state)
})

test('删除：会话与工作区登记一起摘掉', () => {
  const gone = session({ id: 's-gone' })
  const kept = session({ id: 's-kept' })
  const state = stateOf([gone, kept])

  const after = patchRemoved(state, ['s-gone'])
  assert.deepEqual(after.sessions.map((item) => item.id), ['s-kept'])
  assert.equal(after.sessions[0], kept, '留下的那条不换对象')
  assert.deepEqual(after.workspaces[0]?.sessionIds, ['s-kept'], '工作区里的登记也摘掉')
  assert.equal(patchRemoved(state, ['s-unknown']), state)
  assert.equal(patchRemoved(state, []), state)
})

test('重算名称：写回新标题，没变的那条不换对象', () => {
  const state = stateOf([session({ id: 's-1', title: '旧名字' }), session({ id: 's-2', title: '没动' })])
  const after = patchTitles(state, [{ id: 's-1', title: '新名字' }])
  assert.equal(after.sessions[0]?.title, '新名字')
  assert.equal(after.sessions[1], state.sessions[1])
  assert.equal(patchTitles(state, [{ id: 's-1', title: '旧名字' }]), state, '标题没变就不换对象')
  assert.equal(patchTitles(state, [{ id: 's-unknown', title: 'x' }]), state)
})

test('迁移：换到目标目录、清掉未分组；没有 cwd 的那条不给它凭空补一个', () => {
  const moved = session({ id: 's-1', cwd: '/work/alpha', ungrouped: false })
  const uncwd = session({ id: 's-2', dir: '/sessions/_no-cwd/s-2' })
  const state = stateOf([moved, uncwd])

  const after = patchMoved(
    state,
    [
      { id: 's-1', dir: '/sessions/beta/s-1' },
      // 真实计划里没有 cwd 的会话落在同一个 `_no-cwd` 目录、目录不变（上面那条早退就处理了）；
      // 这里故意给一个变了的目录，钉住"就算目录变了也不给它补一个 cwd"。
      { id: 's-2', dir: '/sessions/_no-cwd-2/s-2' },
    ],
    '/work/beta',
  )
  const byId = new Map(after.sessions.map((item) => [item.id, item]))
  assert.equal(byId.get('s-1')?.cwd, '/work/beta')
  assert.equal(byId.get('s-1')?.dir, '/sessions/beta/s-1')
  assert.equal(byId.get('s-1')?.ungrouped, false)
  assert.equal(byId.get('s-2')?.cwd, undefined, '没有 cwd 的会话不许被补一个')
  assert.equal(byId.get('s-2')?.dir, '/sessions/_no-cwd-2/s-2', '目录变了的那条照换 dir')
  assert.equal(patchMoved(state, [], '/work/beta'), state)
})
