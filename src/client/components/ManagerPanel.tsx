/**
 * 「会话管理」页的骨架：一条标题行 + 页内分页，把三件事收在同一页里。
 *
 * 为什么是页内分页而不是三个设置分节：导出/导入、迁移、逐条管理都是"对着同一个会话库做一件事"，
 * 共用一份库状态（`/state` 只拉一次）、共用一句"库在哪、有多少条"的说明，分开成三页反而每次都要
 * 重新认一遍上下文。页面本体分别是 [TransferPanel.tsx](./TransferPanel.tsx)、
 * [MigrationPanel.tsx](./MigrationPanel.tsx) 与 [ManagePanel.tsx](./ManagePanel.tsx)。
 *
 * 分页切换会**卸载**另一个分页：本地草稿（勾选、弹窗里那份计划）随之清掉。这是有意的——一份计划
 * 不该在切走再切回来之后还留着，让人以为它还是刚刚算出来的那份。
 *
 * @module dsh-session-manager/client/ManagerPanel
 */

import * as React from 'react'

import { fetchState, type StateResponse } from '../api.ts'
import { PLUGIN_COMMIT, PLUGIN_DIRTY, PLUGIN_VERSION } from '../build.ts'
import type { DirectoryApi } from '../directory.ts'
import type { Translate } from '../logic/locales.ts'
import { versionCommit, versionLabel, versionTag } from '../logic/version.ts'
import { HelpPanel } from './HelpPanel.tsx'
import { ManagePanel } from './ManagePanel.tsx'
import { MigrationPanel } from './MigrationPanel.tsx'
import { SyncPanel } from './SyncPanel.tsx'
import { TransferPanel } from './TransferPanel.tsx'

/**
 * 页面获得的注入面：`t` 是**框架 props**（注册时带 `locale: NS` 换来的那一个），`directory` 由
 * 注册时的 `inject()` 给出。
 *
 * `t` 必定在——带 `locale` 注册的条目拿到的就是它；目录选择器可以缺席（那个能力由别的客户端
 * 插件提供），缺席时界面上给提示，而不是整页白屏。
 */
export interface ManagerPanelProps {
  t: Translate
  directory?: () => DirectoryApi | undefined
}

/** 页内分页。 */
type PanelKey = 'transfer' | 'sync' | 'migrate' | 'manage' | 'help'

/** 会话管理页。 */
export function ManagerPanel({ t, directory }: ManagerPanelProps): React.ReactElement {
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
      setError(t('error.failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
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
  // 这一页是哪个构建：构建期写死的版本号，加上直接从 git build 时的短 commit（脏工作区挂 -dirty）。
  const version = versionLabel(PLUGIN_VERSION, PLUGIN_COMMIT, PLUGIN_DIRTY)
  // 提示里版本号与 commit 各占一处，所以这里传的是不带 commit 的那个版本号。
  const versionTip =
    PLUGIN_COMMIT === ''
      ? t('page.version.tip', { version: versionTag(PLUGIN_VERSION) })
      : t('page.version.tipBuild', {
          version: versionTag(PLUGIN_VERSION),
          commit: versionCommit(PLUGIN_COMMIT, PLUGIN_DIRTY),
        })

  return (
    <section className="dsm-root" data-plugin="dsh-session-manager">
      <header className="dsm-head">
        <div className="dsm-titleRow">
          <h2 className="dsm-title">{t('page.title')}</h2>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => void load()} disabled={busy}>
            {busy ? t('page.loading') : t('page.refresh')}
          </button>
        </div>
        <p className="dsm-intro">
          {t('page.library')}：{state?.sessionsRoot ?? ''} · {t('page.count.sessions', { count: sessions })} ·{' '}
          {t('page.count.workspaces', { count: workspaces })}
        </p>
      </header>

      {error !== null && (
        <p className="dsm-banner dsm-error">
          <span>{error}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setError(null)}>
            {t('error.dismiss')}
          </button>
        </p>
      )}

      {/*
        页签顺序：四个动作页按日常程度排（会话 → 迁移 → 传输 → 同步），最后的「说明」是名词解释与
        边界条件——它是一次性读的参考，不该挤在动作页上（详见 HelpPanel.tsx 的取舍）。同步紧挨着传输，
        是因为它落地走的是导入那条编排（见 SyncPanel.tsx 的说明）。顺序与页签、页面本体两处都跟着走
        对齐，默认页就是第一个（见上面 useState 的初值）。
      */}
      <div className="dsm-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'manage'}
          onClick={() => setPanel('manage')}
        >
          {t('page.tab.manage')}
        </button>
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'migrate'}
          onClick={() => setPanel('migrate')}
        >
          {t('page.tab.migrate')}
        </button>
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'transfer'}
          onClick={() => setPanel('transfer')}
        >
          {t('page.tab.transfer')}
        </button>
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'sync'}
          onClick={() => setPanel('sync')}
        >
          {t('page.tab.sync')}
        </button>
        <button
          type="button"
          role="tab"
          className="dsm-tab"
          aria-selected={panel === 'help'}
          onClick={() => setPanel('help')}
        >
          {t('page.tab.help')}
        </button>
      </div>

      {panel === 'manage' && <ManagePanel t={t} state={state} reload={load} />}
      {panel === 'migrate' && <MigrationPanel t={t} state={state} reload={load} directory={directory} />}
      {panel === 'transfer' && <TransferPanel t={t} state={state} reload={load} />}
      {panel === 'sync' && <SyncPanel t={t} state={state} reload={load} />}
      {panel === 'help' && <HelpPanel t={t} state={state} reload={load} />}

      {/*
        版本徽标：这一页的右下角。放在页内分页**之后**而不是页头——它答的是"这一页是哪个构建"，
        与"你要做什么"无关；悬浮提示把"发布版还是直接 build 的"说全（判据见 build.ts 与
        scripts/build-identity.ts）。一句话里的数字来自构建期常量，渲染路径上没有任何 IO。
      */}
      <p className="dsm-version" title={versionTip}>
        {version}
      </p>
    </section>
  )
}
