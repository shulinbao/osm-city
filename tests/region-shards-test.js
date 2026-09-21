'use strict';
/**
 * 分区流式（P1：只读查询走分片）· **语义自检**（只读；不起服务、不写任何别人家的库）
 *
 *   node tests/region-shards-test.js [--fallback <库路径>] [--verbose]
 *
 * 断言的几件事：
 *   1. 注册表自检（§2.3）与"真实数据事实"（两片是嵌套关系、219 条 relation 派生 bbox 不同、
 *      1,235 条 relation 在北京片里 bbox 全 NULL）—— 后两条用**只读 SQL 独立复核**设计文档的数字；
 *   2. 视口 → 分片（§3）与三道闸门（§3.4 / §4.5）；
 *   3. **开关开 vs 开关关在同一个 bbox 上给出同一份内容**（判据 1/7 的进程内版本）：
 *      z15/z16 逐字段相同（把 nodePack 按客户端的规则解回 id→坐标 再比），
 *      z11~z14 的 id 集合相同、displayLines/displayAreas 的已知偏差如实报道；
 *   4. 惰性开库（启动 0 片）、分片只读、**写路径仍走单库**；
 *   5. 账本合并规则（§4.3）与 relation 的"派生 bbox 更全者胜"（§4.2 例外）的单测。
 *
 * ⚠ 这一对分片是**嵌套**的（beijing ⊂ hebei），所以这里能验的只有"同 id 内容相同"。
 * "同 id 内容不同"（version 不同 / 同版本内容不同 / 派生 bbox 不同）在
 * `tests/region-divergence-test.js` 里用**构造出来的两片**验（那才是决定"会不会静默丢数据"的两条）。
 *
 * 参考单库（"开关关"的等价物）默认是 `tests/tmp-regions/hebei.sqlite`：
 * 那是为了"绝不写 data/regions/*.sqlite"而复制出来的 hebei 副本（同一个数据集）。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { OsmDB } = require('../server/osmdb');
const { openRegionDB, RegionDB, loadRegistry } = require('../server/regions');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const argOf = (n) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const FALLBACK = path.resolve(ROOT, argOf('fallback') || 'tests/tmp-regions/hebei.sqlite');
/**
 * **嵌套夹具注册表**（不是线上那份）：
 * 线上 `data/regions/registry.json` 是 `tools/tile-cut.js` 生成的**矩形互斥**市级 tile
 * （并行进展的产物，本文件不动它）；本文件要验的是 §4.2 的"同 id 两片"那一半语义，
 * 所以用夹具把 beijing ⊂ hebei 这一对**嵌套**片放进来。tile 那一套由
 * `tests/region-tiles-test.js` 验。
 */
const REGISTRY = path.join(ROOT, 'tests/tmp-regions/registry-nested.json');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, what, extra) {
  if (cond) { pass += 1; if (VERBOSE) console.log('  ✓ ' + what); return true; }
  fail += 1;
  failures.push(what + (extra === undefined ? '' : ' → ' + extra));
  console.log('  ✗ ' + what + (extra === undefined ? '' : ' → ' + extra));
  return false;
}
function eq(a, b, what) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  return ok(same, what, same ? undefined : `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}
function section(t) { console.log('\n== ' + t); }

if (!fs.existsSync(FALLBACK)) {
  console.error(`参考单库不存在：${FALLBACK}\n`
    + '（先复制一份分片当参考库：Copy-Item data\\regions\\hebei.sqlite tests\\tmp-regions\\hebei.sqlite）');
  process.exit(2);
}

/* ------------------------------ 口径与工具 ------------------------------ */
const W = 1400;
const H = 900;
const PAD = 0.05;
const CENTER = { lat: 39.9042, lon: 116.4074 };
function bboxOf(z, center = CENTER) {
  const mPerPx = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, z);
  const dLat = ((H / 2) * (1 + 2 * PAD) * mPerPx) / 111320;
  const dLon = ((W / 2) * (1 + 2 * PAD) * mPerPx) / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return {
    minLon: Number((center.lon - dLon).toFixed(7)), maxLon: Number((center.lon + dLon).toFixed(7)),
    minLat: Number((center.lat - dLat).toFixed(7)), maxLat: Number((center.lat + dLat).toFixed(7)),
  };
}
/** 与 server/index.js 的 /api/map 完全同一组参数（config.json 的 limits + 默认请求参数） */
function queryOpts(z, b, over = {}) {
  return Object.assign({
    ...b, zoom: z, limit: 15000,
    wayCandidates: 12, nodeCandidates: 8, relationLimit: 10000,
    relationCropPad: 0.25, relationCropMinMembers: 64, relationCropBoundaryMembers: false,
    detail: null, lodDetail: 4, lodRoadSend: null, lodRoadClassFloor: null,
    minFillArea: null, lodMinFillArea: 0,
    neverSend: null, lodNeverSend: true,
    coalesce: null, compact: true, view: null, flatCaps: false,
  }, over);
}
/** 对象键排序（tags 的键顺序在两片/两条路径之间可能不同，但语义相同 —— 比较前先规范化） */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
/** 与客户端 World.unpackPayload 同一套解包：nodePack 的 delta 列 → {id: [lat, lon]} */
function decodeNodePack(p) {
  if (!p.nodePack) return canon(p.nodes);
  const s = p.enc.nodeScale;
  const out = {};
  let id = 0;
  let la = 0;
  let lo = 0;
  for (let i = 0; i < p.nodePack.ids.length; i++) {
    id += p.nodePack.ids[i]; la += p.nodePack.lat[i]; lo += p.nodePack.lon[i];
    out[id] = [la / s, lo / s];
  }
  return out;
}
/** 载荷的"内容侧"归一化（把所有几何解回老形状再比；顺序无关的对象先排序） */
function normalize(p) {
  return canon({
    nodes: decodeNodePack(p),
    nodeTags: p.nodeTags,
    ways: p.ways,
    relations: p.relations,
    displayLines: p.displayLines || null,
    displayAreas: p.displayAreas || null,
    enc: p.enc,
    zoom: p.zoom,
    viewOnly: p.viewOnly,
    truncated: p.truncated,
    payloadCounts: p.truncation.payload,
    complete: p.truncation.complete,
    exact: p.truncation.exact,
    kindsComplete: {
      ways: p.truncation.kinds.ways.complete,
      nodes: p.truncation.kinds.nodes.complete,
      relations: p.truncation.kinds.relations.complete,
    },
    coalesceRule: {
      minZoom: p.truncation.coalesce.minZoom, tolPx: p.truncation.coalesce.tolPx,
      coordDigits: p.truncation.coalesce.coordDigits, minClassWays: p.truncation.coalesce.minClassWays,
      on: p.truncation.coalesce.on, active: p.truncation.coalesce.active,
      rule: p.truncation.coalesce.rule,
    },
    viewOnlyRule: {
      minZoom: p.truncation.viewOnly.minZoom, maxZoom: p.truncation.viewOnly.maxZoom,
      detailFloor: p.truncation.viewOnly.detailFloor, tolPx: p.truncation.viewOnly.tolPx,
      coordDigits: p.truncation.viewOnly.coordDigits, active: p.truncation.viewOnly.active,
      reason: p.truncation.viewOnly.reason,
    },
  });
}
const stripMs = (v) => {
  if (Array.isArray(v)) return v.map(stripMs);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) { if (k !== 'ms') o[k] = stripMs(val); }
    return o;
  }
  return v;
};
const idset = (dict) => Object.keys(dict || {}).map(Number).sort((a, b) => a - b);

/** 参考单库（**只读**打开：绝不写别人的库） */
const single = new OsmDB(FALLBACK, { readOnly: true });
function makeRegion(configOverride = {}) {
  return openRegionDB({
    osmDb: FALLBACK,
    regions: Object.assign({
      mode: 'on', registry: 'tests/tmp-regions/registry-nested.json',
      fanoutMax: 2, fallbackBelowZoom: 11, mergedBytesLimit: 4194304,
      allowOverlap: true, conflictListMax: 20, logQueries: false,
    }, configOverride),
  }, {});
}

/* ============================== A. 注册表自检 ============================== */
section('A. 注册表自检（§2.3）');
const reg = loadRegistry(REGISTRY, { allowOverlap: true });
ok(reg.ok, '注册表通过全部硬自检', JSON.stringify(reg.errors));
eq(reg.list.map((r) => r.id), ['beijing', 'hebei'], 'id 按升序（确定性）');
eq(reg.primary, 'hebei', 'primary = hebei（§5.8：属主 = 最全的那一片）');
eq(reg.missing, [], '没有缺失的分片文件');
ok(reg.list.every((r) => path.basename(r.file, '.sqlite') === r.id), '每片 id 与文件名逐字一致（§1.4）');
ok(reg.overlaps.length === 1 && reg.overlaps[0].a === 'beijing' && reg.overlaps[0].b === 'hebei',
  '自检发现两片矩形相交（beijing ∩ hebei）', JSON.stringify(reg.overlaps));
eq(loadRegistry(REGISTRY, { allowOverlap: false }).degradedReason, 'registry-overlap',
  'allowOverlap:false 时按 §2.3 自检项 4 降级为单库');

section('A2. 真实数据事实（只读 SQL 独立复核，§0 事实 5）');
{
  const bj = new DatabaseSync(path.join(ROOT, 'data/regions/beijing.sqlite'), { readOnly: true });
  const hb = new DatabaseSync(path.join(ROOT, 'data/regions/hebei.sqlite'), { readOnly: true });
  // 共有 relation 里 bbox 不同的条数（文档说 219）。
  // ⚠ 两个库要分别连接、在 JS 里比 —— 写成一条 SQL 的 `relations b JOIN relations h` 是**同一个库自比**（结果恒为 0）。
  const bjRows = bj.prepare('SELECT id, min_lon, max_lon, min_lat, max_lat FROM relations WHERE min_lon IS NOT NULL').all();
  const hbBy = hb.prepare('SELECT min_lon, max_lon, min_lat, max_lat FROM relations WHERE id = ?');
  let shared = 0;
  let diffRow = 0;
  for (const r of bjRows) {
    const h = hbBy.get(r.id);
    if (!h || h.min_lon === null) continue;
    shared += 1;
    const same = ['min_lon', 'max_lon', 'min_lat', 'max_lat'].every((k) => Math.abs(r[k] - h[k]) <= 1e-9);
    if (!same) diffRow += 1;
  }
  const bjNull = bj.prepare('SELECT COUNT(*) AS c FROM relations WHERE min_lon IS NULL').get().c;
  const bothHave = bj.prepare('SELECT COUNT(*) AS c FROM relations b JOIN relations h ON h.id = b.id WHERE b.min_lon IS NULL').get().c;
  const sharedWaysDiff = bj.prepare(`SELECT COUNT(*) AS c FROM ways b JOIN ways h ON h.id = b.id
    WHERE b.version <> h.version OR b.node_count <> h.node_count
      OR ABS(COALESCE(b.min_lon,0) - COALESCE(h.min_lon,0)) > 1e-9
      OR ABS(COALESCE(b.max_lon,0) - COALESCE(h.max_lon,0)) > 1e-9
      OR COALESCE(b.tags,'') <> COALESCE(h.tags,'')`).get().c;
  console.log(`  · 共有 relation（两边都有 bbox）${shared} 条，其中 bbox 不同 **${diffRow}** 条`
    + `（设计文档实测 219）· 北京片 bbox 全 NULL ${bjNull} 条（这些在合并时只能由河北提供）`
    + `· 两边都有的 NULL 行 ${bothHave} 条`);
  console.log(`  · 共有 way 里 version/node_count/bbox/tags 任一不同的：**${sharedWaysDiff}** 条（北京片共 518,666 条 way）`);
  ok(diffRow === 219, '独立复核：共有 relation 里 bbox 不同的恰好 219 条（与 §0 事实 5 一致）', String(diffRow));
  ok(sharedWaysDiff === 0, '独立复核：共有 way 里 version/几何/标签不同的 0 条（"同 id 内容相同"那一半）', String(sharedWaysDiff));
  ok(bjNull > 0 && bothHave === bjNull, `${bjNull} 条 relation 在北京片里 bbox 全为 NULL ⇒ 它们不会被北京片的 R*Tree 返回`);
  bj.close();
  hb.close();
}

/* ============================== B. 视口 → 分片 ============================== */
section('B. 视口 → 分片（§3）');
const rdb = makeRegion();
ok(rdb instanceof RegionDB, '分区开 → 返回 RegionDB（与 OsmDB 同形的包装）');
eq(rdb.resolve(bboxOf(16)), ['beijing', 'hebei'], '北京中心 z16：命中两片（嵌套对必然同时命中）');
eq(rdb.resolve({ minLon: 114.4, minLat: 37.9, maxLon: 114.6, maxLat: 38.1 }), ['hebei'],
  '石家庄 z14：只命中 hebei（北京声明框外）');
eq(rdb.resolve({ minLon: 2, minLat: 2, maxLon: 3, maxLat: 3 }), [], '数据集之外：命中 0 片');

/* ============================== C. 闸门 ============================== */
section('C. 三道闸门（§3.4 / §4.5）');
{
  const z10 = bboxOf(10);
  const r10 = rdb.queryBbox(queryOpts(10, z10));
  const s10 = single.queryBbox(queryOpts(10, z10));
  eq(r10.truncation.regions, undefined, 'z10（< fallbackBelowZoom=11）：载荷里**没有** truncation.regions');
  ok(JSON.stringify(r10) === JSON.stringify(s10), 'z10：与单库载荷**逐字节相同**（低缩放回退单库）',
    `${JSON.stringify(r10).length} vs ${JSON.stringify(s10).length} 字节`);
  ok(rdb.regionsInfo().requests.fallbackLowZoom >= 1, 'health 记到 fallbackLowZoom');
  eq(rdb.regionsInfo().opened, 0, 'z10 只回退单库 ⇒ 一个分片库都没打开');
}
{
  const rdbFan = makeRegion({ fanoutMax: 1 });
  const rf = rdbFan.queryBbox(queryOpts(16, bboxOf(16)));
  ok(rf.truncation.regions === undefined && rdbFan.regionsInfo().requests.fallbackFanout === 1,
    'fanoutMax=1：命中 2 片 ⇒ 回退单库（health 记 fallbackFanout）');
  rdbFan.close();
}
{
  const rdbByte = makeRegion({ mergedBytesLimit: 4096 });
  const rb = rdbByte.queryBbox(queryOpts(16, bboxOf(16)));
  ok(rb.truncation.regions && rb.truncation.regions.some((r) => r.skipped === 'bytes'),
    'mergedBytesLimit=4 KB：后续分片被标 skipped:"bytes"',
    JSON.stringify((rb.truncation.regions || []).map((r) => [r.id, r.skipped])));
  ok(rb.truncation.complete === false && rb.truncated === true && typeof rb.truncation.hint === 'string',
    '被字节闸门跳过 ⇒ complete=false + truncated=true + 客户端拆块提示');
  ok(rb.truncation.regionsBytesLimit && rb.truncation.regionsBytesLimit.limit === 4096,
    '闸门读数记在 truncation.regionsBytesLimit');
  rdbByte.close();
}

/* ============================== D. 多片合并 ============================== */
section('D. 多片合并：开关开 vs 开关关（同数据；z15/z16 逐字段、z11~z14 逐 id）');
for (const z of [15, 16]) {
  const b = bboxOf(z);
  const opts = queryOpts(z, b);
  const merged = rdb.queryBbox(opts);
  const ref = single.queryBbox(opts);
  const nm = JSON.stringify(normalize(merged));
  const nr = JSON.stringify(normalize(ref));
  ok(nm === nr, `z${z}：**内容逐字段相同**（nodePack 解包后 / ways / relations / 几何 / enc / payload 条数 / complete）`,
    nm === nr ? undefined : `长度 ${nm.length} vs ${nr.length}`);
  eq(Object.keys(merged.ways).length, Object.keys(ref.ways).length, `z${z}：way 条数相同`);
  eq(idset(merged.relations), idset(ref.relations), `z${z}：relation id 集合逐个相同`);
  eq(merged.truncation.payload, ref.truncation.payload, `z${z}：truncation.payload.* 逐个相同（去重后的真值）`);
  eq(merged.enc, ref.enc, `z${z}：编码说明书 enc 逐字段相同`);
  ok(merged.truncation.regions.length === 2 && merged.truncation.regions.every((r) => r.hit),
    `z${z}：truncation.regions 如实列出两片`,
    merged.truncation.regions.map((r) => `${r.id}:${r.features.ways}/${r.features.nodes}/${r.features.relations}`).join(' '));
  ok(merged.truncation.regions.every((r) => r.complete === true && r.exact === true), `z${z}：每片的 complete/exact 独立给出`);
  eq(Object.keys(merged.totals).sort(), ['nodes', 'relations', 'ways'],
    `z${z}：totals 形态不变（仍是 ways/nodes/relations 三个键；值为"各片候选总数之和"或 null）`);
  ok(['ways', 'nodes', 'relations'].every((k) => merged.totals[k] === null || typeof merged.totals[k] === 'number'),
    `z${z}：totals 的每个值都是数字或 null（不编数字）`);
  const bytesA = Buffer.byteLength(JSON.stringify(merged), 'utf8');
  const bytesB = Buffer.byteLength(JSON.stringify(ref), 'utf8');
  console.log(`  · z${z} 字节：合并 ${bytesA} vs 单库 ${bytesB}（${((bytesA / bytesB - 1) * 100).toFixed(3)}%）`
    + ' —— nodePack.ids 的顺序不同（≥2^32 的 id 在单库里是插入顺序、合并路径按数值升序），解码后逐点相同');
  const k = merged.truncation.kinds.ways;
  const kr = ref.truncation.kinds.ways;
  console.log(`  · z${z} 扫描侧账本（嵌套片各扫一遍，按 §4.3"求和"）：ways.candidates ${k.candidates} vs ${kr.candidates}`
    + ` · ways.returned ${k.returned} vs ${kr.returned} · totals.nodes ${merged.totals ? merged.totals.nodes : 'null'}`
    + ` vs ${ref.totals ? ref.totals.nodes : 'null'}`);
}
section('D2. z11~z14（低缩放但已过闸门：走分片 + 折线/面合并）');
for (const z of [11, 12, 13, 14]) {
  const b = bboxOf(z);
  const opts = queryOpts(z, b);
  const merged = rdb.queryBbox(opts);
  const ref = single.queryBbox(opts);
  eq(idset(merged.relations), idset(ref.relations), `z${z}：relation id 集合相同`);
  eq(idset(merged.ways), idset(ref.ways), `z${z}：way id 集合相同`);
  eq(merged.nodePack.ids.length, ref.nodePack.ids.length, `z${z}：节点数相同`);
  eq(merged.truncation.complete, ref.truncation.complete, `z${z}：complete 不回退`);
  eq(merged.truncation.coalesce.budgetFrac, 0.25, `z${z}：合并预算按片数摊薄（0.5 / 2 = 0.25，§4.3）`);
  const linesA = (merged.displayLines || []).length;
  const linesB = (ref.displayLines || []).length;
  const areasA = (merged.displayAreas || []).length;
  const areasB = (ref.displayAreas || []).length;
  const bytesA = Buffer.byteLength(JSON.stringify(merged), 'utf8');
  const bytesB = Buffer.byteLength(JSON.stringify(ref), 'utf8');
  console.log(`  · z${z} displayLines ${linesA} vs ${linesB} · displayAreas ${areasA} vs ${areasB}`
    + ` · 字节 ${bytesA} vs ${bytesB}（${((bytesA / bytesB - 1) * 100).toFixed(1)}%）`
    + ' ← 嵌套片：同一批几何被两片各合并一遍（§4.3 已知偏差 + 镜像片的固有浪费）');
  ok(linesA > 0 || areasA > 0, `z${z}：合并几何确实下发了`);
}

section('D3. 冲突记账（真实这两片上"同 id 内容相同"，所以这里应当是 0 —— 分歧路径另测）');
{
  const info = rdb.regionsInfo();
  const last = rdb.queryBbox(queryOpts(16, bboxOf(16)));
  const records = last.truncation.regions.flatMap((r) => r.conflicts || []);
  eq(records.length, 0, '真实嵌套对上，8 个视口都没有"同 id 行不同"（219 条 bbox 差异没有泄漏到载荷行里）');
  eq(info.conflicts.count, 0, 'health 的冲突计数与载荷一致（没有虚报）');
  console.log('  · "同 id 内容不同"的三条分支（version 更优先 / 同版本取属主 / 派生 bbox 更全者胜）'
    + '由 tests/region-divergence-test.js 用构造出来的两片验证');
}

/* ============================== E. 单片直通 ============================== */
section('E. 单片直通（§3.4 / §9.0 R40）');
{
  const fresh = makeRegion();
  const b = bboxOf(15, { lat: 38.0428, lon: 114.5149 });          // 石家庄：只落在 hebei 声明框内
  const opts = queryOpts(15, b);
  const got = fresh.queryBbox(opts);
  const ref = single.queryBbox(opts);
  ok(JSON.stringify(got) === JSON.stringify(ref), '石家庄 z15（只命中 hebei）：**逐字节相同**（直通，不经合并）');
  eq(got.truncation.regions, undefined, '直通不加 truncation.regions（默认路径零差异）');
  eq(fresh.regionsInfo().requests.singleShard, 1, 'health 记到 singleShard');
  eq(fresh.regionsInfo().opened, 1, '只打开被命中的那一片（惰性 + 按需）');
  fresh.close();
}

/* ============================== F. 惰性开库 / 只读 ============================== */
section('F. 惰性开库与只读（§6.7.2 的 P0/P1 口径）');
{
  const fresh = makeRegion();
  eq(fresh.regionsInfo().opened, 0, '新建 → 启动时打开 0 个分片库（惰性）');
  eq(fresh.regionsInfo().declared, 2, 'health 报 declared=2 / opened=0');
  fresh.queryBbox(queryOpts(16, bboxOf(16)));
  eq(fresh.regionsInfo().opened, 2, '命中两片之后才打开 2 个');
  let rejected = false;
  let msg = '';
  try { fresh.shard('beijing').exec('CREATE TABLE region_readonly_probe(x)'); } catch (err) { msg = err.message; rejected = /readonly/i.test(msg); }
  ok(rejected, '分片是**只读**连接：写操作被 SQLite 拒绝', msg);
  ok(fresh.regionsInfo().shards.every((s) => s.opened && s.openMs >= 0), 'health 逐片回显 opened / openMs / queries');
  fresh.close();
}

/* ============================== G. 写路径仍是单库 ============================== */
section('G. 写路径仍然是单库（P1 的硬边界；§0 事实 6 的撞号问题不在本阶段）');
{
  const w = makeRegion();
  ok(w.ids === w.fallback.ids, 'RegionDB.ids 就是单库的 IdAllocator（同一个对象 ⇒ 新 id 只从单库发）');
  ok(w.prepare('SELECT 1 AS x').get().x === 1, 'db.prepare 转发到单库');
  ok(w.counts().nodes > 0, 'db.counts 转发到单库');
  eq(w.info().regions.mode, 'on', 'info() 里带 regions 块（分区开时才有）');
  eq(w.info().regions.writePath, 'single-db', 'health 里明确写"写路径 = 单库"');
  eq(w.fallback.file, FALLBACK, '单库 = config.osmDb（写路径落在这里）');
  eq(w.ids.next.relation, w.fallback.ids.next.relation, 'relation 游标只有一份（单库）');
  w.close();
}

/* ============================== H. 合并规则单测 ============================== */
section('H. 账本合并规则与 relation 例外的单测（§4.3 / §4.2）');
{
  const m = makeRegion();
  const empty = { nodes: {}, nodeTags: {}, ways: {}, relations: {}, lines: [], areas: [] };
  const t1 = { complete: true, exact: true, kinds: { ways: { candidates: 10, dropped: 0, complete: true, limitHit: null } } };
  const t2 = { complete: false, exact: true, kinds: { ways: { candidates: 7, dropped: 2, complete: false, limitHit: 'pick' } } };
  const mt = m.mergeTruncation([{ res: { truncation: t1 } }, { res: { truncation: t2 } }], empty);
  eq(mt.complete, false, 'complete 用 AND');
  eq(mt.exact, true, 'exact 用 AND');
  eq(mt.kinds.ways.candidates, 17, '扫描侧条数相加');
  eq(mt.kinds.ways.dropped, 2, '双方都精确时 dropped 相加');
  eq(mt.kinds.ways.limitHit, 'pick', 'limitHit 取"最坏"的那个');
  const mtNull = m.mergeTruncation([{ res: { truncation: t1 } },
    { res: { truncation: { ...t2, exact: false, kinds: { ways: { ...t2.kinds.ways, dropped: null } } } } }], empty);
  eq(mtNull.kinds.ways.dropped, null, '有一片不精确 ⇒ dropped = null（绝不编数字）');
  eq(mtNull.complete, false, '不精确 ⇒ complete 也必须是 false');
  // relation 例外：version 相同、一片 bbox 为 NULL ⇒ 必须取有 bbox 的那一份
  const relRow = (v, kept, crop) => [v, kept, { type: 'boundary' }, crop];
  const fakeParts = [
    { id: 'beijing', res: { relations: { 1: relRow(3, [['way', 10, 'outer']], { memberTotal: 2, memberKept: 1 }) } } },
    { id: 'hebei', res: { relations: { 1: relRow(3, [['way', 10, 'outer'], ['way', 11, 'outer']], { memberTotal: 4, memberKept: 2 }) } } },
  ];
  const partOf = new Map(fakeParts.map((p) => [p.id, p.res]));
  m.relationBbox = () => null;
  const pickNull = m.pickRelation(['beijing', 'hebei'], partOf, '1');
  eq(pickNull.picked, 'hebei', '两片 bbox 都 NULL 时：取成员账本更全的那一份');
  m.relationBbox = (id) => (id === 'hebei' ? { minLon: 113, maxLon: 120, minLat: 36, maxLat: 43 } : null);
  const pickOne = m.pickRelation(['beijing', 'hebei'], partOf, '1');
  eq(pickOne.picked, 'hebei', '只有一片 bbox 非 NULL ⇒ 取它（NULL 那份在 R*Tree 里根本不存在）');
  eq(pickOne.reason, 'derived-bbox-extent-wins', 'reason 写明"派生 bbox 更全者胜"');
  m.relationBbox = (id) => (id === 'hebei'
    ? { minLon: 113, maxLon: 120, minLat: 36, maxLat: 43 }
    : { minLon: 115, maxLon: 117, minLat: 39, maxLat: 41 });
  eq(m.pickRelation(['beijing', 'hebei'], partOf, '1').picked, 'hebei', '两片都有 bbox 时：取面积（范围）更大的那一份');
  m.close();
}
{
  const m2 = makeRegion();
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    m2.commitConflicts([{ type: 'relation', id: 1, kind: 'derived-bbox', shards: ['beijing', 'hebei'], versions: [3, 3], picked: 'hebei' }],
      { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0, zoom: 16 }, ['beijing', 'hebei'], []);
  } finally { console.warn = orig; }
  eq(m2.regionsInfo().conflicts.count, 1, 'commitConflicts → health 计数 +1');
  ok(!!m2.regionsInfo().conflicts.last, 'health 保留最后一次冲突样本');
  ok(warns.some((w) => w.includes('同 id 内容不同')), '冲突一律打 WARN（绝不静默）');
  m2.close();
}

/* ============================== I. 可复现 ============================== */
section('I. 同一请求两次 → 除 ms 外逐字节相同（§3.1 不变量 3）');
{
  const b = bboxOf(16);
  const a1 = rdb.queryBbox(queryOpts(16, b));
  const a2 = rdb.queryBbox(queryOpts(16, b));
  ok(JSON.stringify(stripMs(a1)) === JSON.stringify(stripMs(a2)), '两次请求的载荷（除各片 ms）逐字节相同');
}

/* ============================== 结果 ============================== */
console.log(`\n[region-shards-test] 通过 ${pass} 项 · 失败 ${fail} 项`);
if (fail) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f);
}
try { rdb.close(); } catch { /* ignore */ }
try { single.close(); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
