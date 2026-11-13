/**
 * 「导入」弹窗：把一个 `.dshsess` 包里的会话放进本机库。
 *
 * 为什么它是一个**自己的入口**（状态栏上那枚「导入…」）而不是和导出挤同一个弹窗：导出是对勾选的那几条
 * 做事（动作行上那枚按钮就够），导入与勾了什么完全无关——它要的是"哪儿来的包、落到哪个项目"。两件事
 * 唯一的共同点只是都叫"传输"，挤在一面时导出那半只能把外面的列表再画一遍（筛选条、分组、勾选框），
 * 而那正是这一页刚去掉的东西。
 *
 * 这一层只做三件事：调宿主端点、记本地草稿、把结果摆出来。判定都在宿主侧（`src/web.ts` +
 * `src/transfer.ts`）：计划返回的就是将要发生的事，页面不自己推算。
 *
 * 落地那一下**先看清再确认**：点「导入」只算一份只读计划（`mode: 'plan'`），弹窗里逐条列出会写什么
 * （create / skip、cwd 改写到哪），确认了才写盘——与删除、迁移、回滚同一条分界。导出那一边不在这里：
 * 它只把已有字节打成包给浏览器下载，不改本机任何东西，所以那枚按钮按下去就做。
 *
 * @module dsh-session-manager/client/ImportPanel
 */

import * as React from 'react'

import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import { importBundle, type ImportResponse, type ProgressEvent } from '../api.ts'
import type { ImportEntry } from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { DirectoryField, useDirectoryFields } from './DirectoryField.tsx'
import { ProgressBlock } from './ProgressBlock.tsx'
import { useFileDrop } from './useFileDrop.ts'
import { formatBytes, totalBytes } from './sessionList.tsx'
import { chooseBundle } from '../logic/fileDrop.ts'
import { describeCwd, directoryTargetRows, sessionLabel } from '../logic/planRows.ts'
import type { Translate } from '../logic/locales.ts'
import type { PanelShare } from '../types.ts'

/**
 * cwd 那一格：三支分支在 [planRows.ts](../logic/planRows.ts) 里判，这里只挑文案。
 *
 * 跳过的那一支曾经跟着"没有 toCwd"一起被当成"没有 cwd"，把跳过的会话显示成要落 `_no-cwd`。
 */
function cwdText(entry: ImportEntry, t: Translate): string {
  const plan = describeCwd(entry)
  if (plan.kind === 'skip') return t('cwd.skipped')
  if (plan.kind === 'keepNoCwd') return t('cwd.keep')
  return t('cwd.rewritten', { from: plan.from, to: plan.to })
}

/** 「导入」那一面的 props。 */
export interface ImportPanelProps extends Pick<PanelShare, 't' | 'state' | 'meta' | 'reload' | 'directory'> {
  /**
   * 目标目录的初值：左栏「项目」筛着的那个（`null` / 空串就是没筛，不填）。
   *
   * 为什么从那儿来：导入要回答"落到哪个项目"，而用户在看这一页时已经用左栏说过一次了。弹窗里那枚
   * 目录控件照旧可改、可手输——它只是不要再问一遍同样的问题。
   */
  defaultTarget?: string
  /**
   * 从页面上拖进来的那个包（见 ManagerPanel 的落点）。
   *
   * 有它时这一面一打开就已经拿着包了——"把 .dshsess 拖到页面上"这条路不该再多一步选择。
   */
  initialFile?: File
  /** 关掉这一面（取消、右上角叉、Escape、点遮罩）。 */
  onClose: () => void
  /**
   * 落地成功之后要说的那句话，交给页面说（弹窗随后关掉）。
   *
   * 成功时弹窗里没什么可看的：写入的条数与字节正是页面顶部那条提示该报的，列表也已经重读过了。
   */
  onDone: (text: string) => void
}

/** 「导入」弹窗。 */
export function ImportPanel({
  t,
  state,
  meta,
  reload,
  directory,
  defaultTarget = '',
  initialFile,
  onClose,
  onDone,
}: ImportPanelProps): React.ReactElement {
  const [file, setFile] = React.useState<File | null>(null)
  /** 原生文件选择框藏起来了（见下面那个字段的说明），按官方按钮那一下要能转手点它。 */
  const filePicker = React.useRef<HTMLInputElement>(null)
  const [payload, setPayload] = React.useState<ArrayBuffer | null>(null)
  const [target, setTarget] = React.useState(defaultTarget)
  /**
   * 导入弹窗：`null` = 没开；开了先是一份空壳（计划还在算）。
   *
   * 与另外几面同一套形状（见 [ConfirmDialog.tsx](./ConfirmDialog.tsx)）：计划与弹窗开没开合成一个
   * 状态，取消之后那份计划不会留在页面上。
   */
  const [pending, setPending] = React.useState<{ plan: ImportResponse | null; error: string | null } | null>(null)
  const [busy, setBusy] = React.useState<'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  /**
   * 最近收到的那条进度事件（见 api.ts 的 `importBundle()`）。
   *
   * 包上传那一段宿主报不了（那是浏览器与网络的事），收到之后的预演（逐条读包里的日志折标题）与落地
   * （逐条写盘、改写首帧 cwd）是真花时间的两段。
   *
   * 声明排在**最后**（不跟 `busy` 挤在一起）：冒烟用例按位置往 null 状态里种值（见 test/client.test.mjs
   * 的 `nulls`），插在中间会让后面那些种子的位置整体错一格。
   */
  const [progress, setProgress] = React.useState<ProgressEvent | null>(null)

  // 宿主有没有目录选择器、是哪一种；`null`（含旧宿主没这个字段）时候选面板里不摆「浏览文件系统…」。
  // 这一项来自 `/meta`（与清单无关、先到），所以清单还在读时那枚按钮也不至于晚一步出现。
  const pickerKind = (state ?? meta)?.pickerKind ?? null
  /** 落地目录那一个字段的展开状态（这一面只有它一个目录字段）。 */
  const fields = useDirectoryFields<'target'>()
  /** 目标目录的候选：与「迁移」的目标目录同一份构造（见 planRows.directoryTargetRows）。 */
  const targetRows = React.useMemo(
    () => directoryTargetRows(state?.workspaces ?? [], state?.repos, target),
    [state?.workspaces, state?.repos, target],
  )

  /**
   * 收下一个包：选文件、拖进来、页面那层转进来的三条路都走这里。
   *
   * 读完字节才允许「导入」——`payload === null` 时那枚按钮是灰的（见下面的 footer）。
   */
  const acceptFile = React.useCallback(
    (chosen: File | null): void => {
      setFile(chosen)
      setPending(null)
      setError(null)
      if (chosen === null) {
        setPayload(null)
        return
      }
      void chosen
        .arrayBuffer()
        .then((buffer) => setPayload(buffer))
        .catch((cause: unknown) =>
          setError(t('error.failed', { reason: cause instanceof Error ? cause.message : String(cause) })),
        )
    },
    [t],
  )

  const pickFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    acceptFile(event.target.files?.[0] ?? null)
  }

  /**
   * 从页面上拖进来的那一个（`initialFile`）：这一面每次打开都是新挂的，所以只看第一帧。
   *
   * 放在 effect 里而不是渲染期：读 `arrayBuffer()` 是副作用，渲染期做它等于每次重画都读一遍。
   */
  const seeded = React.useRef(false)
  React.useEffect(() => {
    if (seeded.current || initialFile === undefined) return
    seeded.current = true
    acceptFile(initialFile)
  }, [acceptFile, initialFile])

  /** 拖到这一面里的那个包：只认 `.dshsess`，一次一个（判据在 logic/fileDrop.ts）。 */
  const drop = useFileDrop((files) => {
    const choice = chooseBundle(files)
    if (choice.kind === 'empty') return
    if (choice.kind === 'unknownSuffix') {
      setError(t('import.needBundle'))
      return
    }
    acceptFile(choice.file)
  })

  /**
   * 点「导入」：开确认弹窗，同时把只读的导入计划取回来（`mode=plan` 不写盘）。
   *
   * 包与目标目录都得先有：缺哪个就在弹窗里说出缺的那个（`import.needFile` / `import.needTarget`），
   * 而不是先弹一个空框再抱怨——那一步的错与"计划有什么问题"不是一件事。
   *
   * 计划回来时弹窗可能已经被取消掉了：`current === null` 时原地作废（同「会话」页的删除弹窗）。
   */
  const openImport = (): void => {
    if (file === null || payload === null) {
      setError(t('import.needFile'))
      return
    }
    if (target === '') {
      setError(t('import.needTarget'))
      return
    }
    setError(null)
    setPending({ plan: null, error: null })
    setProgress(null)
    void importBundle(payload, target, 'plan', setProgress).then(
      (plan) => {
        setProgress(null)
        setPending((current) => (current === null ? current : { ...current, plan }))
      },
      (cause) => {
        setProgress(null)
        setPending((current) =>
          current === null ? current : { plan: null, error: cause instanceof Error ? cause.message : String(cause) },
        )
      },
    )
  }

  /**
   * 弹窗里按「确认导入」：真写盘。
   *
   * 一条都没写进去（计划里全是 skip，或落地被拒）时把结果摆回弹窗里：冲突原因就在 `problems` 与每行的
   * `reason` 上，用户得看着它改包或改目标，而不是只收到一句"没写成功"。
   */
  const applyImport = (): void => {
    if (payload === null || target === '') return
    setBusy('apply')
    setError(null)
    setProgress(null)
    void importBundle(payload, target, 'apply', setProgress).then(
      (result) => {
        setBusy(null)
        setProgress(null)
        const wrote = result.written?.length ?? 0
        const objects = result.attachmentWritten ?? 0
        /*
         * 落地算成功有两种：写了会话，或**只补了附件对象**（日志早就在库里、图是挂的——重导一次同一个包
         * 正是那条修复路径）。两种都要把弹窗收掉并刷新，否则第二种会被当成"什么都没发生"。
         */
        if (wrote > 0 || objects > 0) {
          const failed = result.attachmentProblems?.length ?? 0
          onDone(
            [
              t('import.done', { count: wrote, bytes: formatBytes(result.bytes) }),
              objects > 0
                ? t('import.doneAttachments', { count: objects, bytes: formatBytes(result.attachmentWrittenBytes ?? 0) })
                : null,
              // 落地失败的那几个对象不静默：界面上那句"图片加载失败"正是它们，而用户在这里才知道是为什么。
              failed > 0 ? t('import.attachmentProblems', { count: failed }) : null,
            ]
              .filter((line): line is string => line !== null)
              .join(' '),
          )
          void reload()
          return
        }
        setPending((current) => (current === null ? current : { ...current, plan: result }))
      },
      (cause) => {
        setBusy(null)
        setProgress(null)
        setPending((current) => (current === null ? current : { ...current, error: cause instanceof Error ? cause.message : String(cause) }))
      },
    )
  }

  const plan = pending?.plan ?? null
  const createCount = plan?.entries.filter((entry) => entry.action === 'create').length ?? 0
  const skipCount = plan?.entries.filter((entry) => entry.action === 'skip').length ?? 0
  /** 包里的附件对象（v1 的老包没有，宿主回的是空数组）。 */
  const planAttachments = plan?.attachments ?? []
  /** 其中会写下去的条数：一条会话都不建、只有它非零时也值得点「确认导入」（补图那条路）。 */
  const attachmentAdds = plan?.attachmentAdds ?? 0
  /** 包里的对象总字节（含本机已有的那些，所以不能拿 `attachmentBytes` 顶替）。 */
  const attachmentTotalBytes = planAttachments.reduce((sum, item) => sum + item.bytes, 0)
  /** 这个宿主落不了的（没有附件服务、认不出引用）：要如实说出来，不能让用户以为图也导进来了。 */
  const attachmentUnavailable = planAttachments.filter((item) => item.action === 'unavailable').length

  /** 弹窗处在哪一段：填表单 → 看计划 → 正在写盘。三段同处一个弹窗（与删除、迁移、回滚同一套形状）。 */
  const phase: 'form' | 'plan' | 'apply' = pending === null ? 'form' : busy === 'apply' ? 'apply' : 'plan'

  return (
    <Modal
      open
      onClose={onClose}
      // 标题跟着那一段走：填表单时是"导入会话包"，看计划时是"将要写入"，写盘时是"导入中…"。
      title={t(phase === 'form' ? 'import.dialogTitle' : phase === 'apply' ? 'import.applying' : 'import.confirmTitle')}
      closeLabel={t('close')}
      className="dsm-dialog"
      contentClassName="dsm-dialogContent"
      /*
        那句说明走官方 `Modal` 的 `description`（标题下面那一行支撑句），而不是塞进正文第一段：
        正文从字段开始，"标题 → 一句为什么/怎么用 → 字段"才是这枚弹窗的读法。上一版把它摆在正文里，
        标题与那句话之间空出四十来像素，看着像漏了一块。
      */
      description={phase === 'form' ? t('import.hint') : undefined}
      /*
        底部这一对走官方 `Modal` 的 footer（与确认弹窗同一处）：官方弹窗自己管右对齐、间距与那颗
        36px 的尺寸，本页不再自己摆一排按钮——上一版把按钮放在正文里靠左，看着像没人收的尾巴。
      */
      footer={
        phase === 'form' ? (
          <>
            <Button variant="outline" data-modal-autofocus="" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button variant="primary" onClick={openImport} disabled={file === null || payload === null}>
              {t('import.action')}
            </Button>
          </>
        ) : (
          <>
            {/*
              「取消」在这一段是**回表单**（不是关窗）：包与目标目录还在，改一改再算一次比重选一遍省事。
              写盘那一趟里它照旧禁用——那几个动作关掉窗口只是把进度藏起来，结果照样会丢。
            */}
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy === 'apply'}>
              {phase === 'apply' ? t('cancel') : t('import.back')}
            </Button>
            <Button
              variant="primary"
              onClick={applyImport}
              disabled={busy === 'apply' || plan === null || !plan.ok || (createCount === 0 && attachmentAdds === 0)}
            >
              {busy === 'apply' ? t('import.applying') : t('import.apply')}
            </Button>
          </>
        )
      }
    >
      {/* 正文自己再包一层（同 ConfirmDialog）：官方 `.body` 不给块间距，而这里摆的是段落 + 字段 + 表格。 */}
      <div className="dsm-dialogBody">
        {error !== null && <p className="dsm-error">{error}</p>}

        {phase === 'form' && (
          <>
            {/* 与「迁移」那一面同一套字段摆法：一件输入一个字段（带标签）。
                文件那一个不摆原生 `<input type="file">`：它会带出浏览器自己那颗「选择文件」灰按钮，与本页
                其余控件（官方 Button 的外观）不是一套。改成官方按钮 + 隐藏的 input，选完之后把文件名写在
                按钮右边。后缀必须与宿主导出的文件名一致（`src/web.ts` 的 `fileName()`）——这里曾经写成
                `.dhsess`：刚导出的包在选择框的过滤器里被挡掉，用户以为导入坏了，所以测试里钉着它。 */}
            <div className="dsm-field">
              <span className="dsm-fieldLabel">{t('import.fileLabel')}</span>
              {/* 这一格既是"选文件"的按钮，也是落点：把 .dshsess 拖到框里就行（虚线是"可以往这儿放"的
                  通用说法）。悬停时描边转品牌色，松手就收下。 */}
              <div className="dsm-dropZone" data-over={drop.over ? 'true' : 'false'} {...drop.handlers}>
                <Button variant="outline" size="sm" onClick={() => filePicker.current?.click()}>
                  {t('import.pickFile')}
                </Button>
                <span className="dsm-hint" title={file === null ? undefined : file.name}>
                  {file === null ? t('import.dropHere') : file.name}
                </span>
              </div>
              <input ref={filePicker} type="file" accept=".dshsess" hidden onChange={pickFile} />
            </div>

            {/* 落地目录：与「迁移」的目标目录是同一个组件、同一份候选（见 DirectoryField.tsx）。 */}
            <DirectoryField
              t={t}
              controls={fields}
              field="target"
              label={t('import.targetLabel')}
              placeholder={t('import.targetPlaceholder')}
              rows={targetRows}
              value={target}
              onChange={(path) => {
                setTarget(path)
                setPending(null)
              }}
              pickerKind={pickerKind}
              directory={directory}
              onError={setError}
            />
          </>
        )}

        {phase !== 'form' && (
          <>
            {/* 写盘那一段：正文换成进度（上面那张计划表说的是"将要"，这时候已经过期了）。 */}
            {phase === 'apply' &&
              (progress === null ? (
                <p className="dsm-hint">{t('progress.waiting')}</p>
              ) : (
                <ProgressBlock t={t} progress={progress} note={t('import.progress.note')} />
              ))}
            {phase === 'plan' && plan === null && (
              <>
                <p className="dsm-hint">{t('dialog.previewing')}</p>
                {progress === null ? null : <ProgressBlock t={t} progress={progress} />}
              </>
            )}
            {phase === 'plan' && plan !== null && (
              <>
                <p className={plan.ok ? 'dsm-ok' : 'dsm-warn'}>
                  {t('import.planSummary', { create: createCount, skip: skipCount, bytes: formatBytes(plan.bytes) })}
                  {plan.error !== undefined ? ` · ${plan.error}` : ''}
                </p>
                {planAttachments.length > 0 && (
                  <p className={attachmentUnavailable > 0 ? 'dsm-warn' : 'dsm-hint'}>
                    {t('import.planAttachments', {
                      attachments: planAttachments.length,
                      bytes: formatBytes(attachmentTotalBytes),
                      adds: attachmentAdds,
                    })}
                    {attachmentUnavailable > 0
                      ? ` ${t('import.planAttachmentsUnavailable', { count: attachmentUnavailable })}`
                      : ''}
                  </p>
                )}
                {plan.note !== undefined && <p className="dsm-hint">{plan.note}</p>}
                {(plan.problems ?? []).map((problem) => (
                  <p key={problem} className="dsm-warn">
                    {problem}
                  </p>
                ))}
                <table className="dsm-table dsm-planTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('table.action')}</th>
                      <th className="dsm-colSession">{t('table.session')}</th>
                      <th className="dsm-colCwd">{t('table.cwd')}</th>
                      <th className="dsm-colBytes">{t('table.bytes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.entries.map((entry) => {
                      const label = sessionLabel(entry)
                      return (
                        <tr key={entry.id}>
                          <td>
                            {/* `dsm-tag` 挂在 Tag 自己身上：styles.ts 的 `.dsm-planTable .dsm-tag` 那条
                                负责"窄列里限宽截断、别顶到邻居那一列"。 */}
                            <Tag className="dsm-tag" tone={entry.action === 'create' ? 'success' : 'quiet'}>
                              {entry.action === 'create' ? t('table.create') : t('table.skip')}
                            </Tag>
                          </td>
                          <td>
                            <span className={label.kind === 'title' ? 'dsm-rowTitle' : 'dsm-rowId'} title={label.tip}>
                              {label.text}
                            </span>
                            {entry.reason !== undefined && <div className="dsm-hint">{entry.reason}</div>}
                          </td>
                          <td className="dsm-cwd">{cwdText(entry, t)}</td>
                          <td className="dsm-meta">{formatBytes(totalBytes(entry.files))}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
