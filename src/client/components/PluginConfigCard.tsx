/**
 * 插件页里这一包的那一格配置（`plugins.bundle.config`，按包名作键）。
 *
 * 为什么挂在这里而不是设置里：设置页放的是官方那几项（通用、模型、插件、账户、Agent 预设），本包挤
 * 进去只是"多一页"；而插件页本来就是"这个包长什么样、它有哪些可调的东西"的地方。官方的
 * `dsh-context` 也把它的偏好卡挂在这里（`plugins.bundle.config`，键是它自己的命名空间）。侧栏那一页
 * 上留一枚「同步设置」，点过来看到的就是这一格。
 *
 * 契约给的 props：`view` 是 `summary`（列表里那一行的一句话）或 `page`（这一页的正文），`form` 是宿主
 * 给的配置读写面（本包不用它——表单自己走 `configForms` 接缝，见 [SyncConfigForm](./SyncConfigForm.tsx)）。
 *
 * @module dsh-session-manager/client/PluginConfigCard
 */

import * as React from 'react'

import { fetchMeta, type MetaResponse } from '../api.ts'
import type { Translate } from '../logic/locales.ts'
import { panelEvents } from '../logic/panelEvents.ts'
import { SyncConfigForm } from './SyncConfigForm.tsx'

/** 插件页给这一格的 props（只取本模块用得到的）。 */
export interface PluginConfigCardProps {
  /** `summary` 只画一句话；`page` 画整张表单（`plugins.bundle.config` 只会拿到 `page`）。 */
  view: 'summary' | 'page'
  /** 框架按 `locale` 送来的翻译函数。 */
  t: Translate
}

/**
 * 插件页里的「同步」配置卡。
 *
 * @param props 见 {@link PluginConfigCardProps}。
 * @returns 整页时是那张表单；摘要时不画（列表里那一行的一句话由 `docs/DETAIL.md` 负责）。
 */
export function PluginConfigCard({ view, t }: PluginConfigCardProps): React.ReactElement | null {
  /**
   * 宿主事实（只取 `/meta`，不扫库）：只为机器名那一栏的灰字——宿主解析出来的缺省值。
   *
   * 读不到就不给：表单自己会说"留空用主机名"，不会因为一条提示读失败就整格空着。
   */
  const [meta, setMeta] = React.useState<MetaResponse>()
  React.useEffect(() => {
    let alive = true
    void fetchMeta().then(
      (next) => {
        if (alive) setMeta(next)
      },
      () => {
        // 读不到就算了：那只是灰字。
      },
    )
    return () => {
      alive = false
    }
  }, [])

  if (view !== 'page') return null
  return (
    <div className="dsm-settingPrefs">
      {/*
        按**功能**分组，一组一个标题（现在是「同步」一组）。以后再加别的组（比如会话库相关的选项）就
        在下面照同一形状再排一个 .dsm-settingGroup——组与组之间由 CSS 画一条发丝线。这个形状照
        `dsh-context` 那张插件页配置卡：组标题 16/600，组里一行一件事。
      */}
      <div className="dsm-settingGroup" role="group" aria-label={t('sync.config.title')}>
        <div className="dsm-settingGroupTitle">{t('sync.config.title')}</div>
      {/*
        保存之后让侧栏那一页重读一次宿主事实（它可能正开着）。没有那条连接时 `refresh()` 什么都不做，
        所以这里不必判断"页面在不在"。
      */}
      <SyncConfigForm
        t={t}
        remoteCwds={[]}
        {...(meta?.sync == null ? {} : { machineDefault: meta.sync.machineId })}
        onSaved={() => panelEvents.refresh()}
      />
      </div>
    </div>
  )
}
