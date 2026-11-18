// test/client/operations/manage/migrateResult.test.ts — 迁移结果页「哪几类没搬」那一段的拼法。
//
// 为什么单独钉它：结果页不再摆宿主给工具那一面的长摘要，类别与条数是从宿主回的结构化字段
// （`preview.strandedSources`）数出来的。顺序对不对、少了哪几类还要不要写、一条都没有时怎么收尾，
// 全是这一层的事；界面冒烟只能看到一个拼好的键与参数，看不出顺序错没错。
// 判据见 .agents/notes/implemented/bug-fix/2026-11-18-results-return-structure-not-prose.md。
import assert from 'node:assert/strict'
import test from 'node:test'

import { strandedReasonsText } from '../../../../src/client/operations/manage/migrateResult.ts'

/** 翻译假对象：只回键名，断言里就能直接看出"取了哪几类的称呼"。 */
const t = (key: string): string => key

test('搬不走的会话按子智能体 → 空白 → 已归档数，只说真有人的那几类', () => {
  const members = [
    { reason: 'archived' as const },
    { reason: 'subagent' as const },
    { reason: 'subagent' as const },
  ]
  assert.equal(strandedReasonsText(members, t), 'tag.subagent 2、tag.archived 1')
})

test('一条都没有时返回空串（调用方只在有人时才拼那句话）', () => {
  assert.equal(strandedReasonsText([], t), '')
})
