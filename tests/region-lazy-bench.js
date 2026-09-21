'use strict';
/**
 * ============ P4 惰性建图：**开关关 / 开关开**的启动时间、首次请求、常驻 RSS 对照 ============
 *
 *   node tests/region-lazy-bench.js [--recopy] [--settle 20000] [--runs off,on-lazy,on-full]
 *
 * ## 它用的数据、端口、代码版本（**这三件事必须在结论里写清楚**）
 *   · 数据：`data/regions/beijing.sqlite`（948 MiB，**只读来源**）→ 复制成
 *     `tests/tmp-lazy/measure/beijing.sqlite`（**副本**，服务端只写副本，绝不碰 data/ 下的原件）；
 *     注册表用线上的 `data/regions/registry.json`（10 片互斥矩形，只读）。
 *     **为什么用北京片**：它真实、够大（4.83M 节点 / 518,666 way），而且线上那张公交网就是灌进这一片的。
 *   · 灌进副本的交通资产（让 `needsBusGraph()` 为真，从而把"道路网"这一项真的算进来）：
 *     3 个公交站 + 1 条公交线（两个站都在 `bj-se` 片、一个在 `bj-sw` 片 ⇒ 资产片 = 2 片）。
 *   · 端口：**8795（关）/ 8796（开+lazy）/ 8797（开+full）** —— 绝不用 8787。
 *   · 代码版本：运行时把 `server/*.js` 的 SHA256 与 git HEAD 一起记进结果 JSON。
 *
 * ## 每一项怎么量的（如实说明）
 *   · `listenMs` / `readyMs` / `maxStallMs`：**抄服务端自己的启动日志**
 *     （`[init] 就绪：端口 X ms 就开了 · 初始化 Y ms…最长一次同步停顿 Z ms`）；
 *   · `firstHttpMs`：从 `spawn()` 到**第一次**拿到任意 HTTP 响应（初始化期间是 503）；
 *   · `firstMapMs`：`ready` 之后第一条 `/api/map?zoom=16` 的**往返耗时**；
 *   · `rssReady` / `rssSteady`：`ready` 那一刻 / 静置 `--settle` 之后的进程工作集
 *     （Windows 上借 PowerShell 的 `(Get-Process -Id N).WorkingSet64` 写到临时文件再读 ——
 *     本沙箱禁止用管道抓子进程输出，所以一律走文件，见 README 的那条沙箱约束）。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, 'tmp-lazy', 'measure');
const NODE = process.execPath;
/**
 * 两套数据（都复制成临时副本再跑，**绝不写 data/ 下的原件**）：
 *   · `beijing`：`data/regions/beijing.sqlite`（948 MiB / 4.83M 节点 / 518,666 way）
 *     —— 与"把线上公交网灌进北京片"那份实测读数同一套数据，可以直接对照；
 *   · `hebei`  ：`data/regions/hebei.sqlite`（2.82 GiB / 14.92M 节点 / 1.56M way）
 *     —— 设计文档里"一个省 + 10 片"的真实规模：10 片正好铺满它，惰性建图的收益在这里最明显。
 */
const LIBS = {
  beijing: {
    file: 'data/regions/beijing.sqlite',
    // 3 个公交站：两个在 bj-se（lon ≥ 116.25），一个在 bj-sw ⇒ 资产片 = 2 片（与线上 67 个站的分布同构）
    stations: [
      { name: '基准站甲', lonMin: 116.28, lonMax: 116.42, latMin: 39.88, latMax: 39.93 },
      { name: '基准站乙', lonMin: 116.30, lonMax: 116.44, latMin: 39.88, latMax: 39.93 },
      { name: '基准站丙', lonMin: 116.05, lonMax: 116.22, latMin: 39.88, latMax: 39.93 },
    ],
  },
  hebei: {
    file: 'data/regions/hebei.sqlite',
    // 3 个公交站：两个在 heb-bd（石家庄，lon < 116），一个在 heb-lf（廊坊）⇒ 资产片 = 2 片 / 共 10 片
    stations: [
      { name: '基准站甲', lonMin: 114.40, lonMax: 114.60, latMin: 37.95, latMax: 38.15 },
      { name: '基准站乙', lonMin: 114.45, lonMax: 114.65, latMin: 37.95, latMax: 38.15 },
      { name: '基准站丙', lonMin: 116.45, lonMax: 116.70, latMin: 39.30, latMax: 39.42 },
    ],
  },
};
const LIB_NAME = String((process.argv.includes('--lib') ? process.argv[process.argv.indexOf('--lib') + 1] : '') || 'beijing');
if (!LIBS[LIB_NAME]) { console.error(`未知的 --lib：${LIB_NAME}（可选 ${Object.keys(LIBS).join(' / ')}）`); process.exit(2); }
const LIB_SPEC = LIBS[LIB_NAME];
const SRC_LIB = path.join(ROOT, LIB_SPEC.file);
const LIB = path.join(TMP, `${LIB_NAME}.sqlite`);
const REGISTRY_REL = 'data/regions/registry.json';
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RECOPY = hasFlag('--recopy');
const SETTLE_MS = Number(argOf('--settle', '20000'));
const RUN_NAMES = String(argOf('--runs', 'off,on-lazy,on-full')).split(',').map((s) => s.trim()).filter(Boolean);

const RUNS = {
  off: { port: 8795, cfg: 'config-off.json', extra: [], label: '开关关（regions.mode=off，全量建图）' },
  'on-lazy': { port: 8796, cfg: 'config-on-lazy.json', extra: ['--regions=on'], label: '开关开 + lazy（按区域惰性建图）' },
  'on-full': { port: 8797, cfg: 'config-on-full.json', extra: ['--regions=on'], label: '开关开 + lazy:false（等价全量建图，回滚位）' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 小工具（全部走文件，不用管道） ------------------------------ */

function logFd(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.openSync(file, 'a');
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}
/** 子进程工作集（字节）：powershell 写文件 → 读回来（**不用管道**，见文件头） */
function rssOf(pid) {
  const out = path.join(TMP, `rss-${pid}.txt`);
  try { fs.rmSync(out); } catch { /* ignore */ }
  const cmd = `(Get-Process -Id ${Number(pid)}).WorkingSet64 | Out-File -Encoding ascii '${out.replace(/\\/g, '/')}'`;
  spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
  try { return Number(fs.readFileSync(out, 'utf8').trim()); } catch { return null; }
}
function peakRssOf(pid) {
  const out = path.join(TMP, `peak-${pid}.txt`);
  try { fs.rmSync(out); } catch { /* ignore */ }
  const cmd = `(Get-Process -Id ${Number(pid)}).PeakWorkingSet64 | Out-File -Encoding ascii '${out.replace(/\\/g, '/')}'`;
  spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
  try { return Number(fs.readFileSync(out, 'utf8').trim()); } catch { return null; }
}
function get(port, pathname, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}
function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(700);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}
async function stopServer(srv) {
  if (!srv || srv.proc.exitCode !== null) return;
  const peak = peakRssOf(srv.proc.pid);
  srv.peakRss = peak;
  srv.proc.kill('SIGTERM');
  for (let i = 0; i < 80; i++) {
    if (srv.proc.exitCode !== null) break;
    await sleep(250);
  }
  if (srv.proc.exitCode === null) { try { srv.proc.kill('SIGKILL'); } catch { /* ignore */ } await sleep(800); }
  const still = await portListening(srv.port);
  srv.portFree = !still;
}
async function login(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'admin', password: 'admin' }),
  });
  const j = await res.json();
  if (!j.token) throw new Error('登录失败：' + JSON.stringify(j));
  return j.token;
}
/** 中心天安门、z16 的一屏（与 tools/measure-payload.js 同一口径） */
function bboxOf(z, center = { lat: 39.9042, lon: 116.4074 }) {
  const W = 1400; const H = 900; const PAD = 0.05;
  const mPerPx = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, z);
  const dLat = ((H / 2) * (1 + 2 * PAD) * mPerPx) / 111320;
  const dLon = ((W / 2) * (1 + 2 * PAD) * mPerPx) / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return {
    minLon: Number((center.lon - dLon).toFixed(7)), maxLon: Number((center.lon + dLon).toFixed(7)),
    minLat: Number((center.lat - dLat).toFixed(7)), maxLat: Number((center.lat + dLat).toFixed(7)),
  };
}

/* ------------------------------ 0. 准备副本（只读来源 → 临时副本） ------------------------------ */

function prepareLibrary() {
  fs.mkdirSync(TMP, { recursive: true });
  const need = RECOPY || !fs.existsSync(LIB) || fs.statSync(LIB).size !== fs.statSync(SRC_LIB).size;
  if (need) {
    console.log(`  · 复制 ${path.relative(ROOT, SRC_LIB)}（${(fs.statSync(SRC_LIB).size / 1e9).toFixed(2)} GB）→ ${path.relative(ROOT, LIB)}`);
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(LIB + suffix); } catch { /* ignore */ } }
    fs.copyFileSync(SRC_LIB, LIB);
  } else {
    console.log(`  · 复用已有副本 ${path.relative(ROOT, LIB)}（--recopy 可强制重来）`);
  }
  for (const tag of ['off', 'on-lazy', 'on-full']) {
    fs.mkdirSync(path.join(TMP, `${tag}-data`), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data/users.json'), path.join(TMP, `${tag}-data`, 'users.json'));
  }
}

/** 往副本里灌"一张公交网"（幂等）：3 个公交站 + 1 条公交线。只有 assetShards 这一项需要它 */
function seedTransit() {
  const db = new DatabaseSync(LIB);
  const have = db.prepare("SELECT COUNT(*) c FROM stations WHERE owner='bench'").get().c;
  if (have) { db.close(); return; }
  // 真实的城市道路节点（从副本里现查，保证 node_id 真的是路网节点）
  const pick = (s, offset) => db.prepare(`SELECT wn.node_id AS node_id, wn.way_id AS way_id, n.lat AS lat, n.lon AS lon
      FROM ways w JOIN way_nodes wn ON wn.way_id = w.id JOIN nodes n ON n.id = wn.node_id
      WHERE w.deleted = 0 AND w.tags LIKE '%"highway":"residential"%' AND w.tags LIKE '%"name":%'
        AND n.lon >= ? AND n.lon <= ? AND n.lat >= ? AND n.lat <= ?
      ORDER BY w.id LIMIT 1 OFFSET ?`).get(s.lonMin, s.lonMax, s.latMin, s.latMax, Number(s.offset) || offset || 0);
  const ins = db.prepare(`INSERT INTO stations(owner, company_id, name, kind, lat, lon, node_id, way_id,
      platform_m, catchment_m, show_catchment, cost, created_at)
      VALUES('bench', NULL, ?, 'bus', ?, ?, ?, ?, 60, 700, 0, 0, ?)`);
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < LIB_SPEC.stations.length; i++) {
    const spec = LIB_SPEC.stations[i];
    const p = pick(spec, i);
    if (!p) throw new Error(`副本里找不到合适的道路节点（${JSON.stringify(spec)}）`);
    ins.run(spec.name, p.lat, p.lon, p.node_id, p.way_id, now);
    ids.push(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    console.log(`    · 车站 ${spec.name} → 节点 ${p.node_id}（${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}）`);
  }
  db.prepare(`INSERT INTO lines(owner, company_id, name, color, kind, stops, loop, path_len, created_at)
      VALUES('bench', NULL, '基准公交线', '#e6194b', 'bus', ?, 0, 0, ?)`).run(JSON.stringify(ids.slice(0, 2)), now);
  db.close();
  console.log(`  · 往副本里灌了 ${ids.length} 个公交站 + 1 条公交线（资产片见下面 /api/health 的 regions.lazy.assetShards）`);
}

/* ------------------------------ 1. 三份配置 ------------------------------ */

function writeConfigs() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const mk = (file, regions) => {
    const cfg = Object.assign({}, base, { regions: Object.assign({}, base.regions, regions) });
    fs.writeFileSync(path.join(TMP, file), JSON.stringify(cfg, null, 2));
    return path.join(TMP, file);
  };
  return {
    off: mk('config-off.json', { mode: 'off', registry: REGISTRY_REL, logQueries: false }),
    'on-lazy': mk('config-on-lazy.json', { mode: 'on', lazy: true, registry: REGISTRY_REL, logQueries: false }),
    'on-full': mk('config-on-full.json', { mode: 'on', lazy: false, registry: REGISTRY_REL, logQueries: false }),
  };
}

/* ------------------------------ 2. 单次运行 ------------------------------ */

async function runOne(name, cfgFile) {
  const spec = RUNS[name];
  const logFile = path.join(TMP, `${name}-${LIB_NAME}.log`);
  try { fs.rmSync(logFile); } catch { /* ignore */ }
  const fd = logFd(logFile);
  const args = ['server/index.js', '--port', String(spec.port), '--data', `tests/tmp-lazy/measure/${name}-data`,
    '--config', cfgFile, '--osm', LIB, ...spec.extra];
  console.log(`\n  $ ${NODE.replace(/\\/g, '/')} ${args.join(' ')}`);
  const t0 = Date.now();
  const proc = spawn(NODE, args, { cwd: ROOT, stdio: ['ignore', fd, fd] });
  const rec = {
    run: name, label: spec.label, port: spec.port, pid: proc.pid,
    cmd: `${NODE} ${args.join(' ')}`, log: path.relative(ROOT, logFile),
    spawnAt: new Date(t0).toISOString(),
  };
  let firstHttp = null;
  let ready = null;
  let readyPayload = null;
  const deadline = t0 + 15 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${name}：等 /api/ready 超时`);
    if (proc.exitCode !== null) throw new Error(`${name}：进程提前退出（exit ${proc.exitCode}），见 ${rec.log}`);
    try {
      const r = await get(spec.port, '/api/ready', 4000);
      if (firstHttp === null) firstHttp = Date.now() - t0;
      const j = JSON.parse(r.body.toString('utf8'));
      if (j.ready === true) { ready = Date.now() - t0; readyPayload = j; break; }
    } catch { /* 还没监听 */ }
    await sleep(100);
  }
  rec.firstHttpMs = firstHttp;
  rec.readyMsHttp = ready;
  rec.rssReady = rssOf(proc.pid);
  // 服务端自己报的时间线（抄日志，比 HTTP 轮询精确）
  const log1 = fs.readFileSync(logFile, 'utf8');
  const m = /\[init\] 就绪：端口 (\d+) ms 就开了 · 初始化 (\d+) ms（监听之后 (\d+) ms）· 初始化期间最长一次同步停顿 (\d+) ms（阶段 ([^）]*)）/.exec(log1);
  if (m) {
    rec.listenMs = Number(m[1]); rec.initMs = Number(m[2]); rec.afterListenMs = Number(m[3]);
    rec.maxStallMs = Number(m[4]); rec.maxStallStage = m[5];
  }
  rec.readyPayloadStages = readyPayload && readyPayload.stages ? readyPayload.stages.map((s) => s.key) : null;
  rec.regionsFieldInReady = !!(readyPayload && readyPayload.regions);
  // 首屏：z16 的 /api/map（第一条**真实业务请求**）
  {
    const token = await login(spec.port);
    const b = bboxOf(16);
    const qs = `minLon=${b.minLon}&minLat=${b.minLat}&maxLon=${b.maxLon}&maxLat=${b.maxLat}&zoom=16`;
    const t1 = Date.now();
    const res = await fetch(`http://127.0.0.1:${spec.port}/api/map?${qs}&token=${encodeURIComponent(token)}`,
      { headers: { 'Accept-Encoding': 'identity' } });
    const buf = Buffer.from(await res.arrayBuffer());
    rec.firstMapMs = Date.now() - t1;
    rec.firstMapBytes = buf.length;
    rec.firstMapOk = res.status === 200;
  }
  // /api/health（分区信息；开关关时**不该有** regions 键）
  {
    const r = await get(spec.port, '/api/health');
    const j = JSON.parse(r.body.toString('utf8'));
    rec.healthHasRegions = !!j.regions;
    rec.healthNodes = j.data && j.data.nodes;
    if (j.regions && j.regions.lazy) {
      const L = j.regions.lazy;
      rec.lazy = {
        railReady: L.rail && L.rail.ready, busReady: L.bus && L.bus.ready,
        railAbsent: L.rail && L.rail.absent, busAbsent: L.bus && L.bus.absent,
        railWays: L.rail && L.rail.ways, railNodes: L.rail && L.rail.nodes,
        busWays: L.bus && L.bus.ways, busNodes: L.bus && L.bus.nodes,
        assetShards: L.assetShards, alwaysActive: L.alwaysActive, activeShards: L.activeShards,
        counters: L.counters,
      };
    }
  }
  // 静置：等它进入稳态（后台的 regions 阶段可能还在建图）
  rec.settleMs = SETTLE_MS;
  await sleep(SETTLE_MS);
  rec.rssSteady = rssOf(proc.pid);
  {
    const r = await get(spec.port, '/api/health');
    const j = JSON.parse(r.body.toString('utf8'));
    if (j.regions && j.regions.lazy) {
      const L = j.regions.lazy;
      rec.lazyAfterSettle = {
        railReady: L.rail.ready, busReady: L.bus.ready, absent: L.rail.absent,
        counters: L.counters, activeShards: L.activeShards,
      };
    }
  }
  const srv = { proc, port: spec.port };
  await stopServer(srv);
  rec.peakRss = srv.peakRss;
  rec.portFreeAfterStop = srv.portFree;
  rec.exitCode = proc.exitCode;  // 从日志里抠几个关键数字
  const log = fs.readFileSync(logFile, 'utf8');
  const grab = (re) => { const x = re.exec(log); return x ? x[1] : null; };
  rec.logRail = grab(/\[rail\] 铁路网（惰性）构建完成：(\d+) 条轨道 \/ (\d+) 段 \/ (\d+) 个节点/) || grab(/\[rail\] 铁路网构建完成：(\d+) 条轨道/);
  rec.logBus = (() => {
    let x = /\[bus\] 道路网构建完成：(\d+) 条道路 \/ (\d+) 段 \/ (\d+) 个节点（(\d+) ms）/.exec(log);
    if (x) return { ways: Number(x[1]), edges: Number(x[2]), nodes: Number(x[3]), ms: Number(x[4]), lazy: false };
    x = /\[bus\] 道路网（惰性）构建完成：(\d+) 条道路 \/ (\d+) 段 \/ (\d+) 个节点（(\d+) ms · (\d+) 个激活区域/.exec(log);
    if (x) return { ways: Number(x[1]), edges: Number(x[2]), nodes: Number(x[3]), ms: Number(x[4]), regions: Number(x[5]), lazy: true };
    return null;
  })();
  rec.logLines = log.split('\n').filter((l) => /^\[(rail|bus|pop|transit|regions)/.test(l)).slice(-40);
  return rec;
}

/* ------------------------------ 3. 主流程 ------------------------------ */

(async () => {
  console.log('== P4 惰性建图 · 开/关对照实测（临时实例，端口 8795/8796/8797，绝不碰 8787）');
  const codeHashes = {};
  for (const f of ['server/index.js', 'server/regions.js', 'server/railgraph.js', 'server/population.js', 'server/transit.js', 'config.json']) {
    codeHashes[f] = sha256(path.join(ROOT, f));
  }
  /**
   * ⚠ 纪律要求"不跑 npm/git"，所以这里**不调用 git**：HEAD 是本次会话开头
   * （改动之前）用 `git rev-parse HEAD` 读到的那一个，原样抄进来做版本戳。
   */
  const gitHead = 'd0a84dfce94c67bb6b805eb68a65d8678f8181d4';
  prepareLibrary();
  seedTransit();
  const cfgs = writeConfigs();
  const results = { meta: {
    at: new Date().toISOString(),
    dataset: LIB_NAME,
    source: path.relative(ROOT, SRC_LIB), library: path.relative(ROOT, LIB),
    libraryBytes: fs.statSync(LIB).size, registry: REGISTRY_REL,
    settleMs: SETTLE_MS, codeHashes, gitHead,
    ports: RUNS, node: process.version, platform: `${process.platform} ${process.arch}`,
  }, runs: {} };
  for (const name of RUN_NAMES) {
    if (!RUNS[name]) throw new Error(`未知的 run：${name}`);
    results.runs[name] = await runOne(name, cfgs[name]);
  }
  const outFile = path.join(TMP, `lazy-bench-${LIB_NAME}.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

  const pad = (s, n) => String(s === null || s === undefined ? '-' : s).padEnd(n);
  console.log('\n== 对照表（同一套数据、同一台机器、同一版代码）');
  console.log(`  ${pad('run', 10)}${pad('port', 6)}${pad('listenMs', 10)}${pad('initMs', 9)}${pad('readyMs', 9)}`
    + `${pad('firstHttp', 11)}${pad('firstMap', 10)}${pad('maxStall', 10)}${pad('rssReady', 12)}${pad('rssSteady', 12)}`);
  for (const name of RUN_NAMES) {
    const r = results.runs[name];
    console.log(`  ${pad(name, 10)}${pad(r.port, 6)}${pad(r.listenMs, 10)}${pad(r.initMs, 9)}${pad(r.readyMsHttp, 9)}`
      + `${pad(r.firstHttpMs, 11)}${pad(r.firstMapMs, 10)}${pad(r.maxStallMs, 10)}`
      + `${pad(r.rssReady ? (r.rssReady / 1048576).toFixed(0) + ' MB' : '-', 12)}`
      + `${pad(r.rssSteady ? (r.rssSteady / 1048576).toFixed(0) + ' MB' : '-', 12)}`);
  }
  for (const name of RUN_NAMES) {
    const r = results.runs[name];
    console.log(`  · ${pad(name, 10)} rail=${r.logRail || '-'} bus=${r.logBus ? JSON.stringify(r.logBus) : '-'}`
      + ` healthHasRegions=${r.healthHasRegions} lazy=${r.lazy ? JSON.stringify({ railReady: r.lazy.railReady, busReady: r.lazy.busReady, absent: r.lazy.railAbsent, counters: r.lazy.counters }) : '-'}`);
  }
  console.log(`\n  结果 JSON：${path.relative(ROOT, outFile)}`);
  process.exit(0);
})().catch((err) => {
  console.error('[region-lazy-bench] 崩了：', err.stack || err.message);
  process.exit(2);
});
