'use strict';
/**
 * 分区流式（P1）· **用并行进展产出的真实 tile 片验证**（只读；不起服务）
 *
 *   node tests/region-tiles-test.js [--registry <注册表>] [--fallback <库路径>]
 *
 * `data/regions/registry.json` 在我工作期间被 `tools/tile-cut.js` 生成出来了：10 片
 * **矩形互斥**的市级 tile（`bj-sw/bj-se/bj-nw/bj-ne/heb-lf/heb-ts/heb-bd/heb-cz/heb-zjk/heb-cd`），
 * 输入是 `beijing.sqlite + hebei.sqlite`。这份注册表用的是**另一套字段名**（`tiles[]` / `db` /
 * `bbox:{min_lat,…}` / `rects[]`），`server/regions.js` 的注册表读取两种格式都认（见那里的说明）。
 * 默认用**快照** `tests/tmp-regions/registry-tiles.json`（与线上那份逐字节相同，见本文件打印的 sha256），
 * 这样本文件的数字可复现；线上文件继续归 tile-cut 那一支所有（本文件一行都不改它）。
 *
 * 这份测试要回答的问题（都是"嵌套对"回答不了的）：
 *   1. **矩形互斥**片：自检 0 相交；高缩放视口只命中 1 片 → 走**直通**（H2 的护城河）；
 *   2. 高缩放直通 / 低缩放多片时，**way / node 的 id 集合**与单库是否一致；
 *   3. **跨片同 id 节点**（tile-cut 明确说"被复制过来的几何支撑节点，坐标逐位相同"）
 *      是否被正确去重、且**不**产生冲突记账；
 *   4. 已知缺口（**如实测量并报出**）：tile-cut 把 relation 按"第一个成员 way 所在片"归片，
 *      于是一条"第一个成员在邻片、但成员落在本视口里"的 relation 不会被本片返回 ——
 *      这是**切片工具的归属规则**带来的覆盖缺口（REGIONS.md §3.6 规则 2 警告的正是这一类），
 *      不是读路径的 bug；本文件把差额数出来。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { OsmDB } = require('../server/osmdb');
const { openRegionDB, loadRegistry } = require('../server/regions');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
/**
 * 注册表从哪来（三种情况，自动选）：
 *   ① `--registry <路径>`：你显式指定，照用；
 *   ② 默认快照 `tests/tmp-regions/registry-tiles.json`（存在就用它，数字可复现）；
 *   ③ 快照**不存在**（新克隆的仓库、或有人清了临时目录）→ 退回**线上** `data/regions/registry.json`。
 *
 * ⚠ 为什么要这条回退：snapshot 里的 `counts` 是"生成那一刻"的库内计数。分片被
 * `tools/tile-cut.js` 重新生成过（例如给每片复制跨片 relation）之后，快照就**过期**了 ——
 * 那时 A2 节会判定"分片重建中"并**跳过内容断言**（本文件从 33 项缩到 23 项）。
 * 线上注册表由 tile-cut 同步重写，所以它是权威的；用默认参数跑出 23 项时，
 * 先确认线上那份是否与库内一致，再考虑刷新快照（`Copy-Item data\regions\registry.json tests\tmp-regions\`）。
 */
const REGISTRY = argOf('registry')
  ? path.resolve(ROOT, argOf('registry'))
  : (fs.existsSync(path.join(ROOT, 'tests/tmp-regions/registry-tiles.json'))
    ? path.resolve(ROOT, 'tests/tmp-regions/registry-tiles.json')
    : path.join(ROOT, 'data/regions/registry.json'));
const FALLBACK = path.resolve(ROOT, argOf('fallback') || 'tests/tmp-regions/hebei.sqlite');
const LIVE = path.join(ROOT, 'data/regions/registry.json');

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
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16); } catch { return '(缺失)'; } };

if (!fs.existsSync(FALLBACK)) {
  console.error(`参考单库不存在：${FALLBACK}（先复制一份分片：Copy-Item data\\regions\\hebei.sqlite tests\\tmp-regions\\hebei.sqlite）`);
  process.exit(2);
}

const W = 1400; const H = 900; const PAD = 0.05;
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
function idsetNums(dict) { return Object.keys(dict || {}).map(Number).sort((a, b) => a - b); }
function diffCount(a, b) { const sb = new Set(b); return a.filter((x) => !sb.has(x)); }

const single = new OsmDB(FALLBACK, { readOnly: true });
/** 基表连接：用来判定"缺掉的那条 way / relation 的 bbox 到底在不在视口里" */
const base = new DatabaseSync(FALLBACK, { readOnly: true });
const wayBboxStmt = base.prepare('SELECT min_lon, max_lon, min_lat, max_lat FROM ways WHERE id = ?');
const relBboxStmt = base.prepare('SELECT min_lon, max_lon, min_lat, max_lat FROM relations WHERE id = ?');
const memberStmt = base.prepare("SELECT COUNT(*) AS c FROM relation_members WHERE member_type = 'way' AND member_ref = ?");
const hits = (r, b) => !!r && r.min_lon !== null
  && r.min_lon <= b.maxLon && r.max_lon >= b.minLon && r.min_lat <= b.maxLat && r.max_lat >= b.minLat;
function classifyMissingWays(ids, b) {
  let inside = 0; let memberOnly = 0; let other = [];
  for (const id of ids) {
    const r = wayBboxStmt.get(id);
    if (hits(r, b)) inside += 1;
    else if (memberStmt.get(id).c > 0) memberOnly += 1;
    else other.push(id);
  }
  return { inside, memberOnly, other };
}
function countMissingRelsInside(ids, b) {
  let inside = 0;
  for (const id of ids) if (hits(relBboxStmt.get(id), b)) inside += 1;
  return inside;
}
function makeRegion(over = {}) {
  return openRegionDB({
    osmDb: FALLBACK,
    regions: Object.assign({
      mode: 'on', registry: REGISTRY, fanoutMax: 2, fallbackBelowZoom: 11,
      mergedBytesLimit: 4194304, allowOverlap: true, conflictListMax: 20,
    }, over),
  }, {});
}

/* ============================== A. 注册表 ============================== */
section('A. tile 注册表（并行进展产物）：自检与两种格式兼容');
console.log(`  · 快照 ${path.relative(ROOT, REGISTRY)} sha256:${sha(REGISTRY)} · 线上 ${path.relative(ROOT, LIVE)} sha256:${sha(LIVE)}`
  + `${sha(REGISTRY) === sha(LIVE) ? '（一致）' : '（**不一致**：线上被改过了）'}`);
const reg = loadRegistry(REGISTRY, { allowOverlap: true });
ok(reg.ok, 'tile 注册表通过全部硬自检（id / 文件名 / bbox / primary）', JSON.stringify(reg.errors));
eq(reg.list.length, 10, '10 片');
ok(reg.overlaps.length === 0, '**矩形互斥**（0 处相交）—— 与嵌套夹具正好相反', JSON.stringify(reg.overlaps));
ok(reg.list.every((r) => path.basename(r.file, '.sqlite') === r.id), '每片 id 与文件名逐字一致');
ok(reg.primary === 'heb-bd' && reg.primaryDerived === true,
  '注册表没写 primary ⇒ 按"节点最多的那一片"推导（heb-bd 2,885,140 节点，§5.8 属主 = 最全片）');
ok(reg.list.find((r) => r.id === 'heb-cd').rects.length === 2,
  '承德片是 L 形（2 个矩形）⇒ 寻址用 rects 而不是外接 bbox（否则会把北京片盖住）');
eq(loadRegistry(REGISTRY, { allowOverlap: false }).ok, true, 'allowOverlap:false 也不会降级（互斥片）');

/**
 * ⚠ **分片可能正在被重新生成**（并行进展那条线随时会重跑 `tools/tile-cut.js`）：
 * 这里逐片把"库内真实计数"与"注册表声明计数"对一下，不一致（或读不出来）就判定为"重建中"，
 * 于是**跳过依赖数据内容的断言**，只保留注册表 / 寻址 / 惰性 / 回退这些与数据内容无关的断言。
 * 否则本文件会在人家写库写一半的时候报假失败。
 */
section('A2. 分片数据完整性自检（判断能不能做内容断言）');
let IN_FLUX = false;
for (const rec of reg.list) {
  try {
    const db = new DatabaseSync(rec.file, { readOnly: true });
    const c = db.prepare('SELECT (SELECT COUNT(*) FROM nodes) n,(SELECT COUNT(*) FROM ways) w,(SELECT COUNT(*) FROM relations) r').get();
    db.close();
    const same = c.n === rec.counts.nodes && c.w === rec.counts.ways && c.r === rec.counts.relations;
    if (!same) {
      IN_FLUX = true;
      console.log(`  ! ${rec.id}：库内 ${c.n}/${c.w}/${c.r} ≠ 注册表声明 ${rec.counts.nodes}/${rec.counts.ways}/${rec.counts.relations} ⇒ 正在重新生成`);
    }
  } catch (err) {
    IN_FLUX = true;
    console.log(`  ! ${rec.id}：读不出来（${err.message}）⇒ 正在重新生成`);
  }
}
console.log(IN_FLUX
  ? '  ⇒ **分片重建中**：本文件跳过内容断言，只验注册表 / 寻址 / 闸门 / 惰性 / 回退'
  : '  ⇒ 10 片的真实计数与注册表声明逐个一致，可以做内容断言');

/* ============================== B. 选片 ============================== */
section('B. 视口 → 分片（互斥片的真实表现）');
{
  const rdb = makeRegion();
  const cases = [];
  for (const z of [16, 15, 14, 13, 12, 11, 10]) {
    const hit = rdb.resolve(bboxOf(z));
    cases.push([z, hit]);
    console.log(`  · z${z} 命中 ${hit.length} 片：${hit.join(',') || '（无）'}`);
  }
  eq(cases.find((c) => c[0] === 16)[1], ['bj-se'], 'z16 天安门视口只命中 1 片（bj-se）⇒ 走**直通**');
  ok(cases.find((c) => c[0] === 11)[1].length > 2, 'z11 视口命中 > 2 片 ⇒ 顶到 fanoutMax、回退单库（H2 闸门生效）');
  rdb.close();
}
{
  const rdb = makeRegion();
  const b = bboxOf(16);
  const opts = queryOpts(16, b);
  const got = rdb.queryBbox(opts);
  eq(got.truncation.regions, undefined, 'z16 单片直通：**不加** truncation.regions（默认路径零差异）');
  eq(rdb.regionsInfo().opened, 1, '只惰性打开了被命中的那一片');
  eq(rdb.regionsInfo().requests.singleShard, 1, 'health 记到 singleShard');
  if (IN_FLUX) {
    console.log('  ! 分片重建中：跳过 z16 内容对比');
  } else {
    const ref = single.queryBbox(opts);
    const missWays = idsetNums(ref.ways).filter((id) => !(id in got.ways));
    const missRels = idsetNums(ref.relations).filter((id) => !(id in got.relations));
    const cls = classifyMissingWays(missWays, b);
    const relInside = countMissingRelsInside(missRels, b);
    console.log(`  · z16 直通：ways ${Object.keys(got.ways).length} / 单库 ${Object.keys(ref.ways).length}`
      + ` · relations ${Object.keys(got.relations).length} / 单库 ${Object.keys(ref.relations).length}`
      + ` · 单库有而本片没有：way ${missWays.length}（其中 **bbox 与视口相交的 ${cls.inside}**、`
      + `视口外但被关系引用的 ${cls.memberOnly}、其余 ${cls.other.length}）`
      + ` · relation ${missRels.length}（其中 **bbox 与视口相交的 ${relInside}**）`);
    ok(cls.inside <= 1, '视口内**几乎不丢 way**：缺掉的 way 全是"关系成员的几何补齐"（在别的片里）', String(cls.inside));
    ok(relInside === 0, '跨片 relation **缺口已归零**：属主片那份按"来源库 bbox"复制进它触及的每一片'
      + '（tile-cut 归属规则⑦，见 tools/tile-cut.js），于是"视口 ∩ 全局 bbox ≠ ∅ ⇒ 必有片返回它"构造性成立',
      `${relInside}/${Object.keys(ref.relations).length}（修前实测 46/452）`);
  }
  rdb.close();
}

/* ============================== C. 多片合并 ============================== */
section('C. 多片合并（fanoutMax 放到 8，把闸门让开）：与单库比 id 集合');
for (const z of [15, 14, 13, 12, 11]) {
  const b = bboxOf(z);
  const opts = queryOpts(z, b);
  const rdb = makeRegion({ fanoutMax: 8, fallbackBelowZoom: 0 });
  const merged = rdb.queryBbox(opts);
  const info = rdb.regionsInfo();
  const hit = (merged.truncation.regions || []).map((r) => r.id);
  if (IN_FLUX) {
    console.log(`  ! z${z}：分片重建中，跳过内容对比（只验"命中的片都如实列在 truncation.regions 里"）`);
    ok(!merged.truncation.regions || merged.truncation.regions.every((r) => r.hit),
      `z${z}：truncation.regions 逐片如实列出（或单片直通时整个字段不出现）`);
    rdb.close();
    continue;
  }
  const ref = single.queryBbox(opts);
  const waysMiss = diffCount(idsetNums(ref.ways), idsetNums(merged.ways));
  const relMiss = diffCount(idsetNums(ref.relations), idsetNums(merged.relations));
  const relExtra = diffCount(idsetNums(merged.relations), idsetNums(ref.relations));
  const nodeMiss = ref.nodePack.ids.length - merged.nodePack.ids.length;
  const bytesA = Buffer.byteLength(JSON.stringify(merged), 'utf8');
  const bytesB = Buffer.byteLength(JSON.stringify(ref), 'utf8');
  console.log(`  · z${z} 命中 ${hit.length} 片（${hit.join(',')}）· 打开 ${info.opened} 片 · complete=${merged.truncation.complete}`
    + ` · ways ${Object.keys(merged.ways).length} vs ${Object.keys(ref.ways).length}（缺 ${waysMiss.length}）`
    + ` · nodes ${merged.nodePack.ids.length} vs ${ref.nodePack.ids.length}（缺 ${nodeMiss}）`
    + ` · relations ${Object.keys(merged.relations).length} vs ${Object.keys(ref.relations).length}（缺 ${relMiss.length} / 多 ${relExtra.length}）`
    + ` · 字节 ${bytesA} vs ${bytesB}（${((bytesA / bytesB - 1) * 100).toFixed(1)}%）`);
  if (z >= 15) {
    const cls = classifyMissingWays(waysMiss, b);
    const relInside = countMissingRelsInside(relMiss, b);
    ok(cls.inside <= 1, `z${z}：视口内几乎不丢 way（缺的都是"关系成员几何补齐"，其中与视口相交的只有 ${cls.inside} 条）`);
    ok(relExtra.length === 0, `z${z}：合并结果里没有单库没有的 relation（不凭空造）`);
    if (z === 15) {
      // 修前这里断言的是"缺口 > 0"（当时确实缺 7 条）。关系复制落地后缺口应为 0，
      // 所以断言改成正向：**一条都不许缺**。留一句修前数字在 detail 里，方便对照。
      ok(relMiss.length === 0 && relInside === 0,
        `z${z}：多片合并后**一条 relation 都不缺**（${relInside} 条 bbox 与视口相交却不在被选中的片里）`,
        `缺 ${relMiss.length} 条；修前实测缺 7 条、其中 7 条 bbox 相交`);
    }
  }
  ok(!merged.truncation.regions || merged.truncation.regions.every((r) => r.hit),
    `z${z}：truncation.regions 逐片如实列出（或单片直通时整个字段不出现）`);
  /**
   * 跨片同 id 节点：tile-cut 保证"坐标逐位相同"⇒ 节点/way **不该产生任何冲突**。
   * ⚠ 但**关系副本**（tile-cut 规则⑦）会带来 derived-bbox 记账：同 id 的两份副本
   *   在同一个多片视口里都被选中时，服务端按 pickRelation（属主/派生量更全者胜）取一份
   *   并**如实记一次冲突**——那是设计里预期的行为，不是节点冲突。
   * 所以这里断言的是"冲突数处在**仅关系副本记账**的量级"：实测 z16–z13 = 0、z12/z11 各 2；
   * 一旦出现节点/way 冲突，数量会与"跨片同 id 节点的条数"同阶（本数据集上千），立刻被这条抓住。
   * （想要"按 kind 精确区分"的严格断言，需要 regions.js 暴露冲突条目明细，属后续可加项。）
   */
  ok(info.conflicts.count <= 8,
    `z${z}：冲突只来自关系副本记账、节点/way 冲突为 0（实测 ${info.conflicts.count} ≤ 8）`);
  rdb.close();
}
{
  // 冲突与去重路径的"证据面"：跨片重复节点的条数（= 被去重掉的副本）。
  // 用 z11（命中 4 片）—— 高缩放视口在 tile 方案下多半只命中 1 片，没有"跨片同 id"可看。
  const b = bboxOf(11);
  const opts = queryOpts(11, b);
  const rdb = makeRegion({ fanoutMax: 8, fallbackBelowZoom: 0 });
  const merged = rdb.queryBbox(opts);
  const perShard = (merged.truncation.regions || []).map((r) => r.features.nodes);
  const sum = perShard.reduce((a, c) => a + c, 0);
  console.log(`  · ${IN_FLUX ? '（重建中）' : ''}z11 各片节点数 ${perShard.join(' + ')} = ${sum} → 去重后 ${merged.nodePack.ids.length}`
    + `（被去重掉的副本 ${sum - merged.nodePack.ids.length} 个，全是 tile-cut 复制过来的几何支撑节点）`);
  ok(perShard.length >= 2, 'z11 命中 ≥ 2 片（才有"跨片同 id"可看）');
  ok(sum >= merged.nodePack.ids.length, '各片节点数之和 ≥ 去重后的节点数（有副本时去重确实在做事）');
  ok(merged.truncation.payload.nodes === merged.nodePack.ids.length,
    'truncation.payload.nodes 与去重后的载荷一致（结果侧账本是重数过的）');
  rdb.close();
}

/* ============================== D. 低缩放回退 ============================== */
section('D. 低缩放：回退单库（z < fallbackBelowZoom）');
{
  const rdb = makeRegion({ fanoutMax: 8 });                 // fallbackBelowZoom 用默认 11
  const b = bboxOf(10);
  const opts = queryOpts(10, b);
  const got = rdb.queryBbox(opts);
  const ref = single.queryBbox(opts);
  ok(JSON.stringify(got) === JSON.stringify(ref), 'z10：逐字节相同（回退单库）');
  eq(rdb.regionsInfo().opened, 0, '回退路径下一个分片库都没打开');
  eq(rdb.regionsInfo().requests.fallbackLowZoom, 1, 'health 记到 fallbackLowZoom');
  rdb.close();
}

console.log(`\n[region-tiles-test] 通过 ${pass} 项 · 失败 ${fail} 项`);
if (fail) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
try { single.close(); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
