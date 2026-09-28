/**
 * 「会话管理」页的骨架：一条标题行 + 页内分页，把三件事收在同一页里。
 *
 * 为什么是页内分页而不是三个设置分节：导出/导入、迁移、逐条管理都是"对着同一个会话库做一件事"，
 * 共用一份库状态（`/state` 只拉一次）、共用一句"库在哪、有多少条"的说明，分开成三页反而每次都要
 * 重新认一遍上下文。页面本体分别是 [TransferPanel.tsx](./TransferPanel.tsx)、
 * [MigrationPanel.tsx](./MigrationPanel.tsx) 与 [ManagePanel.tsx](./ManagePanel.tsx)。
 *
 * 分页切换会**卸载**另一个分页：本地草稿（勾选、预演结果）随之清掉。这是有意的——一个预演结果
 * 不该在切走再切回来之后还留着，让人以为它还是刚刚算出来的那份。
 *
 * @module dsh-session-manager/client/ManagerPanel
 */

import * as React from 'react'

import { fetchState, type StateResponse } from './api.ts'
import type { DirectoryApi } from './directory.ts'
import { translateWith, zh, type Translate } from './locales.ts'
import { ManagePanel } from './ManagePanel.tsx'
import { MigrationPanel } from './MigrationPanel.tsx'
import { TransferPanel } from './TransferPanel.tsx'

/**
 * 页面获得的注入面：`t` 与 `directory` 都由注册时的 `inject()` 给出。
 *
 * 两个都可缺席（`t` 缺席时回落到中文、选择器缺席时界面上给提示），为的是注入面一旦变形状
 * 也只是少个能力，而不是整页白屏。
 */
export interface ManagerPanelProps {
  t?: Translate
  directory?: () => DirectoryApi | undefined
}

/** 没有注入面时的兜底翻译。 */
const fallback = translateWith(zh as unknown as Record<string, string>)

/** 页内分页。 */
type PanelKey = 'transfer' | 'migrate' | 'manage'

/** 会话管理页。 */
export function ManagerPanel({ t = fallback, directory }: ManagerPanelProps): React.ReactElement {
  const [state, setState] = React.useState<StateResponse | null>(null)
  // 默认停在第一个页签（「会话」）：它是这一页的日常视图，另外两页是偶发动作。
  const [panel, setPanel] = React.useState<PanelKey>('manage')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setState(await fetchState())
    } catch (cause) {
      setError(t('failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(false)
    }
  }, [t])

  // 只跑一次：`t` 不进依赖是有意的——它是渲染期重新绑定的函数，进了依赖会变成每次渲染都重读。
  const loaded = React.useRef(false)
  React.useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void load()
  }, [load])

  const sessions = state?.sessions.length ?? 0
  const workspaces = state?.workspaces.length ?? 0

  return (
    <section className="dsm-root" data-plugin="dsh-session-manager">
      <header className="dsm-head">
        <div className="dsm-titleRow">
          <h2 className="dsm-title">{t('title')}</h2>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => void load()} disabled={busy}>
            {busy ? t('loading') : t('refresh')}
          </button>
        </div>
        <p className="dsm-intro">
          {t('library')}：{state?.sessionsRoot ?? ''} · {t('sessionsCount', { count: sessions })} ·{' '}
          {t('workspacesCount', { count: workspaces })}
        </p>
      </header>

      {error !== null && (
        <p className="dsm-banner dsm-error">
          <span>{error}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setError(null)}>
            {t('dismiss')}
          </button>
        </p>
      )}

      {/*
        页签顺序：日常的「会话」在最前、「传输」在最后。顺序与页签、页面本体两处都跟着走对齐，
        默认页就是第一个（见上面 useState 的初值）。
      */}
      <div className="dsm-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'manage'}
          onClick={() => setPanel('manage')}
        >
          {t('tabManage')}
        </button>
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'migrate'}
          onClick={() => setPanel('migrate')}
        >
          {t('tabMigrate')}
        </button>
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'transfer'}
          onClick={() => setPanel('transfer')}
        >
          {t('tabTransfer')}
        </button>
      </div>

      {panel === 'manage' && <ManagePanel t={t} state={state} reload={load} />}
      {panel === 'migrate' && <MigrationPanel t={t} state={state} reload={load} directory={directory} />}
      {panel === 'transfer' && <TransferPanel t={t} state={state} reload={load} />}
    </section>
  )
}
