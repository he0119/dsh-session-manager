/**
 * 进度块：一条进度条 + 那句"做到哪儿了" + 正在处理的那一条（+ 一句那句动作自己的说明）。
 *
 * 为什么把这一段从 [SyncPanel.tsx](./SyncPanel.tsx) 里提出来：迁移、删除、回滚、导入、归档、扫库都
 * 走同一条事件流（见 [eventStream.ts](../logic/eventStream.ts)），摆法当然是同一套——同一个
 * `ProgressBar`、同一份按段名挑文案的 `progressTextOf()`、同一条"分母为 0 就不画条"的规矩。各页只需要
 * 决定"摆在哪儿"（弹窗正文里、还是动作行下面）与"补哪句话"（同步补的是"再点一次接着补齐"，
 * 迁移补的是"中断会留下中间状态、可在备份页回退"——那句话各页不同，所以由调用方给）。
 *
 * @module dsh-session-manager/client/ProgressBlock
 */

import * as React from 'react'

import { ProgressBar } from './ProgressBar.tsx'
import type { ProgressEvent } from '../logic/eventStream.ts'
import type { Translate } from '../logic/locales.ts'

/**
 * 进度那行字。
 *
 * `done` 是**已经做完**的条数、事件发在开始处理下一条之前，所以正在处理的是第 `done + 1` 条——与
 * 进度条的 `current` 同一个数，两处必须一起变。分母为 0 的那两段（读远端索引、落注册表）是固定的一句，
 * 没有"第几条"可讲。
 *
 * 认不出来的段名退到一句通用的"正在处理…"：宿主比界面新时报一句含糊的话，比整块消失好。
 */
export function progressTextOf(t: Translate, progress: ProgressEvent): string {
  const current = progress.done + 1
  const total = progress.total
  switch (progress.phase) {
    case 'scan':
      return t('progress.scan', { current, total })
    case 'read':
      return t('progress.read', { current, total })
    case 'pack':
      return t('progress.pack', { current, total })
    case 'backup':
      return t('progress.backup', { current, total })
    case 'rewrite':
      return t('progress.rewrite', { current, total })
    case 'move':
      return t('progress.move', { current, total })
    case 'write':
      return t('progress.write', { current, total })
    case 'remove':
      return t('progress.remove', { current, total })
    case 'restore':
      return t('progress.restore', { current, total })
    case 'archive':
      return t('progress.archive', { current, total })
    case 'verify':
      return t('progress.verify', { current, total })
    case 'repo':
      return t('progress.repo', { current, total })
    case 'compare':
      return t('progress.compare', { current, total })
    case 'pull':
      return t('progress.pull', { current, total })
    case 'push':
      return t('progress.push', { current, total })
    case 'warm':
      return t('progress.warm', { current, total })
    // 这两段没有分母，文案里也就没有"第几条"。
    case 'registry':
      return t('progress.registry')
    case 'remote':
      return t('progress.remote')
    default:
      return t('progress.working')
  }
}

/**
 * @param progress 最近收到的那条进度事件。
 * @param note 这一段动作自己的一句话（「中断了再点一次会接着补齐」这类）；不需要就不传。
 */
export function ProgressBlock({
  t,
  progress,
  note,
}: {
  t: Translate
  progress: ProgressEvent
  note?: string | undefined
}): React.ReactElement {
  const text = progressTextOf(t, progress)
  return (
    <>
      {/* 分母是 0 的那几段没有"第几条"：只摆那句话，不摆条（画一条 1/1 的会让人以为已经做完了）。 */}
      {progress.total > 0 && <ProgressBar current={progress.done + 1} total={progress.total} label={text} />}
      <p className="dsm-hint">{text}</p>
      {progress.label === undefined ? null : <p className="dsm-rowTitle">{progress.label}</p>}
      {note === undefined ? null : <p className="dsm-hint">{note}</p>}
    </>
  )
}
