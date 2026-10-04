// 落地目录的规范拼写：宿主把工作区路径与会话 cwd 都存成 `fs.realpath` 归一之后的样子，并按字符串
// 相等比成员资格。这个测试钉住"另一种拼写会被换成宿主存的那个写法"。
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import test from 'node:test'

import { canonicalDir } from '../src/canonical-path.ts'

const SANDBOX = join(import.meta.dirname, '.sandbox', 'canonical-path')

test('canonicalDir：另一种拼写换回宿主存的那个写法', () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  const dir = join(SANDBOX, 'proj')
  const sub = join(dir, 'packages', 'web')
  mkdirSync(sub, { recursive: true })
  const real = realpathSync.native(dir)
  try {
    assert.equal(canonicalDir(dir), real, '已经是规范写法时不动它')
    assert.equal(canonicalDir(sub), realpathSync.native(sub))
    assert.equal(canonicalDir(`${dir}${sep}`), real, '结尾分隔符')
    assert.equal(canonicalDir(`${dir}${sep}.`), real, '结尾的 . 段')
    assert.equal(canonicalDir(join(sub, '..', '..')), real, '.. 段')
    // Windows 上 `git rev-parse --show-toplevel` 给的就是正斜杠写法，而宿主存的是反斜杠那个；
    // POSIX 上两者本来就是同一个字符串（这条断言在那里退化成"它没被改动"）。
    assert.equal(canonicalDir(dir.split(sep).join('/')), real, '正斜杠写法')
    if (process.platform === 'win32') {
      assert.equal(canonicalDir(dir.toUpperCase()), real, 'Windows 上大小写也算另一种拼写')
    }
  } finally {
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('canonicalDir：解析不出来的原样返回（"目标目录不存在"由调用方按原拼写报）', () => {
  const missing = join(SANDBOX, 'not-there')
  assert.equal(canonicalDir(missing), missing)
  assert.equal(canonicalDir(''), '', '空串（没有 cwd 的会话那条路）不该被换成别的东西')
})
