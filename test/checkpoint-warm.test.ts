// 「落地之后请宿主补投影检查点」这一层的单元面：去重、逐条兜住、拿不到端口就如实报。
//
// 为什么单独一个文件：这条路径的**失败语义**就是它的全部价值——它补的是宿主那份派生数据，绝不能因为
// 它失败就把一次成功的落地说成失败（见 src/checkpoint-warm.ts 的开头）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeWarm, warmCheckpoints, type WarmDeps } from '../src/checkpoint-warm.ts'
import type { CheckpointWarmPort } from '../src/types.ts'

/** 记下都请宿主补过谁，并按需让某几条失败。 */
function fakePort(options: { fail?: readonly string[] } = {}): { port: CheckpointWarmPort; asked: string[] } {
  const asked: string[] = []
  const failing = new Set(options.fail ?? [])
  return {
    asked,
    port: {
      warm: async (sessionId: string): Promise<void> => {
        asked.push(sessionId)
        if (failing.has(sessionId)) throw new Error(`宿主说这条读不动：${sessionId}`)
      },
    },
  }
}

test('没有要补的会话时连端口都不探（纯推送这类路上不该多读一次宿主服务）', async () => {
  let probed = 0
  const deps: WarmDeps = {
    hostCheckpoints: () => {
      probed += 1
      return fakePort().port
    },
  }
  const outcome = await warmCheckpoints([], deps)
  assert.deepEqual(outcome, { warmed: 0, failed: 0, unavailable: false, problems: [] })
  assert.equal(probed, 0, '一条都没有时不该探测')
  assert.equal(describeWarm(outcome), undefined, '没什么可说的就不摆这一行')
})

test('探测不到端口：如实报 unavailable，一条都不试', async () => {
  const outcome = await warmCheckpoints(['s-1', 's-2'], { hostCheckpoints: () => undefined })
  assert.deepEqual(outcome, { warmed: 0, failed: 0, unavailable: true, problems: [] })
  assert.match(String(describeWarm(outcome)), /第一次点开/)
})

test('探测本身抛错：按"没有那套动作"报，并把原因带上', async () => {
  const outcome = await warmCheckpoints(['s-1'], {
    hostCheckpoints: () => {
      throw new Error('读服务失败')
    },
  })
  assert.equal(outcome.unavailable, true)
  assert.equal(outcome.warmed, 0)
  assert.deepEqual(outcome.problems, ['读服务失败'])
})

test('逐条去重、按顺序走一遍，重复的 id 只补一次', async () => {
  const fake = fakePort()
  const outcome = await warmCheckpoints(['s-2', 's-1', 's-2', ''], { hostCheckpoints: () => fake.port })
  assert.deepEqual(fake.asked, ['s-2', 's-1'], '按首次出现的顺序、空串不进列表')
  assert.equal(outcome.warmed, 2)
  assert.equal(outcome.failed, 0)
  assert.match(String(describeWarm(outcome)), /2 条/)
})

test('一条失败不影响后面的：计数分开、原因进 problems，落地照旧算成功', async () => {
  const fake = fakePort({ fail: ['s-2'] })
  const outcome = await warmCheckpoints(['s-1', 's-2', 's-3'], { hostCheckpoints: () => fake.port })
  assert.equal(outcome.warmed, 2)
  assert.equal(outcome.failed, 1)
  assert.equal(outcome.unavailable, false)
  assert.deepEqual(outcome.problems, ['s-2：宿主说这条读不动：s-2'])
  assert.deepEqual(fake.asked, ['s-1', 's-2', 's-3'], '失败的那条不该把后面的截断')
  const sentence = String(describeWarm(outcome))
  assert.match(sentence, /2 条/)
  assert.match(sentence, /1 条没补上/)
  assert.match(sentence, /不影响落地/)
})

test('失败多于三条时只带前三条原因，条数照实报', async () => {
  const ids = ['s-1', 's-2', 's-3', 's-4', 's-5']
  const outcome = await warmCheckpoints(ids, { hostCheckpoints: () => fakePort({ fail: ids }).port })
  assert.equal(outcome.failed, 5)
  assert.equal(outcome.problems.length, 3)
})

test('没注入这个端口时按"这个宿主补不了"处理，而不是抛', async () => {
  const outcome = await warmCheckpoints(['s-1'], {})
  assert.equal(outcome.unavailable, true)
  assert.equal(outcome.failed, 0)
})
