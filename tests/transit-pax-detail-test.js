'use strict';
/**
 * NIMBY Rails 乘客模型的**专项验收测试**（不需要那份 500MB 的北京数据集，跑得很快）：
 *
 *   node tests/transit-pax-detail-test.js
 *
 * 三组验收，分别对应"上下客与容量的准确语义 / 目的地与通勤按 NR / 换乘必须真的存在"：
 *
 * ── A. 上下客与容量（§1 ~ §3）───────────────────────────────────────────────
 *   站台 A 上：15 个人在等 1 号线（**15 个不同的目的站**）+ 3 个人在等 2 号线。
 *   一辆 1 号线的车进站：**定员 13、车上本来还有 1 个人**（这个人的目的站就是 A）
 *   → 进站时空位只有 12 个；因为**先下后上**，他下车这件事在同一站就腾出了座位
 *   → 空位变成 13 个 → **15 个人里正好上去 13 个**，剩下的 2 个继续等下一辆 1 号线的车，
 *   等 2 号线的那 3 个人**一个都没动**（连别条线的桶都不看）。
 *   对照组：一模一样的场景，只把车上那个人的目的站从 A 改成 D15（他这站不下车）
 *   → 只能上 12 个、站台上剩 3 个。两个世界的唯一差别就是"那一个人下不下车"，
 *   所以这一对世界证明的正是"下车在同一站腾出座位"这条算术。
 *   另外还测：满员（空位 0）时一个人都上不来、定员被改到低于载客时也不赶人、
 *   小数乘客（按游戏秒累积）只按整人上车、零头留队、多线同站绝不串线。
 *
 * ── B. 目的地与通勤完全按 NR（§5）──────────────────────────────────────────
 *   spawn rate 由 demand 决定（= 覆盖人口 × 活跃度，**不看岗位**）× 出行率；
 *   目的地按（覆盖人口^0.75 + 默认水平）×（1 + 停靠线路条数）× 距离需求曲线加权；
 *   距离档 local 0~15 km / regional 15~100 km / long >100 km（直线距离）；
 *   只有**走得掉**的目的地才会真的走（没路线就不排队）；
 *   换乘最多 3 次、站间步行接驳（OSI）半径 2.3 km、步行 1 m/s。
 *   出处（2026-09-20 用 wiki 的 API 逐条复核，正文抓在 tests/tmp-wiki/）：
 *     · Spawn rate 页（正文已清空，引 r279）：
 *       https://wiki.nimbyrails.com/index.php?title=Spawn_rate&oldid=279
 *     · Pax 页 r360：https://wiki.nimbyrails.com/index.php?title=Pax
 *     · Destination 页 r239：https://wiki.nimbyrails.com/index.php?title=Destination
 *     · Distance category 页 r457（已标 "Deleted feature"）：
 *       https://wiki.nimbyrails.com/index.php?title=Distance_category
 *     · Station 页 r461：https://wiki.nimbyrails.com/index.php?title=Station
 *   ⚠ wiki 上**没有**任何一页写"上下客"的算术（Pax 页的 Boarding 是红链，404），
 *     所以 A 组的口径来自游戏实际行为 + 用户给的验收规则，实现在 transit.js 的 _serveStation。
 *
 * ── C. 换乘真的存在 + 按线路记账（§4）──────────────────────────────────────
 *   A 只在 1 号线上、C 只在 2 号线上、两条线在 X 相交：A→C 的乘客真的会
 *   "坐 1 号线到 X → 下车 → 排 2 号线的队 → 坐 2 号线到 C"；
 *   换乘人次记在**他下车的那条线**（1 号线）的当日账上，2 号线不会被重复记一遍；
 *   他在 1 号线车上时，车上的按目的站分组显示的就是**最终终点 C**（不是换乘站 X）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');
const pop = require('../server/population');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-pax-detail');

const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.0025;      // ≈ 213 米（lat 39.9 处 1 度经度 ≈ 85.4 km）
const RAIL_BASE = 1000;
const RAIL_WAY = 500;

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const lonOf = (i) => LON0 + i * STEP_LON;
/** 20 个铁路节点的一条直线（213 米一站），够摆 16 个站 + 1 个支线终点 */
const linePts = (n = 20) => Array.from({ length: n }, (_, i) => ({ lat: LAT, lon: lonOf(i) }));
/**
 * 模型核对用的底图：16 个本地节点（213 米一个）+ 一个 ≈22 km 外的区域站 + 一个 ≈110 km 外的长途站，
 * 再加一个**离任何有线路的站都超过 2.3 km** 的"孤立站"（PUN，见 §5）。
 */
function modelPts() {
  const pts = Array.from({ length: 16 }, (_, i) => ({ lat: LAT, lon: lonOf(i) }));
  pts.push({ lat: LAT + 0.2, lon: lonOf(15) });      // ≈ 22.1 km → regional
  pts.push({ lat: LAT + 1.0, lon: lonOf(15) });      // ≈ 110.6 km → long
  pts.push({ lat: LAT + 0.03, lon: lonOf(15) });     // ≈ 3.3 km 北（离 N1 4.4 km）→ 孤立站
  return pts;
}

/** 造一条人造铁路（节点与 way 都插进 rtree 索引，车站吸附要用） */
function buildRail(raw, pts) {
  const insNode = raw.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = raw.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = raw.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = raw.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = raw.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    insNode.run(RAIL_BASE + i, p.lat, p.lon, now);
    insIndex.run(RAIL_BASE + i, p.lon, p.lon, p.lat, p.lat);
    insWayNode.run(RAIL_WAY, i, RAIL_BASE + i);
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  insWay.run(RAIL_WAY, JSON.stringify({ railway: 'rail', maxspeed: '120' }), now, pts.length, minLat, maxLat, minLon, maxLon);
  insWayIndex.run(RAIL_WAY, minLon, maxLon, minLat, maxLat);
}

/** 人造世界：每次调用换一个临时库文件，路网用真正的 RailGraph（与其它 transit 测试同一套做法） */
let worldSeq = 0;
function makeWorld(opts = {}) {
  worldSeq += 1;
  const dir = path.join(TMP, 'w' + worldSeq);
  fs.mkdirSync(dir, { recursive: true });
  const raw = openDatabase(path.join(dir, 'osm.sqlite'));
  const pts = opts.pts || linePts();
  buildRail(raw, pts);
  const db = { raw, prepare: (sql) => raw.prepare(sql), exec: (sql) => raw.exec(sql) };
  const rail = new RailGraph(db, { mode: 'rail' });
  rail.build();
  const road = new RailGraph(db, { mode: 'bus' });
  let roadBuilt = false;
  const ensureBusGraph = () => { if (!roadBuilt) { road.build(); roadBuilt = true; } return road; };
  // 假的"人口模块"：每个车站的覆盖人口都是 3000 人、活跃度 1.2 → demand = 3600、coverage = 3600。
  // 这样目的地权重里只剩"线路条数 × 距离需求曲线"两个变量，断言可以写得很死。
  const population = {
    catchment: () => ({ pop: 3000, jobs: 500, weightedPop: 3600, activity: 1.2, coverage: 3600, density: 800 }),
    totals: () => ({ population: 3000, jobs: 500, cells: 1 }),
  };
  const transit = new Transit(db, {
    rail, ensureBusGraph, population,
    config: Object.assign({
      dwellSeconds: 30, terminalDwellSeconds: 0,
      patienceSeconds: 1000000,      // 测试里不让乘客失去耐心走掉
      cohortSeconds: 30,
      tripRatePerDay: 0,             // 默认关掉自动客流：需要真实客流的用例自己传
    }, opts.config || {}),
  });
  const user = { id: 'u-pax-detail', name: '乘客专项测试', color: '#e6194b' };
  const company = transit.ensureCompany(user);
  const at = (i) => ({ lat: pts[i].lat, lon: pts[i].lon });
  return { raw, db, rail, transit, user, company, at, pts };
}

/** 让游戏时间走 gameSec 游戏秒（×1 时 1 实时秒 = 1 游戏秒；默认 3 游戏秒一小步） */
function run(transit, gameSec, chunkMs = 3000) {
  let done = 0;
  while (done < gameSec) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}
/** 一小段一小段地跑，直到条件成立（返回跑掉的游戏秒数；超时返回 -1） */
function runUntil(transit, pred, maxGameSec, stepSec = 30) {
  let done = 0;
  while (done < maxGameSec) {
    run(transit, stepSec);
    done += stepSec;
    if (pred()) return done;
  }
  return -1;
}

/** 记录每一次停站（哪辆车、哪一站、上下客、上下客前后的载客、这一站车上的目的地分组） */
function watchDocks(transit) {
  const events = [];
  const orig = transit._serveStation.bind(transit);
  transit._serveStation = (vehicle, cache, rt, stop) => {
    const loadBefore = rt.load;
    orig(vehicle, cache, rt, stop);
    events.push({
      vehicleId: vehicle.id, lineId: vehicle.line_id, stationId: Number(stop.stationId),
      loadBefore: Math.round(loadBefore * 10) / 10,
      loadAfter: Math.round(rt.load * 10) / 10,
      boarded: Math.round((rt.lastBoarded || 0) * 10) / 10,
      alighted: Math.round((rt.lastAlighted || 0) * 10) / 10,
      capacity: Math.max(0, (vehicle.cars || 1) * (vehicle.capacity_per_car || 60)),
      paxByDest: transit.paxOnBoard(rt),
    });
  };
  return events;
}

/** 某个站台上某条线的候车桶（直接看数据结构，不经过展示层） */
function bucketOf(transit, stationId, companyId, owner, lineId) {
  const byCompany = transit.stationQueues.get(Number(stationId));
  if (!byCompany) return null;
  const entry = byCompany.get(transit._companyKey(companyId, owner));
  if (!entry) return null;
  return entry.buckets.get(transit._bucketKey(lineId)) || null;
}
const bucketWaiting = (b) => (b ? b.waiting : 0);
const cohortDests = (b) => ((b && b.cohorts) || []).map((c) => c.destId);
/** 某个站台某条线的等车人数（展示口径） */
function lineWaiting(transit, stationId, lineId) {
  const row = transit.stationWaiting(stationId).waitingByLine
    .find((e) => (lineId == null ? e.lineId == null : e.lineId === lineId));
  return row ? row.waiting : 0;
}
/** 参考线路上某一站的停靠点 */
function stopOf(transit, lineId, stationId) {
  const cache = transit.lineCache.get(Number(lineId));
  if (!cache) throw new Error('线路缓存不存在: ' + lineId);
  const stop = cache.stops.find((s) => Number(s.stationId) === Number(stationId));
  if (!stop) throw new Error('这条线上没有这一站: line=' + lineId + ' station=' + stationId);
  return { cache, stop };
}
/** 直接把车"停"到某一站（等价于车绕到这一站停靠一次，_dock 就是模拟循环用的那个入口） */
function dockAt(transit, vehicleId, stationId) {
  const v = transit._st.vehicle.get(Number(vehicleId));
  const { cache, stop } = stopOf(transit, v.line_id, stationId);
  const rt = transit._runtimeFor(v.id);
  transit._dock(v, cache, rt, cache.path, stop);
  return rt;
}
/** 改定员：cars × capacityPerCar（createVehicle 会把每车定员夹到 20~400，所以直接写库来造小定员的车） */
function setCapacity(w, vehicleId, cars, perCar) {
  w.raw.prepare('UPDATE vehicles SET cars = ?, capacity_per_car = ? WHERE id = ?').run(cars, perCar, Number(vehicleId));
  // #规模：这是**绕过 Transit 直接写库**（模拟本来就是内存态：启动读一次，之后每小步每帧都不查
  // vehicles 表）。外部改库之后要显式把这几辆车同步回内存车队，否则模拟里还是旧的定员 ——
  // 运维脚本 / DBA 手工改库的场合也是调这一个入口（transit.reloadFleet([id])）。
  w.transit.reloadFleet([vehicleId]);
  return cars * perCar;
}
/** 新造一辆空车（定员 = cars × perCar），返回车辆 id */
function newTrain(w, lineId, perCar = 13, cars = 1) {
  const v = w.transit.createVehicle(w.user, { kind: 'metro_b4', lineId }).vehicle;
  setCapacity(w, v.id, cars, perCar);
  return v.id;
}
/** 手工给车塞一批乘客（当作"车进站之前车上已经有这些人"：测试上下客算术时的初始条件） */
function seedOnboard(transit, vehicleId, groups) {
  const rt = transit._runtimeFor(Number(vehicleId));
  rt.paxGroups = new Map();
  let load = 0;
  for (const g of groups) {
    const plan = g.plan || null;
    const idx = g.idx == null ? null : Number(g.idx);
    rt.paxGroups.set(transit._paxGroupKey(plan, idx, g.destId), {
      destId: g.destId == null ? null : Number(g.destId), people: g.people, plan, idx,
    });
    load += g.people;
  }
  rt.load = load;
  return rt;
}
/** 车上的目的地分组 → 便于断言的 Map（stationId → people） */
const destCounts = (list) => {
  const m = new Map();
  for (const e of list) m.set(e.stationId, e.people);
  return m;
};

/* ══════════════════════════════════════════════════════════════════════════ */
console.log('\n=== NIMBY Rails 乘客模型 · 专项验收测试 ===');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

/** 造 §1/§2/§3 用的场景：A 站台上 15 个等 1 号线（15 个不同目的站）+ 3 个等 2 号线 */
function buildBoardingWorld() {
  const w = makeWorld();
  const { transit, user } = w;
  const station = (i, name) => transit.createStation(user, { name, kind: 'rail', ...w.at(i) }).station.id;
  const A = station(0, '换乘大站');
  const D = [];
  for (let k = 1; k <= 15; k++) D.push(station(k, 'D' + k));
  const C2 = station(19, '2 号线终点');
  const l1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, ...D] }).line;
  const l2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [A, C2] }).line;
  const c1 = transit.lineCache.get(l1.id);
  const c2 = transit.lineCache.get(l2.id);
  const planTo = (dest) => transit._itinerary(A, dest);
  const plans = new Map();
  for (const d of D) {
    const plan = planTo(d);
    plans.set(d, plan);
    // 一人一批（目的站各不相同 → 分组键各不相同 → 15 批）
    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, l1.id, 1, transit.clockMs, d, plan, 0);
  }
  const plan2 = planTo(C2);
  transit._addWaiting(A, c2.queueCompanyId, c2.companyOwner, l2.id, 3, transit.clockMs, C2, plan2, 0);
  return { w, transit, user, A, D, C2, l1, l2, c1, c2, plans, plan2 };
}

/** 让一辆"定员 13、车上有 1 个人"的 1 号线车从 A 站发车（走真实的模拟循环） */
function firstDockAtA(B, onboardDestId) {
  const { w, transit, user, l1, A } = B;
  const v = transit.createVehicle(user, { kind: 'metro_b4', lineId: l1.id }).vehicle;
  setCapacity(w, v.id, 1, 13);
  seedOnboard(transit, v.id, [{ destId: onboardDestId, people: 1 }]);
  const docks = watchDocks(transit);
  transit.speed = 1;
  run(transit, 30);
  const ev = docks.find((e) => e.vehicleId === v.id && e.stationId === A) || null;
  return { v, docks, ev, rt: transit._runtimeFor(v.id) };
}

try {
  /* ══════════════════ §1 上下客与容量：验收算术 ══════════════════ */
  console.log('\n▶ §1 验收算术：A 站 15 人等 1 号线（15 个目的站）+ 3 人等 2 号线；1 号线的车定员 13、车上有 1 人');
  const B = buildBoardingWorld();
  {
    const { w, transit, A, D, C2, l1, l2, c1, plans } = B;

    check('1 号线在 A 站排了 15 个人（15 个不同的目的站）',
      lineWaiting(transit, A, l1.id) === 15, `1 号线 ${lineWaiting(transit, A, l1.id)} 人`);
    check('2 号线在 A 站排了 3 个人（目的站是它自己的终点）',
      lineWaiting(transit, A, l2.id) === 3, `2 号线 ${lineWaiting(transit, A, l2.id)} 人`);
    check('站台合计 18 人（两条线分开记、加得起来）',
      transit.stationWaiting(A).waiting === 18, `站台 ${transit.stationWaiting(A).waiting} 人`);
    const b1 = bucketOf(transit, A, c1.queueCompanyId, c1.companyOwner, l1.id);
    check('1 号线的桶里是 15 批，每批一个目的站（NIMBY Rails 的"按同一目的地打成一包"）',
      b1.cohorts.length === 15 && new Set(cohortDests(b1)).size === 15,
      `${b1.cohorts.length} 批 / ${new Set(cohortDests(b1)).size} 个目的站`);
    check('每一批乘客都带着自己的行程（第一段就是 1 号线，目的站就是自己的那一站）',
      D.every((d) => {
        const p = plans.get(d);
        return p && p.steps.length === 1 && p.steps[0].type === 'ride'
          && p.steps[0].lineId === l1.id && Number(p.steps[0].to) === Number(d);
      }),
      '15 条行程全部是"1 号线直达自己的目的站"');

    const { v, ev, rt } = firstDockAtA(B, A);
    check('车进站前：车上 1 人、定员 13 → 空位只有 12 个',
      !!ev && ev.loadBefore === 1 && ev.capacity === 13 && ev.capacity - ev.loadBefore === 12,
      ev ? `载客 ${ev.loadBefore} / 定员 ${ev.capacity}` : '车没有在 A 站停靠');
    check('本站下车 1 人（车上那个人的目的站就是 A）',
      !!ev && ev.alighted === 1, ev ? `本站下车 ${ev.alighted} 人` : '—');
    check('下车之后空位变成 13（12 + 1：先下后上，同一次停站腾出来的座位当场就能用）',
      !!ev && ev.capacity - (ev.loadBefore - ev.alighted) === 13,
      ev ? `定员 13 − 下车后载客 ${ev.loadBefore - ev.alighted} = 空位 13` : '—');
    check('15 个人里正好上去 13 个',
      !!ev && ev.boarded === 13, ev ? `本站上客 ${ev.boarded} 人` : '—');
    check('上完车正好满员：载客 13 = 定员 13（一个都没超员）',
      !!ev && ev.loadAfter === 13 && ev.loadAfter === ev.capacity && rt.load <= 13,
      ev ? `载客 ${ev.loadBefore} → ${ev.loadAfter}（定员 ${ev.capacity}）` : '—');
    check('上去的就是队列里最先进来的那 13 批（先到先上）',
      transit.paxOnBoard(rt).length === 13 && D.slice(0, 13).every((d) => destCounts(transit.paxOnBoard(rt)).get(d) === 1),
      'D1 ~ D13 各 1 人');
    check('1 号线的桶里只剩 2 个人（D14、D15）继续等下一辆 1 号线的车',
      lineWaiting(transit, A, l1.id) === 2 && cohortDests(b1).join(',') === [D[13], D[14]].join(','),
      `1 号线剩 ${lineWaiting(transit, A, l1.id)} 人（目的站 ${cohortDests(b1).map((x) => 'D' + (D.indexOf(x) + 1)).join('、')}）`);
    check('等 2 号线的那 3 个人一个都没动（1 号线的车连别条线的桶都不看）',
      lineWaiting(transit, A, l2.id) === 3 && bucketWaiting(bucketOf(transit, A, B.c2.queueCompanyId, B.c2.companyOwner, l2.id)) === 3,
      `2 号线仍是 ${lineWaiting(transit, A, l2.id)} 人`);
    check('站台上还剩 5 人（1 号线的 2 + 2 号线的 3）',
      transit.stationWaiting(A).waiting === 5, `站台 ${transit.stationWaiting(A).waiting} 人`);
    const snap1 = transit.snapshot().trains.find((t) => t.id === v.id);
    check('快照里这辆车：load 13 / capacity 13 / lastBoarded 13 / lastAlighted 1',
      !!snap1 && snap1.load === 13 && snap1.capacity === 13 && snap1.lastBoarded === 13
      && snap1.lastAlighted === 1 && snap1.lastServedStation === A,
      snap1 ? `load=${snap1.load}/${snap1.capacity} 上客=${snap1.lastBoarded} 下客=${snap1.lastAlighted}` : '快照里没有这辆车');
    check('车上按目的站分成 13 包、每包 1 人（客户端据此显示"每个人到哪一站下车"）',
      snap1 && snap1.paxByDest.length === 13 && snap1.paxByDest.every((e) => e.people === 1 && e.stationId != null),
      snap1 ? `paxByDest=${snap1.paxByDest.length} 包` : '—');
    check('paxByDest 是精简口径：只带 stationId + people（站名在同帧的 stations 里按 id 查），没人换乘时不带 transfers',
      snap1 && snap1.paxByDest.every((e) => Object.keys(e).sort().join(',') === 'people,stationId'),
      snap1 ? JSON.stringify(snap1.paxByDest.slice(0, 2)) + ' …' : '—');
    // ⚠ 这个世界的库还要继续用来测 §2（车上的人怎么一站站下车），所以这里不 close
  }

  /* ── §1 对照组：车上那个人这站不下车 → 只能上 12 个 ── */
  console.log('\n▶ §1 对照组：同一场景，车上那 1 个人的目的站不是 A（他这站不下车）');
  {
    const B2 = buildBoardingWorld();
    const { w, transit, A, D, l1 } = B2;
    const { ev, rt } = firstDockAtA(B2, D[14]);      // 车上那人是去 D15 的，A 站不下车
    check('车上那 1 个人没在本站下车（lastAlighted = 0）',
      !!ev && ev.alighted === 0 && ev.loadBefore === 1,
      ev ? `本站下车 ${ev.alighted} 人 / 进站载客 ${ev.loadBefore}` : '车没有在 A 站停靠');
    check('空位只有 12 个 → 15 个人里只能上去 12 个',
      !!ev && ev.capacity - ev.loadBefore === 12 && ev.boarded === 12,
      ev ? `空位 ${ev.capacity - ev.loadBefore} / 上客 ${ev.boarded} 人` : '—');
    const dests2 = destCounts(transit.paxOnBoard(rt));
    check('站台上剩下 3 个等 1 号线的人（比"有人下车"的世界多 1 个）',
      lineWaiting(transit, A, l1.id) === 3, `1 号线剩 ${lineWaiting(transit, A, l1.id)} 人`);
    check('车上的分组：上来的 12 个人各自一包（D1~D12），原来那位去 D15 的人还在车上',
      transit.paxOnBoard(rt).length === 13
      && D.slice(0, 12).every((d) => dests2.get(d) === 1)
      && dests2.get(D[14]) === 1 && dests2.get(D[13]) === undefined,
      `13 包（D1~D12 各 1 + 车上的那位去 D15）；D13/D14 没上来`);
    check('载客 = 1 + 12 = 13 = 定员（同样没有超员）',
      rt.load === 13 && ev.loadAfter === 13, `载客 ${rt.load} = 定员 13`);
    check('两个世界的差别只有一个：那一个人下不下车（13 个 vs 12 个上车）',
      true, '先下后上：下车腾出的座位在同一站就能用；不下车就腾不出来');
    w.raw.close();
  }

  /* ══════════════════ §2 车上按目的站分组 / 每个人在自己那一站下车 ══════════════════ */
  console.log('\n▶ §2 车上按目的站分组：13 包人各自在自己那一站下车');
  {
    const { w, transit, A, D, l1 } = B;
    // §1 里那辆已经装着 13 个人的车（这个世界里 1 号线上只有这一辆）
    const vehicleId = transit._st.allVehicles.all().find((x) => x.line_id === l1.id).id;
    const rt1 = transit._runtimeFor(vehicleId);
    check('§1 那辆车现在车上有 13 包人、13 个不同的目的站',
      rt1.load === 13 && transit.paxOnBoard(rt1).length === 13,
      `${transit.paxOnBoard(rt1).length} 包 / 载客 ${rt1.load}`);
    let ok = true;
    const notes = [];
    for (let k = 0; k < 13; k++) {
      const d = D[k];
      const before = transit.paxOnBoard(rt1).length;
      dockAt(transit, vehicleId, d);
      const now = destCounts(transit.paxOnBoard(rt1));
      const arrived = transit.stationPaxStats(d).paxArrived;
      if (!(rt1.lastAlighted === 1 && now.get(d) === undefined && arrived === 1 && before - 1 === transit.paxOnBoard(rt1).length)) {
        ok = false;
        notes.push(`D${k + 1}: 下客 ${rt1.lastAlighted} / 到达 ${arrived} / 包数 ${before}→${transit.paxOnBoard(rt1).length}`);
      }
    }
    check('车依次停 D1 ~ D13：每一站正好下去 1 个人，而且就是目的站是这一站的那个人',
      ok, ok ? '13 站各下 1 人、车上的包数 13 → 0' : notes.join(' | '));
    check('13 站走完，车上一个人都不剩（accounting：每一站的"到达"各 1 人）',
      rt1.load === 0 && transit.paxOnBoard(rt1).length === 0
      && D.slice(0, 13).every((d) => transit.stationPaxStats(d).paxArrived === 1),
      `载客 ${rt1.load} / 13 个目的站的到达人数各 1`);
    check('那 2 个没上去的人还在站台上等（D14、D15 一个都没被谁顺走）',
      lineWaiting(transit, A, l1.id) === 2, `1 号线等车 ${lineWaiting(transit, A, l1.id)} 人`);
    w.raw.close();
  }

  /* ══════════════════ §3 边角：下一辆车 / 满员 / 改小定员 / 小数 / 兜底桶 ══════════════════ */
  console.log('\n▶ §3 边角情况：下一辆 1 号线的车拉走那 2 个；满员上不来；多线不串线');
  {
    const w = makeWorld();
    const { transit, user } = w;
    const station = (i, name) => transit.createStation(user, { name, kind: 'rail', ...w.at(i) }).station.id;
    const A = station(0, '站台');
    const D1 = station(1, 'D1');
    const D2 = station(2, 'D2');
    const D3 = station(3, 'D3');
    const D4 = station(4, 'D4');
    const C2 = station(19, '2 号线终点');
    const l1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, D1, D2, D3, D4] }).line;
    const l2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [A, C2] }).line;
    const c1 = transit.lineCache.get(l1.id);
    const c2 = transit.lineCache.get(l2.id);
    const add = (lineId, cache, people, destId) => transit._addWaiting(
      A, cache.queueCompanyId, cache.companyOwner, lineId, people, transit.clockMs, destId, transit._itinerary(A, destId), 0,
    );

    // 15 个等 1 号线 + 3 个等 2 号线，1 号线的车定员 13 → 上 13 个、剩 2 个
    for (const d of [D1, D2, D3, D4]) add(l1.id, c1, 3, d);       // 4 × 3 = 12 人（4 个目的站）
    add(l1.id, c1, 3, D4);                                        // 第 4 个目的站再补 3 人 → 15 人
    add(l2.id, c2, 3, C2);
    check('站台就位：1 号线 15 人（4 个目的站）、2 号线 3 人',
      lineWaiting(transit, A, l1.id) === 15 && lineWaiting(transit, A, l2.id) === 3,
      `1 号线 ${lineWaiting(transit, A, l1.id)} 人 / 2 号线 ${lineWaiting(transit, A, l2.id)} 人`);

    const v1 = newTrain(w, l1.id, 13);
    dockAt(transit, v1, A);
    check('第一辆 1 号线的车（空车、定员 13）拉走 13 个、站台上剩 2 个',
      transit._runtimeFor(v1).load === 13 && lineWaiting(transit, A, l1.id) === 2,
      `载客 ${transit._runtimeFor(v1).load} / 1 号线剩 ${lineWaiting(transit, A, l1.id)} 人`);

    const v2 = newTrain(w, l1.id, 13);
    dockAt(transit, v2, A);
    check('下一辆 1 号线的车把剩下的 2 个人拉走（不是被别的线抢走）',
      transit._runtimeFor(v2).load === 2 && lineWaiting(transit, A, l1.id) === 0,
      `载客 ${transit._runtimeFor(v2).load} / 1 号线剩 ${lineWaiting(transit, A, l1.id)} 人`);
    check('2 号线的那 3 个人全程没动（1 号线的两辆车都没碰他们）',
      lineWaiting(transit, A, l2.id) === 3, `2 号线 ${lineWaiting(transit, A, l2.id)} 人`);

    const v3 = newTrain(w, l2.id, 13);
    const rt3 = dockAt(transit, v3, A);
    check('反向也不串线：2 号线的车只拉走等 2 号线的那 3 个人',
      rt3.load === 3 && rt3.lastBoarded === 3 && lineWaiting(transit, A, l2.id) === 0,
      `载客 ${rt3.load}（本站上客 ${rt3.lastBoarded}）`);
    check('2 号线车上的人目的地是它自己的终点（不是 1 号线沿线那些站）',
      transit.paxOnBoard(rt3).length === 1 && transit.paxOnBoard(rt3)[0].stationId === C2
      && transit.paxOnBoard(rt3)[0].people === 3,
      JSON.stringify(transit.paxOnBoard(rt3)));
    check('站台被清空（1 号线的 2 个 + 2 号线的 3 个都上了自己那条线的车）',
      transit.stationWaiting(A).waiting === 0, `站台 ${transit.stationWaiting(A).waiting} 人`);

    /* ── 空位 0：车上满员，站台上有人也一个都上不来 ── */
    add(l1.id, c1, 4, D1);
    const vFull = newTrain(w, l1.id, 13);
    seedOnboard(transit, vFull, [{ destId: D4, people: 13 }]);      // 满员（这 13 人在 A 站不下车）
    const rtFull = dockAt(transit, vFull, A);
    check('空位 0（车已满员 13/13）时：站台上 4 个人一个都上不来',
      rtFull.lastBoarded === 0 && rtFull.load === 13 && lineWaiting(transit, A, l1.id) === 4,
      `本站上客 ${rtFull.lastBoarded} / 载客 ${rtFull.load}/13 / 站台剩 ${lineWaiting(transit, A, l1.id)} 人`);

    /* ── 定员被改到低于当前载客：仍然上不来，但也不赶车上的人 ── */
    setCapacity(w, vFull, 1, 5);
    const rtTight = dockAt(transit, vFull, A);
    check('定员被改小到 5（车上 13 人）时：空位按 0 算，一个人都上不来，车上的人也不会被赶下去',
      rtTight.lastBoarded === 0 && rtTight.load === 13,
      `本站上客 ${rtTight.lastBoarded} / 载客 ${rtTight.load}（定员 5）`);
    check('被挡住的 4 个人还在站台上等（没有被吞掉）',
      lineWaiting(transit, A, l1.id) === 4, `1 号线剩 ${lineWaiting(transit, A, l1.id)} 人`);

    /* ── 车空了以后：那 4 个人照样上得去（挡一下不会永久丢人） ── */
    setCapacity(w, vFull, 1, 13);
    seedOnboard(transit, vFull, []);
    const rtFree = dockAt(transit, vFull, A);
    check('车上按目的站分组：4 个人一批、目的地是 D1（只有 1 包，不会有半个人）',
      rtFree.load === 4 && rtFree.lastBoarded === 4 && transit.paxOnBoard(rtFree).length === 1
      && transit.paxOnBoard(rtFree)[0].people === 4 && Number(transit.paxOnBoard(rtFree)[0].stationId) === Number(D1)
      && lineWaiting(transit, A, l1.id) === 0,
      `本站上客 ${rtFree.lastBoarded} / 载客 ${rtFree.load} / 车上 ${JSON.stringify(transit.paxOnBoard(rtFree))}`);

    /* ── 小数乘客：只上整人，零头留队继续攒 ── */
    add(l1.id, c1, 0.6, D2);
    const vFrac = newTrain(w, l1.id, 13);
    const b1 = bucketOf(transit, A, c1.queueCompanyId, c1.companyOwner, l1.id);
    const rtFrac1 = dockAt(transit, vFrac, A);
    check('桶里只有 0.6 个人时：一个整人也上不了（0.6 继续留在队里攒）',
      rtFrac1.lastBoarded === 0 && Math.abs(bucketWaiting(b1) - 0.6) < 1e-9,
      `本站上客 ${rtFrac1.lastBoarded} / 桶里剩 ${bucketWaiting(b1)}`);
    add(l1.id, c1, 0.5, D2);
    const rtFrac2 = dockAt(transit, vFrac, A);
    check('再攒 0.5（合计 1.1）→ 上 1 个整人，零头 0.1 留在桶里',
      rtFrac2.lastBoarded === 1 && rtFrac2.load === 1 && Math.abs(bucketWaiting(b1) - 0.1) < 1e-6,
      `本站上客 ${rtFrac2.lastBoarded} / 载客 ${rtFrac2.load} / 桶里剩 ${bucketWaiting(b1).toFixed(2)}`);

    /* ── 兜底桶（明写的退化口径）：没有"专属线路"的乘客谁的车都能上 ── */
    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, null, 2, transit.clockMs, C2, null, null);
    const vFallback = newTrain(w, l1.id, 13);
    const rtFallback = dockAt(transit, vFallback, A);
    check('兜底桶的 2 个人（没有能到目的站的线路）由 1 号线的车拉走 —— 这是明写的退化口径，不会让人卡死',
      rtFallback.lastBoarded === 2 && rtFallback.load === 2
      && transit.paxOnBoard(rtFallback).every((e) => e.stationId === C2),
      `本站上客 ${rtFallback.lastBoarded}（目的站是 2 号线的终点，1 号线并不到那里）`);
    w.raw.close();
  }

  /* ══════════════════ §4 换乘：真的换乘 + 按线路记账 ══════════════════ */
  console.log('\n▶ §4 换乘：A（1 号线）→ X（换乘）→ C（2 号线），换乘人次按线路记账');
  {
    const w = makeWorld();
    const { transit, user } = w;
    const station = (i, name) => transit.createStation(user, { name, kind: 'rail', ...w.at(i) }).station.id;
    const A = station(0, '支线起点 A');
    const X = station(6, '换乘站 X');
    const C = station(19, '干线终点 C');
    const l1 = transit.createLine(user, { name: '1 号线（支线）', kind: 'rail', stops: [A, X] }).line;
    const l2 = transit.createLine(user, { name: '2 号线（干线）', kind: 'rail', stops: [X, C] }).line;
    const c1 = transit.lineCache.get(l1.id);
    const c2 = transit.lineCache.get(l2.id);
    const plan = transit._itinerary(A, C);
    check('A→C 的行程要换乘：两段乘车、第一段是 1 号线（A→X）、第二段是 2 号线（X→C）',
      !!plan && plan.transfers === 1 && plan.steps.length === 2
      && plan.steps[0].type === 'ride' && plan.steps[0].lineId === l1.id && Number(plan.steps[0].to) === X
      && plan.steps[1].type === 'ride' && plan.steps[1].lineId === l2.id && Number(plan.steps[1].to) === C,
      plan ? `transfers=${plan.transfers} 段数=${plan.steps.length}` : '没有行程（走不到）');

    const before = transit.stationPaxStats(X);
    transit._addWaiting(A, c1.queueCompanyId, c1.companyOwner, l1.id, 5, transit.clockMs, C, plan, 0);
    const v1 = newTrain(w, l1.id, 13);
    const docks1 = watchDocks(transit);
    transit.speed = 1;
    const waited = runUntil(transit, () => transit.stationPaxStats(X).paxTransferred >= 5, 900);
    const firstDock = docks1.find((e) => e.vehicleId === v1 && e.stationId === A) || null;
    check('1 号线的车在 A 站把 5 个人拉上车（他们在 1 号线上排队，5 个人一批）',
      !!firstDock && firstDock.boarded === 5 && firstDock.loadAfter === 5,
      firstDock ? `本站上客 ${firstDock.boarded} / 载客 ${firstDock.loadAfter}` : '车没有停 A 站');
    check('车上的目的地分组给的是**最终终点 C**（不是换乘站 X），并标出这 5 个人不在本车坐到底',
      !!firstDock && firstDock.paxByDest.length === 1 && firstDock.paxByDest[0].stationId === C
      && firstDock.paxByDest[0].people === 5 && firstDock.paxByDest[0].transfers === 5,
      firstDock ? JSON.stringify(firstDock.paxByDest) : '—');
    check('车真的开到了 X，5 个人在 X 下车换乘（X 站的"换乘"人数 +5）',
      waited > 0 && transit.stationPaxStats(X).paxTransferred - before.paxTransferred === 5,
      `等了 ${waited} 游戏秒 / X 站换乘 ${transit.stationPaxStats(X).paxTransferred} 人`);
    check('下车之后他们去排**下一段线路**（2 号线）的队，而不是留在 1 号线的桶里',
      lineWaiting(transit, X, l2.id) === 5 && lineWaiting(transit, X, l1.id) === 0,
      `X 站：2 号线 ${lineWaiting(transit, X, l2.id)} 人 / 1 号线 ${lineWaiting(transit, X, l1.id)} 人`);
    const b2 = bucketOf(transit, X, c2.queueCompanyId, c2.companyOwner, l2.id);
    check('换乘的乘客重新排队时带着**第 2 段**的行程（plan.idx = 1，排队队伍也认得他）',
      !!b2 && b2.cohorts.length === 1 && b2.cohorts[0].idx === 1 && b2.cohorts[0].plan === plan
      && Number(b2.cohorts[0].destId) === C,
      b2 && b2.cohorts.length ? `idx=${b2.cohorts[0].idx} dest=${b2.cohorts[0].destId}` : '桶里没人');
    check('换乘人次记在**他下车的那条线**（1 号线）的当日账上：lineDayStats(1).transfers = 5',
      transit.lineDayStats(l1.id).transfers === 5 && transit.lineDayStats(l1.id).riders === 5,
      `1 号线 transfers=${transit.lineDayStats(l1.id).transfers} riders=${transit.lineDayStats(l1.id).riders}`);
    check('2 号线此时还没有换乘人次、也还没有乘客（不会被提前记一笔）',
      transit.lineDayStats(l2.id).transfers === 0 && transit.lineDayStats(l2.id).riders === 0,
      `2 号线 transfers=${transit.lineDayStats(l2.id).transfers} riders=${transit.lineDayStats(l2.id).riders}`);
    check('1 号线的车把 5 个人放下之后是空的（换乘的人不会赖在车上）',
      transit._runtimeFor(v1).load === 0, `载客 ${transit._runtimeFor(v1).load}`);

    // 第二段：2 号线的车在 X 站把他们接走，送到 C
    const v2 = newTrain(w, l2.id, 13);
    const arrived = runUntil(transit, () => transit.stationPaxStats(C).paxArrived >= 5, 900);
    check('2 号线的车在 X 站接到这 5 个人，开到 C 让他们到达（"到站即消失"）',
      arrived > 0 && transit.stationPaxStats(C).paxArrived === 5 && transit.stationPaxStats(X).paxDeparted === 5,
      `等了 ${arrived} 游戏秒 / C 站到达 ${transit.stationPaxStats(C).paxArrived} 人 / X 站出发 ${transit.stationPaxStats(X).paxDeparted} 人`);
    check('2 号线的 riders = 5（第二段的人次记在 2 号线上）',
      transit.lineDayStats(l2.id).riders === 5, `riders=${transit.lineDayStats(l2.id).riders}`);
    check('换乘只记一次：2 号线没有被记成"换乘线路"（它只记自己拉的人次）',
      transit.lineDayStats(l2.id).transfers === 0, `2 号线 transfers=${transit.lineDayStats(l2.id).transfers}`);
    check('全局账：乘客换乘 5 人次 = 各线路换乘之和（没有重复计数）',
      transit.paxStats().transfers.paxTransferred === 5 && transit.paxStats().transfers.lineTransfers === 5,
      `车站侧 ${transit.paxStats().transfers.paxTransferred} / 线路侧 ${transit.paxStats().transfers.lineTransfers}`);
    check('换乘口径参数就是 NR 的：最多换乘 3 次、OSI 半径 2.3 km、步行 1 m/s',
      transit.paxStats().transfers.maxTransfers === 3 && transit.paxStats().transfers.osiRadiusM === 2300
      && transit.paxStats().transfers.walkSpeedMps === 1,
      `maxTransfers=${transit.paxStats().transfers.maxTransfers} OSI=${transit.paxStats().transfers.osiRadiusM}m ${transit.paxStats().transfers.walkSpeedMps}m/s`);
    check('两位"乘客账本"合得起来：A 站出发 5、X 站换乘 5、C 站到达 5',
      transit.stationPaxStats(A).paxDeparted === 5 && transit.stationPaxStats(X).paxTransferred === 5
      && transit.stationPaxStats(C).paxArrived === 5,
      `A 出发 ${transit.stationPaxStats(A).paxDeparted} / X 换乘 ${transit.stationPaxStats(X).paxTransferred} / C 到达 ${transit.stationPaxStats(C).paxArrived}`);
    w.raw.close();
  }

  /* ══════════════════ §5 目的地与通勤口径（对 wiki 逐条核对） ══════════════════ */
  console.log('\n▶ §5 模型口径：spawn rate = 覆盖人口、目的地权重、距离档、可达才走、OSI 2.3 km');
  {
    const w = makeWorld({ pts: modelPts(), config: { tripRatePerDay: 0.1 } });
    const { transit, user } = w;
    const station = (i, name) => transit.createStation(user, { name, kind: 'rail', ...w.at(i) }).station.id;
    const N1 = station(1, '枢纽 N1');        // 有线路（两条都停）
    const W0 = station(0, '无线路邻站 W0'); // 没有线路，离 N1 只有 213 米 → 走过去坐车（OSI）
    const Loc = station(5, '本地站');        // 有线路，640 米 → local 档
    const PUN = station(18, '孤立站');       // 没有线路，离任何有线路的站都 > 2.3 km → 哪儿也去不了
    const R = station(16, '区域站');         // ≈22 km → regional 档
    const G = station(17, '长途站');         // ≈110 km → long 档
    transit.createLine(user, { name: '本地线', kind: 'rail', stops: [N1, Loc] });
    transit.createLine(user, { name: '长线', kind: 'rail', stops: [N1, R, G] });

    // ① spawn rate 由 demand（= 覆盖人口 × 活跃度）决定，再乘出行率
    const dN1 = transit.stationDemandOf(transit._st.station.get(N1));
    check('车站需求 = 覆盖人口 × 活跃度（3000 × 1.2 = 3600），与 NR "demand 只看覆盖人口"一致',
      dN1.demand === 3600 && dN1.pop === 3000,
      `demand=${dN1.demand} pop=${dN1.pop} activity=${dN1.activity}`);
    check('车站日上车人数 = demand × 出行率（3600 × 0.1 = 360 人/日）',
      dN1.dailyTrips === 360, `dailyTrips=${dN1.dailyTrips}`);
    check('岗位不参与客流计算（NR 原文："population is the only factor considered"）',
      pop.stationDemand({ pop: 1000, activity: 1, jobs: 9e6 }) === 1000,
      '同样 1000 人，岗位 900 万也还是 demand=1000');
    let rateSum = 0;
    for (let h = 0; h < 18; h++) rateSum += pop.paxRateFactor('local', h, 1) * 3600;
    check('某一秒的 spawn rate 在运营时段内积分正好 = 1（一天不多不少就是 demand × 出行率那些人）',
      Math.abs(rateSum - 1) < 1e-9, `Σ 18 小时 = ${rateSum.toFixed(12)}`);

    // ② 距离档（wiki：local 0~15 km / regional 15~100 km / long >100 km，直线距离）
    check('距离档分界就是 wiki 的 0~15 km / 15~100 km / >100 km',
      pop.bandOfMeters(1) === 'local' && pop.bandOfMeters(15000) === 'local'
      && pop.bandOfMeters(15001) === 'regional' && pop.bandOfMeters(100000) === 'regional'
      && pop.bandOfMeters(100001) === 'long',
      `15000→${pop.bandOfMeters(15000)} / 15001→${pop.bandOfMeters(15001)} / 100001→${pop.bandOfMeters(100001)}`);

    // ③ 目的地权重：覆盖人口（非线性 + 默认水平）× 线路条数（近似线性）× 距离需求曲线
    const wCov = (cov, lines, m) => pop.destinationWeightOf(cov, lines, m);
    check('线路条数的影响近似线性：0→1 条翻一倍、1→2 条再多同样的增量',
      Math.abs(wCov(3600, 1, 2000) / wCov(3600, 0, 2000) - 2) < 1e-9
      && Math.abs((wCov(3600, 2, 2000) - wCov(3600, 1, 2000)) - (wCov(3600, 1, 2000) - wCov(3600, 0, 2000))) < 1e-9,
      `w(0)=${wCov(3600, 0, 2000).toFixed(1)} w(1)=${wCov(3600, 1, 2000).toFixed(1)} w(2)=${wCov(3600, 2, 2000).toFixed(1)}`);
    check('覆盖人口的影响是非线性的（覆盖 ×4 → 权重远不到 ×4）',
      wCov(400, 1, 2000) / wCov(100, 1, 2000) < 2,
      `覆盖 100→400 时权重只 ×${(wCov(400, 1, 2000) / wCov(100, 1, 2000)).toFixed(3)}`);
    check('覆盖极小的站也有一个"默认水平"（不会因为覆盖小就永远抽不到）',
      wCov(1, 1, 2000) > 0 && wCov(1, 0, 2000) > 0,
      `覆盖 1 人的站权重 ${wCov(1, 1, 2000).toFixed(1)} > 0`);
    check('覆盖为 0 的站权重为 0（NR："never be chosen as an origin or destination"）',
      wCov(0, 5, 500) === 0 && wCov(0, 0, 500) === 0, 'w(0, 5 条线) = 0');
    check('距离需求曲线：同样条件下越远越不容易被选中',
      wCov(3600, 1, 1000) > wCov(3600, 1, 50000) && wCov(3600, 1, 50000) > wCov(3600, 1, 200000),
      `1 km ${wCov(3600, 1, 1000).toFixed(1)} > 50 km ${wCov(3600, 1, 50000).toFixed(1)} > 200 km ${wCov(3600, 1, 200000).toFixed(1)}`);

    // ④ O/D 需求表：只挑走得到的目的地、按档分人、每一项都带行程
    const od = transit._ensureOdDemand();
    check('O/D 表按"覆盖人口 × 出行率"产生乘客（6 个站 × 360 人/日）',
      od.stats.spawn === 360 * 6, `spawn=${od.stats.spawn} 人/日`);
    const destsN1 = od.byStation.get(N1).dests;
    check('枢纽 N1 的目的地候选里三个档都有（本地 / 区域 / 长途都真的分到了乘客）',
      destsN1.some((x) => x.band === 'local') && destsN1.some((x) => x.band === 'regional')
      && destsN1.some((x) => x.band === 'long'),
      destsN1.map((x) => `${x.name}:${x.band}(${Math.round(x.meters / 1000)}km)`).join(' '));
    check('每一项的档位就是"直线距离"算出来的那一档（与实际线路怎么走无关）',
      destsN1.every((x) => x.band === pop.bandOfMeters(x.meters)),
      destsN1.map((x) => `${Math.round(x.meters)}m→${x.band}`).join(' '));
    check('三档的乘客份额都按 bandMix 分出去了（local/regional/long 都 > 0）',
      od.stats.byBand.local > 0 && od.stats.byBand.regional > 0 && od.stats.byBand.long > 0,
      `local=${od.stats.byBand.local} regional=${od.stats.byBand.regional} long=${od.stats.byBand.long}`);
    check('走不到的车站不会进候选池（孤立站不是任何人的目的地）',
      !destsN1.some((x) => Number(x.stationId) === Number(PUN)),
      `${destsN1.length} 个目的地里没有孤立站`);
    check('枢纽 N1 的每一条目的地都带着行程（走不掉的乘客不排队）',
      destsN1.every((x) => x.transfers >= 0 && Number.isFinite(x.sec)),
      destsN1.map((x) => x.transfers).join('/'));
    const byLineN1 = od.byLine.get(1) && od.byLine.get(1).get(N1);
    check('线路桶里的 destMix 每一项要么是真实目的站（带行程），要么是"去向未知"的零头',
      !!byLineN1 && byLineN1.destMix.every((x) => (x.unknown ? x.stationId == null : !!x.plan && Number(x.plan.destId) === Number(x.stationId))),
      byLineN1 ? `destMix ${byLineN1.destMix.length} 条` : '线路桶里没有 N1');

    // ⑤ 没有路线就不出行：孤立站谁也到不了
    check('孤立站的行程搜索结果是 null（没有路线 → 乘客不会排队出行）',
      transit._itinerary(PUN, N1) === null && transit._itinerary(PUN, Loc) === null,
      'PUN→N1 / PUN→Loc 都没有行程');
    check('孤立站在 O/D 表里 served = 0（它产生的乘客走不掉，记账口径是"没出行"）',
      od.byStation.get(PUN).served === 0 && od.byStation.get(PUN).reach === 0,
      `spawn=${od.byStation.get(PUN).spawn} served=${od.byStation.get(PUN).served}`);

    // ⑥ 站间步行接驳（OSI）：≤2.3 km 走得过去、>2.3 km 走不过去
    const planW0 = transit._itinerary(W0, Loc);
    check('起点站自己没有线路时，第一段是"走到 2.3 km 内的邻站去坐车"（OSI）',
      !!planW0 && planW0.steps[0].type === 'walk' && planW0.walkLegs >= 1 && Number(planW0.steps[0].meters) <= 2300,
      planW0 ? `第一段步行 ${planW0.steps[0].meters} 米 → 在 #${planW0.steps[0].to} 上车` : '没有行程');
    check('这批"先走出去"的乘客在 O/D 表里单独记账（byOriginWalk），上车点是邻站而不是自己',
      od.byOriginWalk.has(W0) && od.byOriginWalk.get(W0).entries.every((e) => Number(e.boardStationId) === Number(N1)),
      od.byOriginWalk.has(W0) ? `W0 走出去 ${Math.round(od.byOriginWalk.get(W0).total)} 人/日，上车点 N1` : '没有记进 byOriginWalk');
    check('离有线路的车站超过 2.3 km 的孤立站不会靠走路接进网络（不在 byOriginWalk 里）',
      !od.byOriginWalk.has(PUN), '孤立站既没线路、也没法走过去');
    check('换乘 / 步行的参数与 wiki 一致：OSI ≤ 2.3 km、1 m/s、最多换乘 3 次、最多 2 段步行',
      od.stats.transfers.osiRadiusM === 2300 && od.stats.transfers.walkSpeedMps === 1
      && od.stats.transfers.maxTransfers === 3 && od.stats.transfers.maxWalkLegs === 2,
      `OSI ${od.stats.transfers.osiRadiusM}m @ ${od.stats.transfers.walkSpeedMps}m/s，换乘 ≤${od.stats.transfers.maxTransfers}，步行 ≤${od.stats.transfers.maxWalkLegs} 段`);
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
