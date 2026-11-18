// src/client/operations/manage/migrateResult.ts — 迁移结果页那几句话的拼法。
//
// 宿主只回**结构化数据**，一段拼好的文字都不带：给模型的那一份由 `src/operations/migrate/report.ts`
// 渲染（点名会话 id、备份目录、要不要重启），界面这一份在 `ManagePanel` 里拼——两边读者不同：
//
//   - 模型要顺着会话 id（36～44 个字符的十六进制）去处理，还要备份目录与"要不要重启"；
//   - 用户要的是"哪几类没搬、去「会话」页怎么处理"，以及一句话一行的节奏。
//
// 所以这里给的是"把没搬的会话按原因数出来"（子智能体 2、已归档 2），和 `ManagePanel` 里那几行短句
// 一起用。判据见 .agents/notes/implemented/bug-fix/2026-11-18-results-return-structure-not-prose.md。
//
// @module dsh-session-manager/client/operations/manage/migrateResult

import type { MigrationPreview } from '../../api.ts'
import type { SessionManagerKey, Translate } from '../../shared/i18n/locales.ts'

/** 侧边栏不显示的三种原因（与宿主 `StrandedReason` 同一套）。 */
export type StrandedReason = MigrationPreview['strandedSources'][number]['members'][number]['reason']

/**
 * 三类原因怎么称呼、按什么顺序数（与行上那几枚标签同一套文案，见 `sessionList.tsx` 的 `ATTRIBUTE_TAGS`）。
 *
 * 顺序跟筛选条与 `src/operations/migrate/plan.ts` 的 `STRANDED_LABELS` 一致：子智能体 → 空白 → 已归档。
 */
const REASON_TAGS: ReadonlyArray<readonly [StrandedReason, SessionManagerKey]> = [
  ['subagent', 'tag.subagent'],
  ['blank', 'tag.blank'],
  ['archived', 'tag.archived'],
]

/**
 * 「另有 N 条会话侧边栏不显示（**这一段**）」括号里的内容。
 *
 * 只说真有人的那几类，例如「子智能体 2、已归档 2」；一条都没有时返回空串（调用方照常拼句子，
 * 只是括号里会空着——那种情况本来就不该走到这里）。
 *
 * @param members 搬不走的那些会话（每条的 `reason` 是它侧边栏不显示的原因）。
 * @param t 翻译函数。
 * @returns `原因 条数` 用顿号连起来的一段文字。
 */
export function strandedReasonsText(
  members: ReadonlyArray<{ reason: StrandedReason }>,
  t: Translate,
): string {
  return REASON_TAGS.map(([reason, key]) => ({
    label: t(key),
    count: members.filter((member) => member.reason === reason).length,
  }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.label} ${item.count}`)
    .join('、')
}
