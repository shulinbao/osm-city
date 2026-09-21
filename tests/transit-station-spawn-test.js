'use strict';
/**
 * 用户投诉 #1 专项测试：**新建车站必须立刻产生乘客**（不许等到跨天），
 * 外加用户要求的"缓存指纹自检"（odStats().staleRecomputes）。
 *
 *   node tests/transit-station-spawn-test.js
 *
 * 背景（根因）：O/D 需求表（_ensureOdDemand）与行程图（_ensureItineraryGraph）都是**缓存**，
 * 缓存键只看"游戏日 + 人口网格版本"。所以"新建的车站要等到跨天才进表"这种病，
 * 只有靠"每个改动路径都记得调 _dropOdCache()"来防。历史上 createStation 就漏过一轮
 * （车站建好了，站台上一个人都不来，跨天忽然就有了）。上一轮补上了那次作废，
 * 本测试要证明四件事：
 *   ① 新建车站 + 加进已有线路之后，**一个游戏分钟之内**这个站就有人等车（waiting > 0），
 *      而且 O/D 表（byStation / byLine）与行程图（linesOf）确实已经为新车站重建过；
 *   ② 改覆盖范围 / 挪位置 / 改类型同样立刻生效（线路缓存里"抄自车站行"的覆盖半径要跟着刷，
 *      否则沿线需求还会按旧半径算）；
 *   ③ **指纹自检**：谁绕过 op 直接改库（撤销直改表、导入、将来的新路径），
 *      下一个 tick 就会被发现 → 同一个 tick 内重建，并记进 odStats().staleRecomputes；
 *      而**正常走 op 的改动不许被误报**（staleRecomputes 必须保持 0）；
 *   ④ config.transit.staleCacheCheck = false 时自检整个关掉（可关的廉价开关）。
 *
 * 世界是人造底图（与 transit-depot-test.js 同一套做法）：一条 12 节点的直线铁路，
 * 车站取第 0 / 4 / 6 / 8 号节点 —— 第 6 号节点在 4 与 8 之间，正好用来演"中途新建一个站"。
 * 人口模块用桩：覆盖人口 = 覆盖半径（米），于是"覆盖半径改了"这件事在需求数字上看得见。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-station-spawn');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.01;        // ≈ 854 米一个节点
const NODES = 12;
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
  // 人口桩：覆盖人口 = 覆盖半径（米）→ "改了覆盖范围"在 demand / dailyTrips 上看得见；
  // version 就是人口网格版本号（改建筑时 +1），交通侧靠它作废缓存。
  const population = {
    version: 1,
    day: 1,
    setDay(d) { this.day = d; },
    catchment: (lat, lon, r) => ({ pop: Math.round(Number(r) || 0), jobs: 0, weightedPop: Math.round(Number(r) || 0), activity: 1 }),
    totals: () => ({ population: 1000, jobs: 0, cells: 1 }),
  };
  const transit = new Transit(db, {
    rail, ensureBusGraph, population,
    config: Object.assign({
      dwellSeconds: 30, terminalDwellSeconds: 20,
      patienceSeconds: 1e9, cohortSeconds: 30,
      // 让"一个游戏分钟"内的人数明显 > 0：日出行率 20 次/人、运营时段压到 1 小时
      tripRatePerDay: 20, serviceHours: 1,
    }, config || {}),
  });
  const user = { id: 'u-spawn', name: '测试玩家', color: '#e6194b' };
  const company = transit.ensureCompany(user);
  const at = (idx) => ({ lat: LAT, lon: lonOf(idx) });
  return { raw, db, rail, population, transit, user, company, at };
}

/** 让游戏时间走 gameSec 游戏秒（3 游戏秒一小步） */
function run(transit, gameSec, chunkMs = 3000) {
  let done = 0;
  let guard = 0;
  while (done < gameSec && guard++ < 200000) {
    const chunk = Math.min(chunkMs, Math.ceil(((gameSec - done) * 1000) / transit.speed));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

/** 一条线路 + 若干车站 + 一辆车；stations 是要建站的节点号 */
function makeLine(w, nodes, opts = {}) {
  const { transit, user } = w;
  const stations = nodes.map((n, i) => transit.createStation(user, {
    name: (opts.prefix || 'S') + i, kind: opts.kind || 'rail', ...w.at(n),
  }).station.id);
  const line = transit.createLine(user, {
    name: opts.name || '测试线', kind: opts.kind || 'rail', stops: stations, schedule: opts.schedule || null,
  }).line;
  if (opts.vehicles !== 0) transit.createVehicle(user, { kind: opts.vehicleKind || 'metro_b4', lineId: line.id });
  return { line, stations, cache: transit.lineCache.get(line.id) };
}

const waitOf = (t, id) => t.stationWaiting(id).waiting;
const odOf = (t, id) => t._ensureOdDemand().byStation.get(Number(id)) || null;

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 新建车站立刻产生乘客 + 缓存指纹自检 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ═════════ 1. 新建车站 + 加进已有线路 → 一个游戏分钟内就有乘客 ═════════ */
  console.log('▶ 1. 新建车站并加进已有线路：一个游戏分钟内 waiting > 0，O/D 表与行程图已重建');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 20;
    const { line, stations } = makeLine(w, [0, 4, 8]);
    run(transit, 120);
    const base = stations.map((id) => waitOf(transit, id));
    check('基线：线路上三个站都在产生乘客（世界本身没问题）',
      base.every((n) => n > 0), `waiting = ${base.join(' / ')}`);
    const serialBefore = transit._od ? transit._od.serial : 0;
    const odBefore = transit.odStats();

    // 中途新建一个车站（第 6 号节点在 4 与 8 之间，吸附到同一条铁路上），然后加进线路
    const fresh = transit.createStation(user, { name: '新站', kind: 'rail', ...w.at(6) }).station.id;
    transit.apply(user, { k: 'line.update', id: line.id, stops: [stations[0], stations[1], fresh, stations[2]] });

    const odAfter = transit.odStats();
    const entry = odOf(transit, fresh);
    check('★ 新建车站 + 加进线路之后：O/D 需求表立刻重建（构建序号 +1、车站数 +1）',
      odAfter.stations === odBefore.stations + 1 && (transit._od.serial || 0) > serialBefore,
      `stations ${odBefore.stations} → ${odAfter.stations}，serial ${serialBefore} → ${transit._od.serial}`);
    check('★ 新车站已经在 O/D 表里当起点（byStation 有它、spawn / served 都 > 0）',
      !!entry && entry.spawn > 0 && entry.served > 0 && entry.dests.length > 0,
      entry ? `spawn=${entry.spawn} served=${entry.served} 目的站 ${entry.dests.length} 个` : 'O/D 表里没有这个站');
    const graph = transit._itinGraph;
    const linesOfNew = graph ? (graph.linesOf.get(Number(fresh)) || []) : [];
    check('★ 行程图（换乘 / 站间步行的那张图）也重建了：新车站已经挂在这条线路上',
      !!graph && graph.stations.has(Number(fresh)) && linesOfNew.length === 1
        && Number(linesOfNew[0].lineId) === Number(line.id),
      graph ? `行程图车站 ${graph.stations.size} 个，新站挂了 ${linesOfNew.length} 条线路` : '行程图不存在');
    const cache = transit.lineCache.get(line.id);
    const stopNew = cache.stops.find((s) => Number(s.stationId) === Number(fresh));
    check('线路缓存（lineCache）的停站明细里已经有新车站，且这条线在它这儿能拉到人（boardByBand > 0）',
      !!stopNew && (stopNew.boardByBand.local + stopNew.boardByBand.regional + stopNew.boardByBand.long) > 0,
      stopNew ? `boardByBand=${JSON.stringify(stopNew.boardByBand)}` : '停站明细里没有新车站');

    // 关键断言：走 60 游戏秒（一个游戏分钟）之后，这个站上必须有人在等车
    const before = waitOf(transit, fresh);
    run(transit, 60);
    const after = waitOf(transit, fresh);
    check('★★ 一个游戏分钟之内，新车站上出现等车的乘客（waiting > 0，用户口径）',
      after > 0 && after > before,
      `60 游戏秒前 ${before} 人 → 之后 ${after} 人`);
    check('新车站的乘客账本也记上了（stationPublic 的 waiting / dailyTrips 都读得到）',
      transit.stationPublic(transit._st.station.get(fresh)).waiting === after
      && transit.stationPublic(transit._st.station.get(fresh)).dailyTrips > 0,
      `waiting=${transit.stationPublic(transit._st.station.get(fresh)).waiting}`);
    w.raw.close();
  }

  /* ═════════ 2. 改覆盖范围 / 挪位置 / 改类型：立刻生效 ═════════ */
  console.log('\n▶ 2. 改车站的覆盖范围 / 位置 / 类型：立刻生效（不许等跨天）');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 20;
    const { line, stations } = makeLine(w, [0, 4, 8]);
    run(transit, 30);
    const target = stations[1];
    const cache = transit.lineCache.get(line.id);
    const stopRef = cache.stops.find((s) => Number(s.stationId) === Number(target));
    // ⚠ 要取**数字快照**：lineCache.stops 里的对象是活的，_dropDemandCache 会就地改它
    const radiusBefore = stopRef.catchmentM;
    const demandBefore = stopRef.demand;
    const serialBefore = transit._od.serial;

    transit.apply(user, { k: 'station.update', id: target, catchmentM: 2500 });
    // 从对外接口读（linePublic 会顺手把这条线的需求合计按新口径重算一次，与玩家看到的完全一致）
    const pub1 = transit.linePublic(transit._st.line.get(line.id));
    const stopAfter = pub1.stopsInfo.find((s) => Number(s.stationId) === Number(target));
    check('★ 改了覆盖范围：线路缓存里那一站的覆盖半径**立刻**跟上（不是等下一次重建路径）',
      stopAfter.catchmentM === 2500 && radiusBefore !== 2500,
      `${radiusBefore} → ${stopAfter.catchmentM}`);
    check('★ 沿线需求按新半径重算（demand / dailyTrips 立刻变大），O/D 表也重建过',
      stopAfter.demand > demandBefore && stopAfter.dailyTrips > (demandBefore * 20)
      && (transit._od.serial || 0) > serialBefore,
      `demand ${demandBefore} → ${stopAfter.demand}，serial ${serialBefore} → ${transit._od.serial}`);

    // 挪位置（第 4 → 第 5 号节点）与改类型：同样立刻反映到需求缓存与线路缓存
    transit.apply(user, { k: 'station.update', id: target, ...w.at(5) });
    const moved = transit._st.station.get(target);
    const pub2 = transit.linePublic(transit._st.line.get(line.id));
    const stopMoved = pub2.stopsInfo.find((s) => Number(s.stationId) === Number(target));
    check('★ 挪了车站位置：线路缓存里的坐标立刻跟上（覆盖人口因此按新位置算）',
      stopMoved.lat === moved.lat && stopMoved.lon === moved.lon,
      `缓存 ${stopMoved.lon} vs 库 ${moved.lon}`);

    // 类型从 rail 改成 subway，然后走一步：需求缓存与 O/D 都不许还拿着旧口径
    const serialBefore2 = transit._od.serial;
    transit.apply(user, { k: 'station.update', id: target, kind: 'subway' });
    check('★ 改了车站类型：O/D 表与需求缓存立刻作废重建（构建序号 +1）',
      transit._st.station.get(target).kind === 'subway' && (transit._od.serial || 0) > serialBefore2,
      `kind=${transit._st.station.get(target).kind}，serial ${serialBefore2} → ${transit._od.serial}`);
    w.raw.close();
  }

  /* ═════════ 3. 缓存指纹自检（odStats().staleRecomputes） ═════════ */
  console.log('\n▶ 3. 缓存指纹自检：正常 op 不误报；绕过 op 的改动一个 tick 内被兜住');
  {
    const w = makeWorld();
    const { transit, user } = w;
    transit.speed = 20;
    const { line, stations } = makeLine(w, [0, 4, 8]);
    run(transit, 60);
    const s0 = transit.odStats();
    check('指纹自检的计数已经对外暴露（odStats().staleChecks / staleRecomputes / cacheStamp）',
      Number.isFinite(s0.staleChecks) && s0.staleRecomputes === 0 && Number.isFinite(s0.cacheStamp),
      `staleChecks=${s0.staleChecks} staleRecomputes=${s0.staleRecomputes} stamp=${s0.cacheStamp}`);

    // ① 正常走 op：createStation / line.update / station.update 都已经自己作废缓存 → 不许误报
    const fresh = transit.createStation(user, { name: '正常新站', kind: 'rail', ...w.at(6) }).station.id;
    transit.apply(user, { k: 'line.update', id: line.id, stops: [stations[0], stations[1], fresh, stations[2]] });
    transit.apply(user, { k: 'station.update', id: fresh, catchmentM: 1800 });
    run(transit, 60);
    check('★ 正常走 op 的改动**不被误报**（op 自己作废了缓存 → staleRecomputes 保持 0）',
      transit.odStats().staleRecomputes === 0 && transit.odStats().staleChecks > s0.staleChecks,
      `staleChecks=${transit.odStats().staleChecks} staleRecomputes=${transit.odStats().staleRecomputes}`);

    // ② 绕过 op 直接改库（模拟"忘了作废缓存"的老路径：撤销直改表 / 导入 / 将来新加的 op）
    const before = transit.odStats();
    const stopBefore = transit.lineCache.get(line.id).stops.find((s) => Number(s.stationId) === Number(stations[1]));
    const demandBefore = stopBefore.demand;
    w.db.prepare('UPDATE stations SET catchment_m = ? WHERE id = ?').run(2900, stations[1]);
    check('直接改库之后（还没 tick）：缓存里的覆盖半径与需求都还是旧的 —— 这正是要被抓到的状态',
      stopBefore.catchmentM !== 2900 && stopBefore.demand === demandBefore,
      `缓存 radius=${stopBefore.catchmentM} demand=${stopBefore.demand}`);
    transit.tick(1000);      // 一个 tick
    const after = transit.odStats();
    const stopAfter = transit.lineCache.get(line.id).stops.find((s) => Number(s.stationId) === Number(stations[1]));
    check('★★ 指纹对不上 → 一个 tick 之内立刻重建，并记进 odStats().staleRecomputes',
      after.staleRecomputes === before.staleRecomputes + 1 && after.stations === before.stations,
      `staleRecomputes ${before.staleRecomputes} → ${after.staleRecomputes}`);
    check('★ 重建是按新口径做的：线路缓存里的覆盖半径与沿线需求都换成了新值',
      stopAfter.catchmentM === 2900 && stopAfter.demand > demandBefore,
      `radius ${stopBefore.catchmentM} → ${stopAfter.catchmentM}，demand ${demandBefore} → ${stopAfter.demand}`);
    check('指纹本身也更新了（不会每个 tick 都重建一次）',
      after.cacheStamp === transit._cacheStamp() && transit.odStats().staleRecomputes === after.staleRecomputes,
      `stamp=${after.cacheStamp}`);

    // ③ 绕过 op 直接插一个车站：车站集合变了也要被抓到，而且新站立刻进 O/D 表
    const before2 = transit.odStats();
    const res = w.db.prepare(`INSERT INTO stations(owner, company_id, name, kind, lat, lon, node_id, way_id, platform_m, catchment_m, show_catchment, cost, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      user.id, w.company.id, '偷偷插的站', 'rail', LAT, lonOf(7), null, null, 120, 700, 0, 0, Date.now());
    const rawId = Number(res.lastInsertRowid);
    transit.tick(1000);
    const after2 = transit.odStats();
    check('★★ 直接往 stations 表插一个站 → 指纹也抓到了（车站集合是指纹的一部分）',
      after2.staleRecomputes === before2.staleRecomputes + 1 && after2.stations === before2.stations + 1,
      `staleRecomputes ${before2.staleRecomputes} → ${after2.staleRecomputes}，stations ${before2.stations} → ${after2.stations}`);
    check('新插进来的车站在重建后的 O/D 表里就有需求（不用等跨天）',
      !!odOf(transit, rawId) && odOf(transit, rawId).spawn > 0,
      JSON.stringify(odOf(transit, rawId) && { spawn: odOf(transit, rawId).spawn, served: odOf(transit, rawId).served }));
    w.raw.close();
  }

  /* ═════════ 4. 自检可以关掉（config.transit.staleCacheCheck = false） ═════════ */
  console.log('\n▶ 4. config.transit.staleCacheCheck = false：自检整个关掉（可关的廉价开关）');
  {
    const w = makeWorld({ staleCacheCheck: false });
    const { transit, user } = w;
    transit.speed = 20;
    const { line, stations } = makeLine(w, [0, 4, 8]);
    run(transit, 60);
    const before = transit.odStats();
    w.db.prepare('UPDATE stations SET catchment_m = ? WHERE id = ?').run(2900, stations[1]);
    transit.tick(1000);
    const after = transit.odStats();
    check('关掉之后：指纹不再比对（staleChecks 不涨、也不重建）',
      after.staleRecomputes === 0 && after.staleChecks === before.staleChecks,
      `staleChecks=${after.staleChecks} staleRecomputes=${after.staleRecomputes}`);
    void user;
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
