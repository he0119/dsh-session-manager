// 写远端格子的互斥锁：一次只放一件事进去，释放之后下一件才拿得到。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createRemoteWriteGate } from '../../../src/operations/sync/remote-write.ts'

test('remote-write：第一件拿到之后第二件被拒，释放之后才轮得到', () => {
  const gate = createRemoteWriteGate(() => 1000)
  const release = gate.tryAcquire('同步')
  assert.equal(typeof release, 'function')
  assert.deepEqual(gate.current(), { label: '同步', startedAt: 1000 })

  assert.equal(gate.tryAcquire('整理远端'), undefined, '已经有人拿着时不给第二把')
  assert.deepEqual(gate.current(), { label: '同步', startedAt: 1000 }, '被拒的那次不改持有者')

  release!()
  assert.equal(gate.current(), undefined)
  const next = gate.tryAcquire('自动推送')
  assert.equal(typeof next, 'function')
  assert.deepEqual(gate.current(), { label: '自动推送', startedAt: 1000 })
  next!()
})

test('remote-write：重复释放不会把后来者放掉', () => {
  const gate = createRemoteWriteGate(() => 1)
  const first = gate.tryAcquire('同步')!
  first()
  first() // 同一个句柄再调一次：无害
  const second = gate.tryAcquire('删除远端')!
  first() // 旧句柄不能把新持有者放掉
  assert.deepEqual(gate.current(), { label: '删除远端', startedAt: 1 })
  second()
  assert.equal(gate.current(), undefined)
})
