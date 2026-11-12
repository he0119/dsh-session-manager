/**
 * 「会话」页左侧那一栏：项目 + 筛选。
 *
 * 为什么有它：平铺表格之后，组头里的"这条属于哪个项目"变成了一列，可"只看某个项目""把这个项目整组
 * 归档"就没了落脚点。项目树把这个落脚点放回列表旁边：点项目 = 只看它，鼠标停在项目行上出现勾选框 =
 * 整组勾选（作用面与卡头的「全选」一致，都是**眼下筛出来的**那些）。
 *
 * 筛选芯片也在这里：它们与项目是两条独立的轴（项目＝目录，筛选＝这条会话是什么），但都回答"中间这栏
 * 列哪些"，放在同一栏里比一个在左上、一个在列表顶上更好找。
 *
 * 窄屏（页面可用宽 ≤960px）这一栏收成**浮层**：卡头会出现一枚「项目与筛选」，点开它从左边滑出；
 * 浮层里点「关闭」收起。宽屏上它一直是左边那条 208px 的栏。两种形态是同一份 DOM，靠容器查询换
 * 位置——不渲染两份，免得两处的选中态、筛选芯片各说各话。
 *
 * @module dsh-session-manager/client/SessionTree
 */

import * as React from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from '../logic/locales.ts'
import { FILTER_KEYS } from '../logic/sessionFilter.ts'
import { GroupCheckbox, SessionFilterChips, type SessionFilter } from './sessionList.tsx'
import { WorkspaceIcon } from './icons.tsx'

/** 一个项目选项：目录路径、称呼、条数、悬浮提示。 */
export interface SessionTreeOption {
  readonly path: string
  readonly name: string
  readonly count: number
  readonly tip: string
}

/** 一个项目行上的勾选状态（只看能单独勾的那些）。 */
export interface SessionTreePickState {
  readonly checked: boolean
  readonly indeterminate: boolean
  /** 这个项目眼下有没有"筛出来的、能单独勾的"行；没有就不画勾选框（画一个点不动的只是噪音）。 */
  readonly available: boolean
}

export interface SessionTreeProps {
  t: Translate
  /** 整库条数（「全部项目」那一行用）。 */
  total: number
  options: readonly SessionTreeOption[]
  /** 当前选中的项目路径；`null` = 全部。 */
  value: string | null
  /** 点项目名：只看它（`null` = 全部）。 */
  onPick: (path: string | null) => void
  filter: SessionFilter
  /** 某个项目眼下能勾的那些里选了几成（由页面按"筛出来的那些"算好）。 */
  pickState: (path: string) => SessionTreePickState
  /** 点项目行上的勾选框：整组勾选／取消（页面按"筛出来的那些"执行）。 */
  onToggleGroup: (path: string) => void
  /** 窄屏浮层里的「关闭」。宽屏上这枚按钮不显示。 */
  onClose: () => void
  /** 窄屏浮层是否展开（宽屏不看这个值）。 */
  open: boolean
  /** 整库清单还没到：这时画 0 个项目 / 0 条会话是个结论，不是事实。 */
  loading: boolean
}

/**
 * 项目与筛选这一栏。
 *
 * @param props 选项、当前项目、筛选状态与两个动作。
 * @returns 一张卡片（宽屏是左栏，窄屏是浮层）。
 */
export function SessionTree({
  t,
  total,
  options,
  value,
  onPick,
  filter,
  pickState,
  onToggleGroup,
  onClose,
  open,
  loading,
}: SessionTreeProps): React.ReactElement {
  return (
    <aside
      id="dsm-tree"
      className={`dsm-card dsm-tree${open ? ' dsm-treeOpen' : ''}`}
      aria-label={t('list.tree.label')}
    >
      <div className="dsm-cardHead dsm-treeHead">
        <span className="dsm-cardTitle">{t('list.project.label')}</span>
        {!loading && <span className="dsm-hint">{options.length}</span>}
        <span className="dsm-spacer" />
        {/*
          两枚按钮都只在小屏出现（styles.ts 的容器查询）：宽屏上这一栏一直摆着，不需要开与关。
        */}
        <span className="dsm-treeClose">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('close')}
          </Button>
        </span>
      </div>

      <div className="dsm-treeList">
        {loading ? (
          <p className="dsm-empty">{t('loading')}</p>
        ) : (
          <>
            <div className="dsm-treeRow" data-selected={value === null ? 'true' : undefined}>
              {/* 与项目行同一个缩进：勾选框那一格留空，项目名才排成一条线。 */}
              <span className="dsm-treeCheck" aria-hidden="true" />
              <button
            type="button"
            className="dsm-treePick"
            aria-current={value === null ? 'true' : undefined}
            onClick={() => onPick(null)}
          >
                <span className="dsm-treeIcon" aria-hidden="true" />
                <span className="dsm-treeName">{t('list.project.all')}</span>
                <span className="dsm-treeCount">{total}</span>
              </button>
            </div>

            {options.map((option) => {
              const state = pickState(option.path)
              return (
                <div
                  key={option.path}
                  className="dsm-treeRow"
                  data-selected={option.path === value ? 'true' : undefined}
                >
                  <span className="dsm-treeCheck">
                    {state.available && (
                      <GroupCheckbox
                        checked={state.checked}
                        indeterminate={state.indeterminate}
                        label={t('list.selectGroup', { name: option.name })}
                        onToggle={() => onToggleGroup(option.path)}
                      />
                    )}
                  </span>
                  <button
                    type="button"
                    className="dsm-treePick"
                    title={option.tip}
                    onClick={() => onPick(option.path)}
                  >
                    <WorkspaceIcon />
                    <span className="dsm-treeName">{option.name}</span>
                    <span className="dsm-treeCount">{option.count}</span>
                  </button>
                </div>
              )
            })}
          </>
        )}
      </div>

      {!loading && (
        <div className="dsm-treeFilters">
          <SessionFilterChips keys={FILTER_KEYS} filter={filter} t={t} />
          <span className="dsm-hint">{t('list.filter.hintAny')}</span>
        </div>
      )}
    </aside>
  )
}
