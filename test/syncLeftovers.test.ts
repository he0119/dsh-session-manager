// test/syncLeftovers.test.ts — 「上次同步没做到的条目」在界面这一侧怎么读。
//
// 判据只有一份（`leftoversOf()`）：页头那枚黄点的条数、弹窗里那张清单、以及"旧记录只有汇总句"那条退路
// 都走它。改坏了不会报错——界面只是少说几句话，或者条数对不上清单。
import assert from 'node:assert/strict'
import test from 'node:test'

import { leftoversOf } from '../src/client/logic/syncLeftovers.ts'

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
