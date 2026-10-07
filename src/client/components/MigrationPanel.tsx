/**
 * 「迁移」分页：把某个工作区目录下的会话整体搬到另一个目录。
 *
 * Host 半侧的编排在 `src/migrate.ts`，端点在同名路由下；这一层只做三件事：收参数、把**计划**摆清楚、
 * 按用户的确认落地。所有判定都在宿主侧——页面不自己推算会不会成功，也不自己拼路径。
 *
 * 一个刻意的设计：**计划与确认同框**——点「迁移」开确认弹窗（见 [ConfirmDialog.tsx](./ConfirmDialog.tsx)），
 * 里面就是 `mode: 'plan'` 的响应（同样的形状、同样的数字），落地按钮在同一个弹窗里；"看到的就是将要
 * 发生的"因此不依赖用户记住上一屏，取消则是关掉弹窗、页面回到之前的样子。
 *
 * 这一页只做迁移这一件事：迁移留下的那份备份（以及删除、同步覆盖留下的）在「备份」分页里，见
 * [BackupPanel.tsx](./BackupPanel.tsx)。
 *
 * @module dsh-session-manager/client/MigrationPanel
 */

import * as React from 'react'

import { migrate, type MigrationRequest, type MigrationResponse } from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import {
  SessionFilterBar,
  SessionListBox,
  SessionListEmpty,
  SessionRow,
  SessionStaticRow,
  formatBytes,
  useSessionFilter,
} from './sessionList.tsx'
import type { Translate } from '../logic/locales.ts'
import { CandidatePanel } from './CandidatePanel.tsx'
import { ChevronIcon } from './icons.tsx'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import { normalizePickedPath } from '../directory.ts'
import {
  UNOWNED_SOURCE,
  migrateFamilyNote,
  migrationMatching,
  migrationSourceRows,
  pathLabel,
  type PathRow,
} from '../logic/planRows.ts'
import type { PanelShare } from '../types.ts'

/** 异常 → 一句话（弹窗正文与横幅共用）。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 一次落地之后的结论：复核过没过、备份在哪、要不要重启（原样透出宿主报的三件事）。 */
interface MigrationEffect {
  verified: boolean
  backupDir?: string
  takesEffect: MigrationResponse['takesEffect']
}

/** 会话选择：全部，或从匹配到的会话里勾几条。 */
type PickMode = 'all' | 'subset'

/** 一个目录字段的入参。 */
interface PathFieldProps {
  t: Translate
  label: string
  /** 值控件空着时的提示（"选源目录…"）。 */
  placeholder: string
  rows: PathRow[]
  value: string
  onChange: (value: string) => void
  /** 点值控件：开／收候选面板。 */
  onChoose: () => void
  /** 候选面板是不是开着（值控件上表达成 `aria-expanded`）。 */
  chooserOpen: boolean
  /** 「手输路径」是否展开。 */
  manualOpen: boolean
  onToggleManual: () => void
  /** 展开中的面板（没展开就是 null）。 */
  browser: React.ReactNode
  /**
   * 「手输路径」输入框里显示的东西（缺省 = 当前值）。
   *
   * 只给「未分组」用：那个值是个内部哨兵（见 planRows.UNOWNED_SOURCE），原样摆进输入框等于让用户
   * 看见一个既不是路径也不是人话的东西；框里显示"未分组"，一敲字就变成真路径（onChange 照旧）。
   */
  manualValue?: string
}

/**
 * 一个目录字段：**一个值控件 + 两条改值的路**。
 *
 * 为什么不是"值控件只是替文本框挑一个候选"：目录是个任意绝对路径，候选列表永远不可能完整（目标目录
 * 甚至可能还没建）。所以值控件的文本**就是那个值**——它是枚按钮，点开的是候选面板（见
 * [CandidatePanel.tsx](./CandidatePanel.tsx)），路径显示不下时截断、完整值在悬浮提示里；「手输路径」
 * 是万能兜底，宿主没有选择器、或要在候选之外敲一个路径时它是唯一的路。
 *
 * 宿主那条（文件系统）不再占字段里的一枚按钮：它进了候选面板的头（`dirPicker.filesystem`），两个
 * 面板在那里互相切。字段里因此只有两件东西——值控件与「手输路径」。
 *
 * 两件控件是并列的兄弟节点而不是把值控件套进 `<label>`：一个 label 里塞两个可交互控件，点哪个都会
 * 把焦点给第一个。
 */
function PathField({
  t,
  label,
  placeholder,
  rows,
  value,
  onChange,
  onChoose,
  chooserOpen,
  manualOpen,
  onToggleManual,
  browser,
  manualValue,
}: PathFieldProps): React.ReactElement {
  /**
   * 值控件上显示什么。
   *
   * 值本身是路径，而路径不是人认得出的东西（`/home/u/dev/x` 与 `/home/u/dev/x-legacy` 在框里只差
   * 几个字符），所以能对上候选时显示候选那一行的称呼（标题／项目名 + 路径，与列表里同一套写法，见
   * `pathLabel()`）。「未分组」是哨兵值、不是路径，显示成人话。
   */
  const current = rows.find((row) => row.path === value)
  const text =
    value === ''
      ? placeholder
      : value === UNOWNED_SOURCE
        ? t('list.ungrouped')
        : current === undefined
          ? value
          : pathLabel(current)
  return (
    <div className="dsm-field">
      <span className="dsm-fieldLabel">{label}</span>
      <div className="dsm-controls">
        <button
          type="button"
          className="dsm-select dsm-selectPath dsm-pathValue"
          // 无障碍名字带上"现在是什么值"：按钮的可见文本会被 aria-label 顶掉，只报字段名的话
          // 屏幕阅读器与语音控制都听不到当前值（下拉框是自己会报值的，这枚按钮不会）。
          aria-label={`${label}：${text}`}
          aria-expanded={chooserOpen}
          title={value === '' ? undefined : value}
          onClick={onChoose}
        >
          <span className="dsm-pathValueText">{text}</span>
          <ChevronIcon />
        </button>
        <button type="button" className="dsm-button" aria-expanded={manualOpen} onClick={onToggleManual}>
          {manualOpen ? t('migrate.path.collapse') : t('migrate.path.type')}
        </button>
      </div>
      {manualOpen && (
        <input
          className="dsm-input"
          type="text"
          aria-label={label}
          value={manualValue ?? value}
          placeholder={t('migrate.path.placeholder')}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {browser}
    </div>
  )
}

/** 迁移页。 */
export function MigrationPanel({ t, state, meta, reload, directory }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []
  // 宿主有没有目录选择器、是哪一种；`null`（含旧宿主没这个字段）时候选面板里不摆「浏览文件系统…」。
  // 这一项来自 `/meta`（与清单无关、先到），所以清单还在读时那枚按钮也不至于晚一步出现。
  const pickerKind = (state ?? meta)?.pickerKind ?? null

  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [includeArtifacts, setIncludeArtifacts] = React.useState(false)
  const [includeUnowned, setIncludeUnowned] = React.useState(true)
  const [pickMode, setPickMode] = React.useState<PickMode>('all')
  const [picked, setPicked] = React.useState<readonly string[]>([])

  /**
   * 展开中的面板挂在哪个字段上、开的是哪一份列表（同一时刻只有一个），以及「手输路径」展开了哪个
   * 字段。
   *
   * 面板有两份列表，`candidates`＝候选面板（值控件点开的那个）、`filesystem`＝宿主的目录浏览框；
   * 两边的头各有一枚按钮互相切（见 `browserFor()`）。
   */
  const [picking, setPicking] = React.useState<{ which: 'from' | 'to'; mode: 'candidates' | 'filesystem' } | null>(
    null,
  )
  const [manual, setManual] = React.useState<'from' | 'to' | null>(null)

  /**
   * 迁移弹窗：`null` = 没开；开了先是一份空壳（计划还在算）。
   *
   * 与「会话」页的删除弹窗同一套形状（计划 + 异常合成一个状态）：没有弹窗就没有要看的计划，取消
   * （或落地成功）之后那份计划也不该留在页面上。
   */
  const [pending, setPending] = React.useState<{ response: MigrationResponse | null; error: string | null } | null>(
    null,
  )
  const [busy, setBusy] = React.useState<'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  /** 上一次落地之后的结论（复核 / 备份 / 生效方式）：弹窗关了之后它还得在页面上留着。 */
  const [effect, setEffect] = React.useState<MigrationEffect | null>(null)

  // 库里能按 cwd 匹配到的会话——只是给用户一个勾选面；真正迁移哪些由宿主按源项目目录算。
  // 「未分组」来源不是按 cwd 匹配，而是"注册表没认领、且有 cwd"的那一批（可以横跨多个目录），
  // 判据与宿主侧完全同一条（见 planRows.unownedSessions）。
  const matching = React.useMemo(() => migrationMatching(sessions, from), [sessions, from])

  /**
   * 筛选：这一页**只给搜索框**，不给类别芯片。
   *
   * 列表里那些本来就是"侧边栏看得见的候选"（`migrationMatching` 已经排掉了隐藏会话），子智能体 / 空白 /
   * 已归档三类在这一页永远是 0——摆出来只会让人以为筛选坏了。搜索按标题或 id 找那几条要搬的。
   */
  const filter = useSessionFilter(matching)
  const listed = React.useMemo(() => matching.filter(filter.matches), [matching, filter.matches])

  /** 当前来源是不是那个跨目录的「未分组」。 */
  const unownedSource = from === UNOWNED_SOURCE

  // 源目录候选 = 已登记工作区 **+ 库里真有会话的目录**（注册表里未必有它：未登记，或记的是旧路径）
  // **+「未分组」**（库里有这类会话时才出现，排在最后：它不是目录，别混进目录堆里）。
  // "只迁其中几条"的第一步是先看见这些会话在哪个目录下，所以每个候选都报**库里的条数**——
  // 注册表的登记条数会骗人：同一个目录下可能还有没登记在册的会话（那些默认也会被一起搬走）。
  const repos = state?.repos
  const sourceOptions = React.useMemo(
    () => migrationSourceRows(sessions, workspaces, t, repos),
    [sessions, workspaces, t, repos],
  )

  /**
   * 候选列表里列出来的行 = 上面的候选 **+ 当前值本身**。
   *
   * 补这一行是为了让"列表里看到的"与"值控件上显示的"对得上：值可能是「浏览文件系统…」选回来的、
   * 注册表和会话都没覆盖到的目录（比如刚建的空目录），没有这一行它既不在候选里、值控件也只剩一串光
   * 秃秃的路径。
   *
   * 哨兵值（「未分组」）不补：它的行由候选自己给出（带文案），补一个只有哨兵值的行等于把内部的
   * 约定漏到界面上。
   */
  const sourceRows = React.useMemo<PathRow[]>(() => {
    if (from === '' || from === UNOWNED_SOURCE || sourceOptions.some((option) => option.path === from)) {
      return sourceOptions
    }
    return [...sourceOptions, { path: from, ...(repos?.[from] === undefined ? {} : { repo: repos[from] }) }]
  }, [sourceOptions, from, repos])

  /** 目标候选：已登记工作区（同一路径只留一条），外加当前值本身。 */
  const targetRows = React.useMemo<PathRow[]>(() => {
    const rows: PathRow[] = []
    const seen = new Set<string>()
    for (const workspace of workspaces) {
      if (seen.has(workspace.path)) continue
      seen.add(workspace.path)
      rows.push({
        path: workspace.path,
        title: workspace.title,
        ...(repos?.[workspace.path] === undefined ? {} : { repo: repos[workspace.path] }),
      })
    }
    if (to !== '' && !seen.has(to)) {
      rows.push({ path: to, ...(repos?.[to] === undefined ? {} : { repo: repos[to] }) })
    }
    return rows
  }, [workspaces, to, repos])

  const chosen = React.useMemo(
    () => (pickMode === 'all' ? matching.map((s) => s.id) : matching.filter((s) => picked.includes(s.id)).map((s) => s.id)),
    [pickMode, matching, picked],
  )

  /**
   * 请求体：全部（或匹配不到）时 `sessionIds` 传 null，让宿主按源的实际内容迁移。
   *
   * 「未分组」来源在这里翻译：`from` 传空串、`unowned: true`（哨兵值只活在界面里）。
   * 那个来源下的会话**全是**没在册的，所以"连同未分组的会话"这个开关对它没有意义，
   * 一律按 true 发（复选框在这个来源下也不显示）；产物搬迁同理不发（跨目录时宿主会拒）。
   */
  const request = (mode: 'plan' | 'apply'): MigrationRequest => ({
    mode,
    from: unownedSource ? '' : from.trim(),
    ...(unownedSource ? { unowned: true } : {}),
    to: to.trim(),
    sessionIds: pickMode === 'subset' ? chosen : null,
    includeUnowned: unownedSource ? true : includeUnowned,
    includeArtifacts: unownedSource ? false : includeArtifacts,
    ...(title.trim() === '' ? {} : { title: title.trim() }),
  })

  /**
   * 落一条路径到某个字段：去掉结尾斜杠后当成值（`cwd` 与注册表里的路径都不带结尾斜杠，
   * 留着 `/a/b/` 会凭空多出一个迁不到任何会话的项目目录）。
   */
  const applyPath = (which: 'from' | 'to', raw: string): void => {
    const path = normalizePickedPath(raw)
    if (path === '') return
    if (which === 'from') {
      setFrom(path)
      setPicked([])
    } else {
      setTo(path)
    }
    setEffect(null)
    setPicking(null)
    setManual(null)
  }

  /**
   * 点值控件（或候选面板头里那枚「候选列表」）：开这一份面板；同一个字段再点一次就收起来。
   *
   * 收起靠"再点一次"而不是又一枚「关闭」按钮：值控件本来就摆在那儿，它自己就是那个开关（面板头里
   * 另有一枚「关闭」，给键盘与不认识这个开关的人用）。
   */
  const toggleCandidates = (which: 'from' | 'to'): void => {
    setPicking((current) =>
      current?.which === which && current.mode === 'candidates' ? null : { which, mode: 'candidates' },
    )
  }

  /**
   * 面板里那枚「浏览文件系统…」：按**宿主报来的能力种类**决定走哪条，不试错。
   *
   * 宿主的目录选择器是能力位服务：`native` 只有 `pick()`（在宿主显示器上弹系统对话框），
   * `browse` 只有 `list()`（页面自己画浏览器）。在 `browse` 宿主上硬调 `pick()` 会被宿主以
   * `directory-picker/unavailable` 拒绝——那正是"按钮看着能用、点了必报错"的坑。
   *
   * 取消（`null`）什么都不做：取消就是取消，不该把已选的值清掉。
   */
  const browseFilesystem = async (which: 'from' | 'to'): Promise<void> => {
    const api = directory?.()
    if (pickerKind === null || api === undefined) {
      setError(t('migrate.path.unavailable'))
      return
    }
    if (pickerKind === 'browse') {
      // 页面内浏览框：就在同一处把列表换成宿主的目录，面板不关。
      setPicking({ which, mode: 'filesystem' })
      return
    }
    try {
      const picked = await api.pick()
      if (picked === null || picked === '') return
      applyPath(which, picked)
    } catch (cause) {
      setError(t('migrate.path.failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    }
  }

  /** 某个字段展开中的面板；没展开时什么都不渲染（文件系统那一份还要选择器服务在）。 */
  const browserFor = (which: 'from' | 'to'): React.ReactNode => {
    if (picking?.which !== which) return null
    const value = which === 'from' ? from : to
    // 起点是这个字段当前的值；「未分组」那个哨兵不是路径，别拿它当起点去问宿主（那会变成
    // 一次"列 '@unowned' 下面有什么"的无意义调用）。
    const startPath = value === UNOWNED_SOURCE ? '' : value
    if (picking.mode === 'filesystem') {
      const api = directory?.()
      if (api === undefined) return null
      return (
        <DirectoryPicker
          t={t}
          api={api}
          startPath={startPath}
          onPick={(path) => applyPath(which, path)}
          onClose={() => setPicking(null)}
          onCandidates={() => setPicking({ which, mode: 'candidates' })}
        />
      )
    }
    return (
      <CandidatePanel
        t={t}
        label={which === 'from' ? t('migrate.from.label') : t('migrate.to.label')}
        rows={which === 'from' ? sourceRows : targetRows}
        value={value}
        onPick={(path) => applyPath(which, path)}
        onClose={() => setPicking(null)}
        // 宿主没有目录选择器时不摆这枚按钮（见 CandidatePanel 的说明）。
        {...(pickerKind === null ? {} : { onFilesystem: () => void browseFilesystem(which) })}
      />
    )
  }

  /**
   * 点「迁移」：开弹窗，同时把只读的迁移计划取回来（`mode: 'plan'`，不落盘）。
   *
   * 参数不齐时不开口：`migrate.needFrom` / `migrate.needTo` / `migrate.needSelection` 三句先摆在页面的错误横幅里——
   * 那是"还没到能算计划的地步"，摆进弹窗只会让用户先看一个空框再看到一句抱怨。
   *
   * 计划回来时弹窗可能已经被取消掉了：`current === null` 时原地作废（同「会话」页的删除弹窗）。
   */
  const openMigrate = (): void => {
    if (from.trim() === '') {
      setError(t('migrate.needFrom'))
      return
    }
    if (to.trim() === '') {
      setError(t('migrate.needTo'))
      return
    }
    if (pickMode === 'subset' && chosen.length === 0) {
      setError(t('migrate.needSelection'))
      return
    }
    setError(null)
    setNotice(null)
    setPending({ response: null, error: null })
    void migrate(request('plan')).then(
      (response) => setPending((current) => (current === null ? current : { ...current, response })),
      (cause) => setPending((current) => (current === null ? current : { response: null, error: reasonOf(cause) })),
    )
  }

  /**
   * 弹窗里按「确认迁移」：真的搬（宿主那边是同一个 `buildRelocationPlan()`，只是这次落盘并复核）。
   *
   * 落地失败但正文里带着完整结果（计划不 ok / 复核没过）时把那份结果摆回弹窗里——用户正看着清单，
   * 新的问题清单就该出现在同一个位置；请求本身没走通（网络、参数被拒）才抛给页面横幅并关掉弹窗。
   */
  const applyMigration = (): void => {
    setBusy('apply')
    setError(null)
    void migrate(request('apply')).then(
      (response) => {
        setBusy(null)
        if (!response.applied) {
          setPending((current) => (current === null ? current : { ...current, response }))
          return
        }
        setPending(null)
        setEffect({
          verified: response.verified,
          ...(response.backupDir === undefined ? {} : { backupDir: response.backupDir }),
          takesEffect: response.takesEffect,
        })
        setNotice(
          t('migrate.done', {
            sessions: response.preview.sessions.length,
            rewritten: response.rewritten,
            moved: response.moved,
            artifacts:
              response.artifactsMoved > 0 ? t('migrate.doneArtifacts', { count: response.artifactsMoved }) : '',
          }) +
            ' ' +
            (response.verified ? t('verify.pass') : t('verify.fail')),
        )
        void reload()
      },
      (cause) => {
        setBusy(null)
        setPending(null)
        setError(t('error.failed', { reason: reasonOf(cause) }))
      },
    )
  }

  const preview = pending?.response?.preview ?? null
  const planned = preview !== null && preview.ok
  const registry = preview?.registryChange ?? null
  /**
   * 这次改动会不会**需要重启**才被宿主承认：预演那次按宿主端口的探测说（见 src/web.ts 的迁移端点），
   * 摆在弹窗里当事前提醒。注册表本来就不用改（`unchanged`）时没有"生效"可谈，不摆这一句。
   */
  const plannedRestart =
    planned && registry !== null && !registry.unchanged && pending?.response?.takesEffect === 'restart-required'

  return (
    <>
      {error !== null && (
        <p className="dsm-banner dsm-error">
          <span>{error}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setError(null)}>
            {t('error.dismiss')}
          </button>
        </p>
      )}
      {notice !== null && (
        <p className="dsm-banner dsm-ok">
          <span>{notice}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setNotice(null)}>
            {t('error.dismiss')}
          </button>
        </p>
      )}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('migrate.title')}</span>
        </div>
        <p className="dsm-hint">{t('migrate.hint')}</p>

        {/*
          源/目标各自只有**一个值控件**：那是一枚按钮，文本本身就是那个值（不是"选一下、填进别处"），
          点开的是候选面板——候选、筛选、选中都在面板里（见 CandidatePanel.tsx）；当前值若不在候选里
          也补进行里（见 sourceRows/targetRows），于是值控件显示的就是列表里那一行。
        */}
        <div className="dsm-fields">
          <PathField
            t={t}
            label={t('migrate.from.label')}
            placeholder={t('migrate.from.pick')}
            rows={sourceRows}
            value={from}
            onChange={(value) => {
              setFrom(value)
              setPicked([])
              setEffect(null)
            }}
            onChoose={() => toggleCandidates('from')}
            // 只有候选面板开在这个字段上时才叫 expanded：切到宿主的浏览框之后，这枚按钮点下去
            // 开回来的是候选面板（见 toggleCandidates）。
            chooserOpen={picking !== null && picking.which === 'from' && picking.mode === 'candidates'}
            manualOpen={manual === 'from'}
            onToggleManual={() => setManual((current) => (current === 'from' ? null : 'from'))}
            browser={browserFor('from')}
            {...(unownedSource ? { manualValue: t('list.ungrouped') } : {})}
          />
          <PathField
            t={t}
            label={t('migrate.to.label')}
            placeholder={t('migrate.to.pick')}
            rows={targetRows}
            value={to}
            onChange={(value) => {
              setTo(value)
              setEffect(null)
            }}
            onChoose={() => toggleCandidates('to')}
            chooserOpen={picking !== null && picking.which === 'to' && picking.mode === 'candidates'}
            manualOpen={manual === 'to'}
            onToggleManual={() => setManual((current) => (current === 'to' ? null : 'to'))}
            browser={browserFor('to')}
          />
        </div>

        <label className="dsm-field">
          <span className="dsm-fieldLabel">{t('migrate.workspaceTitle.label')}</span>
          <input
            className="dsm-input"
            type="text"
            value={title}
            placeholder={t('migrate.workspaceTitle.placeholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        {/*
          「未分组」来源下这两个开关都没有意义，所以不显示（而不是显示成"能点但没用"）：
          那批会话本来就全都没在册，而产物搬迁要一个"源目录"作基准、跨目录的源给不出来。
          请求里照样按 true / false 发（见 request()），于是界面上看不见的东西也不会改变行为。
        */}
        {unownedSource ? (
          <p className="dsm-hint">{t('migrate.from.unownedHint')}</p>
        ) : (
          <div className="dsm-options">
            <label className="dsm-check">
              <input type="checkbox" checked={includeUnowned} onChange={(event) => setIncludeUnowned(event.target.checked)} />
              <span>{t('migrate.includeUnowned')}</span>
            </label>
            <label className="dsm-check">
              <input type="checkbox" checked={includeArtifacts} onChange={(event) => setIncludeArtifacts(event.target.checked)} />
              <span>{t('migrate.includeArtifacts')}</span>
            </label>
          </div>
        )}

        <div className="dsm-field">
          <span className="dsm-fieldLabel">{t('migrate.scope.label')}</span>
          <div className="dsm-options">
            <label className="dsm-check">
              <input type="radio" name="dsm-pick" checked={pickMode === 'all'} onChange={() => setPickMode('all')} />
              <span>{t('migrate.scope.all')}</span>
            </label>
            <label className="dsm-check">
              <input type="radio" name="dsm-pick" checked={pickMode === 'subset'} onChange={() => setPickMode('subset')} />
              <span>
                {pickMode === 'subset' ? t('list.selected', { count: chosen.length }) : t('migrate.scope.subset')}
              </span>
            </label>
            <span className="dsm-hint">
              {matching.length > 0 ? t('migrate.source.count', { count: matching.length }) : t('migrate.source.none')}
            </span>
          </div>
        </div>

        {matching.length > 0 && (
          <>
            <SessionFilterBar keys={[]} filter={filter} t={t} />
            <div className="dsm-options">
              <span className="dsm-hint">{pickMode === 'all' ? t('migrate.scope.tickHint') : t('migrate.scope.subsetHint')}</span>
              {pickMode === 'subset' && (
                <>
                  <span className="dsm-spacer" />
                  <button type="button" className="dsm-button" onClick={() => setPicked(matching.map((session) => session.id))}>
                    {t('migrate.scope.selectAll')}
                  </button>
                  <button type="button" className="dsm-button" onClick={() => setPicked([])}>
                    {t('migrate.scope.clear')}
                  </button>
                </>
              )}
            </div>
            <SessionListBox fixed>
              {listed.length === 0 && <SessionListEmpty text={t('list.noMatch')} />}
              {listed.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  variant="pick"
                  checked={pickMode === 'subset' && picked.includes(session.id)}
                  onToggle={() => {
                    // 在「全部」下勾某一条 = 我指的就是这一条：顺势切到子集，不要求用户先改单选框
                    if (pickMode === 'all') setPickMode('subset')
                    setPicked((current) =>
                      current.includes(session.id) ? current.filter((id) => id !== session.id) : [...current, session.id],
                    )
                  }}
                  // 切到「未分组」来源时每一行都不在册，标了等于没标，于是不挂这枚标签。
                  ungroupedTag={!unownedSource}
                  t={t}
                />
              ))}
            </SessionListBox>
          </>
        )}

        <div className="dsm-controls">
          <button
            type="button"
            className="dsm-button dsm-primary"
            onClick={openMigrate}
            disabled={busy !== null}
          >
            {t('migrate.action')}
          </button>
        </div>

        {/* 落地之后的结论：弹窗关了，这三件事（复核 / 备份位置 / 生效方式）还得留在页面上。 */}
        {effect !== null && (
          <div className="dsm-effect">
            <p className={effect.verified ? 'dsm-ok' : 'dsm-warn'}>
              {effect.verified ? t('verify.pass') : t('verify.fail')}
              {effect.backupDir !== undefined ? ` · ${effect.backupDir}` : ''}
            </p>
            {/* **只在需要重启时说话**（与同步页同一口径）：宿主自己接住时这里再说一句"无需重启"只是噪音，
                而两句话都用同一个颜色时反而分不出哪句是坏消息。 */}
            {effect.takesEffect === 'restart-required' && <p className="dsm-warn">{t('effect.restart')}</p>}
          </div>
        )}
      </div>

      {/* 迁移弹窗：计划与「确认」同框（见 ConfirmDialog.tsx 的说明）。 */}
      {pending !== null && (
        <ConfirmDialog
          t={t}
          title={t('migrate.dialogTitle')}
          confirmLabel={t('migrate.apply')}
          busyLabel={t('migrate.running')}
          busy={busy === 'apply'}
          planning={pending.response === null && pending.error === null}
          error={pending.error}
          disabled={!planned}
          onConfirm={applyMigration}
          onCancel={() => setPending(null)}
        >
          {preview !== null && (
            <>
              <p className={preview.ok ? 'dsm-ok' : 'dsm-warn'}>
                {t('migrate.summary', {
                  sessions: preview.sessions.length,
                  files: preview.files,
                  bytes: formatBytes(preview.bytes),
                })}
              </p>
              {/* 级联带进来的子智能体要说明白：勾的是一条父会话，清单里却多出几条没勾过的。 */}
              {preview.cascaded > 0 && <p className="dsm-hint">{t('migrate.family', { count: preview.cascaded })}</p>}
              <p className="dsm-hint">
                {preview.unowned
                  ? t('migrate.projectDirsUnowned', { projectDirs: preview.sourceProjectDirs.length, to: preview.targetProjectDir })
                  : t('migrate.projectDirs', { from: preview.sourceProjectDir, to: preview.targetProjectDir })}
              </p>

              {preview.problems.length > 0 && (
                <div className="dsm-problems">
                  <p className="dsm-warn">
                    {t('problems.title')}（{preview.problems.length}）
                  </p>
                  <ul className="dsm-listPlain">
                    {preview.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </div>
              )}

              {planned && (
                <div className="dsm-registry">
                  <p className="dsm-fields-label">{t('registry.change.title')}</p>
                  <ul className="dsm-listPlain">
                    {registry === null || registry.unchanged ? (
                      <li>{t('registry.unchanged')}</li>
                    ) : (
                      <>
                        <li>{registry.createdTarget ? t('registry.create') : t('registry.reuse')}</li>
                        {registry.added.length > 0 && <li>{t('registry.added', { count: registry.added.length })}</li>}
                        {registry.adoptedFromUnowned.length > 0 && (
                          <li>{t('registry.adopted', { count: registry.adoptedFromUnowned.length })}</li>
                        )}
                        {registry.movedFrom.length > 0 && <li>{t('registry.moved', { count: registry.movedFrom.length })}</li>}
                        {registry.removedSources.length > 0 && (
                          <li>{t('registry.removed', { count: registry.removedSources.length })}</li>
                        )}
                      </>
                    )}
                  </ul>
                </div>
              )}

              {/* 事前提醒：这次改动要不要重启才被宿主承认，得在按「确认迁移」**之前**说出来
                  （判据与"注册表本来就不用改"那一条见上面的 `plannedRestart`）。 */}
              {plannedRestart && <p className="dsm-warn">{t('effect.plannedRestart')}</p>}

              {preview.artifacts !== null && (
                <p className="dsm-hint">
                  {t('artifacts.planned', { count: preview.artifacts.moves })}
                  {preview.artifacts.skipped.length > 0
                    ? ` · ${t('artifacts.skipped', { count: preview.artifacts.skipped.length })}`
                    : ''}
                </p>
              )}

              {/* 逐条列出会被搬走的会话：摘要报的是数字，这里才是"哪几条"。 */}
              {preview.sessions.length > 0 && (
                <SessionListBox>
                  {preview.sessions.map((session) => (
                    <SessionStaticRow
                      key={session.id}
                      session={session}
                      className="dsm-row dsm-rowPlan"
                      metaTitle={session.sourceDir}
                      // 级联进来的那些缩进一级并挂「随父迁」：勾的是一条父会话，清单里却多出几条（同删除清单）。
                      depth={session.via === undefined ? 0 : 1}
                      note={migrateFamilyNote(session, t)}
                    />
                  ))}
                </SessionListBox>
              )}
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}
