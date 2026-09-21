'use strict';
/**
 * 分区流式（P1）· **"同 id 内容不同"的构造用例**（磁盘上那两片测不出这一条）
 *
 *   node tests/region-divergence-test.js
 *
 * 为什么必须单独测：`data/regions/beijing.sqlite` 与 `hebei.sqlite` 是**严格包含**关系
 * （beijing ⊂ hebei，逐字段差异 0，见 REGIONS.md §0 事实 5），所以它们只能验"同 id 内容相同"。
 * 而 §4.2 规则 0 的三条分支里，真正决定"会不会静默丢数据"的是另外两条：
 *   ① version 不同  → 取 version 大者 + **必须报警**
 *   ② version 相同但内容不同 → nodes/ways 视为**数据损坏**（取属主片 + degraded）
 *   ③ relation 的**派生 bbox** 与成员账本不同 → 取"bbox 非 NULL 且范围更大 / 账本更全"的那一份
 *      （否则那一份会因为 bbox 为 NULL 而从 relation_index 的 R*Tree 里消失）
 *
 * 做法：用仓库自带的导入器造两个**极小**的分片库（同一份元素），再直接改其中一个的
 * `nodes` / `ways` / `relations` 行，制造出上面三种分歧；然后用 `openRegionDB` 走**完整**的
 * 读路径（选片 → 扇出 → 去重 → 合并 → 打包），断言：
 *   · 三种分歧都被如实记账（truncation.regions[].conflicts + health 计数 + 一条 WARN）
 *   · 选中的那一份符合规则（version 大者 / 派生量更全者），**不是**静默取第一片
 *   · 产物仍是合法载荷（每 id 一行、relation 只有一个 bbox 候选等）
 *
 * 造出来的东西全部在 tests/tmp-regions/shards/ 下，**不碰任何真实数据集**。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { OsmDB } = require('../server/osmdb');
const { openRegionDB } = require('../server/regions');
const { importOsm } = require('../tools/import-osm.js');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(__dirname, 'tmp-regions', 'shards');
const FIXTURE = path.join(DIR, 'divergence.osm');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, what, extra) {
  if (cond) { pass += 1; return true; }
  fail += 1;
  failures.push(what + (extra === undefined ? '' : ' → ' + extra));
  console.log('  ✗ ' + what + (extra === undefined ? '' : ' → ' + extra));
  return false;
}
function eq(a, b, what) { return ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }
function section(t) { console.log('\n== ' + t); }

/* ------------------------------ 1. 造两个小分片 ------------------------------ */
/**
 * 元素刻意选在"两片矩形都会命中"的位置（约 39.90/116.40 附近），并且：
 *   node 1: version 会不同（A 改成 5）
 *   node 2: version 相同但坐标不同（数据损坏那一条）
 *   way 10: version 不同（A 改成 9，并且标签不同）
 *   way 11: 完全相同（去重后只应出现一次）
 *   rel 100/101: 成员不同 + 其中一片 bbox 置 NULL（派生 bbox 那一条）
 */
const OSM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="region-divergence-fixture">
  <bounds minlat="39.8900" minlon="116.3900" maxlat="39.9200" maxlon="116.4200"/>
  <node id="1" lat="39.9000000" lon="116.4000000" version="1">
    <tag k="place" v="village"/>
    <tag k="name" v="甲村"/>
  </node>
  <node id="2" lat="39.9010000" lon="116.4010000" version="1"/>
  <node id="3" lat="39.9020000" lon="116.4020000" version="1"/>
  <node id="4" lat="39.9030000" lon="116.4030000" version="1"/>
  <node id="5" lat="39.9040000" lon="116.4040000" version="1">
    <tag k="amenity" v="cafe"/>
    <tag k="name" v="咖啡"/>
  </node>
  <way id="10" version="1">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="分歧路"/>
  </way>
  <way id="11" version="3">
    <nd ref="3"/><nd ref="4"/><nd ref="5"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="同一条路"/>
  </way>
  <way id="12" version="1">
    <nd ref="1"/><nd ref="4"/><nd ref="5"/><nd ref="1"/>
    <tag k="building" v="yes"/>
    <tag k="name" v="同一栋楼"/>
  </way>
  <relation id="100" version="1">
    <member type="way" ref="12" role="outer"/>
    <member type="way" ref="10" role="inner"/>
    <tag k="type" v="multipolygon"/>
    <tag k="building" v="yes"/>
  </relation>
  <relation id="101" version="1">
    <member type="way" ref="10" role=""/>
    <tag k="type" v="route"/>
    <tag k="route" v="road"/>
    <tag k="name" v="同名线"/>
  </relation>
  <relation id="102" version="1">
    <member type="way" ref="11" role="outer"/>
    <tag k="type" v="multipolygon"/>
    <tag k="landuse" v="forest"/>
  </relation>
</osm>
`;
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(FIXTURE, OSM_XML, 'utf8');

const A_DB = path.join(DIR, 'alpha1.sqlite');
const B_DB = path.join(DIR, 'beta1.sqlite');
for (const f of [A_DB, B_DB]) {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(f + suffix); } catch { /* ignore */ } }
}
(async () => {
  await importOsm({ file: FIXTURE, db: A_DB, force: true, quiet: true });
  await importOsm({ file: FIXTURE, db: B_DB, force: true, quiet: true });

  /* ------------------------------ 2. 制造分歧 ------------------------------ */
  {
    const db = new DatabaseSync(A_DB);
    // ① version 不同：node 1（A 更新）+ way 10（A 更新且标签不同）
    db.exec("UPDATE nodes SET version = 5, lat = 39.9100, lon = 116.4100 WHERE id = 1");
    db.exec("UPDATE ways SET version = 9, tags = '{\"highway\":\"primary\",\"name\":\"新名\"}' WHERE id = 10");
    db.exec(`UPDATE way_index SET min_lon = (SELECT min_lon FROM ways WHERE id = 10),
             max_lon = (SELECT max_lon FROM ways WHERE id = 10),
             min_lat = (SELECT min_lat FROM ways WHERE id = 10),
             max_lat = (SELECT max_lat FROM ways WHERE id = 10) WHERE id = 10`);
    // ② version 相同但内容不同：node 2 改坐标（这一条属于"数据损坏"，必须取属主片 + 记 same-version）
    db.exec('UPDATE nodes SET lat = 39.9079, lon = 116.4079 WHERE id = 2');
    db.exec(`UPDATE node_index SET min_lon = (SELECT lon FROM nodes WHERE id = 2),
             max_lon = (SELECT lon FROM nodes WHERE id = 2),
             min_lat = (SELECT lat FROM nodes WHERE id = 2),
             max_lat = (SELECT lat FROM nodes WHERE id = 2) WHERE id = 2`);
    // ③ relation 的成员账本：A 里删掉 relation 100 的一个成员行（version / bbox 都相同，只有成员表不同）
    db.exec('DELETE FROM relation_members WHERE relation_id = 100 AND member_ref = 10');
    db.exec('UPDATE relations SET member_count = 1 WHERE id = 100');
    // ③b relation 102：A 里把派生 bbox 置 NULL（B 里非 NULL）⇒ A 的 relation_index 里没有它
    //     ⇒ 空间查询根本不会返回它。合并结果必须仍然拿到 B 的那一份（这就是"取 NULL 那份会消失"的实测）
    db.exec('UPDATE relations SET min_lon = NULL, max_lon = NULL, min_lat = NULL, max_lat = NULL WHERE id = 102');
    db.close();
    const db2 = new DatabaseSync(B_DB);
    // ④ relation 101：B 里成员更多（成员账本更全），bbox 两片相同 ⇒ 必须取 B
    db2.exec("INSERT INTO relation_members(relation_id, seq, member_type, member_ref, role) VALUES (101, 1, 'way', 12, '')");
    db2.exec('UPDATE relations SET member_count = 2 WHERE id = 101');
    db2.close();
    // 让 A、B 的 relation_index 与基表保持一致（合并只读基表，但查询走 R*Tree：这里手工同步）
    for (const f of [A_DB, B_DB]) {
      const d = new DatabaseSync(f);
      d.exec('DELETE FROM relation_index');
      d.exec(`INSERT OR REPLACE INTO relation_index(id, min_lon, max_lon, min_lat, max_lat)
              SELECT id, min_lon, max_lon, min_lat, max_lat FROM relations WHERE min_lon IS NOT NULL`);
      d.close();
    }
  }

  /* ------------------------------ 3. 注册表（两片矩形相交，都覆盖同一视口） ------------------------------ */
  const REG = path.join(DIR, 'registry-divergence.json');
  const bbox = { minLon: 116.30, minLat: 39.80, maxLon: 116.50, maxLat: 40.00 };
  fs.writeFileSync(REG, JSON.stringify({
    v: 1,
    _note: '构造用例：两片矩形相交、且同 id 的行被人为改出分歧（见 tests/region-divergence-test.js）',
    primary: 'alpha1',
    regions: {
      alpha1: { id: 'alpha1', region: 'alpha', name: '构造片 A', file: 'tests/tmp-regions/shards/alpha1.sqlite', bbox, counts: { nodes: 5, ways: 2, relations: 2 } },
      beta1: { id: 'beta1', region: 'beta', name: '构造片 B', file: 'tests/tmp-regions/shards/beta1.sqlite', bbox, counts: { nodes: 5, ways: 2, relations: 2 } },
    },
  }, null, 2));

  /* ------------------------------ 4. 走完整读路径 ------------------------------ */
  section('构造分歧：走完整读路径（选片 → 扇出 → 去重 → 合并 → 打包）');
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  let payload = null;
  let rdb = null;
  try {
    rdb = openRegionDB({
      osmDb: B_DB,                                   // 单库/回退库用 B（两片并集 ⊇ 它）
      regions: { mode: 'on', registry: REG, fanoutMax: 2, fallbackBelowZoom: 0, mergedBytesLimit: 0, allowOverlap: true },
    }, {});
    payload = rdb.queryBbox({
      ...bbox, zoom: 16, limit: 15000,
      wayCandidates: 12, nodeCandidates: 8, relationLimit: 10000,
      relationCropPad: 0.25, relationCropMinMembers: 64, relationCropBoundaryMembers: false,
      detail: null, lodDetail: 4, lodRoadSend: null, lodRoadClassFloor: null, minFillArea: null,
      lodMinFillArea: 0, neverSend: null, lodNeverSend: true, coalesce: null, compact: true, view: null, flatCaps: false,
    });
  } finally {
    console.warn = origWarn;
  }
  ok(!!payload, '合并查询有返回');
  const info = rdb.regionsInfo();
  const conf = payload.truncation.regions.flatMap((r) => r.conflicts || []);
  eq(payload.truncation.regions.map((r) => r.id), ['alpha1', 'beta1'], 'truncation.regions 按 id 升序列出两片');

  // ① version 不同：整体 WARN + health 计数 + 取 version 大者
  const node1 = conf.find((c) => c.type === 'node' && c.id === 1);
  ok(!!node1, 'node 1（version 5 vs 1）被记进 conflicts', JSON.stringify(conf.map((c) => `${c.type}#${c.id}:${c.kind}`)));
  eq(node1 && node1.versions, [5, 1], 'node 1 的冲突记录里两个 version 都如实列出（A=5 / B=1）');
  eq(node1 && node1.picked, 'alpha1', 'node 1 取 **version 大者**（alpha1，尽管 primary 也是它）');
  eq(payload.nodePack ? decodeNode(payload, 1) : null, [39.91, 116.41], 'node 1 的坐标确实来自 alpha1（新版本）');

  const way10 = conf.find((c) => c.type === 'way' && c.id === 10);
  ok(!!way10 && way10.picked === 'alpha1', 'way 10（version 9 vs 1）取 alpha1（新版本）');
  eq(payload.ways['10'][0], 9, 'way 10 的 version 是 9（取新）');
  eq(payload.ways['10'][2].highway, 'primary', 'way 10 的标签来自新版本那一份');

  // ② version 相同、内容不同：必须取属主片 + 记 same-version（health degraded 的那一类）
  const node2 = conf.find((c) => c.type === 'node' && c.id === 2);
  ok(!!node2 && node2.kind === 'same-version', 'node 2（version 相同、坐标不同）记为 same-version（数据损坏那一类）');
  eq(node2 && node2.picked, 'alpha1', 'node 2 取**属主片**（primary = alpha1）');
  eq(decodeNode(payload, 2), [39.9079, 116.4079], 'node 2 的坐标来自 alpha1（属主片那一份）');
  ok(info.conflicts.sameVersion >= 1, `health 的 sameVersion 冲突计数 ≥ 1（实测 ${info.conflicts.sameVersion}）`);

  // ③ relation 的成员账本更全者优先（version 相同、bbox 相同 → ③ 号判据）
  const rel100 = conf.find((c) => c.type === 'relation' && c.id === 100);
  ok(!!rel100, 'relation 100（A 少一个成员行）被记进 conflicts',
    JSON.stringify(conf.map((c) => `${c.type}#${c.id}:${c.kind}/${c.reason}→${c.picked}`)));
  eq(rel100 && rel100.picked, 'beta1', 'relation 100 取**成员账本更全**的那一份（beta1），不是属主片 alpha1');
  eq(payload.relations['100'][1].length, 2, 'relation 100 的成员表是更全的那一份（2 个成员）');
  const rel101 = conf.find((c) => c.type === 'relation' && c.id === 101);
  ok(!!rel101 && rel101.picked === 'beta1', 'relation 101（B 的成员更多）同样取 beta1');
  eq(payload.relations['101'][1].length, 2, 'relation 101 的成员表是更全的那一份（2 个成员）');

  // ③b relation 102：A 的派生 bbox 为 NULL ⇒ A 的 R*Tree 里没有它 ⇒ A 根本不返回它。
  //    合并结果必须仍然拿到 B 的那一份（"取 NULL 那份就会从空间索引里消失"的实测版）
  ok(payload.relations['102'] !== undefined, 'relation 102（alpha1 的 bbox 为 NULL）在合并结果里**仍然存在**（来自 beta1）');
  ok(!conf.some((c) => c.type === 'relation' && c.id === 102),
    'relation 102 不产生冲突（NULL 那一份压根没进候选，不是"两份内容不同"）');
  eq(payload.truncation.regions.find((r) => r.id === 'alpha1').features.relations, 2,
    'alpha1 这一片返回的 relation 里不含 102（它的 bbox 为 NULL ⇒ 空间索引查不到）');

  // ⑤ 完全相同的元素：去重后只出现一次，且**不**产生冲突
  ok(!conf.some((c) => c.type === 'way' && c.id === 11), 'way 11（两片逐字段相同）**不**产生冲突');
  eq(payload.ways['11'][0], 3, 'way 11 的 version 保持 3（同版本取属主片，内容相同）');
  // 两片各自都返回了同样的 3 条 way / 3 条 relation ⇒ 去重后仍然只有 3 条（不是 6 条）
  eq(payload.truncation.regions.map((r) => r.features.ways), [3, 3], '两片各自返回 3 条 way');
  eq(Object.keys(payload.ways).length, 3, '载荷里每个 way id 只有一份（3+3 → 3，去重生效）');
  eq(Object.keys(payload.relations).length, 3, '载荷里每个 relation id 只有一份');

  // ⑥ 通知链路：一条 WARN + health 计数（绝不静默）
  ok(warns.some((w) => w.includes('同 id 内容不同')), '打了一条 WARN 汇总冲突（console.warn）',
    JSON.stringify(warns.slice(0, 2)));
  ok(info.conflicts.count >= 4, `health regions.conflicts.count 累计到 ${info.conflicts.count}（≥4）`);
  ok(!!info.conflicts.last && !!info.conflicts.last.type, 'health 保留最后一次冲突样本');
  ok(payload.truncation.regions.some((r) => (r.conflictCount || 0) > 0), 'truncation.regions[] 上也有 conflictCount');

  // ⑦ 载荷仍然合法：nodePack 严格递增、无重复
  {
    const ids = [];
    let p = 0;
    for (const d of payload.nodePack.ids) { p += d; ids.push(p); }
    ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), '合并后的 nodePack.ids 严格递增（§4.7 R16 的断言）');
    eq(ids.length, new Set(ids).size, 'nodePack.ids 无重复');
  }
  // ⑧ 同一请求两次 → 除各片耗时 ms 外逐字节相同（§3.1 不变量 3）
  {
    const again = rdb.queryBbox({
      ...bbox, zoom: 16, limit: 15000, wayCandidates: 12, nodeCandidates: 8, relationLimit: 10000,
      relationCropPad: 0.25, relationCropMinMembers: 64, relationCropBoundaryMembers: false,
      detail: null, lodDetail: 4, lodRoadSend: null, lodRoadClassFloor: null, minFillArea: null,
      lodMinFillArea: 0, neverSend: null, lodNeverSend: true, coalesce: null, compact: true, view: null, flatCaps: false,
    });
    ok(JSON.stringify(stripMs(again)) === JSON.stringify(stripMs(payload)),
      '同一 (bbox, zoom) 两次请求的载荷逐字节相同（只除掉各片耗时 ms —— 它是实测值，本来就会变）');
  }

  console.log(`\n[region-divergence-test] 通过 ${pass} 项 · 失败 ${fail} 项`);
  if (fail) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
  try { rdb.close(); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('[region-divergence-test] 崩了：', err.stack || err.message);
  process.exit(2);
});

/** 去掉"每个请求都会变的实测值"（各片 ms），用于"同一请求两次逐字节相同"的断言 */
function stripMs(v) {
  if (Array.isArray(v)) return v.map(stripMs);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'ms') continue;
      out[k] = stripMs(val);
    }
    return out;
  }
  return v;
}

/** 从打包后的 nodePack 里解开某一个节点的坐标（与客户端 World.unpackPayload 同一套算法） */function decodeNode(payload, wantId) {
  const pack = payload.nodePack;
  if (!pack) return payload.nodes ? payload.nodes[wantId] || null : null;
  const s = payload.enc.nodeScale;
  let id = 0; let la = 0; let lo = 0;
  for (let i = 0; i < pack.ids.length; i++) {
    id += pack.ids[i]; la += pack.lat[i]; lo += pack.lon[i];
    if (id === wantId) return [la / s, lo / s];
  }
  return null;
}
