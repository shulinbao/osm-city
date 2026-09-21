'use strict';
/**
 * 静态自检：前端脚本是传统 script（非模块），加载顺序必须保证依赖先定义。
 * 检查每个文件顶层 `const { X } = window.G;` 里的 X 在它之前是否已经定义。
 *   node tools/check-load-order.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const ORDER = [...html.matchAll(/<script src="\/js\/([a-z-]+)\.js"><\/script>/g)].map((m) => m[1]);

if (!ORDER.length) {
  console.error('❌ 没有在 index.html 里找到 /js/*.js 的引入');
  process.exit(1);
}

// 文件名 → 该文件挂到 window.G 上的名字
const GLOBAL_NAME = {
  util: 'util', style: 'Style', presets: 'Presets', net: 'Net', world: 'World',
  mapdata: 'MapData', render: 'Render', editor: 'Editor', transit: 'Transit',
  linemgr: 'LineMgr', inspector: 'Inspector', ui: 'UI', main: 'App',
};

console.log(`\n=== 前端加载顺序自检（${ORDER.length} 个脚本）===\n`);
const defined = new Set(['util']);
let bad = 0;

for (const file of ORDER) {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', file + '.js'), 'utf8');
  const m = src.match(/const \{([^}]+)\} = window\.G;/);
  if (m) {
    const deps = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const missing = deps.filter((d) => !defined.has(d));
    if (missing.length) {
      bad += 1;
      console.log(`  ❌ ${file}.js 顶层解构 [${deps.join(', ')}]，但 ${missing.join(', ')} 此时还没定义`);
    } else {
      console.log(`  ✅ ${file}.js 依赖 [${deps.join(', ')}]`);
    }
  }
  const g = GLOBAL_NAME[file];
  if (g) defined.add(g);
}

console.log(bad ? `\n结果：${bad} 个文件存在加载顺序问题\n` : '\n结果：加载顺序正确\n');
process.exit(bad ? 1 : 0);
