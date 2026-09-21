'use strict';
/**
 * 人口模型：从真实 OSM 建筑推算"人住在哪里"，再按 NIMBY Rails 的真实规则把人口变成车站客流。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 一、NIMBY Rails（下称 NR）的乘客 / 需求模型：研究结论与出处
 *     （全部条目都来自官方 wiki 与官方更新公告 / 作者 devblog，链接附在每条后面）
 *     最后一次逐条复核：2026-09-20（用 wiki 的 API 取了页面正文与历史版本，版本号写在每条后面；
 *     取法见 tests/tmp-wiki/fetch.js 与 tests/tmp-wiki/api.js，抓下来的正文在 tests/tmp-wiki/）。
 *
 *  1) 车站有一个 spawn rate（每秒产生多少乘客）。它由 demand 决定，而 demand 只看：
 *     车站覆盖范围内的人口（reach）、一天中的时刻、星期几，以及玩家在选项里设的
 *     全局 pax demand factor；乘客满意度会在此基础上增减。
 *       wiki 原文（Spawn rate 页 r279，2022-12-27）：
 *         "The spawn rate is a dynamic property of a station and expresses how many new pax
 *          the station will spawn per second for each of the three distance categories."
 *         "The spawn rate is governed by: * Demand governs the base spawn rate, separately for
 *          each distance category * Station average satisfaction can increase or decrease the
 *          spawn rate compared to the base demand."
 *         "The demand level for a station is determined by: * The reach of the station - the
 *          population covered by the station's area * The time of day and day of the week
 *          * The global Pax demand factor ..."
 *         "A station with a reach of zero will have no demand, and will never be chosen as an
 *          origin or destination."
 *       以及最关键的一句（v1.6 起）：
 *         "As of Version 1.6, population is the only factor considered - there is no
 *          directional flow towards city centres in the morning and away in the evening."
 *       → 结论：**NR 里没有"岗位 / 就业"这一套东西**。客流完全由覆盖人口决定，
 *         也没有"早上往市中心流、晚上往外流"的方向性。
 *       时段（同一页）："The daily cycle has peaks of commuter demand in the morning and
 *         evening, while regional and intercity demand are more spread out across the day.
 *         Weekends see lower demand, although intercity demand is higher."
 *       全局 demand factor（同一页）："For Europe, demand factors of 8-15% are considered
 *         realistic."（对应本作的出行率 tripRatePerDay）
 *       ⚠ 该页**现在被清空了**（正文只剩分类，内容在历史版本里），所以引的是 r279：
 *         https://wiki.nimbyrails.com/index.php?title=Spawn_rate&oldid=279
 *
 *  2) 乘客（pax）在车站生成，这个站就是它的 origin；生成时立刻被分到一个"距离档"
 *     （local 0~15 km / regional 15~100 km / long distance >100 km，按**直线距离**算，
 *      与实际线路怎么走无关），然后**挑一个目的车站（destination）**。
 *       原文（Pax 页 r360，2023-05-05）："New pax spawn in stations according to the spawn rate
 *         of a station. ... Pax are allocated immediately to one of the three distance
 *         categories: local, regional and long distance. Upon spawning pax will pick a
 *         destination."
 *       原文（Distance category 页 r457，2024-09-30）：该页**已经标上 "Deleted feature"**
 *         （1.12 之后这个硬切分被删掉了），正文写的是
 *         "Local: destination 0 to 15km from origin / Regional: destination 15km to 100km from
 *          origin / Long distance: destination more than 100km from origin"，
 *         并点了硬切分的毛病："if your entire network is in a single metropolitan area
 *          (within a 100km radius) except for one station outside, all long distance pax will
 *          pick that one station as their destination."
 *       https://wiki.nimbyrails.com/index.php?title=Pax （Pax 页 r360）
 *       https://wiki.nimbyrails.com/index.php?title=Distance_category （r457，标着 Deleted feature）
 *       → 本作默认仍然**按档切分**候选目的站（1.11 的写法），开关是
 *         config.transit.odBandCandidates（见下面"本作与 NR 的差异"）。
 *
 *  3) 挑目的地的三步（wiki 原文 "Destination picking"，Destination 页 r239 / 2022-12-27）：
 *       (1) 候选 = 距离档内的全部车站（直线距离，不管有没有铁路线、有没有海和山）；
 *       (2) 按"目的站覆盖人口"和"停靠在那里的线路条数"给候选加权 ——
 *           线路条数的影响近似线性（同样覆盖、线路翻倍 → 被选中的乘客翻倍）；
 *           覆盖人口的影响是非线性的，而且覆盖很小的站也仍然有一个"默认水平"；
 *           wiki 明说具体的数学没公开："The precise maths for this are not disclosed."
 *       (3) 在加权表里随机抽一个站。
 *       同一页还写了查看方式："The station and train 'passengers listing' window can be sorted
 *         to group 'by destination'. This displays all pax in the station or train, grouped by
 *         their destination."（本作落到车站候车的线路桶 + 车上的 paxByDest，见 transit.js）
 *       https://wiki.nimbyrails.com/index.php?title=Destination
 *
 *  4) 挑完目的地才开始寻路（NR 叫 dominating trip），只有**能到的**目的地才会真的走；
 *     到站即消失。站内可以换乘，也可以站间步行换乘（OSI，半径 2.3 km，步行 1 m/s）。
 *     NR 把乘客按"同一目的地"打成一包来模拟。
 *       原文（Station 页 r461）："Passengers (called Pax in-game) have an origin station and a
 *         destination station, on their way between these two stations pax can transfer in
 *         stations, but also do Out-of-Station Interchanges (walking)."
 *         "The max radius at which an OSI is possible is 2.3km. ... The transfer between two
 *          stations via walking takes time, because the pax are walking at a speed of 1m/s.
 *          While the pax are walking they appear in the station hall of their destination
 *          (of the OSI) with a timer."
 *       原文（Pax 页 r360）："the game represents pax using groups of pax with the same
 *         destination." / 静态属性里有 "Waited line stop, for pax waiting in a station"。
 *       车站窗口的分组方式（Station 页 r461）：Show all / Group by destination / Group by
 *         origin / **Group by waited line stop - Group by the next train pax intend to board** /
 *         Group by next stop —— 本作"站台按线路分桶候车"就是照这条做的。
 *       车站覆盖面积可以设为 0："This prevents pax from spawning or choosing the depot as a
 *         destination."（与第 1 条的"reach 为 0 永不被选"一致）
 *       https://wiki.nimbyrails.com/index.php?title=Station
 *       https://wiki.nimbyrails.com/index.php?title=Simulation
 *
 *  4b) ⚠ **wiki 上没有任何一页写了"上下客"的算术**：Pax 页的 "Pax boarding behaviour" 一节
 *     只写了一句 "See: * Boarding"，而那个 Boarding 页是**红链（不存在，404）**；
 *     wiki 的全文搜索对 boarding / alight / capacity 都没有命中。
 *     所以本作的上/下客口径（先下后上、下车腾出的座位同一次停站就能用、只按本线的桶拉人、
 *     永不超过定员）是按游戏的实际行为 + 用户给出的验收口径实现的，代码在 transit.js 的
 *     _serveStation（注释里写了四步算术），验收测试在 tests/transit-pax-detail-test.js。
 * 
 *
 *  5) v1.12 又改过一次生成方式：乘客先按**人口密度**生成在地图上的"地理点"上（而不是先选
 *     车站），目的地也是地理点，之后才在这些点可达的车站里挑站。车站的客流速率同时取决于
 *     "车站周边人口密度"和"从该站可达的人口"（受距离需求曲线约束）；车站覆盖范围可以重叠
 *     （不再像 1.11 那样切分覆盖区）。玩家可以放 POI（机场 / 办公楼 / 球场之类）给某个点加
 *     人口，并给每个 POI 单独配需求曲线（比如球场一周只热闹几个小时）。
 *     beta 期间覆盖半径一度是 3 km，实测后调回 **2.3 km**。
 *     需求表 NR 会预先把"格子 × 格子"的关系算好缓存（1.12 的 demand tile，后来改成按距离 /
 *     人口自适应的四叉树分组），车站被编辑时才重算。
 *     https://www.eprison.de/spiele/nimby-rails/steam-news/5759616966679638804/6590/64237.html
 *     https://carloscarrasco.com/nimby-rails-may-2024/
 *
 *  6) 人口图层：NR 用欧盟 GHS-POP 的 **250 米**人口网格 + GHS-BUILT 的 30 米建筑数据，
 *     两层合起来算车站 coverage（把 250 米格子里的人按建筑摊到具体位置）。
 *     本作的 population_cells 就是 250 米网格，分辨率和 NR 一致（数据源不同：
 *     我们用 OSM 建筑占地 × 楼层数推算）。
 *     https://wiki.nimbyrails.com/index.php?title=Population_layer
 *
 *  本作与 NR 的差异（都是明写的简化，不是偷偷改口径）：
 *    · 换乘与站间步行接驳（OSI）**已经实现**（见 transit.js 的 _searchItineraries）：
 *      连通判据不是"同一条线"，而是一条**行程**（Dijkstra 搜索，最多换乘 3 次 + 2.3 km / 1 m/s
 *      的步行接驳），乘客在第一段的线路桶里排队，到换乘站下车后重新排下一段的队。
 *      仍然简化的是：NR 按时刻表算"dominating trip"（最快的那条路线），本作用的是一条
 *      带换乘惩罚的静态最优行程（没有车次时刻，只有班次间隔）。
 *    · 距离档（local / regional / long）会**同时**用来挑时段曲线和限制候选目的站
 *      （NR 1.11 的写法；1.12 把硬切分删掉了 —— Distance_category 页现在挂着
 *      "Deleted feature"，r457 / 2024-09-30），所以这里留了 config.odBandCandidates
 *      开关：关掉就退回 1.12 之后的连续距离需求曲线）。
 *    · 步行接驳（OSI）只用在"这个车站没有线路"的场合（起点侧走出去 / 目的站侧走回来）与
 *      中途换乘：起点站自己有车时，乘客不会走到旁边另一个站去坐车（见 transit.js 类头说明）。
 *      纯步行的 O/D 也不算行程（一次行程至少要坐一段车）。
 *    · 用 250 米人口网格代替 NR 的 GHS-POP + GHS-BUILT 两层数据。
 *    · 活跃度（繁华度）是本作加的：NR 靠 GHS-BUILT 判断这 250 米里的人住在哪几栋楼里；
 *      我们只有 OSM，就用 landuse / amenity 等地块给格子一个"建成度"乘数。
 *    · **站台容量 / 站厅没有模拟**：NR 的站台有 pax capacity（50 ~ 100,000 可调），装不下的人
 *      会溢出到站厅（Station 页："Hall - Show pax who cannot currently fit on the platforms.
 *      This includes pax who are making Out-of-Station interchanges."）。本作的乘客一律排在
 *      站台队列里（按车站 × 公司 × 线路分桶），没有"站台装满 → 溢出到站厅"这一步；
 *      步行接驳的人也不进"站厅计时器"列表，而是记在 walkers 里（客户端有自己的显示）。
 *    · **乘客满意度没有模拟**：NR 的满意会增减 spawn rate（Spawn rate 页原文见上），
 *      本作的 demand 只看覆盖人口 × 活跃度 × 出行率，没有满意度项。
 *    · **POI 没有模拟**：NR 1.12 允许在地理点上放 POI（机场 / 办公楼 / 球场）给某一点加人口
 *      并单独配需求曲线（见上面第 5 条）。本作只有 OSM 建筑推出的人口网格。
 *    · **全局 pax demand factor** 在本作里就是 config.transit.tripRatePerDay
 *      （NR 欧洲的现实取值 8%~15% 见 Spawn rate 页）。
 *    · **"上下客"的算术 wiki 上没有出处**（Pax 页的 Boarding 是红链、全文搜索也没有命中），
 *      所以那部分按游戏实际行为与用户给的验收口径实现并单独写了专项测试：
 *      tests/transit-pax-detail-test.js（先下后上 / 定员 / 只拉本线的桶 / 按目的地分组）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 二、本文件的数值口径
 *
 *   人口 ≈ Σ 住宅建筑占地面积 × 楼层数 × 人均楼面面积倒数（只有住宅算人口）
 *   岗位 ≈ Σ 商业 / 办公 / 工业类建筑的楼面面积 × 岗位密度
 *          ← **只用于界面展示（"这里有多少上班的地方"），不参与任何客流计算**
 *   活跃度 = 每个 250 米格子的建成度系数（1.0 = 这一格没有任何地块信息）
 *   车站需求 demand = 覆盖人口（距离加权）× 活跃度          ← 只看人口，与 NR 一致
 *   车站日上车人数 dailyTrips = demand × 出行率 tripRatePerDay
 *   某一秒的上车速率 = Σ_距离档[ 该档日人数 ÷ (运营小时数 × 3600) × 时段曲线(运营小时) × 周末系数 ]
 *     · 权重（覆盖人口的非线性 + 线路条数 + 距离需求曲线）、档位分界都放在 PAX 里
 *     · O/D 表的构建在 transit.js 的 _ensureOdDemand（需要"线路"才知道谁连得通）
 *
 * 性能：本文件只负责"人口 → 车站需求"这一层，具体查表在 transit.js；O/D 表按
 * 人口网格版本 + 游戏日 + 线路签名做缓存，热路径只做 Map 查表和一个乘数。
 *
 * 人口/岗位按 250 米网格存进 SQLite（population_cells），并记录每个 way 的贡献
 * （population_sources），这样玩家改了一栋楼，只需要重算它覆盖的格子。
 * 活跃度不落库：它由地块多边形的外接矩形推出，启动后第一次用到时算一遍并常驻内存
 * （见 _ensureActivity），地块改动后由 index.js 调用 invalidateActivity() 重算。
 */
const { ringAreaM2, metersBetween } = require('./geo');

const CELL_M = 250;
const REF_LAT = 39.9042;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((REF_LAT * Math.PI) / 180);

/** 每平方米楼面容纳的人数（住宅楼越高越接近这个密度） */
const PEOPLE_PER_M2_FLOOR = 0.03;
/**
 * 商业/办公类建筑每平方米的岗位数。
 * ⚠ 这个数字只用来在界面上显示"这一带有多少上班的地方"，**不参与任何客流计算**：
 *    NR 的 demand 只看覆盖人口（见文件头第 1 条），没有岗位模型，所以岗位于本作只是参考值。
 */
const JOBS_PER_M2_BUILDING = 0.02;

/**
 * 人口网格口径版本：1 = 所有建筑都算人口（旧口径）；2 = 住宅算人口、商业/办公/工业算岗位。
 * 只用来提示"库里的网格是旧口径，需要全量重建"，不影响读取（老数据照样能玩，只是口径旧）。
 * 注意：v2 之后客流的**公式**改成了 NIMBY Rails 那套（不再用岗位），但那只在运行时计算，
 * 网格本身（哪栋楼贡献多少人口）没变，所以这个版本号不需要跟着改，也不用重建网格。
 */
const MODEL_VERSION = 2;

/** 商业 / 办公 / 工业类建筑：只产生岗位，不产生住户 */
const JOB_BUILDINGS = new Set([
  'commercial', 'office', 'industrial', 'retail', 'warehouse', 'supermarket', 'kiosk',
  'hotel', 'hospital', 'school', 'university', 'college', 'kindergarten', 'factory',
  'hangar', 'stadium', 'train_station', 'transportation', 'mall', 'civic', 'government',
]);
/** 非居住、也非岗位的建筑（棚子、车库、围墙之类）：既不算人口也不算岗位 */
const NON_LIVING_BUILDINGS = new Set([
  'roof', 'ruins', 'construction', 'bridge', 'wall', 'garage', 'garages', 'shed',
  'farm_auxiliary', 'stable', 'barn', 'cowshed', 'sty', 'greenhouse', 'boathouse',
  'digester', 'slurry_tank', 'silo', 'storage_tank', 'transformer_tower', 'water_tower',
  'bunker', 'carport', 'tent', 'tower', 'grandstand', 'service', 'temporary',
]);
/** building=yes 这种"看不出用途"的建筑，配上这些标签就当成岗位建筑（整栋都是工作场所） */
const JOB_AMENITY = new Set([
  'school', 'kindergarten', 'college', 'university', 'hospital', 'clinic', 'doctors',
  'restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'food_court', 'cinema', 'theatre',
  'nightclub', 'marketplace', 'bank', 'bus_station', 'ferry_terminal', 'townhall',
  'library', 'community_centre', 'arts_centre', 'police', 'fire_station', 'post_office',
]);

/**
 * NIMBY Rails 式乘客行为参数。想改"乘客怎么挑目的地、什么时候出门"只改这里
 * （每一条都对应文件头里的一条研究结论，来源见文件头）：
 *
 *   bandMaxM      三档距离的**分界**（米）：local ≤15 km、regional ≤100 km、其余 long。
 *                 NR 最早是按档位硬切分候选车站的（wiki 的 Destination 页现在还是这么写的），
 *                 但 1.12 把这个硬切分删掉了（Distance_category 页现在标着 "Deleted feature"）：
 *                 因为硬切分有个著名毛病 —— "整个网络都在一个城市里、只有一个站在 100 km 外，
 *                 于是所有长途乘客都涌向那一个站"。所以本作默认**既**用档位挑时段曲线，
 *                 **也**用档位限制候选（bandMix + odBandCandidates；关掉开关就退回 1.12 的
 *                 连续距离需求曲线）。
 *   bandMix       三档的乘客份额。NR 的 spawn rate 是"每一档各有一个"的
 *                 （Spawn rate 页原文："Demand governs the base spawn rate, separately for each
 *                 distance category"），但 wiki 没有公开三档的具体比例，所以这里给一组
 *                 现实的估计值：绝大多数出行是本地通勤，区域次之，长途极少。
 *                 只有 odBandCandidates 打开时它才参与分配（见 transit.js 的 _ensureOdDemand）。
 *   decayMeters   距离需求曲线的尺度 d0（米）：w = 1 / (1 + d/d0)^β
 *   decayBeta     距离需求曲线的指数（NR 的 demand curve 就是需求随距离下降的那条曲线）
 *   coverageExp   目的站覆盖人口的指数（NR：覆盖的影响是非线性的）
 *   coverageFloor 覆盖人口的"默认水平"（人）：覆盖很小的站也仍然会被选中（NR 原文）
 *   lineWeight    目的站每多一条停靠线路的权重增量（NR：线路条数的影响近似线性）
 *   minPeople     每天不足这么多人的 O/D 对不落表（零头，只为控制表的大小；transit 那边用
 *                 config.transit.odMinPeople 覆盖，这里是默认值）
 *   nightFloor    运营时段之外（深夜）的时段系数：代表夜班车，不会把一天的客流总量撑爆
 *   hourly        运营时段内的时段曲线，按档分开，**每一档的求和 = 运营小时数**
 *                 （所以一天的积分正好等于"人/日"，见 paxRateFactor）
 *                 第 0 个运营小时就是游戏日的 00:00，早晚高峰落在运营时段中间
 *   weekend       周末系数（NR：周末整体更低，长途反而更高）
 *   maxTransfers / maxWalkLegs / osiRadiusM / walkSpeedMps / transferPenaltySec /
 *   boardPenaltySec / walkPenaltySec / rideSpeedKmh / maxJourneySec
 *                 换乘与站间步行接驳（OSI）的参数，见下面 OSI 那一段的出处：
 *                 "The max radius at which an OSI is possible is 2.3km ... the pax are
 *                 walking at a speed of 1m/s"（wiki: Station）
 *                 transferPenaltySec 是"换乘要再等一班车"的等效时间，只用于挑路线
 *                 （NR 用真实时刻表算 dominating trip，本作用这个惩罚近似）。
 *                 ⚠ **osiRadiusM 现在是"下限"而不是"固定半径"**：按用户口径，两站能不能站间
 *                 换乘由**两站的覆盖范围（catchment）**决定 —— 覆盖圈相交就互通，
 *                 而 osiRadiusM 只在两站覆盖范围都很小时兜底（wiki 的 2.3 km 就是那个兜底值）。
 *                 完整口径（上限、相对上限、安全阀）在 transit.js 的 config.transit 与
 *                 Transit#transferWalkRadiusM 里，那是唯一实现处；这里只是默认值表。
 */
const PAX = {
  bandMaxM: { local: 15000, regional: 100000, long: Infinity },
  bandMix: { local: 0.76, regional: 0.20, long: 0.04 },
  decayMeters: 4000,
  decayBeta: 0.85,
  coverageExp: 0.75,
  coverageFloor: 300,
  lineWeight: 1,
  minPeople: 0.02,
  nightFloor: 0.15,
  serviceHours: 18,
  // ── 换乘 / 站间步行接驳（OSI）──
  maxTransfers: 3,            // 最多换乘 3 次（= 最多 4 段乘车）
  maxWalkLegs: 2,             // 一次行程里最多 2 段步行接驳（起点 / 换乘）
  osiRadiusM: 2300,           // 站间步行接驳的**下限**（米）：wiki 原文 2.3 km。实际允许距离由两站的
                              // 覆盖范围决定（换乘半径 = 覆盖范围，见 transit.js 的 transferWalkRadiusM）
  walkSpeedMps: 1,            // 步行速度 1 m/s：wiki 原文（新规则没改速度，也没改每段步行的固定代价）
  transferPenaltySec: 600,    // 每次换乘的等效等待时间（游戏秒）
  boardPenaltySec: 300,       // 每次上车的等效等待时间（游戏秒）
  walkPenaltySec: 60,         // 每段步行的固定代价（进出站 / 找路，游戏秒）
  rideSpeedKmh: 45,           // 估算"坐车要多久"用的平均旅行速度（只用于挑路线，不进模拟）
  maxJourneySec: 8 * 3600,    // 一次行程的估算时间上限：超过就不算可达（保护搜索规模）
  hourly: {
    // 通勤（local）：运营日开头先有一波出门，上午 07~09 与傍晚 15~17 两个高峰（游戏日 0 点 = 运营日 0 点）
    local: [1.00, 0.90, 0.85, 0.85, 0.90, 1.00, 1.15, 1.35, 1.40, 1.20, 1.05, 0.95,
      0.90, 0.95, 1.05, 1.15, 1.15, 1.10],
    // 区域：比通勤平，峰更缓
    regional: [0.95, 0.90, 0.85, 0.85, 0.90, 1.00, 1.10, 1.20, 1.20, 1.10, 1.05, 1.00,
      0.95, 1.00, 1.05, 1.10, 1.10, 1.05],
    // 长途：白天基本是平的（NR 原文：区域与长途的需求比通勤更分散）
    long: [0.90, 0.90, 0.90, 0.90, 0.95, 1.00, 1.05, 1.10, 1.10, 1.05, 1.05, 1.00,
      1.00, 1.05, 1.05, 1.05, 1.05, 1.00],
  },
  weekend: { local: 0.42, regional: 0.75, long: 1.15 },
};

/** 三档距离的固定顺序（local → regional → long），代码里到处都用它遍历 */
const PAX_BANDS = ['local', 'regional', 'long'];

/** 车站需求里"岗位会不会影响客流"的开关：NR 没有岗位模型，所以恒为 false（保留常量便于对照） */
const JOBS_AFFECT_DEMAND = false;

/** 每档时段曲线的平均值（把表归一化成"运营时段内求和 = 运营小时数"，一天积分正好等于日上车人数） */
const PAX_HOURLY_MEAN = {};
for (const b of PAX_BANDS) {
  const t = PAX.hourly[b];
  PAX_HOURLY_MEAN[b] = t.reduce((a, v) => a + v, 0) / t.length;
}

/** 一个直线距离（米）落在哪一档（NR 的 distance category：也是"乘客在哪个档"的判据） */
function bandOfMeters(meters) {
  const m = Math.max(0, Number(meters) || 0);
  if (m <= PAX.bandMaxM.local) return 'local';
  if (m <= PAX.bandMaxM.regional) return 'regional';
  return 'long';
}

/**
 * 某一档的直线距离范围（米）：local [0, 15 km]、regional (15 km, 100 km]、long (100 km, ∞)。
 * 挑目的站时用它筛候选（"目的地必须落在乘客自己那一档里"），UI 上也用它画档位说明。
 */
function bandRangeOf(band) {
  const b = PAX_BANDS.includes(band) ? band : 'local';
  if (b === 'local') return { band: b, minM: 0, maxM: PAX.bandMaxM.local };
  if (b === 'regional') return { band: b, minM: PAX.bandMaxM.local, maxM: PAX.bandMaxM.regional };
  return { band: b, minM: PAX.bandMaxM.regional, maxM: Infinity };
}

/**
 * 三档乘客份额（PAX.bandMix）按"这一站真的有候选目的站的档"归一化。
 * 这是 NR 的"每一档各有一个 spawn rate"在本作的落地：乘客生成时先被分到某一档
 * （local 通勤 / regional 区域 / long 长途，见 Pax 页原文），然后只在**自己那一档**的
 * 距离范围里挑目的站。
 *
 *   bands          这一站真的有候选（且可达）的档，例如 ['local','regional']
 *   fallback=true  没有候选的档：把它的份额按比例补到有候选的档上（默认，见 transit.js 的说明）
 *   fallback=false 没有候选的档：那部分乘客就"哪儿也去不了"（NR 1.11 的硬切分就是这个后果，
 *                  wiki 专门点了这个毛病：全城网络里唯一一个 100 km 外的站会吃掉所有长途乘客）
 *
 * 返回 { local, regional, long }，三档之和 ≤ 1（fallback=false 时 < 1 的差额就是走不掉的乘客）。
 */
function bandSharesOf(bands, fallback = true) {
  const mix = PAX.bandMix || {};
  const have = new Set((Array.isArray(bands) ? bands : []).filter((b) => PAX_BANDS.includes(b)));
  const out = { local: 0, regional: 0, long: 0 };
  let sum = 0;
  for (const b of PAX_BANDS) {
    const w = Math.max(0, Number(mix[b]) || 0);
    if (have.has(b)) { out[b] = w; sum += w; }
  }
  if (!(sum > 0)) return out;                       // 一个候选都没有：乘客哪儿也去不了
  if (fallback) {
    // 有候选的档按原比例放大，补回"没有候选的档"留下的份额（总量守恒）
    for (const b of PAX_BANDS) out[b] /= sum;
  }
  return out;
}

/**
 * 某个运营小时、某一档的相对需求形状（均值 = 1）。
 * 第 0 个运营小时 = 游戏日的 00:00；运营时段之外的深夜用 nightFloor（夜班车）。
 */
function hourlyShapeOf(band, hour) {
  const t = PAX.hourly[band] || PAX.hourly.local;
  const h = ((Math.floor(Number(hour) || 0) % 24) + 24) % 24;
  const serviceHours = t.length;
  if (h >= serviceHours) return PAX.nightFloor;      // 运营时段之外：只剩夜班车
  const mean = PAX_HOURLY_MEAN[band] || 1;
  return Math.max(0, t[h] / mean);
}

/** 第 day 天、某一档的周末系数（NR：周末整体更低，长途反而更高） */
function weekendFactorOf(band, day) {
  const d = Math.max(1, Math.round(Number(day) || 1));
  const weekday = d % 7;                       // 7 % 7 = 0、6 % 7 = 6 → 周末
  const weekend = weekday === 0 || weekday === 6;
  const f = PAX.weekend[band];
  return weekend && Number.isFinite(f) ? f : 1;
}

/**
 * 一个 O/D 对（起点 → 目的车站在直线距离 meters 上）的两件事：
 *   · 属于哪一档（bandOfMeters）
 *   · 距离需求曲线的权重（distanceCurveOf）：NR 的 demand curve，
 *     w = 1 / (1 + d/d0)^β，越远越不容易被选成目的地
 */
function distanceCurveOf(meters) {
  const d = Math.max(0, Number(meters) || 0);
  return 1 / Math.pow(1 + d / PAX.decayMeters, PAX.decayBeta);
}

/**
 * 目的车站的"被选中权重"（NR 原文：按目的站覆盖人口与停靠线路条数加权）：
 *   coverageWeight = 覆盖人口^coverageExp + coverageFloor^coverageExp   ← 非线性 + 默认水平
 *   线路因子       = 1 + lineWeight × 停靠线路条数                        ← 近似线性
 * 覆盖人口为 0 的车站返回 0：NR 原文说它"永远不会被选为 origin 或 destination"。
 */
function destinationWeightOf(coverage, lineCount, meters) {
  const cov = Math.max(0, Number(coverage) || 0);
  if (!(cov > 0)) return 0;
  const base = Math.pow(cov, PAX.coverageExp) + Math.pow(PAX.coverageFloor, PAX.coverageExp);
  const lines = 1 + PAX.lineWeight * Math.max(0, Number(lineCount) || 0);
  return base * lines * distanceCurveOf(meters);
}

/* ------------------------------ 活跃度（建成度） ------------------------------ */
// 活跃度是给"格子"用的系数：它代表这一格的建成度（NR 靠 GHS-BUILT 卫星建筑数据判断
// "这 250 米里的人具体住在哪几栋楼里"，本作只有 OSM，就用地块多边形给一个乘数）。
//   地块包含该格（格中心落在地块外接矩形内）        → 用原值，例如 商业/零售/办公 1.6
//   只是落在地块 200 米邻域内（外接矩形再外扩一格）→ 折半生效 1 + (f - 1) × 0.5，如 1.6 → 1.3
//   完全没有地块覆盖                              → 1.0（"没有信息"，不是"没人"）
// 一格被多个地块覆盖时取"最强"的那个系数（取最大值，与遍历顺序无关）。
//
// ⚠ 任何"地块多边形"（闭合 way，面积够大）都必须给出一个**非 0** 的活跃度：
//   分类得出来的系数照用（绿地 0.8、水面 0.8 也是非 0），分类不出来（或者分类结果正好
//   等于基准 1.0）的用 ACTIVITY_POLYGON_MIN 兜底。否则客户端画活跃度图层时，这些
//   明明画了多边形的地方会因为"没有这个格子的值 / 值等于基准被当成没有"而整片显示成 0。
const ACTIVITY_BASE = 1;
const ACTIVITY_NEAR_M = 200;            // "繁华地段"的影响半径（米）
const ACTIVITY_NEAR_DISCOUNT = 0.5;     // 只是"邻近"时的折半系数
const ACTIVITY_MIN_AREA_M2 = 25;        // 退化/极小的地块忽略（噪声；正常商铺也会保留）
/**
 * 地块多边形的活跃度下限（>0 且 != 基准 1.0）。
 * 只要这一格上有任何面积足够的地块多边形，活跃度就至少是这个值：
 * 1.0 表示"这一格没有任何地块信息"，而"有地块"说明这里是人活动的地方，所以略高于 1.0。
 */
const ACTIVITY_POLYGON_MIN = 1.05;

/** landuse=* → 活跃度：商业/零售/办公 1.6、学校医院枢纽 1.5、工业 1.2、住宅 1.05、纯绿地农地水面 0.8 */
const ACTIVITY_LANDUSE = {
  commercial: 1.6, retail: 1.6, office: 1.6,
  education: 1.5, hospital: 1.5, railway: 1.5, port: 1.5,
  industrial: 1.2, quarry: 1.2, landfill: 1.2,
  residential: 1.05, village: 1.05, recreation_ground: 1.05, religious: 1.1, garages: 1.1,
  fairground: 1.3,
  // 这几个原本是 1.0（等于基准）→ 会被当成"没有值"，所以抬到地块下限 ACTIVITY_POLYGON_MIN
  construction: ACTIVITY_POLYGON_MIN, brownfield: ACTIVITY_POLYGON_MIN, military: ACTIVITY_POLYGON_MIN,
  plant_nursery: 0.8,
  farmland: 0.8, farmyard: 0.8, forest: 0.8, meadow: 0.8, grass: 0.8, orchard: 0.8, vineyard: 0.8,
  allotments: 0.8, cemetery: 0.8, basin: 0.8, reservoir: 0.8, salt_pond: 0.8, aquaculture: 0.8,
  greenfield: 0.8, village_green: 0.8, greenhouse_horticulture: 0.8,
};

/** amenity=* → 活跃度：餐饮零售类 1.6，学校/医院/交通枢纽 1.5，其余公共设施小幅提升 */
const ACTIVITY_AMENITY = {
  marketplace: 1.6, restaurant: 1.6, fast_food: 1.6, cafe: 1.6, bar: 1.6, pub: 1.6,
  bank: 1.6, food_court: 1.6, cinema: 1.6, theatre: 1.6, nightclub: 1.6, ice_cream: 1.6,
  school: 1.5, kindergarten: 1.5, college: 1.5, university: 1.5,
  hospital: 1.5, clinic: 1.5, doctors: 1.5,
  bus_station: 1.5, ferry_terminal: 1.5, taxi: 1.5,
  library: 1.3, townhall: 1.3, community_centre: 1.3, arts_centre: 1.3,
  place_of_worship: 1.2, fuel: 1.2, parking: 1.2,
};

/** place=* → 活跃度：城市/城区中心比街区更"繁华" */
const ACTIVITY_PLACE = {
  city: 1.6, town: 1.5, quarter: 1.4, suburb: 1.3, borough: 1.3, neighbourhood: 1.3,
  village: 1.05,
  // hamlet / locality 原来是 1.0（= 基准）→ 抬到地块下限，避免"有地块却显示 0"
  hamlet: ACTIVITY_POLYGON_MIN, locality: ACTIVITY_POLYGON_MIN,
  isolated_dwelling: 0.9,
};

/** leisure=* → 活跃度：公园类绿地拉低，场馆类拉高 */
const ACTIVITY_LEISURE = {
  park: 0.8, garden: 0.9, nature_reserve: 0.8, golf_course: 0.8,
  playground: 1.05, sports_centre: 1.3, stadium: 1.4, marina: 1.2,
};

/** natural=* → 活跃度：水面与林地这类纯自然地块 0.8 */
const ACTIVITY_NATURAL = {
  water: 0.8, bay: 0.8, wetland: 0.8, wood: 0.8, scrub: 0.8, grassland: 0.8, heath: 0.8,
  sand: 0.8, beach: 0.8, bare_rock: 0.8, fell: 0.8, moor: 0.8, glacier: 0.8,
};

/**
 * 一个地块（way 的标签）对应的活跃度系数；返回 null 表示"分类不出来"。
 * 同一地块上多个标签同时命中时取最大值（例如 shop + residential → 1.6）。
 * 注意：null 不等于"这块地没有活跃度"——只要它是一块"地块多边形"（见 isAreaPolygon），
 * _ensureActivity 会用地块下限 ACTIVITY_POLYGON_MIN 兜底，保证不会是 0 / 基准（#14）。
 */
function activityFactorOf(tags) {
  if (!tags) return null;
  let f = null;
  const bump = (v) => {
    if (v == null || !Number.isFinite(v)) return;
    f = f == null ? v : Math.max(f, v);
  };
  if (tags.landuse) bump(ACTIVITY_LANDUSE[tags.landuse]);
  if (tags.amenity) bump(ACTIVITY_AMENITY[tags.amenity]);
  if (tags.place) bump(ACTIVITY_PLACE[tags.place]);
  if (tags.leisure) bump(ACTIVITY_LEISURE[tags.leisure]);
  if (tags.natural) bump(ACTIVITY_NATURAL[tags.natural]);
  if (tags.shop) bump(1.6);                    // 零售（商铺多边形）
  if (tags.office) bump(1.6);                  // 办公
  if (tags.tourism === 'hotel' || tags.tourism === 'museum') bump(1.5);
  if (tags.railway === 'station' || tags.railway === 'halt') bump(1.5);   // 交通枢纽
  if (tags.public_transport === 'station') bump(1.5);
  return f;
}

/**
 * 这条 way 算不算"地块多边形"（画出来的面，而不是一条线）？
 *   · area=no 明确不是；area=yes 明确是；
 *   · 带 highway / railway / waterway / barrier / route 之类"线性要素"标签的闭合 way
 *     （环岛、环线、绕一圈的护栏）不算面；
 *   · 其余闭合 way（用地、自然、商圈、车站面……）都算。
 * 说明：单独的 building 多边形**不算**（一栋楼不是"用地区块"）。原因很实际：
 *   北京数据集里有 11 万多个建筑面，把它们都塞进活跃度图层，会让每次编辑一栋楼之后的
 *   活跃度重建要 2 秒左右（index.js 编辑后会调 invalidateActivity），把编辑手感毁掉。
 *   用地/商圈/自然/车站这些"区块"一共约 4.5 万个，重建只要零点几秒，够用。
 */
function isAreaPolygon(tags) {
  if (!tags) return false;
  if (tags.area === 'no') return false;
  if (tags.area === 'yes') return true;
  if (tags.highway || tags.railway || tags.waterway || tags.barrier || tags.route) return false;
  return true;
}

/** 活跃度格子的内部键：x * 100000 + y（比字符串键省内存；|y| 远小于 50000） */
function activityKey(x, y) {
  return x * 100000 + y;
}

const round = (v, n = 2) => {
  const p = Math.pow(10, n);
  return Math.round(v * p) / p;
};

/**
 * 车站需求（NIMBY Rails 的 demand，人/日）——**只看人口**。
 *
 *   需求 = 覆盖人口（距离加权）× 活跃度
 *
 * 出处（见文件头第 1 条）：NR 的 demand 由"车站覆盖范围内的人口 + 时刻 + 星期 + 全局
 * demand factor"决定，wiki 明确写了 "population is the only factor considered"，
 * 而且没有"早高峰往市中心、晚高峰往外"的方向性。所以这里**没有岗位项、没有重力通勤**：
 * 覆盖了多少人，这一站每天就产生多少人的出行需求，再乘出行率就是日上车人数。
 * 参数 c 就是 Population#catchment() 的返回值（只要带 pop / activity 即可；
 * 里面的 jobs 字段只是展示用的参考值，不参与计算）。
 */
function stationDemand(c) {
  if (!c) return 0;
  const act = Number.isFinite(c.activity) && c.activity > 0 ? c.activity : ACTIVITY_BASE;
  const pop = Number(c.pop) || 0;
  return Math.max(0, pop * act);
}

/**
 * 第 day 天的"整天需求系数"（与 Population#dailyFactor 同一套算法，供外部/测试直接算）。
 * 现在是 NIMBY Rails 的周末系数：通勤类周末打折、长途周末反而更高（按档查 PAX.weekend），
 * 再叠一点点确定性抖动（同一天重放结果一致）。
 */
function dailyFactorOf(day, band = 'local') {
  const d = Math.max(1, Math.round(Number(day) || 1));
  return weekendFactorOf(band, d) * (0.92 + (((d * 2654435761) >>> 0) % 160) / 1000);
}

/**
 * 某一档、某个运营小时、第 day 天的"每秒需求系数"：
 *   hourlyShapeOf(band, hour) × weekendFactorOf(band, day) ÷ (运营小时数 × 3600)
 * 用法：某站某一档每天有 N 人上车，则这一秒的上车速率（人/游戏秒）= N × paxRateFactor(...)。
 * 归一化口径：时段曲线在运营时段内的求和 = 运营小时数（均值 1），所以在运营时段上积分
 *   一天正好得到 N 人 —— 不会系统性多算或少算。运营时段之外只有 nightFloor 那一点夜班车。
 *
 * serviceHours 默认取 PAX.serviceHours（18 小时，与 config.transit.serviceHours 一致）。
 */
function paxRateFactor(band, hour, day, serviceHours) {
  const sh = Math.max(1, Number(serviceHours) || PAX.serviceHours);
  return (hourlyShapeOf(band, hour) * weekendFactorOf(band, day)) / (sh * 3600);
}

/** 会影响活跃度的标签（与 activityWays 的 SQL 条件保持一致） */
const ACTIVITY_TAGS = ['landuse', 'amenity', 'place', 'leisure', 'natural', 'shop', 'office', 'tourism'];
function cellOf(lat, lon) {
  return {
    x: Math.floor((lon * M_PER_DEG_LON) / CELL_M),
    y: Math.floor((lat * M_PER_DEG_LAT) / CELL_M),
  };
}

function cellCenter(x, y) {
  return {
    lat: ((y + 0.5) * CELL_M) / M_PER_DEG_LAT,
    lon: ((x + 0.5) * CELL_M) / M_PER_DEG_LON,
  };
}

class Population {
  constructor(db, options = {}) {
    this.db = db;
    this.cellM = options.cellM || CELL_M;
    /** 人口/岗位网格的版本号：网格一变就 +1，交通那边的车站需求 / O/D 缓存据此失效 */
    this.version = 1;
    /** 当前游戏日（交通那边的时钟跨天时调用 setDay），影响时段曲线与周末系数 */
    this.day = 1;
    this._st = {
      taggedWays: db.prepare("SELECT id, tags FROM ways WHERE deleted = 0 AND tags IS NOT NULL"),
      wayById: db.prepare('SELECT id, tags, deleted FROM ways WHERE id = ?'),
      wayNodes: db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq'),
      nodeById: db.prepare('SELECT id, lat, lon FROM nodes WHERE id = ? AND deleted = 0'),
      upsertCell: db.prepare(`INSERT INTO population_cells(cell_x, cell_y, pop, jobs) VALUES(?,?,?,?)
        ON CONFLICT(cell_x, cell_y) DO UPDATE SET pop = pop + excluded.pop, jobs = jobs + excluded.jobs`),
      addCell: db.prepare(`INSERT INTO population_cells(cell_x, cell_y, pop, jobs) VALUES(?,?,?,?)
        ON CONFLICT(cell_x, cell_y) DO UPDATE SET pop = MAX(0, pop + excluded.pop), jobs = MAX(0, jobs + excluded.jobs)`),
      getCell: db.prepare('SELECT pop, jobs FROM population_cells WHERE cell_x = ? AND cell_y = ?'),
      getSource: db.prepare('SELECT cells FROM population_sources WHERE way_id = ?'),
      putSource: db.prepare(`INSERT INTO population_sources(way_id, cells, ts) VALUES(?,?,?)
        ON CONFLICT(way_id) DO UPDATE SET cells = excluded.cells, ts = excluded.ts`),
      delSource: db.prepare('DELETE FROM population_sources WHERE way_id = ?'),
      countCells: db.prepare('SELECT COUNT(*) AS c FROM population_cells WHERE pop > 0 OR jobs > 0'),
      sumTotals: db.prepare('SELECT SUM(pop) AS pop, SUM(jobs) AS jobs FROM population_cells'),
      cellsInBbox: db.prepare('SELECT cell_x, cell_y, pop, jobs FROM population_cells WHERE cell_x >= ? AND cell_x <= ? AND cell_y >= ? AND cell_y <= ?'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare(`INSERT INTO meta(key, value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
      // 活跃度只看地块的外接矩形（ways 表里已经算好），所以一次扫描就够，不用逐条取节点。
      // 条件 = 可能成为"地块多边形"的标签族（含 area=yes 的显式面）；是不是面由 isAreaPolygon 判定。
      activityWays: db.prepare(`SELECT id, closed, tags, min_lat, max_lat, min_lon, max_lon FROM ways
        WHERE deleted = 0 AND (
          tags LIKE '%"landuse":%' OR tags LIKE '%"amenity":%' OR tags LIKE '%"place":%'
          OR tags LIKE '%"leisure":%' OR tags LIKE '%"natural":%' OR tags LIKE '%"shop":%'
          OR tags LIKE '%"office":%' OR tags LIKE '%"tourism":%' OR tags LIKE '%"railway":"station"%'
          OR tags LIKE '%"area":"yes"%'
        )`),
    };
  }

  /**
   * 网格或活跃度变了：版本号 +1，让车站需求 / O/D 需求相关的缓存全部失效。
   * （交通那边每帧只比较版本号，不做任何重算。）
   */
  _bumpVersion() {
    this.version += 1;
    return this.version;
  }

  /** 时钟跨天：只记下"今天是第几天"，时段曲线 / 周末系数按 day 折算（周末少、长途周末反而多） */
  setDay(day) {
    const d = Math.max(1, Math.round(Number(day) || 1));
    if (d !== this.day) {
      this.day = d;
      this._bumpVersion();
    }
    return this.day;
  }

  /** 第 day 天某一档的整天需求系数（时段曲线与周末系数的汇总口径，供调试/展示） */
  dailyFactor(day, band = 'local') {
    return dailyFactorOf(day === undefined ? this.day : day, band);
  }

  /**
   * 某一档在"第 day 天、某个小时"的每秒需求系数（transit.js 的 O/D 到达速率用它）。
   * 例：某站在 local 档每天有 10000 人上车，则工作日 08:00 这一秒的到达速率
   *     ≈ 10000 × paxRateAt('local', 8, day) 人/游戏秒。
   */
  paxRateAt(band, hour, day, serviceHours) {
    return paxRateFactor(band, hour, day === undefined ? this.day : day, serviceHours);
  }

  /**
   * 网格口径检查：老库里的网格可能是旧口径（版本 1：商业楼也算了人口）建的。
   * 这里只提示、不自动重建 —— 重建一次要几分钟，交给运维（tools/rebuild-population.js）。
   */
  _checkModelVersion() {
    if (this._modelChecked) return this._modelStale;
    this._modelChecked = true;
    try {
      const row = this._st.getMeta.get('population_model');
      const v = row ? Number(row.value) : 0;
      this._modelStale = v !== MODEL_VERSION && !!this._st.countCells.get().c;
      if (this._modelStale) {
        console.warn(`[pop] 库里的网格是旧口径（v${v || '?'}，当前 v${MODEL_VERSION}）：`
          + '商业/办公建筑如今只算岗位、不再算人口。需要重算时运行 node tools/rebuild-population.js 后重启。');
      }
    } catch {
      this._modelStale = false;
    }
    return this._modelStale;
  }

  /** 一个 way 对网格的贡献（不写库，纯计算） */
  contributionOf(tags, coords) {
    const out = new Map();  // "x,y" -> {x, y, pop, jobs}
    if (!tags || coords.length < 3) return out;
    const closed = coords.length > 2 &&
      Math.abs(coords[0][0] - coords[coords.length - 1][0]) < 1e-9 &&
      Math.abs(coords[0][1] - coords[coords.length - 1][1]) < 1e-9;
    if (!closed) return out;
    const area = ringAreaM2(coords.map(([lat, lon]) => ({ lat, lon })));
    if (area < 20) return out;   // 太小的忽略

    let pop = 0;
    let jobs = 0;
    // 人口与岗位只在"建筑"上产生，而且分开口径（NIMBY Rails 那种"住户 vs 岗位"）：
    //   住宅类建筑（含看不出用途的 building=yes）→ 人口
    //   商业 / 办公 / 工业类建筑              → 岗位
    //   住宅楼底层带店面（building=apartments + shop=*）→ 人口 + 底层一点岗位
    //   棚子、车库、围墙这类非居住非岗位建筑 → 两边都不算
    // 用地区块（landuse）不再直接贡献人口或岗位 —— 它们改而影响"活跃度"（见 ACTIVITY_* 常量）。
    const building = tags.building && tags.building !== 'no'
      ? tags.building
      : (tags['building:part'] && tags['building:part'] !== 'no' ? tags['building:part'] : null);
    if (building) {
      const levels = parseFloat(String(tags['building:levels'] || tags.levels || '').replace(/[^\d.]/g, '')) || 0;
      const height = parseFloat(String(tags.height || '').replace(/[^\d.]/g, '')) || 0;
      const floors = levels || (height ? Math.max(1, Math.round(height / 3.2)) : 0);
      const effFloors = floors || (['house', 'detached', 'hut', 'garage', 'shed', 'garages'].includes(building) ? 1 : 3);
      const floorArea = area * effFloors;
      const unknownType = building === 'yes' || building === 'building' || building === 'unclassified';
      // 建筑自带的商业标签（shop / office / 餐饮学校医院之类）说明这是一栋"上班的楼"
      const jobTags = tags.shop !== undefined || tags.office !== undefined || tags.industrial !== undefined ||
        (tags.amenity !== undefined && JOB_AMENITY.has(tags.amenity));
      const isJobBuilding = JOB_BUILDINGS.has(building) || (unknownType && jobTags);
      const isLiving = !isJobBuilding && !NON_LIVING_BUILDINGS.has(building);
      if (isJobBuilding) {
        jobs += floorArea * JOBS_PER_M2_BUILDING;
      } else if (isLiving) {
        pop += floorArea * PEOPLE_PER_M2_FLOOR;
        // 住宅楼底层常有店面/办公：只按底层那点面积再算一点岗位（不重复计入整栋）
        if (jobTags) jobs += Math.min(area, 400) * JOBS_PER_M2_BUILDING;
      }
    }
    if (pop <= 0 && jobs <= 0) return out;

    // 放在建筑重心所在格子；跨多格的大地块按覆盖的格子均摊
    let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
    for (const [lat, lon] of coords) {
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    }
    const c1 = cellOf(minLat, minLon);
    const c2 = cellOf(maxLat, maxLon);
    const span = (c2.x - c1.x + 1) * (c2.y - c1.y + 1);
    const share = Math.min(span, 9);   // 最多摊到 9 个格子，避免超大地块被稀释
    for (let x = c1.x; x <= Math.min(c2.x, c1.x + 2); x++) {
      for (let y = c1.y; y <= Math.min(c2.y, c1.y + 2); y++) {
        out.set(x + ',' + y, { x, y, pop: pop / share, jobs: jobs / share });
      }
    }
    return out;
  }

  /* ------------------------------ 活跃度图层 ------------------------------ */

  /**
   * 惰性构建活跃度图层：扫一遍带 landuse / amenity / place / leisure / natural / shop / office
   * 的 way，用它们的外接矩形给 250 米格子打分（1.0 基准）。算一次常驻内存，
   * 地块被编辑后由 index.js 调 invalidateActivity() 让下次访问时重算。
   * 说明：判断"包含/邻近"用的是地块外接矩形而不是逐点多边形判定 —— OSM 里这类地块多为
   * 近似矩形，且 200 米邻域本身就放宽了边界，用矩形可以一次扫描算完，代价从秒级降到毫秒级。
   */
  _ensureActivity() {
    if (this._activity) return this._activity;
    const t0 = Date.now();
    const map = new Map();          // activityKey(x, y) -> 系数
    const near = Math.max(1, Math.ceil(ACTIVITY_NEAR_M / this.cellM));
    let ways = 0;                   // 参与计算的地块多边形数
    let fallback = 0;               // 分类不出来（或正好等于基准）→ 用地块下限兜底的个数
    for (const row of this._st.activityWays.all()) {
      let tags = null;
      try { tags = row.tags ? JSON.parse(row.tags) : null; } catch { tags = null; }
      if (!tags) continue;
      // 只有"地块多边形"（闭合的面）才参与活跃度：一条路、一条环线不算地块
      if (!row.closed || !isAreaPolygon(tags)) continue;
      // 分类得出来的系数照用；分类不出来 / 正好等于基准 1.0 → 用地块下限兜底。
      // 这一步就是 #14：**只要这一格上有地块多边形，活跃度就不会是 0 / 基准**，
      // 客户端画活跃度图层时不会再出现"明明有地块却一片空白（被当成 0）"的区域。
      let factor = activityFactorOf(tags);
      if (factor == null || factor === ACTIVITY_BASE) { factor = ACTIVITY_POLYGON_MIN; fallback += 1; }
      if (!(factor > 0)) { factor = ACTIVITY_POLYGON_MIN; fallback += 1; }
      const { min_lat: minLat, max_lat: maxLat, min_lon: minLon, max_lon: maxLon } = row;
      if (![minLat, maxLat, minLon, maxLon].every((v) => Number.isFinite(v))) continue;
      const wM = (maxLon - minLon) * M_PER_DEG_LON;
      const hM = (maxLat - minLat) * M_PER_DEG_LAT;
      if (wM <= 0 || hM <= 0 || wM * hM < ACTIVITY_MIN_AREA_M2) continue;   // 太小的地块忽略
      const c1 = cellOf(minLat, minLon);
      const c2 = cellOf(maxLat, maxLon);
      const weak = ACTIVITY_BASE + (factor - ACTIVITY_BASE) * ACTIVITY_NEAR_DISCOUNT;
      for (let x = c1.x - near; x <= c2.x + near; x++) {
        for (let y = c1.y - near; y <= c2.y + near; y++) {
          const inside = x >= c1.x && x <= c2.x && y >= c1.y && y <= c2.y;
          const v = inside ? factor : weak;
          const key = activityKey(x, y);
          const cur = map.get(key);
          if (cur === undefined || v > cur) map.set(key, v);   // 多地块覆盖时取最强
        }
      }
      ways += 1;
    }
    let sum = 0;
    let high = 0;
    let low = 0;
    for (const v of map.values()) {
      sum += v;
      if (v >= 1.5) high += 1;
      else if (v <= 0.9) low += 1;
    }
    this._activity = map;
    this._activityStats = {
      ways, cells: map.size, avg: map.size ? round(sum / map.size, 3) : ACTIVITY_BASE,
      high, low, nearM: ACTIVITY_NEAR_M, ms: Date.now() - t0,
      // 有地块但分类不出来的格子数：这些格子以前是"没有值"（客户端看起来就是 0）
      fallback, polygonMin: ACTIVITY_POLYGON_MIN,
    };
    console.log(`[pop] 活跃度图层：${ways} 个地块 → ${map.size} 个格子`
      + `（平均 ${this._activityStats.avg}，其中 ${fallback} 个地块走下限 ${ACTIVITY_POLYGON_MIN}，${this._activityStats.ms} ms）`);
    return map;
  }

  /** 地块改过之后作废活跃度缓存（人口网格那份由 touchWay 负责） */
  invalidateActivity() {
    this._activity = null;
    this._activityStats = null;
    this._bumpVersion();      // 活跃度会进车站需求，所以也算一次"变了"
  }

  /**
   * 这个 way 的标签会不会影响活跃度图层（地块多边形）？读不到就保守地当作会。
   * 与 activityWays 的 SQL 条件保持一致：这些标签都可能改变活跃度图层。
   * 注意这里**故意不包含 building**：单独的楼不是"用地区块"，把它算进来会让每次编辑
   * 一栋楼都触发一次活跃度重建（约 2 秒），把编辑器手感毁掉（见 isAreaPolygon 的说明）。
   */
  wayAffectsActivity(wayId) {
    const row = this._st.wayById.get(Number(wayId));
    if (!row || !row.tags) return true;
    let tags = null;
    try { tags = JSON.parse(row.tags); } catch { return true; }
    if (!tags) return true;
    if (ACTIVITY_TAGS.some((k) => tags[k] !== undefined)) return true;
    if (tags.area === 'yes') return true;
    return tags.railway === 'station' || tags.railway === 'halt' || tags.public_transport === 'station';
  }

  /** 某个格子（cellOf 的坐标）的活跃度 */
  cellActivity(x, y) {
    const v = this._ensureActivity().get(activityKey(x, y));
    return v === undefined ? ACTIVITY_BASE : v;
  }

  /** 某个坐标所在格子的活跃度（1.0 = 基准，>1 更繁华，<1 更冷清） */
  activityAt(lat, lon) {
    const c = cellOf(lat, lon);
    return this.cellActivity(c.x, c.y);
  }

  /** 活跃度统计（惰性构建后缓存，totals() 走这里，不在热路径上重复遍历） */
  activityStats() {
    this._ensureActivity();
    return this._activityStats;
  }

  /** 视野内"偏离基准"的活跃度格子（给前端画繁华度叠加层） */
  activityInBbox(minLon, minLat, maxLon, maxLat) {
    const map = this._ensureActivity();
    const c1 = cellOf(minLat, minLon);
    const c2 = cellOf(maxLat, maxLon);
    const out = [];
    for (let x = c1.x; x <= c2.x; x++) {
      for (let y = c1.y; y <= c2.y; y++) {
        const v = map.get(activityKey(x, y));
        if (v === undefined || v === ACTIVITY_BASE) continue;
        const center = cellCenter(x, y);
        out.push({ lat: center.lat, lon: center.lon, activity: v });
      }
    }
    return out;
  }

  /** 全量重算（导入数据后第一次启动、或手动触发） */
  buildAll(options = {}) {
    const t0 = Date.now();
    let ways = 0;
    let cells = 0;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM population_cells');
      this.db.exec('DELETE FROM population_sources');
      for (const row of this._st.taggedWays.all()) {
        let tags = null;
        try { tags = JSON.parse(row.tags); } catch { tags = null; }
        if (!tags) continue;
        const ids = this._st.wayNodes.all(row.id).map((r) => r.node_id);
        if (ids.length < 3) continue;
        const coords = [];
        for (const nid of ids) {
          const n = this._st.nodeById.get(nid);
          if (n) coords.push([n.lat, n.lon]);
        }
        const contrib = this.contributionOf(tags, coords);
        if (!contrib.size) continue;
        const json = {};
        for (const [key, v] of contrib) {
          this._st.upsertCell.run(v.x, v.y, v.pop, v.jobs);
          json[key] = [Math.round(v.pop * 100) / 100, Math.round(v.jobs * 100) / 100];
          cells += 1;
        }
        this._st.putSource.run(row.id, JSON.stringify(json), Date.now());
        ways += 1;
        if (ways % 20000 === 0 && options.onProgress) options.onProgress(ways);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // 记下这次网格是按哪个模型版本建的，下次启动就知道要不要重建
    try { this._st.setMeta.run('population_model', String(MODEL_VERSION)); } catch { /* 老库没有 meta 表就算了 */ }
    this._modelChecked = true;
    this._modelStale = false;
    this._bumpVersion();       // 网格变了：车站需求 / O/D 需求下次用到时重算
    const totals = this._st.sumTotals.get();
    return {
      ways, cells, ms: Date.now() - t0,
      population: Math.round(totals.pop || 0),
      jobs: Math.round(totals.jobs || 0),
    };
  }

  /** 增量更新：某个 way 被改动后，只重算它原来和现在覆盖的格子 */
  touchWay(wayId) {
    const old = this._st.getSource.get(wayId);
    if (old) {
      try {
        const json = JSON.parse(old.cells);
        for (const [key, vals] of Object.entries(json)) {
          const [x, y] = key.split(',').map(Number);
          this._st.addCell.run(x, y, -vals[0], -vals[1]);
        }
      } catch { /* 忽略坏数据 */ }
      this._st.delSource.run(wayId);
    }
    // 一格人口变了 → 车站需求 / O/D 表都要跟着变：版本号 +1（重算是惰性的，
    // 玩家连续改很多建筑时只会触发一次重算，不会每改一栋楼卡一下）。
    this._bumpVersion();
    const row = this._st.wayById.get(wayId);
    if (!row || row.deleted) return { removed: true };
    let tags = null;
    try { tags = row.tags ? JSON.parse(row.tags) : null; } catch { tags = null; }
    if (!tags) return { removed: true };
    const ids = this._st.wayNodes.all(wayId).map((r) => r.node_id);
    if (ids.length < 3) return { removed: true };
    const coords = [];
    for (const nid of ids) {
      const n = this._st.nodeById.get(nid);
      if (n) coords.push([n.lat, n.lon]);
    }
    const contrib = this.contributionOf(tags, coords);
    if (!contrib.size) return { added: 0 };
    const json = {};
    for (const [key, v] of contrib) {
      this._st.upsertCell.run(v.x, v.y, v.pop, v.jobs);
      json[key] = [Math.round(v.pop * 100) / 100, Math.round(v.jobs * 100) / 100];
    }
    this._st.putSource.run(wayId, JSON.stringify(json), Date.now());
    return { added: contrib.size };
  }

  /**
   * 覆盖范围内的格子（带距离权重），catchment 用这一次查询。
   * 权重 w = max(0.25, 1 - 0.75 × d / r)：越远权重越低（步行衰减），半径边缘还有 25%。
   * 这也对应 NR 的"车站 coverage / reach"：NR 半径可调，1.12 实测后上限取 2.3 km。
   */
  _catchmentCells(lat, lon, radiusM) {
    const r = Math.max(1, Number(radiusM) || 700);
    const dx = Math.ceil(r / this.cellM);
    const c = cellOf(lat, lon);
    const out = [];
    for (const row of this._st.cellsInBbox.all(c.x - dx, c.x + dx, c.y - dx, c.y + dx)) {
      const center = cellCenter(row.cell_x, row.cell_y);
      const dLat = (center.lat - lat) * M_PER_DEG_LAT;
      const dLon = (center.lon - lon) * M_PER_DEG_LON;
      const d = Math.sqrt(dLat * dLat + dLon * dLon);
      if (d > r) continue;
      out.push({
        x: row.cell_x, y: row.cell_y, pop: row.pop, jobs: row.jobs, d,
        w: Math.max(0.25, 1 - (d / r) * 0.75),
      });
    }
    return out;
  }

  /**
   * 某个坐标周边 radiusM 内的"车站覆盖"（NR 的 reach / coverage）：
   *   pop         距离权重折减后的等效人口（就是 NR 的"覆盖人口"）
   *   jobs        距离权重折减后的等效岗位（**仅供参考展示，不参与需求计算**）
   *   coverage    等效人口 × 活跃度 = 车站的"有效覆盖"（需求与 O/D 权重都用它）
   *   density     覆盖半径内的人口密度（人/km²）：NR 1.12 说车站客流速率同时取决于
   *               "车站周边人口密度"和"可达人口"，这里把密度也报出来
   *   activity    覆盖范围内按人口×距离权重加权的平均活跃度（没人时退回车站所在格）
   *   demand      车站日需求 = 覆盖人口 × 活跃度（见 stationDemand，只看人口）
   *   dailyTrips  日上车人数 = 需求 × 出行率 tripRatePerDay（在 transit.js 里乘）
   *   bands       三档距离的乘客份额（纯展示：告诉玩家"这一站的乘客里有多少是短途"）
   */
  catchment(lat, lon, radiusM = 700) {
    let pop = 0;
    let jobs = 0;
    let weightedPop = 0;      // 乘上活跃度之后的"有效人口"
    let actNum = 0;
    let actDen = 0;
    const r = Math.max(1, Number(radiusM) || 700);
    for (const c of this._catchmentCells(lat, lon, r)) {
      // 建成度高的地块等效人口更高：人口 × 距离权重 × 活跃度
      const a = this.cellActivity(c.x, c.y);
      pop += c.pop * c.w;
      jobs += c.jobs * c.w;
      weightedPop += c.pop * c.w * a;
      actNum += c.pop * c.w * a;
      actDen += c.pop * c.w;
    }
    const areaKm2 = Math.PI * r * r / 1e6;
    const out = {
      pop: Math.round(pop),
      jobs: Math.round(jobs),
      weightedPop: Math.round(weightedPop),
      activity: round(actDen > 0 ? actNum / actDen : this.activityAt(lat, lon), 2),
      // 覆盖范围内的人口密度（人/km²），NR 1.12 的车站速率看这个
      density: Math.round(areaKm2 > 0 ? pop / areaKm2 : 0),
      coverage: Math.round(weightedPop),
      radiusM: r,
      // 三档距离的分界（米）：NR 的 local / regional / long distance（只用于挑时段曲线）
      bandMaxM: { local: PAX.bandMaxM.local, regional: PAX.bandMaxM.regional, long: null },
    };
    out.demand = Math.round(stationDemand(out));
    return out;
  }

  /** 人口热力图（给前端叠加层用），只返回视野内有人的格子；每格带上活跃度 */
  cellsInBbox(minLon, minLat, maxLon, maxLat, minPop = 20) {
    const activity = this._ensureActivity();
    const c1 = cellOf(minLat, minLon);
    const c2 = cellOf(maxLat, maxLon);
    const out = [];
    const seen = new Set();
    const push = (x, y, pop, jobs, a) => {
      seen.add(activityKey(x, y));
      const center = cellCenter(x, y);
      out.push({ lat: center.lat, lon: center.lon, pop: Math.round(pop), jobs: Math.round(jobs), activity: round(a, 2) });
    };
    for (const row of this._st.cellsInBbox.all(c1.x, c2.x, c1.y, c2.y)) {
      const a = this.cellActivity(row.cell_x, row.cell_y);
      if (row.pop < minPop && row.jobs < minPop) continue;
      push(row.cell_x, row.cell_y, row.pop, row.jobs, a);
    }
    // minPop <= 0 时连"没有人但有繁华度/冷清度"的格子也带上，方便前端画活跃度底图。
    // 网格跨度太大（比如整城视野）就跳过，避免一次返回几十万个格子。
    if (!(minPop > 0)) {
      const span = (c2.x - c1.x + 1) * (c2.y - c1.y + 1);
      if (span <= 40000) {
        for (let x = c1.x; x <= c2.x; x++) {
          for (let y = c1.y; y <= c2.y; y++) {
            const key = activityKey(x, y);
            if (seen.has(key)) continue;
            const a = activity.get(key);
            if (a === undefined || a === ACTIVITY_BASE) continue;
            const cell = this._st.getCell.get(x, y);
            push(x, y, cell ? cell.pop : 0, cell ? cell.jobs : 0, a);
          }
        }
      }
    }
    return out;
  }

  totals() {
    const t = this._st.sumTotals.get();
    const act = this.activityStats();
    return {
      population: Math.round(t.pop || 0),
      // 岗位：只用于界面展示，不参与客流计算（NIMBY Rails 没有岗位模型，见文件头）
      jobs: Math.round(t.jobs || 0),
      jobsAffectDemand: JOBS_AFFECT_DEMAND,
      cells: this._st.countCells.get().c,
      cellM: this.cellM,
      // 活跃度：平均系数 / 有记录的格子数 / 繁华格(≥1.5) / 冷清格(≤0.9)
      activity: act.avg,
      activityCells: act.cells,
      activityHigh: act.high,
      activityLow: act.low,
      activityNearM: act.nearM,
      // 有地块、但分类不出来而走了下限的格子数（这些格子以前会显示成 0，见 #14）
      activityFallback: act.fallback || 0,
      activityPolygonMin: act.polygonMin || ACTIVITY_POLYGON_MIN,
      // 客流模型口径（NIMBY Rails）：需求只看覆盖人口，不看岗位
      demandModel: {
        name: 'NIMBY Rails pax（人口 → 车站需求 → 距离档 + 目的地权重 → O/D → 行程/换乘）',
        demandFormula: '需求 = 覆盖人口（距离加权）× 活跃度；日上车人数 = 需求 × 出行率',
        usesJobs: false,
        bandMaxM: { local: PAX.bandMaxM.local, regional: PAX.bandMaxM.regional, long: null },
        // 三档的乘客份额（bandMix）与"只在同档里挑目的站"的开关（transit.config.odBandCandidates）
        bandMix: Object.assign({}, PAX.bandMix),
        nightFloor: PAX.nightFloor,
        serviceHours: PAX.serviceHours,
        decayMeters: PAX.decayMeters,
        decayBeta: PAX.decayBeta,
        coverageExp: PAX.coverageExp,
        coverageFloor: PAX.coverageFloor,
        lineWeight: PAX.lineWeight,
        weekend: PAX.weekend,
        // 换乘与站间步行接驳（OSI）：出处见文件头第 4 条（wiki: Station / Simulation）
        transfers: {
          maxTransfers: PAX.maxTransfers,
          maxWalkLegs: PAX.maxWalkLegs,
          osiRadiusM: PAX.osiRadiusM,
          walkSpeedMps: PAX.walkSpeedMps,
          transferPenaltySec: PAX.transferPenaltySec,
          boardPenaltySec: PAX.boardPenaltySec,
          rideSpeedKmh: PAX.rideSpeedKmh,
          maxJourneySec: PAX.maxJourneySec,
        },
      },
      // 网格口径：true = 库里的网格是旧口径（商业楼也算人口），建议全量重建
      modelVersion: MODEL_VERSION,
      staleModel: this._checkModelVersion(),
    };
  }

  /**
   * 两点之间的直线距离（米）+ 属于哪一档 + 距离需求曲线的权重。
   * 给"线路潜力排序 / 调试"用：NR 的 destination picking 就是按这些量加权的。
   */
  demandBetween(a, b) {
    const d = metersBetween(a.lat, a.lon, b.lat, b.lon);
    return { meters: Math.round(d), band: bandOfMeters(d), distanceWeight: round(distanceCurveOf(d), 6) };
  }
}

module.exports = {
  Population, cellOf, cellCenter, CELL_M,
  ACTIVITY_BASE, ACTIVITY_NEAR_M, ACTIVITY_POLYGON_MIN, activityFactorOf, isAreaPolygon,
  stationDemand, dailyFactorOf, paxRateFactor, MODEL_VERSION,
  // NIMBY Rails 式乘客模型：距离档 / 时段曲线 / 目的地权重（transit.js 的 O/D 表用这些）
  PAX, PAX_BANDS, bandOfMeters, bandRangeOf, bandSharesOf,
  hourlyShapeOf, weekendFactorOf, distanceCurveOf, destinationWeightOf,
  // 建筑用途分类（住宅算人口 / 商业办公工业算岗位）：导出给测试与工具检查口径
  BUILDING_CLASSES: { JOB_BUILDINGS, NON_LIVING_BUILDINGS, JOB_AMENITY },
};
