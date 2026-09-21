'use strict';
/**
 * 分区流式（P1）· **临时实例验收**（开/关对照 + 载荷量测 + 语义等价，全部实测）
 *
 *   node tests/region-server-acceptance.js [--keep]
 *
 * 它做的事（每一步都把**实际执行的命令**打出来，便于复核）：
 *   1. 造两个**临时实例**的目录（`tests/tmp-regions/{off,on}-data`）与配置：
 *      · 后端库 = `tests/tmp-regions/hebei.sqlite`（`data/regions/hebei.sqlite` 的副本 ——
 *        这样"分片库仍是 data/regions/*.sqlite"、"临时目录 / 临时端口"两条都满足，
 *        而且**绝不写 data/regions/*.sqlite**）；
 *      · 端口 8791（关）/ 8792（开）—— **绝不碰 8787**；
 *      · 开的那台：`regions.mode='on'` + 注册表 `tests/tmp-regions/registry-nested.json`（beijing+hebei 嵌套夹具，
 *        与线上 tile 注册表无关；tile 那套由 tests/region-tiles-test.js 覆盖）。
 *   2. 等 `/api/ready` 就绪 → 跑 `node tools/measure-payload.js <tag> <port>`（z9~z16 未压缩 + gzip 字节）；
 *   3. 对同一批 bbox 直接 HTTP 比对**开关开 vs 开关关**的载荷（除 `ms` 与分片元数据外逐字段相同）；
 *   4. 读 `/api/health` 的 `regions` 块（declared / opened / missing / 冲突计数）；
 *   5. 断言"开关关闭时一个分片库都没打开"（关闭那台的 stdout 里**没有**任何 `[regions]` 行）；
 *   6. 跑完**停掉两台**并确认端口不再监听。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests/tmp-regions');
const NODE = process.execPath;
const OFF_PORT = 8791;
const ON_PORT = 8792;
const FALLBACK = path.join(TMP, 'hebei.sqlite');
const REGISTRY = path.join(TMP, 'registry-nested.json');
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, what, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + what); return true; }
  fail += 1;
  failures.push(what + (extra === undefined ? '' : ' → ' + extra));
  console.log('  ✗ ' + what + (extra === undefined ? '' : ' → ' + extra));
  return false;
}
const section = (t) => console.log('\n== ' + t);

/* ------------------------------ 准备临时实例 ------------------------------ */
section('0. 准备临时实例（临时端口 8791 / 8792，临时数据目录，绝不碰 data/ 与 8787）');
for (const d of ['off-data', 'on-data']) {
  fs.mkdirSync(path.join(TMP, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data/users.json'), path.join(TMP, d, 'users.json'));   // measure-payload 用 admin/admin 登录
}
const baseConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const offConfig = Object.assign({}, baseConfig, { port: OFF_PORT, regions: Object.assign({}, baseConfig.regions, { mode: 'off' }) });
const onConfig = Object.assign({}, baseConfig, {
  port: ON_PORT,
  regions: Object.assign({}, baseConfig.regions, {
    mode: 'on',
    registry: 'tests/tmp-regions/registry-nested.json',
    fanoutMax: 2,
    fallbackBelowZoom: 11,
    mergedBytesLimit: 4194304,
    allowOverlap: true,
    logQueries: true,
  }),
});
const offCfgFile = path.join(TMP, 'config-off.json');
const onCfgFile = path.join(TMP, 'config-on.json');
fs.writeFileSync(offCfgFile, JSON.stringify(offConfig, null, 2));
fs.writeFileSync(onCfgFile, JSON.stringify(onConfig, null, 2));
console.log(`  · 后端库 ${path.relative(ROOT, FALLBACK)}（${(fs.statSync(FALLBACK).size / 1e9).toFixed(2)} GB 副本）`);
console.log(`  · 关闭实例：--port ${OFF_PORT} --data tests/tmp-regions/off-data --config tests/tmp-regions/config-off.json --osm <副本>（不带 --regions ⇒ 分区强制关）`);
console.log(`  · 打开实例：--port ${ON_PORT} --data tests/tmp-regions/on-data --config tests/tmp-regions/config-on.json --osm <副本> --regions=on`);

/* ------------------------------ 工具 ------------------------------ */
function logFd(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.openSync(file, 'a');
}
function startServer(tag, port, cfgFile, extraArgs) {
  const logFile = path.join(TMP, `${tag}.log`);
  try { fs.rmSync(logFile); } catch { /* ignore */ }
  const fd = logFd(logFile);
  const args = ['server/index.js', '--port', String(port), '--data', `tests/tmp-regions/${tag}-data`,
    '--config', cfgFile, '--osm', FALLBACK, ...extraArgs];
  console.log(`  $ ${NODE.replace(/\\/g, '/')} ${args.join(' ')}  > ${path.relative(ROOT, logFile)} 2>&1`);
  const proc = spawn(NODE, args, { cwd: ROOT, stdio: ['ignore', fd, fd] });
  return { proc, logFile, port };
}
function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function waitReady(port, timeoutMs = 300000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await get(port, '/api/ready');
      const j = JSON.parse(r.body.toString('utf8'));
      if (j.ready === true) return Date.now() - t0;
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等 /api/ready 超时（${timeoutMs} ms）`);
    await new Promise((r) => setTimeout(r, 500));
  }
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
  if (!srv) return;
  srv.proc.kill('SIGTERM');
  for (let i = 0; i < 60; i++) {
    if (srv.proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (srv.proc.exitCode === null) {
    console.log(`  · ${srv.port} 没在 15 s 内退出，强杀`);
    try { srv.proc.kill('SIGKILL'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  const still = await portListening(srv.port);
  ok(!still, `端口 ${srv.port} 已无监听（进程退出码 ${srv.proc.exitCode}）`);
}
const W = 1400; const H = 900; const PAD = 0.05;
const CENTER = { lat: 39.9042, lon: 116.4074 };
function bboxOf(z) {
  const mPerPx = (156543.03392 * Math.cos((CENTER.lat * Math.PI) / 180)) / Math.pow(2, z);
  const dLat = ((H / 2) * (1 + 2 * PAD) * mPerPx) / 111320;
  const dLon = ((W / 2) * (1 + 2 * PAD) * mPerPx) / (111320 * Math.cos((CENTER.lat * Math.PI) / 180));
  return {
    minLon: Number((CENTER.lon - dLon).toFixed(7)), maxLon: Number((CENTER.lon + dLon).toFixed(7)),
    minLat: Number((CENTER.lat - dLat).toFixed(7)), maxLat: Number((CENTER.lat + dLat).toFixed(7)),
  };
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
async function mapPayload(port, z) {
  const b = bboxOf(z);
  const token = await login(port);
  const qs = `minLon=${b.minLon}&minLat=${b.minLat}&maxLon=${b.maxLon}&maxLat=${b.maxLat}&zoom=${z}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/map?${qs}&token=${encodeURIComponent(token)}`,
    { headers: { 'Accept-Encoding': 'identity' } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { bbox: b, bytes: buf.length, json: JSON.parse(buf.toString('utf8')) };
}
/**
 * 载荷对比的归一化：**只比"内容侧 + 规则回显 + 证据布尔"**（§8.2 判据 1/7 的 HTTP 版）。
 * 三处**故意不比**，理由都在设计文档里：
 *   · `ms` / `query`：时间与请求回显（`regions` 会多一个字段）；
 *   · `truncation.regions` 等分片元数据：本次新增的运维字段（§4.3 的"新增"类）；
 *   · 扫描侧账本（`kinds.* / summary / totals / coalesce 计数`）：嵌套片会把同一批要素**各扫一遍**，
 *     按 §4.3 的"求和"规则必然翻倍（§0 事实 5 的镜像片正是 §5.8 要避免的浪费）。
 * `nodePack` 先按客户端的规则解回 `id → 坐标` 再比（≥2^32 的 id 在两边的**顺序**不同，解码后逐点相同）。
 */
function decodeNodePack(p) {
  if (!p.nodePack) return p.nodes || null;
  const s = p.enc.nodeScale;
  const out = {};
  let id = 0; let la = 0; let lo = 0;
  for (let i = 0; i < p.nodePack.ids.length; i++) {
    id += p.nodePack.ids[i]; la += p.nodePack.lat[i]; lo += p.nodePack.lon[i];
    out[id] = [la / s, lo / s];
  }
  return out;
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
const stripForCompare = (p, full) => {
  const payload = Object.assign({}, p.truncation.payload);
  if (!full) {
    // z≤14 有折线/面合并：这些条数**本来就允许不同**（§4.3 的已知偏差 + 嵌套片的固有重复）
    for (const k of ['displayLines', 'displayLinePaths', 'displayAreas', 'displayAreaRings']) delete payload[k];
  }
  return canon({
    nodes: decodeNodePack(p),
    nodeTags: p.nodeTags,
    ways: p.ways,
    relations: p.relations,
    displayLines: full ? (p.displayLines || null) : undefined,
    displayAreas: full ? (p.displayAreas || null) : undefined,
    enc: p.enc,
    zoom: p.zoom,
    viewOnly: p.viewOnly,
    truncated: p.truncated,
    payload,
    complete: p.truncation.complete,
    exact: p.truncation.exact,
    kindsComplete: {
      ways: p.truncation.kinds.ways.complete,
      nodes: p.truncation.kinds.nodes.complete,
      relations: p.truncation.kinds.relations.complete,
    },
    coalesceRule: {
      on: p.truncation.coalesce.on, minZoom: p.truncation.coalesce.minZoom,
      tolPx: p.truncation.coalesce.tolPx, coordDigits: p.truncation.coalesce.coordDigits,
      minClassWays: p.truncation.coalesce.minClassWays, rule: p.truncation.coalesce.rule,
      // ⚠ 多片时生效的 budgetFrac 会被摊薄（0.5 → 0.25），这一项本来就**允许不同**（§4.3 末尾）
    },
    viewOnlyRule: {
      on: p.truncation.viewOnly.on, active: p.truncation.viewOnly.active,
      reason: p.truncation.viewOnly.reason, minZoom: p.truncation.viewOnly.minZoom,
      maxZoom: p.truncation.viewOnly.maxZoom, detailFloor: p.truncation.viewOnly.detailFloor,
      tolPx: p.truncation.viewOnly.tolPx, coordDigits: p.truncation.viewOnly.coordDigits,
    },
    caps: p.truncation.caps,
    cropRule: {
      pad: p.truncation.crop.pad, minMembers: p.truncation.crop.minMembers,
      boundaryMembers: p.truncation.crop.boundaryMembers, box: p.truncation.crop.box,
      complete: p.truncation.crop.complete, rule: p.truncation.crop.rule,
    },
    lodRule: {
      detail: p.truncation.lod.detail, detailName: p.truncation.lod.detailName,
      source: p.truncation.lod.source, minFillArea: p.truncation.lod.minFillArea,
      buildingZoom: p.truncation.lod.buildingZoom, roadSend: p.truncation.lod.roadSend,
      roadSendRank: p.truncation.lod.roadSendRank, baseFloor: p.truncation.lod.baseFloor,
      baseFloorSource: p.truncation.lod.baseFloorSource,
      landuseAreaM2: p.truncation.lod.landuseAreaM2, clientAreaM2: p.truncation.lod.clientAreaM2,
      roadsMissing: p.truncation.lod.roadsMissing,
      neverSendOn: p.truncation.lod.neverSend.on,
    },
  });
};

/* ------------------------------ 跑起来 ------------------------------ */
let off = null;
let on = null;
(async () => {
try {
  section('1. 关着分区的那台（对照基线，同一套分片库当单库）');
  off = startServer('off', OFF_PORT, offCfgFile, []);
  const offReady = await waitReady(OFF_PORT);
  console.log(`  · /api/ready ready=true，用时 ${offReady} ms`);
  const offLog = fs.readFileSync(off.logFile, 'utf8');
  ok(!/\[regions\]/.test(offLog), '关闭时 stdout / stderr 里**一行 [regions] 都没有**（连注册表都没读）');
  const offHealth = JSON.parse((await get(OFF_PORT, '/api/health')).body.toString('utf8'));
  ok(offHealth.regions === undefined, '/api/health **没有** regions 键（关闭时响应与改动前逐字节同形）');
  ok(offHealth.data && typeof offHealth.data.nodes === 'number', `/api/health 照旧：nodes=${offHealth.data.nodes}`);

  section('2. 基线量测：node tools/measure-payload.js regions-off 8791');
  {
    const fd = logFd(path.join(TMP, 'measure-off.log'));
    const r = spawnSync(NODE, ['tools/measure-payload.js', 'regions-off', String(OFF_PORT)],
      { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(OFF_PORT) }), stdio: ['ignore', fd, fd] });
    console.log(`  $ PORT=${OFF_PORT} node tools/measure-payload.js regions-off ${OFF_PORT}  (exit ${r.status})`);
    console.log(fs.readFileSync(path.join(TMP, 'measure-off.log'), 'utf8').split('\n').filter(Boolean).slice(-12).join('\n'));
    ok(r.status === 0, 'measure-payload（关）跑通');
  }
  const offPayloads = new Map();
  for (const z of [9, 10, 11, 12, 13, 14, 15, 16]) offPayloads.set(z, await mapPayload(OFF_PORT, z));

  section('3. 停掉对照实例（端口要放干净）');
  await stopServer(off);
  off = null;

  section('4. 开着分区的那台（分片 = data/regions/*.sqlite，只读）');
  on = startServer('on', ON_PORT, onCfgFile, ['--regions=on']);
  const onReady = await waitReady(ON_PORT);
  console.log(`  · /api/ready ready=true，用时 ${onReady} ms`);
  const onLog = fs.readFileSync(on.logFile, 'utf8');
  ok(/\[regions\] 区域分片：\*\*已开启\*\*/.test(onLog), '启动日志有分区开启那一行');
  ok(/惰性打开（启动时打开 0 个分片库）/.test(onLog), '启动日志写明"惰性打开，启动时 0 片"');
  ok(/写路径：\*\*仍然只走单库\*\*/.test(onLog), '启动日志写明写路径仍是单库');
  const onHealth0 = JSON.parse((await get(ON_PORT, '/api/health')).body.toString('utf8'));
  ok(onHealth0.regions && onHealth0.regions.declared === 2, `/api/health regions.declared=${onHealth0.regions && onHealth0.regions.declared}`);
  ok(onHealth0.regions.opened === 0, '**启动后 opened=0**（惰性：一个分片库都没打开）', String(onHealth0.regions.opened));
  ok(Array.isArray(onHealth0.regions.missing) && onHealth0.regions.missing.length === 0, 'missing=[]');

  section('5. 语义等价：同一个 bbox，开关开 vs 开关关（除 ms 与分片元数据外逐字段相同）');
  let openedAfter = 0;
  for (const z of [15, 16, 11, 13]) {
    const onP = await mapPayload(ON_PORT, z);
    const offP = offPayloads.get(z);
    const full = z >= 15;                    // z≤14 有折线/面合并：几何条数本来就允许不同（§4.3 已知偏差）
    const a = JSON.stringify(stripForCompare(onP.json, full));
    const b = JSON.stringify(stripForCompare(offP.json, full));
    const same = a === b;
    if (z >= 15) {
      ok(same, `z${z}：载荷逐字段相同（解码后的几何 + ways/relations/nodeTags + enc + payload 条数 + 规则回显 + complete/exact）`,
        same ? undefined : `长度 ${a.length} vs ${b.length}`);
      ok(onP.json.truncation.payload.ways === offP.json.truncation.payload.ways
        && onP.json.truncation.payload.nodes === offP.json.truncation.payload.nodes
        && onP.json.truncation.payload.relations === offP.json.truncation.payload.relations,
        `z${z}：truncation.payload（去重后的真值）逐个相同`,
        JSON.stringify(onP.json.truncation.payload) + ' vs ' + JSON.stringify(offP.json.truncation.payload));
    } else {
      console.log(`  · z${z}（低缩放，走折线/面合并）：开 ${onP.bytes} B / 关 ${offP.bytes} B`
        + ` · displayLines ${(onP.json.displayLines || []).length} vs ${(offP.json.displayLines || []).length}`
        + `（嵌套片把同一批几何各合并一遍 —— 文档已声明的偏差）`
        + ` · 内容侧（几何解包后 / ways / relations）逐字段相同=${same}`);
      ok(same, `z${z}：除合并几何之外的载荷逐字段相同（id 集合 / 节点坐标 / ways / relations / 规则回显）`);
      ok(onP.json.truncation.complete === offP.json.truncation.complete, `z${z}：complete 不回退`);
    }
    if (z === 16) {
      ok(onP.json.truncation.regions && onP.json.truncation.regions.length === 2,
        'z16 多片：truncation.regions 如实列出两片',
        JSON.stringify((onP.json.truncation.regions || []).map((r) => r.id)));
    }
    if (z === 9 || z === 10) {
      ok(onP.bytes === offP.bytes, `z${z}（< fallbackBelowZoom）：字节数与关闭时**完全相同**（回退单库）`);
    }
  }
  const onHealth1 = JSON.parse((await get(ON_PORT, '/api/health')).body.toString('utf8'));
  openedAfter = onHealth1.regions.opened;
  ok(openedAfter === 2, `用过之后 opened=${openedAfter}（两片都被惰性打开过）`);
  console.log('  · health.regions.requests =', JSON.stringify(onHealth1.regions.requests));
  console.log('  · health.regions.conflicts =', JSON.stringify(onHealth1.regions.conflicts));
  console.log('  · health.regions.shards =', JSON.stringify(onHealth1.regions.shards.map((s) => `${s.id}:opened=${s.opened},q=${s.queries}`)));
  ok(onHealth1.regions.requests.multiShard >= 2, 'health 记到多次多片扇出');

  section('6. 开着分区量测：node tools/measure-payload.js regions-on 8792');
  {
    const fd = logFd(path.join(TMP, 'measure-on.log'));
    const r = spawnSync(NODE, ['tools/measure-payload.js', 'regions-on', String(ON_PORT)],
      { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(ON_PORT) }), stdio: ['ignore', fd, fd] });
    console.log(`  $ PORT=${ON_PORT} node tools/measure-payload.js regions-on ${ON_PORT}  (exit ${r.status})`);
    console.log(fs.readFileSync(path.join(TMP, 'measure-on.log'), 'utf8').split('\n').filter(Boolean).slice(-12).join('\n'));
    ok(r.status === 0, 'measure-payload（开）跑通');
  }
  section('7. 对照表：node tools/measure-payload.js --diff logs/payload-regions-off.json logs/payload-regions-on.json');
  {
    const fd = logFd(path.join(TMP, 'measure-diff.log'));
    const r = spawnSync(NODE, ['tools/measure-payload.js', '--diff',
      'logs/payload-regions-off.json', 'logs/payload-regions-on.json'],
    { cwd: ROOT, stdio: ['ignore', fd, fd] });
    console.log(fs.readFileSync(path.join(TMP, 'measure-diff.log'), 'utf8'));
    ok(r.status === 0, '--diff 跑通（A = 关、B = 开，同一套数据）');
  }
} catch (err) {
  fail += 1;
  failures.push('异常：' + (err.stack || err.message));
  console.log('  ✗ 异常：' + (err.stack || err.message));
} finally {
  section('8. 收尾：停掉两台实例并确认端口没在监听');
  await stopServer(on);
  await stopServer(off);
  on = null;
  off = null;
}
if (KEEP) console.log('（--keep：保留 tests/tmp-regions 下的日志与配置）');
console.log(`\n[region-server-acceptance] 通过 ${pass} 项 · 失败 ${fail} 项`);
if (fail) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('[region-server-acceptance] 崩了：', err.stack || err.message);
  try { await stopServer(on); } catch { /* ignore */ }
  try { await stopServer(off); } catch { /* ignore */ }
  process.exit(2);
});
