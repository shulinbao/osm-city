'use strict';
/**
 * 样式表 / 预设表 单元测试（CommonJS，直接运行：node tests/style-test.js）
 * ============================================================================
 * 做法：读入 public/js/style.js 与 public/js/presets.js 的源码，用 vm.runInNewContext
 *      注入一个假的 window 对象执行（模拟浏览器 <script src> 顺序），再逐条断言。
 * 输出：每条 ✅ / ❌，最后打印通过 / 失败数与统计；有失败则以退出码 1 结束。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STYLE_REL = 'public/js/style.js';
const PRESETS_REL = 'public/js/presets.js';

// ---------------------------------------------------------------------------
// 极简测试骨架
// ---------------------------------------------------------------------------
let passCount = 0;
let failCount = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    passCount++;
    console.log('✅ ' + label);
    return true;
  }
  failCount++;
  const line = label + (detail ? '　→ ' + detail : '');
  failures.push(line);
  console.log('❌ ' + line);
  return false;
}

/** 组装失败详情 */
function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function eq(actual, expected, label) {
  return ok(actual === expected, label, '期望 ' + show(expected) + '，实际 ' + show(actual));
}

function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 58 - title.length)));
}

// ---------------------------------------------------------------------------
// 颜色小工具
// ---------------------------------------------------------------------------
function rgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function isHexColor(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v); }
function isWhiteish(v) {
  if (!isHexColor(v)) return false;
  const c = rgb(v);
  return Math.min(c[0], c[1], c[2]) >= 235 && (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) <= 22;
}
function isBeige(v) {
  if (!isHexColor(v)) return false;
  const c = rgb(v);
  return c[0] > c[1] && c[1] > c[2] && c[0] - c[2] <= 45 && c[0] >= 180;
}
function isGreenish(v) {
  if (!isHexColor(v)) return false;
  const c = rgb(v);
  return c[1] > c[0] + 8 && c[1] > c[2] + 8;
}
function isPinkish(v) {
  if (!isHexColor(v)) return false;
  const c = rgb(v);
  return c[0] > c[1] + 10 && c[0] > c[2] + 10 && Math.abs(c[1] - c[2]) <= 45;
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isDash(v) {
  if (!Array.isArray(v) || v.length < 2) return false;
  for (const n of v) if (!isNum(n) || n <= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 加载前端脚本（同一个假 window，模拟浏览器里的加载顺序）
// ---------------------------------------------------------------------------
const sources = {};
function sourceOf(rel) {
  if (!sources[rel]) sources[rel] = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return sources[rel];
}

function loadInto(window) {
  const ctx = { window: window, console: console };
  for (const rel of [STYLE_REL, PRESETS_REL]) {
    vm.runInNewContext(sourceOf(rel), ctx, { filename: rel });
  }
  return window.G;
}

const fakeWindow = {};
const G = loadInto(fakeWindow);
const Style = G.Style;
const Presets = G.Presets;

// ---------------------------------------------------------------------------
// 1. 加载与传统 script 形式
// ---------------------------------------------------------------------------
section('加载与形式');

ok(!!Style, 'G.Style 已挂到全局');
ok(!!Presets, 'G.Presets 已挂到全局');
for (const rel of [STYLE_REL, PRESETS_REL]) {
  const src = sourceOf(rel);
  ok(!/^\s*(import|export)\s/m.test(src), rel + ' 不含 import/export（传统 script）');
  ok(/window\.G\s*=\s*window\.G\s*\|\|\s*\{\}/.test(src), rel + ' 使用 window.G 命名空间');
}
ok(typeof Style.ruleFor === 'function', 'Style.ruleFor 是函数');
ok(typeof Style.labelFor === 'function', 'Style.labelFor 是函数');
ok(typeof Style.categoryOf === 'function', 'Style.categoryOf 是函数');
ok(Array.isArray(Style.LAYER_ORDER), 'Style.LAYER_ORDER 是数组');
ok(Array.isArray(Style.RULES), 'Style.RULES 是数组');
ok(Array.isArray(Style.CATEGORIES), 'Style.CATEGORIES 是数组');
ok(Array.isArray(Style.areaKeys), 'Style.areaKeys 是数组');
ok(typeof Presets.byId === 'function' && typeof Presets.all === 'function' &&
  typeof Presets.search === 'function' && Array.isArray(Presets.categories),
  'Presets 暴露 categories / byId / all / search');

// ---------------------------------------------------------------------------
// 2. 图层顺序一致性
// ---------------------------------------------------------------------------
section('图层顺序');

const LAYERS = Style.LAYER_ORDER;
ok(LAYERS.length >= 10, 'LAYER_ORDER 至少 10 个图层', '实际 ' + LAYERS.length);
ok(new Set(LAYERS).size === LAYERS.length, 'LAYER_ORDER 无重复图层');

{
  const bad = [];
  const usedLayers = new Set();
  for (const rule of Style.RULES) {
    usedLayers.add(rule.layer);
    if (LAYERS.indexOf(rule.layer) < 0) bad.push(rule.id + ' → ' + rule.layer);
  }
  ok(bad.length === 0, '所有规则的 layer 都在 LAYER_ORDER 中', bad.slice(0, 5).join('; '));

  const unused = LAYERS.filter((l) => !usedLayers.has(l));
  ok(unused.length === 0, 'LAYER_ORDER 中每个图层都被规则使用', '未使用：' + unused.join(', '));

  // ruleFor 返回值里的 layer 必须合法
  const badLayer = [];
  const probes = [
    { highway: 'motorway' }, { highway: 'footway' }, { building: 'yes' },
    { natural: 'water' }, { natural: 'wood' }, { landuse: 'forest' }, { leisure: 'park' },
    { waterway: 'river' }, { railway: 'rail' }, { boundary: 'administrative', admin_level: '4' },
    { power: 'line' }, { barrier: 'wall' }, { amenity: 'restaurant' }, { shop: 'mall' },
    { tourism: 'hotel' }, { place: 'city' }, { man_made: 'pipeline' }, { aeroway: 'runway' },
  ];
  for (const tags of probes) {
    for (const kind of ['point', 'line', 'area']) {
      const style = Style.ruleFor(tags, kind);
      if (style && LAYERS.indexOf(style.layer) < 0) badLayer.push(show(tags) + '/' + kind + ' → ' + style.layer);
    }
  }
  ok(badLayer.length === 0, 'ruleFor 返回值的 layer 都在 LAYER_ORDER 中', badLayer.slice(0, 5).join('; '));
}

// ---------------------------------------------------------------------------
// 3. 规则字段合法性（遍历全部规则）
// ---------------------------------------------------------------------------
section('规则字段校验（' + Style.RULES.length + ' 条）');

{
  const problems = [];
  const ids = new Set();
  const dupIds = [];
  const GEO = ['point', 'line', 'area'];
  const KINDS = ['line', 'fill', 'both'];
  const SYMBOLS = ['circle', 'square', 'triangle'];

  for (const rule of Style.RULES) {
    const at = rule.id || '(无 id)';
    if (!rule.id) problems.push('规则缺少 id');
    if (ids.has(rule.id)) dupIds.push(rule.id);
    ids.add(rule.id);
    if (LAYERS.indexOf(rule.layer) < 0) problems.push(at + ': layer 非法 ' + rule.layer);
    if (KINDS.indexOf(rule.kind) < 0) problems.push(at + ': kind 非法 ' + rule.kind);
    if (!Array.isArray(rule.geo) || rule.geo.length === 0) problems.push(at + ': geo 非法');
    else for (const g of rule.geo) if (GEO.indexOf(g) < 0) problems.push(at + ': geo 元素非法 ' + g);
    if (!rule.when && !rule.where) problems.push(at + ': 缺少 when / where');

    if (rule.fill !== undefined) {
      if (!isHexColor(rule.fill)) problems.push(at + ': fill 不是 6 位十六进制 ' + show(rule.fill));
    }
    if (rule.stroke !== undefined) {
      if (!isHexColor(rule.stroke)) problems.push(at + ': stroke 不是 6 位十六进制 ' + show(rule.stroke));
    }
    if (rule.fillOpacity !== undefined && (!isNum(rule.fillOpacity) || rule.fillOpacity < 0 || rule.fillOpacity > 1)) {
      problems.push(at + ': fillOpacity 非法 ' + show(rule.fillOpacity));
    }
    if (rule.opacity !== undefined && (!isNum(rule.opacity) || rule.opacity < 0 || rule.opacity > 1)) {
      problems.push(at + ': opacity 非法 ' + show(rule.opacity));
    }
    if (rule.weight !== undefined && (!isNum(rule.weight) || rule.weight <= 0 || rule.weight > 30)) {
      problems.push(at + ': weight 非法 ' + show(rule.weight));
    }
    if (rule.dash !== undefined && !isDash(rule.dash)) problems.push(at + ': dash 非法 ' + show(rule.dash));
    if (rule.casing !== undefined) {
      if (!rule.casing || !isHexColor(rule.casing.color)) problems.push(at + ': casing.color 非法');
      else if (!isNum(rule.casing.weight) || rule.casing.weight <= 0) problems.push(at + ': casing.weight 非法');
    }
    if (!isNum(rule.minZoom) || rule.minZoom < 2 || rule.minZoom > 22) problems.push(at + ': minZoom 非法 ' + show(rule.minZoom));
    if (!isNum(rule.maxZoom) || rule.maxZoom < 2 || rule.maxZoom > 22) problems.push(at + ': maxZoom 非法 ' + show(rule.maxZoom));
    if (isNum(rule.minZoom) && isNum(rule.maxZoom) && rule.minZoom > rule.maxZoom) problems.push(at + ': minZoom > maxZoom');
    if (rule.label !== undefined) {
      const lb = rule.label;
      if (!isNum(lb.size) || lb.size < 8 || lb.size > 24) problems.push(at + ': label.size 非法 ' + show(lb.size));
      if (!isHexColor(lb.color)) problems.push(at + ': label.color 非法');
      if (!isHexColor(lb.halo)) problems.push(at + ': label.halo 非法');
      if (!isNum(lb.weight) || lb.weight < 100 || lb.weight > 900) problems.push(at + ': label.weight 非法');
      if (!isNum(lb.minZoom) || lb.minZoom < 2 || lb.minZoom > 22) problems.push(at + ': label.minZoom 非法');
    }
    if (rule.icon !== undefined) {
      if (typeof rule.icon !== 'string' || rule.icon.length === 0) problems.push(at + ': icon 非法');
      if (rule.symbol !== undefined) problems.push(at + ': icon 与 symbol 同时存在');
    }
    if (rule.symbol !== undefined && SYMBOLS.indexOf(rule.symbol) < 0) problems.push(at + ': symbol 非法 ' + rule.symbol);
    if (rule.extrude !== undefined && typeof rule.extrude !== 'boolean') problems.push(at + ': extrude 非布尔');
    if (rule.geo && rule.geo.indexOf('point') >= 0 && !rule.icon && !rule.symbol) {
      problems.push(at + ': 点要素规则既没有 icon 也没有 symbol');
    }
    if (rule.widthByZoom !== undefined) {
      const zoomKeys = Object.keys(rule.widthByZoom);
      if (zoomKeys.length === 0) problems.push(at + ': widthByZoom 为空');
      for (const z of zoomKeys) {
        const zn = Number(z);
        if (!isNum(zn) || zn < 2 || zn > 22) problems.push(at + ': widthByZoom 缩放键非法 ' + z);
        if (!isNum(rule.widthByZoom[z]) || rule.widthByZoom[z] <= 0) problems.push(at + ': widthByZoom 宽度非法 ' + show(rule.widthByZoom[z]));
      }
    }
    if (rule.kind === 'line' && rule.weight !== undefined && rule.widthByZoom === undefined) {
      problems.push(at + ': 线状规则有 weight 但缺 widthByZoom');
    }
  }

  ok(dupIds.length === 0, '规则 id 全局唯一', dupIds.slice(0, 5).join(', '));
  ok(problems.length === 0, '全部规则字段类型合法（颜色 / 数值 / 枚举 / 必填）',
    problems.length + ' 处问题：' + problems.slice(0, 6).join(' | '));

  // 颜色集中校验：调色板本身也得是合法颜色
  const badColors = Object.keys(Style.COLORS).filter((k) => !isHexColor(Style.COLORS[k]));
  ok(badColors.length === 0, 'COLORS 调色板全部是合法 6 位十六进制颜色', badColors.join(', '));
}

// ---------------------------------------------------------------------------
// 4. 关键要素的 ruleFor 行为
// ---------------------------------------------------------------------------
section('ruleFor：关键要素');

{
  const motorway = Style.ruleFor({ highway: 'motorway' }, 'line');
  ok(!!motorway, 'motorway 能匹配到规则');
  eq(motorway && motorway.layer, 'road', 'motorway 的 layer 是 road');
  ok(!!(motorway && motorway.casing), 'motorway 有 casing 描边');
  ok(!!(motorway && motorway.weight >= 5), 'motorway 的 weight >= 5', '实际 ' + (motorway && motorway.weight));
  ok(!!(motorway && motorway.minZoom <= 12), 'motorway 的 minZoom <= 12', '实际 ' + (motorway && motorway.minZoom));
  ok(!!(motorway && motorway.widthByZoom), 'motorway 带 widthByZoom 随缩放变宽');
  ok(!!(motorway && motorway.label && motorway.label.minZoom <= 11), '高速公路标签 z11 之前就能出现');

  const residential = Style.ruleFor({ highway: 'residential' }, 'line');
  ok(!!residential, 'residential 能匹配到规则');
  ok(!!(residential && (isWhiteish(residential.fill) || isWhiteish(residential.stroke))),
    'residential 的 fill/stroke 是白色系',
    'fill=' + show(residential && residential.fill) + ' stroke=' + show(residential && residential.stroke));
  ok(!!(residential && residential.casing), 'residential 有 casing 描边');

  const footway = Style.ruleFor({ highway: 'footway' }, 'line');
  ok(!!footway, 'footway 能匹配到规则');
  ok(!!(footway && isPinkish(footway.stroke)), 'footway 的 stroke 是粉红色系', '实际 ' + show(footway && footway.stroke));
  ok(!!(footway && isDash(footway.dash)), 'footway 是虚线', 'dash=' + show(footway && footway.dash));
  ok(!!(footway && footway.minZoom >= 16), 'footway 的 minZoom >= 16（低缩放不画小路）', '实际 ' + (footway && footway.minZoom));
  ok(!!(footway && footway.label && footway.label.minZoom >= 17), '人行道标签 z17 之后才出现');

  const building = Style.ruleFor({ building: 'yes', 'building:levels': '6' }, 'area');
  ok(!!building, 'building=yes 能匹配到规则');
  eq(building && building.extrude, true, 'building=yes + building:levels=6 时 extrude === true');
  ok(!!(building && isBeige(building.fill)), '建筑填充是米色系', '实际 ' + show(building && building.fill));

  const water = Style.ruleFor({ natural: 'water' }, 'area');
  eq(water && water.layer, 'water', 'natural=water 的 layer 是 water');
  eq(water && water.fill, '#aad3df', 'natural=water 的填充是 #aad3df');

  const park = Style.ruleFor({ leisure: 'park' }, 'area');
  ok(!!(park && isGreenish(park.fill)), 'leisure=park 的填充是绿色系', '实际 ' + show(park && park.fill));

  const admin = Style.ruleFor({ boundary: 'administrative', admin_level: '4' }, 'line');
  eq(admin && admin.layer, 'boundary', 'admin_level=4 的 boundary 在 boundary 图层');
  ok(!!(admin && isDash(admin.dash)), 'admin_level=4 的 boundary 是虚线', 'dash=' + show(admin && admin.dash));

  const subway = Style.ruleFor({ railway: 'subway' }, 'line');
  eq(subway && subway.layer, 'railway', 'railway=subway 的 layer 是 railway');
  ok(!!(subway && isDash(subway.dash)), 'railway=subway 是虚线', 'dash=' + show(subway && subway.dash));

  eq(Style.ruleFor({}, 'line'), null, '空标签 {} 返回 null');
  eq(Style.ruleFor({ foo: 'bar' }, 'line'), null, '未知标签 {foo:bar} 返回 null');
  eq(Style.ruleFor({}, 'area'), null, '空标签 {} + area 返回 null');
  eq(Style.ruleFor({}, 'point'), null, '空标签 {} + point 返回 null');
  eq(Style.ruleFor(null, 'line'), null, 'tags 为 null 时返回 null');
  ok(!!Style.ruleFor({ highway: 'zzz_unknown' }, 'line'), '未知 highway 取值有兜底规则，不会漏画');
  ok(!!Style.ruleFor({ amenity: 'zzz_unknown' }, 'point'), '未知 amenity 取值有兜底规则');
}

// ---------------------------------------------------------------------------
// 5. 优先级、修饰与纯函数性质
// ---------------------------------------------------------------------------
section('ruleFor：优先级与修饰');

{
  // 同图层先定义者优先
  const construction = Style.ruleFor({ building: 'construction' }, 'area');
  eq(construction && construction.id, 'building:building=construction', 'building=construction 命中在建建筑规则（同图层先定义者优先）');

  // 不同图层取更靠上的
  const mixed = Style.ruleFor({ landuse: 'forest', natural: 'water' }, 'area');
  eq(mixed && mixed.layer, 'water', 'landuse 与 natural=water 同时存在时取更靠上的 water 图层');

  const areaRoad = Style.ruleFor({ highway: 'pedestrian', area: 'yes' }, 'area');
  eq(areaRoad && areaRoad.kind, 'both', '闭合的步行区按面 + 线绘制（kind=both）');

  // 隧道 / 桥梁 / layer / surface 修饰
  const plain = Style.ruleFor({ highway: 'primary' }, 'line');
  const tunnel = Style.ruleFor({ highway: 'primary', tunnel: 'yes' }, 'line');
  ok(!!(tunnel && tunnel.opacity <= 0.55), '隧道半透明', 'opacity=' + (tunnel && tunnel.opacity));
  ok(!!(tunnel && !tunnel.casing), '隧道不画描边 casing');
  eq(tunnel && tunnel.tunnel, true, '隧道透出 tunnel 标记');

  const bridge = Style.ruleFor({ highway: 'primary', bridge: 'yes' }, 'line');
  ok(!!(bridge && bridge.casing && plain && bridge.casing.color !== plain.casing.color),
    '桥梁描边颜色与普通道路不同');
  ok(!!(bridge && bridge.casing.weight > plain.casing.weight), '桥梁描边更粗');
  eq(bridge && bridge.bridge, true, '桥梁透出 bridge 标记');

  const layered = Style.ruleFor({ highway: 'primary', layer: '-1' }, 'line');
  eq(layered && layered.osmLayer, -1, 'layer 标签透出为 osmLayer');

  const plainResidential = Style.ruleFor({ highway: 'residential' }, 'line');
  const gravel = Style.ruleFor({ highway: 'residential', surface: 'gravel' }, 'line');
  ok(!!(gravel && gravel.stroke !== plainResidential.stroke), 'surface=gravel 会改变道路底色',
    '普通 ' + show(plainResidential.stroke) + ' vs 碎石 ' + show(gravel && gravel.stroke));
  eq(gravel && gravel.surface, 'gravel', 'surface 标签透出为 surface');

  // 纯函数：顶层是拷贝，嵌套样式对象只读共享
  const first = Style.ruleFor({ highway: 'motorway' }, 'line');
  first.stroke = '#000000';
  first.casing = { color: '#000000', weight: 1 };
  let nestedFrozen = true;
  const nested = Style.ruleFor({ highway: 'motorway' }, 'line').casing;
  try { nested.color = '#000000'; } catch (e) { /* 严格模式下写入冻结对象会抛错，同样算只读 */ }
  if (nested.color === '#000000') nestedFrozen = false;
  const second = Style.ruleFor({ highway: 'motorway' }, 'line');
  ok(second.stroke !== '#000000' && second.casing.color === '#dc2a67',
    'ruleFor 顶层返回拷贝，改返回值不影响规则表',
    'stroke=' + show(second.stroke) + ' casing=' + show(second.casing.color));
  ok(nestedFrozen, 'casing / label / widthByZoom 是冻结的只读共享对象');
  ok(Object.isFrozen(Style.RULES) && Object.isFrozen(Style.LAYER_ORDER), 'RULES 与 LAYER_ORDER 是冻结的只读数组');

  // 索引加速与全表扫描语义一致
  function bruteForce(tags, kind) {
    const geo = kind === 'point' ? 'point' : (kind === 'area' ? 'area' : 'line');
    let best = null;
    let bestLayer = -1;
    for (const rule of Style.RULES) {
      if (rule.geo.indexOf(geo) < 0) continue;
      const li = LAYERS.indexOf(rule.layer);
      if (li <= bestLayer) continue;
      let hit = true;
      if (rule.when) {
        for (const key in rule.when) {
          const v = tags[key];
          if (v == null || v === '') { hit = false; break; }
          if (rule.when[key].indexOf('*') < 0 && rule.when[key].indexOf(String(v)) < 0) { hit = false; break; }
        }
      } else {
        hit = false;
      }
      if (hit && rule.where && !rule.where(tags)) hit = false;
      if (!hit) continue;
      best = rule;
      bestLayer = li;
    }
    return best;
  }
  const probeTags = [
    { highway: 'motorway' }, { highway: 'residential' }, { highway: 'footway' }, { highway: 'steps' },
    { highway: 'pedestrian', area: 'yes' }, { highway: 'track', surface: 'dirt' },
    { highway: 'primary', bridge: 'yes' }, { highway: 'primary', tunnel: 'yes' },
    { building: 'yes' }, { building: 'construction' }, { building: 'yes', amenity: 'toilets' },
    { 'building:part': 'yes' }, { natural: 'water' }, { natural: 'peak', ele: '2303' },
    { natural: 'wood' }, { landuse: 'forest' }, { landuse: 'reservoir' }, { leisure: 'park' },
    { leisure: 'pitch', sport: 'basketball' }, { leisure: 'swimming_pool' }, { waterway: 'river' },
    { waterway: 'riverbank' }, { railway: 'subway' }, { railway: 'station' }, { railway: 'platform' },
    { boundary: 'administrative' }, { boundary: 'administrative', admin_level: '2' },
    { boundary: 'administrative', admin_level: '11' }, { power: 'line' }, { power: 'substation' },
    { power: 'pole' }, { barrier: 'gate' }, { barrier: 'wall' }, { amenity: 'restaurant' },
    { amenity: 'parking' }, { amenity: 'school' }, { shop: 'mall' }, { shop: 'unknown_shop' },
    { tourism: 'museum' }, { office: 'government' }, { historic: 'castle' }, { emergency: 'fire_hydrant' },
    { healthcare: 'laboratory' }, { man_made: 'pipeline' }, { man_made: 'bridge' }, { aeroway: 'runway' },
    { aeroway: 'apron' }, { place: 'city' }, { route: 'ferry' }, { public_transport: 'platform' },
    { military: 'danger_area' }, { craft: 'brewery' }, { sport: 'soccer', leisure: 'pitch' },
    {}, { foo: 'bar' }, { highway: 'unknown_hw' }, { amenity: 'unknown_poi' },
  ];
  const mismatches = [];
  for (const tags of probeTags) {
    for (const kind of ['point', 'line', 'area']) {
      const fast = Style.ruleFor(tags, kind);
      const slow = bruteForce(tags, kind);
      const fastId = fast ? fast.id : null;
      const slowId = slow ? slow.id : null;
      if (fastId !== slowId) {
        mismatches.push(show(tags) + '/' + kind + ' 索引=' + fastId + ' 全表=' + slowId);
      }
    }
  }
  ok(mismatches.length === 0, 'ruleFor 的索引加速与全表扫描结果完全一致（' + probeTags.length + ' 组 × 3 种几何）',
    mismatches.slice(0, 5).join(' | '));

  // 可达性：每条「按具体标签值」定义的规则都必须能被真正命中
  // （防止高层图层的通配兜底规则把它盖掉，例如 natural=wood 被水系兜底盖成水色）
  const unreachable = [];
  let specificCount = 0;
  for (const rule of Style.RULES) {
    if (rule.where) continue; // 带 where 的规则（sport=*、admin_level 分档）单独测
    const keys = Object.keys(rule.when || {});
    if (keys.length !== 1) continue;
    const key = keys[0];
    const value = rule.when[key][0];
    if (value === '*') continue;
    specificCount++;
    const tags = {};
    tags[key] = value;
    let reached = false;
    for (const kind of rule.geo) {
      const got = Style.ruleFor(tags, kind);
      if (got && got.id === rule.id) { reached = true; break; }
    }
    if (!reached) unreachable.push(rule.id + ' ' + show(tags));
  }
  ok(unreachable.length === 0, specificCount + ' 条具体取值规则全部可达（没有被兜底规则盖掉）',
    unreachable.slice(0, 6).join(' | '));

  // 带 where 的规则：sport 配色与 admin_level 分档
  eq(Style.ruleFor({ leisure: 'pitch', sport: 'soccer' }, 'area').id, 'landuse:sport=soccer',
    'sport=soccer 的运动场命中专属配色规则');
  eq(Style.ruleFor({ leisure: 'pitch', sport: 'basketball' }, 'area').id, 'landuse:sport=basketball',
    'sport=basketball 的运动场命中专属配色规则');
  eq(Style.ruleFor({ leisure: 'pitch' }, 'area').id, 'landuse:leisure=pitch',
    '没有 sport 的运动场回落到通用 pitch 配色');
  eq(Style.ruleFor({ boundary: 'administrative', admin_level: '4' }, 'line').id,
    'boundary:boundary=administrative@3-4', 'admin_level=4 命中 3-4 档边界规则');
  eq(Style.ruleFor({ boundary: 'administrative', admin_level: '10' }, 'line').id,
    'boundary:boundary=administrative@9-10', 'admin_level=10 命中 9-10 档边界规则');
}

// ---------------------------------------------------------------------------
// 6. labelFor
// ---------------------------------------------------------------------------
section('labelFor');

{
  const cn = Style.labelFor({ name: '长安街' });
  eq(cn && cn.text, '长安街', "labelFor({name:'长安街'}).text === '长安街'");
  ok(!!(cn && cn.priority >= 1 && cn.priority <= 10), 'priority 在 1~10 之间', '实际 ' + (cn && cn.priority));

  const ref = Style.labelFor({ ref: 'G4' });
  eq(ref && ref.text, 'G4', "labelFor({ref:'G4'}).text === 'G4'");

  eq(Style.labelFor({}), null, 'labelFor({}) 返回 null');
  eq(Style.labelFor({ amenity: 'cafe' }), null, '没有 name 的普通要素返回 null');

  const peak = Style.labelFor({ natural: 'peak', name: '灵山', ele: '2303' });
  ok(!!(peak && String(peak.text).indexOf('2303') >= 0), "山峰标签包含高程 '2303'", '实际 ' + show(peak && peak.text));
  ok(!!(peak && String(peak.text).indexOf('灵山') >= 0), '山峰标签包含名字');

  const zh = Style.labelFor({ 'name:zh': '王府井' });
  eq(zh && zh.text, '王府井', "只有 name:zh 时也能取到中文名");
  eq(Style.labelFor({ name: 'X', 'name:zh': 'Y' }).text, 'X', 'name 优先于 name:zh');

  const house = Style.labelFor({ building: 'yes', 'addr:housenumber': '12' });
  eq(house && house.text, '12', '建筑可以用 addr:housenumber 作为标注');
  eq(Style.labelFor({ 'addr:housenumber': '12' }), null, '非建筑不画门牌号');

  const city = Style.labelFor({ place: 'city', name: '北京' });
  eq(city && city.priority, 10, 'place=city 的标注优先级最高（10）');
  const river = Style.labelFor({ waterway: 'river', name: '永定河' });
  ok(!!(river && river.priority >= 5), '水系名字优先级合理', '实际 ' + (river && river.priority));
  const motorway = Style.labelFor({ highway: 'motorway', name: '京藏高速' });
  const footway = Style.labelFor({ highway: 'footway', name: '小巷' });
  ok(motorway.priority > footway.priority, '高速公路标注优先级高于人行道');
}

// ---------------------------------------------------------------------------
// 7. categoryOf 与 CATEGORIES
// ---------------------------------------------------------------------------
section('分类');

{
  eq(Style.categoryOf({ highway: 'primary' }), 'road', "categoryOf({highway:'primary'}) === 'road'");
  eq(Style.categoryOf({ building: 'yes' }), 'building', "categoryOf({building:'yes'}) === 'building'");
  eq(Style.categoryOf({ natural: 'water' }), 'water', "categoryOf({natural:'water'}) === 'water'");
  eq(Style.categoryOf({ highway: 'footway' }), 'path', 'footway 归入步道分类');
  eq(Style.categoryOf({ highway: 'bus_stop' }), 'transport', '公交站归入公共交通分类');
  eq(Style.categoryOf({ railway: 'rail' }), 'railway', 'railway=rail 归入铁路分类');
  eq(Style.categoryOf({ railway: 'station' }), 'transport', '车站归入公共交通分类');
  eq(Style.categoryOf({ boundary: 'administrative' }), 'boundary', '边界分类');
  eq(Style.categoryOf({ power: 'line' }), 'power', '电力分类');
  eq(Style.categoryOf({ barrier: 'fence' }), 'barrier', '障碍分类');
  eq(Style.categoryOf({ amenity: 'restaurant' }), 'poi', '兴趣点分类');
  eq(Style.categoryOf({ landuse: 'forest' }), 'landuse', '用地分类');
  eq(Style.categoryOf({}), 'other', '无标签归入其它');

  const catIds = Style.CATEGORIES.map((c) => c.id);
  eq(new Set(catIds).size, Style.CATEGORIES.length, 'CATEGORIES 的 id 唯一');
  const badCat = Style.CATEGORIES.filter((c) =>
    typeof c.name !== 'string' || c.name.length === 0 || typeof c.defaultVisible !== 'boolean');
  ok(badCat.length === 0, '每个分类都有中文名与 defaultVisible 布尔值', badCat.map((c) => c.id).join(', '));

  // categoryOf 的结果必须落在 CATEGORIES 里；用规则表反推所有标签组合
  const unknown = [];
  const seen = new Set();
  for (const rule of Style.RULES) {
    const key = Object.keys(rule.when || {})[0];
    if (!key) continue;
    const value = (rule.when[key] || [])[0];
    if (!value || value === '*') continue;
    const tags = {};
    tags[key] = value;
    for (const kind of ['point', 'line', 'area']) {
      const cat = Style.categoryOf(tags, kind);
      if (catIds.indexOf(cat) < 0) unknown.push(show(tags) + ' → ' + cat);
      seen.add(cat);
    }
  }
  ok(unknown.length === 0, 'categoryOf 的返回值都在 CATEGORIES 中', unknown.slice(0, 5).join('; '));
  ok(seen.size >= 8, '规则覆盖到的分类数量合理', '实际 ' + seen.size + ' 类');

  for (const need of ['building', 'landuse', 'natural', 'amenity', 'waterway', 'boundary', 'area', 'shop', 'tourism', 'power', 'aeroway', 'public_transport']) {
    ok(Style.areaKeys.indexOf(need) >= 0, "areaKeys 包含 '" + need + "'");
  }
}

// ---------------------------------------------------------------------------
// 8. 预设表
// ---------------------------------------------------------------------------
section('预设表');

{
  const items = Presets.all();
  ok(Presets.categories.length >= 5, '预设分类数量 >= 5', '实际 ' + Presets.categories.length);
  ok(items.length >= 110, '预设条目总数 >= 110', '实际 ' + items.length);

  const problems = [];
  const ids = new Set();
  const dup = [];
  const tagObjects = new Set();
  let sharedTags = 0;
  const VALID_KINDS = ['point', 'line', 'area'];
  const catIds = new Set(Presets.categories.map((c) => c.id));

  for (const cat of Presets.categories) {
    if (!cat.id || !cat.name || !cat.icon) problems.push('分类缺少 id/name/icon');
    if (!Array.isArray(cat.items) || cat.items.length === 0) problems.push('分类 ' + cat.id + ' 没有条目');
  }

  for (const item of items) {
    const at = item.id || '(无 id)';
    if (!item.id || !item.name || !item.icon) problems.push(at + ': 缺少 id/name/icon');
    if (VALID_KINDS.indexOf(item.kind) < 0) problems.push(at + ': kind 非法 ' + item.kind);
    if (!item.tags || typeof item.tags !== 'object' || Array.isArray(item.tags)) problems.push(at + ': tags 不是对象');
    else {
      const keys = Object.keys(item.tags);
      if (keys.length === 0) problems.push(at + ': tags 为空');
      for (const k of keys) {
        if (typeof item.tags[k] !== 'string' || item.tags[k].length === 0) problems.push(at + ': 标签 ' + k + ' 的值非法');
      }
    }
    if (!catIds.has(item.category)) problems.push(at + ': 分类 id 未知 ' + item.category);
    if (ids.has(item.id)) dup.push(item.id);
    ids.add(item.id);
    if (tagObjects.has(item.tags)) sharedTags++;
    tagObjects.add(item.tags);
  }
  ok(problems.length === 0, '每个预设都有 id/name/kind/tags/icon，标签值均为非空字符串',
    problems.length + ' 处问题：' + problems.slice(0, 6).join(' | '));
  ok(dup.length === 0, '预设 id 全局唯一', dup.slice(0, 5).join(', '));
  eq(sharedTags, 0, '不同预设不共享同一个 tags 对象（可安全改标签）');

  const byId = Presets.byId('road-motorway');
  ok(!!byId && byId.name === '高速公路', "byId('road-motorway') 能查到高速公路");
  eq(Presets.byId('不存在的 id'), null, 'byId 查不到时返回 null');
  ok(Presets.byId('poi-restaurant').tags.amenity === 'restaurant', '预设标签是真实 OSM 标签（餐厅 amenity=restaurant）');

  const hits = Presets.search('餐厅');
  ok(hits.length >= 1 && hits.some((i) => i.name === '餐厅'), "search('餐厅') 能找到餐厅",
    '实际 ' + hits.map((i) => i.name).slice(0, 5).join(', '));
  ok(Presets.search('').length === items.length, 'search(\'\') 返回全部条目');
  ok(Presets.search('restaurant').length >= 1, "search('restaurant') 也能按标签值命中");
  ok(Presets.search('不存在的关键词').length === 0, '搜不到时返回空数组');

  // 每个预设都必须能被样式表画出来（否则就是漏画）
  const unmatched = [];
  for (const item of items) {
    const style = Style.ruleFor(item.tags, item.kind);
    if (!style) unmatched.push(item.id + ' ' + show(item.tags) + '/' + item.kind);
    else if (LAYERS.indexOf(style.layer) < 0) unmatched.push(item.id + ' → 非法图层 ' + style.layer);
  }
  ok(unmatched.length === 0, '每个预设都能被样式表命中（不会出现新建后看不见）',
    unmatched.slice(0, 6).join(' | '));

  // 预设里出现的标签 key 必须是「样式表认识的 key」或已知修饰 key
  const ruleKeys = new Set();
  for (const rule of Style.RULES) for (const k in (rule.when || {})) ruleKeys.add(k);
  const MODIFIER_KEYS = new Set([
    'oneway', 'station', 'sport', 'surface', 'lanes', 'maxspeed', 'bridge', 'tunnel', 'layer',
    'area', 'building:levels', 'height', 'min_height', 'ele', 'name', 'name:zh', 'ref',
    'addr:housenumber', 'religion', 'denomination', 'cuisine', 'opening_hours', 'operator',
    'brand', 'wheelchair', 'access', 'fee', 'capacity', 'width', 'description', 'note',
    'source', 'backrest', 'drinking_water', 'shelter', 'vending', 'emergency',
    'fire_hydrant:type', 'recycling_type', 'direction', 'colour', 'material', 'covered',
  ]);
  const unknownKeys = new Set();
  for (const item of items) {
    for (const k in item.tags) {
      if (!ruleKeys.has(k) && !MODIFIER_KEYS.has(k)) unknownKeys.add(k);
    }
  }
  ok(unknownKeys.size === 0, '预设标签 key 都被样式表或修饰键覆盖（无拼写错误）',
    Array.from(unknownKeys).join(', '));
}

// ---------------------------------------------------------------------------
// 9. 统计
// ---------------------------------------------------------------------------
section('统计');

{
  const ruleKeys = new Set();
  for (const rule of Style.RULES) for (const k in (rule.when || {})) ruleKeys.add(k);
  const layerUse = {};
  for (const rule of Style.RULES) layerUse[rule.layer] = (layerUse[rule.layer] || 0) + 1;
  const presetKinds = { point: 0, line: 0, area: 0 };
  for (const item of Presets.all()) presetKinds[item.kind]++;

  console.log('样式规则条数　　：' + Style.RULES.length);
  console.log('覆盖标签 key 数　：' + ruleKeys.size);
  console.log('标签 key 清单　　：' + Array.from(ruleKeys).sort().join(', '));
  console.log('各图层规则数　　：' + Object.keys(layerUse).map((k) => k + '=' + layerUse[k]).join('  '));
  console.log('预设条目数　　　：' + Presets.all().length +
    '（点 ' + presetKinds.point + ' / 线 ' + presetKinds.line + ' / 面 ' + presetKinds.area + '）');
  console.log('预设分类数　　　：' + Presets.categories.length +
    '（' + Presets.categories.map((c) => c.name + ':' + c.items.length).join('，') + '）');
  console.log('图层分类数　　　：' + Style.CATEGORIES.length);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log('通过 ' + passCount + ' 条，失败 ' + failCount + ' 条');
if (failCount > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  · ' + f);
  console.log('='.repeat(64));
  process.exit(1);
}
console.log('全部通过 ✅');
console.log('='.repeat(64));
