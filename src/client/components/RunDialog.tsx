// src/client/components/RunDialog.tsx — 「正在做 → 做完了」那一扇窗：进度、转到后台、结果、完成。
//
// 六个会写盘的动作（删除、迁移、导入、恢复、整理远端、重算名称）共用这一扇，形状只有一种：
//
//   跑着：标题「正在删除」+ 进度块，底栏「转到后台」与一枚按不动的动作键；
//   跑完：标题「删除完成」+ 结果（一句话 + 需要说的话），底栏只剩「完成」。
//
// 为什么不再让确认弹窗兼着做进度窗：确认弹窗的底栏是「取消 / 确认」——执行中那两枚只能是禁用的，
// 用户看着两枚死按钮，做完整个窗口又当场消失，结果跑到页面顶部的一条横幅里。确认、执行、结果三件事
// 各自该有自己的窗口（见 design.md 的「执行与结果」那一节）。
//
// 执行中关窗（✕ 或「转到后台」）不算取消：活儿在宿主那边继续跑，状态栏那一格接着报进度，点回去还是
// 这一扇窗。真正的取消这一版没有（宿主的几个接口都不支持中途停）。
import * as React from 'react'

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SessionManagerKey, Translate } from '../logic/locales.ts'
import { backgroundRun, dismissRun, getRun, openRunDialog, subscribeRun } from '../logic/runJob.ts'
import { ProgressBlock } from './ProgressBlock.tsx'

/** 每一件事的标题怎么说（跑着 / 跑完 / 没做成）。 */
const TITLES: Readonly<Record<string, { running: SessionManagerKey; done: SessionManagerKey }>> = {
  delete: { running: 'run.delete.running', done: 'run.delete.done' },
  migrate: { running: 'run.migrate.running', done: 'run.migrate.done' },
  import: { running: 'run.import.running', done: 'run.import.done' },
  rollback: { running: 'run.rollback.running', done: 'run.rollback.done' },
  tidy: { running: 'run.tidy.running', done: 'run.tidy.done' },
  retitle: { running: 'run.retitle.running', done: 'run.retitle.done' },
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
export function runChipLabel(run: NonNullable<ReturnType<typeof getRun>>, t: Translate): string {
  const titles = TITLES[run.kind] ?? TITLES['delete']!
  if (run.running) {
    const progress = run.progress
    const total = progress?.total ?? 0
    const done = progress?.done ?? 0
    return total > 0 ? t('run.chip.running', { done, total }) : t(titles.running)
  }
  return t(run.done?.ok === true ? titles.done : 'run.chip.failed')
}

/**
 * 状态窗本身：跑着是进度，跑完是结果；底栏在「转到后台」与「完成」之间换。
 *
 * @param props.t 翻译函数。
 * @returns 弹窗；没有在跑、也没有未取走的结论时返回 `null`。
 */
export function RunDialog({ t }: { t: Translate }): React.ReactElement | null {
  const [run, setRun] = React.useState(getRun())
  React.useEffect(() => subscribeRun(() => setRun(getRun())), [])
  if (run === null || !run.dialog) return null

  const titles = TITLES[run.kind] ?? TITLES['delete']!
  const done = run.done
  const title = done === null ? t(titles.running) : done.ok ? t(titles.done) : t('run.failed')

  return (
    <Modal
      open
      // 跑着的时候关窗＝转后台（活儿不停）；跑完关窗＝取走结论。两件事都不该让用户以为"取消了"。
      onClose={done === null ? backgroundRun : dismissRun}
      title={title}
      closeLabel={t('close')}
      className="dsm-dialog"
      contentClassName="dsm-dialogContent"
      footer={
        <>
          {done === null ? (
            <>
              <Button variant="outline" className="dsm-dialogAction" onClick={backgroundRun}>
                {t('run.background')}
              </Button>
              <Button variant="primary" className="dsm-dialogConfirm" disabled>
                {t(titles.running)}
              </Button>
            </>
          ) : (
            <Button variant="primary" className="dsm-dialogConfirm" data-modal-autofocus="" onClick={dismissRun}>
              {t('run.finish')}
            </Button>
          )}
        </>
      }
    >
      <div className="dsm-dialogBody">
        {done === null ? (
          run.progress === null ? (
            <p className="dsm-hint">{t('run.preparing')}</p>
          ) : (
            <ProgressBlock t={t} progress={run.progress} />
          )
        ) : (
          run.render(done)
        )}
      </div>
    </Modal>
  )
}

/**
 * 状态栏那一格：跑着报进度、跑完报结论；点一下回到那扇窗（就是「转到后台」之后找回来的入口）。
 *
 * 单独一个组件是为了让它自己持有订阅：页面骨架那边不必再多一个状态位（那几个状态位在冒烟夹具里是
 * 按顺序种值的，多一个就会把后面种错位）。
 *
 * @param props.t 翻译函数。
 * @returns 那一格；没有在跑、也没有未取走的结论时不渲染。
 */
export function RunChip({ t }: { t: Translate }): React.ReactElement | null {
  const [run, setRun] = React.useState(getRun())
  React.useEffect(() => subscribeRun(() => setRun(getRun())), [])
  if (run === null || run.dialog) return null
  return (
    <Button
      className="dsm-statusAction dsm-statusJob"
      variant="outline"
      size="sm"
      aria-haspopup="dialog"
      onClick={openRunDialog}
    >
      {runChipLabel(run, t)}
    </Button>
  )
}
