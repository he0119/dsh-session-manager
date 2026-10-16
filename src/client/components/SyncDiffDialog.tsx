/**
 * 「两边各自写过」时看差异：本机这一份 vs 远端那台那份。
 *
 * 同步的计划只说得出"两边不一样"（`diverged`），说不出"哪儿不一样"——删哪边、留哪边只能由人决定，
 * 所以这一页把差异摆出来。它**只读**：不写本机、也不写远端（宿主那条路一个字节都不落，见 `web.ts`
 * 的 `/sync-diff`），所以可以放心点开看。
 *
 * 三段式，像 `git diff`：共有的折成一句话、两条尾巴各列一份。三类关系分得清（同一份日志的三种形态）：
 *
 * 1. **事件逐条一致**——只有 header 里的 `cwd` 之类不同（迁移落地会改写它）。这种情况"保哪份都一样"，
 *    界面上要说成一句话，不能跟真分叉混起来。
 * 2. **一边是另一边的前缀**——同一条会话在两边继续写，只是一边写得远一点。这也不是分叉，
 *    报告成"本机又多写了 N 条"。
 * 3. **两边各写各的**——这才是要裁决的：共同到第 N 条为止，之后两边各有各的内容。
 *
 * 条目只显示解析出来的**一行摘要**（正文首行、工具名 + 入参首行），原文要看另有内容视图那一页；
 * 尾巴太长时只列前几条，剩下的报个数（`hidden`）——预览不该把整份日志搬进浏览器。
 *
 * @module dsh-session-manager/client/SyncDiffDialog
 */

import * as React from 'react'

import { Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import { fetchSyncDiff, type SyncDiffResponse } from '../api.ts'
import { KIND_KEY } from './TranscriptDialog.tsx'
import { formatBytes, formatTime } from './sessionList.tsx'
import { sideBlocks, STAT_KEY, statCells } from '../logic/diffStats.ts'
import { KIND_TONE, RELATION_KEY, RELATION_TONE, SIDE_TONE } from '../logic/diffTags.ts'
import type { DiffItem, DiffTail } from '../../session-diff.ts'
import type { Translate } from '../logic/locales.ts'

/** 要看的这一条：id + 远端是哪台机器（计划里已经有了）+ 界面顶上的名字。 */
export interface SyncDiffTarget {
  id: string
  machine?: string
  title?: string
}

type Loaded =
  | { status: 'busy' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SyncDiffResponse }

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 一条尾巴：标题 + 前几条 + "还有 N 条没列出来"。 */
function TailBlock({
  side,
  tail,
  t,
}: {
  side: 'local' | 'remote'
  tail: DiffTail
  t: Translate
}): React.ReactElement {
  return (
    <div className={`dsm-diffTail dsm-diffTail-${side}`}>
      {/* 哪一边独有：一枚标签写在块头上，不用读句子（本机一档、远端另一档，两块一眼分得开）。 */}
      <Tag className="dsm-tag" tone={SIDE_TONE[side]}>
        {t(side === 'local' ? 'sync.diff.tail.local' : 'sync.diff.tail.remote', { count: tail.count })}
      </Tag>
      {/* 0 条也要摆：那半边"没有多出来的"本身就是一条结论，不是还没查。 */}
      {tail.count === 0 ? <div className="dsm-hint">{t('sync.diff.tail.empty')}</div> : null}
      {tail.preview.map((item) => (
        // 一行摘要就是内容视图里那一张事件卡的头行（同一个 `.dsm-itemHead`）：种类在左、摘要在中、
        // 时刻在右。种类在这里是一枚官方标签（档位与内容视图那条色边同一套语义，见 KIND_TONE）。
        <div key={`${side}-${item.index}`} className={`dsm-item dsm-item-${item.kind}`} data-dsm-index={item.index}>
          <div className="dsm-itemHead">
            <Tag className="dsm-tag" tone={KIND_TONE[item.kind]}>
              {t(KIND_KEY[item.kind])}
            </Tag>
            <span title={item.brief}>{item.brief}</span>
            {item.time === undefined ? null : <span className="dsm-meta">{formatTime(item.time)}</span>}
          </div>
        </div>
      ))}
      {tail.hidden > 0 ? <div className="dsm-hint">{t('sync.diff.hidden', { count: tail.hidden })}</div> : null}
    </div>
  )
}

/** 关系那句话：三种形态各说各的（这是这一页最要紧的一句）。 */
function relationText(data: SyncDiffResponse, t: Translate): string {
  const { diff } = data
  const fields = diff.header.map((field) => field.field).join(' / ')
  switch (diff.relation) {
    case 'same':
      return diff.header.length === 0
        ? t('sync.diff.same')
        : t('sync.diff.sameHeader', { fields })
    case 'local-extends':
      return t('sync.diff.localExtends', { count: diff.localTail.count })
    case 'remote-extends':
      return t('sync.diff.remoteExtends', { count: diff.remoteTail.count })
    default:
      return t('sync.diff.forked', {
        common: diff.common,
        localCount: diff.localTail.count,
        remoteCount: diff.remoteTail.count,
      })
  }
}

export function SyncDiffDialog({
  target,
  onClose,
  t,
}: {
  target: SyncDiffTarget
  onClose: () => void
  t: Translate
}): React.ReactElement {
  const [state, setState] = React.useState<Loaded>({ status: 'busy' })

  React.useEffect(() => {
    let live = true
    setState({ status: 'busy' })
    fetchSyncDiff(target.id, target.machine)
      .then((data) => {
        if (live) setState({ status: 'ready', data })
      })
      .catch((cause: unknown) => {
        if (live) setState({ status: 'error', message: reasonOf(cause) })
      })
    return () => {
      live = false
    }
  }, [target.id, target.machine])

  const data = state.status === 'ready' ? state.data : undefined
  const { diff } = data ?? {}

  return (
    <Modal
      open
      onClose={onClose}
      title={t('sync.diff.title')}
      closeLabel={t('close')}
      className="dsm-dialog dsm-diffDialog"
      contentClassName="dsm-dialogContent dsm-diffContent"
    >
      <div className="dsm-transcriptName" title={target.id}>
        {target.title ?? target.id}
      </div>
      {data === undefined ? null : (
        <div className="dsm-hint">{t('sync.diff.remoteMachine', { machine: data.machine })}</div>
      )}
      {state.status === 'busy' ? <div className="dsm-hint">{t('sync.diff.loading')}</div> : null}
      {state.status === 'error' ? <p className="dsm-banner dsm-error">{state.message}</p> : null}
      {diff === undefined || data === undefined ? null : (
        <>
          <div className="dsm-hint">
            {t('sync.diff.summary', {
              localBytes: formatBytes(diff.local.bytes),
              remoteBytes: formatBytes(diff.remote.bytes),
            })}
          </div>
          <p className="dsm-diffRelation">
            <Tag className="dsm-tag" tone={RELATION_TONE[diff.relation]}>
              {t(RELATION_KEY[diff.relation])}
            </Tag>
            <span>{relationText(data, t)}</span>
          </p>
          {/* 三格计数把账摆全：共同 / 本机独有 / 远端独有，一格都不能少（0 也是数字）。 */}
          <div className="dsm-diffStats">
            {statCells(diff).map((cell) => (
              <div key={cell.key} className="dsm-diffStat">
                <span className="dsm-hint">{t(STAT_KEY[cell.key])}</span>
                <span>{t('sync.diff.count', { count: cell.count })}</span>
              </div>
            ))}
          </div>
          {diff.header.length === 0 ? null : (
            <div className="dsm-diffHeader">
              <Tag className="dsm-tag" tone="neutral">
                {t('sync.diff.headerTitle', { count: diff.header.length })}
              </Tag>
              <table className="dsm-table dsm-diffTable">
                <thead>
                  <tr>
                    <th className="dsm-diffField">{t('sync.diff.field')}</th>
                    <th>{t('sync.diff.side.local')}</th>
                    <th>{t('sync.diff.side.remote')}</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.header.map((field) => (
                    <tr key={field.field}>
                      <td className="dsm-diffField">{field.field}</td>
                      <td className="dsm-path">{field.local ?? '—'}</td>
                      <td className="dsm-path">{field.remote ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sideBlocks(diff).map((block) => (
            <TailBlock key={block.side} side={block.side} tail={block.tail} t={t} />
          ))}
          <div className="dsm-hint">{t('sync.diff.readonly')}</div>
        </>
      )}
    </Modal>
  )
}

/** 预览里一条摘要（内容视图那一页按需取原文，这里只要够认出来）。 */
export type { DiffItem }
