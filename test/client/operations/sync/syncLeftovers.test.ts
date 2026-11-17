// test/client/operations/sync/syncLeftovers.test.ts — 「上次同步没做到的条目」在界面这一侧怎么读。
//
// 判据只有一份（`leftoversOf()`）：页头那枚黄点的条数、弹窗里那张清单、以及"旧记录只有汇总句"那条退路
// 都走它。改坏了不会报错——界面只是少说几句话，或者条数对不上清单。
//
// 分组（`groupLeftovers()`）也在这里钉：它只认宿主给的 `kind`，不解析句子；认不出的分类落到「其它问题」。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  groupLeftovers,
  leftoverGroupOf,
  leftoversOf,
  LEFTOVER_KEY,
  LEFTOVER_TONE,
} from '../../../../src/client/operations/sync/syncLeftovers.ts'

test('有名字版就用名字版（新宿主给的 leftovers 已经把汇总句收进去了）', () => {
  const listed = [
    { message: '甲（session-1）：目标目录不存在：/nope', sessionId: 'session-1' },
    { message: '同步映射里有一条空的来源路径（远端 cwd）' },
  ]
  assert.deepEqual(leftoversOf({ leftovers: listed, problems: ['同步映射里有一条空的来源路径（远端 cwd）'] }), listed)
})

test('旧记录只有汇总句时一条一句地列出来', () => {
  assert.deepEqual(leftoversOf({ problems: ['甲', '乙'] }), [{ message: '甲' }, { message: '乙' }])
})

test('空的名字版不算数：退回汇总句（宿主可能只写了 problems）', () => {
  assert.deepEqual(leftoversOf({ leftovers: [], problems: ['甲'] }), [{ message: '甲' }])
})

test('两样都没有、或者整份记录都缺席时是空数组', () => {
  assert.deepEqual(leftoversOf({}), [])
  assert.deepEqual(leftoversOf({ leftovers: [], problems: [] }), [])
  assert.deepEqual(leftoversOf(null), [])
  assert.deepEqual(leftoversOf(undefined), [])
})

test('返回的是副本：调用方改它不该动到宿主给的那份数据', () => {
  const listed = [{ message: '甲', sessionId: 'session-1' }]
  const read = leftoversOf({ leftovers: listed })
  read.push({ message: '乙' })
  assert.equal(listed.length, 1)
})

test('按原因分组：组按「缺附件 → 两边都写过 → 正开着 → 目录对不上 → 其它」排，组内保持原顺序', () => {
  const items = [
    { message: '甲', kind: 'path' as const },
    { message: '乙', kind: 'other' as const },
    { message: '丙', kind: 'attachment' as const },
    { message: '丁', kind: 'fork' as const },
    { message: '戊', kind: 'live' as const },
    { message: '己', kind: 'fork' as const },
  ]
  assert.deepEqual(
    groupLeftovers(items).map((group) => [group.key, group.items.map((item) => item.message)]),
    [
      ['attachment', ['丙']],
      ['fork', ['丁', '己']],
      ['live', ['戊']],
      ['path', ['甲']],
      ['other', ['乙']],
    ],
  )
})

test('认不出的分类（旧记录没有 kind、或以后新增的）一律落到「其它问题」，不丢条目', () => {
  assert.equal(leftoverGroupOf({ message: '旧记录' }), 'other')
  // 运行期真的会收到不认识的字符串（旧宿主 / 新宿主混在一起），类型层面拦不住它。
  assert.equal(leftoverGroupOf({ message: '将来的一类', kind: 'later-kind' as never }), 'other')
  assert.deepEqual(groupLeftovers([{ message: '旧记录' }]), [{ key: 'other', items: [{ message: '旧记录' }] }])
})

test('每一组都有标签与档位；分组键不能漏（漏了界面上就是一串键名）', () => {
  for (const key of ['attachment', 'fork', 'live', 'path', 'other'] as const) {
    assert.match(LEFTOVER_KEY[key], /^sync\.leftovers\.group\./)
    assert.ok(['warning', 'info', 'neutral'].includes(LEFTOVER_TONE[key]), `${key} 的档位不是注意/信息/中性之一`)
  }
})
