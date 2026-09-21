'use strict';
/**
 * 分区流式地图 —— 矩形裁片工具（零第三方依赖，只用 Node 内置模块）
 *
 * 用法：
 *   node tools/tile-cut.js --plan                    # 只量测不写库（干跑，走的是同一套归属代码）
 *   node tools/tile-cut.js --run                    # 真正裁片，生成 data/regions/<id>.sqlite + registry.json
 *   node tools/tile-cut.js --run --only bj-sw,heb-lf # 只裁指定几片（调试用；registry 只写这几片）
 *   node tools/tile-cut.js --registry               # 不裁片，仅按现有分片库重新生成 registry.json
 *   node tools/tile-cut.js --run --force            # 目标库已存在时覆盖（默认拒绝覆盖）
 *
 * 为什么要这个工具：`data/regions/beijing.sqlite` 与 `hebei.sqlite` 是**嵌套冗余**关系 ——
 * 河北省级提取包整包含有北京片的全部要素（内容逐字段一致），两片之间连一条"跨片边界"都不存在，
 * 拿它们做试点既测不出"跨片边界要素的路由与分叉"，上线又等于把同一份几何存两遍。
 * 本工具把这两片**只读**读出来，按**互不重叠的矩形**重建为若干分片库，
 * 于是分片之间是真的有边界、真的能测路由。
 *
 * ----------------------------------------------------------------------------------
 * 一、归属规则（确定性，逐条写死）
 * ----------------------------------------------------------------------------------
 * ① **坐标 → 片**：矩形用**半开区间** [min, max)（纬度、经度都是）。于是相邻两片的公共边
 *    只属于一侧，一个点不可能被两片同时"包含" —— 这是"不重叠"最底层的一条保证。
 * ② **独立节点（POI）**：按自身坐标归片。
 * ③ **way**：**整条**只进一片，归属看"**中间节点**"落在哪片：
 *      mid 下标 = refs.length >> 1   （refs = 该 way 的节点序列，**从 way_nodes 按 seq 读出来的实际序列**）
 *      即 1 个节点 → 下标 0；2 个 → 下标 1（第二个）；3 个 → 下标 1；4 个 → 下标 2；n 个 → floor(n/2)。
 *      **不用 bbox 中心**：一条沿边界走 50 km 的长条道路，bbox 中心可能落在完全无关的片里，
 *      几何会被撕成两半；中间节点是序列上的中点，长条要素的失真最小。
 *    注意这里用 refs.length 而**不是** ways.node_count：两者在现有来源库上实测相等
 *    （北京片逐 way 核对：node_count 与 way_nodes 行数不一致的 way = 0，seq 不是 0..n-1 的 = 0），
 *    但 refs.length 是"库里真实存在的几何"，用它就不必依赖"来源库字段自洽"这个前提。
 * ④ **way 用到的全部节点**：不管落在哪个矩形，**全部**复制进该 way 所在的那片（几何自洽；
 *    这些被复制过来的节点就是"片间同 id 节点"，它们的坐标必须逐位相同）。
 * ⑤ **relation**：按"**第一个成员 way 所在片**"归片。这是**简化**：真实的 relation
 *    （尤其 route/boundary）成员可能横跨好几片，严格做法是复制到每一片或做成员级拆分，
 *    这里只放一片，于是片内 relation_members 里的其它成员可能指向本片没有的要素
 *    （way 成员不一定都在：只有"第一个 way 成员"所在片 == 该 way 所在片，其余成员可能在邻片）。
 *    定片锚点按顺序退让：**第一个能定位的 way 成员** → 该 way 的中间节点；没有就用第一个能定位的
 *    node 成员的坐标；连成员都解析不到（关系成员落在提取包之外）就用 relation 自己的 bbox 中心；
 *    三步都拿不到才丢弃。
 *
 *    **⚠ relation 必须按 id 全局去重（这是实测踩出来的坑，不是过度设计）**：
 *    way 的片只取决于它**自己**的中间节点，所以同一个 way id 从哪个来源库读都算到同一片
 *    （实测 45 对分片 way 同 id 全为 0）；relation 不一样 —— 它的片取决于成员表，
 *    而成员可能不在本来源库里，于是锚点以**不同方式**退让，同一个 relation id 会被算进两片。
 *    实测案例：relation 5869571（8977 个成员）在两个来源库里成员表逐条相同，但第一个 way 成员
 *    202165095 在两个库里都没有 way_nodes 行；退让到 node 成员后一边能定位一边不能，
 *    最终落到各自 bbox 中心：北京片中心 → bj-se，河北片中心 → bj-sw，**同一条关系进了两片**。
 *    所以 relation 走"先河北（超集）后北京，按 id 锁定一片；后来者只有成员更全才覆盖进同一片"。
 *    这样"片间 relation 同 id = 0"是**结构上**成立的，不依赖两个来源库长得一样。
 *
 *    **实测丢弃的正是"来源库自己都没法定位的 relation"**：两个来源库的 relation_index
 *    分别是 11,345 / 27,922（= 有 bbox 的关系数），凡来源库能算出几何的关系本工具一条都不丢；
 *    丢掉的 3,255 条在北京/河北合计 42,522 条里本来就没有任何可定位的成员。
 *    另有 6,688 条北京 relation 没有 way 成员（多为纯 node 关系），退回 node 成员坐标定片。
 * ⑤b **跨片 relation 副本**（归属规则 ⑦，见下面那一大段）：阶段 ③ 定的只是**属主片**，
 *    属主片 ≠ "任何视口都能查到它" —— 因为服务端选片只看声明矩形。所以阶段 ⑦ 会把
 *    属主片那一份**复制进它的 bbox 触及的每一片**。于是"片间 relation 同 id 数 = 0"
 *    **不再成立**（断言口径已按 ⑤b 改写，见下节与 tests/tile-cut-bench.js 的 ②b）。
 * ⑥ **落在所有矩形之外**的元素：不是丢弃，而是**就近归片**（到矩形的最短平方距离最小者；
 *    距离相同则取 TILES 里靠前的那片）。量很小（实测节点 1.2 万个 / 0.06%，way 55 条），
 *    它们是省级提取包在"多边形之外仍被关系/way 引用"的野点（data_bbox 远大于 source_bounds
 *    就是这个原因）。宁可把它们带进某一片并如实量出 bbox 溢出，也不静默丢数据。
 *
 * 二、由此得到的可验证性质（tests/tile-cut-bench.js 会逐条实测断言）
 * ----------------------------------------------------------------------------------
 *   · 片间 **way 同 id 数 = 0**（way 永远只属于一片）；
 *   · 片间 **node 同 id 数可以 > 0**（那是被复制过去的几何支撑节点），但**坐标必须差 0**；
 *   · 每片内 way_nodes 引用的节点**都在本片内**（悬挂 = 0）；
 *   · 片间 **relation 同 id 数可以 > 0**（跨片副本），但**副本之间内容必须逐条相同**：
 *     bbox 四列逐位相同 / 成员行逐条相同 / version 与 member_count 相同 / 只出现在 bbox 触及的片里；
 *     服务端"同 id 去重"（`server/regions.js` 的 `pickRelation`）因此永远面对同一份内容，
 *     只可能因为**各自裁剪出的成员账本**不同而如实记一次冲突（预期内，见 ⑤b 那段）。
 *
 * 三、写库方式
 * ----------------------------------------------------------------------------------
 * 建库一律复用 `server/dbschema.js` 的 `openDatabase`（含 R*Tree 与索引维护，与全项目一致）；
 * 插入语句的列清单**逐字对齐** `tools/import-osm.js` 的 insertElement（nodes / ways / way_nodes /
 * relations / relation_members）；几何回填（ways 的 bbox 与 length、relations 的 bbox、
 * node_index / way_index / relation_index 三个 R*Tree）**直接调用** `tools/import-osm.js` 导出的
 * `backfillGeometry`，不另写一份，避免"两套回填逻辑悄悄不一致"。
 *
 * 字段是**逐字段原样搬运**（tags 原样搬 JSON 字符串，不 JSON.parse 再 stringify）：
 * 一旦 parse 再 stringify，纯数字的标签键会被重排，对账脚本"内容一致"的结论就不成立了。
 *
 * 四、next_*_id 的处理（和对账脚本 ② 有关）
 * ----------------------------------------------------------------------------------
 * 所有分片都放在**同一个 OSM id 空间**里，所以每片的 next_*_id 统一取"两个来源库 next_*_id 的较大者"
 * （= 全局 OSM 最大 id + 1），而**不是**每片各取"自己表里的 max+1"。这样任何一片的发号起点
 * 都在所有片的已有 id 范围之外，`logs/shard-overlap-check.js` 的 ② 才会全绿；
 * 若各片各取 max+1，② 必然报警（分片共享 id 空间时那是假警报，本工具直接把这个坑堵掉）。
 */

const fs = require('fs');
const path = require('path');

// node:sqlite 在 require 阶段就会打印 ExperimentalWarning，早于 server/dbschema.js 里的静音处理，
// 这里提前拦掉（做法与 tools/import-osm.js 完全一致）
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};

const { DatabaseSync } = require('node:sqlite');
const { openDatabase, setMeta, getMeta } = require('../server/dbschema.js');
const { backfillGeometry, formatBytes } = require('./import-osm.js');

const ROOT = path.resolve(__dirname, '..');
const REGION_DIR = path.join(ROOT, 'data', 'regions');
const REGISTRY_FILE = path.join(REGION_DIR, 'registry.json');

/* ================================================================================== *
 * 矩形表（这一份是全部取舍的落点，改这里就是改分区方案）
 * ================================================================================== */

/** 半开区间 [min_lat, max_lat) × [min_lon, max_lon)：相邻片的公共边只属于一侧 */
const rect = (min_lat, max_lat, min_lon, max_lon) => Object.freeze({ min_lat, max_lat, min_lon, max_lon });

/**
 * 取舍说明（写在这里，免得下次有人对着数字猜）：
 *
 * 1) **北京为什么按 2×2 切，切在 lon=116.25 / lat=40.00**：
 *    这两条线是**按数据量量出来的**，不是按行政中心拍的。北京片的节点在经度上极度不均：
 *    lon 116.00~116.50 一条带就占 250 万（全片 482 万的一半以上），而 lon ≥ 117.25 只有 5.9 万。
 *    最初按"bbox 正中"切在 lon=116.46 时，四片是 301 万 / 77 万 / 53 万 / 51 万 —— **差 6 倍**，
 *    等于把整个城区塞进一片、另三片是空地，测不出分片的意义。改切 116.25 后，
 *    累积分布落在 116.25 处正好接近一半（西侧 232 万 / 东侧 253 万）；纬度线放在 40.00
 *    （南 260 万 / 北 222 万）。实测四片约 132 / 127 / 100 / 123 万节点，**最大最小差 1.3 倍**。
 *
 * 2) **河北为什么是"五个城市 + 一个承德补角"，而且承德那片是两个矩形**：
 *    矩形必须互不重叠（否则重开"嵌套冗余"的老问题），但北京片本身已经把
 *    lat 39.44~41.06 / lon 115.42~117.51 这块掏空了，而河北是要**绕着北京**兜一圈的。
 *    只用一个矩形表示承德，就必然要么盖住北京、要么在"北京正北那条带"
 *    （lat 41.06~42.70 / lon 115.42~117.51，即丰宁/围场，量不小）留个洞。
 *    所以 TILES 的 rects 允许是**矩形列表**：承德 = 北京以北的横带 + 北京以东的竖块，两块拼成 L 形。
 *    其余五片（廊坊 / 保定 / 沧州衡水 / 张家口 / 唐山）各用一个矩形。
 *
 * 3) **"矩形近似"的已知失真（明说，不假装精确）**：
 *    · 河北有若干"飞地/插花地"落进了北京片的矩形里 —— 最典型的是廊坊的三河、大厂、香河
 *      （在北京东侧、被北京和天津夹着）以及保定涿州、张家口怀来的一角。
 *      实测：北京 bbox 这个矩形里，河北片有 **579 万节点**，而北京片只有 482 万 ——
 *      多出来的约 97 万就是这些河北地界。它们**不会**被丢：按坐标归属，它们进了
 *      bj-sw / bj-se / bj-nw / bj-ne 四片（矩形近似，不追求行政边界正确）。
 *      这就是为什么本工具**不能**简单地"把北京矩形从河北里挖掉" —— 那会丢掉 97 万个真实节点。
 *    · 唐山片把遵化、迁西（纬度 > 40.25）划给了承德片；保定片把石家庄、邢台、邯郸
 *      一并算进来（lat 35.90~39.44 一整条）。片名只是"以谁为主"，不是行政边界。
 *
 * 4) **片数与规模**：共 10 片（目标 6~10）。切片规模量级相当：最小的 heb-zjk 约 100 万节点，
 *    最大的 heb-bd 约 290 万节点，其余都在 80~230 万之间，没有"一片吃掉半个省"的情况。
 *
 * 5) **外框**：所有矩形合起来覆盖 lat [35.90, 42.70) × lon [113.40, 120.10)，
 *    比两个来源库的 source_bounds（北京 lat 39.44~41.06 / lon 115.42~117.51；
 *    河北 lat 36.04~42.62 / lon 113.45~120.00）都略微外扩，尽量把野点也纳入正式矩形。
 */
const TILES = [
  {
    id: 'bj-sw', name: '北京·西南片', group: 'beijing',
    rects: [rect(39.4408, 40.00, 115.4155, 116.25)],
    note: '北京城区西半 + 房山/大兴/门头沟。lon<116.25 是量出来的均衡线，不是 bbox 中点。',
  },
  {
    id: 'bj-se', name: '北京·东南片', group: 'beijing',
    rects: [rect(39.4408, 40.00, 116.25, 117.5096)],
    note: '北京城区东半 + 通州/平谷南部。含廊坊三河·大厂·香河（河北飞地，矩形近似的已知失真）。',
  },
  {
    id: 'bj-nw', name: '北京·西北片', group: 'beijing',
    rects: [rect(40.00, 41.0639, 115.4155, 116.25)],
    note: '昌平/延庆/怀柔西部 + 门头沟北部。含张家口怀来一角（河北）。',
  },
  {
    id: 'bj-ne', name: '北京·东北片', group: 'beijing',
    rects: [rect(40.00, 41.0639, 116.25, 117.5096)],
    note: '顺义/密云/怀柔东部 + 平谷。含承德兴隆一角（河北）。',
  },
  {
    id: 'heb-lf', name: '河北·廊坊片', group: 'hebei',
    rects: [rect(38.80, 39.4408, 116.00, 117.5096)],
    note: '廊坊主体（北京正南）。三河/大厂/香河三个飞地在 bj-se 里，见取舍说明 3。',
  },
  {
    id: 'heb-ts', name: '河北·唐山片', group: 'hebei',
    rects: [rect(38.80, 40.25, 117.5096, 120.10)],
    note: '唐山（含秦皇岛方向直到 120.10）。遵化/迁西北部落在承德片。',
  },
  {
    id: 'heb-bd', name: '河北·保定片', group: 'hebei',
    rects: [rect(35.90, 39.4408, 113.40, 116.00)],
    note: '保定 + 石家庄 + 邢台/邯郸西侧，一条南北向长矩形（片名以保定为主）。本方案最大的一片。',
  },
  {
    id: 'heb-cz', name: '河北·沧州衡水片', group: 'hebei',
    rects: [rect(35.90, 38.80, 116.00, 120.10)],
    note: '沧州/衡水 + 邯郸东侧 + 邢台东部，河北东南角。',
  },
  {
    id: 'heb-zjk', name: '河北·张家口片', group: 'hebei',
    rects: [rect(39.4408, 42.70, 113.40, 115.4155)],
    note: '张家口全境（北京以西）。本方案最小的一片。',
  },
  {
    id: 'heb-cd', name: '河北·承德片', group: 'hebei',
    rects: [
      rect(40.25, 41.0639, 117.5096, 120.10),   // 北京以东（承德市区/兴隆/宽城/平泉）
      rect(41.0639, 42.70, 115.4155, 120.10),   // 北京正北那条带（丰宁/围场）
    ],
    note: '两段矩形拼成 L 形：绕开北京片，否则要么盖住北京、要么在北京正北留洞。见取舍说明 2。',
  },
];

/** 来源分片库（**只读**打开，绝不写；data/osm/osm.sqlite 是线上库，本工具根本不碰） */
const SOURCES = {
  beijing: { file: path.join(REGION_DIR, 'beijing.sqlite'), label: 'beijing.sqlite（Geofabrik china/beijing）' },
  hebei: { file: path.join(REGION_DIR, 'hebei.sqlite'), label: 'hebei.sqlite（Geofabrik china/hebei）' },
};
const SOURCE_KEYS = Object.keys(SOURCES);
/** relation 的处理顺序：**河北先**（它基本是超集），与阶段 ③ 的锁定顺序一致 */
const REL_ORDER = ['hebei', 'beijing'];

/* ================================================================================== *
 * 归属：坐标 → 片
 * ================================================================================== */

/** 半开区间判断：lat/lon 都取 [min, max) */
function inRect(r, lat, lon) {
  return lat >= r.min_lat && lat < r.max_lat && lon >= r.min_lon && lon < r.max_lon;
}

/** 落在某个矩形里的片下标；都不在返回 -1 */
function tileInside(lat, lon) {
  for (let i = 0; i < TILES.length; i++) {
    const rs = TILES[i].rects;
    for (let k = 0; k < rs.length; k++) if (inRect(rs[k], lat, lon)) return i;
  }
  return -1;
}

/** 点到矩形的最短平方距离（度²）；点在矩形内为 0 */
function rectDist2(r, lat, lon) {
  const dLat = lat < r.min_lat ? r.min_lat - lat : (lat > r.max_lat ? lat - r.max_lat : 0);
  const dLon = lon < r.min_lon ? r.min_lon - lon : (lon > r.max_lon ? lon - r.max_lon : 0);
  return dLat * dLat + dLon * dLon;
}

/** 就近归片（矩形外的野点用；距离相同取靠前的片，保证确定性） */
function tileNearest(lat, lon) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < TILES.length; i++) {
    const rs = TILES[i].rects;
    for (let k = 0; k < rs.length; k++) {
      const d = rectDist2(rs[k], lat, lon);
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  return best;
}

/**
 * 归属入口。返回 { tile, fallback }：fallback = true 表示该点不在任何矩形里、走了"就近归片"。
 * **所有元素（节点/way 的中间节点/关系）都只通过这一个函数定片**，所以"同一份几何"
 * 无论从哪个来源库读出来，都会落到同一片 —— 这也是"片间 way 同 id 必然为 0"的根据：
 * 两个来源库对同一条 way 的中间节点坐标相同（前序对账已实测内容逐字段一致），
 * 于是同 id 的 way 不可能被分到两片去。
 */
function route(lat, lon) {
  const t = tileInside(lat, lon);
  if (t >= 0) return { tile: t, fallback: false };
  return { tile: tileNearest(lat, lon), fallback: true };
}

/** 矩形表自检：两两不重叠（半开区间下，公共边不算重叠）+ 外框范围 */
function checkRectTable() {
  const problems = [];
  const flat = [];
  TILES.forEach((t, i) => t.rects.forEach((r, k) => flat.push({ i, k, r })));
  for (let a = 0; a < flat.length; a++) {
    for (let b = a + 1; b < flat.length; b++) {
      if (flat[a].i === flat[b].i) continue;                 // 同一片内部的多个矩形也不许重叠
      const A = flat[a].r;
      const B = flat[b].r;
      const overlap = A.min_lat < B.max_lat && B.min_lat < A.max_lat
        && A.min_lon < B.max_lon && B.min_lon < A.max_lon;
      if (overlap) problems.push(`${TILES[flat[a].i].id} 与 ${TILES[flat[b].i].id} 的矩形相交`);
    }
  }
  for (let a = 0; a < flat.length; a++) {
    for (let b = a + 1; b < flat.length; b++) {
      if (flat[a].i !== flat[b].i) continue;
      const A = flat[a].r;
      const B = flat[b].r;
      const overlap = A.min_lat < B.max_lat && B.min_lat < A.max_lat
        && A.min_lon < B.max_lon && B.min_lon < A.max_lon;
      if (overlap) problems.push(`${TILES[flat[a].i].id} 内部两个矩形相交`);
    }
  }
  return problems;
}

/** 一片的声明外框（其所有矩形的外包矩形）—— 写进 meta.source_bounds，供 logs/shard-bbox-check.js 用 */
function enclosingBbox(tile) {
  return {
    min_lat: Math.min(...tile.rects.map((r) => r.min_lat)),
    max_lat: Math.max(...tile.rects.map((r) => r.max_lat)),
    min_lon: Math.min(...tile.rects.map((r) => r.min_lon)),
    max_lon: Math.max(...tile.rects.map((r) => r.max_lon)),
  };
}

/* ================================================================================== *
 * 写库语句：列清单逐字对齐 tools/import-osm.js 的 insertElement
 * ================================================================================== */

const INSERT_NODE_SQL = 'INSERT OR REPLACE INTO nodes(id, lat, lon, version, tags, editor, editor_name, ts, deleted) VALUES(?,?,?,?,?,?,?,?,?)';
const INSERT_WAY_SQL = 'INSERT OR REPLACE INTO ways(id, version, tags, editor, editor_name, ts, deleted, node_count, closed) VALUES(?,?,?,?,?,?,?,?,?)';
const INSERT_WAY_NODE_SQL = 'INSERT OR REPLACE INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)';
const INSERT_RELATION_SQL = 'INSERT OR REPLACE INTO relations(id, version, tags, editor, editor_name, ts, deleted, member_count) VALUES(?,?,?,?,?,?,?,?)';
const INSERT_REL_MEMBER_SQL = 'INSERT OR REPLACE INTO relation_members(relation_id, seq, member_type, member_ref, role) VALUES(?,?,?,?,?)';

const SELECT_NODE_SQL = 'SELECT id, lat, lon, version, tags, editor, editor_name, ts, deleted FROM nodes WHERE id = ?';

const COMMIT_EVERY = 200000;   // 每 20 万行提交一次（来源库最大 2.9 GB，一次事务写到底会让 WAL 涨到 GB 级）

/** 一个目标分片的写入端。write=false 时是"干跑"的空壳，只累计计数，不建库 */
function makeTarget(tile, opts) {
  const t = {
    tile,
    id: tile.id,
    dbPath: path.join(REGION_DIR, tile.id + '.sqlite'),
    enabled: !!opts.write && (!opts.only || opts.only.has(tile.id)),
    db: null,
    pending: 0,
    counts: { nodes: 0, ways: 0, way_nodes: 0, relations: 0, relation_members: 0 },
    srcCounts: {},                     // 每片实际由哪些来源库贡献了多少要素
    supportNodes: 0,                   // 为了几何自洽额外复制进来的节点数
    fallback: { nodes: 0, ways: 0, relations: 0 },   // 走"就近归片"的元素数
    load: {},
  };
  for (const k of SOURCE_KEYS) t.srcCounts[k] = { nodes: 0, ways: 0, relations: 0 };
  if (!t.enabled) return t;
  if (fs.existsSync(t.dbPath) && !opts.force) {
    throw new Error(`目标库已存在：${t.dbPath}\n若要重新裁片请加 --force（会先删掉这个文件再重建）`);
  }
  if (opts.force && fs.existsSync(t.dbPath)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = t.dbPath + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  }
  t.db = openDatabase(t.dbPath);
  t.txOpen = false;
  t.stmt = {
    node: t.db.prepare(INSERT_NODE_SQL),
    way: t.db.prepare(INSERT_WAY_SQL),
    wayNode: t.db.prepare(INSERT_WAY_NODE_SQL),
    relation: t.db.prepare(INSERT_RELATION_SQL),
    relMember: t.db.prepare(INSERT_REL_MEMBER_SQL),
  };
  return t;
}

/**
 * 事务按需开启。**绝不能"提交后立刻再 BEGIN"**：那样会留一个空事务挂着，
 * 后面 backfillGeometry 自己的 `BEGIN` 就会撞上 "cannot start a transaction within a transaction"。
 */
function openTx(t) {
  if (t.db && !t.txOpen) {
    t.db.exec('BEGIN');
    t.txOpen = true;
  }
}

function commitTarget(t) {
  if (!t.db || !t.txOpen) return;
  t.db.exec('COMMIT');
  t.txOpen = false;
  t.pending = 0;
}

function closeTarget(t) {
  commitTarget(t);
}

function insertNodeRow(t, row, isSupport) {
  t.counts.nodes++;
  if (isSupport) t.supportNodes++;
  if (!t.db) return;
  openTx(t);
  t.stmt.node.run(row.id, row.lat, row.lon, row.version, row.tags, row.editor, row.editor_name, row.ts, row.deleted);
  if (++t.pending >= COMMIT_EVERY) commitTarget(t);
}

/* ================================================================================== *
 * 归属规则 ⑦：跨片 relation 的**副本**（让"成员跨片的 relation"不再从被选中的片里消失）
 * ================================================================================== *
 * ## 为什么必须有这一段（实测缺口，不是设想）
 * relation 按"**第一个能定位的成员 way 所在片**"归片（规则 ⑤），而服务端选片只看
 * **声明矩形**与视口是否相交（`server/regions.js` 的 `resolve()`，本工具一行都不改它）。
 * 于是一条"成员横跨数片"的 relation（长城、京广高速线这类几百/几千成员的关系）**必然漏**：
 * 它的属主片在别处，视口正好落在另一片时，这条关系既不在该片、属主片也没被选中。
 *
 * 实测（z16 天安门视口，见 tests/region-coverage-bench.js，参考单库 = hebei）：
 *   单库返回 452 条 relation，分区路径（只命中 bj-se 一片）只返回 406 条 ——
 *   缺的 46 条**全部**是"bbox 与视口相交"的关系（修前口径）。
 *
 * ## 做法
 * 把 canonical（属主片里的那一份）**复制进它的 bbox 触及的每一片**，并且：
 *   · `relations` 行、`relation_members` 行**逐字段等于属主片的那一份**（不裁剪、不重算、不重排）；
 *   · `relations` 的 bbox 四列与 `relation_index` 的那一行，取**来源库 relation_index 的同一行**
 *     （河北优先，取不到才用北京的——河北是超集）。理由：服务端判"这条关系在不在视口里"
 *     用的就是这一行的相交，所以"视口 ∩ 全局 bbox ≠ ∅ ⇒ 必存在一片返回它"是**构造性**成立的；
 *     若各片各写"本地成员算出来的 bbox"，副本的 bbox 是全局 bbox 的子集，
 *     "视口恰好落在本片、而本片没有这条关系的成员几何"时它照样会漏 —— 那就没修干净。
 *
 * ## 断言口径的改动（**必须一起改，不许留一条明知不成立的断言**）
 *   · 老口径"片间 relation 同 id 数 = 0" **不再成立**（副本本来就是同 id）；
 *   · 新口径（tests/tile-cut-bench.js ② 逐对实测）：
 *       ① 片间 relation 同 id 的每一对，**bbox 四列逐位相同**；
 *       ② 同 id 的**成员行逐条相同**（seq / member_type / member_ref / role 全等）；
 *       ③ 同 id 的 **version 与 member_count 相同**；
 *       ④ 每条 relation 的副本只出现在"bbox 触及的片 ∪ 属主片"里（不扩散到无关片）。
 *     于是副本之间**不可能内容打架**：服务端 `pickRelation` 面对的永远是同一份内容。
 *   · 仍然会产生的记账（**预期内，如实记**）：同一视口命中 ≥2 片、且某条副本关系的成员 way
 *     分散在两片时，两片各自裁剪出来的成员账本（`relations[id][3]`）不同 ⇒
 *     `server/regions.js` 的 `build()` 按 id 记一次 relation 冲突
 *     （`kind='derived-bbox'`、`reason='derived-bbox-extent-wins'`），明细进
 *     `truncation.regions[].conflicts`，并在 `stats.derivedConflicts` 累计；
 *     选择按"bbox 非 NULL → 面积大 → 成员账本更全 → 属主片 → id 升序"**确定性地**收敛。
 *     这不是新引入的噪声：修前这些关系根本不在候选里，连冲突都记不出来（`derived` 恒为 0）。
 *
 * ## 为什么不做 route A（选片关系化）
 * A 需要 `server/regions.js` 的 `resolve()` 在矩形相交之外**再查一张宽跨度关系索引**才会命中
 * 属主片；本任务明令不改 `server/**`，A 就只能做**数据侧的一半**（索引建好、但选片规则还是旧的），
 * "缺口归零"无法用**未改动的服务端**复现 —— 那等于用一个模拟出来的选片规则冒充实测。
 * 所以这里选 B；A 需要的服务端改动逐条写在交付报告里，由项目方决定。
 *
 * ## 已知代价（如实记，不粉饰）
 *   1. relation_members 行数变多（复制的代价），库变大：实测增量见 `--cross-tile --dry-run` 与报告；
 *   2. 多片视口多出 relation 冲突记账（上面已说明口径）；
 *   3. 副本的 `relations` bbox 可能**大于**该片手里真的有的成员几何 —— 这是有意的：
 *      bbox 在这里的语义是"这条关系**在全库**的几何范围"（= 来源库 relation_index 那一行），
 *      不是"这一片手里有多少"。R\*Tree 于是是**超集**，只会多返回候选、不会漏（漏才是本次要修的缺陷）。
 *      连带后果：某些视口会返回"成员几何不在本片"的关系（`kept` 只含本片真有的成员，
 *      服务端照旧把它记进 memberWaysMissing）—— 与单库相比是"关系在、成员几何不全"，
 *      比"关系整个消失"更接近单库语义，但**不等于**完整（见报告「没验证到的部分」）。
 */

/** 半开矩形 rect 与 bbox 是否相交 —— 与 `server/regions.js` 的 `resolve()` **同一口径**（闭区间比较） */
function rectHitsBbox(r, b) {
  return r.min_lat <= b.max_lat && r.max_lat >= b.min_lat
    && r.min_lon <= b.max_lon && r.max_lon >= b.min_lon;
}

/** 某片的库文件路径 */
const tileDbPath = (tile) => path.join(REGION_DIR, tile.id + '.sqlite');

/**
 * 读"每条 relation 现在都在哪几片里"（relId → [片下标]）。
 *
 * ⚠ **不能用"第一个持有它的片"当属主**：跨片副本一旦写进去，"谁是真属主"就**无法再从分片库反推**了
 * （第一次实现就是这么写的，重跑一次 `--cross-tile` 时把 bj-se 的副本当成"属主"，
 * 于是日志里的"副本条数"从 442 变成 331 —— 内容虽然没变，但口径已经不可复现了）。
 * 所以本函数只**如实报告**"这条 relation 在几片里有"，canonical 由 planCrossTile 按
 * **成员行数最多、并列取片下标最小**确定性地挑一份（副本内容逐条相同，挑谁都一样；
 * 立这条规则只是为了"同一份数据任何时候跑出来的规划都一致"）。
 */
function readTileRelationCopies() {
  const tilesOf = new Map();
  const missing = [];
  TILES.forEach((tile, i) => {
    const f = tileDbPath(tile);
    if (!fs.existsSync(f)) { missing.push(tile.id); return; }
    const d = new DatabaseSync(f, { readOnly: true });
    for (const r of d.prepare('SELECT id FROM relations').iterate()) {
      const id = Number(r.id);
      if (!tilesOf.has(id)) tilesOf.set(id, []);
      tilesOf.get(id).push(i);
    }
    d.close();
  });
  let multiTile = 0;
  for (const ts of tilesOf.values()) if (ts.length > 1) multiTile++;
  return { tilesOf, multiTile, missing };
}

/**
 * 来源库的 relation bbox（= 服务端判"在不在视口里"用的那一行）；河北优先。
 *
 * **读 `relations` 表的四列而不是 `relation_index`**：R*Tree 把坐标存成 32 位浮点
 * （实测 hebei：relations 27,922 行、relation_index 27,922 行，逐行比"值不同"，
 * 但差异只是 float32 舍入，例如 110.6494363 → 110.64942169189453）。
 * 写回时 R*Tree 还会再舍入一次，所以取双精度的基表值最准，且写进索引后与来源库那一行逐位相同。
 */
function readSourceRelBbox() {
  const out = new Map();          // relId → { min_lat, max_lat, min_lon, max_lon, src }
  for (const key of REL_ORDER) {
    const s = openSource(key);
    for (const r of s.prepare('SELECT id, min_lat, max_lat, min_lon, max_lon FROM relations').iterate()) {
      const id = Number(r.id);
      if (out.has(id)) continue;    // 河北（第一个）已经有了 → 不覆盖
      if (r.min_lat === null || r.max_lat === null || r.min_lon === null || r.max_lon === null) continue;
      out.set(id, {
        min_lat: Number(r.min_lat), max_lat: Number(r.max_lat),
        min_lon: Number(r.min_lon), max_lon: Number(r.max_lon), src: key,
      });
    }
    s.close();
  }
  return out;
}

/**
 * 读出某片里某条 relation 的 canonical 内容（relations 行 + 成员行）。
 * **canonical = 属主片里那一份**：那是阶段 ③ 按"成员更全者胜"合并出来的版本，
 * 复制必须搬这一份，不能改成"从来源库再读一遍"（否则副本与属主片的内容不再逐条相同，
 * "副本之间不可能内容打架"这条就没了）。
 */
function readTileRelationCopy(db, relId) {
  const row = db.prepare('SELECT id, version, tags, editor, editor_name, ts, deleted, member_count FROM relations WHERE id = ?').get(relId);
  if (!row) return null;
  const members = db.prepare('SELECT seq, member_type, member_ref, role FROM relation_members WHERE relation_id = ? ORDER BY seq').all(relId);
  return { row, members };
}

/**
 * 规划"跨片 relation 副本"。**只读**（分片库 readOnly、来源库 readOnly），不写任何东西。
 *
 * 返回 `plan` = **每一条有 bbox 的 relation 一条记录**（含只落一片的），字段：
 *   { id, ownerIdx, touched:[片下标], bbox, row|null, members|null }
 * `row` / `members` **只有 touched ≥ 2 的关系才装**（那才是要搬的副本；内存里不留多余的成员行）。
 * 只落一片的关系也要进 plan：它的 `relations` bbox 同样要覆盖成来源库那一行，
 * 否则"同一视口内每条关系的 bbox 都与参考库一致"这个口径就只在被复制的那批上成立。
 */
function planCrossTile() {
  const { tilesOf, multiTile, missing } = readTileRelationCopies();
  const idx = readSourceRelBbox();
  const touchedHist = {};
  const top = [];
  let replicated = 0;
  let extraRows = 0;
  let extraTiles = 0;
  let bboxFromSource = 0;
  let bboxFromTile = 0;
  let bboxNone = 0;
  let maxFanout = 0;
  const plan = [];
  /** 逐片懒开 + 语句缓存 */
  const dbs = new Map();
  const stmts = new Map();
  const openTile = (i) => {
    if (!dbs.has(i)) {
      const db = new DatabaseSync(tileDbPath(TILES[i]), { readOnly: true });
      dbs.set(i, db);
      stmts.set(i, {
        bbox: db.prepare('SELECT min_lat, max_lat, min_lon, max_lon, member_count FROM relations WHERE id = ?'),
      });
    }
    return dbs.get(i);
  };
  /** canonical：成员行数最多的一份，并列取片下标最小（副本内容逐条相同，挑谁都一样，只是要确定） */
  const canonicalOf = (ts, relId) => {
    let best = ts[0];
    let bestN = -1;
    for (const i of ts) {
      const r = stmts.get(i).bbox.get(relId);
      const n = r ? Number(r.member_count) || 0 : -1;
      if (n > bestN) { bestN = n; best = i; }
    }
    return best;
  };
  try {
    for (const [relId, ts] of tilesOf) {
      const tsSorted = ts.slice().sort((a, b) => a - b);
      for (const i of tsSorted) openTile(i);
      const ownerIdx = canonicalOf(tsSorted, relId);
      const odb = dbs.get(ownerIdx);
      const src = idx.get(relId);
      let bbox = null;
      if (src) { bbox = src; bboxFromSource++; } else {
        const cur = stmts.get(ownerIdx).bbox.get(relId);
        if (cur && cur.min_lat !== null && cur.max_lat !== null && cur.min_lon !== null && cur.max_lon !== null) {
          bbox = {
            min_lat: Number(cur.min_lat), max_lat: Number(cur.max_lat),
            min_lon: Number(cur.min_lon), max_lon: Number(cur.max_lon), src: 'tile',
          };
          bboxFromTile++;
        }
      }
      if (!bbox) { bboxNone++; continue; }   // 连 bbox 都没有：写进去也没人会查到它，如实计数并跳过
      const touched = [];
      TILES.forEach((tile, i) => { if (tile.rects.some((r) => rectHitsBbox(r, bbox))) touched.push(i); });
      for (const i of tsSorted) if (!touched.includes(i)) touched.push(i);   // 已有副本的片必须在"触及"集合里
      touched.sort((a, b) => a - b);
      if (touched.length > maxFanout) maxFanout = touched.length;
      touchedHist[touched.length] = (touchedHist[touched.length] || 0) + 1;
      const rec = { id: relId, ownerIdx, touched, bbox, row: null, members: null };
      if (touched.length >= 2) {
        const copy = readTileRelationCopy(odb, relId);
        if (!copy) continue;                 // canonical 读不到（半成品库）→ 不复制，如实少一条
        rec.row = copy.row;
        rec.members = copy.members;
        replicated++;
        extraTiles += touched.length - 1;
        extraRows += (touched.length - 1) * copy.members.length;
        if (top.length < 10 || copy.members.length > top[top.length - 1].memberCount) {
          top.push({ id: relId, memberCount: copy.members.length, touched: touched.map((i) => TILES[i].id) });
          top.sort((a, b) => b.memberCount - a.memberCount);
          if (top.length > 10) top.pop();
        }
      }
      plan.push(rec);
    }
  } finally {
    for (const db of dbs.values()) db.close();
  }
  return {
    tilesOf,
    plan,
    stats: {
      relTotal: tilesOf.size, multiTile, missingTiles: missing, withBbox: plan.length,
      replicated, extraTiles, extraRows,
      bboxFromSource, bboxFromTile, bboxNone, maxFanout, touchedHist, top,
      source: 'relations 表 bbox（河北 → 北京）',
    },
  };
}

/** 复制语句（列清单逐字对齐 insertElement / 阶段 ③） */
const UPDATE_REL_BBOX_SQL = 'UPDATE relations SET min_lat = ?, max_lat = ?, min_lon = ?, max_lon = ? WHERE id = ?';
const UPSERT_REL_INDEX_SQL = 'INSERT OR REPLACE INTO relation_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)';

/**
 * 把规划出来的副本真正写进分片库。
 *
 * **幂等且"重跑不改字节"**：先比对"这一片现有的 relations 行 + 成员行指纹"与 canonical 是否逐字段一致，
 * 一致就**一个字节都不写**（只跳过），不一致才 `DELETE` 成员行再整份插入。
 * 为什么必须这样：成员行动辄上百万，反复 DELETE+INSERT 会在库里留下大量空闲页（文件只涨不缩），
 * 而"重跑一次 `--cross-tile`"是这套流程的正常操作。
 *
 * 逐片一个事务；每片写完把 `cross_tile` 写进 meta（数量 + 时间 + 口径），于是"某片补过没有"可以自证。
 *
 * `opts.only`（Set of 片 id）可以只补指定几片（调试用；副本跨片才有意义，一般整批跑）。
 */
function applyCrossTile(planResult, opts = {}) {
  const log = opts.log || (() => {});
  const out = {
    tiles: {}, appliedRelations: 0, appliedMembers: 0, bboxOverrides: 0,
    unchangedRelations: 0, elapsedMs: 0,
  };
  const t0 = Date.now();
  /** 先把"每片要写什么"分好桶，再逐片开库（一进一出，不让 10 个库同时开着写） */
  const byTile = new Map();
  for (const rec of planResult.plan) {
    for (const ti of rec.touched) {
      if (opts.only && !opts.only.has(TILES[ti].id)) continue;
      if (!byTile.has(ti)) byTile.set(ti, []);
      byTile.get(ti).push(rec);
    }
  }
  /** canonical 成员指纹（与下面 SQL 里的 GROUP_CONCAT 表达式**逐字对应**，否则永远判不等 → 每次都重写） */
  const sigOf = (members) => members.map((m) => `${m.seq}:${m.member_type}:${m.member_ref}:${m.role === null || m.role === undefined ? '' : m.role}`).join('|');
  for (let i = 0; i < TILES.length; i++) {
    const tile = TILES[i];
    const items = byTile.get(i) || [];
    const f = tileDbPath(tile);
    if (!fs.existsSync(f)) { log(`   ${tile.id.padEnd(8)} 库不存在，跳过（${items.length} 条待写）`); continue; }
    if (!items.length) { out.tiles[tile.id] = { replicated: 0, members: 0, bboxOverrides: 0, note: '不在本次范围内' }; continue; }
    const db = openDatabase(f);
    const ts = Date.now();
    let repl = 0;
    let mem = 0;
    let bboxFix = 0;
    let same = 0;
    const stRel = db.prepare(INSERT_RELATION_SQL);
    const stMem = db.prepare(INSERT_REL_MEMBER_SQL);
    const stDel = db.prepare('DELETE FROM relation_members WHERE relation_id = ?');
    const stBbox = db.prepare(UPDATE_REL_BBOX_SQL);
    const stIdx = db.prepare(UPSERT_REL_INDEX_SQL);
    const stRow = db.prepare(`SELECT version, COALESCE(tags,'') AS tags, COALESCE(editor,'') AS editor,
                                     COALESCE(editor_name,'') AS editor_name, ts, deleted, member_count,
                                     min_lat, max_lat, min_lon, max_lon
                              FROM relations WHERE id = ?`);
    const stSig = db.prepare(`SELECT COUNT(*) AS n,
                                     (SELECT GROUP_CONCAT(s, '|') FROM (
                                        SELECT seq || ':' || member_type || ':' || member_ref || ':' || COALESCE(role,'') AS s
                                        FROM relation_members WHERE relation_id = ? ORDER BY seq)) AS sig
                              FROM relation_members WHERE relation_id = ?`);
    db.exec('BEGIN');
    let pending = 0;
    for (const rec of items.slice().sort((a, b) => a.id - b.id)) {
      const b = rec.bbox;
      const cur = stRow.get(rec.id);
      let need = false;
      if (rec.members) {
        if (!cur) need = true;
        else {
          const want = rec.row;
          const sig = stSig.get(rec.id, rec.id);
          need = Number(cur.version) !== Number(want.version)
            || cur.tags !== (want.tags || '')
            || cur.editor !== (want.editor || '')
            || cur.editor_name !== (want.editor_name || '')
            || (cur.ts === null ? null : Number(cur.ts)) !== (want.ts === null || want.ts === undefined ? null : Number(want.ts))
            || Number(cur.deleted || 0) !== Number(want.deleted || 0)
            || Number(cur.member_count) !== rec.members.length
            || Number(sig.n) !== rec.members.length
            || (sig.sig || '') !== sigOf(rec.members);
        }
      }
      if (need) {
        // 内容确实不一样（或这一片还没有）：整份搬过来（先删后插，保证不残留多余的 seq）
        stDel.run(rec.id);
        stRel.run(rec.id, rec.row.version, rec.row.tags, rec.row.editor, rec.row.editor_name, rec.row.ts,
          Number(rec.row.deleted) || 0, rec.members.length);
        for (const m of rec.members) stMem.run(rec.id, m.seq, m.member_type, m.member_ref, m.role);
        pending += rec.members.length + 2;
        repl++;
        mem += rec.members.length;
      } else if (rec.members) {
        same++;
      }
      // bbox 与 relation_index 一律对齐**来源库那一行**（副本之间"bbox 逐位相同"就是这么来的）；
      // 已经一致就不写（重跑一个字节都不改）。
      const bboxSame = !!cur && cur.min_lat === b.min_lat && cur.max_lat === b.max_lat
        && cur.min_lon === b.min_lon && cur.max_lon === b.max_lon;
      if (!bboxSame) {
        stBbox.run(b.min_lat, b.max_lat, b.min_lon, b.max_lon, rec.id);
        stIdx.run(rec.id, b.min_lon, b.max_lon, b.min_lat, b.max_lat);
        bboxFix++;
        pending += 2;
      }
      if (pending >= COMMIT_EVERY) { db.exec('COMMIT'); db.exec('BEGIN'); pending = 0; }
    }
    db.exec('COMMIT');
    const one = (sql) => db.prepare(sql).get().c;
    const counts = {
      nodes: one('SELECT COUNT(*) c FROM nodes'),
      ways: one('SELECT COUNT(*) c FROM ways'),
      relations: one('SELECT COUNT(*) c FROM relations'),
      way_nodes: one('SELECT COUNT(*) c FROM way_nodes'),
      relation_members: one('SELECT COUNT(*) c FROM relation_members'),
    };
    db.exec('BEGIN');
    setMeta(db, 'counts', JSON.stringify(counts));
    setMeta(db, 'cross_tile', JSON.stringify({
      version: CROSS_TILE_VERSION,
      at: new Date().toISOString(),
      replicated: repl, members: mem, bboxOverrides: bboxFix, unchanged: same,
      bboxSource: planResult.stats.source,
      note: '跨片 relation 副本：relations/relation_members 与属主片逐条相同；bbox 与 relation_index 取来源库 relations 那一行',
    }));
    db.exec('COMMIT');
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    db.close();
    out.tiles[tile.id] = {
      replicated: repl, members: mem, bboxOverrides: bboxFix, unchanged: same,
      relations: counts.relations, relation_members: counts.relation_members,
      dbMs: Date.now() - ts, bytes: fs.statSync(f).size,
    };
    out.appliedRelations += repl;
    out.appliedMembers += mem;
    out.bboxOverrides += bboxFix;
    out.unchangedRelations += same;
    log(`   ${tile.id.padEnd(8)} 副本关系 写入 ${String(repl).padStart(5)} 条 / 已一致跳过 ${String(same).padStart(5)} 条 `
      + `/ 成员行 ${String(mem).padStart(7)} · bbox 覆盖 ${String(bboxFix).padStart(5)} 条 · `
      + `relations=${counts.relations} members=${counts.relation_members} · `
      + `${formatBytes(out.tiles[tile.id].bytes)}（${out.tiles[tile.id].dbMs} ms）`);
  }
  out.elapsedMs = Date.now() - t0;
  log(`   合计：写入副本关系 ${out.appliedRelations} 条（另 ${out.unchangedRelations} 条内容已一致、未写）、`
    + `成员行 ${out.appliedMembers} 行、bbox 覆盖 ${out.bboxOverrides} 条（${(out.elapsedMs / 1000).toFixed(1)}s）`);
  return out;
}

/** 跨片副本功能的版本串（写进每片 meta 的 `cross_tile.version`，便于"这片补过没有"自证） */
const CROSS_TILE_VERSION = '1.0';

/* ================================================================================== *
 * 主流程
 * ================================================================================== */

function openSource(key) {
  const s = SOURCES[key];
  // readOnly：来源库**只读**，WAL 也不会被我们动
  return new DatabaseSync(s.file, { readOnly: true });
}

/**
 * 裁片主流程。write=false 时同一套代码只做量测（--plan）。
 * 三个阶段：① 节点按坐标入片；② way 按中间节点入片并带上它的全部节点；③ relation 按第一个
 * way 成员入片。最后逐片做几何回填 + meta。
 */
function cut(opts) {
  const problems = checkRectTable();
  if (problems.length) throw new Error('矩形表不合法（存在重叠）：\n  ' + problems.join('\n  '));

  const targets = TILES.map((tile) => makeTarget(tile, opts));
  const out = { targets, stats: { fallbackOut: 0, waysDropped: 0, relDropped: 0, nodeCountMismatch: 0, relSkippedDup: 0 } };
  const log = (m) => process.stdout.write(m + '\n');
  const t0 = Date.now();

  /* ---------------- 读来源库的 next_*_id（全局 id 空间，取较大者） ---------------- */
  const globalNext = { node: 0, way: 0, relation: 0 };
  const srcMeta = {};
  for (const key of SOURCE_KEYS) {
    const s = openSource(key);
    srcMeta[key] = {
      file: path.basename(SOURCES[key].file),
      bytes: fs.statSync(SOURCES[key].file).size,
      counts: JSON.parse(getMeta(s, 'counts', '{}')),
      imported_at: getMeta(s, 'imported_at', null),
      source_bounds: JSON.parse(getMeta(s, 'source_bounds', 'null')),
      next: {
        node: Number(getMeta(s, 'next_node_id', 0)),
        way: Number(getMeta(s, 'next_way_id', 0)),
        relation: Number(getMeta(s, 'next_relation_id', 0)),
      },
    };
    for (const k of ['node', 'way', 'relation']) {
      if (srcMeta[key].next[k] > globalNext[k]) globalNext[k] = srcMeta[key].next[k];
    }
    s.close();
  }
  out.globalNext = globalNext;
  out.srcMeta = srcMeta;

  /* ================= 阶段 ①：节点按自身坐标入片 ================= */
  log('① 节点按坐标入片 …');
  for (const key of SOURCE_KEYS) {
    const s = openSource(key);
    const st = s.prepare('SELECT id, lat, lon, version, tags, editor, editor_name, ts, deleted FROM nodes');
    let n = 0;
    const ts = Date.now();
    for (const row of st.iterate()) {
      const r = route(row.lat, row.lon);
      const t = targets[r.tile];
      if (r.fallback) { t.fallback.nodes++; out.stats.fallbackOut++; }
      insertNodeRow(t, row, false);
      t.srcCounts[key].nodes++;
      n++;
    }
    s.close();
    log(`   ${key}: nodes=${n}（${((Date.now() - ts) / 1000).toFixed(1)}s）`);
  }

  /* ================= 阶段 ②：way 按中间节点入片 + 带上全部节点 ================= */
  log('② way 按中间节点入片（并复制它用到的全部节点）…');
  for (const key of SOURCE_KEYS) {
    const s = openSource(key);
    const ts = Date.now();
    const wayIt = s.prepare(
      'SELECT id, version, tags, editor, editor_name, ts, node_count, closed FROM ways ORDER BY id').iterate();
    const wnIt = s.prepare('SELECT way_id, seq, node_id FROM way_nodes ORDER BY way_id, seq').iterate();
    const nodeStmt = s.prepare(SELECT_NODE_SQL);
    let cur = wnIt.next();
    const refs = [];
    const seqs = [];
    let n = 0;
    for (const w of wayIt) {
      refs.length = 0;
      seqs.length = 0;
      while (!cur.done && Number(cur.value.way_id) === Number(w.id)) {
        refs.push(cur.value.node_id);
        seqs.push(cur.value.seq);
        cur = wnIt.next();
      }
      if (refs.length !== Number(w.node_count)) out.stats.nodeCountMismatch++;
      if (!refs.length) { out.stats.waysDropped++; continue; }

      // 中间节点 = 节点序列的中点，下标 refs.length >> 1（1 个 → 0；2 个 → 1；3 个 → 1；4 个 → 2）
      const midIdx = refs.length >> 1;
      let anchor = nodeStmt.get(refs[midIdx]);
      if (!anchor) {
        // 来源库理论上不会悬挂（实测 0），但真遇到就从中点向两侧找第一个有坐标的节点，保证确定性
        for (let d = 1; d < refs.length && !anchor; d++) {
          if (midIdx - d >= 0) anchor = nodeStmt.get(refs[midIdx - d]);
          if (!anchor && midIdx + d < refs.length) anchor = nodeStmt.get(refs[midIdx + d]);
        }
      }
      if (!anchor) { out.stats.waysDropped++; continue; }

      const r = route(anchor.lat, anchor.lon);
      const t = targets[r.tile];
      if (r.fallback) { t.fallback.ways++; out.stats.fallbackOut++; }
      t.counts.ways++;
      t.counts.way_nodes += refs.length;
      t.srcCounts[key].ways++;
      if (t.db) {
        const n0 = refs.length;
        const closed = n0 >= 2 && refs[0] === refs[n0 - 1] ? 1 : 0;
        openTx(t);
        // node_count 写**实际序列长度**（与 way_nodes 的行数严格相等，见归属规则 ③）
        t.stmt.way.run(w.id, w.version, w.tags, w.editor, w.editor_name, w.ts, 0, n0, closed);
        for (let i = 0; i < n0; i++) t.stmt.wayNode.run(w.id, seqs[i], refs[i]);
        t.pending += n0 + 1;
        if (t.pending >= COMMIT_EVERY) commitTarget(t);
      }
      n++;
    }
    s.close();
    log(`   ${key}: ways=${n}（${((Date.now() - ts) / 1000).toFixed(1)}s）`);
  }

  /* ================= 阶段 ③：关系按"第一个成员 way 所在片"入片 ================= */
  /**
   * **relation 必须按 id 全局去重，不能像 way 那样"读两次、各算各的"** —— 这一点是实测踩出来的：
   *
   * way 的片只取决于**它自己**的中间节点，所以同一个 way id 无论从哪个来源库读，算出来都是同一片
   * （实测 45 对分片 way 同 id 全为 0）。**relation 不一样**：它的片取决于"第一个成员 way"，
   * 而"第一个成员 way"本身可能压根不在这个来源库里（提取包会把关系成员裁到包外），
   * 于是锚点会以**不同的方式**退让，同一个 relation id 就被算进了两片。
   *
   * 实例（实测）：relation 5869571（一个 8977 个成员的边界关系），两个来源库里的成员表**逐条相同**，
   * 但它的第一个 way 成员 202165095 在两个库里都**没有 way_nodes 行**；于是退让到"第一个 node 成员"，
   * 而这个 node 成员在一个来源库里有、在另一个里没有，最终落到 bbox 中心：
   * 北京片 bbox 中心 → bj-se，河北片 bbox 中心 → bj-sw —— **同一条关系进了两片**。
   *
   * 两道修正：
   *   a) **锚点取"第一个能定位的 way 成员"**（不是"第一个 way 成员"）：按成员顺序往下找，
   *      找到第一个在本来源库里真有几何的 way。成员动辄几千条，这样基本总能定位，少走退让路径；
   *   b) **按 relation id 全局去重**：先处理**河北**（它是超集：北京片的 518,666 条 way 一条不少地
   *      都在河北片里，实测切片前已核实），第一个能定片的关系就锁定它的片；后面来源库再遇到同 id，
   *      只有"成员更全"才覆盖进**同一片**（覆盖前先删掉旧的成员行，免得残留多余的 seq），
   *      否则直接跳过。这样"片间 relation 同 id 数 = 0"是**结构上**成立的，不依赖来源库长得一样。
   */
  log('③ relation 按第一个成员 way 所在片入片（按 id 全局去重）…');
  const relTile = new Map();       // relId → 片下标（跨来源锁定，保证一片只出现一次）
  const relCount = new Map();      // relId → 已写入版本的 member_count（用于"保留更全的版本"）
  for (const key of REL_ORDER) {
    const s = openSource(key);
    const ts = Date.now();
    const relIt = s.prepare(
      'SELECT id, version, tags, editor, editor_name, ts, member_count FROM relations ORDER BY id').iterate();
    const rmIt = s.prepare(
      'SELECT relation_id, seq, member_type, member_ref, role FROM relation_members ORDER BY relation_id, seq').iterate();
    // 取某条 way 的"中间节点坐标"：与阶段 ② 同一条规则（用实际 way_nodes 序列长度取中点）
    const refStmt = s.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq');
    const nodeStmt = s.prepare(SELECT_NODE_SQL);
    const hasWayStmt = s.prepare('SELECT 1 AS x FROM ways WHERE id = ?');
    const bboxStmt = s.prepare('SELECT min_lat, max_lat, min_lon, max_lon FROM relations WHERE id = ?');
    let cur = rmIt.next();
    const members = [];
    const anchorOfWay = (wayId) => {
      const list = refStmt.all(wayId);
      if (!list.length) return null;
      const mid = list.length >> 1;
      let a = nodeStmt.get(list[mid].node_id);
      for (let d = 1; d < list.length && !a; d++) {
        if (mid - d >= 0) a = nodeStmt.get(list[mid - d].node_id);
        if (!a && mid + d < list.length) a = nodeStmt.get(list[mid + d].node_id);
      }
      return a || null;
    };
    let n = 0;
    let merged = 0;
    for (const rel of relIt) {
      members.length = 0;
      while (!cur.done && Number(cur.value.relation_id) === Number(rel.id)) {
        members.push(cur.value);
        cur = rmIt.next();
      }
      /**
       * 定片的锚点，按顺序退让：
       *   1) **第一个能定位的 way 成员** → 该 way 的中间节点（正式规则，与 way 完全同一套代码）；
       *      注意是"能定位的"：成员表里排在前面、但不在本来源库里的 way 直接跨过（见上面的实测案例）；
       *   2) 第一个**能定位的** node 成员的坐标（只用了 way 成员的 relation 走这里）；
       *   3) relation 自己的 bbox 中心（成员全在包外时走这里，见下面注释）；
       *   4) 连 bbox 都没有 → 丢弃并计数。
       */
      let anchor = null;
      for (const m of members) {
        if (m.member_type !== 'way') continue;
        if (!hasWayStmt.get(m.member_ref)) continue;
        anchor = anchorOfWay(m.member_ref);
        if (anchor) break;
      }
      if (!anchor) {
        for (const m of members) {
          if (m.member_type !== 'node') continue;
          anchor = nodeStmt.get(m.member_ref);
          if (anchor) break;
        }
      }
      if (!anchor) {
        const bb = bboxStmt.get(rel.id);
        if (bb && bb.min_lat !== null && bb.min_lat !== undefined) {
          anchor = { lat: (Number(bb.min_lat) + Number(bb.max_lat)) / 2, lon: (Number(bb.min_lon) + Number(bb.max_lon)) / 2 };
        }
      }
      if (!anchor) { out.stats.relDropped++; continue; }

      // ---- 按 id 去重：同一个 relation id 只允许出现在一片里 ----
      const locked = relTile.get(rel.id);
      if (locked !== undefined) {
        const prev = relCount.get(rel.id) || 0;
        if (members.length <= prev) { out.stats.relSkippedDup++; continue; }   // 已有版本更全 → 跳过
        // 这一份成员更全 → 覆盖进**同一片**（先删旧成员行，避免旧的 seq 残留成孤儿）
        const t0 = targets[locked];
        if (t0.db) {
          openTx(t0);
          t0.db.prepare('DELETE FROM relation_members WHERE relation_id = ?').run(rel.id);
        }
        t0.counts.relation_members -= prev;
        relCount.set(rel.id, members.length);
        t0.counts.relation_members += members.length;
        t0.srcCounts[key].relations++;
        if (t0.db) {
          t0.stmt.relation.run(rel.id, rel.version, rel.tags, rel.editor, rel.editor_name, rel.ts, 0, members.length);
          for (const m of members) t0.stmt.relMember.run(rel.id, m.seq, m.member_type, m.member_ref, m.role);
          t0.pending += members.length + 1;
          if (t0.pending >= COMMIT_EVERY) commitTarget(t0);
        }
        merged++;
        continue;
      }

      const r = route(anchor.lat, anchor.lon);
      const t = targets[r.tile];
      relTile.set(rel.id, r.tile);
      relCount.set(rel.id, members.length);
      if (r.fallback) { t.fallback.relations++; out.stats.fallbackOut++; }
      t.counts.relations++;
      t.counts.relation_members += members.length;
      t.srcCounts[key].relations++;
      if (t.db) {
        openTx(t);
        t.stmt.relation.run(rel.id, rel.version, rel.tags, rel.editor, rel.editor_name, rel.ts, 0, members.length);
        for (const m of members) t.stmt.relMember.run(rel.id, m.seq, m.member_type, m.member_ref, m.role);
        t.pending += members.length + 1;
        if (t.pending >= COMMIT_EVERY) commitTarget(t);
      }
      n++;
    }
    s.close();
    log(`   ${key}: relations=${n}，与之前来源库合并（取更全版本）${merged} 条（${((Date.now() - ts) / 1000).toFixed(1)}s）`);
  }
  out.stats.relDistinct = relTile.size;

  if (!opts.write) {
    log(`\n干跑结束（未写任何库），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    log('注意：干跑不包含"几何支撑节点复制"的计数（那一步要在真库里做"哪些引用还缺"的查询）。');
    return out;
  }

  /* ================= 阶段 ④：补齐几何支撑节点（way 用到的节点若不在本片就复制进来） ================= */
  log('④ 补齐几何支撑节点（保证每片 way_nodes 引用的节点都在本片内）…');
  for (const t of targets) {
    if (!t.db) continue;
    commitTarget(t);
    const ts = Date.now();
    let copied = 0;
    for (const key of SOURCE_KEYS) {
      if (!t.srcCounts[key] || (!t.srcCounts[key].ways && !t.srcCounts[key].nodes)) continue;
      const missing = t.db.prepare(
        `SELECT wn.node_id AS id FROM way_nodes wn
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = wn.node_id)`).all();
      if (!missing.length) break;               // 已经补齐（后一个来源库只补前一个没有的）
      const s = openSource(key);
      const get = s.prepare(SELECT_NODE_SQL);
      for (const m of missing) {
        const row = get.get(m.id);
        if (row) { insertNodeRow(t, row, true); copied++; }
      }
      s.close();
    }
    commitTarget(t);
    t.copiedSupport = copied;
    log(`   ${t.id.padEnd(8)} 补入支撑节点 ${copied}（${((Date.now() - ts) / 1000).toFixed(1)}s）`);
  }

  /* ================= 阶段 ⑤：几何回填 + 索引（复用 import-osm 的 backfillGeometry） ================= */
  log('⑤ 几何回填（ways 的 bbox/length、relations 的 bbox、三个 R*Tree 索引）…');
  for (const t of targets) {
    if (!t.db) continue;
    const ts = Date.now();
    const g = backfillGeometry(t.db, () => {}, true);
    t.geom = g;
    t.load.geometryMs = Date.now() - ts;
    t.db.exec('BEGIN');
    setMeta(t.db, 'tile_id', t.tile.id);
    setMeta(t.db, 'tile_name', t.tile.name);
    setMeta(t.db, 'tile_group', t.tile.group);
    setMeta(t.db, 'tile_rects', JSON.stringify(t.tile.rects));
    setMeta(t.db, 'tile_bbox', JSON.stringify(enclosingBbox(t.tile)));
    setMeta(t.db, 'tile_note', t.tile.note);
    t.db.exec('COMMIT');
    log(`   ${t.id.padEnd(8)} way_index=${g.wayIndex} relation_index=${g.relIndex} node_index=${g.nodeIndex}（${t.load.geometryMs} ms）`);
  }

  /* ================= 阶段 ⑥：计数 + meta + 收尾 ================= */
  log('⑥ 计数、写 meta、checkpoint …');
  for (const t of targets) {
    if (!t.db) continue;
    const one = (sql) => t.db.prepare(sql).get().c;
    t.finalCounts = {
      nodes: one('SELECT COUNT(*) c FROM nodes'),
      ways: one('SELECT COUNT(*) c FROM ways'),
      relations: one('SELECT COUNT(*) c FROM relations'),
      way_nodes: one('SELECT COUNT(*) c FROM way_nodes'),
      relation_members: one('SELECT COUNT(*) c FROM relation_members'),
    };
    const box = t.db.prepare(
      'SELECT MIN(lat) AS min_lat, MAX(lat) AS max_lat, MIN(lon) AS min_lon, MAX(lon) AS max_lon FROM nodes').get();
    const bb = enclosingBbox(t.tile);
    t.db.exec('BEGIN');
    // source_file 写清来源片：这一片实际由哪些来源库贡献过要素
    const used = SOURCE_KEYS.filter((k) => t.srcCounts[k].nodes || t.srcCounts[k].ways || t.srcCounts[k].relations);
    setMeta(t.db, 'source_file', used.map((k) => srcMeta[k].file).join('+'));
    setMeta(t.db, 'source_format', 'tile-cut');
    setMeta(t.db, 'source_version', '0.6');
    setMeta(t.db, 'imported_at', new Date().toISOString());
    setMeta(t.db, 'cut_from', JSON.stringify(used.map((k) => ({
      file: srcMeta[k].file, nodes: t.srcCounts[k].nodes, ways: t.srcCounts[k].ways, relations: t.srcCounts[k].relations,
    }))));
    setMeta(t.db, 'counts', JSON.stringify(t.finalCounts));
    setMeta(t.db, 'data_bbox', JSON.stringify(box.min_lat === null ? null : box));
    setMeta(t.db, 'source_bounds', JSON.stringify(bb));
    setMeta(t.db, 'default_center', JSON.stringify({
      lat: (bb.min_lat + bb.max_lat) / 2, lon: (bb.min_lon + bb.max_lon) / 2,
    }));
    // 全局 id 空间：所有片统一用"两个来源库 next_*_id 的较大者"，见文件头第四节
    setMeta(t.db, 'next_node_id', globalNext.node);
    setMeta(t.db, 'next_way_id', globalNext.way);
    setMeta(t.db, 'next_relation_id', globalNext.relation);
    t.db.exec('COMMIT');
    try { t.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    t.bytes = fs.existsSync(t.dbPath) ? fs.statSync(t.dbPath).size : 0;
    closeTarget(t);
    t.db.close();
    t.db = null;
    log(`   ${t.id.padEnd(8)} nodes=${t.finalCounts.nodes} ways=${t.finalCounts.ways} relations=${t.finalCounts.relations} 库 ${formatBytes(t.bytes)}`);
  }

  /* ================= 阶段 ⑦：跨片 relation 副本（规则 ⑦）================= */
  /**
   * **必须在阶段 ⑤ 之后**：⑤ 的 backfillGeometry 会把每片的 relations bbox 重算成
   * "本片手里有多少成员几何"，本阶段再用**来源库 relation_index 的那一行**把它统一覆盖掉
   * （局部 bbox 是子集，会让"视口落在本片、而本片没有这条关系的成员几何"时照样漏 —— 那正是要修的缺口）。
   * 也**必须在所有分片库关掉之后**：本阶段要另开只读连接读各片的 canonical 内容（属主片那一份）。
   */
  log('⑦ 跨片 relation 副本（把成员跨片的关系复制进它的 bbox 触及的每一片）…');
  {
    const planResult = planCrossTile();
    const s = planResult.stats;
    log(`   规划：${s.relTotal} 条 relation（有 bbox 的 ${s.withBbox} 条）· 需要副本的 ${s.replicated} 条 · `
      + `副本数 ${s.extraTiles} 份 · 多出成员行 ${s.extraRows} 行 · 最大触及片数 ${s.maxFanout}`);
    log(`   触及片数分布：${Object.keys(s.touchedHist).sort((a, b) => a - b).map((k) => `${k} 片→${s.touchedHist[k]} 条`).join(' · ')}`
      + `（bbox 来源：${s.source} ${s.bboxFromSource} 条 / 片内既有 ${s.bboxFromTile} 条 / 无 bbox 跳过 ${s.bboxNone} 条）`);
    if (s.multiTile) log(`   （其中 ${s.multiTile} 条 relation 现在在 ≥2 片里各有一份 —— 本阶段做的就是这个，重跑时不要当成异常）`);
    if (s.missingTiles.length) log(`   ⚠ 缺库的片：${s.missingTiles.join(',')}（这些片不会被补/被覆盖）`);
    const applied = applyCrossTile(planResult, { log, only: opts.only });
    out.crossTile = { stats: s, applied };
  }

  out.elapsedMs = Date.now() - t0;
  return out;
}

/* ================================================================================== *
 * registry.json
 * ================================================================================== */

function writeRegistry(cutResult) {
  const tiles = [];
  for (const t of cutResult.targets) {
    const dbPath = path.join(REGION_DIR, t.id + '.sqlite');
    if (!fs.existsSync(dbPath)) continue;
    const d = new DatabaseSync(dbPath, { readOnly: true });
    const one = (sql) => d.prepare(sql).get().c;
    const counts = {
      nodes: one('SELECT COUNT(*) c FROM nodes'),
      ways: one('SELECT COUNT(*) c FROM ways'),
      relations: one('SELECT COUNT(*) c FROM relations'),
      way_nodes: one('SELECT COUNT(*) c FROM way_nodes'),
      relation_members: one('SELECT COUNT(*) c FROM relation_members'),
    };
    const get = (k) => getMeta(d, k, null);
    const crossTile = JSON.parse(get('cross_tile') || 'null');
    tiles.push({
      id: t.tile.id,
      name: t.tile.name,
      group: t.tile.group,
      db: 'data/regions/' + t.tile.id + '.sqlite',
      rects: t.tile.rects,
      bbox: enclosingBbox(t.tile),
      bytes: fs.statSync(dbPath).size,
      counts,
      indexes: {
        node_index: one('SELECT COUNT(*) c FROM node_index'),
        way_index: one('SELECT COUNT(*) c FROM way_index'),
        relation_index: one('SELECT COUNT(*) c FROM relation_index'),
      },
      data_bbox: JSON.parse(get('data_bbox') || 'null'),
      source_file: get('source_file'),
      cut_from: JSON.parse(get('cut_from') || '[]'),
      generated_at: get('imported_at'),
      cross_tile: crossTile,
      note: t.tile.note,
    });
    d.close();
  }
  const tot = { nodes: 0, ways: 0, relations: 0, way_nodes: 0, relation_members: 0, bytes: 0 };
  for (const t of tiles) {
    for (const k of Object.keys(tot)) tot[k] += (t.counts[k] !== undefined ? t.counts[k] : t.bytes);
  }
  const reg = {
    generated_at: new Date().toISOString(),
    generator: 'tools/tile-cut.js',
    note: '矩形网格裁片：片间 way 同 id 数为 0；同 id 节点一定是被复制过来的几何支撑节点，坐标逐位相同；'
      + '**跨片 relation 会被复制进它的 bbox 触及的每一片**（同 id 副本的 bbox 与成员行逐位/逐条相同），'
      + '所以"片间 relation 同 id 数"不再为 0 —— 见 method.assignment 与 method.cross_tile。',
    method: {
      assignment: [
        '矩形用半开区间 [min,max)，相邻片公共边只属于一侧 → 一个坐标不可能落进两片',
        'node(POI) 按自身坐标归片',
        'way 整条只进一片，归属看中间节点：mid = refs.length >> 1（refs 为从 way_nodes 按 seq 读出的实际序列）',
        'way 用到的全部节点都复制进该 way 所在片（片间同 id 节点的来源）',
        'relation 先按"第一个能定位的成员 way 所在片"定**属主片**（简化：不做成员级拆分，node 成员可能悬挂）',
        '**跨片 relation 副本**：再把属主片那一份复制进它的 bbox 触及的每一片（见 cross_tile）—— '
          + '否则"成员横跨数片"的关系会从被选中的片里整个消失（服务端选片只看声明矩形）',
        '落在所有矩形之外的点就近归片（不丢数据）',
      ],
      disjointness: 'TILES 的矩形两两不相交（工具启动时自检，相交直接报错退出）',
      cross_tile: {
        version: CROSS_TILE_VERSION,
        what: '把每条 relation 复制进"它的 bbox 触及的每一片"（含属主片），副本之间 bbox 逐位相同、成员行逐条相同',
        why: '服务端选片只看声明矩形（server/regions.js 的 resolve()，本工具不改它）；relation 若只放在属主片里，'
          + '"成员横跨数片"的关系必然从别的片的视口里整个消失（实测 z16 天安门视口：修前缺 46 条 bbox 相交的 relation）',
        bbox_rule: '副本的 relations bbox 与 relation_index 行 = 来源库 relation_index 的那一行（河北优先），'
          + '所以"视口 ∩ 全局 bbox ≠ ∅ ⇒ 必有一片返回它"是构造性成立的',
        assertion: '片间 relation 同 id 数**不再为 0**；新口径见 tests/tile-cut-bench.js ②：'
          + '同 id 副本 bbox 逐位相同 / 成员行逐条相同 / version 与 member_count 相同 / 副本只出现在 bbox 触及的片里',
        conflict_accounting: '同一视口命中 ≥2 片时，两片各自裁剪出的成员账本可能不同 ⇒ 服务端按 id 记一次 relation 冲突'
          + '（kind=derived-bbox，明细进 truncation.regions[].conflicts），选择规则确定性地收敛到"派生量更全"的那一份',
      },
      next_ids: JSON.parse(JSON.stringify(cutResult.globalNext)),
      next_ids_reason: '所有分片共享同一个 OSM id 空间，故每片 next_*_id 统一取两个来源库的较大者（= 全局最大 id + 1），避免各片"自己 max+1"以后撞号',
    },
    /** 每片一条：这一片的跨片副本记账（来自片内 meta.cross_tile） */
    cross_tile: cutResult.crossTile
      ? { stats: cutResult.crossTile.stats, applied: cutResult.crossTile.applied && {
        appliedRelations: cutResult.crossTile.applied.appliedRelations,
        appliedMembers: cutResult.crossTile.applied.appliedMembers,
        bboxOverrides: cutResult.crossTile.applied.bboxOverrides,
        elapsedMs: cutResult.crossTile.applied.elapsedMs,
      } }
      : null,
    sources: Object.keys(cutResult.srcMeta).map((k) => ({
      key: k,
      file: 'data/regions/' + cutResult.srcMeta[k].file,
      bytes: cutResult.srcMeta[k].bytes,
      counts: cutResult.srcMeta[k].counts,
      imported_at: cutResult.srcMeta[k].imported_at,
      source_bounds: cutResult.srcMeta[k].source_bounds,
      next: cutResult.srcMeta[k].next,
    })),
    tiles,
    totals: tot,
  };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n');
  return reg;
}

/* ================================================================================== *
 * 命令行
 * ================================================================================== */

const USAGE = [
  '用法：node tools/tile-cut.js --plan',
  '      node tools/tile-cut.js --run [--only id,id] [--force]',
  '      node tools/tile-cut.js --registry',
  '      node tools/tile-cut.js --cross-tile [--dry-run] [--only id,id]',
  '  --plan        只量测（干跑，走同一套归属代码），不建库',
  '  --run         真正裁片 → data/regions/<id>.sqlite + data/regions/registry.json（含阶段 ⑦ 跨片 relation 副本）',
  '  --registry    不裁片，仅按现有分片库重建 registry.json',
  '  --cross-tile  只补"跨片 relation 副本"（阶段 ⑦）到**现有**分片库上，不重裁；幂等，可反复跑',
  '  --dry-run     与 --cross-tile 搭配：只打印规划（要写多少条副本 / 多少行成员），一个字都不写',
  '  --only        只处理指定分片（逗号分隔）',
  '  --force       目标库已存在时删掉重建（默认拒绝覆盖）',
].join('\n');

function parseArgs(argv) {
  const out = { plan: false, run: false, registry: false, crossTile: false, dryRun: false, force: false, only: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const val = eq === -1 ? null : a.slice(eq + 1);
    const take = () => {
      if (val !== null) return val;
      i++;
      if (i >= argv.length) throw new Error('参数 ' + key + ' 缺少取值');
      return argv[i];
    };
    switch (key) {
      case '--plan': out.plan = true; break;
      case '--run': out.run = true; break;
      case '--registry': out.registry = true; break;
      case '--cross-tile': out.crossTile = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--force': out.force = true; break;
      case '--only': out.only = new Set(take().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (key.startsWith('-')) throw new Error('未知参数：' + key);
    }
  }
  return out;
}

function printPlan(result) {
  const rows = result.targets.map((t) => ({
    id: t.id, name: t.tile.name, group: t.tile.group,
    nodes: t.counts.nodes, ways: t.counts.ways, relations: t.counts.relations,
    fb: t.fallback.nodes + t.fallback.ways + t.fallback.relations,
    rects: t.tile.rects.length,
  }));
  process.stdout.write('\n===== 裁片方案干跑（未写库）=====\n');
  process.stdout.write('片 id     片名                组      矩形数  nodes       ways      relations  就近归片\n');
  for (const r of rows) {
    process.stdout.write(
      r.id.padEnd(9) + r.name.padEnd(20) + r.group.padEnd(8) + String(r.rects).padStart(5) + '  '
      + String(r.nodes).padStart(10) + '  ' + String(r.ways).padStart(9) + '  '
      + String(r.relations).padStart(8) + '  ' + String(r.fb).padStart(8) + '\n');
  }
  const s = rows.reduce((a, r) => ({
    nodes: a.nodes + r.nodes, ways: a.ways + r.ways, relations: a.relations + r.relations, fb: a.fb + r.fb,
  }), { nodes: 0, ways: 0, relations: 0, fb: 0 });
  process.stdout.write('-'.repeat(96) + '\n');
  process.stdout.write('合计'.padEnd(37) + '  ' + String(s.nodes).padStart(10) + '  ' + String(s.ways).padStart(9)
    + '  ' + String(s.relations).padStart(8) + '  ' + String(s.fb).padStart(8) + '\n');
  const ns = rows.map((r) => r.nodes).sort((a, b) => a - b);
  process.stdout.write(`\n节点规模：最小 ${ns[0]}，最大 ${ns[ns.length - 1]}，最大/最小 = `
    + `${(ns[ns.length - 1] / ns[0]).toFixed(2)} 倍；way 丢弃 ${result.stats.waysDropped}，`
    + `relation 丢弃 ${result.stats.relDropped}（去重后共 ${result.stats.relDistinct || 0} 条唯一 relation），`
    + `因"另一来源库已有更全版本"跳过 ${result.stats.relSkippedDup} 条，`
    + `node_count 与引用行数不一致的 way ${result.stats.nodeCountMismatch}\n`);
}

/** 来源库的元信息（`--registry` / `--cross-tile` 两条"不重裁"路径共用） */
function readSourceMeta() {
  const srcMeta = {};
  for (const key of SOURCE_KEYS) {
    if (!fs.existsSync(SOURCES[key].file)) {
      srcMeta[key] = { file: path.basename(SOURCES[key].file), bytes: 0, counts: null, imported_at: null, source_bounds: null, next: {} };
      continue;
    }
    const s = openSource(key);
    srcMeta[key] = {
      file: path.basename(SOURCES[key].file),
      bytes: fs.statSync(SOURCES[key].file).size,
      counts: JSON.parse(getMeta(s, 'counts', '{}')),
      imported_at: getMeta(s, 'imported_at', null),
      source_bounds: JSON.parse(getMeta(s, 'source_bounds', 'null')),
      next: {
        node: Number(getMeta(s, 'next_node_id', 0)),
        way: Number(getMeta(s, 'next_way_id', 0)),
        relation: Number(getMeta(s, 'next_relation_id', 0)),
      },
    };
    s.close();
  }
  return srcMeta;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) {
    process.stderr.write('参数错误：' + err.message + '\n' + USAGE + '\n');
    process.exitCode = 1;
    return;
  }
  if (args.help || (!args.plan && !args.run && !args.registry && !args.crossTile)) {
    process.stdout.write(USAGE + '\n');
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  try {
    /* ---------- 只补跨片 relation 副本（阶段 ⑦）：不重裁，幂等 ---------- */
    if (args.crossTile && !args.run && !args.plan) {
      const planResult = planCrossTile();
      const s = planResult.stats;
      process.stdout.write('===== 跨片 relation 副本规划（只读）=====\n');
      process.stdout.write(`每片合起来一共 ${s.relTotal} 条 relation（其中 bbox 可用的 ${s.withBbox} 条，无 bbox 跳过 ${s.bboxNone} 条）\n`);
      process.stdout.write(`已经在 ≥2 片里有副本的：${s.multiTile} 条（第一次跑时是 0；重跑时这段数只说明"副本还在"）\n`);
      process.stdout.write(`bbox 来源：${s.source} ${s.bboxFromSource} 条 / 片内既有 ${s.bboxFromTile} 条\n`);
      process.stdout.write(`需要副本的 relation ${s.replicated} 条 · 副本份数 ${s.extraTiles} · 多出成员行 ${s.extraRows} 行 · 最大触及片数 ${s.maxFanout}\n`);
      process.stdout.write('触及片数分布：' + Object.keys(s.touchedHist).sort((a, b) => a - b)
        .map((k) => `${k} 片→${s.touchedHist[k]} 条`).join(' · ') + '\n');
      if (s.top.length) {
        process.stdout.write('成员最多的几条（看看是谁在跨片）：\n');
        for (const t of s.top) process.stdout.write(`   rel ${String(t.id).padStart(10)}  成员 ${String(t.memberCount).padStart(6)}  触及 ${t.touched.join(',')}\n`);
      }
      if (s.missingTiles.length) process.stdout.write(`⚠ 缺库的片：${s.missingTiles.join(',')}\n`);
      if (args.dryRun) {
        process.stdout.write('\n--dry-run：一个字节都没写。\n');
        return;
      }
      const applied = applyCrossTile(planResult, {
        log: (m) => process.stdout.write(m + '\n'),
        only: args.only,
      });
      process.stdout.write('\n副本写入完成，重建 registry …\n');
      // registry 里的 counts / indexes 必须跟着更新（副本改了 relation_members 与 relation_index）
      const globalNext = { node: 0, way: 0, relation: 0 };
      for (const tile of TILES) {
        const f = path.join(REGION_DIR, tile.id + '.sqlite');
        if (!fs.existsSync(f)) continue;
        const d = new DatabaseSync(f, { readOnly: true });
        for (const [k, key] of [['node', 'next_node_id'], ['way', 'next_way_id'], ['relation', 'next_relation_id']]) {
          const v = Number(getMeta(d, key, 0));
          if (v > globalNext[k]) globalNext[k] = v;
        }
        d.close();
      }
      const srcMeta = readSourceMeta();
      const reg = writeRegistry({
        targets: TILES.map((tile) => ({ tile, id: tile.id })), globalNext, srcMeta,
        crossTile: { stats: s, applied },
      });
      process.stdout.write(`registry 已重写：${REGISTRY_FILE}（${reg.tiles.length} 片，relation_members 合计 ${reg.totals.relation_members}）\n`);
      return;
    }
    if (args.registry && !args.run && !args.plan) {
      // 只重建 registry：next_*_id 从**现有分片库**的 meta 读回来（不能写 0），来源信息从来源库读
      const globalNext = { node: 0, way: 0, relation: 0 };
      for (const tile of TILES) {
        const f = path.join(REGION_DIR, tile.id + '.sqlite');
        if (!fs.existsSync(f)) continue;
        const d = new DatabaseSync(f, { readOnly: true });
        for (const [k, key] of [['node', 'next_node_id'], ['way', 'next_way_id'], ['relation', 'next_relation_id']]) {
          const v = Number(getMeta(d, key, 0));
          if (v > globalNext[k]) globalNext[k] = v;
        }
        d.close();
      }
      const srcMeta = readSourceMeta();
      // 副本规划的汇总（只读；来源库缺了就不算，registry 里如实写 null）
      let crossTile = null;
      try { crossTile = { stats: planCrossTile().stats, applied: null }; } catch (err) {
        process.stdout.write(`（跨片副本规划未重算：${err.message}）\n`);
      }
      const reg = writeRegistry({ targets: TILES.map((tile) => ({ tile, id: tile.id })), globalNext, srcMeta, crossTile });
      process.stdout.write(`registry 已写：${REGISTRY_FILE}（${reg.tiles.length} 片）\n`);
      return;
    }
    const result = cut({ write: args.run, force: args.force, only: args.only });
    if (args.plan) {
      printPlan(result);
      return;
    }
    const reg = writeRegistry(result);
    process.stdout.write(`\n裁片完成：${reg.tiles.length} 片，合计 nodes=${reg.totals.nodes} ways=${reg.totals.ways} `
      + `relations=${reg.totals.relations}，库合计 ${formatBytes(reg.totals.bytes)}\n`);
    process.stdout.write(`registry：${REGISTRY_FILE}\n`);
    process.stdout.write(`耗时 ${(result.elapsedMs / 1000).toFixed(1)}s；就近归片 ${result.stats.fallbackOut} 个元素；`
      + `way 丢弃 ${result.stats.waysDropped}，relation 丢弃 ${result.stats.relDropped}（唯一 relation ${result.stats.relDistinct} 条，`
      + `跨来源去重跳过 ${result.stats.relSkippedDup} 条）\n`);
  } catch (err) {
    process.stderr.write('裁片失败：' + (err && err.message ? err.message : String(err)) + '\n');
    if (err && err.stack && process.env.TILE_CUT_DEBUG) process.stderr.write(err.stack + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  TILES, SOURCES, REL_ORDER, CROSS_TILE_VERSION,
  route, inRect, checkRectTable, enclosingBbox, cut, writeRegistry, parseArgs,
  rectHitsBbox, planCrossTile, applyCrossTile, readTileRelationCopies,
};
