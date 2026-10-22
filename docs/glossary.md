# 术语表

这份表回答一个问题：**这个词官方怎么说、我该照着写什么、别写什么、出处在哪。**

判据不是印象：每条「官方说法」都在官方包里或在官方文档站上核过，出处写在最后一列。官方包指
`@deepseek-ai/*` 发布出来的中文文案（界面文案就在各包的 `lib/client.js` 里），官方文档站是
<https://deepseek-harness.github.io/deepseek-harness/>。中英双语以中文为准，英文那份跟着它译。

写代码、写注释、写界面文案、写文档都是这一套。**表里「别写」那一列出现的词，新写的东西一律不用**——
旧提交里的原话留着，不回头改。

| 概念 | 官方说法 | 别写 | 出处 |
| --- | --- | --- | --- |
| 插件包的两侧 | **Host 半侧 / 浏览器半侧**（英文 Host half / browser half） | 半边、客户端侧、Host 侧 | 官方文档 [新增设置卡片](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)（web-client 页里另有一种写法「Host 侧 / Client 侧」，本仓库跟 cookbook 那一种） |
| 宿主进程（跑插件的那个 DSH 进程） | **宿主**（Host） | 宿主机、主进程 | 官方文档 [Web Client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client) 与各子系统页；注意官方**界面文案**里不出现这个词，给用户看的句子说具体的事（「存进 DSH 的凭据」，不说「宿主凭据库」） |
| 会话里发生的事 | **事件**（官方代码里是 `SessionEvent`，即 `session/event`） | 会话事件（内部叫法，界面别用） | 官方文档 [会话](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session)：「由类型化 SessionEvent 组成的仅追加日志」 |
| 会话的一轮 | **轮次 / 第 N 轮** | 回合 | 官方界面：`dsh-client-ui-trajectory` 的「轮次」「展开所有轮次」、`dsh-client-ui-chat` 的「第 {turn} 轮」 |
| 子会话 | **子智能体**（英文 subagent） | 子代理、子 agent | 官方包中文文案里「子智能体」出现 39 次，「子代理」0 次 |
| 插件的目录结构 | **项目目录**（宿主 `projectDir(root, cwd)`） | 桶、分桶 | 官方接口命名；本仓库 `src/registry.ts` 用它 |
| 会话清单 | **注册表** | 账本 | 官方文档的 session registry；本仓库 `src/registry.ts` |
| 工作树里的目录 | **工作区**（英文 workspace） | 空间、房间 | 官方界面「工作区」「添加工作区」 |
| 结束态的会话 | **归档 / 取消归档** | 收起来、封存 | 官方界面「归档会话」「显示已归档」 |
| 挂载点（插件往宿主挂东西的位置） | **`Slot`**（官方保留英文） | 槽位 | 官方文档 [客户端 Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots) |
| 同步的两个方向 | **拉取 / 推送** | 拉下来、推上去、上传下载（指会话时） | 本仓库自己的功能，官方没有；两个方向必须成对用，单字「拉 / 推」也不用 |
| 文件真的进出浏览器 | **下载 / 上传**（导出包、导入包、附件对象） | ——（这里就是浏览器的下载与上传，不是同步方向，照写） | 本仓库的「导出 / 导入」两节（README）；官方文档站没有这一层，因为它就是浏览器行为 |
| 没在干活的那段时间 | **空闲**（英文 idle）；资源没在用叫**闲置** | 静默（时段） | 官方界面「Agent 空闲时可输入 /compact 手动压缩」「默认在闲置后释放模型内存」 |
| 出错也不吭声 | **静默**（静默降级、静默丢弃、静默截断、静默规范化） | —— | 官方文档：「静默规范化」「静默截断」。这个词只表示「不报错」，**不表示「安静了一段时间」** |
| 崩了之后接着写的那一层 | **检查点**（flush 检查点） | 存档点、恢复点 | 官方文档 [持久化](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/persistence)：「flush 检查点」 |
| 智能体的本体 | **智能体**（英文 agent；官方界面里「Agent 预设」保留英文） | AI、机器人 | 官方文档：「Session 是一份由类型化 SessionEvent 组成的仅追加日志，是 agent（智能体）…」 |
| 设置页两侧的配对方式 | **Host 半侧 / 浏览器半侧** + 命名空间 | 前后端 | 官方文档 [新增设置卡片](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card) |

## 加新词的时候

1. 先在上表里找有没有现成说法；有就照它写，没有再加一行。
2. 「官方说法」那一列必须能在官方包的中文文案或官方文档站上找到原文，出处填**哪一页 / 哪个包**，
   不写「官方就是这么说的」。
3. 「别写」那一列写清**为什么不写**（旧词？另一个意思？界面里不出现？），否则下一个人还会写回去。
4. 一个词如果只在内部讲得通、用户看不懂（比如「会话事件」「宿主」），就把它关在代码与文档里：界面
   文案说具体的事，不搬内部叫法。
