/**
 * 「会话管理」页上的宽弹窗：导出 / 导入、同步、备份与回滚三件事共用的外壳。
 *
 * 为什么这三件事不再各占一个页签：页签把"你在哪一页"摆在"你要对哪些会话做什么"前面，勾选只在
 * 「会话」页有效，切到别的页签再想导出就得重新勾一遍。它们本来就是"对同一个库做一件事"，做完就走；
 * 弹窗把这件事限制在"打开 → 看计划 → 确认 → 关掉"这一条线上，关掉就回到列表，勾选与滚动位置都还在。
 *
 * 为什么宽度是 1080（`.dsm-workDialog`）而不是一般确认弹窗的 640：传输那两栏（导出清单 + 导入字段）
 * 与同步的计划表都是按 1080 量出来的宽度，塞进 640 会折行；1080 也是原来这三页在页面上的可读宽度，
 * 搬进弹窗之后一个字都不用重排。窄窗口下 `min(1080px, 100%)` 自己收窄，传输那两栏靠它自己的容器
 * 查询叠回一列（见 styles.ts 的 `.dsm-transferGrid`）。
 *
 * 正文层用 `.dsm-workBody`（整页那档 16px 块间距）：面板内部还是原来那套"横幅 + 卡片"的节奏，
 * 不换一档间距就等于不改它们的摆放。
 *
 * @module dsh-session-manager/client/WorkDialog
 */

import * as React from 'react'

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from '../logic/locales.ts'

export interface WorkDialogProps {
  t: Translate
  /** 弹窗标题：说的就是这件事（「导出 / 导入」「WebDAV 同步」「备份与回滚」）。 */
  title: string
  /** 关掉它：清掉这一件事的本地草稿，回到列表。 */
  onClose: () => void
  children: React.ReactNode
}

/** 宽弹窗外壳。 */
export function WorkDialog({ t, title, onClose, children }: WorkDialogProps): React.ReactElement {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('close')}
      className="dsm-dialog dsm-workDialog"
      contentClassName="dsm-dialogContent dsm-workBody"
    >
      {children}
    </Modal>
  )
}
