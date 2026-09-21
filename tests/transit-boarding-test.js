'use strict';
/**
 * 乘客上车 / 等车队伍 / 底图车站导入 的专项测试（不需要那份 500MB 的北京数据集，跑得很快）。
 *
 *   node tests/transit-boarding-test.js
 *
 * 用一个"人造小铁路 + 小公路"的临时库直接驱动 Transit，重点验证四件曾经出错的事：
 *   1. 首站也要上人：车就停在首站时，一个停站时间（dwellSeconds）内必须把等车的整人拉走；
 *   2. 返回方向、末站、以及"车改派到线路上"之后，同样要能上人；
 *   3. 候车队伍按（车站 × 公司）记账：别人的队伍不许动，自己的队伍先到先上、上到定员为止；
 *   4. 等车人数会随游戏时间涨（到达按覆盖人口 × 出行率摊到运营时间上）、
 *      也会随耐心流失（每批乘客自己计时，patienceSeconds 到了整批放弃走人）；
 * 外加公交站没有站台长度、以及底图车站导入（import.stations）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit, TransitError } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-boarding');
const DB = path.join(TMP, 'osm.sqlite');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.0025;      // ≈ 213 米一个节点
const NODES = 12;             // 一条 2.4 公里的短线（测试跑得快）
const RAIL_BASE = 1000;
const ROAD_BASE = 2000;
const RAIL_WAY = 500;
const ROAD_WAY = 501;

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

/** 造一份人造底图：一条铁路 + 一条平行公路（都插进 rtree 索引，导入时要用） */
function buildFixture(db) {
  const insNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = db.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  for (let i = 0; i < NODES; i++) {
    // 铁路节点
    insNode.run(railNode(i), LAT, lonOf(i), now);
    insIndex.run(railNode(i), lonOf(i), lonOf(i), LAT, LAT);
    insWayNode.run(RAIL_WAY, i, railNode(i));
    // 公路节点（正北 30 米）
    insNode.run(roadNode(i), LAT + 0.00027, lonOf(i), now);
    insIndex.run(roadNode(i), lonOf(i), lonOf(i), LAT + 0.00027, LAT + 0.00027);
    insWayNode.run(ROAD_WAY, i, roadNode(i));
  }
  insWay.run(RAIL_WAY, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, NODES, LAT, LAT, lonOf(0), lonOf(NODES - 1));
  insWayIndex.run(RAIL_WAY, lonOf(0), lonOf(NODES - 1), LAT, LAT);
  insWay.run(ROAD_WAY, JSON.stringify({ highway: 'primary', maxspeed: '50' }), now, NODES, LAT + 0.00027, LAT + 0.00027, lonOf(0), lonOf(NODES - 1));
  insWayIndex.run(ROAD_WAY, lonOf(0), lonOf(NODES - 1), LAT + 0.00027, LAT + 0.00027);
  // 底图里"像车站"的元素：一个火车站（就在铁路上）、一个公交站牌（就在公路上）、一个站台 way、一个没名字的停靠点
  const railStationLon = lonOf(3);
  db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run(JSON.stringify({ railway: 'station', name: '底图火车站', 'name:zh': '底图火车站' }), railNode(3));
  db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run(JSON.stringify({ highway: 'bus_stop', name: '底图公交站' }), roadNode(8));
  db.prepare('UPDATE nodes SET tags = ? WHERE id = ?').run(JSON.stringify({ public_transport: 'stop_position', bus: 'yes', name: '底图停靠点' }), roadNode(5));
  void railStationLon;
}

/** 人造世界：每次调用换一个临时库文件，路网用真正的 RailGraph */
let worldSeq = 0;
function makeWorld(config) {
  worldSeq += 1;
  const file = path.join(TMP, `osm-${worldSeq}.sqlite`);
  const raw = openDatabase(file);
  buildFixture(raw);
  const db = {
    raw,
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
  };
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
    config: Object.assign({ dwellSeconds: 30, patienceSeconds: 900, cohortSeconds: 30 }, config || {}),
  });
  const user = { id: 'u-test', name: '测试玩家', color: '#e6194b' };
  const company = transit.ensureCompany(user);
  const at = (idx, kind) => (kind === 'bus'
    ? { lat: LAT + 0.00027, lon: lonOf(idx) }
    : { lat: LAT, lon: lonOf(idx) });
  return { raw, db, rail, road, transit, user, company, at };
}

/** 记录每一次停站（谁、哪一站、上下客前后车上人数与该站等车人数） */
function watchDocks(transit) {
  const events = [];
  const orig = transit._serveStation.bind(transit);
  transit._serveStation = (vehicle, cache, rt, stop) => {
    const loadBefore = rt.load;
    const waitingBefore = transit.stationWaiting(stop.stationId).waiting;
    orig(vehicle, cache, rt, stop);
    events.push({
      vehicleId: vehicle.id, stationId: stop.stationId,
      loadBefore: Math.round(loadBefore), loadAfter: Math.round(rt.load),
      waitingBefore, waitingAfter: transit.stationWaiting(stop.stationId).waiting,
    });
  };
  return events;
}

/**
 * 让游戏时间走 gameSec 游戏秒。
 * 时间基准：×1 = 现实 1 秒 = 游戏 1 秒（旧基准是 1 实时秒 = 1 游戏分钟，所以换算从
 * `chunk * 60 * speed` 改成 `chunk * speed`）。默认 3000 毫秒一步 = **3 游戏秒一个小步**，
 * 与旧版本（tick(1000) 走 60 游戏秒、内部再切成 3 秒小步）的积分粒度完全一致。
 */
function run(transit, gameSec, chunkMs = 3000) {
  let done = 0;
  while (done < gameSec) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 乘客上车 / 等车队伍 / 底图车站导入 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ------------------------------ 1. 首站一个停站时间内上人 ------------------------------ */
  console.log('▶ 首站 / 停站上车');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: '首站', kind: 'rail', ...at(0) }).station.id;
    const B = transit.createStation(user, { name: '中间站', kind: 'rail', ...at(6) }).station.id;
    const C = transit.createStation(user, { name: '末站', kind: 'rail', ...at(NODES - 1) }).station.id;
    const line = transit.createLine(user, { name: '测试线', kind: 'rail', stops: [A, B, C] }).line;
    const veh = transit.createVehicle(user, { kind: 'metro_b4', lineId: line.id }).vehicle;
    const cache = transit.lineCache.get(line.id);
    check('线路寻路成功（三个站都在路径上）', cache && cache.stops.length === 3, cache ? `${cache.stops.length} 站 / ${Math.round(cache.path[cache.path.length - 1].distance)} 米` : '没有路径');

    // 首站已经有 3 个整人在等车（模拟之前积累下来的客流）
    transit._addWaiting(A, cache.companyId, cache.companyOwner, line.id, 3, transit.clockMs);
    check('车站公开数据里有等车人数', transit.stationPublic(transit._st.station.get(A)).waiting === 3,
      `waiting=${transit.stationWaiting(A).waiting}`);
    const docks = watchDocks(transit);
    transit.speed = 1;
    run(transit, 30);        // 正好一个停站时间（dwellSeconds = 30 游戏秒）
    const firstDock = docks[0] || null;
    check('车在首站停靠并把等车的人拉上车（一个停站时间内）',
      !!firstDock && firstDock.stationId === A && firstDock.loadAfter - firstDock.loadBefore >= 3 && firstDock.waitingAfter === 0,
      firstDock ? `第 ${firstDock.stationId} 站：载客 ${firstDock.loadBefore} → ${firstDock.loadAfter}，等车 ${firstDock.waitingBefore} → ${firstDock.waitingAfter}` : '一个停站时间内没有任何停靠');
    check('首站的队伍被抽干', transit.stationWaiting(A).waiting === 0, `waiting=${transit.stationWaiting(A).waiting}`);

    /* ------------------------------ 2. 末站 + 返回方向 ------------------------------ */
    const before2 = transit.stationPublic(transit._st.station.get(A));
    transit._addWaiting(C, cache.companyId, cache.companyOwner, line.id, 4, transit.clockMs);
    run(transit, 900);       // 跑完整的一圈（含返回方向）
    const dockC = docks.find((d) => d.stationId === C);
    check('末站（返回方向的端点）也停靠上客', !!dockC && dockC.loadAfter - dockC.loadBefore >= 4,
      dockC ? `末站上客 ${dockC.loadAfter - dockC.loadBefore} 人` : '末站一次都没停');
    check('末站没有人因为等不到车而放弃', transit.stationWaiting(C).lost === 0, `lost=${transit.stationWaiting(C).lost}`);
    check('返回方向经过首站也会再停一次',
      docks.filter((d) => d.stationId === A).length >= 2,
      `首站停靠 ${docks.filter((d) => d.stationId === A).length} 次`);
    void before2;

    /* ------------------------------ 3. 公司口径 / 定员 ------------------------------ */
    const other = transit.createCompany(user, { name: '另一家公司' });
    transit._addWaiting(A, other.id, user.id, line.id, 7, transit.clockMs);
    const otherBefore = transit.stationWaiting(A).waiting;
    run(transit, 60);        // 比 patienceSeconds（300 游戏秒）短，别让别人家的人等超时
    const otherEntry = transit.stationQueues.get(A).get(transit._companyKey(other.id, user.id));
    check('只拉自己公司的队伍，别人的队伍原地不动',
      !!otherEntry && otherEntry.waiting >= 7 && transit.stationWaiting(A).waiting >= 7,
      `车站合计 ${otherBefore} → ${transit.stationWaiting(A).waiting} 人（别家公司仍有 ${otherEntry ? otherEntry.waiting.toFixed(2) : '—'} 人）`);

    // 定员：车塞满、站上排一大堆人，进站后最多上到定员，剩下的继续排队
    const rt = transit._runtimeFor(veh.id);
    const capacity = veh.cars * veh.capacityPerCar;
    transit._addWaiting(B, cache.companyId, cache.companyOwner, line.id, 5000, transit.clockMs);
    rt.distance = cache.stops[1].distance + 60;    // 车就在中间站前面，马上进站
    rt.direction = -1;
    rt.load = capacity;
    const docks2 = watchDocks(transit);
    run(transit, 120);
    const dockB = docks2.find((d) => d.stationId === B);
    const leftB = transit.stationWaiting(B).waiting;
    // ⚠ 断言"不超过定员"，不是"正好等于定员"：乘客是按游戏秒累积的**小数**，本站下车的
    // 4.69 个人腾出 4.69 个座位，而只上**整人** → 最多上 4 个，最后载客 919.31/920
    // （本文件的 watchDocks 把载客四舍五入成整数，所以这里按"最多差 1 个整人"判）。
    // 剩下的零头（< 1 个座位）上不了人，这是"只上整人 + 空位取整"的正常结果。
    // （以前这里断言 loadAfter === capacity，只是因为"载客被减了两次"的老 bug 把 919.61
    //  四舍五入成了 920 才碰巧通过；那个 bug 已修，见 transit.js 的 _serveStation/_alightAt）
    check('上客不超过剩余定员：车上装满定员，站上还留着没上完的',
      !!dockB && dockB.loadAfter <= capacity && capacity - dockB.loadAfter <= 1 && leftB > 100,
      dockB ? `载客 ${dockB.loadBefore} → ${dockB.loadAfter}/${capacity}（空位不足 1 个整人），站上还剩 ${leftB} 人` : '中间站没有停靠');

    /* ------------------------------ 4. 改派之后照样上人 ------------------------------ */
    // 单独一条"还没派车"的线路：先攒人，再把车派过来 —— 车从首站出发，一个停站时间内必须上人
    const D = transit.createStation(user, { name: '改派首站', kind: 'rail', ...at(1) }).station.id;
    const E = transit.createStation(user, { name: '改派末站', kind: 'rail', ...at(8) }).station.id;
    const line2 = transit.createLine(user, { name: '还没派车的线', kind: 'rail', stops: [D, E] }).line;
    transit.speed = 1;
    run(transit, 300);                                  // 没车，乘客在 D 站排队
    const dWait = transit.stationWaiting(D).waiting;
    check('线路上还没派车时，乘客在站上正常排队', dWait >= 3, `D 站等车 ${dWait} 人`);
    const veh2 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line2.id }).vehicle;
    const docks3 = watchDocks(transit);
    run(transit, 30);                                   // 一个停站时间
    const reassigned = docks3.find((d) => d.vehicleId === veh2.id && d.stationId === D);
    check('车被派到线路上后，一个停站时间内就在首站上人',
      !!reassigned && reassigned.loadAfter - reassigned.loadBefore >= 3,
      reassigned ? `派车后首站上客 ${reassigned.loadAfter - reassigned.loadBefore} 人` : '派车后没有在首站停靠');

    /* ------------------------------ 5. 下车给公司记人次 ------------------------------ */
    const ridersBefore = transit.stationPublic ? transit.companyPublic(transit._st.company.get(w.company.id)).riders : 0;
    transit.speed = 1;
    run(transit, 1200);
    const ridersAfter = transit.companyPublic(transit._st.company.get(w.company.id)).riders;
    check('公司人次是"下车"时记的帐（乘客真的被运走了）', ridersAfter > ridersBefore,
      `${ridersBefore} → ${ridersAfter} 人次`);
    const stats = transit.lineStats(line.id, 3);
    const today = stats.days[stats.days.length - 1];
    check('线路日报里有上车人次与加权候车时间', today && today.riders > 0 && today.avgWait >= 0,
      today ? `人次 ${today.riders} / 平均候车 ${today.avgWait} 秒 / 车公里 ${today.vehicleKm}` : '没有日报');
    w.raw.close();
  }

  /* ------------------------------ 6. 等车人数要涨、也要流失 ------------------------------ */
  console.log('\n▶ 等车人数：会涨、也会流失');
  {
    const w = makeWorld({ tripRatePerDay: 2, patienceSeconds: 400 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: '没人服务的站', kind: 'rail', ...at(2) }).station.id;
    const B = transit.createStation(user, { name: '另一站', kind: 'rail', ...at(9) }).station.id;
    const line = transit.createLine(user, { name: '空线路', kind: 'rail', stops: [A, B] }).line;   // 一辆车都没有
    transit.speed = 1;
    run(transit, 60);
    const w0 = transit.stationWaiting(A).waiting;
    run(transit, 120);
    const w1 = transit.stationWaiting(A).waiting;
    run(transit, 110);
    const w2 = transit.stationWaiting(A).waiting;
    check('等车人数随游戏时间增长（覆盖人口 × 出行率摊到运营时间）', w1 > w0 && w2 > w1, `${w0} → ${w1} → ${w2} 人`);
    const pub = transit.stationPublic(transit._st.station.get(A));
    check('stationPublic 给出 waiting / lost / waitSeconds',
      Number.isFinite(pub.waiting) && Number.isFinite(pub.lost) && pub.waitSeconds > 0,
      `waiting=${pub.waiting} lost=${pub.lost} waitSeconds=${pub.waitSeconds}`);
    check('等车人数按线路拆分（waitingByLine）',
      Array.isArray(pub.waitingByLine) && pub.waitingByLine.some((e) => e.lineId === line.id && e.waiting >= 0),
      JSON.stringify(pub.waitingByLine));
    check('等车人数按公司拆分（waitingByCompany）',
      Array.isArray(pub.waitingByCompany) && pub.waitingByCompany.length === 1 && pub.waitingByCompany[0].companyId === w.company.id,
      JSON.stringify(pub.waitingByCompany.map((c) => ({ companyId: c.companyId, waiting: c.waiting, waitSeconds: c.waitSeconds }))));
    const peak = transit.stationWaiting(A).waiting;
    run(transit, 1200);      // 超过 patienceSeconds（400 游戏秒）→ 最老的批次放弃离开
    const lost = transit.stationWaiting(A).lost;
    const nowWait = transit.stationWaiting(A).waiting;
    // 到达率 = 覆盖人口 3000 × 出行率 2 × 活跃度 1.2 ÷ 运营 18 小时 ≈ 0.111 人/游戏秒；
    // 有耐心在，队伍最多排到"到达率 × 耐心"（≈ 44 人）就会被压住，不会随时间无限变长。
    const ratePerSec = (3000 * 2 * 1.2) / (18 * 3600);
    const bound = Math.ceil(ratePerSec * 400 * 1.35);
    check('等不到车的人会失去耐心离开（lost 增长、队伍被耐心压住而不是无限变长）',
      lost > 0 && nowWait <= bound && nowWait < ratePerSec * 1500,
      `lost=${lost} 人；队伍峰值 ${peak} → ${nowWait} 人（理论上限约 ${Math.round(ratePerSec * 400)} 人，不设耐心的话早该到 ${Math.round(ratePerSec * 1500)} 人了）`);
    check('分线路的放弃人数也能看到', pub.waitingByLine.length === 0 || pub.waitingByLine.every((e) => Number.isFinite(e.lost)),
      JSON.stringify(transit.stationWaiting(A).waitingByLine));
    w.raw.close();
  }

  /* ------------------------------ 7. 公交站没有站台长度 ------------------------------ */
  console.log('\n▶ 公交站没有站台长度');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const bus = transit.createStation(user, { name: '公交站', kind: 'bus', ...at(4, 'bus') });
    check('公交站建站成功且 platformM = 0', bus.ok !== false && bus.station.platformM === 0, JSON.stringify(bus.station && bus.station.platformM));
    check('stationPublic 给出 hasPlatform=false / noPlatform=true',
      bus.station.hasPlatform === false && bus.station.noPlatform === true,
      `hasPlatform=${bus.station.hasPlatform} noPlatform=${bus.station.noPlatform}`);
    let rejected = null;
    try {
      transit.updateStation(user, { id: bus.station.id, platformM: 120 });
    } catch (err) {
      rejected = err;
    }
    check('想给公交站设站台长度会被拒绝', !!rejected && rejected instanceof TransitError, rejected ? rejected.message : '居然通过了');
    const renamed = transit.updateStation(user, { id: bus.station.id, name: '改个名字' });
    check('公交站照样能改名，站台长度保持 0', renamed.station.name === '改个名字' && renamed.station.platformM === 0,
      `${renamed.station.name} / platformM=${renamed.station.platformM}`);
    const rail = transit.createStation(user, { name: '普通车站', kind: 'rail', ...at(7) });
    check('铁路车站仍然有站台长度（默认 120 米）', rail.station.platformM === 120 && rail.station.hasPlatform === true,
      `platformM=${rail.station.platformM} hasPlatform=${rail.station.hasPlatform}`);
    const kinds = transit.apply(user, { k: 'kinds' });
    check('站点类型表里带 hasPlatform（客户端据此藏掉那一栏）',
      kinds.stationKinds.bus && kinds.stationKinds.bus.hasPlatform === false && kinds.stationKinds.rail.hasPlatform === true,
      JSON.stringify({ bus: kinds.stationKinds.bus.hasPlatform, rail: kinds.stationKinds.rail.hasPlatform }));
    const hid = transit.updateStation(user, { id: rail.station.id, kind: 'bus' });
    check('把车站改成公交站后站台长度自动归零', hid.station.platformM === 0 && hid.station.hasPlatform === false,
      `platformM=${hid.station.platformM}`);
    w.raw.close();
  }

  /* ------------------------------ 8. 底图车站导入 ------------------------------ */
  console.log('\n▶ 底图车站导入（import.stations）');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    const bbox = { minLat: LAT - 0.01, minLon: lonOf(0) - 0.01, maxLat: LAT + 0.01, maxLon: lonOf(NODES - 1) + 0.01 };
    const res = transit.apply(user, { k: 'import.stations', bbox, limit: 50 });
    check('底图里的车站被导入成游戏车站', res.created >= 2, `新建 ${res.created} 个（扫到 ${res.scanned} 个元素）`);
    check('导入结果按类型/来源分类统计', res.byKind.rail >= 1 && res.byKind.bus >= 1 && Object.keys(res.bySource).length >= 2,
      `byKind=${JSON.stringify(res.byKind)} bySource=${JSON.stringify(res.bySource)}`);
    const importedRail = transit._st.allStations.all().find((s) => s.osm_type === 'node' && s.imported === 1 && s.kind === 'rail');
    const importedBus = transit._st.allStations.all().find((s) => s.osm_type === 'node' && s.imported === 1 && s.kind === 'bus');
    check('车站名取自底图（name / name:zh）', !!importedRail && importedRail.name === '底图火车站',
      importedRail ? importedRail.name : '没导入到火车站');
    check('导入站挂在那家"名义公司"名下、imported=1（owner 只是记账用的挂靠账号，不代表权限）',
      !!importedRail && importedRail.owner === '__system__' && importedRail.company_id === res.company.id && importedRail.imported === 1,
      importedRail ? `owner=${importedRail.owner} company=${importedRail.company_id}` : '');
    check('node_id 记下了底图节点/路网节点（车站马上能用）',
      !!importedRail && importedRail.node_id != null && !!importedBus && importedBus.node_id != null,
      `rail node=${importedRail && importedRail.node_id} / bus node=${importedBus && importedBus.node_id}`);
    const again = transit.apply(user, { k: 'import.stations', bbox, limit: 50 });
    check('重复导入是幂等的（不会再建一遍）', again.created === 0 && again.skippedExisting >= 2,
      `再导入新建 ${again.created} 个 / 跳过已存在 ${again.skippedExisting} 个`);
    const pub = transit.stationPublic(transit._st.station.get(importedRail.id));
    // ⚠ 这条原来写的是"客户端按只读显示"：车站已经没有归属概念，imported / isPublic 只是来源信息
    check('stationPublic 标出 imported / isPublic（**只是底图来源信息**，不是"不能改"的判据）',
      pub.isPublic === true && pub.imported === 1 && pub.osmType === 'node' && pub.osmId != null,
      `isPublic=${pub.isPublic} imported=${pub.imported} osm=${pub.osmType}:${pub.osmId}`);

    // ⚠ 这条原来是"公共车站不能被别的玩家改名/删除"（服务端 FORBIDDEN）。用户要求车站不再有归属：
    //    底图导入的站和玩家自建站一样，谁都能改名 / 删除 —— 这里让另一个玩家改一个、删一个。
    const other = { id: 'u-other', name: '别人', color: '#2b8cbe' };
    const otherCompany = transit.ensureCompany(other);
    let renamed = null;
    try { renamed = transit.updateStation(other, { id: importedRail.id, name: '别人改的站名' }); } catch (err) { renamed = err; }
    let deleted = null;
    try { deleted = transit.deleteStation(other, { id: importedBus.id }); } catch (err) { deleted = err; }
    check('底图导入的站也能被别的玩家改名 / 删除（车站没有归属，改名后来源信息仍在）',
      !!renamed && !(renamed instanceof Error) && renamed.station.name === '别人改的站名' && renamed.station.imported === 1
        && !!deleted && !(deleted instanceof Error) && !transit._st.station.get(importedBus.id),
      `改：${renamed instanceof Error ? renamed.message : renamed.station.name} / 删：${deleted instanceof Error ? deleted.message : '车站 #' + importedBus.id + ' 已删'}`);
    const line = transit.createLine(other, {
      name: '别人的线路', kind: 'rail',
      stops: [importedRail.id, transit.createStation(other, { name: '别人的站', kind: 'rail', ...at(10) }).station.id],
    });
    check('任何玩家都能把导入站加进自己的线路', line.ok !== false && line.line.stops.includes(importedRail.id) && line.line.pathLen > 0,
      line.line ? `线路 ${line.line.pathLen} 米 / 站 ${JSON.stringify(line.line.stops)}` : JSON.stringify(line));
    check('被别的玩家改过名的导入站能被线路正常寻路（重新算路径不报错）',
      (() => { const r = transit.rebuildPath(line.line.id); return r && r.ok === true; })(),
      JSON.stringify(transit.linePublic(transit._st.line.get(line.line.id)).pathError));
    check('导入时 all:true 也可以（不限视野）',
      (() => { const r = transit.apply(user, { k: 'import.stations', all: true, limit: 50 }); return r.ok === true && r.all === true; })(), '');
    check('不给 bbox 也不给 all 会被拒绝',
      (() => { try { transit.apply(user, { k: 'import.stations' }); return false; } catch (err) { return /bbox/.test(err.message); } })(), '');
    void otherCompany;
    w.raw.close();
  }
  /* ------------------------------ 9. 启动自动导入（默认关、幂等） ------------------------------ */
  console.log('\n▶ 启动自动导入（config.importStationsOnStart）');
  {
    const importedCount = (w) => w.raw.prepare('SELECT COUNT(*) AS c FROM stations WHERE imported = 1').get().c;
    const off = makeWorld();
    run(off.transit, 30);
    check('默认（开关关着）启动不会导入任何底图车站', importedCount(off) === 0, `${importedCount(off)} 个`);
    off.raw.close();

    const on = makeWorld({ importStationsOnStart: true, importLimit: 20 });
    run(on.transit, 30);
    const n1 = importedCount(on);
    check('打开开关后启动就自动导入一批（上限 importLimit）', n1 > 0 && n1 <= 20, `${n1} 个`);
    const sysCount = on.raw.prepare("SELECT COUNT(*) AS c FROM stations WHERE imported = 1 AND owner = '__system__'").get().c;
    check('启动导入的车站挂在名义公司名下（owner=__system__ + imported=1）', sysCount === n1, `owner=__system__ 的有 ${sysCount} 个`);
    run(on.transit, 900);
    check('启动导入是幂等的（再跑多久都不会重复建站）', importedCount(on) === n1, `${n1} → ${importedCount(on)}`);
    on.raw.close();
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
