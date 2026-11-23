// test/shared/host/log-lines.test.ts — 往宿主 logger 说话时，接收者不能丢。
//
// 为什么值得单独钉：宿主用的是 Cordis 4.1.0，它的 `ctx.logger.warn` 要靠调用时的接收者才跑得起来；
// 一旦写成 `(logger.warn ?? logger.info)?.(m)`（`??` 先取函数值），调用就没有接收者，直接抛
// `TypeError: this is not a function`。这条错被上层吞掉之后，现象离原因很远：升级后的第一次启动里
// "上次同步记录已搬进存储"那句话打不出来，打开领域那一步跟着失败，页头退回"配没配"，要重启一次才恢复。
//
// 这里用一个方法依赖 `this` 的 logger（与 4.1.0 同一形状）把两件事钉住：
//   1) `info` / `warn` 都是成员调用，不抛；
//   2) 没有 `warn` 时退回 `info` 也不抛。
import assert from 'node:assert/strict'
import test from 'node:test'

import { logLines } from '../../../src/shared/host/log-lines.ts'

/** 照 Cordis 4.1.0 的形状写：方法存进 `this.lines`，脱离接收者调用就会抛。 */
class ThisBoundLogger {
  readonly lines: string[] = []

  info(message: string): void {
    this.lines.push(`info:${message}`)
  }

  warn(message: string): void {
    this.lines.push(`warn:${message}`)
  }
}

/** 只有 `info` 的 logger：退回那一条也要走成员调用。 */
class InfoOnlyLogger {
  readonly lines: string[] = []

  info(message: string): void {
    this.lines.push(message)
  }
}

test('前提：这种 logger 的方法脱离接收者就会抛，下面的用例才抓得住那个写法', () => {
  const logger = new ThisBoundLogger()
  const detached = logger.warn
  assert.throws(() => detached('x'), TypeError)
  assert.deepEqual(logger.lines, [], '抛出发生在写进 lines 之前')
})

test('info 与 warn 都走成员调用：方法依赖 this 的 logger 也不抛', () => {
  const logger = new ThisBoundLogger()
  const { info, warn } = logLines(logger)
  info('已就绪')
  warn('上次同步的记录已从 state.json 搬进存储')
  assert.deepEqual(logger.lines, [
    'info:已就绪',
    'warn:上次同步的记录已从 state.json 搬进存储',
  ])
})

test('没有 warn 时退回 info，仍然是成员调用', () => {
  const logger = new InfoOnlyLogger()
  const { warn } = logLines(logger)
  warn('只配了 info 的宿主也要把这句说出来')
  assert.deepEqual(logger.lines, ['只配了 info 的宿主也要把这句说出来'])
})

test('没有 logger 时两个口子都是空操作，不抛', () => {
  const { info, warn } = logLines(undefined)
  assert.doesNotThrow(() => {
    info('x')
    warn('y')
  })
})
