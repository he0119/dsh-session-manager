/**
 * 「会话」页右栏：一条会话的详情与单条动作。
 *
 * 左边选中哪一条、这里就显示哪一条：标题、分类标签、项目与目录、创建时间、大小、会话 id，
 * 以及三枚动作——打开完整内容、归档 / 取消归档、勾选 / 取消勾选这一条。
 *
 * 为什么不是"点行就跳弹窗"：宽屏上右栏一直摆着（没选时是一句提示），选中一条只是换右栏的内容，
 * 列表不跳走；完整时间线仍留在弹窗里，由右栏那枚「打开完整内容」打开——两件事分开之后，"快速看
 * 一眼"不再要把整份日志读进弹窗。
 *
 * 窄屏（工作台可用宽 ≤1180px）右栏收成从右边滑出的浮层，没选会话时整栏不出现；宽窄是同一份 DOM。
 *
 * @module dsh-session-manager/client/SessionInspector
 */

import * as React from 'react'

import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from '../logic/locales.ts'
import { sessionLabel } from '../logic/planRows.ts'
import { formatBytes, formatTime, sessionTags, type RowSession } from './sessionList.tsx'

export interface SessionInspectorProps {
  t: Translate
  /** 右栏正开着的那一条；`null` = 还没选（宽屏显示提示，窄屏整栏不出现）。 */
  session: RowSession | null
  /** 这一条的归属称呼（与列表「项目」那一格同一份）。 */
  projectName: string
  /** 父会话的称呼（子智能体才有）；找不到时退回 id。 */
  parentTitle?: string
  /** 这条会话日志目录里有几个文件（`/state` 给的那份）。 */
  fileCount?: number
  /** 这一条是否已勾选（决定第三枚动作的文案）。 */
  checked: boolean
  archiveAvailable: boolean
  busy: boolean
  /** 这一条不能单独勾时的原因（子智能体跟着父会话走）。 */
  lockedTip?: string
  onClose: () => void
  onTranscript: () => void
  onArchive: () => void
  onPick: () => void
}

/**
 * 右栏本体。
 *
 * @param props 当前会话、归属与三枚动作。
 * @returns 卡片（宽屏是右栏，窄屏是浮层）。
 */
export function SessionInspector({
  t,
  session,
  projectName,
  parentTitle,
  fileCount,
  checked,
  archiveAvailable,
  busy,
  lockedTip,
  onClose,
  onTranscript,
  onArchive,
  onPick,
}: SessionInspectorProps): React.ReactElement {
  const empty = session === null
  const label = session === null ? null : sessionLabel(session)
  const tags = session === null ? [] : sessionTags(session, { ungrouped: true })

  return (
    <aside
      id="dsm-inspector"
      className="dsm-card dsm-inspector"
      data-empty={empty ? 'true' : 'false'}
      aria-label={t('manage.detail.title')}
    >
      <div className="dsm-cardHead">
        <span className="dsm-cardTitle">{t('manage.detail.title')}</span>
        <span className="dsm-spacer" />
        {!empty && (
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('close')}
          </Button>
        )}
      </div>

      {session === null || label === null ? (
        <div className="dsm-inspectorEmpty">
          <p className="dsm-inspectorEmptyTitle">{t('manage.detail.empty.title')}</p>
          <p className="dsm-hint">{t('manage.detail.empty.hint')}</p>
        </div>
      ) : (
        <div className="dsm-inspectorBody">
          <h3 className="dsm-inspectorName" title={label.tip}>
            {label.text}
          </h3>
          {tags.length > 0 && (
            <div className="dsm-inspectorTags">
              {tags.map((tag) => (
                <span key={tag.key} className="dsm-tag" title={t(tag.tip)}>
                  <Tag tone="neutral">{t(tag.key)}</Tag>
                </span>
              ))}
            </div>
          )}

          <dl className="dsm-facts">
            <dt>{t('manage.detail.project')}</dt>
            <dd title={session.cwd ?? ''}>{projectName}</dd>
            <dt>{t('manage.detail.dir')}</dt>
            <dd title={session.cwd ?? ''}>{session.cwd === undefined || session.cwd === '' ? '—' : session.cwd}</dd>
            <dt>{t('manage.detail.created')}</dt>
            <dd>{formatTime(session.createdAt)}</dd>
            <dt>{t('manage.detail.size')}</dt>
            <dd>
              {formatBytes(session.bytes)}
              {fileCount === undefined ? '' : ` · ${t('manage.detail.files', { count: fileCount })}`}
            </dd>
            <dt>{t('manage.detail.id')}</dt>
            <dd className="dsm-inspectorId">{session.id}</dd>
            {session.parentSession !== undefined && (
              <>
                <dt>{t('manage.detail.parent')}</dt>
                <dd title={parentTitle ?? session.parentSession}>{parentTitle ?? session.parentSession}</dd>
              </>
            )}
          </dl>

          <div className="dsm-inspectorActions">
            <Button
              variant="primary"
              size="sm"
              title={t('manage.detail.transcriptTip')}
              onClick={onTranscript}
            >
              {t('manage.detail.transcript')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !archiveAvailable}
              onClick={onArchive}
            >
              {session.archived === true ? t('manage.detail.unarchive') : t('manage.detail.archive')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={lockedTip !== undefined}
              title={lockedTip}
              onClick={onPick}
            >
              {checked ? t('manage.detail.unpick') : t('manage.detail.pick')}
            </Button>
          </div>
        </div>
      )}
    </aside>
  )
}
