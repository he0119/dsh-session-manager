// src/client/operations/manage/deleteResult.ts — 删除这一路的几句话：确认弹窗那句结论、结果页那几行。
//
// 宿主只回结构（计划、`dirsRemoved`、`verified`、`remote`），一句拼好的文字都不带。为什么：同一段文字
// 有两个读者——给模型的（工具的返回，要 id 与备份目录）与给人的（弹窗，要一句一行、按语言翻译）。
// 删除只有界面这一个入口，所以这几句在这里拼；判据见
// .agents/notes/implemented/bug-fix/2026-11-18-results-return-structure-not-prose.md。
//
// 抽成纯函数而不是写在 JSX 里：这几句错一次就会**说反**（"复核没过"说成"删干净了"、"别的机器上还留着"
// 漏掉），纯函数能被 test/**/*.ts 直接钉住，见 test/client/operations/manage/deleteResult.test.ts。
//
// @module dsh-session-manager/client/operations/manage/deleteResult

import type { Translate } from '../../shared/i18n/locales.ts'

/** 确认弹窗那一句结论要看的那几样（`DeleteResponse.preview` 够用）。 */
export interface DeletePlanFacts {
  readonly ok: boolean
  readonly entries: readonly unknown[]
  readonly cascaded: number
}

/** 远端那一步的结果（`DeleteResponse.remote` 够用的那几样）。 */
export interface RemoteRemovalFacts {
  readonly removed: number
  readonly others: readonly string[]
}

/** 结果页那一套要看的那几样（`DeleteResponse` 够用）。 */
export interface DeleteResultFacts {
  readonly applied: boolean
  readonly verified: boolean
  readonly dirsRemoved: number
  readonly cascaded: number
  readonly remote?: RemoteRemovalFacts | undefined
}

/** 结果页要画的东西：结论（带颜色）+ 一句一句的说明 + 要标出来的那一句。 */
export interface DeleteResultLines {
  /** 结论成没成（决定颜色）。 */
  ok: boolean
  /** 结论那一句。 */
  verdict: string
  /** 结论下面的说明，一句一行。 */
  notes: string[]
  /** 需要告警的那一句（复核没通过），没有就是 `undefined`。 */
  warn?: string
}

/**
 * 确认弹窗里那句结论。
 *
 * @param plan 宿主回的计划（`ok`、要删的清单、级联条数）。
 * @param t 翻译函数。
 * @returns 一句结论：计划可用时说"将删除 N 个会话"，不可用时说"这次不会删任何会话"。
 */
export function deletePlanVerdict(plan: DeletePlanFacts, t: Translate): string {
  return plan.ok
    ? t('manage.delete.plan', { count: plan.entries.length })
    : t('manage.delete.planBlocked')
}

/**
 * "其中 N 条是子智能体会话，跟着点名的会话一起删"——没有级联时返回 `undefined`。
 *
 * 确认弹窗与结果页共用：同一个事实（级联条数）在两处各说一句，措辞只能有一份。
 *
 * @param cascaded 级联带进来的条数。
 * @param t 翻译函数。
 * @returns 那句说明，或 `undefined`。
 */
export function deleteCascadeNote(cascaded: number, t: Translate): string | undefined {
  return cascaded > 0 ? t('manage.delete.planCascade', { count: cascaded }) : undefined
}

/**
 * 远端那一步那句话。
 *
 * 一个包都没删、别的机器上也没有副本时**整句不出现**：这台机器根本没推过这些会话，说"删掉 0 个包"
 * 只是噪音。
 *
 * @param remote 远端那一步的结果。
 * @param t 翻译函数。
 * @returns 一句话；没什么可说的时是 `undefined`。
 */
export function describeRemoteRemoval(remote: RemoteRemovalFacts, t: Translate): string | undefined {
  if (remote.removed === 0 && remote.others.length === 0) return undefined
  const parts: string[] = []
  if (remote.removed > 0) parts.push(t('manage.delete.remoteDone', { count: remote.removed }))
  if (remote.others.length > 0) {
    parts.push(t('manage.delete.remoteOthers', { machines: remote.others.join('、') }))
  } else if (remote.removed > 0) {
    // 远端那一格清干净、别处也没有副本：这句是"下次同步不会又冒出来"的交代。
    parts.push(t('manage.delete.remoteStaysDeleted'))
  }
  return parts.join(' ')
}

/**
 * 结果页那几行：结论、级联说明、远端那一步、复核没通过。
 *
 * @param result 宿主回的执行结果。
 * @param t 翻译函数。
 * @returns 结论、说明与告警；说明里没有内容的项不会出现（不画空行）。
 */
export function describeDeleteResult(result: DeleteResultFacts, t: Translate): DeleteResultLines {
  const ok = result.applied && result.verified
  const notes: string[] = []
  if (result.applied) {
    const cascade = deleteCascadeNote(result.cascaded, t)
    if (cascade !== undefined) notes.push(cascade)
    if (result.remote !== undefined) {
      const remote = describeRemoteRemoval(result.remote, t)
      if (remote !== undefined) notes.push(remote)
    }
  }
  return {
    ok,
    verdict: result.applied
      ? t('manage.delete.done', { count: result.dirsRemoved })
      : t('manage.delete.nothingDone'),
    notes,
    ...(result.applied && !result.verified ? { warn: t('manage.delete.verifyFailed') } : {}),
  }
}
