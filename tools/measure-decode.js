'use strict';
/**
 * 客户端**解码耗时**基线（改动前 / 改动后都用它，口径一致）。
 *
 * 为什么要有它：目标里点名要"解码耗时"。而"改动前"的客户端只能**在客户端被改之前**
 * 测得到 —— 与字节基线同一个道理，所以这份必须在窗口内先抓下来。
 *
 * 做法：不在 Node 里另写一份解码器（那测的不是真东西），而是用项目自带的
 * `tests/client-vm.js` 把**真实的 public/js/** 加载进 Node VM，然后在沙箱里
 * 直接调用客户端的解码入口 `World.unpackPayload(payload)` 并计时。
 * 这正是浏览器里跑的那份代码（render.js 只被打了桩，解码路径不受影响）。
 *
 *   node logs/measure-decode.js [标签] [端口]
 * 结果写入 logs/decode-<标签>.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { makeClient } = require('../tests/client-vm.js');

const TAG = process.argv[2] || 'baseline';
const PORT = Number(process.argv[3] || process.env.PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const W = 1400;
const H = 900;
const PAD = 0.05;
const CENTER = { lat: 39.9042, lon: 116.4074 };
const ZOOMS = [9, 10, 13, 14, 15, 16];
const REPEAT = 20;

const bboxOf = (z) => {
  // ⚠ 与 tools/measure-payload.js 同一个坑：**宽和高要分别算**，不能都按宽度那半边算 ——
  // 否则测的是"1400×1400 当量"的正方形区域，绝对值偏大（z11~z16 实测偏大 16%~30%）。
  const mPerPx = (156543.03392 * Math.cos((CENTER.lat * Math.PI) / 180)) / Math.pow(2, z);
  const halfWM = ((W / 2) * (1 + 2 * PAD)) * mPerPx;
  const halfHM = ((H / 2) * (1 + 2 * PAD)) * mPerPx;
  const dLat = halfHM / 111320;
  const dLon = halfWM / (111320 * Math.cos((CENTER.lat * Math.PI) / 180));
  return `minLon=${(CENTER.lon - dLon).toFixed(7)}&minLat=${(CENTER.lat - dLat).toFixed(7)}`
    + `&maxLon=${(CENTER.lon + dLon).toFixed(7)}&maxLat=${(CENTER.lat + dLat).toFixed(7)}&zoom=${z}`;
};

(async () => {
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'admin', password: 'admin' }),
  });
  const { token } = await login.json();
  if (!token) throw new Error('登录失败');

  const client = makeClient({ base: BASE, token });
  const rows = [];
  console.log(`标签 ${TAG}（端口 ${PORT}）· 每档解码 ${REPEAT} 次取平均\n`);
  console.log('缩放   解码 ms/次   载荷 KB   条目数');
  for (const z of ZOOMS) {
    const url = `/api/map?${bboxOf(z)}&token=${encodeURIComponent(token)}`;
    /**
     * ⚠ 坑（第一版就在这里栽了）：`World.unpackPayload` 是**原地解码** —— 第一次调用把
     * 打包的增量数组换成坐标数组，之后再调就是空转。所以"同一份载荷解码 N 次取平均"
     * 得到的是 0.00 ms，纯属测错。
     * 正确做法：每轮**重新取一份新鲜载荷**（取数不计时），只给"这一次解码"计时；
     * 并且自证解码真的干了活（调用前后结构必须变化），否则宁可报错也不报 0。
     */
    const code = `(async () => {
      const ms = [];
      let bytes = 0, lines = 0, areas = 0, ways = 0, enc = null;
      let worked = false;
      for (let round = 0; round < ${REPEAT}; round++) {
        const payload = await __fetchJSON(${JSON.stringify(url)});
        if (!window.G.World || typeof window.G.World.unpackPayload !== 'function') return { err: 'no unpackPayload' };
        if (round === 0) {
          bytes = (await (await fetch(${JSON.stringify(url)}, { headers: { 'Accept-Encoding': 'identity' } })).arrayBuffer()).byteLength;
          lines = payload.displayLines ? payload.displayLines.length : 0;
          areas = payload.displayAreas ? payload.displayAreas.length : 0;
          ways = payload.ways ? Object.keys(payload.ways).length : 0;
          enc = payload.enc ? JSON.stringify(payload.enc).slice(0, 120) : null;
        }
        const probe = payload.displayLines && payload.displayLines[0] ? payload.displayLines[0].coords : null;
        const before = probe && Array.isArray(probe) ? probe.length : -1;
        const t0 = performance.now();
        window.G.World.unpackPayload(payload);
        ms.push(performance.now() - t0);
        const after = payload.displayLines && payload.displayLines[0] ? payload.displayLines[0].coords : null;
        // 解码后 coords 应当从"扁平数字数组"变成"坐标点数组"（或长度/形状变化）
        if (before >= 0 && after && Array.isArray(after) && (after.length !== before || Array.isArray(after[0]))) worked = true;
        if (before < 0) worked = true;        // 这一档没有 displayLines（编辑档），无法用这个探针
      }
      ms.sort((a, b) => a - b);
      const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
      return { ms: avg, med: ms[Math.floor(ms.length / 2)], min: ms[0], max: ms[ms.length - 1],
        bytes, lines, areas, ways, enc, worked };
    })()`;
    let r;
    try { r = await client.eval(code); } catch (e) { r = { err: e.message }; }
    if (!r || r.err) { console.log(`z${z}  失败: ${r && r.err}`); continue; }
    if (!r.worked) { console.log(`z${z}  ⚠ 解码前后结构没变化，说明没测到真正的解码（不报数）`); continue; }
    rows.push({ zoom: z, decodeMs: r.ms, medianMs: r.med, minMs: r.min, maxMs: r.max,
      bytes: r.bytes, displayLines: r.lines, displayAreas: r.areas, ways: r.ways, enc: r.enc });
    console.log(`z${String(z).padStart(2)}   均值 ${r.ms.toFixed(2).padStart(7)} ms   中位 ${r.med.toFixed(2).padStart(7)}   `
      + `(min ${r.min.toFixed(2)} / max ${r.max.toFixed(2)})   载荷 ${(r.bytes / 1024).toFixed(1).padStart(8)} KB   `
      + `lines=${r.lines} areas=${r.areas} ways=${r.ways}`);
  }
  const out = { tag: TAG, at: new Date().toISOString(), port: PORT, viewport: { W, H, PAD }, repeat: REPEAT, rows };
  const file = path.join(__dirname, '..', 'logs', `decode-${TAG}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\n写入 ' + file);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
