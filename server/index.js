'use strict';
/**
 * 多人在线 OSM 编辑器 —— HTTP + WebSocket 服务器（零第三方依赖）
 *
 *   node server/index.js [--port 8787] [--data ./data] [--osm ./data/osm/osm.sqlite]
 *
 * 服务器自己持有一套 OSM 数据集（SQLite）：玩家看到的地图、改动的对象，都是这份数据。
 * 不连接、不修改 OpenStreetMap 官方数据库。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { Auth } = require('./auth');
const { OsmDB } = require('./osmdb');
const { OsmOps, OpError, GroupError, UndoBus } = require('./osmops');
const { RailGraph } = require('./railgraph');
const { Population } = require('./population');
const { Transit, TransitError, VEHICLE_KINDS, SPEEDS, CLOCK_BASE } = require('./transit');
const { attachWebSocketServer } = require('./websocket');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------- 配置 ------------------------------- */
/**
 * 游客登录关闭时的统一文案（HTTP 403 / WS 4004 / 端口日志都用这一句）。
 * 客户端 public/js/ui.js 的 UI.GUEST_OFF_HINT 与它逐字一致 —— 用户不管从哪条路撞上，
 * 看到的都是同一句中文。
 */
const GUEST_DISABLED_MESSAGE = '本服务器已关闭游客登录，请注册账号或使用已有账号登录';

/**
 * **游客登录开关（config.json 的 `allowGuests`），默认关闭。**
 *
 * 关闭时的行为（三条路都堵上，见下面各处调用点）：
 *   · `POST /api/guest`        → 403 + 上面那句中文
 *   · `Auth.guest()`           → 抛 AuthError('FORBIDDEN')（绕过 HTTP 直接调也进不来）
 *   · WebSocket `?guest=1`     → 升级握手阶段就 403（onWsConnection 里另有一道防御：
 *                                旧游客 token 也连不上）
 * 前端同时把「以游客身份先上任」按钮藏掉（读 /api/meta 的 allowGuests），`?guest=1` 也不再自动登录。
 *
 * 优先级：命令行 > 环境变量 > config.json > 默认 false
 *   node server/index.js --allow-guests          # 打开（测试用）
 *   node server/index.js --allow-guests=false    # 明确关闭
 *   node server/index.js --no-guests             # 明确关闭
 *   DSH_ALLOW_GUESTS=1 node server/index.js      # 打开
 *   { "allowGuests": true }                      # 打开
 *
 * 之所以留这个开关：tests/transit-e2e.js 与两个浏览器套件要批量造临时玩家
 *（几十个"游客xxxx"），逐个注册既慢又没意义 —— 它们各自拉起一台带 `--allow-guests`
 * 的测试实例，而正式运行的那台照旧只认注册账号。
 */
function resolveAllowGuests(argv, cfg) {
  const truthy = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === '' || s === '1' || s === 'true' || s === 'yes' || s === 'on';
  };
  const falsy = (v) => ['0', 'false', 'no', 'off'].includes(String(v == null ? '' : v).trim().toLowerCase());
  if (argv.includes('--no-guests')) return false;
  const i = argv.findIndex((a) => a === '--allow-guests' || a.startsWith('--allow-guests='));
  if (i >= 0) {
    const flag = argv[i];
    const eq = flag.indexOf('=');
    if (eq >= 0) return !falsy(flag.slice(eq + 1));               // --allow-guests=false
    if (falsy(argv[i + 1])) return false;                          // --allow-guests 0 / --allow-guests false
    return true;                                                   // --allow-guests [1|true|…]
  }
  const env = process.env.DSH_ALLOW_GUESTS;
  if (env != null && String(env).trim() !== '') return truthy(env);
  return cfg.allowGuests === true;                                 // 默认 false（config.json 里没写也关着）
}

function loadConfig() {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  let cfg = {};
  const cfgPath = argOf('config') || path.join(ROOT, 'config.json');
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    console.warn('[config] 读取失败，使用默认配置:', err.message);
  }
  const port = Number(argOf('port') || process.env.PORT || cfg.port || 8787);
  const dataDir = path.resolve(ROOT, argOf('data') || process.env.DATA_DIR || cfg.dataDir || 'data');
  const osmDb = path.resolve(ROOT, argOf('osm') || process.env.OSM_DB || cfg.osmDb || path.join(dataDir, 'osm', 'osm.sqlite'));
  return Object.assign({}, cfg, { port, dataDir, osmDb, allowGuests: resolveAllowGuests(argv, cfg) });
}

const config = loadConfig();
/** 游客登录是否允许（默认 false）。全文件只读这一个常量，别再各自去翻 config。 */
const ALLOW_GUESTS = config.allowGuests === true;
const LIMITS = Object.assign(
  {
    opsPer10s: 120,
    chatPer10s: 6,
    maxChatLength: 200,
    viewportLimit: 15000,
    // 视口查询的候选/条数上限（见 osmdb.js 的 QUERY_CAPS 与 queryBbox 的说明）：
    // 被上限砍掉的部分会在 /api/map 的 truncation 里如实报出来，客户端据此拆块。
    // 默认值是真实数据集上实测挑的：候选是懒取的，放宽上限几乎不花钱（详见 osmdb.js 的注释）。
    wayCandidates: 12,       // 候选 way 扫描上限 = viewportLimit × 这个倍数
    nodeCandidates: 8,       // 候选节点（只数带标签的）扫描上限 = viewportLimit × 这个倍数
    relationLimit: 10000,    // bbox 内关系的条数上限
    // 关系成员裁剪（#P0：拖地图 10 秒的根因是全城级关系把整个成员列表夹带进每个响应）：
    // 只有"成员数 > relationCropMinMembers 且没有环语义且不全在裁剪框内"的关系才会被裁，
    // 被裁的成员全部在裁剪框（= 请求 bbox 每边外扩 viewport 尺寸 × relationCropPad）之外。
    // 详见 osmdb.js 的 queryBbox / truncation.crop；裁剪量会如实记账，但不影响 complete。
    relationCropPad: 0.25,         // 裁剪框每边外扩比例（0 = 不外扩）
    relationCropMinMembers: 64,    // 成员数 ≤ 这个值的关系一律不裁（多面体建筑永远完整）
    relationCropBoundaryMembers: false,  // 是否连"纯行政边界"的成员也裁（默认否，见 osmdb.js 的规则说明）
    /**
     * 服务端 LOD（见 osmdb.js 开头「服务端 LOD」那一段）：跟客户端的**详细度档位**对齐。
     * 客户端默认档是 4 = 「标准」，它在 z≤15 一栋楼都不画、z16 只画重要建筑、z17 起才画普通建筑，
     * 而服务端以前照发（z15 一个视口 9237 条建筑 way / 6 万个节点，占 payload 一半）。
     *   lodDetail   4 = 标准（默认，与客户端默认档一致）；0/1 = 不筛（客户端「完整/全部道路」档）；
     *               2 = 精简；3 = 骨架（建筑一律不下发）
     *   lodMinFillArea  建筑面的面积门槛（m²，0 = 不按面积筛）：只想要"大建筑"时用
     * 请求级参数（/api/map?detail=0 / &minFillArea=500）优先于这里的默认值。
     * 被 LOD 扣下的条数如实记在 payload.truncation.lodFiltered / truncation.lod 里，**不算截断**
     * （kinds.ways.dropped 仍是 0）：那是"客户端本来就不画"，不是"少给了"。
     */
    lodDetail: 4,
    lodMinFillArea: 0,
    /**
     * **永不下发的类别**（树 / 自行车道，见 osmdb.js 开头「永不下发的类别」那一段）：默认**开**。
     * natural=tree / natural=tree_row / highway=cycleway 在任何缩放、任何档位下都不再下发
     * （人行道/步道与其余一切照旧）。用户口径："树、自行车道这类装饰性/用不上的东西纯粹是性能开销"。
     * 被它扣下的条数如实记在 truncation.lodFilteredBy.neverSend / truncation.lod.neverSend.*，**不算 dropped**。
     * 想回到"照旧全发"：这里写 false（或单次请求带 neverSend=0，用于 A/B 实测）。
     */
    neverSend: true,
    /**
     * 服务端**路网分级**（与客户端 `Render.roadClassTable()` 的 `serverSend` 同一张表；
     * 见 osmdb.js「服务端路网分级」那一段）。等级 rank：0 主干(motorway/trunk/primary) ·
     * 1 secondary · 2 tertiary · 3 支路(residential/unclassified/living_street/road) ·
     * 4 细路(service/track/footway/path…) · 5 未知等级。
     * 本表 = 客户端建议表**各降一档**（z12→0、z13→1、z14→2）：
     *   ≤12 → 0（只主干道）· 13 → 1（+secondary）· 14 → 2（+tertiary）· 15–18 → 4（全发）· ≥19 → 5
     * `detail=0/1`（客户端「完整 / 全部道路」档）时整表关掉，全部等级照发。
     * 被筛掉的次要道路记在 payload.truncation.lodFiltered / lodFilteredBy.roadClass /
     * lod.roadsWithheldByClass，**不算截断**；主干道（rank 0）/铁路/水系/水域/行政边界永不筛
     * （truncation.lod.roadsWithheld 恒 0）。
     * 想自己调分界点：写成一个对象按缩放覆盖，例如 { "12": 0, "13": 1, "14": 2 }。
     */
    roadSend: null,
    /**
     * 路网**基础地板**（每个 rank 最早在哪个缩放下发；永远生效，含 detail=0/1 的"完整"档）：
     *   trunk 9 · secondary 12 · tertiary 13 · minor 14 · **detail 16**
     * 细路（service/track/footway…）地板默认 **16**：z16 是城市常用档位，退回 17 会让玩家在 z16
     * 看不到人行道/服务道（实测那 500 KB 增量可接受）。需要时一键调：
     *   "limits": { "roadClassFloor": { "detail": 17 } }        ← 推荐写法
     *   "limits": { "roadClassZoom": { "detail": 17 } }         ← 旧名，同样生效
     * 生效值在 payload.truncation.lod.baseFloor 里回显。
     */
    roadClassFloor: null,
    /**
     * **低缩放几何合并**（见 osmdb.js 开头「低缩放几何合并」那一段）：
     * z < minZoom 时，把高条数类的 way 合并成"只有几何、没有 way id"的 displayLines
     * （客户端画它、不选它、不改它），于是 `ways` 字典里的条数不再被"主干道+铁路+水系"
     * 撑满 —— 这是"15000 条上限永不 binding"的关键（调大上限只是把阈值往后挪）。
     *   minZoom       15 = 编辑缩放（= osmdb.js 的 VIEW_ONLY_MAX_ZOOM + 1，"只看不改"边界在 z14）；
     *                 z ≥ 15 一条都不合并（真 way id 全部照旧下发），z ≤ 14 才进"只看不改"的档
     *   budget        合并后"逐条下发的 way 条数"要 ≤ viewportLimit × 这个比例（默认 0.5）
     *   minClassWays  一个样式类的可合并条数 ≥ 这个值才值得合并（默认 200）
     *   tolPx         Douglas–Peucker 简化容差（屏幕像素，默认 1）
     *   coordDigits   折线坐标小数位（默认 5 ≈ 1.1 m）
     * 想整个关掉：`"coalesce": { "on": false }`（回到"逐条下发"，上限就会重新 binding）。
     */
    coalesce: null,
    /**
     * **紧凑载荷**（见 osmdb.js 开头「紧凑载荷」那一段）：坐标量化 + 列式/delta 整数编码。
     * 只改"几何怎么写成 JSON"，不改任何语义：客户端在 World.mergePayload 入口一次展开回老形状，
     * 条数/账本/complete/dropped/coalesce 一个数都不变。实测一屏整框（1400×900）：
     *   z13 3038 → 1467 KB（每个节点 37.8 → 11.3 B，每条 way 256 → 175 B）
     *   z10 6255 → 2476 KB · z16 2049 → 1346 KB
     * 量化误差：z<16 用 1e-6°（≈0.11 m）· z≥16 用 1e-7°（≈1.1 cm，与改动前一致，无损）。
     * 想整包按老形状下发（对照/排查用）：`"compact": false`。
     */
    compact: true,
    /** 空间索引自检/自愈（见 osmdb.js 的 _auditSpatialIndexes）：
     * 导入器回填几何时把 way_index / relation_index 的第 5 列写成了 max_lon（笔误），
     * 导致视口查询失去"纬度下界"，把视口**南边**的 way 也全拉进候选（实测 17%~37%）。
     * 启动时抽样核对，发现整片不符就从基表重建索引（真实数据集一次性 2.4 秒）；健全的库一行不动。
     * 置 false 可以关掉（只读库/排查用）。
     */
    indexAudit: true,
    /**
     * **低缩放候选索引**（见 osmdb.js 的 _wayScanPlan / dbschema.js 的「道路等级 / 最低可见缩放」）：
     * way 上物化了两列 `road_class`（0 主干 … 4 细路 · 5 未知 · −1 非道路）与
     * `lod_zoom`（这条 way 最早在哪个缩放可见 = lodVisible 的阈值），配一个部分索引
     * `idx_ways_lod_zoom`。z ≤ 这个值时，候选扫描只碰"这一档看得见的 way"
     * （等级够的道路 + 铁路/水系/水域/行政边界例外），而不是把视口内 20~32 万行全读一遍再丢掉。
     * 默认 13 = 实测的交叉点（z10 1.6 s → 0.06 s；z14 起 R*Tree 更快，不换）。
     * 置 0 = 关掉（永远走 R*Tree，用于对照实测）；置 22 = 一直用。
     */
    wayLodIndexMaxZoom: 13,
    /**
     * 上面那两列的回填（幂等，启动时跑一次，跟空间索引自检同一位置）：
     * 已经填好就只抽 3000 行核对（零成本）；没填过/对不上（换过导入器、改过规则、上次被打断）
     * 就整表重填一遍（真实数据集 32 万行实测见 tests/tmp-lodidx/RESULTS-lodidx.md）。
     * **不需要重跑导入**：`ALTER TABLE ADD COLUMN` 是 O(1)，老库下次启动自动补列 + 回填。
     * sample 可以调抽检行数（0/负数会被当成 1 行）。
     */
    wayLodSample: 3000,
    /**
     * **低缩放 POI 计划**（见 osmdb.js 的 _nodePoiPlan）：z ≤ 这个值时，"带标签节点"的候选扫描
     * 走部分索引 idx_nodes_poi_low —— z10 一个视口里 10.57 万个带标签节点里只有 2150 个是
     * 这一档看得见的地名，改造前要把 10.57 万行全读出来再逐个丢掉（实测 1.17 s）。
     * 默认 15 = 实测交叉点（z16 起可见集合变成 amenity/shop/highway… 一大票，索引不再等价）。
     * 置 0 = 关掉（永远走 R*Tree，用于对照实测）。
     */
    nodePoiIndexMaxZoom: 15,
    /**
     * **视口要素统计**（`payload.stats`：视野内多少建筑 / 道路 / 水系 / 用地 / 铁路 + POI 数）
     * —— **默认不算、也不下发**（`stats` 字段整个不出现）。
     *
     * 它是 way 表上 5 条 `tags LIKE '%"key":%'` 的 SUM 扫描，真实数据集实测 **z10 ≈ 0.49 s ·
     * z13 ≈ 0.4 s**（低缩放档最贵的三项之一），而客户端渲染一个字节都不需要它：
     * 图层面板里那几行条数是客户端自己数本地要素（ui.js → `World.categoryCounts`），
     * 状态栏读的是 `Render.stats`，都不碰这个字段。所以默认关掉。
     *
     *   · 请求带 `&stats=1` → 算（工具 / 排查用）· `&stats=0` → 不算
     *   · 不带参数（或非法值）→ 用这里的默认值
     *
     * 与它无关、**照旧全量保留**的是那份"给全了没有"的条数账：`truncation`（kinds / payload /
     * coalesce / viewOnly / lod.roadsMissing …）—— 那是正确性证据，不是面子数字。
     */
    viewportStats: false,
    // 分组撤销（见 osmops.js 的 UndoBus）：beginGroup/endGroup 与 groupLabel 自动分组
    groupMaxDepth: 8,        // 分组最多嵌套几层
    groupMaxSteps: 500,      // 一组最多几条操作（超了自动收尾）
    groupIdleMs: 5000,       // groupLabel 自动分组：相邻操作间隔超过这么久就算新的一组
    groupTtlMs: 120000,      // 显式分组：这么久没动静就自动收尾
    // ── #广播按需（规模）───────────────────────────────────────────────────
    // 客户端上报的视口半径上限（米）：服务端按它取"这一帧给哪些车"。
    // 上限存在的理由是防御性的 —— 视口越大，这一帧要发的车越多（100 km 的视口
    // 会把整支车队都装进来，等于没做按需）。默认 12 km 足够覆盖"看一座城市"的镜头，
    // 再远的话玩家本来就只看得见线路示意图，看不见车。
    transitViewRadiusM: 12000,
    // 一个客户端的 sim 帧最多带多少辆车的实时数据（超出的按线路聚合；见 transit.vehicleFrame）
    transitFrameVehicles: 600,
  },
  config.limits || {}
);

fs.mkdirSync(path.dirname(config.osmDb), { recursive: true });
const db = new OsmDB(config.osmDb, {
  auditIndexes: LIMITS.indexAudit !== false,
  wayLodIndexMaxZoom: LIMITS.wayLodIndexMaxZoom,
  wayLodSample: LIMITS.wayLodSample,
  nodePoiIndexMaxZoom: LIMITS.nodePoiIndexMaxZoom,
});
// 分组撤销总线：OSM 编辑（ops）与交通玩法（transit）共用同一条时间线，
// 于是 beginGroup/endGroup（或 groupLabel）能把两边的一批操作合并成"一步"撤销/重做
const undoBus = new UndoBus({
  maxDepth: LIMITS.groupMaxDepth,
  maxParts: LIMITS.groupMaxSteps,
  idleMs: LIMITS.groupIdleMs,
  ttlMs: LIMITS.groupTtlMs,
});
const ops = new OsmOps(db, {
  maxCreateNodes: 5000, allowAnyRollback: !!config.allowAnyRollback,
  undoBus, src: 'osm',
});
const auth = new Auth(path.join(config.dataDir, 'users.json'), {
  sessionDays: config.sessionDays || 30,
  allowGuests: ALLOW_GUESTS,          // config.json 的 allowGuests（默认 false，见 resolveAllowGuests）
});
console.log(ALLOW_GUESTS
  ? '[auth] 游客登录：**已打开**（--allow-guests / DSH_ALLOW_GUESTS=1 / config.json allowGuests=true）'
  : '[auth] 游客登录：**已关闭**（config.json allowGuests=false）—— 只有 /api/register + /api/login 能拿到 token；'
    + ' 测试实例可以加 --allow-guests 或 DSH_ALLOW_GUESTS=1 打开');

/* --------------------- 铁路经营玩法（路网 / 人口 / 模拟） --------------------- */
const rail = new RailGraph(db, { mode: 'rail' });
const road = new RailGraph(db, { mode: 'bus' });
let roadGraphBuilt = false;
/**
 * 道路网按需构建（约 100 万个路段）。**启动时**走的是切片版 buildGraphSliced（见文件上方），
 * 这里这条同步路径只留给"启动时没有公交线路、后来玩家才新建第一条公交线"那种情况 ——
 * transit.js 的调用方要的是"立刻拿到图"，把它也变成异步要改 transit.js（不在本次范围内）。
 * 真实数据集上它是一次 10~18 秒的同步建图：端口开着，这段时间里的请求会排队。
 */
function ensureBusGraph() {
  if (roadGraphBuilt) return road;
  const t0 = Date.now();
  const stats = road.build();
  roadGraphBuilt = true;
  console.log(`[bus] 道路网构建完成（同步惰性路径，期间事件循环被占住）：${stats.ways} 条道路 / ${stats.edges} 段 / ${stats.nodes} 个节点（${stats.ms} ms）`);
  return road;
}
const population = new Population(db);
const transit = new Transit(db, {
  rail,
  ensureBusGraph,
  population,
  config: config.transit,
  // 选项名是 undoBus：Transit 里的 deps.bus 是"道路网"（公交用），两者不能混
  undoBus, src: 'transit',
  onChanged: () => scheduleTransitSync(true),
});
undoBus.attach('osm', ops);        // 两条通道挂到同一条总线上（分组才能跨两边）
undoBus.attach('transit', transit);
let transitReady = { rail: null, population: null, at: 0 };

/* ---------------------- 切片式建图（启动期间不锁事件循环） ---------------------- */
/**
 * 背景：`RailGraph.build()` 是一次**同步**的全量建图 —— 真实数据集实测铁路网 ≈ 0.8 s、
 * 道路网 ≈ 10~18 s（91873 条道路 / 107 万段 / 87 万个节点）。这段重活以前排在
 * `httpServer.listen()` **之前**：好处是"端口一开就是可用状态"，代价是**页面 12~22 秒打不开**。
 * 现在端口先开（见文件末尾的启动段），于是这段同步代码必须**切片**：否则端口开着、
 * 事件循环却被锁十几秒，浏览器发出的每个请求都排在后面（那正是"连上了却几十秒没人理"）。
 *
 * 做法（**不在 index.js 里复制 RailGraph 的建图逻辑**，只驱动它自己的方法与参数）：
 *   1. way 行按片供给：用 node:sqlite 的 `iterate()` 一片一片读（不把 9 万行一次全取进内存），
 *      把 `_st.railWays.all()` 临时换成"返回当前这一片"，再把 build() 开头那段"清理"
 *      （第二片起）临时变成空操作 —— 于是 build() **本身**被逐片反复调用，
 *      建边/wayInfo 那套语义与一次性 build() 完全同源，一个字段都不会漂。
 *   2. #15 虚拟路口：走 RailGraph 自己的 `_noderCells(cells)` 分批 —— `cells` 这个参数
 *      本来就是给增量更新用的（切开是幂等的；跨批次的交点靠"已经共用节点"规则复用，
 *      不会各切各的）。等价性由 `--graph-selfcheck` 在真实数据集上逐项核对。
 *   3. #16 拥堵：按 way 分批调 `_recomputeWayStats`（模块自己的方法）。
 *   4. 每片之间 `await setImmediate()`；片长按目标预算（`limits.graphSliceMs`，默认 12 ms）自适应。
 *
 * **切不开的三段**（它们在 railgraph.js 里是整段同步循环，从外面没有分批入口）如实计时，
 * 由 `--graph-selfcheck` 与启动日志打印出来：
 *   `_reindexSegments()`（107 万条边收成段 + 建网格）· `_rebuildEdgesFromSegments()`（按段表重铺边）
 *   · `_applyCongestionToEdges()`（把速度刷到 210 万条边上）。
 * 想把这三段也切了，得动 `server/railgraph.js`（本次任务的范围只有 index.js / osmdb.js / main.js）。
 */
const GRAPH_SLICE_MS = Math.max(4, Math.floor(Number(LIMITS.graphSliceMs)) || 12);
/** 每片之间让出事件循环（setImmediate 比 setTimeout(0) 少一次定时器开销，且同样插进 check 阶段） */
function yieldToLoop() { return new Promise((resolve) => setImmediate(resolve)); }

/**
 * 切片建图：语义等价于 `graph.build()`，但每片之间把事件循环让出去。
 * @returns {Promise<{ways:number, edges:number, nodes:number, ms:number,
 *   virtualJunctions:number, junctions:number, junctionMs:number, phases:object}>}
 */
async function buildGraphSliced(graph, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const budgetMs = Math.max(4, Number(opts.budgetMs) || GRAPH_SLICE_MS);
  const estimateMs = Math.max(200, Number(opts.estimateMs) || 12000);
  const t0 = Date.now();
  const st = graph._st && graph._st.railWays;
  if (!st || typeof st.all !== 'function' || typeof st.iterate !== 'function') {
    throw new Error('buildGraphSliced：这条语句不支持切片读取');
  }
  /** 各段耗时（如实记账，`--graph-selfcheck` 与启动日志都会打印） */
  const phases = { ways: 0, slices: 0, junctions: 0, congestion: 0, reindex: 0, rebuildEdges: 0, applyCongestion: 0, tail: 0 };
  const undo = [];
  const ownOf = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const patch = (obj, key, make) => {
    const orig = obj[key];
    const had = ownOf(obj, key);
    obj[key] = make(orig);
    undo.push(() => { if (had) obj[key] = orig; else delete obj[key]; });
  };
  const state = { allowClear: true };
  let origCountEdges = null;
  try {
    // ---- 1) build() 的输入：当前这一片 ----
    // ⚠ 先把**原始** all() 拿在手里，再把它换成"返回当前这一片"（顺序反了就会读到空数组）
    const origAll = st.all.bind(st);
    let slice = [];
    patch(st, 'all', () => () => slice);
    // ---- 2) build() 开头的"清理"：第一片照常清（= 新图开始），之后变成空操作（累积） ----
    for (const key of ['nodes', 'wayInfo', 'wayNodes', '_segOfWay']) {
      const map = graph[key];
      if (!map || typeof map.clear !== 'function') continue;
      patch(map, 'clear', (orig) => function clearSliced() {
        if (!state.allowClear) return undefined;
        return orig.call(this);
      });
    }
    // ---- 3) build() 收尾里"每片都会重跑一遍"的东西先关掉，最后统一算一次 ----
    patch(graph, '_countEdges', (orig) => { origCountEdges = orig; return () => 0; });
    if (graph.busJunctions) {
      patch(graph, '_buildJunctions', () => () => null);          // #15：挪到下面分批做
      patch(graph, '_recomputeAllCongestion', () => () => {});    // #16：挪到下面分批做
    }

    // ---- 4) 逐片调 build()：每批 way 行交给模块自己那段建图循环 ----
    /**
     * 行先**一次读完**再切片。曾经想用 node:sqlite 的 `iterate()` 一片片读（省内存），
     * 但那条游标在"期间还在同一个连接上跑别的语句"时不可靠：实测切片日志里行数越读越多
     * （10 分钟都读不完 10773 行的查询，见 tmp-verify/lateinit/ 的诊断），所以改成
     * 一次性 `all()` + 数组切片 —— 代价是**一段有界的同步读**（真实数据集实测：
     * 铁路 10773 行 169 ms · 道路 91873 行 0.3~0.8 s，打在日志里），换来的是确定的语义。
     */
    const rows = origAll();
    phases.rows = rows.length;
    if (!rows.length) return { ways: 0, edges: 0, nodes: 0, ms: Date.now() - t0, virtualJunctions: 0, junctions: 0, junctionMs: 0, phases };
    let batch = Math.max(25, Math.min(20000, Math.floor(Number(opts.batch)) || 300));
    let lastLogAt = Date.now();
    for (let at = 0; at < rows.length;) {
      const end = Math.min(rows.length, at + batch);
      slice = rows.slice(at, end);
      const tSlice = Date.now();
      graph.build();
      const used = Date.now() - tSlice;
      phases.ways += slice.length;
      phases.slices += 1;
      at = end;
      state.allowClear = false;
      // 片长自适应：偏慢就缩小、偏快就放大（片越大建得越快，但每次要让出事件循环）
      if (used > budgetMs * 1.5) batch = Math.max(25, Math.round(batch * (budgetMs / Math.max(1, used))));
      else if (used < budgetMs * 0.5) batch = Math.min(20000, Math.round(batch * 1.3) + 1);
      // 每 2 秒在日志里报一次进度（启动窗口里这是"到底在干什么"的唯一线索）
      if (Date.now() - lastLogAt > 2000) {
        lastLogAt = Date.now();
        console.log(`[init] 建图切片：${phases.ways}/${rows.length} 条 way / ${phases.slices} 片`
          + `（每片 ${batch} 行 · 上一片 ${used} ms · 已用 ${((Date.now() - t0) / 1000).toFixed(1)} s）`);
      }
      onProgress(Math.min(0.97, at / Math.max(1, rows.length)), { ways: phases.ways, slices: phases.slices, used });
      await yieldToLoop();
    }

    // ---- 5) #15 / #16：切片模式下被推迟的两段，用模块自己的分批入口补上 ----
    // ⚠ 先把"清理"恢复成正常行为：下面这些方法自己会调 wayNodes.clear() 之类
    //（切片期间的"clear 空操作"只是为了让 build() 能一片片累积，到这里就不需要了）。
    state.allowClear = true;
    if (graph.busJunctions) {
      let t = Date.now();
      graph._reindexSegments();                     // ← railgraph.js 里的整段同步循环（切不开）
      phases.reindex = Date.now() - t;
      const cells = [...graph._segGrid.keys()];
      /**
       * 每批处理多少格子：**必须是大批、少刀**。
       * 原因（实测踩到的坑）：`_noderCells(cells)` 每次调用结束时都会把**整张节点表**扫一遍
       * 清理"没边的虚拟路口"（`[...this.nodes.values()]`，真实数据集 48 万个节点）。所以
       * "把格子切成很小很多批"的代价是每次调用都要付这份固定开销 —— 一开始按 12 ms 目标自适应，
       * 结果批次被压到几十个格子，光这份收尾开销就吃掉了 **115 秒**（实测：
       * tmp-verify/lateinit/server-after.log 里"路口 114950 ms"）。
       * 现在改成按固定刀数切（默认 12 刀），每刀 = 总格子数 / 12：路口这一相的总时间从 115 s
       * 回到秒级，刀与刀之间仍然 await，事件循环照样有得跑。
       */
      const junctionSlices = Math.max(1, Math.min(64, Math.floor(Number(opts.junctionSlices)) || 12));
      const perCall = Math.max(1, Math.ceil(cells.length / junctionSlices));
      let ci = 0;
      while (ci < cells.length) {
        const tOne = Date.now();
        graph._noderCells(cells.slice(ci, ci + perCall));
        phases.junctions += Date.now() - tOne;
        phases.junctionCalls = (phases.junctionCalls || 0) + 1;
        ci += perCall;
        onProgress(0.97 + 0.02 * Math.min(1, ci / Math.max(1, cells.length)), { cells: ci, of: cells.length });
        await yieldToLoop();
      }
      t = Date.now();
      graph._rebuildEdgesFromSegments();            // ← 同样是整段同步循环（切不开）
      phases.rebuildEdges = Date.now() - t;
      // `_buildJunctions()` 的收尾三行：活着的虚拟路口数
      let v = 0;
      for (const n of graph.nodes.values()) if (n.virtual) v += 1;
      graph.virtualNodeCount = v;
      // #16：拥堵按 way 分批（每批之间让出事件循环）
      const wayIds = [...graph.wayInfo.keys()];
      let wi = 0;
      while (wi < wayIds.length) {
        const tW = Date.now();
        while (wi < wayIds.length && Date.now() - tW < budgetMs) graph._recomputeWayStats(wayIds[wi++]);
        phases.congestion += Date.now() - tW;
        onProgress(0.99, { congestion: wi, of: wayIds.length });
        await yieldToLoop();
      }
      t = Date.now();
      graph._applyCongestionToEdges();              // ← 整段同步循环（切不开）
      phases.applyCongestion = Date.now() - t;
      // 路口总数（图上度数 ≥ 3）：87 万个节点的循环，也切成几段
      let junctions = 0;
      let seen = 0;
      for (const n of graph.nodes.values()) {
        if (n.edges.length >= 3) junctions += 1;
        seen += 1;
        if ((seen & 16383) === 0) await yieldToLoop();
      }
      graph.junctionCount = junctions;
    }

    // ---- 6) 收尾：把 build() 结尾那几行补上（切片模式下被临时关掉了） ----
    const tTail = Date.now();
    graph.wayCount = graph.wayInfo.size;
    graph.edgeCount = origCountEdges ? origCountEdges.call(graph) : 0;
    graph.segmentCount = graph._segWay ? graph._segWay.filter((w) => w).length : 0;
    graph.builtAt = Date.now();
    if (graph.nodes.size > graph.maxNodes) {
      console.warn(`[rail] 路网节点过多（${graph.nodes.size}），已按上限截断`);
    }
    phases.tail = Date.now() - tTail;
    const ms = Date.now() - t0;
    return {
      ways: graph.wayCount, edges: graph.edgeCount, nodes: graph.nodes.size, ms,
      virtualJunctions: graph.virtualNodeCount, junctions: graph.junctionCount,
      junctionMs: phases.junctions, phases,
    };
  } finally {
    for (let i = undo.length - 1; i >= 0; i--) {
      try { undo[i](); } catch { /* 恢复失败不该影响启动 */ }
    }
  }
}

/**
 * 路网 / 人口 / 线路路径的初始化。**调用点在 httpServer.listen() 之后**（见文件末尾的启动段）：
 * 端口先开、静态页面先出，这些重活切片跑，期间 /api/* 一律 503 + 进度（/api/ready）。
 */
async function initTransitWorld() {
  const t0 = Date.now();
  setInitStage('rail');
  console.log('[transit] 开始初始化（端口已开，重活切片跑，不锁事件循环）：铁路网 / 道路网 / 线路路径 / 人口网格');
  const railStats = await buildGraphSliced(rail, {
    estimateMs: 1500, onProgress: (frac) => setInitProgress('rail', frac),
  });
  console.log(`[rail] 铁路网构建完成：${railStats.ways} 条轨道 / ${railStats.edges} 段 / ${railStats.nodes} 个节点（${railStats.ms} ms）`);
  // 道路网（公交线要用）也在这里建，但**切片**（只有真的存在公交线路时才值得花这 8~10 秒；
  // 实测 91873 条道路 / 107 万段 / 10.1 s）。纯铁路城市留到第一次用到公交时由
  // ensureBusGraph() 惰性建（transit.graph('bus') 会调它）—— 那条路是**同步**的，
  // 因为 transit.js 的调用方要的是"立刻拿到图"（把那条路也变成异步要改 transit.js）。
  if (needsBusGraph()) {
    setInitStage('road');
    try {
      const busStats = await buildGraphSliced(road, {
        estimateMs: 20000, onProgress: (frac) => setInitProgress('road', frac),
      });
      roadGraphBuilt = true;
      console.log(`[bus] 道路网构建完成：${busStats.ways} 条道路 / ${busStats.edges} 段 / ${busStats.nodes} 个节点（${busStats.ms} ms）`);
      console.log(`[bus] 分段耗时：${busStats.phases.slices} 片建边 · 段网格 ${busStats.phases.reindex} ms`
        + ` · 路口 ${busStats.phases.junctions} ms（切不开的一段见下） · 重铺边 ${busStats.phases.rebuildEdges} ms`
        + ` · 拥堵 ${busStats.phases.congestion + busStats.phases.applyCongestion} ms（其中刷边 ${busStats.phases.applyCongestion} ms）`
        + ` · 收尾 ${busStats.phases.tail} ms`);
    } catch (err) { console.error('[bus] 构建失败:', err.message); }
  }
  setInitStage('population');
  const cellCount = db.prepare('SELECT COUNT(*) AS c FROM population_cells').get().c;
  let popStats = null;
  if (cellCount === 0) {
    // ⚠ 首次启动的人口推算（Population.buildAll）是 population.js 里一次性的整段同步循环，
    // 从外面没有分批入口 —— 真实数据集上它是分钟级的，这一段会**整段**占着事件循环（端口开着、
    // 请求排在后面）。所以这里明确打一行日志：进度停在"人口网格"就是它。
    console.log('[pop] 首次启动：正在从 OSM 建筑/用地推算人口与岗位…'
      + '（population.js 的整段同步循环，这一段切不开，页面会在这期间停在"人口网格"）');
    popStats = population.buildAll();
    console.log(`[pop] 完成：${popStats.ways} 个地块 → ${popStats.population} 人 / ${popStats.jobs} 个岗位 / ${popStats.cells} 个网格（${(popStats.ms / 1000).toFixed(1)} s）`);
  } else {
    popStats = population.totals();
    console.log(`[pop] 已有人口网格：${popStats.population} 人 / ${popStats.jobs} 个岗位 / ${popStats.cells} 格`);
  }
  setInitStage('paths');
  const t1 = Date.now();
  // ⚠ 线路路径全量重建（transit.js 的 onRailChanged）同样是那边的整段同步循环（实测 0.3~1 s），
  // 从 index.js 没有分批入口；如实计时打印。
  const out = transit.onRailChanged();      // 铁路网建好了：全量重建一次线路路径（不是增量）
  transitReady = { rail: railStats, population: popStats, at: Date.now() };
  scheduleTransitSync(true);
  console.log(`[transit] 初始化完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} s`
    + `（其中线路路径 ${out.ms} ms / ${out.rebuilt} 条 · 建网 ${t1 - t0} ms）`);
}
let transitSyncTimer = null;
let transitSyncFull = false;
function scheduleTransitSync(full = false) {
  if (full) transitSyncFull = true;
  if (transitSyncTimer) return;
  transitSyncTimer = setTimeout(() => {
    transitSyncTimer = null;
    const payload = transit.snapshot();
    const msg = transitSyncFull ? { t: 'transitSync', full: true, data: payload } : { t: 'transitSync', full: false, data: payload };
    transitSyncFull = false;
    broadcast(msg);
  }, 120);
}

function onOsmWaysChangedOld() { /* 已废弃 */ }

/** OSM 改动后同步到路网与人口网格（可能是轨道/道路改了，也可能是建筑改了） */
const onOsmWaysChanged = (() => {
  const dirty = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    const ids = [...dirty];
    dirty.clear();
    let netTouched = false;
    let areaTouched = false;
    for (const id of ids) {
      try {
        population.touchWay(id);
        // 用地区块变了要重算"活跃度"图层（建筑只影响人口网格，不影响活跃度）
        if (population.wayAffectsActivity(id)) areaTouched = true;
        const info = rail.updateWay(id);
        if (info && (info.added || info.removed)) netTouched = true;
        if (roadGraphBuilt) {
          const info2 = road.updateWay(id);
          if (info2 && (info2.added || info2.removed)) netTouched = true;
        }
      } catch (err) {
        console.warn('[sync] 更新派生数据失败', id, err.message);
      }
    }
    if (areaTouched) population.invalidateActivity();
    // 路网动了：只把"路径真的踩到这些 way"的线路重建一遍（旧版是全清 + 全部线路重算）。
    // 这里把这次动到的 way id 交给 transit —— 它自己按 way 的包围盒挑受影响的那几条。
    if (netTouched) {
      const r = transit.onRailChanged(ids);
      if (r.ms > 250 || r.rebuilt) {
        console.log(`[sync] 路网改动 ${ids.length} 条 way → 重建 ${r.rebuilt} 条线路路径（${r.ms} ms）`
          + `${r.odDropped ? ' · O/D 需求表已作废' : ' · 站点里程没变，O/D 表保留'}`);
      }
    }
    scheduleTransitSync(true);
  };
  return (wayIds) => {
    for (const id of wayIds) dirty.add(Number(id));
    if (timer) return;
    timer = setTimeout(flush, 600);
  };
})();

function extractChangedWays(opList) {
  const ids = [];
  for (const op of opList || []) {
    if (op.k === 'wayCreate' || op.k === 'wayUpdate') ids.push(op.way.id);
    else if (op.k === 'wayDelete') ids.push(op.id);
  }
  return ids;
}

/** 给前端的交通玩法配置（造价、票价、车辆类型等） */
function publicTransitConfig() {
  return {
    economy: !!transit.config.economy,
    startingCash: transit.config.startingCash,
    stationCost: transit.config.stationCost,
    costPerMeter: transit.config.costPerMeter,
    vehicleBaseCost: transit.config.vehicleBaseCost,
    vehiclePerCarCost: transit.config.vehiclePerCarCost,
    maintenancePerCarPerDay: transit.config.maintenancePerCarPerDay,
    fareBase: transit.config.fareBase,
    farePerKm: transit.config.farePerKm,
    dwellSeconds: transit.config.dwellSeconds,
    patienceSeconds: transit.config.patienceSeconds,
    serviceHours: transit.config.serviceHours,
    minGapMeters: transit.config.minGapMeters,
    // ── 时间基准（#时间倍率语义）─────────────────────────────────────────────
    // 倍速是"**实时时间**的倍数"：×1 就是 1 实时秒 = 1 游戏秒（1:1 真实时间）。
    // 老版本是"1 实时秒 = 1 游戏分钟"，所以老版本的 ×1 = 现在的 ×60、老 ×5 = 现在的 ×300。
    // config.transit 里的 dwellSeconds / patienceSeconds / serviceHours 等一律是
    // **游戏秒 / 游戏小时**，与倍速无关。
    clockBase: CLOCK_BASE,
    clockSpeeds: SPEEDS,
    // 方便前端直接显示："×60 → 现实 1 秒 = 游戏 1 分钟"
    clockSpeedNotes: SPEEDS.map((s) => (s === 0 ? '暂停' : `×${s} = 现实 1 秒 = 游戏 ${s} 秒`)),
    vehicleKinds: VEHICLE_KINDS,
    // ── #广播按需（规模）───────────────────────────────────────────────────
    // 客户端把地图视口报上来（`{t:'view', lat, lon, radiusM, zoom}`，或者 move 里带 radiusM），
    // 服务端就只发"它看得见的车 + 它自己的车"，视口外的车按线路给条数（sim 帧的 lineCounts）。
    // 没上报过视口的客户端照旧收完整车队（老行为），所以这是**纯增益、可选**的协议。
    sim: {
      viewportRadiusM: transit.config.viewportRadiusM,
      maxViewportRadiusM: LIMITS.transitViewRadiusM,
      vehicleFrameLimit: transit.config.vehicleFrameLimit,
      lineCounts: !!transit.config.frameIncludeLineCounts,
      // ⚠ 这里写字面量 250，不引用 SIM_INTERVAL_MS：那个 const 在文件后面才声明
      // （publicTransitConfig 是函数、调用时机在连接时，但 const 的 TDZ 会让人误判可读性）。
      intervalMs: 250,
    },
  };
}

const dataInfo = db.info();
if (db.isEmpty()) {
  console.warn('');
  console.warn('  ⚠️   OSM 数据库还是空的，先导入数据再打开网页：');
  console.warn('      node tools/import-osm.js --file data/osm/Beijing.osm.gz --db ' + path.relative(ROOT, config.osmDb));
  console.warn('');
}

/* --------------------------- 会话 / 在线状态 --------------------------- */
const sessions = new Map(); // conn -> session
let presenceTimer = null;
let infoTimer = null;

function onlinePlayers() {
  const out = [];
  for (const s of sessions.values()) {
    out.push({
      id: s.userId, name: s.name, color: s.color,
      lat: s.lat, lon: s.lon,
      select: s.select || null,
    });
  }
  return out;
}

/**
 * 可以"只留最新一份"的整份状态广播：客户端要的是**现在长什么样**，不是 15 秒的动画。
 * 这些消息给 websocket.js 一个 slot 名，背后追上水位（客户端一时读不动）时同一 slot 只保留
 * 最新的一份，过期的直接丢掉 —— 这样慢客户端不会在自己的连接上堆出几 MB 旧帧，
 * 也就不再把它自己发来的 op 的 ack 埋到超时后面（旧版就是这么产生"服务器响应超时"的）。
 * 不在这张表里的一律当控制帧（ack / transitAck / pong / ops / chat / sys / welcome /
 * lockResult）：永远优先发出去，一份都不丢。
 *
 * slot 按消息类型分（不同类型互不顶替）。transitSync 的 slot 里带上 full 标志：
 * 整份快照（full，改完东西要重绘面板）只被后来的整份快照顶替，不会被精简版顶掉。
 */
function frameSlot(obj) {
  if (obj.t === 'transitSync') return `transitSync:${obj.full === false ? 'slim' : 'full'}`;
  return REPLACEABLE_FRAMES.has(obj.t) ? obj.t : null;
}
const REPLACEABLE_FRAMES = new Set(['sim', 'players', 'info', 'locks', 'transitSync']);

function broadcast(obj, exceptConn) {
  const text = JSON.stringify(obj);
  const slot = frameSlot(obj);
  const opts = slot ? { slot } : null;
  let superseded = 0;
  for (const conn of sessions.keys()) {
    if (conn === exceptConn) continue;
    const before = conn.droppedFrames + conn.replacedFrames;
    try { conn.send(text, opts); } catch { /* ignore */ }
    // 这个客户端的这一帧被"更新的一份"顶掉/丢掉了（背压合并）：调用方据此知道有人没收到
    if (conn.droppedFrames + conn.replacedFrames > before) superseded += 1;
  }
  return superseded;
}

function schedulePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    broadcast({ t: 'players', players: onlinePlayers() });
  }, 120);
}

function scheduleInfo() {
  if (infoTimer) return;
  infoTimer = setTimeout(() => {
    infoTimer = null;
    broadcast({ t: 'info', info: db.info(), locks: ops.locksSnapshot() });
  }, 400);
}

function rateLimited(bucket, max) {
  const now = Date.now();
  while (bucket.length && now - bucket[0] > 10000) bucket.shift();
  if (bucket.length >= max) return true;
  bucket.push(now);
  return false;
}

/**
 * 撤销/重做的深度与"当前分组"，放进每个 ack / pong 里。
 * undoDepth 给的是**总数**（OSM 编辑 + 交通玩法 + 已收尾的分组），因为玩家心里只有一条时间线：
 * 一次「生成示例线路与车辆」= 12 条操作 = 1 步。明细在 undoBySource 里。
 * group 是"当前开着的分组"（没有就是 null），客户端可以直接显示 group.undoLabel。
 */
function undoState(user) {
  const depths = undoBus.depths(user);
  const group = undoBus.frameInfo(user);
  return {
    undoDepth: depths.total,
    redoDepth: depths.redo.total,
    undoBySource: { osm: depths.osm, transit: depths.transit, group: depths.group },
    redoBySource: { osm: depths.redo.osm, transit: depths.redo.transit, group: depths.redo.group },
    undoLabel: group ? group.undoLabel : null,
    group,
  };
}

/* ------------------------------ WebSocket ------------------------------ */
function onWsConnection(conn, req) {
  const url = new URL(req.url, 'http://localhost');
  const user = auth.userByToken(url.searchParams.get('token') || '');
  if (!user) {
    conn.sendJSON({ t: 'error', message: '登录状态已失效，请重新登录', fatal: true });
    conn.close(4001, 'unauthorized');
    return;
  }
  /**
   * 游客通道关闭时的第二道闸（第一道是升级握手里的 `?guest=1` 403）：
   * 手上还捏着**以前发的**游客 token 的客户端也一律挡下 —— 否则"关掉游客登录"就只是
   * 挡住了新游客，旧的照旧能进来。
   */
  if (!ALLOW_GUESTS && user.guest) {
    conn.sendJSON({ t: 'error', message: GUEST_DISABLED_MESSAGE, code: 'GUESTS_DISABLED', fatal: true });
    conn.close(4004, 'guests-disabled');
    return;
  }
  if (sessions.size >= (config.maxPlayers || 64)) {
    conn.sendJSON({ t: 'error', message: '服务器人数已满，请稍后再试', fatal: true });
    conn.close(4002, 'full');
    return;
  }
  // 初始化没完：**升级握手就已经被 503 挡掉了**（见 httpServer 上的 upgrade 闸门），
  // 正常流程走不到这里。留着是防御：万一闸门被拆了，也立刻说清楚，别让客户端等 op 超时。
  if (!initState.done) {
    conn.sendJSON({
      t: 'error', fatal: true,
      message: initState.error ? `初始化失败：${initState.error}` : '正在初始化路网…，请稍后重试',
    });
    conn.close(4003, 'initializing');
    return;
  }

  const changesetId = ops.newSession(user, `${user.name} 在 OSM 城市在线编辑`);
  const session = {
    userId: user.id, name: user.name, color: user.color,
    lat: config.defaultCenter.lat, lon: config.defaultCenter.lng,
    select: null, changesetId, opBucket: [], chatBucket: [], transitBucket: [], ts: Date.now(),
  };
  sessions.set(conn, session);
  const myCompany = transit.ensureCompany(user);

  conn.sendJSON({
    t: 'welcome',
    user: { id: user.id, name: user.name, color: user.color, guest: !!user.guest },
    info: db.info(),
    locks: ops.locksSnapshot(),
    players: onlinePlayers(),
    changesetId,
    history: db.recentChangesets(30),
    transit: Object.assign(transit.snapshot(), { myCompanyId: myCompany ? myCompany.id : null }),
    transitReady,
    config: {
      defaultCenter: config.defaultCenter,
      limits: LIMITS,
      allowAnyRollback: !!config.allowAnyRollback,
      // 游客通道是否可用（默认 false）：客户端据此决定露不露「以游客身份先上任」
      allowGuests: ALLOW_GUESTS,
      transit: publicTransitConfig(),
    },
    serverTime: Date.now(),
  });
  broadcast({ t: 'sys', text: `${user.name} 进入了编辑室`, ts: Date.now() }, conn);
  schedulePresence();
  console.log(`[ws] ${user.name} 上线（在线 ${sessions.size}）`);

  conn.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw); } catch {
      conn.sendJSON({ t: 'error', message: '消息不是合法 JSON' });
      return;
    }
    try {
      handleMessage(conn, session, user, msg);
    } catch (err) {
      conn.sendJSON({ t: 'error', message: '服务器处理失败：' + err.message });
    }
  });

  conn.on('close', () => {
    sessions.delete(conn);
    ops.releaseLocks(user.id);
    transit.dropPlayerView(session.userId);      // #广播按需：视口跟着连接一起走
    broadcast({ t: 'sys', text: `${user.name} 离开了编辑室`, ts: Date.now() });
    broadcast({ t: 'locks', locks: ops.locksSnapshot() });
    schedulePresence();
    console.log(`[ws] ${user.name} 下线（在线 ${sessions.size}）`);
  });
}

/**
 * #广播按需：记下这个客户端的视口。由 `{t:'view', lat, lon, radiusM, zoom}` 触发
 * （以及作为兼容兜底的 `move`）。半径上限取 LIMITS.transitViewRadiusM。
 *
 * ⚠ 只有**客户端真的上报过**才会有视口。没上报过的会话在 transit.frameFor 里走
 * "发完整车队"那条老路 —— 也就是说"视口裁剪"是纯增益、可选启用的，
 * 老客户端（只发 move 的老版本、或者只发 ping 的脚本）永远看得到全部车，
 * 不会出现"地图上突然一辆车都没有"。
 */
function setSessionView(session, view) {
  if (!session || !view) return null;
  const lat = Number(view.lat);
  const lon = Number(view.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const radiusM = Math.max(
    200,
    Math.min(LIMITS.transitViewRadiusM || 12000, Number(view.radiusM) || transit.config.viewportRadiusM)
  );
  session.view = {
    lat: Math.max(-90, Math.min(90, lat)),
    lon: Math.max(-180, Math.min(180, lon)),
    radiusM,
    zoom: view.zoom == null ? null : Number(view.zoom),
    at: Date.now(),
  };
  transit.setPlayerView(session.userId, session.view);
  return session.view;
}

function handleMessage(conn, session, user, msg) {
  if (!msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'ping':
      ops.refreshLocks(user.id);
      conn.sendJSON(Object.assign({ t: 'pong', ts: msg.ts || Date.now() }, undoState(user)));
      return;

    case 'move':
      if (typeof msg.lat === 'number' && typeof msg.lon === 'number') {
        session.lat = Math.max(-90, Math.min(90, msg.lat));
        session.lon = Math.max(-180, Math.min(180, msg.lon));
        // #广播按需：老的 `move` 消息就是"我现在看这一带"的信号（鼠标/中心），
        // 所以顺手当作视口用（半径按默认值或客户端给的 viewRadiusM）。
        // 新客户端可以发更准的 {t:'view', lat, lon, radiusM, zoom}（见下一个 case）。
        if (msg.radiusM == null || typeof msg.radiusM === 'number') {
          setSessionView(session, {
            lat: session.lat, lon: session.lon,
            radiusM: msg.radiusM == null ? msg.viewRadiusM : msg.radiusM,
            zoom: msg.zoom,
          });
        }
        schedulePresence();
      }
      return;

    /**
     * #广播按需：客户端上报地图视口（中心 + 半径 + 缩放）。
     * 服务端据此只发"视口内 + 自己的车"，视口外的按线路聚合 —— 1 万辆车时这是
     * "每帧 2 MB × 每个玩家" 与 "每帧几十 KB" 的区别。消息是**可选**的：
     * 没发过的客户端照旧收完整车队（老行为），所以新旧客户端都能连。
     */
    case 'view':
      setSessionView(session, msg);
      return;

    case 'select':
      session.select = msg.id ? { type: String(msg.type), id: Number(msg.id) } : null;
      schedulePresence();
      return;

    case 'lock': {
      const type = String(msg.elemType || '');
      const id = Number(msg.id);
      if (!['node', 'way', 'relation'].includes(type) || !Number.isFinite(id)) return;
      const res = ops.lock(type, id, user, msg.on !== false);
      conn.sendJSON({ t: 'lockResult', elemType: type, id, ...res });
      broadcast({ t: 'locks', locks: ops.locksSnapshot() });
      return;
    }

    case 'chat': {
      if (rateLimited(session.chatBucket, LIMITS.chatPer10s)) {
        conn.sendJSON({ t: 'error', message: '发言太快了，慢一点～' });
        return;
      }
      const text = String(msg.text == null ? '' : msg.text).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.maxChatLength);
      if (!text) return;
      broadcast({ t: 'chat', from: { id: user.id, name: user.name, color: user.color }, text, ts: Date.now() });
      return;
    }

    case 'op': {
      if (rateLimited(session.opBucket, LIMITS.opsPer10s)) {
        conn.sendJSON({ t: 'ack', id: msg.id, ok: false, error: '操作太快了，服务器需要喘口气' });
        return;
      }
      try {
        const result = ops.apply(user, msg.op, { changesetId: session.changesetId });
        conn.sendJSON(Object.assign({
          t: 'ack', id: msg.id, ok: true, ops: result.ops || [], label: result.label,
          created: result.created || null,
          merged: result.merged || null,
          // 分组信息：beginGroup/endGroup 的 ack 里有 group，普通操作里给"当前分组"
          group: result.group || undoBus.frameInfo(user),
        }, undoState(user)));
        broadcast({
          t: 'ops', ops: result.ops || [], label: result.label, changesetId: session.changesetId,
          by: { id: user.id, name: user.name, color: user.color }, ts: Date.now(),
        }, conn);
        // OSM 改动会影响派生数据：轨道变了要重算路网，建筑变了要重算人口
        const changedWays = extractChangedWays(result.ops);
        if (changedWays.length) onOsmWaysChanged(changedWays);
        scheduleInfo();
      } catch (err) {
        const message = err instanceof OpError || err instanceof GroupError ? err.message : '操作失败：' + err.message;
        /**
         * 失败回执里带上错误码，以及**版本冲突的结构化回执**（`err.conflict`）：
         * { type, id, version, editorName, yourVersion, index? }。
         * 客户端据此知道该刷新哪个元素、服务端现在的版本是多少，刷新后自动重放一次
         * （见 server/osmops.js 的 conflictInfo 与 editor.js 的「版本冲突自愈」）。
         * `error` 那句中文一个字都没改，老客户端照旧能显示。
         */
        conn.sendJSON(Object.assign(
          { t: 'ack', id: msg.id, ok: false, error: message, code: err.code || 'ERROR' },
          err.conflict ? { conflict: err.conflict } : null,
        ));
        /**
         * 批量操作**中途失败**时，出错下标之前的子操作已经真的写进库了
         * （见 osmops.js 的 _batch：逐条 apply，不是事务）。
         * 那几条的广播条目在 `err.conflict.appliedOps` 里：
         *   - 作者端从上面的 ack 里拿，先把本地画面同步成真实状态，再从第 index 条重放；
         *   - **其他玩家不在那次 ack 的收件人里**，这里不补发，他们就会一直停在旧几何上，
         *     直到自己碰巧重新拉一次视口 —— 于是出现"我看不到他已经改了"的分歧。
         * 所以单独广播一次，并排除作者端（它已经按 ack 自己应用过了，避免重复应用）。
         * 派生数据（轨道→路网、建筑→人口）与整批成功时同样要跟着更新。
         */
        const appliedPrefix = err && err.conflict && Array.isArray(err.conflict.appliedOps)
          ? err.conflict.appliedOps : null;
        if (appliedPrefix && appliedPrefix.length) {
          broadcast({
            t: 'ops', ops: appliedPrefix, label: (msg.op && msg.op.label) || '批量编辑',
            changesetId: session.changesetId,
            by: { id: user.id, name: user.name, color: user.color }, ts: Date.now(),
          }, conn);
          const appliedWays = extractChangedWays(appliedPrefix);
          if (appliedWays.length) onOsmWaysChanged(appliedWays);
          scheduleInfo();
        }
      }
      return;
    }

    case 'transit': {
      if (rateLimited(session.transitBucket, 60)) {
        conn.sendJSON({ t: 'transitAck', id: msg.id, ok: false, error: '操作太快了，服务器需要喘口气' });
        return;
      }
      try {
        const result = transit.apply(user, msg.op);
        conn.sendJSON(Object.assign({
          t: 'transitAck', id: msg.id, ok: true, result,
          company: transit.companyPublic(transit.ensureCompany(user)),
        }, undoState(user)));
        scheduleTransitSync(true);
      } catch (err) {
        const message = err instanceof TransitError || err instanceof GroupError ? err.message : '操作失败：' + err.message;
        conn.sendJSON({ t: 'transitAck', id: msg.id, ok: false, error: message, code: err.code || 'ERROR' });
      }
      return;
    }

    default:
      conn.sendJSON({ t: 'error', message: '未知消息类型：' + msg.t });
  }
}

/* ------------------------------- HTTP ------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** 小于这个字节数的 JSON 不值得压缩（压缩后可能更大，还要多花 CPU/一次往返） */
const GZIP_MIN_BYTES = 1024;

/** 解析 Accept-Encoding，判断客户端是否愿意接收 gzip（`gzip;q=0` 视为不接受） */
function acceptsGzip(req) {
  const raw = req && req.headers ? req.headers['accept-encoding'] : '';
  if (!raw) return false;
  for (const part of String(raw).split(',')) {
    const bits = part.trim().split(';');
    const coding = bits[0].trim().toLowerCase();
    if (coding !== 'gzip' && coding !== '*') continue;
    let q = 1;
    for (let i = 1; i < bits.length; i++) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(bits[i]);
      if (m) q = Number(m[1]);
    }
    if (!(q > 0)) continue; // 显式拒绝（gzip;q=0）
    return true;
  }
  return false;
}

/** 统一的 JSON 收尾：保持原有的 Content-Type / Cache-Control 与状态码不变 */
function writeJSON(res, req, status, body, gzipped) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  if (gzipped) headers['Content-Encoding'] = 'gzip';
  res.writeHead(status, headers);
  // HEAD 不发送 body，但保留 Content-Length（等于 GET 时会发送的字节数）
  if (req && req.method === 'HEAD') res.end();
  else res.end(body);
}

function sendJSON(res, status, obj) {
  const req = res.req || null;
  const body = Buffer.from(JSON.stringify(obj), 'utf8');

  // 204/304 不允许有 body，也不该带 Content-Length
  if (status === 204 || status === 304) {
    res.writeHead(status, { 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' });
    res.end();
    return;
  }

  // 视口数据动辄几百 KB：走异步 gzip，避免在多人游戏里长时间阻塞事件循环
  if (body.length >= GZIP_MIN_BYTES && acceptsGzip(req)) {
    zlib.gzip(body, (err, gz) => {
      if (res.writableEnded || res.destroyed) return; // 客户端已断开
      if (err || !gz || gz.length >= body.length) { writeJSON(res, req, status, body, false); return; }
      writeJSON(res, req, status, gz, true);
    });
    return;
  }

  writeJSON(res, req, status, body, false);
}

async function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function clientIp(req) {
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function requireUser(req, res, url) {
  const user = auth.userByToken(bearerToken(req) || url.searchParams.get('token'));
  if (!user) {
    sendJSON(res, 401, { error: '未登录' });
    return null;
  }
  /**
   * 与 WebSocket 那两道闸**同一个口径**（见 handleConnection 里的 `!ALLOW_GUESTS && user.guest`）：
   * 关掉游客登录之后，手上还捏着**以前发的**游客 token 的客户端，在 HTTP 侧也必须被挡下。
   * 老代码这里只查"token 能不能解析出用户"，于是 `allowGuests: false` 之后旧游客 token
   * 照样能读 /api/map、/api/transit、/api/element… 全部只读接口
   *（编辑走 WS、被握手挡住，所以表现成"半个关闭"：看得到、改不了，很容易被当成正常）。
   * 口径不一致本身就是个坑：一处改了、另一处忘了，就会出现"以为关了其实没关"。
   */
  if (!ALLOW_GUESTS && user.guest) {
    sendJSON(res, 403, { error: GUEST_DISABLED_MESSAGE, code: 'GUESTS_DISABLED' });
    return null;
  }
  return user;
}

function parseBbox(url) {
  const q = url.searchParams;
  const nums = ['minLon', 'minLat', 'maxLon', 'maxLat'].map((k) => Number(q.get(k)));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = nums;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  return {
    minLon: Math.max(-180, minLon), maxLon: Math.min(180, maxLon),
    minLat: Math.max(-90, minLat), maxLat: Math.min(90, maxLat),
  };
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(path.join(ROOT, 'public', rel));
  const publicDir = path.resolve(path.join(ROOT, 'public'));
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    sendJSON(res, 403, { error: 'forbidden' });
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJSON(res, 404, { error: 'not found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
    const longCache = rel.startsWith('/vendor/');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      'Cache-Control': longCache ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    /**
     * **GET /api/ready（免登录）**：初始化进度。它是所有 /api 端点里**唯一**在初始化期间
     * 不返回 503 的那个（页面就靠它画「正在初始化路网…（阶段 N%）」这一行），
     * 只回一份内存里的状态 —— 否则慢查询又会把响应压在后面。
     * 无论就绪与否都是 200（body.ready 说明状态），这样浏览器/工具一条轮询就够。
     */
    if (pathname === '/api/ready') {
      sendJSON(res, 200, readyPayload());
      return;
    }

    /**
     * 初始化还没完：**立刻**给一个明确的 503（不是把请求挂在那里等事件循环 —— 那正是客户端
     * 眼里的"服务器响应超时"）。静态资源照旧发（浏览器至少能看到页面与这句提示），
     * 页面自己轮询 /api/ready 显示进度，就绪后自动重试。
     * 就绪后本分支不再进（initState.done = true）。
     */
    if (!initState.done && pathname.startsWith('/api/')) {
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '2',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(initPayload()));
      return;
    }

    /* ------------------------------ 只读接口 ------------------------------ */
    if (pathname === '/api/health') {
      sendJSON(res, 200, {
        ok: true, online: sessions.size, data: db.info(),
        locks: Object.keys(ops.locksSnapshot()).length,
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }

    if (pathname === '/api/meta') {
      sendJSON(res, 200, {
        // 走到这里说明初始化已经完成（没完成的话上面那道闸门已经回了 503 + 进度）
        ready: true,
        defaultCenter: config.defaultCenter,
        data: db.info(),
        limits: LIMITS,
        online: sessions.size,
        allowAnyRollback: !!config.allowAnyRollback,
        // 前端据此决定要不要露出「以游客身份先上任」按钮与 `?guest=1` 自动登录
        // （见 public/js/ui.js 的 applyGuestPolicy / main.js 的 boot）
        allowGuests: ALLOW_GUESTS,
        source: '服务器本地 OSM 数据集（不写入 OpenStreetMap 官方数据库）',
        config: { transit: publicTransitConfig() },
      });
      return;
    }

    /* ------------------------------ 账号接口 ------------------------------ */
    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { token, user } = auth.register(body.name, body.password, clientIp(req));
        sendJSON(res, 200, { token, user });
      } catch (err) {
        sendJSON(res, err.code === 'TAKEN' ? 409 : err.code === 'RATELIMIT' ? 429 : 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { token, user } = auth.login(body.name, body.password, clientIp(req));
        sendJSON(res, 200, { token, user });
      } catch (err) {
        sendJSON(res, err.code === 'RATELIMIT' ? 429 : 401, { error: err.message });
      }
      return;
    }

    /**
     * 游客登录（**默认关闭**，见 resolveAllowGuests）：关了就是 403 + 一句中文说明，
     * 让只会在页面上找路子的玩家明白"得注册或登录"，而不是收到一个含糊的 400。
     * `auth.guest()` 自己也会拒（FORBIDDEN）—— 这里先判一次，是为了给一个准确的 403 状态码。
     */
    if (pathname === '/api/guest' && req.method === 'POST') {
      if (!ALLOW_GUESTS) {
        sendJSON(res, 403, { error: GUEST_DISABLED_MESSAGE, code: 'GUESTS_DISABLED' });
        return;
      }
      try {
        const { token, user } = auth.guest(clientIp(req));
        sendJSON(res, 200, { token, user });
      } catch (err) {
        sendJSON(res, err.code === 'FORBIDDEN' ? 403 : err.code === 'RATELIMIT' ? 429 : 400, {
          error: err.message,
          ...(err.code === 'FORBIDDEN' ? { code: 'GUESTS_DISABLED' } : {}),
        });
      }
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = bearerToken(req) || (await readBody(req)).token;
      auth.logout(token);
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/me') {
      const user = requireUser(req, res, url);
      if (!user) return;
      sendJSON(res, 200, { user: auth.publicUser(user) });
      return;
    }

    /* ------------------------------ 地图数据 ------------------------------ */
    if (pathname === '/api/map') {
      const user = requireUser(req, res, url);
      if (!user) return;
      const bbox = parseBbox(url);
      if (!bbox) {
        sendJSON(res, 400, { error: 'bbox 参数不合法（需要 minLon/minLat/maxLon/maxLat）' });
        return;
      }
      const zoom = Math.max(0, Math.min(22, Number(url.searchParams.get('zoom')) || 16));
      /**
       * 详细度提示（可选，见 osmdb.js 的「服务端路网分级」与「服务端 LOD」）：
       *   detail=0..4    客户端当前的详细度档位（0 完整 / 1 全部道路 / 2 精简 / 3 骨架 / 4 标准=默认）。
       *                  服务端据此决定"哪些建筑面、哪些小路根本不用发"：
       *                  默认档下 z≤15 一栋楼都不画、z≤12 只发主干道；detail=0/1 时两条都关掉。
       *   minFillArea=n  建筑面的面积门槛（m²）：只要大于等于这个面积的建筑。
       * 两个都可以不带（不带的档位用 config limits.lodDetail / lodMinFillArea）。
       * 非法值一律退回默认（不会 400：这是个纯优化提示，不该让地图请求失败）。
       */
      const detailRaw = url.searchParams.get('detail');
      const areaRaw = url.searchParams.get('minFillArea');
      const detail = detailRaw === null || detailRaw === '' ? null : Number(detailRaw);
      const minFillArea = areaRaw === null || areaRaw === '' ? null : Number(areaRaw);
      /**
       * 低缩放视图载荷（见 osmdb.js 的「低缩放视图载荷」）：`view=0/1` 强制关/开。
       * 默认口径：合并生效（z < limits.coalesce.minZoom，默认 15 —— 也就是 z ≤ 14 只看不改）+ LOD 档位 ≥ 2 时才开 ——
       * `detail=0/1`（「完整 / 全部道路」档）是"我要全量数据"的档位，默认**整个关掉**。
       */
      const viewRaw = url.searchParams.get('view');
      const view = viewRaw === null || viewRaw === '' ? null : (viewRaw === '0' || viewRaw === 'false' ? 0 : 1);
      /**
       * 视口要素统计（`payload.stats`：建筑 / 道路 / 水系 / 用地 / 铁路 / POI 各多少）——**默认不算**。
       * 它是 way 表上 5 条 `tags LIKE`，真实数据集实测 z10 ≈ 0.49 s · z13 ≈ 0.4 s（低缩放最贵的三项之一），
       * 而客户端渲染不需要它（图层面板的条数是本地数的 `World.categoryCounts`）。
       *   `stats=1` / `true` → 算（工具、排查用）· `stats=0` / `false` → 不算
       *   不带参数 / 非法值   → 用 config 的 `limits.viewportStats`（默认 false）
       * 想要这个数的是工具不是页面，所以非法值**不报错**，退回默认即可。
       */
      const statsRaw = url.searchParams.get('stats');
      const wantStats = statsRaw === null || statsRaw === ''
        ? LIMITS.viewportStats === true
        : (statsRaw === '1' || statsRaw === 'true' ? true
          : (statsRaw === '0' || statsRaw === 'false' ? false : LIMITS.viewportStats === true));
      /**
       * 永不下发的类别（树 / 自行车道，见 osmdb.js 那段）：`neverSend=0/false` 这一**单次请求**里关掉它
       * （回到"照旧全发"）。留这个口子是为了对照实测：同机 A/B 两次请求，差值就是这条规则的真实成本。
       * 不带的用 config limits.neverSend（默认 true）。
       */
      const neverSendRaw = url.searchParams.get('neverSend');
      const neverSend = neverSendRaw === null || neverSendRaw === '' ? null
        : (neverSendRaw === '0' || neverSendRaw === 'false' ? false : true);
      const started = Date.now();
      // 上限全部来自 config.json 的 limits.*（wayCandidates / nodeCandidates / relationLimit /
      // relationCropPad / relationCropMinMembers），每一项被砍掉多少条由 db.queryBbox 如实报在
      // payload.truncation 里（关系成员裁剪另见 payload.truncation.crop 与 relations[id][3]，
      // 服务端 LOD 扣下的见 payload.truncation.lodFiltered / truncation.lod，
      // 其中 lodFilteredBy.roadClass = 被路网分级筛掉的小路条数）
      const payload = db.queryBbox({
        ...bbox, zoom, limit: LIMITS.viewportLimit,
        wayCandidates: LIMITS.wayCandidates, nodeCandidates: LIMITS.nodeCandidates, relationLimit: LIMITS.relationLimit,
        relationCropPad: LIMITS.relationCropPad, relationCropMinMembers: LIMITS.relationCropMinMembers,
        relationCropBoundaryMembers: LIMITS.relationCropBoundaryMembers,
        detail: Number.isFinite(detail) ? detail : null,
        lodDetail: LIMITS.lodDetail,
        lodRoadSend: LIMITS.roadSend,
        // 基础地板：新名 roadClassFloor 优先，旧名 roadClassZoom 兜底（两者都只覆盖给了的键）
        lodRoadClassFloor: LIMITS.roadClassFloor || LIMITS.roadClassZoom,
        minFillArea: Number.isFinite(minFillArea) && minFillArea >= 0 ? minFillArea : null,
        lodMinFillArea: LIMITS.lodMinFillArea,
        // 永不下发的类别（树 / 自行车道）：请求参数优先，其次 config limits.neverSend（默认开）
        neverSend,
        lodNeverSend: LIMITS.neverSend,
        // 低缩放几何合并（displayLines）：z < limits.coalesce.minZoom（默认 15 = VIEW_ONLY_MAX_ZOOM + 1，
        // 即 z ≤ 14）时把高条数类的 way 合并成"只有几何、没有 way id"的折线，见 osmdb.js 的 _coalesce
        coalesce: LIMITS.coalesce,
        // 紧凑载荷（见 osmdb.js 开头「紧凑载荷」）：坐标量化 + 列式/delta 编码，默认开
        compact: LIMITS.compact,
        // 低缩放视图载荷（见 osmdb.js 开头「低缩放视图载荷」）：面几何也只发"画得出来的紧凑几何"
        view,
      });
      payload.ms = Date.now() - started;
      /**
       * 视口要素统计：**默认不做**（见上面的 wantStats 与 limits.viewportStats）。
       * 打开时才跑 db.visibleStats，并直接复用 queryBbox 候选账本里的"带标签节点数"
       * （payload.totals.nodes）：同一个数，省掉一次全视口节点扫描（真实数据集 z13 上
       * 200~800 ms）。注意 `payload.ms` 在它前面就取好了 —— 这个数一直是"queryBbox 的时间"，
       * 关掉统计并不会让它变小（真正的省下在 TTFB / 总时长上）。
       */
      if (wantStats) payload.stats = db.visibleStats(bbox, payload.totals);
      // 回显这次查询用的 bbox / 上限 / 生效的 LOD 档位，客户端可以自己核对（也方便排查"到底是谁在截断"）
      payload.query = {
        ...bbox, zoom, limit: LIMITS.viewportLimit,
        wayCandidates: LIMITS.wayCandidates, nodeCandidates: LIMITS.nodeCandidates, relationLimit: LIMITS.relationLimit,
        relationCropPad: LIMITS.relationCropPad, relationCropMinMembers: LIMITS.relationCropMinMembers,
        relationCropBoundaryMembers: LIMITS.relationCropBoundaryMembers,
        detail: payload.truncation.lod.detail,
        detailSource: payload.truncation.lod.source,
        minFillArea: payload.truncation.lod.minFillArea,
        // 永不下发的类别（树 / 自行车道）这条规则这次生效没有（echo 出来，A/B 实测时一眼看得出）
        neverSend: payload.truncation.lod.neverSend ? payload.truncation.lod.neverSend.on : null,
        roadSend: payload.truncation.lod.roadSend,
        roadSendRank: payload.truncation.lod.roadSendRank,
        baseFloor: payload.truncation.lod.baseFloor,
        baseFloorSource: payload.truncation.lod.baseFloorSource,
        // 低缩放几何合并的回显（客户端可据此自证"这一档是不是只读视图"）
        coalesce: payload.truncation.coalesce,
        // 低缩放视图载荷的回显（displayAreas：面几何也只画不选；见 osmdb.js 的「低缩放视图载荷」）
        viewOnly: payload.truncation.viewOnly,
        areas: payload.truncation.viewOnly ? payload.truncation.viewOnly.areas : null,
        compact: payload.enc || (LIMITS.compact === false ? false : true),
        // 这次到底算没算视口要素统计（默认不算 → payload 里没有 stats 字段；见 limits.viewportStats）
        stats: wantStats,
      };
      sendJSON(res, 200, payload);
      return;
    }

    if (pathname === '/api/element') {
      const user = requireUser(req, res, url);
      if (!user) return;
      const type = String(url.searchParams.get('type') || '');
      const id = Number(url.searchParams.get('id'));
      if (!['node', 'way', 'relation'].includes(type) || !Number.isFinite(id)) {
        sendJSON(res, 400, { error: 'type/id 参数不合法' });
        return;
      }
      const el = db.geometry(type, id);
      if (!el || el.deleted) {
        sendJSON(res, 404, { error: '元素不存在（可能已被删除）' });
        return;
      }
      sendJSON(res, 200, {
        element: el,
        history: db.elementHistory(type, id, 30),
        relations: db.relationsFor(type, id),
        locks: ops.locksSnapshot(),
      });
      return;
    }

    if (pathname === '/api/search') {
      const user = requireUser(req, res, url);
      if (!user) return;
      const results = db.search({
        name: url.searchParams.get('name') || undefined,
        key: url.searchParams.get('key') || undefined,
        value: url.searchParams.get('value') || undefined,
        limit: Math.min(200, Number(url.searchParams.get('limit')) || 60),
      });
      sendJSON(res, 200, { results, count: results.length });
      return;
    }

    if (pathname === '/api/tags') {
      sendJSON(res, 200, { keys: db.tagStats(80) });
      return;
    }

    /* ------------------------------ 铁路玩法 ------------------------------ */
    if (pathname === '/api/transit') {
      const user = requireUser(req, res, url);
      if (!user) return;
      sendJSON(res, 200, { data: transit.snapshot(), ready: transitReady, company: transit.companyPublic(transit.ensureCompany(user)) });
      return;
    }

    // 线路客流统计：GET /api/transit/line/:id/stats?days=7&token=…
    const lineStatsMatch = pathname.match(/^\/api\/transit\/line\/(\d+)\/stats$/);
    if (lineStatsMatch) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJSON(res, 405, { error: 'method not allowed' });
        return;
      }
      const user = requireUser(req, res, url);
      if (!user) return;
      const id = Number(lineStatsMatch[1]);
      const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get('days')) || 7)));
      try {
        sendJSON(res, 200, transit.apply(user, { k: 'line.stats', id, days }));
      } catch (err) {
        const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'NOTFOUND' ? 404 : 400;
        sendJSON(res, status, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/population') {
      const user = requireUser(req, res, url);
      if (!user) return;
      const bbox = parseBbox(url);
      if (!bbox) {
        sendJSON(res, 400, { error: 'bbox 参数不合法' });
        return;
      }
      const minPop = Math.max(0, Number(url.searchParams.get('minPop')) || 20);
      sendJSON(res, 200, {
        cells: population.cellsInBbox(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat, minPop),
        totals: population.totals(),
      });
      return;
    }

    if (pathname === '/api/rail') {
      sendJSON(res, 200, { stats: rail.stats(), ready: transitReady.rail });
      return;
    }

    if (pathname === '/api/history') {
      const user = requireUser(req, res, url);
      if (!user) return;
      sendJSON(res, 200, {
        changesets: db.recentChangesets(Math.min(200, Number(url.searchParams.get('limit')) || 50)),
        changes: db.recentChanges(Math.min(500, Number(url.searchParams.get('changes')) || 80)),
      });
      return;
    }

    if (pathname === '/api/export') {
      const user = requireUser(req, res, url);
      if (!user) return;
      const bbox = parseBbox(url);
      const xml = db.exportOsm({ bbox });
      const name = bbox ? 'export-bbox.osm' : 'export-all.osm';
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      res.end(xml);
      return;
    }

    const changeMatch = pathname.match(/^\/api\/export\/changeset\/(\d+)$/);
    if (changeMatch) {
      const user = requireUser(req, res, url);
      if (!user) return;
      const xml = db.exportOsmChange(Number(changeMatch[1]));
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="changeset-${changeMatch[1]}.osmChange"`,
        'Cache-Control': 'no-store',
      });
      res.end(xml);
      return;
    }

    /* ------------------------------ 静态资源 ------------------------------ */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJSON(res, 405, { error: 'method not allowed' });
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});
/**
 * **WebSocket 升级闸门（B 方案）**：端口先开、初始化还没完时，`/ws` 的升级请求直接回
 * `503 Service Unavailable`（带同一份进度 JSON），而不是"101 换协议之后再发一帧 error 然后关掉" ——
 * 浏览器那边 `onopen` 根本不会触发，`onerror` 立刻到，重试逻辑也就干净。
 *
 * 它必须注册在 `attachWebSocketServer` **之前**（见下面 wsAttached 的说明），
 * 就绪之后这个监听器只是个"看门人"：`initState.done` 为真时什么都不做，把升级让给 websocket.js。
 */
function wsUpgradeGate(req, socket) {
  /**
   * **游客通道关闭时，`/ws?guest=1` 在握手阶段就被拒。**
   * 这种请求本来就没带 token（老客户端用 `?guest=1` 当"给我个游客身份"的约定），
   * 走到 onWsConnection 只会拿到"登录状态已失效"—— 那是误导。这里直接回 403 + 同一句中文，
   * 与 `POST /api/guest` 的行为对齐。
   */
  if (!ALLOW_GUESTS) {
    let guestParam = null;
    try { guestParam = new URL(req.url, 'http://localhost').searchParams.get('guest'); } catch { /* 非法 URL 交给下面正常路径 */ }
    if (guestParam === '1' || guestParam === 'true') {
      const body = JSON.stringify({ error: GUEST_DISABLED_MESSAGE, code: 'GUESTS_DISABLED' });
      try {
        socket.write('HTTP/1.1 403 Forbidden\r\n'
          + 'Content-Type: application/json; charset=utf-8\r\n'
          + 'Connection: close\r\n'
          + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      } catch { /* 客户端提前断开就算了 */ }
      socket.destroy();
      return;
    }
  }
  if (initState.done) return;                       // 就绪：放行（websocket.js 的监听器接着处理）
  try {
    const body = JSON.stringify(initPayload());
    socket.write('HTTP/1.1 503 Service Unavailable\r\n'
      + 'Content-Type: application/json; charset=utf-8\r\n'
      + 'Retry-After: 2\r\n'
      + 'Connection: close\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } catch { /* 客户端提前断开就算了 */ }
  socket.destroy();
}
httpServer.on('upgrade', wsUpgradeGate);

/**
 * **端口没绑上（EADDRINUSE / EACCES / EADDRNOTAVAIL）时的兜底 —— B 方案的必配项。**
 *
 * 改造后"端口先开、初始化在后"，于是**绑定失败**这件事必须自己说清楚，否则会踩到这条坑（实测过）：
 * 文件末尾那句 `process.on('uncaughtException', ...)` 会把监听错误**记一行就算了**（进程不死），
 * 于是 runInit() 照旧把 12 秒的建图跑完，最后打出「就绪：端口 0 ms 就开了」（**假话**：端口根本没开），
 * 随后事件循环无事可做，进程静默退出 —— 用户看到的是"日志说就绪了，浏览器却打不开"。
 * 现在：绑定阶段出错就直接给出中文原因 + 退出码 1，不做那些无意义的初始化。
 * （就绪之后的 socket 级错误不动服务器：那只是单个连接的问题。）
 */
httpServer.on('error', (err) => {
  if (initState.listenOk) {
    console.error('[http] 服务器错误：', err.message);
    return;
  }
  const hint = err.code === 'EADDRINUSE'
    ? `端口 ${config.port} 已被占用：先停掉占用它的进程（Windows: netstat -ano | findstr :${config.port}），或用 --port 换一个端口`
    : `无法监听 ${config.host}:${config.port}：${err.message}`;
  console.error(`[启动] ${hint}`);
  initState.error = hint;
  stopInitWatchdog();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 20).unref();   // 让上面那行日志先落盘
});

/* ------------------------------ 定时任务 ------------------------------ */
let wsAttached = false;
/**
 * WebSocket 服务器**在就绪之后**才挂上去。理由：
 *   · 初始化期间升级请求由上面的闸门回 503 —— 如果这里先挂了，Node 会把 'upgrade' 事件
 *     派发给**两个**监听器（闸门写 503 + websocket.js 写 101），两个都动同一个 socket；
 *   · 就绪之后再挂，升级路径就与改造前完全一样（一条监听器、一套逻辑）。
 * `onWsConnection` 里那道"初始化没完就发 error 帧"的检查留着做防御。
 */
function attachWsServer() {
  if (wsAttached) return;
  wsAttached = true;
  attachWebSocketServer(httpServer, { path: '/ws', maxPayload: 4 * 1024 * 1024, onConnection: onWsConnection });
}

/**
 * 铁路模拟：每 250 毫秒推进一次，并把**增量帧**（时钟 + 在跑的车 + 变了才带的公司）广播给所有玩家。
 *
 * 旧版这里每帧都调 transit.snapshot() 再取其中 .trains（另外又把 companies 单独算了一遍）：
 * snapshot() 每帧构造约 1 MB / 15 ms 的整份状态（车站 / 线路 / 车辆 / 统计），其中 93% 的字节
 * 没有任何消费者。整份快照现在只在显式请求时构建（welcome / transitSync / GET /api/transit）。
 */
const SIM_INTERVAL_MS = 250;
let lastSimAt = Date.now();
/**
 * 上一帧带的公司块有没有被慢客户端的背压合并顶掉：
 * 公司块平时不带（只在它变了的那一帧带），万一那一帧正好被"更新的一份 sim 帧"顶掉，
 * 那个客户端就会一直用着旧的公司数字（×0 倍速下可能再也不会变）。所以被顶掉就在下一帧补带一次。
 */
let companiesPending = false;
/**
 * 一次 tick 里"最多让出事件循环几次"（见下面的分帧推进）：安全阀，
 * 防止在极端配置下把一次 tick 拖成几十段。正常情况下一段就够（10k 辆车也不会分段）。
 */
const SIM_MAX_SLICES = 4;
/**
 * 这一轮的 tick 被切成几段（>1 表示预算用完、剩下的游戏时间延到了后面的切片）。
 * 用 setTimeout(0) 而不是 setImmediate：让已经就绪的 I/O（op / HTTP / WS）先跑完，
 * 客户端的 ack 就不会排在"补模拟"后面。
 */
let simSliceSerial = 0;

/**
 * 一次仿真 tick（可能分几段跑，每段之间让出事件循环）。
 *
 * #不阻塞事件循环：tick 内部有 simBudgetMs（默认 5 ms）的预算，预算用完会把
 * "还剩多少游戏时间"留在 _budgetLeftMs 里。以前那个余量要等下一次 250 ms 才补，
 * 于是高倍速 + 大车队时游戏时钟会明显掉队。现在 tick 返回后如果发现还有余量，
 * 就用 setTimeout(0) 立刻接着跑（最多 SIM_MAX_SLICES 段），
 * 这样"游戏时间不丢"和"事件循环不被长段占用"两件事同时成立。
 *
 * ⚠ 同一时刻只允许一段在补算（simSliceRunning）：250 ms 的定时器与 setTimeout(0)
 * 的补算段可能撞在一起，而 transit.tick 不是可重入的（它会改 clockMs）。
 * 撞上时补算段直接放弃，余量由下一个 250 ms 继续消化。
 */
let simSliceRunning = false;
function runSimSlice(chain) {
  if (simSliceRunning) return;
  simSliceRunning = true;
  // tickAsync：每一小步之间让出一次事件循环（setImmediate），
  // 于是"一次 tick 要跑 25 个小步"不再是一个长同步片段，而是 25 个短片段。
  // 返回的 Promise 在整段 tick 跑完（或预算到点）之后 resolve。
  transit.tickAsync(chain.dt, { onYield: () => new Promise((r) => setImmediate(r)) })
    .then(() => {
      simSliceRunning = false;
      const left = transit.consumeBudgetLeft();
      chain.slices += 1;
      if (left > 0.5 && chain.slices < SIM_MAX_SLICES) {
        chain.dt = left / Math.max(1e-6, transit.speed);
        const serial = (simSliceSerial += 1);
        setTimeout(() => { if (serial === simSliceSerial) runSimSlice(chain); }, 0);
      }
    })
    .catch((err) => {
      simSliceRunning = false;
      console.error('[sim] 推进失败:', err.message);
    });
}

const simTimer = setInterval(() => {
  const now = Date.now();
  const dt = Math.min(2000, now - lastSimAt);
  lastSimAt = now;
  // 分片推进（tick 的预算用完就接着排一段），所以这里不再等它同步跑完
  runSimSlice({ dt, slices: 0 });
  if (!sessions.size) return;
  // ── #广播按需：**一个连接一帧** ────────────────────────────────────────────
  // 以前是"构造一帧（整支车队）→ JSON.stringify 一次 → 所有人共用这一个字符串"。
  // 车队上万之后那条路的代价是"每个客户端每帧都要收下整支车队"（10k 辆车 ≈ 2 MB，
  // 20 个玩家 = 40 MB/s 的出口带宽 + 每人 2 MB 的 JSON.parse），全是白花的：
  // 每台机器的屏幕顶多画得出几百辆车。
  // 现在每个连接自己一帧：只有"视口内的车 + 自己的车"带完整实时字段，
  // 视口外的车按线路给一个条数（frame.lineCounts），并且**按内容去重** ——
  // 相邻两次广播期间没有任何变化的客户端，收到的帧只有 clock（几十字节）。
  try {
    const clock = transit.clockPublic();
    // "这一帧有没有东西变"的判据：时钟 + 车队版本号。
    // 车队版本号在两种情况下加一（见 transit.motionSerial 的说明）：
    //   ① 真的算过至少一辆车（位置/载客/状态/班次变了）；
    //   ② 任何 onChanged（有人建/改/删车或线路、撤销重做）。
    // 所以暂停中 / 所有车都停在站台上时，那一帧只发一个 clock（几十字节）。
    const motion = transit.motionSerial();
    const frameKey = `${clock.clockMs}|${clock.speed}|${clock.day}|${motion}`;
    let companies = null;         // 懒构造：第一个真的需要它的连接才构造
    let companiesTried = false;
    for (const [conn, session] of sessions) {
      try {
        if (session.lastFrameKey === frameKey && !companiesPending) {
          // 一秒 4 帧里通常只有 1 帧真的在动（LOD 粗档 3 游戏秒 / 250 ms 一跳）：
          // 其余几帧就是这一条 —— 几十字节，而不是"整支车队再来一遍"。
          conn.send(JSON.stringify({ t: 'sim', clock }), { slot: 'sim' });
          continue;
        }
        session.lastFrameKey = frameKey;
        const frame = transit.frameFor(session.userId, {
          owner: session.userId,
          limit: LIMITS.transitFrameVehicles,
        });
        frame.t = 'sim';
        if (!companiesTried) { companies = transit.companiesIfChanged(); companiesTried = true; }
        if (companies) frame.companies = companies;
        else if (companiesPending) frame.companies = transit.companiesFrame();
        conn.send(JSON.stringify(frame), { slot: 'sim' });
      } catch (err) {
        console.error('[sim] 单帧失败:', err.message);
      }
    }
    companiesPending = !!companies && companiesPending;
  } catch (err) {
    console.error('[sim] 广播失败:', err.message);
  }
}, SIM_INTERVAL_MS);
simTimer.unref();

const pingTimer = setInterval(() => {
  for (const [conn] of sessions) {
    if (!conn.isAlive) { conn.terminate(); continue; }
    conn.isAlive = false;
    conn.ping();
  }
}, 30000);
pingTimer.unref();

const pruneTimer = setInterval(() => auth.prune(), 3600 * 1000);
pruneTimer.unref();

/* ------------------------------ 启动 / 退出 ------------------------------ */
/**
 * **B 方案：端口先开、页面先出、初始化期间 /api/* 一律 503 + 进度。**
 *
 * 改造前：铁路网 0.8 s + 道路网 10~18 s + 人口网格 + 线路路径全排在 `httpServer.listen()` **之前**
 * —— 好处是"端口一开就是可用状态"，代价是**页面 12~22 秒连不上**（浏览器只会一直转圈，
 * 看不到任何原因）。本机实测（北京数据集，867 辆车）：端口 11.7 s 才打开、第一次有响应 12.1 s。
 *
 * 改造后：
 *   1. `httpServer.listen()` **先调**：静态页面/脚本立刻可取（第一阶段就能画出界面骨架）；
 *   2. `/api/ready`（免登录、不碰库）随时可问，返回 {ready, progress:{stage, percent}}；
 *   3. 其余 `/api/*` 与 `/ws` 升级请求在初始化期间立刻回 **503 + 同一份进度 JSON**
 *      （不是"挂着等事件循环"，那正是客户端的"服务器响应超时"）；
 *   4. 重活**切片**跑（见 buildGraphSliced）：每片之间让出事件循环，
 *      所以端口开着的时候服务器是真的能应答的；
 *   5. 就绪后 `initState.done = true`，挂上 WebSocket 服务器，正常流量照旧。
 *
 * 进度百分比：阶段边界是**精确**的（每个阶段有固定权重），阶段内部按"已用时间 / 该阶段的
 * 实测估计"给一个估计值（`limits.graphEstimateMs` 可调）—— 首次启动的人口推算（population.js
 * 的整段同步循环）与线路路径重建（transit.js）没有分批入口，它们的内部进度只能靠时间估计。
 */
const INIT_STAGES = [
  { key: 'rail', label: '铁路网', weight: 5, message: '正在构建铁路网' },
  { key: 'road', label: '道路网', weight: 84, message: '正在构建道路网（有公交线路要用）' },
  { key: 'population', label: '人口网格', weight: 6, message: '正在准备人口网格' },
  { key: 'paths', label: '线路路径', weight: 5, message: '正在重建线路路径' },
];
const INIT_STAGE_TOTAL = INIT_STAGES.reduce((n, s) => n + s.weight, 0);
const INIT_STAGE_INDEX = new Map(INIT_STAGES.map((s, i) => [s.key, i]));

const initState = {
  done: false,                    // 全部就绪（/api/* 放行的唯一开关）
  stage: 'boot',                  // 当前阶段（'boot' / 'rail' / 'road' / 'population' / 'paths' / 'ready'）
  label: '启动',
  message: '正在初始化路网…',
  percent: 0,                     // 0~100（阶段边界精确，阶段内部为估计）
  stageFrac: 0,
  error: null,
  startedAt: Date.now(),
  listenOk: false,                // 端口**真的**绑上了（listen 回调里翻牌）；绑定失败见 httpServer.on('error')
  listenAt: 0, listenMs: 0,       // 端口打开的时刻/耗时
  readyAt: 0, readyMs: 0,         // 初始化完成的时刻/耗时
  ms: 0,                          // readyMs 的别名（兼容老字段/老日志）
  /** 初始化期间最长的一次同步停顿（毫秒）+ 它发生在哪个阶段：由下面的看门狗定时器量 */
  maxStallMs: 0, maxStallStage: null,
};

/** 初始化进度（内存里，纯读）：/api/ready 与 503 都用它 */
function initPayload() {
  const elapsedMs = Date.now() - initState.startedAt;
  return {
    ready: !!initState.done,
    initializing: !initState.done,
    // 规范要求的字段形状：ready / message / progress{stage, percent}
    message: initState.error ? `初始化失败：${initState.error}` : '正在初始化路网…',
    progress: {
      stage: initState.stage,
      percent: initState.percent,
      label: initState.label,
      index: INIT_STAGE_INDEX.has(initState.stage) ? INIT_STAGE_INDEX.get(initState.stage) + 1 : 0,
      total: INIT_STAGES.length,
      stageMessage: initState.message,
      stagePercent: Math.round(initState.stageFrac * 100),
    },
    phase: initState.stage,                 // 兼容老字段（旧客户端/工具读的是 phase）
    detail: initState.message,
    error: initState.error,
    elapsedMs,
    listenMs: initState.listenMs || null,
    readyMs: initState.readyMs || null,
    estimated: true,                        // 阶段内部是估计值（阶段边界是精确的）
    retryAfterMs: 1000,
  };
}

/** /api/ready：同样的状态，但明确"已就绪"时的样子（客户端一条轮询就够） */
function readyPayload() {
  return Object.assign({
    ok: true,
    stages: INIT_STAGES.map((s) => ({ key: s.key, label: s.label, weight: s.weight })),
  }, initPayload());
}

/** 进入某个阶段（阶段边界精确 → percent 立刻跳到该阶段的起点） */
function setInitStage(key) {
  const idx = INIT_STAGE_INDEX.has(key) ? INIT_STAGE_INDEX.get(key) : -1;
  const stage = idx >= 0 ? INIT_STAGES[idx] : null;
  initState.stage = key;
  initState.label = stage ? stage.label : (key === 'ready' ? '就绪' : '启动');
  initState.message = stage ? stage.message : (key === 'ready' ? '就绪' : '正在初始化路网…');
  initState.stageFrac = 0;
  initState.percent = stage ? Math.round((INIT_STAGES.slice(0, idx).reduce((n, s) => n + s.weight, 0) / INIT_STAGE_TOTAL) * 100) : (key === 'ready' ? 100 : 0);
  if (!initState.done) console.log(`[init] 阶段 ${idx + 1}/${INIT_STAGES.length} · ${initState.label}（${initState.percent}%）· ${initState.message}`);
}

/** 阶段内部进度（frac 0~1，只影响显示/轮询，不影响任何语义） */
function setInitProgress(key, frac) {
  if (initState.stage !== key) return;
  const idx = INIT_STAGE_INDEX.get(key);
  if (idx === undefined) return;
  const base = INIT_STAGES.slice(0, idx).reduce((n, s) => n + s.weight, 0);
  const own = Number(frac);
  initState.stageFrac = Number.isFinite(own) ? Math.max(0, Math.min(1, own)) : 0;
  initState.percent = Math.round(((base + INIT_STAGES[idx].weight * initState.stageFrac) / INIT_STAGE_TOTAL) * 100);
}

/**
 * **初始化期间的事件循环看门狗**：每 5 ms 打一次卡，把"两次打卡之间多等了多久"记下来。
 * 这是"有没有 >20 ms 同步停顿"的**服务端自证**（客户端那侧的证据是 /api/ready 的往返时间，
 * 见 tmp-verify/lateinit/timeline.js）。切片做得好，它就应该一直在个位数毫秒。
 */
let initWatchdog = null;
function startInitWatchdog() {
  if (initWatchdog) return;
  let next = Date.now() + 5;
  initWatchdog = setInterval(() => {
    const now = Date.now();
    const lag = now - next;
    next = now + 5;
    if (lag > initState.maxStallMs) { initState.maxStallMs = lag; initState.maxStallStage = initState.stage; }
  }, 5);
  initWatchdog.unref();
}
function stopInitWatchdog() {
  if (!initWatchdog) return;
  clearInterval(initWatchdog);
  initWatchdog = null;
}

/** 有没有需要道路网的线路（公交）：没有就别在启动时白花 8~10 秒建路网 */
function needsBusGraph() {
  try {
    return !!transit.needsRoadGraph();
  } catch {
    return true;      // 查不出来就按"要建"处理（宁可慢也不能少建）
  }
}

function localAddresses() {
  const os = require('node:os');
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) if (nic.family === 'IPv4' && !nic.internal) out.push(nic.address);
  }
  return out;
}

/** 初始化跑完（成功或失败）：翻牌 + 挂 WebSocket + 打时间线 */
function finishInit() {
  initState.done = true;
  initState.readyAt = Date.now();
  initState.readyMs = initState.readyAt - initState.startedAt;
  initState.ms = initState.readyMs;
  setInitStage('ready');
  initState.message = initState.error ? `初始化失败：${initState.error}` : '就绪';
  initState.percent = 100;
  stopInitWatchdog();
  attachWsServer();
  const listenMs = initState.listenMs;
  // 端口没绑上时**不许**打"端口 0 ms 就开了"（那是假话）：绑定失败由 httpServer.on('error') 负责退出
  if (!initState.listenOk) {
    console.error('[init] 初始化结束了，但端口没有绑上 —— 服务器不可用，请按上面的提示处理');
    return;
  }
  console.log(`[init] 就绪：端口 ${listenMs} ms 就开了 · 初始化 ${initState.readyMs} ms`
    + `（监听之后 ${initState.readyMs - listenMs} ms）· 初始化期间最长一次同步停顿 ${initState.maxStallMs} ms`
    + `（阶段 ${initState.maxStallStage || '-'}）`);
}

/** 初始化主流程：**在 listen() 之后**被调用（不 await，端口不会被它挡住） */
async function runInit() {
  startInitWatchdog();
  setInitStage('boot');
  try {
    await initTransitWorld();
  } catch (err) {
    initState.error = err.message;
    console.error('[transit] 初始化失败:', err.message);
  }
  finishInit();
}

/**
 * 启动：**先 listen，再初始化**。
 * @param {{selfcheck?: boolean}} [opts]
 */
function boot(opts = {}) {
  if (opts.selfcheck) { runGraphSelfcheck(); return; }
  initState.listenAt = Date.now();
  initState.listenMs = initState.listenAt - initState.startedAt;
  httpServer.listen(config.port, config.host, () => {
    // 端口**真的开始接受连接**的时刻（listen 回调）：这之前的 socket 绑定/监听是异步的，
    // 所以这个数才是页面上"端口已开（X ms）"该显示的那个（本机实测 0~1 ms，启动即开）。
    initState.listenOk = true;
    initState.listenMs = Date.now() - initState.startedAt;
    console.log('');
    console.log('  🗺️   OSM 城市在线 —— 多人在线 OSM 编辑器 + 铁路经营');
    console.log(`      本机：   http://127.0.0.1:${config.port}/`);
    for (const ip of localAddresses()) console.log(`      局域网： http://${ip}:${config.port}/`);
    console.log(`      数据集： ${path.relative(ROOT, config.osmDb)}（${dataInfo.nodes} 节点 / ${dataInfo.ways} 道路 / ${dataInfo.relations} 关系）`);
    if (dataInfo.source) console.log(`      来源：   ${dataInfo.source}${dataInfo.importedAt ? '（导入于 ' + dataInfo.importedAt + '）' : ''}`);
    console.log(`      **端口已开**（${initState.listenMs} ms）：页面/静态资源立刻可取，`
      + `路网/人口/线路路径正在切片初始化 —— 期间 /api/* 与 /ws 一律 503，进度见 GET /api/ready`);
    console.log('');
  });
  // 端口先开：初始化**不 await**，切片跑（每片之间让出事件循环）
  runInit().catch((err) => {
    initState.error = err.message;
    console.error('[init] 未捕获的初始化错误:', err.stack || err.message);
    if (!initState.done) finishInit();
  });
}

/**
 * `--graph-selfcheck`：**切片建图 vs 一次性 build() 的等价性自检**（真实数据集上跑一次几十秒）。
 * 逐项对比：节点/边/段/虚拟路口/路口数、wayInfo 的合计校验、随机 200 对节点的最短路长度。
 * 打印一份 JSON 报告后退出（exit 0 = 等价，1 = 不等价）。用：
 *   node server/index.js --graph-selfcheck [--port ... --data ... --osm ...]
 */
function runGraphSelfcheck() {
  const t0 = Date.now();
  const fingerprint = (graph) => {
    let edgeObjects = 0; let degMax = 0;
    for (const n of graph.nodes.values()) {
      edgeObjects += n.edges.length;
      if (n.edges.length > degMax) degMax = n.edges.length;
    }
    let speed = 0; let congestion = 0; let lengthM = 0; let junctions = 0; let density = 0;
    for (const w of graph.wayInfo.values()) {
      speed += w.speed; congestion += Math.round(w.congestion * 1000);
      lengthM += Math.round(w.lengthM); junctions += w.junctions; density += Math.round(w.density * 100);
    }
    let segLen = 0; let segLive = 0;
    if (graph._segWay) {
      for (let i = 0; i < graph._segWay.length; i++) {
        if (!graph._segWay[i]) continue;
        segLive += 1;
        segLen += Math.round(graph._segLen[i] * 100);
      }
    }
    return {
      nodes: graph.nodes.size, edges: graph.edgeCount, edgeObjects: edgeObjects, degMax,
      ways: graph.wayCount, segments: segLive,
      /** 墓碑槽位（`_segWay[i] === 0`，任何消费者都跳过）——**只报不判**，见下面的注释 */
      segmentTombstones: (graph._segWay ? graph._segWay.length : 0) - segLive,
      segLenHash: segLen, virtual: graph.virtualNodeCount, junctions: graph.junctionCount,
      wayInfoHash: { speed, congestion, lengthM, junctions, density },
    };
  };
  /** 固定的伪随机抽样（不用 Math.random：两次跑要抽同一批节点，报告才可复现） */
  const routing = (graph) => {
    const ids = [...graph.nodes.keys()].filter((id) => id > 0);
    const out = [];
    if (!ids.length) return out;
    let seed = 123456789;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 40; i++) {
      const a = ids[Math.floor(rnd() * ids.length)];
      const b = ids[Math.floor(rnd() * ids.length)];
      if (a == null || b == null || a === b) continue;
      const p = graph.shortestPath(a, b, {});
      out.push(p && p.nodes
        ? { a, b, len: p.lengthM, sec: p.seconds, n: p.nodes.length }
        : { a, b, err: (p && p.error) || 'none' });
    }
    return out;
  };
  const drop = (obj) => { try { if (global.gc) global.gc(); } catch { /* 没开 --expose-gc 就算了 */ } return obj; };

  (async () => {
    const report = { mode: 'graph-selfcheck', db: path.relative(ROOT, config.osmDb), at: new Date().toISOString(), rails: {}, bus: {} };
    for (const [name, mode] of [['rails', 'rail'], ['bus', 'bus']]) {
      // 一次性 build()
      let a = new RailGraph(db, { mode });
      const tA = Date.now();
      const statA = a.build();
      const msA = Date.now() - tA;
      const fpA = fingerprint(a);
      const rtA = routing(a);
      a = drop(null);                     // 放开第一张图，别让两张巨图同时在内存里
      // 切片 build（与启动路径同一个函数）
      const b = new RailGraph(db, { mode });
      const tB = Date.now();
      const statB = await buildGraphSliced(b, { onProgress: () => {} });
      const msB = Date.now() - tB;
      const fpB = fingerprint(b);
      const rtB = routing(b);
      /**
       * 判定"等价"的口径（都用指纹与**行为**，不比对内部数组长度）：
       *   · 节点 / 边 / way / 活着的段 / 虚拟路口 / 路口数：必须逐项相等；
       *   · 段长合计哈希 + wayInfo 的 speed/congestion/lengthM/junctions/density 合计：必须相等
       *     （这两项把"每条 way 的速度、拥堵、里程"与"每条段的长度"都盖住了）；
       *   · 120 组随机节点对的最短路（长度 / 秒数 / 节点数）：必须逐字节相同。
       * **不判** segmentTombstones（`_segWay` 里的墓碑槽位）：分批切段时批次边界上可能多留几个
       * 空槽（真实数据集实测差 6 个 / 53.5 万），它们对任何消费者都不可见（`if (!this._segWay[i]) continue`），
       * 活着的段数、段长合计、路由结果全都一模一样 —— 所以只把它报出来，不作为"不等价"。
       */
      const diff = {};
      for (const k of Object.keys(fpA)) {
        if (k === 'segmentTombstones') continue;
        if (JSON.stringify(fpA[k]) !== JSON.stringify(fpB[k])) diff[k] = { build: fpA[k], sliced: fpB[k] };
      }
      const routingSame = JSON.stringify(rtA) === JSON.stringify(rtB);
      report[name] = {
        build: { ms: msA, stats: statA, fp: fpA },
        sliced: { ms: msB, stats: { ways: statB.ways, edges: statB.edges, nodes: statB.nodes, virtualJunctions: statB.virtualJunctions, junctions: statB.junctions, junctionMs: statB.junctionMs }, fp: fpB, phases: statB.phases },
        equal: Object.keys(diff).length === 0 && routingSame, diff, routingSame, routingSamples: rtA.length,
      };
      if (!routingSame) {
        const bad = rtA.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(rtB[i]));
        report[name].routingFirstDiff = { at: bad, build: rtA[bad], sliced: rtB[bad] };
      }
    }
    const ok = report.rails.equal && report.bus.equal;
    report.equal = ok;
    report.ms = Date.now() - t0;
    console.log(JSON.stringify(report, null, 2));
    console.log(`\n[graph-selfcheck] ${ok ? '✅ 切片建图与一次性 build() 完全等价' : '❌ 切片建图与一次性 build() 不等价（见 diff）'}`
      + `（铁路 ${report.rails.sliced.ms} ms / 道路 ${report.bus.sliced.ms} ms · 总 ${report.ms} ms）`);
    try { db.close(); } catch { /* ignore */ }
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error('[graph-selfcheck] 失败:', err.stack || err.message);
    process.exit(2);
  });
}

if (process.argv.includes('--graph-selfcheck')) boot({ selfcheck: true });
else boot();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] 收到 ${signal}，正在保存...`);
  try { transit.flushStats(); } catch (err) { console.error(err.message); }
  try { auth.shutdown(); } catch (err) { console.error(err.message); }
  try { db.close(); } catch (err) { console.error(err.message); }
  for (const conn of sessions.keys()) {
    try { conn.close(1001, 'server shutdown'); } catch { /* ignore */ }
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

module.exports = { httpServer, db, ops, undoBus, auth, config };
