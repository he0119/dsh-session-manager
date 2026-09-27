// test/planRows.test.ts — 导入预演表里「cwd 那一格」的判定。
//
// 这一格在用户截图上错过：一次 20 条**全部跳过**的导入，每一行的 cwd 都写着
// 「保持无 cwd（落 _no-cwd）」，而那些会话明明都有 cwd（截图里第一条就在
// /home/uy_sun/dev/dsh-aperture），并且它们根本不会被写盘。等于把"什么都不会发生"说成了
// "你的会话要被丢进无 cwd 桶"。根因是那一格只判断 `toCwd === undefined`——跳过的行按设计也没有
// `toCwd`（见 `src/transfer.ts` 的 ImportEntry），于是两支不同的情况被合并成了一句错话。
//
// 判定抽成了 `src/client/planRows.ts`（纯函数），所以三支分支能在这里逐个钉死。
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeCwd } from '../src/client/planRows.ts'

// 同 groups.test.ts：不 import `src/client/api.ts`（它会把 src/client 拉进没有 DOM 的 Host 工程）。

test('跳过的行：说"跳过"，不说 cwd 会怎样', () => {
  // 这条就是截图里那一条：有 cwd、但库里已经有同 id，所以不会写盘。
  const plan = describeCwd({ action: 'skip', fromCwd: '/home/uy_sun/dev/dsh-aperture' })
  assert.deepEqual(plan, { kind: 'skip' })
})

test('会写的行且有 cwd：给出"从哪到哪"', () => {
  const plan = describeCwd({
    action: 'create',
    fromCwd: '/home/uy_sun/dev/alpha',
    toCwd: '/home/uy_sun/test',
  })
  assert.deepEqual(plan, { kind: 'rewrite', from: '/home/uy_sun/dev/alpha', to: '/home/uy_sun/test' })
})

test('包里没有 cwd 的会话：才会落 _no-cwd', () => {
  assert.deepEqual(describeCwd({ action: 'create' }), { kind: 'keepNoCwd' })
})

test('会写、有目标路径但包里没记原 cwd（坏数据）：原路径退成占位符，别显示成空', () => {
  assert.deepEqual(describeCwd({ action: 'create', toCwd: '/home/uy_sun/test' }), {
    kind: 'rewrite',
    from: '—',
    to: '/home/uy_sun/test',
  })
})
