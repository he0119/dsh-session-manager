/**
 * 会话内容视图：把一份会话日志逐条摆出来。
 *
 * 这一页**不经过宿主**：解析在插件自己的核心层（`src/transcript.ts`），所以侧边栏看不见的那些会话
 * ——空会话、孤儿目录、已归档、子智能体、从别的工具导进来的——一样能看。代价是"完整"得自己守：日志里
 * 什么都有（6 MB 的会话、100 KB 的工具输出、读不出来的坏行），所以这里按事件位分页（一次 80 条起步，
 * 「加载更多」往下接），被截断的条目单独给一个「看全文」按钮，按 `index` 把那一格原文取回来盖掉。
 *
 * 三个取舍写在明面上：
 *
 * 1. **一条事件一行**（与核心层一致）：`seq` 只当显示，游标用 `index`——日志里的 `seq` 会跳号（实测
 *    有 4 → 6 这种），拿它当游标会漏条。
 * 2. **思考与正文分格**：助手的 `reasoning` 折在 `<details>` 里（默认收起），正文直接摆出来——"完整"
 *    不等于"一屏塞满"，但折起来的东西一眼看得出还在那儿。
 * 3. **筛选只影响显示，不影响加载**：筛「工具」时不改变"已经读到第几条"，也不改变「加载更多」的语义
 *    ——换筛选条件不该让用户重新等一次网络。
 *
 * @module dsh-session-manager/client/TranscriptDialog
 */

import * as React from 'react'

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import { fetchTranscript, type TranscriptFacts, type TranscriptResponse } from '../api.ts'
// 会话行的时刻格式与这里必须是同一份（同一套 "YYYY-MM-DD HH:mm"），所以复用列表那个导出。
import { formatTime } from './sessionList.tsx'
import type { TranscriptItem, TranscriptKind } from '../../transcript.ts'
import { shouldLoadMore } from '../logic/transcriptScroll.ts'
import type { SessionManagerKey, Translate } from '../logic/locales.ts'

/** 一个筛选键：它对应哪几类条目。 */
export type TranscriptFilterKey = 'all' | 'human' | 'model' | 'tool' | 'other'

/** 每类条目在筛选里归哪一组。 */
const FILTER_OF: Record<TranscriptKind, Exclude<TranscriptFilterKey, 'all'>> = {
  user: 'human',
  assistant: 'model',
  reasoning: 'model',
  'tool-call': 'tool',
  'tool-result': 'tool',
  system: 'other',
  event: 'other',
}

/** 条目种类 → 文案键。 */
const KIND_KEY: Record<TranscriptKind, SessionManagerKey> = {
  user: 'manage.transcript.kind.user',
  assistant: 'manage.transcript.kind.assistant',
  reasoning: 'manage.transcript.kind.reasoning',
  'tool-call': 'manage.transcript.kind.toolCall',
  'tool-result': 'manage.transcript.kind.toolResult',
  system: 'manage.transcript.kind.system',
  event: 'manage.transcript.kind.event',
}

/** 筛选条上那几枚芯片的顺序与文案键。 */
const FILTERS: Array<{ key: TranscriptFilterKey; label: SessionManagerKey }> = [
  { key: 'all', label: 'manage.transcript.filter.all' },
  { key: 'human', label: 'manage.transcript.filter.human' },
  { key: 'model', label: 'manage.transcript.filter.model' },
  { key: 'tool', label: 'manage.transcript.filter.tool' },
  { key: 'other', label: 'manage.transcript.filter.other' },
]

/** 「看全文」时单条格子的上限：日志里最大的一条工具输出实测 100 KB 上下，这个额度够它落地。 */
const FULL_ITEM_CHARS = 400_000

/** 时刻：只给到时、分、秒（内容视图里日期没意义，会话的建立时间摆在上面）。 */
function clockOf(time: number | undefined): string {
  if (time === undefined) return ''
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export interface TranscriptDialogProps {
  /** 看哪条会话（用 `id` 取内容，`title` 只用来当标题的兜底）。 */
  session: { id: string; title?: string }
  onClose: () => void
  t: Translate
}

/**
 * 内容视图本体。
 *
 * 打开即读第一页；之后正文滚到贴底就按 `nextCursor` 自己往下接（缺席就是读完了）。第一页撑不满
 * 一屏时没有"滚到底"这个动作可用，所以读完每一页之后还要复查一次（见 `shouldLoadMore()`）。
 * 任何一次读取失败都只把错误摆出来、**不关掉已经读到的部分**——读到一半失败时用户手上那些内容
 * 没有理由消失。
 */
export function TranscriptDialog({ session, onClose, t }: TranscriptDialogProps): React.ReactElement {
  const [items, setItems] = React.useState<TranscriptItem[]>([])
  const [page, setPage] = React.useState<TranscriptResponse | null>(null)
  const [facts, setFacts] = React.useState<TranscriptFacts | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [filter, setFilter] = React.useState<TranscriptFilterKey>('all')
  const list = React.useRef<HTMLDivElement | null>(null)

  const load = React.useCallback(
    async (from: number): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const next = await fetchTranscript(session.id, { from })
        setItems((current) => (from === 0 ? next.items : [...current, ...next.items]))
        setPage(next)
        setFacts(next.session)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [session.id],
  )

  React.useEffect(() => {
    void load(0)
  }, [load])

  const hasMore = page?.nextCursor !== undefined

  /**
   * 滚动区是官方给正文用的那一层（`contentClassName` 就落在它上面），列表自己不滚。
   *
   * 官方那个正文层本来就是"唯一那个滚动区"（`RiskConfirmation` 也这么用）：再往里套一层自己的滚动区
   * 会出现两条滚动条，而且内层那份按视口算的 `max-height` 会被卡片的 `overflow: hidden` 裁掉一截。
   */
  const scroller = React.useCallback(
    (): HTMLElement | null => list.current?.closest<HTMLElement>('.dsm-dialogContent') ?? null,
    [],
  )

  const loadMore = React.useCallback((): void => {
    if (page?.nextCursor === undefined) return
    void load(page.nextCursor)
  }, [load, page])

  // 滚到底就接下一页。`scroll` 不冒泡，所以这条监听挂在滚动区本体上，不走 React 的 onScroll。
  React.useEffect(() => {
    const element = scroller()
    if (element === null) return
    const onScroll = (): void => {
      if (shouldLoadMore(element, hasMore, busy)) loadMore()
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [busy, hasMore, loadMore, scroller])

  // 读完每一页复查一次：还够不着底、又还有下一页，就自己接上（否则那一页之后再也没有下一步）。
  React.useEffect(() => {
    const element = scroller()
    if (element === null) return
    if (shouldLoadMore(element, hasMore, busy)) loadMore()
  }, [busy, hasMore, items, loadMore, scroller])

  /** 把被截断的那一格原文取回来，盖掉列表里那一条（其余条目不动）。 */
  const showFull = React.useCallback(
    async (item: TranscriptItem): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const single = await fetchTranscript(session.id, {
          from: item.index,
          limit: 1,
          maxChars: FULL_ITEM_CHARS,
        })
        const replacement = single.items[0]
        if (replacement === undefined) throw new Error(t('manage.transcript.gone'))
        setItems((current) => current.map((one) => (one.index === item.index ? replacement : one)))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [session.id, t],
  )

  const shown = filter === 'all' ? items : items.filter((item) => FILTER_OF[item.kind] === filter)
  const counts = page?.counts
  let lastTurn: number | undefined

  return (
    <Modal
      open
      onClose={onClose}
      title={t('manage.transcript.title')}
      closeLabel={t('close')}
      className="dsm-dialog dsm-transcript"
      contentClassName="dsm-dialogContent dsm-transcriptContent"
    >
      <div className="dsm-transcriptFacts">
        <div className="dsm-transcriptName" title={session.id}>
          {facts?.title ?? session.title ?? session.id}
        </div>
        <div className="dsm-defs dsm-transcriptFactsGrid">
          <dt>{t('manage.transcript.fact.session')}</dt>
          <dd className="dsm-path">{session.id}</dd>
          <dt>{t('manage.transcript.fact.cwd')}</dt>
          <dd className="dsm-path">{facts?.cwd ?? '—'}</dd>
          <dt>{t('manage.transcript.fact.created')}</dt>
          <dd>{facts === null ? '—' : formatTime(facts.createdAt)}</dd>
          <dt>{t('manage.transcript.fact.file')}</dt>
          <dd className="dsm-path">
            {facts === null
              ? '—'
              : `${facts.file}（${t('manage.transcript.fact.generation', { generation: facts.generation, generations: facts.generations })}）`}
          </dd>
        </div>
        {counts !== undefined && (
          <div className="dsm-hint">
            {t('manage.transcript.counts', {
              events: counts.events,
              human: counts.human,
              assistant: counts.assistant,
              toolCalls: counts.toolCalls,
              toolResults: counts.toolResults,
            })}
          </div>
        )}
        {page !== null && page.problemCount > 0 && (
          <div className="dsm-hint dsm-warn">
            {t('manage.transcript.problems', {
              count: page.problemCount,
              lines: page.problems.map((problem) => problem.line).join('、'),
            })}
          </div>
        )}
      </div>

      <div className="dsm-transcriptFilters">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={`dsm-chip${filter === entry.key ? ' dsm-chipOn' : ''}`}
            onClick={() => setFilter(entry.key)}
          >
            {t(entry.label)}
          </button>
        ))}
        <span className="dsm-spacer" />
        <span className="dsm-meta">
          {t('manage.transcript.shown', { shown: shown.length, loaded: items.length })}
        </span>
      </div>

      {error !== null && <div className="dsm-error">{error}</div>}

      <div
        ref={list}
        className="dsm-transcriptList"
        tabIndex={0}
        data-modal-autofocus=""
      >
        {items.length === 0 && busy && <div className="dsm-hint">{t('manage.transcript.loading')}</div>}
        {page !== null && page.totalEvents === 0 && <div className="dsm-hint">{t('manage.transcript.empty')}</div>}
        {shown.map((item) => {
          const turnHead = item.turn !== undefined && item.turn !== lastTurn ? item.turn : undefined
          if (turnHead !== undefined) lastTurn = turnHead
          return (
            <React.Fragment key={item.index}>
              {turnHead !== undefined && (
                <div className="dsm-turn">{t('manage.transcript.turn', { turn: turnHead })}</div>
              )}
              <div className={`dsm-item dsm-item-${item.kind}`}>
                <div className="dsm-itemHead">
                  <span className="dsm-itemKind">{t(KIND_KEY[item.kind])}</span>
                  {item.name !== undefined && <span className="dsm-itemName">{item.name}</span>}
                  {item.isError === true && <span className="dsm-tag dsm-tagIdle dsm-warn">{t('manage.transcript.errorTag')}</span>}
                  {item.synthetic === true && (
                    <span className="dsm-tag dsm-tagIdle">{t('manage.transcript.synthetic')}</span>
                  )}
                  <span className="dsm-spacer" />
                  {item.time !== undefined && <span className="dsm-meta">{clockOf(item.time)}</span>}
                  {item.seq !== undefined && <span className="dsm-meta">seq {item.seq}</span>}
                  <span className="dsm-meta dsm-path">{item.type}</span>
                </div>
                {item.reasoning !== undefined && (
                  <details className="dsm-itemBody">
                    <summary>{t('manage.transcript.reasoning')}</summary>
                    <pre className="dsm-pre">{item.reasoning}</pre>
                  </details>
                )}
                {item.args !== undefined && <pre className="dsm-pre">{item.args}</pre>}
                {item.text !== undefined && item.text !== '' && <pre className="dsm-pre">{item.text}</pre>}
                {item.note !== undefined && <div className="dsm-meta">{item.note}</div>}
                {item.truncated !== undefined && (
                  <button type="button" className="dsm-button" disabled={busy} onClick={() => void showFull(item)}>
                    {t('manage.transcript.truncated', {
                      count: item.truncated.reduce((sum, cut) => sum + cut.chars, 0),
                    })}
                  </button>
                )}
              </div>
            </React.Fragment>
          )
        })}
        {busy && items.length > 0 && <div className="dsm-hint">{t('manage.transcript.loadingMore')}</div>}
      </div>
    </Modal>
  )
}
