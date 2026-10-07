/**
 * 「会话管理」页的骨架：一条标题行 + 页内分页，把三件事收在同一页里。
 *
 * 为什么是页内分页而不是几个设置分节：导出/导入、迁移、逐条管理都是"对着同一个会话库做一件事"，
 * 共用一份库状态（`/state` 只拉一次）、共用一句"库在哪、有多少条"的说明，分开成几页反而每次都要
 * 重新认一遍上下文。页面本体分别是 [TransferPanel.tsx](./TransferPanel.tsx)、
 * [MigrationPanel.tsx](./MigrationPanel.tsx)、[ManagePanel.tsx](./ManagePanel.tsx) 与
 * [BackupPanel.tsx](./BackupPanel.tsx)（后者是三个写操作共同的后悔面，不属于其中任何一个动作页）。
 *
 * 数据分两份到：`/meta`（库在哪、宿主有哪些能力位，不扫库）与 `/state`（扫完整库的清单）。页头读
 * `state ?? meta`，所以"位置与能力位"不必等那遍扫描；清单没到的分页说「读取中…」，而不是先把
 * "还没有会话""这个宿主没有这个能力"这类**结论**画上去再改。
 *
 * 分页切换会**卸载**另一个分页：本地草稿（勾选、弹窗里那份计划）随之清掉。这是有意的——一份计划
 * 不该在切走再切回来之后还留着，让人以为它还是刚刚算出来的那份。
 *
 * @module dsh-session-manager/client/ManagerPanel
 */

import * as React from 'react'

import { fetchMeta, fetchState, type MetaResponse, type StateResponse } from '../api.ts'
import { PLUGIN_COMMIT, PLUGIN_DIRTY, PLUGIN_VERSION } from '../build.ts'
import type { DirectoryApi } from '../directory.ts'
import type { Translate } from '../logic/locales.ts'
import { versionCommit, versionLabel, versionTag } from '../logic/version.ts'
import { BackupPanel } from './BackupPanel.tsx'
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
type PanelKey = 'transfer' | 'sync' | 'migrate' | 'manage' | 'backup' | 'help'

/** 会话管理页。 */
export function ManagerPanel({ t, directory }: ManagerPanelProps): React.ReactElement {
  const [state, setState] = React.useState<StateResponse | null>(null)
  /**
   * 会话库位置与能力位那一份（`/meta`）。
   *
   * 用 `undefined` 而不是 `null` 表示"还没到"：`null` 在本页是"读到了，宿主就是没给"（比如没配同步），
   * 两者不能混。它比 `state` 先到，页头因此不必等清单。
   */
  const [meta, setMeta] = React.useState<MetaResponse | undefined>(undefined)
  // 默认停在第一个页签（「会话」）：它是这一页的日常视图，另外两页是偶发动作。
  const [panel, setPanel] = React.useState<PanelKey>('manage')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // 两份同时发、各自落地：`/meta` 不扫库，通常立刻回来，页头先把位置与能力位画上；`/state` 要扫完
      // 整库（每条会话读 header + 折标题），回来再填清单与条数。用 allSettled 是为了让先到的那份**先画**，
      // 而不是等另一份一起。
      const [metaResult, stateResult] = await Promise.allSettled([fetchMeta(), fetchState()])
      if (metaResult.status === 'fulfilled') setMeta(metaResult.value)
      // `/meta` 拿不到不算这一页的错：那几项只是"先说清楚"，清单那条路照样把它们带回来（页头退回
      // "读取中…"）。所以这里不报错，也不清掉上一次拿到的位置。
      if (stateResult.status === 'fulfilled') {
        setState(stateResult.value)
      } else {
        setError(
          t('error.failed', {
            reason: stateResult.reason instanceof Error ? stateResult.reason.message : String(stateResult.reason),
          }),
        )
      }
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
  /**
   * 页头那行读的那些事实：`/state` 到了以它为准（它是超集），没到就用先回来的 `/meta`。
   *
   * 清单没到时条数说"读取中…"而不是 0——`0 个会话` 是**结论**，而那一刻的真相是"还不知道"。
   */
  const facts = state ?? meta
  const counts =
    state === null
      ? t('page.loading')
      : `${t('page.count.sessions', { count: sessions })} · ${t('page.count.workspaces', { count: workspaces })}`
  const libraryLine = facts === undefined ? t('page.loading') : `${facts.sessionsRoot} · ${counts}`
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
          {t('page.library')}：{libraryLine}
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
        页签顺序：四个动作页按日常程度排（会话 → 迁移 → 传输 → 同步），「备份」是那三个写操作
        共同的后悔面（迁移 / 删除 / 同步覆盖各留一份），日常程度最低却也不属于其中任何一页，所以
        排在动作页之后、最后的「说明」之前——「说明」是一次性读的参考，不该挤在动作页上（详见
        HelpPanel.tsx 的取舍）。同步紧挨着传输，是因为它落地走的是导入那条编排（见 SyncPanel.tsx
        的说明）。顺序与页签、页面本体两处都跟着走对齐，默认页就是第一个（见上面 useState 的初值）。
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
          aria-selected={panel === 'backup'}
          onClick={() => setPanel('backup')}
        >
          {t('page.tab.backup')}
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

      {panel === 'manage' && <ManagePanel t={t} state={state} meta={meta} reload={load} />}
      {panel === 'migrate' && <MigrationPanel t={t} state={state} meta={meta} reload={load} directory={directory} />}
      {panel === 'transfer' && <TransferPanel t={t} state={state} meta={meta} reload={load} />}
      {panel === 'sync' && <SyncPanel t={t} state={state} meta={meta} reload={load} />}
      {panel === 'backup' && <BackupPanel t={t} reload={load} />}
      {panel === 'help' && <HelpPanel t={t} state={state} meta={meta} reload={load} />}

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
