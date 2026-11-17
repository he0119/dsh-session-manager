// test/client/operations/sync/sync-stage.test.ts — 「同步」这一面该摆哪一段。
//
// 为什么单钉这一层：状态栏那枚「同步中 3/7」点开的就是这一面，而"宿主那边正在跑、这一页没有发起"
// 这种状态在冒烟夹具里种不出来（`syncJob` 是产物内部的模块级状态，只能靠真跑一趟同步才会变）。
// 实测过的现象：状态栏写着「同步中…」，点进去只有「上次同步」和一枚按不动的「同步」，进度一条字都没有。
// 跑完那一段同理：结论与「撤销」都在结果页上，退回面板段就只剩一条横幅。
import assert from 'node:assert/strict'
import test from 'node:test'

import { syncStage } from '../../../../src/client/operations/sync/syncStage.ts'

test('没在跑、这一页也停在面板段、也没有未取走的结论：摆面板段', () => {
  assert.equal(syncStage(null, false, false), 'idle')
})

test('宿主那边跑着、这一页停在面板段：直接摆落地段（点状态栏那枚进来时看得到进度）', () => {
  assert.equal(syncStage(null, true, false), 'apply')
})

test('这一页正在算计划：留在计划段，不跟着后台那一趟换走', () => {
  assert.equal(syncStage('plan', true, false), 'plan')
  assert.equal(syncStage('plan', false, true), 'plan', '手上有份计划在看时，刚跑完那一趟不抢这一页')
})

test('这一页刚按了确认：还没收到第一条事件也在落地段', () => {
  assert.equal(syncStage('apply', false, false), 'apply')
  assert.equal(syncStage('apply', true, false), 'apply')
})

test('跑完了、结论还没被「完成」收走：摆结果段（不回面板，也不停在落地段）', () => {
  assert.equal(syncStage(null, false, true), 'done', '转到后台之后跑完，点状态栏回来直接落到结果页')
  assert.equal(syncStage('apply', false, true), 'done', '自己按的确认也一样：落地结束后就是结果页')
  assert.equal(syncStage(null, true, true), 'apply', '还在跑就先看进度，结论等它跑完')
})
