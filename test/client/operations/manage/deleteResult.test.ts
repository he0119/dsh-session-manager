// test/client/operations/manage/deleteResult.test.ts — 删除这一路的几句话（`deleteResult.ts`）。
//
// 为什么单独钉它：宿主只回结构，结论、级联说明、远端那一步、复核没通过全由界面拼；这几句错一次就会
// **说反**（"复核没过"说成删干净了、"别的机器上还留着"漏掉）。判据见
// .agents/notes/implemented/bug-fix/2026-11-18-results-return-structure-not-prose.md。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deleteCascadeNote,
  deletePlanVerdict,
  describeDeleteResult,
  describeRemoteRemoval,
} from '../../../../src/client/operations/manage/deleteResult.ts'

/** 翻译假对象：把键与参数拼成一句可比较的字符串（与界面冒烟的示例数据同一标准）。 */
const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`

test('确认弹窗那句结论：计划可用说删几条，不可用说这次不删', () => {
  assert.equal(
    deletePlanVerdict({ ok: true, entries: [{}, {}], cascaded: 0 }, t),
    'manage.delete.plan:{"count":2}',
  )
  assert.equal(deletePlanVerdict({ ok: false, entries: [], cascaded: 0 }, t), 'manage.delete.planBlocked')
})

test('级联说明只在真有条子智能体跟着走时出现', () => {
  assert.equal(deleteCascadeNote(0, t), undefined)
  assert.equal(deleteCascadeNote(3, t), 'manage.delete.planCascade:{"count":3}')
})

test('远端那句话：本地删了包、别处还有副本时两句都说；别处没有时说"不会再拉回来"', () => {
  assert.equal(describeRemoteRemoval({ removed: 2, others: ['robot-b'] }, t), 'manage.delete.remoteDone:{"count":2} manage.delete.remoteOthers:{"machines":"robot-b"}')
  assert.equal(
    describeRemoteRemoval({ removed: 2, others: [] }, t),
    'manage.delete.remoteDone:{"count":2} manage.delete.remoteStaysDeleted',
  )
  // 一个包都没删、别处也没有：整句不出现（"删掉 0 个包"是噪音）。
  assert.equal(describeRemoteRemoval({ removed: 0, others: [] }, t), undefined)
  // 本地没删到、别处还留着：只说那一句。
  assert.equal(
    describeRemoteRemoval({ removed: 0, others: ['robot-b', 'robot-c'] }, t),
    'manage.delete.remoteOthers:{"machines":"robot-b、robot-c"}',
  )
})

test('结果页：结论、级联、远端、复核，各占一句；没做成的那些不进结论', () => {
  const done = describeDeleteResult(
    { applied: true, verified: true, dirsRemoved: 3, cascaded: 2, remote: { removed: 1, others: [] } },
    t,
  )
  assert.equal(done.ok, true, '删干净了才是成功色')
  assert.equal(done.verdict, 'manage.delete.done:{"count":3}')
  assert.deepEqual(done.notes, [
    'manage.delete.planCascade:{"count":2}',
    'manage.delete.remoteDone:{"count":1} manage.delete.remoteStaysDeleted',
  ])
  assert.equal(done.warn, undefined, '通过的那一次不说复核')

  const failed = describeDeleteResult({ applied: true, verified: false, dirsRemoved: 1, cascaded: 0 }, t)
  assert.equal(failed.ok, false, '复核没过要换成告警色')
  assert.equal(failed.warn, 'manage.delete.verifyFailed')
  assert.deepEqual(failed.notes, [], '没有级联、没有远端时一行废话都没有')

  const blocked = describeDeleteResult({ applied: false, verified: false, dirsRemoved: 0, cascaded: 0 }, t)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.verdict, 'manage.delete.nothingDone')
  assert.equal(blocked.warn, undefined, '一条都没删时不该说"复核没通过"')
})
