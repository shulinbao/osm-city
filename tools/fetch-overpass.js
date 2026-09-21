'use strict';
/**
 * Overpass API 取数器（零第三方依赖，只用 Node 内置模块）
 *
 * 用途：把某个经纬度框内的 OSM 数据（OSM XML）直接下载成 `.osm.gz`，
 * 交给 `tools/import-osm.js` 导入 —— 因为导入器只吃 OSM XML，不吃 `.osm.pbf`，
 * 而本机没有 osmconvert / osmium 这类转换工具，Overpass 是唯一不需要外部工具的
 * "按范围取 OSM XML" 途径。
 *
 * 用法：
 *   node tools/fetch-overpass.js --bbox <minLat,minLon,maxLat,maxLon> --out <path.osm.gz>
 *                               [--timeout 900] [--count] [--no-relations] [--rounds 4]
 *                               [--endpoint URL] [--quiet]
 *
 * 取数口径（**关键**，决定导入后几何是否完整）：
 *   1) `node(bbox)` + `way(bbox)`：way 只要有一个节点在框里就算选中；
 *   2) `>`（recurse down）把**这些 way 的全部节点**补进来 —— 于是落在框外的节点也在，
 *      way 的坐标序列完整，导入器的 bbox / length 回填才有意义；
 *   3) **relation 单独 out，不做递归**。若对 relation 也 `>`，Overpass 会把成员的 way
 *      连同其全部节点一并吐出来：一条省级行政边界 relation 就能把整个河北省拉下来，
 *      几百 MB 起步。所以 relation 只取自身与成员引用，不做几何展开 ——
 *      代价是 relation 的 bbox 可能因为成员 way 不在库里而算不出来（不参与渲染）。
 *   4) `out meta` 带 version / timestamp / uid / user —— 导入器要用它们填 editor / ts。
 *
 * 公共实例经常返回 504 "server is probably too busy"（实测 overpass-api.de 与
 * overpass.kumi.systems 都会），这是**瞬时**状态。所以本工具在多个端点之间轮换并重试
 * （--rounds 轮，轮间退避），只有全部轮次都失败才放弃。取数是一次性长请求（几分钟），
 * 中途失败会整份重来 —— 因此宁可一次成功，也不要半份数据。
 *
 * --count 只发一条 `out count` 查询（JSON，几百字节），拿到框内元素个数而不下载数据，
 * 用来在真下载前估算体积与耗时。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * 端点池。实测（2026 年，本机）：
 *   overpass-api.de        经常 504 "too busy"，但状态好时最快
 *   overpass.private.coffee 本次测量可用，返回 200（但查询偏慢，226s 才出 count）
 *   overpass.kumi.systems   本次测量 504
 * 一律轮换重试，不把可用性绑在单一实例上。
 */
const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "minLat,minLon,maxLat,maxLon" → 校验后的 bbox */
function parseBbox(spec) {
  const parts = String(spec).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error('--bbox 需要 4 个数字：minLat,minLon,maxLat,maxLon（例如 37.95,114.40,38.15,114.65）');
  }
  const [minLat, minLon, maxLat, maxLon] = parts;
  if (minLat >= maxLat || minLon >= maxLon) throw new Error('--bbox 的 min 必须小于 max');
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) throw new Error('--bbox 超出经纬度范围');
  return { minLat, minLon, maxLat, maxLon };
}

/** Overpass 的 bbox 字面量顺序是 (south,west,north,east) */
function bboxLiteral(b) {
  return `(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})`;
}

/** 框内面积（km²，等距圆柱近似，只用于估算体积/耗时） */
function bboxAreaKm2(b) {
  const midLat = (b.minLat + b.maxLat) / 2;
  const h = (b.maxLat - b.minLat) * 111.32;
  const w = (b.maxLon - b.minLon) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  return Math.abs(h * w);
}

/** 只数元素：JSON 输出的 `out count` 只有几百字节（含递归后的 way 节点） */
function buildCountQuery(bbox) {
  const box = bboxLiteral(bbox);
  return [
    '[out:json][timeout:300];',
    '(',
    `  node${box};`,
    `  way${box};`,
    ');',
    '(._;>;);',
    'out count;',
  ].join('\n');
}

/** 取数查询：node + way + way 的全部节点（递归），relation 单独 out 但不递归 */
function buildDataQuery(bbox, timeoutS, withRelations) {
  const box = bboxLiteral(bbox);
  const lines = [
    `[out:xml][timeout:${timeoutS}];`,
    '(',
    `  node${box};`,
    `  way${box};`,
    ');',
    '(._;>;);',
    'out meta;',
  ];
  if (withRelations) lines.push(`relation${box};`, 'out meta;');
  return lines.join('\n');
}

/** Overpass 的报错正文（HTML）里认出"可重试"的瞬时故障 */
function isRetryable(status, body) {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (status !== 200 && /too busy|rate_limited|Dispatcher_Client|Timeout|timed out/i.test(String(body || ''))) return true;
  return false;
}

/** 临时错误：带 retryable 标记，供轮换重试判断 */
class RetryableError extends Error {
  constructor(msg, status) { super(msg); this.retryable = true; this.status = status; }
}

/**
 * POST 一条 Overpass QL。
 *
 * **约定：promise 只在响应结束时 resolve**，返回 `{ status, headers, errorBody }`。
 * 200 的正文通过 `onData` 回调流出去（不在内存里攒），非 200 只收前几 KB 当错误信息。
 *
 * 之所以不用"响应一到就 resolve({status})、正文另走事件"的写法：那样调用方拿 status
 * 的时机和正文事件的派发顺序会**竞态** —— 实测小响应（几百字节的 out count）会先跑完
 * 'end' 再轮到 `.then`，于是一次成功的 200 被读成"status 未知"而误判失败（白等一轮退避）。
 * 把 status 和结束放进同一个 resolve 里，竞态就不存在了。
 */
function postQuery(endpoint, query, { timeoutMs, onData, errorBodyLimit = 8192 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const mod = url.protocol === 'http:' ? http : https;
    const body = 'data=' + encodeURIComponent(query);
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'osm-city-online/2.0 (tools/fetch-overpass.js; node ' + process.version + ')',
        Accept: '*/*',
      },
    }, (res) => {
      const status = res.statusCode;
      const errChunks = [];
      let errBytes = 0;
      res.on('data', (chunk) => {
        if (status === 200) {
          if (onData) onData(chunk);
        } else if (errBytes < errorBodyLimit) {
          errChunks.push(chunk);
          errBytes += chunk.length;
        }
      });
      res.on('end', () => resolve({
        status,
        headers: res.headers,
        errorBody: Buffer.concat(errChunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('客户端等待超时（' + Math.round(timeoutMs / 1000) + 's）')));
    req.write(body);
    req.end();
  });
}

/** 把一次非 200 响应变成异常：瞬时故障打 retryable 标记，其余直接给出正文 */
function httpError(status, errorBody) {
  const flat = String(errorBody || '').replace(/\s+/g, ' ').trim();
  if (isRetryable(status, errorBody)) {
    return new RetryableError('HTTP ' + status + (/too busy/i.test(flat) ? '（Overpass 忙）' : '（限流/瞬时错误）'), status);
  }
  const detail = /<strong[^>]*>Error<\/strong>:\s*([^<]+)/i.exec(flat);
  return new Error('HTTP ' + status + '：' + (detail ? detail[1].trim() : flat.slice(0, 200)));
}

/** 收完整响应为文本（给 --count 用）；非 200 抛 httpError */
async function fetchText(endpoint, query, timeoutMs) {
  const chunks = [];
  const { status, errorBody } = await postQuery(endpoint, query, { timeoutMs, onData: (c) => chunks.push(c) });
  if (status !== 200) throw httpError(status, errorBody);
  return Buffer.concat(chunks).toString('utf8');
}

/** 从 `out count` 的 JSON 里读计数（elements[0].tags） */
function parseCount(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('out count 返回的不是 JSON：' + String(text).slice(0, 200));
  }
  const el = (doc.elements || []).find((e) => e && e.type === 'count');
  const tags = (el && el.tags) || {};
  const num = (k) => (tags[k] === undefined ? null : Number(tags[k]));
  return { nodes: num('nodes'), ways: num('ways'), relations: num('relations'), total: num('total') };
}

/**
 * 在端点池上轮换重试直到成功。
 * @param {(endpoint:string)=>Promise<any>} attempt
 * @param {{endpoints:string[], rounds:number, log:Function, label:string}} opts
 */
async function withRetry(attempt, opts) {
  const { endpoints, rounds, log, label } = opts;
  let lastErr = null;
  for (let round = 0; round < rounds; round++) {
    for (const endpoint of endpoints) {
      try {
        return await attempt(endpoint);
      } catch (err) {
        lastErr = err;
        const retryable = err && err.retryable !== false;
        log(`· [${label}] ${endpoint.replace(/^https?:\/\//, '')} 失败：${err.message}${retryable ? '（可重试）' : ''}`);
        if (!retryable) throw err;
      }
    }
    if (round < rounds - 1) {
      const wait = 20000 * (round + 1);
      log(`· [${label}] 第 ${round + 1}/${rounds} 轮全部失败，${Math.round(wait / 1000)}s 后重试 …`);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(label + ' 失败');
}

/** 统计框内元素个数（不下载数据） */
async function countOverpass(options) {
  const endpoints = options.endpoint ? [options.endpoint] : DEFAULT_ENDPOINTS;
  const query = buildCountQuery(options.bbox);
  const t0 = Date.now();
  const r = await withRetry(async (endpoint) => {
    const text = await fetchText(endpoint, query, 360000);
    return { counts: parseCount(text), endpoint };
  }, { endpoints, rounds: options.rounds || 4, log: options.log || (() => {}), label: 'count' });
  return { ...r, query, ms: Date.now() - t0 };
}

/**
 * 下载 bbox 内的 OSM XML，直接 gzip 落盘（不在内存里攒整份数据）。
 * 一个端点的尝试中途失败会**整份重来**，不会把半份数据当成功。
 */
async function fetchOverpass(options) {
  const bbox = options.bbox;
  const out = options.out;
  const timeoutS = options.timeout || 900;
  const withRelations = options.relations !== false;
  const quiet = !!options.quiet;
  const log = quiet ? () => {} : (m) => process.stdout.write(m + '\n');
  const endpoints = options.endpoint ? [options.endpoint] : DEFAULT_ENDPOINTS;
  const query = buildDataQuery(bbox, timeoutS, withRelations);

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

  let attemptNo = 0;
  const r = await withRetry(async (endpoint) => {
    attemptNo++;
    const tmp = out + '.part' + attemptNo;
    const gzip = zlib.createGzip({ level: 6 });
    const ws = fs.createWriteStream(tmp);
    gzip.pipe(ws);
    const t0 = Date.now();
    let bytes = 0;
    let lastLog = Date.now();
    /**
     * 完整性核对。Overpass 在"查询超时 / 被 maxsize 截断 / 内部错误"时会返回
     * **HTTP 200 + 一段 `<remark>`**，正文里的数据是**残缺**的 —— 只看状态码会把半份数据
     * 当成成功导入，而且导入器不会报错（SAX 解析器遇到 `</osm>` 缺失只会打一行"可能被截断"，
     * 或干脆连那行都没有）。所以在流里顺带扫 `<remark>`，并记下收尾字节核对 `</osm>` 是否闭合。
     */
    const remarks = [];
    let scanCarry = Buffer.alloc(0);
    let tailBuf = Buffer.alloc(0);
    try {
      const { status, headers, errorBody } = await postQuery(endpoint, query, {
        timeoutMs: (timeoutS + 180) * 1000,
        onData: (chunk) => {
          bytes += chunk.length;
          gzip.write(chunk);
          // 用 Buffer 直接找 ASCII 特征串，避免按字节切坏多字节字符
          const hay = scanCarry.length ? Buffer.concat([scanCarry, chunk]) : chunk;
          let idx = hay.indexOf('<remark');
          while (idx !== -1) {
            const end = hay.indexOf(62 /* > */, idx);
            remarks.push(hay.subarray(idx, end === -1 ? Math.min(hay.length, idx + 300) : end + 1)
              .toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300));
            idx = hay.indexOf('<remark', idx + 7);
          }
          scanCarry = hay.subarray(Math.max(0, hay.length - 8));
          tailBuf = hay.subarray(Math.max(0, hay.length - 16));
          if (!quiet && Date.now() - lastLog > 10000) {
            lastLog = Date.now();
            log(`· 已接收 ${formatBytes(bytes)}（${((Date.now() - t0) / 1000).toFixed(0)}s）…`);
          }
        },
      });
      if (status !== 200) throw httpError(status, errorBody);
      if (!/xml|text/i.test(String(headers['content-type'] || 'xml'))) {
        throw new Error('返回了非 XML 内容：' + headers['content-type']);
      }
      if (remarks.length && !options.allowRemark) {
        throw new RetryableError('Overpass 报告 <remark>（数据可能被截断）：' + remarks[0], 200);
      }
      if (!bytes || !tailBuf.toString('utf8').includes('</osm>')) {
        throw new RetryableError('响应没有以 </osm> 收尾（疑似截断，只收到 ' + formatBytes(bytes) + '）', 200);
      }
      gzip.end();
      await new Promise((resolve, reject) => {
        if (ws.writableFinished) return resolve();
        ws.on('finish', resolve);
        ws.on('error', reject);
        gzip.on('error', reject);
      });
      if (failed) throw failed;
      fs.renameSync(tmp, out);
      return { file: out, bytes, compressed: fs.statSync(out).size, ms: Date.now() - t0, endpoint };
    } catch (err) {
      try { gzip.destroy(); } catch { /* ignore */ }
      await new Promise((res) => { if (ws.closed) res(); else { ws.on('close', res); ws.close(); } });
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }, { endpoints, rounds: options.rounds || 4, log, label: 'fetch' });

  return { ...r, query };
}

const USAGE = [
  '用法：node tools/fetch-overpass.js --bbox <minLat,minLon,maxLat,maxLon> --out <path.osm.gz> [选项]',
  '  --bbox         经纬度框，顺序 minLat,minLon,maxLat,maxLon（Overpass 的 S,W,N,E）',
  '  --out          输出文件（.osm.gz）',
  '  --count        只查询元素个数，不下载数据',
  '  --no-relations 不取 relation（默认取 relation 但不递归成员）',
  '  --timeout N    Overpass 侧超时秒数（默认 900）',
  '  --rounds N     端点池全部失败的轮换轮数（默认 4）',
  '  --allow-remark 忽略 Overpass 的 <remark> 警告（默认：有 remark 就换端点重取，因为数据可能残缺）',
  '  --endpoint URL 只用指定端点（默认在 3 个公共实例间轮换）',
  '  --quiet        只打印结果',
].join('\n');

function parseArgs(argv) {
  const out = { bbox: null, out: null, count: false, relations: true, timeout: 900, rounds: 4, endpoint: null, quiet: false, help: false, allowRemark: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const take = () => { if (inline !== null) return inline; i++; if (i >= argv.length) throw new Error('参数 ' + key + ' 缺少取值'); return argv[i]; };
    switch (key) {
      case '--bbox': out.bbox = take(); break;
      case '--out': out.out = take(); break;
      case '--count': out.count = true; break;
      case '--no-relations': out.relations = false; break;
      case '--timeout': out.timeout = Number(take()); break;
      case '--rounds': out.rounds = Number(take()); break;
      case '--allow-remark': out.allowRemark = true; break;
      case '--endpoint': out.endpoint = take(); break;
      case '--quiet': case '-q': out.quiet = true; break;
      case '--help': case '-h': out.help = true; break;
      default: if (key.startsWith('-')) throw new Error('未知参数：' + key); break;
    }
  }
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) {
    process.stderr.write('参数错误：' + err.message + '\n' + USAGE + '\n');
    process.exitCode = 1;
    return;
  }
  if (args.help || !args.bbox || (!args.out && !args.count)) {
    process.stdout.write(USAGE + '\n');
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  let bbox;
  try { bbox = parseBbox(args.bbox); } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exitCode = 1;
    return;
  }
  const area = bboxAreaKm2(bbox);
  const log = args.quiet ? () => {} : (m) => process.stdout.write(m + '\n');

  if (args.count) {
    log(`· 统计 ${args.bbox}（约 ${area.toFixed(0)} km²）…`);
    try {
      const r = await countOverpass({ bbox, rounds: args.rounds, endpoint: args.endpoint, log });
      process.stdout.write(JSON.stringify({
        bbox: args.bbox, areaKm2: Math.round(area), ...r.counts,
        ms: r.ms, endpoint: r.endpoint,
      }, null, 2) + '\n');
    } catch (err) {
      process.stderr.write('统计失败：' + (err && err.message ? err.message : String(err)) + '\n');
      process.exitCode = 1;
    }
    return;
  }

  try {
    const r = await fetchOverpass({ bbox, out: args.out, timeout: args.timeout, relations: args.relations, quiet: args.quiet, endpoint: args.endpoint, rounds: args.rounds, allowRemark: args.allowRemark });
    process.stdout.write([
      '',
      '===== Overpass 取数结果 =====',
      `范围      : ${args.bbox}（约 ${area.toFixed(0)} km²）`,
      `输出      : ${path.resolve(r.file)}`,
      `XML 体积  : ${formatBytes(r.bytes)}（gzip 后 ${formatBytes(r.compressed)}）`,
      `耗时      : ${(r.ms / 1000).toFixed(1)}s`,
      `端点      : ${r.endpoint}`,
      '=============================',
    ].join('\n') + '\n');
  } catch (err) {
    process.stderr.write('取数失败：' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  fetchOverpass, countOverpass, parseBbox, parseCount, buildDataQuery, buildCountQuery,
  bboxAreaKm2, formatBytes, DEFAULT_ENDPOINTS, withRetry, isRetryable,
};
