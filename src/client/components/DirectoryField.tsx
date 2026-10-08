/**
 * 目录字段：**一枚值控件 + 两条改值的路**（候选面板 / 手输路径），外加宿主那条「浏览文件系统…」。
 *
 * 「迁移」的源目录与目标目录、「导入」的落地目录问的是同一件事——"用哪个目录"，所以三处是同一个组件、
 * 同一份候选面板、同一套展开状态，改一处三处一起动（见
 * [决策](../../../.agents/notes/implemented/architecture/2026-10-07-directory-field-picks-from-a-panel.md)）。
 *
 * 为什么不是原生下拉框：候选是"有多少个工作区就有多少条"，而 `<option>` 只有一行可用——名字、身份、
 * 路径、条数只能挤成一串、挤不下就截断，也没有悬浮提示，找一条只能滚动或靠打字跳行首。值控件只有一行
 * 可用，所以**框里的字就是那个值**（能对上候选时显示候选那一行的称呼，放不下就截断，完整值在悬浮
 * 提示里），点开的是候选面板（见 [CandidatePanel.tsx](./CandidatePanel.tsx)）。
 *
 * 为什么不是"值控件只是替文本框挑一个候选"：目录是个任意绝对路径，候选列表永远不可能完整（目标目录
 * 甚至可能还没建）。所以「手输路径」是万能兜底，宿主没有选择器、或要在候选之外敲一个路径时它是唯一
 * 的路。
 *
 * 展开状态（哪个字段开着哪一份面板、「手输路径」展开了哪一个）由**页面**持有（`useDirectoryFields()`）：
 * 一页里两三个目录字段各开一份候选列表，页面会被撑成两份目录清单，用户也分不清眼下看的是哪一个字段的
 * 候选（每个面板头上写着字段名，但那要读）。
 *
 * 两件控件是并列的兄弟节点而不是把值控件套进 `<label>`：一个 label 里塞两个可交互控件，点哪个都会把
 * 焦点给第一个。
 *
 * @module dsh-session-manager/client/DirectoryField
 */

import * as React from 'react'

import { normalizePickedPath, type DirectoryApi } from '../directory.ts'
import type { Translate } from '../logic/locales.ts'
import { UNOWNED_SOURCE, pathLabel, type PathRow } from '../logic/planRows.ts'
import { CandidatePanel } from './CandidatePanel.tsx'
import { ChevronIcon } from './icons.tsx'
import { DirectoryPicker } from './DirectoryPicker.tsx'

/** 一个字段展开的是哪一份列表。 */
export type DirectoryPanelMode = 'candidates' | 'filesystem'

/** 一页里所有目录字段共用的展开状态。 */
export interface DirectoryFieldControls<K extends string> {
  /** 现在展开着面板的那个字段、以及它开的是哪一份列表；`null` = 一个都没开。 */
  open: { field: K; mode: DirectoryPanelMode } | null
  /** 「手输路径」展开着的字段；`null` = 都收着。 */
  manual: K | null
  /** 点值控件（或面板头那枚切换按钮）：同一个字段同一份列表再点一次 = 收起。 */
  toggle(field: K, mode: DirectoryPanelMode): void
  /** 展开／收起某个字段的「手输路径」。 */
  toggleManual(field: K): void
  /** 面板与「手输路径」都收起（落了一个值之后走这一步）。 */
  settle(): void
}

/**
 * 一页里所有目录字段的展开状态。
 *
 * 状态放在页面上（而不是字段自己身上）只为一件事：**同一时刻只有一个面板开着**。判据见文件头。
 *
 * @returns 展开状态与三个动作。
 */
export function useDirectoryFields<K extends string>(): DirectoryFieldControls<K> {
  const [open, setOpen] = React.useState<{ field: K; mode: DirectoryPanelMode } | null>(null)
  const [manual, setManual] = React.useState<K | null>(null)
  return {
    open,
    manual,
    toggle: (field, mode) =>
      setOpen((current) => (current?.field === field && current.mode === mode ? null : { field, mode })),
    toggleManual: (field) => setManual((current) => (current === field ? null : field)),
    settle: () => {
      setOpen(null)
      setManual(null)
    },
  }
}

/** 一个目录字段的入参。 */
export interface DirectoryFieldProps<K extends string> {
  /** 注入面给的翻译函数。 */
  t: Translate
  /** 这一页所有目录字段的展开状态（`useDirectoryFields()`）。 */
  controls: DirectoryFieldControls<K>
  /** 本字段的键：在 `controls` 里认自己。 */
  field: K
  /** 字段名（值控件的无障碍名字与候选面板的头都用它）。 */
  label: string
  /** 值控件空着时的提示（"选源目录…"）。 */
  placeholder: string
  /** 候选行（调用方已经补过当前值）。 */
  rows: readonly PathRow[]
  /** 当前值。 */
  value: string
  /** 用户改值（挑了一行、手输、或宿主对话框返回了一条）。 */
  onChange: (value: string) => void
  /**
   * 宿主目录选择器的能力种类；`null`（含旧宿主没这个字段）= 没有。
   *
   * 它决定字段里的宿主那条路怎么走，也决定候选面板头里摆不摆「浏览文件系统…」——不摆一个点了必然报错的
   * 按钮（同[「浏览…」按宿主的能力走](../../../.agents/notes/implemented/bug-fix/2026-09-27-browse-follows-the-picker-capability.md)）。
   */
  pickerKind: 'browse' | 'native' | null
  /** 宿主目录选择器（注入面给的 thunk；宿主没提供时没有）。 */
  directory?: () => DirectoryApi | undefined
  /** 出事时往页面横幅上报一句（这个字段自己不做横幅）。 */
  onError: (message: string) => void
  /**
   * 「手输路径」输入框里显示的东西（缺省 = 当前值）。
   *
   * 只给「未分组」用：那个值是个内部哨兵（见 planRows.UNOWNED_SOURCE），原样摆进输入框等于让用户
   * 看见一个既不是路径也不是人话的东西；框里显示"未分组"，一敲字就变成真路径（onChange 照旧）。
   */
  manualValue?: string
}

/** 一个目录字段。 */
export function DirectoryField<K extends string>({
  t,
  controls,
  field,
  label,
  placeholder,
  rows,
  value,
  onChange,
  pickerKind,
  directory,
  onError,
  manualValue,
}: DirectoryFieldProps<K>): React.ReactElement {
  const api = directory?.()
  // 只有候选面板开在这个字段上时才叫 expanded：切到宿主的浏览框之后，这枚按钮点下去开回来的是候选面板。
  const chooserOpen = controls.open?.field === field && controls.open.mode === 'candidates'
  const manualOpen = controls.manual === field

  /**
   * 落一条路径到字段上：去掉结尾斜杠后当成值（`cwd` 与注册表里的路径都不带结尾斜杠，留着 `/a/b/`
   * 会凭空多出一个迁不到任何会话的项目目录），落完收起面板。
   */
  const apply = (raw: string): void => {
    const path = normalizePickedPath(raw)
    if (path === '') return
    onChange(path)
    controls.settle()
  }

  /**
   * 字段里那条非候选的路：按**宿主报来的能力种类**决定走哪条，不试错。
   *
   * 宿主的目录选择器是能力位服务：`native` 只有 `pick()`（在宿主显示器上弹系统对话框），`browse` 只有
   * `list()`（页面自己画浏览器）。在 `browse` 宿主上硬调 `pick()` 会被宿主以
   * `directory-picker/unavailable` 拒绝——那正是"按钮看着能用、点了必报错"的坑。
   *
   * 取消（`null`）什么都不做：取消就是取消，不该把已选的值清掉。
   */
  const browse = async (): Promise<void> => {
    if (pickerKind === null || api === undefined) {
      onError(t('pathField.unavailable'))
      return
    }
    if (pickerKind === 'browse') {
      // 页面内浏览框：就在同一处把列表换成宿主的目录，面板不关。
      controls.toggle(field, 'filesystem')
      return
    }
    try {
      const picked = await api.pick()
      if (picked === null || picked === '') return
      apply(picked)
    } catch (cause) {
      onError(t('pathField.failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    }
  }

  /**
   * 值控件上显示什么。
   *
   * 值本身是路径，而路径不是人认得出的东西（`/home/u/dev/x` 与 `/home/u/dev/x-legacy` 在框里只差几个
   * 字符），所以能对上候选时显示候选那一行的称呼（标题／项目名 + 路径，见 `pathLabel()`）。「未分组」
   * 是哨兵值、不是路径，显示成人话。
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
          // 无障碍名字带上"现在是什么值"：按钮的可见文本会被 aria-label 顶掉，只报字段名的话屏幕阅读器
          // 与语音控制都听不到当前值（原生下拉框是自己会报值的，这枚按钮不会）。
          aria-label={`${label}：${text}`}
          aria-expanded={chooserOpen}
          title={value === '' ? undefined : value}
          onClick={() => controls.toggle(field, 'candidates')}
        >
          <span className="dsm-pathValueText">{text}</span>
          <ChevronIcon />
        </button>
        <button type="button" className="dsm-button" aria-expanded={manualOpen} onClick={() => controls.toggleManual(field)}>
          {manualOpen ? t('pathField.collapse') : t('pathField.type')}
        </button>
      </div>
      {manualOpen && (
        <input
          className="dsm-input"
          type="text"
          aria-label={label}
          value={manualValue ?? value}
          placeholder={t('pathField.placeholder')}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {/* 起点是这个字段当前的值；「未分组」那个哨兵不是路径，别拿它当起点去问宿主（那会变成一次
          "列 '@unowned' 下面有什么"的无意义调用）。 */}
      {controls.open?.field === field && controls.open.mode === 'filesystem' && api !== undefined && (
        <DirectoryPicker
          t={t}
          api={api}
          startPath={value === UNOWNED_SOURCE ? '' : value}
          onPick={apply}
          onClose={controls.settle}
          onCandidates={() => controls.toggle(field, 'candidates')}
        />
      )}
      {chooserOpen && (
        <CandidatePanel
          t={t}
          label={label}
          rows={rows}
          value={value}
          onPick={apply}
          onClose={controls.settle}
          {...(pickerKind === null ? {} : { onFilesystem: () => void browse() })}
        />
      )}
    </div>
  )
}
