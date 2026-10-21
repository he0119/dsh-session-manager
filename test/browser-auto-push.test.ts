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

test('自动推送表单：草稿如实读回，缺省是"没开"', () => {
  const empty = draftFrom({})
  assert.equal(empty.autoPush, false, '没配过就是没开（开关不打开）')
  // 空节 → 整份草稿，与已保存的那一节逐字段对得上。
  assert.deepEqual(empty, {
    url: '',
    machineId: '',
    username: '',
    mapping: [],
    timeoutMs: '',
    autoPush: false,
  })

  assert.equal(draftFrom({ autoPush: true }).autoPush, true, '配过就照实读回')
})

test('自动推送表单：只提交真的改过的那一格（取消勾选发 unset）', () => {
  const value = { url: 'https://dav.example.com/dsh', autoPush: true }
  const draft = draftFrom(value)
  assert.deepEqual(draftOps(draft, value), [], '原样不动什么都不写')

  assert.deepEqual(
    draftOps({ ...draft, autoPush: false }, value),
    [{ op: 'unset', path: ['sync', 'autoPush'] }],
    '取消勾选发 unset（缺省就是没开，不必在用户层留一条 set false）',
  )

  // 没开的那份配置里勾上：发的是 `set true`。
  const off = { url: 'https://dav.example.com/dsh' }
  assert.deepEqual(draftOps(draftFrom(off), off), [])
  assert.deepEqual(draftOps({ ...draftFrom(off), autoPush: true }, off), [
    { op: 'set', path: ['sync', 'autoPush'], value: true },
  ])
})

test('自动推送表单：草稿只剩开关这一格，没有间隔可填', () => {
  /*
   * 间隔那一栏跟着兜底定时器一起删了。这一条钉住草稿的**形状**：多出一格没人读的字段，界面上就会
   * 多画一个输入框、用户填了也什么都不影响。
   */
  assert.deepEqual(
    Object.keys(draftFrom({ autoPush: true })).sort(),
    ['autoPush', 'machineId', 'mapping', 'timeoutMs', 'url', 'username'],
  )
  // 超时那一栏的判据照旧（它跟自动推送无关，别被这次删改带走）。
  assert.deepEqual(draftProblems({ ...draftFrom({}), timeoutMs: '0' }), [{ code: 'timeoutNotPositive' }])
})

// ---- 字典 ----

test('自动推送字典：新增的键两种语言都在，占位符也一致', () => {
  const keys = [
    'sync.field.autoPush',
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
  ] as const
  for (const key of keys) {
    assert.ok(key in zh, `中文缺 ${key}`)
    assert.ok(key in en, `英文缺 ${key}`)
  }
  // 占位符要成对：句子里的 `{pushed}` 在两种语言里都得有，否则 `t()` 换出来的是一个原样的花括号。
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
  for (const key of ['sync.autoPush.enabled', 'sync.autoPush.done', 'sync.autoPush.skipped', 'sync.autoPush.failed', 'sync.autoPush.problem']) {
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
