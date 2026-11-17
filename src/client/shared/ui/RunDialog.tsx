// src/client/shared/ui/RunDialog.tsx — 「正在做 → 做完了」那一扇窗：进度、转到后台、结果、完成。
//
// 六个会写入磁盘的动作（删除、迁移、导入、恢复、整理远端、重算名称）共用这一扇，形状只有一种：
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

import type { SessionManagerKey, Translate } from '../i18n/locales.ts'
import { backgroundRun, dismissRun, getRun, openRunDialog, subscribeRun } from '../../operations/manage/runJob.ts'
import { RUN_TITLES, runChipLabel, runTitle } from '../../operations/manage/runLabel.ts'
import { ProgressBlock } from './ProgressBlock.tsx'

/**
 * 跑着的时候进度块下面补的那句话：这件事写到一半被打断会怎样、后悔面在哪。
 *
 * 同一份说明原先挂在确认弹窗的进度块上（那时确认弹窗兼做进度窗）；现在进度窗是这一扇，说明跟着搬过来。
 * 「整理远端」「重算名称」没有写本机的库，也就没有这句话要说。
 */
const NOTES: Readonly<Record<string, SessionManagerKey>> = {
  delete: 'manage.delete.progress.note',
  migrate: 'migrate.progress.note',
  import: 'import.progress.note',
  rollback: 'backup.progress.note',
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

  const titles = RUN_TITLES[run.kind]
  const done = run.done
  const title = runTitle(run, t)

  return (
    <Modal
      open
      // 跑着的时候关窗＝转后台（活儿不停）；跑完关窗＝取走结论。两件事都不该让用户以为"取消了"。
      onClose={done === null ? backgroundRun : dismissRun}
      title={title}
      closeLabel={t('close')}
      // 宽度跟着发起它的那一面走（见 runJob.RunState.wide）：一条流程一个宽度，中途不换。
      className={run.wide ? 'dsm-dialog dsm-workDialog' : 'dsm-dialog'}
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
      <div className={run.wide ? 'dsm-workBody' : 'dsm-dialogBody'}>
        {done === null ? (
          run.progress === null ? (
            <p className="dsm-hint">{t('run.preparing')}</p>
          ) : (
            <ProgressBlock
              t={t}
              progress={run.progress}
              {...(NOTES[run.kind] === undefined ? {} : { note: t(NOTES[run.kind]) })}
            />
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
 * 单独一个组件是为了让它自己持有订阅：页面外壳那边不必再多一个状态位（那几个状态位在冒烟测试的示例数据里是
 * 按顺序初始值的，多一个就会把后面种错位）。
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
