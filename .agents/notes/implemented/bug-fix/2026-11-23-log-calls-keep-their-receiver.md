# Agent Note: 往宿主 logger 说话时保留接收者

Status: implemented

## Problem

插件入口把 `ctx.logger` 收成两个本地函数，其中「说一句需要留意的话」写成了
`(logger?.warn ?? logger?.info)?.(message)`。`??` 先把方法算成一个值，后面那次调用就没有接收者了。
Cordis 4.0.4 里 `info` / `warn` 是构造时绑死的箭头函数，怎么调都行；4.1.0 改成了
先调 `this()` 再取同名方法（`this()[type]` 后面接参数）的方法，脱离接收者直接抛
`TypeError: this is not a function`。本包声明的是
`^4.0.4`，这个范围收得下 4.1.0，而宿主装的就是 4.1.0。

现象离原因很远。升级之后第一次启动、目录里还有旧 `state.json` 时，打开存储领域那一步会做一次性迁移：
记录已经导入、旧文件已经改名，接着要打一句「上次同步的记录已从 state.json 搬进存储」——这句话一抛，
外面那层 `catch` 兜住，再打一句失败提示，又抛；`openSyncRunStore()` 的 promise 于是 reject，入口那个
`.then(…, () => {})` 把它吞掉，`syncRunStore` 整个进程都停在空手柄上：页头退回「配没配」，这一进程里
手动同步写下的记录也丢掉。重启一次才恢复（那时迁移已做完，不再走这句话）。领域打不开时的解释也不会
出现在日志里。

测试没抓住，是因为它们传的 `warn` 是普通函数（`(message) => notes.push(message)`），不依赖接收者；
用仓库自己那份 Cordis 4.0.4 跑也复现不了。

## Decision

新增 `src/shared/host/log-lines.ts`：`logLines(logger?)` 收下宿主 logger，交出 `info` / `warn` 两个
函数，两个都写成**成员调用**把接收者留住：

```ts
info: (message) => { logger?.info?.(message) },
warn: (message) => {
  if (logger?.warn !== undefined) logger.warn(message)
  else logger?.info?.(message)
},
```

入口 `src/index.ts` 只拿这两个函数说话，不再自己拼调用方式。回归用例用「方法依赖 `this`」的 logger
（与 4.1.0 同一形状）钉住两件事：两个口子都不抛；没有 `warn` 时退回 `info` 也不抛。另加一条前提用例，
先断言这种 logger 的游离调用确实会抛——否则那条用例哪天就不证明任何东西了。

## Alternatives considered

- **只把 `warn` 那一行改成 `.bind(logger)`**：能修当下这一处，但下一个写日志的人仍可能把 `info` 写成
  取函数值；两个口子收进一个模块，调用方式只有一处可改。
- **保持内联，只写 `logger?.warn ? logger.warn(m) : logger?.info?.(m)`**：正确，但没法单测——`warn` 是
  `apply()` 里的局部闭包，测试只能通过整份 `apply()` 才够得着；抽出来之后用例直接调它。
- **按宿主版本判分支**：为两种 Cordis 写两套调用，等于把宿主版本写进插件；成员调用在 4.0.4 上一样成立。
- **只依赖断言 / 日志观察**：现象是「页头少一句话」，没有人会为此报警；必须让测试在写法退回时变红。

## Consequences

- 升级后第一次启动就能读出迁移进来的记录，页头不再空一整个进程；打开领域失败时的解释也会出现在日志里。
- 往宿主 logger 说话的方式收在一处，以后加日志不会再各自拼 `??`。
- 测试多了一层「方法依赖 `this`」的假 logger，它与宿主 4.1.0 的形状一致；将来 Cordis 再把方法改成别的
  绑定方式，那条前提用例会先红，提醒我们重新判断。
