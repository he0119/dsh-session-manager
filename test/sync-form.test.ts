// test/sync-form.test.ts — 「同步设置」表单的数据面：映射草稿的解析/格式化，以及"保存会写什么"。
//
// 这一层是纯函数（不 import React、也不 import 宿主客户端包），所以能直接单测：真正会在用户层留下
// 痕迹的是 `draftOps()` 发出去的那几条路径编辑——只提交改动过的字段、空草稿发 unset，这两条规矩
// 写错了不会当场报错，只会在配置文档里攒下一堆"等于默认值"的覆盖，界面从此满屏「已覆盖」。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  draftFrom,
  draftOps,
  draftProblems,
  mappingProblems,
  mappingRows,
  mappingValue,
  SYNC_SECTION,
  syncSectionOf,
} from '../src/client/syncForm.ts'

test('同步设置：entry id 是 profile 里那个 insert 的 id', () => {
  assert.equal(SYNC_SECTION, 'session-manager')
})

test('同步设置：映射表是行，顺序跟着文档走（看到的顺序就是配置里的顺序）', () => {
  // 故意让插入顺序与"排序结果"不同（`/z` 先进、`/a` 后进）：钉住"不重排"。
  assert.deepEqual(
    mappingRows({ '/z/proj': '/opt/z', '/a/proj': '/opt/a', 'C:\\work\\proj': 'D:\\work\\proj' }),
    [
      { from: '/z/proj', to: '/opt/z' },
      { from: '/a/proj', to: '/opt/a' },
      { from: 'C:\\work\\proj', to: 'D:\\work\\proj' },
    ],
  )
  // 不是字典的值一律当空表：读到一个坏形状时画一行都没有，比画出 "undefined" 强。
  assert.deepEqual(mappingRows(undefined), [])
  assert.deepEqual(mappingRows(['a']), [])
  assert.deepEqual(mappingRows(null), [])
})

test('同步设置：两边都空的行不算一条（点了添加又改主意不该存不下去）', () => {
  assert.deepEqual(mappingValue([{ from: '  ', to: '' }]), {})
  assert.deepEqual(
    mappingValue([
      { from: '/home/alice/dev/proj', to: '/opt/work/proj' },
      { from: '', to: '' },
      { from: ' /p ', to: ' /q ' },
    ]),
    { '/home/alice/dev/proj': '/opt/work/proj', '/p': '/q' },
  )
})

test('同步设置：行的问题指到行号（缺一侧、重复的远端），空行不算错', () => {
  assert.deepEqual(mappingProblems([{ from: '', to: '' }]), [])
  assert.deepEqual(mappingProblems([{ from: '/p', to: '/q' }]), [])
  assert.deepEqual(mappingProblems([{ from: '/p', to: '' }]), [{ code: 'mapNoTo', line: 1 }])
  assert.deepEqual(mappingProblems([{ from: '', to: '/q' }]), [{ code: 'mapNoFrom', line: 1 }])
  // 同一个远端两条：后一条会盖掉前一条，那正是"我以为改了这一条"的来源
  assert.deepEqual(
    mappingProblems([
      { from: '/p', to: '/a' },
      { from: '', to: '' },
      { from: '/p', to: '/b' },
    ]),
    [{ code: 'mapDuplicate', line: 3, from: '/p' }],
  )
})

test('同步设置：只提交改动过的字段，清空等于退回组合层（unset）', () => {
  const value = { url: 'https://one.example/dav', machineId: 'robot-a', timeoutMs: 30000, mapping: { '/p': '/a' } }
  const draft = draftFrom(value)
  assert.deepEqual(draftOps(draft, value), [], '原样不动什么都不写')

  assert.deepEqual(draftOps({ ...draft, url: 'https://two.example/dav' }, value), [
    { op: 'set', path: ['sync', 'url'], value: 'https://two.example/dav' },
  ])
  assert.deepEqual(draftOps({ ...draft, url: '  ' }, value), [{ op: 'unset', path: ['sync', 'url'] }], '清空 → 退回组合层')
  assert.deepEqual(draftOps({ ...draft, timeoutMs: '5000' }, value), [
    { op: 'set', path: ['sync', 'timeoutMs'], value: 5000 },
  ])
  assert.deepEqual(draftOps({ ...draft, mapping: [] }, value), [{ op: 'unset', path: ['sync', 'mapping'] }])
  assert.deepEqual(
    draftOps({ ...draft, mapping: [{ from: '/p', to: '/a' }, { from: '/q', to: '/b' }] }, value),
    [{ op: 'set', path: ['sync', 'mapping'], value: { '/p': '/a', '/q': '/b' } }],
  )
  // 顺序不同、内容一样：不算改动（比较走规范形式，不靠字典的插入顺序）
  assert.deepEqual(
    draftOps({ ...draft, mapping: mappingRows({ '/p': '/a' }) }, value),
    [],
    '同一份映射换个顺序不算改过',
  )
  // 有问题的行在场：不发编辑（保存被 draftProblems 挡住），而不是发一条空表把用户的映射抹掉。
  assert.deepEqual(draftOps({ ...draft, mapping: [{ from: '/p', to: '' }] }, value), [])
})

test('同步设置：草稿里能当场看出来的问题（挡住保存，且说得清是哪个码）', () => {
  const draft = draftFrom({})
  assert.deepEqual(draftProblems(draft), [])
  assert.deepEqual(draftProblems({ ...draft, timeoutMs: '0' }), [{ code: 'timeoutNotPositive' }])
  assert.deepEqual(draftProblems({ ...draft, timeoutMs: '30s' }), [{ code: 'timeoutNotPositive' }])
  const bad = draftProblems({ ...draft, mapping: [{ from: '/a', to: '/b' }, { from: '/a', to: '/c' }] })
  assert.equal(bad.length, 1)
  assert.equal(bad[0].code, 'mapping')
  assert.deepEqual(bad[0], { code: 'mapping', problem: { code: 'mapDuplicate', line: 2, from: '/a' } })
})

test('同步设置：接缝没给出值时不编造（空节 → 空草稿）', () => {
  assert.deepEqual(syncSectionOf(undefined), {})
  assert.deepEqual(syncSectionOf({ status: 'ready', writable: true }), {})
  assert.deepEqual(draftFrom(syncSectionOf({ status: 'ready', writable: true, value: { sync: { url: 'https://x' } } })), {
    url: 'https://x',
    machineId: '',
    username: '',
    passwordRef: '',
    mapping: [],
    timeoutMs: '',
  })
})
