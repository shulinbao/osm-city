'use strict';
/**
 * 载荷指纹（分区流式的回归量尺之一）——**只读**，不写任何库、不起服务。
 *
 * 用途：`server/osmdb.js` 的 `queryBbox` 尾部那段"打包"被抽成 `packQueryResult()`（为了让
 * `server/regions.js` 复用同一份打包代码、绝不复制第二份）——抽取前后必须证明**输出逐字节相同**。
 * 这个脚本就是那把尺子：对同一份库、同一批 (bbox, zoom) 跑 `queryBbox`，把载荷
 * `JSON.stringify` 后的 sha256 与字节数打出来，抽取前后对拍。
 *
 *   node tests/region-payload-hash.js <库路径> [--tag 标签] [--out 文件.json] [--detail 0..4]
 *
 * 视口口径与 tools/measure-payload.js 一致（1400×900 + pad 5%，中心天安门），
 * 所以同一档的字节数可以和 logs/payload-*.json 直接对照。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { OsmDB } = require('../server/osmdb');

const argv = process.argv.slice(2);
const dbFile = argv[0];
if (!dbFile) {
  console.error('用法: node tests/region-payload-hash.js <库路径> [--tag 标签] [--out 文件.json]');
  process.exit(2);
}
const argOf = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const TAG = argOf('tag') || 'payload-hash';
const OUT = argOf('out');
const DETAIL = argOf('detail') === null ? 4 : Number(argOf('detail'));
const ZOOMS = [9, 10, 11, 12, 13, 14, 15, 16];

const W = 1400;
const H = 900;
const PAD = 0.05;
const CENTER = { lat: 39.9042, lon: 116.4074 };

function bboxOf(z) {
  const mPerPx = (156543.03392 * Math.cos((CENTER.lat * Math.PI) / 180)) / Math.pow(2, z);
  const halfWM = ((W / 2) * (1 + 2 * PAD)) * mPerPx;
  const halfHM = ((H / 2) * (1 + 2 * PAD)) * mPerPx;
  const dLat = halfHM / 111320;
  const dLon = halfWM / (111320 * Math.cos((CENTER.lat * Math.PI) / 180));
  return {
    minLon: Number((CENTER.lon - dLon).toFixed(7)), maxLon: Number((CENTER.lon + dLon).toFixed(7)),
    minLat: Number((CENTER.lat - dLat).toFixed(7)), maxLat: Number((CENTER.lat + dLat).toFixed(7)),
  };
}

/** 与 server/index.js 的 /api/map 完全同一组参数（config.json 的 limits + 请求参数） */
function queryOpts(z, b) {
  return {
    ...b, zoom: z, limit: 15000,
    wayCandidates: 12, nodeCandidates: 8, relationLimit: 10000,
    relationCropPad: 0.25, relationCropMinMembers: 64, relationCropBoundaryMembers: false,
    detail: null, lodDetail: DETAIL, lodRoadSend: null, lodRoadClassFloor: null,
    minFillArea: null, lodMinFillArea: 0,
    neverSend: null, lodNeverSend: true,
    coalesce: null, compact: true, view: null, flatCaps: false,
  };
}

// 只读打开：分片库/线上库都不许被这个脚本写一个字节
const db = new OsmDB(dbFile, { readOnly: true });
const rows = [];
for (const z of ZOOMS) {
  const b = bboxOf(z);
  const t0 = Date.now();
  const payload = db.queryBbox(queryOpts(z, b));
  const ms = Date.now() - t0;
  const json = JSON.stringify(payload);
  const sha = crypto.createHash('sha256').update(json).digest('hex');
  rows.push({
    zoom: z,
    bytes: Buffer.byteLength(json),
    sha256: sha,
    ms,
    ways: payload.ways ? Object.keys(payload.ways).length : null,
    nodes: payload.nodePack ? payload.nodePack.ids.length : null,
    displayLines: payload.displayLines ? payload.displayLines.length : null,
    displayAreas: payload.displayAreas ? payload.displayAreas.length : null,
    complete: payload.truncation ? payload.truncation.complete : null,
  });
  console.log(`z${String(z).padStart(2)}  ${String(Buffer.byteLength(json)).padStart(9)} B  ${sha.slice(0, 16)}  `
    + `ways=${rows[rows.length - 1].ways} nodes=${rows[rows.length - 1].nodes} `
    + `lines=${rows[rows.length - 1].displayLines} areas=${rows[rows.length - 1].displayAreas} `
    + `complete=${rows[rows.length - 1].complete} ${ms} ms`);
}
const out = { tag: TAG, at: new Date().toISOString(), db: dbFile, viewport: { W, H, PAD }, center: CENTER, detail: DETAIL, rows };
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('写入 ' + path.relative(path.join(__dirname, '..'), OUT));
}
db.close();
