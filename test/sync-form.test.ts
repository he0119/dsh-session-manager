// test/sync-form.test.ts — 「同步设置」表单的数据面：映射草稿的解析/格式化，以及"保存会写什么"。
//
// 这一层是纯函数（不 import React、也不 import 宿主客户端包），所以能直接单测：真正会在用户层留下
// 痕迹的是 `draftOps()` 发出去的那几条路径编辑——只提交改动过的字段、空草稿发 unset，这两条规矩
// 写错了不会当场报错，只会在配置文档里攒下一堆"等于默认值"的覆盖，界面从此满屏「已覆盖」。
//
// `savePlan()` 是同一件事的另一半：密码那一笔走宿主机凭据库而不是配置文档，写错引用名不会有任何
// 报错（密码存进去了，同步却照旧因为"没配密码"而 401），所以这里把"写哪个名字、什么时候不写"钉住。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_PASSWORD_REF,
  draftFrom,
  draftOps,
  draftProblems,
  mappingProblems,
  mappingRows,
  mappingValue,
  passwordRefOf,
  savePlan,
  SYNC_SECTION,
  syncSectionOf,
  testVerdict,
  type SyncTestOutcome,
  type SyncTestSentence,
} from '../src/client/logic/syncForm.ts'
import { en, zh } from '../src/client/logic/locales.ts'
import { AUTO_PUSH_SKIP_CODES } from '../src/client/logic/autoPush.ts'
import { DEFAULT_PASSWORD_REF as CORE_DEFAULT_PASSWORD_REF } from '../src/config.ts'

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
    mapping: [],
    timeoutMs: '',
    // 自动推送那一栏也是"没给就不编"：按未勾选（"没开"，不是"用默认值开"）。
    autoPush: false,
  })
})

test('同步设置：密码写进哪个引用名——配置里写了用它，留空用缺省名', () => {
  assert.equal(DEFAULT_PASSWORD_REF, 'DSH_DAV_PASSWORD', '缺省名是对外名字，改了等于换一个凭据')
  // 浏览器半侧与核心层各留一份同值副本（那一侧不 import 核心层）：算出不同的名字，界面存进去的
  // 密码这边就不会去读，而两处各自看都是"对"的。
  assert.equal(DEFAULT_PASSWORD_REF, CORE_DEFAULT_PASSWORD_REF, '两侧的缺省引用名必须同一个')
  assert.equal(passwordRefOf({}), DEFAULT_PASSWORD_REF)
  assert.equal(passwordRefOf({ passwordRef: '' }), DEFAULT_PASSWORD_REF)
  assert.equal(passwordRefOf({ passwordRef: '   ' }), DEFAULT_PASSWORD_REF, '只有空白等于没写')
  assert.equal(passwordRefOf({ passwordRef: 'MY_DAV_PASSWORD' }), 'MY_DAV_PASSWORD')
  assert.equal(passwordRefOf({ passwordRef: '  MY_DAV_PASSWORD  ' }), 'MY_DAV_PASSWORD', '前后空白不算名字的一部分')
})

test('同步设置：引用名不归这张表单（草稿里没有它，也就不会去写它）', () => {
  const value = { url: 'https://dav.example.com/dsh', passwordRef: 'MY_DAV_PASSWORD' }
  const draft = draftFrom(value)
  // 那一栏在插件配置页那份通用表单上：这张卡的草稿里没有它，于是改不动它、也不会把它写成 unset
  // （写下去就是把别人的引用名抹掉——密码还在凭据库里，同步却再也找不到它）。
  assert.equal('passwordRef' in draft, false)
  assert.deepEqual(draftOps(draft, value), [])
  assert.deepEqual(draftOps({ ...draft, url: 'https://two.example/dsh' }, value), [
    { op: 'set', path: ['sync', 'url'], value: 'https://two.example/dsh' },
  ])
})

test('同步设置：留空的密码不写、输了的才写，且写进配置里那个引用名', () => {
  const value = { url: 'https://dav.example.com/dsh', passwordRef: 'MY_DAV_PASSWORD' }
  const draft = draftFrom(value)

  // 空白（含只有空格）：这一笔不发，已存的那一个留着——改 URL 时最平常的用法。
  for (const blank of ['', ' ', '\t']) {
    assert.equal(savePlan(draft, value, blank, true).password, undefined, `"${blank}" 不该发凭据写入`)
  }
  assert.deepEqual(savePlan(draft, value, 'hunter2', true).password, {
    ref: 'MY_DAV_PASSWORD',
    value: 'hunter2',
  })
  // 引用名取自**生效值**：插件配置里换了个名字，这一笔就落在新名字下。
  const renamed = { url: 'https://dav.example.com/dsh', passwordRef: 'NEW_REF' }
  assert.deepEqual(savePlan(draftFrom(renamed), renamed, 'hunter2', true).password, {
    ref: 'NEW_REF',
    value: 'hunter2',
  })
  // 配置里没写引用名：落到缺省名上（与核心层 passwordRefOf 同一套规则）。
  const bare = { url: 'https://dav.example.com/dsh' }
  assert.deepEqual(savePlan(draftFrom(bare), bare, 'hunter2', true).password, {
    ref: DEFAULT_PASSWORD_REF,
    value: 'hunter2',
  })
  // 宿主没有凭据服务：只发配置编辑，不假装能存密码。
  assert.equal(savePlan(draft, value, 'hunter2', false).password, undefined)
  // 只有密码变了也算脏（配置编辑可以是空数组），否则「保存」按钮永远点不亮。
  assert.deepEqual(savePlan(draft, value, 'hunter2', true).ops, [])
})

test('同步设置：测试连接的结论翻成哪一句（判定在宿主侧，这一层只挑句子）', () => {
  const base: SyncTestOutcome = {
    code: 'ok',
    status: 207,
    namespaceExists: false,
    machines: [],
    entries: 0,
    username: 'webdav',
    hasPassword: true,
  }
  const cases: Array<[string, SyncTestOutcome, SyncTestSentence]> = [
    // 连得上：三种情形分开说——还没有这一层 / 有但还没机器推过 / 已经有机器格
    ['还没建命名空间', { ...base }, { key: 'sync.test.okFirst' }],
    ['命名空间在、但空', { ...base, namespaceExists: true }, { key: 'sync.test.okEmpty' }],
    [
      '已有机器格',
      { ...base, namespaceExists: true, machines: ['robot-a', 'robot-b'], entries: 2 },
      { key: 'sync.test.ok', params: { machines: 'robot-a, robot-b' } },
    ],
    // 401 三句：没填用户名 / 引用名里没有值 / 服务器不认这套——处置完全不同，不能混
    ['没填用户名', { ...base, code: 'unauthenticated', status: 401, username: null }, { key: 'sync.test.noUser', params: { status: 401 } }],
    [
      '引用名里没有值',
      { ...base, code: 'unauthenticated', status: 401, hasPassword: false },
      { key: 'sync.test.noPassword', params: { ref: 'DSH_DAV_PASSWORD' } },
    ],
    ['凭据不对', { ...base, code: 'unauthenticated', status: 401 }, { key: 'sync.test.unauthorized', params: { status: 401 } }],
    ['没权限', { ...base, code: 'forbidden', status: 403 }, { key: 'sync.test.forbidden', params: { status: 403 } }],
    ['地址不对', { ...base, code: 'notFound', status: 404 }, { key: 'sync.test.notFound', params: { status: 404 } }],
    ['不是 WebDAV', { ...base, code: 'unsupported', status: 405 }, { key: 'sync.test.unsupported', params: { status: 405 } }],
    ['连不上', { ...base, code: 'unreachable', status: 0, detail: 'fetch failed' }, { key: 'sync.test.unreachable', params: { detail: 'fetch failed' } }],
    [
      '服务器出错',
      { ...base, code: 'serverError', status: 503, detail: 'x' },
      { key: 'sync.test.serverError', params: { status: 503, detail: 'x' } },
    ],
    [
      '认不出来的码也照实说',
      { ...base, code: 'wat', status: 418, detail: 'teapot' },
      { key: 'sync.test.other', params: { status: 418, detail: 'teapot' } },
    ],
  ]
  for (const [name, outcome, expected] of cases) {
    const sentence = testVerdict(outcome, 'DSH_DAV_PASSWORD')
    assert.deepEqual(sentence, expected, name)
    // 句子真在字典里：键写错了界面上会露出键名（`t()` 找不到就回落到键），而两种语言都得有。
    assert.ok(sentence.key in zh, `${name}：中文缺 ${sentence.key}`)
    assert.ok(sentence.key in en, `${name}：英文缺 ${sentence.key}`)
  }
  // 认不出来的码不许悄悄说成"连得上"
  assert.notEqual(testVerdict({ ...base, code: 'wat', status: 418, detail: 'teapot' }, 'REF').key, 'sync.test.ok')
})

// ── 自动推送那两栏（开关 + 间隔）────────────────────────────────────────────

test('同步设置：打开自动推送发一条 set，关掉发 unset（与 timeoutMs 同一条规矩）', () => {
  /*
   * 只提交**改动过**的字段：逐字提交会在用户层攒下一堆"等于默认值"的覆盖。所以两种方向各钉一遍：
   * 从没开改到开 → 一条 `set true`；从开改到关 → 一条 `unset`（退回组合层，而不是写一个 `false`）。
   */
  const base = draftFrom({})

  const opened = draftOps({ ...base, autoPush: true }, {})
  assert.deepEqual(opened, [{ op: 'set', path: ['sync', 'autoPush'], value: true }])

  const closed = draftOps({ ...base, autoPush: false }, { autoPush: true })
  assert.deepEqual(closed, [{ op: 'unset', path: ['sync', 'autoPush'] }])

  // 没动过就不发编辑：这是"别的字段不跟着被覆盖"的防线。
  assert.deepEqual(draftOps(base, {}), [], '什么都没改 → 一条编辑都不发')
  assert.deepEqual(draftOps({ ...base, autoPush: true }, { autoPush: true }), [], '开关本来就开着 → 不发')
})



test('同步设置：自动推送的字典键两种语言都在', () => {
  // 界面那几处文案全走 `t()`；键写错时界面上会露出键名。这里核"开关 / 立即推送 / 跑完 / 没跑"
  // 这几组键真的存在——`LocaleDictOf` 已经在编译期核过键集一致，这一条核的是**用到的**那些。
  const keys = [
    'sync.field.autoPush',
    'sync.field.autoPushHint',
    'sync.autoPush.now',
    'sync.autoPush.running',
    'sync.autoPush.done',
    'sync.autoPush.nothing',
    'sync.autoPush.enabled',
    'sync.autoPush.failed',
    'sync.autoPush.problem',
    'sync.autoPush.noReason',
  ] as const
  for (const key of keys) {
    assert.ok(key in zh, `中文缺 ${key}`)
    assert.ok(key in en, `英文缺 ${key}`)
  }
  /*
   * `skip` 的每个码都要有各的句子（判定在宿主、句子在界面）：少一个界面上就会退回 noReason。
   *
   * 这份清单**从核心层的联合类型推不出来**（类型在运行期不存在），所以它是手抄的——正因为手抄，它是这
   * 条链路上最容易漏的一环：核心层加一个码时宿主会照实报出来，而界面这一侧少一句话只会安静地退化成
   * "宿主没有说原因"。所以这里核的是**清单与字典对齐**，并且清单本身要跟 `src/sync.ts` 的 `AutoPushSkip`
   * 一致（下面那条断言核的就是这件事）。
   */
  for (const code of AUTO_PUSH_SKIP_CODES) {
    assert.ok(`sync.autoPush.skip.${code}` in zh, `中文缺 sync.autoPush.skip.${code}`)
    assert.ok(`sync.autoPush.skip.${code}` in en, `英文缺 sync.autoPush.skip.${code}`)
  }
})

test('同步设置：界面认得的 skip 码与核心层的联合类型对得上', () => {
  /*
   * `AutoPushSkip` 是**类型**，运行期看不到它；而字典的键是字符串。两边对不上的表现是"界面少一句
   * 话"——不报错、不崩，只是那句原因退回 noReason。所以这条把宿主会报出来的码逐个钉住：
   * `src/sync.ts` 里 `runAutoPush()` / `createAutoPushTimer()` 返回的每一个 `skip` 都得在这份清单里。
   *
   * 反过来（清单里多一个宿主不会报的码）不算错——那样只是字典里多一句用不上的话，无害。
   */
  for (const code of AUTO_PUSH_SKIP_CODES) {
    assert.ok(`sync.autoPush.skip.${code}` in zh, `清单里的 ${code} 中文没句子`)
  }
  // 核心层的源码里出现过的 skip 字面量，都得在清单里。
  const source = readFileSync(new URL('../src/sync.ts', import.meta.url), 'utf8')
  const declared = [...source.matchAll(/skip:\s*'([a-z]+)'/g)].map((match) => match[1] as string)
  assert.ok(declared.length > 0, '没扫到任何 skip 字面量——匹配式写错了，这条会变成空断言')
  for (const code of new Set(declared)) {
    assert.ok(
      (AUTO_PUSH_SKIP_CODES as readonly string[]).includes(code),
      `src/sync.ts 会报 skip:'${code}'，但界面的 AUTO_PUSH_SKIP_CODES 里没有它（字典也就不会有句子）`,
    )
  }
})

test('同步设置：自动推送的文案说清了"停手 5 分钟才推"（两种语言都要）', () => {
  /*
   * 这一组钉的是**文案的语义**。`LocaleDictOf` 只能核**键集**一致，核不了两份译文说不说同一件事，所以
   * 这里逐条核三件必须说出口的事：
   *   1. 触发点是"本机安静满 5 分钟"（quiet for five minutes），不是"写完立刻推"，也不是一个可调的周期；
   *   2. 窗口是 5 分钟这个数——用户得知道要等多久，否则会以为坏了一直不推；
   *   3. 它只推送、绝不拉取（这条是安全边界，用户得能从界面上读到）。
   *
   * 不核具体措辞（措辞会变），只核这几件必须说出口的事；顺带核"没有把窗口说成一个旋钮"——
   * `间隔` / `interval` 这类字样回来了，说明那个被删掉的设置项又从文案里长出来了。
   */
  const cases = [
    ['sync.field.autoPushHint', /5 分钟/, /five minutes/],
    ['sync.autoPush.enabled', /5 分钟/, /five minutes/],
  ] as const
  for (const [key, zhPattern, enPattern] of cases) {
    const zhText = zh[key as keyof typeof zh] as string
    const enText = en[key as keyof typeof en] as string
    assert.match(zhText, zhPattern, `${key} 中文没说清要等多久（应匹配 ${zhPattern}）：${zhText}`)
    assert.match(enText, enPattern, `${key} 英文没说清要等多久（应匹配 ${enPattern}）：${enText}`)
    assert.doesNotMatch(zhText, /间隔|每隔|定时器/, `${key} 中文把窗口说成了可调周期：${zhText}`)
    assert.doesNotMatch(enText, /interval|timer/i, `${key} 英文把窗口说成了可调周期：${enText}`)
  }
  assert.match(zh['sync.field.autoPushHint'], /安静|停手/, '中文没说是"等安静下来"')
  assert.match(en['sync.field.autoPushHint'], /quiet/i, '英文没说是"等安静下来"')
  for (const key of ['sync.field.autoPushHint'] as const) {
    assert.match(zh[key], /不拉|只推/, `${key} 没说"只推不拉"`)
    assert.match(en[key], /never pulls/, `${key} 没说"只推不拉"`)
  }
})
