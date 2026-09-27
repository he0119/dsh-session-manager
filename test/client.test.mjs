// test/client.test.mjs — Web Client 产物冒烟。
//
// 客户端那一半的失败模式与 Host 不同：它不在进程里跑，而是**由宿主的模块加载器执行**，
// 契约错了（id 不对、导出的面不对、require 了宿主没提供的模块、注册时机不对）在源码层面
// 全都看不出来——只有把产物按模块加载器的方式跑一遍才知道。
//
// 本文件因此做四件事：
//   1) 读产物文本，断言它只 require 平台基线模块（react / react/jsx-runtime）；
//   2) 用假的 `window.__ModuleLoader__` + 假 `require` 执行工厂，核对 id 与导出面；
//   3) 用假 ctx 跑 apply，核对注册到的槽位、id、locale 与注入面；
//   4) 核对两份字典键集完全一致（少一个键就是一处会露出键名的界面）。
//
// 产物不存在时整组跳过（源码开发不必先构建）。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundlePath = join(root, 'lib', 'client.js')
const ready = existsSync(bundlePath)
const skip = ready ? false : 'lib/client.js 不存在，先跑 pnpm run build'

const code = ready ? readFileSync(bundlePath, 'utf8') : ''
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 假的 react：钩子给出初始值，同时把创建出来的元素记下来，供"页签还在吗"这类断言用。
 *
 * `firstNull` 是给"要验证**有数据**时那棵树"用的：页面骨架（ManagerPanel）就是用它自己的
 * `useState(null)` 持有会话库，而假钩子本来永远停在 null，于是有数据的分支（分组列表、
 * 各种表格）在冒烟里根本走不到。给了它就只替换**第一次** `useState(null)`——后面那些 null
 * 状态（错误提示、导入计划…）必须保持空，否则会渲染出不存在的数据。
 */
function fakeReact(recorded = [], firstNull = undefined) {
  let seeded = false
  const record = (type, props) => {
    const element = { type, props: props ?? {} }
    recorded.push(element)
    return element
  }
  return {
    // 只在**真的传了**位置参数时才覆盖 children：jsx-runtime 是把 children 放在 props 里的，
    // 无条件写会把它清掉（第一版就是这么把整棵树抹平的）。
    createElement: (type, props, ...children) =>
      record(type, {
        ...(props ?? {}),
        ...(children.length === 0 ? {} : { children: children.length > 1 ? children : children[0] }),
      }),
    useState: (value) => {
      if (!seeded && value === null && firstNull !== undefined) {
        seeded = true
        return [firstNull, () => {}]
      }
      return [value, () => {}]
    },
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Fragment: Symbol('Fragment'),
  }
}

/**
 * 从元素树里收集所有字符串（文案就是字符串，键回显也是）。
 *
 * 遇到**函数组件**就带着 props 调一次再往下走：本文件没有真的渲染器，不这么做的话嵌套的
 * 页面（默认那一页「导入导出」）永远不在树上，冒烟只能看见骨架那一层，页面里的错就漏过去了。
 * 假钩子是无状态的，多调一次不会改变什么。
 */
function strings(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const item of node) strings(item, out)
  else if (node !== null && typeof node === 'object') {
    if (typeof node.type === 'function') strings(node.type(node.props), out)
    else strings(node.props?.children, out)
  }
  return out
}

/** 极小的假 document：够 installStyles 用。 */
function fakeDocument(nodes) {
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node)
      nodes.push(node)
      node.parentNode = this
    },
    removeChild(node) {
      this.children = this.children.filter((child) => child !== node)
      node.parentNode = null
    },
  }
  return {
    head,
    querySelector: () => null,
    createElement: () => ({
      dataset: {},
      textContent: '',
      parentNode: null,
      style: {},
      remove: () => {},
    }),
  }
}

/** 按模块加载器的契约执行产物，返回工厂与其 id。 */
function loadBundle({ firstNull } = {}) {
  let entry = null
  const nodes = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { entry = value } } },
    document: fakeDocument(nodes),
    console,
  }
  vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' })
  assert.ok(entry !== null, '产物必须以 window.__ModuleLoader__.load({ id, factory }) 报名')
  const recorded = []
  const react = fakeReact(recorded, firstNull)
  const mod = entry.factory((specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') {
      return {
        jsx: (type, props) => react.createElement(type, props),
        jsxs: (type, props) => react.createElement(type, props),
        Fragment: react.Fragment,
      }
    }
    throw new Error(`产物 require 了平台模块表里没有的模块：${specifier}`)
  })
  return { entry, mod, nodes, recorded }
}

test('客户端产物：只 require 平台基线模块，id 与包名一致', { skip }, () => {
  const requires = [...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)].sort(), ['react', 'react/jsx-runtime'])
  // 反面证据：宿主 UI 原语包不是稳定契约，一 require 就会把整页绑在它上面。
  assert.equal(/dsh-client-ui-primitives/.test(code), false, '不该 require 宿主的 UI 原语包')

  const { entry } = loadBundle()
  assert.equal(entry.id, pkg.name, '工厂 id 必须是包名')
})

test('客户端产物：导出面符合客户端插件契约', { skip }, () => {
  const { mod } = loadBundle()
  assert.equal(mod.name, pkg.name)
  // 展开一层：产物在另一个 vm realm 里，它的 Array 原型与本文件的不是同一个，
  // deepStrictEqual 会以「结构相同但引用不等」判定失败。
  assert.deepEqual([...mod.inject], ['slots', 'locale'])
  assert.equal(typeof mod.apply, 'function')
})

/** 跑一次 apply，收下所有注册面（后面几个用例共用）。 */
function mount({ translate, state } = {}) {
  const { mod, nodes, recorded } = loadBundle({ firstNull: state })
  const registrations = []
  const dictionaries = []
  const effects = []
  const injectedSlots = []
  const injectedServices = []
  const bound = []
  const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)

  mod.apply({
    effect(callback, label) {
      effects.push(label)
      return callback()
    },
    inject(dependencies, callback) {
      // 客户端壳里这就是就地起一个带依赖声明的子 fiber；这里只记下依赖并立刻跑一遍回调，
      // 顺带记下回调拿到的服务，好在用例里核对「浏览…」真的接在宿主选择器上。
      injectedServices.push({ dependencies })
      const scoped = {
        uiWorkspace: {
          async pickDirectory() {
            return '/tmp/picked'
          },
          async listDirectory(path) {
            // 宿主 browse 能力的形状：一层目录 + 面包屑（这里只求字段齐，页面能画出来）。
            return {
              path: path ?? '/home/tester',
              home: '/home/tester',
              crumbs: [{ name: 'home', path: '/home', hidden: false }],
              entries: [{ name: 'work', path: `${path ?? '/home/tester'}/work`, hidden: false }],
              truncated: false,
            }
          },
        },
      }
      return callback(scoped)
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
      bind(namespace) {
        bound.push(namespace)
        return translate ?? t
      },
    },
    slots: {
      inject(slot, callback) {
        injectedSlots.push(slot)
        return callback()
      },
      register(registration, component) {
        registrations.push({ registration, component })
        return () => {}
      },
    },
  })

  return { mod, nodes, recorded, registrations, dictionaries, effects, injectedSlots, injectedServices, bound, t }
}

test('客户端产物：apply 把「会话管理」注册到设置里的一页，并带上字典与注入面', { skip }, async () => {
  const { nodes, registrations, dictionaries, effects, injectedSlots, injectedServices, bound, t } = mount()

  // 槽位用 inject 等声明到位，而不是直接 register——声明可能晚于本插件 apply。
  assert.deepEqual(injectedSlots, ['settings.section'])
  assert.equal(registrations.length, 1)
  const { registration, component } = registrations[0]
  assert.equal(registration.name, 'settings.section')
  assert.equal(registration.id, 'session-manager')
  assert.equal(registration.locale, 'dsh-session-manager')
  // 排官方那几页之后（账户 -10 / 通用 0 / 模型 10 / 插件 15 / Agent 预设 20），不插队。
  assert.equal(registration.order, 30)
  assert.equal(typeof registration.label(), 'string', 'label 必须是可投影的文案')
  assert.equal(typeof component, 'function', '注册的必须是一个组件')
  // bind 是惰性的（label 与 inject 都是 thunk），上面调用 label() 之后它才被绑过
  assert.deepEqual(bound, ['dsh-session-manager'])

  // 注入面里的 t 就是绑到本命名空间的翻译函数
  assert.equal(registration.inject().t, t)

  // 目录选择器：作为**可选**依赖收（`uiWorkspace` 由别的客户端插件提供，不写进顶层 inject），
  // 注入面给出的是一个"取当前选择器"的 thunk，点击时才作数。
  // 跨 realm：产物在另一个 vm 里，它的数组原型与本文件的不是同一个，先摊成宿主数组再比。
  assert.deepEqual(
    injectedServices.map((entry) => [...entry.dependencies]),
    [['uiWorkspace']],
  )
  // 两个调用面都要接上：宿主只给其中一个（`native` 给 pick、`browse` 给 list），
  // 界面按 /state 里的 pickerKind 选一种用，所以这里两个都得能取到。
  const picker = registration.inject().directory
  assert.equal(typeof picker, 'function', '界面要能取到宿主目录选择器')
  const api = picker()
  assert.equal(typeof api.pick, 'function', '界面要能取到宿主的系统对话框调用')
  assert.equal(typeof api.list, 'function', '界面要能取到宿主的目录浏览调用')
  assert.equal(await api.pick(), '/tmp/picked', '取到的就是宿主 uiWorkspace 的 pickDirectory')
  const listing = await api.list('/home/tester')
  assert.equal(listing.path, '/home/tester', 'listDirectory 的返回原样透出（路径由宿主说了算）')

  // 字典：两份语言、同一个命名空间
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'dsh-session-manager')
  const { zh, en } = dictionaries[0].dicts
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '两份字典的键集必须一致')
  assert.ok(Object.keys(zh).length > 20, '字典不该是空壳')

  // 样式随 effect 注入
  assert.ok(nodes.length >= 1, 'installStyles 应当往 head 里放一个 <style>')
  assert.ok(effects.some((label) => String(label).includes('stylesheet')))
})

test('客户端产物：导航行的文案跟着语言走（同一个 thunk 每次投影重新取）', { skip }, () => {
  // 设置外壳投影导航行时走 resolveSlotLabel（是函数就调用），并且订阅了 locale 快照：
  // 因此这里必须能在不重新注册的前提下换一份文案，否则切语言后导航行会停在旧语言。
  let active = 'zh'
  const { registrations } = mount({
    translate: () => (active === 'zh' ? '会话管理' : 'Session management'),
  })
  const { label } = registrations[0].registration
  assert.equal(label(), '会话管理')
  active = 'en'
  assert.equal(label(), 'Session management')
})

test('客户端产物：页面骨架带着两个页内分页（导入导出 / 迁移）', { skip }, () => {
  const { registrations } = mount()
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  // 用注入面给的 t（键回显）渲染，于是文案就等于字典键，断言不依赖任何一种语言。
  const element = component(inject())
  const text = strings(element)
  assert.ok(text.includes('tabTransfer'), '页内要有「导入导出」这一页')
  assert.ok(text.includes('tabMigrate'), '页内要有「迁移」这一页')
  assert.ok(text.includes('title'), '页面标题走同一份字典')
})

test('客户端产物：页面组件在初始状态下能渲染成元素（不抛）', { skip }, () => {
  const { registrations } = mount()
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  // 假 react 的钩子返回初始值，因此走的是「还没读到数据」那一支渲染；
  // 它照样会把整个函数体跑一遍（文案、格式化、表格骨架），是产物层面最便宜的渲染冒烟。
  const element = component(inject())
  assert.equal(typeof element, 'object')
  assert.notEqual(element, null)
  // 注意首帧只渲染当前那一页（默认「导入导出」），迁移页要点了页签才在树上：
  // 目录字段的两种分支因此不在这个冒烟用例的射程内，别把断言写在这里骗自己。
})

test('客户端产物：导出列表按目录分组，组头就是"整组勾选"的入口', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 2048, files: [] },
      { id: 's-2', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 1024, files: [] },
      { id: 's-3', cwd: '/home/u/dev/beta', createdAt: 3, dir: '/home/u/dev/beta', bytes: 512, files: [] },
      { id: 's-4', createdAt: 4, dir: '_no-cwd', bytes: 256, files: [] },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const { registrations, recorded } = mount({ state })
  const { component, registration } = registrations[0]
  // 假钩子不会真的 setState，所以这里只验证**结构**：分组、组名、组头的调用面。
  // 勾选的增删逻辑在 test/groups.test.ts，靠这里的假钩子点不出来。
  const text = strings(component(registration.inject()))

  assert.ok(text.includes('工作区甲'), '已登记的工作区拿标题当组名')
  assert.ok(text.includes('/home/u/dev/alpha'), '组名旁边还要给出路径')
  assert.ok(text.includes('/home/u/dev/beta'), '没登记的目录也要成组（按路径）')
  assert.ok(text.includes('unregisteredDir'), '没登记的目录要标出来，别让人以为它不在册')
  assert.ok(text.includes('noCwdGroup'), '没有 cwd 的会话自成一组建在最后')
  assert.ok(text.some((item) => String(item).startsWith('sessionsInDir:')), '组头要给出这一组有几条')

  // 三组会话 = 三条组头；一条会话一行，行里不再重复 cwd（它已经在组头上）。
  const heads = recorded.filter((element) => element.props?.className === 'dsm-groupHead')
  assert.equal(heads.length, 3, '一组一条组头')
  // 整组勾选的入口是组头上那个框：它的无障碍名字必须说清是哪一组（"整组勾选／取消：工作区甲"），
  // 否则读屏用户在一堆同名框里分不出点的是谁。文案在 props 里，所以只能从树上取，不在 strings()。
  const groupBoxes = recorded.filter(
    (element) => element.type === 'input' && String(element.props?.['aria-label'] ?? '').startsWith('selectGroup:'),
  )
  assert.equal(groupBoxes.length, 3, '每条组头一个"整组勾选"的框')
  assert.ok(
    groupBoxes.some((element) => String(element.props['aria-label']).includes('工作区甲')),
    '框的名字里要带上组名',
  )
  const rows = recorded.filter((element) => element.type === 'label' && String(element.props?.className).includes('dsm-rowExport'))
  assert.equal(rows.length, 4, '每条会话一行')
})
