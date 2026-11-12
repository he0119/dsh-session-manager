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
  /** 弹窗标题：说的就是这件事（「WebDAV 同步」「备份与回滚」）。 */
  title: string
  /**
   * 标题下面那一行支撑句（官方 `Modal` 的 `description`）。
   *
   * 给这件事的**一个事实**用（同步用的是远端地址）：它属于"你在跟谁说话"，而不是正文里的第一条内容，
   * 所以走这一格，正文从要做的决定开始。
   */
  description?: string
  /**
   * 宽度按**里面装什么**选：
   * - `wide`（缺省，1080）：里面是表或清单（备份那一份）；
   * - `narrow`（640）：里面是几句话加一排按钮（同步那一面）——正文铺到一千像素，一句话拉到两行半，
   *   读起来比窄的费劲。
   */
  size?: 'wide' | 'narrow'
  /** 关掉它：清掉这一件事的本地草稿，回到列表。 */
  onClose: () => void
  children: React.ReactNode
}

/** 宽弹窗外壳。 */
export function WorkDialog({
  t,
  title,
  description,
  size = 'wide',
  onClose,
  children,
}: WorkDialogProps): React.ReactElement {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      {...(description === undefined ? {} : { description })}
      closeLabel={t('close')}
      // 窄的那一档就是确认弹窗那枚宽度（640）：两边都用同一个类，别为"窄一点的宽弹窗"再造一档。
      className={size === 'wide' ? 'dsm-dialog dsm-workDialog' : 'dsm-dialog'}
      contentClassName="dsm-dialogContent"
    >
      {/*
        块间距挂在**正文自己那一层**上，而不是 `contentClassName` 上：那个类落在官方弹窗最外面那层，
        里面依次是标题、说明（`description`）、正文——把 gap 写在那儿，标题与说明、说明与正文之间也会
        各多出一段，看着就是"标题下面空一块"。包一层之后 16px 只管正文里的那些块。
      */}
      <div className="dsm-workBody">{children}</div>
    </Modal>
  )
}
