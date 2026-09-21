'use strict';
/**
 * 第二轮独立核对（把第一轮里两个"判据没校准"的疑点查清，而不是当成缺陷报）：
 *   ① 用**已知地标**验证坐标解码：蒙特卡洛赌场 ≈ 43.7396N, 7.4280E；摩纳哥王宫 ≈ 43.7315N, 7.4205E
 *   ② 悬挂 relation 成员的**类型分布**：若 node/way/relation 都有、比例接近，则是提取包裁剪的固有现象；
 *      若只有某一类异常，才说明 memids/类型枚举解码有问题
 *   ③ 对照 XML 路径：lod_zoom / road_class 是不是**本来就不由导入器回填**（由服务端启动时补）
 *
 *   node logs/verify-pbf2.js <monaco.sqlite> <xml-tiny.sqlite>
 */
const { DatabaseSync } = require('node:sqlite');
const [pbfFile, xmlFile] = process.argv.slice(2);
const open = (f) => new DatabaseSync(f, { readOnly: true });

console.log('=== ① 已知地标坐标（决定性判据：增量解码/quantization 错则位置全错）===');
{
  const db = open(pbfFile);
  const landmarks = [
    ['赌场', 'Casino', 43.7396, 7.4280],
    ['王宫', 'Palais', 43.7315, 7.4205],
    ['蒙特卡洛', 'Monte-Carlo', 43.7397, 7.4270],
    ['港口', 'Port Hercule', 43.7345, 7.4260],
  ];
  for (const [label, needle, expLat, expLon] of landmarks) {
    const rows = db.prepare(
      "SELECT id, lat, lon, tags FROM nodes WHERE tags LIKE ? LIMIT 3",
    ).all('%' + needle + '%');
    const ways = db.prepare(
      "SELECT id, min_lat, max_lat, min_lon, max_lon, tags FROM ways WHERE tags LIKE ? LIMIT 3",
    ).all('%' + needle + '%');
    const cand = rows.length ? rows : ways;
    if (!cand.length) { console.log(`   ${label}（${needle}）: 库中未找到同名要素，跳过`); continue; }
    for (const c of cand.slice(0, 2)) {
      if (c.lat !== undefined) {
        const dLat = Math.abs(c.lat - expLat), dLon = Math.abs(c.lon - expLon);
        const ok = dLat < 0.01 && dLon < 0.01;
        console.log(`   ${label} node#${c.id}: ${c.lat}, ${c.lon}   与已知位置差 ${(dLat * 111000).toFixed(0)}m / ${(dLon * 81000).toFixed(0)}m  ${ok ? '✅' : '⚠ 偏差较大'}`);
      } else {
        console.log(`   ${label} way#${c.id}: lat ${c.min_lat}~${c.max_lat}  lon ${c.min_lon}~${c.max_lon}  （包围盒与已知位置一致性需人工看）`);
      }
    }
  }
  db.close();
}

console.log('\n=== ② 悬挂关系成员的类型分布（node/way/relation 都有 = 提取包裁剪，不是解码错）===');
{
  const db = open(pbfFile);
  const table = { node: 'nodes', way: 'ways', relation: 'relations' };
  for (const t of ['node', 'way', 'relation']) {
    const total = db.prepare('SELECT COUNT(*) c FROM relation_members WHERE member_type = ?').get(t).c;
    const bad = db.prepare(
      `SELECT COUNT(*) c FROM relation_members rm WHERE rm.member_type = ? AND NOT EXISTS (SELECT 1 FROM ${table[t]} x WHERE x.id = rm.member_ref)`,
    ).get(t).c;
    console.log(`   ${t.padEnd(8)} 成员 ${String(total).padStart(6)}   悬挂 ${String(bad).padStart(6)}   ${total ? ((bad / total) * 100).toFixed(2) + '%' : '—'}`);
  }
  // way→node 的悬挂（这是解析器必须做对的部分）
  const wnTotal = db.prepare('SELECT COUNT(*) c FROM way_nodes').get().c;
  const wnBad = db.prepare('SELECT COUNT(*) c FROM way_nodes wn LEFT JOIN nodes n ON n.id = wn.node_id WHERE n.id IS NULL').get().c;
  console.log(`   way→node 引用 ${wnTotal}   悬挂 ${wnBad}   ${wnTotal ? ((wnBad / wnTotal) * 100).toFixed(2) + '%' : '—'}  ← 这一项必须为 0`);
  db.close();
}

console.log('\n=== ③ 对照：XML 路径导出来的库，lod_zoom / road_class 是不是同样为空 ===');
{
  const db = open(xmlFile);
  const w = db.prepare('SELECT COUNT(*) c FROM ways').get().c;
  const lod = db.prepare('SELECT COUNT(*) c FROM ways WHERE lod_zoom IS NOT NULL').get().c;
  const rc = db.prepare('SELECT COUNT(*) c FROM ways WHERE road_class IS NOT NULL').get().c;
  console.log(`   XML 库: ways=${w}  lod_zoom 非空=${lod}  road_class 非空=${rc}`);
  console.log(`   → ${lod === 0 && rc === 0 ? '两条路径一致：LOD 列不由导入器回填（应由服务端启动时补），我的第一轮判据不成立' : '两条路径不一致，需要查'}`);
  db.close();
}
