'use strict';
/**
 * **视口载荷编码的实测台**（只读真实数据集，绝不修改它）。
 *
 *   node tests/bin-payload-bench.js                 # 默认 z9,10,13,14,15,16
 *   node tests/bin-payload-bench.js --zooms=10,15
 *   node tests/bin-payload-bench.js --json=out.json
 *
 * 同一视口（默认 1400×900 + pad 0.05，与客户端 Leaflet 的 `getBounds().pad(0.05)` 同口径）
 * 跑四档编码，给出"改动前 → 改动后"的字节数对照：
 *
 *   A 原始 JSON        `compact:false`（列式 delta 之前的老形状）—— 真正的"改动前"
 *   B 紧凑 JSON        `compact:{on:true, displayFlat:false}`     —— 当前线上的形状
 *   C 紧凑 JSON + 摊平 `compact:{on:true, displayFlat:true}`      —— ② 落地后（只改编码）
 *   D 二进制 BIN v1    C 的载荷走 `encodeBinaryPayload`            —— ① 落地后
 *   E D + gzip / F B + gzip / G A + gzip（**过网字节**：服务端一直开着 gzip，见 server/index.js 的 sendJSON）
 *
 * 另外做两件事，防止"省了字节、错了数据"：
 *   · **C 与 B 语义相同**：把 C 的载荷喂给客户端解码器（真 world.js，跑在 vm 里）展开后
 *     与 B 展开后的结果逐字段比较（规范化：对象键排序、数组保序）；
 *   · **D 与 C 逐字段相同**：同上，二进制解出来的载荷 == C 的载荷。
 * 并给出**解码耗时**：同一份载荷，JSON 路径（JSON.parse）vs 二进制路径
 * （`World.decodeBinaryPayload`，真浏览器解码函数，跑在 vm 里）。
 *
 * ⚠ 只读保证：在 `require('../server/osmdb.js')` **之前**把 `dbschema.openDatabase` 换成
 * `new DatabaseSync(file, { readOnly: true })`（osmdb.js 是加载时解构它的），
 * 于是不管构造函数里那些"回填/建索引"的自愈步骤想做什么，都只会抛错、不会动数据集一个字节。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'data', 'osm', 'osm.sqlite');

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const ARGS = parseArgs();
const DB_FILE = ARGS.db ? path.resolve(ROOT, ARGS.db) : DEFAULT_DB;
const ZOOMS = String(ARGS.zooms || '9,10,13,14,15,16').split(',').map(Number).filter((n) => Number.isFinite(n));
const W = Number(ARGS.w) || 1400;
const H = Number(ARGS.h) || 900;
const PAD = Number(ARGS.pad) || 0.05;

if (!fs.existsSync(DB_FILE)) {
  console.error(`数据集不存在：${DB_FILE}（用 --db=相对路径 指定别的库）`);
  process.exit(2);
}

/* ------------------------- 只读打开（见文件头说明） ------------------------- */
const dbschema = require(path.join(ROOT, 'server', 'dbschema.js'));
dbschema.openDatabase = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -64000');
  return db;
};
const { OsmDB, encodeBinaryPayload } = require(path.join(ROOT, 'server', 'osmdb.js'));

/* ------------------------- 客户端解码器（真 world.js） ------------------------- */
/**
 * 把 public/js 里的真模块装进一个最小宿主 —— 解码函数必须是**浏览器里跑的那一份**，
 * 否则测的是"我另写的一份解码器"，说明不了任何事。
 * 最小宿主只需要 util.js + world.js；补上 DataView / TextDecoder（浏览器原生能力）。
 */
function loadClientWorld() {
  const sandbox = {
    console,
    Promise, JSON, Math, Number, String, Boolean, Object, Array, Error, TypeError, RangeError, Date,
    Map, Set, WeakMap, WeakSet, Symbol, RegExp, isNaN, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, DataView, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
  };
  const makeEl = () => ({
    style: {}, dataset: {}, children: [], textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, appendChild(c) { return c; }, removeChild() {},
    remove() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, blur() {}, click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H }),
  });
  const document = {
    readyState: 'complete', body: makeEl(), documentElement: makeEl(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: makeEl, createElementNS: makeEl, createTextNode: (t) => ({ textContent: t }),
    addEventListener() {}, removeEventListener() {},
  };
  const window = { G: {}, location: { protocol: 'http:', host: '127.0.0.1', href: 'http://127.0.0.1/', search: '' }, addEventListener() {} };
  window.window = window;
  sandbox.window = window;
  sandbox.document = document;
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['util.js', 'world.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8'), sandbox, { filename: 'public/js/' + f });
  }
  /**
   * 解码入口都放在 vm 里跑：**跨 realm 的 Uint8Array / JSON.parse 才不会走偏**
   * （宿主造的数组在 vm 里 `Array.isArray` 是 false，真模块的判定会跟着变）。
   */
  vm.runInContext(`
    globalThis.__decode = function (bytes) {
      const p = window.G.World.decodeBinaryPayload(bytes);
      return p;                                  // 保持 enc / nodePack / segs 不展开
    };
    globalThis.__unpack = function (p) { window.G.World.unpackPayload(p); return p; };
    globalThis.__jsonParse = function (text) { return JSON.parse(text); };
  `, sandbox, { filename: 'bench' });
  return sandbox;
}

/* ------------------------- 视口 bbox（与 Leaflet 同口径） ------------------------- */
const CENTER = { lat: Number(ARGS.lat) || 39.9042, lng: Number(ARGS.lng) || 116.4074 };
function project(lat, lng, z) {
  const size = 256 * Math.pow(2, z);
  const x = (lng + 180) / 360 * size;
  const s = Math.sin(lat * Math.PI / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
  return [x, y];
}
function unproject(x, y, z) {
  const size = 256 * Math.pow(2, z);
  const lng = x / size * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / size;
  return [180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng];
}
function viewportBbox(z) {
  const [cx, cy] = project(CENTER.lat, CENTER.lng, z);
  const hw = (W / 2) * (1 + PAD * 2);
  const hh = (H / 2) * (1 + PAD * 2);
  const nw = unproject(cx - hw, cy - hh, z);
  const se = unproject(cx + hw, cy + hh, z);
  return { minLon: nw[1], maxLon: se[1], minLat: se[0], maxLat: nw[0] };
}

/* ------------------------- 与 server/index.js 的 /api/map 同一套参数 ------------------------- */
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const LIMITS = CFG.limits || {};
const db = new OsmDB(DB_FILE, { auditIndexes: false });

function query(zoom, compact) {
  return db.queryBbox({
    ...viewportBbox(zoom), zoom, limit: LIMITS.viewportLimit,
    wayCandidates: LIMITS.wayCandidates, nodeCandidates: LIMITS.nodeCandidates, relationLimit: LIMITS.relationLimit,
    relationCropPad: LIMITS.relationCropPad, relationCropMinMembers: LIMITS.relationCropMinMembers,
    relationCropBoundaryMembers: LIMITS.relationCropBoundaryMembers,
    detail: null, lodDetail: LIMITS.lodDetail, lodRoadSend: LIMITS.roadSend,
    lodRoadClassFloor: LIMITS.roadClassFloor || LIMITS.roadClassZoom,
    minFillArea: null, lodMinFillArea: LIMITS.lodMinFillArea,
    neverSend: null, lodNeverSend: LIMITS.neverSend,
    coalesce: LIMITS.coalesce, compact, view: null,
  });
}

/** 规范化：对象键排序（键顺序不影响语义）、数组保序 —— 用来做"逐字段相同"的断言 */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

const client = loadClientWorld();
const kb = (n) => (n / 1024).toFixed(1);
const pad = (s, n) => String(s).padStart(n);

console.log(`\n视口 ${W}×${H} pad=${PAD} @ (${CENTER.lat}, ${CENTER.lng})`);
console.log(`数据集 ${path.relative(ROOT, DB_FILE)}（**只读**打开，绝不修改）\n`);
console.log('  z   |    D 二进制 |   E D+gz |  I D+br | br省 |   F B+gz |  H B+br | br省 | A→D | F→I | 客户端解析 | 压缩CPU gz→br');
console.log('------+--------------+---------+---------+--------+---------+---------+--------+-------+-------+-------------+-------------');

const rows = [];
for (const zoom of ZOOMS) {
  const pA = query(zoom, false);
  const pB = query(zoom, { on: true, displayFlat: false });
  const pC = query(zoom, { on: true, displayFlat: true });
  const bin = encodeBinaryPayload(pC);

  const textA = JSON.stringify(pA);
  const textB = JSON.stringify(pB);
  const textC = JSON.stringify(pC);
  const bufA = Buffer.from(textA, 'utf8');
  const bufB = Buffer.from(textB, 'utf8');
  const bufC = Buffer.from(textC, 'utf8');
  const gzA = zlib.gzipSync(bufA).length;
  const gzB = zlib.gzipSync(bufB).length;
  const gzD = zlib.gzipSync(bin).length;
  /**
   * brotli（服务端 `pickEncoding()` 选的 br，质量档 `BROTLI_QUALITY = 5`）：
   * gzip 之外再省 ~8%（JSON 载荷上），CPU 与 gzip 同量级。这里两个都量，方便看"再叠一层"的收益。
   */
  const brOf = (b) => zlib.brotliCompressSync(b, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length },
  }).length;
  const brB = brOf(bufB);
  const brD = brOf(bin);

  // 语义对拍（都走真客户端解码器 / 真 unpackPayload）
  const expandJson = (text) => canon(client.__unpack(client.__jsonParse(text)));
  const cOk = expandJson(textC) === expandJson(textB);
  const dOk = canon(client.__unpack(client.__decode(new Uint8Array(bin)))) === expandJson(textC);

  /**
   * 解码耗时（同一份载荷，各跑 5 次取最好）。
   * **两边做等量的活**：都是 `解析 + World.unpackPayload 展开成老形状` ——
   *   JSON 侧 = `JSON.parse(文本)` + 展开（解析由 V8 的 C++ 解析器做）；
   *   BIN  侧 = `World.decodeBinaryPayload(Uint8Array)` + 展开（纯 JS 逐字节读）。
   * 只比"解析"不比"展开"会低估二进制路径（展开在两边是一样的开销），所以刻意都带上。
   */
  const rep = 5;
  let tJson = Infinity;
  let tBin = Infinity;
  let tEncJson = Infinity;
  let tEncBin = Infinity;
  let tGzJson = Infinity;
  let tGzBin = Infinity;
  let tBrJson = Infinity;
  let tBrBin = Infinity;
  for (let i = 0; i < rep; i++) {
    let t = process.hrtime.bigint();
    client.__unpack(client.__jsonParse(textC));
    const ms1 = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms1 < tJson) tJson = ms1;
    t = process.hrtime.bigint();
    client.__unpack(client.__decode(new Uint8Array(bin)));
    const ms2 = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms2 < tBin) tBin = ms2;
    // 服务端一侧：sendJSON 走 JSON.stringify，二进制路径走 encodeBinaryPayload
    t = process.hrtime.bigint();
    JSON.stringify(pC);
    const ms3 = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms3 < tEncJson) tEncJson = ms3;
    t = process.hrtime.bigint();
    encodeBinaryPayload(pC);
    const ms4 = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms4 < tEncBin) tEncBin = ms4;
    // 两端各自 gzip 的 CPU（服务端实际走异步 zlib，这里比的是同一件事的相对开销）
    t = process.hrtime.bigint();
    zlib.gzipSync(bufC);
    const ms5 = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms5 < tGzJson) tGzJson = ms5;
    t = process.hrtime.bigint();
    zlib.gzipSync(bin);
    const ms6 = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms6 < tGzBin) tGzBin = ms6;
    // brotli（服务端 pickEncoding 选的 br / BROTLI_QUALITY = 5）的 CPU，口径与 gzip 同一套
    t = process.hrtime.bigint();
    brOf(bufC);
    const ms7 = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms7 < tBrJson) tBrJson = ms7;
    t = process.hrtime.bigint();
    brOf(bin);
    const ms8 = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms8 < tBrBin) tBrBin = ms8;
  }

  rows.push({
    zoom,
    A: bufA.length, B: bufB.length, C: bufC.length, D: bin.length, E: gzD, F: gzB, G: gzA,
    H: brB, I: brD,
    jsonParseMs: tJson, binDecodeMs: tBin,
    jsonEncodeMs: tEncJson, binEncodeMs: tEncBin,
    gzipJsonMs: tGzJson, gzipBinMs: tGzBin, brJsonMs: tBrJson, brBinMs: tBrBin,
    cMatchesB: cOk, dMatchesC: dOk,
    nodes: pC.nodePack ? pC.nodePack.ids.length : 0,
    nodeTags: Object.keys(pC.nodeTags || {}).length,
    ways: Object.keys(pC.ways || {}).length,
    relations: Object.keys(pC.relations || {}).length,
    lines: (pC.displayLines || []).length,
    areas: (pC.displayAreas || []).length,
    complete: pC.truncation.complete,
    viewOnly: !!pC.viewOnly,
  });
  const r = rows[rows.length - 1];
  console.log(`${pad('z' + zoom, 5)} | ${pad(kb(r.D) + ' KB', 12)} | ${pad(kb(r.E), 7)} | ${pad(kb(r.I), 7)} |`
    + ` ${pad(((1 - r.I / r.E) * 100).toFixed(1) + '%', 6)} | ${pad(kb(r.F), 7)} | ${pad(kb(r.H), 7)} | ${pad(((1 - r.H / r.F) * 100).toFixed(1) + '%', 6)} |`
    + ` ${pad((r.A / r.D).toFixed(2) + '×', 5)} | ${pad((r.F / r.I).toFixed(2) + '×', 5)} |`
    + ` ${pad(tJson.toFixed(1) + '→' + tBin.toFixed(1), 11)} | ${pad(tGzJson.toFixed(1) + '→' + tBrJson.toFixed(1), 12)}`);
}

const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
console.log('------+--------------+---------+---------+--------+---------+---------+--------+-------+-------+-------------+-------------');
console.log(`${pad('合计', 5)} | ${pad(kb(sum('D')) + ' KB', 12)} | ${pad(kb(sum('E')), 7)} | ${pad(kb(sum('I')), 7)} |`
  + ` ${pad(((1 - sum('I') / sum('E')) * 100).toFixed(1) + '%', 6)} | ${pad(kb(sum('F')), 7)} | ${pad(kb(sum('H')), 7)} | ${pad(((1 - sum('H') / sum('F')) * 100).toFixed(1) + '%', 6)} |`
  + ` ${pad((sum('A') / sum('D')).toFixed(2) + '×', 5)} | ${pad((sum('F') / sum('I')).toFixed(2) + '×', 5)} |             |`);

console.log('\n列说明：');
console.log('  A 原始 JSON       `compact:false`（列式 delta 之前的老形状，只在 JSON 汇总列用到）');
console.log('  B 紧凑 JSON       `compact:{on,displayFlat:false}` = **当前出厂默认**（② 摊平关）');
console.log('  C 紧凑 + 摊平     `compact:{on,displayFlat:true}`（② 显式打开；实测比 B 大 0.6%，故默认关）');
console.log('  D 二进制 BIN v1   紧凑载荷走 `encodeBinaryPayload`（①）');
console.log('  E = D+gzip · I = D+br · F = B+gzip · H = B+br   ← **H→I 那一列才是"① + br 叠加后过网省了多少"**');
console.log('  `A→D` 是未压缩口径的编码效率；`F/I` 是"gzip → br 之后"，即 br 相对现状的净收益');
console.log('  客户端解析 = `JSON.parse+展开` → `二进制解码+展开`（**两边做等量的活**），单位 ms（5 次取最好，真 world.js 解码器跑在 vm 里）');
console.log('  服务端编码 = JSON.stringify → encodeBinaryPayload（sendJSON vs sendBinary 各自要付的那一份 CPU）');
console.log('  gzip       = gzip(紧凑 JSON) → gzip(BIN)（同样只比相对开销）');

const bad = rows.filter((r) => !r.cMatchesB || !r.dMatchesC);
console.log(bad.length
  ? `\n❌ 有 ${bad.length} 档语义对拍失败：${bad.map((r) => 'z' + r.zoom).join(', ')}`
  : '\n✅ 每一档：C（摊平）与 B（不摊平）展开后逐字段相同；D（二进制）与 C 展开后逐字段相同');

if (ARGS.json) {
  fs.writeFileSync(path.resolve(ROOT, ARGS.json), JSON.stringify({ args: { W, H, PAD, CENTER, DB: path.relative(ROOT, DB_FILE) }, rows }, null, 1));
  console.log(`\nwrote ${ARGS.json}`);
}
process.exit(bad.length ? 1 : 0);
