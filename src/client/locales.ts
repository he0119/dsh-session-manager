/**
 * 界面文案：两份语言 + 命名空间。
 *
 * 字典是扁平的 `键 → 文案`，`{name}` 是占位符，与宿主的字典服务同一套口径
 * （`ctx.locale.register(NS, { zh, en })`，注册 Slot 时带 `locale: NS`）。
 *
 * 刻意**不 import** `@deepseek-ai/dsh-client-locale/client` 的类型：那是宿主 Web 端模块图里的
 * 包，本包只在 `dsh.client.inject` 里把它排在自己前面（那份清单管模块到达顺序，不是依赖保证），
 * 不在类型层与它绑死——它改名或换形状时，本页最多文案回落到键名，不会连页面一起装不进去。
 * 代价是字典键没有编译期校验，由 `test/client.test.mjs` 的键集断言补上。
 *
 * 键名按"页面骨架 → 页内分页"分组：`title`/`tabXxx` 是骨架，`exportXxx`/`importXxx` 属于
 * 导入导出页，`migrateXxx`/`backupXxx`/`rollbackXxx` 属于迁移页。**两份语言的键集必须完全一致**
 * ——少一个键就是一处会露出键名的界面。
 *
 * @module dsh-session-manager/client/locales
 */

/** 字典命名空间（同时是注册 Slot 时的 `locale`）。 */
export const NS = 'dsh-session-manager'

/** 翻译函数：宿主字典服务 `bind()` 返回的形状。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** 中文文案。 */
export const zh = {
  // 页面骨架：设置导航里的那一行 + 页面标题 + 页内分页
  title: '会话管理',
  library: '会话库',
  refresh: '刷新',
  loading: '读取中…',
  tabTransfer: '导入导出',
  tabMigrate: '迁移',
  tabManage: '会话',
  sessionsCount: '{count} 个会话',
  workspacesCount: '{count} 个工作区',

  // ---- 导入导出 ----
  exportTitle: '导出',
  exportHint:
    '勾选要带走的会话，导出一个 .dshsess 包。列表按目录分组，组头那一下是整组勾上／取消。包里是会话日志的原始字节，不含会话创建过的普通文件；同一条会话的所有代次日志一起进包。',
  selectAll: '全选整库',
  clearAll: '清空',
  selectedCount: '已选 {count}',
  selectGroup: '整组勾选／取消：{name}',
  unregisteredDir: '未登记工作区',
  unregisteredSession: '未登记在册',
  unregisteredSessionTip:
    '这条会话的 id 不在任何工作区的登记表里。外壳侧边栏把这类会话挂到「未分组」下（子代理、空白与已归档的它不显示，所以那边看着比这里少）。',
  noCwdGroup: '没有 cwd 的会话',
  exportAction: '导出所选',
  exporting: '打包中…',
  exported: '已导出 {count} 条会话（{bytes}）。',
  noSessions: '这个会话库里还没有会话。',
  noCwd: '（无 cwd）',

  importTitle: '导入',
  importHint: '选一个 .dshsess 包和目标工作区：先预演，看清楚会写什么，再确认落盘。',
  pickFile: '选择 .dshsess 包',
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
  // 跳过的行**没有** toCwd，但那不是"没有 cwd"：它们根本不会被写盘。
  cwdSkipped: '跳过，不改写',
  applied: '已写入 {count} 条会话（{bytes}）。',
  needSelection: '请先勾选至少一个会话。',
  needFile: '请先选择要导入的 .dshsess 包。',
  needWorkspace: '请先选择目标工作区。',

  // ---- 迁移 ----
  migrateTitle: '迁移会话',
  migrateHint:
    '把会话从一个来源搬到另一个目录（来源可以是某个工作区目录，也可以是「未分组」里那些没人认领的会话）：改写日志 header 的 cwd（只动首帧，其余字节不变）、把会话目录移进目标项目目录、并重新登记工作区注册表。可以整个来源一起搬，也可以只挑其中几条——先预演，看清会写什么，再确认。侧边栏里看不见的会话（子代理 / 空白 / 已归档）不在候选里，所以来源后面的条数会比导出列表少。',
  fromLabel: '源目录',
  toLabel: '目标目录',
  pickSource: '选择源目录…',
  ungroupedSource: '未分组',
  unownedSourceHint:
    '来源是「未分组」：注册表没认领、且有 cwd 的那批会话，可以横跨多个目录，一次全部收进目标工作区。它们的 header 会写上目标目录的 cwd，会话目录搬进目标项目目录并登记在册。没有 cwd 的会话不在这里（header 里没有 cwd 可改写），"未登记在册的会话"与"搬迁会话产物"两个开关因此也不适用。',
  pickTarget: '选择目标目录…',
  browse: '浏览…',
  typePath: '手输路径',
  collapse: '收起',
  pathPlaceholder: '目录的绝对路径',
  browseUnavailable: '这个宿主没有可用的目录选择器，请从列表里挑一个，或手输路径。',
  browseFailed: '目录选择器没能返回路径：{reason}',
  // 页面内浏览框（宿主给的是 `browse` 能力时用它）：数据来自宿主的 `list()`，不猜路径。
  browseTitle: '选择目录',
  dirHome: '宿主 home',
  dirPick: '用这个目录',
  dirPickHint: '列出来的都是目录：点名字进去，确认当前这一层就点左边。',
  dirEmpty: '这一层没有子目录。',
  dirTruncated: '目录太多，只列出了一部分。',
  sessionsInDir: '{count} 条会话',
  titleLabel: '新建工作区标题（可选）',
  titlePlaceholder: '目标目录还没登记过时用',
  includeArtifacts: '同时搬迁会话创建过的文件（要全量解码，较慢）',
  includeUnowned: '连同未登记在册的会话',
  sourceSessions: '源目录下匹配到 {count} 条会话',
  sourceSessionsNone: '库里没有 cwd 等于源目录的会话（迁移仍按源项目目录里的实际内容进行）',
  pickScopeLabel: '迁移范围',
  allSessions: '全部',
  pickSubsetLabel: '只选其中几条',
  pickTickHint: '勾选任意一条，即改为「只选其中几条」',
  pickSubsetHint: '勾选要搬的会话；一次只处理一个源目录。',
  selectAllInSource: '全选',
  clearPick: '清空',
  needFrom: '请先填源目录。',
  needTo: '请先填目标目录。',
  needMigrateSelection: '请至少勾选一条会话，或选「全部」。',
  migratePreview: '预演迁移',
  migrateApply: '确认迁移',
  migrating: '迁移中…',
  migrateSummary: '将迁移 {sessions} 条会话（{files} 个日志，{bytes}）',
  migrateProjectDirs: '项目目录：{from} → {to}',
  migrateProjectDirsUnowned: '未分组横跨 {projectDirs} 个源项目目录 → {to}',
  registryChangeTitle: '注册表变更',
  registryCreateTarget: '登记目标工作区（新建）',
  registryReuseTarget: '登记到已有工作区',
  registryAdded: '新增登记 {count} 条',
  registryAdopted: '从不属于任何工作区的会话里收编 {count} 条',
  registryMoved: '从 {count} 个工作区搬出',
  registryRemoved: '移除 {count} 个已空的工作区',
  registryUnchanged: '注册表无需变更',
  artifactsPlanned: '计划搬迁 {count} 项产物',
  artifactsSkipped: '跳过 {count} 项产物',
  migrateDone: '已迁移 {sessions} 条会话：改写 {rewritten} 个日志、移动 {moved} 个目录{artifacts}。',
  migrateArtifactsPart: '、搬迁 {count} 项产物',
  verifiedPass: '复核通过',
  verifiedFail: '复核未通过',
  effectImmediate: '注册表变更已由宿主直接承接，无需重启。',
  effectRestart: '注册表已落盘，但宿主进程内持有内存副本，需重启 DSH 才会生效；重启前请勿在旧工作区继续新增会话。',
  problemsTitle: '问题',

  // ---- 备份与回滚 ----
  backupTitle: '备份与回滚',
  backupHint:
    '每次迁移、每次删除都会先留一份字节级备份。迁移的备份点「回滚」：把会话目录、日志字节与工作区注册表一起还原。删除的备份点「恢复」：只把会话目录搬回原位（删除从头到尾没碰过注册表）。',
  backupRootLabel: '备份根目录',
  noBackups: '还没有备份。',
  backupRow: '{sessions} 条会话 · {artifacts} 项产物',
  backupKindMigrate: '迁移',
  backupKindDelete: '删除',
  rollbackAction: '回滚',
  rollbackPreview: '看回滚动作',
  rollbackConfirm: '确认回滚',
  rollingBack: '回滚中…',
  rollbackActions: '以下是回滚会做的 {count} 个动作（还没有写盘）：',
  rollbackDone: '已回滚 {sessions} 条会话、还原 {files} 个文件并恢复注册表。',
  restoreAction: '恢复',
  restorePreview: '看恢复动作',
  restoreConfirm: '确认恢复',
  restoring: '恢复中…',
  restoreActions: '以下是恢复会做的 {count} 个动作（还没有写盘）：',
  restoreDone: '已恢复 {sessions} 条会话、还原 {files} 个文件（注册表未改动）。',

  // ---- 会话（逐条管理：归档与删除） ----
  manageTitle: '会话库',
  manageHint:
    '这一页对着整个会话库逐条管理。归档＝在侧边栏里收起来（走宿主能力，即时生效）；删除＝先把会话目录备份到本插件的备份根，再删掉它。子代理、空白与已归档的会话也在这里——侧边栏里点不到它们，行上的标签说明它们为什么不显示。',
  manageArchiveUnavailable:
    '这个宿主没有 workspaceRegistry 服务（归档是它的能力，只有 Web profile 才有），所以归档按钮不可用；删除不受影响。',
  manageArchive: '归档所选',
  manageUnarchive: '取消归档',
  manageArchiving: '处理中…',
  manageArchiveImmediate: '宿主即时生效，侧边栏马上跟着变。',
  manageArchived: '已归档 {count} 条会话。',
  manageUnarchived: '已取消归档 {count} 条会话。',
  manageArchiveFailed: '有 {count} 条没能改（原因见下）：',
  manageDeletePreview: '预演删除',
  manageDeletePlanTitle: '将要删除',
  manageDeleteApply: '确认删除',
  manageDeleting: '删除中…',
  manageBackupTo: '备份落在：{dir}（要恢复就去「迁移」页的「备份与回滚」）',
  manageDeleteHint:
    '删除会先备份、再删掉整个会话目录；删完侧边栏要等宿主重新扫描才会少掉这几条。还活在宿主内存里的会话删不掉——先在宿主里关掉它。',
  selectAllSessions: '全选',
  tagSubagent: '子代理',
  tagSubagentTip: '子代理会话：外壳侧边栏把它挂在父会话下面（不是没有位置），所以不列进工作区或「未分组」。',
  tagBlank: '空白',
  tagBlankTip: '空白会话：建出来但一轮都没开始过（日志里只有 seed 事件）。侧边栏默认不显示它。',
  tagArchived: '已归档',
  tagArchivedTip: '已归档：id 在注册表的归档集里，侧边栏默认把它过滤掉。',
  tagLive: '活动中',
  tagLiveTip: '这条会话还活在宿主内存里（运行中或已打开），删除会被拒绝——先在宿主里关掉它。',
  cancel: '取消',

  // ---- 共同 ----
  failed: '操作失败：{reason}',
  dismiss: '知道了',
} as const

/** 英文文案（键集必须与中文完全一致）。 */
export const en: Record<keyof typeof zh, string> = {
  title: 'Session management',
  library: 'Session library',
  refresh: 'Refresh',
  loading: 'Loading…',
  tabTransfer: 'Import & export',
  tabMigrate: 'Migrate',
  tabManage: 'Sessions',
  sessionsCount: '{count} sessions',
  workspacesCount: '{count} workspaces',

  exportTitle: 'Export',
  exportHint:
    'Tick the sessions to take away and download one .dshsess bundle. The list is grouped by directory, and each group header toggles its whole group. The bundle carries the raw log bytes (every generation of a session), not files the session created.',
  selectAll: 'Select whole library',
  clearAll: 'Clear',
  selectedCount: '{count} selected',
  selectGroup: 'Select or clear this whole group: {name}',
  unregisteredDir: 'not a registered workspace',
  unregisteredSession: 'not registered',
  unregisteredSessionTip:
    "This session's id is in no workspace record. The shell sidebar parks such sessions under Ungrouped (it hides subagent, blank and archived ones, so that row shows fewer).",
  noCwdGroup: 'Sessions without a cwd',
  exportAction: 'Export selected',
  exporting: 'Packing…',
  exported: 'Exported {count} sessions ({bytes}).',
  noSessions: 'This library has no sessions yet.',
  noCwd: '(no cwd)',

  importTitle: 'Import',
  importHint: 'Pick a .dshsess bundle and a target workspace: preview first, then confirm to write.',
  pickFile: 'Choose a .dshsess bundle',
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
  // A skipped row has **no** toCwd, but that is not "no cwd": nothing will be written at all.
  cwdSkipped: 'skipped, unchanged',
  applied: 'Wrote {count} sessions ({bytes}).',
  needSelection: 'Tick at least one session first.',
  needFile: 'Choose a .dshsess bundle first.',
  needWorkspace: 'Choose a target workspace first.',

  migrateTitle: 'Migrate sessions',
  migrateHint:
    'Move sessions from one source to another directory (the source is a workspace directory, or the unclaimed sessions under Ungrouped): rewrite each log header cwd (first frame only, the rest stays byte-identical), move the session directories into the target project directory, and re-home the workspace registry. Move the whole source at once, or only a few of them — preview first, then confirm. Sessions the sidebar hides (subagent / blank / archived) are never candidates, which is why the counts after each source are lower than on the export list.',
  fromLabel: 'Source directory',
  toLabel: 'Target directory',
  pickSource: 'Choose a source directory…',
  ungroupedSource: 'Ungrouped',
  unownedSourceHint:
    'The source is Ungrouped: sessions no workspace claims that still have a cwd, possibly spread over several directories — adopt them into the target workspace in one go. Their headers get the target cwd, their directories move into the target project directory, and they get registered. Sessions without a cwd are not listed here (there is no cwd in their header to rewrite), so the "include unregistered sessions" and "move session artifacts" switches do not apply.',
  pickTarget: 'Choose a target directory…',
  browse: 'Browse…',
  typePath: 'Type a path',
  collapse: 'Hide',
  pathPlaceholder: 'Absolute path of the directory',
  browseUnavailable: 'This host has no usable directory picker — choose from the list, or type a path.',
  browseFailed: 'The directory picker returned no path: {reason}',
  // The in-page browser (used when the host serves the `browse` capability): its data comes from
  // the host’s own `list()`, so no path is ever guessed here.
  browseTitle: 'Choose a directory',
  dirHome: 'Host home',
  dirPick: 'Use this directory',
  dirPickHint: 'Everything listed is a directory: click a name to go in, or confirm this level on the left.',
  dirEmpty: 'No subdirectories at this level.',
  dirTruncated: 'Too many entries — only part of the list is shown.',
  sessionsInDir: '{count} sessions',
  titleLabel: 'Title for a new workspace (optional)',
  titlePlaceholder: 'Used when the target directory is not registered yet',
  includeArtifacts: 'Also move files the sessions created (decodes whole logs, slower)',
  includeUnowned: 'Include sessions registered in no workspace',
  sourceSessions: '{count} sessions in the library match the source directory',
  sourceSessionsNone:
    'No session in the library has this cwd (the migration still works from the source project directory’s actual contents)',
  pickScopeLabel: 'Scope',
  allSessions: 'All',
  pickSubsetLabel: 'Only the ticked ones',
  pickTickHint: 'Tick any row to switch to “only the ticked ones”',
  pickSubsetHint: 'Tick the sessions to move; one source directory per run.',
  selectAllInSource: 'Select all',
  clearPick: 'Clear',
  needFrom: 'Fill in the source directory first.',
  needTo: 'Fill in the target directory first.',
  needMigrateSelection: 'Tick at least one session, or choose “All”.',
  migratePreview: 'Preview migration',
  migrateApply: 'Migrate now',
  migrating: 'Migrating…',
  migrateSummary: '{sessions} sessions to migrate ({files} logs, {bytes})',
  migrateProjectDirs: 'Project directory: {from} → {to}',
  migrateProjectDirsUnowned: 'Ungrouped spans {projectDirs} source project directories → {to}',
  registryChangeTitle: 'Registry change',
  registryCreateTarget: 'Register the target workspace (new)',
  registryReuseTarget: 'Register into an existing workspace',
  registryAdded: '{count} sessions added',
  registryAdopted: '{count} adopted from unowned sessions',
  registryMoved: 'moved out of {count} workspaces',
  registryRemoved: '{count} emptied workspaces removed',
  registryUnchanged: 'No registry change needed',
  artifactsPlanned: '{count} artifacts to move',
  artifactsSkipped: '{count} artifacts skipped',
  migrateDone: 'Migrated {sessions} sessions: {rewritten} logs rewritten, {moved} directories moved{artifacts}.',
  migrateArtifactsPart: ', {count} artifacts moved',
  verifiedPass: 'verification passed',
  verifiedFail: 'verification FAILED',
  effectImmediate: 'The host took the registry change directly; no restart needed.',
  effectRestart:
    'The registry is on disk, but the host keeps an in-memory copy: restart DSH for it to take effect. Do not add sessions to the old workspace before that.',
  problemsTitle: 'Problems',

  backupTitle: 'Backups & rollback',
  backupHint:
    'Every migration and every delete takes a byte-level backup first. A migration backup offers Roll back: it restores the session directories, the original log bytes and the workspace registry together. A delete backup offers Restore: it only moves the session directories back (deleting never touched the registry).',
  backupRootLabel: 'Backup root',
  noBackups: 'No backups yet.',
  backupRow: '{sessions} sessions · {artifacts} artifacts',
  backupKindMigrate: 'migration',
  backupKindDelete: 'delete',
  rollbackAction: 'Roll back',
  rollbackPreview: 'Show rollback steps',
  rollbackConfirm: 'Confirm rollback',
  rollingBack: 'Rolling back…',
  rollbackActions: '{count} steps this rollback would take (nothing written yet):',
  rollbackDone: 'Rolled back {sessions} sessions, restored {files} files and the workspace registry.',
  restoreAction: 'Restore',
  restorePreview: 'Show restore steps',
  restoreConfirm: 'Confirm restore',
  restoring: 'Restoring…',
  restoreActions: '{count} steps this restore would take (nothing written yet):',
  restoreDone: 'Restored {sessions} sessions and {files} files (the registry was left untouched).',

  manageTitle: 'Session library',
  manageHint:
    'Manage the whole library row by row. Archive puts a session away in the sidebar (a host capability, effective immediately); Delete backs the session directory up into this plugin’s backup root first, then removes it. Subagent, blank and archived sessions are listed here too — the sidebar cannot reach them, so each row carries a tag saying why it is hidden.',
  manageArchiveUnavailable:
    'This host has no workspaceRegistry service (archiving is its capability, Web profiles only), so the archive buttons are disabled; deleting still works.',
  manageArchive: 'Archive selected',
  manageUnarchive: 'Unarchive',
  manageArchiving: 'Working…',
  manageArchiveImmediate: 'The host applies it immediately, so the sidebar follows right away.',
  manageArchived: 'Archived {count} sessions.',
  manageUnarchived: 'Unarchived {count} sessions.',
  manageArchiveFailed: '{count} could not be changed (reasons below):',
  manageDeletePreview: 'Preview delete',
  manageDeletePlanTitle: 'About to delete',
  manageDeleteApply: 'Delete now',
  manageDeleting: 'Deleting…',
  manageBackupTo: 'Backup lands in: {dir} (restore it from Backups & rollback on the Migrate tab)',
  manageDeleteHint:
    'Deleting backs the session directory up first, then removes it; the sidebar drops those rows once the host rescans. A session still living in host memory cannot be deleted — close it in the host first.',
  selectAllSessions: 'Select all',
  tagSubagent: 'subagent',
  tagSubagentTip:
    'Subagent session: the shell sidebar nests it under its parent session (it is not homeless), so it never shows up in a workspace or under Ungrouped.',
  tagBlank: 'blank',
  tagBlankTip: 'Blank session: created but never started a turn (only seed events in the log). The sidebar hides it by default.',
  tagArchived: 'archived',
  tagArchivedTip: 'Archived: its id is in the registry archive set, which the sidebar filters out by default.',
  tagLive: 'active',
  tagLiveTip:
    'This session is still live in host memory (running or open), so deleting it is refused — close it in the host first.',
  cancel: 'Cancel',

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
