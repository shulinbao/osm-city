'use strict';
/**
 * 铁路/公交经营玩法的前端：公司、车站、线路、车辆、游戏时钟、人口热力图。
 * 数据全部来自服务端（权威模拟），这里只做展示与操作发起。
 */
(function () {
  const { util, World, Render, Net, Editor } = window.G;

  const MODE_LABEL = { rail: '铁路', subway: '地铁', tram: '有轨电车', light_rail: '轻轨', intercity: '城际', hsr: '高铁', bus: '公交' };
  const SPEEDS = [0, 1, 2, 5, 10, 20, 60, 120, 300];

  /**
   * 失败提示**由调用方负责**的操作：onAck 不再兜底弹 toast，免得同一个错误弹两条。
   *   clock.set —— Transit.setSpeed 的 .catch 弹「倍速设置失败」，
   *                ui.js 的「跳到…」（UI.jumpToClock）弹带「时间仍是第N天 …」上下文的提示。
   */
  const CALLER_TOAST_OPS = { 'clock.set': 1 };

  /**
   * 元素锁（协作编辑的客户端一面）。
   *
   * 服务端那条铁律（见 server/transit.js 顶部）：**谁都可以改任何人建的交通资产**，车站更是连归属
   * 都没有了 —— 改名 / 删除 / 挪动任何车站（含底图导入的公共车站）一律允许；
   * 冲突靠**元素锁**挡（transit op `lock.set`，TTL 120 秒，与 OSM 那张锁表共用一份）：
   * 谁在改谁上锁，别人拿到一句明确的中文原因，直到对方收工 / 断线 / 超时。
   *
   * 客户端这边只做两件事（锁的权威永远在服务端，本机这份只决定界面怎么写）：
   *   1) 打开某个元素的编辑器（车站表单 / 车辆管理器 / 线路管理器）就上锁，关掉编辑器就解锁；
   *   2) 上锁被拒（别人占着）时把**服务端那句中文原因**弹出来，并把这个编辑器画成只读。
   */
  const LOCK_ELEM_LABEL = { station: '车站', line: '线路', vehicle: '车辆', company: '公司' };

  /** 被别人占着的锁多久重试一次（对方收工 / 断线 / TTL 过期都不会有广播，所以只能自己隔一会儿再问一次） */
  const LOCK_RETRY_MS = 30000;

  /**
   * 被别人锁着时的那句中文原因 —— 与 server/transit.js 的 checkElementLock / osmops 的 checkLock
   * 一字不差（同一个口径，不在客户端另编一套说法）。
   */
  function lockBusyText(by) {
    return `${by || '别的玩家'} 正在编辑这个元素，请稍后再试`;
  }

  /**
   * #车厂：车辆"不在运营"的原因 → 中文短句（与服务端 DEPOT_REASON_NOTE 同一套说法，
   * 只是这里不带「在车厂（未运营）· 」前缀 —— 前缀由 vehicleDepotInfo 拼）。
   *
   * 正常情况下这句话是**服务端下发**的（vehicles[].depotNote，权威）；这张表只在一种情况下用：
   * 客户端自己推断出"我这辆车不在运营了"（帧里没有它 = 服务端没把它算在运营），
   * 而手上那份 vehicles[] 还是旧快照 —— 这时要有一句像样的中文，等下一份快照把它补正。
   */
  const DEPOT_REASON_TEXT = {
    idle: '没指派线路（闲置）',
    paused: '线路已暂停运营，车辆已回车厂',
    'before-departure': '还没到发车时刻，在始发站等点',
    'service-ended': '今天的班次已经跑完，回场过夜',
    'no-departure': '这条线没有分给本车的班次',
    'no-path': '线路还没有可跑的路径',
    'not-online': '还没被模拟步进过（下一次 tick 才上线）',
  };

  /** 「在车厂（未运营）」这半句只有一份（列表 / 详情 / 气泡共用），别在各处另写一遍 */
  const DEPOT_PREFIX = '在车厂（未运营）';

  /**
   * 站点类型表兜底：权威表由服务端下发（transit 的 kinds 操作 → stationKinds），
   * 这里先放一份同名同序的默认值，这样服务器还没回话 / 断线时下拉框也不是空的。
   */
  const STATION_KIND_FALLBACK = {
    hsr: { name: '高铁站', minZoom: 9 },
    intercity: { name: '城际站', minZoom: 11 },
    rail: { name: '普速车站', minZoom: 13 },
    subway: { name: '地铁站', minZoom: 14 },
    light_rail: { name: '轻轨站', minZoom: 14 },
    tram: { name: '有轨电车站', minZoom: 15 },
    bus: { name: '公交站', minZoom: 15 },
  };

  /**
   * 设站模式芯片的兜底图标：正常情况下芯片由 editor.js 的 Editor.STATION_MODES 提供
   * （那份表是唯一来源，含 ico/name/tip）；只有当它也没加载时，我们才用服务端类型表自己拼一行，
   * 这时靠这张小表补图标，保证 7 种模式都有像样的字形。
   */
  const STATION_MODE_ICO = {
    hsr: '🚄', intercity: '🚈', rail: '🚆', subway: '🚇', light_rail: '🚊', tram: '🚋', bus: '🚌',
  };

  /** 站台长度 / 吸引半径的合法区间（与服务端 station.update 的钳制范围一致） */
  const PLATFORM_MIN_M = 30;
  const PLATFORM_MAX_M = 600;
  const CATCHMENT_MIN_M = 200;
  const CATCHMENT_MAX_M = 3000;
  /**
   * 车站 / 车辆的分级显示阈值（唯一的可配置入口：Transit.stationLod / Transit.setStationLod）。
   *   dotMinZoom         车站圆点的全局最低级别 —— 与**每种类型自己的 minZoom 取较大值**（类型表仍是下限）
   *   nameMinZoom        站名标签（自己的站 / 鼠标悬停的站）
   *   waitingMinZoom     等车人数徽标（老版本写死 z16）
   *   bubbleMinZoom      车辆信息气泡（老版本写死 z15）
   *   maxMetersPer100px  视野尺度上限：**可见地面尺度**超过它就整块隐藏车站 / 等车徽标 / 车辆气泡
   *                      （道路与轨道照常画；阈值按 Render.metersPerPixel() 反算，不写死 zoom）
   * 默认值把等车徽标从 z16 提前到 z15、车辆气泡从 z15 提前到 z14 —— 也就是"看得更远"一档。
   * 车站圆点这里**不放松**：dotMinZoom 默认 9，实际阈值永远是 max(类型 minZoom, dotMinZoom)，
   * 也就是说每种类型的 minZoom 仍然是硬下限（公交站 z15、地铁站 z14 …）。想让某类车站也早一级
   * 出现，就调低那一类的 minZoom（服务端 stationKinds 可下发，或改 STATION_MIN_ZOOM），
   * 或者把 maxMetersPer100px 调大（例如 1000）让 z14 这种尺度也允许显示车站。
   * 改法：Transit.setStationLod({ waitingMinZoom: 14 })（记在本机 localStorage），
   * 服务端 config.transit.stationLod 也能下发同一份字段。
   */
  const STATION_LOD_DEFAULT = {
    dotMinZoom: 9,
    nameMinZoom: 11,
    waitingMinZoom: 15,
    bubbleMinZoom: 14,
    maxMetersPer100px: 600,
  };
  /** 只认这几个键（脏数据不会把渲染搞坏） */
  const STATION_LOD_FIELDS = ['dotMinZoom', 'nameMinZoom', 'waitingMinZoom', 'bubbleMinZoom', 'maxMetersPer100px'];
  /**
   * 每个字段的合法区间：**越界就是脏数据，换回默认值**（和"不是有限数"同等对待）。
   * 前四个是缩放级别（地图 minZoom=3 / maxZoom=22，这里从 0 起放宽一点，免得服务端下发 0 被吃掉）；
   * maxMetersPer100px 是"每 100 像素多少米"的视野尺度上限，5 米以下没有实际意义（等于关闭渲染），
   * 100000 米以上任何视角都不会触发"缩太远就隐藏"，都属于脏数据。
   */
  const STATION_LOD_RANGE = {
    dotMinZoom: [0, 22],
    nameMinZoom: [0, 22],
    waitingMinZoom: [0, 22],
    bubbleMinZoom: [0, 22],
    maxMetersPer100px: [5, 100000],
  };
  /** 玩家改过的阈值记在这里，刷新后还在 */
  const STATION_LOD_KEY = 'osmcity.transit.stationLod';

  /**
   * 是不是"普通对象"：数组 / null / 数字 / 字符串 / 布尔 / Date / class 实例统统不算。
   * 存档里整块不是普通对象时**整个忽略**（回默认值），而不是逐字段去猜。
   */
  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  /**
   * 严格取一个数：**只认真正的有限数**且落在 [lo, hi] 内；
   * 字符串（"14" / "abc"）、NaN、±Infinity、越界、null / undefined 一律返回 null（调用方用默认值）。
   */
  function strictNumber(v, lo, hi) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (v < lo || v > hi) return null;
    return v;
  }

  /**
   * 把任意来源（localStorage / 服务端 config / 运行时实参）的 station-lod 整形成"只含合法字段"的对象：
   *   - 整块不是普通对象 → 返回 {}（等于整块忽略）
   *   - 字段不是有限数 / 越界 → 该字段不要（调用方用默认值）
   * 这里**绝不抛异常**，也绝不返回 NaN / Infinity —— 渲染路径上的阈值永远是能用的数。
   */
  function sanitizeStationLod(src) {
    const out = {};
    if (!isPlainObject(src)) return out;
    for (const k of STATION_LOD_FIELDS) {
      const r = STATION_LOD_RANGE[k] || [0, Infinity];
      const n = strictNumber(src[k], r[0], r[1]);
      if (n !== null) out[k] = n;
    }
    return out;
  }

  /**
   * 车辆信息泡泡（线路 · 载客/定员 · 下一站）：放到足够近才画（门槛见 stationLod.bubbleMinZoom）。
   * 每一辆车都必须有泡泡 —— 没有"最多 8 个"这种上限了：和别的泡泡压在一起时往上错开位置，
   * 实在错不开就挪到车身下方，总之不隐藏（见 drawVehicleBubble）。
   */
  /** 泡泡尽量小：一行字，最大 110×16 像素（原来是 190 宽的三行大牌子，太挡地图） */
  const BUBBLE_MAX_W = 110;
  const BUBBLE_H = 16;
  /** 两个泡泡重叠时向上错开的次数上限（再撞就挪到车下方，但仍然画出来） */
  const BUBBLE_STACK_MAX = 6;
  /** 错开一层的步长：泡泡整高 + 4px 空隙（空隙要比 _rectHit 的 2px 判定大，否则算"还压着"） */
  const BUBBLE_STACK_STEP = BUBBLE_H + 4;
  /**
   * 泡泡 / 站名 / 等车徽标的点击判定放宽多少像素。
   * 这些图形是画在 canvas 上的，没有 DOM 事件，只能在 hitTest 里用"画过的矩形"反查，
   * 所以留 2px 余量，让鼠标不必精确压在边框上。
   */
  const BUBBLE_HIT_PAD = 2;

  /** 线路模式（与服务端 LINE_KINDS 同序）：改模式 = 按新制式重建路径 */
  const LINE_KIND_ORDER = ['rail', 'hsr', 'intercity', 'subway', 'light_rail', 'tram', 'bus'];
  /** 列表一次最多画多少行，之后用「显示更多」再加一页 */
  const LIST_LIMIT = 80;
  /**
   * 可排序的列：**每个分区一套**（四种实体能排的列本来就不一样，用同一套标签只会看不懂）——
   *   车站：名称 / 经过的线路数 / 等车人数 / 覆盖人口
   *   线路：站数 / 车辆数 / 日客流 / 等车人数
   *   车辆：载客 / 定员 / 车长 / 类型
   *   公司：车站数 / 线路数 / 车辆数 / 累计客流
   * 「异常清单」分区把异常线路与悬空车站画在同一个列表里，用 mixed 那套通用键（metricOf 按类型各算各的）。
   * 键就是 metricOf(type, item, key) 的入参；默认方向见 SORT_DESC_KEYS（数字大的先来）。
   * 每个列名都是芯片文字，点一下按它排、再点一下反向（箭头就画在芯片上）。
   */
  const SORT_DEFS_BY_TYPE = {
    stations: [
      ['default', '默认'], ['name', '名称'], ['lines', '经过的线路数'],
      ['waiting', '等车人数'], ['pop', '覆盖人口'],
    ],
    lines: [
      ['default', '默认'], ['name', '名称'], ['stops', '站数'],
      ['vehicles', '车辆数'], ['riders', '日客流'], ['waiting', '等车人数'],
    ],
    vehicles: [
      ['default', '默认'], ['name', '名称'], ['load', '载客'],
      ['capacity', '定员'], ['length', '车长'], ['kind', '类型'],
    ],
    companies: [
      ['default', '默认'], ['name', '名称'], ['stations', '车站数'],
      ['lines', '线路数'], ['vehicles', '车辆数'], ['riders', '累计客流'],
    ],
    mixed: [
      ['default', '默认'], ['name', '名称'], ['stops', '站数·线路数'],
      ['vehicles', '车辆数'], ['riders', '客流·覆盖人口'], ['waiting', '等车人数'],
    ],
  };
  /** 这些列「大的先来」更自然（默认降序）；其余（名称 / 类型 / 默认）默认升序 */
  const SORT_DESC_KEYS = { waiting: 1, riders: 1, load: 1, pop: 1, lines: 1, stops: 1, vehicles: 1, capacity: 1, length: 1, stations: 1 };
  /** 公交类车型：泡泡优先分给它们（城市里公交多，先保证公交车看得见） */
  const BUS_VEHICLE_KINDS = { bus: 1, bus_double: 1, bus_artic: 1, trolley: 1, minibus: 1 };
  /** 轨道类站点类型（生成示例地铁线时用它们挑站） */
  const RAIL_KINDS = { rail: 1, hsr: 1, intercity: 1, subway: 1, light_rail: 1, tram: 1 };

  /** 等车人数趋势的采样窗口：每 10 秒比一次，给出 ↑/↓ 的变化量 */
  const WAIT_TREND_WINDOW_MS = 10000;
  /** 有车站被选中时，隔多久去服务端拉一次最新候车数据（车站弹窗/管理器打开期间才拉） */
  const STATION_LIVE_MS = 4000;
  /**
   * 地图上的等车人数徽标是**每帧重画**的（Transit.draw），但服务端的 sim 帧（250ms 一次）只带
   * 车辆与公司 —— 车站的 waiting 只在整份快照里。所以只要当前缩放下画得出徽标，就按这个间隔
   * 去服务端拉一次整份快照（就是 snapshot().stations[].waiting，模拟帧里从来不带的那份数据），
   * 徽标/气泡/列表因此一直是活的（人多了变红、人少了变绿，箭头也跟着动）。
   */
  const WAIT_LIVE_MS = 2000;
  /** 车辆气泡里的线路名最多几个字（超过就截成「前 7 字 + …」，泡泡永远撑不破） */
  const BUBBLE_LINE_MAX_CHARS = 8;
  /** 车辆气泡里的下一站名最多几个字（留出宽度给载客/定员那两个数） */
  const BUBBLE_STOP_MAX_CHARS = 6;
  /** 气泡里线路名最多占泡泡宽度的比例（剩下的宽度留给载客 / 下一站） */
  const BUBBLE_LINE_MAX_W_RATIO = 0.45;
  /**
   * 点击后弹出的那个框（车站 / 车辆**共用**）的宽度：两种框一样大、一样紧凑 ——
   * 取值就是原来公交弹出框的那一对（190/240 是 Leaflet 的钳制区间，配合 .popup-mini 的 200/240），
   * 所以公交框一个像素没变，车站框从此跟它同一个尺寸。
   */
  const MINI_POPUP_MIN_W = 200;
  const MINI_POPUP_MAX_W = 240;

  /** 线路配色预设（线路行 / 线路管理器里的取色器） */  const LINE_COLOR_PRESETS = [
    '#e6194b', '#f58231', '#ffe119', '#3cb44b', '#42d4f4', '#4363d8',
    '#911eb4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#a9a9a9',
  ];
  const LINE_COLOR_RE = /^#[0-9a-f]{6}$/i;
  /** 线路没写颜色 / 颜色非法时用的兜底色（和线路管理器里的兜底色一致） */
  const LINE_COLOR_DEFAULT = '#8ab4f8';

  /** 没有站台长度的站点类型（公交站直接停路边，服务端也不给这个字段） */
  const PLATFORMLESS_KINDS = { bus: 1 };

  /**
   * 交通玩法自己那几块新 UI 的样式（站点管理器 / 线路取色器 / 公交站无站台提示）。
   * 只补新类名，不动 app.css；注入一次，挂在 <style data-transit-style> 上。
   */
  const TRANSIT_STYLE = `
.st-mgr { gap: 4px; }
.st-mgr-title { display: flex; align-items: baseline; gap: 6px; color: #fff; font-size: 12.5px; font-weight: 700; }
.st-mgr-title small { color: var(--fg-mute); font-family: var(--mono); font-size: 10px; font-weight: 400; }
.st-mgr .tp-row { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; line-height: 1.5; }
.st-mgr .tp-row > span { flex: 0 0 62px; color: var(--fg-mute); font-size: 11px; }
.st-mgr .tp-row > b { flex: 1 1 auto; min-width: 0; color: var(--fg); word-break: break-word; }
.st-mgr .tp-row > b small { color: var(--fg-mute); font-family: var(--mono); font-size: 10px; }
.stm-trend { font-family: var(--mono); font-weight: 700; }
.stm-trend.warn { color: #ffb3b3; }
.stm-trend.ok { color: #6ee7a8; }
.stm-trend-note { color: var(--fg-mute); font-size: 10px; }
/* 站点管理器的分组标题（基本信息 / 覆盖与客流 / 等车 / 经过线路）：旧版是一行粗体标题，
   现在整块升级成 .st-sec 分区块（和线路管理器的 .lm-sec 一个观感），这两条只留给老 DOM 兜底 */
.st-mgr-group { margin-top: 6px; padding-top: 5px; border-top: 1px solid var(--line-3); color: #fff; font-size: 11.5px; font-weight: 700; }
.st-mgr-group:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.st-mgr-group small { color: var(--fg-mute); font-size: 10px; font-weight: 400; }
.st-mgr-lines { display: flex; flex-direction: column; gap: 4px; }
.st-mgr-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 4px 6px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,0.03); font-size: 11.5px; }
.st-mgr-line .mini { margin-left: auto; }
/* 站台候车：**只有这一处**明细（跨线路汇总那一块已经删掉，合计收成顶上一行）。
   一行一条线，两行的紧凑表格：第一行 = 色点 + 线路名 + 等车人数（人数右对齐，数字列对齐），
   第二行 = 这条队伍的去向（→ 西单 3 · 王府井 2），一行放下就省略号收尾，全量清单在 title 里。
   没有第二个盒子/边框：行与行之间只有一道极淡的分隔线，窄面板（约 300px）下也读得下去。 */
.st-mgr-waits { display: flex; flex-direction: column; }
.st-mgr-wait { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; column-gap: 6px; align-items: baseline; padding: 3px 1px; font-size: 11.5px; }
.st-mgr-wait + .st-mgr-wait { border-top: 1px solid rgba(255,255,255,0.06); }
.st-mgr-wait .tp-dot { grid-column: 1; grid-row: 1; align-self: center; width: 8px; height: 8px; }
.st-mgr-wait .stm-lw-name { grid-column: 2; grid-row: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
.st-mgr-wait .stm-lw-wait { grid-column: 3; grid-row: 1; text-align: right; font-family: var(--mono); font-weight: 700; white-space: nowrap; }
.st-mgr-wait .stm-lw-wait small { color: var(--fg-mute); font-family: var(--mono); font-size: 10px; font-weight: 400; }
.st-mgr-wait .stm-lw-dest { grid-column: 2 / -1; grid-row: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-top: 1px; color: var(--fg-dim); font-size: 10.5px; }
.st-mgr-wait .stm-lw-dest.pending { color: var(--fg-mute); }
/* 「未指定线路」那一队（没有专属线路的乘客）：色点画成空心圈，一眼看出它不是某条具体的线 */
.st-mgr-wait.fallback .tp-dot { background: transparent !important; box-shadow: inset 0 0 0 2px rgba(255,255,255,0.38); }
/* 顶上那一行合计：共 12 人等车 · 4 个目的站（这是"整站"的口径，明细只在下面那几行里出现一次） */
.st-wait-total { display: flex; align-items: baseline; gap: 5px; flex-wrap: wrap; padding: 0 1px 5px; color: var(--fg-mute); font-size: 11px; }
.st-wait-total b { color: var(--fg); font-family: var(--mono); font-size: 12px; }
.st-wait-total .st-wait-sep { color: var(--line-3); }
/* 没人等的线路：一句压暗的话（完整清单进 title），不占一整块空行 */
.st-wait-zero { padding: 4px 1px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute); font-size: 10.5px; }
.st-mgr-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--line-3); }
.st-mgr-wrap { display: block; }
/* 站点管理器的"分区块"排版：和线路管理器的 .lm-sec 一个观感（一块一件事，头部右侧是这个块的动作按钮）。
   面板「车站」分区的详情就是站点管理器（气泡里没有第二份 DOM：地图上只弹小气泡）。 */
.st-mgr-wrap { display: flex; flex-direction: column; gap: 7px; }
.st-mgr-host { display: flex; flex-direction: column; gap: 7px; }
.st-mgr.tp-block { padding: 0; border: 0; background: none; border-radius: 0; gap: 7px; }
.st-sec { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: rgba(255,255,255,0.04); }
.st-sec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.st-sec-title { flex: 1 1 auto; min-width: 0; font-size: 12.5px; font-weight: 700; color: #fff; }
.st-sec-title small { color: var(--fg-mute); font-family: var(--mono); font-size: 10px; font-weight: 400; }
.st-sec-title b { font-family: var(--mono); }
.st-sec-hint { color: var(--fg-mute); font-size: 10.5px; }
.st-sec-acts { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.st-sec .mini { font-size: 11px; padding: 3px 8px; border-radius: 7px; border: 1px solid var(--line); background: rgba(255,255,255,0.07); color: var(--fg-dim); cursor: pointer; }
.st-sec .mini:hover { background: rgba(255,255,255,0.14); color: var(--fg); border-color: var(--accent-line); }
.st-sec .mini.danger { background: rgba(255,107,107,0.16); border-color: rgba(255,107,107,0.4); color: #ffb3b3; }
.st-sec .mini[disabled] { opacity: .45; cursor: not-allowed; }
/* 车站属性 / 加进线路这两块里是表单，实时刷新碰不到（在 .st-mgr-body 外面） */
.st-sec.tp-station-editor { margin-top: 0; padding-top: 8px; border-top: 1px solid var(--line); }
.st-source-note { color: var(--fg-mute); font-size: 10.5px; }
.st-no-platform { padding: 2px 0; color: var(--fg-mute); font-size: 11px; line-height: 1.5; }
.tp-colors { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 5px; padding-top: 5px; border-top: 1px dashed var(--line-3); }
.tp-colors-title { color: var(--fg-mute); font-size: 11px; }
.tp-color { width: 16px; height: 16px; min-width: 16px; padding: 0; border: 1px solid rgba(0,0,0,0.5); border-radius: 4px; cursor: pointer; }
.tp-color:hover { transform: scale(1.15); }
.tp-color.active { box-shadow: 0 0 0 2px var(--accent-line); }
.tp-color-hex { width: 78px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 6px; background: rgba(0,0,0,0.28); color: var(--fg); font-family: var(--mono); font-size: 11px; }
.tp-color-apply { margin-left: 2px; }

/* ---------------- 单一面板：左侧统一列表 + 右侧详情（车站 / 线路 / 车辆 / 公司 共用一个列表） ---------------- */
#transit:not(.big) { width: 430px; }
#transit-body { padding: 6px 8px 10px; gap: 5px; }
.tp-topbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tp-toolbar { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; padding-bottom: 5px; border-bottom: 1px solid var(--line); }
.tp-fsel { display: flex; align-items: center; gap: 4px; }
.tp-fsel-label { color: var(--fg-mute); font-size: 10.5px; }
.tp-sortbar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 4px 0 2px; }
.tp-sortbar .chip { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; }
.tp-sortlabel { color: var(--fg-mute); font-size: 10.5px; }
.tp-bubble { font-size: 11px; padding: 0; }
.tp-main { display: flex; flex-direction: row; gap: 8px; align-items: flex-start; min-height: 0; }
.tp-list { flex: 0 0 45%; max-height: 46vh; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-right: 3px; }
.tp-detail { flex: 1 1 auto; min-width: 0; max-height: 46vh; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
#transit.big .tp-list { flex: 0 0 320px; max-height: 64vh; }
#transit.big .tp-detail { max-height: 64vh; }
.tp-group { display: flex; align-items: baseline; gap: 6px; padding: 3px 2px 0; color: var(--fg-mute); font-size: 10.5px; }
.tp-group-title { font-weight: 700; color: var(--fg-dim); }
.tp-lrow { cursor: pointer; padding: 5px 6px; }
.tp-lrow:hover { background: rgba(255,255,255,0.09); }
.tp-lrow.active { border-color: var(--accent-line); background: var(--accent-soft); }
.tp-lrow.warn { border-color: rgba(255,107,107,0.45); background: rgba(255,107,107,0.08); }
/* #车厂：不在运营的车（在车厂）那一行压暗一点，和"在路上跑"的车一眼区分开（它不在地图上） */
.tp-lrow.depot { opacity: .78; }
.tp-lrow.depot .tp-item-head b { color: var(--fg-dim); }
/* 车辆列表行右上角那个「🗺 定位」：车没指派线路 / 没实时位置时是禁用状态（鼠标悬停能看到中文原因） */
.tp-lrow { position: relative; }
.tp-lrow .tp-loc {
  position: absolute; right: 6px; top: 6px; margin: 0; padding: 2px 7px;
  font-size: 10.5px; border-radius: 999px; border: 1px solid var(--line);
  background: rgba(255,255,255,0.07); color: var(--fg-dim); cursor: pointer;
}
.tp-lrow .tp-loc:hover { background: rgba(255,255,255,0.16); color: var(--fg); border-color: var(--accent-line); }
.tp-lrow .tp-loc[disabled] { opacity: .42; cursor: not-allowed; }
/* 有「定位」按钮的行：标题行右侧留出位置，别让角标压住车名 */
.tp-lrow.has-loc .tp-item-head { padding-right: 64px; }
.tp-lsub { font-size: 10.5px; color: var(--fg-mute); margin-top: 2px; line-height: 1.45; }
.tp-pager { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10.5px; color: var(--fg-mute); padding: 3px 2px 2px; }
.tp-pager .mini { font-size: 10.5px; padding: 2px 8px; border-radius: 7px; border: 1px solid var(--line); background: rgba(255,255,255,0.07); color: var(--text); cursor: pointer; }
.tp-blocktitle { font-size: 11.5px; font-weight: 700; color: #fff; margin-bottom: 2px; }
.tp-embed { display: flex; flex-direction: column; gap: 7px; }
.tp-kindrow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 5px; padding-top: 5px; border-top: 1px dashed var(--line-3); }
.tp-kindlabel { color: var(--fg-mute); font-size: 11px; }
.tp-kindwarn { color: #ffd166; font-size: 10.5px; }
/* 点出来的弹出框（车站 / 车辆**共用这一套紧凑排版**）：小、字段少、带定位与删除/撤下线路。
   取值就是原来车辆弹出框那一套（200~240 像素 / padding 1px 2px / 标题 12px / 行高 1.45），
   所以车辆弹出框一个像素都没变，而车站弹出框从此跟它一个样式、一个尺寸。 */
.osmcity-popup.popup-mini { min-width: 200px; max-width: 240px; }
.popup-mini { padding: 1px 2px; }
.popup-mini .popup-title { font-size: 12px; padding-bottom: 4px; }
.popup-mini .popup-row { gap: 6px; font-size: 11px; line-height: 1.45; }
.popup-mini .popup-row > span { flex: 0 0 52px; color: var(--fg-mute); font-family: var(--mono); font-size: 10.5px; }
.popup-mini .popup-row > b { flex: 1 1 auto; min-width: 0; font-weight: 600; word-break: break-word; }
.popup-mini .popup-row > b.late { color: #ffb3b3; }
.popup-mini .popup-actions { margin-top: 3px; }
.popup-mini .tp-trend { font-family: var(--mono); font-size: 10px; color: var(--fg-mute); }
.popup-mini .tp-trend.up { color: #ffd166; }
.popup-mini .tp-trend.down { color: #6ee7a8; }
/* 车站气泡里的那一行「每条线路各有多少人在等」（1路 6 人 · 2路 4 人）：
   只占一行，装不下就省略号（完整清单在 title 里），气泡不会因此变高变宽 */
.popup-mini .popup-row > b.stm-byline-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stm-byline { font-family: var(--mono); font-size: 10.5px; }
.stm-byline-none { color: var(--fg-mute); font-size: 10.5px; }
/* 面板「图层设置」里的自动隐藏提示（车站 / 等车人数 / 车辆气泡） */
#transit-body .tp-lod-hint { padding: 3px 0 1px; line-height: 1.5; }
#transit-body .tp-lod-hint .warn { color: #ffb3b3; }
#transit-body .tp-lod-hint .tp-lod-now { font-family: var(--mono); font-size: 10.5px; }
/* 车辆列表行里的营运一行（下一站 / 预计到站 / 班次准点） */
.tp-lsub .late { color: #ffb3b3; font-weight: 700; }
/* 面板里复用 editor.js 的设站模式芯片块（.opt-head / .opt-current 在 app.css 里只对工具面板配过样式） */
#transit-body .opt-field { padding: 0 0 2px; }
#transit-body .opt-head { font-size: 11.5px; font-weight: 700; color: #fff; padding-bottom: 2px; }
#transit-body .opt-current { font-size: 10.5px; color: var(--fg-mute); line-height: 1.5; padding-bottom: 2px; }
#transit-body .opt-chips { padding: 2px 0 4px; }

/* .opt-btn 在面板里没有基样式：app.css 只配过 .tool-options 里的那一份，
   面板里的 .opt-btn 落回浏览器默认按钮底色（浅灰 #efefef），而 body 的文字色是近白 #e7ebf3
   → 就是「白底白字」（例如「🚌 把闲置车辆全部加入这条线路」）。这里统一补成深底浅字。
   选择器比 linemgr.js 的 :is(#linemgr,.tp-embed) .opt-btn 更具体，两边取值保持一致。 */
#transit-body button.opt-btn {
  margin: 0; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--line);
  background: rgba(255,255,255,0.07); color: var(--fg-dim); font-size: 11.5px; cursor: pointer;
}
#transit-body button.opt-btn:hover { background: rgba(255,255,255,0.14); color: var(--fg); border-color: var(--accent-line); }
#transit-body button.opt-btn.danger { background: rgba(255,107,107,0.16); border-color: rgba(255,107,107,0.4); color: #ffb3b3; }
#transit-body button.opt-btn[disabled] { opacity: .45; cursor: not-allowed; }

/* 示例数据（生成示例线路与车辆）按钮：一眼看出是测试数据，不和普通操作混在一起 */
#transit-body .tp-demo { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--line-3); }
#transit-body .tp-demo-note { color: var(--fg-mute); font-size: 10.5px; line-height: 1.55; }

/* ---------------- 车辆管理器（面板「车辆」分区的详情；独立窗口已删） ---------------- */
.veh-mgr { gap: 3px; }
.veh-mgr-title { display: flex; align-items: baseline; gap: 6px; color: #fff; font-size: 12.5px; font-weight: 700; }
.veh-mgr-title small { color: var(--fg-mute); font-family: var(--mono); font-size: 10px; font-weight: 400; }
.veh-mgr .tp-row { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; line-height: 1.5; }
.veh-mgr .tp-row > span { flex: 0 0 74px; color: var(--fg-mute); font-size: 11px; }
.veh-mgr .tp-row > b { flex: 1 1 auto; min-width: 0; color: var(--fg); word-break: break-word; }
.veh-mgr .tp-row > b small { color: var(--fg-mute); font-family: var(--mono); font-size: 10px; }
/* #车厂：车辆管理器里那一行「在车厂 · 下一班 08:15 · 未运营」—— 不在运营的车不在地图上，这里要说清 */
.veh-mgr .tp-row.depot-row > b { color: #ffd166; font-weight: 700; }
.veh-mgr-sub { margin-top: 5px; padding-top: 4px; border-top: 1px solid var(--line-3); color: #fff; font-size: 11.5px; font-weight: 700; }
.veh-mgr-sub small { color: var(--fg-mute); font-size: 10px; font-weight: 400; }
.veh-scroll { overflow-x: auto; }
.veh-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.veh-table th { text-align: left; font-weight: 600; color: var(--fg-mute); padding: 3px 5px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.veh-table td { padding: 3px 5px; border-bottom: 1px dashed var(--line-3); color: var(--fg-dim); white-space: nowrap; }
.veh-table tr:last-child td { border-bottom: none; }
.veh-table td.num { text-align: right; font-family: var(--mono); }
.veh-table td.name { color: var(--fg); white-space: normal; }
.veh-table tr.now td { background: var(--accent-soft); }
.veh-table tr.now td.name { font-weight: 700; color: #fff; }
.veh-table tr.served td { opacity: .62; }
.veh-state { font-size: 10.5px; padding: 1px 5px; border-radius: 999px; border: 1px solid var(--line); color: var(--fg-dim); }
.veh-state.served { color: #6ee7a8; border-color: rgba(110,231,168,0.45); }
.veh-state.now { color: #ffd166; border-color: rgba(255,209,102,0.5); }
.veh-state.next { color: var(--accent); border-color: var(--accent-line); font-weight: 700; }
.veh-state.todo { color: var(--fg-mute); }
.veh-pax { display: flex; flex-direction: column; gap: 3px; }
.veh-pax-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,0.03); font-size: 11.5px; }
.veh-pax-row .veh-pax-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; color: var(--fg); }
.veh-pax-row .veh-pax-n { font-family: var(--mono); font-weight: 700; }
.veh-pax-row .veh-pax-tr { color: var(--fg-mute); font-size: 10.5px; }
.veh-pax-bar { height: 3px; border-radius: 2px; background: var(--accent, #6ee7a8); opacity: .7; }
.veh-mgr-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--line-3); }
.veh-mgr-actions .mini { font-size: 11px; padding: 3px 8px; border-radius: 7px; border: 1px solid var(--line); background: rgba(255,255,255,0.07); color: var(--fg-dim); cursor: pointer; }
.veh-mgr-actions .mini:hover { background: rgba(255,255,255,0.14); color: var(--fg); border-color: var(--accent-line); }
.veh-mgr-actions .mini.danger { background: rgba(255,107,107,0.16); border-color: rgba(255,107,107,0.4); color: #ffb3b3; }
.veh-mgr-actions .mini[disabled] { opacity: .45; cursor: not-allowed; }
/* 分区那一排（#transit-tabs）里只有分区本身：原来的「管理器窗口」启动器那一排已经删掉
   （面板本身就是管理器，每个分区就是那个管理器的一份紧凑视图）。 */

/* 独立管理器窗口（.tmgr-win / #linemgr.lm-win）与地图气泡里的「🧰 管理器」按钮已经**整套删掉**：
   管理器只活在交通面板的分区里（面板本身就是管理器），地图上的一次点击只弹那个小气泡。
   这里一条 .tmgr-* 也不留 —— 免得哪天又有人照着老样式把窗口拼回来。 */
`;

  function injectTransitStyle() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.head.querySelector('style[data-transit-style]')) return;
    const st = document.createElement('style');
    st.setAttribute('data-transit-style', '1');
    st.textContent = TRANSIT_STYLE;
    document.head.appendChild(st);
  }

  /** 车站类型 → 城市尺度下的最低显示级别（只有高铁站/城际站在大范围可见） */
  const STATION_MIN_ZOOM = { hsr: 9, intercity: 11, rail: 13, subway: 14, light_rail: 14, tram: 15, bus: 15 };
  /** 车辆类型 → 最低显示级别 */
  const VEHICLE_MIN_ZOOM = { cr400: 10, crh6: 11, freight: 12, locomotive: 12, metro_b4: 13, metro_b6: 13, metro_a8: 13, tram: 14, bus: 15, bus_double: 15, bus_artic: 15, trolley: 15, minibus: 16 };

  const Transit = {
    data: null,
    ready: null,
    config: null,
    panelTab: 'company',
    panelOpen: false,
    stationMode: 'rail',      // 设站模式（7 种，id 即服务端 kind）：共享状态，editor.js 的 Editor.STATION_MODES 读写的就是它
    addingStopsTo: null,      // 正在往哪条线路里加站
    activeCompanyId: null,    // 当前正在经营的公司
    bigPanel: false,          // 面板是否放大成大窗口
    filters: { company: 'mine', kind: 'all', line: 'all', status: 'all', source: 'all', search: '', sort: 'default', dir: 'desc' },
    limits: { companies: LIST_LIMIT, stations: LIST_LIMIT, lines: LIST_LIMIT, vehicles: LIST_LIMIT },
    selected: null,           // 右侧详情看的是谁：{ type: 'station'|'line'|'vehicle', id }
    selectedStation: null,    // 选中的车站（地图高亮 / 站点管理器都指向它）
    selectedLine: null,       // 选中的线路（列表高亮用）
    selectedVehicle: null,    // 选中的车辆（列表高亮用）
    compareOn: false,         // 线路分区：是否展开"线路对比"表
    population: { on: false, cells: [], bbox: null, loading: false, totals: null, legend: true },
    hoverStation: null,
    stationKindsTable: null,  // 服务端下发的站点类型表（kinds 操作）
    vehicleKindsTable: null,  // 服务端下发的车型表（kinds 操作）
    _stationPopup: null,      // 当前打开的车站气泡 { stationId, popup }
    _vehiclePopup: null,      // 当前打开的车辆详情气泡 { trainId, popup, builtAt }（点地图上的车 / 点车辆列表都到这儿）
    stationLod: null,         // 车站 / 车辆分级阈值（见 STATION_LOD_DEFAULT；init 填满，随时可改）
    _lodStorage: null,        // 本地记住的阈值（localStorage 只读一次）
    _lod: null,               // 合并后的有效阈值缓存（改阈值时置空）
    _farHidden: false,        // 上一帧是否因为"视野太宽"整块隐藏了车站/等车/气泡（面板提示用）
    showVehicleBubbles: true, // 图层开关：地图上画不画车辆信息气泡（面板 / 图层面板都能改，默认开）
    onData: null,             // 数据更新回调（window.G.LineMgr 订阅它做实时刷新）
    _dataHooks: [],           // 额外的订阅者（onDataSubscribe）
    _waitTrack: null,         // Map<stationId, { v, prev, at, delta }>：等车人数趋势采样
    _stMgrLive: false,        // 面板里当前是否挂着站点管理器（挂了才需要逐帧刷新它）
    _stMgrAt: 0,              // 上一次刷新站点管理器内容的时刻
    _mgrHover: false,         // 鼠标停在详情里（别重建，免得点击丢）
    _mgrHoverAt: 0,
    _mgrDirty: false,
    _listHover: false,        // 鼠标停在左侧列表里
    _listDirty: false,
    _popupSyncAt: 0,          // 上一次同步车站气泡的时刻（模拟帧很密，限一下频率）
    _liveSnapAt: 0,           // 上一次拉实时快照（含 stations[].waiting）的时刻
    _liveSnapBusy: false,     // 上一次拉取还没回来（别并发）
    _demoBusy: false,         // 示例数据正在生成 / 清除（防重复点击）
    _demoUndoLabel: null,     // 上一次示例数据分组服务端给的撤销标签（ack 的 group.undoLabel）
    /**
     * 上一帧画过的、可以点的"图形矩形"（canvas 上没有 DOM，只能记下来给 hitTest 反查）。
     * 坐标是**相对实体锚点**的偏移（dx/dy），因为画布坐标比容器坐标多一圈 OVERLAY_PAD，
     * 存偏移就与那圈 padding 无关了：命中时用实体的实时容器坐标 + 偏移还原矩形。
     *   _trainRects   [{ id, lat, lon, dx, dy, w, h, label }]  车辆信息泡泡
     *   _stationRects [{ id, lat, lon, dx, dy, w, h, label }]  站名 / 等车人数徽标
     */
    _trainRects: [],
    _stationRects: [],
    _lockSyncAt: 0,           // 上一次同步"锁相关的界面"（线路只读层）的时刻（模拟帧很密，限一下频率）

    init(meta) {
      // /api/meta 或 welcome 里的 config 都能用，两边任一先到就先配上
      const cfg = meta && meta.config && meta.config.transit
        ? meta.config.transit
        : (meta && meta.transit ? meta.transit : null);
      if (cfg) Transit.config = cfg;
      // 分级阈值：默认值 → 本机记住的 → 服务端下发的，三层叠起来（任何一层都没写就用默认）。
      // 存档先过严格校验：脏值（-1 / "abc" / NaN / 9 / "标准" / [1,2] / null）在**读进来的时候**就被丢掉，
      // 后面无论怎么用（渲染阈值、视野尺度、面板提示）都不会碰到非法数，也绝不会因此抛异常。
      Transit._lodStorage = sanitizeStationLod(util.storage.get(STATION_LOD_KEY, null));
      Transit._lod = null;
      Transit.stationLod = Transit.stationLodEffective();
      injectTransitStyle();
      Transit._bindLockEvents();   // 元素锁：别人解锁的广播 + 关页面前解锁（幂等）
      return Transit;
    },

    /* ------------------------------ 数据 ------------------------------ */
    setReady(ready) { Transit.ready = ready; },

    /**
     * 数据更新订阅：每次 setSnapshot / applySim 之后都会叫一次。
     * 线路管理器（window.G.LineMgr）用它做实时刷新；传函数返回退订函数。
     */
    onDataSubscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      Transit._dataHooks = Transit._dataHooks || [];
      Transit._dataHooks.push(fn);
      return () => {
        const i = Transit._dataHooks.indexOf(fn);
        if (i >= 0) Transit._dataHooks.splice(i, 1);
      };
    },

    /** 广播一次"数据变了"：onData（老接口，单个回调）+ onDataSubscribe 订阅者 */
    emitData(reason) {
      const hooks = [];
      if (typeof Transit.onData === 'function') hooks.push(Transit.onData);
      if (Array.isArray(Transit._dataHooks)) hooks.push(...Transit._dataHooks);
      for (const fn of hooks) {
        try { fn(reason); } catch { /* 单个订阅者出错不影响渲染 */ }
      }
    },

    /** 数据换了：把各种索引缓存作废（列表要按几百个车站/线路排序，不能每次都重算） */
    _bumpData() {
      Transit._dataTick = (Transit._dataTick || 0) + 1;
      Transit._idx = null;
    },

    setSnapshot(data, full) {
      if (!data) return;
      // #车厂：整份快照的 trains[] 是"完整名单"（连在车厂的车也在里面，带 inService:false），
      // 这里**在入口处**就把不在运营的车摘掉 —— data.trains 从此只装"在运营的车"，
      // 地图、气泡、命中测试读的都是这一份，于是"不在运营的公交车停在地图上"这件事不可能发生。
      if (Array.isArray(data.trains)) data.trains = Transit.trainsInService(data.trains);
      Transit.data = data;
      Transit._bumpData();
      if (data.clock) Transit.renderClock();
      if (full && Transit.panelOpen) {
        // 玩家正在表单里打字时别整块重建（会把光标和输入冲掉），只刷新不带动输入的列表
        if (Transit.panelTyping()) Transit.renderListOnly();
        else Transit.renderPanel();
      }
      if (Transit._stationPopup) Transit.syncStationPopup();
      if (Transit._vehiclePopup) Transit.refreshVehiclePopup();
      if (Transit._stMgrLive) Transit.refreshStationMgr();   // 站点管理器（面板「车站」分区详情）
      Transit.refreshVehicleMgr();          // 车辆管理器（面板右侧那块）跟着快照走
      Transit.syncLockSurfaces();
      if (Render.overlay) Render.overlay.redraw();
      Transit.emitData('snapshot');
    },

    /**
     * #车厂：一份 trains 名单里**只留下在运营的车**。
     * 服务端的广播帧本来就只发在运营的车（不在运营的车根本不进帧），所以这里的过滤是给
     * 整份快照（welcome / transitSync / GET /api/transit）兜底的：那里面在车厂的车也在，
     * 但每一条都带 `inService:false`。快路径：名单里没有 inService:false 时**原样返回同一个数组**
     * （不新建、不复制 —— 每帧 4 次广播不该为这件事多分配几次）。
     */
    trainsInService(list) {
      const arr = Array.isArray(list) ? list : [];
      let need = false;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].inService === false) { need = true; break; }
      }
      return need ? arr.filter((t) => !t || t.inService !== false) : arr;
    },

    applySim(msg) {
      if (!Transit.data) Transit.data = { trains: [], companies: [], stations: [], lines: [], vehicles: [] };
      if (msg.clock) Transit.data.clock = msg.clock;
      if (msg.trains) {
        // #车厂：只画在运营的车（服务端帧里没有在车厂的车；这里再兜一次底，见 trainsInService）
        Transit.data.trains = Transit.trainsInService(msg.trains);
        // 收到过"真的带车队"的帧之后，"我自己的车却不在帧里"才等于"它在车厂"（见 vehicleDepotInfo）
        Transit._trainFrames = (Transit._trainFrames || 0) + 1;
        Transit._bumpData();
      }
      if (msg.companies) { Transit.data.companies = msg.companies; Transit._bumpData(); }
      // 服务端哪天在 sim 帧里也带上车站（含 stations[].waiting）就最好了：直接用，
      // 等车徽标下一帧画出来就是新数字，连下面那次补拉都省了。今天 sim 帧不带，所以走 ensureLiveWaiting。
      if (msg.stations) { Transit.data.stations = msg.stations; Transit._bumpData(); }
      Transit.renderClock();
      // 模拟帧 250ms 一次：只在详情里就地更新几个数字，不重建整个面板
      if (Transit.panelOpen) {
        const now = Date.now();
        if (now - (Transit._liveAt || 0) >= 500) {
          Transit._liveAt = now;
          Transit.renderDetailLive();
        }
      }
      if (Transit._stationPopup || Transit._vehiclePopup || Transit._stMgrLive) {
        const now = Date.now();
        if (now - (Transit._popupSyncAt || 0) >= 400) {
          Transit._popupSyncAt = now;
          if (Transit._stationPopup) Transit.syncStationPopup();
          if (Transit._vehiclePopup) Transit.refreshVehiclePopup();
          if (Transit._stMgrLive) Transit.refreshStationMgr();
        }
      }
      // 车辆管理器：模拟帧很密，内部自己限流（默认 400ms 一次）
      Transit.refreshVehicleMgr();
      Transit.syncLockSurfaces();           // 线路被别人锁着时那层只读（独立窗口已删，只剩面板这一份）
      if (Render.overlay) Render.overlay.redraw();
      Transit.emitData('sim');
      // 候车人数（车站等车徽标 / 气泡 / 站点管理器）不在 sim 帧里：按需低频补一次实时快照
      Transit.ensureLiveStation();   // 有车站被选中/开着气泡时：整份刷新（4 秒一次）
      Transit.ensureLiveWaiting();   // 地图上画得出等车徽标时：2 秒一次，徽标因此每帧都是新的数
    },

    /**
     * 候车人数只有服务端整份快照里才有（sim 帧不带车站），
     * 所以只要有车站被选中就低频拉一次 /api/transit，让等车人数/趋势是活的。
     * force = true 时把间隔压到 1 秒：站点管理器正要看「分线路候车 · 每条线的去向」而手上那份快照里
     * **没有**这份明细（服务端只在真有人在等时才下发 waitingByDest / waitingByLine[].destMix）——
     * 这时不该让玩家等到下一个 4 秒周期，也别让面板一直挂着「候车去向正在刷新…」。
     */
    ensureLiveStation(force) {
      return Transit._ensureLiveSnapshot(() => Transit.selectedStation != null || !!Transit._stationPopup,
        force ? 1000 : STATION_LIVE_MS);
    },

    /**
     * 地图等车徽标的数据源：车站/车辆的气泡与徽标都是**每帧重画**的（Transit.draw 读 Transit.data），
     * 但服务端 sim 帧只带车辆与公司，`stations[].waiting` 只在整份快照里 —— 这就是"徽标不动"的原因。
     * 这里在画得出徽标的时候（分级阈值内、视野没超限）按 WAIT_LIVE_MS 拉一次整份快照，
     * 于是每帧重画的徽标拿到的一直是新数字（人多了变红、人少了变绿，箭头也跟着动）。
     */
    ensureLiveWaiting() {
      return Transit._ensureLiveSnapshot(() => Transit.waitingBadgeVisible(), WAIT_LIVE_MS);
    },

    /** 拉一次实时快照的两个入口共用同一套节流/合并逻辑（need() 说"现在要不要"，minGapMs 说"多久一次"） */
    _ensureLiveSnapshot(need, minGapMs) {
      if (Transit._liveSnapBusy || !Net || !Net.token) return false;
      if (typeof document !== 'undefined' && document.hidden) return false;   // 标签页在后台：不画也不拉
      if (typeof need === 'function' && !need()) return false;
      const now = Date.now();
      if (now - (Transit._liveSnapAt || 0) < Math.max(500, Number(minGapMs) || 0)) return false;
      Transit._liveSnapAt = now;
      Transit._liveSnapBusy = true;
      fetch('/api/transit?token=' + encodeURIComponent(Net.token))
        .then((r) => r.json())
        .then((body) => {
          if (!body || !body.data) return;
          // 整份快照会替换 Transit.data，先把"我的公司"记下来，别丢了
          const prevId = Transit.data ? Transit.data.myCompanyId : null;
          const company = body.company && body.company.id ? body.company : null;
          Transit.setSnapshot(body.data, false);
          if (company) {
            Transit.data.myCompanyId = company.id;
            if (!(Transit.data.companies || []).some((x) => x.id === company.id)) {
              Transit.data.companies = (Transit.data.companies || []).concat([company]);
            }
          } else if (prevId != null) {
            Transit.data.myCompanyId = prevId;
          }
          // 车站列表里的「等车 N ↑」也跟着这份实时数据走（鼠标压着列表时先不换行，免得点空）
          if (Transit.panelOpen && !Transit._listHover && Transit.section() === 'stations') Transit.renderListOnly();
        })
        .catch(() => { /* 拉不到就等下一轮，界面继续用上一份数据 */ })
        .then(() => { Transit._liveSnapBusy = false; });
      return true;
    },

    /* ------------------------------ 公司（每人可有多家） ------------------------------ */
    /**
     * 我名下的公司。
     *
     * **登录之前 Transit.data 是 null**（第一份快照靠 welcome / sim 帧才到），
     * 所以这里（以及任何可能被启动流程调到的"读数据"接口）绝不允许直接
     * `Transit.data.xxx` —— 读模式的存档时（显示模式 = 轨交/公交）启动流程会
     * 顺着 myLines → companyId → company → myCompanies 走到这里，
     * 一旦抛异常，main.js 的"地图初始化"整段就被中断（整张地图空白）。
     */
    myCompanies() {
      const me = Transit.myId();
      const d = Transit.data;
      const mine = (d && d.companies) || [];
      const myCompanyId = d ? d.myCompanyId : null;
      if (!me && !myCompanyId) return [];
      return mine.filter((c) => (me && c.owner === me) || (myCompanyId && c.id === myCompanyId));
    },

    /** 客户端自愈：万一会话里没带上"我的公司"，直接问服务端要一次（服务端按当前用户算） */
    ensureMyCompany() {
      if (Transit._companyFetch) return;
      if (Transit.myCompanies().length || !Net.token) return;
      Transit._companyFetch = true;
      fetch('/api/transit?token=' + encodeURIComponent(Net.token))
        .then((r) => r.json())
        .then((body) => {
          const c = body && body.company;
          if (!c || !c.id) return;
          Transit.data = Transit.data || { trains: [], companies: [], stations: [], lines: [], vehicles: [] };
          Transit.data.myCompanyId = c.id;
          if (!(Transit.data.companies || []).some((x) => x.id === c.id)) {
            Transit.data.companies = (Transit.data.companies || []).concat([c]);
          }
          if (Transit.panelOpen) Transit.renderPanelSoon();
          if (Render.overlay) Render.overlay.redraw();
        })
        .catch(() => { /* 忽略：下一次渲染还会再试 */ })
        .then(() => { Transit._companyFetch = false; });
    },

    myId() {
      return Editor.myId || (window.G.UI && window.G.UI.myId);
    },

    /** 当前经营的公司：优先用界面上选中的，否则用服务端标记为 active 的那家 */
    company() {
      const list = Transit.myCompanies();
      if (!list.length) return null;
      if (Transit.activeCompanyId) {
        const hit = list.find((c) => c.id === Transit.activeCompanyId);
        if (hit) return hit;
      }
      const active = list.find((c) => c.active);
      const pick = active || list[0];
      Transit.activeCompanyId = pick.id;
      return pick;
    },

    companyId() {
      const c = Transit.company();
      return c ? c.id : null;
    },

    setCompany(id) {
      Transit.activeCompanyId = Number(id);
      Transit.filters.line = 'all';
      Transit.op({ k: 'company.select', id: Number(id) })
        .then(() => { util.toast('已切换公司', 'success', 1800); Transit.renderPanelSoon(); })
        .catch((err) => { util.toast(err.message, 'error'); Transit.renderPanelSoon(); });
    },

    createCompany() {
      const name = (window.prompt('新公司名称（留空自动命名）', '') || '').trim();
      Transit.op({ k: 'company.create', name })
        .then((res) => {
          const c = res.result && res.result.company;
          if (c) Transit.activeCompanyId = c.id;
          util.toast(c ? `已成立「${c.name}」并配好起步车队` : '公司已成立', 'success', 3000);
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    deleteCompany(c) {
      if (!c) return;
      // 协作编辑：谁的公司都能删（服务端也这么放；系统公司由服务端挡）
      if (Transit.lockRefuse('company', c.id)) return;
      if (!window.confirm(`删除公司「${c.name}」？该公司的车站、线路、车辆会一并删除（可以撤销）。`)) return;
      Transit.op({ k: 'company.delete', id: c.id })
        .then(() => { Transit.activeCompanyId = null; util.toast('公司已删除', 'success'); Transit.renderPanelSoon(); })
        .catch((err) => util.toast(err.message, 'error'));
    },

    myStations() {
      const cid = Transit.companyId();
      return ((Transit.data && Transit.data.stations) || []).filter((s) => (cid ? s.companyId === cid : s.owner === Transit.myId()));
    },

    myLines() {
      const cid = Transit.companyId();
      return ((Transit.data && Transit.data.lines) || []).filter((l) => (cid ? l.companyId === cid : l.owner === Transit.myId()));
    },

    myVehicles() {
      const cid = Transit.companyId();
      return ((Transit.data && Transit.data.vehicles) || []).filter((v) => (cid ? v.companyId === cid : v.owner === Transit.myId()));
    },

    stationById(id) {
      return (Transit.data && Transit.data.stations || []).find((s) => s.id === Number(id)) || null;
    },

    money(n) { return util.fmt(Math.round(n || 0)) + ' 元'; },
    moneyShort(n) {
      const v = Math.round(n || 0);
      if (Math.abs(v) >= 100000000) return (v / 100000000).toFixed(2) + ' 亿';
      if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + ' 万';
      return String(v);
    },

    /* ------------------------------ 元素锁（协作编辑：谁在改谁上锁） ------------------------------ */

    /** 锁的表懒建：key = "station:12"，value = { elemType, id, state: 'pending' | 'held' | 'denied', by } */
    _lockMap() {
      return Transit._elemLocks || (Transit._elemLocks = new Map());
    },

    lockKey(elemType, id) { return String(elemType) + ':' + Number(id); },

    /** 服务端广播的锁表（t:'locks' → main.js 的 UI.locks）里，这个元素被谁占着？（自己占着 / 没人占 → null） */
    _lockOwnerIn(table, elemType, id) {
      const info = table && table[Transit.lockKey(elemType, id)];
      if (!info || info.userId == null) return null;
      const me = Transit.myId();
      if (me != null && String(info.userId) === String(me)) return null;
      return info.name || '别的玩家';
    },

    /**
     * 这个元素现在**被别人**锁着吗？是就返回对方名字（没人锁 / 自己锁着 → null）。
     * 两个来源：
     *   · 本机自己的 lock.set 结果（state='denied'，最快、最准 —— 服务端当场回的）；
     *   · 服务端广播的锁表（别人在我打开编辑器之后才占上锁时，靠它兜底）。
     */
    elemLockBy(elemType, id) {
      const num = Number(id);
      if (elemType == null || !Number.isFinite(num)) return null;
      const rec = Transit._elemLocks && Transit._elemLocks.get(Transit.lockKey(elemType, num));
      if (rec && rec.state === 'denied' && rec.by) return rec.by;
      const ui = window.G && window.G.UI;
      return Transit._lockOwnerIn(ui && ui.locks, elemType, num);
    },

    /** 这个元素是我锁着的吗（自己锁着 → 放心改） */
    holdsElemLock(elemType, id) {
      const rec = Transit._elemLocks && Transit._elemLocks.get(Transit.lockKey(elemType, id));
      return !!(rec && rec.state === 'held');
    },

    /**
     * 别人锁着时那句中文原因（没人锁 / 自己锁着 → null）。
     * 这句话**只有一份**（本文件顶部的 lockBusyText，与服务端 checkElementLock 一字不差）：
     * linemgr.js 画「🗑 删除线路」这类按钮的禁用 title 时也读它，别在那边另编一套说法。
     */
    lockBusyText(by) {
      return by ? lockBusyText(by) : null;
    },

    /**
     * 被别人锁着就弹一句（服务端口径的中文原因）并返回 true —— 改 / 删交通资产前的统一拦截。
     * 没人锁 / 自己锁着 → false（放行；服务端仍然是最后一道，真被拒了它的中文原因会照常弹出来）。
     */
    lockRefuse(elemType, id) {
      const by = Transit.elemLockBy(elemType, id);
      if (!by) return false;
      util.toast(lockBusyText(by), 'warn', 5000);
      return true;
    },

    /**
     * transit op `lock.set` 的客户端包装（elemType: station / line / vehicle / company）。
     *
     * 服务端**不报错**：别人占着锁时它回 `{ locked:true, by }` —— 那就弹服务端那句中文原因，
     * 并把开着的编辑器按"只读"重画一遍；正常上锁回 `{ locked:false }`。
     * 请求本身失败（断线 / 限流）不算"被别人锁着"：编辑器照旧可写，真被占着时下一次改动会被服务端拒掉。
     */
    setElemLock(elemType, id, on) {
      const num = Number(id);
      if (!LOCK_ELEM_LABEL[elemType] || !Number.isFinite(num)) return Promise.resolve(null);
      const map = Transit._lockMap();
      const key = Transit.lockKey(elemType, num);
      if (on === false) {
        const rec = map.get(key);
        map.delete(key);
        if (!rec || rec.state !== 'held') return Promise.resolve(null);   // 没锁上过就别白发一条解锁
        return Transit.op({ k: 'lock.set', elemType, id: num, on: false }).catch(() => null);
      }
      const cur = map.get(key);
      if (cur && (cur.state === 'held' || cur.state === 'pending')) return Promise.resolve(cur);
      const rec = { elemType, id: num, state: 'pending', by: null };
      map.set(key, rec);
      return Transit.op({ k: 'lock.set', elemType, id: num, on: true })
        .then((res) => {
          const r = (res && res.result) || {};
          if (r.locked) {
            rec.state = 'denied';
            rec.by = r.by || '别的玩家';
            rec.at = Date.now();                             // 重试计时（见 applyLockWantsNow）
            util.toast(lockBusyText(rec.by), 'warn', 5000);   // 服务端口径的中文原因
            Transit.refreshLockSurfaces(elemType, num);
            return rec;
          }
          rec.state = 'held';
          rec.by = null;
          return rec;
        })
        .catch(() => {
          // 上锁请求没成功（断线 / 超时）：当作"没锁上"，不把编辑器冻住
          map.delete(key);
          return null;
        });
    },

    /**
     * 哪个界面正开着哪个元素的编辑器：surface → { elemType, id }。
     * 独立窗口删掉之后 surface 只剩**一个**：'panel'（交通面板右侧详情 —— 站点管理器 / 车辆管理器 / 线路详情）。
     * id 传 null = 这个界面现在没开编辑器（顺手把锁解掉）。
     */
    setLockWant(surface, elemType, id) {
      const wants = Transit._lockWants || (Transit._lockWants = new Map());
      const num = Number(id);
      const prev = wants.get(surface);
      // 车站不再有"公共站只读"这回事（谁都能改名 / 挪动 / 删除任何车站，底图导入的站也一样）：
      // 导入站和自建站一样要上锁，否则两个人同时改同一个站谁也拦不住。
      const valid = !(elemType == null || id == null || !Number.isFinite(num));
      if (!valid) {
        if (!prev) return;               // 这个界面本来就没开编辑器：什么都不用做
        wants.delete(surface);
      } else {
        // 同一个元素重复登记（面板每次重画都会调到这里）直接返回：别反复重排那把 120ms 的合并定时器
        if (prev && prev.elemType === elemType && prev.id === num) return;
        wants.set(surface, { elemType, id: num });
      }
      Transit.applyLockWants();
    },

    clearLockWant(surface) { Transit.setLockWant(surface, null, null); },

    /**
     * 把所有界面想要的锁对一遍（**轻微合并**：连着点列表 A→B→C 时只在最后停下来的那个元素上真的上锁，
     * 免得每次点击都发一对 lock.set —— 服务端 10 秒 60 条限流会给一串"操作太快了"）。
     */
    applyLockWants() {
      if (Transit._lockTimer) clearTimeout(Transit._lockTimer);
      Transit._lockTimer = setTimeout(() => {
        Transit._lockTimer = null;
        Transit.applyLockWantsNow();
      }, 120);
    },

    /** 立刻对一遍（定时器里调的就是它；测试 / 需要同步生效时也可以直接调） */
    applyLockWantsNow() {
      const wants = Transit._lockWants;
      if (!wants) return;
      const need = new Map();
      for (const w of wants.values()) need.set(Transit.lockKey(w.elemType, w.id), w);
      const map = Transit._lockMap();
      const now = Date.now();
      for (const [key, rec] of [...map]) {
        if (need.has(key)) {
          // 被别人占着的那把：过一阵子再试一次（对方收工 / 断线 / 120 秒 TTL 过期都不会有广播，
          // 不重试的话这个编辑器会一直卡在只读上）
          if (rec.state === 'denied' && now - (rec.at || 0) > LOCK_RETRY_MS) map.delete(key);
          continue;
        }
        if (rec.state === 'held') Transit.setElemLock(rec.elemType, rec.id, false);   // 编辑器关了 → 解锁
        else map.delete(key);                                                         // pending / denied → 丢掉记录
      }
      for (const [key, w] of need) if (!map.has(key)) Transit.setElemLock(w.elemType, w.id, true);
    },

    /** 关页面 / 断线前把手里的锁全放掉（服务端断线也会清，这里是最后一层保险） */
    releaseAllElemLocks() {
      const map = Transit._elemLocks;
      if (Transit._lockWants) Transit._lockWants.clear();
      if (!map) return;
      for (const rec of [...map.values()]) if (rec.state === 'held') Transit.setElemLock(rec.elemType, rec.id, false);
      map.clear();
    },

    /**
     * 服务端广播了新的锁表（t:'locks'）：之前被别人锁着、现在锁没了 → 把"只读"收回来，
     * 编辑器还开着的话顺手再申请一次（我这边一直没能上锁）。
     */
    _onLocksBroadcast(table) {
      const map = Transit._elemLocks;
      if (!map) return;
      let changed = false;
      for (const [key, rec] of [...map]) {
        if (rec.state !== 'denied') continue;
        if (Transit._lockOwnerIn(table, rec.elemType, rec.id)) continue;   // 还占着（换个人占也算占着）
        map.delete(key);
        changed = true;
      }
      if (!changed) return;
      // main.js 的 UI.locks 是在**它自己**那个监听器里更新的（本文件比它先注册），所以等一拍再看锁表，
      // 否则会把"刚被别人释放的锁"当成还占着，界面会多只读一会儿。
      setTimeout(() => {
        Transit.applyLockWantsNow();
        Transit.refreshLockSurfaces();
      }, 0);
    },

    /**
     * 锁的状态变了：把开着的编辑器按新的"可写 / 只读"重画一遍。
     * 独立窗口已经整套删掉，所以这里只有**交通面板**那一份：车站表单 / 车辆管理器 / 线路详情里的 linemgr 块。
     */
    refreshLockSurfaces(elemType, id) {
      try {
        if (!elemType || elemType === 'station') {
          if (Transit.panelOpen && Transit.section() === 'stations') Transit.renderPanelSoon();
          if (Transit._stationPopup) Transit.syncStationPopup();
        }
        if (!elemType || elemType === 'vehicle') {
          if (Transit.panelOpen && Transit.section() === 'vehicles') Transit.renderPanelSoon();
        }
        if (!elemType || elemType === 'line') {
          if (Transit.panelOpen && Transit.section() === 'lines') Transit.renderPanelSoon();
          Transit.reinforceLineReadOnly();
        }
      } catch { /* 刷新失败不影响锁本身 */ }
    },

    /** 从 linemgr 画出来的详情头里读回"现在显示的是哪条线"（`.lm-tags` 里的 #id；读不到返回 null） */
    _lineIdOfDetail(host) {
      const tag = host && host.querySelector ? host.querySelector('.lm-tags .tp-tag') : null;
      const m = tag ? /#(\d+)/.exec(String(tag.textContent || '')) : null;
      return m ? Number(m[1]) : null;
    },

    /**
     * 线路那一块的"只读"补丁：linemgr.js 的详情由它自己渲染，被别人锁着时由这里补上
     * 一条中文横幅 + 把里面能改的控件冻上（只作用于**面板里嵌的那一份** `.tp-embed`）。
     * 注意：linemgr 自己的 canEdit 只看元素锁（谁建的线路都能改），所以正常情况下它画的按钮都能点，
     * 这里只是把"剩下还点得动的东西"也一并冻住，免得玩家点了才发现要被服务端拒。
     * 锁没了以后要把手写上去的 disabled 清掉，只能让 linemgr **整块重画**一次。
     */
    reinforceLineReadOnly() {
      const panelHost = util.$('#transit-body .tp-detail .tp-embed');
      if (panelHost) Transit.freezeLockedHost(panelHost, 'line', Transit._lineIdOfDetail(panelHost));
    },

    /**
     * 模拟帧里（节流 400ms）维护"锁"这一层的界面：面板里嵌着的那份线路详情被别人锁着时补只读层。
     * 原来这里还负责刷新五个独立管理器窗口 —— 窗口整套删掉之后只剩这一件事。
     */
    syncLockSurfaces(force) {
      const now = Date.now();
      if (!force && now - (Transit._lockSyncAt || 0) < 400) return false;
      Transit._lockSyncAt = now;
      Transit.reinforceLineReadOnly();
      return true;
    },

    /**
     * 把某个容器冻成只读（被别人锁着时用）：里面的控件 disabled + 顶部挂一条中文横幅。
     * 没人锁着（或锁在我自己手里）时把横幅摘掉（控件由各编辑器的重画自己恢复）。
     */
    freezeLockedHost(host, elemType, id) {
      if (!host || typeof host.querySelectorAll !== 'function') return false;
      const num = Number(id);
      if (!Number.isFinite(num)) return false;      // 不知道是哪个元素：什么都不动（别把只读横幅误摘了）
      const note = host.querySelector(':scope > .tp-lock-note');
      const by = Transit.elemLockBy(elemType, num);
      if (!by) {
        if (note) note.remove();
        return false;
      }
      for (const el of host.querySelectorAll('input, select, textarea, button')) {
        if (el.disabled !== true) el.disabled = true;
        el.title = lockBusyText(by);
      }
      if (!note) {
        const box = util.el('div', 'tp-note warn tp-lock-note',
          `🔒 ${util.esc(lockBusyText(by))}（这个编辑器现在是只读的）`);
        host.insertBefore(box, host.firstChild);
      }
      return true;
    },

    /** 注册一次锁相关的事件：别人解锁的广播 + 关页面前把手里的锁放掉（幂等） */
    _bindLockEvents() {
      if (Transit._lockBound) return;
      Transit._lockBound = true;
      if (Net && typeof Net.on === 'function') {
        Net.on('locks', (msg) => Transit._onLocksBroadcast((msg && msg.locks) || {}));
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        // 关窗 / 刷新：尽力发一条解锁（服务端在连接关闭时也会清掉这个玩家的锁，所以这只是快一点）
        const bye = () => Transit.releaseAllElemLocks();
        window.addEventListener('pagehide', bye);
        window.addEventListener('beforeunload', bye);
      }
    },

    /* ------------------------------ 操作 ------------------------------ */
    op(opObject) {
      return new Promise((resolve, reject) => {
        const id = 't' + Math.random().toString(36).slice(2, 9);
        Transit._pending = Transit._pending || new Map();
        Transit._pending.set(id, { resolve, reject, op: opObject });
        if (!Net.send({ t: 'transit', id, op: opObject })) {
          Transit._pending.delete(id);
          reject(new Error('尚未连接到服务器'));
          return;
        }
        setTimeout(() => {
          if (Transit._pending && Transit._pending.has(id)) {
            Transit._pending.delete(id);
            reject(new Error('服务器响应超时'));
          }
        }, 15000);
      });
    },

    onAck(msg) {
      const p = Transit._pending && Transit._pending.get(msg.id);
      const op = p ? p.op : null;
      if (p) {
        Transit._pending.delete(msg.id);
        if (msg.ok) {
          Transit._clearLockedNote(p.op);   // 改成功了 → 之前那句"别人正在编辑"已经过期了
          Transit._noteAck(p.op, msg);
          p.resolve(msg);
        } else {
          const err = new Error(msg.error || '操作失败');
          if (msg.code) err.code = msg.code;
          Transit._noteLockedError(p.op, err);   // 服务端说"XX 正在编辑这个元素" → 把编辑器转成只读
          p.reject(err);
        }
      }
      // 「可撤销 N 步」用服务端 ack 里的 undoDepth（OSM + 交通 + 已收尾的分组 = 真总数）。
      // net.js 只把 OSM 通道的 ack 转给状态栏，交通这条通道得自己转一次，否则数字永远停在旧值上。
      if (typeof msg.undoDepth === 'number' && Net && typeof Net.emit === 'function') Net.emit('depth', msg);
      // 失败提示：**调用方负责**的操作（见 CALLER_TOAST_OPS，例如 clock.set —— setSpeed 与
      // ui.js 的「跳到…」都会弹一条带上下文的提示）这里不再兜底，避免同一个错误弹两条 toast。
      const byCaller = !!op && CALLER_TOAST_OPS[op.k] === 1;
      if (!msg.ok && !byCaller) util.toast(msg.error || '操作失败', 'error', 5000);
    },

    /**
     * 一条改动被服务端拒了，原因是"这个元素正被别人锁着"时（服务端的原因就是锁表那句：
     * `<名字> 正在编辑这个元素，请稍后再试`，见 osmops 的 checkLock）：把这条元素在本机记成 denied，
     * 编辑器立刻转只读 + 弹同一句原因 —— 不用等我下一次 lock.set 才知道（服务端的交通锁不广播锁表）。
     */
    _noteLockedError(op, err) {
      if (!op || !err) return;
      const m = /^(.+?) 正在编辑这个元素/.exec(String(err.message || ''));
      if (!m) return;
      const elemType = String(op.k || '').split('.')[0];
      const id = op.id == null ? NaN : Number(op.id);
      if (!LOCK_ELEM_LABEL[elemType] || !Number.isFinite(id)) return;
      Transit._lockMap().set(Transit.lockKey(elemType, id),
        { elemType, id, state: 'denied', by: m[1], at: Date.now() });
      Transit.refreshLockSurfaces(elemType, id);
    },

    /** 一条改动成功了：把这条元素身上"被别人锁着"的记录清掉（说明服务端那边那把锁早没了） */
    _clearLockedNote(op) {
      if (!op) return;
      const elemType = String(op.k || '').split('.')[0];
      const id = op.id == null ? NaN : Number(op.id);
      const map = Transit._elemLocks;
      if (!map || !LOCK_ELEM_LABEL[elemType] || !Number.isFinite(id)) return;
      const key = Transit.lockKey(elemType, id);
      const rec = map.get(key);
      if (!rec || rec.state !== 'denied') return;
      map.delete(key);
      Transit.applyLockWants();
      Transit.refreshLockSurfaces(elemType, id);
    },

    /**
     * ack 到账后的本地收尾（不往 Editor.actionLog 里记账：那是本地记录，服务端现在是
     * 一条时间线（OSM + 交通 + 分组），本地条数会和真实深度对不上；Ctrl+Z 统一走
     * Net.op({k:'undo'})，由服务端按 seq 决定撤销哪一边 —— transit 的 undoViaBus 已经接好）。
     *
     * 这里只做一件小事：撤销/重做**一整组**时，服务端把组信息放在 result.group
     * （含 display / undoLabel），而 editor.js 的撤销提示读的是 result.undone / result.redone，
     * 所以补上组名 —— 提示就会是「已撤销：生成示例线路与车辆（12 步）」而不是「交通操作」。
     */
    _noteAck(op, msg) {
      const r = msg && msg.result;
      if (!op || !r || typeof r !== 'object') return;
      const g = r.group;
      if (!g || typeof g !== 'object') return;
      const name = g.display || g.label;
      if (!name) return;
      if (op.k === 'undo' && r.undone == null) r.undone = name;
      else if (op.k === 'redo' && r.redone == null) r.redone = name;
    },

    /**
     * 把一批操作包成"一组"：服务端把 OSM 编辑与交通玩法放在同一条时间线上，
     * 一组在撤销里只算**一步**（一次「生成示例线路与车辆」= N 条操作 = 1 步）。
     *
     *   fn 正常结束 → endGroup，返回 endGroup 的 ack（`result.group` 里有 display / steps / undoLabel）；
     *   fn 抛错     → abortGroup 收尾（组里已经做成的操作各自保留一步），错误继续抛给调用方。
     *
     * 服务端没接受 beginGroup（老版本）时不阻塞功能：照常跑，只是这批会分成多步。
     */
    async withUndoGroup(label, fn) {
      let opened = false;
      try {
        await Transit.op({ k: 'beginGroup', label });
        opened = true;
      } catch (err) {
        util.toast(`服务端没接受分组撤销（${(err && err.message) || '未知错误'}）：这一批操作会各自算一步`, 'warn', 6000);
      }
      try {
        const out = await fn();
        if (!opened) return null;
        return await Transit.op({ k: 'endGroup' });
      } catch (err) {
        if (opened) {
          // 收尾失败也不把原始错误吞掉：服务端的分组 TTL 会兜底收尾
          await Transit.op({ k: 'abortGroup' }).catch(() => { /* 忽略 */ });
        }
        throw err;
      }
    },

    /** 从 ack 里取分组信息（beginGroup/endGroup/abortGroup 的 ack 在 result.group 里） */
    ackGroup(ack) {
      if (!ack || typeof ack !== 'object') return null;
      const g = (ack.result && ack.result.group) || ack.group || null;
      return g && typeof g === 'object' ? g : null;
    },

    /**
     * 倍速的语义说明（**新语义**：倍速 = 实时时间的倍数，没有别的换算系数）。
     *   ×1 = 实时（现实 1 秒 = 游戏 1 秒）、×60 = 现实 1 秒 = 游戏 1 分钟、×300 = 现实 1 秒 = 游戏 5 分钟。
     * 文案优先用 ui.js 的 UI.clockSpeedDetail（顶栏按钮/菜单说明行就是它出的，口径必须一致），
     * ui.js 没加载时按同一规则本地拼一份。
     */
    speedDetail(speed) {
      const n = Number(speed) || 0;
      const ui = window.G && window.G.UI;
      if (ui && typeof ui.clockSpeedDetail === 'function') return String(ui.clockSpeedDetail(n));
      if (n === 0) return '时间已暂停：1 实时秒 = 0 游戏时间';
      if (n === 1) return '×1 = 实时：1 实时秒 = 1 游戏秒';
      if (n % 60 === 0) return `×${n}：1 实时秒 = ${n / 60} 游戏分钟`;
      return `×${n}：1 实时秒 = ${n} 游戏秒`;
    },

    /** 整个游戏时钟的一句话文案（toast 用） */
    speedText(speed) {
      const n = Number(speed) || 0;
      if (n === 0) return '游戏时间已暂停（现实时间不再推进游戏时钟；再点暂停按钮即继续）';
      return `游戏时间 ${Transit.speedDetail(n)}`;
    },

    setSpeed(speed) {
      const s = Number(speed) || 0;
      Transit.op({ k: 'clock.set', speed: s })
        .then((res) => {
          // 以服务端确认的档位为准（服务端只接受合法档位）
          const applied = res && res.result && Number.isFinite(Number(res.result.speed)) ? Number(res.result.speed) : s;
          if (Transit.data && Transit.data.clock) Transit.data.clock.speed = applied;
          Transit.renderClock();
          util.toast(Transit.speedText(applied), 'info', 2600);
        })
        // clock.set 失败的提示由**调用方**负责（这里 / ui.js 的「跳到…」各有带上下文的提示），
        // onAck 对 clock.set 不再兜底弹一条，免得同一个错误弹两遍（见 CALLER_TOAST_OPS）
        .catch((err) => util.toast((err && err.message) || '倍速设置失败', 'error', 5000));
    },

    /** 可选的倍速档位（服务端可通过 transit 配置覆盖） */
    speeds() {
      const s = Transit.config && Transit.config.speeds;
      return Array.isArray(s) && s.length ? s : SPEEDS;
    },

    /** 当前倍速；拿不到就当作暂停 */
    currentSpeed() {
      const c = Transit.data && Transit.data.clock;
      return c && Number.isFinite(Number(c.speed)) ? Number(c.speed) : 0;
    },

    /**
     * 顶栏倍速菜单：一排档位芯片，点一下就 setSpeed，当前档位高亮。
     * 与 UI.toggleClockMenu 配合（UI 负责开关与「跳到…」行，这里只负责芯片本身）。
     * 注意：#clock-pause 暂停按钮与菜单里的「跳到…」行都由 ui.js 负责（UI.installClockControls），
     * 这里**不要**再补一份，否则会重复。
     */
    renderClockMenu() {
      const box = util.$('#clock-menu');
      if (!box) return;
      const cur = Transit.currentSpeed();
      box.innerHTML = '';
      for (const s of Transit.speeds()) {
        const b = util.el('button', 'clock-chip' + (s === cur ? ' active' : ''), s === 0 ? '⏸ 暂停' : '×' + s);
        b.type = 'button';
        b.dataset.speed = String(s);
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', s === cur ? 'true' : 'false');
        b.title = s === 0 ? '暂停游戏时间（铺轨、画线时用；恢复用暂停/继续按钮）' : `切到 ${Transit.speedDetail(s)}`;
        b.onclick = () => {
          Transit.setSpeed(s);
          Transit.toggleClockMenu(false);
        };
        box.appendChild(b);
      }
      box.appendChild(util.el('div', 'clock-menu-hint',
        `游戏时间倍速 · 当前 ${cur === 0 ? '暂停' : '×' + cur}（${Transit.speedDetail(cur)}）· Shift+点击按钮顺序切换`));
    },

    /** 展开/收起倍速菜单；返回是否处于展开状态 */
    toggleClockMenu(on) {
      const box = util.$('#clock-menu');
      if (!box) return false;
      const show = on === undefined ? box.classList.contains('hidden') : !!on;
      if (show) Transit.renderClockMenu();
      box.classList.toggle('hidden', !show);
      const btn = util.$('#clock-speed');
      if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      return show;
    },

    /** 备用路径：按档位顺序切到下一档（顶栏 Shift+点击 / 脚本调用）；菜单才是主入口 */
    cycleSpeed() {
      const list = Transit.speeds();
      const cur = Transit.currentSpeed();
      const idx = list.indexOf(cur);
      const next = list[(idx + 1) % list.length];
      Transit.setSpeed(next);   // 提示由 setSpeed 统一发
      return next;
    },

    renderClock() {
      const box = util.$('#clock-box');
      if (!box || !Transit.data || !Transit.data.clock) return;
      const c = Transit.data.clock;
      util.$('#clock-time').textContent = c.time || '00:00';
      // 顶栏只显示时间（第几天在时钟菜单里看）：#clock-day 只是可选的落点，
      // 节点不存在就不能抛错 —— 这样 index.html 里那个隐藏占位节点随时可以删掉。
      const dayEl = util.$('#clock-day');
      if (dayEl) dayEl.textContent = `第 ${c.day || 1} 天`;
      const btn = util.$('#clock-speed');
      btn.textContent = c.speed === 0 ? '⏸ 暂停' : `▶ ×${c.speed}`;
      btn.classList.toggle('paused', c.speed === 0);
      btn.title = c.speed === 0
        ? '游戏时间已暂停 · 点击选择倍速（Shift+点击顺序切换）'
        : `游戏时间 ×${c.speed} · 点击选择倍速（Shift+点击顺序切换）`;
      // 菜单开着的时候跟着服务端状态刷新高亮
      const menu = util.$('#clock-menu');
      if (menu && !menu.classList.contains('hidden')) Transit.renderClockMenu();
    },

    /**
     * 在地图上点中车站/车辆：**只弹那个小气泡**（车站 → 站名 + 等车/线路 + 定位/删除；
     * 车辆 → 车次 + 载客 + 下一站 + 定位/撤下线路/删除）。
     * 点车身、点车辆旁边的信息泡泡、点站名/等车徽标都是走这里（hitTest 把它们判成同一个实体）。
     *
     * 玩家明确要求过（这是契约，别改回去）：地图上的一次点击——
     *   · **不切换**交通面板的分区（不会跳到「车站」/「车辆」页），
     *   · **不打开**任何管理器（面板的分区本身就是各个管理器，独立窗口已经整套删掉），
     *   · **不重建**面板（重建会把列表滚动位置、筛选框与正在输入的焦点一起冲掉）。
     * 一次普通点击只做两件事：地图上高亮它 + 弹出那个小气泡；要管理器就在左侧列表里点那一行。
     */
    selectOnMap(hit, latlng) {
      if (!hit) return null;
      Transit.selectedStation = hit.type === 'station' ? hit.id : null;
      if (Render.overlay) Render.overlay.redraw();
      if (hit.type === 'train') {
        Transit.selectVehicleOnMap(hit.id, latlng);
        return;
      }
      const st = Transit.stationById(hit.id);
      if (!st) return null;
      // 只弹气泡：panel 为 false（默认），面板与选中状态一个字节都不碰
      Transit.selectStation(st, { popup: true, latlng, panel: false });
      return st;
    },

    /**
     * 地图上点中一辆车（车身或它旁边的信息泡泡）：**只弹那个小气泡**（车次 · 载客 · 下一站 · 班次）
     * 并把这辆车记成"当前选中的车"（后面打开面板时默认就看它）。
     *
     * 和 selectStation 一样的契约：不切分区、不打开管理器、不重建面板。
     * 面板开着的时候连 `Transit.selected` 都不动（面板上的东西一个像素都不变）；
     * 面板没开的时候才把选中记下来，这样玩家随后打开面板看到的就是刚点过的那辆车。
     * 只有显式按钮（例如面板里的「🗂 总面板里打开」）才传 { panel: true }。
     */
    selectVehicleOnMap(id, latlng, options) {
      const opt = options || {};
      const v = Transit.vehicleById(id) || Transit.liveVehicle(id);
      const vid = Number(v ? v.id : id);
      if (!Number.isFinite(vid)) return null;
      Transit.selectedVehicle = vid;
      if (opt.panel) { Transit.openPanelFor('vehicle', vid); return v; }
      if (!Transit.panelOpen) Transit.selected = { type: 'vehicle', id: vid };
      // 地图上照旧给那个小气泡（点车身 / 点泡泡都一样能拿到它）
      Transit.openVehicleDetail(vid, latlng || null, { silent: true });
      if (Render.overlay) Render.overlay.redraw();
      return v;
    },

    /**
     * 在给定位置打开车站弹出框：**和点开一辆车一模一样的那套紧凑排版**（名字 + 1~2 个关键数字 + 一排按钮）。
     * 两边都用 miniPopupHtml / .popup-mini，所以尺寸（190~240 像素）与结构完全一致，不再是那个较大的框；
     * 站点管理器里的明细（覆盖人数 / 分线路候车（每条线的去向）/ 接入线路 / 改名）都在右侧面板里。
     */
    openStationPopup(station, latlng) {
      if (!station || !Render.map) return null;
      injectTransitStyle();
      // 框里的按钮走文档级的 data-act 委托（_bindPopup 只绑一次、幂等）：
      // 这里主动叫一次，保证任何路径打开的框都能点到按钮（不必先开过面板）。
      Transit._bindPopup();
      const ll = latlng || [station.lat, station.lon];
      const popup = L.popup({ className: 'osmcity-popup popup-mini popup-st-mini', maxWidth: MINI_POPUP_MAX_W, minWidth: MINI_POPUP_MIN_W, autoPan: true, offset: [0, -8] })
        .setLatLng(ll)
        .setContent(Transit.stationMiniHtml(station))
        .openOn(Render.map);
      Transit._stationPopup = {
        stationId: Number(station.id), popup, sig: Transit.stationMiniSig(station), builtAt: Date.now(),
      };
      if (typeof popup.on === 'function') {
        // 弹窗被 Leaflet 关掉（点了别处 / 换了别的弹窗）就把引用清掉，免得后面白刷
        popup.on('remove', () => {
          if (Transit._stationPopup && Transit._stationPopup.popup === popup) Transit._stationPopup = null;
        });
      }
      return popup;
    },

    /**
     * 点击后弹出框的**唯一**渲染器：车站与车辆共用同一套紧凑排版与尺寸（改字段只改这一处）。
     * spec = {
     *   cls,     附加类名（popup-st-mini / popup-veh-mini；样式统一在 .popup-mini 下）
     *   attrs,   挂在最外层 div 上的额外属性（例如 data-train / data-station）
     *   color,   标题左侧的小圆点（公司色 / 线路色）
     *   title,   标题（车站名 / 车次）
     *   sub,     标题右侧的小字（#id、类型、所属公司…）
     *   rows:    [{ label, html|value, live, key, cls }]：live='slive'|'vlive' 时带上 data-xxx 标记，
     *            配合 _fillStationLive / _fillVehicleLive 在模拟帧里**就地改数字**（按钮不会被重建，点了不会丢）
     *   actions: [{ act, id, label, title, danger, disabled, cls }]：按钮走文档级的 data-act 委托（_bindPopup）
     * }
     */
    miniPopupHtml(spec) {
      const s = spec || {};
      const rows = (s.rows || []).map((r) => {
        const live = (r && r.live && r.key) ? ` data-${r.live}="${util.esc(r.key)}"` : '';
        const cls = r && r.cls ? ` class="${util.esc(r.cls)}"` : '';
        const val = r && r.html != null ? r.html : util.esc(r && r.value != null ? r.value : '');
        return `<div class="popup-row"><span>${util.esc(r && r.label)}</span><b${live}${cls}>${val}</b></div>`;
      }).join('');
      const actions = (s.actions || []).map((a) => {
        const cls = [a && a.danger ? 'danger' : '', (a && a.cls) || ''].filter(Boolean).join(' ');
        return `<button data-act="${util.esc(a && a.act)}" data-id="${util.esc(String(a && a.id))}"`
          + `${cls ? ` class="${cls}"` : ''}${a && a.disabled ? ' disabled' : ''}`
          + `${a && a.title ? ` title="${util.esc(a.title)}"` : ''}>${util.esc(a && a.label)}</button>`;
      }).join('');
      return `<div class="popup popup-mini ${util.esc(s.cls || '')}"${s.attrs || ''}>
        <div class="popup-title"><span class="dot" style="--c:${util.esc(s.color || '#888')}"></span>${util.esc(s.title)}${s.sub ? `<small>${util.esc(s.sub)}</small>` : ''}</div>
        ${rows}
        <div class="popup-actions">${actions}</div>
      </div>`;
    },

    /**
     * 车站弹出框的内容：和车辆那个同一个 renderer、同一套排版 —— 站名 + 三个关键数字
     * （等车人数 / 线路数 / **每条线路各有多少人在等**）+ 一排按钮（定位 / 🧰 打开 / 删除）。
     * 「🧰 打开」= **打开交通公司面板的「车站」分区并选中这一站**（data-act = open-station-panel）：
     * 站点管理器（覆盖人数 / 分线路候车 / 接入线路 / 改名 / 删除）就在那个 tab 的右侧详情里。
     * 它**不是**独立窗口（那一整套已经删掉，不会再长回来）。
     * 删除按钮和面板里的「删除」是同一个 data-act（delete-station）→ 同一条 Transit.deleteStation，
     * 所以两边行为完全一致。
     * **协作编辑口径**：车站是谁建的都能改、都能删、都能挪（服务端就是这么放的）——
     * 底图导入的公共车站在这里也只是多一枚「公共·导入」的来源标记，按钮一个不少。
     * 唯一让按钮变灰的是**元素锁**：别人正在改这个站时删除按钮 disabled + 服务端那句中文原因。
     * mine 现在只决定按钮的红色样式（自己建的看着醒目一点），不是权限。
     * 框内容只在站名 / 类型 / 公司 / 接入线路变化时才重建（stationMiniSig），
     * 数字（含分线路等车人数）由 _fillStationLive 就地改，所以按钮不会在点击前被换掉。
     */
    stationMiniHtml(station) {
      if (!station) return '';
      const owner = ((Transit.data && Transit.data.companies) || []).find((c) => c.id === station.companyId);
      const pub = Transit.isPublicStation(station);
      const lockBy = Transit.elemLockBy('station', station.id);
      const actions = [
        { act: 'goto-station', id: station.id, label: '定位', title: '把地图移到这个车站' },
        {
          act: 'open-station-panel', id: station.id, label: '🧰 打开',
          title: '在交通公司面板的「车站」分区里打开这个车站（站点管理器：覆盖人数 / 候车明细 / 接入线路 / 改名 / 删除都在那块详情里）',
        },
        {
          act: 'delete-station', id: station.id, label: '🗑 删除', danger: true, disabled: !!lockBy,
          title: lockBy
            ? lockBusyText(lockBy)
            : '删除这个车站（会从所有线路里移除，可撤销；谁建的车站都能删，底图导入的站也一样）',
        },
      ];
      return Transit.miniPopupHtml({
        cls: 'popup-st-mini',
        attrs: ` data-station="${station.id}"`,
        color: (owner && owner.color) || '#888',
        title: station.name,
        sub: `#${station.id} · ${Transit.kindName(station.kind)}${pub ? ' · 公共·导入' : ''}`,
        rows: [
          { label: '等车', key: 'wait', live: 'slive', html: Transit.stationWaitHtml(station) },
          { label: '线路', key: 'lines', live: 'slive', html: `${util.fmt(Transit.stationsLineCount(station.id))} 条` },
          // 一条紧凑的"每条线路各有多少人在等"：`1路 6 人 · 2路 4 人`（太长就把尾巴省略，鼠标悬停看全部）
          {
            label: '各线', key: 'byline', live: 'slive', cls: 'stm-byline-cell',
            html: Transit.stationByLineWaitHtml(station),
          },
        ],
        actions,
      });
    },

    /** 车站气泡里那一行能放下几条线路（再多就收成「+N 条线」，完整清单进 title） */
    STATION_BYLINE_MAX: 3,

    /**
     * 车站气泡的那一行「每条线路各有多少人在等」：`1路 6 人 · 2路 4 人`（只列真有人在等的线，
     * 按人数从多到少；超过 STATION_BYLINE_MAX 条就收成「+N 条线」，完整清单放 title）。
     * 数据来自服务端 stationPublic().waitingByLine（见 stationLineWait）——没下发就如实说「明细未下发」，
     * 绝不拿等车合计数去编一个假的分布。
     */
    stationByLineWaitHtml(station) {
      const rows = Transit.stationLineWait(station).filter((r) => r.waiting > 0);
      if (!rows.length) {
        const none = Transit.stationWaiting(station) > 0 ? '分线路明细未下发' : '无人等车';
        return `<span class="stm-byline-none">${util.esc(none)}</span>`;
      }
      const cap = Math.max(1, Number(Transit.STATION_BYLINE_MAX) || 3);
      const shown = rows.slice(0, cap);
      const rest = rows.length - shown.length;
      const text = shown.map((r) => `${r.name} ${util.fmt(r.waiting)} 人`).join(' · ')
        + (rest > 0 ? ` · +${rest} 条线` : '');
      const full = rows.map((r) => `${r.name}：${util.fmt(r.waiting)} 人在等`).join('\n');
      return `<span class="stm-byline" title="${util.esc(full)}">${util.esc(text)}</span>`;
    },

    /** 等车人数 + 10 秒趋势（弹出框里的那一格；地图徽标上的小箭头用的是同一个 waitingTrend） */
    stationWaitHtml(station) {
      const tr = Transit.waitingTrend(station);
      const arrow = tr.dir === 'up' ? `↑ +${util.fmt(tr.delta)}` : (tr.dir === 'down' ? `↓ ${util.fmt(tr.delta)}` : '→ 0');
      return `${util.fmt(Transit.stationWaiting(station))} 人 <span class="tp-trend ${tr.dir === 'up' ? 'up' : (tr.dir === 'down' ? 'down' : '')}"
        title="每 10 秒比较一次，看队伍在涨还是在消化">${util.esc(arrow)}</span>`;
    },

    stationMiniSig(station) {
      if (!station) return '';
      // 元素锁也进指纹：别人开始 / 停止编辑这个车站时，删除按钮的可用状态要跟着变。
      // 「各线」那一行的**线路清单**也进指纹（人数本身走 _fillStationLive 就地改）：
      // 某条线路加了这个站 / 被删掉时，那一行要跟着重建，不然会一直显示旧线路。
      const lineIds = Transit.stationLineWait(station)
        .map((r) => (r.lineId == null ? 'fb' : r.lineId)).join(',');
      return [station.name, station.kind, station.companyId == null ? '' : station.companyId,
        Transit.isPublicStation(station) ? 'pub' : '',
        Transit.elemLockBy('station', station.id) || '', lineIds].join('|');
    },

    /** 关掉当前的车站弹出框（删除车站之后用） */
    closeStationPopup() {
      const ref = Transit._stationPopup;
      Transit._stationPopup = null;
      if (ref && ref.popup) {
        try { ref.popup.remove(); } catch { /* 已经关掉了 */ }
      }
    },

    /** 车站弹出框里的实时数字就地更新（等车人数 / 经过的线路数 / 分线路等车人数；按钮不重建，点了不会丢） */
    _fillStationLive(root, station) {
      if (!root || typeof root.querySelector !== 'function' || !station) return;
      const set = (key, html) => {
        const el = root.querySelector(`[data-slive="${key}"]`);
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      set('wait', Transit.stationWaitHtml(station));
      set('lines', `${util.fmt(Transit.stationsLineCount(station.id))} 条`);
      set('byline', Transit.stationByLineWaitHtml(station));
    },

    /** 保存/同步之后刷新还开着的框：名字/类型/公司变了就整块换，否则只改里面的数字 */
    refreshStationPopup(force) {
      const ref = Transit._stationPopup;
      if (!ref || !ref.popup) return;
      const st = Transit.stationById(ref.stationId);
      if (!st) {
        Transit.closeStationPopup();
        return;
      }
      const root = typeof ref.popup.getElement === 'function' ? ref.popup.getElement() : null;
      const sig = Transit.stationMiniSig(st);
      if (force || !root || sig !== ref.sig) {
        try {
          ref.popup.setContent(Transit.stationMiniHtml(st));
          ref.sig = sig;
          ref.builtAt = Date.now();
        } catch { /* 弹窗已关闭，忽略 */ }
        return;
      }
      Transit._fillStationLive(root, st);
    },

    /** 服务端同步后刷新气泡（只有名字，指纹没变就不动 DOM） */
    syncStationPopup() {
      Transit.refreshStationPopup(false);
    },

    /* ------------------------------ 车辆详情气泡（点地图上的车 / 点车辆列表行都到这儿） ------------------------------ */

    /**
     * 车辆弹出框：地图点车、车辆列表点行都调它 —— 两处看到的是同一份详情。
     * 和车站弹出框**共用同一套紧凑排版**（miniPopupHtml / .popup-mini，190~240 像素），
     * 一行一个字段：车次 / 线路 / 载客 / 下一站 / 预计到站 / 班次（含准点）/ 速度，
     * 四个按钮：定位、🧰 打开（打开交通面板「车辆」分区并选中它）、撤下线路、删除
     * （谁的车都能撤 / 都能删，只有元素锁才拦）。
     * 模拟帧里用 refreshVehiclePopup 就地改数字（按钮不重建，点了不会丢）。
     */
    openVehiclePopup(train, latlng) {
      const t = (train && typeof train === 'object') ? train : Transit.liveVehicle(train);
      if (!t || !Render.map) return null;
      // 没指派线路（或没有实时位置）的车不弹气泡：它的坐标说明不了"它现在在跑哪儿"
      const pos = Transit.vehiclePosInfo(Transit.vehicleById(t.id) || t, t, latlng);
      if (!pos.ok) { util.toast(pos.reason, 'warn', 3500); return null; }
      const at = pos.at;
      injectTransitStyle();
      // 框里的按钮走文档级的 data-act 委托（_bindPopup 只绑一次、幂等）：这里主动叫一次，
      // 保证任何路径打开的框都能点到按钮（不必先开过面板）。
      Transit._bindPopup();
      const popup = L.popup({
        className: 'osmcity-popup popup-mini popup-veh-mini',
        maxWidth: MINI_POPUP_MAX_W, minWidth: MINI_POPUP_MIN_W, autoPan: true, offset: [0, -6],
      })
        .setLatLng(at)
        .setContent(Transit.vehicleMiniHtml(t))
        .openOn(Render.map);
      Transit._vehiclePopup = { trainId: Number(t.id), popup, sig: Transit.vehicleMiniSig(t), builtAt: Date.now() };
      if (typeof popup.on === 'function') {
        // 弹窗被 Leaflet 关掉（点了别处）就把引用清掉，免得后面白刷
        popup.on('remove', () => {
          if (Transit._vehiclePopup && Transit._vehiclePopup.popup === popup) Transit._vehiclePopup = null;
        });
      }
      return popup;
    },

    /** 车辆弹出框的内容（和车站那个同一个 miniPopupHtml；班次晚点用红字） */
    vehicleMiniHtml(train) {
      const info = Transit.vehicleRunInfo(train);
      const t = info.train || {};
      const owner = ((Transit.data && Transit.data.companies) || [])
        .find((c) => c.id === (t.companyId === undefined ? t.owner : t.companyId));
      // 协作编辑：**谁的车都能撤下线路**，所以这里只按元素锁禁用（别人正在改这辆车 → 画成禁用 + 中文原因）。
      // mine 只用来决定按钮的红样式（自己车看着醒目），不再是权限。
      const mine = !!Editor.myId && (t.owner === Editor.myId || (info.vehicle && info.vehicle.owner === Editor.myId));
      const lockBy = Transit.elemLockBy('vehicle', info.id);
      // 「定位」只在车**已指派线路且有实时位置**时可用：没指派的车不能把地图甩到一个说不清的点上
      const pos = Transit.vehiclePosInfo(info.vehicle || t, t);
      const sub = [`#${info.id}`, owner ? owner.name : ''].filter(Boolean).join(' · ');
      return Transit.miniPopupHtml({
        cls: 'popup-veh-mini',
        attrs: ` data-train="${info.id}"`,
        color: info.lineColor,
        title: info.name,
        sub,
        rows: [
          { label: '车次', html: util.esc(info.name) },
          { label: '线路', html: util.esc(info.lineName) },
          { label: '载客', key: 'load', live: 'vlive', html: util.esc(info.loadText) },
          { label: '下一站', key: 'next', live: 'vlive', html: util.esc(info.nextStop) },
          { label: '预计到站', key: 'eta', live: 'vlive', html: util.esc(info.etaText) },
          { label: '班次', key: 'sched', live: 'vlive', html: Transit.vehicleScheduleHtml(info) },
          { label: '速度', key: 'speed', live: 'vlive', html: util.esc(info.speedText) },
        ],
        actions: [
          {
            act: 'follow-train', id: info.id, label: '定位',
            disabled: !pos.ok,
            title: pos.ok ? '把地图移到这辆车（跟着它看）' : pos.reason,
          },
          // 「🧰 打开」= 打开**交通公司面板的「车辆」分区**并选中这辆车（data-act = open-vehicle-panel）：
          // 右侧那块车辆管理器里就能接着改（指派线路 / 改名 / 撤下线路 / 删除 / 停靠站序列与客流）。
          // 不是独立窗口 —— 那一整套已经删掉，这个按钮只是"切到面板对应的 tab"。
          // 车还没指派线路（没有实时位置）也照样能打开：面板里正需要给它选线路。
          {
            act: 'open-vehicle-panel', id: info.id, label: '🧰 打开',
            title: '在交通公司面板的「车辆」分区里打开这辆车（指派线路 / 改名 / 撤下线路 / 删除都在这块详情里）',
          },
          {
            act: 'unassign-train', id: info.id, label: '撤下线路', danger: mine, disabled: !!lockBy,
            title: lockBy ? lockBusyText(lockBy) : '把这辆车从线路上撤下来（变成闲置，可撤销；谁的车都能撤）',
          },
          // 协作编辑：**谁的车都能删**（服务端 deleteVehicle 不看 owner）—— 气泡里也给一个入口，
          // 和车站气泡的删除按钮同一个位置、同一套观感；只有"别人正锁着这辆车"时才禁用。
          {
            act: 'delete-vehicle', id: info.id, label: '🗑 删除', danger: true, disabled: !!lockBy,
            title: lockBy ? lockBusyText(lockBy) : '删除这辆车（可撤销；谁的车都能删）',
          },
        ],
      });
    },

    /** 班次那一格：下一班发车 + 准点情况（晚点=红字） */
    vehicleScheduleHtml(info) {
      const parts = [];
      if (info.noService) parts.push('现在没有班次');
      else if (info.departure) parts.push(`下一班 ${info.departure}`);
      const head = parts.join(' · ');
      const lag = info.lagText || '—';
      return `${head ? util.esc(head) + ' · ' : ''}<span class="tp-lag${info.late ? ' late' : ''}">${util.esc(lag)}</span>`;
    },

    /** 班次那一格的纯文本版（面板详情行用；HTML 版见 vehicleScheduleHtml / scheduleCellHtml） */
    vehicleSchedText(info) {
      const parts = [];
      if (info.noService) parts.push('现在没有班次');
      else if (info.departure) parts.push(`${info.departure} 发车`);
      parts.push(info.lagText || '—');
      return parts.join(' · ');
    },

    /** 气泡指纹：只有线路 / 班次状态 / 归属 / 元素锁变了才整块重建（其它时候只改数字） */
    vehicleMiniSig(train) {
      if (!train) return '';
      const v = Transit.vehicleById(train.id) || {};
      return [train.id, train.name, train.lineId == null ? '' : train.lineId,
        v.lineId == null ? '' : v.lineId, v.noServiceNow ? 1 : 0, train.noServiceNow ? 1 : 0,
        train.owner == null ? '' : train.owner,
        Transit.elemLockBy('vehicle', train.id) || ''].join('|');
    },

    /** 气泡里的实时数字就地更新（不重建 DOM —— 正要点按钮的时候按钮不会被换掉） */
    _fillVehicleLive(root, train) {
      if (!root || typeof root.querySelector !== 'function' || !train) return;
      const info = Transit.vehicleRunInfo(train);
      const set = (key, html) => {
        const el = root.querySelector(`[data-vlive="${key}"]`);
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      set('load', util.esc(info.loadText));
      set('next', util.esc(info.nextStop));
      set('eta', util.esc(info.etaText));
      set('sched', Transit.vehicleScheduleHtml(info));
      set('speed', util.esc(info.speedText));
    },

    /** 数据帧里刷新车辆气泡：字段变了就地改，线路/归属变了才重建内容 */
    refreshVehiclePopup(force) {
      const ref = Transit._vehiclePopup;
      if (!ref || !ref.popup) return;
      const t = Transit.liveVehicle(ref.trainId) || Transit.vehicleById(ref.trainId);
      if (!t) { Transit.closeVehiclePopup(); return; }
      const root = typeof ref.popup.getElement === 'function' ? ref.popup.getElement() : null;
      const sig = Transit.vehicleMiniSig(t);
      if (force || !root || sig !== ref.sig) {
        try {
          ref.popup.setContent(Transit.vehicleMiniHtml(t));
          ref.sig = sig;
        } catch { /* 弹窗已经关掉了 */ }
        return;
      }
      Transit._fillVehicleLive(root, t);
    },

    /** 关掉当前的车辆气泡（撤下线路 / 车没了的时候用） */
    closeVehiclePopup() {
      const ref = Transit._vehiclePopup;
      Transit._vehiclePopup = null;
      if (ref && ref.popup) {
        try { ref.popup.remove(); } catch { /* 已经关掉了 */ }
      }
    },

    /**
     * 从任意入口看一辆车的详情：地图点车（latlng 已知）或车辆列表点行（没有 latlng）。
     * 列表点进来时，如果车不在视野里（或当前缩放根本画不出这种车），先把地图移过去再弹气泡。
     */
    openVehicleDetail(idOrTrain, latlng, options) {
      const opt = options || {};
      const t = (idOrTrain && typeof idOrTrain === 'object')
        ? idOrTrain
        : (Transit.liveVehicle(idOrTrain) || Transit.vehicleById(idOrTrain));
      if (!t) {
        if (!opt.silent) util.toast('找不到这辆车（可能已经被删掉了）', 'warn', 3000);
        return null;
      }
      const pos = Transit.vehiclePosInfo(Transit.vehicleById(t.id) || t, t, latlng);
      if (!pos.ok) {
        // 没指派线路 / 没实时位置：面板详情照常看，只是没气泡可弹（顺便把中文原因说清楚）
        if (!opt.silent) util.toast(pos.reason, 'warn', 3500);
        return null;
      }
      if (!latlng) Transit.ensureVehicleInView(t, pos.at);
      return Transit.openVehiclePopup(t, pos.at);
    },

    /**
     * 坐标归一化：{lat,lon} / {lat,lng} / [lat,lon] / Leaflet LatLng 都能吃，返回 [lat, lon]。
     * **空值绝不当 0 用**：服务端给没上路 / 没指派的车回的是 lat:null, lon:null，
     * 而 `Number(null) === 0` 会让它变成 (0,0)（几内亚湾）——那就是一个"看着像真位置的假点"，
     * 定位一按地图就飞到那儿去了。所以 null / undefined / '' / 非数字一律当没有坐标。
     */
    vehicleLatLng(a, b) {
      const num = (x) => {
        if (x === null || x === undefined || x === '') return null;
        const n = Number(x);
        return Number.isFinite(n) ? n : null;
      };
      const pick = (o) => {
        if (!o) return null;
        if (Array.isArray(o)) {
          const lat = num(o[0]);
          const lon = num(o[1]);
          return lat === null || lon === null ? null : [lat, lon];
        }
        const lat = num(o.lat);
        const lon = num(o.lng !== undefined && o.lng !== null ? o.lng : o.lon);
        return lat === null || lon === null ? null : [lat, lon];
      };
      return pick(a) || pick(b) || null;
    },

    /**
     * 这辆车现在能不能「定位」——能就给出坐标，不能就连**中文原因**一起给出来。
     * 两条硬条件（少一条都不许动地图，免得把地图甩到一个说不清的点上）：
     *   · 必须已指派线路：没指派的车没有"正在跑的位置"，快照里那些坐标只是它最后停的地方；
     *   · 必须有实时位置（服务端 runtime 的 lat/lon 或按线路算出来的坐标）。
     * 界面上所有「定位」按钮（车辆列表 / 车辆管理器 / 地图气泡 / 面板详情）都走这一个判断，
     * 所以"能不能点"和"为什么不能点"在整个界面里只有一个口径。
     */
    vehiclePosInfo(vehicle, live, latlng) {
      const v = (vehicle && typeof vehicle === 'object') ? vehicle : Transit.vehicleById(vehicle);
      const t = live || (v ? Transit.liveVehicle(v.id) : null) || v || null;
      if (!v && !t) return { ok: false, at: null, reason: '找不到这辆车（可能已经被删掉了）' };
      const lineId = (v && v.lineId != null) ? v.lineId : (t && t.lineId != null ? t.lineId : null);
      if (lineId == null) return { ok: false, at: null, reason: '这辆车还没指派线路，没有正在跑的位置' };
      const at = Transit.vehicleLatLng(t, latlng || v);
      if (!at) return { ok: false, at: null, reason: '这辆车还没上路（没有实时位置）' };
      return { ok: true, at, reason: '' };
    },

    /** 这辆车现在能不能定位（vehiclePosInfo 的布尔版） */
    vehicleLocatable(vehicle, live, latlng) {
      return Transit.vehiclePosInfo(vehicle, live, latlng).ok;
    },

    /** 车已经在视野里就别动地图（免得跳来跳去）；不在就飞过去，顺带把缩放提到能看见这种车 */
    ensureVehicleInView(train, at) {
      const map = Render.map;
      if (!map || !at) return false;
      const ll = L.latLng(at[0], at[1]);
      const minZoom = Transit.vehicleMinZoom(train && train.kind);
      const inView = map.getBounds().pad(0.06).contains(ll);
      if (inView && map.getZoom() >= minZoom) return false;
      return util.flyToSafe(map, at[0], at[1], Math.max(map.getZoom(), minZoom), { duration: 0.35 });
    },

    /* ------------------------------ 班次 / 营运信息（面板、线路管理器、地图气泡共用一份口径） ------------------------------ */

    /**
     * 一辆车的营运信息：下一站 / 预计到站 / 下一班发车 / 准点情况 / 速度状态。
     * 服务端字段（nextStop / etaSeconds / scheduledDeparture / scheduleLag / noServiceNow）缺失时
     * 一律降级（用线路里程推算下一站、相关项显示 '—'），不会抛错。
     */
    vehicleRunInfo(v, live) {
      const base = (v && typeof v === 'object') ? v : null;
      const id = base && base.id != null ? base.id : (typeof v === 'number' ? v : null);
      const t = live || Transit.liveVehicle(id) || base || {};
      const veh = base && (base.lineId !== undefined || base.lengthM !== undefined) ? base : Transit.vehicleById(id);
      const lineId = t.lineId != null ? t.lineId : (veh ? veh.lineId : null);
      const line = Transit.lineById(lineId);
      const load = Number(t.load != null ? t.load : (veh && veh.load)) || 0;
      const capacity = Number(t.capacity != null ? t.capacity : (veh && veh.capacity)) || 0;
      const speed = Number(t.speed) || 0;
      const state = t.state || (veh && veh.state) || '';
      const etaSeconds = Transit.etaSecondsOf(t);
      const lagMinutes = Transit.scheduleLagMinutes(t);
      // #车厂：不在运营的车统一叫「在车厂」（stateWord 会在车辆列表 / 气泡 / 详情里显示）
      const depot = Transit.vehicleDepotInfo(veh || base, live);
      const stateWord = depot.depot ? '在车厂'
        : (!lineId ? '闲置' : (state === 'dwell' ? '停站中' : (speed > 0 ? '运行中' : '待发车')));
      return {
        train: t,
        vehicle: veh,
        line,
        id: id != null ? Number(id) : Number(t.id),
        name: t.name || (veh && veh.name) || `#${id}`,
        lineName: line ? line.name : '未指派',
        lineColor: Transit.lineColor(line),
        load,
        capacity,
        loadText: capacity
          ? `${util.fmt(load)} / ${util.fmt(capacity)}（${Math.round((load / capacity) * 100)}%）`
          : `${util.fmt(load)} 人`,
        nextStop: Transit.nextStopOf(t, line),
        etaSeconds,
        etaText: etaSeconds == null ? '—' : '约 ' + Transit.fmtSeconds(etaSeconds),
        departure: Transit.vehicleDepartureText(veh, t, line),
        lagMinutes,
        lagText: Transit.scheduleLagText(lagMinutes),
        late: lagMinutes != null && lagMinutes > 0.5,
        // 「现在没有班次」：车自己报的优先，其次看**线路**报的（#3 暂停运营时 linePublic().noServiceNow 一定为 true，
        // 这时气泡/列表里的班次那一格就该显示"现在没有班次"，而不是一个看着像故障的空格）
        noService: t.noServiceNow === true || !!(veh && veh.noServiceNow === true) || !!(line && line.noServiceNow === true),
        stateWord,
        speedText: `${speed > 0 ? Math.round(speed) + ' km/h' : '静止'} · ${stateWord}`,
      };
    },

    /** 这辆车下一班的发车时刻（服务端字段优先，其次线路 runs 里属于它的那一班） */
    vehicleDepartureText(veh, train, line) {
      const direct = Transit.fmtClock((train && train.scheduledDeparture) || (train && train.nextDeparture)
        || (veh && veh.scheduledDeparture) || (veh && veh.nextDeparture));
      if (direct) return direct;
      const id = Number((train && train.id) || (veh && veh.id));
      const runs = Transit.lineRuns(line);
      if (!runs.length) return '';
      const mine = runs.map((r) => ({ run: r, at: Transit.runTime(r) }))
        .filter((x) => x.at && Number(x.run && (x.run.vehicleId != null ? x.run.vehicleId : x.run.vehicle)) === id);
      const clock = Transit.clockText();
      const next = mine.map((x) => x.at).filter((at) => !clock || at >= clock).sort()[0];
      return next || (mine.length ? mine[0].at : '');
    },

    /** 'HH:MM' 时钟文本（服务端给秒数 / 分钟数 / 各种字符串都能吃），认不出返回 '' */
    fmtClock(v) {
      if (v == null || v === '') return '';
      const num = Number(v);
      if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
        if (!Number.isFinite(num) || num < 0) return '';
        const mins = num > 1440 ? Math.round(num / 60) : Math.round(num);   // >1440 当"当天秒数"，否则当分钟数
        const m = mins % 1440;
        return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
      }
      const s = String(v).trim().replace(/：/g, ':');
      const m = s.match(/^(\d{1,2}):(\d{1,2})/);
      if (!m) return '';
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 47 || mi > 59) return '';
      return String(h % 24).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
    },

    /** 游戏时钟的 'HH:MM'（没有时钟数据时返回 ''） */
    clockText() {
      const c = Transit.data && Transit.data.clock;
      if (!c) return '';
      const t = Transit.fmtClock(c.time);
      if (t) return t;
      const mins = Math.round((Number(c.minutes) || 0) % 1440);
      return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
    },

    /** 线路是不是被"一键暂停运营"了（服务端 linePublic().service.paused；暂停时 noServiceNow 一定为 true） */
    linePaused(line) {
      return !!(line && line.service && line.service.paused);
    },

    /**
     * 这条线路的发车班次数组（服务端 runs / departures；没有就是空数组）；
     * 每个元素是 { index, departure, vehicleId, pinnedVehicleId, assignmentMissed, … }。
     */
    lineRuns(line) {
      if (!line) return [];
      const raw = line.runs || line.runsToday || line.departures;
      return Array.isArray(raw) ? raw.filter(Boolean) : [];
    },

    /** 一班车的发车时刻（'HH:MM' 或对象里各种可能的字段名） */
    runTime(run) {
      if (run == null) return '';
      if (typeof run === 'string' || typeof run === 'number') return Transit.fmtClock(run);
      for (const k of ['scheduledDeparture', 'departureTime', 'departure', 'departAt', 'depart', 'startTime', 'time', 'at']) {
        const t = Transit.fmtClock(run[k]);
        if (t) return t;
      }
      return '';
    },

    /** 线路的班次摘要（面板列表 / 线路管理器共用）：班次类型 + 下一班 + 今日班次数 */
    lineScheduleSummary(line) {
      if (!line) return '—';
      const mgr = window.G.LineMgr;
      let base = (mgr && typeof mgr.scheduleText === 'function') ? String(mgr.scheduleText(line) || '') : '';
      const runs = Transit.lineRuns(line);
      if (!base) {
        base = runs.length ? `定班车 · ${runs.length} 班/日` : '还没配班次';
      } else if (runs.length && !/班\/日/.test(base)) {
        base += ` · ${runs.length} 班/日`;
      }
      const next = Transit.nextDepartureText(line);
      return next ? `${base} · 下一班 ${next}` : base;
    },

    /** 线路的下一班发车（服务端 runs 优先；其次 line.schedule.nextDepartures；最后才按老字段推） */
    nextDepartureText(line) {
      if (!line) return '';
      const clock = Transit.clockText();
      const times = Transit.lineRuns(line).map((r) => Transit.runTime(r)).filter(Boolean).sort();
      if (times.length) {
        const next = clock ? times.find((t) => t >= clock) : times[0];
        return next || times[0];
      }
      // 服务端 scheduleInfo 已经算好了"接下来的几班"（HH:MM），直接用权威值
      const sched = (line.schedule && typeof line.schedule === 'object') ? line.schedule : null;
      const planned = (sched && Array.isArray(sched.nextDepartures) ? sched.nextDepartures : [])
        .map((t) => Transit.fmtClock(t)).filter(Boolean);
      if (planned.length) {
        const next = clock ? planned.find((t) => t >= clock) : planned[0];
        return next || planned[0];
      }
      // 没有 runs：先用线路自己的字段推，别依赖线路管理器有没有加载
      const timetable = (Array.isArray(line.timetable)
        ? line.timetable.map((t) => Transit.fmtClock(t))
        : String(line.timetable || '').split(/[^0-9:：]+/).map((t) => Transit.fmtClock(t)))
        .filter(Boolean).sort();
      if (timetable.length) {
        const next = clock ? timetable.find((t) => t >= clock) : timetable[0];
        return next || timetable[0];
      }
      const headway = Number(line.headwaySeconds) || 0;
      const first = Transit.fmtClock(line.firstDeparture);
      const last = Transit.fmtClock(line.lastDeparture);
      if (!headway || !first || !last || !clock) return '';
      const toMin = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
      const firstM = toMin(first);
      let lastM = toMin(last);
      if (lastM < firstM) lastM += 1440;               // 末班过了午夜
      const nowM = toMin(clock);
      const now = nowM < firstM ? nowM + 1440 : nowM;  // 现在早于首班：算今天的首班
      if (now > lastM) return first;                   // 已经收班：显示明天的首班
      const step = Math.max(1, Math.round(headway / 60));
      const m = (firstM + Math.ceil((now - firstM) / step) * step) % 1440;
      return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    },

    /** 这辆车下一站叫什么（服务端 nextStop 优先，其次按线路里程与方向推） */
    nextStopOf(t, line) {
      if (!t) return '—';
      const ns = t.nextStop != null ? t.nextStop : (t.nextStopName != null ? t.nextStopName : null);
      if (ns != null) {
        if (typeof ns === 'object') {
          const nm = ns.name || ns.stationName || ns.title;
          if (nm) return String(nm);
          const sid = ns.stationId != null ? ns.stationId : (ns.id != null ? ns.id : ns.index);
          if (sid != null) {
            const st = Transit.stationById(sid);
            return st ? st.name : `#${sid}`;
          }
        } else if (String(ns)) {
          return String(ns);
        }
      }
      const l = line || Transit.lineById(t.lineId);
      if (!l) return '未指派';
      return Transit.nextStopName(Object.assign({}, t, { lineId: l.id }));
    },

    /** 到下一站的预计秒数（服务端 etaSeconds；认几种常见别名） */
    etaSecondsOf(t) {
      if (!t) return null;
      for (const k of ['etaSeconds', 'etaSec', 'nextStopEtaSeconds', 'eta']) {
        const n = Number(t[k]);
        if (Number.isFinite(n) && n >= 0) return Math.round(n);
      }
      return null;
    },

    /**
     * 班次偏差（分钟，正数 = 晚点，负数 = 早点）。服务端字段口径可能不同，按这个顺序认：
     *   scheduleLagMinutes / lagMinutes / lateMinutes  → 分钟
     *   scheduleLagSeconds / lagSeconds / lateSeconds  → 秒
     *   scheduleLag / lag                              → 看 Transit.scheduleLagUnit（默认 'auto'：≥60 当秒，否则当分）
     * 想固定口径就设 Transit.scheduleLagUnit = 's' | 'm'。
     */
    scheduleLagMinutes(t) {
      if (!t) return null;
      const pick = (...keys) => {
        for (const k of keys) {
          const n = Number(t[k]);
          if (t[k] != null && t[k] !== '' && Number.isFinite(n)) return n;
        }
        return null;
      };
      const mins = pick('scheduleLagMinutes', 'lagMinutes', 'lateMinutes');
      if (mins != null) return mins;
      const secs = pick('scheduleLagSeconds', 'lagSeconds', 'lateSeconds');
      if (secs != null) return secs / 60;
      const raw = pick('scheduleLag', 'lag');
      if (raw == null) return null;
      const unit = Transit.scheduleLagUnit || 'auto';
      if (unit === 's') return raw / 60;
      if (unit === 'm') return raw;
      return Math.abs(raw) >= 60 ? raw / 60 : raw;   // auto：数值很大时更可能是秒（晚点 3 分 = 180 秒）
    },

    /** 班次偏差说成人话：准点 / 晚点 3 分 / 早点 1.5 分（认不出就是 '—'） */
    scheduleLagText(minutes) {
      const m = Number(minutes);
      if (minutes == null || !Number.isFinite(m)) return '—';
      const abs = Math.abs(m);
      if (abs < 0.5) return '准点';
      const text = abs < 10 ? String(Math.round(abs * 10) / 10) + ' 分' : Math.round(abs) + ' 分';
      return (m > 0 ? '晚点 ' : '早点 ') + text;
    },

    /**
     * 车辆列表里那一小格"班次 / 准点"（晚点红字）。传 vehicleRunInfo() 的结果进来，
     * 免得为了一行字再算一遍（列表最多 80 行）。
     */
    scheduleCellHtml(info) {
      const run = info || {};
      if (run.noService) return '<span class="tp-lag">现在没有班次</span>';
      const lag = `<span class="tp-lag${run.late ? ' late' : ''}">${util.esc(run.lagText || '—')}</span>`;
      return run.departure ? `${util.esc(run.departure)} 发车 · ${lag}` : lag;
    },

    _bindPopup() {
      if (Transit._popupBound) return;
      Transit._popupBound = true;
      document.addEventListener('click', (ev) => {
        const btn = ev.target.closest && ev.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        const id = Number(btn.dataset.id);
        if (act === 'rename-station') Transit.renameStation(Transit.stationById(id));
        else if (act === 'save-station') Transit.saveStationForm(btn.closest('.st-editor'), Transit.stationById(id));
        else if (act === 'delete-station') Transit.deleteStation(Transit.stationById(id));
        else if (act === 'move-station') Transit.moveStationTo(Transit.stationById(id));
        else if (act === 'edit-station') Transit.editStation(Transit.stationById(id));
        else if (act === 'line-remove-stop') {
          const line = Transit.lineById(id);
          const st = Transit.stationById(btn.dataset.station);
          if (line && st) Transit.removeStationFromLine(line, st);
        } else if (act === 'line-color') {
          Transit.setLineColor(Transit.lineById(id), btn.dataset.color);
        } else if (act === 'line-color-apply') {
          const box = btn.closest('.tp-colors');
          const input = box && box.querySelector ? box.querySelector('.tp-color-hex') : null;
          Transit.setLineColor(Transit.lineById(id), input ? input.value : '');
        } else if (act === 'goto-station') {
          const st = Transit.stationById(id);
          if (st) Render.map.setView([st.lat, st.lon], Math.max(17, Render.map.getZoom()));
        } else if (act === 'open-station-panel') {
          // 车站气泡里的「🧰 打开」：打开**交通公司面板的「车站」分区**并选中这一站 ——
          // 站点管理器（覆盖人数 / 分线路候车 / 接入线路 / 改名 / 删除）就在那个 tab 的右侧详情里。
          // openPanelFor 保证：面板没开就打开、在别的分区就切过去、已经在同一分区就只换选中项
          //（不整块重画、不抢左侧列表的滚动位置，也不碰别的面板）。
          Transit.openPanelFor('station', id);
        } else if (act === 'follow-train') {
          // 「定位」：没指派线路（或没有实时位置）时**不动地图**，只把中文原因说清楚
          const t = (Transit.data.trains || []).find((x) => x.id === id);
          const pos = Transit.vehiclePosInfo(t || Transit.vehicleById(id), t);
          if (!pos.ok) { util.toast(pos.reason, 'warn', 3500); return; }
          Render.map.setView(pos.at, Math.max(16, Render.map.getZoom()));
        } else if (act === 'open-vehicle-panel') {
          // 车辆气泡里的「🧰 打开」：打开**交通公司面板的「车辆」分区**并选中这辆车，
          // 右侧那块车辆管理器里接着改（指派线路 / 改名 / 撤下线路 / 删除 / 停靠站序列与客流）。
          // 同样不是独立窗口，也不抢列表滚动位置（见 openPanelFor 的规矩）。
          Transit.openPanelFor('vehicle', id);
        } else if (act === 'unassign-train') {
          // 「撤下线路」：和线路管理器里的「－ 撤下勾选车辆」是同一条路径（vehicle.update lineId=null）
          const v = (Transit.data.vehicles || []).find((x) => x.id === id);
          if (!v) { util.toast('找不到这辆车（可能已经被删掉了）', 'warn', 3000); return; }
          if (!v.lineId) { util.toast('这辆车本来就是闲置的', 'info', 2500); return; }
          Transit.assignVehicle(v, null);   // 内部会发提示并在数据回来后刷新面板
        } else if (act === 'vehicle-detail') {
          Transit.openVehicleDetail(id);
        } else if (act === 'delete-vehicle') {
          // 气泡里的「🗑 删除」：和车辆管理器里的删除同一条路径（Transit.sellVehicle → vehicle.delete）。
          // 谁的车都能删，只有元素锁才拦（服务端就是这么放的）。
          const v = Transit.vehicleById(id) || Transit.liveVehicle(id);
          if (v) Transit.sellVehicle(v);
        } else if (act === 'sell-train') {
          const v = (Transit.data.vehicles || []).find((x) => x.id === id);
          if (v) Transit.sellVehicle(v);
        }
      });
    },

    /* ------------------------------ 车站属性编辑（地图弹窗 + 面板共用同一套） ------------------------------ */
    /** 车站类型表：优先用服务端下发的，没有就退回同名默认表 */
    stationKinds() {
      const t = Transit.stationKindsTable || (Transit.config && Transit.config.stationKinds);
      if (t && typeof t === 'object' && Object.keys(t).length) return t;
      return STATION_KIND_FALLBACK;
    },

    kindName(kind) {
      const t = Transit.stationKinds();
      return (t[kind] && t[kind].name) || MODE_LABEL[kind] || kind;
    },

    /** 向服务端要一次站点类型表（transit 的 kinds 操作）；只问一次，失败就静默用兜底表 */
    ensureStationKinds(force) {
      if (Transit._kindFetch) return;
      if (!force && Transit.stationKindsTable) return;
      if (!Net || !Net.connected) return;
      Transit._kindFetch = true;
      Transit.op({ k: 'kinds' })
        .then((res) => {
          const r = (res && res.result) || {};
          if (r.stationKinds) Transit.stationKindsTable = r.stationKinds;
          // 车型表也从服务端来：面板上的「造车」芯片跟服务器保持一致（离线时用本地兜底表）
          if (r.kinds && Object.keys(r.kinds).length) Transit.vehicleKindsTable = r.kinds;
          Transit.renderPanelSoon();
          Transit.refreshStationPopup();
        })
        .catch(() => { /* 用兜底类型表继续干活 */ })
        .finally(() => { Transit._kindFetch = false; });
    },

    /** 等车人数（服务端 stationPublic 的 waiting；拿不到就当 0） */
    stationWaiting(station) {
      const w = station && station.waiting;
      return Number.isFinite(Number(w)) ? Math.max(0, Math.round(Number(w))) : 0;
    },

    /** 失去耐心走掉的人（服务端 stationPublic 的 lost；拿不到就当 0） */
    stationLost(station) {
      const l = station && station.lost;
      return Number.isFinite(Number(l)) ? Math.max(0, Math.round(Number(l))) : 0;
    },

    /**
     * 这个站点有没有"站台长度"。
     * 公交站直接停路边，服务端可能给 platformM=0，也可能给 hasPlatform:false / noPlatform:true，
     * 所以三种信号都认；都没有时按类型判断（公交站没有站台长度）。
     */
    stationHasPlatform(station) {
      if (!station) return true;
      if (PLATFORMLESS_KINDS[station.kind]) return false;
      if (station.hasPlatform === false || station.noPlatform === true) return false;
      if (Number(station.platformM) === 0) return false;   // 服务端用 0 表示"没有站台长度"
      return true;
    },

    /** 按站点类型判断有没有站台（用户可能刚在下拉框里把类型改成公交站） */
    kindHasPlatform(kind) {
      if (!kind) return true;
      if (PLATFORMLESS_KINDS[kind]) return false;
      const info = Transit.stationKinds()[kind];
      if (info && (info.hasPlatform === false || info.noPlatform === true)) return false;
      return true;
    },

    /**
     * 站台上**按线路**分好的候车情况（服务端 stationPublic / stationWaiting 的 waitingByLine）。
     * 返回 [{ lineId, name, color, waiting, lost, waitSeconds, dest, fallback }]：
     *   · 服务端已经按"能拉走他的那条线"把人分好桶了，这里只做展示用的合并与排序；
     *   · lineId 为 null 的那一行是「未指定线路」（兜底桶）：目的地没有任何线路能到的、
     *     或者那条线路已经被删掉的乘客 —— 他们没有专属线路，哪条线来车都能上；
     *   · 线路名与颜色优先用服务端给的（它按线路表解析），拿不到就用本地线路表兜底；
     *   · dest = 这条线路的候车乘客**按目的站分组**的人数（见 destMixRows；服务端没给就是 available:false）；
     *   · waiting 是显示用的整数、waitingRaw 是服务端原值（可能带小数，只进 title）。
     *   · 服务端没给明细（老服务端 / 模拟帧里不带车站明细）时返回空数组，界面会退回车站合计。
     */
    stationLineWait(station) {
      const rows = (station && station.waitingByLine) || [];
      if (!Array.isArray(rows) || !rows.length) return [];
      const lines = (Transit.data && Transit.data.lines) || [];
      const out = [];
      for (const r of rows) {
        if (!r) continue;
        const lineId = r.lineId == null ? null : Number(r.lineId);
        const local = lineId == null ? null : (lines.find((l) => Number(l && l.id) === lineId) || null);
        const color = LINE_COLOR_RE.test(String(r.color || '')) ? String(r.color)
          : (local && LINE_COLOR_RE.test(String(local.color || '')) ? String(local.color) : LINE_COLOR_DEFAULT);
        out.push({
          lineId,
          fallback: lineId == null,
          name: String(r.name || (local && local.name) || (lineId == null ? '未指定线路' : `线路 #${lineId}`)),
          color,
          // waiting 是**显示用**的整数（界面上一律整数）；waitingRaw 是服务端原值，
          // 只在 title 里当"精确值"露一面（乘客按游戏秒累积，可能是 3.4）
          waitingRaw: Math.max(0, Number(r.waiting) || 0),
          waiting: Math.max(0, Math.round(Number(r.waiting) || 0)),
          lost: Math.max(0, Math.round(Number(r.lost) || 0)),
          waitSeconds: Number.isFinite(Number(r.waitSeconds)) ? Math.max(0, Math.round(Number(r.waitSeconds))) : 0,
          dest: Transit.destMixRows(r.destMix),
        });
      }
      // 等车人多的线路排前面；「未指定线路」这种兜底行排最后（它不是某条具体的线）
      out.sort((a, b) => (b.waiting - a.waiting) || ((a.fallback ? 1 : 0) - (b.fallback ? 1 : 0)) || ((a.lineId || 0) - (b.lineId || 0)));
      return out;
    },

    /**
     * 候车去向（"这些人在等哪条线、要去哪一站"）的原始明细 → 展示用的行。
     *
     * 服务端契约（见 server/transit.js 的 stationWaiting）：
     *   · stationPublic().waitingByLine[].destMix = [{ stationId, name, people }]
     *     —— **这一条线路**的候车乘客按目的站分组的人数；
     *   · stationPublic().waitingByDest = [{ stationId, name, people, lines: [lineId|null] }]
     *     —— 跨线路汇总的同一份口径（上面那些行合起来），并给出"这些人在等哪几条线"。
     * 返回 { available, rows: [{ stationId, name, people, lineId, lines }], total }：
     *   available=false 表示这份快照里**没有**这个字段（服务端只在真有人在等 / 有人放弃过时才下发，
     *   见 snapshot() 里那句 `...(wait.waiting > 0 || wait.lost > 0 ? stationWaiting() : null)`）。
     *   ⚠ 所以 available=false **不等于**"服务端不支持"：没人等车时它本来就不带这个字段 ——
     *   界面必须用车站自己的等车人数去分辨这两种情况（见 waitingDetailMissing / 站点管理器里的空态判断），
     *   绝不能一律写成「暂无明细」。
     * 现在只用来算**目的站个数**（合计那一行）与兜底合成（见 destMixFromLines）—— 明细本身只画一份。
     */
    destMixRows(raw) {
      if (!Array.isArray(raw)) return { available: false, rows: [], total: 0 };
      const out = [];
      let total = 0;
      for (const d of raw) {
        if (!d) continue;
        const people = Number(d.people);
        if (!Number.isFinite(people) || people <= 0) continue;     // 0 人的分组不画
        const sid = d.stationId == null ? null : Number(d.stationId);
        const local = sid == null ? null : Transit.stationById(sid);
        // 跨线路汇总那一路（waitingByDest）给的是 lines: [lineId]（可能几条线，兜底桶是 null）；
        // 分线路那一路（destMix）自己不带 lineId（外层行已经说明了是哪条线）。两个名字都认。
        const lineIds = Array.isArray(d.lines)
          ? d.lines.map((x) => (x == null ? null : Number(x))).filter((x) => x == null || Number.isFinite(x))
          : [];
        const one = d.lineId == null ? null : Number(d.lineId);
        const lineId = Number.isFinite(one) && one ? one : (lineIds.find((x) => x) || null);
        out.push({
          stationId: sid,
          name: String(d.name || (local && local.name) || (sid == null ? '去向未知' : `#${sid}`)),
          people: Math.round(people * 10) / 10,
          lineId,
          lines: lineIds.length ? lineIds : (lineId ? [lineId] : []),
        });
        total += people;
      }
      out.sort((a, b) => (b.people - a.people) || String(a.name).localeCompare(String(b.name), 'zh'));
      return { available: true, rows: out, total: Math.round(total * 10) / 10 };
    },

    /** 跨线路汇总的候车去向（服务端 stationPublic().waitingByDest；这份快照没带就是 available:false） */
    stationWaitingByDest(station) {
      return Transit.destMixRows(station && station.waitingByDest);
    },

    /**
     * 把**分线路**的候车明细（waitingByLine[].destMix）自己合成一份跨线路汇总。
     * 用途只有两个：
     *   1) 服务端版本较老（只带 waitingByLine[].destMix，没有 waitingByDest）时，
     *      合计那一行的「N 个目的站」照样算得出来；
     *   2) 汇总那一路因为别的原因为空、但分线路那一路有数据时兜住。
     * （跨线路汇总**不再单独画一块**：去向明细只在分线路候车那几行里出现一次。）
     * 口径与 server 的 waitingByDest 一致：按目的站合并、人数相加、带上"这些人在等哪几条线"。
     * 一条明细都没有时返回 available:false（绝不拿等车合计数编一个分布）。
     */
    destMixFromLines(rows) {
      const map = new Map();
      for (const r of rows || []) {
        const mix = r && r.dest;
        if (!mix || !mix.available) continue;
        for (const d of mix.rows) {
          const key = d.stationId == null ? 'null' : String(d.stationId);
          let cur = map.get(key);
          if (!cur) { cur = { stationId: d.stationId, name: d.name, people: 0, lineId: null, lines: [] }; map.set(key, cur); }
          cur.people += d.people;
          for (const lid of (d.lines && d.lines.length ? d.lines : (r.lineId == null ? [] : [r.lineId]))) {
            if (!cur.lines.includes(lid)) cur.lines.push(lid);
          }
          if (cur.lineId == null) cur.lineId = cur.lines.find((x) => x) || null;
        }
      }
      if (!map.size) return { available: false, rows: [], total: 0 };
      const out = [...map.values()].map((d) => Object.assign({}, d, { people: Math.round(d.people * 10) / 10 }));
      out.sort((a, b) => (b.people - a.people) || String(a.name).localeCompare(String(b.name), 'zh'));
      const total = out.reduce((n, d) => n + d.people, 0);
      return { available: true, rows: out, total: Math.round(total * 10) / 10 };
    },

    /**
     * 这个车站"有人在等、但手上这份快照没带去向明细"吗？
     * 站点管理器靠它在渲染时补拉一次整份快照（ensureLiveStation(true)），而不是显示一句
     * 含糊的「暂无明细」让玩家以为功能坏了。
     */
    waitingDetailMissing(station) {
      if (!station) return false;
      const waiters = Transit.stationWaiting(station) > 0
        || Transit.stationLineWait(station).some((r) => r.waiting > 0);
      if (!waiters) return false;
      if (Array.isArray(station.waitingByDest) && station.waitingByDest.length) return false;
      return !Transit.stationLineWait(station).some((r) => r.dest && r.dest.rows.length);
    },

    /**
     * 候车人数怎么显示：**一律整数**。服务端的人数带 1 位小数（乘客按游戏秒累积，见
     * server/transit.js 的 round1），界面上绝不能出现「3.4 人」（同伴的服务端取整修好之前，
     * 客户端自己也兜住）。精确值只走 peopleExactNote → title 提示，绝不进正文。
     */
    peopleText(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return '0 人';
      return `${util.fmt(Math.round(v))} 人`;
    },

    /** 只要数字、不要单位（紧凑的一行内联明细里用）：整数字符串 */
    peopleInt(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return '0';
      return util.fmt(Math.round(v));
    },

    /**
     * 服务端给的是小数时那句"精确值"：`（精确 3.4 人）`；本来就是整数时给空串。
     * 只往 title 里塞，正文里永远看不到小数。
     */
    peopleExactNote(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return '';
      const r = Math.round(v);
      if (Math.abs(v - r) < 0.05) return '';      // 显示值就是精确值：不用再提示
      return `（精确 ${Math.round(v * 10) / 10} 人）`;
    },

    /** 老名字（等价于 peopleText，同样是整数）—— 留给外部调用点，别再写小数 */
    destPeopleText(n) { return Transit.peopleText(n); },

    /**
     * 一条候车队伍的**去向** → 一行内联文本（分线路候车那一行里用）：
     *   `西单 3 · 王府井 2 · 国贸 1`
     * 返回 { available, text, title }：
     *   · 人数一律整数（peopleInt）；服务端给的小数只在 title 里作为"精确值"出现；
     *   · text 只放得下一行（装不下由 CSS 省略号收尾），完整清单在 title 里（一个目的站一行）；
     *   · available=false 表示**这份快照没带**这条队伍的去向明细（不是"没人要去"）——
     *     界面这时要说「候车去向正在刷新…」，绝不拿等车合计数编一个假的分布。
     */
    destInline(mix) {
      const rows = (mix && mix.available) ? mix.rows : [];
      if (!rows.length) return { available: false, text: '', title: '' };
      return {
        available: true,
        text: rows.map((r) => `${r.name} ${Transit.peopleInt(r.people)}`).join(' · '),
        title: rows.map((r) => `${r.name}：${Transit.peopleText(r.people)}${Transit.peopleExactNote(r.people)}`).join('\n'),
      };
    },

    /** 候车最久的那批人等了多久（服务端 stationPublic 的 waitingByCompany / waitingByLine） */
    stationMaxWait(station) {
      let max = -1;
      const note = (waitSeconds, waiting) => {
        const w = Number(waitSeconds);
        const n = Number(waiting);
        if (!Number.isFinite(w)) return;
        if (Number.isFinite(n) && n <= 0) return;   // 已经没人等了，那批人的等待时间不算数
        if (w > max) max = w;
      };
      for (const e of (station && station.waitingByCompany) || []) note(e && e.waitSeconds, e && e.waiting);
      // 分线路的明细更细：某个站台上只有 2 号线有人在等时，合计那一行可能已经归零，这里照样量得出来
      for (const r of Transit.stationLineWait(station)) note(r.waitSeconds, r.waiting);
      return max < 0 ? null : Math.round(max);
    },

    /** 秒数说成人话（站点管理器里的"最长等待"用） */
    fmtSeconds(sec) {
      const s = Math.max(0, Math.round(Number(sec) || 0));
      if (s < 60) return s + ' 秒';
      const m = Math.floor(s / 60);
      if (m < 60) return (s % 60) ? `${m} 分 ${s % 60} 秒` : `${m} 分钟`;
      return Math.floor(m / 60) + ' 时 ' + String(m % 60).padStart(2, '0') + ' 分';
    },

    /**
     * 等车人数的短期趋势：每 10 秒取一个基准值，返回 { waiting, delta, dir, seconds }。
     * delta = 当前人数 - 这个窗口开始时的基准人数，玩家据此看出队伍在涨还是在消化（↑/↓）。
     */
    waitingTrend(station) {
      const waiting = Transit.stationWaiting(station);
      const id = station && station.id != null ? Number(station.id) : null;
      const now = Date.now();
      if (id == null) return { waiting, delta: 0, dir: 'flat', seconds: 0 };
      Transit._waitTrack = Transit._waitTrack || new Map();
      let s = Transit._waitTrack.get(id);
      if (!s) {
        // 第一次看到这个站：基准就是当前值，还不能给趋势（显示 → 0）
        s = { base: waiting, baseAt: now, v: waiting, at: now };
        Transit._waitTrack.set(id, s);
        // 看过的车站不会太多，但保险起见丢掉最老的记录
        if (Transit._waitTrack.size > 400) {
          const oldest = Transit._waitTrack.keys().next();
          if (!oldest.done) Transit._waitTrack.delete(oldest.value);
        }
      } else if (now - s.at >= WAIT_TREND_WINDOW_MS) {
        // 开一个新窗口：上一窗口结束时看到的人数就是新基准
        s.base = s.v;
        s.baseAt = s.at;
        s.at = now;
      }
      s.v = waiting;   // 本窗口内看到的最新人数
      const delta = Math.round(s.v - s.base);
      return {
        waiting,
        delta,
        dir: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat'),
        seconds: Math.max(1, Math.round((now - s.baseAt) / 1000)),
      };
    },

    /** 等车趋势的显示文本：等车 12 ↑ +4（10 秒内） */
    waitingTrendText(station) {
      const tr = Transit.waitingTrend(station);
      const arrow = tr.dir === 'up' ? '↑ +' : (tr.dir === 'down' ? '↓ ' : '→ ');
      const num = tr.dir === 'flat' ? '0' : util.fmt(tr.delta);
      return `${arrow}${num}`;
    },

    /* --------------------------- 车站 ↔ 线路 --------------------------- */

    /** 我（当前公司）名下的公司 id 集合 */
    myCompanyIdSet() {
      const ids = new Set();
      for (const c of Transit.myCompanies()) ids.add(c.id);
      const cid = Transit.companyId();
      if (cid != null) ids.add(cid);
      return ids;
    },

    /** 服务这条车站的线路：我的各家公司的线路（一条线就是一串 stops，车站可能同时属于好几条） */
    stationLines(station, all) {
      if (!station) return [];
      const id = Number(station.id);
      const ids = Transit.myCompanyIdSet();
      const out = [];
      for (const line of (Transit.data && Transit.data.lines) || []) {
        if (!Array.isArray(line.stops) || !line.stops.includes(id)) continue;
        const mine = ids.has(line.companyId) || line.owner === Editor.myId;
        if (!all && !mine) continue;
        out.push(Object.assign({}, line, { _mine: mine }));
      }
      out.sort((a, b) => (b._mine ? 1 : 0) - (a._mine ? 1 : 0) || a.id - b.id);
      return out;
    },

    /**
     * 这条线路现在轮得到我改吗？
     *
     * **语义变了**（协作编辑，与 server/transit.js 对齐）：以前问的是"这条线是不是我公司建的"，
     * 现在**谁建的都能改** —— 服务端的 updateLine / deleteLine 只挡元素锁，一眼都不看 owner。
     * linemgr.js 的 canEdit() 也拿它当唯一判断（线路的配色 / 模式 / 站点顺序 / 班次 / 车队全靠它），
     * 所以这一个函数就是"线路编辑"的总闸：现在唯一改不动的情况只剩**这条线正被别人锁着**
     * （元素锁，服务端同样会拒；那边还会弹同一句中文原因 → 见 refreshLockSurfaces / reinforceLineReadOnly）。
     *
     * 想判断"是不是我公司的线路"（**只是筛选口径，不是权限**）用 isMyCompanyAsset('lines', line)。
     */
    isMyLine(line) {
      if (!line) return false;
      return !Transit.elemLockBy('line', line.id);
    },

    /** 把这一站从某条线路上摘掉（站点管理器里的「从该线路移除」） */
    removeStationFromLine(line, station) {
      if (!line || !station) return;
      const index = (line.stops || []).indexOf(Number(station.id));
      if (index < 0) { util.toast('这条线上没有这一站', 'warn'); return; }
      if (!window.confirm(`把「${station.name}」从线路「${line.name}」里移除？`)) return;
      Transit.removeStop(line, index);
    },

    /* ------------------------- 站点管理器（选中站点时显示） ------------------------- */

    /** 线路的类型文字（线路行 / 站点管理器共用） */
    lineKindName(kind) { return MODE_LABEL[kind] || Transit.kindName(kind) || kind || '未知'; },

    /**
     * 选中一个车站：地图上高亮它（+ 可选的小气泡）。
     *
     * 默认**不碰交通面板**（opt.panel 不给就是"点地图"那条路）：分区不切、面板不打开/不展开、
     * DOM 不重建 —— 一次点击不抢焦点也不会把列表滚回顶上。
     * 只有玩家显式按了「🗂 总面板里打开」这类按钮才传 { panel: true }，那就走 openPanelFor。
     * 站点管理器的完整内容在交通面板的「车站」分区里（左侧列表点一行 = 打开它）。
     */
    selectStation(station, options) {
      const st = typeof station === 'object' && station ? station : Transit.stationById(station);
      if (!st) return null;
      const opt = options || {};
      Transit.selectedStation = Number(st.id);
      if (opt.panel) {
        Transit.openPanelFor('station', st.id);      // 显式要求才动面板
      } else if (!Transit.panelOpen) {
        // 面板没开：把"选中"记下来，玩家随后打开面板时看到的就是这一站（面板开着就完全不动它）
        Transit.selected = { type: 'station', id: Number(st.id) };
      }
      // 地图上只留一个小气泡（名字 + 定位 + 删除）
      if (opt.popup) Transit.openStationPopup(st, opt.latlng);
      if (Render.overlay) Render.overlay.redraw();
      Transit.ensureLiveStation();
      return st;
    },

    /**
     * 显式"到面板里看它"：打开**交通公司面板**、切到对应分区、选中它（折叠着就展开）。
     *
     * 谁调它：气泡里的「🧰 打开」按钮、`openStationMgr/openVehicleMgr/openLineMgr` 这几个薄壳、
     * 以及「🗂 总面板里打开」这类显式按钮。**地图上的一次普通点击永远不走这里**（见 selectOnMap 的契约）。
     *
     * 界面规矩（用户明确要求，别改）：
     *   · 不碰别的面板（右侧检查器 / 左侧工具选项一个字节都不动）；
     *   · **已经在同一个分区**时就只更新选中项与右侧详情，**不整块重画**（列表的滚动位置、筛选框、
     *     正在输入的焦点都留着）；只有"面板没开"或"在别的分区"时才走打开 / 切分区那条路。
     */
    openPanelFor(type, id) {
      const need = type === 'station' ? 'stations' : (type === 'line' ? 'lines' : 'vehicles');
      const num = Number(id);
      const valid = Number.isFinite(num) && num > 0;
      const sameSection = Transit.panelOpen && Transit.section() === need;
      const alreadyPicked = !!(Transit.selected && Transit.selected.type === type
        && Number(Transit.selected.id) === num);
      if (valid) {
        if (type === 'station') { Transit.selected = { type: 'station', id: num }; Transit.selectedStation = num; Transit.ensureLiveStation(); }
        else if (type === 'line') { Transit.selected = { type: 'line', id: num }; Transit.selectedLine = num; }
        else if (type === 'vehicle') { Transit.selected = { type: 'vehicle', id: num }; Transit.selectedVehicle = num; }
      }
      Transit.panelTab = need;
      if (window.G.UI && typeof window.G.UI.isPanelCollapsed === 'function' && window.G.UI.isPanelCollapsed('transit')) {
        window.G.UI.setPanelCollapsed('transit', false);
      }
      if (!Transit.panelOpen) { Transit.openPanel(need); return Transit; }
      if (!sameSection) { Transit.renderPanel(); return Transit; }   // 换分区：列表本来就要换一份
      // 已经在同一个分区，而且看的就是它：一个字节都不动（点两次不会闪、也不会抢滚动位置）
      if (alreadyPicked) return Transit;
      // 已经在同一个分区、只是换一个对象：只刷新右侧详情 + 列表高亮（renderListOnly 会保住滚动位置）
      Transit.renderDetailOnly();
      if (!Transit._listHover) Transit.renderListOnly();
      if (Render.overlay) Render.overlay.redraw();
      return Transit;
    },

    /** 「编辑」按钮：把表单里的名称输入框聚焦起来（公共·导入的车站一样能改；只有被别人锁着时才不让动） */
    editStation(station) {
      const st = typeof station === 'object' && station ? station : Transit.stationById(station);
      if (!st) return;
      const boxes = util.$$('.st-editor[data-st-id="' + Number(st.id) + '"]');
      const box = boxes.find((b) => b.querySelector && b.querySelector('.st-name')) || boxes[0] || null;
      if (!box) { util.toast('没有找到可编辑的表单', 'warn'); return; }
      if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
      const input = box.querySelector('.st-name');
      if (!input) return;
      const by = Transit.elemLockBy('station', st.id);
      if (by) { util.toast(lockBusyText(by), 'warn', 5000); return; }
      input.focus();
      if (typeof input.select === 'function') input.select();
    },

    /**
     * 站点管理器的**内容**（就是交通面板「车站」分区右侧那一块；没有第二个入口、没有老款排版）。
     * 一块一件事，每块的头部自带这个块的动作按钮（和线路管理器的 .lm-sec 同一个观感）：
     *   🚏 基本信息（车站 / 类型 / 来源 / 接入路网）+ 🗺 定位 / 🗑 删除
     *      （改名 / 换类型 / 站台 / 吸引半径在下面那块「车站属性」表单里，挪位置用地图 ——
     *        所以这里不再有「📍 挪动」「✏ 编辑」两个和表单/地图重一份的按钮）
     *   覆盖与客流（覆盖人数 / 等车人数 + 10 秒趋势 / 已放弃 / 最长等待）
     *   等车（分线路候车）—— **只有这一处**明细：顶上一行合计（共 12 人等车 · 4 个目的站），
     *     下面一行一条线（色点 + 线路名 + 等车人数右对齐），每条线再带一行这条队伍的去向
     *     （`→ 西单 3 · 王府井 2`，整数人数，全量清单与精确值在 title 里）。
     *     老版的「等车乘客要去哪里」跨线路汇总块已经删掉（那是同一份信息的第二遍），
     *     目的站个数并进合计那一行。服务端**只在真有人在等**时才下发这份明细，所以"这份快照没带"时
     *     按等车人数如实说（没人等 → 现在没有人在这个车站等车；有人等 → 候车去向正在刷新…并补拉一次）
     *   经过线路（每条线一个「从该线路移除」）
     * 这一段整块重建不会有输入焦点问题（里面没有输入框），所以跟着数据实时刷（refreshStationMgr）；
     * 有输入框的「车站属性（编辑表单）」与「把这一站加进线路」由 stationManagerBlockHtml 画在
     * .st-mgr-body **外面**，实时刷新碰不到它们（不会把正在输入的名字冲掉）。
     *
     * **车站归属**：谁建的都能改名 / 删除 / 挪动（服务端就是这么放的），底图导入的公共车站也不例外；
     * 按钮只在**别人正锁着这个车站**时变灰，并带上服务端那句中文原因。
     */
    stationManagerBodyHtml(station) {
      if (!station) return '';
      const c = station.catchment || {};
      const mine = !!Editor.myId && station.owner === Editor.myId;
      const waiting = Transit.stationWaiting(station);
      const lost = Transit.stationLost(station);
      const trend = Transit.waitingTrend(station);
      const maxWait = Transit.stationMaxWait(station);
      const weighted = (c.weightedPop === undefined || c.weightedPop === null) ? null : Number(c.weightedPop);
      const lines = Transit.stationLines(station);
      const others = Transit.stationLines(station, true).filter((l) => !l._mine);
      const pub = Transit.isPublicStation(station);      // 只是来源标签（底图导入），不是权限
      const trendTxt = trend.dir === 'up' ? `↑ +${util.fmt(trend.delta)}`
        : (trend.dir === 'down' ? `↓ ${util.fmt(trend.delta)}` : '→ 0');
      const owner = ((Transit.data && Transit.data.companies) || []).find((x) => x.id === station.companyId);
      const lockBy = Transit.elemLockBy('station', station.id);
      const lockTitle = lockBy ? lockBusyText(lockBy) : '';

      // 这一块右上角那排动作（和线路管理器里 .lm-actions 的位置一样）：车站谁都能改，只有元素锁能拦。
      // 用户要求只留**定位 + 删除**：改名 / 换类型 / 站台 / 吸引半径都在下面那块「车站属性」表单里
      //（表单本身就是编辑器），挪位置用地图（移动工具 / 拖动）—— 所以「📍 挪动」「✏ 编辑」两个按钮删掉，
      // 不再和表单重一份。
      const actionsHtml = `
        <button class="mini" data-act="goto-station" data-id="${station.id}">🗺 定位</button>
        <button class="mini danger" data-act="delete-station" data-id="${station.id}"${lockBy ? ' disabled' : ''}
          title="${util.esc(lockBy ? lockTitle : '删除这个车站（会从所有线路里移除，可撤销；谁的车站都能删）')}">🗑 删除</button>`;

      let linesHtml = '';
      if (!lines.length) {
        linesHtml = `<div class="empty-hint small">还没有线路经过这个车站：在线路详情里点「＋ 加站」，再点这个车站。</div>`;
      } else {
        for (const l of lines) {
          const color = LINE_COLOR_RE.test(String(l.color || '')) ? l.color : LINE_COLOR_DEFAULT;
          const daily = Number.isFinite(Number(l.dailyTrips)) ? Number(l.dailyTrips) : 0;
          linesHtml += `<div class="st-mgr-line" data-line-id="${l.id}">
            <span class="tp-dot" style="background:${util.esc(color)}"></span>
            <b style="color:${util.esc(color)}">${util.esc(l.name)}</b>
            <span class="tp-tag">${util.esc(Transit.lineKindName(l.kind))}</span>
            <span class="tp-tag">${util.esc(color)}</span>
            <span class="tp-tag">日客流 ${util.fmt(daily)} 人次</span>
            <span class="tp-tag ${l.pathError ? 'warn' : 'ok'}">${l.pathError ? '路径不通' : '正常'}</span>
            <button class="mini danger" data-act="line-remove-stop" data-id="${l.id}" data-station="${station.id}"
              title="把这一站从这条线路上摘掉（线路本身保留）">从该线路移除</button>
          </div>`;
        }
      }
      const othersHtml = others.length
        ? `<div class="tp-note">别家公司的线路也停这一站：${util.esc(others.map((l) => l.name).join('、'))}</div>`
        : '';

      // 站台候车：**只在这一处**画明细。这个站台上等 1 号线的 6 个人和等 2 号线的 4 个人是两支队，
      // 2 号线的车只会把 2 号线那 4 个拉走（服务端按线路分桶记账，见 stationLineWait）。
      // 结构 = 顶上一行合计（共 12 人等车 · 4 个目的站）+ 一行一条线
      //        （色点 + 线路名 + 等车人数右对齐，下一行是这条队伍的去向 `→ 西单 3 · 王府井 2`）。
      // 跨线路汇总那一块**已经删掉**：去向信息只出现一次，合计口径由上面那一行承担
      //（目的站个数还是按跨线路去重算出来，但不再画第二份清单）。
      const perLine = Transit.stationLineWait(station);
      const queued = perLine.filter((r) => r.waiting > 0);      // 真有人排队的线路（0 人的不画空行）
      const queueLineIds = new Set(queued.filter((r) => r.lineId != null).map((r) => Number(r.lineId)));
      const byDestRaw = Transit.stationWaitingByDest(station);
      // 服务端有的版本只带 waitingByLine[].destMix（没有 waitingByDest）：用分线路那份自己合一份，
      // 「N 个目的站」照样算得出来，而不是一句「暂无明细」。
      const byDest = byDestRaw.rows.length ? byDestRaw : Transit.destMixFromLines(perLine);
      // 合计：车站自己的等车人数是权威口径，它因为快照错位归零时退回各线之和
      const totalWait = Math.max(waiting, queued.reduce((n, r) => n + r.waiting, 0));
      // 到底有没有人在等这个站的车：等车合计 / 各线合计 / 手上这份明细，任一说了有就是有。
      // ⚠ 服务端**只在真有人在等（或有人放弃过）时才下发** waitingByDest / waitingByLine ——
      //   所以 available=false 绝不等于"功能坏了"，不能一律写成「暂无明细」（老版就是在这里骗人的）。
      const anyWaiters = totalWait > 0 || byDest.rows.length > 0;
      // 有人在等、但这份快照一条去向明细都没带（明细随整份快照下发，sim 帧不带车站）：补拉一次。
      if (Transit.waitingDetailMissing(station)) Transit.ensureLiveStation(true);
      // 没人排队的线路：一句话带过（「经过线路」那一块有完整清单，这里不再画一排 0 人的空行）
      const idleLines = lines.filter((l) => !queueLineIds.has(Number(l.id)));
      const idleNote = idleLines.length
        ? `<div class="st-wait-zero" title="${util.esc(`这些线路也经过这个车站，现在没人等：${idleLines.map((l) => l.name).join('、')}`)}">`
          + `现在没人等的线路：${util.esc(idleLines.map((l) => l.name).join('、'))}</div>`
        : '';
      const rowsHtml = queued.map((r) => {
        const exact = Transit.peopleExactNote(r.waitingRaw);
        const maxWait = (r.waiting > 0 && r.waitSeconds > 0) ? `，最长等待 ${Transit.fmtSeconds(r.waitSeconds)}` : '';
        const lost = r.lost > 0 ? `，已放弃 ${util.fmt(r.lost)} 人` : '';
        const why = r.fallback
          ? '未指定线路的乘客：目的地没有线路直达、或者原来那条线路已经不在了 —— 哪条线来车都能上'
          : `${r.name}：只坐这条线的人，别的线路的车不会把他们拉走`;
        // 去向：一行内联（整数人数），完整清单与精确值都在 title 里；明细没到就如实说正在刷新
        const inline = Transit.destInline(r.dest);
        const destHtml = inline.available
          ? `<span class="stm-lw-dest" title="${util.esc(inline.title)}">→ ${util.esc(inline.text)}</span>`
          : '<span class="stm-lw-dest pending" title="这条队伍的去向明细还没随整份快照到达，正在补拉">候车去向正在刷新…</span>';
        return `<div class="st-mgr-wait${r.fallback ? ' fallback' : ''}" data-line-id="${r.lineId == null ? '' : r.lineId}"
            title="${util.esc(`${why}。${Transit.peopleText(r.waiting)}在等${exact}${maxWait}${lost}`)}">
          <span class="tp-dot" style="background:${util.esc(r.color)}"></span>
          <b class="stm-lw-name" style="color:${util.esc(r.color)}">${util.esc(r.name)}</b>
          <span class="stm-lw-wait">${util.fmt(r.waiting)} 人</span>
          ${destHtml}
        </div>`;
      }).join('');
      // 一个人都没等 → 整块收成一句话；有人在等 → 一行合计 + 一张分线路的表（明细只出现这一次）
      const waitGroup = !anyWaiters
        ? '<div class="empty-hint small">现在没有人在这个车站等车。</div>'
        : `<div class="st-wait-total">共 <b class="stm-wait-total">${util.fmt(totalWait)}</b> 人等车${byDest.rows.length
          ? ` <span class="st-wait-sep">·</span> <b class="stm-dest-count">${byDest.rows.length}</b> 个目的站` : ''}</div>
        ${queued.length
          ? `<div class="st-mgr-waits">${rowsHtml}</div>`
          : '<div class="empty-hint small">候车去向正在刷新…</div>'}
        ${idleNote}`;

      return `<div class="st-sec">
          <div class="st-sec-head">
            <div class="st-sec-title">🚏 站点管理器 <small>#${station.id}</small></div>
            <div class="st-sec-acts">${actionsHtml}</div>
          </div>
          <div class="tp-row"><span>车站</span><b>${util.esc(station.name)} <small class="stm-id">#${station.id}</small></b></div>
          <div class="tp-row"><span>类型</span><b>${util.esc(Transit.kindName(station.kind))}${owner ? ' · ' + util.esc(owner.name) : ''}</b></div>
          <div class="tp-row"><span>来源</span><b class="stm-source">${pub
            ? `公共·导入${station.osmType ? `（OSM ${util.esc(String(station.osmType))} ${util.esc(String(station.osmId == null ? '' : station.osmId))}）` : ''} <small>底图带的站，只是一条来源标记：和自建站一样能改名 / 挪动 / 删除</small>`
            : (mine ? '自建（我的公司）' : '别家公司的车站（协作编辑：一样能改名 / 挪动 / 删除）')}</b></div>
          <div class="tp-row"><span>接入路网</span><b class="stm-node ${station.nodeId || station.onRail ? 'ok' : 'warn'}">${station.nodeId || station.onRail ? '已接入' : '未接入'}</b></div>
        </div>

        <div class="st-sec">
          <div class="st-sec-head"><div class="st-sec-title">覆盖与客流</div></div>
          <div class="tp-row"><span>覆盖人数</span><b>${util.fmt(c.pop || 0)} 人${weighted === null ? '' : `（等效 ${util.fmt(weighted)}）`} · ${util.fmt(c.jobs || 0)} 岗位</b></div>
          <div class="tp-row"><span>等车人数</span><b><span class="stm-wait">${util.fmt(waiting)}</span> 人
            <span class="stm-trend ${trend.dir === 'up' ? 'warn' : (trend.dir === 'down' ? 'ok' : '')}"
              title="每 10 秒比较一次，看队伍在涨还是在消化">${util.esc(trendTxt)}</span>
            <small class="stm-trend-note">（${trend.seconds} 秒内）</small></b></div>
          <div class="tp-row"><span>已放弃</span><b class="stm-lost">${util.fmt(lost)} 人</b></div>
          <div class="tp-row"><span>最长等待</span><b class="stm-maxwait">${maxWait === null ? '—' : util.esc(Transit.fmtSeconds(maxWait))}</b></div>
        </div>

        <div class="st-sec">
          <div class="st-sec-head"><div class="st-sec-title">等车 <small>分线路候车${anyWaiters
            ? ` · <b class="stm-linewait-count">${queued.length}</b> 支队伍` : ''}</small></div></div>
          ${waitGroup}
        </div>

        <div class="st-sec">
          <div class="st-sec-head"><div class="st-sec-title">经过线路 <b class="stm-linecount">${lines.length}</b> 条</div></div>
          <div class="st-mgr-lines">${linesHtml}</div>
          ${othersHtml}
        </div>`;
    },

    /**
     * 站点管理器外框：交通面板「车站」分区右侧详情就是它（唯一入口）。
     * 结构 = 实时刷新的 .st-mgr-body（基本信息 / 覆盖与客流 / 等车 / 经过线路）
     *        + 静态的两块（车站属性表单 / 把这一站加进线路）—— 表单在 .st-mgr-body 外面，
     *          实时刷新只换 body 里的内容，绝不会把正在输入的名字或光标冲掉。
     * options.compact = true 时不画自己的小标题（默认 false = 连标题一起画）。
     */
    stationManagerBlockHtml(station, options) {
      if (!station) return '';
      const opt = options || {};
      const head = opt.compact ? ''
        : `<div class="st-mgr-title">🚏 站点管理器 <small>#${station.id}</small></div>`;
      return `<div class="tp-block st-mgr" data-st-mgr="${station.id}">
        ${head}
        <div class="st-mgr-body">${Transit.stationManagerBodyHtml(station)}</div>
      </div>`;
    },

    /**
     * 把**整块站点管理器**挂进一个容器：外框（含实时刷新的 body）+ 车站属性表单 + 「把这一站加进线路」。
     * 只有交通面板「车站」分区的详情调它（独立窗口删掉后不再有第二个调用方）。
     * 以后加字段只改这一处（这就是"复用同一个渲染器"的落点）。
     * **会先清空容器**（host.innerHTML = ''），所以调用方别把别的东西挂进同一个容器。
     * options.compact 会一起传给外框（默认 false：两块都带自己的小标题）。
     */
    mountStationManager(host, station, options) {
      if (!host || !station) return null;
      const opt = options || {};
      host.innerHTML = '';
      const wrap = util.el('div', 'st-mgr-wrap');
      wrap.innerHTML = Transit.stationManagerBlockHtml(station, { compact: !!opt.compact });
      host.appendChild(wrap);

      const editor = util.el('div', 'st-sec tp-station-editor');
      editor.innerHTML = `<div class="st-sec-head">
          <div class="st-sec-title">车站属性</div>
          <span class="st-sec-hint">谁的车站都能改（改名 / 类型 / 站台 / 吸引半径）</span>
        </div>${Transit.stationEditorHtml(station, { compact: true })}`;
      host.appendChild(editor);
      Transit._bindStationEditor(editor, station);

      host.appendChild(Transit.addStationToLineBlock(station));
      return host;
    },

    /** 站点管理器的内容指纹：一样就不重建 DOM */
    stationManagerSignature(station) {
      if (!station) return '';
      const tr = Transit.waitingTrend(station);
      const lines = Transit.stationLines(station, true);
      // 候车明细（分线路 + 每条线的去向）也要进指纹：不然"1 号线的队伍从 6 变 5"
      // 或者"去西直门的人从 3 变 5"这种变化不会重画那一块。
      // ⚠ 人数按**显示值**（整数）算：服务端给的小数抖动（3.4 → 3.5）在界面上看不出差别，
      //   却会让整块 DOM 每几百毫秒重画一次（还会绕开"鼠标停着先别重建"的让路规则）。
      const destSig = (mix) => (!mix || !mix.available ? '?'
        : mix.rows.map((d) => `${d.stationId}:${Transit.peopleInt(d.people)}`).join('+'));
      const waits = Transit.stationLineWait(station)
        .map((r) => [r.lineId == null ? 'fb' : r.lineId, r.waiting, r.lost, r.waitSeconds, destSig(r.dest)].join(':'))
        .join(',');
      return [
        station.name, station.kind, station.catchment ? station.catchment.pop : 0,
        station.catchment ? station.catchment.weightedPop : 0,
        station.catchment ? station.catchment.jobs : 0,
        Transit.stationWaiting(station), Transit.stationLost(station), Transit.stationMaxWait(station), waits,
        destSig(Transit.stationWaitingByDest(station)),
        tr.delta, tr.dir, station.nodeId || station.onRail ? 1 : 0,
        lines.map((l) => [l.id, l.name, l.color, l.kind, l.dailyTrips || 0, l._mine ? 1 : 0, l.pathError || ''].join(':')).join(','),
      ].join('|');
    },

    /**
     * 实时刷新挂着的站点管理器（就是面板「车站」分区里的那一块）：
     * 只换 .st-mgr-body 的内容，不动外面的列表 / 表单，免得把正在输入的光标冲掉。
     * 鼠标停在管理器里时先别重建：正要点「从该线路移除」的时候把按钮换掉，点击就丢了。
     *   · 例外（必须重建）：**候车明细**（分线路 + 每条线的目的站分布）变了 ——
     *     那正是玩家盯着看的东西，鼠标停在旁边也得让它出现（host.dataset.destSig 单独记这一份指纹）；
     *   · 服务端只在有人等车时才下发这份明细，所以"有人等但手上这份没有"时顺手补拉一次整份快照。
     */
    refreshStationMgr(force) {
      const hosts = util.$$('.st-mgr[data-st-mgr]');
      if (!hosts.length) { Transit._stMgrLive = false; return false; }
      const now = Date.now();
      const due = now - (Transit._stMgrAt || 0) >= WAIT_TREND_WINDOW_MS;   // 趋势每 10 秒也要动一次
      const hoverHold = !force && Transit._mgrHover && now - (Transit._mgrHoverAt || 0) < 4000;
      if (!force && (hoverHold || Transit.panelTyping())) {
        // 鼠标停在详情里 / 正在输入：先记一笔，等让路规则过了再重画（松手/移开会立刻补一次）。
        // 但候车明细的变化不等 —— 见下面每个 host 单独判断。
        Transit._mgrDirty = true;
      }
      let any = false;
      let kicked = false;
      for (const host of hosts) {
        if (host.isConnected === false) continue;
        const st = Transit.stationById(Number(host.dataset.stMgr));
        if (!st) continue;
        const sig = Transit.stationManagerSignature(st);
        const destSig = Transit.stationWaitingSig(st);
        const detailChanged = host.dataset.destSig !== destSig;
        if (!force) {
          if (hoverHold && !detailChanged) continue;                  // 让路（明细没变就别换 DOM）
          if (!due && sig === host.dataset.sig && !detailChanged) { any = true; continue; }
        }
        const body = host.querySelector('.st-mgr-body');
        if (!body) continue;
        body.innerHTML = Transit.stationManagerBodyHtml(st);
        host.dataset.sig = sig;
        host.dataset.destSig = destSig;
        any = true;
        // 有人在等、明细却不在手上 → 拉一次整份快照（节流 1 秒），别干等着下一个周期
        if (!kicked && Transit.waitingDetailMissing(st)) { kicked = true; Transit.ensureLiveStation(true); }
      }
      if (any) Transit._stMgrAt = now;
      if (!kicked && Transit._mgrDirty && !hoverHold) Transit._mgrDirty = false;
      return any;
    },

    /** 候车明细（每条线的去向）的指纹：只这一块变了也要立刻重画（人数按显示值 = 整数算，见 stationManagerSignature） */
    stationWaitingSig(station) {
      if (!station) return '';
      const destSig = (mix) => (!mix || !mix.available ? '?'
        : mix.rows.map((d) => `${d.stationId}:${Transit.peopleInt(d.people)}:${(d.lines || []).join('.')}`).join('+'));
      const mine = destSig(Transit.stationWaitingByDest(station));
      const lines = Transit.stationLineWait(station)
        .map((r) => [r.lineId == null ? 'fb' : r.lineId, r.waiting, r.lost, r.waitSeconds, destSig(r.dest)].join(':'))
        .join(',');
      return `${Transit.stationWaiting(station)}/${Transit.stationLost(station)}/${mine}/${lines}`;
    },

    /**
     * 车站编辑表单：名称 / 类型（服务端类型表）/ 站台长度 / 吸引半径 / 显示覆盖范围，外加 保存。
     * 面板「车站」分区右侧的车站详情就是它（地图上只有一个小气泡，不挂表单）。
     * options.compact = true 时不画标题行（外面那块已经有标题了）。
     * 公交站没有站台长度：那一栏整个换成一句说明，保存时也不会去校验它。
     *
     * 可写 / 只读**只看一件事**（不看是谁建的、也不看是不是底图导入的：服务端允许改任何车站）：
     *   · 这个车站正被别人锁着（元素锁）→ 只读，并把服务端那句中文原因写在表单上。
     * 其余情况下一律可写，「保存」按钮一直在（被别人锁着时才收起来）。
     */
    stationEditorHtml(station, options) {
      if (!station) return '';
      Transit.ensureStationKinds();
      const opt = options || {};
      const pub = Transit.isPublicStation(station);       // 只用来写一句"来源"说明
      const lockBy = Transit.elemLockBy('station', station.id);
      const readonly = !!lockBy;
      const kinds = Transit.stationKinds();
      const maxCatch = (Transit.config && Transit.config.maxCatchment) || CATCHMENT_MAX_M;
      const owner = ((Transit.data && Transit.data.companies) || []).find((c) => c.id === station.companyId);
      const waiting = Transit.stationWaiting(station);
      const lost = Transit.stationLost(station);
      const ro = readonly ? ' readonly' : '';
      const dis = readonly ? ' disabled' : '';
      const hasPlatform = Transit.stationHasPlatform(station);
      const opts = Object.keys(kinds).map((k) => {
        const info = kinds[k] || {};
        return `<option value="${util.esc(k)}"${k === station.kind ? ' selected' : ''}>${util.esc(info.name || MODE_LABEL[k] || k)}</option>`;
      }).join('');
      const head = opt.compact ? ''
        : `<div class="popup-title"><span class="dot" style="--c:${util.esc((owner && owner.color) || '#888')}"></span>${util.esc(station.name)}<small>#${station.id}</small></div>`;
      const roNote = lockBy
        ? `<div class="st-readonly">🔒 ${util.esc(lockBusyText(lockBy))}：以下数值只读</div>`
        : (pub
          ? '<div class="st-source-note">🏷 底图导入的站（来源标记）：和自建站一样能改名 / 挪动 / 删除</div>'
          : '');
      const platformValue = Number.isFinite(Number(station.platformM)) ? Math.round(Number(station.platformM)) : PLATFORM_MIN_M;
      return `<div class="popup st-editor" data-st-id="${station.id}" data-st-owner="${util.esc(station.owner == null ? '' : station.owner)}"${lockBy ? ` data-st-lock="${util.esc(lockBy)}"` : ''}>
        ${head}
        ${roNote}
        <div class="st-field"><label>名称</label>
          <input class="st-input st-name" maxlength="32" value="${util.esc(station.name)}"${ro}></div>
        <div class="st-field"><label>类型</label>
          <select class="st-select st-kind"${dis}>${opts}</select></div>
        <div class="st-field st-platform-field" style="${hasPlatform ? '' : 'display:none'}"><label>站台长度</label>
          <input class="st-input st-platform" type="number" min="${PLATFORM_MIN_M}" max="${PLATFORM_MAX_M}" step="5" value="${platformValue}"${ro}><span class="st-unit">米</span></div>
        <div class="st-no-platform" style="${hasPlatform ? 'display:none' : ''}">🚌 公交站无站台长度（直接停靠路边，长短不影响上下客）</div>
        <div class="st-field"><label>吸引半径</label>
          <input class="st-input st-catchment" type="number" min="${CATCHMENT_MIN_M}" max="${maxCatch}" step="50" value="${Math.round(station.catchmentM || 0)}"${ro}><span class="st-unit">米</span></div>
        <label class="st-check"><input class="st-show" type="checkbox"${station.showCatchment ? ' checked' : ''}${dis}>在地图上显示覆盖范围</label>
        <div class="st-stat">
          <span>等车人数 <b>${util.fmt(waiting)}</b></span>
          <span>失去耐心 <b>${util.fmt(lost)}</b></span>
          ${station.catchment ? `<span>覆盖 <b>${util.fmt(station.catchment.pop)}</b> 人${Number.isFinite(Number(station.catchment.weightedPop)) ? `（等效 <b>${util.fmt(station.catchment.weightedPop)}</b>）` : ''} · <b>${util.fmt(station.catchment.jobs)}</b> 岗位</span>` : ''}
          <span>路网 <b>${station.nodeId || station.onRail ? '已接入' : '未接入'}</b></span>
        </div>
        <div class="popup-actions">
          ${readonly ? '' : `<button data-act="save-station" data-id="${station.id}" class="save">保存</button>`}
        </div>
      </div>`;
    },

    /**
     * 把表单接上：保存按钮由 Transit._bindPopup 的 data-act 委托统一处理（只绑一次，不会重复提交），
     * 这里只补一个「回车即保存」的手感，以及"类型一改成公交站就把站台长度收起来"。
     * 弹窗和面板都调用它，参数就是要绑的容器。
     */
    _bindStationEditor(popupEl, station) {
      if (!popupEl || !station) return null;
      Transit._bindPopup();
      const box = popupEl.classList && popupEl.classList.contains('st-editor')
        ? popupEl
        : (popupEl.querySelector ? popupEl.querySelector('.st-editor') : null);
      if (!box || !box.dataset || typeof box.addEventListener !== 'function') return null;
      box.dataset.stId = String(station.id);
      box.dataset.stKind = String(station.kind || '');
      Transit._syncPlatformField(box);
      const kindSel = box.querySelector ? box.querySelector('.st-kind') : null;
      if (kindSel && !kindSel._stKindBound) {
        kindSel._stKindBound = true;
        kindSel.addEventListener('change', () => Transit._syncPlatformField(box));
      }
      if (box._stEditorBound) return box;
      box._stEditorBound = true;
      box.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        const t = ev.target;
        if (!t || t.tagName !== 'INPUT' || t.type === 'checkbox') return;
        ev.preventDefault();
        Transit.saveStationForm(box, Transit.stationById(box.dataset.stId) || station);
      });
      return box;
    },

    /** 按当前选中的类型决定"站台长度"这一栏露不露（公交站没有站台长度） */
    _syncPlatformField(box) {
      if (!box || !box.querySelector) return;
      const field = box.querySelector('.st-platform-field');
      const note = box.querySelector('.st-no-platform');
      const sel = box.querySelector('.st-kind');
      const kind = (sel && sel.value) || (box.dataset && box.dataset.stKind) || null;
      const has = Transit.kindHasPlatform(kind);
      if (field) field.style.display = has ? '' : 'none';
      if (note) note.style.display = has ? 'none' : '';
      return has;
    },

    /**
     * 表单 → station.update（面板「车站」分区右侧的车站详情用；地图气泡里不挂表单）。
     *
     * 权限（**服务端说了算**，客户端不拦"别人的车站"，也不拦"底图导入的站"）：
     * 谁都可以改任何车站 —— 车站没有归属这回事了。客户端只挡一种服务端也会拒的情况：
     * 车站正被别人锁着（元素锁），用的还是服务端那句中文原因。
     */
    saveStationForm(box, station) {
      if (!box || !station) return;
      if (Transit.lockRefuse('station', station.id)) return;
      const read = (sel) => { const el = box.querySelector(sel); return el ? el.value : ''; };
      const name = String(read('.st-name') || '').trim();
      if (!name) { util.toast('车站名称不能为空', 'warn', 3000); return; }
      const kind = read('.st-kind') || station.kind;
      // 公交站没有站台长度：表单里那一栏是收起来的，别去校验它（服务端会保留原值）
      const platformEl = box.querySelector('.st-platform');
      const platformHidden = !Transit.kindHasPlatform(kind) || !platformEl;
      let platformM;
      if (!platformHidden) {
        platformM = Number(platformEl.value);
        if (!Number.isFinite(platformM) || platformM < PLATFORM_MIN_M || platformM > PLATFORM_MAX_M) {
          util.toast(`站台长度要在 ${PLATFORM_MIN_M} ~ ${PLATFORM_MAX_M} 米之间`, 'warn', 3500); return;
        }
      } else if (Number.isFinite(Number(station.platformM)) && Number(station.platformM) > 0 && !Transit.stationHasPlatform(station)) {
        platformM = 0;   // 本来就按"没有站台长度"存的，照样回传 0
      }
      const maxCatch = (Transit.config && Transit.config.maxCatchment) || CATCHMENT_MAX_M;
      const catchmentM = Number(read('.st-catchment'));
      if (!Number.isFinite(catchmentM) || catchmentM < CATCHMENT_MIN_M || catchmentM > maxCatch) {
        util.toast(`吸引半径要在 ${CATCHMENT_MIN_M} ~ ${maxCatch} 米之间`, 'warn', 3500); return;
      }
      const showEl = box.querySelector('.st-show');
      const showCatchment = showEl ? !!showEl.checked : !!station.showCatchment;
      const btn = box.querySelector('[data-act="save-station"]');
      if (btn) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = '保存中…'; }
      const restore = () => { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || '保存'; } };
      Transit.op({ k: 'station.update', id: station.id, name, kind, platformM, catchmentM, showCatchment })
        .then((res) => {
          const saved = (res && res.result && res.result.station) || null;
          if (saved) Transit._mergeStation(saved);
          util.toast(`已保存「${(saved && saved.name) || name}」`, 'success', 2500);
          Transit.renderPanelSoon();
          Transit.refreshStationPopup();
          if (Render.overlay) Render.overlay.redraw();
        })
        .catch((err) => util.toast(err.message || '保存失败', 'error', 5000))
        .finally(restore);
    },

    /** 保存成功后先更新本地那一份，弹窗/面板立刻显示新值（服务端同步随后还会覆盖一次） */
    _mergeStation(station) {
      if (!station || !Transit.data) return;
      const list = Transit.data.stations || (Transit.data.stations = []);
      const i = list.findIndex((s) => s.id === station.id);
      if (i >= 0) list[i] = Object.assign({}, list[i], station);
      else list.push(station);
    },

    /* ------------------------------ 设站模式（与 editor.js 共用同一份表 / 同一个状态） ------------------------------ */

    /**
     * 7 种设站模式（id 就是服务端 STATION_KINDS 认的 kind）：
     * 优先用 editor.js 的唯一一份表 Editor.STATION_MODES；
     * 拿不到时用服务端下发的站点类型表拼，最后才用本地兜底表。
     */
    stationModeTable() {
      const ed = window.G.Editor;
      if (ed && Array.isArray(ed.STATION_MODES) && ed.STATION_MODES.length) return ed.STATION_MODES;
      const kinds = Transit.stationKinds();
      const ids = Object.keys(kinds);
      if (!ids.length) return [{ id: 'rail', ico: '🚆', name: '铁路' }, { id: 'bus', ico: '🚌', name: '公交' }];
      return ids.map((k) => ({
        id: k,
        ico: STATION_MODE_ICO[k] || '🚉',
        name: (kinds[k] && kinds[k].name) || MODE_LABEL[k] || k,
        tip: MODE_LABEL[k] || k,
      }));
    },

    /** 当前设站模式：唯一来源是共享状态 Transit.stationMode（editor.js 也读它） */
    currentStationMode() {
      const ed = window.G.Editor;
      if (ed && typeof ed.currentStationMode === 'function') return ed.currentStationMode();
      const list = Transit.stationModeTable();
      const cur = Transit.stationMode;
      return list.some((m) => m.id === cur) ? cur : ((list[0] && list[0].id) || 'rail');
    },

    /** 模式 id → 表项（名称 / 图标 / 吸附说明） */
    stationModeInfo(id) {
      const ed = window.G.Editor;
      if (ed && typeof ed.stationModeInfo === 'function') return ed.stationModeInfo(id);
      const want = id || Transit.currentStationMode();
      const list = Transit.stationModeTable();
      return list.find((m) => m.id === want) || list[0] || { id: 'rail', ico: '🚆', name: '铁路' };
    },

    /**
     * 切设站模式：能交给 editor.js 就交给它（它一处改，左侧「设站」面板、检查器「新建车站」、
     * 这里的三处芯片一起同步）；没有它时直接写共享状态并自己通知那两个面板。
     */
    setStationMode(id) {
      if (!Transit.stationModeTable().some((m) => m.id === id)) return false;
      const ed = window.G.Editor;
      if (ed && typeof ed.setStationMode === 'function') {
        ed.setStationMode(id);
      } else {
        Transit.stationMode = id;                       // 共享状态（editor.js 读的就是它）
        const info = Transit.stationModeInfo(id);
        util.statusHint(`设站模式：${info.ico ? info.ico + ' ' : ''}${info.name || id}`);
        util.toast(`设站模式：${info.name || id}（点地图放置）`, 'info', 2600);
        if (window.G.UI && typeof window.G.UI.renderToolOptions === 'function') window.G.UI.renderToolOptions();
        if (window.G.Inspector && typeof window.G.Inspector.showToolConfig === 'function') window.G.Inspector.showToolConfig();
      }
      Transit.renderDetailOnly();                       // 面板这一行的高亮立刻跟上来
      return true;
    },

    /**
     * 设站模式芯片行：优先用 editor.js 的唯一一份渲染（Editor.renderStationModeChooser），
     * 它拿不到时才按 Editor.STATION_MODES / 服务端类型表自己画 7 个 —— 绝不会只剩"铁路/公交"两个。
     * 双向同步：芯片高亮读 Transit.stationMode，点击写回同一个值。
     */
    stationModeRow(host) {
      if (!host) return null;
      const ed = window.G.Editor;
      if (ed && typeof ed.renderStationModeChooser === 'function') {
        const wrap = ed.renderStationModeChooser(host, { title: '设站模式' });
        if (wrap) return wrap;
      }
      const wrap = util.el('div', 'opt-field');
      wrap.dataset.stationModeChooser = '1';
      wrap.appendChild(util.el('div', 'opt-head', '设站模式'));
      const chips = util.el('div', 'opt-chips');
      const cur = Transit.currentStationMode();
      for (const m of Transit.stationModeTable()) {
        const chip = util.el('button', 'chip' + (m.id === cur ? ' active' : ''),
          `${m.ico ? m.ico + ' ' : ''}${util.esc(m.name || m.id)}`);
        chip.dataset.stationMode = m.id;
        chip.title = `${m.tip || m.name || m.id}（服务端 kind=${m.id}）`;
        chip.onclick = () => Transit.setStationMode(m.id);
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
      const info = Transit.stationModeInfo(cur);
      wrap.appendChild(util.el('div', 'opt-current',
        `当前：${info.ico ? info.ico + ' ' : ''}${util.esc(info.name || cur)}${info.snapText ? ' · ' + util.esc(info.snapText) : ''}`));
      host.appendChild(wrap);
      return wrap;
    },

    /* ------------------------------ 站点 ------------------------------ */
    createStationAt(latlng, name) {
      // 归一化过的共享状态：玩家在检查器里选了地铁/轻轨，这里也照样按那个 kind 建站
      const mode = Transit.currentStationMode();
      const kindInfo = Transit.stationKinds()[mode] || {};
      return Transit.op({
        k: 'station.create',
        name: name || Transit.stationName || (mode === 'bus' ? '新公交站' : `新${kindInfo.name || MODE_LABEL[mode] || '车站'}`),
        kind: mode,
        lat: latlng.lat,
        lon: latlng.lng,
      }).then((res) => {
        util.toast(`已建成 ${res.result.station.name}（吸附路网：${res.result.station.onRail ? '是' : '否'}，覆盖 ${res.result.station.catchment.pop} 人 / ${res.result.station.catchment.jobs} 岗位，花费 ${Transit.moneyShort(res.result.cost)}）`, 'success', 5000);
        Transit.renderPanelSoon();
        return res.result.station;
      }).catch((err) => {
        util.toast(err.message, 'error', 6000);
        throw err;
      });
    },

    renameStation(station) {
      if (!station) return;
      const name = window.prompt('车站名称', station.name);
      if (!name) return;
      Transit.op({ k: 'station.update', id: station.id, name })
        .then(() => Transit.renderPanelSoon())
        .catch((err) => util.toast(err.message, 'error'));
    },

    deleteStation(station, skipConfirm) {
      if (!station) return;
      // 车站没有归属：谁建的都能删，底图导入的公共站也一样（服务端同样不看 owner）
      if (Transit.lockRefuse('station', station.id)) return;
      // skipConfirm = 快捷键删除（Delete 键）：不再弹第二个确认框
      if (!skipConfirm && !window.confirm(`删除车站「${station.name}」？会从所有线路里移除。`)) return;
      Transit.op({ k: 'station.delete', id: station.id })
        .then((res) => {
          util.toast(`已删除车站，返还 ${Transit.moneyShort((res.result && res.result.refund) || 0)}`, 'success');
          Transit.selectedStation = null;
          if (Transit.selected && Transit.selected.type === 'station' && Transit.selected.id === Number(station.id)) Transit.selected = null;
          if (Transit._stationPopup && Transit._stationPopup.stationId === Number(station.id)) Transit.closeStationPopup();
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /**
     * 「📍 挪动」这一条路径（**界面上已经没有这个按钮了**：用户要求站点管理器里只留定位与删除，
     * 挪位置用地图的移动工具 / 直接拖动）。函数留着是因为旧脚本与调试代码还在调它。
     *
     * 权限：和改名 / 删除一样 —— 谁的车站都能挪，底图导入的公共站也一样（服务端只看元素锁）。
     * 实现上不依赖编辑器工具：只挂**一次性**的地图点击监听（再点一次 / 挪完就自动摘掉），
     * 不会给地图留下常驻副作用。
     */
    moveStationTo(station) {
      const st = typeof station === 'object' && station ? station : Transit.stationById(station);
      const map = Render.map;
      if (!st || !map) { util.toast('找不到这个车站（可能已经被删掉了）', 'warn', 3000); return; }
      if (Transit.lockRefuse('station', st.id)) return;
      // 设站 / 画线 / 移动这些工具会各自吃掉这次地图点击：先切回「选择」，免得同时建出一个新站
      const ed = window.G.Editor;
      if (ed && ed.tool && ed.tool !== 'select' && window.G.UI && typeof window.G.UI.selectTool === 'function') {
        window.G.UI.selectTool('select');
      }
      if (Transit._stMoveOnce && Transit._stMoveOnce.fn) {
        map.off('click', Transit._stMoveOnce.fn);
        Transit._stMoveOnce.fn = null;
      }
      const fn = (ev) => {
        map.off('click', fn);
        if (Transit._stMoveOnce && Transit._stMoveOnce.fn === fn) Transit._stMoveOnce.fn = null;
        util.statusHint('');
        Transit.op({ k: 'station.update', id: st.id, lat: ev.latlng.lat, lon: ev.latlng.lng })
          .then((res) => {
            const saved = (res && res.result && res.result.station) || null;
            if (saved) Transit._mergeStation(saved);
            util.toast(`已把「${(saved && saved.name) || st.name}」挪到新位置${saved && (saved.nodeId || saved.onRail) ? '（已吸附到路网）' : '（附近没有路网，暂时悬空）'}`, 'success', 4500);
            Transit.renderPanelSoon();
            Transit.refreshStationPopup();
            Transit.refreshStationMgr(true);
            if (Render.overlay) Render.overlay.redraw();
          })
          .catch((err) => util.toast(err.message || '挪动失败', 'error', 5000));
      };
      Transit._stMoveOnce = { id: Number(st.id), fn };
      map.on('click', fn);
      util.toast(`点地图上的位置，把「${st.name}」挪过去（按车站类型自动吸附到最近的路网）`, 'info', 6000);
      util.statusHint(`挪站：点地图放置「${st.name}」`);
    },

    /* ------------------------------ 线路 ------------------------------ */
    createLine() {
      const name = window.prompt('新线路名称', `线路 ${Transit.myLines().length + 1}`);
      if (!name) return;
      // 默认模式跟着当前设站模式走（在地铁模式下新建线路就是地铁线），之后随时能在线路详情里改类型
      const mode = Transit.currentStationMode();
      const kind = LINE_KIND_ORDER.includes(mode) ? mode : 'rail';
      const colors = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45'];
      Transit.op({ k: 'line.create', name, kind, color: colors[Transit.myLines().length % colors.length], stops: [] })
        .then(() => {
          util.toast(`已创建「${MODE_LABEL[kind] || kind}」线路：点「＋ 加站」再依次点车站（模式可在线路详情里改）`, 'success', 5000);
          Transit.panelTab = 'lines';
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /** 「＋ 加站」：进入加站模式（面板不关：左侧车站列表里的站和地图上的车站都能点） */
    addStationToLine(line) {
      if (!line) return;
      Transit.addingStopsTo = line.id;
      Transit.selected = { type: 'line', id: Number(line.id) };
      Transit.selectedLine = Number(line.id);
      if (!Transit.panelOpen) Transit.openPanel('lines');
      else Transit.renderPanel();
      util.toast(`正在给「${line.name}」加站：点左侧车站列表里的站，或直接点地图上的车站，完成后按 Esc`, 'info', 7000);
      util.statusHint(`加站模式：点车站加入「${line.name}」 · Esc 结束`);
    },

    /** 退出加站模式（工具栏 / 详情里的「结束加站」按钮） */
    stopAddingStops() {
      Transit.addingStopsTo = null;
      util.statusHint('');
      Transit.renderPanelSoon();
    },

    appendStop(lineId, stationId) {
      const line = Transit.myLines().find((l) => l.id === lineId);
      if (!line) return;
      if (line.stops.includes(stationId)) { util.toast('这条线已经有这一站了', 'warn'); return; }
      const stops = line.stops.concat([stationId]);
      Transit.op({ k: 'line.update', id: lineId, stops })
        .then((res) => {
          const info = res.result.path || {};
          if (info.error) util.toast(`已加站，但路径不通：${info.error}`, 'warn', 6000);
          else util.toast(`已加站：${info.lengthM} 米，日客流约 ${info.dailyTrips} 人次`, 'success', 4000);
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error', 6000));
    },

    removeStop(line, index) {
      const stops = line.stops.slice();
      stops.splice(index, 1);
      Transit.op({ k: 'line.update', id: line.id, stops })
        .then(() => Transit.renderPanelSoon())
        .catch((err) => util.toast(err.message, 'error'));
    },

    rebuildLine(line) {
      Transit.op({ k: 'line.update', id: line.id, stops: line.stops })
        .then((res) => {
          const info = res.result.path || {};
          if (info.error) util.toast('路径不通：' + info.error, 'error', 6000);
          else util.toast(`路径已重算：${info.lengthM} 米 / ${Math.round(info.seconds / 60)} 分钟`, 'success');
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /**
     * 删除线路：**谁建的线路都能删**（服务端 line.delete 不看 owner），唯一会拦的是元素锁 ——
     * 别人正在改这条线时先在本地拦下来并把服务端那句中文原因说出来，不让他点了确认框再吃一个失败提示。
     * 线路行 / 线路详情（linemgr 的「🗑 删除线路」）都走这一条路径。
     */
    deleteLine(line) {
      if (!line) return;
      if (Transit.lockRefuse('line', line.id)) return;
      if (!window.confirm(`删除线路「${line.name}」？线路上的车辆会变成闲置。`)) return;
      Transit.op({ k: 'line.delete', id: line.id })
        .then(() => { util.toast('线路已删除', 'success'); Transit.renderPanelSoon(); })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /* ------------------------------ 线路配色 ------------------------------ */

    /** 颜色统一成 #rrggbb；不合法返回 null（服务端也只认这个格式） */
    normalizeColor(color) {
      const s = String(color == null ? '' : color).trim();
      if (!s) return null;
      const withHash = s[0] === '#' ? s : '#' + s;
      if (/^#[0-9a-f]{3}$/i.test(withHash)) {
        return '#' + withHash.slice(1).split('').map((ch) => ch + ch).join('').toLowerCase();
      }
      return LINE_COLOR_RE.test(withHash) ? withHash.toLowerCase() : null;
    },

    lineColor(line) {
      const c = Transit.normalizeColor(line && line.color);
      return c || LINE_COLOR_DEFAULT;
    },

    /** 改线路颜色：line.update { id, color }；先本地改掉让画面立刻变，失败再回滚 */
    setLineColor(line, color) {
      if (!line) return Promise.reject(new Error('线路不存在'));
      // 协作编辑：谁建的线路都能改色，只有"别人正锁着这条线"时才拒（服务端同样会拒）
      if (Transit.lockRefuse('line', line.id)) return Promise.reject(new Error('LOCKED'));
      const next = Transit.normalizeColor(color);
      if (!next) {
        util.toast('颜色要写成 #rrggbb（例如 #e6194b）', 'warn', 3500);
        return Promise.reject(new Error('颜色格式不正确'));
      }
      const prev = line.color;
      if (next === Transit.normalizeColor(prev)) return Promise.resolve(line);
      line.color = next;
      if (Render.overlay) Render.overlay.redraw();
      return Transit.op({ k: 'line.update', id: line.id, color: next })
        .then((res) => {
          const saved = (res && res.result && res.result.line) || null;
          if (saved) {
            const local = Transit.lineById(saved.id);
            if (local) Object.assign(local, saved);
          }
          util.toast(`「${line.name}」的颜色已改为 ${next}`, 'success', 2500);
          Transit.renderPanelSoon();
          if (Transit._stMgrLive) Transit.refreshStationMgr(true);
          if (Render.overlay) Render.overlay.redraw();
          return line;
        })
        .catch((err) => {
          line.color = prev;
          if (Render.overlay) Render.overlay.redraw();
          util.toast((err && err.message) || '改色失败', 'error', 5000);
          throw err;
        });
    },

    /**
     * 线路取色器：一排预设色 + 六位十六进制输入 + 应用。
     * 交通面板的线路行和线路管理器共用它。
     * 默认提交给 Transit.setLineColor（data-act 交给 _bindPopup 统一处理）；
     * 传了 options.onApply 就由调用方自己提交，这时不再挂 data-act，避免重复提交。
     */
    lineColorPicker(line, options) {
      const opt = options || {};
      const selfSubmit = typeof opt.onApply !== 'function';
      const cur = Transit.lineColor(line);
      const box = util.el('div', 'tp-colors');
      box.dataset.lineId = String(line.id);
      const title = util.el('span', 'tp-colors-title', '颜色');
      title.title = '改线路颜色（地图上的线会立刻变色）';
      box.appendChild(title);
      for (const c of LINE_COLOR_PRESETS) {
        const sw = util.el('button', 'tp-color' + (c.toLowerCase() === cur.toLowerCase() ? ' active' : ''), '');
        sw.type = 'button';
        sw.title = c;
        sw.setAttribute('aria-label', '线路颜色 ' + c);
        sw.dataset.color = c;
        if (selfSubmit) {
          sw.dataset.act = 'line-color';
          sw.dataset.id = String(line.id);
        }
        sw.style.background = c;
        box.appendChild(sw);
      }
      const hex = util.el('input', 'tp-color-hex');
      hex.type = 'text';
      hex.maxLength = 7;
      hex.value = cur;
      hex.title = '也可以直接填 #rrggbb';
      hex.setAttribute('aria-label', '线路颜色十六进制');
      box.appendChild(hex);
      const apply = util.el('button', 'mini tp-color-apply', '应用');
      apply.type = 'button';
      apply.title = '应用这个颜色';
      if (selfSubmit) {
        apply.dataset.act = 'line-color-apply';
        apply.dataset.id = String(line.id);
      }
      box.appendChild(apply);
      if (!selfSubmit) {
        const submit = (ev, color) => {
          ev.preventDefault();
          ev.stopPropagation();   // 别让文档级的 data-act 委托再提交一次
          opt.onApply(color);
        };
        box.addEventListener('click', (ev) => {
          const sw = ev.target.closest ? ev.target.closest('.tp-color') : null;
          if (sw) { submit(ev, sw.dataset.color); return; }
          if (ev.target.closest && ev.target.closest('.tp-color-apply')) submit(ev, hex.value);
        });
        hex.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter') return;
          submit(ev, hex.value);
        });
      }
      return box;
    },

    /* ------------------------------ 线路模式（类型） ------------------------------ */

    /**
     * 线路模式选择器（rail/hsr/intercity/subway/light_rail/tram/bus）：
     * 面板右侧的线路详情和线路管理器共用这一份，提交仍是 line.update { id, kind }。
     * 改模式会按新制式重建整条路径，所以下拉旁边一直挂着一句提醒。
     */
    lineKindSelect(line) {
      if (!line) return null;
      const wrap = util.el('div', 'tp-kindrow');
      wrap.appendChild(util.el('span', 'tp-kindlabel', '模式'));
      const sel = util.el('select', 'tp-select small');
      sel.title = '改变线路模式：服务端会按新制式重建整条路径（站点顺序不变，里程 / 时间 / 日客流会重算）';
      for (const k of LINE_KIND_ORDER) {
        const o = util.el('option', null, util.esc(MODE_LABEL[k] || k));
        o.value = k;
        if (k === line.kind) o.selected = true;
        sel.appendChild(o);
      }
      const warn = util.el('span', 'tp-kindwarn', '⚠ 改模式会重建路径');
      // 协作编辑：模式谁都能改（服务端不看 owner），只有这条线正被别人锁着时才禁用
      sel.disabled = !Transit.isMyLine(line);
      sel.onchange = () => {
        const next = sel.value;
        if (next === line.kind) return;
        Transit.setLineKind(line, next).catch(() => { sel.value = line.kind; });
      };
      wrap.appendChild(sel);
      wrap.appendChild(warn);
      return wrap;
    },

    /** 改线路模式：line.update { id, kind }；先提示"会重建路径"，成功了再本地同步 */
    setLineKind(line, kind) {
      if (!line) return Promise.reject(new Error('线路不存在'));
      // 协作编辑：谁建的线路都能改模式，只有"别人正锁着这条线"时才拒（服务端同样会拒）
      if (Transit.lockRefuse('line', line.id)) return Promise.reject(new Error('LOCKED'));
      if (!LINE_KIND_ORDER.includes(kind) || kind === line.kind) return Promise.resolve(line);
      const label = MODE_LABEL[kind] || kind;
      if (!window.confirm(`把「${line.name}」的模式改成「${label}」？\n\n改变模式会用新制式重建整条路径：站点顺序不变，但里程、单程时间、日客流都会重算。`)) {
        return Promise.reject(new Error('CANCELLED'));
      }
      return Transit.op({ k: 'line.update', id: line.id, kind })
        .then((res) => {
          const saved = (res && res.result && res.result.line) || null;
          if (saved) {
            const local = Transit.lineById(saved.id);
            if (local) Object.assign(local, saved);
          }
          const info = (res && res.result && res.result.path) || {};
          if (info.error) util.toast(`已改成${label}，但新路径不通：${info.error}`, 'warn', 7000);
          else util.toast(`「${line.name}」已改成${label}，路径已重建（${util.fmtLength(info.lengthM)}）`, 'success', 5000);
          Transit.renderPanelSoon();
          const mgr = window.G.LineMgr;
          if (mgr && typeof mgr.refresh === 'function') mgr.refresh({ force: true });
          if (Render.overlay) Render.overlay.redraw();
          return line;
        })
        .catch((err) => {
          if (!err || err.message !== 'CANCELLED') util.toast((err && err.message) || '改模式失败', 'error', 5000);
          throw err;
        });
    },

    /* ------------------------------ 车辆 ------------------------------ */
    buyVehicle(line) {
      const cfg = Transit.config || { vehicleBaseCost: 20000000, vehiclePerCarCost: 5000000 };
      const cars = Math.max(1, Math.min(12, Number(window.prompt('车厢数（1-12）', '4') || 4)));
      const capacity = Math.max(20, Math.min(400, Number(window.prompt('每节定员（人）', '60') || 60)));
      const maxSpeed = Math.max(30, Math.min(400, Number(window.prompt('最高速度 km/h', '80') || 80)));
      const cost = cfg.vehicleBaseCost + cfg.vehiclePerCarCost * cars;
      if (!window.confirm(`购买 ${cars} 节编组（定员 ${cars * capacity} 人，最高 ${maxSpeed} km/h）需要 ${Transit.moneyShort(cost)} 元，确定吗？`)) return;
      Transit.op({ k: 'vehicle.create', lineId: line ? line.id : null, cars, capacityPerCar: capacity, maxSpeed })
        .then(() => { util.toast('车辆已交付', 'success'); Transit.renderPanelSoon(); })
        .catch((err) => util.toast(err.message, 'error', 6000));
    },

    /* ------------------------------ 车辆（车队） ------------------------------ */
    /**
     * 车型表：优先用服务端 kinds 操作下发的（和服务器完全一致），
     * 其次用 config.transit.vehicleKinds，最后才是本地兜底表（断线 / 还没握手时面板也不是空的）。
     */
    vehicleKinds() {
      const k = Transit.vehicleKindsTable || (Transit.config && Transit.config.vehicleKinds);
      if (k && Object.keys(k).length) return k;
      return {
        bus: { name: '比亚迪 K8 公交', lengthM: 12, cars: 1, capacityPerCar: 80, maxSpeed: 70, minZoom: 15 },
        bus_double: { name: '双层巴士', lengthM: 12.5, cars: 1, capacityPerCar: 100, maxSpeed: 60, minZoom: 15 },
        bus_artic: { name: '宇通 18 米铰接公交', lengthM: 18, cars: 1, capacityPerCar: 140, maxSpeed: 60, minZoom: 15 },
        trolley: { name: '无轨电车', lengthM: 12, cars: 1, capacityPerCar: 85, maxSpeed: 50, minZoom: 15 },
        minibus: { name: '社区巴士', lengthM: 8, cars: 1, capacityPerCar: 30, maxSpeed: 60, minZoom: 15 },
        tram: { name: '中车有轨电车', lengthM: 32, cars: 4, capacityPerCar: 60, maxSpeed: 50, minZoom: 13 },
        metro_b4: { name: '地铁 B 型 4 节', lengthM: 76, cars: 4, capacityPerCar: 230, maxSpeed: 80, minZoom: 12 },
        metro_b6: { name: '地铁 B 型 6 节', lengthM: 114, cars: 6, capacityPerCar: 230, maxSpeed: 80, minZoom: 12 },
        metro_a8: { name: '地铁 A 型 8 节', lengthM: 176, cars: 8, capacityPerCar: 250, maxSpeed: 100, minZoom: 12 },
        crh6: { name: 'CRH6 城际动车组', lengthM: 200, cars: 8, capacityPerCar: 180, maxSpeed: 160, minZoom: 8 },
        cr400: { name: '复兴号 CR400AF', lengthM: 209, cars: 8, capacityPerCar: 72, maxSpeed: 350, minZoom: 7 },
        locomotive: { name: '和谐电 1 型机车', lengthM: 20, cars: 1, capacityPerCar: 1, maxSpeed: 120, minZoom: 14 },
        freight: { name: '货运列车 30 节', lengthM: 400, cars: 30, capacityPerCar: 1, maxSpeed: 80, minZoom: 10 },
      };
    },

    kindLabel(kind) {
      const k = Transit.vehicleKinds()[kind];
      return k ? k.name : (kind === 'bus' ? '公交车' : '轨道车辆');
    },

    /** 在车辆系统里新建一辆车（先建车，再决定跑哪条线） */
    createVehicle(kindKey) {
      const preset = Transit.vehicleKinds()[kindKey];
      if (!preset) return;
      const cars = preset.cars;
      const capacity = cars * preset.capacityPerCar;
      const eco = Transit.config && Transit.config.economy;
      const costText = eco ? `\n造价 ${Transit.moneyShort((Transit.config.vehicleBaseCost || 0) + (Transit.config.vehiclePerCarCost || 0) * cars)}` : '';
      if (!window.confirm(`新建「${preset.name}」？\n长度 ${preset.lengthM} 米 · ${cars} 节 · 定员 ${capacity} 人 · 最高 ${preset.maxSpeed} km/h${costText}`)) return;
      Transit.op({ k: 'vehicle.create', kind: kindKey, cars, capacityPerCar: preset.capacityPerCar, maxSpeed: preset.maxSpeed, lengthM: preset.lengthM })
        .then((res) => {
          util.toast(`已新建 ${res.result.vehicle.name}（${preset.lengthM} 米，定员 ${capacity} 人）`, 'success', 4000);
          Transit.panelTab = 'vehicles';
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error', 6000));
    },

    renameVehicle(vehicle) {
      if (!vehicle) return;
      // 协作编辑：谁的车都能改名（服务端不看 owner），只有"别人正锁着这辆车"时才拒
      if (Transit.lockRefuse('vehicle', vehicle.id)) return;
      const name = window.prompt('车辆名称', vehicle.name);
      if (!name) return;
      Transit.op({ k: 'vehicle.update', id: vehicle.id, name })
        .then(() => Transit.renderPanelSoon())
        .catch((err) => util.toast(err.message, 'error'));
    },

    /**
     * 「指派线路」下拉里能选的线路：**全服的线路**（协作编辑口径 —— 服务端的 vehicle.update 只要求
     * "线路存在"，谁建的线路都能派车上去），自己的排前面（默认先看到自己的）。
     * 下拉里会给别家公司的线路标一句「（别家公司）」，免得选错。
     */
    assignableLines() {
      const all = (Transit.data && Transit.data.lines) || [];
      return all.slice().sort((a, b) => {
        const am = Transit.isMyCompanyAsset('lines', a) ? 0 : 1;
        const bm = Transit.isMyCompanyAsset('lines', b) ? 0 : 1;
        return am - bm || a.id - b.id;
      });
    },

    /** 把车队里的车指派到线路（列表式：由面板传入 lineId，绝不弹输入框） */
    assignVehicle(vehicle, lineId) {
      if (!vehicle) return;
      // 协作编辑：别人的车也能换线 / 撤下（服务端不看 owner），只有"别人正锁着这辆车"时才拒
      if (Transit.lockRefuse('vehicle', vehicle.id)) return;
      let target = lineId;
      if (target === undefined) {
        const lines = Transit.assignableLines();
        if (!lines.length) { util.toast('先创建一条线路', 'warn'); return; }
        target = lines[0].id;
      }
      Transit.op({ k: 'vehicle.update', id: vehicle.id, lineId: target === null ? null : Number(target) })
        .then(() => {
          util.toast(target === null ? '已把车辆撤下线路' : '已指派到线路', 'success');
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /** 批量指派：多辆车一次性挂到某条线路（撤下时 lineId 传 null） */
    assignVehicles(vehicles, lineId) {
      const list = (vehicles || []).filter(Boolean);
      if (!list.length) { util.toast('还没有选中车辆', 'warn'); return; }
      if (list.some((v) => Transit.lockRefuse('vehicle', v.id))) return;
      let chain = Promise.resolve();
      for (const v of list) {
        chain = chain.then(() => Transit.op({ k: 'vehicle.update', id: v.id, lineId: lineId === null ? null : Number(lineId) }));
      }
      chain
        .then(() => {
          util.toast(lineId === null ? `已把 ${list.length} 辆车撤下线路` : `已把 ${list.length} 辆车指派到该线路`, 'success');
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    sellVehicle(vehicle) {
      if (!vehicle) return;
      // 协作编辑：谁的车都能删（服务端不看 owner），只有"别人正锁着这辆车"时才拒
      if (Transit.lockRefuse('vehicle', vehicle.id)) return;
      const eco = Transit.config && Transit.config.economy;
      if (!window.confirm(`删除车辆「${vehicle.name}」？${eco ? '（返还一半购车款）' : ''}`)) return;
      Transit.op({ k: 'vehicle.delete', id: vehicle.id })
        .then((res) => {
          util.toast(eco ? `已删除，返还 ${Transit.moneyShort(res.result.refund)}` : '已删除', 'success');
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /* ------------------------------ 人口密度图 ------------------------------ */
    togglePopulation(on) {
      Transit.population.on = on === undefined ? !Transit.population.on : !!on;
      if (Transit.population.on) Transit.ensurePopulation(true);
      if (Render.overlay) Render.overlay.redraw();
      util.toast(Transit.population.on ? '人口密度图已打开（颜色越红人越密）' : '人口密度图已关闭', 'info', 2200);
      const cb = util.$('#pop-toggle');
      if (cb) cb.checked = Transit.population.on;
      if (Transit.panelOpen) Transit.renderPanelSoon();
    },

    ensurePopulation(force) {
      const p = Transit.population;
      if (!p.on) return;
      const bbox = window.G.MapData ? window.G.MapData.bboxNow(0) : null;
      if (!bbox || p.loading) return;
      if (!force && p.bbox && p.bbox.minLon <= bbox.minLon && p.bbox.maxLon >= bbox.maxLon &&
        p.bbox.minLat <= bbox.minLat && p.bbox.maxLat >= bbox.maxLat) return;
      p.loading = true;
      const url = `/api/population?minLon=${bbox.minLon}&minLat=${bbox.minLat}&maxLon=${bbox.maxLon}&maxLat=${bbox.maxLat}`
        + `&minPop=150&token=${encodeURIComponent(Net.token || '')}`;
      fetch(url)
        .then((r) => r.json())
        .then((data) => {
          p.cells = data.cells || [];
          p.totals = data.totals || null;
          p.bbox = bbox;
          p.loading = false;
          if (Render.overlay) Render.overlay.redraw();
        })
        .catch(() => { p.loading = false; });
    },

    /* ------------------------------ 地图绘制 ------------------------------ */
    /** 当前缩放级别（分级显示用；拿不到就当作最近视角） */
    zoom() {
      try { return Render.map && Render.map.getZoom ? Render.map.getZoom() : 16; } catch { return 16; }
    },

    /* ------------------------------ 分级显示阈值（可配置：Transit.stationLod） ------------------------------ */

    /**
     * 有效的分级阈值：默认值 → 本机记住的 → 服务端 config.transit.stationLod → 运行时改的（Transit.stationLod）。
     * 每一层都过 sanitizeStationLod()：只认 STATION_LOD_FIELDS 里的键，字段必须是**有限数且在合法区间内**，
     * 整块不是普通对象就整块忽略 —— 脏存档（-1 / "abc" / NaN / 9 / "标准" / [1,2] / null）只会被丢掉，
     * 绝不会让某个阈值变成 NaN / -1，也绝不会让启动或渲染抛异常（见 STATION_LOD_RANGE）。
     */
    stationLodEffective() {
      if (Transit._lod) return Transit._lod;
      const eff = Object.assign({}, STATION_LOD_DEFAULT);
      for (const src of [Transit._lodStorage, Transit.config && Transit.config.stationLod, Transit.stationLod]) {
        Object.assign(eff, sanitizeStationLod(src));
      }
      // 兜底：任何情况下这里都必须是 5 个有限数（渲染路径不许出现 NaN 阈值）
      for (const k of STATION_LOD_FIELDS) {
        if (strictNumber(eff[k], STATION_LOD_RANGE[k][0], STATION_LOD_RANGE[k][1]) === null) {
          eff[k] = STATION_LOD_DEFAULT[k];
        }
      }
      Transit._lod = eff;
      return eff;
    },

    /**
     * 改分级阈值（给部分字段就行），立刻生效、记在本机、重绘地图与面板。
     * 例：Transit.setStationLod({ waitingMinZoom: 14, maxMetersPer100px: 800 })
     * 传 { persist: false } 就只改这一次（不写 localStorage）。
     * **非法字段一律忽略**（不是有限数 / 越界），整块不是普通对象就等于什么都没改；任何输入都不抛异常。
     */
    setStationLod(patch, options) {
      const opt = options && typeof options === 'object' ? options : {};
      const clean = sanitizeStationLod(patch);
      if (!Object.keys(clean).length) return Transit.stationLodEffective();
      Transit.stationLod = Object.assign({}, Transit.stationLodEffective(), clean);
      // 存档里只留合法字段：脏数据不会被"顺手写回去"，下次启动也不会再读到它
      Transit._lodStorage = Object.assign({}, sanitizeStationLod(Transit._lodStorage), clean);
      Transit._lod = null;
      if (opt.persist !== false) util.storage.set(STATION_LOD_KEY, Transit._lodStorage);
      if (Render.overlay) Render.overlay.redraw();
      if (Transit.panelOpen && !opt.silent) Transit.renderPanelSoon();
      return Transit.stationLodEffective();
    },

    /** 当前可见地面尺度（米 / 100 像素）：由 Render.metersPerPixel() 换算，不写死 zoom */
    metersPer100px() {
      const mpp = (Render && typeof Render.metersPerPixel === 'function') ? Number(Render.metersPerPixel()) : NaN;
      const safe = Number.isFinite(mpp) && mpp > 0 ? mpp : 2;
      return safe * 100;
    },

    /**
     * 视野尺度上限（米 / 100 像素）：只有 > 0 的有限值才启用"缩太远就隐藏"这条规则。
     * 脏存档（-1 / 0 / "x" / NaN）在 stationLodEffective() 里就已经换回默认 600 了，
     * 这里的兜底只保证**永远不返回 NaN**（返回 Infinity = 这一帧不启用该规则）。
     */
    wideViewLimit() {
      const v = Transit.stationLodEffective().maxMetersPer100px;
      const n = strictNumber(v, STATION_LOD_RANGE.maxMetersPer100px[0], STATION_LOD_RANGE.maxMetersPer100px[1]);
      return n === null ? Infinity : n;
    },

    /**
     * 视野是不是太宽：可见地面尺度超过 wideViewLimit()（默认 600 米/100 像素）时，
     * **车站、等车人数徽标、车辆气泡整块隐藏**（道路与轨道照常画）。
     */
    viewTooWide() {
      return Transit.metersPer100px() > Transit.wideViewLimit();
    },

    /**
     * 由当前视野尺度**反算**出来的缩放阈值（不硬编码 zoom）：低于它车站/等车/气泡就整块隐藏。
     * 面板提示里拿它显示"约 z14.3 以下自动隐藏车站"；取不到地图时返回 null。
     */
    wideViewZoom() {
      const limit = Transit.wideViewLimit();
      if (!Number.isFinite(limit)) return null;
      const perPx = limit / 100;
      const mpp = Transit.metersPer100px() / 100;
      if (!(perPx > 0) || !(mpp > 0)) return null;
      return Transit.zoom() + Math.log2(mpp / perPx);
    },

    /**
     * 车站/车辆分级：城市尺度只留高铁站与城际站，放大后逐级出现。
     * 车站圆点是**两条规则叠加**：① 该类型自己的 minZoom（类型表仍是下限，永远不放宽）
     * ② stationLod.dotMinZoom（全局下限，可配置）—— 两者取大值；视野太宽时整块隐藏见 draw()。
     */
    stationMinZoom(kind) {
      const kindMin = STATION_MIN_ZOOM[kind] === undefined ? 14 : STATION_MIN_ZOOM[kind];
      // dotMinZoom 由 stationLodEffective() 保证是有限数（脏存档已经换回默认 9），这里再兜一层
      const lodMin = strictNumber(Transit.stationLodEffective().dotMinZoom, 0, 22);
      return Math.max(kindMin, lodMin === null ? 0 : lodMin);
    },
    stationVisible(kind, z) { return z >= Transit.stationMinZoom(kind); },
    /** 站名标签（自己的站 / 鼠标悬停的站）要不要画 */
    stationNameVisible(z) { return z >= Transit.stationLodEffective().nameMinZoom; },
    /** 等车人数徽标要不要画（默认 z15，比老版本的 z16 远一级） */
    stationWaitingVisible(z) { return z >= Transit.stationLodEffective().waitingMinZoom; },
    /**
     * 这一帧地图上到底画不画等车人数徽标：分级阈值 + 视野尺度 + 覆盖层都要满足。
     * draw() 里的判定和这里一致；ensureLiveWaiting() 用它在"反正画不出来"时省掉网络请求。
     */
    waitingBadgeVisible() {
      if (!Render.overlay) return false;
      if (Transit.viewTooWide()) return false;
      return Transit.stationWaitingVisible(Transit.zoom());
    },
    /** 车辆信息气泡要不要画（默认 z14，比老版本的 z15 远一级；视野太宽时也不画） */
    vehicleBubbleVisible(z) { return z >= Transit.stationLodEffective().bubbleMinZoom; },
    /** 某车型的最低显示级别（车型表里服务端可以给 minZoom） */
    vehicleMinZoom(kind) {
      const preset = Transit.vehicleKinds()[kind];
      const min = preset && preset.minZoom ? preset.minZoom : (VEHICLE_MIN_ZOOM[kind] === undefined ? 14 : VEHICLE_MIN_ZOOM[kind]);
      const n = Number(min);
      return Number.isFinite(n) ? n : 14;
    },
    vehicleVisible(kind, z) { return z >= Transit.vehicleMinZoom(kind); },

    companyColor(id) {
      const c = (Transit.data && Transit.data.companies || []).find((x) => x.id === id);
      return (c && c.color) || '#888';
    },

    /** 由 Render.drawOverlay 在最后调用：人口热力 → 线路 → 站点 → 列车 */
    draw(ctx, size, P) {
      const data = Transit.data;
      if (!data) return;
      // 这一帧画过的"可点图形"重新收集：hitTest 靠它把点中的位置还原成"点了哪个泡泡/哪块站牌"
      Transit._trainRects = [];
      Transit._stationRects = [];
      const z = Transit.zoom();
      const lod = Transit.stationLodEffective();
      // 视野太宽（可见地面尺度 > stationLod.maxMetersPer100px，默认 600 米/100 像素）时，
      // 车站 / 等车人数 / 车辆气泡整块不画 —— 道路与轨道照常画（它们属于底图，不在这里）
      const hideFar = Transit.viewTooWide();
      Transit._farHidden = hideFar;
      // 1) 人口密度：按每平方公里人口着色（越密越红），图例在面板里
      if (Transit.population.on && Transit.population.cells.length) {
        const mPerDegLat = 110574;
        ctx.save();
        for (const cell of Transit.population.cells) {
          const halfLat = 125 / mPerDegLat;
          const halfLon = 125 / (111320 * Math.cos((cell.lat * Math.PI) / 180));
          const a = P([cell.lat + halfLat, cell.lon - halfLon]);
          const b = P([cell.lat - halfLat, cell.lon + halfLon]);
          if (!a || !b) continue;
          // 每个格子 0.25 km² → 密度 = 人口 / 0.25
          const density = (cell.pop || 0) / 0.25;
          const t = Math.max(0, Math.min(1, density / 120000));
          const r = 40 + Math.round(215 * Math.min(1, t * 1.6));
          const g = Math.round(215 * (1 - t) + 40 * t);
          const bl = Math.round(120 * (1 - t));
          ctx.fillStyle = `rgba(${r},${g},${bl},${(0.12 + 0.5 * t).toFixed(3)})`;
          ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        }
        ctx.restore();
      }
      // 2) 线路（沿真实轨道/道路的路径）
      for (const line of data.lines || []) {
        if (!line.pathCoords || line.pathCoords.length < 2) continue;
        const pts = [];
        for (const c of line.pathCoords) {
          const p = P(c);
          if (p) pts.push(p);
        }
        if (pts.length < 2) continue;
        ctx.save();
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = line.kind === 'bus' ? 6 : 7;
        ctx.stroke();
        // 所有线路都画实线（公交与轨道只在粗细上有区别，虚线看着像"没建成"）
        ctx.strokeStyle = Transit.lineColor(line);
        ctx.lineWidth = line.kind === 'bus' ? 4 : 5;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.restore();
      }
      // 3) 车站（分级显示：类型 minZoom 与 stationLod.dotMinZoom 取大值；视野太宽时整块不画）
      let hiddenStations = 0;
      for (const st of data.stations || []) {
        if (hideFar || !Transit.stationVisible(st.kind, z)) { hiddenStations += 1; continue; }
        const p = P(st);
        if (!p) continue;
        const color = Transit.companyColor(st.companyId === undefined ? st.owner : st.companyId);
        ctx.save();
        // 覆盖范围：只画自己打开开关的站，半径可调
        if (st.showCatchment) {
          const rM = st.catchmentM || 700;
          const rPx = rM / (Render.metersPerPixel ? Render.metersPerPixel() : 2);
          if (rPx > 3 && rPx < 4000) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, rPx, 0, Math.PI * 2);
            ctx.fillStyle = (color || '#888') + '22';
            ctx.fill();
            ctx.strokeStyle = (color || '#888') + '99';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, st.kind === 'bus' ? 4.5 : 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = color;
        ctx.stroke();
        // 选中的车站加一圈高亮
        if (Transit.selectedStation === st.id) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffd166';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (!hideFar && Transit.stationNameVisible(z)
          && (st.companyId === Transit.companyId() || Transit.hoverStation === st.id)) {
          ctx.font = '600 11px "PingFang SC","Microsoft YaHei",sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(255,255,255,0.92)';
          ctx.strokeText(st.name, p.x, p.y - 9);
          ctx.fillStyle = '#222';
          ctx.fillText(st.name, p.x, p.y - 9);
          // 站名本身就是点车站管理器的入口：记下这块牌子（相对锚点）供 hitTest 反查
          const nameW = Math.max(16, ctx.measureText(st.name).width + 8);
          Transit._stationRects.push({
            id: st.id, lat: st.lat, lon: st.lon, label: 'name',
            dx: -nameW / 2, dy: -20, w: nameW, h: 14,
          });
        }
        // 等车人数徽标：默认放大到 z15 以上就画（老版本是 z16 —— 现在远一级也看得见），人越多颜色越红。
        // 这个数字每一帧都从 Transit.data.stations[].waiting 现取（数据由 ensureLiveWaiting 持续刷新），
        // 所以队伍涨/消能立刻看出来；10 秒窗口的涨跌再用一个小箭头标一下（↑ 变多 / ↓ 变少）。
        const waiting = Transit.stationWaiting(st);
        if (waiting > 0 && !hideFar && Transit.stationWaitingVisible(z)) {
          const text = waiting > 999 ? '999+' : String(waiting);
          const trend = Transit.waitingTrend(st);
          const arrow = trend.dir === 'up' ? '↑' : (trend.dir === 'down' ? '↓' : '');
          ctx.save();
          ctx.font = '700 10px "PingFang SC","Microsoft YaHei",sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const numW = ctx.measureText(text).width;
          if (arrow) ctx.font = '700 8px "PingFang SC","Microsoft YaHei",sans-serif';
          const arrowW = arrow ? ctx.measureText(arrow).width : 0;
          const bw = Math.max(13, numW + arrowW + (arrow ? 1.5 : 0) + 7);
          const bx = p.x + 6;
          const by = p.y + 6;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(bx, by, bw, 12, 6);
          else ctx.rect(bx, by, bw, 12);
          ctx.fillStyle = waiting >= 40 ? '#e63946' : (waiting >= 12 ? '#f4a261' : '#2a9d8f');
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.font = '700 10px "PingFang SC","Microsoft YaHei",sans-serif';
          ctx.fillText(text, bx + 3.5, by + 6.5);
          if (arrow) {
            // 趋势箭头：涨了偏黄、消了偏绿（颜色和徽标底色区分开，一眼能看出方向）
            ctx.font = '700 8px "PingFang SC","Microsoft YaHei",sans-serif';
            ctx.fillStyle = trend.dir === 'up' ? '#ffe08a' : '#c8f7d4';
            ctx.fillText(arrow, bx + 3.5 + numW + 1.5, by + 6.5);
          }
          ctx.restore();
          // 等车人数徽标也是点车站管理器的入口（和站名一样，不用非得点中圆点）
          Transit._stationRects.push({
            id: st.id, lat: st.lat, lon: st.lon, label: 'wait',
            dx: 6, dy: 6, w: bw, h: 12,
          });
        }
        ctx.restore();
      }
      // 4) 列车/公交：按真实车长与朝向画成一条"车身"（分级显示，公交要很近才画）
      const mpp = Render.metersPerPixel ? Render.metersPerPixel() : 2;
      const bubbles = [];   // 要在车旁边画信息泡泡的车（每一辆都画，重叠时靠 drawVehicleBubble 错开）
      for (const t of data.trains || []) {
        if (!Transit.vehicleVisible(t.kind, z)) continue;
        const p = P(t);
        if (!p) continue;
        const color = Transit.companyColor(t.companyId === undefined ? t.owner : t.companyId);
        const load = t.capacity ? t.load / t.capacity : 0;
        const lenM = t.lengthM || 20;
        // 车长换算成像素，太小时给个最小可视尺寸
        const px = Math.max(7, Math.min(90, lenM / mpp));
        const wid = Math.max(4, Math.min(12, px * 0.28));
        const heading = ((t.heading || 0) - 90) * (Math.PI / 180);   // 屏幕坐标下 y 向下
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(heading);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-px / 2, -wid / 2, px, wid, Math.min(3, wid / 2));
        else ctx.rect(-px / 2, -wid / 2, px, wid);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.stroke();
        if (load > 0.02) {
          ctx.beginPath();
          ctx.rect(-px / 2, -wid / 2 - 2.5, px * Math.min(1, load), 2);
          ctx.fillStyle = load > 0.9 ? '#ff4d4f' : '#ffd166';
          ctx.fill();
        }
        ctx.restore();
        // 自己公司的车（或鼠标悬停的车）在车身下面写一行名字+载客；视野太宽时和气泡一起不画
        if (!hideFar && (t.owner === Editor.myId || Transit.hoverTrain === t.id)) {
          ctx.save();
          ctx.font = '600 10px "PingFang SC","Microsoft YaHei",sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          ctx.fillStyle = '#fff';
          const text = `${t.name} ${t.load}/${t.capacity}${t.speed ? ' ' + t.speed + 'km/h' : ''}`;
          ctx.strokeText(text, p.x, p.y + wid + 12);
          ctx.fillText(text, p.x, p.y + wid + 12);
          ctx.restore();
        }
        if (!hideFar && Transit.vehicleBubbleVisible(z)) {
          bubbles.push({ t, p, wid, bus: !!BUS_VEHICLE_KINDS[t.kind] });
        }
      }
      // 5) 车辆信息泡泡（线路 · 载客/定员 · 下一站）：**每一辆车都有**，互相压住时上下错开位置，
      //    不再有"最多 8 个"的上限；只有图层里的「车辆气泡」开关关掉时才整块不画（图层面板上的开关）
      if (bubbles.length && Transit.vehicleBubblesOn()) {
        // 悬停的那辆车永远最优先，其次是公交（城市里公交最多，让它们在前面挑位置）
        bubbles.sort((a, b) => {
          const ha = Transit.hoverTrain === a.t.id ? 0 : (a.bus ? 1 : 2);
          const hb = Transit.hoverTrain === b.t.id ? 0 : (b.bus ? 1 : 2);
          return ha - hb || a.t.id - b.t.id;
        });
        const placed = [];
        for (const b of bubbles) {
          Transit.drawVehicleBubble(ctx, b.t, b.p, b.wid, placed, Transit.hoverTrain === b.t.id);
        }
      }
    },

    /**
     * 图层开关：Transit.showVehicleBubbles（图层面板上的"车辆信息泡泡"）。
     * 读不到就当作打开（默认 ON），另外也认 Transit.settings / UI.settings 上的同名字段。
     */
    vehicleBubblesOn() {
      const pick = (v) => (v === undefined || v === null ? null : !!v);
      let v = pick(Transit.showVehicleBubbles);
      if (v === null && window.G.UI && window.G.UI.settings) v = pick(window.G.UI.settings.showVehicleBubbles);
      if (v === null && window.G.Render && window.G.Render.showVehicleBubbles !== undefined) {
        v = pick(window.G.Render.showVehicleBubbles);
      }
      return v === null ? true : v;
    },

    /**
     * 开关车辆信息泡泡（图层面板上的复选框可以直接改 Transit.showVehicleBubbles，
     * 也可以叫这个方法；返回开关之后的状态）。
     */
    toggleVehicleBubbles(on) {
      const next = on === undefined ? !Transit.vehicleBubblesOn() : !!on;
      Transit.showVehicleBubbles = next;
      if (Render.overlay) Render.overlay.redraw();
      return next;
    },

    /**
     * 一辆车旁边的小泡泡：一行字「线路 · 载客/定员 · 下一站」，最大 110×16 像素。
     * 和已经画过的泡泡压在一起时**不隐藏**：先往上错开（每次一个泡泡高），
     * 错开 BUBBLE_STACK_MAX 层还撞就挪到车身下方 —— 总之每辆车都有泡泡。
     * 悬停的那辆车（force）永远用自己的默认位置，并且它占的位置别人会绕开。
     * 返回是否画了（现在只有参数不全时才返回 false）。
     */
    drawVehicleBubble(ctx, t, p, wid, placed, force) {
      if (!ctx || !t || !p) return false;
      const rects = Array.isArray(placed) ? placed : ((placed && placed.rects) || []);
      const line = Transit.lineById(t.lineId);
      // 线路名先按**字数**限长（>8 字 → 7 字 + …），下面再按**像素**额度截一刀：
      // 两层都只切名字，载客/定员那两个数一定留得住（泡泡尺寸不变，永远撑不破）。
      const lineName = Transit.shortLineName(line ? line.name : '未指派');
      const color = Transit.lineColor(line);
      const load = util.fmt(t.load || 0);
      const cap = util.fmt(t.capacity || 0);
      const next = Transit.shortLineName(Transit.nextStopName(t), BUBBLE_STOP_MAX_CHARS);
      ctx.save();
      ctx.font = '600 10px "PingFang SC","Microsoft YaHei",sans-serif';
      const padX = 5;
      const dotW = 7;
      const bubbleAvail = Math.max(8, BUBBLE_MAX_W - padX * 2 - dotW);   // 泡泡里够写字的宽度
      const core = ` · ${load}/${cap}`;                                  // 「载客/定员」必须看得见
      const coreW = ctx.measureText(core).width;
      // 线路名的像素额度：最多占泡泡的 45%，并且要给载客/定员留够位置（至少给 28 像素，免得只剩一个"…"）
      const nameMax = Math.max(28, Math.min(BUBBLE_MAX_W * BUBBLE_LINE_MAX_W_RATIO, bubbleAvail - coreW - 4));
      const nameText = ctx.measureText(lineName).width > nameMax ? Transit._fitText(ctx, lineName, nameMax) : lineName;
      // 下一站名吃剩下的宽度；连两个字的余地都没有就整截不写（宁可少一项，也不要只剩一个孤零零的"…"）
      const spare = bubbleAvail - ctx.measureText(nameText).width - coreW;
      const nextText = spare >= 30 ? Transit._fitText(ctx, ` · ${next}`, spare) : '';
      const text = nameText + core + nextText;
      const width = Math.min(BUBBLE_MAX_W, ctx.measureText(text).width + padX * 2 + dotW);
      // 最后一道保险：整行按可用宽度再截一次（怎么算都不会让字跑出框）
      const avail = Math.max(8, width - padX * 2 - dotW);
      const height = BUBBLE_H;
      const x = p.x - width / 2;
      const baseY = p.y - wid - 8 - height;      // 默认位置：贴在车身上方
      let y = baseY;
      if (!force) {
        // 往上叠：第 0 层是默认位置，依次往上是第 1..BUBBLE_STACK_MAX 层，找到不撞的那层就用它
        for (let i = 1; i <= BUBBLE_STACK_MAX; i++) {
          if (!Transit._bubbleHit(rects, x, y, width, height)) break;
          y = baseY - BUBBLE_STACK_STEP * i;
        }
        // 上下都挤满了就挪到车下方：宁可离车远一点，也不把这一辆藏掉
        if (Transit._bubbleHit(rects, x, y, width, height)) y = p.y + wid + 8;
      }
      rects.push({ x, y, w: width, h: height });
      // 记下这块泡泡（相对车身锚点的偏移），点击它 = 点击车身：都弹同一个车辆小气泡
      Transit._trainRects.push({
        id: t.id, lat: t.lat, lon: t.lon, label: 'bubble',
        dx: x - p.x, dy: y - p.y, w: width, h: height,
      });
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, width, height, 5);
      else ctx.rect(x, y, width, height);
      ctx.fillStyle = 'rgba(12,16,22,0.88)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.stroke();
      // 车色小圆点，一眼看出是哪条线
      ctx.beginPath();
      ctx.arc(x + padX + 2.5, y + height / 2, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(Transit._fitText(ctx, text, avail), x + padX + dotW, y + height / 2 + 0.5);
      ctx.restore();
      return true;
    },

    /** (x, y, w, h) 有没有和已经画过的泡泡压在一起 */
    _bubbleHit(rects, x, y, w, h) {
      if (!rects || !rects.length) return false;
      const rect = { x, y, w, h };
      return rects.some((r) => Transit._rectHit(r, rect));
    },

    /** 文字太长就截断加省略号（泡泡不能糊成一片） */
    _fitText(ctx, text, maxWidth) {
      let s = String(text == null ? '' : text);
      if (ctx.measureText(s).width <= maxWidth) return s;
      while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
      return s + '…';
    },

    /**
     * 气泡里的线路名限长：超过 max 个字就截成「前 max-1 个字 + …」（默认 8 个字，超过就变 7 字 + …）。
     * 按**字**数（Array.from 按码点切，一个汉字 / 一个 emoji 都算 1 个）而不是字节，
     * 这样"北京地铁首都机场线"这种长名字不会把泡泡里的载客/下一站挤掉（泡泡尺寸保持不变）。
     */
    shortLineName(name, max) {
      const chars = Array.from(String(name == null ? '' : name));
      const n = Math.max(2, Number(max) || BUBBLE_LINE_MAX_CHARS);
      if (chars.length <= n) return chars.join('');
      return chars.slice(0, n - 1).join('') + '…';
    },

    /** 两个矩形有没有压在一起（留 2px 空隙，泡泡挨太近也算压） */
    _rectHit(a, b) {
      const pad = 2;
      return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x ||
        a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
    },

    /** 这辆车下一站叫什么：按线路 stopsInfo 上的里程和行驶方向推 */
    nextStopName(t) {
      if (!t) return '—';
      const line = Transit.lineById(t.lineId);
      if (!line) return '未指派';
      const info = (line.stopsInfo || []).filter((s) => s && Number.isFinite(Number(s.distance)));
      const dist = Number(t.distance);
      if (!info.length || !Number.isFinite(dist)) return '—';
      if (Number(t.direction) < 0) {
        for (let i = info.length - 1; i >= 0; i--) {
          if (Number(info[i].distance) < dist - 1) return info[i].name || `#${info[i].stationId}`;
        }
        return info[0].name || '终点';
      }
      for (const s of info) {
        if (Number(s.distance) > dist + 1) return s.name || `#${s.stationId}`;
      }
      return info[info.length - 1].name || '终点';
    },

    /**
     * 在"上一帧画过的图形矩形"里找命中。
     *
     * 这些矩形（车辆信息泡泡 / 站名 / 等车人数徽标）是画在 canvas 上的，没有 DOM 可以点，
     * 所以 draw 时把它们记下来（坐标存的是**相对实体锚点**的偏移），这里用实体的实时容器坐标
     * 还原成矩形再和鼠标比 —— 偏移与画布那圈 OVERLAY_PAD 无关，所以缩放/平移都不会错位。
     * 倒着找：后画的盖在上面，先点到它，和肉眼看到的一致。
     */
    hitRectOf(list, pt) {
      const map = Render.map;
      if (!map || !Array.isArray(list) || !pt) return null;
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const q = map.latLngToContainerPoint([lat, lon]);
        const x = q.x + r.dx;
        const y = q.y + r.dy;
        if (pt.x >= x - BUBBLE_HIT_PAD && pt.x <= x + r.w + BUBBLE_HIT_PAD
          && pt.y >= y - BUBBLE_HIT_PAD && pt.y <= y + r.h + BUBBLE_HIT_PAD) return r;
      }
      return null;
    },

    /**
     * 命中测试：车辆信息泡泡 / 站名 / 等车徽标 / 车站圆点 / 车身。
     * 看不见的东西点不中：视野太宽或级别不够时这些东西根本没画，也就没有矩形可命中
     * （矩形是 draw 时收集的，draw 跳过 → 列表里就没有它）。
     */
    hitTest(latlng) {
      const data = Transit.data;
      if (!data) return null;
      const map = Render.map;
      if (!map) return null;
      const pt = map.latLngToContainerPoint(latlng);
      const z = Transit.zoom();
      const hideFar = Transit.viewTooWide();
      // 1) 车辆信息泡泡：点泡泡就等于点车身（弹同一份车辆小气泡），不用精确点中那根细车身
      const bub = Transit.hitRectOf(Transit._trainRects, pt);
      if (bub && (data.trains || []).some((t) => t.id === bub.id)) {
        return { type: 'train', id: bub.id, via: 'bubble' };
      }
      // 2) 站名 / 等车人数徽标：点它们也等于点车站圆点（只弹小气泡）
      const srect = Transit.hitRectOf(Transit._stationRects, pt);
      if (srect && Transit.stationById(srect.id)) {
        return { type: 'station', id: srect.id, via: srect.label || 'label' };
      }
      // 3) 车站圆点（老行为：12 像素以内）—— 和点站名 / 点等车徽标是同一条路：
      //    都返回 { type:'station', id }，交给 selectOnMap → selectStation 弹那个小气泡
      //    （只弹气泡：不切分区、不开任何管理器，见 selectOnMap 的契约）
      if (!hideFar) {
        for (const st of data.stations || []) {
          if (!Transit.stationVisible(st.kind, z)) continue;
          const p = map.latLngToContainerPoint([st.lat, st.lon]);
          if (Math.hypot(p.x - pt.x, p.y - pt.y) <= 12) return { type: 'station', id: st.id, via: 'dot' };
        }
      }
      // 4) 车身（老行为：12 像素以内）
      for (const t of data.trains || []) {
        if (typeof t.lat !== 'number') continue;
        const p = map.latLngToContainerPoint([t.lat, t.lon]);
        if (Math.hypot(p.x - pt.x, p.y - pt.y) <= 12) return { type: 'train', id: t.id };
      }
      return null;
    },

    /* ------------------------------ 面板 ------------------------------ */
    /**
     * 只有一个面板：标题栏 = 放大 + 折叠 + 关闭（原来那个「🛠 管理器」按钮已经下线），
     * 主体 = 分区那一排（只有分区，没有别的启动器）+ 左侧列表 + 右侧详情。
     * **交通公司面板本身就是管理器，每个分区就是那个管理器**（公司 / 车站 / 线路 / 车辆 / 异常清单）。
     * 独立窗口那一整套（车站 / 线路 / 车辆 / 公司 / 运营五个浮窗）已经删掉：管理器只有这一个家，
     * 地图上的一次点击只弹那个小气泡，不会再长出第二个界面。
     * 运营数据并进「公司」分区，不再单独占一个页签。
     *
     * 面板与整条右栏（#inspector / #toolopts 所在的 #rightcol）互相让位是**面板自己**的老规矩
     * （具体在 ui.js 的 initRightRail 里包了 openPanel / closePanel）。
     */
    openPanel(tab) {
      injectTransitStyle();
      Transit._bindPopup();
      Transit.panelOpen = true;
      if (tab) {
        const t = tab === 'stats' ? 'company' : tab;
        // 认不出来的分区（含老调用传的 'all'）落到「公司」，不留一个不存在的分区名在状态里
        Transit.panelTab = Transit.SECTION_LABEL[t] === undefined ? 'company' : t;
      }
      util.$('#transit').classList.remove('hidden');
      util.$('#inspector').classList.add('hidden');
      const sizeBtn = util.$('#transit-size');
      if (sizeBtn && !sizeBtn.onclick) sizeBtn.onclick = () => Transit.toggleBig();
      if (Transit.bigPanel) util.$('#transit').classList.add('big');
      // 折叠状态由 UI 记着（.panel-collapsed 在元素上，重渲染也不会丢）
      if (window.G.UI && window.G.UI.applyPanelCollapsed) window.G.UI.applyPanelCollapsed('transit');
      Transit.ensureStationKinds();
      Transit.renderPanel();
      return Transit;
    },

    closePanel() {
      Transit.panelOpen = false;
      // 面板一关，右侧那些编辑器就不在了：手里的元素锁当场放掉（不然别人要等到 TTL 超时）
      Transit.clearLockWant('panel');
      util.$('#transit').classList.add('hidden');
      util.$('#inspector').classList.remove('hidden');
      if (Transit.addingStopsTo) { Transit.addingStopsTo = null; util.statusHint(''); }
      const mgr = window.G.LineMgr;
      if (mgr && typeof mgr.detach === 'function') mgr.detach();
    },

    renderPanelSoon() {
      if (Transit._panelTimer) return;
      Transit._panelTimer = setTimeout(() => {
        Transit._panelTimer = null;
        if (!Transit.panelOpen) return;
        if (Transit.panelTyping()) { Transit.renderListOnly(); return; }
        Transit.renderPanel();
      }, 200);
    },

    /* ------------------------------ 面板：分区 / 筛选 / 排序 ------------------------------ */

    /**
     * 面板分区 —— **只有这五个**，没有「全部」：
     * 公司 / 车站 / 线路 / 车辆是四种不同种类的东西，混在一个列表里只会让人看不清；
     * 「异常清单」不是"全部"，它是一份挑出来的毛病清单（空线路 / 路径不通 / 悬空车站）。
     * （老的 'stats' 并入公司：运营数据不再单独一个页签。）
     */
    SECTION_LABEL: { company: '公司', stations: '车站', lines: '线路', vehicles: '车辆', issues: '异常清单' },

    /** 当前分区；认不出来的（含老页面残留的 'all'）一律落到「公司」 */
    section() {
      const t = Transit.panelTab === 'stats' ? 'company' : Transit.panelTab;
      return Transit.SECTION_LABEL[t] === undefined ? 'company' : t;
    },

    setSection(id) {
      const next = id === 'stats' ? 'company' : id;
      Transit.panelTab = Transit.SECTION_LABEL[next] === undefined ? 'company' : next;
      Transit.selected = null;          // 换分区就把选中收起来：详情跟着分区走
      Transit.addingStopsTo = Transit.addingStopsTo && Transit.panelTab === 'lines' ? Transit.addingStopsTo : null;
      Transit.renderPanel();
    },

    /** 异常清单的账（空线路 / 路径不通 / 悬空车站）：「异常清单」分区那一格的数字与提示用它 */
    issueCounts() {
      const lines = (Transit.data && Transit.data.lines) || [];
      const stations = (Transit.data && Transit.data.stations) || [];
      let badLines = 0;
      for (const l of lines) if (Transit.lineProblem(l).bad) badLines += 1;
      let orphanStations = 0;
      for (const s of stations) if (!(s.nodeId || s.onRail)) orphanStations += 1;
      return { badLines, orphanStations, total: badLines + orphanStations };
    },

    /** 面板是"大窗口"还是贴在右边的小面板 */
    toggleBig(on) {
      Transit.bigPanel = on === undefined ? !Transit.bigPanel : !!on;
      const box = util.$('#transit');
      if (box) box.classList.toggle('big', Transit.bigPanel);
      const btn = util.$('#transit-size');
      if (btn) btn.textContent = Transit.bigPanel ? '⤡ 缩小' : '⤢ 放大';
      Transit.renderPanel();
    },

    setFilter(patch) {
      Object.assign(Transit.filters, patch || {});
      Transit.resetLimits();
      Transit.renderPanel();
    },

    resetLimits() {
      Transit.limits = { companies: LIST_LIMIT, stations: LIST_LIMIT, lines: LIST_LIMIT, vehicles: LIST_LIMIT };
    },

    lineById(id) {
      return ((Transit.data && Transit.data.lines) || []).find((l) => l.id === Number(id)) || null;
    },

    vehicleById(id) {
      return ((Transit.data && Transit.data.vehicles) || []).find((v) => v.id === Number(id)) || null;
    },

    companyById(id) {
      return ((Transit.data && Transit.data.companies) || []).find((c) => c.id === Number(id)) || null;
    },

    /** 模拟帧里的实时车辆数据（载客 / 状态 / 速度）：车 id 与 runtime id 一致 */
    liveVehicle(id) {
      return ((Transit.data && Transit.data.trains) || []).find((t) => t.id === Number(id)) || null;
    },

    /**
     * 一次数据版本内算好的索引：几百个车站 / 线路排序时不至于每次都 O(n×m)。
     * 车辆按线路计数、车站接入的线路数、每条线路的等车人数合计都在这里。
     */
    indexes() {
      if (Transit._idx && Transit._idxTick === Transit._dataTick) return Transit._idx;
      const vehByLine = new Map();
      const linesByStation = new Map();
      const waitByStation = new Map();
      const waitByLine = new Map();
      const stationsOfLine = new Map();
      const d = Transit.data || {};
      for (const v of d.vehicles || []) {
        const k = Number(v.lineId);
        if (Number.isFinite(k) && k) vehByLine.set(k, (vehByLine.get(k) || 0) + 1);
      }
      for (const l of d.lines || []) {
        const stops = Array.isArray(l.stops) ? l.stops.map(Number) : [];
        stationsOfLine.set(Number(l.id), stops);
        for (const sid of stops) linesByStation.set(sid, (linesByStation.get(sid) || 0) + 1);
      }
      for (const s of d.stations || []) waitByStation.set(Number(s.id), Transit.stationWaiting(s));
      for (const l of d.lines || []) {
        let sum = 0;
        for (const sid of stationsOfLine.get(Number(l.id)) || []) sum += waitByStation.get(sid) || 0;
        waitByLine.set(Number(l.id), sum);
      }
      Transit._idx = { vehByLine, linesByStation, waitByStation, waitByLine, stationsOfLine };
      Transit._idxTick = Transit._dataTick;
      return Transit._idx;
    },

    lineVehicleCount(line) { return Transit.indexes().vehByLine.get(Number(line && line.id)) || 0; },
    stationsOfLine(id) { return Transit.indexes().stationsOfLine.get(Number(id)) || []; },
    stationsLineCount(stationId) { return Transit.indexes().linesByStation.get(Number(stationId)) || 0; },
    lineWaiting(line) { return Transit.indexes().waitByLine.get(Number(line && line.id)) || 0; },

    /** 线路有没有毛病：空线路 / 路径不通 / 没有车（面板与线路管理器共用同一份判断） */
    lineProblem(line) {
      const mgr = window.G.LineMgr;
      if (mgr && typeof mgr.lineProblem === 'function') return mgr.lineProblem(line);
      const stops = (line && line.stops) || [];
      const empty = stops.length < 2;
      const broken = !!(line && line.pathError);
      return { empty, broken, noVehicle: Transit.lineVehicleCount(line) === 0, bad: empty || broken };
    },

    /** 一家公司的车站 / 线路 / 车辆数（公司通常只有几家，直接数一遍就行） */
    companyCounts(cid) {
      const d = Transit.data || {};
      const out = { stations: 0, lines: 0, vehicles: 0, running: 0 };
      for (const s of d.stations || []) if (s.companyId === cid) out.stations += 1;
      for (const l of d.lines || []) if (l.companyId === cid) out.lines += 1;
      for (const v of d.vehicles || []) {
        if (v.companyId !== cid) continue;
        out.vehicles += 1;
        const live = Transit.liveVehicle(v.id);
        if (v.lineId && ((live && live.state) || v.state)) out.running += 1;
      }
      return out;
    },

    /**
     * #车厂：「这辆车现在是在运营，还是在车厂」—— **客户端唯一口径**（列表 / 详情 / 状态文字都走它）。
     *
     * 服务端口径（唯一权威，server/transit.js 的 serviceStateOf）：**只有正在线路上运营的车才进帧的 trains[]**；
     * 闲置的、线路暂停后已回车厂的、班次车还没到发车时刻 / 当天班次已跑完的，一律留在 vehicles[] 里，
     * 带 inService:false + depotReason + depotNote（中文）。
     *
     * 所以这里按这个顺序判（先新鲜、后权威，绝不瞎猜）：
     *   ① 帧里（data.trains）有它 → 在运营（帧只发在运营的车）；
     *   ② 没有帧数据，但服务端那份 vehicles[] 说 inService:false（或 depot:true）→ 在车厂，原因用服务端的；
     *   ③ 没指派线路 → 闲置（本来就不在地图上）；
     *   ④ "我自己的车一定在帧里"（服务端口径：自己的车永远带，除非它不在运营）→ 帧里没有它 = 它在车厂。
     *      这一条让"线路一暂停 / 班次跑完"在列表里**当帧就变**，不必等下一份整快照；
     *   ⑤ 其余情况（别人的车、开在我视野外）**不猜**：照旧显示运行状态，不硬说它在车厂。
     *
     * 返回（全部字段都给了，调用方不用再判空）：
     *   depot    是否在车厂（= 现在不该出现在地图上）
     *   reason   服务端的原因键（idle / paused / before-departure / service-ended / …），推断出来时为 null
     *   short    '在车厂（未运营）' / ''
     *   note     原因那句中文（不含前缀）
     *   nextText '下一班 08:15' / ''（在车厂的车下一次从车厂发车的时刻）
     *   text     状态那一格要显示的一整句（'' = 不在车厂，用原来的运行状态文字）
     */
    vehicleDepotInfo(v, live) {
      const run = { depot: false, reason: null, short: '', note: '', nextText: '', text: '' };
      if (!v) return run;
      if (live || Transit.liveVehicle(v.id)) return run;          // ① 帧里有它 = 在运营
      const line = v.lineId != null ? Transit.lineById(v.lineId) : null;
      const paused = Transit.linePaused(line);
      const finish = (reason, note) => {
        // 线路暂停运营时**没有"下一班"**（服务端也是这么报的：paused → nextDeparture=null），
        // 所以那一格只留「在车厂（未运营）· 线路已暂停运营，车辆已回车厂」。
        const next = paused ? '' : Transit.vehicleNextDepartureText(v);
        const nextText = next ? `下一班 ${next}` : '';
        const parts = [DEPOT_PREFIX];
        if (nextText) parts.push(nextText);
        if (note) parts.push(note);
        return { depot: true, reason, short: DEPOT_PREFIX, note, nextText, text: parts.join(' · ') };
      };
      if (!v.lineId) return finish('idle', DEPOT_REASON_TEXT.idle);   // ③ 闲置（没线路）
      // ② 服务端那份快照说了算（含"为什么"）
      if (v.inService === false || v.depot === true) {
        const reason = paused ? 'paused' : (v.depotReason || null);
        const serverNote = v.depotNote ? String(v.depotNote).replace(/^在车厂（未运营）·\s*/, '') : '';
        const note = paused ? DEPOT_REASON_TEXT.paused : (serverNote || DEPOT_REASON_TEXT[reason] || '');
        return finish(reason, note);
      }
      // ④ 我自己的车一定会被发给我（除非它不在运营）—— 帧里没有它 = 它回车厂了
      const mine = v.owner != null && Transit.myId() != null && String(v.owner) === String(Transit.myId());
      if (mine && (Transit._trainFrames || 0) > 0) {
        return finish(paused ? 'paused' : 'run-ended',
          paused ? DEPOT_REASON_TEXT.paused : '已经没有在跑的班次（下一次从车厂发车）');
      }
      return run;                                                  // ⑤ 别人的车 / 没帧数据：不猜
    },

    /**
     * 在车厂的车"下一班"几点从车厂发车（'HH:MM'）：
     *   服务端的 scheduledDepartureTime（它自己那一班的计划发车时刻）优先；
     *   没有就退到这条线路上"派给这辆车"的下一班（line.runs 里 vehicleId 对得上的）。
     */
    vehicleNextDepartureText(v) {
      if (!v) return '';
      const direct = Transit.fmtClock(v.scheduledDepartureTime || v.scheduledDeparture);
      if (direct) return direct;
      const line = v.lineId != null ? Transit.lineById(v.lineId) : null;
      const clock = Transit.clockText();
      const mine = Transit.lineRuns(line)
        .map((r) => ({ at: Transit.runTime(r), id: Number(r && (r.vehicleId != null ? r.vehicleId : r.vehicle)) }))
        .filter((x) => x.at && x.id === Number(v.id))
        .map((x) => x.at)
        .sort();
      if (!mine.length) return '';
      return mine.filter((at) => !clock || at >= clock)[0] || mine[0];
    },

    vehicleStateText(v, live) {
      if (!v) return '—';
      if (!v.lineId) return '闲置（没指派线路）';
      // #车厂：不在运营的车说清"它在车厂、为什么、下一班几点"
      const depot = Transit.vehicleDepotInfo(v, live);
      if (depot.depot) return depot.text;
      const st = (live && live.state) || v.state;
      const speed = Number((live && live.speed) || v.speed || 0);
      if (st === 'dwell') return '停站中';
      if (speed > 0) return `运行中 · ${Math.round(speed)} km/h`;
      return st === 'run' ? '运行中' : '待发车';
    },

    /**
     * 这辆车最近一次停站上了几个人（服务端 sim 帧里的 lastBoarded / lastServedStation）。
     * 这是"按线路分队"最直观的验收：2 号线的车进站，只上等 2 号线的人 —— 这里的数字
     * 正好等于那个站台上等 2 号线的人数，而载客那一行同时涨了同样的数。
     */
    vehicleBoardText(live) {
      const n = Math.round(Number(live && live.lastBoarded) || 0);
      if (!live || live.lastServedStation == null) return '—';
      const st = Transit.stationById(live.lastServedStation);
      const where = st ? st.name : `#${live.lastServedStation}`;
      const off = Math.round(Number(live.lastAlighted) || 0);
      const tail = off > 0 ? ` · 下客 ${util.fmt(off)} 人` : '';
      return `${where} +${util.fmt(n)} 人${tail}`;
    },

    trendArrow(trend) {
      const tr = trend || { dir: 'flat', delta: 0 };
      if (tr.dir === 'up') return `↑ +${util.fmt(tr.delta)}`;
      if (tr.dir === 'down') return `↓ ${util.fmt(tr.delta)}`;
      return '→ 0';
    },

    /* ------------------------------ 面板：统一筛选 / 排序 ------------------------------ */

    /** 统一入口：过滤 + 排序（面板和线路管理器都走它，规则只有一份） */
    query(type, list, f) {
      const flt = f || Transit.filters;
      return Transit.sortList(type, Transit.applyFilters(type, list || [], flt), flt.sort, flt.dir);
    },

    isMineItem(type, x) {
      return Transit.isMyCompanyAsset(type, x);
    },

    /**
     * "挂在我名下"的口径（**只是筛选 / 高亮用的，不是权限**）：
     * 公司是我的，或者这条车站 / 线路 / 车辆属于我的一家公司（或 owner 就是我）。
     * 改别人的东西**不看它** —— 客户端唯一会拦的只有元素锁（别人正在改这个元素），
     * 归属 / 是不是底图导入的站在这里都只是"筛选与徽标"。
     */
    isMyCompanyAsset(type, x) {
      if (!x) return false;
      if (type === 'companies') return Transit.myCompanies().some((c) => c.id === x.id);
      const ids = Transit.myCompanyIdSet();
      if (x.companyId != null && ids.has(x.companyId)) return true;
      return !!Editor.myId && x.owner === Editor.myId;
    },

    /**
     * 车站「来源」标签：这个站是不是底图导入的公共站（服务端 import.stations 建的，挂在系统公司名下）。
     *
     * **它不是权限，只是来源**：服务端早就取消了车站归属 —— 任何玩家都能改名 / 删除 / 挪动任何车站，
     * 底图导入的站也一样（imported / osm_type / osm_id 只是说明性信息）。所以这个函数只干两件事：
     *   · 「来源」筛选：全部 / 我的 / 公共·导入（见 filterStationsBySource）；
     *   · 列表与详情上的那一枚「公共·导入」徽标。
     * 唯一还拦得住编辑的只有**元素锁**（别人正在改这个站）—— 那跟归属 / 来源都没关系。
     */
    isPublicStation(station) {
      if (!station) return false;
      if (station.imported || station.isPublic) return true;
      return station.owner != null && String(station.owner) === '__system__';
    },

    /** 车站「来源」筛选：all = 数据集里的全部车站（含公共·导入与别家的），mine = 我的，public = 公共·导入 */
    filterStationsBySource(list, source) {
      const src = source === undefined || source === null || source === '' ? 'all' : String(source);
      if (src === 'mine') return list.filter((s) => Transit.isMineItem('stations', s));
      if (src === 'public') return list.filter((s) => Transit.isPublicStation(s));
      return list;
    },

    applyFilters(type, list, f) {
      let out = list;
      const flt = f || {};
      const company = flt.company === undefined ? 'mine' : flt.company;
      if (type === 'stations') {
        // 车站这一栏用「来源」筛选（全部 / 我的 / 公共·导入）代替「公司」筛选：
        // 否则默认的"只看我的公司"会把数据集里导入的 OSM 公共车站全部挡掉，列表看着永远是空的。
        out = Transit.filterStationsBySource(out, flt.source);
      } else if (company === 'mine') out = out.filter((x) => Transit.isMineItem(type, x));
      else if (company !== 'all') {
        const cid = Number(company);
        out = out.filter((x) => (type === 'companies' ? Number(x.id) === cid : Number(x.companyId) === cid));
      }
      if (flt.kind && flt.kind !== 'all') out = out.filter((x) => x.kind === flt.kind);
      if (flt.line && flt.line !== 'all') {
        const lid = Number(flt.line);
        if (type === 'stations') {
          const stops = Transit.stationsOfLine(lid);
          out = out.filter((x) => stops.includes(Number(x.id)));
        } else if (type === 'lines') {
          out = out.filter((x) => Number(x.id) === lid);
        } else if (type === 'vehicles') {
          out = out.filter((x) => Number(x.lineId) === lid);
        } else {
          out = [];
        }
      }
      if (flt.status && flt.status !== 'all') out = out.filter((x) => Transit.matchStatus(type, x, flt.status));
      const q = String(flt.search || '').trim().toLowerCase();
      if (q) out = out.filter((x) => String(x.name == null ? '' : x.name).toLowerCase().includes(q));
      return out;
    },

    /**
     * 状态筛选：只对"讲得通"的类型生效（选了「闲置」就只剩闲置车辆，选「空线路」就只剩空线路），
     * 其它类型在这种状态下不显示，免得筛完还混着一堆无关的条目。
     */
    matchStatus(type, item, status) {
      if (!status || status === 'all') return true;
      if (type === 'lines') {
        const p = Transit.lineProblem(item);
        if (status === 'ok') return !p.bad;
        if (status === 'broken') return p.broken;
        if (status === 'empty') return p.empty;
        if (status === 'novehicle') return p.noVehicle;
        return false;
      }
      if (type === 'stations') {
        const online = !!(item.nodeId || item.onRail);
        if (status === 'ok') return online;
        if (status === 'offline' || status === 'broken') return !online;
        if (status === 'waiting') return Transit.stationWaiting(item) > 0;
        if (status === 'noline') return Transit.stationsLineCount(item.id) === 0;
        return false;
      }
      if (type === 'vehicles') {
        const live = Transit.liveVehicle(item.id);
        const load = Number((live && live.load) || item.load || 0);
        if (status === 'idle') return !item.lineId;
        if (status === 'assigned' || status === 'ok') return !!item.lineId;
        if (status === 'running') {
          return !!item.lineId && (((live && live.state) || item.state) === 'run' || Number((live && live.speed) || 0) > 0);
        }
        if (status === 'full') return item.capacity ? load / item.capacity > 0.8 : false;
        return false;
      }
      return true;
    },

    /**
     * 一列当前的值：名称 / 经过的线路数 / 站数 / 车辆数 / 日客流 / 覆盖人口 / 等车人数 / 载客 / 定员 / 车长…
     * 键按分区各用各的（见 SORT_DEFS_BY_TYPE）；老键（stops / vehicles / riders / waiting）继续保留，
     * 这样「异常清单」这个混排分区（以及线路管理器传进来的 filters）不用改。缺的列按 0 算。
     */
    metricOf(type, item, key) {
      if (key === 'name') return String((item && item.name) || '');
      if (type === 'lines') {
        if (key === 'stops') return (item.stops || []).length;
        if (key === 'vehicles') return Transit.lineVehicleCount(item);
        if (key === 'riders') return Number(item.dailyTrips || 0);
        if (key === 'waiting') return Transit.lineWaiting(item);
      }
      if (type === 'stations') {
        // 「经过的线路数」= 有多少条线路的 stops 里带着这个车站（和车站行里显示的"线路 N"同一个数）
        if (key === 'lines' || key === 'stops') return Transit.stationsLineCount(item.id);
        if (key === 'pop' || key === 'riders') return Number((item.catchment || {}).pop || 0);   // 覆盖人口
        if (key === 'waiting') return Transit.stationWaiting(item);
        if (key === 'vehicles') return 0;
      }
      if (type === 'vehicles') {
        if (key === 'load' || key === 'riders' || key === 'waiting') {
          const live = Transit.liveVehicle(item.id);
          return Number((live && live.load) || item.load || 0);
        }
        if (key === 'capacity' || key === 'stops') return Number(item.capacity || 0);
        if (key === 'length' || key === 'vehicles') return Number(item.lengthM || 0);
        if (key === 'kind') return String(Transit.kindLabel(item.kind) || '');
      }
      if (type === 'companies') {
        const c = Transit.companyCounts(item.id);
        if (key === 'stations' || key === 'stops') return c.stations;
        if (key === 'lines') return c.lines;
        if (key === 'vehicles') return c.vehicles;
        if (key === 'riders' || key === 'waiting') return Number(item.riders || 0);   // 累计客流
      }
      return 0;
    },

    sortList(type, list, sort, dir) {
      if (!sort || sort === 'default' || !list.length) return list;
      const sign = dir === 'asc' ? 1 : -1;
      return list.slice().sort((a, b) => {
        const va = Transit.metricOf(type, a, sort);
        const vb = Transit.metricOf(type, b, sort);
        if (typeof va === 'string' || typeof vb === 'string') {
          return sign * String(va).localeCompare(String(vb), 'zh');
        }
        return sign * (va - vb) || String(a.name || '').localeCompare(String(b.name || ''), 'zh');
      });
    },

    visibleStations() { return Transit.query('stations', (Transit.data && Transit.data.stations) || []); },
    visibleLines() { return Transit.query('lines', (Transit.data && Transit.data.lines) || []); },
    visibleVehicles() { return Transit.query('vehicles', (Transit.data && Transit.data.vehicles) || []); },

    /** 当前分区能排的列（排序芯片按这个表画，键与标签一一对应） */
    sortDefs(section) {
      const s = section || Transit.section();
      if (s === 'stations') return SORT_DEFS_BY_TYPE.stations;
      if (s === 'lines') return SORT_DEFS_BY_TYPE.lines;
      if (s === 'vehicles') return SORT_DEFS_BY_TYPE.vehicles;
      if (s === 'company') return SORT_DEFS_BY_TYPE.companies;
      return SORT_DEFS_BY_TYPE.mixed;      // 「异常清单」：异常线路 + 悬空车站两种实体，用通用键
    },

    /** 这一列的默认方向：数字大的先来（等车人数 / 客流 / 线路数…），名称按字典序升序 */
    sortDefaultDir(key) { return SORT_DESC_KEYS[key] ? 'desc' : 'asc'; },

    /**
     * 点排序芯片：换一列 → 按这一列的默认方向排；**点的就是当前这一列 → 正序/倒序翻过来**。
     * 芯片上的箭头（↑/↓）由 _syncSortChips 画，右边的方向芯片跟着一起变。
     */
    toggleSort(key) {
      const f = Transit.filters;
      if (f.sort === key) f.dir = f.dir === 'desc' ? 'asc' : 'desc';
      else { f.sort = key; f.dir = Transit.sortDefaultDir(key); }
      Transit.resetLimits();
      Transit._syncSortChips();
      Transit.renderListOnly();
    },

    /** 单独翻方向（排序条右边那个芯片）：正序 ↔ 倒序 */
    toggleSortDir() {
      Transit.filters.dir = Transit.filters.dir === 'desc' ? 'asc' : 'desc';
      Transit.resetLimits();
      Transit._syncSortChips();
      Transit.renderListOnly();
    },

    /** 排序芯片上的文字：当前这一列带箭头（↑ 正序 / ↓ 倒序），别的列只有列名 */
    sortChipLabel(key, label) {
      if (Transit.filters.sort !== key || key === 'default') return label;
      return label + (Transit.filters.dir === 'asc' ? ' ↑' : ' ↓');
    },

    sortChipTitle(key, label) {
      const f = Transit.filters;
      if (key === 'default') return '按服务端给的顺序';
      if (f.sort === key) {
        return `当前按「${label}」${f.dir === 'asc' ? '正序（升序）' : '倒序（降序）'} —— 再点一下换成${f.dir === 'asc' ? '倒序' : '正序'}`;
      }
      return `按「${label}」排序（${Transit.sortDefaultDir(key) === 'desc' ? '从多到少' : '从头到尾'}，再点一下反向）`;
    },

    /** 排序条：每个分区一套可排的列（车站有「经过的线路数」，线路看站数/客流…），箭头画在当前那一列上 */
    renderSortBar(bar) {
      if (!bar) return;
      const defs = Transit.sortDefs();
      const f = Transit.filters;
      // 换了分区（能排的列不一样了）就退回默认：旧列在现在这类实体上没有意义
      if (!defs.some(([k]) => k === f.sort)) f.sort = 'default';
      bar.innerHTML = '';
      bar.appendChild(util.el('span', 'tp-sortlabel', '排序'));
      for (const [key, label] of defs) {
        const on = f.sort === key;
        const chip = util.el('button', 'chip tp-sortchip' + (on ? ' active' : ''), Transit.sortChipLabel(key, label));
        chip.dataset.sort = key;
        chip.title = Transit.sortChipTitle(key, label);
        chip.onclick = () => Transit.toggleSort(key);
        bar.appendChild(chip);
      }
      const dir = util.el('button', 'chip tp-sortdir', f.dir === 'desc' ? '↓ 降序' : '↑ 升序');
      dir.title = '切换排序方向：正序（升序）↔ 倒序（降序）';
      dir.onclick = () => Transit.toggleSortDir();
      bar.appendChild(dir);
    },

    /** 排序芯片上的箭头 / 高亮 / 提示跟着 filters 走（能就地改就不重建，鼠标下的芯片不会被换掉） */
    _syncSortChips() {
      const bar = util.$('#transit-body .tp-sortbar');
      if (!bar) return;
      const defs = Transit.sortDefs();
      const chips = util.$$('#transit-body .tp-sortbar .tp-sortchip');
      if (chips.length !== defs.length || chips.some((c, i) => c.dataset.sort !== defs[i][0])) {
        Transit.renderSortBar(bar);      // 分区换了：可排的列不一样，整条重建
        return;
      }
      chips.forEach((chip, i) => {
        const [key, label] = defs[i];
        const text = Transit.sortChipLabel(key, label);
        if (chip.textContent !== text) chip.textContent = text;
        chip.classList.toggle('active', Transit.filters.sort === key);
        chip.title = Transit.sortChipTitle(key, label);
      });
      const dir = util.$('#transit-body .tp-sortbar .tp-sortdir');
      if (dir) dir.textContent = Transit.filters.dir === 'desc' ? '↓ 降序' : '↑ 升序';
    },

    /* ------------------------------ 面板：选中 / 实时刷新 ------------------------------ */

    selection() {
      const s = Transit.selected;
      if (!s) return null;
      if (s.type === 'station') return Transit.stationById(s.id) ? s : null;
      if (s.type === 'line') return Transit.lineById(s.id) ? s : null;
      if (s.type === 'vehicle') return Transit.vehicleById(s.id) ? s : null;
      return null;
    },

    /** 点列表里的一行：车站 → 站点管理器；线路 → 站点顺序/车辆/客流；车辆 → 载客/指派 */
    selectEntity(type, id) {
      Transit.selected = { type, id: Number(id) };
      if (type === 'station') { Transit.selectedStation = Number(id); Transit.ensureLiveStation(); }
      else if (type === 'line') Transit.selectedLine = Number(id);
      else if (type === 'vehicle') Transit.selectedVehicle = Number(id);
      if (Render.overlay) Render.overlay.redraw();
      // 分区和选中的东西对不上（比如在"车站"分区里选中了一条线路）就先把分区切过去，
      // 否则右侧会显示另一个分区的总览，玩家会以为点了没反应。
      const need = type === 'station' ? 'stations' : (type === 'line' ? 'lines' : 'vehicles');
      const section = Transit.section();
      const mismatch = section !== 'company' && section !== 'issues' && section !== need;
      if (mismatch) {
        Transit.panelTab = need;
        Transit.renderPanel();
        return;
      }
      Transit.renderDetailOnly();
      if (!Transit._listHover) Transit.renderListOnly();   // 列表最多 80 行，重画一下就为高亮
    },

    /** 加站模式里点车站行 = 直接加进那条线路；否则就是选中它 */
    rowPick(type, item) {
      if (!item) return;
      if (type === 'stations' && Transit.addingStopsTo) {
        Transit.appendStop(Transit.addingStopsTo, item.id);
        return;
      }
      if (type === 'lines') { Transit.selectEntity('line', item.id); return; }
      if (type === 'vehicles') {
        Transit.selectEntity('vehicle', item.id);
        // 点车辆行 = 面板右侧看详情 + 地图上弹出同一个车辆详情气泡（车不在视野里就先移过去）
        Transit.openVehicleDetail(item.id, null, { silent: true });
        return;
      }
      Transit.selectEntity('station', item.id);
    },

    /** 玩家是不是正在面板的输入框里打字（这时别整块重建 DOM，光标会丢） */
    panelTyping() {
      const a = document.activeElement;
      const box = util.$('#transit-body');
      if (!a || !box || typeof box.contains !== 'function' || !box.contains(a)) return false;
      const tag = (a.tagName || '').toLowerCase();
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      const type = (a.type || 'text').toLowerCase();
      // 班次编辑器（linemgr.js）里的时间框也要算进来，不然模拟帧一来就把正在填的时间冲掉
      return type === 'text' || type === 'search' || type === 'number' || type === 'email' || type === 'url' || type === 'time';
    },

    /** 就地改详情里的一个实时数字（模拟帧每 500ms 调一次，比整块重建便宜得多） */
    _setLive(box, key, text) {
      if (!box || !text) return;
      const el = box.querySelector(`[data-live="${key}"] b`);
      if (el && el.textContent !== text) el.textContent = text;
    },

    /** 模拟帧：只更新详情里的实时数字，不重建面板 */
    renderDetailLive() {
      if (!Transit.panelOpen) return;
      const box = util.$('#transit-body .tp-detail');
      if (!box) return;
      if (Transit.panelTyping()) return;
      const sel = Transit.selection();
      const section = Transit.section();
      if (sel && sel.type === 'vehicle') {
        const v = Transit.vehicleById(sel.id);
        if (v) {
          const live = Transit.liveVehicle(v.id);
          const run = Transit.vehicleRunInfo(v, live);
          Transit._setLive(box, 'vload', run.loadText);
          Transit._setLive(box, 'vnext', run.nextStop);
          Transit._setLive(box, 'veta', run.etaText);
          Transit._setLive(box, 'vboard', Transit.vehicleBoardText(live));
          Transit._setLive(box, 'vstate', Transit.vehicleStateText(v, live));
          // 班次那一行要能变红（晚点），所以单独就地改：文本 + warn 类
          const schedEl = box.querySelector('[data-live="vsched"] b');
          if (schedEl) {
            const txt = Transit.vehicleSchedText(run);
            if (schedEl.textContent !== txt) schedEl.textContent = txt;
            schedEl.classList.toggle('warn', !!run.late);
          }
        }
      } else if (sel && sel.type === 'line') {
        const mgr = window.G.LineMgr;
        if (mgr && typeof mgr.liveRefresh === 'function') mgr.liveRefresh();
      } else {
        const c = Transit.company();
        if (c && (section === 'company' || !sel)) {
          const eco = Transit.config && Transit.config.economy;
          if (eco) {
            Transit._setLive(box, 'cash', util.fmt(c.cash) + ' 元');
            Transit._setLive(box, 'revenue', util.fmt(c.revenue) + ' 元');
            Transit._setLive(box, 'spent', util.fmt(c.spent) + ' 元');
          }
          Transit._setLive(box, 'riders', util.fmt(c.riders) + ' 人次');
        }
      }
      if (Transit._stMgrLive) Transit.refreshStationMgr();
      // 只有选中车辆时列表里才有每帧都在变的数字（载客/状态），其它情况不乱重画
      if (sel && sel.type === 'vehicle') {
        if (Transit._listHover) Transit._listDirty = true;   // 鼠标压着列表：松手后再补画一次
        else Transit.renderListOnly();
      }
    },

    /** 鼠标停在列表 / 详情里时先别重建（不然正要点的那一行会被换掉，点击就丢） */
    _bindHoverGuards(listBox, detailBox) {
      if (listBox && !listBox._hoverBound) {
        listBox._hoverBound = true;
        listBox.addEventListener('mouseenter', () => { Transit._listHover = true; });
        listBox.addEventListener('mouseleave', () => {
          Transit._listHover = false;
          if (Transit._listDirty) { Transit._listDirty = false; Transit.renderListOnly(); }
        });
      }
      if (detailBox && !detailBox._hoverBound) {
        detailBox._hoverBound = true;
        detailBox.addEventListener('mouseenter', () => { Transit._mgrHover = true; Transit._mgrHoverAt = Date.now(); });
        detailBox.addEventListener('mouseleave', () => {
          Transit._mgrHover = false;
          if (Transit._mgrDirty) {
            Transit._mgrDirty = false;
            Transit.refreshStationMgr(true);
            Transit.refreshVehicleMgr(true);     // 车辆管理器也一起补画
          }
        });
      }
    },

    /* ------------------------------ 面板：顶部与工具栏 ------------------------------ */

    /**
     * 分区那一排（#transit-tabs）：**只有分区**，一共五个 —— 公司 / 车站 / 线路 / 车辆 / 异常清单。
     * 没有「全部」：公司 / 车站 / 线路 / 车辆是四种不同种类的东西，混排在一起只会看不清；
     * 「异常清单」也不是"全部"，它是挑出来的毛病清单（空线路 / 路径不通 / 悬空车站）。
     * 原来下面还挂着一排「管理器窗口」启动器按钮，已经删掉：面板本身就是管理器，分区就是各个管理器。
     */
    renderSectionChips(tabs) {
      tabs.innerHTML = '';
      const section = Transit.section();
      const counts = {
        company: Transit.myCompanies().length,
        // 车站数按「来源」口径算：默认是数据集里的全部车站（含导入的公共车站），和列表里看到的一致
        stations: Transit.filterStationsBySource((Transit.data && Transit.data.stations) || [], Transit.filters.source).length,
        lines: Transit.myLines().length,
        vehicles: Transit.myVehicles().length,
      };
      const issues = Transit.issueCounts();
      counts.issues = issues.total;
      for (const [id, label] of [['company', '公司'], ['stations', '车站'], ['lines', '线路'], ['vehicles', '车辆'], ['issues', '⚠ 异常清单']]) {
        const chip = util.el('button', 'tp-tab' + (section === id ? ' active' : ''),
          counts[id] != null ? `${label} ${counts[id]}` : label);
        chip.title = id === 'issues'
          ? `异常清单（**不是**「全部」）：空线路 / 路径不通 ${issues.badLines} 条 · 悬空车站 ${issues.orphanStations} 个，可以一键重算`
          : `只看「${label}」这一类：左侧列表与右侧详情都跟着换（筛选 / 排序是这一套，公司 / 车站 / 线路 / 车辆各自分开看）`;
        chip.onclick = () => Transit.setSection(id);
        tabs.appendChild(chip);
      }
    },

    /* ------------------------------ 管理器的**唯一**入口：交通面板的分区 ------------------------------ */

    /**
     * 管理器（车站 / 线路 / 车辆 / 公司 / 运营）现在**只有交通面板这一个家**：
     * 每个分区本身就是那个管理器，右侧详情就是它的完整界面。
     *
     * 「独立窗口」那一整套（.tmgr-win 的 DOM / 拖动 / 缩放 / 位置记忆、详情里的「🗔 独立窗口」按钮、
     * 地图气泡里的「🧰 管理器」按钮、五个 openXxxMgr 的窗口渲染）已经**全部删掉**，不再复活：
     *   · 地图上的一次点击只弹那个小气泡（站名 / 关键数字 / 定位 / 删除）；
     *   · 要管理器就点左侧列表里的那一行，面板切到对应分区。
     *
     * 下面这几个 openXxxMgr 保留成**薄壳**：它们不再开窗口，只是"切到面板的对应分区并选中它"。
     * 留着是因为其它文件（ui.js 的 UI.openLineMgr、editor.js 的调用点）与调试代码还在用这些名字，
     * 换成开面板对调用方是同一件事的"正确版本"，而不会多出一套界面。
     */
    MANAGER_TAB: { station: 'stations', line: 'lines', vehicle: 'vehicles', company: 'company', ops: 'company' },

    /** 统一的"到面板里打开某个管理器"（key = station / line / vehicle / company / ops） */
    openManager(key, id) {
      const tab = Transit.MANAGER_TAB[key];
      if (!tab) return null;
      if (key === 'company' || key === 'ops') { Transit.openPanel(tab); return tab; }
      // 没指定看哪一个就用"当前选中的那个"；都没有就只把面板切到那个分区（不硬选一个不存在的 id）
      const cur = key === 'station' ? Transit.selectedStation
        : (key === 'line' ? Transit.selectedLine : Transit.selectedVehicle);
      const pick = id == null ? cur : Number(id);
      if (pick == null || !Number.isFinite(Number(pick)) || !Number(pick)) { Transit.openPanel(tab); return tab; }
      return Transit.openPanelFor(key, Number(pick));
    },

    /** 兼容旧接口：窗口已经没有了，任何 surface 都不再"开着" */
    isManagerOpen() { return false; },

    /** 兼容旧接口：窗口已经没有了，没有东西可关（管理器就活在面板里，关面板=关它） */
    closeManager() { return false; },

    /** 兼容旧接口：窗口已经没有了，永远没有"最靠前的那个窗口" */
    topManagerWindow() { return null; },

    /**
     * 「我正在看哪家公司」：面板「公司」分区里点别家公司的那一行时，看的可以是**别人**的公司
     * （协作编辑：别家公司的名字 / 配色 / 资产都能看、也能改），这时不能走 company.select ——
     * 那个操作切换的是"我当前经营哪家公司"，服务端只认自己的公司（那是玩家的会话状态，不是共享资产）。
     */
    viewCompany() {
      const picked = Transit.selectedCompany == null ? null : Transit.companyById(Transit.selectedCompany);
      if (picked) return picked;
      return Transit.company() || Transit.myCompanies()[0] || ((Transit.data && Transit.data.companies) || [])[0] || null;
    },

    /** 「🗂 总面板里打开」某家公司：自己的公司顺手切成"当前经营"，别家的只在面板里看着（改不改得了看服务端） */
    openCompanyInPanel(id) {
      const c = Transit.companyById(id);
      if (!c) return false;
      Transit.selectedCompany = Number(c.id);
      if (Transit.isMyCompanyAsset('companies', c)) { Transit.setCompany(c.id); return true; }
      if (Transit.panelOpen && Transit.section() === 'company') Transit.renderPanel();
      return true;
    },

    /**
     * 改公司名称 / 配色（company.set）：**谁的公司都能改**（服务端给了 companyId 就改那一家，只挡元素锁），
     * 面板顶栏与「公司」分区里看别家公司时的按钮都走这一条路径，口径只有一份。
     */
    renameCompanyDialog(c) {
      if (!c) return;
      if (Transit.lockRefuse('company', c.id)) return;
      const name = window.prompt('公司名称', c.name);
      if (name == null) return;
      const color = window.prompt('公司颜色（#rrggbb）', c.color);
      Transit.op({ k: 'company.set', name, color, companyId: c.id })
        .then(() => {
          util.toast(`已更新公司「${name || c.name}」`, 'success', 2500);
          Transit.renderPanelSoon();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /**
     * 顶部：当前经营的这家公司 + 公司级操作（折叠与放大在标题栏上）。
     * **没有公司下拉选单**了（那个选单没人看得懂它跟列表的关系）：换公司请在「公司」分区里
     * 点左侧列表里的公司名（同一条 setCompany 路径）；「线路 / 车辆」列表要按公司过滤，
     * 用工具栏那一行的「公司」筛选（默认就是我的公司）。
     */
    renderTopBar(body) {
      const bar = util.el('div', 'tp-topbar');
      const cur = Transit.company();
      if (!cur) bar.appendChild(util.el('span', 'tp-note', '还没有公司'));
      // 「新建公司」只在公司分区里出现：别的分区（车站 / 线路 / 车辆 / 异常清单）不再重复挂这个按钮。
      // 一家公司都没有时，renderPanel 的兜底块里还有一个入口，不会走进死胡同。
      if (Transit.section() === 'company') {
        const add = util.el('button', 'mini', '＋ 新公司');
        add.title = '再开一家公司：新公司会自带一支起步车队';
        add.onclick = () => Transit.createCompany();
        bar.appendChild(add);
      }
      if (cur) {
        const dot = util.el('span', 'tp-dot');
        dot.style.background = cur.color || '#888';
        dot.title = '公司配色';
        bar.appendChild(dot);
        const ren = util.el('button', 'mini', '✏ 改名/配色');
        ren.title = '改公司名称与颜色（谁的公司都能改）';
        ren.onclick = () => Transit.renameCompanyDialog(cur);
        bar.appendChild(ren);
        const del = util.el('button', 'mini danger', '🗑 删除公司');
        del.title = '连同该公司的车站、线路、车辆一起删除（可撤销）';
        del.onclick = () => Transit.deleteCompany(cur);
        bar.appendChild(del);
      }
      body.appendChild(bar);
    },

    /**
     * 工具栏：搜索 + 来源/公司 + 类型 + 线路 + 状态 筛选 + 车辆气泡开关 + 排序条。
     * 公司口径分两种（各有各的道理，不要合成一个）：
     *   · 车站 → 「来源」（全部含公共·导入 / 我的 / 公共·导入）：数据集里导入的 OSM 车站不属于任何玩家；
     *   · 线路 / 车辆 / 公司 / 异常清单 → 「公司」（默认「只看我的公司」，可切「看全服」或某一家）。
     * 顶部那个公司下拉选单已经删掉，公司筛选就长在这一行里（沿用同一套 Transit.filters 机制）。
     */
    renderToolbar(body) {
      const bar = util.el('div', 'tp-toolbar');
      const f = Transit.filters;

      const search = util.el('input', 'tp-search');
      search.type = 'search';
      search.placeholder = '搜索名称…';
      search.value = f.search || '';
      search.title = '按名称搜索当前分区的车站 / 线路 / 车辆 / 公司';
      search.oninput = () => {
        clearTimeout(Transit._searchTimer);
        Transit._searchTimer = setTimeout(() => {
          Transit.filters.search = search.value;
          Transit.resetLimits();
          Transit.renderListOnly();   // 只重画列表：输入框不被重建，光标不会跳
        }, 250);
      };
      bar.appendChild(search);

      const companyOpts = [['mine', '只看我的公司'], ['all', '看全服']]
        .concat(Transit.myCompanies().map((c) => [String(c.id), c.name]));
      if (Transit.section() === 'stations') {
        // 车站看的是「来源」：数据集里导入的公共车站不属于任何玩家，用「公司」筛会被整片挡掉
        bar.appendChild(Transit._filterSelect('来源',
          [['all', '全部（含公共·导入）'], ['mine', '我的'], ['public', '公共·导入']],
          String(f.source === undefined ? 'all' : f.source), 'source'));
      } else {
        // 线路 / 车辆各自按公司筛（默认 = 我的公司；「看全服」能看别家的线路与车）
        bar.appendChild(Transit._filterSelect('公司', companyOpts, String(f.company), 'company'));
      }
      bar.appendChild(Transit._filterSelect('类型', [['all', '全部类型']].concat(LINE_KIND_ORDER.map((k) => [k, MODE_LABEL[k] || k])), String(f.kind), 'kind'));
      bar.appendChild(Transit._filterSelect('线路', [['all', '全部线路']].concat(Transit.myLines().map((l) => [String(l.id), l.name])), String(f.line), 'line'));
      bar.appendChild(Transit._filterSelect('状态', Transit.statusOptions(Transit.section()), String(f.status), 'status'));

      const bub = util.el('label', 'tp-check tp-bubble');
      const bcb = util.el('input');
      bcb.type = 'checkbox';
      bcb.checked = Transit.vehicleBubblesOn();
      bcb.title = '图层里的「车辆气泡」：打开时地图上每辆车都画一个小气泡（一行字 ~110×16，重叠时上下错开，不会隐藏）';
      bcb.onchange = () => {
        Transit.toggleVehicleBubbles(bcb.checked);
        util.toast(bcb.checked ? '车辆气泡已打开（每辆车一行小字，重叠时自动错开）' : '车辆气泡已关闭', 'info', 2200);
      };
      bub.appendChild(bcb);
      bub.appendChild(util.el('span', null, '车辆气泡'));
      bar.appendChild(bub);
      body.appendChild(bar);

      // 图层设置提示：车站 / 等车人数 / 车辆气泡在视野太宽时会**自动隐藏**（道路与轨道照常显示）。
      // 尺度阈值由 Render.metersPerPixel() 反算（不是写死的 zoom），两个门槛都写在提示里，免得玩家以为图层坏了。
      const lod = Transit.stationLodEffective();
      const wideZoom = Transit.wideViewZoom();
      const wide = Transit.viewTooWide();
      const hint = util.el('div', 'tp-note tp-lod-hint',
        `图层设置：地图缩得太远时——可见地面尺度超过 ${util.fmt(lod.maxMetersPer100px)} 米/100 像素`
        + `${wideZoom == null ? '' : `（约 z${wideZoom.toFixed(1)} 以下）`}——车站、等车人数与车辆气泡会自动隐藏，缩回来就出现（道路与轨道照常显示）。`
        + `<span class="tp-lod-now">当前门槛：站点 z${lod.dotMinZoom} · 站名 z${lod.nameMinZoom} · 等车 z${lod.waitingMinZoom} · 气泡 z${lod.bubbleMinZoom}`
        + `${wide ? ' · <b class="warn">当前视野已自动隐藏</b>' : ''}</span>`);
      hint.title = '想改：Transit.setStationLod({ waitingMinZoom: 14 })，会记在本机；服务端也可以下发 config.transit.stationLod';
      const layers = body.querySelector('.tp-toolbar');
      if (layers) layers.appendChild(hint);
      else body.appendChild(hint);

      // 可排序的列：每个分区一套（车站有「经过的线路数」，线路看站数/客流，车辆看载客/定员…）。
      // 点一下按这一列排、再点一下同一列就把正序/倒序翻过来（箭头画在芯片上），右边的芯片单独翻方向。
      const sortBar = util.el('div', 'tp-sortbar');
      Transit.renderSortBar(sortBar);
      body.appendChild(sortBar);
    },

    /** 一个小筛选下拉：label + select，改了就重画列表（不整块重建，省 DOM） */
    _filterSelect(label, options, value, key) {
      const wrap = util.el('label', 'tp-fsel');
      wrap.appendChild(util.el('span', 'tp-fsel-label', label));
      const sel = util.el('select', 'tp-select small');
      sel.title = `按「${label}」筛选`;
      for (const [v, text] of options) {
        const o = util.el('option', null, util.esc(text));
        o.value = String(v);
        if (String(v) === String(value)) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        Transit.filters[key] = sel.value;
        Transit.resetLimits();
        Transit.renderListOnly();
      };
      wrap.appendChild(sel);
      return wrap;
    },

    /** 状态筛选的选项跟着分区走（线路看通不通，车站看接没接路网，车辆看闲不闲置） */
    statusOptions(section) {
      const all = [['all', '全部状态']];
      if (section === 'stations') return all.concat([['ok', '已接入路网'], ['offline', '悬空（没接路网）'], ['waiting', '有人在等车'], ['noline', '没有线路经过']]);
      if (section === 'vehicles') return all.concat([['idle', '闲置'], ['assigned', '已指派线路'], ['running', '在跑'], ['full', '载客 > 80%']]);
      return all.concat([['ok', '正常'], ['broken', '路径不通'], ['empty', '空线路'], ['novehicle', '没有车辆']]);
    },

    /* ------------------------------ 面板：左侧列表 ------------------------------ */

    /**
     * 只重画左侧列表。**保住滚动位置**：气泡里的「🧰 打开」/ 面板里的选中变化都会走到这里，
     * 重建列表会把 scrollTop 冲回顶部，玩家正在翻的那一屏就丢了（用户明确要求别抢滚动位置）。
     */
    renderListOnly() {
      const box = util.$('#transit-body .tp-list');
      if (!box) return;
      const keepTop = Number(box.scrollTop) || 0;
      Transit.renderListInto(box, Transit.section());
      if (keepTop) box.scrollTop = keepTop;
    },

    renderDetailOnly() {
      const box = util.$('#transit-body .tp-detail');
      if (!box) return;
      Transit.renderDetailInto(box, Transit.section());
    },

    /**
     * 左侧列表：**只画当前分区那一种东西**（公司 / 车站 / 线路 / 车辆各一个分区，没有混排的「全部」）。
     * 「异常清单」分区画两组挑出来的毛病（异常线路 + 悬空车站），并明确写出它是异常清单。
     * 每组最多 LIST_LIMIT 行（80），超出给「显示更多」——几百个车站也不会一次塞满 DOM。
     */
    renderListInto(box, section) {
      box.innerHTML = '';
      const groups = [];
      const all = Transit.filters.company === 'all';
      if (section === 'company') groups.push({ type: 'companies', title: '公司', rows: Transit.query('companies', Transit.data.companies || []) });
      if (section === 'stations') groups.push({ type: 'stations', title: '车站', rows: Transit.query('stations', Transit.data.stations || []) });
      if (section === 'lines') groups.push({ type: 'lines', title: '线路', rows: Transit.query('lines', Transit.data.lines || []) });
      if (section === 'vehicles') groups.push({ type: 'vehicles', title: '车辆', rows: Transit.query('vehicles', Transit.data.vehicles || []) });
      if (section === 'issues') {
        // 说清楚这不是"全部资产"：这里只有挑出来的毛病
        box.appendChild(util.el('div', 'tp-note',
          '异常清单：只列有毛病的线路与车站（空线路 / 路径不通 / 悬空车站），不是全部资产 —— 全部资产在各自的「公司 / 车站 / 线路 / 车辆」分区里。'));
        groups.push({
          type: 'lines',
          title: '异常线路（空线路 / 路径不通）',
          rows: Transit.query('lines', Transit.data.lines || []).filter((l) => Transit.lineProblem(l).bad),
        });
        groups.push({
          type: 'stations',
          title: '悬空车站（没接到路网）',
          rows: Transit.query('stations', Transit.data.stations || []).filter((s) => !(s.nodeId || s.onRail)),
        });
      }

      for (const g of groups) {
        const head = util.el('div', 'tp-group');
        head.appendChild(util.el('span', 'tp-group-title', g.title));
        // 车站按「来源」说明范围（公共·导入的车站不属于任何玩家），其它按公司口径
        const note = g.type === 'stations'
          ? (String(Transit.filters.source === undefined ? 'all' : Transit.filters.source) === 'mine' ? '' : '（含公共·导入与别家公司的站）')
          : (all ? '（含别家公司）' : '');
        head.appendChild(util.el('span', null, `${g.rows.length} 条${note}`));
        box.appendChild(head);
        if (!g.rows.length) {
          box.appendChild(util.el('div', 'empty-hint small', Transit._emptyHint(g.type, section)));
          continue;
        }
        const limit = (Transit.limits && Transit.limits[g.type]) || LIST_LIMIT;
        const shown = g.rows.slice(0, limit);
        for (const item of shown) box.appendChild(Transit._listRow(g.type, item));
        if (g.rows.length > shown.length) {
          const pager = util.el('div', 'tp-pager');
          pager.appendChild(util.el('span', null, `显示 ${shown.length} / ${g.rows.length}`));
          const more = util.el('button', 'mini', `显示更多（还有 ${g.rows.length - shown.length}）`);
          more.title = `一次多显示 ${LIST_LIMIT} 行`;
          more.onclick = () => {
            Transit.limits[g.type] = limit + LIST_LIMIT;
            Transit.renderListOnly();
          };
          pager.appendChild(more);
          box.appendChild(pager);
        } else if (g.rows.length > 12) {
          box.appendChild(util.el('div', 'tp-pager', `<span>共 ${g.rows.length} 条，已全部显示</span>`));
        }
      }
    },

    _emptyHint(type, section) {
      if (Transit.filters.search) return '没有符合条件的（换个搜索词或筛选条件）';
      if (type === 'companies') return '还没有公司：切到「公司」分区（公司管理器）开一家';
      if (type === 'stations') {
        return '这个筛选下没有车站：把上面「来源」切成「全部（含公共·导入）」看看数据集里的 OSM 车站（公共车站），'
          + '或者切到「车站」分区在地图上点选位置设站';
      }
      if (type === 'lines') return section === 'issues' ? '没有空线路 / 坏线路，挺好' : '还没有线路：切到「线路」分区新建一条，或一键生成示例线路';
      return '车队还是空的：切到「车辆」分区，点车型就能造一辆';
    },

    /** 一行列表项（四种实体各一套紧凑排版：名字 + 一行指标） */
    _listRow(type, item) {
      const color = Transit.lineColor(item);
      if (type === 'companies') {
        const cur = Transit.company();
        const viewed = Transit.viewCompany();
        const c = Transit.companyCounts(item.id);
        const mine = Transit.isMyCompanyAsset('companies', item);
        const row = util.el('div', 'tp-item tp-lrow' + ((cur && cur.id === item.id) || (viewed && viewed.id === item.id) ? ' active' : ''));
        row.innerHTML = `<div class="tp-item-head"><span class="tp-dot" style="background:${util.esc(item.color || '#888')}"></span><b>${util.esc(item.name)}</b>${item.active ? '<span class="tp-tag ok">当前</span>' : ''}${mine ? '' : '<span class="tp-tag">别家公司</span>'}</div>
          <div class="tp-lsub">${c.stations} 站 · ${c.lines} 线 · ${c.vehicles} 辆（在跑 ${c.running}）</div>`;
        row.title = mine
          ? '点一下切换到这家公司（正在经营的公司）'
          : '点一下在右侧看这家公司（别家公司：改归属不行，但改名 / 配色 / 它的车站线路车辆都能改）';
        row.onclick = () => {
          if (mine) { if (!cur || cur.id !== item.id) Transit.setCompany(item.id); Transit.selectedCompany = null; return; }
          Transit.selectedCompany = Number(item.id);   // 别家公司：只看它（company.select 只认自己的公司）
          if (Transit.section() !== 'company') Transit.panelTab = 'company';
          Transit.renderDetailOnly();
          Transit.renderListOnly();
        };
        return row;
      }
      if (type === 'stations') {
        const online = !!(item.nodeId || item.onRail);
        const waiting = Transit.stationWaiting(item);
        const trend = Transit.waitingTrend(item);
        const pub = Transit.isPublicStation(item);      // 只是「公共·导入」这枚来源徽标
        const row = util.el('div', 'tp-item tp-lrow' + (Transit.selectedStation === item.id ? ' active' : '') + (online ? '' : ' warn'));
        row.innerHTML = `<div class="tp-item-head"><b>${util.esc(item.name)}</b>
            <span class="tp-tag">${util.esc(Transit.kindName(item.kind))}</span>
            ${pub ? '<span class="tp-tag ok">公共·导入</span>' : ''}
            ${online ? '' : '<span class="tp-tag warn">悬空</span>'}</div>
          <div class="tp-lsub">等车 ${util.fmt(waiting)} ${util.esc(Transit.trendArrow(trend))} · 线路 ${Transit.stationsLineCount(item.id)} · 覆盖 ${util.fmt((item.catchment || {}).pop || 0)}</div>`;
        row.title = Transit.addingStopsTo
          ? '点一下就把这一站加进正在编辑的那条线路'
          : (pub
            ? '底图导入的站（来源标记，不是权限）：和自建站一样能改名 / 挪动 / 删除 —— 点一下看它的覆盖、等车趋势与接入线路'
            : '点一下在右侧看/管这个车站（覆盖人数、等车趋势、接入的线路）');
        row.onclick = () => Transit.rowPick('stations', item);
        return row;
      }
      if (type === 'lines') {
        const p = Transit.lineProblem(item);
        const paused = Transit.linePaused(item);
        const row = util.el('div', 'tp-item tp-lrow' + (Transit.selectedLine === item.id ? ' active' : '') + (p.bad ? ' warn' : ''));
        row.innerHTML = `<div class="tp-item-head"><span class="tp-dot" style="background:${util.esc(color)}"></span><b style="color:${util.esc(color)}">${util.esc(item.name)}</b>
            <span class="tp-tag">${util.esc(Transit.lineKindName(item.kind))}</span>
            ${paused ? '<span class="tp-tag warn">暂停运营</span>' : ''}
            ${p.broken ? '<span class="tp-tag warn">路径不通</span>' : (p.empty ? '<span class="tp-tag warn">空线路</span>' : '')}</div>
          <div class="tp-lsub">${(item.stops || []).length} 站 · ${Transit.lineVehicleCount(item)} 辆 · 客流 ${util.fmt(item.dailyTrips || 0)}${p.noVehicle ? ' · <span class="warn">没车</span>' : ''}</div>
          <div class="tp-lsub">班次：${util.esc(Transit.lineScheduleSummary(item))}</div>`;
        row.title = paused
          ? '这条线已暂停运营（不会再发新车；在跑的几辆会跑完当前趟再收车）—— 点一下进线路详情可以恢复运营 / 转移归属'
          : '点一下看站点顺序 / 车辆 / 客流 / 模式与配色（线路详情里还有暂停运营与转移归属）';
        row.onclick = () => Transit.rowPick('lines', item);
        return row;
      }
      const live = Transit.liveVehicle(item.id);
      const run = Transit.vehicleRunInfo(item, live);
      const boarded = Math.round(Number(live && live.lastBoarded) || 0);
      // #车厂：不在运营的车（在车厂）在列表里也要一眼看清：状态那一格说清原因 + 下一班几点
      const depot = Transit.vehicleDepotInfo(item, live);
      // 「定位」：这辆车必须先指派线路、且有实时位置（没指派的车没有"正在跑的位置"）
      const pos = Transit.vehiclePosInfo(item, live);
      const row = util.el('div', 'tp-item tp-lrow has-loc' + (Transit.selectedVehicle === item.id ? ' active' : '') + (depot.depot ? ' depot' : ''));
      row.innerHTML = `<div class="tp-item-head"><b>${util.esc(item.name)}</b>
          <span class="tp-tag">${util.esc(Transit.kindLabel(item.kind))}</span>
          ${run.line ? `<span class="tp-tag ok">${util.esc(run.line.name)}</span>` : '<span class="tp-tag warn">闲置</span>'}
          ${depot.depot && item.lineId ? '<span class="tp-tag warn">在车厂</span>' : ''}</div>
        <div class="tp-lsub">载客 ${util.esc(run.loadText)}${boarded > 0 ? ` · <b>本站 +${util.fmt(boarded)} 人</b>` : ''} · ${util.esc(Transit.vehicleStateText(item, live))}</div>
        <div class="tp-lsub">${depot.depot
        ? util.esc(depot.nextText ? `${depot.short} · ${depot.nextText} · 未运营` : `${depot.short} · 未运营`)
        : `下一站 ${util.esc(run.nextStop)} · 预计到站 ${util.esc(run.etaText)} · ${Transit.scheduleCellHtml(run)}`}</div>`;
      row.title = depot.depot
        ? `${depot.text} —— 不在运营的车不会画在地图上（回车厂了）；点一下看详情，或者在右侧把它派到别的线路`
        : '点一下看这辆车的详情（载客 / 下一站 / 预计到站 / 班次准点 / 换线 / 删除），地图上同时弹出同一份详情';
      row.onclick = () => Transit.rowPick('vehicles', item);
      // 行内「定位」：能定位就居中，不能就禁用并把中文原因写在按钮上（不点也看得见为什么不能点）
      const loc = util.el('button', 'mini tp-loc', '🗺 定位');
      loc.title = pos.ok ? '把地图移到这辆车' : pos.reason;
      loc.disabled = !pos.ok;
      loc.onclick = (ev) => {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();   // 别顺带把这一行也选上
        if (!pos.ok) { util.toast(pos.reason, 'warn', 3500); return; }
        if (Render.map) Render.map.setView(pos.at, Math.max(16, Render.map.getZoom()));
      };
      row.appendChild(loc);
      return row;
    },

    /** 人口密度图例（打开热力图时显示） */
    renderDensityLegend(body) {
      if (!Transit.population.on) return;
      const box = util.el('div', 'tp-legend');
      box.innerHTML = '<div class="tp-legend-title">人口密度（每平方公里）</div>'
        + '<div class="tp-legend-bar"></div>'
        + '<div class="tp-legend-scale"><span>稀疏</span><span>中等</span><span>稠密</span></div>'
        + (Transit.population.totals
          ? `<div class="tp-legend-note">当前视野：${util.fmt(Transit.population.totals.population || 0)} 人 · ${util.fmt(Transit.population.totals.jobs || 0)} 岗位</div>`
          : '');
      body.appendChild(box);
    },

    /**
     * 面板总渲染：分区 chips + 顶部公司条 + 工具栏 + （左侧列表 | 右侧详情）。
     * 详情按"选中的东西"走：车站 → 站点管理器；线路 → 站点顺序/车辆/客流/模式；车辆 → 载客/指派。
     */
    renderPanel() {
      const body = util.$('#transit-body');
      const tabs = util.$('#transit-tabs');
      if (!body || !tabs) return;
      injectTransitStyle();
      Transit._bindPopup();   // 线路取色器 / 站点编辑器里的 data-act 都靠它（只绑一次）
      Transit._stMgrLive = false;   // 站点管理器只在"车站详情"里挂着
      Transit.renderSectionChips(tabs);
      const sizeBtn = util.$('#transit-size');
      if (sizeBtn) sizeBtn.textContent = Transit.bigPanel ? '⤡ 缩小' : '⤢ 放大';
      body.innerHTML = '';
      if (!Transit.data) {
        body.appendChild(util.el('div', 'empty-hint small', '正在载入交通数据…'));
        return;
      }
      const company = Transit.company();
      if (!company) Transit.ensureMyCompany();
      // 选中项被删掉了就把选中收起来（不然详情会指着一个不存在的东西）
      if (Transit.selected && !Transit.selection()) Transit.selected = null;
      if (Transit.selectedStation != null && !Transit.stationById(Transit.selectedStation)) Transit.selectedStation = null;
      if (Transit.selectedLine != null && !Transit.lineById(Transit.selectedLine)) Transit.selectedLine = null;
      if (Transit.selectedVehicle != null && !Transit.vehicleById(Transit.selectedVehicle)) Transit.selectedVehicle = null;
      Transit.renderTopBar(body);
      if (!company) {
        // 一家公司都没有：这里给唯一的出口（公司管理器就在「公司」分区），不然整个面板没法用
        const box = util.el('div', 'tp-block');
        box.appendChild(util.el('div', 'tp-blocktitle', '公司管理器'));
        box.appendChild(util.el('div', 'tp-note', '还没有公司：先开一家（会自带一支起步车队），之后车站 / 线路 / 车辆三个分区就都能用了。'));
        const add = util.el('button', 'opt-btn', '＋ 新公司');
        add.title = '开一家新公司（每人可以同时经营好几家）';
        add.onclick = () => Transit.createCompany();
        box.appendChild(add);
        body.appendChild(box);
        return;
      }
      Transit.renderToolbar(body);
      // 面板里不再有「管理器窗口」启动器那一排：面板自己就是管理器，分区就是各个管理器；
      // 地图上的一次点击也只弹小气泡（不切分区、不开任何窗口）。
      if (Transit.addingStopsTo) {
        const line = Transit.lineById(Transit.addingStopsTo);
        const banner = util.el('div', 'tp-bulk');
        banner.appendChild(util.el('span', 'tp-picker-title',
          `加站模式：点左侧车站列表里的站（或地图上的车站）加入「${line ? line.name : '线路'}」`));
        const stop = util.el('button', 'mini', '结束加站');
        stop.onclick = () => Transit.stopAddingStops();
        banner.appendChild(stop);
        body.appendChild(banner);
      }
      Transit.renderDensityLegend(body);

      const main = util.el('div', 'tp-main');
      const listBox = util.el('div', 'tp-list');
      const detailBox = util.el('div', 'tp-detail');
      main.appendChild(listBox);
      main.appendChild(detailBox);
      body.appendChild(main);
      Transit._bindHoverGuards(listBox, detailBox);

      const section = Transit.section();
      Transit.renderListInto(listBox, section);
      Transit.renderDetailInto(detailBox, section);
    },

    /**
     * 右侧详情：按分区 + 选中项决定画什么（每一块都只在一个地方实现）。
     * 分区只有五个，各自对应自己那一种实体；认不出来的分区（老页面残留的 'all'）落到公司总览。
     */
    renderDetailInto(box, section) {
      box.innerHTML = '';
      const sel = Transit.selection();
      // 元素锁：面板右侧这一块就是"编辑器" —— 打开哪个元素就锁哪个元素（车站表单 / 车辆管理器 /
      // 线路管理器）。换分区、收起选中、关面板都会在这里把锁放掉（见 setLockWant / closePanel）。
      const lockType = (section === 'stations' && sel && sel.type === 'station') ? 'station'
        : (section === 'vehicles' && sel && sel.type === 'vehicle') ? 'vehicle'
          : (section === 'lines' && sel && sel.type === 'line') ? 'line' : null;
      Transit.setLockWant('panel', lockType, lockType ? sel.id : null);
      if (section === 'stations') {
        if (sel && sel.type === 'station') Transit.renderStationDetail(box, Transit.stationById(sel.id));
        else Transit.renderStationOverview(box);
        return;
      }
      if (section === 'lines') {
        if (sel && sel.type === 'line') Transit.renderLineDetail(box, Transit.lineById(sel.id));
        else Transit.renderLineOverview(box);
        return;
      }
      if (section === 'vehicles') {
        if (sel && sel.type === 'vehicle') Transit.renderVehicleDetail(box, Transit.vehicleById(sel.id));
        else Transit.renderVehicleOverview(box);
        return;
      }
      if (section === 'issues') { Transit.renderIssuesDetail(box); return; }
      // 公司分区（也是默认分区）：公司资产 + 运营数据
      Transit.renderCompanyDetail(box);
    },

    /**
     * 公司分区：公司资产 + 运营数据（原来的「运营」页签并进来了，不再单独一个入口）。
     * company 可选：调用方（openCompanyMgr / 面板里看别家公司）想看的那个公司，
     * 不给就用当前正在经营的公司 —— 渲染代码只有这一份。
     */
    renderCompanyDetail(box, company) {
      const c0 = company || Transit.viewCompany();
      if (!c0) {
        box.appendChild(util.el('div', 'empty-hint small', '还没有公司：工具栏上的「＋ 新公司」开一家（公司管理器就在这个「公司」分区里）。'));
        return;
      }
      const eco = Transit.config && Transit.config.economy;
      const c = Transit.companyCounts(c0.id);
      const cur = Transit.company();
      const viewingOther = !!cur && cur.id !== c0.id;
      const block = util.el('div', 'tp-block');
      block.innerHTML = `<div class="tp-row"><span>公司</span><b style="color:${util.esc(c0.color || '#888')}">${util.esc(c0.name)}</b></div>
        ${eco ? `<div class="tp-row" data-live="cash"><span>资金</span><b>${util.fmt(c0.cash)} 元</b></div>` : ''}
        <div class="tp-row" data-live="riders"><span>累计运送</span><b>${util.fmt(c0.riders)} 人次</b></div>
        <div class="tp-row"><span>车队</span><b>${c.vehicles} 辆（在跑 ${c.running}）</b></div>
        <div class="tp-row"><span>车站 / 线路</span><b>${c.stations} 站 / ${c.lines} 条</b></div>
        ${eco ? `<div class="tp-row" data-live="revenue"><span>累计票款</span><b>${util.fmt(c0.revenue)} 元</b></div>
        <div class="tp-row" data-live="spent"><span>累计支出</span><b>${util.fmt(c0.spent)} 元</b></div>` : ''}`;
      box.appendChild(block);

      // 看的是**别家公司**（列表里点的那一行）：给一排公司级操作 —— 公司名 / 配色是全服共享的，
      // 服务端的 company.set 给 companyId 就能改任何一家（系统公司不能删，与 deleteCompany 口径一致）。
      if (viewingOther) {
        const acts = util.el('div', 'tp-actions');
        const back = util.el('button', 'mini', '← 看我自己的公司');
        back.title = '回到「当前经营的公司」那一份详情';
        back.onclick = () => { Transit.selectedCompany = null; Transit.renderDetailOnly(); Transit.renderListOnly(); };
        acts.appendChild(back);
        const ren = util.el('button', 'mini', '✏ 改名/配色');
        ren.title = '改这家公司的名称与颜色（company.set；谁的公司都能改）';
        ren.onclick = () => Transit.renameCompanyDialog(c0);
        acts.appendChild(ren);
        if (String(c0.owner) !== '__system__') {
          const del = util.el('button', 'mini danger', '🗑 删除公司');
          del.title = '删除这家公司（它名下的车站 / 线路 / 车辆会一起删，可撤销）';
          del.onclick = () => Transit.deleteCompany(c0);
          acts.appendChild(del);
        }
        box.appendChild(acts);
        box.appendChild(util.el('div', 'tp-note',
          `正在看「${util.esc(c0.name)}」（不是当前经营的那家）：它的资产都在各自的「车站 / 线路 / 车辆」分区里`
          + '（工具栏「公司」筛选切到看全服就能看到）；编辑器打开哪个元素就锁哪个元素，别人正在改的元素会显示成只读。'));
      }

      Transit.renderOpsBlock(box);

      if (eco) {
        const cfg = Transit.config || {};
        box.appendChild(util.el('div', 'tp-note',
          `造价：车站 ${Transit.moneyShort(cfg.stationCost)}（公交站 1/12）、列车 ${Transit.moneyShort(cfg.vehicleBaseCost)} + 每节 ${Transit.moneyShort(cfg.vehiclePerCarCost)}、`
          + `每节每天维护 ${util.fmt(cfg.maintenancePerCarPerDay)} 元；票价 ${cfg.fareBase} 元 + ${cfg.farePerKm} 元/公里。`
          + '时间流速用顶栏时钟按钮，人口密度图用左侧图层面板的开关。'));
      } else {
        box.appendChild(util.el('div', 'tp-note',
          '经济系统已关闭：建车站、铺轨、买车都不花钱，只看客流与运营效果。（如需开启，把 config.json 里 transit.economy 设为 true）'));
      }
      box.appendChild(util.el('div', 'tp-note',
        '左侧列表里点一下公司名就能切换正在经营的公司；车站 / 线路 / 车辆的筛选与排序都在上面那一排'
        + '（线路与车辆各自有「公司」筛选，默认只看我的公司）。'
        + '每个管理器（车站 / 线路 / 车辆 / 公司 / 运营）**就是这个面板的对应分区**：'
        + '左侧列表里点一行，右侧就是它的管理器（站点管理器 / 车辆管理器 / 线路工作台 / 公司详情）。'
        + '地图上点车站或车辆只会弹出那个小气泡（定位 / 删除 / 撤下线路），不会切分区也不会开别的窗口。'));

      const mineIds = new Set(Transit.myVehicles().map((v) => v.id));
      const running = ((Transit.data && Transit.data.trains) || []).filter((t) => mineIds.has(t.id));
      if (running.length) {
        box.appendChild(util.el('div', 'tp-note',
          `在运车辆：${running.slice(0, 8).map((t) => `${t.name} ${t.load}/${t.capacity}`).join('，')}${running.length > 8 ? ` 等 ${running.length} 辆` : ''}`));
      } else {
        box.appendChild(util.el('div', 'tp-note', '还没有在运车辆：在「车辆」分区造车并指派线路，把时钟调到 ×5 或 ×20 就能看到它跑起来。'));
      }
    },

    /**
     * 运营数据（全服）块：面板「公司」分区里就这一份（openOpsMgr 也是切到这个分区）。
     * 数据来自快照的 stats（服务端 runtimeStats），不做任何本地估算。
     */
    renderOpsBlock(box) {
      if (!box) return box;
      const stats = (Transit.data && Transit.data.stats) || {};
      const pop = stats.population || {};
      const road = stats.road || {};
      const st = util.el('div', 'tp-block');
      st.innerHTML = `<div class="tp-blocktitle">运营数据（全服）</div>
        <div class="tp-row"><span>全服公司</span><b>${util.fmt(stats.companies || 0)}</b></div>
        <div class="tp-row"><span>全服车站</span><b>${util.fmt(stats.stations || 0)}</b></div>
        <div class="tp-row"><span>全服线路</span><b>${util.fmt(stats.lines || 0)}</b></div>
        <div class="tp-row"><span>全服车辆</span><b>${util.fmt(stats.vehicles || 0)}</b></div>
        <div class="tp-row"><span>全服运送</span><b>${util.fmt(stats.riders || 0)} 人次</b></div>
        ${(Transit.config && Transit.config.economy) ? `<div class="tp-row"><span>票款</span><b>${util.fmt(stats.revenue || 0)} 元</b></div>` : ''}
        <div class="tp-row"><span>路网</span><b>${stats.rail ? util.fmt(stats.rail.ways) + ' 条轨道' : '—'}${road.ways ? ` · ${util.fmt(road.ways)} 条道路` : ''}</b></div>
        <div class="tp-row"><span>人口模型</span><b>${util.fmt(pop.population || 0)} 人 / ${util.fmt(pop.jobs || 0)} 岗位</b></div>`;
      box.appendChild(st);
      const clock = (Transit.data && Transit.data.clock) || null;
      box.appendChild(util.el('div', 'tp-note',
        `游戏时钟：第 ${clock && clock.day != null ? clock.day : '—'} 天 ${Transit.clockText() || '--:--'}`
        + `（${clock ? util.esc(String(clock.unit || ('现实 1 秒 = 游戏 ' + clock.speed + ' 秒'))) : '—'}）· 时间流速在顶栏时钟按钮上。`));
      return box;
    },

    /* ------------------------------ 详情：车站（站点管理器在这里，不在地图弹窗） ------------------------------ */

    /** 车站分区、还没选站时：新建/批量设站（模式 + 在地图上放站） */
    renderStationOverview(box) {
      const block = util.el('div', 'tp-block');
      block.appendChild(util.el('div', 'tp-blocktitle', '新建车站'));
      // 设站模式这一行：和左侧「🚉 设站」工具面板、检查器「新建车站」面板共用同一份芯片、同一个 Transit.stationMode，
      // 改一处三处一起高亮（芯片列表由 editor.js 提供，这里不另写一份）
      Transit.stationModeRow(block);
      const add = util.el('button', 'opt-btn', '📍 在地图上点选位置设站');
      add.onclick = () => {
        const info = Transit.stationModeInfo();
        Transit.closePanel();
        if (window.G.UI) window.G.UI.selectTool('station');
        util.toast(`设站模式：${info.ico ? info.ico + ' ' : ''}${info.name || ''} —— ${info.snapText || '点击地图放置'}`, 'info', 6000);
      };
      block.appendChild(add);
      block.appendChild(util.el('div', 'tp-note',
        '选好模式再点地图放置。点左侧任意车站，右侧会切成那个车站的站点管理器：覆盖人数、等车人数与 10 秒趋势、已放弃、最长等待、分线路候车（每条线一队，队伍下面就是这些人要去哪一站）、接入的线路（可逐条移除）。'
        + '地图上点车站的圆点、站名或者那个等车人数徽标，只会弹出那个小气泡（定位 / 删除）—— 站点管理器在左侧列表里点一下就出来。'));
      box.appendChild(block);

      // 有线路就能加站（全服的线路都算：协作编辑下别家公司的线路也能加站）
      const lines = Transit.assignableLines();
      if (!lines.length) box.appendChild(util.el('div', 'tp-note', '还没有线路：切到「线路」分区新建一条，之后就能把车站加进去。'));
    },

    /**
     * 选中的车站：**站点管理器**就是面板「车站」分区的右侧详情（唯一入口，没有第二个窗口）
     * + 可编辑表单 + 「加进某条线路」，全在右侧面板里。
     */
    renderStationDetail(box, st) {
      if (!st) { Transit.renderStationOverview(box); return; }
      // 设站模式那一行只放在「新建车站」块里（不跟单站属性编辑混在一起），这里给一个回得去的入口
      const nav = util.el('div', 'tp-actions');
      const back = util.el('button', 'mini', '← 新建车站 / 设站模式');
      back.title = '收起点选的车站，回到「新建车站」：设站模式与在地图上设站';
      back.onclick = () => { Transit.selected = null; Transit.renderDetailOnly(); };
      nav.appendChild(back);
      box.appendChild(nav);

      // 唯一渲染器（车站属性表单也在里面）。mountStationManager 会先清空容器，
      // 所以上面那排导航按钮必须挂在**另一个**容器里
      const host = util.el('div', 'st-mgr-host');
      box.appendChild(host);
      Transit.mountStationManager(host, st);
      Transit._stMgrLive = true;
      Transit._stMgrAt = Date.now();
      // 「分线路候车 · 每条线的去向」这份明细只在**整份快照**里（sim 帧不带车站），服务端又只在真的有人在等时
      // 才下发它们。所以这里一旦发现"有人等、但手上这份快照没有明细"，立刻补拉一次（节流 1 秒），
      // 别让玩家对着「暂无明细」等下一个 4 秒周期。
      if (Transit.waitingDetailMissing(st)) Transit.ensureLiveStation(true);
    },

    /** 一键把该站加进某条线路（列表选择，不用去地图上点） */
    addStationToLineBlock(st) {
      const block = util.el('div', 'tp-block tp-addline');
      block.appendChild(util.el('div', 'tp-blocktitle', '把这一站加进线路'));
      // 协作编辑：**全服的线路都能加站**（服务端只看线路存在 + 元素锁），自己的排前面；
      // 「看全服」时能直接给别家公司的线路加站，不用先去线路管理器里换筛选。
      const lines = Transit.assignableLines();
      if (!lines.length) {
        block.appendChild(util.el('div', 'empty-hint small', '还没有线路：切到「线路」分区新建一条'));
        return block;
      }
      const sel = util.el('select', 'tp-select small');
      for (const l of lines) {
        const co = Transit.companyById(l.companyId);
        const mine = Transit.isMyCompanyAsset('lines', l);
        const has = (l.stops || []).includes(Number(st.id));
        const o = util.el('option', null,
          `${l.name}${mine ? '' : `（${co ? co.name : '别家公司'}）`}（${(l.stops || []).length} 站${has ? ' · 已在此线' : ''}）`);
        o.value = String(l.id);
        sel.appendChild(o);
      }
      const btn = util.el('button', 'opt-btn', '＋ 加入这条线路');
      btn.onclick = () => Transit.appendStop(Number(sel.value), st.id);
      block.appendChild(sel);
      block.appendChild(btn);
      block.appendChild(util.el('div', 'tp-note', '加站后服务端会沿路网重算路径，不通时会提示（可以在线路详情里点「重算路径」）。'));
      if (Transit.addingStopsTo) block.appendChild(util.el('div', 'tp-note warn', '加站模式开着：在左侧车站列表里点站也能加。'));
      return block;
    },

    /* ------------------------------ 详情：线路（和线路管理器共用同一套） ------------------------------ */

    /** 线路分区、没选线路时：线路体检 + 批量工具（新建 / 对比 / 导出 CSV / 示例数据） */
    renderLineOverview(box) {
      const lines = Transit.query('lines', (Transit.data && Transit.data.lines) || []);
      const problems = lines.filter((l) => Transit.lineProblem(l).bad);
      const noVeh = lines.filter((l) => { const p = Transit.lineProblem(l); return p.noVehicle && !p.bad; });
      const vehicles = Transit.indexes().vehByLine;
      let vehTotal = 0;
      let ridership = 0;
      for (const l of lines) { vehTotal += vehicles.get(Number(l.id)) || 0; ridership += Number(l.dailyTrips || 0); }

      const st = util.el('div', 'tp-block');
      st.innerHTML = `<div class="tp-blocktitle">线路体检（当前筛选范围内）</div>
        <div class="tp-row"><span>线路</span><b>${lines.length} 条</b></div>
        <div class="tp-row"><span>异常（空线路 / 路径不通）</span><b class="${problems.length ? 'warn' : ''}">${problems.length} 条</b></div>
        <div class="tp-row"><span>没有车辆</span><b class="${noVeh.length ? 'warn' : ''}">${noVeh.length} 条</b></div>
        <div class="tp-row"><span>已指派车辆</span><b>${vehTotal} 辆</b></div>
        <div class="tp-row"><span>日客流合计</span><b>${util.fmt(ridership)} 人次</b></div>`;
      box.appendChild(st);

      if (problems.length) {
        // 修线路的唯一入口在「⚠ 问题」分区（那边是一键重算整批），这里只做提示，不再重复挂一个按钮
        box.appendChild(util.el('div', 'tp-note warn',
          `异常线路：${problems.map((l) => l.name).join('、')}（左侧列表里也标红了；到「⚠ 问题」分区可以一键重算）`));
      }

      const mgr = window.G.LineMgr;
      const actions = util.el('div', 'tp-actions');
      const add = util.el('button', 'mini', '＋ 新建线路');
      add.title = '新建一条空线路，再用「＋ 加站」把车站依次加进去（线路管理器就在这个「线路」分区里）';
      add.onclick = () => Transit.createLine();
      actions.appendChild(add);
      const cmp = util.el('button', 'mini' + (Transit.compareOn ? ' on' : ''), '📊 线路对比');
      cmp.title = '把当前筛选出的线路按日客流 / 车辆数并排对比';
      cmp.onclick = () => { Transit.compareOn = !Transit.compareOn; Transit.renderDetailOnly(); };
      actions.appendChild(cmp);
      const csv = util.el('button', 'mini', '⬇ 导出 CSV');
      csv.title = '把当前筛选出的线路导出成 CSV（Excel 可直接打开）';
      csv.onclick = () => {
        if (mgr && typeof mgr.exportCsv === 'function') mgr.exportCsv(lines);
        else util.toast('线路管理器模块没加载', 'warn');
      };
      actions.appendChild(csv);
      box.appendChild(actions);

      if (Transit.compareOn) {
        if (mgr && typeof mgr.compareBlock === 'function') box.appendChild(mgr.compareBlock(lines));
        else box.appendChild(util.el('div', 'empty-hint small', '线路管理器模块没加载，暂时看不了对比表'));
      }
      box.appendChild(util.el('div', 'tp-note',
        '点左侧任意线路，右侧就是它的工作台：站点顺序（可上移 / 下移 / 删站）、班次、车队（勾选加入 / 撤下）、客流统计、模式与配色。'));

      box.appendChild(Transit.demoBlock());
    },

    /* ------------------------------ 管理器只有面板这一个家（独立窗口整套已删） ------------------------------ */

    /**
     * 「独立窗口」这一整套**已经彻底删掉**（用户要求：管理器只活在交通面板的分区里），
     * 下面这五件事一起消失、不再复活：
     *   1) 五个管理器窗口的 DOM（.tmgr-win：标题栏 / 拖动 / 缩放 / localStorage 位置与尺寸记忆 / z 序 / Esc）；
     *   2) 窗口内容的渲染器（renderStationWin / renderVehicleWin / renderCompanyWin / renderOpsWin）；
     *   3) 详情里的「🗔 独立窗口」按钮（车站 / 线路 / 车辆详情各一个）；
     *   4) 地图气泡里的「🧰 管理器」按钮（车站 / 车辆气泡）—— 地图上的一次点击只弹那个小气泡；
     *   5) 窗口那一份元素锁 surface（'win:station' / 'win:vehicle' / 'win:line'）与"哪个窗口在最前面"的排序。
     * 窗口内容本来就是复用面板右侧那几个渲染器（mountStationManager / vehicleManagerBlockHtml /
     * renderCompanyDetail / renderOpsBlock），所以删掉窗口**一个方块都没少**：面板的分区就是这些管理器。
     *
     * 下面这几个 openXxxMgr 保留成**薄壳**：不开窗口，只是"切到面板的对应分区并选中它"。
     * 留着是因为别的文件（ui.js 的 UI.openLineMgr、editor.js 与调试脚本）还在用这些名字 ——
     * 换成开面板对调用方是同一件事的正确版本，而不会再长出一套界面。
     */

    /** 独立的车站管理器 → 面板「车站」分区（选中这一站，右侧就是站点管理器） */
    openStationMgr(stationId) {
      const id = Number(stationId == null ? Transit.selectedStation : stationId);
      if (!Number.isFinite(id) || !id) { Transit.openPanel('stations'); return Transit; }
      return Transit.openPanelFor('station', id);
    },

    /** 独立的车辆管理器 → 面板「车辆」分区（选中这辆车，右侧就是车辆管理器） */
    openVehicleMgr(vehicleId) {
      const id = Number(vehicleId == null ? Transit.selectedVehicle : vehicleId);
      if (!Number.isFinite(id) || !id) { Transit.openPanel('vehicles'); return Transit; }
      return Transit.openPanelFor('vehicle', id);
    },

    /** 独立的公司管理器 → 面板「公司」分区（要看别家公司就在列表里点它那一行） */
    openCompanyMgr(companyId) {
      const id = Number(companyId);
      if (Number.isFinite(id) && id && Transit.companyById(id)) Transit.selectedCompany = id;
      Transit.openPanel('company');
      return Transit;
    },

    /** 独立的运营管理器 → 面板「公司」分区（全服运营数据块就在这个分区里） */
    openOpsMgr() {
      Transit.openPanel('company');
      return Transit;
    },

    /**
     * 线路管理器 → 面板「线路」分区（选中这条线，右侧就是 linemgr.js 画的那块详情）。
     * linemgr 自己的 `LineMgr.open(lineId)` 现在**也是这条路**（见 public/js/linemgr.js 的 open），
     * 所以"线路管理器窗口"这个名字在代码里还找得到，但界面上不会再有第二个入口。
     */
    openLineMgr(lineId) {
      if (!(window.G.LineMgr && typeof window.G.LineMgr.embed === 'function')) {
        util.toast('线路管理器模块没加载（public/js/linemgr.js 未就绪）', 'warn', 3000);
        return false;
      }
      const id = Number(lineId == null ? Transit.selectedLine : lineId);
      if (!Number.isFinite(id) || !id || !Transit.lineById(id)) { Transit.openPanel('lines'); return true; }
      Transit.openPanelFor('line', id);
      return true;
    },

    /* ------------------------------ 示例数据（一键生成；绝不会自动跑） ------------------------------ */

    /** 示例数据的名字前缀：一眼看出是测试数据，也方便一键清除 */
    DEMO_PREFIX: '【示例】',

    isDemoLine(line) { return !!line && String(line.name || '').startsWith(Transit.DEMO_PREFIX); },

    /** 我的示例线路 */
    demoLines() { return Transit.myLines().filter((l) => Transit.isDemoLine(l)); },

    /** 「生成示例线路与车辆」只在玩家还没有线路（或只有 1 条）时出现 */
    demoVisible() { return Transit.myLines().length <= 1; },

    /** 示例数据的分组名（服务端撤销标签会用这个：撤销：生成示例线路与车辆（N 步）） */
    DEMO_GROUP_LABEL: '生成示例线路与车辆',
    DEMO_CLEAR_LABEL: '清除示例数据',

    /**
     * 示例数据块（线路分区底部）：
     *   没有线路时 → 「🎲 生成示例线路与车辆（示例/测试数据）」
     *   已经生成过 → 「🧹 清除示例数据」+ 说明
     * 只在玩家主动点的时候才跑，任何自动路径都不会调用它。
     */
    demoBlock() {
      const demo = Transit.demoLines();
      const box = util.el('div', 'tp-demo');
      if (demo.length) {
        box.appendChild(util.el('div', 'tp-blocktitle', '示例 / 测试数据'));
        // 撤销标签直接用服务端给的 group.undoLabel（「撤销：生成示例线路与车辆（12 步）」）
        const undoHint = Transit._demoUndoLabel ? `整组只算一步（${Transit._demoUndoLabel}）。` : '整组只算一步撤销。';
        box.appendChild(util.el('div', 'tp-demo-note',
          `当前有 ${demo.length} 条【示例】线路（${demo.map((l) => l.name).join('、')}）。`
          + `这些是测试数据，不影响别的玩家，随时可以清掉；${undoHint}`));
        const clear = util.el('button', 'opt-btn danger', `🧹 清除示例数据（${demo.length} 条线路）`);
        clear.title = '删掉【示例】线路、它们的配车、以及示例专用车站（整组一步撤销）';
        clear.onclick = () => Transit.clearDemoData();
        box.appendChild(clear);
        return box;
      }
      if (!Transit.demoVisible()) return box;   // 已经有线路了就别再推销示例数据
      box.appendChild(util.el('div', 'tp-blocktitle', '示例 / 测试数据'));
      const gen = util.el('button', 'opt-btn', '🎲 生成示例线路与车辆（示例数据）');
      gen.title = '一键生成 3 条【示例】线路（2 条公交 + 1 条地铁）+ 配车，站点都落在附近真实的道路 / 轨道上';
      gen.onclick = () => Transit.generateDemoData();
      box.appendChild(gen);
      box.appendChild(util.el('div', 'tp-demo-note',
        '会新建 3 条名字带「【示例】」的线路：2 条公交 + 1 条地铁，每条 3~4 站，'
        + '站点优先复用数据集里已有的车站（含导入的公共车站），不够时在旁边新建（服务端会吸附到最近的真实道路 / 轨道），'
        + '并给每条线路配 2 辆车。这是示例 / 测试数据，不会自动生成；整批包成一组，撤销时一步就全部回退。'));
      return box;
    },

    /**
     * 一键生成示例线路与车辆（示例数据）。全部走既有操作：
     *   station.create（服务端吸附路网）→ line.create → vehicle.create。
     * 整批用 beginGroup / endGroup 包成"一组"：撤销时只算一步（失败则 abortGroup 收尾）。
     */
    async generateDemoData() {
      if (Transit._demoBusy) { util.toast('示例数据正在生成，稍等一下…', 'info', 2500); return; }
      if (!Transit.company()) { util.toast('先开一家公司，再生成示例数据', 'warn', 3500); return; }
      const eco = Transit.config && Transit.config.economy;
      if (!window.confirm([
        '生成示例线路与车辆（示例 / 测试数据）？',
        '',
        '· 2 条公交线路 + 1 条地铁线路，每条 3~4 站，并各配 2 辆车',
        '· 站点优先用数据集里已有的车站（含导入的公共车站）；不够时在附近新建，服务端会吸附到真实道路 / 轨道',
        '· 名字都带「【示例】」前缀，一眼能认出是测试数据',
        eco ? '· 经济系统开着：建站、买车会按正常价格扣钱' : '· 经济系统关着：不花钱',
        '· 整批包成一组：撤销键按一次就全部回退（也可以一键「清除示例数据」）',
      ].join('\n'))) return;

      Transit._demoBusy = true;
      const before = Transit.myLines().length;
      try {
        const center = Transit.demoCenter();
        const plans = [
          { kind: 'bus', name: `${Transit.DEMO_PREFIX}示例公交 1 路`, bearing: 0, stops: 4, vehicles: 2 },
          { kind: 'bus', name: `${Transit.DEMO_PREFIX}示例公交 2 路`, bearing: 100, stops: 4, vehicles: 2 },
          { kind: 'subway', name: `${Transit.DEMO_PREFIX}示例地铁 M1 线`, bearing: 45, stops: 4, vehicles: 2 },
        ];
        const used = new Set();
        let madeLines = 0;
        let madeStations = 0;
        let madeVehicles = 0;
        const skipped = [];
        // 建站 + 建线 + 配车整批包一组：撤销时一步回退（中间任一步抛错 → abortGroup）
        const groupAck = await Transit.withUndoGroup(Transit.DEMO_GROUP_LABEL, async () => {
          for (const plan of plans) {
            const picked = await Transit.demoStopsFor(plan, center, used);
            madeStations += picked.created;
            if (picked.stops.length < 2) {
              skipped.push(`${plan.name}：附近找不到可用的${plan.kind === 'bus' ? '公交站' : '轨道站'}或轨道`);
              continue;
            }
            const lineId = await Transit.demoCreateLine(plan, picked.stops);
            if (lineId == null) { skipped.push(`${plan.name}：线路创建失败`); continue; }
            madeLines += 1;
            madeVehicles += await Transit.demoFleet(plan, lineId);
          }
        });
        // 服务端给的分组信息：display =「生成示例线路与车辆（12 步）」，undoLabel =「撤销：…」
        const group = Transit.ackGroup(groupAck);
        Transit._demoUndoLabel = (group && group.undoLabel) || null;
        const display = (group && group.display) || Transit.DEMO_GROUP_LABEL;
        // 让玩家一眼看到结果：清掉可能挡住它们的筛选
        Transit.filters.kind = 'all';
        Transit.filters.status = 'all';
        Transit.filters.search = '';
        Transit.panelTab = 'lines';
        Transit.selected = null;
        Transit.renderPanelSoon();
        if (Render.overlay) Render.overlay.redraw();
        util.toast(`已生成示例数据：${madeLines} 条线路 · ${madeStations} 个新车站 · ${madeVehicles} 辆车 —— ${display}（示例/测试数据，撤销一次回退整组）`,
          madeLines ? 'success' : 'warn', 7000);
        if (skipped.length) util.toast('部分示例线跳过：' + skipped.join('；'), 'warn', 9000);
        if (!madeLines && before === 0) {
          util.toast('这一带既没有现成的车站，也建不了新站：请把地图移到城市里（有道路 / 轨道的地方）再试，或先用「设站」建几个站。', 'error', 9000);
        }
      } catch (err) {
        util.toast('生成示例数据失败：' + ((err && err.message) || '未知错误'), 'error', 6000);
      } finally {
        Transit._demoBusy = false;
      }
    },

    /** 示例数据的中心：优先用当前地图视野中心，其次用已有车站的平均位置 */
    demoCenter() {
      try {
        const c = Render.map && Render.map.getCenter ? Render.map.getCenter() : null;
        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) return { lat: c.lat, lon: c.lng };
      } catch { /* 地图还没就绪就用车站的平均位置 */ }
      const stations = (Transit.data && Transit.data.stations) || [];
      if (stations.length) { const c = util.centroid(stations); return { lat: c.lat, lon: c.lng }; }
      return { lat: 39.9042, lon: 116.4074 };   // 兜底：北京
    },

    /** kind 属于轨道类（地铁/轻轨/有轨/铁路/高铁/城际） */
    isRailKind(kind) { return !!RAIL_KINDS[kind]; },

    /** 以 center 为起点，沿 bearing 方向走 forwardM、再侧移 sideM 的坐标 */
    demoPoint(center, bearingDeg, forwardM, sideM) {
      const rad = (Number(bearingDeg) || 0) * Math.PI / 180;
      const f = Number(forwardM) || 0;
      const s = Number(sideM) || 0;
      const east = f * Math.sin(rad) + s * Math.cos(rad);
      const north = f * Math.cos(rad) - s * Math.sin(rad);
      const dLat = north / 110574;
      const dLon = east / (111320 * Math.max(0.2, Math.cos(center.lat * Math.PI / 180)));
      return { lat: center.lat + dLat, lon: center.lon + dLon };
    },

    /**
     * 一条示例线的车站：
     *   1) 先用数据集里已有的站（我的 + 公共·导入；它们本来就吸附在真实道路/轨道上），贪心串成一条走廊；
     *   2) 不够就在走廊方向上新建，服务端会把它吸附到最近的真实道路（公交站）/ 轨道（地铁站）；
     *   3) 还是不够就少几站（但至少 2 站才能成线）。
     */
    async demoStopsFor(plan, center, used) {
      const want = Math.max(3, Math.min(4, Number(plan.stops) || 4));
      const rail = plan.kind !== 'bus';
      const all = (Transit.data && Transit.data.stations) || [];
      const usable = all.filter((s) => Transit.isPublicStation(s) || Transit.isMineItem('stations', s));
      const pool = usable
        .filter((s) => (rail ? Transit.isRailKind(s.kind) : s.kind === 'bus'))
        .sort((a, b) => util.metersBetween(a, center) - util.metersBetween(b, center));
      const stops = Transit.demoChain(pool, used, want, center);
      let created = 0;
      // 现有车站不够：从最后一个站继续沿走廊方向往外补建（没站时从地图中心出发），
      // 服务端会把每个新站吸附到最近的真实道路（公交站）/ 轨道（地铁站）；吸不上就换远一点的位置再试。
      if (stops.length < want) {
        const label = plan.name.replace(Transit.DEMO_PREFIX, '');
        const spacing = rail ? 900 : 500;
        const jitter = rail ? [0, 250, -250, 500] : [0, 160, -160, 320];
        let dist = spacing;
        let tries = 0;   // 上限 10 次建站请求：这一带没路 / 没轨道时别把服务器刷爆，早点说清楚
        for (let guard = 0; stops.length < want && guard < 8 && tries < 10; guard++) {
          const last = stops[stops.length - 1];
          const origin = last ? { lat: last.lat, lon: last.lon } : center;
          let made = null;
          for (const side of jitter) {
            if (tries >= 10) break;
            tries += 1;
            const pt = Transit.demoPoint(origin, plan.bearing, dist, side);
            made = await Transit.demoMakeStation(`${Transit.DEMO_PREFIX}${label}·${stops.length + 1}号站`, rail ? 'subway' : 'bus', pt.lat, pt.lon);
            if (made) break;
          }
          if (!made) { dist *= 1.7; continue; }   // 这一段没有路 / 轨道，往更远处再试
          stops.push(made);
          used.add(Number(made.id));   // 这条线新建的站不再给下一条示例线复用，三条线才是三条不同的走向
          created += 1;
          dist = spacing;
        }
      }
      return { stops, created };
    },

    /** 贪心串站：从离 center 最近的站出发，每次挑离上一站最近的没用过的站（像一条真实走廊） */
    demoChain(pool, used, want, center) {
      const rest = (pool || []).filter((s) => s && !used.has(Number(s.id)));
      if (!rest.length) return [];
      let cur = rest.reduce((best, s) => (util.metersBetween(s, center) < util.metersBetween(best, center) ? s : best), rest[0]);
      const out = [cur];
      used.add(Number(cur.id));
      while (out.length < want) {
        let next = null;
        let bestD = Infinity;
        for (const s of rest) {
          if (used.has(Number(s.id))) continue;
          const d = util.metersBetween(cur, s);
          if (d < bestD) { bestD = d; next = s; }
        }
        if (!next || bestD > 6000) break;   // 下一站太远（>6 km）就不硬凑，宁可这条线短一点
        used.add(Number(next.id));
        out.push(next);
        cur = next;
      }
      return out;
    },

    /** 在某个坐标建一个站（服务端负责吸附路网）；建不了（附近没有路 / 轨道）返回 null */
    demoMakeStation(name, kind, lat, lon) {
      return Transit.op({ k: 'station.create', name, kind, lat, lon })
        .then((res) => (res && res.result && res.result.station) || null)
        .catch(() => null);
    },

    /** 建一条示例线路（line.create：站直接给 stops，服务端沿路网算路径） */
    demoCreateLine(plan, stops) {
      const colors = { bus: '#f58231', subway: '#4363d8' };
      return Transit.op({
        k: 'line.create',
        name: plan.name,
        kind: plan.kind,
        color: plan.color || colors[plan.kind] || '#8ab4f8',
        stops: stops.map((s) => Number(s.id)),
      })
        .then((res) => {
          const line = res && res.result && res.result.line;
          if (line) {
            const local = Transit.lineById(line.id);
            if (local) Object.assign(local, line);
            Transit.selectedLine = line.id;
          }
          const path = (res && res.result && res.result.path) || {};
          if (path.error) util.toast(`${plan.name} 已建好，但路径不通：${path.error}`, 'warn', 6000);
          return line ? line.id : null;
        })
        .catch((err) => {
          util.toast(`${plan.name} 创建失败：${(err && err.message) || '未知错误'}`, 'error', 6000);
          return null;
        });
    },

    /** 示例线路配车（vehicle.create + lineId）：车型优先用服务端下发的车型表里的 key */
    async demoFleet(plan, lineId) {
      const kind = Transit.demoVehicleKind(plan.kind);
      let made = 0;
      for (let i = 0; i < (plan.vehicles || 2); i++) {
        try {
          await Transit.op({ k: 'vehicle.create', kind, lineId });
          made += 1;
        } catch { /* 单辆失败就少配一辆，不影响别的 */ }
      }
      return made;
    },

    /** 示例数据用哪种车型：优先用服务端车型表里真实存在的 key */
    demoVehicleKind(kind) {
      const keys = Object.keys(Transit.vehicleKinds() || {});
      const pick = (list, fallback) => list.find((k) => keys.includes(k)) || fallback;
      if (kind === 'bus') return pick(['bus', 'bus_artic', 'bus_double', 'trolley', 'minibus', 'rail'], 'bus');
      return pick(['metro_b4', 'metro_b6', 'metro_a8', 'tram', 'crh6', 'bus'], 'bus');
    },

    /** 一键清除示例数据：先删配车，再删线路，最后删示例专用的车站（整批一组，撤销一步） */
    async clearDemoData() {
      if (Transit._demoBusy) { util.toast('正在处理示例数据，稍等一下…', 'info', 2500); return; }
      const lines = Transit.demoLines();
      if (!lines.length) { util.toast('没有示例数据', 'info', 2500); return; }
      const ids = new Set(lines.map((l) => Number(l.id)));
      const vehicles = Transit.myVehicles().filter((v) => ids.has(Number(v.lineId)));
      const keep = new Set();
      for (const l of Transit.myLines()) {
        if (ids.has(Number(l.id))) continue;
        for (const sid of l.stops || []) keep.add(Number(sid));   // 别的线路还在用的站不能删
      }
      const stations = ((Transit.data && Transit.data.stations) || []).filter((s) => (s.owner === Editor.myId || Transit.isMineItem('stations', s))
        && String(s.name || '').startsWith(Transit.DEMO_PREFIX) && !keep.has(Number(s.id)));
      if (!window.confirm([
        '清除示例数据？',
        '',
        `· 删除 ${lines.length} 条【示例】线路：${lines.map((l) => l.name).join('、')}`,
        `· 删除 ${vehicles.length} 辆示例配车`,
        `· 删除 ${stations.length} 个示例专用车站`,
        '（整批包成一组：撤销键按一次就全部还原；别的线路在用的车站不会删）',
      ].join('\n'))) return;

      Transit._demoBusy = true;
      try {
        const groupAck = await Transit.withUndoGroup(Transit.DEMO_CLEAR_LABEL, async () => {
          for (const v of vehicles) await Transit.op({ k: 'vehicle.delete', id: v.id }).catch(() => {});
          for (const l of lines) await Transit.op({ k: 'line.delete', id: l.id }).catch(() => {});
          for (const s of stations) await Transit.op({ k: 'station.delete', id: s.id }).catch(() => {});
        });
        const group = Transit.ackGroup(groupAck);
        const display = (group && group.display) || Transit.DEMO_CLEAR_LABEL;
        Transit._demoUndoLabel = (group && group.undoLabel) || Transit._demoUndoLabel;
        Transit.selected = null;
        Transit.selectedLine = null;
        Transit.selectedVehicle = null;
        Transit.renderPanelSoon();
        if (Render.overlay) Render.overlay.redraw();
        util.toast(`示例数据已清除：${lines.length} 条线路 · ${vehicles.length} 辆车 · ${stations.length} 个车站 —— ${display}（撤销一次全部还原）`, 'success', 6000);
      } finally {
        Transit._demoBusy = false;
      }
    },

    /**
     * 选中线路：整块详情交给线路管理器（linemgr.js）渲染 —— 面板里那一份就是**唯一**的实现
     * （linemgr 的独立窗口已经删掉，不再有第二个入口，也就不会出现两套按钮）。
     */
    renderLineDetail(box, line) {
      if (!line) { Transit.renderLineOverview(box); return; }
      const host = util.el('div', 'tp-embed');
      box.appendChild(host);
      const mgr = window.G.LineMgr;
      if (mgr && typeof mgr.embed === 'function') {
        mgr.embed(host, { lineId: line.id });
        // 被别人锁着 → 补一层只读（横幅 + 冻住控件；linemgr 自己的 canEdit 只看元素锁，所以按钮都在）
        Transit.freezeLockedHost(host, 'line', line.id);
      } else {
        host.appendChild(util.el('div', 'empty-hint small', '线路管理器模块（public/js/linemgr.js）没加载：暂时看不到站点顺序、车队与客流'));
      }
    },

    /* ------------------------------ 详情：车辆 ------------------------------ */

    /** 车辆分区、没选车时：造车（车型芯片）+ 批量工具（闲置车辆处理） */
    renderVehicleOverview(box) {
      const block = util.el('div', 'tp-block');
      block.appendChild(util.el('div', 'tp-blocktitle', '造车（点车型直接新建）'));
      const kindsWrap = util.el('div', 'opt-chips');
      for (const [key, preset] of Object.entries(Transit.vehicleKinds())) {
        const bus = VEHICLE_MIN_ZOOM[key] && VEHICLE_MIN_ZOOM[key] >= 15;
        const b = util.el('button', 'chip',
          `${bus ? '🚌' : '🚈'} ${util.esc(preset.name)} <em>${preset.lengthM}m/${preset.cars * preset.capacityPerCar}人</em>`);
        b.title = `长度 ${preset.lengthM} 米 · ${preset.cars} 节 · 定员 ${preset.cars * preset.capacityPerCar} 人 · 最高 ${preset.maxSpeed} km/h`;
        b.onclick = () => Transit.createVehicle(key);
        kindsWrap.appendChild(b);
      }
      block.appendChild(kindsWrap);
      block.appendChild(util.el('div', 'tp-note', '车长决定地图上的示意大小；造好后在左侧点它，右侧可以换线 / 改名 / 删除。'));
      box.appendChild(block);

      const idle = Transit.myVehicles().filter((v) => !v.lineId);
      const bulk = util.el('div', 'tp-block');
      bulk.appendChild(util.el('div', 'tp-blocktitle', `批量操作（闲置 ${idle.length} 辆）`));
      const lineSel = util.el('select', 'tp-select small');
      const noneOpt = util.el('option', null, '（先选一条线路）');
      noneOpt.value = '';
      lineSel.appendChild(noneOpt);
      for (const l of Transit.myLines()) {
        const o = util.el('option', null, `${l.name}（${MODE_LABEL[l.kind] || l.kind} · ${Transit.lineVehicleCount(l)} 辆）`);
        o.value = String(l.id);
        lineSel.appendChild(o);
      }
      bulk.appendChild(lineSel);
      const assign = util.el('button', 'opt-btn', '🚌 把闲置车辆全部加入这条线路');
      assign.onclick = () => {
        if (!lineSel.value) { util.toast('先在下拉里选一条线路', 'warn'); return; }
        Transit.assignIdleToLine(Number(lineSel.value));
      };
      bulk.appendChild(assign);
      const del = util.el('button', 'opt-btn danger', `🗑 批量删除闲置车辆（${idle.length} 辆）`);
      del.title = '把没有指派任何线路的车一次删掉，可撤销';
      del.onclick = () => Transit.deleteIdleVehicles(idle);
      bulk.appendChild(del);
      // 「车辆气泡」开关只在工具栏上有一份（图层开关），这里不再重复挂一个
      box.appendChild(bulk);

      box.appendChild(util.el('div', 'tp-note',
        '左侧车辆列表可以用「状态」筛选（闲置 / 已指派 / 在跑 / 载客 > 80%），也可以按载客、车长排序；'
        + '点一行就看这辆车的管理器（基本信息 / 服役与里程 / 本班车的停靠站序列与每站预计到站 / 车上乘客按目的站分组），'
        + '地图上会同时弹出那个小车气泡。'
        + '地图上的车辆气泡开关在工具栏上（每辆车一行小字）；地图缩得太远（视野超过 600 米/100 像素）时，'
        + '车站、等车人数与车辆气泡都会自动隐藏，缩回来就出现。'
        + '点地图上的公交车（车身或它旁边的气泡）只弹那个小气泡：不切分区、不开别的窗口 —— '
        + '车辆管理器在左侧列表里点一下这辆车就出来（载客 / 换线 / 删除都在那里）。'));
    },

    /** 批量删除闲置车辆（没指派线路的车） */
    deleteIdleVehicles(list) {
      const idle = (list || Transit.myVehicles().filter((v) => !v.lineId)).filter(Boolean);
      if (!idle.length) { util.toast('没有闲置车辆', 'info', 2500); return; }
      const eco = Transit.config && Transit.config.economy;
      if (!window.confirm(`删除 ${idle.length} 辆闲置车辆？${eco ? '（返还一半购车款）' : ''}（可以撤销）`)) return;
      let chain = Promise.resolve();
      let done = 0;
      for (const v of idle) {
        chain = chain.then(() => Transit.op({ k: 'vehicle.delete', id: v.id })
          .then(() => { done += 1; })
          .catch(() => { /* 单辆失败继续下一辆 */ }));
      }
      chain.then(() => {
        util.toast(`已删除 ${done} / ${idle.length} 辆闲置车辆`, done ? 'success' : 'warn', 4000);
        Transit.selected = Transit.selected && Transit.selected.type === 'vehicle'
          && idle.some((v) => v.id === Transit.selected.id) ? null : Transit.selected;
        Transit.renderPanelSoon();
      });
    },

    /** 把公司所有闲置车辆一次加入某条线路 */
    assignIdleToLine(lineId) {
      const line = Transit.lineById(lineId);
      if (!line) { util.toast('先选一条线路', 'warn'); return; }
      const idle = Transit.myVehicles().filter((v) => !v.lineId);
      if (!idle.length) { util.toast('没有闲置车辆可以加入', 'info', 2500); return; }
      Transit.assignVehicles(idle, line.id);
    },

    /* ------------------------------ 车辆管理器（面板「车辆」分区的详情） ------------------------------ */

    /**
     * 这辆车这一趟的停靠站序列：每站的计划/预计到站时刻 + 已停/未停。
     *
     * 时刻表来源（按可信度从高到低，serviceText 会如实说明用的是哪一份）：
     *   1) current —— 本趟：line.runs 里"派给这辆车、且发车时刻 = 这辆车本趟计划发车时刻"的那一班，
     *                 逐站时刻取它自己的 stopsEta（服务端 _runTable 按车型加减速算出来的预测到站）
     *   2) next    —— 本车下一班：runs 里派给这辆车的第一班（车在首站等点时就是它）
     *   3) lineNext—— 这条线的下一班（**不一定是这辆车**！服务端 line.stopsEta 给的就是"下一班"的表）
     *   4) none    —— 自由发车 / 没配班次：没有计划时刻，只有下一站用服务端的实时 etaSeconds
     *
     * 已停/未停按**行驶方向**判断（服务端 direction：+1 = 去程，-1 = 回程）：
     * 车前方 = 待停，车后方 = 已经开过（这一轮停过了）；正在站台上下客的那一站是「停靠中」。
     * 全是服务端真实字段，缺哪个就把哪一格如实留成 '—'，不编数字。
     */
    vehicleStopPlan(v, live) {
      const out = {
        line: null, rows: [], source: 'none', sourceText: '', departure: '',
        servedCount: 0, pathEnd: 0, nextEtaText: '', arrTitle: '计划到站',
      };
      const line = v ? Transit.lineById(v.lineId) : null;
      if (!line) return out;
      out.line = line;
      const info = (line.stopsInfo || []).filter((s) => s && Number.isFinite(Number(s.distance)));
      const stops = info.length
        ? info.map((s) => ({ stationId: Number(s.stationId), name: s.name, distance: Number(s.distance) }))
        : (line.stops || []).map((sid) => {
          const st = Transit.stationById(sid);
          return { stationId: Number(sid), name: st ? st.name : `#${sid}`, distance: null };
        });
      if (stops.length && Number.isFinite(stops[stops.length - 1].distance)) {
        out.pathEnd = stops[stops.length - 1].distance;
      }
      const runs = Transit.lineRuns(line).filter((r) => r && typeof r === 'object');
      // #车厂：不在运营的车没有实时帧，但车辆的整份数据（vehicles[]）里同样有
      // nextStop / scheduledDepartureTime / etaSeconds / state / progress —— 用同一套字段，
      // 于是"在车厂的车"也能显示"下一班 08:15 发车 + 各站计划到站"。
      const trip = live || v || null;
      const depot = Transit.vehicleDepotInfo(v, live);
      const depNow = Transit.fmtClock(trip && (trip.scheduledDepartureTime || trip.scheduledDeparture));
      // 班次派车（服务端 _departureVehicleId）：只有 vehicleId 对得上的才是"本车的班"
      const mine = runs.filter((r) => r.vehicleId != null && Number(r.vehicleId) === Number(v.id));
      // 在车厂的车**还没跑这一趟**：它那一班的逐站时刻是"计划"，不能说成"本趟"（serviceText 会说清）
      let run = (!depot.depot && depNow) ? (mine.find((r) => Transit.runTime(r) === depNow) || null) : null;
      let source = run ? 'current' : 'none';
      if (!run && mine.length) { run = mine[0]; source = 'next'; }
      let table = null;
      if (run) {
        out.departure = Transit.runTime(run) || depNow || '';
        table = (Array.isArray(run.stopsEta) && run.stopsEta.length) ? run.stopsEta : null;
      }
      if (!table && !mine.length && Array.isArray(line.stopsEta) && line.stopsEta.length) {
        table = line.stopsEta;
        source = 'lineNext';
        out.departure = Transit.runTime(runs[0]) || depNow || '';
      }
      if (!run && !table && depNow) out.departure = depNow;
      out.source = source;
      out.arrTitle = source === 'current' ? '预计到站' : '计划到站';
      const runVeh = run && run.vehicleName ? String(run.vehicleName) : '';
      out.sourceText = source === 'current' ? `本趟 · ${out.departure || '—'} 发车`
        : source === 'next' ? `本车下一班 · ${out.departure || '—'} 发车`
          : source === 'lineNext' ? `这条线的下一班${runVeh ? `（${runVeh} 开）` : ''} · ${out.departure || '—'} 发车`
            : (depNow ? `本趟 · ${depNow} 发车` : '自由发车：没有班次时刻表');
      // 逐站时刻表（两种形状都吃：[车站 id, 到站秒, 发车秒] 与 { stationId, arrival, departure }）
      const bySid = new Map();
      for (const e of (table || [])) {
        if (!e) continue;
        const arr = Array.isArray(e) ? Transit.fmtClock(Number(e[1])) : (Transit.fmtClock(e.arrival) || Transit.fmtClock(e.arrivalSec));
        const dep = Array.isArray(e) ? Transit.fmtClock(Number(e[2])) : (Transit.fmtClock(e.departure) || Transit.fmtClock(e.departureSec));
        const sid = Number(Array.isArray(e) ? e[0] : e.stationId);
        if (Number.isFinite(sid)) bySid.set(sid, { arr: arr || '—', dep: dep || '—' });
      }
      const dist = Number(live && live.distance != null ? live.distance : (v ? v.progress : NaN));
      const dir = Number((live && live.direction) || 1) >= 0 ? 1 : -1;
      const nextSid = trip && trip.nextStop && trip.nextStop.stationId != null
        ? Number(trip.nextStop.stationId) : null;
      const servedSid = live && live.lastServedStation != null ? Number(live.lastServedStation) : null;
      const dwelling = !!(live && live.state === 'dwell');
      // 在车厂的车：etaSeconds 是"还有多久到发车时刻"（服务端在 vehicles[] 里照旧给），
      // 于是"下一站 = 始发站 · 约 1 分 0 秒"这一格在车厂里也是活的。
      const nextEta = Transit.etaSecondsOf(trip);
      out.nextEtaText = nextEta == null ? '' : '约 ' + Transit.fmtSeconds(nextEta);
      stops.forEach((s, i) => {
        const plan = bySid.get(Number(s.stationId)) || null;
        let state = 'todo';
        if (dwelling && servedSid != null && servedSid === Number(s.stationId)) state = 'now';
        else if (nextSid != null && nextSid === Number(s.stationId)) state = 'next';
        else if (Number.isFinite(dist) && Number.isFinite(s.distance)) {
          const passed = dir > 0 ? (s.distance < dist - 1) : (s.distance > dist + 1);
          if (passed) state = 'served';
        }
        if (state === 'served') out.servedCount += 1;
        out.rows.push({
          idx: i + 1, stationId: Number(s.stationId), name: s.name || `#${s.stationId}`,
          distance: s.distance, state,
          stateText: state === 'now' ? '停靠中' : (state === 'next' ? '下一站' : (state === 'served' ? '已停' : '待停')),
          arrText: plan ? plan.arr : '—',
          depText: plan ? plan.dep : '—',
          etaText: state === 'next' ? out.nextEtaText : '',
        });
      });
      return out;
    },

    /**
     * 车上乘客按目的站分组（服务端快照帧 trains[].paxByDest =
     * [{ stationId, name, people, transfers }]，transfers = 这批人里还要换乘的人次）。
     * 只有**在路上**的车才在这份数据里（闲置车没有 runtime）—— 这时如实返回 available:false。
     */
    vehiclePaxByDest(live) {
      const raw = (live && Array.isArray(live.paxByDest)) ? live.paxByDest : null;
      if (!raw) return { available: false, rows: [], total: 0, transfers: 0 };
      let total = 0;
      let transfers = 0;
      const rows = [];
      for (const d of raw) {
        const people = Number(d && d.people) || 0;
        const tr = Number(d && d.transfers) || 0;
        if (!(people > 0)) continue;
        total += people;
        transfers += tr;
        const sid = d && d.stationId != null ? Number(d.stationId) : null;
        const st = sid == null ? null : Transit.stationById(sid);
        rows.push({
          stationId: sid,
          name: (d && d.name) || (st ? st.name : (sid == null ? '去向未知' : `#${sid}`)),
          people, transfers: tr,
        });
      }
      rows.sort((a, b) => b.people - a.people);
      return {
        available: true, rows,
        total: Math.round(total * 10) / 10,
        transfers: Math.round(transfers * 10) / 10,
      };
    },

    /** 车上乘客分组的一行行 HTML（实时刷新时整块换掉，见 fillVehicleMgrLive） */
    vehiclePaxListHtml(live, v) {
      const pax = Transit.vehiclePaxByDest(live);
      if (!pax.available) {
        // #车厂：不在运营的车没有实时乘客数据（车上的人在下一次停站才动，服务端也不再算它）
        const depot = Transit.vehicleDepotInfo(v, live);
        return `<div class="empty-hint small">${depot.depot
          ? `${util.esc(depot.text)}：车不在路上，没有实时乘客数据。`
          : '这辆车现在不在路上（闲置 / 还没上线），没有实时乘客数据。'}</div>`;
      }
      if (!pax.rows.length) return '<div class="empty-hint small">车上现在没有乘客。</div>';
      const max = pax.rows.reduce((m, r) => Math.max(m, r.people), 0) || 1;
      return pax.rows.map((r) => `<div class="veh-pax-row" data-dest="${r.stationId == null ? '' : r.stationId}">
          <span class="veh-pax-name">${util.esc(r.name)}</span>
          <span class="veh-pax-bar" style="width:${Math.max(6, Math.round((r.people / max) * 42))}px"></span>
          <span class="veh-pax-n">${util.fmt(r.people)} 人</span>
          ${r.transfers > 0 ? `<span class="veh-pax-tr">其中需换乘 ${util.fmt(r.transfers)} 人</span>` : ''}
        </div>`).join('');
    },

    /**
     * 服役时间 / 上线时刻 / 里程。
     * **服务端现在没有的字段不编**：
     *   - 服役时间（车辆建档时刻）：vehicles 表里有 created_at，但 vehiclePublic() 与快照帧都没带 → '—'
     *   - 按车辆累计的今日里程：服务端只有**按线路**的当日车公里（linePublic().dayStats.vehicleKm）
     *     → 「今日里程」显示线路合计并注明；「本趟已行驶」按实时里程算（去程 = distance，回程 = 2×线长 − distance）
     */
    vehicleLifetime(v, live) {
      const line = v ? Transit.lineById(v.lineId) : null;
      const stopPlan = Transit.vehicleStopPlan(v, live);
      const pathEnd = Number(stopPlan.pathEnd) || Number(line && line.pathLen) || 0;
      const dist = Number(live && live.distance != null ? live.distance : (v ? v.progress : NaN));
      const dir = Number((live && live.direction) || 1) >= 0 ? 1 : -1;
      let tripM = null;
      if (Number.isFinite(dist) && pathEnd > 0) {
        tripM = dir > 0 ? Math.min(Math.max(dist, 0), pathEnd) : Math.max(0, 2 * pathEnd - dist);
      }
      const day = (line && line.dayStats) || {};
      const lineKm = Number(day.vehicleKm != null ? day.vehicleKm : (line ? line.vehicleKm : 0)) || 0;
      return {
        pathEnd,
        tripMeters: tripM,
        tripText: tripM == null ? '—' : util.fmtLength(tripM),
        lineKm,
        lineKmText: line ? `${Math.round(lineKm * 10) / 10} 车公里` : '—',
        serviceText: '—',                 // 服务端没有暴露（见上面的说明）
        departText: stopPlan.departure || '',
        sourceText: stopPlan.sourceText,
        onlineText: stopPlan.departure
          ? `${stopPlan.departure} 发车（${stopPlan.source === 'next' || stopPlan.source === 'lineNext' ? '下一班' : '本趟'}）`
          : (live ? '在线上（自由发车，没有班次时刻）' : '还没上线'),
      };
    },

    /** 停靠站序列表格（每站：预计/计划到站、发车、已停/未停） */
    vehicleStopsTableHtml(v, live) {
      const plan = Transit.vehicleStopPlan(v, live);
      if (!plan.line) {
        return '<div class="empty-hint small">这辆车还没指派线路：下面选一条线路（或在线路管理器里把它加进线路），才有停靠站序列。</div>';
      }
      if (!plan.rows.length) return '<div class="empty-hint small">这条线路还没有停靠站（在线路管理器里加站）。</div>';
      const rows = plan.rows.map((r) => `<tr class="${r.state === 'now' ? 'now' : (r.state === 'served' ? 'served' : '')}">
          <td class="num">${r.idx}</td>
          <td class="name">${util.esc(r.name)}</td>
          <td class="num">${util.esc(r.arrText)}</td>
          <td class="num">${util.esc(r.depText)}</td>
          <td><span class="veh-state ${r.state}">${util.esc(r.stateText)}</span>${r.state === 'next'
        ? ` <span class="tp-lag" data-vlive="vm-nexteta">${util.esc(r.etaText)}</span>` : ''}</td>
        </tr>`).join('');
      return `<div class="veh-scroll"><table class="veh-table">
        <thead><tr><th>#</th><th>停靠站</th><th>${util.esc(plan.arrTitle)}</th><th>发车</th><th>状态</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    },

    /**
     * 车辆管理器的正文（面板「车辆」分区右侧详情就是它；没有第二个入口）。
     * 包含：基本信息（车型/车长/定员/载客/最高速）、服役与里程、本班车的停靠站序列、车上乘客按目的站分组。
     * 实时数字用 data-live / data-vlive 标出来，模拟帧里由 fillVehicleMgrLive 就地改，不整块重建。
     */
    vehicleManagerBodyHtml(v) {
      if (!v) return '';
      const live = Transit.liveVehicle(v.id);
      const run = Transit.vehicleRunInfo(v, live);
      const line = Transit.lineById(v.lineId);
      const life = Transit.vehicleLifetime(v, live);
      const plan = Transit.vehicleStopPlan(v, live);
      const pax = Transit.vehiclePaxByDest(live);
      // #车厂：不在运营的车不在地图上 —— 详情里要说清"它在车厂、为什么、下一班几点"
      const depot = Transit.vehicleDepotInfo(v, live);
      const owner = ((Transit.data && Transit.data.companies) || [])
        .find((c) => c.id === (v.companyId === undefined ? v.owner : v.companyId));
      const paxTotal = !pax.available
        ? '—'
        : `${util.fmt(pax.total)} 人（${pax.rows.length} 个目的站${pax.transfers > 0 ? ` · 需换乘 ${util.fmt(pax.transfers)} 人` : ''}）`;
      const destCount = plan.rows.length;
      // 在车厂的车：多一行「在车厂」，把原因与下一班摆在一眼看得见的地方（用户口径的验收点）
      const depotRow = depot.depot && v.lineId
        ? `<div class="tp-row depot-row"><span>在车厂</span><b>${util.esc([depot.short.replace('（未运营）', ''), depot.nextText, '未运营'].filter(Boolean).join(' · '))}</b></div>
        <div class="tp-note">${util.esc(depot.text)}：不在运营的车不会画在地图上（车停在车厂）。恢复运营 / 到下一班发车时刻，它会自己回到线路上。</div>`
        : '';
      return `<div class="tp-blocktitle">基本信息</div>
        <div class="tp-row"><span>车型</span><b>${util.esc(Transit.kindLabel(v.kind))} <small>#${v.id}${owner ? ' · ' + util.esc(owner.name) : ''}</small></b></div>
        <div class="tp-row"><span>车长</span><b>${util.fmt(v.lengthM)} 米</b></div>
        <div class="tp-row"><span>定员</span><b>${util.fmt(v.capacity)} 人 <small>${util.fmt(v.cars)} 节 × ${util.fmt(v.capacityPerCar)} 人</small></b></div>
        <div class="tp-row" data-live="vload"><span>载客</span><b data-vlive="vm-load">${util.esc(run.loadText)}</b></div>
        <div class="tp-row"><span>最高速度</span><b>${util.fmt(v.maxSpeed)} km/h</b></div>
        <div class="tp-row" data-live="vstate"><span>状态</span><b data-vlive="vm-state">${util.esc(Transit.vehicleStateText(v, live))}</b></div>
        ${depotRow}
        <div class="tp-row"><span>所在线路</span><b>${line ? util.esc(line.name) : '闲置（不跑）'} ${line ? `<small>${util.esc(Transit.lineScheduleSummary(line))}</small>` : ''}</b></div>
        <div class="tp-row" data-live="vnext"><span>下一站</span><b data-vlive="vm-next">${util.esc(run.nextStop)}</b></div>
        <div class="tp-row" data-live="veta"><span>预计到站</span><b data-vlive="vm-eta">${util.esc(run.etaText)}</b></div>
        <div class="tp-row" data-live="vsched"><span>班次 / 准点</span><b data-vlive="vm-sched" class="${run.late ? 'warn' : ''}">${util.esc(Transit.vehicleSchedText(run))}</b></div>
        <div class="tp-row" data-live="vboard"><span>本站上客</span><b data-vlive="vm-board">${util.esc(Transit.vehicleBoardText(live))}</b></div>

        <div class="veh-mgr-sub">服役与里程</div>
        <div class="tp-row"><span>服役时间</span><b>${util.esc(life.serviceText)} <small>车辆建档时刻服务端还没下发</small></b></div>
        <div class="tp-row"><span>上线时刻</span><b>${util.esc(life.onlineText)}</b></div>
        <div class="tp-row"><span>本趟已行驶</span><b data-vlive="vm-trip">${util.esc(life.tripText)}</b></div>
        <div class="tp-row"><span>今日里程</span><b>${util.esc(life.lineKmText)} <small>本线路全天车公里合计</small></b></div>

        <div class="veh-mgr-sub">${depot.depot ? '下一班的停靠站序列' : '本班车的停靠站序列'} <b>${plan.servedCount} / ${destCount}</b>
          <small>${util.esc(plan.sourceText)}</small></div>
        ${Transit.vehicleStopsTableHtml(v, live)}
        <div class="tp-note">状态按行驶方向判断：车前方 = 待停，车后方 = 已停（这一轮已经停过），停靠中 = 正在站台上下客。</div>

        <div class="veh-mgr-sub">车上乘客（按目的站分组） <small>共 <b data-vlive="vm-paxtotal">${paxTotal}</b></small></div>
        <div class="veh-pax" data-vlive="vm-paxlist">${Transit.vehiclePaxListHtml(live, v)}</div>
        <div class="tp-note">来自服务端快照帧的 paxByDest：车上每个人的目的站（要换乘的人也算在目的站里，所以一车人可能分成好几组）。</div>`;
    },

    /** 车辆管理器外框（面板「车辆」分区的详情用它；实时刷新只换里面的 .veh-mgr-body） */
    vehicleManagerBlockHtml(v, options) {
      if (!v) return '';
      const opt = options || {};
      const head = opt.compact ? ''
        : `<div class="veh-mgr-title">🚌 车辆管理器 · ${util.esc(v.name)} <small>#${v.id}</small></div>`;
      return `<div class="tp-block veh-mgr" data-veh-mgr="${v.id}">
        ${head}
        <div class="veh-mgr-body">${Transit.vehicleManagerBodyHtml(v)}</div>
      </div>`;
    },

    /** 内容指纹：结构（线路 / 班次来源 / 停靠序列 / 已停未停 / **在不在车厂**）变了才整块重建，数字走 fillVehicleMgrLive */
    vehicleManagerSignature(v) {
      if (!v) return '';
      const live = Transit.liveVehicle(v.id);
      const plan = Transit.vehicleStopPlan(v, live);
      // #车厂：在不在运营会影响整块正文（多一行「在车厂」、停靠序列的标题也变），所以进指纹
      const depot = Transit.vehicleDepotInfo(v, live);
      return [
        v.id, v.name, v.kind, v.lineId == null ? '' : v.lineId,
        v.load, v.capacity, v.maxSpeed, v.lengthM, v.cars, v.capacityPerCar,
        depot.depot ? `depot:${depot.reason}:${depot.nextText}` : 'run',
        plan.source, plan.departure,
        plan.rows.map((r) => `${r.stationId}:${r.arrText}:${r.depText}:${r.state}`).join(','),
        Transit.vehiclePaxByDest(live).rows.map((r) => `${r.stationId}:${r.people}`).join(','),
      ].join('|');
    },

    /** 模拟帧里就地改管理器里的实时数字（不重建 DOM，正要点按钮/看表格时不会被打断） */
    fillVehicleMgrLive(root, v, live) {
      if (!root || typeof root.querySelector !== 'function' || !v) return;
      const info = Transit.vehicleRunInfo(v, live);
      const set = (key, html) => {
        const el = root.querySelector(`[data-vlive="${key}"]`);
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      const setRow = (key, text) => {
        const el = root.querySelector(`[data-live="${key}"] b`);
        if (el && el.textContent !== text) el.textContent = text;
      };
      setRow('vload', info.loadText);
      setRow('vnext', info.nextStop);
      setRow('veta', info.etaText);
      setRow('vsched', Transit.vehicleSchedText(info));
      setRow('vboard', Transit.vehicleBoardText(live));
      setRow('vstate', Transit.vehicleStateText(v, live));
      set('vm-load', util.esc(info.loadText));
      set('vm-state', util.esc(Transit.vehicleStateText(v, live)));
      set('vm-next', util.esc(info.nextStop));
      set('vm-eta', util.esc(info.etaText));
      set('vm-board', util.esc(Transit.vehicleBoardText(live)));
      const schedEl = root.querySelector('[data-vlive="vm-sched"]');
      if (schedEl) {
        const html = Transit.vehicleScheduleHtml(info);
        if (schedEl.innerHTML !== html) schedEl.innerHTML = html;
        schedEl.classList.toggle('warn', !!info.late);
      }
      const life = Transit.vehicleLifetime(v, live);
      set('vm-trip', util.esc(life.tripText));
      const plan = Transit.vehicleStopPlan(v, live);
      set('vm-nexteta', util.esc(plan.nextEtaText || ''));
      const pax = Transit.vehiclePaxByDest(live);
      set('vm-paxtotal', !pax.available
        ? '—'
        : `${util.fmt(pax.total)} 人（${pax.rows.length} 个目的站${pax.transfers > 0 ? ` · 需换乘 ${util.fmt(pax.transfers)} 人` : ''}）`);
      set('vm-paxlist', Transit.vehiclePaxListHtml(live, v));
    },

    /**
     * 刷新挂着的车辆管理器（就是面板「车辆」分区右侧那块），指纹变了整块重建，否则只改数字。
     * 鼠标停在管理器里时让路（不然正要点「撤下线路」时按钮会被换掉）。
     */
    refreshVehicleMgr(force) {
      const hosts = util.$$('[data-veh-mgr]');
      if (!hosts.length) return false;
      let any = false;
      if (!force && Transit._mgrHover && Date.now() - (Transit._mgrHoverAt || 0) < 4000) {
        Transit._mgrDirty = true;
        return false;
      }
      for (const host of hosts) {
        if (host.isConnected === false) continue;
        const v = Transit.vehicleById(Number(host.dataset.vehMgr));
        if (!v) continue;
        const body = host.querySelector('.veh-mgr-body');
        if (!body) continue;
        const sig = Transit.vehicleManagerSignature(v);
        if (force || sig !== host.dataset.sig) {
          body.innerHTML = Transit.vehicleManagerBodyHtml(v);
          host.dataset.sig = sig;
        } else {
          Transit.fillVehicleMgrLive(host, v, Transit.liveVehicle(v.id));
        }
        any = true;
      }
      return any;
    },

    /**
     * 选中车辆 = 车辆管理器：面板「车辆」分区的右侧详情就是它（唯一入口，没有第二个窗口）：
     *   基本信息（车型 / 车长 / 定员 / 载客 x/y / 最高速）+ 服役与里程 + 本班车的停靠站序列（含每站预计到站与已停/未停）
     *   + 车上乘客按目的站分组的人数；下面再接「指派线路」和 定位 / 撤下线路 / 详情气泡 / 改名 / 删除 这几个按钮。
     */
    renderVehicleDetail(box, v) {
      if (!v) { Transit.renderVehicleOverview(box); return; }
      const line = Transit.lineById(v.lineId);
      const live = Transit.liveVehicle(v.id);
      // 协作编辑：别人的车也能改（服务端不看 owner），只有"别人正锁着这辆车"时整块画成只读
      const lockBy = Transit.elemLockBy('vehicle', v.id);

      const wrap = util.el('div', 'veh-mgr-wrap');
      wrap.innerHTML = Transit.vehicleManagerBlockHtml(v, { compact: false });
      box.appendChild(wrap);

      const asg = util.el('div', 'tp-block');
      asg.appendChild(util.el('div', 'tp-blocktitle', '指派线路'));
      if (lockBy) asg.appendChild(util.el('div', 'tp-note warn', `🔒 ${util.esc(lockBusyText(lockBy))}（车辆管理器现在是只读的）`));
      const sel = util.el('select', 'tp-select small');
      const idle = util.el('option', null, '闲置（不跑）');
      idle.value = 'none';
      if (!v.lineId) idle.selected = true;
      sel.appendChild(idle);
      // 线路列表是**全服**的（自己的排前面）：协作编辑下谁建的线路都能派车上去
      for (const l of Transit.assignableLines()) {
        const co = Transit.companyById(l.companyId);
        const o = util.el('option', null,
          Transit.isMyCompanyAsset('lines', l) ? l.name : `${l.name}（${co ? co.name : '别家公司'}）`);
        o.value = String(l.id);
        if (v.lineId === l.id) o.selected = true;
        sel.appendChild(o);
      }
      sel.disabled = !!lockBy;
      if (lockBy) sel.title = lockBusyText(lockBy);
      sel.onchange = () => Transit.assignVehicle(v, sel.value === 'none' ? null : Number(sel.value));
      asg.appendChild(sel);
      if (line) {
        const sched = util.el('div', 'tp-note', `线路班次：${util.esc(Transit.lineScheduleSummary(line))}`);
        asg.appendChild(sched);
      }
      box.appendChild(asg);

      const acts = util.el('div', 'tp-actions');
      // 「详情气泡」/「定位」：都要车**已指派线路且有实时位置**（没指派的车没有"正在跑的位置"）
      const pos = Transit.vehiclePosInfo(v, live);
      const hasPos = pos.ok;
      const bubBtn = util.el('button', 'mini', '🚌 详情气泡');
      bubBtn.disabled = !hasPos;
      bubBtn.title = hasPos
        ? '在地图上弹出这辆车的详情气泡（车次 / 线路 / 载客 / 下一站 / 预计到站 / 班次准点 / 速度）'
        : pos.reason;
      bubBtn.onclick = () => Transit.openVehicleDetail(v.id);
      const loc = util.el('button', 'mini', '🗺 定位');
      loc.disabled = !hasPos;
      loc.title = hasPos ? '把地图移到这辆车' : pos.reason;
      loc.onclick = () => {
        if (!pos.ok) { util.toast(pos.reason, 'warn', 3000); return; }
        Render.map.setView(pos.at, Math.max(16, Render.map.getZoom()));
      };
      // 「撤下线路」：和地图气泡、线路管理器里的「－ 撤下勾选车辆」是同一条路径（vehicle.update lineId=null）
      const off = util.el('button', 'mini', '⤵ 撤下线路');
      off.disabled = !v.lineId || !!lockBy;
      off.title = lockBy ? lockBusyText(lockBy)
        : (v.lineId ? '把这辆车从线路上撤下来（变成闲置，不再跑；可撤销）' : '这辆车本来就是闲置的');
      off.onclick = () => {
        if (!v.lineId) { util.toast('这辆车本来就是闲置的', 'info', 2500); return; }
        Transit.assignVehicle(v, null);
      };
      const ren = util.el('button', 'mini', '✏ 改名');
      ren.disabled = !!lockBy;
      if (lockBy) ren.title = lockBusyText(lockBy);
      ren.onclick = () => Transit.renameVehicle(v);
      acts.appendChild(bubBtn);
      acts.appendChild(loc);
      acts.appendChild(off);
      acts.appendChild(ren);
      // 协作编辑：谁的车都能删（服务端不看 owner）—— 按钮一直画出来，只按元素锁禁用
      const del = util.el('button', 'mini danger', '🗑 删除');
      del.disabled = !!lockBy;
      del.title = lockBy ? lockBusyText(lockBy) : '卖掉 / 删除这辆车（可撤销；谁的车都能删）';
      del.onclick = () => Transit.sellVehicle(v);
      acts.appendChild(del);
      box.appendChild(acts);
    },

    /* ------------------------------ 详情：问题（空线路 / 坏线路 / 悬空车站） ------------------------------ */

    renderIssuesDetail(box) {
      const lines = Transit.query('lines', (Transit.data && Transit.data.lines) || []);
      const broken = lines.filter((l) => l.pathError);
      const empty = lines.filter((l) => !l.pathError && (l.stops || []).length < 2);
      const orphan = Transit.query('stations', (Transit.data && Transit.data.stations) || [])
        .filter((s) => !(s.nodeId || s.onRail));
      const st = util.el('div', 'tp-block');
      st.innerHTML = `<div class="tp-blocktitle">路网体检</div>
        <div class="tp-row"><span>路径不通</span><b class="${broken.length ? 'warn' : ''}">${broken.length} 条</b></div>
        <div class="tp-row"><span>空线路（不足 2 站）</span><b class="${empty.length ? 'warn' : ''}">${empty.length} 条</b></div>
        <div class="tp-row"><span>悬空车站</span><b class="${orphan.length ? 'warn' : ''}">${orphan.length} 个</b></div>`;
      box.appendChild(st);

      const mgr = window.G.LineMgr;
      const acts = util.el('div', 'tp-actions');
      const fix = util.el('button', 'mini', '⟳ 一键重算所有异常线路');
      fix.title = '空线路 / 路径不通的线路按当前路网重算一遍';
      fix.onclick = () => {
        if (mgr && typeof mgr.rebuildBroken === 'function') mgr.rebuildBroken(lines);
        else util.toast('线路管理器模块没加载', 'warn');
      };
      acts.appendChild(fix);
      box.appendChild(acts);

      if (broken.length) {
        box.appendChild(util.el('div', 'tp-note warn',
          `路径不通：${broken.map((l) => `${l.name}（${l.pathError}）`).join('；')}`));
      }
      if (empty.length) {
        box.appendChild(util.el('div', 'tp-note warn',
          `空线路：${empty.map((l) => l.name).join('、')} —— 在左侧点它，然后用「＋ 加站」补站。`));
      }
      if (orphan.length) {
        box.appendChild(util.el('div', 'tp-note',
          `悬空车站：${orphan.slice(0, 12).map((s) => s.name).join('、')}${orphan.length > 12 ? ` 等 ${orphan.length} 个` : ''}`
          + ' —— 这些站没吸附到轨道/道路，车不会停，建议在路网附近重建或用「移动」工具拖到路边。'));
      }
      if (!broken.length && !empty.length && !orphan.length) {
        box.appendChild(util.el('div', 'tp-note', '没有发现空线路、坏线路或悬空车站，路网很健康。'));
      }
    },
  };

  window.G.Transit = Transit;
})();
