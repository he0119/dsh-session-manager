/**
 * 项目选择器：「会话」页平铺之后，拿它代替原来的组头。
 *
 * 为什么不是原生 `<select>`：这一页的原生下拉框在 2026-10 就被清掉了（目录一律走值控件 + 候选面板，
 * 见 [DirectoryField.tsx](./DirectoryField.tsx)）——`<option>` 只有一行可用，项目名与条数挤成一串，
 * 也没有悬浮提示。项目候选同样要两行（名字 + 条数）与一条搜索路，所以走同一套面板的皮。
 *
 * 面板是**浮层**而不是把页头撑开：它挂在卡片头上，展开时不该把下面的表格顶下去。
 *
 * 与目录字段的区别只在语义：这里选的是"只看哪一个项目"，多一行「全部项目」，没有"取消"——面板里
 * 点「关闭」只是收起，不改当前值。
 *
 * @module dsh-session-manager/client/ProjectPicker
 */

import * as React from 'react'

import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from '../logic/locales.ts'
import { ChevronIcon } from './icons.tsx'

/** 一个项目选项：目录路径、称呼、条数。 */
export interface ProjectOption {
  readonly path: string
  readonly name: string
  readonly count: number
}

/** 入参。 */
export interface ProjectPickerProps {
  t: Translate
  options: readonly ProjectOption[]
  /** 当前选中的项目路径；`null` = 全部。 */
  value: string | null
  /** 整库条数（「全部项目」那一行用）。 */
  total: number
  onChange: (path: string | null) => void
}

/** 项目选择器。 */
export function ProjectPicker({ t, options, value, total, onChange }: ProjectPickerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const current = value === null ? undefined : options.find((option) => option.path === value)
  const label =
    value === null
      ? t('list.project.all', { count: total })
      : t('list.project.option', { name: current?.name ?? value, count: current?.count ?? 0 })

  return (
    <div className="dsm-projectField">
      <button
        type="button"
        className="dsm-select dsm-selectPath dsm-pathValue dsm-projectValue"
        aria-label={`${t('list.project.label')}：${label}`}
        aria-expanded={open}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <span className="dsm-pathValueText">{label}</span>
        <ChevronIcon />
      </button>

      {/* 面板自己的筛选词状态放在里面：不展开时不该生出一份空串状态（冒烟用例按位置种状态，多一份就错位）。 */}
      {open && (
        <ProjectPanel
          t={t}
          options={options}
          value={value}
          total={total}
          onPick={(path) => {
            onChange(path)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** 展开之后那份面板：搜索、列表、关闭。 */
function ProjectPanel({
  t,
  options,
  value,
  total,
  onPick,
  onClose,
}: {
  t: Translate
  options: readonly ProjectOption[]
  value: string | null
  total: number
  onPick: (path: string | null) => void
  onClose: () => void
}): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const needle = query.trim().toLowerCase()
  const listed = options.filter(
    (option) =>
      needle === '' ||
      option.name.toLowerCase().includes(needle) ||
      option.path.toLowerCase().includes(needle),
  )

  return (
    <div className="dsm-browser dsm-projectPicker">
      <div className="dsm-browserHead">
        <span className="dsm-fieldLabel">{t('list.project.label')}</span>
        <span className="dsm-spacer" />
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>

      <Input
        className="dsm-search dsm-candidateFilter"
        type="search"
        value={query}
        placeholder={t('list.project.search')}
        aria-label={t('list.project.search')}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="dsm-list dsm-dirList dsm-candidateList">
        <button
          type="button"
          className="dsm-dirEntry dsm-candidate"
          aria-current={value === null ? 'true' : undefined}
          onClick={() => onPick(null)}
        >
          <span className="dsm-candidateName">{t('list.project.all', { count: total })}</span>
        </button>
        {listed.map((option) => (
          <button
            key={option.path}
            type="button"
            className="dsm-dirEntry dsm-candidate"
            aria-current={option.path === value ? 'true' : undefined}
            title={t('list.project.option', { name: option.name, count: option.count })}
            onClick={() => onPick(option.path)}
          >
            <span className="dsm-candidateName">{option.name}</span>
            <span className="dsm-hint dsm-candidateMeta">{t('list.sessionsInDir', { count: option.count })}</span>
          </button>
        ))}
        {listed.length === 0 && <p className="dsm-empty">{t('pathField.noMatch')}</p>}
      </div>
    </div>
  )
}
