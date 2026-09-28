/**
 * 「会话」页的筛选判据与行上属性标签：纯函数，界面只负责渲染（同 [planRows.ts](./planRows.ts)）。
 *
 * 判据读的是 `/state` 里的**原始事实**（`origin` / `blank` / `archived` / `live` / `workspaceId`），
 * 不是"这一行显示成哪一枚标签"。两者有一处刻意的差别：`hidden` 字段只报**宿主先判的那一条**理由
 * （一条会话既是空白又已归档时，`hidden` 是 `blank`——那是侧边栏不显示它的原因），而筛选与标签问的是
 * "这条会话是什么"。所以筛选「已归档」时那条空白+已归档的会话要被筛出来，行上也要能看到「已归档」
 * 这枚标签：否则用户会看到"筛了归档，却有几行没有归档标签"。
 *
 * 五类的口径：
 *   - `subagent`：header 里的 `origin === "subagent"`（外壳把它挂在父会话下面）；
 *   - `blank`：宿主投影缓存说它一个 turn 都没开始过；
 *   - `archived`：id 在注册表的归档集里；
 *   - `unowned`：「未分组」——不在任何工作区的登记表里（`workspaceId` 缺省）；这一类的界面对照物
 *     是归属那一格，不另挂标签；
 *   - `live`：还活在宿主内存里（删除会被拒）。
 *
 * @module dsh-session-manager/client/sessionFilter
 */

/**
 * 判据要读的那几个字段。
 *
 * 只声明用得上的字段（同 [planRows.ts](./planRows.ts) 的 `SourceSubject`），不 import `api.ts`：
 * 那样会把 `src/client` 整个拉进没有 DOM 的 Host 工程，而这几个函数是纯的、与界面无关。
 */
export interface SessionFacts {
  readonly id: string
  readonly workspaceId?: string
  readonly origin?: string
  readonly blank?: boolean
  readonly archived?: boolean
  readonly live?: boolean
}

/** 行上会挂出来的属性标签（与筛选键共用一套名字）。 */
export type AttributeKey = 'subagent' | 'blank' | 'archived' | 'live'

/** 筛选键：属性标签四类，外加「未分组」（它写在归属那一格）。 */
export type FilterKey = AttributeKey | 'unowned'

/** 界面上筛选条的固定顺序（也是标签的固定顺序）。 */
export const FILTER_KEYS: readonly FilterKey[] = ['subagent', 'blank', 'archived', 'unowned', 'live']

/** 这一条会话有没有某个属性。 */
export function hasAttribute(session: SessionFacts, key: AttributeKey): boolean {
  switch (key) {
    case 'subagent':
      return session.origin === 'subagent'
    case 'blank':
      return session.blank === true
    case 'archived':
      return session.archived === true
    case 'live':
      return session.live === true
  }
}

/** 这一条会话符不符合某一类。 */
export function matchesFilter(session: SessionFacts, key: FilterKey): boolean {
  if (key === 'unowned') return session.workspaceId === undefined
  return hasAttribute(session, key)
}

/**
 * 这一行该挂哪几枚属性标签（能挂几枚挂几枚，顺序固定）。
 *
 * 「未分组」不出现在这里：归属那一格本来就写着它。
 */
export function attributeKeys(session: SessionFacts): AttributeKey[] {
  const keys: AttributeKey[] = []
  for (const key of FILTER_KEYS) {
    if (key !== 'unowned' && hasAttribute(session, key)) keys.push(key)
  }
  return keys
}

/**
 * 筛选后的列表。
 *
 * 一枚都没勾 = 全都要；勾了几枚 = **任一命中**（"把这几类都摆出来"是勾选面的直觉，而这几类两两之间
 * 本来就很少同时成立——做成"全都要命中"的话，勾第二枚时列表多半直接空了）。
 */
export function filterSessions<T extends SessionFacts>(
  sessions: readonly T[],
  keys: readonly FilterKey[],
): T[] {
  if (keys.length === 0) return [...sessions]
  return sessions.filter((session) => keys.some((key) => matchesFilter(session, key)))
}

/** 每一类各有多少条（对整个库数，不随当前筛选变化——数字会跳的计数没人信得过）。 */
export function filterCounts(sessions: readonly SessionFacts[]): Record<FilterKey, number> {
  const counts: Record<FilterKey, number> = { subagent: 0, blank: 0, archived: 0, unowned: 0, live: 0 }
  for (const session of sessions) {
    for (const key of FILTER_KEYS) {
      if (matchesFilter(session, key)) counts[key]++
    }
  }
  return counts
}
