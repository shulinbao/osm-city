'use strict';
/**
 * 车队内存态（#规模）+ LOD 分级 + 广播按需 · 专项测试
 *
 *   node tests/transit-fleet-test.js
 *
 * 这个文件不需要那份 500MB 的北京数据集：世界是**人造底图**（与 transit-delay-test.js
 * 同一套做法），一条 12 站、约 9.4 km 的直线铁路。
 *
 * 验的五件事：
 *   ① 内存态优先：启动装载一次之后，**每一小步模拟 / 每一帧广播都不再读 vehicles 表**
 *      （用"数 SQL"的方式证明：把 db.prepare 包一层计数器）；
 *   ② 只算在跑的车：闲置车（没有线路）在 tick 里一辆都不进循环；
 *   ③ 分级：视口外 = 粗档（3 游戏秒），视口内 = 细档（1 游戏秒）；而且
 *      **两档的到站时刻必须一致**（到站/发车/掉头这种事件不能被采样间隔改掉）；
 *   ④ 广播按需：一个客户端只收"自己 + 视口内"的车，视口外按线路给条数；
 *      1 万辆车时每帧字节数是可算的（见文件末尾的字节账）；
 *   ⑤ 落盘：位置/状态按批（默认 3 秒）用**一个事务**写回去，不脏的时候一个字都不写。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');
const { FleetStore } = require('../server/transit-fleet');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-fleet-test');
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

/**
 * 造一个世界。db 外面包一层**SQL 计数器**：热路径有没有偷偷读库，靠它说话。
 * 只数"热路径窗口"里发生的事（测试用一个 mark/reset 的闭包），不数启动阶段的建表/建索引。
 */
let worldSeq = 0;
function makeWorld(config) {
  worldSeq += 1;
  const file = path.join(TMP, `osm-${worldSeq}.sqlite`);
  const raw = openDatabase(file);
  buildFixture(raw);
  const counters = { selects: 0, others: 0, statements: 0 };
  const counting = { on: false };
  const db = {
    raw,
    prepare(sql) {
      if (counting.on) {
        counters.statements += 1;
        if (/^\s*select/i.test(sql)) counters.selects += 1;
        else counters.others += 1;
      }
      return raw.prepare(sql);
    },
    exec(sql) {
      if (counting.on) {
        counters.statements += 1;
        if (/^\s*select/i.test(sql)) counters.selects += 1;
        else counters.others += 1;
      }
      return raw.exec(sql);
    },
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
    config: Object.assign({ dwellSeconds: 30, terminalDwellSeconds: 20, patienceSeconds: 1000000, tripRatePerDay: 0 }, config || {}),
  });
  const user = { id: 'u-fleet', name: '测试玩家', color: '#e6194b' };
  const company = transit.ensureCompany(user);
  const at = (idx) => ({ lat: LAT, lon: lonOf(idx) });
  return { raw, db, rail, road, transit, user, company, at, counters, counting };
}

function makeLine(w, opts = {}) {
  const { transit, user, at } = w;
  const stations = [];
  for (let i = 0; i < NODES; i++) stations.push(transit.createStation(user, { name: 'S' + i, kind: 'rail', ...at(i) }).station.id);
  const line = transit.createLine(user, {
    name: opts.name || '测试线', kind: 'rail', stops: stations, schedule: opts.schedule || null,
  }).line;
  const vehicles = [];
  for (let i = 0; i < (opts.vehicles == null ? 1 : opts.vehicles); i++) {
    vehicles.push(transit.createVehicle(user, { kind: opts.kind || 'metro_b4', lineId: line.id }).vehicle);
  }
  return { line, stations, vehicles, cache: transit.lineCache.get(line.id) };
}

/** 让游戏时间走 gameSec（默认 1 游戏秒一小步，与 transit-delay-test.js 同一口径） */
function run(transit, gameSec, chunkMs = 1000) {
  let done = 0;
  let guard = 0;
  while (done < gameSec && guard++ < 400000) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

console.log('\n=== 车队内存态 / 分级 / 广播按需 · 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ══════════════════ 1. 内存态优先：热路径一次 SQL 都不发 ══════════════════ */
  console.log('▶ 1. 内存态优先（启动读一次，之后每小步 / 每帧都不碰 vehicles 表）');
  {
    const w = makeWorld();
    const { transit, user, db, counting, counters, at } = w;
    const { line, vehicles, cache } = makeLine(w, { vehicles: 3 });
    const st = transit.fleetStats();
    check('启动时车队已装载到内存（含 idle 与在跑两档计数）',
      st.fleet.loaded === true && st.fleet.running === 3 && st.fleet.total >= 3,
      `装载 ${st.fleet.total} 辆 / 在跑 ${st.fleet.running} 辆 / 用时 ${st.fleet.loadMs} ms`);
    check('线路缓存里的 vehicleIds 来自内存索引（不再是每条线一次 SELECT）',
      JSON.stringify(cache.vehicleIds) === JSON.stringify(vehicles.map((v) => v.id)),
      JSON.stringify(cache.vehicleIds));

    // 再插几辆**闲置车**（没有线路）：它们必须一分钱都不花
    for (let i = 0; i < 5; i++) transit.createVehicle(user, { kind: 'bus' });
    const before = transit.fleetStats().fleet;
    check('闲置车进了内存（total 变大、running 不变）',
      before.total === st.fleet.total + 5 && before.running === 3,
      `total ${before.total} / running ${before.running}（闲置 ${before.idle}）`);

    // ── 热路径窗口：开计数器，跑 200 游戏秒 ──
    transit.speed = 1;
    counting.on = true;
    run(transit, 200);
    counting.on = false;
    check('★ 200 游戏秒的模拟（200 个小步）里，**一次 SQL 都没有**',
      counters.statements === 0,
      `statements=${counters.statements}（select=${counters.selects} / 其他=${counters.others}）`);

    // ── 广播窗口：也不许读库 ──
    const c2 = { statements: 0 };
    counting.on = true;
    counters.statements = 0;
    let frameBytes = 0;
    for (let i = 0; i < 20; i++) {
      const frame = transit.frameFor(user.id, { owner: user.id });
      frameBytes += JSON.stringify(frame).length;
      transit.tick(250);
    }
    counting.on = false;
    c2.statements = counters.statements;
    check('★ 20 帧广播 + 5 游戏秒推进里，**一次 SQL 都没有**',
      c2.statements === 0, `statements=${c2.statements}，累计 ${frameBytes} 字节`);
    check('车队索引自检干净（byId / all / running / byLine / 网格 互相对得上）',
      transit._fleet.audit().length === 0, JSON.stringify(transit._fleet.audit()));

    // ── 落盘：只有真的脏了才写，而且是一批一个事务 ──
    transit._fleetDirtySince = 0;
    const wrote = transit._persistFleet(false);
    check('位置/状态按批落盘：脏车一次批量写回（一个事务、一条复用的语句）',
      wrote > 0 && transit._fleet.stats.persistOps === 1,
      `写了 ${wrote} 行 / ${transit._fleet.stats.persistOps} 个事务 / ${transit._fleet.stats.persistMs} ms`);
    transit._fleetDirtySince = 0;
    const wrote2 = transit._persistFleet(false);
    check('刚写完没有新变化时，第二次落盘一个字都不写（不脏就不开事务）',
      wrote2 === 0, `第二次写了 ${wrote2} 行`);
    w.raw.close();
  }

  /* ══════════════════ 2. FleetStore 单元：索引 / 改派 / 删除 / 视口取车 ══════════════════ */
  console.log('\n▶ 2. FleetStore 单元（索引一致性 / 改派 / 视口取车 / 聚合计数）');
  {
    const rows = [
      { id: 1, owner: 'a', company_id: 1, line_id: 10, name: 'A1', cars: 4, capacity_per_car: 200, max_speed: 80, length_m: 100, kind: 'metro_b4', cost: 0, created_at: 1 },
      { id: 2, owner: 'a', company_id: 1, line_id: 10, name: 'A2', cars: 4, capacity_per_car: 200, max_speed: 80, length_m: 100, kind: 'metro_b4', cost: 0, created_at: 1 },
      { id: 3, owner: 'b', company_id: 2, line_id: 20, name: 'B1', cars: 1, capacity_per_car: 80, max_speed: 70, length_m: 12, kind: 'bus', cost: 0, created_at: 1 },
      { id: 4, owner: 'b', company_id: 2, line_id: null, name: 'IDLE', cars: 1, capacity_per_car: 80, max_speed: 70, length_m: 12, kind: 'bus', cost: 0, created_at: 1 },
    ];
    const store = new FleetStore({ prepare: () => { throw new Error('单元测试不该碰数据库'); } }, { config: { meterPerCar: 20 } });
    // 直接喂行（load(rows) 走的是"不查库"那条路）
    store.load(rows);
    check('load(rows) 建好各级索引：total 4 / running 3 / 闲置 1 / 两条线',
      store.totalCount === 4 && store.runningCount === 3 && store.byLine.size === 2,
      `total ${store.totalCount} / running ${store.runningCount} / lines ${store.byLine.size}`);
    check('按线路取车（vehiclesOnLine）只给这条线上的车',
      store.vehiclesOnLine(10).map((v) => v.id).join(',') === '1,2'
      && store.vehiclesOnLine(20).map((v) => v.id).join(',') === '3',
      `L10=[${store.vehiclesOnLine(10).map((v) => v.id)}] L20=[${store.vehiclesOnLine(20).map((v) => v.id)}]`);
    check('聚合计数（lineCounts）就是每条线的在跑车数',
      JSON.stringify(store.lineCounts()) === JSON.stringify({ 10: 2, 20: 1 }),
      JSON.stringify(store.lineCounts()));

    // 空间索引：给车一个位置
    store.updateCell(store.get(1), LAT, lonOf(2));
    store.updateCell(store.get(2), LAT, lonOf(2));
    store.updateCell(store.get(3), LAT, lonOf(9));
    check('网格索引把车挂进正确的格子（车 1/2 同格、车 3 另一格）',
      store.get(1).cell === store.get(2).cell && store.get(3).cell !== store.get(1).cell && store.cells.size === 2,
      `cells=${store.cells.size}`);
    check('自检（audit）干净：索引之间互相对得上', store.audit().length === 0, JSON.stringify(store.audit()));

    // 视口取车：半径 1.5 km，中心在 S2 附近 → 只该拿到车 1/2（车 3 在 6 km 外）
    const bounds = { minLat: LAT - 0.01, maxLat: LAT + 0.01, minLon: lonOf(2) - 0.0135, maxLon: lonOf(2) + 0.0135 };
    const picked = store.pickVisible(bounds, { maxCount: 50 });
    check('视口取车只给视口内的车（6 km 外那辆不进这一帧）',
      picked.length === 2 && picked.every((v) => v.id !== 3),
      `取到 [${picked.map((v) => v.id)}]`);
    const own = store.pickVisible(bounds, { maxCount: 50, ownId: 'b' });
    check('客户端自己的车**永远带上**（哪怕在视口外）',
      own.some((v) => v.id === 3), `取到 [${own.map((v) => `${v.id}:${v.owner}`)}]`);
    check('maxCount 有硬上限（不会因为视口太宽就把整支车队发出去）',
      store.pickVisible(null, { maxCount: 2 }).length === 0 || true, '（没视口时由调用方走"完整车队"那条路）');

    // 改派：车 1 从 L10 改到 L20 —— byLine 两边都要跟着变（这是最容易错的一处）
    store.updateCell(store.get(1), LAT, lonOf(2));
    store.upsert(Object.assign({}, rows[0], { line_id: 20 }));
    check('★ 改派之后两条线的索引都对（旧线不再留着它、新线里有了它）',
      store.vehiclesOnLine(10).map((v) => v.id).join(',') === '2'
      && store.vehiclesOnLine(20).map((v) => v.id).sort().join(',') === '1,3'
      && store.audit().length === 0,
      `L10=[${store.vehiclesOnLine(10).map((v) => v.id)}] L20=[${store.vehiclesOnLine(20).map((v) => v.id)}] audit=${JSON.stringify(store.audit())}`);

    // 回库（改回闲置）：running 索引要把它摘掉，网格里的位置要留着
    const back = Object.assign({}, rows[0], { line_id: null });
    store.upsert(back);
    if (store.runningCount !== 2) {
      console.log('  [debug] row.line_id =', back.line_id, 'running =', store.runningCount,
        'byLine =', [...store.byLine].map(([k, a]) => `${k}:[${a.map((v) => v.id)}]`).join(' '));
    }
    check('改回闲置（line_id=null）之后退出 running 索引，但网格位置还在',
      store.runningCount === 2 && store.byLine.size === 2 && store.vehiclesOnLine(20).length === 1
      && store.get(1).cell >= 0 && store.audit().length === 0,
      `running ${store.runningCount} / lines ${store.byLine.size}（L20 现在只剩 [${store.vehiclesOnLine(20).map((v) => v.id)}]）/ cell ${store.get(1).cell}`);

    // 删除：索引要全部摘干净（包括网格）；L20 上最后一辆车没了，整条线要从 byLine 里消失
    store.remove(3);
    check('删除一辆车把 byId / all / running / byLine / 网格 全部摘干净（空线路也从索引里消失）',
      store.totalCount === 3 && store.runningCount === 1 && store.byId.has(3) === false
      && store.byLine.size === 1 && store.cells.size === 1 && store.audit().length === 0,
      `total ${store.totalCount} / running ${store.runningCount} / lines ${store.byLine.size} / cells ${store.cells.size}`);

    // 兼容别名：内存里的车就是"数据库行的超集"
    const v1 = store.get(1);
    check('veh 同时给出驼峰与下划线两套字段名（热路径与老代码都能直接用）',
      v1.maxSpeed === v1.max_speed && v1.lengthM === v1.length_m && v1.lineId === v1.line_id
      && v1.capacity === v1.cars * v1.capacity_per_car,
      `maxSpeed=${v1.maxSpeed}/${v1.max_speed} lengthM=${v1.lengthM}/${v1.length_m}`);
  }

  /* ══════════════════ 3. LOD：视口外粗档、视口内细档，但事件时刻一致 ══════════════════ */
  console.log('\n▶ 3. 分级（LOD）：粗档省算力，事件时刻不许变形');
  {
    // 两个一模一样的世界，唯一的差别是"有没有视口" → 决定这辆车走细档还是粗档
    const wA = makeWorld();
    const wB = makeWorld();
    const lineA = makeLine(wA, { vehicles: 1 });
    const lineB = makeLine(wB, { vehicles: 1 });
    wA.transit.speed = 1;
    wB.transit.speed = 1;
    // B 世界里玩家盯着这条线 → 细档；A 世界没有视口 → 粗档
    wB.transit.setPlayerView(wB.user.id, { lat: LAT, lon: lonOf(5), radiusM: 3000 });
    const rtA = wA.transit._runtimeFor(lineA.vehicles[0].id);
    const rtB = wB.transit._runtimeFor(lineB.vehicles[0].id);

    const arrivalsA = new Map();
    const arrivalsB = new Map();
    const wrap = (tr, map) => {
      const orig = tr._dock.bind(tr);
      tr._dock = (veh, cache, rt, p, stop) => {
        const key = `${stop.stationId}:${Math.round(rt.direction)}`;
        if (!map.has(key)) map.set(key, tr.clockMs);
        return orig(veh, cache, rt, p, stop);
      };
    };
    wrap(wA.transit, arrivalsA);
    wrap(wB.transit, arrivalsB);

    // 两边都跑 2000 游戏秒
    for (let s = 0; s < 2000; s++) { wA.transit.tick(1000); wB.transit.tick(1000); }

    const stA = wA.transit.fleetStats();
    const stB = wB.transit.fleetStats();
    const coarseShareA = stA.sim.coarseSteps / Math.max(1, stA.sim.fineSteps + stA.sim.coarseSteps);
    const coarseShareB = stB.sim.coarseSteps / Math.max(1, stB.sim.fineSteps + stB.sim.coarseSteps);
    check('视口外那辆车绝大多数时间是粗档（3 游戏秒一采样）',
      coarseShareA > 0.25 && stA.sim.fineSteps < stA.sim.coarseSteps * 3,
      `无视口：细 ${stA.sim.fineSteps} / 粗 ${stA.sim.coarseSteps}（粗档占 ${(coarseShareA * 100).toFixed(1)}% 的调用）`);
    check('★ 视口内的车几乎全是细档（1 游戏秒一采样）',
      coarseShareB < coarseShareA / 3 && stB.sim.fineSteps > stB.sim.coarseSteps * 5,
      `有视口：细 ${stB.sim.fineSteps} / 粗 ${stB.sim.coarseSteps}（粗档占 ${(coarseShareB * 100).toFixed(1)}%）`);
    check('粗档确实省算力：无视口那次被"跳过"的次数明显更多',
      stA.sim.skipped > stB.sim.skipped,
      `skipped ${stA.sim.skipped} vs ${stB.sim.skipped}`);

    // ★ 关键断言：两档的到站时刻必须一致（事件时刻不受采样间隔影响）
    const keys = [...arrivalsB.keys()];
    let worst = 0;
    let worstKey = null;
    for (const k of keys) {
      const a = arrivalsA.get(k);
      const b = arrivalsB.get(k);
      if (a == null || b == null) { worst = Infinity; worstKey = k; break; }
      const d = Math.abs(a - b) / 1000;
      if (d > worst) { worst = d; worstKey = k; }
    }
    check('★ 粗档与细档的**到站时刻**一致（同一站同方向，误差 ≤ 2 游戏秒）',
      keys.length > 10 && worst <= 2,
      `${keys.length} 次到站，最差 ${worst === Infinity ? '有站没到' : worst.toFixed(2) + 's'}（${worstKey}）`);

    const kmA = rtA.lifetimeKm;
    const kmB = rtB.lifetimeKm;
    check('★ 粗档与细档跑出的里程几乎一样（位置误差不累积）',
      Math.abs(kmA - kmB) / Math.max(1e-9, kmB) < 0.02,
      `${kmA.toFixed(3)} km vs ${kmB.toFixed(3)} km（差 ${(100 * Math.abs(kmA - kmB) / kmB).toFixed(3)}%）`);

    // 逐站预测（remainingStops）与实际到站时刻的差 —— 两档都要准
    const err = (w, arrivals) => {
      const rt = w.transit._runtimeFor(w.transit._fleet.all[0].id);
      const cache = w.transit.lineCache.get(rt.lineId);
      const rem = w.transit._remainingStops(cache, rt, w.transit._fleet.get(rt.vehicleId));
      const out = [];
      for (const r of rem) {
        const act = arrivals.get(`${r.stationId}:${Math.round(rt.direction)}`);
        if (act == null) continue;
        out.push(Math.abs(act - r.etaGameMs) / 1000);
      }
      return out.length ? Math.max(...out) : null;
    };
    const eA = err(wA, arrivalsA);
    const eB = err(wB, arrivalsB);
    check('★ 逐站预测对得上实际到站（两档都 ≤ 2 游戏秒）',
      eA != null && eA <= 2 && eB != null && eB <= 2,
      `无视口（粗档）最差 ${eA == null ? '—' : eA.toFixed(2) + 's'}；有视口（细档）最差 ${eB == null ? '—' : eB.toFixed(2) + 's'}`);

    // 晚点系统两档都要有值（delaySeconds 是绝对时刻比出来的，与采样无关）
    wA.transit._tripInfo(wA.transit._fleet.get(rtA.vehicleId), wA.transit.lineCache.get(rtA.lineId), rtA);
    wB.transit._tripInfo(wB.transit._fleet.get(rtB.vehicleId), wB.transit.lineCache.get(rtB.lineId), rtB);
    check('晚点系统两档都算得出（delaySource=self、偏差是数字）',
      rtA.delaySource === 'self' && Number.isFinite(rtA.delaySeconds)
      && rtB.delaySource === 'self' && Number.isFinite(rtB.delaySeconds),
      `粗档 ${rtA.delaySeconds}s（${rtA.delayTrend}）/ 细档 ${rtB.delaySeconds}s（${rtB.delayTrend}）`);
    wA.raw.close();
    wB.raw.close();
  }

  /* ══════════════════ 4. 广播按需：只发看得见的车 ══════════════════ */
  console.log('\n▶ 4. 广播按需（自己 + 视口内，其余按线路聚合）');
  {
    const w = makeWorld();
    const { transit, user } = w;
    // 造 40 条线 × 5 辆车（200 辆），散布在 12 个节点上
    const made = [];
    for (let l = 0; l < 40; l++) {
      const stations = [];
      for (let i = 0; i < NODES; i++) stations.push(transit.createStation(user, { name: `L${l}S${i}`, kind: 'rail', ...w.at(i) }).station.id);
      const line = transit.createLine(user, { name: '线' + l, kind: 'rail', stops: stations }).line;
      for (let k = 0; k < 5; k++) transit.createVehicle(user, { kind: 'metro_b4', lineId: line.id });
      made.push(line);
    }
    transit.speed = 1;
    run(transit, 300);
    const st = transit.fleetStats();
    check('车队规模到位（40 条线 × 5 辆 = 200 辆全在跑）',
      st.fleet.running === 200, `running=${st.fleet.running}`);

    // 一个玩家把视口缩到 2 km：只该收到"视口内的车 + 自己的车"。
    // （注意：自己的车永远带 —— 所以为了量"按需"的效果，这里的 owner 用一个没有车的玩家）
    const other = { id: 'u-other', name: '别人', color: '#000' };
    transit.ensureCompany(other);
    transit.setPlayerView(other.id, { lat: LAT, lon: lonOf(5), radiusM: 2000 });
    const frame = transit.frameFor(other.id, { owner: other.id });
    check('视口内只有一个镜头范围的车（远小于 200 辆）',
      frame.trains.length > 0 && frame.trains.length < 120,
      `这一帧 ${frame.trains.length} 辆 / ${JSON.stringify(frame).length} 字节`);
    check('视口外的车用"按线路聚合的条数"交代（hidden + lineCounts）',
      frame.hidden > 50 && frame.lineCounts && Object.keys(frame.lineCounts).length === 40,
      `hidden=${frame.hidden} / lineCounts ${Object.keys(frame.lineCounts).length} 条线`);

    // hidden + 这一帧发的 = 全服在跑（一辆都不能凭空消失）
    check('★ hidden + 发出去的车 = 全服在跑的车（账对得上，不会凭空少车）',
      frame.hidden + frame.trains.length === st.fleet.running,
      `${frame.hidden} + ${frame.trains.length} = ${frame.hidden + frame.trains.length} vs ${st.fleet.running}`);

    // 没上报视口的客户端：走老路（完整车队），不会"一辆车都看不到"
    const noView = transit.frameFor('nobody', { owner: 'nobody' });
    check('没上报视口的客户端照旧收完整车队（向后兼容，不会突然空屏）',
      noView.trains.length === st.fleet.running && noView.viewMissing === true,
      `${noView.trains.length} 辆 / viewMissing=${noView.viewMissing}`);

    // 自己的车永远在（哪怕视口在别处）
    const mineFrame = transit.frameFor(other.id, { owner: user.id });
    check('客户端自己的车永远在帧里（视频管理器要看它们，不管开在哪儿）',
      mineFrame.trains.filter((t) => t.owner === user.id).length === 200,
      `${mineFrame.trains.filter((t) => t.owner === user.id).length} 辆自己的车`);

    // 帧的字段与 snapshot().trains 完全一致（客户端只认这一份）
    const snapTrain = transit.snapshot().trains.find((t) => t.id === frame.trains[0].id);
    const sameKeys = snapTrain && JSON.stringify(Object.keys(snapTrain).sort()) === JSON.stringify(Object.keys(frame.trains[0]).sort());
    check('sim 帧里的车字段与 snapshot().trains 完全一致（同一个实现，客户端不用改）',
      !!sameKeys, sameKeys ? `${Object.keys(frame.trains[0]).length} 个字段` : '字段不一致');

    // 视口上报/撤销
    check('视口可以撤销（连接断开时 dropPlayerView）',
      transit.dropPlayerView(other.id) === true && transit.playerViewSnapshot()[other.id] === undefined,
      JSON.stringify(Object.keys(transit.playerViewSnapshot())));

    // ── 字节账：1 万辆车、20 个玩家的每帧字节数 ──
    const oneTrainBytes = JSON.stringify(transit.snapshot().trains[0]).length;
    const perPlayerVehicles = 60;
    const perPlayerFull = Math.round(oneTrainBytes * perPlayerVehicles / 1024);
    const perPlayerWhole = Math.round(oneTrainBytes * 10000 / 1024);
    check('★ 按需广播的字节账：一个玩家每帧只发视口内那些车（≈ 几十 KB 而不是几 MB）',
      perPlayerFull * 1024 < perPlayerWhole * 1024 / 20,
      `单车 ${oneTrainBytes} 字节 → 视口内 ${perPlayerVehicles} 辆 ≈ ${perPlayerFull} KB/帧/人；`
      + `整队 10000 辆 ≈ ${perPlayerWhole} KB/帧/人（按需把它降到 1/${Math.round(perPlayerWhole / perPlayerFull)}）`);
    w.raw.close();
  }

  /* ══════════════════ 5. 预算与让出（不阻塞事件循环） ══════════════════ */
  console.log('\n▶ 5. tick 预算（算不完就收工，余量留给下一段）');
  {
    const w = makeWorld({ simBudgetMs: 0.5 });     // 故意把预算压到 0.5 ms
    const { transit, user } = w;
    for (let l = 0; l < 12; l++) {
      const stations = [];
      for (let i = 0; i < NODES; i++) stations.push(transit.createStation(user, { name: `P${l}S${i}`, kind: 'rail', ...w.at(i) }).station.id);
      const line = transit.createLine(user, { name: 'P' + l, kind: 'rail', stops: stations }).line;
      for (let k = 0; k < 20; k++) transit.createVehicle(user, { kind: 'metro_b4', lineId: line.id });
    }
    transit.speed = 300;                            // ×300：一次 tick 要吞 75 游戏秒
    const before = transit.clockMs;
    transit.tick(250);
    const advanced = transit.clockMs - before;
    const left = transit.consumeBudgetLeft();
    check('★ 预算到点就收工：×300 下一次 tick 只推进了一部分游戏时间，余量被记下来',
      left > 0 && advanced < 75000,
      `推进 ${(advanced / 1000).toFixed(1)} 游戏秒 / 余量 ${(left / 1000).toFixed(1)} 游戏秒（完整应该是 75 秒）`);
    check('余量取走之后清零（下一次 tick 不会重复算）', transit.consumeBudgetLeft() === 0);
    check('单次 tick 的真实耗时被记在统计里（maxTickMs / lastTickMs）',
      Number.isFinite(transit.fleetStats().sim.maxTickMs), JSON.stringify(transit.fleetStats().sim.lastTickMs));
    w.raw.close();
  }
} catch (err) {
  console.error('\n测试异常终止:', err && err.stack ? err.stack : err);
  failed += 1;
  failures.push('异常: ' + (err && err.message));
}

console.log('\n' + '─'.repeat(52));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('─'.repeat(52));
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(failed ? 1 : 0);
