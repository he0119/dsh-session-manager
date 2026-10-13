# Agent Note: 重新生成名称——临时把会话挂回宿主，才问得到名称服务

Status: implemented

## Problem

历史会话的标题会停在**确定性兜底名称**上（首句前五个词、或 40 字节），而且大多不会被自动修好：

- 名称 provider 跟随会话主模型时，一次标题调用要真的跑一遍模型；本机路由（`workbuddy-responses`）
  关不掉思考，实测思考段落 143–491 token，provider 的 `maxOutputTokens` 给到 64 就必然返回空正文，
  宿主抛 `session/title-llm: title output reached maxOutputTokens`、不写 `session/title`，停在兜底；
- 含网址的首句特别长（中位 9151 字节，96 字节的那批是普通句子），兜底按 40 字节切，于是标题变成
  半截 URL（`你应该参考 https://github.com/he011`）——看起来就像"标题没生成"；
- 这两条本机配置都改了（`optional-session-title-all-prompts` 给到 1024/65536），但**已经存在的**那些
  会话不会因此重算：`all-prompts` 只在"又有新的用户消息"时修订一次。

**为什么不能在插件里直接算**：名称服务的显式入口 `ctx.sessionTitle.refresh(session)` 只认**活会话**
（它第一件事就是 `sessions.get(id) !== session` 就抛），而这里要处理的是整库里几百条早已不在宿主内存
里的会话。第二条路是逐条 `agents.resume()` 把它们真的开起来——那要给每条会话建一整套 agent（预设、
工具、审批策略），没有对应的卸载面，还会往日志里写进"这条会话被谁用什么预设打开过"那类事件：为了
换个标题，代价与后果都不成比例。

## Decision

给这个插件加一条宿主端口 **`titleRefreshPort()`**（`src/tools.ts`），它自己完成一次**临时挂载**：

1. `sessionQuery.readSession(id)` 把日志整份读完并校验（不建活会话，与补检查点那条路同一个调用）；
2. `sessions.prepare(id, { seed, meta: header, inheritedEventCount, eventState: 'detached' })` 用宿主
   自己的重放构造器还原出 Session——还原出来的 header 与投影状态就是盘上那一个；
3. `sessionPersistence.open(id, 'write')` **先开写句柄**：会话的 append 只按 id 路由给已登记写句柄的
   那一条（`dsh-session-persistence-jsonl` 的 `install()`），没有句柄时新标题只活在内存里，
   摘掉就没影了——"报成功却没落盘"比不做更糟；
4. `sessions.enter()`（返回的正是卸载用的 disposer）+ `sessions.announce()`：宿主公开**成对**的挂载
   原语，`dsh-agent-loop` 的会话创建事务也是这么用的；
5. `sessionTitle.refresh(session)` 重算，随后 `sessions.flush(session)` 把新标题冲进日志；
6. 无论成败，`handle.close()`（先）与 `detach()`（后）把两件都还回去。

会话**已经在内存里**（用户正开着那条）时走另一条路：直接对那条活会话重算，不挂不摘、也不碰写句柄
（写句柄按 id 独占，抢来开第二个会抛 `AlreadyOwned`）。

围绕这一条端口的三件事各有各的地方：

- **谁不该动**（`src/retitle.ts`，零 DSH 依赖、可单测）：子智能体会话跳过（名称在侧边栏里看不见）；
  用户手动改过名的跳过（`source.kind === 'user'`，一次批量动作不该抹掉用户起的名字）；点名了但不在库
  里的记 `not-found`；没有过主模型请求的记 `no-request-route`（那是"本来就无从取名"，不是失败）。
- **怎么报**（`POST /dsh-session-manager/api/retitle`，事件流）：改了 / 算过但没变 / 跳过（附原因）/
  失败（附宿主原话）四类分开，`ok` 只反映失败；能力缺席时流开始之前回 409，空清单回 400。
- **界面**（会话页动作行那一枚「重新生成名称」）：作用于已勾选的会话，跳过按原因合并计数说出来
  （"跳过 5 条：你手动改过名"），`/state` 的 `retitleAvailable` 决定按钮能不能点。
- **`includePinned`**（接口字段，界面刻意不提供）：默认跳过 `user` 源，但"名称是脚本或导入写下的"
  那种 `user` 源并不是用户亲手起的名字，一次性清理时要能连它们一起重算，所以编排层与端口都按这个显式
  选项放行。它**不是**"删除 `user` 源"：`session/title` 是 append-only 的事件、宿主按 seq 连续性校验
  （没有删除事件这回事，抽掉一条就是撕裂），所以让钉失效的唯一做法是**再写一条更新的标题把它顶掉**
  ——provider 源的标题一落，宿主 `onUserMessage()` 里那句"见到 user 源就不再自动修订"的短路自然解除。
  这也正是 `refresh()` 被写成 unpin 路径的原因：只有自动那条路拦 `user` 源，显式重算不拦，provider 端
  也只把 **provider** 源的旧标题当锚点（所以 `user` 源那条一定会换出新标题）。

## Alternatives considered

- **离线直接往日志里追一条 `session/title`**：省掉整条挂载路径，但要复刻 provider 的输入框架与提示词
  才写得出等价的标题，而 `source.kind` 一旦写成 `user` 就等于把这条会话**钉死**（之后所有自动修订都
  不再生效）。重算的定义是"请真正的 provider 再算一次"，不是在插件里伪造一个它的结果。
- **逐条 `agents.resume()`**：语义最正式，但每条会话要建一整套 agent 且没有卸载面，批量跑等于同时开
  几十条会话；还会把 agent 预设那类事件写进历史会话的日志。
- **给历史会话补一条假的用户消息**，让 `all-prompts` 自然触发：改写了用户的历史（会话里会出现一条
  他从没说过的话），是这里最不能接受的一种。
- **让用户逐条打开会话再说一句话**：这正是这个功能要消掉的手工活（本机 587 个日志、其中几百条停在
  兜底名称上）。
- **不跳过 `user` 源**：一次"全选 + 重新生成"就会把用户自己起过的名字全部覆盖。要覆盖时他去重命名
  那条会话，比在这里留一个"连用户的名字也一起改"的批量按钮安全。

## Consequences

- **每条会话的代价是"整份解一次日志 + 一次模型调用"**（本机实测：6MB 日志 ≈1.7 秒，模型 2–3 秒），
  所以编排层**顺序**跑并逐条报进度，不并发——并发等于同时挂 N 条会话、按各自主模型发 N 个请求。
- **这条端口是第一个"临时挂一条不属于自己的会话"的地方**：副作用靠"还原出来的 header 就是盘上那一
  个"压住——`permission-presets` 只在 `preset/sandbox/approval` 全空时才补写事件（还原出来的会话三样
  都有，因此不动），`dsh-session-projection` 会为新挂载的会话惰性折出 `titleInput`（名称服务正需要
  它），`dsh-api-session-controller` 只处理它自己 `target` 那一条。释放路径走的是宿主成对的
  `enter`/`detach`，所以宿主的会话表在动作前后逐条相同。
- **写句柄是硬要求**：`sessionPersistence.open` 拿不到就当"这个宿主没有这个能力"（`/state` 报
  `retitleAvailable: false` 并说明原因），而不是跑一遍"算好了但没写下去"的动作。
- **要落地就有进度**：勾十条会话是半分钟量级，因此这一枚按钮与归档 / 删除 / 迁移 / 同步共用
  [同一条事件流](../architecture/2026-10-08-every-long-action-streams-progress.md)。
- 端口与编排各有一份用例钉住行为（`test/tools.test.ts` 的顺序断言、`test/retitle.test.ts` 的分类、
  `test/retitleNotes.test.ts` 的文案），四类跳过与失败都按"改一处就该红一条"的方式定过位。
- **本机实测（web-dev 实例 :3081，2026-10-12）**：两条停在兜底名称上的历史会话（`你好` 16 KB、
  `你能做什么？` 25 KB）各一次调用后落成 `问候` 与 `AI助手能做什么`；解日志核对，最后一条
  `session/title` 的 `source.kind = provider`、provider 为 `session-title-all-prompts-llm`——
  **落盘**的，不是只在内存里。动作之后 `/state` 里这两条都是 `live: false`（临时挂载都还回去了），
  该库 5 份日志的 seq 连续性审计全绿（`~/.dsh/titlefix/retitle-verify.mjs` 与 `audit-logs.mjs`）。
