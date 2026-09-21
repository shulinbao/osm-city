'use strict';
/**
 * 静态自检：确认 JS 里引用的 DOM id 都存在于 index.html，且 HTML 里的 id 没有重复。
 *   node tools/check-dom.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const ids = new Set();
const dupes = [];
for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
  if (ids.has(m[1])) dupes.push(m[1]);
  ids.add(m[1]);
}

const jsFiles = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js'));
const referenced = new Map();
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
  for (const m of src.matchAll(/\$\('#([a-zA-Z0-9_-]+)'/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], new Set());
    referenced.get(m[1]).add(f);
  }
  for (const m of src.matchAll(/getElementById\('([a-zA-Z0-9_-]+)'\)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], new Set());
    referenced.get(m[1]).add(f);
  }
}

let bad = 0;
console.log(`\n=== DOM 自检（index.html 共 ${ids.size} 个 id，JS 引用 ${referenced.size} 个）===\n`);
for (const [id, files] of referenced) {
  if (!ids.has(id)) {
    bad += 1;
    console.log(`  ❌ JS 引用了不存在的 id: #${id}  (${[...files].join(', ')})`);
  }
}
if (dupes.length) {
  bad += dupes.length;
  for (const d of dupes) console.log(`  ❌ HTML 里重复的 id: #${d}`);
}
if (!bad) console.log('  ✅ 所有 JS 引用的 id 都存在，HTML 无重复 id');

// 必须存在的关键节点（页面骨架）
const REQUIRED = ['map', 'topbar', 'data-info', 'conn', 'toolbar', 'tool-list', 'tool-options', 'layer-list',
  'inspector', 'inspector-empty', 'inspector-body', 'insp-element-title', 'insp-element-meta', 'insp-geometry',
  'insp-tags', 'insp-add-tag', 'insp-presets', 'insp-actions', 'insp-relations', 'insp-history',
  'chat', 'chat-log', 'chat-form', 'chat-input', 'collab', 'collab-count', 'player-list', 'lock-list',
  'statusbar', 'status-coords', 'status-zoom', 'status-counts', 'status-select', 'status-undo', 'status-hint',
  'hint', 'client-errors', 'toasts', 'search-panel', 'search-input', 'search-results',
  'export-modal', 'export-options', 'history-modal', 'history-list', 'help', 'login', 'login-form'];
const missing = REQUIRED.filter((id) => !ids.has(id));
if (missing.length) {
  bad += missing.length;
  console.log(`  ❌ 缺少关键节点: ${missing.join(', ')}`);
} else {
  console.log('  ✅ 页面骨架节点齐全');
}

console.log(`\n结果：${bad ? bad + ' 项问题' : '全部通过'}\n`);
process.exit(bad ? 1 : 0);
