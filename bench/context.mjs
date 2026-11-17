// 给各场景造一份"和宿主里一样"的依赖面：真实的 `createApiHandlers()` + 真实的位置与读取器。
//
// 注入的都是**生产实现**：解码器、标题读取器、投影读取器、扫库缓存、内容缓存。唯一假的是宿主侧那几件
// 动作（注册表、检查点、活会话）——基准不管它们，界面那几条写操作也只跑预览。
//
// @module dsh-session-manager/bench/context
import { createApiHandlers } from '../src/web.ts'
import { createDavClient } from '../src/operations/sync/dav.ts'
import { decodeAll } from '../src/shared/log/log-decode.ts'
import { startDavFixture } from '../test/fixtures/dav-fixture.ts'

/**
 * 造一份上下文。
 * @param manifest `ensureFixture()` 的返回值。
 * @param options.withDav 起一个假的 WebDAV 服务（同步场景要）。
 */
export async function createContext(manifest, options = {}) {
  const settings = {
    url: 'http://127.0.0.1:9/dav',
    machineId: 'bench-a',
    // 远端会话的 cwd 与本机同一批目录：映射成自己，拉取才有落点（与真实配置里"两边一样"最常见的情况同形）。
    mapping: Object.fromEntries(manifest.projects.map((project) => [project.path, project.path])),
  }
  let davFixture
  let dav
  if (options.withDav === true) {
    davFixture = await startDavFixture({ root: manifest.davRoot })
    settings.url = davFixture.url
    dav = createDavClient({ baseUrl: settings.url })
  }

  const deps = {
    paths: {
      sessionsRoot: manifest.sessionsRoot,
      registryPath: manifest.registryPath,
      backupRoot: manifest.backupRoot,
    },
    decodeAll,
    // 每次调用现造一个"运行时"（与 `syncRuntime()` 同形），远端指向那份假服务。
    sync: async () => (dav === undefined ? undefined : { settings, dav }),
    syncInfo: () => ({
      url: settings.url,
      machineId: settings.machineId,
      mappings: Object.keys(settings.mapping).length,
      hasCredentials: false,
    }),
    liveSessionIds: () => new Set(),
    // 项目身份不在基准里量（它要起 git 进程，属于另一条路）：直接给空表，界面照旧显示路径。
    repos: async () => new Map(),
    now: () => new Date('2026-01-01T00:00:00Z'),
  }

  return {
    manifest,
    deps,
    settings,
    handlers: createApiHandlers(deps),
    close: async () => {
      await davFixture?.close()
    },
  }
}
