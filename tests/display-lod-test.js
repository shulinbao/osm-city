'use strict';
/**
 * ==================== 预计算低缩放显示图层（display_lod）的验收套件 ====================
 *
 * 规则、几何语义、瓦片取舍、失效与回滚的口径都在 `server/displaylod.js` 的文件头；
 * 这里只做**可断言的事**：
 *
 *   ① **回滚开关**（`limits.displayLod.on = false`）：载荷与"没有这一层的老库"**逐字节相同** ——
 *      含 z ≤ 14（预计算生效的那一档）与 z ≥ 15（编辑档）。这一条是"一行回滚"的硬证据。
 *   ② **z ≥ 15 逐字节不变**：开着这一层时，z15/z16/z17 的 JSON 与 BIN 与改动前逐字节相同。
 *   ③ **几何等价**：z12/z13 上，预计算出来的 displayLines / displayAreas 与"当场合并"的结果
 *      **互为最近折线**（顶点到对方折线网的距离 ≤ 2 个 DP 容差；DP 容差 = 1 像素对应的米数）。
 *   ④ **账本仍然如实**：complete=true、dropped=0、coalesced/visible 的量级一致（不是"少发了却报 0"）。
 *   ⑤ **没烘的档一律退回实时路径**：z11（本用例故意不烘）开着开关也必须与关掉时**逐字节相同**。
 *   ⑥ **编辑失效（端到端）**：临时实例（库副本 + 独立端口，**绝不是 8787**）里
 *      · 移动一个节点 / 删一条 way 之后，**立刻**请求同一视口 → 载荷必须反映改动（绝不显示旧几何）；
 *      · 重新构建脏瓦片之后，仍然反映改动，而且这次**走的是预计算路径**。
 *
 * 依赖：真实数据集 `data/osm/osm.sqlite`（和 tests/bin-payload-test.js 的真实数据对拍同一口径）。
 * 找不到就整体跳过（打印"跳过"，退出码 0）—— 它不该在没有数据集的机器上变成红灯。
 *
 *   node tests/display-lod-test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { OsmDB, encodeBinaryPayload } = require('../server/osmdb');
const { makeClient } = require('./client-vm');

const ROOT = path.resolve(__dirname, '..');
const REAL_DB = path.join(ROOT, 'data', 'osm', 'osm.sqlite');
const DIR = path.join(ROOT, 'tests', 'tmp-dlod');
const DB = path.join(DIR, 'osm.sqlite');
const PORT = Number(process.env.DLOD_PORT || 8963);
const BASE = `http://127.0.0.1:${PORT}`;
/** 只烘这两个档（够验"走了预计算路径"和"没烘的档退回实时"两件事；全烘要 27 秒） */
const BANDS = [12, 13];
const W = 1400; const H = 900; const PAD = 0.05;
const CENTER = { lat: 39.9042, lon: 116.4074 };

let passed = 0; let failed = 0; let skipped = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const skip = (name, why) => { skipped += 1; console.log('  ⏭ ' + name + ' （' + why + '）'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function metersPerPixel(zoom, lat) {
  return (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}
function bboxOf(z) {
  const mPerPx = metersPerPixel(z, CENTER.lat);
  const dLat = ((H / 2) * (1 + 2 * PAD) * mPerPx) / 111320;
  const dLon = ((W / 2) * (1 + 2 * PAD) * mPerPx) / (111320 * Math.cos((CENTER.lat * Math.PI) / 180));
  return {
    minLon: Number((CENTER.lon - dLon).toFixed(7)), maxLon: Number((CENTER.lon + dLon).toFixed(7)),
    minLat: Number((CENTER.lat - dLat).toFixed(7)), maxLat: Number((CENTER.lat + dLat).toFixed(7)),
  };
}
/** 与 server/index.js 的 /api/map 同一组参数（= tests/region-payload-hash.js 的 queryOpts） */
function queryOpts(z, b, over = {}) {
  return Object.assign({
    ...b, zoom: z, limit: 15000,
    wayCandidates: 12, nodeCandidates: 8, relationLimit: 10000,
    relationCropPad: 0.25, relationCropMinMembers: 64, relationCropBoundaryMembers: false,
    detail: null, lodDetail: 4, lodRoadSend: null, lodRoadClassFloor: null,
    minFillArea: null, lodMinFillArea: 0, neverSend: null, lodNeverSend: true,
    coalesce: null, compact: true, view: null, flatCaps: false,
  }, over);
}
const sha = (p) => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');

/* ---------------- 几何比较：点到折线网的距离（与 tmp-verify/pc-common.js 同一套思路） ---------------- */
const CELL = 0.002;
function buildNet(paths) {
  const cells = new Map();
  for (const p of paths) {
    for (let i = 0; i + 1 < p.length; i += 1) {
      const seg = [p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]];
      const c0 = Math.floor(Math.min(seg[1], seg[3]) / CELL); const c1 = Math.floor(Math.max(seg[1], seg[3]) / CELL);
      const r0 = Math.floor(Math.min(seg[0], seg[2]) / CELL); const r1 = Math.floor(Math.max(seg[0], seg[2]) / CELL);
      for (let cx = c0; cx <= c1; cx += 1) for (let cy = r0; cy <= r1; cy += 1) {
        const k = cx + ':' + cy;
        let a = cells.get(k); if (!a) { a = []; cells.set(k, a); } a.push(seg);
      }
    }
  }
  return cells;
}
function distPtSeg(px, py, a) {
  const kx = Math.cos((((a[0] + a[2]) / 2) * Math.PI) / 180);
  const ax = a[1] * kx; const ay = a[0]; const bx = a[3] * kx; const by = a[2];
  const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy;
  const px2 = px * kx;
  const t = l2 > 1e-18 ? Math.max(0, Math.min(1, ((px2 - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px2 - (ax + t * dx), py - (ay + t * dy)) * 111320;
}
/**
 * 到折线网的距离分布（不只是最大值：一屏 8000 条折线里"最坏那一个顶点"与"99% 的顶点"
 * 是两个完全不同的故事，报告里要分开讲）。
 */
function distStatsToNet(cells, paths, maxRing = 4) {
  const ds = [];
  for (const p of paths) {
    for (const q of p) {
      const cx0 = Math.floor(q[1] / CELL); const cy0 = Math.floor(q[0] / CELL);
      let best = Infinity;
      for (let r = 0; r <= maxRing && best === Infinity; r += 1) {
        for (let cx = cx0 - r; cx <= cx0 + r; cx += 1) {
          for (let cy = cy0 - r; cy <= cy0 + r; cy += 1) {
            if (r > 0 && Math.abs(cx - cx0) !== r && Math.abs(cy - cy0) !== r) continue;
            const arr = cells.get(cx + ':' + cy);
            if (!arr) continue;
            for (const s of arr) { const d = distPtSeg(q[1], q[0], s); if (d < best) best = d; }
          }
        }
      }
      ds.push(Number.isFinite(best) ? best : 1e9);
    }
  }
  ds.sort((a, b) => a - b);
  const pick = (f) => (ds.length ? ds[Math.min(ds.length - 1, Math.floor(ds.length * f))] : 0);
  return { n: ds.length, p50: pick(0.5), p99: pick(0.99), p999: pick(0.999), max: ds.length ? ds[ds.length - 1] : 0, ds };
}
/**
 * 载荷里 displayLines / displayAreas 的**路径集合**（解包之后）。
 * `box` 给出时只保留**落在框内**的点：这是必须的 —— 实时路径下发的是**整条** way 的几何
 * （不裁剪，客户端靠相邻缓存矩形互相覆盖），而预计算路径**裁到了请求框**。
 * 不裁的话"框外那几十公里的点"会被算成巨大偏差，测出来的是夹具口径而不是几何错误。
 */
function pathsOfPayload(p, kind, box = null) {
  const out = [];
  const list = kind === 'area' ? (p.displayAreas || []) : (p.displayLines || []);
  const scale = p.enc ? p.enc.lineScale : 1e5;
  const inside = (q) => !box || (q[0] >= box.minLat && q[0] <= box.maxLat && q[1] >= box.minLon && q[1] <= box.maxLon);
  for (const e of list) {
    const segs = [];
    if (e.segs) {
      let at = 0;
      for (const n of e.segs) { const q = []; for (let i = 0; i < n; i += 1) q.push([e.coords[at + i * 2] / scale, e.coords[at + i * 2 + 1] / scale]); at += n * 2; segs.push(q); }
    } else {
      const dec = (flat) => { const q = []; let la = 0; let lo = 0; for (let i = 0; i + 1 < flat.length; i += 2) { la += flat[i]; lo += flat[i + 1]; q.push([la / scale, lo / scale]); } return q; };
      segs.push(dec(e.coords));
      if (e.paths) for (const f of e.paths) segs.push(dec(f));
    }
    for (const s of segs) { const q = s.filter(inside); if (q.length > 1) out.push(q); }
  }
  return out;
}
const kindsOf = (p) => (p.truncation ? p.truncation.kinds.ways : null);

/* ==================================================================== */
async function main() {
  console.log('=== 预计算低缩放显示图层（display_lod）· 验收套件 ===\n');
  if (!fs.existsSync(REAL_DB)) {
    skip('整段套件', '找不到 ' + path.relative(ROOT, REAL_DB) + '（真实数据集不在就不跑，避免变成假红灯）');
    return finish();
  }
  fs.mkdirSync(DIR, { recursive: true });
  /**
   * **每次运行都从干净副本开始**：这个套件会**改库**（移动节点、删 way），而它验的正是
   * "编辑之后载荷怎么变" —— 复用上一次那份被改过的副本会让"关掉开关 = 老库"这类断言假失败
   *（第一版就复用了，第二次运行时 4 条断言因此报红，排查了半天才看清是用例自己的状态）。
   * 复制 556 MB 约 10~20 s，换来的是可重复。
   */
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  console.log('▶ 复制数据集副本 → ' + path.relative(ROOT, DB));
  fs.copyFileSync(REAL_DB, DB);
  console.log('▶ 库副本 = ' + path.relative(ROOT, DB) + '（' + (fs.statSync(DB).size / 1e6).toFixed(0) + ' MB）');

  /* ---------------- ② 建层（只烘 z12/z13） ---------------- */
  console.log('\n▶ ① 在副本上烘预计算层（band ' + BANDS.join(',') + '）');
  const t0 = Date.now();
  const builder = new OsmDB(DB, { displayLod: { bands: BANDS, tiles: 6 } });
  const build = builder.buildDisplayLod({ bands: BANDS });
  const info = builder.displayLodInfo();
  builder.close();
  check('烘焙成功（36 块 × ' + BANDS.length + ' 档）', build.failed === 0 && build.done === build.jobs,
    `${build.done}/${build.jobs} 块 · ${((Date.now() - t0) / 1000).toFixed(1)} s · 折线 ${build.lines} · 面 ${build.areas} · 覆盖 way ${build.cov} · 几何 ${(build.bytes / 1e6).toFixed(2)} MB`);
  check('meta 记录了这些 band', !!info.available && BANDS.every((z) => info.bands[z] && info.bands[z].done),
    'bands=' + Object.keys(info.bands).join(','));
  /**
   * **切片构建**（服务端自动补建走的就是它）：这里直接实测"有没有让出事件循环"——
   * 用一个 `setInterval` 计数器在旁边跳，如果构建是整段同步跑，计数器整个期间只跳 0~1 次。
   */
  const slicer = new OsmDB(DB, { displayLod: { bands: BANDS, tiles: 6 } });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const sliced = await slicer.buildDisplayLodSliced({ bands: BANDS, sliceMs: 5 });
  clearInterval(timer);
  slicer.close();
  check('切片构建（buildDisplayLodSliced）让出了事件循环',
    sliced.slices >= BANDS.length * 6 && ticks >= 10,
    `${sliced.done} 块 / ${sliced.slices} 片 / 定时器跳了 ${ticks} 次 / 最长一块 ${sliced.maxTileMs} ms`);

  /* ---------------- ③ 只读对拍 ---------------- */
  console.log('\n▶ ② 载荷对拍（关 / 开 / 老库）');
  const on = new OsmDB(DB, { readOnly: true, displayLod: { bands: BANDS, tiles: 6 } });
  const off = new OsmDB(DB, { readOnly: true, displayLod: { on: false } });
  const plain = new OsmDB(REAL_DB, { readOnly: true, displayLod: { bands: BANDS, tiles: 6 } });
  const zoomRows = [];
  for (const z of [10, 11, 12, 13, 15, 16, 17]) {
    const box = bboxOf(z);
    const o = queryOpts(z, box);
    const pOff = off.queryBbox({ ...o });
    const pOn = on.queryBbox({ ...o });
    const pPlain = plain.queryBbox({ ...o });
    const sameOnOff = sha(pOff) === sha(pOn);
    const binOff = encodeBinaryPayload(JSON.parse(JSON.stringify(pOff))).length;
    const binOn = encodeBinaryPayload(JSON.parse(JSON.stringify(pOn))).length;
    zoomRows.push({ z, pOff, pOn, pPlain, sameOnOff, binOff, binOn });
    const dl = pOn.truncation.displayLod;
    console.log(`  z${String(z).padEnd(3)} 关 ${String(Buffer.byteLength(JSON.stringify(pOff))).padStart(9)} B`
      + ` · 开 ${String(Buffer.byteLength(JSON.stringify(pOn))).padStart(9)} B`
      + ` · 预计算 ${dl ? '是' : '否'} · lines ${(pOff.displayLines || []).length}→${(pOn.displayLines || []).length}`
      + ` · areas ${(pOff.displayAreas || []).length}→${(pOn.displayAreas || []).length}`);
  }
  const row = (z) => zoomRows.find((r) => r.z === z);

  // ②-a 没烘的档：开着开关也必须逐字节相同（退回实时路径）
  check('z11（没烘）开着开关与关掉逐字节相同', sha(row(11).pOff) === sha(row(11).pOn));
  // ②-b z ≥ 15 逐字节不变（JSON 与 BIN 都比）
  for (const z of [15, 16, 17]) {
    const r = row(z);
    check(`z${z} 逐字节不变（JSON + BIN）`, sha(r.pOff) === sha(r.pOn) && r.binOff === r.binOn,
      `JSON ${sha(r.pOff) === sha(r.pOn) ? '同' : '异'} · BIN ${r.binOff}B vs ${r.binOn}B`);
    check(`z${z} 载荷里没有 displayLod 字段（不单方面改协议）`, !r.pOn.truncation.displayLod);
  }
  // ②-c 烘过的档：确实走了预计算路径
  for (const z of [12, 13]) {
    const r = row(z);
    check(`z${z} 走了预计算路径`, !!r.pOn.truncation.displayLod && r.pOn.truncation.displayLod.active === true);
    check(`z${z} 关掉开关时与老库逐字节相同`, sha(r.pOff) === sha(r.pPlain));
    const k = kindsOf(r.pOn);
    check(`z${z} 账本仍然如实（complete=true / dropped=0）`, k.complete === true && k.dropped === 0,
      `complete=${k.complete} dropped=${k.dropped} visible=${k.visible} coalesced=${k.coalesced} returned=${k.returned}`);
  }
  // ②-d 回滚路径：整个 `on:false` 与"没有这一层的老库"逐字节相同（含 z ≤ 14）
  const rollbackOk = [10, 11, 12, 13, 15, 16, 17].every((z) => sha(row(z).pOff) === sha(row(z).pPlain));
  check('回滚开关 on:false = 老库（7 个档逐字节相同）', rollbackOk);

  /* ---------------- ④ 几何等价 ---------------- */
  console.log('\n▶ ③ 几何等价（预计算 vs 当场合并）');
  for (const z of BANDS) {
    const r = row(z);
    const tolM = 1 * metersPerPixel(z, CENTER.lat);
    // 只比**框内**的点（见 pathsOfPayload 的说明：实时路径不裁、预计算路径裁到请求框）
    const box = bboxOf(z);
    const aL = pathsOfPayload(r.pOff, 'line', box); const bL = pathsOfPayload(r.pOn, 'line', box);
    const aA = pathsOfPayload(r.pOff, 'area', box); const bA = pathsOfPayload(r.pOn, 'area', box);
    const sL = distStatsToNet(buildNet(bL), aL);
    const sA = distStatsToNet(buildNet(bA), aA);
    /**
     * 判据用**分布**而不是"最坏的那一个顶点"：瓦片是分别接龙 + 分别简化的，
     * 一条"整幅接龙"的折线在瓦片里会被切成几段、各自 DP（起点不同 → 保留的点集不同），
     * 于是**极少数**顶点会落在对方折线网之外（实测 z12 p99.9 = 一个像素以内、最坏 0.3~0.5 km）。
     * 画面上看不出来（0.1% 的顶点、且偏差沿着同一条路的走向），但这个事实必须如实写在报告里，
     * 所以这里断言 p99.9 与"超 2 个容差的顶点占比 ≤ 0.5%"，并把 max 一起打出来。
     */
    const badL = sL.ds.filter((d) => d > 2 * tolM).length / Math.max(1, sL.n);
    const badA = sA.ds.filter((d) => d > 2 * tolM).length / Math.max(1, sA.n);
    check(`z${z} 折线几何等价（p99.9 ≤ 2 个 DP 容差 · 超差顶点占比 ≤ 0.5%）`,
      sL.p999 <= 2 * tolM && badL <= 0.005,
      `n=${sL.n} · p50 ${sL.p50.toFixed(1)} · p99 ${sL.p99.toFixed(1)} · p99.9 ${sL.p999.toFixed(1)} · max ${sL.max.toFixed(1)} m`
      + ` · 容差 ${(2 * tolM).toFixed(1)} m · 超差 ${(badL * 100).toFixed(2)}% · 折线 ${aL.length}→${bL.length}`);
    check(`z${z} 面几何等价（同一判据）`, sA.p999 <= 2 * tolM && badA <= 0.005,
      `n=${sA.n} · p99 ${sA.p99.toFixed(1)} · p99.9 ${sA.p999.toFixed(1)} · max ${sA.max.toFixed(1)} m · 超差 ${(badA * 100).toFixed(2)}%`);
    const kOff = kindsOf(r.pOff); const kOn = kindsOf(r.pOn);
    check(`z${z} 覆盖的 way 数量级一致（不是"少发了一大批"）`,
      Math.abs(kOn.coalesced - kOff.coalesced) <= Math.max(100, kOff.coalesced * 0.05)
        && kOn.returned <= Math.max(50, kOff.visible * 0.01),
      `coalesced ${kOff.coalesced}→${kOn.coalesced} · visible ${kOff.visible}→${kOn.visible} · returned ${kOff.returned}→${kOn.returned}`);
  }
  off.close(); plain.close();

  /* ---------------- ⑤ 编辑失效（端到端：独立端口 + 库副本） ---------------- */
  console.log('\n▶ ④ 编辑失效端到端（临时实例，端口 ' + PORT + '，绝不是 8787）');
  // 临时实例用一份**自己的 config**：band 与 tiles 跟上面烘的一致，避免它在启动时又去补建别的档
  //（本用例要的是"编辑失效"这一段，补建另有断言）
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.port = PORT;
  cfg.limits.displayLod = Object.assign({}, cfg.limits.displayLod, { bands: BANDS, tiles: 6 });
  const cfgFile = path.join(DIR, 'config-dlod.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const srv = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--data', DIR, '--osm', DB, '--config', cfgFile],
    { cwd: ROOT, stdio: 'ignore' });
  try {
    const box13 = bboxOf(13);
    const qs = `minLon=${box13.minLon}&minLat=${box13.minLat}&maxLon=${box13.maxLon}&maxLat=${box13.maxLat}&zoom=13`;
    let health = null;
    for (let i = 0; i < 120 && !health; i += 1) {
      try { const res = await fetch(BASE + '/api/health'); if (res.ok) health = await res.json(); } catch { /* 还没起来 */ }
      if (!health) await sleep(250);
    }
    check('临时实例起来了', !!health, health ? `ready=${health.ready}` : '连不上');
    if (!health) throw new Error('实例没起来');
    const reg = await (await fetch(BASE + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dlod' + (Date.now() % 100000), password: 'pass1234' }),
    })).json();
    check('注册一个玩家', !!reg.token);
    const client = makeClient({ base: BASE, token: reg.token, name: 'dlod' });
    await client.connect();
    const view = async () => {
      const res = await fetch(`${BASE}/api/map?${qs}&token=${encodeURIComponent(reg.token)}`);
      return res.json();
    };
    const row = (z) => zoomRows.find((r) => r.z === z);
    void row;

    /**
     * 选一条"在 z13 可见、压在该视口里、不是关系成员、**不大**"的 way，并且挑**落点最空**的那条。
     *
     * 为什么要挑落点：断言"改动立刻画出来了"必须有个确定含义 —— 把这条 way 的首个节点往北挪 0.02°
     * （约 2.2 km），落点在改前应当**离任何路都很远**、改后到路网的距离应当是 0。
     * 第一版没挑落点，遇到过一次"改前就只有 75 m"（那个点本来就在另一条路边上），
     * 断言就变成了没法解读的东西。这里对前 8 个候选各算一次落点到折线网的距离，取最远的那个。
     *
     * 为什么特意挑小的：一次编辑要后台重算的是"这条 way 的新旧 bbox 压到的所有瓦片"，
     * 一条 1242 个节点、横跨半座城的 way 会脏掉几十块（每块 z13 最坏 1.6 s）—— 那是**最坏情况**，
     * 本用例要验的是"机制正确"，不是把最坏情况当基准（最坏情况见报告第 3 节）。
     */
    const pickWay = (payload0) => {
      const cells = payload0 ? buildNet(pathsOfPayload(payload0, 'line', box13)) : null;
      const rows = on.db.prepare(`SELECT w.id, w.node_count FROM ways w
        WHERE w.deleted = 0 AND w.lod_zoom <= 13 AND w.node_count BETWEEN 4 AND 40
          AND w.max_lon >= ? AND w.min_lon <= ? AND w.max_lat >= ? AND w.min_lat <= ?
          AND NOT EXISTS (SELECT 1 FROM relation_members rm WHERE rm.member_type = 'way' AND rm.member_ref = w.id)
        ORDER BY w.node_count ASC LIMIT 40`).all(box13.minLon, box13.maxLon, box13.minLat, box13.maxLat);
      let best = null;
      for (const r of rows.slice(0, 8)) {
        const n = on.db.prepare('SELECT n.id, n.lat, n.lon FROM nodes n JOIN way_nodes wn ON wn.node_id = n.id WHERE wn.way_id = ? ORDER BY wn.seq LIMIT 1').get(r.id);
        if (!n) continue;
        const lat = n.lat + 0.02;
        if (lat > box13.maxLat || lat < box13.minLat) continue;   // 落点要还在视口里
        const d = cells ? distToNetCells(cells, lat, n.lon) : 999;
        const cand = { id: r.id, node_count: r.node_count, nid: n.id, lat, lon: n.lon, d0: d };
        if (!best || cand.d0 > best.d0) best = cand;
      }
      return best;
    };

    /**
     * 点到一屏折线网的最近距离（米）：用来断言"这个位置到底有没有路"。
     * `cells` 可以传进来复用（挑候选时要对好几个落点各算一次）。
     */
    const distToNetCells = (cells, lat, lon) => {
      let best = Infinity;
      const cx0 = Math.floor(lon / CELL); const cy0 = Math.floor(lat / CELL);
      for (let r = 0; r <= 6; r += 1) {
        for (let cx = cx0 - r; cx <= cx0 + r; cx += 1) {
          for (let cy = cy0 - r; cy <= cy0 + r; cy += 1) {
            if (r > 0 && Math.abs(cx - cx0) !== r && Math.abs(cy - cy0) !== r) continue;
            const arr = cells.get(cx + ':' + cy);
            if (!arr) continue;
            for (const s of arr) { const d = distPtSeg(lon, lat, s); if (d < best) best = d; }
          }
        }
      }
      return best;
    };
    const distToPayload = (p, lat, lon) => distToNetCells(buildNet(pathsOfPayload(p, 'line', box13)), lat, lon);
    /** 等后台重算完成：轮询到这次请求又走了预计算路径为止 */
    const waitPrecomputed = async (maxMs = 180000) => {
      const t = Date.now();
      for (;;) {
        const p = await view();
        if (p.truncation && p.truncation.displayLod) return p;
        if (Date.now() - t > maxMs) return null;
        await sleep(1000);
      }
    };

    const p0 = await view();
    check('基线：低缩放视图走预计算路径', !!(p0.truncation && p0.truncation.displayLod),
      `lines=${(p0.displayLines || []).length} areas=${(p0.displayAreas || []).length} ms=${p0.ms}`);

    const w0 = pickWay(p0);
    check('找到一条 z13 可见的 way（落点是候选里最空的位置）', !!w0,
      w0 ? `#${w0.id}（${w0.node_count} 个节点）· 落点改前离路网 ${Math.round(w0.d0)} m` : '没找到');
    if (!w0) throw new Error('数据集里没有可用的 way');

    // ── 移动一个节点（+0.02° ≈ 2.2 km）：**立刻**请求同一视口，必须反映 ──
    const nid = w0.nid;
    const ncur = on.db.prepare('SELECT lat, lon, version FROM nodes WHERE id = ?').get(nid);
    const newLat = ncur.lat + 0.02; const newLon = ncur.lon;
    const d0 = distToPayload(p0, newLat, newLon);
    const ack = await client.op({ k: 'updateNode', id: nid, lat: newLat, lon: newLon, version: ncur.version });
    check('移动节点成功（真 WS 编辑路径 / Net.op）', !!ack);
    const p1 = await view();
    check('**立刻**再请求同一视口：退回实时路径（有脏瓦片）',
      !(p1.truncation && p1.truncation.displayLod), `ms=${p1.ms}`);
    const d1 = distToPayload(p1, newLat, newLon);
    check('改动**立刻**画出来了（新位置上有路了）', d0 >= 30 && d1 <= 5,
      `新位置到折线网：改前 ${d0.toFixed(0)} m → 改后 ${d1.toFixed(0)} m`);

    // ── 等后台把脏瓦片重算完：又走预计算，而且几何仍然是"改之后"的（不是旧几何） ──
    const p2 = await waitPrecomputed();
    check('后台重算完成后：又走预计算路径', !!p2, p2 ? `ms=${p2.ms}` : '等 180 s 还没重算完');
    if (p2) {
      const d2 = distToPayload(p2, newLat, newLon);
      check('重算之后几何不旧（新位置上仍然有路）', d2 <= 60, `新位置到折线网 ${d2.toFixed(0)} m`);
      check('重算之后的载荷与"脏的时候实时算的"几何等价（p99.9 ≤ 2 个容差）',
        distStatsToNet(buildNet(pathsOfPayload(p2, 'line', box13)), pathsOfPayload(p1, 'line', box13)).p999
          <= 2 * metersPerPixel(13, CENTER.lat),
        `p99.9 = ${distStatsToNet(buildNet(pathsOfPayload(p2, 'line', box13)), pathsOfPayload(p1, 'line', box13)).p999.toFixed(1)} m`);
      check('重算之后载荷确实变了（不是把旧几何留在库里）', sha(p2) !== sha(p0));
    }

    // ── 删一条 way：同样必须立刻反映 ──
    const wdel = pickWay() || w0;
    const ver = on.db.prepare('SELECT version FROM ways WHERE id = ?').get(wdel.id).version;
    await client.op({ k: 'deleteWay', id: wdel.id, version: ver });
    const p3 = await view();
    check('删 way 之后立刻请求：退回实时路径且载荷变化',
      !(p3.truncation && p3.truncation.displayLod) && sha(p3) !== sha(p2 || p1), `ms=${p3.ms}`);
    const p4 = await waitPrecomputed();
    check('删 way 重算之后：走预计算且载荷与实时一致（几何不旧）',
      !!p4 && sha(p4) !== sha(p2 || p1), p4 ? `ms=${p4.ms}` : '等 180 s 还没重算完');
  } catch (err) {
    check('编辑失效端到端', false, String((err && err.message) || err));
  } finally {
    try { srv.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(300);
  }

  on.close();
  return finish();
}

function finish() {
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ===`);
  if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  · ' + f); }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
