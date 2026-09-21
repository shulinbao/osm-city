'use strict';
/**
 * ==================== 预计算低缩放显示图层（display_lod） ====================
 *
 * ## 为什么要有这一层
 *
 * 低缩放（z ≤ VIEW_ONLY_MAX_ZOOM = 14）下客户端拿到的是 `payload.displayLines` /
 * `payload.displayAreas`：**只有几何、没有 way id** 的合并折线与面。这两样东西是
 * `_coalesce` / `_coalesceAreas` **当场算出来**的，而它们依赖"把视口里所有 way 的几何
 * 从 SQLite 全读一遍"。实测（真实北京库 218 万节点 / 33.6 万 way / 530 MB，1400×900 px
 * 视口 + pad 5%、中心天安门，`logs/pc-floor.txt`）：
 *
 *   | zoom | 整包 | ways 扫描 | 取 way 几何 | 合并折线 | 合并面 | 取节点坐标 | 打包 |
 *   |------|------|-----------|-------------|----------|--------|------------|------|
 *   | z10  | 1215 | 168       | 145         | 167      | 118    | 453        | 78   |
 *   | z13  | 801  | 206       | 85          | 76       | 66     | 243        | 64   |
 *
 * 其中"取节点坐标"那 453 ms 里有 **97,864 个节点只是为了把面画出来**（`_coalesceAreas` 的
 * 环），而最终下发的 POI 只有 2153 个；"取 way 几何"那 145 ms 取的是 20,078 条 way，
 * 而合并之后一屏只剩 1,507 条折线。**每一次拖动都白读了一遍全城的几何。**
 *
 * ## 这一层是什么
 *
 * 把"合并 + 简化"这一步**离线烘**进库：
 *
 *   · 网格：数据范围切成 `tiles × tiles`（默认 6×6，每块 0.4624°×0.4326° ≈ 39×48 km）；
 *   · 对每个 band（= zoom 档，默认 z8~z14）的每一块瓦片，**跑一次库里真实的
 *     `OsmDB.queryBbox`**（而不是另写一套合并逻辑）：在 `_coalesce` / `_coalesceAreas`
 *     返回处截下 `lines` / `areas`（= 服务端本来要下发的 displayLines / displayAreas）
 *     与"哪些 way 的几何进了它们"，然后**抛异常跳过打包那一段**（预计算不需要载荷）；
 *   · 每个条目落一行（`display_lod`），并把**这块瓦片里每一个候选 way 的去向**记一行
 *     （`display_lod_cov`：进了折线 / 进了面 / 逐条下发 / 没几何 / 这一档看不见 / 被 LOD 扣下）；
 *   · 查询时：视口 → 瓦片集合 → 按主键读这两张表 → **不再为合并部分读任何 way 几何**。
 *
 * 实测（`logs/pc-build-tile6.txt` / `logs/build-display-lod.json`，真实北京库）：
 * z8~z14 七个档 36 块**总共 27~37 秒**（含"全局选类探针"约 6 秒）、
 * 折线 20,549 条 + 面 17,963 条、几何 **3.26 MB**、去向表 526,352 行（含它的 R\*Tree 共约 65 MB）；
 * 只读预计算表那一层 20~45 ms（对比当场合并 750~1400 ms，快 28~38 倍）。
 *
 * ## 几何语义（**与改动前一致**）
 *
 * 用的是 `_coalesce` / `coalesceGroupKeyOf` / `chainWaysToTrails` / `simplifyTrailMeters`
 * 那一整套（因为就是它跑出来的），DP 容差按 **band 固定**：
 *   `tolM = tolPx × metersPerPixel(z, latRef)`，`latRef` = **数据范围的最大纬度**（`OsmDB#_dlodLatRef`）。
 * 为什么按最大纬度：`metersPerPixel ∝ cos(lat)`，纬度越高 cos 越小、一像素对应的米数越小 ⇒
 * **容差最细**。取最大纬度就等于"保证这一层不比今天粗"（本数据集 37.77°~40.36°，
 * 中心纬度 39.06° 的 cos 比最北端大 1.9% —— 用中心纬度会让北半边的容差比线上现在**粗** 1.9%）。
 * 反过来最南端的容差会比这里用的细 1.9%（多留几个点，只多花字节）。
 * 为什么不按视口算（今天就是这么算的）：视口中心纬度每变一点容差就变一点，DP 保留的点集就可能变
 * —— 那"预计算"就无从谈起。
 *
 * ## 类选择：**在整个数据范围上定一次，烘进每一块瓦片**（这是最容易被忽略、也最要命的一条）
 *
 * `_coalesce` 选"这一档合并哪些样式类"的规则是 `coalesceAlways(cls) || 条数 ≥ minClassWays`，
 * 不够再按条数从大到小补到预算 —— 而**条数是"这一批候选"的条数**。合并是按瓦片分别跑的，
 * 于是**瓦片越小、能选中的类越少**，本该被合并的 way 会被挤出去、变成逐条下发
 * （实测：按瓦片选类时 z13 的 `coalesced` 比实时少 2.8%、217 条 way 掉出折线集、
 *  `payload.ways` 从 0 变成 9 条）。
 *
 * 所以烘焙时先跑一次 `surveyClasses` 探针（`OsmDB#_dlodSurveyClasses`：拿**整个数据范围**当视口
 * 跑一次真实的 `queryBbox`，但 `_coalesce` 数完类、按同一条规则选完就返回，不接龙不取坐标），
 * 把选中的集合存进 meta 的 `bands[z].classes`，**每一块瓦片（以及之后单块瓦片的重算）都用它**
 * （`chooseCoalesceClasses` 的 `forceClasses` 分支）。实测修正后 `payload.ways` 在 z10~z14 全是 0。
 *
 * ⚠ 这也意味着 `limits.coalesce.tolPx / coordDigits / minZoom / budget / minClassWays`
 * 一旦被改动，这一层就必须重建 —— 用 `signature()`（见下）钉死：签名对不上就**退回实时路径**
 * （画面永远是对的，只是慢），不会拿一份"按老参数烘的几何"糊上去。
 *
 * ## 瓦片与"跨瓦片的接龙"
 *
 * 一条折线的 bbox 常常压到多个瓦片。这里的取舍是（**与原型报告里的建议相反，附实测依据**）：
 *
 *   · **每条条目只存一份**，记在"算出它的那块瓦片"上（`tile` 列），不复制进其它瓦片；
 *   · 查询**按瓦片集合取行**（`WHERE z = ? AND tile IN (…)`，走主键 `(z,tile,id)`），
 *     而不是按 R*Tree 取"bbox 与视口相交的行"。
 *
 * 为什么不需要复制（完整性是可以证明的，也是实测过的）：
 *   瓦片网格是数据范围的**划分**，而每个瓦片的行是"用**这个瓦片自己那个框**跑一次真实合并"
 *   得到的 —— 于是**瓦片内的任何几何都被它自己的行覆盖**：视口里的一点 p 落在某块瓦片 T 里，
 *   覆盖 p 的那条 way 的 bbox 必然与 T 相交（p 就在它的 bbox 里），所以它一定参与了 T 的合并，
 *   它的几何一定在 T 的某条折线里。⇒ 取"与视口相交的所有瓦片"的行，就等于取全了。
 *
 * 反过来，复制是**有害**的，两条实测理由：
 *   1. **省不下行、只多存**：相邻瓦片各自都会算出"同一条路"的条目（id 不同，因为它们的接龙
 *      起点与分组输入不同），复制并不会让它们合并 —— 去重按 id 做，而它们的 id 本来就不一样。
 *      实测 z10 全范围：36 块里一共 2023 条折线，而整幅一次算是 1507 条 ——
 *      差额就是"同一组被相邻瓦片各算一遍"，复制只会把这个差额再乘一遍。
 *   2. **按瓦片取行比按 R*Tree 取行更省**：z13 视口（0.2644°×0.1304°）只压到 1~2 块瓦片，
 *      按瓦片取约 230 行；而按 bbox 相交取要 1113 行（全是"远处瓦片算出来的长折线"伸进视口），
 *      解出来 49,979 点、其中只有 32% 在框内（`logs/pc-bench-tile6.txt`）。
 *      ⇒ 取行方式本身就筛掉了大量重复长折线。
 *
 * 于是 `id` 只需在"同一块瓦片内"稳定即可：`id = hash(kind, z, tile, 分组键 / 关系 id)`，
 * 重算同一块瓦片时**删掉 (z, tile) 的所有行再原样写回**（同一个事务里），
 * 也就是"原地替换"；`owner` 列与 `tile` 相同，留着是为了把"谁的几何"写清楚（排查用）。
 *
 * ## 老库怎么办（服务端启动自动补建）
 *
 * 见 `OsmDB#buildDisplayLod` 与 `buildDisplayLodSliced`：库里没有这一层（或签名对不上）时，
 * 服务端**在初始化阶段切片补建**（每片 = 一个"band × 瓦片"，片与片之间 `setImmediate` 让出
 * 事件循环，进度写进 `/api/ready` 的 `stageMessage`）。每个 band 建完就单独记一次 meta，
 * 所以**建到哪个档、哪个档就立刻开始走快路径**（不必等七个档都建完）。
 * ⚠ 诚实的限制：单片就是一个真实的瓦片合并，**最坏一块（z14）实测 1.1~1.9 s**，
 * 这是"一次同步的合并 + 一次批量取几何"的下限，做不到 25 ms；片间让出事件循环，
 * 期间 `/api/ready` 一直能答。要更快只能把瓦片切得更细（代价见上：重复几何更多）。
 *
 * 回滚：config.json `limits.displayLod.on = false` ⇒ 一行都不建、读路径也不生效，
 * 行为退回改动前（`tests/display-lod-test.js` 有覆盖）。
 */

const DLOD_VERSION = 1;
const DLOD_TABLE = 'display_lod';
const DLOD_COV = 'display_lod_cov';
const DLOD_DIRTY = 'display_lod_dirty';
const DLOD_META = 'display_lod_meta';
/** 建表 SQL（**不进 server/dbschema.js 的迁移**：老库在没人建这一层之前，schema 一个字节都不变） */
const DLOD_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${DLOD_TABLE}(
  z INTEGER NOT NULL, tile INTEGER NOT NULL, id INTEGER NOT NULL, owner INTEGER NOT NULL,
  kind TEXT NOT NULL, family TEXT, cls TEXT, name TEXT, rel INTEGER,
  ways INTEGER, nseg INTEGER, npts INTEGER, rawnpts INTEGER,
  min_lon REAL, max_lon REAL, min_lat REAL, max_lat REAL,
  tags TEXT, geom BLOB, built_at INTEGER,
  PRIMARY KEY (z, tile, id)
);
CREATE INDEX IF NOT EXISTS idx_display_lod_owner ON ${DLOD_TABLE}(z, owner);
CREATE TABLE IF NOT EXISTS ${DLOD_COV}(
  z INTEGER NOT NULL, tile INTEGER NOT NULL, way_id INTEGER NOT NULL,
  status TEXT NOT NULL, sub TEXT,
  min_lon INTEGER, max_lon INTEGER, min_lat INTEGER, max_lat INTEGER,
  PRIMARY KEY (z, tile, way_id)
);
CREATE TABLE IF NOT EXISTS ${DLOD_DIRTY}(z INTEGER NOT NULL, tile INTEGER NOT NULL, at INTEGER, PRIMARY KEY (z, tile));
CREATE TABLE IF NOT EXISTS ${DLOD_META}(k TEXT PRIMARY KEY, v TEXT);
`;

/**
 * 去向表的 **R\*Tree**（每个 band 一张，按 bbox 取"与视口相交的候选 way"）：**必须有**，不是可选优化。
 *
 * 为什么：一张瓦片里"所有候选 way"可能多得离谱 —— z14 的候选扫描走 R\*Tree 路径（无 lod_zoom 过滤），
 * 市中心那块瓦片压着十几万条 way，而视口只占这块瓦片的 1/30。按 (z, tile) 主键把整块的
 * 去向读出来再在 JS 里逐行判 bbox，实测 **z14 的 _dlodReadCov 要 630 ms**（logs/pc-dlod-breakdown.txt）——
 * 比实时路径还慢。
 *
 * **为什么每个 band 一张、而不是共用一张**：一开始共用一张（id = cov 的 rowid），
 * z14 实测还是要 324 ms —— 因为 R\*Tree 里躺着 7 个 band 的记录（约 236 万行），
 * 视口那个框一次就命中 7 倍的行，再靠 c.z = ? 回表过滤，等于把 7 个 band 全读了一遍。
 * 拆成每 band 一张之后，z14 那张只有 33.7 万行、命中 3.6 万，读的就正好是**实时路径同一批候选**。
 *
 * 坐标存 1e-5 度的整数：lon × 1e5 ≈ 1.16e7 < 2^24，而 SQLite 的 rtree 用 float32 存坐标 ——
 * 这个量级下 float32 是**精确**的，不会被舍入把边界行判丢。
 * id = display_lod_cov 的 rowid（重建一块瓦片时按 (z, tile) 先删后插）。
 */
function covRtreeName(z) { return `${DLOD_COV}_rtree_${Math.floor(Number(z))}`; }
/** 建这个 band 的去向 R\*Tree（幂等；只有真的烘这个 band 时才建） */
function covRtreeSql(z) {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${covRtreeName(z)} USING rtree(id, min_lon, max_lon, min_lat, max_lat);`;
}

/* ------------------------------ 瓦片网格 ------------------------------ */
/**
 * 数据范围 → n×n 瓦片网格。瓦片编号 1..n*n，**行优先、行 0 = 最南边**（和 GeoJSON / 屏幕
 * 坐标的习惯一致，便于人读日志）。南北/东西都按等分切（不按米，也不按墨卡托 —— 北纬 40° 上
 * 一块瓦片约 39×48 km，够用；反正瓦片只是"失效与取数的单位"，不是渲染单位）。
 */
function makeGrid(extent, n) {
  const cols = Math.max(1, Math.floor(n));
  const dLon = (extent.maxLon - extent.minLon) / cols;
  const dLat = (extent.maxLat - extent.minLat) / cols;
  return {
    n: cols, extent, dLon, dLat,
    count: cols * cols,
    /** 瓦片 id → 它的框（id 从 1 开始；0 / 越界返回 null） */
    boxOf(tile) {
      const i = Math.floor(tile) - 1;
      if (!(i >= 0 && i < cols * cols)) return null;
      const row = Math.floor(i / cols);
      const col = i % cols;
      return {
        minLon: extent.minLon + col * dLon, maxLon: extent.minLon + (col + 1) * dLon,
        minLat: extent.minLat + row * dLat, maxLat: extent.minLat + (row + 1) * dLat,
      };
    },
    /** 落在哪块瓦片（1..n*n）；范围外返回 0 */
    tileAt(lon, lat) {
      if (!(lon >= extent.minLon && lon <= extent.maxLon && lat >= extent.minLat && lat <= extent.maxLat)) return 0;
      const col = Math.min(cols - 1, Math.max(0, Math.floor((lon - extent.minLon) / dLon)));
      const row = Math.min(cols - 1, Math.max(0, Math.floor((lat - extent.minLat) / dLat)));
      return row * cols + col + 1;
    },
    /** 这个框压到的所有瓦片 id（与 extent 取交；空框返回 []） */
    tilesOfBox(box) {
      const lo = Math.max(box.minLon, extent.minLon); const hi = Math.min(box.maxLon, extent.maxLon);
      const a = Math.max(box.minLat, extent.minLat); const b = Math.min(box.maxLat, extent.maxLat);
      if (!(hi >= lo && b >= a)) return [];
      const c0 = Math.min(cols - 1, Math.max(0, Math.floor((lo - extent.minLon) / dLon)));
      const c1 = Math.min(cols - 1, Math.max(0, Math.floor((hi - extent.minLon) / dLon)));
      const r0 = Math.min(cols - 1, Math.max(0, Math.floor((a - extent.minLat) / dLat)));
      const r1 = Math.min(cols - 1, Math.max(0, Math.floor((b - extent.minLat) / dLat)));
      const out = [];
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * cols + c + 1);
      return out;
    },
  };
}

/** 框是否（几乎）完全落在 extent 里：**写路径**用它判断"这次改动有没有把数据撑出网格" */
function boxInside(box, extent, eps = 1e-9) {
  return box.minLon >= extent.minLon - eps && box.maxLon <= extent.maxLon + eps
    && box.minLat >= extent.minLat - eps && box.maxLat <= extent.maxLat + eps;
}

/**
 * 框与 extent 有交集：**读路径**用它（而不是 boxInside）。
 *
 * 为什么读路径不需要"请求框完全落在数据范围内"：瓦片网格是**数据范围**的划分，而每条 way 的
 * bbox 都在数据范围里（extent 就是所有 way bbox 的并集），所以"视口里的一点 p"必定落在
 * `extent ∩ 视口` 里、也就必定落在某块瓦片里 —— `tilesOfBox` 会把请求框先与 extent 取交，
 * 于是**范围外的部分本来就一条数据都没有**，不需要退回实时路径。
 * （真要让"改动撑出网格"，那是写路径的事：见 OsmDB#dlodMarkDirty 里的 extentStale。）
 */
function boxIntersects(box, extent, eps = 1e-9) {
  return box.maxLon >= extent.minLon - eps && box.minLon <= extent.maxLon + eps
    && box.maxLat >= extent.minLat - eps && box.minLat <= extent.maxLat + eps;
}

/* ------------------------------ 几何裁剪 ------------------------------ */
/**
 * Liang–Barsky 线段裁剪：返回 [a', b'] 或 null。**给折线用**（开几何，裁断就是断）。
 * 坐标一律是 [lat, lon]（与 displayLines 的 coords 同一口径）。
 */
function clipSegment(a, b, box) {
  let t0 = 0; let t1 = 1;
  const dy = b[0] - a[0]; const dx = b[1] - a[1];
  const p = [-dy, dy, -dx, dx];
  const q = [a[0] - box.minLat, box.maxLat - a[0], a[1] - box.minLon, box.maxLon - a[1]];
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  const at = (t) => [a[0] + t * dy, a[1] + t * dx];
  return [at(t0), at(t1)];
}

/**
 * 一组折线 → 裁剪到 box。返回若干条折线（一条可能被裁成几段）。
 * 与 `_coalesce` 的输出形状同构：裁剪**只去掉框外的点**，框内的几何一个点不少。
 */
function clipPaths(paths, box) {
  const out = [];
  for (const p of paths) {
    let cur = null;
    for (let i = 0; i + 1 < p.length; i += 1) {
      const seg = clipSegment(p[i], p[i + 1], box);
      if (!seg) { if (cur && cur.length > 1) out.push(cur); cur = null; continue; }
      if (!cur) { cur = [seg[0], seg[1]]; continue; }
      const last = cur[cur.length - 1];
      if (Math.abs(last[0] - seg[0][0]) < 1e-9 && Math.abs(last[1] - seg[0][1]) < 1e-9) cur.push(seg[1]);
      else { if (cur.length > 1) out.push(cur); cur = [seg[0], seg[1]]; }
    }
    if (cur && cur.length > 1) out.push(cur);
  }
  return out;
}

/**
 * 环裁剪：**必须保住"闭合"**（Sutherland–Hodgman，逐条半平面裁）。
 *
 * 为什么面不能用 `clipPaths`（逐段裁）：裁完的环变成几条**开口**折线，而客户端对
 * "没闭合的环"只描边、不填充（见 `_coalesceAreas` 的说明）—— 湖面会整片丢掉填充。
 * 用 SH 裁出来的结果仍然是**闭合环**（首尾同点），填充语义不变。
 * 框是轴对齐矩形（凸），SH 对被裁多边形是否凸没有要求，正好合用。
 */
function clipRing(ring, box) {
  let pts = ring;
  const planes = [
    { inside: (p) => p[1] >= box.minLon, cut: (a, b) => cutAt(a, b, 1, box.minLon) },   // lon ≥ minLon
    { inside: (p) => p[1] <= box.maxLon, cut: (a, b) => cutAt(a, b, 1, box.maxLon) },   // lon ≤ maxLon
    { inside: (p) => p[0] >= box.minLat, cut: (a, b) => cutAt(a, b, 0, box.minLat) },   // lat ≥ minLat
    { inside: (p) => p[0] <= box.maxLat, cut: (a, b) => cutAt(a, b, 0, box.maxLat) },   // lat ≤ maxLat
  ];
  for (const pl of planes) {
    if (!pts.length) return null;
    const next = [];
    for (let i = 0; i < pts.length; i += 1) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const inCur = pl.inside(cur); const inPrev = pl.inside(prev);
      if (inCur) {
        if (!inPrev) next.push(pl.cut(prev, cur));
        next.push(cur);
      } else if (inPrev) next.push(pl.cut(prev, cur));
    }
    pts = next;
  }
  if (pts.length < 3) return null;
  const out = pts.slice();
  if (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]) out.push(out[0]);
  return out.length >= 4 ? out : null;
}
/** 线段 ab 与"轴向坐标 = v"的直线的交点（v 在 [0]=纬度 / [1]=经度） */
function cutAt(a, b, axis, v) {
  const t = (v - a[axis]) / (b[axis] - a[axis] || 1e-18);
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** 一组路径的 bbox（[lat,lon] 点序） */
function bboxOfPaths(paths) {
  let minLon = Infinity; let maxLon = -Infinity; let minLat = Infinity; let maxLat = -Infinity;
  for (const p of paths) {
    for (const q of p) {
      if (q[1] < minLon) minLon = q[1];
      if (q[1] > maxLon) maxLon = q[1];
      if (q[0] < minLat) minLat = q[0];
      if (q[0] > maxLat) maxLat = q[0];
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

/* ------------------------------ 稳定 id ------------------------------ */
/**
 * 稳定内容 id：`hash(kind, z, tile, key)` 取 48 位（< 2^53，能当 JS 安全整数与 SQLite INTEGER）。
 *
 * 为什么要"稳定"：重算同一块瓦片时是 `DELETE WHERE z=? AND tile=?` + 重新插入，
 * 所以严格说 id 不参与"原地替换"；但查询侧要**按 id 去重**（同一条几何将来若被复制到
 * 多块瓦片，去重就靠它），而且"同一条折线在两次构建里的 id 相同"让排查/A-B 对拍容易得多。
 * 用 `sha1` 前 7 字节取 53 位（node 内置，零依赖）；碰撞概率在几千行的量级上可以忽略。
 * 参数收的是 `node:crypto` **模块本身**（不是 `createHash` 函数）：后者脱离 `this` 调用会报
 * "algorithm argument must be of type string"（踩过一次）。
 */
function stableId(cryptoMod, kind, z, tile, key) {
  const h = cryptoMod.createHash('sha1').update(kind).update('\u0000').update(String(z)).update('\u0000')
    .update(String(tile)).update('\u0000').update(key).digest();
  /**
   * 取 53 位（= JS 安全整数的上限，`node:sqlite` 的 INTEGER 参数也只接受安全整数）：
   * 前 6 字节（48 位）再左移 5 位、拼上第 7 字节的高 5 位。
   * ⚠ 一开始写成了 7 字节 = 56 位，结果 `stmt.all()` 直接抛
   * `ERR_OUT_OF_RANGE: Value is too large to be represented as a JavaScript number` —— 记在这里。
   */
  return (h.readUIntBE(0, 6) * 32) + (h[6] >> 3);
}

/**
 * 构建签名：**同一份几何只对一组参数有效**。
 * 读路径每次都会用"这次请求实际生效的参数"重算一遍这个字符串；对不上就退回实时路径。
 * 于是"改了 config 但没重建"这种情况**不会**画出按老参数烘的几何 —— 只会慢。
 *
 * ⚠ 这个签名是**按 band** 算的（`sendRank` 随 zoom 变），存在 `meta.bands[z].sig` 里；
 * 而 `tiles`（瓦片网格）与 `bands`（要烘哪些档）**不进签名** —— 它们是"烘哪些/切多细"的
 * 施工选择，不改变几何语义（网格与范围都存在 meta 里，读路径直接用存下来的值）。
 */
function signature(o) {
  return JSON.stringify({
    v: DLOD_VERSION,
    extent: [o.extent.minLon, o.extent.maxLon, o.extent.minLat, o.extent.maxLat].map((x) => Math.round(x * 1e7) / 1e7),
    lat: Math.round(o.lat * 1e6) / 1e6,
    lod: { detail: o.detail, minFillArea: o.minFillArea, sendRank: o.sendRank, floor: o.floor || null, neverSendOn: !!o.neverSendOn, wayLodReady: !!o.wayLodReady },
    coalesce: { minZoom: o.minZoom, budget: o.budget, minClassWays: o.minClassWays, tolPx: o.tolPx, coordDigits: o.coordDigits },
    viewportLimit: o.viewportLimit,
  });
}

/* ------------------------------ 状态码 ------------------------------ */
/**
 * 一个候选 way 在"这块瓦片的这一档"里的去向（`display_lod_cov.status`）——
 * 这张表就是查询侧重建 `truncation.kinds.ways` 那本账的**唯一依据**：
 *   line      几何进了预计算折线（等价于实时路径的 `coalescePlan.coalesced`）
 *   area      几何进了预计算面（等价于 `areasPlan.covered`）
 *   way       逐条下发（真 way id + 整条几何）→ 查询时按 id 取几何
 *   nogfx     它在这块瓦片里取不到节点（节点被删了之类）→ 实时路径记 noGeometry
 *   invisible 这一档按显示分级看不见（`lodVisible` false；**不是** LOD 扣下）
 *   lod       被服务端 LOD 扣下，`sub` 说明是哪一类：
 *               neverSend:trees / neverSend:cycleways · roadClass:<rank> ·
 *               railMinor / railMinor:main · landuse · building
 */
const COV_STATUS = ['line', 'area', 'way', 'nogfx', 'invisible', 'lod'];

/**
 * 生成 `WHERE tile IN (?,?,…)` 的占位符（瓦片数固定 → SQL 文本固定 → 语句只 prepare 一次）。
 * 瓦片集合最多 `n*n`（默认 36）个，远低于 SQLite 的参数上限。
 */
function tilePlaceholders(count) {
  return new Array(count).fill('?').join(',');
}

module.exports = {
  DLOD_VERSION, DLOD_TABLE, DLOD_COV, DLOD_DIRTY, DLOD_META, DLOD_SCHEMA, COV_STATUS,
  covRtreeName, covRtreeSql,
  makeGrid, boxInside, boxIntersects, clipSegment, clipPaths, clipRing, bboxOfPaths, stableId, signature, tilePlaceholders,
};
