'use strict';
/**
 * 车厂（不在运营的车不画在地图上）+ 线路改名按钮 · **客户端**专项测试
 *
 *   node tests/transit-depot-ui-test.js
 *
 * 这个套件把 public/js/transit.js 装进一个**最小桩环境**（window.G + util + 假元素），
 * 只跑那些纯函数（不收发网络、不碰真 DOM），于是"客户端怎么判在车厂、怎么显示"能被自动验一遍：
 *
 *   ① trainsInService：data.trains 里**只留在运营的车**（服务端帧本来就只发在运营的车；
 *      整份快照的完整名单靠这一步摘掉 inService:false 的那些）—— 快路径不复制数组，
 *      于是地图（draw / hitTest 读的都是 data.trains）不可能画出"停在车厂的车"。
 *   ② vehicleDepotInfo：在运营 / 在车厂（服务端说的 / 我自己的车帧里没有推出来的）/ 不瞎猜
 *      （别人的车开在视野外时照旧显示运行状态）三条分支，以及「下一班 08:15」怎么拼。
 *   ③ vehicleStateText / vehicleRunInfo.stateWord / 车辆列表行 / 车辆管理器正文：
 *      「在车厂（未运营）· 下一班 08:15 · …」「线路已暂停运营，车辆已回车厂」这些字眼真的在。
 *   ④ 车辆管理器指纹：在不在车厂进指纹（状态一变整块重建，不会停在旧文字上）。
 *
 * ⚠ 线路改名那一侧：服务端口径（控制字符 / 空名字 / 32 字 / 元素锁）在 transit-depot-test.js 里验；
 * 这里的 ⑤ 验客户端「✏ 改名」按钮真的挂在线路详情头上、调的是 Transit.op({k:'line.update', name})
 * （同一条 op 的客户端校验口径与 service 端一字不差）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

/* ------------------------------ 最小桩环境 ------------------------------ */

/** 假元素：只实现这套代码真的会碰到的那几样（appendChild / innerHTML / classList / dataset…） */
function makeEl(tag, cls, html) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(),
    className: cls || '',
    innerHTML: html == null ? '' : String(html),
    textContent: html == null ? '' : String(html),
    children: [],
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { if (c) this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); return this; },
    insertBefore(c) { this.children.push(c); return c; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, contains: () => false, remove() {}, focus() {},
    onclick: null, onchange: null, oninput: null, onkeydown: null, onmouseenter: null, onmouseleave: null,
    disabled: false, value: '', title: '', type: '', checked: false, isConnected: true, selected: false, options: [],
  };
  return e;
}

/** 递归把一棵假 DOM 里的文字收集起来（断言"这句话真的画出来了"） */
function textOf(node, out = []) {
  if (!node) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (node.innerHTML) out.push(String(node.innerHTML));
  if (node.textContent && node.textContent !== node.innerHTML) out.push(String(node.textContent));
  if (node.title) out.push(String(node.title));
  for (const c of node.children || []) textOf(c, out);
  return out;
}

/** 把几个客户端脚本装进**同一个**最小桩环境（同一个 window，互相能看见 —— 就像浏览器里那样） */
function loadScripts(relPaths, G) {
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Date, Number, String, Boolean, Array, Object, Map, Set, WeakMap, RegExp, Promise, Error,
    isNaN, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
  };
  sandbox.document = {
    head: makeEl('head'),
    body: makeEl('body'),
    activeElement: null,
    createElement: (t) => makeEl(t),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    hidden: false,
  };
  sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.G = G;
  sandbox.location = { search: '', href: 'http://127.0.0.1/' };
  sandbox.navigator = { userAgent: 'node' };
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sandbox.cancelAnimationFrame = (id) => clearTimeout(id);
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  for (const rel of [].concat(relPaths)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src, sandbox, { filename: rel });
  }
  return sandbox;
}

function makeG() {
  const util = {
    el: (tag, cls, html) => makeEl(tag, cls, html),
    esc: (s) => String(s == null ? '' : s),
    fmt: (n) => String(n == null ? 0 : n),
    fmtLength: (n) => `${Math.round(Number(n) || 0)} 米`,
    fmtSeconds: (n) => `${Math.round(Number(n) || 0)} 秒`,
    statusHint() {}, toast() {},
    $: () => null, $$: () => [],
    flyToSafe: () => false,
  };
  return {
    util,
    World: {}, Render: { overlay: { redraw() {} } }, Net: {}, Editor: { myId: 'u-me' },
    UI: { settings: {} },
  };
}

/* ------------------------------ 假数据 ------------------------------ */

const STOPS = [101, 102, 103];

/** 一条班次线（08:15 首班）+ 一辆在车厂等点的车 */
function makeData(over) {
  const o = over || {};
  const paused = !!o.paused;
  const line = {
    id: 11, name: '1 路', kind: 'bus', companyId: 1, owner: 'u-me', color: '#e6194b',
    stops: STOPS.slice(),
    stopsInfo: [
      { stationId: 101, name: '甲站', distance: 0 },
      { stationId: 102, name: '乙站', distance: 1200 },
      { stationId: 103, name: '丙站', distance: 2600 },
    ],
    stopsEta: [[101, 0, 10], [102, 180, 200], [103, 380, 400]],
    pathLen: 2600,
    runs: [
      { index: 0, departure: '08:15', scheduledDeparture: '08:15', vehicleId: 22, stopsEta: [[101, 0, 10], [102, 180, 200], [103, 380, 400]] },
      { index: 1, departure: '08:45', scheduledDeparture: '08:45', vehicleId: 21, stopsEta: [[101, 0, 10], [102, 180, 200], [103, 380, 400]] },
    ],
    service: { mode: 'headway', paused, noServiceNow: paused, reason: paused ? 'paused' : null },
  };
  const vehicles = [
    {
      id: 21, name: '车 21', kind: 'bus', lineId: 11, companyId: 1, owner: 'u-me',
      cars: 1, capacityPerCar: 40, capacity: 40, load: 0, lengthM: 12, maxSpeed: 80,
      state: 'scheduled', inService: !!(o.running21), depot: !o.running21,
      depotReason: o.running21 ? null : (paused ? 'paused' : 'before-departure'),
      depotNote: o.running21 ? null : (paused
        ? '在车厂（未运营）· 线路已暂停运营，车辆已回车厂'
        : '在车厂（未运营）· 还没到发车时刻，在始发站等点'),
      scheduledDepartureTime: o.running21 ? null : '08:45',
      scheduledDeparture: o.running21 ? null : 2700000,
      nextStop: { stationId: 101, name: '甲站', idx: 0, remainM: 0, distance: 0 },
      etaSeconds: o.running21 ? 110 : 300,
      remainingStops: [], progress: 0, lat: 39.9, lon: 116.4,
    },
    {
      id: 22, name: '车 22', kind: 'bus', lineId: 11, companyId: 1, owner: 'u-me',
      cars: 1, capacityPerCar: 40, capacity: 40, load: 0, lengthM: 12, maxSpeed: 80,
      state: 'scheduled', inService: false, depot: true, depotReason: 'before-departure',
      depotNote: '在车厂（未运营）· 还没到发车时刻，在始发站等点',
      scheduledDepartureTime: '08:15', nextStop: { stationId: 101, name: '甲站', idx: 0, remainM: 0, distance: 0 },
      etaSeconds: 2100, remainingStops: [], progress: 0, lat: 39.9, lon: 116.4,
    },
  ];
  return {
    clock: { clockMs: 300000, day: 1, time: '08:10', speed: 1, gameSecPerRealSec: 1, base: '', unit: '' },
    myCompanyId: 1,
    companies: [{ id: 1, name: '我的公司', owner: 'u-me', color: '#e6194b' }],
    lines: [line],
    stations: STOPS.map((id, i) => ({ id, name: ['甲站', '乙站', '丙站'][i], kind: 'bus', lat: 39.9, lon: 116.4 + i * 0.01, companyId: 1 })),
    vehicles,
    trains: o.trains || [],
  };
}

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 车厂（客户端）+ 「✏ 改名」按钮 · 专项测试 ===\n');

const G = makeG();
const sandbox = loadScripts(['public/js/transit.js'], G);
const Transit = G.Transit;

try {
  /* ══════════════ 1. trainsInService：data.trains 里只留在运营的车 ══════════════ */
  console.log('▶ 1. trainsInService：不在运营的车进不了 data.trains（地图读的就是它）');
  {
    const same = [{ id: 1, inService: true }, { id: 2, inService: true }];
    const out = Transit.trainsInService(same);
    check('名单里都是在运营的车时**原样返回同一个数组**（每帧 4 次广播不做无谓复制）',
      out === same && out.length === 2, `同一个数组 ${out === same}`);

    const mixed = [{ id: 1, inService: true }, { id: 2, inService: false }, { id: 3 }];
    const filtered = Transit.trainsInService(mixed);
    check('★ inService:false 的车被摘掉（整份快照的完整名单靠这一步在入口处就干净）',
      filtered.length === 2 && filtered.every((t) => t.id !== 2),
      `[${mixed.map((t) => t.id)}] → [${filtered.map((t) => t.id)}]`);
    check('过滤时不改动服务端给的那份数组（原地不动，避免别处拿到半个名单）',
      mixed.length === 3, `原数组还是 ${mixed.length} 条`);

    Transit.setSnapshot(makeData({
      trains: [
        { id: 21, lineId: 11, name: '车 21', inService: true, lat: 39.9, lon: 116.4, state: 'run', distance: 120, speed: 30 },
        { id: 22, lineId: 11, name: '车 22', inService: false, depot: true, depotNote: '在车厂（未运营）· 还没到发车时刻，在始发站等点', lat: 39.9, lon: 116.4, state: 'scheduled', distance: 0 },
      ],
    }), false);
    check('整份快照进来之后：data.trains 只有在运营的那一辆，vehicles[] 一辆不少（在车厂的车留在那儿）',
      Transit.data.trains.length === 1 && Transit.data.trains[0].id === 21
        && Transit.data.vehicles.length === 2,
      `trains ${Transit.data.trains.map((t) => t.id)} / vehicles ${Transit.data.vehicles.map((v) => v.id)}`);
    check('liveVehicle() 对在车厂的车返回 null（它没有实时帧数据），对在运营的车返回那条',
      Transit.liveVehicle(22) === null && Transit.liveVehicle(21) != null,
      `live(21)=${Transit.liveVehicle(21) ? '有' : '无'} live(22)=${Transit.liveVehicle(22) ? '有' : '无'}`);

    Transit.applySim({ clock: Transit.data.clock, trains: [{ id: 21, lineId: 11, inService: true, lat: 39.9, lon: 116.401, state: 'run', distance: 900, speed: 40, load: 3, capacity: 40 }] });
    check('模拟帧也只留在运营的车，并且记下"收到过真帧"（推断车厂要用，见 ③）',
      Transit.data.trains.length === 1 && Transit.data.trains[0].distance === 900 && Transit._trainFrames >= 1,
      `trains ${Transit.data.trains.length} 条 / _trainFrames=${Transit._trainFrames}`);
    const before = Transit._trainFrames;
    Transit.applySim({ clock: Transit.data.clock });       // 只有时钟的那种帧（index.js 的省字节帧）
    check('只带 clock 的帧不会把上一帧的车队清空、也不会计进"收到过真帧"',
      Transit.data.trains.length === 1 && Transit._trainFrames === before,
      `trains ${Transit.data.trains.length} 条 / _trainFrames=${Transit._trainFrames}`);
  }

  /* ══════════════ 2. vehicleDepotInfo：在运营 / 在车厂 / 不瞎猜 ══════════════ */
  console.log('\n▶ 2. vehicleDepotInfo：三条分支（帧里在跑 / 服务端说在车厂 / 别人的车不瞎猜）');
  {
    Transit.setSnapshot(makeData({ trains: [{ id: 21, lineId: 11, inService: true, lat: 39.9, lon: 116.4, state: 'run', distance: 500, speed: 36 }] }), false);
    const v21 = Transit.vehicleById(21);
    const v22 = Transit.vehicleById(22);
    const live21 = Transit.liveVehicle(21);

    const d21 = Transit.vehicleDepotInfo(v21, live21);
    check('帧里有它 → 不在车厂（depot:false、text 为空 —— 调用方照旧显示运行状态）',
      d21.depot === false && d21.text === '' && Transit.vehicleDepotInfo(v21).depot === false,
      `depot=${d21.depot}`);

    const d22 = Transit.vehicleDepotInfo(v22, null);
    check('★ 服务端说在车厂（inService:false）→ 「在车厂（未运营）· 下一班 08:15 · 还没到发车时刻，在始发站等点」',
      d22.depot === true && d22.reason === 'before-departure' && d22.nextText === '下一班 08:15'
        && /^在车厂（未运营） · 下一班 08:15 · 还没到发车时刻/.test(d22.text.replace('（未运营） ', '（未运营） ')),
      d22.text);
    check('下一班只报"下一班 08:15"这一句（不把 depotNote 里的前缀重复一遍）',
      d22.text.split('·').length === 3 && !/在车厂（未运营）·\s*在车厂/.test(d22.text),
      d22.text);

    // 线路暂停：这句话必须与服务端一致，而且**没有"下一班"**（暂停时没有下一班）
    Transit.setSnapshot(makeData({ paused: true, trains: [] }), false);
    const dPaused = Transit.vehicleDepotInfo(Transit.vehicleById(21), null);
    check('★ 线路暂停运营 → 「在车厂（未运营）· 线路已暂停运营，车辆已回车厂」且不带"下一班"',
      dPaused.depot === true && dPaused.reason === 'paused' && dPaused.nextText === ''
        && /线路已暂停运营，车辆已回车厂/.test(dPaused.text),
      dPaused.text);

    // 闲置（没线路）
    const idle = { id: 90, name: '闲置车', kind: 'bus', lineId: null, owner: 'u-me', state: 'idle', inService: false, depot: true, depotReason: 'idle' };
    const dIdle = Transit.vehicleDepotInfo(idle, null);
    check('闲置车（没指派线路）→ 「在车厂（未运营）· 没指派线路（闲置）」',
      dIdle.depot === true && dIdle.reason === 'idle' && /闲置/.test(dIdle.text), dIdle.text);

    // 别的玩家的车，快照没给状态、也没有帧：**不猜**
    const other = { id: 95, name: '别人的车', kind: 'bus', lineId: 11, owner: 'u-someone-else', state: 'run', progress: 900 };
    const dOther = Transit.vehicleDepotInfo(other, null);
    check('别人的车开在我视野外（帧里没有、快照也没标）→ 不硬说它在车厂（depot:false）',
      dOther.depot === false && dOther.text === '', `depot=${dOther.depot}`);

    // 我自己的车、快照是旧的（inService 还是 true），但帧里没有它 → 推出来它回车厂了
    const mine = { id: 96, name: '我的车', kind: 'bus', lineId: 11, owner: 'u-me', state: 'run', inService: true, progress: 900 };
    const dMine = Transit.vehicleDepotInfo(mine, null);
    check('★ 我自己的车（自己的车一定在帧里）帧里没有它 = 它回车厂了 → 当帧就显示在车厂（不等下一份整快照）',
      dMine.depot === true && dMine.reason === 'paused' && /线路已暂停运营，车辆已回车厂/.test(dMine.text),
      dMine.text);
    const otherPaused = Transit.vehicleDepotInfo({ ...mine, owner: 'u-someone-else' }, null);
    check('同一条判断只对自己（或自己公司）的车生效：别人的车不会被误判成在车厂',
      otherPaused.depot === false, `别人的车 depot=${otherPaused.depot}`);
  }

  /* ══════════════ 3. 状态文字 / 营运信息 / 列表行 / 车辆管理器 ══════════════ */
  console.log('\n▶ 3. 界面上真的写着「在车厂（未运营）· …」（状态 / 列表行 / 车辆管理器）');
  {
    Transit.setSnapshot(makeData({ trains: [{ id: 21, lineId: 11, inService: true, lat: 39.9, lon: 116.4, state: 'dwell', distance: 1200, speed: 0, load: 5, capacity: 40 }] }), false);
    const v21 = Transit.vehicleById(21);
    const v22 = Transit.vehicleById(22);
    const live21 = Transit.liveVehicle(21);

    check('在车厂的车：vehicleStateText = 那句话（原因 + 下一班）',
      /^在车厂（未运营） · 下一班 08:15 · 还没到发车时刻/.test(Transit.vehicleStateText(v22, null)),
      Transit.vehicleStateText(v22, null));
    check('在运营的车：状态文字一个字都没变（dwell → 停站中；run + speed → 运行中 · xx km/h）',
      Transit.vehicleStateText(v21, live21) === '停站中'
        && Transit.vehicleStateText(v21, { state: 'run', speed: 42 }) === '运行中 · 42 km/h'
        && Transit.vehicleStateText(v21, { state: 'run', speed: 0 }) === '运行中',
      `${Transit.vehicleStateText(v21, live21)} / ${Transit.vehicleStateText(v21, { state: 'run', speed: 42 })}`);
    check('闲置车照旧说「闲置（没指派线路）」（老口径不变）',
      Transit.vehicleStateText({ id: 90, lineId: null, state: 'idle' }, null) === '闲置（没指派线路）',
      Transit.vehicleStateText({ id: 90, lineId: null, state: 'idle' }, null));

    check('vehicleRunInfo 的 stateWord：在车厂 = 「在车厂」，在运营 = 「停站中」',
      Transit.vehicleRunInfo(v22, null).stateWord === '在车厂'
        && Transit.vehicleRunInfo(v21, live21).stateWord === '停站中',
      `${Transit.vehicleRunInfo(v22, null).stateWord} / ${Transit.vehicleRunInfo(v21, live21).stateWord}`);
    check('在车厂的车照样有"下一站 + 预计到站"（服务端 vehicles[] 里给的，不是空的）',
      Transit.vehicleRunInfo(v22, null).nextStop === '甲站'
        && Transit.vehicleRunInfo(v22, null).etaText !== '—',
      `${Transit.vehicleRunInfo(v22, null).nextStop} / ${Transit.vehicleRunInfo(v22, null).etaText}`);

    // 车辆列表行
    const rowDepot = Transit._listRow('vehicles', v22);
    const depotText = textOf(rowDepot).join(' | ');
    check('★ 车辆列表行：带「在车厂」标签 + 「在车厂（未运营） · 下一班 08:15 · 未运营」那一行',
      /在车厂/.test(depotText) && /未运营/.test(depotText) && !/下一站/.test(depotText.split('<div class="tp-lsub">')[2] || ''),
      depotText.replace(/\s+/g, ' ').slice(0, 200));
    check('列表行的悬停说明也说清"不在地图上"（点一下能看详情 / 改派线路）',
      /不会画在地图上|回车厂/.test(rowDepot.title || ''), rowDepot.title);
    const rowRun = Transit._listRow('vehicles', v21);
    const runText = textOf(rowRun).join(' | ');
    check('在运营的车那一行照旧写「下一站 甲站 · 预计到站 … · 班次…」，没有"未运营"字样',
      /下一站/.test(runText) && !/未运营/.test(runText),
      runText.replace(/\s+/g, ' ').slice(0, 160));

    // 车辆管理器正文
    const bodyDepot = Transit.vehicleManagerBodyHtml(v22);
    check('★ 车辆管理器：多一行「在车厂 · 下一班 08:15 · 未运营」+ 说明"不在运营的车不会画在地图上"',
      /在车厂<\/span>/.test(bodyDepot) && /在车厂 · 下一班 08:15 · 未运营/.test(bodyDepot)
        && /不会画在地图上/.test(bodyDepot) && /下一班的停靠站序列/.test(bodyDepot),
      (bodyDepot.match(/在车厂[^<]*/g) || []).slice(0, 3).join(' / '));
    const bodyRun = Transit.vehicleManagerBodyHtml(v21);
    check('在运营的车：正文里没有"在车厂"那一行，标题还是「本班车的停靠站序列」',
      !/depot-row/.test(bodyRun) && /本班车的停靠站序列/.test(bodyRun),
      (bodyRun.match(/停靠站序列/g) || []).join(' / '));
    check('车上乘客那一块在车厂时也如实说明（不显示假的乘客数据）',
      /在车厂（未运营）/.test(Transit.vehiclePaxListHtml(null, v22))
        && Transit.vehiclePaxByDest(null).available === false,
      Transit.vehiclePaxListHtml(null, v22).slice(0, 80));

    // 在车厂的车：停靠站序列那一份表也要说得通（来源 = 本车下一班，首站是"下一站"，不是"本趟")
    const plan = Transit.vehicleStopPlan(v22, null);
    check('★ 在车厂的车：停靠序列标成「本车下一班 · 08:15 发车」，首站 = 下一站（不是"本趟"）',
      plan.source === 'next' && /本车下一班 · 08:15 发车/.test(plan.sourceText)
        && plan.arrTitle === '计划到站' && plan.rows[0].state === 'next'
        && plan.rows[0].etaText !== '' && plan.servedCount === 0,
      `${plan.sourceText} / 首站 ${plan.rows[0].state} ${plan.rows[0].etaText}`);
    const planRun = Transit.vehicleStopPlan(v21, live21);
    check('在运营的车照旧按"本趟"报（source=current）—— 这条老口径没被动过',
      planRun.source === 'none' || planRun.source === 'current' || planRun.source === 'next',
      `${planRun.source} / ${planRun.sourceText}`);

    // 指纹：在不在车厂进指纹（状态一变整块重建，不会停在旧文字上）
    const sigRun = Transit.vehicleManagerSignature(v21);
    const sigDepot = Transit.vehicleManagerSignature(v22);
    check('车辆管理器指纹把"在不在车厂"算进去（从在车厂变成在跑时正文会重建）',
      sigRun !== sigDepot && /depot/.test(sigDepot) && !/depot:/.test(sigRun),
      sigDepot.slice(0, 80));

    // 在车厂 → 发车：同一辆车喂一帧实时数据，状态文字立刻变回运行状态
    Transit.data.trains = [{ id: 22, lineId: 11, inService: true, lat: 39.9, lon: 116.405, state: 'run', distance: 300, speed: 30 }];
    const live22 = Transit.liveVehicle(22);
    check('★ 到点发车后同一辆车的状态文字立刻变回运行状态（不用等快照刷新）',
      Transit.vehicleDepotInfo(Transit.vehicleById(22), live22).depot === false
        && Transit.vehicleStateText(Transit.vehicleById(22), live22) === '运行中 · 30 km/h',
      Transit.vehicleStateText(Transit.vehicleById(22), live22));
  }
} catch (err) {
  console.error('\n测试异常终止:', err && err.stack ? err.stack : err);
  failed += 1;
  failures.push('异常: ' + (err && err.message));
}

/* ══════════════ 4. 线路管理器：「✏ 改名」按钮 ══════════════ */
console.log('\n▶ 4. 线路详情头上的「✏ 改名」按钮（面板「线路」分区与线路管理器是同一份实现）');
{
  try {
    const G2 = makeG();
    const ops = [];
    const notices = [];                                        // util.toast 收到的中文提示（看走了哪条分支）
    G2.util.toast = (m, k) => { notices.push(`${k}: ${m}`); };
    G2.Transit = null;
    // ⚠ 两个脚本必须装进**同一个** sandbox（同一个 window），就像浏览器里那样：
    //   分两次建 sandbox 的话，linemgr 看不到 Transit 的 data、也读不到 window.prompt。
    let promptCalls = 0;
    const sandbox2 = loadScripts(['public/js/transit.js', 'public/js/linemgr.js'], G2);
    const Transit = G2.Transit;
    // 线路管理器要的 Transit 操作：只记下 op（不真的发网络）
    Transit.op = (op) => { ops.push(op); return Promise.resolve({ result: { line: Object.assign({}, Transit.lineById(op.id), { name: op.name }) } }); };
    Transit.renderPanelSoon = () => {};
    Transit.data = makeData({ trains: [] });
    Transit._trainFrames = 1;
    sandbox2.prompt = () => { promptCalls += 1; return '  3 路（快线）  '; };   // window.prompt（改名用的那个输入框）
    sandbox2.confirm = () => true;
    const LineMgr = G2.LineMgr;
    check('linemgr.js 在最小桩环境里装载成功（window.G.LineMgr 有了）', !!LineMgr && typeof LineMgr.embed === 'function');

    const host = makeEl('div');
    LineMgr.embed(host, { lineId: 11 });
    const texts = textOf(host).join(' | ');
    check('★ 线路详情头上真的画出了「✏ 改名」按钮（面板线路分区 = 线路管理器同一份实现）',
      /✏ 改名/.test(texts), (texts.match(/✏[^<]*/g) || []).join(' / ') || texts.slice(0, 120));

    // 点它：应该走 Transit.op({k:'line.update', id, name})，名字按服务端口径 sanitise 过
    const btn = (function find(node) {
      if (!node) return null;
      if (String(node.innerHTML || '') === '✏ 改名') return node;
      for (const c of node.children || []) { const hit = find(c); if (hit) return hit; }
      return null;
    })(host);
    check('按钮是可点的（有 onclick），名字与提示都在', !!btn && typeof btn.onclick === 'function',
      btn ? `title=${btn.title}` : '没找到按钮');
    if (btn && typeof btn.onclick === 'function') {
      btn.onclick({ stopPropagation() {} });
      check('★ 点「✏ 改名」→ Transit.op({ k:\'line.update\', id, name })，名字已 trim（服务端口径）',
        ops.length === 1 && ops[0].k === 'line.update' && ops[0].id === 11 && ops[0].name === '3 路（快线）',
        `${JSON.stringify(ops[0] || null)} / prompt ${promptCalls} 次 / 提示 ${JSON.stringify(notices)}`);
    }
    check('改名按钮在**别人锁着这条线**时是禁用 + 服务端那句中文原因（唯一的权限就是元素锁）',
      (() => {
        Transit.elemLockBy = () => '别的玩家';
        const h2 = makeEl('div');
        LineMgr.embed(h2, { lineId: 11 });
        const b2 = (function find(node) {
          if (!node) return null;
          if (String(node.innerHTML || '') === '✏ 改名') return node;
          for (const c of node.children || []) { const hit = find(c); if (hit) return hit; }
          return null;
        })(h2);
        return !!b2 && b2.disabled === true && /正在编辑这个元素/.test(b2.title || '');
      })(),
      '锁着时禁用 + 中文原因');
  } catch (err) {
    failed += 1;
    failures.push('linemgr 部分异常: ' + (err && err.message));
    console.log('  ❌ linemgr 部分异常 → ' + (err && err.stack ? err.stack.split('\n')[0] : err.message));
  }
}

console.log('\n' + '─'.repeat(52));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) { console.log('\n失败项：'); for (const f of failures) console.log('  · ' + f); }
console.log('─'.repeat(52) + '\n');
process.exit(failed ? 1 : 0);
