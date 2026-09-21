'use strict';
/** 启动流程：读取配置 → 初始化地图/渲染/编辑器 → 登录 → 连接服务器 → 加载视口数据 */
(function () {
  const { util, Net, World, Render, Editor, Inspector, UI, MapData, Transit } = window.G;

  const App = {
    map: null,
    booting: false,
    // 视角缓存键带版本号：旧版本（游戏版）存的是 {lat,lng}，读错会直接让初始化崩掉
    VIEW_KEY: 'osmcity.view.v2',
    LEGACY_KEYS: ['osmcity.view', 'osmcity.basemap'],

    /** 读取上次的视角，任何脏数据一律忽略并回退到默认中心 */
    savedView(meta) {
      const fallback = util.validLL(meta.defaultCenter) || { lat: 39.9042, lng: 116.4074 };
      const fallbackZoom = Number.isFinite(Number(meta.defaultCenter && meta.defaultCenter.zoom))
        ? Number(meta.defaultCenter.zoom) : 16;
      let raw = util.storage.get(App.VIEW_KEY, null);
      if (!raw) {
        // 兼容旧键（两个版本格式不同，靠 validLL 统一消化）
        raw = util.storage.get('osmcity.view', null);
        if (raw) util.storage.del('osmcity.view');
      }
      const ll = raw ? util.validLL(raw) : null;
      const zoom = raw && Number.isFinite(Number(raw.zoom)) ? Math.max(3, Math.min(22, Number(raw.zoom))) : null;
      if (raw && !ll) console.warn('[app] 忽略无法解析的历史视角缓存:', JSON.stringify(raw));
      return {
        center: ll ? [ll.lat, ll.lng] : [fallback.lat, fallback.lng],
        zoom: zoom == null ? fallbackZoom : zoom,
        usedFallback: !ll,
      };
    },

    /**
     * **初始化进度的界面（B 方案）**：服务器现在是"端口先开、页面先出、重活切片初始化"，
     * 初始化期间所有 /api/* 都回 `503 {ready:false, message, progress:{stage,percent}}`。
     * 于是页面不再是一个干等的转圈，而是显示「正在初始化路网…（阶段 N%）」，
     * 并且**自动重试**（每 500 ms，直到就绪）。
     *
     * 节点**常驻在 index.html 里**（`#boot-progress`，默认 `.hidden`）：这里只做三件事 ——
     * 去掉 `.hidden`、写文字、设进度条宽度；就绪后 hideBootProgress() 把 `.hidden` 加回来。
     * 样式全在 app.css 第 17.2 节（.boot-error 就是那层全屏底，z-index 90 压得住登录弹窗）。
     * 万一静态节点被谁删了，下面这段兜底会照着**同一套类名**再建一个，长得一模一样。
     */
    bootProgressEl: null,
    showBootProgress(text, detail, percent) {
      let box = document.getElementById('boot-progress');
      if (!box) {
        box = document.createElement('div');
        box.id = 'boot-progress';
        box.className = 'boot-error';
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.innerHTML = '<div class="boot-progress-card">'
          + '<div id="boot-progress-text"></div>'
          + '<div class="boot-progress-track"><div id="boot-progress-bar"></div></div>'
          + '<div id="boot-progress-detail" class="muted"></div>'
          + '</div>';
        document.body.appendChild(box);
      }
      box.classList.remove('hidden');       // 静态节点默认是 .hidden：这里才是"显出来"的那一步
      const t = document.getElementById('boot-progress-text');
      const d = document.getElementById('boot-progress-detail');
      const bar = document.getElementById('boot-progress-bar');
      if (t) t.textContent = text;
      if (d) d.textContent = detail || '';
      if (bar) bar.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%';
      App.bootProgressEl = box;
    },
    hideBootProgress() {
      // 只加回 .hidden，不删节点：静态节点删了 check-dom 会红，下次要显示还得重建
      const box = document.getElementById('boot-progress');
      if (box) box.classList.add('hidden');
      App.bootProgressEl = null;
    },

    /** 一次 /api/ready（免登录）：就绪与否都回 200，只要一份很轻的状态 */
    async readReady(fallback) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        try {
          const res = await fetch('/api/ready', { signal: ctl.signal });
          if (res.ok) return await res.json();
        } finally {
          clearTimeout(timer);
        }
      } catch { /* 端口还没开 / 断了一下：用上一次的状态继续等 */ }
      return fallback || null;
    },

    /**
     * 取 /api/meta，但**服务器还在初始化时不当作失败**：显示进度、等它就绪、自动重试。
     * 真正连不上（不是 503）才抛错，交给外层显示"无法连接服务器"。
     */
    async fetchMetaWhenReady() {
      const deadline = Date.now() + 10 * 60 * 1000;   // 首次启动要推算人口网格时可能是分钟级
      let state = null;
      for (;;) {
        let res = null;
        let resErr = null;
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 15000);
          try {
            res = await fetch('/api/meta', { signal: ctl.signal });
          } finally {
            clearTimeout(timer);
          }
        } catch (err) { resErr = err; }
        if (res && res.ok) {
          const meta = await res.json();
          if (!meta || meta.ready !== false) { App.hideBootProgress(); return meta; }
          state = meta;
        } else if (res && res.status === 503) {
          try { state = await res.json(); } catch { state = null; }
        } else if (res) {
          throw new Error('服务器返回 ' + res.status);
        } else if (Date.now() > deadline) {
          throw resErr || new Error('服务器一直没有响应');
        }
        if (state && state.error) {
          // 初始化真的失败了：说清楚原因，别让用户一直等
          App.showBootProgress('初始化失败：' + state.error, '服务器日志里有详情（node server/index.js 那个窗口）', 100);
          throw new Error('服务器初始化失败：' + state.error);
        }
        // 进度以免登录的 GET /api/ready 为准（它不碰数据库，回得最快）
        state = await App.readReady(state) || state;
        const p = (state && state.progress) || null;
        const pct = p && Number.isFinite(Number(p.percent)) ? Number(p.percent) : 0;
        const label = (p && (p.stageMessage || p.label)) || (state && state.detail) || '';
        App.showBootProgress(
          '正在初始化路网…（阶段 ' + Math.round(pct) + '%）',
          label + (state && state.listenMs ? ' · 端口已开（' + state.listenMs + ' ms），页面先出来了，数据随后就到' : ''),
          // ⚠ 第三个参数（百分比）必须传：漏了的话文字里的 N% 照旧往上走，
          // 进度条却一直停在 0%（showBootProgress 里 Number(undefined) || 0）。
          // tmp-verify/readygate/client-harness.js 就是抓这条的。
          pct
        );
        if (Date.now() > deadline) throw new Error('服务器初始化超时（超过 10 分钟）');
        await new Promise((r) => setTimeout(r, 500));
      }
    },

    async boot() {
      if (App.booting) return;
      App.booting = true;

      let meta;
      try {
        /**
         * 取配置要有上限：服务器是**单线程 + 同步 SQLite**，一大片 /api/map
         * （一屏十几个请求，单个响应能到十几 MB）在飞的时候，/api/meta 会被排在后面
         * —— 实测能等到 10 秒以上（刷新页面时上一次页面加载的请求还在服务端排队，就会踩到）。
         * 没有超时的话这里会一直 await：App.booting 恒为 true，地图、渲染、登录全都不动，
         * 而**页面上不会出现任何提示** —— 用户看到的就是"地图根本加载不出来"。
         *
         * B 方案之后：初始化期间 /api/meta 会立刻回 503 + 进度，这里就地显示
         * 「正在初始化路网…（阶段 N%）」并自动重试（见 fetchMetaWhenReady）。
         */
        meta = await App.fetchMetaWhenReady();
      } catch (err) {
        App.hideBootProgress();
        document.body.innerHTML = '<div class="boot-error">无法连接服务器（或服务器正忙着处理其他地图请求）：'
          + '请确认 <code>node server/index.js</code> 正在运行，然后刷新页面。</div>';
        return;
      }
      window.G.meta = meta;
      util.storage.purge('osmcity.basemap'); // 旧版底图模式的遗留键，新版本用不到

      const view = App.savedView(meta);

      try {
        App.initMapAndUi(meta, view);
      } catch (err) {
        // 无论地图初始化出什么问题，都要让用户能登录、能看到原因，而不是卡在空白页
        reportClientError('地图初始化失败：' + (err && err.message ? err.message : String(err)));
        try {
          App.bindNet();
          UI.init(meta);
          UI.showLogin();
        } catch { /* 忽略次级错误 */ }
        App.booting = false;
        return;
      }

      if (meta.data && meta.data.nodes === 0) {
        util.hint('数据集为空：请先在服务器上运行 <b>node tools/import-osm.js --file data/osm/Beijing.osm.gz</b> 导入 OSM 数据，然后刷新页面。');
        util.toast('服务器还没有 OSM 数据，请先导入（见页面底部提示）', 'warn', 10000);
      }

      const params = new URLSearchParams(location.search);
      const token = localStorage.getItem('osmcity.token');
      /**
       * `?guest=1` 自动登录**要看服务器允不允许**（config.json 的 allowGuests，默认 false）：
       * 关掉时这个免注册入口整个不存在 —— 按钮被 UI.applyGuestPolicy() 藏了，
       * 地址栏里的 `?guest=1` 也不再偷偷把人塞进去，而是弹登录 / 注册框并把原因写清楚
       *（手里已经有账号会话的老书签照旧直接进去，不会被人踢回登录框）。
       * 老服务器（/api/meta 里没有 allowGuests）按"允许"处理，行为与改动前一致。
       */
      const allowGuests = !(meta && meta.allowGuests === false);
      const wantsGuest = params.get('guest') === '1';
      if (wantsGuest && allowGuests) {
        UI.guestLogin();
      } else if (token) {
        App.connectWithToken(token);
      } else if (wantsGuest) {
        await UI.guestLogin();          // 只写提示 + 弹登录框，不会发 /api/guest（见 ui.js）
      } else {
        UI.showLogin();
      }

      setInterval(() => Net.ping(), 25000);
      App.booting = false;
    },

    initMapAndUi(meta, view) {
      // 第一步只能在这里做：L.map 建不起来就没救了（外层 catch 会给出中文原因并保证还能登录）
      App.map = L.map('map', {
        center: view.center,
        zoom: view.zoom,
        zoomControl: false,
        preferCanvas: true,
        minZoom: 3,
        maxZoom: 22,
        worldCopyJump: true,
        attributionControl: false,
      });
      L.control.zoom({ position: 'bottomright' }).addTo(App.map);
      L.control.scale({ imperial: false, position: 'bottomright' }).addTo(App.map);

      /**
       * 剩下的每一步都**各自兜住**：历史上一次"读存档恢复界面状态"时的异常
       * （例如显示模式存的是轨交/公交，恢复时摸到了还没到的交通数据）
       * 会顺着 initMapAndUi 冒到外层 catch，整张地图与整块界面一起被判死 ——
       * 用户看到的就是"地图根本加载不出来"。
       * 现在单步失败只在错误条里留一行中文原因，地图、渲染、登录照常继续。
       */
      const step = (name, fn) => {
        try {
          return fn();
        } catch (err) {
          reportClientError(name + '初始化失败（地图已照常启动）：' + (err && err.message ? err.message : String(err)));
          return null;
        }
      };

      step('渲染层', () => {
        Render.init(App.map, {
          style: window.G.Style,
          getOverlayState: () => Editor.getOverlayState(),
          visibleCategories: new Set((window.G.Style.CATEGORIES || []).filter((c) => c.defaultVisible !== false).map((c) => c.id)),
        });
        Render.onCounts = util.debounce(() => { UI.updateStatus(); UI.refreshLayerCounts(); }, 250);
      });

      step('地图数据', () => {
        MapData.init(App.map, {
          onStats: () => { UI.updateStatus(); UI.refreshLayerCounts(); },
        });
      });

      step('编辑器', () => {
        Editor.init(App.map, {
          onStatus: () => { UI.updateStatus(); UI.renderToolOptions(); },
        });
      });

      step('属性检查器', () => Inspector.init());
      step('交通模块', () => Transit.init(meta));
      step('界面', () => UI.init(meta));

      step('地图事件', () => App.bindMap());
      step('网络事件', () => App.bindNet());
    },

    bindMap() {
      const map = App.map;
      const onMove = util.throttle((latlng) => {
        UI.setCoords(latlng);
        Net.move(latlng.lat, latlng.lng);
      }, 160);
      map.on('mousemove', (ev) => onMove(ev.latlng));
      map.on('moveend', () => {
        const c = map.getCenter();
        util.storage.set(App.VIEW_KEY, { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
        UI.updateStatus();
      });
      map.on('zoomend', () => UI.updateStatus());
      map.on('baselayerchange', () => { /* 预留 */ });
    },

    bindNet() {
      if (App._bound) return;
      App._bound = true;

      Net.on('welcome', (msg) => {
        UI.myId = msg.user.id;
        Editor.myId = msg.user.id;
        MapData.token = Net.token;
        UI.setInfo(msg.info);
        UI.setPlayers(msg.players || []);
        UI.setLocks(App.enrichLocks(msg.locks || {}));
        UI.hideLogin();
        if (msg.config) Transit.init({ config: msg.config });
        if (msg.transit) Transit.setSnapshot(msg.transit, true);
        Transit.setReady(msg.transitReady || null);
        Transit.renderClock();
        MapData.refresh();
        UI.systemMessage(`已进入编辑室（变更集 #${msg.changesetId}）`);
        if (msg.info && msg.info.source) {
          util.toast(`数据集：${msg.info.source} · ${util.fmtShort(msg.info.ways)} 条道路/区域`, 'success', 4000);
        }
      });

      Net.on('transitSync', (msg) => Transit.setSnapshot(msg.data, msg.full !== false));
      Net.on('sim', (msg) => Transit.applySim(msg));
      Net.on('transitAck', (msg) => Transit.onAck(msg));
      Net.on('transitError', (msg) => util.toast(msg.message || '交通操作失败', 'error'));

      Net.on('ops', (msg) => {
        const n = World.applyOps(msg.ops || []);
        if (!n) return;
        Render.markDirty();
        UI.refreshLayerCounts();
        const sel = Editor.selection;
        if (sel) {
          const affected = (msg.ops || []).some((op) => {
            const id = op.id || (op.node && op.node.id) || (op.way && op.way.id) || (op.relation && op.relation.id);
            return Number(id) === sel.id;
          });
          if (affected) {
            if (!World.get(sel.type, sel.id)) {
              Editor.deselect();
              util.toast('你选中的元素已被删除', 'warn');
            } else {
              Inspector.refresh();
            }
          }
        }
      });

      Net.on('players', (msg) => UI.setPlayers(msg.players || []));
      Net.on('locks', (msg) => UI.setLocks(App.enrichLocks(msg.locks || {})));
      Net.on('lockResult', (msg) => {
        if (msg.locked) util.toast(`${msg.by} 正在编辑这个元素，你的改动可能会被拒绝`, 'warn', 4000);
      });
      Net.on('chat', (msg) => UI.chat(msg.from, msg.text, msg.ts));
      Net.on('sys', (msg) => UI.systemMessage(msg.text));
      Net.on('info', (msg) => { UI.setInfo(msg.info); if (msg.locks) UI.setLocks(App.enrichLocks(msg.locks)); });
      Net.on('depth', (msg) => UI.setDepth(msg));
      Net.on('error', (msg) => {
        util.toast(msg.message, 'error', 5000);
        if (msg.fatal) UI.showLogin();
      });
      Net.on('status', (msg) => UI.connection(msg.state));
    },

    enrichLocks(locks) {
      const out = {};
      for (const [key, info] of Object.entries(locks)) {
        out[key] = { userId: info.userId, name: info.name, color: UI.colorOf(info.userId) };
      }
      Editor.locks = out;
      return out;
    },

    connectWithToken(token, user) {
      if (token) localStorage.setItem('osmcity.token', token);
      MapData.token = token;
      UI.hideLogin();
      Net.connect(token);
    },
  };

  window.G.App = App;

  function reportClientError(text) {
    const box = document.getElementById('client-errors');
    if (box) {
      const line = document.createElement('div');
      line.textContent = text;
      box.appendChild(line);
      box.classList.remove('hidden');
    }
    try { console.error('[client]', text); } catch { /* ignore */ }
  }
  window.addEventListener('error', (e) => {
    const stack = e.error && e.error.stack ? ' @ ' + String(e.error.stack).split('\n')[1] : '';
    reportClientError('页面脚本错误：' + (e.message || '未知错误') + stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    reportClientError('未处理的错误：' + ((r && r.message) || String(r)));
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.boot().catch((err) => reportClientError('初始化失败：' + err.message)));
  } else {
    App.boot().catch((err) => reportClientError('初始化失败：' + err.message));
  }
})();
