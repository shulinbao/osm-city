'use strict';
/**
 * 用户投诉 #3 专项测试：**公交不再互相阻挡**（前车不许再把后车压住），
 * 但同一个站上不许叠在一起；轨道车的净距行为一个字没改；晚点成因改记拥堵。
 *
 *   node tests/transit-bus-noblock-test.js
 *
 * 用户口径：
 *   ① 公交车之间不互相阻挡 —— `_enforceSpacing` 对公交完全不生效（config.transit.busBlocking 默认
 *      false，设成 true 可一键回到老行为）。公交慢下来只能是因为道路网（限速 × #16 拥堵系数）。
 *   ② 轨道车（地铁 / 轻轨 / 有轨电车 / 铁路）**保持原样**：净距照旧生效（本测试有对照断言）。
 *   ③ 不许出现"不自然的叠在一起"：同一个站上停多辆公交时按**停靠位**排队错开
 *      （rt.dwellSlotM，只影响画在哪，不动 rt.distance，所以到站判定/时刻表/里程都不受影响）。
 *   ④ 延迟系统：公交的晚点成因记成 'congestion'，公交车永远拿不到 'blocked'。
 *
 * 世界是人造底图：一条铁路 + 一条平行公路（都在同一批节点上，≈ 213 米一个节点）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { metrosBetween, metersBetween } = require('../server/osmdb');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-bus-noblock');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.0025;      // ≈ 213 米一个节点
const NODES = 12;
const RAIL_BASE = 1000;
const ROAD_BASE = 2000;
const RAIL_WAY = 500;
const ROAD_WAY = 501;
const BUS_STOP_NODES = [0, 2, 4, 6, 8];

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const lonOf = (i) => LON0 + i * STEP_LON;
const railNode = (i) => RAIL_BASE + i;
const roadNode = (i) => ROAD_BASE + i;

function buildFixture(db) {
  const insNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = db.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  for (let i = 0; i < NODES; i++) {
    insNode.run(railNode(i), LAT, lonOf(i), now);
    insIndex.run(railNode(i), lonOf(i), lonOf(i), LAT, LAT);
    insWayNode.run(RAIL_WAY, i, railNode(i));
    insNode.run(roadNode(i), LAT + 0.00027, lonOf(i), now);
    insIndex.run(roadNode(i), lonOf(i), lonOf(i), LAT + 0.00027, LAT + 0.00027);
    insWayNode.run(ROAD_WAY, i, roadNode(i));
  }
  insWay.run(RAIL_WAY, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, NODES, LAT, LAT, lonOf(0), lonOf(NODES - 1));
  insWayIndex.run(RAIL_WAY, lonOf(0), lonOf(NODES - 1), LAT, LAT);
  insWay.run(ROAD_WAY, JSON.stringify({ highway: 'primary', maxspeed: '50' }), now, NODES, LAT + 0.00027, LAT + 0.00027, lonOf(0), lonOf(NODES - 1));
  insWayIndex.run(ROAD_WAY, lonOf(0), lonOf(NODES - 1), LAT + 0.00027, LAT + 0.00027);
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
  const user = { id: 'u-bus', name: '测试玩家', color: '#e6192b' };
  const company = transit.ensureCompany(user);
  const atBus = (idx) => ({ lat: LAT + 0.00027, lon: lonOf(idx) });
  const atRail = (idx) => ({ lat: LAT, lon: lonOf(idx) });
  return { raw, db, rail, road, transit, user, company, atBus, atRail };
}

function run(transit, gameSec, chunkMs = 1000) {
  let done = 0;
  let guard = 0;
  while (done < gameSec && guard++ < 400000) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

/** 把 n 辆车摆在"前车里程 - 10×k 米"的位置（同一方向、都在跑），专治"前车压后车" */
function bunchUp(transit, lineId, vehicles, back = 10) {
  const cache = transit.lineCache.get(lineId);
  const end = cache.path[cache.path.length - 1].distance;
  const rts = vehicles.map((v, i) => {
    const rt = transit._runtimeFor(v.id);
    rt.distance = end * 0.5 - i * back;
    rt.speed = 0;
    rt.direction = 1;
    rt.state = 'run';
    rt.needsServeAtStart = false;
    rt.parkedAt = null;
    rt.parkedIds = null;
    rt.dwellSlotM = 0;
    rt.nextStepMs = 0;
    rt.lastStepAtMs = transit.clockMs;
    return rt;
  });
  return rts;
}

const rtOf = (t, id) => t.runtime.get(id) || null;
const gapOf = (a, b) => Math.abs(a.distance - b.distance);

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 公交不互相阻挡（+ 站台排队位 / 轨道对照 / 拥堵成因）· 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ═════════ 1. 公交：前车压不住后车 ═════════ */
  console.log('▶ 1. 公交：minGapMeters 设成 200 米都不许压住后车（config.transit.busBlocking 默认 false）');
  {
    const w = makeWorld({ minGapMeters: 200 });
    const { transit, user } = w;
    transit.speed = 20;
    const stops = BUS_STOP_NODES.map((n, i) => transit.createStation(user, { name: '公交站' + i, kind: 'bus', ...w.atBus(n) }).station.id);
    const line = transit.createLine(user, { name: '公交 1 路', kind: 'bus', stops }).line;
    const b1 = transit.createVehicle(user, { kind: 'bus', lineId: line.id }).vehicle;
    const b2 = transit.createVehicle(user, { kind: 'bus', lineId: line.id }).vehicle;
    check('默认配置就是"公交互不阻挡"（DEFAULTS.busBlocking = false，可一键切回）',
      transit.config.busBlocking === false, `config.busBlocking = ${transit.config.busBlocking}`);

    const [rt1, rt2] = bunchUp(transit, line.id, [b1, b2], 10);
    const startGap = gapOf(rt1, rt2);
    const start2 = rt2.distance;
    const start1 = rt1.distance;
    transit._blocked = 0;
    // 每秒采样：看后车有没有被压住 / 有没有被刹停 / 会不会超越前车
    let overtook = false;
    let minGapBothRunning = Infinity;
    let stalledSteps = 0;
    let lastDist = rt2.distance;
    for (let i = 0; i < 300; i++) {
      // speed = 20 时 tick(50) 正好走 **1 游戏秒**（300 次 = 5 游戏分钟的逐秒采样）
      transit.tick(50);
      if (rt2.distance > rt1.distance + 10) overtook = true;
      if (rt1.state === 'run' && rt2.state === 'run' && rt2.speed > 1) {
        minGapBothRunning = Math.min(minGapBothRunning, gapOf(rt1, rt2));
      }
      if (rt2.state === 'run' && rt2.distance <= lastDist + 1e-6 && rt2.speed < 0.5) stalledSteps += 1;
      lastDist = rt2.distance;
    }

    check('★★ 后车没有被前车压住（_enforceSpacing 一次都没有限位：_blocked = 0、blockedMs = 0、没有一次"该走却没走"）',
      (transit._blocked || 0) === 0 && (rt2.blockedMs || 0) === 0 && stalledSteps === 0,
      `_blocked=${transit._blocked || 0} blockedMs=${rt2.blockedMs || 0} 停滞采样=${stalledSteps}`
      + `（当前速度 ${rt2.speed.toFixed(2)} m/s，state=${rt2.state}）`);
    check('★ 两辆车都在正常运营（5 游戏分钟里各自都跑了 100 米以上：里程在涨，没有被压在路上）',
      rt2.lifetimeKm > 0.1 && rt1.lifetimeKm > 0.1,
      `里程：前 ${(rt1.lifetimeKm * 1000).toFixed(0)} 米，后 ${(rt2.lifetimeKm * 1000).toFixed(0)} 米`);
    check('★★ 两车都在跑时净距可以远小于 minGapMeters（老代码会把后车限位在 minGapMeters 之外）',
      minGapBothRunning < transit.config.minGapMeters / 2,
      `两车都在跑时的最小净距 ${minGapBothRunning === Infinity ? '—' : Math.round(minGapBothRunning)} 米`
      + ` ≪ minGapMeters = ${transit.config.minGapMeters} 米`);
    check('★★ 后车甚至可以**超越**前车（被限位在 minGapMeters 之外时，这件事不可能发生）',
      overtook,
      `5 游戏分钟里两车交换过前后顺序 = ${overtook}`);
    check('公交的"拥堵时间"在涨（它只被道路网压着走，与 blockedMs 无关）',
      (rt2.congestMs || 0) > 0 && (rt1.congestMs || 0) > 0 && (rt2.blockedMs || 0) === 0,
      `congestMs：前 ${Math.round((rt1.congestMs || 0) / 1000)}s / 后 ${Math.round((rt2.congestMs || 0) / 1000)}s，blockedMs=${rt2.blockedMs || 0}`);
    w.raw.close();
  }

  /* ═════════ 2. 对照：轨道车的净距一个字没改 ═════════ */
  console.log('\n▶ 2. 对照（必须保持不变）：轨道车照旧按净距互相限位');
  {
    const w = makeWorld({ minGapMeters: 200 });
    const { transit, user } = w;
    transit.speed = 20;
    const stops = [0, 4, 8].map((n, i) => transit.createStation(user, { name: '地铁站' + i, kind: 'rail', ...w.atRail(n) }).station.id);
    const line = transit.createLine(user, { name: '地铁 1 号线', kind: 'rail', stops }).line;
    const t1 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line.id }).vehicle;
    const t2 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line.id }).vehicle;
    const [rt1, rt2] = bunchUp(transit, line.id, [t1, t2], 10);
    transit._blocked = 0;
    run(transit, 60);
    const minGap = rt1.veh.lengthM / 2 + rt2.veh.lengthM / 2 + transit.config.minGapMeters;
    check('★ 轨道车照旧被前车压住（blockedMs > 0、_blocked > 0）—— 用户口径：轨道保持现状',
      (rt2.blockedMs || 0) > 0 && (transit._blocked || 0) > 0,
      `blockedMs=${Math.round((rt2.blockedMs || 0) / 1000)}s _blocked=${transit._blocked || 0}`);
    check('★ 轨道车被限位在"两车半长 + minGapMeters"之外（净距规则完全没动）',
      gapOf(rt1, rt2) >= minGap - 1 && rt2.distance <= rt1.distance + 1,
      `净距 ${Math.round(gapOf(rt1, rt2))} 米 ≥ ${Math.round(minGap)} 米`);
    check('轨道车的 congestMs 保持 0（拥堵成因只给公交）',
      (rt2.congestMs || 0) === 0, `congestMs=${rt2.congestMs || 0}`);
    w.raw.close();
  }

  /* ═════════ 3. 开关：busBlocking = true 一键回到老行为 ═════════ */
  console.log('\n▶ 3. config.transit.busBlocking = true：公交恢复老行为（可逆开关）');
  {
    const w = makeWorld({ minGapMeters: 200, busBlocking: true });
    const { transit, user } = w;
    transit.speed = 20;
    const stops = BUS_STOP_NODES.map((n, i) => transit.createStation(user, { name: '公交站' + i, kind: 'bus', ...w.atBus(n) }).station.id);
    const line = transit.createLine(user, { name: '公交 2 路', kind: 'bus', stops }).line;
    const b1 = transit.createVehicle(user, { kind: 'bus', lineId: line.id }).vehicle;
    const b2 = transit.createVehicle(user, { kind: 'bus', lineId: line.id }).vehicle;
    const [rt1, rt2] = bunchUp(transit, line.id, [b1, b2], 10);
    transit._blocked = 0;
    run(transit, 60);
    const minGap = rt1.veh.lengthM / 2 + rt2.veh.lengthM / 2 + transit.config.minGapMeters;
    check('★ 打开 busBlocking 之后公交又会被前车压住（老行为可以整体恢复）',
      (rt2.blockedMs || 0) > 0 && (transit._blocked || 0) > 0 && gapOf(rt1, rt2) >= minGap - 1,
      `blockedMs=${Math.round((rt2.blockedMs || 0) / 1000)}s 净距 ${Math.round(gapOf(rt1, rt2))} 米 ≥ ${Math.round(minGap)}`);
    w.raw.close();
  }

  /* ═════════ 4. 同一个站的公交按停靠位排队，不叠在同一个点 ═════════ */
  console.log('\n▶ 4. 同站停靠：三辆公交同时停一个站 → 按停靠位错开画，且不影响模拟（不会反复进站）');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 20;
    const stops = BUS_STOP_NODES.map((n, i) => transit.createStation(user, { name: '公交站' + i, kind: 'bus', ...w.atBus(n) }).station.id);
    const line = transit.createLine(user, { name: '公交 3 路', kind: 'bus', stops }).line;
    const vs = [0, 1, 2].map(() => transit.createVehicle(user, { kind: 'bus', lineId: line.id }).vehicle);
    const cache = transit.lineCache.get(line.id);
    const stop = cache.stops[2];
    const rts = vs.map((v, i) => {
      const rt = transit._runtimeFor(v.id);
      rt.distance = stop.distance - i * 5;
      rt.speed = 0;
      rt.direction = 1;
      rt.state = 'run';
      rt.needsServeAtStart = false;
      rt.parkedAt = null;
      rt.parkedIds = null;
      rt.nextStepMs = 0;
      return rt;
    });
    // 三辆公交在同一小步里进同一个站（车队的顺序就是模拟的顺序）
    let dockCalls = 0;
    const origDock = transit._dock.bind(transit);
    transit._dock = (vehicle, c, rt, p, st) => {
      if (Number(st.stationId) === Number(stop.stationId)) dockCalls += 1;
      return origDock(vehicle, c, rt, p, st);
    };
    for (const v of vs) transit._dock(transit._fleet.get(v.id), cache, rts[vs.indexOf(v)], cache.path, stop);

    const lens = vs.map((v) => transit._fleet.get(v.id).lengthM);
    check('三辆公交的**模拟位置**都在站台上（rt.distance 相同 —— 到站判定/时刻表完全不受排队位影响）',
      rts.every((rt) => Math.abs(rt.distance - stop.distance) < 1e-9),
      rts.map((rt) => rt.distance.toFixed(1)).join(' / '));
    check('★ 排队位依次错开：0 / 一个车位 / 两个车位（step = 车长 + busQueueGapMeters）',
      rts[0].dwellSlotM === 0 && rts[1].dwellSlotM === lens[1] + transit.config.busQueueGapMeters
      && rts[2].dwellSlotM === 2 * (lens[2] + transit.config.busQueueGapMeters),
      rts.map((rt) => rt.dwellSlotM).join(' / ') + ` 米（车长 ${lens[0]} 米 + 间隙 ${transit.config.busQueueGapMeters} 米）`);
    const drawn = rts.map((rt) => ({ lat: rt.lat, lon: rt.lon }));
    const d12 = metersBetween(drawn[0].lat, drawn[0].lon, drawn[1].lat, drawn[1].lon);
    const d23 = metersBetween(drawn[1].lat, drawn[1].lon, drawn[2].lat, drawn[2].lon);
    check('★★ 画出来的三辆车互不重叠（相邻两辆的图上距离 ≥ 一个车长 = 12 米）',
      d12 >= lens[0] - 1e-6 && d23 >= lens[1] - 1e-6 && d12 > 0 && d23 > 0,
      `图上间距 ${d12.toFixed(1)} 米 / ${d23.toFixed(1)} 米，车长 ${lens[0]} 米`);
    check('第一辆仍然停在站台上（排队位 0 = 对准站台）',
      Math.abs(metersBetween(drawn[0].lat, drawn[0].lon, stop.lat, stop.lon)) < 1,
      `与站台距离 ${metersBetween(drawn[0].lat, drawn[0].lon, stop.lat, stop.lon).toFixed(2)} 米`);

    // 停站结束 → 排队位还回去；之后继续跑时**不会**因为"位置被挪过"而反复进同一个站
    run(transit, 120);
    check('★ 停站结束后排队位清 0，车照常往前跑（模拟里位置从没被挪过，所以不会反复进站）',
      rts.every((rt) => rt.state !== 'dwell' && rt.distance > stop.distance),
      rts.map((rt) => `${rt.state}@${Math.round(rt.distance)}m slot=${rt.dwellSlotM}`).join(' | '));
    check('★ 这个站在整段时间里只被"办"了 3 次（三辆车各一次，没有重复进站）',
      dockCalls === 3, `_dock 调用 ${dockCalls} 次`);
    w.raw.close();
  }

  /* ═════════ 5. 晚点成因：公交记 congestion，永远不是 blocked ═════════ */
  console.log('\n▶ 5. 晚点成因：公交 = congestion（且永远不是 blocked），轨道车照旧 = blocked');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 20;
    const stops = BUS_STOP_NODES.map((n, i) => transit.createStation(user, { name: '公交站' + i, kind: 'bus', ...w.atBus(n) }).station.id);
    const line = transit.createLine(user, { name: '公交 4 路', kind: 'bus', stops }).line;
    const bus = transit.createVehicle(user, { kind: 'bus', lineId: line.id }).vehicle;
    const rt = transit._runtimeFor(bus.id);
    // 先跑到第一个站（这一趟的计划就是在那里按**当时的**道路速度锚定的）
    let guard = 0;
    while (rt.delayHistory.length === 0 && guard++ < 4000) transit.tick(1000);
    check('公交跑了一趟的第一站，拿到了本趟计划（计划按当时的路况锚定）',
      rt.delayHistory.length === 1, `delayHistory ${rt.delayHistory.length} 条`);

    // 之后道路变堵（把路径速度从 50 km/h 压到 12 km/h）：车会比计划慢 —— 这就是"拥堵导致晚点"
    const cache = transit.lineCache.get(line.id);
    for (const p of cache.path) p.speed = Math.min(p.speed || 50, 12);
    guard = 0;
    while (rt.delayHistory.length < 2 && guard++ < 4000) transit.tick(1000);
    const late = rt.delayHistory[rt.delayHistory.length - 1];
    check('★★ 公交因为道路变慢而晚点：成因记成 congestion（不是 blocked/delayed）',
      rt.delayHistory.length >= 2 && late.cause === 'congestion' && late.delaySeconds > 0
      && late.blockedSeconds === 0 && late.congestionSeconds > 0,
      `cause=${late.cause} 晚点 ${late.delaySeconds}s blocked=${late.blockedSeconds}s congestion=${late.congestionSeconds}s`);
    check('★ 公交的记录里一条 blocked 都没有（净距对它不生效，这个成因在公交上不可达）',
      rt.delayHistory.every((r) => r.cause !== 'blocked'),
      rt.delayHistory.map((r) => r.cause).join(','));

    // 极端情况：就算有人硬给公交加上 blockedMs（不该发生），成因也不许变成 blocked
    rt.blockedMs = (rt.blockedMs || 0) + 120000;
    guard = 0;
    const n0 = rt.delayHistory.length;
    while (rt.delayHistory.length === n0 && guard++ < 4000) transit.tick(1000);
    const after = rt.delayHistory[rt.delayHistory.length - 1];
    check('★ 就算 blockedMs 被硬加上去，公交的成因仍然是 congestion（"公交没有 blocked"这条口径是硬的）',
      after && after.cause !== 'blocked', after ? `cause=${after.cause} blockedSeconds=${after.blockedSeconds}` : '没有新记录');
    w.raw.close();
  }

  /* ═════════ 6. 对照：轨道车的晚点成因仍然是 blocked ═════════ */
  console.log('\n▶ 6. 对照（必须保持不变）：轨道车被前车压住 → 成因仍是 blocked');
  {
    const w = makeWorld({ minGapMeters: 200 });
    const { transit, user } = w;
    transit.speed = 20;
    const stops = [0, 4, 8].map((n, i) => transit.createStation(user, { name: '地铁站' + i, kind: 'rail', ...w.atRail(n) }).station.id);
    const line = transit.createLine(user, { name: '地铁 2 号线', kind: 'rail', stops }).line;
    const t1 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line.id }).vehicle;
    const t2 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line.id }).vehicle;
    const cache = transit.lineCache.get(line.id);
    const rt1 = transit._runtimeFor(t1.id);
    const rt2 = transit._runtimeFor(t2.id);
    // 前车钉在中间站上很久（占着站台），后车从首站出发去追它
    transit._dock(transit._st.vehicle.get(t1.id), cache, rt1, cache.path, cache.stops[1]);
    rt1.dwellUntil = transit.clockMs + 600000;
    rt2.distance = 0; rt2.speed = 0; rt2.direction = 1; rt2.state = 'run';
    rt2.needsServeAtStart = true; rt2.parkedAt = null; rt2.parkedIds = null; rt2.nextStepMs = 0;
    let guard = 0;
    while (!rt2.delayHistory.some((r) => r.cause === 'blocked') && guard++ < 8000) transit.tick(1000);
    const blockedRec = rt2.delayHistory.find((r) => r.cause === 'blocked');
    check('★ 轨道车被前车压住 → 成因 blocked（与 transit-delay-test 的口径一致，一个字没改）',
      !!blockedRec && blockedRec.blockedSeconds > 0 && blockedRec.congestionSeconds === 0,
      blockedRec ? `cause=${blockedRec.cause} 被压 ${blockedRec.blockedSeconds}s congestion=${blockedRec.congestionSeconds}s` : '没有 blocked 记录');
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
