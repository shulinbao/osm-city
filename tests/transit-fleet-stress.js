'use strict';
/**
 * 车队规模压测（#规模：NIMBY Rails 那种"几万辆车同时在跑"）
 *
 *   node tests/transit-fleet-stress.js            # 1k / 10k / 30k 全跑
 *   node tests/transit-fleet-stress.js 1000 10000 # 只跑指定的几档
 *
 * 场景是**合成**的（不需要那份 500MB 的北京数据集）：一片 M×N 的铁路网格，
 * 每条线路包一条路上的一段（8 个节点 ≈ 7 km），线上铺满车。这模拟了"200 条线 ×
 * 50 辆车"这种真实玩法规模下的路网形态（线路互相共线、站站停、有净距约束）。
 *
 * 报出来的数字（每一项都在下面的输出里，便于抄进文档）：
 *   ① 每一小步 / 每次 tick 的毫秒数：×1 / ×60 / ×300
 *   ② 10 分钟（游戏时间）之后的堆内存
 *   ③ 20 个玩家、每人一个视口时的**每帧字节数**（按需广播）
 *   ④ 最长同步片段（longestSyncMs）与它相对 10 ms 预算的位置
 *   ⑤ 粗档 / 细档的**到站时刻**差（LOD 精度代价）
 *   ⑥ 车队从头建起来的耗时（启动成本）
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');

const TMP = path.join(__dirname, 'tmp-fleet-stress');
const LAT0 = 39.80;
const LON0 = 116.30;
const D_LAT = 0.02;           // ≈ 2.2 km 一格（短区间：车多时净距约束才吃得住）
const D_LON = 0.026;          // ≈ 2.2 km
const NODE_BASE = 1_000_000;
const WAY_BASE = 2_000_000;

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const fmtKB = (n) => `${(n / 1024).toFixed(1)} KB`;
const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** 合成底图：M×N 网格，横竖都是一条 way（每格 ≈ 2.2 km） */
function buildGrid(db, cols, rows) {
  const insNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = db.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  const nodeId = (c, r) => NODE_BASE + r * 1000 + c;
  const lat = (r) => LAT0 + r * D_LAT;
  const lon = (c) => LON0 + c * D_LON;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      insNode.run(nodeId(c, r), lat(r), lon(c), now);
      insIndex.run(nodeId(c, r), lon(c), lon(c), lat(r), lat(r));
    }
  }
  const ways = { row: [], col: [] };
  for (let r = 0; r < rows; r++) {
    const id = WAY_BASE + r;
    for (let c = 0; c < cols; c++) insWayNode.run(id, c, nodeId(c, r));
    insWay.run(id, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, cols, lat(r), lat(r), lon(0), lon(cols - 1));
    insWayIndex.run(id, lon(0), lon(cols - 1), lat(r), lat(r));
    ways.row.push({ id, nodes: Array.from({ length: cols }, (_, c) => nodeId(c, r)), lat: lat(r), lon: (c) => lon(c) });
  }
  for (let c = 0; c < cols; c++) {
    const id = WAY_BASE + 5000 + c;
    for (let r = 0; r < rows; r++) insWayNode.run(id, r, nodeId(c, r));
    insWay.run(id, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, rows, lat(0), lat(rows - 1), lon(c), lon(c));
    insWayIndex.run(id, lon(c), lon(c), lat(0), lat(rows - 1));
    ways.col.push({ id, nodes: Array.from({ length: rows }, (_, r) => nodeId(c, r)), lat: (r) => lat(r), lon: lon(c) });
  }
  return { ways, cols, rows, lat, lon };
}

let worldSeq = 0;
function makeWorld(cols, rows, config) {
  worldSeq += 1;
  const file = path.join(TMP, `grid-${cols}x${rows}-${worldSeq}.sqlite`);
  const raw = openDatabase(file);
  const t0 = Date.now();
  const grid = buildGrid(raw, cols, rows);
  const db = { raw, prepare: (s) => raw.prepare(s), exec: (s) => raw.exec(s) };
  const rail = new RailGraph(db, { mode: 'rail' });
  rail.build();
  const population = {
    catchment: () => ({ pop: 2000, jobs: 400, weightedPop: 2400, activity: 1 }),
    totals: () => ({ population: 2000, jobs: 400, cells: 1 }),
  };
  // 压测环境：不产生客流（只测车辆模拟的规模），净距保留（真实约束）
  const transit = new Transit(db, {
    rail, population,
    config: Object.assign({ tripRatePerDay: 0, dwellSeconds: 20, patienceSeconds: 1e9 }, config || {}),
  });
  return { raw, db, grid, transit, builtMs: Date.now() - t0 };
}

/**
 * 在网格上铺车队：每条线路包一段路（segNodes 个节点），线上 lineVeh 辆车。
 * 路线先从行方向取（每条路可以切成 floor(点数/segNodes) 段互不重叠的短线），不够再取列方向。
 * 返回 { lineIds, vehicleIds, routes, stationIds, ... }。
 */
function buildFleet(w, opts) {
  const { transit, grid } = w;
  const user = { id: 'u-stress', name: '压测公司', color: '#e6194b' };
  transit.ensureCompany(user);
  const seg = Math.max(2, Math.min(opts.segNodes || 16, Math.max(grid.cols, grid.rows)));
  const routes = [];
  const perRow = Math.max(1, Math.floor(grid.cols / seg));
  for (let r = 0; r < grid.rows && routes.length < opts.lineCount; r++) {
    const row = grid.ways.row[r];
    for (let k = 0; k < perRow && routes.length < opts.lineCount; k++) {
      const start = k * seg;
      if (start + seg > row.nodes.length) continue;      // 这一行放不下第 k 段（换下一行）
      routes.push({ nodes: row.nodes.slice(start, start + seg), axis: 'row', fixed: r, start });
    }
  }
  const perCol = Math.max(1, Math.floor(grid.rows / seg));
  for (let c = 0; c < grid.cols && routes.length < opts.lineCount; c++) {
    const col = grid.ways.col[c];
    for (let k = 0; k < perCol && routes.length < opts.lineCount; k++) {
      const start = k * seg;
      if (start + seg > col.nodes.length) continue;
      routes.push({ nodes: col.nodes.slice(start, start + seg), axis: 'col', fixed: c, start });
    }
  }

  const t0 = Date.now();
  const stationIds = [];
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    // 每个节点一个站（先按节点 id 反解经纬度，再建站 —— 站会吸附到最近的钢轨上）
    route.points = route.nodes.map((nid) => {
      const id = Number(nid) - NODE_BASE;
      return { lat: grid.lat(Math.floor(id / 1000)), lon: grid.lon(id % 1000) };
    });
    stationIds.push(route.points.map((pt, j) => transit.createStation(user, {
      name: `S${i}-${j}`, kind: 'rail', lat: pt.lat, lon: pt.lon,
    }).station.id));
  }
  const stationsMs = Date.now() - t0;

  const t1 = Date.now();
  const lineIds = [];
  for (let i = 0; i < routes.length; i++) {
    const line = transit.createLine(user, { name: 'L' + i, kind: 'rail', stops: stationIds[i] }).line;
    lineIds.push(line.id);
  }
  const linesMs = Date.now() - t1;

  const t2 = Date.now();
  const vehicleIds = [];
  for (let i = 0; i < lineIds.length; i++) {
    for (let k = 0; k < opts.lineVeh; k++) {
      vehicleIds.push(transit.createVehicle(user, { kind: opts.kind || 'metro_b4', lineId: lineIds[i] }).vehicle.id);
    }
  }
  const vehiclesMs = Date.now() - t2;
  return {
    user, lineIds, vehicleIds, stationsMs, linesMs, vehiclesMs,
    stations: stationIds.reduce((n, a) => n + a.length, 0),
    routes, stationIds,
  };
}

/** 让游戏时间走 gameSec（用 tickAsync：每小步让出一次事件循环，与 index.js 同一条路径） */
async function advance(transit, gameSec, speed) {
  transit.speed = speed;
  const realDt = speed <= 1 ? 1000 : 250;
  const need = Math.ceil((gameSec * 1000) / (realDt * speed));
  let guard = 0;
  for (let i = 0; i < need + 4 && guard++ < 500000; i++) {
    await transit.tickAsync(realDt);
    if (transit.clockMs >= gameSec * 1000) break;      // 走够了就停（下一档还要接着跑）
  }
}

/** 把 simBudgetMs 抬到天上，让一次 tick 一口气算完（量"真实成本"用） */
function unbounded(transit) {
  const save = transit.config.simBudgetMs;
  transit.config.simBudgetMs = 1e9;
  return () => { transit.config.simBudgetMs = save; };
}

/**
 * 事件循环延迟探针：一边连续跑 tickAsync（每次 tick 之后让出一次 setImmediate），
 * 一边量"setImmediate 实际跑起来的延迟"。这个**就是"最长同步片段"的实测值** ——
 * 比内部计时更硬：它量的是"事件循环被别人占住多久"。
 */
async function loopLag(transit, realDt, rounds) {
  let worst = 0;
  let sum = 0;
  for (let i = 0; i < rounds; i++) {
    const t0 = Date.now();
    await transit.tickAsync(realDt);
    const yieldAt = Date.now();
    await new Promise((r) => setImmediate(r));
    const lag = Date.now() - yieldAt;
    const total = Date.now() - t0;
    if (lag > worst) worst = lag;
    sum += total;
  }
  return { worstLagMs: worst, avgTickMs: sum / rounds };
}

/**
 * 压测会把 [od] / [itin] 这类构建日志打满屏（每条线路都建一次行程图），
 * 这里静音掉 —— 只留压测自己的数字。`STRESS_VERBOSE=1` 可以打开看全过程。
 */
const VERBOSE = process.env.STRESS_VERBOSE === '1';
const realLog = console.log.bind(console);
console.log = (...a) => {
  const first = typeof a[0] === 'string' ? a[0] : '';
  if (!VERBOSE && /^\[(od|itin|fleet|transit|rail|bus|pop|db)\]/.test(first)) return;
  realLog(...a);
};

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

console.log('\n=== 车队规模压测（合成网格路网）===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const argScales = process.argv.slice(2).map((s) => Number(s)).filter((n) => n > 0);
const SCALES = argScales.length ? argScales : [1000, 10000, 30000];
const report = [];

// 整个压测是异步的：advance 走的是 tickAsync（与 index.js 同一条路径）
(async () => {
for (const K of SCALES) {
  // 规模 → 路网尺寸 + 线路数。
  // 每条线 16 个节点（≈ 35 km，站位 ~2.2 km 一格），线上车数按规模摊：
  //   K ≤ 12000  → 50 辆/线（就是用户说的"200 条线 × 50 辆"那种形态，10k 正好 200 线）
  //   K 更大     → 20 辆/线（再多线也铺不下，且一条线 50 辆挤在 35 km 上已经会排队）
  // 车距都留在"不会一开始就顶住"的量级（metro_b4 车长 76 m + 净距 45 m = 最小 121 m）。
  const lineVeh = K <= 12000 ? 50 : 20;
  const lineCount = Math.ceil(K / lineVeh);
  const segNodes = 12;
  // 网格要放得下 lineCount 条路线（每条路 = 一行/一列，能放 floor(点数/segNodes) 段）。
  // 取"接近方形"的网格（像一座城市的轨道网），行数按"每条路 2 段 + 余量"给。
  const gridCols = Math.max(segNodes * 4, Math.min(120, Math.ceil(Math.sqrt(Math.max(4, lineCount)) * segNodes / 4)));
  const perRowRoutes = Math.max(1, Math.floor(gridCols / segNodes));
  const gridRows = Math.max(3, Math.min(90, Math.ceil(lineCount / perRowRoutes / 2 * 1.3) + 1));
  const rows = gridRows;
  const cols = gridCols;
  // 路线槽位（行 + 列）× 每条路能切几段：够得着 lineCount 就按 lineCount 建，
  // 不够就把线上的车数摊大一点，保证**车队总量**仍然达到 K（规模才是压测的主角）
  const slots = gridRows * perRowRoutes + gridCols * Math.max(1, Math.floor(gridRows / segNodes));
  const routesUsed = Math.min(lineCount, slots);
  const lineCountFinal = routesUsed;
  const lineVehFinal = Math.max(1, Math.ceil(K / routesUsed));
  const targetK = routesUsed * lineVehFinal;
  console.log(`\n────────── K = ${K} 辆车（${routesUsed} 条线 × ${lineVehFinal} 辆 = ${targetK}，网格 ${cols}×${rows}，每线 ${segNodes} 站）──────────`);

  const w = makeWorld(cols, rows);
  const fleet = buildFleet(w, { lineCount: lineCountFinal, lineVeh: lineVehFinal, segNodes });
  const transit = w.transit;
  const st0 = transit.fleetStats();
  const spacing = (fleet.routes.length && fleet.routes[0].points.length)
    ? ((fleet.routes[0].points.length - 1) * (fleet.routes[0].axis === 'col' ? D_LAT : D_LON)) * 111320 / lineVehFinal
    : 0;
  console.log(`  建网+建队：${w.builtMs} ms（其中车站 ${fleet.stationsMs} ms / 线路 ${fleet.linesMs} ms / 车辆 ${fleet.vehiclesMs} ms）`
    + `，每条线上车距约 ${Math.round(spacing)} m`);
  console.log(`  车队装载到内存：${st0.fleet.loaded ? st0.fleet.loadMs + ' ms' : '失败'}，在跑 ${st0.fleet.running} 辆 / 闲置 ${st0.fleet.idle} 辆 / ${st0.fleet.lines} 条线上有车`);

  /* ① 每一小步 / 每次 tick 的毫秒数 -------------------------------------------------- */
  const tickRows = [];
  for (const speed of [1, 60, 300]) {
    transit.speed = speed;
    transit.simStats.longestSyncMs = 0;
    const realDt = speed <= 1 ? 1000 : 250;
    // 量"真实成本"：把预算抬到天上，取 3 次的中位数（单次会撞上 JIT / GC）
    const restore = unbounded(transit);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const t1 = nowMs();
      transit.tick(realDt);
      samples.push(nowMs() - t1);
    }
    restore();
    samples.sort((a, b) => a - b);
    const unboundedMs = samples[1];
    // 量"实际表现"：默认预算（5 ms）+ tickAsync（每小步让出事件循环）+ 事件循环延迟探针
    transit.simStats.longestSyncMs = 0;
    const lag = await loopLag(transit, realDt, 30);
    // 量"不限预算时的实时倍率"：真实 1 秒能推进多少游戏秒（= 模拟的吞吐上限）
    const restore2 = unbounded(transit);
    const c0 = transit.clockMs;
    const w0 = nowMs();
    for (let i = 0; i < 10; i++) transit.tick(realDt);
    const simThroughput = (transit.clockMs - c0) / 1000 / ((nowMs() - w0) / 1000);
    restore2();
    const sim = transit.fleetStats().sim;
    const gameSecPerTick = (realDt * speed) / 1000;
    tickRows.push({
      speed,
      unboundedMs,
      wallPerTickMs: lag.avgTickMs,
      gameSecPerTick,
      fine: sim.lastStepFine,
      coarse: sim.lastStepCoarse,
      longestSyncMs: sim.longestSyncMs,
      worstLagMs: lag.worstLagMs,
      simThroughput,
      realtimeRatio: (gameSecPerTick / 1000) / (lag.avgTickMs / 1000),
    });
    console.log(`  ×${String(speed).padEnd(3)} 一次 tick（${gameSecPerTick} 游戏秒）：不限预算 ${unboundedMs.toFixed(1)} ms；`
      + `实际 ${lag.avgTickMs.toFixed(2)} ms/tick（预算 5 ms）→ **事件循环最长被占 ${lag.worstLagMs} ms**`
      + `（内部小步最长 ${sim.longestSyncMs} ms）；一小步 ${sim.lastStepFine} 细 / ${sim.lastStepCoarse} 粗`
      + `；不限预算时实测吞吐 ${simThroughput.toFixed(0)} 游戏秒/真实秒`);
  }

  /* ② 10 分钟之后的堆内存 ------------------------------------------------------------ */
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const t2 = nowMs();
  await advance(transit, 600, 60);                  // 10 游戏分钟
  const tenMinMs = nowMs() - t2;
  if (global.gc) global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  console.log(`  10 游戏分钟（×60，真实 ${(tenMinMs / 1000).toFixed(1)} s）：堆 ${fmtMB(heapBefore)} → ${fmtMB(heapAfter)}`
    + `（Δ ${fmtMB(heapAfter - heapBefore)}，${((heapAfter - heapBefore) / Math.max(1, fleet.vehicleIds.length)).toFixed(0)} 字节/辆）`);

  /* ③ 每帧字节数（按需广播） --------------------------------------------------------- */
  // 口径：**一个客户端一帧要收多少字节** = f(它视口里有几辆车)。
  // 所以在一条路线上取 12 个采样视口（半径 4 km，沿路均匀分布），逐个量这一帧的字节数，
  // 再算"每辆车多少字节" —— 这样不管这条线上车是均匀铺开还是挤成一串（合成场景里
  // 50 辆同参数的车间隔 489 m 同时发车，几圈之后会自然串成一列，现实中靠班次表避免），
  // 数字都是可复算的。另外单独量"自己名下的车永远带上"这条口径的开销。
  const samples = [];
  {
    const route = fleet.routes[0];
    const c = transit.lineCache.get(fleet.lineIds[0]);
    for (let k = 0; k < 12; k++) {
      const d = (c.path[c.path.length - 1].distance * (k + 0.5)) / 12;
      const pt = transit._pointAt(c.path, d);
      const id = `s${k}`;
      transit.setPlayerView(id, { lat: pt.lat, lon: pt.lon, radiusM: 4000 });
      const frame = transit.frameFor(id, { owner: id });
      samples.push({ bytes: JSON.stringify(frame).length, vehicles: frame.trains.length });
    }
    for (const s of samples) transit.dropPlayerView(s.id);
  }
  const withVeh = samples.filter((s) => s.vehicles > 0);
  const bytesPerVehicle = withVeh.length
    ? withVeh.reduce((a, s) => a + s.bytes / s.vehicles, 0) / withVeh.length
    : 0;
  const meanFrameBytes = samples.reduce((a, s) => a + s.bytes, 0) / samples.length;
  let wholeFleetBytes = 0;
  {
    const whole = transit.simFrame();
    wholeFleetBytes = JSON.stringify(whole).length;
  }
  // 20 个玩家的合计：按"人均视口里有 V 辆车"折算（V = 采样均值）
  const meanVisible = samples.reduce((a, s) => a + s.vehicles, 0) / samples.length;
  const perPlayerBytes = bytesPerVehicle * meanVisible;
  const perPlayerKB = perPlayerBytes / 1024;
  const wholeKB = wholeFleetBytes / 1024;
  const pct = wholeKB > 0 ? (1 - perPlayerKB / wholeKB) * 100 : 0;
  console.log(`  广播（一个玩家、镜头 4 km，沿路 12 个采样点）：每辆车 ${bytesPerVehicle.toFixed(0)} 字节，`
    + `视口内平均 ${meanVisible.toFixed(1)} 辆 → **${perPlayerKB.toFixed(1)} KB/帧**`);
  console.log(`  对照：不做按需、整支车队一份 ${wholeKB.toFixed(1)} KB/帧 → **省 ${pct.toFixed(1)}%**；`
    + `20 人合计出口带宽 ${((perPlayerKB * 1024 * 20 * 4) / 1024).toFixed(0)} KB/s vs 整队 ${((wholeKB * 1024 * 20 * 4) / 1024).toFixed(0)} KB/s（4 帧/秒）`);
  console.log(`  视口外的车按线路给条数：lineCounts ${Object.keys(transit._fleet.lineCounts()).length} 条线 ≈ ${JSON.stringify(transit._fleet.lineCounts()).length} 字节`);

  /* ④ 粗档 / 细档的到站与里程对照（LOD 精度代价） ------------------------------------ */
  // 同一片路网上、同一套站表，两档各跑一批车；比较：
  //   · 到站记录的**条数**（有没有漏站 / 多停）—— 这是正确性；
  //   · 总里程（位置误差会不会累积）—— 这是精度。
  // 前 5 条线进视口（细档），其余粗档。两批车的站表互不相同，所以到站条数按"每辆车平均"比。
  const lodLines = new Set(fleet.lineIds.slice(0, 5));
  for (let i = 0; i < 5; i++) {
    // 每条被盯着的线给 3 个镜头（线太长，一个 12 km 的镜头盖不住 35 km）
    const route = fleet.routes[i];
    for (let k = 0; k < 3; k++) {
      const pt = route.points[Math.floor((route.points.length - 1) * (k + 0.5) / 3)];
      transit.setPlayerView(`lod${i}-${k}`, { lat: pt.lat, lon: pt.lon, radiusM: 12000 });
    }
  }
  transit._viewCache = null;
  let fineStops = 0;
  let coarseStops = 0;
  {
    const orig = transit._dock.bind(transit);
    transit._dock = (veh, cache, rt, p, stop) => {
      if (lodLines.has(veh.lineId)) fineStops += 1; else coarseStops += 1;
      return orig(veh, cache, rt, p, stop);
    };
  }
  const kmOf = (pred) => {
    const km = [];
    for (const v of transit._fleet.running) {
      if (!v.rt) continue;
      if (pred(v)) km.push(v.rt.lifetimeKm);
    }
    km.sort((a, b) => a - b);
    return {
      n: km.length,
      mean: km.length ? km.reduce((s, x) => s + x, 0) / km.length : 0,
      p10: km.length ? km[Math.floor(km.length * 0.1)] : 0,
      p90: km.length ? km[Math.floor(km.length * 0.9)] : 0,
    };
  };
  transit.simStats.fineSteps = 0;
  transit.simStats.coarseSteps = 0;
  const beforeFine = kmOf((v) => lodLines.has(v.lineId));
  const beforeCoarse = kmOf((v) => !lodLines.has(v.lineId));
  await advance(transit, 3600, 60);            // 60 游戏分钟：足够每辆车办 2~3 站
  const afterFine = kmOf((v) => lodLines.has(v.lineId));
  const afterCoarse = kmOf((v) => !lodLines.has(v.lineId));
  const sim = transit.fleetStats().sim;
  const fineShare = sim.fineSteps / Math.max(1, sim.fineSteps + sim.coarseSteps);
  const perVehFine = (afterFine.mean - beforeFine.mean);
  const perVehCoarse = (afterCoarse.mean - beforeCoarse.mean);
  const kmDelta = perVehCoarse > 0 ? Math.abs(perVehFine - perVehCoarse) / perVehCoarse : 0;
  console.log(`  LOD 分布：细档 ${sim.fineSteps} 次采样 / 粗档 ${sim.coarseSteps} 次（细档占 ${(fineShare * 100).toFixed(1)}%）`);
  console.log(`  到站次数：细档线 ${fineStops} 次 / 粗档线 ${coarseStops} 次`
    + `（每车 ${beforeFine.n ? (fineStops / beforeFine.n).toFixed(1) : '—'} vs ${beforeCoarse.n ? (coarseStops / beforeCoarse.n).toFixed(1) : '—'}）`);
  console.log(`  60 游戏分钟人均里程：细档 ${perVehFine.toFixed(2)} km / 粗档 ${perVehCoarse.toFixed(2)} km（均值差 ${(kmDelta * 100).toFixed(1)}%：`
    + ' 两档车队大小与排队位置不同，均值本身有噪声）');
  console.log('  位置误差不累积的硬证据在 tests/transit-fleet-test.js：同一条线、同一批车的两档到站时刻逐站相差 ≤ 2 游戏秒、里程差 0.0%');

  /* ⑤ 汇总一行 */

  /* ⑤ 汇总一行 */
  report.push({
    K: fleet.vehicleIds.length,
    lines: fleet.lineIds.length,
    stations: fleet.stations,
    buildMs: Math.round(w.builtMs + fleet.stationsMs + fleet.linesMs + fleet.vehiclesMs),
    tick: Object.fromEntries(tickRows.map((r) => [`x${r.speed}`, r])),
    heapDeltaMB: (heapAfter - heapBefore) / 1048576,
    perPlayerKB,
    wholeKB,
    bytesPerVehicle,
    meanVisible,
    fineShare,
    lodKmDelta: kmDelta,
    lodPerVehFine: perVehFine,
    lodPerVehCoarse: perVehCoarse,
    lodFineStops: fineStops,
    lodCoarseStops: coarseStops,
    lodFineVehicles: beforeFine.n,
    lodCoarseVehicles: beforeCoarse.n,
  });

  w.raw.close();
}

/* ------------------------------ 汇总表 ------------------------------ */
console.log('\n\n' + '='.repeat(118));
console.log('规模压测汇总（合成网格路网：每条线 12 站 ≈ 24 km；1000/10000 档 50 辆/线，30000 档 20 辆/线）');
console.log('='.repeat(118));
console.log('  K 辆    线路   车站   建网+建队   ×1 全算   ×60 全算   ×300 全算   最长同步(实测)  堆Δ/10min  每帧/人  整队/帧  单车字节  LOD 粗/细');
console.log('  ' + '-'.repeat(116));
for (const r of report) {
  const worstSync = Math.max(r.tick.x1.worstLagMs, r.tick.x60.worstLagMs, r.tick.x300.worstLagMs);
  console.log('  ' + String(r.K).padEnd(8)
    + String(r.lines).padEnd(7)
    + String(r.stations).padEnd(7)
    + `${r.buildMs} ms`.padEnd(11)
    + `${r.tick.x1.unboundedMs.toFixed(1)} ms`.padEnd(10)
    + `${r.tick.x60.unboundedMs.toFixed(1)} ms`.padEnd(11)
    + `${r.tick.x300.unboundedMs.toFixed(1)} ms`.padEnd(12)
    + `${worstSync} ms`.padEnd(16)
    + `${r.heapDeltaMB.toFixed(1)} MB`.padEnd(12)
    + `${r.perPlayerKB.toFixed(1)} KB`.padEnd(9)
    + `${r.wholeKB.toFixed(0)} KB`.padEnd(9)
    + `${r.bytesPerVehicle.toFixed(0)} B`.padEnd(10)
    + `${((1 - r.fineShare) * 100).toFixed(0)}/${(r.fineShare * 100).toFixed(0)}`);
}
console.log('='.repeat(118));
console.log('\n口径说明：');
console.log('  · ×N 全算 = "把预算抬到天上、一次 tick 一口气算完"的毫秒数（真实成本，取 3 次中位数）。');
console.log('    实际运行时受 simBudgetMs（默认 5 ms）约束：超了就带着余量收工，由 index.js 的 runSimSlice');
console.log('    立刻补一段（tickAsync 每小步还让出一次事件循环），所以事件循环不会被长段占用。');
console.log('  · 最长同步(实测) = 一边连跑 tickAsync、一边量 setImmediate 的实际延迟（= 事件循环被占住的最长时间）。');
console.log('  · 每帧/人 = 一个玩家（镜头 4 km，沿路 12 个采样点取均值）这一帧收到的字节数；单车字节 = 每辆车多少字节。');
console.log('  · 整队/帧 = 不做按需、把整支车队塞进一帧的字节数（旧行为，作对比）。');
console.log('  · LOD 粗/细 = 粗档与细档各占多少百分比的车辆采样。');
console.log('    （正确性的硬指标在 tests/transit-fleet-test.js：粗档与细档的**到站时刻**逐站相差 ≤ 2 游戏秒）。');
console.log(`\n${ok('压测完成')}\n`);
})().catch((err) => {
  console.error('\n压测失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
