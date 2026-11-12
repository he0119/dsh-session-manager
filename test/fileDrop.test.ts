// test/fileDrop.test.ts — 拖进来（或选进来）的那个文件算不算会话包。
//
// 为什么值得单独钉：拖放是浏览器事件，界面上的冒烟用例点不出真实的 drop，所以"挑哪一个、不接受时说哪句话"
// 只能在这一层核。三种情形各一条：什么都没拖、后缀不对、一堆里第一个对的。
import assert from 'node:assert/strict'
import test from 'node:test'

import { BUNDLE_SUFFIX, chooseBundle } from '../src/client/logic/fileDrop.ts'

test('后缀就是宿主导出的那个', () => {
  assert.equal(BUNDLE_SUFFIX, '.dshsess')
})

test('挑第一个后缀对得上的（大小写不敏感）', () => {
  const hit = chooseBundle([{ name: 'a.txt' }, { name: '带走.DSHSESS' }, { name: 'b.dshsess' }])
  assert.equal(hit.kind, 'file')
  assert.equal(hit.kind === 'file' ? hit.file.name : '', '带走.DSHSESS', '取第一个对的，不挑第二个')
})

test('什么都没拖：说 empty，不报错', () => {
  assert.deepEqual(chooseBundle([]), { kind: 'empty' })
})

test('后缀都不对：说 unknownSuffix（弹窗里据此给人一句话）', () => {
  assert.deepEqual(chooseBundle([{ name: 'notes.md' }]), { kind: 'unknownSuffix' })
})
