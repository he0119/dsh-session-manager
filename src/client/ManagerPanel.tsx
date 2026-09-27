/**
 * 「会话管理」页的骨架：一条标题行 + 页内分页，把两件事收在同一页里。
 *
 * 为什么是页内分页而不是两个设置分节：导出/导入与迁移都是"对着同一个会话库做一件事"，共用一份
 * 库状态（`/state` 只拉一次）、共用一句"库在哪、有多少条"的说明，分开成两页反而每次都要重新
 * 认一遍上下文。页面本体分别是 [TransferPanel.tsx](./TransferPanel.tsx) 与
 * [MigrationPanel.tsx](./MigrationPanel.tsx)。
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
type PanelKey = 'transfer' | 'migrate'

/** 会话管理页。 */
export function ManagerPanel({ t = fallback, directory }: ManagerPanelProps): React.ReactElement {
  const [state, setState] = React.useState<StateResponse | null>(null)
  const [panel, setPanel] = React.useState<PanelKey>('transfer')
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
        <span className="dsm-title">{t('title')}</span>
        <span className="dsm-sub">
          {t('library')}：{state?.sessionsRoot ?? ''} · {t('sessionsCount', { count: sessions })} ·{' '}
          {t('workspacesCount', { count: workspaces })}
        </span>
        <span className="dsm-spacer" />
        <button type="button" className="dsm-button" onClick={() => void load()} disabled={busy}>
          {busy ? t('loading') : t('refresh')}
        </button>
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

      <div className="dsm-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'transfer'}
          onClick={() => setPanel('transfer')}
        >
          {t('tabTransfer')}
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
      </div>

      {panel === 'transfer' ? (
        <TransferPanel t={t} state={state} reload={load} />
      ) : (
        <MigrationPanel t={t} state={state} reload={load} directory={directory} />
      )}
    </section>
  )
}
