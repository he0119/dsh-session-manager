import assert from 'node:assert/strict'
import test from 'node:test'

import { detectProjectKeyCollision, projectKey } from '../src/project-key.ts'

// 以下三个期望值直接取自本机真实存在的会话项目目录名（宿主自己写出来的），
// 因此是"与宿主逐字节一致"的回归锚点。
test('projectKey 复刻宿主：真实项目目录名', () => {
  assert.equal(projectKey('C:\\Users\\hmy01\\Downloads'), '--C-Users-hmy01-Downloads--')
  assert.equal(projectKey('C:\\Users\\hmy01\\Downloads\\tdx-adblock'), '--C-Users-hmy01-Downloads-tdx-adblock--')
  assert.equal(projectKey('C:\\Users\\hmy01\\Works\\Temp\\dsh-temp'), '--C-Users-hmy01-Works-Temp-dsh-temp--')
})

test('projectKey：连续分隔符折叠成一个', () => {
  assert.equal(projectKey('C:\\\\Users'), '--C-Users--')
  assert.equal(projectKey('C:/Users'), '--C-Users--')
  assert.equal(projectKey('C:\\/\\Users'), '--C-Users--')
})

test('projectKey：非安全字符转 ~XXXX 大写十六进制', () => {
  // 中文（CJK）逐码元转义
  assert.equal(projectKey('C:\\电子'), '--C-~7535~5B50--')
  // '~' 自身也被转义（否则编码不可逆）
  assert.equal(projectKey('C:\\a~b'), '--C-a~007Eb--')
  // 允许集含 '-' 与 '.'，保持字面
  assert.equal(projectKey('C:\\my-proj.v2'), '--C-my-proj.v2--')
})

test('projectKey：去掉开头分隔符；全分隔符退化为 root', () => {
  assert.equal(projectKey('\\\\server\\share'), '--server-share--')
  assert.equal(projectKey('///'), '--root--')
})

test('projectKey：空路径抛错（与宿主一致）', () => {
  assert.throws(() => projectKey(''), /empty project path/)
})

test('projectKey：有损编码的碰撞确实存在且能被检测出', () => {
  // 分隔符折叠是有损的：'C:\x\y' 与 'C:\x-y' 编码结果完全相同，
  // 而宿主的 realpath 唯一性检查抓不到这种碰撞——需要本守卫兜住。
  assert.equal(projectKey('C:\\x\\y'), '--C-x-y--')
  assert.equal(projectKey('C:\\x-y'), '--C-x-y--')
  const collisions = detectProjectKeyCollision(['C:\\x\\y', 'C:\\x-y', 'C:\\z'])
  assert.equal(collisions.length, 1)
  assert.equal(collisions[0]?.key, '--C-x-y--')
  assert.deepEqual(collisions[0]?.cwds.sort(), ['C:\\x-y', 'C:\\x\\y'])
})

test('detectProjectKeyCollision：同一 cwd 重复出现不算碰撞', () => {
  assert.equal(detectProjectKeyCollision(['C:\\x\\y', 'C:\\x\\y']).length, 0)
  assert.equal(detectProjectKeyCollision(['C:\\z']).length, 0)
})
