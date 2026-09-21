'use strict';
/**
 * 铁路经营玩法（NIMBY Rails 风格，但跑在真实的北京 OSM 数据上）
 *
 *  - 每人一家公司：各有各的资金、站点、线路、车辆，互相能看到对方的列车
 *  - 站点吸附到真实轨道节点上；线路按站点顺序沿铁路网自动寻路
 *  - 服务端权威模拟：可调速游戏时钟（暂停 / ×1 / ×2 / ×5 / ×10 / ×20 / ×60 / ×120 / ×300）
 *    **时间基准（#时间倍率语义）：×1 时 1 实时秒 = 1 游戏秒**（1:1 真实时间）。
 *    旧版本是"1 实时秒 = 1 游戏分钟"，所以旧的 ×1 就是现在的 ×60（倍速一律是"实时时间的倍数"）。
 *    config 里的 dwellSeconds / patienceSeconds / serviceHours 等全部是**游戏秒 / 游戏小时**，与倍速无关。
 *  - 客流来自真实 OSM 建筑推算的人口，并按 NIMBY Rails 的规则变成乘客
 *    （人口 → 车站需求 → 按距离档挑目的车站 → 有线路连通才走；见 population.js 顶部的中文说明
 *     与出处链接，那里也写清了"NR 没有岗位模型、需求只看人口"这条结论）
 *  - O/D 需求表就是 NR 的 demand tile 在本作的对应物：人口网格版本 + 线路集合变化才重算，
 *    热路径（每一小步模拟、每帧广播）只查表
 *  - **缓存指纹自检**（用户口径）：每 tick 把"当前世界的版本指纹"与"缓存建起来时那个指纹"
 *    比一次（车站集合 / 覆盖半径 / 线路站序与类型 / 归属 / 人口网格版本 / 游戏日），
 *    对不上就**同一个 tick 内**重建 O/D 表与行程图，并记进 odStats().staleRecomputes
 *    —— 这样"新建车站在一个游戏分钟内就有乘客"不再依赖"每个 op 都记得作废缓存"。
 *  - **公交不互相阻挡**（#3，config.transit.busBlocking 默认 false）：公交车之间不做净距限位，
 *    只受道路网限速/拥堵系数影响；同一个站的多辆公交按"停靠位"错开画（不叠在同一个点）；
 *    公交的晚点成因记 'congestion'，'blocked' 只留给轨道车（轨道车的净距行为一个字没改）。
 */
const { metersBetween } = require('./osmdb');
// 分组撤销：osmops.js 里的 UndoBus 是 OSM 编辑与交通玩法**共用**的一条撤销时间线
// （index.js 建一条同时注入两边，于是 beginGroup/endGroup 能把两边合并成一步）。详见那里的说明。
const { UndoBus } = require('./osmops');
// #2 的失败诊断要用到"这条 highway 到底算不算机动车道"（与路网用同一个判据）
const { isDrivableHighway } = require('./railgraph');
// 车队内存态（#规模）：启动读一次，之后模拟与广播都不碰 SQLite。见那个文件顶部的说明。
const { FleetStore } = require('./transit-fleet');
// 人口/客流模型里的公式与常量（只用纯函数与常量，人口实例还是由 index.js 注入）
const {
  stationDemand, dailyFactorOf, PAX, PAX_BANDS,
  bandOfMeters, bandRangeOf, bandSharesOf, hourlyShapeOf, weekendFactorOf, destinationWeightOf,
} = require('./population');

/** 造价与运营参数（可在 config.json 的 transit 段覆盖） */
const DEFAULTS = {
  economy: false,                     // 是否启用经济系统（钱/票价/维护费）；默认关闭，专心建设与运营
  startingCash: 200000000,            // 起步资金 2 亿（economy=true 时才有意义）
  costPerMeter: { surface: 20000, elevated: 60000, tunnel: 120000 },
  stationCost: 30000000,              // 一座车站 3000 万
  vehicleBaseCost: 20000000,          // 一列车基础价 2000 万
  vehiclePerCarCost: 5000000,         // 每节车厢 +500 万
  maintenancePerCarPerDay: 20000,     // 每节车厢每游戏日维护费
  fareBase: 3,                        // 起步票价（元）
  farePerKm: 0.5,                     // 每公里票价（元）
  tripRatePerDay: 0.22,               // 覆盖人口中每天出行的比例（NR 的 global pax demand factor）
  serviceHours: 18,                   // 每天运营小时
  dwellSeconds: 30,                   // 每站停靠（游戏秒）
  // 上下客多的时候多停一会儿（现实的停站时间模型，NIMBY Rails 里对应"每站的停站时间"设置）：
  //   实际停站 = dwellSeconds + min(dwellPaxMax, 上下客人数 × dwellPaxSeconds)
  // 这样做还有个副作用是好的：停站时间随客流变化，车不会机械地每隔固定时间跑完一圈。
  dwellPaxSeconds: 0.15,              // 每位上下客 +0.15 游戏秒
  dwellPaxMax: 60,                    // 每站最多多停 60 游戏秒
  // 终点站整备时间（游戏秒）：列车在首末站要掉头、换班、留出冗余，现实里也比中间站停得久
  // （NR 里对应线路的"始发时间 / 停站时间"设置）。它同时让"绕一圈要多久"不是一个整数，
  // 所以按固定秒数采样时不会每次都撞回同一个位置。
  terminalDwellSeconds: 20,
  patienceSeconds: 900,               // 等车耐心（游戏秒）：一批乘客等超过这个时间就放弃离开（15 游戏分钟）
  cohortSeconds: 30,                  // 候车"批次"的粒度（游戏秒）：同一批乘客共用一个等待计时器
  maxCohorts: 80,                     // 每个（车站×公司）队伍最多保留几批（超了就合并最老的两批）
  accel: 0.8,                         // m/s²：未知车型的默认加速度（各车型见 VEHICLE_DYNAMICS）
  brake: 0.9,                         // m/s²：未知车型的默认制动减速度（进站停车用）
  maxCatchment: 3000,
  minGapMeters: 45,                   // 同一条线路上前后车的最小净距（车辆长度之外再加这么多）
  // ── #3 公交是不是"前车挡后车" ──
  //   false（默认，用户口径）：**公交车之间不互相阻挡** —— _enforceSpacing 完全跳过公交，
  //     公交只会因为道路网给出的限速/拥堵系数（#16 的 congestion，railgraph 算好的）慢下来；
  //     站台上同一站的多辆公交按"停靠位"错开（见 _dock 里的 dwellSlotM），不会叠在同一个点。
  //   true：恢复老行为（公交也按 minGapMeters + 车长互相限位）。轨道车（地铁/轻轨/有轨电车/铁路）
  //     **不受这个开关影响**，永远保持净距 —— 想让轨道也放开就是把这个判断也摘掉（一处条件的事）。
  busBlocking: false,
  busQueueGapMeters: 4,               // 公交在同一站排队时，前后两辆车之间留的空档（米）
  meterPerCar: 20,                    // 一节车厢按 20 米算（用于净距与地图示意）
  curveSample: 6,                     // 车辆示意多边形沿路径取几个采样点
  // 站点吸附（#2 / #15b）：公交只要求"旁边有一条可通行的道路"，**不限距离**
  //   0 = 不限距离（吸到最近的机动车道上，多远都吸；世界上没有可通行道路时才报错）
  //   想要老行为（必须在 300 米内）就把 config.transit.busSnapMeters 设成 300
  busSnapMeters: 0,
  railSnapMeters: 120,                // 铁路车站：120 米内的最近钢轨
  snapMeasureMeters: 20000,           // 吸附失败时量"到底多远"用的搜索半径（只为了报错信息）
  // O/D 需求表（NIMBY Rails 的 demand tile）：上限与"每个起点站保留几条最忙的目的地"
  odMaxStations: 4000,                // 车站总数超过这个数就只按 id 取前 N 个（保护 O(N²)）
  odMinPeople: 0.02,                  // 每天不足这么多人的 O/D 对不落表（零头）
  odDestMix: 4,                       // 每个（线路 × 车站）保留前几条目的地（用于"按目的地下车"）
  odOnlyReachable: true,              // 只在"可达"的车站里挑目的地（NIMBY Rails 1.12 的写法）
  // 距离档（NIMBY Rails 的 distance category）：候选目的站只在"乘客自己那一档"里挑。
  //   odBandCandidates=true  按档切分（1.11 的写法，wiki 的 Destination 页面就是这么写的）
  //   odBandCandidates=false 不切分，只用距离需求曲线连续衰减（1.12 之后删掉了硬切分）
  //   odBandFallback=true    某一档一个候选都没有时，把这一档的乘客份额按比例补到有候选的档
  //                          （不补的话那部分乘客就是"哪儿也去不了"，见 population.js 的说明）
  odBandCandidates: true,
  odBandFallback: true,
  // ── 换乘（transfers）与站间步行接驳（OSI）：出处与口径见 population.js 顶部的 PAX ──
  maxTransfers: PAX.maxTransfers,             // 一次行程最多换乘几次（3 次 = 最多 4 段乘车）
  maxWalkLegs: PAX.maxWalkLegs,               // 一次行程最多几段步行接驳
  // ⚠ 站间步行接驳（OSI）到底能走多远：**按两站的覆盖范围（catchment）定，不再是固定的 2.3 km**。
  //   用户口径："换乘应该按车站覆盖范围来定" —— 两站互相落在对方的覆盖范围里（两个覆盖圈相交）
  //   就能站间换乘。于是步行边的允许距离是（见 Transit#transferWalkRadiusM，唯一实现处）：
  //
  //     允许距离(A,B) = max( osiRadiusMeters,                       ← ① 下限（wiki 原文的 2.3 km）
  //                          min( 覆盖范围的距离,                      ← ② 覆盖范围给出的距离
  //                               相对上限,                            ← ③ 不能比大站自己的覆盖范围再放宽太多
  //                               绝对上限 ) )                         ← ④ 大站也不能把全城连起来
  //
  //     ② 覆盖范围的距离由 transferRadiusRule 决定：
  //          'overlap'（默认）= catA + catB      —— 两个覆盖圈相交（"两站互相在对方的覆盖范围里"）
  //          'max'            = max(catA, catB)  —— 只要求较大的那个覆盖圈罩住另一站
  //        （用户原话写的是 max(catchmentA, catchmentB)；'overlap' 是他同一句话里的
  //          "覆盖范围相交"口径，也是唯一能让"4 km 覆盖范围、相距 5 km 的两站"算得上的口径，
  //          两种都能用 transferRadiusRule 一键切换。）
  //     ③ 相对上限 = max(osiRadiusMeters, transferSpreadFactor × max(catA, catB))：用户给的 1.5 倍口径
  //     ④ 绝对上限 = transferMaxRadiusM：覆盖范围再大，步行接驳也不超过这个米数（4 km）
  //   两个覆盖范围都很小的站（默认 700 m 的铁路站：700+700 = 1400 < 2300）仍然按 2.3 km 的
  //   下限走 —— 所以**默认数据集上的步行边一条都不会变**，只有把覆盖范围调大的站才会多出边走。
  osiRadiusMeters: PAX.osiRadiusM,            // 站间步行接驳的**下限**：2.3 km（wiki: Station 原文）
  transferRadiusRule: 'overlap',              // 覆盖范围怎么折算成距离：overlap（相交）| max（取大者）
  transferMaxRadiusM: 4000,                   // 站间步行接驳的**绝对上限**（米）：防止一个大站把全城连起来
  transferSpreadFactor: 1.5,                  // **相对上限**：最多比"较大的那个覆盖半径"再放宽 50%
  transferNeighborLimit: 48,                  // 每个车站最多保留最近的 N 个步行可达邻站（0 = 不限）
  walkSpeedMps: PAX.walkSpeedMps,             // 步行速度 1 m/s（wiki: Station 原文）
  transferPenaltySeconds: PAX.transferPenaltySec,   // 换乘一次的等效等待时间（只用于挑路线）
  boardPenaltySeconds: PAX.boardPenaltySec,         // 上车一次的等效等待时间（只用于挑路线）
  walkPenaltySeconds: PAX.walkPenaltySec,           // 每段步行的固定代价（只用于挑路线）
  rideSpeedKmh: PAX.rideSpeedKmh,                   // 估算行程时间用的平均旅行速度
  maxJourneySeconds: PAX.maxJourneySec,             // 行程估算时间上限（保护搜索规模）
  itineraryMaxStates: 20000,                  // 每个起点站一次行程搜索最多展开多少个状态
  odBuildBudgetMs: 4000,                      // O/D 表构建的时间预算（超了就退回"同一条线"的老判据）
  // 底图站点导入（用 OSM 里已有的车站/公交站，而不是从零开始画）
  importStationsOnStart: false,       // 启动时自动导入一次（默认关闭；idempotent）
  importLimit: 300,                   // 一次导入最多新建几个站
  importMaxLimit: 5000,               // limit 的上限
  importSnapRailM: 200,               // 导入时铁路类站点的吸附半径（米）
  importSnapBusM: 80,                 // 导入时公交类站点的吸附半径（米）
  // 底图导入的车站挂在哪个"名义公司"名下（只是记账用的 owner/company_id，不是玩法里的公司）。
  // 车站**没有归属**这个概念：导入站和玩家自建站一样，谁都能改名 / 删除 / 挪位置，见 stationPublic。
  systemCompanyName: '国铁 / 公交集团',
  systemCompanyColor: '#607d8b',
  // ── #19 逐站预测（remainingStops）与晚点系统（NIMBY Rails 的 timetable / delay 口径）──
  // 车上的"后续到站/发车时刻"最多隔这么多**游戏秒**重算一次（外加"办完一站 / 换了一趟"立刻重算）。
  // 预测是绝对时刻，隔几秒重算一次不会让它变旧，所以这个数字只影响 CPU，不影响数字本身。
  remainingStopsRefreshSeconds: 5,
  // 到站判定余量（游戏秒）：sim 在站台前按爬行速度（DOCK_CRAWL）对位后就直接判定到站，
  // 不像纯运动学那样真的一路刹停到站台，所以它比 _segmentRunSec / _travelSecFrom 算出来的
  // 时间早约 0.4~0.5 游戏秒（1 游戏秒步长实测）。逐站预测减掉这一项才对得上实际到站时刻。
  dockAllowanceSeconds: 0.45,
  // 自由发车线"自编时刻表"（没有班次表时拿它自己的预测当计划）的运行余裕：
  // 真实时刻表一般也留 5%~10% 的区间余裕，晚点之后就是靠这点余裕一站站追回来的。
  delayPlanSlackRatio: 0.1,
  // 相邻两站偏差变化超过这么多游戏秒，才算"在变差 / 在追回"（delayTrend 用它）
  delayTrendSeconds: 3,
  // 偏差在 ±这么多游戏秒以内算准点（NR 里"准点"也是分钟级的）；也是 recovered 的判定阈值
  onTimeSeconds: 60,
  // 每辆车保留多少条逐站偏差记录（内存），对外只给最近 delayHistoryPublic 条
  delayHistoryLimit: 64,
  delayHistoryPublic: 8,
  // 起点站发车前的最短整备时间之外的额外余裕（游戏秒）：用来判定"起点站发车晚不晚"
  delayDepartureGraceSeconds: 5,
  // ── #规模（LOD / 预算 / 广播）── 几万辆车同时在跑时，这三组数字决定一切 ──
  // 模拟的一小步游戏时长（毫秒）与"看得见 / 看不见"两档的细分度：
  //   粗档：视口外的车，每 coarseStepMs 游戏毫秒算一次（默认 3000 = 与 #19 的到站判定余量同档）
  //   细档：视口内（以及正在办客 / 被前车顶住）的车，每 fineStepMs 游戏毫秒算一次
  // 两档走的是**同一套**运动学积分与到站判定，只是采样频率不同 —— 所以到站时刻、
  // 逐站预测（remainingStops）、晚点（delaySeconds）的口径完全一样，精度差在"位置"上
  // （见 _simStep 顶部的误差分析：3 游戏秒一采样，位置误差 ~5 米，且下一站一到就归零）。
  simCoarseStepMs: 3000,
  simFineStepMs: 1000,
  // 一次 tick 的模拟时间预算（真实毫秒）：超了就带着 _timeAcc 的余量收工，剩下的下一 tick 接着算。
  // 250 ms 一跳、预算 5 ms 时，×300 倍速下 10 万辆车也只是"每 tick 少算一点"，
  // 而不是"把事件循环锁住几百毫秒"（旧实现没有预算，全部同步算完）。
  simBudgetMs: 5,
  // 视口半径（米）：视口内的车走细档、且永远进这一帧的广播
  viewportRadiusM: 2500,
  // 每个客户端每一帧最多收多少辆车的实时数据（超出的部分按线路聚合计数下发）
  vehicleFrameLimit: 600,
  // 每帧给每个客户端的"聚合计数"（视口外的车按线路给条数）是否带上
  frameIncludeLineCounts: true,
  // 位置落盘间隔（真实毫秒）：批量事务，一次一条复用的 prepared statement
  persistIntervalMs: 3000,
  // 启动时车队装载（一次 SELECT）与线路车数索引的最大同步耗时预算（毫秒）：
  // 超过就不在启动路径里做，留给下一次 tick 的 header 收尾（见 _ensureFleetReady）
  startupFleetBudgetMs: 4000,
};

/**
 * 「在车厂（未运营）」的原因表 —— serviceStateOf 返回什么，客户端就显示哪一句。
 *
 * 用户口径（#车厂）：**不在运营的公交车不要停在地图上**。所以帧里的 trains[] 只发在运营的车，
 * 其余的车留在 vehicles[] 里，用 inService:false + depotReason/depotNote 说明"它现在在车厂、为什么"。
 * 只有 'run' 是在运营；这里给其余每一种状态一句中文原因（客户端车辆列表 / 车辆详情 / 气泡直接显示）。
 */
const DEPOT_REASON_NOTE = {
  idle: '在车厂（未运营）· 没指派线路（闲置）',
  paused: '在车厂（未运营）· 线路已暂停运营，车辆已回车厂',
  'before-departure': '在车厂（未运营）· 还没到发车时刻，在始发站等点',
  'service-ended': '在车厂（未运营）· 今天的班次已经跑完，回场过夜',
  'no-departure': '在车厂（未运营）· 这条线没有分给本车的班次',
  'no-path': '在车厂（未运营）· 线路还没有可跑的路径',
  'not-online': '在车厂（未运营）· 还没被模拟步进过（下一次 tick 才上线）',
};

/**
 * 底图导入的车站的"挂靠账号"：它**不代表任何归属**，也不是什么"系统公司 / 公共车站"。
 * 存在的唯一理由是 stations 表要一个 owner / company_id 才能落库（导入进来的车站不花任何人的钱），
 * 而 ensureCompany() 是按 user.id 找公司的 —— 所以导入走这个固定的名字，不占用任何玩家的公司。
 * 车站本身没有归属：谁都能把导入站改名 / 删除 / 挪位置（见 updateStation / deleteStation），
 * 挂在这条名字下的公司也没有任何特权（deleteCompany 不挡它）。imported / osm_type / osm_id
 * 只是"这个站是从底图哪个元素来的"这条信息，方便界面标一句来源，不参与权限判断。
 */
const SYSTEM_OWNER = '__system__';

/**
 * 各车型的起步加速度与制动减速度（m/s²）。
 *   accel：起步加速 —— 公交 0.9、有轨电车 1.0、地铁 1.1、城际/高铁 0.5、货运 0.3（重车起步最慢）
 *   brake：进站制动 —— 公交/地铁 ~1.1（乘客能站稳的常用制动），动车组 0.6，货运最软 0.3
 * 旧的模拟里所有车都用同一个加速度、而且一小步就到点，起步像弹射；现在按车型分开，
 * 并且用精确运动学积分（见 _integrate），所以"公交车 0→40 km/h 大约 12 秒"是算得出来的：
 *   11.11 m/s ÷ 0.9 m/s² ≈ 12.3 秒。
 */
const VEHICLE_DYNAMICS = {
  bus: { accel: 0.9, brake: 1.1 },
  bus_double: { accel: 0.85, brake: 1.0 },
  bus_artic: { accel: 0.8, brake: 1.0 },
  trolley: { accel: 0.9, brake: 1.1 },
  minibus: { accel: 1.0, brake: 1.2 },
  tram: { accel: 1.0, brake: 1.2 },
  metro_b4: { accel: 1.1, brake: 1.1 },
  metro_b6: { accel: 1.1, brake: 1.1 },
  metro_a8: { accel: 1.1, brake: 1.1 },
  crh6: { accel: 0.5, brake: 0.6 },
  cr400: { accel: 0.5, brake: 0.6 },
  locomotive: { accel: 0.35, brake: 0.5 },
  freight: { accel: 0.3, brake: 0.3 },
};

/** 某个车型的加速度/减速度（认不出来就用 config 里的默认值兜底） */
function dynamicsForKind(kind, config) {
  const d = VEHICLE_DYNAMICS[kind];
  const accel = d ? d.accel : (Number(config && config.accel) || DEFAULTS.accel);
  const brake = d ? d.brake : (Number(config && config.brake) || DEFAULTS.brake);
  return { accel: Math.max(0.05, accel), brake: Math.max(0.05, brake) };
}

/** 到站判定容差（米）：车与站台的距离在这个范围内就算"到站" */
const ARRIVE_EPS = 0.75;
/** 进站最后一段的"爬行速度"（m/s ≈ 3.6 km/h）：对准站台用，不会一头撞上去 */
const DOCK_CRAWL = 1;
/** 站台前留出的对准距离（米）：距离站台这么近时按爬行速度走，误差由到站判定吃掉 */
const DOCK_MARGIN = 2;

/** 站点类型：高铁站/城际站城市级就显示，其余要放大才显示 */
const STATION_KINDS = {
  hsr: { name: '高铁站', minZoom: 9, hasPlatform: true },
  intercity: { name: '城际站', minZoom: 11, hasPlatform: true },
  rail: { name: '普速车站', minZoom: 13, hasPlatform: true },
  subway: { name: '地铁站', minZoom: 14, hasPlatform: true },
  light_rail: { name: '轻轨站', minZoom: 14, hasPlatform: true },
  tram: { name: '有轨电车站', minZoom: 15, hasPlatform: true },
  // 公交站就是路边一个站牌，没有站台长度（服务端一律按 0 存，客户端据此把那一栏藏起来）
  bus: { name: '公交站', minZoom: 15, hasPlatform: false },
};

/** 车辆类型模板：以中国大陆常见车型为准；长度决定地图上的示意大小与前后车净距 */
const VEHICLE_KINDS = {
  bus: { name: '比亚迪 K8 公交', lengthM: 12, cars: 1, capacityPerCar: 80, maxSpeed: 70, minZoom: 15, color: '#2b8cbe' },
  bus_double: { name: '双层巴士', lengthM: 12.5, cars: 1, capacityPerCar: 100, maxSpeed: 60, minZoom: 15, color: '#1d3557' },
  bus_artic: { name: '宇通 18 米铰接公交', lengthM: 18, cars: 1, capacityPerCar: 140, maxSpeed: 60, minZoom: 15, color: '#457b9d' },
  trolley: { name: '无轨电车', lengthM: 12, cars: 1, capacityPerCar: 85, maxSpeed: 50, minZoom: 15, color: '#588157' },
  minibus: { name: '社区巴士', lengthM: 8, cars: 1, capacityPerCar: 30, maxSpeed: 60, minZoom: 15, color: '#43aa8b' },
  tram: { name: '中车有轨电车', lengthM: 32, cars: 4, capacityPerCar: 60, maxSpeed: 50, minZoom: 13, color: '#f9c74f' },
  metro_b4: { name: '地铁 B 型 4 节', lengthM: 76, cars: 4, capacityPerCar: 230, maxSpeed: 80, minZoom: 12, color: '#f3722c' },
  metro_b6: { name: '地铁 B 型 6 节', lengthM: 114, cars: 6, capacityPerCar: 230, maxSpeed: 80, minZoom: 12, color: '#ef476f' },
  metro_a8: { name: '地铁 A 型 8 节', lengthM: 176, cars: 8, capacityPerCar: 250, maxSpeed: 100, minZoom: 12, color: '#e63946' },
  crh6: { name: 'CRH6 城际动车组', lengthM: 200, cars: 8, capacityPerCar: 180, maxSpeed: 160, minZoom: 8, color: '#118ab2' },
  cr400: { name: '复兴号 CR400AF', lengthM: 209, cars: 8, capacityPerCar: 72, maxSpeed: 350, minZoom: 7, color: '#023e8a' },
  locomotive: { name: '和谐电 1 型机车', lengthM: 20, cars: 1, capacityPerCar: 1, maxSpeed: 120, minZoom: 14, color: '#6c757d' },
  freight: { name: '货运列车 30 节', lengthM: 400, cars: 30, capacityPerCar: 1, maxSpeed: 80, minZoom: 10, color: '#495057' },
};

/** 新建公司时送的"起步车队" */
const STARTER_FLEET = [
  { kind: 'bus', name: '公交 1 路' },
  { kind: 'bus', name: '公交 2 路' },
  { kind: 'metro_b4', name: '地铁 4 节编组' },
];

const RAIL_KINDS = new Set(['rail', 'subway', 'tram', 'light_rail', 'intercity', 'hsr']);

/** 只查不改的操作：不进撤销栈、也不会打断 groupLabel 自动分组（客户端轮询它们不该把一组操作切断） */
const READ_ONLY_OPS = new Set(['station.waiting', 'line.stats', 'kinds', 'road.congestion', 'road.congestion.way', 'od.stats', 'pax.stats', 'lock.set']);

/**
 * 交通资产的**元素锁**超时（毫秒）。与 osmops.js 的 LOCK_TTL_MS 同一个口径（120 秒）：
 * 借用 OSM 那张锁表时用不到这个常量，只有"没有 OSM 模块、自己管锁"的场合才用它。
 */
const LOCK_TTL_MS = 120000;

/**
 * 元素锁能保护、也允许协作改动的交通资产类型。
 * 公司（company）也算一类：它名下挂着车站/线路/车辆与资金，改它同样是改共享资产。
 */
const LOCKABLE_ELEMENTS = new Set(['station', 'line', 'vehicle', 'company']);

/** 线路/站点可用的全部类型（由站点类型表推导，含公交） */
const LINE_KINDS = new Set(Object.keys(STATION_KINDS));

/** 这个类型的站点有没有"站台长度"（只有铁路类站点有；公交站是路边站牌，按 0 存） */
function kindHasPlatform(kind) {
  return RAIL_KINDS.has(kind);
}

/**
 * 哪些**车辆类型**算"公交"（#3：公交不互相阻挡、晚点记成拥堵）。
 * 就是 VEHICLE_KINDS 里那五个跑在道路上的车型：公交/双层/铰接/无轨电车/社区巴士。
 * 有轨电车（tram）**不算**：它跑在轨道上，跟地铁一样保留净距。
 * 口径只有这一处（_enforceSpacing / _dock 排队位 / _recordStopObs 的成因都用它）。
 */
const BUS_VEHICLE_KINDS = new Set(['bus', 'bus_double', 'bus_artic', 'trolley', 'minibus']);
function isBusVehicle(veh) {
  return !!(veh && BUS_VEHICLE_KINDS.has(veh.kind));
}

/**
 * 线路缓存里的路径数组（几何点 + 累计里程 + 限速）。
 * 单独抽成函数是因为它出现在热路径的每一行（`path0(cache)` 比 `cache.path` 多一层，
 * 但省掉了"每次都在循环体里解构/取属性"的写法差异），也方便将来把路径换成 TypedArray。
 */
function path0(cache) {
  return cache.path;
}

/**
 * 底图（OSM）里"像车站"的标签 → 游戏站点类型。
 * 顺序 = 重要性：越靠前的越先导入（limit 用完就先保住火车站/汽车站）。
 *   match(tags) 判定；kind(tags) 给出站点类型（默认 rail）；prefilter 是给 SQL 用的 LIKE 条件
 */
const IMPORT_RULES = [
  { key: 'railway=station', mode: 'rail', tags: { railway: 'station' } },
  { key: 'railway=halt', mode: 'rail', tags: { railway: 'halt' } },
  { key: 'amenity=bus_station', mode: 'bus', tags: { amenity: 'bus_station' } },
  { key: 'public_transport=station', mode: 'rail', tags: { public_transport: 'station' } },
  { key: 'railway=tram_stop', mode: 'rail', tags: { railway: 'tram_stop' } },
  { key: 'railway=subway_entrance', mode: 'rail', tags: { railway: 'subway_entrance' } },
  { key: 'highway=bus_stop', mode: 'bus', tags: { highway: 'bus_stop' } },
  { key: 'public_transport=platform', mode: 'rail', tags: { public_transport: 'platform' } },
  { key: 'public_transport=stop_position', mode: 'rail', tags: { public_transport: 'stop_position' } },
];

/** SQL 预筛：这些标签组合里可能藏着车站（真正的判定交给 _importKindOf） */
const IMPORT_SQL_FILTER = `(
  tags LIKE '%"railway":"station"%' OR tags LIKE '%"railway":"halt"%'
  OR tags LIKE '%"railway":"tram_stop"%' OR tags LIKE '%"railway":"subway_entrance"%'
  OR tags LIKE '%"public_transport":"station"%' OR tags LIKE '%"public_transport":"platform"%'
  OR tags LIKE '%"public_transport":"stop_position"%'
  OR tags LIKE '%"highway":"bus_stop"%' OR tags LIKE '%"amenity":"bus_station"%'
)`;

/** 站名：优先中文名，其次 name，最后按类型编号 */
function stationNameFromTags(tags, kind, id) {
  const raw = tags['name:zh'] || tags['name:zh-Hans'] || tags.name || tags['name:en'] || '';
  const clean = String(raw).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32);
  if (clean) return clean;
  return `${STATION_KINDS[kind] ? STATION_KINDS[kind].name : '车站'} #${id}`;
}

/**
 * 标签 → 游戏站点类型。
 *   train/railway=station  → rail（subway=yes / station=subway → 地铁，highspeed=yes → 高铁）
 *   bus / trolleybus       → bus（公交站）
 *   tram / light_rail      → tram / light_rail
 */
function stationKindFromTags(tags) {
  if (!tags) return null;
  const rw = tags.railway;
  const pt = tags.public_transport;
  if (rw === 'station' || rw === 'halt' || pt === 'station') {
    if (tags.subway === 'yes' || tags.station === 'subway' || tags['subway:entrance'] === 'yes') return 'subway';
    if (tags.highspeed === 'yes' || tags.highspeed === 'true') return 'hsr';
    if (tags.tram === 'yes' || tags.station === 'tram') return 'tram';
    if (tags.light_rail === 'yes' || tags.station === 'light_rail') return 'light_rail';
    if (tags.bus === 'yes' || tags.bus === 'true') return tags.train === 'yes' ? 'rail' : 'bus';
    return rw === 'halt' ? 'rail' : 'rail';
  }
  if (rw === 'tram_stop') return 'tram';
  if (rw === 'subway_entrance') return 'subway';
  if (tags.amenity === 'bus_station' || tags.highway === 'bus_stop') return 'bus';
  if (pt === 'platform' || pt === 'stop_position') {
    if (tags.tram === 'yes') return 'tram';
    if (tags.subway === 'yes') return 'subway';
    if (tags.light_rail === 'yes') return 'light_rail';
    if (tags.train === 'yes' || tags.railway === 'platform') return 'rail';
    if (tags.bus === 'yes' || tags.trolleybus === 'yes' || tags.highway === 'bus_stop') return 'bus';
    return tags.railway === 'platform' ? 'rail' : 'bus';
  }
  if (tags.railway === 'platform') return 'rail';
  return null;
}


/**
 * 可选的时间倍速（0 = 暂停）。**单位：实时时间的倍数**——
 *   ×1   = 现实 1 秒 = 游戏 1 秒（1:1，默认档）
 *   ×60  = 现实 1 秒 = 游戏 60 秒 = 1 游戏分钟（= 旧版本的 ×1）
 *   ×300 = 现实 1 秒 = 游戏 5 分钟（= 旧版本的 ×5）
 * 倍速只影响"游戏时间走多快"；模拟内部一律按游戏秒积分（见 tick / _step），
 * 所以停站时间、等车耐心、运营时段这些"游戏秒口径"的参数在任何倍速下含义都一样。
 */
const SPEEDS = [0, 1, 2, 5, 10, 20, 60, 120, 300];

/** 时间基准的中文口径（也会由 publicTransitConfig() 下发给前端） */
const CLOCK_BASE = '1 real second = 1 game second at ×1';

/* ------------------------------ #18 班次（发车时刻表） ------------------------------ */
/**
 * 线路的班次有三种（**调度口径**，实现见 _scheduleStep / _runTable / _lineRuns）：
 *   free      自由发车（默认，也就是"没有班次表"）：车在线路上一直跑，只受最小净距约束。
 *             老库 / 老客户端不传 schedule 就是这个模式，行为与以前完全一致。
 *   headway   流水班：间隔 headwaySec 秒一班，首班 firstSec、末班 lastSec（都是当天 0 点起的秒数）。
 *             发车时刻由此**推导**出来（firstSec 起每 headwaySec 一班，到 lastSec 为止）。
 *   timetable 定班车：直接给一串发车时刻（当天 0 点起的秒数）。
 *
 * 有班次表（headway / timetable）时是**真调度**，不是"提一句就算了"：
 *   · 车只在发车时刻发车：没到点就停在**首站**等点（等点期间照常上下客）；
 *   · 车辆铺开到班次上：第 j 班派给第 (j % 车数) 辆（_departureVehicleId），
 *     所以流水班时线上相邻两班的间隔就是 headwaySec；
 *   · 跑完一趟（回到首站 / 环线绕回起点）才排下一班，车赶不上的班次就跳过（晚点体现在
 *     scheduleLag 上）；
 *   · 模拟按"这一趟的逐站时刻表"预测每一站的到站/发车时刻（_runTable：站间纯运行时间
 *     由车型加减速 + 路段限速算出，再按 dwellSeconds / terminalDwellSeconds 加停站时间），
 *     对外通过 linePublic().runs / stopsEta 与车辆上的 nextStop / etaSeconds /
 *     scheduledDeparture / scheduleLag 暴露；
 *   · 线上没车、车不够、或者不在运营时段 → 什么都不会发（**这是正常状态，不是 bug**），
 *     用 linePublic().noServiceNow + service.reason 如实报出来。
 *
 * **每个班次指定车辆（#4 的 assignments）**：班次表里可以多带一张"指定表"，把某一班钉死在某辆车上：
 *     schedule = { mode:'headway', headwaySec, firstSec, lastSec,
 *                  assignments: [{ runIndex, vehicleId }, ...] }
 *   · runIndex 就是**当天班次表里的下标**（与 linePublic().runs[].index 完全同一个数，
 *     0 = 当天第一班），客户端照着它填就行；
 *   · 也接受紧凑写法 [runIndex, vehicleId]（两种可以混用），解析后统一成对象数组并按 runIndex 排序；
 *   · 派车时**优先满足指定车**：这一班到点时把车交给它（_runPlan / _departureVehicleId），
 *     于是"早班用小车、晚高峰用大车"这种排班能落地；
 *   · 指定车**不空闲就算没满足**（被删了、被改派到别的线路 = 在别处忙、或者已经不在这条线上）：
 *     那一班退回**默认轮转**（第 j 班第 (j % 车数) 辆），并且把没满足的班次记进
 *     linePublic().schedule.assignmentsMissed / runs[].assignmentMissed —— 不报错、不空等、
 *     也不会让这一班消失；
 *   · free 模式没有班次可言，assignments 会被丢掉（解析结果里不保留）。
 *
 * **一键暂停运营（#3，op：line.setService）**：暂停只挡**新的发车**，不打断已经在跑的那一趟
 * （见 _pauseHold / _endRun / _resumeLine）：
 *   · 暂停：还没发车的车就地收车停在首站（不删车、不藏车、不瞬移），收车之后就不再上下客；
 *     已经在路上的车把这一趟跑完（含从末站回场到首站，沿途照常停站上下客 —— 它还在跑这一趟）
 *     再收车；站台上等车的人一个不动，继续按耐心规则等（_patienceStep），一个都不会被丢掉；
 *   · 恢复：按班次表**重新排"现在这一刻之后的下一班"**（相当于时钟刚刚走到下一班的发车时刻），
 *     自由发车线直接从首站重新开跑；
 *   · 对外靠 linePublic().service.paused（暂停时 noServiceNow 也为 true、reason='paused'）说明状态。
 */
const SCHEDULE_MODES = new Set(['free', 'headway', 'timetable']);
/** 一天 86400 秒；发车时刻表按"当天的第几秒"记 */
const DAY_SEC = 86400;
/** 一条线路最多生成多少班次（间隔太小 + 运营时间太长时的保护） */
const MAX_DEPARTURES = 1440;
/** 一条线路最多能填多少个"班次指定车辆"（保护解析与查表） */
const MAX_ASSIGNMENTS = 512;

/** 秒 → "HH:MM"（发车时刻表展示用） */
function secToHHMM(sec) {
  const s = ((Math.round(Number(sec) || 0) % DAY_SEC) + DAY_SEC) % DAY_SEC;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/** "HH:MM" / "HH:MM:SS" / 数字（秒）→ 当天的秒数；认不出来返回 null */
function parseSecOfDay(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(DAY_SEC, Math.round(v)));
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    const s = Number(m[3] || 0);
    if (h > 24 || mi > 59 || s > 59) return null;
    return Math.min(DAY_SEC, h * 3600 + mi * 60 + s);
  }
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.max(0, Math.min(DAY_SEC, Math.round(n))) : null;
}

/**
 * 解析 / 校验班次（#18）。入参可以是对象、也可以是 JSON 字符串或 null。
 * 非法输入抛 TransitError（中文原因），合法输入返回规范化后的对象：
 *   { mode:'free' }
 *   { mode:'headway', headwaySec, firstSec, lastSec[, assignments:[{runIndex,vehicleId},…]] }
 *   { mode:'timetable', times:[...][, assignments:[{runIndex,vehicleId},…]] }
 * assignments（#4）：把某一班钉死在某辆车上，runIndex = 当天班次表里的下标（= linePublic().runs[].index）。
 * 两种写法都认：{runIndex, vehicleId} 或紧凑的 [runIndex, vehicleId]；同一个班次写多次时**后面那条算**。
 * free 模式没有班次，assignments 直接丢掉（解析结果里不保留）。
 */
function parseSchedule(raw) {
  if (raw == null || raw === '' || raw === 'null') return { mode: 'free' };
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { throw new TransitError('班次格式不正确：需要 JSON 对象', 'BAD_SCHEDULE'); }
  }
  if (obj == null) return { mode: 'free' };
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new TransitError('班次格式不正确：需要对象', 'BAD_SCHEDULE');
  const mode = obj.mode === undefined ? (obj.timetable ? 'timetable' : (obj.headwaySec ? 'headway' : 'free')) : String(obj.mode);
  if (!SCHEDULE_MODES.has(mode)) throw new TransitError(`班次模式只能是 free / headway / timetable（收到 ${mode}）`, 'BAD_SCHEDULE');
  if (mode === 'free') return { mode: 'free' };
  const assignments = parseAssignments(obj.assignments);
  if (mode === 'headway') {
    const headwaySec = Math.round(Number(obj.headwaySec != null ? obj.headwaySec : obj.headway));
    if (!Number.isFinite(headwaySec) || headwaySec < 30 || headwaySec > DAY_SEC) {
      throw new TransitError('流水班的间隔（秒）要在 30 ~ 86400 之间', 'BAD_SCHEDULE');
    }
    const firstSec = parseSecOfDay(obj.firstSec != null ? obj.firstSec : obj.first);
    const lastSec = parseSecOfDay(obj.lastSec != null ? obj.lastSec : obj.last);
    const f = firstSec == null ? 6 * 3600 : firstSec;
    const l = lastSec == null ? Math.min(DAY_SEC - 1, f + 18 * 3600) : lastSec;
    if (l < f) throw new TransitError('末班时间不能早于首班时间', 'BAD_SCHEDULE');
    const out = { mode: 'headway', headwaySec, firstSec: f, lastSec: l };
    if (assignments.length) out.assignments = assignments;
    return out;
  }
  const src = Array.isArray(obj.times) ? obj.times : [];
  const times = [];
  for (const t of src) {
    const s = parseSecOfDay(t);
    if (s == null) throw new TransitError('定班车的发车时刻要写成 "HH:MM" 或当天的秒数', 'BAD_SCHEDULE');
    times.push(s);
  }
  if (!times.length) throw new TransitError('定班车至少要给一个发车时刻', 'BAD_SCHEDULE');
  if (times.length > 512) throw new TransitError('定班车时刻最多 512 个', 'BAD_SCHEDULE');
  times.sort((a, b) => a - b);
  const uniq = [];
  for (const t of times) if (!uniq.length || uniq[uniq.length - 1] !== t) uniq.push(t);
  const out = { mode: 'timetable', times: uniq };
  if (assignments.length) out.assignments = assignments;
  return out;
}

/**
 * 解析"每个班次指定车辆"（#4）。接受：
 *   [{ runIndex: 3, vehicleId: 12 }, …]   对象写法（推荐，字段名自解释）
 *   [[3, 12], …]                          紧凑写法（[班次下标, 车辆 id]）
 * 混合也行。返回按 runIndex 升序、同一下标只留最后一条的数组（空数组 = 没有指定）。
 * runIndex 必须是 0 … MAX_DEPARTURES-1 的整数（就是当天班次表里的下标），vehicleId 必须是正整数。
 */
function parseAssignments(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new TransitError('班次里的"指定车辆"要写成数组：[{runIndex, vehicleId}, …]', 'BAD_SCHEDULE');
  }
  if (raw.length > MAX_ASSIGNMENTS) {
    throw new TransitError(`"指定车辆"最多 ${MAX_ASSIGNMENTS} 条（收到 ${raw.length} 条）`, 'BAD_SCHEDULE');
  }
  const norm = [];
  for (const item of raw) {
    let runIndex;
    let vehicleId;
    if (Array.isArray(item)) {
      [runIndex, vehicleId] = item;
    } else if (item && typeof item === 'object') {
      runIndex = item.runIndex != null ? item.runIndex : (item.index != null ? item.index : item.run);
      vehicleId = item.vehicleId != null ? item.vehicleId : (item.vehicle != null ? item.vehicle : item.id);
    } else {
      throw new TransitError('班次里的"指定车辆"要写成 {runIndex, vehicleId}（也接受 [班次下标, 车辆 id] 的紧凑写法）', 'BAD_SCHEDULE');
    }
    const ri = Number(runIndex);
    const vi = Number(vehicleId);
    if (!Number.isInteger(ri) || ri < 0 || ri >= MAX_DEPARTURES) {
      throw new TransitError(`指定车辆的班次下标（runIndex）要是 0 ~ ${MAX_DEPARTURES - 1} 的整数（收到 ${runIndex}）`, 'BAD_SCHEDULE');
    }
    if (!Number.isInteger(vi) || vi <= 0) {
      throw new TransitError(`指定车辆的 vehicleId 要是正整数（收到 ${vehicleId}）`, 'BAD_SCHEDULE');
    }
    norm.push({ runIndex: ri, vehicleId: vi });
  }
  norm.sort((a, b) => a.runIndex - b.runIndex);
  const out = [];
  for (const a of norm) {
    const last = out[out.length - 1];
    if (last && last.runIndex === a.runIndex) out[out.length - 1] = a;   // 同一班写多次：后面那条算
    else out.push(a);
  }
  return out;
}

/** 站点/线路类型 → 用哪张路网 */
function graphFor(kind) {
  return kind === 'bus' ? 'bus' : 'rail';
}

/**
 * 把一组"小数人数"取整成**整数**，而且**合计仍然对得上**（最大余数法）。
 *
 * 为什么要单独一个函数：乘客是按游戏秒累积的（一个慢线一小时才攒出 3 个人，所以内部必须留小数，
 * 见 _addWaiting / _addPaxDest），但对玩家展示的人数**一个都不能是小数** ——
 * 用户原话："人数出现小数（几点几人）……这太荒唐了"。所以：
 *   · **内部账一个小数都不动**：cohort.people / bucket.waiting / rt.paxGroups 照旧是小数，
 *     慢线照样靠零头攒够整人再上车；
 *   · **只在对外展示的最后一步取整**（stationWaiting / paxOnBoard / companyPublic …），
 *     并且用最大余数法让"各行之和 = 合计的取整值"，界面里绝不会出现
 *     "等车 7 人，但下面写着 3 人 + 3 人 + 2 人 = 8 人"这种自相矛盾的账。
 *
 * 输入 pairs: [[键, 小数人数], ...]（键可以是任意可比较值，通常是线路 id / 车站 id）。
 * 返回 Map(键 -> 整数)：小数部分大的先 +1（小数部分相同按输入顺序，结果稳定可预测）；
 * 人数 <= 0 的项给 0（客户端会整条跳过，与服务端"0 人的分组不画"口径一致）。
 */
function wholePeople(pairs) {
  const rows = [];
  let total = 0;
  for (const [key, value] of pairs) {
    const n = Number(value) > 0 ? Number(value) : 0;
    rows.push({ key, n, floor: Math.floor(n), rest: n - Math.floor(n) });
    total += n;
  }
  const out = new Map();
  let need = Math.round(total);
  for (const r of rows) need -= r.floor;
  if (need > 0) {
    const order = rows.map((r, i) => i).sort((a, b) => (rows[b].rest - rows[a].rest) || (a - b));
    for (const i of order) {
      if (need <= 0) break;
      rows[i].floor += 1;
      need -= 1;
    }
  }
  for (const r of rows) out.set(r.key, r.floor);
  return out;
}

/**
 * 行程搜索用的小顶堆（零依赖）。push(key, cost) / pop() -> {key, cost} / size。
 * 只装（标签键, 估算秒数）两种值，够 Dijkstra 用；比"排序数组 + shift"快得多。
 */
class MinHeap {
  constructor() {
    this.keys = [];
    this.costs = [];
  }

  get size() { return this.keys.length; }

  push(key, cost) {
    const k = this.keys;
    const c = this.costs;
    k.push(key);
    c.push(cost);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] <= c[i]) break;
      const tk = k[p]; k[p] = k[i]; k[i] = tk;
      const tc = c[p]; c[p] = c[i]; c[i] = tc;
      i = p;
    }
  }

  pop() {
    const k = this.keys;
    const c = this.costs;
    const n = k.length;
    if (!n) return null;
    const out = { key: k[0], cost: c[0] };
    const lastK = k.pop();
    const lastC = c.pop();
    if (n > 1) {
      k[0] = lastK;
      c[0] = lastC;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && c[l] < c[m]) m = l;
        if (r < k.length && c[r] < c[m]) m = r;
        if (m === i) break;
        const tk = k[m]; k[m] = k[i]; k[i] = tk;
        const tc = c[m]; c[m] = c[i]; c[i] = tc;
        i = m;
      }
    }
    return out;
  }
}

class TransitError extends Error {
  constructor(message, code = 'TRANSIT') {
    super(message);
    this.code = code;
  }
}

class Transit {
  constructor(db, deps = {}) {
    this.db = db;
    this.rail = deps.rail;
    this.bus = deps.bus || null;          // 道路网（巴士模式用），惰性构建
    this.ensureBusGraph = deps.ensureBusGraph || null;
    this.population = deps.population;
    this.config = Object.assign({}, DEFAULTS, deps.config || {});
    /**
     * #广播按需：把 onChanged 包一层 —— 任何"车队/线路构成变了"的通知都顺手把
     * 版本号加一（见 motionSerial）。不这么做的话，那些"没上报视口、照旧收整支车队"
     * 的客户端会在"有人新建了一辆车"之后一直收 clock-only 帧，名单永远是旧的。
     */
    const onChangedRaw = deps.onChanged || (() => {});
    this.onChanged = (kind, id) => {
      this._motionSerial = (this._motionSerial || 0) + 1;
      return onChangedRaw(kind, id);
    };
    this.runtime = new Map();          // vehicleId -> 运行时状态
    this.lineCache = new Map();        // lineId -> {path:[{id,lat,lon,distance}], stops:[...], lengthM, vehicleIds:[]}
    this._stationDemand = new Map();   // stationId -> {key, value}：车站需求（覆盖人口）缓存，见 stationDemandOf
    this._od = null;                   // O/D 需求表（NIMBY Rails 的 demand tile），见 _ensureOdDemand
    this._odKeyValue = null;           // 上面那张表的缓存键（人口网格版本 + 游戏日 + 出行率）
    // 行程搜索（NIMBY Rails 的 pax pathfinding）：线路-站点图 + 站间步行接驳边，见 _ensureItineraryGraph
    this._itinGraph = null;
    this._itinSearches = new Map();    // originId -> 搜索结果（带 LRU 上限，见 _searchItineraries）
    this._itinSearchStates = 0;        // 搜索结果里标签的总数（LRU 的内存水位）
    // 换乘 / 步行接驳参数（一次算好，热路径不再解析 config）
    this._tp = this._transferParams();
    // 等车队伍：stationId -> Map(公司键 -> entry)，entry 里再按**线路**分桶（见 _lineBucket）。
    // 等车队伍属于车站而不是某辆车，所以车被删/被改派，排队的人还在。
    this.stationQueues = new Map();
    // 正在步行接驳（OSI）的乘客：stationId -> [{people, destId, plan, idx, readyAtMs}]。
    // NR 里他们在"目的车站的站厅里带一个计时器"（wiki: Station），走完才去排下一段车。
    this.walkers = new Map();
    // 车站的乘客账本（当日）：arrived 到达目的站 / departed 从这里上车或出发步行 /
    // transferred 在这里换乘（含换乘步行）/ walked 从这里开始步行 / walkedM 步行米数累计
    this.stationStats = new Map();
    this.lineStatsAcc = new Map();     // lineId -> {day, riders, transfers, vehicleKm, loadSum, loadN, waitSum, waitN}：当日未落盘的线路客流
    this.undoStacks = new Map();       // userId -> [{label, steps}]
    this.redoStacks = new Map();
    // 交通资产的元素锁（见 checkElementLock）：只在拿不到 OSM 模块时才会真正用到这张表
    // （index.js 里 Transit 与 OsmOps 共用一条 UndoBus，锁就借 OSM 那一张，全服可见 + 断线自动释放）
    this._locks = new Map();           // "station:12" -> { userId, name, ts }
    // 分组撤销：默认自带一条总线（单元测试里直接 new Transit(db) 也能用分组）；
    // index.js 传进来的那条是与 OsmOps 共用的，于是分组可以横跨"OSM 编辑 + 交通玩法"。
    // 注意选项名是 undoBus：deps.bus 是本文件里的"道路网"（公交用），别搞混。
    // 一定要 attach：分组收尾/跨栈撤销时，总线要靠它找到本模块去摘撤销项、代跑步骤。
    this.undoSrc = deps.src || 'transit';
    this.undoBus = deps.undoBus || new UndoBus();
    this.undoBus.attach(this.undoSrc, this);
    this._groupSuspend = 0;   // >0 时不往分组里登记（预留给内部复用）
    this._bulk = 0;           // >0 时线路路径攒到最后重建一次（一次撤销一整组时有几十步）
    this.clockMs = 0;
    this.speed = 1;
    this.day = 1;
    this._loadSimState();
    this._ensureStationColumns();
    this._ensureLineColumns();     // 必须在准备语句之前：updateLine 里带了 schedule 列
    this._st = {
      company: db.prepare('SELECT * FROM companies WHERE id = ?'),
      systemCompany: db.prepare('SELECT * FROM companies WHERE owner = ? ORDER BY id LIMIT 1'),
      updateCompany: db.prepare('UPDATE companies SET name = ?, color = ?, cash = ?, riders = ?, revenue = ?, spent = ?, updated_at = ? WHERE id = ?'),
      allCompanies: db.prepare('SELECT * FROM companies'),
      insertStation: db.prepare(`INSERT INTO stations(owner, company_id, name, kind, lat, lon, node_id, way_id, platform_m, catchment_m, show_catchment, cost, created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      station: db.prepare('SELECT * FROM stations WHERE id = ?'),
      allStations: db.prepare('SELECT * FROM stations'),
      stationsInBbox: db.prepare('SELECT * FROM stations WHERE lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?'),
      updateStation: db.prepare('UPDATE stations SET name = ?, kind = ?, platform_m = ?, catchment_m = ?, show_catchment = ?, node_id = ?, way_id = ?, lat = ?, lon = ? WHERE id = ?'),
      delStation: db.prepare('DELETE FROM stations WHERE id = ?'),
      insertLine: db.prepare(`INSERT INTO lines(owner, company_id, name, color, kind, stops, loop, created_at) VALUES(?,?,?,?,?,?,?,?)`),
      line: db.prepare('SELECT * FROM lines WHERE id = ?'),
      allLines: db.prepare('SELECT * FROM lines'),
      /**
       * **缓存指纹专用的窄语句**（见 _cacheStamp）：只取"决定 O/D 表与行程图长什么样"的那几列，
       * 不是 SELECT *（几百个站每 tick 一次，列越少越好）。任何一条线路 / 车站 / 公司归属变了，
       * 指纹就对不上 → _checkStaleCaches 立刻重建，不再"等跨天"。
       */
      stampStations: db.prepare('SELECT id, kind, catchment_m, node_id, lat, lon FROM stations ORDER BY id'),
      stampLines: db.prepare('SELECT id, kind, stops, company_id, owner FROM lines ORDER BY id'),
      updateLine: db.prepare('UPDATE lines SET name = ?, color = ?, kind = ?, stops = ?, loop = ?, path = ?, path_len = ?, path_error = ?, path_built_at = ?, schedule = ? WHERE id = ?'),
      delLine: db.prepare('DELETE FROM lines WHERE id = ?'),
      insertVehicle: db.prepare(`INSERT INTO vehicles(owner, company_id, line_id, name, cars, capacity_per_car, max_speed, length_m, kind, cost, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
      vehicle: db.prepare('SELECT * FROM vehicles WHERE id = ?'),
      allVehicles: db.prepare('SELECT * FROM vehicles'),
      /**
       * **热路径专用的窄语句**：仿真每一小步、每一帧、每个快照只关心"挂在某条线路上的车"。
       * 实测规模是 867 辆车里只有 32 辆在跑 —— 用 allVehicles.all() 的话，每一小步都要把 867 行
       * 做成 JS 对象再逐行 `continue` 掉 835 辆闲置车（node:sqlite 实测 876 行 1524 µs /
       * 32 行 64 µs，×300 倍速一个 tick 有 25 小步、_step 与 _enforceSpacing 各来一次 → 每次
       * tick 白花 70 ms 上下）。line_id 上有 idx_vehicles_line（dbschema.js），所以闲置车
       * 一行都不读：**不删任何数据**也能拿到"把闲置车删掉"的那个收益。
       * 注意：`WHERE line_id IS NOT NULL` 用不上索引（SQLite 走 SCAN），但 SQL 层就把 867 行
       * 过滤成 32 行，省掉的正是最贵的那步（每行一个 JS 对象）。
       */
      activeVehicles: db.prepare('SELECT * FROM vehicles WHERE line_id IS NOT NULL'),
      vehiclesOnLine: db.prepare('SELECT * FROM vehicles WHERE line_id = ?'),
      countVehiclesOfOwner: db.prepare('SELECT COUNT(*) AS c FROM vehicles WHERE owner = ?'),
      countCompanies: db.prepare('SELECT COUNT(*) AS c FROM companies'),
      countStations: db.prepare('SELECT COUNT(*) AS c FROM stations'),
      countLines: db.prepare('SELECT COUNT(*) AS c FROM lines'),
      countVehicles: db.prepare('SELECT COUNT(*) AS c FROM vehicles'),
      companyTotals: db.prepare('SELECT COALESCE(SUM(riders), 0) AS riders, COALESCE(SUM(revenue), 0) AS revenue FROM companies'),
      // 每帧的公司块：只取 companyPublic() 真正会读的那几列（顺带当"这一帧变了没有"的指纹）
      companyFrameRows: db.prepare('SELECT id, owner, name, color, cash, riders, revenue, spent, active FROM companies ORDER BY id'),
      updateVehicle: db.prepare('UPDATE vehicles SET line_id = ?, name = ?, cars = ?, capacity_per_car = ?, max_speed = ? WHERE id = ?'),
      delVehicle: db.prepare('DELETE FROM vehicles WHERE id = ?'),
      saveSim: db.prepare('UPDATE sim_state SET clock_ms = ?, speed = ?, day = ?, updated_at = ? WHERE id = 1'),
      // 底图导入：导入站（imported=1）用这一条插入，osm_type/osm_id 记下它来自哪个 OSM 元素
      insertImportedStation: db.prepare(`INSERT INTO stations(owner, company_id, name, kind, lat, lon, node_id, way_id, platform_m, catchment_m, show_catchment, cost, created_at, imported, osm_type, osm_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`),
      stationByOsm: db.prepare('SELECT * FROM stations WHERE osm_type = ? AND osm_id = ? LIMIT 1'),
      importedCount: db.prepare('SELECT COUNT(*) AS c FROM stations WHERE imported = 1'),
      nodesWithTags: db.prepare(`SELECT n.id, n.lat, n.lon, n.tags FROM node_index i JOIN nodes n ON n.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND n.deleted = 0 AND ${IMPORT_SQL_FILTER}
        ORDER BY n.id LIMIT ?`),
      allNodesWithTags: db.prepare(`SELECT id, lat, lon, tags FROM nodes
        WHERE deleted = 0 AND ${IMPORT_SQL_FILTER} ORDER BY id LIMIT ?`),
      waysWithTags: db.prepare(`SELECT w.id, w.tags, w.min_lat, w.max_lat, w.min_lon, w.max_lon FROM way_index i JOIN ways w ON w.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND w.deleted = 0 AND ${IMPORT_SQL_FILTER}
        ORDER BY w.id LIMIT ?`),
      allWaysWithTags: db.prepare(`SELECT id, tags, min_lat, max_lat, min_lon, max_lon FROM ways
        WHERE deleted = 0 AND ${IMPORT_SQL_FILTER} ORDER BY id LIMIT ?`),
    };
    this._ensureStatsTable();
    this._ensureSimRow();
    /* ------------------------------ #规模：车队内存态 ------------------------------ */
    /**
     * **热路径只认这一份内存态**：启动时把 vehicles 表读一次（一条 SELECT），之后——
     *   · 每一小步的模拟（_simStep）、净距检查（_enforceSpacing）
     *   · 每一帧的广播（_simTrains / vehicleFrame）
     *   · 每一小步都会问到的"这辆车在哪条线上、车长多少、定员多少、加减速多少"
     * 全部只读内存，一次 SQLite 都不发。只有"位置/班次状态真的变了"的车会按批落盘
     * （默认每 3 秒一次、一个事务、一条复用的 prepared statement，见 _persistFleet）。
     *
     * 车少时（几十辆）这一层也照跑：它就是"把 867 行换成 32 行"那件事的彻底版——
     * 现在连那 32 行都不再每小步读一次。
     */
    this._fleet = new FleetStore(db, {
      config: this.config,
      // 加减速：与 _dynFor 用同一个判据（车型表 → 认不出来用 config 默认值）
      dynamicsFor: (v) => dynamicsForKind(v && v.kind, this.config),
      persistMs: Math.max(250, Number(this.config.persistIntervalMs) || DEFAULTS.persistIntervalMs),
      onPersist: (n, ms) => { this._fleetPersistLog = { n, ms, at: Date.now() }; },
    });
    this._fleetLoaded = false;
    this._fleetDirtySince = 0;         // 上一次落盘的真实时刻
    // 一帧的"视口内车辆集合"缓存：同一帧给多个客户端算一次就够了（见 _frameFleetSet）
    this._frameVehicles = null;
    // 玩家的视口（#广播按需）：playerId -> {lat, lon, radiusM, zoom, at}，由 index.js 喂进来
    this.playerViews = new Map();
    // #预算：内部游戏时钟的进位余量（tick 被 5 ms 预算打断时靠它接上，见 _simStep）
    this._timeAcc = 0;
    // 统计（实测/排查用）：每一小步的车数、LOD 分布、最长同步片段
    this.simStats = {
      steps: 0, coarseSteps: 0, fineSteps: 0, skipped: 0, parkedSkips: 0,
      lastStepMs: 0, maxStepMs: 0, maxTickMs: 0, longestSyncMs: 0, budgetHits: 0,
      lastStepVehicles: 0, lastStepFine: 0, lastStepCoarse: 0,
      lastStepMsReal: 0, loadMs: 0, lastTickMs: 0, lastViewVehicles: 0,
    };
    this._ensureFleetReady();          // 装载（失败也只是退化成空车队，不能让服务起不来）
    this._syncFleetLines();            // 线路缓存里的 vehicleIds 走内存索引（如果已经有了的话）
    // 位置/状态落盘的一批"上一次真实时刻"
    this._fleetDirtySince = Date.now();
    this._startupImport = { pending: !!this.config.importStationsOnStart, done: false, result: null };
    // 上一帧下发过的公司块指纹（见 companiesIfChanged）：一样就不重复构造、不重复下发
    this._companySig = null;
    // ⚠ index.js 的顺序是 `new Transit(...)` → `rail.build()` → `transit.onRailChanged()`：
    // 构造时铁路网还是一条边都没有，在这里重建线路路径只会让每条线失败一次（还会顺手把
    // 10 秒的道路网在模块加载期间建起来）。真正的全量重建交给 rail.build() 之后那一次
    // onRailChanged()（现在它在 httpServer.listen() 之前跑完，端口一开就是可用状态）。
    // 判据只认"给了 rail 但 nodes 是空的"这一种；rail 干脆没传（单元测试里的纯公交场景）时
    // 保持老行为，照旧在这里重建（那条路走的是 ensureBusGraph() 给的道路网）。
    if (this.rail && !this.graphReady()) {
      console.log('[transit] 铁路网还没建：线路路径留到 rail.build() 之后由 onRailChanged() 重建');
    } else {
      this._rebuildAllLinePaths();
    }
  }

  /** 路网能不能拿来算路径（index.js 里 rail.build() 发生在 new Transit 之后，见构造函数末尾） */
  graphReady() {
    if (!this.rail || !this.rail.nodes) return false;
    return this.rail.nodes.size > 0;
  }

  /**
   * lines 表后加的两列（dbschema.js 不归本文件管，所以老库、新库都在这里补齐）：
   *   schedule        班次（#18）：NULL = 自由发车（老行为），否则是一段 JSON
   *                   {mode:'headway', headwaySec, firstSec, lastSec}   —— 流水班
   *                   {mode:'timetable', times:[sec,...]}                —— 定班车
   *                   两种都能再带 assignments:[{runIndex, vehicleId},…]（#4 每个班次指定车辆）
   *   service_paused  一键暂停运营（#3）：0 = 正常运营，1 = 暂停（不发新车；已在路上的车跑完这一趟）。
   *                   线路上其它 UPDATE（_writeLine / rebuildPath）都不碰它，所以改班次 / 重算路径
   *                   不会把"暂停"这件事弄丢；它跟着线路行一起进出撤销栈。
   */
  _ensureLineColumns() {
    const add = (column, ddl) => {
      try {
        const cols = this.db.prepare('PRAGMA table_info(lines)').all().map((c) => c.name);
        if (!cols.length || cols.includes(column)) return;
        this.db.exec(`ALTER TABLE lines ADD COLUMN ${ddl}`);
      } catch (err) {
        console.warn('[transit] 线路表补列失败:', column, err.message);
      }
    };
    add('schedule', 'schedule TEXT');
    add('service_paused', 'service_paused INTEGER NOT NULL DEFAULT 0');
  }

  /**
   * stations 表后加的三列（dbschema.js 不归本文件管，所以老库、新库都在这里补齐）：
   *   imported  1 = 这个站是从底图导入的（**纯来源信息，不是权限**：导入站一样能改名/删除/挪动）
   *   osm_type / osm_id  来源 OSM 元素（node/way + id），导入的幂等键
   */
  _ensureStationColumns() {
    const add = (column, ddl) => {
      try {
        const cols = this.db.prepare('PRAGMA table_info(stations)').all().map((c) => c.name);
        if (!cols.length || cols.includes(column)) return;
        this.db.exec(`ALTER TABLE stations ADD COLUMN ${ddl}`);
      } catch (err) {
        console.warn('[transit] 车站表补列失败:', column, err.message);
      }
    };
    add('imported', 'imported INTEGER NOT NULL DEFAULT 0');
    add('osm_type', 'osm_type TEXT');
    add('osm_id', 'osm_id INTEGER');
    try {
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_stations_osm ON stations(osm_type, osm_id) WHERE osm_type IS NOT NULL AND osm_id IS NOT NULL');
    } catch (err) {
      console.warn('[transit] 建 osm 唯一索引失败:', err.message);
    }
    // 公交站没有站台长度：把老库里留下的 30/120 归零（只动公交站，跑一次以后就没有匹配行了）
    try {
      this.db.exec("UPDATE stations SET platform_m = 0 WHERE kind = 'bus' AND platform_m <> 0");
    } catch { /* 忽略 */ }
  }

  /**
   * 线路日报表（每条线路每个游戏日一行）。
   * dbschema.js 不归本文件管，所以这里用 CREATE TABLE IF NOT EXISTS 惰性建表，
   * 老库、新库都能直接跑起来。
   */
  _ensureStatsTable() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS line_daily_stats(
      line_id INTEGER NOT NULL,
      day INTEGER NOT NULL,
      riders INTEGER NOT NULL DEFAULT 0,        -- 当日上车人次
      transfers INTEGER NOT NULL DEFAULT 0,     -- 当日在这条线上"下车去换乘"的人次（NR 的 transfers）
      vehicle_km REAL NOT NULL DEFAULT 0,       -- 当日车公里
      load_sum REAL NOT NULL DEFAULT 0,         -- 满载率采样累计（用于算平均满载率）
      load_n INTEGER NOT NULL DEFAULT 0,        -- 满载率采样次数
      wait_sum REAL NOT NULL DEFAULT 0,         -- 候车秒数累计（按上车人数加权）
      wait_n INTEGER NOT NULL DEFAULT 0,        -- 候车采样人数
      updated_at INTEGER,
      PRIMARY KEY(line_id, day)
    )`);
    // 老库里的 line_daily_stats 没有 transfers 列：补上（dbschema.js 不归本文件管）
    try {
      const cols = this.db.prepare('PRAGMA table_info(line_daily_stats)').all().map((c) => c.name);
      if (cols.length && !cols.includes('transfers')) {
        this.db.exec('ALTER TABLE line_daily_stats ADD COLUMN transfers INTEGER NOT NULL DEFAULT 0');
      }
    } catch (err) {
      console.warn('[transit] 线路日报补列失败:', err.message);
    }
    this._st.upsertLineStats = this.db.prepare(`INSERT INTO line_daily_stats(line_id, day, riders, transfers, vehicle_km, load_sum, load_n, wait_sum, wait_n, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(line_id, day) DO UPDATE SET
        riders = riders + excluded.riders,
        transfers = transfers + excluded.transfers,
        vehicle_km = vehicle_km + excluded.vehicle_km,
        load_sum = load_sum + excluded.load_sum,
        load_n = load_n + excluded.load_n,
        wait_sum = wait_sum + excluded.wait_sum,
        wait_n = wait_n + excluded.wait_n,
        updated_at = excluded.updated_at`);
    this._st.lineStatsSince = this.db.prepare('SELECT * FROM line_daily_stats WHERE line_id = ? AND day >= ? ORDER BY day');
  }

  /**
   * 一辆车在数据库里变了（新建 / 改派 / 撤销重做）→ 内存车队跟着变。
   * 读的是刚写完的那一行（冷路径，一次 SELECT 无所谓），保证内存与库永远一致。
   */
  _fleetUpsert(vehicleId) {
    const id = Number(vehicleId);
    const row = this._st.vehicle.get(id);
    if (!row) { this._fleetRemove(id); return null; }
    if (!this._fleetLoaded) return null;
    // 改派/改车型之后"运行时状态"要重建（老代码也是 this.runtime.delete(id)）
    const veh = this._fleet.upsert(row);
    if (veh) veh.rt = null;
    return veh;
  }

  /** 一辆车没了 → 内存车队、运行时状态、空间索引一起摘掉 */
  _fleetRemove(vehicleId) {
    const id = Number(vehicleId);
    this.runtime.delete(id);
    if (!this._fleetLoaded) return;
    this._fleet.remove(id);
  }

  /**
   * 线路缓存里"按车算过"的那几项作废（车的车长 / 车型 / 定员 / 在不在线上变了）。
   * 只清这几项、**不删 lineCache 条目** —— 路径几何（path/stops/lengthM）不因车辆变化而变，
   * 重算它是几十毫秒到几秒（公交线要重新寻路），改个车名不该付这个代价。
   * 清掉的都是纯缓存，下一次用到时会自己重算。
   */
  _invalidateVehicleFacts(lineId) {
    const cache = this.lineCache.get(Number(lineId));
    if (!cache) return false;
    cache.departureKey = null;
    cache.departures = null;
    cache.runPlan = null;
    cache.runPlanKey = null;
    return true;
  }

  /* ------------------------- #规模：车队内存态的装载与落盘 ------------------------- */

  /**
   * 车队装载（幂等，只做一次）：把 vehicles 表读进内存索引。
   * 启动时在构造函数里调一次；之后只有"整表被外部改过"（导入/恢复）时才会再调。
   * 失败不抛：车队空着也能把服务起起来（下一小步发现空车队会再试一次）。
   */
  _ensureFleetReady() {
    if (this._fleetLoaded) return true;
    const t0 = Date.now();
    try {
      const n = this._fleet.load();
      this._fleetLoaded = true;
      this.simStats.loadMs = Date.now() - t0;
      this._fleetDirtySince = Date.now();
      if (n > 0 || this.config.debug) {
        console.log(`[fleet] 车队已装载到内存：${n} 辆（其中挂线路 ${this._fleet.runningCount} 辆，${this.simStats.loadMs} ms，`
          + '此后模拟与广播不再读 vehicles 表）');
      }
    } catch (err) {
      console.warn('[fleet] 车队装载失败（本次退化成空车队，下一次 tick 会重试）:', err.message);
      this._fleetLoaded = false;
      return false;
    }
    return true;
  }

  /**
   * 线路缓存建好之后，把线路的"车数 / 车辆列表"补进内存索引。
   * lineCache 的 vehicleIds 以前是 `SELECT * FROM vehicles WHERE line_id = ?` 每建一条线查一次；
   * 现在按 lineId 读内存索引，O(车数)，不再有 N 条线路 × 1 次查询。
   * 只在 lineCache 被重建时走一次（不是热路径）。
   */
  _syncFleetLines(ids) {
    if (!this._fleetLoaded) return;
    const list = ids ? [...ids] : [...this.lineCache.keys()];
    for (const id of list) {
      const cache = this.lineCache.get(Number(id));
      if (!cache) continue;
      const arr = this._fleet.vehiclesOnLine(id);
      cache.vehicleIds = arr.map((v) => v.id);
    }
  }

  /**
   * 整个车队从数据库重读一遍（**冷路径**：撤销 / 重做 / 外部改库之后才走）。
   * 撤销栈里的步骤是"直接往 vehicles 表里写行"，绕过了 createVehicle/updateVehicle，
   * 所以内存车队要整体重建一次才对得上；顺便把所有 lineCache 的 vehicleIds 重新同步。
   * 位置/班次状态（rt）会重置 —— 这与老代码 `this.runtime.clear()` 的口径一致
   * （撤销之后车从起点重新铺开，本来就是老行为）。
   */
  _reloadFleet() {
    this.runtime.clear();
    if (!this._fleetLoaded) return false;
    try {
      this._fleet.load();
    } catch (err) {
      console.warn('[fleet] 重载失败:', err.message);
      this._fleetLoaded = false;
      return false;
    }
    this._syncFleetLines();
    return true;
  }

  /**
   * **对外**：内存车队与 vehicles 表不一致时重新同步（#规模 的运维入口）。
   *
   * 什么时候需要它：有东西**绕过 Transit 直接改了 vehicles 表**——比如运维脚本
   * （tools/cleanup-idle-vehicles.js 这类）、DBA 手工 UPDATE、或者测试里为了造
   * "定员 13 的小车"直接 `UPDATE vehicles SET cars=?, capacity_per_car=?`。
   * 正常玩法路径（createVehicle / updateVehicle / deleteVehicle / 撤销重做）
   * 都会自己同步，**不需要**调这个。
   *
   *   fleet.reload()                整体重读（最安全；撤销/恢复/导入之后用）
   *   fleet.reload([id, id, ...])   只重读这几辆（按 id 精确刷新，别的不动）
   *   fleet.reload({ lineSync:true }) 顺便把所有线路缓存的 vehicleIds 重新同步
   *
   * 返回 { reloaded, ids, lineSynced }。idle 车不参与模拟，但它也会被同步
   * （车辆管理器看的是内存里的这一份）。
   */
  reloadFleet(arg) {
    const ids = Array.isArray(arg) ? arg : null;
    const opts = (arg && !Array.isArray(arg)) ? arg : {};
    if (!this._fleetLoaded && !this._ensureFleetReady()) return { reloaded: 0, ids: [], lineSynced: false };
    if (!ids) {
      const ok = this._reloadFleet();
      return { reloaded: ok ? this._fleet.totalCount : 0, ids: null, lineSynced: ok };
    }
    const done = [];
    for (const raw of ids) {
      const id = Number(raw);
      if (!Number.isFinite(id)) continue;
      const cur = this._fleet.get(id);
      // 车的运行时状态：位置/速度不该因为"改了个定员"被重置，所以先摘下来再挂回去
      const rt = cur ? cur.rt : null;
      if (cur) this.runtime.delete(id);
      const veh = this._fleetUpsert(id);
      if (veh) {
        veh.rt = rt;
        if (rt) { rt.veh = veh; this.runtime.set(id, rt); }
        done.push(id);
      }
    }
    const lineSync = opts.lineSync !== false;
    if (lineSync) this._syncFleetLines();
    return { reloaded: done.length, ids: done, lineSynced: lineSync };
  }

  /**
   * 一批"位置/班次状态变了"的车落盘。
   * 每 persistIntervalMs（默认 3 秒）真实时间最多一次、一个事务、一条复用的 prepared statement；
   * 没有任何脏车时连事务都不开（return 0）。**位置持久化是"能省则省"的**：
   * 重启后车从"上次落盘的位置"继续，误差最多一个落盘间隔的里程（默认 3 秒 × 车速）。
   */
  _persistFleet(force) {
    if (!this._fleetLoaded) return 0;
    const now = Date.now();
    if (!force && now - (this._fleetDirtySince || 0) < this._fleet.persistMs) return 0;
    this._fleetDirtySince = now;
    try {
      return this._fleet.flush(force);
    } catch (err) {
      console.warn('[fleet] 批量落盘失败:', err.message);
      return 0;
    }
  }

  _loadSimState() {
    const row = this.db.prepare('SELECT * FROM sim_state WHERE id = 1').get();
    if (!row) return;
    this.clockMs = row.clock_ms || 0;
    this.speed = Number(row.speed) || 0;
    this.day = row.day || 1;
  }

  _ensureSimRow() {
    this.db.prepare(`INSERT INTO sim_state(id, clock_ms, speed, day, updated_at) VALUES(1, 0, 1, 1, ?)
      ON CONFLICT(id) DO NOTHING`).run(Date.now());
  }

  /* ------------------------------ 撤销 / 重做 ------------------------------ */
  /** 交通实体也支持 Ctrl+Z：给每次操作记一组"快照步骤"，反向执行即可（与 OSM 编辑同一套思路） */
  static SNAPSHOT_TABLES = ['stations', 'lines', 'vehicles'];

  _row(table, id) {
    if (!Transit.SNAPSHOT_TABLES.includes(table)) return null;
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id)) || null;
  }

  _restoreRow(table, row) {
    if (!Transit.SNAPSHOT_TABLES.includes(table) || !row) return;
    const cols = Object.keys(row);
    const ph = cols.map(() => '?').join(',');
    this.db.prepare(`INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES(${ph})`).run(...cols.map((c) => row[c]));
  }

  _deleteRow(table, id) {
    if (!Transit.SNAPSHOT_TABLES.includes(table)) return;
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(Number(id));
  }

  _pushUndo(userId, entry) {
    const stack = this.undoStacks.get(userId) || [];
    stack.push(this._tagEntry(userId, entry));
    while (stack.length > 50) stack.shift();
    this.undoStacks.set(userId, stack);
    this.redoStacks.set(userId, []);
  }

  /** 交给分组总线登记：拿到全局 seq，正处在分组里就登记进这一组 */
  _tagEntry(userId, entry) {
    if (!this.undoBus || this._groupSuspend) return entry;
    return this.undoBus.tag(this.undoSrc, userId, entry);
  }

  undoDepth(userId) { return (this.undoStacks.get(userId) || []).length; }
  redoDepth(userId) { return (this.redoStacks.get(userId) || []).length; }

  /* ------------- 与分组总线对接（UndoBus 通过这几个入口代跑本模块的步骤） ------------- */
  topSeq(userId) {
    const stack = this.undoStacks.get(userId) || [];
    const entry = stack[stack.length - 1];
    return entry && Number.isFinite(entry.seq) ? entry.seq : -1;
  }

  topRedoSeq(userId) {
    const stack = this.redoStacks.get(userId) || [];
    const entry = stack[stack.length - 1];
    return entry && Number.isFinite(entry.seq) ? entry.seq : -1;
  }

  /** 把指定撤销项从栈里摘出来（分组收尾时），顺序与相对位置都不变 */
  drainUndoEntries(userId, entries) {
    const stack = this.undoStacks.get(userId) || [];
    const drop = new Set(entries);
    const kept = stack.filter((e) => !drop.has(e));
    this.undoStacks.set(userId, kept);
    return stack.length - kept.length;
  }

  invertEntrySteps(entry) { return this._invertTransitSteps(entry.steps); }

  /** 执行一组交通步骤；返回空数组（交通广播走 onChanged → transitSync，不走 OSM 的 ops 通道） */
  applyEntrySteps(user, ctx, entry) {
    this._applyTransitSteps(entry.steps);
    return [];
  }

  undoViaBus(user) { return this._undo(user, null, null, true); }
  redoViaBus(user) { return this._redo(user, null, null, true); }

  /** 一次撤销/重做一整组（几十步）时，不必每一步都重建所有线路路径：攒到最后重建一次 */
  beginBulk() { this._bulk += 1; }

  endBulk() {
    this._bulk = Math.max(0, this._bulk - 1);
    if (this._bulk) return;
    // 组合撤销/重做同样直接改 lines / stations 表（绕过 updateLine / updateStation）：
    // O/D 需求表要作废（不然撤销完客流还按旧线路算），候车台账由 _rebuildAllLinePaths
    // 内部那次 _sweepStationQueues 清扫（见那两处的说明）。
    this._dropOdCache();
    this.lineCache.clear();
    this._rebuildAllLinePaths();
    this.runtime.clear();
    this._reloadFleet();      // #规模：组合撤销同样直接改了 vehicles 表，内存车队要重读
    this.onChanged('undo', 0);
  }

  /** 反向步骤：把当前状态记录下来（用于重做） */
  _invertTransitSteps(steps) {
    const out = [];
    for (const step of steps) {
      const cur = this._row(step.table, step.id);
      out.push(cur ? { table: step.table, id: step.id, mode: 'restore', row: cur } : { table: step.table, id: step.id, mode: 'delete' });
    }
    return out;
  }

  _applyTransitSteps(steps) {
    let touchedLine = false;
    for (const step of steps) {
      if (step.mode === 'delete') this._deleteRow(step.table, step.id);
      else this._restoreRow(step.table, step.row);
      if (step.table === 'stations') {
        // ⚠ 撤销 / 重做是**直接改 stations 表**（绕过 updateStation），而车站的覆盖范围
        // （catchmentM）决定了站间步行接驳（换乘）的半径（见 transferWalkRadiusM）：
        // 覆盖范围（或位置）被恢复成另一个值以后，行程图与 O/D 表都必须重算，否则"撤销一次
        // 改覆盖范围"会留下一张按旧半径算出来的换乘图。这里与 updateStation 同一个口径
        // （_dropDemandCache 内部就会作废 O/D 表与行程图）。组合撤销时只是作废、不重算，
        // 等下一次访问缓存时再按新口径建。
        this._dropDemandCache(step.id);
      }
      if (step.table === 'lines' || step.table === 'stations' || step.table === 'vehicles') touchedLine = true;
    }
    if (this._bulk) return touchedLine;    // 组合撤销：等整组跑完由 endBulk 统一重建
    if (touchedLine) {
      // ⚠ 撤销 / 重做是**直接改 lines 表**（绕过 updateLine），所以 updateLine 里那两件事
      //   （作废 O/D 表、把"线路不再服务的站"的候车队伍搬走）必须在这里补上：
      //   · 不作废 O/D 表 → 撤销"删掉一条线"以后，那条线在 O/D 表里还是旧的（byLine 没有它，
      //     于是它的 boardPerDay 一直是 0：站台上一个乘客都不来，看起来像"撤销把客流弄没了"）；
      //     反过来撤销"改站序"以后，O/D 表里还留着按新站序算的目的地分布（乘客会去错的站）。
      //   · 不清扫候车队伍 → 撤销/重做能把一条线从某些站上摘掉，而它在那儿排的队还挂着
      //     （站台明细里出现"不服务这个站"的线路，人永远等不到车）。
      this._dropOdCache();
      this.lineCache.clear();
      this._rebuildAllLinePaths();      // 内部会做 _sweepStationQueues（见那里的说明）
      this.runtime.clear();
      // #规模：撤销/重做是**直接改 vehicles 表**（_restoreRow / _deleteRow），绕过了
      // createVehicle/updateVehicle —— 所以内存车队要整体重读一次，否则会与库不一致
      this._reloadFleet();
    }
    this.onChanged('undo', 0);
    return touchedLine;
  }

  _undo(user, op, ctx, viaBus) {
    // 先问分组总线：最新一步可能是"一整组"，也可能在 OSM 那条栈上（viaBus=true 时是总线叫我们来的）
    if (!viaBus && this.undoBus) {
      const fromBus = this.undoBus.undo(user, null, this.undoSrc);
      if (fromBus) return fromBus;
    }
    const stack = this.undoStacks.get(user.id) || [];
    const entry = stack.pop();
    if (!entry) throw new TransitError('交通操作没有可撤销的了', 'NOTHING');
    const redoSteps = this._invertTransitSteps(entry.steps);
    this._applyTransitSteps(entry.steps);
    const redo = this.redoStacks.get(user.id) || [];
    redo.push({ label: entry.label, steps: redoSteps, seq: entry.seq });
    this.redoStacks.set(user.id, redo);
    return { undone: entry.label, steps: entry.steps.length, label: '撤销：' + entry.label };
  }

  _redo(user, op, ctx, viaBus) {
    if (!viaBus && this.undoBus) {
      const fromBus = this.undoBus.redo(user, null, this.undoSrc);
      if (fromBus) return fromBus;
    }
    const stack = this.redoStacks.get(user.id) || [];
    const entry = stack.pop();
    if (!entry) throw new TransitError('交通操作没有可重做的了', 'NOTHING');
    const undoSteps = this._invertTransitSteps(entry.steps);
    this._applyTransitSteps(entry.steps);
    const undo = this.undoStacks.get(user.id) || [];
    undo.push({ label: entry.label, steps: undoSteps, seq: entry.seq });
    this.undoStacks.set(user.id, undo);
    return { redone: entry.label, steps: entry.steps.length, label: '重做：' + entry.label };
  }

  /* --------------------- 协作编辑：谁能改什么 + 元素锁 --------------------- */
  /**
   * 协作规则（本文件的权限口径，车站 / 线路 / 车辆 / 公司都一样）：
   *   · **谁都可以改任何人建的交通资产**（多人一起建线才是这个玩法的重点）。
   *     **车站没有归属这回事**：底图导入的站与玩家自建的站完全一样 —— 谁都能改名 / 改类型 /
   *     挪位置 / 删除（updateStation / deleteStation 里没有任何"公共车站"的特判），
   *     imported / osm_type / osm_id 只是"它从底图哪个元素来的"这条信息，不参与权限判断；
   *   · 冲突靠**元素锁**挡：谁在改谁上锁，别人拿到一句明确的中文错误，
   *     一直挡到锁被释放（对方收工 / 断线）或超时（LOCK_TTL_MS = 120 秒）；
   *   · 撤销栈仍然**按玩家分开**（undoStacks 以 userId 为键，_pushUndo(user.id, …) 只压自己的栈）：
   *     玩家 A 的 Ctrl+Z 只回退 A 自己做过的那几步，动不到 B 的任何东西；
   *     变更集审计（osmops 的 changeset）不经过这里，一个字都没改。
   *
   * 锁表优先借 OSM 那一张：index.js 把 OsmOps 与 Transit 挂在同一条 UndoBus 上，
   * 这里用 module('osm') 拿到它 —— 于是
   *   · 锁会跟着既有的 `locks` 广播发给所有客户端（谁在改什么，全服可见）；
   *   · 玩家断线时 OsmOps.releaseLocks 会把他的锁一起清掉（不会留下永远开着的锁）；
   *   · 超时口径（120 秒）只有一处，两边不会打架。
   * 拿不到 OSM 模块时（测试 / 工具脚本里独立 new Transit），退化成自己这张同语义的锁表。
   */
  _osmOps() {
    const bus = this.undoBus;
    if (bus && typeof bus.module === 'function') {
      const m = bus.module('osm');
      if (m && typeof m.lock === 'function' && typeof m.checkLock === 'function') return m;
    }
    return null;
  }

  /**
   * transit op：lock.set { elemType:'station'|'line'|'vehicle'|'company', id, on }
   * 上锁（on 缺省）或解锁（on:false）。返回 { elemType, id, on, locked[, by] }：
   * locked=true 且带 by（别人占了锁）时客户端该提示"XX 正在编辑"，但**不报错**——
   * 真正被拒是下一次改/删操作（checkElementLock 抛 LOCKED）。
   */
  lockElement(user, op = {}) {
    const type = String(op.elemType || op.type || '');
    if (!LOCKABLE_ELEMENTS.has(type)) {
      throw new TransitError(`元素锁只支持 ${[...LOCKABLE_ELEMENTS].join(' / ')}（收到：${type || '空'}）`, 'BAD_LOCK');
    }
    const id = Number(op.id);
    if (!Number.isFinite(id)) throw new TransitError('lock.set 需要 id（锁哪一个元素）', 'BAD_LOCK');
    const on = op.on !== false;
    const osm = this._osmOps();
    if (osm) return Object.assign({ elemType: type, id, on }, osm.lock(type, id, user, on));
    const key = type + ':' + id;
    const table = this._locks || (this._locks = new Map());
    const cur = table.get(key);
    if (!on) {
      if (cur && cur.userId === user.id) table.delete(key);
      return { elemType: type, id, on, locked: false };
    }
    if (cur && cur.userId !== user.id && Date.now() - cur.ts < LOCK_TTL_MS) {
      return { elemType: type, id, on, locked: true, by: cur.name };
    }
    table.set(key, { userId: user.id, name: user.name, ts: Date.now() });
    return { elemType: type, id, on, locked: false };
  }

  /**
   * 改 / 删之前过一遍元素锁：别人正锁着就抛 TransitError（code=LOCKED，中文原因），
   * 没人锁、或者锁在自己手里 → 放行。user 为空（系统内部调用）时不限制。
   * 注意抛的是**本模块的错误类型**：index.js 只对 TransitError 原样透出中文原因。
   *
   * 口径（只有一条，别在别处偷偷加）：锁把守的是**这条 op 直接改的那个元素** ——
   * update/delete 车站要车站的锁、线路要线路的锁、车辆要车辆的锁、公司要公司的锁。
   * 顺带被牵动的元素不要求锁（删车站会把线路上的这一站摘掉；删线路会把车摘下来；
   * 删公司会级联），因为这些代码本来就处理得干净，而"因为某个没点名的元素被锁着所以删不掉"
   * 只会让人看不懂。要把车派到某条线路上同样只看那辆车自己（线路只要求存在）。
   */
  checkElementLock(user, type, id) {
    if (!user || user.id == null) return;
    const osm = this._osmOps();
    if (osm) {
      try {
        osm.checkLock(type, id, user);
      } catch (err) {
        if (err && err.code === 'LOCKED') throw new TransitError(err.message, 'LOCKED');
        throw err;
      }
      return;
    }
    const cur = (this._locks || new Map()).get(type + ':' + Number(id));
    if (cur && cur.userId !== user.id && Date.now() - cur.ts < LOCK_TTL_MS) {
      throw new TransitError(`${cur.name} 正在编辑这个元素，请稍后再试`, 'LOCKED');
    }
  }

  /** 当前被锁住的交通元素：{ 'station:12': { name, userId } }（测试 / 调试 / 将来的客户端展示用） */
  elementLocksSnapshot() {
    const out = {};
    const osm = this._osmOps();
    if (osm) {
      for (const [key, v] of Object.entries(osm.locksSnapshot())) {
        if (LOCKABLE_ELEMENTS.has(key.split(':')[0])) out[key] = v;
      }
      return out;
    }
    const now = Date.now();
    for (const [key, v] of this._locks || []) {
      if (now - v.ts > LOCK_TTL_MS) { this._locks.delete(key); continue; }
      out[key] = { name: v.name, userId: v.userId };
    }
    return out;
  }

  /**
   * 释放某个玩家的交通元素锁（收工 / 断线时用）。
   * 借 OSM 锁表时不需要它：index.js 在连接关闭时已经调 OsmOps.releaseLocks(user.id)，
   * 那张表里就有我们放的锁。这里只是让"自带锁表"的场合也有同样的入口（没人调也没关系，锁会超时）。
   */
  releaseUserLocks(userId) {
    const osm = this._osmOps();
    if (osm) { osm.releaseLocks(userId); return; }
    for (const [key, v] of [...(this._locks || [])]) if (v.userId === userId) this._locks.delete(key);
  }

  /* ------------------------------ 公司（每人可有多家） ------------------------------ */
  _stCompaniesOf(userId) {
    return this.db.prepare('SELECT * FROM companies WHERE owner = ? ORDER BY id').all(userId);
  }

  /**
   * 取当前公司：优先用传入的 id，否则用"active"标记的那家，都没有就新建一家。
   *
   * ⚠ 这里按 owner 过滤是**故意保留**的（协作编辑规则下的例外）：它决定"新建的车站/线路/车辆
   *   算在哪家公司的账上"（造价从这家公司的资金里扣）。放开它 = 谁都能拿别人的钱建自己的东西，
   *   所以新建资产的归属永远是自己那家公司；要改**别人**名下的资产不用经过它
   *   （updateStation / updateLine / updateVehicle 直接按 id 取行，见那些函数）。
   */
  ensureCompany(user, companyId) {
    const wanted = Number(companyId);
    if (Number.isFinite(wanted)) {
      const row = this.db.prepare('SELECT * FROM companies WHERE id = ? AND owner = ?').get(wanted, user.id);
      if (row) return row;
    }
    let row = this.db.prepare('SELECT * FROM companies WHERE owner = ? AND active = 1 ORDER BY id LIMIT 1').get(user.id);
    if (row) return row;
    row = this._stCompaniesOf(user.id)[0];
    if (row) {
      this.db.prepare('UPDATE companies SET active = 1 WHERE id = ?').run(row.id);
      return row;
    }
    return this.createCompany(user, { name: user.name, color: user.color, silent: true });
  }

  createCompany(user, op = {}) {
    const existing = this._stCompaniesOf(user.id);
    const name = String(op.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24)
      || (existing.length ? `${user.name} 交通 ${existing.length + 1}` : user.name);
    const color = /^#[0-9a-f]{6}$/i.test(String(op.color || '')) ? op.color : (user.color || '#e6194b');
    const cash = this.config.economy ? this.config.startingCash : 0;
    this.db.prepare('UPDATE companies SET active = 0 WHERE owner = ?').run(user.id);
    const res = this.db.prepare(`INSERT INTO companies(owner, name, color, cash, riders, revenue, spent, active, created_at, updated_at)
      VALUES(?,?,?,?,0,0,0,1,?,?)`).run(user.id, name, color, cash, Date.now(), Date.now());
    const company = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(res.lastInsertRowid));
    // 送一支起步车队
    for (const item of STARTER_FLEET) {
      const preset = VEHICLE_KINDS[item.kind];
      if (!preset) continue;
      const vid = this.db.prepare(`INSERT INTO vehicles(owner, company_id, line_id, name, cars, capacity_per_car, max_speed, length_m, kind, cost, created_at)
        VALUES(?,?,NULL,?,?,?,?,?,?,0,?)`).run(user.id, company.id, item.name, preset.cars, preset.capacityPerCar, preset.maxSpeed, preset.lengthM, item.kind, Date.now());
      void vid;
    }
    this.onChanged('company', company.id);
    return company;
  }

  selectCompany(user, op) {
    const id = Number(op.id);
    const row = this.db.prepare('SELECT * FROM companies WHERE id = ? AND owner = ?').get(id, user.id);
    if (!row) throw new TransitError('公司不存在', 'NOTFOUND');
    this.db.prepare('UPDATE companies SET active = 0 WHERE owner = ?').run(user.id);
    this.db.prepare('UPDATE companies SET active = 1 WHERE id = ?').run(id);
    this.onChanged('company', id);
    return { company: this.companyPublic(this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id)) };
  }

  deleteCompany(user, op) {
    const id = Number(op.id);
    // 协作编辑：谁都能删任何一家公司（它名下的车站/线路/车辆会跟着一起删，撤销一步能全放回来）。
    // 但**至少给这家公司的东家留一家**：原来的"至少要保留一家公司"现在按 row.owner 判，
    // 否则删别人的公司会受"我自己有几家"影响，规则就乱了。
    // ⚠ 这里**没有**任何"系统公司不能删"之类的特判：车站没有归属，导入站挂靠的那家公司
    //    （SYSTEM_OWNER）与玩家公司地位完全相同，删它只是把挂靠的导入站一起删掉
    //    （导入是可以重跑的，importStations 幂等）；唯一的门槛是上面那条通用的"至少留一家"。
    const row = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (!row) throw new TransitError('公司不存在', 'NOTFOUND');
    if (this._stCompaniesOf(row.owner).length <= 1) throw new TransitError('至少要保留一家公司');
    this.checkElementLock(user, 'company', id);
    const steps = [
      { table: 'companies', id, mode: 'delete' },
    ];
    for (const s of this.db.prepare('SELECT * FROM stations WHERE company_id = ?').all(id)) {
      steps.push({ table: 'stations', id: s.id, mode: 'restore', row: s });
      this._dropStationQueue(s.id, id);   // 公司没了，只清这家公司在这些车站的候车队伍（别家公司的队伍留着）
    }
    for (const l of this.db.prepare('SELECT * FROM lines WHERE company_id = ?').all(id)) {
      steps.push({ table: 'lines', id: l.id, mode: 'restore', row: l });
      this.lineStatsAcc.delete(l.id);
      // 这家公司的线路整条消失：它们在**别家公司的车站**上排的队不能留成幽灵队伍
      //（自己的车站下面已经整站清过了），搬进兜底桶 —— 谁的车来都能拉走
      this._reassignLineQueue(l.id);
    }
    for (const v of this.db.prepare('SELECT * FROM vehicles WHERE company_id = ?').all(id)) {
      steps.push({ table: 'vehicles', id: v.id, mode: 'restore', row: v });
    }
    this.db.prepare('DELETE FROM vehicles WHERE company_id = ?').run(id);
    this.db.prepare('DELETE FROM lines WHERE company_id = ?').run(id);
    this.db.prepare('DELETE FROM stations WHERE company_id = ?').run(id);
    this.db.prepare('DELETE FROM companies WHERE id = ?').run(id);
    // 被删公司的东家：把他剩下的第一家重新标成"当前公司"（删的是别人的公司时不动我的 active）
    const next = this._stCompaniesOf(row.owner)[0];
    if (next) this.db.prepare('UPDATE companies SET active = 1 WHERE id = ?').run(next.id);
    // 线路集合整体变了：O/D 需求表（以及它里面的行程 / 步行接驳表）必须作废重算，
    // 否则"这家公司的线路已经没了，O/D 表里还有它们"，站台上会出现走不掉的乘客
    //（行程要换乘的那条线已经不存在了）。
    this._dropOdCache();
    this.lineCache.clear();
    this._rebuildAllLinePaths();     // 内部会做 _sweepStationQueues
    this.runtime.clear();
    this._pushUndo(user.id, { label: `删除公司「${row.name}」`, steps });
    this.onChanged('company', id);
    return { deleted: id, name: row.name, activeCompany: next ? this.companyPublic(next) : null };
  }

  companyPublic(row) {
    if (!row) return null;
    return {
      id: row.id, owner: row.owner, name: row.name, color: row.color,
      cash: Math.round(row.cash), revenue: Math.round(row.revenue),
      // riders 是"人次"，内部按小数累积（一趟车可能只攒到 0.4 个人的零头），
      // 但对玩家展示的人数**一律整数**（用户报的「几点几人」，见 wholePeople 的说明）
      riders: Math.round(Number(row.riders) || 0),
      spent: Math.round(row.spent), active: !!row.active,
    };
  }

  companiesPublic(userId) {
    return this._stCompaniesOf(userId).map((c) => this.companyPublic(c));
  }

  /**
   * 改公司的名字 / 配色。协作编辑：给了 companyId 就能改**任何一家**公司（公司也是共享资产，
   * 名称与配色全服可见），不给 companyId 还是老规矩 —— 改自己当前那家公司。
   * selectCompany（切换"我当前在用哪家公司"）仍然是**每人自己的**：那是玩家的会话状态，不是共享资产。
   */
  setCompanyProfile(user, { name, color, companyId }) {
    let c = null;
    const wanted = Number(companyId);
    if (Number.isFinite(wanted)) {
      c = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(wanted) || null;
      if (c) this.checkElementLock(user, 'company', c.id);
    }
    if (!c) c = this.ensureCompany(user, companyId);
    const nm = String(name == null ? c.name : name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || c.name;
    const col = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : c.color;
    this.db.prepare('UPDATE companies SET name = ?, color = ?, updated_at = ? WHERE id = ?').run(nm, col, Date.now(), c.id);
    return this.companyPublic(this.db.prepare('SELECT * FROM companies WHERE id = ?').get(c.id));
  }

  _charge(company, amount, reason) {
    if (!this.config.economy) return;   // 经济系统关闭时一切免费
    if (company.cash < amount) {
      throw new TransitError(`资金不足：需要 ${Math.round(amount).toLocaleString('zh-CN')} 元，账上只有 ${Math.round(company.cash).toLocaleString('zh-CN')} 元`, 'NO_CASH');
    }
    this._st.updateCompany.run(company.name, company.color, company.cash - amount, company.riders, company.revenue, company.spent + amount, Date.now(), company.id);
  }

  _earn(companyId, amount) {
    const c = this._st.company.get(companyId);
    if (!c) return;
    this._st.updateCompany.run(c.name, c.color, c.cash + amount, c.riders, c.revenue + amount, c.spent, Date.now(), c.id);
  }

  /* --------------------- 等车队伍（车站 × 公司 × 线路） --------------------- */
  /**
   * 候车队伍挂在车站上，分三层记账：**车站 → 公司 → 线路桶**（桶键 = 线路 id，0 号桶是兜底桶）。
   * 删车 / 换车 / 重启模拟，排队的乘客都还在。
   *
   * 为什么必须按线路分桶（这就是"站台上的人按线路分队"）：
   *   一个站台上可能同时有等 1 号线的 6 个人和等 2 号线的 4 个人。2 号线的车进站时，
   *   只能把 2 号线那一桶（外加兜底桶）拉走 —— 车上的载客正好 +4，站台上留下那 6 个人。
   *   乘客属于哪条线不是猜的：O/D 需求表（_ensureOdDemand）按"同时停起点与目的地的线路"
   *   把乘客平分（byLine → 各站 boardPerDay / destMix），_arrivalsStep 就照这个往对应桶里放人，
   *   所以每一批乘客天生就带着自己的线路；车停站时**只认自己那条线的桶**，绝不碰别条线的桶。
   *
   * 兜底桶（lineId = null / 0）：没有"专属线路"的乘客 —— 手工注入的、老存档里的、
   *   目的地没有任何线路能到的（_arrivalsToQueue 拿不到 destMix 的情况），以及线路被删掉之后
   *   原地留下的那批人。他们没有能坐的线，所以哪条线来车都能上（来车的那条线就是他们唯一的选择）。
   *
   * 每个桶里是一批批乘客（cohort）：每批记下自己的到达时刻，等超过 config.patienceSeconds
   *   就整批放弃离开（计进**本桶**的 lost，再逐级汇总到线路与车站）；车进站停靠时按"先到先上"
   *   把自己那一桶抽干，最多上到定员。这样等车人数会随时间真实涨落：车不够 → 队伍越排越长、
   *   lost 持续累积；车够 → 队伍被抽空。
   */
  _companyKey(companyId, owner) {
    return companyId == null || companyId === '' ? 'o:' + owner : 'c:' + companyId;
  }

  /** 桶键：线路 id；没有线路 / 不知道能坐哪条线 → 0（兜底桶） */
  _bucketKey(lineId) {
    const n = lineId == null || lineId === '' ? 0 : Number(lineId);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  _queueEntry(stationId, companyId, owner) {
    const sid = Number(stationId);
    let byCompany = this.stationQueues.get(sid);
    if (!byCompany) {
      byCompany = new Map();
      this.stationQueues.set(sid, byCompany);
    }
    const key = this._companyKey(companyId, owner);
    let entry = byCompany.get(key);
    if (!entry) {
      entry = {
        companyId: companyId == null ? null : Number(companyId),
        owner: owner || null,
        buckets: new Map(),   // 桶键 -> bucket：按线路分开的候车队伍（0 = 兜底桶，见 _lineBucket）
        waiting: 0,           // 这家公司在这个站等车的总人数（= Σ 各桶，小数累计，攒够整人才上车）
        lost: 0,              // 等太久已经放弃离开的累计人数（= Σ 各桶）
        waitStartMs: this.clockMs,  // 最老那批乘客开始等车的时刻（跨桶取最早）
        servedAtMs: 0,        // 最近一次有车停靠的时刻
      };
      byCompany.set(key, entry);
    }
    return entry;
  }

  /**
   * 取（或建）一个线路桶：桶里只放"这条线能拉走的人"，桶与桶之间互不相通。
   * lineId 为 null / 0 时是兜底桶（没有专属线路、谁都能拉的乘客）。
   */
  _lineBucket(entry, lineId) {
    const key = this._bucketKey(lineId);
    let b = entry.buckets.get(key);
    if (!b) {
      b = {
        lineId: key || null,   // null = 兜底桶
        // [{ key, destId, people, startMs, plan, idx }]：这条线的候车批次（FIFO，先到先上）
        //   key 是乘客分组键（行程 × 第几段，见 _paxGroupKey），换乘前后是两组
        cohorts: [],
        waiting: 0,            // 这条线的等车人数（小数累计）
        lost: 0,               // 这条线上等太久走掉的人（累计）
        carry: 0,              // waiting 的小数零头（展示/兼容用）
        waitStartMs: this.clockMs,
        servedAtMs: 0,
      };
      entry.buckets.set(key, b);
    }
    return b;
  }

  /** 一个 entry（车站 × 公司）里最老的候车时刻：跨桶取最早；没有人在等就是 null */
  _oldestOf(entry) {
    let oldest = null;
    for (const b of entry.buckets.values()) {
      if (!(b.waiting > 0) || !b.cohorts.length) continue;
      const start = b.cohorts[0].startMs;
      if (oldest == null || start < oldest) oldest = start;
    }
    return oldest;
  }

  /** 一条线的名字与颜色（分线路候车明细要用；线路已经被删掉就给 null，客户端另有兜底） */
  _lineMeta(lineId) {
    const id = Number(lineId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const row = this._st.line.get(id);
    return row ? { name: row.name, color: row.color } : null;
  }

  /**
   * 乘客分组键（NIMBY Rails 的 pax group："pax are represented using groups of pax with the
   * same destination"，见 Pax 页）。一趟行程里同一个（行程 × 当前第几段）的乘客会并成一组：
   *   plan 有值      → "行程 id#第几段"，于是换乘前后的两批人是两个组（下车 / 上车的账分得清）
   *   plan 为 null   → "d:目的站"（老存档 / 手工注入 / 换乘信息丢了之后降级的乘客）
   */
  _paxGroupKey(plan, idx, destId) {
    if (plan && idx != null && plan.steps && plan.steps[idx]) return `${plan.id}#${idx}`;
    return 'd:' + (destId == null ? 0 : Number(destId));
  }

  /** 行程里"第几段是坐这条线"（换乘的乘客已经带着准确的段号，这里只给"没带段号"的兜底） */
  _rideStepIndex(plan, lineId) {
    if (!plan || !plan.steps) return null;
    const lid = lineId == null ? null : Number(lineId);
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      if (s.type === 'ride' && (lid == null || Number(s.lineId) === lid)) return i;
    }
    return null;
  }

  /**
   * **这条线现在真的会停这一站吗？** —— 候车队伍（车站 × 线路桶）唯一的合法性判据。
   *
   * 判据是**线路缓存里的停靠站**（rebuildPath 算出来的、车真的会停的那些站），不是 O/D 表里
   * 那份行程：行程是"建 O/D 表那一刻"算出来的快照，乘客身上带着它可以跨越好几个小时、
   * 甚至跨越一次改线（线路改站序 / 删站 / 删线路 / 换公司 / 撤销）。
   *
   * 这就是用户报的「等车目的站与线路不匹配」的根因所在：换乘的乘客在换乘站重新排队时
   * （_alightAt）只认行程里的 lineId，从来不问"这条线现在还停这一站吗"，于是站台上会挂出
   * 一条**根本不服务这个站**的线路的候车明细 —— 而且那批人永远等不到车（见 _addWaiting 的守卫）。
   *
   * 性能：这个函数在 _addWaiting（每小步每站每条线都会调）里，所以线路缓存上挂一个
   * Set 做 O(1) 命中。安全性：线路一改（updateLine / deleteStation / 撤销 / 路网变化）都会
   * rebuildPath 换掉整个 cache 对象（或整张 lineCache 清空），Set 跟着一起没了，不会读到旧值。
   */
  _lineServesStation(lineId, stationId) {
    const id = Number(lineId);
    const sid = Number(stationId);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(sid)) return false;
    const cache = this.lineCache.get(id);
    if (!cache || !cache.stops || !cache.stops.length) return false;
    let set = cache.stopIdSet;
    if (!set || set.size !== cache.stops.length) {
      set = new Set();
      for (const st of cache.stops) set.add(Number(st.stationId));
      cache.stopIdSet = set;
    }
    return set.has(sid);
  }

  /**
   * 行程从第 idx 段起还走得通吗？（每一段乘车都要求：那条线还在、并且现在还停 its from / to）
   * 走不通的行程必须当场作废（降级成"只知道目的站"的乘客，见 _sweepStationQueues / _addWaiting），
   * 否则乘客会拿着一条已经不存在的换乘链，被挂在某个站上永远等不到车。
   */
  _planFeasible(plan, idx) {
    if (!plan || !plan.steps || !plan.steps.length) return false;
    const from = idx == null ? 0 : Number(idx);
    if (!(from >= 0) || from >= plan.steps.length) return false;
    let rides = 0;
    for (let i = from; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      if (!s) return false;
      if (s.type !== 'ride') continue;      // 步行段只要求两站还在（车站没了由 O/D 表重建兜住）
      rides += 1;
      if (!this._lineServesStation(s.lineId, s.from)) return false;
      if (!this._lineServesStation(s.lineId, s.to)) return false;
    }
    return rides > 0;      // 剩下的段里至少要还有一段乘车（纯步行的行程不是"排这条队的理由"）
  }

  /**
   * 兜底桶该挂在哪个公司名下：兜底桶是"这家公司的任意一条线来车都能拉"，
   * 所以给的公司必须**在这个站有线路停靠**，否则这批人会谁的车都上不去（白等到放弃）。
   * 返回 { companyId, owner }（找不到就原样返回调用方给的那对）。
   */
  _fallbackCompanyAt(stationId, companyId, owner) {
    if (this._companyKeyServesStation(companyId, owner, stationId)) return { companyId, owner };
    for (const cache of this.lineCache.values()) {
      if (!cache.stops || !cache.stops.length) continue;
      for (const st of cache.stops) {
        if (Number(st.stationId) !== Number(stationId)) continue;
        return { companyId: cache.queueCompanyId, owner: cache.companyOwner };
      }
    }
    return { companyId, owner };
  }

  /** 这一站有没有"这家公司"（按 _companyKey 口径）的线路停靠 */
  _companyKeyServesStation(companyId, owner, stationId) {
    const key = this._companyKey(companyId, owner);
    const sid = Number(stationId);
    for (const cache of this.lineCache.values()) {
      if (!cache.stops || !cache.stops.length) continue;
      if (this._companyKey(cache.queueCompanyId, cache.companyOwner) !== key) continue;
      for (const st of cache.stops) if (Number(st.stationId) === sid) return true;
    }
    return false;
  }

  /**
   * 一批乘客到站等车，放进**它自己那条线**的桶里。
   * 同一桶内（同一个 cohortSeconds 窗口、**同一个目的站 / 同一段行程**）并成一批 ——
   * NIMBY Rails 里乘客也是"按同一目的地打成一包"的（见 population.js 顶部的出处）。
   * lineId 为 null 表示"不知道能坐哪条线"（手工注入 / 老存档 / 目的地没有线路能到 / 线路被删过）
   * → 兜底桶。destId 为 null 表示"不知道去哪"，这批会在终点站附近按统计口径下车。
   * plan + idx 是这趟行程与"现在要坐第几段"（换乘的乘客会被重新放进下一段的桶里，见 _alightAt）。
   * people 是小数（按游戏秒累计）。
   *
   * ⚠ **这里是"（车站 × 线路）必须真的成立"的唯一守卫**（用户报的「等车目的站与线路不匹配」）：
   *   进来时如果 lineId 那条线**现在不停这一站**（改过站序 / 线路被删 / 撤销过 / 乘客身上带的
   *   是 O/D 表建表时那份已经过期的行程），就绝不把乘客挂到那条线的桶里 —— 那会让站台明细里
   *   冒出一条根本不服务这个站的线路，而且那批人永远等不到车（车根本不停这一站）。
   *   处理办法（按优先级）：
   *     ① 用**当前**的行程图从这一站重新给这批人算一条行程（_itinerary：带缓存的 Dijkstra），
   *        第一段乘车的那条线就是他现在该排的队（换乘链、公司口径一起跟着新的走）；
   *     ② 算不出行程（真的走不掉了）→ 兜底桶 + 行程作废，他们照样能被"任何一条停这一站的车"拉走。
   *   行程与桶对不上（桶是 A 线、行程第 idx 段却是 B 线）时同样作废行程，只留目的站。
   */
  _addWaiting(stationId, companyId, owner, lineId, people, nowMs, destId, plan, idx) {
    if (!(people > 0)) return null;
    const sid = Number(stationId);
    const did = destId == null ? null : Number(destId);
    let lid = lineId == null || lineId === '' ? null : Number(lineId);
    if (!Number.isFinite(lid) || lid <= 0) lid = null;
    let p = plan || null;
    let stepIdx = p && idx == null ? this._rideStepIndex(p, lid) : (idx == null ? null : Number(idx));
    if (p && !(stepIdx != null && p.steps[stepIdx])) { p = null; stepIdx = null; }
    // ① 守卫：这条线现在真的停这一站吗？
    if (lid != null && !this._lineServesStation(lid, sid)) {
      const fresh = did == null ? null : this._itinerary(sid, did);
      const first = fresh && fresh.steps && fresh.steps[0];
      if (first && first.type === 'ride' && this._lineServesStation(first.lineId, sid)) {
        lid = Number(first.lineId);
        p = fresh;
        stepIdx = 0;
        const freshCache = this.lineCache.get(lid);
        if (freshCache) { companyId = freshCache.queueCompanyId; owner = freshCache.companyOwner; }
      } else {
        const fb = this._fallbackCompanyAt(sid, companyId, owner);
        companyId = fb.companyId;
        owner = fb.owner;
        lid = null;
        p = null;
        stepIdx = null;
      }
    } else if (lid == null && p) {
      // 兜底桶不该带"要坐某条线的第几段"的行程（桶是"谁的车都能上"）：只留目的站
      p = null;
      stepIdx = null;
    }
    // ② 行程与桶必须对得上：第 idx 段要么是桶里这条线的乘车段、要么是"先走一段路去坐它"（from = 本站）
    if (p) {
      const step = p.steps[stepIdx];
      const okStep = step && (step.type === 'ride'
        ? (lid != null && Number(step.lineId) === lid && Number(step.from) === sid)
        : (step.type === 'walk' && Number(step.from) === sid));
      if (!okStep || !this._planFeasible(p, stepIdx)) { p = null; stepIdx = null; }
    }
    const e = this._queueEntry(sid, companyId, owner);
    const b = this._lineBucket(e, lid);
    const key = this._paxGroupKey(p, stepIdx, did);
    const cohortMs = Math.max(1, Number(this.config.cohortSeconds) || DEFAULTS.cohortSeconds) * 1000;
    const last = b.cohorts[b.cohorts.length - 1];
    if (last && last.key === key && nowMs - last.startMs < cohortMs) {
      last.people += people;
    } else {
      b.cohorts.push({ key, destId: did, people, startMs: nowMs, plan: p, idx: p ? stepIdx : null });
    }
    // 桶里批次太多时把最老的两批并成一批（保留更早的到达时刻，等待时间不会被"洗白"）。
    // 两批的目的站/行程不同时，留更新的那批的标签（人数一个不少；到站时间取更早的）。
    const maxCohorts = Math.max(4, Number(this.config.maxCohorts) || DEFAULTS.maxCohorts);
    while (b.cohorts.length > maxCohorts) {
      const a = b.cohorts.shift();
      const c2 = b.cohorts.shift();
      b.cohorts.unshift({
        key: c2.key, destId: c2.destId, people: a.people + c2.people,
        startMs: Math.min(a.startMs, c2.startMs), plan: c2.plan, idx: c2.idx,
      });
    }
    b.waiting += people;
    b.carry = b.waiting - Math.floor(b.waiting);
    b.waitStartMs = b.cohorts.length ? b.cohorts[0].startMs : nowMs;
    e.waiting += people;
    const oldest = this._oldestOf(e);
    e.waitStartMs = oldest == null ? nowMs : oldest;
    return e;
  }

  /**
   * 从**某一个桶**里按"先到先上"抽走最多 take 个整人（同时把这家公司在这个站的合计减掉）。
   * 只动这一个桶：别条线路排的队一根手指都不许碰（这是"按线路分队"的核心）。
   * 返回上车的整人数、候车秒数累计（按人数加权），以及**按乘客分组的 groups**
   * （Map(分组键 → { destId, people, plan, idx })；键见 _paxGroupKey，行程不同的人不会混组，
   *   因为换乘前后是两段不同的行程段）。
   */
  _drainBucket(entry, bucket, take, nowMs) {
    let boarded = 0;
    let waitSum = 0;
    const groups = new Map();
    const destMix = groups;      // 兼容旧名字（内部老调用点用 destMix）
    let i = 0;
    while (i < bucket.cohorts.length && boarded < take - 1e-9) {
      const c = bucket.cohorts[i];
      const got = Math.min(c.people, take - boarded);
      if (got > 1e-9) {
        c.people -= got;
        boarded += got;
        waitSum += ((nowMs - c.startMs) / 1000) * got;
        const key = c.key || this._paxGroupKey(c.plan, c.idx, c.destId);
        const g = groups.get(key);
        if (g) g.people += got;
        else groups.set(key, { destId: c.destId, people: got, plan: c.plan || null, idx: c.idx == null ? null : c.idx });
      }
      if (c.people <= 1e-9) bucket.cohorts.splice(i, 1);
      else i += 1;
    }
    bucket.waiting = Math.max(0, bucket.waiting - boarded);
    bucket.carry = bucket.waiting - Math.floor(bucket.waiting);
    bucket.waitStartMs = bucket.cohorts.length ? bucket.cohorts[0].startMs : nowMs;
    entry.waiting = Math.max(0, entry.waiting - boarded);
    const oldest = this._oldestOf(entry);
    entry.waitStartMs = oldest == null ? nowMs : oldest;
    return { boarded, waitSum, destMix, groups };
  }

  /**
   * 车站候车情况的"精简版"：只要三个数（等车人数 / 放弃人数 / 最老一批等了多久）。
   * 每帧广播的 snapshot() 用这个，别把按公司/按线路的明细也塞进每一帧。
   */
  _stationWaitSummary(stationId) {
    const byCompany = this.stationQueues.get(Number(stationId));
    if (!byCompany) return { waiting: 0, lost: 0, waitSeconds: 0 };
    let waiting = 0;
    let lost = 0;
    let oldestMs = null;
    for (const e of byCompany.values()) {
      waiting += e.waiting;
      lost += e.lost;
      const own = this._oldestOf(e);
      if (own != null && (oldestMs == null || own < oldestMs)) oldestMs = own;
    }
    return {
      waiting: Math.round(waiting),
      lost: Math.round(lost),
      waitSeconds: oldestMs == null ? 0 : Math.max(0, Math.round((this.clockMs - oldestMs) / 1000)),
    };
  }

  /**
   * 车站候车情况（给所有客户端看）：等车人数、已放弃人数、最老一批等了多久（waitSeconds），
   * 以及按公司（waitingByCompany）与按线路（waitingByLine）的拆分。
   *
   * waitingByLine 是"站台上的人按线路分队"的对外账本：
   *   [{ lineId, name, color, waiting, lost, waitSeconds, destMix }]
   * lineId 为 null 的那一条是兜底桶（没有专属线路的人：手工注入 / 目的地没有线路能到 /
   * 线路被删掉后留下的），客户端把它显示成「未指定线路」。
   * 同一个线路桶在多家公司下都有，会在这里先汇总再返回（玩家想看的是"这条线有多少人在等"）。
   *
   * **按目的地分组的候车明细**（客户端要显示"这一站等车的人分别要去哪"）：
   *   · waitingByLine[].destMix  [{ stationId, name, people }]
   *       —— 这条线在这个站等的人，按**目的站**分组（只算这条线的桶，换乘前的那一段算它自己的目的站）；
   *   · waitingByDest          [{ stationId, name, people, lines:[lineId] }]
   *       —— 整个站台合起来，按目的站分组，并给出"这些人在等哪几条线"。
   * 数据来源就是候车批次（cohort，天生带 destId，见 _addWaiting），所以人数与 waiting 对得上；
   * 同一个目的站的人按整站汇总、同一批人不会算两遍。
   *
   * **人数一律是整数**（用户报的「等车 3.4 人」）：内部账（cohort.people / bucket.waiting）还是小数，
   * 只在**这里**（对外展示的最后一步）取整，而且用 wholePeople 的最大余数法 ——
   * 每一行的整数之和正好等于那一行的合计（waitingByLine[].destMix 之和 = 这一行的 waiting，
   * waitingByDest 之和 = 车站 waiting），界面里不会出现"合计 7 人、明细加起来 8 人"。
   * 目的站 id 为 null（老存档 / 手工注入 / 换乘信息丢失的乘客）会归成一条：
   * stationId = null、name = '未知目的地'；兜底桶的乘客在 lines 里是 null（= 未指定线路）。
   * 价格（体积）：**只有真的有人在等的车站**才算这一块 —— 空站与"只剩 lost"的站给空数组，
   * 每 250 ms 一帧的快照不会因此变大（stationPublic 的调用点见 snapshot 的 stations 循环）。
   */
  stationWaiting(stationId) {
    const byCompany = this.stationQueues.get(Number(stationId));
    let waiting = 0;
    let lost = 0;
    let oldestMs = null;
    const companies = [];
    const lineAgg = new Map();   // 桶键（0 = 兜底）-> { waiting, lost, oldestMs }
    // 候车明细的"按目的地"账（只有真有人等时才填）：
    const lineDestAgg = new Map();   // 桶键 -> Map(目的站键 -> 人数)：每条线各自的去向
    const destAgg = new Map();       // 目的站键 -> { people, lines:Set(桶键) }：整个站台合起来
    const secs = (ms) => (ms == null ? 0 : Math.max(0, Math.round((this.clockMs - ms) / 1000)));
    // 目的站键：0 = "不知道去哪"（destId 为 null）；站名现查（车站改名后下一帧就是新名字）
    const destKeyOf = (destId) => (destId == null ? 0 : Number(destId));
    const destNameOf = (key) => {
      if (!key) return '未知目的地';
      const row = this._st.station.get(Number(key));
      return row ? row.name : '车站 #' + key;
    };
    // 人多的排前面；"不知道去哪"（键 0）排最后；同人数按 id 稳定排序
    const byPeopleThenKey = (a, b) => (b[1] - a[1])
      || ((a[0] ? 0 : 1) - (b[0] ? 0 : 1))
      || (a[0] - b[0]);
    // 站台那份是 Map(目的站键 -> { people, lines })，人数在 v.people 上，排序口径同上
    const byDestPeople = (a, b) => (b[1].people - a[1].people)
      || ((a[0] ? 0 : 1) - (b[0] ? 0 : 1))
      || (a[0] - b[0]);
    if (byCompany) {
      for (const e of byCompany.values()) {
        const own = this._oldestOf(e);
        waiting += e.waiting;
        lost += e.lost;
        if (own != null && (oldestMs == null || own < oldestMs)) oldestMs = own;
        const byLineOut = [];
        // 桶键从小到大：线路按 id 排好，兜底桶（0）因为 waiting 排序会落到后面
        for (const [key, b] of [...e.buckets].sort((x, y) => x[0] - y[0])) {
          const bOldest = (b.waiting > 0 && b.cohorts.length) ? b.cohorts[0].startMs : null;
          // 这条线在这个站等的人，按目的站分组（人少的空桶直接给空数组）
          const perDest = new Map();
          if (b.waiting > 0) {
            for (const c of b.cohorts) {
              if (!(c.people > 0)) continue;
              const dk = destKeyOf(c.destId);
              perDest.set(dk, (perDest.get(dk) || 0) + c.people);
              const ga = destAgg.get(dk) || { people: 0, lines: new Set() };
              ga.people += c.people;
              ga.lines.add(key);
              destAgg.set(dk, ga);
            }
          }
          // 展示用的整数人数：合计取的就是这一行的 waiting（最大余数法，见 wholePeople）
          const perDestInt = wholePeople(perDest);
          byLineOut.push({
            lineId: key || null,
            waiting: Math.round(b.waiting),
            lost: Math.round(b.lost),
            waitSeconds: secs(bOldest),
            destMix: perDest.size
              ? [...perDest].sort(byPeopleThenKey).map(([dk]) => ({
                stationId: dk ? Number(dk) : null, name: destNameOf(dk), people: perDestInt.get(dk) || 0,
              }))
              : [],
          });
          // 各家公司的同一个桶键合起来看（与 waitingByLine 的汇总口径一致）
          if (perDest.size) {
            let merged = lineDestAgg.get(key);
            if (!merged) { merged = new Map(); lineDestAgg.set(key, merged); }
            for (const [dk, people] of perDest) merged.set(dk, (merged.get(dk) || 0) + people);
          }
          const agg = lineAgg.get(key) || { waiting: 0, lost: 0, oldestMs: null };
          agg.waiting += b.waiting;
          agg.lost += b.lost;
          if (bOldest != null && (agg.oldestMs == null || bOldest < agg.oldestMs)) agg.oldestMs = bOldest;
          lineAgg.set(key, agg);
        }
        companies.push({
          companyId: e.companyId,
          owner: e.owner,
          waiting: Math.round(e.waiting),
          lost: Math.round(e.lost),
          waitSeconds: secs(own),
          byLine: byLineOut,
        });
      }
    }
    // 人多的线路排前面；兜底桶没有专属线路，排到最后；同样人数按桶键稳定排序
    const lineRows = [...lineAgg]
      .sort((a, b) => (b[1].waiting - a[1].waiting)
        || ((a[0] ? 0 : 1) - (b[0] ? 0 : 1))
        || (a[0] - b[0]))
      .map(([key, agg]) => {
        const meta = key ? this._lineMeta(key) : null;
        const merged = lineDestAgg.get(key);
        // 跨公司汇总那一路也要取整，而且合计正好等于这一行的 waiting（各行加起来不会多一个少一个）
        const mergedInt = merged ? wholePeople(merged) : null;
        return {
          lineId: key || null,
          name: meta ? meta.name : (key ? '线路 #' + key : '未指定线路'),
          color: meta ? meta.color : null,
          waiting: Math.round(agg.waiting),
          lost: Math.round(agg.lost),
          waitSeconds: agg.waiting > 0 && agg.oldestMs != null ? secs(agg.oldestMs) : 0,
          // 这条线的候车人按目的站分组（跨公司汇总，见上）
          destMix: merged && merged.size
            ? [...merged].sort(byPeopleThenKey).map(([dk]) => ({
              stationId: dk ? Number(dk) : null, name: destNameOf(dk), people: mergedInt.get(dk) || 0,
            }))
            : [],
        };
      });
    // 整个站台：按目的站分组 + 这些人在等哪几条线（兜底桶 → null = 未指定线路）
    const destInt = wholePeople([...destAgg].map(([dk, v]) => [dk, v.people]));
    const waitingByDest = [...destAgg]
      .sort(byDestPeople)
      .map(([dk, v]) => ({
        stationId: dk ? Number(dk) : null,
        name: destNameOf(dk),
        people: destInt.get(dk) || 0,
        lines: [...v.lines].sort((x, y) => ((x ? 0 : 1) - (y ? 0 : 1)) || (x - y)).map((k) => k || null),
      }));
    return {
      waiting: Math.round(waiting),
      lost: Math.round(lost),
      waitSeconds: oldestMs == null ? 0 : Math.max(0, Math.round((this.clockMs - oldestMs) / 1000)),
      waitingByCompany: companies,
      waitingByLine: lineRows,
      waitingByDest,
    };
  }

  /** 车站被删 / 公司被删时清理候车队伍 */
  _dropStationQueue(stationId, companyId = undefined) {
    const sid = Number(stationId);
    if (companyId === undefined) {
      this.stationQueues.delete(sid);
      this.walkers.delete(sid);          // 正在步行接驳（OSI）的乘客跟着这一站一起清掉
      this.stationStats.delete(sid);
      return;
    }
    const byCompany = this.stationQueues.get(sid);
    if (!byCompany) return;
    for (const [key, e] of byCompany) {
      if (e.companyId === Number(companyId)) byCompany.delete(key);
    }
    if (!byCompany.size) this.stationQueues.delete(sid);
  }

  /**
   * 一条线路被删掉（或某几站不再停靠）之后：那个线路桶里还在等的人不能凭空消失，
   * 而是并进兜底桶 —— 从此哪条线来车都能拉走他们（他们的目的地已经没有"专属线路"能直达，
   * 兜底桶正是为这种乘客准备的）。stationIds 为 null 表示"这条线沿线的所有车站都处理"。
   * 返回被搬走的人数。
   */
  _reassignLineQueue(lineId, stationIds = null) {
    const key = this._bucketKey(lineId);
    if (!key) return 0;
    const only = stationIds == null ? null : new Set([...stationIds].map(Number));
    let moved = 0;
    for (const [sid, byCompany] of this.stationQueues) {
      if (only && !only.has(sid)) continue;
      for (const e of byCompany.values()) {
        const b = e.buckets.get(key);
        if (!b) continue;
        if (!b.cohorts.length && !(b.lost > 0)) { e.buckets.delete(key); continue; }
        const fallback = this._lineBucket(e, 0);
        if (b.cohorts.length) {
          for (const c of b.cohorts) {
            fallback.cohorts.push(c);
            moved += c.people;
          }
          fallback.cohorts.sort((x, y) => x.startMs - y.startMs);
          fallback.waiting += b.waiting;
          fallback.carry = fallback.waiting - Math.floor(fallback.waiting);
          fallback.waitStartMs = fallback.cohorts.length ? fallback.cohorts[0].startMs : this.clockMs;
        }
        // 这条线的桶整个消失：历史上放弃的人也搬到兜底桶的账上，
        // 这样"各桶 lost 之和 = 车站 lost 总计"这条账始终对得上，不会有乘客凭空蒸发
        fallback.lost += b.lost;
        e.buckets.delete(key);
        const oldest = this._oldestOf(e);
        e.waitStartMs = oldest == null ? this.clockMs : oldest;
      }
    }
    return moved;
  }

  /**
   * **整个候车台账的一致性清扫**（线路集合 / 站序一变就跑一次，不在热路径上）。
   *
   * 不变量（用户点名的「等车目的站与线路不匹配」就是它被破坏了）：
   *   一个车站的候车明细里，非兜底行的那条线路**必须真的停这一站**；每一批乘客身上带的行程
   *   也必须**从这一站起还走得通**。
   *
   * 谁来破坏它：乘客的行程是"建 O/D 表那一刻"算出来的快照，之后改站序 / 删站 / 删线路 /
   * 撤销重做 / 车被改派，都能让手里的行程过期 —— 那批人如果还挂在老线路的桶里，站台明细就会
   * 冒出一条根本不服务这个站的线路，而且他们永远等不到车。所以每次线路结构变化后：
   *   · 桶的线路已经不服务这一站 → 整桶（连 lost 的账）搬进兜底桶，行程作废（见 _reassignLineQueue）；
   *   · 行程从第 idx 段起走不通 → 只作废行程（人留在原桶，只留目的站，到站照常下车）。
   * 返回 { moved, plans }（搬走的人数 / 作废的行程数）。
   */
  _sweepStationQueues() {
    if (!this.stationQueues || !this.stationQueues.size) return { moved: 0, plans: 0 };
    let moved = 0;
    let plans = 0;
    const touched = new Set();
    // 第 1 遍：桶的线路已经不服务这一站 → 整桶（连 lost 的账）搬进兜底桶。
    // 先按"哪条线在哪些站失效"汇总，再每条线调一次 _reassignLineQueue —— 那条函数会扫全站，
    // 一个 (站 × 桶) 调一次的话是 O(站²)；汇总之后是 O(线 × 站)。
    const badKeys = new Map();       // 桶键 -> Set(站 id)
    for (const [sid, byCompany] of [...this.stationQueues]) {
      for (const e of byCompany.values()) {
        for (const key of e.buckets.keys()) {
          if (!key || this._lineServesStation(key, sid)) continue;
          let set = badKeys.get(key);
          if (!set) { set = new Set(); badKeys.set(key, set); }
          set.add(sid);
        }
      }
    }
    for (const [key, sids] of badKeys) {
      moved += this._reassignLineQueue(key, sids);
      for (const sid of sids) touched.add(sid);
    }
    // 第 2 遍：行程过期（从第 idx 段起走不通 / 与桶对不上）→ 只作废行程，人留在原桶
    //（第 1 遍刚搬进兜底桶的批次也要在这一遍里过一遍，所以分两遍而不是一趟到底）
    for (const [sid, byCompany] of [...this.stationQueues]) {
      for (const e of byCompany.values()) {
        for (const [key, b] of e.buckets) {
          for (const c of b.cohorts) {
            if (!c.plan) continue;
            const idx = c.idx == null ? 0 : Number(c.idx);
            const step = c.plan.steps ? c.plan.steps[idx] : null;
            const ok = !!step && this._planFeasible(c.plan, idx)
              && (step.type === 'ride'
                ? (!!key && Number(step.lineId) === Number(key) && Number(step.from) === Number(sid))
                : (step.type === 'walk' && Number(step.from) === Number(sid)));
            if (!ok) {
              c.plan = null;
              c.idx = null;
              c.key = this._paxGroupKey(null, null, c.destId);
              plans += 1;
              touched.add(sid);
            }
          }
        }
      }
    }
    for (const sid of touched) {
      const byCompany = this.stationQueues.get(sid);
      if (!byCompany) continue;
      for (const [ckey, e] of [...byCompany]) {
        const oldest = this._oldestOf(e);
        e.waitStartMs = oldest == null ? this.clockMs : oldest;
        // 空壳 entry（桶都搬走了、既没人等也没人等过）不留着，否则车站明细里会多一行 0 人
        if (!e.buckets.size && !(e.waiting > 0) && !(e.lost > 0)) byCompany.delete(ckey);
      }
      if (!byCompany.size) this.stationQueues.delete(sid);
    }
    return { moved: Math.round(moved * 1000) / 1000, plans };
  }

  /**
   * 线路换了运营公司（#2 line.transfer）：把这条线在各站的**候车队伍从旧公司搬到新公司名下**。
   *   · 为什么必须搬：车按线路的新公司结算票款与上车（cache.queueCompanyId），队伍留在旧公司名下
   *     就永远等不到车了 —— 只能等耐心耗尽离开（人没被"删"，但等于白等一场）；
   *   · **人一个不少**：候车批次（cohort）原样搬过去，到达时刻不变，所以等待计时继续走、
   *     耐心规则照旧；lost 的账也跟着搬（"各桶之和 = 车站合计"这条账不能破）。
   * 参数 fromKey 是旧队伍的公司键（_companyKey(companyId, owner)，见 _queueEntry）。
   * 返回搬走的人数。
   */
  _moveLineQueueCompany(lineId, fromKey, toCompanyId, toOwner) {
    const key = this._bucketKey(lineId);
    if (!key || !fromKey) return 0;
    const toKey = this._companyKey(toCompanyId, toOwner);
    if (toKey === fromKey) return 0;
    let moved = 0;
    for (const [sid, byCompany] of [...this.stationQueues]) {
      const from = byCompany.get(fromKey);
      if (!from) continue;
      const b = from.buckets.get(key);
      if (!b) continue;
      const to = this._queueEntry(sid, toCompanyId, toOwner);
      const target = this._lineBucket(to, key);
      if (b.cohorts.length) {
        for (const c of b.cohorts) {
          target.cohorts.push(c);
          moved += c.people;
        }
        target.cohorts.sort((x, y) => x.startMs - y.startMs);
        target.waiting += b.waiting;
        target.carry = target.waiting - Math.floor(target.waiting);
        target.waitStartMs = target.cohorts.length ? target.cohorts[0].startMs : this.clockMs;
      }
      target.lost += b.lost;
      target.servedAtMs = Math.max(target.servedAtMs || 0, b.servedAtMs || 0);
      from.buckets.delete(key);
      from.waiting = Math.max(0, from.waiting - b.waiting);
      from.lost = Math.max(0, from.lost - b.lost);
      const fromOldest = this._oldestOf(from);
      from.waitStartMs = fromOldest == null ? this.clockMs : fromOldest;
      to.waiting += b.waiting;
      to.lost += b.lost;
      const toOldest = this._oldestOf(to);
      to.waitStartMs = toOldest == null ? this.clockMs : toOldest;
      // 旧公司在这个站既没人等也没人等过 → 整条 entry 清掉（不留空壳）
      if (!from.buckets.size && !(from.waiting > 0) && !(from.lost > 0)) byCompany.delete(fromKey);
      if (!byCompany.size) this.stationQueues.delete(sid);
    }
    return moved;
  }

  /* ------------------------------ 站点 ------------------------------ */
  /** 取指定模式的路网（巴士网按需构建） */
  graph(mode) {
    if (graphFor(mode) === 'bus') {
      if (!this.bus && this.ensureBusGraph) this.bus = this.ensureBusGraph();
      return this.bus || this.rail;
    }
    return this.rail;
  }

  /**
   * **按坐标取路网**（P4 惰性建图，见 deploy/REGIONS.md §7.1）。
   *
   * 分区惰性模式下 `this.rail` / `this.bus` 不是一张图，而是"按区域建图的协调器"
   * （`server/regions.js` 的 `RegionGraphSource`）：它按坐标挑出**属于该区域的那一张图实例**。
   * 关键点：协调器**只是选一张图交给调用方**，绝不把两张图的节点表并起来 ——
   * 虚拟路口 id 每个实例都从 −1 开始编号（`railgraph.js` 的 `VIRTUAL_NODE_ID`），
   * 拼图必然撞号（§6.5.1 的最硬一条禁令）。
   *
   * 开关关着时 `this.rail` 是普通 `RailGraph`（没有 `graphAt`）⇒ 原样返回，
   * 这条路径与改动前**逐字节相同**。
   */
  graphAt(kind, lat, lon) {
    const g = this.graph(kind);
    if (g && typeof g.graphAt === 'function') return g.graphAt(lat, lon) || g;
    return g;
  }

  /**
   * **选/建"用来寻路的那张图"**（P4，§6.5.2 方案 C）：
   * 把线路各站的节点 id 交给路网，由它决定用哪张区域图、还是按走廊 bbox **新建一张临时图**。
   * 返回 `{ graph, route }`，或 null = "这次没有专门的图"（调用方退回老路径 `this.graph(kind)`）。
   * 开关关着时 `this.graph(kind)` 是普通 RailGraph（没有 `routeFor`）⇒ 返回 null，行为不变。
   */
  routeFor(kind, nodeIds) {
    const g = this.graph(kind);
    if (!g || typeof g.routeFor !== 'function') return null;
    return g.routeFor(nodeIds);
  }

  /**
   * 有没有"要用道路网"的线路（公交）。index.js 用它决定启动时要不要花那 8~10 秒建道路网
   * （实测 91873 条道路 / 107 万段 / 10.1 s）：纯铁路城市直接跳过，第一次真的用到公交时
   * 再由 graph('bus') → ensureBusGraph() 惰性建。判据与 graph() 保持同一处口径（graphFor）。
   */
  needsRoadGraph() {
    for (const line of this._st.allLines.all()) if (graphFor(line.kind) === 'bus') return true;
    return false;
  }

  /**
   * **P4：给"走廊图预热"用的线路清单**（deploy/REGIONS.md §6.5.2 方案 C）：
   * 每条线路的 `kind` 与**各站吸附到的节点 id**。只读，不改任何状态。
   * 取不到车站/节点就跳过那一条 —— 预热只是优化，缺了会在第一次重建路径时同步补上。
   */
  corridorTargets() {
    const out = [];
    let lines = [];
    try { lines = this._st.allLines.all() || []; } catch { return out; }
    for (const line of lines) {
      try {
        const stops = this._parseStops(line.stops);
        const nodeIds = [];
        for (const sid of stops) {
          const s = this._st.station.get(sid);
          if (s && s.node_id != null) nodeIds.push(Number(s.node_id));
        }
        if (nodeIds.length >= 2) out.push({ id: line.id, kind: line.kind, nodeIds });
      } catch { /* 单条线路解析失败不影响别的 */ }
    }
    return out;
  }

  /* --------------------------- 车站需求（只看覆盖人口） --------------------------- */
  /**
   * 车站需求的缓存键：游戏日 + 人口网格版本号。
   * 人口网格一变（改建筑）、或者跨了一天（时段曲线 / 周末系数要换），键就变，重算一次；
   * 其余时间（每帧广播、每一小步模拟）只做一次字符串比较，不查库、不遍历。
   */
  _demandKey() {
    const pop = this.population;
    if (pop && typeof pop.setDay === 'function') pop.setDay(this.day);
    return `${this.day}|${pop && pop.version != null ? pop.version : 0}`;
  }

  /** 丢掉某个车站（或全部）的需求缓存 */
  _dropDemandCache(stationId) {
    // ⚠ 顺序与"无条件作废"都很要紧：这里以前写成 `if (!this._stationDemand) return;`，
    // 于是"需求缓存还没建起来"的时候连 O/D 表都不作废了 —— 那正是最需要作废的时刻
    //（启动早期、撤销里直接改 stations 表、导入新车站）。两件事必须各做各的。
    if (this._stationDemand) {
      if (stationId == null) this._stationDemand.clear();
      else this._stationDemand.delete(Number(stationId));
    }
    // 车站行变了（新建 / 改覆盖范围 / 挪位置 / 改类型 / 删除）：线路缓存里那几项
    // "从车站行抄过来的"信息（名称 / 坐标 / 覆盖半径）也要跟着刷 ——
    // 不刷的话 updateStation 只作废需求缓存，而 _refreshLineDemand 会拿线路缓存里**旧的
    // catchmentM** 去问 population.catchment()，于是"改了覆盖范围，线路明细与沿线需求还是旧的"
    // （用户投诉 #1 里"改覆盖范围要立刻生效"的那一半）。改车站本来就不重建路径，所以这一步很便宜。
    const refreshed = this._refreshStopsFromStations(stationId);
    this._dropOdCache();
    return refreshed;
  }

  /**
   * 一个车站的需求（人/日），带缓存。口径见 population.js 顶部（含 NIMBY Rails 出处）：
   *
   *   需求 demand = 覆盖人口（距离加权）× 活跃度        ← 只看人口，**没有岗位项**
   *   日上车人数 dailyTrips = demand × 出行率 tripRatePerDay
   *     · 这就是 NR 的 station spawn rate 的"日总量"：覆盖多少人，一天就产生多少人的出行需求
   *     · 至于这些人去哪里、能不能走掉，由 O/D 需求表决定（见 _ensureOdDemand）
   * 另外带出 coverage / density 两个 NR 口径的量：
   *   coverage = 有效覆盖（= 需求），density = 覆盖半径内的人口密度（人/km²）
   *   NR 1.12 说车站的客流速率同时取决于"车站周边人口密度"和"从该站可达的人口"。
   *
   * tableRow 只要有 id / lat / lon / catchment_m 四个字段就行（station 表的一行，或者线路缓存里的站点）。
   */
  stationDemandOf(tableRow) {
    const id = Number(tableRow.id != null ? tableRow.id : tableRow.stationId);
    const radius = tableRow.catchment_m != null ? tableRow.catchment_m : tableRow.catchmentM;
    const key = this._demandKey();
    if (!this._stationDemand) this._stationDemand = new Map();
    const hit = this._stationDemand.get(id);
    if (hit && hit.key === key) return hit.value;
    const base = { pop: 0, jobs: 0, weightedPop: 0, activity: 1, density: 0, coverage: 0, radiusM: Number(radius) || 700 };
    const c = this.population ? this.population.catchment(tableRow.lat, tableRow.lon, radius) : null;
    const value = Object.assign(base, c || {});
    // 需求公式只有一处实现（population.stationDemand）；人口模块没给 demand 时在这里补上
    value.demand = Math.round(value.demand != null ? value.demand : stationDemand(value));
    value.tripRatePerDay = this.config.tripRatePerDay;
    value.dailyTrips = Math.round(value.demand * this.config.tripRatePerDay);
    value.pop = Math.round(value.pop || 0);
    // 岗位只是展示用的参考值（NR 没有岗位模型）：这里不再拿它折算任何客流
    value.jobs = Math.round(value.jobs || 0);
    // coverage = "有效覆盖"（NR 的 reach）：人口模块给了就用，没给就用 有效人口 或 需求 兜底
    const cov = Number(value.coverage);
    value.coverage = Math.round(cov > 0 ? cov : (Number(value.weightedPop) > 0 ? value.weightedPop : value.demand));
    if (!(Number(value.activity) > 0)) value.activity = 1;
    this._stationDemand.set(id, { key, value });
    return value;
  }

  /* ═══════════════ 行程搜索：换乘 + 站间步行接驳（NIMBY Rails 的 pax pathfinding） ═══════════════
   *
   * NR 里乘客生成后先挑一个目的车站，然后寻路（wiki: Pax / Simulation / Dominating trip）：
   *   "Pax spawn at each origin station, pathfind their way to their destination, and board
   *    trains that get them there"（Simulation 页）
   *   "pax can transfer in stations, but also do Out-of-Station Interchanges (walking)"
   *   "The max radius at which an OSI is possible is 2.3km ... the pax are walking at a speed of
   *    1m/s"（Station 页）
   *   "Group by waited line stop - Group by the next train pax intend to board"（Station 页，
   *    说明换乘的乘客是**在换乘站重新排下一段线路的队**）
   *
   * 所以行程不是"同一条线"能表达的，这里照 NR 的做法搜一条最优行程（本作没有车次时刻表，
   * 就用"旅行时间 + 换乘惩罚 + 上车等待惩罚"当边权，等价于 NR 的 dominating trip）：
   *
   *   节点 = 车站
   *   边   = ①坐一段车：在本站上某条线，坐到这条线上的**任意另一站**（两个方向都能坐，
   *          因为车到端点会掉头）；边权 = 上车等待惩罚 + 走行时间（沿线累计里程 ÷ 平均旅速，
   *          中间每站再加 20 秒停站）
   *         ②走一段路（OSI）：两站**互相落在对方的覆盖范围（catchment）里**时互通 ——
   *           "多远算够得着"由这两站的覆盖半径决定，不再是固定的 2.3 km，见 transferWalkRadiusM；
   *           边权 = 距离 ÷ 1 m/s + 固定代价（步行速度与每段代价都没变）
   *   约束 = 最多换乘 maxTransfers 次（= 最多 4 段乘车）、最多 maxWalkLegs 段步行、
   *          估算时间不超过 maxJourneySeconds；状态里记着"已经坐了几段车 / 走了几段路"。
   *
   * 搜索结果按起点站缓存（LRU）：`at` 给出每个车站的最优标签，`prev` 用来还原行程。
   * 一趟行程（plan）的样子：
   *   { id, originId, destId, steps:[{type:'ride'|'walk', ...}], transfers, walkLegs,
   *     rideMeters, walkMeters, sec, firstLeg }
   * steps[0] 可以是步行（起点站自己没线路，走到覆盖范围内的邻站去坐车）也可以是乘车；
   * 换乘站就是上一段 ride 的 to 与下一段 ride 的 from（中间可能夹一段 walk = 站间步行换乘）。
   *
   * 只有"至少坐一段车"的行程才算数：纯步行的 O/D 不算行程（本作只把 OSI 当接驳手段，
   * NR 的 OSI 也是为换乘服务的）。
   * 另一个明写的简化：**起点站自己有线路时，第一段不许是步行** —— 乘客是从这个站出发的，
   * 站上有车就坐车；步行只用来把"没有任何线路的车站"接进网络（起点侧走出去 / 目的站侧
   * 走回来），或者在中途换乘（OSI）。NR 的真实寻路会连"从有车的站走到旁边另一个站更快"
   * 这种路线一起算，但那样一来"在车站旁边放一个新站"就会悄悄改写已有线路的客流分布；
   * 本作取更保守的口径：只有"没有车可坐"的站才靠步行进出，中途换乘照常允许步行。
   * 还有一条：乘客在站台上排"第一段线路"的队，上这条线**任意一辆车**（本作不按时刻表
   * 分车次、也不分方向 —— 车到端点会掉头，所以反向的车也能把他送到该下的站）。
   * ═══════════════════════════════════════════════════════════════════════════════════════ */

  /** 换乘 / 步行接驳参数（config 覆盖 PAX 的默认值；只在构造与改 config 时算一次） */
  _transferParams() {
    const num = (v, d, min = 0) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? n : d;
    };
    return {
      maxTransfers: Math.max(0, Math.round(num(this.config.maxTransfers, PAX.maxTransfers))),
      maxWalkLegs: Math.max(0, Math.round(num(this.config.maxWalkLegs, PAX.maxWalkLegs))),
      osiRadius: num(this.config.osiRadiusMeters, PAX.osiRadiusM, 1),          // 下限：两站覆盖范围都小时按它走
      // 换乘半径 = 覆盖范围决定（见 config 里那一大段说明与 transferWalkRadiusM）
      rule: this.config.transferRadiusRule === 'max' ? 'max' : 'overlap',
      maxRadius: num(this.config.transferMaxRadiusM, 4000, 1),                 // 绝对上限（米）
      spreadFactor: Math.max(1, num(this.config.transferSpreadFactor, 1.5, 1)),// 相对上限：1.5 = 最多放宽 50%
      neighborLimit: Math.max(0, Math.round(num(this.config.transferNeighborLimit, 48))),  // 每站最多几条边（0=不限）
      walkSpeed: Math.max(0.1, num(this.config.walkSpeedMps, PAX.walkSpeedMps, 0.1)),
      transferPenalty: num(this.config.transferPenaltySeconds, PAX.transferPenaltySec),
      boardPenalty: num(this.config.boardPenaltySeconds, PAX.boardPenaltySec),
      walkPenalty: num(this.config.walkPenaltySeconds, PAX.walkPenaltySec),
      rideSpeed: Math.max(1, num(this.config.rideSpeedKmh, PAX.rideSpeedKmh, 1) / 3.6),   // m/s
      maxJourneySec: num(this.config.maxJourneySeconds, PAX.maxJourneySec, 60),
      maxStates: Math.max(200, Math.round(num(this.config.itineraryMaxStates, 40000, 200))),
      bandCandidates: this.config.odBandCandidates !== false,
      bandFallback: this.config.odBandFallback !== false,
      budgetMs: num(this.config.odBuildBudgetMs, 8000, 100),
    };
  }

  /** 人口网格 / 车站 / 线路一变，行程图与搜索结果都要丢（由 _dropOdCache 统一调用） */
  _dropItineraryCache() {
    this._itinGraph = null;
    if (this._itinSearches) this._itinSearches.clear();
    this._itinSearchStates = 0;
  }

  /**
   * 站间步行接驳（OSI）的允许距离：**由两站的覆盖范围（catchment）决定，不再是固定的 2.3 km**。
   * 这是"换乘半径"口径的唯一实现处（行程图的步行边、测试、UI 都用它，别再各写一份）。
   *
   *   允许距离(A,B) = max( osiRadiusMeters,                        // ① 下限：wiki 的 2.3 km
   *                       min( 覆盖范围距离,                       // ② 覆盖范围说了算的那一段
   *                            max(osiRadiusMeters, spreadFactor × max(catA,catB)),  // ③ 相对上限
   *                            transferMaxRadiusM ) )              // ④ 绝对上限
   *
   *   ② transferRadiusRule = 'overlap'（默认）：catA + catB —— 两个覆盖圈相交，也就是"两站互相
   *     落在对方的覆盖范围里"。这一条是唯一能让"4 km 覆盖范围、相距 5 km 的两站"算得上的口径，
   *     也正是用户说的"按车站覆盖范围来定"。
   *     'max'：max(catA, catB) —— 用户原话的写法（较大的那个覆盖圈罩住另一站）；两种只差一行，
   *     用 config.transit.transferRadiusRule 切换。
   *   ③ 相对上限：覆盖范围再大，也只能比"较大的那个覆盖半径"再放宽 spreadFactor 倍（默认 1.5）。
   *   ④ 绝对上限：再大的覆盖范围也不能超过 transferMaxRadiusM 米（默认 4000）——
   *      "一个大站把全城连起来"就是靠这一条挡住的。
   *   ① 下限永远生效：两站覆盖范围都很小时（默认 700+700 = 1400 m）仍然按 2.3 km 走，
   *     所以**默认数据集上的步行边一条都不会变**，只有把覆盖范围调大的站才会多出边来。
   *
   * 对称性：函数对两个参数对称，所以 A→B 与 B→A 的允许距离一定相同。
   */
  transferWalkRadiusM(catchmentA, catchmentB) {
    const tp = this._tp;
    const a = Math.max(0, Number(catchmentA) || 0);
    const b = Math.max(0, Number(catchmentB) || 0);
    const bigger = Math.max(a, b);
    // ② 覆盖范围给出的距离
    const covered = tp.rule === 'max' ? bigger : a + b;
    // ③④ 相对上限与绝对上限（相对上限本身不会低于下限，否则"下限永远生效"这条就说不通了）
    const spreadCap = Math.max(tp.osiRadius, tp.spreadFactor * bigger);
    const cap = Math.min(tp.maxRadius, spreadCap);
    return Math.max(tp.osiRadius, Math.min(cap, covered));     // ① 下限兜底
  }

  /**
   * 行程搜索图（惰性构建 + 缓存）：车站、每条线的停靠序列与沿线累计里程、站间步行接驳边。
   * 站点或线路（含车站覆盖范围）变了由 _dropOdCache() 作废；平时一次都不重算。
   */
  _ensureItineraryGraph() {
    if (this._itinGraph) return this._itinGraph;
    const t0 = Date.now();
    const tp = this._tp;
    const stations = new Map();
    for (const s of this._st.allStations.all()) {
      // catchmentM 要带上：步行接驳边是不是存在，由"两站的覆盖范围"决定（见 transferWalkRadiusM）
      stations.set(Number(s.id), {
        id: Number(s.id), name: s.name, kind: s.kind, lat: s.lat, lon: s.lon,
        catchmentM: Number(s.catchment_m) || 0,
      });
    }
    const linesOf = new Map();    // stationId -> [{ lineId, idx, entry }]
    const lineRide = new Map();   // lineId -> { lineId, name, kind, stops:[sid], cum:[m] }
    for (const l of this._st.allLines.all()) {
      const raw = this._parseStops(l.stops).filter((id) => stations.has(id));
      if (raw.length < 2) continue;
      const cache = this.lineCache.get(l.id);
      const distOf = new Map();
      if (cache) for (const st of cache.stops) distOf.set(Number(st.stationId), st.distance);
      // 沿线累计里程：优先用已经算好的真实路径里程，没有（路径还没建好）就用直线距离累加
      const cum = [];
      let total = 0;
      for (let i = 0; i < raw.length; i++) {
        if (i > 0) {
          let d = 0;
          const da = distOf.get(raw[i - 1]);
          const db = distOf.get(raw[i]);
          if (da != null && db != null) d = Math.abs(db - da);
          if (!(d > 0)) {
            const a = stations.get(raw[i - 1]);
            const b = stations.get(raw[i]);
            d = metersBetween(a.lat, a.lon, b.lat, b.lon);
          }
          total += d;
        }
        cum.push(total);
      }
      const entry = { lineId: Number(l.id), name: l.name, kind: l.kind, stops: raw, cum, lengthM: total };
      lineRide.set(Number(l.id), entry);
      for (let i = 0; i < raw.length; i++) {
        let arr = linesOf.get(raw[i]);
        if (!arr) { arr = []; linesOf.set(raw[i], arr); }
        if (!arr.some((x) => x.lineId === entry.lineId)) arr.push({ lineId: entry.lineId, idx: i, entry });
      }
    }
    // 站间步行接驳（OSI）：网格索引，避免"几千个站两两算距离"；半径按覆盖范围逐对算
    const walk = this._buildWalkLinks(stations, tp);
    // 目的站候选要"至少有一条线，或者步行接驳范围内有一个有线的站（可以走过去）"
    const walkServed = new Set();
    for (const [sid, list] of walk.adj) {
      if (linesOf.has(sid)) { walkServed.add(sid); continue; }
      for (const nb of list) if (linesOf.has(nb.to)) { walkServed.add(sid); break; }
    }
    this._itinGraph = {
      stations, linesOf, lineRide, walk, walkServed,
      builtAt: Date.now(),
      stats: {
        stations: stations.size,
        lines: lineRide.size,
        walkLinks: walk.links,             // 有向边（两站互通算 2 条，与旧口径一致）
        walkPairs: walk.pairs,             // 无向"互通对"（更直观的那个数）
        walkLimit: tp.neighborLimit,       // 每站最多保留几个步行邻站（安全阀）
        walkPruned: walk.pruned,           // 被安全阀砍掉的互通对（0 = 没砍）
        walkRadiusMaxM: Math.round(walk.maxRadiusM),          // 理论上最远的步行接驳（格子按它定）
        transferRadiusRule: tp.rule,
        transferMaxRadiusM: Math.round(tp.maxRadius),
        transferSpreadFactor: tp.spreadFactor,
        osiRadiusM: Math.round(tp.osiRadius),                 // 下限（wiki 的 2.3 km）
        walkSpeedMps: tp.walkSpeed,
        maxTransfers: tp.maxTransfers,
        ms: Date.now() - t0,
      },
    };
    console.log(`[itin] 行程图：${stations.size} 个车站 / ${lineRide.size} 条线路 / `
      + `${walk.links} 条步行接驳边（${walk.pairs} 对互通；换乘半径按覆盖范围：下限 ${Math.round(tp.osiRadius)} m`
      + ` / 上限 ${Math.round(tp.maxRadius)} m / 每站最多 ${tp.neighborLimit || '∞'} 个邻站，`
      + `砍掉 ${walk.pruned} 对，${tp.walkSpeed} m/s，${this._itinGraph.stats.ms} ms）`);
    return this._itinGraph;
  }

  /**
   * 站间步行接驳边：两站能不能走，由**这两站的覆盖范围**决定（见 transferWalkRadiusM），
   * 两站互通就加两条有向边（Dijkstra 两个方向都能走）。用经纬度网格做邻域查询，不做 O(N²)。
   *
   * 网格的格子边长取"理论上最远的允许距离" max(下限, 绝对上限)，再扫 3×3 邻域 ——
   * 覆盖范围调大以后允许距离会变大，格子必须跟着变大，否则 900 米（甚至 4 km）外的站
   * 会落在邻域之外、被静默漏掉。格子越大每格里的站越多，所以候选对先按距离排序，
   * 再用 transferNeighborLimit 只留最近的 N 个（互相对方都在前 N 里才保留这条边 ——
   * 这样边是对称的，且每个站的度数严格 ≤ N）。N = 0 表示不限（老行为）。
   */
  _buildWalkLinks(stations, tp) {
    const list = [...stations.values()];
    const adj = new Map();
    const limit = Math.max(0, Math.round(tp.neighborLimit || 0));
    const maxRadius = Math.max(tp.osiRadius, tp.maxRadius);
    if (!list.length || !(maxRadius > 0)) {
      return { adj, links: 0, pairs: 0, pruned: 0, cells: 0, cell: 0, maxRadiusM: maxRadius };
    }
    // 经纬度 → 格子的换算：取**所有车站里最靠近赤道的那个**纬度算经度方向的比例尺
    //（cos 最大 = 同样的米数对应最多的经度度数），这样格子对每一个站都够大。
    // 用平均纬度会在地域跨度大的路网上差 1%~2%，边上的一对就可能被漏掉。
    let cosWorst = 0;
    for (const s of list) cosWorst = Math.max(cosWorst, Math.cos((s.lat * Math.PI) / 180));
    const cosLat = Math.max(0.2, cosWorst);
    // 一格 ≥ maxRadius（两个方向都够），所以"3×3 邻域"一定覆盖 maxRadius 内的所有站
    const cell = Math.max(0.0005, maxRadius / (111320 * cosLat));
    const grid = new Map();
    const ckey = (i, j) => i + ':' + j;
    for (const s of list) {
      const k = ckey(Math.floor(s.lat / cell), Math.floor(s.lon / cell));
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(s);
    }
    // 第一遍：把"够得着"的候选对收进每站自己的表里（按距离升序）
    const cand = new Map();        // stationId -> [{ to, meters }]
    for (const s of list) {
      const ci = Math.floor(s.lat / cell);
      const cj = Math.floor(s.lon / cell);
      let mine = null;
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          const arr = grid.get(ckey(i, j));
          if (!arr) continue;
          for (const o of arr) {
            if (o.id === s.id) continue;
            const m = metersBetween(s.lat, s.lon, o.lat, o.lon);
            // 这一对能走多远，由**两站的覆盖范围**定（不再是固定半径）
            if (!(m <= this.transferWalkRadiusM(s.catchmentM, o.catchmentM))) continue;
            if (!mine) { mine = []; cand.set(s.id, mine); }
            mine.push({ to: o.id, meters: m });
          }
        }
      }
      if (mine) mine.sort((a, b) => a.meters - b.meters);
    }
    // 安全阀：只留"最近的 N 个"，且要求**双方都留**（保证边对称、度数有界）
    const kept = new Map();        // stationId -> Set(neighborId)
    for (const [sid, mine] of cand) {
      const top = limit > 0 ? mine.slice(0, limit) : mine;
      const set = new Set();
      for (const e of top) set.add(e.to);
      kept.set(sid, set);
    }
    let links = 0;
    let pairs = 0;
    let pruned = 0;
    // 第二遍：两边都保留才成边，两个方向各加一条。adj 里每个站自己的邻站表按**距离升序**
    // （第一遍已经排过序），所以同代价的行程 Tie-break 是确定的（以前是网格扫描顺序，
    // 同样确定但不好预测；实测默认数据集上的边集与老实现完全一致，见 tmp-radius-probe）
    for (const [sid, mine] of cand) {
      const mineTop = kept.get(sid) || new Set();
      let a = null;
      for (const e of mine) {
        const other = kept.get(e.to);
        const mutual = mineTop.has(e.to) && !!other && other.has(sid);
        if (!mutual) { if (sid < e.to) pruned += 1; continue; }
        if (sid < e.to) pairs += 1;
        if (!a) { a = []; adj.set(sid, a); }
        a.push({ to: e.to, meters: e.meters });
        links += 1;
      }
    }
    return { adj, links, pairs, pruned, cells: grid.size, cell, maxRadiusM: maxRadius };
  }

  /** 记录某个车站的最优标签（Dijkstra 的"到这一站最便宜"） */
  _relaxStation(at, stationId, key, cost) {
    const cur = at.get(stationId);
    if (!cur || cost < cur.cost - 1e-9) at.set(stationId, { key, cost });
  }

  /**
   * 从某个车站出发的最优行程搜索（Dijkstra，状态 = 车站 × 已坐段数 × 已走段数）。
   * 结果按起点缓存（LRU 上限 24 个起点 / 40 万个标签，防止几千个站把内存撑爆）。
   * deadlineMs 给出时，搜索到点就停（truncated = true）—— 大路网上宁可退回"同一条线"的
   * 兜底判据，也不能让一次 O/D 表构建卡住整个服务端；被截断的结果不进缓存。
   * 返回 { originId, at:Map(stationId->{key,cost}), prev:Map(labelKey->{from,step}), truncated, ms }
   */
  _searchItineraries(originId, deadlineMs) {
    const oid = Number(originId);
    const hit = this._itinSearches.get(oid);
    if (hit) return hit;
    const g = this._ensureItineraryGraph();
    const tp = this._tp;
    const t0 = Date.now();
    const deadline = Number.isFinite(deadlineMs) ? deadlineMs : null;
    const maxLegs = tp.maxTransfers + 1;
    const best = new Map();      // 标签键 "车站|坐了几段|走了几段" -> 估算秒数
    const prev = new Map();      // 标签键 -> { from, step }
    const at = new Map();        // 车站 -> { key, cost }
    const heap = new MinHeap();
    const startKey = `${oid}|0|0`;
    // 起点站自己有线路时，第一段不许是步行（见 _planFor / 类头说明的"步行接驳"规则）：
    // 乘客是从这个站出发的，站上有车就直接坐车；步行只用来把**没有线路的车站**接进网络，
    // 或者在中途换乘（OSI）。否则"把车站覆盖范围内的别的线也接进来"会把这条线自己的
    // 客流稀释掉（加一条步行边就等于悄悄改掉已有线路的客流，这在 NR 里不会发生）。
    const originServed = g.linesOf.has(oid);
    best.set(startKey, 0);
    prev.set(startKey, null);
    this._relaxStation(at, oid, startKey, 0);
    heap.push(startKey, 0);
    let popped = 0;
    let truncated = false;
    while (heap.size) {
      const top = heap.pop();
      const k = top.key;
      const cost = top.cost;
      if (best.get(k) !== cost) continue;                    // 过期标签
      if (++popped > tp.maxStates) { truncated = true; break; }
      // 到点就停（每 512 个标签看一次表，几乎不影响速度）
      if (deadline && (popped & 511) === 0 && Date.now() > deadline) { truncated = true; break; }
      const parts = k.split('|');
      const sid = Number(parts[0]);
      const legs = Number(parts[1]);
      const walks = Number(parts[2]);
      // ①步行接驳：覆盖范围内互相够得着的邻站（见 transferWalkRadiusM），1 m/s（wiki: Station 原文）
      //   起点站自己有线路时，第一段不许是步行（否则会把这条线自己的客流稀释掉）
      const mayWalkFirst = !(legs === 0 && walks === 0 && originServed);
      if (walks < tp.maxWalkLegs && mayWalkFirst) {
        const nb = g.walk.adj.get(sid);
        if (nb) {
          for (const w of nb) {
            const sec = w.meters / tp.walkSpeed + tp.walkPenalty;
            const nc = cost + sec;
            if (nc > tp.maxJourneySec) continue;
            const nk = `${w.to}|${legs}|${walks + 1}`;
            if ((best.get(nk) || Infinity) <= nc) continue;
            best.set(nk, nc);
            prev.set(nk, { from: k, step: { type: 'walk', from: sid, to: w.to, meters: Math.round(w.meters), sec: Math.round(sec) } });
            heap.push(nk, nc);
            this._relaxStation(at, w.to, nk, nc);
          }
        }
      }
      // ②坐一段车：在本站上某条线，坐到这条线上的任意另一站
      if (legs < maxLegs) {
        const lines = g.linesOf.get(sid);
        if (lines) {
          for (const lo of lines) {
            const entry = lo.entry;
            const from = entry.cum[lo.idx];
            for (let i = 0; i < entry.stops.length; i++) {
              if (i === lo.idx) continue;
              const to = entry.stops[i];
              const m = Math.abs(entry.cum[i] - from);
              const midStops = Math.abs(i - lo.idx) - 1;
              const sec = m / tp.rideSpeed + Math.max(0, midStops) * 20;
              const nc = cost + tp.boardPenalty + sec;
              if (nc > tp.maxJourneySec) continue;
              const nk = `${to}|${legs + 1}|${walks}`;
              if ((best.get(nk) || Infinity) <= nc) continue;
              best.set(nk, nc);
              prev.set(nk, {
                from: k,
                step: {
                  type: 'ride', lineId: entry.lineId, lineName: entry.name,
                  from: sid, to, meters: Math.round(m), sec: Math.round(sec),
                },
              });
              heap.push(nk, nc);
              this._relaxStation(at, to, nk, nc);
            }
          }
        }
      }
    }
    const search = {
      originId: oid, at, prev, best, plans: new Map(),
      truncated, popped, ms: Date.now() - t0, day: this.day,
    };
    // 被截断的搜索结果不进缓存（不然下一次调用会拿到一份"只到一半"的行程表）
    if (truncated) return search;
    this._itinSearches.set(oid, search);
    this._itinSearchStates += best.size;
    // LRU：起点太多就丢最老的（行程结果只是一张缓存，丢了重算即可）
    while (this._itinSearches.size > 24 || this._itinSearchStates > 400000) {
      const oldest = this._itinSearches.keys().next().value;
      if (oldest === oid) break;                              // 别把自己刚放进去的就丢了
      const old = this._itinSearches.get(oldest);
      this._itinSearches.delete(oldest);
      this._itinSearchStates -= old ? old.best.size : 0;
    }
    return search;
  }

  /** 由一个搜索结果还原出到 destId 的行程（没有能走的行程就是 null，会被缓存） */
  _planFor(search, destId, originId) {
    const d = Number(destId);
    const o = Number(originId == null ? search.originId : originId);
    if (!Number.isFinite(d) || d === o) return null;
    const cached = search.plans.get(d);
    if (cached !== undefined) return cached;
    const at = search.at.get(d);
    let plan = null;
    if (at && at.key) {
      const steps = [];
      let k = at.key;
      let guard = 0;
      while (k && guard++ < 64) {
        const p = search.prev.get(k);
        if (!p) break;
        steps.push(p.step);
        k = p.from;
      }
      steps.reverse();
      if (steps.length) plan = this._makePlan(o, d, steps, at.cost);
    }
    search.plans.set(d, plan);
    return plan;
  }

  /** 把一段段的 step 包成行程对象（顺便算出换乘次数 / 步行米数 / 估算时间 / 第一段乘车） */
  _makePlan(originId, destId, steps, cost) {
    let rideLegs = 0;
    let walkLegs = 0;
    let rideMeters = 0;
    let walkMeters = 0;
    let sec = 0;
    let id = originId + '>';
    for (const s of steps) {
      sec += s.sec || 0;
      if (s.type === 'ride') {
        rideLegs += 1;
        rideMeters += s.meters || 0;
        id += `r${s.lineId}@${s.from}-${s.to}>`;
      } else {
        walkLegs += 1;
        walkMeters += s.meters || 0;
        id += `w${s.from}-${s.to}>`;
      }
    }
    if (!rideLegs) return null;      // 纯步行不算行程（OSI 只是接驳手段）
    id += destId;
    const firstLeg = steps.find((s) => s.type === 'ride') || null;
    return {
      id, originId, destId, steps,
      transfers: Math.max(0, rideLegs - 1),
      rideLegs, walkLegs,
      rideMeters: Math.round(rideMeters),
      walkMeters: Math.round(walkMeters),
      sec: Math.round(sec),
      cost: Math.round((Number(cost) || sec) * 10) / 10,
      firstLeg,
    };
  }

  /** 某个 O/D 对的最优行程（调试 / 测试用；走不到就是 null） */
  _itinerary(originId, destId) {
    return this._planFor(this._searchItineraries(Number(originId)), Number(destId), Number(originId));
  }

  /**
   * 兜底行程：只用"同一条线路同时停这两站"的老判据（本作实现换乘之前的判据）。
   * 只在行程搜索超出时间预算（超大的路网）时用来兜底，保证 O/D 表一定算得出来，
   * 而不是把整个客流搞没。
   */
  _sharedLinePlan(originId, destId) {
    const g = this._ensureItineraryGraph();
    const lines = g.linesOf.get(Number(originId));
    if (!lines) return null;
    for (const lo of lines) {
      const idx = lo.entry.stops.indexOf(Number(destId));
      if (idx < 0) continue;
      const m = Math.round(Math.abs(lo.entry.cum[idx] - lo.entry.cum[lo.idx]));
      const sec = Math.round(m / this._tp.rideSpeed + Math.max(0, Math.abs(idx - lo.idx) - 1) * 20);
      const steps = [{
        type: 'ride', lineId: lo.entry.lineId, lineName: lo.entry.name,
        from: Number(originId), to: Number(destId), meters: m, sec,
      }];
      return this._makePlan(Number(originId), Number(destId), steps, sec + this._tp.boardPenalty);
    }
    return null;
  }

  /* ───────────────────────── O/D 需求表（NIMBY Rails 的 demand tile） ─────────────────────────
   *
   * 这是"人口 → 乘客"的第二步，完全照 NR 的 destination picking 来做（出处见 population.js 顶部）：
   *
   *   1) 每个车站每天产生 dailyTrips 个乘客（= 覆盖人口 × 活跃度 × 出行率），他们就是这个站的
   *      **origin（起点）**乘客。覆盖人口为 0 的站不产生乘客，也不会被别人选成目的地。
   *   2) 乘客生成时先被分到一个**距离档**（NR 的 Pax 页原文："Pax are allocated immediately to
   *      one of the three distance categories"），档位由 PAX.bandMix 决定（NR 的 spawn rate 是
   *      "每一档各有一个"，wiki 没公开具体比例）；然后**只在自己那一档的直线距离范围里**
   *      挑目的站（Destination 页原文：0~15 km / 15~100 km / >100 km，用直线距离算）。
   *      odBandCandidates=false 就退回 1.12 之后的连续距离需求曲线（Distance_category 页在
   *      1.12 标了 "Deleted feature"：硬切分会让"全城网络里唯一一个 100 km 外的站"吃掉所有长途）。
   *      odBandFallback=true 时，某一档一个候选都没有就把这一档的份额补到有候选的档上。
   *   3) 每个候选目的车站给一个权重（NR 原文）：
   *        权重 = 目的站覆盖人口（非线性 + 有"默认水平"）× 停靠线路条数（近似线性）× 距离需求曲线
   *   4) 按权重把该档的乘客分给各候选站（等价于 NR 的"按权重随机抽一个目的地"，
   *      我们只需要总量，所以直接算期望值），于是得到 O→D 的人/日。
   *   5) **只有走得掉的才算数**：这条 O/D 必须在**行程图**里可达（_itinerary：最多换乘 3 次，
   *      允许站间步行接驳 —— 能走多远由两站的覆盖范围决定，见 transferWalkRadiusM），
   *      走不掉的乘客不排队（NR 里他们会挤在站厅；本作没有站厅）。
   *      这一步就是 NR 1.12 说的"从该站可达的人口"——它决定了这一站真正的客流。
   *   6) 每个乘客用**最优行程**（dominating trip）：行程第一段乘车的线路就是他要去排队的线路桶；
   *      行程里有换乘/步行时，乘客到换乘站下车、重新排下一段的队（见 _alightAt / _dispatchWalker）。
   *      起点站自己没线路、但覆盖范围内有邻站有线路时，第一段是步行：这批乘客记在 byOriginWalk 里，
   *      到点先"走出去"（站厅里带计时器，见 walkers），走完再排第一段车的队。
   *
   * 结果结构：
   *   stations : Map(stationId -> { id, name, kind, lat, lon, catchmentM, pop, activity, coverage, demand, dailyTrips, lines:[lineId] })
   *   byLine   : Map(lineId -> Map(stationId -> { local, regional, long, total, destMix:[{stationId, people, band, plan}] }))
   *              （local/regional/long 是按**乘客所属的距离档**累加，用来选时段曲线）
   *              —— 这条线在这个站**每天要拉走多少人**，以及他们分别去哪（按目的地下车用）
   *   byOriginWalk: Map(originId -> { bands, total, entries:[{destId, people, band, plan}] })
   *              —— 起点站自己没线路、先步行去邻站坐车的乘客（OSI 接驳）
   *   byStation: Map(stationId -> { spawn, served, reach, dests:[...] })
   *   stats    : { origins, pairs, spawn, served, reach, dropped, byBand, itineraries, ms }
   *
   * 缓存：键 = 人口网格版本 + 游戏日（这两样是"人口变了"）；车站 / 线路的改动则由
   * create/update/delete 主动调 _dropOdCache() 作废（行程图与行程搜索结果一起作废）——
   * **车站的覆盖范围（catchmentM）也算"车站变了"**：换乘半径是它算出来的，改一个站的
   * 覆盖范围会连带改掉它所有邻站的步行边（updateStation → _dropDemandCache → _dropOdCache；
   * 撤销/重做直接改 stations 表，_applyTransitSteps 里同样要作废，见那里的说明）。
   * 不在热路径上遍历车站与线路，这样每帧广播、每一小步模拟都只比较一个短字符串。
   * 北京这种规模（几百个站）一次几十毫秒，且只在"改建筑 / 加线路 / 挪车站 / 跨天"时算一次。
   */
  _odKey() {
    return `${this._demandKey()}|${this.config.tripRatePerDay}`;
  }

  _dropOdCache() {
    this._od = null;
    this._odKeyValue = null;
    this._dropItineraryCache();     // 行程图（线路-站点图 + 步行接驳边）跟着一起作废
    // 指纹也一起清掉：缓存已经没了，"下一次建表时重新记一个指纹"才是对的
    // （留着旧指纹会让"合法作废"被下一次 tick 的比对误判成"有人忘了作废"）
    this._cacheStampValue = null;
  }

  /* ═══════════ 缓存指纹自检（"新建车站立刻就有乘客"的兜底保险） ═══════════
   *
   * 用户投诉 #1 的根因是"O/D 需求表 / 行程图被缓存住，而某个改动路径忘了作废它"：
   * 新建的车站要等到跨天（_odKey 里的日期变了）才进表，于是"车站建好了但一个乘客都不来"。
   * 每个 op 里补一次 _dropOdCache() 是**治本**（createStation / updateStation / line.* /
   * import / 撤销 都已经补上了），但它靠"以后每次加新路径都记得补" —— 不可靠。
   * 这里再加一道便宜的保险（用户要求的口径）：
   *   每 tick 把"当前世界的版本指纹"与"缓存建起来时记下的那个指纹"比一次，
   *   对不上就**立刻**重建（同一个 tick 内），并记进 odStats().staleRecomputes + 打一行日志。
   * 这样"谁忘了作废"最多只影响一个 tick，而且**看得见**，不会安静地表现成"没人来坐车"。
   * ════════════════════════════════════════════════════════════════════════ */

  /**
   * 当前世界的**版本指纹**（32 位整数，FNV-1a）。参与的东西就是"O/D 表与行程图的全部输入"：
   *   ① 车站集合（id）+ 每个站的覆盖范围 catchment_m、类型 kind、吸附节点 node_id、坐标
   *      —— 覆盖半径决定站间步行接驳（换乘）半径，所以它一变，邻站的步行边也要跟着变；
   *   ② 每条线路的站序 stops + 类型 kind + 归属 company_id / owner
   *      —— 归属变了候车队伍要搬到新公司（queueCompanyId），站序/类型变了 byLine 要重算；
   *   ③ 人口网格版本 population.version（改建筑就变）+ 游戏日（时段曲线 / 周末系数）。
   * 两条**窄** SELECT（车站 6 列 / 线路 5 列，都不是 SELECT *）+ 一次哈希：几百个站实测几十微秒。
   * 关掉：config.transit.staleCacheCheck = false（或 _stampOn = false）。
   */
  _cacheStamp() {
    let h = 2166136261;
    const mix = (n) => {
      const x = Math.imul(n | 0, 0x01000193) >>> 0;
      h = (Math.imul(h ^ x, 16777619)) >>> 0;
    };
    const mixStr = (s) => {
      const str = s == null ? '' : String(s);
      let x = 2166136261;
      for (let i = 0; i < str.length; i++) x = (Math.imul(x ^ str.charCodeAt(i), 16777619)) >>> 0;
      mix(x);
    };
    for (const s of this._st.stampStations.all()) {
      mix(s.id);
      mix(Math.round(Number(s.catchment_m) || 0));
      mixStr(s.kind);
      mix(Number(s.node_id) || 0);
      mix(Math.round(Number(s.lat) * 1e6) || 0);
      mix(Math.round(Number(s.lon) * 1e6) || 0);
    }
    for (const l of this._st.stampLines.all()) {
      mix(l.id);
      mixStr(l.kind);
      mixStr(l.stops);
      mix(Number(l.company_id) || 0);
      mixStr(l.owner);
    }
    mix(this.day);
    const pop = this.population;
    mix(pop && pop.version != null ? Number(pop.version) : 0);
    return h >>> 0;
  }

  /**
   * 每 tick 一次：指纹与"缓存建起来时那个指纹"比一次，对不上就立刻重建。
   * 返回 true = 这一次真的重建了（odStats().staleRecomputes 会 +1）。
   */
  _checkStaleCaches() {
    if (this._stampOn === false) return false;
    if (this.config.staleCacheCheck === false) return false;
    let stamp = null;
    try { stamp = this._cacheStamp(); } catch { this._stampOn = false; return false; }
    const built = this._cacheStampValue;
    if (built == null) { this._cacheStampValue = stamp; return false; }   // 还没有缓存：先记下来
    this._staleChecks = (this._staleChecks || 0) + 1;
    if (stamp === built) return false;
    return this._repairStaleCaches(stamp, built);
  }

  /**
   * 指纹对不上 → **同一个 tick 内**按新口径重建（用户口径："最多一个游戏分钟之内"见效，
   * 实际上这一步是立刻的）。顺序很要紧：
   *   ① 车站需求缓存 + O/D 表 + 行程图全部作废（覆盖半径一变，站间步行接驳半径也跟着变）；
   *   ② 线路缓存里"从车站行抄过来的"那几项（名称/坐标/覆盖半径）刷一遍 ——
   *      改车站不会自动重建路径（贵的那部分），但停站明细不能一直显示旧半径；
   *   ③ 线路归属变了要**把候车队伍搬到新公司**（与 line.transfer 同一个口径：不搬的话
   *      那些人在旧公司名下永远等不到车）；
   *   ④ 立刻建一次 O/D 表（不等下一次访问），并让每条线的 boardPerDay / destMix 跟上；
   *   ⑤ 记数 + 打日志（谁忘了作废缓存，在日志和 odStats() 里都看得见）。
   */
  _repairStaleCaches(stamp, built) {
    this._staleRecomputes = (this._staleRecomputes || 0) + 1;
    const t0 = Date.now();
    // ①+② 车站需求缓存 + O/D 表 + 行程图全部作废，并把线路缓存里的停站明细刷成新的车站行
    const refreshed = this._dropDemandCache();
    const moved = this._syncLineCompanies();              // ③ 归属变了：候车队伍搬到新公司
    this._cacheStampValue = stamp;                 // 缓存这一轮就是按这个指纹建的
    this._ensureOdDemand();                        // ④ 立刻重建（不等下一次访问）
    for (const cache of this.lineCache.values()) this._refreshLineDemand(cache);
    /**
     * ⑤ 站序被"绕过作废"地改过时，lineCache 里那份**停靠站成员**也必须重建：
     *    上面 ①–④ 只刷了停站明细（名称/坐标/覆盖半径）与 O/D 表，没有重建 cache.stops / cache.path。
     *    于是会出现一种很难查的错配：O/D 表已经按新站序（含新站）算需求了，lineCache.stops 还是旧的 ——
     *      · 车永远不会停那个新站 → 用户投诉的"新建车站不能直接开始产生乘客"（新站 0 人）；
     *      · 旧站序里的站还会继续挂着这条线的候车队伍（候车守卫是拿 lineCache 判"这条线停不停这一站"的），
     *        也就是用户报的那类"与这条线完全无关的站台上有人在等这条线"。
     *    只重建"站序与库不一致"的那几条线：这整段只在真的有人绕过作废接口时才跑（罕见事件），
     *    把同步重活限制在真正出问题的那几条线上。
     *    最后统一清扫一次候车台账（与 updateLine / deleteLine / _rebuildAllLinePaths 同一个口径）。
     */
    let rebuilt = 0;
    for (const cache of this.lineCache.values()) {
      const row = this._st.line.get(cache.lineId);
      if (!row) continue;
      const want = this._parseStops(row.stops);
      const have = (cache.stops || []).map((s) => Number(s.stationId));
      if (want.length !== have.length || want.some((id, i) => Number(id) !== have[i])) {
        this.rebuildPath(cache.lineId);
        rebuilt += 1;
      }
    }
    this._sweepStationQueues();
    console.log(`[od] 缓存指纹对不上（车站/线路/归属/人口/日期被绕过作废地改过）：`
      + `立刻重建 O/D 表与行程图（第 ${this._staleRecomputes} 次，`
      + `刷新停站明细 ${refreshed} 条、搬迁候车队伍 ${moved} 人、重建站序不一致的线路 ${rebuilt} 条，`
      + `${Date.now() - t0} ms，指纹 ${built} → ${stamp}）`);
    return true;
  }

  /**
   * 线路缓存里那几项"从车站行抄过来的"信息跟着车站行刷新（名称 / 坐标 / 覆盖半径）。
   * 两个调用点：① _dropDemandCache（车站被改 / 被删 / 新建，传 onlyStationId 只刷那一站）；
   * ② 指纹自检认为"车站被动过"时整表刷一遍。
   * 不重建路径：路径几何是贵的那部分，改车站名的代价不该是重算整条线路。
   */
  _refreshStopsFromStations(onlyStationId) {
    const only = onlyStationId == null ? null : Number(onlyStationId);
    let n = 0;
    for (const cache of this.lineCache.values()) {
      if (!cache.stops || !cache.stops.length) continue;
      for (const st of cache.stops) {
        if (only != null && Number(st.stationId) !== only) continue;
        const row = this._st.station.get(st.stationId);
        if (!row) continue;
        if (st.name === row.name && st.lat === row.lat && st.lon === row.lon
          && st.catchmentM === row.catchment_m) continue;
        st.name = row.name;
        st.lat = row.lat;
        st.lon = row.lon;
        st.catchmentM = row.catchment_m;
        n += 1;
      }
    }
    return n;
  }

  /**
   * 一条线路的候车队伍该挂在哪个公司名下（**唯一口径**：rebuildPath 与指纹自检都用它）。
   * 优先线路所属公司；老数据（company_id 为空）退回车主的第一家公司。
   */
  _queueCompanyIdFor(line) {
    if (!line) return null;
    if (line.company_id != null) return line.company_id;
    if (!line.owner) return null;
    const own = this.db.prepare('SELECT id FROM companies WHERE owner = ? ORDER BY id LIMIT 1').get(line.owner);
    return own ? own.id : null;
  }

  /**
   * 线路归属被"绕过 line.transfer"地改掉（直接改库 / 将来新加的 op）时，把候车队伍搬到新公司名下。
   * 返回搬了多少人。归属没变的线路只是把缓存里的 companyId / companyOwner 对齐。
   */
  _syncLineCompanies() {
    let moved = 0;
    for (const cache of this.lineCache.values()) {
      const row = this._st.line.get(cache.lineId);
      if (!row) continue;
      const fromKey = this._companyKey(cache.queueCompanyId, cache.companyOwner);
      const wantKey = this._companyKey(row.company_id, row.owner);
      if (fromKey !== wantKey) {
        moved += this._moveLineQueueCompany(cache.lineId, fromKey, row.company_id, row.owner);
        cache.queueCompanyId = this._queueCompanyIdFor(row);
      }
      cache.companyId = row.company_id;
      cache.companyOwner = row.owner;
    }
    return moved;
  }

  /** 取 O/D 需求表（惰性 + 缓存），见上面的大段说明 */
  _ensureOdDemand() {
    const key = this._odKey();
    if (this._od && this._odKeyValue === key) return this._od;
    const t0 = Date.now();
    const tp = this._tp;
    const maxStations = Math.max(2, Number(this.config.odMaxStations) || 4000);
    const minPeople = Math.max(0, Number(this.config.odMinPeople) || 0.02);
    // 只在"可达"的车站里挑目的地（NR 1.12 的写法，默认开）；关掉 = 1.11 的写法（档内全候选）
    const onlyReachable = this.config.odOnlyReachable !== false;
    const all = this._st.allStations.all();
    const rows = all.length > maxStations ? all.slice(0, maxStations) : all;
    // 行程图（线路-站点图 + 步行接驳边）与"每一站停哪些线"都从它来，保证只有一处口径
    const graph = this._ensureItineraryGraph();

    // 站点 + 需求
    const stations = new Map();
    for (const s of rows) {
      const d = this.stationDemandOf(s);
      stations.set(s.id, {
        id: s.id, name: s.name, kind: s.kind, lat: s.lat, lon: s.lon,
        catchmentM: s.catchment_m, dailyTrips: d.dailyTrips, demand: d.demand,
        pop: d.pop, activity: d.activity, coverage: d.coverage, density: d.density,
        lines: (graph.linesOf.get(Number(s.id)) || []).map((x) => x.lineId),
      });
    }

    const byLine = new Map();
    const byOriginWalk = new Map();
    const byStation = new Map();
    const list = [...stations.values()];
    let pairs = 0;
    let spawnTotal = 0;
    let servedTotal = 0;
    let droppedTotal = 0;
    const bandPeople = { local: 0, regional: 0, long: 0 };
    const destsServedByBand = { local: 0, regional: 0, long: 0 };
    const plans = { searched: 0, found: 0, direct: 0, transfers1: 0, transfers2: 0, transfers3: 0, walkLegs: 0, walkFirst: 0, truncated: 0, budgetFallback: 0 };

    for (const o of list) {
      spawnTotal += o.dailyTrips;
      if (!(o.dailyTrips > 0)) { byStation.set(o.id, { spawn: 0, served: 0, reach: 0, dests: [] }); continue; }
      let budgetHit = Date.now() - t0 > tp.budgetMs;
      if (budgetHit) plans.budgetFallback += 1;
      // 候选目的站 + 权重，按"乘客所属距离档"分组
      //   候选范围 = 覆盖人口 > 0、且自己去得了 / 步行接驳范围内有有线路的邻站（NR 原文：
      //   覆盖为 0 的站"永不会被选为 origin 或 destination"）
      const byBand = { local: [], regional: [], long: [] };
      for (const d of list) {
        if (d.id === o.id) continue;
        if (!(d.coverage > 0)) continue;
        if (!d.lines.length && !graph.walkServed.has(Number(d.id))) continue;
        const meters = metersBetween(o.lat, o.lon, d.lat, d.lon);
        const band = bandOfMeters(meters);
        const w = destinationWeightOf(d.coverage, d.lines.length, meters);
        if (!(w > 0)) continue;
        byBand[band].push({ st: d, w, meters, band });
      }
      const available = PAX_BANDS.filter((b) => byBand[b].length);
      for (const b of available) destsServedByBand[b] += byBand[b].length;
      const dests = [];
      let served = 0;
      const touchedLines = new Set();
      // 一次搜索搞定"从这一站能走到哪些站、怎么走"；超时 / 状态数超限就退回"同一条线"的兜底判据
      // （超大路网上宁可少算换乘，也不能让一次 O/D 表构建卡住服务端的模拟线程）
      let search = null;
      if (!budgetHit) {
        search = this._searchItineraries(o.id, t0 + tp.budgetMs);
        if (search.truncated) {
          plans.truncated += 1;
          plans.budgetFallback += 1;
          search = null;
        } else {
          plans.searched += 1;
        }
      }
      const planOf = (destId) => (search ? this._planFor(search, destId, o.id) : this._sharedLinePlan(o.id, destId));
      // 先把"走得到 / 走不到"算清楚：
      //   odOnlyReachable=true （NR 1.12 的写法）：走不到的目的站**不进候选池**，
      //     于是这一站的乘客只在能到的站里分（这就是 NR 说的"从该站可达的人口"）。
      //   odOnlyReachable=false（1.11 的写法）：走不到的目的站照样进池子、照样吃掉一份乘客，
      //     那部分乘客就白等（计进 dropped）—— 两种口径的差别一眼可见。
      for (const band of PAX_BANDS) {
        const cands = byBand[band];
        if (!cands.length) continue;
        const keep = [];
        for (const c of cands) {
          c.plan = planOf(c.st.id);
          if (!c.plan && onlyReachable) continue;
          keep.push(c);
        }
        byBand[band] = keep;
      }
      // 距离档的乘客份额：按"真的有候选（且走得到）的档"归一化。
      //   odBandFallback=true （默认）：没有候选的那几档的份额按比例补到有候选的档上，
      //     三档份额之和仍是 1 —— 乘客总量守恒，不会因为"本地没有目的地"就凭空少一批人。
      //   odBandFallback=false：没有候选的档就按原样少掉（那部分乘客"哪儿也去不了"），
      //     下面会把没分出去的份额计进 dropped（否则这批人会既不算走掉、也不算走不掉）。
      const shares = tp.bandCandidates
        ? bandSharesOf(PAX_BANDS.filter((b) => byBand[b].length), tp.bandFallback)
        : null;   // null = 不按档切分（1.12 的连续曲线：全部候选一起参与）
      if (shares) {
        let allocated = 0;
        for (const b of PAX_BANDS) allocated += shares[b] || 0;
        if (allocated < 1 - 1e-9) droppedTotal += o.dailyTrips * (1 - allocated);
      }
      let poolAll = 0;
      for (const b of PAX_BANDS) for (const c of byBand[b]) poolAll += c.w;
      if (!(poolAll > 0)) { droppedTotal += o.dailyTrips; byStation.set(o.id, { spawn: Math.round(o.dailyTrips), served: 0, reach: 0, dests: [] }); continue; }
      for (const band of PAX_BANDS) {
        const cands = byBand[band];
        if (!cands.length) continue;
        // 该档的乘客份额：按档切分时用 bandMix；不切分时用"连续曲线"（权重里已经含了距离衰减）
        let bandPax = o.dailyTrips;
        if (shares) {
          bandPax = o.dailyTrips * (shares[band] || 0);
          if (!(bandPax > 0)) continue;
        }
        let pool = 0;
        for (const c of cands) pool += c.w;
        if (!(pool > 0)) continue;
        for (const c of cands) {
          const pax = shares ? bandPax * (c.w / pool) : (o.dailyTrips * c.w) / poolAll;
          if (pax < minPeople) { droppedTotal += pax; continue; }
          const plan = c.plan;
          if (!plan) { droppedTotal += pax; continue; }         // 走不到：这批乘客不走（1.11 口径的"白等"）
          plans.found += 1;
          if (plan.transfers === 0) plans.direct += 1;
          else if (plan.transfers === 1) plans.transfers1 += 1;
          else if (plan.transfers === 2) plans.transfers2 += 1;
          else plans.transfers3 += 1;
          if (plan.walkLegs > 0) plans.walkLegs += 1;
          pairs += 1;
          served += pax;
          bandPeople[band] += pax;
          const first = plan.steps[0];
          if (first.type === 'ride') {
            // 起点站自己就有线路：乘客就在这一站排这条线的队
            touchedLines.add(first.lineId);
            let m = byLine.get(first.lineId);
            if (!m) { m = new Map(); byLine.set(first.lineId, m); }
            let entry = m.get(o.id);
            if (!entry) { entry = { local: 0, regional: 0, long: 0, total: 0, destMix: [] }; m.set(o.id, entry); }
            entry[band] += pax;
            entry.total += pax;
            entry.destMix.push({
              stationId: c.st.id, name: c.st.name, band, meters: Math.round(c.meters), people: pax,
              plan, transfers: plan.transfers, walkMeters: plan.walkMeters,
            });
          } else {
            // 起点站自己没线路：先走覆盖范围内的邻站（OSI），走完再排第一段车的队
            plans.walkFirst += 1;
            const rideLeg = plan.firstLeg;
            let wo = byOriginWalk.get(o.id);
            if (!wo) { wo = { bands: { local: 0, regional: 0, long: 0 }, total: 0, entries: [], originName: o.name }; byOriginWalk.set(o.id, wo); }
            wo.bands[band] += pax;
            wo.total += pax;
            wo.entries.push({
              destId: c.st.id, name: c.st.name, people: pax, band, plan,
              walkMeters: plan.steps[0].meters, walkSec: plan.steps[0].sec,
              // 上车点是"第一段乘车"的那一站（不是起点站：起点站的乘客是先走出去的）
              boardStationId: rideLeg ? rideLeg.from : o.id,
            });
          }
          dests.push({
            stationId: c.st.id, name: c.st.name, band, meters: Math.round(c.meters),
            people: Math.round(pax * 10) / 10, lines: c.st.lines.length,
            transfers: plan.transfers, walkMeters: plan.walkMeters,
            firstLineId: first.lineId, firstLineName: first.lineName || null,
            boardStationId: first.type === 'ride' ? o.id : first.from,
            sec: plan.sec,
          });
        }
      }
      dests.sort((a, b) => b.people - a.people);
      // 每个（线路 × 车站）只留最忙的前几条目的地：上车时按这个比例给乘客打"目的站"标签
      const mixCap = Math.max(1, Math.round(Number(this.config.odDestMix) || 4));
      for (const lid of touchedLines) {
        const m = byLine.get(lid);
        const e = m ? m.get(o.id) : null;
        if (!e) continue;
        e.destMix.sort((a, b) => b.people - a.people);
        if (e.destMix.length > mixCap) {
          const keep = e.destMix.slice(0, mixCap);
          let rest = 0;
          for (const d of e.destMix.slice(mixCap)) rest += d.people;
          // 零头**不再并进最后一个目的地**（那会让乘客下错站，换乘时更会走错路线）：单独作为
          // "去向未知"的一批，他们照样上车，到目的站附近按统计口径下车，只是不再换乘。
          if (rest > 0) keep.push({ stationId: null, name: '去向未知', people: rest, band: 'local', plan: null, unknown: true });
          e.destMix = keep;
        }
      }
      servedTotal += served;
      byStation.set(o.id, {
        spawn: Math.round(o.dailyTrips),
        served: Math.round(served),
        reach: o.dailyTrips > 0 ? Math.round((served / o.dailyTrips) * 1000) / 1000 : 0,
        dests: dests.slice(0, 12),
      });
    }
    this._od = {
      key,
      serial: (this._odSerial = (this._odSerial || 0) + 1),   // 每次重建都换一个序号（见 _refreshLineDemand）
      builtAt: Date.now(),
      day: this.day,
      stations,
      byLine,
      byOriginWalk,
      byStation,
      linesOf: graph.linesOf,
      graph: graph.stats,
      stats: {
        stations: list.length,
        truncated: all.length > maxStations,
        origins: list.filter((s) => s.dailyTrips > 0).length,
        pairs,
        spawn: Math.round(spawnTotal),
        served: Math.round(servedTotal),
        dropped: Math.round(droppedTotal),
        reach: spawnTotal > 0 ? Math.round((servedTotal / spawnTotal) * 1000) / 1000 : 0,
        byBand: { local: Math.round(bandPeople.local), regional: Math.round(bandPeople.regional), long: Math.round(bandPeople.long) },
        bandMaxM: { local: PAX.bandMaxM.local, regional: PAX.bandMaxM.regional, long: null },
        bandRanges: {
          local: bandRangeOf('local'), regional: bandRangeOf('regional'), long: bandRangeOf('long'),
        },
        bandMix: Object.assign({}, PAX.bandMix),
        bandCandidates: tp.bandCandidates,
        bandFallback: tp.bandFallback,
        bandDestinations: destsServedByBand,
        // 行程 / 换乘统计（这次 O/D 表里有多少 O/D 对、其中多少要换乘、多少带步行接驳）
        itineraries: plans,
        walkOrigins: byOriginWalk.size,
        walkOriginsPeople: Math.round([...byOriginWalk.values()].reduce((a, w) => a + w.total, 0)),
        transfers: {
          maxTransfers: tp.maxTransfers,
          maxWalkLegs: tp.maxWalkLegs,
          osiRadiusM: Math.round(tp.osiRadius),            // 下限（wiki 的 2.3 km）
          // 换乘半径 = 两站覆盖范围（见 transferWalkRadiusM）：这里把口径一起报出来
          transferRadiusRule: tp.rule,
          transferMaxRadiusM: Math.round(tp.maxRadius),
          transferSpreadFactor: tp.spreadFactor,
          transferNeighborLimit: tp.neighborLimit,
          walkPairs: this._itinGraph.walk.pairs,
          walkLinks: this._itinGraph.walk.links,
          walkPruned: this._itinGraph.walk.pruned,
          walkSpeedMps: tp.walkSpeed,
          transferPenaltySec: Math.round(tp.transferPenalty),
        },
        ms: Date.now() - t0,
      },
    };
    this._odKeyValue = key;
    // 记下"这张表是按哪个世界指纹建起来的"（见 _cacheStamp / _checkStaleCaches）：
    // 之后每 tick 比一次，对不上就说明有人绕过 _dropOdCache() 改了车站/线路/归属 → 立刻重建。
    this._cacheStampValue = this._cacheStamp();
    const s = this._od.stats;
    console.log(`[od] O/D 需求表：${s.origins} 个起点站 → ${s.pairs} 条 O/D 对`
      + `（日需求 ${s.spawn} 人，其中能走掉 ${s.served} 人 = ${(s.reach * 100).toFixed(1)}%，`
      + `档位 local/regional/long = ${s.byBand.local}/${s.byBand.regional}/${s.byBand.long}，`
      + `行程 直达 ${plans.direct} / 1 次换乘 ${plans.transfers1} / 2 次 ${plans.transfers2} / 3 次 ${plans.transfers3}`
      + ` / 含步行接驳 ${plans.walkLegs}，${s.ms} ms）`);
    if (byOriginWalk.size) {
      console.log(`[od] 起点站步行接驳：${byOriginWalk.size} 个站、${s.walkOriginsPeople} 人/日先步行去邻站坐车`);
    }
    return this._od;
  }

  /** 某个车站在 O/D 表里"每天要拉走多少人"（按线路拆） */
  odForStation(stationId) {
    const od = this._ensureOdDemand();
    return od.byStation.get(Number(stationId)) || { spawn: 0, served: 0, reach: 0, dests: [] };
  }

  /** O/D 表统计（给 /api/transit 的 stats 与调试用） */
  odStats() {
    const od = this._ensureOdDemand();
    return Object.assign({ builtAt: od.builtAt, day: od.day }, od.stats, {
      // 缓存指纹自检（见 _cacheStamp / _checkStaleCaches）：比了几次、真的重建了几次。
      // staleRecomputes > 0 说明有改动路径忘了调 _dropOdCache()（这次被自检兜住了）。
      staleChecks: this._staleChecks || 0,
      staleRecomputes: this._staleRecomputes || 0,
      cacheStamp: this._cacheStampValue == null ? null : this._cacheStampValue,
    });
  }

  /**
   * 把点到的位置吸附到路网上（#2：公交站**只要求"落在一条能跑车的道路上"**）。
   *
   *   公交（kind === 'bus'）：吸附到**最近的可通行机动车道**上 —— 也就是 highway=* 里除了
   *     footway / path / steps / cycleway / construction / proposed（以及 bridleway / corridor /
   *     raceway / platform / elevator 这些同样不是机动车道的等级）之外的**任何**道路，
   *     包括 service / track / living_street 这些底图上画成细黄线的小路（用户点名的那批）。
   *     判断用的是"点到路段的垂距"，所以一条几百米长的直路中间也能吸上去，不会因为节点稀疏
   *     就误判"附近没有路"。
   *     **没有最小距离门槛**：config.transit.busSnapMeters 默认 0 = 不限距离（多远都吸到最近的
   *     机动车道上）；想恢复"必须在 300 米内"的老行为就把它设成 300。
   *     真的吸不上（路网里一条可通行道路都没有）时，错误信息里会给出**实测距离**。
   *   铁路：railSnapMeters（默认 120 米）以内的最近钢轨（车站要贴在轨道上，不然车停不进来），
   *     失败也报实测距离。
   *
   * 返回 { ok:true, nodeId, wayId, lat, lon, distance } 或 { ok:false, error, code, distance }。
   */
  _snapStation(kind, lat, lon) {
    const bus = kind === 'bus';
    const cfgBus = Number(this.config.busSnapMeters);
    // #2：0 / 负数 / 没配 → 不限距离（只要世界上有可通行的道路就吸过去）
    const unlimited = bus && !(cfgBus > 0);
    const maxM = bus
      ? (unlimited ? Infinity : cfgBus)
      : Math.max(1, Number(this.config.railSnapMeters) || 120);
    const measureM = Math.max(Number.isFinite(maxM) ? maxM : 0, Number(this.config.snapMeasureMeters) || 20000);
    // P4（惰性建图）：吸附的目标是**点击坐标所在区域**的那张图 —— 见 graphAt 的说明
    const g = this.graphAt(kind, lat, lon);
    if (!g || !g.nearestNode) return { ok: true, nodeId: null, wayId: null, lat, lon, distance: null, noGraph: true };
    // 路网是空的（比如底图里还没有可通行的道路）：报出**实测距离**（#2 要求失败要说清多远）
    if (g.nodes && g.nodes.size === 0) {
      const m = bus ? this._measureNearestRoad(lat, lon) : null;
      return {
        ok: false, distance: m ? m.distance : null, code: 'NO_LINK',
        nearest: m,
        error: bus
          ? `这一带还没有可通行的机动车道（实测：到最近的 highway=${m ? m.highway : '—'} 约 `
            + `${m ? m.distance : '?'} 米）。公交站只能建在马路边：`
            + 'service / track / living_street 这类小路都算，人行道 / 自行车道 / 台阶 / 施工路段不算。'
          : `路网里还没有可跑车的轨道（railway=rail 之类），无法建站：请先用「画线」铺一段轨道`,
      };
    }

    if (bus && typeof g.nearestRoadPoint === 'function') {
      const near = g.nearestRoadPoint(lat, lon, maxM);
      if (near) {
        const wayId = near.wayId != null ? near.wayId : this._wayOfNode(near.nodeId);
        // 站牌立在马路上的投影点，nodeId 用这条路段较近的那一端（车必须停在路网节点上）
        return {
          ok: true, nodeId: near.nodeId, wayId, lat: near.lat, lon: near.lon,
          distance: Math.round(near.distance), roadside: true,
        };
      }
      // 没吸上：量一下到底有多远（先量路网里最近的机动车道，再退一步量底图里最近的 highway=*），
      // 写进错误信息 —— #2 要求"失败时要报告实测距离"，而且要说清最近的是哪种路
      const far = g.nearestRoadPoint(lat, lon, measureM);
      const m = this._measureNearestRoad(lat, lon);
      const d = far ? Math.round(far.distance) : (m ? m.distance : null);
      const kindTxt = m && m.highway ? `（最近的是 highway=${m.highway}，${m.distance} 米）` : '';
      return {
        ok: false, distance: d, code: 'NO_LINK', nearest: m,
        error: (unlimited
          ? `路网里找不到可通行的机动车道（实测：点击位置到最近的机动车道 ${d == null ? '超过 ' + measureM : d} 米）${kindTxt}。`
          : `公交站附近 ${maxM} 米内没有可通行的道路（实测：点击位置到最近的道路约 ${d == null ? '超过 ' + measureM : d} 米）${kindTxt}。`)
          + '公交站只能建在马路边：请点在能通行公交的道路（机动车道）上，而不是人行道 / 自行车道 / 台阶 / 施工路段。',
      };
    }

    const near = g.nearestNode(lat, lon, maxM);
    if (near) {
      return { ok: true, nodeId: near.nodeId, wayId: this._wayOfNode(near.nodeId), lat, lon, distance: Math.round(near.distance) };
    }
    const far = g.nearestNode(lat, lon, measureM);
    const d = far ? Math.round(far.distance) : null;
    return {
      ok: false, distance: d, code: 'NO_LINK',
      error: `车站必须建在轨道 ${maxM} 米以内（实测：点击位置到最近轨道约 ${d == null ? '超过 ' + measureM : d} 米）：`
        + '请先用「画线」铺一段 railway=rail 的轨道，或把车站放在已有铁路旁边',
    };
  }

  /** 某个路网节点属于哪条 way（车站记下来用于校验连通性；虚拟路口走图里的记录） */
  _wayOfNode(nodeId) {
    if (nodeId == null) return null;
    const g = this.bus && this.bus.nodes && this.bus.nodes.has(Number(nodeId)) ? this.bus : null;
    // #15：虚拟路口节点不在 OSM 里（id 是负数），它的 way 只能从图里问
    if (g && typeof g.wayOfNode === 'function') {
      const w = g.wayOfNode(nodeId);
      if (w != null) return w;
    }
    const w = this.db.prepare('SELECT way_id FROM way_nodes WHERE node_id = ? LIMIT 1').get(nodeId);
    return w ? w.way_id : null;
  }

  /**
   * #2 的失败诊断：量"点击位置到最近的 highway=* 有多远、那条是什么等级"。
   * 走 rtree（way_index）找附近的带 highway 标签的 way，再逐段算垂距 ——
   * 只在吸附失败的报错路径上调用，所以慢一点没关系，但答案必须是真的。
   * 返回 { distance, highway, wayId, name } 或 null。
   */
  _measureNearestRoad(lat, lon, maxMeters) {
    const R = Math.max(200, Math.min(20000, Number(maxMeters) || Number(this.config.snapMeasureMeters) || 20000));
    const dLat = R / 110574;
    const dLon = R / (111320 * Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180));
    let rows;
    try {
      rows = this.db.prepare(`SELECT w.id, w.tags FROM way_index i JOIN ways w ON w.id = i.id
        WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND w.deleted = 0
          AND w.tags LIKE '%"highway":%' LIMIT 400`).all(lon - dLon, lon + dLon, lat - dLat, lat + dLat);
    } catch {
      return null;
    }
    let best = null;
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const ky = 110574;
    for (const row of rows) {
      let tags = null;
      try { tags = row.tags ? JSON.parse(row.tags) : null; } catch { tags = null; }
      const hw = tags && tags.highway;
      if (!hw) continue;
      const ids = this.db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq LIMIT 400').all(row.id);
      let prev = null;
      for (const r of ids) {
        const n = this.db.prepare('SELECT lat, lon FROM nodes WHERE id = ? AND deleted = 0').get(r.node_id);
        if (!n) continue;
        if (prev) {
          // 点到线段的垂距（平面近似）
          const nx = (prev.lon - lon) * kx;
          const ny = (prev.lat - lat) * ky;
          const mx = (n.lon - lon) * kx;
          const my = (n.lat - lat) * ky;
          const dx = mx - nx;
          const dy = my - ny;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? -(nx * dx + ny * dy) / len2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const px = nx + dx * t;
          const py = ny + dy * t;
          const dist = Math.sqrt(px * px + py * py);
          if (!best || dist < best.distance) {
            best = {
              distance: Math.round(dist), highway: String(hw),
              wayId: row.id, name: tags.name || tags['name:zh'] || null,
              drivable: !!isDrivableHighway(hw),
            };
          }
        }
        prev = n;
      }
    }
    return best;
  }

  createStation(user, op) {
    const c = this.ensureCompany(user, op.companyId);
    const lat = Number(op.lat);
    const lon = Number(op.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new TransitError('坐标不合法');
    }
    const kind = STATION_KINDS[op.kind] ? op.kind : 'rail';
    const name = String(op.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32) || STATION_KINDS[kind].name;
    // 公交站是路边站牌，没有站台长度：不管客户端传什么，一律按 0 存（客户端按 hasPlatform 把那一栏藏起来）
    const platformM = kindHasPlatform(kind) ? Math.max(30, Math.min(600, Number(op.platformM) || 120)) : 0;
    const catchmentM = Math.max(200, Math.min(this.config.maxCatchment, Number(op.catchmentM) || (kind === 'bus' ? 450 : 700)));
    // 吸附到路网：公交站 300 米内的最近可通行道路（吸到路面上），铁路 120 米内的最近轨道
    const snap = this._snapStation(kind, lat, lon);
    if (!snap.ok) throw new TransitError(snap.error, snap.code || 'NO_LINK');
    const nodeId = snap.nodeId;
    const wayId = snap.wayId;
    const sLat = Number.isFinite(snap.lat) ? snap.lat : lat;
    const sLon = Number.isFinite(snap.lon) ? snap.lon : lon;
    const cost = kind === 'bus' ? Math.round(this.config.stationCost * 0.08) : this.config.stationCost;
    this._charge(c, cost, 'station');
    const res = this._st.insertStation.run(c.owner, c.id, name, kind, sLat, sLon, nodeId, wayId, platformM, catchmentM, op.showCatchment ? 1 : 0, cost, Date.now());
    const station = this._st.station.get(Number(res.lastInsertRowid));
    this._pushUndo(user.id, { label: `新建车站「${name}」`, steps: [{ table: 'stations', id: station.id, mode: 'delete' }] });
    this.onChanged('station', station.id);
    // ⚠ 新车站要进 O/D 表与行程图：**车站的覆盖半径决定站间步行接驳（换乘）半径**，所以多一个站
    // 不只多了它自己的边，还会改掉它邻站的边（见 transferWalkRadiusM / _buildWalkLinks）。
    // 以前这里没有作废缓存，新建的车站要等到"跨天 / 改线路 / 改人口"才会出现在 O/D 表里，
    // 而 stationPublic 又会顺手把**旧的**缓存读出来显示。与 updateStation / deleteStation 一个口径。
    this._dropDemandCache(station.id);
    return {
      station: this.stationPublic(station), company: this.companyPublic(c), cost,
      // 吸附明细：客户端可以提示"已吸附到 X 米外的道路/轨道"
      snap: { distance: snap.distance, nodeId, wayId, bus: kind === 'bus', snapped: snap.distance != null && snap.distance > 0.5 },
    };
  }

  /**
   * 这个车站是不是"从底图导入的"—— **纯信息字段，不是权限**。
   * 以前这里叫 _isPublicStation（imported || owner === '__system__'），并且拿它把导入站判成
   * "只读的公共车站"（改名 / 删除 / 挪动一律禁止）。现在车站**没有归属这回事**：
   * 导入站和玩家自建站完全一样，谁都能改、能删、能挪；这个函数只剩一个用途 ——
   * 让对外快照标一句"这个站是从底图来的"（imported / osmType / osmId 同理）。
   */
  _isImportedStation(row) {
    return !!(row && row.imported);
  }

  /**
   * 这个车站能不能拿来当站点：**只要车站还在就能用**。
   * 以前只认"自己的车站 / 自己公司的车站 / 公共车站"，但协作规则下谁都可能改别人的线路，
   * 那条过滤会变成**静默摘站**的陷阱：B 改 A 的线路名时客户端会把整份 stops 一起回传，
   * 服务端按"B 自己的车站"过一遍，A 的车站就被全摘掉了（线路直接残废）。
   * 所以这里只看存在性（不存在的 id 仍然会被丢掉）。
   * 参数 companyId / userId 保留不动：调用点不少，签名不改成"少传一个参数"的坑。
   */
  _usableStop(row) {
    return !!row;
  }

  stationPublic(row) {
    if (!row) return null;
    // 需求 / 覆盖人口都在 stationDemandOf 里算（带缓存，人口或日期变了才重算）
    const d = this.stationDemandOf(row);
    // O/D：这一站每天产生多少乘客、其中有多少能走掉、主要去哪（NIMBY Rails 的 destination picking）
    const od = this._ensureOdDemand();
    const odSt = od.byStation.get(row.id) || { spawn: 0, served: 0, reach: 0, dests: [] };
    const catchment = {
      pop: d.pop, jobs: d.jobs, weightedPop: Math.round(d.weightedPop || 0), activity: d.activity,
      density: d.density, coverage: d.coverage,
      demand: d.demand, radiusM: d.radiusM,
      // 三档距离的分界（米）：NR 的 local / regional / long distance（只用于挑时段曲线）
      bandMaxM: { local: PAX.bandMaxM.local, regional: PAX.bandMaxM.regional, long: null },
    };
    const queue = this.stationWaiting(row.id);
    const pax = this.stationPaxStats(row.id);
    const hasPlatform = kindHasPlatform(row.kind);
    return {
      // ⚠ owner / companyId 只是"这个站落在谁的账上建的"（自建站 = 出钱那家公司；底图导入站 =
      //    那个不参与玩法的挂靠账号），**不是权限**：车站没有归属，谁都能改名 / 删除 / 挪位置，
      //    这几个字段给界面做统计与展示就够了，客户端不要拿它当只读判据。
      id: row.id, owner: row.owner, companyId: row.company_id, name: row.name, kind: row.kind,
      lat: row.lat, lon: row.lon, nodeId: row.node_id, wayId: row.way_id,
      // 站台长度只对铁路类站点有意义：公交站恒为 0，并给出 hasPlatform 让客户端把那一栏藏起来
      platformM: hasPlatform ? row.platform_m : 0,
      hasPlatform,
      noPlatform: !hasPlatform,
      catchmentM: row.catchment_m, cost: row.cost,
      showCatchment: !!row.show_catchment,
      onRail: !!row.node_id,
      // 底图导入站的信息（**只读的来源标注，不是权限**）：imported=1 表示这个站是 import.stations
      // 从 OSM 底图建出来的，osmType/osmId 是它来自哪个元素。它们同样是可以改名/删除/挪动的，
      // isPublic 只是 imported 的同义词，留给老客户端做"来源"标签，别拿它当"不能改"的意思。
      imported: row.imported ? 1 : 0,
      isPublic: this._isImportedStation(row),
      osmType: row.osm_type || null, osmId: row.osm_id == null ? null : row.osm_id,
      catchment,
      demand: d.demand,                               // 日需求 = 覆盖人口 × 活跃度（只看人口）
      dailyTrips: d.dailyTrips,                       // 每天在这个站产生的乘客数 = 需求 × 出行率
      // O/D：这些乘客里有多少真的能走掉（行程图里走得到：含换乘与步行接驳），以及主要去向
      odSpawn: odSt.spawn,                            // 每天产生（origin）的乘客
      odServed: odSt.served,                          // 其中能走掉的
      odReach: odSt.reach,                            // 能走掉的比例（NR 1.12 的"可达人口"）
      odDests: odSt.dests,                            // 前几个主要目的站（人/日，带换乘次数与步行米数）
      // 车站乘客账本（当日）：到达目的站 / 从这里出发（上车或步行）/ 在这里换乘 / 从这里开始步行
      paxArrived: pax.paxArrived,
      paxDeparted: pax.paxDeparted,
      paxTransferred: pax.paxTransferred,
      paxWalked: pax.paxWalked,
      paxWalking: pax.paxWalking,      // 正在站间步行接驳（OSI）的乘客（NR：站厅里的计时器）
      waiting: queue.waiting,          // 等车人数（车站 × 公司合计，所有玩家都看得到）
      lost: queue.lost,                // 等太久放弃离开的累计人数
      waitSeconds: queue.waitSeconds,  // 最老那一批乘客已经等了多久（游戏秒）
      waitingByCompany: queue.waitingByCompany,
      waitingByLine: queue.waitingByLine,   // 每条线还有 destMix：这条线的人分别要去哪一站
      waitingByDest: queue.waitingByDest,   // 整个站台按目的站分组 [{stationId,name,people,lines}]
    };
  }

  updateStation(user, op) {
    const s = this._st.station.get(Number(op.id));
    if (!s) throw new TransitError('车站不存在');
    // 车站没有归属：底图导入的站与玩家自建的站一样，谁都能改名 / 换类型 / 挪位置
    //（原来这里有一条"公共车站只读"的特判，已经按用户要求删掉；imported / osm_type / osm_id
    //  只是来源信息，改名挪站之后照样保留）。
    // 协作编辑：不是自己建的车站也能改，只有"有人正在编辑"时才挡
    this.checkElementLock(user, 'station', s.id);
    const before = this._row('stations', s.id);
    const name = op.name === undefined ? s.name : (String(op.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32) || s.name);
    const kind = STATION_KINDS[op.kind] ? op.kind : s.kind;
    // 公交站没有站台长度：忽略这一项（存 0）；显式传一个非 0 值就当参数错误挡回去
    let platformM = s.platform_m;
    if (kindHasPlatform(kind)) {
      platformM = op.platformM === undefined ? (kindHasPlatform(s.kind) ? s.platform_m : 120) : Math.max(30, Math.min(600, Number(op.platformM) || s.platform_m || 120));
    } else {
      const asked = Number(op.platformM);
      if (op.platformM !== undefined && Number.isFinite(asked) && asked > 0) {
        throw new TransitError('公交站没有站台长度（公交站就是路边站牌，platformM 只能是 0）', 'NO_PLATFORM');
      }
      platformM = 0;
    }
    const catchmentM = op.catchmentM === undefined ? s.catchment_m : Math.max(200, Math.min(this.config.maxCatchment, Number(op.catchmentM) || s.catchment_m));
    const showCatchment = op.showCatchment === undefined ? s.show_catchment : (op.showCatchment ? 1 : 0);
    // 支持移动车站：给了新坐标就按新模式重新吸附到路网（公交 300 米内的最近可通行道路、轨道 120 米内的最近轨道）
    let sLat = s.lat;
    let sLon = s.lon;
    let sNode = s.node_id;
    let sWay = s.way_id;
    let snapInfo = null;
    if (op.lat !== undefined || op.lon !== undefined) {
      const nlat = Number(op.lat);
      const nlon = Number(op.lon);
      if (!Number.isFinite(nlat) || !Number.isFinite(nlon) || Math.abs(nlat) > 90 || Math.abs(nlon) > 180) {
        throw new TransitError('坐标不合法');
      }
      const snap = this._snapStation(kind, nlat, nlon);
      if (!snap.ok) throw new TransitError(snap.error, snap.code || 'NO_LINK');
      sNode = snap.nodeId;
      sWay = snap.wayId;
      sLat = Number.isFinite(snap.lat) ? snap.lat : nlat;
      sLon = Number.isFinite(snap.lon) ? snap.lon : nlon;
      snapInfo = { distance: snap.distance, nodeId: sNode, wayId: sWay, bus: kind === 'bus' };
    }
    this._st.updateStation.run(name, kind, platformM, catchmentM, showCatchment, sNode, sWay, sLat, sLon, s.id);
    this._pushUndo(user.id, { label: `修改车站「${name}」`, steps: [{ table: 'stations', id: s.id, mode: 'restore', row: before }] });
    this.onChanged('station', s.id);
    this._dropDemandCache(s.id);
    return { station: this.stationPublic(this._st.station.get(s.id)), snap: snapInfo };
  }

  deleteStation(user, op) {
    const s = this._st.station.get(Number(op.id));
    if (!s) throw new TransitError('车站不存在');
    // 车站没有归属：底图导入的站一样能删（删掉时经过它的线路会被摘掉这一站，见 affectedLines；
    // 撤销一步能连站带线路一起放回来）。原来这里那条"公共车站不能删"的特判已经删掉。
    // 协作编辑：别人建的车站也能删
    this.checkElementLock(user, 'station', s.id);
    const steps = [{ table: 'stations', id: s.id, mode: 'restore', row: this._row('stations', s.id) }];
    const affectedLines = [];
    for (const line of this._st.allLines.all()) {
      let stops = [];
      try { stops = JSON.parse(line.stops || '[]'); } catch { stops = []; }
      if (!stops.includes(s.id)) continue;
      affectedLines.push(this._row('lines', line.id));
      const next = stops.filter((id) => id !== s.id);
      this._writeLine(line, { stops: next });
    }
    for (const row of affectedLines) steps.push({ table: 'lines', id: row.id, mode: 'restore', row });
    this._st.delStation.run(s.id);
    this._dropStationQueue(s.id);
    this._dropDemandCache(s.id);
    this.lineCache.clear();
    this._rebuildAllLinePaths();
    this._pushUndo(user.id, { label: `删除车站「${s.name}」`, steps });
    this.onChanged('station', s.id);
    return { deleted: s.id, refund: Math.round(s.cost * 0.5), name: s.name, linesAdjusted: affectedLines.length };
  }

  stationsFor(ownerId = null) {
    const rows = this._st.allStations.all().filter((s) => (ownerId ? s.owner === ownerId : true));
    return rows.map((s) => this.stationPublic(s));
  }

  /* ------------------------------ 线路 ------------------------------ */
  _parseStops(json) {
    try {
      const arr = JSON.parse(json || '[]');
      return Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : [];
    } catch { return []; }
  }

  _writeLine(line, patch) {
    const stops = patch.stops !== undefined ? patch.stops : this._parseStops(line.stops);
    const name = patch.name !== undefined ? patch.name : line.name;
    const color = patch.color !== undefined ? patch.color : line.color;
    const kind = patch.kind !== undefined ? patch.kind : line.kind;
    const loop = patch.loop !== undefined ? (patch.loop ? 1 : 0) : line.loop;
    const schedule = patch.schedule !== undefined ? patch.schedule : (line.schedule == null ? null : line.schedule);
    // ⚠ service_paused（#3 暂停运营）不在这个 UPDATE 里：改班次 / 改站序不该动"暂停"这件事，
    //   它只由 line.setService 改（那一处还负责重新排班，见 _resumeLine）。
    this._st.updateLine.run(name, color, kind, JSON.stringify(stops), loop, line.path, line.path_len, line.path_error, line.path_built_at, schedule, line.id);
    const cache = this.lineCache.get(line.id);
    if (cache) { cache.schedule = parseSchedule(schedule); cache.departureKey = null; cache.runPlan = null; cache.runPlanKey = null; }
    return this._st.line.get(line.id);
  }

  /** 某条线路的班次（#18）：老库 schedule 为 NULL → 自由发车 */
  lineSchedule(line) {
    if (!line) return { mode: 'free' };
    let raw = line.schedule;
    if (raw && typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return { mode: 'free' }; }
    }
    try { return parseSchedule(raw); } catch { return { mode: 'free' }; }
  }

  /** 把班次写进库里（null/undefined → 清空成自由发车） */
  _storeSchedule(line, schedule) {
    const text = !schedule || schedule.mode === 'free' ? null : JSON.stringify(schedule);
    this.db.prepare('UPDATE lines SET schedule = ? WHERE id = ?').run(text, line.id);
    return text;
  }

  /**
   * 一条线路当天全部发车时刻（当天的秒数，升序）。
   * 流水班：firstSec 起每 headwaySec 一班，到 lastSec 为止；定班车：直接用它给的时刻表。
   */
  _lineDepartures(cache) {
    const s = cache.schedule || { mode: 'free' };
    const key = JSON.stringify(s);
    if (cache.departureKey === key && cache.departures) return cache.departures;
    const out = [];
    if (s.mode === 'headway') {
      for (let t = s.firstSec; t <= s.lastSec && out.length < MAX_DEPARTURES; t += s.headwaySec) out.push(t);
    } else if (s.mode === 'timetable') {
      for (const t of s.times) { if (out.length >= MAX_DEPARTURES) break; out.push(t); }
      out.sort((a, b) => a - b);
    }
    cache.departureKey = key;
    cache.departures = out;
    return out;
  }

  /** 这条线路是不是"按班次表运行"（headway / timetable）；free = 自由发车（老行为，车一直跑） */
  _usesSchedule(cache) {
    return !!(cache && cache.schedule && cache.schedule.mode !== 'free');
  }

  /**
   * 第 j 班（当天班次表里的下标）派给哪辆车 —— **把车辆铺开到班次上**。
   * 完整的规则在 _runPlan 里（含 #4 的"每个班次指定车辆"），这里只是取那一份计划的第 j 项：
   *   · 没指定车 → 老规则：线上的车按 id 排序，第 j 班给第 (j % 车数) 辆，于是流水班
   *     （headway）时相邻两班之间正好隔 headwaySec、每辆车隔 车数×headwaySec 跑一趟；
   *   · 指定了车（schedule.assignments）且那辆车**空闲**（还在、而且就派在这条线上）→ 就是它；
   *     车在别处忙 / 已被删 → 退回老规则，并记进 linePublic().schedule.assignmentsMissed；
   *   · 车比班次多时多出来的车没有班（今天不动，linePublic().noServiceNow 会说明）。
   * 这条线上没有任何车时返回 null —— **没人发车是正常的，不是 bug**。
   */
  _departureVehicleId(cache, j) {
    const plan = this._runPlan(cache);
    if (!plan || !(j >= 0) || j >= plan.vehicles.length) return null;
    return plan.vehicles[j];
  }

  /**
   * 这一天**每一班派哪辆车**（#4 的核心）：[{vehicles: (id|null)[], missed: [...], assigned: n}]。
   *   · 默认（没有 assignments）：第 j 班给第 (j % 车数) 辆 —— 老行为，一个字都没改；
   *   · 指定表里有第 j 班（runIndex === j）：把它交给指定的那辆车，前提是这辆车**空闲** ——
   *     空闲 = 车还在、而且 line_id 就是这条线（cache.vehicleIds 是重建路径时从库里取的，
   *     车被删 / 被改派到别的线路都会重建，所以这里只看内存里的那份列表就够）；
   *   · 不空闲（在别的线路上忙 / 已经不在这条线上）→ 这一班**不空等**：退回默认轮转发车，
   *     并把 {index, departureSec, vehicleId, reason} 记进 missed（对外就是 assignmentsMissed）。
   * 结果缓存在线路缓存上（键 = 线路 id + 车列表 + 班次表），所以每帧取用不会重复算。
   */
  _runPlan(cache) {
    const empty = { vehicles: [], missed: [], assigned: 0 };
    if (!cache) return empty;
    const list = this._lineDepartures(cache);
    const ids = cache.vehicleIds || [];
    const assign = (cache.schedule && cache.schedule.assignments) || [];
    // 缓存键：线路 × 车列表 × 班次表（departureKey 就是班次对象的 JSON，含 assignments）。
    // 车被删 / 被改派到别的线路都会重建线路缓存，所以这份计划不会拿着过期的车列表。
    const key = `${cache.lineId}|${ids.join(',')}|${list.length}|${cache.departureKey || ''}`;
    if (cache.runPlan && cache.runPlanKey === key) return cache.runPlan;
    const byIndex = new Map();
    for (const a of assign) byIndex.set(a.runIndex, a.vehicleId);
    const vehicles = new Array(list.length).fill(null);
    const missed = [];
    for (let j = 0; j < list.length; j++) {
      let use = null;
      if (byIndex.has(j)) {
        const want = byIndex.get(j);
        if (ids.includes(want)) use = want;
        else {
          const v = this._st.vehicle.get(want);
          missed.push({
            index: j, departureSec: list[j], vehicleId: want,
            reason: v ? 'vehicle-busy' : 'vehicle-gone',
          });
        }
      }
      if (use == null && ids.length) use = ids[j % ids.length];
      vehicles[j] = use;
    }
    const plan = { vehicles, missed, assigned: assign.length };
    cache.runPlan = plan;
    cache.runPlanKey = key;
    return plan;
  }

  /* --------------------- #18 逐站时刻表（预测到站 / 发车时刻） --------------------- */

  /**
   * 一段区间的**纯运行时间**（游戏秒）——逐站时刻表就是用它一段段推出来的。
   * 模型与 _integrate 是同一套运动学（加速度/制动减速度都取自 dynamicsForKind）：
   *   从站台静止起步，按 a 加速到 v = min(路段限速, 车辆最高速)，再按 b 减速停在下一站。
   *   · 区间够长：t = v/a + v/b + (d − v²/2a − v²/2b)/v   （加速段 + 制动段 + 匀速段）
   *   · 区间太短（还没加到 v 就要开始刹）：峰值 v_p = √(2d·a·b/(a+b))，t = v_p/a + v_p/b
   * 例：公交（a=0.9 / b=1.1 m/s²）在 40 km/h 限速下跑 800 米的区间 ≈ 12.3 + 10.1 + 60.7 ≈ 83 游戏秒。
   */
  _segmentRunSec(cache, fromM, toM, vmaxMps, dyn) {
    const d = Math.abs(toM - fromM);
    if (!(d > 0)) return 0;
    const limit = this._segSpeed(cache.path, (fromM + toM) / 2);      // 路段限速（km/h）
    const v = Math.max(1, Math.min(vmaxMps, limit ? limit / 3.6 : vmaxMps));
    const a = Math.max(0.05, dyn.accel);
    const b = Math.max(0.05, dyn.brake);
    const da = (v * v) / (2 * a);
    const db = (v * v) / (2 * b);
    if (d >= da + db) return v / a + v / b + (d - da - db) / v;
    const vp = Math.sqrt((2 * d * a * b) / (a + b));
    return vp / a + vp / b;
  }

  /**
   * 从**当前速度**走完 remainM 还要多少游戏秒（"下一站还有多久到"用它）。
   * 与 _segmentRunSec 同一套运动学，只是起点带初速 v0：
   *   先加速到 v：t1 = (v−v0)/a、d1 = (v+v0)/2·t1；再按 b 刹停：t3 = v/b、d3 = v²/2b；
   *   区间不够长时解 v_p²(1/2a + 1/2b) = d + v0²/2a。
   */
  _travelSecFrom(remainM, v0, vTarget, dyn) {
    const d = Math.max(0, remainM);
    if (!(d > 0)) return 0;
    const v = Math.max(1, vTarget);
    const a = Math.max(0.05, dyn.accel);
    const b = Math.max(0.05, dyn.brake);
    const s0 = Math.max(0, Math.min(v0, v));
    const t1 = (v - s0) / a;
    const d1 = ((v + s0) / 2) * t1;
    const t3 = v / b;
    const d3 = (v * v) / (2 * b);
    if (d >= d1 + d3) return t1 + t3 + (d - d1 - d3) / v;
    const vp = Math.sqrt(Math.max(0, (d + (s0 * s0) / (2 * a)) / (1 / (2 * a) + 1 / (2 * b))));
    return Math.max(0, (vp - s0) / a) + vp / b;
  }

  /**
   * 一趟车（run = 从首站发车到末站 / 环线绕回首站）的**逐站时刻表**：
   *   [{ idx, stationId, name, distance, arrivalSec, departureSec, runSec, dwellSec, loopClose }]
   * arrivalSec / departureSec 是"当天的第几秒"（跨零点时允许 > 86400）。
   * 停站时间与 _dock 完全同口径：中间站 dwellSeconds，首末站再加 terminalDwellSeconds。
   * 按（发车时刻 + 车型 + 限速）缓存，车辆改派/改型后自动重算。
   */
  _runTable(cache, departureMs, vehicle) {
    if (!cache || !this._usesSchedule(cache) || !vehicle) return null;
    if (!cache.runTables) cache.runTables = new Map();
    const key = `${departureMs}|${vehicle.kind || ''}|${vehicle.max_speed || 0}|${cache.stops.length}|${cache.path.length}`;
    const hit = cache.runTables.get(key);
    if (hit) return hit;
    const stops = cache.stops;
    if (stops.length < 2) return null;
    const dyn = this._dynFor(vehicle);
    const vmax = Math.max(1, Math.min(Number(vehicle.max_speed) || 80, 400) / 3.6);
    const baseDwell = Math.max(0, Number(this.config.dwellSeconds) || 0);
    const terminalDwell = baseDwell + Math.max(0, Number(this.config.terminalDwellSeconds) || 0);
    const dayStart = Math.floor(departureMs / 86400000) * 86400000;
    let t = (departureMs - dayStart) / 1000;                 // 首站发车时刻（当天秒）
    const rows = [{
      idx: 0, stationId: stops[0].stationId, name: stops[0].name, distance: stops[0].distance,
      arrivalSec: t, departureSec: t, runSec: 0, dwellSec: terminalDwell, loopClose: false,
    }];
    for (let i = 1; i < stops.length; i++) {
      const runSec = this._segmentRunSec(cache, stops[i - 1].distance, stops[i].distance, vmax, dyn);
      t += runSec;
      const dwell = (i === stops.length - 1) ? terminalDwell : baseDwell;
      rows.push({
        idx: i, stationId: stops[i].stationId, name: stops[i].name, distance: stops[i].distance,
        arrivalSec: t, departureSec: t + dwell, runSec, dwellSec: dwell, loopClose: false,
      });
      t += dwell;
    }
    // 环线：末站之后还要绕回首站（也算这一趟的行程，前端可以显示"回到起点几点"）
    if (cache.loop) {
      const pathEnd = cache.path.length ? cache.path[cache.path.length - 1].distance : stops[stops.length - 1].distance;
      const runSec = this._segmentRunSec(cache, stops[stops.length - 1].distance, pathEnd, vmax, dyn);
      rows.push({
        idx: stops.length, stationId: stops[0].stationId, name: stops[0].name, distance: pathEnd,
        arrivalSec: t + runSec, departureSec: t + runSec, runSec, dwellSec: 0, loopClose: true,
      });
    }
    const table = {
      departureMs, dayStartMs: dayStart, vehicleId: vehicle.id, kind: vehicle.kind || '',
      stops: rows, tripSeconds: Math.round(rows[rows.length - 1].arrivalSec - rows[0].departureSec),
    };
    cache.runTables.set(key, table);
    if (cache.runTables.size > 48) {           // 一条线最多留 48 张表，够当天的班次滚动用了
      const oldest = cache.runTables.keys().next().value;
      cache.runTables.delete(oldest);
    }
    return table;
  }

  /** 一趟车的时刻表在某一站的计划到站（当天秒）；找不到返回 null */
  _timetableArrivalSec(table, stationId) {
    if (!table) return null;
    for (const s of table.stops) if (Number(s.stationId) === Number(stationId)) return s.arrivalSec;
    return null;
  }

  /**
   * 这条线未来 limit 班（含正在等点的那一班）的时刻表，给 linePublic().runs 用。
   * 每班都带上：
   *   · index        当天班次表里的下标（#4：客户端的"每个班次指定车辆"就按这个数填 assignments）
   *   · departure / departureSec / departureMs   这一班的发车时刻（"HH:MM" 与当天秒数/游戏毫秒）
   *   · vehicleId / vehicleName                  这一班派给哪辆车（没车可派 = null）
   *   · pinnedVehicleId / pinnedVehicleName / assignmentMissed
   *                  玩家给这一班指定的车、以及这个指定**有没有被满足**（车在别处忙/被删 = true）
   *   · 逐站预测时刻（_runTable）：stopsEta 与 tripSeconds
   * 车比班次多时，多出来的班次是"没有人开"的（vehicleId=null）。
   */
  _lineRuns(cache, limit = 5) {
    if (!this._usesSchedule(cache)) return [];
    const list = this._lineDepartures(cache);
    if (!list.length) return [];
    const assign = new Map();
    for (const a of (cache.schedule && cache.schedule.assignments) || []) assign.set(a.runIndex, a.vehicleId);
    const missedAt = new Set(this._runPlan(cache).missed.map((m) => m.index));
    const nowMs = this.clockMs;
    const dayStart = Math.floor(nowMs / 86400000) * 86400000;
    const tod = (nowMs - dayStart) / 1000;
    const out = [];
    for (let j = 0; j < list.length && out.length < limit; j++) {
      if (list[j] + 1e-6 < tod) continue;
      const vehicleId = this._departureVehicleId(cache, j);
      const v = vehicleId == null ? null : this._st.vehicle.get(vehicleId);
      const table = v ? this._runTable(cache, dayStart + list[j] * 1000, v) : null;
      const pinned = assign.has(j) ? assign.get(j) : null;
      const pv = pinned == null ? null : this._st.vehicle.get(pinned);
      out.push({
        index: j,
        departureSec: list[j],
        departure: secToHHMM(list[j]),
        departureMs: dayStart + list[j] * 1000,
        vehicleId: v ? v.id : null,
        vehicleName: v ? v.name : null,
        // #4 这一班玩家指定的车（没指定 = null）；assignmentMissed = 指定了但没满足（退回轮转了）
        pinnedVehicleId: pinned,
        pinnedVehicleName: pv ? pv.name : null,
        assignmentMissed: missedAt.has(j),
        tripSeconds: table ? table.tripSeconds : null,
        // 逐站预测时刻：[车站 id, 到站秒, 发车秒]（紧凑数组，前端自己配站名）
        stopsEta: table ? table.stops.map((s) => [s.stationId, Math.round(s.arrivalSec), Math.round(s.departureSec)]) : [],
      });
    }
    return out;
  }

  /** 逐站时刻表的"对外"版本：带站名 / HH:MM / 相对现在还有多少游戏秒 */
  _stopsEtaPublic(table) {
    if (!table) return [];
    const dayStart = table.dayStartMs;
    return table.stops.map((s) => ({
      idx: s.idx, stationId: s.stationId, name: s.name, distance: Math.round(s.distance),
      arrivalSec: Math.round(s.arrivalSec), departureSec: Math.round(s.departureSec),
      arrival: secToHHMM(s.arrivalSec), departure: secToHHMM(s.departureSec),
      runSec: Math.round(s.runSec), dwellSec: Math.round(s.dwellSec), loopClose: !!s.loopClose,
      // 相对"现在"还有多少游戏秒（负数 = 已经过点了）
      etaSeconds: Math.round((dayStart + s.arrivalSec * 1000 - this.clockMs) / 1000),
    }));
  }

  /* ----------------- #19 逐站预测（自由发车也有）+ 晚点系统（NIMBY Rails 口径） -----------------

   * #18 只让**按班次表运行**的线路有逐站时刻表（linePublic().runs / stopsEta）；自由发车是"没有时刻表"的，
   * 所以自由发车线上"下一站几点到"只知道 etaSeconds（还有多少秒），再往后就什么都没有了。
   * 这一步把它补齐，并且顺手做出 NIMBY Rails 那套**晚点（delay）**：
   *
   * ① remainingStops —— 每一辆车"本趟剩下每一站几点到、几点发"：
   *      从**车现在的位置**往后推，区间运行时间跟 _runTable 是同一套运动学
   *      （_segmentRunSec / _travelSecFrom，再减掉 dockAllowanceSeconds：sim 在站台前按爬行速度
   *      对位后就判定到站，比纯运动学刹停早一点点），再加上每站停站时间
   *      （中间站 dwellSeconds，首末站再加 terminalDwellSeconds）。
   *      自由发车、班次车都有。**便宜**：只在"换了一趟 / 办完一站 / 每 N 游戏秒"时重算，
   *      其余每帧直接复用上一次算出来的数组（见 DEFAULTS.remainingStopsRefreshSeconds）。
   *
   * ② 晚点系统 —— 每辆车有一份"本趟计划"（rt.delayPlan）：
   *      · 班次车（headway / timetable）：计划就是 _runTable 那张逐站时刻表（source='timetable'），
   *        偏差 = 实际 − 时刻表（负数 = 早点）；
   *      · 自由发车（含班次车的回场段）：计划是**它自己这一趟的预测**（source='self'），并且留
   *        DEFAULTS.delayPlanSlackRatio 的运行余裕 —— 真实时刻表一般也留 5%~10%，晚点之后就是
   *        靠这点余裕一站站追回来的。自由发车没有"时刻表"这回事，所以偏差**只报晚点不报早点**
   *        （负数一律按 0 处理）：正数 = 比计划慢了多少，0 = 准点。
   *      每办完一站就把实际到站/发车时刻跟计划比一次，记进 delayHistory，并更新
   *      delaySeconds（当前偏差，取"离开这一站时"的口径）、peakDelaySeconds、delayTrend、recovered。
   *
   * ③ 晚点的成因（记录里的 cause，都是模拟里真实发生的事）：
   *      'blocked'      被前车压着走：_enforceSpacing 限位/限速，blockedSeconds = 本区间被压住的游戏秒；
   *                     **只有轨道车会拿到这个成因**（#3 之后公交不再互相阻挡，见 _enforceSpacing）；
   *      'congestion'   公交专属（#3 用户口径）：这一段里被**道路网**（限速 × 拥堵系数，
   *                     railgraph 算好后烘进路径速度）压着走过，且确实比计划慢
   *                     → congestionSeconds = 本区间被道路压住的游戏秒（不再是含混的 blocked/delayed）；
   *      'boarding'     本站上下客多、停站超过计划（dwell 本来就按上下客人数变长）；
   *      'departure'    起点站发车就晚了（本趟计划发车时刻被实际发车时刻推后）；
   *      'delayed'      本站没有新成因，但偏差比上一站更大（晚点在累积）；
   *      'recovered'    偏差比上一站小了（在追回时间）；'on-time' / 'early' 则是准点/早点。
   *     当前偏差回到 onTimeSeconds 以内、而这一趟曾经晚过 → recovered = true（追回来了）。
   */

  /** "准点"的判定阈值（游戏秒）：|偏差| 在这个范围内算准点 */
  _onTimeSeconds() {
    const n = Number(this.config.onTimeSeconds);
    return Number.isFinite(n) ? Math.max(1, n) : DEFAULTS.onTimeSeconds;
  }

  /** 偏差变化超过多少游戏秒才算"在变差 / 在追回" */
  _trendSeconds() {
    const n = Number(this.config.delayTrendSeconds);
    return Number.isFinite(n) ? Math.max(0, n) : DEFAULTS.delayTrendSeconds;
  }

  /** 自由发车"自编时刻表"的运行余裕（0~1） */
  _planSlack() {
    const n = Number(this.config.delayPlanSlackRatio);
    const v = Number.isFinite(n) ? n : DEFAULTS.delayPlanSlackRatio;
    return Math.max(0, Math.min(1, v));
  }

  /** 到站判定余量（游戏秒），见 DEFAULTS.dockAllowanceSeconds */
  _dockAllowanceSec() {
    const n = Number(this.config.dockAllowanceSeconds);
    return Number.isFinite(n) ? Math.max(0, n) : DEFAULTS.dockAllowanceSeconds;
  }

  /** 这辆车的区间限速（m/s）= min(车辆最高速, 400 km/h) */
  _vmaxOf(vehicle) {
    return Math.max(1, Math.min(Number(vehicle && vehicle.max_speed) || 80, 400) / 3.6);
  }

  /** 从这里走到 stop 的**到站**时间（游戏秒）：运动学 + 到站余量 */
  _travelToStopSec(remainM, v0, vTarget, dyn) {
    return Math.max(0, this._travelSecFrom(remainM, v0, vTarget, dyn) - this._dockAllowanceSec());
  }

  /** 一个整区间（从上一站台起步）的到站时间（游戏秒）：与 _runTable 同口径 + 到站余量 */
  _segmentStopSec(cache, fromM, toM, vmaxMps, dyn) {
    return Math.max(0, this._segmentRunSec(cache, fromM, toM, vmaxMps, dyn) - this._dockAllowanceSec());
  }

  /**
   * 行进方向上"还没到的停靠站"：从 distance 往前数（不含脚下这一站），带站序下标。
   * 环线在走到头之后绕回起点接着数，但每个站最多出现一次（一整圈）。
   */
  _stopsAheadFrom(cache, distance, direction) {
    const stops = cache.stops;
    const out = [];
    const n = stops.length;
    const seen = new Set();
    if (direction > 0) {
      for (let i = 0; i < n; i++) {
        if (stops[i].distance > distance + 1) { out.push({ st: stops[i], idx: i }); seen.add(i); }
      }
      if (cache.loop) for (let i = 0; i < n; i++) if (!seen.has(i)) out.push({ st: stops[i], idx: i });
    } else {
      for (let i = n - 1; i >= 0; i--) {
        if (stops[i].distance < distance - 1) { out.push({ st: stops[i], idx: i }); seen.add(i); }
      }
      if (cache.loop) for (let i = n - 1; i >= 0; i--) if (!seen.has(i)) out.push({ st: stops[i], idx: i });
    }
    return out;
  }

  /**
   * 车此刻正"停在/正在办"的那一站（正在上下客，或者按班次在首站等点发车）：
   * 逐站预测里它是 state='served' 的那一条（已经到站了，报实际到站时刻与预计发车时刻）。
   * #3 暂停运营收车停在首站的车也算这一条：它确实停在首站上，只是不报"发车时刻"（不会发车）。
   */
  _servedStop(cache, rt) {
    if (!cache || !cache.stops.length || !rt) return null;
    if (rt.state === 'dwell' && rt.lastServedStation != null) {
      const idx = cache.stops.findIndex((s) => Number(s.stationId) === Number(rt.lastServedStation));
      if (idx < 0) return null;
      return {
        st: cache.stops[idx], idx,
        arrivedAtMs: rt.servedAtMs == null ? this.clockMs : rt.servedAtMs,
        departAtMs: rt.dwellUntil == null ? this.clockMs : rt.dwellUntil,
      };
    }
    // 按班次表在首站等点发车 / 暂停运营收车停在首站：这一站也算"已经到站"
    const atFirst = rt.distance <= ARRIVE_EPS;
    if (atFirst && (rt.state === 'paused' || (rt.state === 'scheduled' && rt.departureMs != null))) {
      return {
        st: cache.stops[0], idx: 0,
        arrivedAtMs: rt.servedAtMs == null ? this.clockMs : rt.servedAtMs,
        departAtMs: rt.state === 'paused' ? this.clockMs : rt.departureMs,
      };
    }
    return null;
  }

  /** 作废"逐站预测"的缓存（办完一站 / 离开站台 / 换了一趟时调） */
  _dropRemainingStops(rt) {
    if (!rt) return;
    rt.remainingStops = null;
    rt.remainingStopsAtMs = null;
  }

  /**
   * 本车剩下的逐站到站/发车时刻（对外就是 remainingStops）：
   *   [{ idx, stationId, name, distanceM, etaGameMs, etdGameMs, state }]
   *   · etaGameMs / etdGameMs 都是**游戏时钟毫秒**（绝对值，直接用就行，不用再加 now）
   *   · distanceM 是这一站在线路上的里程（与 linePublic().stopsEta[].distance 同一口径）
   *   · state：'served' 正在办这一站 / 'next' 下一站 / 'pending' 再后面的站
   * 缓存策略见 DEFAULTS.remainingStopsRefreshSeconds；只有这里会新建数组，别的调用点都是复用。
   */
  _remainingStops(cache, rt, vehicle) {
    if (!cache || !cache.stops.length || !rt || !vehicle) return [];
    const refreshMs = Math.max(0.25, Number(this.config.remainingStopsRefreshSeconds) || DEFAULTS.remainingStopsRefreshSeconds) * 1000;
    if (rt.remainingStops && rt.remainingStopsAtMs != null && this.clockMs - rt.remainingStopsAtMs < refreshMs) {
      return rt.remainingStops;
    }
    const dyn = this._dynFor(vehicle);
    const vmax = this._vmaxOf(vehicle);
    const baseDwell = Math.max(0, Number(this.config.dwellSeconds) || 0);
    const terminalDwell = baseDwell + Math.max(0, Number(this.config.terminalDwellSeconds) || 0);
    const n = cache.stops.length;
    const rows = [];
    // 起点时刻：正在停站（或按班次等点发车）时不是"现在"，而是"这一站办完/到点"的时刻
    let t = this.clockMs;
    const served = this._servedStop(cache, rt);
    if (served) {
      rows.push({
        idx: served.idx, stationId: served.st.stationId, name: served.st.name,
        distanceM: Math.round(served.st.distance),
        etaGameMs: Math.round(served.arrivedAtMs), etdGameMs: Math.round(served.departAtMs),
        state: 'served',
      });
      t = Math.max(t, served.departAtMs);
    }
    const ahead = this._stopsAheadFrom(cache, rt.distance, rt.direction);
    let fromM = rt.distance;
    for (let i = 0; i < ahead.length; i++) {
      const { st, idx } = ahead[i];
      const remain = Math.abs(st.distance - fromM);
      const limit = this._segSpeed(cache.path, fromM);
      const vT = Math.min(vmax, limit ? limit / 3.6 : vmax);
      const runSec = i === 0
        ? this._travelToStopSec(remain, Math.max(0, rt.speed || 0), vT, dyn)
        : this._segmentStopSec(cache, fromM, st.distance, vmax, dyn);
      t += runSec * 1000;
      const isTerminal = idx === 0 || idx === n - 1;
      const dwell = isTerminal ? terminalDwell : baseDwell;
      rows.push({
        idx, stationId: st.stationId, name: st.name, distanceM: Math.round(st.distance),
        etaGameMs: Math.round(t), etdGameMs: Math.round(t + dwell * 1000),
        state: i === 0 ? 'next' : 'pending',
      });
      t += dwell * 1000;
      fromM = st.distance;
    }
    rt.remainingStops = rows;
    rt.remainingStopsAtMs = this.clockMs;
    return rows;
  }

  /**
   * 一趟车（leg）开始了：车在端点掉头 / 环线绕回起点时调。
   * 记下这一趟的起点时刻与里程（晚点计划的锚点），并把上一趟的计划留作"上一趟的计划"——
   * 自由发车的下一趟就靠它算出"起点站应该几点发车"，于是"整备超时 / 被前车压住"造成的晚点
   * 会顺着趟次传下去（跟 NIMBY Rails 里晚点会滚到下一班一样）。
   */
  _startLeg(rt) {
    if (!rt) return;
    rt.legSeq = (rt.legSeq || 0) + 1;
    rt.legStartMs = this.clockMs;
    rt.legStartDistance = rt.distance;
    rt.prevDelayPlan = rt.delayPlan || null;
    rt.delayPlan = null;
    rt.peakDelaySeconds = 0;
    rt.recovered = false;
    rt.recoveredSeconds = 0;
    rt.blockedMsAtStop = rt.blockedMs || 0;
    this._dropRemainingStops(rt);
  }

  /** 本趟计划的标识：方向 + 起点站 + 趟次 + （班次车）这一班的计划发车时刻 */
  _delayPlanKey(cache, rt) {
    const n = cache.stops.length;
    const originIdx = rt.direction > 0 ? 0 : Math.max(0, n - 1);
    const sched = (this._usesSchedule(cache) && rt.runActive && rt.direction > 0 && rt.scheduledDepartureMs != null)
      ? rt.scheduledDepartureMs : 'self';
    return `${rt.direction}|${originIdx}|${rt.legSeq || 0}|${sched}`;
  }

  /** 取本趟计划（没有就按现在的状态建一份），plan.source 见文件头的说明 */
  _ensureDelayPlan(cache, rt, vehicle) {
    if (!cache || !cache.stops.length || !rt || !vehicle) return null;
    if (!cache.path || !cache.path.length) return null;
    const key = this._delayPlanKey(cache, rt);
    if (rt.delayPlan && rt.delayPlan.key === key) return rt.delayPlan;
    const plan = this._buildDelayPlan(cache, rt, vehicle, key);
    rt.delayPlan = plan;
    if (plan) this._recordDeparture(cache, rt, plan);
    else {
      // 现在没有可比的东西（班次车在等点 / 回场段）：如实报 null，别拿上一趟的偏差充数
      rt.delaySeconds = null;
      rt.delaySource = null;
      rt.delayTrend = 'stable';
    }
    return plan;
  }

  /**
   * 建一份"本趟计划"：
   *   · 班次车正点发车的那一趟 → 直接用 _runTable 的逐站时刻表（source='timetable'）；
   *   · 自由发车（以及班次车的回场段）→ 用它自己这一趟的预测当计划（source='self'）：
   *       起点站的**计划到站时刻**取"上一趟计划在这一站的到站时刻"（于是晚点会一趟趟传下去），
   *       没有上一趟就用这辆车实际到站的时刻；计划发车 = 计划到站 + 终点站整备时间。
   *       区间运行时间在预测上再乘 (1 + delayPlanSlackRatio)：这点余裕就是追回晚点的本钱。
   *       实际发车早于计划时偏差按 0 处理（自由发车没有时刻表，"早发"没有意义，见 _recordStopObs）。
   */
  _buildDelayPlan(cache, rt, vehicle, key) {
    const n = cache.stops.length;
    const dyn = this._dynFor(vehicle);
    const vmax = this._vmaxOf(vehicle);
    const baseDwell = Math.max(0, Number(this.config.dwellSeconds) || 0);
    const terminalDwell = baseDwell + Math.max(0, Number(this.config.terminalDwellSeconds) || 0);
    const scheduled = this._usesSchedule(cache) && rt.runActive && rt.direction > 0 && rt.scheduledDepartureMs != null;
    if (this._usesSchedule(cache) && !scheduled) return null;   // 班次车不在正班（等点 / 回场）：不比时刻表
    if (scheduled) {
      const table = this._runTable(cache, rt.scheduledDepartureMs, vehicle);
      if (!table || !table.stops.length) return null;
      const stops = [];
      for (const s of table.stops) {
        if (s.loopClose) continue;
        stops.push({
          idx: s.idx, stationId: s.stationId, name: s.name, distance: s.distance,
          plannedArrivalMs: table.dayStartMs + s.arrivalSec * 1000,
          plannedDepartureMs: table.dayStartMs + s.departureSec * 1000,
          observed: false,
        });
      }
      return { key, source: 'timetable', departureMs: rt.scheduledDepartureMs, stops, slack: 0, builtAtMs: this.clockMs };
    }
    // ── 自由发车：自编时刻表 ──
    const originIdx = rt.direction > 0 ? 0 : Math.max(0, n - 1);
    const originStop = cache.stops[originIdx] || null;
    const legStartMs = rt.legStartMs == null ? this.clockMs : rt.legStartMs;
    const legStartDist = rt.legStartDistance == null ? rt.distance : rt.legStartDistance;
    const atOrigin = !!originStop && Math.abs(originStop.distance - legStartDist) <= ARRIVE_EPS * 2;
    // 起点站的**计划到站时刻**：优先用上一趟计划在这里的到站时刻 —— 晚点就是这样一趟趟传下去的
    //（上一趟晚到 90 秒，这一趟的计划发车也就往后挪 90 秒）；没有上一趟（刚上线/刚改派）
    // 就用这辆车**实际到这一站的时刻**，于是"在起点站多停了一会儿"会算成发车晚点。
    let plannedArr = null;
    if (atOrigin && rt.prevDelayPlan && rt.prevDelayPlan.stops) {
      const pe = rt.prevDelayPlan.stops.find((s) => Number(s.stationId) === Number(originStop.stationId));
      if (pe) plannedArr = pe.plannedArrivalMs;
    }
    if (plannedArr == null) {
      plannedArr = (atOrigin && rt.servedAtMs != null && rt.state === 'dwell') ? rt.servedAtMs : legStartMs;
    }
    // 计划发车 = 计划到站 + 终点站整备时间（跟 _dock 的 dwellSeconds + terminalDwellSeconds 同口径）。
    // 实际发车比它早（自由发车没有时刻表，"早发"没有意义）时，后面的偏差一律按 0 处理（见 _recordStopObs）。
    const plannedDep = plannedArr + terminalDwell * 1000;
    const fromM = atOrigin ? originStop.distance : rt.distance;
    const stops = [];
    if (atOrigin) {
      stops.push({
        idx: originIdx, stationId: originStop.stationId, name: originStop.name, distance: originStop.distance,
        plannedArrivalMs: plannedArr, plannedDepartureMs: plannedDep, observed: false, origin: true,
      });
    }
    const ahead = this._stopsAheadFrom(cache, fromM, rt.direction);
    const slack = this._planSlack();
    let t = plannedDep;
    let prevM = fromM;
    const v0 = atOrigin ? 0 : Math.max(0, rt.speed || 0);
    for (let i = 0; i < ahead.length; i++) {
      const { st, idx } = ahead[i];
      const remain = Math.abs(st.distance - prevM);
      const limit = this._segSpeed(cache.path, prevM);
      const vT = Math.min(vmax, limit ? limit / 3.6 : vmax);
      const runSec = i === 0
        ? this._travelToStopSec(remain, v0, vT, dyn)
        : this._segmentStopSec(cache, prevM, st.distance, vmax, dyn);
      t += runSec * (1 + slack) * 1000;
      const isTerminal = idx === 0 || idx === n - 1;
      const dwell = isTerminal ? terminalDwell : baseDwell;
      stops.push({
        idx, stationId: st.stationId, name: st.name, distance: st.distance,
        plannedArrivalMs: t, plannedDepartureMs: t + dwell * 1000, observed: false,
      });
      t += dwell * 1000;
      prevM = st.distance;
    }
    return { key, source: 'self', departureMs: plannedDep, stops, slack, builtAtMs: this.clockMs };
  }

  /**
   * 记一条"某一站实际 vs 计划"的记录（晚点系统的原子操作）。
   * extra.cause 可以指定"起点站发车"这类成因；其余成因按区间里真实发生的事判（见文件头 ③）。
   */
  _recordStopObs(cache, rt, plan, entry, arrivedAtMs, departedAtMs, extra) {
    entry.observed = true;
    if (!Array.isArray(rt.delayHistory)) rt.delayHistory = [];   // 老运行时对象/测试里手搓的 rt 兜底
    const clamp = plan.source === 'self';      // 自由发车：只报晚点，不报早点（负数按 0）
    const rawArr = (arrivedAtMs - entry.plannedArrivalMs) / 1000;
    const rawDep = (departedAtMs - entry.plannedDepartureMs) / 1000;
    // 起点站"到达"就是"发车"（起点站的到站偏差没有意义）：两个数都按发车偏差算
    const arrDelay = clamp ? Math.max(0, entry.origin ? rawDep : rawArr) : (entry.origin ? rawDep : rawArr);
    const depDelay = clamp ? Math.max(0, rawDep) : rawDep;
    const trendSec = this._trendSeconds();
    const prev = rt.delayHistory.length ? rt.delayHistory[rt.delayHistory.length - 1] : null;
    const blockedSec = Math.max(0, ((rt.blockedMs || 0) - (rt.blockedMsAtStop || 0)) / 1000);
    // #3 公交的"拥堵时间"：这一段（上一站 → 这一站）里，车被**道路网给出的限速**压在自己最高速
    //    之下的累计游戏秒（_stepVehicleBody 里按小步累加）。公交不再被前车压住，所以它的晚点
    //    成因就记成 congestion（拥堵），而不是 blocked。
    const congestSec = Math.max(0, ((rt.congestMs || 0) - (rt.congestMsAtStop || 0)) / 1000);
    const bus = isBusVehicle(rt.veh);
    const dwellSec = Math.max(0, (departedAtMs - arrivedAtMs) / 1000);
    const plannedDwellSec = Math.max(0, (entry.plannedDepartureMs - entry.plannedArrivalMs) / 1000);
    const boardExcessSec = Math.max(0, dwellSec - plannedDwellSec);
    const delta = depDelay - (prev ? prev.departureDelaySeconds : depDelay);
    let cause;
    if (extra && extra.cause) cause = extra.cause;
    // #3 公交（用户口径）：**永远不会是 blocked** —— 净距对公交根本不生效（见 _enforceSpacing），
    // blockedMs 也不会涨。它慢下来的唯一外部原因是道路网（限速 × #16 拥堵系数），
    // 所以"这一段被道路压着走过 且 确实晚了"的成因记成 congestion，而不是含混的 delayed。
    // 轨道车一个字没改：还是 blocked。
    else if (blockedSec >= trendSec) cause = bus ? (congestSec >= trendSec ? 'congestion' : 'delayed') : 'blocked';
    else if (boardExcessSec >= trendSec) cause = 'boarding';
    else if (delta > trendSec) cause = bus && congestSec >= trendSec ? 'congestion' : 'delayed';
    else if (delta < -trendSec) cause = 'recovered';
    else if (depDelay > this._onTimeSeconds()) cause = bus && congestSec >= trendSec ? 'congestion' : 'delayed';
    else if (depDelay < -this._onTimeSeconds()) cause = 'early';
    else cause = 'on-time';
    const rec = {
      seq: (prev ? prev.seq : 0) + 1,
      stationId: entry.stationId, name: entry.name, idx: entry.idx,
      origin: !!entry.origin,
      // 时刻都是**游戏时钟毫秒**；紧接着的 HH:MM 是同一时刻的"当天几点几分"（客户端直接显示）
      arrivalMs: Math.round(arrivedAtMs), departureMs: Math.round(departedAtMs),
      plannedArrivalMs: Math.round(entry.plannedArrivalMs), plannedDepartureMs: Math.round(entry.plannedDepartureMs),
      arrivalTime: secToHHMM((arrivedAtMs % 86400000) / 1000),
      departureTime: secToHHMM((departedAtMs % 86400000) / 1000),
      plannedArrivalTime: secToHHMM((entry.plannedArrivalMs % 86400000) / 1000),
      plannedDepartureTime: secToHHMM((entry.plannedDepartureMs % 86400000) / 1000),
      // 记录里的 delaySeconds 跟车上的 delaySeconds 同一个口径：**离开这一站时的偏差**
      //（它才会带到下一站去）；到站偏差单独放在 arrivalDelaySeconds 里。
      delaySeconds: Math.round(depDelay), departureDelaySeconds: Math.round(depDelay),
      arrivalDelaySeconds: Math.round(arrDelay),
      dwellSeconds: Math.round(dwellSec), plannedDwellSeconds: Math.round(plannedDwellSec),
      blockedSeconds: Math.round(blockedSec),
      // #3 公交的拥堵时间（游戏秒）：这一段里被道路限速压着走的时长；非公交恒为 0
      congestionSeconds: Math.round(congestSec),
      source: plan.source, cause,
    };
    rt.delayHistory.push(rec);
    const limit = Math.max(4, Number(this.config.delayHistoryLimit) || DEFAULTS.delayHistoryLimit);
    if (rt.delayHistory.length > limit) rt.delayHistory.splice(0, rt.delayHistory.length - limit);
    rt.delaySeconds = Math.round(depDelay * 10) / 10;
    rt.delaySource = plan.source;
    rt.peakDelaySeconds = Math.max(rt.peakDelaySeconds || 0, rt.delaySeconds);
    const onTimeSec = this._onTimeSeconds();
    rt.delayTrend = delta > trendSec ? 'worsening' : (delta < -trendSec ? 'recovering' : 'stable');
    rt.recoveredSeconds = Math.max(0, Math.round(((rt.peakDelaySeconds || 0) - rt.delaySeconds) * 10) / 10);
    rt.recovered = (rt.peakDelaySeconds || 0) >= onTimeSec && rt.delaySeconds <= onTimeSec;
    rt.blockedMsAtStop = rt.blockedMs || 0;
    rt.congestMsAtStop = rt.congestMs || 0;     // #3 公交的"本区间拥堵时间"也在这里归零
    return rec;
  }

  /**
   * 起点站发车那一条记录：实际发车时刻跟本趟计划发车时刻比。
   * 班次车在这一步等于"晚点发车"（车已经到点还晚发）；自由发车则是"上一站办完已经晚了这么多"。
   */
  _recordDeparture(cache, rt, plan) {
    const entry = plan.stops.find((s) => s.origin) || (plan.source === 'timetable' ? plan.stops[0] : null);
    if (!entry || entry.observed) return null;
    // 实际发车时刻：班次车就是"现在"（到点发车）；自由发车是这一趟的实际出发时刻
    // （还在终点站上下客时就是停站结束的时刻 dwellUntil，它已经含了上下客多停的时间）
    const atMs = plan.source === 'timetable' ? this.clockMs
      : (rt.state === 'dwell' && rt.dwellUntil ? rt.dwellUntil
        : (rt.legStartMs == null ? this.clockMs : rt.legStartMs));
    const grace = Math.max(500, Math.max(0, Number(this.config.delayDepartureGraceSeconds) || 0) * 1000);
    const late = (atMs - entry.plannedDepartureMs) > grace;
    // 到站时刻用真实的进站时刻（有的话），这样记录里的"停站时间 / 计划停站时间"是可比的
    const arrivedMs = (rt.state === 'dwell' && rt.servedAtMs != null) ? rt.servedAtMs : atMs;
    return this._recordStopObs(cache, rt, plan, entry, arrivedMs, atMs, { cause: late ? 'departure' : null });
  }

  /** 办完一站：实际到站/发车时刻 vs 计划 → delayHistory + delaySeconds / delayTrend / recovered */
  _recordDelay(vehicle, cache, rt, stop, arrivedAtMs, departedAtMs) {
    if (!vehicle || !cache || !rt || !stop) return null;
    const plan = this._ensureDelayPlan(cache, rt, vehicle);
    if (!plan) return null;
    const entry = plan.stops.find((s) => !s.observed && Number(s.stationId) === Number(stop.stationId));
    if (!entry) return null;
    return this._recordStopObs(cache, rt, plan, entry, arrivedAtMs, departedAtMs, null);
  }

  /** 一辆车的晚点字段（紧凑，快照每帧要用的那几项） */
  _delayFields(rt) {
    if (!rt || rt.delaySeconds == null) {
      return { delaySeconds: null, delayTrend: 'stable', recovered: false, peakDelaySeconds: null, delaySource: null };
    }
    return {
      delaySeconds: Math.round(rt.delaySeconds),
      delayTrend: rt.delayTrend || 'stable',
      recovered: !!rt.recovered,
      peakDelaySeconds: Math.round(rt.peakDelaySeconds || 0),
      delaySource: rt.delaySource || null,
    };
  }

  /** 一条线路现在的准点情况（NIMBY Rails 的 punctuality 口径） */
  _lineDelayAgg(cache) {
    const onTimeSec = this._onTimeSeconds();
    const agg = {
      onTimeRate: null, avgDelaySeconds: 0, maxDelaySeconds: 0,
      tracked: 0, onTimeVehicles: 0, lateVehicles: 0, earlyVehicles: 0, recoveredVehicles: 0,
      worstVehicleId: null, onTimeSeconds: onTimeSec,
    };
    const ids = (cache && cache.vehicleIds) || [];
    let sum = 0;
    for (const id of ids) {
      const rt = this.runtime.get(id);
      if (!rt || rt.delaySeconds == null) continue;
      agg.tracked += 1;
      sum += rt.delaySeconds;
      if (rt.delaySeconds > agg.maxDelaySeconds) { agg.maxDelaySeconds = rt.delaySeconds; agg.worstVehicleId = id; }
      if (rt.delaySeconds > onTimeSec) agg.lateVehicles += 1;
      else if (rt.delaySeconds < -onTimeSec) agg.earlyVehicles += 1;
      else agg.onTimeVehicles += 1;
      if (rt.recovered) agg.recoveredVehicles += 1;
    }
    if (agg.tracked) {
      agg.onTimeRate = Math.round((agg.onTimeVehicles / agg.tracked) * 1000) / 1000;
      agg.avgDelaySeconds = Math.round(sum / agg.tracked);
    }
    agg.maxDelaySeconds = Math.round(agg.maxDelaySeconds);
    return agg;
  }

  /** 全网车辆晚点的一行汇总（快照里的精简版） */
  _fleetDelayStats() {
    const onTimeSec = this._onTimeSeconds();
    const out = {
      tracked: 0, onTimeVehicles: 0, lateVehicles: 0, earlyVehicles: 0, recoveredVehicles: 0,
      onTimeRate: null, avgDelaySeconds: 0, maxDelaySeconds: 0, worstVehicleId: null, onTimeSeconds: onTimeSec,
    };
    let sum = 0;
    for (const [vehicleId, rt] of this.runtime) {
      if (!rt || rt.delaySeconds == null) continue;
      out.tracked += 1;
      sum += rt.delaySeconds;
      if (rt.delaySeconds > out.maxDelaySeconds) { out.maxDelaySeconds = rt.delaySeconds; out.worstVehicleId = vehicleId; }
      if (rt.delaySeconds > onTimeSec) out.lateVehicles += 1;
      else if (rt.delaySeconds < -onTimeSec) out.earlyVehicles += 1;
      else out.onTimeVehicles += 1;
      if (rt.recovered) out.recoveredVehicles += 1;
    }
    if (out.tracked) {
      out.onTimeRate = Math.round((out.onTimeVehicles / out.tracked) * 1000) / 1000;
      out.avgDelaySeconds = Math.round(sum / out.tracked);
    }
    out.maxDelaySeconds = Math.round(out.maxDelaySeconds);
    return out;
  }

  /**
   * 这条线"现在有没有车在服务"。
   * 班次表模式（headway / timetable）下**只在发车时刻发车**，所以"车在首站等点"是常态，
   * 而"现在线上一个在跑的车都没有"也完全是正常状态（没车 / 车不够 / 不在运营时段）——
   * 这里如实报出来（noServiceNow + 原因 + 下一班几点），前端就能明确说明"不是坏了，是没车"。
   *
   * #3 暂停运营：`paused=true`，并且这时 **noServiceNow 一定为 true**（这条线现在不提供服务：
   * 不会再有新车发出）—— 与之配套的 reason 是 'paused'，note 说清"已经在路上的车会跑完这一趟"。
   * `inService` 仍然是**如实的**：暂停那一刻已经在跑的那一趟不算被打断，它会跑完回到首站再收车，
   * 所以暂停后的一段时间里 inService 可能还是 1（车确实还在路上，只是跑完就停）。
   */
  _lineService(cache) {
    const paused = !!(cache && cache.paused);
    const mode = (cache && cache.schedule ? cache.schedule.mode : 'free');
    const vehicleIds = (cache && cache.vehicleIds) || [];
    const noteOf = (reason) => reason === 'paused' ? '这条线已暂停运营：不会再有新车发出，已经在路上的车会跑完这一趟再收车'
      : reason === 'no-vehicles' ? '这条线上没有车，所以现在没有班次发出（这是正常的，不是故障）'
        : reason === 'outside-service-hours' ? '当前不在运营时段（今天已经没有班次了）'
          : reason === 'waiting-for-departure' ? '所有车都在始发站等下一班的发车时刻'
            : '有车正在按班次运行';
    if (mode === 'free') {
      return {
        mode: 'free', paused, noServiceNow: paused, reason: paused ? 'paused' : null,
        vehicles: vehicleIds.length, inService: 0, waiting: 0,
        nextDeparture: null, nextDepartureSec: null, nextDepartureMs: null,
        note: paused ? noteOf('paused') : '自由发车：车一直在线路上跑，不看时刻表',
      };
    }
    let inService = 0;
    let waiting = 0;
    let nextMs = null;
    for (const id of vehicleIds) {
      const rt = this.runtime.get(id);
      if (!rt) { waiting += 1; continue; }               // 还没上线（下一小步才排班）
      if (rt.runActive) { inService += 1; continue; }
      waiting += 1;
      if (rt.departureMs != null && (nextMs == null || rt.departureMs < nextMs)) nextMs = rt.departureMs;
    }
    const dayStart = Math.floor(this.clockMs / 86400000) * 86400000;
    if (nextMs == null) {
      const tod = (this.clockMs - dayStart) / 1000;
      const list = this._lineDepartures(cache);
      for (let j = 0; j < list.length; j++) {
        if (list[j] + 1e-6 < tod) continue;
        if (this._departureVehicleId(cache, j) == null) continue;   // 这一班没人开
        nextMs = dayStart + list[j] * 1000;
        break;
      }
    }
    // 暂停运营：不会有下一班（恢复运营时才按时刻表重新排，见 _resumeLine）
    if (paused) nextMs = null;
    const reason = paused ? 'paused'
      : !vehicleIds.length ? 'no-vehicles'
        : (inService > 0 ? null : (nextMs == null ? 'outside-service-hours' : 'waiting-for-departure'));
    return {
      mode, paused, noServiceNow: paused ? true : inService === 0, reason,
      vehicles: vehicleIds.length, inService, waiting,
      nextDepartureMs: nextMs,
      nextDepartureSec: nextMs == null ? null : (nextMs - dayStart) / 1000,
      nextDeparture: nextMs == null ? null : secToHHMM((nextMs - dayStart) / 1000),
      note: noteOf(reason),
    };
  }

  /**
   * 某辆车这一刻的行程信息（快照每帧都要，所以必须便宜）：
   *   nextStop            下一站 { stationId, name, idx, remainM, distance }
   *   etaSeconds          预计还有多少**游戏秒**到下一站（当前速度 + 车型加减速 + 路段限速）
   *   scheduledDeparture  本趟的计划发车时刻（游戏毫秒；自由发车 = null）
   *   scheduleLag         相对时刻表的晚点秒数（正数 = 比表晚，负数 = 早；自由发车 = null）
   *   remainingStops      #19 本趟剩下每一站的到站/发车时刻（自由发车也有，见 _remainingStops）
   *   delaySeconds 等    #19 晚点系统的字段（自由发车拿"自编时刻表"当基准，见 _recordStopObs）
   */
  _tripInfo(vehicle, cache, rt) {
    const empty = {
      nextStop: null, etaSeconds: null, scheduledDeparture: null, scheduledDepartureTime: null, scheduleLag: null,
      remainingStops: [], delaySeconds: null, delayTrend: 'stable', recovered: false, peakDelaySeconds: null,
      delaySource: null,
    };
    if (!vehicle || !cache || !rt) return empty;
    // 还没经过第一个模拟小步的车（快照可能在 tick 之前就来问）：这里补一次排班，
    // 免得"车辆详情里的下一班"要等到下一次 tick 才有值。
    if (this._usesSchedule(cache) && rt.departureMs === undefined) {
      rt.departureMs = this._nextDepartMs(cache, vehicle.id, null);
      rt.scheduledDepartureMs = null;
      rt.runActive = false;
    }
    const dyn = this._dynFor(vehicle);
    const vmax = this._vmaxOf(vehicle);
    const paused = !!cache.paused;      // #3 暂停运营：车停在首站，不会有发车时刻
    // 在首站等点发车的车：下一站就是脚下的首站，"还要多久"= 距离发车还有多久
    //（暂停运营的车同样"下一站 = 首站"，但它不会发车，所以 etaSeconds 给 null）
    const waiting = this._usesSchedule(cache) && !rt.runActive && (rt.departureMs != null || paused);
    let target = waiting ? (cache.stops[0] || null) : this._nextStop(cache, rt.distance, rt.direction);
    const remain = target ? Math.abs(target.distance - rt.distance) : null;
    let etaSeconds = null;
    if (target) {
      if (waiting) etaSeconds = (paused && !rt.runActive) ? null : Math.max(0, Math.round((rt.departureMs - this.clockMs) / 1000));
      else if (!(remain > ARRIVE_EPS)) etaSeconds = 0;
      else {
        const limit = this._segSpeed(cache.path, rt.distance);
        const vT = Math.min(vmax, limit ? limit / 3.6 : vmax);
        // 与逐站预测同一个口径（含 DEFAULTS.dockAllowanceSeconds 的到站余量），两者数字对得上
        etaSeconds = Math.round(this._travelToStopSec(remain, rt.speed, vT, dyn));
      }
    }
    const out = {
      nextStop: target
        ? {
          stationId: target.stationId, name: target.name, idx: target.idx,
          remainM: Math.round(remain || 0), distance: Math.round(target.distance),
        }
        : null,
      etaSeconds, scheduledDeparture: null, scheduledDepartureTime: null, scheduleLag: null,
      // #19 逐站预测 + 晚点（自由发车也有；数组是缓存复用的，不在这里新建）
      remainingStops: this._remainingStops(cache, rt, vehicle),
      ...this._delayFields(rt),
    };
    // #19 本趟计划：车还没停过站时也要有（起点站的发车偏差就是这么来的）；
    // 建计划很便宜（一趟一次），而且 remainingStops 的缓存不受它影响。
    if (out.delaySeconds == null) {
      this._ensureDelayPlan(cache, rt, vehicle);
      Object.assign(out, this._delayFields(rt));
    }
    if (this._usesSchedule(cache)) {
      // 等点发车时报"下一班的计划发车时刻"；跑起来之后报"这一趟的计划发车时刻"。
      // 暂停运营的车**没有**计划发车时刻（它不会发车），这里如实报 null。
      const dep = rt.runActive ? rt.scheduledDepartureMs : (paused ? null : rt.departureMs);
      if (dep != null) {
        out.scheduledDeparture = Math.round(dep);
        out.scheduledDepartureTime = secToHHMM((dep % 86400000) / 1000);
      }
      if (rt.scheduledDepartureMs != null && rt.direction > 0) {
        // 只在这一趟的**去程**上比时刻表：回场段（从末站开回首站）不在时刻表里，
        // 拿它去比"中间站的计划到站"会报出一个毫无意义的晚点数。
        const table = this._runTable(cache, rt.scheduledDepartureMs, vehicle);
        const planSec = table && target ? this._timetableArrivalSec(table, target.stationId) : null;
        if (planSec != null && etaSeconds != null) {
          const planMs = table.dayStartMs + planSec * 1000;
          out.scheduleLag = Math.round((this.clockMs + etaSeconds * 1000 - planMs) / 1000);
        }
      }
    }
    return out;
  }

  /**
   * 这辆车"下一趟该几点发车"（游戏时钟毫秒）。
   * 发车班次在线上的车之间轮转（见 _runPlan）：没指定车辆时第 j 班给第 (j % 车数) 辆车，
   * 所以流水班时线上相邻两班车的间隔就是 headwaySec；**被指定到某几班上的车只等那几班**
   * （指定表在 _runPlan 里统一算，口径只有一处）。
   * 今天的班次都发完了 → 顺延到明天的第一班（车就在始发站过夜）。
   * 返回 null = 这条线上今天/明天都没有分给本车的班次（车比班次多、班次表为空、
   * 或者这辆车已经不在线上了 —— 它被改派走之后不该再等这条线的班）。
   */
  _nextDepartMs(cache, vehicleId, afterSec) {
    const list = this._lineDepartures(cache);
    if (!list.length) return null;
    const nowMs = this.clockMs;
    const dayStart = Math.floor(nowMs / 86400000) * 86400000;
    const tod = afterSec == null ? (nowMs - dayStart) / 1000 : afterSec;
    const pick = (from) => {
      for (let j = 0; j < list.length; j++) {
        if (list[j] + 1e-6 < from) continue;
        if (this._departureVehicleId(cache, j) !== vehicleId) continue;
        return list[j];
      }
      return null;
    };
    let t = pick(tod);
    let dayOffset = 0;
    if (t == null) { t = pick(0); dayOffset = 1; }
    if (t == null) return null;      // 车数比班次数还多（或这辆车没被排上班）：这辆车今天没有班
    return dayStart + (t + dayOffset * DAY_SEC) * 1000;
  }

  /**
   * 线路按班次运行时，车该在哪（给前端显示"下一班 / 今天还剩几班"）。
   * #4 的"每个班次指定车辆"也报在这里：assignmentsRequested = 玩家填了几个班次的指定车，
   * assignmentsMissed = 其中**没能满足**的班次数（指定的车在别处忙 / 已被删 → 那一班退回轮转）；
   * 每一班具体是哪些没满足、指定的是哪辆车，看 linePublic().runs[] 的
   * pinnedVehicleId / assignmentMissed（runs[].index 就是填 assignments 用的那个下标）。
   */
  scheduleInfo(line, cache) {
    const s = this.lineSchedule(line);
    // 自由发车没有班次，也就没有"班次指定车辆"可言（parseSchedule 会把 free 的 assignments 丢掉）
    if (s.mode === 'free') {
      return { mode: 'free', assignmentsRequested: 0, assignmentsMissed: 0, note: '自由发车（没有班次表）' };
    }
    const list = cache ? this._lineDepartures(cache) : [];
    const plan = cache ? this._runPlan(cache) : null;
    const nowMs = this.clockMs;
    const dayStart = Math.floor(nowMs / 86400000) * 86400000;
    const tod = (nowMs - dayStart) / 1000;
    const next = list.filter((t) => t + 1e-6 >= tod).slice(0, 6).map((t) => secToHHMM(t));
    const vehicles = cache ? (cache.vehicleIds || []).length : 0;
    return {
      mode: s.mode,
      headwaySec: s.mode === 'headway' ? s.headwaySec : null,
      firstSec: s.mode === 'headway' ? s.firstSec : (list.length ? list[0] : null),
      lastSec: s.mode === 'headway' ? s.lastSec : (list.length ? list[list.length - 1] : null),
      firstTime: list.length ? secToHHMM(list[0]) : null,
      lastTime: list.length ? secToHHMM(list[list.length - 1]) : null,
      // 当天班次总数 / 线上车辆数 / 发车间隔（多条车时每辆车隔多久跑一趟）
      departuresPerDay: list.length,
      vehicles,
      vehicleHeadwaySec: s.mode === 'headway' ? s.headwaySec * Math.max(1, vehicles) : null,
      nextDepartures: next,
      // #4：指定了几个班次的车辆、其中几个没满足（车在别处忙/没了 → 那一班退回默认轮转）
      assignmentsRequested: plan ? plan.assigned : 0,
      assignmentsMissed: plan ? plan.missed.length : 0,
      note: s.mode === 'headway'
        ? `流水班：每 ${s.headwaySec} 秒一班，${secToHHMM(s.firstSec)} ~ ${secToHHMM(s.lastSec)}`
        : `定班车：一天 ${list.length} 班，首班 ${list.length ? secToHHMM(list[0]) : '—'}，末班 ${list.length ? secToHHMM(list[list.length - 1]) : '—'}`,
    };
  }

  /**
   * 给线路加站时自动把"不在线路上"的车站吸附到线路路径上，
   * 这样就不会出现"加了站却提示路径不通"。返回吸附记录。
   */
  snapStopsToLine(line, stops) {
    const cache = this.lineCache.get(line.id);
    const snapped = [];
    if (!cache || !cache.path.length || stops.length < 3) return snapped;
    const onPath = new Set(cache.path.map((p) => p.id));
    // 只检查新加进来的站（既不在路径上、也不是首站）
    for (let i = 1; i < stops.length; i++) {
      const st = this._st.station.get(stops[i]);
      if (!st || !st.node_id || onPath.has(st.node_id)) continue;
      // 车站没有归属：导入站和自建站一样，为了"加进来就能通车"照样替它吸附到线路路径上
      //（原来这里有一条"公共车站只读，不替玩家挪动它"的特判，已经按用户要求删掉）。
      let best = null;
      let bestD = 1500;   // 最多吸附 1.5 公里
      for (const p of cache.path) {
        const d = metersBetween(st.lat, st.lon, p.lat, p.lon);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best) continue;
      this._st.updateStation.run(st.name, st.kind, st.platform_m, st.catchment_m, best.id, st.way_id, best.lat, best.lon, st.id);
      this._dropDemandCache(st.id);     // 车站挪了位置：覆盖范围要重算
      snapped.push({ stationId: st.id, name: st.name, distance: Math.round(bestD) });
      onPath.add(best.id);
    }
    return snapped;
  }

  createLine(user, op) {
    const c = this.ensureCompany(user, op.companyId);
    const name = String(op.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32) || '新线路';
    const color = /^#[0-9a-f]{6}$/i.test(String(op.color || '')) ? op.color : '#e6194b';
    const kind = LINE_KINDS.has(op.kind) ? op.kind : 'rail';
    let stops = Array.isArray(op.stops) ? op.stops.map(Number).filter(Number.isFinite) : [];
    // 车站没有归属：谁的车站（含底图导入的）都能加进自己的线路，_usableStop 只看"这站还在不在"
    stops = stops.filter((id) => this._usableStop(this._st.station.get(id), c.id, user.id));
    const res = this._st.insertLine.run(c.owner, c.id, name, color, kind, JSON.stringify(stops), op.loop ? 1 : 0, Date.now());
    const lineId = Number(res.lastInsertRowid);
    this._dropOdCache();          // 线路集合变了：O/D 需求表要重算
    // #18 班次：新建线路时就能直接给（格式不合法会抛中文原因）
    if (op.schedule !== undefined && op.schedule !== null) {
      const parsed = parseSchedule(op.schedule);
      this._storeSchedule(this._st.line.get(lineId), parsed);
    }
    const rebuilt = this.rebuildPath(lineId);
    this._pushUndo(user.id, { label: `新建线路「${name}」`, steps: [{ table: 'lines', id: lineId, mode: 'delete' }] });
    this.onChanged('line', lineId);
    return { line: this.linePublic(this._st.line.get(lineId)), path: rebuilt };
  }

  updateLine(user, op) {
    const line = this._st.line.get(Number(op.id));
    if (!line) throw new TransitError('线路不存在');
    // 协作编辑：别人建的线路也能改（改名 / 换色 / 改站序 / 改班次），只有"有人正在编辑"时才挡
    this.checkElementLock(user, 'line', line.id);
    const before = this._row('lines', line.id);
    const patch = {};
    if (op.name !== undefined) {
      // 改名：控制字符抹掉、首尾空白去掉、最多 32 个字（与客户端「✏ 改名」的校验同一口径）。
      // 清完是空的话**明确报错**，而不是默默留着老名字 —— 否则玩家会以为"改成功了"。
      const name = String(op.name == null ? '' : op.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32);
      if (!name) throw new TransitError('线路名不能为空（去掉首尾空格与控制字符后要有内容）', 'BAD_ARG');
      patch.name = name;
    }
    if (op.color !== undefined && /^#[0-9a-f]{6}$/i.test(String(op.color))) patch.color = op.color;
    if (op.kind !== undefined && LINE_KINDS.has(op.kind)) patch.kind = op.kind;
    if (op.loop !== undefined) patch.loop = op.loop;
    // #18 班次：op.schedule 给了就校验并写库（null / {mode:'free'} = 清掉班次表，恢复自由发车）
    if (op.schedule !== undefined) {
      const parsed = parseSchedule(op.schedule);
      patch.schedule = parsed.mode === 'free' ? null : JSON.stringify(parsed);
    }
    let snapped = [];
    if (op.stops !== undefined) {
      if (!Array.isArray(op.stops)) throw new TransitError('站点列表格式不正确');
      patch.stops = op.stops.map(Number).filter((id) => this._usableStop(this._st.station.get(id), line.company_id, user.id));
      // 新加的站如果不在线路上，先吸附到线路路径上（避免"路径不通"）
      snapped = this.snapStopsToLine(line, patch.stops);
    }
    // 被摘掉的站：那条线在这个站排的队不能留成"永远等不到车的幽灵队伍"，
    // 而是搬进兜底桶（谁的车来都能上）。必须在写库前算好差集，之后 stops 就变了。
    const beforeStops = this._parseStops(line.stops);
    this._writeLine(line, patch);
    if (op.stops !== undefined) {
      const after = new Set(patch.stops.map(Number));
      const removed = beforeStops.filter((id) => !after.has(Number(id)));
      if (removed.length) this._reassignLineQueue(line.id, removed);
    }
    this._dropOdCache();          // 站序 / 班次变了：O/D 需求表要重算
    const rebuilt = this.rebuildPath(line.id);
    // 站序变了还要把候车台账扫一遍：被摘掉的站在上面已经搬过桶，但**路径重建也可能把某一站
    // 从停靠序列里丢掉**（rebuildPath 找不到那一站的节点时会跳过它），那种"线上有站、车不停"
    // 的站同样不能再挂着这条线的候车队伍（见 _sweepStationQueues）。
    this._sweepStationQueues();
    this._pushUndo(user.id, { label: `修改线路「${patch.name || line.name}」`, steps: [{ table: 'lines', id: line.id, mode: 'restore', row: before }] });
    this.onChanged('line', line.id);
    return { line: this.linePublic(this._st.line.get(line.id)), path: rebuilt, snapped };
  }

  deleteLine(user, op) {
    const line = this._st.line.get(Number(op.id));
    if (!line) throw new TransitError('线路不存在');
    // 协作编辑：别人建的线路也能删（挂在这条线上的车辆会被摘下来，见下面的 steps）
    this.checkElementLock(user, 'line', line.id);
    const steps = [{ table: 'lines', id: line.id, mode: 'restore', row: this._row('lines', line.id) }];
    for (const v of this._st.vehiclesOnLine.all(line.id)) {
      steps.push({ table: 'vehicles', id: v.id, mode: 'restore', row: this._row('vehicles', v.id) });
      this._st.updateVehicle.run(null, v.name, v.cars, v.capacity_per_car, v.max_speed, v.id);
      this.runtime.delete(v.id);
      this._fleetUpsert(v.id);        // #规模：车从这条线摘下来 → 内存车队里也退出 running 索引
    }
    this._st.delLine.run(line.id);
    this._dropOdCache();          // 少了一条线：有些 O/D 从此走不通了
    this.lineCache.delete(line.id);
    this.lineStatsAcc.delete(line.id);   // 日报历史留在库里，内存里的当日累计清掉
    // 这条线各站桶里还在等的人搬进兜底桶：线路没了，但不该把乘客一起吞掉
    // （他们从此哪条线来车都能上，直到耐心用完自己走）
    this._reassignLineQueue(line.id);
    // 再扫一遍：别的线桶里那些"行程后半段要换乘这条刚被删掉的线"的乘客，
    // 行程当场作废（降级成"只知道目的站"），免得他们坐到换乘站才发现那条线不存在
    //（车上已经载着的那批人在 _alightAt 里同样会被 _addWaiting 的守卫接住）。
    this._sweepStationQueues();
    this._pushUndo(user.id, { label: `删除线路「${line.name}」`, steps });
    this.onChanged('line', line.id);
    return { deleted: line.id, name: line.name };
  }

  /**
   * transit op：line.transfer { id, companyId, withVehicles? } —— **线路归属转移**。
   * 把一条线路转到另一家公司名下（那家公司可以是**别的玩家**的：协作规则下谁都能动谁的资产）。
   *   · id          要转移的线路
   *   · companyId   目标公司（必须已经存在，否则给一句明确的中文错误，不自作主张新建）
   *   · withVehicles 可选，true = 把**现在派在这条线上**的车一起转过去（owner / company_id 跟着换）。
   *                 默认 false：只转线路，车辆留在原来的公司（车照样能跑这条线，这是协作编辑允许的）。
   *                 目标公司就是线路现在的公司时，整条 op 是空操作（不记撤销、不动车辆）。
   * 转移之后：
   *   · 线路的 owner / company_id 变成新公司，路径重算（cache.queueCompanyId / companyOwner 也跟着换，
   *     于是票款、上车结算都记在新公司账上）；
   *   · 这条线在各站的**候车队伍搬到新公司名下**（人一个不少、等待计时继续走）—— 不搬的话
   *     他们永远等不到车（车已经按新公司结算了），只能等耐心耗尽离开，见 _moveLineQueueCompany；
   *   · 记进撤销栈：Ctrl+Z 一步把线路（以及一起转过去的车）放回原来的公司。
   * 除了这些，对外**不多暴露任何东西**：返回的就是 linePublic() 的线路 + 两端的公司 + 转了几辆车。
   */
  transferLine(user, op = {}) {
    const line = this._st.line.get(Number(op.id));
    if (!line) throw new TransitError('线路不存在', 'NOTFOUND');
    const targetId = Number(op.companyId);
    if (!Number.isFinite(targetId)) {
      throw new TransitError('line.transfer 需要 companyId（转到哪家公司名下）', 'NOTFOUND');
    }
    const target = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(targetId);
    if (!target) throw new TransitError(`目标公司不存在（companyId=${targetId}）：线路归属只能转到已有的公司名下`, 'NOTFOUND');
    this.checkElementLock(user, 'line', line.id);
    const from = line.company_id == null ? null : this._st.company.get(Number(line.company_id));
    if (Number(line.company_id) === Number(target.id)) {
      return {
        line: this.linePublic(line), from: this.companyPublic(from), to: this.companyPublic(target),
        moved: false, vehiclesMoved: 0,
        note: '线路本来就属于这家公司，没有改动（也没有记撤销）',
      };
    }
    const withVehicles = op.withVehicles === true || op.withVehicles === 1 || op.withVehicles === 'true';
    const before = this._row('lines', line.id);
    const fleet = withVehicles ? this._st.vehiclesOnLine.all(line.id) : [];
    const steps = [{ table: 'lines', id: line.id, mode: 'restore', row: before }];
    // 先记车（撤销时线和车一起回到原公司；顺序不影响 restore，每一步都是整行写回）
    const fleetBefore = [];
    for (const v of fleet) {
      fleetBefore.push({ v, row: this._row('vehicles', v.id) });
      steps.push({ table: 'vehicles', id: v.id, mode: 'restore', row: this._row('vehicles', v.id) });
    }
    this.db.prepare('UPDATE lines SET owner = ?, company_id = ? WHERE id = ?').run(target.owner, target.id, line.id);
    for (const { v } of fleetBefore) {
      this.db.prepare('UPDATE vehicles SET owner = ?, company_id = ? WHERE id = ?').run(target.owner, target.id, v.id);
      this.runtime.delete(v.id);      // 换了东家：车的运行时重算（票款/线路缓存都按新公司）
      this._fleetUpsert(v.id);        // #规模：内存车队跟着换东家（车还在线路上，索引不变）
    }
    // 候车队伍跟着线路走（必须在 rebuildPath 之前做完：重建缓存时 queueCompanyId 已经变成新公司）
    const fromKey = this._companyKey(from ? from.id : null, line.owner);
    const movedPax = this._moveLineQueueCompany(line.id, fromKey, target.id, target.owner);
    // 归属也是"世界指纹"的一部分（见 _cacheStamp 里那两列 company_id / owner）：
    // 这里主动作废一次 O/D 表，别让归属变更留到下一次 tick 由指纹自检兜底 ——
    // 兜底虽然也对，但会打一行"有人绕过作废"的日志，看起来像真出了漏作废的 bug。
    this._dropOdCache();
    const rebuilt = this.rebuildPath(line.id);
    // 换公司不改站序，但 rebuildPath 可能因为路径重算把某一站丢掉（见 updateLine 里的说明）：
    // 扫一遍，保证站台上不会留下"这条线已经不服务这个站"的候车队伍
    this._sweepStationQueues();
    this._pushUndo(user.id, {
      label: `线路「${line.name}」转到「${target.name}」名下${fleet.length ? `（含 ${fleet.length} 辆车）` : ''}`,
      steps,
    });
    this.onChanged('line', line.id);
    return {
      line: this.linePublic(this._st.line.get(line.id)),
      from: this.companyPublic(from) || { owner: line.owner, name: null },
      to: this.companyPublic(target),
      moved: true,
      vehiclesMoved: fleet.length,
      passengersMoved: Math.round(movedPax),
      path: rebuilt,
    };
  }

  /**
   * transit op：line.setService { id, running:false|true } —— **一键暂停 / 恢复运营**（#3）。
   *   running:false  暂停：**不再发新车**；还没发车的车就地收车停在首站；已经在路上的车把这一趟
   *                  跑完（含回到首站）再收车；不删车、不藏车、不瞬移；站台上等车的人一个不动
   *                  （继续按耐心规则等，等太久照样会走）。
   *   running:true   恢复：按班次表重新排"现在这一刻之后的下一班"（相当于时钟刚走到下一班），
   *                  自由发车线直接回到首站重新开跑。
   * 对外：linePublic().service.paused = 暂停状态（暂停时 noServiceNow 一定为 true、reason='paused'）。
   * 记进撤销栈（一步回到暂停/恢复之前的状态），并且和其它线路 op 一样过元素锁。
   */
  setService(user, op = {}) {
    const line = this._st.line.get(Number(op.id));
    if (!line) throw new TransitError('线路不存在', 'NOTFOUND');
    if (typeof op.running !== 'boolean') {
      throw new TransitError('line.setService 需要 running:true|false（false = 暂停运营，true = 恢复运营）', 'BAD_ARG');
    }
    this.checkElementLock(user, 'line', line.id);
    const paused = !op.running;
    if (!!line.service_paused === paused) {
      const pub = this.linePublic(line);
      return {
        line: pub, service: pub.service, changed: false,
        note: paused ? '这条线本来就处于暂停运营' : '这条线本来就在正常运营',
      };
    }
    const before = this._row('lines', line.id);
    this.db.prepare('UPDATE lines SET service_paused = ? WHERE id = ?').run(paused ? 1 : 0, line.id);
    const cache = this.lineCache.get(line.id);
    if (cache) cache.paused = paused;
    if (!paused) this._resumeLine(line.id, cache || null);   // 恢复：重新排"现在之后的下一班"
    this._pushUndo(user.id, {
      label: `${paused ? '暂停' : '恢复'}运营「${line.name}」`,
      steps: [{ table: 'lines', id: line.id, mode: 'restore', row: before }],
    });
    this.onChanged('line', line.id);
    const pub = this.linePublic(this._st.line.get(line.id));
    return { line: pub, service: pub.service, changed: true };
  }

  /** 沿铁路网重算线路路径 */
  rebuildPath(lineId) {
    const line = this._st.line.get(Number(lineId));
    if (!line) return null;
    const stops = this._parseStops(line.stops);
    const stations = stops.map((id) => this._st.station.get(id)).filter(Boolean);
    this.lineCache.delete(line.id);
    if (stations.length < 2) {
      this._st.updateLine.run(line.name, line.color, line.kind, JSON.stringify(stops), line.loop, null, 0, '至少需要 2 个车站', Date.now(), line.schedule, line.id);
      return { ok: false, error: '至少需要 2 个车站' };
    }
    const missingRail = stations.filter((s) => !s.node_id);
    if (missingRail.length) {
      const err = `车站「${missingRail[0].name}」没有吸附到轨道上`;
      this._st.updateLine.run(line.name, line.color, line.kind, JSON.stringify(stops), line.loop, null, 0, err, Date.now(), line.schedule, line.id);
      return { ok: false, error: err };
    }
    const nodeIds = stations.map((s) => s.node_id);
    if (line.loop) nodeIds.push(nodeIds[0]);
    const routePlan = this.routeFor(line.kind, nodeIds);
    // ⚠ 惰性模式下 `routePlan.graph` 可能是 null（一张就绪的区域图都没有 + 跨区域被拒）——
    //    那时退回协调器本身只是为了拿到 `mode / nodes.size / wayCount` 这几个数去拼报错文案，
    //    寻路仍然用 routePlan.route 的那条 error（不会静默给一条错路径）。
    const g = (routePlan && routePlan.graph) ? routePlan.graph : this.graph(line.kind);
    const route = (routePlan && routePlan.route) ? routePlan.route : g.routeThrough(nodeIds);
    if (route.error) {
      const detail = `${route.error}（所用路网：${g.mode === 'bus' ? '道路' : '铁路'}，${g.nodes.size} 个节点 / ${g.wayCount} 条路段）`;
      this._st.updateLine.run(line.name, line.color, line.kind, JSON.stringify(stops), line.loop, null, 0, detail, Date.now(), line.schedule, line.id);
      return { ok: false, error: detail };
    }
    const path = g.pathGeometry(route.path, route.speeds);
    // 每个站在路径上的里程位置
    const stopInfo = [];
    let cursor = 0;
    for (const s of stations) {
      let bestIdx = -1;
      let bestD = Infinity;
      for (let i = cursor; i < path.length; i++) {
        if (path[i].id !== s.node_id) continue;
        const d = i - cursor;
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      if (bestIdx < 0) continue;
      cursor = bestIdx;
      // 站点覆盖人口/活跃度/密度：统一走 stationDemandOf（带缓存，口径只有一处）
      const d = this.stationDemandOf(s);
      stopInfo.push({
        stationId: s.id, name: s.name, distance: path[bestIdx].distance,
        lat: s.lat, lon: s.lon, catchmentM: s.catchment_m,
        pop: d.pop, jobs: d.jobs,
        activity: d.activity != null ? d.activity : 1,
        density: d.density, coverage: d.coverage,
        // 这一站每天产生多少乘客（覆盖人口 × 活跃度 × 出行率）
        spawnPerDay: d.dailyTrips, demand: d.demand, dailyTrips: d.dailyTrips,
        // boardPerDay / destMix 由 _refreshLineDemand 从 O/D 表填（这条线在这个站拉多少人、去哪）
        boardPerDay: 0, boardByBand: { local: 0, regional: 0, long: 0 }, destMix: [],
        platformM: s.platform_m,
      });
    }
    // 线路日客流的算法（NIMBY Rails 口径，出处见 population.js 顶部）：
    //   1) 每站日需求 = 覆盖人口 × 活跃度；每站每天产生 dailyTrips = 需求 × 出行率 个乘客（origin）
    //   2) O/D 表（_ensureOdDemand）按距离档 + 目的地权重把这些乘客分给别的车站
    //   3) 只有"起点与目的地在同一条线路上"的乘客才真的走 —— 那就是这条线在这个站的
    //      boardPerDay（每天要在这一站拉走多少人）
    //   4) 线路日客流 = Σ boardPerDay；各站 dailyTrips 的合计只是"沿线需求总量"
    this.lineCache.set(line.id, {
      path, stops: stopInfo, lengthM: route.lengthM, seconds: route.seconds,
      lineId: line.id,
      companyId: line.company_id, queueCompanyId: null, companyOwner: line.owner,
      loop: !!line.loop,
      schedule: this.lineSchedule(line),      // #18 班次（free = 自由发车；可带 #4 的 assignments）
      // #3 一键暂停运营：读线路行上的 service_paused（line.setService 改它，_writeLine/rebuildPath 都不碰）
      paused: !!line.service_paused,
      // 这条线上有哪些车：内存索引（老实现是 `SELECT * FROM vehicles WHERE line_id = ?`，
      // 每重建一条线路就查一次库；几十条线 × 重算一次 = 几十次查询）
      vehicleIds: this._fleet.vehiclesOnLine(line.id).map((v) => v.id),
      direction: 1,
      demandKey: null,     // 让 _refreshLineDemand 立刻算一次线路合计
    });
    // 候车队伍挂在哪个公司名下：优先线路所属公司；老数据（company_id 为空）退回车主的第一家公司。
    // 客流积累和上车结算必须用同一个值，否则会出现"排了队却没人上车"。
    let queueCompanyId = line.company_id != null ? line.company_id : null;
    if (queueCompanyId == null && line.owner) {
      const own = this.db.prepare('SELECT id FROM companies WHERE owner = ? ORDER BY id LIMIT 1').get(line.owner);
      if (own) queueCompanyId = own.id;
    }
    const cache = this.lineCache.get(line.id);
    cache.queueCompanyId = queueCompanyId;
    const totals = this._refreshLineDemand(cache);
    this._st.updateLine.run(line.name, line.color, line.kind, JSON.stringify(stops), line.loop,
      JSON.stringify(route.path), route.lengthM, null, Date.now(), line.schedule, line.id);
    return {
      ok: true, lengthM: route.lengthM, seconds: route.seconds, stops: stopInfo.length,
      dailyTrips: totals.dailyTrips, dailyTripsBase: totals.dailyTripsBase, activity: totals.activity,
      popTotal: totals.popTotal, jobsTotal: totals.jobsTotal,
      demand: totals.demand, boardPerDay: totals.boardPerDay,
      odPairs: totals.odPairs, od: totals.od,
      schedule: this.scheduleInfo(line, cache),
    };
  }

  /**
   * 把线路上的各站需求汇成线路合计（沿线需求 / 这条线真正拉得到的人 / 沿线活跃度）。
   * 只在"人口网格版本 + 游戏日"（以及车站、线路）变化后重算一次：每帧、每一小步只比较一个字符串。
   * 返回 { popTotal, jobsTotal, demand, dailyTrips, boardPerDay, dailyTripsBase, activity, odPairs, od }
   *   dailyTrips   沿线各站每天产生的乘客总量（origin 侧需求）
   *   boardPerDay  其中"这条线真的能拉走"的部分（O/D 表按线路拆出来的）
   */
  _refreshLineDemand(cache) {
    const od = this._ensureOdDemand();
    // 缓存键里必须带 O/D 表的**构建序号**：线路/车站一变就 _dropOdCache() 重算表，
    // 而表本身的 key（人口版本 + 日期 + 出行率）可能没变 —— 只比 key 的话会一直用着
    // 上一次构建留下的 boardPerDay / destMix（"加了一条线，旧线路的客流数字不动"的根因）。
    const key = `${od.key}|${od.serial}|${cache.schedule ? cache.schedule.mode : 'free'}`;
    if (cache.demandKey === key && cache.totals) return cache.totals;
    let popTotal = 0;
    let jobsTotal = 0;
    let demand = 0;
    let dailyTrips = 0;
    let boardPerDay = 0;
    let odPairs = 0;
    let actNum = 0;
    const perLine = od.byLine.get(cache.lineId) || null;
    for (const st of cache.stops) {
      const d = this.stationDemandOf(st);
      st.pop = d.pop;
      st.jobs = d.jobs;
      st.activity = d.activity != null ? d.activity : 1;
      st.density = d.density;
      st.coverage = d.coverage;
      st.demand = d.demand;
      st.dailyTrips = d.dailyTrips;
      st.spawnPerDay = d.dailyTrips;
      // 这条线在这个站"每天要拉走多少人"（O/D 表按线路拆好的）
      const entry = perLine ? perLine.get(st.stationId) : null;
      st.boardPerDay = entry ? Math.round(entry.total * 10) / 10 : 0;
      st.boardByBand = entry
        ? { local: entry.local, regional: entry.regional, long: entry.long }
        : { local: 0, regional: 0, long: 0 };
      st.destMix = entry ? entry.destMix : [];
      const bs = od.byStation.get(st.stationId);
      st.servedPerDay = bs ? bs.served : 0;
      st.reach = bs ? bs.reach : 0;
      popTotal += d.pop;
      jobsTotal += d.jobs;
      demand += d.demand;
      dailyTrips += d.dailyTrips;
      boardPerDay += st.boardPerDay;
    }
    for (const st of cache.stops) {
      st.share = popTotal > 0 ? st.pop / popTotal : (cache.stops.length ? 1 / cache.stops.length : 0);
      actNum += st.share * (st.activity || 1);
      const entry = perLine ? perLine.get(st.stationId) : null;
      if (entry) odPairs += (entry.destMix || []).length;
    }
    const totals = {
      popTotal,
      jobsTotal,
      demand,
      // 沿线各站产生的乘客总量（origin 侧需求）
      dailyTrips,
      // 基础客流（不含活跃度）：需求 × 出行率
      dailyTripsBase: demand * this.config.tripRatePerDay,
      // 这条线真正拉得到的人/日（O/D 表按线路拆出来的合计）
      boardPerDay: Math.round(boardPerDay * 10) / 10,
      odPairs,
      activity: cache.stops.length ? actNum : 1,
      dayFactor: dailyFactorOf(this.day),
      bandMaxM: { local: PAX.bandMaxM.local, regional: PAX.bandMaxM.regional, long: null },
      od: od.stats,
    };
    cache.demandKey = key;
    cache.totals = totals;
    cache.popTotal = popTotal;
    cache.jobsTotal = jobsTotal;
    cache.demand = demand;
    cache.dailyTrips = dailyTrips;
    cache.dailyTripsBase = totals.dailyTripsBase;
    cache.boardPerDay = totals.boardPerDay;
    cache.activity = totals.activity;
    return totals;
  }

  linePublic(row) {
    if (!row) return null;
    const cache = this.lineCache.get(row.id);
    // 人口/日期变了就把这条线的各站需求重算一次（平时只是一次字符串比较）
    const totals = cache ? this._refreshLineDemand(cache) : null;
    // 这条线"今天到现在"的客流（只读内存累计，不查库；快照每帧都要用）
    const day = this.lineDayStats(row.id);
    // #18 班次：现在有没有车在服务 / 下一班几点 / 未来几班的逐站预测时刻
    const service = cache ? this._lineService(cache) : this._lineService(null);
    const runs = cache ? this._lineRuns(cache, 5) : [];
    const nextRunVehicle = runs.length && runs[0].vehicleId != null ? this._st.vehicle.get(runs[0].vehicleId) : null;
    const nextTable = (cache && nextRunVehicle) ? this._runTable(cache, runs[0].departureMs, nextRunVehicle) : null;
    // #19 晚点系统：这条线现在的准点率 / 平均晚点 / 最大晚点（自由发车线拿"自编时刻表"当基准）
    const delayAgg = this._lineDelayAgg(cache);
    const out = {
      id: row.id, owner: row.owner, companyId: row.company_id, name: row.name, color: row.color, kind: row.kind,
      stops: this._parseStops(row.stops), loop: !!row.loop,
      pathLen: row.path_len || 0, pathError: row.path_error || null,
      stopsInfo: cache ? cache.stops : [],
      dailyTrips: cache ? cache.dailyTrips : 0,
      popTotal: cache ? cache.popTotal : 0,
      // 当日客流数字（NR 里线路/公司账本上的 riders 与 transfers）：
      //   riders    = 今天在这条线上车的人次
      //   transfers = 今天在这条线下车去换乘（换别的线路 / 步行接驳）的人次
      riders: day.riders,
      transfers: day.transfers,
      vehicleKm: day.vehicleKm,
      dayStats: day,
      // 岗位：**仅供界面展示**（NR 没有岗位模型，需求只看人口，见 population.js 顶部）；
      // 保留这个字段是为了客户端那一行"站点覆盖 X 人 / Y 岗位"不至于变成空白。
      jobsTotal: cache ? cache.jobsTotal : 0,
      // 沿线需求合计（人/日）与"这条线真正拉得到的人"（O/D 表按线路拆出来的）
      demand: totals ? totals.demand : 0,
      boardPerDay: totals ? totals.boardPerDay : 0,
      odPairs: totals ? totals.odPairs : 0,
      // #18 班次：free / headway / timetable，以及当天还剩哪几班
      //（#4 的"每个班次指定车辆"报在 schedule.assignmentsMissed 与 runs[].index/assignmentMissed 上）
      schedule: this.scheduleInfo(row, cache),
      // 现在有没有车在按班次服务（班次表模式下"没车"是正常状态，不是 bug，见 _lineService）
      // #3 暂停运营时这里一定为 true（service.paused 同时为 true、reason='paused'）
      noServiceNow: service.noServiceNow,
      service,
      // 未来 5 班：{ index, departureSec, departure:'HH:MM', departureMs, vehicleId, vehicleName,
      //             pinnedVehicleId, pinnedVehicleName, assignmentMissed, tripSeconds,
      //             stopsEta: [[车站 id, 到站秒, 发车秒], ...] }
      runs,
      // 下一班（含正在等点的那一班）的**逐站时刻表**：预测到站/发车时刻 + 相对现在还有多少秒
      // （自由发车 = []；班次表模式下这就是"这趟车每个站几点到、几点发"）
      stopsEta: this._stopsEtaPublic(nextTable),
      timetableTripSeconds: nextTable ? nextTable.tripSeconds : null,
      // #19 准点情况（NIMBY Rails 的 punctuality）：准点率 / 平均晚点 / 最大晚点 + 明细
      //   · 班次车（headway / timetable）：偏差 = 实际 − 时刻表（负数 = 早点）
      //   · 自由发车：没有时刻表，就拿"这一趟自己的预测 + 运行余裕"当计划，只报晚点不报早点
      //   · onTimeRate 在没有可比的车（tracked = 0）时是 null —— 没车不等于准点率 100%
      onTimeRate: delayAgg.onTimeRate,
      avgDelaySeconds: delayAgg.avgDelaySeconds,
      maxDelaySeconds: delayAgg.maxDelaySeconds,
      delay: delayAgg,
      travelSeconds: cache ? cache.seconds : 0,
      vehicleCount: cache ? cache.vehicleIds.length : 0,
      // 沿线平均活跃度（区域繁华度）与日客流拆解
      activity: cache ? Math.round((cache.activity || 1) * 100) / 100 : 1,
      dailyTripsBreakdown: {
        popTotal: cache ? cache.popTotal : 0,
        jobsTotal: cache ? cache.jobsTotal : 0,
        tripRatePerDay: this.config.tripRatePerDay,
        // base = 需求 × 出行率（未取整的日上车人数，即"理论上的基础客流"）
        base: cache ? Math.round(cache.dailyTripsBase) : 0,
        activity: cache ? Math.round((cache.activity || 1) * 100) / 100 : 1,
        total: cache ? cache.dailyTrips : 0,
        // 公式（与 population.js 顶部的中文说明、NIMBY Rails 的出处保持一致）：
        //   站需求 = 覆盖人口 × 活跃度；日上车人数 = 需求 × 出行率（这就是 NR 的 spawn rate）
        //   乘客按距离档（bandMix）只在同档里挑目的站，权重 = 目的地权重（NR 的 destination picking）
        //   能不能走由**行程**决定（最多 3 次换乘 + 站间步行接驳：能走多远由两站覆盖范围定，
        //   下限 2.3 km / 1 m/s，见 transferWalkRadiusM）
        //   → 线路日客流 = Σ 各站 boardPerDay（只算第一段坐这条线的乘客）
        formula: '需求 = 覆盖人口 × 活跃度（只看人口，没有岗位项）；日上车人数 = 需求 × 出行率；'
          + '乘客按距离档挑目的站（local ≤ ' + (PAX.bandMaxM.local / 1000) + ' km / regional ≤ '
          + (PAX.bandMaxM.regional / 1000) + ' km / long 更远），档内按目的地权重'
          + '（覆盖人口^' + PAX.coverageExp + ' + 默认水平）×（1 + 停靠线路数）'
          + '× 距离需求曲线 1/(1+d/' + PAX.decayMeters + 'm)^' + PAX.decayBeta
          + ' 分配；只要行程图里能走到（含换乘与步行接驳）就走，线路客流按行程第一段记账',
        demand: totals ? totals.demand : 0,
        boardPerDay: totals ? totals.boardPerDay : 0,
        odPairs: totals ? totals.odPairs : 0,
        bandMaxM: { local: PAX.bandMaxM.local, regional: PAX.bandMaxM.regional, long: null },
        dayFactor: totals ? totals.dayFactor : dailyFactorOf(this.day),
        od: totals ? totals.od : null,
        byStop: (cache ? cache.stops : []).map((st) => ({
          stationId: st.stationId, name: st.name, pop: st.pop, jobs: st.jobs, activity: st.activity,
          share: Math.round(st.share * 10000) / 10000, demand: st.demand || 0, dailyTrips: st.dailyTrips || 0,
          // 这一站每天产生的乘客 / 这条线在这个站拉走的人 / 能走掉的比例 / 主要去向
          spawnPerDay: st.spawnPerDay || 0, boardPerDay: st.boardPerDay || 0, reach: st.reach || 0,
          density: st.density || 0,
          // destMix 就是这里"每天拉走的人按目的站拆开"：transfers 是其中要换乘几次，
          // walkMeters 是行程里步行接驳的米数（0 = 直达），客户端可以据此显示"几换"
          destMix: (st.destMix || []).map((d) => ({
            stationId: d.stationId, name: d.name, people: Math.round(d.people * 10) / 10,
            band: d.band || null, transfers: d.transfers || 0, walkMeters: d.walkMeters || 0,
            steps: d.plan ? d.plan.steps.length : 1,
          })),
        })),
      },
    };
    // 路径坐标（画线用）：只在有缓存时带，保留 6 位小数控制体积
    if (cache && cache.path.length) {
      out.pathCoords = cache.path.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]);
    }
    return out;
  }

  /* --------------------------- 线路客流统计（日报） --------------------------- */

  /** 一条线路最近 days 个游戏日的客流：{days:[{day,riders,transfers,vehicleKm,avgLoad,avgWait}], week, today}
   *  （days 只列已经过去/正在进行的游戏日，第 1 天之前不存在，所以早期返回的条目会比请求的天数少） */
  lineStats(lineId, days = 7) {
    const id = Number(lineId);
    const n = Math.max(1, Math.min(90, Math.round(Number(days) || 7)));
    const today = this.day;
    const byDay = new Map();
    for (const r of this._st.lineStatsSince.all(id, today - n + 1)) {
      byDay.set(r.day, {
        day: r.day, riders: r.riders, transfers: r.transfers || 0,
        vehicle_km: r.vehicle_km, load_sum: r.load_sum, load_n: r.load_n, wait_sum: r.wait_sum, wait_n: r.wait_n,
      });
    }
    // 内存里"今天"还没落盘的部分一起算上，玩家看到的数字永远是实时的
    const acc = this.lineStatsAcc.get(id);
    if (acc && acc.day === today) {
      const r = byDay.get(today) || { day: today, riders: 0, transfers: 0, vehicle_km: 0, load_sum: 0, load_n: 0, wait_sum: 0, wait_n: 0 };
      byDay.set(today, {
        day: today,
        riders: r.riders + acc.riders,
        transfers: (r.transfers || 0) + acc.transfers,
        vehicle_km: r.vehicle_km + acc.vehicleKm,
        load_sum: r.load_sum + acc.loadSum,
        load_n: r.load_n + acc.loadN,
        wait_sum: r.wait_sum + acc.waitSum,
        wait_n: r.wait_n + acc.waitN,
      });
    }
    const list = [];
    // 游戏从第 1 天开始，别返回"第 0 天/第 -3 天"这种不存在的日期
    for (let d = Math.max(1, today - n + 1); d <= today; d++) list.push(this._statsDayRow(d, byDay.get(d)));
    const weekRows = [];
    for (let d = Math.max(1, today - 6); d <= today; d++) {
      const r = byDay.get(d);
      if (r) weekRows.push(r);
    }
    // today 取的是"今天"，week 是含今天的最近 7 天；days 是最近 n 天的逐日明细（缺失的日期补 0）
    return { days: list, week: this._aggregateStats(weekRows), today: this._aggregateStats([byDay.get(today)].filter(Boolean)) };
  }

  /** 单日一行：满载率是采样均值（0~1），候车时间按上车人数加权平均（游戏秒） */
  _statsDayRow(day, r) {
    return {
      day,
      riders: r ? Math.round(r.riders) : 0,
      transfers: r ? Math.round(r.transfers || 0) : 0,
      vehicleKm: r ? Math.round(r.vehicle_km * 10) / 10 : 0,
      avgLoad: r && r.load_n > 0 ? Math.round((r.load_sum / r.load_n) * 1000) / 1000 : 0,
      avgWait: r && r.wait_n > 0 ? Math.round(r.wait_sum / r.wait_n) : 0,
    };
  }

  /** 多日汇总：总量相加，平均满载率/平均候车时间按各自的采样权重加权 */
  _aggregateStats(rows) {
    let riders = 0;
    let transfers = 0;
    let km = 0;
    let loadSum = 0;
    let loadN = 0;
    let waitSum = 0;
    let waitN = 0;
    for (const r of rows || []) {
      if (!r) continue;
      riders += r.riders;
      transfers += r.transfers || 0;
      km += r.vehicle_km;
      loadSum += r.load_sum;
      loadN += r.load_n;
      waitSum += r.wait_sum;
      waitN += r.wait_n;
    }
    return {
      riders: Math.round(riders),
      transfers: Math.round(transfers),
      vehicleKm: Math.round(km * 10) / 10,
      avgLoad: loadN > 0 ? Math.round((loadSum / loadN) * 1000) / 1000 : 0,
      avgWait: waitN > 0 ? Math.round(waitSum / waitN) : 0,
    };
  }

  /** transit op：line.stats {id, days} —— 协作编辑下谁都能看任何一条线的客流（只读，不改东西） */
  lineStatsOp(user, op) {
    const line = this._st.line.get(Number(op.id));
    if (!line) throw new TransitError('线路不存在', 'NOTFOUND');
    const stats = this.lineStats(line.id, op.days === undefined ? 7 : op.days);
    return { line: this.linePublic(line), ...stats };
  }

  /* ------------------------------ 车辆 ------------------------------ */
  vehicleCost(spec) {
    const cars = Math.max(1, Math.min(12, Math.round(Number(spec.cars) || 4)));
    return this.config.vehicleBaseCost + this.config.vehiclePerCarCost * cars;
  }

  createVehicle(user, op) {
    const c = this.ensureCompany(user, op.companyId);
    const line = op.lineId ? this._st.line.get(Number(op.lineId)) : null;
    // 协作编辑：车可以派到别人的线路上（那条线只要还在就行；元素锁只把守"这条 op 直接改的元素"，
    // 也就是车辆本身 —— 见 checkElementLock 的说明）
    if (op.lineId && !line) throw new TransitError('线路不存在');
    const preset = VEHICLE_KINDS[op.kind] || null;
    const cars = Math.max(1, Math.min(12, Math.round(Number(op.cars) || (preset ? preset.cars : 4))));
    const capacity = Math.max(20, Math.min(400, Math.round(Number(op.capacityPerCar) || (preset ? preset.capacityPerCar : 60))));
    const maxSpeed = Math.max(30, Math.min(400, Number(op.maxSpeed) || (preset ? preset.maxSpeed : 80)));
    const lengthM = Math.max(4, Math.min(400, Number(op.lengthM) || (preset ? preset.lengthM : cars * this.config.meterPerCar)));
    const cost = this.vehicleCost({ cars });
    this._charge(c, cost, 'vehicle');
    const name = String(op.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32)
      || `${preset ? preset.name : '车辆'} ${this._st.countVehiclesOfOwner.get(c.id).c + 1}`;
    const kind = VEHICLE_KINDS[op.kind] ? op.kind : (op.kind === 'bus' ? 'bus' : 'rail');
    const res = this._st.insertVehicle.run(c.owner, c.id, line ? line.id : null, name, cars, capacity, maxSpeed, lengthM, kind, cost, Date.now());
    const id = Number(res.lastInsertRowid);
    this.runtime.delete(id);
    this._fleetUpsert(id);                 // #规模：内存车队跟数据库同步（车在跑就同时进 running 索引）
    if (line) this.rebuildPath(line.id);
    this._pushUndo(user.id, { label: `新建车辆「${name}」`, steps: [{ table: 'vehicles', id, mode: 'delete' }] });
    this.onChanged('vehicle', id);
    return { vehicle: this.vehiclePublic(this._st.vehicle.get(id)), company: this.companyPublic(c), cost };
  }

  updateVehicle(user, op) {
    const v = this._st.vehicle.get(Number(op.id));
    if (!v) throw new TransitError('车辆不存在');
    // 协作编辑：别人建的车辆也能改（改名 / 换车型 / 改派线路），只有"有人正在编辑"时才挡
    this.checkElementLock(user, 'vehicle', v.id);
    const before = this._row('vehicles', v.id);
    let lineId = v.line_id;
    if (op.lineId !== undefined) {
      if (op.lineId === null) lineId = null;
      else {
        const line = this._st.line.get(Number(op.lineId));
        if (!line) throw new TransitError('线路不存在');   // 谁建的线路都能派车上去（存在就行）
        lineId = line.id;
      }
    }
    const preset = VEHICLE_KINDS[op.kind] || null;
    const cars = op.cars === undefined ? (preset ? preset.cars : v.cars) : Math.max(1, Math.min(12, Math.round(Number(op.cars) || v.cars)));
    const capacity = op.capacityPerCar === undefined ? (preset ? preset.capacityPerCar : v.capacity_per_car) : Math.max(20, Math.min(400, Math.round(Number(op.capacityPerCar) || v.capacity_per_car)));
    const maxSpeed = op.maxSpeed === undefined ? (preset ? preset.maxSpeed : v.max_speed) : Math.max(30, Math.min(400, Number(op.maxSpeed) || v.max_speed));
    const lengthM = op.lengthM === undefined ? (preset ? preset.lengthM : v.length_m) : Math.max(4, Math.min(400, Number(op.lengthM) || v.length_m));
    const name = op.name === undefined ? v.name : (String(op.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32) || v.name);
    const kind = op.kind !== undefined && VEHICLE_KINDS[op.kind] ? op.kind : (op.kind === 'bus' ? 'bus' : v.kind);
    this._st.updateVehicle.run(lineId, name, cars, capacity, maxSpeed, v.id);
    this.db.prepare('UPDATE vehicles SET length_m = ?, kind = ? WHERE id = ?').run(lengthM, kind, v.id);
    this.runtime.delete(v.id);
    // 车长 / 车型 / 定员 / 车号变了：线路缓存里"按车算过"的东西必须作废。
    // 老代码靠 `if (lineId) this.rebuildPath(lineId)` 顺带重建（rebuildPath 会把整个 cache 删掉重建），
    // 但"车从 A 线改派到 B 线、A 线没被重建"这条路上 A 线的 _runTable / 排班缓存会留着旧车长。
    // 这里显式作废那几项（**不删 lineCache 条目**：路径几何是贵的那部分，不该为改个名字重算）。
    for (const id of new Set([v.line_id, lineId].filter((x) => x != null))) this._invalidateVehicleFacts(id);
    this._fleetUpsert(v.id);               // #规模：改派/改车型同步到内存车队（rt 会重建）
    if (lineId) this.rebuildPath(lineId);
    // 车从哪条线被拿走了，那条线也要重算：线路缓存里的 vehicleIds（谁在这条线上）必须跟着变，
    // 否则"车已经改派到别的线路"这件事在旧线路那边还看得见 —— 排班（_runPlan）与
    // linePublic().vehicleCount 都会拿它当"这条线上还有这辆车"。
    if (v.line_id && v.line_id !== lineId) this.rebuildPath(v.line_id);
    this._pushUndo(user.id, { label: `修改车辆「${name}」`, steps: [{ table: 'vehicles', id: v.id, mode: 'restore', row: before }] });
    this.onChanged('vehicle', v.id);
    return { vehicle: this.vehiclePublic(this._st.vehicle.get(v.id)) };
  }

  deleteVehicle(user, op) {
    const v = this._st.vehicle.get(Number(op.id));
    if (!v) throw new TransitError('车辆不存在');
    // 协作编辑：别人建的车辆也能删（退款退给车所属的那家公司，见 refund）
    this.checkElementLock(user, 'vehicle', v.id);
    const before = this._row('vehicles', v.id);
    const refund = Math.round(v.cost * 0.5);
    if (this.config.economy) this._earn(v.company_id, refund);
    this._st.delVehicle.run(v.id);
    this.runtime.delete(v.id);
    this._fleetRemove(v.id);               // #规模：内存车队里也删掉（连同空间索引/线路索引）
    // 车没了：它原来跑的那条线要重算（vehicleIds / 排班里不能再有它）。
    // 再按老规矩把"车主自己名下"的线路也刷一遍（老数据 / 协作编辑下两者可能不是同一个人）。
    if (v.line_id) this.rebuildPath(v.line_id);
    for (const l of this._st.allLines.all()) {
      if (l.owner === v.owner && l.id !== v.line_id) this.rebuildPath(l.id);
    }
    this._pushUndo(user.id, { label: `删除车辆「${v.name}」`, steps: [{ table: 'vehicles', id: v.id, mode: 'restore', row: before }] });
    this.onChanged('vehicle', v.id);
    return { deleted: v.id, refund, company: this.companyPublic(this._st.company.get(v.owner)) };
  }

  vehiclePublic(row) {
    if (!row) return null;
    const rt = this.runtime.get(row.id);
    const cache = row.line_id ? this.lineCache.get(row.line_id) : null;
    // #18/#19：下一站 / 预计到站秒数 / 本趟计划发车时刻 / 晚点 / 本趟剩下每一站的到站发车时刻
    //（没有 rt 或没有线路时全是 null / 空数组）
    const trip = this._tripInfo(row, cache, rt);
    // #车厂：这辆车现在在运营还是在车厂（唯一口径见 serviceStateOf）。
    // 在车厂的车**不进帧里的 trains[]**，它就在这里带着 inService:false + 原因 + 中文说明，
    // 于是车辆列表 / 车辆详情照样能显示「在车厂（未运营）· 线路已暂停运营，车辆已回车厂」。
    // 内存车队里没有这辆车（外部直接插库 / 车队还没装载）时，退回按"有没有线路"判断。
    const mem = this._fleet && this._fleet.byId ? this._fleet.byId.get(Number(row.id)) : null;
    const svc = this.serviceStateOf(mem || row, mem ? (mem.rt || rt) : rt, cache);
    const inService = svc === 'run';
    const histLimit = Math.max(1, Number(this.config.delayHistoryPublic) || DEFAULTS.delayHistoryPublic);
    const hist = rt && rt.delayHistory && rt.delayHistory.length
      ? rt.delayHistory.slice(-histLimit)
      : [];
    const out = {
      id: row.id, owner: row.owner, companyId: row.company_id, lineId: row.line_id, name: row.name,
      cars: row.cars, capacityPerCar: row.capacity_per_car, capacity: row.cars * row.capacity_per_car,
      maxSpeed: row.max_speed, cost: row.cost,
      lengthM: row.length_m || row.cars * this.config.meterPerCar,
      kind: row.kind || 'rail',
      // #19 服役时间（车辆建档时刻，游戏外的真实毫秒时间戳）与"今天跑了多少公里"
      createdAt: row.created_at == null ? null : Number(row.created_at),
      dayKm: rt && rt.dayKm ? Math.round(rt.dayKm * 10) / 10 : 0,
      load: rt ? Math.round(rt.load) : 0,
      state: rt ? rt.state : 'idle',
      // #车厂：在运营吗（只有它在跑的车才在地图上）；depot/depotReason/depotNote 说明"为什么不在路上"
      inService,
      depot: !inService,
      depotReason: inService ? null : svc,
      depotNote: inService ? null : (DEPOT_REASON_NOTE[svc] || DEPOT_REASON_NOTE['not-online']),
      progress: rt ? Math.round(rt.distance) : 0,
      lat: rt ? rt.lat : null, lon: rt ? rt.lon : null,
      nextStop: trip.nextStop,
      etaSeconds: trip.etaSeconds,
      scheduledDeparture: trip.scheduledDeparture,
      scheduledDepartureTime: trip.scheduledDepartureTime,
      scheduleLag: trip.scheduleLag,
      // #19 本趟剩下每一站几点到、几点发（自由发车也有）
      remainingStops: trip.remainingStops,
      // #19 晚点：当前偏差 / 趋势 / 是否追回来过 / 本趟最大偏差 / 基准来自时刻表还是自编计划
      delaySeconds: trip.delaySeconds,
      delayTrend: trip.delayTrend,
      recovered: trip.recovered,
      peakDelaySeconds: trip.peakDelaySeconds,
      delaySource: trip.delaySource,
      // 逐站偏差记录（最近几条）：每站实际到站/发车 vs 计划，以及晚点的成因
      delayHistory: hist,
    };
    return out;
  }

  /* ------------------------------ 模拟 ------------------------------ */

  /** 这辆车的加速度 / 制动减速度（按车型，认不出来用 config 的默认值） */
  _dynFor(vehicle) {
    return dynamicsForKind(vehicle && vehicle.kind, this.config);
  }

  /**
   * 一个游戏秒小步里的速度积分（精确运动学，步长多大都不会"一步到点"）。
   *
   *   加速段：v(t) = v0 + a·t，走行 s = v0·t + a·t²/2；到达目标速度后按匀速走完剩下的时间
   *   减速段：v(t) = v0 − b·t，走行 s = v0·t − b·t²/2；减到目标速度后同样转匀速
   *   a = 车型加速度（公交 0.9 / 电车 1.0 / 地铁 1.1 / 动车 0.5 / 货运 0.3 m/s²）
   *   b = 车型制动减速度（进站用）
   *
   * 返回本小步走的距离（米，非负），并把 rt.speed 更新为小步结束时的速度。
   * 例：公交车从 0 加速，a = 0.9 m/s²，到 40 km/h（11.11 m/s）需要 11.11/0.9 ≈ 12.3 游戏秒，
   * 这 12.3 秒里走了约 68 米 —— 这就是"起步不再像弹射"的意思。
   */
  _integrate(rt, vTarget, dyn, gameSec) {
    const dt = Math.max(0, Number(gameSec) || 0);
    if (!(dt > 0)) return 0;
    const v0 = Math.max(0, rt.speed || 0);
    const vT = Math.max(0, Number(vTarget) || 0);
    const a = dyn.accel;
    const b = dyn.brake;
    if (v0 < vT - 1e-9) {
      const tAcc = (vT - v0) / a;                 // 加到目标速度需要的时间
      if (tAcc >= dt) {
        const dist = v0 * dt + 0.5 * a * dt * dt;
        rt.speed = v0 + a * dt;
        return dist;
      }
      rt.speed = vT;
      return v0 * tAcc + 0.5 * a * tAcc * tAcc + vT * (dt - tAcc);
    }
    if (v0 > vT + 1e-9) {
      const tDec = (v0 - vT) / b;                 // 减到目标速度需要的时间
      if (tDec >= dt) {
        const dist = Math.max(0, v0 * dt - 0.5 * b * dt * dt);
        rt.speed = Math.max(vT, v0 - b * dt);
        return dist;
      }
      rt.speed = vT;
      return Math.max(0, v0 * tDec - 0.5 * b * tDec * tDec) + vT * (dt - tDec);
    }
    rt.speed = vT;
    return vT * dt;
  }

  /**
   * 一辆车的运行时状态（rt）。**热路径上的唯一入口，零 SQLite**：
   * 车辆静态字段来自内存车队（this._fleet），rt 建好之后直接挂在 veh.rt 上 ——
   * 之后每一小步都是 `veh.rt` 一次属性读取，没有 Map 查找、没有行对象构造。
   *
   * ⚠ this.runtime（Map<vehicleId, rt>）保留着，因为它是**对外契约**：如果一辆车被改派
   * 或删除，它的 rt 可能还挂在旧条目上（_resumeLine / _rescheduleWaiting / 车辆详情都会遍历它）。
   */
  _runtimeFor(vehicleId) {
    const veh = this._fleet.get(vehicleId);
    if (!veh) {
      // 兜底：车队还没装载（启动竞态）或这辆车是外部直接插进数据库的
      if (!this._fleetLoaded) this._ensureFleetReady();
      const v2 = this._fleet.get(vehicleId);
      if (!v2 || !v2.running) return null;
      return this._runtimeFor(vehicleId);
    }
    if (!veh.running) return null;
    if (veh.rt) return veh.rt;
    const cache = this.lineCache.get(veh.lineId);
    if (!cache || !cache.path.length) return null;
    const rt = {
      vehicleId, lineId: veh.lineId, veh,
      distance: 0, speed: 0, state: 'run',
      dwellUntil: 0, nextStopIdx: 0, direction: 1,
      load: 0, paxGroups: new Map(), lat: cache.path[0].lat, lon: cache.path[0].lon,
      lifetimeKm: 0, heading: 0,
      // 刚上线 / 刚被派到这条线：车要是正好停在某个车站上（尤其是线路首站），
      // 第一小步就要把这一站办了 —— 按"前方下一个站"找目标是永远找不到脚下那一站的。
      needsServeAtStart: true,
      lastServedStation: null,
      lastServePax: 0,        // 上一次停站的上下客合计（停站时间按它加点）
      lastBoarded: 0,         // 上一次停站**上车**的整人数（客户端据此看到"载客涨了多少"）
      lastAlighted: 0,        // 上一次停站下车人数
      parkedAt: null, parkedDir: 0, parkedIds: null,
      // #18 班次调度状态（见 _scheduleStep）：undefined = 还没排过班
      runActive: undefined, departureMs: undefined, scheduledDepartureMs: null, runStartMs: null,
      // #19 逐站预测（remainingStops）的缓存：只在"换了一趟 / 办完一站 / 每 N 游戏秒"时重算
      remainingStops: null, remainingStopsAtMs: null,
      // #19 晚点系统：本趟计划 + 逐站偏差历史
      //   legSeq / legStartMs / legStartDistance：本趟（方向一致的一段）起点，晚点计划的锚点
      //   legStartMs = null 表示"这趟的起点不明"（刚上线、刚改派），这时计划按当前位置从头算
      legSeq: 0, legStartMs: null, legStartDistance: null,
      delayPlan: null, prevDelayPlan: null, delayHistory: [],
      delaySeconds: null, peakDelaySeconds: 0, delayTrend: 'stable',
      recovered: false, recoveredSeconds: 0, delaySource: null,
      blockedMs: 0, blockedMsAtStop: 0,     // 被前车压住的累计游戏毫秒（晚点的成因之一）
      // #3 公交：被**道路网**（限速/拥堵系数）压着跑的累计游戏毫秒 —— 公交没有 blocked，
      //    晚点的成因记成 congestion（见 _recordStopObs / _stepVehicleBody）
      congestMs: 0, congestMsAtStop: 0,
      // #3 公交在站台上的排队位（米）：同一条线、同一方向、同一个站的多辆公交按到达顺序错开，
      //    只影响"画在哪"（_updateVehiclePoint），不改 rt.distance，所以不影响到站判定与模拟
      dwellSlotM: 0,
      servedAtMs: null,                     // 上一次进站的时刻（逐站预测里 'served' 那一条）
      // #19 今日里程（客户端车辆管理器里的「今日里程」用它；跨天自动归零，见 _step 里累加处）
      dayKm: 0, dayKmDay: null,
      // #规模：下一次算它的游戏时刻（LOD 分档，见 _simStep）—— 0 = 立刻算
      nextStepMs: 0, lod: 1,
    };
    // 同一条线路上的多辆车均匀铺开，避免一开始挤在一起（只查这条线上的车，走内存索引）。
    // idx = 0 的车就摆在首站（distance 0）：第一小步 `needsServeAtStart` 会把它当"停在站台上"
    // 办一次客 —— 这是**首站要能上人**的关键（改不得：把铺开点挪到"每段中点"会让第一辆车
    // 落在两站之间，首站永远上不了人，transit-e2e 的"列车产生了客流"当场挂掉）。
    // ⚠ **设了班次的线路一律不铺开**（用户投诉 #2）：班次车的合法位置只有两个 ——
    //   首站（车厂等点）和"正在跑这一趟"的路上。铺开到线路中段就等于"没在跑这一趟却站在路上"，
    //   _scheduleStep 会在第一小步把它收回首站（见那里），这里直接摆对，省掉一次瞬移。
    const peers = this._fleet.vehiclesOnLine(veh.lineId);
    if (peers.length > 1 && !this._usesSchedule(cache)) {
      let idx = -1;
      for (let i = 0; i < peers.length; i++) if (peers[i].id === vehicleId) { idx = i; break; }
      const pathEnd = cache.path[cache.path.length - 1].distance;
      rt.distance = (pathEnd * Math.max(0, idx)) / peers.length;
      const pt = this._pointAt(cache.path, rt.distance);
      rt.lat = pt.lat;
      rt.lon = pt.lon;
    }
    veh.rt = rt;
    this.runtime.set(vehicleId, rt);
    return rt;
  }

  /**
   * 时钟推进：realDtMs 是**真实**毫秒。**时间基准：×1 时 1 实时秒 = 1 游戏秒**
   *   （旧版本是 1 实时秒 = 1 游戏分钟，所以旧 ×60 = 现在 ×1）。
   *   gameMs = realDtMs × speed —— 倍速就是"实时时间的倍数"，没有别的换算系数。
   *
   * #预算：内部仍然按最多 simCoarseStepMs（默认 3 游戏秒）的小步长细分，但**整个 tick 有一个
   * 真实毫秒预算**（simBudgetMs，默认 5 ms）。预算用完就收工，把"欠下的游戏时间"留在
   * this._timeAcc 里，下一次 tick 接着算 —— 于是：
   *   · 车少的时候行为和以前一模一样（预算根本用不完，一次 tick 就把该走的游戏时间走完）；
   *   · 车多到算不完的时候（×300 + 几万辆），表现是"游戏时钟走得比倍速慢一点"，
   *     而不是"事件循环被锁住几百毫秒、所有玩家的 op 一起卡死"。
   * 单次 tick 最多吞 600000 游戏毫秒（10 游戏分钟）：实时卡顿 2 秒（index.js 的 dt 上限）
   *   在 ×300 时正好等于这个上限，再大的追赶就丢掉，避免一次补上几个小时。
   */
  tick(realDtMs) {
    // 暂停时也要定期把"当日未落盘的线路客流"写进数据库（否则关服就丢了）
    if (Date.now() - (this._lastSave || 0) > 10000) {
      this._lastSave = Date.now();
      this._st.saveSim.run(this.clockMs, this.speed, this.day, Date.now());
      this._flushLineStats();
    }
    this._maybeStartupImport();
    // #规模：位置/班次状态按批落盘（默认每 3 秒一次、一个事务）。空闲时一行都不写。
    this._persistFleet(false);
    if (!this._fleetLoaded) this._ensureFleetReady();
    // 缓存指纹自检（用户要求）：车站/线路/归属/人口/日期一变就立刻重建 O/D 表与行程图，
    // 不等跨天。放在暂停判断之前：暂停时改车站也要立刻生效（见 _checkStaleCaches）。
    this._checkStaleCaches();
    if (this.speed <= 0) return;
    const totalGameMs = Math.min(600000, realDtMs * this.speed);
    const tTick = Date.now();
    const MAX_TICK_MS = Math.max(0.5, Number(this.config.simBudgetMs) || DEFAULTS.simBudgetMs);
    const coarseStepMs = Math.max(200, Number(this.config.simCoarseStepMs) || DEFAULTS.simCoarseStepMs);
    // #分级：一小步的游戏时长（见 _simStep 顶部的推导）。它决定"一小步之内这辆车要走多久"，
    // 所以每一小步都要传给车辆（rt.lastStepMs），而不是让车辆自己拿"前一次采样"去猜。
    //   · 低倍速（×1…×12）：一小步就是粗档步长（3 游戏秒），于是视口外的车每 3 小步才动一次；
    //   · 高倍速（×300）：一小步被压到"约 250 ms 真实时间能走的游戏时间"（75 游戏秒），
    //     免得一次步进就跳过一百多公里 —— 这时的采样密度与老实现相同。
    const stepBudgetMs = Math.max(200, realDtMs * this.speed);
    const subStepMs = Math.max(200, Math.min(coarseStepMs, stepBudgetMs));
    let remaining = totalGameMs;
    let guard = 0;
    while (remaining > 0.5 && guard++ < 4000) {
      const step = Math.min(subStepMs, remaining);
      const tStep = Date.now();
      // 传预算进去：一小步之内也会查（车队上万时一小步本身就可能超预算）。
      // 返回 false = 这一步只算了一部分，游标留在 _stepSuspend 里，**游戏时间不推进**，
      // 下一次 tick 从游标接着算（所以这里不能扣 remaining）。
      const done = this._simStep(step, Math.max(1, MAX_TICK_MS - (Date.now() - tTick)));
      const stepMs = Date.now() - tStep;
      if (stepMs > this.simStats.longestSyncMs) this.simStats.longestSyncMs = stepMs;
      if (!done) {
        this._budgetLeftMs = remaining + step;
        this.simStats.budgetHits += 1;
        break;
      }
      remaining -= step;
      // 预算到了：剩下的游戏时间留给下一次 tick（不丢，只是晚一点算）
      if (remaining > 0.5 && (Date.now() - tTick) >= MAX_TICK_MS) {
        this.simStats.budgetHits += 1;
        this._budgetLeftMs = remaining;
        break;
      }
    }
    const tickMs = Date.now() - tTick;
    this.simStats.lastTickMs = tickMs;
    if (tickMs > this.simStats.maxTickMs) this.simStats.maxTickMs = tickMs;
  }

  /**
   * **让出事件循环的 tick**（index.js 用的是这一条）。
   *
   * 与 tick() 的差别只有一处：每跑完一小步（默认最多 3 游戏秒）就让出一次事件循环
   * （await 一个 setImmediate 包装的 Promise）。于是"一次 tick 要跑 25 个小步"这件事
   * 不再表现为"事件循环被锁住一整个 tick"，而是"25 个各自很短的同步片段"：
   *   · 最长同步片段 = 受预算约束的一段（可测：simStats.longestSyncMs）；
   *   · 一小步算不完时游标留在 _stepSuspend 里，下一段从那里接着算（不饥饿、不重复）；
   *   · 预算（simBudgetMs）仍然生效：余量留给下一次 tick（consumeBudgetLeft 取走）。
   *
   * @param {number} realDtMs 真实毫秒
   * @param {{onYield?: () => Promise<void>|void}} [opts]
   */
  async tickAsync(realDtMs, opts = {}) {
    const onYield = opts.onYield || (() => new Promise((r) => setImmediate(r)));
    if (Date.now() - (this._lastSave || 0) > 10000) {
      this._lastSave = Date.now();
      this._st.saveSim.run(this.clockMs, this.speed, this.day, Date.now());
      this._flushLineStats();
    }
    this._maybeStartupImport();
    this._persistFleet(false);
    if (!this._fleetLoaded) this._ensureFleetReady();
    // 与 tick() 同一处口径：每 tick 对一次缓存指纹（见 _checkStaleCaches）
    this._checkStaleCaches();
    if (this.speed <= 0) return;
    const totalGameMs = Math.min(600000, realDtMs * this.speed);
    const tTick = Date.now();
    const MAX_TICK_MS = Math.max(0.5, Number(this.config.simBudgetMs) || DEFAULTS.simBudgetMs);
    const coarseStepMs = Math.max(200, Number(this.config.simCoarseStepMs) || DEFAULTS.simCoarseStepMs);
    const stepBudgetMs = Math.max(200, realDtMs * this.speed);
    const subStepMs = Math.max(200, Math.min(coarseStepMs, stepBudgetMs));
    let remaining = totalGameMs;
    let guard = 0;
    while (remaining > 0.5 && guard++ < 4000) {
      const step = Math.min(subStepMs, remaining);
      const tStep = Date.now();
      const done = this._simStep(step, Math.max(1, MAX_TICK_MS - (Date.now() - tTick)));
      const stepMs = Date.now() - tStep;
      if (stepMs > this.simStats.longestSyncMs) this.simStats.longestSyncMs = stepMs;
      if (!done) {
        this._budgetLeftMs = remaining + step;
        this.simStats.budgetHits += 1;
        break;
      }
      remaining -= step;
      if (remaining > 0.5 && (Date.now() - tTick) >= MAX_TICK_MS) {
        this.simStats.budgetHits += 1;
        this._budgetLeftMs = remaining;
        break;
      }
      if (remaining > 0.5) await onYield();      // ★ 让出事件循环（这一段就到这里）
    }
    const tickMs = Date.now() - tTick;
    this.simStats.lastTickMs = tickMs;
    if (tickMs > this.simStats.maxTickMs) this.simStats.maxTickMs = tickMs;
  }

  /**
   * 跨天结算：把第 day+1 … newDay 天各结算一次（维护费 + 当日线路日报落盘），
   * 再切到新的一天并作废"按天变化"的缓存（时段曲线 / O&D 需求表）。
   * 正常推进（_step）与手动拨表（clock.set 跳时间）都走这里，两边口径一致。
   */
  _advanceDayTo(newDay) {
    if (!(newDay > this.day)) { this.day = newDay; return; }
    for (let d = this.day + 1; d <= newDay; d++) this._dailyUpkeep();
    this._flushLineStats();
    this.day = newDay;
    // 每天的时段曲线 / 周末系数不一样（周末通勤低、长途反而高）：_demandKey() 会把新的日期
    // 告诉人口模型，这里先把车站需求与 O/D 表的缓存作废（下一小步按新的一天重算）。
    if (this._stationDemand) this._stationDemand.clear();
    this._dropOdCache();
  }

  /**
   * LOD 分档（#按可见性分级）：
   *   1 = 细档（simFineStepMs，默认 1 游戏秒）：视口内、正在办客、或正被前车顶住的车
   *   0 = 粗档（simCoarseStepMs，默认 3 游戏秒）：其余全部车
   *
   * **两档走的是同一条代码路径**（同一套 _integrate 精确运动学 + _stopCrossed 到站判定 +
   * _dock 停站结算 + 晚点记录），区别只有"采样间隔"。所以：
   *   · 到站时刻、逐站预测（remainingStops）、晚点（delaySeconds）、班次（scheduleLag）
   *     **两档完全一致** —— 它们都是在事件发生时算出来的绝对时刻，与采样频率无关；
   *   · 差别只在"两站之间那一段的位置"：粗档每 3 游戏秒采一次位置/速度，位置误差量级
   *     a·Δt²/2（公交 0.9 m/s² × 9 s² / 2 ≈ 4 米，地铁 1.1 ≈ 5 米），而且**一进站就归零**
   *     （_dock 把 distance 直接钉在站台里程上）。60 km/h 下 3 游戏秒 = 50 米，
   *     所以粗档适合"玩家看不到的车"，细档给"屏幕里那几十辆"。
   *   进站/出站、被前车顶住的车场（净距是相互作用的，粗采样会让两辆车互相"穿过去"）
   *   由 _dock / _enforceSpacing 自动提到细档（它们要等到下一次采样才发现，所以必须先升档）。
   */
  _lodOf(veh, rt, view) {
    if (rt.state === 'dwell' || rt.state === 'scheduled' || rt.state === 'paused') return 1;
    if (rt.needsServeAtStart) return 1;
    if (veh.lengthM >= 100) return 1;                       // 长编组（动车/货运）车身就上百米，值得算准
    if (view && veh.cell >= 0 && view.cells.has(veh.cell)) return 1;
    if (view && veh.cell < 0) return 1;                     // 还没定位：先按细档算，下一小步就有格子了
    return 0;
  }

  /**
   * 前方第一个"会让车改变行为"的里程（下一个停靠站 / 线路端点）距离现在还有多远（米）。
   * 返回 null = 前方没有事件（可以放心用粗档大步长）。
   *
   * #分级 为什么需要它：粗档的 3 游戏秒是**采样间隔**，不是"可以随便跳过事件"。如果这一小步
   * 会把车带到站台，就必须把步长压回细档，让"跨过站台"的判定发生在正确的一小步里 ——
   * 否则到站时刻会被记成"这一小步结束的时刻"（最多差一整步），而晚点系统与逐站预测
   * 都是拿绝对时刻比出来的，一站差 3 秒、几十站就是几分钟的假晚点。
   */
  _blockingDistanceAhead(cache, rt, path) {
    const stops = cache.stops;
    if (!stops.length) return null;
    // 二分：停靠站按里程升序（rebuildPath 保证），所以"前方第一个站"不用线性扫
    // （一小步里每辆逼近站台的车都要问一次，线路站多时线性扫是白花的）
    if (rt.direction > 0) {
      let lo = 0;
      let hi = stops.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (stops[mid].distance > rt.distance + 1) { hit = mid; hi = mid - 1; } else lo = mid + 1;
      }
      if (hit >= 0) return stops[hit].distance - rt.distance;
      return Math.max(0, path[path.length - 1].distance - rt.distance);
    }
    let lo = 0;
    let hi = stops.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (stops[mid].distance < rt.distance - 1) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit >= 0) return rt.distance - stops[hit].distance;
    return Math.max(0, rt.distance);
  }

  /**
   * 本小步的"最大安全步长"（米）：粗档只在"前方有事件的空间还足够"时生效。
   *
   * 判据是**这一小步走得到的距离** × 1.6（不是"制动距离"）：既然位置积分是精确的
   * （粗采样点上的位置与连续积分完全一致），唯一会出问题的是"采样点正好落在站台之后"——
   * 那时到站时刻会被记成采样结束时刻（最多差一整步）。所以只要保证"这一小步到不了站台"
   * 就够了；一旦进入了这个区间（约等于"再过一小步就到站"），下一步就自动降到细档。
   * 这样车只在**接近站台的最后几秒**用细档，两站之间的大部分里程仍然是粗档。
   */
  _coarseRoomMeters(rt, path, coarseStepMs) {
    const limit = this._segSpeed(path, rt.distance);
    const vmax = Math.min(rt.veh ? rt.veh.maxSpeed : 120, limit || 120) / 3.6;
    const stepM = vmax * (Math.max(200, coarseStepMs) / 1000);
    return Math.max(80, stepM * 1.6);
  }

  /**
   * 本小步的视口摘要（把每个玩家的视口翻译成一组网格 key，供 LOD 与广播共用）。
   *
   * **每个 tick 只算一次**（不是每一小步）：视口本身最多 4 次/秒变化（客户端上报），
   * 而一小步最多 25 次/tick —— 每小步重算会白花 O(玩家数 × 视口网格数) 的集合操作。
   * 缓存键是"玩家视口表 + 车队运动版本号"：车挪了格子就要重算（索引变了）。
   */
  _viewSummary() {
    const views = this.playerViews;
    if (!views || !views.size) return null;
    const motion = this._motionSerial || 0;
    const cached = this._viewCache;
    if (cached && cached.motion === motion && cached.views === views && cached.size === views.size) return cached.summary;
    const out = [];
    for (const v of views.values()) {
      const lat = Number(v.lat), lon = Number(v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const r = Math.max(200, Number(v.radiusM) || Number(this.config.viewportRadiusM) || DEFAULTS.viewportRadiusM);
      // 视口半径 → 网格范围（0.01° ≈ 1.1 km）。同一个视口重复用同一份 Set。
      const key = `${lat}|${lon}|${r}`;
      let seen = v._cells;
      if (!seen || v._cellsKey !== key) {
        seen = new Set();
        const dLat = r / 111320;
        const dLon = r / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
        const x0 = Math.floor((lat - dLat) * 100);
        const x1 = Math.floor((lat + dLat) * 100);
        const y0 = Math.floor((lon - dLon) * 100);
        const y1 = Math.floor((lon + dLon) * 100);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) seen.add((x + 9000) * 100000 + (y + 18000));
        }
        v._cells = seen;
        v._cellsKey = key;
      }
      out.push({ lat, lon, radiusM: r, cells: seen });
    }
    const summary = out.length ? { views: out } : null;
    // cells：所有视口并集（LOD 用它一次判完；广播取车仍按每个视口各自的 Set 精确判）
    let union = null;
    if (summary) {
      union = new Set();
      for (const v of out) for (const k of v.cells) union.add(k);
      summary.cells = union;
    }
    this._viewCache = { motion, views, size: views.size, summary };
    return summary;
  }

  /**
   * 一帧的"视口内车辆集合"（#广播按需 的第一半）：
   * 所有在线玩家的视口并集 ∩ 在跑的车。同一帧给多个客户端复用这一份，
   * 而不是每个客户端各扫一遍车队（20 个玩家 × 1 万辆车 = 20 万次比较，白花）。
   */
  _frameFleetSet() {
    const summary = this._viewSummary();
    if (!summary) return { vehicles: [], byId: null, summary: null, scanned: 0 };
    const out = [];
    const byId = new Set();
    for (const veh of this._fleet.running) {
      if (veh.cell < 0 || !summary.cells.has(veh.cell)) continue;
      const rt = veh.rt;
      if (!rt) continue;
      out.push(veh);
      byId.add(veh.id);
    }
    this.simStats.lastViewVehicles = out.length;
    return { vehicles: out, byId, summary, scanned: this._fleet.runningCount };
  }

  /**
   * #规模：**小步内的模拟**。返回 false 表示"预算用完，剩下的下一 tick 再算"。
   *
   * 载客到达 / 耐心 / 步行接驳（_arrivalsStep / _patienceStep / _walkStep）每一小步都照做
   * （它们与车无关，是车站侧的成本，规模由车站数决定）；车这一侧按 LOD 分档采样：
   *   每辆车有 rt.nextStepMs = "下一次算它的游戏时刻"，落在这一小步窗口里的才算。
   *   细档 1 游戏秒 / 粗档 3 游戏秒，窗口最多 3 游戏秒 —— 所以每一小步最多算
   *   "视口内那些车（每步都算）+ 1/3 的视口外车"。
   */
  _simStep(gameMs, budgetMs) {
    const t0 = Date.now();
    // ── 中途挂起（#不阻塞事件循环的关键）──
    // 一小步之内要遍历在跑的车队。车队上万时"一小步"本身就可能超过预算（×300 下实测 9~44 ms），
    // 光在"小步之间"看预算是拦不住的。所以车队循环里也查预算：超了就**记住游标**（suspend）
    // 立刻返回，下一次调用从游标处接着遍历 —— 于是"最长同步片段"被压在预算附近，
    // 而不是"一小步的全部车算完为止"。
    const suspended = this._stepSuspend;
    let clockMs;
    let i;
    let gameSec;
    let view;
    let fineStepMs;
    let coarseStepMs;
    let fine = 0;
    let coarse = 0;
    if (suspended) {
      clockMs = suspended.clockMs;
      i = suspended.i;
      gameSec = suspended.gameSec;
      view = suspended.view;
      fineStepMs = suspended.fineStepMs;
      coarseStepMs = suspended.coarseStepMs;
      fine = suspended.fine;
      coarse = suspended.coarse;
    } else {
      // 这一小步的结束游戏时刻取整到毫秒：rt.nextStepMs 是"对齐到毫秒网格"的（见下面的分档），
      // 用取整后的值去比较与推进，就不会出现"差 0.0001 ms 到期、于是粗档车一直被跳过"的掉队。
      clockMs = Math.round(this.clockMs + gameMs);
      gameMs = clockMs - this.clockMs;
      this.clockMs = clockMs;
      gameSec = gameMs / 1000;
      i = 0;
      view = this._viewSummary();
      fineStepMs = Math.max(100, Number(this.config.simFineStepMs) || DEFAULTS.simFineStepMs);
      coarseStepMs = Math.max(fineStepMs, Number(this.config.simCoarseStepMs) || DEFAULTS.simCoarseStepMs);
      this._stepSuspend = { clockMs, gameSec, view, fineStepMs, coarseStepMs, i: 0, fine: 0, coarse: 0 };

      // 跨天：结算上一天的线路日报，收维护费；通勤量也按新的一天重新折算
      // （游戏日 = 86400 游戏秒；×1 倍速下一天要走 24 小时真实时间；×300 下 4.8 分钟）
      const newDay = Math.floor(this.clockMs / 86400000) + 1;
      if (newDay !== this.day) this._advanceDayTo(newDay);

      this._arrivalsStep(gameSec);
      this._patienceStep();          // 每个小步长都查一次耐心：高倍速细分之后也不会漏
      this._walkStep();              // 走完步行接驳（OSI）的乘客进下一段车的候车队伍
    }
    const nowMs = clockMs;
    const budget = Number(budgetMs) || 0;

    // 只遍历"挂了线路的车"（内存索引 running）：闲置车一辆都不进这里，成本 ~0
    const running = this._fleet.running;
    const total = running.length;
    for (; i < total; i++) {
      const veh = running[i];
      const cache = this.lineCache.get(veh.lineId);
      if (!cache || !cache.path.length) continue;
      const rt = this._runtimeFor(veh.id);
      if (!rt) continue;
      // #18/#3：一条线暂停、而且这辆车已经收车了：位置不会变，直接跳过
      //（"正在跑完这一趟"的车 runActive=true，不在这个分支里）
      if (cache.paused && !rt.runActive && rt.state === 'paused') continue;
      /**
       * #车厂·性能（用户投诉：没有任务的车辆还挂在起点站，很影响性能）：
       * 班次线路上"**已经算出下一班发车时刻、但现在还没到点**"的车停在首站一动不动 ——
       * 这一小步里它的位置、朝向、里程、到站状态都不可能变，唯一会变的就是"到点了"。
       * 老代码让它们每一小步都进 _stepVehicle（细档 1 游戏秒 / 粗档 3 游戏秒），
       * 几万辆车时这就是纯烧 CPU 的空转。
       * 这里把下一次采样直接推到**本车那一班的发车时刻**，于是它们全部落进上面那条廉价跳过分支
       * （simStats.skipped），成本 ≈ 0。到点精确醒（nextStepMs = departureMs），不早发、不晚发。
       *
       * ⚠ 判据必须收紧到 `typeof departureMs === 'number'`：
       *   `undefined` 是"这辆车还没排过班"（_scheduleStep 要靠这一次步进算出来），
       *   `null` 是"这条线今天/明天都没有分给本车的班次"（同样要步进才会进入 hold 分支）。
       *   把这两种也跳过，就会让车永远排不上班 —— 实测后果是整条线的班次一班都发不出去
       *   （schedule/depot/service 三套专项测试当场红）。
       * 自由发车线（_usesSchedule 为假）、在途车（runActive）、暂停车都不进这一支。
       */
      if (this.config.parkedSkip !== false
        && !cache.paused && this._usesSchedule(cache) && !rt.runActive && rt.distance <= ARRIVE_EPS
        && typeof rt.departureMs === 'number' && rt.departureMs > nowMs + 1e-6) {
        rt.nextStepMs = Math.round(rt.departureMs);
        /**
         * ⚠ 必须同时把"上一次被算的时刻"钉到**醒来的那一刻**：
         * 循环里这一辆车的步进时长是 `elapsed = nowMs - rt.lastStepAtMs`（见上面）。
         * 跳过的这一段（可能几个小时）里车是停着的、位置一点没变，所以醒来时该补的时间是 0；
         * 如果不动 lastStepAtMs，醒来那一步就会把整段等待时间当成"这一小步走了这么久"灌进
         * _stepVehicle —— 实测后果是发车/到站比时刻表早 79 秒（delay-test 当场红两格：
         * 偏差 -79s 与准点率 0）。钉成 nextStepMs 之后，醒来那一步的 elapsed ≈ 1 毫秒。
         */
        rt.lastStepAtMs = rt.nextStepMs;
        this.simStats.parkedSkips += 1;
        continue;
      }
      if (nowMs + 1e-6 < rt.nextStepMs) { this.simStats.skipped += 1; continue; }
      const lod0 = this._lodOf(veh, rt, view);
      // 这一辆车"上一次被算"到"这一次"之间的游戏时长 = 前后两次采样时刻之差（精确，不是近似）
      const elapsed = Math.max(1, nowMs - (rt.lastStepAtMs == null ? nowMs - gameMs : rt.lastStepAtMs));
      // 粗档的第二个条件：**前方这一小步之内没有事件**（见 _blockingDistanceAhead）。
      // 位置误差方面粗档很便宜（a·Δt²/2 ≈ 5 米，一进站就归零），但"跨过站台/走到端点"
      // 这种事件不能跨步采样 —— 那会让到站时刻差出整整一步。所以逼近事件的车自动降到细档。
      let lod = lod0;
      if (lod0 === 0) {
        const blockM = this._blockingDistanceAhead(cache, rt, path0(cache));
        if (blockM != null && blockM < this._coarseRoomMeters(rt, path0(cache), coarseStepMs)) lod = 1;
      }
      const stepMs = lod ? fineStepMs : coarseStepMs;
      rt.lod = lod;
      rt.lastStepMs = elapsed;
      rt.lastStepAtMs = nowMs;
      // 下一次采样时刻：**对齐到毫秒网格**（累加而不是"now + 步长"），
      // 所以误差不会累积；阶梯只有 1 游戏秒，粗档车不会被拖到 6 秒才动一次。
      const prevNext = rt.nextStepMs;
      rt.nextStepMs = Math.max(nowMs + 1, Math.round(prevNext + stepMs));
      if (lod) fine += 1; else coarse += 1;
      this._stepVehicle(veh, cache, rt, elapsed / 1000, path0(cache));
      // ── 事件时刻的精确化（#分级 的精度所在）──
      // _stepVehicle 在"半路遇到事件"时（跨过站台 / 停站结束 / 等点发车到点 / 走到端点 /
      // 被前车顶住）会把它实际用掉的那一小段时间记进 rt.usedMs（默认 = 整步）。
      // 这里把那部分从 nextStepMs 里退回来，剩下的时间在**同一个小步内递归**继续走完：
      //   · 粗档车因此不会被"整步采样"拖着多跑 —— 事件时刻（到站 / 发车 / 掉头）的误差
      //     从"最多一整步"降到"两次采样之间"（精度只受 1 ms 的切片粒度限制）；
      //   · 位置误差仍然只在两次采样之间累积（≤ a·Δt²/2 ≈ 5 米），一进站就归零；
      //   · 递归一定会消耗正的游戏时间，深度有限（一条线上最多几十个事件）。
      const used = Math.max(1, Math.min(elapsed, Math.round(rt.usedMs == null ? elapsed : rt.usedMs)));
      if (used < elapsed) {
        rt.nextStepMs = Math.round(Math.max(nowMs + 1, prevNext + stepMs) - (elapsed - used));
        rt.usedMs = null;
        this._stepVehicle(veh, cache, rt, (elapsed - used) / 1000, path0(cache));
      }
      rt.usedMs = null;
      // ── 预算：车队循环内也查一次 ──
      // 超了就把游标记下来、立刻返回（不 break 后重头再来，而是**下次从 i+1 接着走**），
      // 既不会让后面的车饿死，也不会攒出一个几十毫秒的同步片段。
      // ⚠ 检查间隔 = 同步片段的"过冲量"：每 64 辆查一次 Date.now()（Date.now 本身也是成本，
      // 每辆都查会变成热点），实测一次过冲 ≤ 64 辆 × 单车耗时（几十微秒）≈ 几毫秒。
      if (budget > 0 && ((i & 63) === 63) && (Date.now() - t0) >= budget) {
        this._stepSuspend = { clockMs, gameSec, view, fineStepMs, coarseStepMs, i: i + 1, fine, coarse };
        this.simStats.suspends = (this.simStats.suspends || 0) + 1;
        return false;
      }
    }
    this._stepSuspend = null;
    this.simStats.steps += 1;
    this.simStats.fineSteps += fine;
    this.simStats.coarseSteps += coarse;
    this.simStats.lastStepVehicles = fine + coarse;
    this.simStats.lastStepFine = fine;
    this.simStats.lastStepCoarse = coarse;
    // #广播按需：**只要真的动过车，就把"运动版本号"加一**。
    // index.js 用它做"这一帧要不要重算/重发"的判据：版本号没变 = 一支车队一个字节都没变
    // （时钟没动、或者 ×0 暂停、或者所有车都停在站台上），那一帧只发 clock（几十字节）。
    // 它是**保守的**：动过就一定加（宁可多发一帧，也不能让谁看到旧位置），
    // 而且不依赖任何哈希（上万辆车的 JSON 指纹比整帧还贵）。
    if (fine + coarse > 0) this._motionSerial = (this._motionSerial || 0) + 1;
    const ms = Date.now() - t0;
    this.simStats.lastStepMsReal = ms;
    if (ms > this.simStats.maxStepMs) this.simStats.maxStepMs = ms;
    this._enforceSpacing(gameMs);
    // 落盘时间到了就把这一小步里变脏的车写回去（批量事务；没有脏车就什么都不做）
    this._persistFleet(false);
    return true;
  }

  /**
   * 一个游戏小步里，**一辆车**的推进（老 _step 里那个 for 循环的循环体，逐字搬过来）。
   * 每一小步它的 gameSec 是"这辆车两次采样之间的游戏秒数"（细档 1 秒 / 粗档 3 秒），
   * 运动学积分、到站判定、停站结算、班次调度、晚点记录的口径与老代码完全一致。
   *
   * 唯一新增的是 **rt.usedMs**：这一小步里"真的用掉了多少游戏毫秒"。
   * 只有在这一小步**中途撞上事件**的地方才会设它（跨过站台 / 停站结束 / 等点发车到点 /
   * 走到端点 / 被前车顶住），调用方 _simStep 会照它把剩下的时间在同一小步内接着算完。
   * 事件时刻（到站 / 发车 / 掉头）因此与"粗档 3 游戏秒一采样"无关 —— 这是 #分级 不掉精度的关键。
   */
  _stepVehicle(v, cache, rt, gameSec, path) {
    rt.usedMs = null;
    rt._planVTarget = null;
    rt._planDyn = null;
    return this._stepVehicleBody(v, cache, rt, gameSec, path);
  }

  /**
   * 本小步里"走到某个里程"要用掉多少游戏毫秒（1 ms 粒度的二分）。
   * 用同一条运动学（_kinematicsAt）从游戏时刻反推里程，所以与正向积分完全一致。
   * 返回 null = 本小步到不了那个里程（调用方按"整步"继续）。
   */
  _consumeToDistance(rt, gameSec, wantDistance, toward) {
    if (Math.abs(rt.distance - wantDistance) <= 1e-9) return null;
    const endMs = Math.round(gameSec * 1000);
    if (!(endMs > 0)) return null;
    let lo = 0;
    let hi = endMs;
    const reached = (ms) => {
      const d = this._kinematicsAt(rt, ms / 1000).dist;
      return toward > 0 ? d >= wantDistance - 1e-9 : d <= wantDistance + 1e-9;
    };
    if (!reached(hi)) return null;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (reached(mid)) hi = mid; else lo = mid;
    }
    return Math.max(1, hi);
  }

  /**
   * 本小步里"游戏时钟走到某个绝对时刻"要用掉多少游戏毫秒（停站结束 / 等点发车到点用）。
   * 到点时刻落在本小步之内才返回正数，否则 null（调用方按"整步"继续）。
   */
  _consumeToClock(rt, gameSec, targetMs) {
    const endMs = Math.round(gameSec * 1000);
    const until = Math.round(targetMs - this.clockMs + endMs);
    if (until <= 0 || until > endMs) return null;
    return Math.max(1, until);
  }

  /**
   * 从"这一小步开始时的状态"出发、走 sec 游戏秒之后的位置与速度（纯函数，不改 rt）。
   * 与 _integrate 的口径完全一致（加速段/匀速段/减速段的分段解析解）。
   * 二分求"什么时候走到站台"与正向积分因此不会打架（同一个模型，只是反过来解）。
   */
  _kinematicsAt(rt, sec) {
    const dt = Math.max(0, Number(sec) || 0);
    const v0 = Math.max(0, rt.speed || 0);
    const vT = Math.max(0, rt._planVTarget == null ? v0 : rt._planVTarget);
    const dyn = rt._planDyn || { accel: 0.8, brake: 0.9 };
    const a = Math.max(1e-6, dyn.accel);
    const b = Math.max(1e-6, dyn.brake);
    if (v0 < vT - 1e-9) {
      const tAcc = (vT - v0) / a;
      if (tAcc >= dt) return { dist: v0 * dt + 0.5 * a * dt * dt, speed: v0 + a * dt };
      return { dist: v0 * tAcc + 0.5 * a * tAcc * tAcc + vT * (dt - tAcc), speed: vT };
    }
    if (v0 > vT + 1e-9) {
      const tDec = (v0 - vT) / b;
      if (tDec >= dt) return { dist: Math.max(0, v0 * dt - 0.5 * b * dt * dt), speed: Math.max(vT, v0 - b * dt) };
      return { dist: Math.max(0, v0 * tDec - 0.5 * b * tDec * tDec) + vT * (dt - tDec), speed: vT };
    }
    return { dist: vT * dt, speed: vT };
  }

  /** 事件体（见 _stepVehicle 的说明；拆出来只是为了让"设 rt.usedMs"这件事集中在一处） */
  _stepVehicleBody(v, cache, rt, gameSec, path) {
      const lastDist = path[path.length - 1].distance;

      // ── #3 暂停运营：只挡新的发车 ──
      // 必须在 _scheduleStep 之前判：暂停时"还没发车的车"就地收车停在首站（state='paused'），
      // 已经在跑的那一趟照常跑完（回到首站时 _endRun 会把它收车）；站台上等车的人一个不动。
      if (cache.paused && this._pauseHold(cache, rt) === 'hold') {
        this._updateVehiclePoint(rt, path);
        return;
      }

      // ── #18 班次：先看要不要在首站等点发车 ──
      // 必须在"到站停靠/开局停靠"之前判：否则刚上线的车会先被 _dock 拉去停 30 秒
      // （dwellSeconds），把"到点发车"整个推后 —— 发车时刻比停站时间近时就不发车了。
      // 返回 'hold' 表示这一小步原地待命（不推进里程，但每小步都在首站上下客）。
      if (this._scheduleStep(v, cache, rt) === 'hold') {
        this._updateVehiclePoint(rt, path);
        return;
      }

      if (rt.state === 'dwell') {
        // #3 停站结束 = 离开站台：把这个"排队位"还回去（下一站重新排），否则它会一直带着旧偏移画
        if (this.clockMs >= rt.dwellUntil) { rt.state = 'run'; rt.dwellSlotM = 0; this._dropRemainingStops(rt); }
        else {
          // 停站还没结束：这一小步只用到"停站结束"为止（剩下的时间在同一步内递归接着跑），
          // 于是"几点发车"是精确的，与粗档采样间隔无关
          rt.usedMs = this._consumeToClock(rt, gameSec, rt.dwellUntil);
          this._updateVehiclePoint(rt, path);
          return;
        }
      }

      // 刚上线 / 刚改派到这条线：车正停在某个车站上就先把这一站办了（首站也要上人）
      if (rt.needsServeAtStart) {
        rt.needsServeAtStart = false;
        const at = this._stopAt(cache, rt);
        if (at) { this._dock(v, cache, rt, path, at); return; }
      }

      // 限速来自路网：公交按所在道路的 maxspeed / 等级限速，铁路按轨道类型
      const segSpeed = this._segSpeed(path, rt.distance);
      const limit = Math.min(v.maxSpeed, segSpeed || 120) / 3.6;
      // #3 公交的"拥堵时间"：路段限速（railgraph 把 #16 的拥堵系数 congestion 烘进了路径的
      // speed：speed = 道路限速 × congestion）比车辆自身最高速还低 → 这一段公交是被**道路网**
      // 压着跑的，不是被前车压的（公交已经不互相阻挡了，见 _enforceSpacing）。
      // 这些毫秒会记进 rt.congestMs，进站时由 _recordStopObs 归成成因 'congestion'。
      if (isBusVehicle(v)) {
        const vmaxMs = this._vmaxOf(v);
        if (segSpeed && limit < vmaxMs - 1e-6) rt.congestMs = (rt.congestMs || 0) + Math.round(gameSec * 1000);
      }

      // 目标：行进方向上的下一个停靠站；前方没有站了就在端点掉头（环线则绕回起点）
      let target = this._nextStop(cache, rt.distance, rt.direction);
      if (!target) {
        if (cache.loop) {
          rt.distance = 0;
          rt.speed = 0;
          rt.needsServeAtStart = true;      // 绕回起点：下一小步在首站停靠上客
          this._endRun(cache, rt);          // #18 环线：绕回起点 = 这一趟跑完，排下一班
          this._startLeg(rt);               // #19 新的一趟（晚点计划在这里重新锚定）
          this._updateVehiclePoint(rt, path);
          return;
        }
        // 到端点了：端点上的站（末站常常就在路径终点）先办了再掉头
        const endStop = this._stopAt(cache, rt);
        if (endStop) { this._dock(v, cache, rt, path, endStop); return; }
        if (rt.runActive && rt.direction < 0) {
          // 从末站开回首站：这一段是"回场"（不占班次），回到起点就算这一趟跑完 ——
          // 按班次表排下一班，之后在首站等点发车。自由发车的线路 runActive 一直是 false，
          // 走的还是老逻辑（直接掉头继续跑）。
          this._endRun(cache, rt);
          rt.direction = 1;
          this._startLeg(rt);               // #19 新的一趟
          this._updateVehiclePoint(rt, path);
          return;      // 这一小步就停在首站等点，不要再往前挪（否则车会在等点期间跑掉）
        }
        rt.direction = -rt.direction;
        this._startLeg(rt);                 // #19 掉头 = 新的一趟
        target = this._nextStop(cache, rt.distance, rt.direction);
      }

      // 速度控制：起步按车型加速度慢慢加起来，进站按制动曲线减速到"站台前刚好停住"
      const dyn = this._dynFor(v);
      let vTarget = limit;
      if (target) {
        const gap = Math.abs(target.distance - rt.distance);
        // 提前一小步看：驾驶员看的是"这一小步走完之后还剩多远"，
        // 这样起步/减速不受步长影响（1 秒一步和 3 秒一步的轨迹几乎一样）
        const lookahead = Math.min(rt.speed * gameSec, Math.max(0, gap - DOCK_MARGIN));
        const gapAhead = gap - lookahead;
        // 需要的制动距离 = v²/(2b)：比"前方剩余距离 - 对准距离"还长，就得开始减速
        const brakeDist = (rt.speed * rt.speed) / (2 * dyn.brake) + DOCK_MARGIN;
        if (gapAhead <= brakeDist) {
          vTarget = Math.max(DOCK_CRAWL, Math.sqrt(2 * dyn.brake * Math.max(0, gapAhead - DOCK_MARGIN)));
        }
      }
      // #分级：记下"这一小步打算怎么走"，供 _kinematicsAt 把"什么时候走到站台"反解出来
      rt._planVTarget = vTarget;
      rt._planDyn = dyn;

      // 本小步从 before 走到 want（端点处夹住）：距离由精确运动学积分给出，
      // 所以就算一小步是 3 游戏秒，速度也不会"一步到位"（见 _integrate）。
      const before = rt.distance;
      let move = this._integrate(rt, vTarget, dyn, gameSec);
      // ── 前半段：本小步会**跨过站台**吗？──
      // 会的话，这一小步就只走到"到站那一刻"为止（_advanceToStop 把位置钉在站台里程上），
      // 剩下的时间由调用方在同一步内接着算 —— 到站时刻因此是精确的，而不是"整步结束时刻"。
      const crossed = this._stopCrossed(cache, before, before + move * rt.direction, rt.direction);
      let capMs = null;
      if (crossed) {
        const ms = this._consumeToDistance(rt, gameSec, crossed.distance, rt.direction);
        if (ms != null) {
          const k = this._kinematicsAt(rt, ms / 1000);
          rt.speed = Math.max(0, k.speed);
          move = k.dist;
          capMs = ms;
          rt.usedMs = ms;
        }
      }
      // 沿制动曲线收口：本小步结束时如果还高于"按剩余距离允许的速度"，就多减一点
      // （最多 1.5 倍常用制动），把离散化误差在几步内拉回来 —— 进站才是真的"慢慢停住"，
      // 而不是最后被到站判定硬拽一下。
      if (target && rt.speed > DOCK_CRAWL && capMs == null) {
        const gapNext = Math.abs(target.distance - (rt.distance + move * rt.direction));
        const allow = Math.max(DOCK_CRAWL, Math.sqrt(2 * dyn.brake * Math.max(0, gapNext - DOCK_MARGIN)));
        if (rt.speed > allow) rt.speed = Math.max(allow, rt.speed - 1.5 * dyn.brake * gameSec);
      }
      // ── 到站判定之前的收口 ──
      // 车已经用爬行速度对准站台、而站台就在"本小步走得到"的范围内时，直接停到站台上：
      // 否则会出现"停在站台前 1 米多"的情况 —— 而 _nextStop 只认前方 1 米之外的站，
      // 于是车会在末站前掉头走掉（末站永远不上客的老毛病）。
      let want = before + move * rt.direction;
      if (want > lastDist) want = lastDist;
      if (want < 0) want = 0;
      if (target) {
        const gapNow = Math.abs(target.distance - before);
        const crawlLimit = Math.max(DOCK_MARGIN + DOCK_CRAWL * gameSec, 1 + DOCK_CRAWL * gameSec);
        if (vTarget <= DOCK_CRAWL + 1e-9 && gapNow <= crawlLimit) {
          want = target.distance;
          // 爬行对位：同样只用到"对准站台"那一刻
          if (capMs == null) {
            const ms = this._consumeToDistance(rt, gameSec, target.distance, rt.direction);
            if (ms != null) { rt.usedMs = ms; capMs = ms; }
          }
        } else if (rt.direction > 0 && want > target.distance) want = target.distance;
        else if (rt.direction < 0 && want < target.distance) want = target.distance;
        if (want > lastDist) want = lastDist;
        if (want < 0) want = 0;
      }
      rt.distance = want;
      const travelled = Math.abs(want - before);
      // 满载率采样：每一步记一次 载客/定员，日报里的"平均满载率"就是这些采样的均值
      const capacity = v.capacity;
      const loadSample = capacity > 0 ? rt.load / capacity : 0;
      if (travelled > 0) {
        rt.lifetimeKm += travelled / 1000;
        // #19 本车"今天"跑了多少（客户端车辆管理器里的「今日里程」用它；跨天自动归零）
        if (rt.dayKmDay !== this.day) { rt.dayKmDay = this.day; rt.dayKm = 0; }
        rt.dayKm += travelled / 1000;
        // 车公里 + 满载率采样**合并成一次调用**（原来两次 _accLineStats = 两次 Map 查找 +
        // 两次对象分配，而这是每一小步每一辆车都要走的路 —— 实测占 _stepVehicle 的 10% 上下）
        this._accLineStats(rt.lineId, {
          vehicleKm: travelled / 1000,
          loadSum: loadSample,
          loadN: capacity > 0 ? 1 : 0,
        });
      } else if (capacity > 0) {
        this._accLineStats(rt.lineId, { loadSum: loadSample, loadN: 1 });
      }
      // 离开停靠点一段距离后，把"这一处已经办过的站"清掉（下一趟回到这里还能再停）
      if (rt.parkedAt != null && Math.abs(rt.distance - rt.parkedAt) > ARRIVE_EPS * 2) {
        rt.parkedAt = null;
        rt.parkedIds = null;
      }

      // 到站判定：本小步"跨过"的第一个站就停 —— 不论步长多大、方向如何，
      // 也不管车是被前车限位顶过来的，只要越过了站就会停靠上客。
      const hit = crossed || this._stopCrossed(cache, before, want, rt.direction);
      if (hit) { this._dock(v, cache, rt, path, hit); return; }
      // 保险：车停着没动，而脚下正好是一个还没办过的站（刚上线、被限位顶住等），也把它办了
      if (rt.speed <= 0.05) {
        const at = this._stopAt(cache, rt);
        if (at) { this._dock(v, cache, rt, path, at); return; }
      }

      // 端点掉头（站点本身由上面的"跨过"判定停靠，所以首站/末站都不会被漏掉）
      if (rt.direction > 0 && rt.distance >= lastDist - 1e-6) { rt.direction = -1; this._startLeg(rt); }
      else if (rt.direction < 0 && rt.distance <= 1e-6) {
        // 回到起点（非环线）：这一趟结束 —— 按班次排下一班，之后在首站等点发车
        this._endRun(cache, rt);
        rt.direction = 1;
        this._startLeg(rt);                 // #19 新的一趟
      }

      this._updateVehiclePoint(rt, path);
  }

  /**
   * 老入口（兼容）：单个小步长内的模拟。内部就是 _simStep。
   * 现在每一步只遍历内存里的 running 数组（见 transit-fleet.js）。
   */
  _step(gameMs) { return this._simStep(gameMs); }

  /**
   * 老的单步实现（**已下线，保留作对照**）：保留在这里是为了"逐行比对行为有没有变"——
   * 它和新路径的差别只有三处，全部是性能/规模相关的：
   *   ① 车队来源：`this._st.activeVehicles.all()`（每小步一次全表 SELECT + 每行一个 JS 对象）
   *      → `this._fleet.running`（内存数组，零 I/O）；v.max_speed / v.cars / v.capacity_per_car
   *      → veh.maxSpeed / veh.cars / veh.capacity（内存字段）
   *   ② LOD：所有车每个小步都算 → 按 rt.nextStepMs 分档采样（细 1 游戏秒 / 粗 3 游戏秒）
   *   ③ 循环体：continue → return（同一段逻辑搬进了 _stepVehicle）
   * 没有人调用它。保留它同时也是 tests/transit-fleet-test.js 里"新旧两条路径跑出来的
   * 到站时刻必须一致"那条断言的对照实现。
   */
  _stepLegacyUnused(gameMs) {
    this.clockMs += gameMs;
    const gameSec = gameMs / 1000;

    // 跨天：结算上一天的线路日报，收维护费；通勤量也按新的一天重新折算
    // （游戏日 = 86400 游戏秒；×1 倍速下一天要走 24 小时真实时间，×300 下 4.8 分钟）
    const newDay = Math.floor(this.clockMs / 86400000) + 1;
    if (newDay !== this.day) this._advanceDayTo(newDay);

    this._arrivalsStep(gameSec);
    this._patienceStep();          // 每个小步长都查一次耐心：高倍速细分之后也不会漏
    this._walkStep();              // 走完步行接驳（OSI）的乘客进下一段车的候车队伍

    // 只遍历"挂了线路的车"：老实现是 `this._st.activeVehicles.all()`（每小步一次 SELECT），
    // 这里改成内存索引，逻辑一行没动
    for (const v of this._fleet.running) {
      const cache = this.lineCache.get(v.lineId);
      if (!cache || !cache.path.length) continue;
      const rt = this._runtimeFor(v.id);
      if (!rt) continue;

      const path = cache.path;
      const lastDist = path[path.length - 1].distance;

      // ── #3 暂停运营：只挡新的发车 ──
      // 必须在 _scheduleStep 之前判：暂停时"还没发车的车"就地收车停在首站（state='paused'），
      // 已经在跑的那一趟照常跑完（回到首站时 _endRun 会把它收车）；站台上等车的人一个不动。
      if (cache.paused && this._pauseHold(cache, rt) === 'hold') {
        this._updateVehiclePoint(rt, path);
        continue;
      }

      // ── #18 班次：先看要不要在首站等点发车 ──
      // 必须在"到站停靠/开局停靠"之前判：否则刚上线的车会先被 _dock 拉去停 30 秒
      // （dwellSeconds），把"到点发车"整个推后 —— 发车时刻比停站时间近时就不发车了。
      // 返回 'hold' 表示这一小步原地待命（不推进里程，但每小步都在首站上下客）。
      if (this._scheduleStep(v, cache, rt) === 'hold') {
        this._updateVehiclePoint(rt, path);
        continue;
      }

      if (rt.state === 'dwell') {
        if (this.clockMs >= rt.dwellUntil) { rt.state = 'run'; this._dropRemainingStops(rt); }
        else { this._updateVehiclePoint(rt, path); continue; }
      }

      // 刚上线 / 刚改派到这条线：车正停在某个车站上就先把这一站办了（首站也要上人）
      if (rt.needsServeAtStart) {
        rt.needsServeAtStart = false;
        const at = this._stopAt(cache, rt);
        if (at) { this._dock(v, cache, rt, path, at); continue; }
      }

      // 限速来自路网：公交按所在道路的 maxspeed / 等级限速，铁路按轨道类型
      const segSpeed = this._segSpeed(path, rt.distance);
      const limit = Math.min(v.maxSpeed, segSpeed || 120) / 3.6;

      // 目标：行进方向上的下一个停靠站；前方没有站了就在端点掉头（环线则绕回起点）
      let target = this._nextStop(cache, rt.distance, rt.direction);
      if (!target) {
        if (cache.loop) {
          rt.distance = 0;
          rt.speed = 0;
          rt.needsServeAtStart = true;      // 绕回起点：下一小步在首站停靠上客
          this._endRun(cache, rt);          // #18 环线：绕回起点 = 这一趟跑完，排下一班
          this._startLeg(rt);               // #19 新的一趟（晚点计划在这里重新锚定）
          this._updateVehiclePoint(rt, path);
          continue;
        }
        // 到端点了：端点上的站（末站常常就在路径终点）先办了再掉头
        const endStop = this._stopAt(cache, rt);
        if (endStop) { this._dock(v, cache, rt, path, endStop); continue; }
        if (rt.runActive && rt.direction < 0) {
          // 从末站开回首站：这一段是"回场"（不占班次），回到起点就算这一趟跑完 ——
          // 按班次表排下一班，之后在首站等点发车。自由发车的线路 runActive 一直是 false，
          // 走的还是老逻辑（直接掉头继续跑）。
          this._endRun(cache, rt);
          rt.direction = 1;
          this._startLeg(rt);               // #19 新的一趟
          this._updateVehiclePoint(rt, path);
          continue;      // 这一小步就停在首站等点，不要再往前挪（否则车会在等点期间跑掉）
        }
        rt.direction = -rt.direction;
        this._startLeg(rt);                 // #19 掉头 = 新的一趟
        target = this._nextStop(cache, rt.distance, rt.direction);
      }

      // 速度控制：起步按车型加速度慢慢加起来，进站按制动曲线减速到"站台前刚好停住"
      const dyn = this._dynFor(v);
      let vTarget = limit;
      if (target) {
        const gap = Math.abs(target.distance - rt.distance);
        // 提前一小步看：驾驶员看的是"这一小步走完之后还剩多远"，
        // 这样起步/减速不受步长影响（1 秒一步和 3 秒一步的轨迹几乎一样）
        const lookahead = Math.min(rt.speed * gameSec, Math.max(0, gap - DOCK_MARGIN));
        const gapAhead = gap - lookahead;
        // 需要的制动距离 = v²/(2b)：比"前方剩余距离 - 对准距离"还长，就得开始减速
        const brakeDist = (rt.speed * rt.speed) / (2 * dyn.brake) + DOCK_MARGIN;
        if (gapAhead <= brakeDist) {
          vTarget = Math.max(DOCK_CRAWL, Math.sqrt(2 * dyn.brake * Math.max(0, gapAhead - DOCK_MARGIN)));
        }
      }

      // 本小步从 before 走到 want（端点处夹住）：距离由精确运动学积分给出，
      // 所以就算一小步是 3 游戏秒，速度也不会"一步到位"（见 _integrate）。
      const before = rt.distance;
      const move = this._integrate(rt, vTarget, dyn, gameSec);
      // 沿制动曲线收口：本小步结束时如果还高于"按剩余距离允许的速度"，就多减一点
      // （最多 1.5 倍常用制动），把离散化误差在几步内拉回来 —— 进站才是真的"慢慢停住"，
      // 而不是最后被到站判定硬拽一下。
      if (target && rt.speed > DOCK_CRAWL) {
        const gapNext = Math.abs(target.distance - (rt.distance + move * rt.direction));
        const allow = Math.max(DOCK_CRAWL, Math.sqrt(2 * dyn.brake * Math.max(0, gapNext - DOCK_MARGIN)));
        if (rt.speed > allow) rt.speed = Math.max(allow, rt.speed - 1.5 * dyn.brake * gameSec);
      }
      // ── 到站判定之前的收口 ──
      // 车已经用爬行速度对准站台、而站台就在"本小步走得到"的范围内时，直接停到站台上：
      // 否则会出现"停在站台前 1 米多"的情况 —— 而 _nextStop 只认前方 1 米之外的站，
      // 于是车会在末站前掉头走掉（末站永远不上客的老毛病）。
      let want = before + move * rt.direction;
      if (want > lastDist) want = lastDist;
      if (want < 0) want = 0;
      if (target) {
        const gapNow = Math.abs(target.distance - before);
        const crawlLimit = Math.max(DOCK_MARGIN + DOCK_CRAWL * gameSec, 1 + DOCK_CRAWL * gameSec);
        if (vTarget <= DOCK_CRAWL + 1e-9 && gapNow <= crawlLimit) want = target.distance;
        else if (rt.direction > 0 && want > target.distance) want = target.distance;
        else if (rt.direction < 0 && want < target.distance) want = target.distance;
        if (want > lastDist) want = lastDist;
        if (want < 0) want = 0;
      }
      rt.distance = want;
      const travelled = Math.abs(want - before);
      if (travelled > 0) {
        rt.lifetimeKm += travelled / 1000;
        // #19 本车"今天"跑了多少（客户端车辆管理器里的「今日里程」用它；跨天自动归零）
        if (rt.dayKmDay !== this.day) { rt.dayKmDay = this.day; rt.dayKm = 0; }
        rt.dayKm += travelled / 1000;
        this._accLineStats(rt.lineId, { vehicleKm: travelled / 1000 });   // 车公里
      }
      // 离开停靠点一段距离后，把"这一处已经办过的站"清掉（下一趟回到这里还能再停）
      if (rt.parkedAt != null && Math.abs(rt.distance - rt.parkedAt) > ARRIVE_EPS * 2) {
        rt.parkedAt = null;
        rt.parkedIds = null;
      }

      // 到站判定：本小步"跨过"的第一个站就停 —— 不论步长多大、方向如何，
      // 也不管车是被前车限位顶过来的，只要越过了站就会停靠上客。
      const crossed = this._stopCrossed(cache, before, want, rt.direction);
      if (crossed) { this._dock(v, cache, rt, path, crossed); continue; }
      // 保险：车停着没动，而脚下正好是一个还没办过的站（刚上线、被限位顶住等），也把它办了
      if (rt.speed <= 0.05) {
        const at = this._stopAt(cache, rt);
        if (at) { this._dock(v, cache, rt, path, at); continue; }
      }

      // 端点掉头（站点本身由上面的"跨过"判定停靠，所以首站/末站都不会被漏掉）
      if (rt.direction > 0 && rt.distance >= lastDist - 1e-6) { rt.direction = -1; this._startLeg(rt); }
      else if (rt.direction < 0 && rt.distance <= 1e-6) {
        // 回到起点（非环线）：这一趟结束 —— 按班次排下一班，之后在首站等点发车
        this._endRun(cache, rt);
        rt.direction = 1;
        this._startLeg(rt);                 // #19 新的一趟
      }

      this._updateVehiclePoint(rt, path);
      // 满载率采样：每一步记一次 载客/定员，日报里的"平均满载率"就是这些采样的均值
      const capacity = v.capacity;
      if (capacity > 0) this._accLineStats(rt.lineId, { loadSum: rt.load / capacity, loadN: 1 });
    }

    this._enforceSpacing(gameMs);
  }

  /**
   * 客流积累（NIMBY Rails 的 spawn rate 落在本作的时间轴上）。
   *
   * 乘客是"在车站等车"，所以按线路 × 车站记账（3 辆车不会让需求变 3 倍）：
   *   这一秒的上车人数 = Σ_距离档[ 该档每天要拉走的人数 × 时段曲线(当前小时) × 周末系数 ÷ 86400 ] × 本小步秒数
   * 其中"该档每天要拉走的人数"来自 O/D 需求表（_ensureOdDemand 按起点→目的地分好的），
   * 所以已经包含了"走得到才走"这个约束（含换乘与步行接驳，见 _itinerary）。
   * 时段曲线：通勤档早晚两个高峰、区域/长途更平；周末整体更低而长途更高
   * （NR 原文：每天有早晚通勤高峰，区域与长途更分散；周末需求更低，长途反而更高）。
   * 曲线已归一化（日均 1.0），所以一天积分下来正好等于 O/D 表里的"人/日"。
   *
   * 每个批次的乘客都带上"行程"（destMix 里的 plan），这样车到站时能按行程精确下车 /
   * 换乘 —— NR 里乘客就是按同一目的地打成一包的（Pax 页）。
   * 起点站自己没线路的乘客（O/D 表的 byOriginWalk）先按"步行接驳"走一段（OSI，1 m/s），
   * 走完再进邻站第一段车的候车队伍。
   */
  _arrivalsStep(gameSec) {
    if (!(gameSec > 0)) return;
    const hour = Math.floor((this.clockMs % 86400000) / 3600000);
    const day = this.day;
    const pop = this.population;
    // 运营小时数：一天的客流总量按它摊到每一个运营小时（config.transit.serviceHours）
    const serviceHours = Math.max(1, Number(this.config.serviceHours) || DEFAULTS.serviceHours);
    // 每一档在这一小时的"每秒到达系数"（人口模块没给 paxRateAt 时就地用纯函数算）
    const factor = {};
    for (const b2 of PAX_BANDS) {
      factor[b2] = pop && typeof pop.paxRateAt === 'function'
        ? pop.paxRateAt(b2, hour, day, serviceHours)
        : (hourlyShapeOf(b2, hour) * weekendFactorOf(b2, day)) / (serviceHours * 3600);
    }
    for (const cache of this.lineCache.values()) {
      if (!cache.stops.length) continue;
      this._refreshLineDemand(cache);      // O/D 合计算一次（平时只比较一个字符串）
      for (const st of cache.stops) {
        const byBand = st.boardByBand;
        if (!byBand) continue;
        const perSec = byBand.local * factor.local + byBand.regional * factor.regional + byBand.long * factor.long;
        if (!(perSec > 0)) continue;
        const people = perSec * gameSec;
        if (!(people > 0)) continue;
        this._arrivalsToQueue(st, cache, people);
      }
    }
    // 先步行去邻站坐车的乘客（OSI 接驳）：起点站自己没线路，O/D 表把它们记在 byOriginWalk 里
    const od = this._od;
    const walkOrigins = od && od.byOriginWalk;
    if (walkOrigins && walkOrigins.size) {
      const bandRate = (bands) => bands.local * factor.local + bands.regional * factor.regional + bands.long * factor.long;
      for (const [oid, wo] of walkOrigins) {
        const perSec = bandRate(wo.bands);
        if (!(perSec > 0)) continue;
        const people = perSec * gameSec;
        if (!(people > 0) || !(wo.total > 0)) continue;
        for (const e of wo.entries) {
          const part = (people * e.people) / wo.total;
          if (!(part > 0)) continue;
          const steps = e.plan ? e.plan.steps : null;
          const walkSec = steps && steps[0] && steps[0].type === 'walk'
            ? Math.max(1, steps[0].sec || 0)
            : Math.max(1, Math.round(e.walkMeters / this._tp.walkSpeed));
          // 走完以后要接的那一段（第一段乘车）在 steps 里的下标
          const rideIdx = steps ? steps.findIndex((s) => s.type === 'ride') : -1;
          this._addWalker(oid, part, e.destId, e.plan, rideIdx >= 0 ? rideIdx : 1, this.clockMs + walkSec * 1000);
        }
      }
    }
  }

  /**
   * 把"这一小步到站的乘客"按目的地分布塞进候车队伍（队伍挂在 cache.queueCompanyId 上，
   * 与 _serveStation 用的是同一个值，否则会出现"排了队却没人上车"）。
   * 每一批都带上它自己的行程（plan）与"现在要坐第几段"（idx），换乘时才能接得下去。
   */
  _arrivalsToQueue(st, cache, people) {
    const mix = st.destMix && st.destMix.length ? st.destMix : null;
    const add = (part, destId, plan) => {
      if (!(part > 0)) return;
      this._addWaiting(st.stationId, cache.queueCompanyId, cache.companyOwner, cache.lineId, part, this.clockMs, destId, plan, plan ? 0 : null);
    };
    if (!mix) {
      // 没有目的地分布：整批算"去向未知"，到终点站附近按统计口径下车
      add(people, null, null);
      return;
    }
    let total = 0;
    for (const d of mix) total += d.people;
    if (!(total > 0)) { add(people, null, null); return; }
    const cap = Math.min(mix.length, Math.max(1, Math.round(Number(this.config.odDestMix) || 4)));
    let left = people;
    for (let i = 0; i < cap; i++) {
      const isLast = i === cap - 1;
      const part = isLast ? left : (people * mix[i].people) / total;
      left -= part;
      add(part, mix[i].stationId, mix[i].plan || null);
    }
  }

  /* ------------------- 站间步行接驳（OSI）：走完再排下一段车的队 ------------------- */

  /**
   * 一批乘客开始步行接驳（NR：OSI 的乘客在"目的车站的站厅里带一个计时器"，1 m/s）。
   * 同一（行程 × 段号 × 目的站）的批并成一批，readyAt 按人数加权平均（到达是连续的）。
   */
  _addWalker(stationId, people, destId, plan, idx, readyAtMs) {
    if (!(people > 0)) return null;
    const sid = Number(stationId);
    const did = destId == null ? null : Number(destId);
    const key = this._paxGroupKey(plan, idx, did);
    let list = this.walkers.get(sid);
    if (!list) { list = []; this.walkers.set(sid, list); }
    const cohortMs = Math.max(1, Number(this.config.cohortSeconds) || DEFAULTS.cohortSeconds) * 1000;
    const last = list[list.length - 1];
    if (last && last.key === key && Math.abs(last.readyAtMs - readyAtMs) < cohortMs) {
      const total = last.people + people;
      last.readyAtMs = (last.readyAtMs * last.people + readyAtMs * people) / total;
      last.people = total;
    } else {
      list.push({ key, destId: did, people, plan: plan || null, idx: idx == null ? null : Number(idx), readyAtMs });
    }
    // 走路摔不死人，但别让一个站的步行队列无限长（超过就并成一批，取较早的 readyAt）
    const maxCohorts = Math.max(4, Number(this.config.maxCohorts) || DEFAULTS.maxCohorts);
    while (list.length > maxCohorts) {
      const a = list.shift();
      const b2 = list.shift();
      list.unshift({
        key: b2.key, destId: b2.destId, people: a.people + b2.people,
        plan: b2.plan, idx: b2.idx, readyAtMs: Math.min(a.readyAtMs, b2.readyAtMs),
      });
    }
    // 站台账：从这里步行出发 = 离开这一站（出发人数 / 步行人数）
    this._accStationPax(sid, 'departed', people);
    this._accStationPax(sid, 'walked', people);
    return list;
  }

  /** 正在步行的乘客数（车站账本 / 快照用） */
  walkingAt(stationId) {
    const list = this.walkers.get(Number(stationId));
    if (!list) return 0;
    let n = 0;
    for (const w of list) n += w.people;
    return Math.round(n);
  }

  /** 每一步检查一次"走完了的乘客"：走完就进下一段车的桶（或者到达目的地） */
  _walkStep() {
    if (!this.walkers.size) return;
    for (const [sid, list] of [...this.walkers]) {
      if (!list.length) { this.walkers.delete(sid); continue; }
      for (let i = 0; i < list.length;) {
        const w = list[i];
        if (w.readyAtMs > this.clockMs) { i += 1; continue; }
        list.splice(i, 1);
        this._dispatchWalker(sid, w);
      }
      if (!list.length) this.walkers.delete(sid);
    }
  }

  /** 某个车站被哪条线服务（给"线路被删掉 / 乘客降级"的兜底用：找一条能在这个站拉人的线） */
  _companyContextForStation(stationId) {
    const sid = Number(stationId);
    for (const cache of this.lineCache.values()) {
      if (!cache.stops.length) continue;
      for (const st of cache.stops) if (Number(st.stationId) === sid) return cache;
    }
    return null;
  }

  /** 一个走完步行段的批次：接着走下一段（乘车 → 排那条线的队；没有下一段 → 到达目的地） */
  _dispatchWalker(stationId, w) {
    const plan = w.plan;
    const idx = w.idx == null ? null : Number(w.idx);
    const step = plan && idx != null ? plan.steps[idx] : null;
    // 下一段还是步行（一般是两段接驳）→ 接着走，走完再处理
    if (step && step.type === 'walk') {
      this._addWalker(step.from, w.people, w.destId, plan, idx + 1, this.clockMs + Math.max(0, step.sec || 0) * 1000);
      return;
    }
    if (step && step.type === 'ride') {
      // 线路还在 → 排它的队；线路被删了 → 找这个站上任何一条还在跑的线（兜底桶谁都能拉）
      const cache = this.lineCache.get(Number(step.lineId)) || this._companyContextForStation(step.from);
      const same = !!cache && Number(step.lineId) === Number(cache.lineId);
      this._addWaiting(step.from, cache ? cache.queueCompanyId : null, cache ? cache.companyOwner : null,
        same ? step.lineId : null, w.people, this.clockMs, w.destId, same ? plan : null, idx);
      return;
    }
    // 步行段就是最后一段：人已经到目的地了
    const dest = w.destId == null ? null : Number(w.destId);
    if (dest != null) this._accStationPax(dest, 'arrived', w.people);
  }

  /** 车站乘客账本（当日；跨天自动清零） */
  _stationStat(stationId) {
    const sid = Number(stationId);
    let s = this.stationStats.get(sid);
    if (!s || s.day !== this.day) {
      s = { day: this.day, arrived: 0, departed: 0, transferred: 0, walked: 0 };
      this.stationStats.set(sid, s);
    }
    return s;
  }

  /** 累加某个车站的乘客账（同时记进"当日累计"，供 paxStats 汇总） */
  _accStationPax(stationId, field, people) {
    if (!(people > 0)) return;
    const s = this._stationStat(stationId);
    s[field] += people;
    this._paxDay = this._paxDay && this._paxDay.day === this.day
      ? this._paxDay
      : { day: this.day, arrived: 0, departed: 0, transferred: 0, walked: 0 };
    this._paxDay[field] += people;
  }

  /** 某站的乘客账本（对外展示；带上正在步行的人数）。跨天自动归零（账本是"当日"口径） */
  stationPaxStats(stationId) {
    const s = this.stationStats.get(Number(stationId));
    const fresh = s && s.day === this.day ? s : null;
    return {
      paxArrived: fresh ? Math.round(fresh.arrived) : 0,
      paxDeparted: fresh ? Math.round(fresh.departed) : 0,
      paxTransferred: fresh ? Math.round(fresh.transferred) : 0,
      paxWalked: fresh ? Math.round(fresh.walked) : 0,
      paxWalking: this.walkingAt(stationId),
      day: fresh ? fresh.day : this.day,
    };
  }

  /** 行进方向上"下一个该停的站"（严格在前方 1 米之外）；前方没有站就是 null */
  _nextStop(cache, distance, direction) {
    const stops = cache.stops;
    if (direction > 0) {
      for (const st of stops) if (st.distance > distance + 1) return st;
      return null;
    }
    for (let i = stops.length - 1; i >= 0; i--) if (stops[i].distance < distance - 1) return stops[i];
    return null;
  }

  /** 本小步从 from 走到 to（方向 direction）时"跨过"的第一个站；没跨过任何站就是 null */
  _stopCrossed(cache, from, to, direction) {
    let best = null;
    for (const st of cache.stops) {
      if (direction > 0) {
        if (st.distance > from + 1e-6 && st.distance <= to + ARRIVE_EPS) {
          if (!best || st.distance < best.distance) best = st;
        }
      } else if (st.distance < from - 1e-6 && st.distance >= to - ARRIVE_EPS) {
        if (!best || st.distance > best.distance) best = st;
      }
    }
    return best;
  }

  /** 车正停在哪个站上（这个位置、这个方向上已经办过的站不再返回，避免反复进站） */
  _stopAt(cache, rt) {
    for (const st of cache.stops) {
      if (Math.abs(st.distance - rt.distance) > ARRIVE_EPS) continue;
      if (rt.parkedIds && rt.parkedDir === rt.direction && rt.parkedAt != null &&
        Math.abs(rt.parkedAt - rt.distance) <= ARRIVE_EPS && rt.parkedIds.has(st.stationId)) continue;
      return st;
    }
    return null;
  }

  /** 进站停靠：对准站台、停 dwellSeconds 游戏秒，并先把乘客上下完 */
  _dock(vehicle, cache, rt, path, stop) {
    // #分级：到站时刻必须精确。this.clockMs 是"这一小步**结束**的游戏时刻"，
    // 而车可能是在这一小步中间就到站了（rt.usedMs = 走到站台那一刻用掉的毫秒），
    // 所以实际到站时刻 = 小步结束时刻 − 这一小步还没走掉的部分。
    // 细档（1 秒步长）下这一项最多 1 秒，粗档下最多 3 秒 —— 不修正的话
    // "预告到站时刻 vs 实际到站时刻"会一站一站累积出偏差。
    const stepMs = Math.max(0, Math.round(rt.lastStepMs || 0));
    const usedMs = rt.usedMs == null ? null : Math.max(1, Math.min(stepMs || Infinity, Math.round(rt.usedMs)));
    const arrivedAtMs = usedMs == null ? this.clockMs : this.clockMs - Math.max(0, stepMs - usedMs);
    rt.distance = stop.distance;
    rt.speed = 0;
    rt.state = 'dwell';
    // 停站时间 = 中间站 dwellSeconds；首末站再加 terminalDwellSeconds（掉头整备）
    const first = cache.stops[0];
    const last = cache.stops[cache.stops.length - 1];
    const isTerminal = (first && stop.stationId === first.stationId) || (last && stop.stationId === last.stationId);
    const baseSec = Math.max(0, Number(this.config.dwellSeconds) || 0)
      + (isTerminal ? Math.max(0, Number(this.config.terminalDwellSeconds) || 0) : 0);
    rt.dwellUntil = arrivedAtMs + baseSec * 1000;
    rt.lastServePax = 0;
    rt.lastBoarded = 0;
    rt.lastAlighted = 0;
    rt.lastServedStation = stop.stationId;
    // #3 公交的站台排队位（只影响"画在哪"，见 _busDwellSlotM / _updateVehiclePoint）：
    //   同一条线、同一个方向、已经停在这个站上的公交有几辆，就在行进方向后方排开几个车位。
    //   公交之间不再互相阻挡（_enforceSpacing 跳过公交），所以"同站不叠在一起"就靠这一处。
    rt.dwellSlotM = isBusVehicle(vehicle) ? this._busDwellSlotM(vehicle, cache, rt, stop) : 0;
    if (rt.parkedAt == null || rt.parkedDir !== rt.direction || Math.abs(rt.parkedAt - rt.distance) > ARRIVE_EPS) {
      rt.parkedAt = rt.distance;
      rt.parkedDir = rt.direction;
      rt.parkedIds = new Set();
    }
    rt.parkedIds.add(stop.stationId);
    this._serveStation(vehicle, cache, rt, stop);
    // 上下客多的时候多停一会儿（见 DEFAULTS.dwellPaxSeconds）
    const pax = Math.max(0, Math.round(rt.lastServePax || 0));
    const perPax = Math.max(0, Number(this.config.dwellPaxSeconds) || 0);
    const cap = Math.max(0, Number(this.config.dwellPaxMax) || 0);
    const extra = Math.min(cap, pax * perPax);
    if (extra > 0) rt.dwellUntil += extra * 1000;
    // #19 晚点系统：实际到站/发车时刻 vs 本趟计划（停站时间已经算完，所以发的时刻是最终值）；
    // 顺便作废"逐站预测"的缓存（这一站已经办过了，状态变了）
    rt.servedAtMs = arrivedAtMs;
    this._dropRemainingStops(rt);
    this._recordDelay(vehicle, cache, rt, stop, arrivedAtMs, rt.dwellUntil);
    this._updateVehiclePoint(rt, path);
  }

  /**
   * #3 公交在同一站的**排队位**（米，0 = 停在站台上，正数 = 沿行进方向往后排开这么多米）。
   *
   * 为什么需要它：公交不再互相阻挡以后（_enforceSpacing 跳过公交），两辆公交可以同时停在一个站上，
   * 而 `_dock` 把车对准站台的方式就是 `rt.distance = stop.distance` —— 不处理的话两辆车会**精确重叠**
   * 在同一个点（老代码也重叠：_spacePair 对 state==='dwell' 的后车直接返回），地图上看起来像一辆车。
   *
   * 口径（用户要求"公交在同一个站要排在各自的停靠位上，不许重叠"）：
   *   后车的车位 = （已经停在这个站上的同线同向车里最大的那个车位）+ max(两车车长) + busQueueGapMeters
   * 也就是说：第一辆停在站台上（0），第二辆在它后面一个车身 + 4 米处，第三辆再往后一个车身 —— 依次排队。
   * 关键：它只写 `rt.dwellSlotM`，**不动 rt.distance** ——
   *   · 不影响到站判定（_stopAt / _stopCrossed 都按 rt.distance 算，动了就会反复进站）；
   *   · 不影响时刻表、里程、乘客上下车与净距；只有 _updateVehiclePoint 在算"画在哪"时减掉这个偏移。
   * 车一旦离开站台（_stepVehicleBody 里 dwell → run，以及发车 / 收车）就把 dwellSlotM 清 0。
   */
  _busDwellSlotM(vehicle, cache, rt, stop) {
    if (!vehicle || !cache || !stop) return 0;
    const gap = Math.max(0, Number(this.config.busQueueGapMeters) || 0);
    const list = this._fleet.vehiclesOnLine(cache.lineId);
    let maxSlot = -1;
    let slotLen = 0;
    for (const v of list) {
      if (v.id === vehicle.id) continue;
      const o = v.rt;
      if (!o || o.state !== 'dwell') continue;
      if (o.direction !== rt.direction) continue;
      if (Number(o.lastServedStation) !== Number(stop.stationId)) continue;
      const s = Number(o.dwellSlotM) || 0;
      if (s > maxSlot) { maxSlot = s; slotLen = Number(v.lengthM) || 12; }
    }
    if (maxSlot < 0) return 0;                     // 这个站上现在只有我一辆：直接停在站台上
    return maxSlot + Math.max(Number(vehicle.lengthM) || 12, slotLen) + gap;
  }

  /**
   * #3 暂停运营：这一小步要不要把车"按住不动"。
   * 返回 'hold' = 原地不动（调用方 continue）；null = 让它照常跑。
   *
   * 口径（用户的要求：**不发新车，但已经在路上的车把这一趟跑完**）：
   *   · `rt.runActive`（班次车正在跑这一趟，**含从末站回场到首站**）→ 不拦，让它跑完；
   *     它回到首站那一刻 _endRun 的 cache.paused 分支会把它收车（state='paused'）；
   *   · 自由发车线没有 runActive：车不在首站 = 这一圈还没跑完 → 也不拦（一圈 = 从首站绕回首站），
   *     回到首站同样由 _endRun 收车；
   *   · **其余一律按住**：位置不动、不发车、也不上下客（车不走，拉人上车只会把乘客困在车上）。
   * 于是暂停期间**不可能有任何新车发出**（_scheduleStep 根本轮不到），也绝不删车、不藏车、不瞬移；
   * 站台上等车的人一个不动，继续按耐心规则等（等太久照样会走，见 _patienceStep）。
   */
  _pauseHold(cache, rt) {
    if (rt.runActive) return null;
    const first = cache.stops.length ? cache.stops[0].distance : 0;
    const atFirst = Math.abs(rt.distance - first) <= ARRIVE_EPS;
    if (!atFirst && !this._usesSchedule(cache)) return null;
    rt.speed = 0;
    rt.state = 'paused';
    if (atFirst) {
      rt.distance = first;
      rt.direction = 1;
    }
    return 'hold';
  }

  /**
   * #3 恢复运营：把被暂停"收车"的车重新排班。
   *   · 班次车：按班次表取**现在这一刻之后的下一班**（相当于时钟刚刚走到下一班的发车时刻），
   *     之后照常 _scheduleStep 在首站等点发车；
   *   · 自由发车：直接回到首站重新开跑（自由发车本来就没有时刻表）；
   *   · 正在跑这一趟的车（暂停期间还没跑完）不动它：它接着跑完，回到首站再按时刻表排下一班；
   *   · 位置归到首站不是"在路上瞬移"：被暂停收车的车本来就停在首站（_pauseHold 只按住在首站的车，
   *     在途的车由 _endRun 收到首站），这里只是把它摆正到首站、清掉"这一站已经办过"的标记，
   *     好让恢复后的第一班正常上客。
   */
  _resumeLine(lineId, cache) {
    const scheduled = this._usesSchedule(cache);
    for (const [vehicleId, rt] of this.runtime) {
      if (Number(rt.lineId) !== Number(lineId)) continue;
      if (rt.runActive) continue;                     // 还在跑这一趟：不打断
      if (rt.state !== 'paused') continue;            // 只有被暂停收车的那批要重新排班
      rt.scheduledDepartureMs = null;
      rt.runStartMs = null;
      rt.speed = 0;
      rt.distance = 0;
      rt.direction = 1;
      rt.parkedAt = null;
      rt.parkedIds = null;
      rt.needsServeAtStart = true;                    // 恢复后先在首站停靠上客
      this._dropRemainingStops(rt);
      if (scheduled) {
        rt.departureMs = this._nextDepartMs(cache, vehicleId, null);   // 现在之后的下一班
        rt.state = 'scheduled';
      } else {
        rt.departureMs = null;
        rt.state = 'run';
      }
    }
  }

  /**
   * #18 班次调度：在始发站**等点发车**。
   * 返回：
   *   'hold'   车在首站等"本车的下一班"（这一小步不推进里程，但照常上下客）
   *   'depart' 刚刚到点发车（调用方接着按普通运行逻辑走）
   *   null     自由发车 / 正在跑这一趟（都不归这一步管）
   *
   * 状态机（每辆车）：
   *   departureMs          下一班的发车时刻（游戏毫秒；null = 这条线没有分给本车的班次）
   *   runActive            true = 正在跑这一趟（从首站发车到回到首站/绕完一圈）
   *   scheduledDepartureMs 这一趟的计划发车时刻（对外报 scheduledDeparture / 算晚点用）
   *
   * ⚠ 用户投诉 #2 的根因就在这个函数里（已修）：**设了班次的线路上，任何"没有在跑这一趟"的车
   *   都必须在首站（车厂）等点，不许在路上自由行驶**。老代码在"还没到发车时刻"那一支里写了
   *   `if (rt.distance > ARRIVE_EPS) return null;` —— 意思是"还在回场路上的车让它跑回去"，
   *   但 `_runtimeFor` 会把同一条线上的多辆车沿路径**铺开**（distance = pathEnd×i/车数），
   *   而且"这条线刚从自由发车改成班次表"时车本来就在半路上。这两种车的 rt.distance > 0、
   *   runActive 又是 false，于是被那一行放行：它会像自由发车一样跑完一整圈（沿途还进站停靠、
   *   上下客），同时对外报 inService:false —— 用户看到的就是"设了班次的车还在自由发车"。
   *   现在改成：没在跑这一趟的车一律摆回首站（车厂）等点（_parkAtStart），不再有第三种状态。
   * ⚠ 暂停运营（cache.paused）时这里根本不会被调用：_pauseHold 已经把车按住了（见那里）。
   */
  _scheduleStep(vehicle, cache, rt) {
    if (!this._usesSchedule(cache)) return null;
    if (rt.departureMs === undefined) {
      // 刚上线 / 刚改派：排第一班（本车序号对应的最近一班）
      rt.departureMs = this._nextDepartMs(cache, vehicle.id, null);
      rt.scheduledDepartureMs = null;
      rt.runActive = false;
    }
    if (rt.runActive) return null;
    if (rt.departureMs == null) {
      // 这条线今天/明天都没有分给本车的班次（车比班次多，或班次表为空）：停在首站，不发车。
      // 这是**正常**状态（linePublic().noServiceNow 会说清楚），不是故障；
      // 对外 serviceStateOf() 会给出 depotReason='no-departure'（「在车厂（未运营）· 没有分给本车的班次」）。
      if (rt.distance > ARRIVE_EPS) this._parkAtStart(vehicle, cache, rt);
      rt.state = 'scheduled';
      rt.speed = 0;
      if (rt.distance <= ARRIVE_EPS) {
        rt.distance = 0;
        const at = this._stopAt(cache, rt);
        if (at) this._serveStation(vehicle, cache, rt, at);
      }
      return 'hold';
    }
    if (this.clockMs + 1e-6 < rt.departureMs) {
      // 还没到发车时刻：车必须停在**首站**等点。distance > 0 说明它"没在跑这一趟却在路上"
      // （刚上线被铺开在中间 / 这条线刚改成班次表 / 刚从库里恢复出来）—— 摆回首站，
      // 而不是让它把这一圈跑完（见函数头对用户投诉 #2 的说明）。
      if (rt.distance > ARRIVE_EPS) this._parkAtStart(vehicle, cache, rt);
      rt.distance = 0;
      rt.speed = 0;
      rt.direction = 1;
      rt.state = 'scheduled';
      const at = this._stopAt(cache, rt);
      if (at) this._serveStation(vehicle, cache, rt, at);
      return 'hold';
    }
    // 到点了：发车（发车前再上一次客，把等车期间新来的乘客拉上）
    rt.runActive = true;
    rt.scheduledDepartureMs = rt.departureMs;
    rt.runStartMs = this.clockMs;
    rt.state = 'run';
    rt.dwellSlotM = 0;              // #3：发车了就不再占站台上的排队位
    rt.needsServeAtStart = false;   // 上面这一站已经办过了，别再让 _dock 把发车推后一个停站时间
    rt.parkedAt = null;          // 先清掉"这一站已经办过"的标记，否则这次上客会被跳过
    rt.parkedIds = null;
    const at = this._stopAt(cache, rt);
    if (at) this._serveStation(vehicle, cache, rt, at);
    // #19 本趟计划 = 这一班的逐站时刻表（晚点系统的基准）；起点站先记一条"发车偏差"
    this._ensureDelayPlan(cache, rt, vehicle);
    return 'depart';
  }

  /**
   * 把车摆回**首站（车厂）**等点：位置 0、速度 0、朝上行走，清掉"这一站已经办过"的标记，
   * 好让等点期间照常上客（站台上等车的人不会因为这次摆位而错过车）。
   * 只被 _scheduleStep 用来收拢"设了班次却没在跑这一趟"的车（见那里对投诉 #2 的说明）；
   * 与 _resumeLine（暂停恢复）摆回首站是同一个口径。
   */
  _parkAtStart(vehicle, cache, rt) {
    rt.distance = 0;
    rt.speed = 0;
    rt.direction = 1;
    rt.state = 'scheduled';
    rt.dwellSlotM = 0;
    rt.needsServeAtStart = false;
    rt.parkedAt = null;
    rt.parkedIds = null;
    this._dropRemainingStops(rt);
    if (cache && cache.path && cache.path.length) this._updateVehiclePoint(rt, cache.path);
  }

  /**
   * 一趟车跑完（回到始发站 / 环线绕回起点）：按班次表排下一班。
   * 按班次跑的车回到首站后就**停在首站上**（distance = 0、速度 0）等下一班；
   * 自由发车的线路不做任何事（车接着按老逻辑一直跑）。
   * #3 暂停运营时（cache.paused）：这一趟跑完就**收车** —— 车停在首站、不再排下一班，
   * 等 line.setService { running:true } 时由 _resumeLine 重新排"现在之后的下一班"。
   */
  _endRun(cache, rt) {
    rt.runActive = false;
    rt.scheduledDepartureMs = null;
    rt.runStartMs = null;
    if (cache && cache.paused) {
      rt.distance = 0;
      rt.speed = 0;
      rt.direction = 1;
      rt.departureMs = null;      // 暂停期间没有"下一班"
      rt.state = 'paused';
      this._dropRemainingStops(rt);
      return;
    }
    if (this._usesSchedule(cache)) {
      rt.distance = 0;
      rt.speed = 0;
      rt.direction = 1;
      rt.departureMs = this._nextDepartMs(cache, rt.vehicleId, null);
      rt.state = 'scheduled';
    }
  }

  /**
   * 等车耐心：每一批乘客自己计时，等超过 config.patienceSeconds 游戏秒就整批放弃离开。
   * 计时与 lost 都**按桶（= 按线路）**算：2 号线等不到车的人算在 2 号线上，
   * 1 号线的车拉得再勤也救不了他们（这本来就是两条独立的队伍）。
   */
  _patienceStep() {
    const limitMs = Math.max(1, Number(this.config.patienceSeconds) || DEFAULTS.patienceSeconds) * 1000;
    for (const byCompany of this.stationQueues.values()) {
      for (const e of byCompany.values()) {
        let entryGone = 0;
        for (const b of e.buckets.values()) {
          if (!b.cohorts.length) {
            if (b.waiting > 0) b.waiting = 0;
            continue;
          }
          let gone = 0;
          while (b.cohorts.length && this.clockMs - b.cohorts[0].startMs > limitMs) {
            gone += b.cohorts.shift().people;
          }
          if (gone > 0) {
            b.lost += gone;                       // 记在**这条线**的账上（分线路明细用它）
            b.waiting = Math.max(0, b.waiting - gone);
            b.waitStartMs = b.cohorts.length ? b.cohorts[0].startMs : this.clockMs;
            b.carry = b.waiting - Math.floor(b.waiting);
            entryGone += gone;
          }
        }
        if (entryGone > 0) {
          e.lost += entryGone;
          e.waiting = Math.max(0, e.waiting - entryGone);
          const oldest = this._oldestOf(e);
          e.waitStartMs = oldest == null ? this.clockMs : oldest;
        }
      }
    }
  }

  /* --------------------------- 线路客流日报（内存累计 + 落库） --------------------------- */

  /**
   * 当日累计器：riders 按上车人次记，transfers 按"在这条线上下车去换乘"的人次记
   * （NR 的 transfers 口径），vehicleKm 按走行距离记，满载率/候车时间都是采样均值。
   */
  _accLineStats(lineId, delta) {
    const id = Number(lineId);
    if (!Number.isFinite(id)) return;
    let acc = this.lineStatsAcc.get(id);
    if (acc && acc.day !== this.day) {
      this._writeStatsRow(id, acc);   // 跨天时先把上一段落库（正常情况下 _step 已经统一结算过）
      acc = null;
    }
    if (!acc) {
      acc = { day: this.day, riders: 0, transfers: 0, vehicleKm: 0, loadSum: 0, loadN: 0, waitSum: 0, waitN: 0 };
      this.lineStatsAcc.set(id, acc);
    }
    acc.riders += delta.riders || 0;
    acc.transfers += delta.transfers || 0;
    acc.vehicleKm += delta.vehicleKm || 0;
    acc.loadSum += delta.loadSum || 0;
    acc.loadN += delta.loadN || 0;
    acc.waitSum += delta.waitSum || 0;
    acc.waitN += delta.waitN || 0;
  }

  /** 一条线路"今天到现在"的客流（只读内存累计，不查库：每帧的 linePublic 用它） */
  lineDayStats(lineId) {
    const acc = this.lineStatsAcc.get(Number(lineId));
    if (!acc || acc.day !== this.day) return { day: this.day, riders: 0, transfers: 0, vehicleKm: 0 };
    return {
      day: acc.day,
      riders: Math.round(acc.riders),
      transfers: Math.round(acc.transfers),
      vehicleKm: Math.round(acc.vehicleKm * 10) / 10,
      avgLoad: acc.loadN > 0 ? Math.round((acc.loadSum / acc.loadN) * 1000) / 1000 : 0,
      avgWait: acc.waitN > 0 ? Math.round(acc.waitSum / acc.waitN) : 0,
    };
  }

  _writeStatsRow(lineId, acc) {
    if (!acc) return;
    if (!acc.riders && !acc.transfers && !acc.vehicleKm && !acc.loadN && !acc.waitN) return;
    this._st.upsertLineStats.run(lineId, acc.day, Math.round(acc.riders), Math.round(acc.transfers || 0),
      acc.vehicleKm, acc.loadSum, acc.loadN, acc.waitSum, acc.waitN, Date.now());
  }

  /** 把内存里当日的线路客流写进数据库（每 10 秒、跨天、暂停与关服时各来一次） */
  _flushLineStats() {
    for (const [lineId, acc] of this.lineStatsAcc) {
      this._writeStatsRow(lineId, acc);
      acc.riders = 0;
      acc.transfers = 0;
      acc.vehicleKm = 0;
      acc.loadSum = 0;
      acc.loadN = 0;
      acc.waitSum = 0;
      acc.waitN = 0;
    }
  }

  /** 对外：立刻落盘（index.js 在关服时调用） */
  flushStats() {
    try { this._flushLineStats(); } catch (err) { console.warn('[transit] 线路日报落盘失败:', err.message); }
  }

  /**
   * 同一条线路上、同一个方向的前后车不许贴在一起：后车最多跟到"前车后方（两车半长 + 安全距离）"处。
   * 关键点：这里只把后车"往后拉"（限位到前车后面），绝不把它往前顶 ——
   * 往前顶会让车越过还没停靠的车站，那一站的乘客就永远上不了车（"等车的人不上车"的老毛病）。
   * 正在站台上上下客的车不动它。反方向的车互相不约束（单线路，对面来车直接会车通过）。
   *
   * ⚠ #3 公交（用户口径）：**公交车之间不再互相阻挡**。config.transit.busBlocking 默认 false，
   *   这时 _spacePair 对"**后车是公交**"的车对直接返回 —— 公交不会因为前面有车而被限位、被刹停
   *   （老行为实测：后车被压在前车后方 200 米、blockedMs 涨、速度被砍到 0.5 m/s，
   *   用户看到的就是"公交互相阻挡、排队堵在路上"）。公交慢下来只有一个原因：
   *   道路网给出的限速/拥堵系数（#16 的 congestion，railgraph 算好后烘进路径的 speed）。
   *   · 轨道车（metro / light_rail / tram / rail / crh / freight …）**保持原样**：净距照旧生效，
   *     而且判据只看后车，所以"同线混编时轨道后车跟在公交后面"这一种组合也与改动前一模一样。
   *     想让轨道也放开，就把 _spacePair 里那个 busBlocking 判断摘掉（就这一处条件）。
   *   · 站台上"多辆公交停同一个站"不会叠在同一个点：_dock 给每辆车算一个排队位
   *     （rt.dwellSlotM，见那里的说明），_updateVehiclePoint 按排队位错开画。
   *   设 config.transit.busBlocking = true 可以一键回到老行为（公交也按净距互相限位）。
   */
  _enforceSpacing(gameMs) {
    const stepMs = Math.max(0, Number(gameMs) || 0);
    const fleet = this._fleet;
    if (fleet.runningCount < 2 || fleet.byLine.size === 0) return;   // 一辆车/没有车：净距无从谈起
    // 按线路分组这件事**不用每次重算**：fleet.byLine 就是"哪条线上有哪些车"的内存索引
    // （它只在车辆改派/删除时变）。老实现每一小步都 from scratch 建一次 Map + 数组。
    // 复用同一个数组装 group，避免每小步每方向都 filter 出两个新数组。
    const group = this._spacingGroup || (this._spacingGroup = []);
    for (const [lineId, list] of fleet.byLine) {
      if (list.length < 2) continue;
      const cache = this.lineCache.get(lineId);
      if (!cache || !cache.path.length) continue;
      const pathEnd = cache.path[cache.path.length - 1].distance;
      // **一次排序 + 一次扫描**求出所有"前后车对"：原来是对每个方向 filter 出一个新数组再排序，
      // 现在是"整体按里程排序，然后按方向各扫一遍邻接"。
      // 上行方向的邻接 = 排序数组里的前一个同向车；下行方向同理，只是顺序反过来。
      // 复杂度从 O(n log n)（两次）+ O(n) 分配 降到 O(n log n)（一次）+ O(1) 分配。
      group.length = 0;
      for (const v of list) if (v.rt) group.push(v);
      if (group.length < 2) continue;
      group.sort((a, b) => a.rt.distance - b.rt.distance);
      for (const dir of [1, -1]) {
        let behind = null;          // 沿行进方向上"更靠后"的那辆车（里程更小）
        for (let i = 0; i < group.length; i++) {
          const v = group[i];
          if (((v.rt.direction > 0) ? 1 : -1) !== dir) continue;
          // ⚠ 参数顺序是 (前车, 后车)：数组按里程升序，所以 v 在 behind 的**前方**，
          // 于是 v 是 lead、behind 是 back（写反了就会变成"永远在拉前车"，净距完全不生效
          // —— 实测表现为 blockedSeconds 一直是 0、两辆车贴在一起）。
          if (behind) this._spacePair(v, behind, dir, pathEnd, stepMs, cache.path);
          behind = v;
        }
      }
    }
  }

  /** 净距约束的单个车对（见 _enforceSpacing 的说明）：只把后车往后拉，绝不往前顶 */
  _spacePair(lead, back, dir, pathEnd, stepMs, path) {
    // 站台上上下客的车、在始发站等点发车的车（#18）、以及暂停运营收车的车（#3）都不动
    if (back.rt.state === 'dwell' || back.rt.state === 'scheduled' || back.rt.state === 'paused') return;
    // ── #3 公交不互相阻挡（用户口径，config.transit.busBlocking 默认 false）──
    //   判据只看**后车**：被限位、被压速的永远是后车，所以"后车是公交 → 直接返回"就把
    //   公交的"前车压速"**完全取消**了（公交互相之间、以及公交跟在轨道车后面，都不会被压）。
    //   判据**刻意不看前车**：这样"轨道车的净距控制"在所有组合下都与改动前逐字节相同
    //   （同线混编时，轨道后车照样按 minGapMeters 跟在前面的公交后面 —— 用户口径是
    //   "轨道类保留间距控制"，一个字都不动）。想让"前面是公交时后车也放开"，把这里的
    //   `isBusVehicle(back)` 改成 `(isBusVehicle(back) || isBusVehicle(lead))` 即可。
    //   true = 玩家显式要求恢复老行为，照旧按 minGapMeters 限位。
    if (this.config.busBlocking !== true && isBusVehicle(back)) return;
    // 车长与加减速都已经是内存字段（v.lengthM / v.dyn）：这里不再走 config 解析，
    // 也不再每步调一次 dynamicsForKind（净距是每小步都跑的，那一层函数调用是白花的）
    const minGap = lead.lengthM / 2 + back.lengthM / 2 + this.config.minGapMeters;
    const leadProgress = dir > 0 ? lead.rt.distance : -lead.rt.distance;
    const backProgress = dir > 0 ? back.rt.distance : -back.rt.distance;
    if (leadProgress - backProgress >= minGap) return;
    const wantProgress = leadProgress - minGap;
    let dist = dir > 0 ? wantProgress : -wantProgress;
    dist = Math.max(0, Math.min(pathEnd, dist));
    if (Math.abs(dist - back.rt.distance) < 1e-9) {
      if (back.rt.speed > 0) back.rt.speed = 0;
      return;
    }
    back.rt.distance = dist;
    if (back.rt.speed > 0) back.rt.speed = Math.max(0, back.rt.speed - back.dyn.brake * 2);
    if (back.rt.speed < 0.2) back.rt.speed = 0;
    this._blocked = (this._blocked || 0) + 1;
    // #19 被前车压住的时长（晚点的成因之一：'blocked'，见 _recordStopObs）
    back.rt.blockedMs = (back.rt.blockedMs || 0) + stepMs;
    // #分级：被前车顶住的车立刻提到细档 —— 净距是"两辆车互相作用"，
    // 粗采样会让两辆车互相穿过去（3 游戏秒 = 50 米，而最小净距只有几十米）；
    // 同时把它这一小步的时间**只算到被顶住那一刻**（剩下的时间下一步接着走），
    // 免得粗档车被"整步限位"白白拉回 50 米。
    back.rt.lod = 1;
    back.rt.nextStepMs = Math.min(back.rt.nextStepMs, this.clockMs + 1);
    if (back.rt.usedMs == null || back.rt.usedMs > stepMs) back.rt.usedMs = Math.max(1, Math.round(stepMs));
    this._updateVehiclePoint(back.rt, path);
  }

  /**
   * 车的图上位置（lat/lon/heading）+ 空间索引（#广播按需）。
   *
   * 与老实现的差别只有最后两行：位置变了要把车挪到新的网格里（供视口取车用），
   * 并把这个"位置变了"记进脏位图（每几秒一次的批量落盘只写这些车）。
   * 注意 dirty 只标记**位置/状态**，而位置其实不必每步都落盘 —— 落盘间隔 3 秒一次，
   * 重启后车从"上次落盘的位置"继续，误差最多一个落盘间隔的里程。
   */
  _updateVehiclePoint(rt, path) {
    // #3 公交的站台排队位：只在"画在哪"上错开（rt.distance 不动 —— 到站判定 / 到站时刻 /
    //    里程累计 / 时刻表全都按 rt.distance 算，动它会连锁破坏这些）。见 _busDwellSlotM。
    const slotM = Number(rt.dwellSlotM) > 0 ? Number(rt.dwellSlotM) : 0;
    const draw = slotM > 0
      ? Math.max(0, Math.min(path[path.length - 1].distance, rt.distance - (rt.direction || 1) * slotM))
      : rt.distance;
    const pt = this._pointAt(path, draw);
    rt.lat = pt.lat;
    rt.lon = pt.lon;
    // 车头朝向（度，正北为 0）：取前方 20 米处的位置算方位角，供前端按车长画示意
    const ahead = this._pointAt(path, draw + 20 * (rt.direction || 1));
    const dLat = ahead.lat - pt.lat;
    const dLon = (ahead.lon - pt.lon) * Math.cos((pt.lat * Math.PI) / 180);
    rt.heading = (Math.atan2(dLon, dLat) * 180) / Math.PI;
    const veh = rt.veh;
    if (veh) {
      this._fleet.updateCell(veh, pt.lat, pt.lon);
      this._fleet.markDirty(veh);
    }
  }

  _isLoop(lineId) {
    const l = this._st.line.get(Number(lineId));
    return !!(l && l.loop);
  }

  _pointAt(path, distance) {
    // 线性扫描（线路节点通常几百个，够用）
    let lo = 0;
    let hi = path.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (path[mid].distance < distance) lo = mid + 1;
      else hi = mid;
    }
    const b = path[lo];
    const a = path[Math.max(0, lo - 1)];
    if (!a || a === b || b.distance === a.distance) return { lat: b.lat, lon: b.lon };
    const t = (distance - a.distance) / (b.distance - a.distance);
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  }

  /** 运营这条线的公司（老数据 line.company_id 为空时退回车辆所属公司，再退回车主） */
  _companyFor(vehicle, cache) {
    const id = cache && cache.companyId != null ? cache.companyId : vehicle.company_id;
    let c = id == null ? null : this._st.company.get(Number(id));
    if (!c && vehicle.company_id != null) c = this._st.company.get(Number(vehicle.company_id));
    if (!c && vehicle.owner) c = this.db.prepare('SELECT * FROM companies WHERE owner = ? ORDER BY id LIMIT 1').get(vehicle.owner);
    return c || null;
  }

  /**
   * 停站：**先下后上**，结算票款。这一步的算术就是"上下客与容量"的唯一实现：
   *
   *   ① 先下车（_alightAt）：到目的站的消失、到换乘站的下车去排下一段的队；
   *   ② **再算空位**：room = floor(定员 − 下车之后的 rt.load) —— 所以**同一站下车腾出来的座位
   *      当场就能被本站在等的人用上**（例：定员 13、车上有 1 人、本站他下车 → 空位 13 个，
   *      不是 12 个。这正是 NIMBY Rails 的"先下后上"：下车发生在同一次停站里）；
   *   ③ 按**本车那条线的桶**（外加兜底桶）先到先上抽人，最多抽 room 个整人，
   *      **绝不会把别条线的人拉走**，也**绝不会超过定员**（room 是上限，抽完就 break）；
   *   ④ 车上的账按"行程 × 第几段"分组（_addPaxDest），到站才知道谁下车、谁换乘。
   *
   * 于是同一站台上的两条线互不相干：1 号线的车进站，等 2 号线的人一个都不会少，
   * 直到 2 号线的车进站（那时它的载客正好 +N）。候车队伍按（车站 × 公司 × 线路）记账，
   * 所以同一条线的哪辆车来都能拉；车辆被改派到别的线路后，它原来线路上的人还留在那个
   * 桶里，新派来的车照样能拉（NR 里乘客排的是 "waited line stop"，即"我打算上的那条线的
   * 那个站"，见 Station 页的 "Group by waited line stop - Group by the next train pax
   * intend to board"）。
   *
   * 容量口径：定员 = cars × capacity_per_car（与快照里的 capacity 同一处实现）。
   * 定员被改小到低于当前载客时 room = 0，于是"一个人都上不来"，但已经在车上的人不会被赶下去
   * （NR 也没有"超员就赶人"这回事）；小数乘客（按游戏秒累积）按整人上车，零头留在桶里继续攒。
   */
  _serveStation(vehicle, cache, rt, stop) {
    const capacity = Math.max(0, (vehicle.cars || 1) * (vehicle.capacity_per_car || 60));
    rt.lastServePax = 0;      // 本站上下客人数（停站时间按它加点，见 _dock）
    rt.lastTransfers = 0;
    // 下车：乘客按**自己的行程**下车 —— 到目的站就到达（到站即消失）、到换乘站就下车去排
    // 下一段的队（NR 的 pax 是按同一目的地打成一包的；换乘站重新排"waited line stop"的队）
    const alighted = this._alightAt(rt, cache, stop);
    if (alighted > 0) {
      // ⚠ 这里**不能再减一次** rt.load：_alightAt 已经把下车的人从 rt.paxGroups 里删掉、
      // 并且把 rt.load 改成了（进站载客 − 下车人数）。以前这里又减了一次，于是载客会
      // 凭空少掉"本站下车人数"（例：车上 13 人、本站下 5 人 → 载客被记成 3 人而不是 8 人），
      // 空位因此算多，同一站上车的账也跟着错；_syncPaxDest 又会把按目的站分的账按比例缩小，
      // 于是车上的人"慢慢消失"。2026-09-20 由 tests/transit-pax-detail-test.js 的 §2 抓到
      // （13 个人在 13 个站依次下车，每站却只下去 11/12、10/12…个人）。
      // 载客与按目的站的账必须在同一处改：就是 _alightAt 里那一行。
      // 这一站下车的人里有几个是去换乘的（换乘人次记在"跑这条线的车"所属的线路账上）
      if (rt.lastTransfers > 0) this._accLineStats(vehicle.line_id, { transfers: rt.lastTransfers });
      const c = this._companyFor(vehicle, cache);
      if (c) {
        let revenue = c.revenue;
        if (this.config.economy) {
          const km = Math.max(1, cache.lengthM / 1000) * 0.6;
          revenue += (this.config.fareBase + this.config.farePerKm * km) * alighted;
        }
        this._st.updateCompany.run(c.name, c.color, c.cash, c.riders + alighted, revenue, c.spent, Date.now(), c.id);
      }
    }
    // 上车：按班次"整人"上（小数零头留在桶里继续攒），最多上到定员。
    // 公司口径必须和客流积累时完全一致（都是 cache.queueCompanyId），否则会"排了队却没人上车"。
    const companyId = cache.queueCompanyId != null ? cache.queueCompanyId : vehicle.company_id;
    const owner = cache.companyOwner || vehicle.owner;
    const entry = this._queueEntry(stop.stationId, companyId, owner);
    // 这辆车跑的是哪条线（cache 就是它的线路缓存；老数据退回 vehicle.line_id）
    const servingLineId = cache.lineId != null ? Number(cache.lineId) : (vehicle.line_id == null ? null : Number(vehicle.line_id));
    const lineKey = this._bucketKey(servingLineId);
    // 空位 = 定员 − **下车之后**的载客（下车在同一站已经结算过了，见上面的 ②）。
    // 取整 = 只上整人（乘客人数是小数，零头留在桶里继续攒）。
    let room = Math.max(0, Math.floor(capacity - rt.load));
    let boardedNow = 0;
    // 只碰这两个桶：自己那条线的桶 → 兜底桶。别条线的桶连看一眼都不看。
    const keys = lineKey ? [lineKey, 0] : [0];
    for (const key of keys) {
      if (room <= 0) break;
      const bucket = entry.buckets.get(key);
      if (!bucket) continue;
      const take = Math.min(Math.floor(bucket.waiting + 1e-9), room);
      if (take <= 0) continue;
      const { boarded, waitSum, destMix } = this._drainBucket(entry, bucket, take, this.clockMs);
      if (!(boarded > 0)) continue;
      room -= boarded;
      boardedNow += boarded;
      bucket.servedAtMs = this.clockMs;
      rt.load += boarded;
      // 上车的乘客按"行程 × 第几段"记账，到站时才知道谁该下车、谁该换乘
      this._addPaxDest(rt, destMix, servingLineId);
      // 上车人次与候车时长都记到这条线路的当日日报里（候车时长按上车人数加权）
      this._accLineStats(vehicle.line_id, { riders: boarded, waitSum, waitN: boarded });
      // 车站台账：从这一站上车 = 出发（NR 的 accounting 里"reached destination"按线路/车站记账，
      // 这里对应的"出发"也按车站记）
      this._accStationPax(stop.stationId, 'departed', boarded);
    }
    entry.servedAtMs = this.clockMs;
    rt.lastServedStation = stop.stationId;
    rt.lastServePax = (rt.lastServePax || 0) + alighted + boardedNow;
    // 本站上/下客明细：客户端据此显示"这辆车刚在哪一站上了几个人"（载客涨了多少一眼可见）
    rt.lastBoarded = boardedNow;
    rt.lastAlighted = alighted;
    this._syncPaxDest(rt);
  }

  /**
   * 到站下车。三种情况：
   *   1) 行程走完了（下一段没有了）→ **到达目的站**，paxArrived +1，到站即消失；
   *   2) 下一段还是乘车 → **换乘**：在这一站下车，去排下一段线路的队（耐心重新计时，
   *      因为 NR 里换乘的人就是在换乘站重新排"下一班车"的队）；station paxTransferred +1；
   *   3) 下一段是步行接驳（OSI）→ 下车去走那一段（站厅里带计时器，见 _addWalker）；
   *      走完再排下一段车的队（或直接到达目的地）。
   * 另外三类"没有行程"的乘客照样能坐车：
   *   · 只有目的站、没有行程（老存档 / 手工注入 / 换乘信息降级）→ 目的站就是这一站时下车；
   *   · 连目的站都没有（去向未知）→ 按统计口径下车，到两端（首站/末站）全部下车，
   *     保证这些人总能下车、不会把车塞死；
   *   · **目的站不在这条线上**（行程作废 / 线路改过站序 / 换乘链断了以后降级下来的）→ 同样按
   *     统计口径下车：他们的目的站这条线到不了，不这么办就会一直坐在车上（既到不了站也不下车）。
   * 换乘那一路的守卫在 _addWaiting 里：行程要接的那条线**现在不停这一站**时不会把乘客挂到它的
   * 桶里（用户报的「等车目的站与线路不匹配」就是缺了这个守卫）。
   * 返回下车人数。
   */
  _alightAt(rt, cache, stop) {
    const total = Math.max(0, rt.load);
    if (!(total > 0)) return 0;
    if (!(rt.paxGroups instanceof Map)) rt.paxGroups = new Map();
    const lineId = cache && cache.lineId != null ? Number(cache.lineId) : null;
    const sid = Number(stop.stationId);
    const first = cache.stops[0];
    const last = cache.stops[cache.stops.length - 1];
    const terminal = (first && sid === first.stationId) || (last && sid === last.stationId);
    const unknownRatio = Math.min(0.9, 1 / Math.max(1, cache.stops.length - 1) + 0.15);
    let out = 0;
    let transfers = 0;
    for (const [key, g] of [...rt.paxGroups]) {
      const people = g.people;
      if (!(people > 0)) { rt.paxGroups.delete(key); continue; }
      const plan = g.plan;
      if (!plan) {
        if (g.destId != null && Number(g.destId) === sid) {
          out += people;
          rt.paxGroups.delete(key);
          this._accStationPax(sid, 'arrived', people);
          continue;
        }
        // "去向未知"（destId 为空）**以及**"目的站根本不在这条线上"的乘客都按统计口径下车：
        // 后者是行程作废 / 线路改过站序之后降级下来的（见 _addWaiting / _sweepStationQueues），
        // 他们的目的站这条线到不了 —— 不这么处理，他们会一直坐在车上（永远到不了站、也永远不下车）。
        if (g.destId == null || !this._lineServesStation(lineId, g.destId)) {
          const want = terminal ? people : Math.round(people * unknownRatio);
          const gone = Math.max(0, Math.min(people, want, total - out));
          if (gone > 0) {
            out += gone;
            const left = people - gone;
            if (left > 1e-9) g.people = left;
            else rt.paxGroups.delete(key);
            this._accStationPax(sid, 'arrived', gone);
          }
        }
        continue;
      }
      const idx = g.idx == null ? 0 : Number(g.idx);
      const step = plan.steps[idx];
      if (!step || step.type !== 'ride' || Number(step.to) !== sid) continue;   // 还没到该下车的站
      if (lineId != null && Number(step.lineId) !== lineId) {
        // 车被改派到别的线上了（行程里的这一段不是这辆车在跑）：下车降级成"只有目的站"的乘客，
        // 不能把人困在车上；到目的站仍然会下车。
        out += people; transfers += people;
        rt.paxGroups.delete(key);
        this._accStationPax(sid, 'transferred', people);
        this._addWaiting(sid, cache.queueCompanyId, cache.companyOwner, null, people, this.clockMs, g.destId, null, null);
        continue;
      }
      const nIdx = idx + 1;
      if (nIdx >= plan.steps.length) {
        // 到终点站了：目的站下车（NR：到达目的地即消失）
        out += people;
        rt.paxGroups.delete(key);
        this._accStationPax(sid, 'arrived', people);
        continue;
      }
      const next = plan.steps[nIdx];
      if (next.type === 'walk') {
        // 站间步行接驳（OSI）：下车走这一段，走完再上下一段车（或直接到达）
        out += people; transfers += people;
        rt.paxGroups.delete(key);
        this._accStationPax(sid, 'transferred', people);
        this._addWalker(sid, people, g.destId, plan, nIdx + 1, this.clockMs + Math.max(0, next.sec || 0) * 1000);
        continue;
      }
      // 换乘：下车、去排下一段线路的队（换乘站重新计时，所以等待时间是"这一段的等待"）
      out += people; transfers += people;
      rt.paxGroups.delete(key);
      this._accStationPax(sid, 'transferred', people);
      const nextCache = this.lineCache.get(Number(next.lineId));
      this._addWaiting(sid,
        nextCache ? nextCache.queueCompanyId : cache.queueCompanyId,
        nextCache ? nextCache.companyOwner : cache.companyOwner,
        next.lineId, people, this.clockMs, g.destId, plan, nIdx);
    }
    if (!(out > 0)) return 0;
    // 载客只在**这一处**更新：车上的总人数与"按目的站分的账"是同一次改动，永远说得通。
    // （调用方 _serveStation 不许再减一遍，见那里的注释 —— 那是本站下车人数被减两次的老 bug）
    rt.load = Math.max(0, total - out);
    // 线路台账：这条线上有多少人是在这一站下车去换乘的（NR 的 transfers 口径）。
    // 用车辆所属的线路记账（与 riders 同一口径，见 _serveStation），临时放在 rt 上交给调用方。
    rt.lastTransfers = transfers;
    this._syncPaxDest(rt);
    return out;
  }

  /**
   * 上车的乘客按"行程 × 第几段"记账（键见 _paxGroupKey）。
   * 行程里"当前这一段"必须是这辆车跑的线；不是（线路被删过、车被改派过、兜底桶里的老乘客）
   * 就降级成"只有目的站、没有行程"的乘客：照样坐车、到目的站下车，只是不再换乘。
   */
  _addPaxDest(rt, groups, currentLineId) {
    if (!(rt.paxGroups instanceof Map)) rt.paxGroups = new Map();
    if (!groups) return;
    const lineId = currentLineId == null ? null : Number(currentLineId);
    for (const [key, g] of groups) {
      if (!(g.people > 0)) continue;
      let plan = g.plan || null;
      let idx = g.idx == null ? null : Number(g.idx);
      let k = key;
      if (plan) {
        const step = plan.steps[idx == null ? 0 : idx];
        if (!step || step.type !== 'ride' || (lineId != null && Number(step.lineId) !== lineId)) {
          plan = null; idx = null;
          k = this._paxGroupKey(null, null, g.destId);
        }
      }
      const cur = rt.paxGroups.get(k);
      if (cur) cur.people += g.people;
      else rt.paxGroups.set(k, { destId: g.destId == null ? null : Number(g.destId), people: g.people, plan, idx });
    }
  }

  /** 把"车上的总人数"与"按行程分的账"对齐（手工改过 rt.load 的情况：差额记进"去向未知"） */
  _syncPaxDest(rt) {
    if (!(rt.paxGroups instanceof Map)) rt.paxGroups = new Map();
    let sum = 0;
    for (const g of rt.paxGroups.values()) sum += g.people;
    const load = Math.max(0, rt.load);
    if (Math.abs(sum - load) < 1e-6) return;
    if (sum < load) {
      const key = this._paxGroupKey(null, null, null);
      const cur = rt.paxGroups.get(key);
      if (cur) cur.people += load - sum;
      else rt.paxGroups.set(key, { destId: null, people: load - sum, plan: null, idx: null });
      return;
    }
    const k = load / sum;
    for (const [key, g] of [...rt.paxGroups]) {
      g.people *= k;
      if (!(g.people > 1e-9)) rt.paxGroups.delete(key);
    }
  }

  /**
   * 车上乘客**按目的站分组**的账（客户端"车上每个人到哪一站下车"就靠它）。
   *
   * 这不是本作自己想出来的：NR 的车次窗口里乘客就是按目的站分组的（wiki 原文：
   * "The station and train 'passengers listing' window can be sorted to group 'by destination'.
   *  This displays all pax in the station or train, grouped by their destination."
   *  —— https://wiki.nimbyrails.com/index.php?title=Destination ），
   * 而 pax 本身就是"同一目的地打成一包"（Pax 页："the game represents pax using groups of
   *  pax with the same destination"）。所以这里给的就是**下车**口径的分组：
   *  stationId 是这包人**最终的终点站**（不是下一个换乘站）—— 换乘的人在换乘站下车时，
   *  他在车上这一段仍然记在自己的终点站名下（与 NR 的 "group by destination" 一致）。
   *
   * 返回 [{ stationId, people[, transfers] }]（按人数从多到少，同人数按 stationId）：
   *   stationId  最终目的站 id；null = 去向未知（老存档 / 手工注入 / 换乘信息降级的乘客）
   *   people     这包人的人数（**整数**：内部按游戏秒累积的是小数，见 wholePeople，
   *              这里用最大余数法取整，保证各行之和正好等于 round(载客)）
   *   transfers  这包人里"不在这辆车上坐到底"的人数（后面还有换乘 / 步行接驳的段）；
   *              没人要换乘时**不带这个键**（每 250 ms 一帧，省一个键就省一份字节）
   *
   * ⚠ 这里**不带站名**：站名在同一个快照的 stations 里已经有了，客户端本来就是按 id 自查的
   *   （public/js/transit.js 的 vehiclePaxByDest：`Transit.stationById(sid).name`）。
   *   几十辆车 × 十几个目的站每帧重复一遍站名会白白撑大帧 —— 这是本字段以前唯一的多余部分。
   *   键名保留 people（不改成 count）：客户端已经在读 d.people，改键名会让那个界面直接空掉，
   *   而"按 id 查站名 + 人数"这两件事本来就已经够客户端显示"车上每个人到哪一站下车"了。
   * 人数与 rt.load 的差额（手工改过 rt.load）由 _syncPaxDest 记进"去向未知"那一条，
   * 所以 Σpeople 始终等于车上的实际载客。
   */
  paxOnBoard(rt) {
    if (!rt || !(rt.paxGroups instanceof Map)) return [];
    const agg = new Map();
    for (const g of rt.paxGroups.values()) {
      if (!(g.people > 0)) continue;
      const key = g.destId == null ? 0 : Number(g.destId);
      const cur = agg.get(key) || { people: 0, transfers: 0 };
      cur.people += g.people;
      // 行程还没走完（后面还有段）→ 这包人中途要下车换乘 / 走接驳，不在本车坐到底
      const idx = g.idx == null ? 0 : Number(g.idx);
      if (g.plan && g.plan.steps.length > idx + 1) cur.transfers += g.people;
      agg.set(key, cur);
    }
    // 展示人数一律整数（用户报的「车上 3.4 人」）：最大余数法，合计 = round(载客)
    const peopleInt = wholePeople([...agg].map(([k, v]) => [k, v.people]));
    const transferInt = wholePeople([...agg].map(([k, v]) => [k, v.transfers]));
    const out = [];
    for (const [destId, row] of agg) {
      const one = { stationId: destId ? Number(destId) : null, people: peopleInt.get(destId) || 0 };
      const tr = row.transfers > 0 ? (transferInt.get(destId) || 0) : 0;
      if (tr > 0) one.transfers = tr;
      out.push(one);
    }
    out.sort((a, b) => (b.people - a.people) || ((a.stationId || 0) - (b.stationId || 0)));
    return out;
  }

  /** 每日维护费 */
  _dailyUpkeep() {
    if (!this.config.economy) return;
    for (const v of this._st.allVehicles.all()) {
      const cost = v.cars * this.config.maintenancePerCarPerDay;
      const c = this._st.company.get(v.owner);
      if (!c) continue;
      this._st.updateCompany.run(c.name, c.color, Math.max(0, c.cash - cost), c.riders, c.revenue, c.spent + cost, Date.now(), c.id);
    }
  }

  /** 取当前里程所在路段的限速（km/h），路径点带 speed 字段时才有值 */
  _segSpeed(path, distance) {
    let lo = 0;
    let hi = path.length - 2;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distance <= path[mid + 1].distance) hi = mid;
      else lo = mid + 1;
    }
    return path[lo] && path[lo].speed ? path[lo].speed : null;
  }

  /**
   * 只改倍速（内部用）。倍速 = 实时时间的倍数：×1 时 1 实时秒 = 1 游戏秒。
   */
  _setSpeedOnly(speed) {
    const s = Number(speed);
    if (!SPEEDS.includes(s)) throw new TransitError('倍速只能是 ' + SPEEDS.join(' / ') + '（0 为暂停）');
    this.speed = s;
    return s;
  }

  setSpeed(user, speed) {
    this._setSpeedOnly(speed);
    this._st.saveSim.run(this.clockMs, this.speed, this.day, Date.now());
    this.onChanged('clock', 0);
    return { speed: this.speed, clockMs: this.clockMs, day: this.day };
  }

  /**
   * 时钟操作（transit op `clock.set`）——三选一（可以同时给 speed）：
   *   { k:'clock.set', speed: 0|1|2|5|10|20|60|120|300 }  只改倍速（倍速 = 实时时间的倍数）
   *   { k:'clock.set', time: 'HH:MM' | 'HH:MM:SS' }       **跳到当天的这个时刻**（日期不变）
   *   { k:'clock.set', clockMs: <游戏毫秒> }              **跳到指定的"第几天几时"**：
   *        游戏毫秒从第 1 天 00:00 起算，day = floor(clockMs / 86400000) + 1
   *        （例：clockMs = 2*86400000 + 8*3600000 → 第 3 天 08:00）
   *   time 与 clockMs 不能同时给（clockMs 本身已经含了日期）。
   * 往未来跳会**逐天结算**（维护费 + 当日线路日报落盘，与正常推进同一条路径）；
   * 往过去拨只改时钟与"第几天"，已经落盘的日报不会回滚（过去的日子不会重算）。
   * 跳表后所有"等点发车"的车会重新排下一班（否则会拿着跳表前的旧班次傻等）。
   * 返回值与 clockPublic() 同形：{ clockMs, day, time, speed, ... }
   */
  setClock(user, op = {}) {
    const hasSpeed = op.speed !== undefined && op.speed !== null;
    const hasClock = op.clockMs !== undefined && op.clockMs !== null;
    const hasTime = op.time !== undefined && op.time !== null;
    if (hasClock && hasTime) {
      throw new TransitError('clock.set 不能同时给 clockMs 与 time（clockMs 本身就含"第几天"）', 'BAD_CLOCK');
    }
    if (!hasSpeed && !hasClock && !hasTime) {
      throw new TransitError('clock.set 需要 speed（倍速）、time（"HH:MM"）或 clockMs（游戏毫秒）三者之一', 'BAD_CLOCK');
    }
    if (hasSpeed) this._setSpeedOnly(op.speed);
    if (hasClock) this._jumpToMs(op.clockMs);
    else if (hasTime) this._jumpToTimeOfDay(op.time);
    this._st.saveSim.run(this.clockMs, this.speed, this.day, Date.now());
    this.onChanged('clock', 0);
    return this.clockPublic();
  }

  /** 跳到指定游戏毫秒（第几天几时） */
  _jumpToMs(raw) {
    const ms = Math.round(Number(raw));
    if (!Number.isFinite(ms) || ms < 0) throw new TransitError('clockMs 要是不小于 0 的游戏毫秒数', 'BAD_CLOCK');
    const target = Math.min(ms, 3650 * 86400000);     // 上限 10 游戏年，防手滑
    this._advanceDayTo(Math.floor(target / 86400000) + 1);
    this.clockMs = target;
    this._rescheduleWaiting();
  }

  /** 跳到"当天的 HH:MM[:SS]"（日期不变；跨天请用 clockMs） */
  _jumpToTimeOfDay(raw) {
    const sec = parseSecOfDay(raw);
    if (sec == null) throw new TransitError('时间要写成 "HH:MM" 或 "HH:MM:SS"（例如 "07:30"）', 'BAD_CLOCK');
    const dayStart = Math.floor(this.clockMs / 86400000) * 86400000;
    this.clockMs = Math.min(dayStart + sec * 1000, dayStart + (DAY_SEC - 0.001) * 1000);
    this._rescheduleWaiting();
  }

  /**
   * 跳表之后：所有"在首站等点发车"的车重新排下一班。
   * 正在跑的车不动（它接着跑完这一趟，回到首站再按新时刻排班）。
   * #3：暂停运营的线路整条跳过 —— 它现在不发车，"下一班"要等恢复运营时按新时刻重排（_resumeLine）。
   */
  _rescheduleWaiting() {
    for (const [vehicleId, rt] of this.runtime) {
      if (rt.runActive) continue;
      const v = this._st.vehicle.get(vehicleId);
      if (!v || !v.line_id) continue;
      const cache = this.lineCache.get(v.line_id);
      if (!this._usesSchedule(cache) || (cache && cache.paused)) continue;
      rt.departureMs = this._nextDepartMs(cache, vehicleId, null);
    }
  }

  /** 估算一条轨道的造价（按长度和类型） */
  estimateTrack(user, { lengthM, kind }) {
    const perM = this.config.costPerMeter[kind] || this.config.costPerMeter.surface;
    return Math.round((Number(lengthM) || 0) * perM);
  }

  /**
   * 时钟的对外快照。
   *   gameSecPerRealSec：当前"1 实时秒 = 多少游戏秒"（= 倍速本身，×1 时就是 1）
   *   unit：中文口径，便于前端直接显示"×60 = 现实 1 秒 = 游戏 1 分钟"
   */
  clockPublic() {
    return {
      clockMs: this.clockMs,
      day: this.day,
      time: this._formatClock(),
      speed: this.speed,
      gameSecPerRealSec: this.speed,
      base: CLOCK_BASE,
      unit: this.speed === 0 ? '已暂停' : `现实 1 秒 = 游戏 ${this.speed} 秒`,
    };
  }

  _formatClock() {
    const ms = this.clockMs % 86400000;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /**
   * 一辆车"现在到底在不在运营"—— **唯一口径**（帧、整份快照、车辆详情、线路运营状态共用这一处判断）。
   *
   * 返回**状态字符串**（不是布尔，客户端要按原因说话）：
   *   'run'               正在线路上运营。两种车都算：
   *                       · 班次车（headway / timetable）：`rt.runActive === true` —— 从首站发车到
   *                         "跑完这一趟回到首站"（**含从末站回场那一段**）都在运营，中途停站（state='dwell'）也算；
   *                       · 自由发车线（没有班次表）：车一直在线路上绕圈，只要没被暂停收车（state!=='paused'）就算在跑。
   *   'idle'              没指派线路（闲置车，停在车厂）。
   *   'paused'            线路已暂停运营（#3）**且这辆车已经回场了**。在途的车照样算在跑（暂停不打断这一趟，
   *                       见 _pauseHold / _endRun）：只有跑完回到首站、被收车的车才是 'paused'（已回车厂）。
   *   'before-departure'  班次车还没到本车下一班的发车时刻（在始发站等点 / 车厂）。
   *   'service-ended'     今天的班次已经跑完（本车的下一班在明天）→ 回场过夜。
   *   'no-departure'      这条线今天/明天都没有分给本车的班次（车比班次多 / 班次表为空）。
   *   'no-path'           线路还没有可跑的路径（路径不通 / 站点不足）。
   *   'not-online'        还没有运行时状态（还没被模拟步进过）。
   *
   * 只有 'run' 是"在运营"：帧里的 trains[] 只发它（见 _trainsOf），其余留在 vehicles[] 里，
   * 由 vehiclePublic 补上 inService/depot/depotReason/depotNote，客户端显示「在车厂（未运营）」。
   */
  serviceStateOf(veh, rt, cache) {
    if (!veh) return 'idle';
    const lineId = veh.lineId != null ? veh.lineId : veh.line_id;
    if (lineId == null) return 'idle';
    if (!rt) return 'not-online';
    if (!cache || !cache.stops || !cache.stops.length || !cache.path || !cache.path.length) return 'no-path';
    // 自由发车线（没有班次表）：车一直在线路上绕圈，**只有被收车（state='paused'）才在车厂**。
    // 注意这一条要排在"线路暂停"前面：自由发车线的 runActive 一直是 undefined，
    // 光看 cache.paused 会把"暂停那一刻还在路上、要把这一圈跑完"的车误判成已回车厂
    //（#3 的口径是暂停不打断在途车，见 _pauseHold / _endRun 的 cache.paused 分支）。
    if (!this._usesSchedule(cache)) return rt.state === 'paused' ? 'paused' : 'run';
    // 班次车（headway / timetable）：只有 runActive（本趟在跑，含回场段）算运营。
    // 暂停运营时在途的那一趟照旧算在跑；跑完回到首站被 _endRun 收车之后就是车厂（'paused'）。
    if (cache.paused) return rt.runActive ? 'run' : 'paused';
    if (rt.runActive) return 'run';
    const dep = rt.departureMs;
    if (dep == null) return 'no-departure';
    // 下一班在"今天之后" = 今天的班次已经跑完了（车回场过夜）；否则就是还没到发车时刻。
    // 两份时刻都是游戏毫秒（绝对时刻），所以"哪一天"直接按 86400000 取整比。
    return Math.floor(dep / 86400000) > Math.floor(this.clockMs / 86400000) ? 'service-ended' : 'before-departure';
  }

  /**
   * 「在运营吗」的布尔版，给帧的过滤器用（_trainsOf / vehicleFrame / _serviceIndex）。
   * 还没有运行时状态的车（创建后还没被模拟步进过）在这里也要判对：
   *   · 自由发车线（有可用路径）→ 算在运营（与 _runtimeFor 新建 rt 时的 state='run' 一致，老行为）；
   *   · 班次车 → 要等第一次排班（_scheduleStep）才算，在那之前它在车厂等自己的第一班。
   */
  _inServiceOf(veh) {
    if (!veh) return false;
    const cache = this.lineCache.get(veh.lineId);
    const rt = veh.rt;
    if (!rt) {
      if (!cache || !cache.path || !cache.path.length) return false;
      return this._usesSchedule(cache) ? false : true;
    }
    return this.serviceStateOf(veh, rt, cache) === 'run';
  }

  /**
   * 这一批广播里"在运营的车"的索引：#规模 —— **一次遍历，本帧所有客户端共用**
   * （见 vehicleFrame：20 个玩家各自裁剪时不必各扫一遍车队）。
   *   count    在运营的车数（帧里 hidden/totalRunning 的基数）
   *   byLine   lineId -> 在运营的车数（只在 config.frameIncludeLineCounts 打开时建）
   *   depotIds 在车厂的车 id 集合（视口取车时先记进 seen，别让它们占掉帧的配额）
   * 缓存键 = 游戏时钟 + 车队版本号（任何一辆车被算过、车队/线路构成变了都会变，见 motionSerial）。
   */
  _serviceIndex() {
    const key = `${this.clockMs}|${this.motionSerial()}|${this._fleet.running.length}`;
    if (this._svcIdx && this._svcIdx.key === key) return this._svcIdx;
    const wantByLine = !!this.config.frameIncludeLineCounts;
    const byLine = wantByLine ? new Map() : null;
    const depotIds = new Set();
    let count = 0;
    for (const veh of this._fleet.running) {
      if (!this._inServiceOf(veh)) { depotIds.add(veh.id); continue; }
      count += 1;
      if (byLine) byLine.set(veh.lineId, (byLine.get(veh.lineId) || 0) + 1);
    }
    this._svcIdx = { key, count, byLine, depotIds };
    return this._svcIdx;
  }

  /**
   * 视口外的车按线路聚合的条数（口径与 FleetStore.lineCounts 完全一致，只是**只数在运营的车**：
   * 在车厂的车不算"别处还在跑"）。最多 256 条 + 一条 'other'。
   */
  _lineCountsOf(svc) {
    if (!this.config.frameIncludeLineCounts) return null;
    const byLine = (svc && svc.byLine) || null;
    const out = Object.create(null);
    if (!byLine || !byLine.size) return out;
    const limit = 256;
    if (byLine.size <= limit) {
      for (const [lineId, n] of byLine) out[lineId] = n;
      return out;
    }
    const entries = [...byLine].sort((a, b) => b[1] - a[1]);
    let other = 0;
    for (let i = 0; i < entries.length; i++) {
      if (i < limit) out[entries[i][0]] = entries[i][1];
      else other += entries[i][1];
    }
    out.other = other;
    return out;
  }

  /**
   * 在运营的车 → 一帧的 trains 数组。
   * snapshot() 与 simFrame() 共用这一条实现，字段完全一致（客户端只认这一份）。
   *
   * #规模：**一次 SQL 都不发**。以前这里是每帧一次 `SELECT * FROM vehicles WHERE
   * line_id IS NOT NULL`（250 ms 一帧 = 每秒 4 次全表扫），现在是内存索引 this._fleet.running。
   * 字段名保持完全相同（veh 是数据库行的超集，见 transit-fleet.js 的"兼容别名"）。
   *
   * #车厂（用户口径：不在运营的车不要停在地图上）：
   *   · 广播帧（simFrame / frameFor → vehicleFrame）**只发在运营的车**（includeDepot 不传）；
   *   · 整份快照（snapshot，不是每帧的东西：welcome / transitSync / GET /api/transit）多带一份
   *     includeDepot=true 的**完整**名单，在车厂的车也在里面，但每一条都如实带 `inService:false` +
   *     depotReason/depotNote —— 客户端的 setSnapshot 按这个标记把不在运营的车从 data.trains 里摘掉
   *     （见 public/js/transit.js 的 trainsInService），所以它们永远不会被画到地图上，
   *     而车辆列表 / 车辆详情照旧拿得到「在车厂（未运营）· 下一班 08:15」这些数据。
   */
  _simTrains(includeDepot) {
    return this._trainsOf(this._fleet.running, includeDepot);
  }

  /**
   * 把一批车（veh 数组）做成帧里的 trains 数组。_simTrains 与 vehicleFrame 共用，
   * 字段完全一致；includeDepot=true 时**连在车厂的车一起带上**（整份快照用，见 _simTrains）。
   */
  _trainsOf(list, includeDepot) {
    const trains = [];
    for (const v of list) {
      const rt = v.rt || this._runtimeFor(v.id);
      if (!rt) continue;
      const cache = this.lineCache.get(v.lineId);
      const svc = this.serviceStateOf(v, rt, cache);
      const inService = svc === 'run';
      // #车厂：帧里只发在运营的车。在车厂的车留在 vehicles[] 里（vehiclePublic 带 inService/depot*）。
      if (!inService && !includeDepot) continue;
      const trip = this._tripInfo(v, cache, rt);
      const row = {
        id: v.id, owner: v.owner, lineId: v.lineId, name: v.name, kind: v.kind || 'rail',
        lengthM: v.lengthM,
        lat: rt.lat, lon: rt.lon, speed: Math.round(rt.speed * 3.6),
        load: Math.round(rt.load), capacity: v.capacity,
        state: rt.state, distance: Math.round(rt.distance), direction: rt.direction,
        heading: Math.round(rt.heading || 0),
        // #车厂：这一条是不是"在运营"的车。广播帧里永远是 true（不在运营的车根本不发），
        // 整份快照的 includeDepot=true 名单里才有 false 的那些（客户端据此不画它们，
        // 并把 depotNote 显示成「在车厂（未运营）· …」）。在运营的条目不带 depot* 字段，
        // 免得每帧给每辆车多发几十个字节。
        inService,
        // 车上乘客**按目的站**的分组（NIMBY Rails 车次窗口的 "group by destination"）：
        // [{stationId, people[, transfers]}]，只带 id 不带站名（站名在下面的 stations 里，
        // 客户端按 id 查），见 paxOnBoard 的说明。车上是空的时是空数组，不占字节。
        paxByDest: this.paxOnBoard(rt),
        // 上一次停站在哪一站、上了几个人、下了几个人：客户端详情里显示「本站上客 +N」，
        // 玩家一眼就能看到"2 号线的车进站后载客正好涨了 4"（按线路分队的验收点）
        lastServedStation: rt.lastServedStation == null ? null : Number(rt.lastServedStation),
        lastBoarded: Math.round(rt.lastBoarded || 0),
        lastAlighted: Math.round(rt.lastAlighted || 0),
        // #18 班次：下一站与预计到站秒数 / 本趟计划发车时刻 / 相对时刻表的晚点秒数
        //（自由发车的线路也有 nextStop 与 etaSeconds，只是没有时刻表可对照）
        nextStop: trip.nextStop,
        etaSeconds: trip.etaSeconds,
        scheduledDeparture: trip.scheduledDeparture,
        scheduledDepartureTime: trip.scheduledDepartureTime,
        scheduleLag: trip.scheduleLag,
        // #19 本趟剩下每一站几点到、几点发（自由发车也有）：[{stationId,name,etaGameMs,etdGameMs,distanceM,state}]
        // 数组是车上缓存复用的，这里只是把它挂上帧，不新建
        remainingStops: trip.remainingStops,
        // #19 晚点（紧凑：只给当前偏差 / 趋势 / 是否追回来过 / 本趟峰值；逐站明细在 vehicles[] 里）
        delaySeconds: trip.delaySeconds,
        delayTrend: trip.delayTrend,
        recovered: trip.recovered,
        peakDelaySeconds: trip.peakDelaySeconds,
        delaySource: trip.delaySource,
        // #19 服役时间与今日里程（客户端车辆管理器原来这两格是"—"）
        createdAt: v.createdAt,
        dayKm: rt.dayKm ? Math.round(rt.dayKm * 10) / 10 : 0,
        // 兼容老字段：在首站等几点发车（= 本车的下一班）
        scheduledHoldMs: rt.departureMs == null ? null : Math.round(rt.departureMs),
      };
      if (!inService) {
        // 在车厂的车：原因 + 中文说明（只有整份快照会走到这里，见 _simTrains 的说明）
        row.depot = true;
        row.depotReason = svc;
        row.depotNote = DEPOT_REASON_NOTE[svc] || DEPOT_REASON_NOTE['not-online'];
      }
      trains.push(row);
    }
    return trains;
  }

  /* ------------------------------ #广播按需 ------------------------------ */

  /**
   * 玩家的视口（由 index.js 从 WS 的 `view` / `move` 消息喂进来）：
   *   vehicleId -> { lat, lon, radiusM, at }
   * 没有视口的玩家（老客户端只发 move）用 move 的坐标 + config.viewportRadiusM 兜底，
   * 所以"看不见任何车"这种事故不会发生。
   */
  setPlayerView(playerId, view) {
    const id = String(playerId);
    if (!this.playerViews) this.playerViews = new Map();
    if (!view || view.lat == null || view.lon == null) { this.playerViews.delete(id); return null; }
    const lat = Number(view.lat), lon = Number(view.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { this.playerViews.delete(id); return null; }
    const out = {
      lat, lon,
      radiusM: Math.max(200, Math.min(200000, Number(view.radiusM) || Number(this.config.viewportRadiusM) || DEFAULTS.viewportRadiusM)),
      zoom: view.zoom == null ? null : Number(view.zoom),
      at: Date.now(),
    };
    this.playerViews.set(id, out);
    this._frameVehicles = null;      // 视口变了：这一帧的缓存作废
    return out;
  }

  dropPlayerView(playerId) {
    if (!this.playerViews) return false;
    const ok = this.playerViews.delete(String(playerId));
    if (ok) this._frameVehicles = null;
    return ok;
  }

  /**
   * #预算：把"上一次 tick 没算完的游戏时间余量"取走（取一次就清零）。
   * index.js 用它决定"要不要立刻接着排一段"，见那里的 runSimSlice。
   */
  consumeBudgetLeft() {
    const left = Number(this._budgetLeftMs) || 0;
    this._budgetLeftMs = 0;
    return left;
  }

  /** 这个是给"onChanged 被调用过"用的（构造函数里包了一层，见 this.onChanged 的初始化） */
  _bumpMotion() {
    this._motionSerial = (this._motionSerial || 0) + 1;
  }

  /**
   * #广播按需：车队"版本号"。**任何会影响一帧内容的东西变了都会变**：
   *   · 只要有一辆车被算过就加一（见 _simStep 结尾）—— 位置/载客/状态/班次都在这一步里变；
   *   · 车辆/线路被新建、改派、删除、撤销（onChanged）也加一 —— 车队的构成变了，
   *     那些"没上报视口、照旧收整支车队"的客户端必须重收一帧（否则它会一直用着旧名单）。
   * index.js 拿它当"这一帧需要重算/重发吗"的判据：没变 = 时钟没动 / 暂停中 /
   * 所有车都停在站台上 → 那一帧只发一个 clock（几十字节），而不是整支车队再来一遍。
   * 它是**保守的**：变过就一定加（宁可多发一帧，也不能让谁看到旧数据），而且不依赖任何哈希
   * （上万辆车的 JSON 指纹比整帧还贵）。
   */
  motionSerial() {
    return this._motionSerial || 0;
  }

  /**
   * 玩家视口的原样快照（排查 / 测试用）
   */
  playerViewSnapshot() {
    const out = {};
    if (this.playerViews) for (const [id, v] of this.playerViews) out[id] = Object.assign({}, v);
    return out;
  }

  /**
   * **一个客户端这一帧要看哪些车**（#广播按需 的核心）。
   *
   * 三条口径，缺一不可：
   *   ① 自己的车**永远带**（车辆管理器 / 车辆详情要它们，哪怕开在视野外）—— 但在车厂的除外：
   *      自己的车**全都**在车厂 / 在运营这张名单里，没发出去的那些就是"不在运营"（见 #车厂）；
   *   ② 视口内 / 视口附近（外扩 vehicleFrameBufferM）的车：带**完整实时字段**；
   *   ③ 视口外的车**不进这一帧**，改为按线路聚合的条数（frame.lineCounts）——
   *      "别的城市那条线还在正常跑"这件事用 1 个数字就够了，不需要 1 万个位置。
   *
   * 返回 { trains, hidden, lineCounts, limited }：
   *   trains      这一帧要发的车辆数组（口径与 snapshot().trains 完全一致，**只有在运营的车**）
   *   hidden      视口外没有单独发的车数（= 全服在运营的车 - 发出去的）
   *   lineCounts  按线路的在运营车数（含视口外的；只有 config.frameIncludeLineCounts 打开时给）
   *   limited     是否因为 vehicleFrameLimit 截断过
   *
   * ⚠ 同一帧的视口并集只扫一次车队（_frameFleetSet），给 20 个玩家复用；
   * 每个客户端只是在自己那一段里按"到底在不在我的视口里"再精确判一次。
   * ⚠ 「在运营的车」这份索引（_serviceIndex）也同样是**本帧只算一次**、所有客户端共用。
   */
  vehicleFrame(opts = {}) {
    const ownId = opts.owner == null ? null : opts.owner;
    const view = opts.view || null;
    const limit = Math.max(1, Number(opts.limit) || Number(this.config.vehicleFrameLimit) || DEFAULTS.vehicleFrameLimit);
    const running = this._fleet.running;
    const svc = this._serviceIndex();      // #车厂：在运营的车（帧的基数）
    // 没有视口的客户端：给一份**完整**的在运营车队（老行为），只把"聚合计数"补上。
    // 这是为了兼容"只发过 move、没发过 view"的客户端：它自己会在地图上裁剪，
    // 而车辆管理器需要完整的实时数据。
    if (!view) {
      const trains = this._trainsOf(running);
      return {
        trains, hidden: 0, limited: false, totalRunning: trains.length,
        lineCounts: this._lineCountsOf(svc),
        viewMissing: true,
      };
    }
    const picked = [];
    const seen = this._frameSeen || (this._frameSeen = new Set());
    seen.clear();
    // #车厂：在车厂的车先记进 seen —— 它们既不进这一帧，也不许占掉视口取车的配额
    // （它们在网格里是有位置的，不放行的话"视口里一堆停着的车"会把真在跑的车挤掉）。
    for (const id of svc.depotIds) seen.add(id);
    let limited = false;
    // ① 自己的车：永远带（force = true，不受 limit 影响）—— 除了在车厂的那些
    if (ownId) {
      for (const veh of running) {
        if (veh.owner !== ownId) continue;
        seen.add(veh.id);
        if (svc.depotIds.has(veh.id)) continue;
        picked.push(veh);
      }
    }
    // ② 视口（含外扩半径）内的车
    const bounds = opts.bounds || null;
    if (bounds) {
      const arr = this._fleet.pickVisible(bounds, {
        maxCount: Math.max(1, limit - picked.length) + 1,
        bufferM: Number(opts.bufferM) || 0,
        ownId: null,
        seen,
      });
      for (const veh of arr) {
        if (picked.length >= limit) { limited = true; break; }
        picked.push(veh);
      }
    }
    const trains = this._trainsOf(picked);
    const total = svc.count;
    return {
      trains,
      hidden: Math.max(0, total - trains.length),
      totalRunning: total,
      limited,
      lineCounts: this._lineCountsOf(svc),
      viewMissing: false,
    };
  }

  /**
   * 视口 → 经纬度包围盒（广播取车与 LOD 都用它）。
   * 半径按纬度修正经度方向（米 → 度），与人口网格用的是同一条换算。
   */
  viewBounds(view) {
    if (!view || view.lat == null) return null;
    const r = Math.max(200, Number(view.radiusM) || Number(this.config.viewportRadiusM) || DEFAULTS.viewportRadiusM);
    const dLat = r / 111320;
    const dLon = r / (111320 * Math.max(0.05, Math.cos((view.lat * Math.PI) / 180)));
    return {
      minLat: view.lat - dLat, maxLat: view.lat + dLat,
      minLon: view.lon - dLon, maxLon: view.lon + dLon,
    };
  }

  /**
   * #规模：仿真的实时统计（tick 预算用了多少、每一小步算了多少车、LOD 分布、
   * 车队落盘与索引的一致性）。压测脚本与 /api/transit 的 stats 都读它。
   */
  fleetStats() {
    const s = this.simStats;
    return {
      fleet: {
        total: this._fleet.totalCount,
        running: this._fleet.runningCount,
        idle: this._fleet.totalCount - this._fleet.runningCount,
        lines: this._fleet.byLine.size,
        loaded: this._fleetLoaded,
        loadMs: s.loadMs,
        cells: this._fleet.cells.size,
      },
      persist: Object.assign({}, this._fleet.stats),
      sim: {
        steps: s.steps, fineSteps: s.fineSteps, coarseSteps: s.coarseSteps, skipped: s.skipped,
        lastStepMs: s.lastStepMsReal, maxStepMs: s.maxStepMs, lastTickMs: s.lastTickMs,
        maxTickMs: s.maxTickMs, budgetHits: s.budgetHits,
        // #不阻塞事件循环：**最长同步片段** = 一小步（≤3 游戏秒）里"一口气算完"的毫秒数。
        // 它才是"事件循环被占住多久"的答案（maxTickMs 是整个 tick 的耗时，
        // tickAsync 会在小步之间让出事件循环，所以两者不是一回事）。
        longestSyncMs: s.longestSyncMs || 0, maxStepMsReal: s.maxStepMs || 0,
        lastStepVehicles: s.lastStepVehicles, lastStepFine: s.lastStepFine, lastStepCoarse: s.lastStepCoarse,
        lastViewVehicles: s.lastViewVehicles || 0,
        budgetMs: Number(this.config.simBudgetMs) || DEFAULTS.simBudgetMs,
        fineStepMs: Number(this.config.simFineStepMs) || DEFAULTS.simFineStepMs,
        coarseStepMs: Number(this.config.simCoarseStepMs) || DEFAULTS.simCoarseStepMs,
        speed: this.speed,
      },
      views: this.playerViews ? this.playerViews.size : 0,
    };
  }

  /**
   * 公司块（id / 名字 / 配色 / 现金 / 客流）的**完整一份**（不做"变了没有"的判断）。
   * simFrame() 用 companiesIfChanged()；这一份给"上一帧的公司块被慢客户端顶掉了、需要补一帧"用。
   */
  companiesFrame() {
    return this._st.companyFrameRows.all().map((r) => this.companyPublic(r));
  }

  /**
   * 公司块：**只有内容真的变了才返回数组**，没变返回 null。
   * 这一块占旧 sim 帧一半以上的字节，而它几乎不变（29x 家公司的名字/配色/归属是静态的，
   * 钱和客流只在有人上/下车时才动）。客户端的 applySim() 是 `if (msg.companies) …`，
   * 没带就继续用上一份（welcome / transitSync / GET /api/transit 里一定给过一整份）。
   */
  companiesIfChanged() {
    const rows = this._st.companyFrameRows.all();
    let sig = String(rows.length);
    for (const r of rows) {
      sig += `|${r.id},${r.owner},${r.name},${r.color},${r.cash},${r.riders},${r.revenue},${r.spent},${r.active ? 1 : 0}`;
    }
    if (this._companySig === sig) return null;
    this._companySig = sig;
    return rows.map((r) => this.companyPublic(r));
  }

  /**
   * 每 250ms 广播一次的**增量仿真帧**（index.js 的 simTimer 用它）。
   *
   * 字段：trains（**在运营的**车）+ clock（游戏时钟）+ **变了才带**的 companies。
   * 旧实现每帧都构造整份 snapshot()（实测 ~1028 KB / 15 ms），再把其中 trains 与
   * 另外重算一遍的 companies 拼成帧发出去 —— 剩下 93% 的字节（lines / stations /
   * vehicles / stats）一个消费者都没有。整份快照现在只在显式请求时构建：
   * welcome、transitSync（改完东西同步一次）、GET /api/transit（客户端按需拉实时数据）。
   *
   * #车厂（用户口径：不在运营的车不要停在地图上）：这里发的是**帧**，所以只带在运营的车
   * （_simTrains 不传 includeDepot）。在车厂的车照旧在 vehicles[] 里，带 inService:false +
   * depotReason/depotNote，客户端显示「在车厂（未运营）· 下一班 08:15」。
   *
   * ⚠ **不要在这里发整支车队**。#广播按需 的入口是 vehicleFrame(owner, view)：
   * 一个客户端只收"自己 + 视口内"的车，视口外的按线路给条数。这个函数（不带视口）
   * 只给"没有视口的调用方"用 —— 比如单测、以及要一份完整实时车队的诊断接口。
   */
  simFrame() {
    const frame = { clock: this.clockPublic(), trains: this._simTrains() };
    const companies = this.companiesIfChanged();
    if (companies) frame.companies = companies;
    return frame;
  }

  /**
   * **一个客户端的仿真帧**（index.js 的 250 ms 广播循环对每个连接各调一次）。
   *
   * 与 simFrame() 的差别只有 trains：
   *   · 只带"自己的车 + 视口内/附近的车的完整实时字段"；
   *   · 视口外的车用 frame.lineCounts（按线路的在跑条数）交代，1 万辆车也只有几十个数字；
   *   · frame.hidden 如实报出"这一帧没发给你的车有多少辆"（客户端可以提示"视野外还有 N 辆"）；
   *   · 位置/朝向是整数或 6 位小数（见 _rounded 的说明），浮点尾巴不再占字节。
   *
   * 视口来自客户端上报（index.js 把 `view` 消息喂给 setPlayerView）；
   * 没上报过视口的客户端退化成"完整车队"（老行为），不会出现"地图上一辆车都没有"。
   */
  frameFor(playerId, opts = {}) {
    const view = (this.playerViews && this.playerViews.get(String(playerId))) || null;
    const bounds = view ? this.viewBounds(view) : null;
    // 视口外的"缓冲带"（米）：**小一点**，只用来抵消"跨视口边界时闪一下"。
    // 这里踩过坑：早先用固定 2.5 km，结果 2 km 的视口配 2.5 km 缓冲 = 实际取车框 4.5 km，
    // 把整条 11 km 的线都框进来了（实测这一帧发了 200/200 辆，"按需"直接失效）。
    // 现在固定 500 m（≈ 屏幕上多两三个车身的余量），视口该多大就多大。
    const bufferM = opts.bufferM == null ? 500 : Number(opts.bufferM);
    const out = this.vehicleFrame({
      owner: opts.owner == null ? null : opts.owner,
      view,
      bounds,
      limit: opts.limit,
      bufferM,
    });
    const frame = { clock: this.clockPublic(), trains: out.trains };
    // 如实报出"这一帧没发给你的车有多少辆"（客户端可以提示"视野外还有 N 辆"）；
    // 0 且不是"没视口"时就不带这两个字段，省字节
    if (out.hidden > 0) frame.hidden = out.hidden;
    if (out.totalRunning != null && out.hidden > 0) frame.totalRunning = out.totalRunning;
    if (out.limited) frame.limited = true;
    if (out.viewMissing) frame.viewMissing = true;
    if (out.lineCounts) frame.lineCounts = out.lineCounts;
    const companies = this.companiesIfChanged();
    if (companies) frame.companies = companies;
    return frame;
  }

  /**
   * 整份状态快照（**不是每帧的东西**，别在定时器里调）：
   *   给 welcome（新玩家第一条消息）、transitSync（一次改动后同步给所有人）、
   *   GET /api/transit（客户端自己按需要拉：等车人数这类每帧不给的数据）。
   */
  snapshot() {
    const companies = this._st.allCompanies.all().map((c) => this.companyPublic(c));
    // #车厂：整份快照**连在车厂的车一起给**（它本来就不是"每帧"的东西：欢迎消息 / 改动同步 /
    // GET /api/transit），但每一条都带 inService:false + depotNote；客户端的 setSnapshot 会把
    // 不在运营的车从 data.trains 里摘掉（trainsInService），所以地图上永远只画在运营的车。
    const trains = this._simTrains(true);
    return {
      clock: this.clockPublic(),
      companies,
      trains,
      lines: this._st.allLines.all().map((l) => this.linePublic(l)),
      stations: this._st.allStations.all().map((s) => {
        const hasPlatform = kindHasPlatform(s.kind);
        // 需求走缓存（人口或日期变了才重算），所以每帧带上这几个数也不会重复查库
        const d = this.stationDemandOf(s);
        const wait = this._stationWaitSummary(s.id);
        const pax = this.stationPaxStats(s.id);
        return {
          id: s.id, owner: s.owner, companyId: s.company_id, name: s.name, kind: s.kind, lat: s.lat, lon: s.lon,
          nodeId: s.node_id, wayId: s.way_id,
          platformM: hasPlatform ? s.platform_m : 0, hasPlatform, noPlatform: !hasPlatform,
          catchmentM: s.catchment_m, showCatchment: !!s.show_catchment,
          imported: s.imported ? 1 : 0, isPublic: this._isImportedStation(s),
          // 日需求（覆盖人口 × 活跃度）与每天在这个站产生的乘客数
          demand: d.demand, dailyTrips: d.dailyTrips, density: d.density,
          // 乘客账本（当日）：到达 / 从这里出发 / 在这里换乘 / 从这里步行 / 正在步行
          paxArrived: pax.paxArrived, paxDeparted: pax.paxDeparted,
          paxTransferred: pax.paxTransferred, paxWalking: pax.paxWalking,
          // 三个数（等车人数 / 放弃人数 / 最老一批等了多久）永远带；有人在等（或有人放弃过）时
          // 再补上**分线路 + 分公司**的明细：车站管理器要显示「1 号线 6 人 / 2 号线 4 人」。
          // 空站一个字段都不加，几百个车站的快照不会因此变大。
          ...wait,
          ...(wait.waiting > 0 || wait.lost > 0 ? this.stationWaiting(s.id) : null),
        };
      }),
      vehicles: this._st.allVehicles.all().map((v) => this.vehiclePublic(v)),
      stats: this.runtimeStats(),
    };
  }

  runtimeStats() {
    // 只数个数、只求两个和：以前这里把 companies / stations / lines / vehicles 四张表整个读出来
    // 只为了 .length 与两个合计（每帧一次，白建几千个 JS 对象）
    const totals = this._st.companyTotals.get();
    return {
      companies: this._st.countCompanies.get().c,
      stations: this._st.countStations.get().c,
      lines: this._st.countLines.get().c,
      vehicles: this._st.countVehicles.get().c,
      // riders 是全网人次合计：展示一律整数（DB 里可能带小数零头，见 companyPublic 的说明）
      riders: Math.round(Number(totals ? totals.riders : 0) || 0),
      revenue: Math.round(totals ? totals.revenue : 0),
      rail: this.rail ? this.rail.stats() : null,
      // 公交路网的路口/拥堵统计（#16）：客户端据此判断能不能开"拥堵上色"这个显示模式
      road: this.bus ? Object.assign(this.bus.stats(), { congestion: this.bus.congestionStats ? this.bus.congestionStats() : null }) : null,
      population: this.population ? this.population.totals() : null,
      // O/D 需求表（NIMBY Rails 的 demand tile）统计：只在已经算过时给，避免"看一眼统计"就触发表构建
      od: this._od ? Object.assign({ builtAt: this._od.builtAt, day: this._od.day }, this._od.stats) : null,
      // 乘客账本的精简版（到达 / 出发 / 换乘 / 正在步行）：paxStats() 的完整版见那里
      pax: this._paxSummary(),
      // #19 全网晚点的一行汇总（谁能算偏差、几家准点、平均/最大晚点；按线路的明细在 lines[] 里）
      delay: this._fleetDelayStats(),
    };
  }

  /**
   * 车站乘客账本的当日汇总（只遍历 stationStats，不做任何查询；每帧快照用）。
   * ⚠ 与 paxStats() 的区别：这里只给车站侧的四个数，不汇总线路日报。
   */
  _paxSummary() {
    const day = this._paxDay && this._paxDay.day === this.day
      ? this._paxDay
      : { arrived: 0, departed: 0, transferred: 0, walked: 0 };
    return {
      day: this.day,
      arrived: Math.round(day.arrived),
      departed: Math.round(day.departed),
      transferred: Math.round(day.transferred),
      walked: Math.round(day.walked),
      walking: this.walkerCount(),
      stationCount: this.stationStats.size,
    };
  }

  /** 正在步行接驳（OSI）的乘客总数 */
  walkerCount() {
    if (!this.walkers.size) return 0;
    let n = 0;
    for (const list of this.walkers.values()) for (const w of list) n += w.people;
    return Math.round(n);
  }

  /**
   * 乘客统计总表（车站 + 线路 + 行程）：换乘 / 步行接驳的账在这里汇总。
   * 车站侧是当日累计（到达 / 出发 / 换乘 / 步行），线路侧是当日日报（人次 / 换乘人次），
   * 行程侧是 O/D 表里这次算出来的行程结构（直达 / 换乘几次 / 带步行接驳）。
   */
  paxStats() {
    const od = this._ensureOdDemand();
    const stations = { total: this._st.allStations.all().length, withDemand: 0, arrived: 0, departed: 0, transferred: 0, walked: 0, waiting: 0, lost: 0 };
    let waiting = 0;
    let lost = 0;
    for (const [, byCompany] of this.stationQueues) {
      for (const e of byCompany.values()) { waiting += e.waiting; lost += e.lost; }
    }
    const day = this._paxDay && this._paxDay.day === this.day
      ? this._paxDay
      : { arrived: 0, departed: 0, transferred: 0, walked: 0 };
    stations.arrived = Math.round(day.arrived);
    stations.departed = Math.round(day.departed);
    stations.transferred = Math.round(day.transferred);
    stations.walked = Math.round(day.walked);
    stations.waiting = Math.round(waiting);
    stations.lost = Math.round(lost);
    stations.walking = this.walkerCount();
    for (const [, st] of od.byStation) if (st.spawn > 0) stations.withDemand += 1;
    const lines = { total: 0, riders: 0, transfers: 0, vehicleKm: 0, loadSum: 0, loadN: 0, waitSum: 0, waitN: 0, top: [] };
    for (const l of this._st.allLines.all()) {
      lines.total += 1;
      const acc = this.lineStatsAcc.get(Number(l.id));
      const riders = acc && acc.day === this.day ? acc.riders : 0;
      const transfers = acc && acc.day === this.day ? acc.transfers : 0;
      lines.riders += riders;
      lines.transfers += transfers;
      lines.vehicleKm += acc && acc.day === this.day ? acc.vehicleKm : 0;
      lines.loadSum += acc && acc.day === this.day ? acc.loadSum : 0;
      lines.loadN += acc && acc.day === this.day ? acc.loadN : 0;
      lines.waitSum += acc && acc.day === this.day ? acc.waitSum : 0;
      lines.waitN += acc && acc.day === this.day ? acc.waitN : 0;
      lines.top.push({ lineId: Number(l.id), name: l.name, riders: Math.round(riders), transfers: Math.round(transfers) });
    }
    lines.top.sort((a, b) => b.riders - a.riders);
    return {
      day: this.day,
      clockMs: this.clockMs,
      time: this._formatClock(),
      od: Object.assign({ builtAt: od.builtAt, day: od.day }, od.stats),
      stations,
      lines: {
        total: lines.total,
        riders: Math.round(lines.riders),
        transfers: Math.round(lines.transfers),
        vehicleKm: Math.round(lines.vehicleKm * 10) / 10,
        avgLoad: lines.loadN > 0 ? Math.round((lines.loadSum / lines.loadN) * 1000) / 1000 : 0,
        avgWait: lines.waitN > 0 ? Math.round(lines.waitSum / lines.waitN) : 0,
        top: lines.top.slice(0, 8),
      },
      transfers: {
        paxTransferred: stations.transferred,
        lineTransfers: Math.round(lines.transfers),
        maxTransfers: this._tp.maxTransfers,
        osiRadiusM: Math.round(this._tp.osiRadius),          // 下限（wiki 的 2.3 km）
        // 换乘半径由两站覆盖范围决定（见 transferWalkRadiusM）：口径与当前步行边规模一起报出来
        transferRadiusRule: this._tp.rule,
        transferMaxRadiusM: Math.round(this._tp.maxRadius),
        transferSpreadFactor: this._tp.spreadFactor,
        transferNeighborLimit: this._tp.neighborLimit,
        walkPairs: this._itinGraph ? this._itinGraph.walk.pairs : null,
        walkLinks: this._itinGraph ? this._itinGraph.walk.links : null,
        walkSpeedMps: this._tp.walkSpeed,
        walking: stations.walking,
        walkOrigins: od.byOriginWalk.size,
      },
      itinerary: od.stats.itineraries || null,
    };
  }

  /**
   * 线路路径缓存重建（启动时 / 轨道整体变化后）。给了 ids 就只重建这几条。
   * ⚠ 这里**不**作废 O/D 表：调用方决定（全量重建时由 _railChangedAll 作废；
   * 增量重建时只有当"站点沿线里程"真的变了才作废，见 onRailChanged 的 sigBefore/sigAfter）。
   *
   * 但**候车台账必须在这里清扫一次**（_sweepStationQueues）：调用这个函数的都是"线路集合 /
   * 站序整体变了"的时机（撤销重做一整组、删车站、删公司、路网大改、启动），
   * 这些时机正是乘客手里的行程最容易过期的时候 —— 不清扫，站台上就会留下
   * "线路已经不服务这个站"的幽灵队伍（用户报的等车明细与线路不匹配）。清扫是 O(车站 × 桶)，
   * 只在结构变化时跑一次，不在每帧/每小步的热路径上。
   */
  _rebuildAllLinePaths(ids = null) {
    const list = ids || this._st.allLines.all().map((l) => l.id);
    for (const id of list) {
      try { this.rebuildPath(id); } catch (err) { console.warn('[transit] 线路路径重建失败', id, err.message); }
    }
    this._sweepStationQueues();
    return list.length;
  }

  /** 一条线路上各站"沿线里程"的签名：行程图（拿里程当边权）与 O/D 表的口径就是它 */
  _stopDistanceSig(lineId) {
    const cache = this.lineCache.get(Number(lineId));
    if (!cache || !cache.stops || !cache.stops.length) return 'none';
    let sig = '';
    for (const st of cache.stops) sig += `${st.stationId}:${Math.round(st.distance)};`;
    return sig;
  }

  /**
   * 一组 way 的经纬度包围盒（WAYS 表上每条 way 都存着自己的 min/max，一条 SQL 就够）。
   * 软删除的 way 也在表里，所以"刚被删掉的那条轨道"照样能取到范围；
   * 有任何一条 way 查不到范围（老数据缺 bbox）就返回 null —— 调用方退回全量重建，别漏。
   */
  _waysBbox(wayIds) {
    const ids = [...new Set(wayIds.map(Number).filter((n) => Number.isFinite(n)))];
    if (!ids.length) return null;
    if (!this._wayBboxStmts) this._wayBboxStmts = new Map();
    let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
    const step = 400;                     // 一条 SQL 里最多几个参数（保守值，分批查）
    for (let i = 0; i < ids.length; i += step) {
      const chunk = ids.slice(i, i + step);
      let st = this._wayBboxStmts.get(chunk.length);
      if (!st) {
        st = this.db.prepare(`SELECT COUNT(*) AS n, MIN(min_lat) AS a, MAX(max_lat) AS b,
          MIN(min_lon) AS c, MAX(max_lon) AS d FROM ways WHERE id IN (${chunk.map(() => '?').join(',')})`);
        this._wayBboxStmts.set(chunk.length, st);
      }
      let row;
      try { row = st.get(...chunk); } catch { return null; }
      if (!row || row.n !== chunk.length) return null;              // 有 way 不在库里（或已被物理删除）
      if (row.a == null || row.b == null || row.c == null || row.d == null) return null;
      if (row.a < minLat) minLat = row.a;
      if (row.b > maxLat) maxLat = row.b;
      if (row.c < minLon) minLon = row.c;
      if (row.d > maxLon) maxLon = row.d;
    }
    if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;
    return { minLat, maxLat, minLon, maxLon };
  }

  /** 路径有没有踩进这个包围盒（盒外再放宽 60 米，避免"贴着边界改一条 way"漏掉） */
  _pathHitsBox(path, box) {
    const pad = 60 / 111320;              // 60 米 ≈ 0.00054°
    const minLat = box.minLat - pad; const maxLat = box.maxLat + pad;
    const minLon = box.minLon - pad; const maxLon = box.maxLon + pad;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (p.lat >= minLat && p.lat <= maxLat && p.lon >= minLon && p.lon <= maxLon) return true;
    }
    return false;
  }

  /**
   * 轨道 / 道路网变了：重建**受影响的**线路路径，并返回这次干了什么（给日志与实测用）。
   *
   * wayIds = 这次 OSM 操作动到的 way（index.js 的 onOsmWaysChanged 抽出来的）。给了它就只重建
   * "路径踩进这些 way 的包围盒"的线路 —— 旧实现是 lineCache.clear() + 全部 13 条线路重算，
   * 实测 115~140 ms（单条公交线最长 9.5 s），而玩家改一条小路通常一条线路都不沾。
   * 没有 wayIds（例如道路网刚建好、整个图都换了）时照旧全量重建。
   *
   * 一条线路都不受影响时**连 O/D 表都不作废**：路径没变，行程图（线路-站点 + 步行接驳）与
   * 需求表的口径都没变，改一栋楼不再连累 63 个起点站的 O/D 重算（实测 114 ms）。
   */
  onRailChanged(wayIds) {
    this._importGrids = null;    // 路网变了，导入用的节点网格要重建
    const ids = Array.isArray(wayIds) ? wayIds : null;
    const box = ids && ids.length ? this._waysBbox(ids) : null;
    if (!box) return this._railChangedAll(ids ? '无法定位改动范围' : '整体重建');
    const t0 = Date.now();
    const affected = [];
    for (const line of this._st.allLines.all()) {
      const cache = this.lineCache.get(line.id);
      // 没有缓存 / 路径为空（含"上次就没连通"的线路）= 一定要重算
      if (!cache || !cache.path || !cache.path.length) { affected.push(line.id); continue; }
      if (this._pathHitsBox(cache.path, box)) affected.push(line.id);
    }
    if (!affected.length) {
      const ms = Date.now() - t0;
      if (ms > 20) console.log(`[transit] 路网改动没碰到任何线路（看了 ${ids.length} 条 way，${ms} ms）`);
      return { full: false, wayIds: ids.length, rebuilt: 0, ms, box, odDropped: false };
    }
    // 重建前先记下这几条线的"站点沿线里程"：重建后一模一样就说明路径对需求没有实质影响，
    // 行程图（用里程当边权）与 O/D 需求表都还成立 —— 这时**不作废** O/D 表，
    // 免得"改一条小路"顺手把 63 个起点站的需求重算一遍（实测那一遍约 100 ms）。
    const sigBefore = new Map();
    for (const id of affected) sigBefore.set(id, this._stopDistanceSig(id));
    for (const id of affected) this.lineCache.delete(id);
    const rebuilt = this._rebuildAllLinePaths(affected);
    let odDropped = false;
    for (const id of affected) {
      if (this._stopDistanceSig(id) !== sigBefore.get(id)) { odDropped = true; break; }
    }
    if (odDropped) this._dropOdCache();
    return { full: false, wayIds: ids.length, rebuilt, ms: Date.now() - t0, box, lines: affected, odDropped };
  }

  /** 全量重建（启动时、道路网刚建好、定位不到改动范围时的兜底）：整张图都换了，缓存一起作废 */
  _railChangedAll(reason) {
    const t0 = Date.now();
    this._dropOdCache();
    this.lineCache.clear();
    const rebuilt = this._rebuildAllLinePaths();
    const out = { full: true, reason, rebuilt, ms: Date.now() - t0, odDropped: true };
    console.log(`[transit] 全量重建线路路径（${reason}）：${rebuilt} 条 / ${out.ms} ms`);
    return out;
  }

  /* --------------------------- 底图站点导入（别从零开始画站） --------------------------- */
  /**
   * 底图导入用的"名义公司"（国铁 / 公交集团）。
   * ⚠ 它**不是**什么"系统公司"，也不代表任何归属或权限：
   *   · 导入进来的车站要落库就得有个 owner / company_id，而 ensureCompany() 是按玩家 id 找公司的，
   *     所以导入走这条固定账号，不占用任何玩家的公司，也不花任何人的钱（cost=0）；
   *   · 车站没有归属：导入站和玩家自建站一样，谁都能改名 / 删除 / 挪位置
   *     （updateStation / deleteStation 里没有任何特判）；
   *   · 这家公司本身也没有特权：deleteCompany 不挡它（它名下的导入站会跟着一起删，
   *     而导入是幂等的，随时能按底图重跑一遍）。
   * 只有"这个站从底图哪个元素来的"这条信息挂在 imported / osm_type / osm_id 上，供界面标来源。
   */
  ensureSystemCompany() {
    let c = this._st.systemCompany.get(SYSTEM_OWNER);
    if (c) return c;
    const res = this.db.prepare(`INSERT INTO companies(owner, name, color, cash, riders, revenue, spent, active, created_at, updated_at)
      VALUES(?,?,?,0,0,0,0,0,?,?)`).run(
      SYSTEM_OWNER,
      String(this.config.systemCompanyName || '国铁 / 公交集团').slice(0, 24),
      /^#[0-9a-f]{6}$/i.test(String(this.config.systemCompanyColor || '')) ? this.config.systemCompanyColor : '#607d8b',
      Date.now(), Date.now());
    c = this._st.company.get(Number(res.lastInsertRowid));
    return c;
  }

  /** 导入时的吸附半径：铁路类大一点（站台常离正线几十米），公交类小一点 */
  _importSnapMeters(kind) {
    if (kindHasPlatform(kind)) return Math.max(50, Number(this.config.importSnapRailM) || 200);
    return Math.max(30, Number(this.config.importSnapBusM) || 80);
  }

  /** 按（规则 × 元素类型 × 是否 bbox）惰性准备查询语句 */
  _importStmt(rule, type, useBbox) {
    if (!this._importStmts) this._importStmts = new Map();
    const cacheKey = `${rule.key}|${type}|${useBbox ? 'bbox' : 'all'}`;
    const hit = this._importStmts.get(cacheKey);
    if (hit) return hit;
    const [k, v] = Object.entries(rule.tags)[0];
    const like = `tags LIKE '%"${k}":"${v}"%'`;
    const st = type === 'node'
      ? (useBbox
        ? this.db.prepare(`SELECT n.id, n.lat, n.lon, n.tags FROM node_index i JOIN nodes n ON n.id = i.id
            WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND n.deleted = 0 AND ${like} LIMIT ?`)
        : this.db.prepare(`SELECT id, lat, lon, tags FROM nodes WHERE deleted = 0 AND ${like} LIMIT ?`))
      : (useBbox
        ? this.db.prepare(`SELECT w.id, w.tags FROM way_index i JOIN ways w ON w.id = i.id
            WHERE i.max_lon >= ? AND i.min_lon <= ? AND i.max_lat >= ? AND i.min_lat <= ? AND w.deleted = 0 AND ${like} LIMIT ?`)
        : this.db.prepare(`SELECT id, tags FROM ways WHERE deleted = 0 AND ${like} LIMIT ?`));
    this._importStmts.set(cacheKey, st);
    return st;
  }

  /** 长度way（站台常常是多边形/线段）→ 取节点平均值当坐标 */
  _wayCenter(wayId) {
    let rows;
    try { rows = this.db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq LIMIT 200').all(Number(wayId)); } catch { return null; }
    if (!rows.length) return null;
    const st = this.db.prepare('SELECT lat, lon FROM nodes WHERE id = ? AND deleted = 0');
    let lat = 0;
    let lon = 0;
    let n = 0;
    for (const r of rows) {
      const nd = st.get(r.node_id);
      if (!nd) continue;
      lat += nd.lat;
      lon += nd.lon;
      n += 1;
    }
    return n ? { lat: lat / n, lon: lon / n } : null;
  }

  /**
   * 导入期间用的"路网节点网格"（约 110 米一格）：一次建好，之后每个底图元素只查附近几格。
   * 直接调 RailGraph.nearestNode 是 O(全路网节点) 的，几千个元素逐个查会慢到不可用。
   */
  _importGrid(kind) {
    if (!this._importGrids) this._importGrids = new Map();
    const g = this.graph(kind);
    if (!g || !g.nodes) return null;
    const cell = 0.001;
    const hit = this._importGrids.get(kind);
    if (hit && hit.count === g.nodes.size) return hit;
    const map = new Map();
    for (const n of g.nodes.values()) {
      const k = `${Math.floor(n.lat / cell)}:${Math.floor(n.lon / cell)}`;
      let list = map.get(k);
      if (!list) { list = []; map.set(k, list); }
      list.push(n);
    }
    const entry = { cell, map, count: g.nodes.size };
    this._importGrids.set(kind, entry);
    return entry;
  }

  /** 在网格里找离 (lat, lon) 最近的路网节点（最多 maxMeters 米） */
  _importNearest(kind, lat, lon, maxMeters) {
    const grid = this._importGrid(kind);
    if (!grid) return null;
    const span = Math.max(1, Math.ceil(maxMeters / (grid.cell * 111000)));
    const ci = Math.floor(lat / grid.cell);
    const cj = Math.floor(lon / grid.cell);
    let best = null;
    let bestD = maxMeters;
    for (let i = ci - span; i <= ci + span; i++) {
      for (let j = cj - span; j <= cj + span; j++) {
        const list = grid.map.get(`${i}:${j}`);
        if (!list) continue;
        for (const n of list) {
          const d = metersBetween(lat, lon, n.lat, n.lon);
          if (d <= bestD) { bestD = d; best = n; }
        }
      }
    }
    return best ? { nodeId: best.id, lat: best.lat, lon: best.lon, distance: bestD } : null;
  }

  /** 吸附到路网：吸不上就不建站（导入站必须马上能用在线路里，否则加进线路会报"没吸附到轨道"） */
  _importSnap(kind, lat, lon, osmNodeId) {
    const g = this.graph(kind);
    if (!g || !g.nodes) return null;
    // 元素本身就是路网节点（车站/站牌通常就画在路上）→ 直接用，最准
    if (osmNodeId != null && g.nodes.has(Number(osmNodeId))) {
      const nodeId = Number(osmNodeId);
      const w = this.db.prepare('SELECT way_id FROM way_nodes WHERE node_id = ? LIMIT 1').get(nodeId);
      return { nodeId, wayId: w ? w.way_id : null, distance: 0, direct: true };
    }
    const maxM = this._importSnapMeters(kind);
    // 公交站：按"最近可通行路段"吸附（和玩家手动建站同一套口径，见 _snapStation）
    if (kind === 'bus' && typeof g.nearestRoadPoint === 'function') {
      const rp = g.nearestRoadPoint(lat, lon, maxM);
      if (!rp) return null;
      return { nodeId: rp.nodeId, wayId: rp.wayId != null ? rp.wayId : this._wayOfNode(rp.nodeId), distance: Math.round(rp.distance), direct: false };
    }
    const near = this._importNearest(kind, lat, lon, maxM);
    if (!near) return null;
    return { nodeId: near.nodeId, wayId: this._wayOfNode(near.nodeId), distance: Math.round(near.distance), direct: false };
  }

  /** bbox 参数：{minLat,minLon,maxLat,maxLon} 或 [minLon,minLat,maxLon,maxLat] */
  _parseBbox(raw) {
    if (!raw) return null;
    let minLon; let minLat; let maxLon; let maxLat;
    if (Array.isArray(raw) && raw.length >= 4) {
      [minLon, minLat, maxLon, maxLat] = raw.map(Number);
    } else if (typeof raw === 'object') {
      minLat = Number(raw.minLat); maxLat = Number(raw.maxLat);
      minLon = Number(raw.minLon); maxLon = Number(raw.maxLon);
    }
    if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) return null;
    return {
      minLat: Math.min(minLat, maxLat), maxLat: Math.max(minLat, maxLat),
      minLon: Math.min(minLon, maxLon), maxLon: Math.max(minLon, maxLon),
    };
  }

  /**
   * transit op：import.stations { bbox | all, limit }
   * 扫底图里"像车站"的元素 → 变成游戏里的车站：
   *   railway=station|halt|tram_stop|subway_entrance、public_transport=station|stop_position|platform、
   *   highway=bus_stop、amenity=bus_station（节点和 way 都认，站台/polygon 取节点平均位置）
   * 名字取 name / name:zh，类型由标签推（rail/subway/tram/light_rail/hsr/bus），
   * node_id 吸附到路网节点（站牌本身是路网节点时直接用它）、way_id 记所在道路/轨道，
   * owner/company_id 挂在那条不参与玩法的名义账号上、imported=1，并用 osm_type/osm_id 记住来源
   * —— 重复导入不会重复建站（幂等）。
   * ⚠ 导入站**不是"公共车站"**：它没有归属，谁都能改名 / 删除 / 挪位置（见 updateStation / deleteStation），
   *   imported / osm_type / osm_id 只是"它从底图哪个元素来的"这条信息，供界面标来源。
   */
  importStations(user, op = {}) {
    const t0 = Date.now();
    const wantAll = op.all === true || op.all === 1 || op.all === 'true';
    const bbox = this._parseBbox(op.bbox);
    if (!wantAll && !bbox) throw new TransitError('要么给 bbox（只导视野内），要么 all:true（整张底图）');
    const hardMax = Math.max(1, Number(this.config.importMaxLimit) || 5000);
    const limit = Math.max(1, Math.min(hardMax, Math.round(Number(op.limit) || Number(this.config.importLimit) || 300)));
    const company = this.ensureSystemCompany();
    const CELL = 0.0005;   // ≈ 55 米一格，用来快速查"这一带是不是已经有站了"
    const ck = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
    const grid = new Map();
    for (const s of this._st.allStations.all()) {
      const k = ck(s.lat, s.lon);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }
    const clash = (lat, lon, kind, meters) => {
      const ci = Math.floor(lat / CELL);
      const cj = Math.floor(lon / CELL);
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          const list = grid.get(`${i}:${j}`);
          if (!list) continue;
          for (const s of list) {
            if (s.kind !== kind) continue;
            if (metersBetween(lat, lon, s.lat, s.lon) <= meters) return s;
          }
        }
      }
      return null;
    };
    const keep = (row) => {
      const k = ck(row.lat, row.lon);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(row);
    };

    const byKind = {};
    const bySource = {};
    const samples = [];
    let scanned = 0;
    let created = 0;
    let skippedExisting = 0;   // 这个 OSM 元素以前导入过（幂等）
    let skippedNear = 0;       // 附近已经有同类型的站了（避免重复站）
    let unlinked = 0;          // 离路网太远，先不建
    const useBbox = !wantAll;
    for (const rule of IMPORT_RULES) {
      if (created >= limit) break;
      for (const type of ['node', 'way']) {
        if (created >= limit) break;
        const cap = Math.max(20, limit * 4);
        let rows;
        try {
          // rtree 的参数顺序和 osmdb.js 一致：(minLon, maxLon, minLat, maxLat, limit)
          rows = useBbox
            ? this._importStmt(rule, type, true).all(bbox.minLon, bbox.maxLon, bbox.minLat, bbox.maxLat, cap)
            : this._importStmt(rule, type, false).all(cap);
        } catch (err) {
          console.warn('[transit] 导入扫描失败:', rule.key, type, err.message);
          continue;
        }
        for (const row of rows) {
          if (created >= limit) break;
          scanned += 1;
          let tags = null;
          try { tags = row.tags ? JSON.parse(row.tags) : null; } catch { tags = null; }
          if (!tags) continue;
          const kind = stationKindFromTags(tags);
          if (!kind) continue;
          const pos = type === 'node' ? { lat: row.lat, lon: row.lon } : this._wayCenter(row.id);
          if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) continue;
          if (bbox && !wantAll && (pos.lat < bbox.minLat || pos.lat > bbox.maxLat || pos.lon < bbox.minLon || pos.lon > bbox.maxLon)) continue;
          if (this._st.stationByOsm.get(type, row.id)) { skippedExisting += 1; continue; }
          if (clash(pos.lat, pos.lon, kind, 25)) { skippedNear += 1; continue; }
          const snap = this._importSnap(kind, pos.lat, pos.lon, type === 'node' ? row.id : null);
          if (!snap) { unlinked += 1; continue; }
          const name = stationNameFromTags(tags, kind, row.id);
          const hasPlatform = kindHasPlatform(kind);
          const platformM = hasPlatform ? 120 : 0;
          const catchmentM = kind === 'bus' ? 450 : 700;
          let res;
          try {
            res = this._st.insertImportedStation.run(
              SYSTEM_OWNER, company.id, name, kind, pos.lat, pos.lon, snap.nodeId, type === 'way' ? Number(row.id) : snap.wayId,
              platformM, catchmentM, 0, 0, Date.now(), type, Number(row.id));
          } catch (err) {
            // 唯一索引撞车（同一个元素并发导入）→ 当作已存在
            skippedExisting += 1;
            continue;
          }
          const station = this._st.station.get(Number(res.lastInsertRowid));
          keep(station);
          created += 1;
          byKind[kind] = (byKind[kind] || 0) + 1;
          const srcKey = `${type}:${rule.key}`;
          bySource[srcKey] = (bySource[srcKey] || 0) + 1;
          if (samples.length < 8) samples.push({ id: station.id, name: station.name, kind, osm: srcKey, nodeId: station.node_id, wayId: station.way_id });
        }
      }
    }
    if (created > 0) {
      this._dropDemandCache();    // 新导入的车站进 O/D 表：需求缓存与 O/D 表都要重算
      this.onChanged('station.import', 0);
    }
    return {
      ok: true, created, scanned, skippedExisting, skippedNear, unlinked,
      limit, all: wantAll, bbox: bbox || null,
      byKind, bySource, samples,
      company: this.companyPublic(company),
      importedTotal: this._st.importedCount.get().c,
      ms: Date.now() - t0,
    };
  }

  /** 启动时自动导入一次（config.importStationsOnStart 默认关）：等路网建好再跑，跑过就不再跑 */
  _maybeStartupImport() {
    const st = this._startupImport;
    if (!st || !st.pending || st.done) return;
    if (!this.rail || !this.rail.nodes || !this.rail.nodes.size) return;   // 铁路网还没建好，下一个 tick 再说
    st.done = true;
    try {
      const res = this.importStations({ id: SYSTEM_OWNER, name: '系统' }, { all: true, limit: this.config.importLimit });
      st.result = res;
      console.log(`[transit] 启动导入底图车站：新建 ${res.created} 个（已存在 ${res.skippedExisting} / 太远未接入 ${res.unlinked} / 附近已有 ${res.skippedNear}，${res.ms} ms）`);
    } catch (err) {
      console.warn('[transit] 启动导入底图车站失败:', err.message);
    }
  }

  /** 统一操作入口 */
  apply(user, op) {
    if (!op || typeof op.k !== 'string') throw new TransitError('操作格式不正确');
    // 分组（beginGroup / endGroup / groupLabel）统一交给与 OsmOps 共用的那条总线处理
    if (this.undoBus && !this._groupSuspend && !READ_ONLY_OPS.has(op.k)) this.undoBus.note(user, op);
    switch (op.k) {
      case 'company.set': return this.setCompanyProfile(user, op);
      case 'company.create': return { company: this.companyPublic(this.createCompany(user, op)) };
      case 'company.select': return this.selectCompany(user, op);
      case 'company.delete': return this.deleteCompany(user, op);
      case 'station.create': return this.createStation(user, op);
      case 'station.update': return this.updateStation(user, op);
      case 'station.delete': return this.deleteStation(user, op);
      case 'station.waiting': return { station: this.stationPublic(this._st.station.get(Number(op.id))) };
      case 'import.stations': return this.importStations(user, op);
      case 'line.create': return this.createLine(user, op);
      case 'line.update': return this.updateLine(user, op);
      case 'line.delete': return this.deleteLine(user, op);
      // #2 线路归属转移（转到别家公司名下，可选把线上的车一起转）
      case 'line.transfer': return this.transferLine(user, op);
      // #3 一键暂停 / 恢复运营（不发新车；已经在路上的车跑完这一趟再收车）
      case 'line.setService': return this.setService(user, op);
      case 'line.stats': return this.lineStatsOp(user, op);
      case 'vehicle.create': return this.createVehicle(user, op);
      case 'vehicle.update': return this.updateVehicle(user, op);
      case 'vehicle.delete': return this.deleteVehicle(user, op);
      case 'clock.set': return this.setClock(user, op);
      // 元素锁（协作编辑的冲突保护）：谁在改谁上锁，别人拿到明确的中文错误，直到解锁或超时
      case 'lock.set': return this.lockElement(user, op);
      case 'undo': return this._undo(user, op);
      case 'redo': return this._redo(user, op);
      // 分组撤销：与 OSM 通道共用同一条时间线（所以一组里可以同时有车站/线路/车辆和 OSM 编辑）
      case 'beginGroup':
      case 'endGroup':
      case 'abortGroup':
      case 'groupStatus':
        return this.undoBus.op(user, op, { src: this.undoSrc });
      case 'kinds': return {
        kinds: VEHICLE_KINDS, stationKinds: STATION_KINDS, speeds: SPEEDS, dynamics: VEHICLE_DYNAMICS,
        scheduleModes: [...SCHEDULE_MODES], clockBase: CLOCK_BASE,
      };
      // #16 拥堵：客户端可以拿它画一种新的"道路拥堵"显示模式
      case 'road.congestion': return this.roadCongestion(op);
      case 'road.congestion.way': return this.roadCongestionWay(op);
      // NIMBY Rails 口径的 O/D 需求表（调试，以及"这条线到底能拉多少人"的展示）
      case 'od.stats': return this.odDemandOp(op);
      // 乘客总账（到达 / 出发 / 换乘 / 步行接驳 / 行程结构）：Transit#paxStats() 的 op 入口
      case 'pax.stats': return Object.assign({ ok: true }, this.paxStats());
      default: throw new TransitError('未知操作：' + op.k);
    }
  }

  /* ------------------------------ #16 拥堵系数（暴露给客户端） ------------------------------ */
  /**
   * transit op：road.congestion { bbox, limit, withCoords, minCongestion }
   * 返回视野内每条可通行道路的拥堵系数 / 服务速度 / 限速 / 路口数 / 路口密度，客户端按这个给道路上色
   * （一种新的显示模式）。bbox 用 [minLon, minLat, maxLon, maxLat] 或 {minLat,minLon,maxLat,maxLon}。
   * 返回 { ok, mode, bbox, count, total, ways:[{wayId, kind, congestion, speed, limit, junctions, density, lengthM, level, coords?}], stats }
   */
  roadCongestion(op = {}) {
    const bbox = this._parseBbox(op.bbox);
    if (!bbox) throw new TransitError('要么给 bbox（只算视野内），要么用 road.congestion.way 查单条道路');
    const road = this.bus || (this.ensureBusGraph ? this.ensureBusGraph() : null);
    if (!road || !road.congestionInBbox) throw new TransitError('公交路网还没有构建完成，稍后再试', 'NOTREADY');
    const res = road.congestionInBbox(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat, {
      limit: op.limit,
      withCoords: op.withCoords === true || op.withCoords === 1,
      minCongestion: op.minCongestion,
    });
    return Object.assign({ ok: true }, res);
  }

  /** transit op：road.congestion.way { id } —— 单条道路的拥堵明细 */
  roadCongestionWay(op = {}) {
    const road = this.bus || (this.ensureBusGraph ? this.ensureBusGraph() : null);
    if (!road || !road.wayStats) throw new TransitError('公交路网还没有构建完成，稍后再试', 'NOTREADY');
    const way = road.wayStats(Number(op.id != null ? op.id : op.wayId));
    if (!way) throw new TransitError('这不是一条可通行的道路（或不在路网里）', 'NOTFOUND');
    return { ok: true, way, coords: op.withCoords ? road.wayCoords(way.wayId) : undefined };
  }

  /** transit op：od.stats —— O/D 需求表的统计（NIMBY Rails 的 demand tile） */
  odDemandOp(op = {}) {
    const od = this._ensureOdDemand();
    const out = { ok: true, stats: Object.assign({ builtAt: od.builtAt, day: od.day }, od.stats) };
    const stationId = Number(op.stationId);
    if (Number.isFinite(stationId)) {
      const st = od.stations.get(stationId);
      if (st) {
        out.station = {
          id: st.id, name: st.name, coverage: st.coverage, pop: st.pop, activity: st.activity,
          density: st.density, demand: st.demand, dailyTrips: st.dailyTrips, lines: st.lines,
        };
        out.od = od.byStation.get(stationId) || null;
      }
    }
    return out;
  }
}

module.exports = {
  Transit, TransitError, DEFAULTS, VEHICLE_KINDS, VEHICLE_DYNAMICS, dynamicsForKind,
  // 时间倍速档与时间基准（index.js 的 publicTransitConfig 会下发给前端）
  SPEEDS, CLOCK_BASE,
};
