'use strict';
/**
 * 视口载荷体积基线测量（改动前 / 改动后都用它，保证口径一致）。
 *
 * 口径：1400×900 视口 + 每边 5% pad（与客户端 mapdata.js 一致），
 * 中心取天安门；逐个缩放测**原始未压缩字节**（Accept-Encoding: identity）与
 * **gzip 后字节**（手工数 socket 上的原始字节，因为 fetch 会自动解压）。
 *
 *   node logs/measure-payload.js [标签]
 * 结果追加写入 logs/payload-<标签>.json，方便前后对照。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const W = 1400;
const H = 900;
const PAD = 0.05;
const CENTER = { lat: 39.9042, lon: 116.4074 };
const ZOOMS = [4, 9, 10, 11, 12, 13, 14, 15, 16];
const TAG = process.argv[2] || 'baseline';
/** 可选：--fmt=bin / --fmt=json —— 用来测二进制载荷与 JSON 载荷的体积差 */
const FMT = (process.argv.find((a) => a.startsWith('--fmt=')) || '').slice(6);

/**
 * `--diff A.json B.json`：把两次测量结果并排打出来（改动前 vs 改动后）。
 * 这是验收用的：① 二进制编码 与 ② 结构摊平 各自省了多少，一眼能看出来。
 */
if (process.argv.includes('--diff')) {
  const [fa, fb] = process.argv.slice(process.argv.indexOf('--diff') + 1);
  if (!fa || !fb) { console.error('用法: node logs/measure-payload.js --diff A.json B.json'); process.exit(1); }
  const A = JSON.parse(fs.readFileSync(fa, 'utf8'));
  const B = JSON.parse(fs.readFileSync(fb, 'utf8'));
  const byZ = (o) => new Map(o.rows.map((r) => [r.zoom, r]));
  const ma = byZ(A), mb = byZ(B);
  const kb = (n) => (n == null ? '—' : (n / 1024).toFixed(1));
  console.log(`对照：${A.tag}  →  ${B.tag}    （口径 1400×900 pad 5%，中心天安门）\n`);
  console.log('缩放 |        未压缩 KB        |       真实传输(gzip) KB     | 降幅(未压缩 / 传输)');
  console.log('     |   前      后      降幅  |   前       后       降幅   |');
  for (const z of A.rows.map((r) => r.zoom)) {
    const a = ma.get(z), b = mb.get(z);
    if (!a || !b) continue;
    const dRaw = ((a.rawBytes - b.rawBytes) / a.rawBytes) * 100;
    const dGz = ((a.gzipBytes - b.gzipBytes) / a.gzipBytes) * 100;
    console.log(
      `z${String(z).padStart(2)}  |`
      + `${kb(a.rawBytes).padStart(8)} ${kb(b.rawBytes).padStart(8)} ${(dRaw.toFixed(1) + '%').padStart(7)} |`
      + `${kb(a.gzipBytes).padStart(8)} ${kb(b.gzipBytes).padStart(8)} ${(dGz.toFixed(1) + '%').padStart(7)} |`,
    );
  }
  console.log('\n（"真实传输"那两列才是在用户链路上省下来的量；未压缩那两列只用于说明编码效率。）');
  process.exit(0);
}

/** 数 socket 上的原始字节（可指定是否 gzip），用来量"实际传输体积" */
function rawBytes(pathname, token, gzip) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        'Accept-Encoding': gzip ? 'gzip' : 'identity',
      },
    }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, enc: res.headers['content-encoding'] || 'none' }));
    });
    req.on('error', reject);
    req.end();
  });
}

const bboxOf = (z) => {
  /**
   * ⚠ 这里曾经有个真 bug（被编码战线的复核抓到）：把 1400×900 的**高度**也按 770 px 算了，
   * 于是每档测的都是**正方形框**、面积是真视口的 **1.56 倍** —— 绝对值全被放大，
   * "哪个缩放最肥"的排序也可能失真。现在按真视口分别算宽/高：
   *   宽 = 1400 px、高 = 900 px，各自再乘 (1 + 2×pad) 作为外扩后的总尺寸。
   * 比例类结论（before/after 降幅）不受这个 bug 影响，但绝对值必须以修正后的为准。
   */
  const mPerPx = (156543.03392 * Math.cos((CENTER.lat * Math.PI) / 180)) / Math.pow(2, z);
  const halfWM = ((W / 2) * (1 + 2 * PAD)) * mPerPx;   // 半个宽度（米）
  const halfHM = ((H / 2) * (1 + 2 * PAD)) * mPerPx;   // 半个高度（米）
  const dLat = halfHM / 111320;
  const dLon = halfWM / (111320 * Math.cos((CENTER.lat * Math.PI) / 180));
  return {
    minLon: (CENTER.lon - dLon).toFixed(7), maxLon: (CENTER.lon + dLon).toFixed(7),
    minLat: (CENTER.lat - dLat).toFixed(7), maxLat: (CENTER.lat + dLat).toFixed(7),
  };
};

(async () => {
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'admin', password: 'admin' }),
  });
  const { token } = await login.json();
  if (!token) throw new Error('登录失败');

  const rows = [];
  for (const z of ZOOMS) {
    const b = bboxOf(z);
    const qs = `minLon=${b.minLon}&minLat=${b.minLat}&maxLon=${b.maxLon}&maxLat=${b.maxLat}&zoom=${z}`
      // ⚠ 这里曾经是个死代码：FMT 解析了却从没拼进 URL（被编码战线复核抓到）。
      // 现在 `--fmt=bin` 真的会带上去，量二进制载荷时不用再另写脚本。
      + (FMT ? `&fmt=${encodeURIComponent(FMT)}` : '');
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/map?${qs}&token=${encodeURIComponent(token)}`, {
      headers: { 'Accept-Encoding': 'identity' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    let j = null;
    try { j = JSON.parse(buf.toString('utf8')); } catch { /* 非 JSON（二进制载荷）时只记字节数 */ }
    const gz = await rawBytes(`/api/map?${qs}&token=${encodeURIComponent(token)}`, token, true);
    const np = j && j.nodePack ? (j.nodePack.ids || []).length : (j && j.nodes ? Object.keys(j.nodes).length : null);
    rows.push({
      zoom: z,
      rawBytes: buf.length,
      gzipBytes: gz.bytes,
      gzipApplied: gz.enc,
      ms,
      ways: j && j.ways ? Object.keys(j.ways).length : null,
      nodes: np,
      displayLines: j && j.displayLines ? j.displayLines.length : null,
      displayAreas: j && j.displayAreas ? j.displayAreas.length : null,
      truncation: j ? (j.truncation || null) : 'non-json',
    });
    console.log(`z${String(z).padStart(2)}  原始 ${String((buf.length / 1024).toFixed(1)).padStart(8)} KB  `
      + `gzip ${String((gz.bytes / 1024).toFixed(1)).padStart(8)} KB (${gz.enc})  ${String(ms).padStart(5)} ms  `
      + `ways=${rows[rows.length - 1].ways}  nodePack=${np}  displayLines=${rows[rows.length - 1].displayLines}  `
      + `areas=${rows[rows.length - 1].displayAreas}`);
  }
  const out = { tag: TAG, at: new Date().toISOString(), port: PORT, viewport: { W, H, PAD }, center: CENTER, rows };
  const file = path.join(__dirname, '..', 'logs', `payload-${TAG}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\n写入 ' + file);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
