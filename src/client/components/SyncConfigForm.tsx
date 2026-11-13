/**
 * 「同步设置」表单：URL、机器名、账号、密码、超时、自动推送与映射表，直接改 profile 里那一节。
 *
 * 挂在**插件页**那张配置卡里（`plugins.bundle.config`，见 PluginConfigCard）：配置一年改两次，操作用天天
 * 用，分开之后改完不用再滚过十来个字段才按到「同步」。
 * 读写面在 [syncForm.ts](./syncForm.ts)（宿主的设置接缝），密码的写入面在
 * [credentials.ts](./credentials.ts)（宿主的凭据服务），这里只管画与暂存。
 *
 * 四条刻意的取舍：
 *   - **保存是显式的**：输入框只改草稿，按「保存」才写。写下去的是用户层（设置对话框里那份配置
 *     文档），逐字提交会让每次击键都变成一次文档写入，而用户根本没法预览自己写了什么；
 *   - **只提交改动过的字段**：没动过的字段不发编辑，否则用户层里会攒下一堆"等于默认值"的覆盖，
 *     界面上那些字段从此都顶着「已覆盖」徽标（判据见 syncForm.ts 的 draftOps）；
 *   - **密码直接输入、值不进配置**：那个框是 `type=password` 的官方 `Input`（旁边的状态标签说明配没
 *     配），保存时
 *     把输入的密码写进宿主凭据库（`remote.credentials` 的 `set`），配置里只有引用名——与 DSH 自己
 *     的口径一致（配置携带引用，值归凭据提供方）。所以那个框永远从空白开始：没有任何一条读路径会把
 *     值送回来，界面只能报"配没配、能不能写"（`describe`）。留空 = 不动已存的那一个；
 *   - **引用名不在这张表单上**：`sync.passwordRef` 属于插件配置（在插件配置页那份 volatile 表单里改），
 *     卡片只问"密码是什么"——官方那几个要密钥的卡片也是这个分法（网页搜索那张卡只摆密钥，`apiKeyEnv`
 *     留在配置里）。引用名缺席时按 `DSH_DAV_PASSWORD` 解析，见 syncForm.ts 的 `passwordRefOf`；
 *   - **映射表是一行一行的**：远端 cwd 与本机目录各一个输入框，行可以增删。远端那一侧必须**逐字**
 *     对上别的机器记下的 cwd，所以它带一份从上次同步的计划里收来的候选（`remoteCwds`）——这些路径靠人背
 *     是靠不住的，抄错一个字符就是"没配映射，跳过"。
 *
 * @module dsh-session-manager/client/SyncConfigForm
 */

import * as React from 'react'

import { Button, Input, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import { testSync, type SyncTestResponse } from '../api.ts'
import { getCredentialsApi, type CredentialInfo } from '../credentials.ts'
import {
  draftFrom,
  draftProblems,
  getSyncConfigApi,
  passwordRefOf,
  savePlan,
  syncSectionOf,
  testVerdict,
  type MappingProblem,
  type MappingRow,
  type SyncDraft,
  type SyncFormSnapshot,
} from '../logic/syncForm.ts'
import type { Translate } from '../logic/locales.ts'

/** 问题的文案：码 → 句子（这一层才有语言）。 */
function problemText(problem: MappingProblem, t: Translate): string {
  switch (problem.code) {
    case 'mapNoFrom':
      return t('sync.map.noFrom', { line: problem.line })
    case 'mapNoTo':
      return t('sync.map.noTo', { line: problem.line })
    case 'mapDuplicate':
      return t('sync.map.duplicate', { line: problem.line, from: problem.from })
  }
}

/**
 * 一行设置：左边是标签与它的说明，右边是输入框。
 *
 * 形状照 `dsh-context` 那张插件页配置卡（`.lc-settings-row`）：标签占满左侧、控件靠右，一行一件事；
 * 说明压在标签下面（12px 灰字），不占右侧那一列。输入框本身仍是官方 `Input`——外观归控件库，这里只
 * 决定它摆在哪、多宽。
 */
function SettingRow({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string
  hint: string
  value: string
  onChange: (text: string) => void
  placeholder?: string
}): React.ReactElement {
  return (
    <label className="dsm-settingRow">
      <span className="dsm-settingText">
        <span className="dsm-settingLabel">{label}</span>
        <span className="dsm-settingNote">{hint}</span>
      </span>
      <Input
        className="dsm-settingInput"
        type="text"
        value={value}
        placeholder={placeholder ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

/**
 * 一行「密码」：形状与别的行一样（标签与说明在左、控件在右），控件是 `type=password` 的官方 `Input`，
 * 标签旁边多一枚状态标签（已配置 / 未设置）。
 *
 * 为什么不用控件库的 `SettingsSecretField`：那个是一个**整块的字段**（自己画标签、徽标、输入框、说明
 * 四层，竖着排），放进这张横排的卡里就是唯一一行长得不一样的东西——左列空着、控件占满整行。它的语义
 * （只写、留空即保留、关掉自动填充）本页自己就有：值不进响应，留空时保存不写 `password`。
 */
function SecretRow({
  id,
  label,
  hint,
  text,
  stateLabel,
  configured,
  disabled,
  onEdit,
}: {
  id: string
  label: string
  hint: string
  text: string
  stateLabel: string
  configured: boolean
  disabled: boolean
  onEdit: (text: string) => void
}): React.ReactElement {
  return (
    <label className="dsm-settingRow" htmlFor={id}>
      <span className="dsm-settingText">
        <span className="dsm-settingLabelRow">
          <span className="dsm-settingLabel">{label}</span>
          <Tag className="dsm-tag" tone={configured ? 'neutral' : 'quiet'}>
            {stateLabel}
          </Tag>
        </span>
        <span className="dsm-settingNote">{hint}</span>
      </span>
      <Input
        id={id}
        className="dsm-settingInput"
        type="password"
        autoComplete="new-password"
        value={text}
        disabled={disabled}
        onChange={(event) => onEdit(event.target.value)}
      />
    </label>
  )
}

/**
 * 同步设置表单。
 *
 * `overridden` 是"用户层里已经有了这一项"——它不比较值，因为一个等于默认值的覆盖仍然是覆盖。
 * 用户点了「恢复默认」之后那个徽标才会消失。
 */
export function SyncConfigForm({
  t,
  onSaved,
  remoteCwds = [],
  machineDefault,
}: {
  t: Translate
  onSaved?: () => void
  /** 上次同步的计划里见过的远端 cwd：给"远端"那一栏当候选，省得手抄一条长路径。 */
  remoteCwds?: readonly string[]
  /**
   * 机器名那一栏的**缺省值**（宿主解析出来的：没配就是主机名）。
   *
   * 那一栏留空不等于"没有机器名"——宿主会拿主机名顶上，所以灰字要把它写出来，与「超时」那一栏的
   * 30000 同一个口径。卡片标题原来也印一遍这个名字，现在只在这里认。
   */
  machineDefault?: string
}): React.ReactElement | null {
  const api = getSyncConfigApi()
  // 凭据服务每次渲染现取：它由别的客户端插件提供，可能晚于本页挂载（取到的那一组方法见
  // credentials.ts）。宿主没提供时那个密码框不画，只说明"密码只能走环境变量"。
  const credentials = getCredentialsApi()
  const [snapshot, setSnapshot] = React.useState<SyncFormSnapshot | undefined>(api?.getSnapshot())
  const [draft, setDraft] = React.useState<SyncDraft | undefined>(undefined)
  const [password, setPassword] = React.useState('')
  const [credential, setCredential] = React.useState<CredentialInfo>({ configured: false, writable: true })
  // 写完一次密码要重问一次 `describe`（值不回来，只有那个"配没配"的徽标要跟着变）。
  const [credentialGen, setCredentialGen] = React.useState(0)
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  /** 宿主拒了这一笔凭据写入时的原话（例如引用被启动环境里的值遮住）。 */
  const [credentialError, setCredentialError] = React.useState<string | undefined>(undefined)
  // 「测试连接」：结果只用 `null` 当"还没测过"，好让冒烟用例把这个状态种出来（见 test/client.test.mjs）。
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<SyncTestResponse | null>(null)
  /** 那次测试请求本身没走通（宿主没配同步、连接断了）时的原话；与上面的"测出来的结论"是两件事。 */
  const [testError, setTestError] = React.useState<string | undefined>(undefined)

  // 订阅：宿主那边配置一变（别处改了同一份文档、或保存被接受）就重新投影。没装读写面时订阅不了，
  // 也就没有别的来路会改这一份，因此不必假装订阅。
  React.useEffect(() => {
    if (api === undefined) return undefined
    return api.subscribe(() => setSnapshot(api.getSnapshot()))
  }, [api])

  // 磁盘上的值变了、而用户没有草稿时，草稿跟着走；有草稿就不动它（正在输入的东西不能被远端覆盖）。
  const section = syncSectionOf(snapshot)
  React.useEffect(() => {
    setDraft((current) => current ?? draftFrom(syncSectionOf(api?.getSnapshot())))
  }, [api, section.url, section.machineId, section.username, section.timeoutMs, section.mapping])

  // 密码写进哪个引用名由**插件配置**决定（表单上没有那一栏，与官方那些要密钥的卡片同一个口径：
  // 卡片问"密码是什么"，"放在哪个名字下"是配置的事）。配置里换了引用名，下一帧就按新名字问状态。
  const passwordRef = passwordRefOf(section)
  React.useEffect(() => {
    if (credentials === undefined) return undefined
    let live = true
    void credentials.describe([passwordRef]).then(
      (result) => {
        if (!live) return
        // 问不到（宿主没装凭据提供方、连接刚断）：按"没配、写得进去"画，写入那一步会给出原话。
        const info = result.ok ? result.value[passwordRef] : undefined
        setCredential({ configured: info?.configured ?? false, writable: info?.writable ?? true })
      },
      () => {
        if (live) setCredential({ configured: false, writable: true })
      },
    )
    return () => {
      live = false
    }
  }, [credentials, passwordRef, credentialGen])

  if (api === undefined || snapshot === undefined) {
    return <p className="dsm-hint">{t('sync.form.unavailable')}</p>
  }
  if (snapshot.status === 'loading') return <p className="dsm-hint">{t('sync.form.loading')}</p>
  if (snapshot.status !== 'ready') return <p className="dsm-hint">{t('sync.form.unavailable')}</p>

  const view = draft ?? draftFrom(section)
  const problems = draftProblems(view)
  /**
   * 三档各自的说明：同一行里只换这一段（控件本身不动，用户按一下就知道这一档会做什么）。
   *
   * 「双向」那句最长，因为它是唯一会动本机的一档——覆盖、备份、跳过正在开着的，三件事必须说清。
   */
  const autoHint =
    view.auto === 'off'
      ? t('sync.field.autoHintOff')
      : view.auto === 'push'
        ? t('sync.field.autoPushHint')
        : t('sync.field.autoSyncHint')
  /** 草稿一动，上一次的测试结论就过期了：它说的是当时那份已保存的配置。 */
  const clearTest = (): void => {
    setTestResult(null)
    setTestError(undefined)
  }
  const edit = (patch: Partial<SyncDraft>): void => {
    setFailed(false)
    clearTest()
    setDraft({ ...view, ...patch })
  }
  /** 改第 n 行的一侧；留空由保存前的校验去挡（不是每敲一下就报错）。 */
  const editMapping = (index: number, patch: Partial<MappingRow>): void => {
    setFailed(false)
    clearTest()
    setDraft({ ...view, mapping: view.mapping.map((row, at) => (at === index ? { ...row, ...patch } : row)) })
  }
  const addMapping = (): void => {
    setFailed(false)
    clearTest()
    setDraft({ ...view, mapping: [...view.mapping, { from: '', to: '' }] })
  }
  const removeMapping = (index: number): void => {
    setFailed(false)
    clearTest()
    setDraft({ ...view, mapping: view.mapping.filter((_row, at) => at !== index) })
  }
  const editPassword = (text: string): void => {
    setFailed(false)
    setCredentialError(undefined)
    clearTest()
    setPassword(text)
  }
  const discard = (): void => {
    setFailed(false)
    setCredentialError(undefined)
    clearTest()
    setPassword('')
    setDraft(undefined)
  }
  // 一次保存要发的两件事一起算（见 syncForm.ts 的 savePlan）：配置文档里的编辑，以及要写进宿主
  // 凭据库的那一笔密码。密码走的是另一条通道，所以这里不是"多一个字段"而是"多一件事"。
  const plan = savePlan(view, section, password, credentials !== undefined)
  const dirty = plan.ops.length > 0 || plan.password !== undefined
  const canSave = snapshot.writable && dirty && problems.length === 0 && !saving

  // 「测试连接」测的是**已保存的**配置：宿主的运行时按配置现读（密码也从凭据库里现解析），所以草稿
  // 还没保存时先别测——否则会拿旧地址、旧密码测出一个结论，而用户以为测的是刚敲进去的那一份。
  const canTest = !dirty && !saving && !testing && view.url.trim() !== ''
  const testConnection = (): void => {
    if (!canTest) return
    setTesting(true)
    setTestError(undefined)
    setTestResult(null)
    void testSync().then(
      (result) => {
        setTesting(false)
        setTestResult(result)
      },
      (error: unknown) => {
        setTesting(false)
        setTestError(error instanceof Error ? error.message : String(error))
      },
    )
  }
  // 结论码 → 句子：判定在宿主侧，句子在字典里（见 syncForm.ts 的 testVerdict）。
  const verdict = testResult === null ? undefined : testVerdict(testResult, passwordRef)

  const save = (): void => {
    if (!canSave) return
    setSaving(true)
    setFailed(false)
    setCredentialError(undefined)
    void (async () => {
      try {
        // 配置先写：它被拒时（版本冲突、值非法）密码也先别存——两份改动是一起按下的。
        if (plan.ops.length > 0) {
          const accepted = await api.mutate(plan.ops, snapshot.revision)
          // 被接受：草稿落回"跟随磁盘"（下一次投影就是刚写下的值）；被拒：留着草稿，让用户自己看。
          if (!accepted) {
            setFailed(true)
            return
          }
          setDraft(undefined)
          // 配置变了，上一次的测试结论说的是旧的地址/机器名：清掉，别让两句话并排摆着。
          clearTest()
        }
        if (credentials !== undefined && plan.password !== undefined) {
          const written = await credentials.set(plan.password.ref, plan.password.value)
          if (!written.ok) {
            // 宿主拒了就说它的原话（引用被环境遮住、文档只读…），并且留着输入的内容让用户改。
            setCredentialError(written.error.message)
            setFailed(true)
            return
          }
          setPassword('')
          setCredentialGen((generation) => generation + 1)
          clearTest()
        }
        // 让外面重读一次宿主状态：第一次配好 URL 时，同步卡片上那个「同步」按钮是照着 /state 画的，
        // 不重读就还是"没配置"的样子（用户刚存完却看不见按钮，会以为没生效）。
        onSaved?.()
      } catch {
        setFailed(true)
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <div className="dsm-syncForm">
      <SettingRow
        label={t('sync.field.url')}
        hint={t('sync.field.urlHint')}
        value={view.url}
        onChange={(url) => edit({ url })}
        placeholder="https://dav.example.com/dsh"
      />
      <SettingRow
        label={t('sync.field.machine')}
        hint={t('sync.field.machineHint')}
        value={view.machineId}
        onChange={(machineId) => edit({ machineId })}
        // 留空时宿主用主机名顶上：把那个名字写成灰字，用户才知道"空着会叫什么"。
        placeholder={machineDefault ?? ''}
      />
      <SettingRow
        label={t('sync.field.timeout')}
        hint={t('sync.field.timeoutHint')}
        value={view.timeoutMs}
        onChange={(timeoutMs) => edit({ timeoutMs })}
        placeholder="30000"
      />
      <SettingRow
        label={t('sync.field.user')}
        hint={t('sync.field.userHint')}
        value={view.username}
        onChange={(username) => edit({ username })}
      />
      {credentials === undefined && <p className="dsm-hint">{t('sync.password.unavailable')}</p>}
      {credentials !== undefined && (
        <SecretRow
          id="dsm-dav-password"
          label={t('sync.field.password')}
          hint={credential.writable ? t('sync.field.passwordHint') : t('sync.password.shadowed')}
          text={password}
          disabled={!snapshot.writable || !credential.writable}
          configured={credential.configured}
          stateLabel={credential.configured ? t('sync.password.set') : t('sync.password.unset')}
          onEdit={editPassword}
        />
      )}
      <div className="dsm-settingColumn">
        <span className="dsm-settingText">
          <span className="dsm-settingLabel">{t('sync.field.mapping')}</span>
          <span className="dsm-settingNote">{t('sync.field.mappingHint')}</span>
        </span>
        {view.mapping.length === 0 && <span className="dsm-settingNote">{t('sync.field.mappingEmpty')}</span>}
        {view.mapping.length > 0 && (
          <div className="dsm-mapRows">
            {view.mapping.map((row, index) => (
              <div className="dsm-mapRow" key={index}>
                <Input
                  className="dsm-settingInput"
                  type="text"
                  list={remoteCwds.length > 0 ? 'dsm-mapRemoteCwds' : undefined}
                  aria-label={t('sync.map.remoteLabel', { line: index + 1 })}
                  placeholder="/home/alice/dev/proj"
                  value={row.from}
                  onChange={(event) => editMapping(index, { from: event.target.value })}
                />
                <span className="dsm-mapArrow" aria-hidden="true">
                  →
                </span>
                <Input
                  className="dsm-settingInput"
                  type="text"
                  aria-label={t('sync.map.localLabel', { line: index + 1 })}
                  placeholder="/opt/work/proj"
                  value={row.to}
                  onChange={(event) => editMapping(index, { to: event.target.value })}
                />
                {/* 删掉这一行映射：只改草稿，不动已保存的配置。 */}
                <Button variant="outline" size="sm" onClick={() => removeMapping(index)}>
                  {t('sync.map.remove')}
                </Button>
              </div>
            ))}
          </div>
        )}
        {remoteCwds.length > 0 && (
          <datalist id="dsm-mapRemoteCwds">
            {remoteCwds.map((cwd) => (
              <option key={cwd} value={cwd} />
            ))}
          </datalist>
        )}
        <div className="dsm-controls">
          {/* 加一行空映射：动作行上的动作，走官方 outline。 */}
          <Button variant="outline" size="sm" onClick={addMapping}>
            {t('sync.map.add')}
          </Button>
        </div>
      </div>

      {/*
       * 自动那一档摆在**最后**：前三栏是"怎么连"（URL / 机器标识 / 超时），中间是"怎么认证"，再下面
       * 是"落地到哪"（路径映射）——这三组说的是"这条通道是什么"。自动不一样，它说的是"连上之后让它自己
       * 怎么跑"，是另一件事；夹在连接参数与认证之间会把那一组自然的分组切成两半。
       *
       * 摆最后还有个位置上的好处：它紧挨着「保存」，而它是个**存了才生效**的选择（生效与否由宿主按已
       * 保存的那两栏判，草稿里改了不保存也没用）。
       *
       * 没有"间隔"那一栏：什么时候跑由安静窗口决定（本机停手 5 分钟），不是一个可调的周期（见
       * [那篇决策](../../../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)
       * 与 [等安静之后再跑](../../../.agents/notes/implemented/bug-fix/2026-10-22-auto-push-waits-for-quiet.md)）。
       */}
      {/*
       * 自动那一档：**一行、三选一**（关闭 / 仅推送 / 双向）。
       *
       * 为什么不是两个开关：它们不是并列的两件事，而是同一件事的强弱三档。两个开关摆在一起，用户得先
       * 猜"两个都开算哪个"，界面上还得为此加一句"已由另一个包含"的说明——一个分段控件直接把三档摆出来
       * 就没有这个中间态。写进配置的仍是那两栏（`autoPush` / `autoSync`），由 `logic/syncForm.ts` 按时
       * 转成最小的编辑。
       *
       * 控件用官方 `SegmentedControl`（`role="tablist"` 那一套）：它是设置页里"三选一"的现成原语。
       */}
      <div className="dsm-toggleRow">
        <div className="dsm-toggleText">
          <div className="dsm-toggleTitle">{t('sync.field.auto')}</div>
          <div className="dsm-toggleDesc">{autoHint}</div>
        </div>
        <SegmentedControl
          id="dsm-auto-mode"
          value={view.auto}
          disabled={!snapshot.writable}
          label={t('sync.field.auto')}
          options={[
            { value: 'off', label: t('sync.field.auto.off') },
            { value: 'push', label: t('sync.field.auto.push') },
            { value: 'sync', label: t('sync.field.auto.sync') },
          ]}
          onChange={(next) => edit({ auto: next as SyncDraft['auto'] })}
        />
      </div>
      {/*
       * 动作行：保存是**写**（配置 + 凭据库、作用于草稿），「测试连接」紧跟它——它测的是**已保存**的
       * 配置，所以按完保存、草稿一干净，这枚按钮就在原地当场变成可用。
       *
       * 不把它摆到表单最上面去：那样在"第一次配"这条路上根本用不了——地址还没存过，`canTest` 先是
       * 假的，用户得填完、存好、再翻回最上面去按；「只读工具」这条口径是给「刷新 / 全选」那种**列表**
       * 工具留的，而这一枚是**配置校验**，它的输入就是刚存下去的那份配置，摆在哪一步之后是明确的。
       */}
      <div className="dsm-syncTools">
        <div className="dsm-controls">
          {/* 表单的主动作：写的是配置，走官方 primary。 */}
          <Button variant="primary" size="sm" onClick={save} disabled={!canSave}>
            {saving ? t('sync.form.saving') : t('save')}
          </Button>
          {/*
           * 「测试连接」只读一次远端（PROPFIND）：照样走官方 outline——"不写盘"不是裸着的理由，
           * 内建设置页那枚同样只读的「打开配置文件」正是带边框的（量到 `border: rgba(0, 0, 0, 0.12) 1px`）。
           */}
          <Button variant="outline" size="sm" onClick={testConnection} disabled={!canTest}>
            {testing ? t('sync.test.running') : t('sync.test.action')}
          </Button>
          {/*
           * 丢掉草稿、退回已保存的那份：动作行上的动作，走官方 outline。只在真有草稿时出场——没改动时它是个
           * 永远按不动的按钮，占着主动作旁边的位置却什么都做不了（而且旁边的「未保存」已经把这个
           * 状态说出来了）。
           */}
          {dirty && (
            <Button variant="outline" size="sm" onClick={discard}>
              {t('sync.form.discard')}
            </Button>
          )}
          {!snapshot.writable && <span className="dsm-warn">{t('sync.form.readOnly')}</span>}
          {problems.map((problem) => (
            <span key={problem.code} className="dsm-warn">
              {problem.code === 'mapping' ? problemText(problem.problem, t) : t('sync.field.timeoutInvalid')}
            </span>
          ))}
          {failed && <span className="dsm-warn">{t('sync.form.saveFailed')}</span>}
          {credentialError !== undefined && <span className="dsm-warn">{credentialError}</span>}
          {snapshot.writable && dirty && problems.length === 0 && !failed && <span className="dsm-hint">{t('sync.form.unsaved')}</span>}
        </div>
        {/*
         * 探测的说明与结论紧跟在按钮那一行下面：按一下按钮，答案就该出现在按的地方。这一块留在
         * 动作行里（同一个 dsm-syncTools 子树），由 test/client.test.mjs 按结构钉住。
         */}
        <span className="dsm-hint">{dirty ? t('sync.test.dirty') : t('sync.test.hint')}</span>
        {testError !== undefined && <p className="dsm-warn">{testError}</p>}
        {verdict !== undefined && (
          <p className={testResult?.code === 'ok' ? 'dsm-ok' : 'dsm-warn'}>{t(verdict.key, verdict.params)}</p>
        )}
      </div>

    </div>
  )
}
