// test/client/operations/manage/run-job.test.ts — 「确认之后的那扇状态窗」这一份状态（`src/client/operations/manage/runJob.ts`）。
//
// 为什么单独钉它：删除 / 迁移 / 导入 / 回滚 / 整理远端 / 重算名称这六个写盘的动作，确认之后都交给
// 同一个状态窗：跑着报进度、可以「转到后台」、跑完在**同一个窗口**里换成结果页、按「完成」收掉。
// 这一套的"谁在跑、跑到哪、窗口开没开、结论还在不在"全是模块级状态，界面冒烟里推不动（假 React
// 不跑副作用，也没法调用这个模块的入口），所以在这一层逐条钉住。
//
// 六个动作各自的"结果页长什么样"不在这里：那些是各面板传给 `startRun()` 的 `render(done)`，界面冒烟
// 照着点击走一遍（见 test/plugin/client.test.mjs 的「迁移落地之后进度在状态窗里」那两条）。
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProgressEvent } from '../../../../src/client/api.ts'
import { backgroundRun, dismissRun, getRun, openRunDialog, startRun, subscribeRun } from '../../../../src/client/operations/manage/runJob.ts'
import { runChipLabel, runTitle } from '../../../../src/client/operations/manage/runLabel.ts'

/**
 * 翻译替身：把键与参数拼成一句可比较的字符串（与冒烟夹具同一口径）。
 */
const t = (key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`

/** 一条进度事件（形状见 src/shared/types.ts 的 `ProgressEvent`）。 */
const progress = (phase: string, done: number, total: number, label?: string): ProgressEvent => ({
  phase,
  done,
  total,
  ...(label === undefined ? {} : { label }),
})

/** 等一轮微任务 / 定时器，让 `startRun` 里那几个 `.then` 落地。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 收尾：把上一条用例留下的状态清干净（模块级状态，用例之间共享）。
 *
 * 正在跑的那一份不能直接丢——`dismissRun()` 就是这么定的（跑着的时候关窗等于转后台，不是放弃）。
 * 所以先等它跑完再收：每条用完的用例都要调到 `getRun() === null`。
 */
async function reset(): Promise<void> {
  for (let tries = 0; tries < 50 && getRun()?.running === true; tries += 1) await settle()
  dismissRun()
  assert.equal(getRun(), null, '上一条用例没把状态收干净：这一条会在别人的状态上跑')
}

test('起跑 → 进度 → 结果：同一份状态走完三个样子', async () => {
  await reset()
  let report: ((event: ProgressEvent) => void) | undefined
  let finish: ((value: string) => void) | undefined
  const rendered: unknown[] = []
  const started = startRun(
    'delete',
    (emit) => {
      report = emit
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    },
    (done) => {
      rendered.push(done)
      return null
    },
  )
  assert.equal(started, true, '没有别的一趟在跑，这一趟发起来了')

  const launched = getRun()
  assert.ok(launched !== null)
  assert.equal(launched.kind, 'delete')
  assert.equal(launched.running, true, '刚发起就是在跑')
  assert.equal(launched.dialog, true, '状态窗立刻打开（确认之后用户就该看见它在动）')
  assert.equal(launched.progress, null, '第一条进度还没来：状态窗里说"正在准备…"')
  assert.equal(launched.done, null)

  report?.(progress('remove', 0, 3, '会话甲'))
  const moving = getRun()
  assert.notEqual(moving, launched, '每次变化换一个新对象（订阅者据此判"变了没有"）')
  assert.equal(moving?.progress?.done, 0, '进度原样收进来')
  assert.equal(moving?.progress?.total, 3)
  assert.equal(moving?.running, true)

  report?.(progress('remove', 2, 3, '会话丙'))
  assert.equal(getRun()?.progress?.done, 2, '后一条进度覆盖前一条')
  assert.equal(getRun()?.progress?.label, '会话丙')

  finish?.('删了 3 条')
  await settle()
  const settled = getRun()
  assert.equal(settled?.running, false, '结果回来之后就不算在跑了')
  assert.equal(settled?.done?.ok, true)
  assert.equal(settled?.done?.result, '删了 3 条', '宿主回的那份原样挂着（各面板自己解释）')
  assert.equal(settled?.progress?.done, 2, '结论到了也不清进度：结果页万一要引用它')
  assert.deepEqual(rendered, [], '结论不替调用方画：等界面真的去读它时才调 render（见下面那条）')

  // 迟到的进度不该把已经结束的那一趟改回"在跑"。
  report?.(progress('remove', 3, 3))
  assert.equal(getRun()?.running, false)
  assert.equal(getRun()?.progress?.done, 2, '已经结束的状态不吃迟到的事件')
})

test('结果页是 `render(done)` 画的：同一份结论、每一件事自己拼正文', async () => {
  await reset()
  const seen: unknown[] = []
  startRun(
    'migrate',
    () => Promise.resolve({ summary: '已迁移 1 条会话。', problems: ['s-2：还在跑'] }),
    (done) => {
      seen.push(done.result)
      return '结果页'
    },
  )
  await settle()
  const run = getRun()
  assert.ok(run !== null)
  // 界面（`RunDialog`）就是拿这一份状态调 `render` 的：渲染一次看它给的是什么。
  assert.equal(run.render(run.done ?? { ok: true }), '结果页')
  assert.deepEqual(seen, [{ summary: '已迁移 1 条会话。', problems: ['s-2：还在跑'] }], '拿到的正是宿主回的那份')
})

test('转后台：窗口关掉、活儿照跑；点状态栏那一格回到同一扇窗', async () => {
  await reset()
  let finish: (() => void) | undefined
  startRun(
    'import',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    () => null,
  )
  assert.equal(getRun()?.dialog, true)

  backgroundRun()
  assert.equal(getRun()?.dialog, false, '窗口收起来了')
  assert.equal(getRun()?.running, true, '活儿没停（这不是取消）')

  // 同一个入口：跑着能回去，跑完也能回去（跑完就落在结果页上）。
  openRunDialog()
  assert.equal(getRun()?.dialog, true, '点状态栏那一格回到同一扇窗')

  backgroundRun()
  finish?.()
  await settle()
  assert.equal(getRun()?.dialog, false, '转到后台之后结果不会自己把窗口弹出来')
  assert.equal(getRun()?.done?.ok, true, '结论在等着')
  openRunDialog()
  assert.equal(getRun()?.dialog, true, '回来时窗口开着，正文就是结果页')
})

test('「完成」把结论取走：之后不再有任何状态；跑着的时候按不动', async () => {
  await reset()
  let finish: ((value: number) => void) | undefined
  startRun(
    'retitle',
    () =>
      new Promise<number>((resolve) => {
        finish = resolve
      }),
    () => null,
  )
  // 跑着的时候关窗只是转后台：结论还没出来，没有"完成"可言。
  dismissRun()
  assert.equal(getRun()?.running, true, '跑着时 dismissRun 不动它')
  assert.equal(getRun()?.dialog, true)

  finish?.(1)
  await settle()
  dismissRun()
  assert.equal(getRun(), null, '按「完成」之后这一趟彻底收掉（状态栏那一格也随之消失）')
  dismissRun()
  assert.equal(getRun(), null, '再按一次没有副作用')
})

test('一次只跑一件：跑着时第二趟发不起来，第一趟跑完才放行', async () => {
  await reset()
  let finish: (() => void) | undefined
  const work = (): Promise<void> =>
    new Promise<void>((resolve) => {
      finish = resolve
    })
  assert.equal(startRun('delete', work, () => null), true)
  assert.equal(startRun('migrate', work, () => null), false, '第二趟被拒：两趟同时写盘会互相踩着')
  assert.equal(getRun()?.kind, 'delete', '留下的是先发起的那一趟')

  finish?.()
  await settle()
  assert.equal(startRun('tidy', () => Promise.resolve('ok'), () => null), true, '上一趟跑完就能再开')
  await settle()
})

test('请求本身没走通：留一条失败结论，结果页说原因', async () => {
  await reset()
  startRun(
    'rollback',
    () => Promise.reject(new Error('远端 503')),
    () => null,
  )
  await settle()
  assert.equal(getRun()?.running, false)
  assert.equal(getRun()?.done?.ok, false)
  assert.equal(getRun()?.done?.error, '远端 503', '说的是原因本身，不是"未知错误"')
  await reset()
})

test('订阅：每次变化通知一次，退订之后不再叫', async () => {
  await reset()
  let calls = 0
  const off = subscribeRun(() => {
    calls += 1
  })
  assert.equal(startRun('tidy', () => Promise.resolve('ok'), () => null), true)
  assert.equal(calls, 1, '发起时通知一次（状态窗要开）')
  await settle()
  assert.equal(calls, 2, '结论落地再通知一次')
  off()
  // 退订之后任何变化都不该再叫到它（`getRun()` 是读的入口，订阅只是"变了叫我"）。
  dismissRun()
  assert.equal(calls, 2)
  assert.equal(getRun(), null)
})

test('状态栏那一格说什么：跑着报第几条，跑完说做完了 / 没做成', async () => {
  await reset()
  let finish: (() => void) | undefined
  startRun(
    'migrate',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    () => null,
  )
  const started = getRun()
  assert.ok(started !== null)
  assert.equal(runChipLabel(started, t), 'run.migrate.running', '还没收到进度：说这件事正在做')
  assert.equal(runChipLabel({ ...started, progress: progress('rewrite', 0, 0) }, t), 'run.migrate.running', '分母还是 0 时不编一个 0/0')
  assert.equal(
    runChipLabel({ ...started, progress: progress('rewrite', 3, 7) }, t),
    'run.chip.running:{"done":3,"total":7}',
    '有分母就报第几条 / 共几条',
  )
  finish?.()
  await settle()
  const done = getRun()
  assert.ok(done !== null)
  assert.equal(runChipLabel(done, t), 'run.migrate.done', '跑完了说"迁移完成"（与结果页标题同一套词）')
  assert.equal(
    runChipLabel({ ...done, done: { ok: false, error: '被拒' } }, t),
    'run.chip.failed',
    '没成时说"没做成"（原因在结果页里）',
  )
  await reset()
})
