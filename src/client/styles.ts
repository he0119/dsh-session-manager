/**
 * 这一页的样式，按 effect 生命周期注入 `<style>`。
 *
 * 颜色只用宿主 `Theme` 检查面列出的那十几个 token（`--dsw-alias-*`），每个都带一个中性的回落值，
 * 深浅主题自动跟随。唯一的例外是 `.dsm-primary` 的字色：那个位置宿主的检查面没给 token，
 * 于是显式写了回落链（见该处注释）——**主题色不能拿"另一个主题下的观感"去估**，深色主题里的
 * `brand-primary` 是近白色，所以填充按钮上写死白字就是白底白字。
 *
 * 不用任何宿主原语包的类名：那些是打包器哈希出来的私有产物，抄不到也不该抄。
 *
 * 排版照「插件」页那一类管理列表：一个区块一张卡片（发丝描边 + 大圆角）、行高紧凑、
 * 次要文字用 `label-secondary`。外层的水平留白与滚动由设置外壳给（它那一列是
 * `padding: 0 24px 24px; overflow-y: auto`），所以这里不再自己加页面级 padding。
 *
 * @module dsh-session-manager/client/styles
 */

/** 样式归属（卸载与热替换都按它认领）。 */
export const STYLE_OWNER = 'dsh-session-manager/client.css'

/** 样式表正文。 */
export const CSS = `
.dsm-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 13px;
  line-height: 20px;
}
.dsm-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.dsm-title { font-size: 14px; font-weight: 600; }
.dsm-sub { color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-spacer { flex: 1 1 auto; }
.dsm-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsm-cardHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsm-cardTitle { font-weight: 600; }
.dsm-hint { color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-button {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 4px 10px;
  font: inherit;
  cursor: pointer;
}
.dsm-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #3370ff); }
.dsm-button:disabled { opacity: 0.5; cursor: default; }
.dsm-button.dsm-primary {
  background: var(--dsw-alias-brand-primary, #3370ff);
  border-color: var(--dsw-alias-brand-primary, #3370ff);
  /*
   * 字色**不能写死白**：brand-primary 在深色主题里是 #f9fafb 那种近白（它是"表面的反色"，
   * 不是为了当填充色才存在），写死 #fff 就是白底白字——按钮整个读不出来。宿主内置按钮用的是
   * label-primary-foreground（浅色主题 #fff、深色主题 #0f1115），但它不在 Theme 检查面的
   * 那 14 个 token 里，所以这里挂了回落链：拿不到就退到 bg-layer-1——brand-primary 在明暗
   * 两套里都是表面的反色，拿**表面色**当字色一定读得出来。
   */
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1, #fff));
}
.dsm-button.dsm-primary:hover:not(:disabled) {
  /* 往表面色混一点点：深色主题里变暗、浅色主题里变亮，两边都像"被按了一下"。 */
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3370ff) 88%, var(--dsw-alias-bg-layer-1, #fff));
}
/* 一组会话：组头 + 组内若干行。 */
.dsm-group { display: block; }
.dsm-group:first-child .dsm-groupHead { border-top: none; }
/*
 * 组头是一条"带底色、随列表滚动粘住"的横幅：底色用字色薄雾兑在**卡片表面色**上，于是它既是不透明
 * 的（粘住时底下的行不会透出来），又在明暗两套主题里都是"比卡片略深/略浅一层"的区分色。
 * 前一条声明是给不认 color-mix 的浏览器留的退路：没有底色也还读得出来，只是少了横向的分组感。
 */
.dsm-groupHead {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 6%, var(--dsw-alias-bg-layer-1, #fff));
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  cursor: pointer;
}
.dsm-groupTitle { font-weight: 600; }
.dsm-list {
  /* 整页里不必再用 320px 的小窗：给一个随视口的上限，短列表不留空、长列表不把页面推得很长。 */
  max-height: min(420px, 42vh);
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
}
.dsm-row {
  display: grid;
  grid-template-columns: 24px minmax(120px, 1.2fr) minmax(120px, 2fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  cursor: pointer;
}
.dsm-row:last-child { border-bottom: none; }
/*
 * 悬停底色同样不能拿表面 token 当"稍深一点"：浅色主题里 bg-layer-1/2/3 **全是同一个白**，
 * 铺上去等于没有反馈。改成把字色兑透明做一层薄雾（宿主外壳自己也这么兑），明暗两套都看得见。
 */
.dsm-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 6%, transparent); }
.dsm-rowId { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.dsm-meta { color: var(--dsw-alias-label-secondary, #646a73); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsm-empty { padding: 14px; color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsm-select, .dsm-file {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 4px 8px;
  font: inherit;
  max-width: 100%;
}
.dsm-file { padding: 3px; }
/* 目录下拉：撑满一行（旁边留给「浏览…」按钮），长路径由浏览器自己省略，别把布局顶宽。 */
.dsm-selectPath { flex: 1 1 22rem; min-width: 0; }
/* 页面内目录浏览框：一个缩进的浅底小面板，和所在字段同宽。 */
.dsm-browser {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.dsm-browserHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* 当前这一层的完整路径：单行省略（完整值在 title 里），长路径不该把这个框顶宽。 */
.dsm-browserPath {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsm-crumbs { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.dsm-crumb {
  border: none;
  background: transparent;
  color: var(--dsw-alias-brand-primary, #3370ff);
  font: inherit;
  padding: 2px 4px;
  border-radius: 6px;
  cursor: pointer;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * 悬停底色是"字色兑透明的一层薄雾"，不是某个表面 token：检查面里的表面色在浅色主题下多半也是
 * 白的（bg-layer-3 就是 #fff），铺上去等于没有反馈。宿主外壳自己也这么兑（color-mix +
 * transparent），所以这里跟着走；真遇到不认 color-mix 的浏览器，就只是少一层悬停反馈。
 */
.dsm-crumb:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 8%, transparent);
}
.dsm-crumb:disabled { color: var(--dsw-alias-label-secondary, #646a73); cursor: default; }
/* 一层子目录：等宽两列铺开，比竖排一行一览得多。 */
.dsm-dirList {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 2px;
  max-height: min(260px, 30vh);
  padding: 4px;
}
.dsm-dirEntry {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsm-dirEntry:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 8%, transparent);
}
.dsm-dirEntry:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: -1px; }
.dsm-dirHidden { color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-table { width: 100%; border-collapse: collapse; }
.dsm-table th, .dsm-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  vertical-align: top;
}
.dsm-table th { color: var(--dsw-alias-label-secondary, #646a73); font-weight: 500; }
/* 导入预演那张表的列宽**写死**（fixed 布局）：会话那一列吃掉剩余宽度，其余按内容量好。
   自动布局碰上长路径会算出一个很怪的比例——动作列被挤成两个字宽（「动作」自己都折行），
   会话列每行只剩十来个字符。列宽是设计，不该由内容的字数决定。 */
.dsm-planTable { table-layout: fixed; }
.dsm-planTable .dsm-colAction { width: 72px; }
.dsm-planTable .dsm-colCwd { width: 32%; }
.dsm-planTable .dsm-colBytes { width: 88px; }
/* cwd 那一格里的路径要能断行（fixed 布局下列宽不会再变），否则长路径顶出格子。 */
.dsm-cwd { color: var(--dsw-alias-label-secondary, #646a73); overflow-wrap: anywhere; }
/* 标签是个小块：挤在窄列里也不能折成两行（导入预演表的动作列里曾经折成「跳/过」）。 */
.dsm-tag { border-radius: 6px; padding: 0 6px; font-size: 12px; white-space: nowrap; }
.dsm-tagCreate { color: var(--dsw-alias-state-success-primary, #2ea121); border: 1px solid currentColor; }
/* 中性标签：导入预演里的 skip、导出列表里"不是已登记工作区"的目录，都只是"没什么动作"。 */
.dsm-tagIdle, .dsm-tagSkip { color: var(--dsw-alias-state-idle-primary, #8f959e); border: 1px solid currentColor; }
.dsm-error { color: var(--dsw-alias-state-error-primary, #d83931); }
.dsm-warn { color: var(--dsw-alias-state-warn-primary, #d97b00); }
.dsm-ok { color: var(--dsw-alias-state-success-primary, #2ea121); }
.dsm-banner {
  border: 1px solid currentColor;
  border-radius: 8px;
  padding: 6px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 页内分页：贴着卡片区的下划线式页签，和设置外壳自己的 tab 视觉区分开 */
.dsm-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsm-tab {
  appearance: none;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, #646a73);
  font: inherit;
  cursor: pointer;
  padding: 6px 10px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.dsm-tab:hover { color: var(--dsw-alias-label-primary, #1f2329); }
.dsm-tab[aria-selected='true'] {
  color: var(--dsw-alias-label-primary, #1f2329);
  border-bottom-color: var(--dsw-alias-brand-primary, #3370ff);
  font-weight: 600;
}
.dsm-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: -2px; }
.dsm-fields { display: flex; flex-direction: column; gap: 8px; }
.dsm-field { display: flex; flex-direction: column; gap: 4px; }
.dsm-fieldLabel { color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-input {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 5px 8px;
  font: inherit;
  width: 100%;
  box-sizing: border-box;
}
.dsm-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: -1px; }
.dsm-options { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.dsm-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
/* 勾选式列表行：只有"勾选框 + 内容列"，没有 cwd 那一列（cwd 在组头/字段上，不再一行行重复）。 */
.dsm-rowPick, .dsm-rowExport { grid-template-columns: 24px minmax(120px, 1.4fr) auto auto; }
.dsm-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  padding-top: 8px;
}
.dsm-listPlain {
  margin: 0;
  padding-left: 18px;
  color: var(--dsw-alias-label-secondary, #646a73);
  max-height: 240px;
  overflow: auto;
}
.dsm-listPlain li { overflow-wrap: anywhere; }
.dsm-fields-label { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 500; margin: 0; }
.dsm-registry, .dsm-problems, .dsm-effect { display: flex; flex-direction: column; gap: 4px; }
.dsm-backupRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
}
.dsm-backupRow:last-child { border-bottom: none; }
.dsm-backupMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
`

/**
 * 注入样式表，返回卸载函数。
 *
 * 先删同 `data-plugin-css` 的旧节点：热替换时会重新 append 一份，不认领旧的就会留下幽灵样式。
 */
export function installStyles(): () => void {
  const owner = STYLE_OWNER
  const stale = document.querySelector(`style[data-plugin-css="${owner}"]`)
  if (stale !== null && stale.parentNode !== null) stale.parentNode.removeChild(stale)

  const element = document.createElement('style')
  element.dataset['plugin'] = 'dsh-session-manager'
  element.dataset['pluginCss'] = owner
  element.textContent = CSS
  document.head.appendChild(element)
  return () => {
    if (element.parentNode !== null) element.parentNode.removeChild(element)
  }
}
