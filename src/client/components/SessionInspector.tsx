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
 * 窄屏（工作台可用宽 ≤1180px）右栏收成从右边滑出的浮动面板，没选会话时整栏不出现；宽窄是同一份 DOM。
 *
 * @module dsh-session-manager/client/SessionInspector
 */

import * as React from 'react'

import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import { Hint } from './Hint.tsx'

import { fetchTranscript } from '../api.ts'
import type { Translate } from '../logic/locales.ts'
import { sessionLabel } from '../logic/planRows.ts'
import { previewTurns, type PreviewTurn } from '../logic/preview.ts'
import { formatBytes, formatTime, sessionTags, type RowSession } from './sessionList.tsx'

/** 右栏开头那一段的取数状态。`id` 与当前会话不同时说明还在等新的那一条。 */
interface PreviewState {
  id: string | null
  loading: boolean
  error: boolean
  turns: PreviewTurn[]
}

const EMPTY_PREVIEW: PreviewState = { id: null, loading: false, error: false, turns: [] }

/** 开头取多少条事件：两轮对话通常远小于这个数；再多就是工具调用的长尾。 */
const PREVIEW_EVENTS = 240

/** 每格文字的上限（与 CSS 的四行截断一起用，先让网络那一侧小下来）。 */
const PREVIEW_CHARS = 600

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
 * @returns 卡片（宽屏是右栏，窄屏是浮动面板）。
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

  /**
   * 开头两轮：选中一条才读，读的是 `/transcript` 的第一页（不是整份日志）。
   *
   * 同一页里选来选去时不重复读：读到过的结果按会话 id 留在这个组件里；宿主那侧还有日志解压缓存，
   * 所以第二次选同一条连解析都省了。读失败不写缓存，下次选中会再试。
   */
  const [preview, setPreview] = React.useState<PreviewState>(EMPTY_PREVIEW)
  const previewCache = React.useRef(new Map<string, PreviewState>())
  const sessionId = session?.id ?? null
  React.useEffect(() => {
    if (sessionId === null) {
      setPreview(EMPTY_PREVIEW)
      return
    }
    const cached = previewCache.current.get(sessionId)
    if (cached !== undefined) {
      setPreview(cached)
      return
    }
    let cancelled = false
    setPreview({ id: sessionId, loading: true, error: false, turns: [] })
    void fetchTranscript(sessionId, { limit: PREVIEW_EVENTS, maxChars: PREVIEW_CHARS })
      .then((page) => {
        const next: PreviewState = {
          id: sessionId,
          loading: false,
          error: false,
          turns: previewTurns(page.items, undefined, page.nextCursor !== undefined),
        }
        previewCache.current.set(sessionId, next)
        if (!cancelled) setPreview(next)
      })
      .catch(() => {
        if (!cancelled) setPreview({ id: sessionId, loading: false, error: true, turns: [] })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

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
          <Hint text={label.tip}>
            <h3 className="dsm-inspectorName">{label.text}</h3>
          </Hint>
          {tags.length > 0 && (
            <div className="dsm-inspectorTags">
              {tags.map((tag) => (
                <Hint key={tag.key} text={t(tag.tip)}>
                  <span className="dsm-tag">
                    <Tag tone="neutral">{t(tag.key)}</Tag>
                  </span>
                </Hint>
              ))}
            </div>
          )}

          <div className="dsm-preview">
            <div className="dsm-previewHead">{t('manage.detail.preview')}</div>
            {preview.id !== session.id || preview.loading ? (
              <p className="dsm-hint">{t('manage.detail.previewLoading')}</p>
            ) : preview.error ? (
              <p className="dsm-hint">{t('manage.detail.previewError')}</p>
            ) : preview.turns.length === 0 ? (
              <p className="dsm-hint">{t('manage.detail.previewEmpty')}</p>
            ) : (
              <>
                {preview.turns.map((turn) => (
                  <div key={turn.turn} className="dsm-previewTurn">
                    <div className="dsm-previewLabel">
                      {t('manage.transcript.turn', { turn: turn.turn })}
                    </div>
                    {turn.user !== null && (
                      <div className="dsm-previewRow">
                        <span className="dsm-previewWho">{t('manage.detail.previewUser')}</span>
                        <p className="dsm-previewText">{turn.user}</p>
                      </div>
                    )}
                    {turn.answer !== null ? (
                      <div className="dsm-previewRow">
                        <span className="dsm-previewWho">{t('manage.detail.previewAnswer')}</span>
                        <p className="dsm-previewText">{turn.answer}</p>
                      </div>
                    ) : (
                      <p className="dsm-hint">{t('manage.detail.previewNoAnswer')}</p>
                    )}
                  </div>
                ))}
                <p className="dsm-hint">{t('manage.detail.previewNote')}</p>
              </>
            )}
          </div>

          <dl className="dsm-facts">
            <dt>{t('manage.detail.project')}</dt>
            <Hint text={session.cwd ?? ''}>
              <dd>{projectName}</dd>
            </Hint>
            <dt>{t('manage.detail.dir')}</dt>
            <Hint text={session.cwd ?? ''}>
              <dd>{session.cwd === undefined || session.cwd === '' ? '—' : session.cwd}</dd>
            </Hint>
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
                <Hint text={parentTitle ?? session.parentSession}>
                  <dd>{parentTitle ?? session.parentSession}</dd>
                </Hint>
              </>
            )}
          </dl>
        </div>
      )}

      {session !== null && label !== null && (
        <div className="dsm-inspectorActions">
          <Hint text={t('manage.detail.transcriptTip')}>
            <Button variant="primary" size="sm" onClick={onTranscript}>
              {t('manage.detail.transcript')}
            </Button>
          </Hint>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !archiveAvailable}
            onClick={onArchive}
          >
            {session.archived === true ? t('manage.detail.unarchive') : t('manage.detail.archive')}
          </Button>
          <Hint text={lockedTip}>
            <Button variant="outline" size="sm" disabled={lockedTip !== undefined} onClick={onPick}>
              {checked ? t('manage.detail.unpick') : t('manage.detail.pick')}
            </Button>
          </Hint>
        </div>
      )}
    </aside>
  )
}
