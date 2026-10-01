/**
 * 「同步设置」表单：URL、机器名、账号、密码引用、超时与映射表，直接改 profile 里那一节。
 *
 * 放在传输页的同步卡片里，与预演/确认挨着——改完 URL 就能立刻预演一次，不必在两页之间来回跳。
 * 读写面在 [syncForm.ts](./syncForm.ts)（宿主的设置接缝），这里只管画与暂存。
 *
 * 三条刻意的取舍：
 *   - **保存是显式的**：输入框只改草稿，按「保存」才写。写下去的是用户层（设置对话框里那份配置
 *     文档），逐字提交会让每次击键都变成一次文档写入，而用户根本没法预览自己写了什么；
 *   - **只提交改动过的字段**：没动过的字段不发编辑，否则用户层里会攒下一堆"等于默认值"的覆盖，
 *     界面上那些字段从此都顶着「已覆盖」徽标（判据见 syncForm.ts 的 draftOps）；
 *   - **映射表用文本行**：一行一条 `远端路径 = 本机目录`。宿主那套表单原语只有文本/数字两种字段
 *     规格，字典类型没有现成控件；文本行至少能一眼看全、能整段复制粘贴，坏行还能指到行号。
 *
 * @module dsh-session-manager/client/SyncConfigForm
 */

import * as React from 'react'

import {
  draftFrom,
  draftOps,
  draftProblems,
  getSyncConfigApi,
  syncSectionOf,
  type MappingProblem,
  type SyncDraft,
  type SyncFormSnapshot,
} from './syncForm.ts'
import type { Translate } from './locales.ts'

/** 问题的文案：码 → 句子（这一层才有语言）。 */
function problemText(problem: MappingProblem, t: Translate): string {
  switch (problem.code) {
    case 'mapNoSeparator':
      return t('syncMapNoSeparator', { line: problem.line, text: problem.text })
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
export function SyncConfigForm({ t }: { t: Translate }): React.ReactElement | null {
  const api = getSyncConfigApi()
  const [snapshot, setSnapshot] = React.useState<SyncFormSnapshot | undefined>(api?.getSnapshot())
  const [draft, setDraft] = React.useState<SyncDraft | undefined>(undefined)
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

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
  }, [api, section.url, section.machineId, section.username, section.passwordRef, section.timeoutMs, section.mapping])

  if (api === undefined || snapshot === undefined) {
    return <p className="dsm-hint">{t('syncFormUnavailable')}</p>
  }
  if (snapshot.status === 'loading') return <p className="dsm-hint">{t('syncFormLoading')}</p>
  if (snapshot.status !== 'ready') return <p className="dsm-hint">{t('syncFormUnavailable')}</p>

  const view = draft ?? draftFrom(section)
  const problems = draftProblems(view)
  const edit = (patch: Partial<SyncDraft>): void => {
    setFailed(false)
    setDraft({ ...view, ...patch })
  }
  const ops = draftOps(view, section)
  const dirty = ops.length > 0
  const canSave = snapshot.writable && dirty && problems.length === 0 && !saving

  const save = (): void => {
    if (!canSave) return
    setSaving(true)
    setFailed(false)
    void api
      .mutate(ops, snapshot.revision)
      .then((accepted) => {
        // 被接受：草稿落回"跟随磁盘"（下一次投影就是刚写下的值）；被拒：留着草稿，让用户自己看。
        if (accepted) setDraft(undefined)
        else setFailed(true)
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false))
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
      <div className="dsm-syncRow">
        <Field
          label={t('syncFieldUser')}
          hint={t('syncFieldUserHint')}
          value={view.username}
          onChange={(username) => edit({ username })}
        />
        <Field
          label={t('syncFieldPassword')}
          hint={t('syncFieldPasswordHint')}
          value={view.passwordRef}
          onChange={(passwordRef) => edit({ passwordRef })}
          placeholder="DSH_DAV_PASSWORD"
        />
      </div>
      <label className="dsm-field">
        <span className="dsm-fieldLabel">{t('syncFieldMapping')}</span>
        <textarea
          className="dsm-input dsm-textarea"
          rows={3}
          value={view.mapping}
          placeholder={'/home/alice/dev/proj = /opt/work/proj'}
          onChange={(event) => edit({ mapping: event.target.value })}
        />
        <span className="dsm-hint">{t('syncFieldMappingHint')}</span>
      </label>

      <div className="dsm-controls">
        <button type="button" className="dsm-button dsm-primary" onClick={save} disabled={!canSave}>
          {saving ? t('saving') : t('save')}
        </button>
        <button type="button" className="dsm-button" onClick={() => setDraft(undefined)} disabled={!dirty}>
          {t('discard')}
        </button>
        {!snapshot.writable && <span className="dsm-warn">{t('syncFormReadOnly')}</span>}
        {problems.map((problem) => (
          <span key={problem.code} className="dsm-warn">
            {problem.code === 'mapping' ? problemText(problem.problem, t) : t('syncTimeoutInvalid')}
          </span>
        ))}
        {failed && <span className="dsm-warn">{t('saveFailed')}</span>}
        {snapshot.writable && dirty && problems.length === 0 && !failed && <span className="dsm-hint">{t('unsaved')}</span>}
      </div>
    </div>
  )
}
