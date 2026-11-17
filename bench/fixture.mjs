// bench/fixture.mjs — 造一份"像真实会话库"的夹具，给所有场景共用。
//
// 为什么不用现成的真实库：它只在这台机器上、内容还一直在变，基线的可比性立刻没了。这里生成的东西
// 逐字节可复现（固定种子 + 固定 zstd 压缩），规模与形状对着真实库取：几百到一千多条会话、分在几十个
// 项目目录里、绝大多数很短、少数很长，日志是多帧压缩的（与宿主写出的一样），并且每题会话都配一份
// 投影缓存记录（标题、空白、两枚活动时间）。
//
// 远端那一格不是手写的索引：**用生产代码自己推上去**（`runSync({apply:true})` 从一份"别的机器"的库
// 推到夹具 WebDAV）。手写索引等于把格式契约复述一遍，而基准要测的正是真实格式下的开销。
//
// 生成一次之后按 profile 缓存到 `bench/.work/<profile>/`；生成器版本或 profile 变了才重来。
//
// @module dsh-session-manager/bench/fixture
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { runSync } from '../src/operations/sync/sync.ts'
import { createDavClient } from '../src/operations/sync/dav.ts'
import { createProjectionReader } from '../src/shared/library/projection-cache.ts'
import { decodeAll } from '../src/shared/log/log-decode.ts'
import { encodeSegment, projectionCacheDir, sessionDir } from '../src/shared/paths.ts'
import { writeRegistryAtomic } from '../src/shared/registry.ts'
import { createSessionMetaResolver } from '../src/shared/visibility.ts'
import { startDavFixture } from '../test/fixtures/dav-fixture.ts'

import { PROFILES } from './profiles.mjs'
import { between, rng } from './rng.mjs'

/** 夹具生成器的版本：改了生成方式就 +1，旧目录作废。 */
const FIXTURE_VERSION = 8

const WORDS = [
  '这个', '文件', '先', '看', '一下', '同步', '的', '边界', '条件', '然后', '再', '改', '注册表',
  '宿主', '手里', '那份', '内存', '副本', '不该', '按', '目录', '名', '去', '猜', '路径', '归一',
  '成', '真实', '拼写', '之后', '再', '比', '字符串', '相等', '否则', '会', '多出', '一条', '记录',
]

const LOREM = (random, words) => {
  const out = []
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(random() * WORDS.length)])
  return out.join('')
}

/** 一份夹具的缓存目录。 */
export function workDir(profileName) {
  return join(import.meta.dirname, '.work', profileName)
}

/** 读已有的 manifest；版本/规模不匹配就整份重来。 */
export function readManifest(profileName) {
  const dir = workDir(profileName)
  const path = join(dir, 'manifest.json')
  if (!existsSync(path)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    if (manifest.version !== FIXTURE_VERSION) return undefined
    if (manifest.profile !== profileName) return undefined
    return manifest
  } catch {
    return undefined
  }
}

/**
 * 确保夹具存在。
 * @param profileName small / default / full
 * @param options.rebuild 强制重造
 * @returns manifest（字段见文件末尾 `generate()`）。
 */
export async function ensureFixture(profileName, options = {}) {
  const existing = readManifest(profileName)
  if (!options.rebuild && existing !== undefined) return existing
  const manifest = await generate(profileName)
  writeFileSync(join(workDir(profileName), 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

/**
 * 生成一份夹具。
 *
 * 目录形状：
 *
 *   sessions/                        本机会话库
 *   storages/workspace.json          注册表
 *   storages/session_projcache/…     投影缓存（每条会话一份记录）
 *   backups/                         备份根（同步覆盖本机时要往里写）
 *   dirs/p*                          项目目录（真实存在，迁移/导入的目标要用）
 *   dirs/target                      迁移的目标工作区
 *   dav/                             远端那一份的落盘目录（夹具 WebDAV 的 root）
 *   remote-lib/                      造远端时"另一台机器"的库（生成期用完即留，便于排查）
 */
async function generate(profileName) {
  const profile = PROFILES[profileName]
  if (profile === undefined) throw new Error(`未知的 profile：${profileName}`)
  const dir = workDir(profileName)
  rmSync(dir, { recursive: true, force: true })
  const sessionsRoot = join(dir, 'sessions')
  const storages = join(dir, 'storages')
  const registryPath = join(storages, 'workspace.json')
  const backupRoot = join(dir, 'backups')
  const dirsRoot = join(dir, 'dirs')
  const davRoot = join(dir, 'dav')
  const remoteLib = join(dir, 'remote-lib')
  const remoteStorages = join(dir, 'remote-storages')
  const remoteRegistryPath = join(remoteStorages, 'workspace.json')
  const remoteBackups = join(dir, 'remote-backups')
  const projectionDir = projectionCacheDir(registryPath)
  for (const path of [sessionsRoot, storages, projectionDir, backupRoot, dirsRoot, davRoot, remoteLib, remoteStorages, remoteBackups]) {
    mkdirSync(path, { recursive: true })
  }

  const random = rng(profile.seed)
  const projects = []
  for (let i = 0; i < profile.projects; i++) {
    const path = join(dirsRoot, `p${i}`)
    mkdirSync(path, { recursive: true })
    projects.push({ id: `ws-${i}`, path, title: `项目 ${i}` })
  }
  mkdirSync(join(dirsRoot, 'target'), { recursive: true })

  // ── 1. 本机会话 ────────────────────────────────────────────────
  const sessions = []
  const registry = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: projects.map((p) => p.id), archivedSessionIds: [] },
    tables: { workspaces: {} },
  }
  for (const project of projects) {
    registry.tables.workspaces[project.id] = { id: project.id, path: project.path, title: project.title, sessionIds: [] }
  }

  for (let i = 0; i < profile.sessions; i++) {
    const project = projects[i % projects.length]
    const id = `bench-${String(i).padStart(4, '0')}`
    const createdAt = 1_760_000_000_000 + i * 60_000
    const cls = i < profile.largeSessions ? 'large' : random() < 0.6 ? 'small' : random() < 0.94 ? 'medium' : 'large'
    const huge = i === 0
    const count = huge
      ? Math.ceil(profile.hugeBytes / 320)
      : cls === 'large'
        ? between(random, 3000, 9000)
        : cls === 'medium'
          ? between(random, 300, 2000)
          : between(random, 40, 300)
    const blank = i % 25 === 5
    const lines = []
    lines.push(
      JSON.stringify({
        type: 'session',
        version: 4,
        id,
        createdAt,
        cwd: project.path,
        isSeeded: false,
        delegationDepth: 0,
      }),
    )
    for (let e = 0; e < count; e++) {
      const time = createdAt + e * 1500
      const seq = e
      const kind = e % 12
      if (kind === 0 || kind === 6) {
        lines.push(JSON.stringify({ type: 'user/message', seq, time, data: { content: [{ type: 'text', text: LOREM(random, between(random, 5, 40)) }], source: { kind: 'user' }, role: 'user' } }))
      } else if (kind === 1 || kind === 7) {
        lines.push(JSON.stringify({ type: 'assistant/message', seq, time, data: { content: [{ type: 'text', text: LOREM(random, between(random, 20, 200)) }], role: 'assistant' } }))
      } else if (kind === 2) {
        lines.push(JSON.stringify({ type: 'tool/call', seq, time, data: { callId: `call-${e}`, name: 'read_file', args: { path: join(project.path, 'src/index.ts'), limit: 2000 } } }))
      } else if (kind === 3) {
        // 工具输出偶尔很大（真实库里 100 KB 的也有）：内容视图的截断那条路要真的被走到。
        const size = e % 37 === 3 ? between(random, 2000, 40000) : between(random, 50, 600)
        lines.push(JSON.stringify({ type: 'tool/result', seq, time, data: { callId: `call-${e - 1}`, isError: false, content: [{ type: 'text', text: LOREM(random, Math.ceil(size / 6)) }] } }))
      } else if (kind === 4) {
        lines.push(JSON.stringify({ type: 'step/end', seq, time, data: { reason: 'stop' } }))
      } else if (kind === 5) {
        lines.push(JSON.stringify({ type: 'llm/retry', seq, time, data: { attempt: 1, delayMs: 200 } }))
      } else {
        lines.push(JSON.stringify({ type: 'assistant/message', seq, time, data: { content: [{ type: 'text', text: LOREM(random, between(random, 5, 60)) }], role: 'assistant' } }))
      }
    }

    const logDir = sessionDir(sessionsRoot, project.path, id)
    mkdirSync(logDir, { recursive: true })
    // 第一帧只装 header（宿主就是这么写的，迁移/导入改写首帧的前提）；之后每 12 条一帧。
    const frames = [zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'))]
    for (let offset = 1; offset < lines.length; offset += 12) {
      const chunk = lines.slice(offset, offset + 12).join('\n') + '\n'
      frames.push(zstdCompressSync(Buffer.from(chunk, 'utf8')))
    }
    const bytes = Buffer.concat(frames)
    writeFileSync(join(logDir, 'session.v4.jsonl.zstd'), bytes)

    // 投影缓存：宿主的形状（identity 对得上才认）。
    const lastPromptAt = blank ? undefined : createdAt + count * 1500
    writeFileSync(
      join(projectionDir, `${encodeSegment(id)}.json`),
      JSON.stringify({
        version: 7,
        record: {
          identity: { formatVersion: 4, createdAt, cwd: project.path },
          rows: {
            title: { ver: 1, seq: 1, val: `会话 ${id} · ${project.title}` },
            ...(blank
              ? { sessionListMetadata: { ver: 1, seq: 1, val: { blank: true, lastPromptAt: null } } }
              : {
                  sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt } },
                  timeContext: { ver: 1, seq: 1, val: { lastMessageTime: lastPromptAt + 500 } },
                }),
          },
        },
      }),
    )

    const archived = i % 20 === 7
    sessions.push({ id, cwd: project.path, createdAt, eventCount: count, bytes: bytes.length, logDir, blank, archived })
    registry.tables.workspaces[project.id].sessionIds.push(id)
    if (archived) registry.global.archivedSessionIds.push(id)
  }
  writeRegistryAtomic(registryPath, registry)

  // ── 2. 远端：从"另一台机器"的库推上去（用生产代码，索引因此是真实格式）──────
  const remotePick = sessions.filter((_, index) => index % 3 === 0)
  const remoteRandom = rng(profile.seed + 1)
  const remoteOnly = []
  const remoteSessions = [...remotePick]
  // 远端独有：本机没有的 id，cwd 仍落在本机存在的项目目录里（拉取才落得下去）。
  for (let i = 0; i < 20; i++) {
    const project = projects[i % projects.length]
    const id = `remote-${String(i).padStart(4, '0')}`
    const createdAt = 1_760_500_000_000 + i * 60_000
    const count = between(remoteRandom, 40, 400)
    const lines = [JSON.stringify({ type: 'session', version: 4, id, createdAt, cwd: project.path, isSeeded: false, delegationDepth: 0 })]
    for (let e = 0; e < count; e++) {
      lines.push(JSON.stringify({ type: 'user/message', seq: e, time: createdAt + e * 1000, data: { content: [{ type: 'text', text: LOREM(remoteRandom, between(remoteRandom, 5, 30)) }], source: { kind: 'user' }, role: 'user' } }))
    }
    const dir = sessionDir(remoteLib, project.path, id)
    mkdirSync(dir, { recursive: true })
    const bytes = Buffer.concat([
      zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8')),
      zstdCompressSync(Buffer.from(lines.slice(1).join('\n') + '\n', 'utf8')),
    ])
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), bytes)
    remoteOnly.push({ id, cwd: project.path, createdAt, eventCount: count, bytes: bytes.length, dir })
    remoteSessions.push(remoteOnly[remoteOnly.length - 1])
  }
  // 两边各自写过：同一个 id，远端那份多一条事件（内容关系那一步要真的解两份日志）。
  const diverged = []
  for (const source of sessions.filter((_, index) => index % 97 === 3).slice(0, 3)) {
    const dir = sessionDir(remoteLib, source.cwd, source.id)
    mkdirSync(dir, { recursive: true })
    const original = readFileSync(join(source.logDir, 'session.v4.jsonl.zstd'))
    const extra = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'user/message', seq: source.eventCount, time: source.createdAt + source.eventCount * 1500, data: { content: [{ type: 'text', text: '远端后来补的一条' }], source: { kind: 'user' }, role: 'user' } }) + '\n', 'utf8'))
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([original, extra]))
    diverged.push(source.id)
    remoteSessions.push({ ...source, dir, eventCount: source.eventCount + 1, bytes: original.length + extra.length })
  }
  writeRegistryAtomic(remoteRegistryPath, registry)

  const davFixture = await startDavFixture({ root: davRoot })
  const settings = { url: davFixture.url, machineId: 'bench-remote', mapping: {} }
  const outcome = await runSync(
    {
      dav: createDavClient({ baseUrl: settings.url }),
      settings,
      sessionsRoot: remoteLib,
      registryPath: remoteRegistryPath,
      backupRoot: remoteBackups,
      decodeAll,
      sessionMeta: createSessionMetaResolver({ cacheDir: projectionCacheDir(remoteRegistryPath) }),
      projection: createProjectionReader(projectionCacheDir(remoteRegistryPath)),
      liveSessionIds: () => new Set(),
      repoLocations: async () => undefined,
    },
    { apply: true },
  )
  await davFixture.close()
  if (outcome.problems.length > 0) throw new Error(`造远端失败：${outcome.problems.join('；')}`)

  const largest = [...sessions].sort((left, right) => right.bytes - left.bytes)[0]
  return {
    version: FIXTURE_VERSION,
    profile: profileName,
    seed: profile.seed,
    generatedAt: new Date().toISOString(),
    dir,
    sessionsRoot,
    registryPath,
    backupRoot,
    dirsRoot,
    targetDir: join(dirsRoot, 'target'),
    projectionDir,
    davRoot,
    remoteLib,
    remoteRegistryPath,
    remoteBackups,
    projects,
    sessions,
    largestId: largest.id,
    largestBytes: largest.bytes,
    remote: { machineId: 'bench-remote', pushed: remoteSessions.length, remoteOnly: remoteOnly.length, diverged: diverged.length },
    totalBytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
  }
}
