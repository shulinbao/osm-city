'use strict';
/**
 * **二进制矢量载荷（BIN v1）与 displayLines 摊平（②）的验收套件。**
 *
 *   node tests/bin-payload-test.js
 *
 * 为什么单独一个文件：`tests/osm-e2e.js` 的 77 项是**冻结的数字**（别的战线也在看它），
 * 所以这套新东西一律放这里。
 *
 * 三层验证，缺一不可：
 *   1. **服务端协商**（真服务器 + 临时库 + 临时端口）：`?fmt=bin` / `?fmt=json` /
 *      `Accept: application/vnd.dsh.osm.bin` / 不认识的 fmt / gzip 开销 —— 全部走真 HTTP；
 *   2. **编解码器**（真 `public/js/world.js` 装在 vm 里）：魔数/版本/越界校验、大 id（> 2^32）、
 *      zigzag 边界、crop、多段几何、unknown-field 零容忍……
 *   3. **真实数据集只读对拍**（`data/osm/osm.sqlite`，**只读打开，绝不修改**）：
 *      z9/z10/z13/z14/z15/z16 六档，二进制解出来的载荷与同一请求的 JSON 载荷**逐字段相同**，
 *      并且确实更小。数据集不在时这一段整体跳过（不会把套件搞红）。
 *
 * 所有临时产物都在 `tests/tmp-bin-e2e/`（gitignore 里 `tests/tmp-*` 已盖住），
 * 端口默认 8947（`E2E_PORT` 可改），**不会碰 8787 上那个线上服**。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 8947);
const DATA_DIR = path.join(ROOT, 'tests', 'tmp-bin-e2e');
const DB = path.join(DATA_DIR, 'osm.sqlite');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'tiny.osm');
const REAL_DB = path.join(ROOT, 'data', 'osm', 'osm.sqlite');
const BASE = `http://127.0.0.1:${PORT}`;
const BIN_CT = 'application/vnd.dsh.osm.bin';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const skip = (name, why) => { skipped += 1; console.log('  ⏭ ' + name + '  （' + why + '）'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ 客户端模块的无浏览器宿主 ============================ */
/**
 * 把 `public/js/util.js` + `world.js`（+ 可选 `mapdata.js`）**原样**装进一个最小宿主。
 * 解码必须跑浏览器里那一份代码 —— 否则测的是"我另写的一份解码器"，什么都说明不了。
 * 只补浏览器原生能力：DataView / TextDecoder（解码器只允许用这两个）。
 */
function loadClient(files, search = '') {
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
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { return c; }, removeChild() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, blur() {}, click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 900, right: 1400, bottom: 900 }),
  });
  const document = {
    readyState: 'complete', body: makeEl(), documentElement: makeEl(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: makeEl, createElementNS: makeEl, createTextNode: (t) => ({ textContent: t }),
    addEventListener() {}, removeEventListener() {},
  };
  const window = {
    G: {},
    location: { protocol: 'http:', host: '127.0.0.1', href: 'http://127.0.0.1/', search },
    addEventListener() {}, removeEventListener() {},
  };
  window.window = window;
  sandbox.window = window;
  sandbox.document = document;
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8'), sandbox, { filename: 'public/js/' + f });
  }
  /**
   * 解码/展开都**在 vm 里**跑：跨 realm 的 `Uint8Array` 与 `JSON.parse` 会让真模块的
   * `Array.isArray` 判定走偏（client-vm.js 里记着同一个坑）。
   */
  vm.runInContext(`
    globalThis.__decBin = function (bytes) { return window.G.World.decodeBinaryPayload(bytes); };
    globalThis.__unpack = function (p) { window.G.World.unpackPayload(p); return p; };
    globalThis.__parse = function (text) { return JSON.parse(text); };
    globalThis.__encBinProbe = function () { return null; };
    /** 在 vm 里解析 + 展开，再把显示几何以 JSON 文本交回宿主（跨 realm 最稳的过界方式） */
    globalThis.__unpackDump = function (text) {
      const p = JSON.parse(text);
      window.G.World.unpackPayload(p);
      return JSON.stringify({ lines: p.displayLines || null, areas: p.displayAreas || null });
    };
  `, sandbox, { filename: 'client-host' });
  return sandbox;
}

/** 规范化比较：对象键排序（键顺序不是语义）、数组保序 */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

const client = loadClient(['util.js', 'world.js']);
const World = client.window.G.World;

/* --------------------------------- HTTP 小工具 --------------------------------- */
/** query 是**查询串**（以 ? 开头），函数自己拼 `/api/map` */
async function getRaw(query, headers = {}) {
  const res = await fetch(BASE + '/api/map' + query, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    ctype: String(res.headers.get('content-type') || ''),
    encoding: res.headers.get('content-encoding'),
    vary: res.headers.get('vary'),
    length: Number(res.headers.get('content-length') || 0),
    buf,
  };
}
function boxOf(q) { return `?minLon=${q.minLon}&minLat=${q.minLat}&maxLon=${q.maxLon}&maxLat=${q.maxLat}&zoom=${q.zoom}`; }

function startServer() {
  return spawn(process.execPath, [
    'server/index.js', '--port', String(PORT), '--data', DATA_DIR, '--osm', DB,
  ], { cwd: ROOT, stdio: 'ignore' });
}
async function waitHealth(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('服务器启动超时');
    await sleep(200);
  }
}

/* --------------------------------- 主流程 --------------------------------- */
(async () => {
  console.log('\n=== 二进制矢量载荷（BIN v1）+ displayLines 摊平 · 验收套件 ===\n');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('▶ 准备：临时库（测试夹具，绝不碰真实数据集）');
  const imp = spawnSync(process.execPath, ['tools/import-osm.js', '--file', FIXTURE, '--db', DB, '--quiet'], { cwd: ROOT, stdio: 'ignore' });
  check('导入器在临时库上执行成功', imp.status === 0, 'exit=' + imp.status);

  const server = startServer();
  let health = null;
  try {
    health = await waitHealth();
  } catch (err) {
    console.error('服务器没起来：' + err.message);
    try { server.kill(); } catch { /* ignore */ }
    process.exit(1);
  }
  check('测试服务器启动（临时端口 ' + PORT + '）', !!health && health.ok === true,
    `节点 ${health.data.nodes} / 道路 ${health.data.ways}`);
  check('临时库与真实数据集是两个文件', path.resolve(DB) !== path.resolve(REAL_DB));

  const reg = await (await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '载荷甲' + Math.floor(Math.random() * 10000), password: 'pass1234' }),
  })).json();
  const token = reg.token;
  check('注册拿到 token', typeof token === 'string' && token.length > 0);

  // 一屏视口（夹具很小，但走的是完整的 /api/map 路径）
  const BOX = { minLon: 115.90, minLat: 39.70, maxLon: 117.10, maxLat: 40.10, zoom: 15 };
  const q = boxOf(BOX) + '&token=' + encodeURIComponent(token);

  /* ======================= 一、服务端协商（真 HTTP） ======================= */
  console.log('\n▶ 一、能力协商（fmt 参数 / Accept 头 / 默认值 / 逃生阀）');
  const noFmt = await getRaw(q);
  check('不带 fmt、不带 Accept → JSON（Content-Type: application/json）', noFmt.status === 200 && noFmt.ctype.indexOf('application/json') === 0,
    `${noFmt.status} ${noFmt.ctype} ${noFmt.length}B`);
  const jsonPayload = JSON.parse(noFmt.buf.toString('utf8'));
  check('JSON 载荷带紧凑编码说明书 enc', !!jsonPayload.enc && jsonPayload.enc.v >= 1, JSON.stringify(jsonPayload.enc && jsonPayload.enc.v));

  const binHdr = await getRaw(q + '&fmt=bin');
  check('fmt=bin → Content-Type: ' + BIN_CT, binHdr.status === 200 && binHdr.ctype.indexOf(BIN_CT) === 0,
    `${binHdr.status} ${binHdr.ctype} ${binHdr.length}B`);
  check('fmt=bin 的响应体是 BIN v1（魔数 DSHB + 版本 1）',
    binHdr.buf.length > 8 && binHdr.buf.toString('latin1', 0, 4) === 'DSHB' && binHdr.buf[4] === 1,
    'magic=' + binHdr.buf.toString('latin1', 0, 4) + ' ver=' + binHdr.buf[4]);

  const esc = await getRaw(q + '&fmt=json');
  check('逃生阀 fmt=json → JSON（哪怕 Accept 说会解二进制）', esc.ctype.indexOf('application/json') === 0);
  const escAccept = await getRaw(q + '&fmt=json', { Accept: BIN_CT + ', application/json' });
  check('fmt=json 一票否决 Accept（逃生阀优先级最高）', escAccept.ctype.indexOf('application/json') === 0, escAccept.ctype);

  const byAccept = await getRaw(q, { Accept: BIN_CT + ', application/json' });
  check('Accept: ' + BIN_CT + ' → BIN', byAccept.ctype.indexOf(BIN_CT) === 0, byAccept.ctype);
  const acceptWithQ = await getRaw(q, { Accept: 'application/json, ' + BIN_CT + ';q=0.1' });
  check('Accept 里带 q 值也能协商出 BIN', acceptWithQ.ctype.indexOf(BIN_CT) === 0, acceptWithQ.ctype);

  const unknownFmt = await getRaw(q + '&fmt=xml');
  check('不认识的 fmt=xml → 退回 JSON（绝不猜）', unknownFmt.ctype.indexOf('application/json') === 0);

  const ordinaryAccept = await getRaw(q, { Accept: 'application/json' });
  check('老客户端（Accept: application/json）→ JSON', ordinaryAccept.ctype.indexOf('application/json') === 0);

  /* ======================= 二、gzip（本来就开着，回归护栏 + 二进制不会被重复压缩） ======================= */
  console.log('\n▶ 二、gzip（服务端 sendJSON / sendBinary 的既有行为）');
  /**
   * ⚠ 测试侧必须显式控制 `Accept-Encoding`：Node 的 fetch（undici）**默认就带**
   * `Accept-Encoding: gzip, deflate` 并且**自动解压**响应体。
   * 所以这里一律显式发头，并且用 `content-length`（= 服务端真正发出去的字节数）判压缩，
   * 用 `buf.length`（= 解压后的原始字节）判载荷大小。
   */
  const binIdentity = await getRaw(q + '&fmt=bin', { 'Accept-Encoding': 'identity' });
  check('Accept-Encoding: identity → 不压缩（无 Content-Encoding）', !binIdentity.encoding, String(binIdentity.encoding));
  check('未压缩时 Content-Length 等于 body 字节数（没有偷偷压）',
    binIdentity.length === binIdentity.buf.length, `${binIdentity.length} == ${binIdentity.buf.length}`);

  const binGzip = await getRaw(q + '&fmt=bin', { 'Accept-Encoding': 'gzip' });
  check('BIN + Accept-Encoding: gzip → Content-Encoding: gzip', binGzip.encoding === 'gzip', String(binGzip.encoding));
  check('BIN 的 gzip 是**真压缩**（body 解出来仍是同一份 BIN，且过网字节更少）',
    binGzip.buf.length === binIdentity.buf.length && binGzip.length < binIdentity.length,
    `${binIdentity.length}B → ${binGzip.length}B`);
  check('BIN v1 自身不压缩 → 外层 gzip 不是"重复压缩"（能再小 2 倍上下）',
    binGzip.length < binIdentity.length * 0.75,
    `${(binIdentity.length / Math.max(1, binGzip.length)).toFixed(2)}×`);

  const jsonGzip = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'gzip' });
  check('JSON + Accept-Encoding: gzip → gzip（回归：这条**一直开着**，不是我这次加的）',
    jsonGzip.encoding === 'gzip', String(jsonGzip.encoding));
  const jsonIdentity = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'identity' });
  check('JSON 的 gzip 也确实更小', jsonGzip.length < jsonIdentity.length,
    `${jsonIdentity.length}B → ${jsonGzip.length}B`);

  const gzRefused = await getRaw(q + '&fmt=bin', { 'Accept-Encoding': 'gzip;q=0' });
  check('Accept-Encoding: gzip;q=0 → 尊重客户端的拒绝', !gzRefused.encoding);
  check('响应带 Vary: Accept-Encoding（中间缓存不会串味）', String(binHdr.vary || '').indexOf('Accept-Encoding') >= 0, String(binHdr.vary));

  /* ---------- 二之二、编码协商：brotli / gzip / identity（q 值 + 显式拒绝） ---------- */
  console.log('\n▶ 二之二、Accept-Encoding 协商（br 优先，gzip 兜底，q=0 必须尊重）');
  /** 归一化：两次请求间本来就不同的字段（ms、query.fmt）剔掉，只比数据 */
  const bodyOf = (r) => {
    const p = JSON.parse(r.buf.toString('utf8'));
    delete p.ms;
    if (p.query) p.query.fmt = 'x';
    return canon(p);
  };
  const identity = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'identity' });
  const gzOnly = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'gzip' });
  const brOnly = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'br' });

  check('Accept-Encoding: br → Content-Encoding: br（服务端会压 brotli 了）',
    brOnly.encoding === 'br', String(brOnly.encoding));
  check('br 解出来的载荷与 identity 逐字节一致（只排除 ms / query.fmt）',
    bodyOf(brOnly) === bodyOf(identity));
  check('br 比 gzip 更小（q5 实测约省 7%）', brOnly.length < gzOnly.length,
    `gzip ${gzOnly.length}B → br ${brOnly.length}B（省 ${((1 - brOnly.length / gzOnly.length) * 100).toFixed(1)}%）`);
  check('br 也比 gzip 比未压缩小', brOnly.length < gzOnly.length && gzOnly.length < identity.length,
    `${identity.length} → gzip ${gzOnly.length} → br ${brOnly.length}`);

  const brGz = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'br, gzip' });
  check('br 与 gzip 同 q 时优先 br', brGz.encoding === 'br', String(brGz.encoding));
  const gzWins = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'br;q=0.5, gzip;q=1' });
  check('gzip;q=1, br;q=0.5 → 用 gzip（等价才优先 br，q 高者胜）', gzWins.encoding === 'gzip', String(gzWins.encoding));
  const brRefused = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'br;q=0, gzip' });
  check('br;q=0 → 不许用 br，退回 gzip', brRefused.encoding === 'gzip', String(brRefused.encoding));
  const gzRefusedBr = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'gzip;q=0, br' });
  check('gzip;q=0 → 不许用 gzip，改用 br', gzRefusedBr.encoding === 'br', String(gzRefusedBr.encoding));
  const bothRefused = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'br;q=0, gzip;q=0' });
  check('br 与 gzip 都被 q=0 拒 → 原样发明文（不带 Content-Encoding）', !bothRefused.encoding, String(bothRefused.encoding));
  const identOnly = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'identity' });
  check('Accept-Encoding: identity → 不压缩', !identOnly.encoding, String(identOnly.encoding));
  const zstdOnly = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'zstd' });
  check('只点名 zstd（不认识）→ 不压缩，也**不报错**', !zstdOnly.encoding && zstdOnly.status === 200,
    `${zstdOnly.status} ${zstdOnly.encoding}`);
  const star = await getRaw(q + '&fmt=json', { 'Accept-Encoding': '*' });
  check('Accept-Encoding: * → 用我们最好的那个（br）', star.encoding === 'br', String(star.encoding));
  const idForbidden = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'identity;q=0' });
  check('identity;q=0 而 br/gzip 都没点名 → 仍发明文（宁可发明文也不回 406，见 pickEncoding 注释）',
    idForbidden.status === 200 && !idForbidden.encoding, `${idForbidden.status} ${idForbidden.encoding}`);

  // 二进制载荷（① 的产物）也要走同一套协商
  const binBr = await getRaw(q + '&fmt=bin', { 'Accept-Encoding': 'br' });
  const binGz2 = await getRaw(q + '&fmt=bin', { 'Accept-Encoding': 'gzip' });
  const binId = await getRaw(q + '&fmt=bin', { 'Accept-Encoding': 'identity' });
  check('二进制载荷也走同一套协商：Content-Encoding: br', binBr.encoding === 'br', String(binBr.encoding));
  check('二进制载荷解出来仍是同一份 BIN（魔数 DSHB + 长度一致）',
    binBr.buf.toString('latin1', 0, 4) === 'DSHB' && binBr.buf.length === binId.buf.length,
    `${binId.buf.length}B → br ${binBr.length}B`);
  check('二进制载荷上 br 相对 gzip 的收益**明显更小**（熵高，符合预期）',
    binBr.length < binGz2.length && (1 - binBr.length / binGz2.length) < 0.07,
    `bin gzip ${binGz2.length}B → br ${binBr.length}B（省 ${((1 - binBr.length / binGz2.length) * 100).toFixed(1)}%）；`
    + `同时 JSON 上省 ${((1 - brOnly.length / gzOnly.length) * 100).toFixed(1)}%`);

  /* ======================= 三、两种编码解出来的载荷逐字段相同 ======================= */
  console.log('\n▶ 三、同一视口：BIN 与 JSON 解出来的载荷必须逐字段相同');
  check('BIN 响应比 JSON 响应小', binHdr.buf.length < noFmt.buf.length,
    `${noFmt.buf.length}B → ${binHdr.buf.length}B（${(noFmt.buf.length / binHdr.buf.length).toFixed(2)}×）`);
  /**
   * 两次独立请求里**本来就该不一样**的字段（按设计不同，不是 bug）：
   *   · `payload.ms`         这次查询花了多久；
   *   · `payload.query.fmt`  回显这次用的编码（json / bin）；
   *   · `query.caps.flatCaps` "能力是否被用于扁平几何" —— `fmt=bin` 也算声明，所以 JSON 那一次是 false。
   * 除此之外**逐字段必须相同**。
   */
  const normalize = (payload) => {
    if (payload) {
      delete payload.ms;
      if (payload.query) {
        payload.query.fmt = '(编码回显，按设计不同)';
        if (payload.query.caps) payload.query.caps.flatCaps = '(按设计不同)';
      }
    }
    return payload;
  };
  const jsonExpanded = canon(client.__unpack(normalize(client.__parse(noFmt.buf.toString('utf8')))));
  const binExpanded = canon(client.__unpack(normalize(client.__decBin(new Uint8Array(binHdr.buf)))));
  check('BIN 解码 + 展开后与 JSON 展开后逐字段相同（只排除 ms 与 query.fmt）', binExpanded === jsonExpanded,
    binExpanded === jsonExpanded ? '' : `首个差异 @${(() => { let i = 0; while (i < binExpanded.length && i < jsonExpanded.length && binExpanded[i] === jsonExpanded[i]) i++; return i; })()}`);
  const binPayload = client.__decBin(new Uint8Array(binHdr.buf));
  /**
   * `displayPaths` **故意不同**，这是对的：`enc` 要描述**手上这个对象**的形状。
   *   · JSON 那一份 = 服务端按能力开关选的形状（默认 `split`，见 PACK_DEFAULTS.displayFlat）；
   *   · BIN 解出来的那一份**一定**是 `flat+segs`（DISPLAY 段的格式就是"段长表 + 扁平坐标"），
   *     所以 `decodeBinaryPayload` 会把说明书对准它 —— 否则 `unpackPayload` 会按老形状去读
   *     扁平数组，正是"多段被当成一段"的那种误画。
   * 其余解码参数（nodeScale / lineScale / wayRefs）必须一致。
   */
  check('BIN 载荷里的解码参数与 JSON 版一致（nodeScale/lineScale/wayRefs）',
    binPayload.enc && binPayload.enc.nodeScale === jsonPayload.enc.nodeScale
    && binPayload.enc.lineScale === jsonPayload.enc.lineScale
    && binPayload.enc.wayRefs === jsonPayload.enc.wayRefs,
    JSON.stringify(binPayload.enc));
  check('BIN 解码后的 enc.displayPaths 被对准为 flat+segs（描述它自己那份几何），JSON 那份是 split',
    binPayload.enc.displayPaths === 'flat+segs' && jsonPayload.enc.displayPaths === 'split',
    `bin=${binPayload.enc.displayPaths} json=${jsonPayload.enc.displayPaths}`);
  check('payload.query.fmt 回显这次用的编码', binPayload.query && binPayload.query.fmt === 'bin',
    JSON.stringify(binPayload.query && binPayload.query.fmt));
  check('BIN 载荷的账本（truncation / totals / zoom）原样带来',
    !!binPayload.truncation && typeof binPayload.truncation.complete === 'boolean'
    && typeof binPayload.zoom === 'number' && !!binPayload.totals);
  check('低缩放"只看不改"边界仍随响应回显（viewOnly.maxZoom）',
    !!binPayload.truncation.viewOnly && binPayload.truncation.viewOnly.maxZoom === 14,
    JSON.stringify(binPayload.truncation.viewOnly && binPayload.truncation.viewOnly.maxZoom));

  /* ======================= 四、客户端协商与逃生阀（真 mapdata.js） ======================= */
  console.log('\n▶ 四、客户端协商 / 逃生阀（真 public/js/mapdata.js 装在 vm 里）');
  const md = loadClient(['util.js', 'world.js', 'mapdata.js']);
  const MapData = md.window.G.MapData;
  check('MapData.DEFAULTS.binary 默认为 true', MapData.DEFAULTS.binary === true);
  check('默认的 loader 想要二进制（wantBin() === true）', MapData.wantBin() === true);
  check('MapData.setBinary(false) → wantBin() 变 false（退回纯 JSON）',
    MapData.setBinary(false) === false && MapData.wantBin() === false);
  check('MapData.setBinary(true) → 复位回 true', MapData.setBinary(true) === true && MapData.wantBin() === true);
  const mdEsc = loadClient(['util.js', 'world.js', 'mapdata.js'], '?foo=1&fmt=json');
  check('页面地址带 ?fmt=json → 这一页整体退回 JSON（逃生阀）',
    mdEsc.window.G.MapData.binOff === true && mdEsc.window.G.MapData.wantBin() === false);
  check('payloadStats() 能报出这次用的是哪种编码', !!MapData.payloadStats() && MapData.payloadStats().binaryOn === true,
    JSON.stringify(MapData.payloadStats()));
  /**
   * `MapData.selfCheck()` 是 mapdata.js 自带的整套沙盒自检（假 map + 假 fetch，跑完整取数流程：
   * 缺口/拆块/截断/失败重试/预取/卸载……）。这次改了 `_fetch`（拆成 `_mapRequest` + `_mapOnce`），
   * 所以**必须**把这份自检重跑一遍 —— 它正是"取数流程有没有被改坏"的那道闸。
   * 自检的假 fetch 不带 `content-type`，所以它走的是"服务端只回 JSON"那条兜底路径。
   */
  const sc = await MapData.selfCheck();
  check('MapData.selfCheck() 全绿（含新的 fmt 协商/兜底路径）', !!sc && sc.ok === true,
    `steps=${sc && sc.steps ? sc.steps.length : '?'} requests=${sc && sc.requests} failures=${JSON.stringify(sc && sc.failures || [])}`);
  check('自检覆盖了完整的取数流程（≥ 20 步）', !!sc && Array.isArray(sc.steps) && sc.steps.length >= 20,
    String(sc && sc.steps && sc.steps.length));

  /* ------------- 四之二、混版组合：新客户端 + 老服务端 / 解码失败自动退回 ------------- */
  console.log('\n▶ 四之二、混版组合（**最关键的一条安全承诺**：两侧不认识对方都能自动退回 JSON）');
  /**
   * 这一段直接驱动**真 `_mapOnce` / `_mapRequest`**（mapdata.js 里那两个函数），
   * 只把 `fetch` 换成假的 —— 于是"新客户端 + 老服务端"这条组合是在真代码路径上验的。
   */
  const mkRes = (buf, ctype) => ({
    ok: true,
    status: 200,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        if (key === 'content-type') return ctype;
        if (key === 'content-length') return String(buf.length);
        return null;
      },
    },
    json: () => Promise.resolve(JSON.parse(buf.toString('utf8'))),
    arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  });
  const jsonBody = Buffer.from(noFmt.buf);          // 真 JSON 响应体（老服务端会返回的东西）
  const binBody = Buffer.from(binHdr.buf);          // 真 BIN 响应体

  // ① 新客户端 + 老服务端：请求里带了 fmt=bin，但服务端（不认识）照旧返回 JSON
  {
    const seenUrls = [];
    const ld = MapData.createLoader({
      fetch: (url, init) => { seenUrls.push({ url, accept: init && init.headers && init.headers.Accept }); return Promise.resolve(mkRes(jsonBody, 'application/json; charset=utf-8')); },
    });
    const r = await ld._mapOnce({ minLon: 115.9, minLat: 39.7, maxLon: 117.1, maxLat: 40.1 }, 15, null, { seq: ld.loadSeq }, true);
    check('老服务端（只回 JSON）→ 客户端照样解析成功（以 content-type 为权威判据）',
      !!r && !!r.payload && typeof r.payload.zoom === 'number', r && r.payload && String(r.payload.zoom));
    check('客户端确实声明了能力（URL 带 fmt=bin + Accept 带 ' + BIN_CT + '）',
      seenUrls.length === 1 && seenUrls[0].url.indexOf('fmt=bin') >= 0 && String(seenUrls[0].accept).indexOf(BIN_CT) >= 0,
      JSON.stringify(seenUrls[0]));
    check('账本如实记下"这次是 JSON 兜底"（lastFmt = json-fallback）',
      ld.stats.lastFmt === 'json-fallback', String(ld.stats.lastFmt));
  }

  // ② 新客户端 + 新服务端：BIN 响应体走真解码器
  {
    const ld = MapData.createLoader({ fetch: () => Promise.resolve(mkRes(binBody, BIN_CT)) });
    const r = await ld._mapOnce({ minLon: 115.9, minLat: 39.7, maxLon: 117.1, maxLat: 40.1 }, 15, null, { seq: ld.loadSeq }, true);
    check('新服务端（回 BIN）→ 客户端用真解码器解出载荷（lastFmt = bin）',
      !!r && !!r.payload && ld.stats.lastFmt === 'bin'
      && !!r.payload.enc && r.payload.enc.nodeScale === 1e7 && !!r.payload.nodePack,
      'lastFmt=' + ld.stats.lastFmt);
    check('BIN 路径统计计数 +1', ld.stats.binPayloads === 1 && (ld.stats.jsonPayloads || 0) === 0,
      `bin=${ld.stats.binPayloads} json=${ld.stats.jsonPayloads}`);
  }

  // ③ 解码失败（版本不认识）→ 自动关掉二进制，并用 fmt=json 重取一次
  {
    const broken = Buffer.from(binBody);
    broken[4] = 99;                                  // 版本号改成不认识的
    const urls = [];
    const ld = MapData.createLoader({
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(urls.length === 1 ? mkRes(broken, BIN_CT) : mkRes(jsonBody, 'application/json; charset=utf-8'));
      },
    });
    const r = await ld._mapRequest({ minLon: 115.9, minLat: 39.7, maxLon: 117.1, maxLat: 40.1 }, 15, null, { seq: ld.loadSeq }, true);
    check('BIN 解码失败 → 自动退回 JSON 重取一次（不把这一屏卡住）',
      !!r && !!r.payload && urls.length === 2 && urls[1].indexOf('fmt=json') >= 0,
      `${urls.length} 次请求，第二次 ${urls[1] ? urls[1].replace(/token=.*/, 'token=…') : '—'}`);
    check('退回之后二进制被整体关掉（不再反复踩坑）', ld.binOff === true && ld.wantBin() === false);
    check('兜底计数如实 +1（binFallback = 1）', ld.stats.binFallback === 1, String(ld.stats.binFallback));
    check('MapData.setBinary(true) 能把"解码失败自动关掉"的状态复位',
      MapData.setBinary(true) === true && MapData.wantBin() === true);
  }
  /**
   * ④ 反方向（老客户端 + 新服务端）：已经在"一、能力协商"里验过了 ——
   *    不带 `fmt`、`Accept: application/json` 时服务端一律回 JSON，老客户端一个字都不用改。
   */

  /* ======================= 四之三、扁平几何的"能力开关"（部署安全） ======================= */
  console.log('\n▶ 四之三、扁平几何的能力开关（**部署时不能打坏正在玩的旧标签页**）');
  /**
   * 这一段验的是"服务端绝不单方面改协议"：
   * 扁平形状要**两道门串联**才发 —— ① 配置允许 ② 客户端声明能力（`?caps=flatsegs` 或 `fmt=bin`）。
   * 直接调真 `queryBbox`（进程内，参数可控），比走 HTTP 更能覆盖"配置打开了"这种组合。
   */
  {
    const { OsmDB: RealOsmDB } = require(path.join(ROOT, 'server', 'osmdb.js'));
    const box = { minLon: 115.9, minLat: 39.7, maxLon: 117.1, maxLat: 40.1, zoom: 13 };
    // 用夹具库（真实数据集那一段在下面），走真 OsmDB + 真 queryBbox
    const { DatabaseSync: DS } = require('node:sqlite');
    const dbschema2 = require(path.join(ROOT, 'server', 'dbschema.js'));
    const origOpen = dbschema2.openDatabase;
    dbschema2.openDatabase = (f) => { const d = new DS(f, { readOnly: true }); d.exec('PRAGMA temp_store = MEMORY'); return d; };
    const probe = new RealOsmDB(DB, { auditIndexes: false });
    dbschema2.openDatabase = origOpen;
    const shapeOf = (compact, flatCaps) => {
      const p = probe.queryBbox({
        ...box, limit: 15000, coalesce: undefined, compact, view: null, flatCaps,
      });
      return p.enc ? p.enc.displayPaths : '(无 enc)';
    };
    check('出厂默认（配置 displayFlat=false）+ 客户端声明能力 → 仍然是老形状 split',
      shapeOf(undefined, true) === 'split', shapeOf(undefined, true));
    check('配置打开 displayFlat + 客户端**没声明**能力 → **老形状**（老标签页安全）',
      shapeOf({ on: true, displayFlat: true }, false) === 'split', shapeOf({ on: true, displayFlat: true }, false));
    check('配置打开 displayFlat + 客户端**声明了**能力（caps=flatsegs）→ 才发扁平 flat+segs',
      shapeOf({ on: true, displayFlat: true }, true) === 'flat+segs', shapeOf({ on: true, displayFlat: true }, true));
    check('配置关掉 displayFlat + 客户端声明了能力 → 还是老形状（配置是硬闸，客户端说了不算）',
      shapeOf({ on: true, displayFlat: false }, true) === 'split', shapeOf({ on: true, displayFlat: false }, true));
  }
  // 端到端确认：HTTP 层真的把 caps 传下去了（`payload.query.caps` 是回显）
  {
    const noCaps = await getRaw(q + '&fmt=json', { 'Accept-Encoding': 'identity' });
    const withCaps = await getRaw(q + '&fmt=json&caps=flatsegs', { 'Accept-Encoding': 'identity' });
    const jNo = JSON.parse(noCaps.buf.toString('utf8'));
    const jYes = JSON.parse(withCaps.buf.toString('utf8'));
    check('不带 caps 的请求：query.caps.flatsegs=false，且几何是老形状',
      jNo.query.caps && jNo.query.caps.flatsegs === false && jNo.query.compact.displayPaths === 'split',
      JSON.stringify(jNo.query.caps) + ' ' + jNo.query.compact.displayPaths);
    check('带 caps=flatsegs 的请求：query.caps.flatsegs=true（能力已送达服务端）',
      jYes.query.caps && jYes.query.caps.flatsegs === true, JSON.stringify(jYes.query.caps));
    check('出厂默认下，两种请求的几何形状仍然都是 split（配置没开，能力也不越权）',
      jYes.query.compact.displayPaths === 'split', jYes.query.compact.displayPaths);
    check('fmt=bin 也算声明能力（query.caps.flatCaps=true，而 flatsegs 仍为 false）',
      (() => {
        const p = client.__decBin(new Uint8Array(binHdr.buf));
        return !!(p.query && p.query.caps && p.query.caps.flatsegs === false && p.query.caps.flatCaps === true);
      })(),
      (() => {
        const p = client.__decBin(new Uint8Array(binHdr.buf));
        return JSON.stringify(p.query && p.query.caps) + ' displayPaths=' + (p.enc && p.enc.displayPaths);
      })());
  }

  /* ======================= 四之四、客户端遇到不认识的形状不能静默乱画 ======================= */
  console.log('\n▶ 四之四、客户端对**不认识的** enc.displayPaths 必须出声（不静默乱画）');
  {
    const payload = {
      enc: { v: 9, nodeScale: 1e6, lineScale: 1e5, wayRefs: 'delta', displayPaths: 'flat+v3-future' },
      nodePack: { ids: [1], lat: [0], lon: [0] }, nodeTags: {}, ways: {}, relations: {},
      displayLines: [{ class: 'road', tags: {}, coords: [3991353, 11632510, 785, -2220, 785, 2220], segs: [1, 2] }],
      displayAreas: [{ class: 'water', tags: {}, coords: [100, 200, 10, 20], segs: [2] }],
      zoom: 13, totals: {}, truncation: { complete: true }, viewOnly: true, truncated: false,
    };
    const warns = [];
    const md3 = loadClient(['util.js', 'world.js']);
    md3.console = Object.assign({}, console, { error: (...a) => warns.push(a.join(' ')) });
    const out = JSON.parse(String(md3.__unpackDump(JSON.stringify(payload))));
    check('不认识的形状 → 打了 console.error，且说清了取值与只认哪两个',
      warns.length === 1 && warns[0].indexOf('flat+v3-future') >= 0 && warns[0].indexOf('flat+segs') >= 0,
      String(warns[0] || '(没有报错)').slice(0, 120));
    check('不认识的形状 → **按结构兜底**，段数没有丢（2 段仍然是 2 段，不是被当成 1 段）',
      !!out.lines && Array.isArray(out.lines[0].paths) && out.lines[0].paths.length === 1
      && out.lines[0].coords.length === 1,
      `coords ${out.lines && out.lines[0] ? out.lines[0].coords.length : '?'} 点 / paths ${out.lines && out.lines[0].paths ? out.lines[0].paths.length : 0} 段`);
    check('不认识的形状 + 老形状条目（没有 segs）→ 走老路径，照样正确',
      !!out.areas && out.areas[0].coords.length === 2, String(out.areas && out.areas[0] ? out.areas[0].coords.length : '?'));
    // 一次载荷只报一次（不按条目刷屏）
    const warns2 = [];
    const md4 = loadClient(['util.js', 'world.js']);
    md4.console = Object.assign({}, console, { error: (...a) => warns2.push(a.join(' ')) });
    md4.__unpackDump(JSON.stringify(Object.assign({}, payload, {
      displayLines: [payload.displayLines[0], payload.displayLines[0], payload.displayLines[0]],
    })));
    check('同一次载荷只报一次（三个条目也只报一行，不刷屏）', warns2.length === 1, String(warns2.length));
    // 认识的两个取值都不能报错
    const warns3 = [];
    const md5 = loadClient(['util.js', 'world.js']);
    md5.console = Object.assign({}, console, { error: (...a) => warns3.push(a.join(' ')) });
    md5.__unpackDump(JSON.stringify(Object.assign({}, payload,
      { enc: Object.assign({}, payload.enc, { displayPaths: 'split' }) })));
    check('认识的取值 split → 一行错都不报', warns3.length === 0, String(warns3.length));
  }

  /* ======================= 五、编解码器（边界 / 零容忍） ======================= */
  console.log('\n▶ 五、BIN v1 编解码器的边界与零容忍');
  const { encodeBinaryPayload } = require(path.join(ROOT, 'server', 'osmdb.js'));

  const baseEnc = { v: 2, nodeScale: 1e6, lineScale: 1e5, wayRefs: 'delta', displayPaths: 'flat+segs' };
  const mini = {
    enc: baseEnc, nodePack: { ids: [1, 1], lat: [0, 1], lon: [0, -1] }, nodeTags: {},
    ways: {}, relations: {}, viewOnly: false, truncated: false, zoom: 15,
    totals: {}, truncation: { complete: true },
  };
  const miniBin = encodeBinaryPayload(mini);
  const miniDec = client.__decBin(new Uint8Array(miniBin));
  check('空几何（0 way / 0 关系 / 无合并几何）也能往返',
    miniDec.zoom === 15 && miniDec.nodePack.ids.length === 2 && !miniDec.displayLines && !miniDec.displayAreas,
    `${miniBin.length}B`);

  check('魔数不对 → 抛错（客户端会退回 fmt=json）', (() => {
    const bad = Buffer.from(miniBin);
    bad[0] = 0x00;
    try { client.__decBin(new Uint8Array(bad)); return false; } catch { return true; }
  })());
  check('版本不认识 → 抛错', (() => {
    const bad = Buffer.from(miniBin);
    bad[4] = 99;
    try { client.__decBin(new Uint8Array(bad)); return false; } catch (e) { return /版本/.test(String(e.message)); }
  })());
  check('段落目录越界 → 抛错（不读到别人的内存）', (() => {
    const bad = Buffer.from(miniBin);
    bad.writeUInt16LE(60000, 6);
    try { client.__decBin(new Uint8Array(bad)); return false; } catch { return true; }
  })());
  check('截断的缓冲区 → 抛错', (() => {
    try { client.__decBin(new Uint8Array(miniBin.subarray(0, Math.max(8, miniBin.length - 3)))); return false; } catch { return true; }
  })());
  check('非紧凑载荷（没有 enc）→ 编码器抛错（→ 服务端退回 JSON）', (() => {
    try { encodeBinaryPayload({ nodes: {}, ways: {} }); return false; } catch { return true; }
  })());
  check('显示条目上有不认识的字段 → 编码器抛错（绝不悄悄吞字段）', (() => {
    try {
      encodeBinaryPayload(Object.assign({}, mini, {
        displayLines: [{ class: 'x', tags: {}, coords: [1, 2], segs: [1], 未来字段: 1 }],
      }));
      return false;
    } catch { return true; }
  })());
  check('way 形状不是 5 元组 → 编码器抛错', (() => {
    try { encodeBinaryPayload(Object.assign({}, mini, { ways: { 1: [1, [1], null, 0] } })); return false; } catch { return true; }
  })());

  // 大 id（> 2^32，真实 OSM 节点 id 已经到 1.2e10）：uvarint 不能走 32 位位运算
  const bigIds = [12000000000, 12000000001, 11999999999, 1];
  const big = Object.assign({}, mini, {
    nodePack: { ids: [bigIds[0], 1, -2, -11999999998], lat: [39900000, 1, -1, 0], lon: [116000000, -1, 1, 0] },
    nodeTags: { 12000000000: { name: '超界点' }, 1: { amenity: 'cafe' } },
  });
  const bigDec = client.__decBin(new Uint8Array(encodeBinaryPayload(big)));
  check('节点 id > 2^32（1.2e10）往返无损',
    JSON.stringify(bigDec.nodePack.ids) === JSON.stringify(big.nodePack.ids)
    && JSON.stringify(Object.keys(bigDec.nodeTags).sort()) === JSON.stringify(['1', '12000000000']),
    JSON.stringify(bigDec.nodePack.ids));

  // zigzag 边界
  const zigVals = [-1, 1, 0, -63, 63, -64, 64, -8192, 8191, 8192, 2147483647, -2147483648, 4503599627370495];
  const zigPayload = Object.assign({}, mini, { nodePack: { ids: zigVals, lat: zigVals.map((v) => v % 1000), lon: zigVals.map((v) => -v % 1000) } });
  const zigDec = client.__decBin(new Uint8Array(encodeBinaryPayload(zigPayload)));
  check('zigzag/varint 边界值（含 ±2^31、2^52−1）往返无损',
    JSON.stringify(zigDec.nodePack.ids) === JSON.stringify(zigVals));

  // crop / 关系成员 / role
  const relPayload = Object.assign({}, mini, {
    relations: {
      7: [3, [['way', 10, ''], ['node', 1, 'outer'], ['relation', 5, 'inner']], { type: 'multipolygon', name: '测试' }, null],
      9: [1, [['way', 20, '']], null, {
        cropped: true, reason: 'viewport', memberTotal: 9, memberKept: 1,
        memberWaysTotal: 9, memberWaysKept: 1, memberNodesTotal: 0, memberNodesKept: 0,
        memberRelsTotal: 0, memberRelsKept: 0,
      }],
    },
  });
  const relDec = client.__decBin(new Uint8Array(encodeBinaryPayload(relPayload)));
  check('关系成员（type/ref/role）与裁剪账本（crop）往返无损',
    canon(relDec.relations) === canon(relPayload.relations), JSON.stringify(relDec.relations['9'] && relDec.relations['9'][3]));

  // 多段折线 + name + rel（② 的摊平形状）
  const dispPayload = Object.assign({}, mini, {
    displayLines: [
      { class: 'road', tags: { highway: 'primary' }, name: '长安街', coords: [100, 200, -1, -2, 105, 198, 3, 4], segs: [2, 2] },
      { class: 'railway', tags: {}, coords: [-5, -6], segs: [1] },
    ],
    displayAreas: [{ class: 'water', tags: { natural: 'water' }, rel: 3263576, coords: [7, 8, 1, 1], segs: [2] }],
  });
  const dispDec = client.__decBin(new Uint8Array(encodeBinaryPayload(dispPayload)));
  check('displayLines 多段（segs 段长表）+ name 往返无损',
    canon(dispDec.displayLines) === canon(dispPayload.displayLines), JSON.stringify(dispDec.displayLines));
  check('displayAreas 的 rel（面关系 id）往返无损（曾经漏掉过）',
    dispDec.displayAreas[0].rel === 3263576, JSON.stringify(dispDec.displayAreas[0]));
  const dispExpanded = canon(client.__unpack(client.__parse(JSON.stringify(dispDec))));
  const wantExpanded = canon(client.__unpack(client.__parse(JSON.stringify(dispPayload))));
  check('摊平（coords+segs）与拆分（coords+paths）展开后**逐点相同**', dispExpanded === wantExpanded,
    wantExpanded === dispExpanded ? '' : wantExpanded.slice(0, 200) + ' ≠ ' + dispExpanded.slice(0, 200));

  /* ======================= 六、真实数据集只读对拍 ======================= */
  console.log('\n▶ 六、真实数据集（只读）z9/z10/z13/z14/z15/z16 对拍');
  if (!fs.existsSync(REAL_DB)) {
    skip('真实数据集对拍', '找不到 ' + path.relative(ROOT, REAL_DB));
  } else {
    // **只读打开**：在 require osmdb 之前把 openDatabase 换成 readOnly 连接
    const dbschema = require(path.join(ROOT, 'server', 'dbschema.js'));
    dbschema.openDatabase = (file) => {
      const d = new DatabaseSync(file, { readOnly: true });
      d.exec('PRAGMA temp_store = MEMORY');
      d.exec('PRAGMA cache_size = -64000');
      return d;
    };
    const { OsmDB } = require(path.join(ROOT, 'server', 'osmdb.js'));
    const real = new OsmDB(REAL_DB, { auditIndexes: false });
    const LIMITS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).limits || {};
    const CENTER = { lat: 39.9042, lng: 116.4074 };
    const proj = (lat, lng, z) => {
      const size = 256 * Math.pow(2, z);
      const s = Math.sin(lat * Math.PI / 180);
      return [(lng + 180) / 360 * size, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size];
    };
    const unproj = (x, y, z) => {
      const size = 256 * Math.pow(2, z);
      const n = Math.PI - 2 * Math.PI * y / size;
      return [180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), x / size * 360 - 180];
    };
    const realBox = (z) => {
      const [cx, cy] = proj(CENTER.lat, CENTER.lng, z);
      const hw = 700 * 1.1; const hh = 450 * 1.1;
      const nw = unproj(cx - hw, cy - hh, z); const se = unproj(cx + hw, cy + hh, z);
      return { minLon: nw[1], maxLon: se[1], minLat: se[0], maxLat: nw[0] };
    };

    let totalJson = 0;
    let totalBin = 0;
    for (const z of [9, 10, 13, 14, 15, 16]) {
      const p = real.queryBbox({
        ...realBox(z), zoom: z, limit: LIMITS.viewportLimit,
        wayCandidates: LIMITS.wayCandidates, nodeCandidates: LIMITS.nodeCandidates, relationLimit: LIMITS.relationLimit,
        relationCropPad: LIMITS.relationCropPad, relationCropMinMembers: LIMITS.relationCropMinMembers,
        relationCropBoundaryMembers: LIMITS.relationCropBoundaryMembers,
        detail: null, lodDetail: LIMITS.lodDetail, lodRoadSend: LIMITS.roadSend,
        lodRoadClassFloor: LIMITS.roadClassFloor, minFillArea: null, lodMinFillArea: LIMITS.lodMinFillArea,
        neverSend: null, lodNeverSend: LIMITS.neverSend,
        coalesce: LIMITS.coalesce, compact: LIMITS.compact, view: null,
      });
      const bin = encodeBinaryPayload(p);
      const jsonBytes = Buffer.byteLength(JSON.stringify(p), 'utf8');
      totalJson += jsonBytes;
      totalBin += bin.length;
      const jsonCanon = canon(client.__unpack(client.__parse(JSON.stringify(p))));
      const binCanon = canon(client.__unpack(client.__decBin(new Uint8Array(bin))));
      const same = jsonCanon === binCanon;
      check(`z${z}：BIN 解出来的载荷与 JSON 载荷逐字段相同`, same,
        same ? `bin ${(bin.length / 1024).toFixed(1)} KB < json ${(jsonBytes / 1024).toFixed(1)} KB（${(jsonBytes / bin.length).toFixed(2)}×）`
          : `首个差异 @${(() => { let i = 0; while (i < binCanon.length && i < jsonCanon.length && binCanon[i] === jsonCanon[i]) i++; return i; })()}`);
    }
    check('六档合计：二进制比紧凑 JSON 小（真实数据集）', totalBin < totalJson,
      `${(totalJson / 1024).toFixed(1)} KB → ${(totalBin / 1024).toFixed(1)} KB（${(totalJson / totalBin).toFixed(2)}×）`);
    check('真实数据集的载荷仍带完整账本（truncation.complete 为布尔）',
      typeof real.queryBbox({ ...realBox(13), zoom: 13, limit: LIMITS.viewportLimit, coalesce: LIMITS.coalesce, compact: LIMITS.compact }).truncation.complete === 'boolean');
    try { real.db.close(); } catch { /* ignore */ }
  }

  /* --------------------------------- 收尾 --------------------------------- */
  try { server.kill(); } catch { /* ignore */ }
  await sleep(200);

  console.log('\n' + '─'.repeat(64));
  console.log(`通过 ${passed} 项，失败 ${failed} 项${skipped ? `，跳过 ${skipped} 项` : ''}`);
  if (failures.length) {
    console.log('\n失败清单：');
    for (const f of failures) console.log('  · ' + f);
  }
  console.log('─'.repeat(64) + '\n');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\n套件自身出错：', err && err.stack ? err.stack : err);
  process.exit(1);
});
