'use strict';
/** 界面：工具栏、图层、搜索、导出、历史、协作者、聊天、状态栏、登录 */
(function () {
  const { util, World, Render, Editor, Inspector, Net, MapData, Transit } = window.G;

  const UI = {
    meta: null,
    players: [],
    locks: {},
    myId: null,
    info: null,
    depth: { undoDepth: 0, redoDepth: 0 },
    presetBrowser: null,
    /**
     * 可折叠面板：localStorage 键按面板分开记（元素 id 与键名一一对应，
     * 折叠按钮的 id 是「面板 id + -collapse」）。
     * 页面上每一块面板都走同一套机制：左栏两块（编辑工具 / 图层与显示模式）、
     * 右栏两块（属性检查器 / 工具选项）、左下协作频道、右下在线协作者、交通公司窗口。
     */
    PANEL_KEYS: {
      transit: 'osmcity.panel.transit',
      inspector: 'osmcity.panel.inspector',
      layers: 'osmcity.panel.layers',
      toolopts: 'osmcity.panel.toolopts',
      toolbox: 'osmcity.panel.tools',
      chat: 'osmcity.panel.chat',
      collab: 'osmcity.panel.collab',
    },
    PANEL_TITLES: {
      transit: '交通公司', inspector: '属性检查器',
      layers: '图层面板', toolopts: '工具选项面板', toolbox: '编辑工具面板',
      chat: '协作频道', collab: '在线协作者面板',
    },
    collapsed: {
      transit: false, inspector: false, layers: false,
      toolopts: false, toolbox: false, chat: false, collab: false,
    },
    /**
     * 左栏现在是**三个工具按钮那么宽**（--rail-w = 3 × 36px 按钮 + 2 × 4px 间隙 + 6px 内边距 + 2px 边框 = 130px），
     * 折叠按钮在这里写完整的「▾ 折叠 / ▸ 展开」就放不下了：列进这张表的面板，
     * 折叠按钮**只写一个箭头**（完整说法放 title 上，aria-expanded 照旧跟着状态走）。
     * 右侧的「属性检查器 / 工具选项」宽度没变（316px），照旧写全称。
     */
    COMPACT_TOGGLES: { toolbox: true, layers: true },
    /**
     * 图层与显示模式面板的展开状态（它是左栏的第三块，紧贴在「工具选项」下面）。
     * 键名带 .v2：抽屉时代的 osmcity.panel.layersOpen 默认是「收起」，直接沿用会让
     * 面板一上来就缩着，看着像"图层又不见了"。旧键在 initLayersPanel 里清掉。
     */
    LAYERS_OPEN_KEY: 'osmcity.panel.layersOpen.v2',
    layersOpen: true,
    /** 交通公司面板被拖到哪儿了（{ left, top } 像素）；没有这一项就是 CSS 的默认位置（右栏左边） */
    TRANSIT_POS_KEY: 'osmcity.panel.transitPos',
    _transitPos: null,
    /**
     * 尺寸记忆（都是"用户拖出来的"，没有记忆就用 CSS 默认）：
     *   PANEL_H_KEYS   **四块**带拖柄的面板的高度（像素，osmcity.panel.h.<面板名>）——
     *                  左栏的 #toolbox（编辑工具）/ #layers（图层与显示模式）与
     *                  右栏的 #inspector（属性检查器）/ #toolopts（工具选项）。
     *                  左栏那两块是**两个独立面板**（各有自己的标题栏 / .panel-body / 拖柄），
     *                  所以高度也各记一份，互不影响。
     *   TRANSIT_SIZE_KEY 交通公司面板的 { w, h }
     *   MGR_WIN_POS_KEY  独立管理器窗口的位置 + 尺寸，**与 transit.js 共用同一个对象**
     *                    （osmcity.transit.mgrWin.<key>，transit.js 写 left/top，这里补 w/h）
     */
    PANEL_H_KEYS: {
      toolbox: 'osmcity.panel.h.toolbox',
      layers: 'osmcity.panel.h.layers',
      inspector: 'osmcity.panel.h.inspector',
      toolopts: 'osmcity.panel.h.toolopts',
    },
    /** 每块面板能被拖到的最小高度（再矮就只剩标题栏了，折叠按钮另管这件事） */
    PANEL_H_MIN: { toolbox: 96, layers: 96, inspector: 96, toolopts: 88 },
    TRANSIT_SIZE_KEY: 'osmcity.panel.transitSize',
    MGR_WIN_POS_KEY: 'osmcity.transit.mgrWin',
    /** 浮动窗口的最小尺寸：交通公司面板 / 独立管理器窗口（后者 CSS 里本来就有 300×200） */
    WIN_MIN: { w: 260, h: 160 },
    MGR_MIN: { w: 300, h: 200 },
    /** 拖柄改尺寸时给视口留的边距（像素） */
    WIN_MARGIN: 16,
    /**
     * 显示模式（互斥）：**只有这五种**，顺序就是面板上的行序 ——
     * 普通 / 轨交模式 / 公交模式 / 道路车速 / 拥堵模式。
     * 上色类（车速 / 拥堵）由渲染层换整套底图配色；轨交 / 公交模式 = 只看某一类（其余图层淡化），
     * 勾选它们时**下面缩进出现子 checkbox**（分色方式 + 线路类别，见 renderModeTree / modeChildren）。
     * 人口密度、活跃度、车站覆盖范围都是「图层」（图层表里的普通勾选框），不是显示模式。
     * 「公交线路分色」也不是显示模式：它是轨交 / 公交模式下面的子选项（见 TRANSIT_COLOR_MODES）。
     */
    MODE_KEY: 'osmcity.displayMode',
    /** 轨交 / 公交模式的筛选（只显示指定类型 / 只显示指定线路） */
    MODE_FILTER_KEYS: { rail: 'osmcity.modeFilter.rail', bus: 'osmcity.modeFilter.bus' },
    /** 图层开关的持久化键（独立于显示模式） */
    POP_KEY: 'osmcity.layer.population',
    ACTIVITY_KEY: 'osmcity.layer.activity',
    CATCHMENT_KEY: 'osmcity.layer.catchment',
    CATCHMENT_FILTER_KEY: 'osmcity.layer.catchmentFlaggedOnly',
    /**
     * 需要渲染层"换整套**底图**配色"的显示模式（其余模式只改聚焦 / 筛选，配色仍是普通）。
     * 注意：三个「公交线路分色」id（linecolor / company / fare）**不在这张表里** ——
     * 它们不走显示模式那条路（那是以前把它们当第 6/7/8 个模式芯片时的写法，是错的），
     * 而是走「分色方式」这条独立的轴，见 TRANSIT_COLOR_MODES。
     */
    COLOR_MODES: ['speed', 'congestion'],
    MODES: [
      { id: 'normal', name: '普通', ico: '🗺️', hint: '默认的 OSM Carto 写实配色' },
      { id: 'rail', name: '轨交模式', ico: '🚈', hint: '只突出轨道交通（铁路/地铁/轻轨/有轨电车），其余图层淡化；勾上之后下面缩进出现「分色方式」与「线路类别」两组子选项' },
      { id: 'bus', name: '公交模式', ico: '🚌', hint: '只突出公交（公交站 / 公交线路 / 公交车），其余图层淡化；勾上之后下面缩进出现「分色方式」与「线路类别」两组子选项' },
      { id: 'speed', name: '道路车速', ico: '🛣️', hint: '道路按有效限速上色：蓝 = 慢 → 红 = 快' },
      { id: 'congestion', name: '拥堵模式', ico: '🚦', hint: '道路按实时拥堵上色：绿 = 畅通 → 红 = 拥堵；进模式后按视野自动加载，下面有色带与统计' },
    ],
    /**
     * 三种「分色方式」的 id（**不是显示模式**）：linecolor 线路本色 / company 按公司 / fare 按票价。
     * 它们只出现在「轨交模式 / 公交模式」这一行下面的**子 checkbox**（分色方式，单选）里，
     * 取值与高亮都来自渲染层：Render.transitColorSchemeDefs() / Render.setTransitColorScheme()。
     * 同时它们仍是**旧接口的别名**：UI.selectDisplayMode('company') / Render.setDisplayMode('company')
     * 照旧可用 —— 渲染层那边"同时设方案 + 显示模式"，离开轨交/公交模式时回到 auto（老行为）。
     */
    TRANSIT_COLOR_MODES: ['linecolor', 'company', 'fare'],
    /** 拿不到 render.js 的 defs 时，子选项里那三个单选行用这份兜底（顺序 = 行序；short 是行上的短标签） */
    TRANSIT_COLOR_FALLBACK: [
      { id: 'linecolor', name: '按线路色分色', short: '按线路色', ico: '🎨', hint: '每条线路画自己的颜色（现在的默认表现）；两条线撞色时后一条换一个确定性的备用色，并在图例里标出来' },
      { id: 'company', name: '按公交公司分色', short: '按公交公司', ico: '🏢', hint: '同一家公司的线路 / 车站 / 车辆同一个颜色；颜色由公司 id 哈希得到，任何会话、任何客户端都一样' },
      { id: 'fare', name: '按票价分色', short: '按票价', ico: '🎫', hint: '按全程票价分档上色：票价 = 起步价 + 每公里价 × 线路里程（里程优先用服务端 pathLen，缺失时按路径折线算）' },
    ],
    /** 轨交模式可以筛的**线路类别**（与服务端站点类型表 STATION_KINDS 同名）：子 checkbox 逐项列出 */
    RAIL_TYPES: [
      ['hsr', '🚄 高铁'], ['intercity', '🚈 城际'], ['subway', '🚇 地铁'],
      ['rail', '🚂 普速'], ['light_rail', '🚊 轻轨'], ['tram', '🚋 有轨电车'],
    ],
    /** 公交模式的线路类别（公交站 / 公交线路只有一种 kind） */
    BUS_TYPES: [['bus', '🚌 公交']],
    /** 「线路类别」子 checkbox 每行左边那个色块的颜色（只为了每一行一眼能区分，与线路自己的配色无关） */
    TYPE_COLORS: {
      hsr: '#d64545', intercity: '#e07b39', subway: '#3d7dd8',
      rail: '#6b7280', light_rail: '#2fa36b', tram: '#b45bd6', bus: '#f4a23c',
    },
    /** 公交类车型（与服务端 VEHICLE_KINDS 里的公交一一对应） */
    BUS_VEHICLE_KINDS: { bus: 1, bus_double: 1, bus_artic: 1, trolley: 1, minibus: 1 },
    /** 当前显示模式（UI 层记住的 id，见 MODES） */
    mode: 'normal',
    /** 轨交 / 公交模式的筛选状态：types = kind 列表，lines = 线路 id 列表（空 = 全部） */
    modeFilters: { rail: { types: [], lines: [] }, bus: { types: [], lines: [] } },
    /** 图层开关状态（人口密度走交通模块的热力图，活跃度走渲染层的格子图层） */
    layers: { population: false, activity: false },
    /**
     * **服务器是否允许游客登录**（来自 GET /api/meta 的 `allowGuests`，默认关闭）。
     * 与 server/index.js 的 allowGuests 同一个开关：关闭时那个免注册入口整个藏掉，
     * 只留注册 / 登录。老服务器（/api/meta 里没有这个字段）按"允许"处理，行为与改动前一致。
     */
    allowGuests: true,
    /** 游客通道关闭时的提示文案（与 server/index.js 的 GUEST_DISABLED_MESSAGE 逐字一致） */
    GUEST_OFF_HINT: '本服务器已关闭游客登录，请注册账号或使用已有账号登录',

    init(meta, options = {}) {
      UI.meta = meta;
      UI.onReady = options.onReady || (() => {});
      /**
       * **每一步各自兜住**：以前这里是平铺的一串调用，任何一步抛错（例如某块面板的节点不在、
       * 某个模块还没就绪）都会把**后面的步骤一起带走** —— 最典型的后果就是
       * `initTransitDrag` 出错 → `initPanelResize` 根本没跑 → 四块面板的高度拖柄集体失效、
       * 页面上却看不出任何原因。现在单步失败只在错误条里留一行中文，其余步骤照常完成。
       */
      const step = (name, fn) => {
        try { return fn(); } catch (err) { return UI.noteInitError(name, err); }
      };
      step('界面提示', () => UI.installHintTitles()); // 提示并进状态条后是"单行 + 省略号"：完整文字挂到 title 上
      step('游客登录开关', () => UI.applyGuestPolicy(meta)); // 关掉游客登录时藏起那个按钮（服务端也不认）
      step('静态说明「?」', () => UI.initStaticHelp()); // index.html 里 data-help 的那些「?」：点一下展开说明弹层
      step('分色方式钩子', () => UI.installTransitColorSchemes()); // 先给渲染层装上钩子（子选项行 / 图例跟着方案重画）
      step('编辑工具', () => UI.renderTools());
      step('图层与显示模式状态', () => UI.initLayerModes()); // 先恢复图层/显示模式状态，再渲染面板
      step('图层表', () => UI.renderLayers());
      step('事件接线', () => UI.bind());
      step('面板折叠', () => UI.initPanels());
      step('图层面板展开状态', () => UI.initLayersPanel()); // 它住在左栏第二块
      step('右栏', () => UI.initRightRail()); // 右栏与交通公司窗口**并存**：开关交通窗口绝不藏右栏
      step('交通窗口拖动', () => UI.initTransitDrag());
      step('面板高度拖柄', () => UI.initPanelResize());     // 四块带拖柄的面板（左栏两块 + 右栏两块）：拖底边改高度（记在 localStorage）
      step('管理器窗口尺寸', () => UI.initMgrWinResize());  // 独立管理器窗口（.tmgr-win）：双向可缩放 + 尺寸记忆
      step('轨交筛选接线', () => UI.installTransitView());
      step('状态栏', () => UI.updateStatus());
      return UI;
    },

    /**
     * 界面初始化某一步失败：写成一行中文进 #client-errors（与 main.js 的 reportClientError 同一处），
     * **不打断后面的步骤**。正常情况下一行都不会出现 —— 只有真的出错时才有内容。
     */
    noteInitError(step, err) {
      const text = `界面「${step}」初始化失败：${err && err.message ? err.message : String(err)}`;
      try { console.error('[ui]', text); } catch { /* ignore */ }
      const box = util.$('#client-errors');
      if (box) {
        const line = document.createElement('div');
        line.textContent = text;
        box.appendChild(line);
        box.classList.remove('hidden');
      }
      return null;
    },

    /**
     * 接上渲染层的「分色方式」（轨交 / 公交模式下面那一行子选项 + 它下面那一格图例）。
     *
     * **不再**把三个分色 id 塞进 UI.MODES —— 它们不是显示模式（以前会渲染成第 6/7/8 个模式芯片，
     * 那是错的）：显示模式只有 MODES 里那五个；分色是独立的一条轴，只在轨交 / 公交模式下露出
     * 那一行子选项（见 renderColorSchemeRow / selectTransitColorScheme）。
     * 这里只做一件事：给渲染层装钩子 —— 从别处（旧别名、交通面板、自检脚本）改了方案时，
     * 子选项行的高亮与图例跟着重画。拿不到 render.js 时什么也不做（面板有 TRANSIT_COLOR_FALLBACK 兜底）。
     */
    installTransitColorSchemes() {
      if (!Render || typeof Render !== 'object') return UI.TRANSIT_COLOR_MODES;
      Render.onTransitColorScheme = (scheme) => {
        // 急停（2026-09-20）：这里原来同时调 renderColorSchemeRow + renderLegend，
        // 而这两者都会整块重建显示模式那一棵树 → 与 setTransitColorScheme 形成递归/风暴。
        // 改为只更新状态提示，树与图例由显式点击路径（selectTransitColorScheme）负责重画。
        const name = (typeof Render.transitColorSchemeName === 'function' && Render.transitColorSchemeName(scheme)) || scheme;
        util.statusHint(`分色方式：${name}`);
      };
      return UI.TRANSIT_COLOR_MODES;
    },

    /**
     * 状态条最右边那一格是"单行、超出省略号"（提示不再有浮在地图上的提示框）。
     * 这里把完整文字同步挂到 title 上：被截断时鼠标停一下就能看全。
     */
    installHintTitles() {
      if (util.__hintTitlesInstalled) return;
      util.__hintTitlesInstalled = true;
      const wrap = (name, id) => {
        const orig = util[name];
        if (typeof orig !== 'function') return;
        util[name] = function (text) {
          const out = orig.apply(util, arguments);
          const box = util.$('#' + id);
          if (box) box.title = String(text == null ? '' : text).replace(/<[^>]*>/g, '');
          return out;
        };
      };
      wrap('statusHint', 'status-hint');
      wrap('hint', 'hint');
    },

    /* ------------------------------ 面板折叠 ------------------------------ */
    /** 从 localStorage 恢复折叠状态，并给标题栏的折叠按钮接上线 */
    initPanels() {
      for (const name of Object.keys(UI.PANEL_KEYS)) {
        const el = util.$('#' + name);
        if (!el) continue;
        UI.applyPanelCollapsed(name, !!util.storage.get(UI.PANEL_KEYS[name], false));
        const btn = util.$('#' + name + '-collapse');
        if (btn) btn.onclick = () => UI.togglePanelCollapsed(name);
      }
    },

    /** 应用折叠状态；on === undefined 时沿用当前记住的状态（面板被重新打开时用） */
    applyPanelCollapsed(name, on) {
      const el = util.$('#' + name);
      if (!el || !(name in UI.PANEL_KEYS)) return;
      const collapsed = on === undefined ? !!UI.collapsed[name] : !!on;
      UI.collapsed[name] = collapsed;
      el.classList.toggle('panel-collapsed', collapsed);
      const btn = util.$('#' + name + '-collapse');
      if (btn) {
        const title = UI.PANEL_TITLES[name] || name;
        // 更窄的栏位（COMPACT_TOGGLES）里只写得下一个箭头，完整说法一律放 title 上
        const compact = !!UI.COMPACT_TOGGLES[name];
        btn.textContent = compact
          ? (collapsed ? '▸' : '▾')
          : (collapsed ? '▸ 展开' : '▾ 折叠');
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.title = (collapsed ? '展开' : '折叠') + title + '（折叠状态会记住）';
      }
      // 图层面板的展开状态与这一份记忆是同一个值（setLayersOpen / LAYERS_OPEN_KEY）
      if (name === 'layers') UI.layersOpen = !collapsed;
    },

    setPanelCollapsed(name, on, persist) {
      UI.applyPanelCollapsed(name, on);
      if (persist !== false && UI.PANEL_KEYS[name]) util.storage.set(UI.PANEL_KEYS[name], !!on);
      // 图层这一块的两个写法共用一份记忆：折叠按钮与 setLayersOpen 都得记住
      if (persist !== false && name === 'layers') util.storage.set(UI.LAYERS_OPEN_KEY, !on);
    },

    togglePanelCollapsed(name) {
      UI.setPanelCollapsed(name, !UI.collapsed[name]);
      util.statusHint(`${UI.PANEL_TITLES[name] || name}已${UI.collapsed[name] ? '折叠' : '展开'}`);
    },

    isPanelCollapsed(name) { return !!UI.collapsed[name]; },

    /* ------------------------------------------------------------------
       界面重排：左侧一列（编辑工具 → 工具选项 → 图层与显示模式）+ 右侧栏（属性检查器）
       ------------------------------------------------------------------ */

    /**
     * 「图层与显示模式」是左栏的第三块，紧贴在「工具选项」下面（用户要求的顺序）。
     * 它自己带一个折叠按钮（#layers-collapse，ui.js 的 initPanels 接线），
     * 这里只负责启动时按存档恢复那一块的展开 / 收起状态。
     * 旧键（抽屉时代默认"收起"）清掉，免得一上来就缩着。
     */
    initLayersPanel() {
      util.storage.del('osmcity.panel.layersOpen');
      UI.setLayersOpen(!!util.storage.get(UI.LAYERS_OPEN_KEY, true), false);
    },

    /** 开 / 收图层面板（= 左栏第三块的展开 / 折叠；persist === false 用于启动时按存档恢复） */
    setLayersOpen(on, persist) {
      UI.layersOpen = !!on;
      UI.setPanelCollapsed('layers', !UI.layersOpen, false);
      if (persist !== false) {
        util.storage.set(UI.LAYERS_OPEN_KEY, UI.layersOpen);
        util.storage.set(UI.PANEL_KEYS.layers, !UI.layersOpen);
      }
      // 展开时滚进视野（左栏内容超过一屏时会整列滚动）
      const panel = util.$('#layers');
      if (UI.layersOpen && panel && typeof panel.scrollIntoView === 'function') {
        panel.scrollIntoView({ block: 'nearest' });
      }
    },

    isLayersOpen() { return !!UI.layersOpen; },

    /**
     * 交通公司窗口与右栏（#inspector 属性检查器 + #toolopts 工具选项）**并存**。
     *
     * 用户明令：**打开「交通公司」面板时，禁止关闭 / 隐藏右侧面板**。所以这里的原则是
     * "交通窗口只管它自己"：
     *   · **不**给 #inspector / #toolopts 加 .hidden（transit.js 自己的 openPanel 会给 #inspector
     *     加一个 —— 那是它面板独占一排的老规矩，本文件不能改 transit.js，所以在它之后**立刻摘掉**：
     *     加与摘在同一个任务里同步完成，浏览器不会有一次绘制，看不到闪动）；
     *   · **不**碰它们的宽度 / 高度 / 位移（内联 height 只由玩家拖 .panel-grip 时写）；
     *   · **不**动它们的滚动位置（调用前后把容器的 scrollTop 原样还原，见 captureRailState）；
     *   · **不**碰折叠状态（.panel-collapsed 只由面板自己的折叠按钮 / 存档说话）。
     *
     * 交通面板本身是**浮动窗口**：CSS 默认停在**右栏左边**（right = 右栏宽 + 20px），
     * 不压住右栏；玩家拖动过就完全按 localStorage 的 osmcity.panel.transitPos 来
     * （restoreTransitPos / initTransitDrag），位置重叠时靠玩家拖动解决，绝不自动藏任何面板。
     * 左栏（#toolbox 编辑工具 + #layers 图层与显示模式）同样不参与这套逻辑，也不会被藏。
     * 管理器窗口（.tmgr-win / #linemgr 的 .lm-win）本来就 `position: fixed` 浮在地图上，
     * 与右栏 / 图层 / 工具选项同时显示 —— 这里只给它们挂尺寸拖柄，不动任何面板。
     */
    initRightRail() {
      const T = Transit || (window.G && window.G.Transit);
      UI.keepRightRailVisible();
      // 兜底（用户的要求是"禁止"，不是"尽量"）：不经过 openPanel / closePanel 的代码路径
      // 万一把 .hidden 加到这几块上，class 一变就立刻摘掉。MutationObserver 的回调是微任务，
      // 在下一帧绘制之前就跑完，所以看不到闪动；摘掉之后没有新的 mutation，不会自己转圈。
      // 急停（2026-09-20）：这个观察者与 transit.js 的 openPanel 会互相改同一批 class，
      // 形成微任务风暴把页面卡死（浏览器报 "this page is slowing browser"）。
      // 保底逻辑保留：keepRightRailVisible() 仍在 openPanel/closePanel 之后显式调用一次。
      if (false && typeof MutationObserver === 'function' && !UI._railHiddenGuard) {
        UI._railHiddenGuard = new MutationObserver(() => UI.keepRightRailVisible());
        for (const id of ['rightcol', 'inspector', 'toolopts']) {
          const el = util.$('#' + id);
          if (el) UI._railHiddenGuard.observe(el, { attributes: true, attributeFilter: ['class'] });
        }
      }
      if (!T || T._uiRightRailPatched) return;
      T._uiRightRailPatched = true;
      for (const name of ['openPanel', 'closePanel']) {
        const orig = T[name];
        if (typeof orig !== 'function') continue;
        T[name] = function uiKeepRightRail() {
          const kept = UI.captureRailState();     // 开关之前先记下"该显示 / 滚到哪儿"
          const out = orig.apply(this, arguments);
          UI.restoreRailState(kept);              // 之后原样还回去（只摘 .hidden，不加）
          return out;
        };
      }
    },

    /** 右栏每一块（含整条容器）此刻的滚动位置；restoreRailState 用它原样还回去 */
    captureRailState() {
      const out = [];
      for (const id of ['rightcol', 'inspector', 'toolopts']) {
        const el = util.$('#' + id);
        if (!el) continue;
        const body = el.querySelector('.panel-body');
        out.push({
          el,
          scrollTop: el.scrollTop || 0,
          body,
          bodyTop: body ? (body.scrollTop || 0) : 0,
        });
      }
      return out;
    },

    /**
     * 把右栏恢复成"该显示就显示、滚动位置一寸不动"：
     * 只**摘掉**别人加的 .hidden（绝不在任何地方自己加），宽高 / 位移 / 折叠状态一概不碰。
     */
    restoreRailState(kept) {
      for (const item of kept || []) {
        item.el.classList.remove('hidden');
        if (item.el.scrollTop !== item.scrollTop) item.el.scrollTop = item.scrollTop;
        if (item.body && item.body.scrollTop !== item.bodyTop) item.body.scrollTop = item.bodyTop;
      }
    },

    /** 右栏两块面板（属性检查器 / 工具选项）保持显示：启动时、交通窗口开关之后都走这里 */
    keepRightRailVisible() {
      UI.restoreRailState(UI.captureRailState());
    },

    /* ------------------------------ 交通面板：拖动标题栏 ------------------------------ */
    /**
     * 交通公司窗口默认用 CSS 定位（top 54px + right = 右栏宽 + 20px，也就是**停在右栏左边**，
     * 与右栏两块面板并存），但按住标题栏（.tp-head）就能拖到任何地方：
     * 位置写进 localStorage（osmcity.panel.transitPos），刷新后还在原处；双击标题栏回到默认位置。
     * 只有标题栏是拖手：放大 / 折叠 / 关闭按钮和面板内部的滚动都不受影响
     * （按钮上按下直接放行，一次点击 / 手抖 3px 也不算拖动）。
     * 写法与 transit.js 的 _bindMgrDrag（线路管理器窗口拖动）同一套：mousedown + document 上的
     * mousemove / mouseup，这里只多一个"移动超过 3px 才算拖动"的门槛与双击复位。
     */
    initTransitDrag() {
      const panel = util.$('#transit');
      const head = panel ? panel.querySelector('.tp-head') : null;
      if (!panel || !head || panel.dataset.dragReady === '1') return;
      panel.dataset.dragReady = '1';
      head.title = '按住这里可以把面板拖到别处；双击回到默认位置（右栏左边）';

      const onButton = (node) => !!(node && typeof node.closest === 'function'
        && node.closest('button, a, input, select, textarea, label, .tp-tab, .mini'));
      /** 上一次"点了标题栏但没拖动"的时刻：两下挨得够近就当双击 */
      let lastTap = 0;

      head.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0 && ev.button !== undefined) return;   // 只认左键
        if (onButton(ev.target)) return;                          // 按钮上的按下不算拖动
        const rect = panel.getBoundingClientRect();
        const offX = ev.clientX - rect.left;
        const offY = ev.clientY - rect.top;
        let moved = false;
        const move = (e2) => {
          // 手抖 3px 以内不算拖动：点一下标题栏不会被当成拖动
          if (!moved && Math.abs(e2.clientX - ev.clientX) + Math.abs(e2.clientY - ev.clientY) < 3) return;
          moved = true;
          panel.classList.add('dragging');
          UI.placeTransit(e2.clientX - offX, e2.clientY - offY);
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          panel.classList.remove('dragging');
          if (moved && UI._transitPos) {
            lastTap = 0;
            util.storage.set(UI.TRANSIT_POS_KEY, UI._transitPos);
            util.statusHint('交通公司面板已移到新位置（双击标题栏回到默认位置）');
            return;
          }
          // 只点了一下、没拖动：两下挨得够近（400ms 内）就是"双击标题栏" → 回到默认位置
          const now = Date.now();
          if (now - lastTap < 400) { lastTap = 0; UI.resetTransitPos(); }
          else lastTap = now;
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
      });
      // 放大 / 缩小之后面板宽度变了：重新夹一次，别让它跑出屏幕；
      // 同时处理"用户自己拖过尺寸"的情况 —— .big 是靠 CSS 宽度的布局开关，
      // 内联 width（拖柄写的）会把它压住，所以进大窗口时先让开内联尺寸（记忆还在），
      // 缩回小窗口时再把记忆套回去。
      const sizeBtn = util.$('#transit-size');
      if (sizeBtn) sizeBtn.addEventListener('click', () => setTimeout(() => {
        const box = util.$('#transit');
        if (box) {
          if (box.classList.contains('big')) UI.clearTransitInlineSize();
          else UI.restoreTransitSize();
        }
        UI.reclampTransit();
      }, 0));
      window.addEventListener('resize', () => UI.reclampTransit());
      UI.restoreTransitPos();
      UI.initTransitSize();          // 右边缘 / 下边缘 / 右下角：双向改尺寸（记在 localStorage）
    },

    /** 把交通面板放到 (left, top)：固定定位，先把 CSS 的 right 让开（否则两边会打架） */
    placeTransit(left, top) {
      const box = util.$('#transit');
      if (!box) return null;
      const pos = UI.clampTransitPos(left, top, box);
      box.style.left = pos.left + 'px';
      box.style.top = pos.top + 'px';
      box.style.right = 'auto';
      // 高度上限跟着新位置走：拖到下面时内容自动压缩，整块面板始终留在视口里。
      // **用户自己拖过尺寸（.sized）的窗口一律让开上限**（写成 none）：内联 height 才是玩家拖出来的结果，
      // 被 CSS 的 calc(100vh - 300px) 或这条上限压回去的话，就成了"拖了没用"。
      const cap = Math.max(96, window.innerHeight - pos.top - 34);
      box.style.maxHeight = box.classList.contains('sized')
        ? 'none'
        : Math.min(cap, Math.max(96, window.innerHeight - 300)) + 'px';
      UI._transitPos = pos;
      return pos;
    },

    /** 夹进视口：左右各留 4px，顶部不越过顶栏，底部至少留得下 150px 面板（标题栏 + 一排页签） */
    clampTransitPos(left, top, panel) {
      const box = panel || util.$('#transit');
      const w = (box && box.offsetWidth) || 430;   // 面板默认 430px 宽（transit.js 注入的样式）
      const minX = 4;
      const maxX = Math.max(minX, window.innerWidth - w - 4);
      const minY = 48;
      const maxY = Math.max(minY, window.innerHeight - 150);
      return {
        left: Math.round(Math.min(Math.max(left, minX), maxX)),
        top: Math.round(Math.min(Math.max(top, minY), maxY)),
      };
    },

    /** 从 localStorage 恢复上次拖到的位置（脏数据 / 旧格式一律忽略，保持 CSS 的默认位置） */
    restoreTransitPos() {
      const saved = util.storage.get(UI.TRANSIT_POS_KEY, null);
      if (!saved || typeof saved !== 'object') return false;
      const left = Number(saved.left);
      const top = Number(saved.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
      UI.placeTransit(left, top);
      return true;
    },

    /** 窗口尺寸 / 面板宽度变了：把记住的位置重新夹回视野内（拖过尺寸的窗口顺带把高度夹回屏幕内） */
    reclampTransit() {
      const box = util.$('#transit');
      if (box && box.style.height && box.classList.contains('sized')) {
        const maxH = Math.max(UI.WIN_MIN.h, (window.innerHeight || 720) - 54 - UI.WIN_MARGIN);
        if (box.getBoundingClientRect().height > maxH) box.style.height = Math.round(maxH) + 'px';
      }
      if (!UI._transitPos) return;
      UI.placeTransit(UI._transitPos.left, UI._transitPos.top);
    },

    /** 双击标题栏：清掉记住的位置，回到 CSS 的默认状态（停在右栏左边） */
    resetTransitPos() {
      const box = util.$('#transit');
      if (box) {
        box.style.left = '';
        box.style.top = '';
        box.style.right = '';
        box.style.maxHeight = '';
      }
      UI._transitPos = null;
      util.storage.del(UI.TRANSIT_POS_KEY);
      // 拖过尺寸的面板（.sized）回到默认位置后，高度上限照旧让开 —— 内联 height 是玩家拖出来的结果，
      // 被 100vh-300px 的老上限压回去就成了"拖了没用"
      if (box && box.classList.contains('sized')) {
        box.style.maxHeight = 'none';
      }
      util.statusHint('交通公司窗口已回到默认位置（右栏左边、可再拖动）');
    },

    /* ==================================================================
       尺寸：拖动边缘 / 底边改大小，一律记在 localStorage
       ==================================================================
       - 四块带拖柄的面板（左栏的 #toolbox / #layers 与右栏的 #inspector / #toolopts）：**只改高度**，
         拖柄是面板底边那条 14px 的 .panel-grip（见 app.css 的 .panel-grip）。默认「内容多高就多高」
         （CSS 是 height: auto + max-height），只有用户拖过之后才写死像素高；
         双击拖柄（或键盘 ↑/↓ 微调后双击）清掉记忆、回到自适应。
         左栏那两块原本共用 #toolbar 一条滚动条（拖多高都被整列的上限压着），现在各自是独立面板：
         拖过高度的那个加 .panel-sized → CSS 里 flex-shrink: 0，**内联高度绝不缩回**。
       - 交通公司面板（#transit）：右边缘拖宽、下边缘拖高、右下角同时改；
         尺寸记在 osmcity.panel.transitSize。
       - 独立管理器窗口（.tmgr-win，transit.js 懒创建）：右边缘 / 下边缘两条 JS 拖柄，
         **右下角 18×18 让给它自己的原生 resize: both 握把**（两条路都能用）；
         不管从哪条路改的尺寸，ResizeObserver 都会把 w/h 合并回
         osmcity.transit.mgrWin.<key>（与 transit.js 写的 left/top 同一个对象）。
       ================================================================== */

    /** 一屏之内允许的最大尺寸（拖柄的钳制与恢复都走这里，保证拖不出屏幕） */
    sizeCaps() {
      const vw = Math.max(360, window.innerWidth || 1024);
      const vh = Math.max(320, window.innerHeight || 720);
      return {
        maxW: Math.max(320, vw - UI.WIN_MARGIN),
        maxH: Math.max(240, vh - UI.WIN_MARGIN),
      };
    },

    /** 右栏一块面板的高度上限：视口高的 86%，再高就顶出屏幕了 */
    panelHeightCap() {
      return Math.max(160, Math.round((window.innerHeight || 720) * 0.86));
    },

    /**
     * **拖动时**一块面板能被拖到的最大高度。
     *
     * 右栏（#rightcol）与其他面板：视口 86%（panelHeightCap）。
     * 左栏（#toolbar）里另算 —— 一列的可用高度是固定的（CSS 的 --rail-h：宽 >1200px 时停在左下
     * 「协作频道」上面），两块面板抢这一份高度：上限 = 整列可用高度 − 两块之间的缝 − 另一块的下限（72px）。
     * 拖到这儿整列**刚好放下**（拖大的那块按内联高度、另一块让位到 72px），
     * 拖柄因此一直留在手边；不然往下拖只会把整列拖出滚动条、把自己这块的拖柄顶到屏幕外面，
     * 想拖回来都抓不到（就是"高度拖柄好像没用"的另一半）。
     * 拖动结束后真正写进 localStorage 的仍是整数值，下次刷新按 osmcity.panel.h.<名字> 原样恢复。
     */
    panelDragMax(name) {
      const cap = UI.panelHeightCap();
      const panel = util.$('#' + name);
      const rail = panel && panel.parentElement;
      if (!rail || rail.id !== 'toolbar') return cap;
      const win = window;
      if (typeof win.getComputedStyle !== 'function') return cap;
      const cs = win.getComputedStyle(rail);
      const railMax = parseFloat(cs.maxHeight);          // --rail-h 已经解析成像素（none → NaN）
      if (!Number.isFinite(railMax) || railMax <= 0) return cap;
      const gap = parseFloat(cs.rowGap || cs.gap) || 0;
      const minSibling = 72;                             // .rc-panel 的 min-height（app.css 第 8 节）
      return Math.max(UI.PANEL_H_MIN[name] || 80, Math.min(cap, Math.round(railMax - gap - minSibling)));
    },

    /**
     * 通用拖柄：node 是抓手，target 是被改大小的盒子，edge 决定改哪个方向：
     *   'x' 只改宽、'y' 只改高、'xy' 两个都改（右下角）。
     * 拖动期间只写内联 width / height（用 rect 的起始值 + 鼠标位移，不做 transform，
     * 免得 getBoundingClientRect 一边拖一边飘）；松手时 done(w, h) 去持久化。
     * 移动不到 2px 不算拖动（点一下抓手不会白写一次 localStorage）。
     * opts.onDragStart()：**真的开始拖**（位移过 2px）的那一刻回调一次，用来先把挡路的东西让开 ——
     * 面板高度拖柄用它提前加 .panel-sized 并让开 CSS 的默认上限（见 initPanelResize 与 app.css 第 7 节）：
     * 只等到松手才让开的话，拖动过程中内联高度会被 CSS 上限和 flex 一起压回去，画面上纹丝不动，
     * 松手后才"跳"一下 —— 看起来还是"拖了没反应"。
     */
    bindEdgeDrag(node, target, edge, opts = {}) {
      if (!node || !target || node.dataset.edgeReady === '1') return;
      node.dataset.edgeReady = '1';
      node.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0 && ev.button !== undefined) return;   // 只认左键
        const rect = target.getBoundingClientRect();
        const startX = ev.clientX;
        const startY = ev.clientY;
        const caps = UI.sizeCaps();
        const minW = Math.max(80, Number(opts.minW) || 120);
        const minH = Math.max(60, Number(opts.minH) || 80);
        const maxW = Math.min(caps.maxW, Number(opts.maxW) || caps.maxW);
        const maxH = Math.min(caps.maxH, Number(opts.maxH) || caps.maxH);
        let w = rect.width;
        let h = rect.height;
        let moved = false;
        const move = (e2) => {
          const dx = e2.clientX - startX;
          const dy = e2.clientY - startY;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;   // 手抖不算拖
          if (!moved && typeof opts.onDragStart === 'function') opts.onDragStart();
          moved = true;
          node.classList.add('dragging');
          target.classList.add('resizing');
          if (edge !== 'y') w = Math.min(Math.max(rect.width + dx, minW), maxW);
          if (edge !== 'x') h = Math.min(Math.max(rect.height + dy, minH), maxH);
          if (edge !== 'y') target.style.width = Math.round(w) + 'px';
          if (edge !== 'x') target.style.height = Math.round(h) + 'px';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          node.classList.remove('dragging');
          target.classList.remove('resizing');
          if (moved && typeof opts.done === 'function') opts.done(Math.round(w), Math.round(h));
          if (typeof opts.after === 'function') opts.after(moved);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
      });
    },

    /* --------------- 四块带拖柄的面板（左栏 #toolbox / #layers、右栏 #inspector / #toolopts）：拖底边改高度 --------------- */
    /**
     * **拖出来的高度必须真的说了算** —— 这是"高度拖柄好像没用"的根因所在。
     *
     * 接线本身是对的（bindEdgeDrag 会把内联 height 与 osmcity.panel.h.<名字> 都写上），
     * 但 app.css 给每一块都配了一条默认上限（右栏的 --inspector-max-h: 48vh / --toolopts-max-h: 42vh；
     * 左栏的 --toolbox-max-h / --layers-max-h 是从 --rail-h 算出来的、跟视口走的 calc()），
     * 而 CSS 里 **max-height 的优先级高于 height**：
     * 面板内容一旦超过这条上限（属性检查器有一整张标签表、图层与显示模式有 12 类 + 5 个模式 + 子项，
     * 在 900px 高的窗口里 48vh 只有 432px，几乎必然超过），拖到底边往下拉时
     * 内联 height 写成了 700px，画面上却仍然是 432px —— 看起来就是"拖了毫无反应"；
     * 刷新后从 osmcity.panel.h.* 恢复的高度同样会被当场压回去（存档形同虚设）。
     *
     * 所以：只要一块面板的高度是**用户给的**（拖动 / 键盘 / 从存档恢复），就把它的 max-height 让开，
     * 真正的高度上限交给 panelHeightCap()（视口 86%）在 JS 里钳制；
     * 左栏那两块还多一层：.panel-sized 在 CSS 里带 flex-shrink: 0（见 app.css 第 7 节），
     * 否则整列一超限，flex 会把拖出来的高度原地缩回去 —— 又是"拖了没反应"。
     * 双击拖柄（clearPanelHeight）时再把默认上限还回去。
     */
    liftPanelHeightCap(panel) {
      if (!panel) return;
      panel.style.maxHeight = 'none';
      panel.classList.add('panel-sized');
      UI.syncRailSized(panel);
    },

    /**
     * 左栏（#toolbar）里只要**有一块**是"用户拖过高度的"（.panel-sized），就给整列加 .has-sized。
     *
     * 为什么需要它：左栏一列的可用高度是固定的（--rail-h，见 app.css 第 7 节），两块面板抢这一份高度。
     * 如果两块都不许缩（老代码的 `#toolbar > * { flex: 0 0 auto }`），用户往下拖只会把整列拖出滚动条，
     * 拖出来的那块自己的拖柄还会被顶到屏幕外面（想拖回来都抓不到）。
     * 所以默认只许 #layers 缩（编辑工具一点不被压扁）；**一旦有人拖过高度**，
     * 就放开编辑工具的 flex-shrink —— 拖大的那块按内联 height 说话，让位的是另一块
     * （缩到 .rc-panel 的 72px 下限为止），拖柄始终留在手边、整列也不溢出。
     */
    syncRailSized(panel) {
      const rail = panel && panel.parentElement;
      if (!rail || rail.id !== 'toolbar') return;
      const anySized = Array.prototype.some.call(
        rail.children, (el) => !!el.classList && el.classList.contains('panel-sized'));
      rail.classList.toggle('has-sized', anySized);
    },

    /** 从 localStorage 恢复一块面板的高度（没有记忆 / 脏数据 = 不写内联高度，回到"内容多高就多高"） */
    applyPanelHeight(name) {
      const panel = util.$('#' + name);
      if (!panel) return null;
      const min = UI.PANEL_H_MIN[name] || 80;
      const saved = Number(util.storage.get(UI.PANEL_H_KEYS[name], 0));
      // 比下限还小的值一律当脏数据（老版本 / 手改 / 别的脚本留下的），别拿它去改布局
      if (!Number.isFinite(saved) || saved < min) { UI.clearPanelHeight(name); return null; }
      const h = Math.round(Math.min(saved, UI.panelHeightCap()));
      panel.style.height = h + 'px';
      UI.liftPanelHeightCap(panel);
      return h;
    },

    /** 写死一块面板的高度（拖柄途中 / 松手时；persist 才写 localStorage） */
    setPanelHeight(name, h, persist) {
      const panel = util.$('#' + name);
      if (!panel || !UI.PANEL_H_KEYS[name]) return null;
      const min = UI.PANEL_H_MIN[name] || 80;
      const hh = Math.round(Math.min(Math.max(Number(h) || min, min), UI.panelHeightCap()));
      panel.style.height = hh + 'px';
      UI.liftPanelHeightCap(panel);   // ← 少了这一句，CSS 的 max-height 会把它原地压回默认上限
      if (persist !== false) util.storage.set(UI.PANEL_H_KEYS[name], hh);
      return hh;
    },

    /** 忘掉一块面板的高度（双击拖柄 / 存档是脏数据）：回到"内容多高就多高"，并把 CSS 的默认上限还回去 */
    clearPanelHeight(name) {
      const panel = util.$('#' + name);
      if (!panel) return;
      panel.style.height = '';
      panel.style.maxHeight = '';
      panel.classList.remove('panel-sized');
      UI.syncRailSized(panel);      // 左栏两块都没拖过高度时，.has-sized 撤掉（编辑工具回到"一点不缩"）
    },

    /** 双击拖柄：忘掉这块面板的高度，回到"内容多高就多高" */
    resetPanelHeight(name) {
      UI.clearPanelHeight(name);
      util.storage.del(UI.PANEL_H_KEYS[name]);
      util.statusHint(`${UI.PANEL_TITLES[name] || name}的高度已恢复「内容多高就多高」`);
    },

    /** 窗口变矮时把四块面板拖过的高度夹回视口内（记忆本身不动，放大窗口后还会回来） */
    clampPanelHeights() {
      for (const name of Object.keys(UI.PANEL_H_KEYS)) {
        const panel = util.$('#' + name);
        if (!panel || !panel.style.height) continue;
        const cap = UI.panelHeightCap();
        const cur = panel.getBoundingClientRect().height;
        if (cur > cap + 1) panel.style.height = Math.round(cap) + 'px';
      }
    },

    /**
     * 拿到一块面板底边的高度拖柄；**没有就地补一个**。
     * 拖柄在 index.html 里本来是静态节点，但只要它缺了（旧 HTML / 被别的代码清掉 / 面板是后建的），
     * 原来的写法就是 `if (!grip) continue;` —— 整块面板静默失去拖柄，页面上看不出任何异常。
     */
    ensurePanelGrip(name, panel) {
      const box = panel || util.$('#' + name);
      if (!box) return null;
      const existing = box.querySelector('.panel-grip');
      if (existing) return existing;
      const grip = util.el('div', 'panel-grip');
      grip.dataset.grip = name;
      grip.setAttribute('role', 'separator');
      grip.setAttribute('aria-orientation', 'horizontal');
      grip.tabIndex = 0;
      grip.title = `按住上下拖动：调整${UI.PANEL_TITLES[name] || name}的高度；`
        + '双击恢复「内容多高就多高」（高度记在浏览器里）';
      box.appendChild(grip);
      return grip;
    },

    /** 四块面板的高度拖柄（接线见 app.css 的 .panel-grip）：左栏的 #toolbox / #layers、右栏的 #inspector / #toolopts */
    initPanelResize() {
      for (const name of Object.keys(UI.PANEL_H_KEYS)) {
        const panel = util.$('#' + name);
        if (!panel) continue;
        UI.applyPanelHeight(name);      // 恢复上次拖出来的高度（没有就自适应）
        const grip = UI.ensurePanelGrip(name, panel);
        if (!grip) continue;
        const title = UI.PANEL_TITLES[name] || name;
        grip.setAttribute('aria-label', `调整${title}的高度（上下拖动；双击恢复自适应高度）`);
        // 双击拖柄 = 忘掉高度，回到"内容多高就多高"
        grip.addEventListener('dblclick', (ev) => {
          if (ev && ev.preventDefault) ev.preventDefault();
          UI.resetPanelHeight(name);
        });
        // 键盘也能调（拖柄 tabindex="0"）：↑ 变矮、↓ 变高，每次 24px
        // （上限同拖动：左栏里夹到"整列刚好放得下"，别把自己的拖柄顶到屏幕外面）
        grip.addEventListener('keydown', (ev) => {
          if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
          ev.preventDefault();
          const cur = panel.getBoundingClientRect().height;
          const max = UI.panelDragMax(name);
          const next = ev.key === 'ArrowDown' ? Math.min(cur + 24, max) : cur - 24;
          UI.setPanelHeight(name, next, true);
        });
        // bindEdgeDrag 自带"只接一次"（dataset.edgeReady）：重复跑 initPanelResize 不会接两遍
        UI.bindEdgeDrag(grip, panel, 'y', {
          minH: UI.PANEL_H_MIN[name] || 80,
          maxH: UI.panelDragMax(name),
          // 真的开始拖的那一刻就让开默认上限（+ .panel-sized / 左栏的 .has-sized）：
          // 否则拖动期间高度会被 CSS 上限和 flex 压住，画面上不动、松手才跳一下
          onDragStart: () => UI.liftPanelHeightCap(panel),
          done: (w, h) => {
            UI.setPanelHeight(name, h, true);
            const shown = Math.round(panel.getBoundingClientRect().height);
            util.statusHint(`${title}高度 ${shown}px（拖动底边可再改，双击恢复自适应高度）`);
          },
        });
      }
      // 浏览器窗口变矮时，把用户拖过的高度夹回视口内（记忆本身不动，窗口放大后还会回来）
      window.addEventListener('resize', () => UI.clampPanelHeights());
    },

    /* --------------------- 交通公司面板：右 / 下 / 右下角 --------------------- */
    /**
     * 交通公司窗口的三条尺寸拖柄（右 / 下 / 右下角）。
     * 这里**不写 `if (box.querySelector('.win-grip')) return;`** 那种"有就整块跳过"：
     * 只要缺了任意一条（面板被重建 / 只挂上了其中一条），原来就会连**别的**拖柄与尺寸恢复一起跳过。
     * 现在逐条 ensure（同名的已存在就复用），缺哪条补哪条。
     */
    initTransitSize() {
      const box = util.$('#transit');
      if (!box) return;
      UI.restoreTransitSize();
      const strip = (cls, edge, hint) => {
        let el = box.querySelector('.win-grip.' + cls);
        if (el) return el;
        el = util.el('div', 'win-grip ' + cls);
        el.title = hint + '（记在浏览器里；双击右下角恢复默认尺寸）';
        box.appendChild(el);
        UI.bindEdgeDrag(el, box, edge, {
          minW: UI.WIN_MIN.w, minH: UI.WIN_MIN.h,
          done: () => UI.saveTransitSize(),
        });
        return el;
      };
      strip('right', 'x', '左右拖动：调整交通公司面板的宽度');
      strip('bottom', 'y', '上下拖动：调整交通公司面板的高度');
      // 右下角：一次改宽高；双击回到默认尺寸
      const corner = strip('corner', 'xy', '拖动右下角：同时调整宽高');
      if (corner && corner.dataset.dblReady !== '1') {
        corner.dataset.dblReady = '1';
        corner.addEventListener('dblclick', (ev) => {
          if (ev && ev.preventDefault) ev.preventDefault();
          UI.resetTransitSize();
        });
      }
      box.dataset.sizeReady = '1';
    },

    /** 记住交通公司面板的尺寸（拖柄松手时调用） */
    saveTransitSize() {
      const box = util.$('#transit');
      if (!box) return null;
      const r = box.getBoundingClientRect();
      if (!(r.width > 4) || !(r.height > 4)) return null;
      const size = { w: Math.round(r.width), h: Math.round(r.height) };
      box.classList.add('sized');
      // 拖过尺寸 = 内联宽高说了算：把 CSS 的高度上限（#transit 的 calc(100vh - 300px)）让开，
      // 否则拖到 700px 画面上还是 600px（"拖不高"）。真正的上限由 sizeCaps() 在 JS 里钳制。
      box.style.maxHeight = 'none';
      util.storage.set(UI.TRANSIT_SIZE_KEY, size);
      util.statusHint(`交通公司面板 ${size.w} × ${size.h}（右边缘 / 下边缘 / 右下角都能拖，双击右下角恢复默认）`);
      return size;
    },

    /** 恢复上次拖出来的尺寸（没有记忆 / 脏数据就不写内联尺寸，回到 CSS 默认：宽 340px、高度随内容） */
    restoreTransitSize() {
      const box = util.$('#transit');
      const saved = util.storage.get(UI.TRANSIT_SIZE_KEY, null);
      if (!box || !saved || typeof saved !== 'object') return null;
      const caps = UI.sizeCaps();
      const w = Number(saved.w);
      const h = Number(saved.h);
      // 小于拖柄下限（260×170）的宽高一律当脏数据丢掉，别拿它去改面板尺寸
      const useW = Number.isFinite(w) && w >= UI.WIN_MIN.w - 1;
      const useH = Number.isFinite(h) && h >= UI.WIN_MIN.h - 1;
      if (!useW && !useH) return null;
      // 宽度上限比面板自己的 CSS 上限（.big = min(1180px, 94vw)）再收一点，别横穿整屏
      const maxW = Math.min(caps.maxW, Math.round((window.innerWidth || 1024) * 0.94));
      if (useW) box.style.width = Math.round(Math.min(w, maxW)) + 'px';
      if (useH) box.style.height = Math.round(Math.min(h, caps.maxH)) + 'px';
      box.classList.add('sized');
      // 恢复出来的尺寸同样要让开 CSS 的高度上限（否则存了个 700px，刷新回来还是 600px）
      box.style.maxHeight = 'none';
      return { w: useW ? Math.round(w) : null, h: useH ? Math.round(h) : null };
    },

    /** 双击右下角：忘掉尺寸记忆，回到默认（宽 340px / 高度随内容） */
    resetTransitSize() {
      const box = util.$('#transit');
      if (box) {
        box.style.width = '';
        box.style.height = '';
        box.classList.remove('sized');
        box.style.maxHeight = '';
      }
      util.storage.del(UI.TRANSIT_SIZE_KEY);
      util.statusHint('交通公司面板已恢复默认尺寸（宽 340px，高度随内容）');
      UI.reclampTransit();
    },

    /** 进「放大」布局时让开内联尺寸（记忆留着，缩回小面板时再套上） */
    clearTransitInlineSize() {
      const box = util.$('#transit');
      if (!box) return;
      box.style.width = '';
      box.style.height = '';
      box.classList.remove('sized');
      box.style.maxHeight = '';
    },

    /* --------------------- 独立管理器窗口（.tmgr-win） --------------------- */
    /**
     * transit.js 的管理器窗口是**懒创建**的（第一次 open 才建 DOM，关掉只是加 .hidden），
     * 所以这里先扫一遍已有的窗口，再用 MutationObserver 盯着 body：
     * 新窗口一出现就挂上拖柄与 ResizeObserver。
     */
    initMgrWinResize() {
      const scan = () => util.$$('.tmgr-win').forEach((win) => UI.decorateMgrWin(win));
      scan();
      // 急停（2026-09-20）：body 级 childList 观察者在管理器窗口频繁增删 DOM 时会自我触发，
      // 与上面的右栏观察者一起造成页面卡死。改为只扫一次；窗口在 open 时也会自己调用 decorate。
      if (false && typeof MutationObserver === 'function' && document.body && !UI._mgrWinObserver) {
        UI._mgrWinObserver = new MutationObserver(() => scan());
        UI._mgrWinObserver.observe(document.body, { childList: true });
      }
    },

    /** 给一个管理器窗口挂上右边缘 / 下边缘拖柄 + 尺寸变化的兜底记忆（缺哪条补哪条，重复调用无害） */
    decorateMgrWin(win) {
      if (!win) return;
      const strip = (cls, edge, hint) => {
        const existing = win.querySelector('.win-grip.' + cls);
        if (existing) return existing;
        const el = util.el('div', 'win-grip ' + cls);
        el.title = hint + '（尺寸记在浏览器里，下次打开还在；右下角也有原生握把）';
        win.appendChild(el);
        UI.bindEdgeDrag(el, win, edge, {
          minW: UI.MGR_MIN.w, minH: UI.MGR_MIN.h,
          done: () => UI.saveMgrWinSize(win),
        });
        return el;
      };
      strip('right', 'x', '左右拖动：调整这个窗口的宽度');
      strip('bottom', 'y', '上下拖动：调整这个窗口的高度');
      win.dataset.gripReady = '1';
      // 不管尺寸从哪条路变的（这两条拖柄 / 右下角的原生 resize:both / 代码），
      // 停下来 260ms 就把 w/h 合并进 osmcity.transit.mgrWin.<key>
      if (typeof ResizeObserver === 'function' && !win._gripRO) {
        let timer = 0;
        try {
          win._gripRO = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => UI.saveMgrWinSize(win), 260);
          });
          win._gripRO.observe(win);
        } catch { /* 没有 ResizeObserver 也不影响拖柄本身 */ }
      }
    },

    /** 把窗口当前的 w/h 合并进 osmcity.transit.mgrWin.<key>（transit.js 写的是同一个对象，各管一半） */
    saveMgrWinSize(win) {
      if (!win) return null;
      const key = win.dataset ? win.dataset.mgrWin : '';
      if (!key) return null;
      if (win.classList.contains('hidden')) return null;   // 关着的窗口尺寸是 0，别把记忆写坏
      const r = win.getBoundingClientRect();
      if (!(r.width > 4) || !(r.height > 4)) return null;
      const storeKey = `${UI.MGR_WIN_POS_KEY}.${key}`;
      const cur = util.storage.get(storeKey, null);
      const next = Object.assign({}, (cur && typeof cur === 'object') ? cur : {}, {
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
      util.storage.set(storeKey, next);
      return next;
    },

    /* --------------------- 顶栏时钟：暂停 / 倍速 / 跳到自定义时间 --------------------- */
    /**
     * 顶栏时钟从「一个按钮兼两职」拆成了两个独立控件：
     *   #clock-pause = 暂停 ⇄ 继续（暂停走 Transit.setSpeed(0)，再点恢复上一次的倍速）
     *   #clock-speed = 只负责展开菜单（#clock-speed 仍然是菜单触发按钮，e2e 测试点它开菜单）
     * 菜单里的档位芯片仍由 transit.js 的 renderClockMenu 出，我们只往后补一行「跳到…」，
     * 并把两个按钮的文案 / 提示按**新语义**刷新（×1 = 1 实时秒 = 1 游戏秒）。
     */
    /** 上一次运行过的倍速（暂停前的档位），暂停按钮靠它恢复 */
    _clockLastSpeed: 1,
    /** 「跳到…」的常用时刻快捷键：value 是输入框能认的文本，tomorrow = 当前天数 + 1 的 08:00 */
    CLOCK_JUMPS: [
      { label: '早晨 07:00', value: '07:00', title: '跳到当天的 07:00' },
      { label: '中午 12:00', value: '12:00', title: '跳到当天的 12:00' },
      { label: '傍晚 18:00', value: '18:00', title: '跳到当天的 18:00' },
      { label: '次日 08:00', value: 'tomorrow', title: '跳到第二天的 08:00（按绝对 clockMs 换算后发给服务端）' },
    ],

    /** 打开/收起时钟菜单（内容由 Transit.renderClockMenu 负责，我们补「跳到…」行） */
    toggleClockMenu(on) {
      if (!Transit) return false;
      if (typeof Transit.toggleClockMenu === 'function') return Transit.toggleClockMenu(on);
      util.toast('交通模块还没有就绪', 'warn', 2500);
      return false;
    },

    /** 短标签：×1 = 实时、×60 = 1 分钟（N 游戏秒 / 实时秒） */
    clockSpeedText(speed) {
      const n = Number(speed) || 0;
      if (n === 0) return '暂停';
      if (n === 1) return '实时';
      if (n % 60 === 0) return `${n / 60} 分钟`;
      return `${n} 秒`;
    },

    /** 倍速的一句话语义说明（按钮提示 / 菜单芯片提示 / 菜单说明行共用） */
    clockSpeedDetail(speed) {
      const n = Number(speed) || 0;
      if (n === 0) return '时间已暂停：1 实时秒 = 0 游戏时间';
      if (n === 1) return '×1 = 实时：1 实时秒 = 1 游戏秒';
      if (n % 60 === 0) return `×${n}：1 实时秒 = ${n / 60} 游戏分钟`;
      return `×${n}：1 实时秒 = ${n} 游戏秒`;
    },

    /** 暂停按钮：暂停 ⇄ 恢复上一次倍速（当前档位不是 0 就先记住它） */
    toggleClockPause() {
      if (!Transit || typeof Transit.setSpeed !== 'function') {
        util.toast('交通模块还没有就绪', 'warn', 2500);
        return;
      }
      const cur = typeof Transit.currentSpeed === 'function' ? Transit.currentSpeed() : 0;
      if (cur > 0) {
        UI._clockLastSpeed = cur;      // 记住暂停前的档位，供「继续」恢复
        Transit.setSpeed(0);
        return;
      }
      const list = (typeof Transit.speeds === 'function' ? Transit.speeds() : null) || [];
      let back = Number(UI._clockLastSpeed);
      if (!(back > 0) || (list.length && list.indexOf(back) < 0)) {
        back = list.find((s) => Number(s) > 0) || 1;   // 没记住 / 档位已被服务端改掉就用第一个非零档
      }
      Transit.setSpeed(back);
    },

    /**
     * 把服务端时钟状态刷到两个按钮上。transit.js 的 renderClock 只认 #clock-speed
     * （它自己写 '⏸ 暂停' / '▶ ×N'），所以这里在它之后覆盖一遍：暂停按钮的
     * 「⏸ 已暂停 / ▶ 运行中」、倍速按钮的新语义文案与提示都由这里统一出。
     */
    syncClockControls() {
      const speed = Transit && typeof Transit.currentSpeed === 'function' ? Transit.currentSpeed() : 0;
      if (speed > 0) UI._clockLastSpeed = speed;
      const pauseBtn = util.$('#clock-pause');
      if (pauseBtn) {
        const paused = speed === 0;
        const label = paused ? '⏸ 已暂停' : '▶ 运行中';
        if (pauseBtn.textContent !== label) pauseBtn.textContent = label;
        pauseBtn.classList.toggle('paused', paused);
        pauseBtn.classList.toggle('running', !paused);
        pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
        pauseBtn.title = paused
          ? `游戏时间已暂停 · 点击恢复上一次的倍速 ×${UI._clockLastSpeed || 1}（${UI.clockSpeedText(UI._clockLastSpeed || 1)}）`
          : `游戏时间运行中（${UI.clockSpeedDetail(speed)}）· 点击暂停，铺轨画线时更好操作`;
      }
      const speedBtn = util.$('#clock-speed');
      if (speedBtn) {
        const label = speed === 0 ? '⏸ 暂停' : `▶ ×${speed} ${UI.clockSpeedText(speed)}`;
        if (speedBtn.textContent !== label) speedBtn.textContent = label;
        speedBtn.classList.toggle('paused', speed === 0);
        speedBtn.title = `点击打开「倍速 + 跳到…」菜单 · 当前${speed === 0 ? '已暂停' : ' ' + UI.clockSpeedDetail(speed)}`
          + '；×1 = 实时（1 实时秒 = 1 游戏秒）、×60 = 1 实时秒 = 1 游戏分钟、×300 = 1 实时秒 = 5 游戏分钟'
          + '；Shift+点击 = 顺序切到下一档';
      }
      UI.syncClockJumpRow();
    },

    /** 「HH:MM」/「H:MM」/「第N天 HH:MM」→ { day, h, m }；解析不出来返回 null */
    parseClockJump(text) {
      const raw = String(text == null ? '' : text).trim().replace(/：/g, ':');
      if (!raw) return null;
      const m = raw.match(/^(?:第\s*(\d+)\s*天\s*)?(\d{1,2})\s*[:.时点]\s*(\d{1,2})?$/);
      if (!m) return null;
      const h = Number(m[2]);
      const mi = m[3] === undefined || m[3] === '' ? 0 : Number(m[3]);
      const day = m[1] === undefined ? null : Number(m[1]);
      if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
      if (day !== null && !(day >= 1)) return null;
      return { day, h, m: mi };
    },

    /**
     * 跳到自定义时间：服务端 clock.set 收 time（'HH:MM'）或 clockMs。
     * 只填 HH:MM 就直接发 time；写了「第N天」就换算成绝对 clockMs（1 游戏天 = 86400000 游戏毫秒）。
     * 调用失败：toast 服务端的中文错误，**保持原来的时间**（不动 Transit.data.clock）。
     */
    async jumpToClock(text) {
      if (!Transit || typeof Transit.op !== 'function') {
        util.toast('交通模块还没有就绪', 'warn', 2500);
        return false;
      }
      const parsed = UI.parseClockJump(text);
      if (!parsed) {
        util.toast('时间格式不对：请填 HH:MM（如 07:30）或 第N天 HH:MM（如 第3天 07:30）', 'error', 3600);
        return false;
      }
      const pad = (n) => String(n).padStart(2, '0');
      const clock = (Transit.data && Transit.data.clock) || null;
      const oldText = clock ? `第 ${clock.day || 1} 天 ${clock.time || '00:00'}` : '原来的时间';
      const op = { k: 'clock.set' };
      if (parsed.day === null) op.time = `${pad(parsed.h)}:${pad(parsed.m)}`;
      else op.clockMs = (parsed.day - 1) * 86400000 + parsed.h * 3600000 + parsed.m * 60000;
      try {
        const ack = await Transit.op(op);
        // 成功：以服务端 ack（result = { speed, clockMs, day }）为准刷新顶栏
        const r = (ack && ack.result) || null;
        if (clock && r) {
          const ms = Number(r.clockMs);
          if (Number.isFinite(ms)) {
            clock.clockMs = ms;
            clock.day = Math.floor(ms / 86400000) + 1;
            clock.time = `${pad(Math.floor((ms % 86400000) / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}`;
          } else if (op.time) {
            clock.time = op.time;
            if (Number.isFinite(Number(r.day))) clock.day = Number(r.day);
          }
          if (Number.isFinite(Number(r.speed))) clock.speed = Number(r.speed);
        } else if (clock && op.time) {
          clock.time = op.time;   // 服务端没回明细时至少让顶栏立刻跟手
        }
        if (typeof Transit.renderClock === 'function') Transit.renderClock();
        const now = (Transit.data && Transit.data.clock) || null;
        util.toast(`游戏时间已跳到 ${now ? `第 ${now.day || 1} 天 ${now.time || op.time || ''}` : (op.time || '')}`, 'info', 2600);
        const input = UI._clockJumpInput;
        if (input) input.value = '';
        Transit.toggleClockMenu(false);   // 跳完收起菜单
        return true;
      } catch (err) {
        // 失败：时间保持原样（Transit.data.clock 没被改过，服务端快照也不会变）
        util.toast(`跳到时间失败：${(err && err.message) || '未知错误'}（时间仍是 ${oldText}）`, 'error', 4200);
        return false;
      }
    },

    /** 建出「跳到…」整行（只建一次，之后复用同一个节点，正在输入的内容与光标不会丢） */
    clockJumpRow() {
      if (UI._clockJumpNode) return UI._clockJumpNode;
      const row = util.el('div', 'clock-menu-jump');
      const label = util.el('span', 'clock-jump-label', '跳到…');
      const input = util.el('input', 'clock-jump-input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.placeholder = 'HH:MM 或 第N天 HH:MM';
      input.setAttribute('aria-label', '跳到指定游戏时间：HH:MM 或 第N天 HH:MM');
      const go = util.el('button', 'clock-jump-go', '跳转');
      go.type = 'button';
      go.title = '跳到输入的时间（服务端收 HH:MM 或 clockMs）';
      const quick = util.el('div', 'clock-jump-quick');
      for (const q of UI.CLOCK_JUMPS) {
        const b = util.el('button', 'clock-jump-chip', q.label);
        b.type = 'button';
        b.dataset.jump = q.value;
        b.title = q.title;
        b.onclick = () => UI.jumpClockQuick(q.value);   // 每个芯片自己接事件（不靠冒泡到容器上）
        quick.appendChild(b);
      }
      const note = util.el('div', 'clock-jump-note');
      row.append(label, input, go, quick, note);
      UI._clockJumpNode = row;
      UI._clockJumpInput = input;
      UI._clockJumpNote = note;
      const submit = () => UI.jumpToClock(input.value);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); submit(); }
        // Esc 不拦：交给全局（收起菜单）
      });
      go.onclick = submit;
      return row;
    },

    /** 「跳到…」快捷时刻：tomorrow = 当前天数 + 1 的 08:00（换算成 clockMs），其余就是输入框能认的文本 */
    jumpClockQuick(value) {
      if (value === 'tomorrow') {
        const day = ((Transit.data && Transit.data.clock && Transit.data.clock.day) || 1) + 1;
        UI.jumpToClock(`第${day}天 08:00`);
        return;
      }
      UI.jumpToClock(value);
    },

    /** 菜单里那行「跳到…」的实时说明：现在几点 + 当前倍速的新语义 */
    syncClockJumpRow() {
      const note = UI._clockJumpNote;
      if (!note) return;
      const c = Transit && Transit.data ? Transit.data.clock : null;
      const speed = Transit && typeof Transit.currentSpeed === 'function' ? Transit.currentSpeed() : 0;
      const now = c ? `现在 第 ${c.day || 1} 天 ${c.time || '00:00'}` : '还没拿到服务器时间';
      note.textContent = `${now} · 当前倍速 ${UI.clockSpeedDetail(speed)}`;
    },

    /**
     * 「跳到…」行挂进菜单 + 给 transit.js 的 renderClock / renderClockMenu 各包一层：
     *  - renderClock 之后 → syncClockControls()（两个按钮的文案与提示）
     *  - renderClockMenu 之后 → 把「跳到…」行补回菜单（transit.js 用 innerHTML='' 重建芯片，
     *    菜单开着时每 250ms 一帧都会重建，所以复用同一个节点 + 还原焦点和光标位置）
     * 没装过才装（_uiClockPatched），和 installTransitView 里那几个包装同一个套路。
     */
    installClockControls() {
      if (!Transit) return;
      UI.clockJumpRow();   // 先把节点建好，包装里就能直接复用
      const menu = util.$('#clock-menu');
      if (menu && UI._clockJumpNode.parentNode !== menu) menu.appendChild(UI._clockJumpNode);
      if (!Transit._uiClockPatched) {
        Transit._uiClockPatched = true;
        if (typeof Transit.renderClockMenu === 'function') {
          const origMenu = Transit.renderClockMenu;
          Transit.renderClockMenu = function uiClockMenu() {
            const box = util.$('#clock-menu');
            const input = UI._clockJumpInput;
            const focused = !!(box && input && document.activeElement === input);
            const caret = focused ? input.selectionStart : null;
            const out = origMenu.apply(this, arguments);
            if (box && UI._clockJumpNode) {
              box.appendChild(UI._clockJumpNode);           // 同一节点：输入的内容留着
              UI.syncClockChipTitles(box);
              UI.syncClockJumpRow();
              if (focused) {
                input.focus();
                try { input.setSelectionRange(caret, caret); } catch (e) { /* 忽略：不支持就算了 */ }
              }
            }
            return out;
          };
        }
        if (typeof Transit.renderClock === 'function') {
          const origClock = Transit.renderClock;
          Transit.renderClock = function uiClock() {
            const out = origClock.apply(this, arguments);
            UI.syncClockControls();
            return out;
          };
        }
      }
      UI.syncClockControls();
    },

    /** 芯片提示也换成语义正确的说法（transit.js 里写的是旧的「1 实时秒 = N 游戏分钟」） */
    syncClockChipTitles(menu) {
      if (!menu || typeof menu.querySelectorAll !== 'function') return;
      for (const chip of menu.querySelectorAll('.clock-chip[data-speed]')) {
        const s = Number(chip.dataset.speed) || 0;
        chip.title = s === 0
          ? '暂停游戏时间（铺轨、画线时用）；恢复用左边的暂停/继续按钮'
          : `切到 ${UI.clockSpeedDetail(s)}`;
      }
    },

    /**
     * 线路管理器的独立窗口（linemgr.js 由另一个脚本提供，没加载时只提示不报错）。
     * 入口按钮（交通面板标题栏的「🛠 管理器」）已经删除 —— 面板的每个分区本身就是管理器，
     * 所以这里只留一个**由代码调用**的 API（window.G.LineMgr.open() 照旧是同一个窗口）。
     */
    openLineMgr() {
      const mgr = window.G.LineMgr;
      if (mgr && typeof mgr.open === 'function') { mgr.open(); return true; }
      util.toast('线路管理器还没加载（public/js/linemgr.js 未就绪）', 'warn', 3500);
      return false;
    },

    /* ------------------------------ 工具栏 ------------------------------ */
    /**
     * 编辑工具 = 一排**小的图标按钮**（.tool-list 是 3 列网格、每个按钮 36×36、图标 15px；
     * 工具名与用法只写在 title / aria-label 上，.lbl 由 CSS 隐藏）——
     * 左栏就这么宽（--rail-w = 三个按钮），工具按钮本身不占大格，
     * 剩下的高度留给同一列下面的「图层与显示模式」（两块各自独立、各有一条高度拖柄）。
     *
     * 列表里还有两枚**不是编辑工具**的入口按钮：#btn-transit（交通公司）与 #btn-search（搜索），
     * 它们从顶栏搬到这里，是 index.html 里的**静态节点**（id 必须一直是这两个）。
     * 所以这里不能直接 box.innerHTML = ''：先把这两枚摘下来，重排完编辑工具再放回列表末尾
     * （摘下来只是从文档里移除，事件与 id 都还在；bind() 接的 onclick 也不会丢）。
     */
    renderTools() {
      const box = util.$('#tool-list');
      if (!box) return;
      const entries = ['btn-transit', 'btn-search']
        .map((id) => util.$('#' + id))
        .filter(Boolean);
      box.innerHTML = '';
      for (const tool of Editor.TOOLS) {
        const btn = util.el('button', 'tool' + (tool.id === Editor.tool ? ' active' : ''),
          `<span class="ico">${tool.ico}</span><span class="lbl">${util.esc(tool.name)}</span>`);
        btn.type = 'button';
        btn.dataset.tool = tool.id;
        // 名字与用法都挂在提示上（按钮只有 36px 见方，格子里放不下字），无障碍也能读出来
        btn.title = `${tool.name} · ${tool.hint}`;
        btn.setAttribute('aria-label', tool.name);
        btn.onclick = () => UI.selectTool(tool.id);
        box.appendChild(btn);
      }
      // 顶栏搬来的两个入口：排在编辑工具后面，同样是 36×36 的小图标按钮
      for (const extra of entries) {
        extra.classList.add('tool', 'tool-entry');
        box.appendChild(extra);
      }
      UI.renderToolOptions();
    },

    selectTool(id) {
      Editor.setTool(id);
      // 高亮按 **Editor.tool** 走：老 id（delete / copy）会落到「选择」工具上，按钮也要亮对
      util.$$('#tool-list .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === Editor.tool));
      UI.renderToolOptions();
      // 换了工具就是换了一整屏设置：工具选项面板的滚动条拉回顶部
      // （面板只有内容那么高，上一个工具滚到一半的位置会让人以为"东西没了"）
      const body = util.$('#toolopts .panel-body');
      if (body) body.scrollTop = 0;
      if (Inspector) Inspector.showToolConfig();
    },

    /* ------------------------------ 工具选项 ------------------------------ */
    /**
     * 工具选项面板 = 「当前工具自己怎么用 + 这个工具的动作」。
     * 面板上只留标签，长说明一律收进「?」弹层（见 optRow / renderToolHeader）。
     * 新建类工具（加点 / 画线 / 画面 / 设站）"画之前"的设置（名字 / 类型表 / 楼层 / 设站模式）
     * 全部在创作面板 #inspector-create 里 —— 那是工具选项的一部分，属性检查器只留给选中的元素。
     */
    renderToolOptions() {
      const box = util.$('#tool-options');
      // editor.js 会把本函数包一层、在后面追加"这个工具自己的动作"（框选过滤 / 道路工具…）。
      // 加载顺序不同时它可能还没包上，这里兜一下（函数内部自带"只包一次"的开关）。
      if (Editor && typeof Editor._ensureOptionsHook === 'function') Editor._ensureOptionsHook();
      UI.closeHelpPops();
      UI.renderToolHeader();
      if (!box) return;
      box.innerHTML = '';
      const tool = Editor.tool;
      if (tool === 'select') UI.renderSelectOptions(box);
      else if (tool === 'boxselect') UI.renderBoxSelectOptions(box);
      // 其它工具的动作由 editor.js 的 renderExtraOptions 追加（它包了本函数），别在这里重复一份
    },

    /** 面板标题上的「当前工具 + ?」：说明全在这里，面板正文只留标签 */
    renderToolHeader() {
      const tool = (Editor.TOOLS || []).find((t) => t.id === Editor.tool) || null;
      const nameEl = util.$('#toolopts-tool');
      if (nameEl) nameEl.textContent = tool ? `${tool.ico} ${tool.name}` : '—';
      const btn = util.$('#toolopts-help');
      const head = btn ? btn.parentElement : null;
      if (!btn || !head) return;
      let pop = head.querySelector('.opt-pop');
      if (!pop) { pop = util.el('div', 'opt-pop hidden'); head.appendChild(pop); }
      pop.innerHTML = tool
        ? `<b>${util.esc(tool.ico + ' ' + tool.name)}</b> · ${util.esc(tool.hint)}`
        : '先在「编辑工具」里选一个工具。';
      btn.title = tool ? `「${tool.name}」怎么用（点一下展开）` : '当前工具怎么用（点一下展开）';
      btn.setAttribute('aria-expanded', 'false');
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const show = pop.classList.contains('hidden');
        UI.closeHelpPops();
        pop.classList.toggle('hidden', !show);
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      };
    },

    /** 收起所有「?」弹层（点别处、切工具、重画面板时用） */
    closeHelpPops() {
      util.$$('.opt-pop').forEach((p) => p.classList.add('hidden'));
      util.$$('.opt-help').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    },

    /**
     * 一行「标签 + ?」：面板上只显示标签，点「?」展开短说明。
     * helpText 允许写 HTML（自己保证转义）；返回的行元素可以继续塞芯片。
     */
    optRow(label, helpText) {
      const row = util.el('div', 'opt-row');
      if (label) row.appendChild(util.el('span', 'opt-row-label', util.esc(label)));
      if (helpText) {
        const btn = util.el('button', 'mini opt-help', '?');
        btn.type = 'button';
        btn.setAttribute('aria-expanded', 'false');
        const pop = util.el('div', 'opt-pop hidden', helpText);
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const show = pop.classList.contains('hidden');
          UI.closeHelpPops();
          pop.classList.toggle('hidden', !show);
          btn.setAttribute('aria-expanded', show ? 'true' : 'false');
        };
        row.appendChild(btn);
        row.appendChild(pop);
      }
      return row;
    },

    /**
     * 通用「?」按钮：**面板 / 弹窗里任何一段中文说明都塞进它的弹层**，面板上只留一行短标签
     * （用户要求：长段文字不直接铺在面板里）。用的是与 optRow 同一套零件
     * （.opt-help + .opt-pop），所以 closeHelpPops()、点别处收起、aria-expanded 全都照旧生效。
     * 返回的是包着「按钮 + 弹层」的 .help-wrap（弹层靠它定位）。
     */
    helpButton(helpText, opts = {}) {
      const wrap = util.el('span', 'help-wrap');
      const btn = util.el('button', 'mini opt-help', '?');
      btn.type = 'button';
      btn.setAttribute('aria-label', opts.label || '说明');
      btn.setAttribute('aria-expanded', 'false');
      btn.title = opts.title || '点一下看说明（再点一下收起）';
      const pop = util.el('div', 'opt-pop help-pop hidden', helpText);
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const show = pop.classList.contains('hidden');
        UI.closeHelpPops();
        pop.classList.toggle('hidden', !show);
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      };
      wrap.appendChild(btn);
      wrap.appendChild(pop);
      return wrap;
    },

    /**
     * 一行「短标签 + ?」：面板里凡是"一句话说不完"的设置都长这样
     * （optRow 是工具选项里那一份同款；这里给图层 / 图例 / 弹窗共用）。
     */
    helpRow(label, helpText, cls) {
      const row = util.el('div', cls || 'help-row');
      if (label) row.appendChild(util.el('span', 'help-row-label', util.esc(label)));
      if (helpText) row.appendChild(UI.helpButton(helpText));
      return row;
    },

    /** 往一个已经有短标签的元素（标题行 / 图例头）里补一枚「?」 */
    appendHelp(target, helpText, opts) {
      if (!target) return null;
      const wrap = UI.helpButton(helpText, opts);
      target.appendChild(wrap);
      return wrap;
    },

    /**
     * 静态节点上的「?」：index.html 里写 `data-help="…"` 的那些按钮
     * （弹窗说明、检查器空态…）。点一下在按钮旁边展开同一个 .opt-pop；
     * 全页只接一次委托，新加的静态按钮不用再改 JS。
     */
    initStaticHelp() {
      if (UI._staticHelpBound) return;
      UI._staticHelpBound = true;
      document.addEventListener('click', (ev) => {
        const t = ev.target;
        const btn = (t && t.closest) ? t.closest('.opt-help[data-help]') : null;
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        let pop = btn.__helpPop || null;
        if (!pop) {
          pop = util.el('div', 'opt-pop help-pop hidden', btn.getAttribute('data-help') || '');
          btn.__helpPop = pop;
          // 宿主 = 按钮的 .help-host 容器（CSS 里给它 position: relative，弹层才对得准）
          (btn.parentElement || btn).appendChild(pop);
        }
        const show = pop.classList.contains('hidden');
        UI.closeHelpPops();
        pop.classList.toggle('hidden', !show);
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      });
    },

    /**
     * 「选择」工具的动作：**复制 / 删除就是它的选项**（不再是工具栏里的独立工具）。
     * 「点击地图时」那一排 = 点中元素之后直接干什么；下面一排作用在当前选中的元素上。
     */
    renderSelectOptions(box) {
      const quick = Editor.quickAction || 'select';
      box.appendChild(UI.optRow('点击地图时', '「🔍 选择」点中元素即可在右侧看和改它的标签（同一处重复点击可切换重叠元素）。<br>'
        + '「🗑️ 删除」点中即删；被道路引用的节点会先问是否级联删除。<br>'
        + '「⧉ 复制」把当前选中的元素复制一份、偏移约 8 米。两者都能 Ctrl+Z 撤销。'));
      const chips = util.el('div', 'opt-chips');
      for (const [id, label] of [['select', '🔍 选择'], ['delete', '🗑️ 删除'], ['copy', '⧉ 复制']]) {
        const b = util.el('button', 'chip' + (quick === id ? ' active' : ''), label);
        b.dataset.quick = id;
        b.title = id === 'select' ? '点中元素就选中它（默认）'
          : id === 'delete' ? '点中元素就直接删除（Ctrl+Z 可撤销）'
            : '点一下地图就把当前选中的元素复制一份';
        b.onclick = () => { Editor.setQuickAction(id); UI.renderToolOptions(); };
        chips.appendChild(b);
      }
      box.appendChild(chips);

      const sel = Editor.selection;
      const acts = util.el('div', 'opt-actions');
      const copy = util.el('button', 'opt-btn', '⧉ 复制选中');
      copy.disabled = !sel;
      copy.title = '复制当前选中的元素（框选了一批也可以整体复制）';
      copy.onclick = () => Editor.duplicateSelection();
      const del = util.el('button', 'opt-btn danger', '🗑️ 删除选中');
      del.disabled = !sel;
      del.title = '删除当前选中的元素（Ctrl+Z 一步撤销）';
      del.onclick = () => Editor.deleteSelection();
      acts.appendChild(copy);
      acts.appendChild(del);
      box.appendChild(acts);
      box.appendChild(util.el('div', 'opt-current', sel
        ? `已选中 #${sel.id}`
        : '先点一个元素；要一次选一批，换「⬚ 框选」工具。'));
    },

    /**
     * 「框选」工具的动作：批量删除 / 批量套用标签 / 统计。
     * 类型过滤、批量限速、批量改类型由 editor.js 追加在下面（同一块面板）。
     */
    renderBoxSelectOptions(box) {
      box.appendChild(UI.optRow('框选结果', '在地图上按住左键拖出一块矩形，松开即选中框内的所有元素（选中哪几类由下面的「框选类型过滤」决定）。<br>'
        + '批量删除与批量套用标签都是一次 batch 提交，<b>Ctrl+Z 一次撤销</b>；留空的标签值表示删除该标签。'));
      const n = Editor.multiSelect.length;
      box.appendChild(util.el('div', 'opt-current', n ? `已选中 ${n} 个元素` : '还没有框选到元素：按住左键拖一个矩形。'));
      if (!n) return;
      const acts = util.el('div', 'opt-actions');
      const del = util.el('button', 'opt-btn danger', '🗑️ 批量删除');
      del.title = `删除这 ${n} 个元素（Ctrl+Z 一步撤销）`;
      del.onclick = () => Editor.deleteMultiSelection();
      const stat = util.el('button', 'opt-btn ghost', '统计');
      stat.title = '线长合计、面积合计与分类计数';
      stat.onclick = () => Editor.summarizeSelection();
      acts.appendChild(del);
      acts.appendChild(stat);
      box.appendChild(acts);

      const tagRow = util.el('div', 'opt-field row');
      const k = util.el('input', 'opt-input');
      k.placeholder = '标签名，如 highway';
      const v = util.el('input', 'opt-input');
      v.placeholder = '标签值，留空 = 删除该标签';
      const apply = util.el('button', 'opt-btn', '批量套用');
      apply.onclick = () => Editor.applyTagsToSelection(k.value.trim(), v.value.trim());
      tagRow.appendChild(k);
      tagRow.appendChild(v);
      tagRow.appendChild(apply);
      box.appendChild(tagRow);
    },

    /** 预设浏览器（渲染到左侧工具选项区） */
    showPresetBrowser(callback, title) {
      const box = util.$('#tool-options');
      box.innerHTML = '';
      UI.presetBrowser = callback;
      box.appendChild(util.el('div', 'opt-head', util.esc(title || '选择预设')));
      const input = util.el('input', 'opt-search');
      input.placeholder = '搜索预设（如 餐厅 / 公园 / 高速）';
      box.appendChild(input);
      const cats = util.el('div', 'preset-cats');
      const items = util.el('div', 'preset-items');
      box.appendChild(cats);
      box.appendChild(items);
      const all = window.G.Presets ? window.G.Presets.all() : [];
      const renderItems = (list) => {
        items.innerHTML = '';
        if (!list.length) { items.innerHTML = '<div class="empty-hint small">没有匹配的预设</div>'; return; }
        for (const item of list.slice(0, 60)) {
          const chip = util.el('button', 'preset-chip', `${item.icon || ''} ${util.esc(item.name)}`);
          chip.title = Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join('\n');
          chip.onclick = () => {
            if (UI.presetBrowser) UI.presetBrowser(item);
            UI.renderToolOptions();
          };
          items.appendChild(chip);
        }
      };
      if (window.G.Presets) {
        for (const cat of window.G.Presets.categories) {
          const b = util.el('button', 'preset-cat', `${cat.icon || ''} ${util.esc(cat.name)}`);
          b.onclick = () => renderItems(cat.items);
          cats.appendChild(b);
        }
      }
      input.oninput = () => {
        const q = input.value.trim();
        if (!q) { renderItems(all); return; }
        renderItems(window.G.Presets ? window.G.Presets.search(q) : []);
      };
      renderItems(all);
    },

    /* ------------------------------ 图层与显示模式 ------------------------------ */
    /**
     * 恢复图层与显示模式状态，并给开关接上线：
     *  - 车站覆盖范围：一个全局开关（默认关），跟每个车站自己的勾选无关
     *  - 图层：人口密度（交通模块热力图）/ 活跃度（渲染层格子图层），各自独立开关（图层表里的普通勾选框）
     *  - 显示模式：互斥，只有 普通 / 道路车速 / 轨交模式 / 公交模式 四种
     */
    initLayerModes() {
      const cb = util.$('#catchment-toggle');
      const only = util.$('#catchment-only-flagged');
      const on = !!util.storage.get(UI.CATCHMENT_KEY, false);
      const flagged = !!util.storage.get(UI.CATCHMENT_FILTER_KEY, false);
      if (cb) {
        cb.checked = on;
        cb.onchange = () => {
          Render.setStationCatchment(cb.checked);
          util.storage.set(UI.CATCHMENT_KEY, cb.checked);
          UI.renderLegend();
          util.statusHint(cb.checked ? '车站覆盖范围图层已打开（所有车站）' : '车站覆盖范围图层已关闭');
        };
      }
      if (only) {
        only.checked = flagged;
        only.onchange = () => {
          Render.setStationCatchment(undefined, only.checked);
          util.storage.set(UI.CATCHMENT_FILTER_KEY, only.checked);
          UI.renderLegend();
        };
      }
      Render.setStationCatchment(on, flagged);

      // 2) 人口密度图层（交通模块的人口热力图）：独立开关，与显示模式互不干扰
      UI.layers.population = !!util.storage.get(UI.POP_KEY, false);
      const popCb = util.$('#pop-toggle');
      if (popCb) popCb.checked = UI.layers.population;
      if (UI.layers.population) UI.setPopulationLayer(true, true);   // quiet：启动恢复时不弹提示

      // 3) 活跃度图层（渲染层的格子图层）：服务器没给 activity 字段时不可用
      UI.layers.activity = !!util.storage.get(UI.ACTIVITY_KEY, false) && Render.activityUsable();
      const actCb = util.$('#activity-toggle');
      if (actCb) actCb.checked = UI.layers.activity;

      // 4) 显示模式（普通 / 道路车速 / 拥堵模式 / 轨交模式 / 公交模式）与轨交/公交的筛选
      const saved = util.storage.get(UI.MODE_KEY, 'normal');
      // 存档里可能是老版本的"分色显示模式"（linecolor / company / fare）：它们现在是「分色方式」的别名，
      // 照旧放行（applyViewState 会走别名那条路：同时设方案 + 显示模式），不要压成 normal
      UI.mode = (UI.MODES.some((m) => m.id === saved) || UI.TRANSIT_COLOR_MODES.indexOf(saved) >= 0)
        ? saved : 'normal';
      for (const key of Object.keys(UI.MODE_FILTER_KEYS)) {
        const raw = util.storage.get(UI.MODE_FILTER_KEYS[key], null);
        UI.modeFilters[key] = {
          types: raw && Array.isArray(raw.types) ? raw.types.map(String) : [],
          lines: raw && Array.isArray(raw.lines) ? raw.lines.map(Number).filter(Number.isFinite) : [],
        };
      }
      // 人口/活跃度数据到位后要顺手刷新图例与芯片状态（也可能要因缺少 activity 字段而退回普通）
      Render.onCells = () => UI.onCellsUpdated();
      // 拥堵数据到位 → 刷新「显示模式」下方那一格的色带统计
      Render.onCongestion = () => UI.renderModeLegend();
      // 取不到拥堵数据时渲染层只喊一句中文提示、不回调 onCongestion：
      // 这里补一次重画，免得那一格一直停在"载入中…"（失败原因写在 note 里）
      if (typeof Render.congestionHint === 'function' && !Render._uiCongestionWrapped) {
        const origCongestionHint = Render.congestionHint;
        Render.congestionHint = function () {
          const out = origCongestionHint.apply(Render, arguments);
          UI.renderModeLegend();
          return out;
        };
        Render._uiCongestionWrapped = true;
      }
      // 回调接好之后再推一次状态：恢复出来的"拥堵模式"一进来就能拿到数据 / 显示中文说明
      //
      // 这一步是**读存档恢复界面状态**：存档里的显示模式/筛选可能属于旧版本、或者
      // 碰上"交通数据还没到"（Transit.data 还是 null）的时机。它一旦抛异常，
      // 启动流程就会断在这里 —— 退回普通模式再推一次，绝不让地图因此起不来。
      try {
        UI.applyViewState();
      } catch (err) {
        console.error('[ui] 恢复显示模式失败，已退回普通模式', err);
        UI.mode = 'normal';
        UI.modeFilters = { rail: { types: [], lines: [] }, bus: { types: [], lines: [] } };
        util.storage.set(UI.MODE_KEY, 'normal');
        UI.applyViewState();
      }
    },

    /* ------------------------------ 显示模式与图层 ------------------------------ */
    /**
     * 把「显示模式 + 图层 + 分色方式」这套状态一次性推给渲染层：
     *  - 活跃度图层占用渲染层的格子通道（Render 的 population/activity 格子），所以它一开，显示模式回到普通
     *  - 道路车速 / 拥堵模式 = 换整套**底图**配色（Render.setDisplayMode 认这两个 id，见 COLOR_MODES）
     *  - 轨交 / 公交模式 = 只看某一类（focus）+ 交通图层筛选，渲染通道仍是普通配色
     *  - 「分色方式」（公交线路分色）是**另一条轴**：它只在轨交 / 公交模式下露出那一行子选项，
     *    由 selectTransitColorScheme 直接调 Render.setTransitColorScheme()，这里不碰它（方案不会被切模式清掉）
     *  - 人口密度图层由交通模块（Transit.population）负责画，不占显示模式
     */
    applyViewState() {
      // 显示模式只认 MODES 里那五个；老存档里的 linecolor / company / fare 是「分色方式」的别名，也放行
      const alias = UI.TRANSIT_COLOR_MODES.indexOf(UI.mode) >= 0;
      if (!UI.MODES.some((m) => m.id === UI.mode) && !alias) UI.mode = 'normal';
      const wantMode = UI.layers.activity ? 'activity'
        : ((alias || UI.COLOR_MODES.includes(UI.mode)) ? UI.mode : 'normal');
      const wantFocus = (UI.mode === 'rail' || UI.mode === 'bus') ? UI.mode : null;
      // 只在真的变了的时候才调渲染层：每次调用都会重建一遍画布（还会重取人口格子），能省就省
      if (Render.displayMode !== wantMode) Render.setDisplayMode(wantMode);
      if (Render.focus !== wantFocus) Render.setFocus(wantFocus);
      if (Render.overlay) Render.overlay.redraw();
      UI.renderModeTree();     // 显示模式那一整块（顶层行 + 轨交/公交的子选项 + 一行图例 + 线路筛选）
      UI.renderLegend();
    },

    /**
     * 「显示模式」= **层级式 checkbox**，与上面「图层」那张表同一种行样式
     * （勾选框 + 色块 + 名称 + 右侧状态），不再是一排芯片按钮。
     *
     *   顶层（互斥，只有这五行）：普通 / 轨交模式 / 公交模式 / 道路车速 / 拥堵模式。
     *   子层（**只在父行勾选时出现**，缩进一级）：见 modeChildren() ——
     *     分色方式（单选）+ 线路类别（多选，写进 osmcity.modeFilter.rail/bus）。
     *
     * 勾选行为：顶层是互斥的（点哪一行就切到哪个模式；再点当前这一行还是它自己，不会"全都不选"）。
     * 每次点击都重建这一块 DOM（状态就是唯一依据），所以勾选框永远与 UI.mode 一致。
     * 公交线路分色**不是**显示模式（以前把它渲染成第 6/7/8 个模式芯片是错的）。
     */
    renderModeTree() {
      const box = util.$('#display-mode-group');
      if (!box) return;
      box.innerHTML = '';
      for (const m of UI.MODES) {
        const active = UI.mode === m.id;
        const row = util.el('label', 'layer-item mode-item' + (active ? ' active' : ''));
        row.title = m.hint;
        const cb = util.el('input');
        cb.type = 'checkbox';
        cb.dataset.mode = m.id;
        cb.checked = active;
        cb.setAttribute('aria-label', m.name);
        cb.onchange = () => UI.selectDisplayMode(m.id);
        row.appendChild(cb);
        const sw = util.el('span', 'sw');
        // 色带一律向渲染层要（车速 / 拥堵有 legendCss；轨交 / 公交与普通模式返回空串，用下面的写死色）
        const css = typeof Render.legendCss === 'function' ? Render.legendCss(m.id) : '';
        if (css) sw.style.background = `linear-gradient(90deg, ${css})`;
        else if (m.id === 'rail') sw.style.background = 'linear-gradient(90deg, #b9c0cc, #5b6472)';
        else if (m.id === 'bus') sw.style.background = 'linear-gradient(90deg, #ffd166, #f4783c)';
        else sw.style.background = 'linear-gradient(90deg, #f3f1ec, #d9d0c9)';
        row.appendChild(sw);
        row.appendChild(util.el('span', 'lname', `${m.ico} ${util.esc(m.name)}`));
        row.appendChild(util.el('span', 'lstate', UI.modeStateText(m)));
        box.appendChild(row);
        // 子项：勾了轨交 / 公交，才在**它下面**缩进出现分色方式与线路类别
        if (active && (m.id === 'rail' || m.id === 'bus')) box.appendChild(UI.modeChildren(m.id));
      }
      UI.renderModeSettings();     // 「只显示指定线路」（我的线路多选，同一套筛选键）
    },

    /** 顶层行右侧那一格状态：当前 = 现在生效的模式；轨交/公交筛过 = 已筛选；其它留空 */
    modeStateText(m) {
      if (UI.mode === m.id) return '当前';
      if (m.id === 'rail' || m.id === 'bus') {
        const f = UI.modeFilters[m.id];
        if (f && ((f.types || []).length || (f.lines || []).length)) return '已筛选';
      }
      return '';
    },

    /**
     * 轨交 / 公交模式下面**缩进出现的子 checkbox**（只有父行勾选时才生成）：
     *   1) 分色方式（单选，radio 语义）：三项直接来自渲染层 Render.transitColorSchemeDefs()，
     *      点一下 = Render.setTransitColorScheme(id)；勾选状态取 defs 里的 active；
     *      下面只跟**一行简单图例**（几个色块 + 名称，或一条色带），没有解释文字 / 统计块。
     *   2) 线路类别（多选）：轨交 = 高铁/城际/地铁/普速/轻轨/有轨电车，公交 = 公交；
     *      沿用现有筛选键 osmcity.modeFilter.rail / bus（types 数组），走 UI.toggleModeType。
     */
    modeChildren(mode) {
      const wrap = util.el('div', 'mode-children');

      // ---- 1) 分色方式（单选）----
      // 说明收进「?」：面板上只有「分色方式」四个字 + 一枚「?」（用户要求：不铺长文字）
      const schemeTitle = util.el('div', 'mode-child-title');
      schemeTitle.appendChild(util.el('span', null, '分色方式'));
      UI.appendHelp(schemeTitle, '公交线路的取色方式（单选）：按线路色 / 按公交公司 / 按票价。'
        + '它是与显示模式**独立的另一条轴** —— 换显示模式、进出轨交 / 公交模式都不会把它清掉。', { label: '分色方式说明' });
      wrap.appendChild(schemeTitle);
      let defs = null;
      try {
        if (typeof Render.transitColorSchemeDefs === 'function') defs = Render.transitColorSchemeDefs();
      } catch (err) {
        defs = null;   // 渲染层还没就绪 / 抛错：用兜底清单，别让这一组空着
      }
      if (!Array.isArray(defs) || !defs.length) {
        defs = UI.TRANSIT_COLOR_FALLBACK.map((d) => ({
          id: d.id, name: d.name, short: d.short || d.name, ico: d.ico, hint: d.hint,
          active: false, chosen: false, auto: false, scheme: d.id,
        }));
      }
      for (const d of defs) {
        const id = d.scheme || d.id;
        const row = util.el('label', 'layer-item');
        const cb = util.el('input');
        cb.type = 'radio';
        cb.name = 'transit-color-scheme';
        cb.dataset.scheme = id;
        cb.checked = !!d.active;
        cb.onchange = () => UI.selectTransitColorScheme(id);
        row.appendChild(cb);
        const sw = util.el('span', 'sw');
        const css = typeof Render.legendCss === 'function' ? Render.legendCss(id) : '';
        sw.style.background = css
          ? `linear-gradient(90deg, ${css})`
          : (id === 'company' ? '#6a8cff' : id === 'fare' ? '#e4a13c' : '#8a94a6');
        row.appendChild(sw);
        row.appendChild(util.el('span', 'lname', util.esc(d.short || d.name || id)));
        row.title = `${d.ico ? d.ico + ' ' : ''}${d.name || id}${d.hint ? ' · ' + d.hint : ''}`
          + (d.auto ? '（现在是默认的自动方案）' : '');
        wrap.appendChild(row);
      }
      wrap.appendChild(UI.colorSchemeLine());

      // ---- 2) 线路类别（多选）----
      // 「公交只有一种类别，所以只需要筛线路」这句原来直接铺在面板上（mode-child-note）：收进「?」
      const typeTitle = util.el('div', 'mode-child-title');
      typeTitle.appendChild(util.el('span', null, '线路类别'));
      UI.appendHelp(typeTitle, (mode === 'bus'
        ? '公交站与公交线路只有「公交」一种类别，所以这里只需要筛线路。<br>'
        : '') + '点一下切换：只看 / 不看这一类（可多选，全不选 = 全部）。', { label: '线路类别说明' });
      wrap.appendChild(typeTitle);
      const filter = UI.modeFilters[mode] || { types: [], lines: [] };
      for (const [id, label] of (mode === 'rail' ? UI.RAIL_TYPES : UI.BUS_TYPES)) {
        const row = util.el('label', 'layer-item');
        const cb = util.el('input');
        cb.type = 'checkbox';
        cb.dataset.type = id;
        cb.checked = filter.types.includes(id);
        cb.onchange = () => UI.toggleModeType(mode, id);
        row.appendChild(cb);
        const sw = util.el('span', 'sw');
        sw.style.background = UI.TYPE_COLORS[id] || '#8a94a6';
        row.appendChild(sw);
        row.appendChild(util.el('span', 'lname', util.esc(label)));
        row.title = `点一下切换：只看 / 不看这一类（可多选，全不选 = 全部）`;
        wrap.appendChild(row);
      }
      return wrap;
    },

    /**
     * 「分色方式」下面**唯一**的那一行图例：几个色块 + 名称（分类配色），或一条色带（连续配色）。
     * 数据与地图同源：Render.legendModel(Render.transitColorScheme())；颜色用 Render.legendCss(...)。
     * 刻意只有一行、最多 3 个色块（多的用「+N」带过）——
     * 原来的标题行 / 条目计数 / 票价公式那一堆解释文字与统计块已经删掉。
     */
    colorSchemeLine() {
      const line = util.el('div', 'scheme-line');
      if (typeof Render.legendModel !== 'function') return line;
      const scheme = typeof Render.transitColorScheme === 'function' ? Render.transitColorScheme() : 'auto';
      const model = Render.legendModel(scheme);
      if (!model) return line;
      const css = typeof Render.legendCss === 'function' ? Render.legendCss(scheme) : '';
      const entries = (model.categorical && Array.isArray(model.entries)) ? model.entries : [];
      if (!entries.length) {
        // 非分类（或还没有数据）：一条色带就够了
        if (css) {
          const bar = util.el('span', 'legend-bar');
          bar.style.background = `linear-gradient(90deg, ${css})`;
          bar.title = model.title || '';
          line.appendChild(bar);
        }
        return line;
      }
      for (const e of entries.slice(0, 3)) {
        const item = util.el('span', 'lg-item');
        const sw = util.el('span', 'sw');
        sw.style.background = e.hex || model.unknownColor || '#6b7280';
        item.appendChild(sw);
        item.appendChild(util.el('span', 'lg-name', util.esc(e.label || e.key || '')));
        item.title = [e.label, e.hex, e.pattern, e.note].filter(Boolean).join(' · ');
        line.appendChild(item);
      }
      if (entries.length > 3) line.appendChild(util.el('span', 'lg-more', `+${entries.length - 3}`));
      return line;
    },

    /** 切换显示模式（互斥；持久化）。活跃度图层占着渲染通道，切模式时先把它关掉 */
    selectDisplayMode(id, quiet) {
      // 旧别名：'linecolor' / 'company' / 'fare' **不是显示模式**，是「分色方式」的别名 ——
      // 走方案那条路（渲染层会同时设方案 + 显示模式），不再当第 6/7/8 个模式芯片
      if (UI.TRANSIT_COLOR_MODES.indexOf(id) >= 0) return UI.selectTransitColorAlias(id, quiet);
      const m = UI.MODES.find((x) => x.id === id);
      if (!m) return null;
      UI.mode = m.id;
      util.storage.set(UI.MODE_KEY, m.id);
      if (UI.layers.activity) {
        UI.layers.activity = false;
        util.storage.set(UI.ACTIVITY_KEY, false);
        const actCb = util.$('#activity-toggle');
        if (actCb) actCb.checked = false;
        if (!quiet) util.toast('已关闭活跃度图层（显示模式与整屏热力层不能同时占一条通道）', 'info', 3200);
      }
      UI.applyViewState();
      UI.renderLayers();
      if (!quiet) {
        const extra = (m.id === 'rail' || m.id === 'bus')
          ? '（它下面缩进出现了「分色方式」与「线路类别」两组子选项）' : '';
        util.toast(`显示模式：${m.name}${extra}`, 'info', 2600);
      }
      return m.id;
    },

    /**
     * 旧别名：UI.selectDisplayMode('linecolor' | 'company' | 'fare') —— 老存档（osmcity.displayMode =
     * 'company'）与老代码都走这里。语义照旧：**同时**设颜色方案 + 显示模式（渲染层的别名语义，
     * 见 render.js 的 setDisplayMode），所以离开轨交 / 公交模式时方案会自动回到 auto（老行为）。
     * 面板上的体现：这个 id 不是显示模式，顶层五行都不勾；分色方式那一行按生效方案勾选。
     */
    selectTransitColorAlias(id, quiet) {
      UI.mode = id;                                          // 与老行为一致：UI.mode 也记下这个 id
      util.storage.set(UI.MODE_KEY, id);
      // 走与真显示模式同一条路：applyViewState 会把 UI.mode 推给渲染层（别名在那边同时设方案 + 模式，
      // 并清掉轨交/公交聚焦、让别名方案在离开时回到 auto）—— 老 ui.js 的行为一模一样
      UI.applyViewState();
      UI.renderLayers();
      if (!quiet) {
        const name = (typeof Render.transitColorSchemeName === 'function' && Render.transitColorSchemeName(id)) || id;
        util.toast(`分色方式：${name}（旧接口 setDisplayMode 的别名）`, 'info', 2800);
      }
      return id;
    },

    /**
     * 选「分色方式」（**显式方案**）：只改公交取色，不动显示模式 —— 轨交 / 公交模式照旧，
     * 而且这个方案在两种模式下都生效、也不会被切显示模式清掉（语义在渲染层，见 setTransitColorScheme：
     * 显式方案 vs 旧别名方案的区别就在那儿）。这就是子选项里那三个单选行的点击目标。
     */
    selectTransitColorScheme(id, quiet) {
      const s = (typeof Render.setTransitColorScheme === 'function')
        ? Render.setTransitColorScheme(id)
        : (UI.TRANSIT_COLOR_MODES.indexOf(id) >= 0 ? id : 'auto');
      // 渲染层的钩子已经重画过一次；这里显式再画一遍，保证"点了就有反应"（幂等）
      UI.renderModeTree();
      UI.renderLegend();
      if (!quiet) {
        const name = (typeof Render.transitColorSchemeName === 'function' && Render.transitColorSchemeName(s)) || s;
        util.toast(s === 'auto' ? '分色方式：每条线用自己的颜色' : `分色方式：${name}`, 'info', 2400);
      }
      return s;
    },

    /**
     * 旧名字（Render 的 onTransitColorScheme 钩子、外部脚本都还在用它）：
     * 「显示模式」那一整块（含轨交 / 公交下面的「分色方式」子选项与那一行图例）重画一遍。
     * 子选项行现在是 renderModeTree() 的一部分 —— 独立的 #color-scheme-row 容器已经删掉。
     */
    renderColorSchemeRow() {
      UI.renderModeTree();
    },

    /** 人口密度图层（交通模块热力图）：本地记住状态，重启后自动恢复 */
    setPopulationLayer(on, quiet) {
      UI.layers.population = !!on;
      util.storage.set(UI.POP_KEY, UI.layers.population);
      const cb = util.$('#pop-toggle');
      if (cb) cb.checked = UI.layers.population;
      if (Transit && Transit.population) {
        if (quiet) {
          // 启动恢复：不发提示、不重复弹提示，直接开通道并取一次视野内的人口格子
          Transit.population.on = UI.layers.population;
          // 还没登录时先不取（取也取不到），登录成功后 setInfo 会再补一次
          if (UI.layers.population && Net.token && typeof Transit.ensurePopulation === 'function') Transit.ensurePopulation(true);
          else if (Render.overlay) Render.overlay.redraw();
        } else if (typeof Transit.togglePopulation === 'function') {
          Transit.togglePopulation(UI.layers.population);   // 它自己会发提示、同步勾选框并重绘
        }
      }
      UI.renderLegend();
    },

    /** 活跃度图层（渲染层格子图层）：与人口密度互斥，开启时显示模式回到普通 */
    setActivityLayer(on, quiet) {
      UI.layers.activity = !!on;
      util.storage.set(UI.ACTIVITY_KEY, UI.layers.activity);
      const cb = util.$('#activity-toggle');
      if (cb) cb.checked = UI.layers.activity;
      if (UI.layers.activity) {
        UI.mode = 'normal';
        util.storage.set(UI.MODE_KEY, 'normal');
      }
      UI.applyViewState();
      UI.renderLayers();
      if (!quiet) {
        util.toast(UI.layers.activity ? '活跃度图层已打开（颜色越红越繁华）' : '活跃度图层已关闭', 'info', 2200);
      }
    },

    /** 勾选框入口：人口密度（开着活跃度就先把活跃度关掉，两个整屏热力层不同时叠） */
    togglePopulationLayer(on) {
      if (on && UI.layers.activity) {
        UI.setActivityLayer(false, true);
        util.toast('已关闭活跃度图层：人口密度与活跃度都是整屏热力层，一次只看一个', 'info', 3200);
      }
      UI.setPopulationLayer(on, false);
    },

    /** 勾选框入口：活跃度 */
    toggleActivityLayer(on) {
      if (on && !Render.activityUsable()) {
        util.toast('服务器的人口接口没有返回 activity 字段，活跃度图层不可用', 'warn', 5000);
        const cb = util.$('#activity-toggle');
        if (cb) cb.checked = false;
        return;
      }
      if (on && UI.layers.population) {
        UI.setPopulationLayer(false, true);
        util.toast('已关闭人口密度图层：人口密度与活跃度都是整屏热力层，一次只看一个', 'info', 3200);
      }
      UI.setActivityLayer(on, false);
    },

    /** 人口/活跃度格子数据到位后的收尾：缺 activity 字段就把活跃度图层关掉并说明原因 */
    onCellsUpdated() {
      if (UI.layers.activity && Render.cells.list.length && !Render.activityUsable()) {
        UI.layers.activity = false;
        util.storage.set(UI.ACTIVITY_KEY, false);
        const cb = util.$('#activity-toggle');
        if (cb) cb.checked = false;
        UI.mode = 'normal';
        util.storage.set(UI.MODE_KEY, 'normal');
        UI.applyViewState();
        util.toast('服务器 /api/population 未提供 activity 字段，活跃度图层已停用', 'warn', 6000);
      }
      UI.renderModeTree();
      UI.renderLegend();
    },

    /* ------------------------------ 轨交 / 公交模式的设置块 ------------------------------ */
    /** 我的线路里属于该模式的那些（轨交模式 = 非公交线路，公交模式 = 公交线路） */
    myModeLines(mode) {
      const lines = (Transit && typeof Transit.myLines === 'function') ? Transit.myLines() : [];
      return lines.filter((l) => (mode === 'bus' ? l.kind === 'bus' : l.kind !== 'bus'));
    },

    lineKindName(kind) {
      const map = {
        hsr: '高铁', intercity: '城际', rail: '普速', subway: '地铁',
        light_rail: '轻轨', tram: '有轨电车', bus: '公交',
      };
      return map[kind] || kind || '未知';
    },

    persistModeFilter(mode) {
      if (UI.MODE_FILTER_KEYS[mode]) util.storage.set(UI.MODE_FILTER_KEYS[mode], UI.modeFilters[mode]);
    },

    /**
     * 轨交 / 公交模式下「只显示指定线路」（我的线路，多选）—— 写进 osmcity.modeFilter.<模式>.lines。
     * **类别筛选不在这里**：它是显示模式那一棵层级 checkbox 里的「线路类别」子项（见 modeChildren），
     * 这里只管线路，而且刻意只有标签 + 线路行 + 一个「清除筛选」按钮，不再挂解释段落。
     */
    renderModeSettings() {
      const box = util.$('#mode-settings');
      if (!box) return;
      box.innerHTML = '';
      const mode = UI.mode;
      if (mode !== 'rail' && mode !== 'bus') return;
      const filter = UI.modeFilters[mode];
      const lines = UI.myModeLines(mode);
      if (!lines.length) {
        // 空态只留一句短的，"上哪儿建线路"收进「?」（原来那句 36 字铺在面板里）
        const row = util.el('div', 'ms-note', '还没有属于自己的线路');
        row.appendChild(UI.helpButton('在「🚈 交通公司」里新建线路后，这里就能勾选要只看哪几条。',
          { label: '线路筛选用法' }));
        box.appendChild(row);
        return;
      }
      const wrap = util.el('div', 'ms-block');
      const lineLabel = util.el('div', 'ms-label');
      lineLabel.innerHTML = '只显示指定线路 <span class="ms-hint">'
        + (filter.lines.length ? `已选 ${filter.lines.length} 条` : '未选 = 全部') + '</span>';
      wrap.appendChild(lineLabel);
      const list = util.el('div', 'ms-lines');
      for (const line of lines) {
        const id = Number(line.id);
        const row = util.el('label', 'ms-line');
        const cb = util.el('input');
        cb.type = 'checkbox';
        cb.checked = filter.lines.includes(id);
        cb.onchange = () => UI.toggleModeLine(mode, id, cb.checked);
        row.appendChild(cb);
        const dot = util.el('span', 'dot');
        dot.style.setProperty('--c', (Transit && typeof Transit.lineColor === 'function' ? Transit.lineColor(line) : '#8a94a6'));
        row.appendChild(dot);
        row.appendChild(util.el('span', 'ms-line-name', util.esc(line.name || ('线路 #' + id))));
        row.appendChild(util.el('span', 'ms-kind', util.esc(UI.lineKindName(line.kind))));
        list.appendChild(row);
      }
      wrap.appendChild(list);
      const foot = util.el('div', 'ms-foot');
      const clear = util.el('button', 'mini', '清除筛选');
      clear.title = '回到「全部类别 / 全部线路」';
      clear.onclick = () => UI.clearModeFilter(mode);
      foot.appendChild(clear);
      wrap.appendChild(foot);
      box.appendChild(wrap);
    },

    toggleModeType(mode, id) {
      const filter = UI.modeFilters[mode];
      const i = filter.types.indexOf(id);
      if (i >= 0) filter.types.splice(i, 1);
      else filter.types.push(id);
      UI.persistModeFilter(mode);
      UI.renderModeTree();     // 子 checkbox 的勾选状态与右侧「已筛选」都跟着重画
      UI.renderLegend();
      if (Render.overlay) Render.overlay.redraw();
      util.statusHint(filter.types.length
        ? `${UI.lineKindName(id)}：${i >= 0 ? '不再显示' : '只显示这一类'}（共选了 ${filter.types.length} 类）`
        : '类型筛选已清空：该模式的全部类型都会显示');
    },

    toggleModeLine(mode, id, on) {
      const filter = UI.modeFilters[mode];
      const set = new Set(filter.lines);
      if (on) set.add(Number(id)); else set.delete(Number(id));
      filter.lines = [...set];
      UI.persistModeFilter(mode);
      UI.renderModeTree();
      UI.renderLegend();
      if (Render.overlay) Render.overlay.redraw();
      util.statusHint(filter.lines.length ? `只显示 ${filter.lines.length} 条指定线路` : '线路筛选已清空：该模式的全部线路都会显示');
    },

    clearModeFilter(mode) {
      UI.modeFilters[mode] = { types: [], lines: [] };
      UI.persistModeFilter(mode);
      UI.renderModeTree();
      UI.renderLegend();
      if (Render.overlay) Render.overlay.redraw();
      util.toast('已清除筛选：该模式的全部类别与线路都会显示', 'info', 2200);
    },

    /**
     * 当前显示模式对应的交通图层过滤器（返回 null = 不过滤）。
     * 轨交/公交模式下：车站、线路、车辆都按「类型 + 线路」过一遍，
     * 只有被选中的那部分画在地图上（未选任何一项 = 该模式的全部）。
     */
    transitFilter() {
      const mode = UI.mode;
      if (mode !== 'rail' && mode !== 'bus') return null;
      const filter = UI.modeFilters[mode];
      const types = new Set(filter.types);
      const lineIds = new Set(filter.lines);
      const busMode = mode === 'bus';
      let allowedStations = null;
      if (lineIds.size) {
        allowedStations = new Set();
        for (const line of ((Transit && Transit.data && Transit.data.lines) || [])) {
          if (!lineIds.has(Number(line.id))) continue;
          for (const sid of (line.stops || [])) allowedStations.add(Number(sid));
        }
      }
      return {
        active: types.size > 0 || lineIds.size > 0,
        line: (line) => {
          if (!line) return false;
          if (busMode !== (line.kind === 'bus')) return false;
          if (types.size && !types.has(line.kind)) return false;
          if (lineIds.size && !lineIds.has(Number(line.id))) return false;
          return true;
        },
        station: (st) => {
          if (!st) return false;
          if (busMode !== (st.kind === 'bus')) return false;
          if (types.size && !types.has(st.kind)) return false;
          if (allowedStations && !allowedStations.has(Number(st.id))) return false;
          return true;
        },
        vehicle: (v) => {
          if (!v) return false;
          if (busMode !== !!UI.BUS_VEHICLE_KINDS[v.kind]) return false;
          if (lineIds.size && !lineIds.has(Number(v.lineId))) return false;
          return true;
        },
      };
    },

    /**
     * 用「当前显示模式只看的那部分」临时替换交通数据里的四份列表，跑完立刻还原。
     * 交通模块（transit.js）不认识显示模式筛选，所以绘制与命中测试都从这里过一道；
     * 替换是同步的（try/finally 里包着一次调用），其它代码看不到换过的列表。
     */
    withTransitFilter(fn) {
      const data = Transit && Transit.data;
      const keep = UI.transitFilter();
      if (!data || !keep) return fn();
      const before = { lines: data.lines, stations: data.stations, trains: data.trains, vehicles: data.vehicles };
      try {
        if (Array.isArray(before.lines)) data.lines = before.lines.filter(keep.line);
        if (Array.isArray(before.stations)) data.stations = before.stations.filter(keep.station);
        if (Array.isArray(before.trains)) data.trains = before.trains.filter(keep.vehicle);
        if (Array.isArray(before.vehicles)) data.vehicles = before.vehicles.filter(keep.vehicle);
        return fn();
      } finally {
        data.lines = before.lines;
        data.stations = before.stations;
        data.trains = before.trains;
        data.vehicles = before.vehicles;
      }
    },

    /**
     * 把轨交/公交模式的筛选接到交通模块上：
     *  - draw / hitTest：按当前模式筛选后画图、命中（看得见的才点得中）
     *  - setSnapshot：服务器快照更新后重画设置块（线路多选列表要跟着变）
     *  - renderTopBar：共用的面板顶栏只留"和当前分区有关"的按钮 ——
     *    公司改名/配色、删除公司是**公司自己的操作**，只在「公司」分区出现，
     *    车站 / 线路 / 车辆分区里一律不摆（改完颜色、删公司都要先切回「公司」）；
     *    顶栏渲染完再**补回公司下拉选单**（renderTopBar 在 transit.js 里，不属于本文件：
     *    这里用"包一层"的办法加，不去改 transit.js）。
     *  - _filterSelect / filterStationsBySource：车站那一栏的「来源」筛选升级成
     *    「我的 / 公共（底图导入）/ 每个玩家 / 全部」，同样是包一层（transit.js 一个字节不改）。
     */
    installTransitView() {
      if (!Transit) return;
      for (const name of ['draw', 'hitTest']) {
        const flag = '_uiFilterWrapped_' + name;
        if (typeof Transit[name] !== 'function' || Transit[flag]) continue;
        const orig = Transit[name];
        Transit[name] = function () {
          const args = arguments;
          return UI.withTransitFilter(() => orig.apply(Transit, args));
        };
        Transit[flag] = true;
      }
      if (typeof Transit.setSnapshot === 'function' && !Transit._uiSnapshotWrapped) {
        const origSetSnapshot = Transit.setSnapshot;
        Transit.setSnapshot = function () {
          const out = origSetSnapshot.apply(Transit, arguments);
          // 急停（2026-09-20）：这里原来每次服务器快照（每 2 秒一次）都整块重建
          // 「显示模式」树（含线路多选列表），既卡又持续产生垃圾。改为只在快照里
          // 的公司/线路集合真的变化时才重画。
          const sig = (Transit.data && Transit.data.lines ? Transit.data.lines.length : 0)
            + ':' + (Transit.data && Transit.data.companies ? Transit.data.companies.length : 0);
          if (UI._modeTreeSig !== sig) {
            UI._modeTreeSig = sig;
            UI.renderModeTree();
          }
          return out;
        };
        Transit._uiSnapshotWrapped = true;
      }
      if (typeof Transit.renderTopBar === 'function' && !Transit._uiTopBarWrapped) {
        const origTopBar = Transit.renderTopBar;
        Transit.renderTopBar = function () {
          const out = origTopBar.apply(Transit, arguments);
          UI.pruneTransitTopBar();
          UI.injectTransitCompanySelect();   // 顶栏最前面：公司下拉选单（恢复）
          return out;
        };
        Transit._uiTopBarWrapped = true;
      }
      // 车站「来源」筛选：选项换成「我的 / 公共（底图导入）/ 每个玩家 / 全部」
      if (typeof Transit._filterSelect === 'function' && !Transit._uiFilterSelectWrapped) {
        const origFilterSelect = Transit._filterSelect;
        Transit._filterSelect = function (label, options, value, key) {
          const opts = key === 'source' ? UI.stationSourceOptions() : options;
          const wrap = origFilterSelect.call(Transit, label, opts, value, key);
          const sel = (wrap && typeof wrap.querySelector === 'function') ? wrap.querySelector('select') : null;
          if (sel && sel.classList) sel.classList.add(key === 'source' ? 'tp-select-source' : 'tp-select-filter');
          return wrap;
        };
        Transit._uiFilterSelectWrapped = true;
      }
      // 「来源」筛选的取值：player:<玩家id>（transit.js 只认 all / mine / public，这里补上按玩家）
      if (typeof Transit.filterStationsBySource === 'function' && !Transit._uiStationSourceWrapped) {
        const origSourceFilter = Transit.filterStationsBySource;
        Transit.filterStationsBySource = function (list, source) {
          const src = (source === undefined || source === null || source === '') ? 'all' : String(source);
          if (src.startsWith('player:')) return UI.stationsOfPlayer(list, src.slice('player:'.length));
          return origSourceFilter.call(Transit, list, source);
        };
        Transit._uiStationSourceWrapped = true;
      }
    },

    /**
     * 公司 id → 玩家账号（owner）名。玩家名优先用联机协作者列表（net.js 的玩家表），
     * 拿不到就退到公司名 / 一段短 id —— 绝不会显示 "undefined"。
     */
    playerLabel(ownerId, companyName) {
      const key = String(ownerId == null ? '' : ownerId);
      if (!key) return companyName || '未知玩家';
      const p = (UI.players || []).find((x) => x && String(x.id) === key);
      const name = (p && p.name) || '';
      if (name && companyName && companyName !== name) return `${name}（${companyName}）`;
      return name || companyName || `玩家 ${key.slice(0, 8)}`;
    },

    /** 车站「来源」下拉的选项：我的 / 公共（底图导入）/ 每个玩家 / 全部（顺序 = 用户指定的顺序） */
    stationSourceOptions() {
      const stations = ((Transit && Transit.data && Transit.data.stations) || []);
      const companies = ((Transit && Transit.data && Transit.data.companies) || []);
      const companyOfOwner = new Map();
      for (const c of companies) {
        const o = c && c.owner != null ? String(c.owner) : '';
        if (!o || o === '__system__') continue;
        if (!companyOfOwner.has(o)) companyOfOwner.set(o, c.name || '');
      }
      // 「每个玩家」= 数据集里真的有车站的那些 owner（其余玩家点了只会得到空列表，不列出来）
      const owners = new Map();
      for (const s of stations) {
        if (!s || Transit.isPublicStation(s)) continue;
        const o = s.owner != null ? String(s.owner) : '';
        if (!o) continue;
        if (!owners.has(o)) owners.set(o, UI.playerLabel(o, companyOfOwner.get(o) || ''));
      }
      const mine = (Transit && typeof Transit.myId === 'function') ? String(Transit.myId() || '') : '';
      if (mine) owners.delete(mine);
      const rows = [...owners.entries()]
        .map(([id, label]) => [`player:${id}`, `👤 ${label}`])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'zh-CN'));
      return [['mine', '我的'], ['public', '公共（底图导入）']]
        .concat(rows)
        .concat([['all', '全部']]);
    },

    /** 某个玩家名下的车站：owner 就是他，或者挂在他的公司名下（公共车站不算任何人的） */
    stationsOfPlayer(list, ownerKey) {
      const key = String(ownerKey);
      const cids = new Set(((Transit && Transit.data && Transit.data.companies) || [])
        .filter((c) => c && String(c.owner) === key)
        .map((c) => Number(c.id)));
      return (list || []).filter((s) => s
        && !Transit.isPublicStation(s)
        && (String(s.owner) === key || (s.companyId != null && cids.has(Number(s.companyId)))));
    },

    /**
     * 顶栏最前面的**公司下拉选单**（用户要求恢复：上一轮删掉了，这一轮改回来）。
     * renderTopBar 在 transit.js 里（不归本文件），所以这里在它渲染完之后往 .tp-topbar 里插一个 select。
     *   · 我的公司 → Transit.openCompanyInPanel(id)（内部走 setCompany，＝切换"我在经营哪家"）
     *   · 别家公司 → 同样走 openCompanyInPanel：只在面板里看它的运营数据（company.select 只认自己的公司）
     * 选项分两组：我的公司 / 别家公司（协作）。一家公司都没有时给一个禁用的占位项。
     *
     * **如果以后 transit.js 拿回来了**（那份文件里 renderTopBar 是原生入口，注释还写着"没有公司下拉选单"）：
     * 把本函数的 6 行 select 构造搬进 transit.js 的 renderTopBar 开头即可，本包装层删掉就不会重复。
     * 现在这样做的原因只有一个：一个文件一个写者 —— transit.js 不属于本次改动范围。
     */
    injectTransitCompanySelect() {
      if (!Transit || typeof Transit.section !== 'function') return null;
      const bar = util.$('#transit-body .tp-topbar');
      if (!bar) return null;
      const mine = (typeof Transit.myCompanies === 'function' ? Transit.myCompanies() : []) || [];
      const all = ((Transit.data && Transit.data.companies) || []);
      const mineIds = new Set(mine.map((c) => Number(c.id)));
      const viewed = Transit.selectedCompany == null ? null : Number(Transit.selectedCompany);
      const active = Transit.activeCompanyId == null ? null : Number(Transit.activeCompanyId);

      const sel = util.el('select', 'tp-select tp-company-select');
      sel.title = '切换当前经营的公司；选别家公司＝在面板里看它的运营数据（协作）';
      sel.setAttribute('aria-label', '当前公司');
      if (!mine.length && !all.length) {
        const o = util.el('option', null, '还没有公司');
        o.value = '';
        o.disabled = true;
        sel.appendChild(o);
      }
      const addGroup = (label, list, kind) => {
        if (!list.length) return;
        const g = util.el('optgroup');
        g.label = label;
        for (const c of list) {
          const isActive = kind === 'mine' && (active != null ? Number(c.id) === active : Transit.company() === c);
          const o = util.el('option', null, util.esc(`${c.name || ('公司 #' + c.id)}${isActive ? '（当前）' : ''}`));
          o.value = `${kind}:${c.id}`;
          if (isActive || (kind === 'view' && viewed != null && Number(c.id) === viewed)) o.selected = true;
          g.appendChild(o);
        }
        sel.appendChild(g);
      };
      addGroup('我的公司', mine, 'mine');
      addGroup('别家公司（协作）', all.filter((c) => !mineIds.has(Number(c.id))), 'view');
      sel.onchange = () => {
        const v = String(sel.value || '');
        const i = v.indexOf(':');
        if (i <= 0) return;
        const id = Number(v.slice(i + 1));
        if (!Number.isFinite(id)) return;
        const kind = v.slice(0, i);
        if (typeof Transit.openCompanyInPanel === 'function') Transit.openCompanyInPanel(id);
        // 别家公司：把面板切到「公司」分区，才看得到它的运营数据
        if (kind === 'view' && typeof Transit.openPanel === 'function') Transit.openPanel('company');
      };
      bar.insertBefore(sel, bar.firstChild);
      return sel;
    },

    /**
     * 顶栏上只属于「公司」分区的按钮：公司改名/配色、删除公司。
     * 交通面板的分区共用同一条顶栏，所以渲染完按当前分区清一遍 —— 其它分区不留这两个动作。
     */
    COMPANY_TOP_ACTIONS: /改名|配色|删除公司/,

    pruneTransitTopBar() {
      if (!Transit || typeof Transit.section !== 'function') return 0;
      if (Transit.section() === 'company') return 0;      // 「公司」分区：这两个动作就住在这里
      const bar = document.querySelector('#transit-body .tp-topbar');
      if (!bar) return 0;
      let removed = 0;
      for (const btn of Array.from(bar.querySelectorAll('button'))) {
        if (!UI.COMPANY_TOP_ACTIONS.test(btn.textContent || '')) continue;
        btn.remove();
        removed += 1;
      }
      return removed;
    },

    /**
     * 图层表：**所有显示开关都在这一张表里** ——
     *   要素分类勾选（道路 / 铁路 / 步道小径 / 建筑…）+ 人口密度 / 活跃度 / 车站覆盖范围。
     * 这些行由 HTML 直接给出（人口密度那几个）或在这里渲染（分类勾选），行样式完全一样，
     * 没有"特殊分组"，也没有单独一行样式的开关。轨交 / 公交是「显示模式」，不再在图层里重复一遍。
     * 每一行只有 勾选框 + 色块 + 名称：**右侧的要素计数已经删掉** ——
     * "我为什么要知道有多少道路 / 建筑 / 水系？"，所以这里也不再为显示数字做任何统计。
     */
    renderLayers() {
      const style = window.G.Style;
      if (!style) return;

      // 要素分类：12 类，每一类一个勾选框（含 道路 / 铁路 / 步道与小径）
      const catBox = util.$('#layer-cats');
      if (catBox) {
        catBox.innerHTML = '';
        for (const cat of style.CATEGORIES) {
          const label = util.el('label', 'layer-item');
          const cb = util.el('input');
          cb.type = 'checkbox';
          cb.checked = Render.isVisible(cat.id);
          cb.dataset.cat = cat.id;
          cb.onchange = () => {
            Render.setCategoryVisible(cat.id, cb.checked);
            UI.updateStatus();
          };
          label.appendChild(cb);
          label.appendChild(util.el('span', 'sw cat-' + cat.id));
          label.appendChild(util.el('span', 'lname', util.esc(cat.name)));
          catBox.appendChild(label);
        }
      }

      UI.renderModeTree();     // 显示模式那一整块（顶层行 + 子选项 + 一行图例 + 线路筛选）
      UI.renderLegend();
    },

    /**
     * 「显示模式」下方那一格：只在拥堵模式下出现 —— 色带 + 刻度 + 一行中文摘要（另有「↻ 刷新」）。
     * 摘要只留**数据**（视野内多少条 / 三档各多少 / 平均服务速度）；
     * 「绿=畅通红=拥堵」「进模式后自动加载」这类**说明**收进标题上的「?」（原来是一整行铺在面板上）。
     * 不再在下面的 #layer-legend 里重复画一份（同一个显示模式只有一处图例）。
     */
    renderModeLegend() {
      const box = util.$('#mode-legend');
      if (!box) return;
      box.innerHTML = '';
      if (UI.mode !== 'congestion' || typeof Render.legendModel !== 'function') return;   // :empty → 整格收起
      const model = Render.legendModel('congestion');
      if (!model) return;
      const stats = typeof Render.congestionStats === 'function' ? Render.congestionStats() : null;

      const block = util.el('div', 'legend-block');
      const head = util.el('div', 'legend-title');
      head.appendChild(util.el('span', '', util.esc(model.title)));
      if (model.note) UI.appendHelp(head, util.esc(model.note), { label: '拥堵图例说明' });
      const right = util.el('span', 'legend-actions');
      right.appendChild(util.el('span', '', stats && stats.ways
        ? `${util.fmt(stats.ways)} 条道路`
        : (model.loading ? '载入中…' : '无数据')));
      if (typeof Render.refreshCongestion === 'function') {
        const refresh = util.el('button', 'mini', '↻ 刷新');
        refresh.type = 'button';
        refresh.title = '按当前视野重新取一次拥堵数据';
        refresh.onclick = () => { Render.refreshCongestion(); UI.renderModeLegend(); };
        right.appendChild(refresh);
      }
      head.appendChild(right);
      block.appendChild(head);

      const bar = util.el('div', 'legend-bar');
      bar.style.background = `linear-gradient(90deg, ${Render.legendCss('congestion')})`;
      block.appendChild(bar);

      const ticks = util.el('div', 'legend-ticks');
      for (const t of model.ticks || []) ticks.appendChild(util.el('span', '', util.esc(t.label)));
      block.appendChild(ticks);

      // 一行**数据**摘要：有数据就是统计原文；载入中 / 取不到时只留短句（原因与说明都在「?」里）
      if (stats && stats.ways) block.appendChild(util.el('div', 'legend-note', util.esc(stats.text)));
      else if (stats && stats.error) block.appendChild(util.el('div', 'legend-note', util.esc('拥堵数据取不到：' + stats.error)));
      else if (stats && stats.loading) block.appendChild(util.el('div', 'legend-note', '拥堵数据载入中…'));
      else block.appendChild(util.el('div', 'legend-note', '还没有拥堵数据'));
      // 灰 = 服务器这批数据里没有这条路（尚未取到），别让人以为是配色坏了
      if (model.unknownColor) {
        const line = util.el('div', 'legend-line');
        const sw = util.el('span', 'sw');
        sw.style.background = model.unknownColor;
        line.appendChild(sw);
        line.appendChild(util.el('span', '', util.esc('灰 = 这条路暂无拥堵数据')));
        block.appendChild(line);
      }
      box.appendChild(block);
    },

    /** 图例：画在图层面板里（不放交通面板），色带与地图用的是同一份颜色定义 */
    renderLegend() {
      // 拥堵模式的图例住在「显示模式」下方那一格（#mode-legend），这里不再重复画一遍
      UI.renderModeLegend();

      const box = util.$('#layer-legend');
      if (!box) return;
      box.innerHTML = '';

      const mode = Render.displayMode;
      // 「分色方式」那一类配色（linecolor / company / fare，含老存档里的别名）**不再**画一整块带标题、
      // 条目计数、票价公式的图例 —— 只留一行（几个色块 + 名称）。而且这一行通常已经在
      // 「显示模式」里那个子选项下面了（colorSchemeLine），这里只在"没显示在那儿"时补一行，绝不放两块。
      const isScheme = typeof Render.isTransitColorScheme === 'function' && Render.isTransitColorScheme(mode);
      if (isScheme) {
        if (!(UI.mode === 'rail' || UI.mode === 'bus')) box.appendChild(UI.colorSchemeLine());
      } else {
        const model = mode === 'congestion' ? null : Render.legendModel(mode);
        if (model) {
          const block = util.el('div', 'legend-block');
          const head = util.el('div', 'legend-title');
          head.appendChild(util.el('span', '', util.esc(model.title)));
          if (Render.isCellMode(mode)) {
            const c = Render.cells;
            const badge = c.loading ? '载入中…' : (c.error ? '载入失败' : `${util.fmt(c.list.length)} 格`);
            head.appendChild(util.el('span', '', badge));
          }
          // 图例说明（"蓝=慢红=快 / 越红人越多 / 1.0 是基准"…）收进「?」：图例上只留标题 + 色带 + 刻度
          if (model.note) UI.appendHelp(head, util.esc(model.note), { label: `${model.title || '图例'}说明` });
          block.appendChild(head);
          const bar = util.el('div', 'legend-bar');
          bar.style.background = `linear-gradient(90deg, ${Render.legendCss(mode)})`;
          block.appendChild(bar);
          const ticks = util.el('div', 'legend-ticks');
          for (const t of model.ticks || []) ticks.appendChild(util.el('span', '', util.esc(t.label)));
          block.appendChild(ticks);
          if (Render.isCellMode(mode)) {
            const c = Render.cells;
            let extra = '';
            if (c.error) extra = `数据读取失败：${c.error}`;
            else if (mode === 'population' && c.list.length) {
              const pop = c.list.reduce((a, x) => a + (Number(x.pop) || 0), 0);
              // ⚠ 「岗位」不再显示：这个游戏里没有岗位系统（服务端默认也不算岗位，
              //    见 config.json 的 population.computeJobs 与 server/population.js 的说明）。
              extra = `视野内合计 ${util.fmtShort(pop)} 人`;
            } else if (mode === 'activity' && c.list.length) {
              const sum = c.list.reduce((a, x) => a + (Number(x.activity) || 0), 0);
              extra = `视野内 ${util.fmt(c.list.length)} 格 · 平均系数 ${(sum / c.list.length).toFixed(2)}`;
            } else if (!c.loading && !c.loadedAt) {
              extra = '还没取到格子数据';
            } else if (!c.loading) {
              extra = '当前视野内没有人口格子';
            }
            if (extra) {
              // 空态只留一句短的，"接下来怎么办"收进「?」（原来那一长句直接铺在图例上）
              const row = util.el('div', 'legend-note', util.esc(extra));
              if (!c.error && !c.loading && !c.loadedAt) {
                row.appendChild(UI.helpButton('登录后会自动加载；也可以拖动一下地图，或放大地图 / 换个位置再试。',
                  { label: '格子数据说明' }));
              }
              block.appendChild(row);
            }
          }
          box.appendChild(block);
        }
      }

      // 轨交 / 公交模式不再在这里堆筛选说明文字：现在只看哪几类 / 哪几条线，
      // 在「显示模式」那一棵层级 checkbox 里一眼就能看见（勾选状态 + 右侧「已筛选」）。

      // 人口密度图层（交通模块的人口热力图，颜色与 transit.js 的着色一致：绿 → 红）
      if (UI.layers.population) {
        const block = util.el('div', 'legend-block');
        const head = util.el('div', 'legend-title');
        head.appendChild(util.el('span', '', '人口密度'));
        const cells = (Transit && Transit.population && Array.isArray(Transit.population.cells)) ? Transit.population.cells : [];
        head.appendChild(util.el('span', '', `${util.fmt(cells.length)} 格`));
        // 「每格 250×250 米…」这句原来直接铺在图例上：收进「?」
        UI.appendHelp(head, '每格 250×250 米，颜色越红人越密；数据来自 /api/population。', { label: '人口密度说明' });
        block.appendChild(head);
        const bar = util.el('div', 'legend-bar');
        bar.style.background = 'linear-gradient(90deg, rgb(40,215,120), rgb(147,127,60), rgb(255,40,0))';
        block.appendChild(bar);
        const ticks = util.el('div', 'legend-ticks');
        for (const label of ['人少', '一般', '人多']) ticks.appendChild(util.el('span', '', label));
        block.appendChild(ticks);
        box.appendChild(block);
      }

      if (Render.stationCatchment.on) {
        const block = util.el('div', 'legend-block');
        const head = util.el('div', 'legend-title');
        head.appendChild(util.el('span', '', '车站覆盖范围'));
        head.appendChild(util.el('span', '', `${util.fmt(Render.stationList().length)} 座车站`));
        // 半径口径 + 配色说明（原来是"一行 + 一句"两段文字）合成一枚「?」，图例上只留短标签
        UI.appendHelp(head, '半径 = 车站表单里的「吸引半径」。<br>'
          + (Render.stationCatchment.onlyFlagged
            ? '只画车站自己勾了「显示覆盖范围」的那些（上方的过滤器已打开）。'
            : '所有车站都画；圆盘越叠越深，橙色 = 轨道交通站，黄色 = 公交站。'), { label: '车站覆盖范围说明' });
        block.appendChild(head);
        const line = util.el('div', 'legend-line');
        line.appendChild(util.el('span', 'legend-disc'));
        line.appendChild(util.el('span', '', '半径 = 吸引半径'));
        block.appendChild(line);
        box.appendChild(block);
      }

      // 服务器没给 activity 字段时，把活跃度图层开关置灰（点了也会被 toggleActivityLayer 拦下）
      const actRow = util.$('#activity-toggle');
      if (actRow) {
        const usable = Render.activityUsable();
        actRow.disabled = !usable;
        if (actRow.parentElement) actRow.parentElement.classList.toggle('disabled', !usable);
        actRow.title = usable
          ? '活跃度图层：按每格的繁华度系数着色（1.0 为基准，商业/枢纽更高、绿地更低）'
          : '服务器 /api/population 没有返回 activity 字段，活跃度图层暂不可用（请更新服务器）';
      }
    },

    /**
     * 旧接口：以前把每个图层类别的要素计数（.lcount）刷到图层表右侧。
     * **计数已经彻底删掉**（用户明确问过"我为什么要知道有多少道路 / 建筑 / 水系？"），
     * 所以这里不再统计任何东西 —— main.js 的 Render.onCounts / onStats 还会调它，
     * 保留这个空实现只是为了让那些调用点照旧可用（返回值 0 = 一件事都没做）。
     */
    refreshLayerCounts() {
      return 0;
    },

    /* ------------------------------ 顶栏与状态栏 ------------------------------ */
    /**
     * 顶栏不再显示数据集 / 导入时间那一串（顶栏只留八个入口按钮，瘦身之后更好认）。
     * 数据集来源、导入时间、要素总数等统一在「📊 服务器资讯」窗口里看，
     * 这里只把 info 记下来供那个窗口用（#data-info 现在只是个隐藏的占位节点）。
     */
    setInfo(info) {
      UI.info = info;
      if (!info) return;
      // 登录拿到 token 之后再补一次人口/活跃度格子（这两个图层要用 token 才能取数据；
      // 没取过或换过视野才真的发请求，force=false 不会每次都重新拉）
      if (Render.isCellMode()) Render.ensureCells(false);
      // 人口密度图层是上次退出时留着的：启动时还没登录取不到数据，这里补一次
      if (UI.layers.population && Transit && typeof Transit.ensurePopulation === 'function') Transit.ensurePopulation(true);
    },

    setDepth(d) {
      if (!d) return;
      UI.depth = d;
      UI.updateStatus();
    },

    updateStatus() {
      const stats = Render.stats || {};
      const counts = World.counts();
      const zoomEl = util.$('#status-zoom');
      if (zoomEl) zoomEl.textContent = 'z' + (Editor.map ? Editor.map.getZoom() : '-');
      const countsEl = util.$('#status-counts');
      if (countsEl) {
        const lod = stats.lod ? ` · 分级 L+${stats.lod}` : '';
        /**
         * 报**这一档真的画在这个视野里的要素数**（Render.stats.features 就是它），
         * 而不是"本地缓存里一共有多少"。
         *
         * 为什么必须这样（#6a）：以前这里写的是 `counts.ways + counts.nodes` ——
         * 那是**本地缓存总量**（保留区里所有缩放混在一起的数据），于是 z19 上一屏只画几百个图形，
         * 状态栏却报"视野内 2.7 万个要素"，看着像地图卡住了。
         * 现在：正文只报视野内真画出来的量；明细（哪一部分没画、本地缓存多少、哪个街区被简略）
         * 全部挂在 title 上，鼠标一悬停就看得到。
         */
        const inView = Number.isFinite(stats.featuresInView) ? stats.featuresInView : 0;
        const b = Render.featureBreakdown ? Render.featureBreakdown() : null;
        let text = `视野内 ${util.fmtShort(inView)} 个要素 · 绘制 ${util.fmtShort(stats.drawn || 0)} 个图形${lod}`;
        const block = Render.blockStats ? Render.blockStats() : null;
        if (block && block.degraded) {
          // 有街区被简略时，正文里就点出来（明细在 title 里给全）
          text += ` · 简略 ${block.degraded} 街区`;
        }
        countsEl.textContent = text;
        const tip = [];
        if (b) tip.push(Render.featureBreakdownText());
        if (block && block.degraded) {
          tip.push('分块简略：' + (block.breakdownText || ''));
          tip.push(`这一档门槛 ${block.threshold} 个可简化要素 / ${block.sizeM} 米街区`
            + `（判过密的街区平均露出 ${Math.round((block.visibleFrac || 0) * 100)}% 在屏幕上）`
            + ` · 简化小面 ${block.simplifiedFills} / POI ${block.simplifiedPoints} / 次要道路 ${block.simplifiedRoads}`);
        }
        if (stats.detailDroppedFills) tip.push(`本趟按档位/面积省掉的小面 ${stats.detailDroppedFills} 个`);
        tip.push('（数据集总量在「服务器资讯」窗口里看；本地缓存 ' + util.fmtShort(counts.ways + counts.nodes) + ' 个要素）');
        countsEl.title = tip.join('\n');
      }
      const undoEl = util.$('#status-undo');
      const canUndo = UI.depth.undoDepth || 0;
      const canRedo = UI.depth.redoDepth || 0;
      if (undoEl) undoEl.textContent = `可撤销 ${canUndo} 步 · 可重做 ${canRedo} 步`;
      // 左栏够宽，#status-undo 那行字照旧显示；步数同时写进两个按钮的提示（悬停就能看）
      const undoBtn = util.$('#btn-undo');
      if (undoBtn) undoBtn.title = `撤销上一步（Ctrl+Z）· 可撤销 ${canUndo} 步`;
      const redoBtn = util.$('#btn-redo');
      if (redoBtn) redoBtn.title = `重做（Ctrl+Y）· 可重做 ${canRedo} 步`;
      UI.updateClearSelect();
      UI.refreshLoadHint();
    },

    /**
     * 「✕ 取消选择」按钮的可用状态（#8）：
     * 只有真的选中了东西（点选单个元素，或框选出一批）才可点。
     * 选中状态由 Editor 持有（selection / multiSelect），所以每次 updateStatus 都会重算一遍 ——
     * 点选、框选、Esc、删除之后的自动取消，全都走同一条更新路径，不会出现"按钮亮着却没东西可取消"。
     */
    updateClearSelect() {
      const btn = util.$('#btn-clear-select');
      if (!btn) return false;
      const ed = window.G && window.G.Editor;
      let n = 0;
      if (ed) {
        if (ed.selection) n += 1;
        n += (ed.multiSelect || []).length;
      }
      const on = n > 0;
      btn.disabled = !on;
      btn.setAttribute('aria-disabled', on ? 'false' : 'true');
      btn.title = on
        ? `取消选择（当前选中 ${n} 个元素 / 框选结果）· 也会清掉框选与属性检查器 · Esc 同效`
        : '取消选择：先在地图上点选或框选元素，这个按钮才会亮起来';
      btn.classList.toggle('active', on);
      return on;
    },

    /** 「✕ 取消选择」：清掉点选与框选结果，并刷新属性检查器（#8） */
    clearSelection() {
      const ed = window.G && window.G.Editor;
      if (!ed || typeof ed.deselect !== 'function') return false;
      const had = !!ed.selection || (ed.multiSelect || []).length > 0;
      ed.deselect();                       // 同时清 selection / multiSelect / lastBoxRect，并收起检查器
      UI.updateClearSelect();
      UI.updateStatus();
      if (had) util.statusHint('已取消选择（框选结果也一并清掉）');
      return had;
    },

    /** 「这一片太密，正在分块加载…」——状态栏与 MapData 用同一句话（别两处各写一套） */
    LOAD_HINT_TEXT: '这一片太密，正在分块加载…',
    /** 这句话现在是不是我们挂上去的（只为"数据补齐后自己撤掉"记账，不去动别人的提示） */
    _loadHintOn: false,

    /**
     * 刷新"数据还在路上"的提示。
     *
     * **只在确实还缺数据时才算数**：`MapData.lastCapped` 还在（有块被服务器截断、且没被子块补齐）
     * **并且** `completeness().complete === false`（这一屏真的不完整）。
     * 只是客户端内部把视野拆成几块重取、最终拿全了的那种，lastCapped 会被清掉 / complete 为 true
     * —— **不提示**：玩家不需要知道我们内部分了几块。
     *
     * 提示会随数据补齐**自动消失**，也不重复刷屏（同一句话只在状态变化时写一次；
     * 撤掉时也只在自己那句话还挂着的时候才清空，不覆盖别人的状态提示）。
     */
    refreshLoadHint() {
      const box = util.$('#status-hint');
      let needy = false;
      try {
        const capped = !!(MapData && MapData.lastCapped);
        const comp = (MapData && typeof MapData.completeness === 'function') ? MapData.completeness() : null;
        needy = capped && !!comp && comp.complete === false;
      } catch { needy = false; }
      if (needy) {
        if (box && box.textContent !== UI.LOAD_HINT_TEXT) {
          util.statusHint(UI.LOAD_HINT_TEXT);
          UI._loadHintOn = true;
        }
        return true;
      }
      if (UI._loadHintOn && box && box.textContent === UI.LOAD_HINT_TEXT) util.statusHint('');
      UI._loadHintOn = false;
      return false;
    },

    setCoords(latlng) {
      util.$('#status-coords').textContent = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
    },

    connection(state) {
      const box = util.$('#conn');
      box.className = 'conn ' + state;
      box.textContent = {
        connecting: '连接中…', open: '已连接', reconnecting: '重连中…',
        unauthorized: '登录已过期', closed: '未连接',
      }[state] || state;
      // 连上之后如果正开着人口/活跃度图层，补一次格子数据（拿到 token 才能取）
      if (state === 'open' && Render.isCellMode()) Render.ensureCells(false);
      if (state === 'unauthorized') {
        localStorage.removeItem('osmcity.token');
        util.toast('登录状态已失效，请重新登录', 'warn', 5000);
        UI.showLogin();
      }
    },

    /* ------------------------------ 协作者 ------------------------------ */
    setPlayers(players) {
      UI.players = players;
      const box = util.$('#player-list');
      util.$('#collab-count').textContent = String(players.length);
      box.innerHTML = '';
      for (const p of players) {
        const li = util.el('li', p.id === UI.myId ? 'me' : '');
        const state = p.select ? `正在编辑 #${p.select.id}` : '浏览中';
        li.innerHTML = `<span class="dot" style="--c:${util.esc(p.color)}"></span>
          <span class="pname">${util.esc(p.name)}${p.id === UI.myId ? ' <em>（我）</em>' : ''}</span>
          <span class="pstate">${util.esc(state)}</span>`;
        li.title = '点击跟随该协作者的视角';
        li.onclick = () => {
          if (typeof p.lat !== 'number') return;
          if (!util.flyToSafe(Editor.map, p.lat, p.lon)) util.toast(`${p.name} 的位置暂时不可用`, 'warn', 2000);
          else util.toast(`正在跟随 ${p.name}`, 'info', 1500);
        };
        box.appendChild(li);
      }
      if (!players.length) box.innerHTML = '<li class="empty-hint small">暂无其他协作者</li>';
      Editor.players = players;
      Render.overlay.redraw();
    },

    setLocks(locks) {
      UI.locks = locks || {};
      const box = util.$('#lock-list');
      box.innerHTML = '';
      const entries = Object.entries(UI.locks);
      if (!entries.length) {
        box.innerHTML = '<li class="empty-hint small">当前没有元素被锁定</li>';
        return;
      }
      for (const [key, info] of entries) {
        const color = UI.colorOf(info.userId);
        const li = util.el('li', '');
        li.innerHTML = `<span class="dot" style="--c:${util.esc(color)}"></span>
          <span class="pname">${util.esc(info.name)}</span>
          <span class="pstate">${util.esc(key.replace(':', ' #'))}</span>`;
        li.onclick = () => {
          const [type, id] = key.split(':');
          if (Editor.map && World.get(type, Number(id))) Render.flyToElement(type, Number(id));
        };
        box.appendChild(li);
      }
      Render.overlay.redraw();
    },

    colorOf(userId) {
      const p = UI.players.find((x) => x.id === userId);
      return (p && p.color) || '#ff6b6b';
    },

    /* ------------------------------ 聊天 ------------------------------ */
    chat(from, text, ts) {
      const log = util.$('#chat-log');
      if (!log) return;
      const row = util.el('div', 'msg');
      row.innerHTML = `<span class="who" style="--c:${util.esc(from.color)}">${util.esc(from.name)}</span>
        <span class="text">${util.esc(text)}</span>
        <span class="time">${new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>`;
      log.appendChild(row);
      while (log.children.length > 150) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    },

    systemMessage(text) {
      const log = util.$('#chat-log');
      if (!log) return;
      const row = util.el('div', 'msg sys', `<span class="text">${util.esc(text)}</span>`);
      log.appendChild(row);
      while (log.children.length > 150) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    },

    /* ------------------------------ 搜索 ------------------------------ */
    toggleSearch(on) {
      const panel = util.$('#search-panel');
      const show = on === undefined ? panel.classList.contains('hidden') : on;
      panel.classList.toggle('hidden', !show);
      if (show) util.$('#search-input').focus();
      else util.$('#search-input').value = '';
    },

    async runSearch() {
      const input = util.$('#search-input');
      const q = input.value.trim();
      const list = util.$('#search-results');
      if (!q) { list.innerHTML = ''; return; }
      let url = '/api/search?';
      if (q.includes('=')) {
        const [k, v] = q.split('=');
        url += `key=${encodeURIComponent(k.trim())}&value=${encodeURIComponent((v || '').trim())}`;
      } else if (/^[a-z_]+(:[a-z_]+)?$/i.test(q) && q.includes('_')) {
        url += `key=${encodeURIComponent(q)}`;
      } else {
        url += `name=${encodeURIComponent(q)}`;
      }
      url += `&token=${encodeURIComponent(Net.token || '')}`;
      list.innerHTML = '<li class="empty-hint small">搜索中…</li>';
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '搜索失败');
        list.innerHTML = '';
        if (!data.results.length) {
          list.innerHTML = '<li class="empty-hint small">没有找到匹配的元素</li>';
          return;
        }
        for (const r of data.results) {
          const tags = r.tags || {};
          const name = tags.name || tags['name:zh'] || tags.ref || '(无名)';
          const kind = tags.highway || tags.building || tags.amenity || tags.landuse || tags.natural || tags.railway || tags.waterway || tags.shop || tags.tourism || '';
          const li = util.el('li', '');
          li.innerHTML = `<span class="s-type">${{ node: '点', way: '线/面', relation: '关系' }[r.type]}</span>
            <span class="s-name">${util.esc(name)}</span>
            <span class="s-tags">${util.esc(kind)}</span>
            <span class="s-id">#${r.id}</span>`;
          li.onclick = async () => {
            try {
              UI.toggleSearch(false);
              const center = r.center ? util.validLL(r.center) : null;
              if (center) {
                util.flyToSafe(Editor.map, center.lat, center.lng, Math.max(Editor.map.getZoom(), 18));
                await new Promise((resolve) => setTimeout(resolve, 700));
              }
              MapData.refresh();
              setTimeout(() => {
                try { Editor.select(r.type, r.id); } catch (err) { util.toast('打开元素失败：' + err.message, 'error'); }
              }, 400);
            } catch (err) {
              util.toast('跳转到该元素失败：' + err.message, 'error', 5000);
            }
          };
          list.appendChild(li);
        }
      } catch (err) {
        list.innerHTML = `<li class="empty-hint small">${util.esc(err.message)}</li>`;
      }
    },

    /* ------------------------------ 导出与历史 ------------------------------ */
    openExport() {
      const modal = util.$('#export-modal');
      modal.classList.remove('hidden');
      const box = util.$('#export-options');
      box.innerHTML = '';
      const token = encodeURIComponent(Net.token || '');
      const add = (label, href, desc) => {
        const a = util.el('a', 'export-btn', `<b>${util.esc(label)}</b><span>${util.esc(desc)}</span>`);
        a.href = href;
        a.setAttribute('download', '');
        box.appendChild(a);
      };
      const b = Editor.map.getBounds();
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      add('导出当前视野 (.osm)',
        `/api/export?minLon=${sw.lng}&minLat=${sw.lat}&maxLon=${ne.lng}&maxLat=${ne.lat}&token=${token}`,
        '只包含当前屏幕范围内的数据，适合小范围交换');
      add('导出全部数据 (.osm)',
        `/api/export?token=${token}`,
        '服务器数据集全量导出（较大的文件）');
      // 说明不再铺一段中文在面板里：全部收进标题栏那枚「?」（index.html 的 data-help）
    },

    async openHistory() {
      const modal = util.$('#history-modal');
      modal.classList.remove('hidden');
      const box = util.$('#history-list');
      box.innerHTML = '<div class="empty-hint small">加载中…</div>';
      try {
        const res = await fetch(`/api/history?token=${encodeURIComponent(Net.token || '')}&limit=60`);
        const data = await res.json();
        box.innerHTML = '';
        if (!data.changesets || !data.changesets.length) {
          box.innerHTML = '<div class="empty-hint small">还没有任何编辑记录</div>';
          return;
        }
        for (const cs of data.changesets) {
          const row = util.el('div', 'history-row' + (cs.reverted ? ' reverted' : ''));
          row.innerHTML = `<div class="hs-main">
              <span class="hs-author">${util.esc(cs.author_name || cs.author)}</span>
              <span class="hs-count">${cs.op_count} 处改动</span>
              <span class="hs-time">${util.fmtTime(cs.ts)}</span>
              ${cs.reverted ? '<span class="hs-flag">已回滚</span>' : ''}
            </div>
            <div class="hs-comment">${util.esc(cs.comment || '')}</div>`;
          const actions = util.el('div', 'hs-actions');
          const dl = util.el('a', 'mini', '下载 osmChange');
          dl.href = `/api/export/changeset/${cs.id}?token=${encodeURIComponent(Net.token || '')}`;
          dl.setAttribute('download', '');
          actions.appendChild(dl);
          const canRevert = !cs.reverted && (UI.meta.allowAnyRollback || cs.author === UI.myId);
          if (canRevert) {
            const rb = util.el('button', 'mini danger', '回滚');
            rb.onclick = () => {
              if (!window.confirm(`确定回滚 #${cs.id} 这个变更集的 ${cs.op_count} 处改动吗？`)) return;
              Net.op({ k: 'revertChangeset', id: cs.id })
                .then((ack) => {
                  util.toast(ack.label || '已回滚', 'success', 3000);
                  MapData.refresh();
                  UI.openHistory();
                })
                .catch((err) => util.toast(err.message, 'error', 5000));
            };
            actions.appendChild(rb);
          }
          row.appendChild(actions);
          box.appendChild(row);
        }
      } catch (err) {
        box.innerHTML = `<div class="empty-hint small">${util.esc(err.message)}</div>`;
      }
    },

    /* ------------------------------ 服务器资讯窗口 ------------------------------ */
    /**
     * 集中一处看服务器资讯：数据集来源与导入时间、要素总数、变更集、在线玩家、路网、
     * 人口（新口径）、活跃度格子数、游戏时钟与倍速、服务器运行时长。
     * 数据全部来自现成接口（/api/health、/api/meta、/api/transit、/api/history），服务器不用改。
     */
    openServerInfo() {
      const modal = util.$('#server-info');
      if (!modal) return;
      modal.classList.remove('hidden');
      UI.loadServerInfo();
    },

    async loadServerInfo() {
      const box = util.$('#server-info-body');
      if (box) box.innerHTML = '<div class="empty-hint small">正在读取服务器资讯…</div>';
      const token = encodeURIComponent(Net.token || '');
      const get = async (url) => {
        try {
          const res = await fetch(url);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
          return data;
        } catch (err) {
          return { __error: err && err.message ? err.message : String(err) };
        }
      };
      const [health, meta, transit, history] = await Promise.all([
        get('/api/health'),
        get('/api/meta'),
        get(`/api/transit?token=${token}`),
        get(`/api/history?token=${token}&limit=200`),
      ]);
      UI.renderServerInfo({ health, meta, transit, history });
    },

    renderServerInfo(d) {
      const box = util.$('#server-info-body');
      if (!box) return;
      box.innerHTML = '';
      const failed = (x) => !x || !!x.__error;
      const health = failed(d.health) ? {} : d.health;
      const meta = failed(d.meta) ? {} : d.meta;
      const tSnap = !failed(d.transit) ? ((d.transit && d.transit.data) || null) : null;
      const tLive = (Transit && Transit.data) || null;
      const snap = tSnap || tLive || {};
      const tStats = snap.stats || {};
      const info = meta.data || health.data || UI.info || {};

      const section = (title, note) => {
        const s = util.el('div', 'srv-section');
        const head = util.el('div', 'srv-section-title', util.esc(title) + (note ? ` <span class="srv-sub">${util.esc(note)}</span>` : ''));
        s.appendChild(head);
        box.appendChild(s);
        return s;
      };
      const row = (sec, k, html) => {
        const r = util.el('div', 'srv-row');
        r.appendChild(util.el('span', 'srv-k', util.esc(k)));
        r.appendChild(util.el('span', 'srv-v', html == null ? '—' : html));
        sec.appendChild(r);
        return r;
      };
      const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `<b>${util.fmt(v)}</b>`);
      const bold = (v) => (v == null || v === '' ? '—' : `<b>${util.esc(String(v))}</b>`);
      const fmtWhen = (v) => {
        if (!v) return '—';
        const t = new Date(v);
        return Number.isFinite(t.getTime()) ? util.fmtTime(t.getTime()) : util.esc(String(v));
      };
      const fmtDur = (sec) => {
        const s = Math.max(0, Math.round(Number(sec) || 0));
        const day = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (day) return `<b>${day}</b> 天 <b>${h}</b> 小时 <b>${m}</b> 分`;
        if (h) return `<b>${h}</b> 小时 <b>${m}</b> 分`;
        return `<b>${m}</b> 分 <b>${s % 60}</b> 秒`;
      };

      // 1) 数据集
      const secData = section('数据集');
      row(secData, '数据集来源', info.source ? util.esc(String(info.source)) : '本地数据集');
      row(secData, '导入时间', fmtWhen(info.importedAt));
      row(secData, '数据范围', info.bbox
        ? `${Number(info.bbox.minLat).toFixed(3)}~${Number(info.bbox.maxLat).toFixed(3)}°N · ${Number(info.bbox.minLon).toFixed(3)}~${Number(info.bbox.maxLon).toFixed(3)}°E`
        : '—');
      row(secData, '数据库大小', info.sizeBytes ? `<b>${util.fmtBytes(info.sizeBytes)}</b>` : '—');

      // 2) 要素总数与变更集（原来挤在顶栏上的那串数字都搬到这里）
      const secCount = section('要素总数与变更集');
      row(secCount, '节点', num(info.nodes));
      row(secCount, '道路 / 区域', num(info.ways));
      row(secCount, '关系', num(info.relations));
      row(secCount, '字段改动次数', num(info.changes));
      const cs = !failed(d.history) && d.history && Array.isArray(d.history.changesets) ? d.history.changesets : null;
      row(secCount, '变更集数量', cs
        ? `${num(cs.length)}${cs.length >= 200 ? ' <span class="srv-sub">（仅最近 200 条）</span>' : ''}`
        : '<span class="srv-sub">未知（需要登录）</span>');
      row(secCount, '锁定中的元素', num(health.locks));

      // 3) 在线与运行时长
      const secOnline = section('在线玩家与服务器');
      row(secOnline, '在线玩家', num(health.online));
      row(secOnline, '本房间协作者', num((UI.players || []).length));
      row(secOnline, '服务器运行时长', fmtDur(health.uptimeSec));

      // 4) 路网
      const lines = Array.isArray(snap.lines) ? snap.lines : [];
      const stations = Array.isArray(snap.stations) ? snap.stations : [];
      const railLines = lines.filter((l) => l && l.kind && l.kind !== 'bus').length;
      const busLines = lines.filter((l) => l && l.kind === 'bus').length;
      const railStations = stations.filter((s) => s && s.kind !== 'bus').length;
      const busStations = stations.filter((s) => s && s.kind === 'bus').length;
      const railGraph = tStats.rail || null;
      const secNet = section('路网（轨道 / 道路）');
      if (!tSnap && !tLive) {
        row(secNet, '交通数据', '<span class="srv-warn">暂不可用（未登录或服务器交通模块未就绪）</span>');
      }
      row(secNet, '轨道条数', railLines || railGraph ? `${num(railLines)} <span class="srv-sub">条线路</span>`
        + (railGraph && railGraph.ways != null ? ` · 铺轨 ${util.fmt(railGraph.ways)} 条 way · 轨道网节点 ${util.fmt(railGraph.nodes)}` : '') : num(0));
      row(secNet, '道路条数', `${num(busLines)} <span class="srv-sub">条公交线路</span>`);
      row(secNet, '车站', `${num(stations.length)} <span class="srv-sub">座（轨道 ${util.fmt(railStations)} · 公交 ${util.fmt(busStations)}）</span>`);
      row(secNet, '车辆', num((snap.vehicles || []).length));
      const wc = World.counts();
      row(secNet, '视野内已载入', `<span class="srv-sub">道路 ${util.fmt(wc.ways)} · 节点 ${util.fmt(wc.nodes)}（只统计已载入视野的本地缓存）</span>`);

      // 5) 人口（新口径）—— ⚠ 「岗位」不再显示：这个游戏里没有岗位系统
      //    （服务端默认也不算岗位，见 config.json 的 population.computeJobs）
      const pop = tStats.population || Render.cells.totals || null;
      const secPop = section('人口（新口径）');
      if (pop) {
        row(secPop, '总人口', num(pop.population));
        row(secPop, '人口网格', pop.cellM ? `<b>${pop.cellM}</b> 米一格 · <b>${util.fmt(pop.cells)}</b> 格` : num(pop.cells) + ' 格');
        row(secPop, '活跃度格子数', pop.activityCells == null ? '—'
          : `<b>${util.fmt(pop.activityCells)}</b> <span class="srv-sub">格（平均系数 ${Number(pop.activity || 0).toFixed(2)}）</span>`);
        row(secPop, '繁华格 / 冷清格', `${num(pop.activityHigh)} <span class="srv-sub">/</span> ${num(pop.activityLow)}`);
      } else {
        row(secPop, '人口模型', '<span class="srv-warn">暂不可用（交通模块未就绪或未登录）</span>');
        row(secPop, '活跃度格子数', '—');
      }

      // 6) 游戏时钟与倍速
      const clock = (tLive && tLive.clock) || snap.clock || null;
      const secClock = section('游戏时钟');
      if (clock) {
        row(secClock, '游戏时间', `第 <b>${clock.day || 1}</b> 天 <b>${util.esc(clock.time || '00:00')}</b>`);
        row(secClock, '倍速', Number(clock.speed) > 0 ? `<b>×${clock.speed}</b>` : '<b>⏸ 暂停</b>');
      } else {
        row(secClock, '游戏时间', '—');
      }
      const errs = [d.health, d.meta, d.transit, d.history].filter((x) => x && x.__error);
      if (errs.length) {
        const secErr = section('读取提示');
        for (const e of errs) row(secErr, '接口', `<span class="srv-warn">${util.esc(e.__error)}</span>`);
      }
    },

    /* ------------------------------ 登录 ------------------------------ */
    showLogin() {
      util.$('#login').classList.remove('hidden');
      util.$('#btn-logout').classList.add('hidden');
    },

    /**
     * **游客登录开关**（服务器 config.json 的 allowGuests，见 server/index.js）。
     *
     * 关闭时：藏掉「🚀 以游客身份先上任」按钮、露出 #guest-hint 那行中文说明，
     * 并把登录框的默认页签切到「注册新账号」（见下）；打开时反过来。
     * 注册 / 登录这两条流程本身完全照旧 —— 这个开关只关掉"免注册"那一条路。
     *
     * 按钮与提示节点**都留在 DOM 里**（只加/去 .hidden）：静态自检 tools/check-dom.js
     * 与 tests/browser-boot-e2e.js 都靠 `document.querySelector('#btn-guest')` 认这个入口，
     * 删节点会让它们红掉，而"藏起来"本来就够了。
     */
    applyGuestPolicy(meta) {
      const allowed = !(meta && meta.allowGuests === false);
      UI.allowGuests = allowed;
      const btn = util.$('#btn-guest');
      const hint = util.$('#guest-hint');
      if (btn) {
        btn.classList.toggle('hidden', !allowed);
        btn.disabled = !allowed;
        btn.title = allowed ? '以游客身份先上任（不需要注册）' : UI.GUEST_OFF_HINT;
      }
      if (hint) {
        hint.textContent = UI.GUEST_OFF_HINT + '。';
        hint.classList.toggle('hidden', allowed);
      }
      /**
       * 游客通道关着的时候，登录框默认停在**「注册新账号」**那一页：
       * 原来点「以游客身份先上任」的人（第一次来的新玩家）现在只能走注册，
       * 让他少点一下。提交按钮的文字也跟着页签走（见 syncLoginSubmitLabel），
       * 免得"注册页签 + 写着登录的按钮"这种让人点错的老毛病。
       */
      if (!allowed && !UI._guestTabsDefaulted) {
        const tabs = util.$$ ? util.$$('#login .tabs button') : [];
        const regTab = tabs.find((b) => b.dataset && b.dataset.tab === 'register');
        if (regTab) {
          tabs.forEach((b) => b.classList.remove('active'));
          regTab.classList.add('active');
        }
      }
      UI._guestTabsDefaulted = true;
      UI.syncLoginSubmitLabel();
      return allowed;
    },

    /** 提交按钮的文字跟着当前页签走：注册页签 → 「注册并上任」，否则 → 「登录」 */
    syncLoginSubmitLabel() {
      const tabs = util.$$ ? util.$$('#login .tabs button') : [];
      const active = tabs.find((b) => b.classList.contains('active'));
      const submit = util.$('#login-submit');
      if (submit && active && active.dataset) {
        submit.textContent = active.dataset.tab === 'register' ? '注册并上任' : '登录';
      }
    },

    hideLogin() {
      util.$('#login').classList.add('hidden');
      util.$('#btn-logout').classList.remove('hidden');
    },

    async submitLogin() {
      const name = util.$('#login-name').value.trim();
      const password = util.$('#login-pass').value;
      const errBox = util.$('#login-error');
      errBox.textContent = '';
      const isRegister = util.$('#login .tabs button.active').dataset.tab === 'register';
      try {
        const res = await fetch(isRegister ? '/api/register' : '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '登录失败');
        window.G.App.connectWithToken(data.token, data.user);
      } catch (err) {
        errBox.textContent = err.message;
      }
    },

    async guestLogin() {
      const errBox = util.$('#login-error');
      errBox.textContent = '';
      /**
       * 服务器关了游客登录时**不发这一次请求**：先在界面上把话说清楚（同一句中文），
       * 并把登录框摆出来（`?guest=1` 也走这里）。服务器那边同样会回 403，两边口径一致。
       */
      if (UI.allowGuests === false) {
        const hint = util.$('#guest-hint');
        if (hint) { hint.textContent = UI.GUEST_OFF_HINT + '。'; hint.classList.remove('hidden'); }
        errBox.textContent = UI.GUEST_OFF_HINT;
        UI.showLogin();
        return;
      }
      try {
        const res = await fetch('/api/guest', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '无法以游客身份加入');
        window.G.App.connectWithToken(data.token, data.user);
      } catch (err) {
        errBox.textContent = err.message;
      }
    },

    /* ------------------------------ 事件绑定 ------------------------------ */
    bind() {
      // 交通玩法：顶栏时钟 = 「暂停/继续」按钮 + 「倍速与跳到」菜单按钮（两个独立控件，不再一个按钮兼两职）
      const pauseBtn = util.$('#clock-pause');
      if (pauseBtn) pauseBtn.onclick = () => UI.toggleClockPause();
      const clockBtn = util.$('#clock-speed');
      if (clockBtn) clockBtn.onclick = (ev) => {
        if (!Transit) return;
        if (ev && ev.shiftKey) { Transit.cycleSpeed(); return; }   // Shift+点击：顺序切下一档
        UI.toggleClockMenu();
      };
      // 菜单里那行「跳到…」+ 两个按钮的文案（把 transit.js 的 renderClock / renderClockMenu 包一层）
      UI.installClockControls();
      // 点菜单以外的地方、或按 Esc 就收起菜单
      document.addEventListener('click', (ev) => {
        if (Transit && (!ev.target || !ev.target.closest || !ev.target.closest('#clock-box'))) {
          Transit.toggleClockMenu(false);
        }
        // 工具选项里的「?」弹层：点弹层自己或按钮以外的地方就收起
        if (!ev.target || !ev.target.closest || !ev.target.closest('.opt-pop, .opt-help')) UI.closeHelpPops();
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && Transit && typeof Transit.toggleClockMenu === 'function') Transit.toggleClockMenu(false);
      });
      // 「🛠 管理器」按钮（#line-mgr）已经彻底删除（交通面板每个分区本身就是管理器），
      // 所以这里不再绑定任何按钮；线路管理器的独立窗口仍然保留，由代码调用：
      //   window.G.LineMgr.open(...) / UI.openLineMgr()
      const transitBtn = util.$('#btn-transit');
      if (transitBtn) transitBtn.onclick = () => {
        if (!Transit) return;
        if (Transit.panelOpen) Transit.closePanel();
        else Transit.openPanel('company');
      };
      const transitClose = util.$('#transit-close');
      if (transitClose) transitClose.onclick = () => Transit && Transit.closePanel();
      const popToggle = util.$('#pop-toggle');
      if (popToggle) popToggle.onchange = () => UI.togglePopulationLayer(popToggle.checked);
      const actToggle = util.$('#activity-toggle');
      if (actToggle) actToggle.onchange = () => UI.toggleActivityLayer(actToggle.checked);

      // 服务器资讯窗口（顶栏按钮 + 顶栏数据集徽标都能打开）
      const infoBtn = util.$('#btn-server-info');
      if (infoBtn) infoBtn.onclick = () => UI.openServerInfo();
      const infoRefresh = util.$('#server-info-refresh');
      if (infoRefresh) infoRefresh.onclick = () => UI.loadServerInfo();
      const infoClose = util.$('#server-info-close');
      if (infoClose) infoClose.onclick = () => util.$('#server-info').classList.add('hidden');

      util.$('#btn-search').onclick = () => UI.toggleSearch();
      const undoBtn = util.$('#btn-undo');
      if (undoBtn) undoBtn.onclick = () => Editor.undo();
      const redoBtn = util.$('#btn-redo');
      if (redoBtn) redoBtn.onclick = () => Editor.redo();
      /**
       * 「✕ 取消选择」（#8）：紧跟在撤销 / 重做后面，只有真的选中了东西才可点。
       * 它清掉点选与**框选结果**（Editor.deselect 两样一起清），并收起属性检查器。
       */
      const clearSelBtn = util.$('#btn-clear-select');
      if (clearSelBtn) clearSelBtn.onclick = () => UI.clearSelection();
      UI.updateClearSelect();
      // 顶栏的「导出」「帮助」按钮已经下线，这里只保留面板自己的关闭按钮
      // （导出面板留着：tests/browser-osm-e2e.js 会用 G.UI.openExport() + #export-options 断言导出入口）
      const exportClose = util.$('#export-close');
      if (exportClose) exportClose.onclick = () => util.$('#export-modal').classList.add('hidden');
      util.$('#btn-history').onclick = () => UI.openHistory();
      util.$('#history-close').onclick = () => util.$('#history-modal').classList.add('hidden');
      util.$('#btn-logout').onclick = () => {
        localStorage.removeItem('osmcity.token');
        Net.disconnect();
        location.reload();
      };

      const searchInput = util.$('#search-input');
      searchInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') UI.runSearch();
        if (ev.key === 'Escape') UI.toggleSearch(false);
      });

      util.$('#chat-form').onsubmit = (ev) => {
        ev.preventDefault();
        const input = util.$('#chat-input');
        const text = input.value.trim();
        if (!text) return;
        if (!Net.connected) { util.toast('还没连上服务器', 'warn'); return; }
        Net.chat(text);
        input.value = '';
      };

      util.$$('#login .tabs button').forEach((btn) => {
        btn.onclick = () => {
          util.$$('#login .tabs button').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          UI.syncLoginSubmitLabel();   // 按钮文字跟着页签走（注册时不要再写着"登录"）
        };
      });
      util.$('#login-form').onsubmit = (ev) => { ev.preventDefault(); UI.submitLogin(); };
      util.$('#btn-guest').onclick = () => UI.guestLogin();

      document.addEventListener('keydown', (ev) => {
        const tag = (ev.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        if (ev.key === 'f' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); UI.toggleSearch(true); }
        if (ev.key === 'Escape') {
          util.$$('.modal').forEach((m) => { if (m.id !== 'login') m.classList.add('hidden'); });
          UI.toggleSearch(false);
        }
      });
    },
  };

  window.G.UI = UI;
})();
