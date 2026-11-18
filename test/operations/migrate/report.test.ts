// test/operations/migrate/report.test.ts — 迁移**给模型看的那一份**文字（`src/operations/migrate/report.ts`）。
//
// 为什么单独钉它：预览与执行结果都只回结构化数据，那段文字是工具的渲染结果（模型只有这一面）；
// 界面不吃这一份，它按同一份结构自己拼（见 test/plugin/client.test.mjs 的迁移结果页那两条）。
// 这里用现造的预览 / 结果对象，把"点名哪几条、留在哪、复核与备份、怎么生效"逐条钉住。
import assert from 'node:assert/strict'
import test from 'node:test'

import type { MigrationPreview, MigrationRun } from '../../../src/operations/migrate/migrate.ts'
import { describeMigrationPreview, describeMigrationRun } from '../../../src/operations/migrate/report.ts'

/** 一份最简单的预览：一条会话，注册表要新建目标工作区，没有少搬的。 */
function preview(overrides: Partial<MigrationPreview> = {}): MigrationPreview {
  return {
    ok: true,
    problems: [],
    sessionIds: ['session-a'],
    to: '/home/u/dev/beta',
    sourceProjectDirs: ['/home/u/.dsh/sessions/alpha'],
    targetProjectDir: '/home/u/.dsh/sessions/beta',
    sessions: [
      {
        id: 'session-a',
        createdAt: 5,
        registered: true,
        alreadyAtTarget: false,
        sourceDir: '/home/u/dev/alpha/session-a',
        targetDir: '/home/u/dev/beta/session-a',
        files: 2,
        bytes: 100,
      },
    ],
    cascaded: 0,
    liveSkipped: [],
    strandedSources: [],
    files: 2,
    bytes: 100,
    artifacts: null,
    registryChange: null,
    ...overrides,
  }
}

test('预览那段文字：说清搬几条、从哪到哪、谁搬不走、注册表怎么变', () => {
  const text = describeMigrationPreview(
    preview({
      cascaded: 1,
      liveSkipped: [{ id: 'session-live', createdAt: 1 }],
      strandedSources: [
        {
          workspaceId: 'ws-from',
          path: '/home/u/dev/alpha',
          title: '工作区甲',
          members: [
            { id: 'session-blank', reason: 'blank' },
            { id: 'session-archived', reason: 'archived' },
          ],
        },
      ],
      artifacts: { moves: 2, problems: [], skipped: [{ path: '/x/out.png', reason: '缺失' }] },
      problems: ['目标目录不存在'],
      registryChange: {
        targetId: 'ws-to',
        targetPath: '/home/u/dev/beta',
        targetTitle: 'beta',
        createdTarget: true,
        added: ['session-a'],
        adoptedFromUnowned: [],
        movedFrom: [{ workspaceId: 'ws-from', path: '/home/u/dev/alpha', sessionIds: ['session-a'] }],
        removedSources: [],
        droppedStale: [{ workspaceId: 'ws-from', path: '/home/u/dev/alpha', sessionIds: ['session-ghost'] }],
        unchanged: false,
      },
    }),
  )
  // 清单与去向
  assert.match(text, /迁移 1 个会话：/)
  assert.match(text, /来源项目目录：\/home\/u\/\.dsh\/sessions\/alpha/)
  assert.match(text, /-> \/home\/u\/dev\/beta/)
  assert.match(text, /日志文件 2 个；目标项目目录 \/home\/u\/\.dsh\/sessions\/beta/)
  assert.match(text, /其中 1 条是子智能体会话/)
  // 少搬的两类都要点名到 id（模型据此去处理）
  assert.match(text, /另有 1 条会话宿主持在内存里（还活着），这次不搬：session-live/)
  assert.match(text, /重启 DSH 之后再迁一次/)
  assert.match(text, /另有 2 条会话侧边栏不显示（空白 1、已归档 1），这次不搬：session-blank、session-archived/)
  assert.match(text, /它们留在 \/home\/u\/dev\/alpha，那几块工作区因此不会被删/)
  // 产物、注册表、问题
  assert.match(text, /会话产物：待搬 2 项、跳过 1 项/)
  assert.match(text, /注册表：目标工作区 ws-to（新建，前插）/)
  assert.match(text, /顺带清掉 1 条宿主不认的悬空登记/)
  assert.match(text, /问题 1 项：/)
})

test('结果那段文字：搬了几条、少搬了谁、复核与备份、怎么生效', () => {
  const run: MigrationRun = {
    applied: true,
    preview: preview({ liveSkipped: [{ id: 'session-live', createdAt: 1 }] }),
    rewritten: 2,
    moved: 1,
    artifactsMoved: 3,
    verified: true,
    backupDir: '/home/u/.dsh/dsh-session-manager/backups/2026-11-18T00-00-00',
    problems: [],
    effect: { kind: 'applied' },
    warm: { warmed: 1, failed: 0, unavailable: false, problems: [] },
  }
  const text = describeMigrationRun(run)
  assert.match(text, /已迁移 1 个会话（改写 2 个日志、移动 1 个目录、搬迁 3 项产物）。/)
  assert.match(text, /另有 1 条会话宿主持在内存里（还活着），这次没搬：session-live——重启 DSH 之后再迁一次。/)
  assert.match(text, /复核：通过。备份：\/home\/u\/\.dsh\/dsh-session-manager\/backups\/2026-11-18T00-00-00/)
  // 怎么生效与侧边栏标题那两句来自共用件（describeEffect / describeWarm），这里只核它们接上了。
  assert.match(text, /无需重启 DSH/)
  assert.match(text, /已请宿主折好这 1 条会话的列表元数据/)
})
