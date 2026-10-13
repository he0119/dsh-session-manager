/**
 * 「重新生成名称」这一次动作该说哪几句话——抽成纯函数，因为这里错一次就会**说反**。
 *
 * 三件事各说各的，不能混：
 *   - **改了**（provider 给出不同标题）与**没变**（模型认为现有的仍然贴切）都是"算过了"，但一个是
 *     "你得到了新名字"、一个是"原来的名字确认还在用"——按同一个数报会让人以为有一半没生效；
 *   - **跳过**不是失败：`pinned`（你自己改过名）、`subagent`（名称在侧边栏里看不见）、
 *     `no-human-message`、`no-request-route`（这条会话没有过主模型请求）全都是"本来就不该动它"。
 *     所以它有自己的说法，不进 `failed` 那张清单；
 *   - 一次动作里可能**同时**有"改了 3 条、跳过 5 条（其中 4 条是你改过名的）"，所以两句话要能一起说。
 *
 * 跳过按**原因合并计数**：勾一页会话时逐条念"这条跳过、那条跳过"没人读，用户要的是"5 条没动，其中
 * 4 条是你自己改过名的"。
 *
 * 只用到结果里那几个数组，所以这里**不 import** `../api.ts`（那是浏览器侧的模块，Host 侧的 typecheck
 * 工程没有 DOM，import 会把它拉进那个工程里检查——见 planRows.ts 里的同一段说明）。
 *
 * @module dsh-session-manager/client/retitleNotes
 */

import type { SessionManagerKey, Translate } from './locales.ts'

/** 结果里这个函数用得到的那几样（`RetitleResponse` 满足它）。 */
export interface RetitleFacts {
  readonly retitled: readonly { readonly id: string; readonly title: string }[]
  readonly unchanged: readonly { readonly id: string; readonly title: string }[]
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly reason: string }>
}

/**
 * 宿主那个原因词 → 界面上那句话。
 *
 * 与宿主共用一份词汇（`src/types.ts` 的 `RetitleSkipReason`）：将来宿主多报一种原因时，这里**不认识
 * 就退到 `other`**——界面该说"因为别的原因跳过了 N 条"，而不是整次动作失败或者印一个英文词出来。
 */
const REASON_KEY: Readonly<Record<string, SessionManagerKey>> = {
  pinned: 'manage.retitle.skip.pinned',
  subagent: 'manage.retitle.skip.subagent',
  'no-human-message': 'manage.retitle.skip.noHumanMessage',
  'no-request-route': 'manage.retitle.skip.noRequestRoute',
  'no-title-provider': 'manage.retitle.skip.noTitleProvider',
  'not-found': 'manage.retitle.skip.notFound',
}

/** 这次动作的文案。 */
export interface RetitleNotes {
  /** 一句结论（改了 / 没变）；一条都没算过时为 `undefined`。 */
  notice?: string
  /** 逐条跳过的原因（按原因合并计数）；一条都没跳过时为空数组。 */
  skipped: string[]
}

/**
 * 把一次重算结果翻译成界面上要写的几句话。
 *
 * @param facts 宿主回的结果。
 * @param t 注入面带来的翻译函数。
 * @returns 结论与跳过原因；两者都可能为空（比如全都没算过）。
 */
export function describeRetitle(facts: RetitleFacts, t: Translate): RetitleNotes {
  const parts: string[] = []
  if (facts.retitled.length > 0) parts.push(t('manage.retitle.done', { count: facts.retitled.length }))
  if (facts.unchanged.length > 0) parts.push(t('manage.retitle.unchanged', { count: facts.unchanged.length }))

  const counts = new Map<string, number>()
  for (const item of facts.skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1)
  const skipped = [...counts].map(([reason, count]) =>
    t(REASON_KEY[reason] ?? 'manage.retitle.skip.other', { count }),
  )

  return { ...(parts.length === 0 ? {} : { notice: parts.join(' ') }), skipped }
}
