'use strict';
/**
 * ============ P4：按区域惰性建图 / 卸载（deploy/REGIONS.md §7 + §6.5）验收 ============
 *
 *   node tests/region-lazy-test.js
 *
 * 这个套件**不碰任何真实数据集**：它在 `tests/tmp-lazy/` 下**现造**一个两片的小世界
 * （`alpha1` = lon 116.15~116.35，`beta1` = lon 116.35~116.50，矩形互斥），
 * 里面有：两段接起来的铁路（跨两片）、两组十字路口道路（制造虚拟路口）、
 * 两个地块（人口网格）、一个车站（资产片 = alpha1）。
 *
 * 它断言的东西（每条都对应设计文档的一节）：
 *   1. **开关关（`regions.mode:'off'`）时 `openRegionDB` 返回的是原样的 `OsmDB`**，
 *      没有 `lazyWorld`、`regionsOptionsOf(...).lazyOn === false` —— 这是"游戏其他功能不受影响"的前提；
 *   2. **开关开**：启动只为**资产片**建图；其余区域 `state === 'absent'`、`graph === null`（不建、不常驻）；
 *   3. 站点吸附按坐标取**那一张区域图**（§7.1 的"按需兜底"路径：没预热的区域会同步建出来）；
 *   4. **禁止拼图**（§6.5.1 的最硬一条）：两张区域图各有自己的虚拟路口 id（都从 −1 起算 ⇒ 必然撞号），
 *      协调器的 `nodes` 视图**跳过虚拟节点**、`nodeAt(负 id)` 恒为 undefined；
 *   5. **跨区域寻路 = 按走廊 bbox 新建一张图**（§6.5.2 方案 C），
 *      并且这条路径与"独立地用同一个走廊 bbox 建一张图再寻路"**逐节点相同**（文档的专项②）；
 *   6. 单区域线路**复用**那张区域图（不建走廊图，零额外代价）；
 *   7. **内存能释放**：空闲到点后被卸载（`dispose()` 后内部结构真的空了），资产片**永不卸载**，
 *      再被用到时能重新建起来；
 *   8. **人口网格按区域算**：`Population#buildRegion(rect)` 只碰这一块，而且**幂等**（重复算不翻倍）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const { openRegionDB, regionsOptionsOf, createRegionLazyWorld, RegionGraphSource } = require('../server/regions');
const { RailGraph } = require('../server/railgraph');
const { Population, cellOf } = require('../server/population');
const { importOsm } = require('../tools/import-osm.js');

const DIR = path.join(__dirname, 'tmp-lazy');
const FIXTURE = path.join(DIR, 'lazy.osm');
const WORLD = path.join(DIR, 'world.sqlite');       // 那个"单库"（= config.osmDb，唯一的数据来源）
const A_DB = path.join(DIR, 'alpha1.sqlite');       // 分片（只为注册表自检而存在，本套件不查它）
const B_DB = path.join(DIR, 'beta1.sqlite');
const REG = path.join(DIR, 'registry-lazy.json');

/** 两片矩形（互斥）—— 与下面的元素坐标严格对齐 */
const RECT_A = { minLon: 116.15, minLat: 39.90, maxLon: 116.35, maxLat: 40.00 };
const RECT_B = { minLon: 116.35, minLat: 39.90, maxLon: 116.50, maxLat: 40.00 };

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, what, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + what); return true; }
  fail += 1;
  failures.push(what + (extra === undefined ? '' : ' → ' + extra));
  console.log('  ✗ ' + what + (extra === undefined ? '' : ' → ' + extra));
  return false;
}
function eq(a, b, what) { return ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }
function section(t) { console.log('\n== ' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------
 * 造夹具：两片、跨片铁路、两组十字路口道路、两个地块、一个车站
 * ------------------------------------------------------------------------ */
const OSM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="region-lazy-fixture">
  <bounds minlat="39.90" minlon="116.15" maxlat="40.00" maxlon="116.50"/>
  <!-- 铁路：way 101 全在 A 片内，way 102 从 A 片一路接到 B 片（跨片） -->
  <node id="1" lat="39.9500" lon="116.2200" version="1"/>
  <node id="2" lat="39.9500" lon="116.2800" version="1"/>
  <node id="3" lat="39.9500" lon="116.3300" version="1"/>
  <node id="4" lat="39.9500" lon="116.4000" version="1"/>
  <node id="5" lat="39.9500" lon="116.4700" version="1"/>
  <way id="101" version="1">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="railway" v="rail"/>
    <tag k="name" v="A 片轨道"/>
  </way>
  <way id="102" version="1">
    <nd ref="3"/><nd ref="4"/><nd ref="5"/>
    <tag k="railway" v="rail"/>
    <tag k="name" v="跨片轨道"/>
  </way>
  <!-- 道路：A 片一组十字（制造虚拟路口），B 片一组十字 -->
  <node id="11" lat="39.9400" lon="116.2000" version="1"/>
  <node id="12" lat="39.9400" lon="116.3000" version="1"/>
  <node id="13" lat="39.9300" lon="116.2500" version="1"/>
  <node id="14" lat="39.9500" lon="116.2500" version="1"/>
  <way id="201" version="1"><nd ref="11"/><nd ref="12"/>
    <tag k="highway" v="residential"/><tag k="name" v="A 东西路"/></way>
  <way id="202" version="1"><nd ref="13"/><nd ref="14"/>
    <tag k="highway" v="residential"/><tag k="name" v="A 南北路"/></way>
  <node id="15" lat="39.9400" lon="116.4000" version="1"/>
  <node id="16" lat="39.9400" lon="116.4600" version="1"/>
  <node id="17" lat="39.9300" lon="116.4300" version="1"/>
  <node id="18" lat="39.9500" lon="116.4300" version="1"/>
  <way id="203" version="1"><nd ref="15"/><nd ref="16"/>
    <tag k="highway" v="residential"/><tag k="name" v="B 东西路"/></way>
  <way id="204" version="1"><nd ref="17"/><nd ref="18"/>
    <tag k="highway" v="residential"/><tag k="name" v="B 南北路"/></way>
  <!-- 地块（人口网格）：A、B 各一栋闭合的住宅楼 -->
  <node id="21" lat="39.9600" lon="116.2400" version="1"/>
  <node id="22" lat="39.9600" lon="116.2410" version="1"/>
  <node id="23" lat="39.9610" lon="116.2410" version="1"/>
  <node id="24" lat="39.9610" lon="116.2400" version="1"/>
  <way id="301" version="1">
    <nd ref="21"/><nd ref="22"/><nd ref="23"/><nd ref="24"/><nd ref="21"/>
    <tag k="building" v="apartments"/><tag k="building:levels" v="6"/>
  </way>
  <node id="25" lat="39.9600" lon="116.4200" version="1"/>
  <node id="26" lat="39.9600" lon="116.4210" version="1"/>
  <node id="27" lat="39.9610" lon="116.4210" version="1"/>
  <node id="28" lat="39.9610" lon="116.4200" version="1"/>
  <way id="302" version="1">
    <nd ref="25"/><nd ref="26"/><nd ref="27"/><nd ref="28"/><nd ref="25"/>
    <tag k="building" v="apartments"/><tag k="building:levels" v="6"/>
  </way>
</osm>
`;

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(FIXTURE, OSM_XML, 'utf8');
for (const f of [WORLD, A_DB, B_DB]) {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(f + suffix); } catch { /* ignore */ } }
}
fs.writeFileSync(REG, JSON.stringify({
  v: 1,
  generator: 'tests/region-lazy-test.js',
  primary: 'alpha1',
  regions: {
    alpha1: {
      id: 'alpha1', region: 'alpha', name: 'A 片', file: 'tests/tmp-lazy/alpha1.sqlite',
      bbox: { minLon: RECT_A.minLon, minLat: RECT_A.minLat, maxLon: RECT_A.maxLon, maxLat: RECT_A.maxLat },
      counts: { nodes: 26, ways: 6, relations: 0 },
    },
    beta1: {
      id: 'beta1', region: 'beta', name: 'B 片', file: 'tests/tmp-lazy/beta1.sqlite',
      bbox: { minLon: RECT_B.minLon, minLat: RECT_B.minLat, maxLon: RECT_B.maxLon, maxLat: RECT_B.maxLat },
      counts: { nodes: 22, ways: 5, relations: 0 },
    },
  },
}, null, 2));

/** 惰性建图的配置（两片、资产片 = alpha1、空闲 300 ms 就卸载） */
const CONFIG = () => ({
  osmDb: WORLD,
  regions: {
    mode: 'on', registry: 'tests/tmp-lazy/registry-lazy.json',
    lazy: true, lazyIdleMs: 300, lazySweepMs: 600000, corridorPadMeters: 500,
    corridorQuantDeg: 0.05, corridorTtlMs: 600000, corridorMax: 2, lazyLog: false,
  },
});

(async () => {
  /* ------------------------------ 0. 开关关（改动前行为） ------------------------------ */
  section('0. 开关**关**：`openRegionDB` 原样返回单库，惰性建图一个字段都不生效');
  {
    const offA = openRegionDB({ osmDb: WORLD, regions: { mode: 'off', registry: 'tests/tmp-lazy/registry-lazy.json' } }, {});
    ok(offA instanceof (require('../server/osmdb').OsmDB), 'mode:off ⇒ 返回的是原样的 OsmDB（不是 RegionDB）');
    ok(!('lazyWorld' in offA), 'mode:off ⇒ 没有 lazyWorld 字段');
    eq(regionsOptionsOf({ regions: { mode: 'off' } }).lazyOn, false, 'regionsOptionsOf：mode:off ⇒ lazyOn=false');
    eq(regionsOptionsOf({}).lazyOn, false, '压根没有 regions 块 ⇒ lazyOn=false');
    eq(regionsOptionsOf({ regions: { mode: 'on', lazy: false } }).lazyOn, false,
      'mode:on 但 lazy:false ⇒ lazyOn=false（P4 的一行回滚）');
    eq(createRegionLazyWorld(offA, { opts: regionsOptionsOf({ regions: { mode: 'off' } }) }), null,
      '开关关时 createRegionLazyWorld 返回 null（调用方据此走老路 new RailGraph）');
    offA.close();
  }

  /* ------------------------------ 1. 造库 ------------------------------ */
  section('1. 造夹具：两片互斥矩形的小世界 + 一个车站（资产片 = alpha1）');
  await importOsm({ file: FIXTURE, db: WORLD, force: true, quiet: true });
  await importOsm({ file: FIXTURE, db: A_DB, force: true, quiet: true });
  await importOsm({ file: FIXTURE, db: B_DB, force: true, quiet: true });
  {
    // 车站直接写进"单库"的 stations 表（本套件只验建图的范围，不验交通玩法）
    const raw = new DatabaseSync(WORLD);
    raw.exec(`INSERT INTO stations(owner, company_id, name, kind, lat, lon, node_id, way_id,
      platform_m, catchment_m, show_catchment, cost, created_at)
      VALUES('tester', NULL, '甲站', 'rail', 39.9500, 116.2800, 2, 101, 120, 700, 0, 0, ${Date.now()})`);
    raw.close();
    const n = new DatabaseSync(WORLD, { readOnly: true }).prepare('SELECT COUNT(*) c FROM stations').get().c;
    eq(n, 1, '单库里 1 个车站（坐标落在 A 片，lon 116.28）');
  }

  /* ------------------------------ 2. 开关开：只为资产片建图 ------------------------------ */
  section('2. 开关**开** + lazy：启动只为**资产片**建图，其余区域一片都不建');
  const cfg = CONFIG();
  const opts = regionsOptionsOf(cfg);
  eq(opts.lazyOn, true, 'mode:on + lazy:true ⇒ lazyOn=true');
  const db = openRegionDB(cfg, {});
  ok(db.registry && db.registry.ok === true, '注册表自检通过（两片互斥、文件都在）');
  const world = createRegionLazyWorld(db, { opts, needsBusGraph: () => true });
  ok(!!world, 'createRegionLazyWorld 返回了世界');
  db.lazyWorld = world;
  const rail = new RegionGraphSource(world, 'rail');
  const bus = new RegionGraphSource(world, 'bus');

  {
    const started = await world.activateStartup();
    eq(started.shards, ['alpha1'], '启动激活集 = 资产片 alpha1（车站所在片）');
    eq(world.slot('rail', 'alpha1').state, 'ready', 'rail · alpha1 已就绪（启动时建好）');
    eq(world.slot('rail', 'beta1').state, 'absent', 'rail · beta1 **没建**（state=absent）');
    eq(world.slot('rail', 'beta1').graph, null, 'rail · beta1 的图是 null（不常驻）');
    eq(world.slot('bus', 'beta1').state, 'absent', 'bus · beta1 同样没建');
    eq(world.info().rail.ready, ['alpha1'], 'health：铁路图就绪的只有 alpha1');
    eq(world.info().assetShards, ['alpha1'], 'health：资产片 = alpha1');
    ok(world.info().rail.ways < 6, `只为 A 片建图的 way 条数（${world.info().rail.ways}）小于整库（6）`);
  }

  /* ------------------------------ 3. 建图范围：相交的 way 收，节点全带 ------------------------------ */
  section('3. 建图范围 = way 的物化 bbox 与区域矩形相交；**节点全带**（几何不截断）');
  {
    const gA = world.slot('rail', 'alpha1').graph;
    ok(gA.wayInfo.has(101), 'A 片图里有 way 101（整条在 A 片内）');
    ok(gA.wayInfo.has(102), 'A 片图里有 way 102（bbox 与 A 片相交 ⇒ 整条收进来）');
    eq(gA.wayInfo.size, 2, 'A 片图里正好 2 条铁路 way');
    ok(gA.nodes.has(5), 'way 102 的**远端节点 5（lon 116.47，在 B 片里）也在图里** —— 节点不设作用域');
    ok(gA.nodes.has(1), '近端节点 1 在图里');
    // 作用域语句的 iterate()：切片建图（index.js 的 buildGraphSliced）**必须**能用它
    const st = gA._st.railWays;
    eq(typeof st.iterate, 'function', 'railWays 包装后的语句仍然有 iterate()（切片建图的硬要求）');
    let viaIterate = 0;
    for (const _row of st.iterate()) viaIterate += 1;
    eq(viaIterate, st.all().length, 'iterate() 与 all() 读到的行数一致（作用域参数插在正确位置）');
    // 没有被作用域的 way：不在图里
    const gB = world.ensureSync('rail', 'beta1');
    ok(!gB.wayInfo.has(101), 'B 片图里**没有** way 101（它整条在 A 片，与 B 片矩形不相交）');
    ok(gB.wayInfo.has(102), 'B 片图里有 way 102（跨片那条）');
    eq(gB.wayInfo.size, 1, 'B 片图里正好 1 条铁路 way');
  }

  /* ------------------------------ 4. 站点吸附：按坐标取那一张图 ------------------------------ */
  section('4. 站点吸附按坐标取**那一张区域图**（没预热的区域走同步兜底）');
  {
    const gA = rail.graphAt(39.9500, 116.2800);
    ok(gA === world.slot('rail', 'alpha1').graph, 'A 片坐标 ⇒ 拿到 A 片那张图（同一个实例）');
    const near = gA.nearestNode(39.9501, 116.2801, 120);
    eq(near && near.nodeId, 2, '吸附到最近的轨道节点 2');
    ok(gA.nodes.size > 0 && gA.wayCount === 2, `A 片图：${gA.wayCount} 条 way / ${gA.nodes.size} 个节点`);
    // B 片的铁路图在上一节已经同步兜底建过了：再取一次**不该**重复建图
    const before = world.stats.syncBuilds;
    const gB = rail.graphAt(39.9500, 116.4500);
    ok(gB === world.slot('rail', 'beta1').graph, 'B 片坐标 ⇒ 拿到 B 片那张图');
    eq(world.stats.syncBuilds, before, '已经建过的区域不会再建一次（syncBuilds 不变）');
    ok(gB !== gA, '**两张不同的 RailGraph 实例**（不是拼图）');
    // bus · B 片从来没建过（也没有人上报过 B 片的视口）⇒ 按需兜底必须**同步**建出来并如实记数
    const beforeBus = world.stats.syncBuilds;
    const busB = bus.graphAt(39.9400, 116.4500);
    ok(busB === world.slot('bus', 'beta1').graph, 'bus：B 片坐标 ⇒ 同步兜底建出 B 片道路图');
    eq(world.stats.syncBuilds - beforeBus, 1, 'health 记到 1 次"同步兜底建图"（bus · beta1）');
    ok(bus.graphAt(39.9400, 116.2500).nodes.size > 0, 'bus：A 片坐标也能拿到 A 片道路图');
  }

  /* ------------------------------ 5. 禁止拼图（虚拟路口 id 会撞） ------------------------------ */
  section('5. **禁止拼图**（§6.5.1）：两张图的虚拟路口 id 都从 −1 起算 ⇒ 协调器从不混用');
  {
    const gA = world.slot('bus', 'alpha1').graph;
    const gB = world.slot('bus', 'beta1').graph || world.ensureSync('bus', 'beta1');
    const negA = [...gA.nodes.keys()].filter((k) => k < 0).sort((a, b) => a - b);
    const negB = [...gB.nodes.keys()].filter((k) => k < 0).sort((a, b) => a - b);
    ok(negA.length > 0 && negB.length > 0,
      `两张道路图**各自**都造出了虚拟路口（A ${negA.length} 个 / B ${negB.length} 个）`);
    ok(negA[0] === -1 && negB[0] === -1,
      '两边的第一个虚拟路口 id **都是 −1** —— 这就是"拼图必然撞号"的实测证据');
    eq(negA.filter((x) => negB.includes(x)), negA.filter((x) => negB.includes(x)),
      '两边虚拟 id 的**交集非空**（撞号是必然的，不是"可能"）');
    eq(negA.filter((x) => negB.includes(x)).length > 0, true, '交集确实非空');
    // 协调器的并集视图必须**跳过**虚拟节点，否则负 id 会指向另一张图的错误节点
    ok(!bus.nodes.has(-1), '协调器的 nodes 视图：has(−1) === false（虚拟节点被跳过）');
    eq(world.nodeAt('bus', -1), undefined, 'nodeAt(负 id) 恒为 undefined');
    let sum = 0;
    for (const g of world.readyGraphs('bus')) sum += g.nodes.size - (g.virtualNodeCount || 0);
    eq(bus.nodes.size, sum, 'nodes.size = 各就绪图的**非虚拟**节点数之和（诚实口径，不含虚拟）');
    let listed = 0;
    for (const _n of bus.nodes.values()) listed += 1;
    eq(listed, sum, 'nodes.values() 枚举出来的条数 = 非虚拟节点数');
    ok(bus.nodes.has(11) && bus.nodes.get(11).id === 11, '正 id（OSM node id）按 id 取得到，且是全局唯一的');
  }

  /* ------------------------------ 6. 跨区域寻路 = 走廊 bbox 新建一张图 ------------------------------ */
  section('6. 跨区域寻路 = 按走廊 bbox **新建一张图**（§6.5.2 方案 C），且与独立建图**逐节点相同**');
  {
    const plan = world.routeFor('rail', [1, 5]);
    ok(plan && plan.route && Array.isArray(plan.route.path) && plan.route.path.length > 0,
      `跨片（A 的节点 1 → B 的节点 5）算出了非空 path：${plan.route.path && plan.route.path.join('→')}`);
    eq(plan.route.path, [1, 2, 3, 4, 5], 'path 逐节点 = [1,2,3,4,5]');
    ok(!!plan.corridor, '走廊 bbox 被算出来了');
    ok(plan.corridorBuild && plan.corridorBuild.ways >= 1,
      `走廊图确实新建了（${plan.corridorBuild && plan.corridorBuild.ways} 条 way · ${plan.corridorBuild && plan.corridorBuild.ms} ms）`);
    eq(world.stats.corridorBuilds, 1, 'health 记到 1 张走廊图');
    ok(plan.graph !== world.slot('rail', 'alpha1').graph && plan.graph !== world.slot('rail', 'beta1').graph,
      '用的是一张**新的**实例（不是把 A、B 两张图拼起来）');
    // 最强调据（文档专项②）：与"独立地用同一走廊 bbox 建一张图再寻路"逐节点相同
    const indep = new RailGraph(db, { mode: 'rail', bbox: plan.corridorBuild.bbox });
    const stIndep = indep.build();
    const route2 = indep.routeThrough([1, 5]);
    eq(route2.path, plan.route.path, '与"独立单片建图"的 path **逐节点相同**');
    eq(route2.lengthM, plan.route.lengthM, '里程也相同');
    eq(stIndep.ways, plan.corridorBuild.ways, 'way 条数相同');
    indep.dispose();
    // 缓存命中：第二次同样的问题不该再建一张
    const again = world.routeFor('rail', [1, 5]);
    eq(world.stats.corridorBuilds, 1, '第二次同一走廊 ⇒ 命中缓存，不再建图');
    eq(again.route.path, plan.route.path, '缓存命中的路径一致');
    eq(world.stats.corridorHits >= 1, true, 'health 记到走廊缓存命中');
    // 走廊图里两片的数据都在（这就是"完整的走廊数据 → 一张完整的图"）
    ok(plan.graph.wayInfo.has(101) && plan.graph.wayInfo.has(102), '走廊图里 101 / 102 都在');
  }

  /* ------------------------------ 7. 单区域线路复用那张区域图（不建走廊图） ------------------------------ */
  section('7. 线路的站点全落在**同一张区域图**内 ⇒ 直接复用，零建图代价');
  {
    const before = world.stats.corridorBuilds;
    const plan = world.routeFor('rail', [1, 2]);
    eq(plan.reused, true, '两个站点都在 A 片矩形内 ⇒ reused=true');
    eq(plan.corridorShard, 'alpha1', '用的是 A 片那张图');
    ok(plan.graph === world.slot('rail', 'alpha1').graph, '返回的是 A 片图的**同一个实例**');
    eq(world.stats.corridorBuilds, before, '没有为它新建走廊图');
    eq(plan.route.path, [1, 2], '路径 = [1,2]');
  }

  /* ------------------------------ 8. 卸载：内存能释放，资产片永不卸载 ------------------------------ */
  section('8. **卸载**（§7.2 / R33）：空闲到点就释放；资产片**永不卸载**；再被用到时能重建');
  {
    const gB = world.slot('rail', 'beta1').graph;
    const nodesBefore = gB.nodes.size;
    const waysBefore = gB.wayCount;
    ok(nodesBefore > 0 && waysBefore > 0, `卸载前 B 片图里有 ${waysBefore} 条 way / ${nodesBefore} 个节点`);
    await sleep(450);                                   // > lazyIdleMs(300)
    world.sweep();                                      // 资产片只有 alpha1 ⇒ beta1 不在激活集里
    eq(world.slot('rail', 'beta1').state, 'absent', 'beta1 被卸载（state=absent）');
    eq(world.slot('rail', 'beta1').graph, null, 'B 片图的引用已丢掉');
    eq(gB.nodes.size, 0, '被卸载的那张图**内部结构真的空了**（dispose 后 nodes.size=0）');
    eq(gB.wayCount, 0, 'wayCount 也归零（不是"留着引用假装卸载"）');
    eq(world.stats.unloads >= 2, true, `health 记到卸载次数 ≥ 2（rail+bus 各一次，实测 ${world.stats.unloads}）`);
    ok(world.stats.lastUnload && world.stats.lastUnload.nodes >= 1 && world.stats.lastUnload.ways >= 1
      && typeof world.stats.lastUnload.builtMs === 'number' && typeof world.stats.lastUnload.idleMs === 'number',
      `卸载记录如实写明"释放了什么、空闲多久、重建要多久"（${JSON.stringify(world.stats.lastUnload)})`);
    // 资产片永不卸载
    eq(world.slot('rail', 'alpha1').state, 'ready', '资产片 alpha1 **仍然是 ready**（R28：永不卸载）');
    eq(world.slot('bus', 'alpha1').state, 'ready', '资产片的道路图同样不卸');
    // 再被用到 ⇒ 重建
    const before = world.stats.syncBuilds;
    const gB2 = rail.graphAt(39.9500, 116.4500);
    eq(world.stats.syncBuilds - before, 1, '再次用到 B 片 ⇒ 重新同步建出来');
    eq(gB2.wayCount, waysBefore, '重建后的 way 条数与卸载前一致');
    eq(gB2.nodes.size, nodesBefore, '重建后的节点数与卸载前一致');
    eq(gB2 === gB, false, '是一个**新实例**（旧实例已 dispose）');
  }

  /* ------------------------------ 9. 人口网格按区域算（幂等） ------------------------------ */
  section('9. 人口网格按区域算：`Population#buildRegion(rect)` 只碰这一块，而且幂等');
  {
    const pop = new Population(db);
    world.population = pop;
    world.populationMode = 'region';
    const cellsBefore = db.prepare('SELECT COUNT(*) AS c FROM population_cells').get().c;
    eq(cellsBefore, 0, '起点：population_cells 是空的（还没算过）');
    const stA = pop.buildRegion(RECT_A);
    ok(stA.cells > 0, `只为 A 片算之后有 ${stA.cells} 格（${stA.ways} 个地块 · ${stA.ms} ms）`);
    const tA = pop.totals();
    ok(tA.population > 0, `A 片算出来 ${tA.population} 人`);
    // B 片的格子必须还是 0（只算激活区域）
    const cB = cellOf(39.9605, 116.4205);
    const inB = db.prepare('SELECT COUNT(*) AS c FROM population_cells WHERE cell_x = ? AND cell_y = ?').get(cB.x, cB.y).c;
    eq(inB, 0, 'B 片那栋楼所在的格子仍然是 0（未激活区域不算）');
    const cA = cellOf(39.9605, 116.2405);
    const inA = db.prepare('SELECT COUNT(*) AS c FROM population_cells WHERE cell_x = ? AND cell_y = ?').get(cA.x, cA.y).c;
    ok(inA > 0, 'A 片那栋楼所在的格子有值');
    // 幂等：重复算同一块不许翻倍（这是"按区域增量"能成立的前提）
    const stA2 = pop.buildRegion(RECT_A);
    const tA2 = pop.totals();
    eq(tA2.population, tA.population, '重复 buildRegion 同一块 ⇒ 总人口**不翻倍**（幂等）');
    eq(tA2.cells, tA.cells, '格子数也不变');
    eq(stA2.cellsAfter, tA2.cells, 'buildRegion 回显的 cellsAfter 与实际一致');
    // 再把 B 片算上：这时两片都有值（模拟"B 片后来被激活"）
    pop.buildRegion(RECT_B);
    const tBoth = pop.totals();
    ok(tBoth.population > tA.population, `补上 B 片之后总人口从 ${tA.population} 涨到 ${tBoth.population}`);
    eq(pop.buildRegion(RECT_B).population, tBoth.population, 'B 片再算一次也不翻倍');
  }

  /* ------------------------------ 10. info() / health 的形状 ------------------------------ */
  section('10. `/api/health` 的 regions.lazy 块 + 关闭时**不长出**这个键');
  {
    const info = db.info().regions.lazy;
    ok(info && info.on === true, 'regions.lazy.on === true');
    ok(Array.isArray(info.rail.ready) && Array.isArray(info.bus.ready), 'rail/bus 各自报 ready/absent');
    ok(info.counters && typeof info.counters.builds === 'number', 'counters 里有 builds/unloads/...');
    ok(info.assetShards.includes('alpha1') && info.alwaysActive.length === 0, '资产片与 alwaysActive 分开报');
    // 单测里直接 new RegionDB（没挂世界）时**不该**多出 lazy 键
    const plain = openRegionDB(cfg, {});
    raw_noop: {
      // 这里刻意不挂世界，验证"没有世界就不多字段"
      const r = plain.info().regions;
      ok(r.lazy && r.lazy.world === null, 'lazyOn 但还没挂世界 ⇒ lazy 只报 {on, world:null, note}');
    }
    plain.close();
  }

  /* ------------------------------ 收尾 ------------------------------ */
  world.stop();
  try { db.close(); } catch { /* ignore */ }
  console.log(`\n[region-lazy] 通过 ${pass} 项 · 失败 ${fail} 项`);
  if (fail) {
    console.log('失败明细：');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('[region-lazy] 崩了：', err.stack || err.message);
  process.exit(2);
});
