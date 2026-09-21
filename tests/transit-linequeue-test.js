'use strict';
/**
 * 站台候车"**按线路分队**"的专项测试（不需要那份 500MB 的北京数据集，跑得很快）。
 *
 *   node tests/transit-linequeue-test.js
 *
 * 用户报的 bug：一个站台上等车的人不按线路分开 —— 1 号线的人会被 2 号线的车拉走。
 * 期望的行为（本文件就是照这个写的验收）：
 *   一个站台上有 6 个人等 1 号线、4 个人等 2 号线；2 号线的车进站时**正好**拉走那 4 个
 *   （车上的载客 +4），站台上留下等 1 号的 6 个；1 号线的车没来之前，那 6 个人一个都不能少。
 *
 * 覆盖的点：
 *   1. 车站队伍按（车站 × 公司 × **线路**）分桶；桶与桶互不相通（_lineBucket / _drainBucket）
 *   2. 车停站只拉"自己那条线的桶 + 兜底桶"，绝不碰别条线的桶（_serveStation）
 *   3. stationPublic / stationWaiting 给出 waitingByLine：[{lineId,name,color,waiting,lost,...}]
 *   4. 耐心与 lost 也按桶算：某条线没人拉，走掉的人记在那条线上（_patienceStep）
 *   5. 兜底桶：没有"专属线路"的乘客（目的地没有任何线路能到 / 线路被删掉了）哪条线来车都能上
 *   6. 客流积累（O/D 需求表）把乘客放进"能拉走他的那条线"的桶里，不是一锅粥
 *   7. 快照里带 lastBoarded：客户端据此看到"车一进站载客就涨了 N"
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-linequeue');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.0025;      // ≈ 213 米一个节点
const NODES = 12;             // 一条 2.4 公里的短线（测试跑得快）
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
const railNode = (i) => RAIL_BASE + i;

/** 造一份人造底图：一条小铁路（都插进 rtree 索引，吸附时要用） */
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
  }
  insWay.run(RAIL_WAY, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, NODES, LAT, LAT, lonOf(0), lonOf(NODES - 1));
  insWayIndex.run(RAIL_WAY, lonOf(0), lonOf(NODES - 1), LAT, LAT);
}

/** 人造世界：每次调用换一个临时库文件，路网用真正的 RailGraph（与 boarding 测试同一套做法） */
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
    // 默认：这一组测试只关心"谁能上谁的车"，所以把自动客流关掉（tripRatePerDay = 0），
    // 需要真实客流的用例自己再传 tripRatePerDay
    config: Object.assign({ dwellSeconds: 30, patienceSeconds: 1000000, cohortSeconds: 30, tripRatePerDay: 0 }, config || {}),
  });
  const user = { id: 'u-test', name: '测试玩家', color: '#e6194b' };
  const company = transit.ensureCompany(user);
  const at = (idx) => ({ lat: LAT, lon: lonOf(idx) });
  return { raw, db, rail, road, transit, user, company, at };
}

/** 记录每一次停站（哪辆车、哪一站、上下客前后车上人数与该站等车人数） */
function watchDocks(transit) {
  const events = [];
  const orig = transit._serveStation.bind(transit);
  transit._serveStation = (vehicle, cache, rt, stop) => {
    const loadBefore = rt.load;
    const waitingBefore = transit.stationWaiting(stop.stationId).waiting;
    orig(vehicle, cache, rt, stop);
    events.push({
      vehicleId: vehicle.id, lineId: vehicle.line_id, stationId: stop.stationId,
      loadBefore: Math.round(loadBefore), loadAfter: Math.round(rt.load),
      boarded: Math.round(rt.lastBoarded || 0),
      waitingBefore, waitingAfter: transit.stationWaiting(stop.stationId).waiting,
    });
  };
  return events;
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

/** 某个站台在 waitingByLine 里的一行（按线路），没有就是 null */
function lineRow(transit, stationId, lineId) {
  const rows = transit.stationWaiting(stationId).waitingByLine;
  return rows.find((e) => (lineId == null ? e.lineId == null : e.lineId === lineId)) || null;
}

/** 桶里的原始数据（直接看数据结构，不经过展示层） */
function bucketOf(transit, stationId, companyId, owner, lineId) {
  const byCompany = transit.stationQueues.get(Number(stationId));
  if (!byCompany) return null;
  const entry = byCompany.get(transit._companyKey(companyId, owner));
  if (!entry) return null;
  return entry.buckets.get(transit._bucketKey(lineId)) || null;
}

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 站台候车按线路分队 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ============ 1. 验收：6 个等 1 号线 + 4 个等 2 号线 → 2 号线的车正好拉走 4 个 ============ */
  console.log('▶ 验收：一个站台两条线（6 + 4），2 号线的车只拉走 4 个');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: '换乘大站', kind: 'rail', ...at(0) }).station.id;
    const B = transit.createStation(user, { name: '1 号线终点', kind: 'rail', ...at(6) }).station.id;
    const C = transit.createStation(user, { name: '2 号线终点', kind: 'rail', ...at(NODES - 1) }).station.id;
    const line1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, B] }).line;
    const line2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [A, C] }).line;
    const cache2 = transit.lineCache.get(line2.id);
    check('两条线路都停靠同一个站台', cache2 && cache2.stops.some((s) => s.stationId === A) && !!transit.lineCache.get(line1.id),
      `1 号线 #${line1.id} / 2 号线 #${line2.id}，站台 #${A}`);

    // 站台上：6 个人等 1 号线（去 B）、4 个人等 2 号线（去 C）
    transit._addWaiting(A, cache2.queueCompanyId, cache2.companyOwner, line1.id, 6, transit.clockMs, B);
    transit._addWaiting(A, cache2.queueCompanyId, cache2.companyOwner, line2.id, 4, transit.clockMs, C);

    const rows = transit.stationWaiting(A).waitingByLine;
    check('waitingByLine 把站台按线路拆开了（1 号线 6 人 / 2 号线 4 人）',
      rows.length === 2 && lineRow(transit, A, line1.id).waiting === 6 && lineRow(transit, A, line2.id).waiting === 4,
      JSON.stringify(rows));
    check('分线路的明细带线路名与颜色（客户端直接显示，不用自己查表）',
      lineRow(transit, A, line1.id).name === '1 号线' && /^#[0-9a-f]{6}$/i.test(String(lineRow(transit, A, line1.id).color || '')),
      JSON.stringify(lineRow(transit, A, line1.id)));
    check('站台合计 = 6 + 4 = 10 人', transit.stationWaiting(A).waiting === 10, `waiting=${transit.stationWaiting(A).waiting}`);
    check('队伍真的按线路分了桶（数据结构：entry.buckets 里两个桶）',
      !!bucketOf(transit, A, cache2.queueCompanyId, cache2.companyOwner, line1.id)
      && !!bucketOf(transit, A, cache2.queueCompanyId, cache2.companyOwner, line2.id)
      && bucketOf(transit, A, cache2.queueCompanyId, cache2.companyOwner, line1.id).waiting === 6
      && bucketOf(transit, A, cache2.queueCompanyId, cache2.companyOwner, line2.id).waiting === 4,
      '1 号线桶 6 人 / 2 号线桶 4 人');

    // 只给 2 号线派一辆车（1 号线一辆车都没有：它的 6 个人必须原地等着）
    const veh2 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line2.id }).vehicle;
    const docks = watchDocks(transit);
    transit.speed = 1;
    run(transit, 30);                                  // 正好一个停站时间（dwellSeconds = 30）
    const first = docks.find((d) => d.stationId === A) || null;
    check('2 号线的车进站，正好拉走等 2 号线的那 4 个人（载客 +4）',
      !!first && first.vehicleId === veh2.id && first.boarded === 4 && first.loadAfter - first.loadBefore === 4,
      first ? `载客 ${first.loadBefore} → ${first.loadAfter}（本站上客 ${first.boarded} 人）` : '车站没有停靠');
    check('站台上留下等 1 号线的那 6 个人（一个都没被拉走）',
      transit.stationWaiting(A).waiting === 6 && lineRow(transit, A, line1.id).waiting === 6,
      `站台 ${transit.stationWaiting(A).waiting} 人，其中 1 号线 ${lineRow(transit, A, line1.id).waiting} 人`);
    check('2 号线自己的桶被抽空了（等车 0 人）',
      lineRow(transit, A, line2.id).waiting === 0 && bucketOf(transit, A, cache2.queueCompanyId, cache2.companyOwner, line2.id).cohorts.length === 0,
      `2 号线等车 ${lineRow(transit, A, line2.id).waiting} 人`);
    const snapTrain = transit.snapshot().trains.find((t) => t.id === veh2.id);
    check('快照里带上"本站上了几个人"（客户端据此显示载客在涨）',
      !!snapTrain && snapTrain.lastBoarded === 4 && snapTrain.lastServedStation === A && snapTrain.load === 4,
      snapTrain ? `lastBoarded=${snapTrain.lastBoarded} 站=${snapTrain.lastServedStation} load=${snapTrain.load}` : '快照里没有这辆车');

    /* ============ 2. 车再来一趟：1 号线的人还是不被抢；兜底桶的人能上 ============ */
    const rt = transit._runtimeFor(veh2.id);
    const vehRow = transit._st.vehicle.get(veh2.id);
    const stopA = cache2.stops.find((s) => s.stationId === A);
    transit._dock(vehRow, cache2, rt, cache2.path, stopA);      // 直接再办一次这一站（等价于车绕一圈回来）
    check('2 号线的车第二次进站：上客 0 人，1 号线那 6 个人纹丝不动',
      rt.lastBoarded === 0 && transit.stationWaiting(A).waiting === 6 && rt.load === 4,
      `本站上客 ${rt.lastBoarded} 人 / 载客 ${rt.load} / 站台还剩 ${transit.stationWaiting(A).waiting} 人`);

    // 没有"专属线路"的乘客（目的地没有任何线路能到 → 兜底桶）：哪条线来车都能上
    transit._addWaiting(A, cache2.queueCompanyId, cache2.companyOwner, null, 2, transit.clockMs, 999999);
    const fb = lineRow(transit, A, null);
    check('兜底桶单独成一行（lineId 为 null，名字是「未指定线路」）',
      !!fb && fb.waiting === 2 && fb.lineId === null && typeof fb.name === 'string',
      JSON.stringify(transit.stationWaiting(A).waitingByLine));
    transit._dock(vehRow, cache2, rt, cache2.path, stopA);
    check('兜底桶的乘客由 2 号线的车拉走（他们只有这一条线可坐），站台上仍是那 6 个人',
      rt.lastBoarded === 2 && rt.load === 6 && transit.stationWaiting(A).waiting === 6
      && lineRow(transit, A, line1.id).waiting === 6,
      `本站上客 ${rt.lastBoarded} 人 / 载客 ${rt.load} / 站台剩 ${transit.stationWaiting(A).waiting} 人（全是 1 号线）`);
    w.raw.close();
  }

  /* ============ 3. 耐心与 lost 也按线路算 ============ */
  console.log('\n▶ 耐心 / 放弃人数：按线路分开记账');
  {
    const w = makeWorld({ patienceSeconds: 400 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: '站台', kind: 'rail', ...at(0) }).station.id;
    const B = transit.createStation(user, { name: '北', kind: 'rail', ...at(6) }).station.id;
    const C = transit.createStation(user, { name: '南', kind: 'rail', ...at(NODES - 1) }).station.id;
    const line1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, B] }).line;   // 一辆车都没有
    const line2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [A, C] }).line;   // 稍后才有乘客
    const cache2 = transit.lineCache.get(line2.id);
    transit._addWaiting(A, cache2.queueCompanyId, cache2.companyOwner, line1.id, 6, transit.clockMs, B);
    transit.speed = 1;
    run(transit, 500);                                   // 1 号线的人等过 patienceSeconds（400 秒）→ 放弃离开
    transit._addWaiting(A, cache2.queueCompanyId, cache2.companyOwner, line2.id, 4, transit.clockMs, C);
    run(transit, 200);                                   // 2 号线的人只等了 200 秒，还该在站上
    const pub = transit.stationPublic(transit._st.station.get(A));
    const r1 = lineRow(transit, A, line1.id);
    const r2 = lineRow(transit, A, line2.id);
    check('等 1 号线的人失去耐心走掉，记在 1 号线的账上（不是记到 2 号线上）',
      r1 && r1.waiting === 0 && r1.lost >= 6 && r2 && r2.waiting === 4 && r2.lost === 0,
      `1 号线 等 ${r1 && r1.waiting} / 放弃 ${r1 && r1.lost}；2 号线 等 ${r2 && r2.waiting} / 放弃 ${r2 && r2.lost}`);
    check('车站合计：等车 4 人、放弃 ≥6 人（分线路加得起来）',
      pub.waiting === 4 && pub.lost >= 6, `waiting=${pub.waiting} lost=${pub.lost}`);
    check('stationPublic 仍然给出 waiting / lost / waitSeconds / waitingByCompany / waitingByLine',
      Number.isFinite(pub.waiting) && Number.isFinite(pub.lost) && Number.isFinite(pub.waitSeconds)
      && Array.isArray(pub.waitingByCompany) && Array.isArray(pub.waitingByLine),
      `waiting=${pub.waiting} lost=${pub.lost} waitSeconds=${pub.waitSeconds} 公司=${pub.waitingByCompany.length} 线路=${pub.waitingByLine.length}`);
    w.raw.close();
  }

  /* ============ 4. 线路被删掉：它的乘客搬进兜底桶，不会被吞掉 ============ */
  console.log('\n▶ 线路没了：桶里的乘客搬进兜底桶');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: '站台', kind: 'rail', ...at(0) }).station.id;
    const B = transit.createStation(user, { name: '终点', kind: 'rail', ...at(6) }).station.id;
    const C = transit.createStation(user, { name: '另一头', kind: 'rail', ...at(NODES - 1) }).station.id;
    const line1 = transit.createLine(user, { name: '要删的线', kind: 'rail', stops: [A, B] }).line;
    const line2 = transit.createLine(user, { name: '留着的线', kind: 'rail', stops: [A, C] }).line;
    const cache2 = transit.lineCache.get(line2.id);
    transit._addWaiting(A, cache2.queueCompanyId, cache2.companyOwner, line1.id, 6, transit.clockMs, B);
    const moved = transit._reassignLineQueue(line1.id);
    check('线路桶里的 6 个人被搬进兜底桶，一个都没丢',
      moved === 6 && transit.stationWaiting(A).waiting === 6 && !!(lineRow(transit, A, null) || {}).waiting
      && lineRow(transit, A, null).waiting === 6,
      `搬走 ${moved} 人 / 站台 ${transit.stationWaiting(A).waiting} 人 / 兜底桶 ${(lineRow(transit, A, null) || {}).waiting} 人`);
    check('这条线在 waitingByLine 里不再有等人（只剩兜底那一行）',
      !transit.stationWaiting(A).waitingByLine.some((e) => e.lineId === line1.id),
      JSON.stringify(transit.stationWaiting(A).waitingByLine));

    const veh2 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line2.id }).vehicle;
    const rt = transit._runtimeFor(veh2.id);
    transit._dock(transit._st.vehicle.get(veh2.id), cache2, rt, cache2.path, cache2.stops.find((s) => s.stationId === A));
    check('兜底桶的人由留着的 2 号线拉走（线路没了也不会把人卡死在站台上）',
      rt.lastBoarded === 6 && rt.load === 6 && transit.stationWaiting(A).waiting === 0,
      `本站上客 ${rt.lastBoarded} 人 / 载客 ${rt.load} / 站台剩 ${transit.stationWaiting(A).waiting} 人`);
    w.raw.close();
  }

  /* ============ 5. 真实客流（O/D 需求表）落进"能拉走他的那条线" ============ */
  console.log('\n▶ 客流积累：乘客落到自己那条线的桶里');
  {
    const w = makeWorld({ tripRatePerDay: 0.22, patienceSeconds: 1000000 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: '换乘站', kind: 'rail', ...at(0) }).station.id;
    const B = transit.createStation(user, { name: '1 号线终点', kind: 'rail', ...at(6) }).station.id;
    const C = transit.createStation(user, { name: '2 号线终点', kind: 'rail', ...at(NODES - 1) }).station.id;
    const line1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, B] }).line;
    const line2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [A, C] }).line;
    transit.speed = 1;
    run(transit, 1200);                                   // 两分钟游戏时间（走真实到达率）
    const r1 = lineRow(transit, A, line1.id);
    const r2 = lineRow(transit, A, line2.id);
    check('同一个站台上，两条线各自攒到了自己的人（不是一锅粥）',
      !!r1 && !!r2 && r1.waiting > 0 && r2.waiting > 0,
      `1 号线 ${r1 && r1.waiting} 人 / 2 号线 ${r2 && r2.waiting} 人`);
    const inBucket = (line, dest) => {
      const cache = transit.lineCache.get(line.id);
      const b = bucketOf(transit, A, cache.queueCompanyId, cache.companyOwner, line.id);
      const cohorts = (b && b.cohorts) || [];
      return { ok: cohorts.length > 0 && cohorts.every((c) => c.destId === dest), n: cohorts.length };
    };
    const b1 = inBucket(line1, B);
    const b2 = inBucket(line2, C);
    check('每条线的桶里只有去它自己终点方向的人（destMix 只含本线能到的站）',
      b1.ok && b2.ok, `1 号线桶 ${b1.n} 批（全去 #${B}）/ 2 号线桶 ${b2.n} 批（全去 #${C}）`);

    // 只给 2 号线派车：它只能拉走自己桶里的人，1 号线的队伍必须原样留着
    const before1 = r1.waiting;
    const veh2 = transit.createVehicle(user, { kind: 'metro_b6', lineId: line2.id }).vehicle;
    const docks = watchDocks(transit);
    run(transit, 60);
    const dock = docks.find((d) => d.stationId === A && d.vehicleId === veh2.id) || null;
    const after1 = (lineRow(transit, A, line1.id) || { waiting: 0 }).waiting;
    check('2 号线的车只把自己桶里的人拉走，1 号线的人一个都没少',
      !!dock && dock.boarded > 0 && dock.boarded <= before1 + 1 && after1 >= before1,
      dock ? `本站上客 ${dock.boarded} 人 / 1 号线等车 ${before1} → ${after1} 人` : '车站没有停靠');
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
