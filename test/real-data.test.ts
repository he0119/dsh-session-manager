// 真实数据回归：对着本机真实会话日志（拷贝副本）跑一遍改写与校验。
// 需要 DSM_FIXTURE 指向一个含 sessions/--C-Users-hmy01-Downloads-- 的备份目录；
// 未提供时整组跳过，保证单元测试可在无 fixture 的机器上运行。
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { projectKey } from '../src/project-key.ts'
import { relocateHeaderCwd } from '../src/session-log.ts'
import type { DecodeAll } from '../src/types.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const FIXTURE = process.env['DSM_FIXTURE']
const PROJECT_DIR = FIXTURE ? join(FIXTURE, 'sessions', '--C-Users-hmy01-Downloads--') : null
const enabled = Boolean(PROJECT_DIR && existsSync(PROJECT_DIR))
const FROM = 'C:\\Users\\hmy01\\Downloads'
const TO = 'C:\\Users\\hmy01\\Works\\Temp\\dsh-temp'

test(
  '真实日志：改写 cwd 后正文逐行不变',
  { skip: !enabled && 'set DSM_FIXTURE to a session backup dir' },
  () => {
    let files = 0
    let events = 0
    for (const dir of readdirSync(PROJECT_DIR!)) {
      const sd = join(PROJECT_DIR!, dir)
      for (const name of readdirSync(sd)) {
        if (!name.endsWith('.jsonl.zstd')) continue
        const buf = readFileSync(join(sd, name))
        const before = decodeAll(buf).split('\n')
        const r = relocateHeaderCwd(buf, { from: FROM, to: TO, decodeAll })
        const after = decodeAll(r.buffer).split('\n')
        assert.equal(after.length, before.length, `${dir}/${name}: 行数必须不变`)
        for (let i = 1; i < before.length; i++) {
          assert.equal(after[i], before[i], `${dir}/${name}: 第 ${i} 行被改动`)
        }
        assert.equal(r.nextHeader.cwd, TO)
        assert.equal(r.header.id, r.nextHeader.id)
        // 目录名必须与 header cwd 一致，否则宿主会判 corrupt session log
        assert.equal(projectKey(r.nextHeader.cwd!), '--C-Users-hmy01-Works-Temp-dsh-temp--')
        files++
        events += r.events
      }
    }
    assert.ok(files > 0, 'fixture 中应至少有一个会话日志')
    console.log(`      真实数据：${files} 个日志文件、${events} 个事件改写校验通过`)
  },
)
