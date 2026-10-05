/**
 * 会话列表的共用骨架：三个分页里"一行会话长什么样、怎么勾、挂哪几枚标签、列表框的框、筛选条"都从
 * 这里出。
 *
 * 这三件事原先在每个分页里各写了一遍（`.dsm-rowExport` / `.dsm-rowPick` / `.dsm-rowManage` 三份
 * 行标记，`formatBytes` / `formatTime` 三份，标签判断两份），代价已经出现过两次：时间格式在迁移页
 * 是另一套（那边绕了一圈 ISO 串），「未分组」那枚标签在三页里叫两个名字。一处逻辑写三遍，改一处
 * 就会漏两处——所以共用的边界划在**一行的解剖结构**与**列表的框**上。
 *
 * 留在各分页里的，是各页自己的东西：传输页的组头（按目录分组，见 `groups.ts`）、会话页的归属那一格
 * 与删除计划、迁移页的「全部 / 子集」单选框与备份回滚。
 *
 * 样式只在 [styles.ts](./styles.ts) 里定义，颜色只用 `--dsw-alias-*` 主题 token。
 *
 * @module dsh-session-manager/client/sessionList
 */

import * as React from 'react'

import { ChevronIcon, SessionIcon, WorkspaceIcon } from './icons.tsx'
import { projectLabel, sessionLabel } from '../logic/planRows.ts'
import {
  attributeKeys,
  filterCounts,
  matchesFilters,
  type AttributeKey,
  type FilterKey,
  type SessionFacts,
} from '../logic/sessionFilter.ts'
import type { SessionManagerKey, Translate } from '../logic/locales.ts'

/** 一行会话要显示的字段（三个分页传进来的 `SessionSummary` 都满足它）。 */
export interface RowSession extends SessionFacts {
  readonly cwd?: string
  readonly createdAt: number
  readonly bytes: number
}

/** 一行的列组合：导出 / 挑选是五列，会话页多一格归属。 */
export type RowVariant = 'export' | 'pick' | 'manage'

const ROW_CLASS: Record<RowVariant, string> = {
  export: 'dsm-row dsm-rowExport',
  pick: 'dsm-row dsm-rowPick',
  manage: 'dsm-row dsm-rowManage',
}

/**
 * 缩进一级的行标记（`depth` = 0 时不加）。
 *
 * 级数在 `groups.ts` 里已经封顶（`MAX_NEST_DEPTH`），这里再夹一道只是防止调用方给出别的数：
 * 类名写错不会报错、不会崩，只会让那一行**不缩进**（父子关系看着断了），所以两处都写死。
 */
export function nestClass(depth: number): string {
  if (!Number.isFinite(depth) || depth <= 0) return ''
  return ` dsm-rowNest${Math.min(Math.floor(depth), 3)}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** 时间那一格的显示格式只写一份（原先三个分页各一份，迁移页那份还绕了一圈 ISO 串）。 */
function formatDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 毫秒时间戳 → "YYYY-MM-DD HH:mm"（会话行的 `createdAt` 就是它）。读不出来写破折号。 */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  return formatDate(date)
}

/**
 * ISO 串 → 同一套 "YYYY-MM-DD HH:mm"。
 *
 * 备份清单里的时间是 JSON 里的串（`journal.ts` 写进去的就是 ISO），与会话行那种毫秒时间戳不是一回事，
 * 所以入参分两个函数、输出共用一份。读不出来时原样返回：清单里的值至少还是条线索，比破折号有用。
 */
export function formatStamp(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return formatDate(new Date(ms))
}

export function totalBytes(sessions: readonly { bytes: number }[]): number {
  return sessions.reduce((sum, session) => sum + session.bytes, 0)
}

/**
 * 一枚行内标签的两句字典键：`key` 是标签本身、`tip` 是"这条会话为什么是这样"的说明。
 *
 * 两处都收窄成字典键集而不是 `string`：芯片、行标签、筛选框三处共用同一批键，写成 `string` 时
 * 打错一个键不会报错，只会在界面上露出键名。
 */
export type TagCopy = { key: SessionManagerKey; tip: SessionManagerKey }

/** 行上的属性标签 → 字典键（文案与"这条会话为什么是这样"的说明）。 */
export const ATTRIBUTE_TAGS: Record<AttributeKey, TagCopy> = {
  subagent: { key: 'tag.subagent', tip: 'tag.subagentTip' },
  blank: { key: 'tag.blank', tip: 'tag.blankTip' },
  archived: { key: 'tag.archived', tip: 'tag.archivedTip' },
  live: { key: 'tag.live', tip: 'tag.liveTip' },
}

/**
 * 「未分组」那枚标签 / 那枚芯片。
 *
 * 一个事实一个名字：外壳侧边栏里那个组、迁移页那个来源、这里这枚标签，说的都是**侧边栏那一组**
 * （"谁都没认领它，而且默认视图下它会显示"），所以三处都叫「未分组」，判据也共用
 * `session.ungrouped`（原先列表里叫「未登记在册」，同一件事两个名字）。
 */
export const UNGROUPED_TAG: TagCopy = { key: 'list.ungrouped', tip: 'list.ungroupedTip' }

/**
 * 这一行该挂哪几枚标签。
 *
 * 属性标签**能挂几枚挂几枚**（空白且已归档的两枚都挂）：它们既是"侧边栏为什么不显示它"的答案，也是
 * "这条会话是什么"的标记，而筛选条正是按后者工作的——只挂宿主先判的那一枚，筛「已归档」时就会冒出
 * 几行没有归档标签的会话。
 *
 * @param options.ungrouped 这一页「未分组」那枚标签有没有信息量：会话页的归属那一格已经写着它，不挂；
 *   迁移页切到「未分组」来源时每一行都不在册，也不挂（标了等于没标）。
 */
export function sessionTags(
  session: SessionFacts,
  options: { ungrouped: boolean },
): TagCopy[] {
  const tags = attributeKeys(session).map((key) => ATTRIBUTE_TAGS[key])
  if (options.ungrouped && session.ungrouped === true) tags.push(UNGROUPED_TAG)
  return tags
}

export interface SessionRowProps {
  session: RowSession
  variant: RowVariant
  checked: boolean
  onToggle: () => void
  /** 归属那一格（只有会话页有这一列，给了才渲染）。 */
  owner?: string
  /** 「未分组」那枚标签在这一页有没有信息量（见 sessionTags）。 */
  ungroupedTag?: boolean
  /** 缩进级数：这条会话是子智能体、挂在上面那张父行下面时 > 0（见 groups.nestSessions）。 */
  depth?: number
  /** 名字后面跟一枚小标签（父会话在别的目录组里时用它说明父在哪儿）；文案由调用方翻好。 */
  note?: { text: string; tip: string }
  /**
   * 这一行不能单独勾：子智能体跟着父会话走（要动它得勾上面那条父会话，见 family.ts）。
   *
   * 勾选框**禁用**而不是"允许勾但拒绝执行"：能勾的集合就该是"单独操作不会被拒的集合"，
   * 否则用户只能靠试错发现自己点错了。提示里写明该勾哪一条。
   */
  locked?: { tip: string }
  t: Translate
}

/** 列表里的一行：勾选框、标记、标题（+标签）、可选的归属、字节、时间。 */
export function SessionRow({
  session,
  variant,
  checked,
  onToggle,
  owner,
  ungroupedTag = true,
  depth = 0,
  note,
  locked,
  t,
}: SessionRowProps): React.ReactElement {
  // 行上显示标题、id 退到悬浮提示（见 planRows.sessionLabel）。
  const label = sessionLabel(session)
  const tags = sessionTags(session, { ungrouped: ungroupedTag })
  return (
    <label className={`${ROW_CLASS[variant]}${nestClass(depth)}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={locked !== undefined}
        title={locked?.tip}
        onChange={onToggle}
      />
      <SessionIcon />
      {/* 标题与标签同占一格：标签跟着名字走，名字自己负责省略（见 .dsm-rowLabel）。 */}
      <span className="dsm-rowLabel">
        <span className={label.kind === 'title' ? 'dsm-rowTitle' : 'dsm-rowId'} title={label.tip}>
          {label.text}
        </span>
        {tags.map((tag) => (
          <span key={tag.key} className="dsm-tag dsm-tagIdle" title={t(tag.tip)}>
            {t(tag.key)}
          </span>
        ))}
        {note !== undefined && (
          <span className="dsm-tag dsm-tagIdle" title={note.tip}>
            {note.text}
          </span>
        )}
      </span>
      {owner !== undefined && (
        <span className="dsm-meta" title={session.cwd ?? ''}>
          {owner}
        </span>
      )}
      <span className="dsm-meta">{formatBytes(session.bytes)}</span>
      <span className="dsm-meta">{formatTime(session.createdAt)}</span>
    </label>
  )
}

/**
 * 只读的一行：确认弹窗里那份计划清单用它（没有勾选框，也不该能点）——删除的"将要被删掉"、迁移的
 * "将要被搬走"都是它。
 *
 * @param className 行标记由调用方给（`.dsm-rowPlan` 是四列，与可勾选的那些不一样）。
 * @param metaTitle 字节那一格的悬浮提示（删除计划里给的是会话目录，迁移计划里是源会话目录）。
 * @param note 名字后面跟一枚小标签（清单用它说明"这条是跟着谁来的"）；文案由调用方翻好。
 * @param depth 缩进级数（级联带进来的那些缩进到点名的那条下面，见 groups.nestClass）。
 */
export function SessionStaticRow({
  session,
  className,
  metaTitle,
  note,
  depth = 0,
}: {
  session: RowSession
  className: string
  metaTitle?: string
  note?: { text: string; tip: string }
  depth?: number
}): React.ReactElement {
  const label = sessionLabel(session)
  return (
    <div className={`${className}${nestClass(depth)}`}>
      <SessionIcon />
      <span className="dsm-rowLabel">
        <span className={label.kind === 'title' ? 'dsm-rowTitle' : 'dsm-rowId'} title={label.tip}>
          {label.text}
        </span>
        {note !== undefined && (
          <span className="dsm-tag dsm-tagIdle" title={note.tip}>
            {note.text}
          </span>
        )}
      </span>
      <span className="dsm-meta" title={metaTitle}>
        {formatBytes(session.bytes)}
      </span>
      <span className="dsm-meta">{formatTime(session.createdAt)}</span>
    </div>
  )
}

/**
 * 三态勾选框。
 *
 * `indeterminate` 不是能写进 JSX 的属性（那是 DOM 节点上的状态），只能在节点上赋值——少了这一步，
 * 组里勾了一部分时选框画成"空"，用户会以为自己的操作没生效。
 */
export function GroupCheckbox({
  checked,
  indeterminate,
  label,
  onToggle,
}: {
  checked: boolean
  indeterminate: boolean
  label: string
  onToggle: () => void
}): React.ReactElement {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate
  }, [indeterminate, checked])
  return (
    <input ref={ref} type="checkbox" checked={checked} aria-label={label} title={label} onChange={onToggle} />
  )
}

export interface SessionGroupHeadProps {
  /** 这一组的目录路径（分组键本身）。 */
  path: string
  /** 已登记工作区才有标题（注册表里的名字）。 */
  title?: string
  /**
   * 这个目录的项目身份（仓库的 git remote，`host/owner/repo`）；认不出来时没有。
   *
   * 有身份时**那一格显示的就不是本机路径**——路径退到它的悬浮提示里（见 `planRows.projectLabel()`）。
   */
  repo?: string
  /** 这一组**列出来的**有几条（筛过之后就是筛剩下的）。 */
  count: number
  picked: number
  /** 收起状态（只影响画不画组内的行，不影响"列出来了哪些"）。 */
  collapsed: boolean
  onToggle: () => void
  onToggleCollapse: () => void
  t: Translate
}

/**
 * 按目录分组时的组头：折叠开关、整组勾选的入口，外加这一组的条数与已选数。
 *
 * 折叠开关在**最前**（树的惯例：左缘是"这一组能不能折"的位置）。它换来的是组内那些行整体多缩进一格：
 * 组头的勾选框与组内行的勾选框差 16px，"行挂在组头下面"这件事才读得出来，而组头自己的内容因此右移了
 * 一个开关的宽度（见 styles.ts 里 .dsm-group > .dsm-row 的 padding-left 与它的注释）。
 *
 * 右端那两串数字是**一整块**：宁可让路径截断，也不要把它拆到第二行去（那样组长成两行，看着像坏掉了）。
 * 收起时这两串数字照样在——一个目录收起来之后，"里面有几条、勾了几条"正是最该看见的东西。
 *
 * 结构上组头是"一个 div 装着按钮与 label"，而不是"一个 label 包住一切"：折叠标记必须是按钮（可聚焦、
 * 带 `aria-expanded`），而 label 里放按钮是非法嵌套（labelable 元素只能是被标注的那一个），点击行为
 * 也会两头打架。于是整组勾选那一块单独包成 label（点组头其余任意一处仍等于勾上／取消整组）。
 */
export function SessionGroupHead({
  path,
  title,
  repo,
  count,
  picked,
  collapsed,
  onToggle,
  onToggleCollapse,
  t,
}: SessionGroupHeadProps): React.ReactElement {
  // 称呼规则集中在 `planRows.projectLabel()`：组头上只摆名字，项目身份与本机路径一起进它的悬浮提示
  // （见那个函数的说明）。列表、同步弹窗与两个下拉框读的是同一份口径。
  const label = projectLabel({ path, title, repo }, t)
  return (
    <div className="dsm-groupHead">
      <button
        type="button"
        className="dsm-groupToggle"
        aria-expanded={!collapsed}
        aria-label={t('list.toggleGroup', { name: label.name })}
        title={t('list.toggleGroup', { name: label.name })}
        onClick={onToggleCollapse}
      >
        <ChevronIcon />
      </button>
      <label className="dsm-groupPick">
        <GroupCheckbox
          checked={count > 0 && picked === count}
          indeterminate={picked > 0 && picked < count}
          label={t('list.selectGroup', { name: label.name })}
          onToggle={onToggle}
        />
        <WorkspaceIcon />
        <span className="dsm-groupTitle" title={label.tip}>
          {label.name}
        </span>
        {/* 有项目身份的目录挂一枚主机名标签：整条身份太长（会被截断），而"这是认得出身份的仓库"值得
            扫一眼就看见——标签的悬浮提示里给全整条身份。 */}
        {label.host !== undefined && (
          <span className="dsm-tag dsm-tagIdle" title={repo}>
            {label.host}
          </span>
        )}
        {title === undefined && path !== '' && <span className="dsm-tag dsm-tagIdle">{t('list.unregisteredDir')}</span>}
        <span className="dsm-groupCounts">
          <span className="dsm-hint">{t('list.sessionsInDir', { count })}</span>
          <span className="dsm-hint">{t('list.selected', { count: picked })}</span>
        </span>
      </label>
    </div>
  )
}

/**
 * 折叠状态：一堆组的键，收起的是哪几个。
 *
 * 只存**收起的**那些（空集合 = 全都展开）：默认全展开是最常见的用法，而"全部展开"于是等于清空。
 * 键是路径（`groups.groupKey`），所以筛掉又筛回来、换个筛选条件，收起状态都跟着那个目录走。
 *
 * @param keys 眼下列出来的那些组的键。收起／展开全部只对它们生效——不画出来的组是什么状态，看不出来，
 *   也不必记住；筛回来时它是展开的，反而更符合"我刚切了个筛选"的预期。
 */
export interface GroupCollapse {
  readonly isCollapsed: (key: string) => boolean
  /** 眼下这些组全都收着（"全部收起"因此没什么可做）。 */
  readonly allCollapsed: boolean
  /** 眼下至少收着一组（"全部展开"才有意义）。 */
  readonly anyCollapsed: boolean
  readonly toggle: (key: string) => void
  readonly collapseAll: () => void
  readonly expandAll: () => void
}

export function useGroupCollapse(keys: readonly string[]): GroupCollapse {
  const [collapsed, setCollapsed] = React.useState<readonly string[]>([])
  const toggle = React.useCallback((key: string): void => {
    setCollapsed((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))
  }, [])
  const collapseAll = React.useCallback((): void => setCollapsed([...keys]), [keys])
  const expandAll = React.useCallback((): void => setCollapsed([]), [])
  return {
    isCollapsed: (key) => collapsed.includes(key),
    allCollapsed: keys.length > 0 && keys.every((key) => collapsed.includes(key)),
    anyCollapsed: keys.some((key) => collapsed.includes(key)),
    toggle,
    collapseAll,
    expandAll,
  }
}

/** 分组列表的工具栏：一句话说明分组方式，加一对"全部收起 / 全部展开"。 */
export function SessionGroupTools({ collapse, t }: { collapse: GroupCollapse; t: Translate }): React.ReactElement {
  return (
    <div className="dsm-groupTools">
      <span className="dsm-hint">{t('list.groupedByDir')}</span>
      <button type="button" className="dsm-button" disabled={collapse.allCollapsed} onClick={collapse.collapseAll}>
        {t('list.collapseAll')}
      </button>
      <button type="button" className="dsm-button" disabled={!collapse.anyCollapsed} onClick={collapse.expandAll}>
        {t('list.expandAll')}
      </button>
    </div>
  )
}

/**
 * 列表框。
 *
 * @param fixed 这个列表会不会随筛选变行数。会的话高度必须固定（见 styles.ts 的 `.dsm-listFixed`）：
 *   框一变矮，整页跟着变矮，设置弹窗外层那条滚动条就一进一出，占位滚动条的环境里整个卡片会横移 15px。
 */
export function SessionListBox({
  fixed = false,
  children,
}: {
  fixed?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return <div className={fixed ? 'dsm-list dsm-listFixed' : 'dsm-list'}>{children}</div>
}

/** 框里的空态。放在框**里面**，框才不会因为"没内容"而消失。 */
export function SessionListEmpty({ text }: { text: string }): React.ReactElement {
  return <p className="dsm-empty">{text}</p>
}

/**
 * 一个列表的筛选状态：类别芯片（多选＝任一命中）、关键词，以及每一类各有多少条。
 *
 * 计数是对**传进来的这一批**数的，不随当前筛选或关键词跳（会跳的计数没人信得过）。
 */
export interface SessionFilter {
  readonly filters: readonly FilterKey[]
  readonly query: string
  readonly counts: Record<FilterKey, number>
  /** 有芯片或关键词在起作用（界面据此报"显示 N / M 条"）。 */
  readonly active: boolean
  readonly matches: (session: SessionFacts) => boolean
  readonly toggle: (key: FilterKey) => void
  readonly clear: () => void
  readonly setQuery: (query: string) => void
}

export function useSessionFilter(sessions: readonly SessionFacts[]): SessionFilter {
  const [filters, setFilters] = React.useState<readonly FilterKey[]>([])
  const [query, setQuery] = React.useState('')
  const counts = React.useMemo(() => filterCounts(sessions), [sessions])
  const matches = React.useCallback(
    (session: SessionFacts) => matchesFilters(session, filters, query),
    [filters, query],
  )
  const toggle = React.useCallback((key: FilterKey): void => {
    setFilters((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))
  }, [])
  const clear = React.useCallback((): void => setFilters([]), [])
  return {
    filters,
    query,
    counts,
    active: filters.length > 0 || query.trim() !== '',
    matches,
    toggle,
    clear,
    setQuery,
  }
}

/** 芯片上的文案：四类属性与行上标签同一份，「未分组」与外壳那一组同名。 */
const CHIP_LABELS: Record<FilterKey, TagCopy> = {
  subagent: ATTRIBUTE_TAGS.subagent,
  blank: ATTRIBUTE_TAGS.blank,
  archived: ATTRIBUTE_TAGS.archived,
  unowned: UNGROUPED_TAG,
  live: ATTRIBUTE_TAGS.live,
}

export interface SessionFilterBarProps {
  /**
   * 列哪几枚类别芯片。
   *
   * 空数组 = 这一页只给搜索框，例如迁移页：它的列表**本来就是候选**（侧边栏看不见的会话按设计不进
   * 候选），健康的那几类芯片在那页永远是 0，摆出来只会让人以为筛选坏了。
   */
  keys: readonly FilterKey[]
  filter: SessionFilter
  t: Translate
}

/**
 * 筛选条：一排类别芯片，底下一行是搜索框与那句说明。
 *
 * 两行是刻意的：胶囊那一行只剩一百来 px 余量（窄 135px 就会换行），把那句说明或搜索框塞进去，容器
 * 一窄就整块换行、位置乱跳（见 styles.ts 的 .dsm-filters 注释）。搜索框单独一行则两边都固定。
 */
export function SessionFilterBar({ keys, filter, t }: SessionFilterBarProps): React.ReactElement {
  const chips = keys.length > 0
  return (
    <>
      {chips && (
        <div className="dsm-filters">
          <span className="dsm-hint">{t('list.filter.label')}</span>
          <button
            type="button"
            className="dsm-filter"
            aria-pressed={filter.filters.length === 0}
            onClick={filter.clear}
          >
            {t('list.filter.all')}
          </button>
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              className="dsm-filter"
              aria-pressed={filter.filters.includes(key)}
              title={t(CHIP_LABELS[key].tip)}
              onClick={() => filter.toggle(key)}
            >
              {t(CHIP_LABELS[key].key)}
              <span className="dsm-filterCount">{filter.counts[key]}</span>
            </button>
          ))}
        </div>
      )}
      <div className="dsm-filterSearch">
        {!chips && <span className="dsm-hint">{t('list.filter.label')}</span>}
        <input
          className="dsm-search"
          type="search"
          value={filter.query}
          placeholder={t('list.filter.search')}
          aria-label={t('list.filter.search')}
          onChange={(event) => filter.setQuery(event.target.value)}
        />
        {chips && <span className="dsm-hint">{t('list.filter.hint')}</span>}
      </div>
    </>
  )
}
