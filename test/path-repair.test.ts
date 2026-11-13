// test/path-repair.test.ts — 修已落地日志里"别的机器留下的路径"：推源根、算计划、落地。
//
// 三条判据要钉死：
//   1) 源根是从日志里推出来的（末段与会话根同名的那个前缀），推不出就让调用方用 from 给；
//   2) 只要有取值映射不上，这条会话就整条不修（半修等于没修，宿主照样读不出来）；
//   3) 落地是"备份 → 原子替换 → 复验"，复验不过时原文件一个字节都没动。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import type { DiscoveredSession } from '../src/discovery.ts'
import { projectKey } from '../src/project-key.ts'
import { applyPathRepair, deriveSourceRoot, planPathRepair } from '../src/path-repair.ts'
import type { DecodeAll } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const FOREIGN_ROOT = 'C:\\Users\\me\\Work\\repo'

/** 造一条会话目录（项目目录 + 会话目录 + 一份日志），返回发现阶段会给出的那个形状。 */
function writeSession(
  root: string,
  id: string,
  cwd: string,
  values: readonly string[],
): DiscoveredSession {
  const dir = join(root, projectKey(cwd), id)
  mkdirSync(dir, { recursive: true })
  const frames = [
    encodeRawFrame(JSON.stringify({ type: 'session', version: 4, id, createdAt: 7, cwd, isSeeded: false, delegationDepth: 0 }) + '\n'),
    ...values.map((value, index) =>
      encodeRawFrame(JSON.stringify({ type: 'working-directory/change', seq: index, time: 10 + index, data: { cwd: value } }) + '\n'),
    ),
  ]
  const bytes = Buffer.concat(frames)
  const name = 'session.v4.jsonl.zstd'
  writeFileSync(join(dir, name), bytes)
  return {
    dirName: id,
    dir,
    id,
    cwd,
    createdAt: 7,
    header: { type: 'session', version: 4, id, createdAt: 7, cwd, isSeeded: false, delegationDepth: 0 },
    files: [{ name, path: join(dir, name), version: 4, compression: 'zstd', bytes: bytes.length }],
  }
}

function makeRoot(name: string): string {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  return join(base, 'sessions')
}

test('推源根：取末段与会话根同名的那个前缀（工作树路径也认得出会话根）', () => {
  assert.equal(
    deriveSourceRoot([`${FOREIGN_ROOT}\\.agents\\worktrees\\fix\\x`, FOREIGN_ROOT], '/home/me/repo'),
    FOREIGN_ROOT,
  )
  // 顺序反过来也照样取最长的那个同名前缀
  assert.equal(
    deriveSourceRoot([FOREIGN_ROOT, `${FOREIGN_ROOT}\\.agents\\worktrees\\fix\\x`], '/home/me/repo'),
    FOREIGN_ROOT,
  )
})

test('推源根：目录名对不上就推不出来（让人用 from 指定，不瞎猜）', () => {
  assert.equal(deriveSourceRoot(['D:\\somewhere\\other\\x'], '/home/me/repo'), undefined)
  assert.equal(deriveSourceRoot([], '/home/me/repo'), undefined)
})

test('算计划：只挑"本机不认的工作目录路径"，写清从哪个根搬到哪个根', () => {
  const root = makeRoot('path-repair-plan')
  const cwd = '/home/me/repo'
  const session = writeSession(root, 'session-w', cwd, [`${FOREIGN_ROOT}\\.agents\\worktrees\\fix\\x`, FOREIGN_ROOT])
  const clean = writeSession(root, 'session-clean', cwd, [cwd, '/home/me/other'])

  const plan = planPathRepair([session, clean], { decodeAll })
  assert.equal(plan.scanned.sessions, 2)
  assert.equal(plan.scanned.files, 2)
  assert.equal(plan.sessions.length, 1, '本机就合法的路径不该进计划')
  const entry = plan.sessions[0]!
  assert.equal(entry.id, 'session-w')
  assert.equal(entry.problem, undefined)
  assert.equal(entry.files.length, 1)
  assert.equal(entry.files[0]!.from, FOREIGN_ROOT)
  assert.equal(entry.files[0]!.to, cwd)
  assert.equal(entry.files[0]!.rewritten, 2)
  assert.deepEqual(entry.files[0]!.unmapped, [])

  rmSync(join(import.meta.dirname, '.sandbox', 'path-repair-plan'), { recursive: true, force: true })
})

test('算计划：有取值映射不上就整条不修，并把原因写出来', () => {
  const root = makeRoot('path-repair-unmapped')
  const cwd = '/home/me/repo'
  const session = writeSession(root, 'session-w', cwd, [FOREIGN_ROOT, 'D:\\elsewhere\\y'])

  const plan = planPathRepair([session], { decodeAll })
  const entry = plan.sessions[0]!
  assert.ok(entry.problem, '映射不上时这条不该直接修')
  assert.ok(entry.problem!.includes('D:\\elsewhere\\y'), '原因里要点出改不了的那个值')

  rmSync(join(import.meta.dirname, '.sandbox', 'path-repair-unmapped'), { recursive: true, force: true })
})

test('算计划：给 from 就不推，按给的根算', () => {
  const root = makeRoot('path-repair-from')
  const cwd = '/home/me/repo'
  const session = writeSession(root, 'session-w', cwd, ['D:\\somewhere\\other\\x'])

  assert.equal(planPathRepair([session], { decodeAll }).sessions[0]!.problem === undefined, false, '推不出来时不修')
  const plan = planPathRepair([session], { decodeAll, from: 'D:\\somewhere\\other' })
  const entry = plan.sessions[0]!
  assert.equal(entry.problem, undefined)
  assert.deepEqual(entry.files[0]!.mappings, [{ from: 'D:\\somewhere\\other\\x', to: `${cwd}/x` }])

  rmSync(join(import.meta.dirname, '.sandbox', 'path-repair-from'), { recursive: true, force: true })
})

test('落地：备份原字节、原子替换、复验通过；再算一遍计划是空的', () => {
  const base = join(import.meta.dirname, '.sandbox', 'path-repair-apply')
  const root = join(base, 'sessions')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const cwd = '/home/me/repo'
  const session = writeSession(root, 'session-w', cwd, [`${FOREIGN_ROOT}\\.agents\\worktrees\\fix\\x`, FOREIGN_ROOT])
  const original = readFileSync(session.files[0]!.path)

  const plan = planPathRepair([session], { decodeAll })
  const outcome = applyPathRepair(plan.sessions, { decodeAll, backupRoot: join(base, 'backups'), now: new Date('2026-11-13T00:00:00Z') })
  assert.equal(outcome.files, 1)
  assert.equal(outcome.events, 2)
  assert.deepEqual(outcome.problems, [])
  assert.ok(outcome.backupDir)

  const backup = join(outcome.backupDir!, 'sessions', projectKey(cwd), 'session-w', 'session.v4.jsonl.zstd')
  assert.deepEqual(readFileSync(backup), original, '备份是改写前的逐字节副本')
  assert.equal(existsSync(join(outcome.backupDir!, 'repair.json')), true)
  assert.equal(existsSync(`${session.files[0]!.path}.dsh-session-manager.tmp`), false, '临时文件不该留下')

  const after = decodeAll(readFileSync(session.files[0]!.path))
  assert.deepEqual(
    after.split('\n').filter((line) => line.includes('working-directory/change')).map((line) => JSON.parse(line).data.cwd),
    [`${cwd}/.agents/worktrees/fix/x`, cwd],
  )
  assert.deepEqual(planPathRepair([session], { decodeAll }).sessions, [], '修完再算一遍计划必须空')

  rmSync(base, { recursive: true, force: true })
})

test('落地：写盘前复验不过就抛，原文件一个字节都不动（不留半成品）', () => {
  const base = join(import.meta.dirname, '.sandbox', 'path-repair-guard')
  const root = join(base, 'sessions')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const cwd = '/home/me/repo'
  const session = writeSession(root, 'session-w', cwd, [FOREIGN_ROOT])
  const original = readFileSync(session.files[0]!.path)
  const plan = planPathRepair([session], { decodeAll })
  assert.equal(plan.sessions[0]!.problem, undefined)

  // 故意换一个"写坏的压缩器"：帧里的内容被截短，落盘前那一份就不对了。
  const broken = (text: string): Buffer => encodeRawFrame(text.slice(0, Math.max(text.length - 3, 0)))
  assert.throws(
    () => applyPathRepair(plan.sessions, { decodeAll, compressFrame: broken }),
    /mismatch|verification/,
    '改写结果对不上时必须抛错',
  )
  assert.deepEqual(readFileSync(session.files[0]!.path), original, '抛错时原文件必须原样')
  assert.equal(existsSync(`${session.files[0]!.path}.dsh-session-manager.tmp`), false, '连临时文件都不该留下')

  rmSync(base, { recursive: true, force: true })
})
