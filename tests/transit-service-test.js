'use strict';
/**
 * 运营服务相关的四项功能专项测试（不需要那份 500MB 的北京数据集，跑得很快）：
 *
 *   node tests/transit-service-test.js
 *
 * ① **一键暂停运营**（transit op `line.setService { id, running }`）：
 *      暂停 → **不再发新车**；已经在路上的车把这一趟跑完（含从末站回场到首站）再停在首站；
 *      不删车、不藏车、不瞬移；站台上等车的人一个不动（继续按耐心规则等）。
 *      恢复 → 按班次表重新排"现在这一刻之后的下一班"（相当于时钟刚走到下一班），之后照常发车。
 *      对外：linePublic().service.paused / noServiceNow / reason='paused'。
 * ② **每个班次指定车辆**（schedule.assignments）：
 *      schedule = { mode, headwaySec|times, assignments:[{runIndex, vehicleId}] }（也认 [runIndex, vehicleId]）
 *      派车时优先满足指定车；指定车在别处忙 / 已被删 → 那一班退回默认轮转，
 *      并把没满足的班次记进 linePublic().schedule.assignmentsMissed。
 *      每一班都带 index / departure / vehicleId（+ pinnedVehicleId / assignmentMissed），供客户端画选择器。
 * ③ **线路归属转移**（transit op `line.transfer { id, companyId, withVehicles? }`）：
 *      线路（可选连同线上的车）转到别家公司名下；目标公司不存在 → 明确的中文错误；
 *      撤销一步回到原来的公司。
 * ④ （#1 车站去归属的验收在 transit-collab-test.js / transit-boarding-test.js 里，
 *     本文件只顺带确认它没有把暂停 / 指定车这些线路功能带坏。）
 *
 * 世界是人造底图（与 transit-delay-test.js 同一套做法）：12 个节点、间距 ≈ 854 米的一条直线，
 * 车站取第 0 / 4 / 8 号节点（三个站、两个区间，一趟往返 ≈ 16 游戏分钟，方便把"这一趟跑完"跑出来）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-service-test');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.01;        // ≈ 854 米一个节点
const NODES = 12;
const RAIL_BASE = 1000;
const RAIL_WAY = 500;
const STOP_NODES = [0, 4, 8]; // 车站就在这三号节点上

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
    config: Object.assign({
      dwellSeconds: 30, terminalDwellSeconds: 20,
      // 本文件只关心"调度"，不要自动客流：需要人排队时自己往站台上放
      patienceSeconds: 1000000, cohortSeconds: 30, tripRatePerDay: 0,
    }, config || {}),
  });
  const userA = { id: 'u-owner', name: '车主', color: '#e6194b' };
  const userB = { id: 'u-other', name: '别人', color: '#2b8cbe' };
  const companyA = transit.ensureCompany(userA);
  const companyB = transit.ensureCompany(userB);
  const at = (nodeIdx) => ({ lat: LAT, lon: lonOf(nodeIdx) });
  return { raw, db, rail, road, transit, userA, userB, companyA, companyB, at };
}

/**
 * 让游戏时间走 gameSec 游戏秒（20 倍速：一小步仍然是 3 游戏秒，
 * 所以轨迹与 ×1 完全一致，只是不用等 20 倍的墙钟时间）。
 */
function run(transit, gameSec, chunkMs = 3000) {
  let done = 0;
  let guard = 0;
  while (done < gameSec && guard++ < 200000) {
    const chunk = Math.min(chunkMs, Math.max(1, Math.ceil(((gameSec - done) * 1000) / transit.speed)));
    transit.tick(chunk);
    done += (chunk * transit.speed) / 1000;
  }
}

/** 一直推进到 pred() 为真（或超时），返回是否成功 */
function runUntil(transit, pred, maxGameSec, chunkMs = 3000) {
  let done = 0;
  let guard = 0;
  while (done < maxGameSec && guard++ < 200000) {
    if (pred()) return true;
    const chunk = Math.min(chunkMs, Math.max(1, Math.ceil((chunkMs * 1000) / transit.speed)));
    transit.tick(chunk);
    done += (chunk * transit.speed) / 1000;
  }
  return !!pred();
}

/** 记录每一次"到点发车"（_scheduleStep 返回 'depart'）：发车时刻与车 */
function watchDepartures(transit) {
  const list = [];
  const orig = transit._scheduleStep.bind(transit);
  transit._scheduleStep = (vehicle, cache, rt) => {
    const r = orig(vehicle, cache, rt);
    if (r === 'depart') list.push({ vehicleId: vehicle.id, atMs: transit.clockMs, plannedMs: rt.scheduledDepartureMs });
    return r;
  };
  return list;
}

/** 造一条线 + n 辆车（车站是 3 个固定节点），并把车都摆到首站上（不要开局均匀铺开） */
function makeLine(w, opts = {}) {
  const { transit, userA, at } = w;
  const stations = STOP_NODES.map((n, i) => transit.createStation(userA, { name: 'S' + i, kind: 'rail', ...at(n) }).station.id);
  const line = transit.createLine(userA, {
    name: opts.name || '测试线', kind: 'rail', stops: stations, schedule: opts.schedule || null,
  }).line;
  const vehicles = [];
  for (let i = 0; i < (opts.vehicles == null ? 1 : opts.vehicles); i++) {
    vehicles.push(transit.createVehicle(userA, { kind: 'metro_b4', lineId: line.id }).vehicle);
  }
  const cache = transit.lineCache.get(line.id);
  for (const v of vehicles) {
    const rt = transit._runtimeFor(v.id);
    if (!rt) continue;
    rt.distance = 0;                 // 别用"多车间均匀铺开"的开局位置：本文件要看清"谁在跑"
    rt.lat = cache.path[0].lat;
    rt.lon = cache.path[0].lon;
  }
  return { line, stations, vehicles, cache };
}

const linePub = (transit, lineId) => transit.linePublic(transit._st.line.get(lineId));
const vehPub = (transit, id) => transit.vehiclePublic(transit._st.vehicle.get(id));
/** "HH:MM:SS" 之类的当天秒数（断言"发车时刻落在班次表上"用） */
const secOfDay = (ms) => Math.round((ms % 86400000) / 1000);

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 暂停运营 / 每班指定车辆 / 线路归属转移 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ============ 1. 一键暂停运营：不发新车，在途车跑完这一趟 ============ */
  console.log('▶ 1. line.setService { running:false }：暂停运营（不发新车，在途车把这一趟跑完）');
  {
    const w = makeWorld();
    const { transit } = w;
    const { line, stations, vehicles } = makeLine(w, {
      vehicles: 2,
      schedule: { mode: 'headway', headwaySec: 600, firstSec: 60, lastSec: 7200 },
    });
    const [vehA, vehB] = vehicles;
    const cache = transit.lineCache.get(line.id);
    transit.speed = 20;
    const departures = watchDepartures(transit);

    // 先确认它是**正常运营**的样子：没有暂停、有下一班、班次表在跑
    const before = linePub(transit, line.id);
    check('暂停之前：service.paused=false、有下一班发车时刻（班次表正常在跑）',
      before.service.paused === false && before.service.reason !== 'paused'
        && Number.isFinite(before.service.nextDepartureSec) && before.runs.length > 0,
      `paused=${before.service.paused} reason=${before.service.reason} 下一班=${before.service.nextDeparture} runs=${before.runs.length}`);

    // 跑到"第一辆车已经在路上"（首班 60 秒发车，跑一趟往返约 16 游戏分钟）
    const running = runUntil(transit, () => {
      const rt = transit.runtime.get(vehA.id);
      return !!rt && rt.runActive === true && rt.distance > 100;
    }, 900);
    const rtA = transit.runtime.get(vehA.id);
    const rtB = transit.runtime.get(vehB.id);
    check('取到取样点：第一辆车已经发车在路上，第二辆车还在首站等自己的班次',
      running && departures.length >= 1 && departures[0].vehicleId === vehA.id
        && rtB.runActive === false && rtB.distance === 0,
      `发车 ${departures.map((d) => `#${d.vehicleId}@${Math.round(d.atMs / 1000)}s`).join(' ')} / A 在 ${Math.round(rtA.distance)} 米处，B 在首站`);

    // 站台上放一批等车的人（暂停期间他们必须一个不少地继续等）
    transit._addWaiting(stations[0], cache.queueCompanyId, cache.companyOwner, line.id, 8, transit.clockMs, stations[2]);
    const waitingBefore = transit.stationWaiting(stations[0]).waiting;
    const departuresBefore = departures.length;
    const fleetBefore = transit._st.allVehicles.all().length;

    // ── 暂停运营 ──
    const paused = transit.apply(w.userA, { k: 'line.setService', id: line.id, running: false });
    const svc = paused.service;
    check('line.setService { running:false } 之后：service.paused=true、noServiceNow=true、reason=paused、没有下一班',
      paused.changed === true && svc.paused === true && svc.noServiceNow === true && svc.reason === 'paused'
        && svc.nextDeparture === null && svc.nextDepartureMs === null,
      `paused=${svc.paused} noServiceNow=${svc.noServiceNow} reason=${svc.reason} 下一班=${svc.nextDeparture} note=${svc.note}`);
    check('暂停状态写进了线路行（service_paused 落库，重启也不会丢）',
      Number(transit._st.line.get(line.id).service_paused) === 1 && transit.lineCache.get(line.id).paused === true,
      `service_paused=${transit._st.line.get(line.id).service_paused}`);

    // 在途的车把这一趟跑完（往返 ≈ 16 游戏分钟），期间一辆新车都不许发
    const finished = runUntil(transit, () => rtA.runActive === false && rtA.distance === 0, 3000);
    run(transit, 1200);      // 再多跑 20 分钟：暂停期间一直都不该有新车发出
    check('在途的车把这一趟跑完了（回到首站、停在首站上，没有被删、没有瞬移）',
      finished && rtA.runActive === false && rtA.distance === 0 && rtA.speed === 0 && rtA.state === 'paused'
        && !!transit._st.vehicle.get(vehA.id),
      `A 在 ${Math.round(rtA.distance)} 米 / state=${rtA.state} / speed=${rtA.speed} / 里程 ${rtA.lifetimeKm.toFixed(2)}km`);
    check('暂停期间**一辆新车都没有发出**（发车记录停在暂停那一刻）',
      departures.length === departuresBefore,
      `暂停前 ${departuresBefore} 次发车 → 现在 ${departures.length} 次`);
    check('两辆车都还在、也都在线上（不删车、不藏车：快照里照样看得到它们）',
      transit._st.allVehicles.all().length === fleetBefore
        && transit.lineCache.get(line.id).vehicleIds.length === 2
        && transit.snapshot().vehicles.filter((v) => v.lineId === line.id).length === 2,
      `车队 ${fleetBefore} → ${transit._st.allVehicles.all().length} / 线上 ${transit.lineCache.get(line.id).vehicleIds.length} 辆`);
    // 站台上等车的人：**一个都不能丢**。暂停期间他们要么还站在站台上等（耐心计时继续走），
    // 要么被"跑完这一趟"的那辆车顺路拉上车（那一趟本来就要停首站，不是新的发车）。
    const waitingNow = transit.stationWaiting(stations[0]).waiting;
    const onboardNow = [vehA, vehB].reduce((s, v) => {
      const rt = transit.runtime.get(v.id);
      return s + (rt && rt.load ? Math.round(rt.load) : 0);
    }, 0);
    check('站台上等车的人一个都没丢（没有变成"放弃离开"：还在等 + 被跑完这一趟的车拉走 = 原来的 8 人）',
      transit.stationWaiting(stations[0]).lost === 0 && waitingNow + onboardNow === waitingBefore,
      `等车 ${waitingNow} 人 + 车上 ${onboardNow} 人 = ${waitingNow + onboardNow}（暂停前 ${waitingBefore} 人）/ 放弃 ${transit.stationWaiting(stations[0]).lost} 人`);

    /* ============ 2. 恢复运营：按班次表重新排"现在之后的下一班" ============ */
    console.log('\n▶ 2. line.setService { running:true }：恢复运营（按班次表重新排下一班）');
    const clockBeforeResume = transit.clockMs;
    const resume = transit.apply(w.userA, { k: 'line.setService', id: line.id, running: true });
    check('恢复之后：service.paused=false，两辆车都重新排上了"现在这一刻之后的下一班"',
      resume.changed === true && resume.service.paused === false
        && [rtA, rtB].every((rt) => rt.departureMs != null && rt.departureMs >= clockBeforeResume
          && (secOfDay(rt.departureMs) - 60) % 600 === 0),
      `A 下一班 ${rtA.departureMs == null ? 'null' : secOfDay(rtA.departureMs) + 's'} / B 下一班 ${rtB.departureMs == null ? 'null' : secOfDay(rtB.departureMs) + 's'}（班次表：60s 起每 600s 一班）`);
    check('恢复之后 service 也回到"正常运营"：paused=false、reason 不是 paused、下一班有点',
      resume.service.paused === false && resume.service.reason !== 'paused'
        && Number.isFinite(resume.service.nextDepartureSec),
      `paused=${resume.service.paused} reason=${resume.service.reason} 下一班=${resume.service.nextDeparture}`);

    const beforeRestart = departures.length;
    const restarted = runUntil(transit, () => departures.length > beforeRestart, 3000);
    const first = departures[departures.length - 1];
    check('恢复运营后真的重新发车了，而且发车时刻落在班次表上（60s 起每 600s 一班）',
      restarted && first && (secOfDay(first.plannedMs) - 60) % 600 === 0 && first.plannedMs >= clockBeforeResume,
      restarted ? `#${first.vehicleId} 在 ${secOfDay(first.plannedMs)}s 发车（计划 ${secOfDay(first.plannedMs)}s）` : '等了 50 分钟都没有新车发出');
    const boarded = runUntil(transit, () => transit.stationWaiting(stations[0]).waiting === 0, 2000);
    check('恢复之后站台上的人都上车了（暂停期间他们一直在等，没有被丢掉）',
      boarded && transit.stationWaiting(stations[0]).waiting === 0,
      `等车 ${transit.stationWaiting(stations[0]).waiting} 人 / 放弃 ${transit.stationWaiting(stations[0]).lost} 人`);

    // 反复暂停 / 恢复：状态干净（不会卡着不发车，也不会连发两次）
    transit.apply(w.userA, { k: 'line.setService', id: line.id, running: false });
    const again = transit.apply(w.userA, { k: 'line.setService', id: line.id, running: false });
    check('重复暂停是幂等的（changed=false，状态不变、不报错）',
      again.changed === false && again.service.paused === true, `changed=${again.changed} paused=${again.service.paused}`);
    const undoPause = transit.apply(w.userA, { k: 'undo' });
    check('暂停 / 恢复都记在撤销栈上（撤销一步回到暂停之前的状态）',
      undoPause.undone === '暂停运营「测试线」' && linePub(transit, line.id).service.paused === false,
      `undo=${undoPause.undone} → paused=${linePub(transit, line.id).service.paused}`);
    w.raw.close();
  }

  /* ============ 3. 每个班次指定车辆（assignments） ============ */
  console.log('\n▶ 3. schedule.assignments：把某一班钉死在某辆车上，车忙就退回轮转');
  {
    const w = makeWorld();
    const { transit, userA } = w;
    const { line, vehicles } = makeLine(w, { vehicles: 2 });
    const [vehA, vehB] = vehicles;
    transit.speed = 20;
    // 默认轮转是"第 j 班给第 (j % 车数) 辆"→ 第 0 班本来是 vehA；这里故意把它指定给 vehB
    const schedule = {
      mode: 'headway', headwaySec: 600, firstSec: 60, lastSec: 7200,
      assignments: [{ runIndex: 0, vehicleId: vehB.id }, [2, vehA.id]],
    };
    const up = transit.apply(userA, { k: 'line.update', id: line.id, schedule });
    const pub = linePub(transit, line.id);
    check('assignments 写进了班次（两种写法都认：{runIndex,vehicleId} 与紧凑的 [runIndex,vehicleId]）',
      up.line.schedule.mode === 'headway' && JSON.stringify(up.line.schedule.assignmentsRequested) === '2'
        && transit._st.line.get(line.id) && JSON.parse(transit._st.line.get(line.id).schedule).assignments.length === 2,
      transit._st.line.get(line.id).schedule);
    check('linePublic().schedule 报出"指定了几个班次、几个没满足"（这次两个都满足）',
      pub.schedule.assignmentsRequested === 2 && pub.schedule.assignmentsMissed === 0,
      `requested=${pub.schedule.assignmentsRequested} missed=${pub.schedule.assignmentsMissed}`);
    const run0 = pub.runs.find((r) => r.index === 0);
    const run2 = pub.runs.find((r) => r.index === 2);
    check('每一班都带 index / departure / vehicleId（客户端据此画"每个班次指定车辆"的选择器）',
      !!run0 && run0.index === 0 && typeof run0.departure === 'string' && Number.isFinite(run0.departureMs)
        && run0.vehicleId === vehB.id && !!run2 && run2.vehicleId === vehA.id,
      pub.runs.slice(0, 3).map((r) => `#${r.index} ${r.departure} → ${r.vehicleName}`).join(' | '));
    check('指定车被优先满足：第 0 班给了 vehB（默认轮转本来会给 vehA），并且标出 pinnedVehicleId',
      run0.vehicleId === vehB.id && run0.pinnedVehicleId === vehB.id && run0.assignmentMissed === false
        && run0.vehicleName === vehB.name,
      `第 0 班 → ${run0.vehicleName}（指定 ${run0.pinnedVehicleId}，missed=${run0.assignmentMissed}）`);

    // 派车真的照做了：第 0 班发车的是 vehB
    const departures = watchDepartures(transit);
    const departed = runUntil(transit, () => departures.length > 0, 900);
    const rtA = transit.runtime.get(vehA.id);
    const rtB = transit.runtime.get(vehB.id);
    check('派车真的照做：第 0 班实际发车的是 vehB（vehA 还在首站等它自己的第 2 班）',
      departed && departures[0].vehicleId === vehB.id && rtB.runActive === true && rtA.distance === 0,
      departures.length ? `发车 #${departures[0].vehicleId}（vehB=#${vehB.id}）/ A 在 ${Math.round(rtA.distance)} 米` : '没有发车');

    // ── 指定车"忙着"（被改派到别的线路）→ 退回默认轮转 + assignmentsMissed ──
    // 用真正的另一条线（两个站）把 vehB 改派过去
    const s1 = transit.createStation(userA, { name: '别的站甲', kind: 'rail', ...w.at(0) }).station.id;
    const s2 = transit.createStation(userA, { name: '别的站乙', kind: 'rail', ...w.at(8) }).station.id;
    const line2 = transit.createLine(userA, { name: '2 号线', kind: 'rail', stops: [s1, s2] }).line;
    transit.apply(userA, { k: 'vehicle.update', id: vehB.id, lineId: line2.id });
    const pub2 = linePub(transit, line.id);
    const run0b = pub2.runs.find((r) => r.index === 0);
    check('指定车被改派到别的线路（在别处忙）→ 那一班退回默认轮转，但仍然记得玩家指定的是谁',
      run0b.vehicleId === vehA.id && run0b.pinnedVehicleId === vehB.id && run0b.assignmentMissed === true,
      `第 0 班 → #${run0b.vehicleId}（指定 #${run0b.pinnedVehicleId}，missed=${run0b.assignmentMissed}）`);
    check('linePublic().schedule 报出 assignmentsMissed（2 个指定里有 1 个没满足）',
      pub2.schedule.assignmentsRequested === 2 && pub2.schedule.assignmentsMissed === 1,
      `requested=${pub2.schedule.assignmentsRequested} missed=${pub2.schedule.assignmentsMissed}`);
    check('指定车不在这条线上时照样发车（不空等、也不让这一班消失）',
      run0b.vehicleId === vehA.id && pub2.runs.length > 0,
      `第 0 班 → ${run0b.vehicleName} / 未来 ${pub2.runs.length} 班`);

    // 指定车被删掉：同样退回轮转，原因记成 vehicle-gone
    transit.apply(userA, { k: 'vehicle.delete', id: vehB.id });
    const planGone = transit._runPlan(transit.lineCache.get(line.id));
    check('指定车被删掉 → 那一班照样退回默认轮转，原因记成 vehicle-gone（_runPlan 的明细分得清两种没满足）',
      planGone.missed.length === 1 && planGone.missed[0].reason === 'vehicle-gone'
        && planGone.missed[0].vehicleId === vehB.id && planGone.vehicles[0] === vehA.id,
      JSON.stringify(planGone.missed));

    // 指定表本身的校验：班次下标 / 车辆 id 不合法 → 明确的中文错误
    let bad = null;
    try { transit.apply(userA, { k: 'line.update', id: line.id, schedule: { mode: 'headway', headwaySec: 600, assignments: [{ runIndex: -1, vehicleId: 3 }] } }); }
    catch (err) { bad = err; }
    check('assignments 格式不合法会被拒绝（中文原因 + code=BAD_SCHEDULE）',
      !!bad && bad.code === 'BAD_SCHEDULE' && /runIndex/.test(bad.message),
      bad ? `${bad.message}（code=${bad.code}）` : '居然通过了');
    w.raw.close();
  }

  /* ============ 4. 线路归属转移（line.transfer） ============ */
  console.log('\n▶ 4. line.transfer：线路（可选带车）转到另一家公司名下，撤销能放回来');
  {
    const w = makeWorld();
    const { transit, userA, userB } = w;
    const { line, stations, vehicles } = makeLine(w, { vehicles: 2 });
    const cache = transit.lineCache.get(line.id);
    const [vehA, vehB] = vehicles;
    // 站台上放一批等这条线车的人（转移时他们必须跟着线路走，不然永远等不到车）
    transit._addWaiting(stations[0], cache.queueCompanyId, cache.companyOwner, line.id, 6, transit.clockMs, stations[2]);
    const waitingBefore = transit.stationWaiting(stations[0]).waiting;

    let bad = null;
    try { transit.apply(userB, { k: 'line.transfer', id: line.id, companyId: 999999 }); } catch (err) { bad = err; }
    check('目标公司不存在 → 明确的中文错误（code=NOTFOUND，不会自作主张新建公司）',
      !!bad && bad.code === 'NOTFOUND' && /目标公司不存在/.test(bad.message) && !transit._st.company.get(999999),
      bad ? `${bad.message}（code=${bad.code}）` : '居然通过了');

    const res = transit.apply(userB, { k: 'line.transfer', id: line.id, companyId: w.companyB.id, withVehicles: true });
    const row = transit._st.line.get(line.id);
    check('线路真的转到别人公司名下了（owner / company_id 都换，线路本身还在）',
      res.moved === true && row.owner === userB.id && row.company_id === w.companyB.id
        && res.line.companyId === w.companyB.id && res.line.stops.length === stations.length,
      `owner=${row.owner} company=${row.company_id} / 线路 #${row.id} 站 ${JSON.stringify(res.line.stops)}`);
    check('withVehicles:true 时线上的车一起转过去（owner / company_id 换、仍然跑这条线）',
      res.vehiclesMoved === 2
        && [vehA, vehB].every((v) => {
          const r = transit._st.vehicle.get(v.id);
          return r.owner === userB.id && r.company_id === w.companyB.id && r.line_id === line.id;
        }),
      `${res.vehiclesMoved} 辆车 → 公司 #${w.companyB.id}`);
    check('线路缓存跟着换运营公司（票款 / 上车结算从此记在新公司账上）',
      transit.lineCache.get(line.id).companyId === w.companyB.id
        && transit.lineCache.get(line.id).queueCompanyId === w.companyB.id
        && transit.lineCache.get(line.id).companyOwner === userB.id,
      `companyId=${transit.lineCache.get(line.id).companyId} queueCompanyId=${transit.lineCache.get(line.id).queueCompanyId}`);

    // 候车队伍：人一个不少地搬到新公司名下（否则他们永远等不到车）
    const byCompany = transit.stationQueues.get(Number(stations[0])) || new Map();
    const underNew = byCompany.get(transit._companyKey(w.companyB.id, userB.id));
    const bucket = underNew ? underNew.buckets.get(transit._bucketKey(line.id)) : null;
    check('这条线在各站的候车队伍跟着线路搬到新公司名下（人一个不少、等待计时继续）',
      transit.stationWaiting(stations[0]).waiting === waitingBefore
        && !!bucket && bucket.waiting === waitingBefore && bucket.cohorts.length > 0
        && res.passengersMoved === waitingBefore,
      `等车 ${transit.stationWaiting(stations[0]).waiting} 人 / 新公司名下 ${bucket ? bucket.waiting : '无'} 人 / 搬走 ${res.passengersMoved} 人`);

    // 撤销：线路与车一起回到原公司
    const undo = transit.apply(userB, { k: 'undo' });
    const backRow = transit._st.line.get(line.id);
    const okVehicles = [vehA, vehB].every((v) => {
      const r = transit._st.vehicle.get(v.id);
      return r.owner === userA.id && r.company_id === w.companyA.id && r.line_id === line.id;
    });
    check('撤销一步：线路与两辆车都回到原来的公司（撤销栈里记的就是这一次转移）',
      /转到/.test(undo.undone || '') && backRow.owner === userA.id && backRow.company_id === w.companyA.id && okVehicles,
      `undo=${undo.undone} → owner=${backRow.owner} company=${backRow.company_id} / 车回到原公司 ${okVehicles}`);
    check('撤销之后线路缓存也回到原公司（迁移不是"一次性"的）',
      transit.lineCache.get(line.id).companyId === w.companyA.id
        && transit.lineCache.get(line.id).queueCompanyId === w.companyA.id,
      `companyId=${transit.lineCache.get(line.id).companyId} queueCompanyId=${transit.lineCache.get(line.id).queueCompanyId}`);

    // 不给 withVehicles 时只转线路，车留在原公司
    const again = transit.apply(userB, { k: 'line.transfer', id: line.id, companyId: w.companyB.id });
    const stay = [vehA, vehB].every((v) => transit._st.vehicle.get(v.id).company_id === w.companyA.id);
    check('不给 withVehicles 时只转线路（车留在原公司，照样能跑这条线）',
      again.moved === true && again.vehiclesMoved === 0 && stay
        && transit._st.line.get(line.id).company_id === w.companyB.id,
      `转了 ${again.vehiclesMoved} 辆车 / 车还在原公司 ${stay}`);
    // 转到自己现在的公司 = 空操作（不记撤销）
    const depth = transit.undoDepth(userB.id);
    const same = transit.apply(userB, { k: 'line.transfer', id: line.id, companyId: w.companyB.id });
    check('转到线路现在所属的那家公司是空操作（changed 语义清楚：moved=false、不记撤销）',
      same.moved === false && transit.undoDepth(userB.id) === depth,
      `moved=${same.moved} / 撤销栈深度 ${depth} → ${transit.undoDepth(userB.id)}`);
    w.raw.close();
  }

  /* ============ 5. 自由发车线（没有班次表）照样能一键暂停 ============ */
  console.log('\n▶ 5. 自由发车线（schedule=null）：暂停也是"跑完这一圈再收车"，恢复后重新开跑');
  {
    const w = makeWorld();
    const { transit } = w;
    const { line, vehicles } = makeLine(w, { vehicles: 1 });   // 没有 schedule = 自由发车（老行为）
    const veh = vehicles[0];
    transit.speed = 20;
    const rt = transit.runtime.get(veh.id);

    const freePub = linePub(transit, line.id);
    check('自由发车线（free）的 service 也带 paused 字段（老客户端只多一个字段，语义不变）',
      freePub.service.mode === 'free' && freePub.service.paused === false && freePub.schedule.mode === 'free',
      `mode=${freePub.service.mode} paused=${freePub.service.paused}`);

    const running = runUntil(transit, () => rt.distance > 300, 600);
    transit.apply(w.userA, { k: 'line.setService', id: line.id, running: false });
    const distAtPause = rt.distance;
    run(transit, 60);         // 暂停后的一小段时间：这一圈还没跑完，车接着跑（不是"就地冻住"）
    check('暂停不当场打断这一圈：车继续跑到这一圈结束（暂停时的位置还在往前推）',
      running && rt.distance > distAtPause && rt.state !== 'paused',
      `暂停时 ${Math.round(distAtPause)} 米 → 60 游戏秒后 ${Math.round(rt.distance)} 米 / state=${rt.state}`);

    const finished = runUntil(transit, () => rt.state === 'paused', 4000);
    check('跑完这一圈（回到首站）之后收车：停在首站、速度 0、state=paused',
      finished && rt.state === 'paused' && rt.distance === 0 && rt.speed === 0
        && linePub(transit, line.id).service.paused === true,
      `state=${rt.state} 位置 ${Math.round(rt.distance)} 米 / 速度 ${rt.speed}`);
    const parkedAt = rt.distance;
    run(transit, 600);
    check('收车之后一直不动（再跑 10 分钟位置一点没变，也不会有新的出发）',
      rt.distance === parkedAt && rt.speed === 0 && rt.state === 'paused',
      `位置 ${Math.round(rt.distance)} 米（10 分钟前 ${Math.round(parkedAt)} 米）`);

    const resume = transit.apply(w.userA, { k: 'line.setService', id: line.id, running: true });
    const moved = runUntil(transit, () => rt.distance > 100 && rt.state === 'run', 900);
    check('恢复运营：自由发车线直接从首站重新开跑（service.paused 回到 false）',
      resume.service.paused === false && moved && rt.distance > 100 && rt.state === 'run',
      `paused=${resume.service.paused} → 位置 ${Math.round(rt.distance)} 米 / state=${rt.state}`);
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
