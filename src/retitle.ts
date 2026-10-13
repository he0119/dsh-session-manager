// src/retitle.ts — 重新生成会话题标的编排：跳过不该动的，逐条请宿主重算，按条报结果。
//
// 为什么要有这一层而不是把循环写在端点里：三件事各归各的地方——**谁不该动**是产品判断（子智能体的
// 标题在侧边栏里根本看不到；用户手动改过的名字不该被一次批量动作抹掉）、**怎么重算**是 DSH 内部的事
// （见 src/tools.ts 的 `titleRefreshPort()`）、**怎么报**是端点的事（事件流 + 逐条结果）。编排层只认
// `TitleRefreshPort` 一个形状，所以它可以脱离宿主单独测（见 test/retitle.test.ts）。
//
// 逐条进行而不是并发：每次重算都要在宿主里把那条会话临时挂上、跑一次模型调用、再摘下来（见端口的
// 注释），并发跑等于同时挂 N 条会话并按会话主模型发 N 个请求；顺序跑既让进度条有意义，也让"中途发现
// 不对"可以立刻停手。代价是慢——一条会话一次模型调用（实测同一路由下 2～3 秒），这是这个动作的性质，
// 不是实现取舍。
//
// 一条失败不影响其余：与归档那条路同一口径（`failed` 逐条列出，其余照常报成功），因为"这条因为用户
// 改过名被跳过"和"这条模型报错"是两件不同的事，界面要分别说。**一次都没成功**也算 ok——跳过不是失败。
//
// @module dsh-session-manager/retitle
import type { ProgressReporter, RetitleOutcome, RetitleSkipReason, TitleRefreshPort } from './types.ts'

/** 库里一条会话在编排层要用的那几样（`DiscoveredSession` 满足它）。 */
export interface RetitleSubject {
  id: string
  /** 折叠出的标题；只用来在进度里称呼它（读不到就退回 id）。 */
  title?: string
  /** 子智能体会话：标题在外壳侧边栏里看不到。 */
  subagent?: boolean
}

/** 编排层的依赖（都可注入，便于测试）。 */
export interface RetitleDeps {
  /**
   * 宿主的重算能力；这个宿主没装名称服务时为 `undefined`（界面据此把按钮禁掉并说明原因，见
   * `src/web.ts` 的 `/state`）。
   */
  port: TitleRefreshPort | undefined
  /** 这次扫出来的会话库（判"不在库里"与"是不是子智能体"）。 */
  sessions: readonly RetitleSubject[]
}

/** 一次重算的请求。 */
export interface RetitleRequest {
  /** 要重算的会话 id；重复的会去重，空数组由调用方先拒掉。 */
  sessionIds: readonly string[]
  /**
   * 连 `user` 源（用户改过名 / 由脚本或导入写下）的标题也一起重算。
   *
   * 默认 false：批量动作不该抹掉用户起的名字。它由接口显式打开（一次性清理那些"标题是脚本或导入写的"
   * 会话时用），编排层只负责把它转交给端口——判定"这条是不是 `user` 源"要能看到标题的来源，而那只在
   * 端口手里（见 `TitleRefreshOptions`）。
   */
  includePinned?: boolean
}

/** 标题被重算成哪一条。 */
export interface RetitleEntry {
  id: string
  title: string
}

/** 没被重算的一条，附原因。 */
export interface RetitleSkip {
  id: string
  reason: RetitleSkipReason
}

/** 真失败的一条（宿主那句话原样带出）。 */
export interface RetitleFailure {
  id: string
  error: string
}

/** 一次重算的结果。 */
export interface RetitleResult {
  /** 有没有失败项（跳过不算失败）。 */
  ok: boolean
  /** provider 给出**不同**标题的那些。 */
  retitled: RetitleEntry[]
  /** 重算过但标题没变的那些（模型按锚定规则原文保留了）。 */
  unchanged: RetitleEntry[]
  skipped: RetitleSkip[]
  failed: RetitleFailure[]
}

/** 编排层的选项。 */
export interface RetitleOptions {
  /** 进度上报（每条会话处理**之前**一次，`done` 是已经做完的条数）。 */
  onProgress?: ProgressReporter
}

/** 异常 → 一句话。宿主自己抛的就是这句话（用户看得懂的那部分在 DSH 里已经写好）。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 给点名的会话逐条重算名称。
 *
 * 顺序：去重 → 逐条判定"该不该动" → 交给宿主 → 按结果分类。**不认识的 id 记 `not-found` 而不是抛**：
 * 界面刚拉完清单，别处删了一条是完全正常的，不该让整批动作作废。
 *
 * @param deps 宿主能力与这次扫出来的库。
 * @param request 点名的会话 id。
 * @param options 进度上报。
 * @returns 四类结果；`ok` 只反映有没有 `failed`。
 */
export async function runRetitle(
  deps: RetitleDeps,
  request: RetitleRequest,
  options: RetitleOptions = {},
): Promise<RetitleResult> {
  const report = options.onProgress
  const known = new Map<string, RetitleSubject>()
  for (const subject of deps.sessions) known.set(subject.id, subject)

  // 去重但保序：界面按勾选顺序传，进度条上"第几条"因此与用户按下去的顺序对得上。
  const targets = [...new Set(request.sessionIds)]

  const retitled: RetitleEntry[] = []
  const unchanged: RetitleEntry[] = []
  const skipped: RetitleSkip[] = []
  const failed: RetitleFailure[] = []

  for (const [index, id] of targets.entries()) {
    const subject = known.get(id)
    report?.({
      phase: 'retitle',
      total: targets.length,
      done: index,
      id,
      ...(subject?.title === undefined ? {} : { label: subject.title }),
    })
    if (subject === undefined) {
      skipped.push({ id, reason: 'not-found' })
      continue
    }
    if (subject.subagent === true) {
      skipped.push({ id, reason: 'subagent' })
      continue
    }
    if (deps.port === undefined) {
      // 端点其实在这之前就按能力位拒了（见 src/web.ts 的 `/retitle`），这里只是不让"没有能力"
      // 变成一条抛出来的异常——编排层照旧给出可展示的结果。
      skipped.push({ id, reason: 'no-title-provider' })
      continue
    }

    let outcome: RetitleOutcome
    try {
      outcome = await deps.port.refresh(id, { includePinned: request.includePinned === true })
    } catch (error) {
      failed.push({ id, error: describe(error) })
      continue
    }

    switch (outcome.status) {
      case 'retitled':
        retitled.push({ id, title: outcome.title })
        break
      case 'unchanged':
        unchanged.push({ id, title: outcome.title })
        break
      case 'skipped':
        skipped.push({ id, reason: outcome.reason })
        break
      case 'failed':
        failed.push({ id, error: outcome.error })
        break
      /* v8 ignore next -- 封闭联合的穷尽性守卫（新增状态时这里会编译不过） */
      default:
        failed.push({ id, error: `未知的重算结果：${JSON.stringify(outcome)}` })
    }
  }

  return { ok: failed.length === 0, retitled, unchanged, skipped, failed }
}
