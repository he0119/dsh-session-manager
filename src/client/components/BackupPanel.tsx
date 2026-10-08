/**
 * 「备份」分页：那几件会写盘的操作共同的后悔面。
 *
 * 为什么单独一页、而不是留在「迁移」页底部：这张清单里躺的不只是迁移留下的备份——删除（`delete`）
 * 与同步覆盖本机那份（`replace`）也各留一份（来源写在 `kind` 上，见 `src/journal.ts`）。它挂在迁移
 * 卡片下面时，界面得在三处替它指路（「会话」页删除成功的横幅、「同步」页的结果与进度说明、说明页
 * 的 FAQ）：一个面板要三处文案引路，就等于承认它不在用户会去找的地方。
 *
 * 两种动作的判据只写在 `isRestore()` 里：迁移留下的那份是"搬走的那份搬回来"，属**回滚**（会话目录、
 * 日志与工作区注册表一起还原）；删除与同步覆盖留下的那份是"备份里那份搬回去"，属**恢复**（注册表
 * 本来就没动过）。老备份没有 `kind` 字段，按迁移处理。
 *
 * 卡片头部只有「刷新」这枚不动数据的工具，行上的「回滚 / 恢复」留在行上——备份天然是一行一份、一行
 * 一个动作，它们不是卡片级的那一枚主动作。
 *
 * @module dsh-session-manager/client/BackupPanel
 */

import * as React from 'react'

import { fetchBackups, rollbackBackup, type BackupSummary, type ProgressEvent, type RollbackResponse } from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ProgressBlock } from './ProgressBlock.tsx'
import { formatStamp } from './sessionList.tsx'
import type { PanelShare } from '../types.ts'

/** 异常 → 一句话（横幅与弹窗正文共用）。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 这份备份点下去是「恢复」还是「回滚」（判据见文件头）。 */
function isRestore(backup: Pick<BackupSummary, 'kind'>): boolean {
  return backup.kind !== undefined && backup.kind !== 'migrate'
}

/** 这份备份是哪一类操作留下的（三种各一枚标签）。 */
function backupKindLabel(
  backup: Pick<BackupSummary, 'kind'>,
): 'backup.kind.migrate' | 'backup.kind.delete' | 'backup.kind.replace' {
  if (backup.kind === 'delete') return 'backup.kind.delete'
  if (backup.kind === 'replace') return 'backup.kind.replace'
  return 'backup.kind.migrate'
}

/** 「备份」分页。 */
export function BackupPanel({ t, reload }: Pick<PanelShare, 't' | 'reload'>): React.ReactElement {
  const [backups, setBackups] = React.useState<BackupSummary[]>([])
  const [backupRoot, setBackupRoot] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  /** 正在算回滚动作 / 正在回滚的那份备份目录（按钮据此禁用）。 */
  const [busy, setBusy] = React.useState<string | null>(null)
  /** 回滚 / 恢复弹窗：动作清单与确认按钮在同一块地方（同 ConfirmDialog.tsx 的说明）。 */
  const [dialog, setDialog] = React.useState<{
    backup: BackupSummary
    plan: RollbackResponse | null
    error: string | null
  } | null>(null)

  /**
   * 最近收到的那条进度事件（见 api.ts 的 `rollbackBackup()`）。
   *
   * 预演也要逐条走一遍清单（`restore` 那一段：目录搬回哪、文件从哪还原），落地还要真的逐文件复写
   * 字节——整库回滚是几十秒的活。
   *
   * 声明排在**最后**（不跟 `busy` 挤在一起）：冒烟用例按位置往 null 状态里种值（见 test/client.test.mjs
   * 的 `nulls`），插在中间会让后面那些种子的位置整体错一格。
   */
  const [progress, setProgress] = React.useState<ProgressEvent | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetchBackups()
      setBackups(response.backups)
      setBackupRoot(response.backupRoot)
      setError(null)
    } catch (cause) {
      setError(reasonOf(cause))
    }
  }, [])

  // 只跑一次：分页切换会卸载这一页，下次进来重新读一遍清单（这正是"刚做完迁移/删除/同步，切过来
  // 就能看见它留下的那一份"的实现方式——那份备份不必由做动作的那一页去通知这里刷新）。
  const loaded = React.useRef(false)
  React.useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void load()
  }, [load])

  /**
   * 点备份行上的「回滚」/「恢复」：开弹窗，同时把只读的动作清单取回来（`dryRun: true` 不写盘）。
   *
   * 动作清单是回滚这件事唯一能让用户预先看到的东西（会话目录搬回哪、日志从哪还原、注册表动不动），
   * 所以它必须与确认按钮同框——这正是原来"看回滚动作 → 再点一下回滚"两步之间的那段距离。
   */
  const open = (backup: BackupSummary): void => {
    setError(null)
    setDialog({ backup, plan: null, error: null })
    setBusy(backup.dir)
    setProgress(null)
    void rollbackBackup(backup.dir, true, setProgress)
      .then(
        (response) =>
          setDialog((current) =>
            current === null || current.backup.dir !== backup.dir ? current : { ...current, plan: response },
          ),
        (cause) =>
          setDialog((current) =>
            current === null || current.backup.dir !== backup.dir ? current : { ...current, plan: null, error: reasonOf(cause) },
          ),
      )
      .finally(() => {
        setBusy(null)
        setProgress(null)
      })
  }

  /** 弹窗里按「确认回滚 / 确认恢复」：写盘并还原。 */
  const apply = (backup: BackupSummary): void => {
    setBusy(backup.dir)
    setError(null)
    setProgress(null)
    void rollbackBackup(backup.dir, false, setProgress).then(
      (response) => {
        setBusy(null)
        setProgress(null)
        setDialog(null)
        setNotice(
          t(isRestore(backup) ? 'backup.restore.done' : 'backup.rollback.done', {
            sessions: response.sessions,
            files: response.restoredFiles,
          }),
        )
        // 还原之后注册表也可能被改回去（回滚会），所以清单与会话库都重读一遍。
        void reload().then(() => load())
      },
      (cause) => {
        setBusy(null)
        setProgress(null)
        setDialog(null)
        setError(reasonOf(cause))
      },
    )
  }

  /** 这份备份此刻正在落地（不是"正在算清单"）。标题、按钮态与正文都按它分岔。 */
  const running = dialog !== null && busy === dialog.backup.dir

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
          <span className="dsm-cardTitle">{t('backup.title')}</span>
          <span className="dsm-spacer" />
          {/* 头部只放这枚"重新读一遍清单"的工具：它不动任何数据，与卡片级的写操作不是一类。 */}
          <button type="button" className="dsm-button" onClick={() => void load()} disabled={busy !== null}>
            {t('page.refresh')}
          </button>
        </div>
        <p className="dsm-hint">{t('backup.hint')}</p>
        {backupRoot !== '' && (
          <p className="dsm-hint">
            {t('backup.rootLabel')}：{backupRoot}
          </p>
        )}

        {backups.length === 0 ? (
          <p className="dsm-empty">{t('backup.empty')}</p>
        ) : (
          <div className="dsm-list">
            {backups.map((backup) => (
              <div key={backup.dir} className="dsm-backupRow">
                <div className="dsm-backupMain">
                  <span className="dsm-rowId">
                    {formatStamp(backup.createdAt)}
                    {/* 这份备份是哪一类操作留下的：删除与同步覆盖的那份点「恢复」，迁移的那份点「回滚」。 */}
                    <span className="dsm-tag dsm-tagIdle">{t(backupKindLabel(backup))}</span>
                  </span>
                  <span className="dsm-hint">{t('backup.row', { sessions: backup.sessions, artifacts: backup.artifacts })}</span>
                  {(backup.from !== undefined || backup.to !== undefined) && (
                    <span className="dsm-meta" title={backup.dir}>
                      {backup.from ?? '—'} → {backup.to ?? '—'}
                    </span>
                  )}
                </div>
                <button type="button" className="dsm-button" onClick={() => open(backup)} disabled={busy !== null}>
                  {t(isRestore(backup) ? 'backup.restore.action' : 'backup.rollback.action')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 回滚 / 恢复弹窗：动作清单与「确认」同框（见 ConfirmDialog.tsx 的说明）。 */}
      {dialog !== null && (
        <ConfirmDialog
          t={t}
          // 落地那一段标题也换掉：这时候已经不是"将要"了，正文里正跑着进度。
          title={t(
            isRestore(dialog.backup)
              ? running
                ? 'backup.restore.running'
                : 'backup.restore.dialogTitle'
              : running
                ? 'backup.rollback.running'
                : 'backup.rollback.dialogTitle',
          )}
          confirmLabel={t(isRestore(dialog.backup) ? 'backup.restore.confirm' : 'backup.rollback.confirm')}
          busyLabel={t(isRestore(dialog.backup) ? 'backup.restore.running' : 'backup.rollback.running')}
          busy={running}
          planning={dialog.plan === null && dialog.error === null}
          // 算动作清单那一段也要逐条走一遍备份（`restore` 那条事件），把静态的「预演中…」换成进度。
          planningDetail={progress === null ? undefined : <ProgressBlock t={t} progress={progress} />}
          error={dialog.error}
          disabled={dialog.plan === null}
          onConfirm={() => apply(dialog.backup)}
          onCancel={() => setDialog(null)}
        >
          {/* 落地：逐条搬目录、逐文件复写字节，正文换成进度（那份动作清单说的是"将要"）。 */}
          {running &&
            (progress === null ? (
              <p className="dsm-hint">{t('progress.waiting')}</p>
            ) : (
              <ProgressBlock t={t} progress={progress} note={t('backup.progress.note')} />
            ))}
          {!running && dialog.plan !== null && (
            <>
              <p className="dsm-warn">
                {t(isRestore(dialog.backup) ? 'backup.restore.actions' : 'backup.rollback.actions', {
                  count: dialog.plan.actions.length,
                })}
              </p>
              <ul className="dsm-listPlain">
                {dialog.plan.actions.map((action) => (
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
