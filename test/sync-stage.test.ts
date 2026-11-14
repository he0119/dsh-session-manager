// test/sync-stage.test.ts — 「同步」这一面该摆哪一段。
//
// 为什么单钉这一层：状态栏那枚「同步中 3/7」点开的就是这一面，而"宿主那边正在跑、这一页没有发起"
// 这种状态在冒烟夹具里种不出来（`syncJob` 是产物内部的模块级状态，只能靠真跑一趟同步才会变）。
// 实测过的现象：状态栏写着「同步中…」，点进去只有「上次同步」和一枚按不动的「同步」，进度一条字都没有。
import assert from 'node:assert/strict'
import test from 'node:test'

import { syncStage } from '../src/client/logic/syncStage.ts'

test('没在跑、这一页也停在面板段：摆面板段', () => {
  assert.equal(syncStage(null, false), 'idle')
})

test('宿主那边跑着、这一页停在面板段：直接摆落地段（点状态栏那枚进来时看得到进度）', () => {
  assert.equal(syncStage(null, true), 'apply')
})

test('这一页正在算计划：留在计划段，不跟着后台那一趟换走', () => {
  assert.equal(syncStage('plan', true), 'plan')
})

test('这一页刚按了确认：还没收到第一条事件也在落地段', () => {
  assert.equal(syncStage('apply', false), 'apply')
  assert.equal(syncStage('apply', true), 'apply')
})
