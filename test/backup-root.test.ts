// test/backup-root.test.ts — 默认备份根落在哪，以及旧默认根的一次性搬迁。
//
// 默认值是对外契约：备份清单只读 `backupRoot` 一个根，`assertBackupDir()` 也只认它下面的路径，所以
// 这里把**字面路径**钉死（不复算一遍 join），并逐条摆出搬迁的取舍——路径换了、或者条件放宽成"两个根
// 都搬/合并"，这几条断言要能变红。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { adoptLegacyBackupRoot, resolvePaths } from '../src/tools.ts'

/** 旧默认根的目录名（0.3.x 及更早）。 */
const LEGACY = 'dsh-session-manager-backups'
/** 新默认根相对 `$DSH_HOME` 的那一段。 */
const CURRENT = join('dsh-session-manager', 'backups')

/**
 * 在一座临时 `$DSH_HOME` 下跑一段，跑完把环境变量与整座目录都还原。
 * @param fn 拿临时家目录当参数。
 */
function withHome(fn: (home: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'dsm-backup-root-'))
  const home = join(base, 'dsh')
  mkdirSync(home, { recursive: true })
  const before = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  try {
    fn(home)
  } finally {
    if (before === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = before
    rmSync(base, { recursive: true, force: true })
  }
}

test('默认备份根是 <DSH_HOME>/dsh-session-manager/backups', () => {
  withHome((home) => {
    const paths = resolvePaths()
    assert.equal(paths.backupRoot, join(home, 'dsh-session-manager', 'backups'), '备份根与 dsh-config-manager 那种「插件名 / 子目录」同一形状')
    assert.equal(paths.sessionsRoot, join(home, 'sessions'), '另外两个默认值不受这次改动影响')
    assert.equal(paths.registryPath, join(home, 'storages', 'workspace.json'))
  })
})

test('自己配了 backupRoot 就按配的来，搬家不动他的磁盘', () => {
  withHome((home) => {
    const configured = join(home, 'my-own-backups')
    assert.equal(resolvePaths({ backupRoot: configured }).backupRoot, configured)

    mkdirSync(join(home, LEGACY), { recursive: true })
    assert.equal(adoptLegacyBackupRoot({ backupRoot: configured }), undefined, '用户点了别的备份根，旧默认根不归这次改动管')
    assert.equal(existsSync(join(home, LEGACY)), true, '旧目录原样留着')
    assert.equal(existsSync(join(home, CURRENT)), false, '也不该顺手建出新根')
  })
})

test('旧默认根整个搬进插件目录，清单原样跟过去', () => {
  withHome((home) => {
    const from = join(home, LEGACY)
    const stamp = '2026-10-03T08-00-00-000Z'
    const manifest = '{"kind":"migrate","createdAt":"2026-10-03T08:00:00.000Z"}\n'
    mkdirSync(join(from, stamp, 'sessions'), { recursive: true })
    writeFileSync(join(from, stamp, 'manifest.json'), manifest)

    const adopted = adoptLegacyBackupRoot()
    assert.equal(adopted?.ok, true, '旧目录在、新目录不在：这一次要真的搬')
    assert.equal(adopted?.from, from)
    const to = join(home, 'dsh-session-manager', 'backups')
    assert.equal(adopted?.to, to)
    assert.equal(existsSync(from), false, '旧位置整个让出来，不留空壳')
    assert.deepEqual(readdirSync(to), [stamp], '搬的是整棵子树，不是逐份挑')
    assert.equal(readFileSync(join(to, stamp, 'manifest.json'), 'utf8'), manifest, '清单字节不变——它记着回滚要还原的路径')
    assert.equal(resolvePaths().backupRoot, to, '搬迁之后解析出来的备份根就是新位置')
  })
})

test('搬迁只做一次，一个条件不成立就不动', () => {
  withHome((home) => {
    assert.equal(adoptLegacyBackupRoot(), undefined, '没有旧目录：没得搬')
    assert.equal(existsSync(join(home, CURRENT)), false, '也不建空根')

    const from = join(home, LEGACY)
    mkdirSync(from, { recursive: true })
    writeFileSync(join(from, 'keep.txt'), 'old\n')
    const to = join(home, 'dsh-session-manager', 'backups')

    mkdirSync(to, { recursive: true })
    assert.equal(adoptLegacyBackupRoot(), undefined, '新根已经在了（哪怕是空的）：两份备份不合并')
    assert.equal(readFileSync(join(from, 'keep.txt'), 'utf8'), 'old\n', '旧目录原样留着')
    assert.deepEqual(readdirSync(to), [], '新根不该被塞进旧内容')
  })
})

test('搬不动就一动不动，并如实报错', () => {
  withHome((home) => {
    const from = join(home, LEGACY)
    mkdirSync(from, { recursive: true })
    // 新根要待的那一层先占成一个**文件**：新根因此"不存在"，而 mkdir 那一步必然失败。
    writeFileSync(join(home, 'dsh-session-manager'), 'not a directory\n')
    assert.equal(existsSync(join(home, CURRENT)), false, '夹具成立：新根本来就不存在')

    const adopted = adoptLegacyBackupRoot()
    assert.equal(adopted?.ok, false, '搬不动不许假装搬了')
    assert.equal(adopted?.from, from)
    assert.equal(typeof adopted?.error, 'string')
    assert.equal(existsSync(from), true, '备份是回滚的唯一凭据：搬不成宁可原地不动')
  })
})
