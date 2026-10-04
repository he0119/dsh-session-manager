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
function loadBundle({ firstNull, panel, arrays, strings, nulls, fetch } = {}) {
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
function mount({ translate, state, panel, arrays, strings, nulls, configForms, credentials, fetch } = {}) {
  const { mod, nodes, recorded } = loadBundle({ firstNull: state, panel, arrays, strings, nulls, fetch })
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
  // 组头只摆名字：路径（以及认出来的项目身份）都在名字那一格的悬浮提示里，判定见下面那个用例。
  assert.ok(
    recorded.some(
      (element) => String(element.props?.className) === 'dsm-groupTitle' && element.props?.title === '/home/u/dev/alpha',
    ),
    '已登记的工作区：路径在名字那一格的悬浮提示里（组头上不再印它）',
  )
  assert.ok(text.includes('/home/u/dev/beta'), '没登记的目录也要成组（没有标题、也没有身份，名字就是路径）')
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

test('客户端产物：组头只摆名字，身份与本机路径在悬浮提示里；下拉框里两个都留', { skip }, () => {
  // 组头上只留**人认得的那一个名字**：项目身份（host/owner/repo）与本机路径都是机器字符串，摆在那一行
  // 里又长又会被截断（截断的身份比没有还难认），而"这是哪个仓库、在本机哪个目录"是想知道才看的信息。
  // 规则在 planRows.projectLabel() / pathLabel()（test/planRows.test.ts 逐条钉着），这里管的是"四处
  // 界面是不是都接上了这条线"：两个动作页的组头、迁移页的来源下拉框、传输页的目标下拉框。下拉框与组头
  // 的差别是刻意的——<option> 没有悬浮提示，路径不能从那儿消失。
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
  assert.equal(text.includes('unregisteredDir'), true, '没登记的目录照样要标出来')
  // 两个机器字符串都不在可见文字里：身份与路径各自只出现在悬浮提示上
  assert.equal(text.includes('github.com/he0119/beta'), false, '身份不再当可见文字印一遍')
  assert.equal(text.includes('/home/u/dev/beta'), false, '本机路径也不再当可见文字印一遍')
  assert.ok(
    mounted.recorded.some((element) => element.props?.title === 'github.com/he0119/beta\n/home/u/dev/beta'),
    '身份与路径都没丢：它们落在名字那一格的悬浮提示上',
  )

  // 传输页的目标工作区下拉框：身份取代标题那一栏，路径留着（那里没有悬浮提示可退）
  const target = mounted.recorded.find((element) => element.type === 'option' && element.props?.value === '/home/u/dev/alpha')
  assert.equal(target?.props?.children, 'github.com/he0119/alpha — /home/u/dev/alpha')

  // 迁移页的来源下拉框：同一套写法 + 库里的条数
  const migrated = mount({ state, panel: 'migrate' })
  strings(migrated.registrations[0].component(migrated.registrations[0].registration.inject()))
  const options = migrated.recorded.filter((element) => element.type === 'option')
  const optionFor = (path) => options.find((element) => element.props?.value === path)
  assert.equal(
    optionFor('/home/u/dev/alpha')?.props?.children,
    'github.com/he0119/alpha — /home/u/dev/alpha — sessionsInDir:{"count":1}',
    '有身份时那一行是"身份 — 路径 — 条数"（标题不再重复，路径与身份都在）',
  )
  assert.equal(
    optionFor('/home/u/dev/beta')?.props?.children,
    'github.com/he0119/beta — /home/u/dev/beta — sessionsInDir:{"count":1}',
  )
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
  assert.ok(actionButton('manageDelete') !== undefined && text.includes('manageDeleteHint'), '删除入口与说明在')
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
  assert.ok(button('manageDelete') !== undefined, '删除入口照旧在')
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

test('客户端产物：迁移弹窗——计划逐条列出会话，跟着父会话进来的那些挂「随父迁」', { skip }, () => {
  // 弹窗是点了「迁移」之后才在树上的，冒烟里走不到（假钩子给不出点击），所以把 `pending` 种进去。
  // null 状态的顺序：页面骨架的 error（`state` 由 mount 的 `firstNull` 种）/ 迁移页的
  // picking / manual / **pending**——所以 `nulls` 里先补三个 null，第四个才是那份计划。
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
  /** 种一份计划进弹窗（`pending` 的位置见上面的注释）。 */
  const withPlan = (cascaded) => {
    const mounted = mount({
      state,
      panel: 'migrate',
      strings: ['/home/u/dev/alpha', '/home/u/dev/beta'],
      nulls: [null, null, null, { response: outcomeOf(cascaded), error: null }],
    })
    const tree = mounted.registrations[0].component(mounted.registrations[0].registration.inject())
    return { mounted, tree, text: strings(tree) }
  }

  const withFamily = withPlan(1)
  assert.ok(withFamily.text.includes('migrateTitle'), '迁移页本体渲染出来了')
  assert.ok(
    withFamily.text.some((item) => String(item) === 'migrateFamily:{"count":1}'),
    '有一条子代理跟着走时，弹窗里要说明它是跟着父会话进来的',
  )
  // 弹窗本体：标题、逐条清单（含"随父迁"那枚标签）、底部那对按钮
  const dialogs = withFamily.mounted.recorded.filter((node) => node.props?.role === 'dialog')
  assert.equal(dialogs.length, 1, '迁移页上只有一个弹窗')
  assert.equal(dialogs[0].props['aria-label'], 'migrateDialogTitle', '标题说的是那个动作')
  const rows = withFamily.mounted.recorded.filter(
    (node) => typeof node.type === 'string' && String(node.props?.className).includes('dsm-rowPlan'),
  )
  assert.deepEqual(rows.map((row) => rowParts(row).label), ['s-1', 's-9'], '清单里逐条列出会搬走的会话')
  assert.deepEqual(rowParts(rows[0]).tags, [], '点名的那些没有出处标签')
  assert.deepEqual(rowParts(rows[1]).tags, ['migrateVia'], '级联进来的挂「随父迁」（不是「随父删」）')
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
    ['cancel', 'migrateApply'],
    '底部是「取消 / 确认迁移」，确认那个是唯一的落地入口',
  )

  // 没有子代理跟随时那句话不该出现（否则每次迁移都多一行噪音）
  const plain = withPlan(0)
  assert.ok(plain.text.some((item) => String(item).startsWith('migrateSummary')), '弹窗正文照旧渲染')
  assert.equal(plain.text.some((item) => String(item).startsWith('migrateFamily')), false)
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
  assert.equal(terms.length, 18, '词条数＝分类 6 + 分页 4 + 数据 2 + 疑问 6')
  assert.equal(recorded.filter((node) => node.type === 'dd').length, 18, '每条词条都有解释')
  assert.ok(terms.includes('tabSync'), '分页那一节要写到「同步」这一页')
  // 「数据从哪来」两条路径来自 /state，不是写死在文案里
  assert.ok(
    text.includes('/home/u/.dsh/sessions') && text.includes('/home/u/.dsh/registry.json'),
    '两条路径来自 /state',
  )
  for (const key of ['faqUnownedQ', 'faqDeletedQ', 'faqRestartQ', 'faqRestoreQ', 'faqForkQ', 'faqPasswordQ']) {
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
  assert.ok(!buttonTexts(off).includes('syncAction'), '没配置时不该出现同步按钮')

  // 配置了：远端与这台机器报出来，预演与确认两个按钮都在
  const on = mount({
    state: { ...base, sync: { url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 2 } },
    panel: 'sync',
  })
  const onText = text(on)
  assert.ok(onText.includes('syncWhere:{"url":"https://dav.example.com/dsh"}'), '卡片标题只报远端')
  assert.ok(onText.includes('syncHint:{"mappings":2}'), '要报出映射条数')
  // 机器名不再重复印在标题上：它挪到了机器名那一栏的**灰字**里（宿主解析出来的缺省值，没配就是
  // 主机名），与「超时」那一栏的 30000 同一个口径——留空不等于没有值。那一栏归表单那条用例钉。
  // 一个动作一个按钮：弹窗里的「确认同步」只有开了弹窗才在树上，卡片头上只有「同步」这一个入口。
  assert.deepEqual(buttonTexts(on).filter((label) => label.startsWith('sync')), ['syncAction'])
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
  assert.ok(text.includes('syncFieldMapping'), '映射字段在场')
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
  assert.ok(text.includes('syncMapAdd'), '有「添加一行」')

  // 密码：官方控件库那个**只写**控件（`SettingsSecretField`），不是本页手写的 dsm-input。
  // 假钩子不跑 useEffect，所以这里量的是首帧：`describe` 的答案还没回来之前按"未配置"画，
  // 并且输入框从空白开始——没有任何读路径会把值送回来（`describe` 只回 {configured, writable}）。
  const secret = mounted.recorded.find((node) => node.props?.id === 'dsm-dav-password')?.props
  assert.ok(secret !== undefined, '宿主给了凭据服务就摆出密码控件')
  assert.equal(secret.label, 'syncFieldPasswordValue')
  assert.equal(secret.text, '', '只写控件从空白开始：值不会从宿主那边回来')
  assert.equal(secret.stateLabel, 'syncPasswordUnset', '首帧按未配置画，describe 回来之后再改')
  assert.equal(secret.configured, false)
  assert.equal(secret.disabled, false)
  assert.ok(!text.includes('syncPasswordUnavailable'), '有凭据服务时不摆那句"只能走环境变量"')

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
  assert.ok(bareText.includes('syncFormUnavailable'), '没接缝时说清只能在配置里改')
  assert.ok(!bareText.includes('syncMapAdd'), '没接缝时不画表单')

  // 有接缝、没有凭据服务（宿主没装凭据提供方）：表单照画，只是密码那一块说清只能走环境变量，
  // 不摆一个按下去必然被拒的输入框。
  const noCredentials = mount({
    state,
    panel: 'sync',
    configForms: { get: () => controller },
  })
  const noCredentialsText = strings(noCredentials.registrations[0].component(noCredentials.registrations[0].registration.inject()))
  assert.ok(noCredentialsText.includes('syncPasswordUnavailable'), '没凭据服务时说清密码只能走环境变量')
  assert.ok(!noCredentials.recorded.some((node) => node.props?.id === 'dsm-dav-password'), '也不摆那个控件')
  assert.ok(noCredentialsText.includes('syncMapAdd'), '其余字段照旧能改')
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
  assert.ok(fresh.text.some((item) => item === 'syncTest'), '有「测试连接」按钮')
  assert.ok(fresh.text.some((item) => item === 'syncTestHint'), '旁边说明这次探测是只读的')
  assert.equal(fresh.text.includes('syncTestDirty'), false, '没有草稿时不摆"先保存"那句')
  const testButton = fresh.mounted.recorded.find((node) => node.type === 'button' && node.props?.children === 'syncTest')
  assert.ok(testButton !== undefined, '按钮是个真的 button')
  assert.equal(testButton.props.disabled, false, '配了 url、又没有草稿：可以直接测')
  assert.equal(fresh.text.some((item) => String(item).startsWith('syncTestOk')), false, '没测之前不摆结论')

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
  const deniedLine = 'syncTestNoPassword:{"ref":"DSH_DAV_PASSWORD"}'
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
  const okLine = 'syncTestOk:{"machines":"robot-a, robot-b"}'
  assert.ok(reachable.text.some((item) => item === okLine), '连得上时把远端已有的机器格列出来')
  assert.ok(
    reachable.mounted.recorded.some((node) => node.props?.className === 'dsm-ok' && node.props?.children === okLine),
    '成功那行用成功色',
  )

  // 有未保存的改动时测的不是刚敲进去的那一份：按钮禁用，那句话也换成"先保存"。草稿本身种不进假
  // 钩子（它的初值是 `undefined`，只有 `null` 与 `''` 能被种），但"刚敲了密码还没保存"同样是脏的
  // ——密码框正好是这条渲染路径上第一个 `useState('')`，用它把表单弄脏。
  const edited = render({ strings: ['s3cret'] })
  assert.ok(edited.text.some((item) => item === 'syncTestDirty'), '有草稿时那句改成"先保存"')
  assert.equal(edited.text.includes('syncTestHint'), false, '脏的时候不再说"只读探测"')
  const editedButton = edited.mounted.recorded.find(
    (node) => node.type === 'button' && node.props?.children === 'syncTest',
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
    (node) => node.type === 'button' && node.props?.children === 'syncTest',
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
    unreachable.text.some((item) => item === 'syncTestUnreachable:{"detail":"fetch failed"}'),
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
    .filter((node) => node.type === 'th' && node.props?.children === 'colMachine')
    .length
  assert.equal(keptHeaders, 1, '那张表的第三列表头是「远端机器」')
  // 分组之后路径只在组头说一次：三张表里都不该再有 cwd 列（这一页上也没有别的表会用到它）。
  assert.equal(
    mounted.recorded.filter((node) => node.type === 'th' && node.props?.className === 'dsm-colCwd').length,
    0,
    '同步预演的表里不再有 cwd 列——路径去组头了',
  )

  // 动作列：看得见的是动词，整句在 title 里。
  const tagOf = (visible, title) =>
    mounted.recorded.find((node) => node.props?.children === visible && node.props?.title === title)
  assert.ok(tagOf('syncTagPull', 'syncCodeMissingPull'), '拉取那张表的标签是「拉取」，整句在 title 上')
  assert.ok(tagOf('syncTagPush', 'syncCodeMissingPush'), '推表新推的那颗是「推送」')
  assert.ok(tagOf('syncTagRepush', 'syncCodeLocalAhead'), '本机领先的那颗是「重推刷新」')
  assert.ok(
    mounted.recorded.some(
      (node) => node.props?.children === 'syncTagDiverged' && String(node.props?.title).startsWith('syncCodeDiverged'),
    ),
    '「这次不动」那颗是「两边各自写过」，整句（带机器名）在 title 上',
  )

  // 整句不许再当可见文字（它会把邻居那一列压掉；挤在同一句里还会让状态与会话名分不出来）。
  assert.equal(text.includes('syncCodeMissingPush'), false, '动作列不再放整句')
  assert.equal(text.includes('syncCodeMissingPull'), false)
  assert.equal(text.includes('syncCodeDiverged'), false, '「这次不动」也不再整句可见')
  assert.equal(
    text.some((item) => String(item).includes('syncCodeDiverged') && String(item).includes('session-d')),
    false,
    '状态与会话名不许挤在同一个文本节点里——那正是分不出两者的原因',
  )
  assert.ok(text.includes('session-d'), '会话名照旧是那一行看得见的文字')

  // 计划还没回来的那一段：弹窗开着、正文是"预演中…"，确认禁用（别让上一次那份计划冒充这一次的）。
  const waiting = mount({ state, panel: 'sync', nulls: [null, response, 'plan', 'plan'] })
  const waitingRecorded = waiting.recorded
  const waitingText = strings(waiting.registrations[0].component(waiting.registrations[0].registration.inject()))
  assert.ok(waitingText.includes('previewing'), '计划在路上时正文是"预演中…"')
  assert.equal(
    waitingText.some((item) => String(item).startsWith('syncSummary')),
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

  assert.ok(tagOf('syncTagPull', 'syncCodeMissingPull'), '从无到有那条照旧是「拉取」')
  // 覆盖本机那份：标签说的是动作，title 说清"谁更新、会拿谁换掉本机这份"。
  assert.ok(tagOf('syncTagReplace', 'syncCodeReplaceNewer'), '覆盖那条挂「覆盖本机」+ 它自己那句整句')
  assert.ok(tagOf('syncTagLocalNewer', 'syncCodeLocalNewer'), '分叉里本机更晚那条是「分叉·重推」')
  assert.equal(
    mounted.recorded.some(
      (node) => node.props?.children === 'syncTagReplace' && node.props?.title === 'syncCodeReplaceAhead',
    ),
    false,
    '两条覆盖行的整句按各自的码走（这里这条说的是"两边各自写过"）',
  )
  assert.ok(text.includes('session-replace'), '覆盖那条也在「会拉取」那张表里（它同样是往本机落内容）')
  assert.ok(text.includes('syncPullHead:{"count":2}'), '那张表的条数把覆盖那条算进去')
  assert.ok(text.includes('syncPushHead:{"count":1}'), '覆盖不是推送：推表只有分叉重推那一条')

  // 空白会话：只在正文里报一句，id 一个都不许冒出来（那三张表里也不许有它们）。
  const blankLine = mounted.recorded.find(
    (node) => node.type === 'p' && node.props?.children === 'syncSkippedBlank:{"count":2}',
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
    legacyText.some((item) => String(item).startsWith('syncSkippedBlank')),
    false,
    '没有 blank 字段就不画那一句',
  )
  assert.ok(legacyText.includes('syncPullHead:{"count":2}'), '其余照旧画出来')
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
  assert.ok(headOf(2).includes('noCwdGroup'), '没有 cwd 的那一组照旧自成一组建在最后')
  assert.ok(
    text.includes('sessionsInDir:{"count":2}'),
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
    'session-5\ncwdRewritten:{"from":"/home/b/dev/x","to":"/home/u/dev/beta"}',
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
  assert.ok(syncText.includes('syncTitle'), '「同步」分页上要有同步卡片')
  assert.ok(syncText.includes('syncAction'), '且带着同步按钮（配置在，按钮就在）')
  assert.ok(!transferText.includes('syncTitle'), '传输页上不该再有同步卡片')
  assert.ok(!transferText.includes('syncAction'), '传输页上不该再有同步按钮')
})

// ---- 确认弹窗：一个动作一个入口 ----
//
// 这次改动把"先点预演、看页面上的结果、再点确认"换成了"点动作 → 弹窗里看清单 → 确认或取消"。
// 下面几条钉住三件事：① 每个会写盘的动作只有一个入口（页面上不再有独立的预演按钮）；② 弹窗里摆的
// 是宿主那份计划（清单、问题、备份位置），主按钮在计划不 ok 时真的禁用；③ 级联进来的行有出处标签。

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

  // 页面上只剩"那个动作"本身；`previewing`（"预演中…"）只该出现在开着的弹窗里，页面上一律没有。
  for (const text of [manage, transfer, migrate, sync]) {
    assert.equal(text.includes('previewing'), false, '关着弹窗时页面上不该有"预演中…"')
  }
  assert.ok(manage.includes('manageDelete'), '「会话」页的写入口是「删除所选」')
  assert.ok(transfer.includes('importAction'), '传输页的写入口是「导入」（导出不问）')
  assert.ok(migrate.includes('migrateAction'), '迁移页的写入口是「迁移」')
  assert.ok(sync.includes('syncAction'), '同步页的写入口是「同步」')
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
      backupRoot: '/home/u/.dsh/dsh-session-manager-backups',
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
  assert.equal(dialogs[0].props['aria-label'], 'manageDeletePlanTitle', '标题说的是那个动作')
  assert.ok(good.text.some((item) => String(item) === '将删除 2 条会话'), '弹窗里摆的是宿主给的那份摘要')
  const rows = good.recorded.filter(
    (node) => typeof node.type === 'string' && String(node.props?.className).includes('dsm-rowPlan'),
  )
  assert.deepEqual(rows.map((row) => rowParts(row).label), ['s-1', 's-9'], '清单逐条列出会被删的会话')
  assert.deepEqual(rowParts(rows[1]).tags, ['manageDeleteVia'], '级联进来的挂「随父删」')
  assert.equal(primaryOf(good.recorded).props.disabled, false, '计划 ok 时确认可用')
  assert.ok(strings(cancelOf(good.recorded)).includes('cancel'), '旁边是「取消」')
  assert.ok(
    good.text.some((item) => String(item).startsWith('manageBackupTo') && String(item).includes('dsh-session-manager-backups')),
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
  assert.ok(waitingText.includes('previewing'), '计划在路上时正文是"预演中…"')
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
  // null 顺序：骨架的 error / 传输页的 file / payload / **pending**（目标工作区由第二个空串种）。
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
  assert.ok(create.text.some((item) => String(item).startsWith('planSummary')), '表头那句话照旧在')
  assert.equal(primaryOf(create.recorded).props.children, 'apply', '确认按钮走「确认导入」那一条')
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
    dir: '/home/u/.dsh/dsh-session-manager-backups/2026-10-03T08-00-00',
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
  // null 顺序：骨架的 error / 迁移页的 picking / manual / pending / busy / error / notice / effect /
  // backupError / rollbackBusy / **rollbackDialog**（备份清单由第二个数组种）。
  const item = mount({
    state,
    panel: 'migrate',
    arrays: [[], [backup]],
    nulls: [
      null, null, null, null, null, null, null, null, null, null,
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
  assert.equal(dialogs[0].props['aria-label'], 'rollbackDialogTitle', '标题说的是那个动作')
  assert.ok(text.some((item) => String(item).startsWith('rollbackActions')), '那句"以下是回滚会做的 N 个动作"照旧在')
  assert.ok(text.some((item) => String(item) === '把 s-1 搬回 /home/u/dev/alpha'), '动作清单逐条摆出来')
  assert.deepEqual(
    strings(cancelOf(item.recorded)).concat(strings(primaryOf(item.recorded))),
    ['cancel', 'rollbackConfirm'],
    '底部是「取消 / 确认回滚」',
  )
})

test('客户端产物：备份清单认三种来源——迁移/删除/覆盖前，后两种点「恢复」', { skip }, () => {
  // 同步把本机那份换掉之前也要备份（`kind: 'replace'`）。它与删除留下的那份**行为一样**（搬回目录、
  // 注册表照旧），但与迁移那份不同（迁移要连注册表一起还原）。清单里那颗标签与那个动作按钮都要跟着走，
  // 不然用户面对一份"同步覆盖前"的备份会以为按下去会把工作区登记也一起改回去。
  const backupOf = (kind, stamp) => ({
    dir: `/home/u/.dsh/dsh-session-manager-backups/${stamp}`,
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
  const mounted = mount({ state, panel: 'migrate', arrays: [[], backups] })
  const text = strings(mounted.registrations[0].component(mounted.registrations[0].registration.inject()))
  assert.ok(text.includes('backupKindMigrate'), '迁移那份的标签照旧')
  assert.ok(text.includes('backupKindDelete'), '删除那份的标签照旧')
  assert.ok(text.includes('backupKindReplace'), '同步覆盖前那份要有自己的标签')
  const buttonLabels = mounted.recorded
    .filter((node) => node.type === 'button')
    .map((node) => node.props?.children)
  assert.equal(
    buttonLabels.filter((label) => label === 'restoreAction').length,
    2,
    '删除与覆盖前那两份都点「恢复」（只搬目录）',
  )
  assert.equal(
    buttonLabels.filter((label) => label === 'rollbackAction').length,
    1,
    '只有迁移那份点「回滚」（连注册表一起还原）',
  )

  // 弹窗里的措辞也跟着来源走：覆盖前那份开的是「恢复」那一套文案。
  const replacing = mount({
    state,
    panel: 'migrate',
    arrays: [[], backups],
    nulls: [
      null, null, null, null, null, null, null, null, null, null,
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
  assert.equal(dialogs[0].props['aria-label'], 'restoreDialogTitle', '覆盖前那份开的是「恢复」弹窗')
  assert.deepEqual(
    strings(cancelOf(replacing.recorded)).concat(strings(primaryOf(replacing.recorded))),
    ['cancel', 'restoreConfirm'],
    '底部是「取消 / 确认恢复」',
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
  assert.equal(bar.props['aria-label'], 'syncPushing:{"current":13,"total":84}', '可读名就是那句计数')
  const fill = recorded.find((node) => String(node.props?.className) === 'dsm-progressFill')
  assert.equal(fill.props.style.width, `${(13 / 84) * 100}%`, '填充宽度按 13/84 算，不是写死的')
  assert.ok(text.includes('syncPushing:{"current":13,"total":84}'), '正文里写清正在推送第几条')
  assert.ok(text.includes('会话九'), '当前那一条的标题也在（一条几 MB 的包会在这停一会儿）')
  assert.ok(text.includes('syncProgressNote'), '并说明为什么这里没有「取消」')
  assert.equal(recorded.some((node) => node.type === 'table'), false, '落地时不再画计划表（那张表说的是"将要"）')
  assert.equal(primaryOf(recorded).props.children, 'syncBusy', '确认按钮变成"同步中…"')
  assert.equal(primaryOf(recorded).props.disabled, true, '落地时确认按钮禁用（不能按第二下）')
  assert.equal(cancelOf(recorded).props.disabled, true, '取消也禁用：中途撒手会在宿主侧留下半截状态')

  // 拉取那一段用另一句：两段分母不同，文案得跟着 phase 走。
  const pulling = mount({
    state,
    panel: 'sync',
    nulls: [null, null, 'apply', 'apply', null, null, progressOf('pull', 0, 3, 'session-a')],
  })
  const pullingText = strings(pulling.registrations[0].component(pulling.registrations[0].registration.inject()))
  assert.ok(pullingText.includes('syncPulling:{"current":1,"total":3}'), '拉那一段说「正在拉取」')

  // 还没收到第一条事件（宿主刚起来，什么都没开始报）。
  const preparing = mount({ state, panel: 'sync', nulls: [null, null, 'apply', 'apply'] })
  const preparingText = strings(preparing.registrations[0].component(preparing.registrations[0].registration.inject()))
  assert.ok(preparingText.includes('syncPreparing'), '那一段说"正在读取远端索引…"')
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
  assert.ok(scanning.text.includes('syncScanning:{"current":43,"total":85}'), '预演时说"正在扫描本机会话"')
  assert.equal(scanning.text.includes('previewing'), false, '有具体进度就不摆那句静态的「预演中…」')
  assert.equal(scanning.mounted.recorded.some((node) => node.type === 'table'), false, '计划还没回来，不画表')
  assert.equal(scanning.text.includes('syncProgressNote'), false, '预演阶段还没有东西可覆盖，不摆那句"只增不覆盖"')

  // 读远端索引是一次往返，没有"第几条"可讲（宿主给的分母是 0）：固定一句话，**不摆条**——画一条
  // 1/1 的会让人以为已经做完了，而它其实还在等。
  const remote = phaseOf({ phase: 'remote', done: 0, total: 0 })
  assert.ok(remote.text.includes('syncPreparing'), '读远端索引那一段就说"正在读取远端索引…"')
  assert.equal(remote.bar, undefined, '分母是 0 的那一段不画进度条')

  // 认本机仓库身份：每个候选目录一个 git 进程，真机上这一段比前两段加起来还长。
  const matching = phaseOf({ phase: 'repo', done: 4, total: 13 })
  assert.ok(matching.text.includes('syncMatchingRepos:{"current":5,"total":13}'), '认仓库时说的是"正在核对本机仓库"')

  // 比对内容：分母是两边都有那些会话的文件数。
  const comparing = phaseOf({ phase: 'compare', done: 7, total: 12 })
  assert.ok(comparing.text.includes('syncComparing:{"current":8,"total":12}'), '比对时说的是"正在比对内容"')
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
  const open = mounted.recorded.find((node) => node.type === 'button' && node.props?.children === 'syncAction')
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
