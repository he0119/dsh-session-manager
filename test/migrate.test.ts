// 迁移编排（src/migrate.ts）的单元面：预演只读、dry-run 不写、回滚只认自己的备份根。
//
// 工具层那条路径由 test/tools.test.ts 端到端覆盖（plan → migrate → verify → rollback），
// 这里补的是**界面也会用到的**那些边界：备份目录的越界拒绝、备份清单的列举、dry-run 的零写入。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import {
  assertBackupDir,
  listBackups,
  previewMigration,
  readBackup,
  rollbackMigration,
  runMigration,
  type MigrateDeps,
} from '../src/migrate.ts'
import { sessionDir } from '../src/paths.ts'
import { writeRegistryAtomic } from '../src/registry.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const FROM = join(import.meta.dirname, '.sandbox', 'migrate-from')
const TO = join(import.meta.dirname, '.sandbox', 'migrate-to')

interface Sandbox {
  base: string
  deps: MigrateDeps
  sessionId: string
}

/** 造一个最小但完整的沙箱：源工作区里一条会话 + 指向它的注册表 + 已存在的目标目录。 */
function makeSandbox(name: string): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(FROM, { recursive: true })
  mkdirSync(TO, { recursive: true })

  const sessionId = 'session-migrate-1'
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: 1000,
    cwd: FROM,
    isSeeded: false,
    delegationDepth: 0,
  }
  const dir = sessionDir(sessionsRoot, FROM, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.v4.jsonl.zstd'),
    encodeRawFrame(`${JSON.stringify(header)}\n`),
  )

  const registryPath = join(base, 'workspace.json')
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-from'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-from': {
          path: FROM,
          title: 'from',
          sessionIds: [sessionId],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  writeRegistryAtomic(registryPath, registry)

  return {
    base,
    sessionId,
    deps: { sessionsRoot, registryPath, backupRoot: join(base, 'backups'), decodeAll },
  }
}

test('预演：把源桶的会话与注册表变更算出来，一个字节都不写', () => {
  const sb = makeSandbox('migrate-preview')
  const before = readFileSync(join(sb.deps.registryPath), 'utf8')

  const preview = previewMigration(sb.deps, { from: FROM, to: TO })
  assert.equal(preview.ok, true, `预演应当可用：${preview.problems.join('; ')}`)
  assert.equal(preview.sessions.length, 1)
  assert.equal(preview.sessions[0]?.registered, true)
  assert.equal(preview.files, 1)
  assert.ok(preview.bytes > 0, '应当报出日志字节数')
  assert.equal(preview.registryChange?.targetPath, TO)
  assert.match(preview.summary, /迁移/)

  // 只读的证据：注册表没变、会话还在源桶、目标桶没被建出来
  assert.equal(readFileSync(sb.deps.registryPath, 'utf8'), before)
  const dirName = basename(sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId))
  assert.equal(existsSync(sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId)), true, '会话应当还在源桶')
  assert.equal(existsSync(join(sb.deps.sessionsRoot, preview.targetBucket, dirName)), false, '预演不该建目标会话目录')
  rmSync(sb.base, { recursive: true, force: true })
})

test('dry-run：runMigration(apply:false) 与预演同形，且不写盘', () => {
  const sb = makeSandbox('migrate-dryrun')
  const run = runMigration(sb.deps, { from: FROM, to: TO }, { apply: false })

  assert.equal(run.applied, false)
  assert.equal(run.backupDir, undefined, 'dry-run 不该有备份目录')
  assert.equal(run.preview.ok, true)
  assert.equal(existsSync(sb.deps.backupRoot), false, 'dry-run 不该建备份根')
  rmSync(sb.base, { recursive: true, force: true })
})

test('执行：改写 header.cwd、搬目录、登记目标工作区，并留下可回滚的备份', () => {
  const sb = makeSandbox('migrate-apply')
  const run = runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })

  assert.equal(run.applied, true)
  assert.equal(run.verified, true, `复核应当通过：${run.problems.join('; ')}`)
  assert.equal(run.rewritten, 1)
  assert.equal(run.moved, 1)
  assert.ok(run.backupDir, '执行必须留下备份目录')

  // 备份清单带上了源/目标，界面据此列出"这次搬了什么"
  const { manifest } = readBackup(sb.deps, run.backupDir)
  assert.equal(manifest.from, FROM)
  assert.equal(manifest.to, TO)
  assert.equal(manifest.sessions.length, 1)
  assert.equal(manifest.sessions[0]?.sourceDir, sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId))

  // 目标分桶里能看到这条会话，且 header.cwd 已改写
  const dir = sessionDir(sb.deps.sessionsRoot, TO, sb.sessionId)
  assert.equal(existsSync(dir), true, '会话应当已在目标桶里')
  assert.equal(existsSync(sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId)), false, '源桶里那份应当已经搬走')
  const header = JSON.parse(decodeAll(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as { cwd: string }
  assert.equal(header.cwd, TO)

  // 列举：这份备份应当出现在列表里，且带源/目标
  const listed = listBackups(sb.deps)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.sessions, 1)
  assert.equal(listed[0]?.from, FROM)
  assert.equal(listed[0]?.to, TO)

  rmSync(sb.base, { recursive: true, force: true })
})

test('回滚：dryRun 只回动作清单，真跑则目录与字节都回到原位', () => {
  const sb = makeSandbox('migrate-rollback')
  const run = runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })
  const backupDir = run.backupDir!
  const afterMigrate = sessionDir(sb.deps.sessionsRoot, TO, sb.sessionId)
  assert.equal(existsSync(afterMigrate), true)

  // dry-run：给动作但不写
  const plan = rollbackMigration(sb.deps, { backupDir, dryRun: true })
  assert.equal(plan.dryRun, true)
  assert.ok(plan.actions.length > 0, '应当列出将要做的动作')
  assert.equal(existsSync(afterMigrate), true, 'dry-run 不该动目录')

  // 真回滚：目录回源桶、header.cwd 复原、注册表还原
  const done = rollbackMigration(sb.deps, { backupDir })
  assert.equal(done.dryRun, false)
  assert.equal(done.restoredFiles, 1)
  assert.equal(done.registryRestored, true)
  assert.equal(existsSync(afterMigrate), false, '目标位必须已经搬走')
  const back = sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId)
  assert.equal(existsSync(back), true, '会话目录必须搬回源桶')
  const header = JSON.parse(decodeAll(readFileSync(join(back, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as { cwd: string }
  assert.equal(header.cwd, FROM, 'header.cwd 必须逐字节还原成源路径')
  // 对称性：apply 会删掉空源桶，回滚也该删掉空目标桶（否则会话根下留一个空目录）
  assert.equal(existsSync(dirname(afterMigrate)), false, '空掉的目标桶应当被删掉')

  rmSync(sb.base, { recursive: true, force: true })
})

test('备份目录越界：只认本插件备份根下的目录，其余一律拒', () => {
  const sb = makeSandbox('migrate-guard')
  const run = runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })
  const good = run.backupDir!

  assert.equal(assertBackupDir(sb.deps, good), good)
  // 空值、根目录本身、根之外、根下但没有 manifest 的目录
  assert.throws(() => assertBackupDir(sb.deps, ''), /缺少备份目录/)
  assert.throws(() => assertBackupDir(sb.deps, sb.deps.backupRoot), /不在本插件的备份根下/)
  assert.throws(() => assertBackupDir(sb.deps, join(sb.base, 'elsewhere')), /不在本插件的备份根下/)
  const empty = join(sb.deps.backupRoot, 'not-a-backup')
  mkdirSync(empty, { recursive: true })
  assert.throws(() => assertBackupDir(sb.deps, empty), /没有 manifest\.json/)

  rmSync(sb.base, { recursive: true, force: true })
})

test('列举备份：坏目录跳过而不是让整张列表打不开', () => {
  const sb = makeSandbox('migrate-list')
  runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })
  mkdirSync(join(sb.deps.backupRoot, 'garbage'), { recursive: true })
  writeFileSync(join(sb.deps.backupRoot, 'garbage', 'manifest.json'), '{not json')

  const listed = listBackups(sb.deps)
  assert.equal(listed.length, 1, '只有那一条真备份应当出现')
  assert.equal(listBackups({ ...sb.deps, backupRoot: join(sb.base, 'nope') }).length, 0, '备份根不存在时回空列表')
  rmSync(sb.base, { recursive: true, force: true })
})
