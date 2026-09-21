'use strict';
/**
 * 独立核对一个分片库（不依赖任何 agent 的自述）：
 *   node logs/inspect-shard.js <分片库路径>
 * 打印：要素计数、三个 R*Tree 索引、坐标范围、LOD 列是否已物化、库里的表清单、meta 内容。
 */
const { DatabaseSync } = require('node:sqlite');
const file = process.argv[2];
if (!file) { console.error('用法: node logs/inspect-shard.js <shard.sqlite>'); process.exit(1); }
const d = new DatabaseSync(file, { readOnly: true });
const one = (sql) => d.prepare(sql).get();
const all = (sql) => d.prepare(sql).all();

console.log('库: ' + file + '\n');

console.log('=== 要素计数 ===');
for (const [label, sql] of [
  ['nodes', 'SELECT COUNT(*) c FROM nodes'],
  ['ways', 'SELECT COUNT(*) c FROM ways'],
  ['way_nodes', 'SELECT COUNT(*) c FROM way_nodes'],
  ['relations', 'SELECT COUNT(*) c FROM relations'],
  ['relation_members', 'SELECT COUNT(*) c FROM relation_members'],
]) {
  try { console.log('  ' + label.padEnd(18) + one(sql).c); } catch (e) { console.log('  ' + label + ' 读不到: ' + e.message); }
}

console.log('\n=== 空间索引（R*Tree）===');
for (const t of ['node_index', 'way_index', 'relation_index']) {
  try { console.log('  ' + t.padEnd(18) + one('SELECT COUNT(*) c FROM ' + t).c); } catch (e) { console.log('  ' + t + ' 读不到: ' + e.message); }
}

console.log('\n=== 坐标范围 ===');
console.log('  ' + JSON.stringify(one('SELECT MIN(lat) mnLat, MAX(lat) mxLat, MIN(lon) mnLon, MAX(lon) mxLon FROM nodes')));

console.log('\n=== LOD 物化列（导入器不回填，由服务端启动时补）===');
const wn = one('SELECT COUNT(*) c FROM ways').c;
console.log('  lod_zoom 非空 ' + one('SELECT COUNT(*) c FROM ways WHERE lod_zoom IS NOT NULL').c + ' / ' + wn
  + '   road_class 非空 ' + one('SELECT COUNT(*) c FROM ways WHERE road_class IS NOT NULL').c);

console.log('\n=== 库里的表（看它是纯 OSM 分片，还是也带交通玩法表）===');
const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
console.log('  ' + tables.join(', '));
const transitTables = ['companies', 'lines', 'stations', 'vehicles', 'line_stops'];
console.log('  含交通玩法表? ' + transitTables.filter((t) => tables.includes(t)).join(', ') || '（无）');

console.log('\n=== meta ===');
try {
  for (const r of all('SELECT key, value FROM meta ORDER BY key')) {
    console.log('  ' + r.key + ' = ' + String(r.value).slice(0, 120));
  }
} catch (e) { console.log('  读不到 meta: ' + e.message); }
d.close();
