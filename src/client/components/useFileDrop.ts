/**
 * 拖放接事件的那一层：把浏览器那四个 `drag*` 事件收成"现在拖没拖进来、松手时给了什么文件"。
 *
 * 为什么要一个 hook 而不是在两个组件里各写一遍：页面（列表）与导入弹窗都要能接包，而 `dragover` 必须
 * `preventDefault()` 才允许落下来、`dragleave` 在子元素之间会来回抖（计数器才稳）——这几条每写一遍就
 * 多一处漏 `preventDefault` 的地方，表现是"拖到按钮上就不认了"。
 *
 * 只认携带文件的拖放：拖选中的文字、拖页内元素过来时 `types` 里没有 `Files`，这里一律放行（不
 * `preventDefault`），不抢别处的行为。
 *
 * @module dsh-session-manager/client/useFileDrop
 */

import * as React from 'react'

/** 挂到接受拖放的那一层上的四个处理器。 */
export interface FileDropHandlers {
  onDragEnter: (event: React.DragEvent) => void
  onDragOver: (event: React.DragEvent) => void
  onDragLeave: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
}

/** `useFileDrop()` 的回答：接事件的四个处理器，以及"现在正有一个文件悬在上面"。 */
export interface FileDrop {
  over: boolean
  handlers: FileDropHandlers
}

/**
 * 把一层元素变成"可以落文件"的地方。
 *
 * @param onFiles 松手时收到那些文件（`File[]`；空数组表示这次拖的不是文件）。
 * @returns 处理器与当前悬停状态（悬停态用于给这一层加高亮）。
 */
export function useFileDrop(onFiles: (files: File[]) => void): FileDrop {
  const [over, setOver] = React.useState(false)
  /** 进出子元素也会各报一次 dragenter / dragleave，所以数着层级，归零才算真的离开。 */
  const depth = React.useRef(0)

  const carriesFiles = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')

  const onDragEnter = (event: React.DragEvent): void => {
    if (!carriesFiles(event)) return
    // 不 preventDefault 的话浏览器会把文件当成"导航到它"，页面直接跳走。
    event.preventDefault()
    depth.current += 1
    setOver(true)
  }

  const onDragOver = (event: React.DragEvent): void => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: React.DragEvent): void => {
    if (!carriesFiles(event)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }

  const onDrop = (event: React.DragEvent): void => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    // 落下来之后这一层不再需要高亮，也不再接管更外层（页面那一层不该也开一次导入弹窗）。
    event.stopPropagation()
    depth.current = 0
    setOver(false)
    onFiles(Array.from(event.dataTransfer?.files ?? []))
  }

  return { over, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
