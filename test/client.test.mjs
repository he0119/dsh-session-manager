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
 *
 * `nulls` 是那条规矩的延伸：要往**更后面**的某个 null 状态里种数据（比如迁移页的预演结果，
 * 见下面的用例），就按顺序把前几个 null 状态写成 null、要种的那个写成值。顺序同样是调用方与
 * 组件之间的约定，种错了表现为"期望的元素没渲染出来"（当场红），不会静默过。
 */
function fakeReact(recorded = [], firstNull = undefined, panel = undefined, arrays = [], strings = [], nulls = []) {
  let seededPanel = false
  const nullSeeds = firstNull === undefined ? [] : [firstNull]
  nullSeeds.push(...nulls)
  // 「种」进空数组状态的那些值按顺序发：分页组件里第一个 useState([]) 是勾选集，第二个是筛选条
  // （见 mount 的 arrays 参数）。顺序是调用方与组件之间的约定，所以种错了会当场断言失败，不会静默过。
  const arraySeeds = [...arrays]
  // 空串状态同样按顺序种（见 mount 的 strings 参数）：迁移页第一个空串是「源目录」，传输页第一个是
  // 导入目标、第二个才是搜索词，会话页第一个就是搜索词——各用例里写清自己种的是哪一个。
  const stringSeeds = [...strings]
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
      if (value === null && nullSeeds.length > 0) {
        return [nullSeeds.shift(), () => {}]
      }
      // 页内分页的状态：假钩子不会点页签，于是除默认那一页之外的 JSX 在冒烟里一次都跑不到。
      // 只替换**第一个** `useState('manage')`（骨架里那个，默认页就是它），其余字符串状态照旧。
      if (!seededPanel && value === 'manage' && panel !== undefined) {
        seededPanel = true
        return [panel, () => {}]
      }
      // 勾选集 / 筛选条：分页组件自己的 `useState([])`。不给勾选集种子，"按钮禁没禁用"就只能撞上
      // "一条都没勾所以禁用"这条分支，断言等于没测到宿主能力那件事（见下面那个用例的注释）。
      if (arraySeeds.length > 0 && Array.isArray(value) && value.length === 0) {
        return [arraySeeds.shift(), () => {}]
      }
      if (stringSeeds.length > 0 && value === '') {
        return [stringSeeds.shift(), () => {}]
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
 * 一行里显示出来的文案与标签。
 *
 * 与 strings() 同理：遇到函数组件要带着 props 调一次才看得见里面（行是共用组件渲染的，
 * 见 sessionList.tsx 的 SessionRow）。
 */
function rowParts(node, acc = { label: '', tags: [] }) {
  if (Array.isArray(node)) {
    for (const item of node) rowParts(item, acc)
    return acc
  }
  if (node === null || typeof node !== 'object') return acc
  if (typeof node.type === 'function') return rowParts(node.type(node.props), acc)
  const className = String(node.props?.className ?? '')
  if (className.includes('dsm-tag')) acc.tags.push(node.props?.children)
  if (className === 'dsm-rowTitle' || className === 'dsm-rowId') acc.label = String(node.props?.children)
  return rowParts(node.props?.children, acc)
}

/**
 * 把一棵子树摊平成元素列表（函数组件带着 props 调一次，同 rowParts）。
 *
 * 想在**某一块**里找东西时用它：`recorded` 是整个页面的元素，缩不到局部。
 */
function elementsOf(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) elementsOf(item, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') return elementsOf(node.type(node.props), out)
  out.push(node)
  return elementsOf(node.props?.children, out)
}

/**
 * 从元素树里收集所有字符串（文案就是字符串，键回显也是）。
 *
 * 遇到**函数组件**就带着 props 调一次再往下走：本文件没有真的渲染器，不这么做的话嵌套的
 * 页面（默认那一页「会话」）永远不在树上，冒烟只能看见骨架那一层，页面里的错就漏过去了。
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
function loadBundle({ firstNull, panel, arrays, strings, nulls } = {}) {
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
  const react = fakeReact(recorded, firstNull, panel, arrays, strings, nulls)
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
  // （0.2.0-rc.1 这一代里，62 个 `dsh-client-*` 包有 47 个直接 require 它，没有一个声明成 external）。
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
function mount({ translate, state, panel, arrays, strings, nulls, configForms } = {}) {
  const { mod, nodes, recorded } = loadBundle({ firstNull: state, panel, arrays, strings, nulls })
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
        // 设置接缝（`configForms`）按用例给：不给就等于宿主没提供它，同步设置表单要自己说明。
        ...(configForms === undefined ? {} : { configForms }),
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
    [['configForms'], ['uiWorkspace']],
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

  // 说明文字的分工：动作页只写"当下要做的决定"，词条与边界条件（分类含义、谁判的、删完侧边栏为什么
  // 还在、回滚与恢复的差别…）集中到「说明」页。这条分工靠自觉会漂回去——每加一个功能都想在按钮边上
  // 多解释一句，攒起来就是读者每次都要扫过去的散文（实测动作页正文曾经 187 / 382 / 144 字，最长一段
  // 192 字）。这里钉它的机械面：**动作页上的每一段说明都不超过两行**。
  // 两行的容量按实测的排版算：卡片正文宽约 480px、13px 字体，一行约 36 个汉字；英文按 ~6.5px/字符
  // 折半，所以两边各给一个上限。超过上限不是"字太多"，是"这段该搬去「说明」页"。
  const PAGE_PROSE = {
    zh: 76,
    en: 175,
  }
  const actionKeys = [
    'exportHint',
    'importHint',
    'migrateHint',
    'unownedSourceHint',
    'manageHint',
    'manageDeleteHint',
    'backupHint',
    'filterHint',
  ]
  for (const [language, cap] of Object.entries(PAGE_PROSE)) {
    const dictionary = language === 'zh' ? zh : en
    const over = actionKeys
      .filter((key) => String(dictionary[key]).length > cap)
      .map((key) => `${key}=${String(dictionary[key]).length}`)
    assert.deepEqual(over, [], `${language}：动作页上的说明每段最多两行（更长的就该进「说明」页）`)
  }

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

test('客户端产物：页面骨架带着四个动作页（会话 / 迁移 / 传输 / 同步）与说明页', { skip }, () => {
  const { registrations, recorded } = mount()
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  // 用注入面给的 t（键回显）渲染，于是文案就等于字典键，断言不依赖任何一种语言。
  const element = component(inject())
  const text = strings(element)
  assert.ok(text.includes('tabTransfer'), '页内要有「传输」这一页')
  assert.ok(text.includes('tabMigrate'), '页内要有「迁移」这一页')
  assert.ok(text.includes('tabManage'), '页内要有「会话」这一页（逐条归档 / 删除）')
  assert.ok(text.includes('tabSync'), '页内要有「同步」这一页（WebDAV）')
  // 页签顺序：日常的「会话」在最前；「同步」紧挨「传输」（它落地走的是导入那条编排）；说明垫底
  const tabs = recorded.filter((node) => String(node.props?.className) === 'dsm-tab')
  assert.deepEqual(
    tabs.map((node) => strings(node)[0]),
    ['tabManage', 'tabMigrate', 'tabTransfer', 'tabSync', 'tabHelp'],
    '顺序是 会话 → 迁移 → 传输 → 同步 → 说明（动作页按日常程度排，参考页垫底）',
  )
  assert.deepEqual(
    tabs.map((node) => node.props['aria-selected']),
    [true, false, false, false, false],
    '默认停在第一个页签',
  )
  assert.ok(text.includes('title'), '页面标题走同一份字典')
})

test('客户端产物：页头是页面级标题（h2 + 说明行），不是卡片式的小标题', { skip }, () => {
  // 真实事故（用户报的）：这一页标题曾是 14px 的 `span`，跟内建设置页（`h2` 18px + 13px 说明行）
  // 摆在一起就是两种规格。结构层面的差别得在产物里钉住，不然改样式时很容易又退回 span。
  const { registrations, recorded } = mount()
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
  const { registrations, recorded } = mount()
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
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 2048, files: [], ungrouped: false },
      { id: 's-2', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 1024, files: [], ungrouped: true },
      { id: 's-3', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 512, files: [], ungrouped: true },
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
  // 条数 = 库里"侧边栏会放进「未分组」、且有 cwd"的会话数（s-2 与 s-3），不是某个目录的条数
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
      // `ungrouped` 是宿主算好的结论（侧边栏会不会把它放进「未分组」）：s-1 在册 →
      // false；s-2 / s-3 / s-4 谁都没认领又看得见 → true。**没有 cwd 也算**（那是迁移来源自己的
      // 能力限制，不是「未分组」的定义）。
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 2048, files: [], ungrouped: false },
      { id: 's-2', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 1024, files: [], ungrouped: true },
      { id: 's-3', cwd: '/home/u/dev/beta', createdAt: 3, dir: '/home/u/dev/beta', bytes: 512, files: [], ungrouped: true },
      { id: 's-4', createdAt: 4, dir: '_no-cwd', bytes: 256, files: [], ungrouped: true },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const { registrations, recorded } = mount({ state, panel: 'transfer' })
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

  // 「未分组」这枚标签只该挂给**侧边栏那一组**里的会话（宿主算好的 `ungrouped`）。挂错或漏挂都不会
  // 抛错、不会崩，只会让"外壳侧边栏为什么把这些会话放进未分组"重新变成要靠人对着两个界面猜的谜——
  // 本机上真的被问过一次，所以按行核：先把每行的名字与标签取出来，再按名字对号入座。
  const tagsByLabel = new Map(rows.map((row) => [rowParts(row).label, rowParts(row).tags]))
  assert.deepEqual(tagsByLabel.get('s-1'), [], '登记在册的会话不挂标签')
  // s-1 与 s-2 在同一个目录、同一组里：在册与不在册混在一组是常态（真实库里就是这样），
  // 标签得精确到行，不能按组一刀切。
  assert.deepEqual(tagsByLabel.get('s-2'), ['ungroupedSource'], '同目录里在「未分组」那一组的那条要单独标出来')
  assert.deepEqual(tagsByLabel.get('s-3'), ['ungroupedSource'], '另一个目录里的同样标出来')
  assert.deepEqual(tagsByLabel.get('s-4'), ['ungroupedSource'], '没有 cwd 的也在那一组里（标签与迁移来源的 cwd 要求无关）')

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
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 2048, files: [], ungrouped: false },
      // 子代理会话在 /state 里带**三个**字段：origin 是 header 里的事实，hidden 是宿主先判的理由，
      // ungrouped 是"侧边栏会不会把它放进「未分组」"——子代理嵌在父会话下面，答案是否。
      { id: 's-2', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 1024, files: [], origin: 'subagent', hidden: 'subagent', ungrouped: false },
      { id: 's-3', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 900, files: [], blank: true, hidden: 'blank', ungrouped: false },
      { id: 's-4', cwd: '/home/u/dev/beta', createdAt: 2, dir: '/home/u/dev/beta', bytes: 512, files: [], archived: true, hidden: 'archived', ungrouped: false },
      // 谁都没认领、又看得见的那条：侧边栏的「未分组」里就是它
      { id: 's-5', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 256, files: [], live: true, ungrouped: true },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  // 勾一条（假钩子给不出点击，只能把勾选集种进去）：否则"按钮是否禁用"永远撞在"一条都没勾"上
  const { registrations, recorded } = mount({ state, panel: 'manage', arrays: [['s-1']] })
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
  // 归属进了组头：按目录分组（组头写工作区标题与路径），行上不再重复那一列
  const heads = recorded.filter((node) => String(node.props?.className) === 'dsm-groupHead')
  assert.equal(heads.length, 2, 'alpha 与 beta 各一组')
  assert.ok(strings(heads[0]).includes('工作区甲'), '登记过的那一组写工作区标题')
  assert.ok(
    heads.some((node) => strings(node).includes('/home/u/dev/alpha')),
    '组头把目录写在路径那一格',
  )
  const manageRows = recorded.filter(
    (node) => node.type === 'label' && String(node.props?.className).includes('dsm-rowManage'),
  )
  // 归属那一列没了：五个格子（勾选框 / 标记 / 标题 / 字节 / 时间）。
  // 数的是**元素**：JSX 里那个 `owner !== undefined && …` 为假时会留一个 false 在 children 里。
  const cells = (Array.isArray(manageRows[0].props.children) ? manageRows[0].props.children : []).filter(
    (child) => child !== null && typeof child === 'object',
  )
  assert.equal(cells.length, 5, '行里不再有归属那一列（勾选框 / 标记 / 标题 / 字节 / 时间）')
  // 子代理**不是**「未分组」：它确实没在册，但侧边栏把它嵌在父会话下面，从来不放进那一组。
  // 这条以前是反的（判据只看"有没有认领"），所以两行都钉住。
  assert.deepEqual(
    rowParts(manageRows.find((row) => strings(row).includes('s-2'))).tags,
    ['tagSubagent'],
    '子代理只挂「子代理」——它不在侧边栏的「未分组」那一组里',
  )
  assert.deepEqual(
    rowParts(manageRows.find((row) => strings(row).includes('s-5'))).tags,
    ['tagLive', 'ungroupedSource'],
    '真正落在侧边栏「未分组」里的那条才挂「未分组」',
  )
  // 归档与删除两组入口都在，且宿主给出归档能力时不显示那句"改不了"
  assert.ok(text.includes('manageArchive') && text.includes('manageUnarchive'), '归档 / 取消归档入口在')
  const actionButton = (key) =>
    recorded.find((element) => element.type === 'button' && strings(element).includes(key))
  assert.equal(actionButton('manageArchive')?.props?.['disabled'], false, '宿主有归档能力时按钮可用')
  assert.ok(text.includes('manageDeletePreview') && text.includes('manageDeleteHint'), '删除入口与说明在')
  assert.ok(!text.includes('manageArchiveUnavailable'), '宿主有归档能力时不该显示"改不了归档"那句')
})

test('客户端产物：子代理缩进到父会话的下一级（同一组 / 父在别的组 / 父被筛掉 / 分叉不缩进）', { skip }, () => {
  // 列表里的父子关系与删除 / 迁移的级联展开是同一条边（`parentSession` + `origin === "subagent"`）。
  // 缩进错了不会抛错、不会崩，只会让"删父会话会带上谁"与眼睛看到的对不上，所以按行核顺序与缩进类名。
  const sessions = [
    // alpha 组：父 → 子 → 孙，外加一条无关的（它排在子树之后：顶层按新→旧）
    { id: 'p1', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 100, files: [], archived: true },
    { id: 'c1', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 200, files: [], origin: 'subagent', hidden: 'subagent', parentSession: 'p1' },
    { id: 'c2', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 300, files: [], origin: 'subagent', hidden: 'subagent', parentSession: 'c1' },
    { id: 'lone', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 400, files: [] },
    // 分叉（`sessions.fork()`）：有父指针、没有 origin，是自洽的普通会话——不缩进、也不挂标签
    { id: 'f1', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 400, files: [], parentSession: 'p1' },
    // beta 组：这条子代理的父会话在 alpha（父被单独迁走过一次就会长成这样）
    { id: 'x1', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 500, files: [], origin: 'subagent', hidden: 'subagent', parentSession: 'p1' },
  ]
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions,
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: [] }],
  }
  const rowsOf = (recorded) =>
    recorded
      .filter((node) => node.type === 'label' && String(node.props?.className).includes('dsm-rowManage'))
      .map((row) => ({
        label: rowParts(row).label,
        tags: rowParts(row).tags,
        // 缩进由类名表达（样式在 styles.ts 里按级数给缩进与导引线）
        nest: (String(row.props.className).match(/dsm-rowNest(\d)/) ?? [])[1] ?? '0',
      }))

  /** 渲染一页：假钩子不自动跑，得自己带着注入面调一次（同本文件别处的写法）。 */
  const render = (mounted) => {
    const { component, registration } = mounted.registrations[0]
    const element = component(registration.inject())
    return { recorded: mounted.recorded, text: strings(element) }
  }

  // ① 不筛：父在前、子紧随其后，子挂一级、孙挂两级；父在别的组的那条留在自己组里挂一级并说明父在哪儿
  const first = render(mount({ state, panel: 'manage' }))
  const text = first.text
  assert.deepEqual(rowsOf(first.recorded), [
    { label: 'p1', tags: ['tagArchived'], nest: '0' },
    { label: 'c1', tags: ['tagSubagent'], nest: '1' },
    { label: 'c2', tags: ['tagSubagent'], nest: '2' },
    { label: 'lone', tags: [], nest: '0' },
    { label: 'f1', tags: [], nest: '0' },
    { label: 'x1', tags: ['tagSubagent', 'tagParentElsewhere'], nest: '1' },
  ])
  // 缩进只改画法：组头报的条数还是这一组有几条会话（子代理照样算）
  assert.ok(text.some((item) => String(item).includes('sessionsInDir:{"count":5}')), 'alpha 组 5 条（分叉也算一条）')
  assert.ok(text.some((item) => String(item).includes('sessionsInDir:{"count":1}')), 'beta 组 1 条')

  // ② 只筛「子代理」：父会话被筛走，子代理按普通行画（不凭空多一级）；孙的父还在，于是只它缩进
  const second = render(mount({ state, panel: 'manage', arrays: [[], ['subagent']] }))
  assert.deepEqual(rowsOf(second.recorded), [
    { label: 'c1', tags: ['tagSubagent'], nest: '0' },
    { label: 'c2', tags: ['tagSubagent'], nest: '1' },
    { label: 'x1', tags: ['tagSubagent'], nest: '0' },
  ])
})

test('客户端产物：子代理行的勾选框禁用（跟着父会话走），全选也只勾能单独勾的那些', { skip }, () => {
  // 能勾的集合必须与"单独操作不会被拒的集合"一致（宿主那几条路的判据见 family.ts 的 loneSubagents）：
  // 否则用户只能靠"点下去被拒"发现自己点错了。分叉与孤儿都能单独勾——分叉不是子代理，孤儿没有可跟随的会话。
  const sessions = [
    { id: 'p1', title: '父会话', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 100, files: [] },
    { id: 'c1', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 200, files: [], origin: 'subagent', hidden: 'subagent', parentSession: 'p1' },
    { id: 'f1', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 300, files: [], parentSession: 'p1' },
    { id: 'o1', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 400, files: [], origin: 'subagent', hidden: 'subagent', parentSession: 'gone' },
  ]
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions,
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: [] }],
  }
  const render = (mounted) => {
    const { component, registration } = mounted.registrations[0]
    return { recorded: mounted.recorded, text: strings(component(registration.inject())) }
  }

  const first = render(mount({ state, panel: 'manage' }))
  const rows = first.recorded.filter(
    (node) => node.type === 'label' && String(node.props?.className).includes('dsm-rowManage'),
  )
  const inputOf = (label) => {
    const row = rows.find((node) => rowParts(node).label === label)
    assert.ok(row !== undefined, `${label} 这一行要在`)
    return elementsOf(row).find((element) => element.type === 'input')?.props ?? {}
  }
  assert.equal(inputOf('c1').disabled, true, '子代理不能单独勾')
  assert.equal(inputOf('c1').title, 'lockedSubagentTip:{"name":"父会话"}', '提示里写明该勾哪一条')
  assert.notEqual(inputOf('父会话').disabled, true, '父会话能勾（它就是那个"上面那条"）')
  assert.notEqual(inputOf('f1').disabled, true, '分叉不是子代理，照旧能单独勾')
  assert.notEqual(inputOf('o1').disabled, true, '孤儿没有可跟随的会话，照旧能单独勾')

  // 筛到只剩"不能单独勾"的那些：一个能勾的都没有，「全选」要真的禁用（把孤儿摘掉，它能单独勾）
  const lockedOnly = { ...state, sessions: sessions.filter((session) => session.id !== 'o1') }
  const second = render(mount({ state: lockedOnly, panel: 'manage', arrays: [[], ['subagent']] }))
  const selectAll = second.recorded.find(
    (element) => element.type === 'button' && strings(element).includes('selectAllSessions'),
  )
  assert.equal(selectAll?.props?.['disabled'], true, '列出来的全是不能单独勾的子代理时，「全选」禁用')
})

test('客户端产物：导出页也把子代理缩进到父会话的下一级（两个分页各接一遍线）', { skip }, () => {
  // 缩进这套接了两遍线（「会话」页在 ManagePanel、传输页在 TransferPanel），所以两处各钉一次。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [
      { id: 'p1', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 100, files: [] },
      { id: 'c1', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 200, files: [], origin: 'subagent', hidden: 'subagent', parentSession: 'p1' },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: [] }],
  }
  const { registrations, recorded } = mount({ state, panel: 'transfer' })
  const { component, registration } = registrations[0]
  // 行在子组件里：得让 `strings()` 把树走一遍，它们才会被记进 `recorded`（同上面「会话」页那个用例）。
  strings(component(registration.inject()))
  const rows = recorded.filter(
    (node) => node.type === 'label' && String(node.props?.className).includes('dsm-rowExport'),
  )
  const nestOf = (row) => (String(row.props.className).match(/dsm-rowNest(\d)/) ?? [])[1] ?? '0'
  assert.deepEqual(rows.map((row) => [rowParts(row).label, nestOf(row)]), [
    ['p1', '0'],
    ['c1', '1'],
  ])
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
  const { registrations, recorded } = mount({ state, panel: 'manage', arrays: [['s-1']] })
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

test('客户端产物：「会话」页的筛选条把不匹配的行筛掉，选中态挂在 aria-pressed 上', { skip }, () => {
  // 假钩子点不出 setState（见上面那个用例的注释），所以筛选条也靠"种"：第一个空数组是勾选集、
  // 第二个是筛选条（ManagePanel 里两个 useState([]) 的顺序），这里把它种成「空白」。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [
      { id: 's-owned', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 100, files: [], ungrouped: false },
      { id: 's-sub', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 200, files: [], origin: 'subagent', ungrouped: false },
      { id: 's-blank', cwd: '/home/u/dev/beta', createdAt: 3, dir: '/home/u/dev/beta', bytes: 300, files: [], blank: true, ungrouped: false },
      { id: 's-both', cwd: '/home/u/dev/beta', createdAt: 2, dir: '/home/u/dev/beta', bytes: 400, files: [], blank: true, archived: true, ungrouped: false },
      { id: 's-live', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 500, files: [], live: true, ungrouped: true },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-owned'] }],
  }
  const { registrations, recorded } = mount({ state, panel: 'manage', arrays: [[], ['blank']] })
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  const element = component(inject())
  const text = strings(element)

  // 筛选条：一枚「全部」+ 五类，各自带上库里的条数（对整个库数，不随当前筛选跳）
  const chips = recorded.filter((node) => String(node.props?.className) === 'dsm-filter')
  assert.equal(chips.length, 6, '「全部」+ 五类')
  const chip = (label) => chips.find((node) => strings(node).includes(label))
  assert.deepEqual(chips.map((node) => strings(node).join('')), [
    'filterAll',
    'tagSubagent',
    'tagBlank',
    'tagArchived',
    'ungroupedSource',
    'tagLive',
  ])
  // 每类各有多少条（对整个库数）：数字是 React 直接渲染的数字节点，strings() 只收字符串，所以单看这里
  const counts = recorded
    .filter((node) => String(node.props?.className) === 'dsm-filterCount')
    .map((node) => String(node.props.children))
  // 「未分组」只有 1 条（s-live）：s-sub（子代理）与两条空白都不在侧边栏那一组里——这正是这次的改动
  assert.deepEqual(counts, ['1', '2', '1', '1', '1'], '子代理 1 / 空白 2 / 已归档 1 / 未分组 1 / 活动中 1')
  assert.equal(chip('filterAll')?.props?.['aria-pressed'], false, '筛着的时候「全部」不是选中态')
  assert.equal(chip('tagBlank')?.props?.['aria-pressed'], true, '种进去的那一类要显示成选中')
  assert.equal(chip('tagSubagent')?.props?.['aria-pressed'], false, '没勾的那几类不是选中态')
  // 每一类的说明走悬浮提示（与行上的标签同一份文案）
  assert.equal(chip('tagBlank')?.props?.title, 'tagBlankTip')
  assert.equal(chip('ungroupedSource')?.props?.title, 'ungroupedTip')

  // 列表：只剩空白那两条（筛选＝任一命中），其余三类不在树上
  const rows = recorded.filter(
    (node) => node.type === 'label' && String(node.props?.className).includes('dsm-rowManage'),
  )
  const listed = rows.map((row) => strings(row)[0])
  assert.deepEqual(listed, ['s-blank', 's-both'])
  assert.ok(!text.includes('s-owned') && !text.includes('s-sub') && !text.includes('s-live'), '不匹配的行不在树上')
  // "空白 + 已归档"那条要挂两枚标签：只挂宿主先判的那一枚，筛选就没法自证了。
  // 它**不**挂「未分组」：侧边栏默认视图里压根不显示它，更不会把它放进「未分组」那一组。
  const both = rows.find((row) => strings(row).includes('s-both'))
  assert.deepEqual(rowParts(both).tags, ['tagBlank', 'tagArchived'], '既是空白又已归档的那条挂两枚，且都不是「未分组」')
  // 筛过之后头部报"显示了其中几条"，别让人以为库里的会话变少了
  assert.ok(text.includes('shownCount:{"shown":2,"total":5}'), '筛过之后报出 显示 N / M 条')

  // 说明句「多选＝任一命中」必须**自己一行**（筛选条后面那个 <p>），不能挤在胶囊那一行里。
  // 挤回去不会报错、不会崩，只会让它重新跟着容器右边缘跑：外层滚动条一进一出就让这条边的位置变
  // （实测旧写法 9px；装了经典滚动条的环境是 15px），胶囊行余量也只剩三十来px、窄一点就整行换行。
  // 位置这种东西没法在这里量，所以按结构核：它在不在 .dsm-filters 里面。
  const filterRow = recorded.find((node) => String(node.props?.className) === 'dsm-filters')
  assert.equal(strings(filterRow).includes('filterHint'), false, '说明句不在胶囊那一行里')
  const searchRow = recorded.find((node) => String(node.props?.className) === 'dsm-filterSearch')
  assert.ok(strings(searchRow).includes('filterHint'), '说明句与胶囊不在同一行（都在固定的左边界上）')
  // 搜索框本身：值的来源是筛选状态，占位符与无障碍名字走字典（它们是 props，strings() 看不见）
  const search = recorded.find((node) => String(node.props?.className) === 'dsm-search')
  assert.equal(search?.props?.type, 'search', '搜索框是原生 input[type=search]（自带清空按钮）')
  assert.equal(search?.props?.placeholder, 'searchPlaceholder', '占位符说明它搜什么')
  assert.equal(search?.props?.['aria-label'], 'searchPlaceholder', '搜索框要有无障碍名字')
  assert.ok(
    (Array.isArray(searchRow.props.children) ? searchRow.props.children : [searchRow.props.children]).includes(search),
    '搜索框在搜索那一行里',
  )
})

test('客户端产物：「会话」页一条都没筛出来时，那个固定的列表框还在（高度不跟着筛选变）', { skip }, () => {
  // 列表高度是固定的（styles.ts 的 .dsm-list）：筛空时如果把框换成一句 <p>，这一页的高度就跟着筛选
  // 变，设置弹窗外层那条滚动条又会一进一出，占位滚动条的环境里卡片右边缘就跟着挪 15px。所以空态必须
  // 画在框**里面**。这里种一个库里没有的类别（夹具里没有"活动中"的会话）来走到那个分支。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [
      { id: 's-owned', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 100, files: [], ungrouped: false },
      { id: 's-blank', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 200, files: [], blank: true },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-owned'] }],
  }
  const { registrations, recorded } = mount({ state, panel: 'manage', arrays: [[], ['live']] })
  const { component, registration } = registrations[0]
  const text = strings(component(registration.inject()))

  const lists = recorded.filter((node) => String(node.props?.className ?? '').split(/\s+/).includes('dsm-list'))
  assert.equal(lists.length, 1, '列表框还在（高度固定的那个框）')
  const empties = recorded.filter((node) => String(node.props?.className) === 'dsm-empty')
  assert.equal(empties.length, 1, '空态的说明只有一条')
  assert.ok(strings(empties[0]).includes('noMatch'), '空态说的是"没有符合筛选条件的会话"')
  // 空态必须是框的子节点，不能是它的兄弟（换成兄弟就等于把框撤了）
  assert.ok(
    String(lists[0].props.className).includes('dsm-listFixed'),
    '「会话」页那个框还得是固定高度的那一款（其余两页的列表照旧按内容长）',
  )
  // 空态是共用组件（sessionList.tsx 的 SessionListEmpty），所以要看的是**它渲染出来**的 .dsm-empty
   // 是不是落在这个框里面——函数组件得带着 props 调一次才看得见（同本文件其它遍历）。
  const walk = (node, out = []) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, out)
      return out
    }
    if (node === null || typeof node !== 'object') return out
    if (typeof node.type === 'function') return walk(node.type(node.props), out)
    out.push(node)
    return walk(node.props?.children, out)
  }
  const inside = walk(lists[0].props.children)
  assert.ok(
    inside.some((node) => String(node.props?.className) === 'dsm-empty'),
    '空态画在列表框里面',
  )
  assert.ok(!text.includes('s-owned') && !text.includes('s-blank'), '没有匹配的行被列出来')
  assert.ok(text.includes('shownCount:{"shown":0,"total":2}'), '头部照样报 显示 0 / 2 条')
})

test('客户端产物：导出页也接了同一套筛选条，筛空的组整组不画、组头条数跟着筛', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [
      { id: 'a-1', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 100, files: [], ungrouped: false },
      { id: 'a-2', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 200, files: [], blank: true, ungrouped: false },
      { id: 'b-1', cwd: '/home/u/dev/beta', createdAt: 2, dir: '/home/u/dev/beta', bytes: 300, files: [], ungrouped: true },
      { id: 'b-2', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 400, files: [], origin: 'subagent', ungrouped: false },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['a-1'] }],
  }
  // 勾选集是第一个空数组，筛选条是第二个（TransferPanel 里 useSessionFilter 挨着 sessions 定义）
  const { registrations, recorded } = mount({ state, panel: 'transfer', arrays: [[], ['blank']] })
  const { component, registration } = registrations[0]
  const text = strings(component(registration.inject()))

  // 这一页列的是**整个库**（隐藏会话也在），所以五类芯片都有意义，计数对整个库数
  const chips = recorded.filter((node) => String(node.props?.className) === 'dsm-filter')
  assert.deepEqual(chips.map((node) => strings(node).join('')), [
    'filterAll',
    'tagSubagent',
    'tagBlank',
    'tagArchived',
    'ungroupedSource',
    'tagLive',
  ])
  assert.equal(
    recorded
      .filter((node) => String(node.props?.className) === 'dsm-filterCount')
      .map((node) => String(node.props.children))
      .join(','),
    '1,1,0,1,0',
    '子代理 1 / 空白 1 / 已归档 0 / 未分组 1（b-1）/ 活动中 0',
  )
  assert.ok(text.includes('shownCount:{"shown":1,"total":4}'), '筛过之后报 显示 1 / 4 条')

  // 筛空的那一组整组不画（组头底下没有行，看着像坏了），留下那组报的是筛剩下的条数
  const heads = recorded.filter((node) => String(node.props?.className) === 'dsm-groupHead')
  assert.equal(heads.length, 1, '筛空的组不画组头')
  assert.ok(strings(heads[0]).includes('工作区甲'), '留下的是 alpha 那组')
  assert.ok(text.includes('sessionsInDir:{"count":1}'), '组头报的是筛剩下的条数')

  // 行出自共用组件（sessionList.tsx 的 SessionRow），标签也走共用判据
  const rowEls = recorded.filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow')
  assert.equal(rowEls.length, 1, '筛过之后只有一行')
  assert.equal(rowEls[0].props.variant, 'export')
  const labels = recorded.filter(
    (node) => node.type === 'label' && String(node.props?.className).includes('dsm-rowExport'),
  )
  assert.equal(labels.length, 1)
  // a-2 是空白：它不挂「未分组」（侧边栏默认视图里根本没显示它）
  assert.deepEqual(rowParts(labels[0]).tags, ['tagBlank'], '这一页也挂属性标签，且「未分组」只给侧边栏那一组')
})

test('客户端产物：迁移页把"跟着父会话进来的子代理"单独说明（预演卡片）', { skip }, () => {
  // 预演卡片是点了「预演」之后才渲染的，冒烟里走不到（假钩子给不出点击），所以把 `outcome` 种进去。
  // null 状态的顺序是：页面骨架的 state（由 mount 的 `state` 种）/ error，然后迁移页的
  // picking / manual / **outcome** —— 所以 `nulls` 里先补三个 null，第四个才是预演结果。
  // 种错位置表现为"预演卡片没渲染出来"，当场红。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    pickerKind: 'browse',
    sessions: [
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 2048, files: [], ungrouped: false },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const previewOf = (cascaded) => ({
    ok: true,
    problems: [],
    from: '/home/u/dev/alpha',
    to: '/home/u/dev/beta',
    sourceProjectDir: 'alpha',
    targetProjectDir: 'beta',
    unowned: false,
    sourceProjectDirs: ['/home/u/.dsh/sessions/alpha'],
    sessions: [
      // 点名的父会话 + 跟着走的子代理：`via` 指回点名的那个祖先
      { id: 's-1', createdAt: 3, registered: true, alreadyAtTarget: false, sourceDir: '/a/s-1', targetDir: '/b/s-1', files: 1, bytes: 100 },
      { id: 's-9', createdAt: 2, registered: false, alreadyAtTarget: false, sourceDir: '/a/s-9', targetDir: '/b/s-9', files: 1, bytes: 100, via: { id: 's-1' } },
    ].slice(0, cascaded === 0 ? 1 : 2),
    cascaded,
    files: 2,
    bytes: 200,
    artifacts: null,
    registryChange: null,
    summary: 'plan summary',
  })
  const outcomeOf = (cascaded) => ({
    mode: 'plan',
    ok: true,
    preview: previewOf(cascaded),
    applied: false,
    rewritten: 0,
    moved: 0,
    artifactsMoved: 0,
    verified: false,
    problems: [],
    summary: 'plan summary',
    takesEffect: 'restart-required',
  })

  const withFamily = mount({
    state,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
    nulls: [null, null, null, outcomeOf(1)],
  })
  const familyText = strings(withFamily.registrations[0].component(withFamily.registrations[0].registration.inject()))
  assert.ok(familyText.includes('migrateTitle'), '迁移页本体渲染出来了')
  assert.ok(
    familyText.some((item) => String(item) === 'migrateFamily:{"count":1}'),
    '有一条子代理跟着走时，预演卡片要说明它是跟着父会话进来的',
  )

  // 没有子代理跟随时这句话不该出现（否则每次迁移都多一行噪音）
  const plain = mount({
    state,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
    nulls: [null, null, null, outcomeOf(0)],
  })
  const plainText = strings(plain.registrations[0].component(plain.registrations[0].registration.inject()))
  assert.ok(plainText.some((item) => String(item).startsWith('migrateSummary')), '预演卡片照旧渲染')
  assert.equal(plainText.some((item) => String(item).startsWith('migrateFamily')), false)
})

test('客户端产物：迁移页只给搜索框、不给类别芯片（那页的列表本来就是候选）', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [
      { id: 'a-1', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 100, files: [] },
      { id: 'a-2', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 200, files: [], origin: 'subagent', hidden: 'subagent' },
      { id: 'b-1', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 300, files: [] },
    ],
    workspaces: [],
  }
  // 迁移页第一个空串状态是「源目录」（MigrationPanel 的 useState('') 顺序：from → to → title → 搜索词）
  const { registrations, recorded } = mount({ state, panel: 'migrate', strings: ['/home/u/dev/alpha'] })
  const { component, registration } = registrations[0]
  strings(component(registration.inject()))

  assert.equal(recorded.filter((node) => String(node.props?.className) === 'dsm-filter').length, 0, '不给类别芯片')
  assert.ok(
    recorded.some((node) => String(node.props?.className) === 'dsm-search'),
    '给搜索框',
  )
  // 候选只剩"侧边栏看得见的那条"：隐藏会话按设计不进候选，所以五类芯片在这页永远是 0
  const rowEls = recorded.filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow')
  assert.deepEqual(rowEls.map((node) => node.props.session.id), ['a-1'])
  assert.equal(rowEls[0].props.variant, 'pick')
  assert.equal(rowEls[0].props.ungroupedTag, true, '目录来源下，没在册的那条要挂「未分组」')
})

test('客户端产物：「会话」页的搜索框按标题或 id 筛，筛空时空态还是画在同一个框里', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [
      { id: 's-1', title: '重构迁移编排', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 100, files: [], ungrouped: false },
      { id: 's-2', title: '别的东西', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 200, files: [], ungrouped: false },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1', 's-2'] }],
  }
  // 会话页第一个空串状态就是搜索词（勾选集是第一个空数组，useSessionFilter 紧跟着它）
  const hit = mount({ state, panel: 'manage', strings: ['迁移'] })
  const hitText = strings(hit.registrations[0].component(hit.registrations[0].registration.inject()))
  assert.ok(hitText.includes('shownCount:{"shown":1,"total":2}'), '按标题搜到了那一条')
  assert.deepEqual(
    hit.recorded
      .filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow')
      .map((node) => node.props.session.id),
    ['s-1'],
  )

  // 搜不到时：空态照样画在那个高度固定的框里，头部报 显示 0 / 2（框还在，整页高度就不变）
  const miss = mount({ state, panel: 'manage', strings: ['zzz-没有这条'] })
  const missText = strings(miss.registrations[0].component(miss.registrations[0].registration.inject()))
  assert.ok(missText.includes('shownCount:{"shown":0,"total":2}'), '搜不到也照样报条数')
  const lists = miss.recorded.filter((node) =>
    String(node.props?.className ?? '').split(/\s+/).includes('dsm-list'),
  )
  assert.equal(lists.length, 1, '列表框还在')
  assert.ok(
    miss.recorded.some(
      (node) => String(node.props?.className) === 'dsm-empty' && strings(node).includes('noMatch'),
    ),
    '空态画在框里',
  )
})

test('客户端产物：组头的折叠只影响画不画行，不影响"列出来了哪些"', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [
      { id: 'a-1', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 100, files: [], blank: true },
      { id: 'a-2', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 200, files: [] },
      { id: 'b-1', cwd: '/home/u/dev/beta', createdAt: 2, dir: '/home/u/dev/beta', bytes: 300, files: [], blank: true },
    ],
    workspaces: [],
  }
  // 传输页里三个空数组状态按顺序是：勾选集、筛选条、折叠状态（各自的 useState 顺序）
  const alpha = '/home/u/dev/alpha'
  const beta = '/home/u/dev/beta'
  const key = (path) => (path === '' ? '\u0000no-cwd' : path)

  // 筛「空白」之后列出来的是 a-1 与 b-1（两个组），收起 alpha 那一组
  const one = mount({ state, panel: 'transfer', arrays: [[], ['blank'], [key(alpha)]] })
  const oneText = strings(one.registrations[0].component(one.registrations[0].registration.inject()))
  const oneRows = one.recorded.filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow')
  assert.deepEqual(oneRows.map((node) => node.props.session.id), ['b-1'], '收起的那一组不画行')
  const heads = one.recorded.filter((node) => String(node.props?.className) === 'dsm-groupHead')
  assert.equal(heads.length, 2, '组头一个都不少（收起来的是行，不是整个组）')
  assert.ok(oneText.includes('sessionsInDir:{"count":1}'), '收起的组头照样报"这组几条"')
  assert.ok(
    oneText.includes('shownCount:{"shown":2,"total":3}'),
    '头部照样按列出来的算（2 条），折叠不改"算不算"',
  )

  // 折叠开关：右端那个按钮，状态写在 aria-expanded 上（读屏与视觉同一个来源）
  const toggles = one.recorded.filter((node) => String(node.props?.className) === 'dsm-groupToggle')
  assert.equal(toggles.length, 2, '每组一个折叠开关')
  assert.equal(
    heads[0].props.children[0].props?.className,
    'dsm-groupToggle',
    '折叠开关在组头最前（树的惯例：左缘就是"这一组能不能折"的位置）',
  )
  assert.deepEqual(
    toggles.map((node) => node.props['aria-expanded']),
    [false, true],
    '收起的那组 false，另一组 true',
  )
  assert.ok(
    toggles.every((node) => node.props.type === 'button' && String(node.props['aria-label']).includes('toggleGroupLabel')),
    '是可聚焦的按钮，且带无障碍名字',
  )
  // 按钮不能塞进"点一下整组勾选"那个 label 里：labelable 元素只能是被标注的那一个
  const picks = one.recorded.filter((node) => String(node.props?.className) === 'dsm-groupPick')
  assert.equal(picks.length, 2, '整组勾选那一块仍是 label')
  const walk = (node, out = []) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, out)
      return out
    }
    if (node === null || typeof node !== 'object') return out
    if (typeof node.type === 'function') return walk(node.type(node.props), out)
    out.push(node)
    return walk(node.props?.children, out)
  }
  assert.equal(
    walk(picks[0]).filter((node) => node.type === 'button').length,
    0,
    '折叠按钮不在整组勾选的 label 里面（非法嵌套，点击行为也会打架）',
  )

  // 工具栏：全部收起 / 全部展开的可用状态跟着眼下的收起情况走。
  // 只看工具栏那一块里的按钮——卡片头部也有两个 .dsm-button，不能一起数进来。
  const disabled = (recorded) => {
    const bar = recorded.find((node) => String(node.props?.className) === 'dsm-groupTools')
    assert.ok(bar, '有组就该有折叠工具栏')
    return walk(bar)
      .filter((node) => node.type === 'button')
      .map((node) => node.props.disabled)
  }
  assert.deepEqual(disabled(one.recorded), [false, false], '收了一组、另一组还开着：两个按钮都能用')

  // 一组都没收：全部展开没什么可做
  const none = mount({ state, panel: 'transfer', arrays: [[], ['blank'], []] })
  // 一定要走一遍 strings()：只调 component() 只渲染骨架那 12 个元素，页面里的东西一个都不会建出来
  strings(none.registrations[0].component(none.registrations[0].registration.inject()))
  assert.deepEqual(disabled(none.recorded), [false, true], '都没收：全部收起能用、全部展开置灰')
  assert.equal(
    none.recorded.filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow').length,
    2,
    '没收起时两组都画出来',
  )

  // 两组都收着：全部收起没什么可做，行一条都不画，但"列出来了哪些"仍是 2 条
  const all = mount({ state, panel: 'transfer', arrays: [[], ['blank'], [key(alpha), key(beta)]] })
  const allText = strings(all.registrations[0].component(all.registrations[0].registration.inject()))
  assert.deepEqual(disabled(all.recorded), [true, false], '都收着：全部收起置灰、全部展开能用')
  assert.equal(
    all.recorded.filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow').length,
    0,
  )
  assert.ok(allText.includes('shownCount:{"shown":2,"total":3}'), '全收着也照样报"显示 2 / 3 条"')
  assert.ok(allText.includes('sessionsInDir:{"count":1}'), '组头的条数不因为收起而变')
})

test('客户端产物：一个组都没有时不摆折叠工具栏', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [
      { id: 'a-1', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 100, files: [] },
    ],
    workspaces: [],
  }
  // 筛「子代理」（一条都没有）→ 组一个都不剩，收无可收
  const { registrations, recorded } = mount({ state, panel: 'transfer', arrays: [[], ['subagent'], []] })
  strings(registrations[0].component(registrations[0].registration.inject()))
  assert.equal(recorded.filter((node) => String(node.props?.className) === 'dsm-groupTools').length, 0)
  assert.ok(
    recorded.some((node) => String(node.props?.className) === 'dsm-empty' && strings(node).includes('noMatch')),
    '筛空时框里是那句空态',
  )
})

test('客户端产物：「会话」页也按目录分组、也能折叠，勾选口径与传输页一致', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [
      { id: 'a-1', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 100, files: [], ungrouped: false },
      { id: 'a-2', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 200, files: [], blank: true },
      { id: 'b-1', cwd: '/home/u/dev/beta', createdAt: 2, dir: '/home/u/dev/beta', bytes: 300, files: [], blank: true },
      { id: 'b-2', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 400, files: [], archived: true },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['a-1'] }],
  }
  // 会话页的空数组状态按顺序是：勾选集、筛选条（useSessionFilter）、失败的删除记录、折叠状态
  // （useGroupCollapse 在 groups 之后）。种子按这个顺序发，错一位就会当场断言失败，不会静默过。
  const alpha = '/home/u/dev/alpha'
  // 筛「空白」→ 列出来的是 a-2 与 b-1（两组），把 alpha 那组收起来
  const { registrations, recorded } = mount({ state, panel: 'manage', arrays: [[], ['blank'], [], [alpha]] })
  const text = strings(registrations[0].component(registrations[0].registration.inject()))

  const rowIds = recorded
    .filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow')
    .map((node) => node.props.session.id)
  assert.deepEqual(rowIds, ['b-1'], '收起的那一组不画行，另一组照画')
  const heads = recorded.filter((node) => String(node.props?.className) === 'dsm-groupHead')
  assert.equal(heads.length, 2, '组头一个都不少')
  assert.ok(text.includes('sessionsInDir:{"count":1}'), '收起的组头照样报"这组几条"')
  assert.ok(text.includes('shownCount:{"shown":2,"total":4}'), '折叠不改"列出来了哪些"（仍是 2 条）')
  assert.ok(text.includes('工作区甲'), '组头写工作区标题')
  // 组头那一下就是整组勾选（勾选集是空的，于是两个组头的选框都没勾上）
  const boxes = heads.map((node) => elementsOf(node).find((child) => child.type === 'input'))
  assert.deepEqual(boxes.map((node) => node.props.checked), [false, false], '整组勾选的选框在组头上')

  // 折叠工具栏也在，且与传输页同一个组件
  const bar = recorded.find((node) => String(node.props?.className) === 'dsm-groupTools')
  assert.ok(bar, '会话页也给「全部收起 / 全部展开」')
  assert.deepEqual(
    elementsOf(bar)
      .filter((node) => node.type === 'button')
      .map((node) => node.props.disabled),
    [false, false],
    '收了一组：两个按钮都能用',
  )
})

// ---- 「说明」页（词条与边界条件）----
//
// 这一页的存在理由是"把动作页上的散文搬走"，所以它的验收点有两个：词条**复用了行上那几枚标签的文案**
// （同一件事在两处各写一份就会漂），以及边界条件确实讲全了（分类、三个分页、碰什么盘、数据从哪来、
// 常见疑问）。动作页那边由上面那条"每段最多两行"的预算盯着。

test('客户端产物：「说明」页把分类词条、四个分页与边界条件摆出来', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [],
    workspaces: [],
  }
  const { registrations, recorded } = mount({ state, panel: 'help' })
  const text = strings(registrations[0].component(registrations[0].registration.inject()))

  for (const key of ['helpCategoriesTitle', 'helpTabsTitle', 'helpDiskTitle', 'helpWhereTitle', 'helpFaqTitle']) {
    assert.ok(text.includes(key), `缺少小节「${key}」`)
  }
  // 词条与解释成对，且词条就是行上那几枚标签的键
  const terms = recorded.filter((node) => node.type === 'dt').flatMap((node) => strings(node))
  for (const key of ['catVisible', 'tagSubagent', 'tagBlank', 'tagArchived', 'tagLive', 'ungroupedSource']) {
    assert.ok(terms.includes(key), `分类词典缺少「${key}」`)
  }
  assert.equal(terms.length, 17, '词条数＝分类 6 + 分页 4 + 数据 2 + 疑问 5')
  assert.equal(recorded.filter((node) => node.type === 'dd').length, 17, '每条词条都有解释')
  assert.ok(terms.includes('tabSync'), '分页那一节要写到「同步」这一页')
  // 「数据从哪来」两条路径来自 /state，不是写死在文案里
  assert.ok(
    text.includes('/home/u/.dsh/sessions') && text.includes('/home/u/.dsh/registry.json'),
    '两条路径来自 /state',
  )
  for (const key of ['faqUnownedQ', 'faqDeletedQ', 'faqRestartQ', 'faqRestoreQ', 'faqForkQ']) {
    assert.ok(text.includes(key), `常见疑问缺少「${key}」`)
  }
  // 同步那条边界也在这一页上（动作页只留用得到的句子）：同步只往库里加、不覆盖
  assert.ok(text.includes('helpDiskSync'), '会碰什么盘那节要写上同步')
  // 说明页不该长成一个"什么都往里塞"的垃圾桶：正文段落本身就是词条/项目符号，没有额外的大段散文
  assert.ok(text.includes('helpHint'), '页首要有一句话说明这一页讲什么')
})

test('客户端产物：同步页的同步块——没配置只说明，配置了才摆按钮', { skip }, () => {
  const base = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [],
    workspaces: [],
  }
  const text = (mounted) => strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  const buttonTexts = (mounted) =>
    mounted.recorded
      .filter((node) => node.type === 'button')
      .map((node) => strings(node).join(''))

  // 没配置：一句话说明怎么配，一个按钮都不摆（点了没反应的按钮比不摆更糟）
  const off = mount({ state: base, panel: 'sync' })
  assert.ok(text(off).includes('syncOffHint'), '没配置时要说明怎么配')
  assert.ok(!buttonTexts(off).includes('syncPreview'), '没配置时不该出现同步按钮')
  assert.ok(!buttonTexts(off).includes('syncApply'), '没配置时不该出现同步按钮')

  // 配置了：远端与这台机器报出来，预演与确认两个按钮都在
  const on = mount({
    state: { ...base, sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 2 } },
    panel: 'sync',
  })
  const onText = text(on)
  assert.ok(onText.includes('syncWhere:{"url":"https://dav.example.com/dsh","machine":"robot-a"}'), '要报出远端与机器名')
  assert.ok(onText.includes('syncHint:{"mappings":2}'), '要报出映射条数')
  assert.deepEqual(buttonTexts(on).filter((label) => label.startsWith('sync')), ['syncPreview', 'syncApply'])
})

test('客户端产物：同步设置表单按 entry id 向设置接缝取控制器，宿主没提供时说实话', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 1 },
    sessions: [],
    workspaces: [],
  }
  const asked = []
  const controller = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      revision: 7,
      value: {
        sync: {
          url: 'https://dav.example.com/dsh',
          machineId: 'robot-a',
          timeoutMs: 30000,
          mapping: { '/home/alice/dev/proj': '/opt/work/proj' },
        },
      },
    }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const mounted = mount({
    state,
    panel: 'sync',
    configForms: {
      get(namespace) {
        asked.push(namespace)
        return controller
      },
    },
  })
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  assert.deepEqual(asked, ['session-manager'], '按 profile 里那个 insert 的 id 取控制器')
  assert.ok(text.includes('syncFieldMapping'), '映射字段在场')
  assert.ok(
    mounted.recorded.some((node) => node.type === 'input' && node.props?.value === 'https://dav.example.com/dsh'),
    'URL 是从接缝里读出来的，不是页面自己存的',
  )
  const areas = mounted.recorded.filter((node) => node.type === 'textarea')
  assert.equal(areas.length, 1, '映射表是一段文本')
  assert.equal(areas[0].props.value, '/home/alice/dev/proj = /opt/work/proj', '映射表按一列「远端 = 本机」画')

  // 宿主没提供设置接缝（例如只装了设置外壳）：这一块要自己说明，而不是画一张点了没用的表单
  const bare = mount({ state, panel: 'sync' })
  const bareText = strings(bare.registrations[0].component(bare.registrations[0].registration.inject()))
  assert.ok(bareText.includes('syncFormUnavailable'), '没接缝时说清只能在配置里改')
  assert.equal(bare.recorded.filter((node) => node.type === 'textarea').length, 0, '没接缝时不画表单')
})

test('客户端产物：同步独占「同步」分页，传输页不再有那张同步卡片', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 2 },
    sessions: [],
    workspaces: [],
  }
  // 分页各自渲染一次：假钩子不点页签，所以「哪一页上有哪张卡片」只能这样量。
  const syncText = strings(
    (() => {
      const mounted = mount({ state, panel: 'sync' })
      return mounted.registrations[0].component(mounted.registrations[0].registration.inject())
    })(),
  )
  const transferText = strings(
    (() => {
      const mounted = mount({ state, panel: 'transfer' })
      return mounted.registrations[0].component(mounted.registrations[0].registration.inject())
    })(),
  )
  assert.ok(syncText.includes('syncTitle'), '「同步」分页上要有同步卡片')
  assert.ok(syncText.includes('syncPreview'), '且带着预演按钮（配置在，按钮就在）')
  assert.ok(!transferText.includes('syncTitle'), '传输页上不该再有同步卡片')
  assert.ok(!transferText.includes('syncPreview'), '传输页上不该再有预演按钮')
})
