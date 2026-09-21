'use strict';
/**
 * 分片 bbox 溢出核查：库里的要素是否真的都在提取包声明的范围内？
 *   node logs/shard-bbox-check.js <分片库> [source_bounds 的 lat_min lat_max lon_min lon_max]
 * 不传后四个数就从 meta.source_bounds 读。
 *
 * 为什么重要：分区路由按 bbox 相交来选分片。如果某个分片的 data_bbox 莫名大出几百公里
 * （例如关系成员溢出，或坐标解码出错），路由就会把无关请求也发给它 —— 前者只是浪费，
 * 后者是数据错了。所以必须量出来"超出多少、超出的那些是什么"。
 */
const { DatabaseSync } = require('node:sqlite');
const file = process.argv[2];
if (!file) { console.error('用法: node logs/shard-bbox-check.js <shard.sqlite>'); process.exit(1); }
const d = new DatabaseSync(file, { readOnly: true });
const one = (sql, ...p) => d.prepare(sql).get(...p);

let bounds = null;
if (process.argv.length >= 7) {
  bounds = { min_lat: +process.argv[3], max_lat: +process.argv[4], min_lon: +process.argv[5], max_lon: +process.argv[6] };
} else {
  try { bounds = JSON.parse(one("SELECT value v FROM meta WHERE key = 'source_bounds'").v); } catch { /* 没有 */ }
}
console.log('库: ' + file);
console.log('提取包声明范围: ' + (bounds ? JSON.stringify(bounds) : '（读不到）'));
if (!bounds) process.exit(0);

const total = one('SELECT COUNT(*) c FROM nodes').c;
const out = one(
  'SELECT COUNT(*) c FROM nodes WHERE lat < ? OR lat > ? OR lon < ? OR lon > ?',
  bounds.min_lat, bounds.max_lat, bounds.min_lon, bounds.max_lon,
).c;
console.log(`\n节点总数 ${total}，**落在声明范围之外** ${out}（${((out / total) * 100).toFixed(3)}%）`);

console.log('\n=== 超出部分的坐标分布（每 1° 一格，看是"溢出一点"还是"溢出几百公里"）===');
for (const r of d.prepare(
  `SELECT CAST(lat AS INT) latBand, COUNT(*) c FROM nodes
   WHERE lat < ? OR lat > ? OR lon < ? OR lon > ?
   GROUP BY latBand ORDER BY c DESC LIMIT 8`,
).all(bounds.min_lat, bounds.max_lat, bounds.min_lon, bounds.max_lon)) {
  console.log(`   纬度 ${r.latBand}° 附近: ${r.c} 个节点`);
}

console.log('\n=== 抽样：这些远在天边的节点带什么标签、有没有被 way 引用 ===');
for (const r of d.prepare(
  `SELECT n.id, n.lat, n.lon, n.tags,
          (SELECT COUNT(*) FROM way_nodes wn WHERE wn.node_id = n.id) AS used_by_ways
   FROM nodes n
   WHERE (n.lat < ? OR n.lat > ? OR n.lon < ? OR n.lon > ?)
   ORDER BY n.lat ASC LIMIT 6`,
).all(bounds.min_lat, bounds.max_lat, bounds.min_lon, bounds.max_lon)) {
  console.log(`   node ${r.id} (${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}) 被 ${r.used_by_ways} 条 way 引用  tags=${String(r.tags).slice(0, 90)}`);
}

console.log('\n=== 对比：way 的 bbox 有多少超出声明范围 ===');
const wOut = one(
  'SELECT COUNT(*) c FROM ways WHERE min_lat < ? OR max_lat > ? OR min_lon < ? OR max_lon > ?',
  bounds.min_lat, bounds.max_lat, bounds.min_lon, bounds.max_lon,
).c;
console.log(`   way 总数 ${one('SELECT COUNT(*) c FROM ways').c}，bbox 超出 ${wOut}`);
d.close();
