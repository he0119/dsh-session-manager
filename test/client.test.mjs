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

import { readBuildIdentity } from '../scripts/build-identity.ts'
import { versionLabel } from '../src/client/logic/version.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundlePath = join(root, 'lib', 'client.js')
const ready = existsSync(bundlePath)
const skip = ready ? false : 'lib/client.js 不存在，先跑 pnpm run build'

const code = ready ? readFileSync(bundlePath, 'utf8') : ''
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 本页不自己写、直接用宿主 `common` 命名空间的那三个词。
 *
 * 与 `src/client/logic/locales.ts` 的 `REUSED_COMMON` 是同一份名单；那边用
 * `satisfies readonly CommonKey[]` 在**编译期**核这几个词真的是宿主 common 的键（这正是那份类型
 * 声明存在的意义），这里只核另一边：本字典里**没有**它们，查找链才会落到宿主那一份。
 */
const REUSED_COMMON = ['cancel', 'close', 'save']

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
 *
 * `meta` 是页面骨架里那份 `/meta` 状态（初始化值是 `undefined`——它在页面上的语义是"还没到"，
 * 与 null 不能混，所以单开一个种子而不是挤进 `nulls`）。它是渲染顺序里**第一个** `useState(undefined)`
 * 的状态（骨架的钩子先于任何分页跑；设置表单里那几个 undefined 状态都在后面）。
 */
function fakeReact(recorded = [], firstNull = undefined, panel = undefined, arrays = [], strings = [], nulls = [], meta = undefined, sets = []) {
  let seededPanel = false
  // useState 的调用序号（同一次渲染里的先后）：`sets` 记下"第几个状态位被 set 成了什么"，
  // 于是用例能核"这个位先收到进度、后来又清回 null"这种成对的事。
  let slot = 0
  const nullSeeds = firstNull === undefined ? [] : [firstNull]
  nullSeeds.push(...nulls)
  // 「种」进空数组状态的那些值按顺序发：分页组件里第一个 useState([]) 是勾选集，第二个是筛选条
  // （见 mount 的 arrays 参数）。顺序是调用方与组件之间的约定，所以种错了会当场断言失败，不会静默过。
  const arraySeeds = [...arrays]
  // 空串状态同样按顺序种（见 mount 的 strings 参数）：迁移页第一个空串是「源目录」，传输页第一个是
  // 导入目标、第二个才是搜索词，会话页第一个就是搜索词——各用例里写清自己种的是哪一个。
  const stringSeeds = [...strings]
  const undefinedSeeds = meta === undefined ? [] : [meta]
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
      // 假钩子**不改**状态（每次渲染都还是种子那个值），但把"谁被 set 成了什么"记下来：面板把
      // `onProgress` 接没接到 api 上、落地之后有没有清掉进度，只有这一条路能看见（见下面「迁移落地
      // 的进度真的进了界面状态」那条用例）。
      const mine = slot
      slot += 1
      const set = (next) => {
        sets.push({ slot: mine, value: next })
      }
      if (value === null && nullSeeds.length > 0) {
        return [nullSeeds.shift(), set]
      }
      // `/meta` 那一份（见上面的 meta 说明）。排在 null 之后、数组与空串之前，与骨架里的调用顺序一致。
      if (value === undefined && undefinedSeeds.length > 0) {
        return [undefinedSeeds.shift(), set]
      }
      // 页内分页的状态：假钩子不会点页签，于是除默认那一页之外的 JSX 在冒烟里一次都跑不到。
      // 只替换**第一个** `useState('manage')`（骨架里那个，默认页就是它），其余字符串状态照旧。
      if (!seededPanel && value === 'manage' && panel !== undefined) {
        seededPanel = true
        return [panel, set]
      }
      // 勾选集 / 筛选条：分页组件自己的 `useState([])`。不给勾选集种子，"按钮禁没禁用"就只能撞上
      // "一条都没勾所以禁用"这条分支，断言等于没测到宿主能力那件事（见下面那个用例的注释）。
      if (arraySeeds.length > 0 && Array.isArray(value) && value.length === 0) {
        return [arraySeeds.shift(), set]
      }
      if (stringSeeds.length > 0 && value === '') {
        return [stringSeeds.shift(), set]
      }
      return [value, set]
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
function loadBundle({ firstNull, panel, arrays, strings, nulls, meta, fetch } = {}) {
  let entry = null
  const nodes = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { entry = value } } },
    document: fakeDocument(nodes),
    console,
    // 浏览器里这两样是全局的：同步的落地走事件流，读流那一步要按 UTF-8 解码（api.ts 里 new 的是
    // TextDecoder）。vm 的新上下文默认什么都不给，少一个就会在"读流"那一步抛 ReferenceError，而它
    // 只会表现成"进度没出现"，看不出是环境缺件。
    TextDecoder,
    TextEncoder,
    // 默认**没有** fetch：渲染路径不该发请求，给不了就当它不存在，省得漏掉一次真网络调用。
    // 用例要核对"点这个按钮打了哪个端点"时显式给一个假 fetch（见「测试连接」那条）。
    ...(fetch === undefined ? {} : { fetch }),
  }
  vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' })
  assert.ok(entry !== null, '产物必须以 window.__ModuleLoader__.load({ id, factory }) 报名')
  const recorded = []
  const sets = []
  const react = fakeReact(recorded, firstNull, panel, arrays, strings, nulls, meta, sets)
  const mod = entry.factory((specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') {
      return {
        jsx: (type, props) => react.createElement(type, props),
        jsxs: (type, props) => react.createElement(type, props),
        Fragment: react.Fragment,
      }
    }
    // 平台基线模块之一（官方控件库）。本产物用得上两样：那个**只写**的密码控件，以及确认弹窗用的
    // `Modal`。真正的它们都是 React 组件，这里照 props 造一个 `input[type=password]` / 一个
    // `[role=dialog]`，并把 props 原样记进 `recorded`——用例要核对的是"徽标说配没配、能不能写""弹窗
    // 开没开、标题是什么、正文摆了什么、底部那两个按钮是谁"这些**入参**，不是官方控件内部怎么画。
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        SettingsSecretField: (props) =>
          react.createElement('input', {
            type: 'password',
            id: props.id,
            value: props.text,
            disabled: props.disabled,
            'data-state': props.stateLabel,
            'data-configured': props.configured,
          }),
        // `Modal` 的替身：真那个会 createPortal 到 body、管 Escape 与焦点归还，这里没有渲染器也没有
        // DOM；用例只关心它的四处入参——`open`（回 null 的契约）、`title`、`children` 与 `footer`。
        Modal: (props) =>
          props.open === false
            ? null
            : react.createElement(
                'div',
                {
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': props.title,
                  className: props.className,
                  'data-close-label': props.closeLabel,
                },
                react.createElement('h2', { className: 'dsm-fakeDialogTitle' }, props.title),
                props.children,
                props.footer === undefined
                  ? null
                  : react.createElement('div', { className: 'dsm-fakeDialogFooter' }, props.footer),
              ),
      }
    }
    throw new Error(`产物 require 了平台模块表里没有的模块：${specifier}`)
  })
  return { entry, mod, nodes, recorded, sets }
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
function mount({ translate, state, meta, panel, arrays, strings, nulls, configForms, credentials, fetch } = {}) {
  const { mod, nodes, recorded, sets } = loadBundle({ firstNull: state, panel, arrays, strings, nulls, meta, fetch })
  const registrations = []
  const dictionaries = []
  const effects = []
  const injectedSlots = []
  const injectedServices = []
  const bound = []
  const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
  // 页面渲染时问到的每一个键（`t()` 的入参）都记下来，并当场核一遍它在本字典里：字面量键已经有
  // 编译期那道（`LocaleNamespaceMap` + `LocaleDictOf`），这条管的是**动态拼出来的**那些（键表、
  // 码 → 键的映射）——漏在字典外的话，界面上露出来的就是键名本身。
  //
  // 三个例外是刻意让它落到宿主 `common` 命名空间的词（`cancel` / `close` / `save`）：它们在
  // 字典里**必须缺席**，由宿主那条查找链兜住（见下面那条断言）。
  const asked = new Set()
  const seat = (key, params) => {
    asked.add(key)
    const dictionary = dictionaries[0]?.dicts.zh ?? {}
    assert.ok(
      Object.hasOwn(dictionary, key) || REUSED_COMMON.includes(key),
      `页面问到的键不在字典里：${key}`,
    )
    return (translate ?? t)(key, params)
  }

  mod.apply({
    effect(callback, label) {
      effects.push(label)
      return callback()
    },
    inject(dependencies, callback) {
      // 客户端壳里这就是就地起一个带依赖声明的子 fiber；这里只记下依赖并立刻跑一遍回调，
      // 顺带记下回调拿到的服务，好在用例里核对「浏览…」真的接在宿主选择器上、密码框真的接在
      // 宿主机凭据服务上（`remote.credentials`）。
      injectedServices.push({ dependencies })
      const scoped = {
        // 设置接缝（`configForms`）按用例给：不给就等于宿主没提供它，同步设置表单要自己说明。
        ...(configForms === undefined ? {} : { configForms }),
        // 凭据服务同理：不给就等于宿主没装凭据提供方，密码框那一块要说明"只能走环境变量"。
        ...(credentials === undefined ? {} : { remote: { credentials } }),
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
        // 框架在渲染时把 `t` seat 叠在注册面之上（条目声明了 `locale` 就有它）。本文件照同一个
        // 合成顺序把它补上，于是"页面拿到的 `t` 来自框架、不是插件自己 inject 的"在用例里也成立；
        // 插件自己 inject 的那一份留在 `injected` 上，供下面那条断言核它**没有** `t`。
        const injected = registration.inject
        registrations.push({
          registration: { ...registration, inject: () => ({ ...(injected?.() ?? {}), t: seat }) },
          component,
          injected,
        })
        return () => {}
      },
    },
  })

  return {
    mod, nodes, recorded, sets, registrations, dictionaries, effects, injectedSlots, injectedServices,
    bound, t, seat, asked,
  }
}

test('客户端产物：apply 把「会话管理」注册到设置里的一页，并带上字典与注入面', { skip }, async () => {
  const { nodes, registrations, dictionaries, effects, injectedSlots, injectedServices, bound, seat } = mount()

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

  // 翻译函数是**框架 props**，不是插件自己 inject 的：注册选项声明 `locale: NS`，框架据此把 `t`
  // 送进组件（本文件在 register 那里照同一条合成顺序补上）。插件自己 inject 的注入面里因此只剩
  // 目录选择器那一项——多 inject 一个 `t` 会把框架那一个盖掉，那正是这条断言要拦的事。
  assert.deepEqual(Object.keys(registrations[0].injected() ?? {}), ['directory'])
  assert.equal(registration.inject().t, seat)

  // 目录选择器与凭据服务：都作为**可选**依赖收（由别的客户端插件提供，不写进顶层 inject），
  // 服务不在时整页照装——只是对应那一块要自己说明。凭据那两个名字都声明：命名空间服务挂在
  // `remote` 下面，官方的客户端插件（网页搜索那张卡）也是这么写的。
  // 跨 realm：产物在另一个 vm 里，它的数组原型与本文件的不是同一个，先摊成宿主数组再比。
  assert.deepEqual(
    injectedServices.map((entry) => [...entry.dependencies]),
    [['configForms'], ['uiWorkspace'], ['remote', 'remote.credentials']],
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
  // 取消 / 关闭 / 保存走宿主 `common` 命名空间（查找链在本命名空间缺席时落到它）：这两处必须
  // 一边缺席、一边存在——本字典里留一份就不会用宿主那份，两种语言各写一遍正是要避免的事。
  for (const key of REUSED_COMMON) {
    assert.ok(!Object.hasOwn(zh, key) && !Object.hasOwn(en, key), `${key} 该由宿主 common 提供`)
  }

  // 界面文案是纯文本渲染（`dd` / 提示里写什么就显示什么），所以字典里不能有 Markdown 记号：
  // 说明页原来那两条 `**…**` 就是原样露在页面上的（用户截图报的）。
  for (const [language, dictionary] of [['zh', zh], ['en', en]]) {
    const marked = Object.keys(dictionary).filter((key) => String(dictionary[key]).includes('**'))
    assert.deepEqual(marked, [], `${language} 字典里摆着 Markdown 星号（会原样显示）`)
  }

  /*
   * 拉取 / 推送两张表的动作标签：那一列是 88px（单元格左右各 8px padding → 标签可用 70px），标签自己
   * 还有左右各 6px padding 与 1px 边框。真机（dev GUI）在这一列上量到：zh「分叉·重推」75px、en
   * 'Replace local' 88px、'No mapping' 83px、'目标目录缺失' 87px —— 都超过 70px，画出来是「分叉…」
   * 这种省略号（用户截图报过），而装得下的那些是 49~63px（「分叉重推」「覆盖本机」「重推刷新」
   * 'Re-push' 'Replace' 'Forked' 'No map' 'No dir'）。
   *
   * 这里用同一把尺子钉住：非 ASCII 字符（汉字、间隔号）按 12px、其余按 6.5px，加上标签自己的
   * 14px（padding + 边框），超过 70px 就是"会被截断"。估算式对上面那批实测值最多高估 11px、最多
   * 低估 5px，所以它抓的是差得远的那种（实测 75px 以上），而不是一两个像素的边界。「这次不动」那张
   * 表是 122px 的列，装的是「两边各自写过」这种更长的短语，不在这条里。
   */
  const SYNC_ACTION_LABELS = [
    'sync.tag.pull',
    'sync.tag.push',
    'sync.tag.repush',
    'sync.tag.localNewer',
    'sync.tag.replace',
    'sync.tag.noMapping',
    'sync.tag.missingTarget',
  ]
  const labelWidth = (text) =>
    [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x7f ? 12 : 6.5), 14)
  for (const [language, dictionary] of [
    ['zh', zh],
    ['en', en],
  ]) {
    const tooWide = SYNC_ACTION_LABELS.map((key) => ({ key, text: String(dictionary[key]) }))
      .filter((entry) => labelWidth(entry.text) > 70)
      .map((entry) => `${entry.key}="${entry.text}"`)
    assert.deepEqual(tooWide, [], `${language}：拉取/推送两张表的动作标签要装得进 88px 那一列`)
  }

  // 说明文字的分工：动作页只写"当下要做的决定"，词条与边界条件（分类含义、谁判的、删完侧边栏为什么
  // 还在、回滚与恢复的差别…）集中到「说明」页。这条分工靠自觉会漂回去——每加一个功能都想在按钮边上
  // 多解释一句，攒起来就是读者每次都要扫过去的散文（实测动作页正文曾经 187 / 382 / 144 字，最长一段
  // 192 字）。这里钉它的机械面：**动作页上的每一段说明都不超过两行**。
  // 两行的容量按实测的排版算：卡片正文宽 534px、说明句 12px（内建描述那一档），一行约 44 个汉字、
  // 英文约 87 个字符，所以两行的上限在 88 / 174 上下——下面这两个数贴着它（现有最长的一条：中文 75
  // 字、英文 174 字符，在 dev GUI 里量下来都是两行）。超过上限不是"字太多"，是"这段该搬去「说明」页"。
  const PAGE_PROSE = {
    zh: 76,
    en: 175,
  }
  const actionKeys = [
    'transfer.export.hint',
    'transfer.import.hint',
    'migrate.hint',
    'migrate.from.unownedHint',
    'manage.hint',
    'manage.delete.hint',
    'backup.hint',
    'list.filter.hint',
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

test('客户端产物：页面骨架带着五个动作页（会话 / 迁移 / 传输 / 同步 / 备份）与说明页', { skip }, () => {
  const { registrations, recorded } = mount()
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  // 用注入面给的 t（键回显）渲染，于是文案就等于字典键，断言不依赖任何一种语言。
  const element = component(inject())
  const text = strings(element)
  assert.ok(text.includes('page.tab.transfer'), '页内要有「传输」这一页')
  assert.ok(text.includes('page.tab.migrate'), '页内要有「迁移」这一页')
  assert.ok(text.includes('page.tab.manage'), '页内要有「会话」这一页（逐条归档 / 删除）')
  assert.ok(text.includes('page.tab.sync'), '页内要有「同步」这一页（WebDAV）')
  assert.ok(text.includes('page.tab.backup'), '页内要有「备份」这一页（三种写操作共同的后悔面）')
  // 页签顺序：日常的「会话」在最前；「同步」紧挨「传输」（它落地走的是导入那条编排）；「备份」是
  // 三个写操作共同的后悔面、不属于任何一个动作页，所以排在动作页之后；说明垫底
  const tabs = recorded.filter((node) => String(node.props?.className) === 'dsm-tab')
  assert.deepEqual(
    tabs.map((node) => strings(node)[0]),
    ['page.tab.manage', 'page.tab.migrate', 'page.tab.transfer', 'page.tab.sync', 'page.tab.backup', 'page.tab.help'],
    '顺序是 会话 → 迁移 → 传输 → 同步 → 备份 → 说明（动作页按日常程度排，参考页垫底）',
  )
  assert.deepEqual(
    tabs.map((node) => node.props['aria-selected']),
    [true, false, false, false, false, false],
    '默认停在第一个页签',
  )
  assert.ok(text.includes('page.title'), '页面标题走同一份字典')
})

test('客户端产物：备份是独立分页，迁移页上不再有那张清单', { skip }, () => {
  // 这张清单里躺的不只是迁移留下的备份：删除与同步覆盖本机那份也各留一份（`kind` 三种）。它原先挂在
  // 「迁移」卡片下面时，界面得在三处替它引路（删除成功的横幅、同步的结果与进度说明、说明页的 FAQ）。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [],
    workspaces: [],
  }
  const pageText = (panel) => {
    const mounted = mount({ state, panel })
    return strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  }
  const migrate = pageText('migrate')
  const backup = pageText('backup')
  for (const key of ['backup.title', 'backup.hint', 'backup.empty']) {
    assert.ok(!migrate.includes(key), `迁移页上不该再有备份清单的那部分（${key}）`)
    assert.ok(backup.includes(key), `「备份」分页上要有清单的那部分（${key}）`)
  }
  // 「会话」页与「同步」页的成功文案都指向「备份」页，不再指向「迁移」页的某张卡：那句话只在弹窗
  // 或流式进度里出现，渲染路径上取不到，所以按字典的值核（键一定在，值里不该再出现"迁移页"）。
  const { zh } = mount().dictionaries[0].dicts
  for (const key of ['manage.delete.backupTo', 'sync.progress.note', 'sync.appliedReplaced', 'help.faq.backupA']) {
    assert.ok(zh[key].includes('「备份」页'), `${key} 要把人指到「备份」页`)
    assert.ok(!zh[key].includes('迁移」页'), `${key} 不该再指「迁移」页`)
  }
  assert.ok(
    zh['sync.progress.note'].includes('「备份」页'),
    '同步的进度说明里那句"去哪恢复"要指到「备份」页',
  )
})

/**
 * 树里每一枚 `dsm-primary` 按钮所在的容器（`cardHead` / `controls` / `root`）。
 *
 * 一次下探里记下来，不分成"先收卡头再收按钮"两趟：函数组件每被调用一次都新建一批元素，两趟比对
 * 身份是对不上的（`strings()` 那条注释里同一个坑）。
 */
function primaryPlacements(node, inside = 'root', out = []) {
  if (Array.isArray(node)) {
    for (const item of node) primaryPlacements(item, inside, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') return primaryPlacements(node.type(node.props), inside, out)
  const className = String(node.props?.className ?? '')
  const classes = className.split(/\s+/)
  const nested = classes.includes('dsm-cardHead') ? 'cardHead' : classes.includes('dsm-controls') ? 'controls' : inside
  if (node.type === 'button' && classes.includes('dsm-primary')) out.push(nested)
  return primaryPlacements(node.props?.children, nested, out)
}

test('客户端产物：卡片级的主动作长在卡片底部的动作行里，不长在卡头', { skip }, () => {
  // 同一页上几张卡片的形状不同（列表 / 字段），主动作的位置是同一条规矩：头部只放不动数据的工具
  // （刷新、全选 / 清空、收起 / 展开），会写盘的那枚在卡片底部的动作行里。判据见
  // .agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 1 },
    sessions: [{ id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 1, files: [] }],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  // 「会话」页那一行放的是归档 / 取消归档 / 删除，三枚都没有 `dsm-primary`（删除是破坏性动作、靠
  // spacer 顶到右端）；另外三页各有一到两枚主动作：迁移页的「迁移」、传输页的「导出所选 + 导入」、
  // 同步页的「同步」（那张设置表单自己的「保存」只在宿主有设置接缝时才画，归表单那条用例钉）。
  const expected = {
    manage: [],
    migrate: ['controls'],
    transfer: ['controls', 'controls'],
    sync: ['controls'],
  }
  for (const [panel, places] of Object.entries(expected)) {
    const mounted = mount({ state, panel })
    const tree = mounted.registrations[0].component(mounted.registrations[0].registration.inject())
    assert.deepEqual(primaryPlacements(tree), places, `${panel} 页的主动作位置`)
  }
})

test('客户端产物：页头是页面级标题（h2 + 说明行），不是卡片式的小标题', { skip }, () => {
  // 真实事故（用户报的）：这一页标题曾是 14px 的 `span`，跟内建设置页（`h2` 16px + 14px 说明行）
  // 摆在一起就是两种规格。结构层面的差别得在产物里钉住，不然改样式时很容易又退回 span。
  const { registrations, recorded } = mount()
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  const tree = elements(component(inject()))

  const heading = tree.find((node) => node.props?.className === 'dsm-title')
  assert.equal(heading?.type, 'h2', '页面标题必须是 h2（内建页就是 h2）')
  assert.ok(strings(heading).includes('page.title'), '标题文案走字典')
  assert.equal(tree.some((node) => node.props?.className === 'dsm-sub'), false, '旧的 .dsm-sub 不该再出现')

  const intro = tree.find((node) => node.props?.className === 'dsm-intro')
  assert.equal(intro?.type, 'p', '说明行是 p')
  assert.ok(
    strings(intro).some((text) => text.includes('page.library')),
    '说明行里带着会话库信息（路径与条数）',
  )
  // 页头**只有**标题与说明行两行：页头里一枚按钮都没有，「刷新」在页签那一行的右端（见下一条）。
  // 反例有两代：标题与「刷新」同排（标题那一行被按钮从 24px 撑到 30px，按钮还与设置外壳自己那枚
  // 「打开配置文件」在同一个右列里上下叠着）；说明行与「刷新」同排（说明行实测宽 497px，加上按钮
  // 与间距要 580px，而内容列只有 564px，它会被挤成两行）。
  const head = tree.find((node) => node.props?.className === 'dsm-head')
  assert.equal(head?.type, 'header', '页头是 header')
  const headKids = Array.isArray(head?.props?.children) ? head.props.children : [head?.props?.children]
  assert.ok(headKids.includes(heading), '标题是页头的直接子节点——没有别的控件与它同排')
  assert.ok(headKids.includes(intro), '说明行也是页头的直接子节点')
  assert.equal(tree.some((node) => node.props?.className === 'dsm-titleRow'), false, '标题行那一层不该再出现')
  assert.deepEqual(
    elementsOf(head).filter((node) => node.type === 'button'),
    [],
    '页头里不该有按钮',
  )

  // 「刷新」在页签那一行的右端：整页的状态（`/meta` + `/state`）不属于任何一个分页，只能挂在页面
  // 这一级；页签整排只占左边一段，右边量下来空着 142px。
  const tabsRow = tree.find((node) => node.props?.className === 'dsm-tabsRow')
  assert.equal(tabsRow?.type, 'div', '页签与「刷新」同排在一个 div 里')
  assert.ok(
    strings(tabsRow).some((text) => text.includes('page.refresh')),
    '「刷新」挂在这一行的右端',
  )
  assert.ok(
    elementsOf(tabsRow).some((node) => node.props?.className === 'dsm-tabs' && node.props?.role === 'tablist'),
    '页签那一层还在这一行里（下划线式页签没有变成工具栏）',
  )
})

test('客户端产物：清单还没到时页头先说库在哪与「读取中…」，不说 0 条', { skip }, () => {
  /**
   * 渲染一整页（`strings` 会走进函数组件，包括分页那个 Fragment），并返回页头说明行的文字。
   *
   * 走 `strings` 而不是 `elements`：分页本体包在 Fragment 里，`elements` 不下穿 Fragment。
   */
  const introOf = (mounted) => {
    strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
    return strings(mounted.recorded.find((node) => node.props?.className === 'dsm-intro'))
  }

  // 只给 `/meta`：它就是"先回来的那一份"（不扫库），`/state` 还在扫，state 保持 null。
  const meta = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    archiveAvailable: true,
  }
  const withMeta = mount({ meta })
  const line = introOf(withMeta)
  assert.ok(line.includes('page.library'), '说明行还是"会话库：…"这一句')
  assert.ok(
    line.some((text) => text.includes('/home/u/.dsh/sessions')),
    '库的位置来自 /meta，不必等扫完整库',
  )
  assert.ok(line.some((text) => text.includes('page.loading')), '条数那一段说"读取中…"')
  assert.ok(
    !line.some((text) => text.includes('page.count.sessions')),
    '"还不知道"不能画成"0 个会话"：条数是结论，不是默认值',
  )
  // 列表那一格同理：清单没到说"读取中…"，不说"这个会话库里还没有会话"（默认页就是「会话」）
  const empties = withMeta.recorded.filter((node) => String(node.props?.className) === 'dsm-empty')
  assert.deepEqual(strings(empties[0]), ['page.loading'], '空列表那一格说"读取中…"')

  // 两份都还没到（首帧）：整行只有一句"读取中…"，不是"会话库： · 0 个会话 · 0 个工作区"
  const bare = introOf(mount())
  assert.ok(bare.includes('page.loading'), '位置也还不知道时，整行说"读取中…"')
  assert.ok(!bare.some((text) => text.includes('page.count')), '首帧一个数字都不报')
})

test('客户端产物：能力位按 /meta 或 /state 说的来，两份都没到时不先报结论', { skip }, () => {
  const read = (mounted) => strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  const base = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [],
    workspaces: [],
  }

  // `/meta` 说这个宿主有归档能力：清单还在读，但"这个宿主没有 workspaceRegistry"绝不能先出现
  const withArchive = read(mount({ meta: { ...base, archiveAvailable: true } }))
  assert.ok(!withArchive.includes('manage.archive.unavailable'), '宿主有这个能力（/meta 说的），不能先报"没有"')

  // 两份都还没到：那一刻的真相是"还不知道"，一句结论都不下
  const bare = read(mount())
  assert.ok(!bare.includes('manage.archive.unavailable'), '能力位还不知道时不说结论')
  assert.ok(!bare.includes('list.empty'), '清单没到不能说"这个会话库里还没有会话"')
  const bareSync = read(mount({ panel: 'sync' }))
  assert.ok(!bareSync.includes('sync.offHint'), '同步配置没读到不能说"这台机器没配同步"')
  assert.ok(bareSync.includes('page.loading'), '那一刻说的是"读取中…"')

  // 读到了、宿主确实没有 / 确实没配：照旧把话说出来（不是一律不说）
  assert.ok(
    read(mount({ state: { ...base, archiveAvailable: false } })).includes('manage.archive.unavailable'),
    '读到了确实没有归档能力，就要说明并禁用那两个按钮',
  )
  assert.ok(read(mount({ panel: 'sync', state: base })).includes('sync.offHint'), '读到了确实没配同步，就要说明')
})

test('客户端产物：右下角那枚版本徽标说得出这是哪个构建', { skip }, () => {
  // 徽标是「这一页是哪个构建」的自述：版本号永远在，直接从 git build 的产物再多一个短 commit
  // （发布构建只有版本号——标签与版本号本来就是同一件事）。三个常量由 `tsdown.config.ts` 的
  // `define` 在编译期写进产物，判据在 scripts/build-identity.ts；没注入的话源码里那三个标识符是
  // ReferenceError，页面当场崩成占位——所以这一条同时是"注入链真的通了"的证据。
  const identity = readBuildIdentity(root)
  const { registrations } = mount()
  const { component, registration } = registrations[0]
  const tree = elements(component(registration.inject()))

  const badge = tree.find((node) => node.props?.className === 'dsm-version')
  assert.equal(badge?.type, 'p', '徽标是一行说明文字')
  // 「右下角」在结构上就是"页面的最后一个元素"：挪到页内分页之前就不再是页脚了。
  assert.equal(tree.at(-1), badge, '徽标是这一页的最后一个元素（页脚）')

  const label = String(badge?.props?.children ?? '')
  assert.ok(label.startsWith(`v${pkg.version}`), `徽标要报出版本号：${label}`)
  if (identity.dirty) {
    // 工作区脏时产物可能比源码新（刚 build 完又改了两行）也可能比源码旧（改完还没 build），
    // 这时只核形状；干净的检出上必须逐字对上这个构建。
    assert.match(label, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?: · [0-9a-f]{7,}(?:-dirty)?)?$/)
  } else {
    assert.equal(
      label,
      versionLabel(identity.version, identity.commit ?? '', identity.dirty),
      '徽标与当前检出的构建对不上——先 pnpm run build 再跑测试',
    )
  }

  // 悬浮提示说清是发布版还是直接 build 的（`v0.3.1` / 本地构建 git 3c9f1ab）：两个键都在字典里，
  // 由上面那条"页面问到的键不在字典里"的断言兜住；这里核的是**问的是哪一个**。
  const tip = String(badge?.props?.title ?? '')
  const buildKey = 'page.version.tipBuild'
  assert.ok(
    tip.startsWith(identity.commit === undefined ? 'page.version.tip' : buildKey),
    `悬浮提示要按有没有 commit 选键：${tip}`,
  )
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
  // 这一页值得跑一遍：它的来源现在有两条路（目录候选 / 未分组），而"未分组"是个**跨目录**的来源
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
  const { registrations, recorded } = mount({
    state,
    panel: 'migrate',
    // null 顺序：骨架的 error / 目录字段的面板（种成"源字段的候选面板开着"——候选就住在面板里）。
    nulls: [null, { field: 'from', mode: 'candidates' }],
  })
  const { component } = registrations[0]
  const { inject } = registrations[0].registration
  const text = strings(component(inject()))

  assert.ok(text.includes('page.tab.migrate'), '页签还在（seeded 的那一页就是它）')
  assert.ok(text.includes('migrate.title') && text.includes('migrate.source.none'), '迁移页本体渲染出来了')

  const rows = candidateRows(recorded)
  const second = (row) => String(strings(row)[1] ?? '')
  assert.ok(rows.some((row) => second(row).includes('/home/u/dev/alpha')), '已登记工作区的目录仍是候选')
  assert.ok(rows.some((row) => second(row).includes('/home/u/dev/beta')), '没登记的目录（库里有会话）也是候选')
  // 冒烟里的翻译函数把键原样吐回来，所以那一行的名字是 list.ungrouped（真值是「未分组」）
  const unowned = rows.find((row) => String(strings(row)[0]) === 'list.ungrouped')
  assert.ok(unowned, '候选里必须有「未分组」这一行')
  // 条数 = 库里"侧边栏会放进「未分组」、且有 cwd"的会话数（s-2 与 s-3），不是某个目录的条数。
  // 第二行只有条数：哨兵值不是路径，不上那一行。
  assert.deepEqual(
    strings(unowned),
    ['list.ungrouped', 'list.sessionsInDir:{"count":2}'],
    '未分组那一行要报出跨目录的条数',
  )
  // 哨兵值只是行内部的值，不该当文案露出来（名字是「未分组」，第二行只有条数）
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
  // 组头只摆名字：路径（以及认出来的项目身份）都在名字那一格的悬浮提示里，判定见下面那个用例。
  assert.ok(
    recorded.some(
      (element) => String(element.props?.className) === 'dsm-groupTitle' && element.props?.title === '/home/u/dev/alpha',
    ),
    '已登记的工作区：路径在名字那一格的悬浮提示里（组头上不再印它）',
  )
  assert.ok(text.includes('/home/u/dev/beta'), '没登记的目录也要成组（没有标题、也没有身份，名字就是路径）')
  assert.ok(text.includes('list.unregisteredDir'), '没登记的目录要标出来，别让人以为它不在册')
  assert.ok(text.includes('list.noCwdGroup'), '没有 cwd 的会话自成一组建在最后')
  assert.ok(text.some((item) => String(item).startsWith('list.sessionsInDir:')), '组头要给出这一组有几条')

  // 三组会话 = 三条组头；一条会话一行，行里不再重复 cwd（它已经在组头上）。
  const heads = recorded.filter((element) => element.props?.className === 'dsm-groupHead')
  assert.equal(heads.length, 3, '一组一条组头')
  // 整组勾选的入口是组头上那个框：它的无障碍名字必须说清是哪一组（"整组勾选／取消：工作区甲"），
  // 否则读屏用户在一堆同名框里分不出点的是谁。文案在 props 里，所以只能从树上取，不在 strings()。
  const groupBoxes = recorded.filter(
    (element) => element.type === 'input' && String(element.props?.['aria-label'] ?? '').startsWith('list.selectGroup:'),
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
  assert.deepEqual(tagsByLabel.get('s-2'), ['list.ungrouped'], '同目录里在「未分组」那一组的那条要单独标出来')
  assert.deepEqual(tagsByLabel.get('s-3'), ['list.ungrouped'], '另一个目录里的同样标出来')
  assert.deepEqual(tagsByLabel.get('s-4'), ['list.ungrouped'], '没有 cwd 的也在那一组里（标签与迁移来源的 cwd 要求无关）')

})

test('客户端产物：组头只摆名字，身份与本机路径在悬浮提示里；候选行与值控件各留各的', { skip }, () => {
  // 组头上只留**人认得的那一个名字**：项目身份（host/owner/repo）与本机路径都是机器字符串，摆在那一行
  // 里又长又会被截断（截断的身份比没有还难认），而"这是哪个仓库、在本机哪个目录"是想知道才看的信息。
  // 规则在 planRows.projectLabel() / pathLabel() / candidateRow()（test/planRows.test.ts 逐条钉着），
  // 这里管的是"四处界面是不是都接上了这条线"：两个动作页的组头、迁移页的候选面板、两处的目录值控件。
  // 面板与组头可以只摆名字（第二行与悬浮提示接得住），<option> 不行——它没有悬浮提示，路径不能从那儿
  // 消失。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    pickerKind: 'browse',
    repos: {
      '/home/u/dev/alpha': 'github.com/he0119/alpha',
      '/home/u/dev/beta': 'github.com/he0119/beta',
    },
    sessions: [
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 2048, files: [], ungrouped: false },
      { id: 's-2', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 1024, files: [], ungrouped: true },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const mounted = mount({ state, panel: 'transfer' })
  const tree = mounted.registrations[0].component(mounted.registrations[0].registration.inject())
  const text = strings(tree)

  /** 一条组头里那串可见的字（组头里只该有这一格文字）。 */
  const namesOf = (head) =>
    elementsOf(head)
      .filter((element) => String(element.props?.className) === 'dsm-groupTitle')
      .map((element) => ({ text: element.props?.children, tip: element.props?.title }))
  const heads = mounted.recorded.filter((element) => String(element.props?.className) === 'dsm-groupHead')
  assert.equal(heads.length, 2, '两个目录两条组头')

  /** 一条组头里那枚主机标签（有项目身份的目录才有）。 */
  const hostsOf = (head) =>
    elementsOf(head)
      .filter((element) => String(element.props?.className) === 'dsm-tag dsm-tagIdle' && element.props?.children === 'github.com')
      .map((element) => element.props?.title)
  assert.deepEqual(hostsOf(heads[0]), ['github.com/he0119/alpha'], '有身份的组头挂一枚主机标签，标签的悬浮提示给全整条身份')
  assert.deepEqual(hostsOf(heads[1]), ['github.com/he0119/beta'])

  // 已登记的那一组：名字是用户起的标题（身份不该把人的名字顶掉），身份与路径都在它的悬浮提示里
  assert.deepEqual(namesOf(heads[0]), [
    { text: '工作区甲', tip: 'github.com/he0119/alpha\n/home/u/dev/alpha' },
  ])

  // 没登记的那一组：名字取身份最后一段（原来这里是整条本机路径），"未登记"照样标
  assert.deepEqual(namesOf(heads[1]), [
    { text: 'beta', tip: 'github.com/he0119/beta\n/home/u/dev/beta' },
  ])
  assert.equal(text.includes('list.unregisteredDir'), true, '没登记的目录照样要标出来')
  // 两个机器字符串都不在可见文字里：身份与路径各自只出现在悬浮提示上
  assert.equal(text.includes('github.com/he0119/beta'), false, '身份不再当可见文字印一遍')
  assert.equal(text.includes('/home/u/dev/beta'), false, '本机路径也不再当可见文字印一遍')
  assert.ok(
    mounted.recorded.some((element) => element.props?.title === 'github.com/he0119/beta\n/home/u/dev/beta'),
    '身份与路径都没丢：它们落在名字那一格的悬浮提示上',
  )

  // 传输页的目标目录（与迁移页同一枚值控件）：身份取代标题那一栏，路径留着——这枚控件只有一行可用，
  // 路径退不到别处去（它的悬浮提示给的是完整值）。
  const transfer = mount({ state, panel: 'transfer', strings: ['/home/u/dev/alpha'] })
  strings(transfer.registrations[0].component(transfer.registrations[0].registration.inject()))
  const target = transfer.recorded.find((element) => String(element.props?.className ?? '').includes('dsm-pathValue'))
  assert.deepEqual(
    strings(target),
    ['github.com/he0119/alpha — /home/u/dev/alpha'],
    '导入卡片里那枚值控件里是「身份 — 路径」',
  )

  // 迁移页的候选面板：名字仍取 `projectLabel`（有标题就是标题），身份与本机路径退到第二行与悬浮提示里
  const migrated = mount({ state, panel: 'migrate', nulls: [null, { field: 'from', mode: 'candidates' }] })
  strings(migrated.registrations[0].component(migrated.registrations[0].registration.inject()))
  const rows = candidateRows(migrated.recorded)
  const rowFor = (path) => rows.find((row) => String(strings(row)[1] ?? '').includes(path))
  assert.deepEqual(
    strings(rowFor('/home/u/dev/alpha')),
    ['工作区甲', '/home/u/dev/alpha · list.sessionsInDir:{"count":1}'],
    '有身份时名字仍取人起的标题，身份与本机路径在第二行与悬浮提示里',
  )
  assert.equal(
    rowFor('/home/u/dev/alpha')?.props?.title,
    'github.com/he0119/alpha\n/home/u/dev/alpha\nlist.sessionsInDir:{"count":1}',
    '整串（身份 + 路径 + 条数）在悬浮提示里',
  )
  assert.deepEqual(strings(rowFor('/home/u/dev/beta')), ['beta', '/home/u/dev/beta · list.sessionsInDir:{"count":1}'])
})

// ---- 「会话」页（逐条归档 / 删除）----
//
// 这一页的存在理由就是"侧边栏里点不到的那些会话"（子智能体 / 空白 / 已归档），所以它的验收点有两个：
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
      // 子智能体会话在 /state 里带**三个**字段：origin 是 header 里的事实，hidden 是宿主先判的理由，
      // ungrouped 是"侧边栏会不会把它放进「未分组」"——子智能体嵌在父会话下面，答案是否。
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

  assert.ok(text.includes('page.tab.manage'), '页签停在「会话」这一页')
  assert.ok(text.includes('manage.title') && text.includes('manage.hint'), '页面本体渲染出来了')
  // 三类隐藏理由各挂各的标签：**标签文字**是子节点，**为什么不显示**在悬浮提示里，两处都核
  const tagged = (key, tip) => {
    const node = recorded.find((element) => element.type === 'span' && strings(element).includes(key))
    assert.ok(node, `缺少「${key}」这枚标签`)
    assert.equal(node.props?.title, tip, `「${key}」要说清它为什么不显示`)
    assert.equal(node.props?.className, 'dsm-tag dsm-tagIdle', '标签走统一的那套中性样式')
  }
  tagged('tag.subagent', 'tag.subagentTip')
  tagged('tag.blank', 'tag.blankTip')
  tagged('tag.archived', 'tag.archivedTip')
  tagged('tag.live', 'tag.liveTip')
  // 归属进了组头：按目录分组（组头写工作区标题，目录路径在那一格的悬浮提示里），行上不再重复那一列
  const heads = recorded.filter((node) => String(node.props?.className) === 'dsm-groupHead')
  assert.equal(heads.length, 2, 'alpha 与 beta 各一组')
  assert.ok(strings(heads[0]).includes('工作区甲'), '登记过的那一组写工作区标题')
  assert.ok(
    recorded.some(
      (node) =>
        String(node.props?.className) === 'dsm-groupTitle' &&
        String(node.props?.title).includes('/home/u/dev/alpha'),
    ),
    '组头那一格的悬浮提示里给出目录（这个夹具没有项目身份，提示就是路径）',
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
  // 子智能体**不是**「未分组」：它确实没在册，但侧边栏把它嵌在父会话下面，从来不放进那一组。
  // 这条以前是反的（判据只看"有没有认领"），所以两行都钉住。
  assert.deepEqual(
    rowParts(manageRows.find((row) => strings(row).includes('s-2'))).tags,
    ['tag.subagent'],
    '子智能体只挂「子智能体」——它不在侧边栏的「未分组」那一组里',
  )
  assert.deepEqual(
    rowParts(manageRows.find((row) => strings(row).includes('s-5'))).tags,
    ['tag.live', 'list.ungrouped'],
    '真正落在侧边栏「未分组」里的那条才挂「未分组」',
  )
  // 归档与删除两组入口都在，且宿主给出归档能力时不显示那句"改不了"
  assert.ok(text.includes('manage.archive.action') && text.includes('manage.archive.undo'), '归档 / 取消归档入口在')
  const actionButton = (key) =>
    recorded.find((element) => element.type === 'button' && strings(element).includes(key))
  assert.equal(actionButton('manage.archive.action')?.props?.['disabled'], false, '宿主有归档能力时按钮可用')
  assert.ok(actionButton('manage.delete.action') !== undefined && text.includes('manage.delete.hint'), '删除入口与说明在')
  assert.ok(!text.includes('manage.archive.unavailable'), '宿主有归档能力时不该显示"改不了归档"那句')
})

test('客户端产物：子智能体缩进到父会话的下一级（同一组 / 父在别的组 / 父被筛掉 / 分叉不缩进）', { skip }, () => {
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
    // beta 组：这条子智能体的父会话在 alpha（父被单独迁走过一次就会长成这样）
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
    { label: 'p1', tags: ['tag.archived'], nest: '0' },
    { label: 'c1', tags: ['tag.subagent'], nest: '1' },
    { label: 'c2', tags: ['tag.subagent'], nest: '2' },
    { label: 'lone', tags: [], nest: '0' },
    { label: 'f1', tags: [], nest: '0' },
    { label: 'x1', tags: ['tag.subagent', 'manage.tag.parentElsewhere'], nest: '1' },
  ])
  // 缩进只改画法：组头报的条数还是这一组有几条会话（子智能体照样算）
  assert.ok(text.some((item) => String(item).includes('list.sessionsInDir:{"count":5}')), 'alpha 组 5 条（分叉也算一条）')
  assert.ok(text.some((item) => String(item).includes('list.sessionsInDir:{"count":1}')), 'beta 组 1 条')

  // ② 只筛「子智能体」：父会话被筛走，子智能体按普通行画（不凭空多一级）；孙的父还在，于是只它缩进
  const second = render(mount({ state, panel: 'manage', arrays: [[], ['subagent']] }))
  assert.deepEqual(rowsOf(second.recorded), [
    { label: 'c1', tags: ['tag.subagent'], nest: '0' },
    { label: 'c2', tags: ['tag.subagent'], nest: '1' },
    { label: 'x1', tags: ['tag.subagent'], nest: '0' },
  ])
})

test('客户端产物：子智能体行的勾选框禁用（跟着父会话走），全选也只勾能单独勾的那些', { skip }, () => {
  // 能勾的集合必须与"单独操作不会被拒的集合"一致（宿主那几条路的判据见 family.ts 的 loneSubagents）：
  // 否则用户只能靠"点下去被拒"发现自己点错了。分叉与孤儿都能单独勾——分叉不是子智能体，孤儿没有可跟随的会话。
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
  assert.equal(inputOf('c1').disabled, true, '子智能体不能单独勾')
  assert.equal(inputOf('c1').title, 'list.lockedSubagentTip:{"name":"父会话"}', '提示里写明该勾哪一条')
  assert.notEqual(inputOf('父会话').disabled, true, '父会话能勾（它就是那个"上面那条"）')
  assert.notEqual(inputOf('f1').disabled, true, '分叉不是子智能体，照旧能单独勾')
  assert.notEqual(inputOf('o1').disabled, true, '孤儿没有可跟随的会话，照旧能单独勾')

  // 筛到只剩"不能单独勾"的那些：一个能勾的都没有，「全选」要真的禁用（把孤儿摘掉，它能单独勾）
  const lockedOnly = { ...state, sessions: sessions.filter((session) => session.id !== 'o1') }
  const second = render(mount({ state: lockedOnly, panel: 'manage', arrays: [[], ['subagent']] }))
  const selectAll = second.recorded.find(
    (element) => element.type === 'button' && strings(element).includes('list.selectAll'),
  )
  assert.equal(selectAll?.props?.['disabled'], true, '列出来的全是不能单独勾的子智能体时，「全选」禁用')
})

/**
 * 树里每一枚"选行工具按钮"所在的容器（`cardHead` / `options` / `controls` / `root`）与禁用态。
 *
 * 与 `primaryPlacements()` 同一个走法（一次下探里记下来，不分成两趟）：函数组件每被调用一次都新建
 * 一批元素，两趟比对身份是对不上的。
 */
function pickPlacements(node, inside = 'root', out = []) {
  if (Array.isArray(node)) {
    for (const item of node) pickPlacements(item, inside, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') return pickPlacements(node.type(node.props), inside, out)
  const classes = String(node.props?.className ?? '').split(/\s+/)
  const nested = classes.includes('dsm-cardHead')
    ? 'cardHead'
    : classes.includes('dsm-options')
      ? 'options'
      : classes.includes('dsm-controls')
        ? 'controls'
        : inside
  if (node.type === 'button') {
    const text = strings(node)[0]
    if (text === 'list.selectAll' || text === 'list.clear') {
      out.push({ text, where: nested, disabled: node.props?.['disabled'] === true })
    }
  }
  return pickPlacements(node.props?.children, nested, out)
}

test('客户端产物：三个分页的选行工具是同一对「全选 / 清空」，禁用判据与位置一致', { skip }, () => {
  // 现象（用户报的）：会话页有一对常驻的「全选」「清空」，传输页只有一枚**会变脸**的按钮——全勾上了
  // 它才显示「清空」，勾了一部分时"清空"在界面上根本不存在；迁移页那一对只在「只选其中几条」下出现
  // （清单摆着却没有工具），而且它的「全选」无视搜索框（作用面是 matching 而不是列出来的那些）。
  // 统一之后的判据见 .agents/notes/implemented/bug-fix/2026-10-08-one-pair-of-pick-tools.md。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [
      { id: 's-alpha', title: '甲', cwd: '/home/u/dev/alpha', createdAt: 2, dir: '/home/u/dev/alpha', bytes: 100, files: [], ungrouped: false },
      { id: 's-beta', title: '乙', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 200, files: [], ungrouped: true },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-alpha'] }],
  }
  /**
   * 渲染一页（一次 `mount` 只够走**一遍**：假钩子的状态种子喂给第一次下探，再走一遍就退回初始值了，
   * 所以"位置"与"文字"各 mount 一次）。
   */
  const render = (panel, extra = {}) => {
    const mounted = mount({ state, panel, ...extra })
    const { component, registration } = mounted.registrations[0]
    return { mounted, tree: component(registration.inject()) }
  }
  const placesOf = (panel, extra = {}) => pickPlacements(render(panel, extra).tree)
  const textOf = (panel, extra = {}) => strings(render(panel, extra).tree)

  const where = { manage: 'cardHead', transfer: 'cardHead', migrate: 'options' }
  // 迁移页的清单靠"源目录"种出来（strings 的第一个空串状态）
  const fromSource = { strings: ['/home/u/dev/alpha'] }

  // ① 三个分页都是**常驻的两枚**，顺序固定（全选在前）：一条都没勾时只有「清空」禁用；位置都是"清单
  // 之上那一行的右端"——会话页 / 传输页的清单就是整张卡，所以是卡头；迁移页的勾选是卡片里的一段，
  // 所以是清单上方那一行（与筛选框同一处）。
  const fresh = {
    manage: placesOf('manage'),
    transfer: placesOf('transfer'),
    migrate: placesOf('migrate', fromSource),
  }
  for (const [panel, places] of Object.entries(fresh)) {
    assert.deepEqual(
      places,
      [
        { text: 'list.selectAll', where: where[panel], disabled: false },
        { text: 'list.clear', where: where[panel], disabled: true },
      ],
      `${panel}：一对常驻的「全选 / 清空」，只有「清空」在没勾东西时禁用`,
    )
  }

  // ② 勾了几条（种进第一个空数组状态）：两枚都能点。传输页那枚"变脸"的按钮正是在这里失效的——
  // 勾了一部分时它只剩「全选」可读，用户找不到「清空」。
  const some = {
    manage: placesOf('manage', { arrays: [['s-alpha']] }),
    transfer: placesOf('transfer', { arrays: [['s-alpha']] }),
    migrate: placesOf('migrate', { ...fromSource, arrays: [['s-alpha']] }),
  }
  for (const [panel, places] of Object.entries(some)) {
    assert.deepEqual(
      places.map((entry) => entry.disabled),
      [false, false],
      `${panel}：勾了一部分时「全选」与「清空」同时可点`,
    )
  }

  // ③ 「全选」的作用面是**眼下列出来的那些**（不是整份候选）：把筛选条件种成筛不到任何一行，
  // 「全选」就必须禁用——否则它会悄悄选上屏幕上看不见的会话。迁移页这条同时证明工具**不随清单空掉
  // 而消失**（清空照旧可点）。
  const filtered = {
    // 会话页 / 传输页的筛选条：第一个空数组状态是勾选集，第二个是筛选条
    transfer: placesOf('transfer', { arrays: [['s-alpha'], ['blank']] }),
    // 迁移页只有搜索框（空串状态的第四个），两个会话都不是空白，所以搜不到任何一行
    migrate: placesOf('migrate', { strings: ['/home/u/dev/alpha', '', '', 'zzz'], arrays: [['s-alpha']] }),
  }
  for (const [panel, places] of Object.entries(filtered)) {
    assert.deepEqual(
      places,
      [
        { text: 'list.selectAll', where: where[panel], disabled: true },
        { text: 'list.clear', where: where[panel], disabled: false },
      ],
      `${panel}：筛空之后「全选」禁用（作用面是列出来的那些），工具不消失（「清空」照旧可点）`,
    )
  }

  // ④ 一枚变脸的按钮、三份各写一遍的文案都不该再回来：三页问到的都是同一对键，另外那三枚键从两份
  // 字典里一起删掉（留着就等于"同一件事有两个词"）。
  const { zh, en } = render('manage').mounted.dictionaries[0].dicts
  for (const key of ['transfer.export.selectAll', 'migrate.scope.selectAll', 'migrate.scope.clear']) {
    assert.ok(!Object.hasOwn(zh, key) && !Object.hasOwn(en, key), `${key} 该删掉：同一对按钮只留 list.*`)
  }
  for (const panel of ['manage', 'transfer']) {
    const text = textOf(panel)
    assert.ok(text.includes('list.selectAll') && text.includes('list.clear'), `${panel} 用共用的那对键`)
  }
  // 迁移页那一份要种出清单来，才走得到那对按钮；同一次下探里也核那个单选框的标签
  const migrateText = textOf('migrate', fromSource)
  assert.ok(migrateText.includes('list.selectAll') && migrateText.includes('list.clear'), 'migrate 用共用的那对键')
  // 「只选其中几条」的单选框不再把条数塞进标签里（条数由「已选 N」报，三页同一处）
  assert.deepEqual(
    migrateText.filter((text) => String(text).startsWith('migrate.scope.subset')),
    ['migrate.scope.subset'],
    '「只选其中几条」的标签是它自己，不带条数',
  )
  // 「全部」模式下那行提示要说清"整来源一起搬、勾选不算数"，以及怎么切到子集（多了一条「全选」的路）
  for (const [language, dictionary] of [['zh', zh], ['en', en]]) {
    assert.ok(
      String(dictionary['migrate.scope.tickHint']).includes('全选') ||
        String(dictionary['migrate.scope.tickHint']).includes('Select all'),
      `${language}：提示里要写出「全选」也能切到子集`,
    )
  }

  // ⑤ 迁移页的行勾选与模式**解耦**：勾选面只反映勾了什么（`checked` 读的是勾选集），模式只决定请求
  // 怎么发（「全部」不发 sessionIds）。种一条勾选、模式停在默认的「全部」：那一行的复选框必须是勾上
  // 的——旧写法在「全部」下把所有行画成未勾，屏幕上与「已选 N」两处各说各话。
  //
  // 走 `strings()` 而不是 `elements()`：分页本体包在 Fragment 里，`elements()` 不下穿 Fragment
  // （见它的注释），而行的记录照样会进 `recorded`。
  const pickedView = mount({ state, panel: 'migrate', ...fromSource, arrays: [['s-alpha']] })
  strings(pickedView.registrations[0].component(pickedView.registrations[0].registration.inject()))
  const pickedRow = pickedView.recorded.find(
    (node) => node.type === 'label' && String(node.props?.className).includes('dsm-rowPick'),
  )
  assert.ok(pickedRow !== undefined, '迁移页要画出行来')
  assert.equal(
    elementsOf(pickedRow).find((element) => element.type === 'input')?.props?.['checked'],
    true,
    '「全部」模式下也要把已勾的那一行画成勾上',
  )
})

test('客户端产物：导出页也把子智能体缩进到父会话的下一级（两个分页各接一遍线）', { skip }, () => {
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
  assert.ok(text.includes('manage.archive.unavailable'), '要说清为什么归档按钮不可用')

  const button = (key) =>
    recorded.find((element) => element.type === 'button' && strings(element).includes(key))
  assert.equal(button('manage.archive.action')?.props?.['disabled'], true, '没有归档能力时归档按钮要真的禁用')
  assert.equal(button('manage.archive.undo')?.props?.['disabled'], true, '取消归档同理')
  // 删除不依赖宿主的归档服务，所以入口照旧在（空选择下它也禁用，但那是另一条理由，界面上另有说明）
  assert.ok(button('manage.delete.action') !== undefined, '删除入口照旧在')
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
    'list.filter.all',
    'tag.subagent',
    'tag.blank',
    'tag.archived',
    'list.ungrouped',
    'tag.live',
  ])
  // 每类各有多少条（对整个库数）：数字是 React 直接渲染的数字节点，strings() 只收字符串，所以单看这里
  const counts = recorded
    .filter((node) => String(node.props?.className) === 'dsm-filterCount')
    .map((node) => String(node.props.children))
  // 「未分组」只有 1 条（s-live）：s-sub（子智能体）与两条空白都不在侧边栏那一组里——这正是这次的改动
  assert.deepEqual(counts, ['1', '2', '1', '1', '1'], '子智能体 1 / 空白 2 / 已归档 1 / 未分组 1 / 活动中 1')
  assert.equal(chip('list.filter.all')?.props?.['aria-pressed'], false, '筛着的时候「全部」不是选中态')
  assert.equal(chip('tag.blank')?.props?.['aria-pressed'], true, '种进去的那一类要显示成选中')
  assert.equal(chip('tag.subagent')?.props?.['aria-pressed'], false, '没勾的那几类不是选中态')
  // 每一类的说明走悬浮提示（与行上的标签同一份文案）
  assert.equal(chip('tag.blank')?.props?.title, 'tag.blankTip')
  assert.equal(chip('list.ungrouped')?.props?.title, 'list.ungroupedTip')

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
  assert.deepEqual(rowParts(both).tags, ['tag.blank', 'tag.archived'], '既是空白又已归档的那条挂两枚，且都不是「未分组」')
  // 筛过之后头部报"显示了其中几条"，别让人以为库里的会话变少了
  assert.ok(text.includes('list.shown:{"shown":2,"total":5}'), '筛过之后报出 显示 N / M 条')

  // 说明句「多选＝任一命中」必须**自己一行**（筛选条后面那个 <p>），不能挤在胶囊那一行里。
  // 挤回去不会报错、不会崩，只会让它重新跟着容器右边缘跑：外层滚动条一进一出就让这条边的位置变
  // （实测旧写法 9px；装了经典滚动条的环境是 15px），胶囊行余量也只剩三十来px、窄一点就整行换行。
  // 位置这种东西没法在这里量，所以按结构核：它在不在 .dsm-filters 里面。
  const filterRow = recorded.find((node) => String(node.props?.className) === 'dsm-filters')
  assert.equal(strings(filterRow).includes('list.filter.hint'), false, '说明句不在胶囊那一行里')
  const searchRow = recorded.find((node) => String(node.props?.className) === 'dsm-filterSearch')
  assert.ok(strings(searchRow).includes('list.filter.hint'), '说明句与胶囊不在同一行（都在固定的左边界上）')
  // 搜索框本身：值的来源是筛选状态，占位符与无障碍名字走字典（它们是 props，strings() 看不见）
  const search = recorded.find((node) => String(node.props?.className) === 'dsm-search')
  assert.equal(search?.props?.type, 'search', '搜索框是原生 input[type=search]（自带清空按钮）')
  assert.equal(search?.props?.placeholder, 'list.filter.search', '占位符说明它搜什么')
  assert.equal(search?.props?.['aria-label'], 'list.filter.search', '搜索框要有无障碍名字')
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
  assert.ok(strings(empties[0]).includes('list.noMatch'), '空态说的是"没有符合筛选条件的会话"')
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
  assert.ok(text.includes('list.shown:{"shown":0,"total":2}'), '头部照样报 显示 0 / 2 条')
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
    'list.filter.all',
    'tag.subagent',
    'tag.blank',
    'tag.archived',
    'list.ungrouped',
    'tag.live',
  ])
  assert.equal(
    recorded
      .filter((node) => String(node.props?.className) === 'dsm-filterCount')
      .map((node) => String(node.props.children))
      .join(','),
    '1,1,0,1,0',
    '子智能体 1 / 空白 1 / 已归档 0 / 未分组 1（b-1）/ 活动中 0',
  )
  assert.ok(text.includes('list.shown:{"shown":1,"total":4}'), '筛过之后报 显示 1 / 4 条')

  // 筛空的那一组整组不画（组头底下没有行，看着像坏了），留下那组报的是筛剩下的条数
  const heads = recorded.filter((node) => String(node.props?.className) === 'dsm-groupHead')
  assert.equal(heads.length, 1, '筛空的组不画组头')
  assert.ok(strings(heads[0]).includes('工作区甲'), '留下的是 alpha 那组')
  assert.ok(text.includes('list.sessionsInDir:{"count":1}'), '组头报的是筛剩下的条数')

  // 行出自共用组件（sessionList.tsx 的 SessionRow），标签也走共用判据
  const rowEls = recorded.filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow')
  assert.equal(rowEls.length, 1, '筛过之后只有一行')
  assert.equal(rowEls[0].props.variant, 'export')
  const labels = recorded.filter(
    (node) => node.type === 'label' && String(node.props?.className).includes('dsm-rowExport'),
  )
  assert.equal(labels.length, 1)
  // a-2 是空白：它不挂「未分组」（侧边栏默认视图里根本没显示它）
  assert.deepEqual(rowParts(labels[0]).tags, ['tag.blank'], '这一页也挂属性标签，且「未分组」只给侧边栏那一组')
})

test('客户端产物：迁移弹窗——计划逐条列出会话，跟着父会话进来的那些挂「随父迁」', { skip }, () => {
  // 弹窗是点了「迁移」之后才在树上的，冒烟里走不到（假钩子给不出点击），所以把 `pending` 种进去。
  // null 状态的顺序：页面骨架的 error（`state` 由 mount 的 `firstNull` 种）/ 迁移页的
  // 目录字段的面板 / 手输路径 / **pending**——所以 `nulls` 里先补三个 null，第四个才是那份计划。
  // 种错位置表现为"弹窗没渲染出来"，当场红。
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
  const previewOf = (cascaded, live = 0, stranded = 0) => ({
    ok: true,
    problems: [],
    from: '/home/u/dev/alpha',
    to: '/home/u/dev/beta',
    sourceProjectDir: 'alpha',
    targetProjectDir: 'beta',
    unowned: false,
    sourceProjectDirs: ['/home/u/.dsh/sessions/alpha'],
    sessions: [
      // 点名的父会话 + 跟着走的子智能体：`via` 指回点名的那个祖先
      { id: 's-1', createdAt: 3, registered: true, alreadyAtTarget: false, sourceDir: '/a/s-1', targetDir: '/b/s-1', files: 1, bytes: 100 },
      { id: 's-9', createdAt: 2, registered: false, alreadyAtTarget: false, sourceDir: '/a/s-9', targetDir: '/b/s-9', files: 1, bytes: 100, via: { id: 's-1' } },
    ].slice(0, cascaded === 0 ? 1 : 2),
    cascaded,
    // 宿主持在内存里、这次不搬的那几条（宿主字段 `liveSkipped`）。
    liveSkipped: Array.from({ length: live }, (_, index) => ({ id: `s-live-${index}`, createdAt: 1 })),
    // 侧边栏不显示、这次也不搬的那几条（宿主字段 `strandedSources`）：它们让源工作区删不掉。
    strandedSources:
      stranded === 0
        ? []
        : [
            {
              workspaceId: 'w1',
              path: '/home/u/dev/alpha',
              title: '工作区甲',
              members: Array.from({ length: stranded }, (_, index) => ({ id: `s-hidden-${index}`, reason: 'blank' })),
            },
          ],
    files: 2,
    bytes: 200,
    artifacts: null,
    registryChange: null,
    summary: 'plan summary',
  })
  const outcomeOf = (cascaded, live = 0, stranded = 0) => ({
    mode: 'plan',
    ok: true,
    preview: previewOf(cascaded, live, stranded),
    applied: false,
    rewritten: 0,
    moved: 0,
    artifactsMoved: 0,
    verified: false,
    problems: [],
    summary: 'plan summary',
    takesEffect: 'restart-required',
  })
  /** 种一份计划进弹窗（`pending` 的位置见上面的注释）。 */
  const withPlan = (cascaded, live = 0, stranded = 0) => {
    const mounted = mount({
      state,
      panel: 'migrate',
      strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
      nulls: [null, null, null, { response: outcomeOf(cascaded, live, stranded), error: null }],
    })
    const tree = mounted.registrations[0].component(mounted.registrations[0].registration.inject())
    return { mounted, tree, text: strings(tree) }
  }

  const withFamily = withPlan(1)
  assert.ok(withFamily.text.includes('migrate.title'), '迁移页本体渲染出来了')
  assert.ok(
    withFamily.text.some((item) => String(item) === 'migrate.family:{"count":1}'),
    '有一条子智能体跟着走时，弹窗里要说明它是跟着父会话进来的',
  )
  // 弹窗本体：标题、逐条清单（含"随父迁"那枚标签）、底部那对按钮
  const dialogs = withFamily.mounted.recorded.filter((node) => node.props?.role === 'dialog')
  assert.equal(dialogs.length, 1, '迁移页上只有一个弹窗')
  assert.equal(dialogs[0].props['aria-label'], 'migrate.dialogTitle', '标题说的是那个动作')
  const rows = withFamily.mounted.recorded.filter(
    (node) => typeof node.type === 'string' && String(node.props?.className).includes('dsm-rowPlan'),
  )
  assert.deepEqual(rows.map((row) => rowParts(row).label), ['s-1', 's-9'], '清单里逐条列出会搬走的会话')
  assert.deepEqual(rowParts(rows[0]).tags, [], '点名的那些没有出处标签')
  assert.deepEqual(rowParts(rows[1]).tags, ['migrate.via'], '级联进来的挂「随父迁」（不是「随父删」）')
  assert.equal(
    (String(rows[1].props.className).match(/dsm-rowNest(\d)/) ?? [])[1],
    '1',
    '级联进来的缩进一级（与上面那条父会话的关系一眼看得出）',
  )
  const footer = withFamily.mounted.recorded.find((node) => String(node.props?.className) === 'dsm-fakeDialogFooter')
  assert.deepEqual(
    // 底部那对按钮在 ConfirmDialog 里是一个 Fragment，得摊平了看（elementsOf 会下探 children）。
    elementsOf(footer)
      .filter((node) => node.type === 'button')
      .map((button) => strings(button)[0]),
    ['cancel', 'migrate.apply'],
    '底部是「取消 / 确认迁移」，确认那个是唯一的落地入口',
  )

  // 没有子智能体跟随时那句话不该出现（否则每次迁移都多一行噪音）
  const plain = withPlan(0)
  assert.ok(plain.text.some((item) => String(item).startsWith('migrate.summary')), '弹窗正文照旧渲染')
  assert.equal(plain.text.some((item) => String(item).startsWith('migrate.family')), false)
  // 宿主持在内存里那几条：不在下面的清单里，所以必须单独说明"这次没搬、重启后再迁一次"。
  assert.equal(plain.text.some((item) => String(item).startsWith('migrate.liveSkipped')), false, '没有少搬时不多话')
  const withLive = withPlan(0, 2)
  assert.ok(
    withLive.text.some((item) => String(item) === 'migrate.liveSkipped:{"count":2}'),
    '少搬了 2 条要说出来，否则"勾了 N 条、搬走 M 条"没人解释',
  )
  // 侧边栏不显示、这次也不搬的那几条：源工作区因此不会被删——不说的话用户看到的就是一块空工作区。
  assert.equal(
    plain.text.some((item) => String(item).startsWith('migrate.stranded')),
    false,
    '没有这类残留时不多话',
  )
  const withStranded = withPlan(0, 0, 2)
  assert.ok(
    withStranded.text.some((item) => String(item) === 'migrate.stranded:{"count":2}'),
    '留下 2 条搬不走的要说出来，并说明源工作区因此不会被删',
  )
  assert.equal(
    withStranded.text.some((item) => String(item).startsWith('migrate.liveSkipped')),
    false,
    '这两类是两回事，别互相冒充（这一份里没有活会话）',
  )

  // 宿主半侧比界面旧一版：响应里没有后加的那两个字段（开发档把本包软链到检出目录，随手重建一次产物
  // 就对不上——那台宿主是上次启动时加载的）。缺字段只该表现为"少说一句"：渲染路径上抛一次，DSH 会把
  // 整个 Slot 摘掉，设置页就只剩一片空白——那正是"点了迁移界面全白"的现场。
  const olderPreview = previewOf(0)
  delete olderPreview.liveSkipped
  delete olderPreview.strandedSources
  const legacyMount = mount({
    state,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
    nulls: [
      null,
      null,
      null,
      { response: { ...outcomeOf(0), preview: olderPreview }, error: null },
    ],
  })
  const legacyText = strings(legacyMount.registrations[0].component(legacyMount.registrations[0].registration.inject()))
  assert.ok(
    legacyText.some((item) => String(item).startsWith('migrate.summary')),
    '宿主半侧旧一版时弹窗照旧渲染出来（渲染路径上抛一次，整页就白了）',
  )
  assert.equal(legacyText.some((item) => String(item).startsWith('migrate.liveSkipped')), false)
  assert.equal(legacyText.some((item) => String(item).startsWith('migrate.stranded')), false)
})

test('客户端产物：迁移的「要不要重启」——确认前先说一句，落地后只在需要重启时留一句', { skip }, () => {
  // 与同步页同一口径（见下面那条同步用例）：「需要重启」是坏消息，既不跟"复核通过"那条绿色结论共用
  // 一块底，也不在没事的时候说一句"无需重启"；而且要在按「确认迁移」**之前**说出来，事后才说等于没提醒
  // （预演那次的口径由宿主给，见 src/web.ts 与 test/web.test.ts）。
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
  /** 一份真的会改注册表的计划：新建目标工作区、把 s-1 从 w1 搬过去、w1 空掉之后删掉。 */
  const change = {
    targetId: 'w2',
    targetPath: '/home/u/dev/beta',
    targetTitle: '工作区乙',
    createdTarget: true,
    added: ['s-1'],
    adoptedFromUnowned: [],
    movedFrom: [{ workspaceId: 'w1', path: '/home/u/dev/alpha', sessionIds: ['s-1'] }],
    removedSources: [{ workspaceId: 'w1', path: '/home/u/dev/alpha' }],
    // 顺带摘掉的悬空登记（宿主本来就不认它们，见宿主 `RegistryChange.droppedStale`）。
    droppedStale: [],
    unchanged: false,
  }
  const previewOf = (registryChange) => ({
    ok: true,
    problems: [],
    from: '/home/u/dev/alpha',
    to: '/home/u/dev/beta',
    sourceProjectDir: 'alpha',
    targetProjectDir: 'beta',
    unowned: false,
    sourceProjectDirs: ['/home/u/.dsh/sessions/alpha'],
    sessions: [
      {
        id: 's-1',
        createdAt: 3,
        registered: true,
        alreadyAtTarget: false,
        sourceDir: '/a/s-1',
        targetDir: '/b/s-1',
        files: 1,
        bytes: 100,
      },
    ],
    cascaded: 0,
    liveSkipped: [],
    strandedSources: [],
    files: 1,
    bytes: 100,
    artifacts: null,
    registryChange,
    summary: 'plan summary',
  })
  /** `pending` 是第四个 null 状态（目录字段的面板 / 手输路径在它前面），顺序种错就表现为弹窗没渲染出来。 */
  const dialog = (registryChange, takesEffect) => {
    const mounted = mount({
      state,
      panel: 'migrate',
      strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
      nulls: [
        null,
        null,
        null,
        {
          response: {
            mode: 'plan',
            ok: true,
            preview: previewOf(registryChange),
            applied: false,
            rewritten: 0,
            moved: 0,
            artifactsMoved: 0,
            verified: false,
            problems: [],
            summary: 'plan summary',
            takesEffect,
          },
          error: null,
        },
      ],
    })
    const tree = mounted.registrations[0].component(mounted.registrations[0].registration.inject())
    return { mounted, text: strings(tree) }
  }

  const warned = dialog(change, 'restart-required')
  assert.ok(warned.text.includes('effect.plannedRestart'), '真要改注册表、宿主又接不住时，确认之前就先说')
  assert.ok(
    warned.mounted.recorded.some(
      (node) => node.props?.children === 'effect.plannedRestart' && node.props?.className === 'dsm-warn',
    ),
    '这句是警告色',
  )
  assert.equal(
    dialog(change, 'immediate').text.includes('effect.plannedRestart'),
    false,
    '宿主自己接得住时不提前警告（只在坏消息时说话）',
  )
  assert.equal(
    dialog({ ...change, unchanged: true }, 'restart-required').text.includes('effect.plannedRestart'),
    false,
    '注册表本来就不用改时没有"生效"可谈，不摆这一句',
  )

  // 顺带摘掉的悬空登记也要在"注册表变更"那张清单里报出来：它同样是一次改动，不能只在摘要那句里提。
  assert.equal(dialog(change, 'immediate').text.includes('registry.stale'), false, '没摘任何登记时不多话')
  const withStale = dialog(
    {
      ...change,
      removedSources: [],
      droppedStale: [
        { workspaceId: 'w1', path: '/home/u/dev/alpha', sessionIds: ['s-ghost'] },
        { workspaceId: 'w3', path: '/home/u/dev/gamma', sessionIds: ['s-gone'] },
      ],
    },
    'immediate',
  )
  assert.ok(
    withStale.text.some((item) => String(item) === 'registry.stale:{"count":2}'),
    '摘掉 2 条悬空登记要在清单里说一句',
  )

  // 落地之后的结论块：需要重启时多一句警告；不需要时那句"无需重启"已经删掉（它和"复核通过"挤在同一个
  // 块里、又是同一种颜色，读不出哪句是坏消息）。
  const effectBlock = (takesEffect) => {
    const mounted = mount({
      state,
      panel: 'migrate',
      // null 顺序：骨架的 error / 目录字段的面板 / 手输路径 / pending / busy / 错误 / notice / **effect**。
      nulls: [
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        { verified: true, backupDir: '/home/u/.dsh/dsh-session-manager/backups/2026-10-06T00-00-00', takesEffect },
      ],
    })
    const tree = mounted.registrations[0].component(mounted.registrations[0].registration.inject())
    return { mounted, text: strings(tree) }
  }
  const restarting = effectBlock('restart-required')
  assert.ok(
    restarting.mounted.recorded.some(
      (node) => node.props?.children === 'effect.restart' && node.props?.className === 'dsm-warn',
    ),
    '需要重启时留一句警告（复核那条绿色结论还在，但不再替它说话）',
  )
  assert.ok(restarting.text.includes('verify.pass'), '复核结论照旧')
  assert.ok(restarting.text.includes('effect.restart'), '警告的文案在页面上')
  const applied = effectBlock('immediate')
  assert.equal(applied.text.includes('effect.restart'), false, '不需要重启时一句都不摆')
  assert.ok(applied.text.includes('verify.pass'), '复核结论照旧')
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

// ---- 目录字段的候选面板（迁移的源 / 目标、导入的落地目录共用一个组件） ----
//
// 候选是"你有多少个工作区就有多少条"，几十条时原生下拉框只能一行行滚着找。字段因此只剩两件东西：
// **一枚值控件**（显示当前值，点开面板）与「手输路径」——候选、筛选、选中都在面板里（点一行就是选中），
// 与页面内那个目录浏览框是同一份面板、同一套皮，两边的头各有一枚按钮互相切。三处目录字段是同一个
// 组件（见 DirectoryField.tsx），这里钉六件事：值控件显示的确实是当前值、点开的是候选面板；面板里的
// 筛选只收窄它自己那份列表；没命中时给一句说法而值不动；宿主没有目录选择器时不摆那枚切过去的按钮；
// **传输页的落地目录也是它**（没有原生下拉框了）、候选与迁移页的目标目录同一份；整页一个 `<select>`
// 都没有。

/** 候选面板里列出来的行：每一行都是一枚 `dsm-dirEntry dsm-candidate` 按钮。 */
function candidateRows(recorded) {
  return recorded.filter((node) => node.type === 'button' && String(node.props?.className ?? '') === 'dsm-dirEntry dsm-candidate')
}

/** 某个目录字段的值控件（候选面板的开关）。 */
function valueControl(recorded) {
  return recorded.find((node) => String(node.props?.className ?? '') === 'dsm-select dsm-selectPath dsm-pathValue')
}

/** 两个工作区、两条会话：源候选与目标候选都是这两条，够看清"筛的是哪一份列表"。 */
const MIGRATE_FIELD_STATE = {
  sessionsRoot: '/home/u/.dsh/sessions',
  registryPath: '/home/u/.dsh/registry.json',
  problems: [],
  pickerKind: 'browse',
  sessions: [
    { id: 'a-1', cwd: '/home/u/dev/alpha', createdAt: 3, dir: '/home/u/dev/alpha', bytes: 100, files: [] },
    { id: 'b-1', cwd: '/home/u/dev/beta', createdAt: 1, dir: '/home/u/dev/beta', bytes: 300, files: [] },
  ],
  workspaces: [
    { id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['a-1'] },
    { id: 'w2', path: '/home/u/dev/beta', title: '工作区乙', sessionIds: ['b-1'] },
  ],
}

test('客户端产物：目录字段的值控件显示当前值，点开的是候选面板（没有原生下拉框了）', { skip }, () => {
  // null 状态按渲染顺序种：骨架的 error / **目录字段的面板**（这里种成"源字段的候选面板开着"）。
  const mounted = mount({
    state: MIGRATE_FIELD_STATE,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha'],
    nulls: [null, { field: 'from', mode: 'candidates' }],
  })
  const { component, registration } = mounted.registrations[0]
  strings(component(registration.inject()))

  assert.equal(mounted.recorded.filter((node) => node.type === 'select').length, 0, '目录字段里再没有原生下拉框')

  const value = valueControl(mounted.recorded)
  assert.ok(value, '值控件是一枚按钮')
  assert.equal(value.props['aria-expanded'], true, '面板开着时它是 expanded')
  assert.equal(value.props.title, '/home/u/dev/alpha', '完整值在悬浮提示里（框里放不下会截断）')
  assert.equal(
    value.props['aria-label'],
    'migrate.from.label：工作区甲 — /home/u/dev/alpha',
    '无障碍名字里既有字段也有当前值（屏幕阅读器与语音控制都要）',
  )
  assert.deepEqual(strings(value), ['工作区甲 — /home/u/dev/alpha'], '框里显示的是当前值，且认得出的名字在前')

  assert.ok(
    mounted.recorded.some((node) => String(node.props?.className ?? '').includes('dsm-candidatePicker')),
    '候选面板开在这个字段下面',
  )
  const rows = candidateRows(mounted.recorded)
  assert.deepEqual(rows.map((row) => strings(row)[0]), ['工作区甲', '工作区乙'], '一行一个候选，名字在第一行')
  assert.equal(strings(rows[0])[1], '/home/u/dev/alpha · list.sessionsInDir:{"count":1}', '路径与条数在第二行')
  assert.equal(rows[0].props['aria-current'], 'true', '当前值那一行认得出来')
  assert.equal(rows[1].props['aria-current'], undefined, '别的行没有这个记号')

  const filter = mounted.recorded.find((node) => node.props?.['aria-label'] === 'pathField.filter')
  assert.equal(filter.props.className, 'dsm-search dsm-candidateFilter', '筛选框在面板里、撑满一行')
  assert.ok(
    mounted.recorded.some((node) => node.props?.children === 'dirPicker.filesystem'),
    '宿主那条路在面板头里（这台宿主有目录选择器）',
  )
})

test('客户端产物：候选面板的筛选只收窄自己那份列表，没命中时给一句说法', { skip }, () => {
  // 空串状态按渲染顺序种：from → to → title → 会话搜索词 → **面板里的筛选词**。
  const openPanel = (query) =>
    mount({
      state: MIGRATE_FIELD_STATE,
      panel: 'migrate',
      strings: ['/home/u/dev/alpha', '', '', '', query],
      nulls: [null, { field: 'from', mode: 'candidates' }],
    })
  const render = (mounted) => strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))

  const hit = openPanel('beta')
  const hitText = render(hit)
  assert.deepEqual(candidateRows(hit.recorded).map((row) => strings(row)[0]), ['工作区乙'], '命中一条就只列那一条')
  assert.equal(hitText.includes('pathField.noMatch'), false, '有命中就不说"没有匹配"')

  const miss = openPanel('zzz-没有这个')
  const missText = render(miss)
  assert.deepEqual(candidateRows(miss.recorded), [], '一条都不列')
  assert.ok(missText.includes('pathField.noMatch'), '给一句说法，别让人以为筛选坏了')
  assert.deepEqual(strings(valueControl(miss.recorded)), ['工作区甲 — /home/u/dev/alpha'], '值不受筛选影响')
})

test('客户端产物：面板头那枚「浏览文件系统…」把同一处切成宿主的目录浏览框', { skip }, () => {
  const mounted = mount({
    state: MIGRATE_FIELD_STATE,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha'],
    nulls: [null, { field: 'from', mode: 'filesystem' }],
  })
  const { component, registration } = mounted.registrations[0]
  const text = strings(component(registration.inject()))

  assert.ok(text.includes('dirPicker.title'), '切成宿主的目录浏览框')
  assert.ok(text.includes('dirPicker.candidates'), '那头有切回候选的按钮')
  assert.equal(
    mounted.recorded.some((node) => String(node.props?.className ?? '').includes('dsm-candidatePicker')),
    false,
    '候选面板不同时开着（同一处只有一份列表）',
  )
  assert.equal(valueControl(mounted.recorded).props['aria-expanded'], false, '候选面板没开：值控件是收起的')
})

test('客户端产物：宿主没有目录选择器时，候选面板里不摆「浏览文件系统…」', { skip }, () => {
  const { pickerKind, ...withoutPicker } = MIGRATE_FIELD_STATE
  assert.equal(pickerKind, 'browse', '夹具本来是"有选择器"那一档')
  const mounted = mount({
    state: withoutPicker,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha'],
    nulls: [null, { field: 'from', mode: 'candidates' }],
  })
  strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))

  assert.ok(
    mounted.recorded.some((node) => String(node.props?.className ?? '').includes('dsm-candidatePicker')),
    '候选面板照旧开着',
  )
  assert.equal(
    mounted.recorded.some((node) => node.props?.children === 'dirPicker.filesystem'),
    false,
    '不摆一个点了必然报错的按钮',
  )
})

test('客户端产物：传输页的落地目录换成了同一枚值控件，候选与迁移页的目标目录同一份', { skip }, () => {
  // null 状态按渲染顺序种：骨架的 error / 传输页的 file / payload / pending / busy / error / notice /
  // **目录字段的面板**（种成"落地目录的候选面板开着"——候选就住在面板里）。
  const mounted = mount({
    state: MIGRATE_FIELD_STATE,
    panel: 'transfer',
    strings: ['/home/u/dev/alpha'],
    nulls: [null, null, null, null, null, null, null, { field: 'target', mode: 'candidates' }],
  })
  const { component, registration } = mounted.registrations[0]
  const text = strings(component(registration.inject()))

  // 目录字段不再有原生下拉框：值控件是那枚按钮（这条与迁移页那份是同一个组件的行为）。
  assert.equal(mounted.recorded.filter((node) => node.type === 'select').length, 0, '不再有原生下拉框')
  assert.equal(mounted.recorded.filter((node) => node.type === 'option').length, 0, '也就没有 <option> 了')
  const value = valueControl(mounted.recorded)
  assert.ok(value, '落地目录是那枚值控件')
  assert.equal(value.props['aria-expanded'], true, '面板开着时它是 expanded')
  assert.equal(
    value.props['aria-label'],
    'transfer.import.targetLabel：工作区甲 — /home/u/dev/alpha',
    '无障碍名字里既有字段也有当前值',
  )
  assert.deepEqual(
    candidateRows(mounted.recorded).map((row) => strings(row)),
    [
      ['工作区甲', '/home/u/dev/alpha'],
      ['工作区乙', '/home/u/dev/beta'],
    ],
    '候选＝已登记的工作区（与迁移页目标目录同一份构造：不带条数、没有「未分组」）',
  )
  const filter = mounted.recorded.find((node) => node.props?.['aria-label'] === 'pathField.filter')
  assert.equal(filter?.props?.className, 'dsm-search dsm-candidateFilter', '面板里还是那个筛选框')
  assert.ok(text.includes('pathField.type'), '字段里还是那枚「手输路径」')
  assert.ok(
    mounted.recorded.some((node) => node.props?.children === 'dirPicker.filesystem'),
    '宿主那条路也在面板头里（这台宿主报的是 browse 能力）',
  )
  // 包那一个字段也带标签了（原来它光秃秃地摆在动作行里）
  assert.ok(text.includes('transfer.import.fileLabel'), '包那一个字段有标签')
})

test('客户端产物：传输页的落地目录也能手输（候选之外的路径）', { skip }, () => {
  // null 顺序同上，最后一个是「手输路径」展开着的那个字段。
  const mounted = mount({
    state: MIGRATE_FIELD_STATE,
    panel: 'transfer',
    strings: ['/home/u/dev/alpha'],
    nulls: [null, null, null, null, null, null, null, null, 'target'],
  })
  strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))

  const manual = mounted.recorded.find(
    (node) => node.type === 'input' && node.props?.['aria-label'] === 'transfer.import.targetLabel',
  )
  assert.ok(manual, '「手输路径」展开时是一个输入框')
  assert.equal(manual.props.value, '/home/u/dev/alpha', '框里就是当前值')
  assert.equal(manual.props.placeholder, 'pathField.placeholder')
  assert.equal(valueControl(mounted.recorded).props['aria-expanded'], false, '候选面板没开（同一时刻只有一个）')
})

test('客户端产物：整页一个原生下拉框都没有（目录一律走那枚值控件）', { skip }, () => {
  // 六个分页各渲染一遍：目录字段在「迁移」与「同步」之外都用同一个组件，「同步」那张映射表里只有
  // 文本框（远端路径靠 datalist 提示，那一侧在别的机器上、本机给不出候选）。
  for (const panel of ['manage', 'migrate', 'transfer', 'sync', 'backup', 'help']) {
    const mounted = mount({ state: MIGRATE_FIELD_STATE, panel })
    strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
    assert.deepEqual(
      mounted.recorded.filter((node) => node.type === 'select').map((node) => node.props?.className),
      [],
      `${panel} 页里不该有原生下拉框`,
    )
  }
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
  assert.ok(hitText.includes('list.shown:{"shown":1,"total":2}'), '按标题搜到了那一条')
  assert.deepEqual(
    hit.recorded
      .filter((node) => typeof node.type === 'function' && node.type.name === 'SessionRow')
      .map((node) => node.props.session.id),
    ['s-1'],
  )

  // 搜不到时：空态照样画在那个高度固定的框里，头部报 显示 0 / 2（框还在，整页高度就不变）
  const miss = mount({ state, panel: 'manage', strings: ['zzz-没有这条'] })
  const missText = strings(miss.registrations[0].component(miss.registrations[0].registration.inject()))
  assert.ok(missText.includes('list.shown:{"shown":0,"total":2}'), '搜不到也照样报条数')
  const lists = miss.recorded.filter((node) =>
    String(node.props?.className ?? '').split(/\s+/).includes('dsm-list'),
  )
  assert.equal(lists.length, 1, '列表框还在')
  assert.ok(
    miss.recorded.some(
      (node) => String(node.props?.className) === 'dsm-empty' && strings(node).includes('list.noMatch'),
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
  assert.ok(oneText.includes('list.sessionsInDir:{"count":1}'), '收起的组头照样报"这组几条"')
  assert.ok(
    oneText.includes('list.shown:{"shown":2,"total":3}'),
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
    toggles.every((node) => node.props.type === 'button' && String(node.props['aria-label']).includes('list.toggleGroup')),
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
  assert.ok(allText.includes('list.shown:{"shown":2,"total":3}'), '全收着也照样报"显示 2 / 3 条"')
  assert.ok(allText.includes('list.sessionsInDir:{"count":1}'), '组头的条数不因为收起而变')
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
  // 筛「子智能体」（一条都没有）→ 组一个都不剩，收无可收
  const { registrations, recorded } = mount({ state, panel: 'transfer', arrays: [[], ['subagent'], []] })
  strings(registrations[0].component(registrations[0].registration.inject()))
  assert.equal(recorded.filter((node) => String(node.props?.className) === 'dsm-groupTools').length, 0)
  assert.ok(
    recorded.some((node) => String(node.props?.className) === 'dsm-empty' && strings(node).includes('list.noMatch')),
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
  assert.ok(text.includes('list.sessionsInDir:{"count":1}'), '收起的组头照样报"这组几条"')
  assert.ok(text.includes('list.shown:{"shown":2,"total":4}'), '折叠不改"列出来了哪些"（仍是 2 条）')
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
// （同一件事在两处各写一份就会漂），以及边界条件确实讲全了（分类、每页做什么、数据从哪来、常见疑问）。
// 四张卡片：原先"会碰什么盘"那节的独有内容并进常见疑问，与既有问答重复的那三条不再各写一份。
// 动作页那边由上面那条"每段最多两行"的预算盯着。

test('客户端产物：「说明」页把分类词条、每页做什么与边界条件摆出来', { skip }, () => {
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

  for (const key of ['help.categories.title', 'help.tabs.title', 'help.where.title', 'help.faq.title']) {
    assert.ok(text.includes(key), `缺少小节「${key}」`)
  }
  // 词条与解释成对，且词条就是行上那几枚标签的键
  const terms = recorded.filter((node) => node.type === 'dt').flatMap((node) => strings(node))
  for (const key of ['help.categories.visible', 'tag.subagent', 'tag.blank', 'tag.archived', 'tag.live', 'list.ungrouped']) {
    assert.ok(terms.includes(key), `分类词典缺少「${key}」`)
  }
  assert.equal(terms.length, 21, '词条数＝分类 6 + 分页 5 + 数据 2 + 疑问 8')
  assert.equal(recorded.filter((node) => node.type === 'dd').length, 21, '每条词条都有解释')
  assert.ok(terms.includes('page.tab.sync'), '分页那一节要写到「同步」这一页')
  assert.ok(terms.includes('page.tab.backup'), '分页那一节也要写到「备份」这一页')
  // 「数据从哪来」两条路径来自 /state，不是写死在文案里
  assert.ok(
    text.includes('/home/u/.dsh/sessions') && text.includes('/home/u/.dsh/registry.json'),
    '两条路径来自 /state',
  )
  for (const key of [
    'help.faq.unownedQ',
    'help.faq.deletedQ',
    'help.faq.restartQ',
    'help.faq.backupQ',
    'help.faq.familyQ',
    'help.faq.exportQ',
    'help.faq.forkQ',
    'help.faq.passwordQ',
  ]) {
    assert.ok(text.includes(key), `常见疑问缺少「${key}」`)
  }
  // 四张卡片：会碰什么盘那节撤了，独有那三条（备份与回滚、子智能体跟着父会话走、包里有什么）并入常见疑问
  assert.ok(!text.includes('helpDiskTitle'), '说明页不该再有单独的一张"会碰什么盘"')
  // 文案本身是纯文本（不能摆 Markdown 星号）由上面那条字典检查盯着：这里渲染的是键名，看不出值
  // 说明页不该长成一个"什么都往里塞"的垃圾桶：正文段落本身就是词条，没有额外的大段散文
  assert.ok(text.includes('help.hint'), '页首要有一句话说明这一页讲什么')
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
  assert.ok(text(off).includes('sync.offHint'), '没配置时要说明怎么配')
  assert.ok(!buttonTexts(off).includes('sync.action'), '没配置时不该出现同步按钮')

  // 配置了：远端与这台机器报出来，预演与确认两个按钮都在
  const on = mount({
    state: { ...base, sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 2 } },
    panel: 'sync',
  })
  const onText = text(on)
  assert.ok(onText.includes('sync.where:{"url":"https://dav.example.com/dsh"}'), '卡片标题只报远端')
  assert.ok(onText.includes('sync.hint:{"mappings":2}'), '要报出映射条数')
  // 机器名不再重复印在标题上：它挪到了机器名那一栏的**灰字**里（宿主解析出来的缺省值，没配就是
  // 主机名），与「超时」那一栏的 30000 同一个口径——留空不等于没有值。那一栏归表单那条用例钉。
  // 一个动作一个按钮：弹窗里的「确认同步」只有开了弹窗才在树上，卡片头上只有「同步」这一个入口。
  assert.deepEqual(buttonTexts(on).filter((label) => label.startsWith('sync')), ['sync.action'])
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
          // 机器名**没配过**（接缝里就没有这一项）：真实场景就是这个样子，缺省值由宿主解析。
          url: 'https://dav.example.com/dsh',
          timeoutMs: 30000,
          passwordRef: 'MY_DAV_PASSWORD',
          mapping: { '/home/alice/dev/proj': '/opt/work/proj' },
        },
      },
    }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  // 宿主机凭据服务的形状（`remote.credentials`）：`describe` 只说"配没配、能不能写"，没有值。
  const credentials = {
    async describe(refs) {
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: true, writable: true, source: 'file' }])) }
    },
    async set() {
      return { ok: true, value: undefined }
    },
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
    credentials,
  })
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  assert.deepEqual(asked, ['session-manager'], '按 profile 里那个 insert 的 id 取控制器')
  assert.ok(text.includes('sync.field.mapping'), '映射字段在场')
  assert.ok(
    mounted.recorded.some((node) => node.type === 'input' && node.props?.value === 'https://dav.example.com/dsh'),
    'URL 是从接缝里读出来的，不是页面自己存的',
  )
  // 机器名那一栏：接缝里没这一项（没配过），宿主状态里解析出来是 robot-a —— 框里应当是**空的**、
  // 灰字是那个名字。灰字不是值：它不会进草稿，保存时也不会被写成一条"等于缺省值"的覆盖
  // （覆盖会把这一栏从此顶上一个「已覆盖」徽标，见 syncForm.ts 的 draftOps）。
  const machineInput = mounted.recorded.find(
    (node) => node.type === 'input' && node.props?.placeholder === 'robot-a',
  )
  assert.ok(machineInput !== undefined, '机器名那一栏的灰字是宿主解析出来的缺省值')
  assert.equal(machineInput.props.value, '', '没配过就画成空的——灰字只是缺省，不是值')

  // 映射表是行：左右各一个输入框，值分别来自接缝里的那一对键值
  const mappingInputs = mounted.recorded.filter(
    (node) => node.type === 'input' && (node.props?.value === '/home/alice/dev/proj' || node.props?.value === '/opt/work/proj'),
  )
  assert.equal(mappingInputs.length, 2, '映射表按「远端 cwd → 本机目录」两个输入框画')
  assert.ok(!mounted.recorded.some((node) => node.type === 'textarea'), '映射表不再是一段文本')
  assert.ok(text.includes('sync.map.add'), '有「添加一行」')

  // 密码：官方控件库那个**只写**控件（`SettingsSecretField`），不是本页手写的 dsm-input。
  // 假钩子不跑 useEffect，所以这里量的是首帧：`describe` 的答案还没回来之前按"未配置"画，
  // 并且输入框从空白开始——没有任何读路径会把值送回来（`describe` 只回 {configured, writable}）。
  const secret = mounted.recorded.find((node) => node.props?.id === 'dsm-dav-password')?.props
  assert.ok(secret !== undefined, '宿主给了凭据服务就摆出密码控件')
  assert.equal(secret.label, 'sync.field.password')
  assert.equal(secret.text, '', '只写控件从空白开始：值不会从宿主那边回来')
  assert.equal(secret.stateLabel, 'sync.password.unset', '首帧按未配置画，describe 回来之后再改')
  assert.equal(secret.configured, false)
  assert.equal(secret.disabled, false)
  assert.ok(!text.includes('sync.password.unavailable'), '有凭据服务时不摆那句"只能走环境变量"')

  // 引用名（`sync.passwordRef`）不在这张表单上：它是插件配置的事，卡片只问"密码是什么"。
  // 摆出来就等于给配置里那一项开第二个编辑口，而这两个口很容易悄悄分叉。
  assert.ok(!text.includes('syncFieldPassword'), '不该有「密码引用」那一栏')
  assert.ok(
    !mounted.recorded.some((node) => node.props?.value === 'MY_DAV_PASSWORD'),
    '接缝里的引用名原样出现在输入框里，就是那一栏又回来了',
  )

  // 宿主没提供设置接缝（例如只装了设置外壳）：这一块要自己说明，而不是画一张点了没用的表单
  const bare = mount({ state, panel: 'sync' })
  const bareText = strings(bare.registrations[0].component(bare.registrations[0].registration.inject()))
  assert.ok(bareText.includes('sync.form.unavailable'), '没接缝时说清只能在配置里改')
  assert.ok(!bareText.includes('sync.map.add'), '没接缝时不画表单')

  // 有接缝、没有凭据服务（宿主没装凭据提供方）：表单照画，只是密码那一块说清只能走环境变量，
  // 不摆一个按下去必然被拒的输入框。
  const noCredentials = mount({
    state,
    panel: 'sync',
    configForms: { get: () => controller },
  })
  const noCredentialsText = strings(noCredentials.registrations[0].component(noCredentials.registrations[0].registration.inject()))
  assert.ok(noCredentialsText.includes('sync.password.unavailable'), '没凭据服务时说清密码只能走环境变量')
  assert.ok(!noCredentials.recorded.some((node) => node.props?.id === 'dsm-dav-password'), '也不摆那个控件')
  assert.ok(noCredentialsText.includes('sync.map.add'), '其余字段照旧能改')
})

test('客户端产物：同步设置里的「测试连接」——按钮、只读提示与三种结论', { skip }, async () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 1 },
    sessions: [],
    workspaces: [],
  }
  const controller = {
    getSnapshot: () => ({
      status: 'ready',
      writable: true,
      revision: 4,
      value: { sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', timeoutMs: 30000, mapping: {} } },
    }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const credentials = {
    async describe(refs) {
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: false, writable: true }])) }
    },
    async set() {
      return { ok: true, value: undefined }
    },
  }
  const render = (extra = {}) => {
    const mounted = mount({ state, panel: 'sync', configForms: { get: () => controller }, credentials, ...extra })
    return { mounted, text: strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject())) }
  }
  // 假钩子不会点按钮，所以"结论行"由 `nulls` 按顺序种进去：第一个种子被骨架的会话库状态（`state`）
  // 吃掉，接着七个分别是骨架的错误，同步页的 sync / 弹窗开关 / busy / 错误 / 通知 / 进度，第八个
  // 才是这张表单的测试结论（顺序见 ManagerPanel / SyncPanel / SyncConfigForm 里 useState 的先后）。
  const outcomeOf = (outcome) => render({ nulls: [null, null, null, null, null, null, null, outcome] })

  const fresh = render()
  assert.ok(fresh.text.some((item) => item === 'sync.test.action'), '有「测试连接」按钮')
  assert.ok(fresh.text.some((item) => item === 'sync.test.hint'), '旁边说明这次探测是只读的')
  assert.equal(fresh.text.includes('sync.test.dirty'), false, '没有草稿时不摆"先保存"那句')
  const testButton = fresh.mounted.recorded.find((node) => node.type === 'button' && node.props?.children === 'sync.test.action')
  assert.ok(testButton !== undefined, '按钮是个真的 button')
  assert.equal(testButton.props.disabled, false, '配了 url、又没有草稿：可以直接测')
  assert.equal(fresh.text.some((item) => String(item).startsWith('sync.test.ok')), false, '没测之前不摆结论')

  // 401 且库里没有密码：这是最常见的那一次失败，说清"引用名里没有值"（而不是笼统的"认证失败"）。
  const denied = outcomeOf({
    mode: 'test',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    code: 'unauthenticated',
    status: 401,
    namespaceExists: false,
    machines: [],
    entries: 0,
    detail: 'PROPFIND https://dav.example.com/dsh/dsh-session-manager 返回 401 Unauthorized',
    username: 'webdav',
    hasPassword: false,
  })
  const deniedLine = 'sync.test.noPassword:{"ref":"DSH_DAV_PASSWORD"}'
  assert.ok(denied.text.some((item) => item === deniedLine), '没密码的 401 要说清是引用名里没有值')
  assert.ok(
    denied.mounted.recorded.some((node) => node.props?.className === 'dsm-warn' && node.props?.children === deniedLine),
    '失败那行用警示色',
  )

  const reachable = outcomeOf({
    mode: 'test',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    code: 'ok',
    status: 207,
    namespaceExists: true,
    machines: ['robot-a', 'robot-b'],
    entries: 2,
    username: 'webdav',
    hasPassword: true,
  })
  const okLine = 'sync.test.ok:{"machines":"robot-a, robot-b"}'
  assert.ok(reachable.text.some((item) => item === okLine), '连得上时把远端已有的机器格列出来')
  assert.ok(
    reachable.mounted.recorded.some((node) => node.props?.className === 'dsm-ok' && node.props?.children === okLine),
    '成功那行用成功色',
  )

  // 有未保存的改动时测的不是刚敲进去的那一份：按钮禁用，那句话也换成"先保存"。草稿本身种不进假
  // 钩子（它的初值是 `undefined`，只有 `null` 与 `''` 能被种），但"刚敲了密码还没保存"同样是脏的
  // ——密码框正好是这条渲染路径上第一个 `useState('')`，用它把表单弄脏。
  const edited = render({ strings: ['s3cret'] })
  assert.ok(edited.text.some((item) => item === 'sync.test.dirty'), '有草稿时那句改成"先保存"')
  assert.equal(edited.text.includes('sync.test.hint'), false, '脏的时候不再说"只读探测"')
  const editedButton = edited.mounted.recorded.find(
    (node) => node.type === 'button' && node.props?.children === 'sync.test.action',
  )
  assert.equal(editedButton.props.disabled, true, '测的是已保存的配置：有草稿就先别测')

  // 点一下按钮：打的是 `/sync?mode=test`（端点写错的话这一条会红——结论行本身是宿主回的，测不到它）。
  const calls = []
  const clicked = render({
    fetch: async (url) => {
      calls.push(String(url))
      return { ok: true, status: 200, text: async () => JSON.stringify({ mode: 'test', code: 'ok' }) }
    },
  })
  const clickable = clicked.mounted.recorded.find(
    (node) => node.type === 'button' && node.props?.children === 'sync.test.action',
  )
  clickable.props.onClick()
  await Promise.resolve()
  assert.deepEqual(calls, ['/dsh-session-manager/api/sync?mode=test'], '按钮打的就是那个只读探测端点')

  const unreachable = outcomeOf({
    mode: 'test',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    code: 'unreachable',
    status: 0,
    namespaceExists: false,
    machines: [],
    entries: 0,
    detail: 'fetch failed',
    username: null,
    hasPassword: false,
  })
  assert.ok(
    unreachable.text.some((item) => item === 'sync.test.unreachable:{"detail":"fetch failed"}'),
    '连不上时把原始原因原样带出来',
  )
})

test('客户端产物：同步预演三张表的状态列只放短标签，整句解释挂在 title 上', { skip }, () => {
  // 两次真实事故（都是用户截图报的）：一是动作列沿用导入预演那 60px，而它装的是「本机有、远端没有」
  // 这种短语（实测 110px，en 158px），nowrap 直接画到后面那一列的会话名上；二是「这次不动」那一段
  // 把状态与会话名拼成同一句同色同号的文字（原来的 `syncNote`），三行读下来分不出哪个是状态、哪个
  // 是会话。现在三张表一个口径：状态列放短标签、会话单独一列，整句留在 title 里；列宽与兜底规则在
  // styles.ts（由 test/styles.test.mjs 钉住）。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 0 },
    sessions: [],
    workspaces: [{ id: 'w1', path: '/home/u/dev/x', title: '测试项目', sessionIds: [] }],
  }
  const response = {
    mode: 'plan',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    plan: {
      ok: true,
      problems: [],
      pull: [
        {
          id: 'session-a',
          machine: 'robot-b',
          bytes: 100,
          action: 'create',
          code: 'missing',
          fromCwd: '/home/b/dev/x',
          toCwd: '/home/u/dev/x',
        },
      ],
      push: [
        { id: 'session-b', bytes: 200, action: 'upload', code: 'missing', cwd: '/home/u/dev/x' },
        { id: 'session-c', bytes: 300, action: 'update', code: 'local-ahead', cwd: '/home/u/dev/x' },
        { id: 'session-d', bytes: 400, action: 'skip', code: 'diverged', machine: 'robot-b', cwd: '/home/u/dev/x' },
      ],
      pullIds: ['session-a'],
      pushIds: ['session-b', 'session-c'],
      bytesIn: 100,
      bytesOut: 500,
      localCount: 4,
      remoteCount: 1,
      machines: ['robot-b'],
    },
    applied: false,
    pulled: [],
    pushed: [],
    bytesIn: 0,
    bytesOut: 0,
    registryWritten: false,
    indexWritten: false,
    problems: [],
    takesEffect: 'immediate',
  }
  // 顺序：骨架的错误 → 同步页的 sync（那份计划）→ 弹窗开关（种成 'plan'，计划表只在弹窗里画）。
  const mounted = mount({ state, panel: 'sync', nulls: [null, response, 'plan'] })
  const tree = mounted.registrations[0].component(mounted.registrations[0].registration.inject())
  const text = strings(tree)

  // 两张表都带上"同步预演"这个变体类：列宽由它自己那条规则给（styles.ts 的 .dsm-syncPlanTable）。
  const tables = mounted.recorded.filter((node) => node.type === 'table')
  assert.equal(
    tables.filter((node) => String(node.props?.className).includes('dsm-syncPlanTable')).length,
    3,
    '拉取与推送那两张表、还有「这次不动」那张表都要带变体类，否则列宽还是导入预演那 60px',
  )
  assert.ok(
    tables.some((node) => String(node.props?.className).includes('dsm-keptTable')),
    '「这次不动」也是一张表（状态一列、会话一列、远端机器一列），不是一整行说明',
  )
  const keptHeaders = mounted.recorded
    .filter((node) => node.type === 'th' && node.props?.children === 'table.machine')
    .length
  assert.equal(keptHeaders, 1, '那张表的第三列表头是「远端机器」')
  // 分组之后路径只在组头说一次：三张表里都不该再有 cwd 列（这一页上也没有别的表会用到它）。
  assert.equal(
    mounted.recorded.filter((node) => node.type === 'th' && node.props?.className === 'dsm-colCwd').length,
    0,
    '同步预演的表里不再有 cwd 列——路径去组头了',
  )

  // 三段的段头是 `h3.dsm-planHead`（标题 + 条数药丸），不再是与正文同档的一行 `.dsm-hint`——"三段之间
  // 看不出分界"就是从那儿来的（用户报的）。结构差别得在产物里钉住，不然改样式时很容易又退回 `p`。
  const heads = mounted.recorded.filter((node) => node.type === 'h3' && node.props?.className === 'dsm-planHead')
  assert.equal(heads.length, 3, '会拉取 / 会推送 / 两边都有、这次不动 各一个段头')
  assert.deepEqual(
    heads.map((node) => strings(node)[0]),
    ['sync.pullHead', 'sync.pushHead', 'sync.keptHead'],
    '段头只放标题，条数由药丸说',
  )
  assert.deepEqual(
    heads.map((node) => strings(node).at(-1)),
    ['list.sessionsInDir:{"count":1}', 'list.sessionsInDir:{"count":2}', 'list.sessionsInDir:{"count":1}'],
    '药丸里的条数与会话列表同一句（list.sessionsInDir），数是这一段真正会做的条数',
  )
  assert.equal(
    mounted.recorded.some(
      (node) =>
        node.type === 'p' &&
        ['sync.pullHead', 'sync.pushHead', 'sync.keptHead'].includes(String(node.props?.children)),
    ),
    false,
    '段头不再是 .dsm-hint 那一行（那正是"和正文分不出"的写法）',
  )

  // 动作列：看得见的是动词，整句在 title 里。
  const tagOf = (visible, title) =>
    mounted.recorded.find((node) => node.props?.children === visible && node.props?.title === title)
  assert.ok(tagOf('sync.tag.pull', 'sync.why.missingPull'), '拉取那张表的标签是「拉取」，整句在 title 上')
  assert.ok(tagOf('sync.tag.push', 'sync.why.missingPush'), '推表新推的那颗是「推送」')
  assert.ok(tagOf('sync.tag.repush', 'sync.why.localAhead'), '本机领先的那颗是「重推刷新」')
  assert.ok(
    mounted.recorded.some(
      (node) => node.props?.children === 'sync.tag.diverged' && String(node.props?.title).startsWith('sync.why.diverged'),
    ),
    '「这次不动」那颗是「两边各自写过」，整句（带机器名）在 title 上',
  )

  // 整句不许再当可见文字（它会把邻居那一列压掉；挤在同一句里还会让状态与会话名分不出来）。
  assert.equal(text.includes('sync.why.missingPush'), false, '动作列不再放整句')
  assert.equal(text.includes('sync.why.missingPull'), false)
  assert.equal(text.includes('sync.why.diverged'), false, '「这次不动」也不再整句可见')
  assert.equal(
    text.some((item) => String(item).includes('sync.why.diverged') && String(item).includes('session-d')),
    false,
    '状态与会话名不许挤在同一个文本节点里——那正是分不出两者的原因',
  )
  assert.ok(text.includes('session-d'), '会话名照旧是那一行看得见的文字')

  // 计划还没回来的那一段：弹窗开着、正文是"预演中…"，确认禁用（别让上一次那份计划冒充这一次的）。
  const waiting = mount({ state, panel: 'sync', nulls: [null, response, 'plan', 'plan'] })
  const waitingRecorded = waiting.recorded
  const waitingText = strings(waiting.registrations[0].component(waiting.registrations[0].registration.inject()))
  assert.ok(waitingText.includes('dialog.previewing'), '计划在路上时正文是"预演中…"')
  assert.equal(
    waitingText.some((item) => String(item).startsWith('sync.summary')),
    false,
    '计划路上的那一段不摆旧计划（上次那份的表会被当成这次的）',
  )
  assert.equal(
    primaryOf(waitingRecorded).props.disabled,
    true,
    '计划没到手时确认按钮禁用——这一条靠 ConfirmDialog 的 planning，同步页不给 disabled',
  )
})

test('客户端产物：会拉取那张表分得清「拉一条新的」与「覆盖本机那份」；空白会话只在正文里报一句', { skip }, () => {
  /*
   * 两条新口径都要在界面上看得出来：
   *   - 「会拉取」里现在混着两种事：从无到有拉一条（本机没有它）与**覆盖本机那份**（本机有，但它更
   *     新）。两者都往本机落内容，但后者会把本机已有的东西换掉，所以标签得分开，整句挂在 title 上；
   *   - 空白会话没有内容可同步，逐条列出来只是把三张表撑长：只在正文里报一句条数。
   * 顺带钉住"旧宿主回的响应里没有 blank 这个字段"也不许把渲染弄崩。
   */
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 0 },
    sessions: [],
    workspaces: [{ id: 'w1', path: '/home/u/dev/x', title: '测试项目', sessionIds: [] }],
  }
  const response = {
    mode: 'plan',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    plan: {
      ok: true,
      problems: [],
      pull: [
        {
          id: 'session-new',
          machine: 'robot-b',
          bytes: 100,
          action: 'create',
          code: 'missing',
          fromCwd: '/home/b/dev/x',
          toCwd: '/home/u/dev/x',
        },
        {
          id: 'session-replace',
          machine: 'robot-b',
          bytes: 200,
          action: 'replace',
          code: 'remote-newer',
          fromCwd: '/home/b/dev/x',
          toCwd: '/home/u/dev/x',
        },
      ],
      push: [
        { id: 'session-forked', bytes: 300, action: 'update', code: 'local-newer', machine: 'robot-b', cwd: '/home/u/dev/x' },
      ],
      blank: ['session-blank-1', 'session-blank-2'],
      pullIds: ['session-new', 'session-replace'],
      pushIds: ['session-forked'],
      bytesIn: 300,
      bytesOut: 300,
      localCount: 5,
      remoteCount: 3,
      machines: ['robot-b'],
    },
    applied: false,
    pulled: [],
    pushed: [],
    bytesIn: 0,
    bytesOut: 0,
    registryWritten: false,
    indexWritten: false,
    problems: [],
    takesEffect: 'immediate',
  }
  const mounted = mount({ state, panel: 'sync', nulls: [null, response, 'plan'] })
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  const tagOf = (visible, title) =>
    mounted.recorded.find((node) => node.props?.children === visible && node.props?.title === title)

  assert.ok(tagOf('sync.tag.pull', 'sync.why.missingPull'), '从无到有那条照旧是「拉取」')
  // 覆盖本机那份：标签说的是动作，title 说清"谁更新、会拿谁换掉本机这份"。
  assert.ok(tagOf('sync.tag.replace', 'sync.why.replaceNewer'), '覆盖那条挂「覆盖本机」+ 它自己那句整句')
  assert.ok(tagOf('sync.tag.localNewer', 'sync.why.localNewer'), '分叉里本机更晚那条是「分叉重推」')
  assert.equal(
    mounted.recorded.some(
      (node) => node.props?.children === 'sync.tag.replace' && node.props?.title === 'sync.why.replaceAhead',
    ),
    false,
    '两条覆盖行的整句按各自的码走（这里这条说的是"两边各自写过"）',
  )
  assert.ok(text.includes('session-replace'), '覆盖那条也在「会拉取」那张表里（它同样是往本机落内容）')
  assert.ok(text.includes('sync.pullHead'), '「会拉取」那个段头在')
  assert.ok(
    text.includes('list.sessionsInDir:{"count":2}'),
    '段头药丸里那张表的条数把覆盖那条算进去',
  )
  assert.ok(text.includes('sync.pushHead'), '「会推送」那个段头在')
  assert.ok(
    text.includes('list.sessionsInDir:{"count":1}'),
    '覆盖不是推送：段头药丸里推表只有分叉重推那一条',
  )

  // 空白会话：只在正文里报一句，id 一个都不许冒出来（那三张表里也不许有它们）。
  const blankLine = mounted.recorded.find(
    (node) => node.type === 'p' && node.props?.children === 'sync.skippedBlank:{"count":2}',
  )
  assert.ok(blankLine !== undefined, '正文里那句"跳过 N 条空白会话"在')
  assert.equal(
    text.some((item) => String(item).includes('session-blank')),
    false,
    '空白会话逐条列出来只会把表撑长',
  )

  // 旧宿主（响应里没有 blank 这个字段）也要能画：缺字段按"一条都没有"处理，不是当场崩。
  const legacy = mount({
    state,
    panel: 'sync',
    nulls: [null, { ...response, plan: { ...response.plan, blank: undefined } }, 'plan'],
  })
  const legacyText = strings(legacy.registrations[0].component(legacy.registrations[0].registration.inject()))
  assert.equal(
    legacyText.some((item) => String(item).startsWith('sync.skippedBlank')),
    false,
    '没有 blank 字段就不画那一句',
  )
  assert.ok(legacyText.includes('sync.pullHead'), '其余照旧画出来')
})

test('客户端产物：同步三张表挂会话列表那套类型标签（本机没有那条就不挂）', { skip }, () => {
  /*
   * 计划行只带 id、标题与体积，类型（空白 / 子智能体 / 已归档 / 活着的）得从 `/state` 那份会话清单取。
   * 判据与会话列表**同一套**（`sessionTags()` → `sessionFilter.hasAttribute()`），标签键与说明键也
   * 是同一套——两处各算一份的话，同一条会话在两个页面上会被挂上不同的标签。
   *
   * 「会拉取」里新建的那些本机还没有，挂不出类型（那是"还没落到本机"，不是"它什么类型都不是"）。
   */
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 0 },
    sessions: [
      {
        id: 'session-forked',
        title: '分叉那条',
        cwd: '/home/u/dev/x',
        createdAt: 1,
        dir: '/home/u/.dsh/sessions/x/session-forked',
        bytes: 300,
        files: [],
        origin: 'subagent',
        parentSession: 'session-a',
      },
      {
        id: 'session-replace',
        title: '本机这条',
        cwd: '/home/u/dev/x',
        createdAt: 2,
        dir: '/home/u/.dsh/sessions/x/session-replace',
        bytes: 200,
        files: [],
        archived: true,
        live: true,
        // 宿主说它"会显示、但谁都没认领"。计划表**不**挂这枚标签（组头已经写着它属于哪个目录）。
        ungrouped: true,
      },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/x', title: '测试项目', sessionIds: [] }],
  }
  const response = {
    mode: 'plan',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    plan: {
      ok: true,
      problems: [],
      pull: [
        {
          id: 'session-replace',
          machine: 'robot-b',
          bytes: 200,
          action: 'replace',
          code: 'remote-newer',
          fromCwd: '/home/b/dev/x',
          toCwd: '/home/u/dev/x',
        },
        {
          id: 'session-new',
          machine: 'robot-b',
          bytes: 100,
          action: 'create',
          code: 'missing',
          fromCwd: '/home/b/dev/x',
          toCwd: '/home/u/dev/x',
        },
      ],
      push: [
        { id: 'session-forked', bytes: 300, action: 'update', code: 'local-newer', machine: 'robot-b', cwd: '/home/u/dev/x' },
      ],
      blank: [],
      pullIds: ['session-replace', 'session-new'],
      pushIds: ['session-forked'],
      bytesIn: 300,
      bytesOut: 300,
      localCount: 2,
      remoteCount: 2,
      machines: ['robot-b'],
    },
    applied: false,
    pulled: [],
    replaced: [],
    pushed: [],
    bytesIn: 0,
    bytesOut: 0,
    registryWritten: false,
    indexWritten: false,
    problems: [],
    takesEffect: 'immediate',
  }
  const mounted = mount({ state, panel: 'sync', nulls: [null, response, 'plan'] })
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))

  // 与会话列表同一套键与同一套说明（`ATTRIBUTE_TAGS`），文案本身由字典给。
  assert.ok(text.includes('tag.subagent'), '子智能体那条挂「子智能体」')
  assert.ok(text.includes('tag.archived'), '已归档那条挂「已归档」')
  assert.ok(text.includes('tag.live'), '活着的会话也标出来（覆盖它得先关掉，理由在那一刻才讲清）')
  assert.ok(
    mounted.recorded.some((node) => node.props?.children === 'tag.live' && node.props?.title === 'tag.liveTip'),
    '标签的说明挂在 title 上（与会话列表同一套）',
  )
  // 一条会话能挂几枚挂几枚（已归档 + 活着的两条都真）：本机那两条一共三枚标签，**新建那条一枚都没有**。
  const typeTags = ['tag.subagent', 'tag.blank', 'tag.archived', 'tag.live']
  assert.deepEqual(
    text.filter((item) => typeTags.includes(item)).sort(),
    ['tag.archived', 'tag.live', 'tag.subagent'],
    '只有本机已有的那两条挂得上类型：「会拉取」里新建的那条本机还没有',
  )
  // 「未分组」不在计划表里挂：组头已经写着这条属于哪个目录。
  assert.equal(text.includes('list.ungrouped'), false, '计划表不重复挂「未分组」')
  // 类型标签与名字同占一格（会话列表那套 `.dsm-rowLabel` 排布）。
  assert.ok(
    mounted.recorded.some((node) => String(node.props?.className) === 'dsm-rowLabel'),
    '名字与标签同占一格',
  )
})

test('客户端产物：同步预演三张表按项目分组，路径只在组头上说一次', { skip }, () => {
  // 为什么分组：一次整库同步的计划里同一个目录会连着出现十几条，逐行印一遍同样的路径只是把人绕进去，
  // 还从会话名那一列扣宽度。分组键的规则在 src/client/logic/syncGroups.ts（test/syncGroups.test.ts 逐条钉
  // 着），这里只管"组画出来没有、路径是不是只出现在组头、行里还剩下什么"。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 1 },
    sessions: [],
    // 注册表顺序刻意是 beta 在前：组的次序跟着它走（与列表那边同一套），不是按路径排序。
    workspaces: [
      { id: 'w2', path: '/home/u/dev/beta', title: '测试项目', sessionIds: [] },
      { id: 'w1', path: '/home/u/dev/alpha', title: '会话管理', sessionIds: [] },
    ],
    // 只给 beta 一个身份：alpha 那一组照旧显示本机路径，两边的画法在同一个用例里对照着看。
    repos: { '/home/u/dev/beta': 'github.com/he0119/beta' },
  }
  const response = {
    mode: 'plan',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    plan: {
      ok: true,
      problems: [],
      pull: [
        { id: 'session-5', machine: 'robot-b', bytes: 100, action: 'create', code: 'missing', fromCwd: '/home/b/dev/x', toCwd: '/home/u/dev/beta' },
        { id: 'session-6', machine: 'robot-b', bytes: 100, action: 'create', code: 'missing', fromCwd: '/home/b/dev/alpha', toCwd: '/home/u/dev/alpha' },
        // 远端那条会话本来就没有 cwd：它落 _no-cwd，归"没有 cwd"那一组。
        { id: 'session-7', machine: 'robot-b', bytes: 100, action: 'create', code: 'missing' },
        // 没动的那两类：缺映射（本机没有那个项目，组头给远端路径）、目标目录不存在（本机路径）。
        { id: 'session-8', machine: 'robot-map', bytes: 100, action: 'skip', code: 'no-mapping', fromCwd: '/home/b/dev/zzz' },
        { id: 'session-9', machine: 'robot-b', bytes: 100, action: 'skip', code: 'missing-target', fromCwd: '/home/b/dev/w', toCwd: '/home/u/dev/gone' },
      ],
      push: [
        { id: 'session-1', bytes: 200, action: 'upload', code: 'missing', cwd: '/home/u/dev/alpha' },
        { id: 'session-2', bytes: 200, action: 'upload', code: 'missing', cwd: '/home/u/dev/beta' },
        // 本机这条也没有 cwd：同样归"没有 cwd"那一组（推的那一侧）。
        { id: 'session-3', bytes: 200, action: 'upload', code: 'missing' },
        { id: 'session-4', bytes: 200, action: 'upload', code: 'missing', cwd: '/home/u/dev/alpha' },
        { id: 'session-10', bytes: 200, action: 'skip', code: 'remote-ahead', machine: 'robot-c', cwd: '/home/u/dev/alpha' },
      ],
      pullIds: ['session-5', 'session-6', 'session-7'],
      pushIds: ['session-1', 'session-2', 'session-3', 'session-4'],
      bytesIn: 300,
      bytesOut: 800,
      localCount: 4,
      remoteCount: 3,
      machines: ['robot-b', 'robot-c'],
    },
    applied: false,
    pulled: [],
    pushed: [],
    bytesIn: 0,
    bytesOut: 0,
    registryWritten: false,
    indexWritten: false,
    problems: [],
    takesEffect: 'immediate',
  }
  const mounted = mount({ state, panel: 'sync', nulls: [null, response, 'plan'] })
  const tree = mounted.registrations[0].component(mounted.registrations[0].registration.inject())
  const text = strings(tree)

  // 每个项目一条组头（横跨整行的 th），三张表各自成组：拉取 3 组（beta / alpha / 没有 cwd）、
  // 推送 3 组、没动 3 组（alpha / 远端 zzz / 本机 gone）。
  const heads = mounted.recorded.filter((node) => String(node.props?.className) === 'dsm-planGroupHead')
  assert.equal(heads.length, 9, '三张表各自按项目分组，一共 9 条组头')
  assert.ok(
    heads.every((head) => head.type === 'th' && head.props?.scope === 'colgroup' && Number(head.props?.colSpan) >= 2),
    '组头是一行跨列的 th（不是普通 <td>，读屏要能听出它领着一个列组）',
  )
  const headText = heads.map((head) => strings(head))
  const headOf = (index) => headText[index] ?? []
  // 组头只摆名字（与列表那边同一份称呼规则）：这一组有身份，身份与本机路径都在名字那一格的悬浮提示里。
  assert.deepEqual(
    headOf(0).filter((item) => item === '测试项目' || item === 'github.com/he0119/beta'),
    ['测试项目'],
    '有项目身份的工作区：组头只有标题，身份不进可见文字',
  )
  assert.ok(
    mounted.recorded.some(
      (node) => String(node.props?.className) === 'dsm-groupTitle' && node.props?.title === 'github.com/he0119/beta\n/home/u/dev/beta',
    ),
    '身份与本机路径都在那一格的悬浮提示里（同一个仓库的两个克隆靠路径区分）',
  )
  assert.ok(
    mounted.recorded.some(
      (node) => String(node.props?.className) === 'dsm-tag dsm-tagIdle' && node.props?.title === 'github.com/he0119/beta',
    ),
    '弹窗里也挂同一枚主机标签（标签自己的提示给全整条身份）',
  )
  assert.deepEqual(
    headOf(1).filter((item) => item === '会话管理' || item === '/home/u/dev/alpha'),
    ['会话管理'],
    '没有身份的目录也只剩标题——路径同样退到悬浮提示里',
  )
  assert.ok(
    mounted.recorded.some(
      (node) => String(node.props?.className) === 'dsm-groupTitle' && node.props?.title === '/home/u/dev/alpha',
    ),
    '没有身份时悬浮提示给的就是本机路径',
  )
  assert.ok(headOf(2).includes('list.noCwdGroup'), '没有 cwd 的那一组照旧自成一组建在最后')
  assert.ok(
    text.includes('list.sessionsInDir:{"count":2}'),
    '组头报这一组几条（alpha 在推送那张表里两条），与列表那边的说法同一句',
  )

  // 组内保持计划给的顺序（不重排）：推送那张表里 alpha 那一组是 session-1、session-4。
  const rowIds = mounted.recorded
    .filter((node) => String(node.props?.className) === 'dsm-rowId')
    .map((node) => node.props?.children)
  assert.deepEqual(
    rowIds,
    ['session-5', 'session-6', 'session-7', 'session-2', 'session-1', 'session-4', 'session-3', 'session-10', 'session-8', 'session-9'],
    '拉取那张表按落地目录分组、推送那张表按本机目录分组、没动按各自那一边分组；组内顺序就是计划给的顺序',
  )

  // 路径只在组头：拉取行的来源路径不许再当可见文字，它退到那一行的悬浮提示里（只有真的改写过才补）。
  assert.equal(text.includes('/home/b/dev/x'), false, '来源路径不再逐行印一遍')
  const tips = mounted.recorded
    .filter((node) => String(node.props?.className) === 'dsm-rowId')
    .map((node) => String(node.props?.title))
  assert.equal(
    tips[0],
    'session-5\ncwd.rewritten:{"from":"/home/b/dev/x","to":"/home/u/dev/beta"}',
    '改写过的拉取行在悬浮提示里说清从哪到哪',
  )
  assert.equal(tips[2], 'session-7', '本来就没有 cwd 的会话没有可改写的来源，提示就只是会话名与 id')
  assert.equal(tips[5], 'session-4', '推送行不补改写（它本来就落在这个项目里）')

  // 缺映射那一组：组头给的是**远端**那条路径（本机根本没有那个项目），行里只剩状态、会话名与机器名。
  assert.deepEqual(
    headOf(7).filter((item) => item === '/home/b/dev/zzz'),
    ['/home/b/dev/zzz'],
    '缺映射的组头是远端路径——那正是要补的那条映射',
  )
  assert.ok(
    mounted.recorded.some((node) => node.props?.children === 'robot-map' && String(node.props?.className) === 'dsm-cwd'),
    '「没动」的第三列放远端机器——缺映射那一行以前在这儿印的是那条路径',
  )
  assert.equal(
    text.filter((item) => item === '/home/b/dev/zzz').length,
    1,
    '那条远端路径只在组头上出现一次（行里不再重复它）',
  )
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
  assert.ok(syncText.includes('sync.title'), '「同步」分页上要有同步卡片')
  assert.ok(syncText.includes('sync.action'), '且带着同步按钮（配置在，按钮就在）')
  assert.ok(!transferText.includes('sync.title'), '传输页上不该再有同步卡片')
  assert.ok(!transferText.includes('sync.action'), '传输页上不该再有同步按钮')
})

// ---- 确认弹窗：一个动作一个入口 ----
//
// 这次改动把"先点预演、看页面上的结果、再点确认"换成了"点动作 → 弹窗里看清单 → 确认或取消"。
// 下面几条钉住三件事：① 每个会写盘的动作只有一个入口（页面上不再有独立的预演按钮）；② 弹窗里摆的
// 是宿主那份计划（清单、问题、备份位置），主按钮在计划不 ok 时真的禁用；③ 级联进来的行有出处标签。

/** 页面上开着的那几个弹窗（官方 `Modal` 渲染出来的 `role="dialog"` 元素，标题在 `aria-label` 上）。 */
function dialogsOf(recorded) {
  return recorded.filter((node) => node.props?.role === 'dialog')
}

/** 弹窗里的主按钮（footer 里带 `dsm-primary` 的那个）。 */
function primaryOf(recorded) {
  return elementsOf(recorded.find((node) => String(node.props?.className) === 'dsm-fakeDialogFooter')).find(
    (node) => node.type === 'button' && String(node.props?.className).includes('dsm-primary'),
  )
}

/** 弹窗里的取消按钮。 */
function cancelOf(recorded) {
  return elementsOf(recorded.find((node) => String(node.props?.className) === 'dsm-fakeDialogFooter')).find(
    (node) => node.type === 'button' && !String(node.props?.className).includes('dsm-primary'),
  )
}

test('客户端产物：会写盘的四个动作各自只有一个入口，预演不占页面按钮', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 1 },
    sessions: [{ id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 1, dir: '/home/u/dev/alpha', bytes: 1, files: [] }],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const panelText = (panel) => {
    const mounted = mount({ state, panel })
    return strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  }
  const manage = panelText('manage')
  const transfer = panelText('transfer')
  const migrate = panelText('migrate')
  const sync = panelText('sync')

  // 页面上只剩"那个动作"本身；`dialog.previewing`（"预演中…"）只该出现在开着的弹窗里，页面上一律没有。
  for (const text of [manage, transfer, migrate, sync]) {
    assert.equal(text.includes('dialog.previewing'), false, '关着弹窗时页面上不该有"预演中…"')
  }
  assert.ok(manage.includes('manage.delete.action'), '「会话」页的写入口是「删除所选」')
  assert.ok(transfer.includes('transfer.import.action'), '传输页的写入口是「导入」（导出不问）')
  assert.ok(migrate.includes('migrate.action'), '迁移页的写入口是「迁移」')
  assert.ok(sync.includes('sync.action'), '同步页的写入口是「同步」')
})

test('客户端产物：删除弹窗摆出清单与备份位置，计划不 ok 时确认按钮禁用', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [
      { id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 2048, files: [] },
      { id: 's-9', cwd: '/home/u/dev/alpha', createdAt: 4, dir: '/home/u/dev/alpha', bytes: 1024, files: [], origin: 'subagent', hidden: 'subagent', parentSession: 's-1' },
    ],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const planOf = (ok) => ({
    mode: 'plan',
    ok,
    preview: {
      ok,
      problems: ok ? [] : ['s-9 还活在宿主内存里'],
      entries: [
        { id: 's-1', createdAt: 5, dir: '/home/u/.dsh/sessions/alpha/s-1', files: [], bytes: 2048, live: false },
        { id: 's-9', createdAt: 4, dir: '/home/u/.dsh/sessions/alpha/s-9', files: [], bytes: 1024, live: true, via: { id: 's-1' } },
      ],
      files: 0,
      bytes: 3072,
      backupRoot: '/home/u/.dsh/dsh-session-manager/backups',
    },
    applied: false,
    dirsRemoved: 0,
    removedProjectDirs: [],
    verified: false,
    // 计划不 ok 时宿主把 plan.problems 提到顶层（见 web.ts 的删除端点），界面读的就是这一份。
    problems: ok ? [] : ['s-9 还活在宿主内存里'],
    summary: '将删除 2 条会话',
    takesEffect: 'restart-required',
  })
  // null 顺序：骨架的 error / 会话页的 busy / error / notice / **pending**（勾选集由 arrays 种）。
  const mounted = (ok) =>
    mount({ state, panel: 'manage', arrays: [['s-1']], nulls: [null, null, null, null, { plan: planOf(ok), error: null }] })
  const render = (ok) => {
    const item = mounted(ok)
    return { recorded: item.recorded, text: strings(item.registrations[0].component(item.registrations[0].registration.inject())) }
  }

  const good = render(true)
  const dialogs = good.recorded.filter((node) => node.props?.role === 'dialog')
  assert.equal(dialogs.length, 1, '点删除之后页面上只有一个弹窗')
  assert.equal(dialogs[0].props['aria-label'], 'manage.delete.dialogTitle', '标题说的是那个动作')
  assert.ok(good.text.some((item) => String(item) === '将删除 2 条会话'), '弹窗里摆的是宿主给的那份摘要')
  const rows = good.recorded.filter(
    (node) => typeof node.type === 'string' && String(node.props?.className).includes('dsm-rowPlan'),
  )
  assert.deepEqual(rows.map((row) => rowParts(row).label), ['s-1', 's-9'], '清单逐条列出会被删的会话')
  assert.deepEqual(rowParts(rows[1]).tags, ['manage.delete.via'], '级联进来的挂「随父删」')
  assert.equal(primaryOf(good.recorded).props.disabled, false, '计划 ok 时确认可用')
  assert.ok(strings(cancelOf(good.recorded)).includes('cancel'), '旁边是「取消」')
  assert.ok(
    good.text.some((item) => String(item).startsWith('manage.delete.backupTo') && String(item).includes('dsh-session-manager/backups')),
    '备份落在哪要写在弹窗里（要恢复时知道去哪找）',
  )

  const bad = render(false)
  assert.ok(bad.text.some((item) => String(item) === 's-9 还活在宿主内存里'), '计划里的问题清单照旧摆出来')
  assert.equal(primaryOf(bad.recorded).props.disabled, true, '计划不 ok 时确认按钮禁用（不能一边报问题一边让删）')

  // 计划还没回来那一段（弹窗已经被点开、宿主还没答）：正文是"预演中…"，确认同样禁用——这一格不能
  // 出现"清单还没到手就能按确认"的窗口。
  const waiting = mount({
    state,
    panel: 'manage',
    arrays: [['s-1']],
    nulls: [null, null, null, null, { plan: null, error: null }],
  })
  const waitingRecorded = waiting.recorded
  const waitingText = strings(waiting.registrations[0].component(waiting.registrations[0].registration.inject()))
  assert.ok(waitingText.includes('dialog.previewing'), '计划在路上时正文是"预演中…"')
  assert.equal(primaryOf(waitingRecorded).props.disabled, true, '计划没到手时确认按钮禁用')
})

test('客户端产物：导入弹窗里摆的是那张预演表，全是跳过时确认按钮禁用', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [],
    workspaces: [{ id: 'w1', path: '/home/u/dev/beta', title: '工作区乙', sessionIds: [] }],
  }
  const planOf = (action) => ({
    mode: 'plan',
    ok: true,
    problems: [],
    entries: [
      { id: 's-1', action, dir: '/home/u/.dsh/sessions/beta/s-1', fromCwd: '/home/u/dev/alpha', toCwd: '/home/u/dev/beta', files: [{ name: 'a.log', bytes: 10 }] },
    ],
    created: [],
    rehomed: [],
    bytes: 10,
  })
  // null 顺序：骨架的 error / 传输页的 file / payload / **pending**（第一个空串是导入目标，第二个是搜索词）。
  const mounted = (action) =>
    mount({
      state,
      panel: 'transfer',
      strings: ['', '/home/u/dev/beta'],
      nulls: [null, null, null, { plan: planOf(action), error: null }],
    })
  const render = (action) => {
    const item = mounted(action)
    return { recorded: item.recorded, text: strings(item.registrations[0].component(item.registrations[0].registration.inject())) }
  }

  const create = render('create')
  const table = create.recorded.find(
    (node) => node.type === 'table' && String(node.props?.className).includes('dsm-planTable'),
  )
  assert.ok(table !== undefined, '弹窗里是那张导入计划表（列宽规则也挂在它身上）')
  assert.ok(create.text.some((item) => String(item).startsWith('transfer.import.planSummary')), '表头那句话照旧在')
  assert.equal(primaryOf(create.recorded).props.children, 'transfer.import.apply', '确认按钮走「确认导入」那一条')
  assert.equal(primaryOf(create.recorded).props.disabled, false, '有会创建的条目时确认可用')

  const skip = render('skip')
  assert.ok(
    skip.recorded.some((node) => node.type === 'table'),
    '全是跳过时表还在（要看得到"为什么跳过"）',
  )
  assert.equal(primaryOf(skip.recorded).props.disabled, true, '一条都不会创建时确认按钮禁用')
})

test('客户端产物：回滚弹窗先摆动作清单再确认（清单就是那次真实写入的形状）', { skip }, () => {
  const backup = {
    dir: '/home/u/.dsh/dsh-session-manager/backups/2026-10-03T08-00-00',
    createdAt: '2026-10-03T08:00:00.000Z',
    sessions: 2,
    artifacts: 0,
    kind: 'migrate',
    from: '/home/u/dev/alpha',
    to: '/home/u/dev/beta',
  }
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [],
    workspaces: [],
  }
  // null 顺序：骨架的 error / 备份页的 error / notice / busy / **dialog**（备份清单由第一个数组种）。
  const item = mount({
    state,
    panel: 'backup',
    arrays: [[backup]],
    nulls: [
      null, null, null, null,
      {
        backup,
        plan: {
          mode: 'plan',
          dryRun: true,
          actions: ['把 s-1 搬回 /home/u/dev/alpha', '还原注册表'],
          restoredFiles: 0,
          restoredArtifacts: 0,
          registryRestored: false,
          backupDir: backup.dir,
          createdAt: backup.createdAt,
          sessions: 2,
          artifacts: 0,
          takesEffect: 'restart-required',
        },
        error: null,
      },
    ],
  })
  const text = strings(item.registrations[0].component(item.registrations[0].registration.inject()))
  const dialogs = item.recorded.filter((node) => node.props?.role === 'dialog')
  assert.equal(dialogs.length, 1, '点「回滚」只开一个弹窗（不再有"看回滚动作"那一步）')
  assert.equal(dialogs[0].props['aria-label'], 'backup.rollback.dialogTitle', '标题说的是那个动作')
  assert.ok(text.some((item) => String(item).startsWith('backup.rollback.actions')), '那句"以下是回滚会做的 N 个动作"照旧在')
  assert.ok(text.some((item) => String(item) === '把 s-1 搬回 /home/u/dev/alpha'), '动作清单逐条摆出来')
  assert.deepEqual(
    strings(cancelOf(item.recorded)).concat(strings(primaryOf(item.recorded))),
    ['cancel', 'backup.rollback.confirm'],
    '底部是「取消 / 确认回滚」',
  )
})

test('客户端产物：备份清单认三种来源——迁移/删除/覆盖前，后两种点「恢复」', { skip }, () => {
  // 同步把本机那份换掉之前也要备份（`kind: 'replace'`）。它与删除留下的那份**行为一样**（搬回目录、
  // 注册表照旧），但与迁移那份不同（迁移要连注册表一起还原）。清单里那颗标签与那个动作按钮都要跟着走，
  // 不然用户面对一份"同步覆盖前"的备份会以为按下去会把工作区登记也一起改回去。
  const backupOf = (kind, stamp) => ({
    dir: `/home/u/.dsh/dsh-session-manager/backups/${stamp}`,
    createdAt: `${stamp.slice(0, 10)}T08:00:00.000Z`,
    sessions: 1,
    artifacts: 0,
    kind,
  })
  const backups = [
    { ...backupOf('migrate', '2026-10-03T08-00-00'), from: '/home/u/dev/alpha', to: '/home/u/dev/beta' },
    backupOf('delete', '2026-10-04T08-00-00'),
    backupOf('replace', '2026-10-05T08-00-00'),
  ]
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [],
    workspaces: [],
  }
  const mounted = mount({ state, panel: 'backup', arrays: [backups] })
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  assert.ok(text.includes('backup.kind.migrate'), '迁移那份的标签照旧')
  assert.ok(text.includes('backup.kind.delete'), '删除那份的标签照旧')
  assert.ok(text.includes('backup.kind.replace'), '同步覆盖前那份要有自己的标签')
  const buttonLabels = mounted.recorded
    .filter((node) => node.type === 'button')
    .map((node) => node.props?.children)
  assert.equal(
    buttonLabels.filter((label) => label === 'backup.restore.action').length,
    2,
    '删除与覆盖前那两份都点「恢复」（只搬目录）',
  )
  assert.equal(
    buttonLabels.filter((label) => label === 'backup.rollback.action').length,
    1,
    '只有迁移那份点「回滚」（连注册表一起还原）',
  )

  // 弹窗里的措辞也跟着来源走：覆盖前那份开的是「恢复」那一套文案。
  const replacing = mount({
    state,
    panel: 'backup',
    arrays: [backups],
    nulls: [
      null, null, null, null,
      {
        backup: backups[2],
        plan: {
          mode: 'plan',
          dryRun: true,
          actions: ['把 s-1 搬回 /home/u/dev/x'],
          restoredFiles: 0,
          restoredArtifacts: 0,
          registryRestored: false,
          backupDir: backups[2].dir,
          createdAt: backups[2].createdAt,
          sessions: 1,
          artifacts: 0,
          takesEffect: 'immediate',
        },
        error: null,
      },
    ],
  })
  // 先把树走一遍（`recorded` 只有走过才填上），再找那个弹窗。
  strings(replacing.registrations[0].component(replacing.registrations[0].registration.inject()))
  const dialogs = replacing.recorded.filter((node) => node.props?.role === 'dialog')
  assert.equal(dialogs.length, 1)
  assert.equal(dialogs[0].props['aria-label'], 'backup.restore.dialogTitle', '覆盖前那份开的是「恢复」弹窗')
  assert.deepEqual(
    strings(cancelOf(replacing.recorded)).concat(strings(primaryOf(replacing.recorded))),
    ['cancel', 'backup.restore.confirm'],
    '底部是「取消 / 确认恢复」',
  )
})

// ---- 「要不要重启」怎么摆 ----
//
// 这一句曾经跟「已拉取 N 条…」拼成同一个字符串、画在**绿色**成功横幅里，于是"需要重启"与"不需要重启"
// 共用一块绿底，读的人分不出哪句是坏消息；文案本身也长到要分两行。现在的口径是：
//   - **只在坏消息时说话**：宿主自己接住时一个字都不说；
//   - 结论单独一条 warn 横幅，不跟绿色横幅同层；
//   - 真要重启时，预演弹窗里就提前说（判据由宿主随响应给，见 test/web.test.ts 与 src/web.ts）。

test('客户端产物：需要重启的结论单独一条 warn 横幅，预演弹窗里提前说，不需要重启时一句都不摆', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 0 },
    sessions: [],
    workspaces: [],
  }
  const entry = {
    id: 'session-a',
    machine: 'robot-b',
    bytes: 100,
    action: 'create',
    code: 'missing',
    fromCwd: '/home/b/dev/x',
    toCwd: '/home/u/dev/x',
  }
  const base = {
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    plan: {
      ok: true,
      problems: [],
      pull: [entry],
      push: [],
      pullIds: ['session-a'],
      pushIds: [],
      bytesIn: 100,
      bytesOut: 0,
      localCount: 0,
      remoteCount: 1,
      machines: ['robot-b'],
    },
    applied: false,
    pulled: [],
    pushed: [],
    bytesIn: 0,
    bytesOut: 0,
    registryWritten: false,
    indexWritten: false,
    problems: [],
  }
  /** 预演：库里什么都没有，`takesEffect` 说的是"执行时会不会需要重启"（宿主端口的探测）。 */
  const planned = (takesEffect) => ({ ...base, mode: 'plan', takesEffect })
  /** 落地：真的拉进来一条，`takesEffect` 说的是"刚才那次实际怎样"。 */
  const landed = (takesEffect) => ({
    ...base,
    mode: 'apply',
    applied: true,
    pulled: ['session-a'],
    plan: { ...base.plan, pull: [], pullIds: [] },
    registryWritten: true,
    takesEffect,
  })
  const render = (sync, dialog = null) => {
    const mounted = mount({ state, panel: 'sync', nulls: [null, sync, dialog] })
    return {
      mounted,
      text: strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject())),
    }
  }
  /** 画出某句文案的那个元素：要核"它长什么颜色"就得拿到元素本身，光看文字分不出横幅与段落。 */
  const nodeOf = (mounted, text) => mounted.recorded.find((node) => node.props?.children === text)

  // ① 预演：宿主那头需要重启时，正文里在「确认同步」之前先摆一句（弹窗开着 = 种成 'plan'）。
  const warned = render(planned('restart-required'), 'plan')
  assert.ok(warned.text.includes('effect.plannedRestart'), '预演里就要说"落地后需重启"')
  assert.equal(
    String(nodeOf(warned.mounted, 'effect.plannedRestart').props.className),
    'dsm-warn',
    '事前提示是警告色，不能跟"一切正常"共用一种颜色',
  )

  // 宿主自己接得住时不摆这一句——旧版在这里写"无需重启"，等于每次都说一句话。
  const calm = render(planned('immediate'), 'plan')
  assert.equal(calm.text.includes('effect.plannedRestart'), false, '不需要重启时不提前警告')

  // ② 落地：需要重启时结论单独一条 warn 横幅。
  const warnedLanded = render(landed('restart-required'))
  const banner = warnedLanded.mounted.recorded.find(
    (node) => String(node.props?.className) === 'dsm-banner dsm-warn',
  )
  assert.ok(banner !== undefined, '需要重启时有一条独立横幅')
  assert.deepEqual(banner.props.children, 'effect.restart', '横幅里就是那句短话')
  assert.equal(
    String(banner.props.className).includes('dsm-ok'),
    false,
    '它不许跟「已拉取 N 条…」那条绿色横幅同层：同一块绿底上分不出哪句是坏消息',
  )

  // 宿主自己接住时没有横幅：这一次改动已经生效，没有坏消息可说。
  const calmLanded = render(landed('immediate'))
  assert.equal(
    calmLanded.mounted.recorded.some((node) => node.props?.children === 'effect.restart'),
    false,
    '不需要重启时不摆结论（旧版那句"无需重启"只是噪音）',
  )
})

// ---- 同步的进度 ----
//
// 同步是这个插件里唯一"按条走网络"的长动作：整库同步可能是几百次往返、几十秒。宿主按条推事件
// （见 src/web.ts 的 sendEventStream），界面把弹窗正文换成进度条。下面两条分别钉住"进度怎么画"与
// "确认按钮真的接在那条事件流上"。

test('客户端产物：落地时弹窗正文换成进度条（第几条 / 共几条 + 当前那一条）', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 0 },
    sessions: [],
    workspaces: [],
  }
  const progressOf = (phase, done, total, label) => ({ phase, done, total, id: 's-1', label })
  // 顺序：骨架的错误 → 同步页的 sync / 弹窗开关 / busy / error / notice → **progress**（第 6 个
  // `useState(null)`）。`busy` 种成 'apply'：假钩子不会点按钮，落地那一段只能这样走进去。
  const mounted = mount({
    state,
    panel: 'sync',
    nulls: [null, null, 'apply', 'apply', null, null, progressOf('push', 12, 84, '会话九')],
  })
  const recorded = mounted.recorded
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))

  const bar = recorded.find((node) => String(node.props?.className) === 'dsm-progress')
  assert.ok(bar !== undefined, '进度条本体在弹窗正文里')
  assert.equal(bar.props['aria-valuenow'], 13, '正在处理第 13 条（done 是**已经做完**的条数）')
  assert.equal(bar.props['aria-valuemax'], 84, '分母是这一段要做的总条数')
  assert.equal(bar.props['aria-label'], 'progress.push:{"current":13,"total":84}', '可读名就是那句计数')
  const fill = recorded.find((node) => String(node.props?.className) === 'dsm-progressFill')
  assert.equal(fill.props.style.width, `${(13 / 84) * 100}%`, '填充宽度按 13/84 算，不是写死的')
  assert.ok(text.includes('progress.push:{"current":13,"total":84}'), '正文里写清正在推送第几条')
  assert.ok(text.includes('会话九'), '当前那一条的标题也在（一条几 MB 的包会在这停一会儿）')
  assert.ok(text.includes('sync.progress.note'), '并说明为什么这里没有「取消」')
  assert.equal(recorded.some((node) => node.type === 'table'), false, '落地时不再画计划表（那张表说的是"将要"）')
  assert.equal(primaryOf(recorded).props.children, 'sync.busy', '确认按钮变成"同步中…"')
  assert.equal(primaryOf(recorded).props.disabled, true, '落地时确认按钮禁用（不能按第二下）')
  assert.equal(cancelOf(recorded).props.disabled, true, '取消也禁用：中途撒手会在宿主侧留下半截状态')

  // 拉取那一段用另一句：两段分母不同，文案得跟着 phase 走。
  const pulling = mount({
    state,
    panel: 'sync',
    nulls: [null, null, 'apply', 'apply', null, null, progressOf('pull', 0, 3, 'session-a')],
  })
  const pullingText = strings(pulling.registrations[0].component(pulling.registrations[0].registration.inject()))
  assert.ok(pullingText.includes('progress.pull:{"current":1,"total":3}'), '拉那一段说「正在拉取」')

  // 还没收到第一条事件（宿主刚起来，什么都没开始报）。
  const preparing = mount({ state, panel: 'sync', nulls: [null, null, 'apply', 'apply'] })
  const preparingText = strings(preparing.registrations[0].component(preparing.registrations[0].registration.inject()))
  assert.ok(preparingText.includes('progress.waiting'), '那一段说"正在读取远端索引…"')
  assert.equal(
    preparing.recorded.some((node) => String(node.props?.className) === 'dsm-progress'),
    false,
    '还不知道总数就不画条（画一条 0/0 的只会让人以为卡住了）',
  )

  /*
   * 算计划那三段（预演就有，落地也先走一遍）：扫本机 / 读远端索引 / 比对内容。
   *
   * `dialog` 与 `busy` 都种成 'plan'：假钩子不会点按钮，预演那一段只能这样走进去。进度事件里的
   * `done` 同样是"已经做完的条数"，所以界面上的第几条是 `done + 1`。
   */
  const phaseOf = (progress) => {
    const mounted = mount({ state, panel: 'sync', nulls: [null, null, 'plan', 'plan', null, null, progress] })
    return {
      mounted,
      text: strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject())),
      bar: mounted.recorded.find((node) => String(node.props?.className) === 'dsm-progress'),
    }
  }

  const scanning = phaseOf({ phase: 'scan', done: 42, total: 85 })
  assert.equal(scanning.bar.props['aria-valuenow'], 43, '扫到第 43 条（done 是已经扫完的条数）')
  assert.equal(scanning.bar.props['aria-valuemax'], 85, '分母是这次要尝试的条目数')
  assert.ok(scanning.text.includes('progress.scan:{"current":43,"total":85}'), '预演时说"正在扫描本机会话"')
  assert.equal(scanning.text.includes('dialog.previewing'), false, '有具体进度就不摆那句静态的「预演中…」')
  assert.equal(scanning.mounted.recorded.some((node) => node.type === 'table'), false, '计划还没回来，不画表')
  assert.equal(scanning.text.includes('sync.progress.note'), false, '预演阶段还没有东西可覆盖，不摆那句"只增不覆盖"')

  // 读远端索引是一次往返，没有"第几条"可讲（宿主给的分母是 0）：固定一句话，**不摆条**——画一条
  // 1/1 的会让人以为已经做完了，而它其实还在等。
  const remote = phaseOf({ phase: 'remote', done: 0, total: 0 })
  assert.ok(remote.text.includes('progress.remote'), '读远端索引那一段就说"正在读取远端索引…"')
  assert.equal(remote.bar, undefined, '分母是 0 的那一段不画进度条')

  // 认本机仓库身份：每个候选目录一个 git 进程，真机上这一段比前两段加起来还长。
  const matching = phaseOf({ phase: 'repo', done: 4, total: 13 })
  assert.ok(matching.text.includes('progress.repo:{"current":5,"total":13}'), '认仓库时说的是"正在核对本机仓库"')

  // 比对内容：分母是两边都有那些会话的文件数。
  const comparing = phaseOf({ phase: 'compare', done: 7, total: 12 })
  assert.ok(comparing.text.includes('progress.compare:{"current":8,"total":12}'), '比对时说的是"正在比对内容"')
})

// ---- 其它长动作的进度 ----
//
// 进度块原先只有同步有（见上面那两条）。现在迁移 / 删除 / 回滚 / 导入 / 归档 / 扫库共用同一套地基：
// 宿主那一侧一个 `streamResult()`（见 src/web.ts），界面这一侧一个 `ProgressBlock`（见
// ProgressBlock.tsx）。下面几条钉住三件事：每个动作的弹窗正文里真的接上了它、分母为 0 的段不画条、
// "还没有事件"与"认不出来的段名"各有兜底。

/** 一条进度事件（形状见 src/types.ts 的 `ProgressEvent`）。 */
const progressOf = (phase, done, total, label) => ({ phase, done, total, id: 's-1', ...(label === undefined ? {} : { label }) })

test('客户端产物：迁移落地时弹窗正文换成进度块（计划表说的是"将要"，这时候已经过期了）', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [],
    workspaces: [],
  }
  const response = {
    mode: 'apply',
    ok: true,
    preview: {
      ok: true,
      problems: [],
      from: '/home/u/dev/alpha',
      to: '/home/u/dev/beta',
      sourceProjectDir: '/home/u/.dsh/sessions/alpha',
      targetProjectDir: '/home/u/.dsh/sessions/beta',
      unowned: false,
      sourceProjectDirs: ['/home/u/.dsh/sessions/alpha'],
      sessions: [{ id: 's-1', createdAt: 5, registered: true, alreadyAtTarget: false, sourceDir: '/x', targetDir: '/y', files: 1, bytes: 10 }],
      cascaded: 0,
      liveSkipped: [],
      strandedSources: [],
      files: 1,
      bytes: 10,
      artifacts: null,
      registryChange: null,
      summary: 'plan summary',
    },
    applied: true,
    rewritten: 1,
    moved: 1,
    artifactsMoved: 0,
    verified: true,
    problems: [],
    summary: 'done',
    takesEffect: 'immediate',
  }
  /*
   * null 顺序：骨架的 error / 目录字段的两份面板 / **pending**（种成落地完成的那份响应）/ **busy**
   * （'apply'：假钩子不会点按钮，落地那一段只能这样走进去）/ error / notice / effect / **progress**
   * ——进度声明排在最后，见 MigrationPanel.tsx 的说明。
   */
  const mounted = mount({
    state,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
    nulls: [null, null, null, { response, error: null }, 'apply', null, null, null, progressOf('rewrite', 7, 253, '会话九')],
  })
  const recorded = mounted.recorded
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))

  const bar = recorded.find((node) => String(node.props?.className) === 'dsm-progress')
  assert.ok(bar !== undefined, '落地时弹窗正文里有一条进度条')
  assert.equal(bar.props['aria-valuenow'], 8, '正在改第 8 份日志（done 是**已经做完**的条数）')
  assert.equal(bar.props['aria-valuemax'], 253, '分母是这一步真实的工作单位（这里是日志文件数）')
  assert.ok(text.includes('progress.rewrite:{"current":8,"total":253}'), '正文里写清在改日志')
  assert.ok(text.includes('会话九'), '当前那一条也在')
  assert.ok(text.includes('migrate.progress.note'), '并说明中断之后能在「备份」页回退')
  assert.equal(text.includes('plan summary'), false, '落地时不再摆那份计划摘要（它说的是"将要"）')
  assert.equal(dialogsOf(recorded)[0].props['aria-label'], 'migrate.running', '标题从「将要迁移」换成「迁移中…」')
  assert.equal(primaryOf(recorded).props.children, 'migrate.running', '确认按钮变成"迁移中…"')
  assert.equal(primaryOf(recorded).props.disabled, true, '落地时确认按钮禁用（不能按第二下）')
  assert.equal(cancelOf(recorded).props.disabled, true, '取消也禁用：中途撒手会在库里留下中间状态')

  // 还没有收到第一条事件（按下确认之后的一瞬）：只有一句"正在准备…"，不画条。
  const preparing = mount({
    state,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
    nulls: [null, null, null, { response, error: null }, 'apply'],
  })
  const preparingText = strings(preparing.registrations[0].component(preparing.registrations[0].registration.inject()))
  assert.ok(preparingText.includes('progress.waiting'), '那一段说"正在准备…"')
  assert.equal(
    preparing.recorded.some((node) => String(node.props?.className) === 'dsm-progress'),
    false,
    '还不知道总数就不画条',
  )
})

test('客户端产物：删除与回滚的弹窗正文同样换成进度块', { skip }, () => {
  const deleteState = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [{ id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 2048, files: [] }],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const deletePlan = {
    mode: 'apply',
    ok: true,
    preview: {
      ok: true,
      problems: [],
      entries: [{ id: 's-1', createdAt: 5, dir: '/home/u/.dsh/sessions/alpha/s-1', files: [], bytes: 2048, live: false }],
      files: 0,
      bytes: 2048,
      backupRoot: '/home/u/.dsh/dsh-session-manager/backups',
    },
    applied: true,
    dirsRemoved: 1,
    removedProjectDirs: [],
    verified: true,
    backupDir: '/home/u/.dsh/dsh-session-manager/backups/2026-10-08T00-00-00',
    problems: [],
    summary: '已删除 1 个会话',
    takesEffect: 'restart-required',
  }
  // null 顺序：骨架的 error / 会话页的 busy / error / notice / pending / **progress**（勾选集由 arrays 种）。
  const deleting = mount({
    state: deleteState,
    panel: 'manage',
    arrays: [['s-1']],
    nulls: [null, 'apply', null, null, { plan: deletePlan, error: null }, progressOf('remove', 0, 1, '会话甲')],
  })
  const deletingText = strings(deleting.registrations[0].component(deleting.registrations[0].registration.inject()))
  assert.ok(deletingText.includes('progress.remove:{"current":1,"total":1}'), '删除那一段说"正在删除"')
  assert.ok(deletingText.includes('manage.delete.progress.note'), '并说明删除前先备份、中断了能恢复')
  assert.equal(
    dialogsOf(deleting.recorded)[0].props['aria-label'],
    'manage.delete.running',
    '标题从「将要删除」换成「删除中…」',
  )

  // 归档：没有弹窗，进度块摆在动作行下面（逐条走宿主能力，勾一整页时这一段是可感知的）。
  const archiving = mount({
    state: deleteState,
    panel: 'manage',
    arrays: [['s-1']],
    nulls: [null, 'archive', null, null, null, progressOf('archive', 0, 3, undefined)],
  })
  const archivingText = strings(archiving.registrations[0].component(archiving.registrations[0].registration.inject()))
  assert.ok(archivingText.includes('progress.archive:{"current":1,"total":3}'), '归档那一段说"正在更新归档状态"')

  const backup = {
    dir: '/home/u/.dsh/dsh-session-manager/backups/2026-10-03T08-00-00',
    createdAt: '2026-10-03T08:00:00.000Z',
    sessions: 2,
    artifacts: 0,
    kind: 'migrate',
    from: '/home/u/dev/alpha',
    to: '/home/u/dev/beta',
  }
  // null 顺序：骨架的 error / 备份页的 error / notice / busy / dialog / **progress**。
  const rolling = mount({
    state: { sessionsRoot: '/home/u/.dsh/sessions', registryPath: '/home/u/.dsh/registry.json', problems: [], sessions: [], workspaces: [] },
    panel: 'backup',
    arrays: [[backup]],
    nulls: [
      null,
      null,
      null,
      backup.dir,
      {
        backup,
        plan: {
          mode: 'apply',
          dryRun: false,
          actions: ['把 s-1 搬回 /home/u/dev/alpha'],
          restoredFiles: 1,
          restoredArtifacts: 0,
          registryRestored: true,
          backupDir: backup.dir,
          createdAt: backup.createdAt,
          sessions: 2,
          artifacts: 0,
          takesEffect: 'immediate',
        },
        error: null,
      },
      progressOf('restore', 1, 2, '会话乙'),
    ],
  })
  const rollingText = strings(rolling.registrations[0].component(rolling.registrations[0].registration.inject()))
  assert.ok(rollingText.includes('progress.restore:{"current":2,"total":2}'), '回滚那一段说"正在还原"')
  assert.ok(rollingText.includes('backup.progress.note'), '并说明中断了再点一次这份备份即可')
  assert.equal(dialogsOf(rolling.recorded)[0].props['aria-label'], 'backup.rollback.running', '标题换成「回滚中…」')
})

test('客户端产物：导入落地时弹窗正文换成进度块', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [{ id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 10, files: [] }],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const plan = {
    mode: 'apply',
    bundle: { createdAt: '2026-10-01T00:00:00.000Z', source: {}, sessions: 2 },
    problems: [],
    entries: [
      { id: 's-1', action: 'create', dir: '/home/u/.dsh/sessions/alpha/s-1', files: [{ name: 'session.v4.jsonl.zstd', bytes: 10 }], toCwd: '/home/u/dev/alpha' },
      { id: 's-2', action: 'skip', reason: '库里已有', dir: '/home/u/.dsh/sessions/alpha/s-2', files: [], fromCwd: '/home/u/dev/alpha' },
    ],
    created: ['s-1'],
    rehomed: ['s-1'],
    bytes: 10,
    registryChange: null,
    ok: true,
    written: ['s-1'],
    writtenBytes: 10,
    registryWritten: true,
    takesEffect: 'immediate',
    note: '会话已落盘',
  }
  // null 顺序：骨架的 error / 传输页的 file / payload / **pending** / **busy**（'apply'：假钩子不会点
  // 按钮，落地那一段只能这样走进去）/ error / notice / 目录字段的面板 / 手输路径 / **progress**。
  const mounted = mount({
    state,
    panel: 'transfer',
    nulls: [null, null, null, { plan, error: null }, 'apply', null, null, null, null, progressOf('write', 0, 1, '会话甲')],
  })
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  assert.ok(text.includes('progress.write:{"current":1,"total":1}'), '落地那一段说"正在写入"')
  assert.ok(text.includes('transfer.import.progress.note'), '并说明导入只增不覆盖、中断了再导一次')
  assert.equal(
    dialogsOf(mounted.recorded)[0].props['aria-label'],
    'transfer.import.applying',
    '标题从「将要写入」换成「导入中…」',
  )
  assert.equal(text.includes('table.create'), false, '落地时不再摆那张计划表（它说的是"将要"）')
})

test('客户端产物：进度块的段名是一份共用词汇，认不出来的段名退到一句通用的话', { skip }, () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    archiveAvailable: true,
    sessions: [{ id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 2048, files: [] }],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const plan = {
    mode: 'apply',
    ok: true,
    preview: {
      ok: true,
      problems: [],
      entries: [{ id: 's-1', createdAt: 5, dir: '/home/u/.dsh/sessions/alpha/s-1', files: [], bytes: 2048, live: false }],
      files: 0,
      bytes: 2048,
      backupRoot: '/home/u/.dsh/dsh-session-manager/backups',
    },
    applied: true,
    dirsRemoved: 1,
    removedProjectDirs: [],
    verified: true,
    problems: [],
    summary: '已删除 1 个会话',
    takesEffect: 'immediate',
  }
  /** 种一条进度事件，把弹窗正文摊成文字与元素。 */
  const render = (progress) => {
    const mounted = mount({
      state,
      panel: 'manage',
      arrays: [['s-1']],
      nulls: [null, 'apply', null, null, { plan, error: null }, progress],
    })
    return {
      mounted,
      text: strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject())),
      bar: mounted.recorded.find((node) => String(node.props?.className) === 'dsm-progress'),
    }
  }

  // 共用词汇里的每一段都有一句话（新增一段却忘了配文案时，这里当场红）。
  const wording = {
    scan: 'progress.scan:{"current":5,"total":9}',
    read: 'progress.read:{"current":5,"total":9}',
    pack: 'progress.pack:{"current":5,"total":9}',
    backup: 'progress.backup:{"current":5,"total":9}',
    rewrite: 'progress.rewrite:{"current":5,"total":9}',
    move: 'progress.move:{"current":5,"total":9}',
    write: 'progress.write:{"current":5,"total":9}',
    remove: 'progress.remove:{"current":5,"total":9}',
    restore: 'progress.restore:{"current":5,"total":9}',
    archive: 'progress.archive:{"current":5,"total":9}',
    verify: 'progress.verify:{"current":5,"total":9}',
    repo: 'progress.repo:{"current":5,"total":9}',
    compare: 'progress.compare:{"current":5,"total":9}',
    pull: 'progress.pull:{"current":5,"total":9}',
    push: 'progress.push:{"current":5,"total":9}',
    // 补齐那条是逐条走宿主，有分母
    warm: 'progress.warm:{"current":5,"total":9}',
  }
  for (const [phase, expected] of Object.entries(wording)) {
    assert.ok(render({ phase, done: 4, total: 9 }).text.includes(expected), `${phase} 那一段有自己的话`)
  }
  // 没有分母的三段：只说在做什么，**不画条**。
  for (const phase of ['registry', 'remote']) {
    const rendered = render({ phase, done: 0, total: 0 })
    assert.ok(rendered.text.includes(`progress.${phase}`), `${phase} 那一段有固定的一句话`)
    assert.equal(rendered.bar, undefined, `${phase} 没有分母，不画条`)
  }
  // 宿主比界面新时报一段界面还不认识的段名：退到一句通用的话，整块不许消失。
  const unknown = render({ phase: 'future-phase', done: 0, total: 0 })
  assert.ok(unknown.text.includes('progress.working'), '认不出来的段名退到"正在处理…"')
})

test('客户端产物：确认同步打的是落地端点，读的是一条事件流而不是等一次性 JSON', { skip }, async () => {
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 0 },
    sessions: [],
    workspaces: [],
  }
  const calls = []
  // 收尾那条给一份**完整**的 SyncResponse：界面接着会读 `pulled` / `pushed` / `plan` 它们（缺一个就是
  // "真实宿主不会这么回，但界面不该当场崩"这件事的反面教材）。
  const result = {
    mode: 'apply',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    plan: {
      ok: true,
      problems: [],
      pull: [],
      push: [],
      pullIds: [],
      pushIds: [],
      bytesIn: 0,
      bytesOut: 0,
      localCount: 0,
      remoteCount: 0,
      machines: [],
    },
    applied: true,
    pulled: [],
    pushed: [],
    bytesIn: 0,
    bytesOut: 0,
    registryWritten: false,
    indexWritten: true,
    problems: [],
    takesEffect: 'immediate',
  }
  const chunks = [
    'data: {"type":"progress","progress":{"phase":"push","total":2,"done":0,"id":"s-1","label":"一"}}\n\n',
    `data: {"type":"result","result":${JSON.stringify(result)}}\n\n`,
  ]
  let index = 0
  let reads = 0
  // 弹窗开着（dialog='apply'）、还没点确认（busy=null）：主按钮就是那个入口。
  const mounted = mount({
    state,
    panel: 'sync',
    nulls: [null, null, 'apply'],
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, accept: init?.headers?.accept })
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => {
            calls.push({ header: name })
            return 'text/event-stream; charset=utf-8'
          },
        },
        body: {
          getReader: () => ({
            read: async () => {
              reads += 1
              return index < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[index++]) } : { done: true }
            },
          }),
        },
        // 一次性那条路必须**没被走到**：走错的话这里会被调用，用例当场红。
        text: async () => {
          calls.push({ text: true })
          return ''
        },
      }
    },
  })

  // 没有渲染器：得自己把页面组件调一次，还得**走一遍树**（`strings` 遇到函数组件会带着 props 调它），
  // 否则 SyncPanel 只是个没被展开的元素，里面的按钮压根没进 `recorded`。
  strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  primaryOf(mounted.recorded).props.onClick()
  for (let tries = 0; tries < 50 && index < chunks.length; tries += 1) await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(calls.filter((call) => call.url !== undefined), [
    { url: '/dsh-session-manager/api/sync?mode=apply', method: 'POST', accept: 'text/event-stream' },
  ])
  assert.ok(
    calls.some((call) => call.header === 'content-type'),
    '先问 content-type：流还没开始就被挡下时（没配置同步）回的是一次性 JSON',
  )
  assert.equal(calls.some((call) => call.text === true), false, '事件流不走一次性 text()')
  assert.equal(index, chunks.length, '两块事件都被读出来了')
  assert.ok(reads >= chunks.length + 1, '一直读到 done（不是读一块就收手）')
})

test('客户端产物：同步预演读的也是一条事件流（不是等一次性 JSON）', { skip }, async () => {
  // 预演也要进度：它得先扫本机、再读远端索引、最后逐条比对内容，冷启动时那几秒界面原来只有一句
  // "预演中…"。宿主两条路回的是同一个形状，所以这里钉的就是"点「同步」打的是那个端点、读的是流"。
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 0 },
    sessions: [],
    workspaces: [],
  }
  const calls = []
  // 收尾那条给一份**完整**的 SyncResponse：界面接着会读 `plan` 它们。
  const result = {
    mode: 'plan',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    plan: {
      ok: true,
      problems: [],
      pull: [],
      push: [],
      pullIds: [],
      pushIds: [],
      bytesIn: 0,
      bytesOut: 0,
      localCount: 0,
      remoteCount: 0,
      machines: [],
    },
    applied: false,
    pulled: [],
    pushed: [],
    bytesIn: 0,
    bytesOut: 0,
    registryWritten: false,
    indexWritten: false,
    problems: [],
    takesEffect: 'immediate',
  }
  const chunks = [
    'data: {"type":"progress","progress":{"phase":"scan","total":3,"done":0}}\n\n',
    'data: {"type":"progress","progress":{"phase":"remote","total":1,"done":1}}\n\n',
    `data: {"type":"result","result":${JSON.stringify(result)}}\n\n`,
  ]
  let index = 0
  let reads = 0
  const mounted = mount({
    state,
    panel: 'sync',
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, accept: init?.headers?.accept })
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => {
            calls.push({ header: name })
            return 'text/event-stream; charset=utf-8'
          },
        },
        body: {
          getReader: () => ({
            read: async () => {
              reads += 1
              return index < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[index++]) } : { done: true }
            },
          }),
        },
        // 一次性那条路必须**没被走到**：走错的话这里会被调用，用例当场红。
        text: async () => {
          calls.push({ text: true })
          return ''
        },
      }
    },
  })

  strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  const open = mounted.recorded.find((node) => node.type === 'button' && node.props?.children === 'sync.action')
  assert.ok(open !== undefined, '卡片头上那个「同步」就是预演的入口')
  open.props.onClick()
  for (let tries = 0; tries < 50 && index < chunks.length; tries += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.deepEqual(calls.filter((call) => call.url !== undefined), [
    { url: '/dsh-session-manager/api/sync', method: 'GET', accept: 'text/event-stream' },
  ])
  assert.equal(calls.some((call) => call.text === true), false, '预演也不走一次性 text()')
  assert.equal(index, chunks.length, '三条事件都读出来了（含算计划的那两条）')
  assert.ok(reads >= chunks.length + 1, '一直读到 done（不是读一块就收手）')
})

test('客户端产物：迁移落地时宿主报的每条进度都进了界面状态（事件流 → 面板的回调）', { skip }, async () => {
  /*
   * 上面那几条「弹窗正文换成进度块」是把一份进度**种**进状态里看它怎么画——它们证明不了
   * "宿主报的进度真的会走到界面上"。这一条从另一头钉：给一个假 `fetch`，让它按 SSE 分帧吐出
   * 一条进度 + 一条收尾，然后核**面板传给 api 的那个回调真的被调到了**（`sets` 是假钩子记下的
   * "谁被 set 成了什么"，见 fakeReact）。
   *
   * 少了这一条，`migrate(request, setProgress)` 里那个参数掉了也不会红：种进去的进度照样画得出来。
   */
  const state = {
    sessionsRoot: '/home/u/.dsh/sessions',
    registryPath: '/home/u/.dsh/registry.json',
    problems: [],
    sessions: [{ id: 's-1', cwd: '/home/u/dev/alpha', createdAt: 5, dir: '/home/u/dev/alpha', bytes: 2048, files: [] }],
    workspaces: [{ id: 'w1', path: '/home/u/dev/alpha', title: '工作区甲', sessionIds: ['s-1'] }],
  }
  const preview = {
    ok: true,
    problems: [],
    from: '/home/u/dev/alpha',
    to: '/home/u/dev/beta',
    sourceProjectDir: '/home/u/.dsh/sessions/alpha',
    targetProjectDir: '/home/u/.dsh/sessions/beta',
    unowned: false,
    sourceProjectDirs: ['/home/u/.dsh/sessions/alpha'],
    sessions: [
      { id: 's-1', createdAt: 5, registered: true, alreadyAtTarget: false, sourceDir: '/x', targetDir: '/y', files: 1, bytes: 10 },
    ],
    cascaded: 0,
    liveSkipped: [],
    strandedSources: [],
    files: 1,
    bytes: 10,
    artifacts: null,
    registryChange: null,
    summary: 'plan summary',
  }
  const plan = { mode: 'plan', ok: true, preview, applied: false, rewritten: 0, moved: 0, artifactsMoved: 0, verified: false, problems: [], summary: 'plan summary', takesEffect: 'immediate' }
  const applied = { mode: 'apply', ok: true, preview, applied: true, rewritten: 1, moved: 1, artifactsMoved: 0, verified: true, problems: [], summary: 'done', takesEffect: 'immediate' }
  const chunks = [
    'data: {"type":"progress","progress":{"phase":"rewrite","total":253,"done":6,"id":"s-1","label":"会话甲"}}\n\n',
    `data: {"type":"result","result":${JSON.stringify(applied)}}\n\n`,
  ]
  let index = 0
  const calls = []
  const mounted = mount({
    state,
    panel: 'migrate',
    strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
    nulls: [null, null, null, { response: plan, error: null }],
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, accept: init?.headers?.accept, body: init?.body })
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
        body: {
          getReader: () => ({
            read: async () =>
              index < chunks.length
                ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
                : { done: true },
          }),
        },
        // 一次性那条路必须没被走到：走错的话这里会被调用，用例当场红。
        text: async () => {
          throw new Error('落地走的是事件流，不该读一次性 text()')
        },
      }
    },
  })

  // 假钩子不会点按钮：先把树摊开，再点弹窗底部那枚主动作（确认迁移）。
  strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  primaryOf(mounted.recorded).props.onClick()
  for (let tries = 0; tries < 50 && index < chunks.length; tries += 1) await new Promise((resolve) => setImmediate(resolve))

  // `/meta` 与 `/state` 是骨架首屏那两条（假钩子把 effect 直接跑了），这里只认落地那一条。
  const landing = calls.filter((call) => call.url === '/dsh-session-manager/api/migrate')
  assert.equal(landing.length, 1, '落地只打一次')
  assert.equal(landing[0].method, 'POST')
  assert.equal(landing[0].accept, 'text/event-stream', '界面明说自己要事件流')
  assert.deepEqual(JSON.parse(landing[0].body), {
    mode: 'apply',
    from: '/home/u/dev/alpha',
    to: '/home/u/dev/beta',
    sessionIds: null,
    includeUnowned: true,
    includeArtifacts: false,
  })

  // 跨 realm：产物在另一个 vm 里，把那条进度摊成宿主这边的普通对象再比。
  const progressSets = mounted.sets.filter(
    (entry) => entry.value !== null && typeof entry.value === 'object' && 'phase' in entry.value,
  )
  assert.deepEqual(
    progressSets.map((entry) => ({ ...entry.value })),
    [{ phase: 'rewrite', total: 253, done: 6, id: 's-1', label: '会话甲' }],
    '宿主报的那条进度原样进了界面状态（面板真的把 onProgress 接上了）',
  )
  // 收尾那条要把进度清掉（不然下一次打开弹窗会先闪一条上一轮的进度）：**同一个状态位**先收到进度、
  // 之后被置回 null（只看"后面还有没有 null"是不够的——同一段里 setBusy(null) 也会满足它）。
  const landed = mounted.sets.findIndex((entry) => entry.value !== null && typeof entry.value === 'object' && 'phase' in entry.value)
  const cleared = mounted.sets.findIndex(
    (entry, index) => index > landed && entry.slot === mounted.sets[landed].slot && entry.value === null,
  )
  assert.ok(cleared > landed, '落地收尾时那条进度被清掉（同一个状态位置回 null）')
})
