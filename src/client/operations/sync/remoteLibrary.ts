/**
 * 远端每台机器的格子里有哪几条会话、各在什么路径（右栏那一行「远端」读它）。
 *
 * 为什么是一个模块级 store，而不是每面组件各读一次：读一次要问远端（NAS 上每台机器一份 `index.json`），
 * 而这一页会反复用到它——选中哪条会话就看哪一条。所以**一次刷新只读一次**，读到就整份留在内存里，
 * 之后翻来翻去只是在这份上查表（见
 * [远端位置一次刷新读一次](../../../../.agents/notes/implemented/architecture/2026-11-15-remote-placement-read-once-per-refresh.md)）。
 *
 * 什么时候重读由调用方决定（`load()`）：页面拿到一份**新的**清单时、以及一次同步真的应用之后（那一次
 * 会改远端）。store 自己不订阅任何东西，所以测试不必先造一条面板流。
 *
 * @module dsh-session-manager/client/operations/sync/remoteLibrary
 */

import { fetchRemoteLibrary, type RemoteLibraryResult, type RemotePlacement } from '../../api.ts'

/**
 * 这一份远端地图现在什么样。
 *
 * - `idle` / `loading`：还没读过 / 正在读（右栏说一句"正在读"）；
 * - `off`：这个宿主没配 WebDAV 同步——右栏那一行整行不出现，不是"读不到"；
 * - `failed`：读失败（原话带上），右栏照实说；
 * - `ready`：读到了（`sessions` 是查表用的那份，`problems` 非空说明可能不全）。
 */
export type RemoteLibraryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'failed'; error: string }
  | {
      status: 'ready'
      /** 这份是读出来的时刻（毫秒时间戳）。 */
      at: number
      /** 读到索引的机器（按格子名排序）。 */
      machines: readonly string[]
      /** 会话 id → 它在各格子里的位置。 */
      sessions: ReadonlyMap<string, readonly RemotePlacement[]>
      /** 读索引时遇到的问题：有它，这份可能不全。 */
      problems: readonly string[]
    }

/** 造一份 store 时给的依赖（测试换成假的读法）。 */
export interface RemoteLibraryDeps {
  /** 读一次（生产上是 `src/client/api.ts` 的 `fetchRemoteLibrary`）。 */
  read: (signal?: AbortSignal) => Promise<RemoteLibraryResult>
}

/** 界面用的那几个口子。 */
export interface RemoteLibrary {
  /** 现在这一份。 */
  snapshot(): RemoteLibraryState
  /**
   * 订阅变化。
   *
   * @param listener 每次变化调一次（拿到新状态）。
   * @returns 退订函数（组件卸载时调）。
   */
  subscribe(listener: (state: RemoteLibraryState) => void): () => void
  /**
   * 读一次。
   *
   * 已经在读的那一次会被复用（一次刷新里挂载与状态变化可能连着触发两下，不该发两个请求）。
   * 已经有读到的那一份时不摆 `loading`：翻新期间旧的那份仍然是最接近真相的东西，别让右栏闪一下。
   *
   * @returns 这一趟读完（成功、没配、失败都算读完）。
   */
  load(): Promise<void>
}

/**
 * 造一份远端地图。
 *
 * @param deps 怎么读（见 {@link RemoteLibraryDeps}）。
 * @returns 那几个口子（见 {@link RemoteLibrary}）。
 */
export function createRemoteLibrary(deps: RemoteLibraryDeps): RemoteLibrary {
  const listeners = new Set<(state: RemoteLibraryState) => void>()
  let current: RemoteLibraryState = { status: 'idle' }
  /** 正在读的那一次（去重用）。 */
  let pending: Promise<void> | null = null

  const emit = (next: RemoteLibraryState): void => {
    current = next
    for (const listener of [...listeners]) listener(current)
  }

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load() {
      if (pending !== null) return pending
      if (current.status !== 'ready') emit({ status: 'loading' })
      pending = deps
        .read()
        .then(
          (result) => {
            if (result.kind === 'ready') {
              emit({
                status: 'ready',
                at: result.data.at,
                machines: result.data.machines,
                sessions: new Map(Object.entries(result.data.sessions)),
                problems: result.data.problems,
              })
              return
            }
            if (result.kind === 'off') {
              emit({ status: 'off' })
              return
            }
            emit({ status: 'failed', error: result.error })
          },
          (error: unknown) => {
            // 网络层直接失败（宿主没起来、DNS、证书）：与"宿主回了错"同一句话交代，右栏不空着。
            emit({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
          },
        )
        .finally(() => {
          pending = null
        })
      return pending
    },
  }
}

/** 这一页用的那一份（模块级：切页签、开关弹窗都不该让它重读；见文件头的说明）。 */
export const remoteLibrary = createRemoteLibrary({ read: fetchRemoteLibrary })
