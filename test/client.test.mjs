// test/client.test.mjs — Web Client 产物冒烟。
//
// 客户端那一半的失败模式与 Host 不同：它不在进程里跑，而是**由宿主的模块加载器执行**，
// 契约错了（id 不对、导出的面不对、require 了宿主没提供的模块、注册时机不对）在源码层面
// 全都看不出来——只有把产物按模块加载器的方式跑一遍才知道。
//
// 本文件因此做四件事：
//   1) 读产物文本，断言它只 require 平台基线模块（react / react/jsx-runtime /
//      @deepseek-ai/dsh-client-ui-primitives），且不申请任何非基线模块；
//   2) 用假的 `window.__ModuleLoader__` + 假 `require` 执行工厂，核对 id 与导出面；
//   3) 用假 ctx 跑 apply，核对注册到的 Slot、id、locale 与注入面；
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
function fakeReact(recorded = [], firstNull = undefined, panel = undefined, firstArray = undefined) {
  let seeded = false
  let seededPanel = false
  let seededArray = false
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
      // 页内分页的状态：假钩子不会点页签，于是「迁移」那一页的 JSX 在冒烟里一次都跑不到。
      // 只替换**第一个** `useState('transfer')`（骨架里那个），其余字符串状态照旧。
      if (!seededPanel && value === 'transfer' && panel !== undefined) {
        seededPanel = true
        return [panel, () => {}]
      }
      // 勾选集：分页组件自己的第一个 `useState([])`。不给它种子，"按钮禁没禁用"就只能撞上
      // "一条都没勾所以禁用"这条分支，断言等于没测到宿主能力那件事（见下面那个用例的注释）。
      if (!seededArray && firstArray !== undefined && Array.isArray(value) && value.length === 0) {
        seededArray = true
        return [firstArray, () => {}]
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
 * 页面（默认那一页「传输」）永远不在树上，冒烟只能看见骨架那一层，页面里的错就漏过去了。
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

/**
 * 树里所有宿主元素（`type` 是字符串的那些），深度优先。
 *
 * `strings()` 只看得见文字，看不出"标题是 `h2` 还是 `span`"这种结构差别——而页头那份规格恰恰
 * 是结构（`h2` 独占一行 + `p` 说明行），所以单开一个只收元素的走法。
 */
function elements(node, out = []) {
  if (Array.isArray(node)) for (const item of node) elements(item, out)
  else if (node !== null && typeof node === 'object') {
    if (typeof node.type === 'function') elements(node.type(node.props), out)
    else if (typeof node.type === 'string') {
      out.push(node)
      elements(node.props?.children, out)
    }
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
function loadBundle({ firstNull, panel, firstArray } = {}) {
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
  const react = fakeReact(recorded, firstNull, panel, firstArray)
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
  // 平台基线模块：官方客户端包共用、不必写进 `dsh.client.external`。控件库是其中之一
  // （0.1.7-rc.2 这一代里，60 个 `dsh-client-*` 包有 46 个直接 require 它，没有一个声明成 external）。
  const baseline = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']
  for (const specifier of new Set(requires)) {
    assert.ok(
      baseline.includes(specifier),
      `产物 require 了非基线模块 ${specifier}：要用它就得先写进 dsh.client.external`,
    )
  }
  // 反面证据：非基线模块必须在 `dsh.client.external` 里点名申请，本包一个都没申请。
  assert.deepEqual(pkg.dsh?.client?.external ?? [], [], '本包不该申请非基线模块')

  const { entry } = loadBundle()
  assert.equal(entry.id, pkg.name, '工厂 id 必须是包名')
})

test('客户端产物：包后缀与宿主导出的文件名一致（.dshsess）', { skip }, () => {
  // 后缀曾经在这一侧写成 `.dhsess`（宿主 web.ts 的 fileName() 一直是 `.dshsess`，魔法字节也是
  // `DSHSESS1`）。看着只是错字，实际把功能弄坏了：导入的文件选择框带着 `accept=".dhsess"`，
  // 刚导出的包在下拉里被过滤器挡掉，用户以为导入坏了。
  assert.equal(/\.dhsess\b/i.test(code), false, '客户端产物里不该再出现 .dhsess 这个后缀')
  assert.ok(code.includes('.dshsess'), '文件选择框与文案要用 .dshsess')
  assert.ok(code.includes('accept: ".dshsess"'), '文件选择框的过滤器要与宿主导出的后缀一致')
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
function mount({ translate, state, panel, selection } = {}) {
  const { mod, nodes, recorded } = loadBundle({ firstNull: state, panel, firstArray: selection })
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

  // Slot 用 inject 等声明到位，而不是直接 register——声明可能晚于本插件 apply。
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

test('客户端产物：页面骨架带着三个页内分页（传输 / 迁移 / 会话）', { skip }, () => {
  const { registrations } = mount()
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  // 用注入面给的 t（键回显）渲染，于是文案就等于字典键，断言不依赖任何一种语言。
  const element = component(inject())
  const text = strings(element)
  assert.ok(text.includes('tabTransfer'), '页内要有「传输」这一页')
  assert.ok(text.includes('tabMigrate'), '页内要有「迁移」这一页')
  assert.ok(text.includes('tabManage'), '页内要有「会话」这一页（逐条归档 / 删除）')
  assert.ok(text.includes('title'), '页面标题走同一份字典')
})

test('客户端产物：页头是页面级标题（h2 + 说明行），不是卡片式的小标题', { skip }, () => {
  // 真实事故（用户报的）：这一页标题曾是 14px 的 `span`，跟内建设置页（`h2` 18px + 13px 说明行）
  // 摆在一起就是两种规格。结构层面的差别得在产物里钉住，不然改样式时很容易又退回 span。
  const { registrations } = mount()
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  const tree = elements(component(inject()))

  const heading = tree.find((node) => node.props?.className === 'dsm-title')
  assert.equal(heading?.type, 'h2', '页面标题必须是 h2（内建页就是 h2）')
  assert.ok(strings(heading).includes('title'), '标题文案走字典')
  assert.equal(tree.some((node) => node.props?.className === 'dsm-sub'), false, '旧的 .dsm-sub 不该再出现')

  const intro = tree.find((node) => node.props?.className === 'dsm-intro')
  assert.equal(intro?.type, 'p', '说明行是 p')
  assert.ok(
    strings(intro).some((text) => text.includes('library')),
    '说明行里带着会话库信息（路径与条数）',
  )
  // 标题行里只有标题、弹簧与刷新按钮：说明不在这一行里，否则又变成"挤在一行"。
  const row = tree.find((node) => node.props?.className === 'dsm-titleRow')
  assert.equal(row?.type, 'div', '标题行是一个 div')
  assert.ok(!strings(row).some((text) => text.includes('library')), '说明行不在标题行里')
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
  // 注意首帧只渲染当前那一页（默认「传输」），迁移页要点了页签才在树上：
  // 目录字段的两种分支因此不在这个冒烟用例的射程内，别把断言写在这里骗自己。
})

test('客户端产物：迁移页把「未分组」列成独立来源（注册表没认领的那批可以一次收编）', { skip }, () => {
  // 迁移页平时在产物冒烟里跑不到（页签状态停在「传输」），所以这里把页签 seed 成 'migrate'。
  // 这一页值得跑一遍：它的来源下拉框现在有两条路（目录 / 未分组），而"未分组"是个**跨目录**的来源
  // ——判据在 planRows.ts（有单测），这里只证明它真的被摆到了界面上、条数用的是库里的口径。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    pickerKind: 'browse',
    sessions: [
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 2048, files: [], workspaceId: 'w1' },
      { id: 's-2', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 1024, files: [] },
      { id: 's-3', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 512, files: [] },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const { registrations, recorded } = mount({ state, panel: 'migrate' })
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  const text = strings(component(inject()))

  assert.ok(text.includes('tabMigrate'), '页签还在（seeded 的那一页就是它）')
  assert.ok(text.includes('migrateTitle') && text.includes('sourceSessionsNone'), '迁移页本体渲染出来了')

  const options = recorded.filter((element) => element.type === 'option')
  const paths = options.map((element) => String(element.props?.value))
  assert.ok(paths.includes('/home/u/dev/alpha'), '已登记工作区的目录仍是候选')
  assert.ok(paths.includes('/home/u/dev/beta'), '没登记的目录（库里有会话）也是候选')
  const unowned = options.find((element) => element.props?.value === '@unowned')
  assert.ok(unowned, '源下拉框里必须有「未分组」这一行')
  // 条数 = 库里"没被任何工作区认领、且有 cwd"的会话数（s-2 与 s-3），不是某个目录的条数
  assert.ok(
    text.some((item) => String(item).includes('ungroupedSource') && String(item).includes('sessionsInDir:{"count":2}')),
    '未分组那一行要报出跨目录的条数',
  )
  // 哨兵值只该出现在 option 的 value 上，不该当文案露出来
  assert.equal(
    text.some((item) => String(item).includes('@unowned')),
    false,
    '界面上不该出现内部哨兵值',
  )
})

test('客户端产物：导出列表按目录分组，组头就是"整组勾选"的入口', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [
      // `workspaceId` 是宿主按注册表成员表填的：有值 = 被某个工作区登记在册，缺省 = 谁都没认领。
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 2048, files: [], workspaceId: 'w1' },
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

  // 两级各有各的图形标记：组头是文件夹（工作区），会话行是对话气泡。
  //
  // 为什么值得钉住：会话标题是**用户自己写的第一句话**，它长得像个工作区名是常事（本机就有一条
  // 叫"dsh-session-manager 使用说明"的会话）。同屏两级混排时，"这行是工作区还是会话"只能靠形状读，
  // 而形状是唯一一种"不用读字"就成立的线索——底色和缩进都会随主题、屏幕、色觉打折。
  // 少了标记不会报错、不会崩，只会让人认错行，所以这里按树核一遍。
  const levelIcons = (node, out = []) => {
    if (Array.isArray(node)) {
      for (const item of node) levelIcons(item, out)
      return out
    }
    if (node === null || typeof node !== 'object') return out
    // 图形是函数组件给出的：本文件没有渲染器，得自己带着 props 调一次才看得见 <svg>。
    if (typeof node.type === 'function') return levelIcons(node.type(node.props), out)
    const className = String(node.props?.className ?? '')
    if (className.includes('dsm-levelIcon')) out.push(className)
    return levelIcons(node.props?.children, out)
  }
  for (const head of heads) {
    assert.deepEqual(levelIcons(head), ['dsm-levelIcon dsm-levelWorkspace'], '每条组头挂一个工作区标记（文件夹）')
  }
  for (const row of rows) {
    assert.deepEqual(levelIcons(row), ['dsm-levelIcon dsm-levelSession'], '每条会话行挂一个会话标记（对话气泡）')
  }

  // 组头右侧那两串数字必须是**一整块**（一个 .dsm-groupCounts 里两个 .dsm-hint），而不是各自一个
  // flex 项：组头是 nowrap 的，靠的就是"整数块不可压 + 路径先截断"这一对。拆开两个 span 不会报错、
  // 不会崩，只会让那条修复悄悄失效（路径一长，数字又被挤到第二行），所以这里把结构钉住。
  const counts = recorded.filter((element) => element.props?.className === 'dsm-groupCounts')
  assert.equal(counts.length, 3, '每条组头一个计数块')
  for (const block of counts) {
    const children = Array.isArray(block.props.children) ? block.props.children : [block.props.children]
    const hints = children.filter(
      (child) => child !== null && typeof child === 'object' && String(child.props?.className) === 'dsm-hint',
    )
    assert.equal(hints.length, 2, '计数块里正好是"这组几条 / 选中几条"两条')
  }

  // 「未登记在册」这枚标签只该挂给注册表没认领的会话（行里 `workspaceId` 缺省的那些）。挂错或漏挂都
  // 不会抛错、不会崩，只会让"外壳侧边栏为什么把这些会话放进未分组"重新变成要靠人对着两个界面猜的
  // 谜——本机上真的被问过一次，所以按行核：先把每行的名字与标签取出来，再按名字对号入座。
  const rowFacts = (node, acc = { label: '', tags: [] }) => {
    if (Array.isArray(node)) {
      for (const item of node) rowFacts(item, acc)
      return acc
    }
    if (node === null || typeof node !== 'object') return acc
    if (typeof node.type === 'function') return rowFacts(node.type(node.props), acc)
    const className = String(node.props?.className ?? '')
    if (className.includes('dsm-tag')) acc.tags.push(node.props?.children)
    if (className === 'dsm-rowTitle' || className === 'dsm-rowId') acc.label = String(node.props?.children)
    return rowFacts(node.props?.children, acc)
  }
  const tagsByLabel = new Map(rows.map((row) => [rowFacts(row).label, rowFacts(row).tags]))
  assert.deepEqual(tagsByLabel.get('s-1'), [], '登记在册的会话不挂标签')
  // s-1 与 s-2 在同一个目录、同一组里：登记在册与没登记在册混在一组是常态（真实库里就是这样），
  // 标签得精确到行，不能按组一刀切。
  assert.deepEqual(tagsByLabel.get('s-2'), ['unregisteredSession'], '同目录里未登记在册的那条要单独标出来')
  assert.deepEqual(tagsByLabel.get('s-3'), ['unregisteredSession'], '没登记的工作区下的会话同样没在册')
  assert.deepEqual(tagsByLabel.get('s-4'), ['unregisteredSession'], '没有 cwd 的会话当然也不在任何登记表里')
})

// ---- 「会话」页（逐条归档 / 删除）----
//
// 这一页的存在理由就是"侧边栏里点不到的那些会话"（子代理 / 空白 / 已归档），所以它的验收点有两个：
// 三类隐藏理由都摆在行上，以及归档入口遇不到宿主能力时如实禁用（而不是留一个点了报错的按钮）。
//
// 断言走 `recorded`（假 createElement 记下的**全部**元素）而不是走树：分页组件的根是 Fragment，
// 树走法在 Fragment 处停住，看不见分页内部的元素（`strings()` 看得见，因为它另一个分支会下探）。

test('客户端产物：「会话」页把侧边栏看不见的那三类标出来，并给出归档与删除入口', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 2048, files: [], workspaceId: 'w1' },
      { id: 's-2', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 1024, files: [], hidden: 'subagent' },
      { id: 's-3', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 900, files: [], blank: true, hidden: 'blank' },
      { id: 's-4', cwd: '/home/u/dev/beta', createdAt: 2, dir: '/home/u/dev/beta', bytes: 512, files: [], archived: true, hidden: 'archived' },
      { id: 's-5', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 256, files: [], live: true },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  // 勾一条（假钩子给不出点击，只能把勾选集种进去）：否则"按钮是否禁用"永远撞在"一条都没勾"上
  const { registrations, recorded } = mount({ state, panel: 'manage', selection: ['s-1'] })
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  const text = strings(component(inject()))

  assert.ok(text.includes('tabManage'), '页签停在「会话」这一页')
  assert.ok(text.includes('manageTitle') && text.includes('manageHint'), '页面本体渲染出来了')
  // 三类隐藏理由各挂各的标签：**标签文字**是子节点，**为什么不显示**在悬浮提示里，两处都核
  const tagged = (key, tip) => {
    const node = recorded.find((element) => element.type === 'span' && strings(element).includes(key))
    assert.ok(node, `缺少「${key}」这枚标签`)
    assert.equal(node.props?.title, tip, `「${key}」要说清它为什么不显示`)
    assert.equal(node.props?.className, 'dsm-tag dsm-tagIdle', '标签走统一的那套中性样式')
  }
  tagged('tagSubagent', 'tagSubagentTip')
  tagged('tagBlank', 'tagBlankTip')
  tagged('tagArchived', 'tagArchivedTip')
  tagged('tagLive', 'tagLiveTip')
  // 归属那一格：在册的写工作区路径，没在册的写「未分组」（与外壳侧边栏同一套叫法）
  assert.ok(text.includes('ungroupedSource'), '未登记在册的会话在归属那一格写「未分组」')
  assert.ok(text.includes('/home/u/dev/alpha'), '在册的会话在归属那一格写工作区路径')
  // 归档与删除两组入口都在，且宿主给出归档能力时不显示那句"改不了"
  assert.ok(text.includes('manageArchive') && text.includes('manageUnarchive'), '归档 / 取消归档入口在')
  const actionButton = (key) =>
    recorded.find((element) => element.type === 'button' && strings(element).includes(key))
  assert.equal(actionButton('manageArchive')?.props?.['disabled'], false, '宿主有归档能力时按钮可用')
  assert.ok(text.includes('manageDeletePreview') && text.includes('manageDeleteHint'), '删除入口与说明在')
  assert.ok(!text.includes('manageArchiveUnavailable'), '宿主有归档能力时不该显示"改不了归档"那句')
})

test('客户端产物：「会话」页在宿主没有归档能力时禁用入口并说明原因', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: false,
    sessions: [{ id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 1, files: [] }],
    workspaces: [],
  }
  // 勾上一条：这样"归档按钮禁用"就只可能来自宿主没有那个能力，而不是"一条都没勾"
  const { registrations, recorded } = mount({ state, panel: 'manage', selection: ['s-1'] })
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  const text = strings(component(inject()))
  assert.ok(text.includes('manageArchiveUnavailable'), '要说清为什么归档按钮不可用')

  const button = (key) =>
    recorded.find((element) => element.type === 'button' && strings(element).includes(key))
  assert.equal(button('manageArchive')?.props?.['disabled'], true, '没有归档能力时归档按钮要真的禁用')
  assert.equal(button('manageUnarchive')?.props?.['disabled'], true, '取消归档同理')
  // 删除不依赖宿主的归档服务，所以入口照旧在（空选择下它也禁用，但那是另一条理由，界面上另有说明）
  assert.ok(button('manageDeletePreview'), '删除入口照旧在')
})
