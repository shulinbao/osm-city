'use strict';
/**
 * 交通路网图：把 way 组成可寻路的图，支持两种模式
 *   mode='rail' —— 铁路（railway=*），列车跑
 *   mode='bus'  —— 道路（highway=*），公交跑
 * 支持从一站到另一站找最短路，并取出逐段限速，供车辆模拟使用。
 *
 * 图结构：节点 = OSM node id，边 = way 上相邻两点之间的一段。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 公交路网（mode='bus'）额外做两件事，都是"路上真实会发生的事"：
 *
 * #15 相交即相连：OSM 里两条道路在几何上交叉、但没有共用节点（没有被打断 / 没有 noder）
 *      是常态，只按"共用节点"判连通会让公交线明明画在路口上却报"两站之间没有连通的
 *      道路"。所以建图时会用网格法把相交的路段两两求交，在交点处**切开并插入一个虚拟
 *      路口节点**（id 用负数，和 OSM 的 node id 不会冲突），两条路从此在图上真连通。
 *      桥 / 隧道按 layer（没写 layer 就用 bridge/tunnel 推 ±1）分层，互不相交。
 *
 * #16 拥堵系数：真实市区的公交速度不是"等级限速"，而是被路口拖垮的。这里按
 *      **每公里路口数**算每个 way 的拥堵系数（路口 = 图上度数 ≥ 3 的节点，虚拟路口
 *      也算），乘进公交的服务速度：等级拥堵经验值 × 1/(1 + 密度/12)。
 *      结果按 way 暴露出去（congestionInBbox / wayInfo），客户端可以按拥堵给道路上色。
 *      铁路模式完全不走这套（列车不堵车）。
 *      ⚠ 只有公交路网（mode='bus'）用服务速度；铁路那边 railInfo 返回的是轨道限速。
 */
const { metersBetween } = require('./osmdb');

/** 可以跑车的铁路类型（disused/abandoned/demolished 之类不可用） */
const RUNNABLE = new Set(['rail', 'light_rail', 'subway', 'tram', 'narrow_gauge', 'monorail', 'funicular', 'preserved']);
/** 各类型的默认限速（km/h），OSM 有 maxspeed 标签时以标签为准 */
const DEFAULT_SPEED = { rail: 100, light_rail: 60, subway: 60, tram: 40, narrow_gauge: 40, monorail: 60, funicular: 30, preserved: 40 };

/**
 * 公交能走的道路类型与"路网限速"（km/h）。
 * 这是按中国大陆市区道路的实际通行能力定的，不是设计速度：市区支路、居住区道路就是慢，
 * 把 OSM 的 maxspeed 直接当车速会让公交车在胡同里跑 60，完全不真实。
 */
const BUS_ROADS = {
  motorway: 100, motorway_link: 45, trunk: 70, trunk_link: 40,
  primary: 55, primary_link: 30, secondary: 40, secondary_link: 25,
  tertiary: 30, tertiary_link: 20, unclassified: 25, residential: 20,
  living_street: 10, service: 15, track: 10, busway: 45, bus_guideway: 45,
  road: 25, pedestrian: 5,
};
/** 表里没有的道路等级（新出现的 highway=* 值）用的默认路网限速（km/h） */
const BUS_ROAD_DEFAULT_SPEED = 25;

/**
 * 拥堵系数：市区道路的真实"服务速度" = 限速 × 这个系数。
 * 主干路（primary）路口多、车流量最大，折得最狠；支路、服务路虽然本身限速就低，但车少，
 * 折得少一点；高速/快速路（motorway/trunk）接近自由流。
 * 这是**按等级**的经验值；实际每个 way 还会再乘上"路口密度"那一项（见 JUNCTION_*）。
 */
const BUS_CONGESTION = {
  motorway: 0.9, motorway_link: 0.85,
  trunk: 0.8, trunk_link: 0.8,
  primary: 0.7, primary_link: 0.75,
  secondary: 0.75, secondary_link: 0.8,
  tertiary: 0.8, tertiary_link: 0.85,
  unclassified: 0.85, residential: 0.8, living_street: 0.9,
  service: 0.85, track: 0.9, busway: 0.9, bus_guideway: 0.9,
  road: 0.85, pedestrian: 0.9,
};
/** 表里没有的等级用的默认拥堵系数 */
const BUS_CONGESTION_DEFAULT = 0.85;

/**
 * #16 路口密度 → 拥堵：
 *   密度 = 该 way 上"图上度数 ≥ 3 的节点数" ÷ 长度（km）。
 *        一个路口 = 一条路被另一条路接上 / 穿过（虚拟路口也算，见 #15），
 *        所以北京老城里一条 500 米的胡同（每 100 米一个路口）密度就是 10/km，
 *        而一条 5 公里的快速路密度接近 0。
 *   拥堵 = min(1, max(JUNCTION_CONGESTION_MIN, 等级经验值 × 1/(1 + 密度 / JUNCTION_DENSITY_SCALE)))
 *        JUNCTION_DENSITY_SCALE = 12/km：密度 12 时把等级系数再打对折。
 *   密度用 (长度 + JUNCTION_LENGTH_PRIOR_KM) 做平滑，避免很短的路段（几十米）算出荒谬的密度。
 */
const JUNCTION_DENSITY_SCALE = 12;      // 每公里路口数的"半衰"尺度
const JUNCTION_LENGTH_PRIOR_KM = 0.15;  // 长度平滑先验（150 米）
const JUNCTION_CONGESTION_MIN = 0.25;   // 再堵也不会低于这个系数
/** 虚拟路口节点用负数 id（与 OSM node id 永不冲突） */
const VIRTUAL_NODE_ID = -1;
/** "虚拟路口联系边"用的伪 wayId（两条路的端点落在同一点但不是同一个节点时补的短边） */
const LINK_WAY_ID = -1;
/** 求交点用的网格边长（米）：越小候选对越少、越大越省内存 */
const JUNCTION_CELL_M = 150;
/** 交点合并精度（米）：落在这个范围内的交点算同一个虚拟路口 */
const JUNCTION_SNAP_M = 1.5;
/** 虚拟路口数量上限（安全阀：异常数据下不至于把内存吃光） */
const MAX_VIRTUAL_JUNCTIONS = 400000;

/**
 * 市区道路限速上限（km/h）：这些等级即使 maxspeed 标得更高，也不会超过上限。
 * 居住区 / 支路 / 服务路统一封顶 40（市区就是慢），步行街、小径、机耕道更低。
 */
const URBAN_SPEED_CAP = 40;
const SPEED_CAP_BY_CLASS = {
  residential: URBAN_SPEED_CAP, tertiary: URBAN_SPEED_CAP, tertiary_link: URBAN_SPEED_CAP,
  service: URBAN_SPEED_CAP, living_street: 20, track: 20, pedestrian: 10,
};
/** 服务速度的上下限（km/h）：公交再堵也不会低于 5（人会走），再快也不超过 110 */
const BUS_SPEED_MIN = 5;
const BUS_SPEED_MAX = 110;

/**
 * 公交车不能走的路（#2：除了这些，其余 highway=* 一律算"可通行道路"，
 * 包括 service / track / living_street 这些看起来不起眼的支路）。
 *   · footway / path / steps / cycleway / construction / proposed —— 明确不是机动车道
 *   · bridleway / corridor / raceway / platform / elevator —— 也不是机动车道（顺带排除）
 * 判定在 isDrivableHighway 里；公交站能不能建就看这个（#2）。
 */
const BUS_FORBIDDEN = new Set(['footway', 'path', 'steps', 'cycleway', 'bridleway', 'corridor', 'construction', 'proposed', 'raceway', 'platform', 'elevator']);

/**
 * 这个 highway 等级公交能不能走（#15b / #2：公交站吸附就按这个判断"可通行道路"）。
 * #2 明确要求：**任何 highway=* 都算，只有上面那批明确不能跑车的等级不算**，
 * 不再要求它在 BUS_ROADS 限速表里（表里没有的等级用 BUS_ROAD_DEFAULT_SPEED 兜底）。
 */
function isDrivableHighway(kind) {
  const k = kind == null ? '' : String(kind).trim();
  if (!k) return false;
  return !BUS_FORBIDDEN.has(k);
}

/** 这个纬度上 1 经度 ≈ 多少米（吸附找点时的平面近似用） */
const M_PER_DEG_LAT = 110574;
function M_PER_DEG_LON_AT(lat) {
  return 111320 * Math.cos(((Number(lat) || 0) * Math.PI) / 180);
}

function parseMaxSpeed(value, fallback) {
  if (value == null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  if (s === 'none' || s === 'signals') return 160;
  const mph = /mph/.test(s);
  const num = parseFloat(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const kmh = mph ? num * 1.60934 : num;
  return Math.max(5, Math.min(400, Math.round(kmh)));
}

/**
 * 这条路的"有效层"（#15 求交用）：明写了 layer 就用它；没写但标了 bridge / tunnel
 * 就按 ±1 推。层数不同的两条路即使平面投影相交也不算相交（立交桥 / 下穿道）。
 */
function effectiveLayerOf(tags) {
  if (!tags) return 0;
  const raw = tags.layer;
  if (raw != null && String(raw).trim() !== '') {
    const n = parseFloat(String(raw).replace(/[^\d.-]/g, ''));
    if (Number.isFinite(n)) return Math.round(n);
  }
  if (tags.bridge === 'yes' || tags.bridge === 'viaduct' || tags.bridge === 'boardwalk') return 1;
  if (tags.tunnel === 'yes' || tags.tunnel === 'building_passage' || tags.covered === 'yes') return -1;
  return 0;
}

/**
 * #16：等级经验拥堵系数 × 路口密度惩罚。
 *   密度 = 每公里路口数（路口 = 图上度数 ≥ 3 的节点，含 #15 插的虚拟路口）。
 *   1/(1 + 密度/12)：密度 0 → 1.0（快速路接近自由流）；密度 6 → 0.67；密度 12 → 0.5。
 *   结果夹在 [JUNCTION_CONGESTION_MIN, 1]：再堵也不会低于 0.25，专用道另算（=1）。
 */
function junctionCongestion(base, density) {
  const d = Math.max(0, Number(density) || 0);
  const f = 1 / (1 + d / JUNCTION_DENSITY_SCALE);
  const b = Number.isFinite(Number(base)) ? Number(base) : BUS_CONGESTION_DEFAULT;
  return Math.max(JUNCTION_CONGESTION_MIN, Math.min(1, b * f));
}

/**
 * 两条线段的"真交叉"判定（平面坐标，单位米）。返回交点在两条线段上的参数 { t, u }，或 null。
 * 端点相接（t/u 贴 0 或 1）也算交叉，交给调用方决定"复用已有节点"还是"切一刀"。
 * 平行 / 共线时返回 null（共线重叠的两条路多半是重复画的路，由"共用节点"那条路兜住）。
 */
function planarCrossing(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax; const ry = by - ay;
  const sx = dx - cx; const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const qpx = cx - ax; const qpy = cy - ay;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  const EPS = 1e-6;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) };
}

/** 极简二叉堆优先队列 */
class Heap {
  constructor() { this.a = []; }
  push(item, key) {
    const a = this.a;
    a.push({ item, key });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].key <= a[i].key) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].key < a[m].key) m = l;
        if (r < a.length && a[r].key < a[m].key) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

class RailGraph {
  constructor(db, options = {}) {
    this.db = db;
    this.mode = options.mode === 'bus' ? 'bus' : 'rail';
    this.maxNodes = options.maxNodes || 900000;
    this.nodes = new Map();   // nodeId -> { lat, lon, edges: [{ to, length, speed, wayId, congestion }] }
    this.wayCount = 0;
    this.builtAt = 0;
    /** #15 / #16 的开关：公交路网默认开（相交即相连 + 路口拥堵）；铁路模式永远不做 */
    this.busJunctions = this.mode === 'bus' && options.busJunctions !== false;
    /** wayId -> { kind, limit, base, dedicated, layer, minLat, maxLat, minLon, maxLon, lengthM, junctions, density, congestion, speed, degreeAvg } */
    this.wayInfo = new Map();
    /** wayId -> Set(nodeId)：这条 way 用到了哪些图节点（算路口密度、增量更新时用） */
    this.wayNodes = new Map();
    this.virtualNodeCount = 0;   // 虚拟路口节点数量（#15 插进去的）
    this.junctionCount = 0;      // 图里"度数 ≥ 3"的节点总数（路口）
    this._vnodeSeq = 0;
    this._segGrid = null;        // 网格索引：#15 增量更新时用（只能识别别的路段）
    this._segList = null;        // 与网格配套的段表
    this._segOfWay = new Map();  // wayId -> 段索引数组
    const like = this.mode === 'bus' ? '%highway%' : '%railway%';
    this._st = {
      railWays: db.prepare(`SELECT id, tags FROM ways WHERE deleted = 0 AND tags LIKE '${like}'`),
      wayNodes: db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq'),
      nodeById: db.prepare('SELECT id, lat, lon FROM nodes WHERE id = ? AND deleted = 0'),
      wayById: db.prepare('SELECT id, tags, deleted FROM ways WHERE id = ?'),
    };
  }

  /**
   * 判断一条 way 能不能跑车，并给出它的限速 / 拥堵。
   *   rail：轨道类型 → 限速（maxspeed 优先，隧道打 0.9 折）
   *   bus ：highway=* 只要不在 BUS_FORBIDDEN 里就能走（#2）；限速 = 等级表（表里没有就用
   *         BUS_ROAD_DEFAULT_SPEED）× maxspeed 覆盖 × 市区封顶；服务速度见 _recomputeWayStats
   * layer/effectiveLayer：桥隧分层用（#15：不同层的路不算相交）
   */
  railInfo(tags, wayId) {
    if (!tags) return null;
    if (this.mode === 'bus') {
      const kind = tags.highway;
      if (!isDrivableHighway(kind)) return null;
      if (tags.area === 'yes' || tags.construction) return null;
      const k = String(kind).trim();
      // 1) 先取这个等级的路网限速（表里没有的等级用默认值 —— #2：任何 highway=* 都算可通行）
      let limit = BUS_ROADS[k] == null ? BUS_ROAD_DEFAULT_SPEED : BUS_ROADS[k];
      // 2) 有 maxspeed 标签就以标签为准；但市区等级封顶（居住区/支路/服务路 40），
      //    不会因为底图上标了 60 就让公交车在小区里开 60
      if (tags.maxspeed != null && String(tags.maxspeed).trim() !== '') {
        limit = parseMaxSpeed(tags.maxspeed, limit);
      }
      const cap = SPEED_CAP_BY_CLASS[k];
      if (cap != null) limit = Math.min(limit, cap);
      // 3) 公交专用道 / BRT：有独立路权，不打拥堵折扣（比同等级的混行道路快）
      const dedicated = tags.bus === 'yes' || tags.psv === 'yes' || k === 'busway' || k === 'bus_guideway';
      const base = BUS_CONGESTION[k] == null ? BUS_CONGESTION_DEFAULT : BUS_CONGESTION[k];
      // 4) 拥堵系数：有路口密度数据（#16）就用它，没有就退回按等级的经验值；
      //    实际服务速度 = 限速 × 拥堵系数，这就是车辆巡航时用的速度
      const congestion = this.congestionFor(wayId, k, dedicated, base);
      const limitR = Math.round(limit);
      return {
        kind: k,
        speed: Math.max(BUS_SPEED_MIN, Math.min(BUS_SPEED_MAX, Math.round(limitR * congestion))),
        limit: limitR,                     // 路网限速（km/h）
        congestion,                        // 拥堵系数（#16）
        base,                              // 等级经验系数（没算路口密度时用的）
        dedicated,                         // 是否专用道
        layer: effectiveLayerOf(tags),      // 桥隧分层（#15）
        bus: true,
      };
    }
    const kind = tags.railway;
    if (!kind || !RUNNABLE.has(kind)) return null;
    if (tags.service === 'yard' || tags.service === 'spur') return null;   // 站场/专用线不参与客运寻路
    const fallback = DEFAULT_SPEED[kind] || 60;
    const speed = parseMaxSpeed(tags.maxspeed, fallback) * (tags.tunnel === 'yes' ? 0.9 : 1);
    // 铁路不堵车：#16 的拥堵系数、路口密度都不适用于轨道
    return { kind, speed: Math.max(15, Math.round(speed)) };
  }

  /** 某个 way 的拥堵系数（#16）：专用道 1，有路口密度数据就用密度算，否则用等级经验值 */
  congestionFor(wayId, kind, dedicated, base) {
    const b = base == null ? (BUS_CONGESTION[kind] == null ? BUS_CONGESTION_DEFAULT : BUS_CONGESTION[kind]) : base;
    if (dedicated) return 1;
    if (wayId == null || !this.wayInfo) return b;
    const w = this.wayInfo.get(Number(wayId));
    if (!w || !Number.isFinite(w.density)) return b;
    return junctionCongestion(b, w.density);
  }

  isRailWay(tags) { return !!this.railInfo(tags); }

  /** 全量重建（导入数据后、或轨道改动较多时调用） */
  build() {
    const t0 = Date.now();
    this.nodes.clear();
    this.wayInfo.clear();
    this.wayNodes.clear();
    this._segGrid = null;
    this._segList = null;
    this._segOfWay.clear();
    this.virtualNodeCount = 0;
    this.junctionCount = 0;
    this._vnodeSeq = 0;
    this._jamStats = null;
    let ways = 0;
    let edges = 0;
    for (const row of this._st.railWays.all()) {
      let tags = null;
      try { tags = row.tags ? JSON.parse(row.tags) : null; } catch { tags = null; }
      const info = this.railInfo(tags);
      if (!info) continue;
      const ids = this._st.wayNodes.all(row.id).map((r) => r.node_id);
      if (ids.length < 2) continue;
      ways += 1;
      const coords = new Map();
      for (const nid of ids) {
        const n = this._st.nodeById.get(nid);
        if (n) coords.set(n.id, n);
      }
      let wayLength = 0;
      let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
      for (let i = 1; i < ids.length; i++) {
        const a = coords.get(ids[i - 1]);
        const b = coords.get(ids[i]);
        if (!a || !b) continue;
        const length = metersBetween(a.lat, a.lon, b.lat, b.lon);
        if (length <= 0.01) continue;
        this._addEdge(a, b, length, info.speed, row.id, info.congestion);
        edges += 1;
        wayLength += length;
        minLat = Math.min(minLat, a.lat, b.lat); maxLat = Math.max(maxLat, a.lat, b.lat);
        minLon = Math.min(minLon, a.lon, b.lon); maxLon = Math.max(maxLon, a.lon, b.lon);
      }
      // 记下这条 way 的静态信息（拥堵重算 / congestionInBbox 都要用）
      this.wayInfo.set(row.id, {
        wayId: row.id, kind: info.kind, limit: info.limit, base: info.base == null ? info.congestion : info.base,
        dedicated: !!info.dedicated, layer: info.layer == null ? 0 : info.layer,
        minLat, maxLat, minLon, maxLon, lengthM: wayLength,
        junctions: 0, density: 0, congestion: info.congestion, speed: info.speed, degreeAvg: 0,
      });
    }
    // #15：公交路网把相交的道路打通用虚拟路口连起来；#16：再按路口密度重算拥堵与速度
    let junctionInfo = null;
    if (this.busJunctions) {
      junctionInfo = this._buildJunctions();
      this._recomputeAllCongestion();
    }
    this.wayCount = ways;
    this.edgeCount = this._countEdges();
    this.segmentCount = this._segWay ? this._segWay.filter((w) => w).length : 0;
    this.builtAt = Date.now();
    if (this.nodes.size > this.maxNodes) {
      console.warn(`[rail] 路网节点过多（${this.nodes.size}），已按上限截断`);
    }
    return {
      ways, edges: this.edgeCount, nodes: this.nodes.size, ms: Date.now() - t0,
      virtualJunctions: this.virtualNodeCount, junctions: this.junctionCount,
      junctionMs: junctionInfo ? junctionInfo.ms : 0,
    };
  }

  _countEdges() {
    let n = 0;
    for (const node of this.nodes.values()) n += node.edges.length;
    return n;
  }

  _node(id, lat, lon) {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, lat, lon, edges: [] };
      this.nodes.set(id, n);
    }
    return n;
  }

  /** 新建一个虚拟路口节点（#15）：id 用负数，永不会与 OSM node id 撞车 */
  _virtualNode(lat, lon, key) {
    const id = VIRTUAL_NODE_ID - (this._vnodeSeq++);
    const n = { id, lat, lon, edges: [], virtual: true, key };
    this.nodes.set(id, n);
    this.virtualNodeCount += 1;
    return n;
  }

  _addEdge(a, b, length, speed, wayId, congestion) {
    const na = this._node(a.id, a.lat, a.lon);
    const nb = this._node(b.id, b.lat, b.lon);
    na.edges.push({ to: b.id, length, speed, wayId, congestion });
    nb.edges.push({ to: a.id, length, speed, wayId, congestion });
    // wayId -> 节点集合（算路口密度、增量更新时判断"哪些 way 受影响"）
    if (wayId != null) {
      let set = this.wayNodes.get(wayId);
      if (!set) { set = new Set(); this.wayNodes.set(wayId, set); }
      set.add(a.id);
      set.add(b.id);
    }
  }

  /* --------------------------- #15 虚拟路口：相交即相连 --------------------------- */
  /*
   * 数据结构（为了在 50 万级路段上也跑得动，用平行数组而不是对象）：
   *   _segWay[i]                   这条段的 wayId（0 = 已废弃的墓碑）
   *   _segA[i] / _segB[i]          两端节点 id
   *   _segX1.._segY2[i]            两端点的平面坐标（米，等距圆柱近似，只为求交用）
   *   _segLen[i]                   段长（米）
   *   _segGrid                     网格（150 米一格）→ 段索引数组
   *   _segOfWay                    wayId → 段索引数组（增量更新时删索引用）
   */

  /** 平面投影（求交用）：以第一条路段的纬度为基准，一个城市范围内足够准 */
  _planar(lat, lon) {
    if (this._kx == null) {
      this._kx = M_PER_DEG_LON_AT(lat);
      this._ky = 110574;
    }
    return { x: lon * this._kx, y: lat * this._ky };
  }

  /** 交点合并用的坐标键（1.5 米一格） */
  _nodeKey(px, py) {
    return Math.round(px / JUNCTION_SNAP_M) * 1000003 + Math.round(py / JUNCTION_SNAP_M);
  }

  /** 把一个"已有节点"登记进合并表：后面别的路在同一位置求交时会复用它，不会另造一个节点 */
  _rememberNodeKey(node, px, py, vnodes) {
    if (!node) return;
    const k1 = this._nodeKey(px, py);
    if (!vnodes.has(k1)) vnodes.set(k1, node.id);
    const k2 = this._nodeKey(node.lon * this._kx, node.lat * this._ky);
    if (!vnodes.has(k2)) vnodes.set(k2, node.id);
  }

  /** 一条段覆盖到的格子键（用记录下来的投影范围；删除索引时要能算出同一批键） */
  _segCellKeys(i) {
    const c1 = Math.floor(Math.min(this._segX1[i], this._segX2[i]) / JUNCTION_CELL_M);
    const c2 = Math.floor(Math.max(this._segX1[i], this._segX2[i]) / JUNCTION_CELL_M);
    const r1 = Math.floor(Math.min(this._segY1[i], this._segY2[i]) / JUNCTION_CELL_M);
    const r2 = Math.floor(Math.max(this._segY1[i], this._segY2[i]) / JUNCTION_CELL_M);
    const out = [];
    for (let cx = c1; cx <= c2; cx++) {
      for (let cy = r1; cy <= r2; cy++) out.push((cx - this._cellOX) * 100000 + (cy - this._cellOY));
    }
    return out;
  }

  /** 把当前图里的边收成段（无向，每条边一次），建网格索引；顺带清掉旧的索引 */
  _reindexSegments() {
    this._segWay = [];
    this._segA = [];
    this._segB = [];
    this._segX1 = [];
    this._segY1 = [];
    this._segX2 = [];
    this._segY2 = [];
    this._segLen = [];
    this._segGrid = new Map();
    this._segOfWay = new Map();
    this._cellOX = null;
    this._cellOY = null;
    this._kx = null;
    this._ky = null;
    // 先收集（不建网格）以便确定格子原点，避免偏移在插入过程中变化
    const raw = [];
    for (const n of this.nodes.values()) {
      // 无向边只收一次：只处理 n.id < e.to 的一侧
      for (const e of n.edges) {
        if (!(n.id < e.to)) continue;
        const m = this.nodes.get(e.to);
        if (!m) continue;
        raw.push([e.wayId, n.id, e.to, n.lat, n.lon, m.lat, m.lon, e.length]);
      }
    }
    const refLat = raw.length ? raw[0][3] : 39.9042;
    this._kx = M_PER_DEG_LON_AT(refLat);
    this._ky = 110574;
    // 先算出全局最小格子，作为键的原点
    let minCx = Infinity; let minCy = Infinity;
    for (const r of raw) {
      const x1 = r[4] * this._kx; const x2 = r[6] * this._kx;
      const y1 = r[3] * this._ky; const y2 = r[5] * this._ky;
      minCx = Math.min(minCx, Math.floor(Math.min(x1, x2) / JUNCTION_CELL_M));
      minCy = Math.min(minCy, Math.floor(Math.min(y1, y2) / JUNCTION_CELL_M));
    }
    this._cellOX = Number.isFinite(minCx) ? minCx : 0;
    this._cellOY = Number.isFinite(minCy) ? minCy : 0;
    for (const r of raw) this._pushSegment(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], true);
    return raw.length;
  }

  /** 往段表里追加一条段并挂进网格（index=true 时建索引） */
  _pushSegment(wayId, aId, bId, alat, alon, blat, blon, len, index) {
    const i = this._segWay.length;
    const x1 = alon * this._kx; const y1 = alat * this._ky;
    const x2 = blon * this._kx; const y2 = blat * this._ky;
    this._segWay.push(wayId);
    this._segA.push(aId);
    this._segB.push(bId);
    this._segX1.push(x1);
    this._segY1.push(y1);
    this._segX2.push(x2);
    this._segY2.push(y2);
    this._segLen.push(len);
    if (index !== false) {
      const list = this._segCellKeys(i);
      for (const k of list) {
        let arr = this._segGrid.get(k);
        if (!arr) { arr = []; this._segGrid.set(k, arr); }
        arr.push(i);
      }
    }
    if (wayId) {
      let arr = this._segOfWay.get(wayId);
      if (!arr) { arr = []; this._segOfWay.set(wayId, arr); }
      arr.push(i);
    }
    return i;
  }

  /** 把一条段从网格里摘掉（段表里留墓碑：_segWay[i] = 0） */
  _unindexSegment(i) {
    for (const k of this._segCellKeys(i)) {
      const arr = this._segGrid.get(k);
      if (!arr) continue;
      const at = arr.indexOf(i);
      if (at >= 0) arr.splice(at, 1);
      if (!arr.length) this._segGrid.delete(k);
    }
    const w = this._segWay[i];
    if (w) {
      const list = this._segOfWay.get(w);
      if (list) {
        const at = list.indexOf(i);
        if (at >= 0) list.splice(at, 1);
        if (!list.length) this._segOfWay.delete(w);
      }
    }
    this._segWay[i] = 0;
  }

  /** 删掉一端的无向边（增量更新 / 切开段时用）；返回是否删掉了 */
  _removeEdge(aId, bId, wayId) {
    const na = this.nodes.get(aId);
    const nb = this.nodes.get(bId);
    let removed = false;
    if (na) {
      const at = na.edges.findIndex((e) => e.to === bId && e.wayId === wayId);
      if (at >= 0) { na.edges.splice(at, 1); removed = true; }
    }
    if (nb) {
      const at = nb.edges.findIndex((e) => e.to === aId && e.wayId === wayId);
      if (at >= 0) { nb.edges.splice(at, 1); removed = true; }
    }
    return removed;
  }

  /** 建图收尾用：把前面的边全部清空，再按段表（含切开后的段）重新铺一遍 */
  _rebuildEdgesFromSegments() {
    for (const n of this.nodes.values()) n.edges.length = 0;
    this.wayNodes.clear();
    for (let i = 0; i < this._segWay.length; i++) {
      const w = this._segWay[i];
      if (!w) continue;
      const a = this.nodes.get(this._segA[i]);
      const b = this.nodes.get(this._segB[i]);
      if (!a || !b) continue;
      const info = this.wayInfo.get(w);
      const isLink = w === LINK_WAY_ID;
      const speed = isLink ? 10 : (info ? info.speed : 30);
      const congestion = isLink ? JUNCTION_CONGESTION_MIN : (info ? info.congestion : BUS_CONGESTION_DEFAULT);
      const na = this._node(a.id, a.lat, a.lon);
      const nb = this._node(b.id, b.lat, b.lon);
      na.edges.push({ to: b.id, length: this._segLen[i], speed, wayId: w, congestion, link: isLink });
      nb.edges.push({ to: a.id, length: this._segLen[i], speed, wayId: w, congestion, link: isLink });
      let set = this.wayNodes.get(w);
      if (!set) { set = new Set(); this.wayNodes.set(w, set); }
      set.add(a.id); set.add(b.id);
    }
  }

  /** 记一个切点（同一段上同一个节点只记一次，避免重复切出零长度段） */
  _addCut(cuts, segIdx, t, nodeId) {
    let list = cuts.get(segIdx);
    if (!list) { list = []; cuts.set(segIdx, list); }
    for (const c of list) if (c.nodeId === nodeId) return;
    list.push({ t, nodeId });
  }

  /** 作废一个没人用的虚拟路口（另一侧已经落在真实节点上时） */
  _discardVirtualNode(node, vnodes) {
    if (!node || node.atEnd) return;
    const n = this.nodes.get(node.nodeId);
    if (n && n.virtual && !n.edges.length) {
      this.nodes.delete(node.nodeId);
      if (n.key != null && vnodes) vnodes.delete(n.key);
      this.virtualNodeCount = Math.max(0, this.virtualNodeCount - 1);
    }
  }

  /** 取某个交点在段上的"接入节点"：能复用已有端点就复用，否则造一个虚拟路口（合并到 1.5 米） */
  _junctionNode(segIdx, t, px, py, vnodes) {
    const EPS = 1e-3;
    const aId = this._segA[segIdx];
    const bId = this._segB[segIdx];
    if (t <= EPS) {
      const n = this.nodes.get(aId);
      this._rememberNodeKey(n, px, py, vnodes);
      return { nodeId: aId, atEnd: true };
    }
    if (t >= 1 - EPS) {
      const n = this.nodes.get(bId);
      this._rememberNodeKey(n, px, py, vnodes);
      return { nodeId: bId, atEnd: true };
    }
    // 这个位置已经有节点了吗（已有节点，或者别的路刚在这里插了虚拟路口）
    const key = this._nodeKey(px, py);
    const hit = vnodes.get(key);
    if (hit != null && this.nodes.has(hit)) return { nodeId: hit, atEnd: false };
    if (this.virtualNodeCount >= MAX_VIRTUAL_JUNCTIONS) return null;   // 安全阀
    const lat = py / this._ky;
    const lon = px / this._kx;
    const v = this._virtualNode(lat, lon, key);
    vnodes.set(key, v.id);
    return { nodeId: v.id, atEnd: false };
  }

  /**
   * #15 主过程：在给定的一批网格里，把所有"相交但没共用节点"的道路段切开、插入虚拟路口节点。
   *   cells = null → 全图（建图时用）；给一批键 → 只重算这些格子（编辑道路后增量更新用）。
   * 因为切开是幂等的（切完两段就共用一个节点，下一轮会被"共用节点"规则跳过），
   * 所以重复跑同一批格子不会越切越碎。
   */
  _noderCells(cells) {
    const t0 = Date.now();
    let pairs = 0;
    let crosses = 0;
    let linked = 0;
    const links = [];
    const vnodes = new Map();
    // cuts: segIdx -> [{ t, nodeId }]
    const cuts = new Map();
    // 先把"已有节点"按坐标登记一遍，方便三条路交于同一点时复用同一个节点
    const keys = cells == null ? [...this._segGrid.keys()] : cells;
    for (const k of keys) {
      const list = this._segGrid.get(k);
      if (!list || list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        const si = list[i];
        if (!this._segWay[si]) continue;
        const wi = this._segWay[si];
        for (let j = i + 1; j < list.length; j++) {
          const sj = list[j];
          if (!this._segWay[sj]) continue;
          if (si === sj) continue;
          // 已经共用节点 → 本来就连通，跳过
          const a1 = this._segA[si]; const b1 = this._segB[si];
          const a2 = this._segA[sj]; const b2 = this._segB[sj];
          if (a1 === a2 || a1 === b2 || b1 === a2 || b1 === b2) continue;
          // 桥 / 隧道分层：不同层不相交（立交、下穿）
          const wi2 = this._segWay[sj];
          const li = this.wayInfo.get(wi);
          const lj = this.wayInfo.get(wi2);
          if (li && lj && li.layer !== lj.layer) continue;
          // 包围盒（平面坐标）快速排除
          const x1 = this._segX1[si]; const y1 = this._segY1[si];
          const x2 = this._segX2[si]; const y2 = this._segY2[si];
          const x3 = this._segX1[sj]; const y3 = this._segY1[sj];
          const x4 = this._segX2[sj]; const y4 = this._segY2[sj];
          if (Math.max(x1, x2) < Math.min(x3, x4) || Math.max(x3, x4) < Math.min(x1, x2)) continue;
          if (Math.max(y1, y2) < Math.min(y3, y4) || Math.max(y3, y4) < Math.min(y1, y2)) continue;
          pairs += 1;
          const hit = planarCrossing(x1, y1, x2, y2, x3, y3, x4, y4);
          if (!hit) continue;
          const px = x1 + (x2 - x1) * hit.t;
          const py = y1 + (y2 - y1) * hit.t;
          // 两端各自决定"接入哪个节点"：优先复用已有端点，否则共享同一个虚拟路口
          const na = this._junctionNode(si, hit.t, px, py, vnodes);
          const nb = this._junctionNode(sj, hit.u, px, py, vnodes);
          if (!na || !nb) continue;
          // 这一对交点最终接在哪个节点上：优先"已有的真实节点"，两边都没有就用虚拟路口
          let nodeId;
          if (na.atEnd) nodeId = na.nodeId;
          else if (nb.atEnd) nodeId = nb.nodeId;
          else nodeId = na.nodeId;      // 两边都是新建的：_junctionNode 按坐标键合并，是同一个节点
          // 用不上的虚拟路口作废（并把它已经记下的切点改指到真实节点上，避免"同点两个节点"）
          for (const cand of [na, nb]) {
            if (cand.atEnd || cand.nodeId === nodeId) continue;
            this._discardVirtualNode(cand, vnodes);
            for (const list2 of cuts.values()) {
              for (const c of list2) if (c.nodeId === cand.nodeId) c.nodeId = nodeId;
            }
          }
          // 两侧都要能接到 nodeId 上：交点在段中间就必须切一刀；交点正好在端点上时
          // 这一刀是空操作（_cutSegment 会跳过 nodeId == 端点的切点），所以统一记下来最省心
          this._addCut(cuts, si, hit.t, nodeId);
          this._addCut(cuts, sj, hit.u, nodeId);
          if (na.atEnd && nb.atEnd && na.nodeId !== nb.nodeId) {
            // 两条路的端点落在同一点、却不是同一个节点：补一条很短的联系边（虚拟路口边）。
            // 收集起来等切完再补，避免在遍历网格的过程中改动网格内容。
            const A = this.nodes.get(na.nodeId);
            const B = this.nodes.get(nb.nodeId);
            if (A && B) { links.push([na.nodeId, nb.nodeId]); linked += 1; }
          }
          crosses += 1;
        }
      }
    }
    let cutCount = 0;
    for (const [si, list] of cuts) {
      if (!this._segWay[si]) continue;
      cutCount += this._cutSegment(si, list);
    }
    // 补"虚拟路口联系边"（两条路的端点重合但不是同一个节点时）
    for (const [aId, bId] of links) {
      const A = this.nodes.get(aId);
      const B = this.nodes.get(bId);
      if (!A || !B) continue;
      const d = Math.max(0.5, metersBetween(A.lat, A.lon, B.lat, B.lon));
      this._linkEdge(aId, bId, d);
    }
    for (const n of [...this.nodes.values()]) {
      if (n.virtual && !n.edges.length) this.nodes.delete(n.id);
    }
    return { pairs, crosses, cuts: cutCount, linked, cells: keys.length, ms: Date.now() - t0 };
  }

  /**
   * 补一条"虚拟路口联系边"（两条路的端点落在同一点但不是同一个节点时用）。
   * wayId 用 LINK_WAY_ID（-1）：它不属于任何 OSM way，但要走正常的路段流程
   * （否则重建边的时候会被清掉），速度按"即停即走"给一个很低的值。
   */
  _linkEdge(aId, bId, length) {
    const na = this.nodes.get(aId);
    const nb = this.nodes.get(bId);
    if (!na || !nb) return;
    const link = { to: bId, length, speed: 10, wayId: LINK_WAY_ID, congestion: JUNCTION_CONGESTION_MIN, link: true };
    na.edges.push(link);
    nb.edges.push({ to: aId, length, speed: 10, wayId: LINK_WAY_ID, congestion: JUNCTION_CONGESTION_MIN, link: true });
    this._pushSegment(LINK_WAY_ID, aId, bId, na.lat, na.lon, nb.lat, nb.lon, length, true);
  }

  /**
   * 把一条段按切点列表切开：段 (a→b) 变成 a→n1→n2→…→b。
   * 同时更新网格索引（旧段摘掉、新段挂上）。返回切了几刀（有效切点个数）。
   */
  _cutSegment(segIdx, list) {
    const wayId = this._segWay[segIdx];
    if (!wayId) return 0;
    const aId = this._segA[segIdx];
    const bId = this._segB[segIdx];
    // 切点按 t 排序 + 去重（同一个节点、或者离得太近的只留一个）
    const sorted = list.slice().sort((x, y) => x.t - y.t);
    const picked = [];
    for (const c of sorted) {
      if (c.nodeId === aId || c.nodeId === bId) continue;
      const last = picked[picked.length - 1];
      if (last && (last.nodeId === c.nodeId || Math.abs(last.t - c.t) < 1e-6)) continue;
      picked.push(c);
    }
    if (!picked.length) return 0;
    const info = this.wayInfo.get(wayId);
    const speed = info ? info.speed : 30;
    const congestion = info ? info.congestion : BUS_CONGESTION_DEFAULT;
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (!a || !b) return 0;
    const chain = [aId];
    for (const c of picked) {
      if (c.nodeId !== chain[chain.length - 1]) chain.push(c.nodeId);
    }
    chain.push(bId);
    // 坐标：虚拟节点是新建的，按 t 插值补上经纬度
    for (const c of picked) {
      if (this.nodes.has(c.nodeId)) continue;
      const lat = a.lat + (b.lat - a.lat) * c.t;
      const lon = a.lon + (b.lon - a.lon) * c.t;
      this._node(c.nodeId, lat, lon);
    }
    this._removeEdge(aId, bId, wayId);
    this._unindexSegment(segIdx);
    let added = 0;
    for (let i = 1; i < chain.length; i++) {
      const na = this.nodes.get(chain[i - 1]);
      const nb = this.nodes.get(chain[i]);
      if (!na || !nb) continue;
      const length = metersBetween(na.lat, na.lon, nb.lat, nb.lon);
      if (length <= 0.01) continue;
      na.edges.push({ to: nb.id, length, speed, wayId, congestion });
      nb.edges.push({ to: na.id, length, speed, wayId, congestion });
      let set = this.wayNodes.get(wayId);
      if (!set) { set = new Set(); this.wayNodes.set(wayId, set); }
      set.add(na.id); set.add(nb.id);
      this._pushSegment(wayId, na.id, nb.id, na.lat, na.lon, nb.lat, nb.lon, length, true);
      added += 1;
    }
    return picked.length;
  }

  /** 建图时的 #15 全量一遍：先全图求交切段，再按最终段表重建边与网格 */
  _buildJunctions() {
    const count = this._reindexSegments();
    const res = this._noderCells(null);
    // 切开之后段表已经是最新的（_cutSegment 会就地更新网格），这里只需要把边按段表重铺
    this._rebuildEdgesFromSegments();
    // 统计还活着的虚拟路口
    let v = 0;
    for (const n of this.nodes.values()) if (n.virtual) v += 1;
    this.virtualNodeCount = v;
    res.segments = count;
    res.virtualNodes = v;
    return res;
  }

  /* --------------------------- #16 每 way 拥堵系数 --------------------------- */

  /** 重新统计某个 way 的路口密度与拥堵（路口 = 图上度数 ≥ 3 的节点） */
  _recomputeWayStats(wayId) {
    this._jamStats = null;          // 拥堵统计的缓存作废（下一帧再算一次）
    const info = this.wayInfo.get(wayId);
    const nodes = this.wayNodes.get(wayId);
    if (!info || !nodes) return;
    let junctions = 0;
    let degSum = 0;
    let degN = 0;
    for (const nid of nodes) {
      const n = this.nodes.get(nid);
      if (!n) continue;
      const deg = n.edges.length;
      if (deg >= 3) junctions += 1;      // 路口：被别的路接上 / 穿过
      degSum += deg;
      degN += 1;
    }
    const lengthKm = Math.max(0, info.lengthM) / 1000;
    // 用 (长度 + 150 米先验) 平滑：很短的路段（几十米）也能算出合理密度
    const density = junctions / (lengthKm + JUNCTION_LENGTH_PRIOR_KM);
    const congestion = info.dedicated ? 1 : junctionCongestion(info.base, density);
    const limit = Math.max(1, info.limit);
    info.junctions = junctions;
    info.density = Math.round(density * 100) / 100;
    info.congestion = Math.round(congestion * 1000) / 1000;
    info.speed = Math.max(BUS_SPEED_MIN, Math.min(BUS_SPEED_MAX, Math.round(limit * congestion)));
    info.degreeAvg = degN ? Math.round((degSum / degN) * 100) / 100 : 0;
    info.serviceSpeed = info.speed;
  }

  /** 按路口密度重算全部 way 的拥堵，并把新速度刷到每条边上（公交服务速度 = #16 的落点） */
  _recomputeAllCongestion() {
    this._jamStats = null;
    for (const wayId of this.wayInfo.keys()) this._recomputeWayStats(wayId);
    this._applyCongestionToEdges();
    // 路口总数（统计用）
    let j = 0;
    for (const n of this.nodes.values()) if (n.edges.length >= 3) j += 1;
    this.junctionCount = j;
  }

  _applyCongestionToEdges() {
    for (const n of this.nodes.values()) {
      for (const e of n.edges) {
        if (e.wayId === 0 || e.link) continue;
        const info = this.wayInfo.get(e.wayId);
        if (!info) continue;
        e.speed = info.speed;
        e.congestion = info.congestion;
      }
    }
  }

  /**
   * 单条道路 / 轨道改动后就地更新图（避免整张图重建）。
   * 轨道模式：删掉这条 way 的边再按最新节点重新铺一遍（老逻辑）。
   * 公交模式（#15）：还要把这批新路段拿去和路网里其它路段求交、切开、补上虚拟路口
   *   · 受影响的节点（旧边的端点 ∪ 新边的端点）所在的格子会被重新求交一次；
   *   · 求交是幂等的：已经切开的路段共用了节点，会被"共用节点"规则跳过，不会越切越碎。
   * 另外 #16：路口密度变了，相关 way 的拥堵系数要跟着重算（包括被删掉的那条路原来
   * 接在别人身上的路口 —— 那个路口可能因此消失）。
   */
  updateWay(wayId) {
    const id = Number(wayId);
    const row = this._st.wayById.get(id);
    const bus = this.busJunctions && this._segGrid;
    // 先记下这条 way 原来用到的节点：删掉之后，这些节点所在的格子要重算，
    // 而且这些节点上的其它 way 的路口密度也会变（要一起重算拥堵）
    const oldNodes = bus ? new Set(this.wayNodes.get(id) || []) : null;
    const touched = new Set();
    if (bus) {
      for (const nid of oldNodes) {
        const n = this.nodes.get(nid);
        if (n) for (const e of n.edges) if (e.wayId && e.wayId !== id) touched.add(e.wayId);
      }
      // 段索引里属于这条 way 的段全部摘掉
      for (const si of (this._segOfWay.get(id) || []).slice()) {
        if (this._segWay[si]) this._unindexSegment(si);
      }
    }
    // 先删掉这条 way 产生的所有边
    for (const n of this.nodes.values()) {
      if (n.edges.some((e) => e.wayId === id)) n.edges = n.edges.filter((e) => e.wayId !== id);
    }
    for (const [nid, n] of [...this.nodes]) {
      if (!n.edges.length) this.nodes.delete(nid);
    }
    this.wayNodes.delete(id);
    if (!row || row.deleted) {
      this.wayInfo.delete(id);
      if (bus) this._recomputeAfterEdit(id, touched, null);
      return { removed: true };
    }
    let tags = null;
    try { tags = row.tags ? JSON.parse(row.tags) : null; } catch { tags = null; }
    const info = this.railInfo(tags);
    if (!info) {
      this.wayInfo.delete(id);
      if (bus) this._recomputeAfterEdit(id, touched, null);
      return { removed: true };
    }
    const ids = this._st.wayNodes.all(id).map((r) => r.node_id);
    if (ids.length < 2) return { added: 0 };
    let added = 0;
    let wayLength = 0;
    let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
    const newNodes = new Set();
    for (let i = 1; i < ids.length; i++) {
      const a = this._st.nodeById.get(ids[i - 1]);
      const b = this._st.nodeById.get(ids[i]);
      if (!a || !b) continue;
      const length = metersBetween(a.lat, a.lon, b.lat, b.lon);
      if (length <= 0.01) continue;
      this._addEdge(a, b, length, info.speed, id, info.congestion);
      added += 1;
      wayLength += length;
      newNodes.add(a.id); newNodes.add(b.id);
      minLat = Math.min(minLat, a.lat, b.lat); maxLat = Math.max(maxLat, a.lat, b.lat);
      minLon = Math.min(minLon, a.lon, b.lon); maxLon = Math.max(maxLon, a.lon, b.lon);
    }
    this.wayInfo.set(id, {
      wayId: id, kind: info.kind, limit: info.limit, base: info.base == null ? info.congestion : info.base,
      dedicated: !!info.dedicated, layer: info.layer == null ? 0 : info.layer,
      minLat, maxLat, minLon, maxLon, lengthM: wayLength,
      junctions: 0, density: 0, congestion: info.congestion, speed: info.speed, degreeAvg: 0,
    });
    if (bus) this._recomputeAfterEdit(id, touched, newNodes);
    return { added, junctions: bus ? this.wayInfo.get(id).junctions : undefined };
  }

  /**
   * 编辑之后重算受影响格子里的相交关系（#15）与相关 way 的拥堵（#16）。
   * cells = 旧节点 ∪ 新节点所在的格子；只重算这些格子，代价与"这条路有多长"成正比。
   */
  _recomputeAfterEdit(wayId, touchedWays, newNodes) {
    const cells = new Set();
    const touch = (set) => {
      if (!set) return;
      for (const nid of set) {
        const n = this.nodes.get(nid);
        if (!n) continue;
        // 以节点为中心的 3×3 格：路口一定落在其中某个格子里
        const cx = Math.floor((n.lon * this._kx) / JUNCTION_CELL_M);
        const cy = Math.floor((n.lat * this._ky) / JUNCTION_CELL_M);
        for (let i = cx - 1; i <= cx + 1; i++) {
          for (let j = cy - 1; j <= cy + 1; j++) cells.add((i - this._cellOX) * 100000 + (j - this._cellOY));
        }
      }
    };
    touch(newNodes);
    // 新边的段索引
    if (newNodes) {
      for (const nid of newNodes) {
        const n = this.nodes.get(nid);
        if (!n) continue;
        for (const e of n.edges) {
          if (e.wayId !== wayId || !(n.id < e.to)) continue;
          const m = this.nodes.get(e.to);
          if (!m) continue;
          this._pushSegment(wayId, n.id, m.id, n.lat, n.lon, m.lat, m.lon, e.length, true);
        }
      }
    }
    const noder = cells.size ? this._noderCells([...cells].filter((k) => this._segGrid.has(k))) : null;
    // #16：这条 way + 它接到的那些 way，路口密度都可能变了
    const recompute = new Set([wayId, ...(touchedWays || [])]);
    if (newNodes) {
      for (const nid of newNodes) {
        const n = this.nodes.get(nid);
        if (n) for (const e of n.edges) if (e.wayId) recompute.add(e.wayId);
      }
    }
    for (const w of recompute) this._recomputeWayStats(w);
    this._applyCongestionToEdges();
    this._nodeCount = this.nodes.size;
    return noder;
  }

  /**
   * 找出离给定坐标最近的路网节点（用于车站吸附）。
   * 粗筛用等距圆柱近似（把经纬度差换成米），只对"可能入选"的节点做一次精确 Haversine；
   * maxMeters 传 Infinity（或不传第二、三个参数时给个大数）就返回全图最近的那个，
   * 用来量"到底有多远"（吸附失败时写进错误信息）。
   */
  nearestNode(lat, lon, maxMeters = 120) {
    const lim = Number.isFinite(maxMeters) ? maxMeters : Infinity;
    const kx = M_PER_DEG_LON_AT(lat);
    const ky = 110574;
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      const dx = (n.lon - lon) * kx;
      const dy = (n.lat - lat) * ky;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (!best) return null;
    // 粗筛就已经超过上限（留 2% 余量给近似误差）→ 直接判失败，省掉精确计算
    if (bestD > lim * 1.02) return null;
    const exact = metersBetween(lat, lon, best.lat, best.lon);
    if (exact > lim) return null;
    return { nodeId: best.id, lat: best.lat, lon: best.lon, distance: exact };
  }

  /**
   * 离给定坐标最近的**路段上的点**（公交站吸附用，#15b）。
   * 与 nearestNode 的区别：这里量的是"点到路段的垂距"，点在一条几百米长的直路中间也能吸上
   * （OSM 里一条直路常常几百米才一个节点，只按节点找会误判"300 米内没有路"）。
   * 返回 { nodeId, wayId, lat, lon, distance, t }：
   *   lat/lon 是路段上的投影点（公交站牌就立在这儿），nodeId 取该路段较近的那一端
   *   （车辆最终必须停在一个路网节点上），distance 是点到路的实测距离。
   */
  nearestRoadPoint(lat, lon, maxMeters = 300) {
    const lim = Number.isFinite(maxMeters) ? maxMeters : Infinity;
    const kx = M_PER_DEG_LON_AT(lat);
    const ky = 110574;
    let best = null;
    for (const n of this.nodes.values()) {
      const nx = (n.lon - lon) * kx;
      const ny = (n.lat - lat) * ky;
      for (const e of n.edges) {
        if (n.id > e.to) continue;              // 每条边只算一次（图里两个方向各存了一条）
        const m = this.nodes.get(e.to);
        if (!m) continue;
        const mx = (m.lon - lon) * kx;
        const my = (m.lat - lat) * ky;
        const dx = mx - nx;
        const dy = my - ny;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? -(nx * dx + ny * dy) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const px = nx + dx * t;
        const py = ny + dy * t;
        const d = Math.sqrt(px * px + py * py);
        if (best && d >= best.distance) continue;
        best = {
          distance: d,
          t,
          wayId: e.wayId == null ? null : e.wayId,
          nodeId: t <= 0.5 ? n.id : m.id,
          lat: lat + py / ky,
          lon: lon + px / kx,
        };
      }
    }
    if (!best || best.distance > lim) return null;
    return best;
  }

  /**
   * 从 fromNodeId 到 toNodeId 的最短路（按里程加权，速度用于估算时间）。
   * 返回 { nodes:[id...], lengthM, seconds } 或 { error }
   */
  shortestPath(fromNodeId, toNodeId, options = {}) {
    if (!this.nodes.size) return { error: '路网为空：请先在铁路上新建轨道' };
    const start = this.nodes.get(Number(fromNodeId));
    const goal = this.nodes.get(Number(toNodeId));
    if (!start) return { error: '起点不在轨道上' };
    if (!goal) return { error: '终点不在轨道上' };
    if (start.id === goal.id) return { nodes: [start.id], lengthM: 0, seconds: 0 };

    const maxExplore = options.maxExplore || 400000;
    const dist = new Map([[start.id, 0]]);
    const prev = new Map();
    const prevEdge = new Map();
    const visited = new Set();
    const heap = new Heap();
    heap.push(start.id, 0);
    let explored = 0;

    while (heap.size) {
      const top = heap.pop();
      const curId = top.item;
      if (visited.has(curId)) continue;
      visited.add(curId);
      if (curId === goal.id) break;
      if (++explored > maxExplore) return { error: '路网太大，寻路超出探索上限' };
      const cur = this.nodes.get(curId);
      if (!cur) continue;
      const base = dist.get(curId);
      for (const e of cur.edges) {
        if (visited.has(e.to)) continue;
        // 权重以里程为主、速度为辅：否则会为了抢一点点时间绕出很远的路
        // （比如 4.9 公里的直线被算成 14.7 公里的"更快的绕行"）
        const cost = base + e.length * (1 + 0.6 * (45 / Math.max(15, e.speed)));
        if (!dist.has(e.to) || cost < dist.get(e.to)) {
          dist.set(e.to, cost);
          prev.set(e.to, curId);
          prevEdge.set(e.to, e);
          heap.push(e.to, cost);
        }
      }
    }

    if (!prev.has(goal.id)) return { error: '两站之间没有连通的轨道' };
    const nodes = [goal.id];
    const edgeSpeeds = [];          // 与 nodes 对齐：edgeSpeeds[i] 是 nodes[i] → nodes[i+1] 那一段的限速
    let lengthM = 0;
    let seconds = 0;
    let cur = goal.id;
    const speeds = [];
    while (cur !== start.id) {
      const p = prev.get(cur);
      const e = prevEdge.get(cur);
      if (p === undefined || !e) break;
      lengthM += e.length;
      seconds += e.length / (e.speed / 3.6);
      speeds.push(e.speed);
      edgeSpeeds.push(e.speed);
      nodes.push(p);
      cur = p;
    }
    nodes.reverse();
    edgeSpeeds.reverse();
    speeds.sort((a, b) => a - b);
    const speed = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 60; // 取中位限速
    return { nodes, edgeSpeeds, lengthM: Math.round(lengthM), seconds: Math.round(seconds), speed };
  }

  /**
   * 依次串起多个站点，返回整条线路的路径。
   * 返回 { path:[nodeId], segments:[{from,to,lengthM,seconds,error}], lengthM, seconds }
   */
  routeThrough(stopNodeIds, options = {}) {
    const segments = [];
    let path = [];
    let speeds = [];
    let lengthM = 0;
    let seconds = 0;
    for (let i = 1; i < stopNodeIds.length; i++) {
      const from = stopNodeIds[i - 1];
      const to = stopNodeIds[i];
      const res = this.shortestPath(from, to, options);
      if (res.error) {
        segments.push({ from, to, error: res.error });
        return { path: [], speeds: [], segments, lengthM: 0, seconds: 0, error: `第 ${i} 段（${from} → ${to}）不通：${res.error}` };
      }
      segments.push({ from, to, lengthM: res.lengthM, seconds: res.seconds, nodes: res.nodes.length });
      if (path.length) {
        path = path.concat(res.nodes.slice(1));
        speeds = speeds.concat((res.edgeSpeeds || []).slice(1));
      } else {
        path = res.nodes.slice();
        speeds = (res.edgeSpeeds || []).slice();
      }
      lengthM += res.lengthM;
      seconds += res.seconds;
    }
    return { path, speeds, segments, lengthM: Math.round(lengthM), seconds: Math.round(seconds) };
  }

  /** 路径上每一点的坐标（给列车模拟用），带累计里程与"到下一段"的限速 */
  pathGeometry(nodeIds, speeds) {
    const out = [];
    let acc = 0;
    let prev = null;
    let i = 0;
    for (const id of nodeIds) {
      const n = this.nodes.get(id) || this._st.nodeById.get(id);
      if (!n) { i += 1; continue; }
      if (prev) acc += metersBetween(prev.lat, prev.lon, n.lat, n.lon);
      out.push({ id, lat: n.lat, lon: n.lon, distance: acc, speed: speeds && speeds[i] ? speeds[i] : null });
      prev = n;
      i += 1;
    }
    return out;
  }

  /** wayId → 坐标（虚拟路口节点不在 OSM 里，所以先从图里找） */
  nodeOf(nodeId) {
    const n = this.nodes.get(Number(nodeId));
    if (n) return { id: n.id, lat: n.lat, lon: n.lon, virtual: !!n.virtual, degree: n.edges.length };
    const row = this._st.nodeById.get(Number(nodeId));
    return row ? { id: row.id, lat: row.lat, lon: row.lon, virtual: false, degree: 0 } : null;
  }

  /** 某个图节点属于哪条 way（虚拟路口返回 0 / null：它不属于任何 OSM way） */
  wayOfNode(nodeId) {
    const n = this.nodes.get(Number(nodeId));
    if (n && n.virtual) return null;
    for (const n2 of [n]) {
      if (!n2) break;
      for (const e of n2.edges) if (e.wayId > 0) return e.wayId;
    }
    const row = this.db.prepare('SELECT way_id FROM way_nodes WHERE node_id = ? LIMIT 1').get(Number(nodeId));
    return row ? row.way_id : null;
  }

  /** 单个 way 的拥堵明细（客户端按 way 上色时逐条查） */
  wayStats(wayId) {
    const w = this.wayInfo.get(Number(wayId));
    if (!w) return null;
    return {
      wayId: w.wayId, kind: w.kind, limit: w.limit, speed: w.speed, congestion: w.congestion,
      junctions: w.junctions, density: w.density, lengthM: Math.round(w.lengthM),
      degreeAvg: w.degreeAvg, dedicated: !!w.dedicated, layer: w.layer,
    };
  }

  /**
   * 拥堵统计（全图）：给 /api/transit 的 stats 用。
   * 缓存起来 —— 广播每一帧都会取这个数，91k 条路不能每帧重算一遍；
   * 拥堵一变（_recomputeAllCongestion / _recomputeWayStats）就把缓存清掉。
   */
  congestionStats() {
    if (this._jamStats) return this._jamStats;
    let n = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let slowest = null;
    for (const w of this.wayInfo.values()) {
      n += 1;
      sum += w.congestion;
      if (w.congestion < min) min = w.congestion;
      if (w.congestion > max) max = w.congestion;
      if (!slowest || w.speed < slowest.speed) slowest = w;
    }
    this._jamStats = {
      ways: n,
      avgCongestion: n ? Math.round((sum / n) * 1000) / 1000 : 0,
      minCongestion: n ? min : 0,
      maxCongestion: n ? max : 1,
      junctions: this.junctionCount,
      virtualJunctions: this.virtualNodeCount,
      // 最慢的一条（市区最堵的路段长什么样）
      slowest: slowest ? { wayId: slowest.wayId, kind: slowest.kind, congestion: slowest.congestion, speed: slowest.speed, density: slowest.density } : null,
      densityScale: JUNCTION_DENSITY_SCALE,
      cellM: JUNCTION_CELL_M,
    };
    return this._jamStats;
  }

  /**
   * #16 视野内的"每条道路拥堵"（客户端用它给道路上色，作为一种新的显示模式）：
   * 返回每条可通行道路的拥堵系数 / 服务速度 / 限速 / 路口数 / 路口密度 / 长度。
   *   bbox        [minLon, minLat, maxLon, maxLat] 或 {minLat,maxLat,minLon,maxLon}
   *   limit       最多返回多少条（默认 4000，防止一次把全城的道路都吐出去）
   *   withCoords  是否带上道路折线（客户端可以直接画；默认 false，只给 wayId 让它自己去查）
   *   minCongestion 只返回拥堵系数小于等于这个值的道路（0.6 = 只看堵的）
   */
  congestionInBbox(minLon, minLat, maxLon, maxLat, options = {}) {
    const b = {
      minLon: Math.min(Number(minLon), Number(maxLon)),
      maxLon: Math.max(Number(minLon), Number(maxLon)),
      minLat: Math.min(Number(minLat), Number(maxLat)),
      maxLat: Math.max(Number(minLat), Number(maxLat)),
    };
    if (![b.minLon, b.maxLon, b.minLat, b.maxLat].every(Number.isFinite)) {
      return { error: 'bbox 参数不合法', ways: [] };
    }
    const limit = Math.max(1, Math.min(50000, Math.round(Number(options.limit) || 4000)));
    const maxJam = Number.isFinite(Number(options.minCongestion)) ? Number(options.minCongestion) : Infinity;
    const withCoords = options.withCoords === true;
    const coordCap = Math.max(0, Math.min(3000, Math.round(Number(options.coordLimit) || 1200)));
    const out = [];
    for (const w of this.wayInfo.values()) {
      if (!Number.isFinite(w.minLat) || w.maxLat < b.minLat || w.minLat > b.maxLat) continue;
      if (w.maxLon < b.minLon || w.minLon > b.maxLon) continue;
      if (w.congestion > maxJam) continue;
      out.push(w);
    }
    out.sort((x, y) => (x.congestion - y.congestion) || (x.wayId - y.wayId));   // 最堵的排前面
    const truncated = out.length > limit;
    const picked = out.slice(0, limit);
    const ways = picked.map((w) => {
      const item = {
        wayId: w.wayId, kind: w.kind, congestion: w.congestion, speed: w.speed, limit: w.limit,
        junctions: w.junctions, density: w.density, lengthM: Math.round(w.lengthM),
        degreeAvg: w.degreeAvg, dedicated: !!w.dedicated, layer: w.layer,
        // 3 档方便客户端直接分色：畅通 / 一般 / 拥堵
        level: w.congestion >= 0.75 ? 'free' : (w.congestion >= 0.5 ? 'busy' : 'jam'),
      };
      return item;
    });
    if (withCoords) {
      let n = 0;
      for (const item of ways) {
        if (n >= coordCap) break;
        item.coords = this.wayCoords(item.wayId);
        n += 1;
      }
    }
    return {
      mode: this.mode,
      bbox: b,
      count: ways.length,
      total: out.length,
      truncated,
      limit,
      withCoords,
      // 求和：视野内平均拥堵（客户端可以显示"这一片平均 0.62"）
      avgCongestion: ways.length ? Math.round((ways.reduce((a, w) => a + w.congestion, 0) / ways.length) * 1000) / 1000 : 0,
      stats: {
        junctions: this.junctionCount, virtualJunctions: this.virtualNodeCount,
        densityScale: JUNCTION_DENSITY_SCALE, cellM: JUNCTION_CELL_M,
      },
      ways,
    };
  }

  /** 一条 way 的折线坐标（按 OSM 节点顺序；虚拟路口只是把线段切开，不改折线本身） */
  wayCoords(wayId, maxPoints = 400) {
    let rows;
    try { rows = this._st.wayNodes.all(Number(wayId)); } catch { return []; }
    const out = [];
    for (const r of rows) {
      const n = this.nodes.get(r.node_id) || this._st.nodeById.get(r.node_id);
      if (!n) continue;
      out.push([Math.round(n.lat * 1e6) / 1e6, Math.round(n.lon * 1e6) / 1e6]);
      if (out.length >= maxPoints) break;
    }
    return out;
  }

  stats() {
    const s = {
      mode: this.mode,
      ways: this.wayCount,
      edges: this.edgeCount || 0,
      nodes: this.nodes.size,
      builtAt: this.builtAt,
      segments: this.segmentCount || 0,
    };
    // #15 / #16 的统计只在公交路网上有意义
    if (this.busJunctions) {
      s.virtualJunctions = this.virtualNodeCount;
      s.junctions = this.junctionCount;
      s.avgCongestion = this.congestionStats().avgCongestion;
    }
    return s;
  }
}

module.exports = {
  RailGraph, parseMaxSpeed, RUNNABLE, DEFAULT_SPEED, BUS_ROADS, BUS_FORBIDDEN,
  BUS_CONGESTION, URBAN_SPEED_CAP, SPEED_CAP_BY_CLASS, isDrivableHighway,
  BUS_ROAD_DEFAULT_SPEED, BUS_CONGESTION_DEFAULT,
  // #15 / #16：虚拟路口与拥堵定价用的常量与纯函数（测试与工具直接用）
  JUNCTION_DENSITY_SCALE, JUNCTION_CELL_M, JUNCTION_CONGESTION_MIN, LINK_WAY_ID,
  junctionCongestion, effectiveLayerOf, planarCrossing,
};
