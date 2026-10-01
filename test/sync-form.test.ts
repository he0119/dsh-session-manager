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
  formatMapping,
  parseMapping,
  SYNC_SECTION,
  syncSectionOf,
} from '../src/client/syncForm.ts'

test('同步设置：entry id 是 profile 里那个 insert 的 id', () => {
  assert.equal(SYNC_SECTION, 'session-manager')
})

test('同步设置：映射表按「远端 = 本机」一行一条，用 = 而不是 :（Windows 路径里有冒号）', () => {
  assert.equal(
    formatMapping({ '/home/alice/dev/proj': '/opt/work/proj', 'C:\\work\\proj': 'D:\\work\\proj' }),
    '/home/alice/dev/proj = /opt/work/proj\nC:\\work\\proj = D:\\work\\proj',
  )
  // 不是字典的值一律当空：读到一个坏形状时画空行，比画出 "undefined" 强。
  assert.equal(formatMapping(undefined), '')
  assert.equal(formatMapping(['a']), '')
  assert.equal(formatMapping(null), '')

  const parsed = parseMapping('# 注释\n\n/home/alice/dev/proj = /opt/work/proj\n  C:\\a  =  D:\\b  ')
  assert.deepEqual(parsed, { ok: true, value: { '/home/alice/dev/proj': '/opt/work/proj', 'C:\\a': 'D:\\b' } })
})

test('同步设置：坏行指到行号，而不是悄悄丢掉那一条', () => {
  assert.deepEqual(parseMapping('/home/a/one'), {
    ok: false,
    problem: { code: 'mapNoSeparator', line: 1, text: '/home/a/one' },
  })
  assert.deepEqual(parseMapping('ok = /x\n = /y'), { ok: false, problem: { code: 'mapNoFrom', line: 2 } })
  assert.deepEqual(parseMapping('ok = /x\n/z = '), { ok: false, problem: { code: 'mapNoTo', line: 2 } })
  // 同一个远端两条：后一条会盖掉前一条，那正是"我以为改了这一条"的来源
  assert.deepEqual(parseMapping('/p = /a\n/p = /b'), {
    ok: false,
    problem: { code: 'mapDuplicate', line: 2, from: '/p' },
  })
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
  assert.deepEqual(draftOps({ ...draft, mapping: '' }, value), [{ op: 'unset', path: ['sync', 'mapping'] }])
  assert.deepEqual(draftOps({ ...draft, mapping: '/p = /a\n/q = /b' }, value), [
    { op: 'set', path: ['sync', 'mapping'], value: { '/p': '/a', '/q': '/b' } },
  ])
  // 映射草稿坏了：不发编辑（保存被 draftProblems 挡住），而不是发一条空表把用户的映射抹掉。
  assert.deepEqual(draftOps({ ...draft, mapping: 'bad line' }, value), [])
})

test('同步设置：草稿里能当场看出来的问题（挡住保存，且说得清是哪个码）', () => {
  const draft = draftFrom({})
  assert.deepEqual(draftProblems(draft), [])
  assert.deepEqual(draftProblems({ ...draft, timeoutMs: '0' }), [{ code: 'timeoutNotPositive' }])
  assert.deepEqual(draftProblems({ ...draft, timeoutMs: '30s' }), [{ code: 'timeoutNotPositive' }])
  const bad = draftProblems({ ...draft, mapping: '/a = /b\nbroken' })
  assert.equal(bad.length, 1)
  assert.equal(bad[0].code, 'mapping')
})

test('同步设置：接缝没给出值时不编造（空节 → 空草稿）', () => {
  assert.deepEqual(syncSectionOf(undefined), {})
  assert.deepEqual(syncSectionOf({ status: 'ready', writable: true }), {})
  assert.deepEqual(draftFrom(syncSectionOf({ status: 'ready', writable: true, value: { sync: { url: 'https://x' } } })), {
    url: 'https://x',
    machineId: '',
    username: '',
    passwordRef: '',
    mapping: '',
    timeoutMs: '',
  })
})
