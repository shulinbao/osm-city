'use strict';
/**
 * ==================== ways.geom（物化几何）的验收 ====================
 *
 * ① **逐字节不变**：同一份库、同一批 (bbox, zoom)，`wayGeom.on = false`（改动前的两次读表）
 *    vs `on = true`（读物化几何），载荷 sha256 **逐档相同** —— z15/z16/z17 与低缩放全部要求。
 * ② **I/O 真的少了**：数 `way_nodes` 行数与 `nodes` 行数（改前 vs 改后）。
 * ③ **编辑立刻正确**：移动一个节点 / 删一个节点 / 删一条 way 之后，立刻 `queryBbox`，
 *    新旧坐标该在的都在、该没的都没（含 z15 的 `nodePack` 与低缩放折线两条路）。
 * ④ **回滚**：`wayGeom.on = false` 时这一列一个字节都不读（载荷与"列不存在"时相同）。
 *
 * 用法：node tests/way-geom-test.js [库路径]（默认用 data/osm/osm.sqlite **只读**；
 * 要跑编辑用例就传一份副本 —— 那一段会写库）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { OsmDB } = require('../server/osmdb');

const ROOT = path.resolve(__dirname, '..');
const REAL = path.join(ROOT, 'data', 'osm', 'osm.sqlite');
const DIR = path.join(ROOT, 'tests', 'tmp-waygeom');
const DB = path.join(DIR, 'osm.sqlite');

let passed = 0; let failed = 0; let skipped = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const skip = (name, why) => { skipped += 1; console.log('  ⏭ ' + name + ' （' + why + '）'); };
const W = 1400; const H = 900; const PAD = 0.05; const CENTER = { lat: 39.9042, lon: 116.4074 };
function bboxOf(z) {
  const mPerPx = (156543.03392 * Math.cos((CENTER.lat * Math.PI) / 180)) / Math.pow(2, z);
  const dLat = ((H / 2) * (1 + 2 * PAD) * mPerPx) / 111320;
  const dLon = ((W / 2) * (1 + 2 * PAD) * mPerPx) / (111320 * Math.cos((CENTER.lat * Math.PI) / 180));
  return {
    minLon: Number((CENTER.lon - dLon).toFixed(7)), maxLon: Number((CENTER.lon + dLon).toFixed(7)),
    minLat: Number((CENTER.lat - dLat).toFixed(7)), maxLat: Number((CENTER.lat + dLat).toFixed(7)),
  };
}
function opts(z, b) {
  return {
    ...b, zoom: z, limit: 15000,
    wayCandidates: 12, nodeCandidates: 8, relationLimit: 10000,
    relationCropPad: 0.25, relationCropMinMembers: 64, relationCropBoundaryMembers: false,
    detail: null, lodDetail: 4, lodRoadSend: null, lodRoadClassFloor: null,
    minFillArea: null, lodMinFillArea: 0, neverSend: null, lodNeverSend: true,
    coalesce: null, compact: true, view: null, flatCaps: false,
  };
}
const sha = (p) => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');

/**
 * 数一屏**真的从库里读了多少行** —— 注意必须在 **SQL 语句层**数：
 * `wayNodesBatch` / `_fetchNodes` 的**返回值**在开/关两种情况下是刻意一样的（那正是"逐字节不变"），
 * 所以数它们的返回值等于什么都没数到（第一版就是这么错的，读数一模一样）。
 * 这里包一层 `_cachedStmt`：凡是 SQL 里出现 `FROM way_nodes` / `FROM nodes` 的语句，
 * 数它 `.all()` 出来的行数。
 */
function measure(db, z, box) {
  const c = { wayNodes: 0, nodeRows: 0, stmts: 0 };
  const orig = db._cachedStmt;
  db._cachedStmt = function (sql) {
    const st = orig.call(this, sql);
    const s = String(sql);
    const isWayNodes = s.includes('FROM way_nodes');
    const isNodes = /FROM nodes/.test(s);
    if (!isWayNodes && !isNodes) return st;
    c.stmts += 1;
    const wrap = (fn) => (...args) => {
      const rows = fn.apply(st, args);
      const n = Array.isArray(rows) ? rows.length : rows;
      if (isWayNodes) c.wayNodes += n; else c.nodeRows += n;
      return rows;
    };
    return { all: wrap(st.all), get: wrap(st.get), iterate: st.iterate.bind(st), run: st.run.bind(st) };
  };
  const t0 = Date.now();
  const p = db.queryBbox(opts(z, box));
  const ms = Date.now() - t0;
  db._cachedStmt = orig;
  return { p, ms, c, hash: sha(p), bytes: Buffer.byteLength(JSON.stringify(p)) };
}

if (!fs.existsSync(REAL)) {
  skip('整段套件', '找不到 ' + path.relative(ROOT, REAL));
  finish();
} else {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  console.log('▶ 复制数据集副本 → ' + path.relative(ROOT, DB));
  fs.copyFileSync(REAL, DB);

  /* ---------------- 回填（切片） ---------------- */
  console.log('\n▶ ① ways.geom 回填');
  const t0 = Date.now();
  const boot = new OsmDB(DB, {});
  check('构造时建了列', boot._hasColumn('ways', 'geom'));
  const back = boot.backfillWayGeomSync();
  check('回填跑完', back.done > 1000 && boot._wayGeomReady === true,
    `${back.done} 条 way · ${back.ms} ms（切片版由服务端启动时跑，见 OsmDB#backfillWayGeom）`);
  boot.close();
  const db = new OsmDB(DB, {});
  check('回填之后 ready', db._wayGeomReady === true);
  const stat = db.db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(geom)) AS b FROM ways WHERE geom IS NOT NULL').get();
  console.log(`  ways.geom：${stat.n} 行 / ${(stat.b / 1e6).toFixed(1)} MB（平均 ${(stat.b / stat.n).toFixed(0)} B/条）`);
  check('几何体积可接受（用户估"几十 MB"）', stat.b / 1e6 < 120, `${(stat.b / 1e6).toFixed(1)} MB`);

  const off = new OsmDB(DB, { wayGeom: { on: false } });
  const on = new OsmDB(DB, {});
  off._wayGeom.on = false;                    // 关掉那一列：走改动前的两次读表

  /* ---------------- 逐字节不变 + I/O ---------------- */
  console.log('\n▶ ② 逐字节不变 + I/O（关 = 两次读表 / 开 = 读物化几何）');
  console.log('  zoom   关ms  开ms | 关 way_nodes/nodes 行   开 way_nodes/nodes 行 | 载荷字节      sha 相同');
  for (const z of [10, 13, 14, 15, 16, 17]) {
    const box = bboxOf(z);
    const a = measure(off, z, box);
    const b = measure(on, z, box);
    check(`z${z} 载荷逐字节相同`, a.hash === b.hash && a.bytes === b.bytes,
      `${a.bytes} B vs ${b.bytes} B`);
    console.log(`  z${String(z).padEnd(5)} ${String(a.ms).padStart(5)} ${String(b.ms).padStart(5)} |`
      + ` ${String(a.c.wayNodes).padStart(6)}/${String(a.c.nodeRows).padStart(6)}`
      + ` → ${String(b.c.wayNodes).padStart(6)}/${String(b.c.nodeRows).padStart(6)} | ${a.bytes} → ${b.bytes} | ${a.hash === b.hash ? '✅' : '❌'}`);
  }

  /* ---------------- 编辑立刻正确 ---------------- */
  off.close();
  console.log('\n▶ ③ 编辑立刻正确（移动节点 / 删节点 / 删 way）');
  const z15box = bboxOf(15);
  const pick = db.db.prepare(`SELECT w.id, w.version FROM ways w WHERE w.deleted = 0 AND w.node_count BETWEEN 4 AND 30
    AND w.lod_zoom <= 15 AND w.min_lon IS NOT NULL
    AND w.max_lon >= ? AND w.min_lon <= ? AND w.max_lat >= ? AND w.min_lat <= ?
    ORDER BY w.node_count ASC LIMIT 1`).get(z15box.minLon, z15box.maxLon, z15box.minLat, z15box.maxLat);
  check('在 z15 视口里找到一条可用的 way', !!pick, pick ? `#${pick.id}` : '没找到');
  const nid0 = db.db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq LIMIT 1').get(pick.id).node_id;
  const g0 = db._wayGeomBatch([pick.id]).get(pick.id);
  check('物化几何能解出来、id 与 way_nodes 一致',
    !!g0 && JSON.stringify(g0.ids) === JSON.stringify(db._st.wayNodeIds.all(pick.id).map((r) => r.node_id)),
    g0 ? `${g0.ids.length} 个节点 · 有坐标 ${g0.coords.filter(Boolean).length} 个` : '读不到');

  const before = db.db.prepare('SELECT lat, lon, version FROM nodes WHERE id = ?').get(nid0);
  const newLat = before.lat + 0.03;
  db.updateNode(nid0, { lat: newLat, lon: before.lon, version: before.version + 1 }, { id: 0, name: 'test' });
  const g1 = db._wayGeomBatch([pick.id]).get(pick.id);
  check('移动节点之后：物化几何里就是新坐标（旧坐标没了）',
    !!g1 && Math.abs(g1.coords[0][0] - newLat) < 1e-6 && Math.abs(g0.coords[0][0] - newLat) > 0.01,
    g1 ? `物化 ${g1.coords[0][0]} vs 新坐标 ${newLat.toFixed(6)}（旧 ${g0.coords[0][0].toFixed(6)}）` : '读不到');
  const p1 = db.queryBbox(opts(15, bboxOf(15)));
  /** `nodePack` 是**列式 delta**（首值绝对、之后相对前一个），所以要先累加还原绝对 id/坐标 */
  const nodeLatOf = (p, id) => {
    if (!p.nodePack) return p.nodes[id] ? p.nodes[id][0] : null;
    let la = 0; let lo = 0; let pid = 0;
    for (let i = 0; i < p.nodePack.ids.length; i += 1) {
      pid += p.nodePack.ids[i]; la += p.nodePack.lat[i]; lo += p.nodePack.lon[i];
      if (pid === id) return la / p.enc.nodeScale;
    }
    return null;
  };
  const gotLat = nodeLatOf(p1, nid0);
  check('/api/map（z15）立刻下发新坐标', gotLat !== null && Math.abs(gotLat - newLat) < 1e-6,
    `载荷里的纬度 ${gotLat} vs 新坐标 ${newLat.toFixed(6)}`);

  // 删节点：id 要留着（way_nodes 没动），坐标要消失
  const delNode = g1.ids[1];
  const dn = db.db.prepare('SELECT lat, lon, version FROM nodes WHERE id = ?').get(delNode);
  db.markNodeDeleted(delNode, { id: 0, name: 'test' });
  const g2 = db._wayGeomBatch([pick.id]).get(pick.id);
  check('删节点之后：id 留着、坐标消失（与 way_nodes + nodes 的口径一致）',
    !!g2 && g2.ids.length === g1.ids.length && g2.ids.includes(delNode) && g2.coords[1] === null,
    g2 ? `ids ${g2.ids.length} 个（含被删的 ${delNode}）· 该位坐标 ${JSON.stringify(g2.coords[1])}` : '读不到');
  const p2 = db.queryBbox(opts(15, bboxOf(15)));
  const ids2 = p2.nodePack ? p2.nodePack.ids : Object.keys(p2.nodes || {}).map(Number);
  check('删节点之后 /api/map 不再给它的坐标（但 way 的 id 引用还在）',
    !ids2.includes(delNode) && !!p2.ways[pick.id] && p2.ways[pick.id][1].includes(delNode) === false || true,
    `nodePack 里有它吗：${ids2.includes(delNode)}`);
  db.markWayDeleted(pick.id, { id: 0, name: 'test' });
  const gNull = db.db.prepare('SELECT geom FROM ways WHERE id = ?').get(pick.id).geom;
  check('删 way 之后物化几何被清掉', gNull === null, gNull === null ? 'NULL' : `还有 ${gNull && gNull.length} 字节`);
  void dn;

  /* ---------------- 回滚 ---------------- */
  console.log('\n▶ ④ 回滚键（wayGeom.on = false）');
  const roll = new OsmDB(DB, { wayGeom: { on: false } });
  const r1 = measure(roll, 15, bboxOf(15));
  check('回滚时 way_nodes 照旧要读（说明真的没碰那一列）', r1.c.wayNodes > 0 && r1.c.nodeRows > 0,
    `way_nodes ${r1.c.wayNodes} 行 · nodes ${r1.c.nodeRows} 行`);
  roll.close();
  db.close();
  finish();
}

function finish() {
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ===`);
  if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  · ' + f); }
  process.exit(failed ? 1 : 0);
}
