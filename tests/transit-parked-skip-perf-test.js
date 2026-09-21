'use strict';
/**
 * 「停在起点站的车不再空转」的**性能 A/B 测量**（用户投诉：没有任务的车辆挂在起点站，很影响性能）。
 *
 * 背景：`_scheduleStep` 会把"没在跑这一趟"的班次车摆在首站（车厂）等点。
 * 这种车的位置、朝向、里程在整个等待期间**不可能发生变化**，所以主循环里加了一条跳过：
 *   `rt.nextStepMs = rt.departureMs`（下一次采样直接推到本车那一班的发车时刻），
 * 于是它们全部落进那条廉价跳过分支，不再每 3 游戏秒进一次 _stepVehicle。
 *
 * 本测试用人造底图 + 120 辆车 / 120 班（每辆车一班、首班在 01:00）在同一份世界里跑两次：
 *   · parkedSkip:false → 老行为（每辆车每小步都进 _stepVehicle）
 *   · parkedSkip:true  → 新行为（等点期间 0 次）
 * 并且断言**准点性没有被跳过影响**：第一班仍然精确在 01:00:00 发车。
 *
 *   node tests/transit-parked-skip-perf-test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-parked-skip');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.01;
const NODES = 12;
const RAIL_BASE = 1000;
const RAIL_WAY = 500;
const STOP_NODES = [0, 4, 8];

const VEHICLES = 120;             // 车辆数
const HEADWAY_SEC = 60;           // 流水班间隔 60 秒
const FIRST_SEC = 3600;           // 首班 01:00
const LAST_SEC = 3600 + HEADWAY_SEC * (VEHICLES - 1);
const MEASURE_SEC = 1800;         // 首班之前的 30 游戏分钟：全部车都在等点

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + '  → ' + detail); }
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
/** 造一个"120 辆车、每辆车一班、首班 01:00"的世界；parkedSkip 决定要不要那条跳过 */
function makeWorld(parkedSkip) {
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
    config: {
      dwellSeconds: 30, terminalDwellSeconds: 20,
      patienceSeconds: 1e9, cohortSeconds: 30, tripRatePerDay: 0,
      parkedSkip,
    },
  });
  const user = { id: 'u-perf', name: '性能测试', color: '#e6194b' };
  transit.ensureCompany(user);
  const at = (idx) => ({ lat: LAT, lon: lonOf(idx) });
  const stops = STOP_NODES.map((n, i) => transit.createStation(user, { name: '站' + i, kind: 'rail', ...at(n) }).station.id);
  const line = transit.createLine(user, {
    name: '性能线', kind: 'rail', stops,
    schedule: { mode: 'headway', headwaySec: HEADWAY_SEC, firstSec: FIRST_SEC, lastSec: LAST_SEC },
  }).line;
  const vehicles = [];
  for (let i = 0; i < VEHICLES; i++) vehicles.push(transit.createVehicle(user, { kind: 'metro_b4', lineId: line.id }).vehicle);
  transit.speed = 1;
  return { transit, vehicles, line, user };
}

/** 走 gameSec 游戏秒（speed=1 + tick(1000) = 1 游戏秒一小步），返回 {ms, vehSteps} */
function measure(transit, gameSec) {
  let vehSteps = 0;
  const orig = transit._stepVehicle.bind(transit);
  transit._stepVehicle = (...args) => { vehSteps += 1; return orig(...args); };
  const t0 = process.hrtime.bigint();
  let done = 0;
  let guard = 0;
  while (done < gameSec && guard++ < 400000) {
    const chunk = Math.min(1000, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  transit._stepVehicle = orig;
  return { ms, vehSteps };
}

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 等点车辆不再空转 · 性能 A/B ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  console.log(`▶ 场景：${VEHICLES} 辆车 / ${VEHICLES} 班（间隔 ${HEADWAY_SEC}s，首班 01:00），`
    + `测量首班之前的 ${MEASURE_SEC / 60} 游戏分钟\n`);

  console.log('▶ A. 老行为（parkedSkip:false，每辆车每小步都进 _stepVehicle）');
  const wOld = makeWorld(false);
  const old = measure(wOld.transit, MEASURE_SEC);
  check('A 组确实把车都步进了（说明对照组有效）', old.vehSteps > 10000,
    `${old.vehSteps} 次 _stepVehicle / ${old.ms.toFixed(0)} ms`);

  console.log('\n▶ B. 新行为（parkedSkip:true，等点期间直接跳过）');
  const wNew = makeWorld(true);
  // 跳过生效的前提是"每辆车都已经算出下一班"：先走一小段让 _scheduleStep 排班
  wNew.transit.tick(1000);
  const now = measure(wNew.transit, MEASURE_SEC);
  check('B 组几乎不再步进等点的车', now.vehSteps < old.vehSteps / 100,
    `${now.vehSteps} 次 vs 老行为 ${old.vehSteps} 次（省掉 ${(100 - (now.vehSteps / old.vehSteps) * 100).toFixed(2)}%）`);
  check('B 组墙钟时间明显更短', now.ms < old.ms,
    `A ${old.ms.toFixed(0)} ms → B ${now.ms.toFixed(0)} ms（${(old.ms / Math.max(1, now.ms)).toFixed(1)}× 快）`);

  console.log('\n▶ C. 跳过没有影响准点性（第一班必须精确在 01:00:00）');
  const wP = makeWorld(true);
  const { transit } = wP;
  // 走到首班之后一点点，看每一辆"有班次"的车是不是都在自己的时刻发的车
  let done = 0;
  while (done < FIRST_SEC + 120 && done < 20000) { transit.tick(1000); done += 1; }
  const dep = [];
  for (const v of wP.vehicles) {
    const rt = transit.runtime.get(v.id);
    if (rt && rt.scheduledDepartureMs != null) dep.push(rt.scheduledDepartureMs);
  }
  dep.sort((a, b) => a - b);
  const got = dep.slice(0, 3).map((ms) => Math.round(ms / 1000));
  check('至少在首班之后有车真的发车了', dep.length >= 2, `${dep.length} 辆已发车，发车时刻(秒)=${got.join(',')}`);
  /**
   * 只断言"已经发车的那几班"：间隔 60 秒、测量窗口只比首班多 120 秒，
   * 所以到这一刻只可能有 2 班（01:00:00 与 01:01:00）——第一版按 3 班断言是测试自己的错。
   * 关键是**逐班精确对上**（不早不晚），这正是"跳过等点车"最容易被写坏的地方。
   */
  const n = Math.min(3, dep.length);
  let exact = n >= 2;
  for (let i = 0; i < n; i++) if (got[i] !== FIRST_SEC + HEADWAY_SEC * i) exact = false;
  check('已发出的那几班与班次表完全一致（01:00:00 / 01:01:00…，不早不晚）',
    exact, `实际=${got.join(',')} 期望=${Array.from({ length: n }, (_, i) => FIRST_SEC + HEADWAY_SEC * i).join(',')}`);
} finally {
  /**
   * 不清临时目录：SQLite 句柄还开着（_st 的 prepared statement 持有文件），
   * 在 Windows 上 rmSync 会 EBUSY。下一轮开头的 rmSync 会在没有句柄时清掉它。
   */
}

console.log('\n' + '─'.repeat(56));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  · ' + f);
}
console.log('─'.repeat(56) + '\n');
process.exit(failed ? 1 : 0);
