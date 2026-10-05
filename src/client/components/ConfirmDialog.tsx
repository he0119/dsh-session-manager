/**
 * 确认弹窗：动作按钮那一下就把「将要发生什么」摆在眼前，用户当场确认或取消。
 *
 * 为什么不是「先点预演、看着页面上的结果、再点一次确认」：那两步之间用户还得回到按钮那一行，而
 * 按钮在卡片另一头；更要紧的是**预演结果落在页面里**时，页面本身会跟着变（迁移页的按钮从"预演迁移"
 * 换成"确认迁移"、结果卡片插在字段下面把下面的内容推走），用户按第二下时看的东西已经不在原位。
 * 弹窗把"将要发生什么"与"确认 / 取消"放进同一个视线范围：算计划、看清单、按确认，三件事在同一块
 * 地方完成；取消就是关掉它，页面回到按之前的样子。
 *
 * 这是本页唯一 require 官方控件库的地方之一（另一处是同步设置里的密码框，见 `SyncConfigForm.tsx`）：
 * 弹窗要 `createPortal` 到 `document.body`，而 `react-dom` **不是**平台基线模块（基线只有 react /
 * react/jsx-runtime / 官方控件库）——所以自己写遮罩层既会被设置外壳的 overflow 裁掉，也得额外申请
 * 一个非基线模块。官方 `Modal` 已经带齐遮罩、Escape、焦点归还与菜单叠层，用它就是最短路径。
 *
 * 本组件只负责"框"：标题、正文、底部那对按钮、四种状态（还在算计划 / 算不出来 / 可以确认 / 正在做）。
 * 正文里摆什么由各分页决定——那里才有端点类型与清单结构。计划由**打开弹窗的分页**去取（而不是本组件
 * 去取），因为"取哪一份计划"是那个动作自己的事：删除取删除计划、迁移取迁移计划、回滚取回滚动作。
 *
 * @module dsh-session-manager/client/ConfirmDialog
 */

import * as React from 'react'

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from '../logic/locales.ts'

export interface ConfirmDialogProps {
  t: Translate
  /** 弹窗标题：说的就是那个动作（「将要删除」）。 */
  title: string
  /** 主按钮文案。 */
  confirmLabel: string
  /** 正在做的时候主按钮显示的那句话（「删除中…」）。 */
  busyLabel: string
  /** 动作正在执行：主按钮换成 `busyLabel`，两个按钮都禁用。 */
  busy: boolean
  /** 计划还在算：正文是一行说明，主按钮禁用。 */
  planning?: boolean
  /**
   * 算计划期间正文里摆什么（缺省是一句「预演中…」）。
   *
   * 给得出具体进度的调用方（同步预演要先扫本机、读远端、逐条比对内容，冷的时候几秒）用进度条顶掉
   * 那句静态说明；删除/迁移这类一次就回来的预演不必给，一句「预演中…」更省事。
   */
  planningDetail?: React.ReactNode
  /** 计划没取到时的原话（宿主或网络层的异常），摆在正文里并禁用主按钮。 */
  error?: string | null
  /**
   * 计划本身不允许落地（宿主说 `ok === false`）：主按钮禁用。
   *
   * 与 `error` 分开：计划算出来了、清单也摆出来了，只是里面有问题（例如"这条会话还活在宿主内存里"），
   * 用户要看到清单与问题清单，而不是一句"失败了"。
   */
  disabled?: boolean
  onConfirm: () => void
  onCancel: () => void
  children?: React.ReactNode
}

/**
 * 确认弹窗。
 *
 * 取消落在两处、语义相同：底部那个「取消」、右上角那个叉、Escape、点遮罩。**取消不做任何写入**——
 * 计划本来就是只读的一次计算（见 `src/migrate.ts` 的 `apply:false`），所以关掉它不会留下半个动作。
 *
 * 初始焦点给「取消」而不是主按钮：确认键按下去是这个弹窗里最重的动作，键盘用户不该因为"对话框一出现
 * 就抢了焦点"而误删。官方 `Modal` 按 `data-modal-autofocus` 认这个标记，并且关闭时会把焦点还给当初
 * 触发它的那个按钮。
 */
export function ConfirmDialog({
  t,
  title,
  confirmLabel,
  busyLabel,
  busy,
  planning = false,
  planningDetail,
  error = null,
  disabled = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps): React.ReactElement {
  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      closeLabel={t('close')}
      className="dsm-dialog"
      contentClassName="dsm-dialogContent"
      footer={
        <>
          <button type="button" className="dsm-button" data-modal-autofocus="" onClick={onCancel} disabled={busy}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className="dsm-button dsm-primary"
            onClick={onConfirm}
            disabled={busy || planning || error !== null || disabled}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      {/* 正文自己再包一层：官方 `.body` 是纵向 flex 但不给块间距，而这里摆的是段落 + 清单 + 表格。 */}
      <div className="dsm-dialogBody">
        {planning && (planningDetail ?? <p className="dsm-hint">{t('dialog.previewing')}</p>)}
        {error !== null && <p className="dsm-error">{error}</p>}
        {children}
      </div>
    </Modal>
  )
}
