'use strict';
/**
 * **客户端模块的无浏览器宿主**（端到端测试用）。
 *
 * 为什么要有它：这次修的 bug 全在客户端那半（"本地缓存的版本号是过期的、而且冲突之后永远不刷新"），
 * 只用两个裸 WebSocket 客户端是验不出来的 —— 那样验的是**我猜的**客户端行为，不是**真的**客户端行为。
 * 所以这里把 public/js 里的真模块（util / net / world / mapdata / editor）**原样**装进一个最小 DOM，
 * 于是可以直接调 `Editor.select()` / `Editor.deleteSelection()` / `Editor.deleteAt()`，
 * 跑的就是浏览器里那一份代码（同一份 Net.op、同一份 World、同一份冲突自愈）。
 *
 * 用法：
 *   const { makeClient } = require('./client-vm');
 *   const c = makeClient({ base, token, name });
 *   await c.connect();                     // 真 WebSocket（net.js 自己那套重连/ack 处理）
 *   const vp = await c.loadViewport(box, 16);   // 真 /api/map + 真 World.mergePayload
 *   c.eval('window.G.World.nodes.get(2).version');
 *
 * 几个刻意为之的细节：
 *   · 视口载荷在 **vm 内**用 `JSON.parse` 解析（见 `loadViewport`）：宿主的 JSON.parse 造出来的
 *     数组在 vm 里 `Array.isArray` 是 false，会让真实模块的判定走偏（跨 realm 的经典坑）；
 *   · `util.toast` 在装载完之后被换成一个"记录器"（`client.toasts`）—— 交互路径完全不变，
 *     只是把最后那一下 DOM 追加换成入数组，方便断言"到底对用户说了什么"；
 *   · 不装载 render.js / inspector.js / ui.js（它们要 Leaflet 与整页 DOM）：给一个最小 `Render` 桩，
 *     editor.js 只用到 `Render.pick / markDirty / overlay.redraw / resetPickCycle`。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
/** 装载顺序与 public/index.html 里的 <script> 一致（check-load-order.js 校验的就是这个顺序） */
const CLIENT_FILES = ['util.js', 'net.js', 'world.js', 'mapdata.js', 'editor.js'];

/** 最小 DOM 节点：够 util.toast / classList / appendChild 用 */
function makeEl(id, className) {
  const set = new Set(String(className || '').split(/\s+/).filter(Boolean));
  const node = {
    id,
    className: className || '',
    style: {},
    dataset: {},
    children: [],
    textContent: '',
    innerHTML: '',
    classList: {
      contains: (c) => set.has(c),
      add: (c) => { set.add(c); return node; },
      remove: (c) => { set.delete(c); return node; },
      toggle: (c, on) => { if (on) set.add(c); else set.delete(c); return node; },
    },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { node.children.push(child); return child; },
    removeChild(child) { const i = node.children.indexOf(child); if (i >= 0) node.children.splice(i, 1); return child; },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1400, height: 900, right: 1400, bottom: 900 }; },
    focus() {},
    blur() {},
    click() {},
  };
  return node;
}

/**
 * 造一个客户端。
 * @param {{base:string, token:string, name?:string}} options base 形如 http://127.0.0.1:8921
 */
function makeClient(options) {
  const base = options.base;
  const host = new URL(base);
  const toasts = [];
  const opCalls = [];
  const els = new Map();
  const elOf = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };

  const document = {
    readyState: 'complete',
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById: (id) => elOf(id),
    querySelector: (sel) => (typeof sel === 'string' && sel.startsWith('#') ? elOf(sel.slice(1)) : null),
    querySelectorAll: () => [],
    createElement: (tag) => makeEl('created-' + tag),
    createElementNS: (ns, tag) => makeEl('created-' + tag),
    createTextNode: (t) => ({ textContent: t }),
    addEventListener() {},
    removeEventListener() {},
  };

  const localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(String(k), String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return Array.from(this._m.keys())[i] ?? null; },
    get length() { return this._m.size; },
  };

  /** 浏览器语义：以 / 开头的相对地址按页面地址补全（Node 的 fetch 不认相对 URL） */
  const browserFetch = (input, init) => {
    const url = (typeof input === 'string' && input.startsWith('/')) ? base + input : input;
    return globalThis.fetch(url, init);
  };

  const window = {
    G: {},
    location: { protocol: host.protocol, host: host.host, href: base + '/', search: '' },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    alert() {},
    fetch: browserFetch,
  };
  window.window = window;

  const sandbox = {
    window,
    document,
    localStorage,
    console,
    location: window.location,
    fetch: browserFetch,
    WebSocket,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    performance,
    Promise, JSON, Math, Number, String, Boolean, Object, Array, Error, TypeError, RangeError, Date,
    Map, Set, WeakMap, WeakSet, Symbol, RegExp, isNaN, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, Int32Array, Float64Array, Uint8Array,
    /**
     * ⚠ `TextDecoder` 不是 V8 的内建 primordial（`DataView`/`ArrayBuffer` 是，在 vm 的新 realm 里本来就有），
     * 所以不注入的话，`World.decodeBinaryPayload`（BIN v1 解码器）会直接报
     * `TextDecoder is not defined` —— 二进制载荷那条路径就量不到、也测不了。
     * 注入宿主的那一份（不自己写 JS 版解码器，否则会把耗时测高）。
     */
    TextDecoder, TextEncoder,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  /**
   * `Render` 桩必须在装载 editor.js **之前**放进 window.G：
   * editor.js 顶层就是 `const { util, World, Render, Net, MapData } = window.G;` ——
   * 装载完再补，闭包里那个 Render 永远是 undefined（_renderPreview 会炸）。
   */
  window.G.Render = {
    pick: () => null,
    markDirty() {},
    resetPickCycle() {},
    overlay: { redraw() {} },
    stats: {},
  };

  for (const file of CLIENT_FILES) {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'public/js/' + file });
  }

  /** vm 内的 JSON（见文件头说明：跨 realm 的数组判定） */
  vm.runInContext(
    'globalThis.__fetchJSON = async function (url) { const r = await fetch(url); return JSON.parse(await r.text()); };',
    sandbox,
  );

  const G = window.G;
  // toast 记录器：交互路径完全不变，只是把"最后写 DOM"换成"入数组"（断言用户到底看到了什么）
  G.util.toast = (message, kind) => { toasts.push({ message: String(message == null ? '' : message), kind: kind || 'info' }); };
  G.MapData.token = options.token;
  /**
   * 这个宿主里没有 main.js，但 main.js 里有一段**属于客户端行为**的必需逻辑：
   * 作者自己那条 ack 路径（`Net.emit('ops', { self: true })`）要把 ops 合并进本地库 ——
   * 不合并的话，"删除成功"只发生在服务器上，本地缓存还留着那个元素（画面也不会更新）。
   * 这里照抄 main.js 的那一段（去掉 UI/Inspector 那些不在本宿主里的调用）。
   * 别人的广播不走这里：net.js 的 applyRemoteOps 已经合并过了（remote:true）。
   */
  G.Net.on('ops', (msg) => {
    if (!msg || msg.self === false) return;
    const n = G.World.applyOps(msg.ops || []);
    if (n && G.Render.markDirty) G.Render.markDirty();
  });

  const client = {
    base,
    name: options.name || '',
    token: options.token,
    window,
    G,
    Net: G.Net,
    World: G.World,
    MapData: G.MapData,
    Editor: G.Editor,
    toasts,
    opCalls,

    /** 在 vm 里跑一段代码（返回值是 vm realm 的值；断言只读基本类型/字符串） */
    eval(code) { return vm.runInContext(code, sandbox, { filename: 'client-eval' }); },

    /** 装了哪些模块（自检用） */
    modules() {
      return Object.keys(G).filter((k) => G[k] && typeof G[k] === 'object').sort();
    },

    connect(timeoutMs = 8000) {
      G.Net.connect(options.token);
      return client.waitFor(() => G.Net.connected, timeoutMs, 'WebSocket 连接');
    },

    /** 轮询等待一个条件（宿主侧，简单可靠） */
    async waitFor(pred, timeoutMs = 8000, label = '条件') {
      const t0 = Date.now();
      for (;;) {
        let ok = false;
        try { ok = !!pred(); } catch { ok = false; }
        if (ok) return true;
        if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    /**
     * 真 `/api/map` + 真 `World.mergePayload`（就是浏览器里那一条路）。
     * 载荷在 vm 内解析，所以 `mergePayload` 看到的是 vm realm 的数组/对象。
     */
    async loadViewport(box, zoom = 16, extra = '') {
      const url = `/api/map?minLon=${box.minLon}&minLat=${box.minLat}&maxLon=${box.maxLon}&maxLat=${box.maxLat}`
        + `&zoom=${zoom}&token=${encodeURIComponent(options.token || '')}${extra}`;
      const payload = await vm.runInContext(`__fetchJSON(${JSON.stringify(url)})`, sandbox, { filename: 'viewport' });
      const merged = G.World.mergePayload(payload);
      return { payload, merged };
    },

    /** 真 `/api/element`（vm 内解析），返回 data.element */
    async element(type, id) {
      const url = `/api/element?type=${type}&id=${id}&token=${encodeURIComponent(options.token || '')}`;
      const data = await vm.runInContext(`__fetchJSON(${JSON.stringify(url)})`, sandbox, { filename: 'element' });
      return data.element;
    },

    /** 发一个 OSM 操作（真 Net.op：含 ack/错误码/结构化冲突回执）；失败会 reject */
    op(opObject, timeoutMs) { return G.Net.op(opObject, timeoutMs); },

    /** 发一个操作并把失败也当结果收下来（用例里大量"故意失败"的断言用） */
    async tryOp(opObject, timeoutMs) {
      try {
        const ack = await G.Net.op(opObject, timeoutMs);
        return { ok: true, ack, code: null, message: '', conflict: null };
      } catch (err) {
        return {
          ok: false,
          ack: null,
          code: err && err.code ? err.code : null,
          message: String((err && err.message) || err),
          conflict: (err && err.conflict) || null,
          error: err,
        };
      }
    },

    /**
     * 记录 `Net.op` 的调用（用来断言"只重放了一次" / "权限错误一次都没重试"）。
     * 换掉的是真 Net.op 的外壳，行为不变。
     */
    spyOpCalls() {
      if (client._opSpied) return opCalls;
      client._opSpied = true;
      const real = G.Net.op.bind(G.Net);
      G.Net.op = (opObject, timeoutMs) => {
        const subs = opObject && Array.isArray(opObject.ops) ? opObject.ops : null;
        opCalls.push({
          k: opObject && opObject.k,
          id: opObject && opObject.id,
          version: opObject && opObject.version,
          cascade: opObject && opObject.cascade,
          label: opObject && opObject.label,
          subs: subs ? subs.length : 0,
          /** 批量操作的逐条版本号（断言"重放时用的是最新版本"用） */
          subVersions: subs ? subs.map((s) => s.version) : null,
        });
        return real(opObject, timeoutMs);
      };
      return opCalls;
    },

    /** 读一个元素在客户端缓存里的样子（宿主要的是纯数据，所以 vm 内 stringify、宿主再 parse） */
    world(type, id) {
      const json = client.eval(`(() => { const e = window.G.World.get(${JSON.stringify(type)}, ${Number(id)});`
        + ' return e ? JSON.stringify({ version: e.version || 0, tags: e.tags || null, lat: e.lat, lon: e.lon, nodes: e.nodes || null }) : null; })()');
      return json == null ? null : JSON.parse(String(json));
    },

    close() {
      try { G.Net.disconnect(); } catch { /* ignore */ }
    },
  };

  return client;
}

/** 服务端权威状态（测试侧直接问服务器，不走客户端缓存） */
async function serverElement(base, token, type, id) {
  const res = await fetch(`${base}/api/element?type=${type}&id=${id}&token=${encodeURIComponent(token)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/element ${type} ${id} → HTTP ${res.status}`);
  const data = await res.json();
  return data.element;
}

module.exports = { makeClient, serverElement, CLIENT_FILES, ROOT };
