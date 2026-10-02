// test/config.test.ts — 插件配置的 schema 与"活字段"的读法。
//
// 这一层钉的是**设置面能不能改、改完要不要重启**：`sync` 那一节带 volatile，于是它在宿主手里是活
// 引用，界面改完下一次调用就用新值；三个路径字段不带，于是它们既不会出现在表单里、也不会半生效。
// 判据不看实现，只看两件事：解析出来的形状里谁带 `.get()`，以及改一次引用后读出来的是不是新值。
import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, syncSection, type PluginConfigInput } from '../src/config.ts'
import { describeSyncConfig, syncRuntime } from '../src/tools.ts'

test('配置 schema：只有 sync 那一节是活引用，三个路径字段是普通值', () => {
  const parsed = Config({
    sessionsRoot: '/srv/sessions',
    registryPath: '/srv/workspace.json',
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mapping: { '/p': '/q' } },
  }) as unknown as Record<string, unknown>

  assert.equal(parsed['sessionsRoot'], '/srv/sessions', '路径字段照旧是快照值（改了要重启，别当活字段）')
  assert.equal(parsed['registryPath'], '/srv/workspace.json')
  const sync = parsed['sync'] as { get?: () => unknown }
  assert.equal(typeof sync.get, 'function', 'sync 是活引用：Loader 按固定路径找到它并就地更新')
  assert.deepEqual(sync.get?.(), { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mapping: { '/p': '/q' } })
})

test('配置 schema：缺席那一节不冒充"填了空"', () => {
  // schema 的可调用面在类型上只承诺"校验并返回配置"，具体形状由 PluginConfigRef 描述（声明里没法命名
  // 推导类型，见 src/config.ts）；测试这一层按运行期的形状读，所以这里显式指一次。
  const parsed = Config({}) as unknown as PluginConfigInput
  // 空对象里那个 `mapping: {}` 是 schemastery 给字典子节点填的空表，不是"用户配了"：判据只认 `url`，
  // 所以下面两条路都按"没配置"处理（表单也把它当空草稿）。
  assert.deepEqual(syncSection(parsed), { mapping: {} })
  assert.equal(syncSection(parsed)?.url, undefined)
  assert.equal(describeSyncConfig(parsed), undefined)
  assert.equal(describeSyncConfig({}), undefined)
  assert.equal(describeSyncConfig(undefined), undefined)
})

test('配置 schema：坏配置在装配时当场抛，而不是等到第一次同步', () => {
  assert.throws(() => Config({ sync: { url: 42 } }), 'URL 不是字符串')
  assert.throws(() => Config({ sync: { url: 'https://x', timeoutMs: 'soon' } }), '超时不是数字')
  assert.throws(() => Config({ sync: { url: 'https://x', mapping: { '/a': 1 } } }), '映射的值不是字符串')
  // 只给一部分字段是合法的：其余字段本来就允许缺席（URL 空 = 没开同步）。
  assert.doesNotThrow(() => Config({ sync: { machineId: 'robot-a' } }))
})

test('配置 schema：活引用每次现读（这就是"界面上改完不用重启"的全部机制）', async () => {
  let current: { url: string; mapping?: Record<string, string> } | undefined = { url: 'https://one.example/dav' }
  const live = { get: (): typeof current => current }
  const config = { sync: live } as unknown as PluginConfigInput

  assert.equal(describeSyncConfig(config)?.url, 'https://one.example/dav')
  const first = await syncRuntime({}, config)
  assert.equal(first?.settings.url, 'https://one.example/dav')
  assert.deepEqual(first?.settings.mapping, {})

  // 宿主那边的写入就是"往同一个引用里换一份值"：插件不需要重挂，下一次调用就看得见。
  current = { url: 'https://two.example/dav/', mapping: { '/home/alice/dev/proj': '/opt/work/proj' } }
  assert.equal(describeSyncConfig(config)?.url, 'https://two.example/dav/', 'URL 跟着引用走')
  assert.equal(describeSyncConfig(config)?.mappings, 1)
  const second = await syncRuntime({}, config)
  assert.equal(second?.settings.url, 'https://two.example/dav', '尾斜杠按老规矩去掉')
  assert.deepEqual(second?.settings.mapping, { '/home/alice/dev/proj': '/opt/work/proj' })

  // 清空（unset）之后回到"没配置"，而不是留着一份旧值。
  current = undefined
  assert.equal(describeSyncConfig(config), undefined)
  assert.equal(await syncRuntime({}, config), undefined)
})

test('配置 schema：活引用与普通对象给出同一份值（两种来路同一口径）', () => {
  const plain = { sync: { url: 'https://x.example/dav', machineId: 'm', mapping: { '/a': '/b' }, timeoutMs: 5000 } }
  const live = { sync: { get: () => plain.sync } }
  assert.deepEqual(describeSyncConfig(plain), describeSyncConfig(live as unknown as PluginConfigInput))
  assert.equal(describeSyncConfig(plain)?.machineId, 'm')
  assert.equal(describeSyncConfig(plain)?.mappings, 1)
})
