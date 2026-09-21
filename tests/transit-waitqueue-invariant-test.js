'use strict';
/**
 * 候车台账的**不变量** + 人数一律整数 · 专项测试
 *
 *   node tests/transit-waitqueue-invariant-test.js
 *
 * 用户报的两个 bug（本文件就是这两条的验收）：
 *
 * 1) **等车目的站与线路不匹配**：某个车站的候车明细里出现了**根本不服务这个站**的线路
 *    （例："2 路" 和 "示例公交 1 路" 的一号站互不相干，站台上却挂着去对方线路目的地的乘客）。
 *    根因（见 server/transit.js 的 _lineServesStation / _addWaiting / _sweepStationQueues）：
 *    乘客的**行程**是"建 O/D 需求表那一刻"算出来的快照，之后改站序 / 删站 / 删线路 / 撤销重做
 *    都能让它过期；换乘的乘客在换乘站重新排队时（_alightAt）只认行程里的 lineId，
 *    从来不问"这条线现在还停这一站吗"，于是站台上多出一行不存在的队，而且那批人永远等不到车。
 *
 *    修前的实测（§2 的场景，两条线 A—B—C、乘客 A→C 要在 B 换乘，途中把 1 路的站序改成 [D, C]）：
 *      B 站 waitingByLine = [{ lineId: 2, name: '1 路', waiting: 6,
 *                              destMix: [{ stationId: 3, name: 'C 终点', people: 6 }] }]
 *      —— 1 路已经不停 B 了，站台上却挂着"等 1 路去 C"的 6 个人，再跑 600 游戏秒他们还在那儿
 *      （1 路的车永远不会停 B）。修后同一场景：B 站不再有 1 路这一行，那 6 个人被重新规划成
 *      "从当前位置真的走得通"的行程（在 A 站走站间接驳去坐 1 路），一个都没少。
 *
 * 2) **人数出现小数**（"等车 3.4 人"）：乘客按游戏秒累积（内部必须是小数，慢线靠零头攒够整人），
 *    但**对外展示的人数必须一律整数**，而且每一行的整数之和要等于那一行的合计。
 *
 * 覆盖的验收点：
 *   §1 两条**互不相连**的线路：各自站的候车明细里绝不会出现对方（含"塞一份过期行程"的注入）
 *   §2 换乘链过期（改站序）：换乘站上不会留下那条线的队，乘客也不会凭空蒸发
 *   §3 换乘链断裂（删线路）：不会出现"线路 #id"的幽灵桶
 *   §4 撤销 / 重做（直接改 lines 表）：O/D 表必须作废重算，候车台账必须清扫
 *   §5 整数展示：waiting / lost / destMix / waitingByDest / 车上 paxByDest / 公司 riders 全是整数，
 *      且 Σ 明细 = 合计；同时**内部账仍然是小数**（慢线还能攒零头）
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { metersBetween } = require('../server/geo');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-waitqueue-invariant');
const LAT_MAIN = 39.9;
const LAT_SIDE = LAT_MAIN - 0.028;      // ≈3.1 km（> 2.3 km 步行接驳半径 → 两条线真的互不相连）
const LON0 = 116.4;
const STEP_LON = 0.0025;                // ≈213 米一格
const NODES = 14;
const RAIL_MAIN = 700;
const RAIL_SIDE = 701;
const BASE_MAIN = 30000;
const BASE_SIDE = 31000;

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const lonOf = (i) => LON0 + i * STEP_LON;
const nodeOf = (rail, i) => (rail === 'main' ? BASE_MAIN : BASE_SIDE) + i;
const latOf = (rail) => (rail === 'main' ? LAT_MAIN : LAT_SIDE);

/** 人造底图：两条**相距 3.1 km** 的南北铁路（插进 rtree，建站时吸附要用） */
function buildFixture(db) {
  const insNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = db.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  for (const rail of ['main', 'side']) {
    const way = rail === 'main' ? RAIL_MAIN : RAIL_SIDE;
    const lat = latOf(rail);
    for (let i = 0; i < NODES; i++) {
      const id = nodeOf(rail, i);
      insNode.run(id, lat, lonOf(i), now);
      insIndex.run(id, lonOf(i), lonOf(i), lat, lat);
      insWayNode.run(way, i, id);
    }
    insWay.run(way, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, NODES, lat, lat, lonOf(0), lonOf(NODES - 1));
    insWayIndex.run(way, lonOf(0), lonOf(NODES - 1), lat, lat);
  }
}

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
  const at = (rail, idx) => ({ lat: latOf(rail), lon: lonOf(idx) });
  return { raw, db, rail, transit, user, at };
}

/** 让游戏时间走 gameSec 游戏秒（×1 时 1 实时秒 = 1 游戏秒） */
function run(transit, gameSec, chunkMs = 3000) {
  let done = 0;
  while (done < gameSec) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

/** 某站某公司某线路桶的原始数据（直接看数据结构，不经过展示层） */
function bucketOf(transit, stationId, companyId, owner, lineId) {
  const byCompany = transit.stationQueues.get(Number(stationId));
  if (!byCompany) return null;
  const entry = byCompany.get(transit._companyKey(companyId, owner));
  if (!entry) return null;
  return entry.buckets.get(transit._bucketKey(lineId)) || null;
}

/** 这个站在 waitingByLine 里的非兜底行 */
function lineRows(transit, stationId) {
  return transit.stationWaiting(stationId).waitingByLine.filter((r) => r.lineId != null);
}

/** 一条线现在服务哪些站（按线路缓存的停靠站 = 车真的会停的站） */
function servedStations(transit, lineId) {
  const cache = transit.lineCache.get(Number(lineId));
  return cache ? cache.stops.map((s) => Number(s.stationId)) : [];
}

/**
 * **核心不变量**：一个站的候车明细里
 *   ① 非兜底行的线路必须真的停这一站；
 *   ② 每一批带行程的乘客，行程第 idx 段必须是"从这一站坐这条线"（或从这一站走一段接驳）。
 * 返回违规清单（空数组 = 合规）。
 */
function violations(transit, stationId) {
  const bad = [];
  const byCompany = transit.stationQueues.get(Number(stationId));
  if (!byCompany) return bad;
  for (const e of byCompany.values()) {
    for (const [key, b] of e.buckets) {
      if (key && !servedStations(transit, key).includes(Number(stationId))) {
        bad.push(`桶 lineId=${key} 不服务站 #${stationId}（等 ${b.waiting.toFixed(2)} 人）`);
      }
      for (const c of b.cohorts) {
        if (!c.plan) continue;
        const idx = c.idx == null ? 0 : Number(c.idx);
        const step = c.plan.steps[idx];
        const ok = !!step
          && (step.type === 'ride'
            ? (!!key && Number(step.lineId) === Number(key) && Number(step.from) === Number(stationId))
            : (step.type === 'walk' && Number(step.from) === Number(stationId)));
        if (!ok) bad.push(`批次行程第 ${idx} 段与桶 lineId=${key} / 站 #${stationId} 对不上`);
      }
    }
  }
  return bad;
}

/** 人数必须是整数的字段（展示层） */
function wholeNumberFields(rows, field) {
  return rows.every((r) => Number.isInteger(r[field]));
}

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 候车台账不变量 + 人数整数 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ============ §1 两条互不相连的线路：绝不串台 ============ */
  console.log('▶ §1 两条互不相连的线路（相距 3.1 km，中间连步行接驳都没有）');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: '主线起点', kind: 'rail', ...at('main', 0) }).station.id;
    const B = transit.createStation(user, { name: '主线终点', kind: 'rail', ...at('main', 6) }).station.id;
    const C = transit.createStation(user, { name: '侧线起点', kind: 'rail', ...at('side', 0) }).station.id;
    const D = transit.createStation(user, { name: '侧线终点', kind: 'rail', ...at('side', 6) }).station.id;
    const L1 = transit.createLine(user, { name: '2 路', kind: 'rail', stops: [A, B] }).line;
    const L2 = transit.createLine(user, { name: '示例公交 1 路', kind: 'rail', stops: [C, D] }).line;
    const g = transit._ensureItineraryGraph();
    const walkCross = metersBetween({ lat: LAT_MAIN, lon: LON0 }, { lat: LAT_SIDE, lon: LON0 });
    check('两条线确实互不相连（既有步行接驳边里没有跨线的站对，两线相距 ≈3.1 km）',
      !g.walk.adj.get(A).some((x) => x.to === C) && walkCross > transit.transferWalkRadiusM(700, 700),
      `直线距离 ${Math.round(walkCross)} m > 允许步行 ${transit.transferWalkRadiusM(700, 700)} m`);

    const c1 = transit.lineCache.get(L1.id);
    const c2 = transit.lineCache.get(L2.id);
    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, L1.id, 6, transit.clockMs, B);
    transit._addWaiting(C, c2.queueCompanyId, c2.companyOwner, L2.id, 4, transit.clockMs, D);
    check('主线站的候车明细里只有主线（侧线的 4 个人没有跑到主线上）',
      lineRows(transit, A).length === 1 && lineRows(transit, A)[0].lineId === L1.id
      && lineRows(transit, C).length === 1 && lineRows(transit, C)[0].lineId === L2.id,
      `A 站 ${JSON.stringify(lineRows(transit, A).map((r) => r.name))} / C 站 ${JSON.stringify(lineRows(transit, C).map((r) => r.name))}`);
    check('两站的候车明细都满足不变量（没有任何"不服务这个站"的线路）',
      violations(transit, A).length === 0 && violations(transit, C).length === 0,
      JSON.stringify(violations(transit, A).concat(violations(transit, C))));

    // ★ 塞一份**过期行程**（"在 A 站坐侧线 L2 去 D"，这是改线之前才会有的行程）：
    //   守卫必须把它挡下来 —— 绝不能因此让 A 站冒出一行 "示例公交 1 路"
    const staleSteps = [{ type: 'ride', lineId: L2.id, lineName: '示例公交 1 路', from: A, to: D, meters: 3000, sec: 300 }];
    const stalePlan = transit._makePlan(A, D, staleSteps, 300);
    transit._addWaiting(A, c2.queueCompanyId, c2.companyOwner, L2.id, 3, transit.clockMs, D, stalePlan, 0);
    const rowsA = lineRows(transit, A);
    check('★ 过期行程（侧线在 A 站拉人）被挡下：A 站不会出现"示例公交 1 路"这一行',
      rowsA.every((r) => r.lineId !== L2.id) && rowsA.some((r) => r.lineId === L1.id),
      JSON.stringify(rowsA.map((r) => `${r.name} ${r.waiting} 人`)));
    check('★ 这 3 个人没被吞掉：他们落到兜底桶（谁的车停这一站都能拉）',
      (transit.stationWaiting(A).waitingByLine.find((r) => r.lineId === null) || {}).waiting === 3
      && transit.stationWaiting(A).waiting === 9,
      JSON.stringify(transit.stationWaiting(A).waitingByLine));
    check('★ 注入之后的候车台账仍然满足不变量',
      violations(transit, A).length === 0, JSON.stringify(violations(transit, A)));
    w.raw.close();
  }

  /* ============ §2 换乘链过期：改站序以后换乘站上不会留下那条线的队 ============ */
  console.log('\n▶ §2 换乘链过期（乘客还在车上时，换乘的那条线改了站序）');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A 起点', kind: 'rail', ...at('main', 0) }).station.id;
    const B = transit.createStation(user, { name: 'B 换乘站', kind: 'rail', ...at('main', 7) }).station.id;
    const C = transit.createStation(user, { name: 'C 终点', kind: 'rail', ...at('main', 13) }).station.id;
    const D = transit.createStation(user, { name: 'D 备用站', kind: 'rail', ...at('main', 3) }).station.id;
    const L1 = transit.createLine(user, { name: '2 路', kind: 'rail', stops: [A, B] }).line;
    const L2 = transit.createLine(user, { name: '示例公交 1 路', kind: 'rail', stops: [B, C] }).line;
    const c1 = transit.lineCache.get(L1.id);
    const plan = transit._itinerary(A, C);
    check('A→C 的行程是"坐 2 路到 B、换乘 1 路到 C"',
      !!plan && plan.transfers === 1 && Number(plan.steps[0].lineId) === L1.id && Number(plan.steps[1].lineId) === L2.id,
      plan ? plan.steps.map((s) => `${s.type}#${s.lineId}@${s.from}->${s.to}`).join(' → ') : '没有行程');

    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, L1.id, 6, transit.clockMs, C, plan, 0);
    const veh = transit.createVehicle(user, { kind: 'metro_b4', lineId: L1.id }).vehicle;
    transit.speed = 1;
    run(transit, 45);                              // 上车、开出 A 站（还没到 B）
    const rt = transit._runtimeFor(veh.id);
    check('6 个人已经上车（行程记在车上）', Math.round(rt.load) === 6, `载客 ${rt.load}`);

    // ★ 用户在线上的世界里改线路站序 = 这个操作
    transit.updateLine(user, { id: L2.id, stops: [D, C] });
    check('1 路改完站序后不再停 B 站（cache 与库一致）',
      !servedStations(transit, L2.id).includes(B) && transit._parseStops(transit._st.line.get(L2.id).stops).includes(D),
      `1 路现在停 ${JSON.stringify(servedStations(transit, L2.id))}`);

    run(transit, 240);                             // 车开到 B：乘客在这一站下车换乘
    const rowsB = lineRows(transit, B);
    check('★ B 站的候车明细里**没有** 1 路（它已经不服务 B 了）—— 这就是用户报的那一行',
      rowsB.every((r) => r.lineId !== L2.id),
      JSON.stringify(rowsB.map((r) => `${r.name} ${r.waiting} 人`)));
    check('★ B 站的候车台账满足不变量（桶与行程都对得上）',
      violations(transit, B).length === 0, JSON.stringify(violations(transit, B)));
    // "没蒸发"的账：站台上等 + 步行接驳中 + 在车上 + 已到达，四处加起来一个人都不能少
    const aboardNow = Math.round(rt.load);
    const walking = [A, B, C].reduce((n, s) => n + transit.stationPaxStats(s).paxWalking, 0);
    const arrived = [A, B, C].reduce((n, s) => n + transit.stationPaxStats(s).paxArrived, 0);
    const waitingAll = [A, B, C].reduce((n, s) => n + transit.stationWaiting(s).waiting, 0);
    check('★ 6 个人一个都没蒸发（站台等 / 步行接驳中 / 在车上 / 已到达 = 6）',
      waitingAll + walking + aboardNow + arrived === 6,
      `站台 ${waitingAll} + 步行中 ${walking} + 车上 ${aboardNow} + 已到达 ${arrived} = ${waitingAll + walking + aboardNow + arrived}`);
    check('★ 过期行程被换成了一条"从当前位置真的走得通"的行程（他们开始走接驳去坐 1 路，而不是死等）',
      transit.stationPaxStats(A).paxWalked >= 6 || arrived >= 6,
      `A 站步行出发 ${transit.stationPaxStats(A).paxWalked} 人 / 已到达 ${arrived} 人`);

    run(transit, 600);                             // 再跑一会儿：不会有人被永远挂在 B 站
    const stuck = lineRows(transit, B).filter((r) => r.lineId === L2.id);
    check('★ 再跑 600 游戏秒，B 站也不会冒出 1 路的队伍（老代码会一直挂着那 6 个人）',
      stuck.length === 0 && violations(transit, B).length === 0,
      JSON.stringify(transit.stationWaiting(B).waitingByLine));
    w.raw.close();
  }

  /* ============ §3 换乘链断裂：删掉换乘的那条线 ============ */
  console.log('\n▶ §3 换乘链断裂（乘客在车上时，换乘的那条线被删掉）');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A 起点', kind: 'rail', ...at('main', 0) }).station.id;
    const B = transit.createStation(user, { name: 'B 换乘站', kind: 'rail', ...at('main', 7) }).station.id;
    const C = transit.createStation(user, { name: 'C 终点', kind: 'rail', ...at('main', 13) }).station.id;
    const L1 = transit.createLine(user, { name: '主干线', kind: 'rail', stops: [A, B] }).line;
    const L2 = transit.createLine(user, { name: '要删掉的线', kind: 'rail', stops: [B, C] }).line;
    const c1 = transit.lineCache.get(L1.id);
    const plan = transit._itinerary(A, C);
    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, L1.id, 5, transit.clockMs, C, plan, 0);
    const veh = transit.createVehicle(user, { kind: 'metro_b4', lineId: L1.id }).vehicle;
    transit.speed = 1;
    run(transit, 45);
    transit.deleteLine(user, { id: L2.id });
    run(transit, 300);
    check('★ 删掉线路以后，B 站（以及全线）不会出现"线路 #id"的幽灵候车桶',
      !transit.stationWaiting(B).waitingByLine.some((r) => r.lineId === L2.id)
      && !transit.stationWaiting(A).waitingByLine.some((r) => r.lineId === L2.id),
      JSON.stringify(transit.stationWaiting(B).waitingByLine));
    check('★ 断链之后候车台账仍然满足不变量', violations(transit, B).length === 0, JSON.stringify(violations(transit, B)));
    const rt = transit._runtimeFor(veh.id);
    check('★ 乘客没被卡在站台上等一条不存在的线路（兜底桶或车上）',
      transit.stationWaiting(B).waiting + Math.round(rt.load) >= 0
      && !transit.stationWaiting(B).waitingByLine.some((r) => r.lineId != null && !servedStations(transit, r.lineId).includes(B)),
      `B 站等车 ${transit.stationWaiting(B).waiting} 人 / 车上 ${Math.round(rt.load)} 人`);
    w.raw.close();
  }

  /* ============ §4 撤销 / 重做：O/D 表与候车台账都要跟着变 ============ */
  console.log('\n▶ §4 撤销 / 重做（直接改 lines 表，必须作废 O/D 表并清扫候车台账）');
  {
    const w = makeWorld({ tripRatePerDay: 0.22 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A 起点', kind: 'rail', ...at('main', 0) }).station.id;
    const B = transit.createStation(user, { name: 'B 终点', kind: 'rail', ...at('main', 6) }).station.id;
    const L1 = transit.createLine(user, { name: '1 路', kind: 'rail', stops: [A, B] }).line;
    transit.speed = 1;
    run(transit, 60);                              // 让真实客流进来（stationDemandOf / O/D 表建起来）
    const c1 = transit.lineCache.get(L1.id);
    check('正常状态下这条线在这个站拉得到人（boardPerDay > 0）',
      transit.lineCache.get(L1.id).boardPerDay > 0,
      `boardPerDay=${transit.lineCache.get(L1.id).boardPerDay}`);

    // 站台上放一批等这条线的人，然后把线路删掉（桶必须搬进兜底桶）
    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, L1.id, 6, transit.clockMs, B);
    transit.deleteLine(user, { id: L1.id });
    const fbAfterDelete = (transit.stationWaiting(A).waitingByLine.find((r) => r.lineId === null) || { waiting: 0 }).waiting;
    check('删线路：这条线在站台上的队伍搬进兜底桶（一个不少、也没有幽灵桶）',
      !lineRows(transit, A).some((r) => r.lineId === L1.id) && fbAfterDelete >= 6,
      JSON.stringify(transit.stationWaiting(A).waitingByLine));

    // 撤销：线路回来了 —— O/D 表必须重算，否则这条线的客流永远是 0（老 bug）
    const serialBefore = transit._od ? transit._od.serial : 0;
    transit._undo(user, null, null, false);
    const odAfter = transit._ensureOdDemand();
    check('撤销"删线路"以后 O/D 表被作废重算（构建序号变了）',
      odAfter.serial !== serialBefore && odAfter.byLine.has(Number(L1.id)),
      `serial ${serialBefore} → ${odAfter.serial}，byLine 里有 1 路：${odAfter.byLine.has(Number(L1.id))}`);
    check('★ 撤销以后这条线的客流回来了（boardPerDay > 0，老代码会一直是 0）',
      transit.lineCache.get(L1.id) && transit.lineCache.get(L1.id).boardPerDay > 0,
      transit.lineCache.get(L1.id) ? `boardPerDay=${transit.lineCache.get(L1.id).boardPerDay}` : '没有线路缓存');
    check('撤销以后候车台账仍然满足不变量', violations(transit, A).length === 0, JSON.stringify(violations(transit, A)));

    // 重做：又删掉了 —— 刚才撤销恢复出来的线路桶不许留在站台上
    transit._redo(user, null, null, false);
    check('重做"删线路"以后，站台上不会留下这条线的候车桶',
      !lineRows(transit, A).some((r) => r.lineId === L1.id) && violations(transit, A).length === 0,
      JSON.stringify(transit.stationWaiting(A).waitingByLine));
    w.raw.close();
  }

  /* ============ §5 人数一律整数（内部账仍然是小数） ============ */
  console.log('\n▶ §5 人数出现小数（"等车 3.4 人"）：展示一律整数，内部照旧小数');
  {
    const w = makeWorld({ tripRatePerDay: 0.22 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A 站', kind: 'rail', ...at('main', 0) }).station.id;
    const B = transit.createStation(user, { name: 'B 站', kind: 'rail', ...at('main', 6) }).station.id;
    const C = transit.createStation(user, { name: 'C 站', kind: 'rail', ...at('main', 13) }).station.id;
    const L1 = transit.createLine(user, { name: '1 路', kind: 'rail', stops: [A, B] }).line;
    const L2 = transit.createLine(user, { name: '2 路', kind: 'rail', stops: [A, C] }).line;
    const c1 = transit.lineCache.get(L1.id);
    const c2 = transit.lineCache.get(L2.id);
    // 小数乘客（按游戏秒累积的真实口径）：同一条线两个目的站 + 兜底桶
    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, L1.id, 3.4, transit.clockMs, B);
    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, L1.id, 0.8, transit.clockMs, B);
    transit._addWaiting(A, c2.queueCompanyId, c2.companyOwner, L2.id, 2.6, transit.clockMs, C);
    transit._addWaiting(A, c2.queueCompanyId, c2.companyOwner, null, 1.3, transit.clockMs, C);

    const q = transit.stationWaiting(A);
    const pub = transit.stationPublic(transit._st.station.get(A));
    check('内部账仍然是小数（慢线靠零头攒够整人，这条不能改）',
      Math.abs(bucketOf(transit, A, c1.queueCompanyId, c1.companyOwner, L1.id).waiting - 4.2) < 1e-9,
      `1 路桶 waiting=${bucketOf(transit, A, c1.queueCompanyId, c1.companyOwner, L1.id).waiting}`);
    check('等车人数是整数（waiting / lost / waitingByCompany / waitingByLine）',
      Number.isInteger(q.waiting) && Number.isInteger(q.lost)
      && q.waitingByCompany.every((e) => Number.isInteger(e.waiting) && Number.isInteger(e.lost))
      && q.waitingByLine.every((e) => Number.isInteger(e.waiting) && Number.isInteger(e.lost)),
      `waiting=${q.waiting}，分线路 ${JSON.stringify(q.waitingByLine.map((e) => `${e.name}=${e.waiting}`))}`);
    check('候车去向的人数全是整数（destMix / waitingByDest 一个 3.4 都没有）',
      q.waitingByLine.every((e) => wholeNumberFields(e.destMix, 'people')) && wholeNumberFields(q.waitingByDest, 'people'),
      JSON.stringify(q.waitingByDest));
    const row1 = q.waitingByLine.find((e) => e.lineId === L1.id);
    const sum1 = row1.destMix.reduce((s, d) => s + d.people, 0);
    check('Σ 分线路明细 = 这一行的等车人数（取整以后账仍然对得上）',
      sum1 === row1.waiting && row1.waiting === 4,
      `1 路：明细 ${sum1} / 行 ${row1.waiting}`);
    const sumDest = q.waitingByDest.reduce((s, d) => s + d.people, 0);
    check('Σ 站台去向 = 车站等车合计', sumDest === q.waiting && q.waiting === 8, `明细 ${sumDest} / 合计 ${q.waiting}`);
    check('stationPublic 的 waiting / lost 也是整数（客户端不用自己兜）',
      pub.waiting === q.waiting && Number.isInteger(pub.lost) && Number.isInteger(pub.waitSeconds),
      `waiting=${pub.waiting} lost=${pub.lost}`);

    // 车进站：车上按目的站分的账、公司 riders、车站账本也必须全是整数
    const veh = transit.createVehicle(user, { kind: 'metro_b4', lineId: L1.id }).vehicle;
    transit.speed = 1;
    run(transit, 60);
    const rt = transit._runtimeFor(veh.id);
    const train = transit.snapshot().trains.find((t) => t.id === veh.id);
    check('车上载客 / 本站上下客是整数（快照里不会有小数人数）',
      Number.isInteger(train.load) && Number.isInteger(train.lastBoarded) && Number.isInteger(train.lastAlighted),
      `load=${train.load} lastBoarded=${train.lastBoarded} lastAlighted=${train.lastAlighted}`);
    check('车上"按目的站分组"的人数全是整数，且合计 = 载客',
      train.paxByDest.every((d) => Number.isInteger(d.people) && (d.transfers == null || Number.isInteger(d.transfers)))
      && train.paxByDest.reduce((s, d) => s + d.people, 0) === Math.round(rt.load),
      JSON.stringify(train.paxByDest));
    const comp = transit.companyPublic(transit._st.company.get(c1.queueCompanyId));
    check('公司 riders（人次）是整数', Number.isInteger(comp.riders), `riders=${comp.riders}`);
    const st = transit.stationPaxStats(A);
    check('车站乘客账本（到达 / 出发 / 换乘 / 步行）都是整数',
      Number.isInteger(st.paxArrived) && Number.isInteger(st.paxDeparted)
      && Number.isInteger(st.paxTransferred) && Number.isInteger(st.paxWalked) && Number.isInteger(st.paxWalking),
      JSON.stringify(st));
    check('对外的人数里没有一个是小数（全站逐个字段扫一遍）',
      transit.stationWaiting(A).waitingByLine.every((e) => [e.waiting, e.lost, e.waitSeconds].every(Number.isInteger)
        && e.destMix.every((d) => Number.isInteger(d.people)))
      && transit.stationWaiting(B).waitingByLine.every((e) => e.destMix.every((d) => Number.isInteger(d.people))),
      JSON.stringify(transit.stationWaiting(A).waitingByLine));
    w.raw.close();
  }

  /* ============ §6 失效指纹自检：改了世界，O/D 表与行程图必须换一代 ═============ */
  console.log('\n▶ §6 失效指纹自检（世界指纹一变，候车台账/O/D 表/行程图必须换一代）');
  {
    /**
     * 世界指纹（本测试**自己**从库里算，不依赖服务端的实现）：
     *   车站（id/类型/覆盖半径/吸附节点/坐标）+ 线路（id/类型/站序/归属）+ 游戏日 + 人口版本。
     * 这正是"O/D 需求表 + 行程图"的全部输入（见 server/transit.js 的 _ensureOdDemand 头部说明）。
     */
    const stateSig = (transit) => {
      const parts = [];
      for (const s of transit.db.prepare('SELECT id, kind, catchment_m, node_id, lat, lon FROM stations ORDER BY id').all()) {
        parts.push(`s${s.id}:${s.kind}:${Math.round(s.catchment_m)}:${s.node_id}:${Number(s.lat).toFixed(6)}:${Number(s.lon).toFixed(6)}`);
      }
      for (const l of transit.db.prepare('SELECT id, kind, stops, company_id, owner FROM lines ORDER BY id').all()) {
        parts.push(`l${l.id}:${l.kind}:${l.stops}:${l.company_id}:${l.owner}`);
      }
      parts.push(`d${transit.day}`);
      const pop = transit.population;
      parts.push(`p${pop && pop.version != null ? pop.version : 0}`);
      return parts.join('|');
    };
    /** 缓存代：O/D 表序号 + O/D 键 + 行程图对象（对象换了 = 重建过） */
    const cacheGen = (transit) => ({
      odSerial: transit._od ? transit._od.serial : 0,
      odKey: transit._odKeyValue,
      itin: transit._itinGraph || null,
    });
    /**
     * 一次改动之后自检：世界指纹变了 → 缓存必须已经换了一代（合法作废），
     * 否则就是"有人忘了作废"（用户报的"改了线路/车站，等车明细还是旧的"那种 bug）。
     */
    const afterChange = (transit, gen, sigBefore, label) => {
      const sigAfter = stateSig(transit);
      const od = transit._ensureOdDemand();            // 按需重建：合法作废会在这里换成新序号
      const itin = transit._ensureItineraryGraph();
      const worldChanged = sigAfter !== sigBefore;
      const cacheChanged = od.serial !== gen.odSerial || itin !== gen.itin;
      // 服务端若带指纹自检（_cacheStamp，见那里的说明），它的账也必须自洽：
      // 要么缓存已作废（指纹被清成 null），要么记下的指纹就是当前世界的指纹。
      const stampOk = typeof transit._cacheStamp !== 'function'
        || transit._cacheStampValue == null || transit._cacheStampValue === transit._cacheStamp();
      check(`★ ${label}：世界指纹变了，O/D 表与行程图都换了一代（没有漏作废）`,
        !worldChanged || cacheChanged, `worldChanged=${worldChanged} cacheChanged=${cacheChanged}`);
      check(`★ ${label}：缓存指纹的账自洽（作废后为 null，或等于当前世界指纹）`,
        stampOk, `stamp=${transit._cacheStampValue} / now=${typeof transit._cacheStamp === 'function' ? transit._cacheStamp() : 'n/a'}`);
      return sigAfter;
    };

    const w = makeWorld({ tripRatePerDay: 0.22 });
    const { transit, user, at } = w;
    transit.speed = 1;
    // 每个 op 之前先记下"世界指纹 + 缓存代"，op 之后再比：
    const E = transit.createStation(user, { name: '既有站', kind: 'rail', ...at('main', 0) }).station.id;
    const F = transit.createStation(user, { name: '既有站 2', kind: 'rail', ...at('main', 6) }).station.id;
    transit._ensureOdDemand();
    let sig = stateSig(transit);
    let gen = cacheGen(transit);

    const G = transit.createStation(user, { name: '第三个站', kind: 'rail', ...at('main', 11) }).station.id;
    sig = afterChange(transit, gen, sig, '新建车站');
    gen = cacheGen(transit);

    transit.updateStation(user, { id: F, catchmentM: 1800 });
    sig = afterChange(transit, gen, sig, '改车站覆盖半径（换乘半径的输入）');
    gen = cacheGen(transit);

    const L1 = transit.createLine(user, { name: '1 路', kind: 'rail', stops: [E, F] }).line;
    sig = afterChange(transit, gen, sig, '新建线路');
    gen = cacheGen(transit);

    transit.updateLine(user, { id: L1.id, stops: [E, F, G] });
    sig = afterChange(transit, gen, sig, '改线路站序（加站）');
    gen = cacheGen(transit);

    // 另一家公司的东家先有第二家公司，否则 deleteCompany 会被"至少要保留一家公司"挡住
    const otherUser = { id: 'u-other', name: '另一家', color: '#4363d8' };
    const c2 = transit.ensureCompany(otherUser);
    transit.createCompany(otherUser, { name: '另一家 2' });
    transit.transferLine(user, { id: L1.id, companyId: c2.id });
    sig = afterChange(transit, gen, sig, '线路换公司（line.transfer）');
    gen = cacheGen(transit);
    check('换公司之后候车台账仍然满足不变量', violations(transit, E).length === 0, JSON.stringify(violations(transit, E)));

    transit.deleteLine(user, { id: L1.id });
    sig = afterChange(transit, gen, sig, '删线路');
    gen = cacheGen(transit);

    transit._undo(user, null, null, false);
    sig = afterChange(transit, gen, sig, '撤销（直接改 lines/stations 表）');
    gen = cacheGen(transit);

    transit._redo(user, null, null, false);
    sig = afterChange(transit, gen, sig, '重做（直接改 lines/stations 表）');
    gen = cacheGen(transit);

    transit.deleteStation(user, { id: G });
    sig = afterChange(transit, gen, sig, '删车站');
    gen = cacheGen(transit);

    // 删公司要真的删掉东西才算数（上面那条线路已经删掉了）：再建一条属于 c2 的线路再删这家公司
    const L3 = transit.createLine(user, { name: '3 路', kind: 'rail', stops: [E, F] }).line;
    transit.transferLine(user, { id: L3.id, companyId: c2.id });
    sig = afterChange(transit, gen, sig, '再建一条线并转到 c2 名下');
    gen = cacheGen(transit);
    transit.deleteCompany(user, { id: c2.id });
    sig = afterChange(transit, gen, sig, '删公司（名下真有线路/车站）');
    gen = cacheGen(transit);

    // 边界（与另一个写者的交界）：**绕过作废接口**直接改库 + 走一个 tick ——
    // 不管靠"主动作废"还是靠"指纹自检兜底"，最后世界与缓存都必须一致，
    // 而且候车台账里不许出现"不服务这个站"的行、不许出现小数人数。
    const L2 = transit.createLine(user, { name: '2 路', kind: 'rail', stops: [E, F] }).line;
    transit.db.prepare('UPDATE lines SET stops = ? WHERE id = ?').run(JSON.stringify([F]), L2.id);
    const sigBeforeBypass = stateSig(transit);
    run(transit, 3);                                   // 一个 tick（指纹自检在这里跑）
    const sigAfterBypass = stateSig(transit);
    check('★ 绕过作废接口直接改库（站序被摘空）之后，走一个 tick 世界与缓存必须一致',
      sigAfterBypass === sigBeforeBypass
      && transit._ensureOdDemand().byLine.get(Number(L2.id)) === undefined,
      `byLine 里还有 2 路：${transit._ensureOdDemand().byLine.has(Number(L2.id))}`);
    check('★ 这种"绕过作废"的世界里，候车台账仍然不许出现不服务这个站的线路，也不许出现小数人数',
      violations(transit, E).length === 0 && violations(transit, F).length === 0
      && transit.stationWaiting(E).waitingByLine.every((e) => e.destMix.every((d) => Number.isInteger(d.people))),
      JSON.stringify(transit.stationWaiting(E).waitingByLine));
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
