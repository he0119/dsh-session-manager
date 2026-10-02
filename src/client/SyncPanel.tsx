/**
 * 「同步」分页：按 WebDAV 配置在多台机器之间拉与推（预演 → 确认）。
 *
 * 为什么单独一页，而不是挂在「传输」底下：两者正交——「传输」是一次性的带走/带回来（选包、选目标、
 * 导出下载），同步是一条**常设**通道：远端地址、机器名、映射表、预演与确认都只属于它。挤在一页时
 * 同步那块只能排在导出列表与导入预演表之后，越用越长；而这一页的第一件事（看一眼远端配没配对、
 * 改一下映射）与「传输」的第一件事（勾哪些会话）也没有先后关系。
 *
 * 分页顺序是「会话 → 迁移 → 传输 → 同步 → 说明」：同步排在传输之后，是因为它落地走的是导入那条
 * 编排（见 README 的「同步」一节），紧挨着读更顺。
 *
 * 这一层只做三件事：调宿主端点、记本地草稿、把结果摆出来。所有判定都在宿主侧
 * （`src/web.ts` + `src/sync.ts`）：预演返回的就是将要发生的事，页面不自己推算。会话库数据由页面
 * 骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉好传进来，切分页不各拉一份。
 *
 * 样式只在 [styles.ts](./styles.ts) 里定义，颜色只用 `--dsw-alias-*` 主题 token；控件是手写的原生
 * 元素，**不 require 宿主的 UI 原语包**——那份包会随时改，而它一抛异常就会让整个 Slot 条目变成崩溃
 * 占位（控制台里是 `slot entry crashed in '…'`）。唯一的例外是同步设置的读写面，它走
 * [SyncConfigForm.tsx](./SyncConfigForm.tsx)，那里说明了为什么。
 *
 * @module dsh-session-manager/client/SyncPanel
 */

import * as React from 'react'

import { applySync, fetchSyncPlan, type SyncPullEntry, type SyncPushEntry, type SyncResponse } from './api.ts'
import { formatBytes } from './sessionList.tsx'
import { SyncConfigForm } from './SyncConfigForm.tsx'
import { translateWith, zh, type Translate } from './locales.ts'
import type { PanelShare } from './types.ts'

/** 没有注入面时的兜底翻译。 */
const fallback = translateWith(zh as unknown as Record<string, string>)

/** 同步计划里一条的显示名：标题优先，没有标题才退到 id（与行上那套口径一致）。 */
function syncName(entry: { id: string; title?: string }): string {
  return entry.title ?? entry.id
}

/** 拉/推两种计划行的公共字段（只为 `syncWhy()` 取字段用）。 */
interface SyncRow {
  code: SyncPullEntry['code'] | SyncPushEntry['code']
  action: string
  machine?: string
  fromCwd?: string
  toCwd?: string
}

/**
 * 「没动」那一类为什么没动：判据在宿主侧的 `code` 上，页面只把它翻成一句话。
 *
 * 认不出来的码退回原始字符串：新增一类关系时界面上会出现一个生词，好过悄悄显示成"已跳过"。
 */
function syncWhy(entry: SyncRow, t: Translate): string {
  switch (entry.code) {
    case 'missing':
      return t(entry.action === 'create' ? 'syncCodeMissingPull' : 'syncCodeMissingPush')
    case 'local-ahead':
      return t('syncCodeLocalAhead')
    case 'remote-ahead':
      return t('syncCodeRemoteAhead', { machine: entry.machine ?? '' })
    case 'diverged':
      return t('syncCodeDiverged', { machine: entry.machine ?? '' })
    case 'no-mapping':
      return t('syncCodeNoMapping', { from: entry.fromCwd ?? '' })
    case 'missing-target':
      return t('syncCodeMissingTarget', { to: entry.toCwd ?? '' })
    default:
      return String(entry.code)
  }
}

/** 同步页。 */
export function SyncPanel({ t = fallback, state, reload }: PanelShare): React.ReactElement {
  const [sync, setSync] = React.useState<SyncResponse | null>(null)
  const [busy, setBusy] = React.useState<'syncPreview' | 'syncApply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  /** 同步配置（宿主插件配置里的 `sync` 块）；`null` 或字段缺席都按"没配置"处理，只画一句说明。 */
  const syncInfo = state?.sync ?? null

  const run = async (kind: 'syncPreview' | 'syncApply', action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (cause) {
      setError(t('failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const doSyncPreview = (): void => {
    void run('syncPreview', async () => {
      setSync(await fetchSyncPlan())
    })
  }

  const doSyncApply = (): void => {
    void run('syncApply', async () => {
      const result = await applySync()
      setSync(result)
      if (result.pulled.length > 0 || result.pushed.length > 0) {
        setNotice(t('syncApplied', {
          pulled: result.pulled.length,
          pushed: result.pushed.length,
          bytesIn: formatBytes(result.bytesIn),
          bytesOut: formatBytes(result.bytesOut),
        }))
      }
      // 拉下来的落到本机库里了：列表与工作区归属都要重读（推的那一侧不改本机任何东西）。
      if (result.pulled.length > 0) await reload()
    })
  }

  const syncPlan = sync?.plan ?? null
  const syncPulls = syncPlan?.pull.filter((entry) => entry.action === 'create') ?? []
  const syncPushes = syncPlan?.push.filter((entry) => entry.action !== 'skip') ?? []
  // 只留"有信息量"的没动项：`identical` 是"远端已经有这一份"，整库同步时它是最多也最没用的一类。
  const syncKept = syncPlan === null
    ? []
    : [
        ...syncPlan.pull.filter((entry) => entry.action === 'skip'),
        ...syncPlan.push.filter((entry) => entry.action === 'skip' && entry.code !== 'identical'),
      ]
  const syncClean = syncPlan !== null && syncPulls.length === 0 && syncPushes.length === 0 && syncKept.length === 0
  /**
   * 上次预演里见过的远端 cwd：交给映射表当候选。
   *
   * 它解决的是这一栏唯一真正难的地方——远端那一侧必须**逐字**对上别的机器记下的路径，而那条路径
   * 靠人背是靠不住的（抄错一个字符，结果就是"没配映射，跳过"）。没预演过时它是空的，行为退回手填。
   */
  const remoteCwds = [
    ...new Set(
      [...(syncPlan?.pull ?? []).map((entry) => entry.fromCwd), ...(syncPlan?.push ?? []).map((entry) => entry.cwd)].filter(
        (cwd): cwd is string => typeof cwd === 'string' && cwd !== '',
      ),
    ),
  ]

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
          <span className="dsm-cardTitle">{t('syncTitle')}</span>
          {syncInfo !== null && (
            <span className="dsm-hint">{t('syncWhere', { url: syncInfo.url, machine: syncInfo.machineId })}</span>
          )}
          {syncInfo !== null && <span className="dsm-spacer" />}
          {syncInfo !== null && (
            <>
              <button type="button" className="dsm-button" onClick={doSyncPreview} disabled={busy !== null}>
                {busy === 'syncPreview' ? t('previewing') : t('syncPreview')}
              </button>
              <button type="button" className="dsm-button dsm-primary" onClick={doSyncApply} disabled={busy !== null}>
                {busy === 'syncApply' ? t('applying') : t('syncApply')}
              </button>
            </>
          )}
        </div>
        {/* 没配置同步时只留一句话：摆一个点了没反应的按钮比不摆更糟（与「宿主没有归档能力」同一条口径）。 */}
        <p className="dsm-hint">
          {syncInfo === null ? t('syncOffHint') : t('syncHint', { mappings: syncInfo.mappings })}
        </p>
        {/* 配置表单就在预演/确认旁边：改完 URL 立刻能预演一次。宿主没有设置接缝时这一块自己说明。 */}
        <SyncConfigForm t={t} onSaved={() => void reload()} remoteCwds={remoteCwds} />

        {sync !== null && syncPlan !== null && (
          <div>
            <p className={syncPlan.ok && sync.problems.length === 0 ? 'dsm-ok' : 'dsm-warn'}>
              {t('syncSummary', {
                pull: syncPlan.pullIds.length,
                push: syncPlan.pushIds.length,
                local: syncPlan.localCount,
                remote: syncPlan.remoteCount,
              })}
              {syncPlan.machines.length > 0 ? ` · ${t('syncMachines', { machines: syncPlan.machines.join('、') })}` : ''}
            </p>
            {sync.applied && sync.pulled.length > 0 && (
              <p className="dsm-hint">
                {sync.takesEffect === 'immediate' ? t('effectImmediate') : t('effectRestart')}
              </p>
            )}
            {sync.problems.map((problem) => (
              <p key={problem} className="dsm-warn">
                {problem}
              </p>
            ))}
            {syncClean && <p className="dsm-ok">{t('syncNothing')}</p>}

            {syncPulls.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncPullHead', { count: syncPulls.length })}</p>
                <table className="dsm-table dsm-planTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('colAction')}</th>
                      <th className="dsm-colSession">{t('colSession')}</th>
                      <th className="dsm-colCwd">{t('colCwd')}</th>
                      <th className="dsm-colBytes">{t('colBytes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {syncPulls.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <span className="dsm-tag dsm-tagCreate">{t('syncCodeMissingPull')}</span>
                        </td>
                        <td>
                          <span className="dsm-rowTitle" title={entry.id}>
                            {syncName(entry)}
                          </span>
                        </td>
                        <td className="dsm-cwd">
                          {entry.toCwd === undefined
                            ? t('cwdKeep')
                            : t('cwdRewritten', { from: entry.fromCwd ?? '', to: entry.toCwd })}
                        </td>
                        <td className="dsm-meta">{formatBytes(entry.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {syncPushes.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncPushHead', { count: syncPushes.length })}</p>
                <table className="dsm-table dsm-planTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('colAction')}</th>
                      <th className="dsm-colSession">{t('colSession')}</th>
                      <th className="dsm-colCwd">{t('colCwd')}</th>
                      <th className="dsm-colBytes">{t('colBytes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {syncPushes.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <span className={`dsm-tag ${entry.code === 'local-ahead' ? 'dsm-tagSkip' : 'dsm-tagCreate'}`}>
                            {entry.code === 'local-ahead' ? t('syncCodeLocalAhead') : t('syncCodeMissingPush')}
                          </span>
                        </td>
                        <td>
                          <span className="dsm-rowTitle" title={entry.id}>
                            {syncName(entry)}
                          </span>
                        </td>
                        <td className="dsm-cwd">{entry.cwd ?? t('noCwd')}</td>
                        <td className="dsm-meta">{formatBytes(entry.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {syncKept.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncKeptHead', { count: syncKept.length })}</p>
                {syncKept.map((entry) => (
                  <p key={entry.id} className="dsm-hint">
                    {t('syncNote', { name: syncName(entry), why: syncWhy(entry, t) })}
                  </p>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
