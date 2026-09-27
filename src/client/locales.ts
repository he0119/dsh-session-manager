/**
 * 界面文案：两份语言 + 命名空间。
 *
 * 字典是扁平的 `键 → 文案`，`{name}` 是占位符，与宿主的字典服务同一套口径
 * （`ctx.locale.register(NS, { zh, en })`，页面注册时带 `locale: NS`）。
 *
 * 刻意**不 import** `@deepseek-ai/dsh-client-locale/client` 的类型：那是宿主 Web 端模块图里的
 * 包，本包只声明它作为运行时依赖（`dsh.client.inject`），不在类型层与它绑死——它改名或换形状
 * 时，本页最多文案回落到键名，不会连页面一起装不进去。代价是字典键没有编译期校验，
 * 由 `test/client.test.mjs` 的键集断言补上。
 *
 * @module dsh-session-manager/client/locales
 */

/** 字典命名空间（同时是注册槽位时的 `locale`）。 */
export const NS = 'dsh-session-manager'

/** 翻译函数：宿主字典服务 `bind()` 返回的形状。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** 中文文案。 */
export const zh = {
  tab: '会话导入导出',
  refresh: '刷新',
  loading: '读取中…',
  library: '会话库',
  sessionsCount: '{count} 个会话',
  workspacesCount: '{count} 个工作区',

  exportTitle: '导出',
  exportHint:
    '勾选要带走的会话，导出一个 .dhsess 包。包里是会话日志的原始字节，不含会话创建过的普通文件；同一条会话的所有代次日志一起进包。',
  selectAll: '全选',
  clearAll: '清空',
  selectedCount: '已选 {count}',
  exportAction: '导出所选',
  exporting: '打包中…',
  exported: '已导出 {count} 条会话（{bytes}）。',
  noSessions: '这个会话库里还没有会话。',
  noCwd: '（无 cwd）',

  importTitle: '导入',
  importHint: '选一个 .dhsess 包和目标工作区：先预演，看清楚会写什么，再确认落盘。',
  pickFile: '选择 .dhsess 包',
  pickWorkspace: '选择目标工作区…',
  preview: '预演',
  previewing: '预演中…',
  apply: '确认导入',
  applying: '导入中…',
  planSummary: '将创建 {create} 条、跳过 {skip} 条，共 {bytes}',
  colAction: '动作',
  colSession: '会话',
  colCwd: 'cwd',
  colBytes: '大小',
  actionCreate: '创建',
  actionSkip: '跳过',
  cwdRewritten: '{from} → {to}',
  cwdKeep: '保持无 cwd（落 _no-cwd）',
  applied: '已写入 {count} 条会话（{bytes}）。',

  needSelection: '请先勾选至少一个会话。',
  needFile: '请先选择要导入的 .dhsess 包。',
  needWorkspace: '请先选择目标工作区。',
  failed: '操作失败：{reason}',
  dismiss: '知道了',
} as const

/** 英文文案（键集必须与中文完全一致）。 */
export const en: Record<keyof typeof zh, string> = {
  tab: 'Session import & export',
  refresh: 'Refresh',
  loading: 'Loading…',
  library: 'Session library',
  sessionsCount: '{count} sessions',
  workspacesCount: '{count} workspaces',

  exportTitle: 'Export',
  exportHint:
    'Tick the sessions to take away and download one .dhsess bundle. The bundle carries the raw log bytes (every generation of a session), not files the session created.',
  selectAll: 'Select all',
  clearAll: 'Clear',
  selectedCount: '{count} selected',
  exportAction: 'Export selected',
  exporting: 'Packing…',
  exported: 'Exported {count} sessions ({bytes}).',
  noSessions: 'This library has no sessions yet.',
  noCwd: '(no cwd)',

  importTitle: 'Import',
  importHint: 'Pick a .dhsess bundle and a target workspace: preview first, then confirm to write.',
  pickFile: 'Choose a .dhsess bundle',
  pickWorkspace: 'Choose a target workspace…',
  preview: 'Preview',
  previewing: 'Previewing…',
  apply: 'Import now',
  applying: 'Importing…',
  planSummary: '{create} to create, {skip} to skip, {bytes} in total',
  colAction: 'Action',
  colSession: 'Session',
  colCwd: 'cwd',
  colBytes: 'Size',
  actionCreate: 'create',
  actionSkip: 'skip',
  cwdRewritten: '{from} → {to}',
  cwdKeep: 'stays without cwd (lands in _no-cwd)',
  applied: 'Wrote {count} sessions ({bytes}).',

  needSelection: 'Tick at least one session first.',
  needFile: 'Choose a .dhsess bundle first.',
  needWorkspace: 'Choose a target workspace first.',
  failed: 'Failed: {reason}',
  dismiss: 'Dismiss',
}

/** 占位符替换（`{name}`）。宿主字典服务自己也会插值，这一份是给没有服务时的兜底与测试用。 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : match,
  )
}

/** 由一份字典造出翻译函数（缺键时回落到键名，绝不让页面因为缺一句文案而崩）。 */
export function translateWith(dict: Record<string, string>): Translate {
  return (key, params) => interpolate(dict[key] ?? key, params)
}
