/**
 * 差异视图那两张分类对照表的判据：关系三条、种类七个、两边两档。
 *
 * 界面那一层只能靠真实 GUI 量，但"哪个分类落在哪一档"是判据——判据要能在这一层钉住：改回一档就红。
 *
 * @module dsh-session-manager/test/diff-tags
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { KIND_TONE, RELATION_KEY, RELATION_TONE, SIDE_TONE } from '../src/client/logic/diffTags.ts'

test('差异视图：三种关系各一档，只有真分叉落在"需要注意"那一档', () => {
  assert.deepEqual(
    [RELATION_TONE.same, RELATION_TONE['local-extends'], RELATION_TONE['remote-extends'], RELATION_TONE.forked],
    ['quiet', 'info', 'info', 'warning'],
    '一致=最安静、续写=信息档、两边各写各的=需要注意（那一条要人做决定）',
  )
  // 续写两侧共用一枚文案（"只是续写"里本机远端都在那句散文里说清了），所以键只有三个。
  assert.equal(RELATION_KEY['local-extends'], RELATION_KEY['remote-extends'])
  assert.equal(new Set(Object.values(RELATION_KEY)).size, 3, '三条关系各有自己的文案键')
})

test('差异视图：两边各一档且必须不同，两块尾巴才一眼分得开', () => {
  assert.equal(SIDE_TONE.local, 'info')
  assert.equal(SIDE_TONE.remote, 'neutral')
  assert.notEqual(SIDE_TONE.local, SIDE_TONE.remote, '两边同档就等于没标')
})

test('差异视图：七个种类都有档位，只有工具调用与结果共用一档', () => {
  assert.deepEqual(
    Object.keys(KIND_TONE).sort(),
    ['assistant', 'event', 'reasoning', 'system', 'tool-call', 'tool-result', 'user'],
  )
  assert.equal(KIND_TONE['tool-call'], KIND_TONE['tool-result'], '同一次调用与它的结果算一类')
  assert.equal(
    new Set([
      KIND_TONE.user,
      KIND_TONE.assistant,
      KIND_TONE.reasoning,
      KIND_TONE['tool-call'],
      KIND_TONE.system,
      KIND_TONE.event,
    ]).size,
    6,
    '六个类别各自一档：用户在蓝、助手在灰、思考更淡、工具在琥珀、系统在绿、事件留只读默认',
  )
})
