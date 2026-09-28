/**
 * 「会话」页的筛选判据与行上属性标签：纯函数，界面只负责渲染（同 [planRows.ts](./planRows.ts)）。
 *
 * 四类属性读的是 `/state` 里的**原始事实**（`origin` / `blank` / `archived` / `live`），不是"这一行
 * 显示成哪一枚标签"。两者有一处刻意的差别：`hidden` 字段只报**宿主先判的那一条**理由（一条会话既是
 * 空白又已归档时，`hidden` 是 `blank`——那是侧边栏不显示它的原因），而筛选与标签问的是"这条会话是
 * 什么"。所以筛选「已归档」时那条空白+已归档的会话要被筛出来，行上也要能看到「已归档」这枚标签：
 * 否则用户会看到"筛了归档，却有几行没有归档标签"。
 *
 * 「未分组」是**唯一**读结论（`ungrouped`）而不是读原始事实的一类：它的定义就是"外壳侧边栏把它放进
 * 了「未分组」那一组"（谁都没认领 **且** 默认视图下会显示），要自己从原始事实推就得把宿主的
 * `sessionVisible()` 再抄一遍——以前正是这么抄错的（只看"有没有认领"，于是子代理/空白/已归档也被
 * 算成「未分组」）。所以在宿主侧算一次（见 `src/visibility.ts` 的 `isUngrouped()`），这里只读结论。
 *
 * 五类的口径：
 *   - `subagent`：header 里的 `origin === "subagent"`（外壳把它挂在父会话下面）；
 *   - `blank`：宿主投影缓存说它一个 turn 都没开始过；
 *   - `archived`：id 在注册表的归档集里；
 *   - `unowned`：「未分组」——外壳侧边栏那一组（`ungrouped`，见上）；这一类的界面对照物是归属那一
 *     格，不另挂标签；
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
  /** 折叠出的标题（可能没有，见 `src/session-title.ts`）：搜索时与 id 一起当关键词。 */
  readonly title?: string
  readonly ungrouped?: boolean
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
  if (key === 'unowned') return session.ungrouped === true
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
 * 关键词命中：**标题与 id 都算**。
 *
 * id 永远在，标题可能没有（老会话、日志里就没有标题事件），所以两个都搜——按 id 指名道姓与按标题
 * 回忆"我上次问的那个"都是真实需求，区别只是行上显示哪一个（见 `planRows.sessionLabel`）。
 * 大小写不敏感；空白串 = 没有关键词。
 */
export function matchesQuery(session: SessionFacts, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if ((session.title ?? '').toLowerCase().includes(needle)) return true
  return session.id.toLowerCase().includes(needle)
}

/**
 * 这一条该不该出现在筛过之后的列表里：关键词与类别**都要**过。
 *
 * 两者是两条独立的轴（"搜 foo" ＋ "只看空白"= foo 里的空白），所以是「与」而不是「或」。
 */
export function matchesFilters(session: SessionFacts, keys: readonly FilterKey[], query = ''): boolean {
  if (!matchesQuery(session, query)) return false
  if (keys.length === 0) return true
  return keys.some((key) => matchesFilter(session, key))
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
  query = '',
): T[] {
  return sessions.filter((session) => matchesFilters(session, keys, query))
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
