'use strict';
/**
 * 用户投诉 #2 专项测试：**设了班次（流水班 / 定班车）的线路不许再有"自由发车"的车**。
 *
 *   node tests/transit-station-schedule-obey-test.js
 *
 * 根因（本测试把它钉死）：`_scheduleStep` 在"还没到发车时刻"那一支里写过
 *   `if (rt.distance > ARRIVE_EPS) return null;`   // 老代码：以为"还在回场路上"
 * 而 `_runtimeFor` 会把同一条线上的多辆车沿路径**铺开**（distance = pathEnd×i/车数），
 * 且"这条线刚从自由发车改成班次表"时车本来就半路。这两种车 rt.distance > 0、
 * runActive 又是 false → 被那一行放行：它会像自由发车一样跑完一整圈（沿途进站、上下客），
 * 同时对外报 inService:false —— 用户看到的就是"设了班次的车还在自由发车"。
 *
 * 用户口径（本测试逐条断言）：
 *   ① 设了班次的线路上，**每一辆车都遵守时刻表**：没排到"正在跑这一趟"时一律在车厂（首站）等点，
 *      不许在路上出现（rt.distance 恒为 0、位置不动、也不出现在帧的 trains[] 里）；
 *   ② 到点按时发车（发车时刻 = 班次表里的那几班），跑完这一趟回到首站继续等下一班；
 *   ③ 车比班次多时，多出来的车**永远留在车厂**，且状态可见：depotReason = 'no-departure'；
 *   ④ 自由发车的线路一点没变（照旧一直跑）—— 对照实验，防止"一刀切把自由发车也停了"；
 *   ⑤ `line.update` 的 schedule 解析与客户端发的两种 payload 形状对得上
 *      （{mode:'headway',headwaySec,first:'06:00',last:'09:00'} / {mode:'timetable',times:[…]}），
 *      而且班次真的落到了库里、缓存里、以及每辆车的排班上。
 *
 * 世界是人造底图：一条 12 节点的直线铁路（≈ 854 米一个节点），车站取第 0 / 4 / 8 号节点，
 * 一趟往返 ≈ 6800 米（80 km/h 限速下 ≈ 10 游戏分钟）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-schedule-obey');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.01;        // ≈ 854 米一个节点
const NODES = 12;
const RAIL_BASE = 1000;
const RAIL_WAY = 500;
const STOP_NODES = [0, 4, 8];

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const lonOf = (i) => LON0 + i * STEP_LON;

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
    version: 1,
    setDay() {},
    catchment: () => ({ pop: 3000, jobs: 500, weightedPop: 3600, activity: 1.2 }),
    totals: () => ({ population: 3000, jobs: 500, cells: 1 }),
  };
  const transit = new Transit(db, {
    rail, ensureBusGraph, population,
    config: Object.assign({
      dwellSeconds: 30, terminalDwellSeconds: 20,
      patienceSeconds: 1e9, cohortSeconds: 30, tripRatePerDay: 0,
    }, config || {}),
  });
  const user = { id: 'u-sched', name: '测试玩家', color: '#e6194b' };
  const company = transit.ensureCompany(user);
  const at = (idx) => ({ lat: LAT, lon: lonOf(idx) });
  return { raw, db, rail, transit, user, company, at };
}

/** 走 gameSec 游戏秒。默认 **1 游戏秒一小步**（speed=1 + tick(1000)），发车时刻才能精确断言 */
function run(transit, gameSec, chunkMs = 1000) {
  let done = 0;
  let guard = 0;
  while (done < gameSec && guard++ < 400000) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

function makeStations(w, prefix) {
  return STOP_NODES.map((n, i) => w.transit.createStation(w.user, { name: prefix + i, kind: 'rail', ...w.at(n) }).station.id);
}

function makeVehicles(w, lineId, n, kind = 'metro_b4') {
  const out = [];
  for (let i = 0; i < n; i++) out.push(w.transit.createVehicle(w.user, { kind, lineId }).vehicle);
  return out;
}

const rtOf = (t, id) => t.runtime.get(id) || null;
const svcOf = (t, id) => {
  const v = t._fleet.get(id);
  return t.serviceStateOf(v, v && v.rt, v ? t.lineCache.get(v.lineId) : null);
};
const depOf = (t, id) => t.vehiclePublic(t._st.vehicle.get(id)).depotReason;

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 班次线路不许有自由发车的车 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ═════════ 1. 班次线上没有"没在跑这一趟却动了位置"的车 ═════════ */
  console.log('▶ 1. 班次车一律在车厂等点：30 游戏分钟里"没在跑却动了"的采样必须为 0');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 1;
    const sched = { mode: 'headway', headwaySec: 600, firstSec: 3600, lastSec: 7200 };
    const stopsA = makeStations(w, 'A');
    const lineA = transit.createLine(user, { name: '班次线', kind: 'rail', stops: stopsA, schedule: sched }).line;
    const vA = makeVehicles(w, lineA.id, 3);
    // 对照：自由发车线（先自由、后改班次，两条都测）
    const stopsB = makeStations(w, 'B');
    const lineB = transit.createLine(user, { name: '自由线', kind: 'rail', stops: stopsB }).line;
    const vB = makeVehicles(w, lineB.id, 2);

    check('建车时：班次线上的车全都在首站（distance = 0，不许被"铺开"到线路中段）',
      vA.every((v) => rtOf(transit, v.id) === null || rtOf(transit, v.id).distance === 0),
      vA.map((v) => (rtOf(transit, v.id) ? rtOf(transit, v.id).distance : 'rt未建')).join(' / '));

    const bad = [];
    for (let i = 0; i < 60; i++) {
      run(transit, 30);
      for (const v of vA) {
        const rt = rtOf(transit, v.id);
        if (!rt) continue;
        if (rt.distance > 1 && !rt.runActive) {
          bad.push(`t=${Math.round(transit.clockMs / 1000)}s 车${v.id} distance=${Math.round(rt.distance)} state=${rt.state}`);
        }
      }
    }
    check('★★ 班次线（首班 3600 秒之前）没有任何"没在跑这一趟却动了位置"的采样',
      bad.length === 0, bad.length ? `${bad.length} 次，例如：${bad[0]}` : '0 次');
    check('★ 班次线上的车全部在车厂等点（serviceStateOf = before-departure，位置 0）',
      vA.every((v) => svcOf(transit, v.id) === 'before-departure' && Math.round(rtOf(transit, v.id).distance) === 0),
      vA.map((v) => `${v.id}:${svcOf(transit, v.id)}@${Math.round(rtOf(transit, v.id).distance)}m`).join(' | '));
    check('★ 在车厂的车不在帧的 trains[] 里（地图上画不出"自由发车"的车）',
      transit.simFrame().trains.filter((x) => vA.some((v) => v.id === x.id)).length === 0,
      `trains 里班次线车辆数 = ${transit.simFrame().trains.filter((x) => vA.some((v) => v.id === x.id)).length}`);
    check('对照：自由发车线的车照旧一直在路上跑（没有一刀切）',
      vB.some((v) => rtOf(transit, v.id).distance > 1) && transit.simFrame().trains.filter((x) => vB.some((v) => v.id === x.id)).length === 2,
      `自由线位置 = ${vB.map((v) => Math.round(rtOf(transit, v.id).distance)).join(' / ')}`);
    w.raw.close();
  }

  /* ═════════ 2. 到点发车、跑完回场：发车时刻 = 班次表 ═════════ */
  console.log('\n▶ 2. 到点按时发车（不早发、不晚发），跑完这一趟回首站继续等下一班');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 1;
    const sched = { mode: 'headway', headwaySec: 600, firstSec: 3600, lastSec: 7200 };
    const stops = makeStations(w, 'S');
    const line = transit.createLine(user, { name: '班次线', kind: 'rail', stops: stops, schedule: sched }).line;
    const vehicles = makeVehicles(w, line.id, 3);
    const cache = transit.lineCache.get(line.id);
    const depList = transit._lineDepartures(cache);
    const plan = transit._runPlan(cache);

    const starts = [];              // { vehicleId, plannedSec, actualMs, lateSec }
    const seen = new Set();
    const parkedSamples = [];
    let guard = 0;
    while (transit.clockMs < 8000 * 1000 && guard++ < 20000) {
      transit.tick(1000);
      for (const v of vehicles) {
        const rt = rtOf(transit, v.id);
        if (!rt) continue;
        if (rt.runActive && !seen.has(`${v.id}:${rt.scheduledDepartureMs}`)) {
          seen.add(`${v.id}:${rt.scheduledDepartureMs}`);
          starts.push({
            vehicleId: v.id, plannedSec: Math.round((rt.scheduledDepartureMs % 86400000) / 1000),
            actualSec: Math.round(rt.runStartMs / 1000), lateSec: (rt.runStartMs - rt.scheduledDepartureMs) / 1000,
          });
        }
        // 跑完回场：runActive=false 且停在首站
        if (!rt.runActive && rt.distance === 0 && transit.clockMs > 3700 * 1000) {
          parkedSamples.push(svcOf(transit, v.id));
        }
      }
    }
    check('★ 每一班都发出了（发车记录条数 = 班次表条数）',
      starts.length === depList.length, `${starts.length} 次发车 / 班次表 ${depList.length} 班`);
    check('★★ 发车时刻就是班次表里的那几班（一班不差，且**从不早发**）',
      starts.map((s) => s.plannedSec).sort((a, b) => a - b).join(',') === depList.join(',')
      && starts.every((s) => s.lateSec >= -0.001 && s.lateSec <= 2),
      starts.map((s) => `${s.vehicleId}@${s.plannedSec}s(${s.lateSec.toFixed(1)}s)`).join(' '));
    check('★ 每辆车只跑分给它的那几班（_runPlan 的轮转口径：第 j 班给第 j%车数 辆）',
      starts.every((s) => plan.vehicles[depList.indexOf(s.plannedSec)] === s.vehicleId),
      starts.map((s) => `${s.vehicleId}@${s.plannedSec}→计划${plan.vehicles[depList.indexOf(s.plannedSec)]}`).join(' '));
    check('★ 跑完回到首站就被收回车厂等下一班（停在首站、serviceStateOf 说得出原因）',
      parkedSamples.length > 0 && parkedSamples.every((x) => x === 'before-departure' || x === 'service-ended' || x === 'paused'),
      `回场采样状态：${[...new Set(parkedSamples)].join(' / ')}`);
    // 发车之后确实在跑：帧里能看见它（inService:true）
    const v0 = vehicles[0];
    const rt0 = rtOf(transit, v0.id);
    check('发车后的车在帧里报 inService:true（与"在车厂"的 before-departure 互斥）',
      !rt0.runActive || transit.simFrame().trains.some((x) => x.id === v0.id),
      `runActive=${rt0.runActive} 帧里 ${transit.simFrame().trains.some((x) => x.id === v0.id) ? '有' : '没有'}它`);
    w.raw.close();
  }

  /* ═════════ 3. 车比班次多：多出来的车留在车厂（depotReason = no-departure） ═════════ */
  console.log('\n▶ 3. 车比班次多：没有班次的车停在车厂（depotReason = no-departure），绝不上路');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 1;
    const sched = { mode: 'headway', headwaySec: 900, firstSec: 1200, lastSec: 3000 };   // 1200 / 2100 / 3000 = 3 班
    const stops = makeStations(w, 'M');
    const line = transit.createLine(user, { name: '少班线', kind: 'rail', stops: stops, schedule: sched }).line;
    const vehicles = makeVehicles(w, line.id, 7);
    const cache = transit.lineCache.get(line.id);
    const plan = transit._runPlan(cache);
    const depCount = transit._lineDepartures(cache).length;
    const noRun = vehicles.map((v) => v.id).filter((id) => !plan.vehicles.includes(id));
    check('这一局确实造出了"没有班次的车"（车 7 辆 > 班次 3 班 → 4 辆没班）',
      noRun.length === vehicles.length - depCount && noRun.length > 0,
      `班次 ${depCount} 个（派车 ${JSON.stringify(plan.vehicles)}）｜没班次的车 = ${noRun.join(',')}`);

    // 跑过首班（1200 秒）之后再跑一段，确认没班次的车一步都没动
    run(transit, 2000);
    check('★ 没班次的车一直在车厂：位置 0、不在帧里、状态是 no-departure',
      noRun.every((id) => Math.round(rtOf(transit, id).distance) === 0
        && svcOf(transit, id) === 'no-departure'
        && depOf(transit, id) === 'no-departure'
        && !transit.simFrame().trains.some((x) => x.id === id)),
      noRun.map((id) => `${id}:${svcOf(transit, id)}@${Math.round(rtOf(transit, id).distance)}m`).join(' | '));
    check('★ no-departure 的中文说明能看懂（客户端车辆列表直接显示这一句）',
      noRun.every((id) => /在车厂（未运营）/.test(transit.vehiclePublic(transit._st.vehicle.get(id)).depotNote || '')),
      transit.vehiclePublic(transit._st.vehicle.get(noRun[0])).depotNote);
    check('有班次的车照常按时刻表发车（不是"所有车都趴窝"）',
      vehicles.some((v) => plan.vehicles.includes(v.id) && rtOf(transit, v.id).lifetimeKm > 0),
      `跑过的车：${vehicles.filter((v) => rtOf(transit, v.id).lifetimeKm > 0).map((v) => v.id).join(',')}`);
    w.raw.close();
  }

  /* ═════════ 4. 自由发车 → 班次表：路上那辆车被收回车厂 ═════════ */
  console.log('\n▶ 4. 一条自由发车的线路改成班次表：半路上的车立刻收回车厂，不许把这一圈跑完');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 1;
    const stops = makeStations(w, 'F');
    const line = transit.createLine(user, { name: '改班次线', kind: 'rail', stops: stops }).line;
    const vehicles = makeVehicles(w, line.id, 2);
    run(transit, 120);
    const mid = vehicles.filter((v) => rtOf(transit, v.id).distance > 20);
    check('先把两辆车跑到半路上（自由发车，确实在路上）',
      mid.length > 0, vehicles.map((v) => Math.round(rtOf(transit, v.id).distance)).join(' / '));

    transit.apply(user, {
      k: 'line.update', id: line.id,
      schedule: { mode: 'headway', headwaySec: 600, firstSec: 3600, lastSec: 7200 },
    });
    check('班次已经存到服务端：库里、线路缓存里都能看到（面向前端的那一份）',
      JSON.parse(transit._st.line.get(line.id).schedule).mode === 'headway'
      && transit.lineCache.get(line.id).schedule.mode === 'headway'
      && transit.linePublic(transit._st.line.get(line.id)).schedule.mode === 'headway',
      transit._st.line.get(line.id).schedule);
    transit.tick(1000);
    // ⚠ 位置不是"一个 tick 之内"就收回来的：车按 LOD 分档采样（视口外粗档 3 游戏秒一次），
    //   所以要给它几小步。用户口径是"最多一个游戏分钟"，这里跑 10 游戏秒已经很宽松。
    run(transit, 10);
    check('★★ 改班次之后一辆都不许再自由行驶：全部回到首站（distance = 0）等点',
      vehicles.every((v) => rtOf(transit, v.id).distance === 0 && !rtOf(transit, v.id).runActive),
      vehicles.map((v) => `${v.id}@${Math.round(rtOf(transit, v.id).distance)}m`).join(' | '));
    const before = vehicles.map((v) => rtOf(transit, v.id).lat);
    run(transit, 600);
    check('★★ 之后 10 游戏分钟里它们一动不动（位置与朝向都没变，帧里也没有它们）',
      vehicles.every((v, i) => rtOf(transit, v.id).lat === before[i] && rtOf(transit, v.id).distance === 0)
      && transit.simFrame().trains.filter((x) => vehicles.some((v) => v.id === x.id)).length === 0,
      vehicles.map((v) => `${v.id}@${Math.round(rtOf(transit, v.id).distance)}m`).join(' | '));
    w.raw.close();
  }

  /* ═════════ 5. line.update 的 schedule 解析（与客户端发的形状对拍） ═════════ */
  console.log('\n▶ 5. line.update 的 schedule 解析：客户端发的两种形状都要落到库里并按它发车');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 1;
    const stops = makeStations(w, 'P');
    const line = transit.createLine(user, { name: '解析线', kind: 'rail', stops: stops }).line;
    // 客户端 linemgr.saveSchedule 发的是嵌套对象，headway 用 first/last 的 'HH:MM' 字符串
    transit.apply(user, { k: 'line.update', id: line.id, schedule: { mode: 'headway', headwaySec: 1800, first: '06:00', last: '08:00' } });
    const row = transit._st.line.get(line.id);
    const parsed = transit.lineSchedule(row);
    check('流水班：{mode,headwaySec,first:"06:00",last:"08:00"} 被解析成 firstSec/lastSec（客户端发的就是这个形状）',
      parsed.mode === 'headway' && parsed.headwaySec === 1800 && parsed.firstSec === 6 * 3600 && parsed.lastSec === 8 * 3600,
      JSON.stringify(parsed));
    check('班次表按流水班铺开（06:00 ~ 08:00 每 1800 秒一班 = 5 班）',
      transit._lineDepartures(transit.lineCache.get(line.id)).join(',') === '21600,23400,25200,27000,28800',
      transit._lineDepartures(transit.lineCache.get(line.id)).join(','));

    // 定班车：times 用 'HH:MM' 字符串，顺序打乱、含重复
    transit.apply(user, { k: 'line.update', id: line.id, schedule: { mode: 'timetable', times: ['08:30', '07:00', '08:30'] } });
    const parsed2 = transit.lineSchedule(transit._st.line.get(line.id));
    check('定班车：times 的 "HH:MM" 字符串被解析、排序、去重',
      parsed2.mode === 'timetable' && parsed2.times.join(',') === `${7 * 3600},${8 * 3600 + 1800}`,
      JSON.stringify(parsed2));
    check('线路缓存与对外接口都换成了定班车（不是"存进去了但还在按流水班跑"）',
      transit.lineCache.get(line.id).schedule.mode === 'timetable'
      && transit.linePublic(transit._st.line.get(line.id)).schedule.mode === 'timetable',
      transit.lineCache.get(line.id).schedule.mode);

    // 定班车也要真的按它发车：一辆车、两班（07:00 / 08:30）
    const v = makeVehicles(w, line.id, 1)[0];
    // 把时钟拨到 06:30（顺带测一跳表之后的重新排班：等点的车要按新时刻排下一班）
    transit.apply(user, { k: 'clock.set', time: '06:30' });
    run(transit, 60);
    check('定班车在首班之前也在车厂等点（不是自由发车），且跳表后重新排的是 07:00 那一班',
      rtOf(transit, v.id).distance === 0 && svcOf(transit, v.id) === 'before-departure'
      && Math.round(rtOf(transit, v.id).departureMs / 1000) % 86400 === 7 * 3600,
      `${svcOf(transit, v.id)}，下一班 = ${Math.round(rtOf(transit, v.id).departureMs / 1000) % 86400}s`);
    let startSec = null;
    let guard = 0;
    while (startSec == null && guard++ < 60 * 60) {
      transit.tick(1000);
      const rt = rtOf(transit, v.id);
      if (rt.runActive) startSec = Math.round(rt.scheduledDepartureMs / 1000) % 86400;
    }
    check('★ 到 07:00 才发车（定班车的时刻表真的在驱动发车）',
      startSec === 7 * 3600, `实际计划发车 = ${startSec}（应为 ${7 * 3600}）`);
    // 清掉班次 = 回到自由发车（老行为要能一键回去）
    transit.apply(user, { k: 'line.update', id: line.id, schedule: { mode: 'free' } });
    check('把班次清成 free：库里清空、缓存回到自由发车（一键回到老行为）',
      transit._st.line.get(line.id).schedule === null
      && transit.lineCache.get(line.id).schedule.mode === 'free',
      `库=${transit._st.line.get(line.id).schedule} 缓存=${transit.lineCache.get(line.id).schedule.mode}`);
    w.raw.close();
  }
} catch (err) {
  failed += 1;
  failures.push('异常：' + (err && err.stack ? err.stack : err));
  console.log('  ❌ 测试异常：', err && err.stack ? err.stack : err);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(failed ? 1 : 0);
