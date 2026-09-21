'use strict';
/**
 * 自由发车的**逐站到站预测**与**晚点系统**的专项测试（不需要那份 500MB 的北京数据集，跑得很快）。
 *
 *   node tests/transit-delay-test.js
 *
 * 要验的三件事（NIMBY Rails 的口径）：
 *   ① 自由发车（没有班次表的线路）也要能报出"本趟剩下每一站几点到、几点发"：
 *      从车现在的位置往后推，区间时间与 _runTable 同一套运动学（加速度/制动/巡航 + 到站余量），
 *      再加每站停站时间 → 每辆车上的 remainingStops。
 *      验收：把它跟**实际到站时刻**比，误差要在 ~2 游戏秒以内（实测最差不到 1 秒）。
 *   ② 晚点：每办完一站拿实际时刻跟"计划"比（班次车比时刻表，自由发车比它自己这一趟的预测 +
 *      运行余裕），记 delaySeconds / delayTrend / peakDelaySeconds / recovered 与逐站历史；
 *      晚点的成因要如实反映出来 —— 被前车压着（_enforceSpacing）、上下客多停得久、起点站发车晚。
 *   ③ 线路上的汇总：onTimeRate / avgDelaySeconds / maxDelaySeconds（linePublic + 快照）。
 *   ④ 顺带：vehicles[].createdAt（服役时间）与 dayKm（今日里程）—— 客户端这两格原来是"—"。
 *
 * 世界是人造底图（与 transit-linequeue-test.js 同一套做法）：一条 12 站、约 9.4 km 的直线，
 * 站间约 854 米，跑 metro_b4（80 km/h、a=b=1.1），中间站停 30 秒、首末站 30+20 秒。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-delay-test');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.01;        // ≈ 854 米一个节点（区间够长，晚点追回的过程才看得清）
const NODES = 12;             // 一条 9.4 公里的线
const RAIL_BASE = 1000;
const RAIL_WAY = 500;
const DWELL = 30;             // config.dwellSeconds
const TERMINAL_DWELL = 20;    // config.terminalDwellSeconds

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const lonOf = (i) => LON0 + i * STEP_LON;

/** 人造底图：一条小铁路（都插进 rtree 索引，吸附时要用） */
function buildFixture(db) {
  const insNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = db.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  for (let i = 0; i < NODES; i++) {
    insNode.run(RAIL_BASE + i, LAT, lonOf(i), now);
    insIndex.run(RAIL_BASE + i, lonOf(i), lonOf(i), LAT, LAT);
    insWayNode.run(RAIL_WAY, i, RAIL_BASE + i);
  }
  insWay.run(RAIL_WAY, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, NODES, LAT, LAT, lonOf(0), lonOf(NODES - 1));
  insWayIndex.run(RAIL_WAY, lonOf(0), lonOf(NODES - 1), LAT, LAT);
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
  const road = new RailGraph(db, { mode: 'bus' });
  let roadBuilt = false;
  const ensureBusGraph = () => { if (!roadBuilt) { road.build(); roadBuilt = true; } return road; };
  const population = {
    catchment: () => ({ pop: 3000, jobs: 500, weightedPop: 3600, activity: 1.2 }),
    totals: () => ({ population: 3000, jobs: 500, cells: 1 }),
  };
  const transit = new Transit(db, {
    rail, ensureBusGraph, population,
    // 默认没有自动客流（tripRatePerDay = 0）：本文件只关心"预测准不准、晚点怎么走"，
    // 需要真实上下客的场景自己往站台上放人
    config: Object.assign({ dwellSeconds: DWELL, terminalDwellSeconds: TERMINAL_DWELL, patienceSeconds: 1000000, tripRatePerDay: 0 }, config || {}),
  });
  const user = { id: 'u-delay', name: '测试玩家', color: '#e6194b' };
  const company = transit.ensureCompany(user);
  const at = (idx) => ({ lat: LAT, lon: lonOf(idx) });
  return { raw, db, rail, road, transit, user, company, at };
}

/** 造一条线 + n 辆车（车站每站一个），返回站号和车 */
function makeLine(w, opts = {}) {
  const { transit, user, at } = w;
  const stations = [];
  for (let i = 0; i < NODES; i++) stations.push(transit.createStation(user, { name: 'S' + i, kind: 'rail', ...at(i) }).station.id);
  const line = transit.createLine(user, {
    name: opts.name || '测试线', kind: 'rail', stops: stations, schedule: opts.schedule || null,
  }).line;
  const vehicles = [];
  for (let i = 0; i < (opts.vehicles == null ? 1 : opts.vehicles); i++) {
    vehicles.push(transit.createVehicle(user, { kind: opts.kind || 'metro_b4', lineId: line.id }).vehicle);
  }
  return { line, stations, vehicles, cache: transit.lineCache.get(line.id) };
}

/**
 * 让游戏时间走 gameSec 游戏秒。
 * 时间基准：×1 = 现实 1 秒 = 游戏 1 秒；本文件默认 **1 游戏秒一小步**（9000 ms 的 tick 会切成 3000 ms，
 * 但我们的到站判定误差只在"一小步"的量级上，用 1 秒步长量出来的都是真实的到站时刻）。
 */
function run(transit, gameSec, chunkMs = 1000) {
  let done = 0;
  let guard = 0;
  while (done < gameSec && guard++ < 200000) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

/** 一直推进到 pred() 为真（或超时），返回是否成功 */
function runUntil(transit, pred, maxGameSec, chunkMs = 1000) {
  let done = 0;
  while (done < maxGameSec) {
    if (pred()) return true;
    transit.tick(chunkMs);
    done += (chunkMs * transit.speed) / 1000;
  }
  return !!pred();
}

/** 记录每一次进站（车、站、当时游戏时刻） */
function watchArrivals(transit) {
  const arrivals = new Map();     // `${vehicleId}:${stationId}` -> 第一次到站时刻
  const orig = transit._dock.bind(transit);
  transit._dock = (vehicle, cache, rt, path, stop) => {
    const key = vehicle.id + ':' + stop.stationId;
    if (!arrivals.has(key)) arrivals.set(key, transit.clockMs);
    return orig(vehicle, cache, rt, path, stop);
  };
  return arrivals;
}

const lineDelay = (transit, lineId) => transit.linePublic(transit._st.line.get(lineId));
const trainOf = (transit, vehicleId) => transit.snapshot().trains.find((t) => t.id === vehicleId);
const vehOf = (transit, vehicleId) => transit.vehiclePublic(transit._st.vehicle.get(vehicleId));

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 自由发车逐站预测 + 晚点系统 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ============ 1. 自由发车也要有"后续每一站几点到、几点发" ============ */
  console.log('▶ 1. 自由发车：remainingStops（后续每一站的到站/发车时刻）');
  {
    const w = makeWorld();
    const { transit, user } = w;
    const { line, stations, vehicles, cache } = makeLine(w);
    const veh = vehicles[0];
    const rt = transit._runtimeFor(veh.id);
    transit.speed = 1;
    const arrivals = watchArrivals(transit);

    const linePub0 = lineDelay(transit, line.id);
    check('自由发车线确实"没有班次表"（runs / stopsEta 都是空的 —— 这就是要补的缺口）',
      linePub0.schedule.mode === 'free' && linePub0.runs.length === 0 && linePub0.stopsEta.length === 0,
      `mode=${linePub0.schedule.mode} runs=${linePub0.runs.length} stopsEta=${linePub0.stopsEta.length}`);

    // 跑到"刚离开第 2 站"的瞬间取样（这时候后面还有 10 站）
    const okSample = runUntil(transit, () => rt.state === 'run' && rt.distance > cache.stops[1].distance + 5, 4000);
    const snap = transit.snapshot();
    const train = snap.trains.find((t) => t.id === veh.id);
    const pub = snap.vehicles.find((v) => v.id === veh.id);
    const rem = train.remainingStops;
    check('取到了取样点（车刚离开第 2 站，后面还有 10 站）', okSample && rem.length === 10,
      `位置 ${train.distance}m / remainingStops ${rem.length} 条`);

    check('remainingStops 每一站都带站号/站名/线路里程/到站时刻/发车时刻/状态',
      rem.every((r) => Number.isFinite(r.stationId) && typeof r.name === 'string'
        && Number.isFinite(r.distanceM) && Number.isFinite(r.etaGameMs) && Number.isFinite(r.etdGameMs)
        && ['served', 'next', 'pending'].includes(r.state)),
      JSON.stringify(rem[0]));
    check('站序与线路一致（第 2 站是 next，其余 pending，里程递增）',
      rem[0].state === 'next' && rem.slice(1).every((r) => r.state === 'pending')
      && rem.every((r, i) => i === 0 || r.distanceM > rem[i - 1].distanceM)
      && rem[rem.length - 1].stationId === stations[stations.length - 1],
      rem.map((r) => `${r.name}:${r.state}`).join(' '));
    check('中间站停 30 秒、末站停 50 秒（30 中间 + 20 整备）：etd − eta = 停站时间',
      rem.slice(0, -1).every((r) => r.etdGameMs - r.etaGameMs === DWELL * 1000)
      && rem[rem.length - 1].etdGameMs - rem[rem.length - 1].etaGameMs === (DWELL + TERMINAL_DWELL) * 1000,
      `中间 ${rem[0].etdGameMs - rem[0].etaGameMs}ms / 末站 ${rem[rem.length - 1].etdGameMs - rem[rem.length - 1].etaGameMs}ms`);
    check('到站时刻是绝对游戏时钟（从现在往后递增，且与 etaSeconds 对得上）',
      rem.every((r, i) => i === 0 || r.etaGameMs > rem[i - 1].etdGameMs - 1)
      && Math.abs((rem[0].etaGameMs - transit.clockMs) / 1000 - train.etaSeconds) <= 1,
      `下一站 ${Math.round((rem[0].etaGameMs - transit.clockMs) / 1000)}s vs etaSeconds ${train.etaSeconds}`);

    // 同一份数据在 trains[] 与 vehicles[] 上都有（客户端两个面板都读得到）
    check('逐站预测同时挂在快照的 trains[] 与 vehicles[] 上（客户端两处都能用）',
      Array.isArray(train.remainingStops) && Array.isArray(pub.remainingStops) && pub.remainingStops.length === rem.length,
      `trains ${train.remainingStops.length} 条 / vehicles ${pub.remainingStops.length} 条`);

    // 缓存：同一趟、刷新窗口内重复取是同一个数组（"只在换趟/办完一站/每 N 秒重算"）
    const vehRow = transit._st.vehicle.get(veh.id);
    const r1 = transit._remainingStops(cache, rt, vehRow);
    const r2 = transit._remainingStops(cache, rt, vehRow);
    check('便宜：刷新窗口内重复取逐站预测是**同一个数组**（不重算）',
      r1 === r2 && r1 === rem, `同一引用=${r1 === r2}`);
    transit._dropRemainingStops(rt);
    const r3 = transit._remainingStops(cache, rt, vehRow);
    check('办完一站 / 换一趟时缓存作废（重算出新数组，内容仍然对）',
      r3 !== r1 && r3.length === rem.length && r3[0].state === 'next',
      `${r3.length} 条，第一条 ${r3[0].name}/${r3[0].state}`);

    // ★ 验收：预告到站时刻 vs 实际到站时刻
    const predictAt = rem.map((r) => ({ stationId: r.stationId, name: r.name, eta: r.etaGameMs }));
    runUntil(transit, () => arrivals.has(veh.id + ':' + stations[stations.length - 1]), 4000);
    const errs = predictAt.map((p) => {
      const act = arrivals.get(veh.id + ':' + p.stationId);
      return { name: p.name, err: act == null ? null : (act - p.eta) / 1000 };
    });
    const worst = errs.reduce((m, e) => (e.err == null || Math.abs(e.err) <= Math.abs(m) ? m : e.err), 0);
    check('★ 预告的到站时刻与**实际到站时刻**一致（每一站误差 ≤ 2 游戏秒）',
      errs.every((e) => e.err != null && Math.abs(e.err) <= 2),
      errs.map((e) => `${e.name}:${e.err == null ? '未到' : e.err.toFixed(2)}s`).join(' ') + ` / 最差 ${worst.toFixed(2)}s`);

    // 停站时报 'served'：到站时刻 = 实际进站时刻，发车时刻 = 停站结束
    // （等到它在**中间站**停靠时再看 —— 末站后面没有下一站，看不出 next/pending 的衔接）
    runUntil(transit, () => rt.state === 'dwell' && rt.lastServedStation !== stations[NODES - 1], 6000);
    const during = transit._remainingStops(cache, rt, transit._st.vehicle.get(veh.id));
    check('正在站台上上下客时，这一站是 served（到站时刻 = 实际进站时刻，发车时刻 = 停站结束）',
      during.length && during[0].state === 'served' && during[0].stationId === rt.lastServedStation
      && during[0].etaGameMs === rt.servedAtMs && during[0].etdGameMs === rt.dwellUntil
      && during[1] && during[1].state === 'next',
      during.length ? `${during[0].name} served@${(during[0].etaGameMs / 1000).toFixed(0)}s 发${(during[0].etdGameMs / 1000).toFixed(0)}s，下一站 ${during[1].name}` : '没有 served 条目');
    check('自由发车也能算出偏差：没被耽误时是 0（准点），基准是"自编计划"',
      (() => { transit._tripInfo(transit._st.vehicle.get(veh.id), cache, rt); return rt.delaySource === 'self' && rt.delaySeconds === 0; })(),
      `delaySeconds=${rt.delaySeconds} source=${rt.delaySource}`);
    w.raw.close();
  }

  /* ============ 2. 一大批人上车 → 停站变长 → 晚点，之后一站站追回 ============ */
  console.log('\n▶ 2. 上下客多、停得久 → 晚点；靠运行余裕一站站追回');
  {
    // 400 个人上车、每人 0.3 秒（上限 90 秒）→ 这一站要多停 90 秒
    const w = makeWorld({ dwellPaxSeconds: 0.3, dwellPaxMax: 90 });
    const { transit } = w;
    const { line, stations, vehicles, cache } = makeLine(w);
    const veh = vehicles[0];
    const rt = transit._runtimeFor(veh.id);
    transit.speed = 1;
    // 第 2 站（idx 1）塞 400 个人（都去终点站）
    transit._addWaiting(stations[1], cache.queueCompanyId, cache.companyOwner, line.id, 400, transit.clockMs, stations[NODES - 1]);

    // 跑到"第 2 站办完、车重新跑起来"（那时这一站的偏差已经记下了）
    const okHeavy = runUntil(transit, () => rt.delayHistory.some((r) => r.cause === 'boarding'), 4000);
    const heavy = rt.delayHistory.find((r) => r.cause === 'boarding');
    const aggLate = lineDelay(transit, line.id);
    const fleetLate = transit.snapshot().stats.delay;
    check('一大批人上车：这一站停站时间远超计划（记录里带 dwellSeconds / plannedDwellSeconds）',
      okHeavy && heavy.dwellSeconds > heavy.plannedDwellSeconds + 60 && heavy.blockedSeconds === 0,
      heavy ? `${heavy.name} 停 ${heavy.dwellSeconds}s / 计划 ${heavy.plannedDwellSeconds}s，上客后 ${heavy.departureMs - transit.clockMs}ms` : '没有 boarding 记录');
    check('晚点的成因如实写成 boarding（上下客多），偏差是正数（晚点）',
      !!heavy && heavy.cause === 'boarding' && heavy.delaySeconds > 60,
      heavy ? `cause=${heavy.cause} delaySeconds=${heavy.delaySeconds}` : '');
    check('车上的 delaySeconds 与记录一致，且超过准点阈值（60 秒）',
      rt.delaySeconds > 60 && Math.round(rt.delaySeconds) === heavy.delaySeconds && rt.peakDelaySeconds >= rt.delaySeconds,
      `delaySeconds=${rt.delaySeconds} peak=${rt.peakDelaySeconds}`);
    check('线路汇总反映了这次晚点：onTimeRate=0、有 1 辆车晚点、平均/最大晚点 = 这辆车的偏差',
      aggLate.onTimeRate === 0 && aggLate.delay.lateVehicles === 1 && aggLate.delay.tracked === 1
      && aggLate.maxDelaySeconds === Math.round(rt.delaySeconds) && aggLate.avgDelaySeconds === Math.round(rt.delaySeconds),
      `onTimeRate=${aggLate.onTimeRate} avg=${aggLate.avgDelaySeconds} max=${aggLate.maxDelaySeconds} late=${aggLate.delay.lateVehicles}`);
    check('快照里的全网汇总（stats.delay）也对得上',
      fleetLate.tracked === 1 && fleetLate.lateVehicles === 1 && fleetLate.maxDelaySeconds === Math.round(rt.delaySeconds),
      JSON.stringify(fleetLate));

    // 之后每一站偏差都要变小（在追回），直到回到准点阈值以内
    const okRecover = runUntil(transit, () => rt.recovered === true, 4000);
    const after = rt.delayHistory.slice(rt.delayHistory.findIndex((r) => r.cause === 'boarding'));
    const trail = after.map((r) => r.delaySeconds);
    const monotone = trail.every((v, i) => i === 0 || v <= trail[i - 1]);
    check('★ 晚点之后一站站变小（运行余裕把时间追回来）',
      okRecover && monotone && trail[trail.length - 1] < trail[0],
      `${trail.join(' → ')}`);
    check('追回过程被标成 recovering，并且最后 recovered=true + recoveredSeconds>0',
      rt.recovered === true && rt.delaySeconds <= transit._onTimeSeconds() && rt.recoveredSeconds > 0
      && after.some((r) => r.cause === 'recovered'),
      `delaySeconds=${rt.delaySeconds} trend=${rt.delayTrend} recovered=${rt.recovered} recoveredSeconds=${rt.recoveredSeconds}`);
    const aggBack = lineDelay(transit, line.id);
    check('追回来以后线路汇总也回到准点：onTimeRate=1、recoveredVehicles=1、平均晚点回到阈值以内',
      aggBack.onTimeRate === 1 && aggBack.delay.recoveredVehicles === 1
      && aggBack.avgDelaySeconds <= transit._onTimeSeconds(),
      `onTimeRate=${aggBack.onTimeRate} avg=${aggBack.avgDelaySeconds} recovered=${aggBack.delay.recoveredVehicles}`);
    w.raw.close();
  }

  /* ============ 3. 被前车压着走 → 后车晚点，前车让开以后追回 ============ */
  console.log('\n▶ 3. 被前车压着（_enforceSpacing）→ 后车晚点，之后就追回来');
  {
    const w = makeWorld();
    const { transit, user } = w;
    const { line, stations, vehicles, cache } = makeLine(w, { vehicles: 2 });
    const [vehA, vehB] = vehicles;
    transit.speed = 1;
    transit.tick(1000);                                  // 两辆车都上线
    const rtA = transit._runtimeFor(vehA.id);
    const rtB = transit._runtimeFor(vehB.id);
    const rowA = transit._st.vehicle.get(vehA.id);
    const rowB = transit._st.vehicle.get(vehB.id);

    // 前车正停在第 3 站上，而且要在站上压很久（现实中就是上下客多 / 前车占着站台，
    // 场景 2 已经证明"上下客多"是怎么把停站时间拉长的，这里只关心后车被压住的后果）
    transit._dock(rowA, cache, rtA, cache.path, cache.stops[2]);
    rtA.dwellUntil = transit.clockMs + 300000;
    // 后车摆回首站，先办一次首站的客（本趟的自编计划就在这里锚定）
    rtB.distance = 0; rtB.speed = 0; rtB.direction = 1; rtB.needsServeAtStart = true;
    rtB.parkedAt = null; rtB.parkedIds = null;
    run(transit, 2);
    check('后车在首站办完客：本趟计划从首站锚定（起点站有一条发车记录）',
      rtB.delayHistory.length === 1 && rtB.delayHistory[0].origin === true && rtB.delaySeconds === 0,
      JSON.stringify(rtB.delayHistory[0]));

    // 跑到后车第一次带着"被前车压住"的记录进站
    const okBlocked = runUntil(transit, () => rtB.delayHistory.some((r) => r.cause === 'blocked'), 4000);
    const blockedRec = rtB.delayHistory.find((r) => r.cause === 'blocked');
    const gapAt = Math.abs(rtA.distance - rtB.distance);
    check('后车确实被前车压住了（记录里 blockedSeconds > 0，且它一直没越过前车）',
      okBlocked && blockedRec.blockedSeconds > 30 && rtB.distance <= rtA.distance + 1
      && gapAt >= transit.config.minGapMeters - 1,
      blockedRec ? `${blockedRec.name} 被压 ${blockedRec.blockedSeconds}s，两车净距 ${gapAt.toFixed(0)}m` : '没有 blocked 记录');
    check('★ 被前车压着 → 记成晚点：成因 blocked、delaySeconds 是正数且超过准点阈值',
      blockedRec.cause === 'blocked' && blockedRec.delaySeconds > 60 && Math.round(rtB.delaySeconds) === blockedRec.delaySeconds,
      `cause=${blockedRec.cause} delaySeconds=${blockedRec.delaySeconds} 被压=${blockedRec.blockedSeconds}s`);

    const lineLate = lineDelay(transit, line.id);
    const trainB = trainOf(transit, vehB.id);
    check('线路汇总与快照里都带上了这条晚点（trains[] 也有 delaySeconds / delayTrend / recovered）',
      lineLate.maxDelaySeconds >= blockedRec.delaySeconds && lineLate.delay.lateVehicles >= 1
      && trainB.delaySeconds === Math.round(rtB.delaySeconds) && typeof trainB.delayTrend === 'string'
      && trainB.recovered === false && trainB.delaySource === 'self',
      `line max=${lineLate.maxDelaySeconds} late=${lineLate.delay.lateVehicles} / train delay=${trainB.delaySeconds} trend=${trainB.delayTrend} src=${trainB.delaySource}`);

    // 前车摘下线路（玩家可以随时把车撤下来）：后车不再被压，可以按自己的能力追回时间
    transit.updateVehicle(user, { id: vehA.id, lineId: null });
    check('前车被摘下线路后不再约束后车（_enforceSpacing 只约束同一条线上的同方向车）',
      transit._st.vehicle.get(vehA.id).line_id === null && !transit.runtime.has(vehA.id),
      `前车 lineId=${transit._st.vehicle.get(vehA.id).line_id}`);

    const peak = rtB.peakDelaySeconds;
    const okRecover = runUntil(transit, () => rtB.recovered === true, 8000);
    const tail = rtB.delayHistory.slice(rtB.delayHistory.findIndex((r) => r.cause === 'blocked')).map((r) => r.delaySeconds);
    check('★ 前车让开以后，偏差一站站变小并最终追回（recovered=true）',
      okRecover && rtB.recovered === true && rtB.delaySeconds <= transit._onTimeSeconds()
      && tail[tail.length - 1] < tail[0] && tail.every((v, i) => i === 0 || v <= tail[i - 1]),
      `峰值 ${peak}s → 现在 ${rtB.delaySeconds}s（${tail.join(' → ')}）`);
    check('delayTrend 说得出"在追回"，recoveredSeconds = 峰值 − 当前',
      rtB.delayTrend === 'recovering' && rtB.recoveredSeconds >= peak - rtB.delaySeconds - 1 && rtB.recoveredSeconds > 0,
      `trend=${rtB.delayTrend} recoveredSeconds=${rtB.recoveredSeconds}（峰值 ${peak}s）`);
    const lineBack = lineDelay(transit, line.id);
    check('线路汇总回到准点：onTimeRate=1、recoveredVehicles=1',
      lineBack.onTimeRate === 1 && lineBack.delay.recoveredVehicles === 1 && lineBack.delay.tracked === 1,
      `onTimeRate=${lineBack.onTimeRate} tracked=${lineBack.delay.tracked} recovered=${lineBack.delay.recoveredVehicles}`);

    // 逐站历史：每一站都能看到实际/计划时刻、停站时间与成因
    const hist = vehOf(transit, vehB.id).delayHistory;
    check('逐站历史（vehicles[].delayHistory）给出实际/计划到站发车时刻、停站时间与成因',
      hist.length > 0 && hist.every((r) => Number.isFinite(r.arrivalMs) && Number.isFinite(r.plannedArrivalMs)
        && Number.isFinite(r.departureMs) && Number.isFinite(r.plannedDepartureMs)
        && /^\d{2}:\d{2}$/.test(r.plannedDepartureTime) && /^\d{2}:\d{2}$/.test(r.departureTime)
        && Number.isFinite(r.delaySeconds) && typeof r.cause === 'string' && typeof r.source === 'string'),
      hist.length ? `最近一条：${hist[hist.length - 1].name} ${hist[hist.length - 1].cause} 计划${hist[hist.length - 1].plannedDepartureTime}→实际${hist[hist.length - 1].departureTime}（${hist[hist.length - 1].delaySeconds}s）` : '空');
    w.raw.close();
  }

  /* ============ 4. 服役时间（createdAt）与今日里程（dayKm） ============ */
  console.log('\n▶ 4. vehicles[].createdAt / dayKm（客户端原来这两格是"—"）');
  {
    const w = makeWorld();
    const { transit } = w;
    const { line, vehicles } = makeLine(w);
    const veh = vehicles[0];
    const rt = transit._runtimeFor(veh.id);
    transit.speed = 1;
    const t0 = Date.now();
    run(transit, 600);

    const pub = vehOf(transit, veh.id);
    const train = trainOf(transit, veh.id);
    const row = transit._st.vehicle.get(veh.id);
    check('vehicles[].createdAt = 车辆建档时刻（真实时间戳，不是"—"）',
      Number.isFinite(pub.createdAt) && pub.createdAt > 0 && Math.abs(pub.createdAt - row.created_at) < 1
      && pub.createdAt <= t0 + 1000 && pub.createdAt >= t0 - 60000,
      `createdAt=${pub.createdAt}（${new Date(pub.createdAt).toISOString()}）`);
    check('快照的 trains[] / vehicles[] 都带 createdAt 与 dayKm',
      train.createdAt === pub.createdAt && train.dayKm === pub.dayKm,
      `trains ${train.createdAt}/${train.dayKm} vs vehicles ${pub.createdAt}/${pub.dayKm}`);
    check('dayKm = 这辆车今天跑的公里数（>0，且与车上累计里程一致：没有跨天）',
      pub.dayKm > 0 && Math.abs(pub.dayKm - Math.round(rt.lifetimeKm * 10) / 10) < 0.05,
      `今日 ${pub.dayKm} km / 累计 ${rt.lifetimeKm.toFixed(2)} km`);
    const beforeDay = pub.dayKm;
    check('dayKm 随行驶单调增长（再跑一段就更大）',
      (() => { run(transit, 300); return vehOf(transit, veh.id).dayKm > beforeDay; })(),
      `${beforeDay} km → ${vehOf(transit, veh.id).dayKm} km`);

    // 跨天：把时钟推到第 1 天最后一刻再走一小步 → "今天"变成第 2 天
    const kmBefore = vehOf(transit, veh.id).dayKm;
    const lifeBefore = rt.lifetimeKm;
    transit.clockMs = 86400000 - 3000;
    run(transit, 600);
    const pubNext = vehOf(transit, veh.id);
    check('跨天以后 dayKm 从 0 重新开始，累计里程继续涨（"今天跑的" ≠ "一共跑的"）',
      transit.day === 2 && pubNext.dayKm < kmBefore && pubNext.dayKm > 0 && rt.lifetimeKm > lifeBefore,
      `第 ${transit.day} 天：今日 ${pubNext.dayKm} km（上一天 ${kmBefore} km）/ 累计 ${rt.lifetimeKm.toFixed(2)} km`);
    check('运行状态里的 dayKmDay 跟着游戏日走（懒重置，不用每天遍历车队）',
      rt.dayKmDay === transit.day, `dayKmDay=${rt.dayKmDay} day=${transit.day}`);
    w.raw.close();
  }

  /* ============ 5. 班次车（headway）走同一套：计划来自时刻表 ============ */
  console.log('\n▶ 5. 班次车也报逐站预测，但偏差是拿**时刻表**比的');
  {
    const w = makeWorld();
    const { transit } = w;
    // 首班 60 秒（00:01），每 600 秒一班
    const { line, vehicles } = makeLine(w, { schedule: { mode: 'headway', headwaySec: 600, firstSec: 60, lastSec: 3600 } });
    const veh = vehicles[0];
    const rt = transit._runtimeFor(veh.id);
    transit.speed = 1;
    transit.tick(1000);        // 让车先进入"首站等点发车"的状态（state='scheduled'）
    const before = transit.snapshot().trains.find((t) => t.id === veh.id);
    check('等点发车时就报"下一站 = 首站"，remainingStops 里首站是 served（发车时刻 = 计划发车时刻）',
      before.remainingStops.length > 0 && before.remainingStops[0].state === 'served'
      && before.remainingStops[0].stationId === transit.lineCache.get(line.id).stops[0].stationId
      && before.remainingStops[0].etdGameMs === Math.round(rt.departureMs),
      `首条 ${before.remainingStops[0].name}/${before.remainingStops[0].state} 发车=${before.remainingStops[0].etdGameMs} 计划=${rt.departureMs}`);

    const okRun = runUntil(transit, () => rt.runActive === true && rt.distance > 100, 2000);
    const train = trainOf(transit, veh.id);
    check('正班跑起来以后：偏差的基准是时刻表（delaySource=timetable），偏差是数字且准点',
      okRun && train.delaySource === 'timetable' && Number.isFinite(train.delaySeconds)
      && Math.abs(train.delaySeconds) <= transit._onTimeSeconds() && train.recovered === false,
      `delaySeconds=${train.delaySeconds} source=${train.delaySource} peak=${train.peakDelaySeconds}`);
    const linePub = lineDelay(transit, line.id);
    check('班次车的 linePublic 仍然给 #18 的班次信息（runs / stopsEta 有值），另外多了准点汇总',
      linePub.runs.length > 0 && linePub.stopsEta.length > 0 && linePub.onTimeRate === 1
      && linePub.delay.tracked === 1 && linePub.delay.onTimeSeconds === transit._onTimeSeconds(),
      `runs=${linePub.runs.length} stopsEta=${linePub.stopsEta.length} onTimeRate=${linePub.onTimeRate}`);
    check('班次车的逐站预测与 station 顺序一致（remainingStops 覆盖后面每一站）',
      train.remainingStops.length === NODES - 1 && train.remainingStops.every((r, i) => i === 0 || r.distanceM > train.remainingStops[i - 1].distanceM),
      `${train.remainingStops.length} 站：${train.remainingStops.map((r) => r.name).join(' ')}`);
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
