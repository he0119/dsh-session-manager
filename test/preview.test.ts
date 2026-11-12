// test/preview.test.ts — 右栏「开头两轮」的取法。
//
// 为什么单拎出来测：这一段只读、不写，错了不会抛错，只会让右栏把"标题模型那次调用"当成用户说的话、
// 或者把流式片段重复摆两遍。假钩子不跑 useEffect，界面冒烟里也看不到取回来的内容，所以规则在这一层
// 直接测。
import assert from 'node:assert/strict'
import test from 'node:test'

import { previewTurns } from '../src/client/logic/preview.ts'
import type { TranscriptItem } from '../src/transcript.ts'

let index = 0
function item(over: Partial<TranscriptItem> & Pick<TranscriptItem, 'type' | 'kind'>): TranscriptItem {
  return { index: index++, ...over }
}

test('取前两轮：人的消息跳过合成的那种，回答取这一轮最后一条有文字的', () => {
  index = 0
  const items: TranscriptItem[] = [
    item({ type: 'turn/start', kind: 'event', turn: 1 }),
    item({ type: 'user/message', kind: 'user', turn: 1, text: '你好' }),
    item({ type: 'assistant/message', kind: 'assistant', turn: 1, text: '第一答（上）' }),
    item({ type: 'assistant/message', kind: 'assistant', turn: 1, text: '第一答（下）' }),
    item({ type: 'turn/end', kind: 'event', turn: 1 }),
    item({ type: 'turn/start', kind: 'event', turn: 2 }),
    item({ type: 'user/message', kind: 'user', synthetic: true, text: '标题模型那次调用' }),
    item({ type: 'user/message', kind: 'user', text: '第二问' }),
    item({ type: 'assistant/message', kind: 'assistant', text: '第二答' }),
    item({ type: 'turn/end', kind: 'event', turn: 2 }),
    item({ type: 'turn/start', kind: 'event', turn: 3 }),
    item({ type: 'user/message', kind: 'user', text: '第三问' }),
    item({ type: 'assistant/message', kind: 'assistant', text: '第三答' }),
    item({ type: 'turn/end', kind: 'event', turn: 3 }),
  ]
  assert.deepEqual(previewTurns(items), [
    { turn: 1, user: '你好', answer: '第一答（下）' },
    { turn: 2, user: '第二问', answer: '第二答' },
  ])
})

test('一轮里只有工具调用时回答为空；不要拿别的轮来补', () => {
  index = 0
  const items: TranscriptItem[] = [
    item({ type: 'turn/start', kind: 'event', turn: 1 }),
    item({ type: 'user/message', kind: 'user', text: '查一下' }),
    item({ type: 'tool/call', kind: 'tool-call', name: 'search', args: '{}' }),
    item({ type: 'tool/result', kind: 'tool-result', text: '结果' }),
    item({ type: 'turn/end', kind: 'event', turn: 1 }),
    item({ type: 'turn/start', kind: 'event', turn: 2 }),
    item({ type: 'assistant/message', kind: 'assistant', text: '第二答' }),
    item({ type: 'turn/end', kind: 'event', turn: 2 }),
  ]
  assert.deepEqual(previewTurns(items), [
    { turn: 1, user: '查一下', answer: null },
    { turn: 2, user: null, answer: '第二答' },
  ])
})

test('一条轮次边界都没有时退回第一条人的消息与第一条回答', () => {
  index = 0
  const items: TranscriptItem[] = [
    item({ type: 'session/start', kind: 'event' }),
    item({ type: 'user/message', kind: 'user', text: '开场' }),
    item({ type: 'assistant/message', kind: 'assistant', text: '回话' }),
  ]
  assert.deepEqual(previewTurns(items), [{ turn: 1, user: '开场', answer: '回话' }])
})

test('这一页切在第二轮中间时丢掉半截的那一节；不切的时候照常保留', () => {
  index = 0
  const items: TranscriptItem[] = [
    item({ type: 'turn/start', kind: 'event', turn: 1 }),
    item({ type: 'user/message', kind: 'user', text: '一' }),
    item({ type: 'assistant/message', kind: 'assistant', text: '答一' }),
    item({ type: 'turn/end', kind: 'event', turn: 1 }),
    item({ type: 'turn/start', kind: 'event', turn: 2 }),
    item({ type: 'user/message', kind: 'user', text: '二' }),
    item({ type: 'assistant/message', kind: 'assistant', text: '我先改一下' }),
  ]
  assert.deepEqual(previewTurns(items), [
    { turn: 1, user: '一', answer: '答一' },
    { turn: 2, user: '二', answer: '我先改一下' },
  ])
  assert.deepEqual(previewTurns(items, undefined, true), [{ turn: 1, user: '一', answer: '答一' }])
  // 只有半截那一节、又被丢掉时，不要退回“整页第一条人的消息”，否则同一段半句话又回来了。
  const onlyPartial = items.slice(4)
  assert.deepEqual(previewTurns(onlyPartial, undefined, true), [])
})

test('整页没有可读的文字时返回空；maxTurns 能收紧', () => {
  index = 0
  assert.deepEqual(previewTurns([]), [])
  const items: TranscriptItem[] = [
    item({ type: 'turn/start', kind: 'event', turn: 1 }),
    item({ type: 'user/message', kind: 'user', text: '一' }),
    item({ type: 'turn/end', kind: 'event', turn: 1 }),
    item({ type: 'turn/start', kind: 'event', turn: 2 }),
    item({ type: 'user/message', kind: 'user', text: '二' }),
    item({ type: 'turn/end', kind: 'event', turn: 2 }),
  ]
  assert.deepEqual(previewTurns(items, 1), [{ turn: 1, user: '一', answer: null }])
})
