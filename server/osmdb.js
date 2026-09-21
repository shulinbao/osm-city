'use strict';
/**
 * OSM 数据访问层：视口查询、元素读写、空间索引维护、变更日志与导出。
 *
 * 所有几何都存 WGS84 经纬度；R*Tree 索引列顺序为 (id, min_lon, max_lon, min_lat, max_lat)。
 * 元素采用"软删除"（deleted=1）以便历史和回滚，视口查询会过滤掉。
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  openDatabase, getMeta, setMeta, IdAllocator,
  backfillWayLod, ensureLodIndexes, WAY_LOD_INDEX, NODE_POI_INDEX, NODE_POI_LOW_PREDICATE,
} = require('./dbschema');
/**
 * 预计算低缩放显示图层（见 server/displaylod.js 的文件头那一段）。
 * 这里只用它的**纯函数**（瓦片网格 / 裁剪 / 稳定 id / 签名 / 表名与建表 SQL）——
 * 几何 blob 的编解码留在本文件（`packLodPaths` / `unpackLodPaths`），因为它要复用
 * 上面「紧凑载荷」那套量化 + 差分编码（`packPathFlat`），**不另发明一套**。
 */
const DLOD = require('./displaylod');

/**
 * ==================== 只读打开（分片库专用，见 server/regions.js） ====================
 *
 * `openDatabase()` 是"服务端自己那个库"的打开方式：它会 `PRAGMA journal_mode = WAL`、
 * 跑 `SCHEMA_SQL` 与迁移、允许回填**写**。**分片库一律不能用它**：
 * 分区流式的第一阶段（P1）分片是**只读素材**（写路径仍然只走主库，见 server/regions.js 的说明），
 * 一旦用可写连接打开分片，启动时的迁移/回填/自愈就会去改那些 .sqlite 文件。
 *
 * 所以这里给一个只读连接（实测：`new DatabaseSync(file, {readOnly:true})` 可以 prepare 写语句，
 * 但执行时被 SQLite 拒绝：`attempt to write a readonly database`；`temp_store` / `cache_size`
 * 是**连接级** pragma，只读库照样能设）。
 * 服务端会跳过全部"自愈/回填/建索引"路径（见 OsmDB 构造函数里的 `this.readOnly` 分支）。
 */
function openReadOnlyDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -64000');
  return db;
}

/**
 * 只读库的 `road_class / lod_zoom` 抽查（替代 `backfillWayLod()` 的写路径）：
 * 抽 3000 行看物化列填过没有 —— 填过就用低缩放计划，没填过就退回 R*Tree（慢一点，绝不少要素）。
 */
function lodColumnsFilled(db) {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM (SELECT lod_zoom FROM ways LIMIT 3000) WHERE lod_zoom IS NULL').get();
    return !!row && row.c === 0;
  } catch {
    return false;
  }
}

const EARTH_R = 6378137;
const D2R = Math.PI / 180;

function metersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function parseTags(json) {
  if (!json) return null;
  try {
    const t = JSON.parse(json);
    return t && Object.keys(t).length ? t : null;
  } catch {
    return null;
  }
}

function stringifyTags(tags) {
  if (!tags) return null;
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    const key = String(k).trim();
    if (!key || v === null || v === undefined) continue;
    const val = String(v).trim();
    if (!val) continue;
    out[key] = val;
    if (Object.keys(out).length >= 200) break;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/* ------------------------- 视口查询的上限（可配置） ------------------------- */
/**
 * 三个"候选/条数"上限的默认值，可以被 config.json 的 limits.* 覆盖（index.js 会透传进来）：
 *   limits.wayCandidates   候选 way 的扫描上限 = viewportLimit × 这个倍数（默认 12）
 *   limits.nodeCandidates  候选节点的扫描上限 = viewportLimit × 这个倍数（默认 8）
 *   limits.relationLimit   bbox 内关系的条数上限（默认 10000）
 * 上限只是"一次请求最多看多少"，不是"假装数据只有这么多"：被砍掉的部分会在
 * truncation 里如实报出来（见 queryBbox 的说明），客户端据此拆块直到每一块都完整。
 *
 * 默认值是**实测**挑出来的（tests/tmp-groupundo/probe-multiplier.js，北京真实数据集）：
 *   · 候选是懒取的（挑满返回上限就停），所以把上限放宽几乎不花钱：
 *     z13 看 5 万行 92 ms、z10 看 18 万行 325 ms；而交付量 z10 6720 → 11138、z12 11481 → 15000（打满返回上限）；
 *   · 节点候选只数"带标签的节点"，上限给到 8（=12 万）就能把 z10~z18 的 POI 一次给全（本数据集最多 10.5 万个带标签节点）；
 *   · 关系上限 3000 → 10000 之后 z10~z18 的关系不再被截断（本数据集一个视口最多 9040 个关系，扫描本身只要 23 ms）。
 */
const QUERY_CAPS = {
  wayCandidates: 12,
  nodeCandidates: 8,
  relationLimit: 10000,
  /**
   * 关系成员裁剪（#P0：视口请求不再夹带全城级关系的全部成员）：
   *   relationCropPad        裁剪框 = 请求 bbox 每边再外扩"视口尺寸 × 这个比例"（默认 0.25）
   *   relationCropMinMembers 成员数 ≤ 这个值的关系**一律不裁**（默认 64；本数据集里多面体建筑
   *                          最多 20 个成员，所以这个阈值把"小关系永远完整"钉死了）
   * 见 queryBbox 里"关系成员裁剪"那段：病根是全城级 route/boundary 关系的成员列表（实测
   * 单个关系最多 8973 条成员、1223 个关系超过 64 条），视口只碰到它一次就要把整条线路的下发。
   */
  relationCropPad: 0.25,
  relationCropMinMembers: 64,
  /**
   * 纯行政边界（不属于"会被当**面**填色"的那些）的成员要不要也裁/裁几何：
   * 客户端把 boundary 规则画成 kind:'line' 的**虚线**（没有 fill），不靠 relation 的环渲染，
   * 所以裁掉/贴上视口外的部分在画面上是无损的 —— 按"视野里有哪些区块就只加载区块"的口径，
   * 纯行政边界（不属于"会被当**面**填色"的那些）的成员要不要也裁：
   * 客户端把 boundary 规则画成 kind:'line' 的**虚线**（没有 fill），不靠 relation 的环渲染，
   * 所以裁掉视口外的成员在画面上是无损的 —— 但实测这一档只值 ~2% payload，默认不动它。
   */
  relationCropBoundaryMembers: false,
};

/** 批量取"一批 id 的几何 bbox"时每个参数块带多少个 id（SQL 文本固定，语句只 prepare 一次） */
const MEMBER_ID_CHUNK = 4000;

/**
 * "节点候选扫描"换计划的视口跨度阈值（经度，度）。见 OsmDB#_nodeScanHint：
 *   ≥ 这个跨度（约 25 公里宽，z14 及以上）从部分索引驱动更快；
 *   < 这个跨度（z15 起）R*Tree 驱动更快。真实数据集实测的交叉点在 z14/z15 之间。
 */
const NODE_SCAN_INDEX_SPAN = 0.3;

/** 批量取节点坐标时每个参数块带多少个 id（prepare 一次就能重复用） */
const NODE_FETCH_CHUNK = 500;

/**
 * 低缩放候选扫描走"物化列 + 部分索引"的最大缩放（= 两条计划的实测交叉点）：
 *   z10~z12：视口几乎覆盖整座城市，R*Tree 会把 20~32 万行全读出来再逐行扔掉 → 索引驱动快得多；
 *   z ≥ 14：视口小，bbox 本身已经把候选砍到 1~4 万行，R*Tree 反而更快（索引要按城市全域的
 *           "这一档可能可见的 way"数来算成本）。
 * 实测（真实北京数据集，1400×900 + pad 0.05，见 tests/tmp-lodidx/RESULTS-lodidx.md）：
 *   z10 1.6 s → 0.06 s · z11 1.5 s → 0.06 s · z12 1.0 s → 0.05 s · z13 0.66 s → 0.09 s ·
 *   z14 0.16 s（R*Tree 更快，不换）· z15/z16 不换。
 * config limits.wayLodIndexMaxZoom 可覆盖（0 = 关掉回到老行为）。
 */
const WAY_LOD_INDEX_MAX_ZOOM = 13;

/**
 * 低缩放 POI 候选扫描走"部分索引 idx_nodes_poi_low"的最大缩放（z13~z15 实测的交叉点）。
 * 判据见 dbschema.js 的 NODE_POI_LOW_PREDICATE：z ≤ 15 时"可见的 POI"只有地名（z≥8）
 * 与山峰/泉/洞口（z≥13），所以这条索引恰好是这一档的可见集合（超集），
 * 候选行数从"视口内全部带标签节点"（z10 实测 10.57 万行）降到 2000 行上下。
 * z ≥ 16 起可见集合变成"amenity/shop/highway/…"一大票，索引不再等价（也不划算）→ 维持 R*Tree。
 * config limits.nodePoiIndexMaxZoom 可覆盖（0 = 关掉回到老行为）。
 */
const NODE_POI_INDEX_MAX_ZOOM = 15;

/**
 * 基础地板覆盖（config limits.roadClassFloor）会不会把某一级道路放到**比物化的 lod_zoom 更早**的缩放？
 * 会的话索引路径就不能用（索引按 lod_zoom 过滤会把它们筛掉 → 画面会少东西），退回 R*Tree。
 * 默认配置（没有覆盖）永远返回 true；把地板调**晚**（比如 detail: 17）不受影响。
 */
function wayLodFloorSafe(floor) {
  if (!floor) return true;
  for (let rank = 0; rank <= 5; rank++) {
    if (roadFloorAt(rank, floor) < roadFloorAt(rank, null)) return false;
  }
  return true;
}

/**
 * 取 n 个节点坐标的 SQL（n 固定 → 文本固定 → 语句只 prepare 一次，见 _fetchNodes）。
 * 用 IN (?,?,…) 而不是 json_each(?)：真实数据集实测前者更快
 * （z13 取 13.3 万节点：77 ms vs 89 ms；z16：51 ms vs 63 ms。见 tests/tmp-perf/opt-fetch.js）。
 */
function nodeFetchSql(n) {
  return `SELECT id, lat, lon, tags FROM nodes WHERE deleted = 0 AND id IN (${new Array(n).fill('?').join(',')})`;
}

/** 把外部传进来的上限规范化：不是正数就用默认值 */
function capOf(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 把外部传进来的"比例/阈值"规范化：允许 0（关掉外扩），NaN/负数用默认值 */
function numOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/* ------------------- 服务端路网分级（与客户端 Render.roadClassTable() 同一张表） ------------------- */
/**
 * 客户端 `public/js/render.js` 顶部导出 `Render.roadClassTable()` → `[{zoom, blockKeep, serverSend, …}]`：
 *   · `blockKeep`  = **区块过密时客户端还画到第几级**（更深的整块不画，并铺阴影标注）；
 *   · `serverSend` = **服务端下发到第几级**（永远 ≥ blockKeep，客户端不会等一份"服务端本不该发"的数据）。
 * 服务端这里实现的就是 `serverSend`（两边共用一张表，避免一个筛一个不筛）：
 *
 *   rank    highway 值
 *   0       motorway / trunk / primary（+ _link）        —— **主干道：永不被筛**
 *   1       secondary（+ _link）
 *   2       tertiary（+ _link）
 *   3       unclassified / residential / living_street / road
 *   4       service / track / footway / path / steps / cycleway / bridleway / pedestrian / …
 *   5       表里没写的 highway 值（未知等级，宁晚发不早发）
 *
 * **服务端下发表 = 客户端建议表再"各降一档"**（z12→0、z13→1、z14→2）：
 *
 *   | zoom | serverSend | 下发到 |
 *   |------|-----------|--------|
 *   | ≤12  | **0**     | 只主干道 |
 *   | 13   | **1**     | + secondary |
 *   | 14   | **2**     | + tertiary |
 *   | 15–18| **4**     | 全发（含细路） |
 *   | ≥19  | **5**     | 连未知等级也发 |
 *
 * 依据（客户端的建议表 + 实测）：z13 的客户端真实请求是 3×3 拆块，把次干道/三级路一起收掉能让
 * "每块响应"从 2.2–2.9 MB 降到 1.9–2.6 MB；再往下压的瓶颈是"受保护类 + landuse"（见 RESULTS-roadclass.md 第 3 节）。
 * ⚠ 底线：**主干道（rank 0）、铁路、水系、水域、行政边界永不被筛**；
 *   被筛掉的只记 `truncation.lodFiltered` / `lodFilteredBy.roadClass` / `lod.roadsWithheldByClass`，**不算 dropped**。
 * ⚠ `detail=0/1`（客户端「完整 / 全部道路」档）时本表整个关掉 → 全部等级照发。
 */
const ROAD_RANK_VALUES = [
  ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'],                    // 0
  ['secondary', 'secondary_link'],                                                                   // 1
  ['tertiary', 'tertiary_link'],                                                                     // 2
  ['unclassified', 'residential', 'road', 'living_street'],                                          // 3
  ['service', 'track', 'footway', 'path', 'steps', 'cycleway', 'bridleway', 'pedestrian',
    'construction', 'proposed', 'busway', 'bus_guideway', 'raceway', 'corridor', 'platform'],         // 4
];
const ROAD_RANK_NAMES = ['主干道', 'secondary', 'tertiary', '支路', '细路', '未知等级'];
/** highway 值 → rank（表里没写的 = 5「未知等级」） */
const ROAD_RANK_OF = (() => {
  const m = new Map();
  ROAD_RANK_VALUES.forEach((values, rank) => { for (const v of values) m.set(v, rank); });
  return m;
})();
/** 「未知等级」的兜底 rank（与客户端 ROAD_RANK_NAMES 的最后一档一致） */
const ROAD_RANK_UNKNOWN = 5;
/** 服务端下发表（= 客户端建议表各降一档）：zoom ≥ fromZoom 时下发到 serverSend */
const ROAD_SEND_TABLE = [
  { fromZoom: 0, serverSend: 0, sendName: '只主干道' },
  { fromZoom: 13, serverSend: 1, sendName: '主干道+secondary' },
  { fromZoom: 14, serverSend: 2, sendName: '主干道+secondary+tertiary' },
  { fromZoom: 15, serverSend: 4, sendName: '全部道路（含细路）' },
  { fromZoom: 19, serverSend: 5, sendName: '全部道路（含未知等级）' },
];
/**
 * **基础地板**（永远生效，含 detail=0/1 的"完整 / 全部道路"档）：每个 rank 最早在哪个缩放下发。
 * 它是"完整档"一直以来的口径，也是"档位关闭时能拿到多少"的上限；档位开启时由下发表再逐档收紧。
 * ⚠ detail（细路 service/track/footway…）的地板 = **16**：玩家最反感"路少了一块"，
 *   而 z16 是城市尺度常用档位，退回 17 会让 z16 看不到人行道/服务道（实测那 500 KB 增量可接受）。
 * 可用 config limits.roadClassFloor（或旧名 limits.roadClassZoom.{trunk,secondary,minor,detail}）覆盖，
 * 生效值会在 payload 的 truncation.lod.baseFloor 里回显，随时可一键调。
 */
const ROAD_FLOOR = { trunk: 9, secondary: 12, tertiary: 13, minor: 14, detail: 16 };
/** 地板键（config 里用的名字）→ rank（secondary 覆盖 secondary+tertiary 两级） */
const ROAD_FLOOR_KEYS = { trunk: [0], secondary: [1], tertiary: [2], minor: [3], detail: [4] };

/**
 * 干线铁路的判据：只有 `usage=main` 的 `railway=rail` 是**干线**（永不被筛）。
 * 其余 `railway=rail`（场站/支线/专用线：usage 缺失、siding、yard、industrial、branch…）
 * 实测在最重的 z13 一块里就有 1125 条/9065 节点（≈480 KB），在 1 公里尺度根本看不清 ——
 * 按"次要等级"（rank 3，与支路同一套地板/下发表）处理。其余 railway=*（subway/light_rail/tram/
 * platform/…）是真实线路，保持永不筛。
 */
const RAIL_MINOR_RANK = 3;
function isMinorRail(tags) {
  return !!tags && tags.railway === 'rail' && tags.usage !== 'main';
}

/* ------------------------- 永不下发的类别（树 / 自行车道） ------------------------- */
/**
 * **永不下发**：不管哪个缩放、哪个详细度档位（**连 detail=0/1 的「完整 / 全部道路」档也一样**），
 * 服务端都不再下发这些要素 —— 用户口径："树（natural=tree / tree_row）、自行车道（cycleway）之类
 * 装饰性、用不上的类纯粹是性能开销"。**人行道 / 步道（footway / path / steps / pedestrian）与
 * 其它一切照旧全发**（这是明确要求：只收这两类）。
 *
 *   · `trees`      natural=tree / natural=tree_row
 *                  —— way 与**节点**都算：street tree 在 OSM 里绝大多数是带标签的独立节点
 *                     （z ≥ 17 会当成 POI 进 payload.nodeTags），tree_row 是 way。
 *   · `cycleways`  highway=cycleway
 *                  —— 只认"这条 way 本身就是自行车道"。注意 `cycleway=lane` / `cycleway=track`
 *                     是**画在别的道路上**的车道属性（那条 way 自己的 highway=primary 之类），
 *                     不属于这一类，绝不会被这条规则误伤。
 *
 * 记账口径：与其它 LOD 扣下的东西**完全一样** —— 记在 `truncation.lodFiltered` /
 * `truncation.lodFilteredBy.neverSend` / `truncation.lod.neverSend.*`，**不算 dropped**、
 * 不影响 `complete`：`dropped` 是"该下发却没下发"，而这些是"规则上永不下发"，
 * 规则原文就在 `truncation.lod.neverSendRule` / `neverSend.rule` 里。
 *
 * ⚠ 客户端侧的语义（只核对，**没有改客户端**）：
 *   · `Render.completeness()` 的分母是**客户端已经收到并缓存的 way**
 *     （public/js/render.js:2831 `World.queryWays(bbox)` → :2865 `const isRoad = !!way.tags.highway`
 *      → :2869 `roads += 1`），所以"服务端不再发"只会让分母变小，**不可能**让
 *     `roadsMissing`（= roadsMissingUnexpected）变大 —— `roadsWithheld` / `roadsMissing` 的口径
 *     （恒 0）不需要任何改动。
 *   · 但客户端有三处从此是"画了也看不到"的死路（**未改**，仅在此说明）：
 *     `public/js/editor.js:168` 与 `public/js/presets.js:68` 的「自行车道」预设
 *     （新建一条 highway=cycleway：会存进库，但任何缩放都不再回图），
 *     以及样式里的 `public/js/style.js:341`（cycleway）、`public/js/style.js:493`（tree_row）两条规则。
 */
const NEVER_SEND_CLASSES = ['trees', 'cycleways'];
/** 这条要素属不属于"永不下发"的类别（返回类名，否则 null） */
function neverSendClassOf(tags) {
  if (!tags) return null;
  if (tags.natural === 'tree' || tags.natural === 'tree_row') return 'trees';
  if (tags.highway === 'cycleway') return 'cycleways';
  return null;
}
/**
 * 永不下发的类别的说明（回显给客户端 / 工具，见 truncation.lod.neverSend）
 * 想关掉这条规则（回到"照旧全发"）：`config.json` 的 `"limits": { "neverSend": false }`，
 * 或者单次请求带 `neverSend=0`（工具/对照实测用 —— A/B 两次请求就能量出这条规则到底省了多少）。
 */
const NEVER_SEND_RULE = 'natural=tree / natural=tree_row / highway=cycleway 一律不下发'
  + '（任何缩放、任何详细度档位，含 detail=0/1 的「完整 / 全部道路」档）；'
  + '人行道 / 步道（footway / path / steps / pedestrian）与其余一切照旧。'
  + '被它扣下的条数记在 lodFilteredBy.neverSend 与 lod.neverSend.*，**不算 dropped**（规则明确不发）。'
  + '关掉：config limits.neverSend = false，或请求带 neverSend=0。';


/** 装饰性面（landuse / leisure）按客户端默认档的面积门槛筛：z13=20000 m²、z14=6000、z15=1500、z16=400 */
const LANDUSE_AREA_TABLE = [[13, 20000], [14, 6000], [15, 1500], [16, 400]];
/** 这条 way 是否属于"按面积门槛筛的装饰性面"（口径与客户端 detailMinAreaM2 一致） */
function isAreaFilteredFill(tags) {
  if (!tags) return false;
  if (!(tags.landuse || tags.leisure)) return false;
  if (tags.highway || tags.railway || tags.waterway) return false;
  if (tags.building || tags['building:part']) return false;
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return false;
  if (tags.natural === 'water' || tags.natural === 'coastline' || tags.natural === 'bay') return false;
  if (tags.boundary === 'administrative') return false;
  return true;
}

/** 这条 way 的等级（不是道路返回 null） */
function roadRankOf(tags) {
  if (!tags || !tags.highway) return null;
  const r = ROAD_RANK_OF.get(tags.highway);
  return r === undefined ? ROAD_RANK_UNKNOWN : r;
}

/** 等级名（账本用；unknown 单独一档） */
function roadRankName(rank) {
  if (rank === 0) return 'trunk';
  if (rank === 1) return 'secondary';
  if (rank === 2) return 'tertiary';
  if (rank === 3) return 'minor';
  if (rank === 4) return 'detail';
  return 'unknown';
}

/**
 * 这个缩放下服务端下发到第几级（rank ≤ 返回值才发）。
 * overrides（config limits.roadSend）= { zoom: rank } 或 [{fromZoom, serverSend}]，用来按实测微调分界点。
 */
function roadSendRankAt(zoom, table) {
  const z = Number(zoom) || 0;
  let rank = 0;
  for (const row of table) if (z >= row.fromZoom) rank = row.serverSend;
  return rank;
}

/** 规范化外部传进来的下发表（config limits.roadSend）：只认合法的 zoom→rank 覆盖 */
function roadSendTableOf(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const rows = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const z = Math.floor(Number(r.fromZoom));
      const n = Math.floor(Number(r.serverSend));
      if (Number.isFinite(z) && Number.isFinite(n)) rows.push({ fromZoom: Math.max(0, Math.min(22, z)), serverSend: Math.max(0, Math.min(ROAD_RANK_UNKNOWN, n)) });
    }
    return rows.length ? rows.sort((a, b) => a.fromZoom - b.fromZoom) : null;
  }
  if (typeof raw === 'object') {
    // { 12: 0, 13: 0 } 这种"按缩放覆盖"：并进默认表（同 fromZoom 覆盖，缺的补齐）
    const rows = ROAD_SEND_TABLE.map((r) => Object.assign({}, r));
    let any = false;
    for (const [k, v] of Object.entries(raw)) {
      const z = Math.floor(Number(k));
      const n = Math.floor(Number(v));
      if (!Number.isFinite(z) || !Number.isFinite(n)) continue;
      any = true;
      const at = Math.max(0, Math.min(22, z));
      const rank = Math.max(0, Math.min(ROAD_RANK_UNKNOWN, n));
      const hit = rows.find((r) => r.fromZoom === at);
      if (hit) hit.serverSend = rank;
      else rows.push({ fromZoom: at, serverSend: rank, sendName: '自定义' });
    }
    if (!any) return null;
    rows.sort((a, b) => a.fromZoom - b.fromZoom);
    // 保证单调不减（表是"下发到第几级"，绝不能随缩放变粗）
    for (let i = 1; i < rows.length; i++) if (rows[i].serverSend < rows[i - 1].serverSend) rows[i].serverSend = rows[i - 1].serverSend;
    return rows;
  }
  return null;
}

/** 规范化外部传进来的基础地板（config limits.roadClassFloor / 旧名 limits.roadClassZoom） */
function roadFloorOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let any = false;
  for (const key of Object.keys(ROAD_FLOOR_KEYS)) {
    const n = Number(raw[key]);
    if (!Number.isFinite(n)) continue;
    out[key] = Math.max(0, Math.min(22, Math.floor(n)));
    any = true;
  }
  return any ? out : null;
}

/** 某个 rank 的基础地板（默认表 + 覆盖；覆盖按名字给：trunk/secondary/tertiary/minor/detail） */
function roadFloorAt(rank, floor) {
  const key = rank === 0 ? 'trunk' : rank === 1 ? 'secondary' : rank === 2 ? 'tertiary' : rank === 3 ? 'minor' : 'detail';
  const f = floor || {};
  return f[key] === undefined ? ROAD_FLOOR[key] : f[key];
}

/* ------------------- 服务端 LOD：跟客户端详细度档位对齐（默认档「标准」） ------------------- */
/**
 * 客户端 public/js/render.js 有一套玩家可见的**详细度档位**，默认是 **4 = 标准**。
 * 它决定了一屏里哪些"装饰性面"真的会被画出来：
 *
 *   · detailAllows(tags, 'area', zoom) → zoom >= lodMinZoom(tags, 'area', 4)
 *     lodMinZoom 里建筑面：**重要建筑**（有名字 / ≥5 层 / amenity|shop|tourism）= 15，
 *     **普通建筑** = 16；标准档再给非骨架面 +fillZoomBias(1) ⇒ 实际门槛 **16 / 17**。
 *     （骨架标签 landuse/natural/place/waterway/主干路 不加这个偏置，按基础值判。）
 *   · detailMinAreaM2：普通装饰性面再按 STANDARD_MIN_AREA = [[13,20000],[14,6000],[15,1500],[16,400]]
 *     拿 **bbox 面积** 筛一次（≥17 不筛）；水域 / 行政边界 / 道路铁路水系 / 重要建筑不筛。
 *
 * 于是默认档下：**z≤15 一栋楼都不画，z16 只画重要建筑，z17 起才画普通建筑**。
 * 而服务端以前完全不看这个：z15 一个视口要下发 9237 条建筑 way（6.07 万个几何节点，
 * 占整个 payload 的一半），客户端一栋都不画 —— 这正是 z15 拖一屏要 8 次请求、
 * 每次 0.5~0.9 秒的主要来源。现在服务端用**同一套判据**把"客户端根本不画"的建筑面留在库里：
 *
 *   1. 只筛**建筑**这一类（building=* / building:part=*），而且带 highway/railway/waterway/
 *      boundary=administrative/natural=water|coastline 的 way 一律不筛（客户端对这类
 *      "永不分级"，筛了就真会少东西）。**道路、铁路、水系、水域、用地、关系一条不动**。
 *   2. 被筛掉的条数**不算截断**：如实记在 truncation.lodFiltered / truncation.lod，
 *      kinds.ways.dropped 仍必须是 0、complete 仍是 true —— 前提是"该下发的都下发了"，
 *      而"该下发"现在按**当前 LOD 规则**说，规则原文就在 truncation.lod.rule 里。
 *   3. 想要"完整"档的调用方带 detail=0（或 1）：LOD 整个关掉，服务端回到老行为。
 *
 * 实测（真实数据集，tests/tmp-lodsvr/RESULTS-lodsvr.md）：
 *   · z15：payload 6624→3162 KB、6.07 万几何节点不再下发、服务器时间 981→497 ms，
 *     拖一屏从 8 次请求 / 2414 ms 降到 4 次 / 274 ms（真实 HTTP）；
 *   · z16：普通建筑同样不下发（payload 8509→3367 KB）；
 *   · z13/z14 的建筑服务端本来就不发（lodVisible 的门槛是 ≥15），那两档省不到什么，
 *     它们的 payload 是道路/铁路/水系在撑着（拖一屏 9/4 次请求、1525/932 ms）。
 */
const LOD_DETAIL_NAMES = ['完整', '全部道路', '精简', '骨架', '标准（默认）'];
/** 默认档位 = 4 = 客户端默认的「标准」档（render.js 的 DEFAULT_DETAIL_LEVEL） */
const LOD_DEFAULT_DETAIL = 4;
/**
 * 每个档位下建筑面的显示门槛（base = 客户端 lodMinZoom 的基础值，bias = fillZoomBias）：
 *   2 精简    ：bias 0 → 重要 15 / 普通 16
 *   3 骨架    ：建筑永远不画（一栋都不下发）
 *   4 标准（默认）：bias 1 → 重要 16 / 普通 17
 * 骨架类标签（landuse/natural/place…）不加 bias，按 base 判。
 */
const LOD_BUILDING_ZOOM = {
  2: { base: 15, bias: 0 },
  3: { base: 99, bias: 0 },
  4: { base: 15, bias: 1 },
};
/** 客户端的 STANDARD_MIN_AREA（[[zoom, 最小面积 m²], ...]，超出表尾 = 不筛） */
const LOD_MIN_AREA_TABLE = [[13, 20000], [14, 6000], [15, 1500], [16, 400]];

/** 表查找（与 render.js 的 stepValueZero 同语义：zoom 超出表尾返回 0 = 不筛） */
function stepValueZero(table, zoom) {
  if (!table || !table.length) return 0;
  if (zoom <= table[0][0]) return table[0][1];
  for (const [z, v] of table) if (zoom <= z) return v;
  return 0;
}

/** render.js 的 isSkeleton 的等价判断（只用来决定"要不要加 fillZoomBias"） */
function lodSkeletonTags(tags) {
  if (!tags) return false;
  const hw = tags.highway;
  if (hw && ['motorway', 'trunk', 'motorway_link', 'trunk_link', 'primary', 'primary_link'].includes(hw)) return true;
  if (tags.railway && ['rail', 'narrow_gauge', 'light_rail', 'subway'].includes(tags.railway)) return true;
  if (tags.waterway || tags.natural === 'water' || tags.natural === 'coastline') return true;
  if (tags.landuse || tags.natural) return true;
  if (tags.boundary === 'administrative') return true;
  if (tags.place) return true;
  return false;
}

/** 客户端"重要建筑"的判据（lodMinZoom 里那一行：名字 / ≥5 层 / amenity|shop|tourism） */
function lodImportantBuilding(tags) {
  const levels = parseFloat(String(tags['building:levels'] || '0').replace(/[^\d.]/g, '')) || 0;
  return !!(tags.name || levels >= 5 || tags.amenity || tags.shop || tags.tourism);
}

/** 把外部传进来的 LOD 档位规范化：0~4，非法值给默认 */
function lodDetailOf(value, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(LOD_DETAIL_NAMES.length - 1, n));
}

/** 显式"关掉"的写法：false / 0 / '0' / 'false'（其它一律当作"没给"） */
function flagOff(v) { return v === false || v === 0 || v === '0' || v === 'false'; }
/** 三态：请求参数优先于 config，都没有就是默认"开" */
function neverSendOnOf(neverSend, lodNeverSend) {
  const q = (neverSend === undefined || neverSend === null || neverSend === '') ? null : !flagOff(neverSend);
  const c = (lodNeverSend === undefined || lodNeverSend === null || lodNeverSend === '') ? null : !flagOff(lodNeverSend);
  return q === null ? (c === null ? true : c) : q;
}
function neverSendSourceOf(neverSend, lodNeverSend) {
  const q = (neverSend === undefined || neverSend === null || neverSend === '') ? null : true;
  const c = (lodNeverSend === undefined || lodNeverSend === null || lodNeverSend === '') ? null : true;
  return q ? 'query' : (c ? 'config' : 'default');
}

/**
 * 组装这次请求生效的 LOD 规则。
 *   detail        请求里带的详细度档位（0~4）；没带就用服务端默认（config limits.lodDetail）
 *   minFillArea   建筑面的**面积门槛**（m²，0 = 不按面积筛）。客户端默认档并不按面积筛建筑
 *                 （重要建筑永远免筛、普通建筑在 z≤16 本来就不显示），这个旋钮是给调用方
 *                 "我只要大建筑"用的：一旦给了，它对当前缩放下**所有**建筑生效（含重要建筑）。
 *   roadSend      路网下发表覆盖（config limits.roadSend）：{ zoom: rank } 或 [{fromZoom, serverSend}]，
 *                 只覆盖给了的缩放，其余沿用 ROAD_SEND_TABLE（并强制单调不减）。
 */
function makeLod({ zoom = 16, detail, lodDetail, minFillArea, lodMinFillArea, roadSend, lodRoadSend, roadClassFloor, lodRoadClassFloor, neverSend, lodNeverSend }) {
  const hasQueryDetail = !(detail === undefined || detail === null || detail === '');
  const hasLimitDetail = !(lodDetail === undefined || lodDetail === null || lodDetail === '');
  const d = hasQueryDetail ? lodDetailOf(detail, LOD_DEFAULT_DETAIL)
    : hasLimitDetail ? lodDetailOf(lodDetail, LOD_DEFAULT_DETAIL)
      : LOD_DEFAULT_DETAIL;
  const rawArea = (!(minFillArea === undefined || minFillArea === null || minFillArea === '')) ? minFillArea : lodMinFillArea;
  const area = numOf(rawArea, 0);
  const rule = LOD_BUILDING_ZOOM[d] || null;
  const sendTable = rule
    ? (roadSendTableOf(roadSend) || roadSendTableOf(lodRoadSend) || ROAD_SEND_TABLE)
    : [{ fromZoom: 0, serverSend: ROAD_RANK_UNKNOWN, sendName: '档位不筛（完整 / 全部道路）' }];
  return {
    detail: d,
    detailName: LOD_DETAIL_NAMES[d] || String(d),
    source: hasQueryDetail ? 'query' : (hasLimitDetail ? 'config' : 'default'),
    /** 建筑面判据；null = 这个档位不做建筑 LOD（完整 / 全部道路） */
    rule,
    minFillArea: area,
    /** 这个档位下建筑面的两个真实门槛（骨架类标签不加 bias） */
    buildingZoom: rule
      ? { important: rule.base + rule.bias, normal: rule.base + 1 + rule.bias }
      : { important: 0, normal: 0 },
    /**
     * 路网下发表（与客户端 Render.roadClassTable() 的 serverSend 同一张表，本实现是"各降一档"版）：
     *   roadSend    本次生效的表（数组，按 fromZoom 升序）
     *   sendRank    这个缩放下"下发到第几级"（rank ≤ sendRank 才发；detail=0/1 时是 ROAD_RANK_UNKNOWN = 全发）
     */
    roadSend: sendTable,
    sendRank: roadSendRankAt(zoom, sendTable),
    /** 基础地板（永不下发被"档位"影响的那道底线）：生效值 + 来源 + 覆盖了哪些键 */
    floor: roadFloorOf(roadClassFloor) || roadFloorOf(lodRoadClassFloor) || null,
    floorSource: roadFloorOf(roadClassFloor) ? 'query' : (roadFloorOf(lodRoadClassFloor) ? 'config' : 'default'),
    /**
     * **永不下发的类别开关**（树 / 自行车道，见文件开头那一段）：默认**开**。
     * 只有显式给 false / 0 / 'false' / '0' 才关掉（请求参数 `neverSend=0` 优先于 config limits.neverSend）。
     * 关掉它是为了"对照实测"：同一台机器上 A/B 两次请求，差值就是这条规则的真实成本。
     */
    neverSendOn: neverSendOnOf(neverSend, lodNeverSend),
    neverSendSource: neverSendSourceOf(neverSend, lodNeverSend),
  };
}

/**
 * 一条 way 在当前 LOD 下"要不要因为客户端不画 / 看不清而不下发"。
 * 返回 null = 下发；否则返回被扣下的**类别**（记进 lodFiltered / lodFilteredBy）：
 *   'neverSend' —— **永不下发的类别**（树 / 自行车道，见上面那一段）：任何档位、任何缩放都不发
 *   'roadClass' —— 次要道路（等级比这一档能发的更深）
 *   'railMinor' —— 非干线铁路（railway=rail 且 usage≠main：场站/支线/专用线）
 *   'landuse'   —— 装饰性面（landuse/leisure）小于客户端默认档的面积门槛
 *   'building'  —— 建筑面（客户端默认档门槛：重要 16 / 普通 17，或显式 minFillArea）
 *
 * 永不筛：**主干道（rank 0）、干线铁路（usage=main）、其余 railway=*（subway/tram/…）、
 *          水系、水域、行政边界**。
 * row/closed 用于按需算 bbox 面积（只有装饰性面与显式 minFillArea 才算，避免每行都算）。
 */
function lodWithholdClass(tags, zoom, lod, row, closed) {
  if (!lod || !tags) return null;
  // ---------- 0. 永不下发的类别（树 / 自行车道）：**在档位判断之前**，所以 detail=0/1 也照扣 ----------
  if (lod.neverSendOn && neverSendClassOf(tags)) return 'neverSend';
  const rank = roadRankOf(tags);
  // ---------- 1. 路网分级（含"非干线铁路按次要等级"）----------
  if (rank !== null) {
    if (rank === 0) return null;                       // 主干道：永不被筛
    if (rank > lod.sendRank) return 'roadClass';       // 比这一档能发的等级更深 → 不发
    return null;                                       // 道路只按等级筛，不再走建筑/面积判据
  }
  if (tags.railway) {
    if (isMinorRail(tags)) {                           // 场站/支线/专用线：按次要等级（rank 3）走
      if (!lod.rule) return null;                      // detail=0/1：全发
      const need = roadFloorAt(RAIL_MINOR_RANK, lod.floor);
      if (zoom < need || RAIL_MINOR_RANK > lod.sendRank) return 'railMinor';
      return null;
    }
    return null;                                       // 干线铁路与其余 railway=*：永不被筛
  }
  if (tags.waterway) return null;                      // 水系：永不被筛
  if (tags.boundary === 'administrative') return null;
  if (tags.natural === 'water' || tags.natural === 'coastline' || tags.waterway === 'riverbank') return null;
  const needArea = lod.rule && row && closed && isAreaFilteredFill(tags) && stepValueZero(LANDUSE_AREA_TABLE, zoom) > 0;
  const needBuildingArea = lod.minFillArea > 0 && row && (tags.building || tags['building:part']);
  // ---------- 2. 装饰性面（landuse/leisure）按客户端默认档的面积门槛 ----------
  if (needArea) {
    const minArea = stepValueZero(LANDUSE_AREA_TABLE, zoom);
    if (indexRowAreaM2(row) < minArea) return 'landuse';
  }
  // ---------- 3. 建筑面 ----------
  if (!(tags.building || tags['building:part'])) return null;                 // 只筛建筑
  if (lod.rule) {                                                            // 档位判据（0/1 = 完整档，不做缩放筛选）
    const bias = lodSkeletonTags(tags) ? 0 : lod.rule.bias;
    const need = (lodImportantBuilding(tags) ? lod.rule.base : lod.rule.base + 1) + bias;
    if (zoom < need) return 'building';
  }
  // 显式给的面积门槛独立生效（哪怕档位是"完整"）：调用方说"只要大于这个面积的建筑"
  if (needBuildingArea && indexRowAreaM2(row) < lod.minFillArea) return 'building';
  return null;
}

/** way_index 行的 bbox 面积（m²，等距圆柱近似 —— 与客户端 Render.bboxAreaM2 同一套算法） */
function indexRowAreaM2(row) {
  const dLat = (row.bb_max_lat - row.bb_min_lat) * 110574;
  const dLon = (row.bb_max_lon - row.bb_min_lon) * 111320
    * Math.cos((((row.bb_min_lat + row.bb_max_lat) / 2) * Math.PI) / 180);
  return Math.abs(dLat * dLon);
}

/** 按缩放级别的显示规则：低缩放不下发小路和细节要素，避免一次传几十万要素
 *  floor = 基础地板覆盖（config limits.roadClassFloor），只影响道路那一档 */
function lodVisible(tags, zoom, geometry, floor) {
  if (!tags) return zoom >= 17; // 无标签节点只有在大缩放才有意义（几何顶点除外，那是被 way 带出来的）
  if (geometry === 'point') {
    // 点要素（POI）：城市名/山峰早显示，公共设施次之，普通店铺最后
    if (tags.place) return zoom >= 8;
    if (tags.natural === 'peak' || tags.natural === 'spring' || tags.natural === 'cave_entrance') return zoom >= 13;
    if (tags.amenity || tags.shop || tags.tourism || tags.office || tags.craft || tags.leisure ||
      tags.historic || tags.healthcare || tags.emergency || tags.public_transport ||
      tags.railway === 'station' || tags.railway === 'halt' || tags.highway === 'bus_stop' ||
      tags.highway === 'traffic_signals' || tags.man_made === 'tower' || tags.power === 'tower') return zoom >= 16;
    return zoom >= 17;
  }
  const hw = tags.highway;
  if (hw) {
    // 基础地板（永远生效，含 detail=0/1 的"完整 / 全部道路"档）：这是"显示分级"的老口径，
    // 用在**档位关闭**时兜底，保证"玩家要全画"也能拿到全部等级（客户端「全部道路」档用
    // zoomFloor=17 强制高缩放请求，那时所有等级都在）。档位开启时由「服务端路网分级」
    // 的 rank 表逐档收紧（见 ROAD_SEND_TABLE），这里只要不比那张表更紧即可。
    // 默认地板：rank0 主干 9/11 · rank1 secondary 12 · rank2 tertiary 13 · rank3 支路 14 · rank4 细路 16。
    const rank = roadRankOf(tags);
    return zoom >= roadFloorAt(rank === null ? 4 : rank, floor);
  }
  const rw = tags.railway;
  if (rw) {
    if (tags.usage === 'main' || rw === 'rail') return zoom >= 10;
    if (rw === 'subway' || rw === 'light_rail' || rw === 'tram') return zoom >= 13;
    if (rw === 'platform') return zoom >= 16;
    return zoom >= 14;
  }
  if (tags.waterway) return zoom >= 12;
  if (tags.natural === 'water' || tags.waterway === 'riverbank') return zoom >= 9;
  if (tags.building || tags['building:part']) return zoom >= 15;
  if (tags.landuse || tags.natural || tags.leisure || tags.amenity || tags.shop || tags.tourism || tags.office || tags.man_made || tags.aeroway) {
    if (tags.landuse === 'residential' || tags.landuse === 'commercial' || tags.landuse === 'industrial') return zoom >= 13;
    if (tags.amenity === 'parking' || tags.leisure === 'park' || tags.landuse === 'forest') return zoom >= 13;
    return zoom >= 15;
  }
  if (tags.boundary === 'administrative') {
    const lvl = Number(tags.admin_level) || 8;
    return zoom >= (lvl <= 4 ? 6 : lvl <= 6 ? 9 : 12);
  }
  if (tags.power === 'line' || tags.power === 'minor_line') return zoom >= 14;
  if (tags.barrier) return zoom >= 17;
  if (geometry === 'point') return zoom >= 17;
  return zoom >= 16;
}

/* --------------- 物化到 ways 的两列：road_class / lod_zoom（低缩放候选索引用） --------------- */
/**
 * 低缩放候选索引（见 `dbschema.js` 的「道路等级 / 最低可见缩放」与 `_wayScanPlan`）：
 * 把"这条 way 最早在哪个缩放可见"（= 上面 `lodVisible(tags, z, 'line')` 的最小 z）物化到
 * `ways.lod_zoom`，把道路等级物化到 `ways.road_class`（−1 = 不是道路）。
 *
 * ⚠ 这里是**唯一真值实现**：回填（dbschema.backfillWayLod）、编辑写入（insertWay/updateWayTags）、
 *   启动抽检三处都调它，而它自己直接调用查询时用的那个 `lodVisible` ——
 *   于是"存进库的判断"与"查询时的判断"不可能对不上（规则改了 → 改 WAY_LOD_SIGNATURE 重填）。
 */
function wayLodZoomOf(tags) {
  // lodVisible 对缩放单调（每个类都是 `zoom >= 阈值`）→ 二分开销最多 5 次判断
  let lo = 0;
  let hi = 18;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lodVisible(tags, mid, 'line', null)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** tags（原始 JSON 串或已解析对象）→ { roadClass, lodZoom }；tags 看不出东西时返回 null */
function wayLodKeysOf(raw) {
  const tags = typeof raw === 'string' ? parseTags(raw) : (raw || null);
  const rank = roadRankOf(tags);
  return {
    roadClass: rank === null ? -1 : rank,
    lodZoom: wayLodZoomOf(tags),
  };
}

/**
 * `lodVisible(tags, zoom, 'point')` 的**廉价前置判断**：只看原始 JSON 串里有没有可能
 * 出现的键（字符串子串），判断"绝不可能可见"就直接跳过 JSON.parse。
 *
 * 用途：取 way 顶点坐标时，每个带标签的节点都要判一次"它能不能当 POI 显示"，
 * 而低于 z16 时绝大多数标签（门牌号、建筑细节）都不可见 —— 逐个 JSON.parse 是白花时间。
 * 这个函数只允许**误判为可能可见**（多解析几次无所谓），绝不能漏掉真正可见的，
 * 所以每一档用的键集合都是 lodVisible 里那一档键集合的**超集**（键名本身，含冒号）。
 */
function pointTagsMaybeVisible(raw, zoom) {
  if (!raw) return false;
  const z = Number(zoom) || 0;
  if (z >= 17) return true;                     // 高缩放：什么标签都可能可见，直接解析
  if (raw.includes('"place":')) return z >= 8;  // 地名：z8 起
  if (raw.includes('"natural":"peak"') || raw.includes('"natural":"spring"')
    || raw.includes('"natural":"cave_entrance"')) return z >= 13;
  if (z < 16) return false;                     // 以下键最早 z16 才可见
  return raw.includes('"amenity":') || raw.includes('"shop":') || raw.includes('"tourism":')
    || raw.includes('"office":') || raw.includes('"craft":') || raw.includes('"leisure":')
    || raw.includes('"historic":') || raw.includes('"healthcare":') || raw.includes('"emergency":')
    || raw.includes('"public_transport":') || raw.includes('"railway":') || raw.includes('"highway":')
    || raw.includes('"man_made":') || raw.includes('"power":');
}

/* ==================== 低缩放几何合并（displayLines：只用来画的合并折线） ==================== */
/**
 * **问题的本体（用户点出的那个）**：把每条该发的东西都逐条发，一屏就装不下。
 * 实测（真实北京数据集，z13 一屏 1600×900 + pad 0.35）：
 *   可见 way 21481 条，其中**受保护类**（主干道 trunk 系 7582 + 干线铁路 2513 + 水系/水域 1160
 *   + 行政边界 569）≈ 11.8k，去掉所有次要道路之后仍是这个量级 —— 也就是说
 *   **15000 条上限不是"小路撑满的"，而是"主干道+铁路+水系自己就撑满了"**。
 * 于是"调大上限"永远只是把阈值往后挪一屏；真正的解法是让**每一条下发的东西携带的几何更少**。
 *
 * 做法（只在 z < minZoom＝编辑缩放时生效）：
 *   1. **只合并"开折线"**（不闭合的线要素）。闭合面（建筑/水面/绿地）是填充几何，
 *      折线表达不了，一律逐条下发 —— 它们受 LOD 的建筑/面积门槛管，不在"条数撑满"的主力里；
 *      关系成员的 way 也不合并（关系要靠成员几何拼环/拼线，见 queryBbox 的成员裁剪那一段）。
 *   2. **按"样式类 + 名字 + bridge/tunnel/layer(+surface)"分组**。样式类是**画法的等价类**：
 *      `highway=trunk` 与 `highway=trunk_link` 的路宽/描边不同，所以分组键里带的是**精确 tag 值**、
 *      不带名字就会把两条同名不同类的路画成一种宽度。同组里的每条 way 拿到的样式规则逐字段相同，
 *      所以合并后画出来与合并前**颜色/宽度/虚线/描边全一致**。
 *   3. 组内按**共享节点**接龙（一个节点上还有 ≥2 条没用过的 continuation 就断开：折线不能分叉），
 *      先从未用过的"尽头"（度为 1 的端点）起头，尽量把长路接成一条。
 *      实测这套贪心已经贴着**欧拉路径数下界**（z13：4736 条 vs 下界 4707）——
 *      也就是说"折线段数"几乎完全由路网拓扑（奇度点个数）决定，不是实现偷懒。
 *   4. 每条接龙结果做 **Douglas–Peucker ≤ tolPx 屏幕像素**（默认 1 px：z13 ≈ 14.7 m）的简化，
 *      坐标量化到 coordDigits 位小数（默认 5 位 ≈ 1.1 m ≤ z15 的 1 像素）。
 *      实测点数降到原来的 ~31%，这个缩放级别下肉眼无法分辨。
 *   5. 结果放进 `payload.displayLines`：**只有几何，没有 way id** —— 客户端画它，但不选它、不改它。
 *      z ≥ minZoom（默认 15 = VIEW_ONLY_MAX_ZOOM + 1）时**一条都不合并**，真 way id 全部照旧下发，
 *      编辑与拾取完全不受影响（所以"低缩放只看不改"是明确口径，见 README / 报告）。
 *
 * 为什么这么算就"上限永不 binding"：合并掉的 way **不进 `ways` 字典**，也就**不占上限名额**，
 * 而它们的几何被压缩成"组数"级别的折线（实测 z13 一屏 929 组 / 4736 段 / 419 KB）。
 * 剩下的逐条下发部分只有闭合面与关系成员（z13 实测 3023 条），离 15000 还差一个数量级。
 *
 * 合并**不是截断**：被合并的 way 一条都没少（几何都在折线里），所以 `kinds.ways.dropped` 仍是 0、
 * `complete` 仍是 true，账目单独记在 `truncation.coalesce` 与 `kinds.ways.coalesced*` 里。
 */
/**
 * **"只看不改" / 可点选编辑的缩放边界（服务端唯一一处定义）**：
 *   · z ≤ VIEW_ONLY_MAX_ZOOM（**14**）→ 低缩放"只看不改"档：服务端只发**合并几何**
 *     （`displayLines` / `displayAreas`，**一条 way id 都没有**），所以这一档**点不中、也改不了**
 *     任何具体要素（拾取与编辑靠 way id，没有 id 就没有可拾取的对象）；
 *   · z ≥ VIEW_ONLY_MAX_ZOOM + 1（**15**）→ 完整可编辑档：真 way id + 真实几何全量下发，
 *     拾取/编辑/框选照旧（z15 一条都不合并）。
 * 用户口径原话：「z14 开始就不应该点选了」—— 也就是**从 z15 起才允许点选/编辑**。
 *
 * **下游判据全部从这一个常量推导**（绝不各写一个数，否则两侧会各说一个数）：
 *   · `COALESCE_DEFAULTS.minZoom` = 边界 + 1（合并/视图载荷的阈值：`zoom < minZoom` 才生效）
 *   · `PACK_DEFAULTS.editZoom`    = 边界 + 1（坐标精度不再降的"编辑档"起点：可编辑就该拿到全精度）
 * 生效值随每份响应回显：`payload.truncation.viewOnly.maxZoom / .minZoom` 与
 * `truncation.coalesce.minZoom`（**每次响应都带，不论有没有生效**），另外 `/api/meta` 的
 * `limits.coalesce` 也会回显（config.json 里没写 `limits.coalesce` 时它是 null，那时客户端以
 * 响应里的回显为准）—— **客户端只认回显，不许自己写死这个数**（见 public/js/mapdata.js 的
 * VIEW_ONLY_BOUNDARY）。
 */
const VIEW_ONLY_MAX_ZOOM = 14;
const COALESCE_DEFAULTS = {
  minZoom: VIEW_ONLY_MAX_ZOOM + 1,   // zoom < minZoom 才合并（= 边界 + 1：z15 起是编辑缩放，真 way id 必须齐全）
  budget: 0.5,        // 合并后"逐条下发的 way 条数"要 ≤ viewportLimit × 这个比例
  minClassWays: 200,  // 一个样式类的可合并条数 ≥ 这个值才值得合并（用户要的"条数超过阈值"）
  tolPx: 1,           // Douglas–Peucker 容差（屏幕像素）
  coordDigits: 5,     // 折线坐标保留几位小数（5 位 ≈ 1.1 m，细于 z15 的 1 像素）
  /**
   * 合并生效时把**候选扫描倍数**放宽到多少（默认 48 = 72 万候选行）。
   * 为什么必须放宽：候选上限一旦 binding（stopReason='cap'），`complete` 就是 false，
   * 客户端会拆块重取 —— 而合并之后"每次请求下发多少"已经不是问题，卡住它的只剩这道
   * "一次最多看多少行"的安全阀。实测（1400×900 真实数据）z12 一屏候选 20.1 万行、
   * z10/z11 一屏几乎覆盖整个数据集（~32 万行），48 倍（72 万）都扫得完；
   * 而候选扫描是**懒取**的（挑满/扫完就停），全扫 20 万行只比扫 18 万行多 ~50 ms。
   */
  wayCandidates: 48,
};
/** 配置规范化（config limits.coalesce；`on:false` 或 minZoom:0 = 整个关掉） */
function coalesceOptsOf(raw) {
  const o = Object.assign({}, COALESCE_DEFAULTS);
  if (raw && typeof raw === 'object') {
    if (raw.on === false) o.minZoom = 0;
    for (const k of Object.keys(COALESCE_DEFAULTS)) {
      const v = Number(raw[k]);
      if (Number.isFinite(v) && v >= 0) o[k] = v;
    }
  }
  o.minZoom = Math.max(0, Math.min(22, Math.floor(o.minZoom)));
  o.minClassWays = Math.max(0, Math.floor(o.minClassWays));
  o.tolPx = Math.max(0, o.tolPx);
  o.budget = Math.max(0.05, Math.min(1, o.budget));
  o.coordDigits = Math.max(3, Math.min(7, Math.floor(o.coordDigits)));
  o.wayCandidates = Math.max(1, Math.floor(o.wayCandidates));
  return o;
}
/**
 * ==================== 预计算低缩放显示图层的开关（见 server/displaylod.js） ====================
 *
 *   on           **总开关，默认 true**：`false` 就是那一行回滚 —— 不建、不读、行为退回改动前
 *                （`tests/display-lod-test.js` 对这个回滚路径有覆盖）。
 *   tiles        瓦片网格边长（默认 6×6 = 36 块）。实测（logs/pc-invalidate.txt / -t12）：
 *                6×6 每块 0.46°×0.43°（约 39×48 km），一条 way 压到的瓦片数中位 1、p99 1、最大 6；
 *                12×12 单块重算便宜一半（最坏一块 7 个档 2.7 s vs 4.2 s），但跨瓦片重复几何更多。
 *                取 6×6：重算最坏一块 7 个 band 合计 4.2 s，而**一次编辑通常只脏 1 块、只脏一个档**。
 *   bands        要烘哪些档。默认 z8~z14（= 客户端"只看不改"的全部档位，z15 起走实时路径且必须逐字节不变）。
 *   sliceMs      **切片构建的让出粒度**（不是"单片上限"）：片 = 一个 (band, 瓦片)，
 *                而单片就是一个真实的瓦片合并 —— 实测最坏一块（z14）1.1~1.9 s，
 *                做不到 25 ms，所以这里只用来决定"一块做完就让出、还是接着做下一块"。
 *   autoRebuild  编辑后要不要后台重算脏瓦片（`false` = 只标脏、永远走实时路径）。
 */
/**
 * **ways.geom（物化几何）的开关**（见 `packWayGeom` 上面那一大段）：默认**开**。
 * `on: false` 是一行回滚：不建列、不回填、读写都不碰它 —— 读路径仍旧走 `way_nodes + nodes`
 * 两次读表（行为与改动前逐字节相同）。
 */
function wayGeomOptsOf(raw) {
  const o = { on: true, autoBackfill: false };
  if (raw === false) { o.on = false; return o; }
  if (raw && typeof raw === 'object') {
    if (raw.on === false) o.on = false;
    if (raw.autoBackfill === true) o.autoBackfill = true;
  }
  return o;
}
const DISPLAY_LOD_DEFAULTS = {  on: true,
  tiles: 6,
  bands: [8, 9, 10, 11, 12, 13, 14],
  sliceMs: 25,
  autoRebuild: true,
};
function displayLodOptsOf(raw) {
  const o = Object.assign({}, DISPLAY_LOD_DEFAULTS);
  if (raw === false) { o.on = false; return o; }
  if (raw && typeof raw === 'object') {
    if (raw.on === false) o.on = false;
    const t = Math.floor(Number(raw.tiles));
    if (Number.isFinite(t) && t >= 1 && t <= 40) o.tiles = t;
    const s = Math.floor(Number(raw.sliceMs));
    if (Number.isFinite(s) && s >= 1) o.sliceMs = s;
    if (raw.autoRebuild === false) o.autoRebuild = false;
    if (Array.isArray(raw.bands) && raw.bands.length) {
      const b = raw.bands.map((x) => Math.floor(Number(x))).filter((x) => Number.isFinite(x) && x >= 0 && x <= 22);
      if (b.length) o.bands = [...new Set(b)].sort((x, y) => x - y);
    }
    // 烘焙用的查询参数：与 server/index.js 的 /api/map 同一组（不给就用库里的默认口径）。
    // `raw.limits` = 整个 config.limits —— server/index.js 传的是
    // `Object.assign({}, LIMITS.displayLod, { limits: LIMITS })`，于是它经 openRegionDB 时
    // 不需要多转发一个字段（分区开关那一层只认它显式列出的那几个选项）。
    o.opts = (raw.limits && typeof raw.limits === 'object') ? raw.limits : raw;
  }
  return o;
}
/**
 * 一条 way 的**样式类**（画法的等价类）。返回 null = 不参与合并（交给"逐条下发"那条路）。
 * 键里带精确 tag 值的原因见上面第 2 条；面状值（natural=water 等）直接返回 null（它们是填充几何）。
 */
function coalesceClassOf(tags) {
  if (!tags) return null;
  if (tags.highway) return 'highway=' + tags.highway;
  if (tags.railway) return 'railway=' + tags.railway;
  if (tags.waterway) return 'waterway=' + tags.waterway;
  if (tags.natural === 'coastline') return 'natural=coastline';
  if (tags.natural === 'water' || tags.natural === 'bay' || tags.natural === 'strait') return null;
  if (tags.boundary === 'administrative') return 'boundary@' + (tags.admin_level == null ? '' : tags.admin_level);
  if (tags.power === 'line' || tags.power === 'minor_line') return 'power=' + tags.power;
  if (tags.man_made === 'pipeline') return 'man_made=pipeline';
  if (tags.aeroway) return 'aeroway=' + tags.aeroway;
  if (tags.barrier) return 'barrier=' + tags.barrier;
  const keys = Object.keys(tags).sort();
  if (!keys.length) return null;
  return 'tags:' + keys.slice(0, 3).join(',');
}
/** 样式类 → 粗类（客户端渲染/账本用的口径：road / railway / waterway / water / boundary / other） */
function coalesceFamilyOf(cls) {
  if (!cls) return 'other';
  if (cls.startsWith('highway=')) return 'road';
  if (cls.startsWith('railway=')) return 'railway';
  if (cls.startsWith('waterway=')) return 'waterway';
  if (cls === 'natural=coastline') return 'water';
  if (cls.startsWith('boundary@')) return 'boundary';
  return 'other';
}
/**
 * "永远合并"的类（用户点名的四个高条数类）：主干道（rank 0）、铁路线、水系线、水域岸线、行政边界。
 * 其余类按**条数阈值**（minClassWays）决定 —— 用户在 z15 那种"全部道路都下发"的档位上，
 * 支撑条数的其实是 residential/unclassified 这类，它们会自然被阈值捞进来。
 */
const COALESCE_ALWAYS_HIGHWAY = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']);
const COALESCE_AREAS_RAIL = new Set(['platform', 'station', 'halt', 'turntable', 'roundhouse']);
const COALESCE_AREAS_WATER = new Set(['riverbank', 'dock', 'boatyard']);
function coalesceAlways(cls) {
  if (!cls) return false;
  if (cls.startsWith('highway=')) return COALESCE_ALWAYS_HIGHWAY.has(cls.slice(8));
  if (cls.startsWith('railway=')) return !COALESCE_AREAS_RAIL.has(cls.slice(8));
  if (cls.startsWith('waterway=')) return !COALESCE_AREAS_WATER.has(cls.slice(8));
  if (cls === 'natural=coastline') return true;
  if (cls.startsWith('boundary@')) return true;
  return false;
}
/**
 * **"这一档把哪些样式类合并成折线"的规则（唯一真值）**：`_coalesce` 与预计算层都调它。
 *
 * 规则：`coalesceAlways(cls) || 条数 ≥ minClassWays` 先选中；若"剩下的逐条 way"仍超过预算
 * （`limit × budget`），再按条数从大到小继续收，直到落进预算。
 *
 * `opts.forceClasses`（预计算层用）：给了一个类名集合时**只用这个集合**，阈值/预算/排序一概不参与。
 * 为什么预计算层必须这么做（原型实测，也是原型点名的那条）：合并是**按瓦片**分别跑的，
 * 而"条数 ≥ 200"是**按这一批候选**数的 —— 于是**瓦片越小、能选中的类越少**，
 * 本该被合并的 way 会被挤出去、变成逐条下发（z13 实测：按瓦片选类时 `coalesced` 比实时少 2.8%，
 * 217 条 way 掉了出去）。所以烘焙时**先在整个数据范围上把类定一次**（`surveyClasses` 探针），
 * 再把这个集合烘进每一块瓦片。
 */
function chooseCoalesceClasses(byClass, pickedCount, opts, limit) {
  const ranked = [...byClass.entries()].sort((a, b) => b[1].length - a[1].length);
  const forced = opts && opts.forceClasses instanceof Set ? opts.forceClasses : null;
  const chosen = new Set();
  for (const [cls, list] of ranked) {
    if (forced) { if (forced.has(cls)) chosen.add(cls); continue; }
    if (coalesceAlways(cls) || list.length >= opts.minClassWays) chosen.add(cls);
  }
  const budget = Math.max(1, Math.floor(limit * opts.budget));
  let coalescedCount = 0;
  for (const cls of chosen) coalescedCount += byClass.get(cls).length;
  if (!forced && pickedCount - coalescedCount > budget) {
    for (const [cls, list] of ranked) {
      if (pickedCount - coalescedCount <= budget) break;
      if (chosen.has(cls)) continue;
      chosen.add(cls);
      coalescedCount += list.length;
    }
  }
  void forced;
  return {
    chosen,
    chosenList: ranked.filter(([cls]) => chosen.has(cls)).map(([cls]) => cls),
    budget,
    coalescedCount,
    remainingWays: pickedCount - coalescedCount,
    classes: ranked.map(([cls, list]) => ({
      class: cls, family: coalesceFamilyOf(cls), ways: list.length,
      coalesced: chosen.has(cls) ? 1 : 0, always: coalesceAlways(cls) ? 1 : 0,
    })),
  };
}
/** 分组键：同组 = 同一条样式规则 + 同名字 + 同 bridge/tunnel/layer（+surface，路面材质会改颜色） */
function coalesceGroupKeyOf(cls, tags) {
  const t = tags || {};
  return [cls, t.name || '', t.bridge || '', t.tunnel || '', t.layer == null ? '' : t.layer, t.surface || ''].join('\u0001');
}
/**
 * 折线上要保留的标签：**渲染真正会读的那些**（style.ruleFor / decorate / categoryOf / 标签）。
 * 全量下发标签既浪费体积又毫无意义（客户端只画线，不显示属性面板）。
 */
const DISPLAY_TAG_KEYS = ['name', 'ref', 'highway', 'railway', 'waterway', 'natural', 'boundary', 'admin_level',
  'bridge', 'tunnel', 'layer', 'surface', 'usage', 'service', 'oneway', 'power', 'man_made', 'barrier',
  'aeroway', 'route', 'area', 'access'];
function displayTagsOf(tags) {
  const out = {};
  if (!tags) return out;
  for (const k of DISPLAY_TAG_KEYS) if (tags[k] !== undefined && tags[k] !== null && tags[k] !== '') out[k] = tags[k];
  return out;
}
/* ============ 低缩放"视图载荷"：面几何也只画不选（payload.displayAreas） ============ */
/**
 * **用户点出的那块最大的肥肉**：低缩放（合并生效的那一档，z < coalesce.minZoom）还在传
 * "原始节点坐标"和"way 的节点引用"。实测（真实北京数据集，1400×900 + pad 0.05）z10 一屏：
 *   payload 2474 KB = nodePack（节点坐标）1045 KB + displayLines 735 KB + ways ~290 KB
 *                    + nodeTags 249 KB + relations 136 KB + 账本 ~11 KB
 *   而 10.4 万个节点里**绝大头是"面"的几何**：闭合水面 1846 条/6.38 万节点、
 *   面关系（多面体建筑/水面/用地）成员 502 条/3.24 万节点 —— 两者合计 9.6 万节点 = 92%。
 *   这些节点坐标在低缩放**只有一个用途：把面画出来**，而这一档客户端是**只看不改**的
 *   （z ≤ VIEW_ONLY_MAX_ZOOM（14）一条 way id 都不下发：拾取/编辑要靠 way id，低缩放只有"看"的语义）。
 *
 * 所以低缩放再多做一件事：**把画得出来的面几何压成 displayLines 那种"只有几何、没有 id"
 * 的紧凑条目**（`payload.displayAreas`），原始 way 几何 + 它的节点坐标不再下发：
 *   · 开几何（线）：照旧走 `_coalesce` → `payload.displayLines`（本次不动，见上面那一段）；
 *   · 闭几何（面）：走 `_coalesceAreas` → `payload.displayAreas`
 *       - 闭合 way：环 → Douglas–Peucker ≤ tolPx 屏幕像素 → 坐标量化 coordDigits 位；
 *       - 面关系（type=multipolygon / 带面标签的 boundary）：成员 way **在服务端接龙成环**，
 *         作为一条 displayArea 下发（tags 用**关系自己**的标签）—— 客户端照旧按样式规则填充；
 *       - 两者都不带 way id：客户端画它，但不选它、不改它（与 displayLines 完全同一套语义）。
 *   · **LOD 判据对关系成员同样生效**：这一档客户端不画的面关系（z10 的多面体建筑 ——
 *     默认档 z≤15 一栋楼都不画）成员几何直接不发，如实记在 `truncation.viewOnly`（**不是** dropped，
 *     与 lodFiltered 同一口径）。
 *
 * 为什么量化 + 简化是安全的：低缩放的 1 像素 = 117 m（z10）· 14.7 m（z13）· 3.7 m（z15），
 * 而一个坐标点值 13 字节 —— 按像素简化后点数掉到原来的百分之几，画面上看不出来
 * （displayLines 从第一版就是这么干的，实测 z13 点数降到 31%）。
 *
 * **逃逸阀**：`detail=0/1`（客户端「完整 / 全部道路」档）时**整个视图载荷关掉** ——
 * 面几何与节点坐标照旧全量下发，编辑语义一个字节都不变（见 VIEW_ONLY_MIN_DETAIL）。
 * 也可以直接用请求参数 `view=0/1` 强制开关（实测/排查用）。
 */
const VIEW_ONLY_MIN_DETAIL = 2;
/** 空集合（合并的"不排除任何 way"口径；用一个共享常量避免每次请求新建） */
const EMPTY_SET = new Set();
/**
 * 面的**样式等价类**：键 = 精确的"样式键=值"。顺序 = 谁先命中算谁的（一个 way 同时带
 * landuse 与 natural 时以 natural 为准 —— 与样式表里"水面规则优先"一致）。
 * 同组的 way 拿到**同一条面样式规则**，所以合并到一条 displayArea 里画出来与逐条画逐字段相同。
 */
const AREA_CLASS_KEYS = ['waterway', 'natural', 'landuse', 'leisure', 'amenity', 'shop', 'tourism', 'historic',
  'building', 'place', 'man_made', 'aeroway', 'military', 'power', 'boundary', 'golf', 'sport',
  'healthcare', 'office', 'craft', 'emergency', 'highway', 'railway', 'barrier'];
function areaClassOf(tags) {
  if (!tags) return null;
  for (const k of AREA_CLASS_KEYS) {
    if (tags[k] === undefined || tags[k] === null || tags[k] === '') continue;
    if (k === 'boundary') return 'boundary=' + tags[k] + '@' + (tags.admin_level == null ? '' : tags.admin_level);
    return k + '=' + tags[k];
  }
  const keys = Object.keys(tags).sort();
  return keys.length ? 'tags:' + keys.slice(0, 3).join(',') : null;
}
/** 面分组键：同组 = 同一条面样式规则 + 同名字 + 同 bridge/tunnel/layer（与折线那套同一口径） */
function areaGroupKeyOf(cls, tags) {
  const t = tags || {};
  return [cls, t.name || '', t.bridge || '', t.tunnel || '', t.layer == null ? '' : t.layer].join('\u0001');
}
/** 面家族（账本口径：water / landuse / building / boundary / other） */
function areaFamilyOf(cls) {
  if (!cls) return 'other';
  if (cls.startsWith('natural=water') || cls.startsWith('natural=coastline') || cls.startsWith('natural=bay')
    || cls.startsWith('natural=strait') || cls.startsWith('waterway=')) return 'water';
  if (cls.startsWith('landuse=') || cls.startsWith('leisure=') || cls.startsWith('natural=')) return 'landuse';
  if (cls.startsWith('building=')) return 'building';
  if (cls.startsWith('boundary=')) return 'boundary';
  return 'other';
}
/**
 * displayArea 上要保留的标签：**只带"这一组的面样式类"命中的那个键**（+ 渲染真正会读的少量键）。
 *
 * 为什么不是"把所有面相关的键都给出去"：客户端的样式表比服务端的 `lodVisible` 细得多，
 * 而且**优先级由客户端定**。带得越多，客户端就越可能选中另一条规则 —— 实测
 * `leisure=park` + `emergency=designated` 会被选成 z17 才生效的 emergency 规则，于是
 * z13 上整片公园不画（"白传字节 + 少画一块"）。只给命中的键，客户端选到的规则就是**确定的**：
 * 与 `_coalesceAreas` 分组时用的那个类完全一致（同组 = 同一条规则）。
 */
const AREA_EXTRA_TAG_KEYS = ['name', 'ref', 'bridge', 'tunnel', 'layer', 'surface'];
function areaDisplayTagsOf(tags) {
  const out = {};
  if (!tags) return out;
  for (const k of AREA_EXTRA_TAG_KEYS) {
    if (tags[k] !== undefined && tags[k] !== null && tags[k] !== '') out[k] = tags[k];
  }
  const cls = areaClassOf(tags);
  if (cls && !cls.startsWith('tags:')) {
    const k = cls.slice(0, cls.indexOf('='));
    if (tags[k] !== undefined && tags[k] !== null && tags[k] !== '') out[k] = tags[k];
    // admin_level 是 boundary 规则的一部分（不同级别的边界样式不同）
    if (k === 'boundary' && tags.admin_level != null && tags.admin_level !== '') out.admin_level = tags.admin_level;
  } else {
    // 没命中任何面样式键（兜底类 `tags:…`）：把这些键给出去，让客户端的兜底规则自己选
    for (const k of Object.keys(tags).sort().slice(0, 4)) {
      if (tags[k] !== undefined && tags[k] !== null && tags[k] !== '') out[k] = tags[k];
    }
  }
  return out;
}
/** 一条"面关系"的判据：客户端会不会把它当面**填色**渲染（不是 → 成员按线走折线合并/逐条下发） */
function relationAreaLike(tags) {
  if (!tags) return false;
  if (tags.type !== 'multipolygon' && tags.type !== 'boundary') return false;
  if (tags.highway || tags.railway || tags.waterway || tags.barrier) return false;   // 线状关系
  /**
   * ⚠ 必须有**真的面样式键**（`landuse=forest` / `natural=water` / `building=yes`…）。
   * 只有 `type=multipolygon` 而没有样式键的关系（本数据集里确实有）：
   * 客户端选不到填充规则 → 不会画这个关系，而它的成员 way 却**可能各自带标签、自己画得出来**。
   * 这种关系一旦被当成"面关系"，成员几何就会被 displayArea 吞掉、画面上反而少东西 ——
   * 所以判据收紧到"客户端真的能填色"，其余关系一律走老路（成员逐条下发/参与折线合并）。
   */
  const cls = areaClassOf(tags);
  if (!cls || cls.startsWith('tags:')) return false;
  const areaLike = !!(tags.building || tags['building:part'] || tags.landuse || tags.leisure
    || tags.natural || tags.water || tags.wetland || tags.amenity || tags.place);
  if (tags.boundary === 'administrative' && !areaLike) return false;   // 纯行政边界：样式里是虚线（无 fill）
  return areaLike;
}
/** 米/像素（Web Mercator，与客户端 util 同一套公式） */
function metersPerPixel(zoom, lat) {
  return (156543.03392804097 * Math.cos((Number(lat) || 0) * D2R)) / Math.pow(2, Number(zoom) || 0);
}

/* ==================== 紧凑载荷（坐标量化 + 列式/delta 整数编码） ==================== */
/**
 * **问题的本体**：payload 的体积几乎全是"坐标的十进制文本"，不是要素条数。
 * 实测（真实北京数据集，1400×900 + pad 0.05，z13 一屏整框一次请求）**改动前**：
 *   nodes        44054 个 × 37.8 B/个 = 1628 KB   ← `"1234567890":[39.9041234,116.4074123],`
 *   way 节点引用 47758 个 × 11.0 B/个 =  526 KB   ← `[1234567890,1234567891,…]`
 *   displayLines 13612 点 × 21.0 B/点 =  285 KB   ← `[39.90412,116.40741]`
 *   三项合计 2439 KB = 整包 3038 KB 的 **80%**（way/relation 的标签与账本加起来才 600 KB）。
 * 于是"再砍要素"已经没得砍（合并/分级都做过了），只能砍**每个坐标的字节数**。
 *
 * 做法（**只改编码，不改语义**；客户端在 World.mergePayload 入口一次展开回老形状）：
 *   1. **量化**：坐标乘 scale 取整。z ≤ VIEW_ONLY_MAX_ZOOM（14，只看不改的档）用 1e-6° ≈ 0.11 m；
 *      z ≥ VIEW_ONLY_MAX_ZOOM + 1（15，可点选/编辑的档）用 1e-7° ≈ 1.1 cm —— 与改动前的下发精度**完全一致**（无损）。
 *   2. **列式 + delta 的 nodes**：`{ids:[…], lat:[…], lon:[…]}`，三列各自"首值绝对、之后相对前一个"。
 *      同一个视口里的节点在 id 与地理上都成片（都是同一批 way 的顶点），差分只要 3~5 位数字。
 *      实测 37.8 B/个 → **11.3 B/个（−70%）**。
 *   3. **每条 way 内 delta 的节点引用**（一条 way 的节点 id 基本是连续的）：11.0 B/个 → **4.6 B/个**。
 *   4. **每条折线路径内 delta 的 displayLines 坐标**（1e-5 整数，与合并时的 coordDigits 一致）：
 *      21.0 B/点 → **12.9 B/点**。
 *
 * 为什么 delta 这么好使：十进制文本的长度由**绝对值的位数**决定（经度 9~10 位、纬度 8~9 位、
 * 节点 id 10 位），而相邻点的差只有 3~5 位 —— JSON 里数字就是文本，"少几位"就等于"少几个字节"。
 *
 * 实测总账（同一实例、同一数据集，只切 limits.compact）：
 *   z13 3038 → 1467 KB（−52%）· z10 6255 → 2476 KB · z16 2049 → 1346 KB
 *   way 每条 256 → 175 B · node 每个 37.8 → 11.3 B
 *
 * 量化误差：0.11 m（z ≤ 14，该档一个像素 ≥ 1.2 m）与 1.1 cm（z ≥ 15），都远细于一像素，肉眼不可见。
 * 关掉：config.json `limits.compact = false`（那时原样下发 nodes / 绝对 id / 小数坐标）。
 */
const PACK_DEFAULTS = {
  on: true,
  viewScale: 1e6,     // z < editZoom 的坐标量化（1e-6° ≈ 0.11 m）
  editScale: 1e7,     // z ≥ editZoom 的坐标量化（1e-7° ≈ 1.1 cm，与改动前一致）
  // 从这一档起是"编辑档"：精度不降 —— 与"可点选/可编辑"同一条边界（见 VIEW_ONLY_MAX_ZOOM）
  editZoom: VIEW_ONLY_MAX_ZOOM + 1,
  lineScale: 1e5,     // displayLines 折线坐标的量化（= 合并时的 coordDigits 5 位）
  /**
   * ②：displayLines / displayAreas 的几何是"一个扁平数组 + 段长表"（见 packDisplayGeometry），
   * 还是老形状（`coords` + `paths` 每段一个数组）。
   *
   * **默认 `false`（老形状）** —— 这是实测加部署安全两方面的结论，不是保守：
   *   · **实测不省字节**：`tests/bin-payload-bench.js` 在真实数据集上逐档对拍，
   *     摊平后 z9 +0.5% / z10 +0.55% / z13 +2.0% / z14 +1.7% / z15 +0.007% / z16 +0.004%，
   *     合计 **+35.9 KB（+0.64%）**。算术上也说得通：省掉的是每段两个方括号，
   *     付出的是每段一个"段长数字 + 逗号"，净差 = Σ(段长位数) − 段数；本数据平均一段 2.2 个点，
   *     段长多为 1~2 位 → 净差 ≈ 0。**它真正的价值是让 JSON 与 BIN 共用同一个几何形状**
   *     （BIN 段的段长就是每段 1 字节 varint，编解码各只有一条路径），
   *     而这件事由二进制编码器内部的 `displaySegmentsOf()` 完成，**不需要改 JSON 的对外形状**。
   *   · **部署安全**：`public/index.html` 引脚本是裸路径（`<script src="/js/world.js">`，无 `?v=`），
   *     所以线上一次部署时，**已经打开的旧标签页**会继续跑旧 JS。若服务端这时开始发扁平几何，
   *     旧客户端会把"多段首尾相接的扁平数组"当成只有一段、而 `paths` 又不存在 ——
   *     低缩放路网被画成贯穿全图的折线，**不报错、不崩溃、只是画错**，多人在线时必然命中。
   *     默认发老形状就没有这个问题：老客户端拿到的与改动前逐字节相同（实测每档恰好只差
   *     143 字节的 `enc.rule` 文档串）。新客户端要二进制时走 `fmt=bin`，那条路径根本不经过 JSON 形状。
   *
   * **两道门串联，缺一不发扁平形状**（改动协议的事绝不单方面做）：
   *   1. 这里（配置）为 `true`；
   *   2. **这一次请求的客户端声明了能力**：`?caps=flatsegs` 或 `?fmt=bin`（见 queryBbox 的 `flatCaps`）。
   * 所以即使运维把配置打开，**没声明能力的老标签页/老缓存 JS/curl 仍然拿到老形状** ——
   * "部署不会打坏正在玩的人"这条是结构性保证，不靠人去记得同步发版。
   * 想要扁平形状（A/B 实测、排障）：`limits.compact = {on:true, displayFlat:true}` + 客户端带 `caps=flatsegs`。
   */
  displayFlat: false,
};
function packOptsOf(raw) {
  const o = Object.assign({}, PACK_DEFAULTS);
  if (raw === false) o.on = false;
  else if (raw && typeof raw === 'object') {
    if (raw.on === false) o.on = false;
    // 扁平形状默认关（见 PACK_DEFAULTS.displayFlat 的实测与部署说明）；显式给布尔值才覆盖
    if (typeof raw.displayFlat === 'boolean') o.displayFlat = raw.displayFlat;
    for (const k of ['viewScale', 'editScale', 'lineScale']) {
      const v = Number(raw[k]);
      if (Number.isFinite(v) && v > 0) o[k] = v;
    }
    const z = Number(raw.editZoom);
    if (Number.isFinite(z) && z >= 0) o.editZoom = Math.floor(z);
  }
  return o;
}
/**
 * nodes 字典 → 列式 delta 三列。
 * 依赖一条 JS 语义（不是巧合）：整数字符串键按**数值升序**遍历，所以 ids 天然是升序的，
 * 差分为正且小；lat/lon 的差分也跟着小（同一批 way 的节点在地理上成片）。
 * 就算将来某天顺序变了，**正确性不受影响**（差分只是变大），客户端解出来仍是同样的坐标。
 */
function packNodesColumnar(nodes, scale) {
  const ids = []; const lat = []; const lon = [];
  let pid = 0; let pla = 0; let plo = 0;
  for (const key in nodes) {
    const c = nodes[key];
    const id = +key;
    const la = Math.round(c[0] * scale);
    const lo = Math.round(c[1] * scale);
    ids.push(id - pid); lat.push(la - pla); lon.push(lo - plo);
    pid = id; pla = la; plo = lo;
  }
  return { ids, lat, lon };
}
/** 一串节点 id → 每条 way 内的差分（首值绝对） */
function packRefDeltas(ids) {
  const n = ids.length;
  const out = new Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) { const v = ids[i]; out[i] = v - prev; prev = v; }
  return out;
}
/** 一条折线的坐标 [[lat,lon],…] → 扁平差分整数 [lat0,lon0, dLat1,dLon1, …]（量化到 scale） */
function packPathFlat(coords, scale) {
  const n = coords.length;
  const out = new Array(n * 2);
  let pla = 0; let plo = 0;
  for (let i = 0; i < n; i++) {
    const c = coords[i];
    const la = Math.round(c[0] * scale);
    const lo = Math.round(c[1] * scale);
    out[i * 2] = la - pla;
    out[i * 2 + 1] = lo - plo;
    pla = la; plo = lo;
  }
  return out;
}

/**
 * ==================== 预计算层的几何 blob ====================
 *
 * **复用上面这一套"量化到 1/scale + 段内差分"的紧凑编码**（`packPathFlat`），只是把整数数组
 * 再用 BIN v1 那套 `zigzag + uvarint` 落成 BLOB：
 *
 * ```
 * uvarint segCount
 * segCount × { uvarint ptCount, ptCount × 2 × svarint(delta) }
 * ```
 *
 * 为什么可以直接复用：`packPathFlat(coords, scale)` 的第一个值是**绝对值**、之后是差分，
 * 而 `svarint` 对"小的负数"只占 1 字节 —— 与载荷里 `displayLines[i].coords` 装的东西**逐整数相同**。
 * 于是"库里存的坐标"与"下发的坐标"是同一个量化口径（scale = 10^coordDigits，默认 1e5 ≈ 1.1 m），
 * 解码 → 打包这条往返是**无损**的（`Math.round(x*scale)/scale` 再乘回 scale 还是同一个整数）。
 *
 * 实测体积（真实北京库 z8~z14 全量 36 块）：折线 + 面几何一共 12.5 MB。
 * 段之间**差分复位**（每段首点绝对值）—— 与载荷的 `paths` 编码完全一致，理由也一样：
 * 一个分组里接不到一起的几段之间可能隔着几十公里，不复位就白花字节。
 */
function packLodPaths(paths, scale) {
  const parts = [];
  for (const p of paths) parts.push(packPathFlat(p, scale));
  let size = 8;
  for (const f of parts) size += 5 + f.length * 3;
  const bw = new ByteWriter(size);
  bw.uvarint(parts.length);
  for (const f of parts) {
    bw.uvarint(f.length >> 1);
    for (let i = 0; i < f.length; i++) bw.svarint(f[i]);
  }
  return Buffer.from(bw.view());
}

/** `packLodPaths` 的逆：BLOB → [[ [lat,lon], … ], …]（与 `packPathFlat` 的 scale 必须一致） */
function unpackLodPaths(buf, scale) {
  let o = 0;
  const rd = () => {
    let x = 0; let s = 1; let b;
    do { b = buf[o]; o += 1; x += (b & 0x7f) * s; s *= 128; } while (b & 0x80);
    return x;
  };
  const unzig = (v) => (v % 2 === 1 ? -(v + 1) / 2 : v / 2);
  const segCount = rd();
  const out = new Array(segCount);
  for (let s = 0; s < segCount; s++) {
    const n = rd();
    const p = new Array(n);
    let pla = 0; let plo = 0;
    for (let i = 0; i < n; i++) {
      const dLa = unzig(rd()); const dLo = unzig(rd());
      pla += dLa; plo += dLo;
      p[i] = [pla / scale, plo / scale];
    }
    out[s] = p;
  }
  return out;
}

/** 一个显示条目（displayLines / displayAreas 的那一种）的**所有路径**：coords 是第一段，paths 是其余段 */
function pathsOfEntry(entry) {
  const out = [];
  if (entry.coords) out.push(entry.coords);
  if (entry.paths) for (const p of entry.paths) out.push(p);
  return out.filter((p) => Array.isArray(p) && p.length);
}

/* ==================================================================================
 * ==================== ways.geom：把每条 way 的几何物化成一列 ====================
 * ==================================================================================
 * ## 为什么（用户的 VPS 实测把这一条顶到了同等优先级）
 *
 * 用户的机器：**956 MB 内存、无 swap**，容器占 297 MB、CPU 24.7%，而 `BLOCK I/O` 读 **41.8 GB**
 * （库一共 530 MB）—— 页缓存装不下库，每次查询都重新读盘。他日常在 **z15** 拖动，而低缩放
 * 预计算层只覆盖 z ≤ 14，救不了日常体验。
 *
 * `/api/map` 在 z15 一屏要取 2,491 条 way 的几何，走两次读表：
 *   `wayNodesBatch`（`way_nodes`，实测 **25,956 行**）+ `_fetchNodes`（`nodes`，实测 **22,166 行**，
 *   而 `nodes` 行里还带着大字段 `tags`）—— 在磁盘瓶颈的机器上就是几十 MB 的随机读。
 *
 * 物化成 `ways.geom` 之后：这些行**跟着 way 行一起读**（way 行本来就要读），
 * 两次跨表探针变成 0 次。**输出逐字节不变**：这一列存的正是那两张表里同样的信息。
 *
 * ## 格式（**复用本文件已有的紧凑量化编码**：`uvarint` + `svarint` = BIN v1 那一套）
 *
 * ```
 * u8      version = 1                     （将来换格式时读路径按它退避）
 * uvarint n                               节点 id 个数（= 这条 way 的 way_nodes 行数）
 * n ×     svarint                          id 增量（首值绝对）
 * uvarint m                               有坐标的节点个数（m ≤ n：被软删的节点只有 id、没有坐标）
 * m ×     { uvarint (idxDelta << 1 | hasTags); svarint dLat; svarint dLon }
 *                                          坐标量化到 1e-7°（与 z ≥ 15 下发精度**完全一致**，
 *                                          所以"从这一列读"与"从 nodes 表读"给的是同一个 double）
 *                                          hasTags = 该节点 `tags IS NOT NULL AND tags <> ''`
 *                                          （**必须记**：下发的 nodeTags 有一部分来自几何顶点，
 *                                           不记就得把 nodes 表重新读一遍，这一列就白做了）
 * ```
 *
 * ## 谁写它（**唯一写入者**，与 `way_nodes` 同一个真值来源）
 *
 * `_wayGeomWrite()`：由 `recomputeWayGeometry()`（几何/标签变了的唯一收口）与
 * `_wayGeomRefreshForNode()`（删节点）调用。**`way_nodes` 仍然是唯一真值**，这一列是它的物化缓存 ——
 * 所以不存在"两套几何来源"，只有一份真值 + 一份同事务里重写的缓存。
 * 移动节点：`updateNode` → `recomputeWayGeometry` → 重写 ✓
 * 删节点：`markNodeDeleted` → `idx_way_nodes_node` 找出含它的 way → `_wayGeomRefreshForNode` ✓
 * 改/删 way：`recomputeWayGeometry` / `markWayDeleted` ✓
 */
const WAY_GEOM_VERSION = 1;
const WAY_GEOM_QSCALE = 1e7;      // 与 z ≥ 15 的下发精度一致（1e-7°）

/** 节点 id 序列 + 坐标 → `ways.geom` 的 BLOB */
function packWayGeom(ids, coords, hasTags) {
  let size = 16;
  for (let i = 0; i < ids.length; i++) size += 5;
  for (let i = 0; i < ids.length; i++) if (coords[i]) size += 16;
  const bw = new ByteWriter(size);
  bw.u8(WAY_GEOM_VERSION);
  bw.uvarint(ids.length);
  let prev = 0;
  for (let i = 0; i < ids.length; i++) { bw.svarint(ids[i] - prev); prev = ids[i]; }
  let m = 0;
  for (let i = 0; i < ids.length; i++) if (coords[i]) m += 1;
  bw.uvarint(m);
  let lastIdx = 0;
  let plat = 0; let plon = 0;
  for (let i = 0; i < ids.length; i++) {
    const c = coords[i];
    if (!c) continue;
    const la = Math.round(c[0] * WAY_GEOM_QSCALE);
    const lo = Math.round(c[1] * WAY_GEOM_QSCALE);
    bw.uvarint(((i - lastIdx) << 1) | (hasTags && hasTags[i] ? 1 : 0));
    bw.svarint(la - plat);
    bw.svarint(lo - plon);
    lastIdx = i; plat = la; plon = lo;
  }
  return Buffer.from(bw.view());
}

/**
 * `packWayGeom` 的逆：→ `{ ids, coords, hasTags }`
 *   ids     节点 id 数组（**与 `wayNodesBatch` 的返回逐项相同**）
 *   coords  与 ids **同下标对齐**：`coords[i] = [lat, lon] | null`
 *   hasTags 与 ids 同下标：`1` = 那个节点带标签（下发的 nodeTags 可能要从它来）
 */
function unpackWayGeom(buf) {
  let o = 0;
  const rd = () => {
    let x = 0; let s = 1; let b;
    do { b = buf[o]; o += 1; x += (b & 0x7f) * s; s *= 128; } while (b & 0x80);
    return x;
  };
  const unzig = (v) => (v % 2 === 1 ? -(v + 1) / 2 : v / 2);
  const ver = buf[o]; o += 1;
  if (ver !== WAY_GEOM_VERSION) return null;      // 将来换格式：读路径退回 way_nodes/nodes
  const n = rd();
  const ids = new Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) { prev += unzig(rd()); ids[i] = prev; }
  const coords = new Array(n).fill(null);
  const hasTags = new Uint8Array(n);
  const m = rd();
  let idx = 0; let plat = 0; let plon = 0;
  for (let k = 0; k < m; k++) {
    const v = rd();
    idx += v >> 1;
    hasTags[idx] = v & 1;
    plat += unzig(rd()); plon += unzig(rd());
    coords[idx] = [plat / WAY_GEOM_QSCALE, plon / WAY_GEOM_QSCALE];
  }
  return { ids, coords, hasTags };
}

/**
 * ==================== ② displayLines / displayAreas 的"摊平"编码 ====================
 * **纯属编码，不碰语义**。
 *
 * 先说清楚**现在没在用它**：`PACK_DEFAULTS.displayFlat` 默认 `false`（见那里的实测与部署安全说明），
 * 而且就算配置打开了，也**只有声明了能力（`?caps=flatsegs` 或 `fmt=bin`）的客户端**才会收到扁平形状。
 * 这一段实现保留着：二进制段的几何本来就是 `segs` 形状，两种形状共用一套代码省一条分支；
 * 想 A/B 实测或排障时，`limits.compact = {on:true, displayFlat:true}` + 客户端带 `caps=flatsegs` 即可。
 *
 * 它想解决的问题：一个显示条目的几何本来是 `coords`（第一段）+ `paths`（其余段），
 * **每段各自一个扁平数组**，于是 JSON 里有一堆 `[[…],[…]]` 的方括号、逗号与 `"paths":` 键。
 *
 * 摊平成：
 *   coords: [dLat0,dLon0, dLat1,dLon1, …]   ← **所有段首尾相接**的一个扁平数组
 *   segs:   [n0, n1, …]                     ← 段长表（每段几个点）
 * 差分**每段复位**（与老编码逐段打包完全一致），所以解出来逐点相同；
 * 客户端 `World.unpackPayload`（world.js）按 `enc.displayPaths` 切回老形状，
 * 于是 `World.mergeDisplayLines` / `render.js` 一行都不用改。
 * `paths` 字段在摊平后不再出现；`coords` 仍然是**第一段**（顺序不变：coords → paths[0] → paths[1] …）。
 *
 * ⚠ **实测结论：它并不省字节，所以默认关。**（数字全部来自本仓库自己的实测台，不是推算）
 *   `node tests/bin-payload-bench.js`（1400×900 + pad 0.05，中心天安门，真实数据集）逐档对拍：
 *   摊平后 z9 +0.5% · z10 +0.55% · z13 +2.0% · z14 +1.7% · z15/z16 0（那两档没有合并几何），
 *   合计 **+35.9 KB（+0.64%）**。算术上必然：省掉的是每段 2 个方括号，付出的是每段一个
 *   "段长数字 + 逗号"，净差 = `Σ(段长位数) − 段数`。
 *   想按屏核对，看 `tests/tmp-bin/breakdown.js` 输出的 displayLines 内部拆账：
 *   坐标整数 56% · 标签/名字/class 35% · **纯结构（键名/括号/逗号）只有 9%**。
 *   所以 ② 能碰到的上限就是那 9%，而"字符串表去重"（① BIN v1 干的事）打的才是那 35%。
 */
function packDisplayGeometry(entry, scale) {
  const src = [entry.coords];
  if (entry.paths) for (let i = 0; i < entry.paths.length; i++) src.push(entry.paths[i]);
  const lens = new Array(src.length);
  let total = 0;
  // 注意：src[i] 是**打包之前**的 `[[lat, lon], …]`，所以它的 length 就是**点数**（不要再 >>1）
  for (let i = 0; i < src.length; i++) { const n = src[i].length; lens[i] = n; total += n * 2; }
  const flat = new Array(total);
  let at = 0;
  for (let i = 0; i < src.length; i++) {
    const f = packPathFlat(src[i], scale);
    for (let j = 0; j < f.length; j++) flat[at++] = f[j];
  }
  delete entry.paths;
  entry.coords = flat;
  entry.segs = lens;
  return entry;
}
/**
 * 摊平条目 → "每段一个扁平数组"（摊平前的形状）。二进制编码器与自检共用它，
 * 免得"两种形状"的逻辑散在两处。
 */
function displaySegmentsOf(entry) {
  const out = [];
  if (entry.segs) {
    let at = 0;
    for (let i = 0; i < entry.segs.length; i++) {
      const n = entry.segs[i] * 2;
      out.push(entry.coords.slice(at, at + n));
      at += n;
    }
    return out;
  }
  if (entry.coords) out.push(entry.coords);
  if (entry.paths) for (const p of entry.paths) out.push(p);
  return out;
}
/**
 * ==================== 载荷打包（queryBbox 的收尾那一段，单一出处） ====================
 *
 * **为什么要抽成函数**：`server/regions.js`（分区流式，第一阶段 = 只读查询走分片）在**多片**
 * 时要把各片的原始查询结果合并成一份载荷。合并**必须早于打包**（`packNodesColumnar` 出来的是
 * delta 列，压完就不能再按 id 去重了 —— 见下面的说明），所以分片路径要"各片拿老形状
 * （`compact:false`）→ JS 侧合并 → **用同一段打包代码**打包"。
 *
 * 打包代码**绝不能有第二份**（两份迟早会漂，而且漂了以后 BIN 段与 JSON 段会不一致），
 * 所以这里把 `queryBbox` 尾部原样搬成一个模块级函数：`queryBbox` 自己也调它 ——
 * 也就是说"抽取前后 queryBbox 的输出逐字节相同"是可断言、已实测的
 * （`node tests/region-payload-hash.js`，抽取前后逐档 sha256 相同）。
 *
 * 入参里的 `nodes / nodeTags / ways / relations / lines / areas` **会被就地修改**
 * （ways[id][1] 换成 delta、折线坐标换成量化整数）—— 调用方要自己保证传进来的是"可以改的副本"。
 *
 * 关于顺序：返回对象的**键顺序与改动前逐字相同**（BIN 的 CORE/JSON 段与 JSON 响应都受它影响），
 * 所以这里的字面量顺序不要随手调整。
 */
function packQueryResult({
  nodes, nodeTags, ways, relations, truncation, totals, zoom, complete, viewOnly,
  lines, areas, pack, coalesceOpts, capsFlat,
}) {
  const lineList = lines || [];
  const areaList = areas || [];
  if (!pack.on) {
    // 老形状（`limits.compact: false`）：坐标原样下发，nodePack / enc 都不出现
    return {
      nodes, nodeTags, ways, relations, truncated: !complete, truncation, totals, zoom,
      viewOnly: !!viewOnly,
      // 低缩放合并折线（视图用：只有几何，没有 way id）。没有合并时整个字段不出现，
      // 客户端拿 `payload.displayLines` 是否存在就能判断"这一档是不是只读视图"。
      ...(lineList.length ? { displayLines: lineList } : {}),
      // 低缩放的面几何（视图用：量化 + 简化过的环，同样没有 way id，见「低缩放视图载荷」）
      ...(areaList.length ? { displayAreas: areaList } : {}),
    };
  }
  /**
   * 坐标精度的"编辑档"起点：**跟随合并/视图载荷的边界**（默认 15 = VIEW_ONLY_MAX_ZOOM + 1）——
   * 从这一档起客户端能点选/编辑，几何就给全精度 1e-7°；"只看不改"的档位给 1e-6°（≈0.11 m）足够。
   * 这样两侧只有**一条**边界：config 改了 limits.coalesce.minZoom（或 on:false）时这里跟着走，
   * 绝不会出现"这一档可编辑、但坐标被降精度"的自相矛盾。
   */
  const editFloor = coalesceOpts.minZoom > 0 ? coalesceOpts.minZoom : pack.editZoom;
  const nodeScale = zoom >= editFloor ? pack.editScale : pack.viewScale;
  // 折线的量化位数跟着合并时的 coordDigits 走（默认 5 位）：这样打包是**无损**的
  const lineScale = Math.pow(10, coalesceOpts.coordDigits || 5);
  for (const key in ways) ways[key][1] = packRefDeltas(ways[key][1]);
  /**
   * **② 摊平（见 packDisplayGeometry）：必须由客户端能力开关控制，绝不单方面改协议。**
   *
   * `public/index.html` 引脚本用的是**裸路径**（`<script src="/js/world.js">`，没有 `?v=`），
   * 所以部署的一瞬间，**已经打开的标签页 / 命中缓存的旧 JS 仍会继续跑老客户端**；
   * 本项目是多人在线，"正在玩的人不会自动刷新"是常态而不是边界情况。
   * 老客户端读扁平几何会把"多段首尾相接的扁平数组"当成**只有一段**（`paths` 又不存在）——
   * 低缩放的线与面被画成穿过全图的折线，**不报错、不崩溃、只是画错**，这类事故最难查。
   *
   * 所以门是**两道、串联**的（缺一不可）：
   *   1. 配置允许（`limits.compact.displayFlat = true` 显式打开；**默认 false**，见 PACK_DEFAULTS）；
   *   2. **这一次请求的客户端声明了能力**：`?caps=` 里含 `flatsegs`，或者 `?fmt=bin`。
   * 只满足 1 不满足 2（老标签页 / 老客户端 / curl）→ 照旧发老形状 `coords` + `paths`。
   * 于是"部署不会打坏正在玩的人"：老标签页拿到的与改动前**逐字节相同**，玩家刷新后才升级。
   *
   * `fmt=bin` 之所以也算声明，是因为二进制解码出来的显示条目本来就是 `segs` 形状
   * （`World.decodeBinaryPayload`），能收二进制载荷的客户端必然已经认识 `segs`。
   */
  const flatDisplay = pack.displayFlat === true && capsFlat === true;
  for (let i = 0; i < lineList.length; i++) {
    const l = lineList[i];
    if (flatDisplay) { packDisplayGeometry(l, lineScale); continue; }
    l.coords = packPathFlat(l.coords, lineScale);
    if (l.paths) for (let j = 0; j < l.paths.length; j++) l.paths[j] = packPathFlat(l.paths[j], lineScale);
  }
  // displayAreas（低缩放视图载荷的面几何）与折线同一套编码：每条环扁平差分 + 量化
  for (let i = 0; i < areaList.length; i++) {
    const a = areaList[i];
    if (flatDisplay) { packDisplayGeometry(a, lineScale); continue; }
    a.coords = packPathFlat(a.coords, lineScale);
    if (a.paths) for (let j = 0; j < a.paths.length; j++) a.paths[j] = packPathFlat(a.paths[j], lineScale);
  }
  return {
    nodePack: packNodesColumnar(nodes, nodeScale), nodeTags, ways, relations,
    truncated: !complete, truncation, totals, zoom,
    viewOnly: !!viewOnly,
    enc: {
      v: flatDisplay ? 2 : 1,
      nodeScale,                 // 坐标 = 整数 / nodeScale
      lineScale,                 // 折线坐标 = 整数 / lineScale
      wayRefs: 'delta',          // ways[id][1] 是"每条 way 内 delta"的节点 id
      displayPaths: flatDisplay ? 'flat+segs' : 'split',
      rule: 'nodes 换成列式 delta 三列 nodePack{ids,lat,lon}；ways[id][1] 与 displayLines / displayAreas 的坐标'
        + '都是差分（首值绝对）；坐标量化到 1/nodeScale。'
        + (flatDisplay
          ? 'displayLines / displayAreas 的几何摊平成 coords（所有段首尾相接的扁平差分数组）+ segs（段长表，每段点数），'
            + 'coords 的第一段点数 = segs[0]。'
          : 'displayLines / displayAreas 的几何是 coords（第一段）+ paths（其余段），每段一个扁平差分数组。')
        + '客户端 World.unpackPayload 展开回老形状。',
    },
    ...(lineList.length ? { displayLines: lineList } : {}),
    ...(areaList.length ? { displayAreas: areaList } : {}),
  };
}
/**
 * 组内接龙：返回若干条**节点序列**（每条是一段不分叉的路径）。
 * 一个节点上只剩 1 条没用过的 way 时才继续接；否则（尽头 / 路口 / 环）断开另起一条。
 * 先从未用过的"尽头"起头，保证长路不会被中间的岔口切成两半。
 */
function chainWaysToTrails(list) {
  const adj = new Map();
  const push = (n, i) => { let a = adj.get(n); if (!a) { a = []; adj.set(n, a); } a.push(i); };
  list.forEach((w, i) => {
    push(w.ids[0], i);
    const last = w.ids[w.ids.length - 1];
    if (last !== w.ids[0]) push(last, i);
  });
  const used = new Uint8Array(list.length);
  const walk = (startRef, startNode) => {
    const trail = [];
    let cur = startRef;
    let node = startNode;
    while (cur != null) {
      used[cur] = 1;
      const w = list[cur];
      const nodes = w.ids[0] === node ? w.ids : w.ids.slice().reverse();
      for (const n of nodes) if (!trail.length || trail[trail.length - 1] !== n) trail.push(n);
      node = nodes[nodes.length - 1];
      const cands = (adj.get(node) || []).filter((r) => !used[r]);
      cur = cands.length === 1 ? cands[0] : null;
    }
    return trail;
  };
  const trails = [];
  for (const [node, refs] of adj) {
    if (refs.length !== 1) continue;
    if (used[refs[0]]) continue;
    trails.push(walk(refs[0], node));
  }
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    trails.push(walk(i, list[i].ids[0]));
  }
  return trails;
}
/**
 * Douglas–Peucker（在"以视口中心为原点的米制坐标"里算，容差单位就是米）：
 * 把一串经纬度点简化到"偏离原折线不超过 tolM"。
 * 先把经纬度换算成米（等距圆柱近似，与客户端 bboxAreaM2 同一套），再逐段递归挑最远点。
 */
function simplifyTrailMeters(pts, tolM) {
  if (pts.length <= 2 || !(tolM > 0)) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 <= i0 + 1) continue;
    const ax = pts[i0][0]; const ay = pts[i0][1];
    const bx = pts[i1][0]; const by = pts[i1][1];
    const dx = bx - ax; const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1;
    let worstI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const px = pts[i][0]; const py = pts[i][1];
      let d;
      if (l2 <= 1e-12) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > worst) { worst = d; worstI = i; }
    }
    if (worst > tolM) {
      keep[worstI] = 1;
      stack.push([i0, worstI], [worstI, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/* ==================== 二进制矢量载荷 BIN v1（zigzag + varint 增量编码） ==================== */
/**
 * ## 格式说明（BIN v1）—— 字段顺序 / 变体类型 / 版本号
 *
 * 目标：把"紧凑载荷"（已经是列式 delta + 差分坐标，但**仍然是 JSON**）再压下去。
 * JSON 剩下的开销全是**结构**：键名（每一条 way 都要把 `"version":` 写一遍）、括号与逗号、
 * 以及十进制整数的每一位。二进制把它们换成 varint 变长整数 + **一张全局去重的字符串表**。
 *
 * ### 字节序与整数变体
 * 全部**小端**（客户端用 DataView 默认的小端 + TextDecoder 解码，都是浏览器原生能力）。
 * 除了魔数、版本、flags 与段目录里的定长字段，**所有整数都是变长整数**：
 *   · `uvarint(v)` 无符号 LEB128：每字节 7 位有效位（低位在前），最高位 = "还有后续字节"。
 *   · `svarint(v)` 先 zigzag 再 uvarint：`v ≥ 0 → 2v`，`v < 0 → −2v−1`。
 *     （zigzag 让"小的负数"也只占 1 字节 —— 坐标增量正负各半，不 zigzag 会让负数永远占满 5 字节。）
 *   · 取值范围到 2^53−1（JS 安全整数）：节点 id 首值可以到 ~1.2e10 > 2^32，
 *     所以编解码**都不走 32 位位运算**，用 `Math.floor(v / 128)`。
 *   · 字符串 = `uvarint 字节长度` + UTF-8 原始字节。
 *
 * ### 文件布局（所有偏移相对文件开头）
 * ```
 * [0..3]   魔数 'D','S','H','B'（0x44 0x53 0x48 0x42）
 * [4]      u8   version = 1                       ← **版本号**；客户端只认它认识的版本
 * [5]      u8   flags   bit0 viewOnly · bit1 truncated（其余位保留，必须为 0）
 * [6..7]   u16  sectionCount（本版本恒为 7；客户端按 kind 找段，不按顺序）
 * [8..]    sectionCount × 10 字节的**段目录**（按 kind 升序）：
 *            u8  kind      段类型
 *            u8  sflags    段级标志（保留，本版本恒 0）
 *            u32 offset    段起始偏移
 *            u32 length    段字节数
 * [8+10n..] 段数据（本实现按 kind 升序紧密排列，段之间不填充、不对齐）
 * ```
 *
 * ### 段类型（kind）
 * | kind | 名字 | 内容 |
 * |------|------|------|
 * | 1 | CORE          | UTF-8 JSON：**除几何以外的所有字段**（truncation / totals / zoom / truncated / viewOnly / enc / ms / query / stats …） |
 * | 2 | STRINGS       | 字符串表 |
 * | 3 | NODES         | nodePack + nodeTags |
 * | 4 | WAYS          | ways 字典 |
 * | 5 | RELATIONS     | relations 字典 |
 * | 6 | DISPLAY_LINES | displayLines（低缩放合并折线，② 的摊平形状） |
 * | 7 | DISPLAY_AREAS | displayAreas（低缩放合并面，同上） |
 *
 * CORE 刻意仍是 JSON：那些小字段本身高度重复（账本里的中文说明文案一个视口就 12 KB），
 * 外层 gzip 对文本的收益远大于"再发明一套编码"，所以不必在这里抠。
 *
 * ### 字符串表（kind 2）
 * `uvarint count`；随后 `count` 条 `(uvarint 字节长度 + UTF-8 字节)`。
 * **约定：下标 0 恒为空串 ""，不出现在表里；表里第一条的下标 = 1。**
 * 全包共用一张表 —— 重复的标签 key 与 value 只存一份（`highway=residential` 一屏重复上万次）。
 *
 * ### 标签集（tagset，多处复用）
 * `uvarint countPlusOne`；`0` = **没有标签（null）**，否则 `countPlusOne - 1` = 键值对个数，
 * 随后 `count × (uvarint keyIdx, uvarint valIdx)`，下标指向 STRINGS 表。
 * 这个 +1 的哨兵是刻意的：服务端里 `tags` 有 `null` 与 `{}` 两种"空"，客户端直接把它们
 * 当对象用，两者必须能原样区分（多花 0 字节 —— 1 与 0 在 varint 里一样宽）。
 * 键的顺序 = 服务端 JSON 里那个对象的键顺序（**必须保序**：客户端拿它直接当 tags 用）。
 *
 * ### NODES 段（kind 3）
 * ```
 * uvarint nodeCount
 * nodeCount × svarint   节点 id 增量（首值绝对 → 与 JSON 版 nodePack.ids 逐个相同）
 * nodeCount × svarint   lat 增量（已量化：坐标 = 整数 / enc.nodeScale）
 * nodeCount × svarint   lon 增量
 * uvarint taggedCount
 * taggedCount × ( svarint nodeId 增量（升序，首值绝对） + tagset )      → 重建 payload.nodeTags
 * ```
 *
 * ### WAYS 段（kind 4）
 * ```
 * uvarint wayCount
 * wayCount × {
 *   svarint  id 增量（升序，首值绝对）
 *   uvarint  version
 *   u8       flags   bit0 closed · bit1 hasTags · bit2 hasLength
 *   uvarint  refCount
 *   refCount × svarint  节点 id 增量（**已经是服务端打包好的"每条 way 内 delta"**，原样搬运）
 *   hasLength 时：svarint length
 *   hasTags   时：tagset
 * }
 * ```
 * 重建：`ways[id] = [version, refDeltas, tags|null, closed ? 1 : 0, length|0]`
 *
 * ### RELATIONS 段（kind 5）
 * ```
 * uvarint relCount
 * relCount × {
 *   svarint  id 增量（升序，首值绝对）
 *   uvarint  version
 *   u8       flags   bit0 hasTags · bit1 hasCrop
 *   uvarint  memberCount
 *   memberCount × { u8 type（0=node 1=way 2=relation）
 *                   svarint ref 增量（**同一关系内**累计，首值绝对）
 *                   uvarint roleIdx（字符串表下标，空 role = 0） }
 *   hasTags 时：tagset
 *   hasCrop 时：8 × uvarint（memberTotal, memberKept,
 *                            memberWaysTotal, memberWaysKept,
 *                            memberNodesTotal, memberNodesKept,
 *                            memberRelsTotal, memberRelsKept）
 * }
 * ```
 * 重建：`relations[id] = [version, [[type, ref, role], …], tags|null, crop|null]`，
 * 其中 crop 重建为 `{ cropped: true, reason: 'viewport', …上面 8 个计数 }`。
 *
 * ### DISPLAY_LINES（kind 6）/ DISPLAY_AREAS（kind 7）—— 两个段同一格式
 * ```
 * uvarint entryCount
 * entryCount × {
 *   uvarint classIdx       字符串表下标（class 恒非空）
 *   u8      flags          bit0 hasName · bit1 hasRel
 *   hasName 时：uvarint nameIdx    字符串表下标（**没有 name 键时这个位就是 0**，
 *                                  与 JSON 版"name 非空才有这个键"口径一致）
 *   hasRel  时：uvarint rel        面关系条目上的关系 id（只有 displayAreas 的关系条目有）
 *   tagset                 （空标签就是 count = 0）
 *   uvarint segCount
 *   segCount × uvarint     每段的点数（← 就是 ② 的段长表 segs）
 *   Σ点数 × 2 × svarint    dLat, dLon 交替；**每段各自的第一个点是绝对量化值**（段间差分复位）
 * }
 * ```
 * 重建：`{ class, tags, coords: 全部段首尾相接的扁平数组, segs: [每段点数], name?, rel? }`
 * —— 正是 ② 的摊平形状，客户端 `World.unpackPayload` 再按 segs 切回 coords/paths。
 *
 * ⚠ 编码器对"条目上多出来的字段"是**零容忍**的（ways/relations/displayXxx 都查）：
 * 见到不认识的键就抛错 → `/api/map` 退回 JSON。宁可慢一点，也绝不把服务端新加的字段
 * 在二进制那一条路上悄悄吞掉（这类丢失在浏览器里表现为"少画一块/少一条路"，极难查）。
 *
 * ### 版本演进
 *   · **段目录**让"加一个新段"不用动老段的解析（客户端跳过不认识的 kind）；
 *   · 段内加字段的兼容做法：往 flags 里加位（本版本每个位都有明确含义，多出来的位一律当 0 处理）；
 *   · **不兼容的改动必须把 version 加 1**：客户端遇到不认识的 version 会抛错，
 *     `mapdata.js` 的 `_fetch` 收到异常后会自动退回 `fmt=json` 重取（协商与逃生阀见那边）。
 *
 * ### 与 gzip 的关系
 * 本格式**自身不压缩**（只是变长整数 + 去重），字节流里仍有多余的统计冗余，外层 gzip 还能再小 ~2 倍，
 * 所以服务端照旧按 `Accept-Encoding` 压 —— 这不是"重复压缩"（实测数字见 `node tests/bin-payload-bench.js`
 * 的输出）。将来若把某个版本换成自带压缩的
 * （例如内部套一层 LZ），**必须**在 flags 里置一个"已压缩"标志并让 `sendBinary` 跳过 gzip，
 * 否则才是真的浪费。
 *
 * ### 只改编码，不改语义
 * 段里搬运的一切都来自 `queryBbox` 已经算好的紧凑载荷：LOD 分级、`truncation` 账本
 * （dropped / lodFiltered / complete / stopReason）、`VIEW_ONLY_MAX_ZOOM = 14` 的"只看不改"边界、
 * `nodeTags` / 关系成员、编辑档（z15+）的真 way id + 全量几何 —— 一个数都不变，
 * 只是换个写法搬到线上。客户端解出来的对象与 JSON 版**逐字段相同**（tests/bin-payload-test.js 用
 * 真实数据集逐档对拍）。
 */
const BIN_VERSION = 1;
const BIN_MAGIC = [0x44, 0x53, 0x48, 0x42];   // 'D' 'S' 'H' 'B'
const BIN_HEADER_BYTES = 8;
const BIN_DIR_ENTRY_BYTES = 10;
const BIN_KIND = {
  CORE: 1, STRINGS: 2, NODES: 3, WAYS: 4, RELATIONS: 5, DISPLAY_LINES: 6, DISPLAY_AREAS: 7,
};
/** 段顺序固定（kind 升序）：客户端按 kind 查目录，不依赖顺序，但固定下来更省事 */
const BIN_SECTION_ORDER = [
  BIN_KIND.CORE, BIN_KIND.STRINGS, BIN_KIND.NODES, BIN_KIND.WAYS,
  BIN_KIND.RELATIONS, BIN_KIND.DISPLAY_LINES, BIN_KIND.DISPLAY_AREAS,
];
/** 走二进制时**不进 CORE JSON**的字段（几何全部走各自的段） */
const BIN_GEOMETRY_KEYS = new Set([
  'nodePack', 'nodes', 'nodeTags', 'ways', 'relations', 'displayLines', 'displayAreas',
]);
const BIN_REL_TYPES = ['node', 'way', 'relation'];
const BIN_REL_TYPE_INDEX = { node: 0, way: 1, relation: 2 };

/** 支持二进制的客户端能力标识（内容类型 + Accept 里的那个 token，两处必须是同一个串） */
const BIN_CONTENT_TYPE = 'application/vnd.dsh.osm.bin';
/** `Accept` 里出现这个子串就说明客户端会解二进制（协商第二条路；显式 `?fmt=` 优先级更高） */
const BIN_ACCEPT_TOKEN = BIN_CONTENT_TYPE;

/** 变长整数的写入器：预分配 + 翻倍扩容，`_need` 之后才直接写 buf */
class ByteWriter {
  constructor(cap) {
    this.buf = Buffer.allocUnsafe(Math.max(64, cap || 4096));
    this.len = 0;
  }
  _need(n) {
    const need = this.len + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = Buffer.allocUnsafe(cap);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  u8(v) { this._need(1); this.buf[this.len++] = v & 0xff; return this; }
  u16(v) { this._need(2); this.buf.writeUInt16LE(v & 0xffff, this.len); this.len += 2; return this; }
  u32(v) { this._need(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; return this; }
  raw(buf) { this._need(buf.length); buf.copy(this.buf, this.len); this.len += buf.length; return this; }
  /** 无符号 LEB128（**不走 32 位位运算**：节点 id 可以超过 2^32） */
  uvarint(v) {
    this._need(10);
    let n = v;
    while (n >= 0x80) { this.buf[this.len++] = (n % 128) | 0x80; n = Math.floor(n / 128); }
    this.buf[this.len++] = n;
    return this;
  }
  /** zigzag + uvarint（坐标增量正负各半，zigzag 才能让小的负数只占 1 字节） */
  svarint(v) { return this.uvarint(v < 0 ? (-v) * 2 - 1 : v * 2); }
  view() { return this.buf.subarray(0, this.len); }
}

/**
 * 紧凑载荷 → BIN v1 缓冲区。
 * **纯函数**：不改传进来的 payload（只读它），失败时抛错（调用方据此退回 JSON）。
 * 只接受紧凑载荷（`payload.enc` 必须在）：非紧凑（`limits.compact=false`）时几何是 `nodes` 字典，
 * 没有量化也没有 delta，编码它等于把老形状硬塞进新容器 —— 直接抛错更诚实。
 */
function encodeBinaryPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('二进制载荷需要一个对象');
  if (!payload.enc) throw new Error('二进制载荷只支持紧凑载荷（payload.enc 缺失：limits.compact 被关掉了？）');
  if (payload.nodes) throw new Error('二进制载荷不支持老形状的 nodes 字典');

  /* ---------- 字符串表：下标 0 恒为空串，表里第一条的下标 = 1 ---------- */
  const stringList = [''];
  const stringIndex = new Map([['', 0]]);
  const intern = (s) => {
    const key = s === undefined || s === null ? '' : String(s);
    let i = stringIndex.get(key);
    if (i === undefined) { i = stringList.length; stringList.push(key); stringIndex.set(key, i); }
    return i;
  };
  /** 标签值必须是字符串：不是就抛错（→ JSON 回退），绝不悄悄 String() 改掉类型 */
  const internValue = (v) => {
    if (typeof v !== 'string') throw new Error('标签值不是字符串（tags.' + typeof v + '），退回 JSON');
    return intern(v);
  };
  const writeTags = (bw, tags) => {
    if (tags === null || tags === undefined) { bw.uvarint(0); return; }   // 0 = null（与"空对象"必须分得开）
    const keys = Object.keys(tags);
    bw.uvarint(keys.length + 1);
    for (let i = 0; i < keys.length; i++) {
      bw.uvarint(intern(keys[i]));
      bw.uvarint(internValue(tags[keys[i]]));
    }
  };

  /* ---------- NODES：nodePack（三列 delta） + nodeTags ---------- */
  const bwNodes = new ByteWriter(1 << 16);
  const np = payload.nodePack;
  if (np && np.ids) {
    const n = np.ids.length;
    bwNodes.uvarint(n);
    for (let i = 0; i < n; i++) bwNodes.svarint(np.ids[i]);
    for (let i = 0; i < n; i++) bwNodes.svarint(np.lat[i]);
    for (let i = 0; i < n; i++) bwNodes.svarint(np.lon[i]);
  } else {
    bwNodes.uvarint(0);
  }
  const nodeTags = payload.nodeTags || null;
  const taggedIds = nodeTags ? Object.keys(nodeTags).map(Number) : [];
  bwNodes.uvarint(taggedIds.length);
  {
    let prev = 0;
    for (let i = 0; i < taggedIds.length; i++) {
      const id = taggedIds[i];
      bwNodes.svarint(id - prev);
      prev = id;
      writeTags(bwNodes, nodeTags[id]);
    }
  }

  /* ---------- WAYS ---------- */
  const bwWays = new ByteWriter(1 << 16);
  const ways = payload.ways || null;
  const wayIds = ways ? Object.keys(ways).map(Number) : [];
  bwWays.uvarint(wayIds.length);
  {
    let prev = 0;
    for (let i = 0; i < wayIds.length; i++) {
      const id = wayIds[i];
      const a = ways[id];
      // ways[id] = [version, 节点 id 差分, tags|null, closed, length]：多一位就抛错（见格式说明的"零容忍"）
      if (!Array.isArray(a) || a.length !== 5) throw new Error('ways[' + id + '] 的形状不是 5 元组，退回 JSON');
      bwWays.svarint(id - prev);
      prev = id;
      bwWays.uvarint(Number(a[0]) || 0);
      const refs = a[1] || [];
      const tags = a[2] || null;
      const length = Number(a[4]) || 0;
      let flags = 0;
      if (a[3]) flags |= 1;          // closed
      if (tags) flags |= 2;          // hasTags
      if (length) flags |= 4;        // hasLength（现在实现恒为 0：0 与"没有"等价，省一个字节）
      bwWays.u8(flags);
      bwWays.uvarint(refs.length);
      for (let j = 0; j < refs.length; j++) bwWays.svarint(refs[j]);
      if (flags & 4) bwWays.svarint(length);
      if (flags & 2) writeTags(bwWays, tags);
    }
  }

  /* ---------- RELATIONS ---------- */
  const bwRels = new ByteWriter(1 << 14);
  const relations = payload.relations || null;
  const relIds = relations ? Object.keys(relations).map(Number) : [];
  bwRels.uvarint(relIds.length);
  {
    let prev = 0;
    for (let i = 0; i < relIds.length; i++) {
      const id = relIds[i];
      const a = relations[id];
      // relations[id] = [version, [[type, ref, role], …], tags|null, crop|null]：同样是零容忍
      if (!Array.isArray(a) || a.length !== 4) throw new Error('relations[' + id + '] 的形状不是 4 元组，退回 JSON');
      bwRels.svarint(id - prev);
      prev = id;
      bwRels.uvarint(Number(a[0]) || 0);
      const members = a[1] || [];
      const tags = a[2] || null;
      const crop = a[3] || null;
      let flags = 0;
      if (tags) flags |= 1;
      if (crop) flags |= 2;
      bwRels.u8(flags);
      bwRels.uvarint(members.length);
      let prevRef = 0;
      for (let j = 0; j < members.length; j++) {
        const m = members[j];
        const t = BIN_REL_TYPE_INDEX[m[0]];
        if (t === undefined) throw new Error('关系成员类型不认识：' + m[0] + '，退回 JSON');
        if (m.length !== 3) throw new Error('关系成员不是 [type, ref, role] 三元组，退回 JSON');
        bwRels.u8(t);
        const ref = Number(m[1]) || 0;
        bwRels.svarint(ref - prevRef);
        prevRef = ref;
        bwRels.uvarint(intern(m[2]));
      }
      if (flags & 1) writeTags(bwRels, tags);
      if (flags & 2) {
        bwRels.uvarint(Number(crop.memberTotal) || 0);
        bwRels.uvarint(Number(crop.memberKept) || 0);
        bwRels.uvarint(Number(crop.memberWaysTotal) || 0);
        bwRels.uvarint(Number(crop.memberWaysKept) || 0);
        bwRels.uvarint(Number(crop.memberNodesTotal) || 0);
        bwRels.uvarint(Number(crop.memberNodesKept) || 0);
        bwRels.uvarint(Number(crop.memberRelsTotal) || 0);
        bwRels.uvarint(Number(crop.memberRelsKept) || 0);
      }
    }
  }

  /* ---------- DISPLAY_LINES / DISPLAY_AREAS（同一格式） ---------- */
  /** 一个显示条目允许出现的键（多一个就抛错 → 退回 JSON，见格式说明的"零容忍"） */
  const DISPLAY_ENTRY_KEYS = ['class', 'tags', 'coords', 'segs', 'paths', 'name', 'rel'];
  const writeDisplay = (entries) => {
    const bw = new ByteWriter(1 << 16);
    const list = entries || [];
    bw.uvarint(list.length);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      for (const k of Object.keys(e)) {
        if (DISPLAY_ENTRY_KEYS.indexOf(k) < 0) throw new Error('显示条目上有不认识的字段 ' + k + '，退回 JSON');
      }
      bw.uvarint(intern(e.class));
      let flags = 0;
      if (e.name) flags |= 1;                       // hasName
      if (e.rel !== undefined && e.rel !== null) flags |= 2;   // hasRel（只有 displayAreas 的关系条目有）
      bw.u8(flags);
      if (flags & 1) bw.uvarint(intern(e.name));
      if (flags & 2) bw.uvarint(Number(e.rel) || 0);
      writeTags(bw, e.tags || null);
      // 几何：摊平形状（coords + segs）与老形状（coords + paths）都收，段序不变
      const segs = e.segs || null;
      const parts = segs ? null : displaySegmentsOf(e);
      const segCount = segs ? segs.length : parts.length;
      bw.uvarint(segCount);
      if (segs) {
        for (let j = 0; j < segs.length; j++) bw.uvarint(segs[j]);
        const flat = e.coords || [];
        for (let j = 0; j < flat.length; j++) bw.svarint(flat[j]);
      } else {
        for (let j = 0; j < parts.length; j++) bw.uvarint(parts[j].length >> 1);
        for (let j = 0; j < parts.length; j++) {
          const f = parts[j];
          for (let k = 0; k < f.length; k++) bw.svarint(f[k]);
        }
      }
    }
    return bw;
  };
  const bwLines = writeDisplay(payload.displayLines);
  const bwAreas = writeDisplay(payload.displayAreas);

  /* ---------- CORE：除几何以外的全部字段，仍然是 JSON ---------- */
  const core = {};
  for (const k of Object.keys(payload)) {
    if (BIN_GEOMETRY_KEYS.has(k)) continue;
    core[k] = payload[k];
  }
  const coreBuf = Buffer.from(JSON.stringify(core), 'utf8');

  /* ---------- STRINGS ---------- */
  const bwStrings = new ByteWriter(1 << 14);
  bwStrings.uvarint(stringList.length - 1);
  for (let i = 1; i < stringList.length; i++) {
    const b = Buffer.from(stringList[i], 'utf8');
    bwStrings.uvarint(b.length);
    bwStrings.raw(b);
  }

  /* ---------- 组装：头 + 段目录 + 段数据 ---------- */
  const bodies = {
    [BIN_KIND.CORE]: coreBuf,
    [BIN_KIND.STRINGS]: bwStrings.view(),
    [BIN_KIND.NODES]: bwNodes.view(),
    [BIN_KIND.WAYS]: bwWays.view(),
    [BIN_KIND.RELATIONS]: bwRels.view(),
    [BIN_KIND.DISPLAY_LINES]: bwLines.view(),
    [BIN_KIND.DISPLAY_AREAS]: bwAreas.view(),
  };
  const count = BIN_SECTION_ORDER.length;
  let total = BIN_HEADER_BYTES + count * BIN_DIR_ENTRY_BYTES;
  for (const kind of BIN_SECTION_ORDER) total += bodies[kind].length;
  const out = Buffer.allocUnsafe(total);
  out[0] = BIN_MAGIC[0]; out[1] = BIN_MAGIC[1]; out[2] = BIN_MAGIC[2]; out[3] = BIN_MAGIC[3];
  out[4] = BIN_VERSION;
  out[5] = (payload.viewOnly ? 1 : 0) | (payload.truncated ? 2 : 0);
  out.writeUInt16LE(count, 6);
  let at = BIN_HEADER_BYTES;
  let offset = BIN_HEADER_BYTES + count * BIN_DIR_ENTRY_BYTES;
  for (const kind of BIN_SECTION_ORDER) {
    const buf = bodies[kind];
    out[at] = kind;
    out[at + 1] = 0;
    out.writeUInt32LE(offset, at + 2);
    out.writeUInt32LE(buf.length, at + 6);
    at += BIN_DIR_ENTRY_BYTES;
    buf.copy(out, offset);
    offset += buf.length;
  }
  return out;
}

class OsmDB {
  constructor(file, options = {}) {
    this.file = file;
    /**
     * **只读模式**（`readOnly: true`，分片库专用；见文件上方 openReadOnlyDatabase 的说明）：
     * 只影响"怎么打开库"和"哪些自愈/回填路径要跳过"，**查询结果一个字节都不变**
     *   · 打开：只读连接（写操作会被 SQLite 拒绝，实测报 `attempt to write a readonly database`）
     *   · 物化列（road_class / lod_zoom）：只抽查，不回填；缺了就让低缩放退回 R*Tree
     *   · 视口索引（idx_nodes_tagged）：只核对在不在，**不建**（分片库已经带了这个索引）
     *   · 空间索引自检/自愈（_auditSpatialIndexes）：整段跳过（自愈要写库），审计结果记 'read-only'
     * 默认 false —— 服务端自己那个库的行为与改动前逐字节相同。
     */
    this.readOnly = options.readOnly === true;
    this.db = this.readOnly ? openReadOnlyDatabase(file) : openDatabase(file);
    this.ids = new IdAllocator(this.db);
    this._st = {};
    this._countsCache = null;
    this._pageCache = new Map();   // 视口查询的分页语句缓存
    /** 空间索引自检/自愈是否开启（config limits.indexAudit !== false） */
    this._auditIndexes = options.auditIndexes !== false;
    /**
     * 低缩放候选索引生效的最大缩放（见 _wayScanPlan；config limits.wayLodIndexMaxZoom）：
     * 0 = 关掉（永远走 R*Tree，用于对照实测），22 = 一直用。
     */
    const maxZoom = Number(options.wayLodIndexMaxZoom);
    this._wayLodMaxZoom = Number.isFinite(maxZoom) ? Math.max(0, Math.min(22, Math.floor(maxZoom))) : WAY_LOD_INDEX_MAX_ZOOM;
    this._wayLodFloorWarned = false;
    /**
     * road_class / lod_zoom 的回填 + 部分索引（幂等，见 dbschema.js 的同名函数）：
     * 启动时跟空间索引自检一样跑一次 —— 已经填好就只抽 3000 行核对（零成本），
     * 没填过/对不上/上次被打断就整表重填一遍。
     * **顺序：先回填、后建索引**（批量构建 159 ms，反过来要 32 万次 UPDATE 维护索引）。
     * 任一步失败 → `_wayLodReady = false` → 低缩放退回旧的 R*Tree 扫描，画面不受影响。
     */
    const wayLodFilled = this.readOnly
      ? lodColumnsFilled(this.db)                                   // 只读：只能抽查，不能回填
      : backfillWayLod(this.db, wayLodKeysOf, { sample: options.wayLodSample }) === true;
    const lodIndexed = this.readOnly ? this._hasIndex(WAY_LOD_INDEX) : ensureLodIndexes(this.db) === true;
    this._wayLodReady = wayLodFilled && lodIndexed;
    /** 低缩放 POI 计划生效的最大缩放（见 _nodePoiPlan；config limits.nodePoiIndexMaxZoom） */
    const poiMax = Number(options.nodePoiIndexMaxZoom);
    this._nodePoiMaxZoom = Number.isFinite(poiMax) ? Math.max(0, Math.min(22, Math.floor(poiMax))) : NODE_POI_INDEX_MAX_ZOOM;
    this._nodePoiReady = this._hasIndex(NODE_POI_INDEX);
    /**
     * 预计算低缩放显示图层（见 server/displaylod.js 的文件头）：
     *   `_dlod`       生效参数（`limits.displayLod`；默认开）
     *   `_dlodDirty`  脏瓦片（内存 + 库里的 display_lod_dirty，跨重启保留）
     *   `_dlodOff`    这一次 queryBbox 调用**强制走实时路径**（烘焙时用：否则烘出来的就是上一版结果）
     * ⚠ 这一层**只在读路径生效**，而且构造时不写库：`autoBuild` 由 server/index.js 驱动
     *   （见 index.js 的初始化段），`tools/build-display-lod.js` 是显式入口。
     *   所以"直接 new OsmDB()"的工具/测试在没有这一层的库上，行为与改动前逐字节相同。
     */
    this._dlod = displayLodOptsOf(options.displayLod);
    this._dlod.log = typeof options.displayLodLog === 'function' ? options.displayLodLog : null;
    this._dlodStateCache = undefined;
    this._dlodExtentStale = false;
    this._dlodDirty = new Map();
    this._dlodBgRunning = false;
    this._dlodOff = false;
    /**
     * **ways.geom（物化几何，见 `packWayGeom` 上面那一段）**：默认开，`limits.wayGeom.on = false`
     * 是回滚键。构造时只建列 + 抽查，真正的回填由 `server/index.js` 的启动阶段切片跑
     * （`backfillWayGeom()`），期间读路径对"还没有这一列的 way"自动退回 `way_nodes + nodes`。
     */
    this._wayGeom = wayGeomOptsOf(options.wayGeom);
    this._wayGeomReady = false;
    this._ensureWayGeom();
    if (this._dlod.on && !this.readOnly) this._dlodLoadDirty();
    this._ensureViewportIndexes();
    this._prepare();
  }

  /**
   * 视口查询用到的索引（#3 性能排查的结论，见 queryBbox 里"节点候选扫描"的说明）。
   *
   * 数据集里 95% 以上的节点是几何顶点（没有任何标签），而"视口内的 POI 候选"只可能是
   * **带标签**的节点。SQL 里那个 `n.tags IS NOT NULL` 没有索引可用，于是 SQLite 只能
   * 把视口内的每个节点都读一遍再逐行判断 —— 真实数据集上 z13 的视口有 188 万个节点，
   * 实测要 850~970 ms（而带回的候选只有 9.8 万个）。
   * 建一个**部分索引**（只索引"带标签且没被删"的节点）之后，规划器可以反过来从这
   * 10.5 万条索引记录出发、再按 id 探一次 R*Tree 判断在不在视口里，z13 直接降到 ~400 ms；
   * 视口小的时候（z15 以上）反过来走 R*Tree 更快（0.3° 以内只要几毫秒），
   * 所以 queryBbox 会按视口跨度在两种计划之间显式选择（INDEXED BY / NOT INDEXED）。
   */
  _ensureViewportIndexes() {
    this._nodeIndexReady = false;
    /**
     * 只读连接（分片库）：不能 CREATE INDEX、也不能自愈重建。只核对索引在不在 ——
     * 分片库是导入器建的，`idx_nodes_tagged` 本来就有；缺了就退回 R*Tree（结果一致，只是慢些）。
     * 空间索引自检整段跳过（它的自愈是写操作），审计结果记成 'read-only' 便于 /api/health 看出来。
     */
    if (this.readOnly) {
      this._nodeIndexReady = this._hasIndex('idx_nodes_tagged');
      this._indexAudit = { skipped: 'read-only' };
      return;
    }
    try {
      const row = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_tagged'"
      ).get();
      if (!row) {
        const t0 = Date.now();
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_tagged ON nodes(id) WHERE tags IS NOT NULL AND deleted = 0');
        const n = this.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE tags IS NOT NULL AND deleted = 0').get().c;
        console.log(`[db] 建立视口索引 idx_nodes_tagged（带标签节点 ${n} 个，${Date.now() - t0} ms）`);
      }
      this._nodeIndexReady = true;
    } catch (err) {
      console.warn('[db] 视口索引不可用（退回 R*Tree 扫描）:', err.message);
    }
    this._auditSpatialIndexes();
  }

  /**
   * 空间索引自检 + 自愈（**这是 z13~z15 拖一屏慢的真正病根**）。
   *
   * 实测（tests/tmp-lodsvr/probe-index-audit.js，真实数据集 319640 条 way）：
   *   `way_index` / `relation_index` 的第 5 列（max_lat）里存的其实是 **max_lon** ——
   *   `tools/import-osm.js` 回填几何时写的是
   *     INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat)
   *     SELECT id, min_lon, max_lon, min_lat, max_lon FROM ways ...      ← 第 5 列笔误
   *   （relation_index 同一处笔误）。于是视口查询里的
   *     `i.max_lat >= minLat AND i.min_lat <= maxLat`
   *   退化成了"没有纬度下界"：**视口南边的所有 way 也全被选进候选**。
   *   实测一个 0.11°×0.07° 的框：候选 53206 条里 19525 条（37%）与请求框根本不相交；
   *   视口越"扁"（低缩放）、离数据南边界越远，这个比例越大 —— z13/z14 的 payload 就是被
   *   这些**根本不在视口里**的 way 撑到 6~9 MB、把 15000 条上限打满、逼客户端拆 4~9 块。
   *   （不会漏：漏查 0 条 —— 它只是个"超集"索引，所以画面一直是对的，只是白白搬数据。）
   *
   * 自愈：**抽样**核对索引行与基表（ways / relations 自己的 bbox 列）是否一致，
   * 抽样里错得超过 2% 就从基表整表重建（一行 SQL）。健全的库抽样 0 条不一致 → 什么都不做。
   * 只读库/写失败一律吞掉（退回原来的"超集"行为，画面不受影响）。
   *
   * 比较必须带**精度容差**：SQLite 的 rtree 把坐标按 **float32** 存（基表是 float64），
   * 所以"逐位相等"永远不成立、会把好库误判成坏库（每档启动都白重建一遍 2.4 秒）。
   * 用相对 1e-5 的容差：float32 的往返误差约 1e-7，而"第 5 列写成了 max_lon"的错位
   * 是"纬度 vs 经度"级别的差异（北京 39.9 vs 116.4），差着好几个数量级，绝不会漏判。
   */
  _auditSpatialIndexes() {
    this._indexAudit = {};
    if (!this._auditIndexes) return;
    const near = (a, b) => (a === b) || (Number.isFinite(a) && Number.isFinite(b)
      && Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-5));
    const checks = [
      { name: 'way_index', base: 'ways', sample: 4000 },
      { name: 'relation_index', base: 'relations', sample: 2000 },
    ];
    for (const c of checks) {
      const t0 = Date.now();
      let rows;
      try {
        rows = this.db.prepare(`SELECT
            i.min_lon AS i_min_lon, i.max_lon AS i_max_lon, i.min_lat AS i_min_lat, i.max_lat AS i_max_lat,
            b.min_lon AS b_min_lon, b.max_lon AS b_max_lon, b.min_lat AS b_min_lat, b.max_lat AS b_max_lat
          FROM ${c.name} i JOIN ${c.base} b ON b.id = i.id LIMIT ?`).all(c.sample);
      } catch (err) {
        this._indexAudit[c.name] = { checked: 0, bad: 0, repaired: false, error: err.message };
        continue;
      }
      let checked = 0;
      let bad = 0;
      for (const r of rows) {
        if (r.b_min_lon === null || r.b_min_lon === undefined) continue;   // 基表没有 bbox：索引里也不该有，跳过
        checked += 1;
        if (!near(r.i_min_lon, r.b_min_lon) || !near(r.i_max_lon, r.b_max_lon)
          || !near(r.i_min_lat, r.b_min_lat) || !near(r.i_max_lat, r.b_max_lat)) bad += 1;
      }
      const rec = { checked, bad, repaired: false, ms: 0 };
      this._indexAudit[c.name] = rec;
      if (!checked || bad / checked < 0.02) continue;      // 抽检没问题 → 一行都不动
      const before = this.db.prepare(`SELECT COUNT(*) AS c FROM ${c.name}`).get().c;
      try {
        const t1 = Date.now();
        this.db.exec('BEGIN');
        this.db.exec(`DELETE FROM ${c.name}`);
        this.db.exec(`INSERT OR REPLACE INTO ${c.name}(id, min_lon, max_lon, min_lat, max_lat)
          SELECT id, min_lon, max_lon, min_lat, max_lat FROM ${c.base} WHERE min_lon IS NOT NULL`);
        this.db.exec('COMMIT');
        const after = this.db.prepare(`SELECT COUNT(*) AS c FROM ${c.name}`).get().c;
        rec.repaired = true;
        rec.ms = Date.now() - t1;
        rec.rowsBefore = before;
        rec.rowsAfter = after;
        console.log(`[db] 修复空间索引 ${c.name}：抽检 ${checked} 行有 ${bad} 行的 bbox 与 ${c.base} 不一致`
          + `（导入器回填时把第 5 列写成了 max_lon），已从 ${c.base} 重建 ${after} 行（${rec.ms} ms）`);
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
        rec.error = err.message;
        console.warn(`[db] 空间索引 ${c.name} 自检发现问题但修复失败（继续用原索引）:`, err.message);
      }
      void t0;
    }
  }

  /**
   * 节点候选扫描的两种计划（按视口经度跨度选）：
   *   span ≥ NODE_SCAN_INDEX_SPAN：从部分索引驱动（成本是"全库带标签节点数"，与视口无关）
   *   span <  NODE_SCAN_INDEX_SPAN：R*Tree 驱动（成本与视口内节点数成正比）
   * 阈值 0.3° 是真实数据集上实测的交叉点（z14 0.47° 走索引更快、z15 0.23° 走 R*Tree 更快）。
   * 索引不存在时（只读库等）一律退回 R*Tree。
   */
  _nodeScanHint(minLon, maxLon) {
    if (!this._nodeIndexReady) return '';
    return (Number(maxLon) - Number(minLon)) >= NODE_SCAN_INDEX_SPAN
      ? ' INDEXED BY idx_nodes_tagged'
      : ' NOT INDEXED';
  }

  /**
   * way 候选扫描的两条计划（低缩放走物化列 + 部分索引，高缩放维持原来的 R*Tree）：
   *
   *   · **索引驱动**（低缩放）：`FROM ways w INDEXED BY idx_ways_lod_zoom WHERE w.lod_zoom <= zoom`
   *     只碰"这一档可能看得见"的 way —— 也就是**等级够的道路 + 铁路/水系/水域/行政边界这些例外**
   *     （`lod_zoom` 就是在 `lodVisible` 的口径上物化出来的"最早可见缩放"，见
   *     dbschema.js 的「道路等级 / 最低可见缩放」）。bbox 用 ways 自己的
   *     min_lon/max_lon/min_lat/max_lat 列判断（float64，比 rtree 的 float32 更准）。
   *     实测：z10 一个视口 31.99 万行 → 3.9 万行、z12 20.12 万 → 1.3 万行（就是这次要治的病）。
   *   · **R*Tree 驱动**（高缩放，原样保留）：视口小的时候 bbox 已经把候选砍到很小，
   *     R*Tree 只读视口内的行，比"按城市全域数量扫索引"更快（交叉点见 WAY_LOD_INDEX_MAX_ZOOM）。
   *
   * 安全性：列没回填成功（`_wayLodReady` 假）或 config 把地板调得更宽松（wayLodFloorSafe 假）
   * 时**一律退回 R*Tree** —— 慢一点，但绝不会少要素。
   */
  _wayScanPlan(zoom, floor) {
    if (!this._wayLodReady) return null;
    if (!(Number(zoom) <= this._wayLodMaxZoom)) return null;
    if (!wayLodFloorSafe(floor)) {
      if (!this._wayLodFloorWarned) {
        this._wayLodFloorWarned = true;
        console.warn('[db] limits.roadClassFloor 把某一级道路放到了比物化值更早的缩放 → 低缩放退回 R*Tree 扫描（画面不受影响）');
      }
      return null;
    }
    return { plan: 'lod-index', index: WAY_LOD_INDEX, maxZoom: this._wayLodMaxZoom, lodZoom: Number(zoom) };
  }

  /** 库里有没有这个索引（有才敢用 INDEXED BY，否则 SQL 直接报错） */
  _hasIndex(name) {
    try {
      return !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
    } catch {
      return false;
    }
  }

  /**
   * **POI（带标签节点）候选扫描的两条计划**：
   *   · 低缩放（z ≤ NODE_POI_INDEX_MAX_ZOOM）：走部分索引 `idx_nodes_poi_low`，
   *     `WHERE <NODE_POI_LOW_PREDICATE> AND lat/lon 在框内` —— 只碰"这一档可能可见的 POI"
   *     （地名 + 山峰/泉/洞口）。实测 z10 候选 10.57 万行 → 2150 行、`scan.nodes` 1.17 s → 0.03 s。
   *     bbox 用 nodes 的 lat/lon 列判断（float64，比 rtree 的 float32 更准）。
   *   · z ≥ 16：维持原来的 R*Tree + idx_nodes_tagged 计划（那一档可见集合太大，索引换不来什么）。
   * 与 way 侧同理：这只是**把 accept() 里本来就要做的 lodVisible 判断提前到索引上做**，
   * 所以 visible / returned / dropped / complete 一个数都不变；变的是 `candidates`
   * （"看过多少行"）与 `totals.nodes` / `stats.pois`（那个数现在 = 这一档的 POI 候选数，
   * 而不是"视口里所有带标签的节点"—— 以前那个数把 10 万个门牌号也算成 POI；
   * 另注：`stats` 这一整块默认不下发，见 visibleStats 的说明）。
   */
  _nodePoiPlan(zoom) {
    if (!this._nodePoiReady) return null;
    if (!(Number(zoom) <= this._nodePoiMaxZoom)) return null;
    return { plan: 'poi-index', index: NODE_POI_INDEX, maxZoom: this._nodePoiMaxZoom, zoom: Number(zoom) };
  }

  _prepare() {
    const db = this.db;
    const st = this._st;
    // 视口查询的候选语句不在这里准备：它们是**按 id 分页**的（见 _scanBbox / _pageStmt），
    // 语句本身带 LIMIT ? 与 "id > ?"，按需 prepare 一次后缓存在 this._pageCache 里。
    st.wayNodeIds = db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq');
    st.relationMembers = db.prepare('SELECT member_type, member_ref, role FROM relation_members WHERE relation_id = ? ORDER BY seq');
    st.nodeById = db.prepare('SELECT id, lat, lon, version, tags, deleted, editor_name, ts FROM nodes WHERE id = ?');
    st.wayById = db.prepare('SELECT id, version, tags, deleted, node_count, closed, length, editor_name, ts, min_lat, max_lat, min_lon, max_lon FROM ways WHERE id = ?');
    st.relationById = db.prepare('SELECT id, version, tags, deleted, member_count, editor_name, ts FROM relations WHERE id = ?');
    st.wayRefsForNode = db.prepare('SELECT DISTINCT way_id FROM way_nodes WHERE node_id = ?');
    st.relRefs = db.prepare('SELECT DISTINCT relation_id FROM relation_members WHERE member_type = ? AND member_ref = ?');
    st.waysReferencingAny = db.prepare('SELECT DISTINCT way_id FROM way_nodes WHERE node_id IN (SELECT value FROM json_each(?))');
    st.insertNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, editor, editor_name, ts, deleted) VALUES(?,?,?,?,?,?,?,?,?)');
    st.updateNode = db.prepare('UPDATE nodes SET lat = ?, lon = ?, version = ?, tags = ?, editor = ?, editor_name = ?, ts = ?, deleted = ? WHERE id = ?');
    // 写入时同步维护物化列 road_class / lod_zoom（见 wayLodKeysOf）：
    // 改了 tags 就必须改它们，否则低缩放索引会把这条 way 分到错误的等级里去。
    st.insertWay = db.prepare('INSERT INTO ways(id, version, tags, editor, editor_name, ts, deleted, node_count, closed, road_class, lod_zoom) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    st.updateWay = db.prepare('UPDATE ways SET version = ?, tags = ?, editor = ?, editor_name = ?, ts = ?, deleted = ?, node_count = ?, closed = ?, road_class = ?, lod_zoom = ? WHERE id = ?');
    st.insertWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
    st.deleteWayNodes = db.prepare('DELETE FROM way_nodes WHERE way_id = ?');
    st.insertRelation = db.prepare('INSERT INTO relations(id, version, tags, editor, editor_name, ts, deleted, member_count) VALUES(?,?,?,?,?,?,?,?)');
    st.updateRelation = db.prepare('UPDATE relations SET version = ?, tags = ?, editor = ?, editor_name = ?, ts = ?, deleted = ?, member_count = ? WHERE id = ?');
    st.insertRelMember = db.prepare('INSERT INTO relation_members(relation_id, seq, member_type, member_ref, role) VALUES(?,?,?,?,?)');
    st.deleteRelMembers = db.prepare('DELETE FROM relation_members WHERE relation_id = ?');
    st.upsertNodeIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
    st.deleteNodeIndex = db.prepare('DELETE FROM node_index WHERE id = ?');
    st.upsertWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
    st.deleteWayIndex = db.prepare('DELETE FROM way_index WHERE id = ?');
    st.upsertRelIndex = db.prepare('INSERT OR REPLACE INTO relation_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
    st.deleteRelIndex = db.prepare('DELETE FROM relation_index WHERE id = ?');
    st.setWayGeom = db.prepare('UPDATE ways SET min_lat = ?, max_lat = ?, min_lon = ?, max_lon = ?, length = ?, node_count = ?, closed = ? WHERE id = ?');
    st.insertChange = db.prepare('INSERT INTO changes(changeset_id, elem_type, elem_id, action, before_json, after_json, ts, author, author_name, undone) VALUES(?,?,?,?,?,?,?,?,?,0)');
    st.insertChangeset = db.prepare('INSERT INTO changesets(author, author_name, comment, ts, op_count) VALUES(?,?,?,?,0)');
    st.bumpChangeset = db.prepare('UPDATE changesets SET op_count = op_count + 1 WHERE id = ?');
  }

  close() {
    try { this.ids.persist(); } catch { /* ignore */ }
    try { this.db.close(); } catch { /* ignore */ }
  }

  /* -------------------- 原生 SQLite 直通（供路网/人口等派生模块使用） -------------------- */
  prepare(sql) { return this.db.prepare(sql); }
  exec(sql) { return this.db.exec(sql); }
  get raw() { return this.db; }
  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  /* ------------------------------ 元信息 ------------------------------ */
  counts() {
    if (this._countsCache && Date.now() - this._countsCache.at < 2000) return this._countsCache.value;
    const value = {
      nodes: this.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE deleted = 0').get().c,
      ways: this.db.prepare('SELECT COUNT(*) AS c FROM ways WHERE deleted = 0').get().c,
      relations: this.db.prepare('SELECT COUNT(*) AS c FROM relations WHERE deleted = 0').get().c,
    };
    this._countsCache = { at: Date.now(), value };
    return value;
  }

  invalidateCounts() { this._countsCache = null; }

  isEmpty() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM nodes LIMIT 1').get().c === 0;
  }

  info() {
    const c = this.counts();
    let bbox = null;
    try { bbox = JSON.parse(getMeta(this.db, 'data_bbox', 'null')); } catch { /* ignore */ }
    return {
      ...c,
      source: getMeta(this.db, 'source_file', null),
      importedAt: getMeta(this.db, 'imported_at', null),
      bbox,
      changes: this.db.prepare('SELECT COUNT(*) AS c FROM changes').get().c,
      sizeBytes: (() => { try { return fs.statSync(this.file).size; } catch { return 0; } })(),
      /** 空间索引自检结果（启动时抽样核对，发现导入器写坏的 bbox 列会自愈重建） */
      indexAudit: this._indexAudit || null,
    };
  }

  /* ------------------------------ 视口查询 ------------------------------ */
  /**
   * 取一个矩形范围内的要素。返回紧凑结构：
   * { nodes: {id: [lat, lon]}, nodeTags: {id: {k:v}}, ways: {id: [version, [nodeIds], tags|null, closed, length]},
   *   relations: {id: [version, [[type, ref, role]], tags|null, crop|null]}, truncated, truncation, zoom }
   *
   * **紧凑编码开启时（默认，见文件开头「紧凑载荷」）形状变成**：
   * { nodePack: {ids:[d…], lat:[d…], lon:[d…]},   ← 列式差分整数（替代 nodes 字典）
   *   ways: {id: [version, [d…], tags|null, closed, length]},   ← 第 2 位也是差分（每条 way 内）
   *   displayLines: [{class, tags, name?, coords:[d…], segs:[…]}],  ← 坐标扁平差分 + 段长表（见 ②）
   *   displayAreas: 同上（面关系条目还会多一个 rel = 关系 id）
   *   enc: {v, nodeScale, lineScale, wayRefs:'delta', displayPaths, rule},  ← 解码说明书
   *   …其余字段（nodeTags / relations / truncation / totals / zoom）形状不变 }
   * 客户端在 `World.unpackPayload`（world.js）里按 `enc` 一次展开回上面那套老形状，
   * 所以 `World.mergePayload`、拾取、编辑、`completeness()` 全都看不到编码差异。
   * 关掉：`limits.compact = false`（那时就是上面那套老形状，一个字都不差）。
   * ② 摊平单独关：`limits.compact = {on:true, displayFlat:false}`（几何退回 `coords` + `paths`）。
   *
   * **二进制载荷（BIN v1）**：`/api/map?fmt=bin`（或 `Accept` 声明能力）时，上面这份紧凑载荷
   * 会被 `encodeBinaryPayload` 编码成二进制（zigzag/varint + 字符串表），解码后形状**逐字段相同**
   * —— 格式说明见文件开头「二进制矢量载荷」，协商与逃生阀见 server/index.js 的 `wantBinaryPayload`。
   *
   * relations 的第 4 位是**关系成员裁剪**的说明（#P0）：没裁时为 null，裁了就是
   *   { cropped: true, reason: 'viewport', memberTotal, memberKept,
   *     memberWaysTotal, memberWaysKept, memberNodesTotal, memberNodesKept,
   *     memberRelsTotal, memberRelsKept }
   * —— 客户端据此可以诚实地知道"这条关系我只是没拿到视口外的那些成员"，
   * 而不是"服务器把数据截断了"（后者会触发拆块重试，前者不该触发）。
   *
   * 上限与截断（客户端拿它**证明**自己没缺数据，而不是靠猜）：
   *   三种要素各自有一个"候选上限"和一个"返回上限"：
   *     ways       候选 = limit × wayCandidates，返回 ≤ limit
   *     nodes(POI) 候选 = limit × nodeCandidates，返回 ≤ 候选（够就全给；候选只数带标签的节点）
   *     relations  候选 = 返回 = relationLimit
   *   候选只取一批（上限 +1 行），多取的那一行用来把"是不是正好被上限卡住"变成事实。
   *   每个 kind 都给实测数字（"exact" 表示这批数字是精确的，而不是下界）：
   *     candidates       真正看过的候选行数
   *     candidateLimit   这一类的候选上限（= limit × 倍数 / relationLimit）
   *     candidatesCapped 还有候选行没看（unscanned 说明有多少）
   *     unscanned        没看的候选行数 = bbox 内候选总数 − candidates（COUNT 数出来的精确值；-1 = 未知）
   *     stopReason       'exhausted' 扫干净了 / 'pick' 返回上限满了 / 'cap' 候选上限满了
   *     visible          看过的候选里通过显示分级（zoom 规则）的条数 —— 这些"本该下发"
   *     returned         真的进了 payload 的行数
   *     dropped          "该下发却没下发"的条数：候选扫干净时是精确值，**候选被砍断时是 null**
   *                      （数不出来就说数不出来，绝不报一个骗人的 0）
   *     droppedKnown     看过的部分里确定丢掉的条数（任何情况都精确）
   *     exact            visible / dropped 是否精确（候选被砍断时 visible 只是下界）
   *     complete         这一类的**证据**：exact 且 dropped === 0（bbox 内每个该下发的要素都在 payload 里）
   *   truncation.complete=false 时，客户端唯一能证明完整性的办法就是拆块 —— 拆出来的每一块
   *   都会给出 complete=true（tests/tmp-groupundo/measure-truncation.js 在真数据集上验证了这件事，
   *   并且用"没有上限的暴力扫描"逐条核对过 complete=true 时确实一条不缺）。
   *
   * 关系成员裁剪（#P0：拖地图要 10 秒的根因）：
   *   关系索引存的是**整条关系**的 bbox，而全城级关系（国道/铁路/公交线路/行政边界）的成员
   *   分布在整座城市里 —— 视口只要碰到它，以前的实现就把它的**每一个成员**连同几何一起下发，
   *   于是每个响应都夹带 1 万~1.7 万条城市另一头的成员路（实测 4~19 MB，与视口大小无关）。
   *   现在按视口裁剪成员（见下面"关系成员裁剪"那段），并把裁剪量如实记在
   *   truncation.crop / truncation.kinds.relations 与 payload 的 relations[id][3] 里。
   *   裁剪**不影响** complete：被裁掉的成员全部在裁剪框之外，请求框内的成员一条不少。
   */
  queryBbox({ minLon, minLat, maxLon, maxLat, zoom = 16, limit = 12000, wayCandidates, nodeCandidates, relationLimit, relationCropPad, relationCropMinMembers, relationCropBoundaryMembers, detail, lodDetail, minFillArea, lodMinFillArea, roadSend, lodRoadSend, roadClassFloor, lodRoadClassFloor, neverSend, lodNeverSend, coalesce, lodCoalesce, compact, view, flatCaps, _dlodOff }) {
    const st = this._st;
    const caps = {
      viewportLimit: Math.max(1, Math.floor(Number(limit)) || QUERY_CAPS.viewportLimit),
      wayCandidates: capOf(wayCandidates, QUERY_CAPS.wayCandidates),
      nodeCandidates: capOf(nodeCandidates, QUERY_CAPS.nodeCandidates),
      relationLimit: capOf(relationLimit, QUERY_CAPS.relationLimit),
      relationCropPad: numOf(relationCropPad, QUERY_CAPS.relationCropPad),
      relationCropMinMembers: Math.floor(numOf(relationCropMinMembers, QUERY_CAPS.relationCropMinMembers)),
      relationCropBoundaryMembers: relationCropBoundaryMembers === undefined
        ? !!QUERY_CAPS.relationCropBoundaryMembers : !!relationCropBoundaryMembers,
    };
    /**
     * 服务端 LOD：见文件开头「服务端路网分级」与「服务端 LOD」两段。
     * 两条判据（路网等级 / 建筑面）扣下的条数都记进 lodFiltered（**不是** dropped）。
     */
    const lod = makeLod({ zoom, detail, lodDetail, minFillArea, lodMinFillArea, roadSend, lodRoadSend, roadClassFloor, lodRoadClassFloor, neverSend, lodNeverSend });
    /**
     * 低缩放几何合并（见文件开头「低缩放几何合并」那一段）：z < minZoom 时把高条数类的 way
     * 合并成 displayLines（只有几何、没有 id，客户端只画不选）。
     * 生效时**放宽 way 扫描的挑取上限**（挑取不再受 viewportLimit 限制，因为合并后的条数才是
     * 真正下发的条数）—— 上限仍然存在（候选上限 wayCandidates × viewportLimit），
     * 它被砍断时会如实报在 truncation 里（`candidatesCapped` / `unscanned`），绝不假装完整。
     */
    const coalesceOpts = coalesceOptsOf(coalesce || lodCoalesce);
    /**
     * **低缩放"只看不改"的那一档**：z < coalesce.minZoom（默认 15 = VIEW_ONLY_MAX_ZOOM + 1，
     * 也就是 z ≤ 14）**且** LOD 档位 ≥
     * VIEW_ONLY_MIN_DETAIL（2）。这一档里服务端发的是"合并几何"（displayLines / displayAreas，
     * 都没有 way id）—— 也就是**没有东西可以拾取/编辑**，这正是"低缩放只看不改"的口径。
     *
     * `detail=0/1`（客户端「完整 / 全部道路」档）是"我要全量数据（含编辑）"的档位：
     * 这两个档位下**合并与视图载荷都关掉**，真 way id + 全量几何照旧下发（z10 实测约 2.5 MB、
     * 超过 viewportLimit 时如实报 truncated，客户端按块拆）。
     */
    const coalescing = coalesceOpts.minZoom > 0 && zoom < coalesceOpts.minZoom && lod.detail >= VIEW_ONLY_MIN_DETAIL;
    /**
     * **低缩放视图载荷**（见文件开头「低缩放视图载荷」那一段）：合并生效的那一档里，
     * 面几何也只下发"画得出来的紧凑几何"（displayAreas），原始 way 几何 + 节点坐标不下发。
     * 生效条件与上面那条同源（`detail=0/1` 整个关掉），另外可用请求参数 `view=0/1` 强制关/开。
     */
    const viewArg = view === undefined || view === null || view === '' ? null
      : (view === false || view === 0 || view === '0' || view === 'false' ? false : true);
    const viewOnly = viewArg === null
      ? (coalescing && lod.detail >= VIEW_ONLY_MIN_DETAIL)
      : (viewArg && coalesceOpts.minZoom > 0 && zoom < coalesceOpts.minZoom);
    /**
     * **预计算低缩放显示图层**（见 server/displaylod.js 的文件头那一段）。
     *
     * `dlod` 非空 = 这次请求的 displayLines / displayAreas **直接从库里读**，
     * `_coalesce` / `_coalesceAreas` 不再跑、也不再为合并部分取任何 way 几何；
     * 那本 `truncation` 账改由预计算的**去向表**（display_lod_cov）如实重建。
     *
     * 只有当"客户端要的正好是这一层烘出来的东西"才对得上：合并生效、走的是视图载荷、
     * 而且 LOD / 合并参数与签名完全一致；任何一条不满足都**退回实时路径**（画面永远是对的）。
     */
    const dlodPlan = (viewOnly && !_dlodOff && !this._dlodOff)
      ? this._dlodPlan(zoom, { minLon, minLat, maxLon, maxLat }, lod, coalesceOpts, limit, caps.viewportLimit)
      : null;
    /** 紧凑载荷（见文件开头「紧凑载荷」一段）：坐标量化 + 列式/delta 编码，语义不变 */
    const pack = packOptsOf(compact);
    /**
     * **客户端能力开关**（见下面 ② 摊平那一段的完整说明）：这一次请求的客户端**有没有声明**
     * 它认识扁平几何（`?caps=` 含 `flatsegs`，或 `?fmt=bin`）。没声明就一律发老形状 ——
     * 于是部署瞬间还在跑的旧标签页/旧缓存 JS 不会被新协议打坏。
     */
    const capsFlat = flatCaps === true;
    /** 因为 LOD 没下发的条数（按类记账）：'building' / 'roadClass' / 'neverSend' → 条数。**不是**截断。 */
    const lodWithheld = {};
    let lodWithheldTotal = 0;
    /**
     * **永不下载的类别**（树 / 自行车道，见文件开头那一段）的明细账：way / 节点 / 关系成员分开数，
     * 每一档都按类（trees / cycleways）细分 —— 这样"是树省下来的还是车道省下来的"一眼看得出来。
     * 它们同样**不是 dropped**（规则上永不下发），与 lodFiltered 同一口径。
     */
    const neverSendLedger = { ways: {}, nodes: {}, memberWays: {}, total: 0 };
    const neverSendCount = (scope, cls) => {
      const bag = neverSendLedger[scope];
      if (!bag) return;
      bag[cls] = (bag[cls] || 0) + 1;
      neverSendLedger.total += 1;
    };
    /**
     * 独立核账（规则上恒为 0，将来改规则时不会悄悄违约）：
     *   lodTrunkRoadsWithheld —— **主干道**（rank 0）被 LOD 扣下的条数：必须 0
     *   lodRailWaterWithheld —— 干线铁路 / 水系 / 水域 / 行政边界被扣下的条数：必须 0
     *   lodMinorRoadsWithheld / roadsByRank —— 被等级 LOD 扣下的**次要道路**（按等级细分）
     *   lodMinorRailWithheld —— 非干线铁路（场站/支线）被扣下的条数
     *   lodLanduseWithheld   —— 装饰性面（landuse/leisure）按面积门槛被扣下的条数
     */
    let lodTrunkRoadsWithheld = 0;
    let lodRailWaterWithheld = 0;
    let lodMinorRoadsWithheld = 0;
    let lodMinorRailWithheld = 0;
    let lodLanduseWithheld = 0;
    const roadsByRank = {};
    const args = [minLon, maxLon, minLat, maxLat];   // R*Tree 参数顺序：(minLon, maxLon, minLat, maxLat)
    /**
     * 候选扫描上限：合并生效时按 coalesce.wayCandidates（默认 48×）放宽 —— 合并之后
     * "每次请求下发多少"已经由折线决定，卡住 complete 的只剩这道"一次最多看多少行"的安全阀
     * （见 COALESCE_DEFAULTS.wayCandidates 的说明）。没合并时维持老口径。
     */
    const wayScanCap = caps.viewportLimit * (coalescing ? Math.max(caps.wayCandidates, coalesceOpts.wayCandidates) : caps.wayCandidates);
    const nodeScanCap = caps.viewportLimit * caps.nodeCandidates;

    // ---------- 1. 道路/区域：先按显示分级筛选，再批量取几何（避免每条路一次查询）----------
    // 顺序：老的"按缩放的显示分级"（lodVisible，永远生效的基础地板）→ 服务端 LOD（档位相关：
    // 路网等级 + 建筑面；detail=0/1 时全关）。两级都只决定"要不要下发"，**不减几何**。
    //
    // 低缩放（z ≤ WAY_LOD_INDEX_MAX_ZOOM）时候选扫描改走物化列 + 部分索引（见 _wayScanPlan）：
    // `lod_zoom <= zoom` 恰好把"这一档看不见的次要道路/建筑/用地"挡在扫描之外 ——
    // 这不是新增的过滤，而是把 accept() 里**本来就要做**的那次 lodVisible 判断提前到索引上做，
    // 所以 `visible` / `lodFiltered` / `dropped` / `complete` 的账一个数都不变
    // （唯一差别：被删掉的 way 不再当候选 —— 老路径里它们本来就一律被 accept() 丢掉）。
    const wayPlan = this._wayScanPlan(zoom, lod.floor);
    const wayArgs = wayPlan ? [zoom, ...args] : args;
    /**
     * **走预计算路径时这里一行 way 都不扫**：
     * `display_lod_cov` 已经是"这块瓦片里每个候选 way 去了哪"的完整答案（见 `_dlodReadCov`），
     * 而它逐条对齐实时路径的账（candidates / visible / coalesced / lodFiltered / dropped）。
     * 实测这一步值多少：真实数据集 z10 扫 2.36 万行 **168 ms**、z12 2.06 万行 **214 ms**、
     * z13 1.68 万行 **206 ms**（`logs/pc-floor.txt`）—— 走预计算路径时省掉的就是这一块，
     * 也是"能不能压到 200 ms 以内"的关键一块。账本改成由去向表重建（见下面 `dlodCov` 的用法）。
     */
    const dlodCov = dlodPlan ? this._dlodReadCov(dlodPlan, { minLon, minLat, maxLon, maxLat }) : null;
    const wayScan = dlodCov
      ? {
        values: [],
        candidates: dlodCov.candidates,
        visible: dlodCov.visible,
        capped: false, scannedAll: true, unscanned: 0, stopReason: 'exhausted',
        pickLimit: coalescing ? wayScanCap : caps.viewportLimit, scanCap: wayScanCap,
        precomputed: true,
      }
      : this._scanCandidates({
      sql: wayPlan
        ? `SELECT w.id, w.tags, w.version, w.node_count, w.closed, w.deleted,
          w.min_lon AS bb_min_lon, w.max_lon AS bb_max_lon, w.min_lat AS bb_min_lat, w.max_lat AS bb_max_lat
        FROM ways w INDEXED BY ${WAY_LOD_INDEX}
        WHERE w.lod_zoom <= ? AND w.deleted = 0 AND w.min_lon IS NOT NULL
          AND w.max_lon >= ? AND w.min_lon <= ? AND w.max_lat >= ? AND w.min_lat <= ?
        LIMIT ?`
        : `SELECT w.id, w.tags, w.version, w.node_count, w.closed, w.deleted,
          i.min_lon AS bb_min_lon, i.max_lon AS bb_max_lon, i.min_lat AS bb_min_lat, i.max_lat AS bb_max_lat
        FROM way_index i JOIN ways w ON w.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ?
        LIMIT ?`,
      // 删一条路会连它的 way_index 行一起删，所以索引行数就是候选行数（COUNT 走索引，很快）
      countSql: wayPlan
        ? `SELECT COUNT(*) AS c FROM ways w INDEXED BY ${WAY_LOD_INDEX}
        WHERE w.lod_zoom <= ? AND w.deleted = 0 AND w.min_lon IS NOT NULL
          AND w.max_lon >= ? AND w.min_lon <= ? AND w.max_lat >= ? AND w.min_lat <= ?`
        : `SELECT COUNT(*) AS c FROM way_index i
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ?`,
      args: wayArgs,
      scanCap: wayScanCap,
      /**
       * 挑取上限：合并生效时**不再用 viewportLimit 卡**（合并掉的 way 不进 payload.ways，
       * 真正决定体积的是"组数"），交给候选上限兜底；合并没生效时维持老行为（15000 条）。
       */
      pickLimit: coalescing ? wayScanCap : caps.viewportLimit,
      accept: (w) => {
        if (w.deleted) return null;
        const tags = parseTags(w.tags);
        if (!lodVisible(tags, zoom, 'line', lod.floor)) return null;
        // LOD：这一档看不清 / 客户端不画的东西留在库里（面积按需算，只有装饰性面与 minFillArea 才走）
        const cls = lodWithholdClass(tags, zoom, lod, w, !!w.closed);
        if (cls) {
          lodWithheld[cls] = (lodWithheld[cls] || 0) + 1;
          lodWithheldTotal += 1;
          if (cls === 'neverSend') {
            // 树 / 自行车道：按类另记一笔（与 roadClass 那套账各算各的）
            neverSendCount('ways', neverSendClassOf(tags));
          } else if (cls === 'roadClass') {
            const rank = roadRankOf(tags);
            if (rank === 0) lodTrunkRoadsWithheld += 1;                 // 不该发生 → 独立核账
            else {
              lodMinorRoadsWithheld += 1;
              const name = roadRankName(rank);
              roadsByRank[name] = (roadsByRank[name] || 0) + 1;
            }
          } else if (cls === 'railMinor') {
            lodMinorRailWithheld += 1;
            if (tags && tags.usage === 'main') lodRailWaterWithheld += 1;   // 不该发生 → 独立核账
          } else if (cls === 'landuse') {
            lodLanduseWithheld += 1;
          }
          return null;
        }
        return { row: w, tags };
      },
    });
    /**
     * 预计算路径下 LOD 那本账由**去向表**重建（每个候选 way 的去向连同被扣下的类别都烘在里面了，
     * 见 `_dlodCovRowsOf`）。口径与实时路径的 accept() 逐项对齐：`lodFiltered` 按类、
     * `roadsWithheldByClass` 按等级、`neverSend` 按类、两个"恒为 0"的独立核账也在。
     */
    if (dlodCov) {
      lodWithheldTotal = dlodCov.lodWithheldTotal;
      for (const k of Object.keys(dlodCov.lodBy)) lodWithheld[k] = dlodCov.lodBy[k];
      lodTrunkRoadsWithheld = dlodCov.trunkWithheld;
      lodMinorRoadsWithheld = Math.max(0, (dlodCov.lodBy.roadClass || 0) - dlodCov.trunkWithheld);
      lodMinorRailWithheld = dlodCov.minorRailWithheld;
      lodRailWaterWithheld = dlodCov.railWaterWithheld;
      lodLanduseWithheld = dlodCov.landuseWithheld;
      for (const k of Object.keys(dlodCov.roadsByRank)) roadsByRank[k] = dlodCov.roadsByRank[k];
      let neverWays = 0;
      for (const k of Object.keys(dlodCov.neverSendWays)) {
        neverSendLedger.ways[k] = (neverSendLedger.ways[k] || 0) + dlodCov.neverSendWays[k];
        neverWays += dlodCov.neverSendWays[k];
      }
      neverSendLedger.total += neverWays;
    }

    const ways = {};
    const nodeIds = new Set();
    let picked = wayScan.values;
    /**
     * 预计算路径下"逐条下发"的那些 way（去向 = `way`）：按 id 把真行取回来 ——
     * 实测 z10~z13 这一档是 **0 条**（可见的 way 全部进了折线/面），z14 约 200 条。
     * 取行与几何的代码与实时路径**完全相同**（`_wayRowsByIds` + 下面那个循环 + `wayNodesBatch`），
     * 所以这一小撮 way 的输出逐字段一致。
     */
    if (dlodCov && dlodCov.sentWay.size) {
      picked = this._wayRowsByIds([...dlodCov.sentWay].sort((a, b) => a - b));
    }
    /**
     * **候选顺序确定性**（只在低缩放合并生效时做）：
     * displayLines 的接龙 + 简化是**贪心**的（从度为 1 的端点起头，按输入顺序接），
     * 于是"同一批 way、不同的候选顺序"会得到**同一份几何、不同的分段**（画出来一样，
     * 但字节不同、也没法逐字节比对两条扫描计划）。这里按 id 排一遍，让合并结果与
     * "候选是 R*Tree 给的还是索引给的"无关 —— 以后换索引/换计划都不会让低缩放折线悄悄变样
     * （验证见 tests/tmp-lodidx/verify-plans.js：两条计划逐 way、逐折线、逐账本完全一致）。
     */
    if (coalescing) picked.sort((a, b) => a.row.id - b.row.id);
    /**
     * 挑出来的 way id 集合：关系成员那一节用它判断"这条成员是不是已经在 ways 里了"
     * （以前读的是 ways 字典的键，但几何要等合并计划定下来才知道谁进 ways，
     *  所以改成"凡是被挑出来的就算已下发" —— 语义一致：不会重复下发同一条 way）。
     */
    const pickedIds = dlodCov
      ? dlodCov.pickedIds
      : new Set(picked.map((p) => p.row.id));
    let noGeometry = dlodCov ? dlodCov.noGfx.size : 0;
    let returnedWays = 0;

    // ---------- 2. 视口内带标签的独立节点（POI）----------
    // 候选只在**带标签**的节点里数：数据集中 90% 以上是没有标签的几何顶点（建筑的角点等），
    // 它们不可能是 POI，却会把候选名额吃光 —— 那样"上限"就变成了"随机看了一小撮节点"。
    //
    // 性能（#3）：`n.tags IS NOT NULL` 没有索引可用。视口大时（z13/z14）SQLite 会把视口内
    // 每个节点都读一遍（真实数据集 z13 = 188 万行，实测 850~970 ms）才发现 9.8 万个带标签的；
    // 用部分索引 idx_nodes_tagged 反过来驱动只要 ~400 ms。视口小时正好相反（R*Tree 几毫秒），
    // 所以这里按视口跨度显式选计划（_nodeScanHint），两种计划看到的行集合完全一样，
    // 候选账本（candidates / unscanned / exact / complete）的语义不变。
    //
    // **低缩放这一档再往前走一步**（见 _nodePoiPlan）：z ≤ 15 时"可见的 POI"只有地名与
    // 山峰/泉/洞口，于是候选扫描直接走部分索引 idx_nodes_poi_low —— z10 候选 10.57 万行
    // （其中 10.35 万个在 accept() 里被丢掉）→ 2150 行，`scan.nodes` 1.17 s → 0.03 s。
    const nodePlan = this._nodePoiPlan(zoom);
    const nodeHint = this._nodeScanHint(minLon, maxLon);
    const nodeScan = this._scanCandidates({
      sql: nodePlan
        ? `SELECT n.id, n.lat, n.lon, n.tags, n.version
        FROM nodes n INDEXED BY ${NODE_POI_INDEX}
        WHERE n.deleted = 0 AND n.tags IS NOT NULL AND ${NODE_POI_LOW_PREDICATE}
          AND n.lat >= ? AND n.lat <= ? AND n.lon >= ? AND n.lon <= ?
        LIMIT ?`
        : `SELECT n.id, n.lat, n.lon, n.tags, n.version
        FROM node_index i JOIN nodes n${nodeHint} ON n.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND n.deleted = 0
          AND n.tags IS NOT NULL
        LIMIT ?`,
      countSql: nodePlan
        ? `SELECT COUNT(*) AS c
        FROM nodes n INDEXED BY ${NODE_POI_INDEX}
        WHERE n.deleted = 0 AND n.tags IS NOT NULL AND ${NODE_POI_LOW_PREDICATE}
          AND n.lat >= ? AND n.lat <= ? AND n.lon >= ? AND n.lon <= ?`
        : `SELECT COUNT(*) AS c
        FROM node_index i JOIN nodes n${nodeHint} ON n.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND n.deleted = 0
          AND n.tags IS NOT NULL`,
      args: nodePlan ? [minLat, maxLat, minLon, maxLon] : args,
      scanCap: nodeScanCap,
      pickLimit: nodeScanCap,     // POI：扫到多少给多少（返回上限就是候选上限）
      accept: (n) => {
        /**
         * 注：这里试过加 `pointTagsMaybeVisible(n.tags, zoom)` 的前置判断（省掉 JSON.parse），
         * 实测**一点用都没有**（z13 节点扫描仍是 370 ms 上下）—— 这一段的耗时不在 JSON.parse，
         * 而在"29830 行 SQLite 取行 + 逐行 R*Tree 连接"（见 _nodeScanHint 的说明）。
         * 所以不加它：省不下时间就不要再引入一条可能与 lodVisible 不同步的判断。
         * （真正管用的是把这条判据放进索引选择里，见 _nodePoiPlan —— 连行都不用取。）
         */
        const tags = parseTags(n.tags);
        if (!tags) return null;
        // 先按缩放分级（这一档本来就看不见的，不记进 neverSend 的账 —— 账只数"本来要发、被这条规则拦下的"）
        if (!lodVisible(tags, zoom, 'point')) return null;
        // 永不下载的类别（树 / 自行车道）：节点也照扣（street tree 在 OSM 里多半就是带标签的节点，
        // z ≥ 17 会当成 POI 进 payload.nodeTags —— 那才是这条规则在节点上的真实收益）
        if (lod.neverSendOn) {
          const never = neverSendClassOf(tags);
          if (never) { neverSendCount('nodes', never); return null; }
        }
        return { row: n, tags };
      },
    });
    const nodeTags = {};
    let returnedNodes = 0;
    // 低缩放 POI 计划下把候选按 id 排一遍：索引扫描顺序与 R*Tree 顺序不同，
    // 排一下让 payload.nodeTags 的键顺序与"扫描计划"无关（客户端标签绘制的顺序也就稳定了）。
    if (nodePlan) nodeScan.values.sort((x, y) => x.row.id - y.row.id);
    for (const { row, tags } of nodeScan.values) {
      nodeIds.add(row.id);
      nodeTags[row.id] = tags;
      returnedNodes += 1;
    }

    // ---------- 3. 关系（多面体/边界等）与它们的成员（按视口裁剪成员） ----------
    /**
     * 裁剪规则（前三条是"永不裁"的底线，第四条才是真正会裁的）：
     *   1. 成员数 ≤ caps.relationCropMinMembers（默认 64）→ **不裁**：小关系永远是完整的
     *      （本数据集 643 个多面体建筑关系里，成员最多只有 20 个）；
     *   2. 有**环语义**的关系 → **不裁**：type=multipolygon，以及带 landuse/leisure/natural…
     *      这类"会被当**面**填色渲染"的 boundary —— 成员 way 少一条就接不成环，
     *      多面体建筑的**内环（天井/内院）**会整个丢掉（客户端靠环接龙 + 挖洞画的）；
     *   3. 关系整体落在裁剪框内 → **不裁**（本来就没有可裁的：它的成员与视口同量级）；
     *   4. 其余（实测就是 type=route 这类**线状**关系：成员只是一串路径，没有环语义、
     *      没有内环、客户端也不拿它画关系轮廓）→ 只保留**几何 bbox 与裁剪框相交**的成员。
     *
     * 实测（tests/tmp-relcrop/probe-mptype.js，真实数据集 10002 个关系）：
     *   真正把 payload 撑起来的是 type=route（1898 个关系、成员合计 270019 条，
     *   单个最大 8973 条 —— 国道/铁路/公交线路横跨全城），而带环语义的关系总量很小
     *   （multipolygon 1279 个共 4075 条成员、boundary 255 个共 3704 条），所以"只裁线状关系"
     *   既拿到了绝大部分收益，又完全不碰环/内环。纯行政边界（不属于第 2 条的那种）默认也保护，
     *   实测只值 ~2% payload，想更激进可以开 limits.relationCropBoundaryMembers。
     *
     * 裁剪框 = 请求 bbox 每边再外扩 (视口尺寸 × relationCropPad)，**严格大于请求 bbox**，
     * 所以"请求框内一条不少"是可证明的：成员几何与请求框相交 ⇒ 必与裁剪框相交 ⇒ 必被保留。
     * 外扩的意义还有一条：线路在屏幕边缘要"画到屏幕外"，不留一点余量就会在视口边上断掉。
     *
     * 裁剪量如实记账（relations[id][3] 与 truncation.crop / truncation.kinds.relations），
     * 但**不算 truncated**：裁掉的全部在请求框之外，请求框内没有任何缺失（否则客户端会
     * 永远拆块：每一块都会再裁一次全城级关系，永远 complete=false）。
     */
    const relScan = this._scanCandidates({
      sql: `SELECT r.id, r.tags, r.version, r.member_count,
          i.min_lon AS rel_min_lon, i.max_lon AS rel_max_lon, i.min_lat AS rel_min_lat, i.max_lat AS rel_max_lat
        FROM relation_index i JOIN relations r ON r.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ?
        LIMIT ?`,
      countSql: `SELECT COUNT(*) AS c FROM relation_index i
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ?`,
      args,
      scanCap: caps.relationLimit,
      pickLimit: caps.relationLimit,
      accept: (r) => {
        const tags = parseTags(r.tags);
        return tags && lodVisible(tags, zoom, 'area') ? { row: r, tags } : null;   // 关系同样遵守分级，避免成员绕过分级
      },
    });
    /**
     * 裁剪框：请求 bbox 每边外扩 (请求尺寸 × relationCropPad)，**严格大于请求 bbox**。
     * 所以"请求框内一条不少"是可证明的：成员几何与请求框相交 ⇒ 必与裁剪框相交 ⇒ 必被保留。
     * 外扩还有一层意义：线路在屏幕边缘要"画到屏幕外"，不留余量就会在视口边上断掉。
     *
     * 注意：这里**只裁成员列表**（哪些成员算"在视野里"），成员 way 的几何一律**整条下发**。
     * 曾经试过"把成员几何也裁到框内"，但那会破坏客户端"一条 way 只存一份几何、
     * 相邻缓存矩形互相覆盖"的前提（同一条路被两块瓦片各裁一半 → 画面上出现真空缺），
     * 所以不做（见 tests/tmp-lodsvr/RESULTS-lodsvr.md 的说明）。
     */
    const cropPadLon = (maxLon - minLon) * caps.relationCropPad;
    const cropPadLat = (maxLat - minLat) * caps.relationCropPad;
    const cropBox = {
      minLon: minLon - cropPadLon, maxLon: maxLon + cropPadLon,
      minLat: minLat - cropPadLat, maxLat: maxLat + cropPadLat,
    };
    // 成员取出来（逐关系跑同一条 prepared 语句；实测比"一条 SQL 批量取"更快，见 _relationMembersFor）
    const relRows = relScan.values;
    const membersByRel = this._relationMembersFor(relRows.map((v) => v.row.id));

    // 第一遍：定下每个关系裁不裁（成员已批量取到，这里只是分类 + 打标）
    const plan = [];
    for (const { row: r, tags } of relRows) {
      const members = membersByRel.get(r.id) || [];
      /**
       * "环语义"的关系一律不裁：
       *   · type=multipolygon：成员是环的一段，少一条就接不成环 —— 多面体建筑的
       *     **内环（天井/内院）**会整个丢掉，而客户端正是靠环来接龙 + 挖洞的；
       *   · 带 landuse/leisure/natural/water/wetland/building 的 boundary：客户端会把它
       *     当**面**填色渲染（style 的面规则），裁了同样接不成环；
       *   · 其它 boundary（纯行政边界）默认也保护起来（保守）：客户端把它们画成**虚线**
       *     （style 里 boundary 规则是 kind:'line'、没有 fill），不靠 relation 的环渲染，
       *     所以裁掉视口外的成员在画面上是无损的 —— 但实测这一档只值 ~2% payload
       *     （那些边界 way 本来就在视口自己的 way 扫描里），所以默认不动它；
       *     想要更短的成员列表可以把 config.json 的 limits.relationCropBoundaryMembers 打开
       *     （实测 z13 profile 9188→9117 KB、成员条 4450→2626，画面无损，账也照实记）。
       */
      const areaLike = !!(tags.building || tags['building:part'] || tags.landuse || tags.leisure
        || tags.natural || tags.water || tags.wetland);
      const isBoundary = tags.type === 'boundary' || !!tags.boundary;
      const ringSemantics = tags.type === 'multipolygon'
        || (isBoundary && (areaLike || !caps.relationCropBoundaryMembers));
      const insideCropBox = Number.isFinite(r.rel_min_lon)
        && r.rel_min_lon >= cropBox.minLon && r.rel_max_lon <= cropBox.maxLon
        && r.rel_min_lat >= cropBox.minLat && r.rel_max_lat <= cropBox.maxLat;
      const willCrop = !ringSemantics && !insideCropBox && members.length > caps.relationCropMinMembers;
      /**
       * 低缩放视图载荷：这个关系**会不会被客户端当面填色画出来**（是 → 成员几何在服务端接龙成环、
       * 作为一条 displayArea 下发；否 → 成员按老办法逐条下发/参与折线合并）。
       * 判据 = 上面那套"环语义"（multipolygon / 带面标签的 boundary）+ 服务端 LOD：
       *   · 客户端不画的东西（z10 的多面体建筑：默认档 z≤15 一栋楼都不画）成员几何**直接不发**，
       *     如实记在 ledger.membersWithheldByLod（**不是** dropped，与 lodFiltered 同一口径）；
       *   · 面关系的 bbox 借用 relation_index 的列（面积门槛要用它）。
       */
      const lodRow = {
        bb_min_lat: r.rel_min_lat, bb_max_lat: r.rel_max_lat,
        bb_min_lon: r.rel_min_lon, bb_max_lon: r.rel_max_lon,
      };
      const withheld = viewOnly ? lodWithholdClass(tags, zoom, lod, lodRow, true) : null;
      const areaDrawn = viewOnly && !withheld && relationAreaLike(tags);
      plan.push({ row: r, tags, members, willCrop, areaDrawn, withheld });
    }
    // 要裁的关系：一次 SQL 问出"哪些成员的几何在裁剪框里"（不逐条查）
    const cropWayRefs = [];
    const cropNodeRefs = [];
    for (const p of plan) {
      if (!p.willCrop) continue;
      for (const m of p.members) {
        if (m[0] === 'way') cropWayRefs.push(m[1]);
        else if (m[0] === 'node') cropNodeRefs.push(m[1]);
      }
    }
    const keptWayRefs = this._waysIntersecting(cropWayRefs, cropBox);
    const keptNodeRefs = this._nodesIntersecting(cropNodeRefs, cropBox);

    const relations = {};
    const memberWayIds = new Set();
    /** 所有（保留下来的）成员 way id：这些**一律不合并**（关系要靠成员几何拼环/拼线） */
    const memberWayRefs = new Set();
    const memberNodeIds = new Set();
    /**
     * 低缩放视图载荷专用：
     *   areaMemberIds  面关系的成员 way（几何在服务端接龙成环 → displayAreas，不逐条下发）
     *   withheldMemberIds 被 LOD 扣下的关系（客户端不画）的成员 way —— 几何一条都不发
     */
    const areaMemberIds = new Set();
    const areaRels = [];
    let returnedRelations = 0;
    const ledger = {
      memberTotal: 0, memberReturned: 0,
      memberWaysTotal: 0, memberWaysReturned: 0,
      memberNodesTotal: 0, memberNodesReturned: 0,
      memberRelsTotal: 0, memberRelsReturned: 0,
      croppedRelations: 0,
      /** 低缩放视图载荷的账（见文件开头「低缩放视图载荷」）：成员去 displayAreas 的 / 被 LOD 扣下的 */
      memberWaysAsAreas: 0, memberWaysCoalesced: 0, memberWaysWithheld: 0, memberWaysUnaccounted: 0,
      memberWaysNeverSent: 0,
      memberWaysPicked: 0, memberWaysToFetch: 0, memberWaysFetched: 0, memberWaysMissing: 0,
      relationsAsAreas: 0, relationsWithheld: 0,
    };
    for (const p of plan) {
      const { row: r, tags, members } = p;
      let kept = members;
      let cropInfo = null;
      if (p.willCrop) {
        kept = members.filter((m) => {
          if (m[0] === 'way') return keptWayRefs.has(m[1]);
          if (m[0] === 'node') return keptNodeRefs.has(m[1]);
          return true;   // 成员类型是 relation 的超关系：数量极少，也没有便宜的 bbox，一律保留
        });
        // 内环保险（环语义的关系本来就不裁，这里是双保险）：只要留下了一个 inner，
        // 就把这个关系的 inner 成员**全部**留下 —— 宁可多给几条，也不让内环断成半个。
        if (kept.some((m) => m[2] === 'inner')) {
          const have = new Set(kept.map((m) => m[0] + ':' + m[1]));
          for (const m of members) {
            if (m[2] !== 'inner') continue;
            const key = m[0] + ':' + m[1];
            if (!have.has(key)) { have.add(key); kept.push(m); }
          }
        }
        if (kept.length < members.length) {
          const tot = { way: 0, node: 0, relation: 0 };
          for (const m of members) tot[m[0]] = (tot[m[0]] || 0) + 1;
          const cnt = { way: 0, node: 0, relation: 0 };
          for (const m of kept) cnt[m[0]] = (cnt[m[0]] || 0) + 1;
          cropInfo = {
            cropped: true,
            reason: 'viewport',          // 只为视口裁剪（不是上限截断，不受 truncated/complete 影响）
            memberTotal: members.length,
            memberKept: kept.length,
            memberWaysTotal: tot.way, memberWaysKept: cnt.way,
            memberNodesTotal: tot.node, memberNodesKept: cnt.node,
            memberRelsTotal: tot.relation, memberRelsKept: cnt.relation,
          };
          ledger.croppedRelations += 1;
        }
      }
      relations[r.id] = [r.version, kept, tags, cropInfo];
      returnedRelations += 1;
      ledger.memberTotal += members.length;
      ledger.memberReturned += kept.length;
      for (const m of members) { if (m[0] === 'way') ledger.memberWaysTotal += 1; else if (m[0] === 'node') ledger.memberNodesTotal += 1; else ledger.memberRelsTotal += 1; }
      for (const [type, ref] of kept) {
        if (type === 'way') {
          ledger.memberWaysReturned += 1;
          if (p.areaDrawn) {
            // 面关系的成员：几何走"服务端接龙成环 → displayAreas"，不逐条下发（也就不用取它的真 way 行）
            areaMemberIds.add(ref);
            ledger.memberWaysAsAreas += 1;
          } else if (p.withheld) {
            // 客户端这一档根本不画这个关系：成员几何一条都不发（如实记账，不是 dropped）
            ledger.memberWaysWithheld += 1;
          } else {
            memberWayRefs.add(ref);
            // 已经在 ways 里的成员不必再取一次；被挑出来但**会被合并成折线**的成员在这里被
            // 排除在合并之外（见 _coalesce 的 exclude），仍然以真 way id + 真几何下发 ——
            // 关系成员路一直是"上限之外补齐"的，所以不占条数名额。
            // 【低缩放视图载荷】不排除：那一档关系成员的线几何本来就直接画在折线里，所以成员
            // 和其它 way 一起参与折线合并（合并掉的成员几何在 displayLines 里，一条都没少）。
            if (!pickedIds.has(ref)) memberWayIds.add(ref);
            else ledger.memberWaysPicked += 1;   // 成员同时也是候选 way：几何走 way 扫描那条路
          }
        } else if (type === 'node') {
          ledger.memberNodesReturned += 1;
          if (!nodeIds.has(ref)) memberNodeIds.add(ref);
        } else ledger.memberRelsReturned += 1;
      }
      if (viewOnly && p.areaDrawn) { areaRels.push({ id: r.id, tags, members: kept.filter((m) => m[0] === 'way').map((m) => m[1]) }); ledger.relationsAsAreas += 1; }
      if (viewOnly && p.withheld) ledger.relationsWithheld += 1;
    }
    ledger.memberCropped = ledger.memberTotal - ledger.memberReturned;
    ledger.memberWaysCropped = ledger.memberWaysTotal - ledger.memberWaysReturned;
    ledger.memberNodesCropped = ledger.memberNodesTotal - ledger.memberNodesReturned;
    ledger.memberRelsCropped = ledger.memberRelsTotal - ledger.memberRelsReturned;

    // ---------- 3b. way 几何 + 低缩放合并（displayLines）----------
    /**
     * 顺序说明：合并计划要在**知道哪些 way 是关系成员之后**才能定（成员必须保留真 way id + 真几何，
     * 关系要靠它们拼环/拼线），所以"取几何"这一步挪到关系那一节之后。
     * 几何仍然是**一次批量取**（wayNodesBatch），合并与不合并的 way 共用这一份，不多查一次库。
     */
    const geom = picked.length ? this.wayNodesBatch(picked.map((p) => p.row.id)) : new Map();
    /**
     * **永不下载的类别**（树 / 自行车道）在成员路径上也要挡掉（见文件开头那一段）：
     * 不然一条 cycleway / tree_row 只要挂进某个关系就绕过了 way 扫描那道筛子。
     * 挡掉的是"几何一条不给"：既不下发、也不参与折线与面合并；单独记在 memberWaysNeverSent。
     *
     * 这一段（取成员行 + 三个账）**两条路都要**：预计算路径不再需要成员的几何，
     * 但"成员去哪了"的账（toFetch / fetched / missing / neverSent）必须照样如实。
     */
    const keepMemberRows = (rows) => {
      if (!lod.neverSendOn) return rows;
      return rows.filter((r) => {
        const cls = neverSendClassOf(r.tags);
        if (!cls) return true;
        neverSendCount('memberWays', cls);
        ledger.memberWaysNeverSent += 1;
        return false;
      });
    };
    const memberRowsRaw = (viewOnly && memberWayIds.size) ? this._wayRowsByIds([...memberWayIds]) : [];
    const memberRows = keepMemberRows(memberRowsRaw);
    ledger.memberWaysToFetch = memberWayIds.size;          // 需要按 id 取行的成员（非候选/非面关系）
    ledger.memberWaysFetched = memberRowsRaw.length;       // 真的取到的（被删掉 / 不在数据集里的成员取不到）
    ledger.memberWaysMissing = Math.max(0, memberWayIds.size - memberRowsRaw.length);
    /**
     * ==================== 预计算路径：读预计算层代替"当场合并" ====================
     *
     * 走这条路时 `_coalesce` / `_coalesceAreas` **一次都不跑**，也**不为合并部分取任何 way 几何**
     * （那正是原来那 145 ms 取 way 几何 + 453 ms 取 10 万个节点坐标的来源）。
     * `geom` 上面已经取过 —— 它是"逐条下发的那几条 way"的几何，数量极小（z10~z13 实测 0 条）。
     */
    let coalescePlan = null;
    let areasPlan = null;
    if (dlodPlan) {
      const rd = this._dlodRead(dlodPlan, { minLon, minLat, maxLon, maxLat });
      const cov = dlodCov;
      const lineStats = rd.stats;
      coalescePlan = {
        active: true,
        lines: rd.lines,
        coalesced: cov.coveredLine,
        nodeIds: [],
        coords: null,
        groupKeys: [], groupCls: [], groupWays: [], groupRaw: [],
        precomputed: true,
        stats: {
          rule: '预计算低缩放显示图层（display_lod）：几何是离线按 (band, 瓦片) 跑真实合并烘好的，'
            + '查询只做"取行 → 去重 → 裁到视口"',
          minZoom: coalesceOpts.minZoom, tolPx: coalesceOpts.tolPx,
          minClassWays: coalesceOpts.minClassWays, budgetFrac: coalesceOpts.budget,
          coordDigits: dlodPlan.coordDigits,
          // ⚠ 这三项是"这一次合并运行"的现场统计，预计算层复现不了（如实报 null，不报 0）
          candidateWays: null, skippedClosed: null, skippedMember: null, skippedNoClass: null,
          budget: null, remainingWays: null, classesAlways: [], classesPicked: [],
          ways: cov.coveredLine.size, lines: rd.lines.length,
          paths: lineStats.segs, points: lineStats.points, rawPoints: lineStats.rawPoints,
          classes: lineStats.classes.lines.map((c) => ({ class: c.class, family: c.family, ways: c.ways, coalesced: 1, always: coalesceAlways(c.class) ? 1 : 0 })),
          byFamily: lineStats.byFamily.lines,
          precomputed: true,
        },
      };
      areasPlan = {
        active: true,
        entries: rd.areas,
        covered: cov.coveredArea,
        nodeIds: [],
        groupKeys: [], groupCls: [], groupWays: [], groupRaw: [],
        precomputed: true,
        stats: {
          rule: '预计算低缩放显示图层（display_lod）：面几何同样是离线烘好的（闭合 way 的环 + 面关系接龙环）',
          tolPx: coalesceOpts.tolPx, coordDigits: dlodPlan.coordDigits,
          // `ways` = 真的画进 displayAreas 的环数（与实时路径的 `areasPlan.stats.ways` 同口径：
          // 退化到画不出来的那些只是 `covered`，不进这个数）
          ways: lineStats.areaWays, rings: lineStats.areaRings,
          rawPoints: lineStats.areaRawPoints, points: lineStats.areaPoints,
          openRings: null, tiny: null, tinyRings: null, relationMembersNoGeometry: null,
          relations: rd.areas.filter((a) => a.rel !== undefined).length,
          // 环总数已经算在 rings 里（关系环与非关系环不分开记：预计算层里它们都是同一张表的行）
          relationWays: null, relationRings: 0,
          classes: lineStats.classes.areas.map((c) => ({ class: c.class, family: c.family, ways: c.ways, rings: c.rings, points: c.points })),
          byFamily: lineStats.byFamily.areas,
          precomputed: true,
        },
      };
      this._dlodLastRead = lineStats;
      execPrecomputed(dlodPlan, coalescePlan, areasPlan);
    } else {
    /**
     * 【低缩放视图载荷】非"面关系"的成员 way 也一起参与合并 —— 它们本来就是按**线**画的
     * （boundary 是虚线、route 成员是路径），合并掉的成员几何在 displayLines 里一条都没少。
     * 所以这里在定合并计划**之前**把成员 way 的行取出来（几何仍然只取一次，见下面的 coalesceGeom）。
     * 面关系的成员走另一条路（服务端接龙成环 → displayAreas），不在这里。
     */
    /**
     * ⚠ 账本口径说明：`memberWaysReturned` 是**按出现次数**计的（同一个 way 属于多个关系就会重复计一次），
     * 而 picked / toFetch / fetched 是**按 way 去重**的（Set）。所以这两组数只在"没有重复成员"时逐项相等；
     * 有重复时差额 = 重复出现次数，不是"丢了几条"。
     */
    const memberGeom = memberRows.length ? this.wayNodesBatch(memberRows.map((r) => r.row.id)) : new Map();
    const coalesceInput = memberRows.length ? picked.concat(memberRows) : picked;
    let coalesceGeom = geom;
    if (memberRows.length) {
      coalesceGeom = new Map(geom);
      for (const [k, v] of memberGeom) coalesceGeom.set(k, v);
    }
    coalescePlan = this._coalesce(coalesceInput, coalesceGeom, {
      zoom,
      limit: caps.viewportLimit,
      /**
       * 合并的排除集：
       *   · 老口径（非视图载荷）：关系成员一律不合并 —— 关系要靠成员几何拼环/拼线；
       *   · 低缩放视图载荷：只有**面关系**的成员要保留几何，而它们走 displayAreas（不在这里），
       *     所以线状成员照常参与合并。
       */
      exclude: viewOnly ? EMPTY_SET : memberWayRefs,
      /**
       * `detail=0/1`（「完整 / 全部道路」档）时把合并整个关掉：`minZoom: 0` 会让 `_coalesce`
       * 直接返回空计划（一条都不合并）—— 那两个档位要的是"真 way id + 全量几何"，能编辑。
       */
      opts: coalescing ? coalesceOpts : Object.assign({}, coalesceOpts, { minZoom: 0 }),
      lat: (minLat + maxLat) / 2,
      // 视图载荷下面几何与线几何的节点集合大量重叠 → 共用一份坐标缓存，不多取一遍
      coords: viewOnly ? {} : null,
    });
    /**
     * 【低缩放视图载荷】面几何合并：候选里的**闭合** way + 面关系的成员 → displayAreas。
     * 盖到的 way **不再进 payload.ways**（几何已经在 displayAreas 里，且这一档客户端只看不改）。
     */
    if (viewOnly) {
      const relGeom = areaRels.length
        ? this.wayNodesBatch([...new Set(areaRels.flatMap((r) => r.members))])
        : new Map();
      const areaWays = [];
      for (const { row, tags } of coalesceInput) {
        const list = coalesceGeom.get(row.id);
        if (!list || list.length < 3) continue;
        const closed = !!row.closed || list[0] === list[list.length - 1];
        if (!closed) continue;
        if (coalescePlan.coalesced.has(row.id)) continue;   // 理论上不会同时命中，防御一下
        areaWays.push({ id: row.id, tags, ids: list });
      }
      areasPlan = this._coalesceAreas({
        ways: areaWays, relations: areaRels, relGeom,
        opts: coalesceOpts, zoom, lat: (minLat + maxLat) / 2,
        coords: coalescePlan.coords,     // 与折线共用同一份节点坐标缓存
      });
    }
    execPrecomputed(null, coalescePlan, areasPlan);
    }
    /**
     * `execPrecomputed` 只是一个"把两条路的共同尾部收在一处"的小闭包：
     * 无论几何是当场合并的还是从预计算层读的，**下面这段（逐条下发 + 账本）只有一份代码**。
     */
    function execPrecomputed(plan, coalescePlan, areasPlan) {
      for (const { row, tags } of picked) {
        const ids = geom.get(row.id);
        if (!ids || !ids.length) { noGeometry += 1; continue; }   // 节点全没了的路：没东西可渲染，不算"被丢掉"
        // 被合并进 displayLines 的 way：几何已经以折线形式下发，这里不再逐条下发（也就不占条数上限）
        if (coalescePlan.coalesced.has(row.id)) continue;
        // 【低缩放视图载荷】几何进了 displayAreas 的面：同样不再逐条下发、也不取它的节点坐标
        if (areasPlan && areasPlan.covered.has(row.id)) continue;
        ways[row.id] = [row.version, ids, tags, row.closed, 0];
        for (const id of ids) nodeIds.add(id);
        returnedWays += 1;
      }
      void plan;
    }

    /**
     * 关系成员路：在上限之外**额外**补齐（它们分布在全城，不该占 ways 的候选名额）。
     * 几何一律**整条下发**：客户端每条 way 只存一份几何、相邻缓存矩形互相覆盖，
     * 半截几何会让道路在瓦片边界出现真空缺（所以不做成员几何裁剪）。
     * 【低缩放视图载荷】成员已经在上面和普通 way 一起走过同一条路（折线合并 / displayAreas），
     * 所以这一节只在"没进视图载荷"时跑。
     */
    let extraWays = 0;
    let memberWayNodes = 0;
    if (!viewOnly && memberWayIds.size) {
      // 永不下载的类别（树 / 自行车道）在这里同样挡掉：成员几何一条不给（见上面的 keepMemberRows）
      const rows = keepMemberRows(this._wayRowsByIds([...memberWayIds]));
      const geoms = rows.length ? this.wayNodesBatch(rows.map((r) => r.row.id)) : new Map();
      for (const { row: w, tags } of rows) {
        const nodeList = geoms.get(w.id);
        if (!nodeList || !nodeList.length) continue;
        ways[w.id] = [w.version, nodeList, tags, w.closed, 0];
        for (const id of nodeList) nodeIds.add(id);
        memberWayNodes += nodeList.length;
        extraWays += 1;
      }
    } else if (viewOnly) {
      // 视图载荷下"成员去哪了"的账（三分法，合计 = 非面关系的成员数）：
      //   逐条下发（含几何） / 几何进了 displayLines / 几何进了 displayAreas（闭合成员）
      for (const { row: w } of memberRows) {
        if (ways[w.id]) { extraWays += 1; memberWayNodes += ways[w.id][1].length; }
        else if (coalescePlan.coalesced.has(w.id)) ledger.memberWaysCoalesced += 1;
        else if (areasPlan && areasPlan.covered.has(w.id)) ledger.memberWaysAsAreas += 1;
        else ledger.memberWaysUnaccounted += 1;   // 防御：理论上恒为 0（有它才能在账上自证）
      }
    }
    ledger.memberWayNodes = memberWayNodes;
    for (const id of memberNodeIds) nodeIds.add(id);

    // ---------- 4. 一次性取出所有需要的节点坐标 ----------
    // 注意：displayLines 的坐标**不进 payload.nodes**（那是合并省下来的体积，见 _coalesce）
    const nodes = {};
    /**
     * 物化几何的坐标缓存（`ways.geom`）：这一屏里**属于已挑 way 顶点**的那些节点，
     * 坐标直接来自 way 行，不再去 `nodes` 表里随机读（z15 一屏实测少读 22,166 行）。
     * 剩下要回库的只有 POI、关系成员、以及**带标签的几何顶点**（要判定 nodeTags）。
     */
    const geomNodeCache = this._wayGeom.on && this._wayGeomReady
      ? this._wayGeomNodeCache(picked.map((p) => p.row.id)) : null;
    this._fetchNodes([...nodeIds], nodes, nodeTags, zoom, lod.neverSendOn, geomNodeCache);
    const extraFromGeometry = Object.keys(nodeTags).length - returnedNodes;   // 道路顶点在高缩放下的标签

    /* ------------------------------ 上限 / 截断的账本 ------------------------------ */
    const kindStats = (scan, returned, extra = {}) => {
      const skipped = extra.skippedNoGeometry || 0;
      const coalesced = extra.coalesced || 0;
      const areaCoalesced = extra.areaCoalesced || 0;
      // 看过的部分里确定丢掉的：**合并掉的不算丢**（几何以 displayLines / displayAreas 的形式下发了）
      const known = Math.max(0, scan.visible - returned - skipped - coalesced - areaCoalesced);
      const exact = scan.scannedAll;
      return Object.assign({
        candidates: scan.candidates,
        candidateLimit: scan.scanCap,
        candidatesCapped: !scan.scannedAll,       // 还有候选行没看（unscanned 说明有多少）
        unscanned: scan.unscanned,                // 精确值（COUNT 数出来的）；-1 = 没给 countSql，不知道
        scannedAll: scan.scannedAll,
        stopReason: scan.stopReason,              // 'exhausted'（扫干净了）/ 'pick'（返回上限满了）/ 'cap'（候选上限满了）
        visible: scan.visible,                    // 看过的候选里通过分级筛选、"本该下发"的条数
        visibleExact: exact,                      // 候选被砍断时 visible 只是下界
        returned,                                 // 真的进了 payload 的条数
        // dropped 是"该下发却没下发"的条数：**只有候选扫干净时才算得出来**。
        // 候选被砍断时它必须是 null —— 报 0 会骗人（明明还有 unscanned 行根本没看）。
        dropped: exact ? known : null,
        droppedKnown: known,                      // 看过的部分里确定丢掉的条数（任何情况都精确）
        exact,
        complete: exact && known === 0,
        limitHit: scan.scannedAll ? null : (scan.stopReason === 'cap' ? 'candidates' : 'pick'),
      }, extra);
    };
    const kinds = {
      ways: kindStats(wayScan, returnedWays, {
        pickLimit: coalescing ? wayScanCap : caps.viewportLimit, scanCap: wayScanCap, skippedNoGeometry: noGeometry,
        // ---- 低缩放几何合并的账（见文件开头「低缩放几何合并」）----
        // coalesced = 被合并成 displayLines 的 way 条数：它们**不是 dropped**（几何一条没少，
        // 只是不再逐条下发、也不占条数上限），所以 known 里扣掉了它们。
        coalesced: coalescePlan.coalesced.size,
        displayLines: coalescePlan.lines.length,
        displayLinePaths: coalescePlan.stats.paths,
        displayLinePoints: coalescePlan.stats.points,
        coalesceActive: coalescePlan.active,
        // ---- 低缩放视图载荷的账（见文件开头「低缩放视图载荷」）----
        // areaCoalesced = 被挑出来的候选里、几何进了 displayAreas 的**闭合** way 条数：
        // 同样**不是 dropped**（几何在 displayAreas 里一条没少），所以 known 里也扣掉了它们。
        // 预计算路径下 `picked` 只有"逐条下发"的那几条，所以这个数直接取去向表里的面覆盖集合
        areaCoalesced: !areasPlan ? 0
          : (dlodCov ? dlodCov.coveredArea.size : picked.filter((p) => areasPlan.covered.has(p.row.id)).length),
        areaCoalesceActive: !!(areasPlan && areasPlan.active),
        displayAreas: areasPlan ? areasPlan.entries.length : 0,
        displayAreaRings: areasPlan ? areasPlan.stats.rings + areasPlan.stats.relationRings : 0,
        displayAreaPoints: areasPlan ? areasPlan.stats.points : 0,
        displayAreaWays: areasPlan ? areasPlan.stats.ways : 0,
        displayAreaRelations: areasPlan ? areasPlan.stats.relations : 0,
        // ---- 服务端 LOD 的账 ----
        // lodFiltered = "客户端不画 / 1 公里尺度看不清，所以没下发"的条数。
        // 它**不是** dropped：dropped 是"该下发却没下发"（候选扫干净才是精确值），
        // 而 lodFiltered 是**规则明确不下发**的部分，所以两者不能混。
        lodFiltered: lodWithheldTotal,
        lodFilteredBy: Object.assign({}, lodWithheld),     // { neverSend, roadClass, railMinor, landuse, building }
        lodFilteredBuildings: lodWithheld.building || 0,
        lodFilteredRoads: lodWithheld.roadClass || 0,
        lodFilteredRailMinor: lodWithheld.railMinor || 0,
        lodFilteredLanduse: lodWithheld.landuse || 0,
        lodFilteredNeverSend: lodWithheld.neverSend || 0,  // 树 / 自行车道（按类细分见 truncation.lod.neverSend）
        lodTrunkRoadsWithheld,                            // 主干道被扣下（恒 0）
        lodDetailAnomalies: lodRailWaterWithheld,         // 干线铁路/水系被扣下（恒 0）
        lodDetail: lod.detail,
        // 永不下载的类别：way / 节点 / 关系成员分开数（**不是** dropped，见文件开头那一段）
        neverSend: Object.assign({}, neverSendLedger.ways),
        neverSendTotal: neverSendLedger.total,
      }),
      nodes: kindStats(nodeScan, returnedNodes, {
        pickLimit: nodeScanCap, scanCap: nodeScanCap, extraFromGeometry,
      }),
      relations: kindStats(relScan, returnedRelations, {
        pickLimit: caps.relationLimit, scanCap: caps.relationLimit, extraWays,
        // ---- 关系成员裁剪的账（#P0）----
        // 这些数把"请求框之外的东西一条都没下发"说清楚，且**不是**上限截断：
        // 被裁的成员全部落在请求框之外，请求框内一条不少，所以不影响 complete。
        memberTotal: ledger.memberTotal,             // 库里这些关系的成员条数合计
        memberReturned: ledger.memberReturned,       // 真正进了 payload 的成员条数
        memberCropped: ledger.memberCropped,         // = memberTotal − memberReturned（全部在裁剪框之外）
        memberWaysTotal: ledger.memberWaysTotal, memberWaysReturned: ledger.memberWaysReturned, memberWaysCropped: ledger.memberWaysCropped,
        memberNodesTotal: ledger.memberNodesTotal, memberNodesReturned: ledger.memberNodesReturned, memberNodesCropped: ledger.memberNodesCropped,
        memberRelsTotal: ledger.memberRelsTotal, memberRelsReturned: ledger.memberRelsReturned, memberRelsCropped: ledger.memberRelsCropped,
        croppedRelations: ledger.croppedRelations,   // 有成员被裁的关系个数
        cropComplete: ledger.croppedRelations === 0, // 一个关系都没裁（小视口/小关系时就是这个）
        memberWayNodes: ledger.memberWayNodes,       // 成员补齐 way 实际下发的节点数（几何一律整条给）
        // ---- 低缩放视图载荷下"成员去哪了"的账（五选一，合计 = memberWaysReturned）----
        // picked       成员同时也是候选 way（z10 的行政边界就是一例）→ 几何走 way 扫描（折线合并/面合并）
        // asAreas      面关系成员（接龙成环）/ 闭合成员：几何在 displayAreas 的环里
        // coalesced    线状成员：几何在 displayLines 里
        // withheld     LOD 扣下面关系（客户端这一档不画）的成员：几何一条不发
        // （第五类 = 逐条下发的成员，见 memberWayNodes）
        memberWaysPicked: ledger.memberWaysPicked,
        memberWaysToFetch: ledger.memberWaysToFetch,
        memberWaysFetched: ledger.memberWaysFetched,
        memberWaysMissing: ledger.memberWaysMissing,
        memberWaysAsAreas: ledger.memberWaysAsAreas,
        memberWaysCoalesced: ledger.memberWaysCoalesced,
        memberWaysWithheld: ledger.memberWaysWithheld,
        memberWaysUnaccounted: ledger.memberWaysUnaccounted,   // 防御：成员既没下发也没进合并（恒 0）
        relationsAsAreas: ledger.relationsAsAreas,
        relationsWithheld: ledger.relationsWithheld,
      }),
    };
    const complete = kinds.ways.complete && kinds.nodes.complete && kinds.relations.complete;
    // 视口内**候选总数**（candidates + unscanned，两边都是精确值）：
    // /api/map 接着要跑的 visibleStats 里那个"带标签节点数"就是它，别再查一遍库
    // （真实数据集 z13 上这一条 COUNT 要 200~800 ms，见 visibleStats 的说明）。
    const totals = {
      ways: wayScan.scannedAll ? wayScan.candidates : (wayScan.unscanned >= 0 ? wayScan.candidates + wayScan.unscanned : null),
      nodes: nodeScan.scannedAll ? nodeScan.candidates : (nodeScan.unscanned >= 0 ? nodeScan.candidates + nodeScan.unscanned : null),
      relations: relScan.scannedAll ? relScan.candidates : (relScan.unscanned >= 0 ? relScan.candidates + relScan.unscanned : null),
    };
    const truncation = {
      zoom,
      complete,                                                        // 证据：三元全 complete
      exact: kinds.ways.exact && kinds.nodes.exact && kinds.relations.exact,
      /**
       * 服务端 LOD 的账：一共扣下多少条、按类各多少（`building` = 建筑面，`roadClass` = 小路）。
       * **不是截断**：扣下的东西在当前缩放下玩家根本看不清/客户端不画，
       * 所以 kinds.ways.dropped 仍是 0、complete 仍是 true。
       */
      lodFiltered: lodWithheldTotal,
      lodFilteredBy: Object.assign({}, lodWithheld),
      /**
       * **低缩放几何合并的账**（见文件开头「低缩放几何合并」那一段）：
       * z < minZoom 时，高条数类的"开折线"way 被接龙 + 简化成 `payload.displayLines`
       * （只有几何、没有 way id：客户端画它，不选它、不改它）。被合并的 way 一条没少，
       * 所以 `kinds.ways.dropped` 仍是 0、complete 仍是 true。
       *
       *   active        这次请求有没有合并
       *   ways          被合并的 way 条数（这些**不占** viewportLimit 名额）
       *   lines         折线条目数（= 分组数：样式类 + 名字 + bridge/tunnel/layer/surface）
       *   paths         折线几何段数（一个分组里几何可能分叉/断开成好几段，每段一条折线）
       *   points        下发的坐标点数（简化+量化之后）
       *   rawPoints     简化前的原始几何点数（省了多少一眼看得出）
       *   classes       逐样式类的条数（哪些类被合并、哪些没有）
       *   skipped*      没参与合并的原因（闭合面 / 关系成员 / 没有样式类）
       */
      coalesce: {
        active: coalescePlan.active,
        on: coalescing,
        minZoom: coalesceOpts.minZoom,
        tolPx: coalesceOpts.tolPx,
        coordDigits: coalesceOpts.coordDigits,
        minClassWays: coalesceOpts.minClassWays,
        budgetFrac: coalesceOpts.budget,
        rule: coalescePlan.stats.rule,
        ways: coalescePlan.stats.ways,
        candidateWays: coalescePlan.stats.candidateWays,
        lines: coalescePlan.stats.lines,
        paths: coalescePlan.stats.paths,
        points: coalescePlan.stats.points,
        rawPoints: coalescePlan.stats.rawPoints,
        byFamily: coalescePlan.stats.byFamily || [],
        classes: coalescePlan.stats.classes,
        budget: coalescePlan.stats.budget,
        remainingWays: coalescePlan.stats.remainingWays,
        skippedClosed: coalescePlan.stats.skippedClosed,
        skippedMember: coalescePlan.stats.skippedMember,
        skippedNoClass: coalescePlan.stats.skippedNoClass,
        lineNodeIds: (coalescePlan.nodeIds || []).length,   // 折线用到、但没有进 payload.nodes 的节点数
        note: 'displayLines 是**视图用**合并折线：低缩放（z < minZoom）只有几何、没有 way id，'
          + '客户端画它但不选它、不改它；z ≥ minZoom 时这一档整个关掉，真 way id 全部照旧下发，'
          + '编辑与拾取一点不受影响（"低缩放只看不改"是明确口径）。',
      },
      /**
       * **低缩放视图载荷的账**（见文件开头「低缩放视图载荷」那一段）：
       * 合并生效的那一档里，**面几何**也不再逐条下发原始 way + 节点坐标，而是压成
       * `payload.displayAreas`（量化 + 按像素简化的环，只有几何、没有 way id）。
       * 被压进去的 way **不是 dropped**：几何一条没少（只是换了编码），所以
       * `kinds.ways.dropped` 仍是 0、`complete` 仍是 true。
       *
       *   active            这次请求有没有走视图载荷
       *   reason            'low-zoom-display-only'（低缩放只看不改）/ 'forced'（view=1）
       *   minZoom           生效的合并阈值（displayAreas 只在 z < 它时生效）= VIEW_ONLY_MAX_ZOOM + 1
       *   maxZoom           "只看不改"的**最高**缩放 = minZoom − 1（默认 14）：z ≤ 它就没法点选/编辑。
       *                     **客户端读这两个回显值，不许自己写死**（见 public/js/mapdata.js 的 VIEW_ONLY_BOUNDARY）
       *   detailFloor       低于这个 LOD 档位（= detail 0/1 的"完整 / 全部道路"档）一律不下发视图载荷
       *   areas             displayAreas 的账（条目/环/点数/按类细分）
       *   waysCovered       几何进了 displayAreas 的 way 条数（含关系成员）
       *   memberWaysWithheld 因为 LOD（客户端这一档不画这个关系）而一条几何都不发的成员 way 条数
       */
      viewOnly: {
        active: !!viewOnly,
        on: coalescing,
        reason: viewOnly ? (viewArg === true ? 'forced' : 'low-zoom-display-only') : null,
        minZoom: coalesceOpts.minZoom,
        // "只看不改"的最高缩放（= minZoom − 1，默认 14）：客户端只认这个回显，不写死数字
        maxZoom: Math.max(0, coalesceOpts.minZoom - 1),
        detail: lod.detail,
        detailFloor: VIEW_ONLY_MIN_DETAIL,
        tolPx: coalesceOpts.tolPx,
        coordDigits: coalesceOpts.coordDigits,
        areas: areasPlan ? {
          active: areasPlan.active,
          entries: areasPlan.entries.length,
          ways: areasPlan.stats.ways,
          rings: areasPlan.stats.rings,
          relationRings: areasPlan.stats.relationRings,
          points: areasPlan.stats.points,
          rawPoints: areasPlan.stats.rawPoints,
          openRings: areasPlan.stats.openRings,
          tiny: areasPlan.stats.tiny,
          tinyRings: areasPlan.stats.tinyRings,
          relationMembersNoGeometry: areasPlan.stats.relationMembersNoGeometry,
          relations: areasPlan.stats.relations,
          relationWays: areasPlan.stats.relationWays,
          byFamily: areasPlan.stats.byFamily || [],
          classes: areasPlan.stats.classes,
          rule: areasPlan.stats.rule,
        } : null,
        waysCovered: areasPlan ? areasPlan.covered.size : 0,
        relationsAsAreas: ledger.relationsAsAreas,
        relationsWithheld: ledger.relationsWithheld,
        /**
         * 关系成员 way 去哪了（**按 way 去重**计数；`kinds.relations.memberWaysReturned` 是按**出现次数**计的，
         * 同一个 way 属于多个关系会重复计，所以两组数不逐项相等 —— 差额是重复出现次数，不是丢数据）：
         *   picked      成员同时也是候选 way（几何走 way 扫描：折线合并 / 面合并）
         *   asAreas     面关系成员或闭合成员：几何在 displayAreas 的环里
         *   coalesced   线状成员：几何在 displayLines 里
         *   withHeld    LOD 判定"这一档客户端不画这个关系"：成员几何一条不发
         *   missing     成员表引用了库里没有的 way（数据集是裁剪过的：这类引用本来就没有几何）
         */
        memberWaysPicked: ledger.memberWaysPicked,
        memberWaysAsAreas: ledger.memberWaysAsAreas,
        memberWaysCoalesced: ledger.memberWaysCoalesced,
        memberWaysWithheld: ledger.memberWaysWithheld,
        /** 关系成员里属于"永不下载"类别（树 / 自行车道）的条数：几何一条没发（**不是** dropped） */
        memberWaysNeverSent: ledger.memberWaysNeverSent,
        memberWaysMissing: ledger.memberWaysMissing,
        memberWaysUnaccounted: ledger.memberWaysUnaccounted,
        nodePayload: {
          nodes: Object.keys(nodes).length,                  // 真的进了 payload.nodes 的节点数
          wayRefs: Object.keys(ways).length,                 // 逐条下发的 way 条数（它们的几何需要节点）
          areaNodeIds: areasPlan ? areasPlan.nodeIds.length : 0,   // 只在 displayAreas 的环里出现的节点（不占 payload.nodes）
          lineNodeIds: (coalescePlan.nodeIds || []).length,
        },
        note: '低缩放（z ≤ ' + Math.max(0, coalesceOpts.minZoom - 1) + '，即 VIEW_ONLY_MAX_ZOOM）是"只看不改"的档：'
          + '客户端这一档没有任何 way id，拾取与编辑本来就在 z ≥ ' + coalesceOpts.minZoom + ' 才可用。'
          + '所以面几何也只下发"画得出来的紧凑几何"'
          + '（displayAreas：量化到 ' + coalesceOpts.coordDigits + ' 位小数、按 ≤ ' + coalesceOpts.tolPx
          + ' 屏幕像素简化），原始 way 几何与节点坐标不下发。'
          + 'detail=0/1（「完整 / 全部道路」档）时**整个视图载荷与折线合并都关掉**：'
          + '真 way id + 全量几何照旧下发（超上限时如实报 truncated）。',
      },
      lod: {
        detail: lod.detail,                       // 生效档位（0~4）
        detailName: lod.detailName,
        /**
         * 低缩放候选扫描用的是哪条计划（见 _wayScanPlan）：
         *   'lod-index' —— 物化列 + 部分索引 idx_ways_lod_zoom（`lod_zoom <= zoom` 的范围扫描）
         *   'rtree'     —— 原来的 R*Tree bbox 路径（高缩放、或物化列不可用时）
         * 与账本的关系：**只是把 accept() 里那次 lodVisible 判断提前到索引上做**，
         * visible / lodFiltered / dropped / complete 的语义与数字都不变。
         */
        wayScan: dlodPlan
          ? { plan: 'display-lod', band: zoom, tiles: dlodPlan.tiles.length,
            rows: dlodCov ? dlodCov.candidates : 0,
            rule: '**不扫 way**：这一档的候选与每个候选的去向直接读预计算层（display_lod_cov），'
              + 'candidates / visible / coalesced / lodFiltered / dropped / complete 由它如实重建' }
          : wayPlan
            ? { plan: wayPlan.plan, index: wayPlan.index, maxZoom: wayPlan.maxZoom, lodZoom: wayPlan.lodZoom,
              rule: '只扫 `lod_zoom <= ' + wayPlan.lodZoom + '` 的 way（= 这一档等级够的道路 + 铁路/水系/水域/行政边界例外）' }
            : { plan: 'rtree', maxZoom: this._wayLodMaxZoom, ready: !!this._wayLodReady,
              rule: 'R*Tree bbox 路径：先扫视口内所有 way，再由 accept() 按显示分级/LOD 逐行判断' },
        source: lod.source,                       // 'query'（请求带的）/ 'config'（limits.lodDetail）/ 'default'
        /**
         * POI（带标签节点）候选扫描用的是哪条计划（见 _nodePoiPlan）：
         *   'poi-index' —— 部分索引 idx_nodes_poi_low（z ≤ 15：这一档可见的只有地名 + 山峰/泉/洞口）
         *   'rtree'     —— 原来的 R*Tree + idx_nodes_tagged（z ≥ 16 或索引不可用）
         * 与 way 侧同理：只是把 accept() 里的 lodVisible 判断提前到索引上做，
         * nodes 的 visible / returned / dropped / complete 一个数都不变；
         * 变的是 `candidates`（看过多少行）以及 `totals.nodes` / `stats.pois`
         * （= 这一档的 POI 候选数，不再是"视口里所有带标签节点"）。
         */
        poiScan: nodePlan
          ? { plan: nodePlan.plan, index: nodePlan.index, maxZoom: nodePlan.maxZoom,
            rule: '只扫带 "place": / "natural":"peak"|"spring"|"cave_entrance" 的节点（这一档可见的 POI 集合）' }
          : { plan: 'rtree', maxZoom: this._nodePoiMaxZoom, ready: !!this._nodePoiReady,
            rule: 'R*Tree + idx_nodes_tagged：先把视口内带标签的节点都读出来，再由 accept() 按可见性逐行判断' },        rule: (lod.rule ? '建筑面：z≤' + (lod.buildingZoom.normal - 1) + ' 一律不下发；'
          + 'z=' + lod.buildingZoom.important + ' 起只下发重要建筑（有名字 / ≥5 层 / amenity|shop|tourism）；'
          + 'z≥' + lod.buildingZoom.normal + ' 起全部下发（骨架类标签不受档位偏置影响）'
          : '档位不筛（客户端「完整 / 全部道路」档一块都不丢）')
          + (lod.minFillArea > 0 ? '；另加面积门槛 ' + lod.minFillArea + ' m²（小于它的建筑面不下发）' : ''),
        buildingZoom: lod.buildingZoom,           // {important, normal}：客户端默认档的真实显示门槛
        minFillArea: lod.minFillArea,             // 建筑面的面积门槛（m²，0 = 不按面积筛）
        clientAreaM2: stepValueZero(LOD_MIN_AREA_TABLE, zoom),   // 客户端标准档对装饰性面的面积门槛（服务端**不**据此扣 landuse/leisure：它们必须完整）
        /**
         * 路网分级（与客户端 Render.roadClassTable() 同一张表，本实现是"各降一档"版）：
         *   roadSend        本次生效的下发表（[fromZoom, serverSend]，客户端可逐行对比自己的表）
         *   sendRank        这个缩放下"下发到第几级"（rank ≤ sendRank 才发）
         *   roadSendRule    规则原文
         *   roadsWithheldByClass  被筛掉的次要道路条数，按等级细分（客户端据此自证"被筛的只是次要道路"）
         */
        roadSend: lod.roadSend,                   // [{fromZoom, serverSend, sendName}]
        roadSendRank: lod.sendRank,
        roadSendRule: lod.rule
          ? '等级 rank：0 主干(motorway/trunk/primary) · 1 secondary · 2 tertiary · 3 支路(residential…) · 4 细路(service/track/footway…) · 5 未知；'
            + '本档下发到 rank ' + lod.sendRank + '（'
            + (lod.roadSend.filter((r) => zoom >= r.fromZoom).slice(-1)[0] || {}).sendName + '）；'
            + 'rank 0 与铁路/水系/水域/行政边界永不筛'
          : '档位不筛（客户端「完整 / 全部道路」档：全部等级都下发）',
        roadsWithheldByClass: Object.assign({}, roadsByRank),   // { secondary, tertiary, minor, detail, unknown }
        roadRankNames: ROAD_RANK_NAMES,
        /** 基础地板（config limits.roadClassFloor 可覆盖；detail = 细路地板，默认 16）+ 生效值 */
        baseFloor: {
          trunk: roadFloorAt(0, lod.floor), secondary: roadFloorAt(1, lod.floor), tertiary: roadFloorAt(2, lod.floor),
          minor: roadFloorAt(3, lod.floor), detail: roadFloorAt(4, lod.floor),
        },
        baseFloorSource: lod.floorSource,
        baseFloorNote: '细路（service/track/footway…）地板默认 16（z16 是城市常用档位，玩家不能在 z16 看不到人行道）；'
          + '想改：config limits.roadClassFloor = { "detail": 17 } 或旧名 limits.roadClassZoom = { "detail": 17 }',
        /** 两条"政策级"筛选的账（各自独立，便于核对） */
        railMinorWithheld: lodMinorRailWithheld,      // 非干线铁路（usage≠main 的 railway=rail）按次要等级扣下
        landuseWithheld: lodLanduseWithheld,          // 装饰性面按客户端面积门槛扣下
        landuseAreaM2: stepValueZero(LANDUSE_AREA_TABLE, zoom),   // 这一档生效的面积门槛（0 = 不筛）
        railMinorRule: 'railway=rail 且 usage≠main（场站/支线/专用线）按 rank 3 处理；usage=main 的干线永不被筛',
        landuseRule: 'landuse/leisure 面按客户端默认档 STANDARD_MIN_AREA 筛（z13=20000 · z14=6000 · z15=1500 · z16=400 m²，≥17 不筛）',
        /**
         * **永不下发的类别**（树 / 自行车道，见文件开头「永不下发的类别」那一段）：
         * 任何缩放、任何详细度档位都不下发（连 detail=0/1「完整 / 全部道路」档也一样）。
         *   ways / nodes / memberWays  各自按类（trees / cycleways）记条数
         *   total                      三类合计（= lodFilteredBy.neverSend）
         * **不是 dropped**：这是"规则明确永不下发"，不是"该发没发"（dropped / complete 不受影响）。
         */
        neverSend: {
          classes: NEVER_SEND_CLASSES,
          ways: Object.assign({}, neverSendLedger.ways),
          nodes: Object.assign({}, neverSendLedger.nodes),
          memberWays: Object.assign({}, neverSendLedger.memberWays),
          total: neverSendLedger.total,
          on: lod.neverSendOn,               // 这条规则这次生效了没有（false = 对照实测/A-B 用）
          source: lod.neverSendSource,       // 'default' / 'config'（limits.neverSend=false）/ 'query'（neverSend=0）
          atEveryZoom: true,
          ignoresDetailLevel: true,          // detail=0/1（「完整 / 全部道路」档）也照扣
          rule: NEVER_SEND_RULE,
          clientNote: '客户端本地完整度（Render.completeness）的分母是"已收到并缓存的 way"'
            + '（render.js 的 World.queryWays → isRoad = !!tags.highway），所以不下发这些只会让分母变小，'
            + 'roadsMissing / roadsWithheld（恒 0）的口径不需要改；'
            + '受影响的只是客户端"自行车道"预设（editor.js / presets.js）与 cycleway / tree_row 两条样式规则：'
            + '新建的自行车道会存进库，但任何缩放都不再回图。',
        },
        neverSendTotal: neverSendLedger.total,
        neverSendWays: (neverSendLedger.ways.trees || 0) + (neverSendLedger.ways.cycleways || 0),
        neverSendRule: NEVER_SEND_RULE,
        withheld: Object.assign({}, lodWithheld), // 实际扣下的条数（按类：neverSend / roadClass / building）
        withheldTotal: lodWithheldTotal,
        classes: Object.keys(lodWithheld),
        /**
         * 语义（P0 明确）：`roadsWithheld` 只数**主干道（rank 0）**被 LOD 扣下的条数 —— 必须恒为 0；
         * 被等级 LOD 扣下的次要道路不算丢数据，单独记在 minorRoadsWithheld + roadsWithheldByClass
         * + lodFilteredBy.roadClass 里。`roadsMissing` 的承诺：主干道/铁路/水系/水域/行政边界一条不缺。
         */
        roadsWithheld: lodTrunkRoadsWithheld,
        roadsMissing: 0,
        minorRoadsWithheld: lodMinorRoadsWithheld,
        railWaterBoundaryWithheld: lodRailWaterWithheld,
        note: '被 roadsWithheldByClass / lodFilteredBy.roadClass 扣下的是"这一档看不清的次要道路"'
          + '（客户端表里的 serverSend 同一批，客户端在过密街区还会再收紧一档 blockKeep），不是丢数据；'
          + '主干道（rank 0）/铁路/水系/水域/行政边界永远不筛（roadsWithheld 恒 0）。',
        hint: '要让服务端连次要道路/建筑一起下发（客户端「完整」档）：请求带 detail=0；'
          + '只想要大建筑：带 minFillArea=<平方米>；'
          + '想自己调分界点：config limits.roadSend = { "12": 0, "13": 1, "14": 2 }（按缩放下发到第几级）',
      },
      /**
       * **预计算低缩放显示图层**（见 server/displaylod.js 的文件头那一段）：
       * 这次请求的 displayLines / displayAreas 是**从库里读的**还是**当场算的**，
       * 以及读了多少行、裁掉了多少（一分钱花在哪，一眼看得出）。
       *
       * ⚠ **只在真的走了这条路时才出现这个字段** —— 于是
       *   · z ≥ 15（编辑档，永远走实时路径）的载荷与改动前**逐字节相同**；
       *   · `limits.displayLod.on = false`（回滚）时，所有档位的载荷也**逐字节相同**。
       * 这两条由 `tests/display-lod-test.js` 用 sha256 逐档断言（临时库上真跑）。
       */
      ...(dlodPlan ? {
        displayLod: {
          active: true,
          on: !!this._dlod.on,
          band: zoom,
          tiles: dlodPlan.tiles.length,
          rows: (this._dlodLastRead || {}).rows || 0,
          unique: (this._dlodLastRead || {}).unique || 0,
          lines: (this._dlodLastRead || {}).lines || 0,
          areas: (this._dlodLastRead || {}).areas || 0,
          clipped: (this._dlodLastRead || {}).clipped || 0,
          coveredWays: dlodCov ? dlodCov.coveredLine.size + dlodCov.coveredArea.size : 0,
          sentWays: dlodCov ? dlodCov.sentWay.size : 0,
          dirtyTiles: this._dlodDirty.size,
          note: '这一档的折线/面几何是**离线烘**好的（按 (band, 瓦片) 跑真实合并），查询只做'
            + '「取行 → 按 id 去重 → 裁到视口」；way 候选与每个候选的去向也一并读自预计算层，'
            + '所以这次请求**没有为合并部分取任何 way 几何**。'
            + '库没烘这一层 / 这个 band 没建完 / 参数签名对不上 / 压到的瓦片里有脏的 —— 任何一条都会'
            + '**整体**退回实时路径（绝不把新旧几何混在一屏里）。',
        },
      } : {}),
      caps: {
        viewportLimit: caps.viewportLimit,        wayCandidates: caps.wayCandidates, nodeCandidates: caps.nodeCandidates, relationLimit: caps.relationLimit,
        relationCropPad: caps.relationCropPad, relationCropMinMembers: caps.relationCropMinMembers,
        relationCropBoundaryMembers: caps.relationCropBoundaryMembers,
      },
      /**
       * 关系成员裁剪的账（#P0：全城级关系的成员不再整条下发）：
       * 只裁**成员列表**（哪些成员算"在视野里"），成员 way 的**几何一律整条下发**。
       * 裁剪框严格大于请求 bbox ⇒ 请求框内一条不少（crop.complete 恒为 true）。
       * （试过"把成员几何也裁到框内"，但那会破坏客户端"一条 way 一份几何 + 相邻缓存矩形
       *   互相覆盖"的前提、在瓦片边界造成道路真空缺，所以不做。）
       */
      crop: {
        reason: 'viewport-member-crop',
        pad: caps.relationCropPad,                 // 裁剪框 = 请求 bbox 每边外扩（请求尺寸 × pad）
        minMembers: caps.relationCropMinMembers,   // 成员数 ≤ 这个值的关系一律不裁
        boundaryMembers: caps.relationCropBoundaryMembers,  // 纯行政边界的成员是否也裁（默认否）
        box: cropBox,                              // 实际使用的裁剪框
        relations: ledger.croppedRelations,        // 成员列表被裁的关系个数
        memberTotal: ledger.memberTotal,
        memberReturned: ledger.memberReturned,
        memberCropped: ledger.memberCropped,
        memberWaysTotal: ledger.memberWaysTotal, memberWaysReturned: ledger.memberWaysReturned, memberWaysCropped: ledger.memberWaysCropped,
        memberNodesTotal: ledger.memberNodesTotal, memberNodesReturned: ledger.memberNodesReturned, memberNodesCropped: ledger.memberNodesCropped,
        memberWayNodes: ledger.memberWayNodes,     // 成员补齐 way 下发的节点数（几何整条给）
        complete: true,                            // 被裁的成员全在裁剪框外 ⇒ 请求框内的成员一条不少
        rule: '成员数≤minMembers / type=multipolygon 或面状 boundary / 关系整体在裁剪框内 → 不裁；'
          + '其余只留几何与裁剪框相交的成员（成员 way 的几何始终整条下发）',
      },
      kinds,
      summary: {
        returned: { ways: kinds.ways.returned, nodes: kinds.nodes.returned, relations: kinds.relations.returned },
        // dropped = null 表示"候选没扫完，丢了多少数不出来"（不是一个骗人的 0）
        dropped: { ways: kinds.ways.dropped, nodes: kinds.nodes.dropped, relations: kinds.relations.dropped },
        // LOD 扣下的（客户端本来就不画）：与 dropped 分开报，别把"没浪费"记成"丢数据"
        lodFiltered: { ways: kinds.ways.lodFiltered, nodes: 0, relations: 0 },
        // 永不下载的类别（树 / 自行车道）：任何档位都不发，**不是** dropped（见 truncation.lod.neverSend）
        neverSend: {
          ways: (neverSendLedger.ways.trees || 0) + (neverSendLedger.ways.cycleways || 0),
          nodes: (neverSendLedger.nodes.trees || 0) + (neverSendLedger.nodes.cycleways || 0),
          memberWays: ledger.memberWaysNeverSent,
          total: neverSendLedger.total,
        },
        // 低缩放合并掉的（几何以 displayLines 下发）：同样不是 dropped
        coalesced: { ways: kinds.ways.coalesced, displayLines: kinds.ways.displayLines, paths: kinds.ways.displayLinePaths },
        unscanned: { ways: kinds.ways.unscanned, nodes: kinds.nodes.unscanned, relations: kinds.relations.unscanned },
        limitHit: {
          ways: kinds.ways.limitHit, nodes: kinds.nodes.limitHit, relations: kinds.relations.limitHit,
        },
      },
      // 客户端可以拿这两个恒等式验证服务端没算错：payload 的条数 = 本类返回 + 额外补齐
      payload: {
        ways: Object.keys(ways).length,
        nodes: Object.keys(nodes).length,
        nodeTags: Object.keys(nodeTags).length,
        relations: Object.keys(relations).length,
        displayLines: coalescePlan.lines.length,
        displayLinePaths: coalescePlan.stats.paths,
        displayAreas: areasPlan ? areasPlan.entries.length : 0,
        displayAreaRings: areasPlan ? areasPlan.stats.rings + areasPlan.stats.relationRings : 0,
      },
      hint: complete ? null
        : '视口内有要素被上限截断：把这一块继续拆小再请求（拆开后每一块都会给出 complete=true 的完整证据）',
    };

    /**
     * 紧凑编码（见文件开头「紧凑载荷」那一段）：把"十进制坐标文本"换成"量化整数 + delta"。
     * **语义完全不变**，只是每个坐标少几个字节；客户端在 World.mergePayload 入口一次展开回老形状
     * （`payload.enc` 就是那份"解码说明书"，没有它客户端就当老格式处理）。
     * 关闭：config.json limits.compact = false（那时按老形状原样下发）。
     *
     * 注意这里**只动几何的表示**：
     *   · 条数 / 账本 / complete / dropped / coalesce 全都在上面算完了，一个数都不受影响；
     *   · truncation.payload.nodes 也在上面取过 Object.keys(nodes)（打包前），所以账还是对的。
     */
    return packQueryResult({
      nodes, nodeTags, ways, relations, truncation, totals, zoom, complete,
      viewOnly: !!viewOnly,
      lines: coalescePlan.lines,
      areas: areasPlan ? areasPlan.entries : [],
      pack, coalesceOpts, capsFlat,
    });
  }

  /**
   * **低缩放几何合并**（见文件开头「低缩放几何合并」那一段的完整说明）。
   *
   * 输入：这次视口扫描挑出来的 way（已过显示分级 + LOD）、它们的节点 id 序列（geom）、
   *       这次要跳过的 id（关系成员：关系要靠成员几何拼环/拼线，不能只留"画着好看"的折线）。
   * 输出：
   *   { active, lines, coalesced, stats, nodeIds }
   *     lines      → payload.displayLines（每条 = 一个"样式类+名字+layer/bridge/tunnel"分组）
   *     coalesced  → 被合并的 way id 集合（这些**不再进 ways 字典**，于是不占条数上限）
   *     stats      → 账本（条数/组数/段数/点数/按类细分），进 truncation.coalesce
   *
   * 为什么只合并"开折线"：闭合面（建筑/水面/绿地/环岛）是**填充**几何，折线表达不了它们的语义
   * （填充色、内环、挤出），合并只会把地图画错。它们本来就被 LOD 的建筑/面积门槛管着，
   * 也不是"撑满上限"的主力。
   *
   * 为什么"永远合并的类"里包含主干道/铁路/水系/边界：这四类是**任何档位都不许扣**的
   * （见 lodWithholdClass），于是它们必然全量下发 —— 实测一屏就是 1 万条上下，
   * 正是上限 binding 的直接原因。合并它们既不改画法（同组同规则），也不影响完整性账目。
   */
  _coalesce(picked, geom, { zoom, limit, exclude, opts, lat, coords: coordsIn }) {
    const out = {
      active: false,
      lines: [],
      coalesced: new Set(),
      nodeIds: [],
      /**
       * 逐条目的元数据（**与 `lines` 同一个循环、同一个下标填的**）：
       *   groupKeys  分组键（= `coalesceGroupKeyOf(cls, tags)`）—— 预计算层用它定**稳定内容 id**
       *   groupCls   这一组的样式类（`classes` 账本的原始键）
       *   groupWays  被并进这一条的 way 条数
       *   groupRaw   简化前的原始点数（= 这一条省了多少，账本 `rawPoints` 的逐条版本）
       * 预计算低缩放显示图层（server/displaylod.js）靠它把"库里的行"与"线上那条折线"对上，
       * 而不是自己按标签反推类（反推在兜底类 `tags:…` 上推不出来）。线上载荷不含这几个字段。
       */
      groupKeys: [], groupCls: [], groupWays: [], groupRaw: [],
      stats: {
        rule: 'z < minZoom 时，把"开折线的 way"按（样式类 + 名字 + bridge/tunnel/layer/surface）分组接龙，'
          + 'Douglas–Peucker ≤ tolPx 屏幕像素简化后作为 displayLines 下发；'
          + '闭合面、关系成员、以及没到条数阈值的类仍逐条下发（真 way id）',
        minZoom: opts.minZoom, tolPx: opts.tolPx, minClassWays: opts.minClassWays,
        budgetFrac: opts.budget, coordDigits: opts.coordDigits,
        candidateWays: 0, ways: 0, lines: 0, paths: 0, rawPoints: 0, points: 0,
        skippedClosed: 0, skippedMember: 0, skippedNoClass: 0,
        classes: [], classesAlways: [], classesPicked: [], budget: 0, remainingWays: 0,
      },
    };
    if (!(opts.minZoom > 0) || zoom >= opts.minZoom || !picked.length) return out;
    out.active = true;

    // ---------- 1. 分类：只收"开折线 + 有几何 + 不是关系成员 + 有样式类"的 way ----------
    const entries = [];
    const byClass = new Map();
    for (const { row, tags } of picked) {
      const ids = geom.get(row.id);
      if (!ids || ids.length < 2) continue;
      if (exclude && exclude.has(row.id)) { out.stats.skippedMember += 1; continue; }
      const closed = !!row.closed || (ids.length > 2 && ids[0] === ids[ids.length - 1]);
      if (closed) { out.stats.skippedClosed += 1; continue; }
      const cls = coalesceClassOf(tags);
      if (!cls) { out.stats.skippedNoClass += 1; continue; }
      const e = { id: row.id, tags, cls, ids };
      entries.push(e);
      let arr = byClass.get(cls);
      if (!arr) { arr = []; byClass.set(cls, arr); }
      arr.push(e);
    }
    out.stats.candidateWays = entries.length;
    if (!entries.length) return out;

    // ---------- 2. 选类：永远类 + 条数 ≥ 阈值；要是不够就按条数从大到小继续收，直到落进预算 ----------
    /**
     * **类选择：规则只有一份**（`chooseCoalesceClasses`），`_coalesce` 与预计算层的"全局选类"
     * 都调它 —— 于是"烘焙时选哪些类"与"实时算时选哪些类"不可能漂。详见那个函数的说明。
     */
    const pick = chooseCoalesceClasses(byClass, picked.length, opts, limit);
    const chosen = pick.chosen;
    out.stats.budget = pick.budget;
    out.stats.remainingWays = pick.remainingWays;
    out.stats.classes = pick.classes;
    out.stats.classesForced = !!opts.forceClasses;
    /**
     * 逐条目的元数据里要带上"这一档最终选了哪些类"：预计算层把它烘进 meta，
     * 之后**单块瓦片的重算**就能用同一份类集合（否则"重算一块"会按这块瓦片自己的条数重新选类，
     * 把 way 挤出折线集 —— 那正是"瓦片越小、选中的类越少"这个坑）。
     */
    out.chosenClasses = pick.chosenList;
    /** 「只数类，不算几何」探针（预计算层全局选类用）：算完账就返回，不接龙、不取节点坐标 */
    if (opts.surveyClasses) return out;

    // ---------- 3. 分组 → 接龙 → 简化 ----------
    const groups = new Map();
    for (const e of entries) {
      if (!chosen.has(e.cls)) continue;
      const key = coalesceGroupKeyOf(e.cls, e.tags);
      let list = groups.get(key);
      if (!list) { list = []; groups.set(key, list); }
      list.push(e);
    }
    if (!groups.size) return out;
    const nodeIdSet = new Set();
    for (const list of groups.values()) for (const e of list) for (const nid of e.ids) nodeIdSet.add(nid);
    out.nodeIds = [...nodeIdSet];
    // 折线的坐标**不进 payload.nodes**（那是合并省下来的体积；它们只用在这条折线自己的 coords 里）
    // coordsIn：调用方（低缩放视图载荷）可以把"面几何也要用的那份坐标缓存"传进来共用，
    // 免得同一批节点被取两遍（areas 与 lines 的节点集合大量重叠）。
    const coords = coordsIn || {};
    /**
     * **物化几何的坐标缓存**（`ways.geom`）：这一组合并要取的节点坐标全都来自这些 way，
     * 所以直接按 way id 一次读出来（z10 一屏原来是 19.5 万行 `nodes` 随机读）。
     * 返回值与逐行读 `nodes` **完全相同**（物化时就是按 `_fetchNodes` 的口径量化到 1e-7 的）。
     */
    const geomCache = this._wayGeom.on && this._wayGeomReady
      ? this._wayGeomNodeCache(entries.map((e) => e.id)) : null;
    if (coordsIn) {
      const missing = out.nodeIds.filter((id) => coords[id] === undefined);
      if (missing.length) this._fetchNodes(missing, coords, null, zoom, true, geomCache);
    } else {
      this._fetchNodes(out.nodeIds, coords, null, zoom, true, geomCache);
    }

    const kx = 111320 * Math.cos((Number(lat) || 0) * D2R);
    const ky = 110574;
    const tolM = opts.tolPx * metersPerPixel(zoom, lat);
    const q = (v, d) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };
    const byFamily = new Map();
    for (const [gkeyOf, list] of groups) {
      // 组内每条 way 的样式类/名字/btl 都相同（分组键保证），所以只用第一条的标签建折线
      const head = list[0];
      const trails = chainWaysToTrails(list);
      const paths = [];
      let groupRaw = 0;      // 这一条折线简化前的原始点数（逐条版 rawPoints，见 out.groupKeys 的说明）
      for (const trail of trails) {
        const meters = [];
        const lls = [];
        for (const nid of trail) {
          const c = coords[nid];
          if (!c) continue;
          if (lls.length && lls[lls.length - 1][0] === c[0] && lls[lls.length - 1][1] === c[1]) continue;
          lls.push(c);
          meters.push([c[1] * kx, c[0] * ky]);
        }
        if (lls.length < 2) continue;
        const simp = simplifyTrailMeters(meters, tolM);
        const line = new Array(simp.length);
        for (let i = 0; i < simp.length; i++) line[i] = [q(simp[i][1] / ky, opts.coordDigits), q(simp[i][0] / kx, opts.coordDigits)];
        if (line.length < 2) continue;
        out.stats.rawPoints += lls.length;
        out.stats.points += line.length;
        groupRaw += lls.length;
        paths.push(line);
      }
      if (!paths.length) continue;
      const entry = {
        class: coalesceFamilyOf(head.cls),
        tags: displayTagsOf(head.tags),
        coords: paths[0],
      };
      const name = (head.tags && head.tags.name) || '';
      if (name) entry.name = name;
      // 同组里"分叉/断开"的其余路径：一条 displayLine 的几何可以是好几段（接不到一起的那些）
      if (paths.length > 1) entry.paths = paths.slice(1);
      out.lines.push(entry);
      // 逐条目元数据（与 lines 同一个下标；见 out.groupKeys 的说明）
      out.groupKeys.push(gkeyOf);
      out.groupCls.push(head.cls);
      out.groupWays.push(list.length);
      out.groupRaw.push(groupRaw);
      out.stats.paths += paths.length;
      for (const e of list) out.coalesced.add(e.id);
      const fam = byFamily.get(entry.class) || { class: entry.class, lines: 0, paths: 0, ways: 0, points: 0 };
      fam.lines += 1;
      fam.paths += paths.length;
      fam.ways += list.length;
      fam.points += paths.reduce((s, p) => s + p.length, 0);
      byFamily.set(entry.class, fam);
    }
    out.stats.ways = out.coalesced.size;
    out.stats.lines = out.lines.length;
    out.stats.byFamily = [...byFamily.values()].sort((a, b) => b.ways - a.ways);
    out.coords = coords;      // 供同一请求里的面几何合并复用（见 queryBbox）
    return out;
  }

  /**
   * **低缩放面几何合并**（见文件开头「低缩放视图载荷」那一段的完整说明）。
   *
   * 输入：
   *   ways       这次扫描挑出来的**闭合** way：[{ id, tags, ids }]（ids 来自 geom）
   *   relations  这一档客户端会当面填色画的关系：[{ id, tags, members: [wayId, …] }]
   *   relGeom    面关系成员的节点序列：Map(wayId → [nodeId, …])
   *   opts       { tolPx, coordDigits }（与折线同一套参数）
   * 输出：
   *   { active, entries, covered, stats, nodeIds }
   *     entries → payload.displayAreas（每条 = 一个"面样式类 + 名字"分组的若干环，或一条面关系）
   *     covered → 几何已经进了 displayAreas 的 way id（**不再进 payload.ways**，也不再取它们的节点坐标）
   *     stats   → 账本（条数/环数/点数/按类细分），进 truncation.viewOnly.areas
   *
   * 关键点：
   *   1. **坐标只在 displayAreas 里出现一次**：环的节点坐标**不进 payload.nodes**（这正是省下来的体积，
   *      与 displayLines 同一口径），客户端拿到的是"量化 + 按像素简化"过的内联坐标；
   *   2. 面关系的成员 way **在服务端接龙成环**（`chainWaysToTrails` 与折线共用同一套贪心），
   *      所以客户端不需要成员几何也能把水面/绿地的填充画出来；
   *   3. 接不成环的开放路径照旧下发（客户端对"没闭合的环"只画描边、不填充）——
   *      宁可少填一块，也不把一条断开的岸线填成一个三角形。
   */
  _coalesceAreas({ ways, relations, relGeom, opts, zoom, lat, coords: coordsIn }) {
    const out = {
      active: false,
      entries: [],
      covered: new Set(),
      nodeIds: [],
      /**
       * 逐条目的元数据（**与 `entries` 同一个下标**；口径与 `_coalesce` 的 groupKeys 一样）：
       *   groupKeys  稳定内容 id 的键（闭合 way 组 = `areaGroupKeyOf`，面关系 = `rel:<id>`）
       *   groupCls   账本类（闭合 way = `areaClassOf`；面关系 = `rel:` + `areaClassOf`）
       *   groupWays  并进这一条的 way 条数（环数 / 关系成员数）
       *   groupRaw   简化前的原始点数
       */
      groupKeys: [], groupCls: [], groupWays: [], groupRaw: [],
      stats: {
        rule: '低缩放（z < coalesce.minZoom 且 detail ≥ ' + VIEW_ONLY_MIN_DETAIL + '）：画得出来的面几何'
          + '（闭合 way 的环 + 面关系的接龙环）量化到 coordDigits 位、按 Douglas–Peucker ≤ tolPx 屏幕像素'
          + '简化后作为 displayAreas 下发（只有几何、没有 way id）；'
          + '对应的原始 way 几何与节点坐标不再下发（低缩放是"只看不改"的视图语义）',
        tolPx: opts.tolPx, coordDigits: opts.coordDigits,
        ways: 0, rings: 0, rawPoints: 0, points: 0, openRings: 0, tiny: 0, tinyRings: 0,
        relations: 0, relationWays: 0, relationRings: 0, relationMembersNoGeometry: 0,
        classes: [], byFamily: [],
      },
    };
    const list = ways || [];
    const rels = relations || [];
    if (!list.length && !rels.length) return out;
    out.active = true;

    // ---------- 1. 一次性取齐需要的节点坐标（这些**不进 payload.nodes**，只用在环自己的坐标里） ----------
    const ids = [];
    const seenNode = new Set();
    const pushIds = (arr) => {
      if (!arr) return;
      for (const nid of arr) {
        if (seenNode.has(nid)) continue;
        seenNode.add(nid); ids.push(nid);
      }
    };
    for (const w of list) pushIds(w.ids);
    for (const r of rels) for (const wid of r.members) pushIds(relGeom.get(wid));
    // 坐标缓存可以由调用方（同一个请求的折线合并）共用：同一批节点不取两遍
    const coords = coordsIn || {};
    const geomCache = this._wayGeom.on && this._wayGeomReady ? this._wayGeomNodeCache(list.map((w) => w.id)) : null;
    if (coordsIn) {
      const missing = ids.filter((id) => coords[id] === undefined);
      if (missing.length) this._fetchNodes(missing, coords, null, zoom, true, geomCache);
    } else {
      this._fetchNodes(ids, coords, null, zoom, true, geomCache);
    }
    out.nodeIds = ids;

    const kx = 111320 * Math.cos((Number(lat) || 0) * D2R);
    const ky = 110574;
    const tolM = opts.tolPx * metersPerPixel(zoom, lat);
    const f = Math.pow(10, opts.coordDigits);
    const q = (v) => Math.round(v * f) / f;
    /**
     * 节点 id 序列 → 简化 + 量化的环。
     * 返回 { ring, missing, raw, degenerate }：
     *   ring       [[lat,lon], …]（first == last 表示闭合环）；null = 这个环这一档画不出来
     *   missing    取不到的节点个数（节点被删了之类 → 调用方应当保守处理，别把几何偷偷丢了）
     *   degenerate 简化之后不足 3 点 = **比这一档的一个像素还小**（z10 一像素 117 m）：
     *              这种面客户端画出来也是空的（退化多边形），所以不下发，记进 areas.tiny
     */
    const buildRing = (nodeIds) => {
      const res = { ring: null, missing: 0, raw: 0, degenerate: false };
      if (!nodeIds || nodeIds.length < 3) { res.degenerate = true; return res; }
      const lls = [];
      for (const nid of nodeIds) {
        const c = coords[nid];
        if (!c) { res.missing += 1; continue; }
        const last = lls[lls.length - 1];
        if (last && last[0] === c[0] && last[1] === c[1]) continue;
        lls.push(c);
      }
      res.raw = lls.length;
      if (lls.length < 3) { res.degenerate = true; return res; }
      const meters = new Array(lls.length);
      for (let i = 0; i < lls.length; i++) meters[i] = [lls[i][1] * kx, lls[i][0] * ky];
      const simp = simplifyTrailMeters(meters, tolM);
      // 去重之后不足 3 个**不同**的点：退化多边形（客户端画出来是空的）→ 记 tiny，不下发
      let distinct = 0;
      for (let i = 0; i < simp.length; i++) {
        if (i === simp.length - 1 && simp.length > 1 && simp[0][0] === simp[i][0] && simp[0][1] === simp[i][1]) break;
        distinct += 1;
      }
      if (distinct < 3) { res.degenerate = true; return res; }
      const ring = new Array(simp.length);
      for (let i = 0; i < simp.length; i++) ring[i] = [q(simp[i][1] / ky), q(simp[i][0] / kx)];
      res.ring = ring;
      out.stats.rawPoints += lls.length;
      out.stats.points += ring.length;
      return res;
    };
    const isClosedRing = (ring) => ring.length > 3
      && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];

    // ---------- 2. 闭合 way：按（面样式类 + 名字 + btl）分组，每组一条 displayArea ----------
    const groups = new Map();
    const classStat = new Map();
    for (const w of list) {
      const cls = areaClassOf(w.tags);
      if (!cls) continue;
      const r = buildRing(w.ids);
      // 节点缺失（数据不齐）：保守处理 —— 不进 displayAreas，仍然逐条下发（老行为）
      if (!r.ring && r.missing > 0) continue;
      const key = areaGroupKeyOf(cls, w.tags);
      out.covered.add(w.id);          // 几何要么在 displayAreas 里，要么"小到这一档画不出来"
      if (!r.ring) {
        out.stats.tiny += 1;
        const cs0 = classStat.get(cls) || { class: cls, family: areaFamilyOf(cls), ways: 0, rings: 0, points: 0, tiny: 0 };
        cs0.ways += 1; cs0.tiny += 1;
        classStat.set(cls, cs0);
        continue;
      }
      let g = groups.get(key);
      if (!g) { g = { cls, tags: w.tags, rings: [], raw: 0 }; groups.set(key, g); }
      g.rings.push(r.ring);
      g.raw += r.raw || 0;
      const cs = classStat.get(cls) || { class: cls, family: areaFamilyOf(cls), ways: 0, rings: 0, points: 0, tiny: 0 };
      cs.ways += 1; cs.rings += 1; cs.points += r.ring.length;
      classStat.set(cls, cs);
      if (!isClosedRing(r.ring)) out.stats.openRings += 1;
    }
    const byFamily = new Map();
    for (const [gkeyOf, g] of groups) {
      const entry = { class: areaFamilyOf(g.cls), tags: areaDisplayTagsOf(g.tags), coords: g.rings[0] };
      const name = (g.tags && g.tags.name) || '';
      if (name) entry.name = name;
      if (g.rings.length > 1) entry.paths = g.rings.slice(1);
      out.entries.push(entry);
      // 逐条目元数据（与 entries 同一个下标；见 out.groupKeys 的说明）
      out.groupKeys.push(gkeyOf);
      out.groupCls.push(g.cls);
      out.groupWays.push(g.rings.length);
      out.groupRaw.push(g.raw);
      out.stats.ways += g.rings.length;
      out.stats.rings += g.rings.length;
      const fam = byFamily.get(entry.class) || { class: entry.class, areas: 0, rings: 0, ways: 0, points: 0 };
      fam.areas += 1; fam.rings += g.rings.length; fam.ways += g.rings.length;
      fam.points += g.rings.reduce((s, r) => s + r.length, 0);
      byFamily.set(entry.class, fam);
    }

    // ---------- 3. 面关系：成员接龙成环 → 每条关系一条 displayArea（tags 用关系自己的标签） ----------
    for (const r of rels) {
      const memberEntries = [];
      let noGeometry = 0;
      const seenWay = new Set();
      for (const wid of r.members) {
        if (seenWay.has(wid)) continue;
        seenWay.add(wid);
        const nodeIds = relGeom.get(wid);
        if (!nodeIds || nodeIds.length < 2) { noGeometry += 1; continue; }
        memberEntries.push({ id: wid, ids: nodeIds });
      }
      out.stats.relationMembersNoGeometry += noGeometry;
      if (!memberEntries.length) continue;
      const trails = chainWaysToTrails(memberEntries);
      const rings = [];
      let open = 0;
      let relRaw = 0;
      for (const trail of trails) {
        const ringRes = buildRing(trail);
        if (!ringRes.ring) { if (!ringRes.missing) out.stats.tinyRings += 1; continue; }
        rings.push(ringRes.ring);
        relRaw += ringRes.raw || 0;
        if (!isClosedRing(ringRes.ring)) open += 1;
      }
      /**
       * 一个环都接不出来（几何取不到 / 这一档小到退化）→ **不覆盖成员**：它们照旧逐条下发。
       * 宁可多传几个字节，也绝不把"取不到几何的成员"悄悄吞掉（那会变成真的少画一块）。
       */
      if (!rings.length) continue;
      for (const m of memberEntries) out.covered.add(m.id);
      const cls = areaClassOf(r.tags);
      const entry = {
        class: areaFamilyOf(cls), tags: areaDisplayTagsOf(r.tags), coords: rings[0], rel: r.id,
      };
      if (rings.length > 1) entry.paths = rings.slice(1);
      out.entries.push(entry);
      out.groupKeys.push('rel:' + r.id);
      out.groupCls.push('rel:' + cls);
      out.groupWays.push(memberEntries.length);
      out.groupRaw.push(relRaw);
      out.stats.relations += 1;
      out.stats.relationWays += memberEntries.length;
      out.stats.relationRings += rings.length;
      out.stats.openRings += open;
      const cs = classStat.get('rel:' + cls) || { class: 'rel:' + cls, family: areaFamilyOf(cls), ways: 0, rings: 0, points: 0 };
      cs.ways += memberEntries.length; cs.rings += rings.length;
      cs.points += rings.reduce((s, x) => s + x.length, 0);
      classStat.set(cs.class, cs);
      const fam = byFamily.get(entry.class) || { class: entry.class, areas: 0, rings: 0, ways: 0, points: 0 };
      fam.areas += 1; fam.rings += rings.length; fam.ways += memberEntries.length;
      fam.points += rings.reduce((s, x) => s + x.length, 0);
      byFamily.set(entry.class, fam);
    }
    out.stats.classes = [...classStat.values()].sort((a, b) => b.ways - a.ways);
    out.stats.byFamily = [...byFamily.values()].sort((a, b) => b.ways - a.ways);
    return out;
  }

  /** 按 id 批量取 way 行（关系成员补齐用）：返回 [{ row, tags }] */
  _wayRowsByIds(ids) {
    const out = [];
    if (!ids.length) return out;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const ph = chunk.map(() => '?').join(',');
      const stmt = this._cachedStmt(`SELECT id, version, tags, closed FROM ways WHERE deleted = 0 AND id IN (${ph})`);
      for (const row of stmt.all(...chunk)) out.push({ row, tags: parseTags(row.tags) });
    }
    return out;
  }

  /**
   * 扫一遍候选行并记账（ways / nodes / relations 共用）。
   *
   * 为什么是"一次性 LIMIT 候选上限+1"而不是分页：这里用的 SQLite 对
   * `... JOIN ... WHERE <rtree 条件> AND id > ? ORDER BY id LIMIT ?` 会退化成
   * "每页都全量扫一遍 R*Tree 再临时排序"（实测 z13 十页 8.9 秒，一次性只要 40 毫秒）。
   * 所以候选只取一批（上限 +1 行，多取一行是用来判断"是不是正好被上限卡住"的），
   * 但**账要算清楚**：
   *   candidates  我们真正看过的候选行数（accept() 被调用了几次）
   *   stopReason  为什么停下来：挑满返回上限（pick）/ 候选上限到了（cap）/ 整个 bbox 看完了（exhausted）
   *   unscanned   没看的候选行数 = bbox 内候选总数 − candidates（COUNT 数出来的**精确**值）
   * 多取的那一行数据不浪费：它让"有没有被上限卡住"变成一个事实，而不是猜测。
   */
  _scanCandidates({ sql, countSql, args, accept, pickLimit, scanCap }) {
    const stmt = this._cachedStmt(sql);
    const values = [];
    let candidates = 0;
    let visible = 0;
    let rowCount = 0;
    let stopReason = 'exhausted';
    const limit = scanCap + 1;   // 多取一行：用来判断"是不是正好被候选上限卡住"
    // 懒取（iterate）而不是一次 all()：候选上限可以给得宽一些也不会白花时间 ——
    // 挑满返回上限就 break，后面的行根本不会被读出来（实测 z13：看 5 万行 92 ms，全取 18 万行 386 ms）。
    const cursor = typeof stmt.iterate === 'function' ? stmt.iterate(...args, limit) : stmt.all(...args, limit);
    for (const row of cursor) {
      rowCount += 1;
      if (values.length >= pickLimit) { stopReason = 'pick'; break; }
      candidates += 1;
      const value = accept(row);
      if (!value) continue;
      visible += 1;
      values.push(value);
    }
    if (stopReason === 'exhausted' && rowCount > scanCap) stopReason = 'cap';
    let unscanned = 0;
    if (stopReason !== 'exhausted') {
      if (countSql) {
        const total = this._cachedStmt(countSql).get(...args).c;
        unscanned = Math.max(0, total - candidates);
        // 剩下的候选行其实一行都没有（提前收手只是因为返回上限到了）：那还是"扫干净了"，数字照样精确
        if (!unscanned) stopReason = 'exhausted';
      } else {
        unscanned = -1;   // 没给 countSql：只能承认"还有行没看，但不知道多少"
      }
    }
    const scannedAll = stopReason === 'exhausted';
    return { values, candidates, visible, capped: !scannedAll, scannedAll, unscanned, stopReason, pickLimit, scanCap };
  }

  /** 语句缓存：这几个 SQL 每次视口请求都要跑，别每次都重新 prepare */
  _cachedStmt(sql) {
    let stmt = this._pageCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._pageCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * 取这批关系的成员（#P0）：返回 Map<relation_id, [[type, ref, role], ...]>，组内按 seq 升序。
   *
   * 这里是**逐关系**跑同一条 prepared 语句（`st.relationMembers`），不是"一条 SQL 批量取"：
   * 批量版（`relation_id IN (SELECT value FROM json_each(?)) ORDER BY relation_id, seq`）虽然
   * 查询计划也用上了主键（`SEARCH relation_members USING PRIMARY KEY (relation_id=?)`），
   * 但实测更慢 —— 要为每个块拼一次 JSON、多一层 bloom filter 子查询、再按 relation_id 排序：
   * z13 6307 个关系 263012 条成员：批量 252 ms vs 逐关系 172 ms；z16 98 vs 58 ms；z18 69 vs 52 ms
   * （tests/tmp-relcrop/probe-members-sql.js）。逐关系那条语句本来就长期 prepared 着，零额外开销。
   */
  _relationMembersFor(relIds) {
    const out = new Map();
    if (!relIds.length) return out;
    const stmt = this._st.relationMembers;
    for (const id of relIds) {
      out.set(id, stmt.all(id).map((m) => [m.member_type, m.member_ref, m.role || '']));
    }
    return out;
  }

  /**
   * 这批 way 里哪些的几何与 box 相交（返回 id 的 Set）。关系成员裁剪用它挑"要留下的成员"。
   *
   * 用 ways 表的 bbox 列（id 是 INTEGER PRIMARY KEY，json_each 批量传参走主键点查）：
   * 真实数据集实测 5 万条 id 43 ms；逐条 way_index 点查要 284 ms（way_index 是 R*Tree，
   * 没法按 id 批量探测）。ways.min_* 为 NULL（"不知道"）的 way 一律当作相交 ——
   * 宁可多给几条，也绝不把请求框内该给的成员漏掉。
   */
  _waysIntersecting(ids, box) {
    const out = new Set();
    if (!ids.length) return out;
    const stmt = this._cachedStmt(`SELECT w.id FROM ways w
      WHERE w.deleted = 0 AND w.id IN (SELECT value FROM json_each(?))
        AND (w.min_lat IS NULL OR (w.max_lon >= ? AND w.min_lon <= ? AND w.max_lat >= ? AND w.min_lat <= ?))`);
    for (let i = 0; i < ids.length; i += MEMBER_ID_CHUNK) {
      const rows = stmt.all(JSON.stringify(ids.slice(i, i + MEMBER_ID_CHUNK)), box.minLon, box.maxLon, box.minLat, box.maxLat);
      for (const r of rows) out.add(r.id);
    }
    return out;
  }

  /** 同上，节点成员版（一个节点就是一个点，直接比经纬度） */
  _nodesIntersecting(ids, box) {
    const out = new Set();
    if (!ids.length) return out;
    const stmt = this._cachedStmt(`SELECT n.id FROM nodes n
      WHERE n.deleted = 0 AND n.id IN (SELECT value FROM json_each(?))
        AND n.lon >= ? AND n.lon <= ? AND n.lat >= ? AND n.lat <= ?`);
    for (let i = 0; i < ids.length; i += MEMBER_ID_CHUNK) {
      const rows = stmt.all(JSON.stringify(ids.slice(i, i + MEMBER_ID_CHUNK)), box.minLon, box.maxLon, box.minLat, box.maxLat);
      for (const r of rows) out.add(r.id);
    }
    return out;
  }

  /**
   * 批量取多条道路的节点序列：way_id -> [nodeId, ...]。
   * 性能（#3）：用 json_each(?) 把整批 id 当成一个参数传进去，SQL 文本永远一样、
   * 语句只 prepare 一次（旧做法是每 300 条拼一次 IN(?,?,…) 再 prepare 一次，
   * 真实数据集 z18 实测 46 ms → 23 ms，z13 79 ms → 69 ms）。
   */
  wayNodesBatch(wayIds) {
    const out = new Map();
    if (!wayIds.length) return out;
    /**
     * **先读物化几何**（`ways.geom`）：一屏 2,491 条 way 实测原来要读 `way_nodes` **25,956 行**，
     * 现在这些行跟着 way 行一起读，跨表探针 0 次。读到的 id 序列与 `way_nodes` **逐项相同**
     * （它是从同一张表物化出来的），所以下游（折线合并、`payload.ways`、面环）一个字节都不会变。
     * 没物化的 way（老库还没回填完、或刚被建出来）按 miss 退回下面那条 SQL。
     */
    const memo = this._wayGeomBatch(wayIds);
    if (memo.size) {
      const miss = [];
      for (const id of wayIds) {
        const g = memo.get(id);
        if (g) out.set(id, g.ids); else miss.push(id);
      }
      if (!miss.length) return out;
      wayIds = miss;
    }
    const stmt = this._cachedStmt(
      'SELECT way_id, node_id FROM way_nodes WHERE way_id IN (SELECT value FROM json_each(?)) ORDER BY way_id, seq'
    );
    for (let i = 0; i < wayIds.length; i += NODE_FETCH_CHUNK) {
      const chunk = wayIds.slice(i, i + NODE_FETCH_CHUNK);
      for (const r of stmt.all(JSON.stringify(chunk))) {
        let arr = out.get(r.way_id);
        if (!arr) { arr = []; out.set(r.way_id, arr); }
        arr.push(r.node_id);
      }
    }
    return out;
  }

  /**
   * 取一批节点的坐标（顺带按分级规则挑出"可以当 POI 显示"的标签）。
   * 性能（#3）：
   *   · 语句**缓存复用**（同样长度的 IN 列表只 prepare 一次）。实测"每块现拼现 prepare"
   *     是真实的开销：z13 取 13.3 万个节点 140 ms → 77 ms，z16 99 ms → 51 ms
   *     （对比过的另一条路线是 json_each(?) 整批传 id，实测反而更慢：z13 89 ms / z16 63 ms）；
   *   · 标签解析是**懒**的：先做一次廉价的"这个缩放下根本不可能可见"判断（字符串子串），
   *     再 JSON.parse —— 低于 z16 时几何顶点上的标签（门牌号之类）一律不可见，
   *     逐个 JSON.parse 纯属白花时间。
   */
  _fetchNodes(ids, out, nodeTags, zoom, neverSendOn = true, nodeCache = null) {
    if (!ids.length) return;
    const z = zoom === undefined ? 19 : zoom;
    /**
     * **物化几何的坐标快路径**（见 `packWayGeom` 上面那一大段）：
     * 一屏 2,491 条 way 原来要读 `nodes` **22,166 行**（每行还带着大字段 `tags`），
     * 磁盘瓶颈的机器上就是几十 MB 随机读。现在这些坐标直接来自 `ways.geom`。
     *
     * **逐字节不变的三条纪律**（实测过 `IN (…)` 的返回顺序是 **id 升序**，不是列表顺序）：
     *   1. **分块完全照旧**（还是 `ids` 原顺序、每 500 个一块）——块的组成不变；
     *   2. 每一块内**按 id 升序插入**，与 SQLite 自己的返回顺序一致（合并缓存命中与库返回的行之后
     *      再升序插，所以"缓存的那些"不会挤到前面去）；
     *   3. 带标签的节点（`hasTags` 位）**一律照旧回库取**（它的 `tags` 要参与 `nodeTags` 的判定），
     *      不带标签的节点库里 `tags` 本来就是 NULL，原代码在那一步就短路了 —— 结论一样。
     * 于是 `nodes` / `nodeTags` 的键、顺序、值都与改动前相同（`tests/way-geom-test.js` 用 sha256 断言）。
     */
    const cache = (nodeCache && nodeCache.coords.size) ? nodeCache : null;
    for (let i = 0; i < ids.length; i += NODE_FETCH_CHUNK) {
      const chunk = ids.slice(i, i + NODE_FETCH_CHUNK);
      if (!cache) {
        const stmt = this._cachedStmt(nodeFetchSql(chunk.length));
        for (const n of stmt.all(...chunk)) this._putNode(out, nodeTags, n, z, neverSendOn);
        continue;
      }
      /** 命中缓存、而且那个节点**没有标签**的：坐标直接用，不用回库 */
      const hit = new Map();
      const miss = [];
      for (const id of chunk) {
        const c = cache.coords.get(id);
        if (c && !cache.hasTags.has(id)) hit.set(id, c); else miss.push(id);
      }
      const rows = new Map();
      if (miss.length) {
        const stmt = this._cachedStmt(nodeFetchSql(miss.length));
        for (const n of stmt.all(...miss)) rows.set(n.id, n);
      }
      const all = [...new Set([...hit.keys(), ...rows.keys()])].sort((a, b) => a - b);
      for (const id of all) {
        const n = rows.get(id);
        if (n) { this._putNode(out, nodeTags, n, z, neverSendOn); continue; }
        const c = hit.get(id);
        // 与 `out[n.id] = [Math.round(n.lat*1e7)/1e7, …]` 同一口径（物化时已经量化到 1e7）
        out[id] = c;
      }
    }
  }

  /** 单个节点行的落库口径（`_fetchNodes` 两条路共用，保证"从哪儿读"不影响结果） */
  _putNode(out, nodeTags, n, z, neverSendOn) {
    out[n.id] = [Math.round(n.lat * 1e7) / 1e7, Math.round(n.lon * 1e7) / 1e7];
    if (nodeTags && n.tags && pointTagsMaybeVisible(n.tags, z)) {
      const tags = parseTags(n.tags);
      if (tags && !(neverSendOn && neverSendClassOf(tags)) && lodVisible(tags, z, 'point')) nodeTags[n.id] = tags;
    }
  }

  /**
   * 把一批 way 的物化几何摊成**按节点 id** 的坐标缓存（`_fetchNodes` 的快路径用它）。
   * 一次性建好，之后整屏都命中；`hasTags` 里的是"要回库看标签"的节点（很少）。
   */
  _wayGeomNodeCache(wayIds) {
    const coords = new Map();
    const hasTags = new Set();
    if (!this._wayGeom.on || !this._wayGeomReady || !wayIds.length) return { coords, hasTags };
    for (const g of this._wayGeomBatch(wayIds).values()) {
      for (let i = 0; i < g.ids.length; i++) {
        const c = g.coords[i];
        if (c && !coords.has(g.ids[i])) coords.set(g.ids[i], c);
        if (g.hasTags[i]) hasTags.add(g.ids[i]);
      }
    }
    return { coords, hasTags };
  }

  /* ==================================================================================
   * ==================== 预计算低缩放显示图层（display_lod） ====================
   * ==================================================================================
   * 规则与实测依据全在 server/displaylod.js 的文件头那一段；这里只放**入口**：
   *   · `_dlodPlan()`    —— 这次请求能不能走预计算（开关 / band / 签名 / 脏瓦片 / 范围）
   *   · `_dlodRead()`    —— 按瓦片读表 + 去重 + 裁剪，产出 displayLines / displayAreas / 覆盖账
   *   · `_dlodBakeTile()`—— 烘一块瓦片（**跑库里真实的 queryBbox**，在 _coalesce 处截下结果）
   *   · 构建与失效        —— buildDisplayLod / buildDisplayLodSliced / dlodMarkDirty / dlodRebuildDirty
   */
  /** 这次请求生效的 display_lod 参数（构造时给，默认开；`on:false` 是那一行回滚开关） */
  _dlodOpts() { return this._dlod; }

  /** meta 里的那一行状态（带缓存；`_dlodForget` 清掉） */
  _dlodState() {
    if (this._dlodStateCache !== undefined) return this._dlodStateCache;
    let st = null;
    try {
      const row = this.db.prepare(`SELECT v FROM ${DLOD.DLOD_META} WHERE k = 'state'`).get();
      if (row && row.v) {
        const raw = JSON.parse(row.v);
        const bands = {};
        for (const k of Object.keys(raw.bands || {})) bands[Number(k)] = raw.bands[k];
        st = {
          sig: raw.sig, version: raw.version, tiles: raw.tiles,
          extent: raw.extent, lat: raw.lat,
          bands, builtAt: raw.builtAt,
          bytes: raw.bytes || 0, rows: raw.rows || 0,
        };
      }
    } catch { st = null; }   // 没有这张表 / 没有这一行 → 这一层不可用（老库的常态）
    this._dlodStateCache = st;
    return st;
  }

  _dlodForget() { this._dlodStateCache = undefined; }

  /** 库里有没有这一层、且"该建的 band 都建了"（有 meta 且 rows > 0） */
  dlodReady() { const st = this._dlodState(); return !!(st && st.rows > 0); }

  /** 这一层的信息（给 /api/health 与种子报告用；不读库也能答） */
  displayLodInfo() {
    const st = this._dlodState();
    if (!st) return { available: false, on: !!this._dlod.on, reason: '库里没有这一层' };
    const bands = {};
    for (const z of Object.keys(st.bands).sort((a, b) => a - b)) bands[z] = st.bands[z];
    return {
      available: true, on: !!this._dlod.on, tiles: st.tiles, lat: st.lat, extent: st.extent,
      rows: st.rows, bytes: st.bytes, bands, dirty: this._dlodDirty.size, builtAt: st.builtAt,
      sig: st.sig,
    };
  }

  _dlodEnsureSchema() {
    this.db.exec(DLOD.DLOD_SCHEMA);
    /**
     * 清掉一个**自己造的历史包袱**：第一版实现把"候选 way 的去向"只挂在**一张共享的** R\*Tree 上
     * （id = cov 的 rowid），实测 z14 因为一次命中 7 个 band 的行而要 324 ms；现在改成**每个 band 一张**
     * （见 displaylod.js 里那段说明）。老库如果被第一版建过，那张表就是纯占地方 —— 顺手删掉。
     */
    try { this.db.exec(`DROP TABLE IF EXISTS ${DLOD.DLOD_COV}_rtree`); } catch { /* ignore */ }
    this._dlodStateCache = undefined;
  }

  /** 数据范围（**所有活着的 way 的 bbox 并集**）：瓦片网格就是它的等分。 */
  _dlodDataExtent() {
    const r = this.db.prepare(`SELECT MIN(min_lon) AS a, MAX(max_lon) AS b, MIN(min_lat) AS c, MAX(max_lat) AS d
      FROM ways WHERE deleted = 0 AND min_lon IS NOT NULL`).get();
    if (!r || r.a === null) return null;
    return { minLon: r.a, maxLon: r.b, minLat: r.c, maxLat: r.d };
  }

  _dlodGrid(extent, tiles) { return DLOD.makeGrid(extent, tiles); }

  /**
   * **DP 容差用的参考纬度 = 该数据范围的【最大纬度】**（原型点名的口径）。
   *
   * 为什么是"最大纬度"而不是中心纬度：`metersPerPixel ∝ cos(lat)`，纬度越高 cos 越小、
   * 一像素对应的米数越小 ⇒ **容差最细**。取最大纬度就等于"保证这一层不比今天粗"：
   * 本数据集纬度 37.77°~40.36°，中心纬度 39.06° 的 cos 比最北端大 1.9% ——
   * 用中心纬度会让北半部分的容差比线上现在算的**粗** 1.9%（虽然只有 2% 像素，但没理由让它粗）。
   * 反过来，最南端的容差会比这里用的**细** 1.9%（多留几个点，只多花字节）。
   *
   * ⚠ 这也意味着**同一个 band 的容差是一个常数**：不会随请求中心纬度漂（线上是 `(minLat+maxLat)/2`，
   * 视口一动容差就动，DP 保留的点集就可能变 —— 那"预计算"就无从谈起）。
   */
  _dlodLatRef(extent) { return extent.maxLat; }

  /**
   * 烘一块瓦片：**跑库里真实的 `queryBbox`**（不是另写一套合并逻辑），在 `_coalesce` /
   * `_coalesceAreas` 返回处把结果截下来，然后**抛一个哨兵异常跳过打包那一段**
   * （预计算不需要载荷；省下的正是打包 + JSON 的 40~80 ms）。
   *
   * 为什么要用真 queryBbox：折线/面的几何语义必须与线上**逐字段同源**，
   * 而"哪些 way 参与合并、类怎么选、LOD 怎么扣"这些规则长在 queryBbox 里 ——
   * 抄一份出来迟早会漂。这里只两处干预：
   *   1. `lat`（DP 容差用的纬度）**强制成 band 固定值**（见 displaylod.js 文件头）；
   *   2. 把 ways 扫描的 `accept` 包一层，记下"每个候选 way 的去向"（→ display_lod_cov）。
   */
  _dlodBakeTile(z, tile, box, ctx) {
    const cap = {
      lines: null, areas: null, coalesced: null, covered: null,
      geom: new Map(), picked: [], rejects: [], scan: null,
    };
    const origScan = this._scanCandidates;
    const origCoalesce = this._coalesce;
    const origAreas = this._coalesceAreas;
    const origBatch = this.wayNodesBatch;
    const STOP = '__DLOD_STOP__';
    const isWayScan = (sql) => {
      const s = String(sql || '');
      return s.includes('FROM ways w') || s.includes('FROM way_index');
    };
    this._scanCandidates = function (o) {
      if (!isWayScan(o.sql)) return origScan.call(this, o);
      const inner = o.accept;
      const wrapped = Object.assign({}, o, {
        accept: (row) => {
          const v = inner(row);
          if (v) cap.picked.push(v); else cap.rejects.push(row);
          return v;
        },
      });
      const r = origScan.call(this, wrapped);
      cap.scan = r;
      return r;
    };
    this._coalesce = function (picked, geom, o) {
      const forced = ctx.forceClasses ? ctx.forceClasses.get(z) : null;
      const opts2 = forced ? Object.assign({}, o.opts, { forceClasses: forced }) : o.opts;
      const r = origCoalesce.call(this, picked, geom, Object.assign({}, o, { lat: ctx.lat, opts: opts2 }));
      cap.lines = r.lines; cap.coalesced = r.coalesced; cap.coalescePlan = r;
      return r;
    };
    this._coalesceAreas = function (a) {
      const r = origAreas.call(this, Object.assign({}, a, { lat: ctx.lat }));
      cap.areas = r.entries; cap.covered = r.covered; cap.areasPlan = r;
      throw new Error(STOP);
    };
    this.wayNodesBatch = function (ids) {
      const r = origBatch.call(this, ids);
      for (const [k, v] of r) cap.geom.set(k, v);
      return r;
    };
    /**
     * **烘焙（低缩放预计算）的输入也读物化几何**：合并过程中要取 10 万个节点坐标
     * （`_coalesce` 里的 `_fetchNodes`），在磁盘瓶颈的机器上那是烘焙最贵的一步。
     * 这里按**整块瓦片**一次性建好坐标缓存，之后合并/面接龙的每一次取坐标都命中它。
     * （读的仍然是同一份数据：`ways.geom` 是从 `way_nodes` + `nodes` 物化出来的。）
     */
    const origFetch = this._fetchNodes;
    let tileCache = null;
    this._fetchNodes = function (ids, out, nodeTags, zoom, neverSendOn, cache) {
      if (!cache && this._wayGeom.on && this._wayGeomReady) {
        if (tileCache === null) {
          const wayIds = [];
          for (const r of this.db.prepare(`SELECT id FROM ways INDEXED BY way_index
            WHERE max_lon >= ? AND min_lon <= ? AND max_lat >= ? AND min_lat <= ?`)
            .iterate(box.minLon, box.maxLon, box.minLat, box.maxLat)) wayIds.push(r.id);
          tileCache = this._wayGeomNodeCache(wayIds);
        }
        cache = tileCache;
      }
      return origFetch.call(this, ids, out, nodeTags, zoom, neverSendOn, cache);
    };
    let err = null;
    try { this.queryBbox(this._dlodQueryOpts(z, box, ctx)); } catch (e) { err = e; } finally {
      this._scanCandidates = origScan;
      this._coalesce = origCoalesce;
      this._coalesceAreas = origAreas;
      this._fetchNodes = origFetch;
      this.wayNodesBatch = origBatch;
    }
    if (!cap.lines && !cap.areas) {
      throw new Error('烘焙没走到 _coalesce/_coalesceAreas：' + (err ? err.message : '未知原因'));
    }
    return cap;
  }

  /** 烘焙用的查询参数：**与 server/index.js 的 /api/map 同一组**（否则几何会不一样） */
  _dlodQueryOpts(z, box, ctx) {
    const o = ctx.opts || {};
    return {
      ...box, zoom: z, limit: ctx.viewportLimit,
      wayCandidates: o.wayCandidates, nodeCandidates: o.nodeCandidates,
      relationLimit: o.relationLimit, relationCropPad: o.relationCropPad,
      relationCropMinMembers: o.relationCropMinMembers,
      relationCropBoundaryMembers: o.relationCropBoundaryMembers,
      detail: o.detail === undefined ? null : o.detail,
      lodDetail: o.lodDetail, lodRoadSend: o.roadSend,
      lodRoadClassFloor: o.roadClassFloor || o.roadClassZoom,
      minFillArea: o.minFillArea === undefined ? null : o.minFillArea,
      lodMinFillArea: o.lodMinFillArea,
      neverSend: null, lodNeverSend: o.neverSend,
      coalesce: o.coalesce, compact: true, view: null, flatCaps: false,
      // 预计算层自己读盘：烘焙时别让读路径又去读它（否则烘出来的就是"上一版的结果"）
      _dlodOff: true,
    };
  }

  /**
   * 规则签名：`displaylod.js signature()`。读路径每次都会按"这次请求实际生效的参数"重算，
   * 对不上就退回实时路径（改了 config 而没重建时**只会慢，绝不会画错**）。
   */
  _dlodSignatureFor(z, extent, tiles, lat, lod, coalesceOpts, limit, viewportLimit) {
    return DLOD.signature({
      bands: this._dlod.bands, tiles,
      extent, lat,
      detail: lod.detail, minFillArea: lod.minFillArea, sendRank: lod.sendRank,
      floor: lod.floor, neverSendOn: lod.neverSendOn, wayLodReady: this._wayLodReady,
      minZoom: coalesceOpts.minZoom, budget: coalesceOpts.budget, minClassWays: coalesceOpts.minClassWays,
      tolPx: coalesceOpts.tolPx, coordDigits: coalesceOpts.coordDigits,
      viewportLimit: viewportLimit === undefined ? limit : viewportLimit,
    });
  }

  /* ------------------------------ 构建 ------------------------------ */
  /**
   * 构建（同步版，给 `tools/build-display-lod.js` 与 CI 的种子步骤用）。
   * 带进度回调；每块瓦片是一个事务（**原子替换**：先 `DELETE WHERE z=? AND tile=?` 再插入）。
   *
   * `only` 给出时要建的 (z,tile) 集合（增量/失效重算都走它）。
   */
  buildDisplayLod({ bands, only, onProgress, log } = {}) {
    this._dlodEnsureSchema();
    const t0 = Date.now();
    const extent = this._dlodDataExtent();
    if (!extent) throw new Error('库里没有任何带 bbox 的 way，无法建预计算层');
    const tiles = this._dlod.tiles;
    const lat = this._dlodLatRef(extent);
    const grid = this._dlodGrid(extent, tiles);
    const want = (bands && bands.length ? bands : this._dlod.bands).slice().sort((a, b) => a - b);
    const jobs = [];
    for (const z of want) {
      for (let tile = 1; tile <= grid.count; tile++) {
        if (only && !only.has(z + ':' + tile)) continue;
        jobs.push([z, tile]);
      }
    }
    const report = { extent, tiles, lat, bands: want, jobs: jobs.length, done: 0, failed: 0, lines: 0, areas: 0, cov: 0, bytes: 0, maxTileMs: 0, ms: 0, perBand: {}, survey: {} };
    const insLine = this.db.prepare(`INSERT OR REPLACE INTO ${DLOD.DLOD_TABLE}
      (z,tile,id,owner,kind,family,cls,name,rel,ways,nseg,npts,rawnpts,min_lon,max_lon,min_lat,max_lat,tags,geom,built_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insCov = this.db.prepare(`INSERT OR REPLACE INTO ${DLOD.DLOD_COV}
      (z,tile,way_id,status,sub,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?,?,?,?,?)`);
    /** 每个 band 一张去向 R*Tree + 它对应的插入/删除语句（见 displaylod.js 里为什么按 band 分表） */
    const covRt = new Map();
    const covRtOf = (z) => {
      let o = covRt.get(z);
      if (!o) {
        this.db.exec(DLOD.covRtreeSql(z));
        const rt = DLOD.covRtreeName(z);
        o = {
          ins: this.db.prepare(`INSERT OR REPLACE INTO ${rt}(id,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?)`),
          del: this.db.prepare(`DELETE FROM ${rt} WHERE id IN (SELECT rowid FROM ${DLOD.DLOD_COV} WHERE z = ? AND tile = ?)`),
        };
        covRt.set(z, o);
      }
      return o;
    };
    const delTile = this.db.prepare(`DELETE FROM ${DLOD.DLOD_TABLE} WHERE z = ? AND tile = ?`);
    const delCov = this.db.prepare(`DELETE FROM ${DLOD.DLOD_COV} WHERE z = ? AND tile = ?`);
    const cx = this._dlodBuildCtx(extent, lat, grid);
    // 全量构建：每个 band 在整个数据范围上把"要合并的样式类"定一次；增量重算用 meta 里存下来的那份
    for (const z of want) {
      const t = Date.now();
      const r = this._dlodClassesFor(z, cx, only);
      report.survey[z] = { ms: Date.now() - t, classes: r.classes.length, from: r.from };
      if (log && r.from === 'survey') log(`  选类探针 z${z}：${r.classes.length} 个样式类（${Date.now() - t} ms）`);
    }
    const builtAt = Date.now();
    for (const [z, tile] of jobs) {
      const box = grid.boxOf(tile);
      const tt0 = Date.now();
      let cap = null;
      let ferr = null;
      try { cap = this._dlodBakeTile(z, tile, box, cx); } catch (e) { ferr = e; }
      const ms = Date.now() - tt0;
      if (ms > report.maxTileMs) report.maxTileMs = ms;
      if (ferr) {
        report.failed += 1;
        if (log) log(`  ⚠ z${z} 瓦片 #${tile} 烘焙失败：${ferr.message.slice(0, 120)}`);
        continue;
      }
      let rows = 0;
      const band = report.perBand[z] || (report.perBand[z] = { lines: 0, areas: 0, cov: 0, bytes: 0, ms: 0, maxTileMs: 0, tiles: 0 });
      this.db.exec('BEGIN');
      try {
        covRtOf(z).del.run(z, tile);
        delTile.run(z, tile);
        delCov.run(z, tile);
        for (const r of this._dlodRowsOf(z, tile, cap, cx, builtAt)) {
          insLine.run(...r.args);
          rows += 1;
          report.bytes += r.bytes;
          band.bytes += r.bytes;
          if (r.kind === 'area') { report.areas += 1; band.areas += 1; } else { report.lines += 1; band.lines += 1; }
        }
        for (const c of this._dlodCovRowsOf(z, tile, cap, cx)) {
          const res = insCov.run(...c);
          covRtOf(z).ins.run(res.lastInsertRowid, c[5], c[6], c[7], c[8]);
          report.cov += 1; band.cov += 1;
        }
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
        report.failed += 1;
        if (log) log(`  ⚠ z${z} 瓦片 #${tile} 写库失败：${e.message.slice(0, 120)}`);
        continue;
      }
      band.ms += ms; band.tiles += 1;
      if (ms > band.maxTileMs) band.maxTileMs = ms;
      report.done += 1;
      if (onProgress) onProgress(report.done / jobs.length, { z, tile, rows, ms });
    }
    // band 级状态落 meta：**建到哪个档、哪个档立刻开始走快路径**（读路径按 bands[z].done 判）
    this._dlodFlushMeta(cx, report, true);
    report.ms = Date.now() - t0;
    return report;
  }

  /** 烘焙上下文（LOD 规则 + 合并规则 + 配置；与 /api/map 用的同一份规范化函数） */
  _dlodBuildCtx(extent, lat, grid) {
    const o = this._dlod.opts || {};
    /**
     * ⚠ `QUERY_CAPS` 里**没有** viewportLimit 这个键（它由 config limits.viewportLimit 提供，
     * index.js 的默认值是 15000）。第一版这里写成 `capOf(o.viewportLimit, QUERY_CAPS.viewportLimit)`，
     * 于是"没带 limits 的调用方"（工具/测试直接 `new OsmDB(file, {displayLod:{...}})`）拿到的是
     * `undefined` → 签名里少一个键 → 读路径永远对不上、永远退回实时路径。
     * 现在兜底 15000：与 server/index.js 的默认口径一致（config.json 的 limits.viewportLimit 也是它）。
     */
    const limit = capOf(o.viewportLimit, 15000);
    const lod = makeLod({
      zoom: 16, detail: o.detail === undefined ? null : o.detail, lodDetail: o.lodDetail,
      minFillArea: o.minFillArea === undefined ? null : o.minFillArea, lodMinFillArea: o.lodMinFillArea,
      roadSend: o.roadSend, lodRoadSend: o.roadSend,
      roadClassFloor: o.roadClassFloor || o.roadClassZoom,
      neverSend: null, lodNeverSend: o.neverSend,
    });
    return {
      extent, lat, grid, viewportLimit: limit, opts: o,
      lodProto: lod,
      coalesceOpts: coalesceOptsOf(o.coalesce),
      scale: Math.pow(10, coalesceOptsOf(o.coalesce).coordDigits),
      /** band → 全局定下来的"要合并的样式类"集合（见 `_dlodSurveyClasses`） */
      forceClasses: new Map(),
    };
  }

  /**
   * **在整个数据范围上把"这一档要合并哪些样式类"定一次**（原型点名的那个坑：瓦片越小、
   * 按本瓦片条数选中的类越少，本该合并的 way 会被挤出去）。
   *
   * 做法：拿**整个数据范围**当视口跑一次真实的 `queryBbox`，但让 `_coalesce` 走
   * `surveyClasses` 探针 —— 它数完每个类的条数、按同一条规则（`chooseCoalesceClasses`）选完类
   * 就返回，**不接龙、不取节点坐标、不算面**，所以便宜（实测每个 band 100~400 ms，见报告）。
   * 拿到的集合烘进 meta 的 `bands[z].classes`，之后每一块瓦片（以及**单块瓦片的重算**）都用它。
   */
  _dlodSurveyClasses(z, cx) {    let captured = null;
    const orig = this._coalesce;
    const self = this;
    this._coalesce = function (picked, geom, o) {
      const r = orig.call(this, picked, geom, Object.assign({}, o, {
        lat: cx.lat, opts: Object.assign({}, o.opts, { surveyClasses: true }),
      }));
      captured = r;
      throw new Error('__DLOD_SURVEY_STOP__');
    };
    try {
      this.queryBbox(this._dlodQueryOpts(z, cx.extent, cx));
    } catch (e) {
      if (!captured) throw new Error('选类探针失败（z' + z + '）：' + e.message);
    } finally {
      this._coalesce = orig;
    }
    void self;
    const list = (captured && captured.chosenClasses) || [];
    cx.forceClasses.set(z, new Set(list));
    return { classes: list, scanned: captured ? captured.stats.candidateWays : 0 };
  }

  /**
   * 这一档要用的"合并样式类集合"：**增量重算从 meta 读，全量构建才探针**。
   * 返回 `{ classes, from }`，`from` ∈ 'survey'（这次真的算了一遍）/ 'meta'（用烘好的那份）。
   */
  _dlodClassesFor(z, cx, only) {
    if (only) {
      const st = this._dlodState();
      const stored = st && st.bands[z] && st.bands[z].classes;
      if (Array.isArray(stored) && stored.length) {
        cx.forceClasses.set(z, new Set(stored));
        return { classes: stored, from: 'meta' };
      }
    }
    const r = this._dlodSurveyClasses(z, cx);
    return { classes: r.classes, from: 'survey' };
  }

  /**
   * 一块瓦片的捕获结果 → `display_lod` 的行。
   *
   * 每个条目（折线 / 面）一行：几何用**现有那套量化 + 差分的紧凑编码**（`packLodPaths`），
   * 另附点数/段数/来源 way 条数/bbox/标签；`id` 是稳定内容 id（`DLOD.stableId`），
   * 于是"重算同一块瓦片"写回的是同一批 id（A/B 对拍与排查都看得到）。
   *
   * 每行的 `cls` / `ways` / `rawnpts` 来自 `_coalesce` / `_coalesceAreas` 输出的
   * `groupCls` / `groupWays` / `groupRaw`（与 `lines` / `entries` **同一个循环、同一个下标**填的，
   * 所以不可能是"另算一遍"的近似值），分组键 `groupKeys[i]` 用来定稳定 id。
   */
  *_dlodRowsOf(z, tile, cap, cx, builtAt) {
    const scale = cx.scale;
    const lines = cap.lines || [];
    const lKeys = (cap.coalescePlan && cap.coalescePlan.groupKeys) || [];
    const lCls = (cap.coalescePlan && cap.coalescePlan.groupCls) || [];
    const lWays = (cap.coalescePlan && cap.coalescePlan.groupWays) || [];
    const lRaw = (cap.coalescePlan && cap.coalescePlan.groupRaw) || [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const paths = pathsOfEntry(l);
      if (!paths.length) continue;
      const box = DLOD.bboxOfPaths(paths);
      const id = DLOD.stableId(crypto, 'line', z, tile, lKeys[i] === undefined ? ('idx:' + i) : lKeys[i]);
      const npts = paths.reduce((s, p) => s + p.length, 0);
      const geom = packLodPaths(paths, scale);
      yield {
        kind: 'line', id, bytes: geom.length,
        args: [z, tile, id, tile, 'line', l.class || 'other', lCls[i] || null, (l.tags && l.tags.name) || null, null,
          lWays[i] || 0, paths.length, npts, lRaw[i] || 0,
          box.minLon, box.maxLon, box.minLat, box.maxLat, JSON.stringify(l.tags || {}), geom, builtAt],
      };
    }
    const areas = cap.areas || [];
    const aKeys = (cap.areasPlan && cap.areasPlan.groupKeys) || [];
    const aCls = (cap.areasPlan && cap.areasPlan.groupCls) || [];
    const aWays = (cap.areasPlan && cap.areasPlan.groupWays) || [];
    const aRaw = (cap.areasPlan && cap.areasPlan.groupRaw) || [];
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i];
      const paths = pathsOfEntry(a);
      if (!paths.length) continue;
      const box = DLOD.bboxOfPaths(paths);
      const id = DLOD.stableId(crypto, 'area', z, tile, aKeys[i] === undefined ? ('idx:' + i) : aKeys[i]);
      const npts = paths.reduce((s, p) => s + p.length, 0);
      const geom = packLodPaths(paths, scale);
      yield {
        kind: 'area', id, bytes: geom.length,
        args: [z, tile, id, tile, 'area', a.class || 'other', aCls[i] || null, (a.tags && a.tags.name) || null,
          a.rel === undefined ? null : a.rel, aWays[i] || 0, paths.length, npts, aRaw[i] || 0,
          box.minLon, box.maxLon, box.minLat, box.maxLat, JSON.stringify(a.tags || {}), geom, builtAt],
      };
    }
  }

  /**
   * 一块瓦片的捕获结果 → `display_lod_cov` 的行（**这块瓦片里每一个候选 way 的去向**）。
   *
   * 这张表是查询侧重建 `truncation.kinds.ways` 那本账的**唯一依据** —— 于是走预计算路径时
   * 服务端**再也不需要为了"数一数有几个候选 way"去扫 2.3 万行 way、逐行 JSON.parse 标签**
   * （那一步实测 z10 168 ms / z12 214 ms，是这条路上最后一块大头）。
   * 每条 way 的去向与实时路径**逐个对齐**（`line` = coalesced、`area` = areas.covered、
   * `way` = 逐条下发、`nogfx` = 没几何、`invisible` = 分级看不见、`lod` = LOD 扣下）。
   *
   * bbox 存成 1e-5 度的整数（约 1.1 m）：查询侧用它判"这条 way 与视口相不相交"，
   * 而实时路径那个判据本来也是 bbox 级的（R*Tree 还是 float32），精度远够。
   */
  _dlodCovRowsOf(z, tile, cap, cx) {
    const S = 1e5;
    const qi = (v) => Math.round(v * S);
    const out = [];
    const seen = new Set();
    const push = (row, status, sub) => {
      const id = Number(row.id);
      if (seen.has(id)) return;
      seen.add(id);
      out.push([z, tile, id, status, sub || null,
        qi(row.bb_min_lon) - 1, qi(row.bb_max_lon) + 1, qi(row.bb_min_lat) - 1, qi(row.bb_max_lat) + 1]);
    };
    const lod = cx.lodProto;
    const zoom = z;
    for (const row of cap.rejects) {
      const tags = parseTags(row.tags);
      if (!tags || !lodVisible(tags, zoom, 'line', lod.floor)) { push(row, 'invisible', null); continue; }
      const cls = lodWithholdClass(tags, zoom, lod, row, !!row.closed);
      if (!cls) { push(row, 'invisible', null); continue; }   // 防御：不该发生
      let sub = cls;
      if (cls === 'neverSend') sub = 'neverSend:' + (neverSendClassOf(tags) || 'other');
      else if (cls === 'roadClass') sub = 'roadClass:' + roadRankOf(tags);
      else if (cls === 'railMinor') sub = tags.usage === 'main' ? 'railMinor:main' : 'railMinor';
      push(row, 'lod', sub);
    }
    const coalesced = cap.coalesced || new Set();
    const covered = cap.covered || new Set();
    const geom = cap.geom;
    for (const p of cap.picked) {
      const id = Number(p.row.id);
      const ids = geom.get(id);
      if (!ids || !ids.length) { push(p.row, 'nogfx', null); continue; }
      if (coalesced.has(id)) { push(p.row, 'line', coalesceClassOf(p.tags)); continue; }
      if (covered.has(id)) { push(p.row, 'area', areaClassOf(p.tags)); continue; }
      push(p.row, 'way', null);
    }
    return out;
  }

  /**
   * **切片构建**（服务端启动时对老库自动补建 / 失效后后台重算走它）。
   *
   * 切片单位 = 一个 (band, 瓦片)。每片之间 `setImmediate` 让出事件循环，`/api/ready` 一直能答；
   * 每个 band 全部建完就写一次 meta（**建到哪一档、哪一档立刻开始走快路径**）。
   * ⚠ 单片就是一个真实的瓦片合并，实测最坏一块（z14）1.1~1.9 s —— 做不到 25 ms，
   * 这是"一次同步合并 + 一次批量取几何"的下限（要更快只能把瓦片切得更细，代价是跨瓦片重复几何更多）。
   */
  async buildDisplayLodSliced({ bands, only, sliceMs = 25, onProgress, log } = {}) {
    const t0 = Date.now();
    this._dlodEnsureSchema();
    const extent = this._dlodDataExtent();
    if (!extent) return { skipped: '库里没有 way', ms: 0 };
    const tiles = this._dlod.tiles;
    const lat = (extent.minLat + extent.maxLat) / 2;
    const grid = this._dlodGrid(extent, tiles);
    const want = (bands && bands.length ? bands : this._dlod.bands).slice().sort((a, b) => a - b);
    const jobs = [];
    for (const z of want) for (let tile = 1; tile <= grid.count; tile++) {
      if (only && !only.has(z + ':' + tile)) continue;
      jobs.push([z, tile]);
    }
    const cx = this._dlodBuildCtx(extent, lat, grid);
    /**
     * 全量/首次构建：每个 band 在整个数据范围上把"要合并的样式类"定一次（`_dlodSurveyClasses`）。
     * **增量重算（`only`）绝不重新探针**：一是贵，二是"重算一块瓦片"必须用**与其它瓦片同一份**类集合，
     * 否则同一档里不同瓦片的折线集就会不一致（那正是"瓦片越小选中的类越少"这个坑的另一种形态）。
     * 所以类集合烘进 meta（`bands[z].classes`），重算时从 meta 读。
     */
    const stats = { done: 0, failed: 0, total: jobs.length, perBand: {}, maxTileMs: 0, slices: 0, lines: 0, areas: 0, cov: 0, bytes: 0, survey: {} };
    for (const z of want) {
      const t = Date.now();
      const r = this._dlodClassesFor(z, cx, only);
      stats.survey[z] = { ms: Date.now() - t, classes: r.classes.length, from: r.from };
    }
    const out = await this._dlodWriteJobs(jobs, cx, stats, { sliceMs, onProgress, log });
    Object.assign(stats, out);
    stats.ms = Date.now() - t0;
    return stats;
  }

  /** 真正写库的那一段（同步构建与切片构建共用；每片之间让出事件循环） */
  async _dlodWriteJobs(jobs, cx, stats, { sliceMs = 25, onProgress, log } = {}) {
    const z = this._dlod;
    const insLine = this.db.prepare(`INSERT OR REPLACE INTO ${DLOD.DLOD_TABLE}
      (z,tile,id,owner,kind,family,cls,name,rel,ways,nseg,npts,rawnpts,min_lon,max_lon,min_lat,max_lat,tags,geom,built_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insCov = this.db.prepare(`INSERT OR REPLACE INTO ${DLOD.DLOD_COV}
      (z,tile,way_id,status,sub,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?,?,?,?,?)`);
    /** 每个 band 一张去向 R*Tree + 它对应的插入/删除语句（见 displaylod.js 里为什么按 band 分表） */
    const covRt = new Map();
    const covRtOf = (z) => {
      let o = covRt.get(z);
      if (!o) {
        this.db.exec(DLOD.covRtreeSql(z));
        const rt = DLOD.covRtreeName(z);
        o = {
          ins: this.db.prepare(`INSERT OR REPLACE INTO ${rt}(id,min_lon,max_lon,min_lat,max_lat) VALUES(?,?,?,?,?)`),
          del: this.db.prepare(`DELETE FROM ${rt} WHERE id IN (SELECT rowid FROM ${DLOD.DLOD_COV} WHERE z = ? AND tile = ?)`),
        };
        covRt.set(z, o);
      }
      return o;
    };
    const delTile = this.db.prepare(`DELETE FROM ${DLOD.DLOD_TABLE} WHERE z = ? AND tile = ?`);
    const delCov = this.db.prepare(`DELETE FROM ${DLOD.DLOD_COV} WHERE z = ? AND tile = ?`);
    const builtAt = Date.now();
    let i = 0;
    while (i < jobs.length) {
      const sliceStart = Date.now();
      while (i < jobs.length && (i === 0 || Date.now() - sliceStart < sliceMs)) {
        const [bz, tile] = jobs[i];
        i += 1;
        const box = cx.grid.boxOf(tile);
        const tt0 = Date.now();
        let cap = null;
        let ferr = null;
        try { cap = this._dlodBakeTile(bz, tile, box, cx); } catch (e) { ferr = e; }
        const ms = Date.now() - tt0;
        if (ms > stats.maxTileMs) stats.maxTileMs = ms;
        const band = stats.perBand[bz] || (stats.perBand[bz] = { lines: 0, areas: 0, cov: 0, bytes: 0, tiles: 0, maxTileMs: 0 });
        band.tiles += 1;
        if (ms > band.maxTileMs) band.maxTileMs = ms;
        if (ferr) {
          stats.failed += 1;
          if (log) log(`[dlod] ⚠ z${bz} 瓦片 #${tile} 烘焙失败：${ferr.message.slice(0, 120)}`);
          continue;
        }
        if (!stats.hasOwnProperty('_' + bz)) { stats['_' + bz] = 1; }   // 标记这个 band 被动过
        this.db.exec('BEGIN');
        try {
          covRtOf(bz).del.run(bz, tile);
          delTile.run(bz, tile);
          delCov.run(bz, tile);
          for (const r of this._dlodRowsOf(bz, tile, cap, cx, builtAt)) {
            insLine.run(...r.args);
            stats.bytes += r.bytes; band.bytes += r.bytes;
            if (r.kind === 'area') { stats.areas += 1; band.areas += 1; } else { stats.lines += 1; band.lines += 1; }
          }
          for (const c of this._dlodCovRowsOf(bz, tile, cap, cx)) {
            const res = insCov.run(...c);
            covRtOf(bz).ins.run(res.lastInsertRowid, c[5], c[6], c[7], c[8]);
            stats.cov += 1; band.cov += 1;
          }
          this.db.exec('COMMIT');
        } catch (e) {
          try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
          stats.failed += 1;
          if (log) log(`[dlod] ⚠ z${bz} 瓦片 #${tile} 写库失败：${e.message.slice(0, 120)}`);
          continue;
        }
        stats.done += 1;
        if (onProgress) onProgress(stats.done / Math.max(1, stats.total), { z: bz, tile, ms });
      }
      stats.slices += 1;
      this._dlodFlushMeta(cx, stats);
      await new Promise((r) => setImmediate(r));
    }
    this._dlodFlushMeta(cx, stats, true);
    return stats;
  }

  /**
   * 把这一层的状态写进 meta（读路径据此决定"哪一档可以走快路径"）。
   *
   * ⚠ 两个必须写对的地方（都踩过）：
   *   1. **`done` 在增量重算时必须保持 true**：失效重算只重建**脏的那一块瓦片**（`--only` 语义），
   *      要是拿"这一轮建了几块"去比"总共几块"，一个 band 会因为一次编辑就被标成"没建完"，
   *      于是读路径**永远**退回实时路径（本用例第一版就是这样：编辑之后再也没走回快路径）。
   *   2. **条数与体积从库里数，不用这一轮的统计**：增量重算的 stats 只覆盖脏瓦片，
   *      拿它去覆盖 meta 会让 band 的行数/体积凭空缩水（`rows` 甚至可能变成 0 → 整层不可用）。
   *      这两条 `SELECT` 都走索引，几毫秒。
   */
  _dlodFlushMeta(cx, stats, final = false) {
    const prev = this._dlodState();
    const bands = {};
    if (prev) Object.assign(bands, prev.bands);
    const stBand = this.db.prepare(`SELECT COUNT(*) AS n, SUM(LENGTH(geom)) AS bytes,
      SUM(kind = 'line') AS lines, SUM(kind = 'area') AS areas FROM ${DLOD.DLOD_TABLE} WHERE z = ?`);
    const stCov = this.db.prepare(`SELECT COUNT(*) AS n FROM ${DLOD.DLOD_COV} WHERE z = ?`);
    const stTile = this.db.prepare(`SELECT COUNT(DISTINCT tile) AS n FROM ${DLOD.DLOD_TABLE} WHERE z = ?`);
    for (const k of Object.keys(stats.perBand)) {
      const z = Number(k);
      const b = stats.perBand[k];
      const fromDb = stBand.get(z);
      const prevBand = bands[k];
      const doneBefore = !!(prevBand && prevBand.done);
      // "这一档一共建过几块瓦片"：已经建完的照旧算建完；否则把上一轮的块数加上这一轮的
      const tiles = doneBefore ? cx.grid.count
        : Math.min(cx.grid.count, (prevBand ? prevBand.tiles || 0 : 0) + b.tiles);
      bands[k] = {
        tiles, lines: fromDb.lines || 0, areas: fromDb.areas || 0,
        rows: fromDb.n || 0, cov: stCov.get(z).n || 0, bytes: fromDb.bytes || 0,
        maxTileMs: Math.max((prevBand && prevBand.maxTileMs) || 0, b.maxTileMs || 0),
        builtTiles: stTile.get(z).n || 0,
        // 这一档"要合并的样式类"集合：重算单块瓦片时必须用**同一份**（见 _dlodClassesFor）
        classes: cx.forceClasses.has(z) ? [...cx.forceClasses.get(z)]
          : ((prevBand && prevBand.classes) || []),
        done: tiles >= cx.grid.count || (final && doneBefore && fromDb.n > 0),
        at: Date.now(),
        // 签名按 band 单独存（`sendRank` 随 zoom 变，所以不能一个签名管七个档）
        sig: this._dlodSigForBand(z, cx),
      };
    }
    let rows = 0; let bytes = 0;
    for (const k of Object.keys(bands)) { rows += (bands[k].lines || 0) + (bands[k].areas || 0); bytes += bands[k].bytes || 0; }
    const state = {
      version: DLOD.DLOD_VERSION, tiles: cx.grid.n, extent: cx.extent, lat: cx.lat,
      bands, rows, bytes, builtAt: (prev && prev.builtAt) || Date.now(),
    };
    this.db.prepare(`INSERT OR REPLACE INTO ${DLOD.DLOD_META}(k, v) VALUES('state', ?)`).run(JSON.stringify(state));
    this._dlodStateCache = undefined;
  }

  /** 某个 band 的规则签名（读路径按同一份算法重算并要求完全一致） */
  _dlodSigForBand(z, cx) {
    const o = cx.opts;
    const lod = makeLod({
      zoom: z, detail: o.detail === undefined ? null : o.detail, lodDetail: o.lodDetail,
      minFillArea: o.minFillArea === undefined ? null : o.minFillArea, lodMinFillArea: o.lodMinFillArea,
      roadSend: o.roadSend, lodRoadSend: o.roadSend,
      roadClassFloor: o.roadClassFloor || o.roadClassZoom,
      neverSend: null, lodNeverSend: o.neverSend,
    });
    return this._dlodSignatureFor(z, cx.extent, cx.grid.n, cx.lat, lod, cx.coalesceOpts, cx.viewportLimit, cx.viewportLimit);
  }

  /* ------------------------------ 失效（编辑） ------------------------------ */
  /**
   * **标记脏瓦片**（写路径唯一的钩子）。规则（见 `dlodMarkDirty` 的调用点）：
   *   · 一条 way 的几何变了 → 它**新旧 bbox** 压到的所有瓦片都脏（在两个 band 段内）；
   *   · 只标"这条 way 真的可见的那些档"（`ways.lod_zoom ~ 14`），不是无脑 7 个档 ——
   *     实测（logs/pc-invalidate.txt）12×12 网格下"每条 way 压到的瓦片数"中位 1、p99 2，
   *     而一条 residential（lod_zoom=14）只需重算 z14 那一档。
   *
   * 脏瓦片在重算完成**之前**一律走实时路径（`_dlodPlan` 直接返回 null），
   * 所以"绝不显示旧几何"是结构性的，不靠重算及时。
   */
  dlodMarkDirty(box, minZoom, maxZoom) {
    if (!this._dlod.on || !box || !Number.isFinite(box.minLon)) return 0;
    const st = this._dlodState();
    if (!st) return 0;
    const grid = DLOD.makeGrid(st.extent, st.tiles);
    const tiles = grid.tilesOfBox(box);
    if (!DLOD.boxInside(box, st.extent)) {
      /**
       * 改动落在数据范围之外（有人在网格外新建了一条路/拖出一个点）：整层作废 ——
       * 把所有 (band, 瓦片) 标脏，后台那次重建会**重算范围**再逐块重烘；
       * 在那之前读路径整体退回实时路径（`_dlodExtentStale`）。
       */
      this._dlodExtentStale = true;
      for (const z of this._dlod.bands) for (let t = 1; t <= grid.count; t++) this._dlodAddDirty(z, t);
      return 0;
    }
    if (!tiles.length) return 0;
    const lo = Math.max(0, Math.floor(Number(minZoom) || 0));
    const hi = Math.max(lo, Math.floor(Number(maxZoom) || 0));
    let n = 0;
    for (const z of this._dlod.bands) {
      if (z < lo || z > hi) continue;
      for (const t of tiles) if (this._dlodAddDirty(z, t)) n += 1;
    }
    return n;
  }

  _dlodAddDirty(z, tile) {
    const key = z + ':' + tile;
    if (this._dlodDirty.has(key)) return false;
    this._dlodDirty.set(key, { z, tile, at: Date.now() });
    try {
      this.db.prepare(`INSERT OR REPLACE INTO ${DLOD.DLOD_DIRTY}(z, tile, at) VALUES(?,?,?)`).run(z, tile, Date.now());
    } catch { /* 库是只读/表不存在：内存里记住就够 */ }
    this._dlodKick();
    return true;
  }

  _dlodClearDirty(z, tile) {
    this._dlodDirty.delete(z + ':' + tile);
    try { this.db.prepare(`DELETE FROM ${DLOD.DLOD_DIRTY} WHERE z = ? AND tile = ?`).run(z, tile); } catch { /* ignore */ }
  }

  _dlodLoadDirty() {
    this._dlodDirty = new Map();
    try {
      for (const r of this.db.prepare(`SELECT z, tile, at FROM ${DLOD.DLOD_DIRTY}`).iterate()) {
        this._dlodDirty.set(r.z + ':' + r.tile, { z: r.z, tile: r.tile, at: r.at });
      }
    } catch { /* 没有这张表：一切照旧 */ }
  }

  /** 后台重算：串行、每块之间让出事件循环；一次只跑一个循环（重复调用直接返回） */
  _dlodKick() {
    if (this._dlodBgRunning || !this._dlod.autoRebuild) return;
    if (!this._dlodDirty.size) return;
    this._dlodBgRunning = true;
    setTimeout(() => this._dlodDrain().catch(() => { this._dlodBgRunning = false; }), 50);
  }

  /**
   * **把上一次进程留下的脏瓦片接着算完**（服务端启动时调用，见 index.js 的 autoBuildDisplayLod）。
   *
   * 为什么必须有这一条：脏集合是**跨重启保留**的（写在 `display_lod_dirty` 表里，这是对的 ——
   * 进程被杀时那些瓦片确实还没重算）。但"标脏"那条路（`_dlodAddDirty`）才会 `_dlodKick()`，
   * 而启动时是 `_dlodLoadDirty()` 从表里读回来的 —— 第一版没在这里补一次 kick，
   * 结果**被 Ctrl+C / 被 kill 打断过一次之后，那几块瓦片就永远走实时路径了**
   *（本套件第二次运行时抓到的就是这个：基线请求 ms=699 = 实时路径）。
   * 返回这次"接手"了多少块脏瓦片，调用方如实打日志。
   */
  dlodResume() {
    if (!this._dlod.on) return 0;
    const n = this._dlodDirty.size;
    if (n) this._dlodKick();
    return n;
  }

  async _dlodDrain() {
    try {
      while (this._dlodDirty.size) {
        const keys = [...this._dlodDirty.values()].slice(0, 64);
        const only = new Set(keys.map((k) => k.z + ':' + k.tile));
        const bands = [...new Set(keys.map((k) => k.z))];
        const t0 = Date.now();
        const stats = await this.buildDisplayLodSliced({ bands, only, sliceMs: this._dlod.sliceMs, log: this._dlod.log });
        for (const k of keys) this._dlodClearDirty(k.z, k.tile);
        this._dlodExtentStale = false;
        if (this._dlod.log) {
          this._dlod.log(`[dlod] 失效重算完成：${keys.length} 块（band ${bands.join(',')}）· ${stats.done} 块成功 / ${stats.failed} 失败`
            + ` · 最长一块 ${stats.maxTileMs} ms · 合计 ${Date.now() - t0} ms`);
        }
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      this._dlodBgRunning = false;
    }
  }

  /** 同步重算脏瓦片（测试/工具用；服务端走 _dlodDrain 的后台循环） */
  dlodRebuildDirtyNow() {    if (!this._dlodDirty.size) return { done: 0 };
    const keys = [...this._dlodDirty.values()];
    const only = new Set(keys.map((k) => k.z + ':' + k.tile));
    const bands = [...new Set(keys.map((k) => k.z))];
    const stats = this.buildDisplayLod({ bands, only });
    for (const k of keys) this._dlodClearDirty(k.z, k.tile);
    return stats;
  }

  /* ------------------------------ 读路径 ------------------------------ */
  /**
   * 这次请求能不能走预计算？逐条判据（任何一条不满足都**退回实时路径**，画面永远是对的）：
   *   1. 开关开着（config limits.displayLod.on）；
   *   2. 库里这一层在，而且**这个 band 建完了**（`bands[z].done`）；
   *   3. 请求框完全落在这一层的数据范围内（在外面就没有可用的行）；
   *   4. 规则签名一致（config 的 LOD / 合并参数、视口上限、way 索引是否可用……）；
   *   5. 请求框压到的瓦片里**没有脏的**（编辑过还没重算 → 整包走实时，绝不混合新旧几何）。
   */
  _dlodPlan(zoom, box, lod, coalesceOpts, limit, viewportLimit) {
    if (!this._dlod.on || this._dlodOff) return null;
    const st = this._dlodState();
    if (!st || !st.rows) return null;
    const band = st.bands[zoom];
    if (!band || !band.done) return null;
    if (!box || !Number.isFinite(box.minLon)) return null;
    if (!DLOD.boxIntersects(box, st.extent)) return null;
    if (this._dlodExtentStale) return null;
    const sig = this._dlodSignatureFor(zoom, st.extent, st.tiles, st.lat, lod, coalesceOpts, limit, viewportLimit);
    if (sig !== band.sig) return null;
    const grid = DLOD.makeGrid(st.extent, st.tiles);
    const tiles = grid.tilesOfBox(box);
    if (!tiles.length) return null;
    for (const t of tiles) if (this._dlodDirty.has(zoom + ':' + t)) return null;
    const coordDigits = coalesceOpts.coordDigits;
    return { band: band, zoom: Number(zoom), grid, tiles, state: st, sig, coordDigits, scale: Math.pow(10, coordDigits) };
  }

  /**
   * 按瓦片读预计算层：R*Tree 不需要 —— 取行是**主键范围**（`z = ? AND tile IN (…)`），
   * 而"跨瓦片的那部分几何"由"每个瓦片自己的行覆盖它自己的范围"这条性质保证（证明见 displaylod.js）。
   *
   * 为什么要裁剪：一条折线的 bbox 常常比视口大得多（z13 视口只占一块瓦片的 1/4），
   * 不裁会把 33% 的点花在框外（实测 z13 49,979 点 → 裁完 16,859 点，与实时路径的 17,776 点持平）。
   * 线用逐段裁（裁断就是断），面用 Sutherland–Hodgman（**必须保住闭合**，否则客户端只描边不填充）。
   */
  _dlodRead(plan, box) {
    const z = plan.zoom;
    const scale = plan.scale;
    const sel = this._cachedStmt(`SELECT id, kind, family, cls, name, rel, ways, nseg, npts, rawnpts,
      min_lon, max_lon, min_lat, max_lat, tags, geom FROM ${DLOD.DLOD_TABLE}
      WHERE z = ? AND tile IN (${DLOD.tilePlaceholders(plan.tiles.length)})`);
    const rows = sel.all(z, ...plan.tiles);
    const byId = new Map();
    for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
    const lines = []; const areas = [];
    // 折线与面的账**分开记**（实时路径的 `truncation.coalesce` 与 `truncation.viewOnly.areas`
    // 是两本账，混在一起会给出"面的点数是折线的点数"这种假数）
    const cnt = {
      line: { points: 0, rawPoints: 0, segs: 0, ways: 0 },
      area: { points: 0, rawPoints: 0, rings: 0, ways: 0 },
    };
    let clipped = 0;
    const clsLines = new Map(); const clsAreas = new Map();
    const famLines = new Map(); const famAreas = new Map();
    for (const r of byId.values()) {
      if (!(r.max_lon >= box.minLon && r.min_lon <= box.maxLon && r.max_lat >= box.minLat && r.min_lat <= box.maxLat)) continue;
      let paths = unpackLodPaths(r.geom, scale);
      const before = paths.reduce((s, p) => s + p.length, 0);
      if (r.kind === 'area') {
        const out = [];
        for (const p of paths) { const q = DLOD.clipRing(p, box); if (q) out.push(q); }
        paths = out;
      } else {
        paths = DLOD.clipPaths(paths, box);
      }
      const after = paths.reduce((s, p) => s + p.length, 0);
      if (!paths.length) continue;
      if (after !== before) clipped += 1;
      const tags = r.tags ? JSON.parse(r.tags) : {};
      const entry = { class: r.family || 'other', tags, coords: paths[0] };
      if (r.name) entry.name = r.name;
      if (paths.length > 1) entry.paths = paths.slice(1);
      if (r.rel !== null && r.rel !== undefined) entry.rel = r.rel;
      if (r.kind === 'area') areas.push(entry); else lines.push(entry);
      const c0 = r.kind === 'area' ? cnt.area : cnt.line;
      c0.points += after; c0.rawPoints += r.rawnpts || 0;
      if (r.kind === 'area') { c0.rings += paths.length; c0.ways += paths.length; } else { c0.segs += paths.length; c0.ways += r.ways || 0; }
      const byClass = r.kind === 'area' ? clsAreas : clsLines;
      const byFam = r.kind === 'area' ? famAreas : famLines;
      const ck = r.cls || ('#' + (r.family || 'other'));
      const cs = byClass.get(ck) || { class: ck, family: r.family || 'other', ways: 0, lines: 0, areas: 0, rings: 0, points: 0, tiny: 0 };
      cs.ways += (r.kind === 'area' ? paths.length : (r.ways || 0)); cs.points += after;
      if (r.kind === 'area') { cs.areas += 1; cs.rings += paths.length; } else { cs.lines += 1; }
      byClass.set(ck, cs);
      const fs = byFam.get(r.family || 'other') || { class: r.family || 'other', lines: 0, areas: 0, paths: 0, rings: 0, ways: 0, points: 0 };
      fs.ways += (r.kind === 'area' ? paths.length : (r.ways || 0)); fs.points += after;
      if (r.kind === 'area') { fs.areas += 1; fs.rings += paths.length; } else { fs.lines += 1; fs.paths += paths.length; }
      byFam.set(r.family || 'other', fs);
    }
    return {
      lines, areas,
      stats: {
        rows: rows.length, unique: byId.size, tiles: plan.tiles.length,
        lines: lines.length, areas: areas.length,
        segs: cnt.line.segs, points: cnt.line.points, rawPoints: cnt.line.rawPoints, ways: cnt.line.ways,
        areaRings: cnt.area.rings, areaPoints: cnt.area.points, areaRawPoints: cnt.area.rawPoints, areaWays: cnt.area.ways,
        clipped, clippedOut: clipped,
        classes: { lines: [...clsLines.values()].sort((a, b) => b.ways - a.ways), areas: [...clsAreas.values()].sort((a, b) => b.ways - a.ways) },
        byFamily: { lines: [...famLines.values()].sort((a, b) => b.ways - a.ways), areas: [...famAreas.values()].sort((a, b) => b.ways - a.ways) },
      },
    };
  }

  /**
   * 读**与视口相交的候选 way 的去向**（`display_lod_cov`），产出实时路径那本账要的所有东西。
   *
   * 取数方式是 **R\*Tree 驱动**（`display_lod_cov_rtree`）：`c.rowid IN (SELECT id FROM rtree WHERE bbox 与视口相交)`。
   * 为什么不能按 `(z, tile)` 主键把"整块瓦片的候选"读出来：z14 的候选扫描走 R*Tree 路径（没有
   * lod_zoom 过滤），市中心一块瓦片压着十几万条 way，而视口只占这块瓦片的三十分之一 ——
   * 实测按主键读 **630 ms**（`logs/pc-dlod-breakdown.txt`），比实时路径还慢。
   * 按 bbox 驱动读到的就是"与实时路径同一个判据"的那批候选（z14 3.6 万条），而且**一条标签都不用解析**。
   *
   * 同一个 way 可能出现在多块瓦片的去向表里（而且去向可能不同）→ 取"最好的"那个：
   * `line > area > way > nogfx`（几何进了折线就不再逐条下发）。这与实时路径"一条 way 只算一次"一致。
   */
  _dlodReadCov(plan, box) {
    const z = plan.zoom;
    const S = 1e5;
    const q = (v) => Math.round(v * S);
    const sel = this._cachedStmt(`SELECT c.way_id, c.status, c.sub
      FROM ${DLOD.covRtreeName(z)} r JOIN ${DLOD.DLOD_COV} c ON c.rowid = r.id
      WHERE r.max_lon >= ? AND r.min_lon <= ? AND r.max_lat >= ? AND r.min_lat <= ?`);
    const status = new Map();     // way_id → 去向（同一个 way 在多块瓦片里可能不同 → 取"最好的"那个：
    const sub = new Map();        //   line > area > way > nogfx —— 几何进了折线就不再逐条下发）
    const clsWays = new Map();    // 样式类 → Set(way_id)（**去重**：跨瓦片重复的 way 只算一次，
    const rank = { line: 0, area: 1, way: 2, nogfx: 3 };   // 这本账要与实时路径「按 way 去重」的口径一致）
    const better = (a, b) => (rank[a] === undefined ? 9 : rank[a]) < (rank[b] === undefined ? 9 : rank[b]);
    let candidates = 0;
    const lodBy = {};
    const roadsByRank = {};
    const neverSendWays = {};
    let lodWithheldTotal = 0;
    let trunkWithheld = 0; let minorRailWithheld = 0; let railWaterWithheld = 0; let landuseWithheld = 0;
    const bump = (cls, id) => {
      let s = clsWays.get(cls);
      if (!s) { s = new Set(); clsWays.set(cls, s); }
      s.add(id);
    };
    for (const r of sel.all(q(box.minLon), q(box.maxLon), q(box.minLat), q(box.maxLat))) {
      candidates += 1;
      const cur = status.get(r.way_id);
      if (cur === undefined || better(r.status, cur)) { status.set(r.way_id, r.status); sub.set(r.way_id, r.sub); }
      if ((r.status === 'line' || r.status === 'area') && r.sub) bump(r.sub, r.way_id);
      if (r.status === 'lod') {
        lodWithheldTotal += 1;
        const kind = String(r.sub || '').split(':')[0];
        lodBy[kind] = (lodBy[kind] || 0) + 1;
        if (kind === 'neverSend') {
          const cls = String(r.sub).split(':')[1] || 'other';
          neverSendWays[cls] = (neverSendWays[cls] || 0) + 1;
        } else if (kind === 'roadClass') {
          const rk = Number(String(r.sub).split(':')[1]);
          if (rk === 0) trunkWithheld += 1;
          else { const nm = roadRankName(rk); roadsByRank[nm] = (roadsByRank[nm] || 0) + 1; }
        } else if (kind === 'railMinor') {
          minorRailWithheld += 1;
          if (String(r.sub).endsWith(':main')) railWaterWithheld += 1;
        } else if (kind === 'landuse') {
          landuseWithheld += 1;
        }
      }
    }
    // 按（去重后的）way 集合分类：picked = 通过了显示分级且没被 LOD 扣下（= 实时路径 accept() 非空）
    const coveredLine = new Set();
    const coveredArea = new Set();
    const sentWay = new Set();
    const noGfx = new Set();
    for (const [id, stv] of status) {
      if (stv === 'line') coveredLine.add(id);
      else if (stv === 'area') coveredArea.add(id);
      else if (stv === 'way') sentWay.add(id);
      else if (stv === 'nogfx') noGfx.add(id);
    }
    for (const id of coveredLine) { if (sentWay.has(id)) sentWay.delete(id); }
    for (const id of coveredArea) { if (sentWay.has(id)) sentWay.delete(id); }
    const pickedIds = new Set([...coveredLine, ...coveredArea, ...sentWay, ...noGfx]);
    return {
      candidates, status, sub, clsWays, coveredLine, coveredArea, sentWay, noGfx, pickedIds,
      visible: pickedIds.size,
      lodBy, roadsByRank, neverSendWays,
      lodWithheldTotal, trunkWithheld, minorRailWithheld, railWaterWithheld, landuseWithheld,
    };
  }

  /* ------------------------------ ways.geom：物化几何 ------------------------------ */
  /** 开关（config limits.wayGeom；`on:false` 就是这一条的回滚键） */
  _wayGeomOpts() { return this._wayGeom; }

  /** 建列 + 回填（幂等，与 wayLod 的回填同一套做法：先抽查，不对就整表重填） */
  _ensureWayGeom() {
    if (!this._wayGeom.on) return;
    if (this.readOnly) {
      this._wayGeomReady = this._hasColumn('ways', 'geom') && this._wayGeomFilled();
      return;
    }
    try {
      if (!this._hasColumn('ways', 'geom')) {
        const t0 = Date.now();
        this.db.exec('ALTER TABLE ways ADD COLUMN geom BLOB');
        console.log(`[db] ways 表加列 geom（物化几何，${Date.now() - t0} ms）`);
      }
    } catch (err) {
      console.warn('[db] ways.geom 列不可用（退回 way_nodes + nodes 两次读表）:', err.message);
      this._wayGeom.on = false;
      return;
    }
    this._wayGeomReady = this._wayGeomFilled();
    if (!this._wayGeomReady) this._wayGeomBackfillTodo = true;   // 真正的回填在 init 里切片跑
  }

  _hasColumn(table, col) {
    try { return this.db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col); } catch { return false; }
  }

  /** 抽查 3000 行看这一列填过没有 */
  _wayGeomFilled() {
    try {
      const r = this.db.prepare('SELECT COUNT(*) AS c FROM (SELECT geom FROM ways WHERE deleted = 0 LIMIT 3000) WHERE geom IS NULL').get();
      return !!r && r.c === 0;
    } catch { return false; }
  }

  /** **回填**（切片：每片 ≤25 ms 让出事件循环）。老库启动时跑一次，之后靠写路径维护。 */
  async backfillWayGeom() {
    if (!this._wayGeom.on || this.readOnly) return { skipped: 'off' };
    const t0 = Date.now();
    const rows = this.db.prepare('SELECT id FROM ways WHERE deleted = 0 AND geom IS NULL').all();
    if (!rows.length) { this._wayGeomReady = true; return { done: 0, ms: 0 }; }
    console.log(`[db] 回填 ways.geom：${rows.length} 条 way（切片跑，期间让出事件循环）`);
    const upd = this.db.prepare('UPDATE ways SET geom = ? WHERE id = ?');
    let n = 0;
    let sliceStart = Date.now();
    for (const r of rows) {
      this._wayGeomWrite(r.id, upd);
      n += 1;
      if (Date.now() - sliceStart >= 25) { sliceStart = Date.now(); await new Promise((res) => setImmediate(res)); }
    }
    this._wayGeomReady = true;
    console.log(`[db] ways.geom 回填完成：${n} 条 · ${Date.now() - t0} ms`);
    return { done: n, ms: Date.now() - t0 };
  }

  /** 同步回填（工具/测试用；服务端走上面那个切片版，每片 ≤25 ms 让出事件循环） */
  backfillWayGeomSync() {
    if (!this._wayGeom.on || this.readOnly) return { skipped: 'off' };
    const t0 = Date.now();
    const rows = this.db.prepare('SELECT id FROM ways WHERE deleted = 0 AND geom IS NULL').all();
    const upd = this._cachedStmt('UPDATE ways SET geom = ? WHERE id = ?');
    for (const r of rows) this._wayGeomWrite(r.id, upd);
    this._wayGeomReady = true;
    return { done: rows.length, ms: Date.now() - t0 };
  }

  /**
   * **重写一条 way 的物化几何**（唯一写入口，与 `way_nodes` 同一个真值来源、同一次调用完成）。
   * 所以"移动/删除节点 → 立刻 `/api/map` 就是新几何"不需要任何后台任务。
   */
  _wayGeomWrite(wayId, updStmt) {
    if (!this._wayGeom.on) return;
    try {
      const ids = this._st.wayNodeIds.all(wayId).map((r) => r.node_id);
      const stmt = updStmt || this._cachedStmt('UPDATE ways SET geom = ? WHERE id = ?');
      if (!ids.length) { this._cachedStmt('UPDATE ways SET geom = NULL WHERE id = ?').run(wayId); return; }
      const ph = ids.map(() => '?').join(',');
      /**
       * ⚠ `deleted = 0` **必须有**：`_fetchNodes` 取坐标时就是这条口径（软删的节点不给坐标、
       * 但 `way_nodes` 的行还在 → `ways[id][1]` 照旧带着它的 id）。漏了这一条，
       * "删节点"之后物化几何里还会留着那个坐标，两边就对不上了（本套件第一版就抓到了这个）。
       */
      const byId = new Map(this._cachedStmt(`SELECT id, lat, lon, tags FROM nodes WHERE deleted = 0 AND id IN (${ph})`)
        .all(...ids).map((r) => [r.id, r]));
      const coords = new Array(ids.length).fill(null);
      const hasTags = new Uint8Array(ids.length);
      for (let i = 0; i < ids.length; i++) {
        const r = byId.get(ids[i]);
        if (!r) continue;   // 被删/缺节点：只留 id，不给坐标（与 _fetchNodes 的 deleted = 0 口径一致）
        coords[i] = [Math.round(r.lat * 1e7) / 1e7, Math.round(r.lon * 1e7) / 1e7];
        if (r.tags) hasTags[i] = 1;
      }
      stmt.run(packWayGeom(ids, coords, hasTags), wayId);
    } catch (err) {
      // 物化失败绝不影响正确性：读路径会自动退回 way_nodes + nodes
      this._wayGeom.on = false;
      console.warn('[db] ways.geom 写入失败，整条路退回 way_nodes + nodes:', err.message);
    }
  }

  /** 删了一个节点：用 `idx_way_nodes_node` 找出**含它的那些 way**，把物化几何在同一处重写 */
  _wayGeomRefreshForNode(nodeId) {
    if (!this._wayGeom.on) return 0;
    let n = 0;
    for (const r of this._st.wayRefsForNode.all(nodeId)) { this._wayGeomWrite(r.way_id); n += 1; }
    return n;
  }

  /**
   * 批量取物化几何：`Map(wayId → { ids, coords, hasTags })`（只含真的有这一列的 way；
   * 没有的调用方按 miss 退回 SQL —— 于是"回填还没到的老库"也永远是对的画面）。
   */
  _wayGeomBatch(wayIds) {
    const out = new Map();
    if (!this._wayGeom.on || !this._wayGeomReady || !wayIds.length) return out;
    const stmt = this._cachedStmt('SELECT id, geom FROM ways WHERE id IN (SELECT value FROM json_each(?)) AND geom IS NOT NULL');
    for (let i = 0; i < wayIds.length; i += 400) {
      const chunk = wayIds.slice(i, i + 400);
      for (const r of stmt.all(JSON.stringify(chunk))) {
        const g = unpackWayGeom(r.geom);
        if (g) out.set(r.id, g);
      }
    }
    return out;
  }

  /* ------------------------------ 元素读取 ------------------------------ */
  getNode(id) {
    const row = this._st.nodeById.get(id);
    if (!row) return null;
    return { type: 'node', id: row.id, lat: row.lat, lon: row.lon, version: row.version, tags: parseTags(row.tags), deleted: !!row.deleted, editorName: row.editor_name, ts: row.ts };
  }

  getWay(id) {
    const row = this._st.wayById.get(id);
    if (!row) return null;
    return {
      type: 'way', id: row.id, version: row.version, tags: parseTags(row.tags), deleted: !!row.deleted,
      nodes: this._st.wayNodeIds.all(id).map((r) => r.node_id),
      closed: !!row.closed, length: row.length, editorName: row.editor_name, ts: row.ts,
    };
  }

  getRelation(id) {
    const row = this._st.relationById.get(id);
    if (!row) return null;
    return {
      type: 'relation', id: row.id, version: row.version, tags: parseTags(row.tags), deleted: !!row.deleted,
      members: this._st.relationMembers.all(id).map((m) => ({ type: m.member_type, ref: m.member_ref, role: m.role || '' })),
      editorName: row.editor_name, ts: row.ts,
    };
  }

  getElement(type, id) {
    if (type === 'node') return this.getNode(id);
    if (type === 'way') return this.getWay(id);
    if (type === 'relation') return this.getRelation(id);
    return null;
  }

  /** 完整几何（含所有节点坐标），用于导出与渲染高亮 */
  geometry(type, id) {
    const el = this.getElement(type, id);
    if (!el) return null;
    if (type === 'node') return { ...el, coords: [[el.lat, el.lon]] };
    if (type === 'way') {
      const coords = [];
      for (const nid of el.nodes) {
        const n = this._st.nodeById.get(nid);
        if (n && !n.deleted) coords.push([n.lat, n.lon]);
      }
      return { ...el, coords };
    }
    const members = [];
    for (const m of el.members) {
      const geo = this.geometry(m.type, m.ref);
      if (geo) members.push({ ...m, coords: geo.coords });
    }
    return { ...el, members };
  }

  nodeTopology(nodeId) {
    const ways = this._st.wayRefsForNode.all(nodeId).map((r) => r.way_id).filter((id) => {
      const w = this._st.wayById.get(id);
      return w && !w.deleted;
    });
    const rels = this._st.relRefs.all('node', nodeId).map((r) => r.relation_id);
    return { ways, relations: rels };
  }

  relationsFor(type, id) {
    return this._st.relRefs.all(type, id).map((r) => r.relation_id).filter((rid) => {
      const rel = this._st.relationById.get(rid);
      return rel && !rel.deleted;
    });
  }

  /* ------------------------------ 视口统计 ------------------------------ */
  /**
   * 视口统计：视野内有多少建筑 / 道路 / 水系 / 用地 / 铁路，以及多少个 POI 节点。
   *
   * ⚠ `/api/map` **默认不再调用它**（`payload.stats` 默认整个字段不出现）：它只给工具/排查看，
   *   客户端渲染不需要（图层面板的条数是本地数出来的 `World.categoryCounts`），而它在这一档
   *   要花 z10 ≈ 0.49 s / z13 ≈ 0.4 s。要它：请求带 `&stats=1`，或配 `limits.viewportStats: true`
   *   （见 server/index.js 的 /api/map）。方法本身留着 —— 探针与工具仍然直接用它。
   *   同样地，/api/map 里那份"给全了没有"的条数账（truncation / payload / coalesce / viewOnly）
   *   与这个统计**无关**，照旧全量下发。
   *
   * 语义与"逐行 JSON.parse 再数标签"完全一致（都是数"有没有这个键"）：
   *   · 用 SQL 的 `tags LIKE '%"key":%'` 直接数，**不把标签文本搬进 JS、也不 JSON.parse**
   *     —— 真实数据集 z13 上从 ~750 ms 降到 ~370 ms（要点是别把 13 万条标签串
   *     都物化成 JS 字符串）；
   *   · `"key":` 里的冒号很重要：它保证 `"building:levels"` 不会被算成 building
   *     （与 JS 版读 `tags.building` 的口径一致）；
   *   · 唯一可能与 JS 版不同的地方：某个标签的**值**里正好含 `"building":` 这种子串
   *     （JSON 转义后的引号）—— 实际数据里不存在，可忽略。
   * POI 数 = 视口内的 **POI 候选**数（低缩放时是"这一档看得见的 POI"：地名 / 山峰 / 泉 / 洞口；
   * z ≥ 16 时仍是"带标签节点"的总数）—— 直接复用 queryBbox 候选账本里的同一个数，
   * 所以接受一个 hint（queryBbox 的 totals）直接复用，省掉一次全视口节点扫描
   * （z13 实测省 200~800 ms；这一条 COUNT 在没有部分索引时要扫 188 万个节点）。
   * ⚠ 低缩放那一档的数**不再是"所有带标签节点"**（以前把 10 万个门牌号也算成 POI）：
   *   见 osmdb.js 的 _nodePoiPlan；条数账（visible/returned/dropped/complete）不受影响。
   */
  visibleStats({ minLon, minLat, maxLon, maxLat }, hint = null) {
    const args = [minLon, maxLon, minLat, maxLat];   // R*Tree 参数顺序 (minLon, maxLon, minLat, maxLat)
    const row = this._cachedStmt(`SELECT
        SUM(w.tags LIKE '%"building":%') AS buildings,
        SUM(w.tags LIKE '%"highway":%') AS highways,
        SUM(w.tags LIKE '%"waterway":%' OR w.tags LIKE '%"natural":"water"%') AS waterways,
        SUM(w.tags LIKE '%"landuse":%' OR w.tags LIKE '%"leisure":%' OR w.tags LIKE '%"natural":%') AS landuse,
        SUM(w.tags LIKE '%"railway":%') AS railways
      FROM way_index i JOIN ways w ON w.id = i.id
      WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND w.deleted = 0`).get(...args);
    const stats = {
      buildings: Number(row.buildings) || 0,
      highways: Number(row.highways) || 0,
      waterways: Number(row.waterways) || 0,
      landuse: Number(row.landuse) || 0,
      railways: Number(row.railways) || 0,
      pois: 0,
    };
    // POI：优先用 queryBbox 已经数出来的总数；没有 hint（或 hint 里这个数是 null = 数不出来）时才自己查一次
    const hintPois = hint && hint.nodes != null ? Number(hint.nodes) : NaN;
    if (Number.isFinite(hintPois) && hintPois >= 0) {
      stats.pois = hintPois;
      stats.poisFromHint = true;
    } else {
      const nodeHint = this._nodeScanHint(minLon, maxLon);
      stats.pois = this._cachedStmt(`SELECT COUNT(*) AS c
        FROM node_index i JOIN nodes n${nodeHint} ON n.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND n.deleted = 0
          AND n.tags IS NOT NULL`).get(...args).c;
    }
    return stats;
  }

  /* ------------------------------ 写操作原语 ------------------------------ */
  _now() { return Date.now(); }

  insertNode({ lat, lon, tags }, user) {
    const id = this.ids.alloc('node');
    const ts = this._now();
    this._st.insertNode.run(id, lat, lon, 1, stringifyTags(tags), user.id, user.name, ts, 0);
    this._st.upsertNodeIndex.run(id, lon, lon, lat, lat);
    this.invalidateCounts();
    return this.getNode(id);
  }

  updateNode(id, { lat, lon, tags, version }, user) {
    const cur = this.getNode(id);
    if (!cur) return null;
    this._st.updateNode.run(lat, lon, version, stringifyTags(tags), user.id, user.name, this._now(), 0, id);
    this._st.upsertNodeIndex.run(id, lon, lon, lat, lat);
    // 引用它的 way 需要重算 bbox
    for (const wayId of this._st.wayRefsForNode.all(id).map((r) => r.way_id)) this.recomputeWayGeometry(wayId);
    return this.getNode(id);
  }

  markNodeDeleted(id, user) {
    const cur = this.getNode(id);
    if (!cur) return null;
    this._st.updateNode.run(cur.lat, cur.lon, cur.version + 1, this._st.nodeById.get(id).tags, user.id, user.name, this._now(), 1, id);
    this._st.deleteNodeIndex.run(id);
    this.invalidateCounts();
    /**
     * 删节点会让引用它的 way 少一个顶点：`recomputeWayGeometry` **不会**被这条路径调用
     * （它只由 updateNode 触发），所以这里自己把那些 way 的 bbox 标脏 —— 几何只会**变小**，
     * 于是"按旧 bbox 标脏"就覆盖了新旧两边（新 bbox ⊆ 旧 bbox）。
     */
    if (this._dlod.on) {
      for (const wid of this._st.wayRefsForNode.all(id).map((r) => r.way_id)) {
        const w = this._st.wayById.get(wid);
        if (!w || w.min_lon === null || w.min_lon === undefined) continue;
        this._dlodDirtyWay({ minLon: w.min_lon, maxLon: w.max_lon, minLat: w.min_lat, maxLat: w.max_lat }, null,
          wayLodZoomOf(parseTags(w.tags)));
      }
    }
    /**
     * **删节点也要重写物化几何**（用 `idx_way_nodes_node` 找出含它的 way）：被删的节点
     * 在 `_fetchNodes` 里是不存在的（`deleted = 0`），所以它的坐标必须从物化几何里消失，
     * 但 **id 要留着**（`way_nodes` 的行没动，`ways[id][1]` 照旧带着它）—— 这两件事分开处理，
     * 才与"从 way_nodes + nodes 两次读表"的口径逐字节一致。
     */
    this._wayGeomRefreshForNode(id);
    return { ...cur, version: cur.version + 1, deleted: true };
  }

  insertWay({ nodes, tags }, user) {
    const id = this.ids.alloc('way');
    const ts = this._now();
    const closed = nodes.length > 2 && nodes[0] === nodes[nodes.length - 1] ? 1 : 0;
    const json = stringifyTags(tags);
    const keys = wayLodKeysOf(json);         // 物化列（低缩放候选索引用）
    this._st.insertWay.run(id, 1, json, user.id, user.name, ts, 0, nodes.length, closed, keys.roadClass, keys.lodZoom);
    nodes.forEach((nid, seq) => this._st.insertWayNode.run(id, seq, nid));
    this.recomputeWayGeometry(id);
    this.recomputeRelationsOfWay(id);
    this.invalidateCounts();
    return this.getWay(id);
  }

  updateWayGeometry(id, nodes) {
    this._st.deleteWayNodes.run(id);
    nodes.forEach((nid, seq) => this._st.insertWayNode.run(id, seq, nid));
    this.recomputeWayGeometry(id);
    this.recomputeRelationsOfWay(id);
  }

  markWayDeleted(id, user) {
    const cur = this.getWay(id);
    if (!cur) return null;
    // 旧 bbox 从 `_st.wayById` 取（`getWay` 不回 bbox 列）；下面 deleteWayIndex 之后就没得取了
    const raw = this._st.wayById.get(id);
    const oldBox = (raw && raw.min_lon !== null && raw.min_lon !== undefined)
      ? { minLon: raw.min_lon, maxLon: raw.max_lon, minLat: raw.min_lat, maxLat: raw.max_lat } : null;
    const json = stringifyTags(cur.tags);
    const keys = wayLodKeysOf(json);
    this._st.updateWay.run(cur.version + 1, json, user.id, user.name, this._now(), 1, 0, 0, keys.roadClass, keys.lodZoom, id);
    this._st.deleteWayIndex.run(id);
    this._st.deleteWayNodes.run(id);
    this.recomputeRelationsOfWay(id);
    this.invalidateCounts();
    this._dlodDirtyWay(oldBox, null, keys.lodZoom);
    this._cachedStmt('UPDATE ways SET geom = NULL WHERE id = ?').run(id);   // 删掉的 way 不留物化几何
    return { ...cur, version: cur.version + 1, deleted: true };
  }

  updateWayTags(id, { version, tags, nodes }, user) {
    const cur = this.getWay(id);
    if (!cur) return null;
    const finalNodes = nodes || cur.nodes;
    const closed = finalNodes.length > 2 && finalNodes[0] === finalNodes[finalNodes.length - 1] ? 1 : 0;
    const json = stringifyTags(tags);
    const keys = wayLodKeysOf(json);         // 改了标签就同步改 road_class / lod_zoom
    this._st.updateWay.run(version, json, user.id, user.name, this._now(), 0, finalNodes.length, closed, keys.roadClass, keys.lodZoom, id);
    if (nodes) {
      this._st.deleteWayNodes.run(id);
      nodes.forEach((nid, seq) => this._st.insertWayNode.run(id, seq, nid));
    }
    this.recomputeWayGeometry(id);
    if (nodes) this.recomputeRelationsOfWay(id);
    return this.getWay(id);
  }

  insertRelation({ members, tags }, user) {
    const id = this.ids.alloc('relation');
    this._st.insertRelation.run(id, 1, stringifyTags(tags), user.id, user.name, this._now(), 0, members.length);
    members.forEach((m, seq) => this._st.insertRelMember.run(id, seq, m.type, m.ref, m.role || ''));
    this.recomputeRelationBbox(id);
    this.recomputeRelationMembers(id);
    this.invalidateCounts();
    this._dlodDirtyRelation(this._dlodRelBox(id));
    return this.getRelation(id);
  }

  updateRelation(id, { version, members, tags }, user) {
    const cur = this.getRelation(id);
    if (!cur) return null;
    const finalMembers = members || cur.members;
    const oldBox = this._dlodRelBox(id);      // 改之前的范围（下面 deleteRelMembers 之后就没得取了）
    this._st.updateRelation.run(version, stringifyTags(tags), user.id, user.name, this._now(), 0, finalMembers.length, id);
    if (members) {
      this._st.deleteRelMembers.run(id);
      members.forEach((m, seq) => this._st.insertRelMember.run(id, seq, m.type, m.ref, m.role || ''));
      this.recomputeRelationBbox(id);
      this.recomputeRelationMembers(id);
    }
    const newBox = this._dlodRelBox(id);
    this._dlodDirtyRelation(oldBox);
    this._dlodDirtyRelation(newBox);
    return this.getRelation(id);
  }

  markRelationDeleted(id, user) {
    const cur = this.getRelation(id);
    if (!cur) return null;
    const oldBox = this._dlodRelBox(id);
    this._st.updateRelation.run(cur.version + 1, stringifyTags(cur.tags), user.id, user.name, this._now(), 1, 0, id);
    this._st.deleteRelIndex.run(id);
    this._st.deleteRelMembers.run(id);
    this.invalidateCounts();
    this._dlodDirtyRelation(oldBox);
    return { ...cur, version: cur.version + 1, deleted: true };
  }

  /** 关系在 `relation_index` 里的 bbox（面关系的失效范围用它）；没有就是 null */
  _dlodRelBox(id) {
    try {
      const r = this.db.prepare('SELECT min_lon, max_lon, min_lat, max_lat FROM relation_index WHERE id = ?').get(id);
      if (!r) return null;
      return { minLon: r.min_lon, maxLon: r.max_lon, minLat: r.min_lat, maxLat: r.max_lat };
    } catch { return null; }
  }

  /** 重算 way 的 bbox / 长度 / 节点数 / 闭合标记，并更新空间索引 */
  recomputeWayGeometry(wayId) {
    const row = this._st.wayById.get(wayId);
    /**
     * **预计算层的失效钩子**（见 displaylod.js 的「失效」一段）：几何/标签一变，这条 way
     * 新旧 bbox 压到的瓦片就要重算。放在这里是因为**所有**改 way 的写路径最后都走它
     * （insertWay / updateWayGeometry / updateWayTags / updateNode→wayRefsForNode）。
     * `row` 里的 bbox 是**改之前**的值（setWayGeom 还没跑），新 bbox 稍后算出来 → 两边一起标。
     */
    const oldBox = (row && row.min_lon !== null && row.min_lon !== undefined)
      ? { minLon: row.min_lon, maxLon: row.max_lon, minLat: row.min_lat, maxLat: row.max_lat } : null;
    const lodZoom = row ? wayLodZoomOf(parseTags(row.tags)) : 0;
    if (!row || row.deleted) { this._st.deleteWayIndex.run(wayId); this._dlodDirtyWay(oldBox, null, lodZoom); return; }
    const ids = this._st.wayNodeIds.all(wayId).map((r) => r.node_id);
    if (!ids.length) { this._st.deleteWayIndex.run(wayId); this._dlodDirtyWay(oldBox, null, lodZoom); return; }
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let length = 0;
    let prev = null;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT id, lat, lon FROM nodes WHERE id IN (${placeholders})`).all(...ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const n = byId.get(id);
      if (!n) continue;
      if (n.lat < minLat) minLat = n.lat;
      if (n.lat > maxLat) maxLat = n.lat;
      if (n.lon < minLon) minLon = n.lon;
      if (n.lon > maxLon) maxLon = n.lon;
      if (prev) length += metersBetween(prev.lat, prev.lon, n.lat, n.lon);
      prev = n;
    }
    if (!Number.isFinite(minLat)) { this._st.deleteWayIndex.run(wayId); this._dlodDirtyWay(oldBox, null, lodZoom); return; }
    const closed = ids.length > 2 && ids[0] === ids[ids.length - 1] ? 1 : 0;
    this._st.setWayGeom.run(minLat, maxLat, minLon, maxLon, Math.round(length * 10) / 10, ids.length, closed, wayId);
    this._st.upsertWayIndex.run(wayId, minLon, maxLon, minLat, maxLat);
    /**
     * **物化几何在同一处重写**（`ids` 与节点坐标刚刚都读过了，这里不多花一次 I/O）。
     * 于是"移动一个节点 → 立刻请求"拿到的就是新几何：见 `tests/way-geom-test.js`。
     */
    this._wayGeomWrite(wayId);
    this._dlodDirtyWay(oldBox, { minLon, maxLon, minLat, maxLat }, lodZoom);
  }

  /**
   * 预计算层的写路径钩子（**见 displaylod.js 的「失效」一段**）：
   * 一条 way 的**新旧 bbox 并集**压到的瓦片，在"这条 way 真的可见的那些档"上标脏。
   *   · 为什么要并集：way 的 bbox 可能变大（拖了一个节点到远处）也可能变小（删了一段），
   *     而旧几何在旧瓦片上、新几何可能在新瓦片上，两边都得重算；
   *   · 为什么按 lod_zoom 收窄档位：`lod_zoom` 就是"这条 way 最早在哪个缩放可见"的物化列
   *     （见 wayLodKeysOf），它**之后**的档才画得出这条 way。实测一条 residential（lod_zoom=14）
   *     只需要重算 z14 那一档，而不是七个档一起（logs/pc-invalidate.txt）。
   */
  _dlodDirtyWay(oldBox, newBox, lodZoom) {
    if (!this._dlod.on) return;
    const a = oldBox && Number.isFinite(oldBox.minLon) ? oldBox : null;
    const b = newBox && Number.isFinite(newBox.minLon) ? newBox : null;
    if (!a && !b) return;
    const box = (!a || !b) ? (a || b) : {
      minLon: Math.min(a.minLon, b.minLon), maxLon: Math.max(a.maxLon, b.maxLon),
      minLat: Math.min(a.minLat, b.minLat), maxLat: Math.max(a.maxLat, b.maxLat),
    };
    const bands = this._dlod.bands;
    this.dlodMarkDirty(box, Math.floor(Number(lodZoom) || 0), bands[bands.length - 1] || 14);
  }

  /** 关系变了（新增/成员变化/删除）：它的面几何会变 → 按它自己的 bbox 标脏（与 way 同一口径） */
  _dlodDirtyRelation(box, lodZoom = 0) {
    if (!this._dlod.on) return;
    if (!box || !Number.isFinite(box.minLon)) return;
    const bands = this._dlod.bands;
    this.dlodMarkDirty(box, Math.floor(Number(lodZoom) || 0), bands[bands.length - 1] || 14);
  }

  recomputeRelationsOfWay(wayId) {
    for (const rid of this._st.relRefs.all('way', wayId).map((r) => r.relation_id)) this.recomputeRelationBbox(rid);
  }

  recomputeRelationBbox(relId) {
    const row = this._st.relationById.get(relId);
    if (!row || row.deleted) { this._st.deleteRelIndex.run(relId); return; }
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const m of this._st.relationMembers.all(relId)) {
      if (m.member_type === 'way') {
        const w = this._st.wayById.get(m.member_ref);
        if (w && !w.deleted && w.min_lat !== null) {
          minLat = Math.min(minLat, w.min_lat);
          maxLat = Math.max(maxLat, w.max_lat);
          minLon = Math.min(minLon, w.min_lon);
          maxLon = Math.max(maxLon, w.max_lon);
        }
      } else if (m.member_type === 'node') {
        const n = this._st.nodeById.get(m.member_ref);
        if (n && !n.deleted) {
          minLat = Math.min(minLat, n.lat);
          maxLat = Math.max(maxLat, n.lat);
          minLon = Math.min(minLon, n.lon);
          maxLon = Math.max(maxLon, n.lon);
        }
      }
    }
    if (!Number.isFinite(minLat)) { this._st.deleteRelIndex.run(relId); return; }
    this._st.upsertRelIndex.run(relId, minLon, maxLon, minLat, maxLat);
  }

  /** way 的节点顺序变化后，父 relation 的成员顺序可能失效，这里只校正 member_count */
  recomputeRelationMembers(relId) {
    const count = this._st.relationMembers.all(relId).length;
    this.db.prepare('UPDATE relations SET member_count = ? WHERE id = ?').run(count, relId);
  }

  /** 找出这些节点里哪些是"孤立节点"（无标签、不被任何 way/relation 引用） */
  orphanNodes(nodeIds) {
    const out = [];
    const stmt = this.db.prepare(`
      SELECT n.id FROM nodes n
      WHERE n.id = ? AND n.deleted = 0 AND (n.tags IS NULL OR n.tags = '')
        AND NOT EXISTS (SELECT 1 FROM way_nodes wn WHERE wn.node_id = n.id)
        AND NOT EXISTS (SELECT 1 FROM relation_members rm WHERE rm.member_type = 'node' AND rm.member_ref = n.id)`);
    for (const id of nodeIds) if (stmt.get(id)) out.push(id);
    return out;
  }

  /* ------------------------------ 变更日志 ------------------------------ */
  beginChangeset(user, comment) {
    const res = this._st.insertChangeset.run(user.id, user.name, comment || '', Date.now());
    return Number(res.lastInsertRowid);
  }

  logChange(changesetId, type, id, action, before, after, user) {
    this._st.insertChange.run(changesetId, type, id, action,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      Date.now(), user ? user.id : null, user ? user.name : null);
    if (changesetId) this._st.bumpChangeset.run(changesetId);
  }

  recentChanges(limit = 100) {
    return this.db.prepare(`
      SELECT c.id, c.changeset_id, c.elem_type, c.elem_id, c.action, c.ts, c.author_name, c.undone,
             json_extract(c.after_json, '$.tags.name') AS name
      FROM changes c ORDER BY c.id DESC LIMIT ?`).all(limit);
  }

  recentChangesets(limit = 50) {
    return this.db.prepare(`
      SELECT id, author, author_name, comment, ts, op_count, reverted FROM changesets ORDER BY id DESC LIMIT ?`).all(limit);
  }

  changesOfChangeset(changesetId) {
    return this.db.prepare('SELECT * FROM changes WHERE changeset_id = ? ORDER BY id DESC').all(changesetId);
  }

  getChangeset(changesetId) {
    return this.db.prepare('SELECT id, author, author_name, comment, ts, op_count, reverted FROM changesets WHERE id = ?').get(changesetId) || null;
  }

  elementHistory(type, id, limit = 50) {
    return this.db.prepare(`
      SELECT id, changeset_id, action, ts, author_name, undone FROM changes
      WHERE elem_type = ? AND elem_id = ? ORDER BY id DESC LIMIT ?`).all(type, id, limit);
  }

  markChangesetReverted(changesetId) {
    this.db.prepare('UPDATE changesets SET reverted = 1 WHERE id = ?').run(changesetId);
    this.db.prepare('UPDATE changes SET undone = 1 WHERE changeset_id = ?').run(changesetId);
  }

  getChange(changeId) {
    return this.db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId);
  }

  /* ------------------------------ 搜索 ------------------------------ */
  search({ name, key, value, limit = 100, bbox = null }) {
    const results = [];
    const like = (s) => '%' + String(s).replace(/[%_]/g, '') + '%';

    if (name) {
      const rows = this.db.prepare(`
        SELECT id, tags, 'way' AS t FROM ways WHERE deleted = 0 AND (json_extract(tags,'$.name') LIKE ? OR json_extract(tags,'$.name:zh') LIKE ? OR json_extract(tags,'$.ref') LIKE ?) LIMIT ?
      `).all(like(name), like(name), like(name), limit);
      for (const r of rows) results.push({ type: 'way', id: r.id, tags: parseTags(r.tags) });
      const nrows = this.db.prepare(`
        SELECT id, tags FROM nodes WHERE deleted = 0 AND (json_extract(tags,'$.name') LIKE ? OR json_extract(tags,'$.name:zh') LIKE ?) LIMIT ?
      `).all(like(name), like(name), limit);
      for (const r of nrows) results.push({ type: 'node', id: r.id, tags: parseTags(r.tags) });
      const rrows = this.db.prepare(`
        SELECT id, tags FROM relations WHERE deleted = 0 AND (json_extract(tags,'$.name') LIKE ? OR json_extract(tags,'$.name:zh') LIKE ?) LIMIT ?
      `).all(like(name), like(name), limit);
      for (const r of rrows) results.push({ type: 'relation', id: r.id, tags: parseTags(r.tags) });
    } else if (key && value) {
      const needle = `%"${key}":"${value}"%`;
      const rows = this.db.prepare("SELECT id, tags FROM ways WHERE deleted = 0 AND tags LIKE ? LIMIT ?").all(needle, limit);
      for (const r of rows) results.push({ type: 'way', id: r.id, tags: parseTags(r.tags) });
      const nrows = this.db.prepare("SELECT id, tags FROM nodes WHERE deleted = 0 AND tags LIKE ? LIMIT ?").all(needle, limit);
      for (const r of nrows) results.push({ type: 'node', id: r.id, tags: parseTags(r.tags) });
    } else if (key) {
      const needle = `%"${key}":%`;
      const rows = this.db.prepare("SELECT id, tags FROM ways WHERE deleted = 0 AND tags LIKE ? LIMIT ?").all(needle, limit);
      for (const r of rows) results.push({ type: 'way', id: r.id, tags: parseTags(r.tags) });
    }

    // 附带中心点，方便客户端跳转
    return results.slice(0, limit).map((r) => {
      const geo = this.geometry(r.type, r.id);
      const coords = geo && geo.coords && geo.coords.length ? geo.coords : null;
      let center = null;
      if (coords) {
        const mid = coords[Math.floor(coords.length / 2)];
        center = { lat: mid[0], lon: mid[1] };
      }
      return { ...r, center };
    });
  }

  tagStats(limit = 60) {
    return this.db.prepare(`
      SELECT key, COUNT(*) AS c FROM (
        SELECT DISTINCT w.id AS id, j.key AS key FROM ways w, json_each(w.tags) j WHERE w.deleted = 0
      ) GROUP BY key ORDER BY c DESC LIMIT ?`).all(limit);
  }

  /* ------------------------------ 导出 ------------------------------ */
  exportOsm({ bbox = null, limit = 500000 } = {}) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const lines = [];
    const now = new Date().toISOString();
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<osm version="0.6" generator="osm-city-online">');

    const inBbox = (lat, lon) => !bbox || (lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon);

    let nodes = [];
    let ways = [];
    if (bbox) {
      nodes = this.db.prepare(`
        SELECT n.id, n.lat, n.lon, n.version, n.tags FROM node_index i JOIN nodes n ON n.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND n.deleted = 0 LIMIT ?`)
        .all(bbox.minLon, bbox.maxLon, bbox.minLat, bbox.maxLat, limit);
      ways = this.db.prepare(`
        SELECT w.id, w.version, w.tags FROM way_index i JOIN ways w ON w.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND w.deleted = 0 LIMIT ?`)
        .all(bbox.minLon, bbox.maxLon, bbox.minLat, bbox.maxLat, limit);
    } else {
      nodes = this.db.prepare('SELECT id, lat, lon, version, tags FROM nodes WHERE deleted = 0 LIMIT ?').all(limit);
      ways = this.db.prepare('SELECT id, version, tags FROM ways WHERE deleted = 0 LIMIT ?').all(limit);
    }

    const wayIds = ways.map((w) => w.id);
    const neededNodes = new Set(nodes.map((n) => n.id));
    const wayNodeMap = new Map();
    for (let i = 0; i < wayIds.length; i += 400) {
      const chunk = wayIds.slice(i, i + 400);
      if (!chunk.length) continue;
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT way_id, node_id FROM way_nodes WHERE way_id IN (${ph}) ORDER BY way_id, seq`).all(...chunk);
      for (const r of rows) {
        if (!wayNodeMap.has(r.way_id)) wayNodeMap.set(r.way_id, []);
        wayNodeMap.get(r.way_id).push(r.node_id);
        neededNodes.add(r.node_id);
      }
    }
    const extra = [...neededNodes].filter((id) => !nodes.some((n) => n.id === id));
    const allNodeRows = [];
    for (let i = 0; i < extra.length; i += 400) {
      const chunk = extra.slice(i, i + 400);
      const ph = chunk.map(() => '?').join(',');
      allNodeRows.push(...this.db.prepare(`SELECT id, lat, lon, version, tags FROM nodes WHERE deleted = 0 AND id IN (${ph})`).all(...chunk));
    }
    const nodeRowMap = new Map([...nodes, ...allNodeRows].map((n) => [n.id, n]));

    lines.push(`  <bounds minlat="${bbox ? bbox.minLat : -85}" minlon="${bbox ? bbox.minLon : -180}" maxlat="${bbox ? bbox.maxLat : 85}" maxlon="${bbox ? bbox.maxLon : 180}"/>`);
    for (const n of nodeRowMap.values()) {
      if (!inBbox(n.lat, n.lon) && bbox) continue;
      const tags = parseTags(n.tags);
      if (tags) {
        lines.push(`  <node id="${n.id}" lat="${n.lat}" lon="${n.lon}" version="${n.version}" timestamp="${now}">`);
        for (const [k, v] of Object.entries(tags)) lines.push(`    <tag k="${esc(k)}" v="${esc(v)}"/>`);
        lines.push('  </node>');
      } else {
        lines.push(`  <node id="${n.id}" lat="${n.lat}" lon="${n.lon}" version="${n.version}" timestamp="${now}"/>`);
      }
    }
    for (const w of ways) {
      const ids = wayNodeMap.get(w.id) || [];
      if (!ids.length) continue;
      lines.push(`  <way id="${w.id}" version="${w.version}" timestamp="${now}">`);
      for (const nid of ids) lines.push(`    <nd ref="${nid}"/>`);
      const tags = parseTags(w.tags);
      if (tags) for (const [k, v] of Object.entries(tags)) lines.push(`    <tag k="${esc(k)}" v="${esc(v)}"/>`);
      lines.push('  </way>');
    }
    const rels = this.db.prepare('SELECT id, version, tags FROM relations WHERE deleted = 0 LIMIT ?').all(limit);
    for (const r of rels) {
      lines.push(`  <relation id="${r.id}" version="${r.version}" timestamp="${now}">`);
      for (const m of this._st.relationMembers.all(r.id)) lines.push(`    <member type="${m.member_type}" ref="${m.member_ref}" role="${esc(m.role || '')}"/>`);
      const tags = parseTags(r.tags);
      if (tags) for (const [k, v] of Object.entries(tags)) lines.push(`    <tag k="${k}" v="${esc(v)}"/>`);
      lines.push('  </relation>');
    }
    lines.push('</osm>');
    return lines.join('\n');
  }

  exportOsmChange(changesetId) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const changes = this.changesOfChangeset(changesetId);
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<osmChange version="0.6" generator="osm-city-online">'];
    const byAction = { create: [], modify: [], delete: [] };
    for (const c of changes) {
      if (c.undone) continue;
      (byAction[c.action] || byAction.modify).push(c);
    }
    for (const action of ['create', 'modify', 'delete']) {
      if (!byAction[action].length) continue;
      lines.push(`  <${action}>`);
      for (const c of byAction[action]) {
        const snap = JSON.parse(c.after_json || c.before_json || 'null');
        if (!snap) continue;
        if (c.elem_type === 'node') {
          lines.push(`    <node id="${snap.id}" lat="${snap.lat}" lon="${snap.lon}" version="${snap.version || 1}">`);
          for (const [k, v] of Object.entries(snap.tags || {})) lines.push(`      <tag k="${esc(k)}" v="${esc(v)}"/>`);
          lines.push('    </node>');
        } else if (c.elem_type === 'way') {
          lines.push(`    <way id="${snap.id}" version="${snap.version || 1}">`);
          for (const nid of snap.nodes || []) lines.push(`      <nd ref="${nid}"/>`);
          for (const [k, v] of Object.entries(snap.tags || {})) lines.push(`      <tag k="${esc(k)}" v="${esc(v)}"/>`);
          lines.push('    </way>');
        }
      }
      lines.push(`  </${action}>`);
    }
    lines.push('</osmChange>');
    return lines.join('\n');
  }
  /* ------------------------------ 恢复/回滚原语 ------------------------------ */
  restoreNode(snap, user) {
    const exists = this._st.nodeById.get(snap.id);
    const version = (exists ? exists.version : 0) + 1;
    if (exists) {
      this._st.updateNode.run(snap.lat, snap.lon, version, stringifyTags(snap.tags), user.id, user.name, this._now(), 0, snap.id);
    } else {
      this._st.insertNode.run(snap.id, snap.lat, snap.lon, version, stringifyTags(snap.tags), user.id, user.name, this._now(), 0);
    }
    this._st.upsertNodeIndex.run(snap.id, snap.lon, snap.lon, snap.lat, snap.lat);
    for (const wid of this._st.wayRefsForNode.all(snap.id).map((r) => r.way_id)) this.recomputeWayGeometry(wid);
    this.invalidateCounts();
    return this.getNode(snap.id);
  }

  restoreWay(snap, user) {
    const exists = this._st.wayById.get(snap.id);
    const version = (exists ? exists.version : 0) + 1;
    const json = stringifyTags(snap.tags);
    const keys = wayLodKeysOf(json);
    if (exists) {
      this._st.updateWay.run(version, json, user.id, user.name, this._now(), 0, snap.nodes.length, 0, keys.roadClass, keys.lodZoom, snap.id);
    } else {
      this._st.insertWay.run(snap.id, version, json, user.id, user.name, this._now(), 0, snap.nodes.length, 0, keys.roadClass, keys.lodZoom);
    }
    this._st.deleteWayNodes.run(snap.id);
    snap.nodes.forEach((nid, seq) => this._st.insertWayNode.run(snap.id, seq, nid));
    this.recomputeWayGeometry(snap.id);
    this.recomputeRelationsOfWay(snap.id);
    this.invalidateCounts();
    return this.getWay(snap.id);
  }

  restoreRelation(snap, user) {
    const exists = this._st.relationById.get(snap.id);
    const version = (exists ? exists.version : 0) + 1;
    if (exists) {
      this._st.updateRelation.run(version, stringifyTags(snap.tags), user.id, user.name, this._now(), 0, snap.members.length, snap.id);
    } else {
      this._st.insertRelation.run(snap.id, version, stringifyTags(snap.tags), user.id, user.name, this._now(), 0, snap.members.length);
    }
    this._st.deleteRelMembers.run(snap.id);
    snap.members.forEach((m, seq) => this._st.insertRelMember.run(snap.id, seq, m.type, m.ref, m.role || ''));
    this.recomputeRelationBbox(snap.id);
    this.recomputeRelationMembers(snap.id);
    this.invalidateCounts();
    return this.getRelation(snap.id);
  }

  /** 快照：供撤销/回滚精确还原（元素不存在或已删除时返回 null） */
  snapshot(type, id) {
    if (type === 'node') {
      const n = this.getNode(id);
      return n && !n.deleted ? { id: n.id, lat: n.lat, lon: n.lon, version: n.version, tags: n.tags } : null;
    }
    if (type === 'way') {
      const w = this.getWay(id);
      return w && !w.deleted ? { id: w.id, version: w.version, tags: w.tags, nodes: w.nodes.slice() } : null;
    }
    const r = this.getRelation(id);
    return r && !r.deleted ? { id: r.id, version: r.version, tags: r.tags, members: r.members.map((m) => ({ ...m })) } : null;
  }

  hardDelete(type, id, user) {
    if (type === 'node') return this.markNodeDeleted(id, user);
    if (type === 'way') return this.markWayDeleted(id, user);
    return this.markRelationDeleted(id, user);
  }
}

module.exports = {
  OsmDB, metersBetween, parseTags, stringifyTags, lodVisible, QUERY_CAPS,
  // 低缩放候选索引用到的派生值实现（dbschema.backfillWayLod / 启动抽检 / 写入维护共用同一份规则）
  wayLodKeysOf, wayLodZoomOf, WAY_LOD_INDEX_MAX_ZOOM,
  // 二进制矢量载荷（BIN v1，见文件开头「二进制矢量载荷」的格式说明）
  encodeBinaryPayload, packDisplayGeometry, displaySegmentsOf,
  BIN_VERSION, BIN_KIND, BIN_SECTION_ORDER, BIN_CONTENT_TYPE, BIN_ACCEPT_TOKEN,
  /**
   * 分区流式（server/regions.js）复用的两个内部件：
   *   packQueryResult —— queryBbox 的收尾打包段（**单一出处**：分片路径合并完也走它，
   *                     这样"合并后的载荷"与"单库直出的载荷"形状必然一致）
   *   coalesceOptsOf  —— 合并/视图载荷的规则规范化（分片路径要用它算"预算按片数摊薄"）
   *   packOptsOf      —— 紧凑载荷的规则规范化（同上，分片路径要判断 compact 开没开）
   */
  packQueryResult, coalesceOptsOf, packOptsOf,
};
