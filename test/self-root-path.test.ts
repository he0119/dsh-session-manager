// 跟着会话根搬的路径：映射规则与"只动那几个字段"的行级改写。
//
// 这一层是所有改写路径的底座（导入落地、修已落地的日志、两边比对都走它），所以这里的判据要钉死：
// 值只在源根底下才翻译、翻译只动 `data` 里那一个字段、原样保留的部分一个字节都不变。
import assert from 'node:assert/strict'
import test from 'node:test'

import { mapUnderRoot, rewriteSelfRootLine, SELF_ROOT_PLACEHOLDER } from '../src/self-root-path.ts'

const WINDOWS_ROOT = 'C:\\Users\\me\\Work\\repo'
const POSIX_ROOT = '/home/me/repo'

test('mapUnderRoot：源根底下的子路径按同一套段翻译，分隔符跟着目标走', () => {
  assert.equal(
    mapUnderRoot(`${WINDOWS_ROOT}\\.agents\\worktrees\\fix\\x`, WINDOWS_ROOT, POSIX_ROOT),
    '/home/me/repo/.agents/worktrees/fix/x',
  )
  assert.equal(mapUnderRoot('/home/me/repo/.agents/x', POSIX_ROOT, WINDOWS_ROOT), 'C:\\Users\\me\\Work\\repo\\.agents\\x')
})

test('mapUnderRoot：值正好等于源根时得到目标根（不拼多余的结尾分隔符）', () => {
  assert.equal(mapUnderRoot(WINDOWS_ROOT, WINDOWS_ROOT, POSIX_ROOT), POSIX_ROOT)
  assert.equal(mapUnderRoot(POSIX_ROOT, POSIX_ROOT, POSIX_ROOT), POSIX_ROOT)
})

test('mapUnderRoot：不在源根底下、或只是"名字像"的兄弟目录都不翻译', () => {
  assert.equal(mapUnderRoot('C:\\Users\\me\\Work\\other\\x', WINDOWS_ROOT, POSIX_ROOT), undefined)
  assert.equal(mapUnderRoot('C:\\Users\\me\\Work\\repo-backup', WINDOWS_ROOT, POSIX_ROOT), undefined)
  assert.equal(mapUnderRoot('/home/me', POSIX_ROOT, WINDOWS_ROOT), undefined)
})

test('mapUnderRoot：不分大小写地认盘符之外的段（段本身逐字比）', () => {
  // 段比较是逐字的：大小写不同就是另一条路径，宁可不动也不猜。
  assert.equal(mapUnderRoot('c:\\Users\\me\\Work\\repo\\x', WINDOWS_ROOT, POSIX_ROOT), undefined)
})

test('rewriteSelfRootLine：只改 working-directory/change 的 cwd，其余字段与取值原样', () => {
  const line = JSON.stringify({
    type: 'working-directory/change',
    seq: 7,
    time: 123,
    data: { cwd: `${WINDOWS_ROOT}\\.agents\\worktrees\\fix\\x` },
  })
  const result = rewriteSelfRootLine(line, { root: WINDOWS_ROOT, to: POSIX_ROOT })
  assert.equal(result.changes.length, 1)
  assert.deepEqual(result.changes[0], { field: 'cwd', before: `${WINDOWS_ROOT}\\.agents\\worktrees\\fix\\x`, after: '/home/me/repo/.agents/worktrees/fix/x' })
  assert.deepEqual(JSON.parse(result.line), {
    type: 'working-directory/change',
    seq: 7,
    time: 123,
    data: { cwd: '/home/me/repo/.agents/worktrees/fix/x' },
  })
  assert.deepEqual(result.unmapped, [])
})

test('rewriteSelfRootLine：别的类型的事件一行都不动（正文里的旧路径属于历史事实）', () => {
  const line = JSON.stringify({
    type: 'user/message',
    seq: 3,
    time: 1,
    data: { content: [{ type: 'text', text: `我把东西放在 ${WINDOWS_ROOT} 下` }] },
  })
  const result = rewriteSelfRootLine(line, { root: WINDOWS_ROOT, to: POSIX_ROOT })
  assert.equal(result.line, line)
  assert.deepEqual(result.changes, [])
})

test('rewriteSelfRootLine：accept 说不改就不改（落地那条路用它跳过"本机本来就合法"的值）', () => {
  const line = JSON.stringify({ type: 'working-directory/change', seq: 1, time: 1, data: { cwd: '/home/me/repo/sub' } })
  const result = rewriteSelfRootLine(line, { root: '/home/me/repo', to: '/elsewhere', accept: () => false })
  assert.equal(result.line, line)
  assert.deepEqual(result.changes, [])
})

test('rewriteSelfRootLine：映射不上的值原样保留并记进 unmapped', () => {
  const line = JSON.stringify({ type: 'working-directory/change', seq: 1, time: 1, data: { cwd: 'D:\\somewhere\\else' } })
  const result = rewriteSelfRootLine(line, { root: WINDOWS_ROOT, to: POSIX_ROOT })
  assert.equal(result.line, line)
  assert.deepEqual(result.unmapped, ['D:\\somewhere\\else'])
})

test('rewriteSelfRootLine：坏行与非事件行原样返回（不抛、不改）', () => {
  assert.equal(rewriteSelfRootLine('{not json', { root: WINDOWS_ROOT, to: POSIX_ROOT }).line, '{not json')
  const noData = JSON.stringify({ type: 'working-directory/change', seq: 1, time: 1 })
  assert.equal(rewriteSelfRootLine(noData, { root: WINDOWS_ROOT, to: POSIX_ROOT }).line, noData)
})

test('rewriteSelfRootLine：比对归一用的占位符是 NUL 开头，不会撞上真实路径', () => {
  const line = JSON.stringify({ type: 'working-directory/change', seq: 1, time: 1, data: { cwd: `${POSIX_ROOT}/a` } })
  const result = rewriteSelfRootLine(line, { root: POSIX_ROOT, to: SELF_ROOT_PLACEHOLDER })
  assert.equal(JSON.parse(result.line).data.cwd, `${SELF_ROOT_PLACEHOLDER}/a`)
  assert.equal(SELF_ROOT_PLACEHOLDER.startsWith('\u0000'), true)
})
