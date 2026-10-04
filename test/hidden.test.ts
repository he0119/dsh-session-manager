// 迁移候选与"外壳侧边栏看得见什么"对齐：子智能体、空白、已归档的会话一个都不进候选。
//
// 这条口径来自一次真实的账对不上：迁移面板的「未分组」报 4 条，外壳侧边栏那一组只显示 1 条。四条里
// 三条是侧边栏不显示的（一条子智能体会话、两条只有 seed 事件的空白会话，其中一条还已归档），而面板
// 照旧把它们算进候选与条数。现在候选由 `src/visibility.ts` 一条判据决定，界面与计划层读同一份结论。
//
// 这里用 `previewMigration()`（而不是 `buildRelocationPlan()`）跑：空白判据的默认读取器是**编排层**
// 按 `registryPath` 反推投影缓存目录造出来的（见 migrate.ts），走完整条路才钉得住"工具层与界面层
// 同一套候选"这件事——两处各造一个读取器，迟早会长出两套候选。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { previewMigration, type MigrateDeps } from '../src/migrate.ts'
import { sessionDir } from '../src/paths.ts'
import { projectKey } from '../src/project-key.ts'
import { writeRegistryAtomic } from '../src/registry.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

interface Sandbox {
  base: string
  sessionsRoot: string
  registryPath: string
  cacheDir: string
  source: string
  target: string
}

/**
 * 沙箱：源目录 source 下住着四条会话，其中三条外壳侧边栏不显示。
 *   - `session-visible`：在册、非子智能体、非空白 → 唯一该进候选的那条；
 *   - `session-subagent`：header 写着 `origin: "subagent"`（子智能体会话嵌在父会话下面）；
 *   - `session-blank`：投影缓存里 `sessionListMetadata.blank = true`（一轮都没开始过）；
 *   - `session-archived`：在册，但 id 在注册表的归档集里。
 */
function makeSandbox(name: string): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  const source = join(base, 'src-dir')
  const target = join(base, 'dst-dir')
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const registryPath = join(base, 'storages', 'workspace.json')
  mkdirSync(join(base, 'storages'), { recursive: true })
  const cacheDir = join(base, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })

  let createdAt = 1000
  const write = (id: string, extra: Partial<SessionHeader> = {}): number => {
    createdAt += 1
    const header: SessionHeader = {
      type: 'session',
      version: 4,
      id,
      createdAt,
      cwd: source,
      isSeeded: false,
      delegationDepth: 0,
      ...extra,
    }
    const dir = sessionDir(sessionsRoot, source, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'session.v4.jsonl.zstd'),
      Buffer.concat([
        encodeRawFrame(`${JSON.stringify(header)}\n`),
        // 日志里必须真有一轮（`turn/start`）：候选口径不读日志判空白，但夹具照真实形状写，
        // 免得这里"因为夹具不真实而恰好通过"。
        encodeRawFrame(`${JSON.stringify({ type: 'turn/start', seq: 0, time: createdAt, data: { turn: 1 } })}\n`),
        encodeRawFrame(`${JSON.stringify({ type: 'turn/end', seq: 1, time: createdAt + 1, data: { turn: 1 } })}\n`),
      ]),
    )
    return createdAt
  }

  const visibleAt = write('session-visible')
  const subagentAt = write('session-subagent', { origin: 'subagent', parentSession: 'session-visible', delegationDepth: 1 })
  const blankAt = write('session-blank')
  write('session-archived')

  // 投影缓存：空白那条写 blank: true；子智能体那条也写一份（不是空白），证明"子智能体"这条理由来自 header。
  writeFileSync(
    join(cacheDir, 'session-blank.json'),
    JSON.stringify({
      version: 7,
      record: { identity: { formatVersion: 4, createdAt: blankAt, cwd: source }, rows: { sessionListMetadata: { val: { blank: true } } } },
    }),
  )
  for (const [id, at] of [['session-visible', visibleAt], ['session-subagent', subagentAt]] as const) {
    writeFileSync(
      join(cacheDir, `${id}.json`),
      JSON.stringify({
        version: 7,
        record: { identity: { formatVersion: 4, createdAt: at, cwd: source }, rows: { sessionListMetadata: { val: { blank: false } } } },
      }),
    )
  }

  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['ws-a'],
      archivedSessionIds: ['session-archived'],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        'ws-a': {
          path: source,
          title: '源',
          sessionIds: ['session-visible', 'session-archived'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  writeRegistryAtomic(registryPath, registry)
  return { base, sessionsRoot, registryPath, cacheDir, source, target }
}

function deps(sandbox: Sandbox): MigrateDeps {
  return {
    sessionsRoot: sandbox.sessionsRoot,
    registryPath: sandbox.registryPath,
    backupRoot: join(sandbox.base, 'backups'),
    decodeAll,
  }
}

test('目录来源：子智能体 / 空白 / 已归档的会话都不进候选，只剩侧边栏看得见的那条', () => {
  const sandbox = makeSandbox('hidden-dir-source')
  const preview = previewMigration(deps(sandbox), { from: sandbox.source, to: sandbox.target })
  assert.equal(preview.ok, true, preview.problems.join('; '))
  // 候选（用户点得到、侧边栏也看得见的那些）只有一条：这里是"界面给的勾选面"。
  assert.deepEqual(preview.sessions.filter((s) => s.via === undefined).map((s) => s.id), ['session-visible'])
  // 但计划里还有一条：`session-subagent` 是 `session-visible` 的子智能体，**跟着父会话一起搬**——
  // 它不是候选，是族的一部分（判据与顺序见 src/family.ts）。空白与已归档那两条没有父会话，一个都不跟。
  assert.deepEqual(preview.sessions.map((s) => s.id), ['session-visible', 'session-subagent'])
  assert.equal(preview.cascaded, 1)
  assert.deepEqual(preview.sessions[1]?.via, { id: 'session-visible' })
  assert.equal(preview.sessions[1]?.registered, false, '子智能体从来不在册，跟着搬也不改变成员资格')
  // 目标项目目录名由 cwd 推出，夹具里两个目录不撞 key
  assert.notEqual(projectKey(sandbox.source), projectKey(sandbox.target))
})

test('未分组来源：同一个库、同一条判据，空洞的只剩"看得见且没人认领"的', () => {
  const sandbox = makeSandbox('hidden-unowned-source')
  const preview = previewMigration(deps(sandbox), { unowned: true, to: sandbox.target })
  // 没人认领的三条里，子智能体与空白都被挡掉；什么都没剩下，于是计划如实报"没有可迁移的会话"。
  assert.deepEqual(preview.sessions.map((s) => s.id), [])
  assert.deepEqual(preview.problems, ['no sessions selected for migration'])
})

test('点名叫一条侧边栏不显示的会话：报的是"它被隐藏了"，不是含糊的"找不到"', () => {
  const sandbox = makeSandbox('hidden-named')
  const preview = previewMigration(deps(sandbox), {
    from: sandbox.source,
    to: sandbox.target,
    sessionIds: ['session-subagent'],
  })
  assert.equal(preview.ok, false)
  // 子智能体那类给的是**下一步**而不是"我不搬它"：点名它自己不会把它搬走（那是向上的牵连），
  // 该点名的是它的父会话——所以这句话里带着父会话的 id。
  assert.deepEqual(preview.problems, [
    'session session-subagent is a subagent session (it follows its parent) — migrate its parent session-visible instead',
  ])

  // 已归档的那条给的是归档这条理由（同一条判据的另一支）
  const archived = previewMigration(deps(sandbox), {
    from: sandbox.source,
    to: sandbox.target,
    sessionIds: ['session-archived'],
  })
  assert.deepEqual(archived.problems, [
    'session session-archived is hidden from the host sidebar (archived) — migration does not take it',
  ])

  // 空白那条的理由来自投影缓存（不是 header），同样报得出来
  const blank = previewMigration(deps(sandbox), {
    from: sandbox.source,
    to: sandbox.target,
    sessionIds: ['session-blank'],
  })
  assert.deepEqual(blank.problems, [
    'session session-blank is hidden from the host sidebar (blank) — migration does not take it',
  ])
})

test('投影缓存缺席（没挂那个域的老宿主）：不凭空判空白，候选照旧列出来', () => {
  const sandbox = makeSandbox('hidden-no-cache')
  // 把缓存目录整个搬走：`resolveBlank` 读不到记录 → 按"会显示"处理，与宿主自己的冷会话口径一致
  // （`summarizeCold()` 用 `metadata?.blank ?? false`）。反过来假设它空白，就会把用户看得见的会话
  // 从候选里悄悄拿掉。
  rmSync(join(sandbox.base, 'storages', 'session_projcache'), { recursive: true, force: true })
  const preview = previewMigration(deps(sandbox), { from: sandbox.source, to: sandbox.target })
  // 只剩"归档"与"子智能体"两条理由还在起作用：空白那条被放回候选（它与 `session-subagent` 一起，
  // 后者是跟着 `session-visible` 进来的族成员）。
  assert.deepEqual(preview.sessions.map((s) => s.id).sort(), ['session-blank', 'session-subagent', 'session-visible'])
  assert.deepEqual(
    preview.sessions.filter((s) => s.via === undefined).map((s) => s.id).sort(),
    ['session-blank', 'session-visible'],
  )
})
