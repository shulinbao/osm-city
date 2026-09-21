'use strict';
/**
 * 属性检查器：**只属于"选中的元素"** —— 显示它的类型、几何、数值设置、OSM 标签、操作与改动历史。
 * 标签修改走服务端校验（带版本号），冲突会明确提示。
 *
 * 分区（顺序固定，空的分区连标题一起收起，见 _syncSections）：
 *   标题    #insp-element-title / #insp-element-meta      类型 + id + 名字 + 版本 / 最后编辑者
 *   类型    #insp-presets     一个元素只有这一张类型表；芯片是**开关**：点一下换类型，再点同一个换回上一个
 *   几何    #insp-geometry    只放几何本身（节点数 / 长度 / 面积 / 坐标）
 *   属性    #insp-fields      这个元素自己的数值设置：建筑的楼层 + **由楼层推算的人口（也可直接改）**、道路限速
 *   标签    #insp-tags        原始标签表 + 快捷加标签
 *   操作    #insp-actions     元素级操作（反转、矩形化、闭合、复制、移动、删除…）
 *   关系 / 改动历史
 *
 * 两个"语境"：
 *   #inspector-create 创作面板（在**左侧「工具选项」面板**里，id 为了测试保留沿用）：
 *                     正在用新建工具、且没有选中元素时，配置"下一个要素"（名称/类型/楼层/设站模式）
 *   #inspector-body   元素面板：选中了元素时，看和改这个元素
 * 全站同时可见的类型选择器只能有一个：_selfCheckTypeChoosers 会数一遍（>1 就 console.warn）。
 */
(function () {
  const { util, World, Editor, Net, MapData } = window.G;

  const TYPE_NAME = { node: '点 (node)', way: '道路/区域 (way)', relation: '关系 (relation)' };

  /** 与服务端 server/population.js 的 contributionOf 保持一致：建筑面积 × 楼层 × 0.03 人/㎡/层 */
  const PEOPLE_PER_M2_FLOOR = 0.03;
  const POP_FORMULA_TIP = '人口 = 建筑面积(m²) × 楼层数(building:levels，缺省 1 层) × 0.03 人/㎡/层（与服务端一致）。<br>'
    + '<b>这一格可以直接改</b>：填人数 → 反推楼层 = 人数 ÷ (面积 × 0.03)，写回 <code>building:levels</code>。<br>'
    + '面积不足 20 m² 的区域不计入人口。';

  const Inspector = {
    current: null,
    data: null,
    dirty: false,

    init(options = {}) {
      Inspector.onSelectDeleted = options.onSelectDeleted || (() => {});
      util.$('#insp-add-tag').onclick = () => {
        if (!Inspector.current) return;
        const box = util.$('#insp-tags');
        const row = Inspector._tagRow('', '');
        box.appendChild(row);
        row.querySelector('.tag-key').focus();
      };
      return Inspector;
    },

    show(type, id) {
      if (!type || !id) return Inspector.hide();
      Inspector.current = { type, id };
      // 选中了元素 → 右栏归元素面板；左侧「工具选项」里的创作面板收起来
      // （全站同时可见的类型表只能有一套，#14 那个"两个建筑类型选择器"就是这么来的）
      Inspector._hideCreatePanel();
      util.$('#inspector-empty').classList.add('hidden');
      util.$('#inspector-body').classList.remove('hidden');
      Inspector.render();
      Inspector.loadRemote();
      Inspector._selfCheckTypeChoosers('元素面板');
    },

    /** 收起并清空"创作面板"（它在左侧「工具选项」面板里，见 showToolConfig） */
    _hideCreatePanel() {
      const box = util.$('#inspector-create');
      if (!box) return;
      box.classList.add('hidden');
      box.innerHTML = '';
    },

    hide() {
      Inspector.current = null;
      Inspector.data = null;
      util.$('#inspector-empty').classList.remove('hidden');
      util.$('#inspector-body').classList.add('hidden');
      Inspector._hideCreatePanel();
    },

    /**
     * 画之前的"创作面板"：还没选中任何元素、但正在用某个新建工具时，
     * **在左侧「工具选项」面板里**显示这个工具会写成什么标签，并让你先选类型/填名字/定楼层。
     *
     * 右栏（属性检查器）只属于选中的元素：没有选中元素时就显示"点一下地图上的元素"的提示，
     * 不再跟着创作面板变来变去 —— 这就是用户说的"工具选项和检查器各管一件事"。
     */
    showToolConfig() {
      const Editor = window.G.Editor;
      const tool = Editor ? Editor.tool : null;
      const drawTools = ['point', 'line', 'area', 'station'];
      const box = util.$('#inspector-create');
      const selected = !!(Inspector.current && World.get(Inspector.current.type, Inspector.current.id));
      if (!box) return;

      // 右栏：只有"选中的元素"和"没有选中"两种状态
      if (selected) {
        util.$('#inspector-empty').classList.add('hidden');
        util.$('#inspector-body').classList.remove('hidden');
      } else {
        util.$('#inspector-empty').classList.remove('hidden');
        util.$('#inspector-body').classList.add('hidden');
      }

      if (!drawTools.includes(tool) || selected) {
        Inspector._hideCreatePanel();
        return;
      }
      Inspector.current = null;
      box.classList.remove('hidden');
      box.innerHTML = '';

      const titles = { point: '📍 新建点要素', line: '📏 新建道路 / 线状要素', area: '⬛ 新建区域 / 建筑', station: '🚉 新建车站' };
      box.appendChild(util.el('div', 'insp-section-title', titles[tool] || '新建要素'));

      // 名称
      const nameRow = util.el('div', 'opt-field');
      const nameInput = util.el('input', 'opt-input');
      nameInput.placeholder = '名称（可留空，画完再填也行）';
      nameInput.value = (tool === 'station' && window.G.Transit && window.G.Transit.stationName) || Editor.drawName || '';
      nameInput.oninput = () => {
        if (tool === 'station' && window.G.Transit) window.G.Transit.stationName = nameInput.value;
        else Editor.drawName = nameInput.value;
        Inspector._renderWillWrite();
      };
      nameRow.appendChild(nameInput);
      box.appendChild(nameRow);

      // 设站模式（铁路/高铁/城际/地铁/轻轨/有轨电车/公交）：和交通面板的「设站模式」是**同一个**共享状态
      // （Transit.stationMode），芯片由 editor.js 的 renderStationModeChooser 唯一渲染（不在这里再写一份）
      if (tool === 'station') {
        if (Editor && typeof Editor.renderStationModeChooser === 'function') {
          box.appendChild(util.el('div', 'insp-section-title', '设站模式'));
          Editor.renderStationModeChooser(box, { title: null });
          box.appendChild(Inspector._tipRow('设站模式与交通面板里的是同一格设置：改一处，两处的高亮一起变。'));
        } else {
          const mode = window.G.Transit ? window.G.Transit.stationMode : 'rail';
          box.appendChild(util.el('div', 'tip', `当前设站模式：<b>${util.esc(mode)}</b>`));
        }
      }
      if (tool === 'area') {
        const chips = util.el('div', 'opt-chips');
        for (const [id, label] of [['building', '建筑'], ['landuse', '用地'], ['natural', '自然'], ['leisure', '休闲']]) {
          const b = util.el('button', 'chip' + (Editor.drawAreaKind === id ? ' active' : ''), label);
          b.onclick = () => {
            Editor.drawAreaKind = id;
            const preset = { building: { building: 'yes' }, landuse: { landuse: 'residential' }, natural: { natural: 'water' }, leisure: { leisure: 'park' } }[id];
            Editor.drawTags = Object.assign({}, Editor.drawTags || {}, preset);
            Inspector.showToolConfig();
          };
          chips.appendChild(b);
        }
        box.appendChild(chips);
        // 这一排是"画出来的几何算哪一类"（建筑 / 用地 / 自然 / 休闲），写进 OSM 的类型标签在下面那一段里选
        box.appendChild(Inspector._tipRow('这一排只决定"画出来的东西算哪一类"；真正写进 OSM 的类型标签在下面选。'
          + '点了「建筑」才会出现楼层滑块。'));
        if (Editor.drawAreaKind === 'building') {
          const floorRow = util.el('div', 'opt-field');
          floorRow.innerHTML = `<label>楼层 <b>${Editor.drawFloors}</b> 层 → 写入 building:levels</label>`;
          const range = util.el('input');
          range.type = 'range';
          range.min = '1';
          range.max = '60';
          range.value = String(Editor.drawFloors);
          range.oninput = () => {
            Editor.drawFloors = Number(range.value);
            Inspector.showToolConfig();
          };
          floorRow.appendChild(range);
          box.appendChild(floorRow);
        }
      }

      // 类型：唯一的类型选择器（建筑 / 道路 / 点要素各一张类表；类表没覆盖的要素才用预设表）
      if (tool !== 'station' && Editor && typeof Editor.renderTypeChooser === 'function') {
        const areaKind = Editor.drawAreaKind || 'building';
        const isBuildingArea = tool === 'area' && areaKind === 'building';
        const scope = tool === 'point' ? 'poi' : isBuildingArea ? 'building' : tool === 'line' ? 'road' : null;
        const titles = { poi: '点要素类型（POI）', building: '建筑类型', road: '道路等级' };
        const presetKind = tool === 'area' && !isBuildingArea ? 'area' : tool === 'point' ? 'point' : 'line';
        const presetKeys = (tool === 'area' && !isBuildingArea && typeof Editor.presetKeysForAreaKind === 'function')
          ? Editor.presetKeysForAreaKind(areaKind) : null;
        box.appendChild(util.el('div', 'insp-section-title', scope ? titles[scope] : `区域类型（${{ landuse: '用地', natural: '自然', leisure: '休闲' }[areaKind] || areaKind}）`));
        const picker = Editor.renderTypeChooser(box, {
          scope,
          classTitle: null,                        // 上面已经有一行标题了
          // 点要素那张表已经把"真正的点"合并进去了（editor.js 的 poiTypeGroups），所以只画一张表：
          // 点要素不再出现"POI + 其它点要素"两段重复列表
          presets: !isBuildingArea && scope !== 'poi',
          presetKind: isBuildingArea ? null : presetKind,
          presetKeys,
          presetTitle: scope ? '其它线状要素（铁路 / 水系 / 挡墙…）' : '选择类型',
          presetSearchPlaceholder: '搜索（铁路 / 河流 / 围墙…）',
          onPick: (item, sc) => {
            if (sc) {
              Editor.setDrawType(item, sc);
              util.toast(`新建时将写入「${item.name}」的标签`, 'success', 2600);
            } else {
              Editor.setDrawPreset(item);
              util.toast(`新建时将使用「${item.name}」：${Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join('，')}`, 'success', 3200);
            }
            Inspector.showToolConfig();
          },
          browseTitle: '新建要素用这个预设',
        });
        if (picker) {
          const tips = {
            poi: '点要素只建 node（没有几何）：选好类型后点一下地图就完成。列表最后是树、电线杆这类点状要素；'
              + '学校 / 医院 / 超市 / 银行 / 图书馆…是建筑，请用「⬛ 画面」画。',
            building: '建筑是画面工具围出来的多边形；楼层在下面调，名字在上面的输入框填。点状的 POI 请用「📍 加点」。',
            road: '道路只写 highway=*，不加名字（名字留给建筑）；限速在检查器的「限速」行里改。',
          };
          box.appendChild(Inspector._tipRow(scope && tips[scope]
            ? tips[scope]
            : '这一类要素没有自己的类型表，类型来自预设表（铁路 / 水系 / 用地 / 自然 / 休闲）：点一下决定画出来的要素写什么标签。'));
        }
      }

      const willWrite = util.el('div', 'will-write');
      box.appendChild(willWrite);
      Inspector._renderWillWrite();
      Inspector._selfCheckTypeChoosers('创作面板');
    },

    /** 创作面板里的一行小提示（标签 + ?，点开才是完整说明） */
    _tipRow(text) {
      const row = util.el('div', 'opt-row');
      row.appendChild(util.el('span', 'opt-row-label', '说明'));
      row.appendChild(Inspector._helpBtn(row, util.esc(text)));
      return row;
    },

    /**
     * 小「?」按钮 + 短弹层：按钮挂到 row 上（row 负责 position:relative）。
     * text 允许写 HTML（调用方自己保证转义）。返回按钮，方便调用方接着 append。
     */
    _helpBtn(row, text, title) {
      const btn = util.el('button', 'mini opt-help', '?');
      btn.type = 'button';
      btn.title = title || '点一下看说明';
      btn.setAttribute('aria-expanded', 'false');
      const pop = util.el('div', 'opt-pop hidden', text);
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const show = pop.classList.contains('hidden');
        if (window.G.UI && typeof window.G.UI.closeHelpPops === 'function') window.G.UI.closeHelpPops();
        pop.classList.toggle('hidden', !show);
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      };
      row.appendChild(btn);
      row.appendChild(pop);
      return btn;
    },

    _renderWillWrite() {
      // 创作面板里的那一行（全站只有这一个 .will-write：左栏「工具选项」里）
      const box = util.$('#inspector-create .will-write');
      if (!box || !window.G.Editor) return;
      const tool = window.G.Editor.tool;
      if (tool === 'station') {
        // 设站模式就是服务端的站点 kind：写清"要挨着什么放"，别再让玩家去猜 60/120 米
        const info = typeof window.G.Editor.stationModeInfo === 'function'
          ? window.G.Editor.stationModeInfo()
          : { ico: '🚉', name: '车站', id: window.G.Transit ? window.G.Transit.stationMode : 'rail', kind: 'rail' };
        const name = util.esc((window.G.Transit && window.G.Transit.stationName) || `新${info.name}站`);
        const where = info.kind === 'bus'
          ? '旁边任何一条能开车的道路（服务道路 / 土路 / 生活街区 / 各级主干道都行），服务端会就近吸附'
          : '旁边的轨道，服务端会就近吸附';
        box.innerHTML = `将创建：<b>${info.ico} ${util.esc(info.name)}站</b>（服务端 kind=${info.id}），名字「${name}」，放在${where}`;
        return;
      }
      const tags = window.G.Editor.defaultTagsFor(tool);
      const text = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join('，');
      box.innerHTML = `将写入标签：<b>${util.esc(text || '（无）')}</b>`;
    },

    /* ------------------------------ 自检：一个语境里只能有一套类型表 ------------------------------ */
    /**
     * 数一遍**同一个语境**里同时可见的类型选择器（.type-chooser）：
     *   右栏（#inspector）与创作面板（#inspector-create，住在左侧「工具选项」面板里）各算一个语境，
     *   每个语境里可见的必须 ≤ 1 —— 以前右栏里"元素面板的改类型"和"创作面板的新建类型"会同屏，
     *   于是用「画面」画完一栋楼会看到两个建筑类型选择器（#14）。
     * 「⬚ 框选」面板里的"批量改类型"是**批量**语境（一次改一批），与单个元素的类型表是两件事，不计入这里。
     * 只断言、不打扰玩家：数量 > 1 时 console.warn，并把数字挂在 Inspector._lastTypeChooserCount 上。
     */
    _selfCheckTypeChoosers(context) {
      const visibleIn = (rootSel) => {
        const root = util.$(rootSel);
        if (!root) return 0;
        return util.$$('.type-chooser', root).filter((n) => Inspector._isVisible(n)).length;
      };
      const element = visibleIn('#inspector');
      const create = visibleIn('#inspector-create');
      Inspector._lastTypeChooserCount = Math.max(element, create);
      Inspector._lastTypeChooserContext = context || '';
      if (element > 1 || create > 1) {
        console.warn(`[inspector] 自检失败：一个语境里出现多个类型选择器（语境：${Inspector._lastTypeChooserContext}）`
          + ` —— 右栏 ${element} 个、创作面板 ${create} 个；同一个语境只能有一套类型表。`);
      }
      return Inspector._lastTypeChooserCount;
    },

    /** 元素自己或任一祖先是 .hidden 就算不可见（创作面板 / 元素面板都是靠这个类互斥的） */
    _isVisible(node) {
      let n = node;
      while (n && n.classList) {
        if (n.classList.contains('hidden')) return false;
        n = n.parentNode;
      }
      return true;
    },

    refresh() {
      if (!Inspector.current) return;
      Inspector.render();
    },

    async loadRemote() {
      const cur = Inspector.current;
      if (!cur) return;
      try {
        const res = await fetch(`/api/element?type=${cur.type}&id=${cur.id}&token=${encodeURIComponent(Net.token || '')}`);
        if (!res.ok) throw new Error('元素不存在');
        const data = await res.json();
        if (!Inspector.current || Inspector.current.id !== cur.id || Inspector.current.type !== cur.type) return;
        Inspector.data = data;
        Inspector.renderRemote();
      } catch (err) {
        if (Inspector.current && Inspector.current.id === cur.id) {
          util.toast('无法加载元素详情：' + err.message, 'warn');
        }
      }
    },

    /* ------------------------------ 渲染 ------------------------------ */
    /**
     * 元素面板的渲染顺序就是面板上的分区顺序：
     * 标题 → 类型 → 几何 → 属性 → 标签 → 操作 → 关系 / 改动历史。
     * 每个分区只画自己的东西：几何里不再混着楼层控件，属性里也不会重复几何数字。
     */
    render() {
      const cur = Inspector.current;
      if (!cur) return;
      const el = World.get(cur.type, cur.id);
      if (!el) {
        Inspector.hide();
        Editor.deselect();
        return;
      }
      const tags = el.tags || {};

      // ---- 标题 ----
      const title = util.$('#insp-element-title');
      const name = tags.name || tags['name:zh'] || tags.ref;
      title.innerHTML = `<span class="insp-type">${TYPE_NAME[cur.type] || cur.type}</span>
        <span class="insp-id">#${cur.id}</span>
        ${name ? `<span class="insp-name">${util.esc(name)}</span>` : ''}`;

      const version = el.version || 0;
      const editor = el.editorName || (Inspector.data && Inspector.data.element ? Inspector.data.element.editorName : null);
      util.$('#insp-element-meta').textContent = `版本 ${version}${editor ? ' · 最后编辑：' + editor : ''}${World.isPinned(cur.type, cur.id) ? ' · 已锁定' : ''}`;

      // ---- 类型（一个元素只有一张类型表，芯片是开关）----
      Inspector.renderTypeSection(tags, cur.type, el);

      // ---- 几何（只放几何本身）----
      const geo = util.$('#insp-geometry');
      if (cur.type === 'node') {
        geo.innerHTML = `<span>坐标 ${el.lat.toFixed(6)}, ${el.lon.toFixed(6)}</span>`;
      } else if (cur.type === 'way') {
        const closed = World.isClosed(el);
        const length = World.wayLength(el);
        const area = closed ? World.wayArea(el) : 0;
        geo.innerHTML = `<span>${el.nodes.length} 个节点 · ${closed ? '闭合区域' : '开放线条'}</span>
          <span>长度 ${util.fmtLength(length)}</span>
          ${closed ? `<span>面积 ${util.fmtArea(area)}</span>` : ''}`;
      } else {
        geo.innerHTML = `<span>${el.members.length} 个成员</span>`;
      }

      // ---- 属性（建筑：楼层 + 由楼层推算的人口；道路：限速）----
      Inspector.renderFields(el, tags, cur.type);

      // ---- 标签 / 操作 / 历史 ----
      Inspector.renderTags(tags);
      Inspector.renderActions(cur.type, el);
      Inspector.renderHistory();
      Inspector._syncSections();
      Inspector._selfCheckTypeChoosers(`元素面板 #${cur.type}/${cur.id}`);
    },

    /**
     * 空的分区连标题一起收起（例如：没有标签行、没有所属关系、还没有改动历史时，
     * 面板上不该留一串空标题）。每个分区标题在 HTML 里带 data-sec，指向它的内容块。
     */
    _syncSections() {
      const map = {
        type: '#insp-presets',
        geometry: '#insp-geometry',
        fields: '#insp-fields',
        tags: '#insp-tags',
        actions: '#insp-actions',
        history: '#insp-history',
      };
      for (const key of Object.keys(map)) {
        const sec = util.$(`#inspector-body [data-sec="${key}"]`);
        const body = util.$(map[key]);
        if (!sec || !body) continue;
        sec.classList.toggle('hidden', !body.children.length);
      }
    },

    /**
     * 属性区（#insp-fields）：这个元素自己的数值设置。
     *   建筑：楼层（building:levels）+ 人口（**由楼层算出来的数字，也能直接改** ——
     *         改人数就是反推楼层写回 building:levels；没有单独的"按人数改楼层"按钮）
     *   道路：限速（maxspeed）
     */
    renderFields(el, tags, type) {
      const box = util.$('#insp-fields');
      if (!box) return;
      box.innerHTML = '';
      const isBuilding = type === 'way' && el && el.nodes && (tags.building || tags['building:part']);
      if (isBuilding) Inspector._renderBuildingFields(box, el, tags);
      Inspector.renderRoadLimits(box, el, tags, type);
    },

    /** 建筑的属性：楼层 + 人口（两者同一个公式，改哪个都行） */
    _renderBuildingFields(box, el, tags) {
      const area = World.wayArea(el);
      const levels = Inspector.levelsOf(tags);
      const raw = String(tags['building:levels'] || '').replace(/[^\d.]/g, '');
      const people = () => Math.round(area * Inspector.levelsOf(tags) * PEOPLE_PER_M2_FLOOR);

      // 楼层：直接写 building:levels
      const floorRow = util.el('div', 'floors-ctl');
      floorRow.title = '楼层会写成 building:levels 标签；一次改动 = 一步撤销';
      floorRow.appendChild(util.el('label', null, '楼层'));
      const floorInput = util.el('input');
      floorInput.type = 'number';
      floorInput.min = '1';
      floorInput.max = '200';
      floorInput.value = raw || '';
      floorInput.placeholder = '如 6';
      floorInput.dataset.field = 'levels';
      const applyFloor = () => {
        const v = String(floorInput.value || '').trim();
        if (!v) { Inspector.setTag('building:levels', null); return; }
        Inspector.setTag('building:levels', String(Math.max(1, Math.min(200, Number(v) || 1))));
      };
      const applyBtn = util.el('button', 'mini', '应用');
      applyBtn.onclick = applyFloor;
      floorInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFloor(); });
      const up = util.el('button', 'mini', '＋1 层');
      up.onclick = () => Inspector.setTag('building:levels', String(Math.min(200, Math.round(Inspector.levelsOf(tags)) + 1)));
      floorRow.appendChild(floorInput);
      floorRow.appendChild(applyBtn);
      floorRow.appendChild(up);
      box.appendChild(floorRow);

      // 人口：**由楼层推算**的数字，也能直接改（= 反推楼层）
      const popRow = util.el('div', 'floors-ctl pop-people');
      popRow.appendChild(util.el('label', null, '人口'));
      const popInput = util.el('input');
      popInput.type = 'number';
      popInput.min = '0';
      popInput.value = area > 0 ? String(people()) : '';
      popInput.placeholder = '人数';
      popInput.dataset.field = 'people';
      const unit = util.el('span', 'field-note', '人');
      const note = util.el('span', 'field-note', '');
      const renderNote = (lv) => {
        note.innerHTML = `≈ 面积 ${util.fmt(area)} m² × ${lv} 层 × 0.03`;
        note.title = POP_FORMULA_TIP;
      };
      renderNote(levels);
      const applyPeople = () => {
        const want = Number(popInput.value);
        if (!Number.isFinite(want) || want <= 0) { util.toast('请填写大于 0 的人数', 'warn'); return; }
        if (!(area > 0)) { util.toast('这个区域还没有面积，无法换算人口', 'warn'); return; }
        const lv = Inspector.levelsForPeople(area, want);
        const back = Math.round(area * lv * PEOPLE_PER_M2_FLOOR);
        // 先就地显示反推结果（服务端确认后 refresh() 会整块重绘）
        popInput.value = String(back);
        renderNote(lv);
        util.statusHint(`按 ${util.fmt(want)} 人反推：${lv} 层 ≈ ${util.fmt(back)} 人，正在写入 building:levels…`);
        Inspector.setTag('building:levels', String(lv));
      };
      popInput.addEventListener('change', applyPeople);
      popInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPeople(); });
      popRow.appendChild(popInput);
      popRow.appendChild(unit);
      popRow.appendChild(note);
      Inspector._helpBtn(popRow, POP_FORMULA_TIP, '人口是怎么算出来的？');
      box.appendChild(popRow);
    },

    /**
     * 改类型：一个元素只有**一个**类型选择器（#insp-presets），芯片是**开关**：
     * 点未选中的 = 换成这套类型（芯片高亮），再点同一个高亮的芯片 = 换回上一个类型。
     * 建筑 / 道路 / 点要素用编辑器里的类表（BUILDING_TYPES / ROAD_TYPES / POI_GROUPS），
     * 类表覆盖不到的要素（铁路、水系、用地、自然、休闲…）才退回预设表 —— 一个元素永远只有一张表。
     */
    renderTypeSection(tags, type, el) {
      const box = util.$('#insp-presets');
      if (!box) return;
      box.innerHTML = '';
      // 关系不是"点/线/面"里的任何一类：它没有类型芯片可点（成员与角色在下面的关系区里看）
      if (type === 'relation') return;
      const Editor = window.G.Editor;
      if (!Editor || typeof Editor.renderTypeChooser !== 'function') return;

      const scope = typeof Editor.typeScopeFor === 'function' ? Editor.typeScopeFor(type, el) : null;
      const kind = type === 'node' ? 'point' : (type === 'way' ? (World.isClosed(el) ? 'area' : 'line') : null);
      // 类表没覆盖的要素：只按它自己的主标签过滤预设表（河流看水系、公园看用地/休闲…）
      const keys = scope ? null : (typeof Editor.primaryKeysOf === 'function' ? Editor.primaryKeysOf(tags) : null);

      const wrap = Editor.renderTypeChooser(box, {
        scope,
        // 这一块整占一行并纵向排列（面板里别和别的控件挤在一行）
        classTitle: null,
        matchTags: tags,                     // 元素当前的类型会高亮成 active
        // 有类表就只列类表：一个元素绝不出现两套等价类型表
        presets: !scope,
        presetKind: scope ? null : kind,
        presetKeys: scope ? null : (keys && keys.length ? keys : null),
        presetTitle: '其它类型（预设表：铁路 / 水系 / 用地 / 自然…）',
        onPick: (item, sc, current) => Editor.applyTypeToggle(item, sc, current),
      });
      if (!wrap) return;
      wrap.style.width = '100%';
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '4px';
      const tip = scope === 'building'
        ? '只换用途：name、building:levels、地址等标签会保留（例如 学校 → building=school + amenity=school）。'
        : scope === 'road'
          ? '道路只写 highway=*：不会加名字标签，原有的 name/name:zh 会被清掉（标签留给建筑）；限速在「限速」行里改。'
          : scope === 'poi'
            ? 'POI 只写在 node 上：换类型会替换 amenity/shop/tourism 等同义标签，名称与地址保留。'
            : '这一类要素没有自己的类型表（如铁路 / 水系 / 用地 / 自然）：类型来自预设表，点一下把标签合并上去。';
      wrap.appendChild(util.el('div', 'preset-hint', '点一下换类型（高亮的那个是当前类型）· 再点同一个换回上一个类型'));
      const row = util.el('div', 'opt-row');
      row.appendChild(util.el('span', 'opt-row-label', '改类型'));
      row.appendChild(Inspector._helpBtn(row, util.esc(tip)));
      wrap.appendChild(row);
    },

    /**
     * 道路自己的设置：限速（maxspeed）。
     * 逐条道路的入口（写在道路自己的属性里）；框选面板里只留一个"批量"次级入口，
     * 两边都调 Editor.setMaxspeed —— 同一段代码，一条道路 = 一个 op = 一步撤销。
     */
    renderRoadLimits(box, el, tags, type) {
      const Editor = window.G.Editor;
      if (!box || type !== 'way' || !el || !el.nodes || !Editor || typeof Editor.setMaxspeed !== 'function') return;
      const cls = tags.highway;
      if (!cls) return;                                  // 没有 highway 等级就不是道路（铁路/水系走预设表）
      if (World.isClosed(el)) return;                    // 闭合的道路环不在这里改限速
      const def = typeof Editor.maxspeedDefaultFor === 'function' ? Editor.maxspeedDefaultFor(cls) : null;
      const cur = tags.maxspeed ? String(tags.maxspeed) : '';
      const curNum = cur.replace(/[^\d.]/g, '');          // 有的数据写 "30 km/h"，比芯片时只看数字

      const row = util.el('div', 'floors-ctl road-speed-ctl');
      row.title = '限速会写成这条道路的 maxspeed 标签；一次改动就是一个 op，Ctrl+Z 一步撤销';
      row.appendChild(util.el('label', null, '限速'));
      const now = util.el('b', null, cur ? `${util.esc(cur)} km/h` : '未设置');
      now.title = row.title;
      row.appendChild(now);
      const src = util.el('span', 'field-note', `等级 ${util.esc(cls)}${def ? ` · 默认 ${def}` : ''}`);
      row.appendChild(src);
      if (curNum && def && curNum !== def) {
        const diff = util.el('span', 'field-note', '（与默认值不同）');
        diff.style.color = 'var(--warn)';
        row.appendChild(diff);
      }
      Inspector._helpBtn(row, '点一个数字即提交（一步撤销）；<br>'
        + '「按等级填默认值」写入该 <code>highway</code> 等级的默认限速，「清除」删掉 maxspeed。');
      box.appendChild(row);

      const chips = util.el('div', 'opt-chips');
      const choices = Editor.MAXSPEED_CHOICES || ['5', '15', '20', '30', '40', '50', '60', '70', '80', '100', '120'];
      for (const speed of choices) {
        const chip = util.el('button', 'chip small' + (curNum === speed ? ' active' : ''), speed);
        chip.title = `把这条道路的限速写成 maxspeed=${speed}（km/h）`;
        chip.onclick = () => Inspector.setRoadMaxspeed(speed);
        chips.appendChild(chip);
      }
      box.appendChild(chips);

      const acts = util.el('div', 'opt-actions');
      const input = util.el('input');
      input.type = 'number';
      input.min = '0';
      input.max = '400';
      input.placeholder = '自定义';
      input.value = curNum && !choices.includes(curNum) ? curNum : '';
      input.title = '自定义限速（km/h）：填一个数字，点「应用」或按回车';
      const apply = util.el('button', 'mini', '应用');
      apply.onclick = () => {
        const v = String(input.value || '').trim();
        if (!v) { util.toast('请先填一个限速值（km/h）', 'warn'); return; }
        Inspector.setRoadMaxspeed(v);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply.onclick(); });
      acts.appendChild(input);
      acts.appendChild(apply);

      const byClass = util.el('button', 'mini', '按等级填默认值');
      byClass.disabled = !def;
      byClass.title = def
        ? `按 highway=${cls} 填类表里的默认值 ${def} km/h`
        : `highway=${cls} 在限速表里没有默认值，请直接选一个数字`;
      byClass.onclick = () => Inspector.setRoadMaxspeed('class');
      acts.appendChild(byClass);

      const clear = util.el('button', 'mini danger', '清除');
      clear.disabled = !cur;
      clear.title = '删除这条道路的 maxspeed 标签';
      clear.onclick = () => Inspector.setRoadMaxspeed(null);
      acts.appendChild(clear);
      box.appendChild(acts);
    },

    /** 提交这条道路的限速：value = 数字（km/h）/ 'class'（按等级填默认值）/ null（清除） */
    setRoadMaxspeed(value) {
      const cur = Inspector.current;
      const Editor = window.G.Editor;
      if (!cur || cur.type !== 'way' || !Editor || typeof Editor.setMaxspeed !== 'function') return;
      const spec = value === null ? { kind: 'clear' }
        : value === 'class' ? { kind: 'class', overwrite: true }
          : { kind: 'value', value: String(value) };
      Editor.setMaxspeed([cur.id], spec);
    },

    renderTags(tags) {
      const box = util.$('#insp-tags');
      box.innerHTML = '';
      const keys = Object.keys(tags);
      if (!keys.length) {
        box.appendChild(util.el('div', 'empty-hint small', '这个元素还没有标签。下面已经准备好常用的 name 行，直接填即可，或从预设里选一个。'));
      }
      for (const key of keys) box.appendChild(Inspector._tagRow(key, tags[key]));
      // 没有 name 就给一行空白的，省得手动加标签（留空不会写入）
      if (!tags.name) {
        const row = Inspector._tagRow('name', '');
        row.classList.add('tag-row-placeholder');
        row.querySelector('.tag-value').placeholder = '填名字（留空则不写入）';
        box.appendChild(row);
      }
      // 常用标签快捷添加（点一下就有 key，只需填值）
      // 注意：maxspeed 不在这里 —— 道路的限速有自己的「限速」行（见 renderRoadLimits），
      // 免得同一个标签有两个入口
      const QUICK = ['building:levels', 'name:zh', 'operator', 'opening_hours', 'addr:street', 'height', 'surface'];
      const chipRow = util.el('div', 'quick-tags');
      chipRow.appendChild(util.el('span', 'quick-label', '快捷加：'));
      for (const key of QUICK) {
        if (tags[key] !== undefined) continue;
        const chip = util.el('button', 'chip small', key);
        chip.onclick = () => {
          const row = Inspector._tagRow(key, '');
          box.appendChild(row);
          row.querySelector('.tag-value').focus();
        };
        chipRow.appendChild(chip);
      }
      box.appendChild(chipRow);
    },

    /** building:levels → 楼层数（缺省 1 层，允许小数） */
    levelsOf(tags) {
      const raw = Number(String((tags && (tags['building:levels'] || tags.levels)) || '').replace(/[^\d.]/g, ''));
      return Number.isFinite(raw) && raw > 0 ? raw : 1;
    },

    /** 反推楼层：面积 × 楼层 × 0.03 ≈ 人数 → 楼层 = 人数 ÷ (面积 × 0.03)，四舍五入且不少于 1 层 */
    levelsForPeople(area, people) {
      const perFloor = Number(area) * PEOPLE_PER_M2_FLOOR;
      const want = Number(people);
      if (!(perFloor > 0) || !Number.isFinite(want)) return 1;
      return Math.max(1, Math.min(200, Math.round(want / perFloor)));
    },

    /* 人口那一行在 _renderBuildingFields 里（和楼层同一段）：**
       服务端 population.js 的人口只由 building=* / building:part=* 推算，
       所以"人口"只出现在建筑的属性区，公园 / 水面 / 地块上没有这一行。 */

    _tagRow(key, value) {
      const row = util.el('div', 'tag-row');
      row.dataset.key = key;
      const kInput = util.el('input', 'tag-key');
      kInput.value = key;
      kInput.placeholder = 'key';
      kInput.spellcheck = false;
      const vInput = util.el('input', 'tag-value');
      vInput.value = value;
      vInput.placeholder = 'value';
      vInput.spellcheck = false;
      const del = util.el('button', 'tag-del', '×');
      del.title = '删除这个标签';

      const commit = () => {
        const next = Inspector._collectTags();
        if (next) Inspector.saveTags(next);
      };
      // 关键：只改了键、值还空着时不要保存——否则这一行会被当成"空值标签"删掉
      kInput.addEventListener('change', () => {
        if (!vInput.value.trim()) { vInput.focus(); return; }
        commit();
      });
      vInput.addEventListener('change', commit);
      kInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') vInput.focus(); });
      vInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
      del.onclick = () => {
        row.remove();
        commit();
      };
      row.appendChild(kInput);
      row.appendChild(vInput);
      row.appendChild(del);
      return row;
    },

    /** 直接设置/删除某个标签（供快捷按钮调用） */
    setTag(key, value) {
      const cur = Inspector.current;
      if (!cur) return;
      const el = World.get(cur.type, cur.id);
      if (!el) return;
      const tags = Object.assign({}, el.tags || {});
      if (value === null || value === undefined || String(value).trim() === '') delete tags[key];
      else tags[key] = String(value).trim();
      Inspector.saveTags(tags);
    },

    _collectTags() {
      const rows = util.$$('#insp-tags .tag-row');
      const out = {};
      for (const row of rows) {
        const k = row.querySelector('.tag-key').value.trim();
        const v = row.querySelector('.tag-value').value.trim();
        if (!k) continue;
        if (v === '') continue; // 空值视为删除该标签
        out[k] = v;
      }
      return out;
    },

    saveTags(tags) {
      const cur = Inspector.current;
      if (!cur) return;
      const el = World.get(cur.type, cur.id);
      if (!el) return;
      const keyCount = Object.keys(tags).length;
      const op = cur.type === 'node'
        ? { k: 'updateNode', id: cur.id, version: el.version, tags }
        : cur.type === 'way'
          ? { k: 'updateWay', id: cur.id, version: el.version, tags }
          : { k: 'updateRelation', id: cur.id, version: el.version, tags };
      util.statusHint('正在保存标签…');
      Net.op(op)
        .then(() => {
          util.statusHint(`${keyCount} 个标签已保存`);
          Inspector.refresh();
          Inspector.loadRemote();
        })
        .catch((err) => {
          util.statusHint('');
          util.toast(err.message, 'error', 6000);
          Inspector.loadRemote();
        });
    },

    /* ------------------------------ 操作按钮 ------------------------------ */
    renderActions(type, el) {
      const box = util.$('#insp-actions');
      box.innerHTML = '';
      const add = (act, label, title) => {
        const b = util.el('button', '', label);
        b.dataset.act = act;
        if (title) b.title = title;
        b.onclick = () => Inspector._action(act);
        box.appendChild(b);
        return b;
      };
      if (type === 'way') {
        // 延伸/分割/合并现在住在「画线」工具的面板里（select 工具不再放这些按钮）
        add('drawtools', '⌁ 画线改造（延伸/分割/合并/加点）', '切到「画线」工具：左侧面板里可以延伸起点/终点、在此处分割、与相邻道路合并、加点删点');
        add('reverse', '⇄ 反转方向', '反转节点的先后顺序（影响单行道方向等）');
        if (World.isClosed(el)) add('rect', '📐 矩形化', '把轮廓整理成矩形');
        add('toggle-close', World.isClosed(el) ? '断开闭合' : '闭合首尾', '把首尾节点连起来或断开');
        add('copy', '⧉ 复制', '复制一份并偏移约 8 米');
        add('relation', '＋ 新建多面体关系', '把这条道路变成一个 type=multipolygon 关系的外环');
      } else if (type === 'node') {
        add('join', '⊙ 合并到别的节点', '选择「合点」工具后点击目标节点');
        add('copy', '⧉ 复制');
      }
      add('move', '✥ 移动', '切到「移动」工具后，拖住这个元素把它挪到新位置');
      add('delete', '🗑️ 删除', '删除元素（Ctrl+Z 可撤销）');
      add('zoom', '🎯 居中显示');
    },

    _action(act) {
      const cur = Inspector.current;
      if (!cur) return;
      const el = World.get(cur.type, cur.id);
      if (!el) return;
      switch (act) {
        case 'drawtools':
          Editor.setTool('line');
          if (window.G.UI) window.G.UI.selectTool('line');
          util.toast('已切到「画线」工具：左侧面板里有 延伸起点/终点、在此处分割、与相邻道路合并、加点/删点', 'info', 6000);
          break;
        case 'rect': Editor.orthogonalizeSelection(); break;
        case 'copy': Editor.duplicateSelection(); break;
        case 'join': Editor.setTool('joinnode'); util.toast('请点击要合并到的目标节点', 'info', 3000); break;
        case 'move':
          Editor.setTool('move');
          util.toast('已切到「移动」工具：按住左键把选中的元素拖到新位置，松开即提交（一步撤销）', 'info', 5000);
          break;
        case 'zoom': if (window.G.Render) window.G.Render.flyToElement(cur.type, cur.id); break;
        case 'delete': Editor.deleteSelection(); break;
        case 'reverse': {
          Net.op({ k: 'reverseWay', id: cur.id, version: el.version })
            .then(() => { util.toast('已反转方向', 'success'); Inspector.loadRemote(); Inspector.refresh(); })
            .catch((err) => util.toast(err.message, 'error'));
          break;
        }
        case 'toggle-close': {
          const nodes = el.nodes.slice();
          const closed = World.isClosed(el);
          let points;
          if (closed) points = nodes.slice(0, -1).map((id) => ({ id }));
          else points = nodes.concat([nodes[0]]).map((id) => ({ id }));
          if (points.length < 2) { util.toast('节点太少', 'warn'); return; }
          Net.op({ k: 'updateWay', id: cur.id, version: el.version, points, tags: el.tags })
            .then(() => { util.toast(closed ? '已断开闭合' : '已闭合', 'success'); Inspector.refresh(); Inspector.loadRemote(); })
            .catch((err) => util.toast(err.message, 'error'));
          break;
        }
        case 'relation': {
          if (el.tags && el.tags.type) { util.toast('这条道路已经是一个关系的成员了', 'warn'); return; }
          const tags = Object.assign({ type: 'multipolygon' }, el.tags || {});
          Net.op({ k: 'createRelation', members: [{ type: 'way', ref: cur.id, role: 'outer' }], tags })
            .then((ack) => {
              const op = (ack.ops || []).find((o) => o.k === 'relationCreate');
              util.toast('已创建多面体关系', 'success');
              if (op) Editor.select('relation', op.relation.id);
            })
            .catch((err) => util.toast(err.message, 'error'));
          break;
        }
        default: break;
      }
    },

    /* ------------------------------ 关系与历史 ------------------------------ */
    renderRemote() {
      const cur = Inspector.current;
      const data = Inspector.data;
      if (!cur || !data) return;
      const relBox = util.$('#insp-relations');
      relBox.innerHTML = '';
      const rels = data.relations || [];
      if (rels.length) {
        relBox.appendChild(util.el('div', 'insp-section-title', `所属关系（${rels.length}）`));
        for (const rid of rels) {
          const rel = World.getRelation(rid);
          const tags = (rel && rel.tags) || {};
          const label = tags.name || tags.type || '关系';
          const row = util.el('div', 'insp-rel-row', `#${rid} ${util.esc(label)}${tags.type ? ` · ${util.esc(tags.type)}` : ''}`);
          row.onclick = () => Editor.select('relation', rid);
          relBox.appendChild(row);
        }
      } else {
        relBox.innerHTML = '<div class="insp-section-title">所属关系</div><div class="empty-hint small">不属于任何关系</div>';
      }
      Inspector.renderHistory();
    },

    renderHistory() {
      const box = util.$('#insp-history');
      if (!box) return;
      const data = Inspector.data;
      box.innerHTML = '';
      const rows = (data && data.history) || [];
      if (!rows.length) {
        box.innerHTML = '<div class="empty-hint small">还没有改动记录</div>';
        return;
      }
      for (const h of rows.slice(0, 20)) {
        const action = { create: '创建', modify: '修改', delete: '删除' }[h.action] || h.action;
        const row = util.el('div', 'hist-row', `<span class="hist-action">${action}</span>
          <span class="hist-author">${util.esc(h.author_name || '未知')}</span>
          <span class="hist-time">${util.fmtTime(h.ts)}</span>
          ${h.undone ? '<span class="hist-undone">已回滚</span>' : ''}`);
        box.appendChild(row);
      }
    },
  };

  window.G.Inspector = Inspector;
})();
