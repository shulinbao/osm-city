'use strict';
/**
 * 车厂（不在运营的车不进帧）+ 线路改名 · 专项测试
 *
 *   node tests/transit-depot-test.js
 *
 * ① **不在运营的公交车不要停在地图上**（用户口径）：帧里的 `trains[]` **只有在运营的车**。
 *    判定口径是服务端唯一的 serviceStateOf()（只有 'run' 算在运营）：
 *      · 班次车（headway / timetable）：`rt.runActive === true` —— 从始发站发车到跑完这一趟回到首站
 *        （**含从末站回场那一段**、中途停站也算）都在运营；在首站等点（还没到发车时刻）、
 *        今天班次跑完（下一班在明天）、这条线没分给它的班次 → 都是「在车厂（未运营）」；
 *      · 自由发车线：车一直绕圈，只有被暂停收车（state='paused'）才算回车厂；
 *      · 没指派线路（闲置）→ 车厂。
 *    在车厂的车**留在 vehicles[] 里**，带 inService:false / depot / depotReason / depotNote
 *    （中文就是「在车厂（未运营）· …」）—— 车辆列表与车辆详情就显示这些。
 *    整份快照（welcome / transitSync / GET /api/transit）是"完整名单"：连在车厂的车一起给，
 *    但每一条都带 inService:false，客户端按这个标记把它们从 data.trains 里摘掉（不会画到地图上）。
 *
 * ② **暂停运营**（line.setService running:false）：在途的车照旧在帧里（跑完这一趟），
 *    跑完回到首站被收车后就**从帧里消失**（回车厂）；恢复运营后又回到帧里，位置就是它的真实位置。
 *
 * ③ **线路改名**（line.update { id, name }）：谁建的线路都能改（归属不是权限，只有元素锁才拦）；
 *    控制字符抹掉、首尾空白去掉、最多 32 个字；清完是空 → 明确的中文错误（不会默默留着老名字）。
 *
 * 世界是人造底图（与 transit-service-test.js 同一套做法）：12 个节点、间距 ≈ 854 米的一条直线，
 * 车站取第 0 / 4 / 8 号节点（三个站、两个区间，一趟往返 ≈ 16 游戏分钟）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-depot-test');
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
    catchment: () => ({ pop: 3000, jobs: 500, weightedPop: 3600, activity: 1.2 }),
    totals: () => ({ population: 3000, jobs: 500, cells: 1 }),
  };
  const transit = new Transit(db, {
    rail, ensureBusGraph, population,
    config: Object.assign({
      dwellSeconds: 30, terminalDwellSeconds: 20,
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

/** 让游戏时间走 gameSec 游戏秒（20 倍速：一小步仍然是 3 游戏秒） */
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
    rt.distance = 0;
    rt.lat = cache.path[0].lat;
    rt.lon = cache.path[0].lon;
  }
  return { line, stations, vehicles, cache };
}

const vehPub = (t, id) => t.vehiclePublic(t._st.vehicle.get(id));
const svcStateOf = (t, id) => {
  const v = t._fleet.get(id);
  return t.serviceStateOf(v, v && v.rt, v ? t.lineCache.get(v.lineId) : null);
};
const depotsOf = (frame) => frame.trains.filter((x) => x.inService === false);
const idsOf = (frame) => frame.trains.map((x) => x.id).sort((a, b) => a - b);

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 车厂（不在运营的车不进帧）+ 线路改名 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ══════════════ 1. 闲置车：不进帧，但留在 vehicles[] 里标明在车厂 ══════════════ */
  console.log('▶ 1. 闲置车（没指派线路）：不进任何帧，vehicles[] 里标明「在车厂」');
  {
    const w = makeWorld();
    const { transit, userA } = w;
    const idle = transit.createVehicle(userA, { kind: 'metro_b4' }).vehicle;   // 没有 lineId
    transit.speed = 20;
    run(transit, 60);

    const frame = transit.simFrame();
    check('闲置车不在 simFrame().trains 里（地图上没有它）',
      !frame.trains.some((x) => x.id === idle.id) && frame.trains.length === 0,
      `trains ${frame.trains.length} 辆`);
    const pub = vehPub(transit, idle.id);
    check('闲置车留在 vehicles[] 里，且带着"在车厂"的显式状态（inService/depot/depotReason/depotNote）',
      !!pub && pub.inService === false && pub.depot === true && pub.depotReason === 'idle'
        && /在车厂（未运营）/.test(pub.depotNote || ''),
      pub ? `inService=${pub.inService} depot=${pub.depot} reason=${pub.depotReason} note=${pub.depotNote}` : '快照里没有这辆车');
    check('serviceStateOf 也把它判成 idle（帧过滤与车辆详情用同一个口径）',
      transit.serviceStateOf(transit._fleet.get(idle.id) || { line_id: null }, null, null) === 'idle',
      svcStateOf(transit, idle.id));

    // 指派到一条自由发车线：立刻进帧（自由发车线一上线就在跑，老行为不变）
    const { line, cache } = makeLine(w, { vehicles: 0 });
    transit.apply(userA, { k: 'vehicle.update', id: idle.id, lineId: line.id });
    const after = transit.simFrame();
    const train = after.trains.find((x) => x.id === idle.id);
    const rt = transit.runtime.get(idle.id);
    check('指派到自由发车线后立刻回到帧里（inService:true，位置 = 它的运行时位置）',
      !!train && train.inService === true && train.lineId === line.id
        && train.lat === rt.lat && train.lon === rt.lon && train.distance === Math.round(rt.distance),
      train ? `inService=${train.inService} @${train.lat},${train.lon} d=${train.distance}` : '帧里没有它');
    check('在同一份快照里它现在报 inService:true / depot:false',
      vehPub(transit, idle.id).inService === true && vehPub(transit, idle.id).depot === false
        && vehPub(transit, idle.id).depotReason === null,
      `inService=${vehPub(transit, idle.id).inService}`);

    // 跑起来以后位置在动，帧里跟着动
    run(transit, 120);
    const moving = transit.simFrame().trains.find((x) => x.id === idle.id);
    check('跑起来之后帧里的位置就是它的实时位置（距离在涨、lat/lon 与 runtime 一致）',
      !!moving && moving.distance > 0 && moving.distance === Math.round(rt.distance)
        && moving.lat === rt.lat && moving.lon === rt.lon,
      moving ? `帧 ${moving.distance} 米 / runtime ${Math.round(rt.distance)} 米 / ${moving.speed} km/h` : '帧里没有它');
    check('自由发车线的车照旧报下一站与剩余各站（服务数据没被这轮过滤截断）',
      !!moving && Array.isArray(moving.remainingStops) && moving.remainingStops.length > 0
        && moving.remainingStops.length <= cache.stops.length && moving.nextStop != null
        && moving.etaSeconds != null,
      moving ? `remainingStops ${moving.remainingStops.length} / 下一站 ${moving.nextStop && moving.nextStop.name} ${moving.etaSeconds}s` : '—');
    w.raw.close();
  }

  /* ══════════════ 2. 班次车：首班之前 / 正班 / 末班跑完 三种状态 ══════════════ */
  console.log('\n▶ 2. 班次车：首班发车之前不进帧（车厂等点）→ 到点发车后进帧 → 末班跑完回车厂');
  {
    const w = makeWorld();
    const { transit } = w;
    // 首班 00:01:00（60s），每 600 秒一班，末班 00:10:00（600s）
    const { line, vehicles } = makeLine(w, {
      vehicles: 1, schedule: { mode: 'headway', headwaySec: 600, firstSec: 60, lastSec: 600 },
    });
    const veh = vehicles[0];
    const rt = transit.runtime.get(veh.id);
    transit.speed = 20;

    // ── 首班之前：车在车厂等点 ──
    check('首班发车之前：serviceStateOf = before-departure（还没到发车时刻 → 车厂）',
      transit._scheduleStep(transit._fleet.get(veh.id), transit.lineCache.get(line.id), rt) === 'hold'
        && rt.state === 'scheduled' && rt.runActive === false
        && svcStateOf(transit, veh.id) === 'before-departure',
      `state=${rt.state} runActive=${rt.runActive} svc=${svcStateOf(transit, veh.id)}`);
    check('★ 在车厂的车不在帧里（simFrame 与带视口的 frameFor 都没有它）',
      !transit.simFrame().trains.some((x) => x.id === veh.id)
        && !transit.frameFor(w.userA.id, { owner: w.userA.id }).trains.some((x) => x.id === veh.id),
      `simFrame ${transit.simFrame().trains.length} 辆`);
    const pubWait = vehPub(transit, veh.id);
    check('车辆详情里能看清「在车厂（未运营）」+「下一班 08:15」+ depotReason（客户端三样都读得到）',
      pubWait.inService === false && pubWait.depot === true && pubWait.depotReason === 'before-departure'
        && /在车厂（未运营）/.test(pubWait.depotNote || '')
        && /^\d{2}:\d{2}$/.test(pubWait.scheduledDepartureTime || ''),
      `note=${pubWait.depotNote} / 下一班 ${pubWait.scheduledDepartureTime} / state=${pubWait.state}`);
    check('在车厂时"下一班"报的就是它自己那班的发车时刻（延误/ETA 数据不丢）',
      pubWait.scheduledDepartureTime === '00:01' && pubWait.scheduledDeparture === Math.round(rt.departureMs)
        && pubWait.etaSeconds != null && pubWait.etaSeconds > 0,
      `下一班 ${pubWait.scheduledDepartureTime}（${pubWait.etaSeconds}s 后）/ remainingStops ${pubWait.remainingStops.length} 条`);
    const snapWait = transit.snapshot();
    check('整份快照的 trains[] 是"完整名单"：在车厂的车也在里面，但如实带 inService:false',
      snapWait.trains.some((x) => x.id === veh.id && x.inService === false && /在车厂（未运营）/.test(x.depotNote || '')),
      `快照 trains ${snapWait.trains.length} 条（在车厂 ${snapWait.trains.filter((x) => x.inService === false).length} 条）`);

    // ── 到点发车：车回到帧里，ETA/逐站预测/晚点都对 ──
    const departed = runUntil(transit, () => rt.runActive === true && rt.distance > 50, 1200);
    const frameRun = transit.simFrame();
    const train = frameRun.trains.find((x) => x.id === veh.id);
    check('★ 到点发车后立刻回到帧里（inService:true，位置 = 运行时位置）',
      departed && !!train && train.inService === true && train.lat === rt.lat && train.lon === rt.lon
        && train.distance === Math.round(rt.distance),
      train ? `d=${train.distance} 米（runtime ${Math.round(rt.distance)}）@${train.lat},${train.lon}` : '帧里没有它');
    check('发车后 ETA / 下一站 / 逐站预测都在（跟没在车厂待过时一模一样）',
      !!train && train.nextStop != null && train.etaSeconds != null && train.etaSeconds >= 0
        && train.remainingStops.length > 0 && train.remainingStops[0].stationId === train.nextStop.stationId,
      train ? `下一站 ${train.nextStop.name} ${train.etaSeconds}s / 剩下 ${train.remainingStops.length} 站` : '—');
    check('发车后晚点基准是时刻表（delaySource=timetable，偏差是数字）',
      !!train && train.delaySource === 'timetable' && Number.isFinite(train.delaySeconds),
      train ? `delay=${train.delaySeconds}s（${train.delayTrend}）` : '—');
    check('同一份数据在快照的 vehicles[] 上也一致（客户端车辆管理器读的是它）',
      (() => {
        const pub = vehPub(transit, veh.id);
        return pub.inService === true && pub.depot === false
          && pub.nextStop && pub.nextStop.stationId === train.nextStop.stationId
          && pub.remainingStops.length === train.remainingStops.length;
      })(),
      `vehicles[] 下一站 ${vehPub(transit, veh.id).nextStop && vehPub(transit, veh.id).nextStop.name}`);

    // ── 末班跑完（把时钟推到末班之后，让它把这趟跑完）→ 回场过夜 ──
    transit.clockMs = Math.floor(transit.clockMs / 86400000) * 86400000 + 700000;   // 00:11:40（末班 00:10）
    const finished = runUntil(transit, () => rt.runActive === false, 3000);
    const svcEnd = svcStateOf(transit, veh.id);
    check('★ 末班跑完（回到首站）之后：下一班在明天 → service-ended，车回场过夜',
      finished && rt.runActive === false && rt.distance === 0 && svcEnd === 'service-ended',
      `runActive=${rt.runActive} 位置 ${Math.round(rt.distance)} 米 svc=${svcEnd} 下一班 ${
        rt.departureMs == null ? 'null' : new Date(rt.departureMs).toISOString().slice(11, 16)}`);
    check('★ 回车厂之后就不在帧里了（地图上不会再停着一辆"跑完的车"）',
      !transit.simFrame().trains.some((x) => x.id === veh.id)
        && !transit.frameFor(w.userA.id, { owner: w.userA.id }).trains.some((x) => x.id === veh.id),
      `simFrame ${transit.simFrame().trains.length} 辆`);
    const pubEnd = vehPub(transit, veh.id);
    check('车辆详情说明"今天的班次已经跑完，回场过夜"（depotReason=service-ended + 中文）',
      pubEnd.inService === false && pubEnd.depotReason === 'service-ended'
        && /班次已经跑完/.test(pubEnd.depotNote || ''),
      `reason=${pubEnd.depotReason} note=${pubEnd.depotNote}`);
    w.raw.close();
  }

  /* ══════════════ 3. 暂停运营：在途车跑完 → 回车厂 → 恢复后回到帧里 ══════════════ */
  console.log('\n▶ 3. 暂停运营：在途车照旧在帧里，跑完回车厂；恢复运营后回到帧里（位置正确）');
  {
    const w = makeWorld();
    const { transit } = w;
    const { line, vehicles } = makeLine(w, { vehicles: 1 });      // 自由发车线
    const veh = vehicles[0];
    const rt = transit.runtime.get(veh.id);
    transit.speed = 20;

    const running = runUntil(transit, () => rt.distance > 300, 600);
    const pause = transit.apply(w.userA, { k: 'line.setService', id: line.id, running: false });
    check('暂停那一刻：在途的车照样在帧里（#3 暂停不打断这一趟，它要把这一圈跑完）',
      running && pause.service.paused === true && svcStateOf(transit, veh.id) === 'run'
        && transit.simFrame().trains.some((x) => x.id === veh.id),
      `svc=${svcStateOf(transit, veh.id)} / 在 ${Math.round(rt.distance)} 米处`);

    const parked = runUntil(transit, () => rt.state === 'paused', 4000);
    check('★ 跑完这一圈被收车 → 立刻从帧里消失（回车厂），vehicles[] 里说明"线路已暂停运营，车辆已回车厂"',
      parked && !transit.simFrame().trains.some((x) => x.id === veh.id)
        && !transit.frameFor(w.userA.id, { owner: w.userA.id }).trains.some((x) => x.id === veh.id),
      `state=${rt.state} / 帧 ${transit.simFrame().trains.length} 辆`);
    const pubPaused = vehPub(transit, veh.id);
    check('「线路已暂停运营，车辆已回车厂」这句中文就是 depotNote（暂停期间也没有"下一班"）',
      pubPaused.inService === false && pubPaused.depotReason === 'paused'
        && /线路已暂停运营，车辆已回车厂/.test(pubPaused.depotNote || '')
        && pubPaused.scheduledDepartureTime == null,
      `reason=${pubPaused.depotReason} note=${pubPaused.depotNote} 下一班=${pubPaused.scheduledDepartureTime}`);
    check('停在车厂期间跑了 10 分钟也不动、也不回帧里（一辆都没漏出去）',
      (() => { run(transit, 600); return rt.distance === 0 && rt.speed === 0 && !transit.simFrame().trains.some((x) => x.id === veh.id); })(),
      `位置 ${Math.round(rt.distance)} 米 / 帧 ${transit.simFrame().trains.length} 辆`);

    const resume = transit.apply(w.userA, { k: 'line.setService', id: line.id, running: true });
    const back = runUntil(transit, () => rt.distance > 100, 900);
    const frame = transit.simFrame();
    const train = frame.trains.find((x) => x.id === veh.id);
    check('★ 恢复运营后它回到帧里，且位置就是它的真实位置（不是车厂里那个旧坐标）',
      resume.service.paused === false && back && !!train && train.inService === true
        && train.distance > 100 && train.distance === Math.round(rt.distance)
        && train.lat === rt.lat && train.lon === rt.lon,
      train ? `帧 ${train.distance} 米 / runtime ${Math.round(rt.distance)} 米 @${train.lat},${train.lon}` : '帧里没有它');
    check('恢复后 vehicles[] 也回到 inService:true（depot 标记一起清掉）',
      vehPub(transit, veh.id).inService === true && vehPub(transit, veh.id).depot === false
        && vehPub(transit, veh.id).depotNote === null,
      `inService=${vehPub(transit, veh.id).inService} note=${vehPub(transit, veh.id).depotNote}`);
    w.raw.close();
  }

  /* ══════════════ 4. 帧的账目：hidden / totalRunning / lineCounts 只数在运营的车 ══════════════ */
  console.log('\n▶ 4. 帧的账目：hidden + trains = 在运营的车数（在车厂的车不算"别处还在跑"）');
  {
    const w = makeWorld();
    const { transit, userA } = w;
    const other = { id: 'u-watcher', name: '路人', color: '#000' };
    transit.ensureCompany(other);
    // 4 辆车、一条班次线：首班只发一辆，另外 3 辆在车厂等自己的班
    const { line, vehicles, cache } = makeLine(w, {
      vehicles: 4, schedule: { mode: 'headway', headwaySec: 600, firstSec: 60, lastSec: 3600 },
    });
    transit.speed = 20;
    const firstRt = transit.runtime.get(vehicles[0].id);
    const departed = runUntil(transit, () => firstRt.runActive === true, 1200);
    const inService = [vehicles[0].id, vehicles[1].id, vehicles[2].id, vehicles[3].id]
      .filter((id) => svcStateOf(transit, id) === 'run');
    check('取样点：只有一辆车在运营（其余 3 辆在车厂等自己的班）',
      departed && inService.length === 1 && svcStateOf(transit, vehicles[1].id) === 'before-departure',
      `在运营 ${inService.length} 辆 / #${vehicles[1].id} svc=${svcStateOf(transit, vehicles[1].id)}`);

    transit.setPlayerView(other.id, { lat: LAT, lon: lonOf(4), radiusM: 8000 });   // 视口盖住整条线
    const view = transit.playerViewSnapshot()[other.id];
    const frame = transit.vehicleFrame({
      owner: other.id, view, bounds: transit.viewBounds(view), bufferM: 500,
    });
    check('★ 视口盖住整条线，但帧里只有在运营的那一辆（在车厂的车一辆都不发）',
      frame.trains.length === 1 && frame.trains[0].id === inService[0] && frame.trains[0].inService === true,
      `帧 ${frame.trains.length} 辆：${frame.trains.map((x) => x.id).join(',')}（线上共 ${transit.fleetStats().fleet.running} 辆）`);
    check('hidden + 发出去的车 = 全服**在运营**的车（账对得上，不是 fleet.running）',
      frame.totalRunning === 1 && frame.hidden === 0 && frame.hidden + frame.trains.length === frame.totalRunning
        && transit.fleetStats().fleet.running === 4,
      `hidden=${frame.hidden} + ${frame.trains.length} = ${frame.hidden + frame.trains.length} vs totalRunning=${frame.totalRunning}（fleet.running=${transit.fleetStats().fleet.running}）`);
    check('lineCounts 也只有在运营的车（1 辆，而不是线上的 4 辆）',
      frame.lineCounts && frame.lineCounts[line.id] === 1,
      JSON.stringify(frame.lineCounts));
    check('没有视口的客户端走的也是同一口径（完整名单 = 在运营的车）',
      transit.frameFor('nobody', { owner: 'nobody' }).trains.length === 1,
      JSON.stringify(transit.frameFor('nobody', { owner: 'nobody' }).trains.map((x) => x.id)));
    check('"自己的车永远带"也有例外：在车厂的自己的车不进帧（否则地图上会停着 3 辆车）',
      transit.frameFor(other.id, { owner: userA.id }).trains.filter((x) => x.owner === userA.id).length === 1,
      `${transit.frameFor(other.id, { owner: userA.id }).trains.length} 辆`);
    check('在车厂的车在网格里也没被当成"看得见的车"占配额（视口内取车取到的就是那 1 辆）',
      transit.frameFor(other.id, { owner: other.id, limit: 1 }).trains.length === 1
        && transit.frameFor(other.id, { owner: other.id, limit: 1 }).limited !== true,
      `limit=1 时 ${transit.frameFor(other.id, { owner: other.id, limit: 1 }).trains.length} 辆`);

    // 第二班发车 → 帧里变成 2 辆
    const secondRt = transit.runtime.get(vehicles[1].id);
    const second = runUntil(transit, () => secondRt.runActive === true, 1200);
    check('第二辆到点发车后帧里变成 2 辆（车厂只留还没到点的车）',
      second && transit.simFrame().trains.length === 2
        && transit.simFrame().trains.every((x) => x.inService === true),
      `帧 ${transit.simFrame().trains.length} 辆 / 车厂 ${4 - transit.simFrame().trains.length} 辆`);
    check('快照的 trains[] 永远是完整名单（4 辆，其中 2 辆 inService:false）',
      (() => {
        const t = transit.snapshot().trains;
        return t.length === 4 && t.filter((x) => x.inService === false).length === 2
          && t.filter((x) => x.inService === true).length === 2;
      })(),
      `快照 ${transit.snapshot().trains.length} 条（在运营 ${transit.snapshot().trains.filter((x) => x.inService).length} 条）`);
    check('线路缓存/路径没被这轮过滤动过（车还在线上、排班照旧）',
      cache.vehicleIds.length === 4 && transit.lineCache.get(line.id) === cache,
      `线上 ${cache.vehicleIds.length} 辆`);
    w.raw.close();
  }

  /* ══════════════ 5. 线路改名（line.update { name }） ══════════════ */
  console.log('\n▶ 5. 线路改名：谁建的线路都能改（只有元素锁拦），控制字符/长度/空名字有明确口径');
  {
    const w = makeWorld();
    const { transit, userA, userB } = w;
    const { line, vehicles } = makeLine(w, { name: '1 路', vehicles: 1 });
    const veh = vehicles[0];
    transit.speed = 20;
    run(transit, 120);
    const rt = transit.runtime.get(veh.id);

    const renamed = transit.apply(userB, { k: 'line.update', id: line.id, name: '  2 路（快线）  ' });
    check('别人（不是车主）也能给这条线路改名，首尾空白被去掉',
      renamed.line.name === '2 路（快线）' && transit._st.line.get(line.id).name === '2 路（快线）',
      `owner=${transit._st.line.get(line.id).owner} → 新名字「${renamed.line.name}」`);
    check('改名后地图/气泡用的那份数据立刻是新名字（帧里的线路名、linePublic 同一份）',
      transit.snapshot().lines.find((l) => l.id === line.id).name === '2 路（快线）'
        && transit.linePublic(transit._st.line.get(line.id)).name === '2 路（快线）',
      transit.linePublic(transit._st.line.get(line.id)).name);
    check('改名不影响车队：帧里那辆车照旧在跑（inService:true，位置没变）',
      (() => {
        const t = transit.simFrame().trains.find((x) => x.id === veh.id);
        return !!t && t.inService === true && t.lat === rt.lat && t.lon === rt.lon && t.distance === Math.round(rt.distance);
      })(),
      `帧 ${transit.simFrame().trains.length} 辆`);

    const ctrl = transit.apply(userA, { k: 'line.update', id: line.id, name: 'A\u0000B\u0007C\u001f D' });
    check('控制字符被抹掉（与服务端原本的 sanitise 口径一致）',
      ctrl.line.name === 'ABC D', `「${ctrl.line.name}」`);
    const long = transit.apply(userA, { k: 'line.update', id: line.id, name: '线'.repeat(40) });
    check('名字最多 32 个字（超出的部分截掉，不会写进库）',
      long.line.name.length === 32 && transit._st.line.get(line.id).name.length === 32,
      `${long.line.name.length} 个字`);
    const wide = transit.apply(userA, { k: 'line.update', id: line.id, stops: transit._parseStops(transit._st.line.get(line.id).stops) });
    check('只改站序（op 里不带 name）不会动名字（改名与其它字段互不干扰）',
      wide.line.name === long.line.name, `名字还是「${wide.line.name}」`);

    let empty = null;
    try { transit.apply(userA, { k: 'line.update', id: line.id, name: '   \u0001\u0002  ' }); } catch (err) { empty = err; }
    check('清完是空的名字被明确拒绝（中文原因 + code=BAD_ARG，不是默默留着老名字）',
      !!empty && empty.code === 'BAD_ARG' && /线路名不能为空/.test(empty.message)
        && transit._st.line.get(line.id).name === wide.line.name,
      empty ? `${empty.message}（code=${empty.code}）→ 库里还是「${transit._st.line.get(line.id).name}」` : '居然通过了');

    // 元素锁：别人正编辑这条线时，改名被拒（这就是唯一的"权限"）
    transit.apply(userA, { k: 'lock.set', elemType: 'line', id: line.id });
    let locked = null;
    try { transit.apply(userB, { k: 'line.update', id: line.id, name: '偷偷改的名字' }); } catch (err) { locked = err; }
    check('A 锁着这条线时 B 改不了名（中文原因 + code=LOCKED，客户端「✏ 改名」也照这条拦）',
      !!locked && locked.code === 'LOCKED' && /正在编辑/.test(locked.message)
        && transit._st.line.get(line.id).name === wide.line.name,
      locked ? `${locked.message}（code=${locked.code}）` : '居然通过了');
    transit.apply(userA, { k: 'lock.set', elemType: 'line', id: line.id, on: false });
    const unlocked = transit.apply(userB, { k: 'line.update', id: line.id, name: '解锁后改的名字' });
    check('解锁之后 B 立刻能改名（锁一放就该放行）',
      unlocked.line.name === '解锁后改的名字', unlocked.line.name);

    let missing = null;
    try { transit.apply(userB, { k: 'line.update', id: 999999, name: '不存在' }); } catch (err) { missing = err; }
    check('改一条不存在的线路 → 中文错误（线路不存在）',
      !!missing && /线路不存在/.test(missing.message), missing ? missing.message : '居然通过了');
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
