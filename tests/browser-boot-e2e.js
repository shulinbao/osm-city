'use strict';
/**
 * 启动健壮性测试：浏览器里残留的历史数据（尤其是旧版本格式）不能让页面卡死。
 *
 * 背景：上一版（游戏版）把视角存成 {lat, lng, zoom}，新版读的是 saved.lon，
 * 于是 L.map({center:[lat, undefined]}) 抛 "Invalid LatLng object"，初始化整体失败、
 * 连登录框都出不来。这个测试用那批真实数据逐条覆盖。
 *
 * 前置：**不需要**手动启动服务器。不设 BASE 时本套件自己拉起一台测试服务器
 * （端口 E2E_PORT，默认 8912）并加 `--allow-guests`：正式 config.json 里 allowGuests=false
 * （玩家必须注册/登录），而本套件第 4、6 节全程用 `?guest=1` 免注册登录。
 * 临时游客账号写在 tests/tmp-browser-boot/（`--data`），不污染正式的 data/users.json。
 * 设了 BASE 就指向那台、不再自启（那台必须允许游客）。
 *
 *   node tests/browser-boot-e2e.js
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
/** 没给 BASE 就自己起一台（见上面说明）；给了就完全按老行为用那台 */
const OWN_SERVER = !process.env.BASE;
const PORT = Number(process.env.E2E_PORT || 8912);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT || 9225);
const PROFILE = path.join(__dirname, 'edge-profile-boot');
/** 账号写在临时目录里：本套件的临时游客/账号不该进正式 data/users.json
 *（数据集仍走 config.json 的 osmDb，默认 data/osm/osm.sqlite） */
const DATA_DIR = path.join(__dirname, 'tmp-browser-boot');

/** 本套件自己的测试服务器：游客通道打开（--allow-guests），端口与 8787 那台不冲突 */
function startServer() {
  return spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--data', DATA_DIR, '--allow-guests'],
    { cwd: ROOT, stdio: 'ignore' });
}

/** 等这台服务器**初始化完**（/api/health 在初始化期间是 503，见 server/index.js 的初始化闸门） */
async function waitReady(timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('测试服务器启动/初始化超时：' + BASE);
    await sleep(500);
  }
}

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('没有找到 Edge/Chrome');
}

async function waitCDP(timeoutMs = 25000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('等待 CDP 端口超时');
    await sleep(300);
  }
}

function cdp(wsUrl, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method && onEvent) {
        try { onEvent(msg); } catch { /* 事件处理出错不影响测试 */ }
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}, timeoutMs = 30000) {
          const id = ++seq;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
              if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); }
            }, timeoutMs);
          });
        },
        close() { try { ws.close(); } catch { /* ignore */ } },
      });
    });
  });
}

async function evaluate(client, expression, timeoutMs = 60000) {
  const res = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (res.exceptionDetails) {
    const e = res.exceptionDetails;
    throw new Error('页面脚本异常: ' + (e.exception && e.exception.description ? e.exception.description.split('\n')[0] : e.text));
  }
  return res.result.value;
}

/** 页面健康状态：能否初始化、登录框是否可用、有没有报错 */
const PROBE = `(() => {
  const errBox = document.querySelector('#client-errors');
  const login = document.querySelector('#login');
  return {
    booted: !!(window.G && window.G.App && window.G.App.map),
    center: window.G && window.G.App && window.G.App.map ? window.G.App.map.getCenter() : null,
    zoom: window.G && window.G.App && window.G.App.map ? window.G.App.map.getZoom() : null,
    loginVisible: !!login && !login.classList.contains('hidden'),
    loginFormUsable: !!document.querySelector('#login-form') && !!document.querySelector('#btn-guest'),
    // 显示模式是"读存档恢复"的状态：恢复得对不对要靠它断言
    mode: window.G && window.G.UI ? window.G.UI.mode : null,
    connected: !!(window.G && window.G.Net && window.G.Net.connected),
    ways: window.G && window.G.World ? window.G.World.ways.size : 0,
    features: window.G && window.G.Render ? window.G.Render.stats.features : 0,
    errors: errBox ? errBox.textContent.trim().slice(0, 200) : '',
    storedView: localStorage.getItem('osmcity.view.v2') || localStorage.getItem('osmcity.view') || null,
  };
})()`;

/**
 * 页面里冒出来的所有异常（CDP 的 exceptionThrown / console.error 都收在这里）。
 * 游戏自己会把启动异常写进 #client-errors，但**网络消息回调里的异常**只会进 console，
 * 所以两处都要看。
 */
let pageErrors = [];
const notePageError = (text) => { if (text) pageErrors.push(String(text).slice(0, 240)); };

/**
 * 失败信息里必须带上的现场 —— 一看就知道是"真失败"还是"断言判据写错了"。
 * （上一版第 5/7 节之所以在真机上刷出一片红，就是因为判据错了而现场没打出来。）
 */
function describe(state) {
  if (!state) return '（没有拿到页面状态）';
  const c = state.center;
  return [
    `booted=${state.booted}`,
    `loginVisible=${state.loginVisible}`,
    `mode=${state.mode}`,
    `connected=${state.connected}`,
    `ways=${state.ways}/features=${state.features}`,
    `center=${c ? c.lat.toFixed(5) + ',' + c.lng.toFixed(5) : 'null'}`,
    `#client-errors=${JSON.stringify(state.errors || '')}`,
    `console异常=${pageErrors.length}${pageErrors.length ? '（' + pageErrors[0].slice(0, 140) + '）' : ''}`,
  ].join(' · ');
}

/** 每次导航都换一个查询串，保证是**全新文档**（不受 HTTP 缓存与"同 URL 不重载"影响） */
function navUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return BASE + path + sep + '_t=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 打开页面并等它跑完启动。
 *
 * **必须显式指定 path、不能靠 Page.reload**：Page.reload 重载的是"当前地址"，
 * 而第 4 节把地址留在了 `?guest=1` —— 之后每次 reload 都会自动以游客身份登录，
 * 登录框自然是**隐藏**的，于是"登录框可见"这类断言会集体误报成失败
 * （页面其实一切正常：实测失败信息里 mode/中心 都是对的、#client-errors 也是空的）。
 */
async function openAndProbe(client, path, waitMs = 3600) {
  await client.send('Page.navigate', { url: navUrl(path) });
  await sleep(waitMs);
  return evaluate(client, PROBE);
}

/** 轮询等待页面里的表达式变成 true（比死等固定毫秒稳，慢机器上也不会假失败） */
async function waitFor(client, expression, timeoutMs = 25000) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await evaluate(client, expression) === true; } catch { ok = false; }
    if (ok) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(400);
  }
}

(async () => {
  console.log('\n=== 启动健壮性测试（历史残留数据不能卡死页面）===\n');
  let server = null;
  if (OWN_SERVER) {
    console.log(`本套件自启测试服务器（游客通道打开）：${BASE}`);
    server = startServer();
    await waitReady();
  }
  const health = await (await fetch(BASE + '/api/health')).json();
  console.log(`服务器：${BASE}  数据集：${health.data.nodes} 节点\n`);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1400,900', BASE + '/',
  ], { stdio: 'ignore' });

  let client = null;
  try {
    const page = await waitCDP();
    client = await cdp(page.webSocketDebuggerUrl, (msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        notePageError('exceptionThrown: ' + ((d.exception && d.exception.description) || d.text || ''));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        notePageError('console.error: ' + (msg.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' '));
      }
    });
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    // 关掉 HTTP 缓存：transit.js / main.js / ui.js 都是普通 <script>，
    // 缓存住旧版本会让"已修好的启动流程"看起来仍然白屏（也方便每次导航都拿到新文件）
    await client.send('Network.enable');
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    await sleep(3500);

    console.log('▶ 1) 全新浏览器（干净 localStorage）');
    const clean = await evaluate(client, PROBE);
    check('全新环境能初始化地图', clean.booted === true, `中心 ${JSON.stringify(clean.center)}`);
    check('全新环境登录框可见且可用', clean.loginVisible === true && clean.loginFormUsable === true);
    check('全新环境无报错', clean.errors === '', clean.errors);

    console.log('\n▶ 2) 旧版（游戏版）残留的视角数据 —— 就是你遇到的那条');
    const legacy = { lat: 39.90441146373993, lng: 116.4074, zoom: 15 };
    await evaluate(client, `localStorage.setItem('osmcity.view', ${JSON.stringify(JSON.stringify(legacy))}); 'ok'`);
    const afterLegacy = await openAndProbe(client, '/');
    check('带旧版 {lat,lng} 视角数据仍能初始化',
      afterLegacy.booted === true, `中心 ${JSON.stringify(afterLegacy.center)}`);
    check('带旧版数据时登录框依然可见', afterLegacy.loginVisible === true);
    check('带旧版数据时页面无报错', afterLegacy.errors === '', afterLegacy.errors);
    check('旧版 {lat,lng} 数据被正确解析并沿用（视角不丢）',
      afterLegacy.center && Math.abs(afterLegacy.center.lat - 39.9044) < 0.01 && Math.abs(afterLegacy.center.lng - 116.4074) < 0.01,
      `中心 ${afterLegacy.center && afterLegacy.center.lat.toFixed(5)}, ${afterLegacy.center && afterLegacy.center.lng.toFixed(5)}`);
    check('旧键已被清理（不会反复踩同一个坑）',
      !(await evaluate(client, `localStorage.getItem('osmcity.view')`)),
      'osmcity.view 已删除');

    console.log('\n▶ 3) 各种脏数据逐个试');
    const junkCases = [
      ['缺少经度 {lat}'.padEnd(22), JSON.stringify({ lat: 39.9 })],
      ['类型错误 {lat:"abc"}', JSON.stringify({ lat: 'abc', lng: null })],
      ['空对象 {}', '{}'],
      ['不是 JSON', 'not-json-at-all'],
      ['超出范围 {999,999}', JSON.stringify({ lat: 999, lng: 999 })],
      ['数组 [1,2]', JSON.stringify([39.9, 116.4])],
      ['null 值', JSON.stringify({ lat: null, lng: null })],
    ];
    for (const [label, raw] of junkCases) {
      await evaluate(client, `localStorage.setItem('osmcity.view.v2', ${JSON.stringify(raw)}); 'ok'`);
      const state = await openAndProbe(client, '/');
      const sane = state.center && Math.abs(state.center.lat) <= 90 && Math.abs(state.center.lng) <= 180;
      check(`脏数据可启动：${label.trim()}`, state.booted === true && state.loginVisible === true && sane && state.errors === '',
        describe(state));
    }

    console.log('\n▶ 4) 脏数据 + 游客登录（完整可用性）');
    await evaluate(client, `localStorage.setItem('osmcity.view.v2', ${JSON.stringify(JSON.stringify({ lat: 39.90441146373993, lng: 116.4074 }))}); 'ok'`);
    pageErrors = [];
    await client.send('Page.navigate', { url: navUrl('/?guest=1') });
    await waitFor(client,
      '!!(window.G && window.G.Net && window.G.Net.connected'
      + ' && window.G.World && window.G.World.ways.size > 50'
      + ' && window.G.Render && window.G.Render.stats.features > 20)', 25000);
    const guest = await evaluate(client, `(() => {
      const errBox = document.querySelector('#client-errors');
      return {
        booted: !!(window.G && window.G.App && window.G.App.map),
        connected: !!(window.G && window.G.Net && window.G.Net.connected),
        ways: window.G && window.G.World ? window.G.World.ways.size : 0,
        features: window.G && window.G.Render ? window.G.Render.stats.features : 0,
        loginHidden: document.querySelector('#login').classList.contains('hidden'),
        errors: errBox ? errBox.textContent.trim().slice(0, 200) : '',
      };
    })()`);
    check('脏数据下游客登录成功（登录框自动隐藏）', guest.connected === true && guest.loginHidden === true,
      `连接=${guest.connected} · ${guest.ways} 道路 / 渲染 ${guest.features} 要素 · #client-errors=${JSON.stringify(guest.errors)}`
      + ` · console异常=${pageErrors.length}`);
    check('脏数据下地图数据照样加载渲染', guest.ways > 50 && guest.features > 20,
      `${guest.ways} 道路 / 渲染 ${guest.features} 要素`);
    check('全流程无报错', guest.errors === '' && pageErrors.length === 0,
      guest.errors || pageErrors.join(' ;; '));

    /**
     * ▶ 5) 「读存档恢复显示模式」不能把整个启动搞崩 —— 就是"地图根本加载不出来"那条。
     *
     * 关键点：客户端是用 util.storage.set() 存的，localStorage 里放的是 **JSON 文本**，
     * 所以显示模式长这样：`"rail"` / `"bus"`（带引号，能解析成合法字符串，也在 UI.MODES 里）。
     * 启动顺序是「先恢复界面状态（initMapAndUi → UI.init），后登录拿交通数据」，
     * 恢复轨交/公交模式时会走到 Transit.companyId() → myCompanies()，
     * 而那一刻 Transit.data 还是 null —— 以前这里直接
     * `Cannot read properties of null (reading 'myCompanyId')`，
     * 异常顺着 initMapAndUi 冒到 main.js 的 catch → 判成"地图初始化失败"→
     * 地图、渲染、登录一起停摆（玩家看到的就是空白页 + 登录框）。
     * 老值 `railbus` / `population` / `activity` 反而不在 UI.MODES 里、会退回普通模式，
     * 所以真正能复现的是这两个**合法**值 —— 只要玩家上次用过轨交/公交模式，下次打开就中招。
     */
    console.log('\n▶ 5) 存档里的显示模式 = 轨交/公交（真实玩家留下的是合法 JSON，不是脏文本）');
    console.log('   判据：booted=true + loginVisible=true + #client-errors 空 + console 干净 + mode 被真正恢复');
    console.log('   注意：这一节必须打开**没有 ?guest=1 的首页**，否则页面会自动以游客登录、登录框是隐藏的');
    for (const mode of ['rail', 'bus']) {
      await evaluate(client, `localStorage.setItem('osmcity.displayMode', ${JSON.stringify(JSON.stringify(mode))});
        localStorage.setItem('osmcity.modeFilter.${mode}', ${JSON.stringify(JSON.stringify({ types: [], lines: [] }))});
        localStorage.removeItem('osmcity.token'); 'ok'`);
      pageErrors = [];
      const state = await openAndProbe(client, '/');
      check(`存档显示模式="${mode}"时地图照样初始化、登录框可见`,
        state.booted === true && state.loginVisible === true, describe(state));
      check(`存档显示模式="${mode}"时没有异常（#client-errors 空、console 无 error）`,
        state.errors === '' && pageErrors.length === 0, describe(state));
      // P0 的原始症状：启动流程被异常打断 → main.js 打出"地图初始化失败：…myCompanyId…"
      // 这一条与"登录与否"无关，是最直接的回归护栏。
      check(`存档显示模式="${mode}"时没有出现"地图初始化失败 / myCompanyId"（P0 原始症状）`,
        !/地图初始化失败/.test(state.errors || '')
          && !pageErrors.some((e) => /地图初始化失败|myCompanyId/.test(e)), describe(state));
      check(`存档显示模式="${mode}"被真正恢复（不是悄悄退回普通模式）`,
        state.mode === mode, describe(state));
    }

    console.log('\n▶ 6) 显示模式=轨交/公交 + 游客登录（白屏 P0 的"真的能用"证据）');
    console.log('   判据：connected=true + 登录框自动隐藏 + ways>50 + features>20 + 无报错 + mode 仍在');
    for (const mode of ['rail', 'bus']) {
      await evaluate(client, `localStorage.setItem('osmcity.displayMode', ${JSON.stringify(JSON.stringify(mode))});
        localStorage.setItem('osmcity.modeFilter.${mode}', '{"types":[],"lines":[]}');
        localStorage.removeItem('osmcity.token'); 'ok'`);
      pageErrors = [];
      await client.send('Page.navigate', { url: navUrl('/?guest=1') });
      const gotData = await waitFor(client,
        '!!(window.G && window.G.Net && window.G.Net.connected'
        + ' && window.G.World && window.G.World.ways.size > 50'
        + ' && window.G.Render && window.G.Render.stats.features > 20)', 25000);
      const s = await evaluate(client, PROBE);
      check(`显示模式="${mode}"时游客登录照样连上、地图数据照样画出来`,
        gotData && s.connected === true && s.loginVisible === false && s.ways > 50 && s.features > 20, describe(s));
      check(`显示模式="${mode}"时全流程无报错（含 console）`,
        s.errors === '' && pageErrors.length === 0, describe(s));
      check(`恢复出来的显示模式在登录之后仍然保留`, s.mode === mode, describe(s));
    }

    /**
     * ▶ 7) 本轮新写的键，逐个灌「旧值 / 非法值」，一个都不许把启动搞崩。
     *
     * 两种写法都要试：
     *   - 客户端自己写出来的（**JSON 文本**）：`"rail"` / `9` / `true` / `{"types":"x"}`
     *   - 老版本 / 手改 / 别的脚本留下的**裸文本**（JSON.parse 直接抛，storage.get 回退默认值）
     * 每条只留它自己（必要时再加一个"让它真的被用到"的键），互不干扰。
     *
     * 这里面 `osmcity.displayMode = "rail"` / `"bus"` 就是本次白屏的那条：
     * 恢复显示模式时交通数据还没到（Transit.data === null），
     * Transit.myCompanies() 直接解引用 → 异常冒到 initMapAndUi → 整张地图不再初始化。
     * `"railbus"` / `"population"` / `"activity"` 这类老值不在 UI.MODES 里，会退回普通模式，反而不炸。
     */
    console.log('\n▶ 7) 本轮新写的键 × 旧值/非法值（逐条，一个都不许打断启动）');
    const NEW_KEY_CASES = [
      // [键, 原始文本（localStorage 里真正放的东西）, 期望的 UI.mode（null = 不检查）, 额外一起写的键]
      ['osmcity.detail.v1', '9', null],
      ['osmcity.detail.v1', '"标准"', null],
      ['osmcity.detail.v1', 'null', null],
      ['osmcity.detail.v1', '标准', null],
      ['osmcity.detail.v2', '9', null],
      ['osmcity.detail.v2', '"标准"', null],
      ['osmcity.detail.v2', 'null', null],
      ['osmcity.detail.v2', '{"level":4}', null],
      ['osmcity.detail.v2', '标准', null],
      ['osmcity.panel.transit', '"yes"', null],
      ['osmcity.panel.inspector', '1', null],
      ['osmcity.panel.layers', '{"a":1}', null],
      ['osmcity.panel.toolopts', 'null', null],
      ['osmcity.panel.tools', '0', null],
      ['osmcity.panel.chat', '"c"', null],
      ['osmcity.panel.collab', '9', null],
      ['osmcity.layer.population', '"on"', null],
      ['osmcity.layer.population', 'true', null],
      ['osmcity.layer.activity', '9', null],
      ['osmcity.layer.activity', 'true', null],
      ['osmcity.layer.catchment', '1', null],
      ['osmcity.layer.catchmentFlaggedOnly', '标准', null],
      ['osmcity.displayMode', '"railbus"', 'normal'],        // 老值：不在 UI.MODES → 退回普通
      ['osmcity.displayMode', '"population"', 'normal'],
      ['osmcity.displayMode', '"activity"', 'normal'],
      ['osmcity.displayMode', '"rail"', 'rail'],             // ← 白屏那条（合法新值）
      ['osmcity.displayMode', '"bus"', 'bus'],               // ← 白屏那条
      ['osmcity.displayMode', '9', 'normal'],
      ['osmcity.displayMode', '"标准"', 'normal'],
      ['osmcity.displayMode', 'null', 'normal'],
      ['osmcity.displayMode', '{"mode":"rail"}', 'normal'],
      ['osmcity.modeFilter.rail', '{"types":"x","lines":"y"}', 'rail', { 'osmcity.displayMode': '"rail"' }],
      ['osmcity.modeFilter.rail', '9', 'rail', { 'osmcity.displayMode': '"rail"' }],
      ['osmcity.modeFilter.rail', '"标准"', 'rail', { 'osmcity.displayMode': '"rail"' }],
      ['osmcity.modeFilter.rail', '{"types":["subway"],"lines":["a"]}', 'rail', { 'osmcity.displayMode': '"rail"' }],
      ['osmcity.modeFilter.bus', '[1,2]', 'bus', { 'osmcity.displayMode': '"bus"' }],
      ['osmcity.modeFilter.bus', '9', 'bus', { 'osmcity.displayMode': '"bus"' }],
      ['osmcity.transit.stationLod', '9', null],
      ['osmcity.transit.stationLod', '"标准"', null],
      ['osmcity.transit.stationLod', 'null', null],
      ['osmcity.transit.stationLod', '{"dotMinZoom":"abc","maxMetersPer100px":"x"}', null],
      ['osmcity.transit.stationLod', '{"maxMetersPer100px":-1}', null],
      ['osmcity.transit.stationLod', '{"bubbleMinZoom":14}', null],
    ];
    for (const [key, raw, expectMode, extra] of NEW_KEY_CASES) {
      const seed = Object.assign({ [key]: raw }, extra || {});
      const seedJS = Object.entries(seed)
        .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n');
      // localStorage.clear() 顺手把 osmcity.token 也清了 → 页面不会自动登录 → 登录框应当可见
      await evaluate(client, `localStorage.clear();\n${seedJS}\n'ok'`);
      pageErrors = [];
      // 必须打开**首页**（不带 ?guest=1）：带游客参数时页面会自动登录、登录框隐藏
      const state = await openAndProbe(client, '/');
      const sane = state.center && Math.abs(state.center.lat) <= 90 && Math.abs(state.center.lng) <= 180;
      const modeOk = expectMode === null || state.mode === expectMode;
      check(`${key} = ${raw} 时启动正常${expectMode ? `，显示模式=${expectMode}` : ''}`,
        state.booted === true && state.loginVisible === true && sane && modeOk
          && state.errors === '' && pageErrors.length === 0,
        describe(state) + (modeOk ? '' : ` · 期望 mode=${expectMode}`));
    }

    // 收尾：清掉测试写入的缓存
    await evaluate(client, `localStorage.clear(); 'ok'`);
  } finally {
    if (client) client.close();
    try { child.kill(); } catch { /* ignore */ }
    // 自己起的那台测试服务器也要关掉（外部 BASE 不动别人的进程）
    if (server) { try { server.kill(); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }

  console.log('\n' + '─'.repeat(52));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('─'.repeat(52) + '\n');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\n测试异常终止:', err.message);
  process.exit(1);
});
