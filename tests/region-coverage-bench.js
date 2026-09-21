'use strict';
/**
 * 分区流式 · **覆盖缺口量测**（只读；不起服务、不写任何库）
 *
 *   node tests/region-coverage-bench.js [选项]
 *
 * 选项：
 *   --registry <path>   分片注册表（默认 data/regions/registry.json）
 *   --fallback <path>   参考"单库"（同时也是 RegionDB 的 fallback；默认 tests/tmp-regions/hebei.sqlite）
 *   --zooms 16,15,14    要量的缩放档（默认 16,15,14,13,12,11）
 *   --json <path>       把逐档结果写成 JSON（做修前/修后对照）
 *   --detail            逐条列出"缺掉的 way / relation"（id、tags、bbox、属主片）
 *   --label <text>      报告抬头（例如 "修前" / "修后"）
 *
 * ## 它回答什么问题
 * `tests/region-tiles-test.js`（服务端那条战线的验收）已经把缺口量出来了，但它量在
 * **它自己的快照注册表**上、且只打印一行。本脚本把同一件事做成**可复现的修前/修后对照**：
 *
 *   ① 用**真实的**服务端代码：`openRegionDB()` 造 RegionDB（选片走 `resolve()`），
 *      单库参考用 `OsmDB`；两边都用同一份 `queryBbox` 参数（与 region-tiles-test.js 逐字相同）；
 *   ② 核心指标 = **"bbox 与视口相交、却不在被选中的片里"的 relation 数**
 *      （= 单库有、分区路径没有，且该 relation 在参考库里的 bbox 与视口相交）；
 *   ③ 顺带量 way 侧同一口径的缺口（并说明缺的是"视口内"还是"视口外但被关系引用"）；
 *   ④ 冲突记账（`regionsInfo().conflicts` 与 `truncation.regions[].conflicts`）、
 *      关系成员完整度（kept 条数）、字节数，一并如实报出。
 *
 * 为什么不含 z10：z10 会命中 7 片 > 默认 fanoutMax=2，服务端按设计**回退单库**
 * （回退路径逐字节等于单库，缺口恒为 0，量它没有信息量）。本脚本仍然把 fallbackBelowZoom
 * 设为 0、fanoutMax 设为 8 以便把分片路径打开；z11 起才有意义。
 */

const fs = require('fs');
const path = require('path');

// node:sqlite 的实验性告警早于 server/dbschema.js 静音，这里提前拦掉
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};

const { DatabaseSync } = require('node:sqlite');
const { OsmDB } = require('../server/osmdb');
const { openRegionDB, loadRegistry } = require('../server/regions');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const has = (n) => argv.includes('--' + n);

const REGISTRY = path.resolve(ROOT, argOf('registry') || 'data/regions/registry.json');
const FALLBACK = path.resolve(ROOT, argOf('fallback') || 'tests/tmp-regions/hebei.sqlite');
const ZOOMS = (argOf('zooms') || '16,15,14,13,12,11').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
const JSON_OUT = argOf('json') ? path.resolve(ROOT, argOf('json')) : null;
const LABEL = argOf('label') || '(未标注)';
const DETAIL = has('detail');

if (!fs.existsSync(FALLBACK)) {
  console.error(`参考单库不存在：${FALLBACK}`);
  process.exit(2);
}
if (!fs.existsSync(REGISTRY)) {
  console.error(`注册表不存在：${REGISTRY}`);
  process.exit(2);
}

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/* ---------------- 视口口径：与 tests/region-tiles-test.js 逐字相同 ---------------- */
const W = 1400; const H = 900; const PAD = 0.05;
const CENTER = { lat: 39.9042, lon: 116.4074 };            // 天安门
function bboxOf(z, center = CENTER) {
  const mPerPx = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, z);
  const dLat = ((H / 2) * (1 + 2 * PAD) * mPerPx) / 111320;
  const dLon = ((W / 2) * (1 + 2 * PAD) * mPerPx) / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return {
    minLon: Number((center.lon - dLon).toFixed(7)), maxLon: Number((center.lon + dLon).toFixed(7)),
    minLat: Number((center.lat - dLat).toFixed(7)), maxLat: Number((center.lat + dLat).toFixed(7)),
  };
}
function queryOpts(z, b, over = {}) {
  return Object.assign({
    ...b, zoom: z, limit: 15000,
    wayCandidates: 12, nodeCandidates: 8, relationLimit: 10000,
    relationCropPad: 0.25, relationCropMinMembers: 64, relationCropBoundaryMembers: false,
    detail: null, lodDetail: 4, lodRoadSend: null, lodRoadClassFloor: null,
    minFillArea: null, lodMinFillArea: 0, neverSend: null, lodNeverSend: true,
    coalesce: null, compact: true, view: null, flatCaps: false,
  }, over);
}
const idsetNums = (dict) => Object.keys(dict || {}).map(Number).sort((a, b) => a - b);
const diffIds = (a, b) => { const sb = new Set(b); return a.filter((x) => !sb.has(x)); };
const bytesOf = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');

/* ---------------- 打开：参考单库 + 真实的 RegionDB ---------------- */
console.log('==================== 分区覆盖缺口量测 ====================');
console.log(`标注     : ${LABEL}`);
console.log(`注册表   : ${path.relative(ROOT, REGISTRY)}`);
console.log(`参考单库 : ${path.relative(ROOT, FALLBACK)}（${(fs.statSync(FALLBACK).size / 1073741824).toFixed(2)} GB）`);
console.log(`视口     : 1400×900 + pad 5%，中心 ${CENTER.lat},${CENTER.lon}`);
console.log(`缩放档   : ${ZOOMS.join(', ')}\n`);

const reg = loadRegistry(REGISTRY, { allowOverlap: true });
console.log(`注册表自检：ok=${reg.ok} · ${reg.list.length} 片 · 矩形相交 ${reg.overlaps.length} 处 · primary=${reg.primary}`
  + `${reg.primaryDerived ? '(推导)' : ''}`);
if (reg.errors.length) console.log('  errors: ' + reg.errors.join(' | '));

/** A2：库内真实计数 vs 注册表声明（不一致就说明"正在重建"，内容结论不可信） */
let inFlux = false;
console.log('\n=== A. 分片数据完整性（决定内容结论能不能信）===');
for (const rec of reg.list) {
  const db = new DatabaseSync(rec.file, { readOnly: true });
  const c = db.prepare('SELECT (SELECT COUNT(*) FROM nodes) n,(SELECT COUNT(*) FROM ways) w,'
    + '(SELECT COUNT(*) FROM relations) r,(SELECT COUNT(*) FROM relation_members) m').get();
  const crossTile = db.prepare("SELECT value FROM meta WHERE key='cross_tile'").get();
  db.close();
  const same = c.n === rec.counts.nodes && c.w === rec.counts.ways && c.r === rec.counts.relations
    && c.m === rec.counts.relationMembers;
  if (!same) inFlux = true;
  console.log(`  ${rec.id.padEnd(8)} nodes=${fmt(c.n).padStart(10)} ways=${fmt(c.w).padStart(9)} relations=${fmt(c.r).padStart(6)}`
    + ` members=${fmt(c.m).padStart(8)}  与 registry ${same ? '一致' : '**不一致**'}`
    + `  跨片副本 meta: ${crossTile ? JSON.parse(crossTile.value).replicated + ' 条' : '（无）'}`);
}
console.log(inFlux ? '  ⇒ **有片与注册表声明不一致**：内容结论要打问号（可能正在重建）'
  : '  ⇒ 10 片的真实计数与注册表声明逐个一致');

/** 参考库的 relation bbox：关系表的四列 vs relation_index 的四列（口径说明用） */
const refBase = new DatabaseSync(FALLBACK, { readOnly: true });
{
  const row = refBase.prepare(`SELECT
      (SELECT COUNT(*) FROM relations WHERE min_lon IS NOT NULL) a,
      (SELECT COUNT(*) FROM relation_index) b,
      (SELECT COUNT(*) FROM relations r JOIN relation_index i ON i.id = r.id
        WHERE ABS(r.min_lon - i.min_lon) > 1e-4 OR ABS(r.max_lon - i.max_lon) > 1e-4
           OR ABS(r.min_lat - i.min_lat) > 1e-4 OR ABS(r.max_lat - i.max_lat) > 1e-4) c`).get();
  console.log(`  参考库 relation bbox：relations 表非空 ${fmt(row.a)} · relation_index ${fmt(row.b)}`
    + ` · 两者相差 >1e-4 的 ${row.c}（R*Tree 坐标存 32 位浮点，逐行比"值不等"是正常的舍入）`);
}
const relBboxStmt = refBase.prepare('SELECT min_lon, max_lon, min_lat, max_lat FROM relations WHERE id = ?');
const relTagsStmt = refBase.prepare('SELECT tags, version, member_count FROM relations WHERE id = ?');
const wayBboxStmt = refBase.prepare('SELECT min_lon, max_lon, min_lat, max_lat FROM ways WHERE id = ?');
const wayInfoStmt = refBase.prepare('SELECT tags, version, node_count FROM ways WHERE id = ?');
const memberStmt = refBase.prepare("SELECT COUNT(*) AS c FROM relation_members WHERE member_type='way' AND member_ref = ?");
const hitBox = (r, b) => !!r && r.min_lon !== null
  && r.min_lon <= b.maxLon && r.max_lon >= b.minLon && r.min_lat <= b.maxLat && r.max_lat >= b.minLat;

const single = new OsmDB(FALLBACK, { readOnly: true });
const rdb = openRegionDB({
  osmDb: FALLBACK,
  regions: {
    mode: 'on', registry: REGISTRY, fanoutMax: 8, fallbackBelowZoom: 0,
    mergedBytesLimit: 4194304, allowOverlap: true, conflictListMax: 20,
  },
}, {});

/* ================================================================== *
 * B. 逐档量测
 * ================================================================== */
console.log('\n=== B. 逐档缺口（口径：单库有、分区路径没有；再看它的 bbox 是否与视口相交）===');
const results = [];
for (const z of ZOOMS) {
  const b = bboxOf(z);
  const hit = rdb.resolve(b);
  const opts = queryOpts(z, b);
  const got = rdb.queryBbox(opts);
  const ref = single.queryBbox(opts);
  const info = rdb.regionsInfo();

  const gotWays = idsetNums(got.ways);
  const refWays = idsetNums(ref.ways);
  const gotRels = idsetNums(got.relations);
  const refRels = idsetNums(ref.relations);
  const missWays = diffIds(refWays, gotWays);
  const missRels = diffIds(refRels, gotRels);
  const extraRels = diffIds(gotRels, refRels);

  // way 缺口分类（与 region-tiles-test.js 同一套）
  let waysInside = 0; let waysMemberOnly = 0; const waysOther = [];
  const waysInsideIds = [];
  for (const id of missWays) {
    const r = wayBboxStmt.get(id);
    if (hitBox(r, b)) { waysInside += 1; waysInsideIds.push(id); }
    else if (memberStmt.get(id).c > 0) waysMemberOnly += 1;
    else waysOther.push(id);
  }
  // relation 缺口里"bbox 与视口相交"的条数 = 本脚本的核心指标
  const relInsideIds = [];
  for (const id of missRels) if (hitBox(relBboxStmt.get(id), b)) relInsideIds.push(id);

  // 成员完整度：两边都有的关系，kept 条数对比（分区路径少了多少成员几何）
  let memberKeptGot = 0; let memberKeptRef = 0; let relWithEmptyKept = 0; let relWithEmptyKeptRef = 0;
  for (const id of refRels) {
    const a = ref.relations[id];
    const g = got.relations[id];
    if (a) memberKeptRef += (a[1] || []).length;
    if (g) memberKeptGot += (g[1] || []).length;
    if (g && (!g[1] || !g[1].length)) relWithEmptyKept += 1;
    if (a && (!a[1] || !a[1].length)) relWithEmptyKeptRef += 1;
  }

  // 冲突记账（服务端 regions.js 的 build() 收集、commitConflicts 累计）
  const conflictList = [];
  for (const e of got.truncation && got.truncation.regions ? got.truncation.regions : []) {
    if (e.conflictCount) conflictList.push({ shard: e.id, conflictCount: e.conflictCount, sample: (e.conflicts || []).slice(0, 3) });
  }
  const passthrough = got.truncation.regions === undefined;

  const row = {
    zoom: z, bbox: b, hit, passthrough,
    ways: { got: gotWays.length, ref: refWays.length, miss: missWays.length, inside: waysInside, memberOnly: waysMemberOnly, other: waysOther.length },
    relations: { got: gotRels.length, ref: refRels.length, miss: missRels.length, inside: relInsideIds.length, extra: extraRels.length },
    nodes: { got: got.nodePack.ids.length, ref: ref.nodePack.ids.length },
    members: { keptGot: memberKeptGot, keptRef: memberKeptRef, emptyKeptGot: relWithEmptyKept, emptyKeptRef: relWithEmptyKeptRef },
    bytes: { got: bytesOf(got), ref: bytesOf(ref) },
    conflicts: { total: info.conflicts.count, derived: info.conflicts.derived, sameVersion: info.conflicts.sameVersion, perShard: conflictList },
    fallbacks: info.requests,
    waysInsideIds, relInsideIds, extraRels,
    missingRelIds: missRels,
  };
  results.push(row);

  console.log(`\n  · z${z} · 命中 ${hit.length} 片（${hit.join(',') || '（无）'}）`
    + `${passthrough ? ' · **单片直通**（不加 truncation.regions）' : ''} · 打开 ${info.opened} 片`);
  console.log(`    relation：分区 ${row.relations.got} / 单库 ${row.relations.ref}`
    + ` · 缺 ${row.relations.miss}（其中 **bbox 与视口相交 ${row.relations.inside}**）· 多 ${row.relations.extra}`);
  console.log(`    way     ：分区 ${row.ways.got} / 单库 ${row.ways.ref}`
    + ` · 缺 ${row.ways.miss}（**bbox 与视口相交 ${row.ways.inside}** / 视口外但被关系引用 ${row.ways.memberOnly} / 其余 ${row.ways.other}）`);
  console.log(`    node    ：分区 ${row.nodes.got} / 单库 ${row.nodes.ref} · 成员 kept ${row.members.keptGot} vs ${row.members.keptRef}`
    + `（分区里 kept 为空的关系 ${row.members.emptyKeptGot} 条，单库 ${row.members.emptyKeptRef} 条）`);
  console.log(`    冲突记账：${row.conflicts.total} 处（derived ${row.conflicts.derived} / same-version ${row.conflicts.sameVersion}）`
    + `${conflictList.length ? ' · 逐片 ' + conflictList.map((c) => `${c.shard}:${c.conflictCount}`).join(' ') : ''}`);
  console.log(`    字节    ：${fmt(row.bytes.got)} vs ${fmt(row.bytes.ref)}（${((row.bytes.got / row.bytes.ref - 1) * 100).toFixed(1)}%）`
    + ` · 回退计数 ${JSON.stringify(row.fallbacks)}`);
}

/* ================================================================== *
 * C. 结论（对照核心指标）
 * ================================================================== */
console.log('\n=== C. 核心指标（bbox 与视口相交却不在被选中的片里的 relation 数）===');
console.log('  zoom  命中片数  分区relation  单库relation   缺  其中bbox相交');
for (const r of results) {
  console.log(`  z${String(r.zoom).padEnd(5)} ${String(r.hit.length).padStart(6)} ${String(r.relations.got).padStart(13)}`
    + ` ${String(r.relations.ref).padStart(13)} ${String(r.relations.miss).padStart(5)} ${String(r.relations.inside).padStart(12)}`);
}
const z16 = results.find((r) => r.zoom === 16);
if (z16) {
  console.log(`\n  ⇒ z16 天安门视口：核心指标 = **${z16.relations.inside}**`
    + `（单库返回 ${z16.relations.ref} 条 relation，分区路径 ${z16.relations.got} 条，缺 ${z16.relations.miss} 条）`);
  console.log(`     way 侧同口径 = ${z16.ways.inside}（缺 ${z16.ways.miss} 条里与视口相交的条数）`);
}

/* ================================================================== *
 * E. way 侧的同类缺口：有多少 way 的 bbox 跨出自己所在的片
 * ================================================================== */
console.log('\n=== E. way 侧同类缺口的规模（决定"要不要一起修 way"）===');
console.log('  way 与 relation 同源：整条 way 只进**一片**（按中间节点定片），而它的几何可以伸进别的片的视口。');
console.log('  下面逐 way 算"它的 bbox 触及几片"（触及 ≥2 片 = 有被漏掉的风险）；这**不等于**实际缺口');
console.log('  （实际缺口还要看视口落点，见 B 节：z16/z15/z14 各 1 条、z13/z12/z11 各 0 条）。');
{
  const hist = {};
  let multiTiles = 0;
  let multiRows = 0;             // 若把跨片 way 也复制，多出来的 way_nodes 行数
  let multiWays = 0;
  const top = [];
  for (const rec of reg.list) {
    const db = new DatabaseSync(rec.file, { readOnly: true });
    for (const w of db.prepare('SELECT id, node_count, min_lat, max_lat, min_lon, max_lon FROM ways WHERE min_lon IS NOT NULL').iterate()) {
      const b = { min_lat: Number(w.min_lat), max_lat: Number(w.max_lat), min_lon: Number(w.min_lon), max_lon: Number(w.max_lon) };
      let n = 0;
      for (const other of reg.list) {
        if (other.rects.some((r) => r.minLat <= b.max_lat && r.maxLat >= b.min_lat && r.minLon <= b.max_lon && r.maxLon >= b.min_lon)) n += 1;
      }
      hist[n] = (hist[n] || 0) + 1;
      if (n >= 2) {
        multiWays += 1;
        multiTiles += n - 1;
        multiRows += (n - 1) * Number(w.node_count || 0);
        if (top.length < 8 || Number(w.node_count) > top[top.length - 1].nodes) {
          top.push({ id: Number(w.id), nodes: Number(w.node_count), tiles: n, owner: rec.id });
          top.sort((a, b2) => b2.nodes - a.nodes);
          if (top.length > 8) top.pop();
        }
      }
    }
    db.close();
  }
  const total = Object.values(hist).reduce((a, b) => a + b, 0);
  console.log('  bbox 触及片数分布：' + Object.keys(hist).sort((a, b) => a - b).map((k) => `${k} 片→${fmt(hist[k])}`).join(' · '));
  console.log(`  合计 ${fmt(total)} 条 way；跨片（≥2 片）的 ${fmt(multiWays)} 条（${((multiWays / total) * 100).toFixed(2)}%）`);
  console.log(`  若把 way 也按同一套规则复制：多 ${fmt(multiTiles)} 份 way、多 ${fmt(multiRows)} 行 way_nodes ——`);
  console.log('  ⚠ 那会**打破"片间 way 同 id = 0"**这条硬断言，并且 way 的几何支撑节点也要跟着复制（数据量与写库时间都上台阶）。');
  if (top.length) {
    console.log('  跨片最"长"的几条 way（节点最多的）：');
    for (const t of top) console.log(`     way ${String(t.id).padStart(12)} 节点 ${String(t.nodes).padStart(6)} 触及 ${t.tiles} 片 属主片 ${t.owner}`);
  }
}

/* ================================================================== *
 * D. 明细
 * ================================================================== */
if (DETAIL) {
  console.log('\n=== D. 缺掉的条目明细（bbox / tags / 属主片）===');
  const ownerOf = new Map();
  for (const rec of reg.list) {
    const db = new DatabaseSync(rec.file, { readOnly: true });
    for (const r of db.prepare('SELECT id FROM relations').iterate()) {
      if (!ownerOf.has(Number(r.id))) ownerOf.set(Number(r.id), rec.id);
    }
    db.close();
  }
  for (const r of results) {
    if (!r.relInsideIds.length && !r.waysInsideIds.length) continue;
    console.log(`\n  · z${r.zoom}`);
    for (const id of r.relInsideIds) {
      const rb = relBboxStmt.get(id);
      const ti = relTagsStmt.get(id) || {};
      const tags = (() => { try { return JSON.parse(ti.tags || '{}'); } catch { return {}; } })();
      console.log(`    relation ${id} · 成员 ${ti.member_count} · version ${ti.version}`
        + ` · bbox [${Number(rb.min_lat).toFixed(4)},${Number(rb.max_lat).toFixed(4)}]×[${Number(rb.min_lon).toFixed(4)},${Number(rb.max_lon).toFixed(4)}]`
        + ` · 属主片 ${ownerOf.get(id) || '**不在任何片**'}`
        + ` · type=${tags.type || '-'} name=${tags.name || tags.ref || '-'} route=${tags.route || '-'} boundary=${tags.boundary || '-'}`);
    }
    for (const id of r.waysInsideIds) {
      const wb = wayBboxStmt.get(id);
      const wi = wayInfoStmt.get(id) || {};
      const tags = (() => { try { return JSON.parse(wi.tags || '{}'); } catch { return {}; } })();
      console.log(`    way      ${id} · 节点 ${wi.node_count} · version ${wi.version}`
        + ` · bbox [${Number(wb.min_lat).toFixed(4)},${Number(wb.max_lat).toFixed(4)}]×[${Number(wb.min_lon).toFixed(4)},${Number(wb.max_lon).toFixed(4)}]`
        + ` · highway=${tags.highway || '-'} name=${tags.name || '-'} railway=${tags.railway || '-'}`
        + ` · 被关系引用 ${memberStmt.get(id).c} 次`);
    }
  }
}

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    label: LABEL, registry: path.relative(ROOT, REGISTRY), fallback: path.relative(ROOT, FALLBACK),
    generated_at: new Date().toISOString(), in_flux: inFlux, results,
  }, null, 2) + '\n');
  console.log(`\nJSON 已写：${path.relative(ROOT, JSON_OUT)}`);
}

try { single.close(); } catch { /* ignore */ }
try { rdb.close(); } catch { /* ignore */ }
process.exitCode = 0;
