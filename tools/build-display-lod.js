'use strict';
/**
 * ==================== 烘焙「预计算低缩放显示图层」（display_lod） ====================
 *
 *   node tools/build-display-lod.js --db data/osm/osm.sqlite
 *   node tools/build-display-lod.js --db <副本> --bands 10,11,12 --tiles 6
 *   node tools/build-display-lod.js --db <副本> --rebuild            # 忽略已有结果，整层重烘
 *   node tools/build-display-lod.js --db <副本> --only 10:31,10:32   # 只重算指定 (band, 瓦片)
 *   node tools/build-display-lod.js --db <副本> --check              # 只看现状（不写库）
 *
 * ## 它干什么
 *
 * 在**每一块瓦片**上跑一次库里真实的 `OsmDB.queryBbox`（`_dlodBakeTile`），把合并好的
 * `displayLines` / `displayAreas` 与"这块瓦片里每个候选 way 去了哪"落进 `display_lod` /
 * `display_lod_cov` 两张表。规则、几何语义、瓦片取舍、DP 容差为什么按 band 固定 ——
 * 全在 `server/displaylod.js` 的文件头那一段（含实测数字）。
 *
 * ## 为什么要有这个独立入口（而不是只靠服务端启动时自动补建）
 *
 * 服务端也有自动补建（`initTransitWorld()` 里的 `displayLod` 阶段，切片跑、进度进 `/api/ready`），
 * 但**构建机上烘一次、装进种子库**永远比让 1 GB 的 VPS 现场烘划算：
 *   · 实测（真实北京库，36 块 × z8~z14）**约 17 秒、+12.5 MB**（`logs/pc-build-tile6.txt`）；
 *   · 种子链里这一步在**导入之后、起临时服务器之前**跑，于是种子库出厂就带这一层，
 *     用户那边首次启动一行都不用烘（`deploy/build-seed.sh` 的 [3.5/6] 那一步）。
 *
 * ## 退出码
 *   0 成功（含"已是最新，跳过"）· 1 参数/环境错 · 2 库打不开或没有 way · 3 烘焙中有瓦片失败
 */
const fs = require('node:fs');
const path = require('node:path');
const { OsmDB } = require('../server/osmdb');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes('--' + name);

if (has('help') || has('h')) {
  console.log('用法: node tools/build-display-lod.js [--db FILE] [--config FILE] [--bands 8,9,…,14]');
  console.log('       [--tiles N] [--only z:tile,…] [--rebuild] [--check] [--report FILE]');
  process.exit(0);
}

const CONFIG_FILE = path.resolve(argOf('config', path.join(ROOT, 'config.json')));
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (err) {
  console.error('[dlod] 读不到 config：' + CONFIG_FILE + '（' + err.message + '）');
  process.exit(1);
}
const LIMITS = config.limits || {};
const DB = path.resolve(argOf('db', config.osmDb || path.join(ROOT, 'data/osm/osm.sqlite')));
const REPORT = path.resolve(argOf('report', path.join(ROOT, 'logs', 'build-display-lod.json')));
const BANDS = argOf('bands', null);
const TILES = argOf('tiles', null);
const ONLY = argOf('only', null);
const CHECK = has('check');
const REBUILD = has('rebuild');

if (!fs.existsSync(DB)) { console.error('[dlod] 库不存在：' + DB); process.exit(2); }

/** 与 server/index.js 完全同一份 displayLod 选项（`limits` 一并带上，烘焙查询参数从它取） */
const dlodRaw = Object.assign({}, LIMITS.displayLod || {}, { limits: LIMITS });
if (TILES) dlodRaw.tiles = Number(TILES);
if (BANDS) dlodRaw.bands = String(BANDS).split(',').map(Number);

const t0 = Date.now();
const db = new OsmDB(DB, { displayLod: dlodRaw, displayLodLog: (m) => console.log(m) });
const opts = db._dlodOpts();
const before = db.displayLodInfo();

console.log(`[dlod] 库 = ${DB}`);
console.log(`[dlod] 瓦片 = ${opts.tiles}×${opts.tiles} · band = ${opts.bands.join(',')}`
  + ` · 切片让出粒度 = ${opts.sliceMs} ms（片 = 一个 (band, 瓦片)）`);
/**
 * **顺手把 `ways.geom`（物化几何）烘进库**（见 server/osmdb.js 的 packWayGeom 那一大段）：
 * 这一步是构建期该干的活（真库整表实测 50~58 秒、21.9 MB），所以种子库出厂就带它，
 * 用户那边首次启动一行都不用补（服务端启动阶段**不会**做这件事，见 limits.wayGeom.autoBackfill）。
 */
if (db._wayGeomOpts && db._wayGeomOpts().on && db._wayGeomReady === false) {
  const t = Date.now();
  const r = db.backfillWayGeomSync();
  const st = db.db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(geom)) AS b FROM ways WHERE geom IS NOT NULL').get();
  console.log(`[dlod] ways.geom 回填：${r.done} 条 way · ${((Date.now() - t) / 1000).toFixed(1)} s`
    + ` · ${st.n} 行 / ${(st.b / 1e6).toFixed(1)} MB（平均 ${st.n ? (st.b / st.n).toFixed(0) : 0} B/条）`);
} else if (db._wayGeomOpts && db._wayGeomOpts().on) {
  console.log('[dlod] ways.geom 已经回填过（跳过）');
}
console.log(before.available
  ? `[dlod] 现有：${before.rows} 行 / ${(before.bytes / 1e6).toFixed(1)} MB · band ${Object.keys(before.bands).join(',')}`
    + ` · 脏瓦片 ${before.dirty}`
  : '[dlod] 现有：**没有这一层**（老库）');

if (CHECK) {
  const rows = db.db.prepare(`SELECT z, COUNT(*) AS lines, SUM(npts) AS pts, SUM(LENGTH(geom)) AS bytes
    FROM display_lod WHERE kind = 'line' GROUP BY z ORDER BY z`).all();
  const areas = db.db.prepare(`SELECT z, COUNT(*) AS areas FROM display_lod WHERE kind = 'area' GROUP BY z ORDER BY z`).all();
  const cov = db.db.prepare('SELECT z, COUNT(*) AS cov FROM display_lod_cov GROUP BY z ORDER BY z').all();
  const areaBy = new Map(areas.map((r) => [r.z, r.areas]));
  const covBy = new Map(cov.map((r) => [r.z, r.cov]));
  console.log('[dlod] band   折线     点      面   覆盖way   几何MB');
  for (const r of rows) {
    console.log(`[dlod] z${String(r.z).padEnd(5)} ${String(r.lines).padStart(6)} ${String(r.pts).padStart(8)}`
      + ` ${String(areaBy.get(r.z) || 0).padStart(6)} ${String(covBy.get(r.z) || 0).padStart(8)} ${(r.bytes / 1e6).toFixed(2).padStart(9)}`);
  }
  const tot = db.db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(geom)) AS b FROM display_lod').get();
  console.log(`[dlod] 合计 ${tot.n} 行 · 几何 ${((tot.b || 0) / 1e6).toFixed(1)} MB · 库文件 ${(fs.statSync(DB).size / 1e6).toFixed(1)} MB`);
  db.close();
  process.exit(0);
}

/** 已是最新就跳过（除非 --rebuild）：签名一致 + 每个 band 都建完 + 没有脏瓦片 */
const wantBands = opts.bands;
const fresh = before.available && Object.keys(before.bands).length
  && wantBands.every((z) => before.bands[z] && before.bands[z].done)
  && before.dirty === 0;
if (fresh && !REBUILD && !ONLY) {
  console.log('[dlod] ✅ 库里这一层已经是最新的（签名一致、band 齐全、无脏瓦片）—— 什么都不用做');
  console.log('[dlod]    要强制重烘：加 --rebuild');
  db.close();
  process.exit(0);
}

const only = ONLY
  ? new Set(String(ONLY).split(',').map((s) => s.trim()).filter(Boolean))
  : null;

console.log(`[dlod] 开始烘焙：${only ? only.size + ' 块（--only）' : wantBands.length + ' 个 band × ' + opts.tiles * opts.tiles + ' 块'}`);
let lastBand = -1;
const rep = db.buildDisplayLod({
  only,
  log: (m) => console.log(m),
  onProgress: () => { /* 每块都回调太吵：band 级别的汇报在下面 buildDisplayLod 的 perBand 里 */ },
});
for (const z of Object.keys(rep.perBand).map(Number).sort((a, b) => a - b)) {
  const b = rep.perBand[z];
  if (z !== lastBand) lastBand = z;
  console.log(`[dlod] z${String(z).padEnd(3)} ${String(b.tiles).padStart(3)} 块 · ${String(b.ms).padStart(6)} ms`
    + ` · 折线 ${String(b.lines).padStart(5)} · 面 ${String(b.areas).padStart(4)} · 覆盖 way ${String(b.cov).padStart(6)}`
    + ` · 几何 ${(b.bytes / 1e6).toFixed(2)} MB · 最长一块 ${b.maxTileMs} ms`);
}
const after = db.displayLodInfo();
console.log(`[dlod] 合计：${rep.done} 块成功 / ${rep.failed} 块失败 · ${((Date.now() - t0) / 1000).toFixed(1)} s`
  + ` · 最长一块 ${rep.maxTileMs} ms · 几何合计 ${(rep.bytes / 1e6).toFixed(1)} MB`);
console.log(`[dlod] 库文件 ${(fs.statSync(DB).size / 1e6).toFixed(1)} MB`
  + (after.extent ? ` · 数据范围 ${after.extent.minLon.toFixed(4)},${after.extent.minLat.toFixed(4)} → ${after.extent.maxLon.toFixed(4)},${after.extent.maxLat.toFixed(4)}` : ''));

const out = {
  tool: 'tools/build-display-lod.js', at: new Date().toISOString(), db: DB, node: process.version,
  tiles: opts.tiles, bands: wantBands, only: only ? [...only] : null, rebuild: REBUILD,
  dbBytesBefore: before.available ? null : null,
  ms: Date.now() - t0, done: rep.done, failed: rep.failed, maxTileMs: rep.maxTileMs,
  lines: rep.lines, areas: rep.areas, cov: rep.cov, geomBytes: rep.bytes,
  perBand: rep.perBand, state: after,
};
try {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { prev = {}; }
  fs.writeFileSync(REPORT, JSON.stringify({ ...prev, last: out }, null, 2));
  console.log('[dlod] 报告：' + REPORT);
} catch (err) { console.warn('[dlod] 报告写不出去（不影响结果）：' + err.message); }

db.close();
process.exit(rep.failed ? 3 : 0);
