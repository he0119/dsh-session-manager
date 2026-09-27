/**
 * 这一页的样式，按 effect 生命周期注入 `<style>`。
 *
 * 颜色只用宿主 `Theme` 检查面列出的那十几个 token（`--dsw-alias-*`），每个都带一个中性的回落值，
 * 深浅主题自动跟随。不用任何宿主原语包的类名：那些是打包器哈希出来的私有产物，抄不到也不该抄。
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
  color: #fff;
}
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
.dsm-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03)); }
.dsm-rowId { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
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
.dsm-table { width: 100%; border-collapse: collapse; }
.dsm-table th, .dsm-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  vertical-align: top;
}
.dsm-table th { color: var(--dsw-alias-label-secondary, #646a73); font-weight: 500; }
.dsm-tag { border-radius: 6px; padding: 0 6px; font-size: 12px; }
.dsm-tagCreate { color: var(--dsw-alias-state-success-primary, #2ea121); border: 1px solid currentColor; }
.dsm-tagSkip { color: var(--dsw-alias-state-idle-primary, #8f959e); border: 1px solid currentColor; }
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
.dsm-rowPick { grid-template-columns: 24px minmax(120px, 1.4fr) auto auto; }
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
