'use strict';
/**
 * 客户端 OSM 数据模型：把服务器下发的视口数据与实时操作合并成一份本地数据集。
 * 结构：nodes / ways / relations 三个 Map，与 OSM 的数据模型一致。
 *
 * 视野外卸载（#3b）：
 *   老版本只在"本地总量超过 30 万"时才清理一次，所以玩家拖了一整圈，本地要素数
 *   永远停在 11.6 万左右 —— 数据只进不出。现在改成"跟着视野走"：
 *     · 保留区 = 当前视野 + 每边 0.75 屏（两个方向合计 1.5 屏）；
 *     · 视野累计移动超过 0.5 屏就评估一次，把保留区之外的要素卸载掉；
 *     · 卸载掉的区域会同时把 MapData 的视口缓存范围作废，拖回去时照样重新请求，
 *       所以"卸载"只影响内存，不影响画面完整（视野内一个要素都不会少）。
 */
(function () {
  const { util } = window.G;

  /** 单调时钟（性能计时用；没有 performance 时退回 Date） */
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  const MAX_ELEMENTS = 300000; // 本地缓存硬上限：超过它无条件清理视野外元素（视野内绝不清理）
  /**
   * 低缩放合并折线（displayLines）的本地条数硬上限：**只是安全阀**。
   * 实测一屏（1400×900，真实北京数据）z10~z15 的折线条目是 350~1501 条，
   * 加上拖动留下的几屏也远到不了这里；真撞上了就按"离视野最远"丢（绝不清空视野里的）。
   */
  const MAX_DISPLAY_LINES = 20000;
  /**
   * 低缩放合并面（displayAreas）的本地条数硬上限：同样只是安全阀。
   * 实测一屏 z10~z15 的面条目是 130~210 条（服务端按"面样式类 + 名字"分组、面关系一条一条），
   * 一屏整框一次请求就到位；真撞上了就按"离视野最远"丢（绝不清空视野里的）。
   */
  const MAX_DISPLAY_AREAS = 20000;
  /**
   * 视野保留区：当前视野的每一边再往外留 0.25 屏（两个方向合计 0.5 屏）。
   *
   * 取值理由（"视野里有哪些区块就只加载区块，区块之外坚决不加载"）：
   *   · 请求范围是**视野 + 每边 5%**（mapdata 的 DEFAULTS.pad），保留区只要略大于它，
   *     就能覆盖"手指抖一下 / 惯性滑动收尾"那一小段，不必重新请求；
   *   · 0.5 屏（每边 0.25 屏）正好是"来回小幅度拖动不用重取"与"视野外的数据立刻还回去"
   *     之间的平衡点：**超出半屏的要素一律卸载**，本地要素数因此不会随拖动积累；
   *   · 老版本是 2.0 屏（每边 1 屏），那是为了迁就当时开着的空闲预取（预取到视野外 0.6-0.7 屏，
   *     保留区不留够就会"刚取回来就被卸载"）。预取现在**默认关闭**，那一圈也就不需要了。
   *   · 安全约束不变：**视野内的要素绝不卸载**；pinned / 撤销栈引用到的要素也不卸载
   *     （见 _collectPins），所以编辑中的数据不会因为拖动消失。
   */
  const KEEP_MARGIN_SCREENS = 0.5;
  /** 视野累计移动多少屏之后才重新评估卸载（拖动过程中不必每次 moveend 都扫全库）。
   *  取 0.25 屏：比保留区（每边 0.25 屏）更密一点，保证"超出半屏的数据"很快就被还回去，
   *  而不是攒到整屏才处理。扫描本身是增量的（只遍历本地 Map + 增量维护索引）。 */
  const UNLOAD_TRIGGER_SCREENS = 0.25;
  /** 空间索引格子边长（度）：0.01° ≈ 1.1km，城市尺度下每格要素数量适中 */
  const CELL_DEG = 0.01;
  /** 一个 way 的 bbox 跨过太多格子时放进"大要素"列表，避免索引里塞进上万个格子 */
  const MAX_CELLS_PER_WAY = 64;
  /**
   * 空环集（多面体关系没缝出任何环时返回它）。
   * **只读**：调用方不许往里 push（所有取值路径都按只读消费）。
   */
  const EMPTY_RINGS = Object.freeze({
    outers: Object.freeze([]), inners: Object.freeze([]),
    memberWays: 0, outerWays: 0, innerWays: 0, chains: 0, dropped: 0, missingNodes: 0, stamp: 0,
  });
  /** 一个关系里最多拿多少条 way 成员参与"接龙缝环"（超出的碎片原样留着，不参与） */
  const MAX_STITCH_WAYS = 512;
  /**
   * 一次 op ack 里最多逐条修正多少个"被原地改过坐标"的节点。
   * 正常一次拖动是 1~几百个节点（拖动上限见 editor.js 的 DRAG_BATCH_LIMIT），
   * 超过这个数说明情况异常 —— 那时不做逐条修正，直接整表重建索引（保守但绝不会错）。
   */
  const MAX_GEOM_DRIFT = 20000;

  /**
   * 两个节点 id 数组是不是同一串（内容比较，不只是引用比较）。
   * 服务器每块响应都会把同一批 way 重发一遍，而重发时 nodes 是**新数组** ——
   * 老代码只比引用（`cur.nodes !== nodes`），于是每次都当成"几何变了"：
   * 索引摘除 + 重插 + 投影缓存作废，拖动时几万条 way 白折腾一遍。
   */
  function sameNodeIds(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** 两个标签对象内容是否一样（同上：避免"重发 = 新对象"被判成标签变了） */
  function sameTags(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    let n = 0;
    for (const k in a) { if (b[k] !== a[k]) return false; n += 1; }
    let m = 0;
    for (const k in b) m += 1;
    return n === m;
  }

  /* --------------------- 空间索引的"行桶"（见 World._grid 的说明） --------------------- */

  /** 取/建一行（create=false 时没有就返回 null） */
  function gridRow(grid, y, create) {
    let row = grid.get(y);
    if (!row) {
      if (!create) return null;
      row = { buckets: new Map(), keys: null, dirty: true };
      grid.set(y, row);
    }
    return row;
  }

  /** 行内"真的有桶的列号"（升序）。脏了才重排：插入风暴里一行只排一次，查询时不会有额外开销 */
  function rowKeys(row) {
    if (row.keys && !row.dirty) return row.keys;
    const n = row.buckets.size;
    const keys = new Int32Array(n);
    let i = 0;
    for (const x of row.buckets.keys()) keys[i++] = x;
    keys.sort();                       // TypedArray.sort 是数值序
    row.keys = keys;
    row.dirty = false;
    return keys;
  }

  /** 升序数组里第一个 >= x 的下标（二分） */
  function lowerBound(keys, x) {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** 往 (y,x) 桶里塞一个 id */
  function rowPush(row, x, id) {
    let arr = row.buckets.get(x);
    if (!arr) { arr = []; row.buckets.set(x, arr); row.dirty = true; }
    arr.push(id);
    return arr;
  }

  /** 从 (y,x) 桶里摘掉一个 id（桶空了就把桶删掉，行不至于越来越胖） */
  function rowRemove(row, x, id) {
    const arr = row.buckets.get(x);
    if (!arr) return;
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) { row.buckets.delete(x); row.dirty = true; }
  }

  /** 一行一列一个 id（给 _forEachCell 当回调用，避免每次查询都新建闭包） */
  function cellInsert(x, y, id) { rowPush(gridRow(World._grid, y, true), x, id); }
  function cellRemove(x, y, id) { const row = gridRow(World._grid, y, false); if (row) rowRemove(row, x, id); }
  function cellInsertNode(x, y, id) { rowPush(gridRow(World._nodeGrid, y, true), x, id); }
  function cellRemoveNode(x, y, id) { const row = gridRow(World._nodeGrid, y, false); if (row) rowRemove(row, x, id); }

  /* --------------------- 矩形查询的状态机（游标：可暂停 / 可续跑） --------------------- */

  /** 游标归零（第一次、或索引换代之后）。**便宜的提前退出**都在这里：没数据就直接 done */
  function queryReset(cur) {
    const box = cur.box;
    cur.out.length = 0;
    cur.stats = { rows: 0, buckets: 0, candidates: 0, dedup: 0, unique: 0, passes: 0 };
    cur.arr = null;
    cur.row = null;
    cur.keys = null;
    cur.kx = 0;
    cur.bi = 0;
    cur.ticks = 0;
    if (!box || !World.ways.size) {          // 空库：一条都不用找（低缩放早期、刚启动时会走到）
      cur.phase = 'done';
      cur.done = true;
      cur.grid = World._grid;
      cur.gridStamp = World._gridStamp;
      cur.q = ++World._queryStamp;
      return;
    }
    World.ensureIndex();
    cur.grid = World._grid;
    cur.gridStamp = World._gridStamp;
    cur.q = ++World._queryStamp;
    cur.x0 = Math.floor(box.minLon / CELL_DEG);
    cur.x1 = Math.floor(box.maxLon / CELL_DEG);
    cur.y = Math.floor(box.minLat / CELL_DEG);
    cur.y1 = Math.floor(box.maxLat / CELL_DEG);
    cur.phase = 'rows';
    cur.done = false;
  }

  /**
   * 找下一个要扫的桶：整行没有桶的直接跳过（老实现在这里要为每个空格子造一个字符串），
   * 行内用二分跳到 [x0,x1] 的第一列。没有更多桶时把 phase 推到 'big' 并返回 false。
   */
  function nextBucket(cur) {
    const grid = cur.grid;
    while (cur.y <= cur.y1) {
      if (cur.row === null) {
        cur.stats.rows += 1;
        cur.row = grid.get(cur.y) || false;   // false = 这一行看过且没有桶
        cur.keys = null;
      }
      const row = cur.row;
      if (row) {
        let keys = cur.keys;
        if (keys === null) {
          keys = rowKeys(row);
          cur.keys = keys;
          cur.kx = lowerBound(keys, cur.x0);
        }
        while (cur.kx < keys.length) {
          const x = keys[cur.kx];
          if (x > cur.x1) break;              // 后面的列都在窗口右边了
          cur.kx += 1;
          const arr = row.buckets.get(x);
          if (!arr || !arr.length) continue;
          cur.arr = arr;
          cur.bi = 0;
          cur.stats.buckets += 1;
          return true;
        }
      }
      cur.y += 1;
      cur.row = null;
      cur.keys = null;
    }
    cur.phase = 'big';
    return false;
  }

  /**
   * 按预算扫一批，返回 true = 扫完了。
   * @param {number} budgetMs 0/负数 = 不限预算（老调用方一次扫完）
   */
  function queryStep(cur, budgetMs) {
    if (cur.done) return true;
    // 索引换代了（这中间有新数据写进来 / 整表重建过）：从头再来（结果数组清掉、去重戳换新）
    if (World._grid !== cur.grid || World._gridStamp !== cur.gridStamp) {
      queryReset(cur);
      if (cur.done) return true;
    }
    cur.stats.passes += 1;
    const out = cur.out;
    const countOnly = !!cur.countOnly;
    const box = cur.box;
    const q = cur.q;
    const deadline = budgetMs > 0 ? nowMs() + budgetMs : Infinity;
    /**
     * 桶内循环是**最热的一段**（z16 一屏几千个候选），所以计数器走局部变量、
     * 只在交出控制权时写回 cur.stats：每个候选少两次属性访问，实测能省 ~20% 的这一段。
     */
    let cand = 0;
    let dedup = 0;
    let unique = 0;
    for (;;) {
      if (cur.arr) {
        const arr = cur.arr;
        while (cur.bi < arr.length) {
          const id = arr[cur.bi++];
          cand += 1;
          const way = World.ways.get(id);
          if (!way || way._q === q) { dedup += 1; continue; }
          way._q = q;
          unique += 1;
          if (!countOnly) out.push(way);
          /**
           * 桶内也要看表：一个格子可能挂着几千条 way，只看"每个桶一次"的话，
           * 单步的耗时就由最胖的那个桶决定（预算就形同虚设）。
           * 每 256 条查一次，超预算就**原地保留 cur.arr / cur.bi** 退出，下一帧接着扫。
           */
          if ((cand & 255) === 0 && nowMs() > deadline) {
            cur.stats.candidates += cand;
            cur.stats.dedup += dedup;
            cur.stats.unique += unique;
            return false;
          }
        }
        cur.arr = null;
      }
      if (cur.phase === 'rows') {
        if (nextBucket(cur)) {
          // 每 64 个桶看一次时钟：读时钟本身也有代价，别每个桶都读
          cur.ticks += 1;
          if ((cur.ticks & 63) === 0 && nowMs() > deadline) {
            cur.stats.candidates += cand;
            cur.stats.dedup += dedup;
            cur.stats.unique += unique;
            return false;
          }
          continue;                            // 桶就绪，下一轮把桶里的 id 扫完
        }
      }
      if (cur.phase === 'big') {
        // 大要素（bbox 跨格太多没进网格的）：只有几条到几十条，单独过一遍
        for (let i = 0; i < World._bigWays.length; i++) {
          const way = World.ways.get(World._bigWays[i]);
          if (!way || way._q === q) continue;
          way._q = q;
          const b = World.wayBBox(way);
          if (!b) continue;
          if (b.maxLon < box.minLon || b.minLon > box.maxLon
            || b.maxLat < box.minLat || b.minLat > box.maxLat) continue;
          unique += 1;
          if (!countOnly) out.push(way);
        }
        cur.phase = 'done';
      }
      cur.stats.candidates += cand;
      cur.stats.dedup += dedup;
      cur.stats.unique += unique;
      cur.done = true;
      return true;
    }
  }

  const World = {
    nodes: new Map(),
    ways: new Map(),
    relations: new Map(),
    /**
     * **低缩放合并折线**（服务端 `payload.displayLines`）：`class / name? / tags? / coords (+paths)`，
     * **只有几何，没有 way id** —— 渲染层把它们按样式规则画出来，但不参与拾取/编辑
     * （低缩放是**只读视图**：**z ≥ 服务端的 coalesce.minZoom（默认 15，即"只看不改"边界 +
     *   1；边界常量见 server/osmdb.js 的 VIEW_ONLY_MAX_ZOOM = 14）**时服务端一条都不合并，
     *   真 way id 全部照旧下发，所以编辑与拾取一点不受影响）。
     *
     * 为什么要有它：z13 一屏里"主干道 + 铁路 + 水系 + 边界"就有 1 万条上下，
     * 逐条下发会把服务端的条数上限打满、逼客户端拆块（见 server/osmdb.js 的 _coalesce）。
     * 合并之后同一条街只发一条接好龙、简化过的折线，条数从"万"降到"百"。
     *
     * 存储：Map<key, line>，key = 类 + 名字 + 标签 + bbox（同一块瓦片重复到达时按 key 去重）。
     */
    displayLines: new Map(),
    /** displayLines 是按**某个缩放**简化过的：换缩放时整批换掉（不同缩放的简化结果不能混用） */
    displayLineZoom: null,
    displayLineStats: { lines: 0, paths: 0, points: 0, added: 0, updated: 0, removed: 0, at: 0 },
    /**
     * **低缩放合并面**（服务端 `payload.displayAreas`）：与 displayLines 完全同一套语义
     * （只有几何、没有 way id → 只画不选不改），区别只是它们画成**面**。
     * 服务端把这一档画得出来的面几何（闭合水面/绿地/用地、面关系的接龙环）量化 + 按像素简化后
     * 放在这里，于是原始 way 几何与节点坐标就不再下发（z10 一屏 2.47 MB → 1.01 MB）。
     * 换缩放整批换掉（简化容差是按缩放算的），存 Map<key, area>。
     */
    displayAreas: new Map(),
    displayAreaZoom: null,
    displayAreaStats: { areas: 0, rings: 0, points: 0, added: 0, updated: 0, removed: 0, at: 0 },
    lastViewport: null,
    generation: 0,
    /** 数据版本号：任何写入都 +1，渲染层用它判断"要不要重建场景" */
    dataStamp: 1,
    /**
     * 几何版本号：只有"形状真的变了"（新增/删除要素、节点坐标变化）才 +1。
     * bbox 缓存与空间索引都挂在它上面，所以"只合并了标签/版本号"的视口响应
     * 不会让索引整表重建（以前每次分块数据到达都要重建一次，60ms 起步）。
     */
    geomStamp: 1,
    /** 当前视野（由渲染层/视口加载层更新）：清理时用它保证视野内的要素一个都不丢 */
    viewportBox: null,
    /** 上次评估卸载时的视野（用来算"拖了几屏"） */
    _evalViewport: null,
    /** 最近一次卸载的报告（unloadStats() 读它） */
    _unload: null,
    /**
     * 观察窗：用来回答"拖了几屏之后本地要素数从多少掉到了多少"。
     * peakFeatures 是本窗口里本地要素数的最高点（= 拖动前的规模），
     * screens 是本窗口累计拖动的屏数；本地要素数创新高时窗口重开。
     */
    _unloadWindow: null,
    /** 自检跑的时候别刷控制台 */
    _unloadSilent: false,
    /**
     * 「视野外卸载」的逐次日志：**默认关闭** —— 每次拖动都会卸载一批要素，
     * 开着就是把控制台刷满（生产环境没人要看这个）。
     * 打开方式（任选其一）：
     *   - 控制台执行 `localStorage.setItem('osmcity.debug', '1')` 后刷新（全局调试开关，见 util.debugOn）；
     *   - 或者当前页面直接 `window.G.World.logUnload = true`（只开这一条）。
     * 卸载的统计随时能读：`window.G.World.unloadStats()`（状态栏/自检也用它），不需要读日志。
     */
    logUnload: false,
    /** 沙盒自检正在进行（这期间的卸载不能惊动渲染层） */
    _sandboxActive: false,
    /** 卸载完成后的回调（渲染层用它把已经不在本地的引用摘掉；不重建、不重画） */
    onUnload: null,
    /**
     * **本地编辑落地（op ack）后修好了几何**的回调：渲染层收到后必须"重建 + 重画覆盖画布"。
     * 为什么必须有它：修的是 way 的几何缓存与索引项，画面上那一条路还是旧的 ——
     * 不通知渲染层，玩家看到的就是"编辑完了，地图没变"（见 refreshNodesGeometry 的说明）。
     */
    onGeometryFixed: null,
    /**
     * "编辑器原地改过坐标"的节点：{ id, lat, lon }（lat/lon 是**World 自己写进去的那一份**，
     * 也就是索引里登记的那份 bbox 所在的位置）。见 refreshNodesGeometry / flushGeometryDrift。
     */
    _driftNodes: [],
    /** 同一批里漂移节点太多（异常情况）→ 不逐条修，直接整表重建索引（保守但绝不会错） */
    _driftOverflow: false,
    /** 正在驱动"当前视野"的视口加载器（MapData.init 会登记进来）：卸载时要把它的缓存范围作废 */
    mapData: null,
    /** 兼容旧字段名（外部/日志仍在读 pruneStats） */
    pruneStats: { removed: 0, at: 0, total: 0 },
    /**
     * "无论如何都不要卸载"的元素（"type:id"）。
     *  · pin()/unpin()：选中的、正在编辑的、被锁定的；
     *  · keepForUndo()/forgetUndoKeep()：当前撤销栈需要的。
     */
    pinned: new Set(),
    undoKeep: new Set(),
    /** 带标签的节点（POI）：只索引这些，别为了找 POI 遍历十几万个普通节点 */
    taggedNodes: new Map(),
    /**
     * "节点还没到齐"的 way（wayBBox 发现缺节点时登记进来）。
     * 为什么必须单独记一笔：`geomStamp` 只在"已有节点坐标变了 / way 的节点序列变了"时 +1，
     * **新增节点不会**（否则每合并一块瓦片都要重建整张空间索引）。于是"way 先到、节点后到"
     * 的那些 way 会一直拿着"缺点"的 bbox 与投影缓存 —— 画面上就是永久少一块，
     * completeness() 会把它算成**计划外缺失**（实测 z11 上正是这个：缺 1 个面）。
     * 节点一到，就只把这一小撮 way 的缓存作废重算（不碰整张索引）。
     */
    _incompleteWays: new Set(),

    /* ------------------------------ 分阶段计时（"拖一屏到底慢在哪儿"） ------------------------------ */
    /**
     * World / MapData / Render 三个模块把自己那一段的耗时都记到这里，于是"拖一屏"的分解
     * （fetch 网络 / merge 合并 / index 索引 / rebuild 重建 / draw 画布）能一次读出来：
     *   · perfAdd(name, ms) —— 累加一个阶段（同时累计到会话总计）
     *   · perfBegin(label)  —— 开一轮（视图一变就开始），开关一轮会先把上一轮收掉
     *   · perfClose()       —— 收一轮，快照留在 perf.last
     *   · perfSnapshot()    —— 最近一轮 + 会话累计（排查/状态栏/自检都读它）
     */
    perf: {
      label: '', startedAt: 0, round: 0, open: false,
      stages: {}, counts: {}, total: {}, totalCounts: {},
      last: null, at: 0,
    },

    perfBegin(label) {
      const p = World.perf;
      if (p.open) World.perfClose();
      p.label = label || 'pan';
      p.startedAt = nowMs();
      p.stages = {};
      p.counts = {};
      p.open = true;
      p.round += 1;
      return p.startedAt;
    },

    perfAdd(name, ms) {
      if (!name || !Number.isFinite(ms) || ms < 0) return 0;
      const p = World.perf;
      p.stages[name] = (p.stages[name] || 0) + ms;
      p.counts[name] = (p.counts[name] || 0) + 1;
      p.total[name] = (p.total[name] || 0) + ms;
      p.totalCounts[name] = (p.totalCounts[name] || 0) + 1;
      p.at = Date.now();
      return ms;
    },

    perfClose(now) {
      const p = World.perf;
      if (!p.open) return null;
      const t = Number.isFinite(now) ? now : nowMs();
      p.open = false;
      const snap = {
        label: p.label,
        round: p.round,
        at: Date.now(),
        totalMs: Math.round((t - p.startedAt) * 10) / 10,
        stages: Object.assign({}, p.stages),
        counts: Object.assign({}, p.counts),
      };
      p.last = snap;
      return snap;
    },

    perfReset() {
      const p = World.perf;
      p.stages = {};
      p.counts = {};
      p.total = {};
      p.totalCounts = {};
      p.open = false;
      p.last = null;
      p.round = 0;
      return true;
    },

    perfSnapshot() {
      const p = World.perf;
      const live = p.open ? (nowMs() - p.startedAt) : 0;
      return {
        label: p.label,
        round: p.round,
        open: p.open,
        totalMs: p.last ? p.last.totalMs : Math.round(live * 10) / 10,
        lastLabel: p.last ? p.last.label : '',
        stages: Object.assign({}, p.last ? p.last.stages : p.stages),
        counts: Object.assign({}, p.last ? p.last.counts : p.counts),
        totals: Object.assign({}, p.total),
        totalCounts: Object.assign({}, p.totalCounts),
        at: p.at || 0,
      };
    },

    /* ------------------------------ 分阶段统计（Module 级：World 自己那一段） ------------------------------ */
    stats: {
      mergeMs: 0, mergeWorkMs: 0, mergeCount: 0, mergeLastMs: 0,
      mergedNodes: 0, mergedWays: 0, mergedRelations: 0, updatedWays: 0,
      indexInsertMs: 0, indexInserts: 0, indexRemoveMs: 0, indexRemoves: 0,
      indexBuildMs: 0, indexBuilds: 0, indexCells: 0, indexRows: 0,
      /**
       * 查询账本。**"遍历次数"= queryLastCells**，口径是"看过的索引行数 + 真的扫过的桶数"：
       * 老实现（按格遍历）的同一个数就是"矩形里的格子总数"，与视野里有没有数据无关，
       * 所以低缩放时能到几十万（见 tests/tmp-editfix/qways-bench.js 的实测表）。
       */
      queryMs: 0, queryCount: 0, queryLastMs: 0, queryLastWays: 0, queryLastNodes: 0,
      queryLastKind: '', queryLastCells: 0, queryLastRows: 0, queryLastBuckets: 0,
      queryLastCandidates: 0, queryLastDedup: 0, queryLastPasses: 0,
      /** 本地编辑落地后被"就地修正几何/索引"的 way 条数（>0 说明 ack 里带了原地改动） */
      geomSyncedWays: 0, geomSyncMs: 0, geomSyncLastMs: 0, geomSyncCount: 0,
      unloadMs: 0, unloadCount: 0, unloadLastMs: 0, unloadRemoved: 0, unloadSkipped: 0,
      /** "节点后到"被修好的 way 条数（>0 说明这一轮合并真的补了东西，不是白提醒） */
      repairedWays: 0,
      at: 0,
    },

    /** 统计清零（自检/排查用） */
    resetStats() {
      const s = World.stats;
      for (const k of Object.keys(s)) s[k] = 0;
      return s;
    },

    reset() {
      World.nodes.clear();
      World.ways.clear();
      World.relations.clear();
      World.displayLines.clear();
      World.displayLineZoom = null;
      World.displayAreas.clear();
      World.displayAreaZoom = null;
      World.pinned.clear();
      World.undoKeep.clear();
      World.taggedNodes.clear();
      World._unload = null;
      World._unloadWindow = null;
      World._evalViewport = null;
      World.viewportBox = null;
      World._incompleteWays.clear();
      World._driftNodes.length = 0;      // 本地编辑的漂移队列一起清掉（库都空了）
      World._driftOverflow = false;
      World.generation += 1;
      World.touch(true);
    },

    /* --------------------- 空间索引（只在视野内取要素，避免每次重绘扫描全库） --------------------- */
    /**
     * 索引结构（v2）：**按行分桶**。
     *   _grid:     Map<行号 y, 行>   行 = { buckets: Map<列号 x, number[]>, keys: Int32Array|null, dirty }
     *   _nodeGrid: 同一套结构（存带标签节点的 id）
     *
     * 为什么把老的 `Map<"x:y", ids>` 换掉：
     *   · 老实现一次查询要**遍历矩形里的每一个格子**，每个格子还要 `x + ':' + y` 现造一个字符串 ——
     *     代价是"矩形面积 ÷ 格子面积"，与"视野里到底有没有数据"完全无关。z13 一屏（1600×900）是
     *     504 个格子、z10 是 3.4 万、z8 是 55 万、z3 是几百万：用户拖到低缩放时这一层 for
     *     就是几百毫秒到几秒的**长任务**（浏览器调试器里"Paused while stepping"正停在这一行）。
     *   · 行桶之后：**整行没有桶的直接跳过**（低缩放时本地数据只占几行），行内有序列键 + 二分
     *     一跳就落到 [x0,x1] 的第一列，于是遍历次数 = 真的扫过的行数 + 桶数（∝ 候选要素数），
     *     与矩形面积无关；整数键也不再产生字符串垃圾。
     *   · bbox 跨格太多的大要素（> MAX_CELLS_PER_WAY）照旧进 _bigWays 线性表，单独走一遍。
     */
    _grid: null,
    _nodeGrid: null,
    _gridStamp: -1,
    _bigWays: [],
    _queryStamp: 0,

    /**
     * 数据变了。
     * @param {boolean} geometry 形状是否真的变了（节点坐标/节点序列/新增删除）。
     *   只有 true 才让 bbox 缓存与空间索引失效；标签、版本号变化不算。
     */
    touch(geometry) {
      World.dataStamp += 1;
      if (geometry) {
        World.geomStamp += 1;
        World._gridStamp = -1;
      }
    },

    /** 更新"当前视野"（卸载与索引的保留区）；视野一动就按"拖了几屏"决定要不要卸载 */
    setViewport(box, options) {
      const next = box && Number.isFinite(box.minLat) && Number.isFinite(box.maxLat)
        && Number.isFinite(box.minLon) && Number.isFinite(box.maxLon) ? box : null;
      World.viewportBox = next;
      World.lastViewport = next;
      if (!next || (options && options.noUnload)) return 0;
      return World.maybeUnload(Object.assign({ box: next }, options || {}));
    },

    /** 一个 way 的经纬度 bbox（缓存；几何版本变了才重算） */
    wayBBox(way) {
      if (!way) return null;
      if (way._bboxStamp === World.geomStamp) return way._bbox;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      let found = 0;
      for (const nid of way.nodes) {
        const n = World.nodes.get(nid);
        if (!n) continue;
        found += 1;
        if (n.lat < minLat) minLat = n.lat;
        if (n.lat > maxLat) maxLat = n.lat;
        if (n.lon < minLon) minLon = n.lon;
        if (n.lon > maxLon) maxLon = n.lon;
      }
      way._bboxStamp = World.geomStamp;
      // 节点没到齐：登记一笔，等节点到了再重算（见 _incompleteWays / _refreshIncompleteWays）
      if (found < way.nodes.length) {
        way._incomplete = true;
        World._incompleteWays.add(way);
      }
      if (!found) {
        way._bbox = null;
        return null;
      }
      way._bbox = { minLat, maxLat, minLon, maxLon };
      return way._bbox;
    },

    /**
     * 新节点到达后调用：把"之前缺节点、现在齐了"的 way 的几何缓存作废重算。
     * 只动这一小撮 way（通常 0~几个），也不会重建整张空间索引，代价可以忽略。
     * @returns {number} 被修好的 way 条数
     */
    _refreshIncompleteWays() {
      const list = World._incompleteWays;
      if (!list || !list.size) return 0;
      let fixed = 0;
      for (const way of Array.from(list)) {
        if (!World.ways.has(way.id)) { list.delete(way); continue; }
        let missing = false;
        for (const nid of way.nodes) if (!World.nodes.has(nid)) { missing = true; break; }
        if (missing) continue;                       // 还缺：留着，下次节点到了再来
        // 顺序很重要：先用**旧** bbox 从索引里摘掉（索引里登记的正是那个旧 bbox），
        // 再作废 bbox / 投影缓存，最后按新 bbox 插回去。
        const swapped = World.indexRemoveWay(way);
        way._bboxStamp = -1;
        way._geom = null;
        way._incomplete = false;
        if (swapped) World.indexInsertWay(way);
        else World._gridStamp = -1;                  // 索引维护不了 → 下次查询整表重建（保守）
        list.delete(way);
        fixed += 1;
      }
      if (fixed) World.stats.repairedWays += fixed;
      return fixed;
    },

    /**
     * 自检：**"节点比 way 晚到"必须能自愈**（可重复断言，不依赖网络/浏览器）。
     * 真实数据里很常见：某块瓦片下发了 way，而它的节点在隔壁瓦片里还没到 ——
     * 这条 way 会先用"缺点"的 bbox/几何画一次；节点到了以后必须重新画得出来，
     * 否则画面上就永久少一块（completeness() 记成计划外缺失）。
     */
    selfCheckLateNodes() {
      const steps = [];
      const failures = [];
      const check = (name, cond, detail) => {
        const ok = !!cond;
        steps.push({ name, ok, detail: detail == null ? '' : String(detail) });
        if (!ok) failures.push(name);
        return ok;
      };
      // 挑一条节点都在本地、且至少有 2 个节点的 way（自己造两条，不依赖视野）
      const id = 990000001;
      const n1 = 990000011;
      const n2 = 990000012;
      const snap = {
        way: World.ways.get(id), n1: World.nodes.get(n1), n2: World.nodes.get(n2),
        geomStamp: World.geomStamp, dataStamp: World.dataStamp,
        grid: World._grid, gridStamp: World._gridStamp, big: World._bigWays,
        incomplete: World._incompleteWays.size,
      };
      try {
        World.mergePayload({
          nodes: { [n1]: [39.9042, 116.4074], [n2]: [39.9052, 116.4084] },
          ways: { [id]: [1, [n1, n2], { highway: 'residential' }, false, 0] },
          relations: {},
        });
        const way = World.ways.get(id);
        check('合成 way 已进入本地库', !!way && way.nodes.length === 2);
        const full = World.wayBBox(way);
        // 1) 拿掉一个节点：bbox 变成"只有一半"，并且被登记为"缺节点"
        World.nodes.delete(n2);
        World.taggedNodes.delete(n2);
        World.touch(true);
        const half = World.wayBBox(way);
        check('缺一个节点时 bbox 只有半个（实验前提成立）',
          !!half && half.maxLat < full.maxLat - 1e-9,
          `half=${JSON.stringify(half && { a: half.minLat, b: half.maxLat })} full=${JSON.stringify({ a: full.minLat, b: full.maxLat })}`);
        check('缺节点的 way 被登记进"待修复"名单', World._incompleteWays.has(way), 'size=' + World._incompleteWays.size);
        // 2) 只补发那个节点（不重发 way —— 现实里隔壁瓦片的响应就是这样）
        World.mergePayload({ nodes: { [n2]: [39.9052, 116.4084] }, ways: {}, relations: {} });
        const back = World.wayBBox(way);
        check('只补发节点之后 bbox 立刻恢复成完整的',
          !!back && Math.abs(back.maxLat - full.maxLat) < 1e-12 && Math.abs(back.maxLon - full.maxLon) < 1e-12,
          `back=${JSON.stringify(back && { a: back.minLat, b: back.maxLat })}`);
        check('补节点之后 way 的投影缓存被作废（几何会重算）', !way._geom, way._geom ? 'still cached' : 'cleared');
        check('补节点之后它从"待修复"名单里摘掉了', !World._incompleteWays.has(way), 'size=' + World._incompleteWays.size);
        check('补节点之后它还能被空间索引查到',
          World.queryWays({ minLat: 39.9, maxLat: 39.91, minLon: 116.4, maxLon: 116.41 }, []).indexOf(way) >= 0);
      } finally {
        // 还原：把合成元素删掉，缓存/版本号恢复原样（不影响真实数据）
        if (snap.way) World.ways.set(id, snap.way); else World.ways.delete(id);
        if (snap.n1) World.nodes.set(n1, snap.n1); else World.nodes.delete(n1);
        if (snap.n2) World.nodes.set(n2, snap.n2); else World.nodes.delete(n2);
        World._grid = snap.grid;
        World._gridStamp = snap.gridStamp;
        World._bigWays = snap.big;
        World.geomStamp = snap.geomStamp;
        World.dataStamp = snap.dataStamp + 1;
      }
      return { ok: failures.length === 0, steps, failures };
    },

    /**
     * 自检：**本地编辑落地之后几何必须真的更新**（"编辑后地图不实时更新"的回归护栏）。
     *
     * 复刻的正是用户报的那条路：编辑器（editor.js 的 _onMouseMove）拖动时**原地改**
     * World.nodes 里节点对象的 lat/lon，随后服务端 ack 带回一模一样的坐标 ——
     * 如果不专门处理，`putNode` 会判定"没动"，geomStamp 不 +1，`way._geom`（拖动之前的
     * 坐标副本）与空间索引格子就永远停在原地：屏幕上那条路一直画在**老位置**。
     *
     * 这里用合成 way 验四件事（不依赖网络、不依赖渲染层）：
     *   · 原地改坐标之后再走 ack，**投影缓存被作废**（_geom 被清掉）；
     *   · **bbox 跟着更新**；
     *   · **空间索引搬到新位置**（新格子能查到，且没有被整表重建——只就地修了这一条）；
     *   · **通知了渲染层**（onGeometryFixed 被调用 → 渲染层据此安排重建 + 重画覆盖画布）。
     */
    selfCheckLocalEditRepaint() {
      const steps = [];
      const failures = [];
      const check = (name, cond, detail) => {
        const ok = !!cond;
        steps.push({ name, ok, detail: detail == null ? '' : String(detail) });
        if (!ok) failures.push(name);
        return ok;
      };
      const wid = 990000101;
      const nA = 990000111;
      const nB = 990000112;
      const nC = 990000113;
      const snap = {
        way: World.ways.get(wid), nA: World.nodes.get(nA), nB: World.nodes.get(nB), nC: World.nodes.get(nC),
        geomStamp: World.geomStamp, dataStamp: World.dataStamp,
        gridStamp: World._gridStamp, big: World._bigWays,
        drift: World._driftNodes.slice(), overflow: World._driftOverflow,
        stats: Object.assign({}, World.stats),
        hook: World.onGeometryFixed,
      };
      let hooked = 0;
      try {
        World.mergePayload({
          nodes: { [nA]: [39.9000, 116.4000], [nB]: [39.9010, 116.4010], [nC]: [39.9020, 116.4020] },
          ways: { [wid]: [1, [nA, nB, nC], { highway: 'residential' }, false, 0] },
          relations: {},
        });
        World.ensureIndex();                     // 索引必须有效，才谈得上"就地修正索引项"
        const way = World.ways.get(wid);
        check('合成 way 已进入本地库并被索引', !!way && World.queryWays(
          { minLat: 39.899, maxLat: 39.903, minLon: 116.399, maxLon: 116.403 }, []).indexOf(way) >= 0);
        const beforeBox = World.wayBBox(way);
        const node = World.nodes.get(nB);
        const oldCellLat = Math.floor(node.lat / CELL_DEG);
        const oldCellLon = Math.floor(node.lon / CELL_DEG);
        way._geom = { stamp: World.geomStamp, z: 16, lls: [[1, 2]] };   // 假装渲染层已经缓存过几何
        World.onGeometryFixed = () => { hooked += 1; };
        // ① 编辑器原地改坐标（跳过 World 的所有写入接口）
        node.lat += 0.02;                        // ≈ 2.2 km：必然跨格
        node.lon += 0.02;
        // ② ack：服务端把"和本地已经一样"的坐标发回来（applyOps → putNode）
        World.applyOps([{ k: 'nodeUpdate', node: { id: nB, lat: node.lat, lon: node.lon, version: 2, tags: null } }]);
        const afterBox = World.wayBBox(way);
        check('原地改坐标 + ack 之后：投影缓存被作废（几何会重算）', !way._geom, way._geom ? 'still cached' : 'cleared');
        check('原地改坐标 + ack 之后：bbox 跟着更新',
          !!afterBox && !!beforeBox && (afterBox.maxLat !== beforeBox.maxLat || afterBox.maxLon !== beforeBox.maxLon),
          `maxLat ${beforeBox && beforeBox.maxLat} → ${afterBox && afterBox.maxLat}`);
        const newCellLat = Math.floor(node.lat / CELL_DEG);
        const newCellLon = Math.floor(node.lon / CELL_DEG);
        const found = World.queryWays(
          { minLat: node.lat - 1e-6, maxLat: node.lat + 1e-6, minLon: node.lon - 1e-6, maxLon: node.lon + 1e-6 }, []);
        check('原地改坐标 + ack 之后：索引搬到了新格子（新位置查得到这条 way）',
          found.indexOf(way) >= 0, `格子 ${oldCellLat}:${oldCellLon} → ${newCellLat}:${newCellLon}`);
        check('只就地修了这一条，没有整表重建索引',
          World.stats.indexBuilds === snap.stats.indexBuilds, 'indexBuilds +' + (World.stats.indexBuilds - snap.stats.indexBuilds));
        check('通知了渲染层（onGeometryFixed）→ 渲染层据此安排重建与覆盖画布重画',
          hooked >= 1, hooked + ' 次');
        check('本地数据版本号 +1（渲染层据此认为"数据变了"）', World.dataStamp > snap.dataStamp,
          snap.dataStamp + ' → ' + World.dataStamp);
        /**
         * 第二段：拖的是**中间那个节点**（way 的 bbox 一点没变）。
         * 只搬索引是不够的 —— 画出来的那条折线也必须跟着动，所以投影缓存一律作废。
         */
        const wid2 = 990000102;
        const m1 = 990000121;
        const m2 = 990000122;
        const m3 = 990000123;
        World.mergePayload({
          nodes: { [m1]: [39.9100, 116.4100], [m2]: [39.9110, 116.4110], [m3]: [39.9120, 116.4120] },
          ways: { [wid2]: [1, [m1, m2, m3], { highway: 'residential' }, false, 0] },
          relations: {},
        });
        World.ensureIndex();
        const way2 = World.ways.get(wid2);
        const midNode = World.nodes.get(m2);
        const box2 = Object.assign({}, World.wayBBox(way2));
        way2._geom = { stamp: World.geomStamp, z: 16, lls: [[1, 2]] };
        midNode.lat += 0.0002;                   // 中间节点：头尾没动
        midNode.lon += 0.0002;
        World.applyOps([{ k: 'nodeUpdate', node: { id: m2, lat: midNode.lat, lon: midNode.lon, version: 2, tags: null } }]);
        const box2b = World.wayBBox(way2);
        check('拖中间节点（bbox 不变）也必须作废投影缓存', !way2._geom, way2._geom ? 'still cached' : 'cleared');
        check('bbox 没变时不用搬索引（登记的格子还是对的）',
          box2.minLat === box2b.minLat && box2.maxLat === box2b.maxLat
          && box2.minLon === box2b.minLon && box2.maxLon === box2b.maxLon,
          `minLat ${box2.minLat} / maxLat ${box2.maxLat}`);
        if (World._grid && World._gridStamp === World.geomStamp) World.indexRemoveWay(way2);
        World.ways.delete(wid2);
        World.nodes.delete(m1);
        World.nodes.delete(m2);
        World.nodes.delete(m3);
      } finally {
        // 还原：把合成元素与索引项清掉，版本号/统计恢复原样（不影响真实数据）
        const way = World.ways.get(wid);
        if (way && World._grid && World._gridStamp === World.geomStamp) World.indexRemoveWay(way);
        if (snap.way) World.ways.set(wid, snap.way); else World.ways.delete(wid);
        if (snap.nA) World.nodes.set(nA, snap.nA); else World.nodes.delete(nA);
        if (snap.nB) World.nodes.set(nB, snap.nB); else World.nodes.delete(nB);
        if (snap.nC) World.nodes.set(nC, snap.nC); else World.nodes.delete(nC);
        World._gridStamp = snap.gridStamp;
        World._bigWays = snap.big;
        World.geomStamp = snap.geomStamp;
        World.dataStamp = snap.dataStamp + 1;
        World._driftNodes = snap.drift;
        World._driftOverflow = snap.overflow;
        World.onGeometryFixed = snap.hook;
        for (const k of Object.keys(snap.stats)) World.stats[k] = snap.stats[k];
      }
      return { ok: failures.length === 0, steps, failures };
    },

    /* ---------------- 索引的增量维护：新来的要素直接插进去，不整表重建 ---------------- */
    /** 遍历 bbox 覆盖的格子（fn(x, y, arg)）；跨格太多（大要素）返回 false */
    _forEachCell(b, fn, arg) {
      const x0 = Math.floor(b.minLon / CELL_DEG);
      const x1 = Math.floor(b.maxLon / CELL_DEG);
      const y0 = Math.floor(b.minLat / CELL_DEG);
      const y1 = Math.floor(b.maxLat / CELL_DEG);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_WAY) return false; // 大要素进 big 列表
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(x, y, arg);
      return true;
    },

    /** 把一个 way 插进索引（索引不存在/已失效时什么都不做，等下次整表重建） */
    indexInsertWay(way) {
      if (!World._grid || World._gridStamp !== World.geomStamp) return;
      const t0 = nowMs();
      const b = World.wayBBox(way);
      if (!b) return;
      if (!World._forEachCell(b, cellInsert, way.id)) {
        if (World._bigWays.indexOf(way.id) < 0) World._bigWays.push(way.id);
      }
      const ms = nowMs() - t0;
      World.stats.indexInsertMs += ms;
      World.stats.indexInserts += 1;
      World.perfAdd('index', ms);
    },

    /** 把一个 way 从索引里摘掉（用它缓存里的旧 bbox） */
    indexRemoveWay(way) {
      if (!World._grid || !way || way._bboxStamp !== World.geomStamp) return false;
      const b = way._bbox;
      if (!b) return false;
      if (!World._forEachCell(b, cellRemove, way.id)) {
        const i = World._bigWays.indexOf(way.id);
        if (i >= 0) World._bigWays.splice(i, 1);
        return true;
      }
      return true;
    },

    indexInsertNode(node) {
      if (!World._nodeGrid || World._gridStamp !== World.geomStamp) return;
      if (!node.tags) return;
      cellInsertNode(Math.floor(node.lon / CELL_DEG), Math.floor(node.lat / CELL_DEG), node.id);
    },
    /**
     * 把一个 POI 从节点索引里摘掉（卸载时用）。
     * 增量维护的意义：卸载不必作废几何缓存，下一次重绘不用重算坐标。
     */
    indexRemoveNode(node) {
      if (!World._nodeGrid || World._gridStamp !== World.geomStamp) return false;
      if (!node || !Number.isFinite(node.lat) || !Number.isFinite(node.lon)) return false;
      cellRemoveNode(Math.floor(node.lon / CELL_DEG), Math.floor(node.lat / CELL_DEG), node.id);
      return true;
    },

    /** 整表重建索引（数据几何版本变了、或增量维护失败时） */
    _buildIndex() {
      const t0 = nowMs();
      const grid = new Map();
      const nodeGrid = new Map();
      const big = [];
      for (const [id, way] of World.ways) {
        const b = World.wayBBox(way);
        if (!b) continue;
        const x0 = Math.floor(b.minLon / CELL_DEG);
        const x1 = Math.floor(b.maxLon / CELL_DEG);
        const y0 = Math.floor(b.minLat / CELL_DEG);
        const y1 = Math.floor(b.maxLat / CELL_DEG);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_WAY) { big.push(id); continue; }
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) rowPush(gridRow(grid, y, true), x, id);
        }
      }
      for (const [id, node] of World.taggedNodes) {
        if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon)) continue;
        const x = Math.floor(node.lon / CELL_DEG);
        const y = Math.floor(node.lat / CELL_DEG);
        rowPush(gridRow(nodeGrid, y, true), x, id);
      }
      World._grid = grid;
      World._nodeGrid = nodeGrid;
      World._bigWays = big;
      World._gridStamp = World.geomStamp;
      // 整表重建索引很贵（几万条 way）：单独记账，排查时一眼能看出"是不是又整表重建了"
      const ms = nowMs() - t0;
      let buckets = 0;
      for (const row of grid.values()) buckets += row.buckets.size;
      World.stats.indexBuildMs += ms;
      World.stats.indexBuilds += 1;
      World.stats.indexCells = buckets;
      World.stats.indexRows = grid.size;
      World.perfAdd('indexBuild', ms);
    },

    ensureIndex() {
      if (!World._grid || World._gridStamp !== World.geomStamp) World._buildIndex();
      return World._grid;
    },

    /* --------------------- 矩形查询：游标（可按预算暂停）+ 一次性取全 --------------------- */
    /**
     * 空间查询游标：把"扫矩形"拆成可以**按预算暂停/续跑**的小步，于是：
     *   · `World.queryWays(box)`            —— 一次扫完（老调用方不用改）；
     *   · `World.queryWaysCursor(box).step(ms)` —— 渲染层的分帧重建可以每次只花几毫秒收集，
     *     下一帧接着收集，**不会再有"一次查询就把主线程按住几百毫秒"的长任务**。
     *
     * 遍历顺序：行 → 行内 [x0,x1] 的桶 → 桶内 way id；整行没有桶的直接跳过。
     * 跨格太多的大要素（_bigWays）在最后单独走一遍（只有几条到几十条）。
     *
     * @param {{minLat:number,maxLat:number,minLon:number,maxLon:number}} box
     * @param {Array} out 复用的结果数组（**内部数组，调用方只读**）
     */
    queryWaysCursor(box, out) {
      const result = out || [];
      result.length = 0;
      const cur = {
        box: box || null, out: result, done: !box, phase: box ? 'rows' : 'done',
        grid: null, gridStamp: -1, q: 0,
        x0: 0, x1: 0, y: 0, y1: 0,
        row: null, keys: null, kx: 0, arr: null, bi: 0, ticks: 0,
        stats: { rows: 0, buckets: 0, candidates: 0, dedup: 0, passes: 0 },
        step: null, reset: null,
      };
      cur.step = (budgetMs) => queryStep(cur, budgetMs);
      cur.reset = () => { queryReset(cur); return cur; };
      if (box) queryReset(cur);
      return cur;
    },

    /**
     * 取 bbox 内的 way 列表（返回内部数组，调用方只读）。
     * 这是渲染层"只处理看得见的要素"的关键：没有它每次重绘都要遍历整个本地库。
     */
    queryWays(box, out) {
      const result = out || [];
      result.length = 0;
      if (!box) return result;
      /**
       * 兜底：本地编辑原地改过坐标、而那条路径没有 op ack（或忘了显式通知）时，
       * 也在"下一次查询之前"把几何/索引修正掉 —— 否则屏幕上会一直少一块新几何。
       * 队列为空时这里只是一次数组长度判断，零成本。
       */
      if (World._driftNodes.length || World._driftOverflow) World.flushGeometryDrift();
      const t0 = nowMs();
      const cur = World.queryWaysCursor(box, result);
      cur.step(0);                    // 0 = 不限预算
      World._queryDone(cur, t0, 'query');
      return result;
    },

    /**
     * 只要条数、不要数组（"先报数再决定要不要取"）：同样不做任何大数组分配，
     * 用与 queryWays 同一套遍历口径（同一份索引、同一个去重戳）。
     */
    countWays(box) {
      if (!box) return 0;
      const t0 = nowMs();
      const cur = World.queryWaysCursor(box, World._countScratch || (World._countScratch = []));
      cur.countOnly = true;
      cur.step(0);
      World._queryDone(cur, t0, 'count');
      return cur.stats.unique;
    },

    /** 查询收尾记账（走哪一个入口都记同一套数） */
    _queryDone(cur, t0, kind) {
      const ms = nowMs() - t0;
      const st = World.stats;
      st.queryMs += ms;
      st.queryCount += 1;
      st.queryLastMs = ms;
      st.queryLastKind = kind;
      st.queryLastWays = cur.countOnly ? (cur.stats.unique || 0) : cur.out.length;
      // "遍历次数" = 看过的行数 + 真的扫过的桶数（老实现这里是矩形的**格子总数**）
      st.queryLastCells = cur.stats.rows + cur.stats.buckets;
      st.queryLastRows = cur.stats.rows;
      st.queryLastBuckets = cur.stats.buckets;
      st.queryLastCandidates = cur.stats.candidates;
      st.queryLastDedup = cur.stats.dedup;
      st.queryLastPasses = cur.stats.passes;
      World.perfAdd('query', ms);
      st.at = Date.now();
      return ms;
    },

    /** 取 bbox 内带标签的独立节点（POI）；没有标签的节点不参与渲染 */
    queryTaggedNodes(box, out) {
      const result = out || [];
      result.length = 0;
      if (!box) return result;
      const t0 = nowMs();
      World.ensureIndex();
      const stamp = ++World._queryStamp;
      let rows = 0;
      let buckets = 0;
      const y0 = Math.floor(box.minLat / CELL_DEG);
      const y1 = Math.floor(box.maxLat / CELL_DEG);
      const x0 = Math.floor(box.minLon / CELL_DEG);
      const x1 = Math.floor(box.maxLon / CELL_DEG);
      const grid = World._nodeGrid;
      for (let y = y0; y <= y1; y++) {
        rows += 1;
        const row = grid.get(y);
        if (!row) continue;                       // 整行没有 POI：一个格子都不用看
        const keys = rowKeys(row);
        for (let i = lowerBound(keys, x0); i < keys.length && keys[i] <= x1; i++) {
          const arr = row.buckets.get(keys[i]);
          if (!arr) continue;
          buckets += 1;
          for (let j = 0; j < arr.length; j++) {
            const node = World.nodes.get(arr[j]);
            if (!node || node._q === stamp) continue;
            node._q = stamp;
            result.push(node);
          }
        }
      }
      World.stats.queryLastNodes = result.length;
      World.stats.queryLastNodeRows = rows;
      World.stats.queryLastNodeBuckets = buckets;
      World.perfAdd('queryNodes', nowMs() - t0);
      return result;
    },

    /* --------------------- 低缩放合并折线（服务端 displayLines） --------------------- */
    /**
     * 一个 displayLines 条目的稳定指纹：**同一块瓦片重复到达**（拖动条带互相重叠、
     * 拆块后父块被重取）时靠它去重，不必把同一条街存两遍。
     * 用"类 + 名字 + 标签 + bbox（5 位小数 ≈ 1 m）"：同一块瓦片上的同一条街，服务端的
     * 接龙/简化是确定性的，所以指纹稳定；不同瓦片上的同一条街几何各简化各的，指纹也不同 ——
     * 各自画各自的那一段，正好互相覆盖（客户端本来就是"相邻缓存矩形互相覆盖"的口径）。
     */
    displayLineKeyOf(line, box) {
      const tags = line.tags || {};
      let tk = '';
      for (const k of Object.keys(tags).sort()) tk += k + '=' + tags[k] + ';';
      return (line.class || '') + '\u0001' + (line.name || '') + '\u0001' + tk + '\u0001'
        + box.minLat.toFixed(5) + ',' + box.minLon.toFixed(5) + ',' + box.maxLat.toFixed(5) + ',' + box.maxLon.toFixed(5);
    },

    /** 一条折线的 bbox（coords + paths 里的每一段都算上），算一次就缓存 */
    displayLineBox(line) {
      if (line._bbox) return line._bbox;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      const paths = [line.coords].concat(line.paths || []);
      for (const path of paths) {
        if (!path) continue;
        for (const c of path) {
          if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
          if (c[0] < minLat) minLat = c[0];
          if (c[0] > maxLat) maxLat = c[0];
          if (c[1] < minLon) minLon = c[1];
          if (c[1] > maxLon) maxLon = c[1];
        }
      }
      line._bbox = Number.isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : null;
      return line._bbox;
    },

    /** 折线上总共有多少个坐标点（诊断/统计用） */
    displayLinePoints(line) {
      let n = 0;
      const paths = [line.coords].concat(line.paths || []);
      for (const p of paths) if (p) n += p.length;
      return n;
    },

    /**
     * 合并一块响应里的 `payload.displayLines`。返回新增条数（已存在的按指纹去重）。
     *
     * 换缩放要**整批换掉**：折线是按某一档缩放简化过的（容差 = 该缩放的 1 像素），
     * 把 z13 简化过的折线留在 z15 的画面上就会"比该有的更粗"，而且和 z15 新到的折线叠在一起。
     * 服务端每个 displayLines 条目都不带 id，所以这里只能按"这一批是哪个缩放请求来的"来管。
     */
    mergeDisplayLines(lines, zoom) {
      const list = Array.isArray(lines) ? lines : [];
      if (!list.length) return 0;
      if (World.displayLineZoom !== zoom) {
        World.displayLines.clear();
        World.displayLineZoom = zoom === undefined ? null : zoom;
      }
      let added = 0;
      let paths = 0;
      let points = 0;
      for (const line of list) {
        if (!line || !Array.isArray(line.coords) || line.coords.length < 2) continue;
        const box = World.displayLineBox(line);
        if (!box) continue;
        const key = World.displayLineKeyOf(line, box);
        if (World.displayLines.has(key)) {
          World.displayLines.get(key).at = Date.now();
          World.displayLineStats.updated = (World.displayLineStats.updated || 0) + 1;
          continue;
        }
        line.key = key;
        line.at = Date.now();
        line.zoom = zoom;
        World.displayLines.set(key, line);
        added += 1;
        paths += 1 + (line.paths ? line.paths.length : 0);
        points += World.displayLinePoints(line);
      }
      const st = World.displayLineStats;
      st.added = (st.added || 0) + added;
      st.lines = World.displayLines.size;
      st.paths = paths;
      st.points = points;
      st.at = Date.now();
      if (added) World.perfAdd('mergeDisplayLines', 0);
      // 安全阀：折线条数不该无界增长（正常一屏几百~一千五百条）；超了就按"离视野多远"丢最远的
      if (World.displayLines.size > MAX_DISPLAY_LINES) World._pruneDisplayLines();
      return added;
    },

    /**
     * 取与 box 相交的合并折线（线性扫一遍缓存的 bbox —— 一屏只有几百~一两千条，很便宜）。
     * 返回内部数组，调用方只读。
     */
    queryDisplayLines(box, out) {
      const result = out || [];
      result.length = 0;
      if (!box) return result;
      const t0 = nowMs();
      for (const line of World.displayLines.values()) {
        const b = line._bbox || World.displayLineBox(line);
        if (!b) continue;
        if (b.maxLat < box.minLat || b.minLat > box.maxLat
          || b.maxLon < box.minLon || b.minLon > box.maxLon) continue;
        result.push(line);
      }
      World.stats.queryDisplayLines = (World.stats.queryDisplayLines || 0) + 1;
      World.stats.queryDisplayLinesLast = result.length;
      World.perfAdd('queryDisplayLines', nowMs() - t0);
      return result;
    },

    /** displayLines 的统计（状态栏/自检/排查都读它） */
    displayLineReport() {
      const st = World.displayLineStats;
      let paths = 0;
      let points = 0;
      let inView = 0;
      const view = World.viewportBox;
      for (const line of World.displayLines.values()) {
        paths += 1 + (line.paths ? line.paths.length : 0);
        points += World.displayLinePoints(line);
        if (view) {
          const b = line._bbox || World.displayLineBox(line);
          if (b && !(b.maxLat < view.minLat || b.minLat > view.maxLat
            || b.maxLon < view.minLon || b.minLon > view.maxLon)) inView += 1;
        }
      }
      return {
        lines: World.displayLines.size, paths, points, inView,
        zoom: World.displayLineZoom,
        added: st.added || 0, updated: st.updated || 0, removed: st.removed || 0, at: st.at || 0,
      };
    },

    /** 超出硬上限时丢掉"离当前视野最远"的折线（只在视野存在时才丢，绝不清空视野里的） */
    _pruneDisplayLines() {
      const view = World.viewportBox;
      const items = [...World.displayLines.values()];
      if (!view) items.sort((a, b) => (a.at || 0) - (b.at || 0));
      else {
        const cx = (view.minLon + view.maxLon) / 2;
        const cy = (view.minLat + view.maxLat) / 2;
        const dist = (line) => {
          const b = line._bbox || World.displayLineBox(line);
          if (!b) return Infinity;
          const dx = (b.minLon + b.maxLon) / 2 - cx;
          const dy = (b.minLat + b.maxLat) / 2 - cy;
          return dx * dx + dy * dy;
        };
        items.sort((a, b) => dist(b) - dist(a));
      }
      const drop = items.slice(0, Math.max(0, items.length - MAX_DISPLAY_LINES));
      for (const line of drop) World.displayLines.delete(line.key);
      World.displayLineStats.removed = (World.displayLineStats.removed || 0) + drop.length;
      return drop.length;
    },

    /* --------------------- 低缩放合并面（服务端 displayAreas） --------------------- */
    /**
     * 与 displayLines **完全对称**的一套：指纹、bbox、点数、去重、换缩放整批换、上限裁剪。
     * 所以这里直接复用 displayLineKeyOf / displayLineBox / displayLinePoints —— 它们的实现
     * 只看 `class / name / tags / coords (+paths)` 这些字段，对面条目**一字不差**地成立。
     *
     * 语义（服务端 osmdb.js 的「低缩放视图载荷」说得很清楚，客户端这边只有两条）：
     *   · 它们**没有 way id**：不进空间索引、不能被选中/编辑，只被画出来；
     *   · 一条 displayArea 的 `coords` 是一个环，`paths` 是同一组里的其余环（面关系的接龙环也在里面）。
     *     闭合的环画成填充，**没闭合的环只画描边**（宁可少填一块，也不把断开的岸线填成三角形）。
     */
    mergeDisplayAreas(areas, zoom) {
      const list = Array.isArray(areas) ? areas : [];
      if (!list.length) return 0;
      if (World.displayAreaZoom !== zoom) {
        World.displayAreas.clear();
        World.displayAreaZoom = zoom === undefined ? null : zoom;
      }
      let added = 0;
      let rings = 0;
      let points = 0;
      for (const area of list) {
        if (!area || !Array.isArray(area.coords) || area.coords.length < 3) continue;
        const box = World.displayLineBox(area);
        if (!box) continue;
        const key = World.displayLineKeyOf(area, box);
        if (World.displayAreas.has(key)) {
          World.displayAreas.get(key).at = Date.now();
          World.displayAreaStats.updated = (World.displayAreaStats.updated || 0) + 1;
          continue;
        }
        area.key = key;
        area.at = Date.now();
        area.zoom = zoom;
        World.displayAreas.set(key, area);
        added += 1;
        rings += 1 + (area.paths ? area.paths.length : 0);
        points += World.displayLinePoints(area);
      }
      const st = World.displayAreaStats;
      st.added = (st.added || 0) + added;
      st.areas = World.displayAreas.size;
      st.rings = rings;
      st.points = points;
      st.at = Date.now();
      if (added) World.perfAdd('mergeDisplayAreas', 0);
      if (World.displayAreas.size > MAX_DISPLAY_AREAS) World._pruneDisplayAreas();
      return added;
    },

    /** 取与 box 相交的合并面（与 queryDisplayLines 同一套线性扫描） */
    queryDisplayAreas(box, out) {
      const result = out || [];
      result.length = 0;
      if (!box) return result;
      const t0 = nowMs();
      for (const area of World.displayAreas.values()) {
        const b = area._bbox || World.displayLineBox(area);
        if (!b) continue;
        if (b.maxLat < box.minLat || b.minLat > box.maxLat
          || b.maxLon < box.minLon || b.minLon > box.maxLon) continue;
        result.push(area);
      }
      World.stats.queryDisplayAreas = (World.stats.queryDisplayAreas || 0) + 1;
      World.stats.queryDisplayAreasLast = result.length;
      World.perfAdd('queryDisplayAreas', nowMs() - t0);
      return result;
    },

    /** displayAreas 的统计（状态栏/自检/排查都读它） */
    displayAreaReport() {
      const st = World.displayAreaStats;
      let rings = 0;
      let points = 0;
      let inView = 0;
      const view = World.viewportBox;
      for (const area of World.displayAreas.values()) {
        rings += 1 + (area.paths ? area.paths.length : 0);
        points += World.displayLinePoints(area);
        if (view) {
          const b = area._bbox || World.displayLineBox(area);
          if (b && !(b.maxLat < view.minLat || b.minLat > view.maxLat
            || b.maxLon < view.minLon || b.minLon > view.maxLon)) inView += 1;
        }
      }
      return {
        areas: World.displayAreas.size, rings, points, inView,
        zoom: World.displayAreaZoom,
        added: st.added || 0, updated: st.updated || 0, removed: st.removed || 0, at: st.at || 0,
      };
    },

    /** 超出硬上限时丢掉"离当前视野最远"的面（与 _pruneDisplayLines 同一套） */
    _pruneDisplayAreas() {
      const view = World.viewportBox;
      const items = [...World.displayAreas.values()];
      if (!view) items.sort((a, b) => (a.at || 0) - (b.at || 0));
      else {
        const cx = (view.minLon + view.maxLon) / 2;
        const cy = (view.minLat + view.maxLat) / 2;
        const dist = (area) => {
          const b = area._bbox || World.displayLineBox(area);
          if (!b) return Infinity;
          const dx = (b.minLon + b.maxLon) / 2 - cx;
          const dy = (b.minLat + b.maxLat) / 2 - cy;
          return dx * dx + dy * dy;
        };
        items.sort((a, b) => dist(b) - dist(a));
      }
      const drop = items.slice(0, Math.max(0, items.length - MAX_DISPLAY_AREAS));
      for (const area of drop) World.displayAreas.delete(area.key);
      World.displayAreaStats.removed = (World.displayAreaStats.removed || 0) + drop.length;
      return drop.length;
    },

    /* ------------------------------ 读取 ------------------------------ */
    getNode(id) { return World.nodes.get(Number(id)) || null; },
    getWay(id) { return World.ways.get(Number(id)) || null; },
    getRelation(id) { return World.relations.get(Number(id)) || null; },
    get(type, id) {
      if (type === 'node') return World.getNode(id);
      if (type === 'way') return World.getWay(id);
      if (type === 'relation') return World.getRelation(id);
      return null;
    },

    /** way 的坐标序列 [[lat,lon], ...] */
    wayCoords(way) {
      if (!way) return [];
      const out = [];
      let missing = false;
      for (const nid of way.nodes) {
        const n = World.nodes.get(nid);
        if (!n) { missing = true; continue; }
        out.push([n.lat, n.lon]);
      }
      if (missing) way._incomplete = true;
      return out;
    },

    /**
     * 返回"路径数组"：node → [[[lat,lon]]]，way → [[[lat,lon], ...]]，relation → 多条路径。
     * 调用方（高亮、元素锁、居中）统一按路径数组消费，避免把坐标对当成路径。
     *
     * opts.rings === true 时**不改返回值**而是换成 ringsOf() 的结果 { outers, inners }：
     * 多面体的内环（天井/内院）就在 inners 里。这条路径是"挤出异形楼"专用的，
     * 默认调用（高亮/居中/拾取）依然拿到路径数组，语义一点没变。
     */
    coords(type, id, opts) {
      if (opts && opts.rings === true) return World.ringsOf(type, id);
      if (type === 'node') {
        const n = World.getNode(id);
        return n ? [[[n.lat, n.lon]]] : [];
      }
      if (type === 'way') {
        const path = World.wayCoords(World.getWay(id));
        return path.length ? [path] : [];
      }
      const rel = World.getRelation(id);
      if (!rel) return [];
      const out = [];
      for (const m of rel.members) {
        if (m.type !== 'way') continue;
        const path = World.wayCoords(World.getWay(m.ref));
        if (path.length) out.push(path);
      }
      return out;
    },

    /* --------------------- 环：外环 + 内环（异形楼的天井必须画出来） --------------------- */
    /*
     * 多面体建筑（building=yes + type=multipolygon）在 OSM 里长这样：
     *   · 外环一条或几条 way（role = outer / 空），内院（天井、内庭）用 role = inner 的 way 挖洞；
     *   · 一圈经常被切成好几条 way，靠**共享的节点 id** 首尾相接 —— 所以要先"接龙"再当环用。
     * 以前 coords() 只给"每条成员 way 一条折线"，内环被当成外环、天井整个丢掉。
     * 这里补上：懒计算（第一次真的要画才缝）+ 缓存（数据没变就复用），代价只有几次 Map 查表。
     */

    /**
     * 把一串 way 按"共享端点"接成闭环（只认节点 id，不做坐标近似 —— OSM 里相接必然共享同一个节点，非常便宜）。
     * 每条 way 只用一次；接不上的碎片收进 open[]，由调用方决定丢不丢。
     * @param {Array<{nodes:number[]}>} ways
     * @param {{maxWays?:number}} [opts]
     * @returns {{rings: Array<Array<number>>, open: Array<Array<number>>, ways: number}} 节点 id 链
     */
    stitchRings(ways, opts) {
      const list = (ways || []).filter((w) => w && w.nodes && w.nodes.length >= 2);
      const out = { rings: [], open: [], ways: list.length };
      if (!list.length) return out;
      const maxWays = Math.max(2, Number.isFinite(opts && opts.maxWays) ? opts.maxWays : MAX_STITCH_WAYS);
      const used = new Uint8Array(list.length);
      // 节点 id → 登记过的 way 下标（两端都登记，接龙时直接从这个桶里找下一条）
      const byEnd = new Map();
      for (let i = 0; i < list.length; i++) {
        if (i >= maxWays) { used[i] = 1; continue; }   // 超出上限的碎片不参与接龙
        const n = list[i].nodes;
        for (const nid of [n[0], n[n.length - 1]]) {
          let arr = byEnd.get(nid);
          if (!arr) { arr = []; byEnd.set(nid, arr); }
          arr.push(i);
        }
      }
      for (let i = 0; i < list.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        let chain = list[i].nodes.slice();
        let grew = true;
        while (grew) {
          grew = false;
          // 先接尾巴再接头部，每接上一条就重新扫（链长变了，端点也变了）
          for (const atTail of [true, false]) {
            const endId = atTail ? chain[chain.length - 1] : chain[0];
            const cands = byEnd.get(endId);
            if (!cands) continue;
            for (const j of cands) {
              if (used[j]) continue;
              const n = list[j].nodes;
              if (n[0] === endId) {
                const add = n.slice(1);
                chain = atTail ? chain.concat(add) : add.reverse().concat(chain);
              } else if (n[n.length - 1] === endId) {
                const add = n.slice(0, n.length - 1);
                chain = atTail ? chain.concat(add.reverse()) : add.concat(chain);
              } else continue;
              used[j] = 1;
              grew = true;
              break;
            }
            if (grew) break;
          }
        }
        if (chain.length >= 4 && chain[0] === chain[chain.length - 1]) out.rings.push(chain);
        else out.open.push(chain);
      }
      return out;
    },

    /** 节点 id 链 → 坐标环；缺节点或没闭合的链返回 { coords: null }（宁可少画一个环，也不画半个） */
    _chainCoords(chain) {
      const pts = [];
      let missing = 0;
      for (const nid of chain) {
        const n = World.nodes.get(nid);
        if (!n || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) { missing += 1; continue; }
        pts.push([n.lat, n.lon]);
      }
      if (missing || pts.length < 4) return { coords: null, missing };
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) return { coords: null, missing };   // 没合成闭环
      if (!(util.ringAreaM2(pts) > 1e-9)) return { coords: null, missing };   // 退化环（一条线）：不算环
      return { coords: pts, missing: 0 };
    },

    /**
     * 一个关系的环（**懒计算 + 缓存**）：{ outers, inners, memberWays, dropped, missingNodes, stamp }。
     * 内环（role = inner）= 天井/内院，挤出建筑时要靠它挖洞、画朝井里的墙面。
     * 缓存条件：成员数组还是同一个对象 + 数据版本号没变（任何写入都会让 dataStamp +1，
     * 宁可多缝一次也绝不把陈旧的环当成新几何）。
     */
    relationRings(rel) {
      if (!rel) return EMPTY_RINGS;
      /*
       * 只有多面体 / 边界关系才有"环"的语义（外环 + 内环挖洞）。
       * route / network 这类关系的成员 way 只是"一串路径"，闭合与否都不代表面，
       * 所以这里直接给空环集 —— 免得把一条环线公交当成一栋楼。
       */
      const type = rel.tags && rel.tags.type;
      if (type !== 'multipolygon' && type !== 'boundary') return EMPTY_RINGS;
      if (rel._rings && rel._ringsStamp === World.dataStamp && rel._ringsMembers === rel.members) return rel._rings;
      const outerWays = [];
      const innerWays = [];
      let memberWays = 0;
      for (const m of rel.members || []) {
        if (m.type !== 'way') continue;
        memberWays += 1;
        const way = World.ways.get(Number(m.ref));
        if (!way || !way.nodes || way.nodes.length < 2) continue;
        // role 缺失按 OSM 惯例当外环（多面体里只有 inner 是必须显式写的）
        (m.role === 'inner' ? innerWays : outerWays).push(way);
      }
      const outerStitch = World.stitchRings(outerWays);
      const innerStitch = World.stitchRings(innerWays);
      const outers = [];
      const inners = [];
      let dropped = outerStitch.open.length + innerStitch.open.length;
      let missingNodes = 0;
      for (const chain of outerStitch.rings) {
        const r = World._chainCoords(chain);
        missingNodes += r.missing;
        if (r.coords) outers.push(r.coords); else dropped += 1;
      }
      for (const chain of innerStitch.rings) {
        const r = World._chainCoords(chain);
        missingNodes += r.missing;
        if (r.coords) inners.push(r.coords); else dropped += 1;
      }
      const out = {
        outers, inners, memberWays,
        outerWays: outerStitch.ways, innerWays: innerStitch.ways,
        chains: outerStitch.rings.length + innerStitch.rings.length,
        dropped, missingNodes, stamp: World.dataStamp,
      };
      rel._rings = out;
      rel._ringsStamp = World.dataStamp;
      rel._ringsMembers = rel.members;
      return out;
    },

    /** 任意元素的环（way → 一圈外环；relation → 缝好的外环 + 内环；node/非闭合 → 空） */
    ringsOf(type, id) {
      if (type === 'relation') return World.relationRings(World.getRelation(id));
      if (type === 'way') {
        const way = World.getWay(id);
        if (!way || !World.isClosed(way)) return EMPTY_RINGS;
        const ring = World.wayCoords(way);
        if (ring.length < 4) return EMPTY_RINGS;
        return {
          outers: [ring], inners: [], memberWays: 1, outerWays: 1, innerWays: 0,
          chains: 1, dropped: 0, missingNodes: 0, stamp: World.dataStamp,
        };
      }
      return EMPTY_RINGS;
    },

    /** 关系的经纬度 bbox（成员 way 的 bbox 合并；缓存，数据版本变了才重算） */
    relationBBox(rel) {
      if (!rel) return null;
      if (rel._relBBoxStamp === World.dataStamp) return rel._relBBox;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      let found = 0;
      for (const m of rel.members || []) {
        if (m.type !== 'way') continue;
        const b = World.wayBBox(World.ways.get(Number(m.ref)));
        if (!b) continue;
        found += 1;
        if (b.minLat < minLat) minLat = b.minLat;
        if (b.maxLat > maxLat) maxLat = b.maxLat;
        if (b.minLon < minLon) minLon = b.minLon;
        if (b.maxLon > maxLon) maxLon = b.maxLon;
      }
      rel._relBBoxStamp = World.dataStamp;
      rel._relBBox = found ? { minLat, maxLat, minLon, maxLon } : null;
      return rel._relBBox;
    },

    /**
     * 视野内"多面体建筑"的清点（自检 / 报告用）：
     *   buildings = 带 building/building:part 标签的多面体关系（在视野内的）；
     *   withInner = 其中**带内环（天井/内院）**的有几个。
     * 会顺手缝环（懒计算），所以这是"真的能挤出天井"的个数，不是标签层面的猜测。
     */
    buildingRelationStats(box) {
      const view = box || World.viewportBox;
      const st = {
        relations: 0, multipolygons: 0, buildings: 0, withInner: 0,
        outerRings: 0, innerRings: 0, outerRingPoints: 0, innerRingPoints: 0,
        splitOuterRings: 0, splitInnerRings: 0, dropped: 0, missingNodes: 0,
      };
      for (const rel of World.relations.values()) {
        st.relations += 1;
        const t = rel.tags;
        if (!t || (t.type !== 'multipolygon' && t.type !== 'boundary')) continue;
        st.multipolygons += 1;
        if (!(t.building || t['building:part'])) continue;
        if (view) {
          const b = World.relationBBox(rel);
          if (!b || !World._boxesIntersect(b, view)) continue;
        }
        st.buildings += 1;
        const rings = World.relationRings(rel);
        st.outerRings += rings.outers.length;
        st.innerRings += rings.inners.length;
        if (rings.inners.length) st.withInner += 1;
        st.dropped += rings.dropped || 0;
        st.missingNodes += rings.missingNodes || 0;
        // 外环是被"多条 way 接龙"接出来的（真实数据里很常见）：报告里单独说一句
        if (rings.outerWays > rings.outers.length) st.splitOuterRings += 1;
        if (rings.innerWays > rings.inners.length) st.splitInnerRings += 1;
        for (const r of rings.outers) st.outerRingPoints += r.length;
        for (const r of rings.inners) st.innerRingPoints += r.length;
      }
      return st;
    },

    isClosed(way) {
      return !!way && way.nodes.length > 2 && way.nodes[0] === way.nodes[way.nodes.length - 1];
    },

    wayLength(way) {
      const coords = World.wayCoords(way);
      return util.lineLengthM(coords);
    },

    wayArea(way) {
      if (!World.isClosed(way)) return 0;
      return util.ringAreaM2(World.wayCoords(way));
    },

    tagsOf(type, id) {
      const el = World.get(type, id);
      return (el && el.tags) || null;
    },

    centerOf(type, id) {
      const coords = World.coords(type, id);
      const flat = [];
      for (const c of coords) for (const p of c) flat.push(p);
      if (!flat.length) return null;
      let lat = 0;
      let lon = 0;
      for (const p of flat) { lat += p[0]; lon += p[1]; }
      return { lat: lat / flat.length, lon: lon / flat.length };
    },

    /* ------------------------------ 写入 ------------------------------ */
    /**
     * 合并 /api/map 的视口数据。
     * 分块加载时这个方法会被反复调用（一块一次），所以这里刻意做三件事：
     *   1. 新要素直接插进空间索引（不整表重建）；
     *   2. 只有节点坐标"真的变了"才让几何缓存失效（重复下发的同一批坐标不算）；
     *   3. 用 for-in 直接遍历响应对象，**不再 Object.entries**（一次合并几万条 way 时，
     *      光是把它们拆成 [id, arr] 数组就是几万次分配，实测能占掉合并时间的一大块）。
     * 每次合并都记账（World.stats / World.perf）：合并慢还是索引慢，一眼看得出来。
     */
    /* ------------------ 紧凑载荷解码（server/osmdb.js 的「紧凑载荷」） ------------------ */
    /**
     * 服务端把几何从"十进制坐标文本"换成"量化整数 + 差分"（一屏整框实测 z13 3038 → 1467 KB），
     * 这里**就地**展开回 mergePayload 下文一直在用的老形状，于是解码头只有一个地方、
     * 下面几万行的写入逻辑一行都不用改：
     *   · `nodePack{ids,lat,lon}`（三列差分整数）        → `nodes {id: [lat, lon]}`（绝对值）
     *   · `ways[id][1]`（每条 way 内的节点 id 差分）    → 绝对节点 id 数组
     *   · `displayLines` / `displayAreas` 的 `coords` + `segs`（② 的摊平形状：
     *     所有段首尾相接的扁平差分数组 + 段长表）→ `[[lat, lon], …]` 的 `coords` + `paths`
     * 展开后把 `payload.enc` 置空：同一块 payload 合并两次也不会解两次（幂等）。
     * 没有 `payload.enc` 的响应（老服务端 / 自检里的假数据 / limits.compact=false）原样放过。
     * 代价：一次线性循环（z13 四万多个节点，实测 &lt;2 ms），换来的是少传一半字节。
     */
    /* ---------- 二进制矢量载荷 BIN v1 的解码（见 server/osmdb.js 的格式说明） ---------- */
    /**
     * **只改编码、不改语义**：二进制载荷解出来的对象与"紧凑 JSON 载荷"**逐字段相同**
     * （tests/bin-payload-test.js 在真实数据集上逐档对拍），所以这里解完照样交给
     * `unpackPayload` 展开成老形状 —— 解码只有一条路径，`mergePayload` 以下一行都不用改。
     *
     * 只依赖浏览器原生能力：`DataView`（小端）+ `TextDecoder`（UTF-8）。
     * 整数是 LEB128 变长整数（uvarint）+ zigzag（svarint），**不能走 32 位位运算**
     * （节点 id 首值可以到 ~1.2e10 > 2^32），所以用 `v += (b & 0x7f) * mul`。
     *
     * 抛错即"别用二进制"：魔数/版本不认识、段越界、varint 截断 → 抛；
     * `mapdata.js` 的 `_fetch` 收到 `err.dshBin` 后会关掉二进制并**原样退回 `fmt=json` 重取一次**。
     *
     * ⚠ **耗时：解码比 JSON 那条路慢 2~3 倍，这是必须知道的代价。**
     * 用 `tests/tmp-bin/measure-decode-bin.js`（照抄 `tools/measure-decode.js` 的口径：真
     * `tests/client-vm.js` 宿主 + 真 `public/js/**`、每档 20 次、每轮取新鲜载荷）实测：
     *
     *   z     JSON.parse+unpack   BIN decode+unpack    倍数
     *   z9         4.32 ms            12.76 ms         2.9×
     *   z10        4.63 ms            10.06 ms         2.2×
     *   z13        2.69 ms             8.84 ms         3.3×
     *   z14        1.22 ms             4.97 ms         4.1×
     *   z15       12.44 ms            21.83 ms         1.8×
     *   z16       13.35 ms            24.84 ms         1.9×
     *
     * 换算成绝对量：低缩放多花 4~8 ms、编辑档多花 9~12 ms，换来的是**字节少 63~69%**
     * （过网 gzip 后少 11~19%）。原因是结构性的：`JSON.parse` 是 V8 的原生解析器，
     * 而这里是**纯 JS 逐 varint 解析 + 几千次字符串 `TextDecoder.decode`**。
     * 试过把逐字节读从 `DataView.getUint8` 换成 `raw[at++]` 直接下标 —— **实测没有变快**
     * （见 `u8()` 上的注释），所以这条差距目前没有低成本的解法；
     * 要再快就得改格式（例如坐标流按定长位宽打包、少数字符串表），那是另一件事。
     */
    decodeBinaryPayload(bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (u8.length < 8) throw new Error('二进制载荷太短（' + u8.length + ' 字节）');
      if (u8[0] !== 0x44 || u8[1] !== 0x53 || u8[2] !== 0x48 || u8[3] !== 0x42) {
        throw new Error('二进制载荷魔数不对（不是 DSHB）');
      }
      const version = u8[4];
      if (version !== 1) throw new Error('不认识的二进制载荷版本：' + version);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const sectionCount = dv.getUint16(6, true);
      if (8 + sectionCount * 10 > u8.length) throw new Error('二进制载荷段目录越界');
      /** 段目录：kind → {offset, length}（按 kind 找，不按顺序） */
      const dir = Object.create(null);
      for (let i = 0; i < sectionCount; i++) {
        const at = 8 + i * 10;
        const kind = dv.getUint8(at);
        const offset = dv.getUint32(at + 2, true);
        const length = dv.getUint32(at + 6, true);
        if (offset + length > u8.length) throw new Error('二进制载荷段 ' + kind + ' 越界');
        dir[kind] = { offset, length };
      }
      const KIND_CORE = 1;
      const KIND_STRINGS = 2;
      const KIND_NODES = 3;
      const KIND_WAYS = 4;
      const KIND_RELATIONS = 5;
      const KIND_LINES = 6;
      const KIND_AREAS = 7;

      /** UTF-8 解码器（浏览器原生；建一次就复用，几百上千条字符串不用反复 new） */
      const textDecoder = World._binTextDecoder || (World._binTextDecoder = new TextDecoder('utf-8'));
      /** 逐字节读取用直接下标（多字节小端字段才用 DataView；见下面 u8() 的注释） */
      const raw = u8;
      /** 段内读取器：全是位置游标 + 解析一行就往前走，不做任何缓冲 */
      const readerAt = (offset, length) => {
        let at = offset;
        const end = offset + length;
        const r = {
          /**
           * 单字节走 `raw[at++]` 直接下标；只有多字节的小端字段才用 `DataView`。
           *
           * ⚠ 老实说：**这个改法实测没有变快**。原本以为 `DataView.getUint8` 的逐字节方法调用
           * 是二进制解码慢的主因，改成直接下标之后用 `tests/tmp-bin/measure-decode-bin.js`
           * （真 `tests/client-vm.js` 宿主 + 真 `public/js/**`）测 z9~z16：
           *   12.76 / 10.06 / 8.84 / 4.97 / 21.83 / 24.84 ms
           * → 13.81 / 11.11 / 10.30 / 5.76 / 20.41 / 24.47 ms
           * **全在噪声里**（每档 min~max 自身就散布 8~26 ms）。保留它只因为它更简单、不更慢，
           * **不要把它当成一处已证实的优化**。二进制解码真正的代价是结构性的：
           * "纯 JS 逐 varint 解析 + 几千次字符串 decode" vs "V8 原生 `JSON.parse`"，
           * 实测整体慢 2~3 倍（见 `decodeBinaryPayload` 顶部关于耗时的那段说明）。
           */
          u8() { if (at >= end) throw new Error('二进制载荷段读越界'); return raw[at++]; },
          /** LEB128 无符号变长整数（低位在前） */
          uvarint() {
            let v = 0;
            let mul = 1;
            let b;
            do {
              if (at >= end) throw new Error('二进制载荷 varint 截断');
              b = raw[at++];
              v += (b & 0x7f) * mul;
              mul *= 128;
            } while (b & 0x80);
            return v;
          },
          /** zigzag 变长整数（正负各半的增量必须这么编，否则小的负数也占满 5 字节） */
          svarint() {
            const u = r.uvarint();
            return (u % 2) ? -((u + 1) / 2) : u / 2;
          },
          /** UTF-8 字符串：uvarint 字节长度 + 原始字节 */
          str() {
            const n = r.uvarint();
            if (at + n > end) throw new Error('二进制载荷字符串越界');
            const s = textDecoder.decode(raw.subarray(at, at + n));
            at += n;
            return s;
          },
        };
        return r;
      };

      /** 字符串表（kind 2）：下标 0 恒为空串，表里第一条的下标 = 1 */
      const strings = [''];
      if (dir[KIND_STRINGS]) {
        const sr = readerAt(dir[KIND_STRINGS].offset, dir[KIND_STRINGS].length);
        const n = sr.uvarint();
        for (let i = 0; i < n; i++) strings.push(sr.str());
      }
      const strAt = (i) => (i > 0 && i < strings.length ? strings[i] : '');

      /**
       * 标签集：`0` = 没有标签（null），否则 `count+1` = 键值对个数，随后 count × (keyIdx, valIdx)。
       * **null 与 `{}` 必须分得开**（服务端里两种"空"都有，客户端直接把它们当对象用）。
       */
      const readTags = (r) => {
        const m = r.uvarint();
        if (!m) return null;
        const n = m - 1;
        const tags = {};
        for (let i = 0; i < n; i++) {
          const k = strAt(r.uvarint());
          tags[k] = strAt(r.uvarint());
        }
        return tags;
      };

      /** CORE（kind 1）：除几何以外的全部字段，仍然是 UTF-8 JSON —— 直接当载荷的底子 */
      const payload = dir[KIND_CORE]
        ? JSON.parse(textDecoder.decode(u8.subarray(dir[KIND_CORE].offset, dir[KIND_CORE].offset + dir[KIND_CORE].length)))
        : {};

      /**
       * NODES（kind 3）：三列 delta（首值绝对，与 JSON 版 nodePack 逐个相同）+ nodeTags。
       * **保持 delta 不放回绝对值**：下游 `unpackPayload` 就是按 delta 展开的，两边口径一致。
       */
      if (dir[KIND_NODES]) {
        const nr = readerAt(dir[KIND_NODES].offset, dir[KIND_NODES].length);
        const n = nr.uvarint();
        const ids = new Array(n);
        const lat = new Array(n);
        const lon = new Array(n);
        // **刻意不在这里放回绝对值**：JSON 版 nodePack 里存的就是增量，
        // 下游 `unpackPayload` 会累加一次；这里再累加一遍就会"加两次"，坐标直接飞掉。
        for (let i = 0; i < n; i++) ids[i] = nr.svarint();
        for (let i = 0; i < n; i++) lat[i] = nr.svarint();
        for (let i = 0; i < n; i++) lon[i] = nr.svarint();
        payload.nodePack = { ids, lat, lon };
        const tagged = nr.uvarint();
        const nodeTags = {};
        let id = 0;
        for (let i = 0; i < tagged; i++) {
          id += nr.svarint();
          nodeTags[id] = readTags(nr);
        }
        payload.nodeTags = nodeTags;
      }

      /** WAYS（kind 4）：id 差分 + version + flags + 引用差分（**原样搬运**服务端那份 profile 内 delta） */
      if (dir[KIND_WAYS]) {
        const wr = readerAt(dir[KIND_WAYS].offset, dir[KIND_WAYS].length);
        const n = wr.uvarint();
        const ways = {};
        let id = 0;
        for (let i = 0; i < n; i++) {
          id += wr.svarint();
          const version = wr.uvarint();
          const flags = wr.u8();
          const refCount = wr.uvarint();
          const refs = new Array(refCount);
          for (let j = 0; j < refCount; j++) refs[j] = wr.svarint();
          const length = (flags & 4) ? wr.svarint() : 0;
          const tags = (flags & 2) ? readTags(wr) : null;
          ways[id] = [version, refs, tags, (flags & 1) ? 1 : 0, length];
        }
        payload.ways = ways;
      }

      /** RELATIONS（kind 5）：成员类型是小枚举，role 走字符串表（绝大多数是空串 = 下标 0） */
      if (dir[KIND_RELATIONS]) {
        const rr = readerAt(dir[KIND_RELATIONS].offset, dir[KIND_RELATIONS].length);
        const n = rr.uvarint();
        const relations = {};
        const TYPES = ['node', 'way', 'relation'];
        let id = 0;
        for (let i = 0; i < n; i++) {
          id += rr.svarint();
          const version = rr.uvarint();
          const flags = rr.u8();
          const memberCount = rr.uvarint();
          const members = new Array(memberCount);
          let ref = 0;
          for (let j = 0; j < memberCount; j++) {
            const type = TYPES[rr.u8()] || 'node';
            ref += rr.svarint();
            members[j] = [type, ref, strAt(rr.uvarint())];
          }
          const tags = (flags & 1) ? readTags(rr) : null;
          let crop = null;
          if (flags & 2) {
            crop = {
              cropped: true,
              reason: 'viewport',
              memberTotal: rr.uvarint(), memberKept: rr.uvarint(),
              memberWaysTotal: rr.uvarint(), memberWaysKept: rr.uvarint(),
              memberNodesTotal: rr.uvarint(), memberNodesKept: rr.uvarint(),
              memberRelsTotal: rr.uvarint(), memberRelsKept: rr.uvarint(),
            };
          }
          relations[id] = [version, members, tags, crop];
        }
        payload.relations = relations;
      }

      /**
       * DISPLAY_LINES（kind 6）/ DISPLAY_AREAS（kind 7）：同一格式。
       * 重建出来的条目就是 ② 的摊平形状（`coords` 扁平 + `segs` 段长表，**不带 paths**），
       * 由 `unpackPayload` 再切回 `coords` / `paths`。
       */
      const readDisplay = (kind) => {
        if (!dir[kind]) return null;
        const r = readerAt(dir[kind].offset, dir[kind].length);
        const count = r.uvarint();
        if (!count) return null;
        const out = new Array(count);
        for (let i = 0; i < count; i++) {
          const entry = {};
          entry.class = strAt(r.uvarint());
          const eflags = r.u8();
          if (eflags & 1) entry.name = strAt(r.uvarint());
          if (eflags & 2) entry.rel = r.uvarint();      // 面关系的条目带关系 id（displayAreas 专用）
          entry.tags = readTags(r) || {};
          const segCount = r.uvarint();
          const segs = new Array(segCount);
          let total = 0;
          for (let j = 0; j < segCount; j++) { const t = r.uvarint(); segs[j] = t; total += t; }
          const flat = new Array(total * 2);
          let k = 0;
          for (let j = 0; j < segCount; j++) {
            // 与 NODES 段同一个口径：**存增量、不放回绝对值** ——
            // `unpackPayload` 的 `unpackPath` 会按段累加一次（每段差分复位，首值就是绝对量化值）
            for (let t = 0; t < segs[j]; t++) {
              flat[k++] = r.svarint();
              flat[k++] = r.svarint();
            }
          }
          entry.coords = flat;
          entry.segs = segs;
          out[i] = entry;        }
        return out;
      };
      const lines = readDisplay(KIND_LINES);
      if (lines) payload.displayLines = lines;
      const areas = readDisplay(KIND_AREAS);
      if (areas) payload.displayAreas = areas;
      /**
       * `enc` 里的 CORE JSON 描述的是**服务端 JSON 那一份载荷**的形状（默认 `'split'`），
       * 而这里解出来的显示条目**一定是** `segs` 形状（DISPLAY 段的格式就是这样，见 osmdb.js）。
       * 交给 `unpackPayload` 之前把说明书对准**手上这个对象**：否则"声明说 split、条目却带 segs"
       * 会让它按老形状去读扁平数组 —— 正是我们要防的那种误画。
       */
      if (payload.enc) payload.enc.displayPaths = 'flat+segs';
      return payload;
    },

    unpackPayload(payload) {
      const enc = payload && payload.enc;
      if (!enc) return false;
      payload.enc = null;
      const nScale = Number(enc.nodeScale) > 0 ? Number(enc.nodeScale) : 1e6;
      const lScale = Number(enc.lineScale) > 0 ? Number(enc.lineScale) : 1e5;
      const pack = payload.nodePack;
      if (pack && pack.ids && pack.lat && pack.lon) {
        const ids = pack.ids;
        const las = pack.lat;
        const los = pack.lon;
        const nodes = {};
        let id = 0;
        let la = 0;
        let lo = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]; la += las[i]; lo += los[i];
          nodes[id] = [la / nScale, lo / nScale];
        }
        payload.nodes = nodes;
        delete payload.nodePack;
      }
      const waysSrc = payload.ways;
      if (waysSrc) {
        for (const key in waysSrc) {
          const arr = waysSrc[key];
          const refs = arr && arr[1];
          if (!refs || !refs.length) continue;
          let prev = 0;
          const abs = new Array(refs.length);
          for (let i = 0; i < refs.length; i++) { prev += refs[i]; abs[i] = prev; }
          arr[1] = abs;
        }
      }
      /**
       * 低缩放合并折线（displayLines）与合并面（displayAreas）的几何形状，
       * **由服务端的 `enc.displayPaths` 显式声明**（见 osmdb.js 的格式说明）：
       *   · `'flat+segs'`      → ② 摊平：`coords` 是一个扁平数组、`segs` 是段长表。
       *     先按 `segs` 切成"每段一个扁平数组"，再逐段 `unpackPath` 展开成 `[[lat, lon], …]`：
       *     `coords` = 第一段、`paths` = 其余段（与摊平前**逐点相同**，`render.js` 读的就是这两个字段）；
       *   · `undefined` / `'split'` → 老形状（`coords` + `paths`，每段一个扁平数组），直接逐段展开。
       *
       * **不认识的取值绝不静默乱画**：服务端比客户端新时（比如将来加了第三种形状），
       * 老客户端把"多段首尾相接的扁平数组"当成只有一段，会把低缩放路网画成贯穿全图的折线
       * —— 不报错、不崩溃、只是画错，是最难查的一类问题。所以这里：
       *   1. 每次载荷**只报一次** `console.error`（说清是什么取值、本客户端只认哪两个）；
       *   2. 再补一次 `util.toast` 提示刷新页面（每次会话只弹一次，不刷屏）；
       *   3. 然后**按结构兜底**（条目上有 `segs` 就按扁平解、没有就按老形状解）——
       *      最坏情况也只是"按能读出来的读"，绝不会把多段几何当成一段。
       */
      const shape = enc.displayPaths === undefined || enc.displayPaths === null ? 'split' : String(enc.displayPaths);
      const flatShape = shape === 'flat+segs';
      if (!flatShape && shape !== 'split') {
        const msg = '[world] 收到不认识的几何形状 enc.displayPaths=' + JSON.stringify(shape)
          + '（本客户端只认 "flat+segs" 与 "split"）：已按结构兜底解码，低缩放几何可能不正确，请刷新页面。';
        try { console.error(msg); } catch { /* 控制台不可用不影响解码 */ }
        if (!World._shapeWarned) {
          World._shapeWarned = true;
          try { util.toast('地图数据格式不认识（服务端已升级）：低缩放可能画得不对，请刷新页面', 'error'); } catch { /* 提示失败不影响解码 */ }
        }
      }
      const expandDisplay = (list) => {
        for (let i = 0; i < list.length; i++) {
          const l = list[i];
          if (!l) continue;
          /**
           * 判据顺序（**结构优先于声明**）：
           *   1. `l.segs` 存在 → 这条几何就是扁平的，**必须**按扁平解。
           *      二进制载荷那条路就是这样：`decodeBinaryPayload` 的 DISPLAY 段本来就带段长表，
           *      与 JSON 那份 `enc.displayPaths` 说什么无关（它描述的是 JSON 的形状）。
           *      把"带着 segs 却当老形状解"当成可能，正是会产生"多段被当成一段"的那种误画。
           *   2. 否则按 `enc.displayPaths` 的声明走（`flat+segs` → 扁平；`split` → 老形状）。
           * 不认识的声明上面已经 `console.error` 出声了，这里只是照结构读得出来的读。
           */
          const asFlat = flatShape || !!l.segs;
          if (asFlat && l.segs) {
            const segs = l.segs;
            const flat = l.coords || [];
            let at = 0;
            const parts = new Array(segs.length);
            for (let j = 0; j < segs.length; j++) {
              const n = segs[j] * 2;
              parts[j] = flat.slice(at, at + n);
              at += n;
            }
            l.coords = parts.length ? World.unpackPath(parts[0], lScale) : [];
            if (parts.length > 1) {
              const rest = new Array(parts.length - 1);
              for (let j = 1; j < parts.length; j++) rest[j - 1] = World.unpackPath(parts[j], lScale);
              l.paths = rest;
            }
            delete l.segs;
            continue;
          }
          if (l.coords) l.coords = World.unpackPath(l.coords, lScale);
          if (l.paths) for (let j = 0; j < l.paths.length; j++) l.paths[j] = World.unpackPath(l.paths[j], lScale);
        }
      };
      const linesSrc = payload.displayLines;
      if (linesSrc) expandDisplay(linesSrc);
      // 低缩放合并面（displayAreas）：与折线同一套编码（量化 + 每段内差分）
      const areasSrc = payload.displayAreas;
      if (areasSrc) expandDisplay(areasSrc);
      return true;
    },

    /** 扁平差分整数 `[lat0, lon0, dLat1, dLon1, …]` → `[[lat, lon], …]`（见 unpackPayload） */
    unpackPath(flat, scale) {
      const n = flat.length >> 1;
      const out = new Array(n);
      let la = 0;
      let lo = 0;
      for (let i = 0; i < n; i++) {
        la += flat[i * 2];
        lo += flat[i * 2 + 1];
        out[i] = [la / scale, lo / scale];
      }
      return out;
    },

    mergePayload(payload) {
      const t0 = nowMs();
      // 紧凑载荷先展开（没有 enc 就是老形状，什么都不做）
      if (payload) World.unpackPayload(payload);
      let added = 0;
      let changed = false;
      let geomChanged = false;
      let nNodes = 0;
      let nWays = 0;
      let nRels = 0;
      let nLines = 0;
      let nAreas = 0;
      let waysChanged = 0;
      let newNodes = 0;
      const nodeTags = payload.nodeTags || null;
      const nodesSrc = payload.nodes;
      if (nodesSrc) {
        for (const id in nodesSrc) {
          const arr = nodesSrc[id];
          const nid = Number(id);
          const tags = nodeTags ? nodeTags[id] : null;
          const cur = World.nodes.get(nid);
          if (!cur) {
            const node = { id: nid, lat: arr[0], lon: arr[1], _wlat: arr[0], _wlon: arr[1], version: 0, tags: tags || null };
            World.nodes.set(nid, node);
            if (node.tags) World.taggedNodes.set(nid, node);
            World.indexInsertNode(node);
            added += 1;
            changed = true;
            nNodes += 1;
            newNodes += 1;
          } else {
            if (cur.lat !== arr[0] || cur.lon !== arr[1]) {
              cur.lat = arr[0];
              cur.lon = arr[1];
              geomChanged = true;
            }
            // World 自己写下的坐标（漂移判定的基准，见 putNode 的说明）
            cur._wlat = arr[0];
            cur._wlon = arr[1];
            if (tags) {
              const had = !!cur.tags;
              cur.tags = tags;
              World.taggedNodes.set(nid, cur);
              if (!had) geomChanged = true; // 变成 POI 了，得进 POI 索引
            }
            changed = true;
            nNodes += 1;
          }
        }
      }
      const waysSrc = payload.ways;
      if (waysSrc) {
        for (const id in waysSrc) {
          const arr = waysSrc[id];
          const wid = Number(id);
          const version = arr[0];
          const nodes = arr[1];
          const tags = arr[2];
          const cur = World.ways.get(wid);
          if (!cur) {
            const way = { id: wid, version, nodes, tags: tags || null, closed: nodes.length > 2 && nodes[0] === nodes[nodes.length - 1] };
            World.ways.set(wid, way);
            way._bboxStamp = -1;
            World.indexInsertWay(way);
            added += 1;
            changed = true;
            nWays += 1;
          } else if (cur.version <= version) {
            cur.version = version;   // 版本号总是跟上（哪怕内容一模一样）
            if (!sameNodeIds(cur.nodes, nodes)) {
              // 节点序列真的换了：先从索引里按旧 bbox 摘掉，插回新的
              const swapped = World.indexRemoveWay(cur);
              cur.nodes = nodes;
              cur.closed = nodes.length > 2 && nodes[0] === nodes[nodes.length - 1];
              cur._bboxStamp = -1;
              // 索引能就地维护（swapped）就完全不必整表重建；几何缓存只对这条 way 作废
              if (!swapped) geomChanged = true;
              const g = cur._geom;
              if (g) cur._geom = null;
              waysChanged += 1;
            }
            if (tags && !sameTags(cur.tags, tags)) {
              // 标签内容真的变了才换对象（换了才需要让样式规则/分块统计缓存失效）
              cur.tags = tags;
              waysChanged += 1;
            }
            changed = true;
            nWays += 1;
          }
        }
      }
      const relsSrc = payload.relations;
      if (relsSrc) {
        for (const id in relsSrc) {
          const arr = relsSrc[id];
          const rid = Number(id);
          const version = arr[0];
          const members = arr[1];
          const tags = arr[2];
          const cur = World.relations.get(rid);
          if (!cur) {
            World.relations.set(rid, {
              id: rid, version, tags: tags || null,
              members: members.map(([type, ref, role]) => ({ type, ref, role: role || '' })),
            });
            added += 1;
            changed = true;
            nRels += 1;
          } else if (cur.version <= version) {
            cur.version = version;
            cur.tags = tags || cur.tags;
            cur.members = members.map(([type, ref, role]) => ({ type, ref, role: role || '' }));
            changed = true;
            nRels += 1;
          }
        }
      }
      if (payload.stats) World.lastStats = payload.stats;
      /**
       * 服务端明确说"这一份**不是**视图载荷"（`payload.viewOnly === false`）→ 把本地缓存的
       * displayLines / displayAreas 丢掉。两个场景：
       *   · 玩家把详细度切到「完整 / 全部道路」（detail=0/1）：服务端会把真 way + 节点坐标全量下发，
       *     这时如果同一块水面还留在 displayAreas 里，就会被"合并面 + 真 way"画两遍（填充叠色）；
       *   · z ≥ coalesce.minZoom（编辑档，默认 15 = 只看不改边界 14 + 1）：本来就没有合并几何。
       * 老服务端没有这个字段（undefined）→ 什么都不做，行为与以前一致。
       */
      if (payload.viewOnly === false) {
        if (World.displayLines.size) { World.displayLines.clear(); World.displayLineZoom = null; }
        if (World.displayAreas.size) { World.displayAreas.clear(); World.displayAreaZoom = null; }
      }
      /**
       * 低缩放合并折线（`payload.displayLines`）：只有几何、没有 way id 的"视图用折线"。
       * 它们**不进空间索引、不能被选中/编辑**，只是要被画出来 —— 所以这里只写进
       * `World.displayLines` 并让数据版本号 +1（渲染层据此重画），几何版本号不动
       * （way 的空间索引一个格子都不用改）。
       */
      const linesSrc = payload.displayLines;
      let lineCount = 0;
      if (linesSrc && linesSrc.length) {
        const tLines = nowMs();
        lineCount = World.mergeDisplayLines(linesSrc, payload.zoom);
        World.perfAdd('mergeLines', nowMs() - tLines);
        if (lineCount) changed = true;
      }
      nLines += lineCount;
      /**
       * 低缩放合并面（`payload.displayAreas`）：与折线完全对称 —— 只有几何、没有 way id，
       * 不进空间索引、不能被选中/编辑，只被画出来（见 mergeDisplayAreas 的说明）。
       */
      const areasSrc = payload.displayAreas;
      let areaCount = 0;
      if (areasSrc && areasSrc.length) {
        const tAreas = nowMs();
        areaCount = World.mergeDisplayAreas(areasSrc, payload.zoom);
        World.perfAdd('mergeAreas', nowMs() - tAreas);
        if (areaCount) changed = true;
      }
      nAreas += areaCount;
      /**
       * 新节点到达：那些"way 先到、节点后到"的 way 现在可能补齐了。
       * 必须在这里把它们的 bbox / 投影缓存作废重算，否则它们会永远画不出来
       * （画面上永久少一块 = completeness() 的"计划外缺失"）。
       */
      if (newNodes > 0) World._refreshIncompleteWays();
      const workMs = nowMs() - t0;
      // 只要有元素被写入或更新就 +1：渲染层据此重建场景
      if (changed) World.touch(geomChanged);
      /**
       * 顺手评估一次"视野外卸载"。
       * **只用当前视野，绝不用这次响应的 bbox**：分块加载时每次响应的 bbox 只是一小块，
       * 拿它当保留区会把同一轮里其它块的数据全删掉（老代码因为这个只在 30 万以上才敢清）。
       * 还没有视野（页面刚启动）时 maybeUnload() 直接返回 0，什么都不动。
       */
      if (changed) World.maybeUnload();
      const ms = nowMs() - t0;
      const st = World.stats;
      st.mergeMs += ms;
      st.mergeWorkMs += workMs;
      st.mergeCount += 1;
      st.mergeLastMs = ms;
      st.mergedNodes += nNodes;
      st.mergedWays += nWays;
      st.mergedRelations += nRels;
      st.mergedDisplayLines = (st.mergedDisplayLines || 0) + nLines;
      st.mergedDisplayAreas = (st.mergedDisplayAreas || 0) + nAreas;
      st.updatedWays += waysChanged;
      st.at = Date.now();
      // 净合并时间（不含"顺手评估卸载"，卸载另有 unload 一条）
      World.perfAdd('merge', workMs);
      return added;
    },

    /** 合并单个元素（来自 /api/element 或操作广播） */
    putNode(node) {
      if (!node) return;
      const nid = Number(node.id);
      const cur = World.nodes.get(nid);
      const moved = !cur || cur.lat !== node.lat || cur.lon !== node.lon;
      /**
       * **编辑器拖动是"原地改坐标"**：editor.js 的 _onMouseMove 直接写 `n.lat = …` / `n.lon = …`，
       * 不走这里。等这次操作的 ack 带回来时，服务器给的坐标和本地已经一模一样 → `moved` 是 false
       * → geomStamp 不 +1 → `way._geom`（里面存的是**拖动之前**的坐标副本）与空间索引格子
       * 全都停在原地，于是画面永远不更新（"编辑后地图不实时更新"的根因就在这里）。
       *
       * `_wlat/_wlon` 记的是"World 自己写进去的那一份坐标"：只要有人绕过 World 改坐标，
       * 这里 O(1) 就能看出来（不用扫全库），并把这件事记进漂移队列，等 ack 处理完统一修。
       */
      if (cur && !moved && (cur.lat !== cur._wlat || cur.lon !== cur._wlon)) {
        World.noteGeomDrift(nid, cur._wlat, cur._wlon);
      }
      const next = {
        id: nid, lat: node.lat, lon: node.lon,
        _wlat: node.lat, _wlon: node.lon,
        version: node.version || 0, tags: node.tags || null,
      };
      World.nodes.set(nid, next);
      if (next.tags) World.taggedNodes.set(nid, next);
      else World.taggedNodes.delete(nid);
      if (moved) World.touch(true);          // 坐标变了：几何缓存与索引都要重来
      else {
        World.touch(false);
        if (!cur) World.indexInsertNode(next);
      }
    },

    putWay(way, nodesMap) {
      let geomChanged = false;
      if (nodesMap) {
        for (const [id, arr] of Object.entries(nodesMap)) {
          const nid = Number(id);
          const cur = World.nodes.get(nid);
          if (cur) {
            if (cur.lat !== arr[0] || cur.lon !== arr[1]) { cur.lat = arr[0]; cur.lon = arr[1]; geomChanged = true; }
            cur._wlat = arr[0];              // 这一份是World 写进去的（漂移判定的基准）
            cur._wlon = arr[1];
          } else {
            World.nodes.set(nid, { id: nid, lat: arr[0], lon: arr[1], _wlat: arr[0], _wlon: arr[1], version: 0, tags: null });
          }
        }
      }
      const wid = Number(way.id);
      const old = World.ways.get(wid);
      if (old && !geomChanged) World.indexRemoveWay(old);
      const next = {
        id: wid, version: way.version || 0, tags: way.tags || null,
        nodes: way.nodes.slice(), closed: !!way.closed, _bboxStamp: -1,
      };
      World.ways.set(wid, next);
      if (geomChanged) World.touch(true);
      else {
        World.touch(false);
        World.indexInsertWay(next);
      }
    },

    putRelation(rel) {
      World.relations.set(Number(rel.id), {
        id: Number(rel.id), version: rel.version || 0, tags: rel.tags || null,
        members: (rel.members || []).map((m) => ({ type: m.type, ref: m.ref, role: m.role || '' })),
      });
      World.touch(false);
    },

    /**
     * **权威版本号写回**（版本冲突自愈用，见 editor.js 的「版本冲突自愈」一节）。
     *
     * 与 mergePayload 的"版本号只许往上走"不同：那个规则是为了防**乱序到达的视口载荷**
     * 把新数据顶掉；而这里的值来自服务端的**冲突回执**或 `/api/element`，是权威的，
     * 所以允许覆盖（本地那个 0 只表示"我们不知道"，不是"版本 0"）。
     *
     * 为什么需要它：如果 `/api/element` 那条路没走通（断线/超时），至少要把服务端说的
     * 当前版本号记下来 —— 否则用户下一次点击还是拿着同一个过期版本去撞同一堵墙，
     * 那正是"怎么点都删不掉、永远恢复不了"的原因。
     * 只动版本号与最后编辑者，不动坐标/标签（内容是 /api/element 负责的）。
     */
    applyConflictVersion(type, id, version, editorName) {
      const v = Number(version);
      if (!Number.isFinite(v) || v <= 0) return false;
      const n = Number(id);
      const el = type === 'node' ? World.nodes.get(n)
        : type === 'way' ? World.ways.get(n)
          : type === 'relation' ? World.relations.get(n) : null;
      if (!el) return false;
      el.version = v;
      if (editorName) el.editorName = String(editorName);
      World.touch(false);                 // 只改版本号：不是几何变化（不用重建索引）
      return true;
    },

    delete(type, id) {
      const n = Number(id);
      if (type === 'node') { World.nodes.delete(n); World.taggedNodes.delete(n); }
      else if (type === 'way') World.ways.delete(n);
      else World.relations.delete(n);
      World.touch(true);
    },

    /** 应用服务器广播的操作数组（同一套 upsert 路径，别有第二份本地存储） */
    applyOps(ops, opts) {
      if (!ops || !ops.length) return 0;
      const remote = !!(opts && opts.remote); // 别人广播来的：带版本号，旧版本不许把新数据顶掉
      let n = 0;
      for (const op of ops) {
        switch (op.k) {
          case 'nodeCreate':
          case 'nodeUpdate': {
            if (remote && World._isOlder('node', op.node)) break;
            World.putNode(op.node);
            n += 1;
            break;
          }
          case 'nodeDelete': World.delete('node', op.id); n += 1; break;
          case 'wayCreate':
          case 'wayUpdate': {
            if (remote && World._isOlder('way', op.way)) break;
            World.putWay(op.way, op.nodes);
            n += 1;
            break;
          }
          case 'wayDelete': {
            World.delete('way', op.id);
            n += 1;
            break;
          }
          case 'relationCreate':
          case 'relationUpdate': {
            if (remote && World._isOlder('relation', op.relation)) break;
            World.putRelation(op.relation);
            n += 1;
            break;
          }
          case 'relationDelete': World.delete('relation', op.id); n += 1; break;
          default: break;
        }
      }
      // 各个 put*/delete 已经按"是不是真的改了几何"打过版本号，这里不再重复 touch。
      // 但**编辑器原地改过的坐标**要在这里统一收尾：不改的话 ack 落地之后画面还是旧的
      // （拖节点/拖整条道路：ack 里的坐标和本地已经一样，putNode 看不出"动过"）。
      World.flushGeometryDrift();
      return n;
    },

    /* ------------- 本地编辑落地：把"原地改过的坐标"同步进几何缓存与空间索引 ------------- */
    /**
     * 记一笔"这个节点的坐标被人绕过 World 改过"。
     * @param {number} nodeId
     * @param {number} lat World 自己写进去的那份坐标（= 索引里登记的 bbox 所在的位置）
     * @param {number} lon
     */
    noteGeomDrift(nodeId, lat, lon) {
      if (World._driftNodes.length >= MAX_GEOM_DRIFT) {
        /**
         * 异常规模（正常一次拖动最多几百个节点）：不逐条修了，直接作废几何版本号整表重建 ——
         * 慢一点，但绝不会留下"画面没更新"这种脏状态。
         */
        World._driftOverflow = true;
        World._driftNodes.length = 0;
        return 0;
      }
      World._driftNodes.push({ id: nodeId, lat, lon });
      return World._driftNodes.length;
    },

    /**
     * 显式入口：**本地改过节点坐标之后**通知 World（没有 op ack 的路径也能用）。
     * @param {Iterable<number>|null} nodeIds null = 只把队列里已有的漂移处理掉
     * @returns {number} 被就地修好的 way 条数
     */
    refreshNodesGeometry(nodeIds) {
      if (nodeIds) {
        for (const raw of nodeIds) {
          const n = World.nodes.get(Number(raw));
          if (n && (n.lat !== n._wlat || n.lon !== n._wlon)) World.noteGeomDrift(n.id, n._wlat, n._wlon);
        }
      }
      return World.flushGeometryDrift();
    },

    /**
     * 把漂移队列落到索引与缓存上（op ack 之后自动调用；queryWays 之前也会兜底调一次）。
     *
     * 只动**真的引用了这些节点**的 way：候选由一次小范围网格查询给出（范围覆盖"旧位置 + 新位置"，
     * 因为索引里登记的是拖动之前的 bbox），再用 `way.nodes.indexOf` 精确判断成员 —— 于是
     * **不用整表重建索引**（省掉一次几十毫秒的全库重建），也不会漏。
     * @returns {number} 修好的 way 条数
     */
    flushGeometryDrift() {
      const list = World._driftNodes;
      const overflow = World._driftOverflow;
      if (!overflow && (!list || !list.length)) return 0;
      World._driftNodes = [];
      World._driftOverflow = false;
      // 索引本来就失效了（这中间有别的几何写入）：整表重建会顺带把一切算对，不必再修
      if (!World._grid || World._gridStamp !== World.geomStamp) return 0;
      const t0 = nowMs();
      if (overflow) {
        World.touch(true);
        return 0;
      }
      const seen = World._driftSeen || (World._driftSeen = new Map());
      seen.clear();
      let fixed = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const node = World.nodes.get(it.id);
        if (!node) continue;                        // 节点被删了：delete() 已经 touch(true)
        if (node.lat === it.lat && node.lon === it.lon) continue;  // 又改回去了（撤销/失败回滚）
        fixed += World._syncWaysOfNode(node, it, seen);
      }
      const ms = nowMs() - t0;
      const st = World.stats;
      st.geomSyncCount += 1;
      st.geomSyncLastMs = ms;
      st.geomSyncMs += ms;
      st.geomSyncedWays += fixed;
      if (fixed) {
        World.dataStamp += 1;                       // 渲染层据此认为"本地数据变了"
        if (World.onGeometryFixed) {
          try { World.onGeometryFixed({ ways: fixed, ms, src: 'local-edit' }); } catch { /* 渲染层自己的异常不往上抛 */ }
        }
      }
      return fixed;
    },

    /**
     * 把一个矩形范围内的 way id **原样**收进 out（可能重复：同一条 way 会出现在多个格子里）。
     *
     * 为什么不用 queryWaysCursor：那个是"公共查询"，会给 way 打 `_q` 去重戳。
     * 渲染层的分帧收集可能正跑在半途（游标是跨帧的），这时候再打一次戳就会让
     * **同一条 way 被重复收进绘制列表**。所以这里只做"按行分桶的矩形遍历"这一件事，
     * 去重交给调用方（见 _syncWaysOfNode 的 seen）。
     */
    _collectWayIds(box, out) {
      out.length = 0;
      const grid = World._grid;
      if (!grid) return out;
      const x0 = Math.floor(box.minLon / CELL_DEG);
      const x1 = Math.floor(box.maxLon / CELL_DEG);
      const y0 = Math.floor(box.minLat / CELL_DEG);
      const y1 = Math.floor(box.maxLat / CELL_DEG);
      for (let y = y0; y <= y1; y++) {
        const row = grid.get(y);
        if (!row) continue;                       // 这一行没有桶：直接跳过
        const keys = rowKeys(row);
        for (let i = lowerBound(keys, x0); i < keys.length && keys[i] <= x1; i++) {
          const arr = row.buckets.get(keys[i]);
          if (!arr) continue;
          for (let j = 0; j < arr.length; j++) out.push(arr[j]);
        }
      }
      return out;
    },

    /** 找出所有引用这个节点、且几何已经过期的 way，就地修正 */
    _syncWaysOfNode(node, drift, seen) {
      let fixed = 0;
      // 索引里登记的是**拖动之前**的 bbox → 候选范围要覆盖旧位置与新位置（再加半格容差）
      const pad = CELL_DEG * 0.5;
      const box = World._driftBox || (World._driftBox = { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 });
      box.minLat = Math.min(node.lat, drift.lat) - pad;
      box.maxLat = Math.max(node.lat, drift.lat) + pad;
      box.minLon = Math.min(node.lon, drift.lon) - pad;
      box.maxLon = Math.max(node.lon, drift.lon) + pad;
      const ids = World._collectWayIds(box, World._driftScratch || (World._driftScratch = []));
      for (let i = 0; i < ids.length; i++) {
        const wid = ids[i];
        if (seen.has(wid)) continue;
        seen.set(wid, 1);
        const way = World.ways.get(wid);
        // 网格只给候选（按 bbox 相交），成员判断必须精确
        if (!way || way.nodes.indexOf(node.id) < 0) continue;
        if (World.reindexWayGeometry(way)) fixed += 1;
      }
      // 大要素（bbox 跨格太多、没进网格）：单独过一遍
      for (let i = 0; i < World._bigWays.length; i++) {
        const way = World.ways.get(World._bigWays[i]);
        if (!way || seen.has(way.id)) continue;
        seen.set(way.id, 1);
        if (way.nodes.indexOf(node.id) < 0) continue;
        if (World.reindexWayGeometry(way)) fixed += 1;
      }
      return fixed;
    },

    /** 从当前节点坐标算一条 way 的 bbox（**不写缓存**，用于和缓存里的那份对比） */
    _bboxOfNodes(way) {
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      let found = 0;
      for (const nid of way.nodes) {
        const n = World.nodes.get(nid);
        if (!n || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) continue;
        found += 1;
        if (n.lat < minLat) minLat = n.lat;
        if (n.lat > maxLat) maxLat = n.lat;
        if (n.lon < minLon) minLon = n.lon;
        if (n.lon > maxLon) maxLon = n.lon;
      }
      return found ? { minLat, maxLat, minLon, maxLon } : null;
    },

    /**
     * 就地修正一条 way 的 bbox / 投影缓存与索引项（**只动这一条**，不整表重建索引）。
     *
     * 两件事要分开看，缺一不可：
     *   · **投影缓存一定要作废** —— 拖的是"中间那个节点"时，way 的 bbox 一点没变
     *     （min/max 还是头尾那两个点），但画出来的折线必须跟着动；
     *   · **索引项只在 bbox 真的变了才搬** —— bbox 没变就说明登记的格子还是对的那几个。
     * @returns {boolean} true = 真的动过（缓存或索引被改过）
     */
    reindexWayGeometry(way) {
      if (!way || !World.ways.has(way.id)) return false;
      const hadGeom = !!way._geom;
      if (way._bboxStamp !== World.geomStamp) {
        // 连"索引里登记的那份 bbox"都对不上：摘不干净 → 保守整表重建（下一次查询会做）
        if (hadGeom) way._geom = null;
        World._gridStamp = -1;
        return hadGeom;
      }
      const oldBox = way._bbox;
      const fresh = World._bboxOfNodes(way);
      if (!fresh) return false;
      const boxSame = !!oldBox
        && oldBox.minLat === fresh.minLat && oldBox.maxLat === fresh.maxLat
        && oldBox.minLon === fresh.minLon && oldBox.maxLon === fresh.maxLon;
      if (boxSame) {
        if (!hadGeom) return false;              // 缓存本来就是空的：没什么要作废的
        way._geom = null;                        // 只作废投影缓存（中间的节点挪了）
        return true;
      }
      const swapped = World.indexRemoveWay(way);       // 用旧 bbox 从索引里摘掉
      way._bbox = fresh;
      way._bboxStamp = World.geomStamp;
      way._geom = null;                                // 投影缓存作废：渲染层按新坐标重算
      way._blk = null;                                 // 区块归属（300 米格子）也可能换了
      if (swapped) World.indexInsertWay(way);          // 用新 bbox 插回去
      else World._gridStamp = -1;                      // 维护不了 → 下次查询整表重建（安全兜底）
      return true;
    },

    /** 广播里的元素版本比本地还旧（乱序/重放）时不要覆盖本地 */
    _isOlder(type, el) {
      if (!el) return false;
      const cur = World.get(type, el.id);
      if (!cur) return false;
      const a = Number(cur.version);
      const b = Number(el.version);
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    },

    /* --------------------- 别人改动的合并与概括（协作提示） --------------------- */
    /** 操作的动词与元素名词：新建筑 → 「新建了一座建筑」，改道路 → 「修改了一条道路」 */
    _verbOf(action) { return action === 'create' ? '新建' : action === 'delete' ? '删除' : '修改'; },

    _nounOf(type, tags) {
      if (type === 'relation') return { noun: '关系', mw: '个' };
      if (type === 'node') return (tags && Object.keys(tags).length) ? { noun: '兴趣点', mw: '个' } : { noun: '节点', mw: '个' };
      const t = tags || {};
      if (t.building || t['building:part']) return { noun: '建筑', mw: '座' };
      if (t.highway) return { noun: '道路', mw: '条' };
      if (t.railway) return { noun: '铁路', mw: '条' };
      if (t.waterway || t.natural === 'water' || t.natural === 'coastline') return { noun: '水系', mw: '处' };
      if (t.landuse || t.leisure || t.natural || t.amenity) return { noun: '区域', mw: '处' };
      return { noun: '要素', mw: '个' };
    },

    /** 一个操作影响到的代表点（用来判断"是不是在我当前视野里"，删除前也能取到） */
    _opPoint(op, type, el) {
      if (type === 'node') {
        const n = op.node || el;
        return n && Number.isFinite(n.lat) && Number.isFinite(n.lon) ? { lat: n.lat, lon: n.lon } : null;
      }
      if (type === 'way' && op.nodes) {
        let lat = 0;
        let lon = 0;
        let k = 0;
        for (const arr of Object.values(op.nodes)) {
          if (!Array.isArray(arr) || !Number.isFinite(arr[0]) || !Number.isFinite(arr[1])) continue;
          lat += arr[0];
          lon += arr[1];
          k += 1;
        }
        if (k) return { lat: lat / k, lon: lon / k };
      }
      const id = op.id != null ? op.id : (el && el.id);
      if (id == null) return null;
      return World.centerOf(type, id);
    },

    /**
     * 把一串"改动条目"概括成一句中文 + 代表点，供"别人改了东西"的提示使用。
     * 条目结构：{ type, action, tags, at }，多批改动可以合并后再概括（提示节流时用）。
     */
    summarizeItems(items) {
      const out = { count: items ? items.length : 0, text: '', points: [] };
      if (!items || !items.length) return out;
      for (const it of items) if (it && it.at) out.points.push(it.at);
      const tally = new Map();
      for (const it of items) {
        const n = World._nounOf(it.type, it.tags);
        const cur = tally.get(n.noun) || { noun: n.noun, mw: n.mw, n: 0 };
        cur.n += 1;
        tally.set(n.noun, cur);
      }
      let top = null;
      for (const t of tally.values()) if (!top || t.n > top.n) top = t;
      const actions = new Set(items.map((it) => it.action));
      const verb = actions.size > 1 ? '改动' : World._verbOf(items[0].action);
      // 只有一种要素时才点名（「修改了一条道路」）；混着好几种就笼统说几处要素
      const mixed = tally.size > 1;
      const noun = mixed ? '要素' : top.noun;
      const mw = mixed ? '处' : top.mw;
      const num = mixed ? items.length : top.n;
      const qty = num === 1 ? '一' + mw : num + ' ' + mw;
      out.text = verb + '了' + qty + noun + (items.length > top.n ? `（共 ${items.length} 处改动）` : '');
      return out;
    },

    /**
     * 把一批操作概括成"改动条目" + 一句中文 + 代表点。
     * 必须在 applyOps 之前调用：删除类操作执行后就取不到旧位置和旧标签了。
     */
    describeOps(ops) {
      const items = [];
      for (const op of ops || []) {
        if (!op || typeof op.k !== 'string') continue;
        const m = /^(node|way|relation)(Create|Update|Delete)$/.exec(op.k);
        if (!m) continue;
        const type = m[1];
        const action = m[2].toLowerCase();
        const el = World.get(type, op.id != null ? op.id : (op[type] && op[type].id));
        const tags = (op[type] && op[type].tags) || (el && el.tags) || null;
        items.push({ type, action, tags, at: World._opPoint(op, type, el) });
      }
      const out = World.summarizeItems(items);
      out.items = items;
      return out;
    },

    /**
     * 合并别人广播过来的操作：走上面同一套 upsert（putNode/putWay/putRelation），删除类操作真的删掉本地元素。
     * 返回 { count, text, items, points } —— 视口缓存失效、重绘与提示由 net.js 统一处理。
     */
    applyRemoteOps(ops) {
      const info = World.describeOps(ops);
      info.count = World.applyOps(ops, { remote: true });
      return info;
    },

    /** 元素是否被本地引用（避免卸载掉正在编辑的东西） */
    pin(type, id) { World.pinned.add(type + ':' + id); },
    unpin(type, id) { World.pinned.delete(type + ':' + id); },
    isPinned(type, id) { return World.pinned.has(type + ':' + id); },
    /** pin/unpin 的别名（语义更直白：这个元素"保留"，不参与视野外卸载） */
    retain(type, id) { World.pin(type, id); },
    release(type, id) { World.unpin(type, id); },
    /** 当前撤销栈需要的元素：入栈时登记，出栈时撤销登记（卸载时无条件保留） */
    keepForUndo(type, id) { World.undoKeep.add(type + ':' + id); },
    forgetUndoKeep(type, id) { World.undoKeep.delete(type + ':' + id); },
    /** 本地要素总量（节点 + way + 关系） */
    total() {
      return World.nodes.size + World.ways.size + World.relations.size;
    },

    /* ------------------------------ 视野外卸载 ------------------------------ */
    /** 视野保留区：视野 + 每边 KEEP_MARGIN_SCREENS/2 屏 */
    keepBox(box, marginScreens) {
      const view = box || World.viewportBox;
      if (!view) return null;
      const m = Number.isFinite(marginScreens) ? Math.max(0, marginScreens) : KEEP_MARGIN_SCREENS;
      const halfLat = (view.maxLat - view.minLat) * m / 2;
      const halfLon = (view.maxLon - view.minLon) * m / 2;
      return {
        minLat: view.minLat - halfLat, maxLat: view.maxLat + halfLat,
        minLon: view.minLon - halfLon, maxLon: view.maxLon + halfLon,
      };
    },

    _insideBox(box, lat, lon) {
      return !!box && Number.isFinite(lat) && Number.isFinite(lon)
        && lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
    },

    _boxesIntersect(a, b) {
      return !!a && !!b && !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);
    },

    /** 视野相对"上次评估点"移动了几屏（按经纬跨度归一化，取两个方向里的大者） */
    viewportMoveScreens(box, ref) {
      const v = box || World.viewportBox;
      if (!v) return 0;
      if (!ref) return Infinity;
      const dLat = Math.abs((v.minLat + v.maxLat) / 2 - (ref.minLat + ref.maxLat) / 2);
      const dLon = Math.abs((v.minLon + v.maxLon) / 2 - (ref.minLon + ref.maxLon) / 2);
      const spanLat = Math.max(1e-9, ref.maxLat - ref.minLat);
      const spanLon = Math.max(1e-9, ref.maxLon - ref.minLon);
      return Math.max(dLat / spanLat, dLon / spanLon);
    },

    _window() {
      if (!World._unloadWindow) {
        World._unloadWindow = {
          peakFeatures: 0, peakCounts: null, screens: 0,
          removed: 0, calls: 0, startedAt: Date.now(), at: 0,
        };
      }
      return World._unloadWindow;
    },

    /**
     * 要不要卸载：视野累计移动超过半屏就评估一次（扫一遍本地库，读的都是缓存的 bbox，很便宜），
     * 本地总量超过硬上限时无论如何都要清。
     */
    maybeUnload(options = {}) {
      const box = options.box || World.viewportBox;
      if (!box) return 0;
      const total = World.total();
      const moved = World.viewportMoveScreens(box, World._evalViewport);
      // 本地要素数创新高 → 重开观察窗（新的"拖动前"规模），否则一直累计"拖了几屏"
      const win = World._window();
      if (total >= win.peakFeatures) {
        win.peakFeatures = total;
        win.peakCounts = { nodes: World.nodes.size, ways: World.ways.size, relations: World.relations.size };
        win.screens = 0;
      }
      if (!options.force && total < MAX_ELEMENTS && !(moved >= UNLOAD_TRIGGER_SCREENS)) return 0;
      /**
       * 便宜的前置判断（"避免白扫全库"）：如果**已取到的范围整个都在保留区里**，
       * 那这次卸载一个要素都删不掉 —— 扫一遍几万条 way 加十几万节点纯属白费。
       * 低缩放（z13 那种一屏几十公里）下"取到的范围"常常比保留区还小，这里每次都命中。
       */
      if (!options.force && World._dataInsideKeep(box)) {
        World.stats.unloadSkipped = (World.stats.unloadSkipped || 0) + 1;
        World.perfAdd('unloadSkipped', 0);
        return 0;
      }
      return World.unload(box, Object.assign({ moved }, options));
    },

    /** 本地数据是不是全都在保留区里（用来跳过"删不掉东西"的全库扫描） */
    _dataInsideKeep(view, marginScreens) {
      const keep = World.keepBox(view, marginScreens);
      if (!keep) return false;
      const md = World.mapData || (window.G && window.G.MapData);
      const box = md && typeof md.loadedBox === 'function' ? md.loadedBox() : null;
      if (!box) return false;
      return box.minLon >= keep.minLon && box.maxLon <= keep.maxLon
        && box.minLat >= keep.minLat && box.maxLat <= keep.maxLat;
    },

    /**
     * 视野外卸载：把"离当前视野已经很远"的要素从本地库里扔掉，并把对应的视口缓存范围作废
     * （拖回去时 MapData 会重新请求，画面照样是完整的）。
     *
     * 三条铁律：
     *   1. 保留区（视野 + 每边 0.75 屏）内的要素一个都不删 —— 画面永远不会缺要素；
     *   2. pinned / 选中的 / 正在编辑的 / 撤销栈登记的，以及关系成员节点永不删；
     *   3. 保留 way 引用的节点永不删（否则那条路会缺节点，画出来就是断的）。
     * 卸载只做增量索引维护（不重建空间索引、不作废几何缓存），所以它不会让下一次重绘变慢。
     * @returns {object|null} 卸载报告（unloadStats() 读的也是它）
     */
    unload(box, options = {}) {
      const view = box || World.viewportBox;
      if (!view) return null;
      const keep = World.keepBox(view, options.marginScreens);
      const t0 = nowMs();
      const before = World.counts();
      const beforeTotal = before.nodes + before.ways + before.relations;
      const win = World._window();
      if (beforeTotal >= win.peakFeatures) {
        win.peakFeatures = beforeTotal;
        win.peakCounts = { nodes: before.nodes, ways: before.ways, relations: before.relations };
        win.screens = 0;
      }
      const moved = Number.isFinite(options.moved) ? options.moved : World.viewportMoveScreens(view, World._evalViewport);
      if (Number.isFinite(moved)) win.screens += Math.min(moved, 1e4);
      win.calls += 1;
      win.at = Date.now();
      const pins = World._collectPins();

      /**
       * 1) way：保留区外的丢掉（顺带增量维护空间索引）。
       * 顺便把"节点引用数"数出来 —— 内存估算以前要为此再遍历一次全库（几万条 way），
       * 现在在这一次遍历里顺手累计，等于白拿。
       */
      let removedWays = 0;
      let keptPinnedWays = 0;
      let indexDirty = false;
      let nodeRefsAll = 0;
      let nodeRefsKept = 0;
      for (const [id, way] of World.ways) {
        const refs = way.nodes ? way.nodes.length : 0;
        nodeRefsAll += refs;
        if (World._wayNear(way, keep)) { nodeRefsKept += refs; continue; }
        if (pins.has('way:' + id)) { keptPinnedWays += 1; nodeRefsKept += refs; continue; }
        World.ways.delete(id);
        if (!World.indexRemoveWay(way)) indexDirty = true;
        removedWays += 1;
      }
      const beforeBytes = World._bytesOf(before, nodeRefsAll);

      /* 2) node：还挂在保留 way 上的一个都不能删 */
      let removedNodes = 0;
      let keptPinnedNodes = 0;
      let relNodes = null;
      let referenced = null;
      /**
       * 一条 way 都没删掉 = 本地数据整个都在保留区里 → 节点也不可能被删
       * （节点要么在保留区里，要么挂在保留区的 way 上）。这一步以前会：
       * 建一个十几万条 id 的 Set，再扫一遍所有节点 —— 白扫，直接跳过。
       */
      if (removedWays > 0 || keptPinnedWays > 0) {
        referenced = new Set();
        for (const way of World.ways.values()) for (const nid of way.nodes) referenced.add(nid);
        relNodes = World._relationNodeIds();
        for (const [id, node] of World.nodes) {
          if (World._insideBox(keep, node.lat, node.lon)) continue;
          if (pins.has('node:' + id) || relNodes.has(id) || referenced.has(id)) { keptPinnedNodes += 1; continue; }
          World.nodes.delete(id);
          World.taggedNodes.delete(id);
          if (!World.indexRemoveNode(node)) indexDirty = true;
          removedNodes += 1;
        }
      }

      /* 3) 关系不卸载：体积小，而且是跨视野的语义对象（成员 way 缺了自然画不出来，拖回来再取） */
      let removedRelations = 0;
      if (options.pruneRelations) {
        for (const [id, rel] of World.relations) {
          if (pins.has('relation:' + id)) continue;
          let anyMember = false;
          for (const m of rel.members || []) {
            const alive = m.type === 'node' ? World.nodes.has(Number(m.ref)) : World.ways.has(Number(m.ref));
            if (alive) { anyMember = true; break; }
          }
          if (anyMember) continue;
          World.relations.delete(id);
          removedRelations += 1;
        }
      }

      // 索引没能增量维护（本来就没有索引之类）：让它在下次查询时整表重建。
      // 注意只动 _gridStamp、不动 geomStamp —— 投影结果与 bbox 缓存因此都能留着。
      if (indexDirty) World._gridStamp = -1;

      /* 3b) 低缩放合并折线：保留区外的一律丢掉（它们只是"画得出来的折线"，拖回去会重新请求）。
         视野内的一条都不丢 —— 否则画面上会缺一条主干道。 */
      let removedDisplayLines = 0;
      for (const line of [...World.displayLines.values()]) {
        const b = line._bbox || World.displayLineBox(line);
        if (b && !(b.maxLat < keep.minLat || b.minLat > keep.maxLat
          || b.maxLon < keep.minLon || b.minLon > keep.maxLon)) continue;
        World.displayLines.delete(line.key);
        removedDisplayLines += 1;
      }
      if (removedDisplayLines) World.displayLineStats.removed = (World.displayLineStats.removed || 0) + removedDisplayLines;

      /* 4) 让 MapData 忘掉"视野外那一块"的缓存范围：拖回去会重新请求，不会出现空白 */
      let invalidatedRects = 0;
      try {
        // 优先用"正在驱动这个视野的"加载器（MapData.init 会把它登记到 World.mapData 上），
        // 再退回全局单例：两边必须是同一个，否则会出现"数据被卸载了、MapData 却还认为已覆盖"的假覆盖。
        const md = options.mapData || World.mapData || (window.G && window.G.MapData);
        if (md && typeof md.invalidateOutside === 'function') invalidatedRects = md.invalidateOutside(keep) || 0;
      } catch (err) { /* MapData 还没加载 / 自检里的假实现：都不影响本地卸载 */ }

      const after = World.counts();
      const afterTotal = after.nodes + after.ways + after.relations;
      const removed = removedWays + removedNodes + removedRelations;
      const report = {
        at: Date.now(),
        ms: Math.round(nowMs() - t0),
        moved: Number.isFinite(moved) ? Math.round(moved * 100) / 100 : -1,
        marginScreens: KEEP_MARGIN_SCREENS,
        keep: Object.assign({}, keep),
        viewport: Object.assign({}, view),
        before: Object.assign({}, before, { features: beforeTotal, bytes: beforeBytes }),
        after: Object.assign({}, after, { features: afterTotal, bytes: World._bytesOf(after, nodeRefsKept) }),
        removed, removedWays, removedNodes, removedRelations,
        removedDisplayLines,
        displayLines: World.displayLineReport(),
        displayAreas: World.displayAreaReport(),
        keptPinned: keptPinnedWays + keptPinnedNodes, invalidatedRects,
        forced: !!options.force,
      };
      win.removed += removed;
      report.window = { screens: Math.round(win.screens * 100) / 100, peakFeatures: win.peakFeatures, removed: win.removed };
      report.text = World._unloadText(report);
      World._unload = report;
      World.pruneStats = { removed, at: report.at, total: beforeTotal };
      World._evalViewport = {
        minLat: view.minLat, maxLat: view.maxLat, minLon: view.minLon, maxLon: view.maxLon,
      };
      if (removed) {
        // 只改数据版本号：几何缓存与索引都还在，下一次重绘几乎不用重算坐标
        World.touch(false);
        // 默认静默（见 World.logUnload 的注释：要看得显式打开调试开关）
        if (!World._unloadSilent && (World.logUnload || util.debugOn())) {
          console.log('[world] 视野外卸载', report.text);
        }
      }
      report.sandbox = !!World._sandboxActive;
      // 通知渲染层：它只摘掉"已经不在本地"的引用，不重建、不清层（所以画面不会闪）
      if (World.onUnload && !World._sandboxActive) {
        try { World.onUnload(report); } catch (err) { /* 渲染层出问题不影响数据层 */ }
      }
      // 卸载是"合并之后、重建之前"必经的一步（累计拖动超过半屏就评估一次）：单独记账
      const unloadMs = nowMs() - t0;
      report.ms = Math.round(unloadMs);
      World.stats.unloadMs += unloadMs;
      World.stats.unloadCount += 1;
      World.stats.unloadLastMs = unloadMs;
      World.stats.unloadRemoved += removed;
      World.perfAdd('unload', unloadMs);
      return report;
    },

    /**
     * **按 id 丢掉一批 way**（当前 LOD 用不上的高细节几何；见 Render.dropDetailForZoom）。
     *
     * 与 unload 的分工：
     *   · unload       —— 按**位置**（保留区之外）卸载，与缩放无关；
     *   · dropWays     —— 按**调用方给的名单**丢掉（缩放变小后"这一档永远画不出来"的那些）。
     *
     * 几条不许动的底线（"道路一条不缺"的前提）：
     *   · pinned / 选中的 / 框选的 / 撤销栈保护的元素（`_collectPins`）一律跳过；
     *   · 关系成员的 way 不跳过 —— 关系环靠懒缝，成员缺了几何就画不出来，
     *     所以**有关系的成员 way 也一并保住**（宁可多留一点，也不让一块面消失）；
     *   · 增量维护空间索引；索引维护不了就标记 `_gridStamp = -1`（下次查询整表重建），
     *     而不是留着脏索引（脏索引 = 查到已经不存在的 way）。
     *
     * 不删节点：节点可能还被别的 way / 关系用着，交给 unload 按保留区统一处理。
     * 丢完之后 `touch(false)`（只改数据版本号，不动几何版本号）：渲染层据此重建，
     * 但已有几何缓存（bbox / 投影）依然有效。
     *
     * @param {number[]|Set<number>} ids  要丢的 way id
     * @returns {{dropped:number, keptPinned:number, keptRelation:number, missing:number, ms:number, ids:number[]}}
     */
    dropWays(ids, options = {}) {
      const t0 = nowMs();
      const list = ids instanceof Set ? Array.from(ids) : (Array.isArray(ids) ? ids : []);
      const pins = World._collectPins();
      /** 关系成员的 way id：一个都不能丢（丢了环缝不出来，面就没了） */
      let members = null;
      if (list.length && options.keepRelationMembers !== false) {
        members = new Set();
        for (const rel of World.relations.values()) {
          for (const m of rel.members || []) if (m.type === 'way') members.add(Number(m.ref));
        }
      }
      let dropped = 0;
      let keptPinned = 0;
      let keptRelation = 0;
      let missing = 0;
      const droppedIds = [];
      let indexDirty = false;
      for (const raw of list) {
        const id = Number(raw);
        const way = World.ways.get(id);
        if (!way) { missing += 1; continue; }
        if (pins.has('way:' + id) || pins.has('relation:' + id)) { keptPinned += 1; continue; }
        if (members && members.has(id)) { keptRelation += 1; continue; }
        World.ways.delete(id);
        if (!World.indexRemoveWay(way)) indexDirty = true;
        if (World._incompleteWays) World._incompleteWays.delete(way);
        droppedIds.push(id);
        dropped += 1;
      }
      if (indexDirty) World._gridStamp = -1;
      const ms = nowMs() - t0;
      if (dropped) {
        // 只改数据版本号：几何缓存与索引都还在，下一次重绘几乎不用重算坐标
        World.touch(false);
        World.stats.dropWays = (World.stats.dropWays || 0) + dropped;
        World.stats.dropWaysLast = dropped;
        World.stats.dropWaysAt = Date.now();
        World.stats.dropWaysMs = (World.stats.dropWaysMs || 0) + ms;
        World.perfAdd('dropWays', ms);
      }
      const report = {
        dropped, keptPinned, keptRelation, missing, ms: Math.round(ms * 10) / 10,
        scanned: list.length, ids: droppedIds, reason: options.reason || '',
        zoom: Number.isFinite(options.zoom) ? options.zoom : null, at: Date.now(),
      };
      World._dropReport = report;
      return report;
    },

    /** 上一次"按 id 丢 way"的报告（自检/排查读它） */
    dropStats() {
      return Object.assign({ at: 0, dropped: 0, keptPinned: 0, keptRelation: 0, missing: 0, scanned: 0, ms: 0, reason: '', zoom: null },
        World._dropReport || {});
    },

    /**
     * 内存粗估：给定要素数与"节点引用总数"直接算（不再遍历全库）。
     * 传数字就用它当引用数；传 true 才退回"遍历 way 累加"的老办法（自检/状态栏路径）。
     */
    _bytesOf(counts, nodeRefs) {
      const c = counts || World.counts();
      const refs = typeof nodeRefs === 'number' ? nodeRefs : 0;
      return (c.nodes || 0) * 64 + (c.ways || 0) * 160 + refs * 8 + (c.relations || 0) * 120;
    },

    /** way 是否落在保留区里（算不出位置的要素一律保留：数据不全时宁可多留） */
    _wayNear(way, keep) {
      const nodes = way.nodes;
      if (!nodes || !nodes.length) return true;
      const last = nodes.length - 1;
      const probes = last > 0 ? [0, last] : [0];
      for (const idx of probes) {
        const n = World.nodes.get(nodes[idx]);
        if (n && World._insideBox(keep, n.lat, n.lon)) return true;
      }
      const b = World.wayBBox(way);
      if (!b) return true;
      return World._boxesIntersect(b, keep);
    },

    /** 卸载时必须保住的东西：pinned + 选中的 / 框选的 + 撤销栈登记的 */
    _collectPins() {
      const out = new Set(World.pinned);
      for (const key of World.undoKeep) out.add(key);
      const ed = window.G && window.G.Editor;
      if (ed) {
        const add = (type, id) => {
          if (!type || id == null) return;
          const n = Number(id);
          if (Number.isFinite(n)) out.add(type + ':' + n);
        };
        if (ed.selection) add(ed.selection.type, ed.selection.id);
        for (const it of ed.multiSelect || []) if (it) add(it.type, it.id);
        // 撤销栈条目（actionLog）：可能直接带元素，也可能带 op 里的元素
        for (const a of (ed.actionLog || []).slice(-200)) {
          if (!a) continue;
          add(a.type, a.id);
          if (a.node) add('node', a.node.id);
          if (a.way) add('way', a.way.id);
          if (a.relation) add('relation', a.relation.id);
        }
      }
      return out;
    },

    /** 关系里的节点成员（站点等）：关系不卸载，它们的节点也不能卸载 */
    _relationNodeIds() {
      const out = new Set();
      for (const rel of World.relations.values()) {
        for (const m of rel.members || []) {
          if (m.type === 'node') out.add(Number(m.ref));
        }
      }
      return out;
    },

    /** 兜底入口（老代码/外部还在调 maybePrune）：语义与 unload 一致 */
    maybePrune(bbox) {
      return World.maybeUnload({ box: bbox || World.viewportBox });
    },

    /* ------------------------------ 统计 ------------------------------ */
    /* ------------------------------ 统计与自检 ------------------------------ */
    /** 本地要素数的简写（116000 → 116k），报告里用 */
    _k(n) {
      const v = Number(n) || 0;
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (v >= 1000) return Math.round(v / 1000) + 'k';
      return String(Math.round(v));
    },

    /**
     * 本地内存的粗估（不是精确统计，只为了给出"卸载前后"可比的两个数字）：
     * 节点对象 ~64B，way 对象 ~160B + 每个节点引用 8B，关系 ~120B。
     * withNodeRefs 传数字时直接用（调用方已经数好了，省掉一次全库遍历）。
     */
    estimateBytes(counts, withNodeRefs) {
      if (typeof withNodeRefs === 'number') return World._bytesOf(counts, withNodeRefs);
      const c = counts || World.counts();
      let nodeRefs = 0;
      if (withNodeRefs) for (const w of World.ways.values()) nodeRefs += (w.nodes ? w.nodes.length : 0);
      return World._bytesOf(c, nodeRefs);
    },

    /**
     * 报告里的那句中文：「拖动 5 屏后本地要素数 117k → 16k」。
     * 传 live（当前的 {features, bytes}）时"after"用实时数字：
     * 因为卸载之后新数据还会陆续到货，报告里的 after 只是卸载那一刻的快照。
     */
    _unloadText(report, live) {
      const win = World._window();
      const screens = win.screens ? Math.round(win.screens * 10) / 10 : 0;
      const beforeFeatures = win.peakFeatures || (report && report.before ? report.before.features : World.total());
      const afterFeatures = live ? live.features : (report ? report.after.features : World.total());
      // 内存：统一按"当时的平均单要素占用"折算，这样 before/after 两个数字永远可比
      const base = report && report.before ? report.before : { features: beforeFeatures, bytes: 0 };
      const avg = base.features > 0 ? base.bytes / base.features : 0;
      const beforeBytes = live && live.features > 0 ? Math.round(beforeFeatures * (live.bytes / live.features)) : Math.round(beforeFeatures * avg);
      const afterBytes = live ? live.bytes : (report ? report.after.bytes : 0);
      const drag = screens > 0 ? `拖动 ${screens} 屏后` : '本次卸载后';
      const mem = `${util.fmtBytes(beforeBytes)} → ${util.fmtBytes(afterBytes)}`;
      return `${drag}本地要素数 ${World._k(beforeFeatures)} → ${World._k(afterFeatures)}`
        + `（累计卸载 ${World._k(win.removed)} · 估算内存 ${mem} · 视野内一个都没少）`;
    },

    /**
     * 卸载统计（状态栏 / 自检 / 排查都用它）。
     * before 取"观察窗里的最高点"而不是"上一次卸载前的一瞬间"：
     * 这样「拖动 5 屏后 116k → 9k」读起来就是玩家真正看到的那件事。
     */
    unloadStats() {
      const win = World._window();
      const counts = World.counts();
      const features = counts.nodes + counts.ways + counts.relations;
      const bytes = World.estimateBytes(counts, true);
      const last = World._unload;
      const counts0 = win.peakCounts || counts;
      const peakFeatures = win.peakFeatures || features;
      // 峰值那一刻的内存只能按"当前平均单要素占用"折算（那批数据已经不在本地了）
      const avg = features > 0 ? bytes / features : 0;
      const stats = {
        at: win.at || 0,
        calls: win.calls,
        screens: Math.round(win.screens * 100) / 100,
        marginScreens: KEEP_MARGIN_SCREENS,
        marginPerSideScreens: KEEP_MARGIN_SCREENS / 2,
        triggerScreens: UNLOAD_TRIGGER_SCREENS,
        removed: win.removed,
        before: Object.assign({}, counts0, { features: peakFeatures, bytes: Math.round(peakFeatures * avg) }),
        after: Object.assign({}, counts, { features, bytes }),
        counts,
        features,
        bytes,
        saved: Math.max(0, peakFeatures - features),
        ratio: peakFeatures > 0 ? Math.round((features / peakFeatures) * 1000) / 1000 : 1,
        keep: World.keepBox(),
        viewport: World.viewportBox ? Object.assign({}, World.viewportBox) : null,
        // 低缩放合并折线（displayLines）：也算"本地数据"，但它不进 total()/MAX_ELEMENTS 的口径
        displayLines: World.displayLineReport(),
        // 低缩放合并面（displayAreas）：同上（只有几何、没有 way id）
        displayAreas: World.displayAreaReport(),
        last,
      };
      stats.text = last ? World._unloadText(last, { features, bytes }) : `还没卸载过 · 本地要素数 ${World._k(features)}`;
      return stats;
    },

    /**
     * 视野内的数据是不是"一个都不缺"：queryWays 拿到的每条 way 都要在本地、且节点齐全。
     * 卸载只可能动保留区之外的要素，所以这里必须永远全绿 —— 自检拿它当铁证。
     */
    viewportCompleteness(box) {
      const view = box || World.viewportBox;
      if (!view) return { ways: 0, complete: 0, completeRatio: 1, missingNodes: 0, roads: 0, roadsComplete: 0 };
      // 复用缓冲区：这条路径每次新建一个"几万条 way"的数组纯属浪费（见 queryWays 的说明）
      const all = World.queryWays(view, World._completenessScratch || (World._completenessScratch = []));
      let ways = 0;
      let complete = 0;
      let missingNodes = 0;
      let roads = 0;
      let roadsComplete = 0;
      for (const way of all) {
        ways += 1;
        let ok = true;
        const nodes = way.nodes || [];
        if (!nodes.length) ok = false;
        for (const nid of nodes) {
          if (!World.nodes.has(nid)) { ok = false; missingNodes += 1; break; }
        }
        if (ok) complete += 1;
        if (way.tags && way.tags.highway) {
          roads += 1;
          if (ok) roadsComplete += 1;
        }
      }
      return {
        ways, complete, missingNodes, roads, roadsComplete,
        completeRatio: ways ? Math.round((complete / ways) * 1000) / 1000 : 1,
      };
    },

    categoryOf(type, id, style) {
      const el = World.get(type, id);
      if (!el) return 'other';
      return style.categoryOf(el.tags, type === 'node' ? 'point' : (World.isClosed(el) ? 'area' : 'line'));
    },

    counts() {
      return { nodes: World.nodes.size, ways: World.ways.size, relations: World.relations.size };
    },

    /* --------------------------- 自检：拖动之后本地要素数真的会掉 --------------------------- */
    /**
     * 沙盒自检（不动页面上的真实数据，跑完把真实状态原样装回去）。
     * 场景就是用户抱怨的那件事：本地已经装了十几屏的数据（11 万多要素），
     * 然后一屏一屏地往东拖 5 屏 —— 断言"本地要素数确实掉下来、而视野内一个都没少"。
     *   · 假数据集：每屏 ~1800 条 way + ~6800 个节点 + 3 个 POI（≈ 8600 个要素）；
     *   · 全程走真实代码路径：setViewport → maybeUnload → unload → mergePayload（回拖时重新下发）。
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
      const cfg = {
        waysPerScreen: Math.max(50, Math.round(Number(options.waysPerScreen) || 1800)),
        screens: Math.max(3, Math.round(Number(options.screens) || 13)),
        screenLat: Number(options.screenLat) || 0.0065,   // ≈ 720 m（z16 一屏的量级）
        screenLon: Number(options.screenLon) || 0.0090,   // ≈ 765 m
        lat0: Number(options.lat) || 39.9042,
        lon0: Number(options.lon) || 116.4074,
      };
      cfg.dragScreens = Math.max(1, Math.min(cfg.screens - 1, Math.round(Number(options.dragScreens) || 5)));

      const snap = World._snapshotState();
      const realMapData = window.G ? window.G.MapData : null;
      const sink = (options.mapData && typeof options.mapData.invalidateOutside === 'function')
        ? options.mapData
        : { calls: 0, lastKeep: null, invalidateOutside(keep) { this.calls += 1; this.lastKeep = keep; return 1; } };
      const silentBefore = World._unloadSilent;
      let result = null;
      try {
        World._unloadSilent = true;
        if (window.G) window.G.MapData = sink;

        /* 1) 造十几屏假数据（视野先框住整条，装载期间不卸载） */
        const slab = World._sandboxBox(cfg, 0, cfg.screens - 1);
        World.viewportBox = slab;
        World._fillSandbox(cfg);
        const start = World.counts();
        const startFeatures = start.nodes + start.ways + start.relations;
        check('铺了 ' + cfg.screens + ' 屏假数据（每屏约 ' + cfg.waysPerScreen + ' 条 way）',
          startFeatures > cfg.screens * cfg.waysPerScreen * 3,
          `${startFeatures} 个要素 · ${World._k(startFeatures)}`);

        /* 2) 护栏：还没有视野时（页面刚启动）合并分块响应绝不能顺手把本地数据清掉 */
        World.viewportBox = null;
        World._evalViewport = null;
        const beforeMerge = World.total();
        World.mergePayload(World._sandboxScreen(cfg, 2));
        const afterMerge = World.total();
        check('没有视野时合并响应不会误删本地的其它块',
          afterMerge === beforeMerge, `${beforeMerge} → ${afterMerge}`);

        /* 3) 视野回到第 1 屏（模拟"玩家此刻的场景"） */
        const box0 = World._sandboxBox(cfg, 0);
        World.viewportBox = box0;
        World._evalViewport = Object.assign({}, box0);
        World._unloadWindow = null;
        const view0 = World.viewportCompleteness(box0);
        check('起始：视野内数据完整（way 的节点都在）', view0.completeRatio === 1 && view0.ways > 0, JSON.stringify(view0));

        /* 3) pinned / 撤销栈元素：故意挑"很远"的两条，验证它们不会被卸载 */
        const wayIds = [...World.ways.keys()].sort((a, b) => a - b);
        const farWay = wayIds[wayIds.length - 1];
        const undoWay = wayIds[wayIds.length - 2];
        World.pin('way', farWay);
        World.keepForUndo('way', undoWay);
        const nearWayId = wayIds[0];

        /* 4) 一屏一屏地往东拖 5 屏（每一步都像真实流程那样：先移动视野，再取回新一屏的数据） */
        const endBox = World._sandboxBox(cfg, cfg.dragScreens);
        for (let i = 1; i <= cfg.dragScreens; i++) {
          World.setViewport(World._sandboxBox(cfg, i));
          World.mergePayload(World._sandboxScreen(cfg, i));
        }

        const end = World.counts();
        const endFeatures = end.nodes + end.ways + end.relations;
        const stats = World.unloadStats();
        const viewEnd = World.viewportCompleteness(endBox);

        check('拖完 ' + cfg.dragScreens + ' 屏：本地要素数明显下降',
          endFeatures < startFeatures * 0.35, `${startFeatures} → ${endFeatures}`);
        check('观察窗记下了"拖了几屏"', stats.screens >= cfg.dragScreens - 0.01, `screens=${stats.screens}`);
        check('观察窗的 before 就是拖动前的规模（不是上一次卸载前的一瞬间）',
          stats.before.features >= startFeatures * 0.99, `${stats.before.features} vs ${startFeatures}`);
        check('unloadStats() 的 after 与真实计数一致',
          stats.after.features === endFeatures && stats.counts.ways === end.ways,
          `${stats.after.features} / ${endFeatures}`);
        check('报告里有中文摘要「拖动 N 屏后本地要素数 … → …」',
          /拖动 .+屏后本地要素数 .+ → .+/.test(stats.text), stats.text);
        check('估算内存也跟着降下来了',
          stats.after.bytes < stats.before.bytes * 0.5,
          `${util.fmtBytes(stats.before.bytes)} → ${util.fmtBytes(stats.after.bytes)}`);
        check('视野内一个要素都没少（也没有断掉的路）',
          viewEnd.completeRatio === 1 && viewEnd.ways > 0 && viewEnd.missingNodes === 0, JSON.stringify(viewEnd));
        check('视野内的道路依然完整', viewEnd.roads > 0 && viewEnd.roads === viewEnd.roadsComplete,
          `${viewEnd.roadsComplete}/${viewEnd.roads}`);
        check('pinned / 撤销栈元素即使很远也被保住',
          !!World.getWay(farWay) && !!World.getWay(undoWay), `way:${farWay} & way:${undoWay}`);
        check('保留区外的 way 已经真的不在本地了', !World.getWay(nearWayId), `way:${nearWayId}`);
        check('卸载的那块已经通知 MapData 作废（拖回去会重新请求）',
          sink.calls > 0 && !!sink.lastKeep
            && sink.lastKeep.minLon > box0.maxLon, `invalidateOutside ${sink.calls} 次 · keep.minLon=${sink.lastKeep ? sink.lastKeep.minLon : '-'}`);

        /* 5) 拖回去：重新下发同一块数据，视野照样完整（"卸载 ≠ 永久丢数据"） */
        World.mergePayload(World._sandboxScreen(cfg, 0));
        const back = World.viewportCompleteness(box0);
        check('拖回原处重新下发后，视野数据又是完整的',
          back.ways > 0 && back.completeRatio === 1, JSON.stringify(back));

        result = {
          ok: failures.length === 0,
          steps,
          failures,
          screens: cfg.dragScreens,
          before: { features: startFeatures, ways: start.ways, nodes: start.nodes, relations: start.relations },
          after: { features: endFeatures, ways: end.ways, nodes: end.nodes, relations: end.relations },
          stats,
          text: stats.text,
        };
      } finally {
        World._restoreState(snap);
        World._unloadSilent = silentBefore;
        if (window.G) {
          if (realMapData) window.G.MapData = realMapData;
          else delete window.G.MapData;
        }
      }
      return result;
    },

    /* --------------------- 自检：多面体的内环（异形楼的天井）被认出来了 --------------------- */
    /**
     * 环自检：拿一份**合成的多面体 payload**（格式与 /api/map 完全一致）走真实的
     * mergePayload → relationRings 路径，断言：
     *   · 外环被切成两条 way 时能按共享节点 id 接成一个闭环；
     *   · role=inner 的 way 被认成内环（天井），单独的"闭合外环 + 内环"也一样；
     *   · 没接上的碎片（开链）被丢掉、成员 way 缺失也不会炸；
     *   · 环是懒算的（mergePayload 之后还没有），并且算一次就缓存住（同一个对象），
     *     数据一变就失效重算。
     * 全程不动页面上的真实数据（合成数据落在南半球，跑完原样装回去）。
     */
    selfCheckRings(options = {}) {
      const steps = [];
      const failures = [];
      const check = (name, cond, detail) => {
        const ok = !!cond;
        steps.push({ name, ok, detail: detail == null ? '' : String(detail) });
        if (!ok) failures.push(name);
        return ok;
      };
      const lat0 = Number.isFinite(Number(options.lat)) ? Number(options.lat) : -33.90;
      const lon0 = Number.isFinite(Number(options.lon)) ? Number(options.lon) : 151.20;
      const d = (a, b) => [lat0 + a, lon0 + b];
      /**
       * 合成的 id 全部取**负数**：OSM 的 id 都是正数，所以绝不会覆盖页面上的真实要素
       * （自检跑在真实 World 上，绝不能碰坏任何一条真实数据）。
       * 合成数据也落在南半球，离北京的数据集很远。
       */
      const N = (n) => -9900000 - n;    // 节点
      const W = (n) => -9910000 - n;    // way
      const R = (n) => -990000 - n;     // 关系
      const n1 = N(1); const n2 = N(2); const n3 = N(3); const n4 = N(4);
      const n11 = N(11); const n12 = N(12); const n13 = N(13); const n14 = N(14);
      const n21 = N(21); const n22 = N(22); const n23 = N(23); const n24 = N(24);
      const n31 = N(31); const n32 = N(32); const n33 = N(33); const n34 = N(34);
      const n41 = N(41); const n42 = N(42); const n43 = N(43);
      const n51 = N(51); const n52 = N(52); const n53 = N(53); const n54 = N(54);
      const n61 = N(61); const n62 = N(62);
      const wOut1 = W(101); const wOut2 = W(102); const wHole = W(103);
      const wOutB = W(104); const wHoleB = W(105); const wBroken = W(106);
      const wPlain = W(107); const wRoad = W(108);
      const rA = R(9001); const rB = R(9002); const rRoute = R(9003);
      const payload = {
        nodes: {
          [n1]: d(0.00020, 0.00020), [n2]: d(0.00020, 0.00040), [n3]: d(0.00000, 0.00040), [n4]: d(0.00000, 0.00020),
          [n11]: d(0.00008, 0.00026), [n12]: d(0.00008, 0.00034), [n13]: d(0.00013, 0.00034), [n14]: d(0.00013, 0.00026),
          [n21]: d(0.00060, 0.00020), [n22]: d(0.00060, 0.00040), [n23]: d(0.00040, 0.00040), [n24]: d(0.00040, 0.00020),
          [n31]: d(0.00048, 0.00026), [n32]: d(0.00048, 0.00034), [n33]: d(0.00053, 0.00034), [n34]: d(0.00053, 0.00026),
          [n41]: d(0.00080, 0.00020), [n42]: d(0.00080, 0.00030), [n43]: d(0.00070, 0.00030),
          [n51]: d(0.00100, 0.00020), [n52]: d(0.00100, 0.00040), [n53]: d(0.00090, 0.00040), [n54]: d(0.00090, 0.00020),
          [n61]: d(0.00120, 0.00020), [n62]: d(0.00120, 0.00040),
        },
        nodeTags: {},
        ways: {
          // 甲楼：外环被切成 2 条 way（1-2-3 / 3-4-1），天井 1 条闭合 way
          [wOut1]: [1, [n1, n2, n3], { building: 'yes' }, false, 0],
          [wOut2]: [1, [n3, n4, n1], { building: 'yes' }, false, 0],
          [wHole]: [1, [n11, n12, n13, n14, n11], {}, true, 0],
          // 乙楼：外环一条闭合 way + 内环一条闭合 way
          [wOutB]: [1, [n21, n22, n23, n24, n21], { building: 'yes' }, true, 0],
          [wHoleB]: [1, [n31, n32, n33, n34, n31], {}, true, 0],
          // 接不上的内环碎片（开链）：必须被丢掉，不能当成天井
          [wBroken]: [1, [n41, n42, n43], {}, false, 0],
          // 普通闭合建筑 way（对照）与一条开链 way
          [wPlain]: [1, [n51, n52, n53, n54, n51], { building: 'yes' }, true, 0],
          [wRoad]: [1, [n61, n62], { highway: 'residential' }, false, 0],
        },
        relations: {
          [rA]: [1, [['way', wOut1, 'outer'], ['way', wOut2, 'outer'], ['way', wHole, 'inner'], ['way', W(999), 'outer']],
            { type: 'multipolygon', building: 'yes' }],
          [rB]: [1, [['way', wOutB, 'outer'], ['way', wHoleB, 'inner'], ['way', wBroken, 'inner']],
            { type: 'multipolygon', building: 'yes' }],
          [rRoute]: [1, [['way', wPlain, '']], { type: 'route', route: 'bus' }],
        },
      };
      const snap = World._snapshotState();
      const silentBefore = World._unloadSilent;
      let result = null;
      try {
        World._sandboxActive = true;
        World._unloadSilent = true;
        World.viewportBox = null;
        World._evalViewport = null;
        World.mergePayload(payload);

        const relA = World.getRelation(rA);
        const relB = World.getRelation(rB);
        check('合成 payload 合并成功（3 个关系 / 8 条 way）',
          !!relA && !!relB && World.getWay(wOut1) && World.getWay(wHoleB),
          `关系 ${World.relations.size} 个 · way ${World.ways.size} 条`);

        /* 1) 懒计算：还没人要环的时候，一条几何都不缝 */
        check('环是懒算的（mergePayload 之后还没有缓存）', !relA._rings && !relB._rings);

        /* 2) 外环接龙 + 内环（天井） */
        const ringsA = World.relationRings(relA);
        check('外环被切成两条 way 时接成了一个闭环',
          ringsA.outers.length === 1 && ringsA.outerWays === 2, JSON.stringify({ outers: ringsA.outers.length, outerWays: ringsA.outerWays }));
        check('role=inner 的 way 被认成内环（天井）',
          ringsA.inners.length === 1 && ringsA.innerWays === 1, JSON.stringify({ inners: ringsA.inners.length, innerWays: ringsA.innerWays }));
        const outerA = ringsA.outers[0] || [];
        check('外环是闭合环（首尾同点、5 个点）',
          outerA.length === 5 && outerA[0][0] === outerA[4][0] && outerA[0][1] === outerA[4][1],
          `点数 ${outerA.length}`);
        check('内环是闭合环（4 个角 + 收尾）', (ringsA.inners[0] || []).length === 5,
          `点数 ${(ringsA.inners[0] || []).length}`);
        check('内环面积小于外环（真的是个洞）',
          util.ringAreaM2(ringsA.inners[0] || []) < util.ringAreaM2(outerA),
          `${Math.round(util.ringAreaM2(ringsA.inners[0] || []))} m² < ${Math.round(util.ringAreaM2(outerA))} m²`);

        /* 3) 缓存：同一个对象；数据一变就失效 */
        const again = World.relationRings(relA);
        check('再取一次直接命中缓存（同一个对象，不重缝）', again === ringsA);
        World.touch(false);
        const fresh = World.relationRings(relA);
        check('数据版本一变，环缓存失效并重算出等价结果',
          fresh !== ringsA && fresh.outers.length === ringsA.outers.length && fresh.inners.length === ringsA.inners.length);

        /* 4) 碎片与缺成员：丢碎片、不炸、不误当天井 */
        const ringsB = World.relationRings(relB);
        check('一条闭合外环 + 一条闭合内环同样是 1 外 1 内',
          ringsB.outers.length === 1 && ringsB.inners.length === 1, JSON.stringify({ o: ringsB.outers.length, i: ringsB.inners.length }));
        check('接不上的内环碎片被丢掉（不会当成天井）', ringsB.dropped >= 1, `dropped=${ringsB.dropped}`);
        check('成员 way 不存在时不影响其它成员（外环照样缝出来）', ringsA.outers.length === 1);

        /* 5) coords() 的两种形态：默认还是"路径数组"，opts.rings 才给环 */
        const viaCoords = World.coords('relation', rA, { rings: true });
        check('World.coords(type,id,{rings:true}) 返回 { outers, inners }',
          viaCoords === World.relationRings(relA) && viaCoords.inners.length === 1);
        const legacy = World.coords('relation', rA);
        check('World.coords(type,id) 默认形态没变（还是路径数组）',
          Array.isArray(legacy) && legacy.length === 3 && Array.isArray(legacy[0][0]),
          `${legacy.length} 条路径 · 第一条 ${legacy[0] ? legacy[0].length : 0} 个点`);

        /* 6) way 的环（对照） */
        check('闭合 building way 走 ringsOf 也是 1 外 0 内',
          World.ringsOf('way', wPlain).outers.length === 1 && World.ringsOf('way', wPlain).inners.length === 0);
        check('开链 way 没有环', World.ringsOf('way', wRoad).outers.length === 0);
        check('非多面体关系没有环', World.ringsOf('relation', rRoute).outers.length === 0);

        /* 7) 视野清点：2 座楼、其中 2 座带天井 */
        const box = { minLat: lat0 - 0.001, maxLat: lat0 + 0.002, minLon: lon0 - 0.001, maxLon: lon0 + 0.002 };
        const st = World.buildingRelationStats(box);
        check('视野清点：2 座多面体建筑，其中 2 座带内环',
          st.buildings === 2 && st.withInner === 2 && st.innerRings === 2, JSON.stringify(st));
        check('视野外不计入', World.buildingRelationStats({ minLat: 0, maxLat: 0.001, minLon: 0, maxLon: 0.001 }).buildings === 0);
        const bboxRel = World.relationBBox(relA);
        check('关系的 bbox 覆盖外环',
          !!bboxRel && bboxRel.minLat <= outerA[0][0] && bboxRel.maxLat >= outerA[2][0],
          JSON.stringify(bboxRel));

        result = {
          ok: failures.length === 0,
          steps,
          failures,
          sample: {
            relation: 9001,
            outers: ringsA.outers.length,
            inners: ringsA.inners.length,
            outerPoints: outerA.length,
            innerPoints: (ringsA.inners[0] || []).length,
            outerAreaM2: Math.round(util.ringAreaM2(outerA)),
            innerAreaM2: Math.round(util.ringAreaM2(ringsA.inners[0] || [])),
            outerSplitFromWays: ringsA.outerWays,
          },
          stats: st,
        };
      } finally {
        World._restoreState(snap);
        World._unloadSilent = silentBefore;
      }
      return result;
    },

    /** 自检用的"第 i 屏"（每屏 screenLon 宽，都占满一屏高度） */
    _sandboxBox(cfg, from, to) {
      const last = to == null ? from : to;
      return {
        minLat: cfg.lat0, maxLat: cfg.lat0 + cfg.screenLat,
        minLon: cfg.lon0 + from * cfg.screenLon, maxLon: cfg.lon0 + (last + 1) * cfg.screenLon,
      };
    },

    /**
     * 造"一屏"假数据，格式就是 /api/map 的返回格式（走真实 mergePayload 路径）。
     * way/节点 id 由屏号推导，所以"卸载后再下发同一批数据"可以重复调用。
     */
    _sandboxScreen(cfg, s) {
      const perRow = 30;
      const cellLat = cfg.screenLat / perRow;
      const cellLon = cfg.screenLon / perRow;
      const nodes = {};
      const nodeTags = {};
      const ways = {};
      const wayBase = s * 1000000;
      const nodeBase = s * 10000000;
      for (let w = 0; w < cfg.waysPerScreen; w++) {
        const gx = w % perRow;
        const gy = Math.floor(w / perRow) % perRow;
        const lat = cfg.lat0 + (gy + 0.5) * cellLat;
        const lon = cfg.lon0 + s * cfg.screenLon + (gx + 0.5) * cellLon;
        const dLat = cellLat * 0.4;
        const dLon = cellLon * 0.4;
        const n0 = nodeBase + w * 10 + 1;
        const road = (w % 5) !== 0;
        nodes[n0] = [lat, lon];
        nodes[n0 + 1] = [lat + dLat, lon + dLon * (road ? 0.3 : 1)];
        nodes[n0 + 2] = [lat + dLat * 2, lon + dLon * (road ? 0.6 : 1)];
        if (road) {
          nodes[n0 + 3] = [lat + dLat * 3, lon + dLon];
          ways[wayBase + w + 1] = [1, [n0, n0 + 1, n0 + 2, n0 + 3], { highway: 'residential' }, false, 0];
        } else {
          nodes[n0 + 3] = [lat + dLat, lon];   // 首尾同点 → 闭合的建筑
          ways[wayBase + w + 1] = [1, [n0, n0 + 1, n0 + 2, n0], { building: 'yes' }, true, 0];
        }
      }
      for (let i = 0; i < 3; i++) {
        const nid = nodeBase + cfg.waysPerScreen * 10 + i + 1;
        nodes[nid] = [cfg.lat0 + (i + 1) * (cfg.screenLat / 5), cfg.lon0 + s * cfg.screenLon + (i + 1) * (cfg.screenLon / 5)];
        nodeTags[nid] = { amenity: 'cafe', name: `自检 POI ${s}-${i}` };
      }
      return {
        nodes, nodeTags, ways, relations: {}, truncated: false,
        bounds: World._sandboxBox(cfg, s),
        stats: { highways: cfg.waysPerScreen },
      };
    },

    /** 装载假数据（直接换掉三个 Map，跑完由 _restoreState 装回真实数据） */
    _fillSandbox(cfg) {
      World._sandboxActive = true;
      World.nodes = new Map();
      World.ways = new Map();
      World.relations = new Map();
      World.taggedNodes = new Map();
      World.pinned = new Set();
      World.undoKeep = new Set();
      World._grid = null;
      World._nodeGrid = null;
      World._bigWays = [];
      World._gridStamp = -1;
      World._unload = null;
      World._unloadWindow = null;
      World.lastStats = null;
      World.geomStamp += 1;
      World.dataStamp += 1;
      for (let s = 0; s < cfg.screens; s++) World.mergePayload(World._sandboxScreen(cfg, s));
      return World.counts();
    },

    _snapshotState() {
      return {
        nodes: World.nodes, ways: World.ways, relations: World.relations,
        taggedNodes: World.taggedNodes, pinned: World.pinned, undoKeep: World.undoKeep,
        viewportBox: World.viewportBox, _evalViewport: World._evalViewport,
        _unload: World._unload, _unloadWindow: World._unloadWindow,
        pruneStats: World.pruneStats, lastStats: World.lastStats,
        dataStamp: World.dataStamp, geomStamp: World.geomStamp,
        _grid: World._grid, _nodeGrid: World._nodeGrid, _gridStamp: World._gridStamp, _bigWays: World._bigWays,
        // "待修复（缺节点）"名单也要一起快照：自检跑的是合成数据，不能把假 way 留在这张表里
        incompleteWays: new Set(World._incompleteWays),
      };
    },

    _restoreState(snap) {
      if (!snap) return;
      World._sandboxActive = false;
      World.nodes = snap.nodes;
      World.ways = snap.ways;
      World.relations = snap.relations;
      World.taggedNodes = snap.taggedNodes;
      World.pinned = snap.pinned;
      World.undoKeep = snap.undoKeep;
      World.viewportBox = snap.viewportBox;
      World._evalViewport = snap._evalViewport;
      World._unload = snap._unload;
      World._unloadWindow = snap._unloadWindow;
      World.pruneStats = snap.pruneStats;
      World.lastStats = snap.lastStats;
      World._incompleteWays = snap.incompleteWays || new Set();
      // 自检期间的索引指向假数据：丢掉，让真实索引在下次查询时按需重建。
      // geomStamp 原样装回：真实要素的 bbox / 投影缓存因此依然有效（自检不会让页面重算一遍）。
      World._grid = null;
      World._nodeGrid = null;
      World._bigWays = [];
      World._gridStamp = -1;
      World.geomStamp = snap.geomStamp;
      World.dataStamp = snap.dataStamp + 1;
    },

    categoryCounts(style) {
      const out = {};
      for (const way of World.ways.values()) {
        const cat = style.categoryOf(way.tags, World.isClosed(way) ? 'area' : 'line');
        out[cat] = (out[cat] || 0) + 1;
      }
      for (const node of World.nodes.values()) {
        if (!node.tags) continue;
        const cat = style.categoryOf(node.tags, 'point');
        out[cat] = (out[cat] || 0) + 1;
      }
      return out;
    },
  };

  window.G.World = World;
})();
