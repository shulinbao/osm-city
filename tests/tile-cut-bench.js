'use strict';
/**
 * 分片矩形裁片 —— 量测与自证脚本（零第三方依赖）
 *
 *   node tests/tile-cut-bench.js [--registry <path>]
 *
 * 它回答四件事：
 *   ① 每片规模：nodes / ways / relations / way_nodes / relation_members、库大小、声明矩形、实测坐标范围、R*Tree 行数；
 *   ② **片间同 id 重叠统计**：对**全部两两组合**（10 片 = 45 对）逐对算
 *      同 id 节点数 + 其中坐标不一致的数、同 id way 数 + node_count/version/tags 不一致的数、同 id relation 数。
 *      期望：node 可以 > 0（几何支撑节点被复制），**way 必须 = 0**，同 id 节点坐标差必须 = 0；
 *      **relation 同 id 可以 > 0**（跨片 relation 被复制进它 bbox 触及的每一片，见 tools/tile-cut.js 规则 ⑦），
 *      但副本之间必须内容一致 —— 那一条由 ②b 逐份核对（bbox 逐位 / 成员行逐条 / version 与 member_count / 不扩散）。
 *   ③ 片内引用完整性：way_nodes 引用的节点是否都在本片内（期望悬挂 = 0）；
 *      以及**关系成员悬挂**（本方案 relation 只把成员表原样搬过来，其它 way/node 成员可能在别的片里 ——
 *      这是文件头写明的简化，这里把它量出来，不藏）。
 *   ④ **给定 bbox 会命中哪些片**：用 registry 的矩形做相交判断，再对命中的片真跑一次 R*Tree 查询，
 *      给出"这条视口要问几个库、各库各能返回多少候选"。
 *
 * "跨片 relation 到底修没修好"这件事**不在本文件**：它要用真实服务端 + 参考单库，
 * 见 `tests/region-coverage-bench.js`（核心指标：bbox 与视口相交却不在被选中的片里的 relation 数）。
 *
 * 实现要点：用 SQLite 的 ATTACH 把其它分片挂到同一个连接上，让 SQL 自己 JOIN（两边 id 都是主键）。
 * 主连接是第 0 片、表名不带别名，其余片才加 s<i>. 前缀 —— 这一点坑过一次，注释在此留痕。
 *
 * 本脚本**只读**：主连接与所有 ATTACH 都用 `file:…?mode=ro` 打开；
 * 若运行时不支持 URI 文件名，则回退成普通 ATTACH（仍然只做 SELECT，不写任何东西）。
 */

const fs = require('fs');
const path = require('path');

// node:sqlite 的 ExperimentalWarning 会污染输出，早于 server/dbschema.js 拦掉（同 import-osm.js 做法）
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};

const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const REGION_DIR = path.join(ROOT, 'data', 'regions');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
let registryFile = path.join(REGION_DIR, 'registry.json');
let quick = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--registry') registryFile = argv[++i];
  else if (argv[i] === '--quick') quick = true;
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('用法: node tests/tile-cut-bench.js [--registry <registry.json>] [--quick]');
    process.exit(0);
  }
}

/* ---------------- 载入 registry（没有就退化成扫目录） ---------------- */
let registry = null;
if (fs.existsSync(registryFile)) {
  registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
}

const tiles = [];
if (registry && Array.isArray(registry.tiles) && registry.tiles.length) {
  for (const t of registry.tiles) {
    const file = path.resolve(ROOT, t.db);
    if (fs.existsSync(file)) tiles.push({ id: t.id, name: t.name, group: t.group, file, rects: t.rects, bbox: t.bbox, note: t.note });
  }
} else {
  for (const f of fs.readdirSync(REGION_DIR).filter((x) => x.endsWith('.sqlite')).sort()) {
    tiles.push({ id: path.basename(f, '.sqlite'), name: path.basename(f, '.sqlite'), group: '?', file: path.join(REGION_DIR, f), rects: null, bbox: null });
  }
}
if (!tiles.length) {
  console.error('没找到分片库。先跑 node tools/tile-cut.js --run');
  process.exit(1);
}

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const gb = (n) => (n / 1073741824).toFixed(2) + ' GB';
const sizeStr = (n) => (n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n < 1073741824 ? mb(n) : gb(n)));

/* ---------------- 连接：第 0 片为主连接，其余 ATTACH ---------------- */
const roNames = (f) => 'file:' + path.resolve(f).replace(/\\/g, '/').replace(/'/g, "''") + '?mode=ro';
let uriReadOnly = true;
const main = new DatabaseSync(roNames(tiles[0].file), { readOnly: true });
for (let i = 1; i < tiles.length; i++) {
  if (uriReadOnly) {
    try {
      main.exec(`ATTACH DATABASE '${roNames(tiles[i].file)}' AS s${i}`);
      continue;
    } catch (err) {
      uriReadOnly = false;                 // 运行时不认 URI 文件名 → 整批回退普通 ATTACH
      console.log('[提示] 本运行时不支持 ATTACH 的 mode=ro URI，回退普通 ATTACH（仍只做 SELECT）: ' + err.message);
    }
  }
  main.exec(`ATTACH DATABASE '${path.resolve(tiles[i].file).replace(/'/g, "''")}' AS s${i}`);
}
/** 第 0 片是主连接（表名不带前缀），其余片加 s<i>. 前缀 */
const T = (i, name) => (i === 0 ? name : `s${i}.${name}`);
const q1 = (sql, ...p) => main.prepare(sql).get(...p);

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  —— ' + detail : ''}`);
  if (!ok) failures.push(label);
};

console.log('==================== 分片矩形裁片量测 ====================');
console.log(`registry : ${registry ? registryFile : '（没有，退化成扫目录）'}`);
console.log(`分片数   : ${tiles.length}    ATTACH 只读: ${uriReadOnly ? '是（mode=ro）' : '否（回退普通 ATTACH）'}`);
if (registry) console.log(`registry 生成时间: ${registry.generated_at}  来源: ${(registry.sources || []).map((s) => s.file).join(', ')}`);

/* ================================================================== *
 * ① 每片规模
 * ================================================================== */
console.log('\n=== ① 每片规模 ===');
const stats = [];
for (let i = 0; i < tiles.length; i++) {
  const t = tiles[i];
  const c = {
    nodes: q1(`SELECT COUNT(*) c FROM ${T(i, 'nodes')}`).c,
    ways: q1(`SELECT COUNT(*) c FROM ${T(i, 'ways')}`).c,
    relations: q1(`SELECT COUNT(*) c FROM ${T(i, 'relations')}`).c,
    way_nodes: q1(`SELECT COUNT(*) c FROM ${T(i, 'way_nodes')}`).c,
    relation_members: q1(`SELECT COUNT(*) c FROM ${T(i, 'relation_members')}`).c,
  };
  const idx = {
    node_index: q1(`SELECT COUNT(*) c FROM ${T(i, 'node_index')}`).c,
    way_index: q1(`SELECT COUNT(*) c FROM ${T(i, 'way_index')}`).c,
    relation_index: q1(`SELECT COUNT(*) c FROM ${T(i, 'relation_index')}`).c,
  };
  const box = q1(`SELECT MIN(lat) mnla, MAX(lat) mxla, MIN(lon) mnlo, MAX(lon) mxlo FROM ${T(i, 'nodes')}`);
  const bytes = fs.statSync(t.file).size;
  const sumNC = q1(`SELECT COALESCE(SUM(node_count),0) c FROM ${T(i, 'ways')}`).c;
  const lod = q1(`SELECT COUNT(*) c FROM ${T(i, 'ways')} WHERE lod_zoom IS NOT NULL`).c;
  let crossTile = null;
  try {
    const m = main.prepare(`SELECT value v FROM ${T(i, 'meta')} WHERE key = 'cross_tile'`).get();
    crossTile = m ? JSON.parse(m.v) : null;
  } catch { crossTile = null; }
  stats.push({ ...t, c, idx, box, bytes, sumNC, lod, crossTile });
  console.log(`  ${t.id.padEnd(9)} ${(t.name || '').padEnd(18)} nodes=${fmt(c.nodes).padStart(11)} ways=${fmt(c.ways).padStart(9)} `
    + `relations=${fmt(c.relations).padStart(6)}  库 ${sizeStr(bytes).padStart(9)}`);
  console.log(`  ${''.padEnd(9)} way_nodes=${fmt(c.way_nodes).padStart(11)} relation_members=${fmt(c.relation_members).padStart(7)} `
    + `R*Tree node/way/relation=${idx.node_index}/${idx.way_index}/${idx.relation_index}  lod 已物化 ${lod}`);
  console.log(`  ${''.padEnd(9)} 实测坐标 lat ${box.mnla.toFixed(4)}~${box.mxla.toFixed(4)}  lon ${box.mnlo.toFixed(4)}~${box.mxlo.toFixed(4)}`);
  console.log(`  ${''.padEnd(9)} 跨片 relation 副本 meta：${crossTile
    ? `写入副本 ${fmt(crossTile.replicated)} 条 / 成员行 ${fmt(crossTile.members)} · bbox 覆盖 ${fmt(crossTile.bboxOverrides)} 条`
      + ` · ${crossTile.at}（bbox 来源 ${crossTile.bboxSource}）`
    : '**（无）—— 这一片没跑过阶段 ⑦，跨片 relation 会漏**'}`);
  if (t.rects) console.log(`  ${''.padEnd(9)} 声明矩形 ${t.rects.map((r) => `[${r.min_lat},${r.max_lat})×[${r.min_lon},${r.max_lon})`).join(' + ')}`);
}
const tot = stats.reduce((a, s) => ({
  nodes: a.nodes + s.c.nodes, ways: a.ways + s.c.ways, relations: a.relations + s.c.relations,
  way_nodes: a.way_nodes + s.c.way_nodes, relation_members: a.relation_members + s.c.relation_members, bytes: a.bytes + s.bytes,
}), { nodes: 0, ways: 0, relations: 0, way_nodes: 0, relation_members: 0, bytes: 0 });
console.log('  ' + '-'.repeat(96));
console.log(`  合计      nodes=${fmt(tot.nodes)} ways=${fmt(tot.ways)} relations=${fmt(tot.relations)} `
  + `way_nodes=${fmt(tot.way_nodes)} relation_members=${fmt(tot.relation_members)} 库合计 ${gb(tot.bytes)}`);
const nSizes = stats.map((s) => s.c.nodes).sort((a, b) => a - b);
console.log(`  节点规模均衡度：最小 ${fmt(nSizes[0])}（${stats.find((s) => s.c.nodes === nSizes[0]).id}）`
  + ` / 最大 ${fmt(nSizes[nSizes.length - 1])}（${stats.find((s) => s.c.nodes === nSizes[nSizes.length - 1]).id}）`
  + ` = ${(nSizes[nSizes.length - 1] / nSizes[0]).toFixed(2)} 倍`);

/* ================================================================== *
 * ② 片间同 id 重叠统计（全部两两组合）
 * ================================================================== */
console.log('\n=== ② 片间同 id 重叠统计（全部两两组合，共 ' + (tiles.length * (tiles.length - 1) / 2) + ' 对）===');
console.log('  说明（**口径已随跨片 relation 副本一起改过，这里是最新的**）：');
console.log('        · node 同 id 数 > 0 是**预期**的（几何支撑节点被复制到相邻片），但坐标必须逐位相同；');
console.log('        · way 同 id 数 > 0 是**硬失败**（way 永远只属于一片）；');
console.log('        · relation 同 id 数 > 0 是**预期**的（跨片 relation 被复制进它 bbox 触及的每一片，');
console.log('          见 tools/tile-cut.js 的归属规则 ⑦）—— 硬判据改成了 **副本之间内容必须逐条相同**，');
console.log('          见下面「②b」那一节（bbox 逐位 / 成员行逐条 / version 与 member_count）。');
const pairRows = [];
let maxNodeShare = 0;
let badNodeCoord = 0;
let badWay = 0;
let relDupPairs = 0;
const t2 = Date.now();
for (let i = 0; i < tiles.length; i++) {
  for (let j = i + 1; j < tiles.length; j++) {
    // 一行 SQL 同时拿到"同 id 数"和"内容不一致数"（分开查要多扫一遍大表）
    const n = q1(`SELECT COUNT(*) c,
                         COALESCE(SUM(CASE WHEN a.lat <> b.lat OR a.lon <> b.lon THEN 1 ELSE 0 END), 0) d
                  FROM ${T(i, 'nodes')} a JOIN ${T(j, 'nodes')} b ON b.id = a.id`);
    const w = q1(`SELECT COUNT(*) c,
                         COALESCE(SUM(CASE WHEN a.node_count <> b.node_count THEN 1 ELSE 0 END), 0) dc,
                         COALESCE(SUM(CASE WHEN a.version <> b.version OR COALESCE(a.tags,'') <> COALESCE(b.tags,'') THEN 1 ELSE 0 END), 0) dm
                  FROM ${T(i, 'ways')} a JOIN ${T(j, 'ways')} b ON b.id = a.id`);
    const r = q1(`SELECT COUNT(*) c FROM ${T(i, 'relations')} a JOIN ${T(j, 'relations')} b ON b.id = a.id`);
    badNodeCoord += Number(n.d);
    badWay += Number(w.c);
    relDupPairs += Number(r.c);
    const share = n.c / Math.min(stats[i].c.nodes, stats[j].c.nodes);
    if (share > maxNodeShare) maxNodeShare = share;
    pairRows.push({ a: tiles[i].id, b: tiles[j].id, n: n.c, nd: Number(n.d), w: w.c, wc: Number(w.dc), wm: Number(w.dm), r: r.c });
    console.log(`  ${tiles[i].id.padEnd(8)} × ${tiles[j].id.padEnd(8)}  同 id node=${fmt(n.c).padStart(10)}（坐标不同 ${n.d}，占较小片 ${(share * 100).toFixed(1)}%）  `
      + `way=${String(w.c).padStart(4)}（node_count 不同 ${w.dc} / 版本标签不同 ${w.dm}）  relation=${String(r.c).padStart(5)}`);
  }
}
console.log(`  （${(Date.now() - t2) / 1000 < 1 ? '<1' : ((Date.now() - t2) / 1000).toFixed(1)}s 算完 ${pairRows.length} 对）`);
const pairsWithNode = pairRows.filter((p) => p.n > 0).length;
console.log(`\n  小结：${pairRows.length} 对里，有同 id 节点的是 ${pairsWithNode} 对（相邻片共用几何支撑节点，正常）；`);
console.log(`        最大的同 id 节点占比 = ${(maxNodeShare * 100).toFixed(1)}%（占两片中较小那片的总节点数）`);
console.log(`        有同 id relation 的片对：${pairRows.filter((p) => p.r > 0).length} 对（跨片副本，正常）；同 id relation 对数合计 ${fmt(relDupPairs)}`);

/* ================================================================== *
 * ②b 同 id relation 副本的内容一致性 + 不扩散（路线 B 的硬判据）
 * ================================================================== */
console.log('\n=== ②b 同 id relation 副本：内容一致性 + 不扩散 ===');
console.log('  判据（tools/tile-cut.js 归属规则 ⑦）：');
console.log('    ① 同 id 的每一份副本，**bbox 四列逐位相同**；');
console.log('    ② **成员行逐条相同**（seq / member_type / member_ref / role 全等，条数也相同）；');
console.log('    ③ **version 与 member_count 相同**；');
console.log('    ④ 副本只出现在"该 relation 的 bbox 触及的片"里（不往无关片扩散）。');
const dupTilesOf = new Map();                    // relId → [片下标]
for (let i = 0; i < tiles.length; i++) {
  for (const r of main.prepare(`SELECT id FROM ${T(i, 'relations')}`).iterate()) {
    const id = Number(r.id);
    if (!dupTilesOf.has(id)) dupTilesOf.set(id, []);
    dupTilesOf.get(id).push(i);
  }
}
const copyIds = [...dupTilesOf.entries()].filter(([, ts]) => ts.length > 1).map(([id]) => id).sort((a, b) => a - b);
console.log(`  同 id 出现在 ≥2 片的 relation：${fmt(copyIds.length)} 条（其余 ${fmt(dupTilesOf.size - copyIds.length)} 条只在一片里）`);
/** 逐块用 IN 把副本行与成员行读出来（逐条点查会跑上万次，太慢） */
const relRowOf = new Map();      // `${i}|${id}` → 行
const membersOf = new Map();     // `${i}|${id}` → 成员行数组
const CHUNK = 200;
for (let i = 0; i < tiles.length; i++) {
  const mine = copyIds.filter((id) => dupTilesOf.get(id).includes(i));
  for (let p = 0; p < mine.length; p += CHUNK) {
    const chunk = mine.slice(p, p + CHUNK);
    const list = chunk.join(',');
    for (const r of main.prepare(`SELECT id, version, member_count, min_lat, max_lat, min_lon, max_lon
                                  FROM ${T(i, 'relations')} WHERE id IN (${list})`).iterate()) {
      relRowOf.set(i + '|' + Number(r.id), r);
    }
    const byId = new Map();
    for (const m of main.prepare(`SELECT relation_id, seq, member_type, member_ref, COALESCE(role,'') AS role
                                  FROM ${T(i, 'relation_members')} WHERE relation_id IN (${list})
                                  ORDER BY relation_id, seq`).iterate()) {
      const id = Number(m.relation_id);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(`${m.seq}:${m.member_type}:${m.member_ref}:${m.role}`);
    }
    for (const id of chunk) membersOf.set(i + '|' + id, byId.get(id) || []);
  }
}
/** 某片的声明矩形是否与该 bbox 相交（closed 比较，与服务端 resolve() 同口径） */
function rectsHitBbox(tile, b) {
  if (!tile.rects || !tile.rects.length) return true;
  return tile.rects.some((r) => r.min_lat <= b.max_lat && r.max_lat >= b.min_lat
    && r.min_lon <= b.max_lon && r.max_lon >= b.min_lon);
}
let badCopyBbox = 0;
let badCopyMembers = 0;
let badCopyMeta = 0;
let spreadViolations = 0;
const badSamples = [];
for (const id of copyIds) {
  const ts = dupTilesOf.get(id);
  const first = relRowOf.get(ts[0] + '|' + id);
  const firstMem = membersOf.get(ts[0] + '|' + id) || [];
  const bbox = first ? { min_lat: first.min_lat, max_lat: first.max_lat, min_lon: first.min_lon, max_lon: first.max_lon } : null;
  const memKey = firstMem.join('|');
  for (const i of ts) {
    const r = relRowOf.get(i + '|' + id);
    if (!r) continue;
    if (first && (r.min_lat !== first.min_lat || r.max_lat !== first.max_lat
      || r.min_lon !== first.min_lon || r.max_lon !== first.max_lon)) {
      badCopyBbox += 1;
      if (badSamples.length < 5) badSamples.push(`rel ${id} ${tiles[ts[0]].id} vs ${tiles[i].id} bbox 不同`);
    }
    if (first && (r.version !== first.version || r.member_count !== first.member_count)) {
      badCopyMeta += 1;
      if (badSamples.length < 5) badSamples.push(`rel ${id} ${tiles[ts[0]].id} vs ${tiles[i].id} version/member_count 不同`);
    }
    const mem = membersOf.get(i + '|' + id) || [];
    if (mem.length !== firstMem.length || mem.join('|') !== memKey) {
      badCopyMembers += 1;
      if (badSamples.length < 5) badSamples.push(`rel ${id} ${tiles[ts[0]].id}(${firstMem.length} 行) vs ${tiles[i].id}(${mem.length} 行) 成员行不同`);
    }
    if (bbox && bbox.min_lat !== null && !rectsHitBbox(tiles[i], bbox)) {
      spreadViolations += 1;
      if (badSamples.length < 5) badSamples.push(`rel ${id} 出现在 ${tiles[i].id}，但该片矩形与它的 bbox 不相交`);
    }
  }
}
console.log(`  副本副本对（同 id × 片数−1）逐份核对完成：bbox 不一致 ${badCopyBbox} · 成员行不一致 ${badCopyMembers}`
  + ` · version/member_count 不一致 ${badCopyMeta} · 扩散到无关片 ${spreadViolations}`);
if (badSamples.length) for (const s of badSamples) console.log('    ! ' + s);


/* ================================================================== *
 * ③ 片内引用完整性 + 关系成员悬挂
 * ================================================================== */
console.log('\n=== ③ 片内引用完整性 ===');
let totDangling = 0;
let totRelWayDang = 0;
let totRelNodeDang = 0;
let totNcMismatch = 0;
let totSampleBad = 0;
for (let i = 0; i < tiles.length; i++) {
  // LEFT JOIN 比相关子查询快得多（相关子查询在百万行上要跑到分钟级）
  const dang = q1(`SELECT COUNT(*) c FROM ${T(i, 'way_nodes')} wn LEFT JOIN ${T(i, 'nodes')} n ON n.id = wn.node_id WHERE n.id IS NULL`).c;
  // 逐 way 核 node_count 太贵（百万行相关子查询，实测单库就 200s+），所以：
  //   ① 先做**总体核对** SUM(node_count) == COUNT(*) FROM way_nodes（两边各一次顺序扫描，很快）；
  //   ② 再**抽样** 300 条 way 做逐条核对（把样本放进 CTE，保证只对 300 行跑相关子查询）。
  const sumNc = q1(`SELECT COALESCE(SUM(node_count),0) c FROM ${T(i, 'ways')}`).c;
  const cntWn = q1(`SELECT COUNT(*) c FROM ${T(i, 'way_nodes')}`).c;
  const sampleBad = q1(`WITH s AS (SELECT id, node_count FROM ${T(i, 'ways')} LIMIT 300)
                        SELECT COUNT(*) c FROM s WHERE s.node_count <> (SELECT COUNT(*) FROM ${T(i, 'way_nodes')} wn WHERE wn.way_id = s.id)`).c;
  const rw = q1(`SELECT COUNT(*) c FROM ${T(i, 'relation_members')} rm LEFT JOIN ${T(i, 'ways')} w ON w.id = rm.member_ref
                 WHERE rm.member_type = 'way' AND w.id IS NULL`).c;
  const rn = q1(`SELECT COUNT(*) c FROM ${T(i, 'relation_members')} rm LEFT JOIN ${T(i, 'nodes')} n ON n.id = rm.member_ref
                 WHERE rm.member_type = 'node' AND n.id IS NULL`).c;
  totDangling += dang;
  totSampleBad += sampleBad;
  if (sumNc !== cntWn) totNcMismatch++;
  totRelWayDang += rw;
  totRelNodeDang += rn;
  const sumOk = sumNc === cntWn;
  console.log(`  ${tiles[i].id.padEnd(9)} way_nodes 悬挂=${String(dang).padStart(4)}`
    + `  Σnode_count=${sumOk ? '=' : '≠'}way_nodes 行数(${fmt(sumNc)})`
    + `  抽样 300 条 way 的 node_count 不符=${sampleBad}`
    + `  关系成员悬挂: way=${String(rw).padStart(5)} node=${String(rn).padStart(6)}`);
}
check(totDangling === 0, '所有片 way_nodes 引用的节点都在本片内（悬挂 = 0）', `实测悬挂 ${totDangling}`);
check(totNcMismatch === 0, '每片 Σways.node_count 等于本片 way_nodes 行数（总体核对）', `不一致的片数 ${totNcMismatch}`);
check(totSampleBad === 0, '每片抽样 300 条 way 的 node_count 逐条核对通过', `不符 ${totSampleBad}`);
console.log(`  ℹ️  关系成员悬挂合计：way 成员 ${fmt(totRelWayDang)} / node 成员 ${fmt(totRelNodeDang)} —— 这是"relation 只把**成员表**原样搬进片` +
  `（原属主片 + 跨片副本），不做成员级拆分"这条简化的**预期后果**（成员要素本身可能在别的片里）；`);
console.log('      不是几何损坏：way 的几何是自洽的，服务的 omsdb 会把取不到的成员记进 memberWaysMissing。');

/* ================================================================== *
 * ④ 给定 bbox 会命中哪些片
 * ================================================================== */
console.log('\n=== ④ 给定 bbox 会命中哪些片（分区路由）===');
/** 视口矩形与某片是否相交：按 registry 的**每个**矩形判，不能用外包矩形（承德是 L 形） */
function hits(tile, b) {
  if (tile.rects && tile.rects.length) {
    return tile.rects.some((r) => r.min_lat < b.max_lat && b.min_lat < r.max_lat && r.min_lon < b.max_lon && b.min_lon < r.max_lon);
  }
  return true;                                  // 没有 registry 矩形信息时（退化模式）只能全问
}
const ALL = { min_lat: 35.90, max_lat: 42.70, min_lon: 113.40, max_lon: 120.10 };
const viewports = [
  { name: '天安门一带（z14 小视口）', b: { min_lat: 39.895, max_lat: 39.915, min_lon: 116.380, max_lon: 116.420 } },
  { name: '跨 bj-sw/bj-se 边界（lon 116.25）', b: { min_lat: 39.980, max_lat: 40.020, min_lon: 116.200, max_lon: 116.300 } },
  { name: '跨北京/河北边界（lat 39.4408）', b: { min_lat: 39.420, max_lat: 39.470, min_lon: 116.300, max_lon: 116.500 } },
  { name: '河北南部（保定+沧州衡水）', b: { min_lat: 36.500, max_lat: 38.000, min_lon: 114.000, max_lon: 117.000 } },
  { name: '整个数据集', b: ALL },
];
for (const vp of viewports) {
  const hit = tiles.map((t, i) => ({ t, i })).filter(({ t }) => hits(t, vp.b));
  let wayCand = 0;
  let nodeCand = 0;
  const per = [];
  const b = vp.b;
  for (const { t, i } of hit) {
    const wc = q1(`SELECT COUNT(*) c FROM ${T(i, 'way_index')}
                   WHERE max_lon >= ? AND min_lon <= ? AND max_lat >= ? AND min_lat <= ?`,
      b.min_lon, b.max_lon, b.min_lat, b.max_lat).c;
    const nc = q1(`SELECT COUNT(*) c FROM ${T(i, 'node_index')}
                   WHERE max_lon >= ? AND min_lon <= ? AND max_lat >= ? AND min_lat <= ?`,
      b.min_lon, b.max_lon, b.min_lat, b.max_lat).c;
    wayCand += wc;
    nodeCand += nc;
    per.push(`${t.id}(${wc} way / ${nc} node)`);
  }
  console.log(`\n  · ${vp.name}`);
  console.log(`    bbox lat [${b.min_lat}, ${b.max_lat}] lon [${b.min_lon}, ${b.max_lon}]`);
  console.log(`    命中 ${hit.length}/${tiles.length} 片：${hit.map(({ t }) => t.id).join(', ')}`);
  console.log(`    各片 R*Tree 候选：${per.join('  ')}`);
  console.log(`    合计候选 way=${fmt(wayCand)} node=${fmt(nodeCand)}`);
}
console.log('\n  说明：候选数是"各片分别查出来再相加"，跨片边界上的同一条 way 只会出现在**一片**里');
console.log('        （② 已实测片间 way 同 id = 0），所以这里不需要去重；');
console.log('        但被复制到两片的**支撑节点**会在两片各返回一次，合并时要按 id 去重。');

/* ================================================================== *
 * ⑤ 硬断言汇总
 * ================================================================== */
console.log('\n=== ⑤ 硬断言汇总 ===');
check(badWay === 0, '片间 way 同 id 数 = 0（way 永远只属于一片，真正不重叠）', `实测合计 ${badWay}`);
check(badNodeCoord === 0, '片间同 id 节点坐标完全一致（差 0）', `坐标不同的 ${badNodeCoord}`);
check(totDangling === 0, '所有片 way_nodes 无悬挂', `悬挂 ${totDangling}`);
console.log(`  ℹ️  片间 relation 同 id 对数 = ${fmt(relDupPairs)}（**跨片 relation 副本，预期 > 0**）：`
  + `${fmt(copyIds.length)} 条 relation 出现在 ≥2 片里`);
check(badCopyBbox === 0, '同 id relation 副本的 bbox 四列逐位相同', `不一致 ${badCopyBbox} 份`);
check(badCopyMembers === 0, '同 id relation 副本的成员行逐条相同（条数 + seq/type/ref/role）', `不一致 ${badCopyMembers} 份`);
check(badCopyMeta === 0, '同 id relation 副本的 version 与 member_count 相同', `不一致 ${badCopyMeta} 份`);
check(spreadViolations === 0, '副本不扩散：副本只在"bbox 触及的片"里', `扩散 ${spreadViolations} 处`);
if (registry) {
  const anyRect = tiles.every((t) => t.rects && t.rects.length);
  check(anyRect, '每片都有 registry 矩形（路由可判定）');
}

console.log('\n==================== ' + (failures.length ? `有 ${failures.length} 条断言未通过` : '全部断言通过') + ' ====================');
if (failures.length) for (const f of failures) console.log('  ❌ ' + f);

main.close();
process.exitCode = failures.length ? 1 : 0;
