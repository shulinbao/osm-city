'use strict';
/**
 * OSM 数据访问层：视口查询、元素读写、空间索引维护、变更日志与导出。
 *
 * 所有几何都存 WGS84 经纬度；R*Tree 索引列顺序为 (id, min_lon, max_lon, min_lat, max_lat)。
 * 元素采用"软删除"（deleted=1）以便历史和回滚，视口查询会过滤掉。
 */
const fs = require('node:fs');
const {
  openDatabase, getMeta, setMeta, IdAllocator,
  backfillWayLod, ensureLodIndexes, WAY_LOD_INDEX, NODE_POI_INDEX, NODE_POI_LOW_PREDICATE,
} = require('./dbschema');

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
};
function packOptsOf(raw) {
  const o = Object.assign({}, PACK_DEFAULTS);
  if (raw === false) o.on = false;
  else if (raw && typeof raw === 'object') {
    if (raw.on === false) o.on = false;
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

class OsmDB {
  constructor(file, options = {}) {
    this.file = file;
    this.db = openDatabase(file);
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
    const wayLodFilled = backfillWayLod(this.db, wayLodKeysOf, { sample: options.wayLodSample }) === true;
    const lodIndexed = ensureLodIndexes(this.db) === true;
    this._wayLodReady = wayLodFilled && lodIndexed;
    /** 低缩放 POI 计划生效的最大缩放（见 _nodePoiPlan；config limits.nodePoiIndexMaxZoom） */
    const poiMax = Number(options.nodePoiIndexMaxZoom);
    this._nodePoiMaxZoom = Number.isFinite(poiMax) ? Math.max(0, Math.min(22, Math.floor(poiMax))) : NODE_POI_INDEX_MAX_ZOOM;
    this._nodePoiReady = this._hasIndex(NODE_POI_INDEX);
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
   *   displayLines: [{class, tags, coords:[lat0,lon0,dLat1,dLon1,…], paths:[…]}],  ← 折线坐标扁平差分
   *   enc: {v, nodeScale, lineScale, wayRefs:'delta', rule},    ← 解码说明书
   *   …其余字段（nodeTags / relations / truncation / totals / zoom）形状不变 }
   * 客户端在 `World.unpackPayload`（world.js）里按 `enc` 一次展开回上面那套老形状，
   * 所以 `World.mergePayload`、拾取、编辑、`completeness()` 全都看不到编码差异。
   * 关掉：`limits.compact = false`（那时就是上面那套老形状，一个字都不差）。
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
  queryBbox({ minLon, minLat, maxLon, maxLat, zoom = 16, limit = 12000, wayCandidates, nodeCandidates, relationLimit, relationCropPad, relationCropMinMembers, relationCropBoundaryMembers, detail, lodDetail, minFillArea, lodMinFillArea, roadSend, lodRoadSend, roadClassFloor, lodRoadClassFloor, neverSend, lodNeverSend, coalesce, lodCoalesce, compact, view }) {
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
    /** 紧凑载荷（见文件开头「紧凑载荷」一段）：坐标量化 + 列式/delta 编码，语义不变 */
    const pack = packOptsOf(compact);
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
    const wayScan = this._scanCandidates({
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

    const ways = {};
    const nodeIds = new Set();
    const picked = wayScan.values;
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
    const pickedIds = new Set(picked.map((p) => p.row.id));
    let noGeometry = 0;
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
     * 【低缩放视图载荷】非"面关系"的成员 way 也一起参与合并 —— 它们本来就是按**线**画的
     * （boundary 是虚线、route 成员是路径），合并掉的成员几何在 displayLines 里一条都没少。
     * 所以这里在定合并计划**之前**把成员 way 的行取出来（几何仍然只取一次，见下面的 coalesceGeom）。
     * 面关系的成员走另一条路（服务端接龙成环 → displayAreas），不在这里。
     */
    /**
     * **永不下载的类别**（树 / 自行车道）在成员路径上也要挡掉（见文件开头那一段）：
     * 不然一条 cycleway / tree_row 只要挂进某个关系就绕过了 way 扫描那道筛子。
     * 挡掉的是"几何一条不给"：既不下发、也不参与折线与面合并；单独记在 memberWaysNeverSent。
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
    const coalescePlan = this._coalesce(coalesceInput, coalesceGeom, {
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
    let areasPlan = null;
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
    this._fetchNodes([...nodeIds], nodes, nodeTags, zoom, lod.neverSendOn);
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
        areaCoalesced: areasPlan ? picked.filter((p) => areasPlan.covered.has(p.row.id)).length : 0,
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
        wayScan: wayPlan
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
      caps: {
        viewportLimit: caps.viewportLimit,
        wayCandidates: caps.wayCandidates, nodeCandidates: caps.nodeCandidates, relationLimit: caps.relationLimit,
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
    if (pack.on) {
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
      const lines = coalescePlan.lines;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        l.coords = packPathFlat(l.coords, lineScale);
        if (l.paths) for (let j = 0; j < l.paths.length; j++) l.paths[j] = packPathFlat(l.paths[j], lineScale);
      }
      // displayAreas（低缩放视图载荷的面几何）与折线同一套编码：每条环扁平差分 + 量化
      const areas = areasPlan ? areasPlan.entries : [];
      for (let i = 0; i < areas.length; i++) {
        const a = areas[i];
        a.coords = packPathFlat(a.coords, lineScale);
        if (a.paths) for (let j = 0; j < a.paths.length; j++) a.paths[j] = packPathFlat(a.paths[j], lineScale);
      }
      return {
        nodePack: packNodesColumnar(nodes, nodeScale), nodeTags, ways, relations,
        truncated: !complete, truncation, totals, zoom,
        viewOnly: !!viewOnly,
        enc: {
          v: 1,
          nodeScale,                 // 坐标 = 整数 / nodeScale
          lineScale,                 // 折线坐标 = 整数 / lineScale
          wayRefs: 'delta',          // ways[id][1] 是"每条 way 内 delta"的节点 id
          rule: 'nodes 换成列式 delta 三列 nodePack{ids,lat,lon}；ways[id][1] 与 displayLines / displayAreas 的坐标'
            + '都是差分（首值绝对）；坐标量化到 1/nodeScale。客户端 World.unpackPayload 展开回老形状。',
        },
        ...(lines.length ? { displayLines: lines } : {}),
        ...(areas.length ? { displayAreas: areas } : {}),
      };
    }
    return {
      nodes, nodeTags, ways, relations, truncated: !complete, truncation, totals, zoom,
      viewOnly: !!viewOnly,
      // 低缩放合并折线（视图用：只有几何，没有 way id）。没有合并时整个字段不出现，
      // 客户端拿 `payload.displayLines` 是否存在就能判断"这一档是不是只读视图"。
      ...(coalescePlan.lines.length ? { displayLines: coalescePlan.lines } : {}),
      // 低缩放的面几何（视图用：量化 + 简化过的环，同样没有 way id，见「低缩放视图载荷」）
      ...(areasPlan && areasPlan.entries.length ? { displayAreas: areasPlan.entries } : {}),
    };
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
    const ranked = [...byClass.entries()].sort((a, b) => b[1].length - a[1].length);
    const chosen = new Set();
    for (const [cls, list] of ranked) {
      if (coalesceAlways(cls) || list.length >= opts.minClassWays) chosen.add(cls);
    }
    const budget = Math.max(1, Math.floor(limit * opts.budget));
    let coalescedCount = 0;
    for (const cls of chosen) coalescedCount += byClass.get(cls).length;
    if (picked.length - coalescedCount > budget) {
      for (const [cls, list] of ranked) {
        if (picked.length - coalescedCount <= budget) break;
        if (chosen.has(cls)) continue;
        chosen.add(cls);
        coalescedCount += list.length;
      }
    }
    out.stats.budget = budget;
    out.stats.remainingWays = picked.length - coalescedCount;
    out.stats.classes = ranked.map(([cls, list]) => ({
      class: cls, family: coalesceFamilyOf(cls), ways: list.length,
      coalesced: chosen.has(cls) ? 1 : 0, always: coalesceAlways(cls) ? 1 : 0,
    }));

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
    if (coordsIn) {
      const missing = out.nodeIds.filter((id) => coords[id] === undefined);
      if (missing.length) this._fetchNodes(missing, coords, null, zoom);
    } else {
      this._fetchNodes(out.nodeIds, coords, null, zoom);
    }

    const kx = 111320 * Math.cos((Number(lat) || 0) * D2R);
    const ky = 110574;
    const tolM = opts.tolPx * metersPerPixel(zoom, lat);
    const q = (v, d) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };
    const byFamily = new Map();
    for (const list of groups.values()) {
      // 组内每条 way 的样式类/名字/btl 都相同（分组键保证），所以只用第一条的标签建折线
      const head = list[0];
      const trails = chainWaysToTrails(list);
      const paths = [];
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
    if (coordsIn) {
      const missing = ids.filter((id) => coords[id] === undefined);
      if (missing.length) this._fetchNodes(missing, coords, null, zoom);
    } else {
      this._fetchNodes(ids, coords, null, zoom);
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
      if (!g) { g = { cls, tags: w.tags, rings: [] }; groups.set(key, g); }
      g.rings.push(r.ring);
      const cs = classStat.get(cls) || { class: cls, family: areaFamilyOf(cls), ways: 0, rings: 0, points: 0, tiny: 0 };
      cs.ways += 1; cs.rings += 1; cs.points += r.ring.length;
      classStat.set(cls, cs);
      if (!isClosedRing(r.ring)) out.stats.openRings += 1;
    }
    const byFamily = new Map();
    for (const g of groups.values()) {
      const entry = { class: areaFamilyOf(g.cls), tags: areaDisplayTagsOf(g.tags), coords: g.rings[0] };
      const name = (g.tags && g.tags.name) || '';
      if (name) entry.name = name;
      if (g.rings.length > 1) entry.paths = g.rings.slice(1);
      out.entries.push(entry);
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
      for (const trail of trails) {
        const ringRes = buildRing(trail);
        if (!ringRes.ring) { if (!ringRes.missing) out.stats.tinyRings += 1; continue; }
        rings.push(ringRes.ring);
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
  _fetchNodes(ids, out, nodeTags, zoom, neverSendOn = true) {
    if (!ids.length) return;
    const z = zoom === undefined ? 19 : zoom;
    for (let i = 0; i < ids.length; i += NODE_FETCH_CHUNK) {
      const chunk = ids.slice(i, i + NODE_FETCH_CHUNK);
      const stmt = this._cachedStmt(nodeFetchSql(chunk.length));
      for (const n of stmt.all(...chunk)) {
        // 下发时保留 7 位小数（约 1 厘米），足够渲染与编辑，能明显减小传输体积
        out[n.id] = [Math.round(n.lat * 1e7) / 1e7, Math.round(n.lon * 1e7) / 1e7];
        if (nodeTags && n.tags && pointTagsMaybeVisible(n.tags, z)) {
          const tags = parseTags(n.tags);
          // 永不下载的类别（树 / 自行车道）连"几何顶点上带的标签"也不下发（见文件开头那一段）
          if (tags && !(neverSendOn && neverSendClassOf(tags)) && lodVisible(tags, z, 'point')) nodeTags[n.id] = tags;
        }
      }
    }
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
    const json = stringifyTags(cur.tags);
    const keys = wayLodKeysOf(json);
    this._st.updateWay.run(cur.version + 1, json, user.id, user.name, this._now(), 1, 0, 0, keys.roadClass, keys.lodZoom, id);
    this._st.deleteWayIndex.run(id);
    this._st.deleteWayNodes.run(id);
    this.recomputeRelationsOfWay(id);
    this.invalidateCounts();
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
    return this.getRelation(id);
  }

  updateRelation(id, { version, members, tags }, user) {
    const cur = this.getRelation(id);
    if (!cur) return null;
    const finalMembers = members || cur.members;
    this._st.updateRelation.run(version, stringifyTags(tags), user.id, user.name, this._now(), 0, finalMembers.length, id);
    if (members) {
      this._st.deleteRelMembers.run(id);
      members.forEach((m, seq) => this._st.insertRelMember.run(id, seq, m.type, m.ref, m.role || ''));
      this.recomputeRelationBbox(id);
      this.recomputeRelationMembers(id);
    }
    return this.getRelation(id);
  }

  markRelationDeleted(id, user) {
    const cur = this.getRelation(id);
    if (!cur) return null;
    this._st.updateRelation.run(cur.version + 1, stringifyTags(cur.tags), user.id, user.name, this._now(), 1, 0, id);
    this._st.deleteRelIndex.run(id);
    this._st.deleteRelMembers.run(id);
    this.invalidateCounts();
    return { ...cur, version: cur.version + 1, deleted: true };
  }

  /** 重算 way 的 bbox / 长度 / 节点数 / 闭合标记，并更新空间索引 */
  recomputeWayGeometry(wayId) {
    const row = this._st.wayById.get(wayId);
    if (!row || row.deleted) { this._st.deleteWayIndex.run(wayId); return; }
    const ids = this._st.wayNodeIds.all(wayId).map((r) => r.node_id);
    if (!ids.length) { this._st.deleteWayIndex.run(wayId); return; }
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
    if (!Number.isFinite(minLat)) { this._st.deleteWayIndex.run(wayId); return; }
    const closed = ids.length > 2 && ids[0] === ids[ids.length - 1] ? 1 : 0;
    this._st.setWayGeom.run(minLat, maxLat, minLon, maxLon, Math.round(length * 10) / 10, ids.length, closed, wayId);
    this._st.upsertWayIndex.run(wayId, minLon, maxLon, minLat, maxLat);
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
};
