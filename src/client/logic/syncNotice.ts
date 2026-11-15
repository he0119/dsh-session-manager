/**
 * 一次同步落地之后，页面顶部那条提示该说什么——抽成纯函数，因为这里最容易越写越长。
 *
 * 提示条只回答"刚做完什么"：拉了几条、推了几条，再加一句"另有…"把其余几项折成一句。日志字节、
 * 上传字节、逐项的解释都不进来：那些属于同步面板那张「上次同步」，提示条挂着就得读完才走。
 *
 * 两处刻意的取舍：
 *   - **一条会话都没搬、只补了附件对象**时不报"拉取 0 条、推送 0 条"，换成"这次没有会话要搬"——
 *     补对象那一趟动的是"早先拉坏了的那条会话"，零是噪音；
 *   - **顶掉 / 删掉本机内容**的那两项后面跟一句"旧的那份在「备份与回滚」里"，整条只说一次，
 *     不逐项重复（重复两次时那一句比结论还长）。
 *
 * @module dsh-session-manager/client/syncNotice
 */

import type { Translate } from './locales.ts'

/** 这条提示用得上的那几个数（`SyncResponse` 摊出来的）。 */
export interface SyncNoticeFacts {
  /** 这次真落到本机的会话数。 */
  pulled: number
  /** 这次真推上去的会话数。 */
  pushed: number
  /** 覆盖本机原来那份的条数（旧的那份已备份）。 */
  replaced: number
  /** 跟着删掉的条数（别处删过、本机这份更旧，旧的那份已备份）。 */
  deleted: number
  /** 取回的附件对象数。 */
  attachmentsIn: number
  /** 上传的附件对象数。 */
  attachmentsOut: number
  /** 本机缺、这次没能补上的对象数。 */
  attachmentsMissing: number
  /** 整理远端删掉的包数（没整理或没删到就是 0）。 */
  tidied: number
  /** 这次是不是重新算过一遍计划（预演之后本机或远端又变了）。 */
  replanned: boolean
}

/**
 * 把一次同步的结果折成一句提示。
 *
 * @param facts 这次结果的几个数。
 * @param t 注入面带来的翻译函数。
 * @returns 要摆在提示条上的那句话；什么都没发生（既没搬会话也没补对象）时返回 `undefined`。
 */
export function describeSyncNotice(facts: SyncNoticeFacts, t: Translate): string | undefined {
  const extras: string[] = []
  if (facts.replaced > 0) extras.push(t('sync.appliedReplaced', { count: facts.replaced }))
  if (facts.deleted > 0) extras.push(t('sync.appliedDeleted', { count: facts.deleted }))
  if (facts.attachmentsIn > 0) extras.push(t('sync.appliedAttachmentsIn', { written: facts.attachmentsIn }))
  if (facts.attachmentsOut > 0) extras.push(t('sync.appliedAttachmentsOut', { uploaded: facts.attachmentsOut }))
  if (facts.attachmentsMissing > 0) {
    extras.push(t('sync.appliedAttachmentsMissing', { missing: facts.attachmentsMissing }))
  }
  if (facts.tidied > 0) extras.push(t('sync.appliedTidy', { count: facts.tidied }))
  if (facts.replanned) extras.push(t('sync.replanned'))

  const moved = facts.pulled > 0 || facts.pushed > 0
  if (!moved && extras.length === 0) return undefined

  // 顶掉 / 删掉本机内容的那两项要说清旧的那份在哪；只说一次，挂在最后。
  const restoreHint = facts.replaced > 0 || facts.deleted > 0 ? t('sync.appliedRestoreHint') : ''
  return (
    (moved
      ? t('sync.applied', { pulled: facts.pulled, pushed: facts.pushed })
      : t('sync.appliedObjectsOnly')) +
    (extras.length === 0 ? '' : `另有：${extras.join('、')}。`) +
    restoreHint
  )
}
