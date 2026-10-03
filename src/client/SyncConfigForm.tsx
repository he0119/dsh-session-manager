/**
 * 「同步设置」表单：URL、机器名、账号、密码、超时与映射表，直接改 profile 里那一节。
 *
 * 放在「同步」分页的卡片里，与预演/确认挨着——改完 URL 就能立刻预演一次，不必跳到别处。
 * 读写面在 [syncForm.ts](./syncForm.ts)（宿主的设置接缝），密码的写入面在
 * [credentials.ts](./credentials.ts)（宿主的凭据服务），这里只管画与暂存。
 *
 * 四条刻意的取舍：
 *   - **保存是显式的**：输入框只改草稿，按「保存」才写。写下去的是用户层（设置对话框里那份配置
 *     文档），逐字提交会让每次击键都变成一次文档写入，而用户根本没法预览自己写了什么；
 *   - **只提交改动过的字段**：没动过的字段不发编辑，否则用户层里会攒下一堆"等于默认值"的覆盖，
 *     界面上那些字段从此都顶着「已覆盖」徽标（判据见 syncForm.ts 的 draftOps）；
 *   - **密码直接输入、值不进配置**：那个框是官方控件库的只写控件（`SettingsSecretField`），保存时
 *     把输入的密码写进宿主机凭据库（`remote.credentials` 的 `set`），配置里只有引用名——与 DSH 自己
 *     的口径一致（配置携带引用，值归凭据提供方）。所以那个框永远从空白开始：没有任何一条读路径会把
 *     值送回来，界面只能报"配没配、能不能写"（`describe`）。留空 = 不动已存的那一个；
 *   - **引用名不在这张表单上**：`sync.passwordRef` 属于插件配置（在插件配置页那份 volatile 表单里改），
 *     卡片只问"密码是什么"——官方那几个要密钥的卡片也是这个分法（网页搜索那张卡只摆密钥，`apiKeyEnv`
 *     留在配置里）。引用名缺席时按 `DSH_DAV_PASSWORD` 解析，见 syncForm.ts 的 `passwordRefOf`；
 *   - **映射表是一行一行的**：远端 cwd 与本机目录各一个输入框，行可以增删。远端那一侧必须**逐字**
 *     对上别的机器记下的 cwd，所以它带一份从上次预演里收来的候选（`remoteCwds`）——这些路径靠人背
 *     是靠不住的，抄错一个字符就是"没配映射，跳过"。
 *
 * @module dsh-session-manager/client/SyncConfigForm
 */

import * as React from 'react'

import { SettingsSecretField } from '@deepseek-ai/dsh-client-ui-primitives'

import { testSync, type SyncTestResponse } from './api.ts'
import { getCredentialsApi, type CredentialInfo } from './credentials.ts'
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
} from './syncForm.ts'
import type { Translate } from './locales.ts'

/** 问题的文案：码 → 句子（这一层才有语言）。 */
function problemText(problem: MappingProblem, t: Translate): string {
  switch (problem.code) {
    case 'mapNoFrom':
      return t('syncMapNoFrom', { line: problem.line })
    case 'mapNoTo':
      return t('syncMapNoTo', { line: problem.line })
    case 'mapDuplicate':
      return t('syncMapDuplicate', { line: problem.line, from: problem.from })
  }
}

/** 一行「标签 + 输入框」。 */
function Field({
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
    <label className="dsm-field">
      <span className="dsm-fieldLabel">{label}</span>
      <input
        className="dsm-input"
        type="text"
        value={value}
        placeholder={placeholder ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="dsm-hint">{hint}</span>
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
}: {
  t: Translate
  onSaved?: () => void
  /** 上次预演里见过的远端 cwd：给"远端"那一栏当候选，省得手抄一条长路径。 */
  remoteCwds?: readonly string[]
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
    return <p className="dsm-hint">{t('syncFormUnavailable')}</p>
  }
  if (snapshot.status === 'loading') return <p className="dsm-hint">{t('syncFormLoading')}</p>
  if (snapshot.status !== 'ready') return <p className="dsm-hint">{t('syncFormUnavailable')}</p>

  const view = draft ?? draftFrom(section)
  const problems = draftProblems(view)
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
  // 一次保存要发的两件事一起算（见 syncForm.ts 的 savePlan）：配置文档里的编辑，以及要写进宿主机
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
        // 让外面重读一次宿主状态：第一次配好 URL 时，同步卡片上的预演/确认按钮是照着 /state 画的，
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
      <Field
        label={t('syncFieldUrl')}
        hint={t('syncFieldUrlHint')}
        value={view.url}
        onChange={(url) => edit({ url })}
        placeholder="https://dav.example.com/dsh"
      />
      <div className="dsm-syncRow">
        <Field
          label={t('syncFieldMachine')}
          hint={t('syncFieldMachineHint')}
          value={view.machineId}
          onChange={(machineId) => edit({ machineId })}
        />
        <Field
          label={t('syncFieldTimeout')}
          hint={t('syncFieldTimeoutHint')}
          value={view.timeoutMs}
          onChange={(timeoutMs) => edit({ timeoutMs })}
          placeholder="30000"
        />
      </div>
      <Field
        label={t('syncFieldUser')}
        hint={t('syncFieldUserHint')}
        value={view.username}
        onChange={(username) => edit({ username })}
      />
      {credentials === undefined && <p className="dsm-hint">{t('syncPasswordUnavailable')}</p>}
      {credentials !== undefined && (
        <SettingsSecretField
          id="dsm-dav-password"
          label={t('syncFieldPasswordValue')}
          hint={credential.writable ? t('syncFieldPasswordValueHint') : t('syncPasswordShadowed')}
          text={password}
          disabled={!snapshot.writable || !credential.writable}
          configured={credential.configured}
          stateLabel={credential.configured ? t('syncPasswordSet') : t('syncPasswordUnset')}
          onEdit={editPassword}
        />
      )}
      <div className="dsm-field">
        <span className="dsm-fieldLabel">{t('syncFieldMapping')}</span>
        {view.mapping.length === 0 && <span className="dsm-hint">{t('syncFieldMappingEmpty')}</span>}
        {view.mapping.length > 0 && (
          <div className="dsm-mapRows">
            {view.mapping.map((row, index) => (
              <div className="dsm-mapRow" key={index}>
                <input
                  className="dsm-input"
                  type="text"
                  list={remoteCwds.length > 0 ? 'dsm-mapRemoteCwds' : undefined}
                  aria-label={t('syncMapRemoteLabel', { line: index + 1 })}
                  placeholder="/home/alice/dev/proj"
                  value={row.from}
                  onChange={(event) => editMapping(index, { from: event.target.value })}
                />
                <span className="dsm-mapArrow" aria-hidden="true">
                  →
                </span>
                <input
                  className="dsm-input"
                  type="text"
                  aria-label={t('syncMapLocalLabel', { line: index + 1 })}
                  placeholder="/opt/work/proj"
                  value={row.to}
                  onChange={(event) => editMapping(index, { to: event.target.value })}
                />
                <button type="button" className="dsm-button" onClick={() => removeMapping(index)}>
                  {t('syncMapRemove')}
                </button>
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
          <button type="button" className="dsm-button" onClick={addMapping}>
            {t('syncMapAdd')}
          </button>
          <span className="dsm-hint">{t('syncFieldMappingHint')}</span>
        </div>
      </div>

      <div className="dsm-controls">
        <button type="button" className="dsm-button dsm-primary" onClick={save} disabled={!canSave}>
          {saving ? t('saving') : t('save')}
        </button>
        <button type="button" className="dsm-button" onClick={discard} disabled={!dirty}>
          {t('discard')}
        </button>
        {!snapshot.writable && <span className="dsm-warn">{t('syncFormReadOnly')}</span>}
        {problems.map((problem) => (
          <span key={problem.code} className="dsm-warn">
            {problem.code === 'mapping' ? problemText(problem.problem, t) : t('syncTimeoutInvalid')}
          </span>
        ))}
        {failed && <span className="dsm-warn">{t('saveFailed')}</span>}
        {credentialError !== undefined && <span className="dsm-warn">{credentialError}</span>}
        {snapshot.writable && dirty && problems.length === 0 && !failed && <span className="dsm-hint">{t('unsaved')}</span>}
      </div>

      {/*
       * 配好之后先探一次：认证过不过、地址对不对。测的是**已保存的**配置（宿主的运行时按配置现读），
       * 所以有草稿时按钮是禁用的，那句话也换成"先保存"。
       */}
      <div className="dsm-controls">
        <button type="button" className="dsm-button" onClick={testConnection} disabled={!canTest}>
          {testing ? t('syncTestRunning') : t('syncTest')}
        </button>
        <span className="dsm-hint">{dirty ? t('syncTestDirty') : t('syncTestHint')}</span>
      </div>
      {testError !== undefined && <p className="dsm-warn">{testError}</p>}
      {verdict !== undefined && (
        <p className={testResult?.code === 'ok' ? 'dsm-ok' : 'dsm-warn'}>{t(verdict.key, verdict.params)}</p>
      )}
    </div>
  )
}
