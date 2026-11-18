// src/operations/migrate/report.ts — 迁移**给模型看的那一份**文字：预览一段、结果一段。
//
// 这里只做一件事：把结构化数据（`MigrationPreview` / `MigrationRun`）渲染成一段给模型读的文本，
// 由迁移工具返回。宿主不再自己拼好一段字塞在结果里——界面与模型是两个读者，各自从结构里取自己需要的
// 部分：
//
//   - **模型**要能顺着 id 去处理（哪几条活会话没搬、哪几条侧边栏不显示），还要备份目录与"要不要重启"；
//   - **界面**（`src/client/operations/manage/ManagePanel.tsx`）要的是类别与条数、一句话一行、按语言
//     翻译，会话 id 与备份绝对路径都不是弹窗里要读的东西。
//
// 所以 `MigrationPreview` / `MigrationRun` 里没有 `summary` 字段，只有结构；需要文字的一方调这里的
// 函数。判据见 .agents/notes/implemented/bug-fix/2026-11-18-results-return-structure-not-prose.md。
//
// @module dsh-session-manager/operations/migrate/report

import { describeEffect } from '../../shared/host/take-effect.ts'
import { describeWarm } from '../../shared/host/checkpoint-warm.ts'
import type { StrandedReason, StrandedSource } from '../../shared/types.ts'
import type { MigrationPreview, MigrationRun } from './migrate.ts'

/** 三种"侧边栏不显示"的称呼与顺序（与 visibility.ts 的判据、界面那几枚标签同一套）。 */
const STRANDED_LABELS: ReadonlyArray<readonly [StrandedReason, string]> = [
  ['subagent', '子智能体'],
  ['blank', '空白'],
  ['archived', '已归档'],
]

/**
 * 搬不走的那些会话是怎么分布的，例如「子智能体 1、已归档 2」。
 *
 * @param sources 见 `MigrationPreview.strandedSources`。
 * @returns `原因 条数` 用顿号连起来的一段；一条都没有时是空串。
 */
function strandedReasons(sources: readonly StrandedSource[]): string {
  const members = sources.flatMap((source) => source.members)
  return STRANDED_LABELS.map(([reason, label]) => ({
    label,
    count: members.filter((member) => member.reason === reason).length,
  }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.label} ${item.count}`)
    .join('、')
}

/**
 * 源工作区"搬完还剩人"那两行：点名是哪几条、它们留在哪、为什么那块工作区没被删、要清掉怎么办。
 *
 * 两行都得说：留下的那几条**不在**这次的清单里（它们侧边栏不显示，见 visibility.ts），不说清楚，
 * 用户看到的就是"全部迁完了，怎么还有一块空工作区"。
 *
 * @param sources 见 `MigrationPreview.strandedSources`。
 * @returns 要追加的行（空数组 = 每块源工作区都搬空了）。
 */
function strandedLines(sources: readonly StrandedSource[]): string[] {
  const members = sources.flatMap((source) => source.members)
  if (members.length === 0) return []
  return [
    `  另有 ${members.length} 条会话侧边栏不显示（${strandedReasons(sources)}），这次不搬：` +
      members.map((member) => member.id).join('、'),
    `    它们留在 ${sources.map((source) => source.path).join('、')}，那几块工作区因此不会被删——` +
      '要清掉它们：已归档的先去「会话」页取消归档、空白的删掉、子智能体连着它的父会话一起迁，然后再迁一次。',
  ]
}

/**
 * 预览那段文字（只读计划，不写任何字节）。
 *
 * @param preview 计划的结构化结果。
 * @returns 一段给模型读的多行文本（界面按同一份结构自己拼）。
 */
export function describeMigrationPreview(preview: MigrationPreview): string {
  const lines: string[] = []
  lines.push(`迁移 ${preview.sessions.length} 个会话：`)
  // 源可能有几处（勾选跨目录时就是这样）：逐条列出项目目录，不写"多个来源"这种含糊话。
  lines.push(`  来源项目目录：${preview.sourceProjectDirs.join('、')}`)
  lines.push(`  -> ${preview.to}`)
  lines.push(`  日志文件 ${preview.files} 个；目标项目目录 ${preview.targetProjectDir}`)
  if (preview.cascaded > 0) {
    lines.push(`  其中 ${preview.cascaded} 条是子智能体会话（跟着点名的父会话一起搬，成员资格不变）`)
  }
  if (preview.liveSkipped.length > 0) {
    // 少搬就说少搬：逐条点名，才知道是哪几条、下一次该迁谁（只有重启 DSH 才能让宿主放手）。
    lines.push(
      `  另有 ${preview.liveSkipped.length} 条会话宿主持在内存里（还活着），这次不搬：` +
        preview.liveSkipped.map((session) => session.id).join('、'),
    )
    lines.push('    它们留在原目录、归属不变；重启 DSH 之后再迁一次即可。')
  }
  lines.push(...strandedLines(preview.strandedSources))
  if (preview.artifacts) {
    lines.push(`  会话产物：待搬 ${preview.artifacts.moves} 项、跳过 ${preview.artifacts.skipped.length} 项`)
  }
  const change = preview.registryChange
  if (change) {
    const staleCount = change.droppedStale.reduce((n, entry) => n + entry.sessionIds.length, 0)
    lines.push(
      `  注册表：目标工作区 ${change.targetId}${change.createdTarget ? '（新建，前插）' : '（复用）'}；` +
        `新增归属 ${change.added.length}（其中未分组收编 ${change.adoptedFromUnowned.length}）；` +
        `摘除自 ${change.movedFrom.length} 个工作区；删除空工作区 ${change.removedSources.length}` +
        `${staleCount > 0 ? `；顺带清掉 ${staleCount} 条宿主不认的悬空登记` : ''}`,
    )
  }
  if (preview.problems.length) {
    lines.push(`  问题 ${preview.problems.length} 项：`)
    for (const problem of preview.problems) lines.push(`    - ${problem}`)
  }
  return lines.join('\n')
}

/**
 * 执行结果那段文字（重活已经做完，说清做了几件、少搬了谁、复核与备份、怎么生效）。
 *
 * 只给工具用：界面按同一份结构自己拼（一句话一行、按语言翻译、不列会话 id）。
 *
 * @param run 执行结果的结构化数据。
 * @returns 一段多行文本。
 */
export function describeMigrationRun(run: MigrationRun): string {
  const lines: string[] = [
    `已迁移 ${run.preview.sessions.length} 个会话（改写 ${run.rewritten} 个日志、移动 ${run.moved} 个目录` +
      `${run.artifactsMoved > 0 ? `、搬迁 ${run.artifactsMoved} 项产物` : ''}）。`,
    // 少搬了谁必须写在最前面那一段里：这一句是执行结果的全部交代，不能只出现在预览里。
    ...(run.preview.liveSkipped.length === 0
      ? []
      : [
          `另有 ${run.preview.liveSkipped.length} 条会话宿主持在内存里（还活着），这次没搬：` +
            `${run.preview.liveSkipped.map((session) => session.id).join('、')}——重启 DSH 之后再迁一次。`,
        ]),
    // 侧边栏不显示、这次搬不走的那几条同理：不说，用户就只会看到"还有一块空工作区"。
    ...strandedLines(run.preview.strandedSources),
    `复核：${run.verified ? '通过' : '失败'}${run.backupDir === undefined ? '' : `。备份：${run.backupDir}`}`,
  ]
  if (run.effect !== undefined) lines.push(describeEffect(run.effect))
  const warm = describeWarm(run.warm)
  if (warm !== undefined) lines.push(warm)
  return lines.join('\n')
}
