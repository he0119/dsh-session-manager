/**
 * 页面内的目录浏览框：列一层子目录、点着往下走、确认当前这一层。
 *
 * 为什么本插件自己写：宿主把"选目录"拆成了两只互斥的能力
 * （见 [../../src/tools.ts](../../src/tools.ts) 的 `directoryPickerKind`）——
 *   - `native`：`pick()` 在**宿主显示器**上弹系统对话框，浏览器里根本看不见；
 *   - `browse`：只给 `list()`/`createDirectory()`，即"页面自己画浏览器"。
 * 浏览器界面拿到的是后者，所以「浏览…」不能去调 `pick()`（宿主会以
 * `directory-picker/unavailable` 拒绝）。本组件用宿主自己的 `list()` 把那一层列出来，
 * 不碰文件系统、不自己拼路径：每一步跳转用的都是宿主返回的 `path`。
 *
 * 与宿主「添加工作区」的浏览框同一套数据源、同一套语义（列出来的**只有目录**），
 * 只是形状按本页的样式来：不 import 宿主的 UI 原语包，颜色只用主题 token。
 *
 * @module dsh-session-manager/client/DirectoryPicker
 */

import * as React from 'react'

import { normalizePickedPath, type DirectoryApi, type DirectoryListing } from '../directory.ts'
import type { Translate } from '../logic/locales.ts'

/** 入参。 */
export interface DirectoryPickerProps {
  /** 注入面给的翻译函数。 */
  t: Translate
  /** 宿主的目录浏览调用面。 */
  api: DirectoryApi
  /** 打开时先列哪一层：当前值；空串 = 宿主 home。 */
  startPath: string
  /** 用户确认了某一层（已经是绝对路径，未经改写）。 */
  onPick: (path: string) => void
  /** 关掉这个框（不改变值）。 */
  onClose: () => void
}

/** 页面内目录浏览框。 */
export function DirectoryPicker({ t, api, startPath, onPick, onClose }: DirectoryPickerProps): React.ReactElement {
  const [listing, setListing] = React.useState<DirectoryListing | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // 列出目录是个异步往返：用户可能在飞行中又点了别的层。用一张"票"来判新旧——
  // 只有最后一次请求的结果作数，先到的旧响应直接丢掉（否则会闪回上一层的内容）。
  const seq = React.useRef(0)

  /** 列出一层。空路径交给宿主解释成 home（本页不猜 home 在哪）。 */
  const open = React.useCallback(
    async (path: string): Promise<void> => {
      const ticket = ++seq.current
      setBusy(true)
      setError(null)
      try {
        const next = await api.list(path === '' ? undefined : path)
        if (ticket !== seq.current) return
        setListing(next)
      } catch (cause) {
        if (ticket !== seq.current) return
        // 列不动不算罕见（目录没了、权限不够、路径打错）：错误留在框里，用户换一层再试。
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (ticket === seq.current) setBusy(false)
      }
    },
    [api],
  )

  // 起点在**打开那一刻**定格：之后浏览器往下点、输入框里敲字都不该让这个框自己乱跳。
  const [root] = React.useState(startPath)
  React.useEffect(() => {
    void open(root)
  }, [open, root])

  const crumbs = listing?.crumbs ?? []

  return (
    <div className="dsm-browser">
      <div className="dsm-browserHead">
        <span className="dsm-fieldLabel">{t('browseTitle')}</span>
        <span className="dsm-spacer" />
        <button type="button" className="dsm-button" onClick={() => void open('')} disabled={busy}>
          {t('dirHome')}
        </button>
        <button type="button" className="dsm-button" onClick={onClose}>
          {t('cancel')}
        </button>
      </div>

      {crumbs.length > 0 && (
        <div className="dsm-crumbs">
          {crumbs.map((crumb) => (
            <button
              key={crumb.path}
              type="button"
              className="dsm-crumb"
              onClick={() => void open(crumb.path)}
              disabled={busy}
              title={crumb.path}
            >
              {crumb.name === '' ? '/' : crumb.name}
            </button>
          ))}
        </div>
      )}

      <p className="dsm-hint dsm-browserPath" title={listing?.path ?? startPath}>
        {listing?.path ?? startPath}
      </p>

      {error !== null && <p className="dsm-banner dsm-error">{t('failed', { reason: error })}</p>}

      {busy && <p className="dsm-hint">{t('loading')}</p>}

      {!busy && listing !== null && (
        <>
          {listing.entries.length === 0 ? (
            <p className="dsm-empty">{t('dirEmpty')}</p>
          ) : (
            <div className="dsm-list dsm-dirList">
              {listing.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={entry.hidden ? 'dsm-dirEntry dsm-dirHidden' : 'dsm-dirEntry'}
                  onClick={() => void open(entry.path)}
                  title={entry.path}
                >
                  {entry.name}
                </button>
              ))}
            </div>
          )}
          {listing.truncated && <p className="dsm-hint">{t('dirTruncated')}</p>}
        </>
      )}

      <div className="dsm-controls">
        <button
          type="button"
          className="dsm-button dsm-primary"
          onClick={() => onPick(normalizePickedPath(listing?.path ?? ''))}
          disabled={busy || listing === null}
        >
          {t('dirPick')}
        </button>
        <span className="dsm-hint">{t('dirPickHint')}</span>
      </div>
    </div>
  )
}
