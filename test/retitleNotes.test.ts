// test/retitleNotes.test.ts — 一次「重新生成名称」该说哪几句话。
//
// 这几句话错一次就会**说反**：把"跳过"混进"失败"会让用户以为模型坏了，把"没变"算进"改了"会让人以为
// 一半没生效，而按原因合并计数是"勾一页会话"时唯一读得下去的说法。所以这里逐支钉死。
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeRetitle, type RetitleFacts } from '../src/client/logic/retitleNotes.ts'

/** 假翻译：把键与参数原样打出来，断言因此核的是"用了哪个键、带什么数"。 */
const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key

const facts = (input: Partial<RetitleFacts>): RetitleFacts => ({
  retitled: input.retitled ?? [],
  unchanged: input.unchanged ?? [],
  skipped: input.skipped ?? [],
})

test('describeRetitle：改了与没变各说一句，两件事同时发生时两句一起说', () => {
  assert.deepEqual(describeRetitle(facts({ retitled: [{ id: 'a', title: '新' }] }), t), {
    notice: 'manage.retitle.done:{"count":1}',
    skipped: [],
  })
  // 两句之间的空格是有意的：界面上是一条横幅里的一句话，不是两段。
  assert.deepEqual(
    describeRetitle(facts({ retitled: [{ id: 'a', title: '新' }], unchanged: [{ id: 'b', title: '旧' }] }), t),
    {
      notice: 'manage.retitle.done:{"count":1} manage.retitle.unchanged:{"count":1}',
      skipped: [],
    },
  )
})

test('describeRetitle：跳过按原因合并计数，顺序按第一次出现', () => {
  const notes = describeRetitle(
    facts({
      skipped: [
        { id: 'a', reason: 'pinned' },
        { id: 'b', reason: 'subagent' },
        { id: 'c', reason: 'pinned' },
        { id: 'd', reason: 'no-request-route' },
      ],
    }),
    t,
  )

  assert.equal(notes.notice, undefined, '一条都没算过时不该编出一句结论')
  assert.deepEqual(notes.skipped, [
    'manage.retitle.skip.pinned:{"count":2}',
    'manage.retitle.skip.subagent:{"count":1}',
    'manage.retitle.skip.noRequestRoute:{"count":1}',
  ])
})

test('describeRetitle：宿主报来不认识的原因时退回一句通用的话，而不是漏掉或抛错', () => {
  const notes = describeRetitle(facts({ skipped: [{ id: 'a', reason: 'brand-new-reason' }] }), t)
  assert.deepEqual(notes.skipped, ['manage.retitle.skip.other:{"count":1}'])
})

test('describeRetitle：一条都没动也没跳过时两样都空（界面因此什么都不画）', () => {
  assert.deepEqual(describeRetitle(facts({}), t), { skipped: [] })
})
