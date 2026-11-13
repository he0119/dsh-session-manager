// test/browser-auto-push.test.ts — 浏览器半侧的「自动推送」那一块。
//
// 这一份只测**源码那一层**能测的东西，不碰产物（产物冒烟在 test/client.test.mjs，归 Lead）：
//   1) 表单数据面（syncForm.ts）：开关怎么进草稿、发哪一条路径编辑；
//   2) 字典：新增的那几个 `sync.*` 键两种语言都有，且真的被界面问到；
//   3) API 那一层（api.ts）：`runAutoPushNow()` 打哪个端点、进度回调接没接上、结果怎么解析。
//
// 为什么单独一个文件：全库的路径编辑（`draftOps`）写错了不会当场报错，只在配置文档里悄悄攒下一条
// "等于默认值"的覆盖，而界面上那一栏从此顶着「已覆盖」徽标——它值得自己那一组断言。文件名与
// test/run-all.mjs 的扫描规则一致（`*.test.ts`，按名字排序在同进程里 import）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { runAutoPushNow, type AutoPushResponse, type ProgressEvent } from '../src/client/api.ts'
import { en, zh } from '../src/client/logic/locales.ts'
import { draftFrom, draftOps, draftProblems } from '../src/client/logic/syncForm.ts'

// ---- 表单数据面 ----

test('自动表单：草稿如实读回，缺省是"关"', () => {
  const empty = draftFrom({})
  assert.equal(empty.auto, 'off', '没配过就是关')
  // 空节 → 整份草稿，与已保存的那一节逐字段对得上。
  assert.deepEqual(empty, {
    url: '',
    machineId: '',
    username: '',
    mapping: [],
    timeoutMs: '',
    auto: 'off',
  })

  assert.equal(draftFrom({ autoPush: true }).auto, 'push', '老写法（只推）读成"仅推送"')
  assert.equal(draftFrom({ autoSync: true }).auto, 'sync', '双向那一栏读成"双向"')
  assert.equal(draftFrom({ autoPush: true, autoSync: true }).auto, 'sync', '两个都写着时按双向（强的那档赢）')
})

test('自动表单：换档时发最小的那几条编辑', () => {
  /*
   * 界面上是一行三选一，配置里是两栏布尔。换到哪一档，就要让配置**正好**落成那一档：
   *   - 关：两栏都清（缺省就是关，发 unset 而不是 set false）；
   *   - 仅推送：写 autoPush、清掉可能留着的 autoSync（留着的话下次打开又回到双向，像没关掉）；
   *   - 双向：写 autoSync、清掉 autoPush（它被吸收）。
   */
  const off = { url: 'https://dav.example.com/dsh' }
  assert.deepEqual(draftOps(draftFrom(off), off), [], '原样不动什么都不写')
  assert.deepEqual(draftOps({ ...draftFrom(off), auto: 'push' }, off), [
    { op: 'set', path: ['sync', 'autoPush'], value: true },
  ])
  assert.deepEqual(draftOps({ ...draftFrom(off), auto: 'sync' }, off), [
    { op: 'set', path: ['sync', 'autoSync'], value: true },
  ])

  // 从只推换到双向：写双向 + 清掉旧的那栏。
  const push = { url: 'https://dav.example.com/dsh', autoPush: true }
  assert.deepEqual(draftOps({ ...draftFrom(push), auto: 'sync' }, push), [
    { op: 'unset', path: ['sync', 'autoPush'] },
    { op: 'set', path: ['sync', 'autoSync'], value: true },
  ])
  // 从双向换到只推：反过来同样两条。
  const both = { url: 'https://dav.example.com/dsh', autoSync: true }
  assert.deepEqual(draftOps({ ...draftFrom(both), auto: 'push' }, both), [
    { op: 'unset', path: ['sync', 'autoSync'] },
    { op: 'set', path: ['sync', 'autoPush'], value: true },
  ])
  // 关掉全部：两栏都清干净。
  assert.deepEqual(draftOps({ ...draftFrom(both), auto: 'off' }, both), [
    { op: 'unset', path: ['sync', 'autoSync'] },
  ])
  assert.deepEqual(
    draftOps({ ...draftFrom({ ...both, autoPush: true }) }, { ...both, autoPush: true }),
    [],
    '两栏都写着（双向赢）时不动就是不动',
  )
})

test('自动推送表单：草稿只剩开关这一格，没有间隔可填', () => {
  /*
   * 间隔那一栏跟着兜底定时器一起删了。这一条钉住草稿的**形状**：多出一格没人读的字段，界面上就会
   * 多画一个输入框、用户填了也什么都不影响。
   */
  assert.deepEqual(
    Object.keys(draftFrom({ autoPush: true })).sort(),
    // 自动只剩一个值（三选一），间隔那一栏早跟着兜底定时器一起删了。
    ['auto', 'machineId', 'mapping', 'timeoutMs', 'url', 'username'],
  )
  // 超时那一栏的判据照旧（它跟自动推送无关，别被这次删改带走）。
  assert.deepEqual(draftProblems({ ...draftFrom({}), timeoutMs: '0' }), [{ code: 'timeoutNotPositive' }])
})

// ---- 字典 ----

test('自动推送字典：新增的键两种语言都在，占位符也一致', () => {
  const keys = [
    'sync.field.auto',
    'sync.field.auto.off',
    'sync.field.auto.push',
    'sync.field.auto.sync',
    'sync.field.autoHintOff',
    'sync.field.autoPushHint',
    'sync.autoPush.enabled',
    'sync.autoPush.now',
    'sync.autoPush.running',
    'sync.autoPush.done',
    'sync.autoPush.nothing',
    'sync.autoPush.skipped',
    'sync.autoPush.failed',
    'sync.autoPush.skip.disabled',
    'sync.autoPush.skip.busy',
    'sync.autoPush.skip.idle',
    'sync.autoPush.noReason',
    'sync.autoPush.problem',
    // 双向那一档的几句（与上面同形，只是说"拉多少、推多少"）
    'sync.field.autoSyncHint',
    'sync.autoSync.enabled',
    'sync.autoSync.now',
    'sync.autoSync.running',
    'sync.autoSync.done',
    'sync.autoSync.nothing',
    'sync.autoSync.skipped',
    'sync.autoSync.failed',
    'sync.autoSync.problem',
    'sync.autoPush.skip.idleSync',
  ] as const
  for (const key of keys) {
    assert.ok(key in zh, `中文缺 ${key}`)
    assert.ok(key in en, `英文缺 ${key}`)
  }
  // 占位符要成对：句子里的 `{pushed}` 在两种语言里都得有，否则 `t()` 换出来的是一个原样的花括号。
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
  for (const key of [
    'sync.autoPush.enabled',
    'sync.autoPush.done',
    'sync.autoPush.skipped',
    'sync.autoPush.failed',
    'sync.autoPush.problem',
    'sync.autoSync.done',
    'sync.autoSync.skipped',
    'sync.autoSync.failed',
    'sync.autoSync.problem',
  ]) {
    assert.deepEqual(
      placeholders(zh[key as keyof typeof zh]),
      placeholders(en[key as keyof typeof en]),
      `${key} 两侧的占位符不一致`,
    )
  }
})

// ---- API 那一层 ----

/** 一段 SSE 文本按块喂给假 fetch（切块边界与事件边界无关，这正是分帧器要处理的常态）。 */
function streamResponse(chunks: string[]): Response {
  let index = 0
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[index++] ?? '') } : { done: true },
      }),
    },
    text: async () => '',
  } as unknown as Response
}

test('自动推送 API：打的是 /auto-push 那条 SSE，进度原样回调，结果原样解析', async () => {
  const result: AutoPushResponse = {
    mode: 'auto-push',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    ran: true,
    failures: 0,
    pushed: [{ id: 's-1', action: 'upload' }],
    pulled: [],
    bytesIn: 0,
    bytesOut: 2048,
    problems: [],
    takesEffect: 'immediate',
  }
  // 两块事件被切在中间：第一块的末尾是半条事件，交给分帧器攒着。
  const full = [
    'data: {"type":"progress","progress":{"phase":"scan","total":3,"done":0}}\n\n',
    'data: {"type":"progress","progress":{"phase":"push","total":1,"done":0,"id":"s-1","label":"一"}}\n\n',
    `data: {"type":"result","result":${JSON.stringify(result)}}\n\n`,
  ].join('')
  const chunks = [full.slice(0, 60), full.slice(60)]

  const calls: Array<{ url: string; method: string | undefined; accept: string | undefined }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, accept: init?.headers?.['accept' as never] })
    return streamResponse(chunks)
  }) as unknown as typeof fetch

  try {
    const seen: string[] = []
    const response = await runAutoPushNow((event: ProgressEvent) => seen.push(event.phase))
    assert.deepEqual(calls, [
      {
        url: '/dsh-session-manager/api/auto-push',
        method: 'GET',
        accept: 'text/event-stream',
      },
    ], '就是那个新端点、就是那条事件流')
    assert.deepEqual(seen, ['scan', 'push'], '两条进度都走到了调用方给的回调上')
    assert.deepEqual(response, result, '收尾那条 `result` 原样解析回来（含只推不拉那几栏）')
  } finally {
    globalThis.fetch = original
  }
})

test('自动推送 API：宿主回一次性 JSON（没配同步 / 没有调度器）时把原话抛出来', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 409,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: '这个宿主没有自动推送的调度器' }),
    }) as unknown as Response) as unknown as typeof fetch
  try {
    await assert.rejects(
      () => runAutoPushNow(),
      /这个宿主没有自动推送的调度器/,
      '拒绝的原因要说宿主的原话，而不是一句 HTTP 409',
    )
  } finally {
    globalThis.fetch = original
  }
})
