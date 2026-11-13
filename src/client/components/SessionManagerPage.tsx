/**
 * 侧栏入口点开之后，本页占的是**主栏**（宿主的 `main` slot）。
 *
 * 为什么还要一层壳：宿主的 `.mainPanel` 是定高的 flex 列、`overflow: hidden`，滚动视口得由占位方
 * 自己给（官方的任务管理页也是这么做的）。设置弹窗那条路不用管这件事——那边的滚动与内边距是设置外壳
 * 的，所以 `ManagerPanel` 自己没有滚动容器，这一层就是为"换一个落点"补上的那一段。
 *
 * 内容列**占满**主栏（旧版那条约 960px 的居中列是设置弹窗里一格的宽度），页面本身不滚：滚的是卡片里
 * 的列表；导出 / 导入、同步、备份与回滚在宽弹窗里，各自滚自己的正文。
 *
 * @module dsh-session-manager/client/SessionManagerPage
 */

import * as React from 'react'

import { ManagerPanel, type ManagerPanelProps } from './ManagerPanel.tsx'

/**
 * 主栏里的「会话管理」页。
 *
 * @param props 与设置里那一页完全一样：`t` 由框架按 `locale` 送来，`directory` 由注册时的 `inject()` 给。
 * @returns 带滚动视口的一页。
 */
export function SessionManagerPage(props: ManagerPanelProps): React.ReactElement {
  return (
    <div className="dsm-globalPage">
      <div className="dsm-globalScroll">
        <div className="dsm-globalContent">
          <ManagerPanel {...props} />
        </div>
      </div>
    </div>
  )
}
