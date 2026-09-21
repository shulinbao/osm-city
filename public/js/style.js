'use strict';
/**
 * OSM 风格渲染样式规则表（纯数据 + 纯函数，零第三方依赖，传统 script）
 * ============================================================================
 * 用途：多人在线 OSM 地图编辑器的矢量底图。前端把服务器下发的 node / way / relation
 *      （含完整 tags）交给本模块，本模块回答「这条要素该画成什么样」。
 * 形式：非 ES module，IIFE 挂到 window.G.Style，与 util.js / basemap.js 等保持一致。
 *
 * 公开接口（window.G.Style）
 * ----------------------------------------------------------------------------
 *   LAYER_ORDER          图层自下而上的绘制顺序（字符串数组）
 *   RULES                全部规则（只读遍历用；每条规则有唯一 id）
 *   COLORS               参考调色板（贴近 OSM Carto 的写实配色）
 *   CATEGORIES           图层面板用的分类表 [{id,name,defaultVisible}]
 *   areaKeys             出现这些 key 时闭合 way 视为「面」的标签 key
 *   ruleFor(tags, kind)  -> null | 样式对象
 *   labelFor(tags)       -> null | { text, priority }
 *   categoryOf(tags, kind) -> 分类 id
 *
 * ruleFor(tags, kind)
 * ----------------------------------------------------------------------------
 *   kind: 'point' | 'line' | 'area'（由前端按几何判断：闭合 way / relation 为 area）
 *   1) 先按几何筛选：kind='point' 只取 geo 含 'point' 的规则，'line'/'area' 同理。
 *   2) 命中的多条规则里，取 LAYER_ORDER 索引更大（图层更靠上）的那条；
 *      同一图层内按 RULES 的定义顺序，先定义者优先 —— 所以「兜底规则」一律写在最后。
 *   3) 返回的是规则浅拷贝（绝不污染 RULES），并叠加下列标签修饰：
 *        tunnel=*   半透明（opacity <= 0.55）且去掉描边 casing
 *        bridge=*   描边更深更粗（casing），便于和普通道路区分
 *        layer=*    透出 osmLayer（数值），前端可用于同图层内的叠放排序
 *        surface=*  轻微改变道路底色（路面色与材质色混合），并透出 surface
 *      （内部按标签 key 建索引加速，语义与「按 RULES 顺序全表扫描」逐条判定完全一致。
 *        RULES 及规则内的 casing / label / widthByZoom 均已冻结：顶层字段是拷贝，
 *        嵌套对象是只读共享，因此前端可以放心缓存 ruleFor 的结果。）
 *   4) 返回对象字段（全部可选，只有 layer 必有）：
 *        layer        'landuse' | ... | 'poi'
 *        kind         'line' | 'fill' | 'both'（该要素按线画 / 按面填 / 两者都要）
 *        fill, fillOpacity
 *        stroke, weight, dash, opacity
 *        casing       { color, weight }  道路描边（先描边后路面）
 *        minZoom, maxZoom                 可见缩放范围（Leaflet zoom 2~22）
 *        label        { size, color, halo, weight, minZoom }  有该字段即可画名字
 *        icon         emoji 图标（point 要素；没有就不画图标）
 *        symbol       'circle' | 'square' | 'triangle'（没有 icon 时的几何符号）
 *        extrude      true 表示建筑走 2.5D 挤出（前端用 building:levels / height 算高度）
 *        widthByZoom  线宽随缩放变化（见下）
 *        geo          该规则适用的几何类型（元信息，便于调试）
 *
 * 线宽随缩放（widthByZoom）
 * ----------------------------------------------------------------------------
 *   每条含 weight 的线状规则都带 widthByZoom：{ 13, 15, 17, 19 } -> 像素宽度，
 *   由基准 weight 乘缩放系数得到（z13 ×0.5、z15 ×0.72、z17 ×1、z19 ×1.5）。
 *   weight 本身是 z17 的参考宽度。渲染时：
 *     · zoom 命中键值 -> 直接取；
 *     · 落在两档之间 -> 线性插值；
 *     · 超出 13~19 -> 取最近端点值。
 *   （也可只用 weight，前端自行缩放；两种用法都不影响本模块的纯函数性质。）
 *
 * 标签文字（labelFor）
 * ----------------------------------------------------------------------------
 *   取值顺序：name > name:zh > ref（国道编号等）> addr:housenumber（仅建筑）。
 *   特例：natural=peak 返回「名字 (高程 m)」；place / water / 道路 / 建筑按类型给不同 priority。
 *   priority 1~10，10 最重要；前端在低缩放只画高优先级的名字。
 */
window.G = window.G || {};

(function () {
  /** 图层自下而上的绘制顺序：先画地面，再画线状设施，最后画点状兴趣点 */
  const LAYER_ORDER = [
    'landuse',    // 用地 / 绿地 / 自然面
    'water',      // 水面（含海岸线）
    'waterway',   // 河流等线状水系
    'railway',    // 铁路
    'road',       // 机动车道路
    'road-detail',// 步道、小径、自行车道等细节路
    'building',   // 建筑（桥梁、码头等结构面也在此层）
    'boundary',   // 行政 / 保护区边界
    'barrier',    // 围栏、围墙、管线、堤坝等线性人造物
    'power',      // 电力线
    'poi-area',   // 面状兴趣点（学校、医院、停车场……）
    'poi',        // 点状兴趣点（图标 / 符号 / 地名标注）
  ];
  const LAYER_INDEX = {};
  for (let i = 0; i < LAYER_ORDER.length; i++) LAYER_INDEX[LAYER_ORDER[i]] = i;

  /** 参考调色板（OSM Carto 写实风格；规格要求照抄的颜色都在这里） */
  const COLORS = {
    water: '#aad3df',            // 水面 / 水系
    forest: '#add19e',           // 森林
    grass: '#c8e6a0',            // 草地 / 公园
    farmland: '#eef0d5',         // 农田
    residential: '#e6e3e0',      // 住宅区
    commercial: '#f2dad9',       // 商业区
    industrial: '#ebdbe8',       // 工业区
    building: '#d9d0c9',         // 建筑填充
    buildingLine: '#c9c0b9',     // 建筑描边
    boundary: '#b8a0d8',         // 行政边界
    power: '#a0a0a0',            // 电力线
    roadMotorway: '#e892a2', roadMotorwayCase: '#dc2a67',
    roadTrunk: '#f9b29c', roadTrunkCase: '#c84e2f',
    roadPrimary: '#fcd6a4', roadPrimaryCase: '#a06b00',
    roadSecondary: '#f7fabf', roadSecondaryCase: '#707d05',
    roadTertiary: '#ffffff', roadTertiaryCase: '#8f8f8f',
    roadMinor: '#ffffff', roadMinorCase: '#bbbbbb',
    pathPink: '#c98f8f',         // 人行道 / 小径（虚线）
    pathBlue: '#7f9fd0',         // 自行车道（虚线）
    pathTrack: '#d6c39b',        // 田间小路（虚线）
    rail: '#8a8a8a', railSubway: '#7a7a7a', railTram: '#9a9a9a',
    text: '#333333', textHalo: '#ffffff', textStrong: '#222222',
    waterText: '#3d6e8f', greenText: '#4d7a33', buildingText: '#666666', boundaryText: '#6b52a3',
  };

  /** POI 面填充色（按行业分类，避免在几百行表格里手抄颜色） */
  const FILL = {
    food: '#f2dad9',      // 餐饮
    shop: '#f2dad9',      // 零售
    edu: '#f0f0e0',       // 教育
    health: '#f5e0e8',    // 医疗
    worship: '#e8e0f0',   // 宗教
    civic: '#e6ded2',     // 市政 / 公共服务
    office: '#e6e3e0',    // 办公
    transport: '#dfe3e5', // 交通设施
    sport: '#c8e6a0',     // 体育
    water: '#aad3df',     // 水
    green: '#cdebb0',     // 绿地
    grey: '#dcd9d4',      // 通用灰
    fuel: '#e8dfc0',      // 加油站
    security: '#dee6f2',  // 警务 / 消防
    culture: '#f0d8e8',   // 文化娱乐
    tourism: '#ebe4f6',   // 旅游
  };

  // ---------------------------------------------------------------------------
  // 规则容器与工厂
  // ---------------------------------------------------------------------------

  /** 全部规则（顺序即同图层内的优先级） */
  const RULES = [];

  /** 保留一位小数，避免 widthByZoom / casing 出现 4.050000000000001 之类的脏值 */
  function ROUND(n) { return Math.round(n * 10) / 10; }

  /** 颜色明暗调整：f<1 变暗，f>1 变亮 */
  function shade(hex, f) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const ch = (shift) => Math.max(0, Math.min(255, Math.round(((n >> shift) & 255) * f)));
    return '#' + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0');
  }

  /** 颜色线性混合：t=0 取 a，t=1 取 b */
  function mix(a, b, t) {
    const na = parseInt(String(a).replace('#', ''), 16);
    const nb = parseInt(String(b).replace('#', ''), 16);
    const ch = (shift) => {
      const va = (na >> shift) & 255;
      const vb = (nb >> shift) & 255;
      return Math.max(0, Math.min(255, Math.round(va + (vb - va) * t)));
    };
    return '#' + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0');
  }

  /** 由基准宽度生成随缩放变化的绝对宽度表（weight 为 z17 参考宽度） */
  function widthsFor(weight) {
    return {
      13: ROUND(weight * 0.5),
      15: ROUND(weight * 0.72),
      17: ROUND(weight),
      19: ROUND(weight * 1.5),
    };
  }

  /** 标签样式：minZoom 之后才画名字 */
  function L(minZoom, size, color, weight) {
    return {
      size: size || 12,
      color: color || COLORS.text,
      halo: COLORS.textHalo,
      weight: weight || 700,
      minZoom: minZoom,
    };
  }

  /** 规则唯一 id */
  function rid(layer, key, value) { return layer + ':' + key + '=' + value; }

  /** 把 'key=value' 条件转成 when 对象；'*' 表示「只要有这个 key 就命中」 */
  function makeWhen(key, value) {
    const when = {};
    when[key] = [String(value)];
    return when;
  }

  /** 登记一条规则（加载期自检，避免数据表手误把页面画崩） */
  function add(rule) {
    if (!rule || !rule.id) throw new Error('样式规则缺少 id');
    if (LAYER_INDEX[rule.layer] === undefined) {
      throw new Error('样式规则 ' + rule.id + ' 的 layer 不在 LAYER_ORDER 中：' + rule.layer);
    }
    if (!rule.when && !rule.where) throw new Error('样式规则 ' + rule.id + ' 缺少匹配条件');
    RULES.push(rule);
    return rule;
  }

  /**
   * 线状规则批量生成
   * 表格行：[标签值（| 分隔同款）, 线色, 宽度, 最小缩放, 标签最小缩放(null=不画名字), 额外样式]
   */
  function lineGroup(layer, key, table, base) {
    for (const row of table) {
      const value = row[0], stroke = row[1], weight = row[2], minZoom = row[3];
      const labelZoom = row[4], extra = row[5] || null;
      for (const v of String(value).split('|')) {
        const rule = {
          id: rid(layer, key, v), layer: layer, geo: ['line', 'area'], kind: 'line',
          when: makeWhen(key, v), stroke: stroke,
          weight: weight, widthByZoom: widthsFor(weight),
          minZoom: minZoom, maxZoom: 22,
        };
        if (labelZoom) rule.label = L(labelZoom);
        add(Object.assign(rule, base || null, extra));
      }
    }
  }

  /**
   * 面状规则批量生成
   * 表格行：[标签值（| 分隔同款）, 填充色, 填充透明度, 最小缩放, 标签最小缩放(null=不画名字), 额外样式]
   */
  function areaGroup(layer, key, table, base) {
    for (const row of table) {
      const value = row[0], fill = row[1], fillOpacity = row[2];
      const minZoom = row[3], labelZoom = row[4], extra = row[5] || null;
      for (const v of String(value).split('|')) {
        const rule = {
          id: rid(layer, key, v), layer: layer, geo: ['line', 'area'], kind: 'fill',
          when: makeWhen(key, v), fill: fill,
          fillOpacity: fillOpacity == null ? 0.85 : fillOpacity,
          minZoom: minZoom, maxZoom: 22,
        };
        if (labelZoom) rule.label = L(labelZoom);
        add(Object.assign(rule, base || null, extra));
      }
    }
  }

  /**
   * 点状规则批量生成（图标 / 几何符号）
   * 表格行：[标签值（| 分隔同款）, emoji 图标或 null, 最小缩放, 额外样式（symbol、label 等）]
   */
  function pointGroup(layer, key, table, base) {
    for (const row of table) {
      const value = row[0], icon = row[1], minZoom = row[2], extra = row[3] || null;
      for (const v of String(value).split('|')) {
        const rule = {
          id: rid(layer, key, v), layer: layer, geo: ['point'], kind: 'fill',
          when: makeWhen(key, v), minZoom: minZoom, maxZoom: 22,
        };
        if (icon) rule.icon = icon;
        add(Object.assign(rule, base || null, extra));
      }
    }
  }

  /**
   * POI 规则批量生成：一行同时产出「面」规则（poi-area 层）与「点」规则（poi 层）
   * 表格行：[标签键, 标签值, emoji 图标, 面填充色（null=不做面规则）, 面最小缩放, 点最小缩放, 额外样式]
   */
  function poiGroup(table) {
    for (const row of table) {
      const key = row[0], value = row[1], icon = row[2], fill = row[3];
      const areaZoom = row[4], pointZoom = row[5], extra = row[6] || null;
      if (fill) {
        add({
          id: rid('poi-area', key, value), layer: 'poi-area', geo: ['line', 'area'], kind: 'fill',
          when: makeWhen(key, value), fill: fill, fillOpacity: 0.6,
          minZoom: areaZoom, maxZoom: 22,
          label: L(Math.min(18, areaZoom + 3), 11),
        });
      }
      const point = Object.assign({
        id: rid('poi', key, value), layer: 'poi', geo: ['point'], kind: 'fill',
        when: makeWhen(key, value), minZoom: pointZoom, maxZoom: 22,
        label: L(Math.min(18, pointZoom + 1), 11),
      }, extra);
      if (icon && !point.icon) point.icon = icon;
      add(point);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. 道路（highway=*）
  // ---------------------------------------------------------------------------

  // 闭合道路（area=yes：广场 / 行人区 / 服务区）按面填充。
  // 同一图层内先定义者优先，所以这几条必须写在道路表之前。
  // 行格式：[highway 值, 填充色, 描边色, 图层（步道类归 road-detail）]
  const AREA_ROADS = [
    ['pedestrian', '#e3e0d8', '#b8b4ab', 'road'],
    ['footway', '#e0d5d5', '#c98f8f', 'road-detail'],
    ['path', '#e0d5d5', '#c98f8f', 'road-detail'],
    ['service', COLORS.roadMinor, COLORS.roadMinorCase, 'road'],
    ['residential', COLORS.roadMinor, COLORS.roadMinorCase, 'road'],
    ['unclassified', COLORS.roadMinor, COLORS.roadMinorCase, 'road'],
    ['living_street', '#ededed', COLORS.roadMinorCase, 'road'],
    ['track', COLORS.pathTrack, '#c0ab86', 'road'],
    ['tertiary', COLORS.roadTertiary, COLORS.roadTertiaryCase, 'road'],
    ['secondary', COLORS.roadSecondary, COLORS.roadSecondaryCase, 'road'],
    ['primary', COLORS.roadPrimary, COLORS.roadPrimaryCase, 'road'],
  ];
  for (const row of AREA_ROADS) {
    add({
      id: rid(row[3], 'highway', row[0] + '@area'), layer: row[3], geo: ['area'], kind: 'both',
      when: { highway: [row[0]] },
      where: (t) => t.area === 'yes' || t.area === '1' || t.area === true,
      fill: row[1], fillOpacity: 0.9, stroke: row[2], weight: 1.5,
      casing: { color: row[2], weight: 2.5 },
      minZoom: 13, maxZoom: 22,
    });
  }

  // 机动车道路与步道：[highway 值（| 同款）, 路面色, 描边色（null=无描边）, 宽度, 最小缩放, 标签最小缩放, 额外]
  // 额外里的 layer 可把规则改挂到 road-detail 图层（步道、小径、自行车道等细节路）
  const ROAD_TABLE = [
    ['motorway', COLORS.roadMotorway, COLORS.roadMotorwayCase, 6, 5, 10, { label: L(10, 13) }],
    ['motorway_link', COLORS.roadMotorway, COLORS.roadMotorwayCase, 4.5, 8, 13],
    ['trunk', COLORS.roadTrunk, COLORS.roadTrunkCase, 5, 6, 11, { label: L(11, 12) }],
    ['trunk_link', COLORS.roadTrunk, COLORS.roadTrunkCase, 4, 9, 13],
    ['primary', COLORS.roadPrimary, COLORS.roadPrimaryCase, 5, 7, 11, { label: L(11, 12) }],
    ['primary_link', COLORS.roadPrimary, COLORS.roadPrimaryCase, 4, 9, 13],
    ['secondary', COLORS.roadSecondary, COLORS.roadSecondaryCase, 4.5, 8, 12, { label: L(12, 11) }],
    ['secondary_link', COLORS.roadSecondary, COLORS.roadSecondaryCase, 3.5, 10, 14],
    ['tertiary', COLORS.roadTertiary, COLORS.roadTertiaryCase, 4, 9, 13, { label: L(13, 11) }],
    ['tertiary_link', COLORS.roadTertiary, COLORS.roadTertiaryCase, 3.2, 11, 14],
    ['unclassified|residential', COLORS.roadMinor, COLORS.roadMinorCase, 3.5, 12, 15, { label: L(15, 11) }],
    ['living_street', '#ededed', COLORS.roadMinorCase, 3, 13, 16, { label: L(16, 10) }],
    ['pedestrian', '#e3e0d8', '#b8b4ab', 3, 13, 16, { label: L(16, 10) }],
    ['service', COLORS.roadMinor, COLORS.roadMinorCase, 2.5, 14, 17, { label: L(17, 10) }],
    ['track', COLORS.pathTrack, '#c0ab86', 2, 13, 16, { dash: [3, 3], label: L(16, 10) }],
    ['road', COLORS.roadMinor, COLORS.roadMinorCase, 3, 13, 16, { label: L(16, 10) }],
    ['footway|path', COLORS.pathPink, null, 2, 16, 17, { layer: 'road-detail', dash: [4, 4], label: L(17, 10) }],
    ['steps', COLORS.pathPink, null, 3, 16, 17, { layer: 'road-detail', dash: [2, 3], label: L(17, 10) }],
    ['cycleway', COLORS.pathBlue, null, 2, 15, 17, { layer: 'road-detail', dash: [4, 4], label: L(17, 10) }],
    ['bridleway', COLORS.pathPink, null, 2, 15, 17, { layer: 'road-detail', dash: [6, 3], label: L(17, 10) }],
    ['corridor', COLORS.pathPink, null, 2, 18, 18, { layer: 'road-detail', dash: [1, 3], label: L(18, 10) }],
    ['construction', '#e0d6c0', '#b5ab96', 3, 13, null, { dash: [4, 4] }],
    ['proposed', '#e8e8e8', '#c0c0c0', 2, 14, null, { dash: [2, 6] }],
    ['bus_guideway', '#d0d0d0', '#a8a8a8', 3, 13, null],
    ['raceway', '#e8d0c0', '#bfae94', 3, 13, null],
  ];
  for (const row of ROAD_TABLE) {
    const values = row[0], stroke = row[1], casingColor = row[2], weight = row[3];
    const minZoom = row[4], labelZoom = row[5], extra = row[6] || {};
    const ruleLayer = extra.layer || 'road';
    for (const v of values.split('|')) {
      const rule = {
        id: rid(ruleLayer, 'highway', v), layer: ruleLayer, geo: ['line', 'area'], kind: 'line',
        when: makeWhen('highway', v), stroke: stroke,
        weight: weight, widthByZoom: widthsFor(weight),
        minZoom: minZoom, maxZoom: 22,
      };
      if (casingColor) rule.casing = { color: casingColor, weight: ROUND(weight + 1) };
      if (labelZoom) rule.label = L(labelZoom, weight >= 5 ? 12 : 11);
      add(Object.assign(rule, extra));
    }
  }

  // 道路上的点要素（节点）
  pointGroup('poi', 'highway', [
    ['bus_stop', '🚌', 17, { label: L(18, 10) }],
    ['platform', null, 17, { symbol: 'square' }],
    ['crossing', null, 18, { symbol: 'square' }],
    ['traffic_signals', null, 17, { symbol: 'circle' }],
    ['give_way', null, 18, { symbol: 'triangle' }],
    ['stop', null, 18, { symbol: 'square' }],
    ['mini_roundabout', null, 17, { symbol: 'circle' }],
    ['turning_circle', null, 18, { symbol: 'circle' }],
    ['passing_place', null, 18, { symbol: 'circle' }],
    ['speed_camera', '📷', 18],
    ['milestone', '🪧', 17, { label: L(18, 10) }],
    ['emergency_access_point', '🆘', 18],
    ['elevator', '🛗', 18],
    ['street_lamp', null, 19, { symbol: 'circle' }],
  ]);

  // ---------------------------------------------------------------------------
  // 2. 铁路（railway=*）
  // ---------------------------------------------------------------------------
  lineGroup('railway', 'railway', [
    ['rail', COLORS.rail, 3, 7, null, { dash: [8, 6] }],
    ['light_rail', '#8f8f8f', 2.5, 10, null, { dash: [8, 6] }],
    ['subway', COLORS.railSubway, 3, 9, null, { dash: [8, 6] }],
    ['tram', COLORS.railTram, 2.5, 12, null, { dash: [4, 4] }],
    ['narrow_gauge', '#8a8a8a', 2, 12, null, { dash: [4, 4] }],
    ['monorail', '#9a9a9a', 2.5, 12, null, { dash: [10, 6] }],
    ['funicular', '#8a8a8a', 2, 13, null, { dash: [2, 2] }],
    ['preserved', '#8a8a8a', 2.5, 13, null, { dash: [6, 4] }],
    ['disused', '#b0b0b0', 2, 14, null, { dash: [4, 4] }],
    ['abandoned', '#c0c0c0', 2, 15, null, { dash: [2, 6] }],
    ['razed', '#c8c8c8', 1.5, 15, null, { dash: [2, 6] }],
    ['construction', '#d0d0d0', 2, 14, null, { dash: [4, 4] }],
    ['yard', '#b0b0b0', 1.5, 15, null, { dash: [4, 4] }],
    ['crossover', '#8a8a8a', 2, 15, null, { dash: [4, 4] }],
    ['spur', '#b0b0b0', 1.5, 14, null, { dash: [6, 6] }],
  ]);
  // 站台（面）
  areaGroup('railway', 'railway', [
    ['platform', COLORS.building, 0.85, 14, 17, { stroke: COLORS.buildingLine, weight: 1, kind: 'both' }],
  ]);
  // 车站（面，便于画站房范围）
  areaGroup('poi-area', 'railway', [
    ['station', FILL.transport, 0.6, 12, 16],
    ['halt', FILL.transport, 0.6, 14, 17],
  ]);
  // 铁路点要素
  pointGroup('poi', 'railway', [
    ['station', '🚉', 15, { label: L(15, 12) }],
    ['halt', '🚏', 16, { label: L(16, 11) }],
    ['tram_stop', '🚊', 17, { label: L(17, 10) }],
    ['subway_entrance', '🚇', 17, { label: L(18, 10) }],
    ['level_crossing', null, 17, { symbol: 'square' }],
    ['crossing', null, 18, { symbol: 'square' }],
    ['signal', null, 18, { symbol: 'circle' }],
    ['buffer_stop', null, 18, { symbol: 'square' }],
    ['turntable', null, 15, { symbol: 'circle' }],
    ['roundhouse', null, 15, { symbol: 'circle' }],
    ['switch', null, 18, { symbol: 'circle' }],
  ]);

  // ---------------------------------------------------------------------------
  // 3. 水系（waterway=* 与面状水域）
  // ---------------------------------------------------------------------------
  lineGroup('waterway', 'waterway', [
    ['river', COLORS.water, 3, 6, 13, { label: L(13, 11, COLORS.waterText) }],
    ['canal', COLORS.water, 2.5, 8, 14, { label: L(14, 11, COLORS.waterText) }],
    ['stream', COLORS.water, 1.5, 12, 16, { label: L(16, 10, COLORS.waterText) }],
    ['ditch', COLORS.water, 1, 14, null, { dash: [4, 4] }],
    ['drain', COLORS.water, 1, 15, null, { dash: [2, 2] }],
    ['dam', '#b0b0b0', 3, 13, null],
    ['weir', '#a8a8a8', 2, 14, null, { dash: [6, 2] }],
    ['waterfall', COLORS.water, 1.5, 14, null, { dash: [2, 2] }],
    ['rapids', COLORS.water, 1.5, 14, null, { dash: [2, 2] }],
    ['lock_gate', '#a8a8a8', 2, 15, null],
    ['canoe_pass', COLORS.water, 1.5, 15, null, { dash: [2, 2] }],
    ['fish_pass', COLORS.water, 1.5, 15, null, { dash: [2, 2] }],
  ]);
  // 面状水域（河岸、船坞、内湖）。放在 waterway 图层并置于兜底规则之前，
  // 否则同键的兜底线规则会在「面」几何上盖掉河岸填充。
  areaGroup('waterway', 'waterway', [
    ['riverbank', COLORS.water, 0.9, 8, 14],
    ['dock', COLORS.water, 0.9, 12, 15],
    ['boatyard', COLORS.water, 0.9, 13, null],
  ]);
  // 渡轮航线（route=ferry 关系）
  lineGroup('waterway', 'route', [
    ['ferry', '#8aa9bd', 2, 10, null, { dash: [6, 6] }],
    ['hiking', '#b08a5a', 2, 13, null, { dash: [3, 4] }],
    ['bicycle', '#7f9fd0', 2, 13, null, { dash: [3, 4] }],
  ]);

  // ---------------------------------------------------------------------------
  // 4. 自然（natural=*）
  // ---------------------------------------------------------------------------
  // 水面 / 海湾（water 图层）
  areaGroup('water', 'natural', [
    ['water', COLORS.water, 0.9, 5, 13],
    ['bay', COLORS.water, 0.9, 5, 12],
    ['strait', COLORS.water, 0.9, 6, 12],
  ]);
  lineGroup('water', 'natural', [
    ['coastline', '#5c9bbd', 1.5, 4, null],
  ]);
  // 陆地自然面（landuse 图层）
  areaGroup('landuse', 'natural', [
    ['wood', COLORS.forest, 0.9, 7, 13],
    ['scrub', '#c8d7ab', 0.8, 12, 16],
    ['heath', '#d4d7b6', 0.8, 12, 16],
    ['grassland', '#cdebb0', 0.8, 10, 15],
    ['grass', '#cdebb0', 0.8, 12, 16],
    ['wetland', '#cfe6d0', 0.8, 11, 15],
    ['sand', '#f5e9c6', 0.9, 11, 15],
    ['beach', '#fff1ba', 0.9, 11, 15],
    ['bare_rock', '#ded8cc', 0.9, 12, 15],
    ['scree', '#e2ded4', 0.9, 12, null],
    ['glacier', '#d8ecf7', 0.9, 8, 14],
    ['shingle', '#e8e2d2', 0.9, 12, null],
    ['fell', '#d4d7b6', 0.8, 12, null],
    ['mud', '#c9bda0', 0.9, 13, null],
    ['dune', '#f0e4bf', 0.9, 13, null],
    ['valley', '#dfe6cf', 0.7, 12, null],
    ['earth_bank', '#d8ccb4', 0.9, 13, null],
  ]);
  // 自然线状要素
  lineGroup('landuse', 'natural', [
    ['tree_row', '#9ec98a', 3, 14, null, { dash: [2, 4] }],
    ['ridge', '#c8bfa8', 1.5, 13, null, { dash: [4, 4] }],
    ['arete', '#c8bfa8', 1.5, 13, null, { dash: [4, 4] }],
  ]);
  // 自然界的线性要素（崖、土坎）：只按线画，避免盖掉同名的面规则
  lineGroup('barrier', 'natural', [
    ['cliff', '#8f8a80', 1.5, 13, null],
    ['earth_bank', '#b0a488', 1.5, 14, null],
  ], { geo: ['line'] });
  // 自然点要素
  pointGroup('poi', 'natural', [
    ['peak', '⛰️', 11, { label: L(11, 11) }],
    ['volcano', '🌋', 10, { label: L(10, 11) }],
    ['hill', '⛰️', 13, { label: L(13, 10) }],
    ['saddle', null, 14, { symbol: 'triangle', label: L(15, 10) }],
    ['geyser', '♨️', 15, { label: L(16, 10) }],
    ['spring', '💧', 16, { label: L(17, 10, COLORS.waterText) }],
    ['tree', '🌳', 17],
    ['cave_entrance', '🕳️', 17, { label: L(18, 10) }],
    ['sinkhole', '🕳️', 17],
    ['stone', null, 18, { symbol: 'circle' }],
    ['rock', null, 18, { symbol: 'circle' }],
    ['shingle', null, 18, { symbol: 'circle' }],
    ['wetland', null, 18, { symbol: 'circle' }],
  ]);

  // ---------------------------------------------------------------------------
  // 5. 用地（landuse=*）
  // ---------------------------------------------------------------------------
  areaGroup('landuse', 'landuse', [
    ['residential', COLORS.residential, 0.85, 10, 13],
    ['commercial', COLORS.commercial, 0.85, 10, 13],
    ['retail', COLORS.commercial, 0.85, 11, 14],
    ['industrial', COLORS.industrial, 0.85, 10, 13],
    ['construction', '#dfdfdf', 0.85, 12, null],
    ['farmland', COLORS.farmland, 0.9, 10, 15],
    ['farmyard', COLORS.residential, 0.85, 12, 15],
    ['forest', COLORS.forest, 0.9, 8, 13],
    ['meadow', '#cdebb0', 0.85, 11, 15],
    ['grass', COLORS.grass, 0.85, 11, 15],
    ['orchard', '#aedfa3', 0.85, 12, 16],
    ['vineyard', '#b0dfa0', 0.85, 12, 16],
    ['cemetery', '#aacbaf', 0.85, 12, 15],
    ['quarry', '#c5c2bc', 0.9, 12, 15],
    ['allotments', '#c9e7a7', 0.85, 12, 16],
    ['railway', COLORS.residential, 0.85, 12, null],
    ['military', '#f0e0e0', 0.85, 11, null],
    ['landfill', '#c9c2b8', 0.9, 12, null],
    ['greenfield', '#dfdfdf', 0.8, 13, null],
    ['brownfield', '#c9c2b8', 0.85, 13, null],
    ['village_green', COLORS.grass, 0.85, 12, 15],
    ['religious', '#eae0f0', 0.85, 13, null],
    ['education', '#f0f0e0', 0.85, 12, null],
    ['recreation_ground', COLORS.grass, 0.85, 12, 15],
    ['flowerbed', '#cdebb0', 0.8, 14, null],
    ['greenhouse_horticulture', '#dff0d8', 0.85, 13, null],
    ['plant_nursery', '#c9e7a7', 0.85, 13, null],
    ['winter_sports', '#e8f0f8', 0.85, 12, null],
    ['basin', COLORS.water, 0.9, 8, 14],
    ['salt_pond', COLORS.water, 0.9, 10, null],
    ['reservoir', COLORS.water, 0.9, 8, 14],
  ]);

  // ---------------------------------------------------------------------------
  // 6. 休闲与运动（leisure=* / sport=*）
  // ---------------------------------------------------------------------------
  // sport 细分决定球场配色（必须先于通用 leisure=pitch 定义）
  const SPORT_PITCH = [
    ['soccer', '#b5e0a8'], ['football', '#b5e0a8'], ['athletics', '#d9a08f'],
    ['baseball', '#c8d7ab'], ['golf', '#cdebb0'], ['basketball', '#e8b47a'],
    ['tennis', '#d9c9a3'], ['volleyball', '#e0c9a0'], ['badminton', '#d9c9a3'],
    ['table_tennis', '#d9c9a3'], ['swimming', COLORS.water], ['multi', COLORS.grass],
    ['equestrian', '#c8b89b'], ['skateboard', '#d0cfc8'], ['climbing', '#ded8cc'],
    ['shooting', '#d8d0c0'], ['archery', '#cdebb0'], ['cycling', '#d8d8d0'],
    ['rugby', '#b5e0a8'], ['handball', '#e8b47a'], ['hockey', '#b5e0a8'],
  ];
  for (const row of SPORT_PITCH) {
    add({
      id: 'landuse:sport=' + row[0], layer: 'landuse', geo: ['line', 'area'], kind: 'both',
      when: { sport: [row[0]] },
      where: (t) => t.leisure === 'pitch' || t.leisure === 'track' || t.leisure === 'sports_centre',
      fill: row[1], fillOpacity: 0.85, stroke: shade(row[1], 0.85), weight: 1,
      minZoom: 13, maxZoom: 22, label: L(16, 10),
    });
  }
  areaGroup('landuse', 'leisure', [
    ['park', COLORS.grass, 0.85, 8, 12],
    ['garden', '#cdebb0', 0.85, 11, 15],
    ['playground', '#f7e7c6', 0.85, 13, 16],
    ['pitch', '#aae0cb', 0.85, 13, 16],
    ['golf_course', '#a8dfa8', 0.8, 9, 14],
    ['sports_centre', COLORS.residential, 0.85, 12, 15],
    ['stadium', COLORS.residential, 0.85, 11, 14],
    ['nature_reserve', COLORS.grass, 0.6, 9, 13],
    ['common', '#cdebb0', 0.8, 11, 15],
    ['dog_park', '#cdebb0', 0.8, 13, 16],
    ['track', '#c8e6a0', 0.8, 12, 16],
    ['recreation_ground', COLORS.grass, 0.85, 12, 15],
    ['fitness_centre', COLORS.residential, 0.85, 14, 16],
    ['ice_rink', '#dff0ff', 0.85, 13, 16],
    ['bowling_green', '#c8e6a0', 0.85, 14, 16],
    ['miniature_golf', '#c8e6a0', 0.85, 14, 16],
    ['outdoor_seating', '#f0e6d8', 0.8, 16, 17],
    ['bleachers', '#d8d4cc', 0.85, 15, 17],
    ['slipway', '#d8d4cc', 0.8, 15, null],
  ]);
  // 水相关的 leisure 面放在 water 图层，压住陆地底色
  areaGroup('water', 'leisure', [
    ['swimming_pool', COLORS.water, 0.9, 14, null],
    ['marina', COLORS.water, 0.9, 11, 14],
    ['water_park', COLORS.water, 0.9, 12, 15],
  ]);
  pointGroup('poi', 'leisure', [
    ['picnic_table', '🧺', 18],
    ['firepit', '🔥', 18],
    ['fitness_station', '🏋️', 18],
    ['swimming_pool', '🏊', 18],
    ['slipway', null, 17, { symbol: 'triangle' }],
    ['playground', '🛝', 17, { label: L(18, 10) }],
    ['sports_centre', '🏟️', 17, { label: L(18, 10) }],
  ]);

  // ---------------------------------------------------------------------------
  // 7. 建筑（building=* / building:part=*）
  // ---------------------------------------------------------------------------
  // 在建建筑：虚线描边
  add({
    id: 'building:building=construction', layer: 'building', geo: ['line', 'area'], kind: 'both',
    when: { building: ['construction'] },
    fill: COLORS.building, fillOpacity: 0.6,
    stroke: COLORS.buildingLine, weight: 1, dash: [4, 4],
    extrude: true, minZoom: 13, maxZoom: 22, label: L(18, 10, COLORS.buildingText),
  });
  // 3D 分块（building:part 常与 building 同时出现，先定义者优先）
  add({
    id: 'building:building:part=*', layer: 'building', geo: ['line', 'area'], kind: 'both',
    when: { 'building:part': ['*'] },
    fill: COLORS.building, fillOpacity: 0.9,
    stroke: COLORS.buildingLine, weight: 1,
    extrude: true, minZoom: 14, maxZoom: 22,
  });
  // 任意 building=*（默认米色填充，2.5D 挤出用 building:levels / height）
  add({
    id: 'building:building=*', layer: 'building', geo: ['line', 'area'], kind: 'both',
    when: { building: ['*'] },
    fill: COLORS.building, fillOpacity: 0.9,
    stroke: COLORS.buildingLine, weight: 1,
    extrude: true, minZoom: 13, maxZoom: 22, label: L(18, 10, COLORS.buildingText),
  });
  // 建筑上的附属结构（屋顶）不再单独建规则：同图层内 building=* 已先定义并优先命中。

  // ---------------------------------------------------------------------------
  // 8. 交通设施（aeroway / public_transport / place）
  // ---------------------------------------------------------------------------
  lineGroup('road', 'aeroway', [
    ['runway', '#cfcac4', 8, 9, null, { casing: { color: '#b5afa8', weight: 9 } }],
    ['taxiway', '#cfcac4', 4, 10, null, { casing: { color: '#b5afa8', weight: 5 } }],
    ['taxilane', '#d6d2cc', 2.5, 12, null],
    ['stopway', '#d6d2cc', 3, 13, null],
  ]);
  areaGroup('landuse', 'aeroway', [
    ['apron', '#dcd8d2', 0.9, 10, null],
    ['helipad', '#e0dcd6', 0.9, 12, 16],
    ['aerodrome', '#e6e6e6', 0.6, 8, 12],
    ['parking_position', '#d6d2cc', 0.8, 16, null],
  ]);
  areaGroup('building', 'aeroway', [
    ['terminal', COLORS.building, 0.9, 11, 16, { stroke: COLORS.buildingLine, weight: 1, kind: 'both', extrude: true }],
    ['hangar', COLORS.building, 0.9, 12, 16, { stroke: COLORS.buildingLine, weight: 1, kind: 'both', extrude: true }],
  ]);
  pointGroup('poi', 'aeroway', [
    ['gate', '🚪', 17, { label: L(18, 10) }],
    ['helipad', '🚁', 17],
    ['aerodrome', '🛩️', 15, { label: L(15, 12) }],
    ['windsock', null, 16, { symbol: 'circle' }],
    ['jet_bridge', null, 17, { symbol: 'square' }],
  ]);
  // 公共交通
  areaGroup('railway', 'public_transport', [
    ['platform', COLORS.building, 0.85, 14, 17, { stroke: COLORS.buildingLine, weight: 1, kind: 'both' }],
  ]);
  pointGroup('poi', 'public_transport', [
    ['station', '🚉', 15, { label: L(15, 12) }],
    ['stop_position', null, 17, { symbol: 'circle', label: L(17, 10) }],
    ['platform', null, 17, { symbol: 'square', label: L(18, 10) }],
  ]);
  // 地名（只画名字，不画大图标）
  pointGroup('poi', 'place', [
    ['city', null, 8, { symbol: 'circle', label: L(8, 15, COLORS.textStrong) }],
    ['town', null, 10, { symbol: 'circle', label: L(10, 13, COLORS.textStrong) }],
    ['borough', null, 11, { symbol: 'circle', label: L(11, 12) }],
    ['village', null, 12, { symbol: 'circle', label: L(12, 12) }],
    ['suburb', null, 12, { symbol: 'circle', label: L(12, 12) }],
    ['quarter', null, 12, { symbol: 'circle', label: L(12, 12) }],
    ['neighbourhood', null, 13, { symbol: 'circle', label: L(13, 11) }],
    ['hamlet', null, 13, { symbol: 'circle', label: L(13, 11) }],
    ['isolated_dwelling', null, 14, { symbol: 'circle', label: L(14, 10) }],
    ['locality', null, 14, { symbol: 'circle', label: L(14, 10) }],
    ['farm', null, 14, { symbol: 'circle', label: L(14, 10) }],
    ['square', null, 15, { symbol: 'square', label: L(15, 10) }],
    ['island', null, 10, { symbol: 'circle', label: L(10, 11, COLORS.waterText) }],
    ['islet', null, 13, { symbol: 'circle', label: L(13, 10, COLORS.waterText) }],
  ]);
  // 岛屿等也可能画成面
  areaGroup('poi-area', 'place', [
    ['island', '#e8e6d8', 0.4, 8, 12],
    ['islet', '#e8e6d8', 0.4, 12, 14],
    ['square', '#e6e3e0', 0.5, 14, 16],
  ]);

  // ---------------------------------------------------------------------------
  // 9. 兴趣点（amenity / shop / tourism / office / craft / historic / healthcare / emergency）
  // ---------------------------------------------------------------------------
  poiGroup([
    // 行格式：[标签键, 标签值, 图标, 面填充色, 面最小缩放, 点最小缩放]
    // ---- amenity：餐饮 ----
    ['amenity', 'restaurant', '🍜', FILL.food, 12, 17],
    ['amenity', 'cafe', '☕', FILL.food, 13, 17],
    ['amenity', 'fast_food', '🍔', FILL.food, 13, 17],
    ['amenity', 'bar', '🍺', FILL.food, 13, 17],
    ['amenity', 'pub', '🍺', FILL.food, 13, 17],
    ['amenity', 'biergarten', '🍺', FILL.food, 14, 17],
    ['amenity', 'food_court', '🍽️', FILL.food, 14, 17],
    ['amenity', 'ice_cream', '🍦', null, 0, 18],
    // ---- amenity：金融 ----
    ['amenity', 'bank', '🏦', FILL.civic, 12, 17],
    ['amenity', 'atm', '🏧', null, 0, 18],
    ['amenity', 'bureau_de_change', '💱', FILL.civic, 13, 18],
    // ---- amenity：医疗 ----
    ['amenity', 'pharmacy', '💊', FILL.health, 12, 17],
    ['amenity', 'hospital', '🏥', FILL.health, 11, 17],
    ['amenity', 'clinic', '🩺', FILL.health, 13, 17],
    ['amenity', 'doctors', '🩺', FILL.health, 13, 17],
    ['amenity', 'dentist', '🦷', null, 0, 17],
    ['amenity', 'veterinary', '🐾', null, 0, 18],
    ['amenity', 'nursing_home', '🏥', FILL.health, 13, 17],
    // ---- amenity：教育 ----
    ['amenity', 'school', '🏫', FILL.edu, 11, 17],
    ['amenity', 'university', '🎓', FILL.edu, 11, 17],
    ['amenity', 'college', '🏛️', FILL.edu, 12, 17],
    ['amenity', 'kindergarten', '🧸', FILL.edu, 13, 17],
    ['amenity', 'childcare', '🧸', FILL.edu, 14, 18],
    ['amenity', 'library', '📚', FILL.civic, 12, 17],
    // ---- amenity：文化娱乐 ----
    ['amenity', 'cinema', '🎬', FILL.culture, 13, 17],
    ['amenity', 'theatre', '🎭', FILL.culture, 13, 17],
    ['amenity', 'arts_centre', '🎨', FILL.culture, 14, 17],
    ['amenity', 'nightclub', '🎉', FILL.culture, 14, 18],
    ['amenity', 'internet_cafe', '💻', FILL.culture, 14, 18],
    ['amenity', 'studio', '🎬', FILL.culture, 14, 18],
    ['amenity', 'gambling', '🎰', FILL.culture, 14, 18],
    // ---- amenity：公共设施 ----
    ['amenity', 'marketplace', '🛒', FILL.shop, 12, 17],
    ['amenity', 'townhall', '🏛️', FILL.civic, 11, 17],
    ['amenity', 'community_centre', '🏘️', FILL.civic, 13, 17],
    ['amenity', 'courthouse', '⚖️', FILL.civic, 13, 18],
    ['amenity', 'embassy', '🏛️', FILL.civic, 13, 18],
    ['amenity', 'post_office', '📮', FILL.civic, 13, 17],
    ['amenity', 'social_facility', '🤝', FILL.civic, 13, 18],
    ['amenity', 'prison', '🏢', FILL.security, 12, 18],
    ['amenity', 'grave_yard', '⚰️', FILL.green, 12, 18],
    ['amenity', 'place_of_worship', '⛪', FILL.worship, 12, 17],
    ['amenity', 'toilets', '🚻', FILL.grey, 15, 17],
    ['amenity', 'public_bath', '🛁', FILL.water, 14, 18],
    ['amenity', 'shower', '🚿', FILL.water, 15, 18],
    ['amenity', 'fountain', '⛲', FILL.water, 14, 17],
    // ---- amenity：安全 ----
    ['amenity', 'police', '🚓', FILL.security, 12, 17],
    ['amenity', 'fire_station', '🚒', FILL.security, 12, 17],
    // ---- amenity：交通 ----
    ['amenity', 'fuel', '⛽', FILL.fuel, 12, 17],
    ['amenity', 'charging_station', '🔌', FILL.transport, 14, 18],
    ['amenity', 'bus_station', '🚌', FILL.transport, 12, 17],
    ['amenity', 'taxi', '🚕', FILL.transport, 14, 17],
    ['amenity', 'ferry_terminal', '⛴️', FILL.transport, 12, 17],
    ['amenity', 'parking', '🅿️', FILL.grey, 13, 17],
    ['amenity', 'parking_entrance', '🅿️', null, 0, 18],
    ['amenity', 'bicycle_parking', '🚲', FILL.transport, 15, 18],
    ['amenity', 'bicycle_rental', '🚲', FILL.transport, 14, 18],
    ['amenity', 'motorcycle_parking', '🏍️', FILL.transport, 15, 18],
    // ---- amenity：生活服务 ----
    ['amenity', 'drinking_water', '🚰', null, 0, 17],
    ['amenity', 'watering_place', '💧', null, 0, 18],
    ['amenity', 'bench', '🪑', null, 0, 18],
    ['amenity', 'waste_basket', '🗑️', null, 0, 18],
    ['amenity', 'waste_disposal', '🗑️', null, 0, 18],
    ['amenity', 'recycling', '♻️', FILL.grey, 15, 18],
    ['amenity', 'shelter', '⛺', FILL.grey, 15, 18],
    ['amenity', 'bbq', '🔥', null, 0, 18],
    ['amenity', 'telephone', '☎️', null, 0, 19],
    ['amenity', 'clock', '🕒', null, 0, 19],
    ['amenity', 'vending_machine', '🥤', null, 0, 19],
    ['amenity', 'parcel_locker', '📦', null, 0, 18],
    ['amenity', 'animal_shelter', '🐾', null, 0, 18],
    ['amenity', 'animal_boarding', '🐾', null, 0, 18],
    ['amenity', 'swimming_pool', '🏊', FILL.water, 13, 18],
    ['amenity', 'training', '🎓', FILL.edu, 14, 18],
    ['amenity', 'dive_centre', '🤿', null, 0, 18],
    ['amenity', 'luggage_locker', '🧳', null, 0, 18],
    ['amenity', 'smoking_area', '🚬', null, 0, 18],
    ['amenity', 'photo_booth', '📸', null, 0, 19],

    // ---- tourism ----
    ['tourism', 'attraction', '🎡', FILL.tourism, 12, 17],
    ['tourism', 'museum', '🏛️', FILL.tourism, 12, 17],
    ['tourism', 'gallery', '🖼️', FILL.tourism, 13, 17],
    ['tourism', 'hotel', '🏨', FILL.tourism, 12, 17],
    ['tourism', 'hostel', '🛏️', FILL.tourism, 13, 17],
    ['tourism', 'guest_house', '🛏️', FILL.tourism, 14, 18],
    ['tourism', 'motel', '🏨', FILL.tourism, 14, 18],
    ['tourism', 'chalet', '🏠', FILL.tourism, 14, 18],
    ['tourism', 'alpine_hut', '🏠', FILL.tourism, 14, 18],
    ['tourism', 'wilderness_hut', '🏚️', FILL.tourism, 14, 18],
    ['tourism', 'apartment', '🏢', FILL.tourism, 13, 18],
    ['tourism', 'camp_site', '⛺', FILL.green, 12, 17],
    ['tourism', 'caravan_site', '🚐', FILL.green, 13, 18],
    ['tourism', 'picnic_site', '🧺', FILL.green, 14, 18],
    ['tourism', 'viewpoint', '👀', null, 0, 17],
    ['tourism', 'theme_park', '🎢', FILL.tourism, 11, 17],
    ['tourism', 'zoo', '🦁', FILL.tourism, 11, 17],
    ['tourism', 'aquarium', '🐠', FILL.tourism, 12, 18],
    ['tourism', 'artwork', '🎨', null, 0, 18],
    ['tourism', 'information', 'ℹ️', null, 0, 18],

    // ---- shop（零售）----
    ['shop', 'supermarket', '🛒', FILL.shop, 12, 17],
    ['shop', 'convenience', '🏪', FILL.shop, 14, 17],
    ['shop', 'mall', '🏬', FILL.shop, 11, 17],
    ['shop', 'department_store', '🏬', FILL.shop, 12, 17],
    ['shop', 'variety_store', '🏪', FILL.shop, 14, 18],
    ['shop', 'general', '🏪', FILL.shop, 14, 18],
    ['shop', 'kiosk', '🏪', FILL.shop, 15, 18],
    ['shop', 'bakery', '🥖', FILL.shop, 14, 17],
    ['shop', 'butcher', '🥩', FILL.shop, 14, 18],
    ['shop', 'greengrocer', '🥬', FILL.shop, 14, 18],
    ['shop', 'seafood', '🐟', FILL.shop, 14, 18],
    ['shop', 'cheese', '🧀', FILL.shop, 15, 18],
    ['shop', 'confectionery', '🍬', FILL.shop, 15, 18],
    ['shop', 'alcohol', '🍷', FILL.shop, 14, 18],
    ['shop', 'beverages', '🥤', FILL.shop, 14, 18],
    ['shop', 'coffee', '☕', FILL.shop, 14, 18],
    ['shop', 'tea', '🍵', FILL.shop, 15, 18],
    ['shop', 'clothes', '👕', FILL.shop, 13, 17],
    ['shop', 'shoes', '👟', FILL.shop, 14, 18],
    ['shop', 'jewelry', '💍', FILL.shop, 14, 18],
    ['shop', 'bag', '👜', FILL.shop, 15, 18],
    ['shop', 'hairdresser', '💈', FILL.shop, 14, 17],
    ['shop', 'beauty', '💅', FILL.shop, 14, 18],
    ['shop', 'massage', '💆', FILL.shop, 15, 18],
    ['shop', 'optician', '👓', FILL.shop, 14, 18],
    ['shop', 'chemist', '💊', FILL.shop, 14, 18],
    ['shop', 'medical_supply', '🩺', FILL.shop, 14, 18],
    ['shop', 'hardware', '🔧', FILL.shop, 13, 17],
    ['shop', 'doityourself', '🧰', FILL.shop, 13, 17],
    ['shop', 'electronics', '📺', FILL.shop, 13, 17],
    ['shop', 'mobile_phone', '📱', FILL.shop, 14, 18],
    ['shop', 'computer', '💻', FILL.shop, 14, 18],
    ['shop', 'furniture', '🛋️', FILL.shop, 13, 17],
    ['shop', 'florist', '💐', FILL.shop, 14, 18],
    ['shop', 'garden_centre', '🌱', FILL.shop, 13, 17],
    ['shop', 'pet', '🐾', FILL.shop, 14, 18],
    ['shop', 'toys', '🧸', FILL.shop, 14, 18],
    ['shop', 'sports', '⚽', FILL.shop, 13, 17],
    ['shop', 'outdoor', '🏕️', FILL.shop, 14, 18],
    ['shop', 'bicycle', '🚲', FILL.shop, 13, 17],
    ['shop', 'car', '🚗', FILL.shop, 13, 17],
    ['shop', 'car_repair', '🔧', FILL.shop, 14, 18],
    ['shop', 'car_parts', '⚙️', FILL.shop, 14, 18],
    ['shop', 'motorcycle', '🏍️', FILL.shop, 14, 18],
    ['shop', 'books', '📚', FILL.shop, 13, 17],
    ['shop', 'stationery', '✏️', FILL.shop, 14, 18],
    ['shop', 'newsagent', '📰', FILL.shop, 14, 18],
    ['shop', 'gift', '🎁', FILL.shop, 14, 18],
    ['shop', 'art', '🖼️', FILL.shop, 14, 18],
    ['shop', 'music', '🎵', FILL.shop, 15, 18],
    ['shop', 'musical_instrument', '🎸', FILL.shop, 15, 18],
    ['shop', 'photo', '📷', FILL.shop, 15, 18],
    ['shop', 'travel_agency', '✈️', FILL.shop, 14, 18],
    ['shop', 'laundry', '🧺', FILL.shop, 14, 18],
    ['shop', 'dry_cleaning', '🧺', FILL.shop, 14, 18],
    ['shop', 'tailor', '🧵', FILL.shop, 15, 18],
    ['shop', 'shoe_repair', '👞', FILL.shop, 15, 18],
    ['shop', 'watchmaker', '⌚', FILL.shop, 15, 18],
    ['shop', 'locksmith', '🔑', FILL.shop, 15, 18],
    ['shop', 'pawnbroker', '💰', FILL.shop, 15, 18],
    ['shop', 'money_lender', '💰', FILL.shop, 15, 18],
    ['shop', 'estate_agent', '🏘️', FILL.shop, 14, 18],
    ['shop', 'copyshop', '🖨️', FILL.shop, 15, 18],
    ['shop', 'charity', '🤝', FILL.shop, 15, 18],
    ['shop', 'second_hand', '♻️', FILL.shop, 15, 18],
    ['shop', 'antiques', '🏺', FILL.shop, 15, 18],
    ['shop', 'vacant', '🏚️', null, 0, 18],

    // ---- office ----
    ['office', 'government', '🏛️', FILL.civic, 12, 17],
    ['office', 'company', '🏢', FILL.office, 14, 18],
    ['office', 'it', '💻', FILL.office, 14, 18],
    ['office', 'lawyer', '⚖️', FILL.office, 14, 18],
    ['office', 'accountant', '🧾', FILL.office, 14, 18],
    ['office', 'insurance', '🛡️', FILL.office, 14, 18],
    ['office', 'estate_agent', '🏘️', FILL.office, 14, 18],
    ['office', 'financial', '💰', FILL.office, 14, 18],
    ['office', 'research', '🔬', FILL.office, 13, 18],
    ['office', 'telecommunication', '📡', FILL.office, 13, 18],
    ['office', 'newspaper', '📰', FILL.office, 13, 18],
    ['office', 'coworking', '💼', FILL.office, 14, 18],
    ['office', 'employment_agency', '🧑‍💼', FILL.office, 14, 18],
    ['office', 'ngo', '🤝', FILL.civic, 13, 18],
    ['office', 'educational_institution', '🎓', FILL.edu, 12, 17],
    ['office', 'diplomatic', '🏛️', FILL.civic, 12, 17],
    ['office', 'political', '🏛️', FILL.civic, 14, 18],
    ['office', 'association', '🤝', FILL.civic, 14, 18],
    ['office', 'religion', '⛪', FILL.worship, 14, 18],

    // ---- craft ----
    ['craft', 'carpenter', '🪚', FILL.grey, 14, 18],
    ['craft', 'electrician', '⚡', FILL.grey, 14, 18],
    ['craft', 'plumber', '🔧', FILL.grey, 14, 18],
    ['craft', 'painter', '🎨', FILL.grey, 14, 18],
    ['craft', 'photographer', '📷', FILL.grey, 14, 18],
    ['craft', 'shoemaker', '👞', FILL.grey, 15, 18],
    ['craft', 'tailor', '🧵', FILL.grey, 15, 18],
    ['craft', 'brewery', '🍺', FILL.food, 13, 18],
    ['craft', 'distillery', '🥃', FILL.food, 14, 18],
    ['craft', 'gardener', '🌿', FILL.grey, 15, 18],
    ['craft', 'metal_construction', '⚙️', FILL.grey, 14, 18],
    ['craft', 'jeweller', '💍', FILL.grey, 15, 18],
    ['craft', 'blacksmith', '🔨', FILL.grey, 14, 18],
    ['craft', 'caterer', '🍽️', FILL.grey, 15, 18],
    ['craft', 'signmaker', '🪧', FILL.grey, 15, 18],

    // ---- historic ----
    ['historic', 'castle', '🏰', FILL.civic, 11, 17],
    ['historic', 'manor', '🏛️', FILL.civic, 11, 17],
    ['historic', 'fort', '🏰', FILL.civic, 11, 17],
    ['historic', 'ruins', '🏚️', FILL.civic, 12, 17],
    ['historic', 'archaeological_site', '⛏️', FILL.civic, 12, 17],
    ['historic', 'city_gate', '🏯', FILL.civic, 12, 18],
    ['historic', 'battlefield', '⚔️', FILL.civic, 12, 18],
    ['historic', 'monument', '🗿', null, 0, 17],
    ['historic', 'memorial', '🕯️', null, 0, 18],
    ['historic', 'wayside_cross', '✝️', null, 0, 18],
    ['historic', 'wayside_shrine', '⛩️', null, 0, 18],
    ['historic', 'boundary_stone', '🪨', null, 0, 19],
    ['historic', 'tomb', '🪦', null, 0, 19],

    // ---- healthcare ----
    ['healthcare', 'laboratory', '🔬', FILL.health, 13, 18],
    ['healthcare', 'blood_donation', '🩸', FILL.health, 13, 18],
    ['healthcare', 'hospice', '🏥', FILL.health, 13, 18],
    ['healthcare', 'optometrist', '👓', FILL.health, 14, 18],
    ['healthcare', 'physiotherapist', '💆', FILL.health, 14, 18],
    ['healthcare', 'alternative', '🧘', FILL.health, 14, 18],

    // ---- emergency ----
    ['emergency', 'ambulance_station', '🚑', FILL.security, 12, 17],
    ['emergency', 'fire_hydrant', '🧯', null, 0, 17],
    ['emergency', 'defibrillator', '🫀', null, 0, 18],
    ['emergency', 'assembly_point', '🆘', null, 0, 18],
    ['emergency', 'phone', '☎️', null, 0, 19],
    ['emergency', 'water_tank', '💧', null, 0, 18],
  ]);

  // ---------------------------------------------------------------------------
  // 10. 电力与管线（power=*）
  // ---------------------------------------------------------------------------
  lineGroup('power', 'power', [
    ['line', COLORS.power, 2, 13, null, { dash: [6, 4] }],
    ['minor_line', COLORS.power, 1.5, 14, null, { dash: [4, 4] }],
    ['cable', COLORS.power, 1.5, 15, null, { dash: [2, 6] }],
  ]);
  areaGroup('landuse', 'power', [
    ['plant', COLORS.industrial, 0.85, 11, 14],
    ['substation', '#e6dce8', 0.85, 13, 16],
    ['generator', COLORS.industrial, 0.85, 13, 16],
    ['transformer', '#e6dce8', 0.85, 15, 17],
  ]);
  pointGroup('poi', 'power', [
    ['tower', null, 13, { symbol: 'triangle' }],
    ['pole', null, 16, { symbol: 'circle' }],
    ['portal', null, 16, { symbol: 'square' }],
    ['terminal', null, 16, { symbol: 'circle' }],
    ['transformer', null, 17, { symbol: 'square' }],
    ['switch', null, 17, { symbol: 'circle' }],
    ['connection', null, 18, { symbol: 'circle' }],
    ['insulator', null, 19, { symbol: 'circle' }],
    ['catenary_mast', null, 18, { symbol: 'circle' }],
    ['generator', '⚡', 15, { label: L(17, 10) }],
    ['plant', '⚡', 15, { label: L(16, 11) }],
    ['substation', '⚡', 16, { label: L(17, 10) }],
  ]);
  lineGroup('barrier', 'man_made', [
    ['pipeline', COLORS.power, 2, 13, null, { dash: [6, 2] }],
    ['embankment', '#b0a9a0', 2, 14, null],
    ['breakwater', '#b5afa8', 3, 11, null],
    ['groyne', '#b5afa8', 2.5, 12, null],
    ['cutline', '#c8c8c0', 1.5, 14, null, { dash: [4, 6] }],
  ]);

  // ---------------------------------------------------------------------------
  // 11. 围栏与障碍（barrier=*）
  // ---------------------------------------------------------------------------
  lineGroup('barrier', 'barrier', [
    ['fence', '#9a9a9a', 1.5, 15, null, { dash: [3, 3] }],
    ['wall', '#a8a29a', 2, 14, null],
    ['hedge', '#8fbc6f', 2.5, 14, null, { dash: [3, 3] }],
    ['city_wall', '#9a9a9a', 3, 12, null],
    ['retaining_wall', '#b0a9a0', 2, 15, null],
    ['ditch', '#7aa8c0', 1.5, 14, null, { dash: [4, 4] }],
    ['guard_rail', '#c0c0c0', 1.5, 15, null],
    ['kerb', '#c8c8c8', 1, 17, null],
    ['embankment', '#b0a9a0', 2, 15, null],
    ['hedge_bank', '#9cc47c', 2, 15, null, { dash: [3, 3] }],
  ]);
  pointGroup('poi', 'barrier', [
    ['gate', null, 16, { symbol: 'square' }],
    ['lift_gate', null, 16, { symbol: 'square' }],
    ['bollard', null, 16, { symbol: 'circle' }],
    ['cycle_barrier', null, 17, { symbol: 'circle' }],
    ['block', null, 17, { symbol: 'square' }],
    ['entrance', null, 17, { symbol: 'circle' }],
    ['kissing_gate', null, 17, { symbol: 'square' }],
    ['stile', null, 17, { symbol: 'square' }],
    ['cattle_grid', null, 17, { symbol: 'square' }],
    ['sally_port', null, 17, { symbol: 'square' }],
    ['toll_booth', '🛂', 16],
    ['border_control', '🛂', 15],
  ]);

  // ---------------------------------------------------------------------------
  // 12. 边界（boundary=*）
  // ---------------------------------------------------------------------------
  // 行政边界按 admin_level 分五档：级别越低越粗越深
  // 行格式：[最小级别, 最大级别, 颜色, 宽度, 虚线, 最小缩放, 标签最小缩放]
  const ADMIN_BANDS = [
    [2, 2, '#8e6fc4', 5, [10, 6], 3, 6],
    [3, 4, '#a086d0', 4, [10, 6], 5, 7],
    [5, 6, COLORS.boundary, 3, [8, 6], 8, 9],
    [7, 8, '#c7b4e2', 2, [6, 4], 10, 11],
    [9, 10, '#d8cbea', 1.5, [4, 4], 12, 13],
  ];
  for (const band of ADMIN_BANDS) {
    const lo = band[0], hi = band[1], color = band[2], weight = band[3];
    const dash = band[4], minZoom = band[5], labelZoom = band[6];
    add({
      id: 'boundary:boundary=administrative@' + lo + '-' + hi,
      layer: 'boundary', geo: ['line', 'area'], kind: 'line',
      when: { boundary: ['administrative'] },
      where: (t) => {
        const v = parseInt(t.admin_level, 10);
        return Number.isFinite(v) && v >= lo && v <= hi;
      },
      stroke: color, weight: weight, widthByZoom: widthsFor(weight), dash: dash,
      minZoom: minZoom, maxZoom: 22, label: L(labelZoom, 11, COLORS.boundaryText),
    });
  }
  // 没写 admin_level 的行政边界
  add({
    id: 'boundary:boundary=administrative', layer: 'boundary', geo: ['line', 'area'], kind: 'line',
    when: { boundary: ['administrative'] },
    stroke: '#c0aade', weight: 2, widthByZoom: widthsFor(2), dash: [6, 4],
    minZoom: 10, maxZoom: 22, label: L(12, 11, COLORS.boundaryText),
  });
  lineGroup('boundary', 'boundary', [
    ['protected_area', '#8fbc8f', 2, 8, 12, { dash: [6, 4], label: L(12, 10, COLORS.greenText) }],
    ['national_park', '#7aa85a', 2.5, 7, 11, { dash: [8, 6], label: L(11, 11, COLORS.greenText) }],
    ['aboriginal_lands', '#8fbc8f', 2, 9, 13, { dash: [6, 4] }],
    ['postal_code', '#c8b8d8', 1.5, 12, null, { dash: [4, 4] }],
    ['maritime', '#9ab8d8', 2, 8, null, { dash: [8, 8] }],
  ]);

  // ---------------------------------------------------------------------------
  // 13. 军事（military=*）
  // ---------------------------------------------------------------------------
  areaGroup('landuse', 'military', [
    ['danger_area', '#f0e0e0', 0.5, 8, 12, { stroke: '#d8b8b8', weight: 1.5, dash: [6, 4], kind: 'both' }],
    ['barracks', '#e8e0e0', 0.85, 12, 15],
    ['bunker', '#d8d4cc', 0.85, 13, 16],
    ['airfield', '#e6e6e6', 0.6, 9, 13],
    ['training_area', '#e8e4d8', 0.6, 11, 14],
    ['range', '#e8e4d8', 0.6, 11, 14],
    ['naval_base', '#dfe6ea', 0.6, 10, 14],
  ]);
  pointGroup('poi', 'military', [
    ['checkpoint', null, 16, { symbol: 'square' }],
    ['trench', null, 17, { symbol: 'circle' }],
    ['bunker', null, 16, { symbol: 'square' }],
  ]);

  // ---------------------------------------------------------------------------
  // 14. 人造物（man_made=*）
  // ---------------------------------------------------------------------------
  // 桥梁 / 码头：结构面，画在水面与道路之上
  areaGroup('building', 'man_made', [
    ['bridge', '#cfc9c0', 0.9, 12, null, { stroke: '#b8b2aa', weight: 1, kind: 'both' }],
    ['pier', COLORS.building, 0.9, 12, null, { stroke: COLORS.buildingLine, weight: 1, kind: 'both' }],
    ['quay', '#d8d2ca', 0.9, 12, null, { stroke: '#c0bab2', weight: 1, kind: 'both' }],
  ]);
  // 厂区 / 罐体 / 塔基
  areaGroup('landuse', 'man_made', [
    ['works', COLORS.industrial, 0.85, 11, 14],
    ['wastewater_plant', '#d8dcd0', 0.85, 11, 14],
    ['water_works', '#d8e0e8', 0.85, 11, 14],
    ['reservoir_covered', '#d8e0e8', 0.85, 12, null],
    ['storage_tank', '#dcd8d2', 0.85, 13, 16],
    ['silo', '#dcd8d2', 0.85, 13, 16],
    ['gasometer', '#dcd8d2', 0.85, 13, 16],
    ['kiln', '#d8d0c8', 0.85, 14, 17],
    ['watermill', '#e0dcd4', 0.85, 13, 16],
    ['windmill', '#e0dcd4', 0.85, 12, 15],
    ['lighthouse', '#f0e8d0', 0.9, 12, 15],
    ['tower', COLORS.building, 0.9, 13, 16],
    ['observatory', '#e0dcd4', 0.85, 13, 16],
    ['crane', '#dcd8d2', 0.85, 15, 17],
  ]);
  pointGroup('poi', 'man_made', [
    ['tower', '🗼', 15, { label: L(16, 11) }],
    ['water_tower', '🗼', 15, { label: L(16, 10) }],
    ['lighthouse', '🗼', 14, { label: L(15, 11) }],
    ['chimney', null, 15, { symbol: 'square' }],
    ['mast', null, 15, { symbol: 'triangle' }],
    ['crane', null, 15, { symbol: 'triangle' }],
    ['windmill', null, 14, { symbol: 'triangle' }],
    ['watermill', null, 14, { symbol: 'square' }],
    ['kiln', null, 15, { symbol: 'square' }],
    ['observatory', null, 15, { symbol: 'circle' }],
    ['storage_tank', null, 15, { symbol: 'circle' }],
    ['silo', null, 15, { symbol: 'circle' }],
    ['gasometer', null, 15, { symbol: 'circle' }],
    ['pumping_station', null, 16, { symbol: 'square' }],
    ['wastewater_plant', null, 15, { symbol: 'square' }],
    ['water_works', null, 15, { symbol: 'square' }],
    ['bridge', null, 15, { symbol: 'square' }],
    ['pier', null, 15, { symbol: 'square' }],
    ['quay', null, 15, { symbol: 'square' }],
    ['breakwater', null, 14, { symbol: 'triangle' }],
    ['groyne', null, 14, { symbol: 'triangle' }],
    ['embankment', null, 16, { symbol: 'square' }],
    ['pipeline', null, 15, { symbol: 'circle' }],
    ['cutline', null, 16, { symbol: 'circle' }],
    ['adit', null, 16, { symbol: 'circle' }],
    ['mineshaft', null, 16, { symbol: 'circle' }],
    ['manhole', null, 19, { symbol: 'circle' }],
    ['survey_point', null, 18, { symbol: 'triangle' }],
    ['monitoring_station', null, 17, { symbol: 'circle' }],
    ['water_well', null, 17, { symbol: 'circle' }],
  ]);

  // ---------------------------------------------------------------------------
  // 15. 兜底规则（必须写在最后：同图层内先定义者优先）
  // ---------------------------------------------------------------------------
  // 道路图层：未知 highway / aeroway 取值也要有路可走
  lineGroup('road', 'highway', [
    ['*', COLORS.roadMinor, 3, 14, 16, { casing: { color: COLORS.roadMinorCase, weight: 4 }, label: L(16, 10) }],
  ]);
  lineGroup('road', 'aeroway', [
    ['*', '#d6d2cc', 3, 12, null, { geo: ['line'] }],
  ]);
  // 铁路图层
  lineGroup('railway', 'railway', [
    ['*', '#a8a8a8', 1.5, 15, null, { dash: [4, 4] }],
  ]);
  // 水系图层
  lineGroup('waterway', 'waterway', [
    ['*', COLORS.water, 1.5, 14, null],
  ]);
  lineGroup('waterway', 'route', [
    ['*', '#8aa9bd', 2, 13, null, { dash: [6, 6], geo: ['line'] }],
  ]);
  // 用地图层
  // 注意：这里不能给 natural 加「水系兜底」通配规则 —— water 图层在 landuse 之上，
  // 一旦写成 natural=* 就会把 wood / scrub 等陆地自然面全部盖成水色。
  areaGroup('landuse', 'landuse', [['*', COLORS.residential, 0.7, 13, null]]);
  areaGroup('landuse', 'natural', [['*', '#e8e6e0', 0.7, 13, null]]);
  areaGroup('landuse', 'leisure', [['*', COLORS.grass, 0.6, 13, null]]);
  areaGroup('landuse', 'man_made', [['*', '#dcd8d2', 0.7, 14, null]]);
  areaGroup('landuse', 'aeroway', [['*', '#dcd8d2', 0.7, 14, null]]);
  areaGroup('landuse', 'military', [['*', '#ece4e4', 0.6, 12, null]]);
  areaGroup('landuse', 'power', [['*', '#e6dce8', 0.7, 14, null]]);
  // 电力图层 / 障碍图层：未知取值
  lineGroup('power', 'power', [
    ['*', COLORS.power, 1.5, 16, null, { dash: [4, 4], geo: ['line'] }],
  ]);
  add({
    id: 'barrier:barrier=*', layer: 'barrier', geo: ['point', 'line', 'area'], kind: 'line',
    when: { barrier: ['*'] },
    stroke: '#a8a29a', weight: 1.5, widthByZoom: widthsFor(1.5), dash: [3, 3],
    symbol: 'square', minZoom: 16, maxZoom: 22,
  });
  // 边界图层
  lineGroup('boundary', 'boundary', [
    ['*', COLORS.boundary, 2, 10, 12, { dash: [6, 4], label: L(12, 10, COLORS.boundaryText) }],
  ]);
  // POI 面图层：任何未收录的 POI 取值也有底色
  const POI_AREA_FALLBACK_KEYS = [
    'amenity', 'shop', 'tourism', 'office', 'craft', 'historic', 'healthcare', 'emergency',
  ];
  for (const key of POI_AREA_FALLBACK_KEYS) {
    areaGroup('poi-area', key, [['*', FILL.grey, 0.5, 17, null]]);
  }
  // POI 点图层：任何未收录的 POI 取值也有符号
  const POI_POINT_FALLBACK_KEYS = [
    'amenity', 'shop', 'tourism', 'office', 'craft', 'historic', 'healthcare', 'emergency',
    'leisure', 'man_made', 'military', 'public_transport', 'aeroway', 'place',
  ];
  for (const key of POI_POINT_FALLBACK_KEYS) {
    pointGroup('poi', key, [['*', null, 18, { symbol: 'circle' }]]);
  }

  // ---------------------------------------------------------------------------
  // 16. 几何判定与图层分类
  // ---------------------------------------------------------------------------

  /** 出现这些 key 时，闭合 way / relation 视为「面」（前端据此决定 kind='area'） */
  const areaKeys = [
    'building', 'landuse', 'natural', 'leisure', 'amenity', 'waterway', 'boundary',
    'area', 'place', 'shop', 'tourism', 'historic', 'man_made', 'aeroway', 'power',
    'military', 'office', 'healthcare', 'public_transport',
  ];

  /** 图层面板分类（与 categoryOf 的返回值一一对应） */
  const CATEGORIES = [
    { id: 'road', name: '道路', defaultVisible: true },
    { id: 'railway', name: '铁路', defaultVisible: true },
    { id: 'path', name: '步道与小径', defaultVisible: true },
    { id: 'building', name: '建筑', defaultVisible: true },
    { id: 'landuse', name: '用地与绿地', defaultVisible: true },
    { id: 'water', name: '水系', defaultVisible: true },
    { id: 'boundary', name: '边界', defaultVisible: true },
    { id: 'power', name: '电力与管线', defaultVisible: false },
    { id: 'barrier', name: '围栏与障碍', defaultVisible: false },
    { id: 'poi', name: '兴趣点', defaultVisible: true },
    { id: 'transport', name: '公共交通', defaultVisible: true },
    { id: 'other', name: '其它', defaultVisible: true },
  ];

  /** 归入「步道与小径」的 highway 取值 */
  const PATH_HIGHWAYS = {
    footway: 1, path: 1, steps: 1, cycleway: 1, bridleway: 1, corridor: 1, track: 1,
  };
  /** 归入「公共交通」的 highway 取值 */
  const TRANSPORT_HIGHWAYS = { bus_stop: 1, platform: 1, bus_guideway: 1 };
  /** 归入「公共交通」的 railway 取值 */
  const TRANSPORT_RAILWAYS = {
    station: 1, halt: 1, tram_stop: 1, subway_entrance: 1, stop: 1, platform: 1,
  };
  /** 归入「公共交通」的 amenity 取值 */
  const TRANSPORT_AMENITY = {
    bus_station: 1, taxi: 1, ferry_terminal: 1, parking: 1, parking_entrance: 1,
    bicycle_parking: 1, bicycle_rental: 1, motorcycle_parking: 1, car_rental: 1,
    car_sharing: 1, charging_station: 1,
  };

  /** 该标签组合是否属于「水系」（用于分类与标注优先级） */
  function isWaterTags(tags) {
    if (tags.waterway || tags.water) return true;
    const n = tags.natural;
    if (n === 'water' || n === 'bay' || n === 'strait' || n === 'coastline' || n === 'spring') return true;
    if (tags.landuse === 'basin' || tags.landuse === 'salt_pond' || tags.landuse === 'reservoir') return true;
    if (tags.leisure === 'swimming_pool' || tags.leisure === 'marina' || tags.leisure === 'water_park') return true;
    return false;
  }

  /** 图层面板分类 id（必是 CATEGORIES 里的 id 之一） */
  function categoryOf(tags, kind) {
    if (!tags || typeof tags !== 'object') return 'other';
    if (tags.building || tags['building:part']) return 'building';
    if (tags.boundary) return 'boundary';
    if (tags.power) return 'power';
    if (tags.barrier) return 'barrier';
    if (tags.highway) {
      if (PATH_HIGHWAYS[tags.highway]) return 'path';
      if (TRANSPORT_HIGHWAYS[tags.highway]) return 'transport';
      return 'road';
    }
    if (tags.railway) return TRANSPORT_RAILWAYS[tags.railway] ? 'transport' : 'railway';
    if (tags.aeroway || tags.public_transport || tags.route) return 'transport';
    if (isWaterTags(tags)) return 'water';
    if (tags.amenity && TRANSPORT_AMENITY[tags.amenity]) return 'transport';
    if (tags.amenity || tags.shop || tags.tourism || tags.historic || tags.office ||
        tags.craft || tags.healthcare || tags.emergency) return 'poi';
    if (tags.landuse || tags.leisure || tags.natural || tags.man_made || tags.military) return 'landuse';
    return 'other';
  }

  // ---------------------------------------------------------------------------
  // 17. 匹配、修饰与取名字
  // ---------------------------------------------------------------------------

  // 规则索引：标签 key -> 规则下标；另有「只靠 where 判定」的规则桶。
  // 作用只是加速：候选集合并按定义顺序升序后，逐条判定的结果与全表扫描完全一致
  // （所有带 when 的规则，若其 key 不在 tags 里就必然不命中）。
  const RULE_INDEX = {};
  const CANDIDATE_ANY = [];
  for (let i = 0; i < RULES.length; i++) {
    const when = RULES[i].when;
    if (!when) { CANDIDATE_ANY.push(i); continue; }
    for (const key in when) {
      if (!RULE_INDEX[key]) RULE_INDEX[key] = [];
      RULE_INDEX[key].push(i);
    }
  }

  /** 收集可能命中的规则下标（升序） */
  function candidateIndexes(tags) {
    const list = CANDIDATE_ANY.slice();
    for (const key in tags) {
      const bucket = RULE_INDEX[key];
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) list.push(bucket[i]);
    }
    list.sort(function (a, b) { return a - b; });
    return list;
  }

  /** 标签值是否构成「是」（排除 no / false / empty） */
  function isSet(v) {
    if (v == null || v === false) return false;
    const s = String(v).toLowerCase();
    return s !== '' && s !== 'no' && s !== 'false' && s !== '0';
  }

  /** when 条件匹配：'*' 表示该 key 存在即可 */
  function whenMatches(when, tags) {
    for (const key in when) {
      const value = tags[key];
      if (value == null || value === '') return false;
      const list = when[key];
      let hit = false;
      for (let i = 0; i < list.length; i++) {
        if (list[i] === '*' || String(value) === list[i]) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  }

  /** 规则是否命中 */
  function matchesRule(rule, tags) {
    if (!rule.when && !rule.where) return false;
    if (rule.when && !whenMatches(rule.when, tags)) return false;
    if (rule.where && !rule.where(tags)) return false;
    return true;
  }

  /** 路面材质对底色的轻微影响（paved 等硬质路面保持原色） */
  const SURFACE_TINT = {
    unpaved: '#e8dcc4', gravel: '#d6c39b', fine_gravel: '#ddcdaa', pebblestone: '#ded6c2',
    dirt: '#d9c9a8', ground: '#d9c9a8', earth: '#d9c9a8', mud: '#c9bda0', sand: '#f0e0b0',
    grass: '#cde0a8', grass_paver: '#cde0a8', wood: '#c8a882', compacted: '#e2d8c4',
  };

  /** 拷贝规则并叠加 tags 修饰（隧道 / 桥梁 / layer / surface） */
  function decorate(rule, tags) {
    const out = {};
    for (const key in rule) {
      if (key === 'when' || key === 'where') continue; // 匹配条件不属于绘制样式
      out[key] = rule[key];
    }
    // 隧道：半透明且不画描边
    if (isSet(tags.tunnel)) {
      out.tunnel = true;
      out.opacity = Math.min(out.opacity == null ? 1 : out.opacity, 0.55);
      delete out.casing;
    }
    // 桥梁：描边更深更粗
    if (isSet(tags.bridge)) {
      out.bridge = true;
      const base = out.casing || null;
      const color = base ? base.color : (out.stroke || COLORS.roadMinorCase);
      const weight = base ? base.weight : (out.weight || 3);
      out.casing = { color: shade(color, 0.72), weight: ROUND(weight + 1) };
    }
    // OSM layer=* 透出，供前端同层排序
    const layerValue = Number(tags.layer);
    out.osmLayer = Number.isFinite(layerValue) ? layerValue : 0;
    // 路面材质：轻微改变道路底色
    if (tags.surface && (out.layer === 'road' || out.layer === 'road-detail')) {
      const surface = String(tags.surface);
      const tint = SURFACE_TINT[surface];
      out.surface = surface;
      if (tint) {
        if (out.stroke) out.stroke = mix(out.stroke, tint, 0.55);
        if (out.fill) out.fill = mix(out.fill, tint, 0.55);
      }
    }
    return out;
  }

  /**
   * 取要素的绘制样式
   * @param {object} tags OSM 标签
   * @param {string} kind 'point' | 'line' | 'area'
   * @returns {null|object}
   */
  function ruleFor(tags, kind) {
    if (!tags || typeof tags !== 'object') return null;
    const geo = kind === 'point' ? 'point' : (kind === 'area' ? 'area' : 'line');
    const candidates = candidateIndexes(tags);
    let best = null;
    let bestLayer = -1;
    for (let c = 0; c < candidates.length; c++) {
      const rule = RULES[candidates[c]];
      if (rule.geo.indexOf(geo) < 0) continue;
      const layerIndex = LAYER_INDEX[rule.layer];
      if (layerIndex <= bestLayer) continue; // 同图层先定义者优先
      if (!matchesRule(rule, tags)) continue;
      best = rule;
      bestLayer = layerIndex;
    }
    return best ? decorate(best, tags) : null;
  }

  /** place=* 的标注优先级 */
  const PLACE_PRIORITY = {
    city: 10, town: 9, borough: 8, village: 8, suburb: 7, quarter: 7,
    neighbourhood: 6, hamlet: 6, isolated_dwelling: 5, locality: 5,
    farm: 5, square: 6, island: 6, islet: 5,
  };

  /** 标签取字符串 */
  function textOf(v) {
    if (v == null) return '';
    return String(v).trim();
  }

  /** name 标注优先级（10 最重要） */
  function priorityOf(tags) {
    const hw = tags.highway;
    if (hw) {
      switch (hw) {
        case 'motorway': case 'motorway_link':
        case 'trunk': case 'trunk_link': return 9;
        case 'primary': case 'primary_link': return 8;
        case 'secondary': case 'secondary_link': return 7;
        case 'tertiary': case 'tertiary_link': return 6;
        case 'unclassified': case 'residential': case 'living_street': case 'pedestrian': return 5;
        case 'service': case 'track': case 'road': return 4;
        default: return 3; // 步道 / 小径 / 自行车道等
      }
    }
    if (tags.place && PLACE_PRIORITY[tags.place]) return PLACE_PRIORITY[tags.place];
    if (tags.natural === 'peak' || tags.natural === 'volcano') return 8;
    if (tags.railway === 'station' || tags.railway === 'halt') return 7;
    if (tags.public_transport === 'station') return 7;
    if (tags.aeroway === 'aerodrome') return 7;
    if (tags.railway) return 5;
    if (isWaterTags(tags)) return 6;
    if (tags.boundary) return 5;
    if (tags.building || tags['building:part']) return 4;
    if (tags.amenity || tags.shop || tags.tourism || tags.historic || tags.office ||
        tags.craft || tags.healthcare || tags.emergency) return 5;
    if (tags.leisure || tags.landuse || tags.natural || tags.man_made || tags.military) return 4;
    return 5;
  }

  /** ref 标注优先级（比同名要素低一档） */
  function refPriorityOf(tags) {
    const hw = tags.highway;
    if (hw === 'motorway' || hw === 'motorway_link' || hw === 'trunk' || hw === 'trunk_link') return 7;
    if (hw === 'primary' || hw === 'primary_link') return 6;
    if (hw) return 5;
    if (tags.railway || tags.route || tags.public_transport || tags.aeroway) return 5;
    return 4;
  }

  /**
   * 取要素的标注文字
   * @returns {null|{text:string, priority:number}}
   */
  function labelFor(tags) {
    if (!tags || typeof tags !== 'object') return null;
    const name = textOf(tags.name) || textOf(tags['name:zh']);
    // 山峰：名字 + 高程（米）
    if (tags.natural === 'peak' || tags.natural === 'volcano') {
      const ele = textOf(tags.ele).replace(/\s*m$/i, '').trim();
      if (name && ele) return { text: name + ' (' + ele + ' m)', priority: 8 };
      if (name) return { text: name, priority: 8 };
      if (ele) return { text: ele + ' m', priority: 6 };
      return null;
    }
    if (name) return { text: name, priority: priorityOf(tags) };
    // 编号（国道 / 铁路线号等）
    const ref = textOf(tags.ref);
    if (ref) return { text: ref, priority: refPriorityOf(tags) };
    // 门牌号（仅建筑）
    if (tags.building || tags['building:part']) {
      const hn = textOf(tags['addr:housenumber']);
      if (hn) return { text: hn, priority: 2 };
    }
    return null;
  }

  // 数据表冻结为只读：
  //   · RULES 数组与每条规则本身冻结；
  //   · casing / label / widthByZoom 这些嵌套对象也被冻结，可以安全地在多条规则间共享；
  //   · ruleFor 返回顶层拷贝，调用方想改样式请改返回值（嵌套对象请自行替换成新对象）。
  Object.freeze(LAYER_ORDER);
  for (const rule of RULES) {
    if (rule.casing) Object.freeze(rule.casing);
    if (rule.label) Object.freeze(rule.label);
    if (rule.widthByZoom) Object.freeze(rule.widthByZoom);
    Object.freeze(rule);
  }
  Object.freeze(RULES);
  for (const cat of CATEGORIES) Object.freeze(cat);
  Object.freeze(CATEGORIES);
  Object.freeze(areaKeys);

  window.G.Style = {
    LAYER_ORDER: LAYER_ORDER,
    RULES: RULES,
    COLORS: COLORS,
    CATEGORIES: CATEGORIES,
    areaKeys: areaKeys,
    ruleFor: ruleFor,
    labelFor: labelFor,
    categoryOf: categoryOf,
  };
})();
