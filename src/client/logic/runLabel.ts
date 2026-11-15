/**
 * 状态窗与其入口（状态栏那一格）各自说哪一句——纯函数，因为这层最容易与结果页说法对不上。
 *
 * 为什么单独一份：窗口标题、状态栏那一格的短标签、失败时那句「没做成」，三处说的必须是同一件事
 * （用户从状态栏那一格点回窗口时，看到的不该是另一个说法）。抽成纯函数之后 `test/run-job.test.ts`
 * 直接钉每一支，不必把那扇窗渲染出来。
 *
 * @module dsh-session-manager/client/logic/runLabel
 */

import type { SessionManagerKey, Translate } from './locales.ts'
import type { RunKind, RunState } from './runJob.ts'

/** 每一件事的标题怎么说（跑着 / 跑完）。 */
export const RUN_TITLES: Readonly<Record<RunKind, { running: SessionManagerKey; done: SessionManagerKey }>> = {
  delete: { running: 'run.delete.running', done: 'run.delete.done' },
  migrate: { running: 'run.migrate.running', done: 'run.migrate.done' },
  import: { running: 'run.import.running', done: 'run.import.done' },
  rollback: { running: 'run.rollback.running', done: 'run.rollback.done' },
  tidy: { running: 'run.tidy.running', done: 'run.tidy.done' },
  retitle: { running: 'run.retitle.running', done: 'run.retitle.done' },
}

/**
 * 状态窗的标题：跑着说"正在做什么"，跑完说"做完了"，没成说"没做成"。
 *
 * @param run 当下这一趟。
 * @param t 翻译函数。
 * @returns 标题。
 */
export function runTitle(run: RunState, t: Translate): string {
  if (run.done === null) return t(RUN_TITLES[run.kind].running)
  return run.done.ok ? t(RUN_TITLES[run.kind].done) : t('run.failed')
}

/**
 * 状态栏那一格的短标签：跑着说"正在做什么 + 到第几条"，跑完说"做完了 / 没做成"。
 *
 * 与弹窗标题同一套词：状态栏那一格是这扇窗的入口，两处说法不一致时用户会以为是两件事。
 *
 * @param run 当下这一趟。
 * @param t 翻译函数。
 * @returns 那一格的文案。
 */
export function runChipLabel(run: RunState, t: Translate): string {
  if (run.running) {
    const progress = run.progress
    const total = progress?.total ?? 0
    const done = progress?.done ?? 0
    return total > 0 ? t('run.chip.running', { done, total }) : t(RUN_TITLES[run.kind].running)
  }
  return t(run.done?.ok === true ? RUN_TITLES[run.kind].done : 'run.chip.failed')
}
