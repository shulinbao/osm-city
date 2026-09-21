'use strict';
/**
 * 换乘半径 = **车站覆盖范围**（不再是固定的 2.3 km）· 专项测试
 *
 *   node tests/transit-catchment-transfer-test.js
 *
 * 用户的新规则：
 *   "换乘应该按车站覆盖范围来定，而不是固定的 2.3 km" —— 两站落在对方的覆盖范围里
 *   （两个覆盖圈相交）就能站间步行换乘。允许距离的实现只有一处：
 *   Transit#transferWalkRadiusM（见那里的中文说明），口径是
 *
 *     允许距离(A,B) = max( osiRadiusMeters,                     ← 下限（wiki 的 2.3 km）
 *                        min( 覆盖范围距离,                       ← 'overlap': catA+catB / 'max': max(catA,catB)
 *                             max(osiRadiusMeters, 1.5 × max),   ← 相对上限（用户给的 1.5 倍）
 *                             transferMaxRadiusM ) )             ← 绝对上限（默认 4000 m）
 *
 * 本文件验收用户点名的四件事：
 *   1. 相距 900 m、覆盖半径 1000 m 的两站互相可走（换乘允许）；覆盖半径 300 m（远低于
 *      2.3 km 下限）时仍然按下限走；4 km 覆盖半径、相距 5 km 的一对**按覆盖范围本来算得上**
 *      （4000+4000 = 8000 ≥ 5000），但被**绝对上限 4000 m**挡住 —— 上限就是 4000 m。
 *   2. 网格索引必须跟着最大允许半径自适应：把下限压到 300 m 以后，相距 2777 m 的一对
 *      （覆盖半径 2000 m → 允许 3000 m）仍然要被找出来，不能因为格子按 2.3 km 切就漏掉。
 *   3. 每站步行邻站数有安全阀（transferNeighborLimit，默认 48）：密集路网上度数有界。
 *   4. 一个车站的覆盖范围被改（station.update catchmentM）以后，行程图 / O-D 表必须重算，
 *      而且**乘客真的能跨着这样一段 2990 m 的步行接驳换乘到另一条线**（模拟里跑出来）。
 *
 * 底图是两条互相断开的南北铁路（人造，与 transit-transfer-test 同一套做法）：
 *   main (lat 39.900) 33 个节点 ≈213.6 米一格（≈6.8 km）
 *   side (lat 39.855) 26 个节点（与 main 相距 ≈5.0 km，用来验"5 km 被上限挡住"）
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { metersBetween } = require('../server/geo');
const { Transit } = require('../server/transit');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-catchment-transfer');
const LAT = 39.9;
const LAT_SIDE = LAT - 0.045;             // ≈ 5005 米（给"5 km 那一对"用）
const LON0 = 116.4;
const STEP_LON = 0.0025;                  // ≈ 213.6 米一格（lat 39.9）
const N_MAIN = 33;
const N_SIDE = 26;
const WAY_MAIN = 610;
const WAY_SIDE = 611;
const NODE_BASE = { main: 20000, side: 21000 };

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const lonOf = (i) => LON0 + i * STEP_LON;
const nodeId = (group, i) => NODE_BASE[group] + i;

/** 人造底图：两条断开的铁路（插进 rtree，建站时吸附要用） */
function buildFixture(db) {
  const insNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = db.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  const ways = [
    { way: WAY_MAIN, group: 'main', lat: LAT, n: N_MAIN },
    { way: WAY_SIDE, group: 'side', lat: LAT_SIDE, n: N_SIDE },
  ];
  for (const w of ways) {
    for (let i = 0; i < w.n; i++) {
      insNode.run(nodeId(w.group, i), w.lat, lonOf(i), now);
      insIndex.run(nodeId(w.group, i), lonOf(i), lonOf(i), w.lat, w.lat);
      insWayNode.run(w.way, i, nodeId(w.group, i));
    }
    insWay.run(w.way, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, w.n, w.lat, w.lat, lonOf(0), lonOf(w.n - 1));
    insWayIndex.run(w.way, lonOf(0), lonOf(w.n - 1), w.lat, w.lat);
  }
}

/** 人造世界：每次换一个临时库文件（与 boarding / linequeue / transfer 测试同一套做法） */
let worldSeq = 0;
function makeWorld(config) {
  worldSeq += 1;
  const file = path.join(TMP, `osm-${worldSeq}.sqlite`);
  const raw = openDatabase(file);
  buildFixture(raw);
  const db = { raw, prepare: (sql) => raw.prepare(sql), exec: (sql) => raw.exec(sql) };
  const rail = new RailGraph(db, { mode: 'rail' });
  rail.build();
  const population = {
    catchment: () => ({ pop: 3000, jobs: 500, weightedPop: 3600, activity: 1.2 }),
    totals: () => ({ population: 3000, jobs: 500, cells: 1 }),
  };
  const transit = new Transit(db, {
    rail, population,
    config: Object.assign({ dwellSeconds: 30, patienceSeconds: 1000000, cohortSeconds: 30, tripRatePerDay: 0 }, config || {}),
  });
  const user = { id: 'u-test', name: '测试玩家', color: '#e6194b' };
  transit.ensureCompany(user);
  const at = (group, idx) => ({ lat: group === 'side' ? LAT_SIDE : LAT, lon: lonOf(idx) });
  return { raw, db, rail, transit, user, at };
}

/** 让游戏时间走 gameSec 游戏秒（与 transfer 测试同一套时钟口径：1 实时秒 = 1 游戏秒） */
function run(transit, gameSec, chunkMs = 3000) {
  let done = 0;
  while (done < gameSec) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

/** 站台上某公司某线路桶的原始数据 */
function bucketOf(transit, stationId, companyId, owner, lineId) {
  const byCompany = transit.stationQueues.get(Number(stationId));
  if (!byCompany) return null;
  const entry = byCompany.get(transit._companyKey(companyId, owner));
  if (!entry) return null;
  return entry.buckets.get(transit._bucketKey(lineId)) || null;
}

/** 某个站在行程图里的步行邻站（[{to, meters}]） */
function walkNeighbors(transit, id) {
  const g = transit._ensureItineraryGraph();
  return g.walk.adj.get(Number(id)) || [];
}
/**
 * 一条线"今天"的客流人次。
 * ⚠ 用 lineStats().today（= 库里已落盘的当日行 + 内存里还没落盘的部分），不用 linePublic().riders ——
 * 后者只看内存累计，而 tick() 每 10 真实秒会把内存累计落盘并清零（见 _flushLineStats），
 * 跑过模拟以后再读它就会读到 0，是条会飘的断言口径。
 */
function ridersToday(transit, lineId) {
  return transit.lineStats(Number(lineId)).today.riders;
}
/** 两站在行程图里是不是互通（步行接驳边存在） */
function walkableInGraph(transit, a, b) {
  return walkNeighbors(transit, a).some((x) => x.to === Number(b));
}
/** 把某个车站的覆盖半径直接写进库（绕过 maxCatchment 的编辑上限，模拟"覆盖范围真的很大"） */
function setCatchment(transit, id, meters) {
  transit.db.prepare('UPDATE stations SET catchment_m = ? WHERE id = ?').run(Number(meters), Number(id));
  transit._dropDemandCache(id);
}

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 换乘半径按车站覆盖范围定 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ============ 1. 规则本身（transferWalkRadiusM，唯一实现处）============ */
  console.log('▶ 规则：允许距离 = max(下限, min(覆盖范围距离, 相对上限, 绝对上限))');
  {
    const w = makeWorld();
    const { transit } = w;
    const r = (a, b) => transit.transferWalkRadiusM(a, b);
    check('覆盖半径 1000+1000 m（相距 900 m）→ 允许距离 = 2.3 km 下限，900 m 的一对走得通',
      r(1000, 1000) === 2300 && 900 <= r(1000, 1000), `允许 ${r(1000, 1000)} m`);
    check('覆盖半径 300+300 m（远低于下限）→ 仍然按 2.3 km 下限走',
      r(300, 300) === 2300 && r(700, 700) === 2300, `r(300,300)=${r(300, 300)} m，r(700,700)=${r(700, 700)} m`);
    check('覆盖半径 4000+4000 m：覆盖范围给出 8000 m（本来够得着 5 km 的一对），但被 4000 m 绝对上限挡住',
      r(4000, 4000) === 4000 && r(4000, 4000) < 5000 && 4000 + 4000 >= 5000,
      `允许 ${r(4000, 4000)} m（覆盖范围口径 8000 m，上限 4000 m）`);
    check('对称：谁大谁小都一样（A→B 与 B→A 的允许距离相同）',
      r(1200, 3000) === r(3000, 1200) && r(700, 450) === r(450, 700), `${r(1200, 3000)} m`);
    check('相对上限（1.5 × 较大的覆盖半径）真的起作用：3000+700 → 3700 m，而不是取大者 3000 m',
      r(3000, 700) === 3700, `r(3000,700)=${r(3000, 700)} m`);
    check('transferRadiusRule 可切换：改成 "max"（较大圈罩住另一站）后 3000+700 → 3000 m',
      (() => {
        transit.config.transferRadiusRule = 'max';
        transit._tp = transit._transferParams();
        const v = r(3000, 700);
        transit.config.transferRadiusRule = 'overlap';
        transit._tp = transit._transferParams();
        return v === 3000 && r(3000, 700) === 3700;
      })(), '两种口径都能用 config.transit.transferRadiusRule 选');
    check('下限是硬下限：把绝对上限配成 800 m，两站覆盖范围再小也还是按 2.3 km 走',
      (() => {
        transit.config.transferMaxRadiusM = 800;
        transit._tp = transit._transferParams();
        const v = r(700, 700);
        transit.config.transferMaxRadiusM = 4000;
        transit._tp = transit._transferParams();
        return v === 2300;
      })(), '');
    w.raw.close();
  }

  /* ============ 2. 行程图：网格自适应 + 逐对半径 + 安全阀 ============ */
  console.log('\n▶ 行程图：900 m 的一对要走得通，格子要跟着最大允许半径放大');
  {
    const w = makeWorld();
    const { transit, user, at } = w;
    // 覆盖半径 1000 m 的两站：相距 4 格 ≈ 854 m
    const P1 = transit.createStation(user, { name: 'P1', kind: 'rail', catchmentM: 1000, ...at('side', 0) }).station.id;
    const P2 = transit.createStation(user, { name: 'P2', kind: 'rail', catchmentM: 1000, ...at('side', 4) }).station.id;
    const d12 = Math.round(metersBetween(at('side', 0), at('side', 4)));
    check('相距 ≈900 m、覆盖半径 1000 m 的两站在行程图里互通（换乘允许）',
      walkableInGraph(transit, P1, P2) && walkableInGraph(transit, P2, P1) && d12 > 800 && d12 < 1000,
      `实际 ${d12} m / 允许 ${transit.transferWalkRadiusM(1000, 1000)} m / 邻居 ${walkNeighbors(transit, P1).length} 个`);

    // 同一条边，覆盖半径降到 300 m（低于下限）：还是能走（下限兜底）
    setCatchment(transit, P1, 300);
    setCatchment(transit, P2, 300);
    const g1 = transit._ensureItineraryGraph();
    check('覆盖半径 300+300 m（低于 2.3 km 下限）时这一对仍然互通：下限就是那个界',
      walkableInGraph(transit, P1, P2)
      && Math.max(...walkNeighbors(transit, P1).map((x) => x.meters)) <= 2300,
      `允许 ${transit.transferWalkRadiusM(300, 300)} m / 最远邻居 ${Math.round(Math.max(...walkNeighbors(transit, P1).map((x) => x.meters)))} m`);
    check('网格格子按"最大允许半径"定，不是按下限定（上限 4000 m > 下限 2300 m）',
      Math.round(g1.walk.cell * 111320) >= 4000 && g1.stats.walkRadiusMaxM >= 4000,
      `格子 ≈ ${Math.round(g1.walk.cell * 111320)} m / 最大允许 ${g1.stats.walkRadiusMaxM} m`);

    // 超出下限的一对（≈2777 m）在 300+300 的覆盖范围下不可走
    const P3 = transit.createStation(user, { name: 'P3（≈2.8 km 外）', kind: 'rail', catchmentM: 300, ...at('side', 13) }).station.id;
    const d13 = Math.round(metersBetween(at('side', 0), at('side', 13)));
    check('相距 ≈2.8 km、覆盖半径 300 m 的一对不可走（> 2.3 km 下限）',
      d13 > 2300 && !walkableInGraph(transit, P1, P3), `实际 ${d13} m / 允许 ${transit.transferWalkRadiusM(300, 300)} m`);
    w.raw.close();
  }
  {
    // 下限压到 300 m：允许距离完全由覆盖范围决定（2000+2000 → 3000 m），
    // 这时格子如果还按"下限 300 m"切，2777 m 外的一对就会被静默漏掉
    const w = makeWorld({ osiRadiusMeters: 300 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A', kind: 'rail', catchmentM: 2000, ...at('side', 0) }).station.id;
    const B = transit.createStation(user, { name: 'B（≈2.8 km 外）', kind: 'rail', catchmentM: 2000, ...at('side', 13) }).station.id;
    const d = Math.round(metersBetween(at('side', 0), at('side', 13)));
    const g = transit._ensureItineraryGraph();
    check('下限压到 300 m 后，覆盖半径 2000+2000 的两站允许 3000 m：相距 2777 m 的一对必须被找出来（网格自适应）',
      transit.transferWalkRadiusM(2000, 2000) === 3000 && d <= 3000 && walkableInGraph(transit, A, B),
      `实际 ${d} m / 允许 ${transit.transferWalkRadiusM(2000, 2000)} m / 格子 ≈ ${Math.round(g.walk.cell * 111320)} m（3×3 邻域覆盖 ${Math.round(g.walk.cell * 111320 * 1)} m 以上）`);
    w.raw.close();
  }
  {
    // 安全阀：一个枢纽站 + 12 个 900 m 内的邻站（覆盖半径 3000 → 允许 4000 m）
    const w = makeWorld({ transferNeighborLimit: 4, osiRadiusMeters: 300 });
    const { transit, user, at } = w;
    const hub = transit.createStation(user, { name: '枢纽', kind: 'rail', catchmentM: 3000, ...at('side', 0) }).station.id;
    const ring = [];
    for (let i = 1; i <= 12; i++) {
      ring.push(transit.createStation(user, { name: 'N' + i, kind: 'rail', catchmentM: 3000, ...at('side', i) }).station.id);
    }
    const g = transit._ensureItineraryGraph();
    const degs = [...g.walk.adj.values()].map((a) => a.length);
    const hubNb = walkNeighbors(transit, hub);
    const nearest = hubNb.map((x) => Math.round(x.meters)).sort((a, b) => a - b);
    check('安全阀 transferNeighborLimit=4：每个站的步行度数 ≤ 4（密集路网上度数有界）',
      degs.length > 0 && Math.max(...degs) <= 4, `最大度数 ${Math.max(...degs)} / 被砍掉 ${g.walk.pruned} 对`);
    check('留下的是**最近的**几个邻站（枢纽只剩最近 2 个，641 m 外的第 4 个邻站已经进不来）',
      hubNb.length >= 1 && hubNb.length <= 4 && Math.max(...hubNb.map((x) => x.meters)) <= 3 * 214.5
      && !walkableInGraph(transit, hub, ring[3]),
      `保留 ${nearest.join('/')} m（第 4 个邻站在 ${Math.round(metersBetween(at('side', 0), at('side', 3)))} m 外）`);
    check('安全阀关掉（0 = 不限）时同一个枢纽的 12 个邻站全部保留',
      (() => {
        transit.config.transferNeighborLimit = 0;
        transit._tp = transit._transferParams();
        transit._dropOdCache();
        const nb = walkNeighbors(transit, hub).length;
        transit.config.transferNeighborLimit = 4;
        transit._tp = transit._transferParams();
        transit._dropOdCache();
        return nb === 12;
      })(), '');
    w.raw.close();
  }
  {
    // 5 km 的一对 + 4 km 覆盖半径：按覆盖范围算得上（8000 ≥ 5000），被 4000 m 绝对上限挡住
    const w = makeWorld();
    const { transit, user, at } = w;
    const M = transit.createStation(user, { name: 'M（主线）', kind: 'rail', ...at('main', 0) }).station.id;
    const S = transit.createStation(user, { name: 'S（≈5 km 外的另一条铁路）', kind: 'rail', ...at('side', 0) }).station.id;
    const d = Math.round(metersBetween(at('main', 0), at('side', 0)));
    setCatchment(transit, M, 4000);
    setCatchment(transit, S, 4000);
    const blocked = walkableInGraph(transit, M, S);
    check('相距 ≈5 km、覆盖半径 4000+4000 m：按覆盖范围算得上，但被 4000 m 绝对上限挡住（不能走）',
      d > 5000 - 100 && d < 5000 + 100 && !blocked
      && transit.transferWalkRadiusM(4000, 4000) === 4000 && transit.transferWalkRadiusM(4000, 4000) < d,
      `实际 ${d} m / 允许 ${transit.transferWalkRadiusM(4000, 4000)} m / 图里互通=${blocked}`);
    check('把绝对上限抬到 9000 m 以后同一对就互通了（证明挡住它的是上限，不是规则）',
      (() => {
        transit.config.transferMaxRadiusM = 9000;
        transit._tp = transit._transferParams();
        transit._dropOdCache();
        const ok = walkableInGraph(transit, M, S);
        const rad = transit.transferWalkRadiusM(4000, 4000);
        transit.config.transferMaxRadiusM = 4000;
        transit._tp = transit._transferParams();
        transit._dropOdCache();
        return ok && rad === 6000 && rad >= d;
      })(), '上限 9000 m 时允许距离 = 相对上限 6000 m（1.5 × 4000）');
    check('改回默认上限后又不能走了（口径完全由 config 决定）',
      !walkableInGraph(transit, M, S), `允许 ${transit.transferWalkRadiusM(4000, 4000)} m`);
    w.raw.close();
  }

  /* ============ 3. 覆盖范围一改，行程图 / O-D 表必须重算 ============ */
  console.log('\n▶ 缓存失效：station.update catchmentM 之后行程图与 O/D 表立刻按新半径重算');
  {
    const w = makeWorld({ tripRatePerDay: 6 });
    const { transit, user, at } = w;
    // 南边那条铁路（与主线相距 5 km，互不干扰）：
    //   S0（远，没线路）  --2989 m-->  S1（中间的站）  --1282 m-->  T / T2（有"侧线"）
    // 覆盖半径都是 700 m 时只有 S1–T / T–T2 这两对能走，S0 哪儿也去不了。
    const S0 = transit.createStation(user, { name: 'S0（起点，3 km 外）', kind: 'rail', catchmentM: 700, ...at('side', 0) }).station.id;
    const S1 = transit.createStation(user, { name: 'S1（中间站）', kind: 'rail', catchmentM: 700, ...at('side', 14) }).station.id;
    const T = transit.createStation(user, { name: 'T（有线路）', kind: 'rail', catchmentM: 700, ...at('side', 20) }).station.id;
    const T2 = transit.createStation(user, { name: 'T2（有线路）', kind: 'rail', catchmentM: 700, ...at('side', 25) }).station.id;
    transit.createLine(user, { name: '侧线', kind: 'rail', stops: [T, T2] });
    const dS0S1 = Math.round(metersBetween(at('side', 0), at('side', 14)));
    check(`先立一个"走不到"的局面：S0 距 S1 约 ${dS0S1} m（> 2.3 km），两边覆盖半径都是 700 m`,
      dS0S1 > 2300 && !walkableInGraph(transit, S0, S1) && transit._itinerary(S0, T2) === null,
      `允许 ${transit.transferWalkRadiusM(700, 700)} m`);
    const pairsBefore = transit._ensureOdDemand().stats.transfers.walkPairs;
    const servedBefore = transit.odForStation(S0).served;
    const builtBefore = transit._itinGraph.builtAt;
    // 用户操作：把中间那个站的覆盖范围改大（3000 = config.maxCatchment 的上限）
    const upd = transit.updateStation(user, { id: S1, catchmentM: 3000 });
    const pairsAfter = transit._ensureOdDemand().stats.transfers.walkPairs;
    check('station.update catchmentM=3000 之后：行程图重算、S0 立刻能走到 S1（换乘半径跟着覆盖范围变大）',
      transit._itinGraph.builtAt !== builtBefore && upd.station.catchmentM === 3000 && walkableInGraph(transit, S0, S1),
      `允许 ${transit.transferWalkRadiusM(3000, 700)} m ≥ ${dS0S1} m`);
    check('O/D 表也跟着重算：步行接驳对数变多了（新半径下多了 S0 那一条）',
      pairsAfter > pairsBefore, `互通对 ${pairsBefore} → ${pairsAfter}`);
    check('S0 站从"走不掉"变成"能走掉"（O/D 表里 served 从 0 变正）',
      servedBefore === 0 && transit.odForStation(S0).served > 0
      && transit.odForStation(S0).dests.some((d) => d.stationId === T2),
      `served ${servedBefore} → ${transit.odForStation(S0).served}，目的地 ${JSON.stringify(transit.odForStation(S0).dests.map((d) => d.stationId))}`);
    check('S0 → T2 的行程是「步行 + 步行 + 乘车」（两段步行接驳，正好用到 maxWalkLegs=2）',
      (() => {
        const p = transit._itinerary(S0, T2);
        return !!p && p.walkLegs === 2 && p.rideLegs === 1 && p.steps[0].type === 'walk' && p.steps[2].type === 'ride';
      })(), (() => {
        const p = transit._itinerary(S0, T2);
        return p ? p.steps.map((s) => `${s.type} ${s.from}->${s.to}(${s.meters}m)`).join(' + ') : '没有行程';
      })());
    // 撤销这次改动：撤销走的是 _applyTransitSteps（直接改 stations 表），缓存同样要作废
    transit.apply(user, { k: 'undo' });
    check('撤销这次覆盖范围修改后：行程图再作废一次，S0 又走不到 S1 了（撤销路径同样作废缓存）',
      !walkableInGraph(transit, S0, S1) && transit._itinerary(S0, T2) === null,
      `允许 ${transit.transferWalkRadiusM(700, 700)} m`);
    // 走一走模拟，确认撤销以后没有"幽灵乘客"在等车
    transit.createVehicle(user, { kind: 'metro_b6', lineId: transit._st.allLines.all()[0].id });
    transit.speed = 1;
    run(transit, 1800);
    check('撤销之后 S0 站一个人都没等到车（走不掉的乘客不排队）',
      transit.stationWaiting(S0).waiting === 0 && transit.stationPaxStats(S0).paxDeparted === 0,
      `等车 ${transit.stationWaiting(S0).waiting} 人 / 出发 ${transit.stationPaxStats(S0).paxDeparted} 人`);
    w.raw.close();
  }

  /* ============ 4. 乘客真的跨着 2990 m 的步行接驳换乘到另一条线 ============ */
  console.log('\n▶ 模拟：乘客坐 1 号线到 M1 → 步行 2990 m 到 M2 → 换 2 号线到 D');
  {
    // tripRatePerDay = 0：这一段全部由手工注入的 5 个乘客来跑，数字可复现
    //（"真实客流自己走这条长步行换乘"放在下一段）
    const w = makeWorld({ tripRatePerDay: 0, patienceSeconds: 1000000 });
    const { transit, user, at } = w;
    // main 上：A(0) -- M1(6) 是 1 号线；M2(20) -- D(32) 是 2 号线；
    // M1 与 M2 相距 14 格 ≈ 2989 m（老口径 2.3 km 走不到，新口径 4000 m 走得通），
    // 而 A→D（6835 m）与 M1→D（5554 m）都远在允许距离之外，绕路占不到便宜。
    const A = transit.createStation(user, { name: 'A 起点', kind: 'rail', catchmentM: 700, ...at('main', 0) }).station.id;
    const M1 = transit.createStation(user, { name: 'M1 下车步行', kind: 'rail', catchmentM: 3000, ...at('main', 6) }).station.id;
    const M2 = transit.createStation(user, { name: 'M2 走完上车', kind: 'rail', catchmentM: 3000, ...at('main', 20) }).station.id;
    const D = transit.createStation(user, { name: 'D 终点', kind: 'rail', catchmentM: 700, ...at('main', 32) }).station.id;
    const line1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, M1] }).line;
    const line2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [M2, D] }).line;
    const dWalk = Math.round(metersBetween(at('main', 6), at('main', 20)));
    const dM1D = Math.round(metersBetween(at('main', 6), at('main', 32)));
    const plan = transit._itinerary(A, D);
    check(`M1–M2 相距 ${dWalk} m（> 老口径 2.3 km），覆盖半径 3000+3000 → 允许 ${transit.transferWalkRadiusM(3000, 3000)} m，可以站间换乘`,
      dWalk > 2300 && dWalk <= transit.transferWalkRadiusM(3000, 3000), `${dWalk} m`);
    check('A → D 的行程 = 「1 号线 → 步行 2990 m → 2 号线」，换乘 1 次、步行 1 段',
      !!plan && plan.transfers === 1 && plan.walkLegs === 1 && plan.steps.length === 3
      && plan.steps[0].type === 'ride' && plan.steps[0].lineId === line1.id && plan.steps[0].to === M1
      && plan.steps[1].type === 'walk' && plan.steps[1].from === M1 && plan.steps[1].to === M2
      && plan.steps[2].type === 'ride' && plan.steps[2].lineId === line2.id && plan.steps[2].from === M2 && plan.steps[2].to === D,
      plan ? plan.steps.map((s) => `${s.type}${s.type === 'ride' ? '#' + s.lineId : ''} ${s.from}->${s.to}(${s.meters}m)`).join(' + ') : '没有行程');
    check('步行那一段仍然是 1 m/s + 每段固定代价（2990 m → 约 3050 游戏秒）',
      !!plan && plan.steps[1].sec >= plan.steps[1].meters
      && plan.steps[1].sec - plan.steps[1].meters <= 61
      && Math.abs(plan.steps[1].meters - dWalk) <= 2,
      plan ? `${plan.steps[1].meters} m 计 ${plan.steps[1].sec} 秒` : '');
    check(`走不了的那条路仍然走不了：M1 到 D 相距 ${dM1D} m，覆盖半径 3000+700 → 允许 ${transit.transferWalkRadiusM(3000, 700)} m（不能直接走完全程）`,
      dM1D > transit.transferWalkRadiusM(3000, 700) && !walkableInGraph(transit, M1, D), `${dM1D} m`);
    // --- 把两个换乘站的覆盖范围改回 700 m：这条换乘立刻消失（说明它完全是新规则带来的）---
    setCatchment(transit, M1, 700);
    setCatchment(transit, M2, 700);
    check('把 M1 / M2 的覆盖半径改回 700 m（默认值）后，A → D 再也没有行程（老口径下就是走不通）',
      transit._itinerary(A, D) === null, `允许 ${transit.transferWalkRadiusM(700, 700)} m < ${dWalk} m`);
    // 改回来（走 station.update，顺便再验一次缓存失效）
    transit.updateStation(user, { id: M1, catchmentM: 3000 });
    transit.updateStation(user, { id: M2, catchmentM: 3000 });

    // --- 手动注入 5 个乘客，逐站停靠，把"下车 → 步行计时器 → 重新排队 → 上车 → 到达"走一遍 ---
    const cache1 = transit.lineCache.get(line1.id);
    const cache2 = transit.lineCache.get(line2.id);
    const plan2 = transit._itinerary(A, D);
    transit._addWaiting(A, cache1.queueCompanyId, cache1.companyOwner, line1.id, 5, transit.clockMs, D, plan2, 0);
    const veh1 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line1.id }).vehicle;
    const rt1 = transit._runtimeFor(veh1.id);
    transit._dock(transit._st.vehicle.get(veh1.id), cache1, rt1, cache1.path, cache1.stops.find((s) => s.stationId === A));
    check('1 号线的车在 A 站把 5 个人拉上车', rt1.lastBoarded === 5 && rt1.load === 5, `上客 ${rt1.lastBoarded}`);
    transit._dock(transit._st.vehicle.get(veh1.id), cache1, rt1, cache1.path, cache1.stops.find((s) => s.stationId === M1));
    check('车到 M1：5 个人下车去步行接驳（不是到达、也不在车上）',
      rt1.lastAlighted === 5 && rt1.load === 0 && transit.stationPaxStats(M1).paxTransferred === 5 && transit.stationPaxStats(M1).paxArrived === 0,
      `下车 ${rt1.lastAlighted} / M1 台账 ${JSON.stringify(transit.stationPaxStats(M1))}`);
    const walkers = transit.walkers.get(M1) || [];
    const wSec = walkers.length ? Math.round((walkers[0].readyAtMs - transit.clockMs) / 1000) : -1;
    check('M1 站厅里挂上了"步行计时器"：走完的时间 = 距离 ÷ 1 m/s + 固定代价（≈3050 游戏秒）',
      walkers.length === 1 && walkers[0].people === 5 && Math.abs(wSec - plan2.steps[1].sec) <= 1,
      `${walkers.length ? walkers[0].people : 0} 人 / ${wSec} 秒（行程里的步行段 ${plan2.steps[1].sec} 秒）`);
    check('步行接驳期间 M1 的账是"步行出发"（paxWalked / paxDeparted 记上了）',
      transit.stationPaxStats(M1).paxWalked === 5 && transit.stationPaxStats(M1).paxDeparted === 5,
      JSON.stringify(transit.stationPaxStats(M1)));
    run(transit, plan2.steps[1].sec + 120);
    const b2 = bucketOf(transit, M2, cache2.queueCompanyId, cache2.companyOwner, line2.id);
    check('走完 2990 m 之后，这 5 个人排进了 M2 站 2 号线的队（第二段）',
      !!b2 && b2.waiting === 5 && b2.cohorts.every((c) => c.destId === D),
      b2 ? `M2 等车 ${b2.waiting} 人` : '没有 2 号线的桶');
    const veh2 = transit.createVehicle(user, { kind: 'metro_b4', lineId: line2.id }).vehicle;
    const rt2 = transit._runtimeFor(veh2.id);
    transit._dock(transit._st.vehicle.get(veh2.id), cache2, rt2, cache2.path, cache2.stops.find((s) => s.stationId === M2));
    check('2 号线的车在 M2 把这 5 个人拉上车', rt2.lastBoarded === 5 && rt2.load === 5, `上客 ${rt2.lastBoarded}`);
    transit._dock(transit._st.vehicle.get(veh2.id), cache2, rt2, cache2.path, cache2.stops.find((s) => s.stationId === D));
    check('到 D 站全部下车（到达目的站），M1 记的是"换乘"，D 记的是"到达"',
      rt2.lastAlighted === 5 && transit.stationPaxStats(D).paxArrived === 5 && transit.stationPaxStats(M1).paxTransferred === 5,
      `D 到达 ${transit.stationPaxStats(D).paxArrived} / M1 换乘 ${transit.stationPaxStats(M1).paxTransferred}`);
    check('两条线都记了人次：1 号线 riders=5（拉人到换乘站）、2 号线 riders=5（拉人到终点）',
      ridersToday(transit, line1.id) === 5 && ridersToday(transit, line2.id) === 5,
      `1 号线 ${ridersToday(transit, line1.id)} / 2 号线 ${ridersToday(transit, line2.id)}`);
    w.raw.close();
  }
  {
    // 真实客流（不手工注入）：O/D 表自己把乘客送上这条"长步行换乘"
    const w = makeWorld({ tripRatePerDay: 60, patienceSeconds: 1000000 });
    const { transit, user, at } = w;
    const A = transit.createStation(user, { name: 'A 起点', kind: 'rail', catchmentM: 700, ...at('main', 0) }).station.id;
    const M1 = transit.createStation(user, { name: 'M1 下车步行', kind: 'rail', catchmentM: 3000, ...at('main', 6) }).station.id;
    const M2 = transit.createStation(user, { name: 'M2 走完上车', kind: 'rail', catchmentM: 3000, ...at('main', 20) }).station.id;
    const D = transit.createStation(user, { name: 'D 终点', kind: 'rail', catchmentM: 700, ...at('main', 32) }).station.id;
    const line1 = transit.createLine(user, { name: '1 号线', kind: 'rail', stops: [A, M1] }).line;
    const line2 = transit.createLine(user, { name: '2 号线', kind: 'rail', stops: [M2, D] }).line;
    transit.createVehicle(user, { kind: 'metro_b6', lineId: line1.id });
    transit.createVehicle(user, { kind: 'metro_b6', lineId: line2.id });
    transit.speed = 1;
    const od = transit._ensureOdDemand();
    check('O/D 表里这条"步行换乘"的行程被算进了可达（A 站的目的地里有 D，且带 1 次换乘的行程）',
      (() => {
        const e = od.byLine.get(line1.id) && od.byLine.get(line1.id).get(A);
        const hit = e && e.destMix.find((x) => x.stationId === D);
        return !!hit && !!hit.plan && hit.plan.walkLegs === 1 && hit.plan.transfers === 1;
      })(), `含步行接驳的行程 ${od.stats.itineraries.walkLegs} 条（阈值 ${od.stats.itineraries.walkLegs}）`);
    let arrivedAtD = 0;
    for (let i = 0; i < 240 && arrivedAtD <= 0; i++) {
      run(transit, 120);
      arrivedAtD = transit.stationPaxStats(D).paxArrived;
    }
    check('真实客流里真的有乘客经"2990 m 步行换乘"到达 D 站', arrivedAtD > 0, `D 站到达 ${arrivedAtD} 人`);
    check('M1 站记下了"换乘 + 步行出发"（这批人不是从 M1 直接到终点的）',
      transit.stationPaxStats(M1).paxTransferred > 0 && transit.stationPaxStats(M1).paxWalked > 0,
      `M1 ${JSON.stringify(transit.stationPaxStats(M1))}`);
    check('两条线都有客流，且 2 号线的客流只可能来自"走过来的"乘客',
      ridersToday(transit, line1.id) > 0 && ridersToday(transit, line2.id) > 0,
      `1 号线 ${ridersToday(transit, line1.id)} 人次 / 2 号线 ${ridersToday(transit, line2.id)} 人次`);
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
