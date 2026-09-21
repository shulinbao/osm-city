'use strict';
/**
 * 独立核对：用真实 Geofabrik PBF 导入出来的库，**数据本身对不对**。
 * 计数对不等于解码对 —— 坐标增量 / granularity 算错时数量照样对、位置全错，
 * 所以这里必须查坐标范围、引用完整性、标签、LOD 列与关系成员。
 *
 *   node logs/verify-pbf.js logs/tmp-monaco.sqlite
 */
const { DatabaseSync } = require('node:sqlite');
const file = process.argv[2] || 'logs/tmp-monaco.sqlite';
const db = new DatabaseSync(file, { readOnly: true });
const one = (sql) => db.prepare(sql).get();
const all = (sql) => db.prepare(sql).all();

console.log('库: ' + file + '\n');

console.log('=== ① 坐标范围（摩纳哥真实约 lon 7.40~7.44 / lat 43.72~43.75）===');
const r = one('SELECT MIN(lat) mnLat, MAX(lat) mxLat, MIN(lon) mnLon, MAX(lon) mxLon FROM nodes');
console.log(`   lat ${r.mnLat} … ${r.mxLat}\n   lon ${r.mnLon} … ${r.mxLon}`);
const inside = one('SELECT COUNT(*) c FROM nodes WHERE lat BETWEEN 43.70 AND 43.76 AND lon BETWEEN 7.39 AND 7.45').c;
const total = one('SELECT COUNT(*) c FROM nodes').c;
const pct = (inside / total) * 100;
console.log(`   落在框内 ${inside} / ${total} = ${pct.toFixed(2)}%   ${pct > 99 ? '✅' : '❌ 坐标或增量解码有问题'}`);

console.log('\n=== ② 引用完整性（way refs 增量算错会立刻暴露成悬挂引用）===');
const dangling = one('SELECT COUNT(*) c FROM way_nodes wn LEFT JOIN nodes n ON n.id = wn.node_id WHERE n.id IS NULL').c;
console.log(`   悬挂 way→node 引用: ${dangling}   ${dangling === 0 ? '✅' : '❌'}`);
const danglingRel = one("SELECT COUNT(*) c FROM relation_members rm WHERE rm.member_type='node' AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=rm.member_ref)").c;
console.log(`   悬挂 relation→node 引用: ${danglingRel}   ${danglingRel === 0 ? '✅' : '❌'}`);

console.log('\n=== ③ 标签解码抽样 ===');
for (const w of all("SELECT id, tags FROM ways WHERE tags LIKE '%\"name\"%' LIMIT 4")) {
  console.log(`   way ${w.id}: ${String(w.tags).slice(0, 130)}`);
}
for (const n of all("SELECT id, tags FROM nodes WHERE tags LIKE '%amenity%' LIMIT 3")) {
  console.log(`   node ${n.id}: ${String(n.tags).slice(0, 130)}`);
}

console.log('\n=== ④ LOD / 道路分级列（低缩放查询依赖物化的这两列）===');
const wn = one('SELECT COUNT(*) c FROM ways').c;
const lod = one('SELECT COUNT(*) c FROM ways WHERE lod_zoom IS NOT NULL').c;
const rc = one('SELECT COUNT(*) c FROM ways WHERE road_class IS NOT NULL').c;
console.log(`   lod_zoom 非空 ${lod}/${wn}    road_class 非空 ${rc}`);
for (const row of all('SELECT road_class, COUNT(*) c FROM ways WHERE road_class IS NOT NULL GROUP BY road_class ORDER BY c DESC LIMIT 5')) {
  console.log(`      ${row.road_class}: ${row.c}`);
}

console.log('\n=== ⑤ 关系（memids 增量 + 角色字符串表）===');
console.log('   成员总数: ' + one('SELECT COUNT(*) c FROM relation_members').c);
console.log('   带角色成员: ' + one("SELECT COUNT(*) c FROM relation_members WHERE role IS NOT NULL AND role <> ''").c);
for (const rel of all("SELECT id, tags FROM relations WHERE tags LIKE '%multipolygon%' LIMIT 3")) {
  console.log(`   relation ${rel.id}: ${String(rel.tags).slice(0, 110)}`);
}

console.log('\n=== ⑥ 版本/时间戳（Info 解码）===');
const v = one('SELECT MIN(version) mn, MAX(version) mx, COUNT(*) c FROM nodes WHERE version IS NOT NULL');
console.log(`   node version 范围 ${v.mn}~${v.mx}（非空 ${v.c}）`);
const ts = one('SELECT COUNT(*) c FROM nodes WHERE ts IS NOT NULL');
console.log(`   有时间戳的节点: ${ts.c} / ${total}`);
db.close();
