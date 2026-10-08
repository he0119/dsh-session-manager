// src/checkpoint-warm.ts — 落地之后请宿主把它自己那份投影检查点补上（零 DSH 依赖，端口由宿主半侧注入）。
//
// 为什么需要这一步：侧边栏那一行显示什么**不来自日志**。宿主的 `session/list` 对"没活过的会话"只读它
// 自己持久化的投影检查点（`<storages>/session_projcache/sessions/<id>.json`），读不到就回退成
// `session.untitled`（未命名）——标题、空白判据、最后活动时间三件事都在那一条记录里。
//
// 而检查点只在**活的会话**的三个时刻被写：创建、`turn/end`（或节流）、释放。所以从文件搬进来的会话
// （导入、同步拉取、迁移改写 cwd）在本机没有检查点：侧边栏显示"未命名"、时间退回 `createdAt`，本插件
// 自己那边的空白判据与"谁更新"也跟着读不到，直到人点开一次——那是宿主把这条会话取成活会话时顺手补的。
//
// 这里做的**不是**自己写那份文件（它是折叠的种子：identity 与每行的 `ver`/`seq` 都归宿主，写错会让宿主
// 跳过真事件），而是把宿主自己的冷读走一遍：
//
//   1. `sessionQuery.readSession()`：读完整日志并校验，**不**把它变成活会话；
//   2. `sessionProjectionCache.coldSnapshot()`：折叠所有投影单元并写回检查点（宿主自己的文档写明
//      "第一次冷读会建立缓存行"）。
//
// 代价是每条落地会话要把整份日志读一遍折一遍（≈ 手动点开一次的代价）。所以这里逐条兜住失败、绝不影响
// 落地结论：日志已经在盘上了，这一步只补宿主那份派生数据。
//
// @module dsh-session-manager/checkpoint-warm
import type { CheckpointWarmPort, ProgressReporter, WarmOutcome } from './types.ts'

/** `warmCheckpoints()` 的依赖：宿主那半侧探测出来的端口（缺席 = 这个宿主没有那套动作）。 */
export interface WarmDeps {
  /**
   * 探测宿主"补齐列表元数据"的两个服务（`sessionQuery` + `sessionProjectionCache`）。
   *
   * 每次调用**重新探测**（与 `EffectDeps.hostRegistry` 同一条理由）：老版本宿主、只装了工具的前端都
   * 可能没有这套服务，探测结果不该被缓存。
   */
  hostCheckpoints?: () => CheckpointWarmPort | undefined
}

/** 一条失败原因最多带几条进结论（多的只计数）：结论是给人看的一句话，不是日志。 */
const MAX_REPORTED_FAILURES = 3

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 请宿主给这几条会话补上投影检查点。
 *
 * 去重后**逐条**走一遍（失败一条不影响后面的），拿不到端口就如实报 `unavailable`——这条路径不是落地的
 * 一部分：`warmed + failed` 不等于落地条数时也不该抛。
 *
 * @param ids 刚落地的会话 id（重复的会去掉）。
 * @param deps 宿主端口（缺席就什么都不做）。
 * @param onProgress 逐条报一次（`phase: 'warm'`）。这一步**每条会话要把整份日志读一遍折一遍**
 *   （见下面那句代价），落地几百条时它是最后一段长活，所以它值得一条进度；拿不到端口时一条都不报。
 * @returns 补上了几条、失败几条、这个宿主有没有那套动作。
 */
export async function warmCheckpoints(
  ids: readonly string[],
  deps: WarmDeps,
  onProgress?: ProgressReporter,
): Promise<WarmOutcome> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))]
  // 一条都不用补时连端口都不探：纯推送、空计划这些路上不该多花一次宿主服务读取。
  if (unique.length === 0) return { warmed: 0, failed: 0, unavailable: false, problems: [] }
  let port: CheckpointWarmPort | undefined
  try {
    port = deps.hostCheckpoints?.()
  } catch (error) {
    // 探测本身失败按"没有那套动作"报，并把原因带上（与 take-effect.ts 对探测失败的口径一致）。
    return { warmed: 0, failed: 0, unavailable: true, problems: [reasonOf(error)] }
  }
  if (port === undefined) return { warmed: 0, failed: 0, unavailable: true, problems: [] }

  let warmed = 0
  const failures: string[] = []
  for (const [index, id] of unique.entries()) {
    onProgress?.({ phase: 'warm', total: unique.length, done: index, id, label: id })
    try {
      await port.warm(id)
      warmed += 1
    } catch (error) {
      failures.push(`${id}：${reasonOf(error)}`)
    }
  }
  return {
    warmed,
    failed: failures.length,
    unavailable: false,
    problems: failures.slice(0, MAX_REPORTED_FAILURES),
  }
}

/**
 * 这一步"结果怎样"的措辞，工具层与界面层共用这一份（与 take-effect.ts 的 `describeEffect()` 同一条
 * 约定：同一个结论不写两遍）。
 *
 * @param outcome 补完之后拿到的结果；`undefined` = 这一步没跑（预演、纯推送）。
 * @returns 一句给人看的结论；没什么可说的时返回 undefined（调用方据此不添这一行）。
 */
export function describeWarm(outcome: WarmOutcome | undefined): string | undefined {
  if (outcome === undefined) return undefined
  if (outcome.warmed === 0 && outcome.failed === 0 && !outcome.unavailable) return undefined
  if (outcome.unavailable) {
    return (
      '这个宿主没有让插件补齐列表元数据的入口（只有工具的前端或老版本宿主）：' +
      '这些会话在侧边栏要等你第一次点开才有标题。'
    )
  }
  const head = `已请宿主折好这 ${outcome.warmed} 条会话的列表元数据（侧边栏的标题与最后活动时间）。`
  if (outcome.failed === 0) return head
  const tail = outcome.problems.length === 0 ? '' : `：${outcome.problems.join('；')}`
  return (
    `${head}另有 ${outcome.failed} 条没补上（日志已经在盘上，不影响落地；点开一次照样会有）${tail}`
  )
}
