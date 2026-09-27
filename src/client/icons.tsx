/**
 * 列表里两级各有一个图形标记：**工作区**是文件夹，**会话**是对话气泡。
 *
 * 为什么自己内联 SVG，而不是用宿主的图标包或图标字体：宿主那套 UI 原语包的导出名、类名、哈希
 * 都是打包器的私有产物（本包在客户端刻意连类型都不 import，见 [index.ts](./index.ts) 的说明），
 * 图标字体又要多一份随包资源。两个十几字节的轮廓自己画，颜色走 `currentColor`——于是明暗两套
 * 主题里它跟着旁边的字色一起走，不需要任何额外的 token。
 *
 * 形状按 16×16 网格画，渲染成 14px：夹在 13px 的字与 24px 的勾选列之间不抢戏，缩到 12px 也还认得出。
 * 两个都是**轮廓**（`fill: none` + `stroke: currentColor`），跟这一页其他控件一样的线条风格。
 *
 * @module dsh-session-manager/client/icons
 */

/**
 * 工作区标记：一个文件夹轮廓，画在设置里那种组头（工作区名 + 路径）的最前面。
 *
 * 图形本身不说话（`aria-hidden`）：组头的无障碍名字来自它自己的文案，屏幕阅读器不需要再听一遍
 * "图标"。
 */
export function WorkspaceIcon() {
  return (
    <svg
      className="dsm-levelIcon dsm-levelWorkspace"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M13.33 13.33a1.33 1.33 0 0 0 1.33-1.33V5.33A1.33 1.33 0 0 0 13.33 4H8.07a1.33 1.33 0 0 1-1.13-.6L6.4 2.6A1.33 1.33 0 0 0 5.29 2H2.67A1.33 1.33 0 0 0 1.33 3.33v8.67a1.33 1.33 0 0 0 1.33 1.33Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 会话标记：一个带小尾巴的对话气泡轮廓，画在每条会话行的最前面。
 *
 * 这一笔不是装饰：会话标题是用户自己写的第一句话，很容易长得像个工作区名（本机就有叫
 * "dsh-session-manager 使用说明"的会话）。同一个列表里两级混排时，"这行是工作区还是会话"
 * 必须一眼看得出，而形状（文件夹 / 气泡）比颜色和缩进都更快。
 */
export function SessionIcon() {
  return (
    <svg
      className="dsm-levelIcon dsm-levelSession"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M14 10a1.33 1.33 0 0 1-1.33 1.33H4.67L2 14V3.33A1.33 1.33 0 0 1 3.33 2h9.34A1.33 1.33 0 0 1 14 3.33Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}
