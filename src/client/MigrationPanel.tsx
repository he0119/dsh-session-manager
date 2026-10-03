/**
 * 「迁移」分页：把某个工作区目录下的会话整体搬到另一个目录。
 *
 * Host 半侧的编排在 `src/migrate.ts`，端点在同名路由下；这一层只做三件事：收参数、把**计划**摆清楚、
 * 按用户的确认落地。所有判定都在宿主侧——页面不自己推算会不会成功，也不自己拼路径。
 *
 * 两个刻意的设计：
 *   - **计划与确认同框**：点「迁移」开确认弹窗（见 [ConfirmDialog.tsx](./ConfirmDialog.tsx)），里面
 *     就是 `mode: 'plan'` 的响应（同样的形状、同样的数字），落地按钮在同一个弹窗里；"看到的就是将要
 *     发生的"因此不依赖用户记住上一屏，取消则是关掉弹窗、页面回到按之前的样子；
 *   - 回滚给一份**动作清单**再确认：回滚会搬目录、按字节还原日志、恢复注册表，等于一次真实写入，
 *     所以开弹窗时先 `dryRun` 把动作列出来，用户点确认才动手。
 *
 * @module dsh-session-manager/client/MigrationPanel
 */

import * as React from 'react'

import {
  fetchBackups,
  migrate,
  rollbackBackup,
  type BackupSummary,
  type MigrationRequest,
  type MigrationResponse,
  type RollbackResponse,
} from './api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import {
  SessionFilterBar,
  SessionListBox,
  SessionListEmpty,
  SessionRow,
  SessionStaticRow,
  formatBytes,
  formatStamp,
  useSessionFilter,
} from './sessionList.tsx'
import { translateWith, zh, type Translate } from './locales.ts'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import { normalizePickedPath } from './directory.ts'
import {
  UNOWNED_SOURCE,
  migrateFamilyNote,
  migrationMatching,
  migrationSourceRows,
  optionLabel,
  type PathRow,
} from './planRows.ts'
import type { PanelShare } from './types.ts'

/** 没有注入面时的兜底翻译。 */
const fallback = translateWith(zh as unknown as Record<string, string>)

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
  /** 下拉框空值时的提示（"选源目录…"）。 */
  placeholder: string
  rows: PathRow[]
  value: string
  onChange: (value: string) => void
  /** 宿主目录选择器的能力种类；`null` = 这个宿主没有选择器，不显示「浏览…」。 */
  pickerKind: 'browse' | 'native' | null
  onBrowse: () => void
  /** 「手输路径」是否展开。 */
  manualOpen: boolean
  onToggleManual: () => void
  /** 展开中的浏览框（没展开就是 null）。 */
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
 * 一个目录字段：**一个值控件**（下拉框自己就是那个值）+ 两条"另选一个值"的路。
 *
 * 为什么不是"下拉框只是替文本框挑一个候选"：目录是个任意绝对路径，候选列表永远不可能完整
 * （目标目录甚至可能还没建）。所以这里的下拉框 `value={value}` 直接就是值，且当前值一定在
 * 列表里（见调用处的 `sourceRows`/`targetRows`）；「浏览…」走宿主的目录选择器；
 * 「手输路径」是万能兜底——宿主没有选择器时也能改值。
 *
 * 三段控件是并列的兄弟节点而不是把 `<select>` 套进 `<label>`：一个 label 里塞两个可交互控件，
 * 点哪个都会把焦点给第一个。
 */
function PathField({
  t,
  label,
  placeholder,
  rows,
  value,
  onChange,
  pickerKind,
  onBrowse,
  manualOpen,
  onToggleManual,
  browser,
  manualValue,
}: PathFieldProps): React.ReactElement {
  return (
    <div className="dsm-field">
      <span className="dsm-fieldLabel">{label}</span>
      <div className="dsm-controls">
        <select
          className="dsm-select dsm-selectPath"
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {rows.map((row) => (
            <option key={row.path} value={row.path}>
              {optionLabel(row, t)}
            </option>
          ))}
        </select>
        {pickerKind !== null && (
          <button type="button" className="dsm-button" onClick={onBrowse}>
            {t('browse')}
          </button>
        )}
        <button type="button" className="dsm-button" aria-expanded={manualOpen} onClick={onToggleManual}>
          {manualOpen ? t('collapse') : t('typePath')}
        </button>
      </div>
      {manualOpen && (
        <input
          className="dsm-input"
          type="text"
          aria-label={label}
          value={manualValue ?? value}
          placeholder={t('pathPlaceholder')}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {browser}
    </div>
  )
}

/** 迁移页。 */
export function MigrationPanel({ t = fallback, state, reload, directory }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []
  // 宿主有没有目录选择器、是哪一种；`null`（含旧宿主没这个字段）时不显示「浏览…」。
  const pickerKind = state?.pickerKind ?? null

  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [includeArtifacts, setIncludeArtifacts] = React.useState(false)
  const [includeUnowned, setIncludeUnowned] = React.useState(true)
  const [pickMode, setPickMode] = React.useState<PickMode>('all')
  const [picked, setPicked] = React.useState<readonly string[]>([])

  // 页面内浏览框挂在哪个字段上，以及「手输路径」展开了哪个字段（同一时刻各一个）。
  const [picking, setPicking] = React.useState<'from' | 'to' | null>(null)
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

  const [backups, setBackups] = React.useState<BackupSummary[]>([])
  const [backupRoot, setBackupRoot] = React.useState('')
  const [backupError, setBackupError] = React.useState<string | null>(null)
  /** 正在算回滚动作 / 正在回滚的那份备份目录（按钮据此禁用）。 */
  const [rollbackBusy, setRollbackBusy] = React.useState<string | null>(null)
  /** 回滚 / 恢复弹窗：动作清单与确认按钮在同一块地方（同 ConfirmDialog.tsx 的说明）。 */
  const [rollbackDialog, setRollbackDialog] = React.useState<{
    backup: BackupSummary
    plan: RollbackResponse | null
    error: string | null
  } | null>(null)

  const loadBackups = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetchBackups()
      setBackups(response.backups)
      setBackupRoot(response.backupRoot)
      setBackupError(null)
    } catch (cause) {
      setBackupError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const loaded = React.useRef(false)
  React.useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void loadBackups()
  }, [loadBackups])

  // 库里能按 cwd 匹配到的会话——只是给用户一个勾选面；真正迁移哪些由宿主按源项目目录算。
  // 「未分组」来源不是按 cwd 匹配，而是"注册表没认领、且有 cwd"的那一批（可以横跨多个目录），
  // 判据与宿主侧完全同一条（见 planRows.unownedSessions）。
  const matching = React.useMemo(() => migrationMatching(sessions, from), [sessions, from])

  /**
   * 筛选：这一页**只给搜索框**，不给类别芯片。
   *
   * 列表里那些本来就是"侧边栏看得见的候选"（`migrationMatching` 已经排掉了隐藏会话），子代理 / 空白 /
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
  const sourceOptions = React.useMemo(() => migrationSourceRows(sessions, workspaces, t), [sessions, workspaces, t])

  /**
   * 下拉框里实际列出来的行 = 上面的候选 **+ 当前值本身**。
   *
   * 补这一行是为了让"框里显示的"永远是"真正要用的"：值可能是「浏览…」选回来的、注册表和会话都没
   * 覆盖到的目录（比如刚建的空目录），没有这一行下拉框就只能显示占位符，看着像没选中。
   *
   * 哨兵值（「未分组」）不补：它的行由候选自己给出（带文案），补一个只有哨兵值的行等于把内部的
   * 约定漏到界面上。
   */
  const sourceRows = React.useMemo<PathRow[]>(() => {
    if (from === '' || from === UNOWNED_SOURCE || sourceOptions.some((option) => option.path === from)) {
      return sourceOptions
    }
    return [...sourceOptions, { path: from }]
  }, [sourceOptions, from])

  /** 目标候选：已登记工作区（同一路径只留一条），外加当前值本身。 */
  const targetRows = React.useMemo<PathRow[]>(() => {
    const rows: PathRow[] = []
    const seen = new Set<string>()
    for (const workspace of workspaces) {
      if (seen.has(workspace.path)) continue
      seen.add(workspace.path)
      rows.push({ path: workspace.path, title: workspace.title })
    }
    if (to !== '' && !seen.has(to)) rows.push({ path: to })
    return rows
  }, [workspaces, to])

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
   * 「浏览…」：按**宿主报来的能力种类**决定开哪一种，不试错。
   *
   * 宿主的目录选择器是能力位服务：`native` 只有 `pick()`（在宿主显示器上弹系统对话框），
   * `browse` 只有 `list()`（页面自己画浏览器）。在 `browse` 宿主上硬调 `pick()` 会被宿主以
   * `directory-picker/unavailable` 拒绝——那正是"按钮看着能用、点了必报错"的坑。
   *
   * 取消（`null`）什么都不做：取消就是取消，不该把已选的值清掉。
   */
  const browse = async (which: 'from' | 'to'): Promise<void> => {
    const api = directory?.()
    if (pickerKind === null || api === undefined) {
      setError(t('browseUnavailable'))
      return
    }
    if (pickerKind === 'browse') {
      // 再点一次收起，不额外给一个"关闭"按钮。
      setPicking((current) => (current === which ? null : which))
      return
    }
    try {
      const picked = await api.pick()
      if (picked === null || picked === '') return
      applyPath(which, picked)
    } catch (cause) {
      setError(t('browseFailed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    }
  }

  /** 某个字段展开中的浏览框；没展开、或选择器服务已卸载时什么都不渲染。 */
  const browserFor = (which: 'from' | 'to'): React.ReactNode => {
    const api = directory?.()
    if (picking !== which || api === undefined) return null
    // 起点是这个字段当前的值；「未分组」那个哨兵不是路径，别拿它当起点去问宿主（那会变成
    // 一次"列 '@unowned' 下面有什么"的无意义调用）。
    const value = which === 'from' ? from : to
    return (
      <DirectoryPicker
        t={t}
        api={api}
        startPath={value === UNOWNED_SOURCE ? '' : value}
        onPick={(path) => applyPath(which, path)}
        onClose={() => setPicking(null)}
      />
    )
  }

  /**
   * 点「迁移」：开弹窗，同时把只读的迁移计划取回来（`mode: 'plan'`，不落盘）。
   *
   * 参数不齐时不开口：`needFrom` / `needTo` / `needMigrateSelection` 三句先摆在页面的错误横幅里——
   * 那是"还没到能算计划的地步"，摆进弹窗只会让用户先看一个空框再看到一句抱怨。
   *
   * 计划回来时弹窗可能已经被取消掉了：`current === null` 时原地作废（同「会话」页的删除弹窗）。
   */
  const openMigrate = (): void => {
    if (from.trim() === '') {
      setError(t('needFrom'))
      return
    }
    if (to.trim() === '') {
      setError(t('needTo'))
      return
    }
    if (pickMode === 'subset' && chosen.length === 0) {
      setError(t('needMigrateSelection'))
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
          t('migrateDone', {
            sessions: response.preview.sessions.length,
            rewritten: response.rewritten,
            moved: response.moved,
            artifacts:
              response.artifactsMoved > 0 ? t('migrateArtifactsPart', { count: response.artifactsMoved }) : '',
          }) +
            ' ' +
            (response.verified ? t('verifiedPass') : t('verifiedFail')),
        )
        void reload().then(() => loadBackups())
      },
      (cause) => {
        setBusy(null)
        setPending(null)
        setError(t('failed', { reason: reasonOf(cause) }))
      },
    )
  }

  const preview = pending?.response?.preview ?? null
  const planned = preview !== null && preview.ok
  const registry = preview?.registryChange ?? null

  /**
   * 点备份行上的「回滚」/「恢复」：开弹窗，同时把只读的动作清单取回来（`dryRun: true` 不写盘）。
   *
   * 动作清单是回滚这件事唯一能让用户预先看到的东西（会话目录搬回哪、日志从哪还原、注册表动不动），
   * 所以它必须与确认按钮同框——这正是原来"看回滚动作 → 再点一下回滚"两步之间的那段距离。
   */
  const openRollback = (backup: BackupSummary): void => {
    setBackupError(null)
    setRollbackDialog({ backup, plan: null, error: null })
    setRollbackBusy(backup.dir)
    void rollbackBackup(backup.dir, true).then(
      (response) =>
        setRollbackDialog((current) =>
          current === null || current.backup.dir !== backup.dir ? current : { ...current, plan: response },
        ),
      (cause) =>
        setRollbackDialog((current) =>
          current === null || current.backup.dir !== backup.dir
            ? current
            : { ...current, plan: null, error: reasonOf(cause) },
        ),
    ).finally(() => setRollbackBusy(null))
  }

  /** 弹窗里按「确认回滚 / 确认恢复」：写盘并还原。 */
  const applyRollback = (backup: BackupSummary): void => {
    setRollbackBusy(backup.dir)
    setBackupError(null)
    void rollbackBackup(backup.dir, false).then(
      (response) => {
        setRollbackBusy(null)
        setRollbackDialog(null)
        setNotice(
          t(backup.kind === 'delete' ? 'restoreDone' : 'rollbackDone', {
            sessions: response.sessions,
            files: response.restoredFiles,
          }),
        )
        setEffect(null)
        void reload().then(() => loadBackups())
      },
      (cause) => {
        setRollbackBusy(null)
        setRollbackDialog(null)
        setBackupError(reasonOf(cause))
      },
    )
  }

  return (
    <>
      {error !== null && (
        <p className="dsm-banner dsm-error">
          <span>{error}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setError(null)}>
            {t('dismiss')}
          </button>
        </p>
      )}
      {notice !== null && (
        <p className="dsm-banner dsm-ok">
          <span>{notice}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setNotice(null)}>
            {t('dismiss')}
          </button>
        </p>
      )}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('migrateTitle')}</span>
        </div>
        <p className="dsm-hint">{t('migrateHint')}</p>

        {/*
          源/目标各自只有**一个值控件**：下拉框本身就是那个值（`value={from}`/`value={to}`），
          不是"选一下、填进别处"。任意绝对路径都能进这个框——「浏览…」走宿主自己的目录选择器
          （能力种类由宿主报来，见 browse()），当前值若不在候选里就地补成一个选项。
        */}
        <div className="dsm-fields">
          <PathField
            t={t}
            label={t('fromLabel')}
            placeholder={t('pickSource')}
            rows={sourceRows}
            value={from}
            pickerKind={pickerKind}
            onChange={(value) => {
              setFrom(value)
              setPicked([])
              setEffect(null)
            }}
            onBrowse={() => void browse('from')}
            manualOpen={manual === 'from'}
            onToggleManual={() => setManual((current) => (current === 'from' ? null : 'from'))}
            browser={browserFor('from')}
            {...(unownedSource ? { manualValue: t('ungroupedSource') } : {})}
          />
          <PathField
            t={t}
            label={t('toLabel')}
            placeholder={t('pickTarget')}
            rows={targetRows}
            value={to}
            pickerKind={pickerKind}
            onChange={(value) => {
              setTo(value)
              setEffect(null)
            }}
            onBrowse={() => void browse('to')}
            manualOpen={manual === 'to'}
            onToggleManual={() => setManual((current) => (current === 'to' ? null : 'to'))}
            browser={browserFor('to')}
          />
        </div>

        <label className="dsm-field">
          <span className="dsm-fieldLabel">{t('titleLabel')}</span>
          <input
            className="dsm-input"
            type="text"
            value={title}
            placeholder={t('titlePlaceholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        {/*
          「未分组」来源下这两个开关都没有意义，所以不显示（而不是显示成"能点但没用"）：
          那批会话本来就全都没在册，而产物搬迁要一个"源目录"作基准、跨目录的源给不出来。
          请求里照样按 true / false 发（见 request()），于是界面上看不见的东西也不会改变行为。
        */}
        {unownedSource ? (
          <p className="dsm-hint">{t('unownedSourceHint')}</p>
        ) : (
          <div className="dsm-options">
            <label className="dsm-check">
              <input type="checkbox" checked={includeUnowned} onChange={(event) => setIncludeUnowned(event.target.checked)} />
              <span>{t('includeUnowned')}</span>
            </label>
            <label className="dsm-check">
              <input type="checkbox" checked={includeArtifacts} onChange={(event) => setIncludeArtifacts(event.target.checked)} />
              <span>{t('includeArtifacts')}</span>
            </label>
          </div>
        )}

        <div className="dsm-field">
          <span className="dsm-fieldLabel">{t('pickScopeLabel')}</span>
          <div className="dsm-options">
            <label className="dsm-check">
              <input type="radio" name="dsm-pick" checked={pickMode === 'all'} onChange={() => setPickMode('all')} />
              <span>{t('allSessions')}</span>
            </label>
            <label className="dsm-check">
              <input type="radio" name="dsm-pick" checked={pickMode === 'subset'} onChange={() => setPickMode('subset')} />
              <span>
                {pickMode === 'subset' ? t('selectedCount', { count: chosen.length }) : t('pickSubsetLabel')}
              </span>
            </label>
            <span className="dsm-hint">
              {matching.length > 0 ? t('sourceSessions', { count: matching.length }) : t('sourceSessionsNone')}
            </span>
          </div>
        </div>

        {matching.length > 0 && (
          <>
            <SessionFilterBar keys={[]} filter={filter} t={t} />
            <div className="dsm-options">
              <span className="dsm-hint">{pickMode === 'all' ? t('pickTickHint') : t('pickSubsetHint')}</span>
              {pickMode === 'subset' && (
                <>
                  <span className="dsm-spacer" />
                  <button type="button" className="dsm-button" onClick={() => setPicked(matching.map((session) => session.id))}>
                    {t('selectAllInSource')}
                  </button>
                  <button type="button" className="dsm-button" onClick={() => setPicked([])}>
                    {t('clearPick')}
                  </button>
                </>
              )}
            </div>
            <SessionListBox fixed>
              {listed.length === 0 && <SessionListEmpty text={t('noMatch')} />}
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
            {t('migrateAction')}
          </button>
        </div>

        {/* 落地之后的结论：弹窗关了，这三件事（复核 / 备份位置 / 生效方式）还得留在页面上。 */}
        {effect !== null && (
          <div className="dsm-effect">
            <p className={effect.verified ? 'dsm-ok' : 'dsm-warn'}>
              {effect.verified ? t('verifiedPass') : t('verifiedFail')}
              {effect.backupDir !== undefined ? ` · ${effect.backupDir}` : ''}
            </p>
            <p className={effect.takesEffect === 'immediate' ? 'dsm-hint' : 'dsm-warn'}>
              {effect.takesEffect === 'immediate' ? t('effectImmediate') : t('effectRestart')}
            </p>
          </div>
        )}
      </div>

      {/* 迁移弹窗：计划与「确认」同框（见 ConfirmDialog.tsx 的说明）。 */}
      {pending !== null && (
        <ConfirmDialog
          t={t}
          title={t('migrateDialogTitle')}
          confirmLabel={t('migrateApply')}
          busyLabel={t('migrating')}
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
                {t('migrateSummary', {
                  sessions: preview.sessions.length,
                  files: preview.files,
                  bytes: formatBytes(preview.bytes),
                })}
              </p>
              {/* 级联带进来的子代理要说明白：勾的是一条父会话，清单里却多出几条没勾过的。 */}
              {preview.cascaded > 0 && <p className="dsm-hint">{t('migrateFamily', { count: preview.cascaded })}</p>}
              <p className="dsm-hint">
                {preview.unowned
                  ? t('migrateProjectDirsUnowned', { projectDirs: preview.sourceProjectDirs.length, to: preview.targetProjectDir })
                  : t('migrateProjectDirs', { from: preview.sourceProjectDir, to: preview.targetProjectDir })}
              </p>

              {preview.problems.length > 0 && (
                <div className="dsm-problems">
                  <p className="dsm-warn">
                    {t('problemsTitle')}（{preview.problems.length}）
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
                  <p className="dsm-fields-label">{t('registryChangeTitle')}</p>
                  <ul className="dsm-listPlain">
                    {registry === null || registry.unchanged ? (
                      <li>{t('registryUnchanged')}</li>
                    ) : (
                      <>
                        <li>{registry.createdTarget ? t('registryCreateTarget') : t('registryReuseTarget')}</li>
                        {registry.added.length > 0 && <li>{t('registryAdded', { count: registry.added.length })}</li>}
                        {registry.adoptedFromUnowned.length > 0 && (
                          <li>{t('registryAdopted', { count: registry.adoptedFromUnowned.length })}</li>
                        )}
                        {registry.movedFrom.length > 0 && <li>{t('registryMoved', { count: registry.movedFrom.length })}</li>}
                        {registry.removedSources.length > 0 && (
                          <li>{t('registryRemoved', { count: registry.removedSources.length })}</li>
                        )}
                      </>
                    )}
                  </ul>
                </div>
              )}

              {preview.artifacts !== null && (
                <p className="dsm-hint">
                  {t('artifactsPlanned', { count: preview.artifacts.moves })}
                  {preview.artifacts.skipped.length > 0
                    ? ` · ${t('artifactsSkipped', { count: preview.artifacts.skipped.length })}`
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

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('backupTitle')}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => void loadBackups()} disabled={rollbackBusy !== null}>
            {t('refresh')}
          </button>
        </div>
        <p className="dsm-hint">{t('backupHint')}</p>
        {backupRoot !== '' && (
          <p className="dsm-hint">
            {t('backupRootLabel')}：{backupRoot}
          </p>
        )}

        {backupError !== null && <p className="dsm-banner dsm-error">{backupError}</p>}

        {backups.length === 0 ? (
          <p className="dsm-empty">{t('noBackups')}</p>
        ) : (
          <div className="dsm-list">
            {backups.map((backup) => (
              <div key={backup.dir} className="dsm-backupRow">
                <div className="dsm-backupMain">
                  <span className="dsm-rowId">
                    {formatStamp(backup.createdAt)}
                    {/* 这份备份是迁移留下的还是删除留下的：删除的那份点「恢复」，迁移的那份点「回滚」。 */}
                    <span className="dsm-tag dsm-tagIdle">
                      {backup.kind === 'delete' ? t('backupKindDelete') : t('backupKindMigrate')}
                    </span>
                  </span>
                  <span className="dsm-hint">{t('backupRow', { sessions: backup.sessions, artifacts: backup.artifacts })}</span>
                  {(backup.from !== undefined || backup.to !== undefined) && (
                    <span className="dsm-meta" title={backup.dir}>
                      {backup.from ?? '—'} → {backup.to ?? '—'}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="dsm-button"
                  onClick={() => openRollback(backup)}
                  disabled={rollbackBusy !== null}
                >
                  {backup.kind === 'delete' ? t('restoreAction') : t('rollbackAction')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 回滚 / 恢复弹窗：动作清单与「确认」同框（见 ConfirmDialog.tsx 的说明）。 */}
      {rollbackDialog !== null && (
        <ConfirmDialog
          t={t}
          title={t(rollbackDialog.backup.kind === 'delete' ? 'restoreDialogTitle' : 'rollbackDialogTitle')}
          confirmLabel={t(rollbackDialog.backup.kind === 'delete' ? 'restoreConfirm' : 'rollbackConfirm')}
          busyLabel={t(rollbackDialog.backup.kind === 'delete' ? 'restoring' : 'rollingBack')}
          busy={rollbackBusy === rollbackDialog.backup.dir}
          planning={rollbackDialog.plan === null && rollbackDialog.error === null}
          error={rollbackDialog.error}
          disabled={rollbackDialog.plan === null}
          onConfirm={() => applyRollback(rollbackDialog.backup)}
          onCancel={() => setRollbackDialog(null)}
        >
          {rollbackDialog.plan !== null && (
            <>
              <p className="dsm-warn">
                {t(rollbackDialog.backup.kind === 'delete' ? 'restoreActions' : 'rollbackActions', {
                  count: rollbackDialog.plan.actions.length,
                })}
              </p>
              <ul className="dsm-listPlain">
                {rollbackDialog.plan.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}
