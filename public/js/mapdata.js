'use strict';
/**
 * 视口数据加载：按当前缩放取服务器数据，缓存已取范围，避免重复请求。
 *
 * 关于"截断"（用户明确要求：禁止截断显示）：
 *   服务器单次 /api/map 返回的要素数量有上限（config.limits.viewportLimit，默认 15000）。
 *   以前碰到上限就只是弹一句"已截断显示"，画面上的路网真的会少一大半（而且是随机的一半）。
 *   现在改成：
 *     1. 每次响应都做上限检测（返回条数 ≥ 上限，或服务器置了 truncated）；
 *     2. 一旦发现被截断，就把这一块继续二分/四分，拆成更小的瓦片分别请求，
 *        直到每一块都不再被截断 —— 客户端不会拿到"半条路网"；
 *     3. 拆不动了（超出瓦片预算）也绝不假装完整：lastCapped 会如实记录缺了什么，
 *        状态栏给出中文提示，玩家放大地图后会自动补齐。
 *
 * 注意：Render 在 mapdata.js 之后才加载，必须延迟到调用时再从 window.G 取，不能在文件加载时解构。
 */
(function () {
  const { World, util } = window.G;

  const DEFAULTS = {
    maxRects: 24,          // 缓存范围上限（只清理与当前视野无关的旧范围）
    concurrency: 4,        // 同时在途的瓦片请求数
    tileBudget: 24,        // 一轮视口加载最多拆成多少块（0 表示不限制）
    maxDepth: 2,           // 瓦片二分最大深度：2 → 最多 4×4 = 16 块
    /**
     * 请求范围相对视野的外扩比例（Leaflet `LatLngBounds.pad()` 的语义：**每一边**外扩这么多，
     * 所以 pad=0.05 → 每边 +5%、总面积 ×1.21 —— 就是屏幕四边"别因为舍入漏一条缝"的那点余量）。
     *
     * **只加载"视野里的区块"**：绝不提前取前面一屏。
     * 于是一次拖动请求的范围**永远被一屏框住**，跟数据集/视野扩到多大无关 ——
     * 这正是"扩到全中国也不会崩"的前提。
     *
     * 实测（本机北京数据集，1400×900，服务端同步 SQLite 单线程；1200×800 视口量到的是同一档）：
     *   z16 一屏 9911 way / 785 ms；z13 一屏 15515 way / 1665 ms（触到服务端 15000 上限）；
     *   z11 一屏 14988 way / 3480 ms（同样触顶）。所以"范围"必须由视野定，不能由 pad 放大。
     */
    pad: 0.05,
    wayLimitFallback: 15000,
    capRatio: 0.98,        // 非成员 way 条数达到上限的这个比例也当作被截断（保守，避免误拆）
    /**
     * 空闲预取：视野数据齐全、地图静下来 idleMs 之后，在后台把视野外一圈也取回来。
     *
     * **默认关闭**（`on: d.prefetch === true` 才开）—— 按"视野里有哪些区块就只加载区块，
     * 区块之外坚决不加载"的原则，预取属于"提前取前面的屏"，一律不做。
     * 想临时换拖动延迟可以显式打开：`MapData.setPrefetch(true)`，或 `setPrefetch(true, 0.25)`
     * 换一圈的大小（pad 上限建议 ≤ 0.5 = 每边半屏）。开着的时候它仍然遵守
     * "视野不齐不预取 / 一次只发一条条带 / 新一轮视口加载作废旧预取"三条约束。
     */
    prefetchPad: 0.25,
    prefetchIdleMs: 900,
    /** 一轮预取最多入队几块（默认 1：一条条带一块，别一次发一堆） */
    prefetchMaxParts: 1,
    /** 缺口细分网格：把"还没取到的部分"切成 N×N 格挑出来（越大越精确，条带也越多） */
    gapGrid: 8,
    /**
     * 只请求"缺口"（默认开）：拖动时目标范围里已经取到的那部分不再重下一遍，
     * **只补新进视野的那一条缺口**（别把目标框整个重取）。
     * 关掉它就退回老行为（整个外扩范围重取一遍）—— 排查/对照用。
     *
     * 判据：缺口矩形的面积 ≤ 目标框面积 × gapMaxFrac → 走缺口路径（**一次请求只要缺口**）；
     * 否则说明是"全新的一屏"（缺口 ≈ 整个目标框，比如刚进页面 / 换了缩放），
     * 这时交给分块路径按缩放预切瓦片 —— 那种大请求必然被服务端截断，先切好可以少跑一趟。
     *
     * 0.95 这个数来自实测：
     *   · **拖半屏**：缺口占目标框 0.625（老值 0.6 正好把它挡在门外，于是退回"整屏重取"，
     *     白跑好几块请求、还多下一份已经在本地的东西）；
     *   · **拖整屏**：缺口是"新露出来的那一条"= 0.909（老值 0.6 同样挡住）；
     *   · **冷启动**：缺口 = 目标框 = 1.00 → 必须走分块路径（一屏 way 数在老档位会超过服务端上限：
     *     实测 z13 15515 / z15 15653 都触顶，z14 12724、z16 9911 不触顶）。
     * 0.95 正好把"拖动"全部收进缺口路径（一次请求），又把"冷启动"留给分块路径。
     * 缺口请求万一还是被服务端截断：只把那**一块**（缺口）拆成 4 块继续取
     * （见 ensure 里的 cappedNear 分支），**不会退回整屏那套瓦片**。
     *
     * ⚠ 上面"预切瓦片"的前提是"一屏装不下"。**服务端现在会广播 limits.coalesce**
     * （低缩放几何合并，见 server/osmdb.js 的 _coalesce）：z < minZoom 时它把高条数类的 way
     * 合并成 displayLines（只有几何、没有 way id 的视图用折线），实测 z10~z15 一屏**一次请求**
     * 就 `complete=true` 且不触上限（z13：payload 2.9 MB · 折线 929 条 · 逐条 way 3075 条）。
     * 所以那些缩放上不再预切瓦片 —— 一屏一次请求（见 _baseTileCount / coalesceAt）。
     * 服务端没广播（老服务端 / config 关掉了 coalesce）时逐字退回老行为。
     */
    gapFetch: true,
    gapMaxFrac: 0.95,
    gapMaxParts: 4,
  };

  /**
   * World 不在场时（自检 / 别的宿主）算保留区用的外扩比例。
   * 必须和 world.js 的 `KEEP_MARGIN_SCREENS / 2`（每边 0.25 屏）保持一致 ——
   * 两边口径不一致时会出现"World 已经把要素卸载了、MapData 却还认为这块已覆盖"的假覆盖。
   */
  const KEEP_PAD_FALLBACK = 0.25;

  /**
   * **"只看不改"边界（客户端唯一一处）** —— 与 `server/osmdb.js` 的 `VIEW_ONLY_MAX_ZOOM`（**14**）
   * 是同一条边界，但客户端**绝不写死这个数**：服务端把它随回显一起下发，这里只做"回显 → 边界"的换算。
   *
   *   · z ≤ **maxZoom**（默认 14）→ 服务端只发合并几何（`displayLines` / `displayAreas`，
   *     **一条 way id 都没有**）→ 这一档**点不中、也改不了**（拾取/编辑靠 way id）；
   *   · z ≥ **minZoom**（默认 15 = maxZoom + 1）→ 真 way id + 真实几何全量下发 → 拾取/编辑照常。
   *
   * 回显从哪来（三处说的都是同一个数，优先级从高到低）：
   *   1. 显式传进来的 echo（排查/自检用）；
   *   2. **最近一次 `/api/map` 响应自己的账本** `truncation.viewOnly.minZoom / .maxZoom` —— 这是
   *      "服务端真正用的那一次"的权威值，客户端**优先信它**；
   *   3. `/api/meta` 广播的 `limits.coalesce.minZoom`（配置里没写 `limits.coalesce` 时它是 null，
   *      所以只能当"还没收到过响应时的兜底"）。
   * 三处都读不到（老服务端）→ `null` → 调用方退回老行为，**不猜、也不写死数字**。
   *
   * 注意 meta 里的 `coalesce.on === false` 是**配置开关**（"整个关掉合并"），这时边界不存在；
   * 而响应账本里的 `on` 只表示"这一次请求有没有合并"（z15 起必然 false），所以读响应账本时
   * **不看 on、只看 minZoom/maxZoom**（否则一旦升到 z15 就再也想不起边界在哪了）。
   */
  const VIEW_ONLY_BOUNDARY = {
    /** 服务端回显的"完整可编辑"第一档（= 边界 + 1）；读不到返回 null */
    minZoom(echo, self) {
      const e = echo || (self && self.stats ? self.stats.viewOnly : null);
      // ① 响应账本（truncation.viewOnly / truncation.coalesce 说的都是同一组数）
      const fromEcho = e && (e.coalesce && e.coalesce.minZoom !== undefined ? e.coalesce
        : (e.minZoom !== undefined ? e : null));
      if (fromEcho) {
        const mz = Number(fromEcho.minZoom);
        if (Number.isFinite(mz) && mz > 0) return mz;
      }
      // ② /api/meta 广播的配置（`on:false` = 配置里整个关掉了合并 → 没有这条边界）
      const c = window.G && window.G.meta && window.G.meta.limits && window.G.meta.limits.coalesce;
      if (!c || c.on === false) return null;
      const mz = Number(c.minZoom);
      return Number.isFinite(mz) && mz > 0 ? mz : null;
    },
    /** "只看不改"的**最高**缩放（= minZoom − 1，默认 14）；读不到返回 null */
    maxZoom(echo, self) {
      const mz = VIEW_ONLY_BOUNDARY.minZoom(echo, self);
      if (mz == null) return null;
      const src = echo || (self && self.stats ? self.stats.viewOnly : null);
      const echoMax = src && Number(src.maxZoom);
      return Number.isFinite(echoMax) && echoMax >= 0 ? echoMax : mz - 1;
    },
    /** 某个缩放是不是"只看不改"的档（同 coalesceAt：按**请求缩放**判，含 zoomFloor） */
    at(zoom, self) {
      const L = self || MapData;
      const mz = VIEW_ONLY_BOUNDARY.minZoom(null, L);
      if (mz == null) return false;
      const z = zoom == null ? L.requestZoom() : Math.round(zoom);
      // 客户端可能用 zoomFloor 把请求缩放抬高（"全部道路"档 → 17），所以按**请求缩放**判
      return Math.max(z, Number(L.zoomFloor) || 0) < mz;
    },
  };

  /**
   * 造一个视口加载器。默认用于页面的单例；selfCheck() 用它再造一个"沙盒实例"，
   * 用假的 map/fetch 跑完整流程，所以自检不会碰到真实状态。
   */
  function createLoader(deps) {
    const d = Object.assign({
      map: null,
      fetch: (typeof fetch === 'function' ? fetch.bind(window) : null),
      limit: () => {
        const meta = window.G && window.G.meta;
        const n = meta && meta.limits && Number(meta.limits.viewportLimit);
        return Number.isFinite(n) && n > 0 ? n : DEFAULTS.wayLimitFallback;
      },
      markDirty: () => {
        const R = window.G && window.G.Render;
        if (R && R.markDirty) R.markDirty();
      },
      toast: (msg, kind) => util.toast(msg, kind),
      status: (msg) => util.statusHint(msg),
      world: World,
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
    }, deps || {});

    /** 往 World 的分阶段计时里记一笔（World 先加载，一定能拿到；拿不到就算了） */
    const perfAdd = (name, ms) => {
      try {
        if (d.world && typeof d.world.perfAdd === 'function') d.world.perfAdd(name, ms);
      } catch { /* 记账出问题不影响加载 */ }
    };

    const loader = {
      map: d.map,
      token: null,
      /** 已经拿到的范围（state: pending / loaded / capped / failed） */
      rects: [],
      rectZoom: null,
      inflight: 0,
      queue: [],
      fetching: false,
      loadSeq: 0,
      _load: null,
      /** 服务器单次返回上限（第一次加载时从 /api/meta 读出，自检可覆盖） */
      limit: null,
      /** 请求时至少用这个缩放级别（Detail 档位可以抬高它，拿到更细的道路） */
      zoomFloor: 0,
      /** 最近一次"服务器说返回不下了"的记录；没有截断时为 null */
      lastCapped: null,
      /** 统计：瓦片数、被截断的次数、缺了多少块 */
      tiles: { last: 0, depth: 0, capped: 0, split: 0, requested: 0 },
      /** 起始瓦片数的"记忆"：这次拆过块，下次直接按拆过的规模请求（少一次往返） */
      tilePref: 1,
      /**
       * 空闲预取（见 DEFAULTS.prefetchPad）：**默认关闭**，只有显式 setPrefetch(true) 才开。
       * 关着的时候"视野外的区块"既不发请求、也不留缓存范围。
       */
      prefetch: { on: d.prefetch === true, auto: true, timer: null, count: 0, ways: 0, running: false, lastAt: 0 },
      /** 上一次拖动的方向（-1..1）：预取优先补"继续往这个方向拖"会用到的那条带子 */
      lastDir: { lon: 0, lat: 0 },
      /**
       * 分阶段统计（拖动排查）：net（服务器+网络）/ parse（JSON）/ merge（合并进 World）/
       * index（空间索引插入）/ tiles（这一轮分成几块）…… 一次"拖一屏"慢在哪儿一眼看得出来。
       */
      stats: {
        lastMs: 0, lastCount: 0, truncated: false, loadedAt: 0,
        lastRedrawAt: 0, requests: 0, bytes: 0, tiles: 1, capped: 0, missing: 0,
        lastNetMs: 0, lastParseMs: 0, lastFetchMs: 0, lastMergeMs: 0, lastIndexMs: 0, lastApplyMs: 0,
        netMs: 0, parseMs: 0, mergeMs: 0, indexMs: 0, applyMs: 0,
        lastWays: 0, lastNodes: 0, lastTiles: 0, lastBytes: 0,
        prefetchTiles: 0, prefetchWays: 0,
        /**
         * 服务端的账本回显（客户端**只读不改**，状态栏/排查/自检用它自证）：
         *   serverComplete  这一块响应服务端证明是完整的（truncation.complete）
         *   stopReason      way 扫描为什么停下：'exhausted'（扫干净）/ 'pick' / 'cap'
         *   droppedWays     "该下发却没下发"的 way 条数（候选扫干净时才是精确值，否则 null）
         *   coalesce        z < limits.coalesce.minZoom 时服务端的低缩放合并账本（折线/点数/合并条数）
         *   displayLines    这一块响应带来的折线**条目**数（几何段数见 coalesce.paths）
         *   viewOnly        低缩放视图载荷的账本（面几何也只画不选；见 server/osmdb.js 的「低缩放视图载荷」）
         *   displayAreas    这一块响应带来的面条目数（量化 + 按像素简化的环，没有 way id）
         */
        serverComplete: false, stopReason: null, droppedWays: null, coalesce: null,
        displayLines: 0, lastDisplayLines: 0,
        viewOnly: null, displayAreas: 0, lastDisplayAreas: 0,
      },
      onStats: () => {},
      onRedraw: null,

      /* ------------------------------ 基本几何 ------------------------------ */
      bboxNow(pad = 0) {
        const b = loader.map.getBounds().pad(pad);
        const sw = b.getSouthWest();
        const ne = b.getNorthEast();
        return { minLon: sw.lng, minLat: sw.lat, maxLon: ne.lng, maxLat: ne.lat };
      },

      contains(outer, inner) {
        return outer.minLon <= inner.minLon && outer.maxLon >= inner.maxLon &&
          outer.minLat <= inner.minLat && outer.maxLat >= inner.maxLat;
      },

      /** 两个矩形的交集；没有交集返回 null */
      intersect(a, b) {
        const out = {
          minLon: Math.max(a.minLon, b.minLon), maxLon: Math.min(a.maxLon, b.maxLon),
          minLat: Math.max(a.minLat, b.minLat), maxLat: Math.min(a.maxLat, b.maxLat),
        };
        return (out.minLon <= out.maxLon && out.minLat <= out.maxLat) ? out : null;
      },

      pointInside(rect, lat, lon) {
        return rect.minLon <= lon && rect.maxLon >= lon && rect.minLat <= lat && rect.maxLat >= lat;
      },

      /**
       * 视野是否"已经请求过"（含在途的块）：用来判断要不要再发请求。
       * 采样 3×3 个点判断"并集覆盖"，这样瓦片拼出来的区域也能算覆盖。
       */
      covered(bbox, states) {
        if (loader.rectZoom !== loader.map.getZoom()) return false;
        const want = states || ['loaded', 'pending'];
        const pts = loader._samples(bbox);
        for (const [lat, lon] of pts) {
          let hit = false;
          for (const r of loader.rects) {
            if (want.indexOf(r.state) < 0) continue;
            if (loader.pointInside(r, lat, lon)) { hit = true; break; }
          }
          if (!hit) return false;
        }
        return true;
      },

      /** 视野是否"数据齐了"（不含在途/被截断的块）：禁止截断的判定就用它 */
      isComplete(bbox) {
        const box = bbox || loader.bboxNow(0);
        return loader.covered(box, ['loaded']);
      },

      /**
       * 缺口的**外接矩形**（一个矩形，不是一圈碎条带）。
       *
       * 为什么要"外接"而不是"精确"：服务器每次响应都要夹带全城的关系成员 way，
       * 一次请求的代价几乎是**常数**（实测 1-4 秒），单次上限 15000 个要素。
       * 所以"多要一点已经在本地的东西"远比"把缺口切成好几条、多发几次请求"划算 ——
       * 请求数才是拖动延迟本身。返回 null 表示没有缺口。
       */
      gapBox(box, states) {
        const N = Math.max(2, Math.min(16, Number(DEFAULTS.gapGrid) || 8));
        const want = states || ['loaded', 'pending'];
        const cellLat = (box.maxLat - box.minLat) / N;
        const cellLon = (box.maxLon - box.minLon) / N;
        let i0 = N;
        let i1 = -1;
        let j0 = N;
        let j1 = -1;
        for (let i = 0; i < N; i++) {
          const lat = box.minLat + (i + 0.5) * cellLat;
          for (let j = 0; j < N; j++) {
            const lon = box.minLon + (j + 0.5) * cellLon;
            let covered = false;
            for (const r of loader.rects) {
              if (want.indexOf(r.state) < 0) continue;
              if (loader.pointInside(r, lat, lon)) { covered = true; break; }
            }
            if (covered) continue;
            if (i < i0) i0 = i;
            if (i > i1) i1 = i;
            if (j < j0) j0 = j;
            if (j > j1) j1 = j;
          }
        }
        if (i1 < 0 || j1 < 0) return null;
        return {
          minLat: box.minLat + i0 * cellLat,
          maxLat: box.minLat + (i1 + 1) * cellLat,
          minLon: box.minLon + j0 * cellLon,
          maxLon: box.minLon + (j1 + 1) * cellLon,
        };
      },

      _samples(bbox) {
        const out = [];
        for (let i = 0; i <= 2; i++) {
          for (let j = 0; j <= 2; j++) {
            out.push([
              bbox.minLat + ((bbox.maxLat - bbox.minLat) * i) / 2,
              bbox.minLon + ((bbox.maxLon - bbox.minLon) * j) / 2,
            ]);
          }
        }
        return out;
      },

      /** 请求用的服务器分级缩放：默认跟显示缩放一致（服务器的分级就是玩家看到的画面） */
      requestZoom(displayZoom) {
        const z = Math.round(displayZoom == null ? loader.map.getZoom() : displayZoom);
        return Math.max(0, Math.min(22, Math.max(z, Number(loader.zoomFloor) || 0)));
      },

      /**
       * 服务端在**这个缩放**上是不是在做低缩放几何合并（server/osmdb.js 的 _coalesce），
       * 也就是"这一档是不是只看不改"（视图载荷：`displayLines` / `displayAreas`，没有 way id）。
       *
       * 判据**只认服务端回显**（`VIEW_ONLY_BOUNDARY`：优先用最近一次响应自己的
       * `truncation.viewOnly.minZoom`，其次 /api/meta 的 `limits.coalesce`，默认 minZoom=15
       * ⇒ "只看不改"的最高档是 z14）：`requestZoom < minZoom` 才算生效 ——
       * 客户端**绝不自己猜、也不写死缩放数字**，因为"合并生效 ⇒ 一屏一次请求就完整"是服务端的承诺
       * （实测 z10~z14 全部 complete=true，1400×900 与 2560×1440 两种屏都成立）。
       * 读不到回显（老服务端 / 配置里整个关掉了合并）→ 返回 false → 预切瓦片的老行为一字不改。
       */
      coalesceAt(zoom) {
        return VIEW_ONLY_BOUNDARY.at(zoom, loader);
      },

      /**
       * "只看不改"边界本身（默认 maxZoom=14 / minZoom=15，值全部来自服务端回显）：
       * 状态栏、自检、排查都读它，别的地方**不要再写死缩放数字**。
       */
      viewOnlyBoundary(echo) {
        return { minZoom: VIEW_ONLY_BOUNDARY.minZoom(echo, loader), maxZoom: VIEW_ONLY_BOUNDARY.maxZoom(echo, loader) };
      },

      init(map, options = {}) {
        loader.map = map;
        loader.onStats = options.onStats || (() => {});
        loader.limit = Number(options.limit) || Number(d.limit()) || null;
        // 登记给 World：World 卸载视野外要素时要把**这个**加载器的缓存范围作废
        // （必须是同一个加载器，否则会出现"数据被卸载了、MapData 却还认为已覆盖"的假覆盖）
        if (d.world) d.world.mapData = loader;
        map.on('moveend zoomend', () => {
          if (map.getZoom() !== loader.rectZoom) {
            // 换缩放级别：旧级别的范围不再适用（但不清 pending，在途请求自己按代号判断过期）
            loader.rects = loader.rects.filter((r) => r.state === 'pending');
            loader.rectZoom = map.getZoom();
          }
          loader.ensure();
        });
        return loader;
      },

      /* ------------------------------ 一轮视口加载 ------------------------------ */
      /** 开始新一轮视口加载：上一轮仍在飞行/排队的请求全部作废 */
      _beginLoad() {
        const prev = loader._load;
        const gen = { seq: loader.loadSeq + 1, controller: null, pendingRects: [], planned: 0, requested: 0 };
        loader.loadSeq = gen.seq;
        loader._load = gen;
        loader.queue.length = 0; // 上一轮排队中的请求不再发出，省掉无用的带宽
        if (prev) {
          // 上一轮没取到数据的范围要撤回，否则 covered() 会谎报"已覆盖"而不再请求
          for (const rect of prev.pendingRects) loader._forgetRect(rect);
          prev.pendingRects.length = 0;
          if (prev.controller) { try { prev.controller.abort(); } catch { /* ignore */ } }
        }
        gen.controller = typeof AbortController === 'function' ? new AbortController() : null;
        loader.tiles = { last: loader.tilePref || 1, depth: 0, capped: 0, split: 0, requested: 0 };
        return gen;
      },

      /** 撤回一个没有取到数据的缓存范围 */
      _forgetRect(rect) {
        if (!rect) return;
        const i = loader.rects.indexOf(rect);
        if (i >= 0) loader.rects.splice(i, 1);
      },

      /** 这次请求是否已被更新的视口加载取代（取代后不得再写入客户端状态） */
      _isStale(job) {
        if (!job) return true;
        if (job.seq !== loader.loadSeq) return true;
        return job.signal ? job.signal.aborted : false;
      },

      /** fetch 被 abort 时抛出的错误（响应体读到一半被 abort 也算） */
      _isAbort(err) {
        if (!err) return false;
        return err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20;
      },

      /** 主入口：确保当前视野的数据齐全（缺什么补什么，被截断就继续拆块） */
      ensure(force = false) {
        const view = loader.bboxNow(0);
        // 记下"上一次视野"和"这次往哪边拖了"：空闲预取优先补这个方向的条带
        const prevView = loader._lastView;
        if (prevView) {
          const w = Math.max(1e-9, prevView.maxLon - prevView.minLon);
          const h = Math.max(1e-9, prevView.maxLat - prevView.minLat);
          const nx = ((view.minLon + view.maxLon) / 2 - (prevView.minLon + prevView.maxLon) / 2) / w;
          const ny = ((view.minLat + view.maxLat) / 2 - (prevView.minLat + prevView.maxLat) / 2) / h;
          if (Math.abs(nx) > 0.02 || Math.abs(ny) > 0.02) loader.lastDir = { lon: Math.max(-1, Math.min(1, nx)), lat: Math.max(-1, Math.min(1, ny)) };
        }
        loader._lastView = {
          minLon: view.minLon, maxLon: view.maxLon, minLat: view.minLat, maxLat: view.maxLat,
        };
        if (d.world && d.world.setViewport) {
          // 注意这里给的是**未外扩**的真实视野：World 会自己按"每边 0.25 屏"算保留区并卸载
          // 保留区之外的要素。给外扩过的框会让保留区虚胖一大圈，卸载就不起作用了。
          d.world.setViewport(view);
        }
        if (loader.rectZoom !== loader.map.getZoom()) {
          loader.rects = loader.rects.filter((r) => r.state === 'pending');
          loader.rectZoom = loader.map.getZoom();
        }
        const target = loader.bboxNow(DEFAULTS.pad);
        const needTarget = force || !loader.covered(target, ['loaded', 'pending']);
        const cappedNear = loader.rects.filter((r) => r.state === 'capped'
          && !(r.maxLon < view.minLon || r.minLon > view.maxLon || r.maxLat < view.minLat || r.minLat > view.maxLat));
        if (!needTarget && !cappedNear.length) return 0;

        /**
         * 一轮"视野变化"从这里开始：fetch / merge / index / rebuild / draw 都记进这一轮，
         * 拖动排查时读 World.perfSnapshot()（或 Render.stats.lastPan）就有完整分解。
         */
        if (d.world && typeof d.world.perfBegin === 'function') d.world.perfBegin('pan');

        const gen = loader._beginLoad();
        let planned = 0;
        if (needTarget) {
          /**
           * 只请求"缺口"，而且缺口只发**一次**请求（外接矩形）：
           * 一次请求的代价大致随 bbox 面积线性（实测 ~2000-4000 way ↔ 200-400 ms），
           * 所以"只取新进视野的那一条缺口"永远比"整屏重取一遍"划算。
           * 只有缺口几乎等于整个目标框（≈ 全新一屏）时才交给分块路径 ——
           * 那时一个大请求必然被服务端截断，先切好瓦片可以少跑一趟。
           * 缺口自己要是被截断了，只拆缺口那一块（见下面 cappedNear 分支）。
           */
          const targetArea = loader._areaOf(target) || 1;
          const gap = DEFAULTS.gapFetch === false ? null : loader.gapBox(target, ['loaded', 'pending']);
          const maxFrac = Number(DEFAULTS.gapMaxFrac);
          const gate = targetArea * (Number.isFinite(maxFrac) ? maxFrac : 0.75);
          if (gap && (loader._areaOf(gap) || 0) <= gate) {
            planned += loader._enqueue(gap, 0, gen);
          } else {
            planned += loader._planRect(target, 0, gen);
          }
        }
        for (const r of cappedNear) {
          // 被截断的块：直接拆成 4 块重新取（父块标记作废，不再算"已覆盖"）
          loader._forgetRect(r);
          for (const child of loader._split(r)) planned += loader._enqueue(child, r.depth + 1, gen);
        }
        gen.planned = planned;
        loader._drain();
        loader._refreshCapState();
        return planned;
      },

      /** 规划一个矩形：按瓦片预算决定切几块（碰到上限后会自己再往下拆） */
      _planRect(bbox, depth, gen, tiles, prefetch) {
        const t = Number(tiles) > 0 ? Math.max(1, Math.round(tiles)) : loader._tileCount();
        if (t <= 1) return loader._enqueue(bbox, depth, gen, prefetch);
        let n = 0;
        for (const part of loader._split(bbox, t)) n += loader._enqueue(part, depth, gen, prefetch);
        return n;
      },

      /** 一个经纬度框的相对面积（只用于比较大小，不必是平方米） */
      _areaOf(box) {
        if (!box) return 0;
        return Math.max(0, box.maxLon - box.minLon) * Math.max(0, box.maxLat - box.minLat);
      },

      /**
       * 起始瓦片数：只按缩放给，用于**冷启动/换缩放**这种"缺口 = 整个目标框"的情况，
       * 少一次"先被截断再重试"的往返。（拖动走的是缺口路径，只发一次请求，不受这里影响。）
       *
       * 数字来自实测：一屏（1400×900）会不会触到服务端 15000 条上限 ——
       *   z11 14988（顶）· z13 15515（顶）· z14 12724~15049（擦边，换个位置就顶）· z15 15653（顶）· z16 9911（不顶）
       * 所以：z≤11 → 4×4；z≤15 → 2×2（z14 擦边，取 2×2 比"先撞顶再拆成 21 块"划算）；
       * z≥16 → 一块就够。注意 z16 之所以不顶，是因为视野里**关系**少
       * （每次响应的固定开销主要来自"夹带的关系成员 way"），所以这个表跟"城市密度"有关，不是纯几何 ——
       * 被截断时仍会自适应再拆（见 _apply 的 capped 分支）。
       * 只按缩放给（不含 tilePref 的记忆）：**切"缺口条带"时必须用它**，
       * 否则一次截断让 tilePref 涨到 8，下一轮就会把每条条带切成 64 块（请求数爆炸）。
       */
      _baseTileCount() {
        const z = loader.map.getZoom();
        /**
         * 服务端在做低缩放几何合并（limits.coalesce，见 coalesceAt）：一屏一次请求就完整，
         * 于是**不预切瓦片** —— 这正是"上限不再逼客户端拆块"的客户端半边。
         */
        if (loader.coalesceAt()) return 1;
        if (z <= 11) return 4;
        if (z <= 15) return 2;
        return 1;
      },

      /**
       * 起始瓦片数（含"上次被截断过"的记忆）：上限压在 2 ——
       * 服务器每次响应都要夹带全城的关系成员 way，一次请求的代价几乎是**常数**（1-4 秒），
       * 所以"请求数"就是拖动延迟本身。记忆涨到 4/8 时一上来就切 16/64 块，
       * 一次拖动要发十几二十次请求（实测 12 次 vs 老行为 4 次）—— 记忆只留一档就够，
       * 剩下的交给"被截断再拆"自适应。
       */
      _tileCount() {
        // 合并生效（服务端广播 limits.coalesce）：一屏就是一次请求，连"上次被截断"的记忆也不用管
        // （记忆是为"一屏装不下"准备的，而合并之后一屏装得下）
        if (loader.coalesceAt()) return 1;
        return Math.max(loader._baseTileCount(), Math.min(2, loader.tilePref || 1));
      },

      /** 把矩形切成 n×n 块 */
      _split(bbox, n) {
        const k = Math.max(2, Math.round(n || 2));
        const out = [];
        for (let i = 0; i < k; i++) {
          for (let j = 0; j < k; j++) {
            out.push({
              minLon: bbox.minLon + ((bbox.maxLon - bbox.minLon) * i) / k,
              maxLon: bbox.minLon + ((bbox.maxLon - bbox.minLon) * (i + 1)) / k,
              minLat: bbox.minLat + ((bbox.maxLat - bbox.minLat) * j) / k,
              maxLat: bbox.minLat + ((bbox.maxLat - bbox.minLat) * (j + 1)) / k,
            });
          }
        }
        return out;
      },

      /** 入队一块（登记为 pending，保证"同一块不会被重复请求"）；prefetch 只用于记账 */
      _enqueue(bbox, depth, gen, prefetch) {
        // 已经拿过或正在取的区域不再重复请求（分块与"拖动后再规划"会重叠）
        for (const r of loader.rects) {
          if (r.state !== 'loaded' && r.state !== 'pending') continue;
          if (r === bbox) continue;
          if (loader.contains(r, bbox)) return 0;
        }
        if (DEFAULTS.tileBudget && gen.requested >= DEFAULTS.tileBudget) {
          loader.stats.missing = (loader.stats.missing || 0) + 1;
          return 0;
        }
        const rect = {
          minLon: bbox.minLon, minLat: bbox.minLat, maxLon: bbox.maxLon, maxLat: bbox.maxLat,
          depth: depth || 0, state: 'pending', zoom: loader.map.getZoom(), prefetch: !!prefetch,
        };
        loader.rects.push(rect);
        gen.pendingRects.push(rect);
        loader.queueFetch(rect, loader.requestZoom(), gen, rect);
        loader._pruneRects();
        return 1;
      },

      /**
       * 缓存范围只清理"跟当前视野无关"的旧块，绝不清理正在用的块。
       * 保留区的口径与 World 的"视野外卸载"保持一致（问 World 要 keepBox）：
       * 两边口径不一致时，会出现"World 已经把要素卸载了，MapData 却还认为这块已覆盖"的假覆盖。
       */
      _pruneRects() {
        if (loader.rects.length <= DEFAULTS.maxRects) return;
        const view = loader._keepBox();
        const keep = [];
        const drop = [];
        for (const r of loader.rects) {
          const far = r.maxLon < view.minLon || r.minLon > view.maxLon || r.maxLat < view.minLat || r.minLat > view.maxLat;
          if (far && r.state !== 'pending') drop.push(r); else keep.push(r);
        }
        drop.sort((a, b) => (a.at || 0) - (b.at || 0));
        while (keep.length > DEFAULTS.maxRects && drop.length) keep.push(drop.pop());
        while (keep.length > DEFAULTS.maxRects) {
          const idx = keep.findIndex((r) => r.state !== 'pending');
          if (idx < 0) break;
          keep.splice(idx, 1);
        }
        loader.rects = keep;
      },

      /** 当前保留区：优先用 World 的口径（视野 + KEEP_MARGIN_SCREENS 屏），没有 World 时退回"视野 + 每边 0.25 屏" */
      _keepBox() {
        const view = loader.bboxNow(0);
        if (d.world && typeof d.world.keepBox === 'function') {
          const box = d.world.keepBox(view);
          if (box) return box;
        }
        return loader.bboxNow(KEEP_PAD_FALLBACK);
      },

      /** 视野里没有数据时强制重新取（例如撤销后需要同步） */
      refresh() {
        loader.rects = [];
        loader.lastCapped = null;
        loader.stats.truncated = false;
        loader.stats.missing = 0;
        loader.ensure(true);
      },

      /* ------------------------------ 空闲预取（拖动不再等请求） ------------------------------ */
      /**
       * 视野数据齐了、地图也静下来了 → 后台把视野外一圈（prefetchPad 倍屏）取回来。
       * 这样"拖一屏"通常落在已取范围内：一次服务器往返都不用等（服务器按 way 条数
       * 线性耗时，实测 ~0.35ms/条，省下一整轮就是省下好几秒）。
       *
       * 三条约束，保证预取永远不会帮倒忙：
       *   1. 只在"没有在途请求、没有待重建、视野数据齐全"时才排期（不跟正事抢并发的 4 个名额）；
       *   2. 预取的块**不参与** covered() 的"已覆盖"判定之外的行为 —— 它们就是普通缓存块，
       *      拖过去直接用，拖不过去被 _pruneRects 清掉；
       *   3. 新一轮视口加载（ensure）会把预取请求当作过期请求丢掉（seq 变了就不再合并），
       *      所以预取永远不会覆盖更新的视野数据。
       */
      _schedulePrefetch() {
        const pf = loader.prefetch;
        if (!pf.on || pf.auto === false) return 0;
        const pad = Number(DEFAULTS.prefetchPad) || 0;
        if (pad <= DEFAULTS.pad) return 0;
        if (pf.timer) { clearTimeout(pf.timer); pf.timer = null; }
        const idle = Math.max(0, Number(DEFAULTS.prefetchIdleMs) || 0);
        pf.timer = d.setTimeout(() => {
          pf.timer = null;
          loader.prefetchNow();
        }, idle);
        return 1;
      },

      /** 立刻做一次预取（返回这一次入队的块数；0 = 不需要） */
      prefetchNow() {
        const pf = loader.prefetch;
        if (!pf.on) return 0;
        const pad = Number(DEFAULTS.prefetchPad) || 0;
        if (pad <= DEFAULTS.pad) return 0;
        // 正事优先：有在途请求 / 有排队 / 视野还没取齐，就不预取
        if (loader.inflight > 0 || loader.queue.length || loader.fetching) return 0;
        if (!loader.isComplete(loader.bboxNow(0))) return 0;
        const wide = loader.bboxNow(pad);
        const view = loader.bboxNow(0);
        const gap = loader.gapBox(wide, ['loaded', 'pending']);
        if (!gap) return 0;
        /**
         * 预取**一条**视野外的条带（默认一条），优先挑"接着往上次拖动方向拖"会用到的那条：
         *   · 服务器每次请求的代价几乎是常数、单次上限 15000 个要素（约一屏的量），
         *     所以预取必须一块一块来，一次只发一块（不发一大块被截断再拆成四块）；
         *   · 地图继续静着的话 _apply 会再排下一轮，几秒之内自然把一圈补上。
         */
        const midLat = (view.minLat + view.maxLat) / 2;
        const midLon = (view.minLon + view.maxLon) / 2;
        const dir = loader.lastDir || { lon: 0, lat: 0 };
        const gx = (gap.minLon + gap.maxLon) / 2;
        const gy = (gap.minLat + gap.maxLat) / 2;
        const dx = (gx - midLon) / Math.max(1e-9, view.maxLon - view.minLon);
        const dy = (gy - midLat) / Math.max(1e-9, view.maxLat - view.minLat);
        const len = Math.hypot(dx, dy) || 1;
        const align = (dx / len) * dir.lon + (dy / len) * dir.lat;
        /**
         * 缺口的外接矩形如果横跨整圈（说明已经取到的范围是个"洞"），就按拖动方向切一条：
         * 只取那一条，剩下的留给下一轮 —— 一轮一次请求，绝不铺开。
         */
        let part = gap;
        if ((gap.maxLon - gap.minLon) > (view.maxLon - view.minLon) * 1.6
          && (gap.maxLat - gap.minLat) > (view.maxLat - view.minLat) * 1.6) {
          if (Math.abs(dx) >= Math.abs(dy)) {
            part = dx >= 0
              ? { minLon: midLon + (view.maxLon - view.minLon) * 0.5, maxLon: gap.maxLon, minLat: gap.minLat, maxLat: gap.maxLat }
              : { minLon: gap.minLon, maxLon: midLon - (view.maxLon - view.minLon) * 0.5, minLat: gap.minLat, maxLat: gap.maxLat };
          } else {
            part = dy >= 0
              ? { minLat: midLat + (view.maxLat - view.minLat) * 0.5, maxLat: gap.maxLat, minLon: gap.minLon, maxLon: gap.maxLon }
              : { minLat: gap.minLat, maxLat: midLat - (view.maxLat - view.minLat) * 0.5, minLon: gap.minLon, maxLon: gap.maxLon };
          }
        }
        const gen = loader._load || loader._beginLoad();
        let planned = 0;
        if (align < -0.1 && (part.maxLon - part.minLon) > (view.maxLon - view.minLon) * 2) {
          // 要补的方向跟"拖动方向"相反且范围很大：这一轮先不取（别把反向的大块先占了）
          return 0;
        }
        planned += loader._enqueue(part, 0, gen, true);
        if (planned) {
          pf.count += planned;
          pf.lastAt = Date.now();
          pf.running = true;
          loader._drain();
        }
        return planned;
      },

      /** 已经取到本地的范围（并集框）：World 用它判断"要不要真的扫全库卸载" */
      loadedBox() {
        let box = null;
        for (const r of loader.rects) {
          if (r.state !== 'loaded') continue;
          if (!box) box = { minLon: r.minLon, maxLon: r.maxLon, minLat: r.minLat, maxLat: r.maxLat };
          else {
            if (r.minLon < box.minLon) box.minLon = r.minLon;
            if (r.maxLon > box.maxLon) box.maxLon = r.maxLon;
            if (r.minLat < box.minLat) box.minLat = r.minLat;
            if (r.maxLat > box.maxLat) box.maxLat = r.maxLat;
          }
        }
        return box;
      },

      /** 关掉/打开空闲预取（排查用：关掉就是老行为——拖一屏必然等一次请求） */
      /**
       * 开关空闲预取（**默认关闭**：区块之外坚决不加载）。
       *   MapData.setPrefetch(true)          → 打开，视野外一圈用默认的 prefetchPad（0.25 屏）
       *   MapData.setPrefetch(true, 0.5)     → 打开并指定外扩（pad 建议 ≤ 0.5；必须 > DEFAULTS.pad 才有效）
       *   MapData.setPrefetch(false)         → 关掉（默认状态）
       */
      setPrefetch(on, pad) {
        loader.prefetch.on = on !== false;
        if (Number.isFinite(Number(pad)) && Number(pad) > 0) DEFAULTS.prefetchPad = Number(pad);
        if (!loader.prefetch.on && loader.prefetch.timer) {
          clearTimeout(loader.prefetch.timer);
          loader.prefetch.timer = null;
        }
        return { on: loader.prefetch.on, pad: DEFAULTS.prefetchPad, gapFetch: DEFAULTS.gapFetch !== false };
      },

      /** 只取缺口（拖一屏时不再重下已经在本地的那部分）；关掉用于对照排查 */
      setGapFetch(on) {
        DEFAULTS.gapFetch = on !== false;
        return DEFAULTS.gapFetch;
      },

      /** 分阶段快照：一次"拖一屏"到底慢在哪儿（net / parse / merge / index / tiles） */
      stages() {
        const s = loader.stats;
        return {
          tiles: s.lastTiles || 1,
          requests: s.requests || 0,
          ways: s.lastWays || 0,
          nodes: s.lastNodes || 0,
          bytes: s.lastBytes || 0,
          netMs: s.lastNetMs || 0,
          parseMs: s.lastParseMs || 0,
          fetchMs: s.lastFetchMs || 0,
          mergeMs: s.lastMergeMs || 0,
          indexMs: s.lastIndexMs || 0,
          applyMs: s.lastApplyMs || 0,
          sums: {
            netMs: Math.round(s.netMs || 0), parseMs: Math.round(s.parseMs || 0),
            mergeMs: Math.round(s.mergeMs || 0), indexMs: Math.round(s.indexMs || 0),
            applyMs: Math.round(s.applyMs || 0),
          },
          prefetch: { on: !!loader.prefetch.on, tiles: s.prefetchTiles || 0, ways: s.prefetchWays || 0, pad: DEFAULTS.prefetchPad },
        };
      },

      /**
       * 别人改了数据之后调用：把"已经缓存过、但内容已经过期"的视口范围撤掉，
       * 让 covered() 不再谎报已覆盖 —— 下一次 moveend/ensure() 会重新取一次真实数据。
       */
      invalidateAt(points) {
        const list = Array.isArray(points) ? points : (points ? [points] : []);
        const hits = list.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
        if (!hits.length) return 0;
        const before = loader.rects.length;
        loader.rects = loader.rects.filter((rect) => !hits.some((p) => loader.pointInside(rect, p.lat, p.lon)));
        return before - loader.rects.length;
      },

      /**
       * 视野外数据被 World 卸载之后调用：把落在"保留区"之外的缓存范围作废，
       * 保证拖回去时会重新请求 —— 卸载只影响内存，不影响画面完整。
       *
       * 规则（核心是**不许谎报"已覆盖"**，也**不许白丢还能用的覆盖**）：
       *   1. 完全落在保留区里的范围原样留着（那些数据还在本地，不用重新请求）；
       *   2. 跨界的范围裁成"保留区内的那一块"（保留区内的数据确实还在，裁剪后依然是诚实的状态）；
       *   3. 与保留区完全无关的范围直接删掉 —— 那块数据已经不在本地了，必须重新请求。
       *
       * **为什么"跨界就裁"而不是"跨界就删"**：保留区 = 视野 + 每边 0.25 屏，
       * 而目标框（视野 + 每边 pad）永远在保留区里面，所以"拖动后还留在视野里的那块覆盖"
       * 裁完一定还在。留着它，ensure() 算出来的缺口就是**真正新进视野的那一条**
       * （拖半屏时缺口占目标框 0.625），于是一次请求就够；
       * 反过来，如果跨界整块删掉（老行为），每个 rect 在视野移动超过 0.25 屏后被整个丢弃，
       * 缺口立刻变成"整个目标框"，只能退回分块的瓦片路径 —— 请求数白翻好几倍。
       *
       * @returns {number} 被作废（删掉或裁剪）的范围数量
       */
      invalidateOutside(keepBox, options = {}) {
        if (!keepBox) return 0;
        let changed = 0;
        let dropped = 0;
        const next = [];
        for (const r of loader.rects) {
          if (loader.contains(keepBox, r)) { next.push(r); continue; }
          const clip = loader.intersect(keepBox, r);
          // 跨界的范围：裁到保留区里（裁完那块的数据确实还在本地，状态依然诚实）
          if (clip) {
            r.minLon = clip.minLon;
            r.maxLon = clip.maxLon;
            r.minLat = clip.minLat;
            r.maxLat = clip.maxLat;
            r.clipped = true;
            r.clippedAt = Date.now();
            next.push(r);
            changed += 1;
            continue;
          }
          loader._abandonRect(r);
          changed += 1;
          dropped += 1;
        }
        loader.rects = next;
        loader.stats.invalidated = (loader.stats.invalidated || 0) + changed;
        loader.stats.invalidatedDropped = (loader.stats.invalidatedDropped || 0) + dropped;
        loader.stats.lastInvalidatedAt = Date.now();
        loader.stats.keepBox = {
          minLon: keepBox.minLon, minLat: keepBox.minLat, maxLon: keepBox.maxLon, maxLat: keepBox.maxLat,
        };
        // 作废掉的范围里可能有"被服务器截断"的块：重新算一次截断状态，别让状态栏一直报旧消息
        try { loader._refreshCapState(); } catch { /* ignore */ }
        if (changed && d.status) d.status(`已卸载视野外缓存：${changed} 块范围作废，拖回去会自动重新请求`);
        return changed;
      },

      /**
       * 作废一个缓存范围的登记（数据已经不在了）：标记状态，并把它从当前这一轮的在途清单里摘掉。
       * 从 loader.rects 里摘除由调用方完成（遍历中不能一边删一边读）。
       */
      _abandonRect(rect) {
        if (!rect) return;
        rect.state = 'dropped';
        rect.droppedAt = Date.now();
        const gen = loader._load;
        if (gen && gen.pendingRects) {
          const i = gen.pendingRects.indexOf(rect);
          if (i >= 0) gen.pendingRects.splice(i, 1);
        }
      },

      /** 让指定范围重新请求（显式"这块我不要再信本地了"）：与之相交的范围全部作废 */
      invalidateBox(box) {
        if (!box) return 0;
        const before = loader.rects.length;
        const kept = [];
        for (const r of loader.rects) {
          if (loader.intersect(box, r)) { loader._abandonRect(r); continue; }
          kept.push(r);
        }
        loader.rects = kept;
        return before - kept.length;
      },

      /* ------------------------------ 请求 ------------------------------ */
      queueFetch(bbox, zoom, gen, rect) {
        const g = gen || loader._beginLoad();
        loader.queue.push({
          bbox, zoom,
          seq: g.seq,
          signal: g.controller ? g.controller.signal : null,
          gen: g,
          rect: rect || null,
        });
        loader._drain();
      },

      _drain() {
        while (loader.inflight < DEFAULTS.concurrency && loader.queue.length) {
          const job = loader.queue.shift();
          if (job.seq !== loader.loadSeq) continue; // 已被新一轮视口加载取代：请求都不必发出
          loader.inflight += 1;
          loader.fetching = true;
          if (job.gen) job.gen.requested += 1;
          loader.tiles.requested += 1;
          loader._fetch(job)
            .catch((err) => {
              if (loader._isAbort(err)) return; // 主动取消：静默，不 toast、不报错
              if (job.seq !== loader.loadSeq) return; // 迟到的失败：同样静默
              // 失败必须把范围撤回，否则 covered() 会一直谎报"已覆盖"，那块数据永远补不回来
              loader._forgetRect(job.rect);
              loader.stats.lastError = (err && err.message) || String(err);
              const msg = (err && err.message) || String(err);
              if (!/超时|断开/.test(msg)) d.toast('地图数据加载失败：' + msg, 'error');
            })
            .finally(() => {
              loader.inflight -= 1;
              // fetching 由在途数推出来：请求被新一轮判过期直接 return 时也不会漏掉复位
              // （以前 fetching 只在合并成功时清掉，一次"过期丢弃"就能让它永远停在 true）
              loader.fetching = loader.inflight > 0;
              loader._drain();
            });
        }
      },

      /**
       * 从响应里判断"服务器是不是没给全"。
       * 只认能证明的信号，绝不靠猜（猜错会把请求越拆越多，反而更慢）：
       *  1. 服务器自己给的 truncated 标记 —— 它截断的是"通过分级筛选的 way 条数"，最权威；
       *  2. 返回里 **非关系成员** 的 way 条数达到上限。
       *     关系成员（公交线路等 relation 的成员路）是服务器在上限之外额外补齐的，
       *     而且它们分布在全城，把成员路算进来会得出"每条路都在被截断"的假象。
       * 说明：不能在客户端拿 stats.highways（bbox 内真实道路总数）跟返回的道路数比较 ——
       *     返回里的道路绝大多数是关系成员，两者根本不是一个集合（实测 z18：返回道路 10545，
       *     其中非成员只有 1157，而 stats.highways 是 1442）。所以这里不做那种比较。
       *     另外 stats 这块**默认根本不在响应里**（服务端 limits.viewportStats 默认 false，
       *     只有请求带 &stats=1 才算）：它是给工具看的面子数字，客户端一处理链都不读它。
       */
      detectCapped(payload, job) {
        const p = payload || {};
        const limit = Number(loader.limit) || Number(d.limit()) || DEFAULTS.wayLimitFallback;
        const memberWays = new Set();
        for (const arr of Object.values(p.relations || {})) {
          const members = (arr && arr[1]) || [];
          for (const m of members) if (m && m[0] === 'way') memberWays.add(Number(m[1]));
        }
        const reasons = [];
        let picked = 0;
        let pickedHighways = 0;
        for (const [id, arr] of Object.entries(p.ways || {})) {
          if (memberWays.has(Number(id))) continue;   // 关系成员不算（服务器在上限之外补的）
          picked += 1;
          if (arr && arr[2] && arr[2].highway) pickedHighways += 1;
        }
        if (p.truncated) reasons.push('server-flag');
        else if (picked >= limit) reasons.push('way-limit');
        else if (picked >= limit * DEFAULTS.capRatio) reasons.push('way-limit-near');
        const pois = Object.keys(p.nodeTags || {}).length;
        if (pois >= limit * 2) reasons.push('poi-limit');
        void job;
        return {
          capped: reasons.length > 0, reasons, limit,
          ways: Object.keys(p.ways || {}).length, picked, pickedHighways, memberWays: memberWays.size, pois,
        };
      },

      async _fetch(job) {
        const { bbox, zoom, signal } = job;
        if (loader._isStale(job)) return null; // 排队期间就被取代
        const t0 = d.now();
        const url = `/api/map?minLon=${bbox.minLon}&minLat=${bbox.minLat}&maxLon=${bbox.maxLon}&maxLat=${bbox.maxLat}&zoom=${zoom}&token=${encodeURIComponent(loader.token || '')}`;
        let payload;
        let tNet = t0;
        let tParsed = t0;
        let bytes = 0;
        try {
          if (!d.fetch) throw new Error('当前环境没有 fetch');
          const res = await d.fetch(url, signal ? { signal } : undefined);
          tNet = d.now();
          if (loader._isStale(job)) return null; // 响应到达时已经被取代
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || ('HTTP ' + res.status));
          }
          try {
            const cl = res.headers && res.headers.get ? res.headers.get('content-length') : null;
            bytes = Number(cl) || 0;
          } catch { bytes = 0; }
          payload = await res.json();
          tParsed = d.now();
        } catch (err) {
          if (loader._isAbort(err)) return null; // 新一轮视口已开始，旧响应直接丢弃
          if (loader._isStale(job)) return null;
          throw err;
        }
        if (loader._isStale(job)) return null; // 合并进世界之前最后一道检查
        job.tNet = tNet;
        job.tParsed = tParsed;
        job.bytes = bytes;
        return loader._apply(job, payload, t0);
      },

      /** 合并一块响应：写入 World、记账、必要时继续拆块 —— 全部走真实代码路径 */
      _apply(job, payload, t0) {
        let wayCount = 0;
        if (payload && payload.ways) for (const k in payload.ways) wayCount += 1;
        let nodeCount = 0;
        if (payload && payload.nodes) for (const k in payload.nodes) nodeCount += 1;
        // 紧凑载荷（server/osmdb.js 的「紧凑载荷」）：节点在 nodePack 的三列差分里，
        // 还没有展开成 nodes 字典（展开发生在 mergePayload 里），所以这里读列长
        else if (payload && payload.nodePack && payload.nodePack.ids) nodeCount = payload.nodePack.ids.length;
        const idxBefore = d.world && d.world.stats ? d.world.stats.indexInsertMs : 0;
        const tMerge = d.now();
        const added = d.world.mergePayload(payload);
        const mergeMs = d.now() - tMerge;
        const indexMs = d.world && d.world.stats ? (d.world.stats.indexInsertMs - idxBefore) : 0;
        const tNet = Number.isFinite(job.tNet) ? job.tNet : t0;
        const tParsed = Number.isFinite(job.tParsed) ? job.tParsed : tNet;
        const netMs = tNet - t0;              // 服务器 + 网络（响应头到手）
        const parseMs = tParsed - tNet;       // JSON 解析
        const applyMs = d.now() - t0;         // 整块（请求 → 合并完）
        const rect = job.rect;
        if (rect) {
          rect.at = Date.now();
          const cap = loader.detectCapped(payload, job);
          rect.ways = cap.ways;
          rect.capped = cap.capped;
          rect.reasons = cap.reasons;
          if (cap.capped) {
            loader.tiles.capped += 1;
            loader.stats.capped = (loader.stats.capped || 0) + 1;
            const depth = rect.depth || 0;
            const canSplit = depth < DEFAULTS.maxDepth && loader._budgetLeft(job.gen);
            rect.state = 'capped';
            const i = job.gen.pendingRects.indexOf(rect);
            if (i >= 0) job.gen.pendingRects.splice(i, 1);
            if (canSplit) {
              loader.tiles.split += 1;
              loader.tilePref = Math.min(8, Math.max(2, (loader.tilePref || 1) * 2));
              if (job.gen.seq === loader.loadSeq) {
                for (const child of loader._split(rect)) loader._enqueue(child, depth + 1, job.gen);
              }
              loader._warnCapped(cap, rect, true);
            } else {
              loader.stats.missing = (loader.stats.missing || 0) + 1;
              loader._warnCapped(cap, rect, false);
            }
          } else {
            rect.state = 'loaded';
            rect.ways = cap.ways;
            // 这一块数据已经真的拿到了
            const i = job.gen.pendingRects.indexOf(rect);
            if (i >= 0) job.gen.pendingRects.splice(i, 1);
          }
        }
        const st = loader.stats;
        st.lastMs = Math.round(applyMs);
        st.lastNetMs = Math.round(netMs);
        st.lastParseMs = Math.round(parseMs);
        st.lastFetchMs = Math.round(netMs + parseMs);
        st.lastMergeMs = Math.round(mergeMs);
        st.lastIndexMs = Math.round(indexMs);
        st.lastApplyMs = Math.round(applyMs);
        st.netMs += netMs;
        st.parseMs += parseMs;
        st.mergeMs += mergeMs;
        st.indexMs += indexMs;
        st.applyMs += applyMs;
        st.lastCount = added;
        st.lastWays = wayCount;
        st.lastNodes = nodeCount;
        st.lastBytes = job.bytes || 0;
        /**
         * 回显服务端的账本（低缩放合并 + 截断证据）：客户端据此可以说清"这一屏为什么完整"。
         *   · serverComplete / stopReason / droppedWays —— 上限有没有 binding（见 osmdb.js 的账本）
         *   · coalesce / displayLines —— 这一档服务端合并了多少条 way 成多少条折线
         */
        {
          const tr = payload && payload.truncation;
          const k = tr && tr.kinds && tr.kinds.ways;
          st.serverComplete = !!(tr && tr.complete);
          st.stopReason = k ? k.stopReason : null;
          st.droppedWays = k ? k.dropped : null;
          st.coalesce = (tr && tr.coalesce) || null;
          st.viewOnly = (tr && tr.viewOnly) || null;
          st.lastDisplayLines = (payload && Array.isArray(payload.displayLines)) ? payload.displayLines.length : 0;
          st.displayLines = (st.displayLines || 0) + st.lastDisplayLines;
          // 低缩放视图载荷：面几何（displayAreas，量化 + 按像素简化的环，没有 way id）
          st.lastDisplayAreas = (payload && Array.isArray(payload.displayAreas)) ? payload.displayAreas.length : 0;
          st.displayAreas = (st.displayAreas || 0) + st.lastDisplayAreas;
        }
        st.requests = (st.requests || 0) + 1;
        st.bytes = (st.bytes || 0) + (job.bytes || 0);
        st.loadedAt = Date.now();
        st.tiles = loader.tiles.last || 1;
        st.lastTiles = loader.tiles.requested || 1;
        perfAdd('fetch', netMs + parseMs);
        perfAdd('net', netMs);
        perfAdd('parse', parseMs);
        if (job.rect && job.rect.prefetch) {
          st.prefetchTiles = (st.prefetchTiles || 0) + 1;
          st.prefetchWays = (st.prefetchWays || 0) + wayCount;
        }
        loader._refreshCapState();
        // 任何一次真正合并成功都必须重绘：哪怕上一轮请求被新的一轮取消了，
        // 这一轮的数据也一定要出现在画面上（以前这里会被 stale 分支静默吃掉）
        loader._scheduleRedraw();
        loader.onStats(loader.stats);
        // 数据齐了、地图静下来了 → 后台把视野外一圈也取回来（拖一屏就不用再等请求）
        loader._schedulePrefetch();
        return payload;
      },

      _budgetLeft(gen) {
        if (!DEFAULTS.tileBudget) return true;
        const used = (gen && gen.requested) || 0;
        return used < DEFAULTS.tileBudget;
      },

      /** 被截断时的中文提示（节流：同一条信息 6 秒内只提示一次） */
      /**
       * 「服务器说这一块它一次返回不完」的提示。
       *
       * **只在真的还缺数据时提示，而且一个"缺数据 episode"只提示一次**（不刷屏）：
       *   - 还能继续拆块（splitting=true）：这是我们**内部**的事 —— 拆完这一屏的数据就是完整的，
       *     玩家不需要知道我们把视野切成了几块，所以**什么都不提示**（只记 tiles.capped 统计）；
       *   - 拆不动了（splitting=false）：这一屏确实缺东西，提示一次，文案说人话、不吓唬人。
       * 缺数据的状态一解除（`_refreshCapState` 里 lastCapped 变回 null），
       * `_capNotified` 复位：下次真的又缺了，可以再提示一次。
       */
      _warnCapped(cap, rect, splitting) {
        if (splitting) return;              // 内部拆块重取：数据最终是完整的，不打扰玩家
        if (loader._capNotified) return;    // 这一轮已经说过了
        loader._capNotified = true;
        d.toast(`这一片太密，正在分块加载…（服务器单次最多返回 ${cap.limit} 个要素，放大会更快看清）`, 'info', 5000);
        if (d.status) d.status('这一片太密，正在分块加载…');
      },

      /** 重新计算"还有没有缺的数据"，并同步给状态栏（ui.js 读 stats.truncated） */
      _refreshCapState() {
        const view = loader.bboxNow(0);
        const near = (r) => !(r.maxLon < view.minLon || r.minLon > view.maxLon || r.maxLat < view.minLat || r.minLat > view.maxLat);
        // 被截断的块如果已经被拆出来的子块完整覆盖，就不算"还缺数据"（否则会一直误报截断）
        const replaced = (r) => loader._samples(r).every(([lat, lon]) => loader.rects.some((x) => x !== r
          && x.state === 'loaded' && loader.pointInside(x, lat, lon)));
        const capped = loader.rects.filter((r) => r.state === 'capped' && near(r));
        const stillCapped = capped.filter((r) => !replaced(r));
        if (capped.length && !stillCapped.length) {
          // 子块已经补齐：把作废的父块从缓存里清掉（它的状态不再有意义）
          loader.rects = loader.rects.filter((r) => stillCapped.indexOf(r) >= 0 || r.state !== 'capped');
        }
        const pending = loader.rects.filter((r) => r.state === 'pending');
        const reasons = [];
        for (const r of stillCapped) for (const s of (r.reasons || [])) if (reasons.indexOf(s) < 0) reasons.push(s);
        loader.lastCapped = stillCapped.length ? {
          at: Date.now(),
          reason: reasons.join(',') || 'server-limit',
          limit: loader.limit || Number(d.limit()) || DEFAULTS.wayLimitFallback,
          rects: stillCapped.length,
          missing: stillCapped.length,
          pending: pending.length,
          zoom: loader.rectZoom,
          // 诊断字段（没人读它做界面，但留一句人话，免得以后有人拿它当提示文案）
          hint: '这一片太密，正在分块加载…',
        } : null;
        loader.stats.truncated = !!loader.lastCapped;
        loader.stats.missing = stillCapped.length;
        // 不缺数据了 → 解除"已经提示过"的锁：下次真的又缺了可以再提示一次（同一轮不会重复刷屏）
        if (!loader.lastCapped) loader._capNotified = false;
        if (!loader.lastCapped && !pending.length && d.status) d.status('');
      },

      _scheduleRedraw() {
        loader.stats.lastRedrawAt = Date.now();
        try { d.markDirty(); } catch { /* ignore */ }
        if (loader.onRedraw) loader.onRedraw(loader.stats);
      },

      /* ------------------------------ 自检 ------------------------------ */
      /**
       * 自检：加载 → 快速拖动两次 → 断言"最终视野的数据已合并、并且安排了重绘"。
       * 同时覆盖：被服务器截断时自动拆块、请求失败后范围不会被谎报为已覆盖。
       * 全程使用沙盒实例（假 map / 假 fetch），不会影响页面上的真实数据。
       */
      selfCheck(options = {}) {
        const steps = [];
        const failures = [];
        const check = (name, cond, detail) => {
          const ok = !!cond;
          steps.push({ name, ok, detail: detail == null ? '' : String(detail) });
          if (!ok) failures.push(name);
          return ok;
        };
        const limit = Number(options.limit) || 15000;
        let center = { lat: 39.9042, lng: 116.4074 };
        let zoom = 16;
        const fakeMap = {
          getZoom: () => zoom,
          getBounds: () => ({
            pad: (p) => {
              const mpp = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, zoom);
              const dLat = (900 * mpp * (1 + (p || 0))) / 110574 / 2;
              const dLon = (1600 * mpp * (1 + (p || 0))) / (111320 * Math.cos((center.lat * Math.PI) / 180)) / 2;
              return {
                getSouthWest: () => ({ lat: center.lat - dLat, lng: center.lng - dLon }),
                getNorthEast: () => ({ lat: center.lat + dLat, lng: center.lng + dLon }),
              };
            },
          }),
          on: () => {},
        };
        const merged = { ways: new Set(), requests: [], payloads: 0 };
        const fakeWorld = {
          setViewport: () => {},
          mergePayload(payload) {
            merged.payloads += 1;
            let added = 0;
            for (const id of Object.keys(payload.ways || {})) {
              const n = Number(id);
              if (!merged.ways.has(n)) { merged.ways.add(n); added += 1; }
            }
            return added;
          },
        };
        let redraws = 0;
        const toasts = [];
        let mode = options.mode || 'normal';
        let modeAt = 0; // 切到某个模式时的请求计数（用来让"第一块"被截断/失败）
        const mkPayload = (bbox, count, capped) => {
          const ways = {};
          for (let i = 0; i < count; i++) {
            const id = Math.round((bbox.minLon * 1e6) + i);
            ways[id] = [1, [1, 2], { highway: 'residential' }, false, 0];
          }
          return { ways, nodes: {}, relations: {}, truncated: !!capped, stats: { highways: count } };
        };
        const fakeFetch = (url) => {
          merged.requests.push(url);
          const m = /minLon=([-\d.]+)&minLat=([-\d.]+)&maxLon=([-\d.]+)&maxLat=([-\d.]+)&zoom=(\d+)/.exec(url);
          const bbox = m ? { minLon: +m[1], minLat: +m[2], maxLon: +m[3], maxLat: +m[4] } : { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 };
          const first = merged.requests.length === modeAt + 1;
          if (mode === 'fail' && first) {
            return Promise.reject(new Error('模拟网络失败'));
          }
          const capped = mode === 'cap' && first;
          const body = mkPayload(bbox, capped ? limit : 50, capped);
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(JSON.stringify(body)),
          });
        };
        const sandbox = createLoader({
          map: fakeMap,
          fetch: fakeFetch,
          world: fakeWorld,
          limit: () => limit,
          markDirty: () => { redraws += 1; },
          toast: (msg) => toasts.push(msg),
          status: () => {},
          now: () => Date.now(),
          // 自检里关掉空闲预取：预取会在后台多发请求，把"请求次数"这类断言搅乱
          prefetch: false,
        });
        sandbox.init(fakeMap, {});
        sandbox.token = 'selfcheck';
        sandbox.zoomFloor = 0;
        const flush = () => new Promise((r) => setTimeout(r, 0));

        return (async () => {
          // 1) 首次加载
          sandbox.ensure();
          await flush(); await flush(); await flush();
          const first = merged.requests.length;
          check('首次加载发出了请求', first >= 1, first + ' 个请求');
          check('响应数据已合并进世界', merged.ways.size > 0, merged.ways.size + ' 条 way');
          check('合并后安排了重绘', redraws >= 1, redraws + ' 次 markDirty');
          check('首次加载后视野标记为已覆盖', sandbox.covered(sandbox.bboxNow(0)) === true);

          // 2) 快速拖动两次（模拟连续两次 moveend）
          const seqBefore = sandbox.loadSeq;
          center = { lat: center.lat, lng: center.lng + 0.02 };
          sandbox.ensure();
          center = { lat: center.lat, lng: center.lng + 0.02 };
          sandbox.ensure();
          await flush(); await flush(); await flush();
          const finalBox = sandbox.bboxNow(0);
          const finalQuery = merged.requests.filter((u) => u.includes('minLon='));
          const lastUrl = finalQuery[finalQuery.length - 1] || '';
          const got = /minLon=([-\d.]+)&minLat=([-\d.]+)&maxLon=([-\d.]+)&maxLat=([-\d.]+)/.exec(lastUrl);
          const reqCenter = got ? { lon: (+got[1] + +got[3]) / 2, lat: (+got[2] + +got[4]) / 2 } : null;
          const viewCenter = { lon: (finalBox.minLon + finalBox.maxLon) / 2, lat: (finalBox.minLat + finalBox.maxLat) / 2 };
          check('拖动两次后发起的是最新视野的请求',
            !!reqCenter && Math.abs(reqCenter.lon - viewCenter.lon) < 0.01 && Math.abs(reqCenter.lat - viewCenter.lat) < 0.01,
            reqCenter ? `请求中心 ${reqCenter.lat.toFixed(4)},${reqCenter.lon.toFixed(4)} · 视野中心 ${viewCenter.lat.toFixed(4)},${viewCenter.lon.toFixed(4)}` : '没有请求');
          check('新一轮加载代号递增（旧请求作废，新请求没被丢掉）', sandbox.loadSeq > seqBefore, `${seqBefore} → ${sandbox.loadSeq}`);
          check('最终视野被覆盖', sandbox.covered(finalBox) === true);
          check('最终视野数据齐全（没有半截）', sandbox.isComplete(finalBox) === true);
          const redrawsAfterPan = redraws;
          check('拖动后仍然安排了重绘', redrawsAfterPan >= 2, redrawsAfterPan + ' 次 markDirty');
          check('在途/排队请求已清空', sandbox.inflight === 0 && sandbox.queue.length === 0,
            `inflight=${sandbox.inflight} queue=${sandbox.queue.length}`);

          // 3) 服务器返回碰到上限 → **内部拆块一律静默**（玩家不需要知道我们分了几块），
          //    但拆块本身必须发生，并且拆完不能再有截断。
          mode = 'cap';
          modeAt = merged.requests.length;
          const reqsBeforeCap = merged.requests.length;
          sandbox.lastCapped = null;
          sandbox.rects = [];
          toasts.length = 0;
          sandbox.refresh();
          await flush(); await flush(); await flush(); await flush();
          check('碰到上限、还能继续拆块时**不提示**（内部拆块静默）', toasts.length === 0, toasts.join(' | ').slice(0, 80) || '（没提示）');
          check('被截断的块被拆成子块继续请求', merged.requests.length > reqsBeforeCap + 4, merged.requests.length + ' 个请求');
          check('拆块后视野不再被标记为截断', sandbox.lastCapped === null, JSON.stringify(sandbox.lastCapped));
          check('拆块后视野数据齐全', sandbox.isComplete(sandbox.bboxNow(0)) === true);

          // 3b) 拆不动了（瓦片深度到顶）→ 这时才提示，而且一个"缺数据 episode"只提示一次
          {
            const savedDepth = DEFAULTS.maxDepth;
            DEFAULTS.maxDepth = 0;
            try {
              sandbox.lastCapped = null;
              sandbox.rects = [];
              toasts.length = 0;
              modeAt = merged.requests.length;   // 让这一轮的第一块被"截断"（见 fakeFetch）
              sandbox.refresh();
              await flush(); await flush(); await flush(); await flush();
              check('拆不动了才提示一句人话（这一片太密，正在分块加载…）',
                toasts.some((t) => /这一片太密/.test(t)), toasts.join(' | ').slice(0, 90) || '（没提示）');
              check('提示不吓人（不再有"要素过多 / 已截断显示"那套说法）',
                !toasts.some((t) => /已截断显示|要素过多|禁止半截/.test(t)), toasts.join(' | ').slice(0, 90) || '（没提示）');
              check('同一个缺数据 episode 只提示一次',
                toasts.filter((t) => /这一片太密/.test(t)).length === 1, toasts.length + ' 条');
            } finally {
              DEFAULTS.maxDepth = savedDepth;
              sandbox.lastCapped = null;
              sandbox.rects = [];
              sandbox.stats.truncated = false;
              sandbox.stats.missing = 0;
              sandbox._capNotified = false;
            }
          }

          // 4) 请求失败：范围必须撤回，下次 ensure 会重新请求
          mode = 'fail';
          modeAt = merged.requests.length;
          sandbox.rects = [];
          sandbox.refresh();
          await flush(); await flush(); await flush();
          const afterFailReqs = merged.requests.length;
          check('失败的块没有被标记为已覆盖', sandbox.covered(sandbox.bboxNow(0), ['loaded']) === false);
          sandbox.ensure();
          await flush(); await flush(); await flush();
          check('失败后再次 ensure 会重新请求', merged.requests.length > afterFailReqs,
            `${afterFailReqs} → ${merged.requests.length}`);

          // 5) 视野外卸载：缓存范围作废 → 当前视野照样算"已覆盖"，拖回去会重新请求
          sandbox.rects = [];
          sandbox.lastCapped = null;
          sandbox.refresh();
          await flush(); await flush(); await flush();
          const viewBox = sandbox.bboxNow(0);
          // 视野外那一块（曾经取过）模拟成"已经取过"的旧范围
          const farBox = {
            minLon: viewBox.minLon + (viewBox.maxLon - viewBox.minLon) * 4,
            maxLon: viewBox.minLon + (viewBox.maxLon - viewBox.minLon) * 5,
            minLat: viewBox.minLat, maxLat: viewBox.maxLat,
          };
          sandbox.rects.push(Object.assign({ state: 'loaded', depth: 0, zoom: sandbox.map.getZoom() }, farBox));
          const farRect = sandbox.rects[sandbox.rects.length - 1];
          const nearOf = (list) => list.filter((r) => r.state === 'loaded'
            && !(r.maxLon < viewBox.minLon || r.minLon > viewBox.maxLon
              || r.maxLat < viewBox.minLat || r.minLat > viewBox.maxLat)).length;
          const nearBefore = nearOf(sandbox.rects);
          const beforeInvalidate = sandbox.rects.length;
          const invalidated = sandbox.invalidateOutside({
            minLon: viewBox.minLon - (viewBox.maxLon - viewBox.minLon) * 0.75,
            maxLon: viewBox.maxLon + (viewBox.maxLon - viewBox.minLon) * 0.75,
            minLat: viewBox.minLat - (viewBox.maxLat - viewBox.minLat) * 0.75,
            maxLat: viewBox.maxLat + (viewBox.maxLat - viewBox.minLat) * 0.75,
          });
          check('视野外卸载后：远处的缓存范围被作废', invalidated >= 1 && sandbox.rects.length < beforeInvalidate,
            `作废 ${invalidated} 块 · ${beforeInvalidate} → ${sandbox.rects.length}`);
          check('被作废的正是视野外那一块', sandbox.rects.indexOf(farRect) < 0, `farRect.state=${farRect.state}`);
          check('作废视野外缓存后，当前视野仍然算"已覆盖"（不会跟 ensure 打架）',
            sandbox.covered(viewBox, ['loaded']) === true, JSON.stringify(sandbox.completeness()));
          check('视野内要用的范围一块都没被误伤', nearOf(sandbox.rects) >= nearBefore && nearBefore > 0,
            `视野内范围 ${nearBefore} → ${nearOf(sandbox.rects)}`);
          const reqsBeforeBack = merged.requests.length;
          center = { lat: center.lat, lng: center.lng + 0.02 * 5 };
          sandbox.ensure();
          await flush(); await flush(); await flush();
          check('拖回被卸载的区域会重新请求（不会出现空白）', merged.requests.length > reqsBeforeBack,
            `${reqsBeforeBack} → ${merged.requests.length}`);

          return { ok: failures.length === 0, steps, failures, requests: merged.requests.length, ways: merged.ways.size };
        })();
      },

      /* ------------------------------ 诊断与补齐 ------------------------------ */
      /** 当前视野的完整性报告（渲染层/自检/状态栏都用它，绝不猜） */
      completeness() {
        const view = loader.bboxNow(0);
        return {
          zoom: loader.rectZoom,
          covered: loader.covered(view),
          complete: loader.isComplete(view),
          pending: loader.rects.filter((r) => r.state === 'pending').length,
          capped: loader.rects.filter((r) => r.state === 'capped').length,
          rects: loader.rects.length,
          lastCapped: loader.lastCapped,
          truncated: !!loader.stats.truncated,
          // 视野外卸载：被作废的范围数（这些块拖回去会重新请求）
          invalidated: loader.stats.invalidated || 0,
          invalidatedDropped: loader.stats.invalidatedDropped || 0,
          lastInvalidatedAt: loader.stats.lastInvalidatedAt || 0,
          // 服务端账本回显（低缩放合并 / 截断证据）：见 _apply 里那一段
          serverComplete: !!loader.stats.serverComplete,
          stopReason: loader.stats.stopReason || null,
          droppedWays: loader.stats.droppedWays == null ? null : loader.stats.droppedWays,
          coalesce: loader.stats.coalesce || null,
          displayLines: loader.stats.lastDisplayLines || 0,
          // 低缩放视图载荷（面几何也只画不选）：displayAreas 条目数 + 服务端账本
          displayAreas: loader.stats.lastDisplayAreas || 0,
          viewOnly: loader.stats.viewOnly || null,
          coalesceActive: loader.coalesceAt(),
          // 客户端**自己认的**"只看不改"边界（值来自服务端回显，默认 maxZoom 14 / minZoom 15）：
          // 与 payload.truncation.viewOnly.maxZoom/minZoom 一对照就知道两侧有没有跑偏
          viewOnlyBoundary: loader.viewOnlyBoundary(loader.stats.viewOnly),
        };
      },

      /** 视野外卸载的统计（状态栏/排查用；与 World.unloadStats() 配对） */
      unloadStats() {
        const keep = loader._keepBox();
        return {
          rects: loader.rects.length,
          loaded: loader.rects.filter((r) => r.state === 'loaded').length,
          pending: loader.rects.filter((r) => r.state === 'pending').length,
          invalidated: loader.stats.invalidated || 0,
          invalidatedDropped: loader.stats.invalidatedDropped || 0,
          lastInvalidatedAt: loader.stats.lastInvalidatedAt || 0,
          keep: Object.assign({}, keep),
          complete: loader.isComplete(loader.bboxNow(0)),
        };
      },

      /** 元素不在本地时按 id 补齐（选中远处元素用） */
      async fetchElement(type, id) {
        const res = await d.fetch(`/api/element?type=${type}&id=${id}&token=${encodeURIComponent(loader.token || '')}`);
        if (!res.ok) throw new Error('元素不存在');
        const data = await res.json();
        const el = data.element;
        if (type === 'node') {
          World.putNode({ id: el.id, lat: el.lat, lon: el.lon, version: el.version, tags: el.tags });
        } else if (type === 'way') {
          // 把几何坐标补成节点（服务端返回的 coords 与 nodes 顺序一致）
          const nodes = el.nodes || [];
          const coords = el.coords || [];
          for (let i = 0; i < nodes.length; i++) {
            const c = coords[i];
            if (!c) continue;
            if (!World.getNode(nodes[i])) World.putNode({ id: nodes[i], lat: c[0], lon: c[1], version: 0, tags: null });
          }
          World.putWay({ id: el.id, version: el.version, tags: el.tags, nodes, closed: el.closed });
        } else {
          World.putRelation({ id: el.id, version: el.version, tags: el.tags, members: el.members });
          for (const m of el.members || []) {
            if (m.type === 'way' && m.coords && m.coords.length) {
              const w = World.getWay(m.ref);
              if (!w) {
                // 关系成员道路没有节点 id 列表时，用临时负 id 节点占位渲染
                const tmpIds = m.coords.map((c, i) => {
                  const nid = -(m.ref * 1000 + i);
                  World.putNode({ id: nid, lat: c[0], lon: c[1], version: 0, tags: null });
                  return nid;
                });
                World.putWay({ id: m.ref, version: 0, tags: m.tags || null, nodes: tmpIds, closed: tmpIds.length > 2 && tmpIds[0] === tmpIds[tmpIds.length - 1] });
              }
            }
          }
        }
        /**
         * 顺手记下服务端说的"最后编辑者"：
         *   · 检查器的元信息行（inspector.js 读 `el.editorName`）能显示"版本 N · 最后编辑：X"；
         *   · 版本冲突自愈的中文提示要讲清"这个节点刚被谁改过"（见 editor.js 的「版本冲突自愈」）。
         * 必须在这里补写：`World.putNode/putWay/putRelation` 只认自己那几个字段，会丢掉它。
         */
        const merged = World.get(type, el.id);
        if (merged && el.editorName) merged.editorName = el.editorName;
        loader._scheduleRedraw();
        return data;
      },
    };

    loader.limit = loader.limit || null;
    return loader;
  }

  const MapData = createLoader({});
  MapData.DEFAULTS = DEFAULTS;
  MapData.createLoader = createLoader;
  window.G.MapData = MapData;
})();
