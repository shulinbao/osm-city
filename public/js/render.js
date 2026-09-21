'use strict';
/**
 * 矢量渲染：把 OSM 数据画成地图。
 *  - 面（用地/水面/建筑）与线（道路/铁路/水系/边界）用 Leaflet canvas 图层，按 OSM Carto 风格分层
 *  - 标签、POI 图标、协作者光标、选中高亮、元素锁、绘制预览统一画在一张覆盖画布上（自己控制顺序与避让）
 */
(function () {
  const { util, World } = window.G;

  const PANES = {
    fill: 300,
    casing: 310,
    core: 320,
    // 建筑放在道路之上：高楼要能挡住它后面的道路、河道（屋顶只向右上偏移，
    // 不会盖住自己前方的东西，所以这样排不会误遮前面的路）
    building: 330,
    focus: 335,
    overlay: 340,
  };
  const LABEL_COLLISION_PAD = 2;
  /** 伪 3D 的相机方向（屏幕坐标下相机在左下方）：屋顶往右上方偏移，只画朝向相机的那侧立面 */
  const VIEW = { x: -0.387, y: 0.921 };

  /* ------------------------------------------------------------------ *
   * 分块降级（#3 严格 LOD，但永不截断）
   *
   * 以前只有两种极端：要么全画（几十万个要素时一帧画不完），要么整屏截断（路少一半）。
   * 现在按"小区尺度"分块：
   *   · 视口切成 300 米见方的区块 —— 一个小区 / 一个街坊，绝不会是"整城"；
   *   · 每个区块单独统计"可简化的要素"：装饰性面（建筑、小面积用地）、POI 图标/标签、
   *     以及**次要道路**（见下面的道路等级表）；
   *   · 只有超过门槛的区块才简化，而且简化**只丢"可简化的那一部分"**：
   *     motorway/trunk/primary、铁路、水系、水域、骨架用地、行政边界一律照画
   *     （所以"主干道该画却没画"恒为 0，见 completeness().roadsMissing）；
   *   · 被简化的区块逐个铺半透明色块，并在成片的角上挂说明 + "?"，玩家一眼就知道"这一块被简略了"，
   *     放大地图（门槛随缩放提高、能省到的等级也随缩放变浅）就会自动恢复完整。
   * ------------------------------------------------------------------ */
  /** 区块边长（米）：300 米 ≈ 一个小区 / 一个街坊的尺度 */
  const BLOCK_SIZE_M = 300;
  /**
   * 每个区块允许的"可简化要素"上限（按缩放给不同门槛）。
   * 计数口径 = 装饰性面 + POI + **可被区块简化的次要道路**（等级比"这一档能留到的等级"更深的路）。
   *   · 数值按**真实密度**校准：实测北京中心一个 300 米街区里"可简化要素"的分布是
   *     z13 中位数 2 / p90 5 / p99 12 / 最大 22 —— 老门槛（80~300）永远不会触发，
   *     所以机制一直是"摆设"。现在的门槛落在 p99 附近：只有真正密的街坊才会被简略。
   *   · 门槛**永远随缩放单调不减**，所以"放大之后同一块只会更松，绝不会更严"。
   */
  /**
   * ⚠ 2026-09 实测修正（#6a）：**门槛的计数口径以前把"屏幕上根本看不见的要素"也算进去了**，
   * 于是 z17/z19 上一屏只画几十个图形却报"要素过密"、把成片的建筑与 POI 简略掉。
   * 现在两道闸一起改：
   *   1) 计数只数**真的会画在屏幕上的**那份（见 countBlockFeatures：先过面积 LOD、
   *      再要求落在**真实视野框**里 —— 画布 padding 那一圈玩家看不见，不算）；
   *   2) 门槛按**真实分布**重新校准：用 `node tmp-verify/lod-z19/sim.js --script calib`
   *      逐档量"每个 300 米街区真的会画出来多少个可简化要素"（p50/p90/p99/max），
   *      门槛取到 ≈ 2×max（也就是 p100 之上），只有真正病态的街区才会触发。
   *
   * 实测（北京中心，1400×900，z16 冷启动后逐档放大；口径 = 视野内真画出来的可简化要素/街区）：
   *   z12 617 块 p50 1 / p99 2 / max 3      z16 82 块 p50 2 / p99 8 / max 10
   *   z13 434 块 p50 1 / p99 2 / max 3      z17 29 块 p50 15 / p99 36 / max 36
   *   z14 186 块 p50 1 / p99 2 / max 2      z18 23 块 p50 13 / p99 48 / max 48
   *   z15  90 块 p50 1 / p99 2 / max 3      z19 11 块 p50 14 / p99 31 / max 31
   * 老表（z17 18 / z18 24 / z19 40）落在 p90~p99 之间，所以 z17/z19 上"正常街区"也会被简略；
   * 新表把高缩放抬到 max 之上（z17 60 / z18 90 / z19 140），低缩放（z ≤ 15）维持原值 ——
   * 那里才是分块降级真正要救的场（一屏几千个街区），而且那些档位的密度几乎到不了门槛，
   * 真正兜底的是下面的 BLOCK_BUDGET（一屏总量预算）。
   */
  const BLOCK_THRESHOLDS = [
    [12, 8], [13, 10], [14, 10], [15, 12], [16, 20], [17, 60], [18, 90],
    [19, 140], [20, 220], [21, 320], [22, 450],
  ];
  /**
   * 一屏允许画出的"可简化要素"总量（按缩放给预算）。
   * 为什么除了"街区密度"还需要它：低缩放下（z12/z13）一屏横跨几千个 300 米街区，
   * 每个街区都不算特别密（中位数才 2 个），但**加起来几万个** —— 只按密度判，
   * 机制永远不会触发，"不管什么分辨率都能急速加载"就是一句空话。
   * 超预算时按"最密的街区先简略"往下压，直到画出来的量回到预算内；
   * 被压到的街区**照样逐块铺阴影 + 标注 + "?"**，放大到门槛更松的档位就恢复。
   */
  const BLOCK_BUDGET = [
    [11, 2200], [12, 3000], [13, 3200], [14, 1300], [15, 1100], [16, 900],
    [17, 1500], [18, 2400], [19, 4000], [20, 7000], [21, 12000], [22, 20000],
  ];
  /** 被简化时"多大面积以上的面还留着"（平方米）：小房子/小绿地是主要噪音，大块地与大建筑保留 */
  const BLOCK_KEEP_AREA = [
    [13, 200000], [14, 80000], [15, 25000], [16, 6000], [17, 1500], [18, 500],
    [19, 600], [20, 500], [21, 400], [22, 300],
  ];
  /**
   * 一次重建里最多简化多少个区块（最密的优先）。
   * 上限存在的意义是"绝不整城简化"：低缩放下一屏有几千个街区，全压下去就等于整屏截断；
   * 400 块 ≈ 一屏街区的 15~20%，正好覆盖"最密的那些小区"，同时保证地图不会被阴影糊满。
   */
  const MAX_DEGRADED_BLOCKS = 400;
  /** 图上"本区块要素过密…"注释一次最多画几条（色块不受这个限制，被简化就一定看得见） */
  const MAX_BLOCK_NOTES = 60;
  /** 区块注释的中文（画在地图上，只在那一块被简化时出现） */
  const BLOCK_NOTE = '本区块要素过密，已简略显示 · 缩放可看全部';
  /** 区块色块（默认）：半透明填充 + 1px 描边，一眼看出是哪一小块被简化了 */
  const BLOCK_FILL = 'rgba(255,180,80,0.10)';
  const BLOCK_STROKE = 'rgba(255,160,40,0.55)';
  /** 区块"?"提示的中文（鼠标悬停时由浏览器原生 tooltip 显示） */
  const BLOCK_TIP = '这一块要素过多，已自动简略显示：省略的是装饰性小面、小标签与本街区最次要的那几级道路；'
    + 'motorway/trunk/primary、铁路、水系、水域、边界一条不缺，放大即可看全。点"?"可以关掉区块高亮。';

  /* ================================================================================== *
   *                        道路等级表（客户端与服务端**共用同一张表**）
   *
   * 需求：低缩放不下发次要道路（服务端那条战线），客户端拿到之后**怎么画**由这张表决定。
   * 两边必须用同一张表，否则会出现"服务端筛了、客户端还在等它"（或反过来：客户端筛了、服务器白发）。
   *
   *  rank 0  motorway / trunk / primary（含 _link）          主干：**任何档位、任何区块都不简化**
   *  rank 1  secondary（含 _link）                            次要干道
   *  rank 2  tertiary（含 _link）
   *  rank 3  unclassified / residential / living_street / road
   *  rank 4  service / track / footway / path / cycleway / steps / pedestrian / bridleway /
   *          corridor / busway / bus_guideway / construction / proposed / raceway
   *  rank 5  未知 highway 值
   *  rank -1 不是道路（railway / waterway / 水域 / 建筑 / 边界…）：**永不参与简化**
   *
   * 两列数字（`ROAD_CLASS_TABLE`，都是"留到第几级"= keepRank）：
   *   · `blockKeep`  ：**区块过密时**还画到第几级（rank ≤ blockKeep 照画，更深的整块不画）；
   *   · `serverSend` ：建议**服务端下发到第几级**（永远 ≥ blockKeep）。
   *       分工：服务端负责"别白发"（低缩放根本不发最细那几级，省带宽与合并时间），
   *             客户端负责"过密街区再收紧"（同一份数据里，只把最密的那几个街坊简化掉）。
   *       因为 serverSend ≥ blockKeep，所以**客户端永远不会等一份服务端不该发的数据**；
   *       反过来，客户端也绝不会去画一张服务端没下发的等级 —— 两边没有"互相等"的缝。
   *
   * 举例（当前值）：
   *   z12：服务端只下发 secondary 及以上；客户端过密街区只留 primary 及以上；
   *   z13：服务端下发 tertiary 及以上；客户端过密街区只留 secondary 及以上；
   *   z14：服务端下发 residential 那一级；客户端过密街区只留 tertiary 及以上；
   *   z16+：服务端全发；客户端过密街区才留到 service 那一级（等于"道路基本不简化"）。
   * ================================================================================== */
  const ROAD_CLASS_TABLE = [
    // zoom, blockKeep(区块过密时留到第几级), serverSend(建议服务端下发到第几级)
    [10, 0, 0],
    [11, 0, 1],
    [12, 0, 1],
    [13, 1, 2],
    [14, 2, 3],
    [15, 3, 4],
    [16, 4, 4],
    [17, 4, 4],
    [18, 4, 4],
    [19, 5, 5],
    [20, 5, 5],
    [21, 5, 5],
    [22, 5, 5],
  ];
  /** highway 值 → 等级（rank）。表里没有的走 unknownHighwayRank / 兜底 */
  const ROAD_RANKS = {
    motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 0, primary_link: 0,
    secondary: 1, secondary_link: 1,
    tertiary: 2, tertiary_link: 2,
    unclassified: 3, residential: 3, living_street: 3, road: 3,
    service: 4, track: 4, footway: 4, path: 4, cycleway: 4, steps: 4, pedestrian: 4,
    bridleway: 4, corridor: 4, busway: 4, bus_guideway: 4, construction: 4, proposed: 4, raceway: 4,
  };
  /** 等级 → 中文名（自检/状态栏/日志用；也让"简化了哪一级"读得懂） */
  const ROAD_RANK_NAMES = ['主干(motorway/trunk/primary)', '次要干道(secondary)', '三级(tertiary)',
    '居民区道路(residential/unclassified/living_street)', '最细(service/track/footway/path…)', '未知等级'];

  /** 阶梯表插值，但超出表尾返回 0（面积门槛用它：放大到一定程度就不该再筛） */
  function stepValueZero(table, zoom) {
    if (!table || !table.length) return 0;
    if (zoom <= table[0][0]) return table[0][1];
    for (let i = 0; i < table.length; i++) if (zoom <= table[i][0]) return table[i][1];
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * 面的面积 LOD（**唯一一张表**，按缩放给"多小的面不画"，单位 m²）
   *
   * 需求（#6b）：面（建筑 / 区域）的详略必须**随缩放变化**，而且只能有一张可配置的表：
   * 缩放越大、屏幕上一平方米占的像素越多，能省掉的最小面积就越小 ——
   *   z13 ≥ 20000 m²（整城视图只留大片用地）
   *   z15 ≥ 1500
   *   z17 ≥ 200
   *   z19 ≥ 20   （z19 连 20 m² 的小棚子都画，肉眼已经能看清）
   * 表是**活的**：`Render.AREA_LOD = [...]` 或 `Render.setAreaLod([...])` 立刻生效；
   * 清空表 / `Render.areaLodEnabled = false` 就等于"完整"档（一块都不按面积筛）。
   *
   * 谁受影响：装饰性面（建筑、绿地、水面之外的零散用地…）与**多面体关系**的面；
   * 谁不受影响（原样保留，见 detailMinAreaM2 的豁免表）：
   *   水域（natural=water / waterway / landuse=reservoir…）、行政边界、有名字或 5 层以上的重要建筑、
   *   以及"档位 = 完整 / 全部道路"（那时整张表都不用）。
   * 道路/铁路/水系线要素从来不走这张表 —— "道路一条不缺"的承诺不受它影响。
   * ------------------------------------------------------------------ */
  const AREA_LOD_M2 = [
    [13, 20000], [14, 6000], [15, 1500], [16, 400], [17, 200], [18, 60],
    [19, 20], [20, 15], [21, 10], [22, 8],
  ];
  const STANDARD_FILL_ZOOM_BIAS = 1;
  /**
   * 兼容别名：老代码/老自检读的是 `Render.STANDARD.minAreaM2`（= 默认档的面积门槛表）。
   * 现在它就是上面那张唯一的 `AREA_LOD_M2`（同一份内容，改哪边都生效 —— 见 setAreaLod）。
   */
  const STANDARD_MIN_AREA = AREA_LOD_M2;
  /** 默认档位的档位号（4 = 标准） */
  const DEFAULT_DETAIL_LEVEL = 4;

  /** 阶梯表插值（缩放在表外就取端点）：[[zoom, value], ...] */
  function stepValue(table, zoom) {
    if (!table || !table.length) return 0;
    if (zoom <= table[0][0]) return table[0][1];
    for (let i = 0; i < table.length; i++) if (zoom <= table[i][0]) return table[i][1];
    return table[table.length - 1][1];
  }

  /** 阶梯表插值，但超出表尾返回 0（面积门槛用它：放大到一定程度就不该再筛） */
  function stepValueZero(table, zoom) {
    if (!table || !table.length) return 0;
    if (zoom <= table[0][0]) return table[0][1];
    for (let i = 0; i < table.length; i++) if (zoom <= table[i][0]) return table[i][1];
    return 0;
  }

  /* ================================================================================== *
   *                公交线路分色：**颜色方案**（独立字段，不再是三种显示模式）
   *
   * 三种分色（线路本色 / 公司 / 票价）原本被做成三个独立的**显示模式**，与「轨交模式 / 公交模式」
   * 平级 —— UI 上说不通：玩家先选"看轨交"还是"看公交"，然后才决定"按什么上色"。
   * 所以颜色从显示模式里**拆出来**，变成一条独立的轴（Render.transitColorSchemeId）：
   *
   *   · linecolor 线路本色 —— 每条线画自己的 color（= 默认表现）；两条线撞色时后一条换一个确定的备用色；
   *   · company   公司分色 —— 同一家公司的线路 / 车站 / 车辆同一个颜色，颜色由**公司 id 哈希**得到；
   *   · fare      票价分色 —— 按"全程票价"分档上色，票价 = fareBase + farePerKm × 线路里程；
   *   · auto      没选（默认）—— 等价于"线路本色"：每条线自己的颜色 + 上面那条撞色兜底。
   *
   * 硬规则（自检里逐条验，见 selfCheckTransitColors 的"颜色方案与显示模式解耦"一节）：
   *   1) **方案与显示模式无关**：方案设了就在任何显示模式下生效（普通 / 车速 / 拥堵 / 轨交 / 公交…），
   *      显示模式只管底图那一套配色（车速 / 拥堵 / 人口格子）与聚焦淡化；
   *   2) **旧写法仍然认**：setDisplayMode('linecolor'|'company'|'fare') 是**别名** ——
   *      它同时设方案和显示模式（谁后调谁说话，见 setDisplayMode 的注释）；旧的 ui.js / 测试不用改；
   *   3) **稳定**：颜色只由 id 决定（FNV-1a + 黄金角铺色），同一家公司/同一条线在任何会话、
   *      任何客户端上都是同一个颜色，绝不随机；
   *   4) **可区分 + 撞色兜底**：同组里颜色重复时（哈希撞车、或两条线自己填了同一个颜色），
   *      按 id 排序后给后来者换一个**确定的**备用色（换盐重算），并在 legendModel / 统计里报出来；
   *   5) **便宜**：每条线/每家公司一次查表（Map.get + 几个字段比较），一帧里不做全量重算、不分配数组。
   *
   * 颜色怎么进到画面上：线路 / 车站 / 车辆都是交通模块（transit.js）自己画的，取色走
   * `Transit.lineColor(line)` 与 `Transit.companyColor(id)`。这里在**不改 transit.js** 的前提下装一层
   * 薄钩子（installTransitColorHooks）：钩子只问一句"这个方案会不会改变这一条的颜色"（见
   * transitLineColorMatches）—— 不会改就原样转交原函数
   * （所以普通模式下除了"撞色的重复线路换备用色"这一点，像素级行为与以前完全一致）。
   * transit.js 想自己接也行，直接调 Render.transitLineColor / transitStationColor / transitVehicleColor。
   * 所有返回值都是 '#rrggbb'（transit.js 里有 color + '22' 这种字符串拼接，rgb() 会拼坏）。
   * ================================================================================== */
  /** 三种"公交线路分色"的 id（= 颜色方案的取值 = 子选项的顺序 = setDisplayMode 认的别名） */
  const TRANSIT_COLOR_MODES = ['linecolor', 'company', 'fare'];
  /** "没选方案"：等价于线路本色（每条线自己的颜色 + 撞色兜底） */
  const TRANSIT_COLOR_SCHEME_AUTO = 'auto';
  /** 颜色方案的全部合法取值（auto + 三种具体方案） */
  const TRANSIT_COLOR_SCHEMES_ALL = [TRANSIT_COLOR_SCHEME_AUTO].concat(TRANSIT_COLOR_MODES);
  /**
   * 颜色方案定义：图层面板的**子选项行**（在「轨交模式 / 公交模式」下面）直接用这个模型
   * （见 Render.transitColorSchemeDefs()；旧名字 transitColorModeDefs() 仍然可用）。
   * name 是完整名字（图例标题用），short 是子选项芯片上的短标签。
   */
  const TRANSIT_COLOR_MODE_DEFS = [
    {
      id: 'linecolor', name: '按线路色分色', short: '按线路色', ico: '🎨',
      hint: '每条线路画自己的颜色（现在的默认表现）；两条线撞色时，后一条换一个确定性的备用色，并在图例里标出来',
    },
    {
      id: 'company', name: '按公交公司分色', short: '按公交公司', ico: '🏢',
      hint: '同一家公司的线路 / 车站 / 车辆同一个颜色；颜色由公司 id 哈希得到，任何会话、任何客户端都一样',
    },
    {
      id: 'fare', name: '按票价分色', short: '按票价', ico: '🎫',
      hint: '按全程票价分档上色：票价 = 起步价 + 每公里价 × 线路里程（里程优先用服务端 pathLen，缺失时按路径折线算）',
    },
  ];
  /** 哈希铺色的色相步长（黄金角）与撞色时换盐的步长：相邻 id 的颜色离得最开 */
  const TRANSIT_HUE_STEP = 0.6180339887498949;
  const TRANSIT_HUE_SALT = 0.3819660112501051;
  /** 撞色时最多换几次盐再认命（换一次色相跳 0.382 圈，实测 1~2 次就够） */
  const TRANSIT_SALT_MAX = 24;
  /**
   * 饱和度 / 明度梯子（同一色相下再分几档：4×4 = 16 条"色带"，实测 1000 个 id 里
   * 只有约 3% 会撞到同一个颜色，剩下的交给 pickFreeColor 换盐兜底）。
   * 取值都压在浅色底图上看得清的范围内（明度 0.34~0.58）。
   */
  const TRANSIT_SAT = [0.78, 0.62, 0.88, 0.5];
  const TRANSIT_LIGHT = [0.42, 0.5, 0.34, 0.58];
  /**
   * 票价档：[[上限(元), 名称, 颜色], ...]（最后一档是"以上"）。
   * 颜色取 Okabe-Ito 色盲友好配色里的一组，保证档与档之间分得开。
   */
  const TRANSIT_FARE_BANDS = [
    [3, '≤3 元', '#0072b2'],
    [5, '3~5 元', '#009e73'],
    [8, '5~8 元', '#e69f00'],
    [12, '8~12 元', '#cc79a7'],
    [Infinity, '>12 元', '#d55e00'],
  ];
  /** 票价公式的兜底参数（与 config.json / 服务端 config.transit 同值：握手前后都能算） */
  const TRANSIT_FARE_DEFAULT = { fareBase: 3, farePerKm: 0.5 };
  /** 查不到归属（没有公司、也没有线路）用什么颜色：不是"配色坏了"，是"真不知道" */
  const TRANSIT_UNKNOWN_COLOR = '#6b7280';
  /**
   * 图例上的备用区分手段（形状/虚线名）：颜色之外的第二条通道。
   * 地图上的线是 transit.js 画的（它只认颜色），所以这里给的是**面板可用**的通道：
   * 图例条目带 pattern 名 + textOn（该颜色上该用黑字还是白字），撞色条目按 pattern 错开。
   */
  const TRANSIT_PATTERNS = ['实线', '虚线', '点线', '点划线', '长虚线', '稀疏点线', '密点线', '双点划线'];

  /**
   * 覆盖画布：标签 / POI / 光标 / 选中 / 预览。
   *
   * 画布比视口大一圈（PAD），并且固定在"图层坐标"的某个位置上：
   * 拖动地图时 Leaflet 平移整个 pane，画布跟着一起走，所以**拖动过程中一帧都不用重画**。
   * 只有视野跑出了已经画好的范围（或者缩放）才重新绘制。
   * 这就是"拖动时标签/线路还在、但不再每帧重画"的实现方式。
   */
  const OVERLAY_PAD = 96;
  /**
   * 覆盖画布上的"逻辑坐标" = Leaflet 容器坐标 + 这一圈 PAD。
   *
   * 画布本身锚在图层坐标上、比视口大一圈（左上角在容器的 (-PAD,-PAD)，见 OverlayLayer._reset），
   * 所以画布里的逻辑坐标统一比容器坐标多一个 PAD。**这里是唯一的换算入口**：
   * 真正的绘制（drawOverlay 的 P）与投影自检（selfCheckProjection）都走它，
   * 否则自检量到的就不是画布真的画在哪儿了。
   */
  function overlayPoint(map, ll) {
    const pt = map.latLngToContainerPoint(ll);
    return { x: pt.x + OVERLAY_PAD, y: pt.y + OVERLAY_PAD };
  }
  const OverlayLayer = L.Layer.extend({
    initialize(render) {
      this.render = render;
      this._bounds = null;
    },
    onAdd(map) {
      this._map = map;
      const canvas = this._canvas = L.DomUtil.create('canvas', 'leaflet-layer osmcity-overlay');
      canvas.style.pointerEvents = 'none';
      map.getPane('osmcity-overlay').appendChild(canvas);
      this._ctx = canvas.getContext('2d');
      map.on('move zoom viewreset resize moveend zoomend', this._reset, this);
      this._reset(true);
    },
    onRemove(map) {
      map.off('move zoom viewreset resize moveend zoomend', this._reset, this);
      if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    },
    /** 重新定位画布；只有视野真的跑出已画范围（或缩放/尺寸变化）时才重画 */
    _reset(force) {
      const map = this._map;
      const size = map.getSize();
      const dpr = window.devicePixelRatio || 1;
      const canvas = this._canvas;
      const pad = OVERLAY_PAD;
      // 缩放一变，画布里的坐标就全不对了：必须重画
      const z = map.getZoom();
      if (this._zoom !== z) { force = true; this._zoom = z; }
      const w = Math.round(size.x + pad * 2);
      const h = Math.round(size.y + pad * 2);
      const anchor = map.containerPointToLayerPoint(L.point(-pad, -pad));
      const viewTopLeft = map.containerPointToLayerPoint(L.point(0, 0));
      const viewBox = { x0: viewTopLeft.x, y0: viewTopLeft.y, x1: viewTopLeft.x + size.x, y1: viewTopLeft.y + size.y };
      const covered = this._bounds
        && viewBox.x0 >= this._bounds.x0 && viewBox.y0 >= this._bounds.y0
        && viewBox.x1 <= this._bounds.x1 && viewBox.y1 <= this._bounds.y1;
      if (covered && !force) {
        // 视野还在已画范围里：连 setPosition 都不用（pane 已经把画布平移过去了）
        this._anchor = anchor;
        return;
      }
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      }
      L.DomUtil.setPosition(canvas, anchor);
      this._anchor = anchor;
      this._size = { x: w, y: h };
      this._bounds = { x0: anchor.x, y0: anchor.y, x1: anchor.x + w, y1: anchor.y + h };
      /**
       * 只做 devicePixelRatio 缩放，**不能**再平移一个 PAD：
       * PAD 那一圈已经由"画布锚在图层坐标 (-PAD,-PAD)"提供了（P() 返回的逻辑坐标已经 +PAD，
       * 而画布左上角又在容器 -PAD 处，两者正好抵消）。这里再 setTransform 平移一次 PAD，
       * 会让画布上的所有内容（标签 / POI 图标 / 选中高亮 / 协作者光标 / 线路站车）
       * 整体偏移 (+PAD,+PAD) —— 屏幕上就是"点哪儿都选偏几厘米"。
       */
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._ctxMatrix = { a: dpr, b: 0, c: 0, d: dpr, e: 0, f: 0 };
      this.render.drawOverlay(this._ctx, this._size);
    },
    redraw() {
      if (!this._ctx) return;
      const size = this._map.getSize();
      // 外部要求立即重画（选中变化、协作数据、列车动画）：范围不变，内容重画
      const pad = OVERLAY_PAD;
      this._size = { x: Math.round(size.x + pad * 2), y: Math.round(size.y + pad * 2) };
      this.render.drawOverlay(this._ctx, this._size);
    },
  });

  const Render = {
    map: null,
    style: null,
    markDirty: null,
    visibleCategories: null,
    _visibleWays: [],
    _visibleNodes: [],
    _visibleRelations: [],
    _labels: [],
    overlayState: { selection: null, preview: null, cursors: [], locks: {}, hover: null },
    stats: {
      features: 0, labels: 0, ms: 0, truncated: false, drawn: 0, lod: 0, skipped: 0, buildings: 0, fills: 0,
      fillShapes: 0,
      detail: 0, detailName: '完整', batches: 0, roads: 0, passes: 0, drawMs: 0, overlayMs: 0,
      drawLastMs: 0, drawName: '',
      roadsInView: 0, roadsDrawn: 0, roadsMissing: 0,
      /* ------------------- 要素账（#6a：报的必须是"这一档真的画出来的"） ------------------- */
      /**
       * 口径（三个数必须能对上，自检逐条验）：
       *   · features          —— **这一档真的画在这个视野里的要素数**（= featuresInView），
       *                          状态栏报的就是它（以前报的是"本地缓存总数"，于是 z19 会报 2.6 万）；
       *   · featuresLoaded    —— 本地缓存里一共多少个要素（World.counts() 的和；只当背景信息看）；
       *   · featuresInView    —— waysInView + nodesInView + relsInView；
       *   · featuresOffView   —— 画了但落在视野外（画布 padding 那一圈 / 没做视野过滤的要素）；
       *   · featuresNotDrawn  —— 本趟里过了视野但**一个图形都没产生**的要素（规则没有描边也没有填充）。
       */
      featuresInView: 0, featuresLoaded: 0, featuresOffView: 0, featuresNotDrawn: 0,
      featuresWaysInView: 0, featuresNodesInView: 0, featuresRelsInView: 0,
      featuresWaysOffView: 0, featuresNodesOffView: 0, featuresRelsOffView: 0,
      /** 本趟被"面积 LOD"筛掉的面（块数/条数），以及当时生效的门槛 */
      areaLodSkipped: 0, areaLodRelationSkipped: 0, areaLodM2: 0, areaLodTable: null,
      /** 框外要素直接不参与本趟（视野/画布 padding 之外）：POI 与多面体关系 */
      nodeOutOfViewSkipped: 0, relationOutOfViewSkipped: 0,
      /** 低缩放合并折线（displayLines）：进来/画出来/路径段/点数/因样式不画 */
      displayLinesInView: 0, displayLinesDrawn: 0, displayLinePaths: 0, displayLinePoints: 0,
      displayLinesByRule: 0, displayLineMs: 0,
      /** 低缩放合并面（displayAreas）：进来/画出来/环数/开放环/点数/因样式不画 */
      displayAreasInView: 0, displayAreasDrawn: 0, displayAreaRings: 0, displayAreaOpenRings: 0,
      displayAreaPoints: 0, displayAreasByRule: 0, displayAreaMs: 0,
      // 显示模式（车速 / 拥堵）与异形楼挤出的记账
      speedRoads: 0, congestionRoads: 0, congestionColored: 0,
      // 公交线路分色（线路本色 / 公司 / 票价）：查表次数、撞色换色的线条数、当前分了几条线
      transitColorLookups: 0, transitColorFallbacks: 0, transitColorLines: 0, transitColorUnresolved: 0,
      extrudedWays: 0, extrudedRelations: 0, innerRings: 0, courtyardWalls: 0, roofHoles: 0, flatBuildings: 0,
      // 分块降级（"严格 LOD，但永不截断"）与视野外卸载的统计
      blockSizeM: 300, blockThreshold: 0, blockKeepAreaM2: 0, blockCounted: 0, blockFeatures: 0,
      blockHot: 0, degradedBlocks: 0, blockSimplified: 0, blockPointsSimplified: 0, blockLabelsSkipped: 0,
      blockNotes: 0, blockError: null, unloadedRefs: 0, blockZones: 0,
      /**
       * 分块密度的算账（#6a：门槛与计数口径必须一致，退化时给得出明细）：
       *   · blockFeaturesDrawn   —— 参与密度统计的要素里，**这一趟真的会画出来的**条数；
       *   · blockFeaturesHidden  —— 数出来很密、但一个图形都没产生的（规则不画 / 面积 LOD 已筛掉）；
       *   · blockVisibleFrac     —— 判过密的那些街区平均"在屏幕上露出多少"（1 = 整块都在视野里）；
       *   · blockThresholdRaw    —— 表里那一档的原始门槛（未按露出比例折算）；
       *   · blockBreakdown       —— 被简略的街区合起来的明细（小面/POI/次要道路 各多少）。
       */
      blockFeaturesDrawn: 0, blockFeaturesHidden: 0, blockVisibleFrac: 0,
      blockThresholdRaw: 0, blockThresholdScaled: 0, blockBreakdown: null,
      /** 缩放变小之后"丢掉当前 LOD 用不上的细节"的账（#6c） */
      detailDropWays: 0, detailDropMs: 0, detailDropZoom: 0, detailDropReason: '', detailDropKeptMajor: 0,
      /** 区块简化掉的道路条数（这一帧的账本；与"档位省掉的"严格分开） */
      blockRoadsSimplified: 0, blockRoadKeep: 0,
      /* ------------------------------ 分阶段耗时（"拖一屏慢在哪儿"） ------------------------------ */
      /** 这次重建里各阶段 ms：分块统计 / 要素循环 / POI / 关系 / 提交 / 覆盖画布 / 矢量画布 */
      blockMs: 0, wayMs: 0, nodeMs: 0, relationMs: 0, commitMs: 0, drawBatchesMs: 0,
      /**
       * **收集视野内 way**（扫空间索引）这一段：耗时 / 分了几帧 / 扫过的行与桶 / 候选 id 数。
       * 老实现是一进 rebuild 就 `queryWays` 一次扫完，这一项就是那次同步调用的耗时。
       */
      collectMs: 0, collectPasses: 1, collectRows: 0, collectBuckets: 0, collectCandidates: 0, wayListSize: 0,
      /** 最近一轮"视野变化"（拖动/缩放）的总耗时与首帧落地时间 */
      panMs: 0, firstCommitMs: 0, lastPan: null,
      /** 档位相关的记账：按档位省掉的面、按面积跳过的小面 */
      detailDroppedFills: 0, skippedTiny: 0, minAreaM2: 0,
      /** 区块标记是否可见（关掉之后一个色块/注释也不画） */
      degradedShown: 0, degradedTips: 0,
    },
    extrudeMinZoom: 17,
    /**
     * 分级显示的额外门槛，**只影响装饰性面**（绿地/水面/小面积），永远不影响道路与骨架。
     * 老版本会在要素过多时自动 +1（自动降级），结果 z16 上住宅路会被自动藏起来——
     * 玩家看到的就是"路只剩一半"。现在这里只作为玩家手动档位的一部分，永不自动改动。
     */
    lodBias: 0,
    /** 已废弃：以前是"单帧最多画多少个"的预算，会直接把要素丢掉。不再有硬上限。 */
    featureBudget: Infinity,
    /** 一笔画里最多塞多少条子路径（把成千上万条同色道路合成一个 Leaflet 对象） */
    batchSize: 4000,
    /** 标签预算：标签总要避让，这里只防止极端情况下画到卡死；默认远大于一屏能容纳的标签数 */
    labelBudget: 4000,

    /* ------------------------------ 详细度档位（玩家可见的分级控制） ------------------------------ */
    /**
     * 档位表（id 就是 Render.detail 的取值）：
     *   0 完整     —— 本地已加载的要素**一个都不丢**（老默认档，最费；Render.setDetail(0) 随时切回来）
     *   1 全部道路 —— 完整 + 额外向服务器请求最细一级道路（服务路/步道）
     *   2 精简     —— 老档位：装饰性面按缩放分级（门槛不变）
     *   3 骨架     —— 纯性能档：只画主干路网/铁路/水系/大面用地/边界
     *   4 标准     —— **默认档**：在"精简"的基础上把装饰性面的门槛再抬一档 + 低缩放筛掉小面。
     *                道路 / 铁路 / 水系 / 骨架面一条都不动（completeness().roadsMissing 恒为 0）。
     */
    DETAILS: [
      { id: 0, name: '完整', note: '本地已加载的要素一个都不丢（老默认档，最费）' },
      { id: 1, name: '全部道路', note: '完整档 + 额外请求服务路/步道等最细道路' },
      { id: 2, name: '精简', note: '装饰性面（绿地/水面/小面积）按缩放分级，道路依旧完整' },
      { id: 3, name: '骨架', note: '只画主干路网/铁路/水系/大面用地/边界' },
      { id: 4, name: '标准（默认）', note: '默认省电：装饰性小面/小绿地在低缩放先收起；道路、铁路、水系一条不缺' },
    ],
    /** 默认档：4 = 标准（比"完整"省，但道路/铁路/水系一条不少） */
    DEFAULT_DETAIL: DEFAULT_DETAIL_LEVEL,
    /** 当前档位（init 时按存档恢复；没存过就是默认的"标准"档） */
    detail: DEFAULT_DETAIL_LEVEL,
    /** 档位存档键（v2：老 v1 里存的是"完整=默认"的旧语义，见 init 的迁移逻辑） */
    DETAIL_KEY: 'osmcity.detail.v2',
    LEGACY_DETAIL_KEY: 'osmcity.detail.v1',
    /** 档位号 → 档位定义 */
    detailDef(level) {
      const n = Render.clampDetail(level == null ? Render.detail : level);
      for (const d of Render.DETAILS) if (d.id === n) return d;
      return Render.DETAILS[0];
    },
    /** 把任意输入（数字 / 中文名 / 英文别名）夹成合法档位号 */
    clampDetail(level) {
      if (typeof level === 'string') {
        const s = level.trim().toLowerCase();
        const alias = {
          full: 0, all: 0, complete: 0, '完整': 0,
          roads: 1, 'all-roads': 1, '全部道路': 1,
          lite: 2, light: 2, '精简': 2,
          skeleton: 3, '骨架': 3,
          standard: 4, default: 4, normal: 4, '标准': 4, '标准（默认）': 4,
        };
        if (s in alias) return alias[s];
      }
      const n = Math.round(Number(level));
      if (!Number.isFinite(n)) return Render.DEFAULT_DETAIL;
      return Math.max(0, Math.min(Render.DETAILS.length - 1, n));
    },

    /** 设置详细度档位（0~4，也吃 '完整'/'标准'/'full' 之类的别名）；返回真正生效的档位 */
    setDetail(level, options = {}) {
      const n = Render.clampDetail(level);
      const changed = n !== Render.detail;
      Render.detail = n;
      Render.labelBudget = Render.detailLabelBudget(n);
      // 档位一变，per-way 的 LOD 结论整体失效（面积门槛/分级门槛都跟着档位走）
      if (changed) {
        Render.bumpLodGen('detail');
        // 换到更细的档位（完整/全部道路）时，之前因为 LOD 丢掉的高细节要允许重新取回来
        Render._detailDropZoom = null;
      }
      // 只有"全部道路"档才把服务器的分级缩放抬高到 17（服务路/步道/小径都在这一级才开始下发）
      try {
        const md = window.G && window.G.MapData;
        if (md) {
          md.zoomFloor = n === 1 ? 17 : 0;
          if (options.refetch !== false && md.rects) {
            md.rects = [];
            if (md.ensure) md.ensure(true);
          }
        }
      } catch { /* ignore */ }
      if (options.persist !== false) util.storage.set(Render.DETAIL_KEY, n);
      // options.rebuild === false：只切档不重建（自检要自己同步重建一次，免得被异步任务顶掉）
      if (options.rebuild !== false) Render.rebuild({ async: true });
      const info = Render.detailDef(n);
      if (options.silent !== true) util.toast(`详细度：${info.name} —— ${info.note}`, 'info', 3200);
      return Render.detail;
    },

    /** 标签预算（只防止极端情况把一帧画爆；默认远大于一屏能显示的标签数） */
    detailLabelBudget(level) {
      const n = Render.clampDetail(level);
      return n === 0 ? 4000 : n === 1 ? 3000 : n === 2 ? 1500 : n === 4 ? 2200 : 400;
    },

    detailName(level) {
      return Render.detailDef(level == null ? Render.detail : level).name;
    },

    /** 详细度选择项（ui.js 想画滑杆/下拉时直接用这个模型） */
    detailChoices() {
      return Render.DETAILS.map((x) => ({
        id: x.id, name: x.name, note: x.note, active: x.id === Render.detail, isDefault: x.id === Render.DEFAULT_DETAIL,
      }));
    },

    /**
     * 当前档位下"装饰性面"的门槛抬高量（zoom 数）：只有"标准"档 +1。
     * 骨架面（水域/大片用地/边界）永远不加 —— 它们是底图底色，砍了反而看不清地图。
     */
    fillZoomBias(level) {
      const n = level == null ? Render.detail : Render.clampDetail(level);
      if (n !== Render.DEFAULT_DETAIL) return 0;
      return Number(Render.STANDARD && Render.STANDARD.fillZoomBias) || 0;
    },

    /**
     * 当前档位下"多小的面不画"（平方米；0 = 不按面积筛）。
     *
     * **唯一一张表**（`Render.AREA_LOD`，默认 AREA_LOD_M2）：z13 ≥20000 / z15 ≥1500 / z17 ≥200 / z19 ≥20，
     * 缩放越大门槛越低（放大 = 门槛更松 = 细节更多），整张表只有这一处可配置。
     *
     * 只对"装饰性面"生效，而且下面这些**一律不筛**（用户要的"水系照旧"）：
     *   · 道路 / 铁路 / 水系（哪怕它们是闭合面 —— 环岛、站台、河面），筛掉会让 roadsMissing 不为 0；
     *   · 水（natural=water/coastline/bay、waterway、landuse=reservoir/basin）与行政边界：它们是底图底色；
     *   · 重要建筑（有名字 / 有公共设施标签 / 5 层以上）。
     * 筛掉的只有屏幕上根本看不清的小绿地 / 小场地 / 零散用地 / 小棚子。
     */
    detailMinAreaM2(tags, zoom) {
      const n = Render.clampDetail(Render.detail);
      // 只有"省"的档位才按面积筛：「完整 / 全部道路」一块都不丢
      if (n === 0 || n === 1) return 0;
      if (Render.areaLodEnabled === false) return 0;
      const t = tags || {};
      // 道路/铁路/水系/行政边界/水：**一条都不许筛**（哪怕它们是闭合面——
      // 环岛、站台、河面这种"面状道路"也照样算道路，筛掉就会让 roadsMissing 不为 0）
      if (t.highway || t.railway || t.waterway) return 0;
      if (t.natural === 'water' || t.natural === 'coastline' || t.natural === 'bay') return 0;
      if (t.landuse === 'reservoir' || t.landuse === 'basin') return 0;
      if (t.boundary === 'administrative') return 0;
      if (t.building || t['building:part']) {
        if (t.name || t.amenity || t.shop || t.tourism || t.office || t.public_transport || t.healthcare) return 0;
        const levels = parseFloat(String(t['building:levels'] || '0').replace(/[^\d.]/g, '')) || 0;
        if (levels >= 5) return 0;
      }
      return Render.areaMinM2(zoom);
    },

    /**
     * 面积门槛本身（m²，与标签无关的那一半）：**唯一一张表**在这里读。
     * 表尾之外取最后一个值（不再"z≥17 就一项都不筛"——那正是 z17/z19 上小棚子铺满屏幕的原因）。
     */
    areaMinM2(zoom) {
      const z = zoom == null ? (Render.map ? Render.map.getZoom() : 16) : zoom;
      const table = Render.AREA_LOD || AREA_LOD_M2;
      if (!table || !table.length) return 0;
      return stepValue(table, z);
    },

    /** 面积 LOD 表的只读副本（面板/自检/排查用；改它不影响渲染，改 Render.AREA_LOD 才生效） */
    areaLodTable() {
      const table = Render.AREA_LOD || AREA_LOD_M2;
      return table.map((r) => ({ zoom: r[0], minAreaM2: r[1] }));
    },

    /** 换一张面积 LOD 表（[[zoom, m²], ...]；传 null 恢复默认表）。返回是否真的换了 */
    setAreaLod(table) {
      if (table == null) { Render.AREA_LOD = AREA_LOD_M2; }
      else {
        const list = (Array.isArray(table) ? table : [])
          .map((r) => [Math.round(Number(r[0])), Math.max(0, Number(r[1]))])
          .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]))
          .sort((a, b) => a[0] - b[0]);
        Render.AREA_LOD = list.length ? list : AREA_LOD_M2;
      }
      // 门槛变了 = 每一条 way 的"画不画"结论都要重算：作废 LOD 决策缓存并重画
      Render.bumpLodGen('area-lod');
      /**
       * 同时让 MapData 忘掉已取范围：门槛变松（比如把 z19 的 20 m² 调到 1 m²）之后，
       * 之前按旧门槛"没取/已丢"的小面要能重新取回来 —— 与 setDetail 同一套做法。
       */
      try {
        const md = (World && World.mapData) || (window.G && window.G.MapData);
        if (md && md.rects) {
          md.rects = [];
          if (md.ensure) md.ensure(true);
        }
      } catch { /* MapData 还没加载：算了 */ }
      Render._detailDropZoom = null;   // 门槛变了，允许下一次重建重新清理
      Render.scheduleRebuild();
      return true;
    },

    /** 当前缩放下这一档是否要画某个要素（只对装饰性面分级，道路/骨架永远返回 true） */
    detailAllows(tags, kind, zoom) {
      const level = Render.clampDetail(Render.detail);
      if (level === 0 || level === 1) return true;          // 完整 / 全部道路：什么都不分级
      const t = tags || {};
      if (level === 3) return Render.isSkeleton(t);          // 骨架档（玩家自选）：只要骨架，含主干路
      // 标准（默认）/ 精简：线要素（道路/铁路/水系）完整，装饰性面按缩放分级
      const isFill = kind === 'area' || kind === 'point';
      if (!isFill) return true;
      return zoom >= Render.lodMinZoom(t, kind, level);
    },

    /* ------------------------------ LOD 决策缓存 + 缩放代（#6c） ------------------------------ */
    /**
     * **缩放代**：每换一次缩放（或面积表 / 档位 / 数据几何变化）就 +1。
     *
     * 为什么必须有它：per-way 的 LOD 结论（画不画、按面积筛不筛）以前是**每趟现算**的，
     * 看似"永远最新"，但真正被缓存住的是**几何与决策的派生结果**：
     *   · `way._geom.lls`（投影过的坐标，带 z）；
     *   · `way._lod`（这一代里这条 way 的 LOD 结论）；
     *   · `World.displayLines / displayAreas`（服务端按某个缩放合并出来的几何）。
     * 三者只要有一个没跟着缩放换代，画面上就会"一半是新阈值、一半是旧阈值" ——
     * 拖一屏之后新旧混在一起，看起来就是"放大/缩小时 LOD 不更新"。
     * 现在统一挂在这一代号上：换代 → 决策缓存整体作废（`way._lod.gen !== lodGen`），
     * 几何缓存靠 `_geom.z` 作废，合并几何靠 World 自己的 zoom 字段整批作废。
     */
    lodGen: 0,
    /** LOD 决策缓存的记账（自检/排查：这一趟重算了多少、复用了多少、换代作废了多少） */
    lodStats: { gen: 0, zoom: 0, recomputed: 0, reused: 0, invalidated: 0, allowed: 0, denied: 0, tinyDropped: 0 },
    /** 面积 LOD 表（唯一可配置处；见 areaMinM2 / setAreaLod） */
    AREA_LOD: AREA_LOD_M2,
    /** 面积 LOD 总开关（false = 一个面都不按面积筛，等于"完整"档的面积语义） */
    areaLodEnabled: true,

    /** 换代：作废所有 per-way 的 LOD 决策缓存（缩放/面积表/档位/几何变化时调用） */
    bumpLodGen(reason) {
      const prev = Render.lodGen || 0;
      Render.lodGen = prev + 1;
      const st = Render.lodStats || (Render.lodStats = { gen: 0, zoom: 0, recomputed: 0, reused: 0, invalidated: 0, allowed: 0, denied: 0, tinyDropped: 0 });
      st.invalidated += 1;
      st.gen = Render.lodGen;
      st.zoom = Render.map ? Render.map.getZoom() : 0;
      st.reason = reason || '';
      return Render.lodGen;
    },

    /**
     * 一条 way 在本趟里的 LOD 结论（画出 / 按面积筛掉 / 按档位不画），**按缩放代缓存**。
     *
     * 缓存键 = 缩放代 + 缩放 + 标签对象身份 + 几何类型；
     * 命中条件不满足就重算（这就是"缩放一变，全部已加载要素的 LOD 一起重算"的落点）。
     * 返回值：{ allow, kind, minAreaM2, areaM2, tiny, gen, z }
     */
    lodDecision(way, kind, rule, zoom, areaM2) {
      const gen = Render.lodGen || 0;
      const c = way._lod;
      if (c && c.gen === gen && c.z === zoom && c.tags === way.tags && c.kind === kind) {
        Render.lodStats.reused += 1;
        return c;
      }
      const tags = way.tags || null;
      const allow = Render.detailAllows(tags, kind, zoom);
      const minAreaM2 = allow && kind === 'area' ? Render.detailMinAreaM2(tags, zoom) : 0;
      const tiny = minAreaM2 > 0 && areaM2 > 0 && areaM2 < minAreaM2;
      const out = { gen, z: zoom, tags: way.tags, kind, rule: rule || null, allow, minAreaM2, tiny, areaM2: areaM2 || 0 };
      way._lod = out;
      const st = Render.lodStats;
      st.recomputed += 1;
      if (allow) st.allowed += 1; else st.denied += 1;
      if (tiny) st.tinyDropped += 1;
      return out;
    },

    /** LOD 决策缓存的统计快照（自检/排查） */
    lodStatsSnapshot() {
      const s = Render.lodStats || {};
      return {
        gen: Render.lodGen || 0, zoom: Render.map ? Render.map.getZoom() : 0,
        reason: s.reason || '', recomputed: s.recomputed || 0, reused: s.reused || 0,
        invalidated: s.invalidated || 0, allowed: s.allowed || 0, denied: s.denied || 0,
        tinyDropped: s.tinyDropped || 0,
        areaLod: Render.areaLodTable(), areaLodEnabled: Render.areaLodEnabled !== false,
        minAreaM2: Math.round(Render.areaMinM2(Render.map ? Render.map.getZoom() : 16) || 0),
      };
    },

    /**
     * "标准"档的两个旋钮（活着改，立刻生效；清零就等于"完整"档）：
     *   · fillZoomBias —— 装饰性面的出现缩放整体 +1；
     *   · minAreaM2    —— **就是那张唯一的面积 LOD 表**（同一份对象，改它 = 改 Render.AREA_LOD）。
     */
    STANDARD: { fillZoomBias: STANDARD_FILL_ZOOM_BIAS, minAreaM2: AREA_LOD_M2 },

    /* ------------------------------ 分块降级（小区尺度，永不整城截断） ------------------------------ */
    /** 区块边长（米）。UI/自检可以直接读它 */
    blockSizeM: BLOCK_SIZE_M,
    /** 一次重建最多简化多少个区块（低缩放下一屏有几千个街区，24 个根本救不了场） */
    maxDegradedBlocks: MAX_DEGRADED_BLOCKS,
    /**
     * 区块道路简化的总开关（三态）：
     *   · `'auto'`（默认）：按档位 —— 「标准/精简/骨架」启用，「完整/全部道路」一个道路都不简化；
     *   · `true` / `false`：强制执行/强制关闭（排查与自检用）。
     */
    blockRoadSimplify: 'auto',
    /** 图上"本区块要素过密…"注释一次最多画几条（色块不受这个限制，被简化就一定看得见） */
    maxBlockNotes: MAX_BLOCK_NOTES,
    /** 预算兜底时，少于这么多"可简化要素"的街区不值得简化（省不了什么，还会多一块阴影） */
    blockMinCount: 3,
    /** 注释排版模式：'zone'（默认，相邻成片合成一条）/ 'block'（严格一块一条） */
    blockNoteMode: 'zone',
    /** 区块注释文案 */
    blockNoticeText: BLOCK_NOTE,
    /** 关掉分块降级（自检/排查用）：关掉之后就回到"一个都不简化" */
    blocksEnabled: true,
    /** 上一次重建里被简化掉的区块（degradedBlocks() 读它） */
    _degraded: [],
    _degradedKeys: null,
    _blockGridUsed: null,
    _blockZoom: 0,
    _blockStats: null,

    /** 这一档缩放下，"一个区块算过密"的可简化要素门槛（按真实密度校准：见 BLOCK_THRESHOLDS） */
    blockThreshold(zoom) {
      return stepValue(BLOCK_THRESHOLDS, zoom == null ? (Render.map ? Render.map.getZoom() : 16) : zoom);
    },

    /** 这一档缩放下，一屏允许画出的"可简化要素"总量（超了就按最密的街区先简略；0 = 不设预算） */
    blockBudget(zoom) {
      return stepValue(BLOCK_BUDGET, zoom == null ? (Render.map ? Render.map.getZoom() : 16) : zoom);
    },

    /** 这一档缩放下，被简化的区块里"多大面积以上的面还留着"（平方米） */
    blockKeepArea(zoom) {
      return stepValue(BLOCK_KEEP_AREA, zoom == null ? (Render.map ? Render.map.getZoom() : 16) : zoom);
    },

    /**
     * 区块网格：300 米见方，锚在"取整到 1 度的纬度"上。
     * 锚点取整是为了让同一块地方在前后几次重建里拿到**同一个 key**（注释不会跳来跳去）。
     */
    blockGrid(centerLat) {
      const lat0 = Math.round(Number.isFinite(centerLat) ? centerLat : 39);
      const cached = Render._blockGridCache;
      if (cached && cached.lat0 === lat0) return cached;
      const grid = {
        lat0,
        latStep: BLOCK_SIZE_M / 110574,
        lonStep: BLOCK_SIZE_M / (111320 * Math.max(0.15, Math.cos((lat0 * Math.PI) / 180))),
      };
      Render._blockGridCache = grid;
      return grid;
    },

    blockKeyOf(grid, lat, lon) {
      const g = grid || Render.blockGrid(lat);
      return Math.floor(lon / g.lonStep) + ':' + Math.floor(lat / g.latStep);
    },

    /** 区块的经纬度范围（注释锚点用它的左上角） */
    blockBounds(grid, key) {
      const g = grid || Render.blockGrid();
      const parts = String(key).split(':');
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const minLon = x * g.lonStep;
      const minLat = y * g.latStep;
      return { x, y, minLon, maxLon: minLon + g.lonStep, minLat, maxLat: minLat + g.latStep };
    },

    /** 某个坐标落在哪个区块里（POI 用） */
    blockKeyAt(job, lat, lon) {
      if (!job || !job.degradedKeys || !job.degradedKeys.size) return null;
      const grid = job.blockGrid || (job.blockGrid = Render.blockGrid(job.centerLat));
      const key = Render.blockKeyOf(grid, lat, lon);
      return job.degradedKeys.has(key) ? key : null;
    },

    /* ------------------------------ 道路等级（客户端/服务端共用一张表） ------------------------------ */
    /**
     * 道路等级表：给服务端看的那一份（**同一张表**，两边不许各写一份）。
     * 返回逐缩放的 { zoom, blockKeep, serverSend, keepName, sendName }，可直接喂给服务端做低缩放下发筛选。
     */
    roadClassTable() {
      return ROAD_CLASS_TABLE.map((row) => ({
        zoom: row[0],
        blockKeep: row[1],
        serverSend: row[2],
        keepName: ROAD_RANK_NAMES[Math.max(0, Math.min(ROAD_RANK_NAMES.length - 1, row[1]))],
        sendName: ROAD_RANK_NAMES[Math.max(0, Math.min(ROAD_RANK_NAMES.length - 1, row[2]))],
      }));
    },

    /** highway 值 → 等级；不是道路返回 -1（铁路/水系/建筑…永不被区块简化） */
    roadRank(tags) {
      if (!tags || !tags.highway) return -1;
      const r = ROAD_RANKS[tags.highway];
      return r == null ? 5 : r;
    },

    /** 等级的中文名（日志/自检用） */
    roadRankName(rank) {
      const r = Math.max(-1, Math.min(ROAD_RANK_NAMES.length - 1, Number(rank)));
      return r < 0 ? '非道路' : ROAD_RANK_NAMES[r];
    },

    /** 这一档缩放下，**区块过密时**还画到第几级（rank ≤ 它的照画） */
    blockRoadKeep(zoom) {
      const z = zoom == null ? (Render.map ? Render.map.getZoom() : 16) : zoom;
      return stepValue(ROAD_CLASS_TABLE.map((r) => [r[0], r[1]]), z);
    },

    /** 建议服务端这一档缩放下发到第几级（永远 ≥ blockRoadKeep，两边不会"互相等"） */
    serverRoadSend(zoom) {
      const z = zoom == null ? (Render.map ? Render.map.getZoom() : 16) : zoom;
      return stepValue(ROAD_CLASS_TABLE.map((r) => [r[0], r[2]]), z);
    },

    /**
     * 这条道路是不是"该被区块简化的次要道路"（只看等级 + 缩放，不看区块）：
     *   · 非道路（铁路/水系…）→ false；主干（rank 0）→ false（永远照画）；
     *   · 等级比"这一档缩放能留到的等级"更深 → true（区块过密时才真的不画）。
     */
    roadIsBlockSimplifiable(tags, zoom) {
      const rank = Render.roadRank(tags);
      if (rank < 0 || rank === 0) return false;            // 非道路 / 主干：永不简化
      return rank > Render.blockRoadKeep(zoom);
    },

    /* --------------------- 道路的缩放 LOD 门槛（客户端与服务端同一张表，#6b/#6c） --------------------- */
    /**
     * 这一档缩放下，客户端**最多画到第几级道路** = max(服务端下发到第几级, 区块过密时留到第几级)。
     *
     * 为什么客户端也要有这道门槛（而不是"服务端筛了就够"）：
     * 客户端的本地库是**按保留区卸载**的，与缩放无关。于是"先在 z19 看清每一栋楼、再缩到 z13"
     * 的客户端手里仍然握着 z19 取回来的服务路/步道/居民区道路，而**新取回来的那一块**只有
     * 服务端在这一档下发的等级（实测：z13 服务端一条真 way 都不发，只发合并折线 displayLines；
     * z14 只发到 rank 3）—— 同一屏上两半 LOD 不一样，看起来就是"缩放之后 LOD 没更新"。
     *
     * 判据用的是**同一张 ROAD_CLASS_TABLE**（服务端 serverSend 那一列），所以
     * "客户端画得出来的"永远等于"服务端这一档会下发的"：同一档缩放，谁来看都是同一张图，
     * 与加载历史无关。主干（rank ≤ 1：motorway/trunk/primary/secondary）永远照画 ——
     * "道路一条不缺"的承诺不受影响（被门槛挡下的会记进 completeness().roadsMissingByRoadLod）。
     *
     * 「完整 / 全部道路」档不做这道门槛（玩家要全画就给全）；「全部道路」档的 zoomFloor=17
     * 也会让 effZoom 抬到 17，于是那一档照样能画最细的路。
     */
    roadLodMinRank(zoom) {
      const z0 = zoom == null ? (Render.map ? Render.map.getZoom() : 16) : zoom;
      let z = z0;
      try {
        const md = (World && World.mapData) || (window.G && window.G.MapData);
        if (md && Number(md.zoomFloor) > z) z = Number(md.zoomFloor);
      } catch { /* 拿不到 zoomFloor 就用真实缩放 */ }
      return Math.max(Render.serverRoadSend(z), Render.blockRoadKeep(z));
    },

    /** 这一档缩放要不要画这条道路（true = 画）。非道路/主干永远 true；「完整/全部道路」档永远 true */
    roadLodAllows(tags, zoom) {
      if (Render.roadLodGate === false) return true;
      const level = Render.clampDetail(Render.detail);
      if (level === 0 || level === 1) return true;          // 完整 / 全部道路：不做这道门槛
      const rank = Render.roadRank(tags);
      if (rank < 0) return true;                            // 不是道路（铁路/水系/建筑面…）
      if (rank <= 1) return true;                           // 主干 + 次要干道：任何档位都照画
      return rank <= Render.roadLodMinRank(zoom);
    },

    /** 道路 LOD 门槛的快照（自检/状态栏/排查用） */
    roadLodStats() {
      const z = Render.map ? Render.map.getZoom() : 16;
      const level = Render.clampDetail(Render.detail);
      const on = Render.roadLodGate !== false && level !== 0 && level !== 1;
      return {
        on, zoom: z, detail: level, minRank: Render.roadLodMinRank(z),
        minRankName: Render.roadRankName(Render.roadLodMinRank(z)),
        serverSend: Render.serverRoadSend(z), blockKeep: Render.blockRoadKeep(z),
        reason: !on ? (Render.roadLodGate === false ? 'gate-off' : 'detail-full') : 'zoom-lod',
        table: Render.roadClassTable(),
      };
    },

    /**
     * 区块道路简化总开关：默认「标准/精简/骨架」启用；**「完整」「全部道路」档一个道路都不简化**
     * （玩家要全画时给全）。
     */
    blockRoadsOn(level) {
      const n = Render.clampDetail(level == null ? Render.detail : level);
      if (Render.blockRoadSimplify === true) return true;
      if (Render.blockRoadSimplify === false) return false;
      return Render.blockLevelsOn(n);
    },

    /** 分块降级在哪些档位生效（默认只有"精简/骨架/标准"；「完整」「全部道路」一个要素都不简化） */
    blockLevels: [2, 3, 4],
    blockLevelsOn(level) {
      const n = Render.clampDetail(level == null ? Render.detail : level);
      if (Render.blocksEnabled === false) return false;
      const list = Array.isArray(Render.blockLevels) ? Render.blockLevels : [2, 3, 4];
      return list.indexOf(n) >= 0;
    },

    /**
     * 数每个区块里的"可简化要素"。
     * 计数口径（三样，都是有替代/可省的）：装饰性面（建筑、小面积用地…）、POI 图标/标签、
     * **次要道路**（rank ≥ 1 且比这一档"能留到的等级"更深）。
     * 主干道、铁路、水系、水域、骨架面**不参与统计**，因此永远不会因为"这一块太密"被简化。
     * 顺便把 way 的归属区块记在 way._blockKey 上。
     *
     * ⚠ 2026-09 修正（#6a）：**只数"这一趟真的会画在屏幕上的那些"**。
     * 以前的口径有两个洞，于是 z17/z19 上"一屏几十个图形"也会被判成过密、把成片建筑与 POI 简略掉：
     *   1) **面积 LOD 已经筛掉的面照样被数进去** —— 它们在屏幕上根本不存在；
     *   2) **画布 padding 那一圈（视野外 12%）的要素也被数进去** —— 玩家看不见它们。
     * 现在两道闸都在（面积 LOD + `job.viewBox` 视野框），数出来的才是"屏幕上真的有多少东西"。
     * 每一条还按"真画 / 没画"分开记账（rec.nDrawn / rec.nHidden），退化时能给出明细。
     *
     * 缓存（拖动时这一步每帧都要跑一遍，几万条 way 全量重算太亏）：
     * 判定只看"标签对象 + 几何 + 缩放 + 档位 + 面积门槛 + 缩放代"，六样都没变就直接复用上一次的结论
     * （way._blk）。拖动时绝大多数要素和上一次是同一批，于是这一趟几乎只剩 Map 查表。
     */
    countBlockFeatures(job) {
      const grid = job.blockGrid || (job.blockGrid = Render.blockGrid(job.centerLat));
      const counts = new Map();
      const list = job.wayList;
      const style = job.style;
      const geom = World.geomStamp || 0;
      const detail = Render.clampDetail(Render.detail);
      const roadsOn = Render.blockRoadsOn(detail);
      const keepRank = Render.blockRoadKeep(job.zoom);
      const gen = Render.lodGen || 0;
      const minArea = Render.clampDetail(Render.detail) === 0 || Render.clampDetail(Render.detail) === 1
        ? 0 : Render.areaMinM2(job.zoom);
      /** 计数用的视野框：**不含画布 padding**（padding 那一圈玩家看不见，不该算进密度） */
      const view = job.viewBox || job.bounds;
      const bump = (key, kind, drawn) => {
        let rec = counts.get(key);
        if (!rec) {
          rec = { key, n: 0, nFills: 0, nPoints: 0, nRoads: 0, nDrawn: 0, nHidden: 0, bounds: Render.blockBounds(grid, key) };
          counts.set(key, rec);
        }
        rec.n += 1;
        if (drawn) rec.nDrawn += 1; else rec.nHidden += 1;
        if (kind === 'fill') rec.nFills += 1; else if (kind === 'road') rec.nRoads += 1;
        return rec;
      };
      const bumpPoint = (key) => {
        const rec = bump(key, 'point', true);
        rec.nPoints += 1;
        return rec;
      };
      for (let i = 0; i < list.length; i++) {
        const way = list[i];
        const cached = way._blk;
        if (cached && cached.tags === way.tags && cached.g === geom && cached.z === job.zoom
          && cached.d === detail && cached.gen === gen && cached.ma === minArea) {
          way._blockKey = cached.key;
          if (cached.key) bump(cached.key, cached.kind, cached.drawn);
          continue;
        }
        let key = null;
        let kind = null;
        let drawn = false;
        const closed = way.closed != null ? way.closed : World.isClosed(way);
        const bt = way.tags || {};
        if (!closed && roadsOn && bt.highway) {
          // 次要道路：等级比"这一档能留到的等级"更深 → 过密街区里可以不画，于是参与密度统计
          const rank = Render.roadRank(bt);
          if (rank > keepRank) {
            const rule = Render.ruleForWay(way, 'line', style);
            // 只有"本来该画"的道路才参与统计（规则缩放到不了、图层被关掉的都不算）
            if (rule && job.zoom >= (rule.minZoom || 0) && job.zoom <= (rule.maxZoom || 99)
              && Render.detailAllows(bt, 'line', job.zoom)
              && Render.isVisible(style.categoryOf(bt, 'line'))) {
              const b = World.wayBBox(way);
              if (b && Render.boxIntersects(view, b)) {
                key = Render.blockKeyOf(grid, (b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2);
                kind = 'road';
                drawn = true;                       // 这条路本来是该画的（只是"过密时可省"）
              }
            }
          }
        } else if (closed && !Render.isSkeleton(way.tags) && !bt.highway && !bt.railway && !bt.waterway) {
          // 装饰性面（线要素/骨架面/闭合的道路水系面：永不被简化，也不参与统计）
          const rule = Render.ruleForWay(way, 'area', style);
          if (rule && rule.fill && (rule.kind === 'fill' || rule.kind === 'both')
            && job.zoom >= (rule.minZoom || 0) && job.zoom <= (rule.maxZoom || 99)
            && Render.detailAllows(way.tags, 'area', job.zoom)
            && Render.isVisible(style.categoryOf(way.tags, 'area'))) {
            const b = World.wayBBox(way);
            if (b && Render.boxIntersects(view, b)) {
              key = Render.blockKeyOf(grid, (b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2);
              kind = 'fill';
              // 面积 LOD 已经筛掉的面**不算密度**：它们这一趟一个图形都不会产生（#6a 的洞①）
              drawn = !(minArea > 0 && Render.bboxAreaM2(b) < minArea);
            }
          }
        }
        way._blk = { tags: way.tags, g: geom, z: job.zoom, d: detail, gen, ma: minArea, key, kind, drawn };
        way._blockKey = key;
        if (key) bump(key, kind, drawn);
      }
      // POI（图标 + 标签）也算"这一块的要素"：它们同样会被简化，所以也要参与密度统计，
      // 否则"一屏全是咖啡馆、没几栋楼"的地方永远到不了门槛。
      // 只数**落在视野框里**的（密集的格子里隔了半条街的 POI 不该算成"屏幕上很挤"）。
      const style2 = job.style;
      const pois = World.queryTaggedNodes(view, Render._blockNodeQuery || (Render._blockNodeQuery = []));
      for (const node of pois) {
        if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon)) continue;
        const rule = style2.ruleFor(node.tags, 'point') || Render.fallbackRule(node.tags);
        if (!rule) continue;
        if (job.zoom < (rule.minZoom || 0) || job.zoom > (rule.maxZoom || 99)) continue;
        if (!Render.detailAllows(node.tags, 'point', job.zoom)) continue;
        if (!Render.isVisible(style2.categoryOf(node.tags, 'point'))) continue;
        bumpPoint(Render.blockKeyOf(grid, node.lat, node.lon));
      }
      return counts;
    },

    /** 两个经纬度矩形是否相交（便宜、无分配；b 可以是 {minLat,maxLat,minLon,maxLon}） */
    boxIntersects(a, b) {
      if (!a || !b) return false;
      return !(b.maxLat < a.minLat || b.minLat > a.maxLat || b.maxLon < a.minLon || b.minLon > a.maxLon);
    },

    /**
     * 一个 300 米区块里"露出在屏幕上的那部分"占整块的比例（0~1）。
     * 用它把门槛折算成"这一块在屏幕上露出多少就该有多少要素"——
     * 一块只露三成的街区不该按整块的密度被判过密（#6a 的洞②）。
     */
    blockVisibleFrac(job, rec) {
      const grid = job.blockGrid || (job.blockGrid = Render.blockGrid(job.centerLat));
      const view = job.viewBox || job.bounds;
      const g = Render.blockBounds(grid, rec.key);
      const b = rec.bounds || g;
      const latSpan = Math.max(1e-12, b.maxLat - b.minLat);
      const lonSpan = Math.max(1e-12, b.maxLon - b.minLon);
      const latIn = Math.max(0, Math.min(b.maxLat, view.maxLat) - Math.max(b.minLat, view.minLat));
      const lonIn = Math.max(0, Math.min(b.maxLon, view.maxLon) - Math.max(b.minLon, view.minLon));
      const frac = (latIn * lonIn) / (latSpan * lonSpan);
      return Math.max(0, Math.min(1, frac));
    },

    /** 把"过密的区块"挑出来（最密的优先，最多 Render.maxDegradedBlocks 个） */
    planBlocks(job, counts) {
      if (!Render.blockLevelsOn(Render.detail)) {
        // 这一档不简化（"完整/全部道路"档，或玩家关了区块机制）：一个区块都不简化
        job.degraded = [];
        job.degradedKeys = new Set();
        job.degradedMap = new Map();
        job.blockThreshold = 0;
        job.blockKeepArea = 0;
        job.blockHot = 0;
        job.blockCounted = counts ? counts.size : 0;
        job.blockFeatures = 0;
        job.blockFeaturesDrawn = 0;
        job.blockFeaturesHidden = 0;
        job.blockRoadKeep = Render.blockRoadKeep(job.zoom);
        return 0;
      }
      const thresholdRaw = Render.blockThreshold(job.zoom);
      const keepArea = Render.blockKeepArea(job.zoom);
      const budget = Render.blockBudget(job.zoom);
      const minCount = Math.max(2, Number(Render.blockMinCount) || 3);
      let total = 0;
      let totalDrawn = 0;
      const ranked = [];
      for (const rec of counts.values()) {
        total += rec.n;
        totalDrawn += rec.nDrawn || 0;
        if (rec.n > 0) {
          /**
           * 这一块在屏幕上露出多少（只作记录与"整块都在屏幕外就跳过"的判断）。
           *
           * ⚠ 为什么**不**拿它去折算门槛：计数口径已经改成"只数视野里的"（见 countBlockFeatures），
           * 数出来的量本身就已经按露出面积缩过一次了；门槛再乘一次等于把同一件事扣两遍 ——
           * 实测那样做会让 z19 的门槛从 110 掉到 18，一块只露 8% 的街区的 30 个建筑就被简略掉，
           * 正是用户报的"只有十几栋建筑却说过密"。所以门槛用表里的原值，
           * "看不见的要素不算数"这件事由**计数口径**负责。
           */
          rec.visibleFrac = Render.blockVisibleFrac(job, rec);
          rec.thresholdRaw = thresholdRaw;
          rec.threshold = thresholdRaw;
          rec.over = rec.nDrawn - thresholdRaw;
          ranked.push(rec);
        }
      }
      ranked.sort((a, b) => b.over - a.over || b.nDrawn - a.nDrawn || (a.key < b.key ? -1 : 1));
      const degraded = [];
      const chosen = new Set();
      let degradedSum = 0;
      // 1) 街区密度：**真画出来的、且在视野里的**要素超过门槛的街区
      //    （整块几乎都在屏幕外的街区不判：屏幕上看不见那一片，密度统计没有意义）
      const MIN_VISIBLE_FRAC = 1 / 6;
      for (const rec of ranked) {
        if (rec.over <= 0 || degraded.length >= Render.maxDegradedBlocks) break;
        if (rec.nDrawn < minCount) break;
        if (rec.visibleFrac < MIN_VISIBLE_FRAC) { rec.skippedOffScreen = true; continue; }
        degraded.push(rec);
        chosen.add(rec);
        degradedSum += rec.nDrawn;
      }
      // 2) 预算兜底：一屏总量还超预算，就按"最密的先简略"继续往下压
      //    （低缩放下一屏几千个街区的情形；被压到的街区在 rec.byBudget 上留痕）
      if (budget > 0 && totalDrawn - degradedSum > budget) {
        for (const rec of ranked) {
          if (totalDrawn - degradedSum <= budget || degraded.length >= Render.maxDegradedBlocks) break;
          if (rec.nDrawn < minCount) break;
          if (chosen.has(rec)) continue;
          degraded.push(rec);
          chosen.add(rec);
          rec.byBudget = true;
          degradedSum += rec.nDrawn;
        }
      }
      let fracSum = 0;
      for (const rec of degraded) {
        rec.keepAreaM2 = keepArea;
        rec.simplifiedFills = 0;
        rec.simplifiedPoints = 0;
        rec.simplifiedRoads = 0;
        rec.labelsSkipped = 0;
        rec.text = BLOCK_NOTE;
        fracSum += rec.visibleFrac || 0;
      }
      job.degraded = degraded;
      job.degradedKeys = new Set(degraded.map((r) => r.key));
      job.degradedMap = new Map(degraded.map((r) => [r.key, r]));
      job.blockThreshold = thresholdRaw;
      job.blockVisibleFrac = degraded.length ? Math.round((fracSum / degraded.length) * 100) / 100 : 0;
      job.blockKeepArea = keepArea;
      job.blockBudget = budget;
      job.blockHot = degraded.filter((r) => !r.byBudget).length;
      job.blockByBudget = degraded.filter((r) => r.byBudget).length;
      job.blockCounted = counts.size;
      job.blockFeatures = total;
      job.blockFeaturesDrawn = totalDrawn;
      job.blockFeaturesHidden = Math.max(0, total - totalDrawn);
      job.blockDegradedFeatures = degradedSum;
      // 密度统计的原始表：_finishJob 用它汇总"数到多少 / 真的会画多少"（#6a 的明细），
      // 也是 blockCountStats() 拿来做"门槛落在真实分布的哪个分位"的校准依据
      job.blockCounts = counts;
      job.blockRoadKeep = Render.blockRoadKeep(job.zoom);
      return degraded.length;
    },

    /**
     * 这一趟"每个 300 米街区真的会画出来多少个可简化要素"的分布（p50/p90/p99/最大）。
     *
     * 为什么要暴露它：门槛表（BLOCK_THRESHOLDS）必须落在**真实分布的高分位**上才有意义 ——
     * 落在中位数上就会把一半的正常街区判成过密（老表在高缩放上正是这个问题：
     * z19 实测每街区最多 31 个，门槛却是 40，于是"只有十几栋建筑"也被简略）。
     * `node tmp-verify/lod-z19/sim.js --script calib` 就是拿这个数逐档校准的。
     */
    blockCountStats() {
      const counts = Render._blockCounts;
      if (!counts || !counts.size) return { blocks: 0, p50: 0, p90: 0, p99: 0, max: 0, total: 0, threshold: 0, zoom: Render.map ? Render.map.getZoom() : 0 };
      const arr = [];
      let total = 0;
      for (const rec of counts.values()) { arr.push(rec.nDrawn || 0); total += rec.nDrawn || 0; }
      arr.sort((a, b) => a - b);
      const q = (p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))] || 0;
      return {
        blocks: arr.length, total,
        p50: q(0.5), p90: q(0.9), p99: q(0.99), max: arr[arr.length - 1] || 0,
        threshold: Render.blockThreshold(Render.map ? Render.map.getZoom() : 16),
        zoom: Render.map ? Render.map.getZoom() : 0,
        /** 门槛落在哪个分位上（>1 表示"任何街区都不会被密度判过密"） */
        quantile: arr.length ? (arr.filter((n) => n <= (Render.blockThreshold(Render.map ? Render.map.getZoom() : 16))).length / arr.length) : 1,
      };
    },

    /**
     * 这个装饰性面是不是"因为所在区块过密而被简化"。
     * 返回该区块的记录（供记账），不需要简化时返回 null。
     * 保留规则：有名字的、公共设施/商铺/景点、5 层以上、以及面积达到该缩放门槛的 —— 都留着。
     */
    blockSimplifiesFill(job, way) {
      if (!job.degradedKeys || !job.degradedKeys.size) return null;
      if (Render.isSkeleton(way.tags)) return null;
      /**
       * 道路/铁路/水系**永远不简化**，哪怕它是闭合面（环岛、匝道围出的地块、
       * highway=pedestrian 的广场）：这些 way 在 completeness() 里算"道路"，
       * 简化掉一条就会让"道路永不缺"这句话不成立。
       */
      const rt = way.tags || {};
      if (rt.highway || rt.railway || rt.waterway) return null;
      const key = way._blockKey;
      if (!key) return null;
      const rec = job.degradedMap ? job.degradedMap.get(key) : null;
      if (!rec) return null;
      const t = way.tags || {};
      if (t.name) return null;
      if (t.amenity || t.shop || t.tourism || t.office || t.public_transport) return null;
      const levels = parseFloat(String(t['building:levels'] || '0').replace(/[^\d.]/g, '')) || 0;
      if (levels >= 5) return null;
      const b = World.wayBBox(way);
      const area = b ? Render.bboxAreaM2(b) : 0;
      if (area >= (job.blockKeepArea || Render.blockKeepArea(job.zoom))) return null;
      return rec;
    },

    /**
     * 这条**次要道路**是不是"因为所在区块过密而被简化"。
     * 返回该区块的记录（供记账），不需要简化时返回 null。
     *
     * 三条永远不简化的硬线（和"道路一条不缺"的承诺一致）：
     *   · 主干（rank 0：motorway/trunk/primary 含 _link）→ 永远照画；
     *   · 非道路（铁路/水系/水域/边界/建筑）→ 根本不走这条路；
     *   · 等级还在"这一档缩放能留到的等级"之内的 → 照画（只有更细的那几级才可能被省）。
     * 另外：「完整」「全部道路」档整体关掉（blockRoadsOn），玩家要全画就给全。
     */
    blockSimplifiesRoad(job, way) {
      if (!job.degradedKeys || !job.degradedKeys.size) return null;
      if (!Render.blockRoadsOn(job.detail != null ? job.detail : Render.detail)) return null;
      const t = way.tags || {};
      if (!t.highway) return null;
      const rank = Render.roadRank(t);
      if (rank <= 0) return null;                                  // 主干：永不简化
      const keep = job.blockRoadKeep != null ? job.blockRoadKeep : Render.blockRoadKeep(job.zoom);
      if (rank <= keep) return null;                               // 这一档本来就该画
      const key = way._blockKey;
      if (!key) return null;
      const rec = job.degradedMap ? job.degradedMap.get(key) : null;
      if (!rec) return null;
      return rec;
    },

    /** POI（图标 + 标签）也属于可简化的装饰性内容：它所在的区块被简化时就不画了 */
    blockSimplifiesPoint(job, node) {
      if (!job.degradedKeys || !job.degradedKeys.size) return null;
      const key = Render.blockKeyAt(job, node.lat, node.lon);
      if (!key) return null;
      return job.degradedMap ? job.degradedMap.get(key) : null;
    },

    /**
     * 当前正在"简略显示"的区块（画布注释就用它）。
     * 只有**真的简化掉了东西**的区块才会出现在这里：数出来很密但一个要素都没被简化
     * （全是重要建筑/大块用地）的区块不算"已简略显示"，也就不会有注释。
     * @returns {Array<{key,x,y,count,threshold,zoom,sizeM,bounds,anchor,simplifiedFills,simplifiedPoints,labelsSkipped,text}>}
     */
    degradedBlocks() {
      const list = Render._degraded || [];
      if (!list.length) return [];
      const map = Render.map;
      let visible = list;
      if (map) {
        const b = map.getBounds().pad(0.1);
        const w = b.getWest();
        const e = b.getEast();
        const s = b.getSouth();
        const n = b.getNorth();
        visible = list.filter((x) => !(x.bounds.maxLon < w || x.bounds.minLon > e
          || x.bounds.maxLat < s || x.bounds.minLat > n));
      }
      return visible.map((x) => ({
        key: x.key,
        x: x.bounds.x,
        y: x.bounds.y,
        // 数出来多少 / 其中真的会画多少（nDrawn）/ 其中因为面积 LOD 等根本不会画多少（nHidden）
        count: x.n,
        countDrawn: x.nDrawn || 0,
        countHidden: x.nHidden || 0,
        countFills: x.nFills || 0,
        countPoints: x.nPoints || 0,
        countRoads: x.nRoads || 0,
        /** 判它过密时用的门槛（已按"这一块在屏幕上露出多少"折算过）与折算前 / 露出比例 */
        threshold: x.threshold,
        thresholdRaw: x.thresholdRaw || x.threshold,
        visibleFrac: x.visibleFrac == null ? 1 : x.visibleFrac,
        zoom: Render._blockZoom,
        sizeM: BLOCK_SIZE_M,
        bounds: Object.assign({}, x.bounds),
        // 注释锚点：区块的左上角
        anchor: { lat: x.bounds.maxLat, lon: x.bounds.minLon },
        simplifiedFills: x.simplifiedFills || 0,
        simplifiedPoints: x.simplifiedPoints || 0,
        simplifiedRoads: x.simplifiedRoads || 0,
        labelsSkipped: x.labelsSkipped || 0,
        text: x.text || BLOCK_NOTE,
        /** 这一块的明细（一句话，中文）：图上注释与状态栏直接用它 */
        detailText: Render.blockDetailText(x),
      }));
    },

    /** 一个被简略的区块的明细（中文一句话）：数出来什么、真的画了什么、省掉了什么 */
    blockDetailText(rec) {
      if (!rec) return '';
      const parts = [];
      parts.push(`数到 ${rec.nDrawn || 0} 个可简化要素（小面 ${rec.nFills || 0} · POI ${rec.nPoints || 0} · 次要道路 ${rec.nRoads || 0}）`);
      if (rec.nHidden) parts.push(`另有 ${rec.nHidden} 个本来就画不出（面积 LOD/样式）`);
      parts.push(`门槛 ${rec.threshold}${rec.thresholdRaw && rec.thresholdRaw !== rec.threshold ? '（基准 ' + rec.thresholdRaw + ' × 露出 ' + Math.round((rec.visibleFrac || 0) * 100) + '%）' : ''}`);
      parts.push(`省掉 小面 ${rec.simplifiedFills || 0} · POI ${rec.simplifiedPoints || 0} · 次要道路 ${rec.simplifiedRoads || 0}`);
      return parts.join(' · ');
    },

    /**
     * 把"已简略显示"的区块**按相邻成片合并**成若干"区块片（zone）"：
     * 色块还是逐块铺（每一块都看得见），但说明文字与 "?" 每片只画一个 ——
     * 否则低缩放下几百个区块会各自顶着一条注释，把地图糊死（玩家反而看不清哪儿被简化了）。
     * 返回值：[{ blocks:[...], anchor:{lat,lon}, count, simplifiedTotal, text }]
     */
    degradedZones(maxZones) {
      const blocks = Render.degradedBlocks();
      if (!blocks.length) return [];
      const byKey = new Map(blocks.map((b) => [b.key, b]));
      const seen = new Set();
      const zones = [];
      const step = Render._blockGridUsed;
      for (const b of blocks) {
        if (seen.has(b.key)) continue;
        // 广度优先把四邻接（同 x±1 / y±1）的区块连成一片
        const queue = [b];
        seen.add(b.key);
        const group = [];
        while (queue.length) {
          const cur = queue.pop();
          group.push(cur);
          const neighbors = [
            (cur.x + 1) + ':' + cur.y, (cur.x - 1) + ':' + cur.y,
            cur.x + ':' + (cur.y + 1), cur.x + ':' + (cur.y - 1),
          ];
          for (const nk of neighbors) {
            if (seen.has(nk)) continue;
            const nb = byKey.get(nk);
            if (!nb) continue;
            seen.add(nk);
            queue.push(nb);
          }
        }
        let lat = -Infinity;
        let lon = Infinity;
        let fills = 0;
        let points = 0;
        let roads = 0;
        for (const g of group) {
          if (g.bounds.maxLat > lat) lat = g.bounds.maxLat;
          if (g.bounds.minLon < lon) lon = g.bounds.minLon;
          fills += g.simplifiedFills || 0;
          points += g.simplifiedPoints || 0;
          roads += g.simplifiedRoads || 0;
        }
        zones.push({
          zone: true, anchor: { lat, lon }, count: group.length,
          simplifiedFills: fills, simplifiedPoints: points, simplifiedRoads: roads,
          simplifiedTotal: fills + points + roads, blocks: group, text: BLOCK_NOTE,
        });
      }
      zones.sort((a, b2) => b2.simplifiedTotal - a.simplifiedTotal || b2.count - a.count);
      if (Number(maxZones) > 0 && zones.length > maxZones) return zones.slice(0, maxZones);
      return zones;
    },

    /** 分块降级的统计（状态栏/自检看这个） */
    blockStats() {
      const s = Render._blockStats || {};
      const shown = Render.showDegradedBlocks !== false;
      const bd = s.breakdown || null;
      return {
        sizeM: BLOCK_SIZE_M,
        maxBlocks: Render.maxDegradedBlocks,
        maxNotes: Render.maxBlockNotes,
        noteMode: Render.blockNoteMode,
        threshold: s.threshold || 0,
        /** 门槛的原始值（表里那一档；判定用的就是它）与"被简略街区的平均露出比例" */
        thresholdRaw: s.thresholdRaw || s.threshold || 0,
        visibleFrac: s.visibleFrac == null ? 1 : s.visibleFrac,
        keepAreaM2: s.keepAreaM2 || 0,
        budget: s.budget || 0,
        budgetByBlocks: s.byBudget || 0,
        countedFeatures: s.features || 0,
        degradedFeatures: s.degradedFeatures || 0,
        /** 参与统计的要素里"真的会画"与"本来就画不出"各多少（门槛判的是前者） */
        countedDrawn: s.featuresDrawn || 0,
        countedHidden: s.featuresHidden || 0,
        /** 被简略的街区合计明细（小面/POI/次要道路：数到多少、省掉多少） */
        breakdown: bd,
        breakdownText: Render.blockBreakdownText(),
        roadsOn: Render.blockRoadsOn(Render.detail),
        roadKeep: s.roadKeep || 0,
        roadKeepName: Render.roadRankName(s.roadKeep || 0),
        serverSend: Render.serverRoadSend(Render.map ? Render.map.getZoom() : s.zoom || 16),
        blocks: s.blocks || 0,
        hot: s.hot || 0,
        degraded: shown ? (s.degraded || 0) : 0,
        degradedAll: s.degraded || 0,
        featuresCounted: s.features || 0,
        simplifiedFills: s.simplifiedFills || 0,
        simplifiedPoints: s.simplifiedPoints || 0,
        simplifiedRoads: s.simplifiedRoads || 0,
        labelsSkipped: s.labelsSkipped || 0,
        zoom: s.zoom || 0,
        error: s.error || null,
        text: BLOCK_NOTE,
        // 区块标记（色块 + 描边 + 注释 + "?" 徽标）
        shown,
        showToggle: 'Render.showDegradedBlocks',
        fill: Render.blockFill || BLOCK_FILL,
        stroke: Render.blockStroke || BLOCK_STROKE,
        /**
         * "?" 徽标的 tooltip：有街区被简略时**把明细一起挂上去**（需求 #6a：
         * "区块被降级时要在统计里给用户一份明细"）——用户不用点开任何面板就能看到
         * "数到多少 / 门槛多少 / 省掉了什么"，而不是只看到一句"已简略显示"。
         */
        tip: (Render.blockTipText || BLOCK_TIP) + (bd ? '\n\n' + Render.blockBreakdownText() : ''),
        breakdownTip: bd ? Render.blockBreakdownText() : '',
        tips: Render.stats.degradedTips || 0,
        notesDrawn: Render.stats.blockNotes || 0,
        zones: Render.stats.blockZones || 0,
        shadesDrawn: Render.stats.degradedShown || 0,
      };
    },

    /**
     * 被简略街区的合计明细（中文一句话；没有区块被简略时返回空串）。
     * 需求 #6a："区块被降级时要在统计里给用户一份明细" —— 状态栏的 tooltip、图上注释的
     * tooltip（BLOCK_TIP）与自检都读这一份，不再各写一套。
     */
    blockBreakdownText(blocks) {
      const list = blocks || Render._degraded || [];
      if (!list.length) return '';
      let n = 0;
      let drawn = 0;
      let hidden = 0;
      let f = 0;
      let p = 0;
      let r = 0;
      let sf = 0;
      let sp = 0;
      let sr = 0;
      let thr = 0;
      let frac = 0;
      for (const b of list) {
        n += 1;
        drawn += b.nDrawn || 0;
        hidden += b.nHidden || 0;
        f += b.nFills || 0;
        p += b.nPoints || 0;
        r += b.nRoads || 0;
        sf += b.simplifiedFills || 0;
        sp += b.simplifiedPoints || 0;
        sr += b.simplifiedRoads || 0;
        thr += b.threshold || 0;
        frac += b.visibleFrac == null ? 1 : b.visibleFrac;
      }
      return `${n} 个 ${BLOCK_SIZE_M} 米街区已简略显示：数到 ${drawn} 个小面/POI/次要道路`
        + `（小面 ${f} · POI ${p} · 次要道路 ${r}；另有 ${hidden} 个本来就画不出）`
        + `，平均门槛 ${Math.round(thr / n)}（露出比例均值 ${Math.round((frac / n) * 100)}%）`
        + `，已省掉 小面 ${sf} · POI ${sp} · 次级道路 ${sr}`;
    },

    /** way 是否落在"被简化的区块"里（completeness 用它区分"该少的面"和"不该少的面"） */
    isInDegradedBlock(way) {
      const keys = Render._degradedKeys;
      const grid = Render._blockGridUsed;
      if (!keys || !keys.size || !grid) return false;
      const b = World.wayBBox(way);
      if (!b) return false;
      return keys.has(Render.blockKeyOf(grid, (b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2));
    },

    /**
     * World 卸载了视野外的要素之后调一下（World.onUnload）。
     * 卸载只动"保留区之外"的数据，而画面里的要素全都在视野附近 ——
     * 所以这里**不重建、不清层、不重画**（重建反而会闪一下），只把已经不在本地的引用摘掉。
     */
    onWorldUnload(report) {
      if (!report || report.sandbox) return 0;
      if (!report.removed) return 0;
      const alive = (el) => !!(el && World.getWay(el.id));
      const aliveNode = (el) => !!(el && World.getNode(el.id));
      const aliveRel = (el) => !!(el && World.getRelation(el.id));
      let dropped = 0;
      const prune = (list, test) => {
        if (!list || !list.length) return list;
        const next = list.filter(test);
        dropped += list.length - next.length;
        return next;
      };
      Render._visibleWays = prune(Render._visibleWays, alive);
      Render._visibleNodes = prune(Render._visibleNodes, aliveNode);
      Render._visibleRelations = prune(Render._visibleRelations, aliveRel);
      Render.stats.unloadedRefs = (Render.stats.unloadedRefs || 0) + dropped;
      return dropped;
    },

    /* ------------------------------ 图层驱动的显示模式 ------------------------------ */
    /**
     * 显示模式（互斥，只有一个字段）：
     *   normal 普通 / speed 道路车速 / congestion 道路拥堵 / population 人口密度 /
     *   activity 活跃度 / railbus 铁路公交 /
     *   linecolor 按线路色分色 / company 按公交公司分色 / fare 按票价分色
     *   —— 后三个是**旧写法**：它们现在只是"颜色方案"的别名（见 setDisplayMode 与文件顶部那段）。
     * 公交配色请用 Render.setTransitColorScheme()（独立于显示模式，见文件顶部说明）。
     */
    displayMode: 'normal',
    /** 图层：车站覆盖范围（全局单开关，默认关；每站自己的 showCatchment 只是可选过滤器） */
    stationCatchment: { on: false, onlyFlagged: false },
    /** 人口/活跃度格子（来自 /api/population，按视野懒加载） */
    cells: { list: [], bbox: null, loading: false, cellM: 250, mode: null, totals: null, error: null, loadedAt: 0 },
    /** 服务器人口接口的能力探测：activity 字段缺失时活跃度模式要置灰 */
    cellsSupport: { loaded: false, hasActivity: null, hasPopulation: null },
    /** 道路等级默认限速（km/h）：没有 maxspeed 标签时按这个算"有效车速" */
    SPEED_BY_CLASS: {
      motorway: 110, motorway_link: 80, trunk: 90, trunk_link: 70,
      primary: 60, primary_link: 50, secondary: 50, secondary_link: 45,
      tertiary: 40, tertiary_link: 35, unclassified: 30, residential: 30, road: 30,
      living_street: 15, pedestrian: 10, service: 20, track: 15, raceway: 40,
      busway: 40, bus_guideway: 40, construction: 10, proposed: 20,
      footway: 8, path: 8, steps: 5, cycleway: 15, bridleway: 8, corridor: 5,
    },
    /** 车速色标：蓝（慢）→ 红（快） */
    speedScale: {
      min: 10, max: 120, unit: 'km/h',
      ticks: [10, 40, 70, 100, 120],
      stops: [
        { t: 0.00, rgb: [29, 78, 216] },
        { t: 0.20, rgb: [8, 145, 178] },
        { t: 0.40, rgb: [22, 163, 74] },
        { t: 0.60, rgb: [234, 179, 8] },
        { t: 0.80, rgb: [249, 115, 22] },
        { t: 1.00, rgb: [220, 38, 38] },
      ],
    },
    /** 格子图层的色标（人口：黄→红；活跃度：蓝 ← 基准 → 红） */
    cellScale: {
      population: {
        max: 20000,   // 每格（250×250 米）人口上限
        ticks: [0, 5000, 10000, 15000, 20000],
        stops: [
          { t: 0.00, rgb: [255, 247, 214] },
          { t: 0.30, rgb: [254, 217, 118] },
          { t: 0.60, rgb: [253, 141, 60] },
          { t: 0.85, rgb: [227, 26, 28] },
          { t: 1.00, rgb: [152, 0, 24] },
        ],
      },
      activity: {
        base: 1, low: 0.6, high: 1.6,
        near: [[69, 117, 180], [171, 217, 233]],   // 冷清端（低 → 基准）
        far: [[253, 174, 97], [215, 48, 39]],      // 繁华端（基准 → 高）
        neutral: [247, 247, 247],
      },
    },

    /* ------------------------------ 道路拥堵图层（transit op: road.congestion） ------------------------------ */
    /**
     * 拥堵图层状态。数据来自服务器（`{k:'road.congestion', bbox, limit, withCoords}` →
     * `ways:[{wayId, kind, congestion, speed, limit, junctions, density, lengthM, level}]`），
     * 按**取整后的视野 bbox** 缓存，换地方就像人口格子一样补一次；同一时刻最多一个请求在飞。
     */
    congestion: {
      list: [],                    // 服务器原样返回的道路（含轨道等非道路成员）
      roads: [],                   // 过滤后的"可通行机动车道"（着色与统计只看这些）
      byWayId: new Map(),          // wayId → { wayId, kind, congestion, speed, limit, level, ... }
      counts: { free: 0, busy: 0, jam: 0, other: 0 },   // other = 被剔除的非道路成员（轨道/步道）
      bbox: null,                  // 这批数据覆盖的范围（请求时按 congestionGridDeg 向外取整）
      key: '',                     // 取整后 bbox 的字符串（同一片地方不重复请求）
      viewBox: null,               // 发起请求时的真实视野
      requestBox: null,            // 实际发出去的 bbox
      loading: false,              // 有一个请求在飞
      pendingId: null,             // 在飞请求的 id（认领 transitAck）
      requests: 0,                 // 本会话发了多少次请求（自检/排查看它）
      error: null,
      hinted: false,               // "取不到拥堵数据"的中文提示只弹一次
      loadedAt: 0,
      ms: 0,
      truncated: false,
      total: 0,
      meanSpeed: 0,
      meanLimit: 0,
      meanCongestion: 0,
      minSpeed: 0,
      maxSpeed: 0,
      slowest: null,
      fastest: null,
      serverStats: null,           // 服务器给的 stats（路口数 / 密度尺度 / 格子米数）
    },
    /** 一次最多要多少条道路（服务器上限 50000，这里按一屏能画的量取） */
    congestionLimit: 8000,
    /** 视野向外取整的格子（度）：≈200 米，来回小拖不用重取 */
    congestionGridDeg: 0.002,
    /** 请求 bbox 相对视野再外扩的比例（兜住拖动时视野边缘） */
    congestionPad: 0.05,
    /** 请求超时（毫秒）：超时就当失败，退回普通配色 */
    congestionTimeoutMs: 12000,
    /** 拥堵三档配色：畅通（绿）→ 一般（琥珀）→ 拥堵（红） */
    congestionScale: {
      colors: { free: '#16a34a', busy: '#eab308', jam: '#dc2626' },
      labels: { free: '畅通', busy: '一般', jam: '拥堵', unknown: '无数据' },
      levels: ['free', 'busy', 'jam'],
      /** 路网里查不到的道路（新路/未建图）：中性灰，不假装知道它堵不堵 */
      unknown: '#b9bec6',
      /** 档内的明暗范围（按"服务速度 / 限速"微调：越接近限速越亮） */
      shadeMin: 0.84,
      shadeMax: 1.12,
    },
    /**
     * 服务器口径里"机动车不能走"的等级（与 server/railgraph.js 的 BUS_FORBIDDEN 一致）。
     * 这些等级不在拥堵路网里，也就没有拥堵可言。
     */
    CONGESTION_FORBIDDEN: new Set(['footway', 'path', 'steps', 'cycleway', 'bridleway', 'corridor',
      'construction', 'proposed', 'raceway', 'platform', 'elevator']),
    /**
     * 轨道类型（与 server/railgraph.js 的 RUNNABLE 一致）。
     * 服务器的路网表里**混着轨道**（轨道不堵车，没有拥堵系数），客户端统计/着色必须把它们剔掉。
     */
    CONGESTION_RAIL_KINDS: new Set(['rail', 'light_rail', 'subway', 'tram', 'narrow_gauge',
      'monorail', 'funicular', 'preserved']),

    init(map, options = {}) {
      Render.map = map;
      Render.style = options.style || window.G.Style;
      Render.getOverlayState = options.getOverlayState || (() => Render.overlayState);
      Render.visibleCategories = options.visibleCategories || new Set(
        (Render.style.CATEGORIES || []).filter((c) => c.defaultVisible !== false).map((c) => c.id)
      );

      for (const [name, z] of Object.entries(PANES)) {
        const pane = map.createPane('osmcity-' + name);
        pane.style.zIndex = String(z);
        if (name !== 'overlay') pane.style.pointerEvents = 'none';
      }
      Render.rendererFill = Render.timeRenderer(L.canvas({ pane: 'osmcity-fill', padding: 0.3 }), 'fill');
      Render.rendererBuilding = Render.timeRenderer(L.canvas({ pane: 'osmcity-building', padding: 0.3 }), 'building');
      Render.rendererCasing = Render.timeRenderer(L.canvas({ pane: 'osmcity-casing', padding: 0.3 }), 'casing');
      Render.rendererCore = Render.timeRenderer(L.canvas({ pane: 'osmcity-core', padding: 0.3 }), 'core');
      Render.rendererFocus = Render.timeRenderer(L.canvas({ pane: 'osmcity-focus', padding: 0.3 }), 'focus');

      Render.fillLayer = L.layerGroup().addTo(map);
      Render.buildingLayer = L.layerGroup().addTo(map);
      Render.casingLayer = L.layerGroup().addTo(map);
      Render.coreLayer = L.layerGroup().addTo(map);
      Render.focusLayer = L.layerGroup().addTo(map);
      Render.overlay = new OverlayLayer(Render).addTo(map);
      Render.labelsVisible = options.labelsVisible !== false;

      /**
       * 重建排期：默认合并到 90ms 后重建一次（数据一块块到达时不要每块都重建）。
       * 但**最后一块**不再等满整个窗口：已经没有在途请求了就 16ms 后重建 ——
       * "拖一屏"的关键路径上少等 70ms。
       */
      Render.markDirty = () => Render.scheduleRebuild();
      /**
       * **本地编辑落地后的重画钩子**（"编辑后地图不实时更新"的另一半）。
       *
       * World 在 op ack 落地时会发现"编辑器拖动时原地改过节点坐标"（见 World.refreshNodesGeometry），
       * 并把受影响的 way 的几何缓存/索引项就地修正。修完必须重画，而且**两样都要**：
       *   · scheduleRebuild —— 矢量图层（道路/建筑）按新几何重画；
       *   · scheduleOverlay —— 覆盖画布（选中高亮、节点小方块、预览）跟着重画。
       * 缺任何一样，玩家看到的就是"改完了，地图上还是老样子"。
       */
      if (World && 'onGeometryFixed' in World) {
        World.onGeometryFixed = (info) => {
          Render.stats.geomFixedWays = (info && info.ways) || 0;
          Render.stats.geomFixSrc = (info && info.src) || '';
          Render.scheduleRebuild();
          Render.scheduleOverlay();
        };
      }
      /**
       * World 卸载视野外要素后的回调：只摘掉已经不在本地的引用，绝不重建、绝不清层。
       * 因为卸载只动"保留区之外"的数据，当前画面里根本不会少东西 ——
       * 所以这里连一次重画都不需要，拖动过程中不会出现闪一下的空白。
       */
      if (World && 'onUnload' in World) World.onUnload = (report) => Render.onWorldUnload(report);
      /**
       * 缩放变化：投影结果失效，必须重建。
       * 平移（moveend）不再无条件重建：Leaflet 自己会把 canvas 平移过去，
       * 只要视野还在"上次重建覆盖的范围"里就一行代码都不用跑（这就是拖动不掉帧的原因）。
       */
      /**
       * 缩放变化：投影结果失效，必须重建；**同时换一代 LOD 决策**（#6c）。
       * 换代的含义：所有已经加载的 way 的"画不画 / 按面积筛不筛"结论一起作废，
       * 下一次重建会按新缩放**重新判一遍**（而不是继续沿用上一档的结论或几何）。
       */
      map.on('zoomend', () => { Render.bumpLodGen('zoom'); Render.markDirty(); });
      map.on('moveend', () => Render.onMoveEnd());
      /**
       * 一轮"视野变化"从拖动/缩放的**开始**算起：这样 fetch（网络）也算进这一轮，
       * 读 World.perfSnapshot() / Render.stats.lastPan 就能看到完整分解。
       */
      map.on('movestart zoomstart', () => Render.beginLoadRound(map.getZoom() !== Render._lastRoundZoom ? 'zoom' : 'pan'));
      map.on('zoomend', () => { Render._lastRoundZoom = map.getZoom(); });
      // 注意：'move'/'zoom' 不需要额外监听 —— OverlayLayer 自己盯着这些事件，
      // 视野还在已画范围里时它连重画都不做（这是拖动不掉帧的关键）。
      // 人口/活跃度图层跟着视野走：换了地方就补一格新数据（数据没覆盖到才发请求）
      map.on('moveend zoomend', () => {
        if (Render.isCellMode()) Render.ensureCells(false);
        // 拥堵图层同理：视野跑出已取范围才重新要一次（取整后的 bbox 一样就什么都不做）
        if (Render.isCongestionMode()) Render.ensureCongestion(false);
      });
      /**
       * 拥堵数据的应答走同一条 WebSocket（transit op 的 transitAck）。
       * 这里只认领"自己发出去的 id"，别人的（交通面板的）一概不碰。
       */
      Render.ensureCongestionListener();
      // 数据版本：World 里一有写入（合并视口数据、协作操作）就重建
      Render._dataStamp = World && World.dataStamp ? World.dataStamp : 0;
      /**
       * 详细度档位：默认是"标准"（比"完整"省装饰性面，道路/铁路/水系一条不少）。
       * 存档迁移：v2 键里存什么就是什么；只有老 v1 键时，把玩家**手动选过**的档（1/2/3）
       * 带过来，老默认的 0（完整）不再沿用 —— 那正是"太细、拖起来慢"的来源。
       */
      const savedV2 = util.storage.get(Render.DETAIL_KEY, null);
      const savedV1 = savedV2 == null ? util.storage.get(Render.LEGACY_DETAIL_KEY, null) : null;
      let level = Render.DEFAULT_DETAIL;
      if (savedV2 != null) level = Render.clampDetail(savedV2);
      else if (savedV1 != null && Number(savedV1) >= 1 && Number(savedV1) <= 3) level = Render.clampDetail(savedV1);
      Render.detail = level;
      Render.labelBudget = Render.detailLabelBudget(level);
      Render._lastRoundZoom = map.getZoom();
      // 详细度 1（"全部道路"）要把服务器的分级缩放抬到 17，才能拿到服务路/步道
      try {
        const md = window.G.MapData;
        if (md) md.zoomFloor = Render.detail === 1 ? 17 : 0;
      } catch { /* ignore */ }
      /**
       * 公交分色的取色钩子：现在就装上（幂等）。
       * 装在 init 而不是"切方案时"是因为存档里的颜色方案 / 显示模式可能在 Render.init 之前就被恢复；
       * 钩子在"方案不会改变这条线的颜色"时只是原样转交原函数
       * （代价是一次方案判断 + 一次查表，见 transitLineColorMatches）。
       */
      Render.installTransitColorHooks();
      return Render;
    },

    /* ------------------------------ 拖动/缩放的分阶段计时 ------------------------------ */
    /**
     * 给 canvas 渲染器套一层计时：Leaflet 每次把某一层的所有图形画到画布上时都走 _redraw，
     * 所以"画布绘制"这一段（矢量图层的路径装配 + 光栅化调用）终于能算进账里。
     * 只包我们自己的 5 个渲染器实例，不动 Leaflet 原型（别的用途/别的图层不受影响）。
     */
    timeRenderer(renderer, name) {
      if (!renderer || typeof renderer._redraw !== 'function' || renderer.__timed) return renderer;
      const orig = renderer._redraw;
      renderer.__timed = true;
      renderer._redraw = function () {
        const t0 = performance.now();
        try {
          return orig.apply(this, arguments);
        } finally {
          const ms = performance.now() - t0;
          Render.stats.drawMs = (Render.stats.drawMs || 0) + ms;
          Render.stats.drawLastMs = Math.round(ms * 10) / 10;
          Render.stats.drawName = name;
          if (World && World.perfAdd) World.perfAdd('draw', ms);
          Render._closeRoundSoon();
        }
      };
      return renderer;
    },
    /**
     * 开一轮：把"视野变化"当成一个整体来记账（fetch → merge → index → rebuild → draw）。
     * 收轮在 _closeRoundIfIdle() 里（重建提交 + 画布画完 + 没有在途请求之后）。
     */
    beginLoadRound(reason) {
      if (!World || typeof World.perfBegin !== 'function') return null;
      const r = World.perfBegin(reason || 'pan');
      Render._roundMarks = { t0: (typeof performance !== 'undefined' ? performance.now() : Date.now()), reason: reason || 'pan', firstCommit: 0, drawn: 0 };
      return r;
    },

    /** 重建真正提交（第一批要素落到画布）的时刻：这就是"新区域出现"的时间点 */
    markFirstCommit() {
      const m = Render._roundMarks;
      if (!m || m.firstCommit) return;
      m.firstCommit = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - m.t0;
      Render.stats.firstCommitMs = Math.round(m.firstCommit);
      if (World && World.perfAdd) World.perfAdd('firstCommit', m.firstCommit);
    },

    /** 画布画完之后过一小会儿收轮：没有在途请求、没有待重建，就落定这一轮 */
    _closeRoundSoon() {
      if (Render._roundTimer) clearTimeout(Render._roundTimer);
      const later = () => {
        Render._roundTimer = null;
        Render._closeRoundIfIdle();
      };
      Render._roundTimer = setTimeout(later, 300);
    },

    _closeRoundIfIdle() {
      if (!World || !World.perf || !World.perf.open) return null;
      const md = World.mapData || (window.G && window.G.MapData);
      const busy = (md && (md.fetching || md.inflight > 0 || (md.queue && md.queue.length))) || Render.jobPending();
      if (busy) return null;
      const snap = World.perfClose();
      if (!snap) return null;
      const m = Render._roundMarks || {};
      snap.firstCommitMs = Math.round(m.firstCommit || 0);
      snap.zoom = Render.map ? Render.map.getZoom() : 0;
      snap.detail = Render.detail;
      snap.features = Render.stats.features;
      snap.fills = Render.stats.fills;
      Render.stats.lastPan = snap;
      Render.stats.panMs = snap.totalMs;
      return snap;
    },

    /** 最近一轮"视野变化"的分阶段耗时（拖动排查/自检读它） */
    panStages() {
      const w = World && World.perfSnapshot ? World.perfSnapshot() : { stages: {}, counts: {} };
      const s = Render.stats.lastPan;
      return {
        zoom: s ? s.zoom : (Render.map ? Render.map.getZoom() : 0),
        detail: Render.detail,
        detailName: Render.detailName(),
        totalMs: s ? s.totalMs : 0,
        firstCommitMs: s ? s.firstCommitMs : 0,
        stages: Object.assign({}, w.stages),
        counts: Object.assign({}, w.counts),
        totals: Object.assign({}, w.totals),
        render: {
          rebuildMs: Render.stats.ms, passes: Render.stats.passes,
          blockMs: Render.stats.blockMs, wayMs: Render.stats.wayMs,
          nodeMs: Render.stats.nodeMs, relationMs: Render.stats.relationMs,
          commitMs: Render.stats.commitMs, overlayMs: Render.stats.overlayMs, canvasMs: Render.stats.drawMs,
        },
        blocks: Render.blockStats(),
        /** 拖动体验：重建分了几帧、每帧多少 ms、画布一次刷多少 ms（"绘制本身是不是瓶颈"就看这三个数） */
        frame: {
          rebuildMs: Render.stats.ms,          // 最近一次重建的 CPU 时间（分片累加）
          rebuildWallMs: Render.stats.wallMs,  // 最近一次重建的墙钟（含分帧之间的等待）
          passes: Render.stats.passes,         // 这次重建占了几帧
          perFrameMs: Render.stats.passes > 0 ? Math.round((Render.stats.ms / Render.stats.passes) * 10) / 10 : Render.stats.ms,
          // 这一轮里"画布绘制"一共花了多少 ms（5 个渲染器的 _redraw 累加，含路径装配）
          canvasRoundMs: Math.round((w.stages.draw || 0) * 10) / 10,
          canvasLastMs: Render.stats.drawLastMs || 0,
          overlayRoundMs: Math.round((w.stages.overlay || 0) * 10) / 10,
          overlayMs: Render.stats.overlayMs || 0,   // 一次覆盖画布重绘（标签/区块标记等）
          features: Render.stats.features,
          fills: Render.stats.fills,
        },
      };
    },

    /**
     * 平移结束：只有当"当前视野"跑出了上次重建覆盖的范围时才重建。
     * 视野内平移 → 什么都不做（Leaflet 平移画布，画面不会出现空档）。
     */
    onMoveEnd() {
      const map = Render.map;
      if (!map) return;
      // 覆盖画布由 OverlayLayer 自己在 moveend/zoomend 上按"是否还在已画范围内"决定要不要重画
      if (Render._dataStamp !== (World.dataStamp || 0)) { Render.markDirty(); return; }
      const b = Render._rebuiltBounds;
      const need = !b || !b.contains(map.getBounds());
      if (need) Render.markDirty();
    },

    /* ------------------------------ 重建排期（拖动关键路径上的固定延迟） ------------------------------ */
    /** 数据还在陆续到达时的重建合并窗口 */
    dirtyDelayMs: 90,
    /** 数据已经齐了（没有在途请求）时的重建延迟：几乎立刻重建，别让玩家干等 */
    dirtyFastMs: 16,

    /**
     * 排一次重建。以前是固定 120ms 防抖：哪怕数据早就齐了也要白等 120ms 才开画 ——
     * 那正是"拖完手停住了，画面还要愣一下"的一部分。现在按"还有没有在途请求"决定延迟。
     */
    scheduleRebuild() {
      /**
       * 已经在重建：**等这次画完再排下一次**。
       * 否则数据一块块到达时，每次到达都把上一次重建顶掉（_job 换代），
       * 结果是"数据一直在来、画面却一直停在上一批"——看起来就是卡住不动。
       */
      if (Render.jobPending()) { Render._rebuildQueued = true; return 0; }
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const md = World.mapData || (window.G && window.G.MapData);
      const loading = !!(md && (md.fetching || md.inflight > 0 || (md.queue && md.queue.length)));
      const delay = loading ? Render.dirtyDelayMs : Render.dirtyFastMs;
      if (Render._dirtyTimer) {
        // 已经在排队：只有"新延迟更早"时才提前（最后一块到了就别再等满窗口）
        const at = Render._dirtyAt || 0;
        if (now + delay >= at) return;
        clearTimeout(Render._dirtyTimer);
      }
      Render._dirtyAt = now + delay;
      Render._dirtyTimer = setTimeout(() => {
        Render._dirtyTimer = null;
        Render._dirtyAt = 0;
        Render.rebuild({ async: true });
      }, delay);
      return delay;
    },

    /** 覆盖画布合并到一帧里重绘（拖动时每个事件都重画会把帧吃掉） */
    scheduleOverlay() {      if (Render._overlayRaf != null) return;
      const raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16);
      Render._overlayRaf = raf(() => {
        Render._overlayRaf = null;
        if (Render.overlay) Render.overlay.redraw();
      });
    },

    setCategoryVisible(cat, on) {
      if (on) Render.visibleCategories.add(cat);
      else Render.visibleCategories.delete(cat);
      Render.rebuild({ async: true });
    },

    isVisible(cat) { return Render.visibleCategories.has(cat); },

    metersPerPixel() {
      const map = Render.map;
      return (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
    },

    /**
     * 样式里的宽度随缩放变化。
     * 排序后的缩放键按样式对象缓存（WeakMap）：以前**每条路**都要 Object.keys+map+sort
     * 一遍，几万条路重建一次就是几万次数组分配 —— 这是纯浪费。
     */
    _widthKeys: new WeakMap(),
    widthAtZoom(style, zoom) {
      const base = Number(style.weight || style.strokeWidth || 2);
      if (style.widthByZoom && typeof style.widthByZoom === 'object') {
        let keys = Render._widthKeys.get(style.widthByZoom);
        if (!keys) {
          keys = Object.keys(style.widthByZoom).map(Number).sort((a, b) => a - b);
          Render._widthKeys.set(style.widthByZoom, keys);
        }
        if (keys.length) {
          let lo = keys[0];
          let hi = keys[keys.length - 1];
          for (const k of keys) { if (k <= zoom) lo = k; if (k >= zoom) { hi = k; break; } }
          const v1 = Number(style.widthByZoom[lo]);
          const v2 = Number(style.widthByZoom[hi]);
          if (lo === hi) return v1;
          const t = (zoom - lo) / (hi - lo);
          return v1 + (v2 - v1) * t;
        }
      }
      // 没有给出映射时：低缩放细一点，高缩放按比例放大
      const f = zoom <= 12 ? 0.6 : zoom <= 14 ? 0.8 : zoom <= 16 ? 1 : zoom <= 18 ? 1.25 : 1.5;
      return Math.max(0.6, base * f);
    },

    /* ------------------------------ 主渲染 ------------------------------ */
    /**
     * 这条 way"根本轮不到画"的设计性理由（与截断/降级无关）：
     *   · `no-rule`   —— 样式表里没有可用的规则（例如标签是空对象 `{}`）；
     *   · `rule-zoom` —— 规则自己规定了缩放范围（例如兜底规则 minZoom 17，而现在是 z11）；
     *   · `layer-off` —— 玩家把这一图层关了。
     * 返回 null 表示"该照画"。
     *
     * 为什么单独拎出来：这些 way 可能在 `_relationPass`（多面体成员）里拿到过几何，
     * 于是 completeness() 会在视野里数到它，却永远等不到它被单独画出来 ——
     * 账面上就是"计划外缺失"。**这不是丢东西，是设计上就不画**，
     * 所以必须和"分块简化 / 档位省 / 节点没到"分开记账（同一个函数分类，口径不会漂移）。
     */
    waySkipReason(way, kind, zoom, style) {
      const st = style || Render.style;
      const rule = Render.ruleForWay(way, kind, st);
      if (!rule) return 'no-rule';
      if (zoom < (rule.minZoom || 0) || zoom > (rule.maxZoom || 99)) return 'rule-zoom';
      if (!Render.isVisible(st.categoryOf(way.tags, kind))) return 'layer-off';
      return null;
    },

    /**
     * 一次重建允许占用的单帧时间：超过就把剩下的要素交给下一帧继续处理。
     * 处理期间画面上仍然是"上一套完整的要素"，所以分帧不会出现半截图。
     */
    frameBudgetMs: 10,
    /** 每处理多少个要素检查一次时间（读时钟也不要太频繁） */
    sliceCheck: 256,
    /**
     * "收集视野内的 way"的单步预算（ms）：游标每跑这么多就交还控制权，
     * 由 `_runJobChunk` 决定是继续跑还是留到下一帧（帧预算 = frameBudgetMs）。
     * 取 2 ms 的理由：一次 `step` 内部不会被更细地打断，所以单步本身要足够小，
     * 才能保证"最长的同步段 ≈ frameBudgetMs + 单步" ≈ 12 ms 这个量级；
     * 再小（0.5 ms）会让每帧的检查开销占比变高，再大（8 ms）就没法保证帧预算了。
     */
    collectSliceMs: 2,

    /**
     * 重建场景。**禁止截断**：
     *   · 本地已加载、落在视野里的要素全部进入绘制列表，没有任何数量上限（featureBudget 已废弃）；
     *   · 道路/铁路/水系等线要素永不分级 —— 只在玩家自己选的"精简/骨架"档位下才对
     *     绿地/水面/小面积这类装饰性面分级；
     *   · 同色同宽的线合并成一个 Leaflet 对象（一笔画多段），几万条路也只有几十个对象，
     *     所以"全画"并不会拖垮帧率。
     * 重建是分片的：单帧只处理一部分要素，剩下的交给下一帧，避免长帧造成的卡顿。
     * **收集视野内的 way 也一样分片**（见 collectSliceMs / _runJobChunk 的 collect 阶段）：
     * 老实现一进来就 `queryWays` 一口气扫完整个矩形，低缩放时那一次同步调用就是几十上百毫秒。
     */
    rebuild(options = {}) {
      if (!Render.map) return;
      const map = Render.map;
      const tRebuild = performance.now();
      /**
       * 分阶段计时：这次重建是"谁引起的"也要能看出来（拖动 / 切图层 / 协作数据到达）。
       * 如果这一轮（拖动/缩放）还没开（比如只是切了个图层），就地开一轮，别让耗时无处可记。
       */
      if (World && World.perf && !World.perf.open) Render.beginLoadRound(options.reason || 'rebuild');
      const zoom = map.getZoom();
      const bounds = map.getBounds().pad(0.12);
      /**
       * **真实视野框**（不带那 12% 的画布 padding）。
       * 两个用处（#6a）：
       *   · 统计"到底有多少要素画在玩家看得见的范围里"（视野外那圈不算）；
       *   · 分块密度的计数与门槛折算（padding 那一圈看不见，不该把街区判成过密）。
       */
      const viewLL = map.getBounds();
      const viewBox = {
        minLat: viewLL.getSouth(), maxLat: viewLL.getNorth(),
        minLon: viewLL.getWest(), maxLon: viewLL.getEast(),
      };
      /** 缩放变了就换一代：所有 per-way 的 LOD 决策缓存一起作废（#6c） */
      if (Render._lodZoom !== zoom) {
        Render._lodZoom = zoom;
        Render.bumpLodGen('zoom');
      }
      /**
       * 缩小之后先丢掉"这一档永远画不出来、又不在眼前"的高细节几何（#6c）：
       * 必须在建立查询游标之前做 —— 这样收集阶段就少扫一大截，
       * 而且"已经加载的老几何"与"新取回来的一块"用的是同一个缩放上的同一套门槛。
       * 放大时这一句什么都不做（见 dropDetailForZoom 的短路条件）。
       */
      try { Render.dropDetailForZoom(zoom); } catch (err) {
        Render.stats.detailDropReason = 'error: ' + (err && err.message ? err.message : String(err));
      }
      const style = Render.style;
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const bbox = { minLat: sw.lat, maxLat: ne.lat, minLon: sw.lng, maxLon: ne.lng };

      /**
       * 视野内的 way **不再在这里一口气取完**：这里只建一个游标（几乎零成本），
       * 真正的"扫空间索引"放到 `_runJobChunk` 的 collect 阶段，按 collectSliceMs 一步一步跑，
       * 单帧超了 frameBudgetMs 就留给下一帧 —— 于是**最长同步段是有上限的**，
       * 不会再出现"点一下缩放/拖一下，主线程被 queryWays 按住几百毫秒"的长任务。
       * （World 还没有 queryWaysCursor 的旧接口时退回一次取全，行为与以前一致。）
       */
      const wayList = Render._wayQuery || (Render._wayQuery = []);
      const hasCursor = typeof World.queryWaysCursor === 'function';
      const job = {
        seq: (Render._jobSeq || 0) + 1,
        t0: tRebuild,
        zoom,
        bounds,
        bbox,
        viewBox,
        lodGen: Render.lodGen || 0,
        style,
        i: 0,
        phase: 'collect',
        wayCursor: hasCursor ? World.queryWaysCursor(bbox, wayList) : null,
        wayList,
        collectMs: 0,
        collectPasses: 0,
        /**
         * 低缩放合并折线（服务端 `payload.displayLines`）：只有几何、没有 way id。
         * 它们**不进 wayList**（不参与完整性分母、不能被选中），单独一趟画（见 _displayLinePass）。
         */
        displayList: (typeof World.queryDisplayLines === 'function')
          ? World.queryDisplayLines(bbox, Render._displayQuery || (Render._displayQuery = []))
          : [],
        /**
         * 低缩放合并面（服务端 `payload.displayAreas`）：同样只有几何、没有 way id，
         * 不进 wayList（不参与完整性分母、不能被选中），单独一趟画（见 _displayAreaPass）。
         */
        displayAreaList: (typeof World.queryDisplayAreas === 'function')
          ? World.queryDisplayAreas(bbox, Render._displayAreaQuery || (Render._displayAreaQuery = []))
          : [],
        fills: [],
        fillShapes: 0,           // 填充的"面"个数（fills 里可能是合批后的对象）
        buildings: [],
        casings: [],
        cores: [],
        focusShapes: [],
        buckets: new Map(),      // 线要素：样式 key → { opts, paths }
        visibleWays: [],
        visibleNodes: [],
        visibleRelations: [],
        labels: [],
        detailShapes: 0,
        speedRoads: 0,
        congestionRoads: 0,
        congestionColored: 0,
        extrudedWays: 0,
        extrudedRelations: 0,
        innerRings: 0,
        courtyardWalls: 0,
        roofHoles: 0,
        flatBuildings: 0,
        relationFallbacks: 0,
        skipped: 0,
        lastError: null,
        roadsInView: 0,
        roadsDrawn: 0,
        batches: 0,
        passes: 1,
        cpuMs: 0,
        blockMs: 0,
        nodeMs: 0,
        relationMs: 0,
        commitMs: 0,
        /** 低缩放合并折线（displayLines）的记账：进来的条目 / 真画出来的路径 / 点数 */
        displayLinesInView: 0,
        displayLinesDrawn: 0,
        displayLinePaths: 0,
        displayLinePoints: 0,
        displayLinesByRule: 0,
        /** 低缩放合并面（displayAreas）的记账：条目 / 真的画出来的环 / 点数 / 因样式不画 */
        displayAreasInView: 0,
        displayAreasDrawn: 0,
        displayAreaRings: 0,
        displayAreaOpenRings: 0,
        displayAreaPoints: 0,
        displayAreasByRule: 0,
        detailDroppedFills: 0,
        skippedTiny: 0,
        skippedSmall: 0,
        /* ------------------- 要素账（#6a：视野内 / 视野外 / 没画出来 三本账） ------------------- */
        waysInView: 0, nodesInView: 0, relsInView: 0,
        waysOffView: 0, nodesOffView: 0, relsOffView: 0,
        notDrawnInView: 0, areaLodSkipped: 0, areaLodRelationSkipped: 0,
        nodeOutOfViewSkipped: 0, relationOutOfViewSkipped: 0,
        /** 这一帧里"因为档位而没画"的要素 id（completeness 用它把账分清楚） */
        detailDropped: new Set(),
        /** 这一帧里"因为区块过密而没画"的次要道路 id（completeness 用它把账分清楚） */
        blockRoadSimplifyIds: new Set(),
        lastSliceAt: tRebuild,
        async: options.async === true,
        resolve: null,
        startedAt: tRebuild,
        // 分块降级（300 米区块）
        centerLat: (bbox.minLat + bbox.maxLat) / 2,
        blockGrid: null,
        degraded: [],
        degradedKeys: null,
        degradedMap: null,
        blockThreshold: 0,
        blockThresholdRaw: 0,
        blockThresholdScaled: 0,
        blockVisibleFrac: 1,
        blockKeepArea: 0,
        blockCounted: 0,
        blockFeatures: 0,
        blockFeaturesDrawn: 0,
        blockFeaturesHidden: 0,
        blockHot: 0,
        blockSimplified: 0,
        blockPointsSimplified: 0,
        blockLabelsSkipped: 0,
        blockRoadsSimplified: 0,
        blockRoadKeep: 0,
      };
      Render._jobSeq = job.seq;
      Render._job = job;
      // 记下"这次重建覆盖的范围"：视野还在里面时，平移完全不需要重建
      Render._rebuiltBounds = L.latLngBounds(
        [bbox.minLat - (bbox.maxLat - bbox.minLat) * 0.1, bbox.minLon - (bbox.maxLon - bbox.minLon) * 0.1],
        [bbox.maxLat + (bbox.maxLat - bbox.minLat) * 0.1, bbox.maxLon + (bbox.maxLon - bbox.minLon) * 0.1]
      );
      Render._dataStamp = World.dataStamp || 0;
      /**
       * 顺手把当前视野交给 World：它会按"视野 + 每边 0.75 屏"的保留区卸载视野外的要素
       * （所以拖动久了本地要素数会掉下来，而不是只进不出）。
       * 注意这次调用可能让 dataStamp 变化，所以数据版本号在它之后再取一次。
       */
      if (World.setViewport) World.setViewport(bbox);
      Render._dataStamp = World.dataStamp || 0;

      if (job.legacyQuery) {
        // 兜底：没有游标的旧 World（自检里的替身）→ 老行为，一次取全
        job.wayList = World.queryWays(bbox, wayList);
        job.phase = 'ways';
        Render.planBlockPass(job);
      }

      Render._runJobChunk(job);
    },

    /**
     * 分块降级（严格 LOD，但永不截断）：
     * 先按 300 米区块数一遍"可简化的要素"（装饰性面 + POI + 次要道路），
     * 只把超过门槛的区块标成"简略显示"。
     * 这一步只读缓存的 bbox，不做投影，代价很小；主干道、铁路、水系、骨架面根本不参与统计。
     * 「完整/全部道路」档整体跳过（一个要素都不简化 —— 玩家要全画就给全），也顺手省掉这一步的开销。
     *
     * 它要遍历**整张 wayList**，所以只能在"收集阶段跑完"之后做（见 _runJobChunk 的 collect 阶段）。
     */
    planBlockPass(job) {
      if (!Render.blockLevelsOn(Render.detail)) return;
      try {
        const tb = performance.now();
        const counts = Render.countBlockFeatures(job);
        Render.planBlocks(job, counts);
        job.blockMs = performance.now() - tb;
      } catch (err) {
        // 分块统计出问题也绝不能影响"把要素画出来"：退化成"这一帧不简化"
        job.degraded = [];
        job.degradedKeys = new Set();
        job.degradedMap = new Map();
        job.blockError = err && err.message ? err.message : String(err);
      }
    },

    /* ------------------------------ 缩放变小：丢掉当前 LOD 用不上的细节（#6c） ------------------------------ */
    /**
     * 缩小之后，把**当前 LOD 根本不会画、又不在眼前**的高细节几何从本地丢掉。
     *
     * 为什么需要它：客户端的 way 集合是"按保留区卸载"的（视野 + 每边 0.75 屏），
     * 与缩放无关。于是 z19 载入的一批细致几何（服务路、步道、小房子）缩到 z13 之后仍然留在本地：
     *   · 状态栏的"本地要素数"一直停在 2.6 万（#6a 的观感来源）；
     *   · 空间索引、块统计、POI 查询、卸载评估都要为它们付钱；
     *   · 更要紧的是：重新平移时"老几何按老阈值画、新取的那块按新阈值画"，两半 LOD 不一致（#6c）。
     *
     * 三条硬规则（"道路一条不缺"的承诺不受影响）：
     *   1) **只在缩小后触发**（`zoom < Render._detailDropZoom`），放大从不触发；
     *   2) **主干道 / 次要干道 / 铁路 / 水系 / 骨架面 / 被钉住或锁住的元素一律不动**
     *      （rank ≤ 1 = motorway/trunk/primary/secondary 含 _link；pinned/锁/撤销保护在 World 侧跳过，
     *       另外"这一档画得出来的关系"的成员 way 也一律保住 —— 环靠懒缝，成员缺了几何那块面就没了）；
     *   3) **只丢"在当前缩放下画不出来"的**，判据与 `_wayPass` 完全一致（唯一一处判定）：
     *      · 样式规则的可见缩放；· 线再看道路等级门槛（与服务端下发同一张表）；
     *      · 面再看分级门槛 + 面积 LOD（z13 ≥20000 … z19 ≥20）。
     *      视野内外的**都一样丢** —— 这些几何这一档本来就不画，属于"当前 LOD 之外"，
     *      而不是"少画"；统计里单列 keptInView 便于对照。
     * 丢掉之后放大回去为什么不会缺东西：换缩放时 MapData 的范围缓存整批作废
     * （见 mapdata.js 的 rects 规则），服务器会把这一档的完整数据重新取一遍。
     */
    dropDetailForZoom(zoom, bounds) {
      const W = World;
      if (!W || typeof W.dropWays !== 'function') return 0;
      /**
       * 什么时候跑这一趟：
       *   · 缩小（zoom < 上一次清理的档位）——必须跑；
       *   · 在同一档位又有**新数据进来**（geomStamp 变了）——还要再跑一遍：
       *     否则"缩小时清掉一批、随后 MapData 又补进来一批高细节几何"就漏了（实测过这个洞：
       *     z15 第一次清理时本地才 1156 条，数据补齐后变成 3200+ 条，清理等于没做）。
       * 平移（几何没变）不重复扫 —— 这一步要遍历本地所有 way，能省就省。
       */
      const stamp = W.geomStamp || 0;
      const lastZoom = Render._detailDropZoom == null ? Infinity : Render._detailDropZoom;
      const zoomShrank = zoom < lastZoom;
      const dataGrew = zoom <= lastZoom && Render._detailDropStamp !== stamp;
      if (!zoomShrank && !dataGrew) {
        /**
         * 放大（或同一档但数据没变）：什么都不用丢，但要把"上次清理的档位"抬到当前档 ——
         * 否则"先缩到 z12 清过一次、再放大到 z19、然后又缩回 z13"这一串里，
         * z13 会因为 13 > 12 而被判成"没缩小"（实测过的坑：整条缩放梯子一次都不清理）。
         */
        if (zoom > lastZoom) Render._detailDropZoom = zoom;
        return 0;
      }
      const t0 = performance.now();
      const style = Render.style;
      /** 眼前这一圈（视野 + 每边 1/4 屏）——拖一屏之内都不会用到新数据，先记下来 */
      const box = bounds || (Render.map ? Render.map.getBounds().pad(0.25) : null);
      const view = box ? { minLat: box.getSouth(), maxLat: box.getNorth(), minLon: box.getWest(), maxLon: box.getEast() } : null;
      const stats = { scanned: 0, dropped: 0, kept: 0, keptMajor: 0, keptInView: 0, keptDrawable: 0, keptRelation: 0, keptReason: {} };
      /**
       * 关系成员 way：**这一档画得出来的关系**的成员一个都不能丢
       * （环靠懒缝，成员缺了几何那块面就没了）。画不出来的关系不用保护。
       */
      const memberKeep = new Set();
      for (const rel of W.relations.values()) {
        const rt = rel.tags || {};
        if (rt.type !== 'multipolygon' && rt.type !== 'boundary') continue;
        if (!Render.detailAllows(rt, 'area', zoom)) continue;
        for (const m of rel.members || []) if (m.type === 'way') memberKeep.add(Number(m.ref));
      }
      const doomed = [];
      for (const way of W.ways.values()) {
        stats.scanned += 1;
        const tags = way.tags || {};
        // 主干道 / 次要干道 / 铁路 / 水系 / 骨架：一条都不许丢（"道路一条不缺"）
        const rank = Render.roadRank(tags);
        if (tags.railway || tags.waterway || Render.isSkeleton(tags)) { stats.keptMajor += 1; continue; }
        if (rank === 0 || (rank > 0 && rank <= 1)) { stats.keptMajor += 1; continue; }
        if (memberKeep.has(way.id)) { stats.keptRelation += 1; continue; }
        const closed = way.closed != null ? way.closed : W.isClosed(way);
        const kind = closed ? 'area' : 'line';
        const rule = Render.ruleForWay(way, kind, style);
        if (!rule) { stats.kept += 1; continue; }   // 没有样式规则的（几何碎片/关系成员）：留着，代价很小
        const ruleMin = rule.minZoom || 0;
        const ruleMax = rule.maxZoom == null ? 99 : rule.maxZoom;
        /**
         * **这一档画得出来吗**（口径与 _wayPass / lodDecision 完全一致，唯一一处判定）：
         *   · 规则可见缩放；线要素再看"道路等级门槛"（与服务端下发同一张表，roadLodAllows）；
         *   · 面要素再看分级门槛（普通建筑 z17 才出现）+ 面积 LOD（z13 ≥20000 … z19 ≥20，
         *     而且只在它真的会被画成"面"时才算 —— 与 _wayPass 的 wantsArea 同一个条件）。
         * 画得出来的 → 留着；画不出来的 → **这一档就是"用不上的细节"**（#6c）。
         */
        const ruleUsable = ruleMin <= zoom && ruleMax >= zoom;
        let drawableNow = ruleUsable;
        if (drawableNow && closed) {
          const wantsArea = rule.kind === 'fill' || rule.kind === 'both';
          drawableNow = Render.detailAllows(tags, 'area', zoom);
          if (drawableNow && wantsArea && rule.fill) {
            const minArea = Render.detailMinAreaM2(tags, zoom);
            if (minArea > 0) {
              const b0 = W.wayBBox(way);
              if (b0 && Render.bboxAreaM2(b0) < minArea) drawableNow = false;
            }
          }
        }
        if (drawableNow && kind === 'line') drawableNow = Render.roadLodAllows(tags, zoom);
        if (drawableNow) { stats.keptDrawable += 1; continue; }
        /**
         * 画不出来的几何：**眼前那一圈也一起丢**（不是"少画"，是"这一档根本用不上"）。
         * 为什么敢丢眼前的：它这一档本来就不画；放大回去时 MapData 的范围缓存会在换缩放时
         * 整批作废（mapdata.js 的 rects 规则），服务器会把完整数据重新取回来 ——
         * 所以"放大就看不到"不会发生。统计上单列 keptInView，便于对照。
         */
        const b = W.wayBBox(way);
        if (b && view && Render.boxIntersects(b, view)) stats.keptInView += 1;
        doomed.push(way.id);
      }
      stats.keptInViewNote = '画不出来的几何里，落在视野+1/4屏之内的条数（同样会被丢）';
      if (doomed.length) {
        const rep = W.dropWays(doomed, { reason: 'zoom-out-lod', zoom, keepMajorRoads: true });
        stats.dropped = (rep && rep.dropped) || 0;
        stats.keptPinned = (rep && rep.keptPinned) || 0;
        stats.keptRelation = (rep && rep.keptRelation) || 0;
        stats.missing = (rep && rep.missing) || 0;
      }
      stats.doomed = doomed.length;
      const ms = performance.now() - t0;
      Render._detailDropZoom = Math.min(zoom, lastZoom);
      Render._detailDropStamp = stamp;
      Render.dropStats = Object.assign({}, stats, {
        ms: Math.round(ms * 10) / 10, zoom: Math.min(zoom, lastZoom),
        at: Date.now(), reason: 'zoom-out-lod', trigger: zoomShrank ? 'zoom-out' : 'data-arrived',
      });
      Render.stats.detailDropWays = stats.dropped;
      Render.stats.detailDropMs = Math.round(ms * 10) / 10;
      Render.stats.detailDropZoom = zoom;
      Render.stats.detailDropKeptMajor = stats.keptMajor;
      Render.stats.detailDropReason = 'zoom-out-lod';
      return stats.dropped;
    },

    /** 上一次"缩小丢细节"的账（自检/状态栏/排查读它） */
    detailDropStats() {
      const s = Render.dropStats || {};
      return {
        zoom: s.zoom || 0, scanned: s.scanned || 0, dropped: s.dropped || 0, kept: s.kept || 0,
        doomed: s.doomed || 0, keptDrawable: s.keptDrawable || 0,
        keptMajor: s.keptMajor || 0, keptInView: s.keptInView || 0, keptPinned: s.keptPinned || 0,
        keptRelation: s.keptRelation || 0, missing: s.missing || 0,
        ms: s.ms || 0, at: s.at || 0, reason: s.reason || '',
        /** 当前缩小到哪一档之后不再清理（放大到 ≥ 它时又会允许下一次缩小清理） */
        dropZoom: Render._detailDropZoom == null ? null : Render._detailDropZoom,
      };
    },

    /**
     * 分片跑重建：**先分片收集视野内的 way，再分片画**。
     * 两个阶段都用 frameBudgetMs 做上限，所以单帧的同步工作量是有界的：
     *   · collect —— 游标每步最多 collectSliceMs（默认 2 ms），单帧累计不超过 frameBudgetMs；
     *   · ways    —— 每 sliceCheck 个要素查一次表，超了就把剩下的留给下一帧。
     */
    _runJobChunk(job) {
      if (Render._job !== job) return; // 已被更新的一次重建取代
      const t0 = performance.now();
      if (job.phase === 'collect') {
        const cur = job.wayCursor;
        let overspent = false;
        try {
          while (cur && !cur.done) {
            cur.step(Render.collectSliceMs);
            if (job.async && performance.now() - t0 > Render.frameBudgetMs) { overspent = true; break; }
          }
        } catch (err) {
          // 收集出问题也不能让地图空着：把已收集到的画出去，错误如实记账
          job.lastError = err && err.message ? err.message : String(err);
          Render.stats.lastError = job.lastError;
        }
        const spent = performance.now() - t0;
        job.collectMs = (job.collectMs || 0) + spent;
        if (overspent) {
          job.cpuMs += spent;
          job.collectPasses += 1;
          job.lastSliceAt = performance.now();
          job.passes += 1;
          Render._continueJob(job);
          return;
        }
        job.collectPasses += 1;
        job.collectRows = cur ? cur.stats.rows : 0;
        job.collectBuckets = cur ? cur.stats.buckets : 0;
        job.collectCandidates = cur ? cur.stats.candidates : 0;
        job.phase = 'ways';
        // 收集完了才做区块统计（它要遍历整张 wayList）
        Render.planBlockPass(job);
      }
      const list = job.wayList;
      let done = false;
      try {
        while (job.i < list.length) {
          const way = list[job.i++];
          if (!way.nodes.length) continue;
          Render._wayPass(job, way);
          if (job.async && (job.i & (Render.sliceCheck - 1)) === 0 && performance.now() - t0 > Render.frameBudgetMs) {
            job.cpuMs += performance.now() - t0;
            job.wayMs = (job.wayMs || 0) + (performance.now() - t0);
            job.lastSliceAt = performance.now();
            job.passes += 1;
            Render._continueJob(job);
            return;
          }
        }
        done = true;
      } catch (err) {
        // 整轮重建出问题也不能让地图空着：把错误记账，尽量把已有内容提交上去
        job.lastError = err && err.message ? err.message : String(err);
        Render.stats.lastError = job.lastError;
        done = true;
      } finally {
        const spent = performance.now() - t0;
        if (done) {
          job.cpuMs += spent;
          job.wayMs = (job.wayMs || 0) + spent;
        }
      }
      if (done) {
        try { Render._finishJob(job); } catch (err) {
          Render.stats.lastError = err && err.message ? err.message : String(err);
        }
      }
    },

    _continueJob(job) {
      const raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16);
      job.raf = raf(() => { if (Render._job === job) Render._runJobChunk(job); });
    },

    /**
     * 单个 way 的处理（规则 → 几何 → 分层绘制）。
     * 全部走缓存：样式规则、投影坐标、bbox 都只在数据/缩放变化后算一次，
     * 同一缩放下的重复重建（切图层、改显示模式、协作数据到达）几乎不用再算几何。
     */
    _wayPass(job, way) {
      const { zoom, bounds, style } = job;
      try {
        const closed = way.closed != null ? way.closed : World.isClosed(way);
        const kind = closed ? 'area' : 'line';
        const rule = Render.ruleForWay(way, kind, style);
        if (!rule) return;
        if (zoom < (rule.minZoom || 0) || zoom > (rule.maxZoom || 99)) return;
        const cat = style.categoryOf(way.tags, kind);
        if (!Render.isVisible(cat)) return;

        const geom = Render.wayGeom(way, zoom);
        if (!geom || geom.lls.length < 2) return;
        if (!bounds.contains(geom.mid)) {
          // 中点不在视野里：先用 bbox 排除（省掉逐点判断），再兜底查顶点
          const b = geom.bbox || World.wayBBox(way);
          if (b && (b.maxLat < job.bbox.minLat || b.minLat > job.bbox.maxLat
            || b.maxLon < job.bbox.minLon || b.minLon > job.bbox.maxLon)) return;
          let any = false;
          for (const c of geom.lls) if (bounds.contains(c)) { any = true; break; }
          if (!any) return;
        }
        const coords = geom.lls;
        const wantsArea = (rule.kind === 'fill' || rule.kind === 'both') && closed;
        const wantsLine = rule.kind !== 'fill' || !closed;
        const extrude = (rule.extrude || rule.layer === 'building') && closed && zoom >= Render.extrudeMinZoom;
        /** 这条要素的 bbox 与"真实视野"是否相交：要素账的"视野内"口径（画布 padding 那一圈不算） */
        const boxLL = geom.bbox || World.wayBBox(way);
        const inView = boxLL ? Render.boxIntersects(boxLL, job.viewBox) : true;

        /**
         * 道路的缩放 LOD 门槛（#6b/#6c）：**这一档服务端不会下发的等级，客户端也不再画**。
         * 放在最前面（比面积/区块都早），因为它决定"这条要素在这一档存不存在"：
         * 用同一张 ROAD_CLASS_TABLE 判，于是"从高缩放缩回来"的客户端与新客户端看到的是同一张图。
         * 闭合的道路面（环岛/广场/停车场，highway + area=yes）也一起管 —— 它们同样是道路等级，
         * 新客户端在这一档看到的是服务端合并出来的 displayAreas，不能一边有真几何一边没有。
         * 记进 detailDropped → completeness() 会把它算成"按档位不画"（roadsMissingByRoadLod），
         * 不会污染 roadsMissing。
         */
        if (way.tags && way.tags.highway && !Render.roadLodAllows(way.tags, zoom)) {
          job.roadLodSkipped = (job.roadLodSkipped || 0) + 1;
          if (job.detailDropped) job.detailDropped.add(way.id);
          if (inView) job.notDrawnInView += 1;
          return;
        }

        /**
         * 分级 + 面积门槛（**按缩放代缓存**，见 lodDecision）：
         *   · 分级只对装饰性面生效（道路/骨架永远画）；
         *   · 面积门槛来自唯一那张表（Render.AREA_LOD：z13 ≥20000 … z19 ≥20）；
         *   · 缩放一变，整代决策一起作废 —— 于是"放大/缩小时已经加载的要素也会按新门槛重判"，
         *     不会出现"半屏是老阈值、半屏是新阈值"的两套 LOD（#6c）。
         * "完整 / 全部道路"档：detailAllows 恒 true、面积门槛恒 0 —— 一块都不丢。
         */
        const areaM2 = wantsArea && rule.fill ? Render.bboxAreaM2(boxLL) : 0;
        const lod = Render.lodDecision(way, kind, rule, zoom, areaM2);
        if (!lod.allow) {
          // 只记"因为档位而没画"的装饰性面（道路/线要素永远不会走到这里）
          if (kind === 'area') {
            job.detailDroppedFills = (job.detailDroppedFills || 0) + 1;
            if (job.detailDropped) job.detailDropped.add(way.id);
          }
          if (inView) job.notDrawnInView += 1;
          return;
        }
        if (lod.tiny) {
          job.skippedTiny = (job.skippedTiny || 0) + 1;
          job.areaLodSkipped = (job.areaLodSkipped || 0) + 1;
          job.detailDroppedFills = (job.detailDroppedFills || 0) + 1;
          if (job.detailDropped) job.detailDropped.add(way.id);
          if (inView) job.notDrawnInView += 1;
          return;
        }
        // 聚焦模式：非聚焦要素淡化，聚焦要素加粗并画到最上层（铁路/公交不再被路面盖住）
        const focused = Render.focus ? Render.isFocused(way.tags) : false;
        // 道路车速 / 道路拥堵模式：道路本身是主角（按有效车速或拥堵系数染色），其余图层淡化当背景
        const speedMode = Render.displayMode === 'speed';
        const jamMode = Render.displayMode === 'congestion';
        const roadWay = speedMode && Render.isRoadTags(way.tags);
        // 拥堵模式只认机动车道：铁路/电车（railway=*）既不上拥堵色，也不当背景压暗（它跟路面拥堵无关）
        const jamWay = jamMode && Render.isCongestionRoad(way.tags);
        // "真的有数据"才换画法：取不到数据时整屏退回普通配色（连白描边都不换）
        const jamPaint = jamWay && Render.congestionReady();
        const railWay = jamMode && !!(way.tags && way.tags.railway);
        const dim = Render.focusDim(way.tags) || ((speedMode || jamMode) && !roadWay && !jamWay && !railWay);
        const focusBoost = focused ? 1.6 : 1;

        /**
         * 分块降级：这一小块（300 米区块）要素过密 → 只简化它的**装饰性面**。
         * 道路/铁路/水系/骨架（含骨架档要保留的东西）根本不会走到这里：
         *   · 线要素永远 false（blockSimplifiesFill 只对闭合面生效）；
         *   · isSkeleton 的面永远 false。
         * 所以"简化"只会让小的建筑/绿地/零散用地不画，路网一条都不会少。
         */
        const simplifiedBlock = (wantsArea && rule.fill && !Render.isSkeleton(way.tags))
          ? Render.blockSimplifiesFill(job, way) : null;
        /**
         * 分块降级（次要道路那一半）：主干道永远照画；比"这一档能留到的等级"更深的次要道路，
         * 在过密街区里不画（区块会显示阴影 + 标注 + "?"，玩家知道这块被简略了）。
         * 只对**线要素**生效；闭合的道路面（环岛/广场）走上面那条面规则，也不受这里影响。
         */
        const simplifiedRoad = (!simplifiedBlock && wantsLine && rule.stroke && !closed)
          ? Render.blockSimplifiesRoad(job, way) : null;
        if (simplifiedBlock) {
          simplifiedBlock.simplifiedFills += 1;
          job.blockSimplified += 1;
          job.skippedDegraded = (job.skippedDegraded || 0) + 1;
          if (inView) job.notDrawnInView += 1;
        } else if (simplifiedRoad) {
          simplifiedRoad.simplifiedRoads += 1;
          job.blockRoadsSimplified += 1;
          job.skippedDegraded = (job.skippedDegraded || 0) + 1;
          if (job.blockRoadSimplifyIds) job.blockRoadSimplifyIds.add(way.id);
          // 被区块简化的次要道路：连它的路面标签/名称也一起省（这一块已经写明"简略显示"了）
          simplifiedRoad.labelsSkipped += 1;
          job.blockLabelsSkipped += 1;
          if (inView) job.notDrawnInView += 1;
          return;
        } else {
          job.visibleWays.push(way);
          // 要素账：**真的画出来**的 way，且落在真实视野里（画布 padding 那一圈另记）
          if (inView) job.waysInView += 1; else job.waysOffView += 1;
          if (!Render.isSkeleton(way.tags)) job.detailShapes += 1;
          // 一个图形都没产生的（规则既没有填充也没有描边）：如实记成"没画"
          const shapes = (wantsArea && rule.fill ? 1 : 0) + (wantsLine && rule.stroke ? 1 : 0);
          if (!shapes && inView) job.notDrawnInView += 1;
        }
        if (way.tags && way.tags.highway) job.roadsInView += 1;

        if (wantsArea && rule.fill && !simplifiedBlock && extrude && !dim) {
          const height = util.buildingHeightMeters(way.tags);
          // 深度：屏幕坐标下"越靠下（越大）越近"，近的后画才能正确遮挡远方的楼。
          // 投影只做一次（wayPixels 缓存），重心与挤出共用同一批坐标。
          const px = Render.wayPixels(way, geom, zoom);
          const center = geom.center || Render.centerPixel(coords, zoom);
          const depth = center.x * VIEW.x + center.y * VIEW.y;
          const stat = { innerRings: 0, courtyardWalls: 0, roofHoles: 0, flat: 0 };
          for (const p of Render.buildExtrusion(coords, height, rule, zoom, undefined, px, undefined, stat)) {
            p.depth = depth;
            job.buildings.push(p);
          }
          job.extrudedWays += 1;
          job.flatBuildings += stat.flat;
        } else if (wantsArea && rule.fill && !simplifiedBlock) {
          // 老"精简"档（2）的低缩放小面积取舍：只在那一档生效（"完整"档一块都不丢）。
          // 道路/铁路/水系（哪怕是闭合面）一条都不筛 —— 否则 completeness().roadsMissing 会不为 0。
          const rdTags = way.tags || {};
          if (Render.clampDetail(Render.detail) === 2 && zoom < 15 && !Render.isSkeleton(way.tags)
            && !rdTags.highway && !rdTags.railway && !rdTags.waterway) {
            const bbox = geom.bbox || World.wayBBox(way);
            const areaM2 = Render.bboxAreaM2(bbox);
            const minArea = zoom <= 11 ? 400000 : zoom === 12 ? 200000 : zoom === 13 ? 80000 : zoom === 14 ? 25000 : 0;
            if (areaM2 < minArea) {
              job.skippedSmall = (job.skippedSmall || 0) + 1;
              if (job.detailDropped) job.detailDropped.add(way.id);
              return;
            }
          }
          job.fillShapes = (job.fillShapes || 0) + 1;
          job.fills.push(L.polygon(coords, {
            renderer: Render.rendererFill,
            color: rule.stroke || 'transparent',
            weight: rule.kind === 'both' ? Math.max(0.4, Render.widthAtZoom(rule, zoom) * 0.4) : (rule.strokeWeight || 0.6),
            opacity: (rule.stroke ? (rule.strokeOpacity == null ? 0.9 : rule.strokeOpacity) : 0) * (dim ? 0.25 : 1),
            fillColor: rule.fill,
            fillOpacity: (rule.fillOpacity == null ? 1 : rule.fillOpacity) * (dim ? 0.18 : 1),
            interactive: false,
          }));
        }
        if (wantsLine && rule.stroke) {
          const width = Render.widthAtZoom(rule, zoom) * (dim ? 0.7 : focusBoost);
          // 车速/拥堵模式下道路改用白色描边：彩色路面在白底上更干净，像一张热力图
          const casingSpec = (roadWay || jamPaint)
            ? { color: '#ffffff', weight: Math.max(2, (rule.casing && rule.casing.weight) || 2), opacity: 0.85 }
            : (rule.casing && rule.casing.color
              ? { color: rule.casing.color, weight: rule.casing.weight, opacity: rule.casing.opacity }
              : null);
          if (casingSpec && !(way.tags && way.tags.tunnel) && !dim) {
            Render.pushLine(job, focused ? 'focus' : 'casing', coords, {
              color: casingSpec.color,
              weight: width + (casingSpec.weight || 2),
              opacity: casingSpec.opacity == null ? 0.95 : casingSpec.opacity,
              lineCap: 'round', lineJoin: 'round',
            });
          }
          /**
           * 颜色来源（互斥，优先级从高到低）：
           *   1) 拥堵模式：按服务器给的 level / 拥堵系数上色（绿→琥珀→红）；取不到数据的那条交回普通配色；
           *   2) 车速模式：按"有效限速"上蓝红色；
           *   3) 其它：样式表的路面色。
           */
          const jamColor = jamWay ? Render.congestionColorFor(way) : null;
          const coreColor = jamColor || (roadWay ? Render.colorForSpeed(Render.effectiveSpeedKph(way.tags)) : rule.stroke);
          if (roadWay) job.speedRoads += 1;
          if (jamWay) {
            job.congestionRoads += 1;
            if (jamColor) job.congestionColored += 1;
          }          Render.pushLine(job, focused ? 'focus' : 'core', coords, {
            color: coreColor,
            weight: width,
            opacity: (rule.opacity == null ? 1 : rule.opacity) * (dim ? 0.22 : 1),
            dashArray: rule.dash ? (Array.isArray(rule.dash) ? rule.dash.join(' ') : rule.dash) : null,
            lineCap: rule.dash ? 'butt' : 'round', lineJoin: 'round',
          });
          if (way.tags && way.tags.highway && !dim) job.roadsDrawn += 1;
        }
        // 标签属于"装饰性内容"：区块被简略显示时，这一块的面标签也一起省掉（道路名/骨架标签不受影响，
        // 因为道路根本不是"被简化的面"）
        if (simplifiedBlock) {
          simplifiedBlock.labelsSkipped += 1;
          job.blockLabelsSkipped += 1;
        } else {
          Render.collectLabel(way.tags, coords, rule, zoom, cat, false, job);
        }
      } catch (err) {
        job.skipped += 1;
        if (!job.lastError) job.lastError = err && err.message ? err.message : String(err);
      }
    },

    /**
     * 低缩放合并折线（服务端 `payload.displayLines`）的绘制趟。
     *
     * 为什么单独一趟而不是塞进 `_wayPass`：它们**没有 way id、没有节点**（坐标是内联的），
     * 也就没有空间索引、不能拾取、不参与"道路一条不缺"的分母 —— 走 way 那条路会把账算乱。
     *
     * 画法**完全走同一套样式规则**（`Render.ruleForWay` → `Style.ruleFor(tags,'line')` → `decorate`）：
     * 服务端下发的 `tags` 是"这一组 way 的渲染相关标签"，而分组时用的就是"精确样式类"，
     * 所以同一条折线拿到的颜色/宽度/虚线/描边与合并前逐条画**逐字段相同**。
     * 线宽按屏幕像素给，所以放大之后细路依旧细 —— 与 way 那条路一致。
     *
     * 不参与的两件事（明确口径）：
     *   · **拾取/编辑**：没有 id，选不中也改不了。低缩放本来就只有"看"的语义
     *     （服务端在 z ≥ coalesce.minZoom 时一条都不合并，真 way id 全部照旧下发）；
     *   · **车速/拥堵染色**：那两种模式要靠 way id 去查数据，低缩放没有 id，所以折线按普通配色画。
     *     聚焦模式（focus）仍然照常淡化非聚焦要素。
     */
    _displayLinePass(job) {
      const list = job.displayList;
      if (!list || !list.length) return;
      const { zoom, style, bounds, bbox } = job;
      const t0 = performance.now();
      for (const line of list) {
        try {
          const tags = line.tags || null;
          if (!tags) { job.displayLinesByRule += 1; continue; }
          job.displayLinesInView += 1;
          const rule = Render.ruleForWay(line, 'line', style);
          if (!rule || !rule.stroke) { job.displayLinesByRule += 1; continue; }
          if (zoom < (rule.minZoom || 0) || zoom > (rule.maxZoom || 99)) { job.displayLinesByRule += 1; continue; }
          const cat = style.categoryOf(tags, 'line');
          if (!Render.isVisible(cat)) { job.displayLinesByRule += 1; continue; }
          const paths = [line.coords].concat(line.paths || []);
          // 视野判断：一条折线可能很长（横穿全城），只要与视野相交就画（Leaflet 自己会裁）
          const b = line._bbox || (World.displayLineBox ? World.displayLineBox(line) : null);
          if (b && (b.maxLat < bbox.minLat || b.minLat > bbox.maxLat
            || b.maxLon < bbox.minLon || b.minLon > bbox.maxLon)) { job.displayLinesByRule += 1; continue; }
          const focused = Render.focus ? Render.isFocused(tags) : false;
          const dim = Render.focusDim(tags);
          const width = Render.widthAtZoom(rule, zoom) * (dim ? 0.7 : (focused ? 1.6 : 1));
          const casingSpec = (rule.casing && rule.casing.color)
            ? { color: rule.casing.color, weight: rule.casing.weight, opacity: rule.casing.opacity }
            : null;
          let drew = 0;
          for (const path of paths) {
            if (!path || path.length < 2) continue;
            if (casingSpec && !(tags && tags.tunnel) && !dim) {
              Render.pushLine(job, focused ? 'focus' : 'casing', path, {
                color: casingSpec.color,
                weight: width + (casingSpec.weight || 2),
                opacity: casingSpec.opacity == null ? 0.95 : casingSpec.opacity,
                lineCap: 'round', lineJoin: 'round',
              });
            }
            Render.pushLine(job, focused ? 'focus' : 'core', path, {
              color: rule.stroke,
              weight: width,
              opacity: (rule.opacity == null ? 1 : rule.opacity) * (dim ? 0.22 : 1),
              dashArray: rule.dash ? (Array.isArray(rule.dash) ? rule.dash.join(' ') : rule.dash) : null,
              lineCap: rule.dash ? 'butt' : 'round', lineJoin: 'round',
            });
            drew += 1;
            job.displayLinePoints += path.length;
          }
          if (!drew) { job.displayLinesByRule += 1; continue; }
          job.displayLinesDrawn += 1;
          job.displayLinePaths += drew;
          // 标签：一条折线一条标签（合并前是"每条 way 一个标签"，低缩放下会糊成一片）
          Render.collectLabel(tags, paths[0], rule, zoom, cat, false, job);
        } catch (err) {
          job.skipped += 1;
          if (!job.lastError) job.lastError = err && err.message ? err.message : String(err);
        }
      }
      job.displayLineMs = (job.displayLineMs || 0) + (performance.now() - t0);
    },

    /**
     * 低缩放合并面（服务端 `payload.displayAreas`）的绘制趟。
     *
     * 与 `_displayLinePass` **完全对称**：没有 way id、没有节点（坐标内联），所以不走 way 那条路
     * （不参与"道路一条不缺"的分母、不能被拾取）。区别只有画法：
     *   · 一条 displayArea 的 `coords` 是第一个环，`paths` 是同一组的其余环（面关系的接龙环也在里面）；
     *   · **闭合环 → 按样式规则填充**（`fillRule: 'evenodd'`：面关系的 inner 环据此挖出天井/湖心岛）；
     *   · **没闭合的环 → 只画描边**（接不上的岸线/边界段）：宁可少填一块，也绝不把断开的岸线
     *     填成一个三角形（服务端 `_coalesceAreas` 的说明里有这条口径）；
     *   · 样式规则为"线"的面（环岛、闭合的边界环）：闭不闭合都按线画，与 way 那条路一致。
     */
    _displayAreaPass(job) {
      const list = job.displayAreaList;
      if (!list || !list.length) return;
      const { zoom, style, bbox } = job;
      const t0 = performance.now();
      for (const area of list) {
        try {
          const tags = area.tags || null;
          if (!tags) { job.displayAreasByRule += 1; continue; }
          job.displayAreasInView += 1;
          const rule = Render.ruleForWay(area, 'area', style);
          if (!rule) { job.displayAreasByRule += 1; continue; }
          if (zoom < (rule.minZoom || 0) || zoom > (rule.maxZoom || 99)) { job.displayAreasByRule += 1; continue; }
          const cat = style.categoryOf(tags, 'area');
          if (!Render.isVisible(cat)) { job.displayAreasByRule += 1; continue; }
          // 视野判断：一个分组可能横跨全城（同一类的小水面合成一条），只要与视野相交就画（Leaflet 自己裁）
          const b = area._bbox || (World.displayLineBox ? World.displayLineBox(area) : null);
          if (b && (b.maxLat < bbox.minLat || b.minLat > bbox.maxLat
            || b.maxLon < bbox.minLon || b.minLon > bbox.maxLon)) { job.displayAreasByRule += 1; continue; }
          const rawRings = [area.coords].concat(area.paths || []);
          const focused = Render.focus ? Render.isFocused(tags) : false;
          const dim = Render.focusDim(tags);
          const wantFill = !!(rule.fill && rule.kind !== 'line');
          const closed = [];
          const open = [];
          for (const ring of rawRings) {
            if (!ring || ring.length < 2) continue;
            const isClosed = ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
            if (isClosed && wantFill) closed.push(ring); else open.push(ring);
          }
          let drew = 0;
          let ringsDrawn = 0;
          if (closed.length) {
            job.fillShapes = (job.fillShapes || 0) + 1;
            job.fills.push(L.polygon(closed, {
              renderer: Render.rendererFill,
              color: rule.stroke || 'transparent',
              weight: rule.strokeWeight || 0.6,
              opacity: (rule.stroke ? 0.9 : 0) * (dim ? 0.25 : 1),
              fillColor: rule.fill,
              fillOpacity: (rule.fillOpacity == null ? 0.9 : rule.fillOpacity) * (dim ? 0.18 : 1),
              fillRule: 'evenodd',     // 内环（天井 / 湖心岛）据此挖洞
              interactive: false,
            }));
            drew += closed.length;
            ringsDrawn += closed.length;
            for (const ring of closed) job.displayAreaPoints += ring.length;
          }
          // 开放环 / "线"规则的面 / 只描边的规则：按线画（宽度与 way 那条路同一套 widthAtZoom）
          const lineRings = wantFill ? open : closed.concat(open);
          if (lineRings.length && (rule.stroke || wantFill)) {
            const width = Render.widthAtZoom(rule, zoom) * (dim ? 0.7 : (focused ? 1.6 : 1));
            const color = rule.stroke || rule.fill;
            const casingSpec = (rule.casing && rule.casing.color) ? rule.casing : null;
            for (const ring of lineRings) {
              if (ring.length < 2) continue;
              if (casingSpec && !(tags && tags.tunnel) && !dim) {
                Render.pushLine(job, focused ? 'focus' : 'casing', ring, {
                  color: casingSpec.color,
                  weight: width + (casingSpec.weight || 2),
                  opacity: casingSpec.opacity == null ? 0.95 : casingSpec.opacity,
                  lineCap: 'round', lineJoin: 'round',
                });
              }
              Render.pushLine(job, focused ? 'focus' : 'core', ring, {
                color,
                weight: wantFill ? Math.max(0.6, width * 0.8) : width,
                opacity: (rule.opacity == null ? 1 : rule.opacity) * (dim ? 0.22 : 1),
                dashArray: rule.dash ? (Array.isArray(rule.dash) ? rule.dash.join(' ') : rule.dash) : null,
                lineCap: rule.dash ? 'butt' : 'round', lineJoin: 'round',
              });
              drew += 1;
              ringsDrawn += 1;
              job.displayAreaPoints += ring.length;
            }
          }
          if (!drew) { job.displayAreasByRule += 1; continue; }
          job.displayAreasDrawn += 1;
          job.displayAreaRings += ringsDrawn;
          if (open.length) job.displayAreaOpenRings += open.length;
          // 标签：一条面条目一个标签（与折线那条口径一致）
          Render.collectLabel(tags, rawRings[0], rule, zoom, cat, true, job);
        } catch (err) {
          job.skipped += 1;
          if (!job.lastError) job.lastError = err && err.message ? err.message : String(err);
        }
      }
      job.displayAreaMs = (job.displayAreaMs || 0) + (performance.now() - t0);
    },

    /**
     * 样式规则缓存：同一个 way 在同一份标签上只求一次样式（ruleFor 每次都新建对象，很贵）。
     *
     * 缓存键用**标签对象的身份**（way.tags）而不是数据版本号：拖动时每一块视口数据到达
     * 都会让 dataStamp +1，用版本号当键等于"每合并一块，全屏的样式全部重算一遍"
     * （几万次 ruleFor，正是拖动时 rebuild 里最贵的一段）。
     * mergePayload 只在服务器真的下发了新标签时才换 way.tags 对象，所以身份比较是准的。
     */
    ruleForWay(way, kind, style) {
      if (way._ruleTagsRef === way.tags && way._ruleKind === kind) return way._rule;
      let rule = style.ruleFor(way.tags, kind);
      if (!rule && kind === 'area') rule = style.ruleFor(way.tags, 'line');
      if (!rule) rule = Render.fallbackRule(way.tags);
      way._rule = rule || null;
      way._ruleKind = kind;
      way._ruleTagsRef = way.tags;
      way._ruleStamp = World.dataStamp || 0;
      return way._rule;
    },

    /**
     * 几何缓存：投影一次，多处复用（原来同一条路的坐标要被投影两遍：
     * 一遍求重心、一遍挤出；点对象还都是新建的）。
     * 失效条件是"几何版本"而不是"数据版本"：分块数据到达只改标签/版本号时，
     * 已经算好的坐标可以继续用（省掉每次合并后的整屏重新建坐标）。
     * 返回 { lls: [[lat,lon],...], mid, bbox, px|null }。
     */
    wayGeom(way, zoom) {
      const stamp = World.geomStamp || 0;
      const g = way._geom;
      if (g && g.stamp === stamp && g.z === zoom) return g;
      const lls = [];
      let missing = false;
      for (const nid of way.nodes) {
        const n = World.nodes.get(nid);
        if (!n) { missing = true; continue; }
        if (!Number.isFinite(n.lat) || !Number.isFinite(n.lon)) continue;
        lls.push([n.lat, n.lon]);
      }
      /**
       * 缺节点 = "way 先到、节点在隔壁瓦片里"：登记一笔，节点到了会被 _refreshIncompleteWays
       * 自动作废重算（否则这条 way 会拿着"缺点"的几何永远画不出来 —— 画面上就是永久少一块）。
       */
      if (missing) {
        way._incomplete = true;
        if (World._incompleteWays) World._incompleteWays.add(way);
      } else {
        way._incomplete = false;
        if (World._incompleteWays) World._incompleteWays.delete(way);
      }
      const out = {
        stamp, z: zoom, lls,
        mid: lls.length ? lls[Math.floor(lls.length / 2)] : null,
        bbox: World.wayBBox(way),
        px: null,
        center: null,
      };
      way._geom = out;
      return out;
    },

    /** 世界像素坐标（只跟缩放有关，跟平移无关）——挤出时用，缓存起来不重复投影 */
    wayPixels(way, geom, zoom) {
      if (geom.px) return geom.px;
      const map = Render.map;
      const pts = new Array(geom.lls.length);
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < geom.lls.length; i++) {
        const ll = geom.lls[i];
        const p = map.project(L.latLng(ll[0], ll[1]), zoom);
        pts[i] = p;
        cx += p.x;
        cy += p.y;
      }
      geom.px = pts;
      geom.center = pts.length ? { x: cx / pts.length, y: cy / pts.length } : null;
      return pts;
    },

    /** 线的批处理：同色同宽同透明度合成一个多段 polyline（几万条路 → 几十个对象） */
    pushLine(job, layer, coords, opts) {
      const key = layer + '|' + (opts.color || '') + '|' + opts.weight + '|' + opts.opacity + '|' + (opts.dashArray || '') + '|' + opts.lineCap + '|' + opts.lineJoin;
      let bucket = job.buckets.get(key);
      if (!bucket) {
        bucket = { layer, opts, paths: [], n: 0 };
        job.buckets.set(key, bucket);
      }
      bucket.paths.push(coords);
      bucket.n += 1;
      // 一个对象里塞太多子路径会让 Leaflet 单次绘制过重：分批成多个对象
      if (bucket.paths.length >= Render.batchSize) Render.flushBucket(job, bucket);
    },

    /** 把一个批次的子路径变成一个 Leaflet 多段 polyline */
    flushBucket(job, bucket) {
      if (!bucket.paths.length) return;
      const target = bucket.layer === 'focus' ? job.focusShapes
        : bucket.layer === 'casing' ? job.casings : job.cores;
      target.push(L.polyline(bucket.paths, Object.assign({
        renderer: bucket.layer === 'focus' ? Render.rendererFocus
          : bucket.layer === 'casing' ? Render.rendererCasing : Render.rendererCore,
        interactive: false,
      }, bucket.opts)));
      bucket.paths = [];
      job.batches += 1;
    },

    /** POI：带标签的独立节点。只遍历"带标签且在视野里"的节点（空间索引） */
    _nodePass(job) {
      const { zoom, style } = job;
      const list = World.queryTaggedNodes(job.bbox, Render._nodeQuery || (Render._nodeQuery = []));
      for (const node of list) {
        if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon)) continue;
        /**
         * 视野框（含 12% 画布 padding）之外的一律不画、也不算要素。
         * 为什么必须在这里再筛一遍：节点空间索引的格子是**按经纬度分桶**的（一格比一屏还大），
         * 查询只保证"这一格"命中 —— z19 实测一次查询会拿回 130 个 POI，其中真正在屏幕上的只有 4 个，
         * 另外 126 个既进 stats.features 又照样画到覆盖画布上（#6a 的"看不见的要素"）。
         */
        if (!(node.lat >= job.bbox.minLat && node.lat <= job.bbox.maxLat
          && node.lon >= job.bbox.minLon && node.lon <= job.bbox.maxLon)) {
          job.nodeOutOfViewSkipped += 1;
          continue;
        }
        try {
          const rule = style.ruleFor(node.tags, 'point') || Render.fallbackRule(node.tags);
          if (!rule) continue;
          if (zoom < (rule.minZoom || 0) || zoom > (rule.maxZoom || 99)) continue;
          if (!Render.detailAllows(node.tags, 'point', zoom)) continue;
          const cat = style.categoryOf(node.tags, 'point');
          if (!Render.isVisible(cat)) continue;
          // 分块降级：POI 图标 + 标签也是装饰性内容，所在区块被简略显示时就不画（注释里会说明）
          const simplifiedBlock = Render.blockSimplifiesPoint(job, node);
          if (simplifiedBlock) {
            simplifiedBlock.simplifiedPoints += 1;
            job.blockPointsSimplified += 1;
            if (Render.containsLL(job.viewBox, node.lat, node.lon)) job.notDrawnInView += 1;
            continue;
          }
          job.visibleNodes.push(node);
          if (Render.containsLL(job.viewBox, node.lat, node.lon)) job.nodesInView += 1; else job.nodesOffView += 1;
          job.detailShapes += 1;
          Render.collectLabel(node.tags, [[node.lat, node.lon]], rule, zoom, cat, true, job);
        } catch (err) {
          job.skipped += 1;
          if (!job.lastError) job.lastError = err.message;
        }
      }
    },

    /** 点是否落在经纬度矩形里（要素账用；node 用 lat/lon 而不是 lng） */
    containsLL(box, lat, lon) {
      return !!box && lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
    },

    /**
     * 关系（多面体）：外环填充 + 内环挖洞；**建筑类多面体在 z≥17 时和普通闭合建筑一样走 2.5D 挤出**，
     * 内环（role=inner）就是天井 —— 屋顶 evenodd 挖洞、四面画朝院子里的墙。
     * 环由 World.ringsOf() 懒缝（成员 way 常被拆成好几条，按共享节点 id 接龙）。
     *
     * ⚠ 2026-09 修正（#6a）：**先按视野筛一遍**。
     * 以前这一趟遍历 `World.relations.values()` 全表、**没有任何视野判断** ——
     * 实测 z19 视口里一个关系都不在，却把本地缓存的 87 个多面体全部推进 `visibleRelations`
     * 并逐个建了 Leaflet 多边形（既进"要素数"，又白画）。
     * 现在用 `World.relationBBox`（成员 way 的 bbox 合并，已有缓存）与视野框求交，
     * 不在视野里的直接跳过 —— 视野内的关系一个不少（"面一块不缺"由 completeness() 的
     * areasMissingUnexpected 依旧守 0）。
     */
    _relationPass(job) {
      const { zoom, style } = job;
      for (const rel of World.relations.values()) {
        try {
          const tags = rel.tags || {};
          if (tags.type !== 'multipolygon' && tags.type !== 'boundary') continue;
          const rule = style.ruleFor(tags, 'area');
          if (!rule || !rule.fill) continue;
          if (zoom < (rule.minZoom || 0) || zoom > (rule.maxZoom || 99)) continue;
          if (!Render.detailAllows(tags, 'area', zoom)) continue;
          const cat = style.categoryOf(tags, 'area');
          if (!Render.isVisible(cat)) continue;
          /** 视野（含画布 padding）之外的整块跳过：不画、也不进要素账 */
          const rbox = World.relationBBox(rel);
          if (rbox && !Render.boxIntersects(rbox, job.bbox)) {
            job.relationOutOfViewSkipped += 1;
            continue;
          }
          /**
           * 面（多面体）的面积 LOD：与普通闭合面**用同一张表**（Render.AREA_LOD）。
           * 面积按关系的经纬度 bbox 估（与 way 那条口径一致：都是 bbox 面积，不是真实多边形面积）。
           */
          const relAreaM2 = rbox ? Render.bboxAreaM2(rbox) : 0;
          const minArea = Render.detailMinAreaM2(tags, zoom);
          if (minArea > 0 && relAreaM2 > 0 && relAreaM2 < minArea) {
            job.areaLodRelationSkipped += 1;
            if (rbox && Render.boxIntersects(rbox, job.viewBox)) job.notDrawnInView += 1;
            continue;
          }
          const rings = World.ringsOf('relation', rel.id);
          let outers = rings.outers;
          let inners = rings.inners;
          /**
           * 环没缝出来时（成员 way 之间不共享节点 —— 真实数据里主要出现在少数边界关系上）
           * 退回"每条成员 way 都是一圈"的老办法，至少把东西画出来。
           * 这条退路**不挤出**：碎片被当成一圈圈去挤出只会得到翻折的乱片。
           */
          const stitched = outers.length > 0;
          if (!stitched) {
            job.relationFallbacks = (job.relationFallbacks || 0) + 1;
            outers = [];
            inners = [];
            for (const m of rel.members) {
              if (m.type !== 'way') continue;
              const way = World.getWay(m.ref);
              const g = way ? Render.wayGeom(way, zoom) : null;
              if (!g || g.lls.length < 3) continue;
              (m.role === 'inner' ? inners : outers).push(g.lls);
            }
          }
          if (!outers.length) continue;
          const extrude = stitched && (rule.extrude || rule.layer === 'building') && zoom >= Render.extrudeMinZoom;
          const focused = Render.focus ? Render.isFocused(tags) : false;
          /**
           * 拥堵模式下"道路是主角"：多面体里的非道路面（小绿地、场地…）压暗当背景。
           * 建筑照常画（它要挤出）；骨架面（水系/大片用地/边界）永远不压暗。
           * 车速模式保持原样（不加压暗），避免改变已有观感。
           */
          const dim = Render.focusDim(tags)
            || (Render.displayMode === 'congestion' && !Render.isSkeleton(tags) && !tags.building && !tags['building:part']);
          if (extrude && !dim) {
            const height = util.buildingHeightMeters(tags);
            for (const outer of outers) {
              const { pts: px, center } = Render.ringPixels(outer, zoom);
              if (px.length < 3) continue;
              // 天井只认"落在这个外环里"的内环：一个关系里可能有好几栋楼，洞不能乱挖到别人头上
              const { holes, pxHoles } = Render.courtyardRings(outer, inners, zoom);
              const depth = center ? center.x * VIEW.x + center.y * VIEW.y : 0;
              const stat = { innerRings: 0, courtyardWalls: 0, roofHoles: 0, flat: 0 };
              for (const p of Render.buildExtrusion(outer, height, rule, zoom, holes, px, pxHoles, stat)) {
                if (!p) continue;
                p.depth = depth;
                job.buildings.push(p);
              }
              job.extrudedRelations += 1;
              job.innerRings += stat.innerRings || 0;
              job.courtyardWalls += stat.courtyardWalls || 0;
              job.roofHoles += stat.roofHoles || 0;
              job.flatBuildings += stat.flat || 0;
            }
          } else {
            job.fillShapes = (job.fillShapes || 0) + 1;
            job.fills.push(L.polygon([outers.concat(inners)], {
              renderer: Render.rendererFill,
              color: rule.stroke || 'transparent',
              weight: rule.strokeWeight || 0.6,
              opacity: (rule.stroke ? 0.9 : 0) * (dim ? 0.25 : 1),
              fillColor: rule.fill,
              fillOpacity: (rule.fillOpacity == null ? 0.9 : rule.fillOpacity) * (dim ? 0.18 : 1),
              fillRule: 'evenodd',
              interactive: false,
            }));
          }
          job.visibleRelations.push(rel);
          if (rbox && Render.boxIntersects(rbox, job.viewBox)) job.relsInView += 1; else job.relsOffView += 1;
          Render.collectLabel(tags, outers[0], rule, zoom, cat, false, job);
        } catch (err) {
          job.skipped += 1;
          if (!job.lastError) job.lastError = err.message;
        }
      }
    },

    /** 一圈坐标 → 世界像素点 + 重心（只投影一次；挤出与深度排序共用） */
    ringPixels(coords, zoom) {
      const pts = [];
      let cx = 0;
      let cy = 0;
      const map = Render.map;
      for (const c of coords || []) {
        const ll = util.toObj(c);
        if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) continue;
        if (Math.abs(ll.lat) > 90 || Math.abs(ll.lng) > 180) continue;
        const p = map.project(L.latLng(ll.lat, ll.lng), zoom);
        pts.push(p);
        cx += p.x;
        cy += p.y;
      }
      return { pts, center: pts.length ? { x: cx / pts.length, y: cy / pts.length } : null };
    },

    /**
     * 挑出"落在这个外环里"的天井（并按屏幕坐标投影好），省掉后续重复投影。
     * 用经纬度 bbox 包含来判定（便宜、够用）：一个多面体关系里可能有好几栋楼，
     * 每栋楼的洞必须只挖自己那块，否则洞会跑到别的楼身上去。
     */
    courtyardRings(outerCoords, innerRings, zoom) {
      if (!innerRings || !innerRings.length) return { holes: [], pxHoles: [] };
      const ob = Render.coordBBox(outerCoords);
      const holes = [];
      const pxHoles = [];
      for (const h of innerRings) {
        const hb = Render.coordBBox(h);
        if (!ob || !hb) continue;
        if (hb.minLat < ob.minLat || hb.maxLat > ob.maxLat || hb.minLon < ob.minLon || hb.maxLon > ob.maxLon) continue;
        const { pts } = Render.ringPixels(h, zoom);
        if (pts.length < 3) continue;
        holes.push(h);
        pxHoles.push(pts);
      }
      return { holes, pxHoles };
    },

    /** 一串经纬度坐标的 bbox（{minLat,maxLat,minLon,maxLon}，取不到返回 null） */
    coordBBox(coords) {
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      let n = 0;
      for (const c of coords || []) {
        const ll = util.toObj(c);
        if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) continue;
        n += 1;
        if (ll.lat < minLat) minLat = ll.lat;
        if (ll.lat > maxLat) maxLat = ll.lat;
        if (ll.lng < minLon) minLon = ll.lng;
        if (ll.lng > maxLon) maxLon = ll.lng;
      }
      return n ? { minLat, maxLat, minLon, maxLon } : null;
    },

    /** 建筑深度排序：桶排序（按 8 像素分层），几万个面也是线性的，不再每次比较函数调用 */
    sortByDepth(list) {
      if (list.length < 2) return;
      const BAND = 8;
      let min = Infinity;
      for (const it of list) { const d = it.depth || 0; if (d < min) min = d; }
      const buckets = new Map();
      for (const it of list) {
        const k = Math.floor(((it.depth || 0) - min) / BAND);
        let arr = buckets.get(k);
        if (!arr) { arr = []; buckets.set(k, arr); }
        arr.push(it);
      }
      const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
      let i = 0;
      for (const k of keys) {
        const arr = buckets.get(k);
        for (const it of arr) list[i++] = it;
      }
    },

    /** 收尾：POI/关系 → 批次落地 → 排序 → 一次性提交 → 统计 */
    _finishJob(job) {
      if (job.done) return;
      job.done = true;
      const tNode = performance.now();
      Render._nodePass(job);
      job.nodeMs = performance.now() - tNode;
      const tRel = performance.now();
      Render._relationPass(job);
      job.relationMs = performance.now() - tRel;
      // 低缩放合并折线：在 way/关系之后、flush 之前画进同一批 bucket（同色同宽合成一笔画）
      Render._displayLinePass(job);
      // 低缩放合并面：填充进 fills、没闭合的环进 bucket（与折线同一批 flush）
      Render._displayAreaPass(job);
      for (const bucket of job.buckets.values()) Render.flushBucket(job, bucket);
      job.buckets.clear();
      Render.sortByDepth(job.buildings);
      const tCommit = performance.now();
      Render._commit(job);
      job.commitMs = performance.now() - tCommit;
      Render.markFirstCommit();

      Render._visibleWays = job.visibleWays;
      Render._visibleNodes = job.visibleNodes;
      Render._visibleRelations = job.visibleRelations;
      /** 这一帧真的画出来的低缩放合并折线（completeness 的账本） */
      Render._visibleDisplayLines = job.displayLinesDrawn || 0;
      Render._displayLineStats = {
        inView: job.displayLinesInView || 0,
        drawn: job.displayLinesDrawn || 0,
        paths: job.displayLinePaths || 0,
        points: job.displayLinePoints || 0,
        byRule: job.displayLinesByRule || 0,
        ms: Math.round(job.displayLineMs || 0),
      };
      /** 这一帧真的画出来的低缩放合并面（completeness 的账本） */
      Render._visibleDisplayAreas = job.displayAreasDrawn || 0;
      Render._displayAreaStats = {
        inView: job.displayAreasInView || 0,
        drawn: job.displayAreasDrawn || 0,
        rings: job.displayAreaRings || 0,
        openRings: job.displayAreaOpenRings || 0,
        points: job.displayAreaPoints || 0,
        byRule: job.displayAreasByRule || 0,
        ms: Math.round(job.displayAreaMs || 0),
      };
      Render._labels = job.labels;
      Render._labelsSorted = null;   // 标签排序推迟到覆盖画布绘制时做一次
      /** 这一帧"因为档位而不是因为丢数据"没画的面（completeness 的账本） */
      Render._detailDroppedIds = job.detailDropped || null;
      /** 这一帧"因为区块过密而没画"的次要道路（completeness 的账本，与上面那条严格分开） */
      Render._blockRoadSimplifyIds = job.blockRoadSimplifyIds || null;

      // 分块降级：只保留"真的简化掉了东西"的区块（数出来很密但一个都没简化的不算"已简略显示"）
      Render._degraded = (job.degraded || []).filter((r) => (r.simplifiedFills + r.simplifiedPoints + (r.simplifiedRoads || 0)) > 0);
      Render._degradedKeys = job.degradedKeys || null;
      Render._blockGridUsed = job.blockGrid || null;
      Render._blockZoom = job.zoom;
      /** 密度统计的原始表（blockCountStats() 拿它算真实分布的分位） */
      Render._blockCounts = job.blockCounts || null;
      /** 被简略的街区的合计明细（小面/POI/次要道路：数到多少、真的会画多少、省掉多少） */
      let bdFills = 0;
      let bdPoints = 0;
      let bdRoads = 0;
      let bdDrawn = 0;
      let bdHidden = 0;
      let bdSFills = 0;
      let bdSPoints = 0;
      let bdSRoads = 0;
      for (const r of Render._degraded) {
        bdFills += r.nFills || 0;
        bdPoints += r.nPoints || 0;
        bdRoads += r.nRoads || 0;
        bdDrawn += r.nDrawn || 0;
        bdHidden += r.nHidden || 0;
        bdSFills += r.simplifiedFills || 0;
        bdSPoints += r.simplifiedPoints || 0;
        bdSRoads += r.simplifiedRoads || 0;
      }
      /** 这一趟参与密度统计的要素里，真的会画的 / 本来就画不出的（#6a 的门槛口径） */
      let countedDrawn = 0;
      let countedHidden = 0;
      if (job.blockCounts) {
        for (const rec of job.blockCounts.values()) { countedDrawn += rec.nDrawn || 0; countedHidden += rec.nHidden || 0; }
      }
      Render._blockStats = {
        zoom: job.zoom,
        threshold: job.blockThreshold || 0,
        thresholdRaw: job.blockThresholdRaw || job.blockThreshold || 0,
        visibleFrac: job.blockVisibleFrac == null ? 1 : job.blockVisibleFrac,
        keepAreaM2: job.blockKeepArea || 0,
        blocks: job.blockCounted || 0,
        hot: job.blockHot || 0,
        features: job.blockFeatures || 0,
        featuresDrawn: countedDrawn,
        featuresHidden: countedHidden,
        simplifiedFills: job.blockSimplified || 0,
        simplifiedPoints: job.blockPointsSimplified || 0,
        simplifiedRoads: job.blockRoadsSimplified || 0,
        roadKeep: job.blockRoadKeep || 0,
        budget: job.blockBudget || 0,
        byBudget: job.blockByBudget || 0,
        degradedFeatures: job.blockDegradedFeatures || 0,
        labelsSkipped: job.blockLabelsSkipped || 0,
        degraded: Render._degraded.length,
        /** 被简略的街区合计（明细）：给状态栏/注释 tooltip 用 */
        breakdown: Render._degraded.length ? {
          blocks: Render._degraded.length,
          countedDrawn: bdDrawn, countedHidden: bdHidden,
          countedFills: bdFills, countedPoints: bdPoints, countedRoads: bdRoads,
          simplifiedFills: bdSFills, simplifiedPoints: bdSPoints, simplifiedRoads: bdSRoads,
          threshold: job.blockThreshold || 0,
          thresholdScaled: job.blockThresholdScaled || 0,
          visibleFrac: job.blockVisibleFrac == null ? 1 : job.blockVisibleFrac,
        } : null,
        error: job.blockError || null,
      };

      const st = Render.stats;
      /**
       * 要素账（#6a）：**报的就是"这一档真的画在这个视野里的东西"**。
       *   · featuresInView —— 视野内真的画出来的 way + POI + 多面体关系；
       *   · featuresOffView—— 被画了但落在视野外的（画布 padding 那一圈：正常，量很小）；
       *   · featuresNotDrawn—— 过了视野但一个图形都没产生的（面积 LOD / 样式没描边没填充 / 区块简化）；
       *   · featuresLoaded —— 本地缓存总数（背景信息：以前状态栏把它当成"视野内"报出来，
       *                       于是 z19 上会报 2.6 万，而屏幕上只有几百个图形）。
       */
      const inViewTotal = job.waysInView + job.nodesInView + job.relsInView;
      st.features = inViewTotal;
      st.featuresInView = inViewTotal;
      st.featuresOffView = job.waysOffView + job.nodesOffView + job.relsOffView;
      st.featuresNotDrawn = job.notDrawnInView || 0;
      st.featuresWaysInView = job.waysInView;
      st.featuresNodesInView = job.nodesInView;
      st.featuresRelsInView = job.relsInView;
      st.featuresWaysOffView = job.waysOffView;
      st.featuresNodesOffView = job.nodesOffView;
      st.featuresRelsOffView = job.relsOffView;
      try {
        const c = World.counts();
        st.featuresLoaded = (c.nodes || 0) + (c.ways || 0) + (c.relations || 0);
      } catch { st.featuresLoaded = 0; }
      st.areaLodSkipped = job.areaLodSkipped || 0;
      st.areaLodRelationSkipped = job.areaLodRelationSkipped || 0;
      st.areaLodM2 = Math.round(Render.areaMinM2(job.zoom) || 0);
      st.nodeOutOfViewSkipped = job.nodeOutOfViewSkipped || 0;
      st.relationOutOfViewSkipped = job.relationOutOfViewSkipped || 0;
      /** 这一趟因为"道路等级门槛"（与服务端同一张表）没画的道路条数与当时的门槛 */
      st.roadLodSkipped = job.roadLodSkipped || 0;
      st.roadLodMinRank = Render.roadLodMinRank(job.zoom);
      st.roadLodMinRankName = Render.roadRankName(st.roadLodMinRank);
      st.drawn = job.fills.length + job.buildings.length + job.casings.length + job.cores.length + job.focusShapes.length;
      st.buildings = job.buildings.length;
      st.fills = job.fills.length;
      st.fillShapes = job.fillShapes || 0;
      st.focusShapes = job.focusShapes.length;
      st.batches = job.batches;
      st.roadsInView = job.roadsInView;
      st.roadsDrawn = job.roadsDrawn;
      st.roadsMissing = Math.max(0, job.roadsInView - job.roadsDrawn);
      // 低缩放合并折线：进来/画出来/路径段/点数（它们不参与 roadsMissing 的分母，单独记账）
      st.displayLinesInView = job.displayLinesInView || 0;
      st.displayLinesDrawn = job.displayLinesDrawn || 0;
      st.displayLinePaths = job.displayLinePaths || 0;
      st.displayLinePoints = job.displayLinePoints || 0;
      st.displayLinesByRule = job.displayLinesByRule || 0;
      st.displayLineMs = Math.round(job.displayLineMs || 0);
      // 低缩放合并面：进来/画出来/环数/开放环/点数（同样不参与 roadsMissing 的分母）
      st.displayAreasInView = job.displayAreasInView || 0;
      st.displayAreasDrawn = job.displayAreasDrawn || 0;
      st.displayAreaRings = job.displayAreaRings || 0;
      st.displayAreaOpenRings = job.displayAreaOpenRings || 0;
      st.displayAreaPoints = job.displayAreaPoints || 0;
      st.displayAreasByRule = job.displayAreasByRule || 0;
      st.displayAreaMs = Math.round(job.displayAreaMs || 0);
      st.detailShapes = job.detailShapes;
      st.speedRoads = job.speedRoads;
      st.congestionRoads = job.congestionRoads || 0;
      st.congestionColored = job.congestionColored || 0;
      // 异形楼（多面体 + 天井）的挤出记账：extrudedRelations / innerRings / courtyardWalls
      st.extrudedWays = job.extrudedWays || 0;
      st.extrudedRelations = job.extrudedRelations || 0;
      st.innerRings = job.innerRings || 0;
      st.courtyardWalls = job.courtyardWalls || 0;
      st.roofHoles = job.roofHoles || 0;
      st.flatBuildings = job.flatBuildings || 0;
      st.relationFallbacks = job.relationFallbacks || 0;
      Render._extrusion = {
        zoom: job.zoom,
        buildings: job.buildings.length,
        extrudedWays: job.extrudedWays || 0,
        extrudedRelations: job.extrudedRelations || 0,
        innerRings: job.innerRings || 0,
        courtyardWalls: job.courtyardWalls || 0,
        roofHoles: job.roofHoles || 0,
        flatBuildings: job.flatBuildings || 0,
        relationFallbacks: job.relationFallbacks || 0,
        skipped: job.skipped,
        at: Date.now(),
      };
      st.skipped = job.skipped;
      st.skippedSmall = job.skippedSmall || 0;
      st.skippedTiny = job.skippedTiny || 0;
      st.skippedDegraded = job.skippedDegraded || 0;
      st.detailDroppedFills = job.detailDroppedFills || 0;
      st.minAreaM2 = Math.round(Render.detailMinAreaM2(null, job.zoom) || 0);
      st.lastError = job.lastError;
      st.detail = Render.detail;
      st.detailName = Render.detailName();
      // 状态栏的"分级 L+N"：只有"完整"档不显示；默认的"标准"档也一样不显示（它就是正常状态）
      st.lod = Render.detail === 0 || Render.detail === Render.DEFAULT_DETAIL ? 0 : Render.detail;
      // 分块降级：本地已加载的要素永远不会被"截断"（truncated 恒为 false），
      // 只有在个别过密的小区块里才把装饰性面/标签简略掉，而且会在地图上标注出来。
      st.truncated = false;
      st.blockSizeM = BLOCK_SIZE_M;
      st.blockThreshold = job.blockThreshold || 0;
      st.blockKeepAreaM2 = job.blockKeepArea || 0;
      st.blockCounted = job.blockCounted || 0;
      st.blockFeatures = job.blockFeatures || 0;
      st.blockHot = job.blockHot || 0;
      st.degradedBlocks = job.degraded ? job.degraded.length : 0;
      st.blockSimplified = job.blockSimplified || 0;
      st.blockPointsSimplified = job.blockPointsSimplified || 0;
      st.blockRoadsSimplified = job.blockRoadsSimplified || 0;
      st.blockRoadKeep = job.blockRoadKeep || 0;
      st.blockLabelsSkipped = job.blockLabelsSkipped || 0;
      st.blockError = job.blockError || null;
      st.passes = job.passes;
      st.depthRange = job.buildings.length
        ? [Math.round(job.buildings[0].depth || 0), Math.round(job.buildings[job.buildings.length - 1].depth || 0)]
        : null;
      // 分阶段耗时（拖动排查）：这次重建里每一段各占多少
      st.blockMs = Math.round(job.blockMs || 0);
      st.collectMs = Math.round(job.collectMs || 0);
      st.collectPasses = job.collectPasses || 1;
      st.collectRows = job.collectRows || 0;
      st.collectBuckets = job.collectBuckets || 0;
      st.collectCandidates = job.collectCandidates || 0;
      st.wayListSize = (job.wayList && job.wayList.length) || 0;
      st.wayMs = Math.round(job.wayMs || 0);
      st.nodeMs = Math.round(job.nodeMs || 0);
      st.relationMs = Math.round(job.relationMs || 0);
      st.commitMs = Math.round(job.commitMs || 0);
      st.ms = Math.round(job.cpuMs);
      st.wallMs = Math.round(performance.now() - job.t0);
      st.zoom = job.zoom;
      st.degradedShown = (Render.showDegradedBlocks === false || Render._degraded.length === 0) ? 0 : Render._degraded.length;
      if (World && World.perfAdd) {
        World.perfAdd('rebuild', st.wallMs);
        World.perfAdd('rebuildBlock', job.blockMs || 0);
        World.perfAdd('rebuildWays', job.wayMs || 0);
        World.perfAdd('rebuildNodes', job.nodeMs || 0);
        World.perfAdd('rebuildRelations', job.relationMs || 0);
        World.perfAdd('rebuildCommit', job.commitMs || 0);
      }
      Render.overlay.redraw();
      if (World && World.perfAdd) World.perfAdd('overlayRedraw', 0);
      // 这一轮重建期间又来了新数据：画完再排一次（进度不丢，也不会互相顶掉）
      if (Render._rebuildQueued) {
        Render._rebuildQueued = false;
        Render.scheduleRebuild();
      }
      if (Render.onCounts) Render.onCounts(st);
      if (job.resolve) job.resolve(st);
      const waiters = Render._rebuildWaiters;
      if (waiters && waiters.length) {
        Render._rebuildWaiters = [];
        for (const fn of waiters) fn(st);
      }
    },

    /**
     * 提交场景：在同一个同步块里"清空 + 整批加入"。
     * 因为两件事在同一帧完成，画面上永远不会出现"要素只剩一半"的中间状态。
     */
    _commit(job) {
      Render.fillLayer.clearLayers();
      Render.buildingLayer.clearLayers();
      Render.casingLayer.clearLayers();
      Render.coreLayer.clearLayers();
      Render.focusLayer.clearLayers();
      if (job.fills.length) Render.fillLayer.addLayer(L.layerGroup(job.fills));
      if (job.buildings.length) Render.buildingLayer.addLayer(L.layerGroup(job.buildings));
      if (job.casings.length) Render.casingLayer.addLayer(L.layerGroup(job.casings));
      if (job.cores.length) Render.coreLayer.addLayer(L.layerGroup(job.cores));
      if (job.focusShapes.length) Render.focusLayer.addLayer(L.layerGroup(job.focusShapes));
    },

    /** 等这次重建真正画完（分帧时用；同步模式下立即 resolve） */
    rebuildAsync() {
      return new Promise((resolve) => {
        Render._rebuildWaiters = Render._rebuildWaiters || [];
        Render._rebuildWaiters.push(resolve);
        if (!Render.jobPending()) {
          const waiters = Render._rebuildWaiters;
          Render._rebuildWaiters = [];
          for (const fn of waiters) fn(Render.stats);
        }
      });
    },

    jobPending() {
      return !!(Render._job && !Render._job.done);
    },

    /**
     * 要素账的明细（#6a）：状态栏、区块注释、自检都读这一份，不再各自拼字符串。
     *
     * 口径：`features` = 视野内真的画出来的要素（way + POI + 多面体关系）；
     * 另外单列"视野外还画着的"（画布 padding 那一圈）与"数出来但没画出来的"
     * （面积 LOD / 样式既不描边也不填充 / 区块简化），以及本地缓存总数（只作背景）。
     */
    featureBreakdown() {
      const s = Render.stats || {};
      return {
        zoom: s.zoom || (Render.map ? Render.map.getZoom() : 0),
        /** 这一档真的画在这个视野里的要素数（= 状态栏报的那个数） */
        features: s.featuresInView || 0,
        ways: s.featuresWaysInView || 0,
        nodes: s.featuresNodesInView || 0,
        relations: s.featuresRelsInView || 0,
        /** 画了但落在视野外的（画布 padding 那一圈） */
        offView: s.featuresOffView || 0,
        offViewWays: s.featuresWaysOffView || 0,
        offViewNodes: s.featuresNodesOffView || 0,
        offViewRelations: s.featuresRelsOffView || 0,
        /** 过了视野却一个图形都没产生的 */
        notDrawn: s.featuresNotDrawn || 0,
        /** 本地缓存总数（背景信息；以前状态栏把这个数当成"视野内"报出来） */
        loaded: s.featuresLoaded || 0,
        /** 这一趟的筛选账：面积 LOD / 框外 POI / 框外关系 / 区块简化 / 道路等级门槛 */
        areaLodSkipped: s.areaLodSkipped || 0,
        areaLodRelationSkipped: s.areaLodRelationSkipped || 0,
        areaLodM2: s.areaLodM2 || 0,
        roadLodSkipped: s.roadLodSkipped || 0,
        roadLodMinRank: s.roadLodMinRank || 0,
        roadLodMinRankName: s.roadLodMinRankName || '',
        nodeOutOfView: s.nodeOutOfViewSkipped || 0,
        relationOutOfView: s.relationOutOfViewSkipped || 0,
        blockSimplifiedFills: s.blockSimplified || 0,
        blockSimplifiedPoints: s.blockPointsSimplified || 0,
        blockSimplifiedRoads: s.blockRoadsSimplified || 0,
        /** 真的建出来的图形个数（面 + 楼 + 描边批次 + 路面批次） */
        drawn: s.drawn || 0,
      };
    },

    /** 一行中文明细（状态栏 tooltip / 自检输出用） */
    featureBreakdownText() {
      const b = Render.featureBreakdown();
      const parts = [`视野内 ${b.features} 个要素（道路/线 ${b.ways} · POI ${b.nodes} · 多面体关系 ${b.relations}）`];
      parts.push(`绘制 ${b.drawn} 个图形`);
      const hidden = [];
      if (b.notDrawn) hidden.push(`档位/面积不画 ${b.notDrawn}`);
      if (b.areaLodSkipped) hidden.push(`面积 < ${b.areaLodM2} m² 的小面 ${b.areaLodSkipped}`);
      if (b.areaLodRelationSkipped) hidden.push(`小多面体 ${b.areaLodRelationSkipped}`);
      if (b.roadLodSkipped) hidden.push(`这一档不画的细路 ${b.roadLodSkipped}（${b.roadLodMinRankName} 以下）`);
      if (b.blockSimplifiedFills || b.blockSimplifiedPoints || b.blockSimplifiedRoads) {
        hidden.push(`区块简略 ${b.blockSimplifiedFills}/${b.blockSimplifiedPoints}/${b.blockSimplifiedRoads}`);
      }
      if (hidden.length) parts.push('没画出来的：' + hidden.join(' · '));
      if (b.offView) parts.push(`视野外画布 padding 里另有 ${b.offView} 个`);
      parts.push(`本地缓存共 ${b.loaded} 个（含其它缩放/视野附近的数据）`);
      return parts.join(' · ');
    },

    /**
     * 在"视野内已加载的要素"和"真的画出来的要素"之间做核对（禁止截断的自证）。
     * 分块降级 / 详细度档位之后，"少"必须分得清清楚楚：
     *   · roadsMissing          —— **该画却没画**的道路条数。任何档位下都必须是 0；
     *   · roadsMissingByDetail  —— 当前档位**主动不画**的道路（只有玩家自选的"骨架"档会这样，
     *                              它本来就是"只画主干路网"）；
     *   · roadsMissingByBlockSimplify —— **区块过密被简化掉的次要道路**（各自独立的街区，
     *                              已在地图上用阴影 + 标注 + "?" 说明；放大那一档就会回来）；
     *   · roadsMissingByRule    —— 样式/图层本身就不画的道路（规则缩放不到、玩家关了那一层）；
     *   · areasMissingByDetail  —— 当前档位按缩放/面积主动省掉的装饰性面（切到"完整"就回来）；
     *   · areasMissingByRule    —— 样式/图层本身就不画的（没规则、规则缩放到不了、玩家关了那一层）；
     *   · degradedAreasMissing  —— 少掉的面落在"已简略显示的区块"里（分块简化）；
     *   · areasMissingIncomplete—— 少掉的面**节点还没到本地**（way 先到、节点在隔壁瓦片里，
     *                              属于"数据未齐"，不是渲染丢的；节点一到会自动补画，见 World._refreshIncompleteWays）；
     *   · areasMissingUnexpected—— 以上都不是，这才叫真的"丢东西"，必须是 0。
     */
    completeness() {
      const map = Render.map;
      if (!map) return null;
      const bounds = map.getBounds().pad(0.12);
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const bbox = { minLat: sw.lat, maxLat: ne.lat, minLon: sw.lng, maxLon: ne.lng };
      // 复用缓冲区（这条路径每次都新建一个几万元素的数组纯属浪费）
      const all = World.queryWays(bbox, Render._completenessQuery || (Render._completenessQuery = []));
      const drawn = new Set(Render._visibleWays.map((w) => w.id));
      // 和渲染时同一套"在不在视野里"的判断（中点或任一顶点），否则分母会偏大
      const inView = (way) => {
        const g = way._geom;
        if (!g || !g.lls || !g.lls.length) return false;
        if (bounds.contains(g.mid)) return true;
        for (const c of g.lls) if (bounds.contains(c)) return true;
        return false;
      };
      const zoom = map.getZoom();
      // 这一帧"按档位省掉的"要素 id（渲染时记下的账本，不再自己重算一遍规则）
      const droppedByDetail = Render._detailDroppedIds || new Set();
      /** 这一帧"因为区块过密而没画"的次要道路 id（渲染时记下的账本） */
      const blockRoadDropped = Render._blockRoadSimplifyIds || new Set();
      const skipStyle = Render.style;
      let roads = 0;
      let roadsDrawn = 0;
      let roadsByDetail = 0;
      /** 其中"因为这一档缩放的服务端/客户端道路门槛（rank）而不画"的条数（#6b/#6c 的新口径） */
      let roadsByRoadLod = 0;
      let roadsByRule = 0;
      let roadsByBlock = 0;
      let roadsUnexpected = 0;
      let fills = 0;
      let fillsDrawn = 0;
      let degradedMissing = 0;
      let detailMissing = 0;
      let incompleteMissing = 0;
      let ruleMissing = 0;
      let unexpectedMissing = 0;
      const ruleReasons = {};
      for (const way of all) {
        if (!way._geom || way._geom.z !== zoom) continue;
        if (!inView(way)) continue;
        if (!way.tags) continue;
        const isRoad = !!way.tags.highway;
        const isArea = World.isClosed(way);
        const kind = isArea ? 'area' : 'line';
        if (isRoad) {
          roads += 1;
          if (drawn.has(way.id)) roadsDrawn += 1;
          // 顺序与渲染一致：档位 → 道路缩放门槛 → 区块过密简化 → 样式/图层本来就不画 → 剩下才是真的"计划外"
          else if (!Render.detailAllows(way.tags, 'line', zoom)) roadsByDetail += 1;
          else if (!Render.roadLodAllows(way.tags, zoom)) { roadsByDetail += 1; roadsByRoadLod += 1; }
          else if (blockRoadDropped.has(way.id)
            || (Render.isInDegradedBlock(way) && Render.roadIsBlockSimplifiable(way.tags, zoom))) roadsByBlock += 1;
          else if (Render.waySkipReason(way, kind, zoom, skipStyle)) roadsByRule += 1;
          else roadsUnexpected += 1;
        }
        if (isArea) {
          fills += 1;
          if (drawn.has(way.id)) fillsDrawn += 1;
          // 顺序与渲染一致：先看档位（含面积门槛）→ 再看"样式本来就不画" → 再看几何
          // （节点没到齐画不出来）→ 再看分块简化 → 剩下才是真的"计划外"
          else if (droppedByDetail.has(way.id)) detailMissing += 1;
          else {
            const reason = Render.waySkipReason(way, 'area', zoom, skipStyle);
            if (reason) {
              ruleMissing += 1;
              ruleReasons[reason] = (ruleReasons[reason] || 0) + 1;
            } else if (way._incomplete || (way._geom && way._geom.lls && way._geom.lls.length < 2)) incompleteMissing += 1;
            else if (Render.isInDegradedBlock(way)) degradedMissing += 1;
            else unexpectedMissing += 1;
          }
        }
      }
      const roadsMissingAll = roads - roadsDrawn;
      const areasMissing = fills - fillsDrawn;
      const blocks = Render.degradedBlocks();
      /**
       * 低缩放合并折线（displayLines）的账：
       *   进来多少条 / 画出来多少条 / 因为样式规则（规则缩放不到、图层被关）没画多少条。
       * **该画却没画**（unexpected）必须恒为 0 —— 与道路那条口径完全一致。
       * 注意它们**不在 roadsInView 的分母里**（没有 way id、不是 way），所以 roadsMissing 不受影响；
       * "合并掉的主干道被画出来了"这件事由 displayLinesDrawn 自己说清楚。
       */
      const dl = Render._displayLineStats || { inView: 0, drawn: 0, paths: 0, points: 0, byRule: 0, ms: 0 };
      const dlUnexpected = Math.max(0, dl.inView - dl.drawn - dl.byRule);
      /**
       * 低缩放合并面（displayAreas）的账：与折线完全同一套口径。
       * 它们同样**不在 areasInView 的分母里**（没有 way id、不是 way），所以
       * `areasMissing` / `areasMissingUnexpected`（"面一块不缺"的那两个数）不受影响；
       * "被合并掉的水面/绿地有没有画出来"由 displayAreasDrawn 自己说清楚。
       */
      const da = Render._displayAreaStats || { inView: 0, drawn: 0, rings: 0, openRings: 0, points: 0, byRule: 0, ms: 0 };
      const daUnexpected = Math.max(0, da.inView - da.drawn - da.byRule);
      return {
        zoom,
        detail: Render.detail,
        detailName: Render.detailName(),
        detailIsDefault: Render.detail === Render.DEFAULT_DETAIL,
        drawnWays: Render._visibleWays.length,
        roadsInView: roads,
        roadsDrawn,
        // 该画却没画的道路：**任何档位下都必须是 0**
        roadsMissing: roadsUnexpected,
        // 低缩放合并折线（displayLines）：该画却没画的必须恒为 0
        displayLinesInView: dl.inView,
        displayLinesDrawn: dl.drawn,
        displayLinePaths: dl.paths,
        displayLinePoints: dl.points,
        displayLinesByRule: dl.byRule,
        displayLinesMissing: dlUnexpected,
        displayLinesUnexpected: dlUnexpected,
        displayLineMs: dl.ms,
        // 低缩放合并面（displayAreas）：与折线同一套口径（"该画却没画的必须恒为 0"）
        displayAreasInView: da.inView,
        displayAreasDrawn: da.drawn,
        displayAreaRings: da.rings,
        displayAreaOpenRings: da.openRings,
        displayAreaPoints: da.points,
        displayAreasByRule: da.byRule,
        displayAreasMissing: daUnexpected,
        displayAreasUnexpected: daUnexpected,
        displayAreaMs: da.ms,
        // 档位主动不画的道路（只有"骨架"档），以及"一共少了几条"的原始差值
        roadsMissingByDetail: roadsByDetail,
        /** 其中因为**这一档缩放的等级门槛**（与服务端下发同一张表）而不画的条数 */
        roadsMissingByRoadLod: roadsByRoadLod,
        roadLod: Render.roadLodStats(),
        // 区块过密被简化掉的次要道路（独立口径：地图上那一块有阴影 + 标注 + "?"）
        roadsMissingByBlockSimplify: roadsByBlock,
        // 样式/图层本身就不画的道路（规则缩放到不了、那一层被关掉）
        roadsMissingByRule: roadsByRule,
        roadsMissingRaw: roadsMissingAll,
        roadsMissingUnexpected: roadsUnexpected,
        areasInView: fills,
        areasDrawn: fillsDrawn,
        areasMissing,
        // 少掉的面里，属于"当前档位主动省掉"的部分（切到"完整"档就全回来）
        areasMissingByDetail: detailMissing,
        // 少掉的面里，属于"样式/图层本来就不画"的部分（没规则 / 规则缩放到不了 / 那一层关了）
        areasMissingByRule: ruleMissing,
        areasMissingByRuleReasons: Object.assign({}, ruleReasons),
        // 少掉的面里，落在"已简略显示的区块"里的部分（如实告知的简化，不是丢数据）
        degradedAreasMissing: degradedMissing,
        // 少掉的面里，属于"节点还没到本地"的部分（way 先到、节点后到；节点一到会自动补画）
        areasMissingIncomplete: incompleteMissing,        // 真的不该少的面（必须恒为 0）
        areasMissingUnexpected: unexpectedMissing,
        // 分块降级状态
        degradedBlocks: blocks.length,
        degradedBlockSizeM: BLOCK_SIZE_M,
        degradedBlocksShown: !!(Render.showDegradedBlocks !== false && blocks.length),
        blockThreshold: Render.stats.blockThreshold || 0,
        simplifiedFills: Render.stats.blockSimplified || 0,
        simplifiedPoints: Render.stats.blockPointsSimplified || 0,
        // 诚实性总闸：没有"该画却没画"的东西（按档位/按区块省掉的是写明了的）
        honest: roadsUnexpected === 0 && unexpectedMissing === 0 && dlUnexpected === 0,
        truncated: false,
        labels: Render.stats.labels,
        patches: Render._visibleWays.some((w) => w._incomplete) ? 'incomplete-way' : null,
      };
    },

    /**
     * 挤出（异形楼 / 天井）的统计：上一次重建里挤出多少栋、认出多少个内环、画了几面朝院子的墙。
     * 「多面体建筑的天井」是否真的被画出来，看 innerRings / courtyardWalls / roofHoles 三个数即可。
     */
    extrusionStats() {
      const s = Render._extrusion || {};
      return {
        zoom: s.zoom || 0,
        buildings: s.buildings || 0,             // 建筑图层里的多边形对象数（墙面 + 屋顶）
        extrudedWays: s.extrudedWays || 0,        // 普通闭合建筑
        extrudedRelations: s.extrudedRelations || 0,   // **多面体建筑**（异形楼）
        innerRings: s.innerRings || 0,            // 认出来并参与挤出的内环（天井）
        courtyardWalls: s.courtyardWalls || 0,    // 朝院子里的墙面片数
        roofHoles: s.roofHoles || 0,              // 屋顶上用 evenodd 挖出来的洞
        flatBuildings: s.flatBuildings || 0,      // 太矮 / 退化 → 退回平面屋顶（带内环时同样是 evenodd）
        relationFallbacks: s.relationFallbacks || 0,   // 环没缝出来的关系（退回"每条成员 way 一圈"的老画法）
        skipped: s.skipped || 0,
        at: s.at || 0,
      };
    },

    fallbackRule(tags) {
      if (!tags || !Object.keys(tags).length) return null;
      // 有标签但样式表里没覆盖：用灰色虚线标出来，方便编辑器发现
      return { layer: 'other', kind: 'both', stroke: '#9aa0a6', weight: 1, dash: [3, 3], fill: '#c9ced4', fillOpacity: 0.35, minZoom: 17 };
    },

    /** 一组坐标的 bbox 面积（米²，等距圆柱近似，够用于筛选） */
    bboxAreaM2(b) {
      if (!b) return 0;
      const h = (b.maxLat - b.minLat) * 110574;
      const w = (b.maxLon - b.minLon) * 111320 * Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180);
      return Math.abs(h * w);
    },

    /** 一组坐标在屏幕像素下的重心与 bbox 面积（米²，用等距圆柱近似，够用于筛选） */
    bboxOf(coords) {
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const c of coords) {
        if (c[0] < minLat) minLat = c[0];
        if (c[0] > maxLat) maxLat = c[0];
        if (c[1] < minLon) minLon = c[1];
        if (c[1] > maxLon) maxLon = c[1];
      }
      const h = (maxLat - minLat) * 110574;
      const w = (maxLon - minLon) * 111320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
      return { areaM2: Math.abs(h * w), w, h };
    },

    /** 一组坐标在当前缩放下的屏幕像素重心（用于深度排序） */
    centerPixel(coords, zoom) {
      let x = 0;
      let y = 0;
      for (const c of coords) {
        const p = Render.map.project(L.latLng(c[0], c[1]), zoom);
        x += p.x;
        y += p.y;
      }
      return { x: x / coords.length, y: y / coords.length };
    },

    focusMatcher: {
      rail: (tags) => !!(tags && (tags.railway || tags.public_transport === 'station')),
      bus: (tags) => !!(tags && ((tags.highway && (tags.bus === 'yes' || tags.psv === 'yes')) ||
        tags.route === 'bus' || tags.public_transport === 'platform' || tags.highway === 'bus_stop' ||
        tags.highway === 'bus_guideway' || tags.amenity === 'bus_station')),
      walk: (tags) => !!(tags && (['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'bridleway'].includes(tags.highway) || tags.railway === 'platform')),
      /** 轨道 + 公交一起聚焦（「显示模式 → 铁路公交」用它，见 setDisplayMode） */
      railbus: (tags) => !!(tags && (Render.focusMatcher.rail(tags) || Render.focusMatcher.bus(tags))),
    },

    isFocused(tags) {
      const kind = Render.focus;
      if (!kind) return false;
      const fn = Render.focusMatcher[kind];
      return fn ? fn(tags) : false;
    },

    /** 设置聚焦模式：null / 'rail' / 'bus' / 'walk' / 'railbus' */
    setFocus(kind) {
      Render.focus = kind || null;
      // 从「铁路公交」显示模式切到别的聚焦目标时，显示模式跟着回到普通
      if (Render.focus !== 'railbus' && Render.displayMode === 'railbus') Render.displayMode = 'normal';
      Render.rebuild({ async: true });
    },

    /* ============================ 图层驱动的显示模式 ============================ */
    /* 像 Cities: Skylines 的视图层：一次只开一层，换一层看城市（普通 / 道路车速 /
       人口密度 / 活跃度 / 铁路公交）。颜色计算都在这里，图例由 ui.js 画在图层面板里。
       公交分色**不在这一层**了：它是独立的颜色方案（Render.transitColorSchemeId），
       在任何显示模式下都生效；下面三个旧 id 只是别名。 */

    /**
     * 设置显示模式（互斥）；返回真正生效的模式。
     * 「互斥」的实现方式始终只有一个 displayMode 字段。
     *
     * 三个旧 id（'linecolor' 线路本色 / 'company' 按公司 / 'fare' 按票价）**是别名**：
     * 调用它们 = 同时设颜色方案 + 把显示模式设成这个 id（老 ui.js / 老测试原样能用）；
     * 之后再选普通 / 车速 / 拥堵这类"非公交分色"的模式时，这种"跟着模式走"的方案会回到
     * auto（= 与旧行为一模一样：离开分色模式就不再改公交配色）。
     * 用 setTransitColorScheme() 显式设的方案**不会**被任何 setDisplayMode 清掉 ——
     * 谁后调谁说话：别名与显式设置都写同一个字段，最后一次写入生效。
     */
    setDisplayMode(mode) {
      const MODES = ['normal', 'speed', 'congestion', 'population', 'activity', 'railbus']
        .concat(TRANSIT_COLOR_MODES);
      const m = MODES.includes(mode) ? mode : 'normal';
      Render.displayMode = m;
      // 「铁路公交」就是聚焦里的"轨道 + 公交"：其余模式则不聚焦
      if (m === 'railbus') Render.focus = 'railbus';
      else if (Render.focus === 'railbus') Render.focus = null;
      if (m === 'population' || m === 'activity') Render.ensureCells(true);
      // 拥堵：进模式就按当前视野要一次数据（已有覆盖就不重复取）
      if (m === 'congestion') Render.ensureCongestion(true);
      // 旧别名：这三个 id 同时就是颜色方案（同时设方案 + 显示模式）
      if (Render.isTransitColorMode(m)) Render.applyTransitColorScheme(m, 'mode');
      // 从旧的"分色显示模式"切走 → 回到 auto（旧的像素级行为：普通模式下不加任何配色）
      else if (Render._transitColorSchemeSource === 'mode') Render.applyTransitColorScheme(TRANSIT_COLOR_SCHEME_AUTO, 'explicit');
      Render.rebuild({ async: true });
      return Render.displayMode;
    },

    /**
     * 绘制路径统一用的"聚焦淡化"判定（线 / 面 / 建筑四处画法都用它，自检也用它）：
     * 有聚焦目标、而这一条不属于聚焦目标 → 淡化。
     * 颜色方案只改公交取色，**绝不碰这里**（自检里验：设了公司色之后非轨交图层照样被淡化）。
     */
    focusDim(tags) {
      return !!(Render.focus && !Render.isFocused(tags));
    },

    isCellMode(mode) {
      const m = mode === undefined ? Render.displayMode : mode;
      return m === 'population' || m === 'activity';
    },

    /** 当前是不是"道路拥堵"显示模式 */
    isCongestionMode(mode) {
      const m = mode === undefined ? Render.displayMode : mode;
      return m === 'congestion';
    },

    /** 活跃度模式是否可用：服务器 /api/population 没给 activity 字段时返回 false（UI 据此置灰） */
    activityUsable() { return Render.cellsSupport.hasActivity !== false; },

    /* ------------------------------ 车站覆盖范围图层 ------------------------------ */
    /** 车站列表（来自交通快照；交通模块没加载时为空） */
    stationList() {
      const t = window.G && window.G.Transit;
      const list = t && t.data && Array.isArray(t.data.stations) ? t.data.stations : [];
      return list;
    },

    /**
     * 全局单开关：开 → 所有车站都画覆盖范围（除非打开"只画自己勾选过的"过滤器）；
     * 关 → 一个都不画。不再需要逐个车站去关。
     */
    setStationCatchment(on, onlyFlagged) {
      if (on !== undefined) Render.stationCatchment.on = !!on;
      if (onlyFlagged !== undefined) Render.stationCatchment.onlyFlagged = !!onlyFlagged;
      if (Render.overlay) Render.overlay.redraw();
      return Render.stationCatchment;
    },

    /**
     * 画车站时临时压住"每站自己的覆盖范围开关"：
     * 覆盖范围现在只有图层总开关一个入口，这样既不会和每站的圆盘叠成两层，
     * 也保证总开关一关就干净（这就是"一个开关能全关"的实现方式）。
     */
    withStationCatchmentSuppressed(fn) {
      const patched = [];
      for (const st of Render.stationList()) {
        if (st && st.showCatchment) { patched.push(st); st.showCatchment = false; }
      }
      try {
        fn();
      } finally {
        for (const st of patched) st.showCatchment = true;
      }
    },

    /* ------------------------------ 道路车速 ------------------------------ */
    /** 道路（按 highway 标签）才参与车速着色 */
    isRoadTags(tags) { return !!(tags && tags.highway); },

    /** 解析 maxspeed 标签：数字 / "50 km/h" / "30 mph" / "walk" / "none"，认不出返回 null */
    parseMaxspeed(raw) {
      if (raw == null) return null;
      const s = String(raw).trim().toLowerCase();
      if (!s) return null;
      if (s === 'none') return 130;
      if (s === 'walk' || s === 'foot') return 7;
      if (/signal|variable|unknown|default/.test(s)) return null;
      const num = parseFloat(s.replace(',', '.'));
      if (!Number.isFinite(num) || num <= 0) return null;
      if (/mph/.test(s)) return num * 1.60934;
      if (/knot/.test(s)) return num * 1.852;
      // 形如 "CN:urban"、"DE:rural"：取其中的数字，取不到就丢给调用方用等级默认值
      return num;
    },

    /** 一条道路的有效车速（km/h）：maxspeed 标签优先，否则按道路等级给默认值 */
    effectiveSpeedKph(tags) {
      const t = tags || {};
      const tagged = Render.parseMaxspeed(t.maxspeed)
        || Render.parseMaxspeed(t['maxspeed:forward'])
        || Render.parseMaxspeed(t['maxspeed:backward']);
      if (Number.isFinite(tagged)) return Math.max(5, Math.min(200, tagged));
      const byClass = Render.SPEED_BY_CLASS[t.highway];
      return Number.isFinite(byClass) ? byClass : 30;
    },

    /** 有效车速 → 蓝红渐变里的颜色（t 也可给图例用） */
    colorForSpeed(kph) {
      const t = Render.speedT(kph);
      return Render.cssRgb(Render.mixStops(Render.speedScale.stops, t));
    },

    speedT(kph) {
      const s = Render.speedScale;
      const v = Number.isFinite(Number(kph)) ? Number(kph) : s.min;
      return Math.max(0, Math.min(1, (v - s.min) / (s.max - s.min)));
    },

    /* ------------------------------ 人口 / 活跃度格子 ------------------------------ */
    /** 视野内的格子数据（懒加载；换视野后自动再取一次） */
    ensureCells(force) {
      if (!Render.isCellMode()) return;
      const c = Render.cells;
      if (c.loading) return;
      // /api/population 需要登录令牌：还没登录就先不发请求（登录后 UI.setInfo 会再叫一次）
      const token = (window.G.Net && window.G.Net.token) || '';
      if (!token) return;
      let bbox = null;
      try {
        const md = window.G && window.G.MapData;
        if (md && md.map && typeof md.bboxNow === 'function') bbox = md.bboxNow(0);
      } catch { bbox = null; }
      if (!bbox) return;
      const covered = c.bbox && c.bbox.minLon <= bbox.minLon && c.bbox.maxLon >= bbox.maxLon
        && c.bbox.minLat <= bbox.minLat && c.bbox.maxLat >= bbox.maxLat;
      if (!force && covered && c.mode === Render.displayMode) return;
      c.loading = true;
      c.mode = Render.displayMode;
      // 活跃度要连"没有人但繁华/冷清"的格子一起拿，所以 minPop=0（服务器会限制返回规模）
      const minPop = Render.displayMode === 'activity' ? 0 : 150;
      const url = `/api/population?minLon=${bbox.minLon}&minLat=${bbox.minLat}`
        + `&maxLon=${bbox.maxLon}&maxLat=${bbox.maxLat}&minPop=${minPop}&token=${encodeURIComponent(token)}`;
      fetch(url)
        .then((r) => r.json())
        .then((data) => {
          const list = data && Array.isArray(data.cells) ? data.cells.slice(0, 40000) : [];
          c.list = list;
          c.totals = (data && data.totals) || null;
          const cellM = Number(c.totals && c.totals.cellM);
          if (Number.isFinite(cellM) && cellM > 0) c.cellM = cellM;
          c.bbox = bbox;
          c.error = null;
          c.loadedAt = Date.now();
          // 能力探测：老版本服务器没有 activity 字段 → 活跃度模式置灰（UI 读 cellsSupport）
          Render.cellsSupport.loaded = true;
          if (list.length) {
            Render.cellsSupport.hasActivity = list.some((x) => x && Number.isFinite(Number(x.activity)));
            Render.cellsSupport.hasPopulation = list.some((x) => x && Number(x.pop) > 0);
          }
        })
        .catch((err) => { c.error = (err && err.message) || '人口数据加载失败'; })
        .then(() => {
          c.loading = false;
          if (Render.overlay) Render.overlay.redraw();
          if (Render.onCells) Render.onCells(c);
        });
    },

    /* ============================ 道路拥堵（transit op: road.congestion） ============================ */
    /*
     * 和"道路车速"并列的一种显示模式：路面按服务器算出的**拥堵系数**上色（绿=畅通 → 琥珀=一般 → 红=拥堵），
     * 宽度/虚线仍走样式表那套规则（与现在完全一致），铁路/电车不上色。
     * 数据跟着视野走：按取整后的 bbox 缓存（同一片地方来回拖不重取），同一时刻最多一个请求在飞；
     * 服务器没这个 op、或者失败了 → 退回普通配色 + 弹一次中文提示（绝不把画面搞花）。
     */

    /** 登记一次 transitAck 监听（Net 可能比 Render 晚就绪，所以做成幂等） */
    ensureCongestionListener() {
      if (Render.congestion._listening) return true;
      try {
        const net = window.G && window.G.Net;
        if (!net || !net.on) return false;
        net.on('transitAck', (msg) => Render.onCongestionAck(msg));
        Render.congestion._listening = true;
        return true;
      } catch { return false; }
    },

    /** 当前视野的经纬度框（拥堵请求用它；MapData 没就绪也能用，直接问地图） */
    viewBoxNow() {
      const map = Render.map;
      if (!map || typeof map.getBounds !== 'function') return null;
      let b = null;
      try { b = map.getBounds(); } catch { return null; }
      if (!b) return null;
      const sw = typeof b.getSouthWest === 'function' ? b.getSouthWest() : b;
      const ne = typeof b.getNorthEast === 'function' ? b.getNorthEast() : b;
      if (!sw || !ne) return null;
      const box = {
        minLat: Number(sw.lat), minLon: Number(sw.lng != null ? sw.lng : sw.lon),
        maxLat: Number(ne.lat), maxLon: Number(ne.lng != null ? ne.lng : ne.lon),
      };
      const ok = [box.minLat, box.maxLat, box.minLon, box.maxLon].every(Number.isFinite);
      return ok ? box : null;
    },

    /** 请求用的 bbox：视野外扩一点，再按 congestionGridDeg 向外取整（≈200 米一个格子） */
    congestionRequestBox(view) {
      const v = view || Render.viewBoxNow();
      if (!v) return null;
      const padLon = (v.maxLon - v.minLon) * Render.congestionPad;
      const padLat = (v.maxLat - v.minLat) * Render.congestionPad;
      const g = Render.congestionGridDeg;
      const floor = (x) => Math.floor(x / g) * g;
      const ceil = (x) => Math.ceil(x / g) * g;
      return {
        minLon: floor(v.minLon - padLon), minLat: floor(v.minLat - padLat),
        maxLon: ceil(v.maxLon + padLon), maxLat: ceil(v.maxLat + padLat),
      };
    },

    /** 取整后 bbox 的缓存 key（同一片地方 = 同一个 key） */
    congestionKeyOf(box) {
      if (!box) return '';
      const r = (x) => (Math.round(x * 1000) / 1000).toFixed(3);
      return `${r(box.minLon)},${r(box.minLat)},${r(box.maxLon)},${r(box.maxLat)}`;
    },

    /** 外框是否已经盖住内框（视野还在已取范围里 → 不重新请求） */
    boxCovers(outer, inner) {
      return !!outer && !!inner
        && outer.minLon <= inner.minLon && outer.maxLon >= inner.maxLon
        && outer.minLat <= inner.minLat && outer.maxLat >= inner.maxLat;
    },

    /**
     * 按视野要一次拥堵数据（换地方就补一次，和人口格子一个套路）。
     * @param {boolean} [force] 强制重取（刚切进拥堵模式 / 面板上的刷新按钮）
     * @returns {boolean} 是否真的发了请求
     */
    ensureCongestion(force) {
      if (!Render.isCongestionMode()) return false;
      const c = Render.congestion;
      if (c.loading) return false;                       // 最多一个请求在飞
      Render.ensureCongestionListener();
      const view = Render.viewBoxNow();
      if (!view) return false;
      const box = Render.congestionRequestBox(view);
      const key = Render.congestionKeyOf(box);
      if (!force && c.bbox && (c.key === key || Render.boxCovers(c.bbox, view))) return false;
      const net = window.G && window.G.Net;
      if (!net || !net.connected || typeof net.send !== 'function') {
        c.error = '未连接到服务器';
        Render.congestionHint();
        return false;
      }
      const id = 'cg' + (Render._cgSeq = (Render._cgSeq || 0) + 1).toString(36)
        + Math.random().toString(36).slice(2, 6);
      const op = {
        k: 'road.congestion',
        bbox: [box.minLon, box.minLat, box.maxLon, box.maxLat],
        limit: Render.congestionLimit,
        withCoords: false,
      };
      c.loading = true;
      c.pendingId = id;
      c.startedAt = Date.now();
      c.requestBox = box;
      c.viewBox = view;
      c.requests += 1;
      const sent = net.send({ t: 'transit', id, op });
      if (!sent) {
        c.loading = false;
        c.pendingId = null;
        c.error = '未连接到服务器';
        Render.congestionHint();
        return false;
      }
      // 乐观记下"已覆盖"：正在飞的这段时间里不再重复发；失败时会被清掉
      c.bbox = box;
      c.key = key;
      // 服务器不回应（老服务器没这个 op）时不能一直挂着 loading，超时就当失败
      Render._cgTimer = setTimeout(() => {
        if (c.pendingId !== id) return;
        c.pendingId = null;
        c.loading = false;
        Render.resetCongestionData('服务器没有回应');
        Render.congestionHint();
        Render.rebuild({ async: true });
      }, Render.congestionTimeoutMs);
      return true;
    },

    /** 清空拥堵数据（取失败 / 超时 / op 不存在时用）：统计与图例跟着一起归零，不留半截数字 */
    resetCongestionData(error) {
      const c = Render.congestion;
      c.list = [];
      c.roads = [];
      c.byWayId = new Map();
      c.counts = { free: 0, busy: 0, jam: 0, other: 0 };
      c.bbox = null;
      c.key = '';
      c.loadedAt = 0;
      c.total = 0;
      c.truncated = false;
      c.meanSpeed = 0;
      c.meanSpeedByLength = 0;
      c.meanLimit = 0;
      c.meanCongestion = 0;
      c.minSpeed = 0;
      c.maxSpeed = 0;
      c.slowest = null;
      c.fastest = null;
      c.serverStats = null;
      c.error = error || c.error || '拥堵数据读取失败';
      return c;
    },

    /** 认领自己发出去的 transitAck（别人的 id 一概不碰） */
    onCongestionAck(msg) {
      if (!msg) return false;
      // 先看有没有"单条道路明细"（road.congestion.way）在等这条应答
      const waiters = Render._cgWayWaiters;
      if (waiters && waiters.length) {
        for (const fn of waiters.slice()) {
          let claimed = false;
          try { claimed = fn(msg) === true; } catch { claimed = false; }
          if (claimed) {
            const i = waiters.indexOf(fn);
            if (i >= 0) waiters.splice(i, 1);
            return true;
          }
        }
      }
      const c = Render.congestion;
      if (!msg || !c.pendingId || msg.id !== c.pendingId) return false;
      if (Render._cgTimer) { clearTimeout(Render._cgTimer); Render._cgTimer = null; }
      const ms = Date.now() - (c.startedAt || Date.now());
      c.pendingId = null;
      c.loading = false;
      const res = msg.result;
      if (!msg.ok || !res || res.error) {
        Render.resetCongestionData(msg.error || (res && res.error));
        Render.congestionHint();
        Render.rebuild({ async: true });
        return true;
      }
      Render.applyCongestion(res, c.requestBox, ms);
      Render.rebuild({ async: true });
      return true;
    },

    /** 服务器回来了：把 way 列表整理成"按 wayId 查"的索引 + 视野统计 */
    applyCongestion(res, box, ms) {
      const c = Render.congestion;
      const raw = Array.isArray(res && res.ways) ? res.ways : [];
      const roads = [];
      const byWayId = new Map();
      const counts = { free: 0, busy: 0, jam: 0, other: 0 };
      let sumSpeed = 0;
      let sumLimit = 0;
      let sumCg = 0;
      let sumSpeedLen = 0;
      let lenSum = 0;
      let minSpeed = Infinity;
      let maxSpeed = -Infinity;
      let slowest = null;
      let fastest = null;
      for (const it of raw) {
        if (!it) continue;
        const id = Number(it.wayId);
        if (!Number.isFinite(id)) continue;
        // 服务器的路网表里也有轨道：轨道不参与"道路拥堵"口径，先剔掉
        if (!Render.isDrivableRoadKind(it.kind)) { counts.other += 1; continue; }
        const cg = Number(it.congestion);
        if (!Number.isFinite(cg)) { counts.other += 1; continue; }
        const speed = Number(it.speed);
        const limit = Number(it.limit);
        const rec = {
          wayId: id, kind: it.kind, congestion: cg,
          speed: Number.isFinite(speed) ? speed : 0,
          limit: Number.isFinite(limit) ? limit : 0,
          junctions: Number(it.junctions) || 0,
          density: Number(it.density) || 0,
          lengthM: Number(it.lengthM) || 0,
          dedicated: !!it.dedicated,
          level: Render.congestionLevel(it),
        };
        roads.push(rec);
        byWayId.set(id, rec);
        counts[rec.level] = (counts[rec.level] || 0) + 1;
        sumSpeed += rec.speed;
        sumLimit += rec.limit;
        sumCg += cg;
        const len = rec.lengthM > 0 ? rec.lengthM : 1;
        sumSpeedLen += rec.speed * len;
        lenSum += len;
        if (rec.speed < minSpeed) { minSpeed = rec.speed; slowest = rec; }
        if (rec.speed > maxSpeed) { maxSpeed = rec.speed; fastest = rec; }
      }
      const n = roads.length;
      c.list = raw;
      c.roads = roads;
      c.byWayId = byWayId;
      c.counts = counts;
      c.total = Number(res && res.total) || n;
      c.truncated = !!(res && res.truncated);
      c.meanSpeed = n ? Math.round((sumSpeed / n) * 10) / 10 : 0;
      c.meanLimit = n ? Math.round((sumLimit / n) * 10) / 10 : 0;
      c.meanSpeedByLength = lenSum ? Math.round((sumSpeedLen / lenSum) * 10) / 10 : 0;
      c.meanCongestion = n ? Math.round((sumCg / n) * 1000) / 1000 : 0;
      c.minSpeed = n ? minSpeed : 0;
      c.maxSpeed = n ? maxSpeed : 0;
      c.slowest = slowest ? { wayId: slowest.wayId, kind: slowest.kind, speed: slowest.speed, limit: slowest.limit, congestion: slowest.congestion, level: slowest.level } : null;
      c.fastest = fastest ? { wayId: fastest.wayId, kind: fastest.kind, speed: fastest.speed, limit: fastest.limit, congestion: fastest.congestion, level: fastest.level } : null;
      c.serverStats = (res && res.stats) || null;
      c.bbox = box || c.requestBox;
      c.key = Render.congestionKeyOf(c.bbox);
      c.error = null;
      c.loadedAt = Date.now();
      c.ms = ms || 0;
      if (Render.onCongestion) {
        try { Render.onCongestion(c); } catch { /* 面板的回调出错不影响渲染 */ }
      }
      return c;
    },

    /** 取不到拥堵数据 → 退回普通配色 + 中文提示（只弹一次，绝不刷屏） */
    congestionHint(reason) {
      const c = Render.congestion;
      if (c.hinted) return false;
      c.hinted = true;
      const why = reason || c.error || '服务器没有提供拥堵数据';
      util.toast(`拥堵数据暂时取不到（${why}）：道路已按普通配色显示`, 'warn', 5200);
      return true;
    },

    /** 拥堵数据是否可用（拿到过、没报错、还有路） */
    congestionReady() {
      const c = Render.congestion;
      return !!c.loadedAt && !c.error && c.roads.length > 0;
    },

    /** 一条 way 是不是"道路拥堵"该上色的对象：机动车道，且不是铁路/电车 */
    isCongestionRoad(tags) {
      if (!tags || !tags.highway) return false;
      if (tags.railway) return false;                 // 铁路/电车/轻轨：绝不上拥堵色
      return true;
    },

    /**
     * 这个 kind 在服务器的拥堵路网里是不是"可通行的机动车道"。
     * 服务器的 way 表里既有道路也有轨道，所以两样都要排掉：
     *   · 机动车不能走的等级（footway / path / steps …）；
     *   · 轨道类型（rail / subway / tram / light_rail …）—— 列车不堵车，没有拥堵系数。
     */
    isDrivableRoadKind(kind) {
      const k = kind == null ? '' : String(kind).trim();
      if (!k) return false;
      if (Render.CONGESTION_RAIL_KINDS.has(k)) return false;
      return !Render.CONGESTION_FORBIDDEN.has(k);
    },

    /** 拥堵档位：优先用服务器给的 level，没有就按系数推（≥0.75 畅通 / ≥0.5 一般 / 其余拥堵） */
    congestionLevel(rec) {
      const lv = rec && rec.level;
      if (lv === 'free' || lv === 'busy' || lv === 'jam') return lv;
      const cg = Number(rec && rec.congestion);
      if (!Number.isFinite(cg)) return 'unknown';
      return cg >= 0.75 ? 'free' : (cg >= 0.5 ? 'busy' : 'jam');
    },

    /** 某一档的主色（图例与地图用同一份定义） */
    congestionLevelColor(level) {
      const s = Render.congestionScale;
      return s.colors[level] || s.unknown;
    },

    /**
     * 拥堵 → 颜色：主色由档位定（绿/琥珀/红），档内再按"服务速度 / 限速"微调明暗
     * （越接近限速越亮），所以一眼能分出三档，同档里也能看出轻重。
     */
    colorForCongestion(rec) {
      const r = (typeof rec === 'number') ? { congestion: rec } : (rec || {});
      const level = Render.congestionLevel(r);
      const hex = Render.congestionLevelColor(level);
      if (level === 'unknown') return hex;
      const limit = Number(r.limit);
      const speed = Number(r.speed);
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(speed)) return hex;
      const s = Render.congestionScale;
      const ratio = Math.max(0, Math.min(1, speed / limit));
      return util.shade(hex, s.shadeMin + (s.shadeMax - s.shadeMin) * ratio);
    },

    /**
     * 渲染层用：这条 way 在拥堵模式下该画什么颜色。
     * 返回 null = **交回普通配色**（没进拥堵模式 / 数据取不到 / 不属于拥堵口径）。
     *   · 铁路、电车、步道：null（照常画，不上拥堵色）；
     *   · 查不到的道路（新画的路、服务器路网没建到）：中性灰 —— 不知道就说不知道；
     *   · 数据取失败/还没到时，所有道路都返回 null（画面退回普通配色，不是一片灰）。
     */
    congestionColorFor(way) {
      if (!way || !Render.isCongestionRoad(way.tags)) return null;
      const c = Render.congestion;
      if (!Render.congestionReady()) return null;
      const rec = c.byWayId.get(way.id);
      if (rec) return Render.colorForCongestion(rec);
      return Render.isDrivableRoadKind(way.tags.highway) ? Render.congestionScale.unknown : null;
    },

    /** 刷新按钮用：强制按当前视野重取一次 */
    refreshCongestion() {
      return Render.ensureCongestion(true);
    },

    /**
     * 拥堵统计（图层面板的图例、状态栏、自检都用它）：
     * levels = 三档条数；meanSpeed = 视野内平均服务速度（km/h，另有按长度加权的 meanSpeedByLength）。
     */
    congestionStats() {
      const c = Render.congestion;
      const n = c.roads.length;
      return {
        mode: 'congestion',
        ready: Render.congestionReady(),
        loading: !!c.loading,
        error: c.error || null,
        ways: n,                                   // 视野内拿到的可通行道路数（已剔除轨道）
        total: c.total || 0,                        // 服务器匹配到的总数（可能被 limit 截断）
        truncated: !!c.truncated,
        limit: Render.congestionLimit,
        levels: {                                  // ★ 每档条数
          free: c.counts.free || 0,
          busy: c.counts.busy || 0,
          jam: c.counts.jam || 0,
        },
        excluded: c.counts.other || 0,              // 被剔除的非道路成员（轨道等）
        meanSpeed: c.meanSpeed || 0,                // ★ 视野内平均服务速度 km/h
        meanSpeedByLength: c.meanSpeedByLength || 0,
        meanLimit: c.meanLimit || 0,
        meanCongestion: c.meanCongestion || 0,
        minSpeed: c.minSpeed || 0,
        maxSpeed: c.maxSpeed || 0,
        slowest: c.slowest || null,
        fastest: c.fastest || null,
        bbox: c.bbox ? Object.assign({}, c.bbox) : null,
        gridDeg: Render.congestionGridDeg,
        requests: c.requests || 0,
        loadedAt: c.loadedAt || 0,
        ms: c.ms || 0,
        serverStats: c.serverStats || null,
        text: n
          ? `视野内 ${n} 条道路 · 畅通 ${c.counts.free || 0} / 一般 ${c.counts.busy || 0} / 拥堵 ${c.counts.jam || 0}`
            + ` · 平均服务速度 ${c.meanSpeed || 0} km/h`
          : (c.error ? `拥堵数据取不到：${c.error}` : (c.loading ? '拥堵数据载入中…' : '还没有拥堵数据')),
      };
    },

    /**
     * transit op：road.congestion.way { id } —— 单条道路的拥堵明细（检查器/面板点某条路时用）。
     * 返回 Promise<{ way, coords? }>，失败会 reject。
     */
    fetchCongestionWay(id, withCoords) {
      const net = window.G && window.G.Net;
      if (!net || !net.connected || typeof net.send !== 'function') {
        return Promise.reject(new Error('未连接到服务器'));
      }
      const wayId = Number(id);
      if (!Number.isFinite(wayId)) return Promise.reject(new Error('way id 不合法'));
      const msgId = 'cgw' + (Render._cgSeq = (Render._cgSeq || 0) + 1).toString(36)
        + Math.random().toString(36).slice(2, 6);
      return new Promise((resolve, reject) => {
        const off = (msg) => {
          if (!msg || msg.id !== msgId) return false;
          clearTimeout(timer);
          if (msg.ok) resolve(msg.result || null);
          else reject(new Error(msg.error || '读取拥堵明细失败'));
          return true;
        };
        Render._cgWayWaiters = Render._cgWayWaiters || [];
        Render._cgWayWaiters.push(off);
        const timer = setTimeout(() => {
          const i = Render._cgWayWaiters.indexOf(off);
          if (i >= 0) Render._cgWayWaiters.splice(i, 1);
          reject(new Error('服务器响应超时'));
        }, Render.congestionTimeoutMs);
        net.send({ t: 'transit', id: msgId, op: { k: 'road.congestion.way', id: wayId, withCoords: withCoords === true } });
      });
    },

    /** 人口密度：每格人数 → 黄红渐变（半径方向用 sqrt 让低密度也看得见） */
    colorForPopulation(pop) {
      const s = Render.cellScale.population;
      const v = Math.max(0, Number(pop) || 0);
      if (v <= 0) return null;
      const t = Math.sqrt(Math.min(1, v / s.max));
      return Render.cssRgba(Render.mixStops(s.stops, t), 0.14 + 0.5 * t);
    },

    /** 活跃度：1.0 为基准的双向色标（冷清偏蓝、繁华偏红） */
    colorForActivity(a) {
      const s = Render.cellScale.activity;
      const v = Number(a);
      if (!Number.isFinite(v)) return null;
      let rgb;
      let strength;
      if (v >= s.base) {
        const t = Math.max(0, Math.min(1, (v - s.base) / (s.high - s.base)));
        rgb = Render.mixRgb(s.neutral, Render.mixRgb(s.far[0], s.far[1], t), t);
        strength = t;
      } else {
        const t = Math.max(0, Math.min(1, (s.base - v) / (s.base - s.low)));
        rgb = Render.mixRgb(s.neutral, Render.mixRgb(s.near[1], s.near[0], t), t);
        strength = t;
      }
      if (strength <= 0.02) return null;   // 基准格子不画，避免整屏铺一层灰
      return Render.cssRgba(rgb, 0.12 + 0.45 * strength);
    },

    cellColor(mode, cell) {
      if (mode === 'activity') return Render.colorForActivity(cell && cell.activity);
      return Render.colorForPopulation(cell && cell.pop);
    },

    /**
     * 图例模型（ui.js 拿它画色带，颜色只在这里定义，面板和地图不会跑偏）。
     *
     * 认四类取值：
     *   1) **颜色方案 id**（'linecolor' / 'company' / 'fare'，以及 'auto'）→ 公交分色的**分类**图例
     *      （entries 逐个色块）。子选项行下面那一格要的就是这个：Render.legendModel(Render.transitColorScheme())；
     *      'auto' 给的是"线路本色"那一份（每条线自己的颜色，含撞色兜底）。
     *   2) rail / bus / railbus（聚焦模式）→ 选了颜色方案时给当前方案的分类图例，没选（auto）则 null
     *      （老 ui.js 里这三种模式本来就没有图例，行为不变）。
     *   3) 底图配色模式 speed / congestion / population / activity → 各自的连续色带（它们管底图，优先级最高）。
     *   4) 其余（'normal' 等）→ null。
     */
    legendModel(mode) {
      const m0 = mode === undefined ? Render.displayMode : mode;
      // 1) 颜色方案（含 'auto'）：公交分色走自己的**分类**图例模型
      if (Render.isTransitColorScheme(m0)) return Render.transitLegendModel(m0);
      // 2) 轨交 / 公交模式：选过方案就把方案的图例给它（子选项行与图例同源）
      if (m0 === 'rail' || m0 === 'bus' || m0 === 'railbus') {
        return Render.transitColorSchemeChosen()
          ? Render.transitLegendModel(Render.transitColorSchemeEffective()) : null;
      }
      const m = m0;
      if (m === 'speed') {
        const s = Render.speedScale;
        return {
          title: '道路车速（有效限速）',
          gradient: s.stops,
          ticks: s.ticks.map((v) => ({ t: Render.speedT(v), label: v >= s.max ? v + '+' : String(v) })),
          note: '蓝=慢，红=快 · 优先用 maxspeed 标签，没写就按道路等级默认值',
        };
      }
      if (m === 'congestion') {
        const sc = Render.congestionScale;
        const c = Render.congestion;
        const n = c.roads.length;
        const note = n
          ? `绿=畅通，红=拥堵 · 视野内 ${n} 条（畅通 ${c.counts.free || 0} / 一般 ${c.counts.busy || 0} / 拥堵 ${c.counts.jam || 0}）`
            + ` · 平均服务速度 ${c.meanSpeed || 0} km/h`
          : (c.loading ? '拥堵数据载入中…'
            : (c.error ? `拥堵数据取不到（${c.error}）：道路已按普通配色显示`
              : '进入「道路拥堵」后按视野自动加载（服务端 transit op: road.congestion）'));
        return {
          // 从左到右：畅通 → 一般 → 拥堵（与地图上的绿→琥珀→红一致）
          title: '道路拥堵（服务速度 / 限速）',
          gradient: [
            { t: 0, rgb: Render.hexToRgb(sc.colors.free) || [22, 163, 74] },
            { t: 0.5, rgb: Render.hexToRgb(sc.colors.busy) || [234, 179, 8] },
            { t: 1, rgb: Render.hexToRgb(sc.colors.jam) || [220, 38, 38] },
          ],
          ticks: [
            { t: 0, label: '畅通 ≥0.75' },
            { t: 0.5, label: '一般 0.5~0.75' },
            { t: 1, label: '拥堵 <0.5' },
          ],
          note,
          // 面板可以直接读这些字段显示"三档各多少条 / 平均车速"
          ready: Render.congestionReady(),
          loading: !!c.loading,
          error: c.error || null,
          levels: { free: c.counts.free || 0, busy: c.counts.busy || 0, jam: c.counts.jam || 0 },
          meanSpeed: c.meanSpeed || 0,
          unknownColor: sc.unknown,
        };
      }
      if (m === 'population') {
        const s = Render.cellScale.population;
        const label = (v) => {
          if (v <= 0) return '0';
          if (v >= s.max) return (s.max / 10000) + '万+';
          if (v >= 10000) return (v / 10000) + '万';
          return (v / 1000) + '千';
        };
        return {
          title: '人口密度（每格人数）',
          gradient: s.stops,
          ticks: s.ticks.map((v) => ({ t: Math.sqrt(v / s.max), label: label(v) })),
          note: `每格 ${Render.cells.cellM}×${Render.cells.cellM} 米（约 ${(Render.cells.cellM * Render.cells.cellM / 1e6).toFixed(2)} km²）· 越红人越多`,
        };
      }
      if (m === 'activity') {
        const s = Render.cellScale.activity;
        const t0 = (s.base - s.low) / (s.high - s.low);
        return {
          title: '活跃度（繁华度系数）',
          gradient: [
            { t: 0, rgb: s.near[0] },
            { t: t0 * 0.5, rgb: s.near[1] },
            { t: t0, rgb: s.neutral },
            { t: t0 + (1 - t0) * 0.5, rgb: s.far[0] },
            { t: 1, rgb: s.far[1] },
          ],
          ticks: [
            { t: 0, label: s.low + ' 冷清' },
            { t: t0, label: s.base.toFixed(1) },
            { t: 1, label: s.high + ' 繁华' },
          ],
          note: '商业/枢纽/学校周边更高，纯绿地水面更低；1.0 是基准',
        };
      }
      return null;
    },

    /**
     * 图例里"浅色底 + 深色字"用：把颜色调成深一点的文字色。
     * 认的取值与 legendModel 完全一致（**包括颜色方案 id 与 'auto'**，
     * 分类配色也能拼成一根分块的 linear-gradient，见 categoricalStops）。
     */
    legendCss(mode) {
      const model = Render.legendModel(mode);
      if (!model || !model.gradient || !model.gradient.length) return '';
      return model.gradient.map((s) => `${Render.cssRgb(s.rgb)} ${Math.round(s.t * 100)}%`).join(', ');
    },

    /* ==========================================================================================
     *                    公交线路分色：颜色方案（独立于显示模式的一条轴）
     *
     * 三种分色（linecolor 线路本色 / company 按公司 / fare 按票价）现在是**颜色方案**，
     * 不是显示模式：先选「轨交模式 / 公交模式」（显示模式 + 聚焦），再在这个子选项行里选怎么上色。
     * 方案存在 Render.transitColorSchemeId 里，与 Render.displayMode 完全解耦 —— 显示模式管底图
     * （车速 / 拥堵 / 人口格子）与聚焦淡化，方案管公交（线路路径 / 车站圆点 / 车辆标记）的取色。
     *
     * 谁说话（同时设了以谁为准；自检里逐条验）：
     *   · 取色：**显式设的方案 > 旧的显示模式 id > auto（= 线路本色）**。
     *     `setTransitColorScheme('company')` 之后再 `setDisplayMode('normal')`，公交仍是公司色；
     *     而"直接写 Render.displayMode = 'company'"（老代码 / 老自检的写法）在方案是 auto 时仍然算数。
     *   · 别名：`setDisplayMode('linecolor'|'company'|'fare')` 同时设方案 + 显示模式（后调的说了算）。
     *     这类"跟着旧模式走"的方案在离开该显示模式时回到 auto（与旧行为一致，老 ui.js 不会变样）；
     *     而 setTransitColorScheme() 设的是**显式**方案，任何显示模式都清不掉它。
     *   · 图例：speed / congestion / population / activity 给各自的底图图例；
     *     方案 id（含 'auto'）给该方案的分类图例；rail / bus / railbus 在选了方案时给当前方案的图例。
     * ========================================================================================== */

    /** 三种颜色方案的 id（顺序就是子选项行里的顺序）；transitColorSchemes 是同义名 */
    transitColorModes: TRANSIT_COLOR_MODES,
    transitColorSchemes: TRANSIT_COLOR_MODES,
    /** 'auto' = 没选方案（= 线路本色：每条线自己的颜色 + 撞色兜底） */
    TRANSIT_COLOR_SCHEME_AUTO,

    /**
     * **当前颜色方案**：'auto' | 'linecolor' | 'company' | 'fare'。
     * 这就是那条"独立于显示模式的颜色字段"：直接读它拿到的是字符串
     * （想要函数形式用 Render.transitColorScheme()；写请用 setTransitColorScheme()，
     * 直接赋值也能生效，只是少了装钩子 / 作废缓存 / 重画这三件事）。
     */
    transitColorSchemeId: TRANSIT_COLOR_SCHEME_AUTO,
    /** 方案是怎么来的：'auto' 默认 / 'explicit' setTransitColorScheme() 设的 / 'mode' 旧 setDisplayMode 别名设的 */
    _transitColorSchemeSource: 'auto',
    /** 方案变化时的可选回调（面板接上就能重画子选项行与图例；没接也一切正常） */
    onTransitColorScheme: null,

    /**
     * 颜色方案：**不带参数 = 读，带参数 = 写**（同一个名字既是字段也是函数，省得再多一个名字）。
     *   Render.transitColorScheme()          → 'auto' | 'linecolor' | 'company' | 'fare'
     *   Render.transitColorScheme('company') → 等价于 Render.setTransitColorScheme('company')
     */
    transitColorScheme(id) {
      if (arguments.length === 0 || id === undefined) return Render.transitColorSchemeId;
      return Render.setTransitColorScheme(id);
    },

    /** 读当前方案（等价 Render.transitColorScheme()；给不喜欢"同名函数"的调用方） */
    getTransitColorScheme() { return Render.transitColorSchemeId; },

    /**
     * 设颜色方案（**只改公交配色，不动显示模式 / 聚焦**）。
     * @param {'auto'|'linecolor'|'company'|'fare'|null} id null / undefined / 认不出的值一律当 'auto'
     * @returns {string} 存下来的方案 id
     */
    setTransitColorScheme(id) {
      return Render.applyTransitColorScheme(id, 'explicit');
    },

    /**
     * 方案落库的**唯一入口**（旧别名 setDisplayMode 也走这里，所以"谁后调谁说话"只有一处实现）。
     * @param {string} id 方案 id
     * @param {'explicit'|'mode'} source 显式设置 / 旧显示模式别名
     */
    applyTransitColorScheme(id, source) {
      const s = Render.normalizeTransitColorScheme(id);
      Render.transitColorSchemeId = s;
      Render._transitColorSchemeSource = (s === TRANSIT_COLOR_SCHEME_AUTO) ? 'auto'
        : (source === 'mode' ? 'mode' : 'explicit');
      // 换方案 = 换一套颜色：装钩子（幂等）+ 作废配色缓存 + 重画覆盖画布（不重建底图）
      Render.installTransitColorHooks();
      Render.transitColorCacheBust();
      Render.scheduleOverlay();
      if (typeof Render.onTransitColorScheme === 'function') {
        try { Render.onTransitColorScheme(Render.transitColorSchemeId, Render._transitColorSchemeSource); } catch { /* 面板出错不影响配色 */ }
      }
      return Render.transitColorSchemeId;
    },

    /** 归一化方案 id：'auto' / null / undefined / '' / 认不出的一律 'auto'（绝不把脏值写进字段） */
    normalizeTransitColorScheme(id) {
      if (id === undefined || id === null) return TRANSIT_COLOR_SCHEME_AUTO;
      const s = String(id);
      return TRANSIT_COLOR_SCHEMES_ALL.indexOf(s) >= 0 ? s : TRANSIT_COLOR_SCHEME_AUTO;
    },

    /** 这个 id 是不是颜色方案（**含 'auto'**）；传 'speed' / 'rail' / 'normal' 之类一律 false */
    isTransitColorScheme(id) {
      return TRANSIT_COLOR_SCHEMES_ALL.indexOf(id) >= 0;
    },

    /**
     * 真正生效的方案（永远是具体三种之一，auto → linecolor）：
     *   1) 显式 / 别名设过的具体方案直接生效（**不管显示模式是什么** —— 这就是解耦）；
     *   2) 方案是 auto 时，"直接写 Render.displayMode = 'company'"这种老写法仍然算数；
     *   3) 否则 auto = 线路本色（每条线自己的颜色 + 撞色兜底）。
     */
    transitColorSchemeEffective() {
      const raw = Render.transitColorSchemeId;
      if (TRANSIT_COLOR_MODES.indexOf(raw) >= 0) return raw;
      const mode = Render.displayMode;
      if (TRANSIT_COLOR_MODES.indexOf(mode) >= 0) return mode;
      return 'linecolor';
    },

    /** 现在生效的是不是"选中的方案"（false = 还是 auto：每条线自己的颜色） */
    transitColorSchemeChosen() {
      if (TRANSIT_COLOR_MODES.indexOf(Render.transitColorSchemeId) >= 0) return true;
      return TRANSIT_COLOR_MODES.indexOf(Render.displayMode) >= 0;
    },

    /**
     * 颜色方案子选项清单：「轨交模式 / 公交模式」下面那一行直接用（id / name / short / ico / hint）。
     *   · active —— 现在生效的方案（auto 时"按线路色"那一项亮，因为 auto 就等于线路本色）；
     *   · chosen —— 玩家**显式**选中的那一项（auto 时三项都是 false）。
     * 旧名字 transitColorModeDefs() 返回同一份（老 ui.js 用它拼芯片，不动）。
     */
    transitColorSchemeDefs() {
      const eff = Render.transitColorSchemeEffective();
      const raw = Render.transitColorSchemeId;
      return TRANSIT_COLOR_MODE_DEFS.map((d) => ({
        id: d.id, name: d.name, short: d.short || d.name, ico: d.ico, hint: d.hint,
        active: eff === d.id, chosen: raw === d.id,
        auto: eff === d.id && raw !== d.id,   // 亮着但"没选"：auto 落到这一项
        scheme: d.id, mode: d.id,             // 兼容：它同时也是一个（旧的）显示模式 id
      }));
    },

    /** 方案定义（认不出返回 null）；不传就用当前生效的方案，传 'auto' 也给"线路本色"的定义 */
    transitColorSchemeDef(id) {
      const m = id === undefined ? Render.transitColorSchemeEffective()
        : (id === TRANSIT_COLOR_SCHEME_AUTO ? 'linecolor' : id);
      for (const d of TRANSIT_COLOR_MODE_DEFS) if (d.id === m) return d;
      return null;
    },

    /** 方案的中文名（图例标题 / 提示语用） */
    transitColorSchemeName(id) {
      const d = Render.transitColorSchemeDef(id);
      return d ? d.name : '';
    },

    /* ------------------------------ 旧名字（全部保留，等于上面的别名，老 ui.js / 老测试不动） ------------------------------ */

    /** 旧名：方案子选项清单（= transitColorSchemeDefs()） */
    transitColorModeDefs() { return Render.transitColorSchemeDefs(); },

    /** 旧名：方案定义；不传就用当前生效的方案 */
    transitColorModeDef(id) { return Render.transitColorSchemeDef(id); },

    /** 旧名：方案中文名 */
    transitColorModeName(id) { return Render.transitColorSchemeName(id); },

    /** 这个 id 是不是三种"公交分色"之一（**不含 'auto'**，语义与以前完全一致）；传 'speed' 之类一律 false */
    isTransitColorMode(mode) {
      const m = mode === undefined ? Render.displayMode : mode;
      return TRANSIT_COLOR_MODES.indexOf(m) >= 0;
    },

    /**
     * 线路本色模式下，两条线自带颜色撞了要不要给后来者换一个确定的备用色。
     * 默认开（撞色的线路在地图上根本分不开，等于没配色）；关掉就完全按玩家填的颜色画。
     */
    transitColorUniqueFallback: true,

    /** 开关"撞色备用色"；返回开关之后的状态。改完立刻重画公交图层（不重建底图） */
    setTransitUniqueFallback(on) {
      Render.transitColorUniqueFallback = !!on;
      Render.transitColorCacheBust();
      Render.scheduleOverlay();
      return Render.transitColorUniqueFallback;
    },

    /* ------------------------------ 交通数据（读不到一律给空表，绝不抛） ------------------------------ */

    /** 交通快照里的线路表 */
    transitLines() {
      const t = window.G && window.G.Transit;
      const d = t && t.data;
      return (d && Array.isArray(d.lines)) ? d.lines : [];
    },

    /** 交通快照里的公司表 */
    transitCompanies() {
      const t = window.G && window.G.Transit;
      const d = t && t.data;
      return (d && Array.isArray(d.companies)) ? d.companies : [];
    },

    /** 按 id 找线路（车辆上色要用；线路数量是几十条量级，线性找可接受，且只在上色时查） */
    transitLineById(id) {
      if (id === undefined || id === null) return null;
      for (const ln of Render.transitLines()) if (ln && ln.id === id) return ln;
      return null;
    },

    /** 票价参数：服务端 config.transit 优先；还没握手就用 config.json 的同值兜底 */
    transitFareConfig() {
      const t = window.G && window.G.Transit;
      const cfg = (t && t.config) || {};
      const base = Number(cfg.fareBase);
      const perKm = Number(cfg.farePerKm);
      const ok = Number.isFinite(base) && Number.isFinite(perKm);
      return {
        fareBase: ok ? base : TRANSIT_FARE_DEFAULT.fareBase,
        farePerKm: ok ? perKm : TRANSIT_FARE_DEFAULT.farePerKm,
        source: ok ? 'config.transit（服务端下发）' : '默认值 3 元 + 0.5 元/公里',
      };
    },

    /**
     * 线路里程：优先服务端算好的 pathLen（DB 里的 row.path_len，米）。
     * 没有就按 pathCoords 折线累加球面距离；再没有就退回 stopsInfo 里最远的站里程。
     * @returns {{lengthM:number, source:'pathLen'|'pathCoords'|'stopsInfo'|'none'}}
     */
    transitLineLength(line) {
      if (!line) return { lengthM: 0, source: 'none' };
      const len = Number(line.pathLen);
      if (Number.isFinite(len) && len > 0) return { lengthM: len, source: 'pathLen' };
      const coords = line.pathCoords;
      if (Array.isArray(coords) && coords.length > 1) {
        const m = util.lineLengthM(coords);
        if (Number.isFinite(m) && m > 0) return { lengthM: m, source: 'pathCoords' };
      }
      const info = Array.isArray(line.stopsInfo) ? line.stopsInfo : null;
      if (info && info.length) {
        let far = 0;
        for (const s of info) {
          const d = Number(s && s.distance);
          if (Number.isFinite(d) && d > far) far = d;
        }
        if (far > 0) return { lengthM: far, source: 'stopsInfo' };
      }
      return { lengthM: 0, source: 'none' };
    },

    /** 线路里程（米），只要数字 */
    transitLineLengthM(line) { return Render.transitLineLength(line).lengthM; },

    /**
     * 全程票价（元）= fareBase + farePerKm × 线路里程(km)。
     * 游戏里**没有"每条线单独定价"**，所以这就是票价口径：同一条线的票价由它的里程决定，
     * 里程没算出来（pathLen=0 且没有路径）时只收起步价。
     */
    transitFareYuan(lengthM) {
      const f = Render.transitFareConfig();
      const km = Math.max(0, Number(lengthM) || 0) / 1000;
      return f.fareBase + f.farePerKm * km;
    },

    /** 票价 → 档号（TRANSIT_FARE_BANDS 的下标；NaN 按起步价那一档） */
    transitFareBandIndex(fare) {
      const v = Number(fare);
      for (let i = 0; i < TRANSIT_FARE_BANDS.length; i++) if (!(v > TRANSIT_FARE_BANDS[i][0])) return i;
      return TRANSIT_FARE_BANDS.length - 1;
    },

    /* ------------------------------ 稳定取色（哈希 + 撞色兜底） ------------------------------ */

    /** 公司 / 车主的唯一 key：有 companyId 用 c:<id>，没有就用 o:<owner> */
    transitCompanyKey(companyId, owner) {
      if (companyId !== undefined && companyId !== null && companyId !== '') return 'c:' + companyId;
      if (owner !== undefined && owner !== null && owner !== '') return 'o:' + owner;
      return '';
    },

    /** transit.js 传进来的可能是公司 id（数字）或车主 user id（字符串），两种都认 */
    transitCompanyKeyOfValue(v) {
      if (v === undefined || v === null || v === '') return '';
      if (typeof v === 'number') return 'c:' + v;
      const s = String(v);
      return /^-?\d+$/.test(s) ? 'c:' + Number(s) : 'o:' + s;
    },

    /** 公司 key → 显示名（公司表里没有就用 id / 车主） */
    transitCompanyName(key) {
      const s = String(key || '');
      if (s.indexOf('c:') === 0) {
        const id = Number(s.slice(2));
        for (const co of Render.transitCompanies()) {
          if (co && co.id === id) return co.name || ('公司 #' + id);
        }
        return '公司 #' + id;
      }
      if (s.indexOf('o:') === 0) return '车主 ' + s.slice(2);
      return '未知归属';
    },

    /** FNV-1a 32 位哈希：Math.imul 保证任何机器上都是同一个数（这就是"跨客户端同色"的根） */
    hash32(str) {
      let h = 0x811c9dc5;
      const s = String(str == null ? '' : str);
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h >>> 0;
    },

    /** HSL → '#rrggbb'（必须是 hex：transit.js 里有 color + '22' 的拼接，rgb() 会被拼坏） */
    hslHex(h, s, l) {
      const hue = ((h % 1) + 1) % 1;
      const sat = Math.max(0, Math.min(1, s));
      const lig = Math.max(0, Math.min(1, l));
      const a = sat * Math.min(lig, 1 - lig);
      const f = (n) => {
        const k = (n + hue * 12) % 12;
        const v = lig - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
        return Math.round(255 * Math.max(0, Math.min(1, v)));
      };
      const h2 = (v) => v.toString(16).padStart(2, '0');
      return '#' + h2(f(0)) + h2(f(8)) + h2(f(4));
    },

    /**
     * 由 id 推颜色（salt = 撞色时换的第几次盐）：色相用黄金角铺开，饱和度 / 明度再错开三档。
     * 纯函数、没有随机数 —— 同一家公司、同一条线在任何会话、任何客户端上颜色都一样。
     */
    idColorHex(kind, id, salt) {
      const h = Render.hash32(String(kind || '') + ':' + (id == null ? '' : String(id)));
      const hue = (h / 4294967296) * TRANSIT_HUE_STEP + (salt || 0) * TRANSIT_HUE_SALT;
      const sat = TRANSIT_SAT[(h >>> 7) % TRANSIT_SAT.length];
      const lig = TRANSIT_LIGHT[(h >>> 13) % TRANSIT_LIGHT.length];
      return Render.hslHex(hue, sat, lig);
    },

    /**
     * 撞色兜底：按 id 找一个**确定**的、当前没被占用的颜色（salt 从 0 试到 TRANSIT_SALT_MAX）。
     * @param {Set|Map} taken 已经被占用的颜色（按 '#rrggbb'）
     * @returns {{hex:string, salt:number, unresolved:boolean}} unresolved=true 表示换满盐还撞（正常数据不会发生）
     */
    pickFreeColor(kind, id, taken) {
      for (let salt = 0; salt <= TRANSIT_SALT_MAX; salt++) {
        const cand = Render.idColorHex(kind, id, salt);
        if (!taken.has(cand)) return { hex: cand, salt, unresolved: false };
      }
      return { hex: TRANSIT_UNKNOWN_COLOR, salt: -1, unresolved: true };
    },

    /** '#rrggbb' 归一（大小写 / 空格）；认不出返回空串（= "这条线没填颜色"） */
    normalizeTransitHex(color) {
      const s = String(color == null ? '' : color).trim();
      return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : '';
    },

    /**
     * 这个颜色上该用黑字还是白字（按相对亮度算）。
     * 这是"颜色之外的第二条通道"里最便宜的一条：图例色块上的文字永远不会看不清。
     */
    transitTextOn(hex) {
      const rgb = Render.hexToRgb(hex) || [107, 114, 128];
      const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
      return lum > 0.62 ? '#111111' : '#ffffff';
    },

    /** 分类图例 → 分块的色标（每项占一段，段内不插值），面板拿去画 legend-bar 就是一格一色 */
    categoricalStops(entries) {
      const list = (entries || []).filter((e) => e && e.rgb);
      if (!list.length) return [];
      if (list.length === 1) {
        return [{ t: 0, rgb: list[0].rgb, hex: list[0].hex }, { t: 1, rgb: list[0].rgb, hex: list[0].hex }];
      }
      const out = [];
      const n = list.length;
      for (let i = 0; i < n; i++) {
        const e = list[i];
        out.push({ t: i / n, rgb: e.rgb, hex: e.hex });
        out.push({ t: i === n - 1 ? 1 : (i + 1) / n - 0.0001, rgb: e.rgb, hex: e.hex });
      }
      return out;
    },

    /* ------------------------------ 配色计划（缓存：每帧只查表，不重算） ------------------------------ */

    /** Map<方案 id, plan>：每个颜色方案一份"这批数据里谁是什么颜色"的查找表 */
    _tcPlans: null,

    /** 把配色缓存整块作废（换方案 / 交通数据改动 / 兜底开关变化时调它） */
    transitColorCacheBust() {
      Render._tcPlans = null;
      return true;
    },

    /**
     * 把任意取值解析成"配色计划的 id"（'linecolor' | 'company' | 'fare'），认不出返回 null。
     *   · 三种方案 id → 原样；
     *   · 'auto'（以及不传 = 当前方案）→ 解析成具体方案（auto 落在 'linecolor'，即"每条线自己的颜色"）；
     *   · 'speed' / 'normal' / 'rail' 这类 → null（它们不是颜色方案）。
     */
    transitColorSchemePlanId(mode) {
      const want = mode === undefined ? Render.transitColorSchemeEffective() : mode;
      if (!Render.isTransitColorScheme(want)) return null;
      return want === TRANSIT_COLOR_SCHEME_AUTO ? 'linecolor' : want;
    },

    /**
     * 取（必要时构建）某个颜色方案下的配色计划。**与显示模式无关**：方案设了就生效。
     * 失效条件全是 O(1) 的比较：交通数据换了引用 / 长度变了 / 兜底开关变了 / 计划被标脏
     * （某条线被就地改了颜色或归属、路径重算过）。
     * @param {string} [mode] 方案 id（'auto' 也算）；不传 = 当前生效的方案
     * @returns {object|null} null = 这个取值根本不是颜色方案
     */
    transitColorPlan(mode) {
      const m = Render.transitColorSchemePlanId(mode);
      if (!m) return null;
      const lines = Render.transitLines();
      const companies = Render.transitCompanies();
      const unique = Render.transitColorUniqueFallback !== false;
      const bag = Render._tcPlans || (Render._tcPlans = new Map());
      const c = bag.get(m);
      if (c && c.linesRef === lines && c.companiesRef === companies && c.unique === unique
        && c.lineCount === lines.length && !c.dirty) return c;
      const plan = Render.transitColorBuild(m, lines, companies, unique);
      bag.set(m, plan);
      return plan;
    },

    /**
     * 真正算一遍配色（只在数据 / 方案变化时跑，不是每帧）。
     * `mode` 一律是具体方案 id（'linecolor' / 'company' / 'fare'，'auto' 在 transitColorPlan 里已解析成 'linecolor'）。
     * 公司 key 先**排序**再依次占色，所以"谁先挑色"只取决于 id，和数据的到达顺序无关 ——
     * 这是"同一家公司、同一条线在任何客户端上颜色都一样"的实现方式。
     */
    transitColorBuild(mode, lines, companies, unique) {
      const plan = {
        mode, linesRef: lines, companiesRef: companies, unique, dirty: false,
        lineCount: lines.length, built: Date.now(),
        line: new Map(),            // lineId → 记录（hex / 里程 / 票价 / 档 / 签名）
        company: new Map(),         // 公司 key → 记录（hex / 平均票价档 / 线路数）
        companyKey: new Map(),      // 公司 key → 公司对象（图例显示名字用；没有就是 null）
        stationBand: null,          // stationId → 最便宜的服务线路票价档（票价模式下的车站色）
        recs: [],                   // 线路记录列表（图例 / 统计用）
        bands: TRANSIT_FARE_BANDS.map((b, i) => ({ index: i, max: b[0], name: b[1], hex: b[2], lines: 0 })),
        fare: Render.transitFareConfig(),
        collisions: 0,              // 哈希撞色、换盐解决的次数
        duplicates: 0,              // 自带颜色撞车、被换成备用色的线条数
        unresolved: 0,              // 换满盐还是撞（正常数据下恒为 0）
        lenSource: { pathLen: 0, pathCoords: 0, stopsInfo: 0, none: 0 },
        used: new Set(),
      };
      // 0) 公司表先入 key 集合（公司表里有、但暂时没有线路的公司也要有颜色）
      for (const co of companies) {
        const k = Render.transitCompanyKey(co && co.id, co && co.owner);
        if (k && !plan.companyKey.has(k)) plan.companyKey.set(k, co);
      }
      // 1) 每条线的里程 / 票价 / 票价档 / 归属（三个模式都要用）
      for (const ln of lines) {
        if (!ln || ln.id === undefined || ln.id === null) continue;
        const key = Render.transitCompanyKey(ln.companyId, ln.owner);
        if (key && !plan.companyKey.has(key)) plan.companyKey.set(key, null);   // 归属有、公司表里没有
        const li = Render.transitLineLength(ln);
        const fare = Render.transitFareYuan(li.lengthM);
        const band = Render.transitFareBandIndex(fare);
        if (plan.lenSource[li.source] !== undefined) plan.lenSource[li.source] += 1;
        const rec = {
          id: ln.id, name: ln.name, kind: ln.kind, lenM: li.lengthM, lenSource: li.source,
          fare, band, companyKey: key, color: ln.color, hex: null, authored: null, fallback: false,
          // 签名：就地改颜色 / 换公司 / 路径重算 都要能被发现（比较不分配字符串）
          sigColor: ln.color, sigCompany: ln.companyId, sigOwner: ln.owner,
          sigLen: ln.pathLen, sigCoords: ln.pathCoords, sigStops: ln.stopsInfo,
        };
        plan.recs.push(rec);
        plan.line.set(ln.id, rec);
        plan.bands[band].lines += 1;
      }
      const keys = Array.from(plan.companyKey.keys()).sort();
      const used = plan.used;
      // 2) 公司颜色
      if (mode === 'company') {
        for (const k of keys) {
          const pick = Render.pickFreeColor('company', k, used);
          if (pick.unresolved) plan.unresolved += 1;
          else if (pick.salt > 0) plan.collisions += 1;
          used.add(pick.hex);
          plan.company.set(k, {
            key: k, hex: pick.hex, band: -1, lines: 0, collision: pick.salt > 0,
            name: Render.transitCompanyName(k),
          });
        }
      } else if (mode === 'fare') {
        // 票价模式下的车站 / 车辆色：公司名下线路的**平均票价档**（同一家公司一个颜色）
        const agg = new Map();
        for (const r of plan.recs) {
          if (!r.companyKey) continue;
          const e = agg.get(r.companyKey) || { n: 0, s: 0 };
          e.n += 1;
          e.s += r.band;
          agg.set(r.companyKey, e);
        }
        for (const k of keys) {
          const e = agg.get(k);
          const band = e && e.n ? Math.round(e.s / e.n) : -1;
          plan.company.set(k, {
            key: k, hex: band >= 0 ? plan.bands[band].hex : TRANSIT_UNKNOWN_COLOR,
            band, lines: e ? e.n : 0, name: Render.transitCompanyName(k),
          });
        }
      }
      // 3) 线路颜色
      if (mode === 'linecolor') {
        /**
         * 自带颜色优先（== 现状）。按 id 从小到大依次占色：
         *   · 没填颜色 → 不动（返回 null，交给 transit.js 自己的默认色，等于现在的行为）；
         *   · 颜色与更早的线撞车 → 换成 id 哈希得到的确定备用色，并记账（可关，见 transitColorUniqueFallback）。
         */
        const taken = new Map();
        const sorted = plan.recs.slice().sort((a, b) => (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
        for (const r of sorted) {
          const authored = Render.normalizeTransitHex(r.color);
          if (!authored) continue;
          r.authored = authored;
          if (!taken.has(authored)) { taken.set(authored, r.id); r.hex = authored; continue; }
          if (!unique) { r.hex = authored; continue; }
          const pick = Render.pickFreeColor('line', r.id, taken);
          if (pick.unresolved) plan.unresolved += 1;
          taken.set(pick.hex, r.id);
          r.hex = pick.hex;
          r.fallback = true;
          plan.duplicates += 1;
        }
      } else if (mode === 'company') {
        for (const r of plan.recs) {
          const co = r.companyKey ? plan.company.get(r.companyKey) : null;
          if (co) { r.hex = co.hex; co.lines += 1; } else { r.hex = TRANSIT_UNKNOWN_COLOR; plan.unresolved += 1; }
        }
      } else {
        for (const r of plan.recs) r.hex = plan.bands[r.band].hex;
      }
      // 4) 票价模式额外算一张"车站 → 服务它的最便宜线路的票价档"（车站圆点用它上色）
      if (mode === 'fare') {
        const map = new Map();
        for (const ln of lines) {
          const rec = ln && plan.line.get(ln.id);
          if (!rec) continue;
          const stops = (Array.isArray(ln.stopsInfo) && ln.stopsInfo.length) ? ln.stopsInfo
            : (Array.isArray(ln.stops) ? ln.stops : null);
          if (!stops) continue;
          for (const s of stops) {
            const sid = (s && typeof s === 'object') ? s.stationId : s;
            if (sid === undefined || sid === null) continue;
            const cur = map.get(sid);
            if (cur === undefined || rec.band < cur) map.set(sid, rec.band);
          }
        }
        plan.stationBand = map;
      }
      Render.stats.transitColorLines = plan.recs.length;
      Render.stats.transitColorUnresolved = plan.unresolved;
      return plan;
    },

    /**
     * 查一条线在**当前模式**下的记录：命中就是 Map.get + 几次字段比较（不分配、不重算）。
     * 发现线路被就地改过（改颜色 / 换公司 / 路径重算 / 数组里多了一条）时把计划标脏重算一次。
     */
    transitLineRec(line) {
      const plan = Render.transitColorPlan();
      if (!plan || !line || line.id === undefined || line.id === null) return null;
      const rec = plan.line.get(line.id);
      if (rec) {
        if (rec.sigColor === line.color && rec.sigCompany === line.companyId && rec.sigOwner === line.owner
          && rec.sigLen === line.pathLen && rec.sigCoords === line.pathCoords && rec.sigStops === line.stopsInfo) {
          return rec;
        }
        plan.dirty = true;
        const p2 = Render.transitColorPlan();
        return (p2 && p2.line.get(line.id)) || null;
      }
      // 计划里没有这条线：数组换了引用或长度变了就重算一次再看
      if (plan.linesRef !== Render.transitLines() || plan.lineCount !== Render.transitLines().length) {
        plan.dirty = true;
        const p2 = Render.transitColorPlan();
        return (p2 && p2.line.get(line.id)) || null;
      }
      return null;
    },

    /* ------------------------------ 取色 API（transit.js 直接调这三个就接上了） ------------------------------ */

    /**
     * 这条线路在**当前颜色方案**下该用什么颜色（与显示模式无关：设了方案在哪儿都生效）。
     *   · 返回 '#rrggbb' —— 用这个颜色画线路；
     *   · 返回 null     —— "交给 transit.js 自己算"：方案是线路本色（含 auto）而这条线**没填颜色**时返回 null
     *                      （没填就该走 transit.js 的默认色，等于现状）。
     * 注意：线路本色的"没撞车的线"也返回它**自己的颜色**（值与原函数一致），
     * 判断"方案到底改没改这一条"用 transitLineColorMatches()。
     */
    transitLineColor(line) {
      const rec = Render.transitLineRec(line);
      if (!rec) return null;
      Render.stats.transitColorLookups += 1;
      if (rec.fallback) Render.stats.transitColorFallbacks += 1;
      return rec.hex || null;
    },

    /**
     * 这个方案会不会**真的改变**这条线的颜色（取色钩子用它决定"要不要转交原函数"）。
     *   · 线路本色（含 auto）：只有"撞色被换成备用色"的那几条算改色，其余一律交回 transit.js（像素级不变）；
     *   · 公司 / 票价：只要与线路自己填的颜色不同就算改色（没填颜色时也算 —— 方案接管取色）。
     */
    transitLineColorMatches(line) {
      const rec = Render.transitLineRec(line);
      if (!rec) return true;                       // 查不到这条线：别抢，交回原函数
      if (Render.transitColorSchemePlanId() === 'linecolor') return !rec.fallback;
      const authored = rec.authored || Render.normalizeTransitHex(rec.color);
      return !!authored && authored === rec.hex;
    },

    /**
     * 公司色（车站圆点 / 车辆标记）：transit.js 的 Transit.companyColor(id) 走这里。
     *   · company 方案：公司 id 的哈希色（同一家公司所有东西一个颜色）；
     *   · fare 方案：该公司名下线路的**平均票价档**色（公司在"票价水平"上的位置）；
     *   · 线路本色方案（含 auto）/ 认不出归属：null = 交给 transit.js
     *     （线路本色 = 现状：线路画自己的颜色，车站与车辆仍按公司自己的颜色画）。
     */
    transitCompanyColor(value) {
      const mode = Render.transitColorSchemeEffective();
      if (mode === 'linecolor') return null;
      const key = Render.transitCompanyKeyOfValue(value);
      if (!key) return null;
      const plan = Render.transitColorPlan();
      if (!plan) return null;
      const rec = plan.company.get(key);
      if (rec) { Render.stats.transitColorLookups += 1; return rec.hex; }
      // 票价方案：这家公司名下还没有线路 → 不知道"票价水平"，交回原色
      if (mode === 'fare') return null;
      // 公司方案：数据里还没有这家公司（刚建的公司 / 公司表还没到）→ 按 id 现算，仍然稳定
      return Render.idColorHex('company', key, 0);
    },

    /**
     * 车站圆点色（票价方案下比"公司平均档"更准，transit.js 想用就用它）：
     *   票价方案 → 服务这个站的线路里**最便宜**的那条的票价档（站上能买到的最低价）；
     *   其余方案 → 公司色（同上）。
     */
    transitStationColor(st) {
      if (!st) return null;
      const mode = Render.transitColorSchemeEffective();
      if (mode === 'linecolor') return null;
      if (mode === 'fare') {
        const plan = Render.transitColorPlan();
        const band = (plan && plan.stationBand) ? plan.stationBand.get(st.id) : undefined;
        if (band !== undefined && band !== null) return TRANSIT_FARE_BANDS[band][2];
      }
      return Render.transitCompanyColor(st.companyId === undefined ? st.owner : st.companyId);
    },

    /**
     * 车辆标记色（同上）：票价方案 → 它跑的那条线的票价档；其余方案 → 公司色。
     * 车辆有 lineId，所以票价方案下能给"按线路的票价"而不是公司平均档。
     */
    transitVehicleColor(v) {
      if (!v) return null;
      const mode = Render.transitColorSchemeEffective();
      if (mode === 'linecolor') return null;
      if (mode === 'fare') {
        const line = Render.transitLineById(v.lineId);
        const c = line ? Render.transitLineColor(line) : null;
        if (c) return c;
      }
      return Render.transitCompanyColor(v.companyId === undefined ? v.owner : v.companyId);
    },

    /** 统一入口：kind = 'line' | 'station' | 'vehicle'('train' 同义)；线路本色方案下按各自规则返回 */
    transitColorFor(kind, obj) {
      if (kind === 'line') return Render.transitLineColor(obj);
      if (kind === 'station') return Render.transitStationColor(obj);
      if (kind === 'vehicle' || kind === 'train') return Render.transitVehicleColor(obj);
      return null;
    },

    /* ------------------------------ 取色钩子（不改 transit.js 也能让线路/站/车一起换色） ------------------------------ */

    /**
     * 给交通模块装"取色钩子"（幂等，重复调用只装一层）：
     * transit.js 画线路 / 车站 / 车辆时调 `Transit.lineColor(line)` 与 `Transit.companyColor(id)`，
     * 这里把它们包一层 —— 取色只看**当前颜色方案**（不再看显示模式：设了方案在轨交 / 公交 / 普通
     * 任何模式下都生效）：
     *   · 线路：方案会改变这条线的颜色（公司 / 票价 / 撞色换备用色）→ 用方案色；否则原样转交原函数
     *     （所以线路本色 + 没撞色时 = 原函数返回值，普通模式像素级不变）；
     *   · 公司色：方案给得出公司色（公司 / 票价）→ 用方案色；线路本色（含 auto）→ 原样转交。
     * 钩子出错也绝不拖垮交通图层（catch 后走原函数）。
     *
     * 想更精确（车站按"最便宜的服务线路"、车辆按"自己跑的那条线"）的话，transit.js 直接改用
     * Render.transitStationColor / transitVehicleColor 即可，钩子留着也无害。
     *
     * @returns {boolean} 钩子是否就位（交通模块还没加载时返回 false，Render.init 之后再试）
     */
    installTransitColorHooks() {
      const T = window.G && window.G.Transit;
      if (!T) return false;
      if (T._osmcityColorHooks) return true;
      const origLine = typeof T.lineColor === 'function' ? T.lineColor : null;
      const origCompany = typeof T.companyColor === 'function' ? T.companyColor : null;
      T.lineColor = function (line) {
        try {
          if (!Render.transitLineColorMatches(line)) {
            const c = Render.transitLineColor(line);
            if (c) return c;
          }
        } catch { /* 配色出错：退回原函数，绝不把交通图层弄坏 */ }
        return origLine ? origLine.call(T, line) : null;
      };
      T.companyColor = function (id) {
        try {
          const c = Render.transitCompanyColor(id);
          if (c) return c;
        } catch { /* 同上 */ }
        return origCompany ? origCompany.call(T, id) : null;
      };
      T._osmcityColorHooks = { origLine, origCompany, at: Date.now() };
      return true;
    },

    /** 钩子装上了没有（面板 / 自检排查用） */
    transitColorHooksActive() {
      const T = window.G && window.G.Transit;
      return !!(T && T._osmcityColorHooks);
    },

    /** 拆掉钩子（自检 / 极端排查用；正常流程不需要） */
    uninstallTransitColorHooks() {
      const T = window.G && window.G.Transit;
      const h = T && T._osmcityColorHooks;
      if (!h) return false;
      if (h.origLine) T.lineColor = h.origLine;
      if (h.origCompany) T.companyColor = h.origCompany;
      delete T._osmcityColorHooks;
      return true;
    },

    /* ------------------------------ 图例模型（面板直接用） ------------------------------ */

    /** 太长的名字在刻度栏里截断（刻度只有一行） */
    transitShortLabel(s, n) {
      const str = String(s == null ? '' : s);
      const lim = Number.isFinite(Number(n)) ? Number(n) : 6;
      return str.length > lim ? str.slice(0, lim) + '…' : str;
    },

    /**
     * 颜色方案的图例模型（ui.js 的 legendModel(mode) 会转到它：mode 给方案 id，'auto' 也认）。
     * 除了通用的 title / gradient / ticks / note，还多给面板三样东西：
     *   · entries —— 逐项色块 [{key,label,hex,rgb,t,textOn,pattern,note,count}]（公司 / 票价档 / 线路）；
     *   · categorical = true —— 提醒面板"这是分类配色，不是连续色带"（legend-bar 会用分块色标）；
     *   · unknownColor / collisions / duplicates / unresolved —— 兜底与撞色的记账。
     * 另外给出 scheme / schemeId / auto，面板据此知道"现在这一份是哪个方案、是不是默认（auto）"。
     * 颜色与 legendCss / transitColorStats 用的是**同一份**数据，图例和地图不会跑偏。
     */
    transitLegendModel(mode) {
      // 取值：方案 id（'auto' 也算）/ 具体方案 id；不传 = 当前生效的方案；认不出（'speed' 之类）→ null
      const want = mode === undefined ? Render.transitColorSchemeEffective() : mode;
      const m = Render.transitColorSchemePlanId(want);
      if (!m) return null;
      const def = Render.transitColorSchemeDef(m);
      const plan = Render.transitColorPlan(m);
      const out = {
        mode: m,                       // 具体的方案 id（'auto' 已解析成 'linecolor'）
        scheme: m,
        schemeId: Render.normalizeTransitColorScheme(want),   // 请求时给的那个值（可能是 'auto'）
        auto: Render.normalizeTransitColorScheme(want) === TRANSIT_COLOR_SCHEME_AUTO,
        modeName: def ? def.name : '公交线路分色',
        title: def ? def.name : '公交线路分色',
        categorical: true,
        gradient: [],
        ticks: [],
        entries: [],
        note: '',
        unknownColor: TRANSIT_UNKNOWN_COLOR,
        companyCount: 0,
        lineCount: plan ? plan.recs.length : 0,
        collisions: plan ? plan.collisions : 0,
        duplicates: plan ? plan.duplicates : 0,
        unresolved: plan ? plan.unresolved : 0,
      };
      if (!plan) {
        out.note = '交通数据还没到（连上服务器后自动出现）';
        return out;
      }
      const entries = [];
      if (m === 'company') {
        const keys = Array.from(plan.company.keys()).sort();
        out.companyCount = keys.length;
        /**
         * 图例只列前 24 家（服务器上可能有几百家公司：全列出来面板会被色块淹没），
         * 排序规则 = "地图上真有线路的公司优先、线路多的优先" —— 图例先说清屏幕上看得见的东西，
         * 剩下的家数用 entryTotal - entries.length 在刻度/说明里体现。
         */
        const list = keys.map((k) => plan.company.get(k)).filter(Boolean);
        list.sort((a, b) => (b.lines || 0) - (a.lines || 0) || (a.key < b.key ? -1 : 1));
        out.entryTotal = list.length;
        for (const co of list.slice(0, 24)) {
          entries.push({
            key: co.key, label: co.name || Render.transitCompanyName(co.key), hex: co.hex,
            count: co.lines || 0, note: `${co.lines || 0} 条线路`,
          });
        }
      } else if (m === 'fare') {
        for (const b of plan.bands) {
          entries.push({
            key: 'band' + b.index, label: b.name, hex: b.hex,
            count: b.lines, note: `${b.lines} 条线路`,
          });
        }
      } else {
        // 线路本色：按里程从长到短列前 12 条（撞色换成备用色的那几条标出来）
        const sorted = plan.recs.slice().sort((a, b) => (b.lenM - a.lenM) || (a.id < b.id ? -1 : 1));
        for (const r of sorted.slice(0, 12)) {
          entries.push({
            key: 'line' + r.id, label: r.name || ('线路 #' + r.id), hex: r.hex,
            count: 1, note: r.fallback ? '与更早的线路撞色 → 已换备用色' : (r.authored || ''),
          });
        }
        out.lineCount = plan.recs.length;
      }
      const n = entries.length || 1;
      out.entries = entries.map((e, i) => {
        const hex = e.hex || TRANSIT_UNKNOWN_COLOR;
        return {
          key: e.key, label: e.label, hex,
          rgb: Render.hexToRgb(hex) || [107, 114, 128],
          t: entries.length > 1 ? i / (entries.length - 1) : 0,
          textOn: Render.transitTextOn(hex),
          pattern: TRANSIT_PATTERNS[i % TRANSIT_PATTERNS.length],
          count: e.count || 0,
          note: e.note || '',
          unknown: hex === TRANSIT_UNKNOWN_COLOR,
        };
      });
      out.gradient = Render.categoricalStops(out.entries);
      // 刻度栏只有一行（面板里是 flex space-between），所以每档给短标签，最多 6 个
      if (m === 'fare') {
        out.ticks = out.entries.map((e, i) => ({ t: out.entries.length > 1 ? i / (out.entries.length - 1) : 0, label: e.label }));
        const used = out.entries.filter((e) => e.count > 0).map((e) => `${e.label} ${e.count} 条`).join(' / ');
        out.note = `票价 = ${plan.fare.fareBase} 元 + ${plan.fare.farePerKm} 元/公里 × 线路里程`
          + `（里程取 pathLen，缺失时按路径折线算）· ${used || '视野里还没有线路'}`;
      } else if (m === 'company') {
        out.ticks = (out.entries.length > 6 ? out.entries.slice(0, 6) : out.entries)
          .map((e) => ({ t: e.t, label: Render.transitShortLabel(e.label, 5) }));
        if (!out.ticks.length) out.ticks = [{ t: 0, label: '暂无公司' }];
        const shown = out.entries.filter((e) => e.count > 0).length;
        out.note = `同一家公司一个颜色（公司 id 哈希 → 黄金角铺色，跨会话 / 跨客户端都一样）`
          + ` · ${out.companyCount} 家公司 / ${out.lineCount} 条线路`
          + (shown < out.companyCount ? ` · 图例先列有线路的 ${shown} 家` : '')
          + (out.collisions ? ` · 哈希撞色换色 ${out.collisions} 次` : '')
          + (out.unresolved ? ` · ${out.unresolved} 项无法区分（已用灰色 + 图例形状通道标注）` : '');
      } else {
        out.ticks = [
          { t: 0, label: `${out.lineCount} 条线路` },
          { t: 1, label: out.duplicates ? `${out.duplicates} 条撞色已区分` : '颜色不重复' },
        ];
        out.note = `每条线画自己的颜色（默认表现${out.auto ? '；auto = 没选方案，就是这一套' : ''}）`
          + (out.duplicates
            ? ` · 其中 ${out.duplicates} 条与更早的线路撞色，已换成 id 哈希得到的确定备用色`
              + `（可在控制台 Render.setTransitUniqueFallback(false) 关掉）`
            : ' · 没有撞色');
      }
      return out;
    },

    /* ------------------------------ 统计（面板 / 自检 / 排查） ------------------------------ */

    /**
     * 颜色方案 / 票价定义 / 公司表 / 线路表（含里程 / 票价 / 档 / 颜色 / 是不是兜底色），
     * 以及"撞色解决了多少次 / 还有多少项没解决 / 钩子装没装"。
     * 全部从缓存好的计划里读，不重算；线路表最多 200 条（面板够用）。
     * 方案与显示模式都在这里如实报告（active = 公交配色**正在生效**：
     * 显式/别名设过方案，或者显示模式还是那三个旧的分色 id）。
     */
    transitColorStats() {
      const mode = Render.displayMode;
      const scheme = Render.transitColorSchemeId;
      const effective = Render.transitColorSchemeEffective();
      const active = Render.transitColorSchemeChosen();
      const plan = Render.transitColorPlan();
      const f = Render.transitFareConfig();
      const out = {
        mode, active,
        modeName: Render.transitColorSchemeName(effective),
        modes: Render.transitColorSchemeDefs(),
        // 颜色方案（与显示模式无关的那条轴）
        scheme,
        schemeName: Render.transitColorSchemeName(scheme),
        schemeSource: Render._transitColorSchemeSource,
        effectiveScheme: effective,
        schemes: TRANSIT_COLOR_MODES.slice(),
        schemeAuto: scheme === TRANSIT_COLOR_SCHEME_AUTO,
        schemeChosen: active,
        focus: Render.focus,
        fare: {
          fareBase: f.fareBase,
          farePerKm: f.farePerKm,
          source: f.source,
          formula: '票价(元) = fareBase + farePerKm × 线路里程(km)',
          lengthSource: '优先 pathLen（服务端 row.path_len）；缺失时按 pathCoords 折线累加；再缺就用 stopsInfo 最远站里程',
          lengthSourceCount: plan ? Object.assign({}, plan.lenSource) : null,
        },
        uniqueFallback: Render.transitColorUniqueFallback !== false,
        hooksInstalled: Render.transitColorHooksActive(),
        stations: Render.stationList().length,
        trains: (function () {
          const t = window.G && window.G.Transit;
          const list = t && t.data && t.data.trains;
          return Array.isArray(list) ? list.length : 0;
        }()),
        companies: [],
        lines: [],
        bands: [],
        distinctColors: 0,
        collisions: plan ? plan.collisions : 0,
        duplicates: plan ? plan.duplicates : 0,
        unresolved: plan ? plan.unresolved : 0,
        lookups: Render.stats.transitColorLookups || 0,
        fallbackHits: Render.stats.transitColorFallbacks || 0,
        text: '',
      };
      if (!plan) {
        // 理论上到不了（transitColorPlan() 对任何方案都给得出计划），留着当兜底说明
        out.text = `配色计划取不到（方案 ${scheme}）：公交配色按各自原有的颜色画`;
        return out;
      }
      const hexes = new Set();
      for (const [k, rec] of plan.company) {
        out.companies.push({
          key: k, id: k.indexOf('c:') === 0 ? Number(k.slice(2)) : null,
          name: rec.name || Render.transitCompanyName(k), hex: rec.hex,
          band: rec.band === undefined ? -1 : rec.band, lines: rec.lines || 0, collision: !!rec.collision,
        });
      }
      out.companies.sort((a, b) => (a.key < b.key ? -1 : 1));
      for (const r of plan.recs) {
        if (r.hex) hexes.add(r.hex);
        if (out.lines.length >= 200) continue;      // 面板够用就行（颜色仍按全量统计）
        out.lines.push({
          id: r.id, name: r.name || ('线路 #' + r.id), kind: r.kind || '',
          companyKey: r.companyKey, companyName: r.companyKey ? Render.transitCompanyName(r.companyKey) : '无归属',
          lengthM: Math.round(r.lenM), lengthSource: r.lenSource,
          fare: Math.round(r.fare * 1000) / 1000, band: r.band, bandName: plan.bands[r.band].name,
          hex: r.hex || '', authored: r.authored, fallback: !!r.fallback,
        });
      }
      out.bands = plan.bands.map((b) => ({ index: b.index, name: b.name, hex: b.hex, lines: b.lines }));
      out.distinctColors = hexes.size;
      // 文案按**生效的方案**说（显示模式已经管不着公交配色了）
      if (!active) {
        out.text = `颜色方案是 auto（= 线路本色，每条线画自己的颜色 + 撞色兜底）`
          + ` · 显示模式 ${mode}：底图配色由显示模式决定，公交取色不受影响`
          + (out.duplicates ? ` · ${out.duplicates} 条撞色已换成确定的备用色` : ' · 没有撞色');
      } else if (effective === 'company') {
        out.text = `按公交公司分色：${out.companies.length} 家公司 / ${out.lines.length} 条线路 · ${out.distinctColors} 种颜色`
          + (out.collisions ? ` · 哈希撞色换色 ${out.collisions} 次` : '')
          + (out.unresolved ? ` · ${out.unresolved} 项无法区分` : '');
      } else if (effective === 'fare') {
        const used = out.bands.filter((b) => b.lines > 0).map((b) => `${b.name} ${b.lines} 条`).join(' / ');
        out.text = `按票价分色：票价 = ${f.fareBase} 元 + ${f.farePerKm} 元/公里 × 里程 · ${used || '视野里还没有线路'}`;
      } else {
        out.text = `按线路色分色：${out.lines.length} 条线路用自己的颜色`
          + (out.duplicates ? ` · ${out.duplicates} 条与更早的线路撞色，已换成确定的备用色` : ' · 没有撞色');
      }
      return out;
    },

    /* ------------------------------ 颜色小工具 ------------------------------ */
    hexToRgb(hex) {
      const h = String(hex || '').replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      if (full.length !== 6) return null;
      const n = parseInt(full, 16);
      if (!Number.isFinite(n)) return null;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    },

    mixRgb(a, b, t) {
      const k = Math.max(0, Math.min(1, t));
      return [
        Math.round(a[0] + (b[0] - a[0]) * k),
        Math.round(a[1] + (b[1] - a[1]) * k),
        Math.round(a[2] + (b[2] - a[2]) * k),
      ];
    },

    mixStops(stops, t) {
      const list = stops && stops.length ? stops : [{ t: 0, rgb: [0, 0, 0] }];
      const k = Math.max(0, Math.min(1, t));
      if (k <= list[0].t) return list[0].rgb;
      for (let i = 1; i < list.length; i++) {
        if (k <= list[i].t) {
          const a = list[i - 1];
          const b = list[i];
          const span = b.t - a.t || 1;
          return Render.mixRgb(a.rgb, b.rgb, (k - a.t) / span);
        }
      }
      return list[list.length - 1].rgb;
    },

    cssRgb(rgb) { return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; },

    cssRgba(rgb, a) { return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`; },

    /** 车站覆盖范围圆盘颜色：轨道站偏红、公交站偏黄，叠在一起像热力图 */
    stationCatchmentColor(st) {
      const kind = String((st && st.kind) || '');
      return kind === 'bus' ? [245, 158, 11] : [232, 92, 40];
    },

    /** 骨架类要素：道路主干、铁路、水系、大面积用地、行政边界 —— 缩小时必须保留 */
    isSkeleton(tags) {
      if (!tags) return false;
      const hw = tags.highway;
      if (hw && ['motorway', 'trunk', 'motorway_link', 'trunk_link', 'primary', 'primary_link'].includes(hw)) return true;
      if (tags.railway && ['rail', 'narrow_gauge', 'light_rail', 'subway'].includes(tags.railway)) return true;
      if (tags.waterway || tags.natural === 'water' || tags.natural === 'coastline') return true;
      if (tags.landuse || tags.natural) return true;
      if (tags.boundary === 'administrative') return true;
      if (tags.place) return true;
      return false;
    },

    /**
     * 装饰性面的分级门槛（绿地 / 水面 / 小面积用地 / 建筑 / POI）。
     *
     * **只用于装饰性面**：道路、铁路、水系干线等线要素在渲染层永不分级
     * （detailAllows 对线要素直接返回 true），所以道路不会因为"要素太多"被藏起来。
     * 只有玩家把详细度切到"标准/精简/骨架"时才用得上这里的阈值；"完整"档一块都不丢。
     *
     * 门槛 = 基础表 + lodBias（玩家档位的额外偏移，永不自动改动）+ 档位偏置
     * （"标准"档对**非骨架面**再 +1；水域/大片用地/边界不加，它们是底图底色）。
     */
    lodMinZoom(tags, kind, level) {
      const lv = level == null ? Render.clampDetail(Render.detail) : Render.clampDetail(level);
      if (!tags) return 18;
      const t = tags;
      const skeleton = Render.isSkeleton(t);
      const bias = skeleton ? 0 : (Render.lodBias || 0) + (kind === 'point' ? 0 : Render.fillZoomBias(lv));
      let z;

      if (kind === 'point') {
        if (t.place) z = t.place === 'city' ? 7 : t.place === 'town' ? 10 : 12;
        else if (t.natural === 'peak') z = 12;
        else if (t.railway === 'station' || t.railway === 'halt' || t.public_transport === 'station') z = 13;
        else if (t.highway === 'motorway_junction') z = 14;
        else if (t.amenity === 'hospital' || t.amenity === 'police' || t.amenity === 'fire_station' || t.amenity === 'fuel') z = 16;
        else if (t.amenity || t.shop || t.tourism || t.office || t.craft || t.leisure || t.historic || t.healthcare || t.emergency || t.public_transport) z = 17;
        else z = 18;
        return z + bias;
      }

      const hw = t.highway;
      // 道路/铁路这类线要素：不分级（返回 0），只有"骨架档"才会通过 detailAllows 过滤
      if (hw || t.railway || t.waterway || t.boundary === 'administrative') return 0;
      if (t.natural === 'water' || t.natural === 'coastline' || t.waterway === 'riverbank') return 9;

      if (t.building || t['building:part']) {
        // 重要建筑（有名字、层数高、公共设施）早一档显示，普通房子晚一档
        const levels = parseFloat(String(t['building:levels'] || '0').replace(/[^\d.]/g, '')) || 0;
        if (t.name || levels >= 5 || t.amenity || t.shop || t.tourism) return 15 + bias;
        return 16 + bias;
      }
      if (t.landuse) {
        // 城市尺度先把大片用地收起来（谷歌/百度地图在整城视图也只给路网和水系）
        if (t.landuse === 'forest') return 11 + bias;
        if (t.landuse === 'residential' || t.landuse === 'village' || t.landuse === 'grass' || t.landuse === 'meadow') return 13 + bias;
        return 14 + bias;
      }
      if (t.natural) {
        if (t.natural === 'wood') return 11 + bias;
        return 13 + bias;
      }
      if (t.leisure) {
        if (t.leisure === 'park' || t.leisure === 'nature_reserve') return 12 + bias;
        if (t.leisure === 'golf_course') return 13 + bias;
        return 15 + bias;
      }
      if (t.boundary === 'administrative') {
        const lvl = Number(t.admin_level) || 8;
        return (lvl <= 4 ? 5 : lvl <= 6 ? 8 : lvl <= 8 ? 11 : 13) + bias;
      }
      if (t.amenity || t.shop || t.tourism || t.office || t.man_made || t.aeroway || t.power || t.barrier || t.military || t.healthcare || t.public_transport) return 15 + bias;
      return 17 + bias;
    },

    /* --------------------------- 轮廓清理（异形楼必需） --------------------------- */
    /** 短于此长度（屏幕像素）的边算退化边，直接丢弃 */
    MIN_EDGE_PX: 0.5,
    /** 顶点到相邻两点连线的垂距小于此值就算共线，合并掉（去掉折线上的毛刺） */
    COLLINEAR_PX: 0.35,
    /** 环面积小于此值（像素²）时不再挤出：屏幕上比一条线还细，挤出只会得到翻折的碎片 */
    MIN_RING_AREA_PX2: 0.75,

    /**
     * 屏幕坐标（y 向下）下的有向面积：> 0 表示视觉上顺时针。
     * 顺时针环在"前进方向右侧"是外部，所以边 p1→p2 的外法线是 normalize(dy, -dx)。
     */
    ringSignedArea(pts) {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        s += p.x * q.y - q.x * p.y;
      }
      return s / 2;
    },

    /** 一组点相对弦 a→b 的最大垂距（像素） */
    _chordDev(pts, a, b) {
      const ax = pts[a].x;
      const ay = pts[a].y;
      const dx = pts[b].x - ax;
      const dy = pts[b].y - ay;
      const len = Math.hypot(dx, dy) || 1;
      let max = 0;
      for (let i = a + 1; i < b; i++) {
        const dev = Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
        if (dev > max) max = dev;
      }
      return max;
    },

    /**
     * 带误差上界的贪心抽稀（合并近似共线的点）：
     * 只有"这一段里被跳过的点到保留弦的垂距都 ≤ tol（像素）"时才允许跳，
     * 所以不会像"每轮都拿新邻居比垂距"那样越抽越偏（弧形/圆形建筑会被抽成多边形）。
     * runCap 限制一段最多吃掉的点数：保证 O(n·runCap) 的规模，也避免长弧线被一路拉直。
     */
    simplifyRing(points, tol, runCap) {
      const n = points.length;
      if (n <= 3) return points.slice();
      const cap = runCap || 32;
      const out = [points[0]];
      let a = 0;
      while (a < n - 1) {
        let best = a + 1;
        let eaten = 0;
        for (let c = a + 2; c < n && eaten < cap; c++) {
          if (Render._chordDev(points, a, c) > tol) break;
          best = c;
          eaten += 1;
        }
        out.push(points[best]);
        a = best;
      }
      return out;
    },

    /**
     * 把一圈屏幕像素点清理成可以正确挤出的简单环：
     *  1) 丢掉非有限坐标与相邻重复点，并显式闭合——OSM 闭合 way 的最后一个节点就是第一个节点，
     *     源数据里那个"重复闭合点"必须先扔掉，否则会多出一条零长边（挤出零宽贴片，画面上就是发丝缝）
     *  2) 丢掉长度 < MIN_EDGE_PX 的退化边（极细长楼、重复节点都会产生这种边）
     *  3) 合并近似共线的点：多段折线取直，减少墙面数量，也避免共线处冒出朝内的假立面
     *  4) 统一绕向：鞋带公式求有向面积，为负（视觉逆时针）就整环反转。
     *     以前用"边中点减重心"当法线，L 形/凹形/重心落在多边形外的轮廓会有一半墙判反——
     *     内墙被当成外墙画出来、外墙又被剔掉，看着就是"拧着/里外翻"。按绕向算法线后凹形也正确。
     * 返回 { pts, area }，退化到挤不出东西时返回 null。
     */
    normalizeRing(points, opts) {
      const o = opts || {};
      const minEdge = o.minEdge == null ? Render.MIN_EDGE_PX : o.minEdge;
      const collinear = o.collinear == null ? Render.COLLINEAR_PX : o.collinear;
      const minArea = o.minArea == null ? Render.MIN_RING_AREA_PX2 : o.minArea;
      let pts = [];
      for (const p of points || []) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const last = pts[pts.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < minEdge) continue;
        pts.push(p);
      }
      // 首尾重复的闭合点（源数据里第一个点又出现一次）：显式闭合，不留零长边
      while (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < minEdge) pts.pop();
      if (pts.length < 3) return null;

      pts = Render.simplifyRing(pts, collinear);
      if (pts.length < 3) return null;

      let area = Render.ringSignedArea(pts);
      if (area < 0) {
        pts = pts.slice().reverse(); // 统一成"屏幕顺时针"，法线符号才固定
        area = -area;
      }
      if (area < minArea) return null;
      return { pts, area };
    },

    /**
     * 把闭合轮廓挤出成 2.5D：屋顶按高度做屏幕空间偏移，只画朝向相机（左下）的墙面。
     * 只在较高缩放启用，避免低缩放时多边形数量爆炸。
     * @param {Array} ring 外环，[lat,lon] 数组或 {lat,lng}/{lat,lon} 对象都接受（统一走 util.toObj，不混用）
     * @param {number} heightM 建筑高度（米）
     * @param {object} rule 样式规则（取 fill / stroke）
     * @param {number} zoom 当前缩放
     * @param {Array<Array>} [holes] 内环（天井/院子）：多面体建筑的 role=inner 成员。
     *        每个内环都会**反向**（外法线朝井里）后参与挤出，所以画出来的是"朝院子的墙"；
     *        屋顶用 evenodd 把这些内环挖成洞（天井真的能看见底下的地面）。
     * @param {Array<{x:number,y:number}>} [pxRing] 已经投影好的外环像素坐标（渲染层缓存，省掉重复投影）
     * @param {Array<Array<{x:number,y:number}>>} [pxHoles] 已经投影好的内环像素坐标（与 holes 一一对应）
     * @param {object} [stat] 记账对象（渲染层统计"这一屏挤出了几个天井、几面院子墙"）
     */
    buildExtrusion(ring, heightM, rule, zoom, holes, pxRing, pxHoles, stat) {
      const map = Render.map;
      const mpp = Render.metersPerPixel();
      const ex = zoom >= 19 ? 1 : zoom >= 18 ? 1.15 : 1.3;
      const hPx = Math.min((heightM / mpp) * ex, 240);
      const toLatLngs = (pts) => pts.map((p) => map.unproject(L.point(p.x, p.y), zoom));
      /**
       * 平面屋顶（矮楼 / 屏幕上的退化轮廓都走这里）。
       * 单环用 nonzero：自相交轮廓不会在交叉处按偶奇规则"破一个洞"；
       * 带内环时必须 evenodd，否则天井会被填死。
       */
      const flat = (rings) => {
        const list = (rings || []).filter((r) => r && r.length >= 3);
        if (!list.length) return null;
        if (stat) stat.flat = (stat.flat || 0) + 1;
        return L.polygon(list.length > 1 ? list : list[0], {
          renderer: Render.rendererBuilding, color: rule.stroke || 'transparent', weight: 0.6,
          opacity: 0.8, fillColor: rule.fill, fillOpacity: 1,
          fillRule: list.length > 1 ? 'evenodd' : 'nonzero', interactive: false,
        });
      };

      // 统一坐标入口：数组 [lat,lng]、{lat,lng}、本地模型的 {lat,lon} 都接受，绝不混着读
      const project = (c) => {
        const ll = util.toObj(c);
        if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return null;
        if (Math.abs(ll.lat) > 90 || Math.abs(ll.lng) > 180) return null;
        return map.project(L.latLng(ll.lat, ll.lng), zoom);
      };
      const projectRing = (coords, px) => {
        const out = [];
        if (px && px.length) {
          for (const p of px) if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push(p);
          return out;
        }
        for (const c of coords || []) {
          const p = project(c);
          if (p) out.push(p);
        }
        return out;
      };
      const outerPx = projectRing(ring, pxRing);
      // 平面屋顶也走"投影过再反投影"的坐标：入参是数组还是 {lat,lon}/{lat,lng} 都不会混用
      const fallback = outerPx.length >= 3 ? toLatLngs(outerPx) : (ring || []);
      const holePx = [];
      for (let i = 0; i < (holes || []).length; i++) {
        const h = holes[i];
        if (!h || h.length < 3) continue;
        const px = projectRing(h, pxHoles ? pxHoles[i] : null);
        if (px.length >= 3) holePx.push(px);
      }
      const flatRings = () => {
        const list = [fallback];
        for (const px of holePx) list.push(toLatLngs(px));
        return list;
      };
      if (hPx < 1.5) return [flat(flatRings())]; // 太矮：只画一块平面屋顶（低缩放时绝大多数建筑都走这条）
      const outer = Render.normalizeRing(outerPx);
      if (!outer) return [flat(flatRings())];    // 屏幕上的退化轮廓（比 0.5px 还细）：挤出只会翻折，退回平面

      const outerPts = outer.pts;
      const D = { x: hPx * 0.42, y: -hPx };
      const out = [];
      const rings = [outerPts];
      for (const px of holePx) {
        const inner = Render.normalizeRing(px);
        // 内环反向：墙面正对天井（外法线指向实体外＝朝井里），与外环法线方向约定一致
        if (inner) {
          rings.push(inner.pts.slice().reverse());
          if (stat) stat.innerRings = (stat.innerRings || 0) + 1;
        }
      }

      for (const pts of rings) {
        const innerRing = pts !== outerPts;
        for (let i = 0; i < pts.length; i++) {
          const p1 = pts[i];
          const p2 = pts[(i + 1) % pts.length];
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const len = Math.hypot(dx, dy);
          if (len < Render.MIN_EDGE_PX) continue; // 退化边：挤出零宽贴片只会留缝
          // 绕向已统一，外法线可以直接由边方向推出（屏幕 y 向下、顺时针环）
          const nx = dy / len;
          const ny = -dx / len;
          const facing = nx * VIEW.x + ny * VIEW.y;
          if (facing <= 0.02) continue; // 背对相机的墙面不画
          const color = util.shade(rule.fill, (0.62 + 0.28 * Math.min(1, facing)) * (innerRing ? 0.86 : 1));
          const quad = [
            { x: p1.x, y: p1.y },
            { x: p2.x, y: p2.y },
            { x: p2.x + D.x, y: p2.y + D.y },
            { x: p1.x + D.x, y: p1.y + D.y },
          ];
          if (innerRing && stat) stat.courtyardWalls = (stat.courtyardWalls || 0) + 1;
          out.push(L.polygon(toLatLngs(quad), {
            renderer: Render.rendererBuilding,
            // 用同色细描边盖掉相邻墙面之间的抗锯齿缝，否则整栋楼会透出一条条发丝缝
            color, weight: 1, opacity: 1, lineJoin: 'round',
            fillColor: color, fillOpacity: 1, interactive: false,
          }));
        }
      }

      const roof = toLatLngs(outerPts.map((p) => ({ x: p.x + D.x, y: p.y + D.y })));
      const roofRings = [roof];
      for (let i = 1; i < rings.length; i++) roofRings.push(toLatLngs(rings[i].map((p) => ({ x: p.x + D.x, y: p.y + D.y }))));
      if (stat) stat.roofHoles = (stat.roofHoles || 0) + Math.max(0, roofRings.length - 1);
      out.push(L.polygon(roofRings, {
        renderer: Render.rendererBuilding,
        color: util.shade(rule.fill, 0.72),
        weight: 0.8,
        opacity: 0.85,
        fillColor: util.shade(rule.fill, 1.06),
        fillOpacity: 1,
        // 单环用 nonzero：自相交轮廓不会在交叉处按偶奇规则"破一个洞"；带内环时必须 evenodd 才挖得出洞
        fillRule: roofRings.length > 1 ? 'evenodd' : 'nonzero',
        interactive: false,
      }));
      return out;
    },

    collectLabel(tags, coords, rule, zoom, cat, isPoint, job) {
      if (!Render.labelsVisible || !rule.label) return;
      const info = Render.style.labelFor(tags);
      if (!info) return;
      const minZoom = rule.label.minZoom || (isPoint ? 17 : Math.max(rule.minZoom || 0, 13));
      if (zoom < minZoom) return;
      const mid = coords[Math.floor(coords.length / 2)];
      const item = {
        lat: mid[0], lon: mid[1], text: info.text, priority: info.priority || 5,
        style: rule.label, cat, icon: isPoint ? rule.icon : null, kind: isPoint ? 'poi' : 'line',
      };
      // 分帧重建时先收集到 job 里，等重建完成再整体换上去（避免半截标签）
      (job ? job.labels : Render._labels).push(item);
    },

    /* ------------------------------ 覆盖画布 ------------------------------ */
    /**
     * 文字宽度缓存：measureText 是覆盖画布上最贵的调用，
     * 同一段文字 + 同一字体只会量一次（拖一条街的标签不再每帧都量）。
     */
    textWidth(ctx, font, text) {
      const cache = Render._textW || (Render._textW = new Map());
      const key = font + '\u0000' + text;
      let w = cache.get(key);
      if (w == null) {
        w = ctx.measureText(text).width;
        if (cache.size > 20000) cache.clear();
        cache.set(key, w);
      }
      return w;
    },

    /* ------------------------------ 分块降级标记（画在地图上） ------------------------------ */
    /**
     * 排版区块标记。两种模式（`Render.blockNoteMode`）：
     *   · `'zone'`（默认）：色块**逐块**铺（每个被简化的区块都看得见），
     *     说明文字 + "?" 按"相邻成片"合并，一片一条 —— 低缩放下几百个区块各自顶一条注释会把地图糊死；
     *   · `'block'`：严格一块一条（区块数少的时候更直观，也便于自检逐块核对）。
     * 锚点都用该块/该片的左上角，跑出画布时把它拽回可见范围；返回值同时用来做标签避让。
     * 关掉显示（Render.showDegradedBlocks = false）时这里返回空：色块、描边、注释一个都不画。
     */
    layoutBlockNotes(ctx, P, size) {
      const map = Render.map;
      if (Render.showDegradedBlocks === false) return [];
      const mode = Render.blockNoteMode === 'block' ? 'block' : 'zone';
      const zonesAll = mode === 'zone' ? Render.degradedZones(0) : [];
      const items = mode === 'block'
        ? Render.degradedBlocks()
        : zonesAll.slice(0, Math.max(1, Number(Render.maxBlockNotes) || MAX_BLOCK_NOTES));
      Render.stats.blockZones = mode === 'zone' ? zonesAll.length : 0;
      if (!items.length) return [];
      const font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
      const padX = 7;
      const boxH = 19;
      const out = [];
      const budget = mode === 'block' ? Math.max(1, Number(Render.maxBlockNotes) || MAX_BLOCK_NOTES) : items.length;
      for (const b of items) {
        const anchor = b.anchor || { lat: b.bounds.maxLat, lon: b.bounds.minLon };
        const corner = mode === 'block'
          ? { maxLat: b.bounds.maxLat, minLon: b.bounds.minLon, minLat: b.bounds.minLat, maxLon: b.bounds.maxLon }
          : Render._zoneCorner(b);
        const tl = P({ lat: corner.maxLat, lng: corner.minLon });
        const br = P({ lat: corner.minLat, lng: corner.maxLon });
        if (!tl || !br) continue;
        const w = br.x - tl.x;
        const h = br.y - tl.y;
        // 整块都在画布外：不用画（注释也就无从锚起）
        if (br.x < -24 || tl.x > size.x + 24 || br.y < -24 || tl.y > size.y + 24) continue;
        if (out.length >= budget) break;                 // 说明文字有预算；色块不受它限制
        const bw = Render.textWidth(ctx, font, b.text) + padX * 2;
        const lx = Math.max(4, Math.min(tl.x + 4, Math.max(4, size.x - bw - 4)));
        const ly = Math.max(4, Math.min(tl.y + 4, Math.max(4, size.y - boxH - 4)));
        out.push({
          x: tl.x, y: tl.y, w, h, lx, ly, bw, bh: boxH, font, text: b.text, block: b,
          zone: !!b.zone, blocks: b.blocks ? b.blocks.length : 1, anchor,
        });
      }
      /**
       * 还有没排上的区块片 → 补一条"合计"说明，锚在画布左下角。
       * 这样**每一个被简化的街区都有一句说明负责**（要么是自己那片的，要么是这条合计的），
       * 不会出现"一片橙色但没人告诉你为什么"的情况。
       */
      if (mode === 'zone' && zonesAll.length > out.length) {
        const rest = zonesAll.length - out.length;
        const text = `本屏还有 ${rest} 处街区要素过密，已简略显示 · 缩放可看全`;
        const bw = Render.textWidth(ctx, font, text) + padX * 2;
        const lx = 8;
        const ly = Math.max(4, size.y - boxH - 26);
        const ll = map.containerPointToLatLng(L.point(lx - OVERLAY_PAD, ly - OVERLAY_PAD));
        out.push({
          summary: true, x: lx, y: ly, w: bw, h: boxH, lx, ly, bw, bh: boxH, font, text,
          block: { summary: true, anchor: { lat: ll.lat, lon: ll.lng }, text, count: rest },
          zone: false, blocks: 0, anchor: { lat: ll.lat, lon: ll.lng },
        });
      }
      return out;
    },

    /** 一片区块的经纬度外框（注释锚点用它的左上角） */
    _zoneCorner(zone) {
      let maxLat = -Infinity;
      let minLat = Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const b of zone.blocks || []) {
        if (b.bounds.maxLat > maxLat) maxLat = b.bounds.maxLat;
        if (b.bounds.minLat < minLat) minLat = b.bounds.minLat;
        if (b.bounds.minLon < minLon) minLon = b.bounds.minLon;
        if (b.bounds.maxLon > maxLon) maxLon = b.bounds.maxLon;
      }
      if (!Number.isFinite(maxLat)) return { maxLat: 0, minLat: 0, minLon: 0, maxLon: 0 };
      return { maxLat, minLat, minLon, maxLon };
    },

    /**
     * 区块色块：**每一个被简化的 300 米区块**都盖一层很淡的暖色 + 1px 描边 —— 一眼看出是哪些小块。
     * 画在标签之前（覆盖画布的最底层），所以它不会压住标签文字与线路站车。
     * 注意：注释文字有预算（`Render.maxBlockNotes`），但**色块没有预算** —— 被简化了就一定看得见。
     */
    drawBlockShade(ctx, blocks) {
      Render.stats.degradedShown = 0;
      if (!blocks || !blocks.length || Render.showDegradedBlocks === false) return 0;
      const map = Render.map;
      ctx.save();
      ctx.fillStyle = Render.blockFill || BLOCK_FILL;
      ctx.strokeStyle = Render.blockStroke || BLOCK_STROKE;
      ctx.lineWidth = 1;
      let n = 0;
      for (const b of blocks) {
        let tl;
        let br;
        if (b.zone) {
          const corner = Render._zoneCorner(b);
          tl = map.latLngToContainerPoint(L.latLng(corner.maxLat, corner.minLon));
          br = map.latLngToContainerPoint(L.latLng(corner.minLat, corner.maxLon));
        } else {
          tl = map.latLngToContainerPoint(L.latLng(b.bounds.maxLat, b.bounds.minLon));
          br = map.latLngToContainerPoint(L.latLng(b.bounds.minLat, b.bounds.maxLon));
        }
        if (!tl || !br) continue;
        const x = Math.round(tl.x + OVERLAY_PAD);
        const y = Math.round(tl.y + OVERLAY_PAD);
        const w = Math.round(br.x - tl.x);
        const h = Math.round(br.y - tl.y);
        if (w < 3 || h < 3) continue;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        n += 1;
      }
      ctx.restore();
      Render.stats.degradedShown = n;
      return n;
    },

    /** 把区块注释画到覆盖画布最上层：半透明说明 + "?" 小标（悬停有解释） */
    drawBlockNotes(ctx, notes) {
      const shown = !!(notes && notes.length) && Render.showDegradedBlocks !== false;
      Render.stats.blockNotes = shown ? notes.length : 0;
      if (!shown) return;
      ctx.save();
      for (const n of notes) {
        // 半透明说明（锚在区块左上角）
        ctx.fillStyle = 'rgba(12,16,21,0.55)';
        ctx.strokeStyle = 'rgba(255,183,3,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(n.lx + 0.5, n.ly + 0.5, n.bw, n.bh);
        ctx.fill();
        ctx.stroke();
        ctx.font = n.font;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,230,194,0.92)';
        ctx.fillText(n.text, n.lx + 7, n.ly + n.bh / 2 + 1);
        // "?" 小圆标：鼠标悬停时由 DOM 徽标给出中文解释（见 syncBlockTips）
        const qx = n.lx + n.bw + 11;
        const qy = n.ly + n.bh / 2;
        ctx.beginPath();
        ctx.arc(qx, qy, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,183,3,0.92)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(60,40,0,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = '700 11px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#3a2600';
        ctx.fillText('?', qx, qy + 0.5);
        ctx.textAlign = 'left';
      }
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
    },

    /* ------------------------------ 区块"?"提示（DOM 徽标 + 原生 tooltip） ------------------------------ */
    /**
     * 区块说明的可视开关。**关掉之后：色块、描边、注释、? 徽标全部消失**（数据层的简化不变，
     * 只是不再画标记）—— 排查性能时想让画面干净就关掉它。
     */
    showDegradedBlocks: true,
    /** "?" DOM 徽标开关（默认开）；关掉只留画布上的色块与注释 */
    blockTipsEnabled: true,
    /** 区块色块配色（半透明暖色，压在底图上仍看得清下面的路） */
    blockFill: BLOCK_FILL,
    blockStroke: BLOCK_STROKE,
    /** "?" 徽标的解释文案（浏览器原生 tooltip） */
    blockTipText: BLOCK_TIP,
    /** DOM 徽标容器（一个 pane + 若干 el，跟随地图平移） */
    _blockTips: { pane: null, els: [] },

    /** 开关区块标记；返回开关后的状态 */
    setDegradedBlocksVisible(on) {
      Render.showDegradedBlocks = on !== false;
      if (!Render.showDegradedBlocks) Render.clearBlockTips();
      if (Render.overlay) Render.overlay.redraw();
      return Render.showDegradedBlocks;
    },

    /** 移除所有"?" 徽标 */
    clearBlockTips() {
      const tips = Render._blockTips;
      for (const el of tips.els) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      tips.els.length = 0;
      Render.stats.degradedTips = 0;
      return 0;
    },

    /**
     * 同步"?" 徽标：每个被简化的区块左上角挂一个小圆标，鼠标悬停显示中文解释，点一下就关掉区块高亮。
     * 徽标挂在 Leaflet 的 overlayPane 里（跟着地图一起平移），所以拖动时不需要重排。
     */
    syncBlockTips(notes) {
      const map = Render.map;
      const tips = Render._blockTips;
      if (!map || !Render.blockTipsEnabled || Render.showDegradedBlocks === false || !notes || !notes.length) {
        if (tips.els.length) Render.clearBlockTips();
        return 0;
      }
      const pane = map.getPanes ? map.getPanes().overlayPane : null;
      if (!pane || typeof document === 'undefined' || !document.createElement) return 0;
      while (tips.els.length > notes.length) {
        const el = tips.els.pop();
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        let el = tips.els[i];
        if (!el) {
          el = document.createElement('div');
          el.className = 'osmcity-block-tip';
          el.textContent = '?';
          el.title = Render.blockTipText;
          el.setAttribute('role', 'button');
          el.setAttribute('aria-label', Render.blockTipText);
          el.style.position = 'absolute';
          el.style.width = '18px';
          el.style.height = '18px';
          el.style.lineHeight = '18px';
          el.style.textAlign = 'center';
          el.style.borderRadius = '50%';
          el.style.background = 'rgba(255,183,3,0.92)';
          el.style.color = '#3a2600';
          el.style.font = '700 12px "PingFang SC","Microsoft YaHei",sans-serif';
          el.style.boxShadow = '0 1px 3px rgba(0,0,0,0.35)';
          el.style.cursor = 'pointer';
          el.style.pointerEvents = 'auto';
          el.style.zIndex = '500';
          el.addEventListener('click', (ev) => {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            Render.setDegradedBlocksVisible(false);
            util.toast('已关掉区块高亮（分块简化照旧生效，随时可以再打开）', 'info', 2600);
          });
          pane.appendChild(el);
          tips.els[i] = el;
        }
        if (el.title !== Render.blockTipText) el.title = Render.blockTipText;
        const anchor = note.block.anchor || { lat: note.block.bounds.maxLat, lon: note.block.bounds.minLon };
        const pt = map.latLngToLayerPoint(L.latLng(anchor.lat, anchor.lon));
        L.DomUtil.setPosition(el, L.point(pt.x + 6, pt.y + 22));
        el.style.display = '';
      }
      Render.stats.degradedTips = notes.length;
      return notes.length;
    },

    drawOverlay(ctx, size) {
      const tOverlay = performance.now();
      try {
        Render._drawOverlay(ctx, size);
      } finally {
        const ms = performance.now() - tOverlay;
        Render.stats.overlayMs = Math.round(ms * 10) / 10;
        if (World && World.perfAdd) World.perfAdd('overlay', ms);
      }
    },

    _drawOverlay(ctx, size) {
      const map = Render.map;
      const state = Render.getOverlayState ? Render.getOverlayState() : Render.overlayState;
      ctx.clearRect(0, 0, size.x, size.y);

      /**
       * 统一坐标入口：数组 [lat,lng]、Leaflet 的 {lat,lng}、本地模型的 {lat,lon} 都接受。
       * 之前这里直接读 .lon，遇到 Leaflet LatLng（只有 .lng）就会算出 (lat, undefined)，
       * 于是抛出 "Invalid LatLng object"。凡是画到画布上的坐标都从这里过一遍。
       */
      const toLL = (p) => {
        if (!p) return null;
        if (Array.isArray(p)) {
          return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
        }
        const lat = Number(p.lat);
        const lng = Number(p.lng != null ? p.lng : p.lon);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
      };
      const P = (p) => {
        const ll = toLL(p);
        if (!ll) return null;
        // 画布比视口大一圈并固定在图层坐标上：画布里的逻辑坐标 = 容器坐标 + PAD
        // （换算只有 overlayPoint 一个入口，见文件上方）
        return overlayPoint(map, ll);
      };

      // 1) 绘制预览（正在画的道路/面、拖动中的节点）
      const preview = state && state.preview;
      if (preview) {
        if (preview.points && preview.points.length) {
          const pts = preview.points.map((p) => P(p)).filter(Boolean);
          const closed = !!preview.closed;
          if (pts.length) {
            ctx.save();
            ctx.beginPath();
            pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            if (preview.cursor) ctx.lineTo(preview.cursor.x + OVERLAY_PAD, preview.cursor.y + OVERLAY_PAD);
            if (closed && pts.length > 2) {
              ctx.closePath();
              ctx.fillStyle = preview.fill || 'rgba(255,209,102,0.25)';
              ctx.fill();
            }
            ctx.strokeStyle = preview.color || '#ffb703';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
        if (preview.rubber && preview.rubber.length === 2) {
          const a = P(preview.rubber[0]);
          const b = P(preview.rubber[1]);
          if (a && b) {
            ctx.save();
            ctx.strokeStyle = preview.color || '#ffb703';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.restore();
          }
        }
        if (preview.tip && preview.tip.at) {
          const p = P(preview.tip.at);
          if (p) Render.drawTip(ctx, p.x + 14, p.y - 12, preview.tip.text);
        }
      }

      // 2) 选中元素高亮 + 节点手柄
      const sel = state && state.selection;
      if (sel) Render.drawSelection(ctx, sel, P);

      // 2.5) 框选：矩形 + 框内元素高亮
      if (state && state.boxRect) {
        const a = P(state.boxRect.start);
        const b = P(state.boxRect.end);
        if (a && b) {
          ctx.save();
          ctx.fillStyle = 'rgba(79,195,247,0.12)';
          ctx.strokeStyle = '#4fc3f7';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }
      if (state && state.multi && state.multi.length) {
        ctx.save();
        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 2.5;
        // 框选高亮不截断：视野外的元素画了也看不见，靠坐标裁剪省掉即可
        for (const item of state.multi) {
          const el = World.get(item.type, item.id);
          if (!el) continue;
          if (item.type === 'node') {
            const p = P(el);
            if (!p) continue;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.stroke();
            continue;
          }
          for (const path of World.coords(item.type, item.id)) {
            if (!path.length) continue;
            ctx.beginPath();
            let started = false;
            for (const c of path) {
              const p = P(c);
              if (!p) continue;
              if (started) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); started = true; }
            }
            if (started) ctx.stroke();
          }
        }
        ctx.restore();
      }

      // 3) 元素锁（别人正在编辑的）
      const locks = (state && state.locks) || {};
      const myId = state && state.myId;
      for (const [key, info] of Object.entries(locks)) {
        if (myId && info.userId === myId) continue;
        const [type, idStr] = key.split(':');
        // 公交锁（station/line/vehicle/company）和 OSM 锁共用一张表，但它们不是地图元素：
        // 若不跳过，id 撞上已加载的关系就会画出一个并不存在的幽灵光晕
        if (type !== 'node' && type !== 'way' && type !== 'relation') continue;
        const coords = World.coords(type, Number(idStr));
        if (type === 'node') {
          const n = World.getNode(Number(idStr));
          if (!n) continue;
          const p = P(n);
          if (!p) continue;
          ctx.save();
          ctx.strokeStyle = info.color || '#ff6b6b';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          continue;
        }
        ctx.save();
        ctx.strokeStyle = info.color || '#ff6b6b';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]);
        for (const path of coords) {
          if (!path.length) continue;
          ctx.beginPath();
          let started = false;
          path.forEach((c) => {
            const p = P(c);
            if (!p) return;
            if (started) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); started = true; }
          });
          if (!started) continue;
          if (type === 'way' && World.isClosed(World.getWay(Number(idStr)))) ctx.closePath();
          ctx.stroke();
        }
        ctx.restore();
      }

      // 3.5) 图层叠加：显示模式（人口密度 / 活跃度）+ 车站覆盖范围
      //      画在标签与车站之前：热力底图在下，文字与站/车在上，谁都盖不住谁
      Render.drawLayerPass(ctx, size, P);

      // 3.9) 分块降级：先排版（下面画标签时让它避让），再逐块铺半透明色块（压在最底层）。
      //      色块覆盖**每一个**被简化的区块（不受注释预算限制），注释/？按片或按块排版。
      const blockNotes = Render.layoutBlockNotes(ctx, P, size);
      Render.drawBlockShade(ctx, Render.degradedBlocks());
      Render.syncBlockTips(blockNotes);

      // 4) 标签与 POI 图标（按优先级排序 + 避让）
      if (Render.labelsVisible) {
        // 排序只在重建后做一次（以前每帧都给整张标签表排序）
        if (!Render._labelsSorted || Render._labelsSortedFor !== Render._labels) {
          Render._labelsSorted = Render._labels.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
          Render._labelsSortedFor = Render._labels;
        }
        const sorted = Render._labelsSorted;
        const grid = new Map();          // 64px 网格：避让判定不再两两比较
        const GRID = 64;
        const hits = (box) => {
          const x0 = Math.floor(box.x / GRID);
          const x1 = Math.floor((box.x + box.w) / GRID);
          const y0 = Math.floor(box.y / GRID);
          const y1 = Math.floor((box.y + box.h) / GRID);
          for (let gx = x0; gx <= x1; gx++) {
            for (let gy = y0; gy <= y1; gy++) {
              const arr = grid.get(gx + ':' + gy);
              if (!arr) continue;
              for (const t of arr) {
                if (!(box.x > t.x + t.w || box.x + box.w < t.x || box.y > t.y + t.h || box.y + box.h < t.y)) return true;
              }
            }
          }
          return false;
        };
        const remember = (box) => {
          const x0 = Math.floor(box.x / GRID);
          const x1 = Math.floor((box.x + box.w) / GRID);
          const y0 = Math.floor(box.y / GRID);
          const y1 = Math.floor((box.y + box.h) / GRID);
          for (let gx = x0; gx <= x1; gx++) {
            for (let gy = y0; gy <= y1; gy++) {
              const key = gx + ':' + gy;
              let arr = grid.get(key);
              if (!arr) { arr = []; grid.set(key, arr); }
              arr.push(box);
            }
          }
        };
        let drawn = 0;
        // 区块注释的位置先占住：标签不会压在上面（注释要看得清才有意义）
        for (const n of blockNotes) remember({ x: n.lx, y: n.ly, w: n.bw, h: n.bh });
        for (const label of sorted) {
          // 上限只防止极端情况把一帧画爆；默认预算远大于一屏能显示的标签数，
          // 也就是说正常情况下"该有的标签都有"，不会因为预算被截断
          if (drawn >= Render.labelBudget) break;
          const p = P(label);
          if (!p) continue;
          if (p.x < -50 || p.y < -20 || p.x > size.x + 50 || p.y > size.y + 20) continue;
          const st = label.style || {};
          const size2 = st.size || 11;
          const font = `${st.weight || 600} ${size2}px "PingFang SC","Microsoft YaHei",sans-serif`;
          ctx.font = font;
          const w = Render.textWidth(ctx, font, label.text);
          const box = { x: p.x - w / 2 - 2, y: p.y - size2 - 2, w: w + 6, h: size2 + 6 };
          if (label.kind === 'poi') { box.x -= 2; box.y -= 6; box.w += 4; box.h += 12; }
          if (hits(box)) continue;
          remember(box);
          drawn += 1;
          if (label.icon) {
            ctx.font = '14px "Segoe UI Emoji","Apple Color Emoji",sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = '#111';
            ctx.fillText(label.icon, p.x, p.y + 1);
            ctx.textBaseline = 'alphabetic';
          }
          ctx.font = `${st.weight || 600} ${size2}px "PingFang SC","Microsoft YaHei",sans-serif`;
          ctx.textAlign = 'center';
          ctx.lineWidth = 3;
          ctx.strokeStyle = st.halo || 'rgba(255,255,255,0.92)';
          ctx.strokeText(label.text, p.x, p.y - (label.icon ? 12 : 4));
          ctx.fillStyle = st.color || '#333';
          ctx.fillText(label.text, p.x, p.y - (label.icon ? 12 : 4));
        }
        Render.stats.labels = drawn;
      } else {
        Render.stats.labels = 0;
      }

      // 5) 协作者光标
      const cursors = (state && state.cursors) || [];
      for (const cur of cursors) {
        const p = P(cur);
        if (!p) continue;
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = cur.color || '#4363d8';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        ctx.font = '600 11px "PingFang SC","Microsoft YaHei",sans-serif';
        const w = ctx.measureText(cur.name || '').width;
        ctx.fillStyle = 'rgba(10,14,19,0.85)';
        ctx.fillRect(p.x + 8, p.y - 16, w + 10, 16);
        ctx.strokeStyle = cur.color || '#4363d8';
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x + 8.5, p.y - 15.5, w + 9, 15);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(cur.name || '', p.x + 13, p.y - 4);
        ctx.restore();
      }
      // 6) 交通玩法图层（人口热力 / 线路 / 车站 / 列车）
      if (window.G.Transit && window.G.Transit.draw) {
        try {
          // 覆盖范围改由上面的"车站覆盖范围"图层统一画：画车站时临时压住每站自己的开关，
          // 免得叠出两层，也保证图层总开关一关就全干净
          Render.withStationCatchmentSuppressed(() => window.G.Transit.draw(ctx, size, P));
        } catch (err) {
          if (!Render.stats.transitError) Render.stats.transitError = err.message;
        }
      }
      // 7) 分块降级注释（画在最上层：它必须永远看得见，否则"简略显示"就等于偷偷摸摸）
      Render.drawBlockNotes(ctx, blockNotes);
    },

    /* ------------------------------ 图层叠加（显示模式 / 车站覆盖范围） ------------------------------ */
    drawLayerPass(ctx, size, P) {
      if (Render.isCellMode()) Render.drawCells(ctx, size, P);
      if (Render.stationCatchment.on) Render.drawCatchment(ctx, size, P);
    },

    /** 人口密度 / 活跃度：按格子填色（范围外的格子跳过，太小的不画） */
    drawCells(ctx, size, P) {
      const mode = Render.displayMode;
      const c = Render.cells;
      const list = c.list;
      Render.stats.cells = 0;
      if (!list.length) return;
      const cellM = Number(c.cellM) > 0 ? Number(c.cellM) : 250;
      const halfLat = (cellM / 2) / 110574;
      const pad = 64;
      // 先用经纬度粗筛一遍：视野外的格子不必做两次投影（格子可能上万，这一步很省）
      let view = null;
      try {
        view = Render.map ? Render.map.getBounds().pad(0.05) : null;
      } catch { view = null; }
      let drawn = 0;
      ctx.save();
      for (const cell of list) {
        // 不做数量截断：视野外的格子靠经纬度粗筛掉（那才是真正的省）
        const lat = Number(cell && cell.lat);
        const lon = Number(cell && cell.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (view && (lat < view.getSouth() - halfLat || lat > view.getNorth() + halfLat
          || lon < view.getWest() || lon > view.getEast())) continue;
        const color = Render.cellColor(mode, cell);
        if (!color) continue;
        const halfLon = (cellM / 2) / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
        const a = P([lat + halfLat, lon - halfLon]);
        const b = P([lat - halfLat, lon + halfLon]);
        if (!a || !b) continue;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        if (w < 0.9 || h < 0.9) continue;
        if (x > size.x + pad || y > size.y + pad || x + w < -pad || y + h < -pad) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
        drawn += 1;
      }
      ctx.restore();
      Render.stats.cells = drawn;
    },

    /** 车站覆盖范围：每座车站一个柔和圆盘，半径 = 该站的吸引半径（catchmentM） */
    drawCatchment(ctx, size, P) {
      Render.stats.catchment = 0;
      // 图层关掉就一个都不画（这里的判断是双保险：总开关永远能一键全关）
      if (!Render.stationCatchment.on) return;
      const list = Render.stationList();
      if (!list.length) return;
      const onlyFlagged = !!Render.stationCatchment.onlyFlagged;
      const mpp = Render.metersPerPixel() || 2;
      const pad = 80;
      let drawn = 0;
      ctx.save();
      for (const st of list) {
        // 不做数量截断：视野外的车站靠下面的矩形裁剪跳过
        if (onlyFlagged && !st.showCatchment) continue;
        const lat = Number(st.lat);
        const lon = Number(st.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const rM = Math.max(50, Math.min(8000, Number(st.catchmentM) || 700));
        const r = rM / mpp;
        if (r < 3 || r > 6000) continue;
        const p = P([lat, lon]);
        if (!p) continue;
        if (p.x + r < -pad || p.y + r < -pad || p.x - r > size.x + pad || p.y - r > size.y + pad) continue;
        const rgb = Render.stationCatchmentColor(st);
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        grad.addColorStop(0, Render.cssRgba(rgb, 0.30));
        grad.addColorStop(0.55, Render.cssRgba(rgb, 0.15));
        grad.addColorStop(1, Render.cssRgba(rgb, 0.02));
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        // 一圈细虚线：让"半径到底是多大"看得清
        ctx.strokeStyle = Render.cssRgba(rgb, 0.45);
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        drawn += 1;
      }
      ctx.restore();
      Render.stats.catchment = drawn;
    },

    drawSelection(ctx, sel, P) {
      const coords = World.coords(sel.type, sel.id);
      const el = World.get(sel.type, sel.id);
      if (!el) return;
      const color = sel.color || '#ffd166';
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      if (sel.type === 'node') {
        const p = P(el);
        if (p) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
        for (const path of coords) {
          if (!path.length) continue;
          ctx.beginPath();
          let started = false;
          path.forEach((c) => {
            const p = P(c);
            if (!p) return;
            if (started) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); started = true; }
          });
          if (!started) continue;
          if (sel.type === 'way' && World.isClosed(World.getWay(sel.id))) ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.restore();

      // 顶点手柄（编辑节点工具时给出更明显的方块）
      if (sel.type === 'way' && (sel.showNodes !== false)) {
        const handles = sel.handles || World.wayCoords(World.getWay(sel.id));
        ctx.save();
        for (const c of handles) {
          const p = P(c);
          if (!p) continue;
          ctx.fillStyle = sel.handleColor || '#ffffff';
          ctx.strokeStyle = sel.handleStroke || '#3d3d3d';
          ctx.lineWidth = 1.5;
          const s = sel.handleSize || 3.5;
          ctx.beginPath();
          ctx.rect(p.x - s, p.y - s, s * 2, s * 2);
          ctx.fill();
          ctx.stroke();
        }
        // 段中点（可插入节点）
        if (sel.showMidpoints) {
          const coords2 = coords[0] || [];
          for (let i = 1; i < coords2.length; i++) {
            const a = coords2[i - 1];
            const b = coords2[i];
            const p = P([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
            if (!p) continue;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.fill();
            ctx.strokeStyle = '#ffb703';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        ctx.restore();
      }
      if (sel.type === 'node') {
        const p = P(el);
        if (!p) return;
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    },

    drawTip(ctx, x, y, text) {
      ctx.save();
      ctx.font = '12px "PingFang SC","Microsoft YaHei",sans-serif';
      const w = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(12,16,21,0.92)';
      ctx.strokeStyle = 'rgba(255,183,3,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x, y - 16, w + 14, 22);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffe6c2';
      ctx.textAlign = 'left';
      ctx.fillText(text, x + 7, y);
      ctx.restore();
    },

    /* --------------------- 自检：异形楼的内环（天井）真的被挤出来了 --------------------- */
    /**
     * 合成一栋"带天井的多面体楼"（外环拆成两条 way + 一条 inner way，和真实数据里的
     * 胡同四合院 / 静默寺一个形状），走真实的 World.mergePayload → World.ringsOf → Render._relationPass
     * 路径，断言：
     *   · 多面体建筑在 z≥17 时**挤出成 2.5D**（以前它只会走填充分支，没有 3D、更没有天井）；
     *   · 屋顶是 evenodd 多环（天井真的挖穿了，能看见底下的地面）；
     *   · 画出了朝院子里的墙（courtyardWalls > 0）；
     *   · skipped 还是 0。
     * 同时给出"改之前"的对照（同一条数据不挤出时 = 一块平面填充）。
     * 顺带清点**真实数据**：当前视野里已加载的多面体建筑有几座、其中几座带内环，
     * 以及 Render.stats.skipped / completeness().roadsMissing 是否还是 0。
     * @param {{zoom?:number, lat?:number, lon?:number, real?:boolean}} options
     */
    selfCheckCourtyard(options = {}) {
      const steps = [];
      const failures = [];
      const check = (name, cond, detail) => {
        const ok = !!cond;
        steps.push({ name, ok, detail: detail == null ? '' : String(detail) });
        if (!ok) failures.push(name);
        return ok;
      };
      const map = Render.map;
      if (!map || typeof map.project !== 'function') return { ok: false, error: 'no-map', steps };
      if (!Render.style || typeof Render.style.ruleFor !== 'function') return { ok: false, error: 'no-style', steps };
      const zoom = Number.isFinite(Number(options.zoom)) ? Number(options.zoom)
        : Math.max(Render.extrudeMinZoom, Math.round(map.getZoom() || 18));
      const center = map.getCenter();
      const lat0 = Number.isFinite(Number(options.lat)) ? Number(options.lat) : center.lat;
      const lon0 = Number.isFinite(Number(options.lon)) ? Number(options.lon) : center.lng;
      const d = (a, b) => [lat0 + a, lon0 + b];
      /* 合成 id 全部取负数：OSM 的 id 都是正数，所以绝不会碰到页面上的真实要素 */
      const N = (n) => -88000000 - n;
      const W = (n) => -88100000 - n;
      const REL = -8800001;
      const outer = [d(0.00036, 0.00000), d(0.00036, 0.00035), d(0.00000, 0.00035), d(0.00000, 0.00000)];
      const hole = [d(0.00010, 0.00010), d(0.00010, 0.00025), d(0.00026, 0.00025), d(0.00026, 0.00010)];
      const payload = {
        nodes: {
          [N(1)]: outer[0], [N(2)]: outer[1], [N(3)]: outer[2], [N(4)]: outer[3],
          [N(11)]: hole[0], [N(12)]: hole[1], [N(13)]: hole[2], [N(14)]: hole[3],
        },
        nodeTags: {},
        ways: {
          // 外环被拆成两条 way（和多面体的真实数据一样），天井是 role=inner 的闭合 way
          [W(1)]: [1, [N(1), N(2), N(3)], { building: 'yes' }, false, 0],
          [W(2)]: [1, [N(3), N(4), N(1)], { building: 'yes' }, false, 0],
          [W(3)]: [1, [N(11), N(12), N(13), N(14), N(11)], {}, true, 0],
        },
        relations: {
          [REL]: [1, [['way', W(1), 'outer'], ['way', W(2), 'outer'], ['way', W(3), 'inner']],
            { type: 'multipolygon', building: 'yes', 'building:levels': '3' }],
        },
      };
      const snap = World._snapshotState();
      const extrudeBefore = Render.extrudeMinZoom;
      /* 数一圈 Leaflet 多边形有几环 / 每环几个点（单环与多环两种结构都能数） */
      const ringsOfLayer = (layer) => {
        const lls = layer && layer._latlngs;
        if (!Array.isArray(lls) || !lls.length) return [];
        if (typeof lls[0].lat === 'number') return [lls];
        return lls;
      };
      let after = null;
      let before = null;
      let real = null;
      try {
        World._sandboxActive = true;
        World.viewportBox = null;
        World._evalViewport = null;
        World.mergePayload(payload);
        const rel = World.getRelation(REL);
        check('合成 payload 合并成功（1 个多面体关系 / 3 条 way）', !!rel, `关系 ${World.relations.size} 个`);

        const rings = World.ringsOf('relation', REL);
        check('外环被两条 way 接成一个闭环 + 认出一个内环（天井）',
          rings.outers.length === 1 && rings.inners.length === 1 && rings.outerWays === 2,
          JSON.stringify({ outers: rings.outers.length, inners: rings.inners.length, outerWays: rings.outerWays }));

        const rule = Render.style.ruleFor(rel.tags, 'area');
        check('样式表给多面体建筑的是"挤出"规则（extrude=true）', !!(rule && rule.fill && rule.extrude),
          JSON.stringify({ fill: rule && rule.fill, extrude: !!(rule && rule.extrude) }));

        /**
         * _relationPass 会遍历**本地所有关系**，所以这里临时把关系表换成"只有这一栋合成楼"：
         * 这样"改之前 / 改之后"的数字就是这一栋楼的，不会混进页面上真实数据的量
         * （关系表本身是普通属性，换掉再换回来即可，_restoreState 还会把整张表恢复原样）。
         */
        const allRelations = World.relations;
        World.relations = new Map([[REL, rel]]);
        try {
          /* 改之前的行为：多面体走填充分支（这里用"不挤出"复现），只有一块平面，天井看不见 */
          Render.extrudeMinZoom = 99;
          const jobOld = Render._selfCheckJob(zoom);
          Render._relationPass(jobOld);
          Render.extrudeMinZoom = extrudeBefore;
          before = {
            buildings: jobOld.buildings.length,
            fills: jobOld.fills.length,
            shed: jobOld.buildings.length === 0 && jobOld.fills.length === 1,
            note: '改之前：多面体建筑走填充分支 → 一块平面填充（没有 3D、天井看不见）',
          };
          check('对照（改之前）：不挤出时只是一块平面填充', before.shed,
            `buildings=${before.buildings} fills=${before.fills}`);

          /* 改之后的真实路径：_relationPass 走挤出 */
          const job = Render._selfCheckJob(zoom);
          Render._relationPass(job);
          const walls = job.buildings.filter((p) => ringsOfLayer(p).length === 1 && ringsOfLayer(p)[0].length === 4);
          const roofLayer = job.buildings.find((p) => ringsOfLayer(p).length > 1 && p.options && p.options.fillRule === 'evenodd');
          const roofRings = roofLayer ? ringsOfLayer(roofLayer).length : 0;
          after = {
            buildings: job.buildings.length,
            fills: job.fills.length,
            walls: walls.length,
            courtyardWalls: job.courtyardWalls,
            innerRings: job.innerRings,
            roofRings,
            roofFillRule: roofLayer ? roofLayer.options.fillRule : null,
            extrudedRelations: job.extrudedRelations,
            relationFallbacks: job.relationFallbacks || 0,
            skipped: job.skipped,
            note: '改之后：挤出成 2.5D，屋顶 evenodd 挖出天井，四壁有朝院子的墙面',
          };
          check('多面体建筑被挤出成 2.5D（建筑图层里有墙 + 屋顶）',
            job.buildings.length > 0 && job.fills.length === 0 && job.extrudedRelations === 1,
            JSON.stringify({ buildings: job.buildings.length, fills: job.fills.length, extrudedRelations: job.extrudedRelations }));
          check('屋顶用 evenodd 挖出天井（2 环）', !!roofLayer && roofRings === 2,
            `roofRings=${roofRings} fillRule=${after.roofFillRule}`);
          check('认出了内环并画出朝院子里的墙', job.innerRings >= 1 && job.courtyardWalls >= 1,
            `innerRings=${job.innerRings} courtyardWalls=${job.courtyardWalls}`);
          check('外墙与院内墙都画了（相机在左下：矩形外露 2 面外墙 + 2 面朝院子的墙）',
            walls.length >= 4 && job.courtyardWalls >= 2,
            `walls=${walls.length} 其中朝院子 ${job.courtyardWalls} 面`);
          check('屋顶只有一块（墙 + 1 块屋顶 = 建筑图层里的对象数）',
            job.buildings.length === walls.length + 1, `buildings=${job.buildings.length} walls=${walls.length}`);
          check('这一轮没有任何要素被跳过（skipped=0）', job.skipped === 0 && !job.lastError,
            `skipped=${job.skipped}${job.lastError ? ' · ' + job.lastError : ''}`);
        } finally {
          World.relations = allRelations;
        }

        /* 同一个 buildExtrusion：不给内环 = 旧画法；给内环 = 新画法（前后对照） */
        const noHoles = Render.buildExtrusion(rings.outers[0], 12, rule, zoom, undefined);
        const withHoles = Render.buildExtrusion(rings.outers[0], 12, rule, zoom, rings.inners);
        const noHoleRoof = noHoles[noHoles.length - 1];
        const withHoleRoof = withHoles[withHoles.length - 1];
        check('前后对照：同一栋楼，不给内环时屋顶是 1 环 nonzero，给了内环是 2 环 evenodd',
          ringsOfLayer(noHoleRoof).length === 1 && noHoleRoof.options.fillRule === 'nonzero'
          && ringsOfLayer(withHoleRoof).length === 2 && withHoleRoof.options.fillRule === 'evenodd',
          `前 ${ringsOfLayer(noHoleRoof).length} 环/${noHoleRoof.options.fillRule} → 后 ${ringsOfLayer(withHoleRoof).length} 环/${withHoleRoof.options.fillRule}`);

        /* 太矮（或屏幕上的退化轮廓）退回平面屋顶时，天井同样要挖出来 */
        const flat = Render.buildExtrusion(rings.outers[0], 12, rule, 10, rings.inners);
        const flatRoof = flat[0];
        check('退回平面屋顶时天井照样挖穿（evenodd）',
          ringsOfLayer(flatRoof).length === 2 && flatRoof.options.fillRule === 'evenodd',
          `${ringsOfLayer(flatRoof).length} 环 / ${flatRoof.options.fillRule}`);
      } finally {
        Render.extrudeMinZoom = extrudeBefore;
        // _restoreState 会把关系表 / 视野 / 数据版本号原样装回去（合成数据一点都不会留在本地）
        World._restoreState(snap);
      }

      /* 真实数据清点（当前视野里已加载的多面体建筑） */
      try {
        const view = Render.viewBoxNow();
        real = World.buildingRelationStats(view);
        const comp = Render.completeness();
        real.roadsMissing = comp ? comp.roadsMissing : null;
        real.areasMissingUnexpected = comp ? comp.areasMissingUnexpected : null;
        real.renderSkipped = Render.stats.skipped;
        real.zoom = map.getZoom();
        real.extrusion = Render.extrusionStats();
        const hasReal = real.buildings > 0;
        check(`真实数据清点：视野内多面体建筑 ${real.buildings} 座`
          + (hasReal ? `，其中 ${real.withInner} 座带内环（天井）` : '（当前视野没有已加载的多面体建筑，跳过严格断言）'),
          true, JSON.stringify({ buildings: real.buildings, withInner: real.withInner, innerRings: real.innerRings, dropped: real.dropped }));
        if (hasReal) {
          check('真实数据的环都能缝出来（没有接不上的碎片、没有缺节点）',
            real.dropped === 0 && real.missingNodes === 0,
            `dropped=${real.dropped} missingNodes=${real.missingNodes}`);
          check('真实数据渲染一个要素都没跳过（skipped=0）', Render.stats.skipped === 0, `skipped=${Render.stats.skipped}`);
          check('道路一条不缺（completeness().roadsMissing=0）',
            !comp || comp.roadsMissing === 0,
            comp ? `roadsInView=${comp.roadsInView} roadsDrawn=${comp.roadsDrawn}` : 'no-map');
        }
      } catch (err) {
        check('真实数据清点没有抛异常', false, err && err.message);
      }

      return {
        ok: failures.length === 0,
        zoom,
        steps,
        failures,
        before,
        after,
        real,
        stats: Render.extrusionStats(),
      };
    },

    /**
     * 自检：**任何档位都不许有"计划外缺失"**（"禁止截断"的最后一道闸，可重复断言）。
     *
     * 逐个档位重建一次并核对 completeness()：
     *   1. `roadsMissing === 0` —— 该画的道路一条不缺（任何档位、任何缩放）；
     *   2. `areasMissingUnexpected === 0` —— 没有"既不属按档位省、也不属区块简化、也不是节点未到"的缺失；
     *   3. 口径互斥且算得清：`按档位 + 区块 + 节点未到 + 计划外 === 总缺失`
     *      （保证"区块简化"不会被误算成"计划外"，反过来也不会）；
     *   4. `honest === true`。
     * 另外单独断言：**"节点比 way 晚到"必须自愈**（way 先到、节点在隔壁瓦片 → 节点到了一定要补画出来，
     * 否则画面上会永久少一块；回归测试用，见 World.selfCheckLateNodes）。
     *
     * 数据没取齐的视野会如实记成 skipped，不假装通过。
     * 用法：
     *   Render.selfCheckCompleteness()                        // 当前缩放、0~4 档
     *   Render.selfCheckCompleteness({ levels: [0, 4] })       // 只查这两档
     *   Render.selfCheckCompleteness({ zooms: [11, 13, 16] })  // 逐缩放（调用方需先把各缩放的数据取齐）
     */
    selfCheckCompleteness(options = {}) {
      const steps = [];
      const failures = [];
      const check = (name, cond, detail) => {
        const ok = !!cond;
        steps.push({ name, ok, detail: detail == null ? '' : String(detail) });
        if (!ok) failures.push(name);
        return ok;
      };
      const skip = (name, detail) => { steps.push({ name, ok: true, detail: 'skipped: ' + (detail || '') }); };
      const map = Render.map;
      if (!map) { check('地图已就绪', false, 'Render.map 为空'); return { ok: false, steps, failures }; }
      const md = World.mapData || (window.G && window.G.MapData);
      const levels = (options.levels && options.levels.length ? options.levels : [0, 1, 2, 3, 4]).map((x) => Render.clampDetail(x));
      const zooms = options.zooms && options.zooms.length ? options.zooms.slice() : [map.getZoom()];
      const detailBefore = Render.detail;
      const rows = [];
      for (const z of zooms) {
        if (z !== map.getZoom()) map.setView(map.getCenter(), z, { animate: false });
        const box = md && md.bboxNow ? md.bboxNow(0) : null;
        const dataReady = !md || !md.isComplete || !box || md.isComplete(box);
        for (const level of levels) {
          const tag = `z${z} 档${level}(${Render.detailDef(level).name})`;
          Render.setDetail(level, { silent: true, persist: false, refetch: false, rebuild: false });
          Render.rebuild();
          const c = Render.completeness();
          if (!c) { check(`${tag} 能拿到 completeness()`, false, '没有视野'); continue; }
          rows.push({
            zoom: z, level, detailName: c.detailName,
            roadsInView: c.roadsInView, roadsMissing: c.roadsMissing, roadsByBlock: c.roadsMissingByBlockSimplify,
            areasInView: c.areasInView, areasMissing: c.areasMissing,
            byDetail: c.areasMissingByDetail, byRule: c.areasMissingByRule,
            degraded: c.degradedAreasMissing,
            incomplete: c.areasMissingIncomplete, unexpected: c.areasMissingUnexpected,
            degradedBlocks: c.degradedBlocks, blockRoads: Render.stats.blockRoadsSimplified || 0,
            roadKeep: Render.stats.blockRoadKeep || 0,
            honest: c.honest, dataReady,
          });
          if (!dataReady) { skip(`${tag} 数据已取齐`, '视野数据还没到齐，本档跳过'); continue; }
          check(`${tag} 主干道该画却没画 = 0（roadsMissing === 0）`, c.roadsMissing === 0,
            `缺 ${c.roadsMissing}/${c.roadsInView}（区块过密简化 ${c.roadsMissingByBlockSimplify} · 样式不画 ${c.roadsMissingByRule} · 按档位不画 ${c.roadsMissingByDetail}）`);
          check(`${tag} 没有计划外缺失（areasMissingUnexpected === 0）`, c.areasMissingUnexpected === 0,
            `计划外 ${c.areasMissingUnexpected}（按档位 ${c.areasMissingByDetail} · 样式不画 ${c.areasMissingByRule}`
            + ` · 区块 ${c.degradedAreasMissing} · 节点未到 ${c.areasMissingIncomplete}）`);
          check(`${tag} 缺失口径互斥且算得清（按档位+样式+区块+节点未到+计划外 === 总缺失）`,
            (c.areasMissingByDetail + c.areasMissingByRule + c.degradedAreasMissing + c.areasMissingIncomplete + c.areasMissingUnexpected) === c.areasMissing,
            `${c.areasMissingByDetail}+${c.areasMissingByRule}+${c.degradedAreasMissing}+${c.areasMissingIncomplete}+${c.areasMissingUnexpected} vs 总 ${c.areasMissing}`);
          check(`${tag} honest === true`, c.honest === true,
            `roadsMissing=${c.roadsMissing} unexpected=${c.areasMissingUnexpected}`);
          /**
           * 档位语义的硬断言：
           *   · 「完整」「全部道路」档**一条次要道路都不许被区块简化**（玩家要全画就给全）；
           *   · 任何档位下被区块简化掉的次要道路都必须记在独立口径里（不混进 roadsMissing）。
           */
          if (level === 0 || level === 1) {
            check(`${tag} 「${Render.detailDef(level).name}」档不许简化任何道路（区块简化道路 = 0）`,
              (Render.stats.blockRoadsSimplified || 0) === 0,
              `区块简化道路 ${Render.stats.blockRoadsSimplified || 0} 条 · 区块 ${Render.stats.degradedBlocks || 0} 个`);
          } else if (Render.blockRoadsOn(level)) {
            // 次要道路确实可能被简化，但必须都能对上账：少掉的次要道路 = 区块账本
            const roadDropOk = c.roadsMissingByBlockSimplify === 0 || (Render.stats.blockRoadsSimplified || 0) > 0;
            check(`${tag} 被区块简化的次要道路记在独立口径里（不是 roadsMissing）`, roadDropOk,
              `区块简化道路 ${Render.stats.blockRoadsSimplified || 0} 条 · 口径里的 ${c.roadsMissingByBlockSimplify} 条 · roadsMissing=${c.roadsMissing}`);
          }
        }
      }
      // 档位还原（不重建：调用方接着用原来的画面）
      Render.setDetail(detailBefore, { silent: true, persist: false, refetch: false, rebuild: false });
      Render.rebuild();
      // 「节点比 way 晚到」回归（数据层，不依赖视野/网络）
      if (options.lateNodes !== false && World && typeof World.selfCheckLateNodes === 'function') {
        const late = World.selfCheckLateNodes();
        for (const s of late.steps) steps.push({ name: '晚到节点 · ' + s.name, ok: s.ok, detail: s.detail });
        for (const f of late.failures) failures.push('晚到节点 · ' + f);
      }
      /**
       * 「本地编辑落地后几何必须更新」回归（数据层，不依赖视野/网络）：
       * 用户报的"编辑完地图不刷新"就是这条 —— 编辑器原地改坐标 + ack 回来时看不出改动。
       */
      if (options.localEdit !== false && World && typeof World.selfCheckLocalEditRepaint === 'function') {
        const le = World.selfCheckLocalEditRepaint();
        for (const s of le.steps) steps.push({ name: '本地编辑 · ' + s.name, ok: s.ok, detail: s.detail });
        for (const f of le.failures) failures.push('本地编辑 · ' + f);
      }
      return {
        ok: failures.length === 0,
        zoom: map.getZoom(),
        levels,
        zooms,
        rows,
        steps,
        failures,
        text: failures.length
          ? `❌ ${failures.length} 项不通过：${failures.slice(0, 3).join(' / ')}`
          : `✅ ${steps.length} 项全通过（${rows.length} 个"档位×缩放"组合：道路一条不缺、无计划外缺失）`,
      };
    },

    /**
     * 异步版自检：**自己把每个缩放的数据等齐**再逐档核对（浏览器控制台 / 端到端测试用）。
     * 同步版 `selfCheckCompleteness()` 只核对"当前已经取齐"的视野；这个版本会走一遍
     * moveend → 取数 → 重建，所以能一次把 11/13/16/18 都查一遍。
     * 等不到数据的缩放如实记进 `skipped`，不假装通过。
     */
    async selfCheckCompletenessAsync(options = {}) {
      const map = Render.map;
      const md = World.mapData || (window.G && window.G.MapData);
      const zooms = options.zooms && options.zooms.length ? options.zooms.slice() : [map.getZoom()];
      const center = options.center || map.getCenter();
      const limit = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000;
      const out = { ok: true, zooms: [], skipped: [], rows: [], steps: [], failures: [] };
      for (const z of zooms) {
        map.setView(center, z, { animate: false });
        const t0 = Date.now();
        let ready = false;
        while (Date.now() - t0 < limit) {
          const busy = md && (md.fetching || md.inflight > 0 || (md.queue && md.queue.length));
          const complete = !md || !md.isComplete || md.isComplete(md.bboxNow(0));
          if (!busy && complete) { ready = true; break; }
          await new Promise((r) => setTimeout(r, 120));
        }
        if (!ready) { out.skipped.push(z); continue; }
        const one = Render.selfCheckCompleteness({ zooms: [z], levels: options.levels, lateNodes: false });
        out.zooms.push(z);
        out.rows = out.rows.concat(one.rows);
        out.steps = out.steps.concat(one.steps);
        out.failures = out.failures.concat(one.failures);
      }
      out.ok = out.failures.length === 0 && out.zooms.length > 0;
      out.text = out.zooms.length === 0
        ? `⚠ 一个缩放都没等齐数据（跳过：${out.skipped.join(',')}）`
        : (out.ok
          ? `✅ z${out.zooms.join(' / z')} 共 ${out.rows.length} 个"档位×缩放"组合：道路一条不缺、无计划外缺失`
          : `❌ ${out.failures.length} 项不通过：${out.failures.slice(0, 3).join(' / ')}`);
      return out;
    },

    /** 自检用的空 job（只跑 _relationPass 这类单遍工序时用） */
    _selfCheckJob(zoom) {      return {
        seq: 0, t0: 0, zoom, style: Render.style, i: 0, wayList: [],
        fills: [], buildings: [], casings: [], cores: [], focusShapes: [],
        buckets: new Map(), visibleWays: [], visibleNodes: [], visibleRelations: [], labels: [],
        detailShapes: 0, speedRoads: 0, congestionRoads: 0, congestionColored: 0,
        extrudedWays: 0, extrudedRelations: 0, innerRings: 0, courtyardWalls: 0,
        roofHoles: 0, flatBuildings: 0, relationFallbacks: 0,
        skipped: 0, lastError: null, roadsInView: 0, roadsDrawn: 0, batches: 0, passes: 1, cpuMs: 0,
        fillShapes: 0, detailDroppedFills: 0, skippedTiny: 0, detailDropped: new Set(),
        bbox: null, degraded: [], degradedKeys: null, degradedMap: null,
      };
    },

    /* --------------------- 自检：拥堵显示模式（分档 / 着色 / 铁路剔除 / 优雅降级） --------------------- */
    /**
     * 不需要网络的拥堵自检：把合成数据直接喂给 applyCongestion，
     * 再拿一个假 Net 验证"按取整 bbox 缓存 / 同一时刻只有一个请求在飞 / 失败退回普通配色 + 只提示一次"。
     */
    selfCheckCongestion(options = {}) {
      const steps = [];
      const failures = [];
      const check = (name, cond, detail) => {
        const ok = !!cond;
        steps.push({ name, ok, detail: detail == null ? '' : String(detail) });
        if (!ok) failures.push(name);
        return ok;
      };
      const c = Render.congestion;
      const snap = {
        list: c.list, roads: c.roads, byWayId: c.byWayId, counts: c.counts, bbox: c.bbox, key: c.key,
        error: c.error, loadedAt: c.loadedAt, hinted: c.hinted, loading: c.loading, pendingId: c.pendingId,
        meanSpeed: c.meanSpeed, total: c.total, requests: c.requests, requestBox: c.requestBox,
      };
      const modeBefore = Render.displayMode;
      const gBefore = window.G ? window.G.Net : undefined;
      const toastBefore = util.toast;
      const toasts = [];
      let fakeSent = [];
      let result = null;
      try {
        util.toast = (msg) => { toasts.push(String(msg)); };
        const ways = [
          { wayId: 1, kind: 'primary', congestion: 0.9, speed: 54, limit: 60, junctions: 2, density: 1.2, lengthM: 500, level: 'free' },
          { wayId: 2, kind: 'residential', congestion: 0.62, speed: 19, limit: 30, lengthM: 200, level: 'busy' },
          { wayId: 3, kind: 'secondary', congestion: 0.30, speed: 15, limit: 50, lengthM: 300, level: 'jam' },
          { wayId: 4, kind: 'rail', congestion: 0.8, speed: 60, limit: 0 },        // 轨道：必须剔除
          { wayId: 5, kind: 'subway', congestion: 0.7, speed: 50, limit: 0 },      // 地铁：必须剔除
          { wayId: 6, kind: 'footway', congestion: 0.9, speed: 5, limit: 5 },      // 步道：必须剔除
        ];
        Render.applyCongestion({ ok: true, total: 6, truncated: false, ways, stats: { junctions: 12 } },
          { minLon: 116, minLat: 39, maxLon: 117, maxLat: 40 }, 7);
        const st = Render.congestionStats();
        check('三档条数正确：畅通 1 / 一般 1 / 拥堵 1', st.levels.free === 1 && st.levels.busy === 1 && st.levels.jam === 1,
          JSON.stringify(st.levels));
        check('轨道 / 地铁 / 步道被剔除（不计入拥堵统计）', st.ways === 3 && st.excluded === 3,
          `ways=${st.ways} excluded=${st.excluded}`);
        check('平均服务速度（视野内）= (54+19+15)/3 = 29.3 km/h', Math.abs(st.meanSpeed - 29.3) < 0.06, `${st.meanSpeed}`);
        check('平均拥堵系数 = (0.9+0.62+0.3)/3 ≈ 0.607', Math.abs(st.meanCongestion - 0.607) < 0.01, `${st.meanCongestion}`);
        check('统计文案是中文且带三档条数与平均车速',
          /视野内 3 条道路 .*畅通 1 .*一般 1 .*拥堵 1.*平均服务速度 29.3 km\/h/.test(st.text), st.text);
        check('congestionStats() 标了 ready', st.ready === true && st.error === null);

        const rgb = (hex) => Render.hexToRgb(hex) || [0, 0, 0];
        const free = rgb(Render.colorForCongestion(ways[0]));
        const busy = rgb(Render.colorForCongestion(ways[1]));
        const jam = rgb(Render.colorForCongestion(ways[2]));
        check('畅通 = 绿（G 通道最大）', free[1] > free[0] && free[1] > free[2], `rgb(${free})`);
        check('一般 = 琥珀（R/G 都高、B 很低）', busy[0] > 150 && busy[1] > 100 && busy[2] < 90, `rgb(${busy})`);
        check('拥堵 = 红（R 通道最大）', jam[0] > jam[1] && jam[0] > jam[2], `rgb(${jam})`);

        check('道路按 wayId 取到拥堵色',
          Render.congestionColorFor({ id: 1, tags: { highway: 'primary' } }) === Render.colorForCongestion(c.byWayId.get(1)));
        check('铁路 / 电车 / 地铁不会被上拥堵色',
          Render.congestionColorFor({ id: 4, tags: { railway: 'rail' } }) === null
          && Render.congestionColorFor({ id: 5, tags: { railway: 'tram' } }) === null
          && Render.congestionColorFor({ id: 6, tags: { railway: 'subway' } }) === null);
        check('步道（不在拥堵路网里）照常画，不给"不知道"的灰',
          Render.congestionColorFor({ id: 77, tags: { highway: 'footway' } }) === null);
        check('路网里查不到的机动车道 = 中性灰（不假装知道）',
          Render.congestionColorFor({ id: 78, tags: { highway: 'service' } }) === Render.congestionScale.unknown);

        /* -------- 真实数据（页面上已经加载的道路/轨道）：路面真的被画成了拥堵色 -------- */
        const realRoads = (Render.map && Render.map.getBounds ? (Render._visibleWays || []) : [])
          .filter((w) => Render.isCongestionRoad(w.tags)).slice(0, 60);
        const realRails = (Render.map && Render.map.getBounds ? (Render._visibleWays || []) : [])
          .filter((w) => w.tags && w.tags.railway).slice(0, 4);
        if (realRoads.length) {
          Render.applyCongestion({
            ok: true, total: realRoads.length,
            ways: realRoads.map((w, i) => ({
              wayId: w.id, kind: w.tags.highway,
              congestion: [0.9, 0.62, 0.30][i % 3], speed: [45, 20, 10][i % 3], limit: 50, lengthM: 100,
            })),
          }, null, 3);
          /** 让真正的 _wayPass 画一遍这条 way，返回"路面(core)用的颜色" */
          const probe = (way) => {
            const job = Render._selfCheckJob(Render.map.getZoom());
            job.bounds = Render.map.getBounds().pad(0.12);
            const sw = job.bounds.getSouthWest();
            const ne = job.bounds.getNorthEast();
            job.bbox = { minLat: sw.lat, maxLat: ne.lat, minLon: sw.lng, maxLon: ne.lng };
            job.wayList = [way];
            Render._wayPass(job, way);
            const bucket = [...job.buckets.values()].find((b) => b.layer === 'core');
            return bucket ? bucket.opts.color : null;
          };
          /** 同一条 way 在"拥堵模式"与"普通模式"下各画一遍，看颜色是不是真的换了 */
          const probeBoth = (way) => {
            const save = Render.displayMode;
            Render.displayMode = 'congestion';
            const jam = probe(way);
            Render.displayMode = 'normal';
            const normal = probe(way);
            Render.displayMode = save;
            return { jam, normal };
          };
          const roadWay = realRoads[0];
          const wantColor = Render.colorForCongestion(c.byWayId.get(roadWay.id));
          const road = probeBoth(roadWay);
          check('真实道路的路面被画成拥堵色（和 colorForCongestion 一致）',
            road.jam !== null && road.jam === wantColor, `${road.jam} vs ${wantColor}`);
          check('同一段路在普通模式与拥堵模式下颜色不同（真的换了配色）',
            road.normal !== null && road.normal !== road.jam, `${road.normal} → ${road.jam}`);
          if (realRails.length) {
            const rail = probeBoth(realRails[0]);
            check('真实轨道线在拥堵模式下画得和普通模式一模一样（不上拥堵色、也不被压暗）',
              rail.jam === rail.normal && Render.congestionColorFor(realRails[0]) === null,
              `${rail.jam} vs ${rail.normal}`);
          } else {
            check('（当前视野里没有已加载的轨道线，跳过铁路对照）', true);
          }
        } else {
          check('（当前视野里没有已加载的道路，跳过"真实道路拥堵上色"）', true);
        }

        /* 取不到数据：所有道路退回普通配色（返回 null），并且中文提示只弹一次 */
        const readyRoad = { id: 1, tags: { highway: 'primary' } };
        c.error = '未知操作：road.congestion';
        c.loadedAt = 0;
        c.hinted = false;
        check('取不到拥堵数据时所有道路退回普通配色',
          Render.congestionColorFor(readyRoad) === null && Render.congestionReady() === false);
        const first = Render.congestionHint();
        const second = Render.congestionHint();
        check('中文提示只弹一次（不刷屏）', first === true && second === false && toasts.length === 1, toasts[0] || '');
        check('提示里说清了"已按普通配色显示"', /普通配色/.test(toasts[0] || ''), toasts[0] || '');

        /* 请求策略：按取整 bbox 缓存、同一时刻只有一个在飞（用假 Net，绝不打真服务器） */
        c.error = null;
        c.bbox = null;
        c.key = '';
        c.loading = false;
        c.pendingId = null;
        fakeSent = [];
        if (window.G) {
          window.G.Net = {
            connected: true,
            on() { return this; },
            send(msg) { fakeSent.push(msg); return true; },
          };
        }
        Render.displayMode = 'congestion';
        const sent1 = Render.ensureCongestion(true);
        const sent2 = Render.ensureCongestion(false);
        check('进入拥堵模式会按视野发一次 road.congestion 请求', sent1 === true && fakeSent.length === 1,
          JSON.stringify(fakeSent[0] && fakeSent[0].op));
        check('同一时刻只有一个请求在飞（第二次不发）', sent2 === false && fakeSent.length === 1);
        check('请求带的是 [minLon,minLat,maxLon,maxLat] 且开了 limit',
          Array.isArray(fakeSent[0].op.bbox) && fakeSent[0].op.bbox.length === 4 && fakeSent[0].op.limit > 0);
        const box1 = JSON.stringify(c.requestBox);
        check('请求 bbox 按 congestionGridDeg 取整（同一片地方同一个 key）',
          c.key === Render.congestionKeyOf(c.requestBox) && box1.length > 0, box1);
        const viewA = Render.viewBoxNow();
        const boxA = Render.congestionRequestBox(viewA);
        const viewB = {
          minLat: viewA.minLat + 0.02, maxLat: viewA.maxLat + 0.02,
          minLon: viewA.minLon + 0.02, maxLon: viewA.maxLon + 0.02,
        };
        const boxB = Render.congestionRequestBox(viewB);
        check('换了地方 → 请求 bbox 的 key 会变（视野跑出已取范围就会重取）',
          Render.boxCovers(boxA, viewA) === true && Render.boxCovers(boxA, viewB) === false
          && Render.congestionKeyOf(boxA) !== Render.congestionKeyOf(boxB),
          `${Render.congestionKeyOf(boxA)} vs ${Render.congestionKeyOf(boxB)}`);
        Render.onCongestionAck({ id: fakeSent[0].id, ok: true, result: { ok: true, total: 3, ways } });
        check('收到 transitAck 后 loading 归位、数据落库', c.loading === false && c.pendingId === null && c.roads.length === 3);
        check('视野还在已取范围内就不重复请求', Render.ensureCongestion(false) === false && fakeSent.length === 1);
        check('强制刷新可以再要一次', Render.ensureCongestion(true) === true && fakeSent.length === 2);
        Render.onCongestionAck({ id: fakeSent[1].id, ok: false, error: '未知操作：road.congestion' });
        check('op 不存在 / 失败时：清空数据 + 记下错误（不抛异常）',
          c.roads.length === 0 && !!c.error, `error=${c.error}`);

        /* road.congestion.way：单条道路明细（检查器点某条路时用），走同一条 transitAck */
        Render._cgWayWaiters = [];
        Render.fetchCongestionWay(1, true).catch(() => { /* 下面的 check 只关心"有没有被认领" */ });
        const detailMsg = fakeSent[fakeSent.length - 1];
        const claimed = Render.onCongestionAck({ id: detailMsg.id, ok: true, result: { ok: true, way: { wayId: 1, congestion: 0.92, level: 'free' } } });
        check('road.congestion.way 的请求与应答都对得上（op 名 / id / 等待者被摘掉）',
          claimed === true && detailMsg.op.k === 'road.congestion.way' && detailMsg.op.id === 1
          && (Render._cgWayWaiters || []).length === 0,
          JSON.stringify(detailMsg.op));

        result = { ok: failures.length === 0, steps, failures, stats: Render.congestionStats(), toasts: toasts.slice() };
      } finally {
        if (Render._cgTimer) { clearTimeout(Render._cgTimer); Render._cgTimer = null; }
        util.toast = toastBefore;
        Render.displayMode = modeBefore;
        Object.assign(c, snap);
        c.loading = false;
        c.pendingId = null;
        if (window.G) {
          if (gBefore === undefined) delete window.G.Net;
          else window.G.Net = gBefore;
        }
      }
      return result;
    },

    /* ------------------------------ 底图配色快照（自检 / 排查用） ------------------------------ */

    /**
     * 底图道路配色的快照：直接问样式表"这几条典型道路画出来是什么颜色"（stroke / fill / 宽度 / 描边）。
     * 颜色方案只管公交（线路 / 车站 / 车辆），**底图一条都不许动** —— 自检拿这个快照前后比对。
     * 样式表还没就绪（Render.style 为空）时返回 null，自检那边就只比对车速 / 拥堵 / 道路等级表。
     */
    roadColorSnapshot() {
      const st = Render.style;
      if (!st || typeof st.ruleFor !== 'function') return null;
      const probe = [['motorway', 'line'], ['primary', 'line'], ['residential', 'line'], ['service', 'line']];
      return probe.map(function (p) {
        const r = st.ruleFor({ highway: p[0] }, p[1]);
        return p[0] + '=' + (r ? [r.stroke, r.fill, r.weight, r.casing && r.casing.color].join('|') : 'none');
      }).join(' ; ');
    },

    /* --------------------- 自检：公交线路分色（稳定 / 可区分 / 撞色兜底 / 互斥 / 便宜） --------------------- */
    /**
     * 不需要网络的分色自检：合成数据（3 家公司 / 4 条线，故意让两条线撞色、一条没有里程）
     * 先跑一遍，再拿**真实 Transit.data**（已经连上服务器时）跑一遍：
     *   · 同 id 同色、不同 id 不同色；清缓存重算后颜色一模一样（跨会话 / 跨客户端稳定）；
     *   · 三个方案给出**不同**的颜色（线路本色 / 公司哈希 / 票价档）；
     *   · 票价按公式分档（票价 = fareBase + farePerKm × 里程），里程来源标注清楚；
     *   · 撞色有**确定**的兜底，而且可以关掉；没填颜色的线不碰（交回 transit.js）；
     *   · **颜色方案与显示模式解耦**：方案是 轨交 / 公交 的子选项，设了就在任何显示模式下生效；
     *     聚焦淡化照旧；底图配色（车速 / 拥堵 / 道路）一点不动；方案回到 auto = 每条线自己的颜色；
     *     旧别名 setDisplayMode('linecolor'|'company'|'fare') 仍然同时设方案 + 显示模式；
     *   · 普通模式下钩子把"不被方案改变的线"原样转交原函数（底图配色零影响）；
     *   · 取色是查表（不重建计划）+ N 次取色的耗时。
     * 跑完把 displayMode / 颜色方案 / 聚焦 / window.G.Transit / 兜底开关 / 缓存原样还原。
     */
    selfCheckTransitColors(options = {}) {
      const steps = [];
      const failures = [];
      const check = (name, cond, detail) => {
        const ok = !!cond;
        steps.push({ name, ok, detail: detail == null ? '' : String(detail) });
        if (!ok) failures.push(name);
        return ok;
      };
      const nowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
      const modeBefore = Render.displayMode;
      // 颜色方案与聚焦也是"页面状态"：自检跑完必须原样还原（这一节会来回切方案 / 聚焦）
      const schemeBefore = Render.transitColorSchemeId;
      const schemeSourceBefore = Render._transitColorSchemeSource;
      const focusBefore = Render.focus;
      const fallbackBefore = Render.transitColorUniqueFallback;
      const statsBefore = { lookups: Render.stats.transitColorLookups, fallbacks: Render.stats.transitColorFallbacks };
      const G = window.G || (window.G = {});
      const TBefore = G.Transit;
      const rebuildBefore = Render.rebuild;
      const overlayBefore = Render.scheduleOverlay;
      const cgBefore = Render.ensureCongestion;
      const cellsBefore = Render.ensureCells;
      let result = null;
      try {
        /* ---------- 合成数据：3 家公司 + 4 条线（11/12 撞色、14 没有 pathLen） ---------- */
        const fake = {
          data: {
            companies: [
              { id: 1, owner: 'u-a', name: '甲公司', color: '#000075' },
              { id: 2, owner: 'u-b', name: '乙公司', color: '#f58231' },
              { id: 3, owner: 'u-c', name: '丙公司', color: '#911eb4' },
            ],
            lines: [
              { id: 11, name: '1 路', kind: 'bus', color: '#e6194b', companyId: 1, pathLen: 584 },
              { id: 12, name: '2 路', kind: 'bus', color: '#e6194b', companyId: 1, pathLen: 1928 },
              { id: 13, name: '3 路', kind: 'rail', color: '#3cb44b', companyId: 2, pathLen: 5307 },
              {
                id: 14, name: '4 路', kind: 'bus', color: '', companyId: 3, pathLen: 0,
                pathCoords: [[39.9, 116.4], [39.91, 116.41]],
                stopsInfo: [{ stationId: 103, name: '站 C', distance: 1500 }],
              },
            ],
            stations: [{ id: 101, name: '站 A', companyId: 1, kind: 'bus' }, { id: 103, name: '站 C', companyId: 3, kind: 'bus' }],
            trains: [{ id: 201, lineId: 11, companyId: 1, kind: 'bus' }, { id: 202, lineId: 13, companyId: 2, kind: 'rail' }],
          },
          config: { fareBase: 3, farePerKm: 0.5 },
          lineCalls: 0,
          companyCalls: 0,
        };
        fake.lineColor = function (line) { fake.lineCalls += 1; return (line && line.color) || '#8ab4f8'; };
        fake.companyColor = function () { fake.companyCalls += 1; return '#888888'; };
        G.Transit = fake;
        // 切模式正常会重建画布 / 取数据：自检里一律空转，只测配色本身
        Render.rebuild = () => null;
        Render.scheduleOverlay = () => null;
        Render.ensureCongestion = () => false;
        Render.ensureCells = () => null;
        Render.transitColorUniqueFallback = true;
        Render.transitColorCacheBust();

        const L = fake.data.lines;
        const byId = (id) => L.find((x) => x.id === id);
        const baseBefore = {
          speed: Render.colorForSpeed(60),
          roadKeep: Render.blockRoadKeep(14),
          serverSend: Render.serverRoadSend(14),
          rank: Render.roadRank({ highway: 'primary' }),
          detail: Render.detailName(),
          // 拥堵配色 + 底图道路的"画出来什么颜色"（样式表就绪时才有，见 roadColorSnapshot）
          jam: {
            free: Render.congestionScale.colors.free,
            busy: Render.congestionScale.colors.busy,
            jam: Render.congestionScale.colors.jam,
          },
          roadPaints: Render.roadColorSnapshot(),
        };

        /* ---------- 1) 取色本身：稳定 / hex / 铺得开 ---------- */
        check('哈希色是 #rrggbb 小写（transit.js 会做 color + \'22\' 拼接，必须是 hex）',
          /^#[0-9a-f]{6}$/.test(Render.idColorHex('company', 'c:1', 0)), Render.idColorHex('company', 'c:1', 0));
        check('同一个 id 反复取色完全一样（纯函数，没有随机数）',
          Render.idColorHex('company', 'c:1', 0) === Render.idColorHex('company', 'c:1', 0)
          && Render.idColorHex('line', 42, 3) === Render.idColorHex('line', 42, 3));
        check('不同 id 的色相铺得开（1000 个 id 的"底色"里重复的少于 100 个）', (function () {
          const seen = new Set();
          for (let i = 0; i < 1000; i++) seen.add(Render.idColorHex('company', 'c:' + i, 0));
          return seen.size >= 900;
        })(), (function () {
          const seen = new Set();
          for (let i = 0; i < 1000; i++) seen.add(Render.idColorHex('company', 'c:' + i, 0));
          return 'distinct=' + seen.size + '/1000（偶尔撞到的由 pickFreeColor 换盐解决，见下一项）';
        })());

        /* ---------- 2) 公司分色：同公司同色、不同公司不同色、跨缓存重建稳定 ---------- */
        Render.displayMode = 'company';
        const c1 = Render.transitCompanyColor(1);
        const c2 = Render.transitCompanyColor(2);
        check('公司分色：同一家公司的线路 / 车站 / 车辆是同一个颜色',
          !!c1 && Render.transitLineColor(byId(11)) === c1
          && Render.transitStationColor(fake.data.stations[0]) === c1
          && Render.transitVehicleColor(fake.data.trains[0]) === c1, `公司 1 = ${c1}`);
        check('公司分色：不同公司颜色不同', c1 !== c2, `${c1} vs ${c2}`);
        Render.transitColorCacheBust();
        check('公司分色：清缓存重算后颜色不变（跨会话 / 跨客户端稳定）',
          Render.transitCompanyColor(1) === c1 && Render.transitLineColor(byId(12)) === c1);

        /* ---------- 3) 撞色兜底：120 家公司两两不同色 ---------- */
        const manyCompanies = [];
        for (let i = 0; i < 120; i++) manyCompanies.push({ id: 1000 + i, owner: 'u' + i, name: '公司' + i, color: '#000000' });
        const realCompanies = fake.data.companies;
        fake.data.companies = manyCompanies;
        Render.transitColorCacheBust();
        const planMany = Render.transitColorPlan('company');
        const manyHexes = new Set();
        for (const rec of planMany.company.values()) manyHexes.add(rec.hex);
        check('撞色兜底：120 家公司两两不同色（哈希撞车已换盐解决，一个都分不开的情况为 0）',
          manyHexes.size === planMany.company.size && planMany.company.size >= 120 && planMany.unresolved === 0,
          `公司 ${planMany.company.size} 家 → ${manyHexes.size} 种颜色 · 换盐 ${planMany.collisions} 次 · 未解决 ${planMany.unresolved}`);
        fake.data.companies = realCompanies;
        Render.transitColorCacheBust();

        /* ---------- 4) 票价分色：公式 / 档 / 里程来源 ---------- */
        Render.displayMode = 'fare';
        check('票价公式：票价 = fareBase + farePerKm × 里程(km)（584 米 → 3 + 0.5×0.584 = 3.292 元）',
          Math.abs(Render.transitFareYuan(584) - 3.292) < 1e-9, `${Render.transitFareYuan(584)}`);
        check('票价分档：3.292 → 3~5 元档 / 3.964 → 3~5 元档 / 5.6535 → 5~8 元档',
          Render.transitFareBandIndex(3.292) === 1 && Render.transitFareBandIndex(3.964) === 1
          && Render.transitFareBandIndex(5.6535) === 2,
          `${Render.transitFareBandIndex(3.292)}/${Render.transitFareBandIndex(3.964)}/${Render.transitFareBandIndex(5.6535)}`);
        const len11 = Render.transitLineLength(byId(11));
        const len14 = Render.transitLineLength(byId(14));
        check('里程来源：有 pathLen 就用 pathLen；没有就按 pathCoords 折线算（不再当 0 米）',
          len11.source === 'pathLen' && len11.lengthM === 584
          && len14.source === 'pathCoords' && len14.lengthM > 1000,
          `11 路 ${len11.source}:${Math.round(len11.lengthM)}m · 4 路 ${len14.source}:${Math.round(len14.lengthM)}m`);
        const fare11 = Render.transitLineColor(byId(11));
        const fare13 = Render.transitLineColor(byId(13));
        check('票价分色：线路颜色 = 它所属票价档的颜色（短线与长线颜色不同）',
          fare11 === TRANSIT_FARE_BANDS[1][2] && fare13 === TRANSIT_FARE_BANDS[2][2] && fare11 !== fare13,
          `1 路 ${fare11}（3~5 元）· 3 路 ${fare13}（5~8 元）`);
        check('票价分色：车辆按它跑的那条线的票价档上色', Render.transitVehicleColor(fake.data.trains[1]) === fare13);
        check('票价分色：车站按服务它的线路里最便宜的那档上色',
          Render.transitStationColor(fake.data.stations[1]) === TRANSIT_FARE_BANDS[1][2],
          `${Render.transitStationColor(fake.data.stations[1])}`);

        /* ---------- 5) 线路本色：= 现状，只有撞色才换备用色（可关） ---------- */
        Render.displayMode = 'linecolor';
        check('线路本色：用自己的颜色（= 现在的默认表现）', Render.transitLineColor(byId(11)) === '#e6194b');
        const dupHex = Render.transitLineColor(byId(12));
        check('线路本色：第 2 条撞色的线换成确定的备用色（不是同一个 #e6194b）',
          dupHex !== '#e6194b' && /^#[0-9a-f]{6}$/.test(dupHex), dupHex);
        Render.transitColorCacheBust();
        check('线路本色：备用色也是稳定的（清缓存重算不变）', Render.transitLineColor(byId(12)) === dupHex);
        Render.transitColorUniqueFallback = false;
        Render.transitColorCacheBust();
        check('关掉兜底 → 完全按玩家填的颜色画（两条线都是 #e6194b）', Render.transitLineColor(byId(12)) === '#e6194b');
        Render.transitColorUniqueFallback = true;
        Render.transitColorCacheBust();
        check('线路本色：没填颜色的线一概不碰（返回 null = 交给 transit.js 的默认色）',
          Render.transitLineColor(byId(14)) === null);
        check('线路本色：车站 / 车辆一概不掺和（返回 null = 仍按公司自己的颜色画，= 现状）',
          Render.transitCompanyColor(1) === null && Render.transitStationColor(fake.data.stations[0]) === null
          && Render.transitVehicleColor(fake.data.trains[0]) === null);

        /* ---------- 6) 三个方案给出三套不同颜色 ---------- */
        const triple = {};
        for (const m of ['linecolor', 'company', 'fare']) {
          Render.displayMode = m;
          triple[m] = Render.transitLineColor(byId(13));
        }
        check('三个方案给同一条线三种不同的颜色（线路本色 / 公司 / 票价各一套）',
          triple.linecolor === '#3cb44b' && triple.company !== triple.linecolor && triple.fare !== triple.linecolor
          && triple.fare !== triple.company, JSON.stringify(triple));

        /* ---------- 7) 旧别名 + 底图零影响 + 钩子 ---------- */
        check('isTransitColorMode：只认那 ' + Render.transitColorModes.length + ' 个方案 id（' + Render.transitColorSchemes.join(' / ')
          + '；普通 / 车速 / 拥堵 / 人口 / 活跃度 / 铁路公交都不是）',
          Render.transitColorModes.length === 3 && Render.isTransitColorMode('company')
          && Render.isTransitColorMode('linecolor') && Render.isTransitColorMode('fare')
          && !Render.isTransitColorMode('normal') && !Render.isTransitColorMode('speed')
          && !Render.isTransitColorMode('congestion') && !Render.isTransitColorMode('population')
          && !Render.isTransitColorMode('activity') && !Render.isTransitColorMode('railbus'));
        check('旧别名：setDisplayMode 仍然认这三个 id（公司 / 票价 / 线路本色）—— 它们同时设颜色方案',
          Render.setDisplayMode('company') === 'company' && Render.displayMode === 'company'
          && Render.setDisplayMode('fare') === 'fare' && Render.setDisplayMode('linecolor') === 'linecolor'
          && Render.setDisplayMode('speed') === 'speed' && Render.displayMode === 'speed'
          && Render.setDisplayMode('nonsense') === 'normal' && Render.displayMode === 'normal');
        check('底图零影响：切模式之后道路车速配色 / 道路等级表 / 详细度一概没变',
          Render.colorForSpeed(60) === baseBefore.speed && Render.blockRoadKeep(14) === baseBefore.roadKeep
          && Render.serverRoadSend(14) === baseBefore.serverSend && Render.roadRank({ highway: 'primary' }) === baseBefore.rank
          && Render.detailName() === baseBefore.detail,
          `车速 ${Render.colorForSpeed(60)} · 道路等级表 ${Render.serverRoadSend(14)}`);
        Render.displayMode = 'normal';
        Render.installTransitColorHooks();
        fake.lineCalls = 0;
        fake.companyCalls = 0;
        const hookedLine = fake.lineColor(byId(11));
        check('钩子：幂等（重复安装只包一层）+ 方案是 auto/线路本色时"没被改色的线"原样转交原函数（返回原色、原函数确实被调到）',
          Render.transitColorHooksActive() && Render.installTransitColorHooks() === true
          && hookedLine === '#e6194b' && fake.lineCalls === 1 && fake.companyColor(1) === '#888888',
          `lineColor → ${hookedLine}`);
        Render.displayMode = 'company';
        const hookC1 = Render.transitCompanyColor(1);
        check('钩子：公司方案下 Transit.lineColor / companyColor 都改成分色（线路 + 车站车辆一起变）',
          fake.lineColor(byId(11)) === hookC1 && fake.companyColor(1) === hookC1, hookC1);
        check('钩子：拆掉之后完全回到 transit.js 原来的行为',
          Render.uninstallTransitColorHooks() === true && !Render.transitColorHooksActive()
          && fake.lineColor(byId(11)) === '#e6194b' && fake.companyColor(1) === '#888888');
        Render.installTransitColorHooks();

        /* ---------- 8) 便宜：查表不重算 + N 次取色耗时 ---------- */
        Render.displayMode = 'company';
        Render.transitColorCacheBust();
        const planA = Render.transitColorPlan('company');
        check('缓存：同一方案重复取计划返回同一个对象（每帧只查表，不重算、不分配数组）',
          Render.transitColorPlan('company') === planA);
        const N = 20000;
        const t0 = nowMs();
        for (let i = 0; i < N; i++) Render.transitLineColor(i % 2 ? byId(11) : byId(13));
        const ms = nowMs() - t0;
        const budget = Number.isFinite(Number(options.lookupBudgetMs)) ? Number(options.lookupBudgetMs) : 80;
        check(`便宜：${N} 次取色 ${ms.toFixed(1)}ms（预算 ${budget}ms，约 ${((ms / N) * 1000).toFixed(0)}ns/次）`, ms < budget);
        check('便宜：取色不会重建配色计划（跑完还是同一个对象）', Render.transitColorPlan('company') === planA);

        /* ---------- 9) 图例模型 / 统计 ---------- */
        const lgCompany = Render.legendModel('company');
        const lgFare = Render.legendModel('fare');
        const lgLine = Render.legendModel('linecolor');
        check('图例（公司）：分类图例给出色块 + 刻度 + 中文说明 + 对比色/形状通道',
          !!lgCompany && lgCompany.categorical === true && lgCompany.entries.length === 3
          && lgCompany.gradient.length > 0 && lgCompany.ticks.length > 0 && !!lgCompany.note
          && lgCompany.entries.every((e) => !!e.pattern && (e.textOn === '#111111' || e.textOn === '#ffffff')),
          lgCompany ? `${lgCompany.entries.length} 个色块` : 'null');
        check('图例（票价）：5 个票价档各一个色块，刻度就是档名',
          !!lgFare && lgFare.entries.length === TRANSIT_FARE_BANDS.length && lgFare.ticks.length === TRANSIT_FARE_BANDS.length,
          lgFare ? lgFare.note : 'null');
        check('图例（线路本色）：列出线路颜色，并把"撞色换备用色"标出来',
          !!lgLine && lgLine.entries.length >= 1 && lgLine.duplicates >= 1
          && lgLine.entries.some((e) => e.note.indexOf('撞色') >= 0),
          lgLine ? `撞色 ${lgLine.duplicates} 条` : 'null');
        check('图例：legendCss 能直接喂给 legend-bar（分块色标，含 rgb(...)）',
          /rgb\(/.test(Render.legendCss('company')) && /rgb\(/.test(Render.legendCss('fare'))
          && Render.legendModel('congestion') !== null && Render.legendModel('speed') !== null,
          Render.legendCss('company').slice(0, 60) + '…');
        Render.displayMode = 'fare';
        const st = Render.transitColorStats();
        check('统计：方案 / 票价定义 / 线路表（里程·票价·档）/ 撞色记账都能读到',
          st.active === true && st.lines.length === 4 && st.fare.fareBase === 3 && st.fare.farePerKm === 0.5
          && st.lines.every((l) => Number.isFinite(l.fare) && l.lengthM >= 0 && !!l.bandName)
          && st.bands.length === TRANSIT_FARE_BANDS.length && typeof st.text === 'string' && st.text.length > 0,
          st.text);
        check('统计：方案是 auto（没选）时如实报告"不生效"',
          (Render.displayMode = 'normal', Render.transitColorStats().active === false));

        /* ---------- 10) 颜色方案与显示模式解耦（方案是子选项，不是显示模式） ---------- */
        /*
         * 这一节专门验"三种分色现在是 轨交模式 / 公交模式 的子选项"这件事：
         *   · 设了方案 → 线路 / 车站 / 车辆都按方案上色，**不管显示模式是什么**；
         *   · 聚焦淡化照旧（非轨交图层照样淡化），底图配色（车速 / 拥堵 / 道路）一点不动；
         *   · 方案回到 auto → 每条线又是自己的颜色（auto = 线路本色：自己的颜色 + 撞色兜底）；
         *   · 旧别名 setDisplayMode('linecolor'|'company'|'fare') 仍然同时设方案 + 显示模式，
         *     而显式 setTransitColorScheme() 设的方案不会被显示模式清掉。
         */
        Render.setTransitColorScheme(TRANSIT_COLOR_SCHEME_AUTO);
        Render.setDisplayMode('normal');
        Render.focus = null;
        check('方案 API：transitColorScheme() 读、setTransitColorScheme() 写、transitColorSchemeId 同步；认不出的值一律 auto',
          Render.setTransitColorScheme('company') === 'company' && Render.transitColorScheme() === 'company'
          && Render.transitColorSchemeId === 'company'
          && Render.transitColorScheme('fare') === 'fare' && Render.getTransitColorScheme() === 'fare'
          && Render.isTransitColorScheme('company') && Render.isTransitColorScheme(TRANSIT_COLOR_SCHEME_AUTO)
          && !Render.isTransitColorScheme('speed') && !Render.isTransitColorScheme('rail')
          && Render.setTransitColorScheme('nonsense') === TRANSIT_COLOR_SCHEME_AUTO
          && Render.setTransitColorScheme(null) === TRANSIT_COLOR_SCHEME_AUTO
          && Render.transitColorScheme() === TRANSIT_COLOR_SCHEME_AUTO);

        // 轨交聚焦 + 公司方案：线路 / 车站 / 车辆都取公司色（显示模式仍是普通 —— 互不影响）
        Render.setFocus('rail');
        Render.setTransitColorScheme('company');
        const railCompany = Render.transitCompanyColor(1);
        check('解耦（轨交 + 公司方案）：显示模式仍是普通，线路 / 车站 / 车辆都按公司方案上色',
          Render.focus === 'rail' && Render.displayMode === 'normal'
          && railCompany === c1 && Render.transitColorSchemeEffective() === 'company'
          && Render.transitLineColor(byId(11)) === railCompany
          && Render.transitStationColor(fake.data.stations[0]) === railCompany
          && Render.transitVehicleColor(fake.data.trains[0]) === railCompany
          && fake.lineColor(byId(11)) === railCompany && fake.companyColor(1) === railCompany,
          `轨交 + 公司方案 = ${railCompany}（与第 2 步的公司 1 同色）`);
        check('解耦：聚焦淡化照旧（轨交层不淡化，道路 / 公交路线 / 其它图层仍然淡化）—— 颜色方案不碰聚焦',
          Render.focusDim({ railway: 'rail' }) === false
          && Render.focusDim({ public_transport: 'station' }) === false
          && Render.focusDim({ highway: 'primary' }) === true
          && Render.focusDim({ route: 'bus' }) === true
          && Render.focusDim({ building: 'yes' }) === true);

        // 换到一个与公交无关的显示模式：方案照样生效（这就是"子选项"该有的表现）
        Render.setDisplayMode('speed');
        check('解耦（车速模式 + 公司方案）：公交取色仍是公司色（方案不被显示模式清掉）',
          Render.displayMode === 'speed' && Render.transitColorScheme() === 'company'
          && Render.transitColorSchemeEffective() === 'company'
          && Render.transitLineColor(byId(11)) === railCompany);

        // 旧别名：老的 ui.js 传这三个 id 进 setDisplayMode，等于"设方案 + 设显示模式"
        Render.setDisplayMode('fare');
        check('别名：setDisplayMode(\'fare\') = 设方案 + 设显示模式（老 ui.js / 老测试原样有效）',
          Render.displayMode === 'fare' && Render.transitColorScheme() === 'fare'
          && Render.transitColorSchemeEffective() === 'fare' && Render.isTransitColorMode('fare')
          && Render.transitLineColor(byId(11)) === TRANSIT_FARE_BANDS[1][2],
          `displayMode=${Render.displayMode} · scheme=${Render.transitColorScheme()}`);
        Render.setDisplayMode('company');
        check('别名与显式设置写同一个字段：setDisplayMode(\'company\') 覆盖之前的方案（后调的说了算）',
          Render.displayMode === 'company' && Render.transitColorScheme() === 'company'
          && Render.transitLineColor(byId(11)) === railCompany);
        Render.setDisplayMode('normal');
        check('别名：离开旧的"分色显示模式" → 方案回到 auto（旧行为：普通模式下不再改公交配色）',
          Render.displayMode === 'normal' && Render.transitColorScheme() === TRANSIT_COLOR_SCHEME_AUTO
          && Render.transitColorSchemeEffective() === 'linecolor');
        Render.setTransitColorScheme('fare');
        Render.setDisplayMode('normal');
        check('显式方案不被显示模式清掉（setTransitColorScheme 之后切普通 / 车速都还在）',
          Render.transitColorScheme() === 'fare' && Render.transitColorSchemeEffective() === 'fare'
          && Render.transitLineColor(byId(11)) === TRANSIT_FARE_BANDS[1][2]);

        // 方案回到 auto：每条线又是自己的颜色（auto = 线路本色：自己的颜色 + 撞色兜底）
        Render.setTransitColorScheme(TRANSIT_COLOR_SCHEME_AUTO);
        const autoOwn = Render.transitLineColor(byId(11));
        const autoDup = Render.transitLineColor(byId(12));
        check('方案回到 auto：线路恢复每条线自己的颜色（钩子也把原函数的返回值原样交回），车站 / 车辆回到公司自己的颜色',
          autoOwn === '#e6194b' && fake.lineColor(byId(11)) === '#e6194b'
          && Render.transitCompanyColor(1) === null && Render.transitStationColor(fake.data.stations[0]) === null
          && fake.companyColor(1) === '#888888',
          `auto → 1 路 ${autoOwn} · 车站 / 车辆交回原函数 → ${fake.companyColor(1)}`);
        check('auto = 线路本色：撞色的重复线路仍拿确定的备用色（不是 #e6194b），没填颜色的线仍交回 transit.js',
          autoDup !== '#e6194b' && /^#[0-9a-f]{6}$/.test(autoDup) && Render.transitLineColor(byId(14)) === null,
          `auto → 2 路 ${autoDup}`);

        // 子选项清单 + 图例：面板在「轨交 / 公交」下面那一行就用它
        Render.setTransitColorScheme('company');
        const defsScheme = Render.transitColorSchemeDefs();
        check('子选项清单 transitColorSchemeDefs()：三项 {id,name,short,ico,hint}，active/chosen 跟着方案走；旧名 transitColorModeDefs() 同值',
          defsScheme.length === 3
          && defsScheme.every((d) => !!d.id && !!d.name && !!d.short && !!d.ico && !!d.hint)
          && defsScheme.map((d) => d.id).join(',') === TRANSIT_COLOR_MODES.join(',')
          && defsScheme.filter((d) => d.chosen).length === 1
          && defsScheme.find((d) => d.chosen).id === 'company'
          && defsScheme.find((d) => d.active).id === 'company'
          && Render.transitColorModeDefs().map((d) => d.id).join(',') === defsScheme.map((d) => d.id).join(','),
          defsScheme.map((d) => `${d.id}${d.chosen ? '*' : ''}`).join(' / '));
        check('图例：legendModel(方案 id) 对三种方案与 auto 都给得出分类图例，legendCss 也认这些取值',
          ['linecolor', 'company', 'fare', TRANSIT_COLOR_SCHEME_AUTO].every((s) => {
            const m = Render.legendModel(s);
            return !!m && m.categorical === true && m.entries.length > 0 && /rgb\(/.test(Render.legendCss(s));
          })
          && Render.legendModel(TRANSIT_COLOR_SCHEME_AUTO).auto === true
          && Render.legendModel('company').scheme === 'company'
          && Render.legendModel('normal') === null,
          Render.legendCss('company').slice(0, 48) + '…');
        Render.setFocus('rail');
        Render.setTransitColorScheme('fare');
        const lgRail = Render.legendModel('rail');
        check('图例：轨交 / 公交模式下（选了方案时）给的是当前方案的图例 —— 子选项行与图例同一份数据',
          !!lgRail && lgRail.categorical === true && lgRail.mode === 'fare'
          && lgRail.entries.length === TRANSIT_FARE_BANDS.length
          && Render.legendCss('rail') === Render.legendCss('fare'));
        Render.setTransitColorScheme(TRANSIT_COLOR_SCHEME_AUTO);
        check('图例：轨交模式 + auto（没选方案）→ 不给公交分色图例（与老 ui.js 里 rail/bus 没有图例的行为一致）',
          Render.legendModel('rail') === null && Render.legendModel('bus') === null);

        // 统计如实报告两条轴
        Render.setTransitColorScheme('company');
        const stScheme = Render.transitColorStats();
        check('统计：同时如实报告颜色方案与显示模式（scheme / effectiveScheme / schemeSource / active）',
          stScheme.scheme === 'company' && stScheme.effectiveScheme === 'company'
          && stScheme.schemeSource === 'explicit' && stScheme.active === true && stScheme.schemeChosen === true
          && typeof stScheme.text === 'string' && stScheme.text.length > 0 && !!stScheme.schemeName,
          stScheme.text);
        Render.setTransitColorScheme(TRANSIT_COLOR_SCHEME_AUTO);
        check('统计：auto 时如实说"没选方案"（active=false，文案讲清 auto = 线路本色）',
          Render.transitColorStats().active === false
          && Render.transitColorStats().schemeAuto === true
          && Render.transitColorStats().text.indexOf('auto') >= 0,
          Render.transitColorStats().text);

        // 底图配色与最初一模一样（车速 / 拥堵 / 道路等级表 / 底图道路画法 / 详细度，方案切换一概不碰）
        const roadPaintsNow = Render.roadColorSnapshot();
        check('底图零影响（整节方案切换之后）：车速配色 / 拥堵配色 / 道路等级表 / 底图道路画法 / 详细度与最初完全一样',
          Render.colorForSpeed(60) === baseBefore.speed && Render.blockRoadKeep(14) === baseBefore.roadKeep
          && Render.serverRoadSend(14) === baseBefore.serverSend && Render.roadRank({ highway: 'primary' }) === baseBefore.rank
          && Render.detailName() === baseBefore.detail
          && Render.congestionScale.colors.free === baseBefore.jam.free
          && Render.congestionScale.colors.busy === baseBefore.jam.busy
          && Render.congestionScale.colors.jam === baseBefore.jam.jam
          && roadPaintsNow === baseBefore.roadPaints,
          `车速 ${Render.colorForSpeed(60)} · 拥堵 ${Render.congestionScale.colors.free}/${Render.congestionScale.colors.busy}/${Render.congestionScale.colors.jam}`
            + (roadPaintsNow ? ` · 道路 ${roadPaintsNow.split(' ; ')[1]}` : ' · 样式表未就绪（只比对了等级表）'));
        Render.focus = null;

        /* ---------- 11) 真实数据（已经连上服务器时） ---------- */
        G.Transit = TBefore;
        Render.transitColorCacheBust();
        const realLines = (TBefore && TBefore.data && Array.isArray(TBefore.data.lines)) ? TBefore.data.lines : [];
        if (!realLines.length) {
          check('真实数据自检：本次会话还没有交通快照（合成数据部分已全部通过）', true, '无 Transit.data.lines');
        } else {
          const gather = () => {
            const bag = { linecolor: {}, company: {}, fare: {} };
            for (const m of ['linecolor', 'company', 'fare']) {
              Render.displayMode = m;
              for (const ln of realLines) {
                const hex = Render.transitLineColor(ln);
                bag[m][ln.id] = hex || Render.normalizeTransitHex(ln.color) || '#8ab4f8';
              }
            }
            return bag;
          };
          const first = gather();
          Render.transitColorCacheBust();
          const second = gather();
          const stable = ['linecolor', 'company', 'fare'].every((m) => Object.keys(first[m]).every((id) => first[m][id] === second[m][id]));
          check(`真实数据（${realLines.length} 条线）：清缓存重算后三个模式的颜色完全一致（稳定）`, stable,
            JSON.stringify(first.company));
          const uniq = (m) => new Set(Object.keys(first[m]).map((id) => first[m][id])).size;
          const differs = Object.keys(first.linecolor).some((id) => first.linecolor[id] !== first.company[id])
            && Object.keys(first.linecolor).some((id) => first.linecolor[id] !== first.fare[id])
            && Object.keys(first.company).some((id) => first.company[id] !== first.fare[id]);
          check('真实数据：三个模式确实给出三套不同的颜色', differs,
            `线路本色 ${uniq('linecolor')} 色 / 公司 ${uniq('company')} 色 / 票价 ${uniq('fare')} 色`);
          Render.displayMode = 'fare';
          const stReal = Render.transitColorStats();
          check('真实数据：票价模式给出每条线的里程 / 票价 / 档（里程来源逐条标注）',
            stReal.lines.length === realLines.length && stReal.lines.every((l) => l.fare >= 3)
            && stReal.lines.every((l) => ['pathLen', 'pathCoords', 'stopsInfo', 'none'].indexOf(l.lengthSource) >= 0),
            stReal.lines.map((l) => `${l.name}:${l.lengthM}m/${l.fare}元/${l.bandName}`).join(' · '));
        }

        result = {
          ok: failures.length === 0,
          steps,
          failures,
          modes: Render.transitColorModes,
          schemes: Render.transitColorSchemes.slice(),
          scheme: Render.transitColorSchemeId,
          fare: Render.transitFareConfig(),
          stats: Render.transitColorStats(),
          legendCss: { company: Render.legendCss('company'), fare: Render.legendCss('fare') },
        };
      } finally {
        Render.rebuild = rebuildBefore;
        Render.scheduleOverlay = overlayBefore;
        Render.ensureCongestion = cgBefore;
        Render.ensureCells = cellsBefore;
        Render.transitColorUniqueFallback = fallbackBefore;
        Render.displayMode = modeBefore;
        Render.focus = focusBefore;
        // 方案 + "方案是怎么来的"一起还原（直接写字段：不再触发装钩子 / 作废缓存这类副作用）
        Render.transitColorSchemeId = schemeBefore;
        Render._transitColorSchemeSource = schemeSourceBefore;
        if (TBefore === undefined) delete G.Transit;
        else G.Transit = TBefore;
        Render.transitColorCacheBust();
        if (statsBefore.lookups === 0) Render.stats.transitColorLookups = 0;
        if (statsBefore.fallbacks === 0) Render.stats.transitColorFallbacks = 0;
        if (!result) console.error('[transitColor] 自检中断：' + failures.join('；'));
        else if (!result.ok) console.error('[transitColor] 自检失败：' + failures.join('；'));
      }
      return result;
    },

    /* ------------------------------ 投影自检（点击 / 绘制必须像素级对齐） ------------------------------ */
    /**
     * 覆盖画布自检：证明"画布上的像素管线"和 Leaflet 的容器坐标是同一套坐标。
     *
     * 不变量（每一个采样点都必须成立，误差 < tolerance，默认 0.5px）：
     *   map.latLngToContainerPoint(ll)
     *     === P(ll)（自有像素管线）经画布 2D 变换（devicePixelRatio 缩放）
     *         再经画布 bounding rect 换算回容器坐标
     * 顺带核对画布"比视口大一圈"的锚定：左上角必须正好在容器的 (-PAD,-PAD)、
     * 尺寸必须等于视口 + 2×PAD、样式尺寸与像素尺寸必须正好差一个 devicePixelRatio。
     * 这四条里只要有一条不成立，覆盖画布上的东西（标签 / POI / 选中高亮 / 线路站车）
     * 就会和 Leaflet 认为的位置错开 —— 表现就是"点哪儿都选偏几厘米"。
     *
     * @param {{lat?:number, lon?:number, tolerance?:number, resize?:boolean, log?:boolean}} options
     *   resize=true 时额外做一次"布局变化（把地图容器缩小 48px 再 map.invalidateSize()）"后的复测，
     *   并在结束后原样还原；证明布局变化不会让投影漂移。
     * @returns {{ok:boolean, tolerance:number, pad:number, dpr:number, before:object, after:object|null, steps:Array}}
     */
    selfCheckProjection(options = {}) {
      const tol = Number.isFinite(Number(options.tolerance)) ? Math.abs(Number(options.tolerance)) : 0.5;
      const steps = [];
      const check = (name, ok, detail) => {
        steps.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
        return !!ok;
      };
      const map = Render.map;
      const overlay = Render.overlay;
      const canvas = overlay && overlay._canvas;
      if (!map || !canvas || !overlay._ctx) {
        console.warn('[projection] 自检不可用：地图或覆盖画布还没准备好');
        return { ok: false, error: 'no-map-or-overlay', steps };
      }
      const ctx = overlay._ctx;
      const container = map.getContainer ? map.getContainer() : map._container;
      const center = map.getCenter();
      const lat = Number.isFinite(Number(options.lat)) ? Number(options.lat) : center.lat;
      const lon = Number.isFinite(Number(options.lon)) ? Number(options.lon) : center.lng;

      /** 量一轮：中心 + 四角附近的采样点，量完返回全部数字 */
      const measure = () => {
        const mapRect = container.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // 画布"属性像素 → 画布 CSS 像素"的换算系数：正常就是 1/dpr。
        // 样式尺寸跟像素尺寸对不上（DPR 处理错）时，这里会立刻把误差暴露出来。
        const sx = canvas.width ? canvasRect.width / canvas.width : 1;
        const sy = canvas.height ? canvasRect.height / canvas.height : 1;
        const m = (typeof ctx.getTransform === 'function') ? ctx.getTransform() : (overlay._ctxMatrix || null);
        const size = map.getSize();
        const latlngs = [[lat, lon]];
        for (const fx of [0.18, 0.82]) {
          for (const fy of [0.18, 0.82]) latlngs.push(map.containerPointToLatLng([size.x * fx, size.y * fy]));
        }
        const samples = latlngs.map((ll) => {
          const cp = map.latLngToContainerPoint(ll);   // Leaflet 的容器坐标
          const pipe = overlayPoint(map, ll);          // 自有像素管线（画布逻辑坐标 = 容器坐标 + PAD）
          const devX = m ? m.a * pipe.x + m.c * pipe.y + m.e : pipe.x * dpr;
          const devY = m ? m.b * pipe.x + m.d * pipe.y + m.f : pipe.y * dpr;
          const drawn = {
            x: (canvasRect.left - mapRect.left) + devX * sx,
            y: (canvasRect.top - mapRect.top) + devY * sy,
          };
          return {
            lat: ll.lat, lon: ll.lng,
            leaflet: { x: cp.x, y: cp.y },
            pipe,
            drawn,
            dx: drawn.x - cp.x,
            dy: drawn.y - cp.y,
            err: Math.hypot(drawn.x - cp.x, drawn.y - cp.y),
          };
        });
        return {
          dpr,
          mapSize: { x: size.x, y: size.y },
          pad: OVERLAY_PAD,
          canvasRel: { left: canvasRect.left - mapRect.left, top: canvasRect.top - mapRect.top },
          canvasCss: { w: canvasRect.width, h: canvasRect.height },
          canvasAttr: { w: canvas.width, h: canvas.height },
          ctxMatrix: m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : null,
          samples,
          maxErr: samples.reduce((a, s) => Math.max(a, s.err), 0),
        };
      };

      /** 一轮测量 → 四条断言 */
      const judge = (label, r) => {
        check(`${label}：画布像素管线 == Leaflet 容器坐标（< ${tol}px）`, r.maxErr < tol,
          `最大误差 ${r.maxErr.toFixed(3)}px · 各点偏差 ${r.samples.map((s) => `(${s.dx.toFixed(2)},${s.dy.toFixed(2)})`).join(' ')}`);
        check(`${label}：画布左上角锚在容器 (${-OVERLAY_PAD},${-OVERLAY_PAD})`,
          Math.abs(r.canvasRel.left + OVERLAY_PAD) < 0.51 && Math.abs(r.canvasRel.top + OVERLAY_PAD) < 0.51,
          `实际 (${r.canvasRel.left.toFixed(2)},${r.canvasRel.top.toFixed(2)})`);
        check(`${label}：画布尺寸 = 视口 + 2×PAD`,
          Math.abs(r.canvasCss.w - (r.mapSize.x + OVERLAY_PAD * 2)) < 1.51
          && Math.abs(r.canvasCss.h - (r.mapSize.y + OVERLAY_PAD * 2)) < 1.51,
          `${r.canvasCss.w}×${r.canvasCss.h} vs 期望 ${r.mapSize.x + OVERLAY_PAD * 2}×${r.mapSize.y + OVERLAY_PAD * 2}`);
        check(`${label}：画布样式尺寸与像素尺寸之比 == devicePixelRatio`,
          Math.abs(r.canvasAttr.w / (r.canvasCss.w || 1) - r.dpr) < 0.01
          && Math.abs(r.canvasAttr.h / (r.canvasCss.h || 1) - r.dpr) < 0.01,
          `像素 ${r.canvasAttr.w}×${r.canvasAttr.h} · CSS ${r.canvasCss.w}×${r.canvasCss.h} · dpr ${r.dpr}`);
      };

      const fmtLine = (r) => r.samples.map((s) => `(${s.leaflet.x.toFixed(1)},${s.leaflet.y.toFixed(1)})→`
        + `(${s.drawn.x.toFixed(2)},${s.drawn.y.toFixed(2)}) err=${s.err.toFixed(3)}px`).join(' · ');

      const before = measure();
      judge('现在', before);
      // 这三行只是给人看的补充：数字与结论全都在返回的 steps/before/after 里（自检脚本读返回值），
      // 自检失败仍然走 console.error。所以默认静默 —— 要看就在控制台开 `localStorage.setItem('osmcity.debug','1')`
      // 后刷新，或当前页面 `window.G.util.debug = true`（见 util.debugLog）。
      util.debugLog(`[projection] PAD=${OVERLAY_PAD} · dpr=${before.dpr} · 视口 ${before.mapSize.x}×${before.mapSize.y}`
        + ` · 画布相对容器 (${before.canvasRel.left.toFixed(1)},${before.canvasRel.top.toFixed(1)})`
        + ` · 画布 ${before.canvasCss.w}×${before.canvasCss.h}（像素 ${before.canvasAttr.w}×${before.canvasAttr.h}）`
        + ` · 画布 2D 变换 ${JSON.stringify(before.ctxMatrix)}`);
      util.debugLog(`[projection] 现在：${fmtLine(before)} · 最大误差 ${before.maxErr.toFixed(3)}px`);

      let after = null;
      if (options.resize) {
        // 布局变化（状态栏/提示条/面板挤压地图）：必须重新 invalidateSize 并复测
        const prevHeight = container.style.height;
        const h0 = container.clientHeight;
        container.style.height = Math.max(160, h0 - 48) + 'px';
        if (map.invalidateSize) map.invalidateSize();
        after = measure();
        judge('布局变化后', after);
        container.style.height = prevHeight;
        if (map.invalidateSize) map.invalidateSize();
        const restored = measure();
        judge('布局还原后', restored);
        util.debugLog(`[projection] 布局变化后（容器高度 ${h0} → ${after.mapSize.y} → ${restored.mapSize.y}）：`
          + `${fmtLine(after)} · 最大误差 ${after.maxErr.toFixed(3)}px`);
      }

      const ok = steps.every((s) => s.ok);
      if (!ok) {
        console.error('[projection] 自检失败：'
          + steps.filter((s) => !s.ok).map((s) => `${s.name} —— ${s.detail}`).join('；'));
      }
      return { ok, tolerance: tol, pad: OVERLAY_PAD, dpr: before.dpr, before, after, steps };
    },

    /* ------------------------------ 拾取 ------------------------------ */
    /** 返回点击位置下的候选元素（按优先级排序，可循环切换） */
    pickCandidates(latlng) {
      const map = Render.map;
      const mpp = Render.metersPerPixel();
      const ptPx = map.latLngToContainerPoint(latlng);
      const out = [];
      const toPx = (lat, lon) => {
        const p = map.latLngToContainerPoint([lat, lon]);
        return Math.hypot(p.x - ptPx.x, p.y - ptPx.y);
      };

      for (const node of Render._visibleNodes) {
        const d = toPx(node.lat, node.lon);
        if (d < 16) out.push({ type: 'node', id: node.id, dist: d, area: 0, priority: 0 });
      }
      for (const way of Render._visibleWays) {
        const closed = World.isClosed(way);
        if (closed && util.pointInRing(latlng, World.wayCoords(way))) {
          out.push({ type: 'way', id: way.id, dist: 0, area: World.wayArea(way) || 1, priority: 1 });
          continue;
        }
        const coords = World.wayCoords(way);
        let best = Infinity;
        for (let i = 1; i < coords.length; i++) {
          const d = util.distToSegmentMeters(latlng, coords[i - 1], coords[i]);
          if (d < best) best = d;
        }
        if (best / mpp < 10) out.push({ type: 'way', id: way.id, dist: best / mpp, area: 0, priority: 2 });
      }
      for (const rel of Render._visibleRelations) {
        const rings = World.ringsOf('relation', rel.id);
        let outers = rings.outers;
        let inners = rings.inners;
        if (!outers.length) {
          // 环没缝出来（成员缺几何之类）：退回"按成员 way 判断"的老办法
          outers = [];
          inners = [];
          for (const m of rel.members) {
            if (m.type !== 'way' || m.role === 'inner') continue;
            const c = World.wayCoords(World.getWay(m.ref));
            if (c.length) outers.push(c);
          }
        }
        if (!outers.some((ring) => util.pointInRing(latlng, ring))) continue;
        // 天井（内环）里点下去应该穿过去选底下的东西，而不是选中这栋楼
        if (inners.some((ring) => util.pointInRing(latlng, ring))) continue;
        out.push({ type: 'relation', id: rel.id, dist: 0, area: 1e9, priority: 3 });
      }

      out.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.area && b.area) return a.area - b.area;
        return a.dist - b.dist;
      });
      return out;
    },

    /** 拾取一个元素；同一位置重复点击会依次循环候选 */
    pick(latlng, cycle = false) {
      const cands = Render.pickCandidates(latlng);
      if (!cands.length) return null;
      if (!cycle || cands.length === 1) return cands[0];
      const last = Render._lastPick;
      const key = (c) => c.type + ':' + c.id;
      const idx = last && last.cands && last.cands.length === cands.length
        ? last.cands.findIndex((c) => key(c) === key(last.chosen)) : -1;
      const chosen = cands[(idx + 1) % cands.length];
      Render._lastPick = { cands, chosen };
      return chosen;
    },

    resetPickCycle() { Render._lastPick = null; },

    /** 选中元素所在的节点手柄（用于拖动） */
    nodeHandles(type, id) {
      if (type === 'node') {
        const n = World.getNode(id);
        return n ? [{ id: n.id, lat: n.lat, lon: n.lon }] : [];
      }
      if (type !== 'way') return [];
      const way = World.getWay(id);
      if (!way) return [];
      return way.nodes.map((nid) => {
        const n = World.getNode(nid);
        return n ? { id: nid, lat: n.lat, lon: n.lon } : null;
      }).filter(Boolean);
    },

    flyToElement(type, id, zoom) {
      const center = World.centerOf(type, id);
      if (!center) return false;
      return util.flyToSafe(Render.map, center.lat, center.lon, zoom);
    },
  };

  window.G.Render = Render;
})();
