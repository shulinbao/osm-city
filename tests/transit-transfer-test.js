'use strict';
/**
 * 换乘（transfers）+ 站间步行接驳（OSI）专项测试（不需要那份 500MB 的北京数据集，跑得很快）。
 *
 *   node tests/transit-transfer-test.js
 *
 * 用户点名要的三件事（本文件就是它们的验收）：
 *   1. 两条线路在中间站相交时，乘客能**从头坐到尾**：上 1 号线 → 在换乘站下车 →
 *      重新排 2 号线的队 → 上 2 号线 → 到目的站（换乘人次、到达人次都要记账）；
 *      两条线**接不上**的乘客永远不上车（哪儿也去不了，不计进任何一条线的客流）。
 *   2. 站间步行接驳（NIMBY Rails 的 OSI：半径 2.3 km、速度 1 m/s）：起点站自己没线路时，
 *      乘客先走到 2.3 km 内的邻站，再在那儿坐车；换乘时也允许走一段（站厅里带计时器）。
 *   3. 换乘是"第一段坐哪条线就排哪条线的队"（NR 的 waited line stop）：行程第一段的线路
 *      决定候车桶，第二段在换乘站重新排队，不会串线。
 *
 * 附带验收：per-station paxArrived / paxDeparted / paxTransferred、per-line riders / transfers、
 * Transit#paxStats() 汇总。
 *
 * 底图是**四条互相断开的铁路**（人造）：
 *   main  (lat 39.900)  12 个节点，≈213 米一格（换乘 / 直达的线路都画在这条上）
 *   north (lat 39.918)   4 个节点，正北 ≈1990 米（OSI 接驳用：< 2.3 km）
 *   far   (lat 40.050)   4 个节点，正北 ≈16.6 km（怎么都接不上，验证"没有行程就不走"）
 *   solo  (lat 39.850)   2 个节点，正南 ≈5.5 km（永远没有线路经过，验证孤立车站的乘客不走）
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-transfer-test');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.0025;               // ≈ 213 米一个节点
const NODES = 12;
const LAT_NORTH = LAT + 0.018;         // ≈ 1990 米（OSI 半径 2.3 km 之内）
const LAT_FAR = LAT + 0.15;            // ≈ 16.6 公里（接不上）
const LAT_SOLO = LAT - 0.05;           // ≈ 5.5 公里（孤立）
const WAY_MAIN = 500;
const WAY_NORTH = 501;
const WAY_FAR = 502;
const WAY_SOLO = 503;
const NODE_BASE = { main: 1000, north: 3000, far: 5000, solo: 7000 };

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const lonOf = (i) => LON0 + i * STEP_LON;
const nodeId = (group, i) => NODE_BASE[group] + i;

/** 人造底图：四条断开的铁路（都插进 rtree，建站时吸附要用） */
function buildFixture(db) {
  const insNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = db.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  const ways = [
    { way: WAY_MAIN, group: 'main', lat: LAT, n: NODES },
    { way: WAY_NORTH, group: 'north', lat: LAT_NORTH, n: 4 },
    { way: WAY_FAR, group: 'far', lat: LAT_FAR, n: 4 },
    { way: WAY_SOLO, group: 'solo', lat: LAT_SOLO, n: 2 },
  ];
  for (const w of ways) {
    for (let i = 0; i < w.n; i++) {
      insNode.run(nodeId(w.group, i), w.lat, lonOf(i), now);
      insIndex.run(nodeId(w.group, i), lonOf(i), lonOf(i), w.lat, w.lat);
      insWayNode.run(w.way, i, nodeId(w.group, i));
    }
    insWay.run(w.way, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, w.n, w.lat, w.lat, lonOf(0), lonOf(w.n - 1));
    insWayIndex.run(w.way, lonOf(0), lonOf(w.n - 1), w.lat, w.lat);
  }
}

/** 人造世界：每次调用换一个临时库文件，路网用真正的 RailGraph（与 boarding / linequeue 测试同一套做法） */
let worldSeq = 0;
function makeWorld(config) {
  worldSeq += 1;
  const file = path.join(TMP, `osm-${worldSeq}.sqlite`);
  const raw = openDatabase(file);
  buildFixture(raw);
  const db = { raw, prepare: (sql) => raw.prepare(sql), exec: (sql) => raw.exec(sql) };
  const rail = new RailGraph(db, { mode: 'rail' });
  rail.build();
  const population = {
    catchment: () => ({ pop: 3000, jobs: 500, weightedPop: 3600, activity: 1.2 }),
    totals: () => ({ population: 3000, jobs: 500, cells: 1 }),
  };
  const transit = new Transit(db, {
    rail, population,
    config: Object.assign({ dwellSeconds: 30, patienceSeconds: 1000000, cohortSeconds: 30, tripRatePerDay: 0 }, config || {}),
  });
  const user = { id: 'u-test', name: '测试玩家', color: '#e6194b' };
  transit.ensureCompany(user);
  const at = (group, idx) => ({ lat: group === 'north' ? LAT_NORTH : (group === 'far' ? LAT_FAR : (group === 'solo' ? LAT_SOLO : LAT)), lon: lonOf(idx) });
  return { raw, db, rail, transit, user, at };
}

/**
 * 让游戏时间走 gameSec 游戏秒。
 * 时间基准：×1 = 现实 1 秒 = 游戏 1 秒（旧基准是 1 实时秒 = 1 游戏分钟，
 * 所以换算从 `chunk * 60 * speed` 改成 `chunk * speed`）。默认 3000 毫秒一步 =
 * **3 游戏秒一个小步**，与旧版本的积分粒度一致。
 */
function run(transit, gameSec, chunkMs = 3000) {
  let done = 0;
  while (done < gameSec) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

/** 某个站台上某个线路桶的原始数据（直接看数据结构，不经过展示层） */
function bucketOf(transit, stationId, companyId, owner, lineId) {
  const byCompany = transit.stationQueues.get(Number(stationId));
  if (!byCompany) return null;
  const entry = byCompany.get(transit._companyKey(companyId, owner));
  if (!entry) return null;
  return entry.buckets.get(transit._bucketKey(lineId)) || null;
}

/** 把车里所有的乘客分组抄出来（调试 / 断言用） */
function groupsOf(rt) {
  const out = [];
  for (const [key, g] of rt.paxGroups) out.push({ key, destId: g.destId, people: Math.round(g.people * 10) / 10, idx: g.idx, transfers: g.plan ? g.plan.transfers : null });
  return out;
}

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 换乘（transfers）+ 站间步行接驳（OSI） · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ============ 1. 行程搜索：两条线在中间站相交 → 一次换乘的行程 ============ */
  console.log('▶ 行程搜索：1 号线 → 换乘站 → 2 号线');
  {
    const w = makeWorld({ tripRatePerDay: 0.22 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A 起点', kind: 'rail', ...at('main', 0) }).station.id;
    const M = transit.createStation(user, { name: 'M 换乘站', kind: 'rail', ...at('main', 6) }).station.id;
    const D = transit.createStation(user, { name: 'D 终点', kind: 'rail', ...at('main', 11) }).station.id;
    const line1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, M] }).line;
    const line2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [M, D] }).line;

    const plan = transit._itinerary(A, D);
    check('A → D 有行程（两条线在 M 换乘）', !!plan && plan.steps.length === 2, plan ? plan.steps.map((s) => `${s.type}:${s.type === 'ride' ? s.lineId : ''}${s.from}->${s.to}`).join(' + ') : '没有行程');
    check('行程就是「1 号线 A→M + 2 号线 M→D」，换乘 1 次',
      !!plan && plan.transfers === 1 && plan.steps[0].type === 'ride' && plan.steps[0].lineId === line1.id
      && plan.steps[0].from === A && plan.steps[0].to === M
      && plan.steps[1].type === 'ride' && plan.steps[1].lineId === line2.id
      && plan.steps[1].from === M && plan.steps[1].to === D,
      plan ? JSON.stringify({ transfers: plan.transfers, steps: plan.steps.map((s) => ({ t: s.type, line: s.lineId, from: s.from, to: s.to })) }) : '');
    check('行程第一段就是乘客要排的那条线（waited line stop）', !!plan && plan.firstLeg && plan.firstLeg.lineId === line1.id,
      plan ? `第一段 #${plan.firstLeg && plan.firstLeg.lineId}` : '');
    const direct = transit._itinerary(M, D);
    check('M → D 是直达（同一趟车，不用换乘）', !!direct && direct.transfers === 0 && direct.steps.length === 1,
      direct ? `换乘 ${direct.transfers} 次 / ${direct.steps.length} 段` : '没有行程');
    check('od.stats 里统计到"能到的目的地 / 换乘次数分布"',
      transit.odStats().itineraries && transit.odStats().itineraries.transfers1 >= 1,
      JSON.stringify(transit.odStats().itineraries));
    check('O/D 表把"要换乘才能到"的目的站也排进了线路的 destMix（带行程）',
      (() => {
        const od = transit._ensureOdDemand();
        const e = od.byLine.get(line1.id) && od.byLine.get(line1.id).get(A);
        const hit = e && e.destMix.find((d) => d.stationId === D);
        return !!hit && !!hit.plan && hit.plan.transfers === 1;
      })(), '');
    w.raw.close();
  }

  /* ============ 2. 换乘全程（手动注入 + 直接停站，结果可复现） ============ */
  console.log('\n▶ 换乘全程：上车 → 换乘站下车 → 重新排队 → 上车 → 到站下车');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A 起点', kind: 'rail', ...at('main', 0) }).station.id;
    const M = transit.createStation(user, { name: 'M 换乘站', kind: 'rail', ...at('main', 6) }).station.id;
    const D = transit.createStation(user, { name: 'D 终点', kind: 'rail', ...at('main', 11) }).station.id;
    const line1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, M] }).line;
    const line2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [M, D] }).line;
    const cache1 = transit.lineCache.get(line1.id);
    const cache2 = transit.lineCache.get(line2.id);
    const plan = transit._itinerary(A, D);

    // 站台上先攒 5 个"要换乘去 D"的乘客（等价于客流积累把它们放进 1 号线的桶）
    transit._addWaiting(A, cache1.queueCompanyId, cache1.companyOwner, line1.id, 5, transit.clockMs, D, plan, 0);
    const b1 = bucketOf(transit, A, cache1.queueCompanyId, cache1.companyOwner, line1.id);
    check('这 5 个人排在 1 号线（第一段）的桶里，带着"要去 D、要换乘"的行程',
      !!b1 && b1.waiting === 5 && b1.cohorts.every((c) => c.destId === D && !!c.plan && c.idx === 0),
      b1 ? `等车 ${b1.waiting} 人 / 批次 ${b1.cohorts.length}` : '没有这个桶');

    const veh1 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line1.id }).vehicle;
    const rt1 = transit._runtimeFor(veh1.id);
    transit._dock(transit._st.vehicle.get(veh1.id), cache1, rt1, cache1.path, cache1.stops.find((s) => s.stationId === A));
    check('1 号线的车在 A 站把 5 个人全拉上车（载客 +5）',
      rt1.lastBoarded === 5 && rt1.load === 5, `本站上客 ${rt1.lastBoarded} / 载客 ${rt1.load}`);
    check('车站台账：A 站"出发"5 人', transit.stationPaxStats(A).paxDeparted === 5, JSON.stringify(transit.stationPaxStats(A)));

    transit._dock(transit._st.vehicle.get(veh1.id), cache1, rt1, cache1.path, cache1.stops.find((s) => s.stationId === M));
    check('车到换乘站 M：5 个人全下车（换乘，不是到达）',
      rt1.lastAlighted === 5 && rt1.load === 0, `下车 ${rt1.lastAlighted} / 载客 ${rt1.load}`);
    check('车站台账：M 站"换乘"5 人（到达 0 人）',
      transit.stationPaxStats(M).paxTransferred === 5 && transit.stationPaxStats(M).paxArrived === 0,
      JSON.stringify(transit.stationPaxStats(M)));
    const b2 = bucketOf(transit, M, cache2.queueCompanyId, cache2.companyOwner, line2.id);
    check('这 5 个人已经排进"2 号线在 M 站"的桶里（第二段，idx 已经推进到 1）',
      !!b2 && b2.waiting === 5 && b2.cohorts.every((c) => c.destId === D && c.idx === 1 && !!c.plan),
      b2 ? `2 号线 M 站等车 ${b2.waiting} 人 / 批次 ${b2.cohorts.length}` : '没有 2 号线的桶');
    check('换乘后候车队伍挂在 2 号线的公司口径上，1 号线的桶里不再有人',
      (!bucketOf(transit, M, cache1.queueCompanyId, cache1.companyOwner, line1.id)
        || bucketOf(transit, M, cache1.queueCompanyId, cache1.companyOwner, line1.id).waiting === 0),
      JSON.stringify(transit.stationWaiting(M).waitingByLine));
    check('线路台账：1 号线记了 5 人次"下车换乘"',
      transit.linePublic(transit._st.line.get(line1.id)).transfers === 5,
      `1 号线 transfers=${transit.linePublic(transit._st.line.get(line1.id)).transfers}`);

    const veh2 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line2.id }).vehicle;
    const rt2 = transit._runtimeFor(veh2.id);
    transit._dock(transit._st.vehicle.get(veh2.id), cache2, rt2, cache2.path, cache2.stops.find((s) => s.stationId === M));
    check('2 号线的车在 M 站把这 5 个人拉上车（载客 +5）',
      rt2.lastBoarded === 5 && rt2.load === 5, `本站上客 ${rt2.lastBoarded} / 载客 ${rt2.load}`);
    check('车上这 5 个人的账是"去 D、还剩 0 次换乘"（行程已经走到最后一段）',
      groupsOf(rt2).length === 1 && groupsOf(rt2)[0].destId === D && groupsOf(rt2)[0].idx === 1,
      JSON.stringify(groupsOf(rt2)));
    transit._dock(transit._st.vehicle.get(veh2.id), cache2, rt2, cache2.path, cache2.stops.find((s) => s.stationId === D));
    check('到 D 站全部下车（到达目的站，不是换乘）',
      rt2.lastAlighted === 5 && rt2.load === 0 && rt2.paxGroups.size === 0,
      `下车 ${rt2.lastAlighted} / 载客 ${rt2.load} / 车上分组 ${rt2.paxGroups.size}`);
    check('车站台账：D 站"到达"5 人、M 站仍是"换乘 5 / 到达 0"',
      transit.stationPaxStats(D).paxArrived === 5 && transit.stationPaxStats(M).paxArrived === 0,
      `D=${JSON.stringify(transit.stationPaxStats(D))} M=${JSON.stringify(transit.stationPaxStats(M))}`);
    check('2 号线记了 5 人次上车（riders），公司人次也涨了',
      transit.linePublic(transit._st.line.get(line2.id)).riders === 5,
      `2 号线 riders=${transit.linePublic(transit._st.line.get(line2.id)).riders}`);
    const ps = transit.paxStats();
    check('paxStats() 汇总：到达 5 / 出发 10（A 站 5 + M 站 5）/ 换乘 5',
      ps.stations.arrived === 5 && ps.stations.departed === 10 && ps.stations.transferred === 5,
      JSON.stringify(ps.stations));
    check('paxStats() 把换乘口径也报出来（线路侧 transfers + 最大换乘次数）',
      ps.transfers.lineTransfers === 5 && ps.transfers.maxTransfers === 3,
      JSON.stringify(ps.transfers));
    const snapTrain = transit.snapshot().trains.find((t) => t.id === veh2.id);
    check('快照里的车辆仍带 paxByDest（到站后为空），并带上下客明细',
      !!snapTrain && Array.isArray(snapTrain.paxByDest) && snapTrain.lastServedStation === D && snapTrain.lastAlighted === 5,
      snapTrain ? `paxByDest=${JSON.stringify(snapTrain.paxByDest)} lastAlighted=${snapTrain.lastAlighted}` : '快照里没有 2 号线的车');
    w.raw.close();
  }

  /* ============ 3. 真实客流下的换乘（不手工注入，全自动） ============ */
  console.log('\n▶ 真实客流：O/D 表自己把乘客送到换乘站，再换第二段');
  {
    const w = makeWorld({ tripRatePerDay: 6, patienceSeconds: 1000000 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A 起点', kind: 'rail', ...at('main', 0) }).station.id;
    const M = transit.createStation(user, { name: 'M 换乘站', kind: 'rail', ...at('main', 6) }).station.id;
    const D = transit.createStation(user, { name: 'D 终点', kind: 'rail', ...at('main', 11) }).station.id;
    const line1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, M] }).line;
    const line2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [M, D] }).line;
    transit.createVehicle(user, { kind: 'metro_b6', lineId: line1.id });
    transit.createVehicle(user, { kind: 'metro_b6', lineId: line2.id });
    transit.speed = 1;
    // 跑到"有人在 D 站到达"为止（最多 3 小时游戏时间）；车会自己绕圈
    let arrivedAtD = 0;
    for (let i = 0; i < 120 && arrivedAtD <= 0; i++) {
      run(transit, 90);
      arrivedAtD = transit.stationPaxStats(D).paxArrived;
    }
    const ps = transit.paxStats();
    check('真实客流里，有乘客经换乘到达 D 站', arrivedAtD > 0, `D 站到达 ${arrivedAtD} 人`);
    check('换乘站 M 记下了换乘人次（有人在这儿换了车）', transit.stationPaxStats(M).paxTransferred > 0,
      `M 站换乘 ${transit.stationPaxStats(M).paxTransferred} 人 / 到达 ${transit.stationPaxStats(M).paxArrived} 人`);
    check('两条线都产生了客流（第一段 + 第二段都有人坐）',
      transit.linePublic(transit._st.line.get(line1.id)).riders > 0 && transit.linePublic(transit._st.line.get(line2.id)).riders > 0,
      `1 号线 ${transit.linePublic(transit._st.line.get(line1.id)).riders} 人次 / 2 号线 ${transit.linePublic(transit._st.line.get(line2.id)).riders} 人次`);
    check('paxStats() 的线路侧把换乘人次汇总起来（transfers > 0）', ps.lines.transfers > 0,
      `线路换乘人次 ${ps.lines.transfers} / 车站换乘 ${ps.stations.transferred} 人`);
    check('O/D 表里 A→D 是"1 次换乘"，M→D 是直达',
      (() => {
        const od = transit._ensureOdDemand();
        const it = od.stats.itineraries;
        return it && it.transfers1 >= 1 && it.direct >= 1;
      })(), JSON.stringify(transit.odStats().itineraries));
    w.raw.close();
  }

  /* ============ 4. 接不上的乘客永远不上车 ============ */
  console.log('\n▶ 没有行程的乘客：一个都不会上车');
  {
    const w = makeWorld({ tripRatePerDay: 6, patienceSeconds: 1000000 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A', kind: 'rail', ...at('main', 0) }).station.id;
    const B = transit.createStation(user, { name: 'B', kind: 'rail', ...at('main', 6) }).station.id;
    const C = transit.createStation(user, { name: 'C（远）', kind: 'rail', ...at('far', 0) }).station.id;
    const E = transit.createStation(user, { name: 'E（远）', kind: 'rail', ...at('far', 3) }).station.id;
    const F = transit.createStation(user, { name: 'F（孤立，没线路）', kind: 'rail', ...at('solo', 0) }).station.id;
    const line1 = transit.createLine(user, { name: '近线', kind: 'rail', stops: [A, B] }).line;
    const line2 = transit.createLine(user, { name: '远线', kind: 'rail', stops: [C, E] }).line;
    check('近线（A/B）与远线（C/E）之间没有行程（16 km 且断网）',
      transit._itinerary(A, C) === null && transit._itinerary(B, E) === null,
      `A→C=${transit._itinerary(A, C)} B→E=${transit._itinerary(B, E)}`);
    const oda = transit.odForStation(A);
    check('A 站的目的地里一个远线车站都没有（只可能是 B）',
      oda.dests.length > 0 && oda.dests.every((d) => d.stationId === B),
      JSON.stringify(oda.dests.map((d) => ({ s: d.stationId, p: d.people }))));
    const od = transit._ensureOdDemand();
    const e1 = od.byLine.get(line1.id) && od.byLine.get(line1.id).get(A);
    check('近线的桶里只有去 B 的批次（不会混进远线的目的站）',
      !!e1 && e1.destMix.length === 1 && e1.destMix[0].stationId === B,
      e1 ? JSON.stringify(e1.destMix.map((d) => ({ s: d.stationId, p: Math.round(d.people) }))) : '没有这条线的桶');
    check('孤立车站 F（没有任何线路、2.3 km 内也没有别的站）：日需求全算"走不掉"',
      transit.odForStation(F).served === 0 && transit.odForStation(F).reach === 0 && transit.odForStation(F).spawn > 0,
      JSON.stringify(transit.odForStation(F)));
    transit.createVehicle(user, { kind: 'metro_b6', lineId: line1.id });
    transit.createVehicle(user, { kind: 'metro_b6', lineId: line2.id });
    transit.speed = 1;
    run(transit, 1800);   // 半小时游戏时间
    check('跑过之后 F 站一个人都没等到车（走不掉的乘客不排队）',
      transit.stationWaiting(F).waiting === 0 && transit.stationPaxStats(F).paxDeparted === 0,
      `F 等车 ${transit.stationWaiting(F).waiting} 人 / 出发 ${transit.stationPaxStats(F).paxDeparted} 人`);
    const farIds = new Set([C, E]);
    const leaked = [];
    for (const [sid, byCompany] of transit.stationQueues) {
      if (!farIds.has(sid)) continue;
      for (const e of byCompany.values()) {
        for (const b of e.buckets.values()) {
          for (const c of b.cohorts) if (c.destId != null && !farIds.has(c.destId)) leaked.push({ sid, dest: c.destId });
        }
      }
    }
    check('远线站台上没有"要去近线车站"的乘客（接不上就不排这条队）', leaked.length === 0, JSON.stringify(leaked.slice(0, 5)));
    const ods = transit.odStats();
    check('O/D 统计里"走不掉"的人数是正的（dropped > 0）', ods.dropped > 0,
      `spawn=${ods.spawn} served=${ods.served} dropped=${ods.dropped}`);
    w.raw.close();
  }

  /* ============ 5. 站间步行接驳（OSI）：2.3 km 内走出去坐车 ============ */
  console.log('\n▶ 站间步行接驳（OSI）：起点站没线路 → 走到邻站坐车');
  {
    const w = makeWorld({ tripRatePerDay: 6, patienceSeconds: 1000000 });
    const { transit, user, at } = w;
    // B / A 在主铁路上（近线）；N1 在正北 1990 米的另一条铁路上，没有任何线路；
    // N2 / N4 也在北边那条铁路上（有线路），用来证明 N1 确实是个"没车可坐"的站。
    const B = transit.createStation(user, { name: 'B（上车点）', kind: 'rail', ...at('main', 0) }).station.id;
    const A = transit.createStation(user, { name: 'A（目的地）', kind: 'rail', ...at('main', 6) }).station.id;
    const N2 = transit.createStation(user, { name: 'N2', kind: 'rail', ...at('north', 1) }).station.id;
    const N4 = transit.createStation(user, { name: 'N4', kind: 'rail', ...at('north', 3) }).station.id;
    const N1 = transit.createStation(user, { name: 'N1（无线路）', kind: 'rail', ...at('north', 0) }).station.id;
    const FARST = transit.createStation(user, { name: 'FARST（14 km 外）', kind: 'rail', ...at('far', 0) }).station.id;
    const line = transit.createLine(user, { name: '近线', kind: 'rail', stops: [B, A] }).line;
    const northLine = transit.createLine(user, { name: '北线', kind: 'rail', stops: [N2, N4] }).line;

    const walk = transit._itinerary(N1, A);
    check('N1（没有线路）→ A 有行程：先步行、再坐车',
      !!walk && walk.steps.length === 2 && walk.steps[0].type === 'walk' && walk.steps[1].type === 'ride',
      walk ? walk.steps.map((s) => `${s.type}${s.type === 'ride' ? '#' + s.lineId : ''} ${s.from}->${s.to}(${s.meters}m)`).join(' + ') : '没有行程');
    check('步行那一段是 2.3 km 内的邻站（OSI 半径），而且按 1 m/s 计时间',
      !!walk && walk.steps[0].meters <= 2300 && walk.steps[0].sec >= walk.steps[0].meters,
      walk ? `步行 ${walk.steps[0].meters} 米 / 计 ${walk.steps[0].sec} 秒` : '');
    check('走路不算坐车：行程里只有 1 段乘车、0 次换乘',
      !!walk && walk.rideLegs === 1 && walk.transfers === 0 && walk.walkLegs === 1,
      walk ? `rideLegs=${walk.rideLegs} walkLegs=${walk.walkLegs} transfers=${walk.transfers}` : '');
    check('走完以后上的车是"近线在 B 站"的车（上车点 = 邻站）',
      !!walk && walk.firstLeg.lineId === line.id && walk.firstLeg.from === B,
      walk ? `第一段乘车：线路 #${walk.firstLeg.lineId} 在站 ${walk.firstLeg.from}` : '');
    const g = transit._ensureItineraryGraph();
    const nb = g.walk.adj.get(N1) || [];
    check('步行接驳边只在 2.3 km 内（OSI 半径）：N1 的邻居全都 ≤ 2300 米，14 km 外的站不在里面',
      nb.length > 0 && nb.every((x) => x.meters <= 2300) && !nb.some((x) => x.to === FARST)
      && transit._itinerary(N1, FARST) === null,
      `N1 的步行邻居 ${nb.length} 个，最远 ${nb.length ? Math.round(Math.max(...nb.map((x) => x.meters))) : 0} 米；N1→14 km 外的站 = ${transit._itinerary(N1, FARST)}`);
    const od = transit._ensureOdDemand();
    const wo = od.byOriginWalk.get(N1);
    check('O/D 表把 N1 的乘客记成"先步行去邻站坐车"的一批',
      !!wo && wo.total > 0 && wo.entries.every((e) => e.plan.steps[0].type === 'walk')
      && wo.entries.some((e) => e.boardStationId === B),
      wo ? `${Math.round(wo.total)} 人/日，上车点 ${[...new Set(wo.entries.map((e) => e.boardStationId))].join(',')}` : '没有步行出发的乘客');
    check('N1 的乘客确实只在 2.3 km 内挑到车站（北线自己那两站 + 近线的 B）',
      !!wo && wo.entries.every((e) => e.walkMeters <= 2300),
      wo ? JSON.stringify(wo.entries.map((e) => ({ dest: e.destId, walk: e.walkMeters, board: e.boardStationId }))) : '');

    transit.createVehicle(user, { kind: 'metro_b6', lineId: line.id });
    transit.createVehicle(user, { kind: 'metro_b6', lineId: northLine.id });
    transit.speed = 1;
    let arrived = 0;
    for (let i = 0; i < 120 && arrived <= 0; i++) {
      run(transit, 90);
      arrived = transit.stationPaxStats(A).paxArrived;
    }
    const sN1 = transit.stationPaxStats(N1);
    check('N1 的乘客先从这里"步行出发"（paxDeparted / paxWalked 记上了）',
      sN1.paxDeparted > 0 && sN1.paxWalked > 0, JSON.stringify(sN1));
    check('走完以后在 B 站上了车，最后到达 A 站', arrived > 0 && transit.stationPaxStats(B).paxDeparted > 0,
      `A 站到达 ${arrived} 人 / B 站出发 ${transit.stationPaxStats(B).paxDeparted} 人`);
    check('步行接驳的人不算"坐了车"：N1 的出发人数全部来自步行（这一站没有车可上）',
      sN1.paxWalked === sN1.paxDeparted && sN1.paxDeparted > 0,
      `N1 出发 ${sN1.paxDeparted} / 其中步行 ${sN1.paxWalked}`);
    const cacheLine = transit.lineCache.get(line.id);
    const bBucket = bucketOf(transit, B, cacheLine.queueCompanyId, cacheLine.companyOwner, line.id);
    check('B 站的近线桶里每一批乘客都带着行程（走完接驳后照样按行程排队）',
      !bBucket || bBucket.cohorts.every((c) => !!c.plan && c.destId != null),
      bBucket ? `${bBucket.cohorts.length} 批，目的站 ${[...new Set(bBucket.cohorts.map((c) => c.destId))].join(',')}` : '桶已经空了');
    w.raw.close();
  }
} catch (err) {
  console.error('\n测试异常终止:', err && err.stack ? err.stack : err);
  failed += 1;
  failures.push('异常: ' + (err && err.message));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('\n' + '─'.repeat(52));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) { console.log('\n失败项：'); for (const f of failures) console.log('  · ' + f); }
console.log('─'.repeat(52) + '\n');
process.exit(failed ? 1 : 0);
