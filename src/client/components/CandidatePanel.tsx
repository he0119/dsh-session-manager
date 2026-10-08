/**
 * 候选目录面板：目录字段那枚值控件点开的那一份列表。
 *
 * 为什么不是原生下拉框：候选是"有多少个工作区就有多少条"（迁移页的来源还会加上库里有会话的目录与
 * 「未分组」），原生下拉框只能一行行滚着找、也写不进筛选词。面板与页面内的目录浏览框
 * （[DirectoryPicker.tsx](./DirectoryPicker.tsx)）是同一套皮、同一个列表：一边是"从候选里挑"，
 * 一边是"去文件系统里找"，两件事在同一处收口，所以两边各有一枚按钮切过去（那枚按钮只在宿主提供
 * 了目录选择器时才出现，见 `onFilesystem`）。
 *
 * **点一行就是选中**（随即关掉面板）：这里挑的是"要用的那个目录"，没有第二步要确认的东西——真正的
 * 确认在「迁移」那个弹窗里（计划 + 数量，见 [MigrationPanel.tsx](./MigrationPanel.tsx)）。
 *
 * 数据是调用方算好的候选行（含条数），这里不查任何东西、也不拼路径。
 *
 * @module dsh-session-manager/client/CandidatePanel
 */

import * as React from 'react'

import { candidateRow, filterPathRows, type PathRow } from '../logic/planRows.ts'
import type { Translate } from '../logic/locales.ts'

/** 入参。 */
export interface CandidatePanelProps {
  /** 注入面给的翻译函数。 */
  t: Translate
  /** 面板标题：就是它所在那个字段的名字（源目录 / 目标目录）。 */
  label: string
  /** 候选行（调用方已经补过当前值）。 */
  rows: readonly PathRow[]
  /** 当前值：只是拿来让"现在用的是哪个"在列表里对得上，面板不改它。 */
  value: string
  /** 用户点了某一行：选中它（随即关掉面板）。 */
  onPick: (path: string) => void
  /** 关掉面板（不改变值）。 */
  onClose: () => void
  /**
   * 切到宿主的文件系统那条路（页面内浏览框或系统对话框，由宿主的能力种类决定）。
   *
   * 宿主没有目录选择器时缺省 = 不摆这枚按钮：不摆一个点了必然报错的按钮（同
   * [「浏览…」按宿主的能力走](../../../.agents/notes/implemented/bug-fix/2026-09-27-browse-follows-the-picker-capability.md)）。
   */
  onFilesystem?: () => void
}

/** 候选目录面板。 */
export function CandidatePanel({
  t,
  label,
  rows,
  value,
  onPick,
  onClose,
  onFilesystem,
}: CandidatePanelProps): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const listed = React.useMemo(() => filterPathRows(rows, query), [rows, query])

  return (
    <div className="dsm-browser dsm-candidatePicker">
      <div className="dsm-browserHead">
        <span className="dsm-fieldLabel">{label}</span>
        <span className="dsm-spacer" />
        {onFilesystem !== undefined && (
          <button type="button" className="dsm-button" onClick={onFilesystem}>
            {t('dirPicker.filesystem')}
          </button>
        )}
        <button type="button" className="dsm-button" onClick={onClose}>
          {t('cancel')}
        </button>
      </div>

      <input
        className="dsm-search dsm-candidateFilter"
        type="search"
        value={query}
        placeholder={t('pathField.filter')}
        aria-label={t('pathField.filter')}
        onChange={(event) => setQuery(event.target.value)}
      />

      {listed.length === 0 ? (
        <p className="dsm-empty">{t('pathField.noMatch')}</p>
      ) : (
        <div className="dsm-list dsm-dirList dsm-candidateList">
          {listed.map((row) => {
            const copy = candidateRow(row, t)
            return (
              <button
                key={row.path}
                type="button"
                className="dsm-dirEntry dsm-candidate"
                title={copy.tip}
                aria-current={row.path === value ? 'true' : undefined}
                onClick={() => onPick(row.path)}
              >
                <span className="dsm-candidateName">{copy.name}</span>
                {copy.meta !== undefined && <span className="dsm-hint dsm-candidateMeta">{copy.meta}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
