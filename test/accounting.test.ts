// 「认领」的判据：注册表里**登记** ≠ 会话有主。
//
// 宿主把每个工作区记录的 `sessionIds` 再过滤一遍才发给界面（`Workspace.sessionIds` 的取值）：
//
//   record.sessionIds.filter((id) => sessionPath(id) === record.path)
//
// 而 `sessionPath(id)` 是启动时按 header 的 cwd 建的索引（`realpath` 解析得出来、而且真的还是一个目录）。
// 插件读原始登记时，目录改名/删掉之后同一批会话在插件这边"有主"、在外壳那边「未分组」——这里把这条
// 判据的四种边界逐个钉住，并按真实形状跑一次"目录改名"（那正是这次出现的那个现象）。
import assert from 'node:assert/strict'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { accountedOwners } from '../src/accounting.ts'
import { canonicalDirIfExists } from '../src/canonical-path.ts'
import type { WorkspaceRegistryState } from '../src/types.ts'

/** 一份最小注册表：只要 path 与 sessionIds 两个字段。 */
function registryOf(workspaces: Record<string, { path: string; sessionIds: string[] }>): WorkspaceRegistryState {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: Object.keys(workspaces),
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: Object.fromEntries(
        Object.entries(workspaces).map(([id, workspace]) => [
          id,
          { ...workspace, title: id, createdAt: 'x', updatedAt: 'x' },
        ]),
      ),
    },
  }
}

test('认领：登记过、且 cwd 归一之后就是那条记录的 path', () => {
  const registry = registryOf({ 'ws-1': { path: 'C:\\work\\proj', sessionIds: ['session-a'] } })
  const owners = accountedOwners(registry, [{ id: 'session-a', cwd: 'C:/work/proj/' }], {
    // 另一种拼写归一之后是同一个目录（宿主的 realpath 也会给出同一条路径）
    resolveDir: () => 'C:\\work\\proj',
  })
  assert.deepEqual([...owners], [['session-a', 'ws-1']])
})

test('认领：cwd 解析不出来（目录改名 / 删掉）的登记不算有主', () => {
  const registry = registryOf({ 'ws-1': { path: 'C:\\work\\proj', sessionIds: ['session-a'] } })
  // 这一条就是插件以前算错的地方：id 明明在 sessionIds 里，但目录已经不在了
  const owners = accountedOwners(registry, [{ id: 'session-a', cwd: 'C:\\work\\proj' }], {
    resolveDir: () => undefined,
  })
  assert.deepEqual([...owners], [])
})

test('认领：归一之后与记录的 path 不是同一个字符串的不算有主', () => {
  const registry = registryOf({ 'ws-1': { path: 'C:\\work\\proj', sessionIds: ['session-a'] } })
  const owners = accountedOwners(registry, [{ id: 'session-a', cwd: 'C:\\work\\elsewhere' }], {
    resolveDir: (cwd) => cwd,
  })
  assert.deepEqual([...owners], [])
})

test('认领：库里没有的登记项不进结果（判不了"目录还在不在"）', () => {
  const registry = registryOf({ 'ws-1': { path: 'C:\\work\\proj', sessionIds: ['session-unknown'] } })
  const owners = accountedOwners(registry, [], { resolveDir: (cwd) => cwd })
  assert.deepEqual([...owners], [])
})

test('认领：没有 cwd 的会话不算任何工作区的成员（哪怕登记过）', () => {
  const registry = registryOf({ 'ws-1': { path: 'C:\\work\\proj', sessionIds: ['session-a', 'session-nocwd'] } })
  const owners = accountedOwners(
    registry,
    [
      { id: 'session-a', cwd: 'C:\\work\\proj' },
      { id: 'session-nocwd' },
    ],
    { resolveDir: (cwd) => cwd },
  )
  assert.deepEqual([...owners], [['session-a', 'ws-1']])
})

test('认领：读不到注册表（null / undefined）时谁都没认领', () => {
  const sessions = [{ id: 'session-a', cwd: 'C:\\work\\proj' }]
  assert.equal(accountedOwners(null, sessions).size, 0)
  assert.equal(accountedOwners(undefined, sessions).size, 0)
})

test('认领：同一个 cwd 只解析一次（一个库里的会话挤在几十个目录里）', () => {
  const registry = registryOf({ 'ws-1': { path: 'C:\\work\\proj', sessionIds: ['session-a', 'session-b', 'session-c'] } })
  let calls = 0
  const owners = accountedOwners(
    registry,
    [
      { id: 'session-a', cwd: 'C:\\work\\proj' },
      { id: 'session-b', cwd: 'C:\\work\\proj' },
      { id: 'session-c', cwd: 'C:\\work\\proj' },
    ],
    {
      resolveDir: (cwd) => {
        calls += 1
        return cwd
      },
    },
  )
  assert.equal(calls, 1)
  assert.equal(owners.size, 3)
})

test('canonicalDirIfExists：真实目录给规范拼写；删掉之后与空串一样返回 undefined', () => {
  const dir = join(import.meta.dirname, '.sandbox', 'accounting-dir')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const canonical = canonicalDirIfExists(dir)
  assert.equal(typeof canonical, 'string')
  assert.equal(canonical, canonicalDirIfExists(canonical!), '规范拼写是幂等的')
  rmSync(dir, { recursive: true, force: true })
  assert.equal(canonicalDirIfExists(dir), undefined)
  assert.equal(canonicalDirIfExists(''), undefined)
})

test('真实磁盘：目录改名之后那条登记不再是认领（外壳那边它就落进「未分组」）', () => {
  const base = join(import.meta.dirname, '.sandbox', 'accounting-rename')
  rmSync(base, { recursive: true, force: true })
  const before = join(base, 'photo-rename')
  const after = join(base, 'photo-manager')
  mkdirSync(before, { recursive: true })

  // 记录的 path 是宿主在注册时存下的**规范拼写**（create 时过了一遍 realpath）
  const registry = registryOf({ 'ws-1': { path: canonicalDirIfExists(before)!, sessionIds: ['session-a'] } })
  const sessions = [{ id: 'session-a', cwd: before }]
  assert.deepEqual([...accountedOwners(registry, sessions)], [['session-a', 'ws-1']])

  renameSync(before, after)
  // 登记还留在注册表里，但那条会话 header 的 cwd 已经解析不出来：宿主不算它有主
  assert.deepEqual([...accountedOwners(registry, sessions)], [])
})
