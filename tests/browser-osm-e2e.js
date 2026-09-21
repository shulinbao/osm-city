'use strict';
/**
 * 浏览器端到端测试：用无头 Edge + CDP 驱动真实界面，验证
 * 矢量底图渲染、图层、选择、标签编辑、绘制、撤销、搜索、导出、历史。
 *
 * 前置：**不需要**手动启动服务器。
 *   · 不设 BASE 时，本套件自己拉起一台测试服务器（端口 E2E_PORT，默认 8911）并加上
 *     `--allow-guests` —— 正式 config.json 里 allowGuests=false（玩家必须注册/登录），
 *     而本套件全程走 `?guest=1` 免注册登录，所以它只给**测试实例**开这个口子；
 *     跑完自动关掉。数据集仍是默认的 data/osm/osm.sqlite；临时游客账号写在
 *     tests/tmp-browser-osm/（`--data`），不污染正式的 data/users.json。
 *   · 设了 BASE（例如 BASE=http://127.0.0.1:8787）就指向那台、不再自启 ——
 *     但那台服务器必须允许游客（--allow-guests / DSH_ALLOW_GUESTS=1 / config.json allowGuests=true）。
 * 用法：node tests/browser-osm-e2e.js
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
/** 没给 BASE 就自己起一台（见上面说明）；给了就完全按老行为用那台 */
const OWN_SERVER = !process.env.BASE;
const PORT = Number(process.env.E2E_PORT || 8911);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT || 9224);
const PROFILE = path.join(__dirname, 'edge-profile-osm');
/** 账号写在临时目录里：本套件的临时游客/账号不该进正式 data/users.json
 *（数据集仍走 config.json 的 osmDb，默认 data/osm/osm.sqlite） */
const DATA_DIR = path.join(__dirname, 'tmp-browser-osm');

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
    await new Promise((r) => setTimeout(r, 500));
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
  else { failed += 1; console.log('  ❌ ' + name + (detail ? '  (' + detail + ')' : '')); }
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

function cdp(wsUrl) {
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

async function evaluate(client, expression, timeoutMs = 240000) {
  const res = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (res.exceptionDetails) {
    const e = res.exceptionDetails;
    throw new Error('页面脚本异常: ' + (e.exception && e.exception.description ? e.exception.description.split('\n')[0] : e.text));
  }
  return res.result.value;
}

const PAGE_SCRIPT = `(async () => {
  const G = window.G;
  const out = {};
  const toasts = () => Array.from(document.querySelectorAll('#toasts .toast')).map(t => t.textContent);
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); }
    return false;
  };
  window.confirm = () => true;
  try {
    // 先等界面起来，避免刚重启服务器时抢跑
    out.appReady = await waitFor(() => G.UI && document.querySelectorAll('#tool-list .tool').length > 0, 25000);
    out.connected = G.Net.connected;
    await waitFor(() => G.Net.connected, 15000);
    out.meName = document.querySelector('#me-name') ? document.querySelector('#me-name').textContent : '(无此元素)';
    out.presets = G.Presets ? G.Presets.all().length : 0;
    out.categories = G.Style.CATEGORIES.length;
    out.layersRendered = document.querySelectorAll('#layer-list .layer-item').length;
    out.toolsRendered = document.querySelectorAll('#tool-list .tool').length;

    // 等地图数据到位
    out.dataLoaded = await waitFor(() => G.World.ways.size > 50, 30000);
    out.counts = G.World.counts();
    // 直接探一次渲染，把异常与跳过计数带回来
    try {
      G.Render.rebuild();
      out.rebuildError = null;
    } catch (e) {
      out.rebuildError = e.message + ' | ' + String(e.stack || '').split('\\n').slice(0, 3).join(' <- ');
    }
    out.rendered = await waitFor(() => G.Render.stats.features > 20, 20000);
    out.features = G.Render.stats.features;
    out.skipped = G.Render.stats.skipped;
    out.lastRenderError = G.Render.stats.lastError;
    out.labels = G.Render.stats.labels;
    out.renderMs = G.Render.stats.ms;
    out.clientErrorsEarly = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.slice(0, 300) : '';
    out.dataInfo = document.querySelector('#data-info') ? document.querySelector('#data-info').textContent.replace(/\\\\s+/g, ' ').trim() : '';

    // 找一个真实的建筑（带 building 标签的闭合 way）并选中
    let target = null;
    for (const w of G.World.ways.values()) {
      if (w.tags && w.tags.building && G.World.isClosed(w)) { target = w; break; }
    }
    out.hasBuilding = !!target;
    if (target) {
      G.Editor.select('way', target.id);
      out.selected = await waitFor(() => {
        const box = document.querySelector('#inspector-body');
        return box && !box.classList.contains('hidden') && document.querySelectorAll('#insp-tags .tag-row').length > 0;
      }, 8000);
      out.tagRows = document.querySelectorAll('#insp-tags .tag-row').length;
      out.inspTitle = document.querySelector('#insp-element-title').textContent.replace(/\\\\s+/g, ' ').trim();
      out.geometryInfo = document.querySelector('#insp-geometry').textContent.replace(/\\\\s+/g, ' ').trim();

      // 通过界面改一个标签：加 name=浏览器测试建筑
      const addBtn = document.querySelector('#insp-add-tag');
      addBtn.click();
      const rows = document.querySelectorAll('#insp-tags .tag-row');
      const last = rows[rows.length - 1];
      last.querySelector('.tag-key').value = 'name';
      last.querySelector('.tag-value').value = '浏览器测试建筑';
      last.querySelector('.tag-value').dispatchEvent(new Event('change', { bubbles: true }));
      out.tagSaved = await waitFor(() => {
        const w = G.World.getWay(target.id);
        return w && w.tags && w.tags.name === '浏览器测试建筑';
      }, 10000);
      out.savedTags = G.World.getWay(target.id) ? G.World.getWay(target.id).tags : null;
    }

    // 绘制一个新区域（不依赖鼠标事件，直接调用编辑器接口）
    G.UI.selectTool('area');
    G.Editor.drawTags = { landuse: 'grass', name: '浏览器测试草地' };
    const c = G.App.map.getCenter();
    const P = (dLat, dLng) => L.latLng(c.lat + dLat, c.lng + dLng);
    const waysBefore = G.World.ways.size;
    G.Editor._addDrawPoint(P(0.0010, 0.0010));
    G.Editor._addDrawPoint(P(0.0010, 0.0016));
    G.Editor._addDrawPoint(P(0.0015, 0.0016));
    G.Editor._addDrawPoint(P(0.0015, 0.0010));
    out.drawPreview = G.Editor.pending.length;
    G.Editor.finishDraw();
    out.drawCreated = await waitFor(() => G.World.ways.size > waysBefore, 12000);
    let drawn = null;
    for (const w of G.World.ways.values()) {
      if (w.tags && w.tags.name === '浏览器测试草地') drawn = w;
    }
    out.drawnId = drawn ? drawn.id : null;
    out.drawnClosed = drawn ? G.World.isClosed(drawn) : false;
    out.drawnNodes = drawn ? drawn.nodes.length : 0;

    // 撤销刚才的绘制：先走界面按钮/快捷键路径（Ctrl+Z）
    if (drawn) {
      G.Editor.select('way', drawn.id);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      out.undoRemoved = await waitFor(() => !G.World.getWay(drawn.id), 10000);
      if (!out.undoRemoved) {
        await G.Editor.undo();
        out.undoRemoved = await waitFor(() => !G.World.getWay(drawn.id), 8000);
        out.undoViaApi = true;
      }
    }

    // ---------- 回归：鼠标移动驱动的绘制预览 ----------
    // 曾经的 bug：预览提示传的是 Leaflet LatLng（只有 .lng），渲染层却读 .lon，
    // 结果 latLngToContainerPoint 收到 (lat, undefined) 抛 "Invalid LatLng object"。
    G.UI.selectTool('line');
    G.Editor.pending = [];
    G.Editor._addDrawPoint(L.latLng(c.lat + 0.0006, c.lng + 0.0006));
    const rect = G.App.map.getContainer().getBoundingClientRect();
    G.App.map.getContainer().dispatchEvent(new MouseEvent('mousemove', {
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.5,
      bubbles: true,
    }));
    await new Promise((r) => setTimeout(r, 400));
    out.cursorLatLngSet = !!G.Editor.cursorLatLng;
    out.previewTipActive = !!(G.Editor._previewState() && G.Editor._previewState().tip);
    out.errorsAfterMousePreview = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '';
    G.Editor.cancel();

    // ---------- 回归：节点工具下的手柄/中点绘制 ----------
    let nodeTarget = null;
    for (const w of G.World.ways.values()) {
      if (w.tags && w.tags.building && G.World.isClosed(w) && w.nodes.length > 3) { nodeTarget = w; break; }
    }
    out.hasNodeTarget = !!nodeTarget;
    if (nodeTarget) {
      G.UI.selectTool('nodes');
      G.Editor.select('way', nodeTarget.id);
      await new Promise((r) => setTimeout(r, 400));
      out.errorsAfterNodeTool = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '';
      out.overlayVisible = !!(G.Render.overlay && G.Render.overlay._canvas);
      G.UI.selectTool('select');
      G.Editor._renderPreview();
      out.errorsAfterNodeTool = out.errorsAfterNodeTool || (document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '');
    }

    // ---------- 新建要素的默认标签（名字/车道/单行/楼层）----------
    G.UI.selectTool('line');
    G.Editor.drawTags = { highway: 'residential', lanes: '2', oneway: 'no' };
    G.Editor.drawName = '默认标签测试路';
    const dc = G.App.map.getCenter();
    G.Editor.pending = [];
    G.Editor._addDrawPoint(L.latLng(dc.lat + 0.0004, dc.lng + 0.0004));
    G.Editor._addDrawPoint(L.latLng(dc.lat + 0.0007, dc.lng + 0.0007));
    G.Editor.finishDraw();
    out.defaultRoadCreated = await waitFor(() => [...G.World.ways.values()].some((w) => w.tags && w.tags.name === '默认标签测试路'), 8000);
    const defaultRoad = [...G.World.ways.values()].find((w) => w.tags && w.tags.name === '默认标签测试路');
    out.defaultRoadTags = defaultRoad ? defaultRoad.tags : null;

    G.UI.selectTool('area');
    G.Editor.drawAreaKind = 'building';
    G.Editor.drawFloors = 5;
    G.Editor.drawTags = { building: 'yes' };
    G.Editor.drawName = '默认标签测试楼';
    G.Editor.pending = [];
    G.Editor._addDrawPoint(L.latLng(dc.lat + 0.0010, dc.lng + 0.0010));
    G.Editor._addDrawPoint(L.latLng(dc.lat + 0.0010, dc.lng + 0.0012));
    G.Editor._addDrawPoint(L.latLng(dc.lat + 0.0012, dc.lng + 0.0012));
    G.Editor._addDrawPoint(L.latLng(dc.lat + 0.0012, dc.lng + 0.0010));
    G.Editor.finishDraw();
    out.defaultBuildingCreated = await waitFor(() => [...G.World.ways.values()].some((w) => w.tags && w.tags.name === '默认标签测试楼'), 8000);
    const defaultBld = [...G.World.ways.values()].find((w) => w.tags && w.tags.name === '默认标签测试楼');
    out.defaultBuildingTags = defaultBld ? defaultBld.tags : null;

    // ---------- 框选 ----------
    G.UI.selectTool('boxselect');
    const bc = G.App.map.getCenter();
    G.Editor.selectInBox({
      start: { lat: bc.lat - 0.0025, lon: bc.lng - 0.0025 },
      end: { lat: bc.lat + 0.0025, lon: bc.lng + 0.0025 },
    });
    out.boxSelected = G.Editor.multiSelect.length;
    G.Render.rebuild();
    await new Promise((r) => setTimeout(r, 300));
    out.boxErrors = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '';
    // 批量套用一个标签再撤销
    G.Editor.applyTagsToSelection('source', 'browser-test');
    out.boxTagged = await waitFor(() => G.Editor.multiSelect.every((it) => {
      const el = G.World.get(it.type, it.id);
      return !el || !el.tags || el.tags.source === 'browser-test';
    }), 15000);
    await G.Editor.undo();

    // ---------- 聚焦模式 ----------
    G.Render.setFocus('rail');
    await new Promise((r) => setTimeout(r, 400));
    G.Render.rebuild();
    out.focusRailShapes = G.Render.stats.focusShapes;
    out.focusRailDrawn = G.Render.stats.drawn;
    G.Render.setFocus(null);
    G.Render.rebuild();
    out.focusOffDrawn = G.Render.stats.drawn;
    G.UI.selectTool('select');

    // ---------- 建筑遮挡顺序 ----------
    G.App.map.setZoom(18);
    await new Promise((r) => setTimeout(r, 2500));
    G.Render.rebuild();
    out.depthRange = G.Render.stats.depthRange;
    out.buildingCountAt18 = G.Render.stats.buildings;
    out.depthZoom = G.App.map.getZoom();
    out.depthFocus = G.Render.focus;
    out.depthBias = G.Render.lodBias;
    out.depthDetail = G.Render.stats.detailShapes;
    out.depthSkipped = G.Render.stats.skipped;
    out.depthErr = G.Render.stats.lastError;

    // ---------- 交通玩法界面 ----------
    out.hasClock = !!document.querySelector('#clock-box');
    out.clockText = document.querySelector('#clock-time') ? document.querySelector('#clock-time').textContent : '';
    out.clockSpeedBefore = G.Transit.data && G.Transit.data.clock ? G.Transit.data.clock.speed : null;
    // 时间流速现在在顶栏时钟按钮的菜单里：点按钮展开菜单，再点具体倍速芯片（先暂停再切 ×5，保证一定变化）
    document.querySelector('#clock-speed').click();
    await new Promise((r) => setTimeout(r, 250));
    const pauseChip = document.querySelector('#clock-menu [data-speed="0"]');
    if (pauseChip) { pauseChip.click(); await new Promise((r) => setTimeout(r, 400)); }
    out.clockSpeedBefore = G.Transit.data && G.Transit.data.clock ? G.Transit.data.clock.speed : null;
    document.querySelector('#clock-speed').click();
    await new Promise((r) => setTimeout(r, 250));
    const speedChip = document.querySelector('#clock-menu [data-speed="1"]') || document.querySelector('#clock-menu [data-speed="5"]');
    if (speedChip) speedChip.click();
    out.clockChanged = await waitFor(() => G.Transit.data && G.Transit.data.clock && G.Transit.data.clock.speed !== out.clockSpeedBefore, 5000);
    out.clockSpeedAfter = G.Transit.data && G.Transit.data.clock ? G.Transit.data.clock.speed : null;
    if (!out.clockChanged) {
      // 点按钮没生效就直连一次，把错误信息带回来
      try {
        const ack = await G.Transit.op({ k: 'clock.set', speed: 1 });
        out.clockDirectAck = JSON.stringify(ack.result || ack).slice(0, 120);
      } catch (err) {
        out.clockDirectError = err.message;
      }
      await new Promise((r) => setTimeout(r, 800));
      out.clockSpeedAfter = G.Transit.data && G.Transit.data.clock ? G.Transit.data.clock.speed : null;
    }
    out.clockToasts = toasts();
    // 恢复暂停，避免测试期间时钟乱跑
    await G.Transit.op({ k: 'clock.set', speed: 0 });

    G.Transit.openPanel('company');
    await new Promise((r) => setTimeout(r, 400));
    out.panelOpen = G.Transit.panelOpen;
    out.panelTabs = document.querySelectorAll('#transit-tabs .tp-tab').length;
    out.panelText = document.querySelector('#transit-body') ? document.querySelector('#transit-body').textContent.replace(/\s+/g, ' ').slice(0, 120) : '';
    out.panelRows = document.querySelectorAll('#transit-body .tp-row').length;
    out.hasCompanyCash = out.economyOffCheck === false || /资金/.test(out.panelText);

    // 人口热力图开关（拉取真实人口网格）
    const popBox = document.querySelector('#pop-toggle');
    popBox.checked = true;
    popBox.dispatchEvent(new Event('change', { bubbles: true }));
    out.popCells = await waitFor(() => G.Transit.population.cells.length > 0, 15000)
      ? G.Transit.population.cells.length : 0;
    G.Transit.togglePopulation(false);

    // 车站工具：切到设站并在铁路附近建站（找不到铁路就跳过）
    let railWay = null;
    for (const w of G.World.ways.values()) {
      if (w.tags && w.tags.railway && w.nodes.length > 2) { railWay = w; break; }
    }
    out.hasRailInView = !!railWay;
    if (railWay) {
      const n = G.World.getNode(railWay.nodes[Math.floor(railWay.nodes.length / 2)]);
      G.App.map.setView([n.lat, n.lon], 17, { animate: false });
      await new Promise((r) => setTimeout(r, 2000));
      G.Transit.stationMode = 'rail';
      try {
        out.stationCreated = await G.Transit.createStationAt(L.latLng(n.lat, n.lon), '浏览器测试车站').then((s) => s.name);
      } catch (err) {
        out.stationError = err.message;
      }
      await new Promise((r) => setTimeout(r, 600));
      out.myStations = G.Transit.myStations().length;
      const mine = G.Transit.myStations();
      out.myStationId = mine.length ? mine[0].id : null;
      out.stationDrawn = G.Render.stats.transitError || '';
    }
    out.transitErrors = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '';
    G.Transit.closePanel();

    // ---------- 修复验证：楼层标签 / 创作面板 / 撤销按钮 / 车站点选 / 建筑遮挡层级 ----------
    // 1) 手动添加 building:levels —— 先只改 key（值还空着）不许把这一行弄没
    let bld = null;
    for (const w of G.World.ways.values()) {
      if (w.tags && w.tags.building && !w.tags['building:levels'] && G.World.isClosed(w)) { bld = w; break; }
    }
    out.hasBldNoLevels = !!bld;
    if (bld) {
      G.Editor.select('way', bld.id);
      await waitFor(() => document.querySelectorAll('#insp-tags .tag-row').length > 0, 8000);
      document.querySelector('#insp-add-tag').click();
      let rows = document.querySelectorAll('#insp-tags .tag-row');
      let row = rows[rows.length - 1];
      const keyInput = row.querySelector('.tag-key');
      keyInput.value = 'building:levels';
      keyInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      out.rowSurvivesKeyEdit = Array.from(document.querySelectorAll('#insp-tags .tag-row'))
        .some((x) => x.querySelector('.tag-key').value === 'building:levels');
      rows = document.querySelectorAll('#insp-tags .tag-row');
      row = rows[rows.length - 1];
      row.querySelector('.tag-value').value = '7';
      row.querySelector('.tag-value').dispatchEvent(new Event('change', { bubbles: true }));
      out.levelsSaved = await waitFor(() => {
        const w = G.World.getWay(bld.id);
        return w && w.tags && w.tags['building:levels'] === '7';
      }, 10000);
      // 楼层控件也能改（建筑专用）
      G.Inspector.setTag('building:levels', '9');
      out.levelsViaControl = await waitFor(() => {
        const w = G.World.getWay(bld.id);
        return w && w.tags && w.tags['building:levels'] === '9';
      }, 10000);
      out.floorsCtlShown = !!document.querySelector('.floors-ctl');
    }

    // 2) 创作面板：还没画就能在右侧选类型
    G.Editor.deselect();
    G.UI.selectTool('line');
    await new Promise((r) => setTimeout(r, 300));
    out.createPanelShown = !!document.querySelector('#inspector-create') && !document.querySelector('#inspector-create').classList.contains('hidden');
    out.createPanelChips = document.querySelectorAll('#inspector-create .preset-chip').length;
    out.createPanelWillWrite = document.querySelector('#inspector-create .will-write')
      ? document.querySelector('#inspector-create .will-write').textContent.replace(/\s+/g, ' ').trim() : '';
    const roadPreset = Array.from(document.querySelectorAll('#inspector-create .preset-chip'))
      .find((c) => /高速|主干道|次干道|住宅区道路/.test(c.textContent));
    out.hasRoadPresetChip = !!roadPreset;
    if (roadPreset) {
      roadPreset.click();
      await new Promise((r) => setTimeout(r, 200));
      out.presetApplied = JSON.stringify(G.Editor.drawTags || {});
      out.willWriteAfter = document.querySelector('#inspector-create .will-write')
        ? document.querySelector('#inspector-create .will-write').textContent.replace(/\s+/g, ' ').trim() : '';
    }

    // 3) 状态栏的撤销/重做按钮
    out.hasUndoButton = !!document.querySelector('#btn-undo') && !!document.querySelector('#btn-redo');
    const cp = G.App.map.getCenter();
    const beforeUndoAck = await G.Net.op({
      k: 'createWay',
      points: [{ lat: cp.lat + 0.0030, lon: cp.lng + 0.0030 }, { lat: cp.lat + 0.0032, lon: cp.lng + 0.0032 }],
      tags: { highway: 'service', name: '撤销按钮测试' },
    });
    const undoWayId = beforeUndoAck.ops.find((o) => o.k === 'wayCreate').way.id;
    await waitFor(() => !!G.World.getWay(undoWayId), 6000);
    const depthBefore = G.Transit ? null : null;
    void depthBefore;
    document.querySelector('#btn-undo').click();
    out.undoButtonWorked = await waitFor(() => !G.World.getWay(undoWayId), 10000);

    // 4) 城市尺度（z11）与低缩放（z13）：默认「完整」档一个要素都不许丢
    //    （旧语义是"城市尺度不画大片底色/公园"——靠少画换性能，那种截断显示已经明令禁止）
    const settleRebuild = async () => {
      if (typeof G.Render.jobPending === 'function' && typeof G.Render.rebuildAsync === 'function'
        && G.Render.jobPending()) {
        await G.Render.rebuildAsync();     // 等 setDetail 触发的那次重建画完，别让旧任务盖掉统计
      }
    };
    G.Render.setDetail(0, { silent: true, persist: false, refetch: false });
    await settleRebuild();
    G.Render.lodBias = 0;                  // 老版本的自动降级已废弃：这里恒为 0
    G.Render.rebuild();
    G.App.map.setView([39.9042, 116.4074], 11, { animate: false });
    await new Promise((r) => setTimeout(r, 2500));
    G.Render.lodBias = 0;
    G.Render.rebuild();
    out.cityFills = G.Render.stats.fills;
    out.cityDrawn = G.Render.stats.drawn;
    out.citySkippedSmall = G.Render.stats.skippedSmall || 0;
    out.cityDetail = G.Render.stats.detail;
    // 自证：视野内"已加载"与"真的画出来"对账（道路必须一条不缺，面不许有计划外的缺失）
    out.cityComplete = G.Render.completeness();
    G.App.map.setView([39.9042, 116.4074], 13, { animate: false });
    await new Promise((r) => setTimeout(r, 2000));
    G.Render.lodBias = 0;
    G.Render.rebuild();
    out.z13Fills = G.Render.stats.fills;
    out.z13SkippedSmall = G.Render.stats.skippedSmall || 0;
    out.z13Complete = G.Render.completeness();

    // 5) 建筑必须画在道路之上（高楼才能挡住后面的道路/河道）
    out.buildingPaneZ = Number(G.App.map.getPane('osmcity-building').style.zIndex);
    out.roadPaneZ = Number(G.App.map.getPane('osmcity-core').style.zIndex);

    // 6) 车站可以点选并删除（地图弹窗里就有删除按钮：站名 + 定位 + 删除）
    out.stationSelectable = false;
    if (out.myStationId) {
      const st = G.Transit.stationById(out.myStationId);
      if (st) {
        G.UI.selectTool('select');
        G.Transit.selectOnMap({ type: 'station', id: st.id }, L.latLng(st.lat, st.lon));
        await new Promise((r) => setTimeout(r, 500));
        const popupEl = document.querySelector('.osmcity-popup');
        out.stationPopupText = popupEl ? popupEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
        out.stationSelected = G.Transit.selectedStation === st.id;
        // 删除按钮必须在地图弹窗里：点它走的是 Transit.deleteStation（和面板里的删除同一条路径）
        const delBtn = popupEl ? popupEl.querySelector('[data-act="delete-station"]') : null;
        out.stationDeleteBtn = !!delBtn;
        if (delBtn) {
          delBtn.click();
          await waitFor(() => !G.Transit.stationById(st.id), 8000);
          out.stationDeleted = !G.Transit.stationById(st.id);
          out.stationDeleteToast = toasts();
        }
      }
    }
    out.fixErrors = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '';

    // ---------- 类型标签互不串味 / 交通撤销 / 车辆系统 ----------
    G.Editor.deselect();
    G.UI.selectTool('station');
    await new Promise((r) => setTimeout(r, 300));
    out.stationPanelChips = document.querySelectorAll('#inspector-create .preset-chip').length;
    out.stationPanelWrite = document.querySelector('#inspector-create .will-write') ? document.querySelector('#inspector-create .will-write').textContent.replace(/\s+/g, ' ') : '';
    G.UI.selectTool('line');
    await new Promise((r) => setTimeout(r, 200));
    out.linePanelTags = JSON.stringify(G.Editor.defaultTagsFor('line'));
    G.UI.selectTool('area');
    await new Promise((r) => setTimeout(r, 200));
    out.areaPanelTags = JSON.stringify(G.Editor.defaultTagsFor('area'));
    out.stationTagsEmpty = JSON.stringify(G.Editor.defaultTagsFor('station'));

    G.Transit.openPanel('company');
    await new Promise((r) => setTimeout(r, 400));
    out.companyPanelText = document.querySelector('#transit-body') ? document.querySelector('#transit-body').textContent.replace(/\s+/g, ' ') : '';
    out.economyOff = G.Transit.config && G.Transit.config.economy === false;

    G.Transit.panelTab = 'vehicles';
    G.Transit.renderPanel();
    await new Promise((r) => setTimeout(r, 300));
    out.vehicleKindChips = document.querySelectorAll('#transit-body .opt-chips .chip').length;
    const vehiclesBefore = G.Transit.myVehicles().length;
    try {
      await G.Transit.op({ k: 'vehicle.create', kind: 'bus' });
      out.busCreated = await waitFor(() => G.Transit.myVehicles().length > vehiclesBefore, 8000);
      const mineV = G.Transit.myVehicles();
      out.newBus = mineV.length
        ? (mineV[mineV.length - 1].name + '/' + mineV[mineV.length - 1].lengthM + 'm/' + mineV[mineV.length - 1].capacity + '人')
        : '';
    } catch (err) {
      out.busError = err.message;
    }
    // 撤销：服务端把 OSM 编辑与交通玩法放在**同一条时间线**上，一次撤销永远先撤"真正最近的一步"。
    // 测试自己在这之前改过地图（框选批量打 source 标签只撤了一下、建过路又撤了），所以第一下撤销
    // 完全可能撤的是那条道路改动，第二下才轮到刚新建的车辆 —— 这里不假设"第一下就是车辆"，
    // 按最多 3 次、直到车队数量回到新建前为止，断言写成"最终回到新建前"。
    out.vehicleUndoAttempts = 0;
    out.vehicleUndoTips = [];
    for (let i = 0; i < 3 && G.Transit.myVehicles().length > vehiclesBefore; i++) {
      await G.Editor.undo();
      out.vehicleUndoAttempts += 1;
      await waitFor(() => G.Transit.myVehicles().length <= vehiclesBefore, 1500);
      await new Promise((r) => setTimeout(r, 400));
      out.vehicleUndoTips = toasts();
    }
    out.vehicleUndone = G.Transit.myVehicles().length === vehiclesBefore;
    out.transitUndoTip = toasts();
    G.Transit.closePanel();
    out.flowErrors = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '';

    // ---------- 分级显示：默认「完整」档一个要素都不丢；「骨架」是玩家显式选的档位 ----------
    const MINOR = ['residential', 'unclassified', 'living_street', 'service', 'footway', 'path', 'cycleway', 'steps', 'track', 'pedestrian'];
    // detail：0=完整（默认，什么都不丢）/ 3=骨架（只画主干路网、铁路、水系、大面用地、边界）
    const lodAt = async (zoom, ms, detail) => {
      G.Render.setDetail(detail == null ? 0 : detail, { silent: true, persist: false, refetch: false });
      await settleRebuild();
      G.Render.lodBias = 0;        // 老版本会自动 +1 降级（"路只剩一半"的来源），现在恒为 0
      G.App.map.setZoom(zoom);
      await new Promise((r) => setTimeout(r, ms));
      G.Render.rebuild();
      const ways = G.Render._visibleWays;
      const comp = G.Render.completeness();   // 禁止截断的自证：道路一条不缺 + 没有计划外少掉的面
      return {
        zoom,
        detail: G.Render.detail,
        detailName: G.Render.detailName(),
        buildings: G.Render.stats.buildings,
        fills: G.Render.stats.fills,
        drawn: G.Render.stats.drawn,
        features: G.Render.stats.features,
        skippedSmall: G.Render.stats.skippedSmall || 0,
        wayCount: ways.length,
        minorWays: ways.filter((w) => {
          const t = w.tags || {};
          return !!(t.building || MINOR.includes(t.highway));
        }).length,
        majorWays: ways.filter((w) => {
          const t = w.tags || {};
          return ['motorway', 'trunk', 'primary'].includes(t.highway);
        }).length,
        lod: G.Render.stats.lod,
        roadsInView: comp ? comp.roadsInView : null,
        roadsMissing: comp ? comp.roadsMissing : null,
        areasInView: comp ? comp.areasInView : null,
        areasMissing: comp ? comp.areasMissing : null,
        degradedAreasMissing: comp ? comp.degradedAreasMissing : null,
        areasMissingUnexpected: comp ? comp.areasMissingUnexpected : null,
        honest: comp ? comp.honest : false,
      };
    };
    G.App.map.setView([39.9042, 116.4074], 11, { animate: false });
    await new Promise((r) => setTimeout(r, 2500));
    out.lodZ11 = await lodAt(11, 2200, 0);
    out.lodZ14 = await lodAt(14, 2200, 0);
    out.lodZ17 = await lodAt(17, 3000, 0);
    // 只有玩家自己把详细度切到「骨架」档才会"少画"：这一档必须只剩主干骨架
    out.lodZ11Skeleton = await lodAt(11, 2200, 3);
    // 回到默认「完整」档，后面的用例继续按默认档跑
    G.Render.setDetail(0, { silent: true, persist: false, refetch: false });
    await settleRebuild();
    G.Render.lodBias = 0;
    G.Render.rebuild();

    // ---------- 延长道路（自己造一条，状态可控）----------
    G.UI.selectTool('select');
    const extCenter = G.App.map.getCenter();
    const extAck = await G.Net.op({
      k: 'createWay',
      points: [
        { lat: extCenter.lat + 0.0010, lon: extCenter.lng + 0.0010 },
        { lat: extCenter.lat + 0.0014, lon: extCenter.lng + 0.0014 },
      ],
      tags: { highway: 'residential', name: '延长测试路' },
    });
    const extWayId = extAck.ops.find((o) => o.k === 'wayCreate').way.id;
    out.extendWayCreated = await waitFor(() => !!G.World.getWay(extWayId), 8000);
    const extWay = G.World.getWay(extWayId);
    const nodesBefore = extWay ? extWay.nodes.length : 0;
    out.extendNodesBefore = nodesBefore;
    if (extWay) {
      G.UI.selectTool('extend');
      G.Editor.select('way', extWayId);
      const endNode = G.World.getNode(extWay.nodes[extWay.nodes.length - 1]);
      G.Editor.pickExtendAnchor(L.latLng(endNode.lat, endNode.lon));
      out.extendAnchorPicked = !!G.Editor._extendAnchor && G.Editor._extendAnchor.end === 'end';
      G.Editor._addDrawPoint(L.latLng(endNode.lat + 0.0006, endNode.lon + 0.0006));
      G.Editor._addDrawPoint(L.latLng(endNode.lat + 0.0012, endNode.lon + 0.0012));
      out.extendPending = G.Editor.pending.length;
      G.Editor.finishExtend();
      out.extendGrew = await waitFor(() => {
        const w = G.World.getWay(extWayId);
        return w && w.nodes.length === nodesBefore + 2;
      }, 12000);
      await new Promise((r) => setTimeout(r, 400));
      out.extendNodes = G.World.getWay(extWayId) ? G.World.getWay(extWayId).nodes.length : 0;
      out.extendFirstNodeKept = (() => {
        const w = G.World.getWay(extWayId);
        return !!(w && extWay && w.nodes[0] === extWay.nodes[0]);
      })();
      await G.Editor.undo();
      out.extendUndone = await waitFor(() => {
        const w = G.World.getWay(extWayId);
        return w && w.nodes.length === nodesBefore;
      }, 10000);
      out.extendToasts = toasts();
      out.extendErrors = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '';
      G.UI.selectTool('select');
    }

    // 搜索面板：搜索并点击第一条结果（覆盖 搜索 → 地图跳转 → 选中 这条链路）
    G.UI.toggleSearch(true);
    document.querySelector('#search-input').value = '天安门';
    await G.UI.runSearch();
    out.searchResults = document.querySelectorAll('#search-results li').length;
    out.searchFirst = document.querySelector('#search-results li') ? document.querySelector('#search-results li').textContent.replace(/\\\\s+/g, ' ').trim() : '';
    const firstResult = document.querySelector('#search-results li');
    if (firstResult) {
      firstResult.click();
      await new Promise((r) => setTimeout(r, 2200));
      out.searchJumpSelected = document.querySelector('#status-select').textContent.includes('已选中');
    }
    out.errorsAfterSearchJump = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent.trim() : '';
    G.UI.toggleSearch(false);

    // 导出面板
    G.UI.openExport();
    out.exportLinks = document.querySelectorAll('#export-options a.export-btn').length;
    document.querySelector('#export-close').click();

    // 历史面板
    await G.UI.openHistory();
    out.historyRows = document.querySelectorAll('#history-list .history-row').length;
    document.querySelector('#history-close').click();

    // 图层开关
    const cb = document.querySelector('#layer-list input[data-cat="building"]');
    const beforeHide = G.Render.stats.features;
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    out.featuresAfterHide = G.Render.stats.features;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    out.featuresAfterShow = G.Render.stats.features;

    // 缩放后应重新取数据（分级显示）
    G.App.map.setZoom(13);
    await new Promise(r => setTimeout(r, 2500));
    out.zoom13Ways = G.World.ways.size;
    G.App.map.setZoom(18);
    await new Promise(r => setTimeout(r, 3000));
    out.zoom18Features = G.Render.stats.features;
    out.statusText = document.querySelector('#status-counts').textContent.replace(/\\\\s+/g, ' ').trim();

    out.clientErrors = document.querySelector('#client-errors') ? document.querySelector('#client-errors').textContent : '';
    out.toasts = toasts();

    // ---------- 收尾：回滚本次测试产生的所有变更集，让数据集恢复原样 ----------
    try {
      const hist = await (await fetch('/api/history?token=' + encodeURIComponent(G.Net.token))).json();
      const mine = (hist.changesets || []).filter((c) => c.author === G.UI.myId && !c.reverted);
      let reverted = 0;
      for (const cs of mine) {
        const ack = await G.Net.op({ k: 'revertChangeset', id: cs.id }).catch(() => null);
        if (ack && ack.ok) reverted += 1;
      }
      out.revertedChangesets = reverted;
      out.pendingChangesets = mine.length;
    } catch (e) {
      out.cleanupError = e.message;
    }
    return out;
  } catch (err) {
    out.fatal = (err && err.message) || String(err);
    out.toastsAtFail = toasts();
    return out;
  }
})()`;

(async () => {
  console.log('\n=== OSM 编辑器 · 浏览器端到端测试 ===\n');
  let server = null;
  if (OWN_SERVER) {
    console.log(`本套件自启测试服务器（游客通道打开）：${BASE}`);
    server = startServer();
    await waitReady();
  }
  const health = await (await fetch(BASE + '/api/health')).json();
  console.log(`服务器：${BASE}  数据集：${health.data.nodes} 节点 / ${health.data.ways} 道路 / ${health.data.relations} 关系\n`);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const browser = findBrowser();
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1680,1000', BASE + '/?guest=1',
  ], { stdio: 'ignore' });

  let client = null;
  let shotTaken = false;
  try {
    const page = await waitCDP();
    client = await cdp(page.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await sleep(4000);

    // 先在最干净的初始状态下截一张图（用于像素自检，此时还没做任何编辑）
    try {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, 60000);
      fs.writeFileSync(path.join(__dirname, 'screenshot.png'), Buffer.from(shot.data, 'base64'));
      shotTaken = true;
      console.log('已截图 tests/screenshot.png（初始地图状态）');
    } catch (err) {
      console.log('截图失败: ' + err.message);
    }

    console.log('▶ 驱动真实界面');
    const out = await evaluate(client, PAGE_SCRIPT);
    if (out.fatal) {
      console.log('  ⚠ 页面脚本中断于: ' + out.fatal);
      if (out.toastsAtFail && out.toastsAtFail.length) console.log('  ⚠ 页面提示: ' + out.toastsAtFail.join(' | '));
    }
    check('页面已连接服务器（游客身份）', out.connected === true, String(out.meName));
    check('样式表与预设已加载', out.categories >= 8 && out.presets >= 110, `${out.categories} 个图层分类 / ${out.presets} 个预设`);
    check('工具栏与图层面板已渲染', out.toolsRendered >= 8 && out.layersRendered >= 8, `${out.toolsRendered} 个工具 / ${out.layersRendered} 个图层`);
    check('真实北京数据已载入浏览器', out.dataLoaded === true && out.counts && out.counts.ways > 50,
      out.counts ? `${out.counts.ways} 道路 / ${out.counts.nodes} 节点` : '');
    check('矢量地图已渲染出要素', out.rendered === true && out.features > 20, `${out.features} 个要素，渲染耗时 ${out.renderMs}ms`);
    check('渲染过程没有异常', !out.rebuildError && !out.lastRenderError,
      out.rebuildError || out.lastRenderError || '无');
    check('没有元素被容错跳过', !out.skipped, `跳过 ${out.skipped || 0} 个`);
    check('地图标签已绘制', out.labels > 0, `${out.labels} 个标签`);

    check('新建道路自动带上默认标签（名字/车道/单行）',
      out.defaultRoadCreated === true && out.defaultRoadTags
      && out.defaultRoadTags.highway === 'residential' && out.defaultRoadTags.lanes === '2'
      && out.defaultRoadTags.oneway === 'no' && out.defaultRoadTags.name === '默认标签测试路',
      JSON.stringify(out.defaultRoadTags));
    check('新建建筑自动带上 building 与 building:levels',
      out.defaultBuildingCreated === true && out.defaultBuildingTags
      && out.defaultBuildingTags.building === 'yes' && out.defaultBuildingTags['building:levels'] === '5'
      && out.defaultBuildingTags.name === '默认标签测试楼',
      JSON.stringify(out.defaultBuildingTags));

    check('框选能选中区域内多个元素', out.boxSelected > 0 && !out.boxErrors,
      `选中 ${out.boxSelected} 个${out.boxErrors ? ' 错误:' + out.boxErrors : ''}`);
    check('框选后可以批量套用标签', out.boxTagged === true);

    check('聚焦模式：轨道被单独提到最上层绘制', out.focusRailShapes > 0,
      `聚焦图形 ${out.focusRailShapes} 个 · 总绘制 ${out.focusRailDrawn}`);
    check('交通面板能打开并显示公司资产', out.panelOpen === true && out.panelTabs >= 5 && out.panelRows >= 3,
      `${out.panelTabs} 个页签 · ${out.panelRows} 行数据 · ${out.panelText.slice(0, 60)}`);
    check('时钟控件能切换倍速并同步到服务端',
      out.hasClock === true && out.clockSpeedAfter === 1 && (out.clockSpeedAfter !== out.clockSpeedBefore || !!out.clockDirectAck),
      `${out.clockSpeedBefore} → ${out.clockSpeedAfter}（${out.clockText}）${out.clockDirectAck ? ' 直连结果:' + out.clockDirectAck : ''}${out.clockDirectError ? ' 直连错误:' + out.clockDirectError : ''}${out.clockToasts && out.clockToasts.length ? ' 提示:' + out.clockToasts.join('|') : ''}`);
    check('人口热力图能加载真实网格数据', out.popCells > 0, `${out.popCells} 个网格`);
    check('车站工具能在真实铁路上建站',
      out.hasRailInView === true ? (out.stationCreated === '浏览器测试车站' && out.myStations >= 1) : true,
      out.hasRailInView ? `已建 ${out.myStations} 个站${out.stationError ? ' 错误:' + out.stationError : ''}` : '视野内没有铁路，跳过');
    check('交通图层绘制无异常', !out.transitErrors, out.transitErrors || '无错误');

    check('手动添加 building:levels 不会丢（只改 key 时不许删行）',
      out.hasBldNoLevels === false || (out.rowSurvivesKeyEdit === true && out.levelsSaved === true),
      `行的存活=${out.rowSurvivesKeyEdit} 保存成功=${out.levelsSaved}`);
    check('建筑楼层控件可用（不用手打标签）', out.hasBldNoLevels === false || (out.floorsCtlShown === true && out.levelsViaControl === true),
      `控件显示=${out.floorsCtlShown} 设为 9 层=${out.levelsViaControl}`);
    check('画之前右侧就有创作面板（可选类型/填名字/定楼层）',
      out.createPanelShown === true && out.createPanelChips > 5 && /将写入标签/.test(out.createPanelWillWrite || ''),
      `${out.createPanelChips} 个类型 · ${out.createPanelWillWrite}`);
    check('在创作面板里选类型会直接决定新建要素的标签',
      out.hasRoadPresetChip === true && /highway/.test(out.presetApplied || ''),
      `选中后：${out.willWriteAfter || out.presetApplied}`);
    check('状态栏有撤销/重做按钮', out.hasUndoButton === true);
    check('点撤销按钮能真正撤掉上一步', out.undoButtonWorked === true);
    check('默认档位（完整）在城市尺度（z11）不丢要素：道路一条不缺、没有计划外缺失',
      !!out.cityComplete && out.cityDetail === 0 && out.cityComplete.roadsMissing === 0
      && out.cityComplete.areasMissingUnexpected === 0 && out.citySkippedSmall === 0,
      out.cityComplete
        ? `档位「${out.cityComplete.detailName}」· z11 面 ${out.cityFills} 个 / 总绘制 ${out.cityDrawn} 个图形 · 视野内道路 ${out.cityComplete.roadsInView} 条缺 ${out.cityComplete.roadsMissing} 条 · 面 ${out.cityComplete.areasInView} 个缺 ${out.cityComplete.areasMissing} 个（区块简化 ${out.cityComplete.degradedAreasMissing} 个，计划外 ${out.cityComplete.areasMissingUnexpected} 个）`
        : '页面取不到 completeness()');
    check('默认档位（完整）在低缩放（z13）也不丢小块面（公园/小区绿地）',
      !!out.z13Complete && out.z13Complete.detail === 0 && out.z13Complete.roadsMissing === 0
      && out.z13Complete.areasMissingUnexpected === 0 && out.z13SkippedSmall === 0,
      out.z13Complete
        ? `z13 面 ${out.z13Fills} 个 · 按面积跳过 ${out.z13SkippedSmall} 个 · 面缺 ${out.z13Complete.areasMissing} 个（其中区块简化 ${out.z13Complete.degradedAreasMissing} 个，计划外 ${out.z13Complete.areasMissingUnexpected} 个）`
        : '页面取不到 completeness()');
    check('建筑绘制层级在道路之上（高楼能挡住后面的道路）', out.buildingPaneZ > out.roadPaneZ,
      `建筑 pane z=${out.buildingPaneZ} vs 道路 pane z=${out.roadPaneZ}`);
    check('车站可以像建筑一样点选并删除',
      !out.myStationId || (out.stationSelected === true && out.stationDeleteBtn === true && out.stationDeleted === true),
      out.myStationId
        ? `选中=${out.stationSelected} 弹窗里有删除按钮=${out.stationDeleteBtn} 已删除=${out.stationDeleted}（弹窗内容：${out.stationPopupText || ''}）`
          + (out.stationDeleteToast && out.stationDeleteToast.length ? ` 提示:${out.stationDeleteToast.join('|')}` : '')
        : '本次没建成车站，跳过');
    check('以上改动没有引入页面错误', !out.fixErrors, out.fixErrors || '无错误');
    check('工具类型隔离：车站不套道路/建筑标签',
      out.stationPanelChips === 0 && /将创建/.test(out.stationPanelWrite || '') && !/highway=|building=/.test(out.stationPanelWrite || '') &&
      out.stationTagsEmpty === '{}' && /highway/.test(out.linePanelTags) && /building/.test(out.areaPanelTags),
      `车站：${out.stationPanelWrite}；道路 ${out.linePanelTags}；建筑 ${out.areaPanelTags}`);
    check('经济系统已关闭（公司页不再显示资金与票价）',
      out.economyOff === true && !/资金/.test(out.companyPanelText || ''),
      (out.companyPanelText || '').slice(0, 80));
    check('车辆系统：可选车型并新建车队车辆',
      out.vehicleKindChips >= 5 && out.busCreated === true && /12m|80人/.test(out.newBus || ''),
      `${out.vehicleKindChips} 种车型 · 新建 ${out.newBus || out.busError}`);
    check('撤销能撤掉交通操作（新建车辆）', out.vehicleUndone === true,
      `车辆数恢复到新建前=${out.vehicleUndone}（按了 ${out.vehicleUndoAttempts} 次撤销；OSM 与交通是同一条时间线，先撤最近一步，最后必然撤到新建的车辆）`
      + (out.vehicleUndoTips && out.vehicleUndoTips.length ? ' 过程提示:' + out.vehicleUndoTips.join('|') : '')
      + (out.transitUndoTip && out.transitUndoTip.length ? ' 提示:' + out.transitUndoTip.join('|') : ''));
    check('交通界面流程无报错', !out.flowErrors, out.flowErrors || '无错误');
    check('建筑按远近排序绘制（前面的高楼才能挡住后面的）',
      out.depthRange && out.depthRange[0] <= out.depthRange[1] && out.buildingCountAt18 > 5,
      `z18 建筑 ${out.buildingCountAt18} 个 · 深度范围 ${JSON.stringify(out.depthRange)} · zoom=${out.depthZoom} focus=${out.depthFocus} bias=${out.depthBias} detail=${out.depthDetail} skipped=${out.depthSkipped} err=${out.depthErr || '无'}`);

    check('默认档位（完整）不做骨架过滤：z11 上不许丢东西（建筑/小路不会被砍掉）',
      !!out.lodZ11 && out.lodZ11.detail === 0 && out.lodZ11.roadsMissing === 0
      && out.lodZ11.areasMissingUnexpected === 0 && out.lodZ11.honest === true,
      out.lodZ11
        ? `z11「${out.lodZ11.detailName}」档：建筑 ${out.lodZ11.buildings} 个 · 小路 ${out.lodZ11.minorWays} 条 · 主干 ${out.lodZ11.majorWays} 条（共 ${out.lodZ11.wayCount} 条）· 视野内道路 ${out.lodZ11.roadsInView} 条缺 ${out.lodZ11.roadsMissing} 条 · 面 ${out.lodZ11.areasInView} 个缺 ${out.lodZ11.areasMissing} 个（计划外 ${out.lodZ11.areasMissingUnexpected} 个）`
        : '');
    check('分级显示：中缩放（z14）出现次要道路；3D 建筑挤出仍从 z17 起（z14 挤出=0）',
      out.lodZ14 && out.lodZ14.buildings === 0 && out.lodZ14.minorWays > 0,
      out.lodZ14 ? `z14 建筑挤出 ${out.lodZ14.buildings} 个 · 次要道路 ${out.lodZ14.minorWays} 条 · 共 ${out.lodZ14.wayCount} 条` : '');
    check('分级显示：放大到 z17 才开始 3D 挤出建筑',
      out.lodZ17 && out.lodZ17.buildings > 0,
      out.lodZ17 ? `z17 建筑挤出 ${out.lodZ17.buildings} 个` : '');
    check('显式切到「骨架」档（G.Render.setDetail(3)）后只剩主干骨架：建筑=0、小路=0、主干>0',
      !!out.lodZ11Skeleton && out.lodZ11Skeleton.detail === 3 && out.lodZ11Skeleton.buildings === 0
      && out.lodZ11Skeleton.minorWays === 0 && out.lodZ11Skeleton.majorWays > 0,
      out.lodZ11Skeleton
        ? `骨架档「${out.lodZ11Skeleton.detailName}」：主干 ${out.lodZ11Skeleton.majorWays} 条 · 建筑 ${out.lodZ11Skeleton.buildings} 个 · 小路 ${out.lodZ11Skeleton.minorWays} 条（共 ${out.lodZ11Skeleton.wayCount} 条）`
        : '');

    check('延长：选中端点后能追加节点（原有顺序不变）',
      out.extendWayCreated === true && out.extendAnchorPicked === true && out.extendPending === 2 &&
      out.extendGrew === true && out.extendFirstNodeKept === true && !out.extendErrors,
      `节点 ${out.extendNodesBefore} → ${out.extendNodes}；提示 ${(out.extendToasts || []).join(' | ') || '无'}${out.extendErrors ? ' 错误:' + out.extendErrors : ''}`);
    check('延长：一次撤销即可还原', out.extendUndone === true);
    check('顶栏不再堆数据集统计（已收进「服务器资讯」窗口）', !/节点|道路/.test(out.dataInfo || ''),
      `顶栏资讯区文本：「${out.dataInfo || ''}」`);

    check('能选中真实的 OSM 建筑并显示标签', out.hasBuilding === true && out.selected === true,
      `${out.inspTitle} · ${out.tagRows} 个标签`);
    check('检查器显示几何信息', /节点|长度/.test(out.geometryInfo || ''), out.geometryInfo);
    check('通过界面编辑标签并保存成功', out.tagSaved === true, JSON.stringify(out.savedTags));

    check('绘制区域时有预览', out.drawPreview === 4, `${out.drawPreview} 个待定顶点`);
    check('绘制区域并新建成功', out.drawCreated === true && !!out.drawnId,
      `way#${out.drawnId} · ${out.drawnNodes} 个节点 · 闭合=${out.drawnClosed}`);
    check('绘制的区域是闭合的（首尾共用节点）', out.drawnClosed === true, `闭合=${out.drawnClosed}`);
    check('Ctrl+Z 撤销后绘制的内容消失', out.undoRemoved === true, out.undoViaApi ? '（通过编辑器接口撤销）' : '（通过快捷键撤销）');
    check('鼠标移动时绘制预览提示正常（回归：LatLng.lng/lon 混用）',
      out.cursorLatLngSet === true && out.previewTipActive === true && !out.errorsAfterMousePreview,
      `光标坐标=${out.cursorLatLngSet} 提示=${out.previewTipActive} 错误=${out.errorsAfterMousePreview || '无'}`);
    check('节点工具下选中并绘制手柄无异常', out.hasNodeTarget === true && !out.errorsAfterNodeTool,
      out.errorsAfterNodeTool || '无错误');

    check('搜索「天安门」返回真实结果', out.searchResults > 0, `${out.searchResults} 条，首条：${out.searchFirst}`);
    check('点击搜索结果能跳转并选中该元素', out.searchJumpSelected === true && !out.errorsAfterSearchJump,
      out.errorsAfterSearchJump ? '错误：' + out.errorsAfterSearchJump : '无错误');
    check('导出面板给出下载入口', out.exportLinks >= 2, `${out.exportLinks} 个导出选项`);
    check('历史面板列出编辑记录', out.historyRows >= 1, `${out.historyRows} 个变更集`);
    check('图层开关能隐藏/显示建筑', out.featuresAfterHide < out.featuresBefore || out.featuresAfterHide < out.featuresAfterShow,
      `显示 ${out.features} → 隐藏 ${out.featuresAfterHide} → 恢复 ${out.featuresAfterShow}`);
    check('缩放后重新加载数据（分级显示生效）', out.zoom13Ways > 0 && out.zoom18Features > 0,
      `z13 本地 ${out.zoom13Ways} 道路，z18 渲染 ${out.zoom18Features} 个要素`);
    check('状态栏显示统计', /道路|要素/.test(out.statusText || ''), out.statusText);
    check('页面无脚本错误', (out.clientErrors || '').trim() === '', (out.clientErrors || '无').slice(0, 200));
    check('测试结束后回滚了自己产生的改动（不污染数据集）',
      !out.cleanupError && out.revertedChangesets === out.pendingChangesets,
      `回滚 ${out.revertedChangesets}/${out.pendingChangesets} 个变更集${out.cleanupError ? ' 错误:' + out.cleanupError : ''}`);
    check('已生成界面截图用于像素自检', shotTaken === true);
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
