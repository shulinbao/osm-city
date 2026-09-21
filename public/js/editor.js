'use strict';
/**
 * 编辑器交互：选择、节点编辑、绘制点/线/面、分割、合并、删除、复制。
 * 所有改动都发给服务端校验，成功后由操作广播统一更新本地数据与画面。
 */
(function () {
  const { util, World, Render, Net, MapData } = window.G;

  /**
   * 工具栏。🗑️ 删除 与 ⧉ 复制 不再是独立工具 —— 它们是「🔍 选择」工具的两个选项
   * （见 renderSelectOptions / Editor.setQuickAction），所以这里没有它们的按钮；
   * 老的 id（delete / copy）仍然认（TOOL_ALIASES），只是会落到「选择」工具上。
   * 📐 矩形化 也已经从工具栏删掉（用户要求）：老 id 'rect' 在 TOOL_ALIASES 里落到「选择」，
   * 要整理成直角矩形请选中闭合的面、用属性检查器「操作」里的「📐 矩形化」。
   */
  /**
   * 工具表。hint = 「?」弹层与状态条提示里的那一句话（短、中文，别写成说明书）。
   */
  const TOOLS = [
    { id: 'select', ico: '🔍', name: '选择', hint: '点击元素看/改它的标签；同一处重复点击可切换重叠元素。删除与复制也是这个工具的选项（在「工具选项」里切）' },
    { id: 'move', ico: '✥', name: '移动', hint: '按住左键把建筑/区域、道路或车站拖到新位置，松开即提交（一步撤销）；车站由服务端吸附到最近的路网' },
    { id: 'nodes', ico: '⬦', name: '节点', hint: '拖动节点改形状（Shift 拖动整体平移）；Alt+点击删点，点击线段中点插点；「工具选项」里可开「＋ 加点 / － 删点」' },
    { id: 'point', ico: '📍', name: '加点', hint: '先在「工具选项」里选一个点类型（公交站牌 / 地铁出入口 / 加油站 / ATM / 厕所 / 长椅…；树、电线杆这类在列表最后），再点地图创建：只建带标签的 node' },
    { id: 'line', ico: '📏', name: '画线', hint: '依次点击画线：双击/Enter 结束并新建道路，Esc 取消，退格删上一个点；延伸 / 分割 / 合并在「工具选项」里' },
    { id: 'area', ico: '⬛', name: '画面', hint: '依次点击围出区域：双击/Enter 闭合完成，Esc 取消；「工具选项」里先挑区域类别、类型与楼层' },
    { id: 'joinnode', ico: '⊙', name: '合点', hint: '点击两个节点，把它们合并成一个（修断开的道路）' },
    { id: 'boxselect', ico: '⬚', name: '框选', hint: '拖出一个矩形，松开即选中框内元素；批量删除 / 套用标签 / 改类型 / 补限速都在「工具选项」里' },
    { id: 'station', ico: '🚉', name: '设站', hint: '先在「工具选项」里选设站模式（铁路/高铁/城际/地铁/轻轨/有轨电车/公交），再点地图放置；之后用「移动」拖动改位置' },
  ];

  /** 「选择」工具点地图时直接干什么（删除 / 复制也是它的模式，不再是独立工具） */
  const QUICK_ACTIONS = ['select', 'delete', 'copy'];
  /**
   * 老工具 id → 现在的归属（老代码 / 老存档 / 老快捷键还能这么调）：
   *   delete / copy / demolish → 并入「选择」工具；
   *   rect → 「矩形化」工具栏按钮已删除，老 id 一律落到「选择」工具上
   *          （功能本身没丢：选中闭合的面之后，属性检查器的「操作」里还有「📐 矩形化」，
   *           走的是同一个 Editor.orthogonalizeSelection()）。
   */
  const TOOL_ALIASES = { delete: 'select', copy: 'select', demolish: 'select', rect: 'select' };

  /**
   * 点要素（POI）类型表：**只放"真正的点"** —— 站牌 / 出入口 / 取款机 / 邮筒 / 长椅 / 观景台…
   * 「加点」工具用它们创建 **只有 node、没有几何** 的点要素（createNode）。
   * 图书馆 / 酒吧 / 菜市场 / 学校 / 医院 / 超市 / 商场 / 银行 / 电影院 / 博物馆 / 酒店 / 健身房 / 理发店…
   * 这些都是**建筑**（有轮廓的面），一律住在下面的 BUILDING_TYPES 里，绝不再混进这张点表。
   */
  const POI_GROUPS = [
    {
      id: 'transit', name: '公共交通', ico: '🚏', items: [
        { id: 'poi-bus-stop', name: '公交站牌', ico: '🚏', tags: { highway: 'bus_stop', public_transport: 'platform' }, kw: ['公交站', '巴士站', '站牌', 'bus_stop'] },
        { id: 'poi-subway-entrance', name: '地铁出入口', ico: '🚇', tags: { railway: 'subway_entrance' }, kw: ['地铁口', '地铁站', '出入口', 'subway_entrance'] },
        { id: 'poi-rail-station', name: '火车站', ico: '🚉', tags: { railway: 'station', public_transport: 'station' }, kw: ['车站', 'railway=station'] },
        { id: 'poi-tram-stop', name: '电车站', ico: '🚊', tags: { railway: 'tram_stop', public_transport: 'platform' }, kw: ['有轨电车', 'tram_stop'] },
        { id: 'poi-taxi', name: '出租车站', ico: '🚕', tags: { amenity: 'taxi' }, kw: ['taxi', '的士站'] },
        { id: 'poi-parking-entrance', name: '停车场入口', ico: '🅿️', tags: { amenity: 'parking_entrance' }, kw: ['停车', 'parking_entrance', '车库入口'] },
      ],
    },
    {
      id: 'vehicle', name: '车辆服务', ico: '⛽', items: [
        { id: 'poi-fuel', name: '加油站', ico: '⛽', tags: { amenity: 'fuel' }, kw: ['加油', '油站', 'fuel', '中石化'] },
        { id: 'poi-charging', name: '充电桩', ico: '🔌', tags: { amenity: 'charging_station' }, kw: ['充电', 'charging_station'] },
        { id: 'poi-bicycle-parking', name: '自行车停放处', ico: '🚲', tags: { amenity: 'bicycle_parking' }, kw: ['车棚', 'bicycle_parking'] },
      ],
    },
    {
      id: 'street', name: '街边设施', ico: '🚻', items: [
        { id: 'poi-atm', name: 'ATM', ico: '🏧', tags: { amenity: 'atm' }, kw: ['取款机', 'atm'] },
        { id: 'poi-post-box', name: '邮筒', ico: '📮', tags: { amenity: 'post_box' }, kw: ['信箱', 'post_box', '邮政'] },
        { id: 'poi-toilets', name: '厕所', ico: '🚻', tags: { amenity: 'toilets' }, kw: ['公共厕所', '洗手间', '卫生间', 'toilets'] },
        { id: 'poi-drinking-water', name: '饮水点', ico: '🚰', tags: { amenity: 'drinking_water' }, kw: ['直饮水', 'drinking_water'] },
        { id: 'poi-waste-basket', name: '垃圾桶', ico: '🗑️', tags: { amenity: 'waste_basket' }, kw: ['果皮箱', 'waste_basket'] },
        { id: 'poi-bench', name: '长椅', ico: '🪑', tags: { amenity: 'bench' }, kw: ['座椅', 'bench'] },
        { id: 'poi-ambulance-station', name: '急救站', ico: '🚑', tags: { emergency: 'ambulance_station' }, kw: ['急救', 'ambulance'] },
      ],
    },
    {
      id: 'outdoor', name: '公园与观景', ico: '🌳', items: [
        { id: 'poi-park-entrance', name: '公园入口', ico: '🌳', tags: { leisure: 'park', entrance: 'yes' }, kw: ['公园', '入口', '大门', 'park'] },
        { id: 'poi-viewpoint', name: '观景台', ico: '👀', tags: { tourism: 'viewpoint' }, kw: ['观景点', 'viewpoint'] },
      ],
    },
  ];

  /**
   * 建筑（多边形）类型：一栋楼该是什么用途 —— building=* 为主，需要时补 amenity/shop/office/tourism。
   * 凡是有轮廓、能画成面的（图书馆 / 酒吧 / 菜市场 / 学校 / 医院 / 超市 / 商场 / 银行 / 电影院 /
   * 博物馆 / 酒店 / 健身房 / 理发店…）都在这里，点要素表里不会有它们。
   */
  const BUILDING_TYPES = [
    {
      id: 'building', name: '建筑本体', ico: '🏢', items: [
        { id: 'bld-residential', name: '住宅', ico: '🏠', tags: { building: 'residential' }, kw: ['居民楼', '住宅楼', 'residential'] },
        { id: 'bld-apartments', name: '公寓', ico: '🏢', tags: { building: 'apartments' }, kw: ['公寓楼', 'apartments'] },
        { id: 'bld-office', name: '写字楼', ico: '🏢', tags: { building: 'office' }, kw: ['办公楼', 'office'] },
        { id: 'bld-commercial', name: '商业楼', ico: '🏬', tags: { building: 'commercial' }, kw: ['商铺', 'commercial'] },
        { id: 'bld-public', name: '公共建筑', ico: '🏛️', tags: { building: 'public' }, kw: ['public'] },
        { id: 'bld-industrial', name: '工厂', ico: '🏭', tags: { building: 'industrial', landuse: 'industrial' }, kw: ['厂房', '工业', 'industrial'] },
        { id: 'bld-warehouse', name: '仓库', ico: '📦', tags: { building: 'warehouse' }, kw: ['库房', 'warehouse'] },
        { id: 'bld-garage', name: '车库', ico: '🚗', tags: { building: 'garage' }, kw: ['停车房', 'garage'] },
        { id: 'bld-shed', name: '棚屋', ico: '🛖', tags: { building: 'shed' }, kw: ['小屋', 'shed'] },
        { id: 'bld-construction', name: '在建建筑', ico: '🚧', tags: { building: 'construction' }, kw: ['施工', 'construction'] },
      ],
    },
    {
      id: 'public', name: '公共服务', ico: '🏛️', items: [
        { id: 'bld-school', name: '学校', ico: '🏫', tags: { building: 'school', amenity: 'school' }, kw: ['教学楼', '小学', '中学', 'school'] },
        { id: 'bld-university', name: '大学', ico: '🎓', tags: { building: 'university', amenity: 'university' }, kw: ['高校', '学院', 'university'] },
        { id: 'bld-kindergarten', name: '幼儿园', ico: '🧸', tags: { building: 'kindergarten', amenity: 'kindergarten' }, kw: ['托儿所', 'kindergarten'] },
        { id: 'bld-library', name: '图书馆', ico: '📚', tags: { building: 'public', amenity: 'library' }, kw: ['图书室', 'library'] },
        { id: 'bld-hospital', name: '医院', ico: '🏥', tags: { building: 'hospital', amenity: 'hospital' }, kw: ['住院楼', '门诊楼', 'hospital'] },
        { id: 'bld-clinic', name: '诊所', ico: '🩺', tags: { building: 'yes', amenity: 'clinic' }, kw: ['门诊', 'clinic'] },
        { id: 'bld-doctors', name: '卫生站', ico: '🩺', tags: { building: 'yes', amenity: 'doctors' }, kw: ['社区医院', 'doctors'] },
        { id: 'bld-pharmacy', name: '药店', ico: '💊', tags: { building: 'commercial', amenity: 'pharmacy' }, kw: ['药房', 'pharmacy'] },
        { id: 'bld-veterinary', name: '宠物医院', ico: '🐾', tags: { building: 'yes', amenity: 'veterinary' }, kw: ['兽医', 'veterinary'] },
        { id: 'bld-museum', name: '博物馆', ico: '🏛️', tags: { building: 'public', tourism: 'museum' }, kw: ['展览馆', 'museum'] },
        { id: 'bld-gallery', name: '美术馆', ico: '🖼️', tags: { building: 'public', tourism: 'gallery' }, kw: ['画廊', 'gallery'] },
        { id: 'bld-cinema', name: '电影院', ico: '🎬', tags: { building: 'commercial', amenity: 'cinema' }, kw: ['影城', 'cinema'] },
        { id: 'bld-theatre', name: '剧院', ico: '🎭', tags: { building: 'public', amenity: 'theatre' }, kw: ['戏院', 'theatre'] },
        { id: 'bld-fitness', name: '健身房', ico: '🏋️', tags: { building: 'yes', leisure: 'fitness_centre' }, kw: ['健身馆', 'fitness_centre'] },
        { id: 'bld-government', name: '政府机构', ico: '🏛️', tags: { building: 'public', office: 'government' }, kw: ['机关', 'government'] },
        { id: 'bld-townhall', name: '市政厅', ico: '🏛️', tags: { building: 'public', amenity: 'townhall' }, kw: ['市政府', 'townhall'] },
        { id: 'bld-police', name: '派出所', ico: '🚓', tags: { building: 'public', amenity: 'police' }, kw: ['警察局', 'police'] },
        { id: 'bld-fire-station', name: '消防站', ico: '🚒', tags: { building: 'public', amenity: 'fire_station' }, kw: ['消防队', 'fire_station'] },
        { id: 'bld-post-office', name: '邮局', ico: '📮', tags: { building: 'public', amenity: 'post_office' }, kw: ['邮政', 'post_office'] },
        { id: 'bld-bank', name: '银行', ico: '🏦', tags: { building: 'commercial', amenity: 'bank' }, kw: ['储蓄所', 'bank'] },
        { id: 'bld-worship', name: '宗教场所', ico: '⛪', tags: { building: 'yes', amenity: 'place_of_worship' }, kw: ['教堂', '寺庙', '清真寺', 'place_of_worship'] },
        { id: 'bld-church', name: '教堂', ico: '⛪', tags: { building: 'church', amenity: 'place_of_worship', religion: 'christian' }, kw: ['礼拜堂', 'church'] },
      ],
    },
    {
      id: 'shop', name: '商业与餐饮', ico: '🏬', items: [
        { id: 'bld-mall', name: '商场', ico: '🏬', tags: { building: 'retail', shop: 'mall' }, kw: ['购物中心', '商业楼', 'mall'] },
        { id: 'bld-supermarket', name: '超市', ico: '🛒', tags: { building: 'retail', shop: 'supermarket' }, kw: ['卖场', 'supermarket'] },
        { id: 'bld-convenience', name: '便利店', ico: '🏪', tags: { building: 'retail', shop: 'convenience' }, kw: ['小卖部', 'convenience'] },
        { id: 'bld-marketplace', name: '菜市场', ico: '🥬', tags: { building: 'retail', amenity: 'marketplace' }, kw: ['市场', '集市', 'marketplace'] },
        { id: 'bld-bakery', name: '面包店', ico: '🥖', tags: { building: 'retail', shop: 'bakery' }, kw: ['烘焙', 'bakery'] },
        { id: 'bld-restaurant', name: '餐厅', ico: '🍜', tags: { building: 'commercial', amenity: 'restaurant' }, kw: ['饭店', '餐馆', 'restaurant'] },
        { id: 'bld-cafe', name: '咖啡馆', ico: '☕', tags: { building: 'commercial', amenity: 'cafe' }, kw: ['咖啡', 'cafe'] },
        { id: 'bld-fast-food', name: '快餐', ico: '🍔', tags: { building: 'commercial', amenity: 'fast_food' }, kw: ['汉堡', '麦当劳', 'fast_food'] },
        { id: 'bld-bar', name: '酒吧', ico: '🍺', tags: { building: 'commercial', amenity: 'bar' }, kw: ['酒馆', 'bar', 'pub'] },
        { id: 'bld-ice-cream', name: '冰淇淋店', ico: '🍦', tags: { building: 'commercial', amenity: 'ice_cream' }, kw: ['冷饮', '雪糕', 'ice_cream'] },
        { id: 'bld-hairdresser', name: '理发店', ico: '💈', tags: { building: 'commercial', shop: 'hairdresser' }, kw: ['理发', 'hairdresser'] },
        { id: 'bld-laundry', name: '洗衣店', ico: '🧺', tags: { building: 'commercial', shop: 'laundry' }, kw: ['干洗', 'laundry'] },
      ],
    },
    {
      id: 'stay', name: '住宿与车站', ico: '🏨', items: [
        { id: 'bld-hotel', name: '酒店', ico: '🏨', tags: { building: 'hotel', tourism: 'hotel' }, kw: ['宾馆', 'hotel'] },
        { id: 'bld-guest-house', name: '客栈', ico: '🛏️', tags: { building: 'yes', tourism: 'guest_house' }, kw: ['民宿', 'guest_house'] },
        { id: 'bld-station', name: '车站大楼', ico: '🚉', tags: { building: 'train_station', railway: 'station' }, kw: ['站房', '火车站大楼', 'train_station'] },
      ],
    },
  ];

  /** 道路类型：只写 highway=*（道路不需要名字标签，名字留给建筑） */
  const ROAD_TYPES = [
    {
      id: 'road', name: '道路等级', ico: '🛣️', items: [
        { id: 'road-motorway', name: '高速', ico: '🛣️', tags: { highway: 'motorway' }, kw: ['高速公路', '高速路', 'motorway'] },
        { id: 'road-trunk', name: '快速路', ico: '🛣️', tags: { highway: 'trunk' }, kw: ['高架', '国道', 'trunk'] },
        { id: 'road-primary', name: '主干道', ico: '🛣️', tags: { highway: 'primary' }, kw: ['省道', 'primary'] },
        { id: 'road-secondary', name: '次干道', ico: '🛣️', tags: { highway: 'secondary' }, kw: ['secondary'] },
        { id: 'road-tertiary', name: '支路', ico: '🛣️', tags: { highway: 'tertiary' }, kw: ['tertiary'] },
        { id: 'road-residential', name: '住宅区道路', ico: '🛣️', tags: { highway: 'residential' }, kw: ['小区道路', 'residential'] },
        { id: 'road-living-street', name: '生活街区', ico: '🚸', tags: { highway: 'living_street' }, kw: ['共享街道', 'living_street'] },
        { id: 'road-pedestrian', name: '步行街', ico: '🚶', tags: { highway: 'pedestrian' }, kw: ['步行道', 'pedestrian'] },
        { id: 'road-cycleway', name: '自行车道', ico: '🚲', tags: { highway: 'cycleway' }, kw: ['骑行道', 'cycleway'] },
        { id: 'road-service', name: '服务道路', ico: '🛠️', tags: { highway: 'service' }, kw: ['内部道路', 'service'] },
        { id: 'road-footway', name: '人行道', ico: '🚶', tags: { highway: 'footway' }, kw: ['小路', 'footway'] },
        { id: 'road-track', name: '田间小路', ico: '🌾', tags: { highway: 'track' }, kw: ['土路', 'track'] },
      ],
    },
  ];

  /** 改类型时要先清掉的"同义标签"：避免一栋楼上同时留着 amenity=school 和 amenity=hospital */
  const TYPE_CLEAR_KEYS = {
    building: ['building', 'amenity', 'shop', 'tourism', 'landuse', 'office', 'leisure', 'healthcare', 'historic', 'emergency', 'craft', 'railway', 'public_transport'],
    road: ['highway', 'building', 'amenity', 'shop', 'tourism', 'landuse', 'office', 'leisure', 'natural', 'waterway', 'railway', 'public_transport', 'name', 'name:zh', 'name:en'],
    poi: ['amenity', 'shop', 'tourism', 'office', 'leisure', 'healthcare', 'emergency', 'historic', 'craft', 'railway', 'highway', 'public_transport', 'landuse', 'natural'],
  };

  /** 类型表按"作用对象"分组：poi=点要素、building=建筑多边形、road=道路 */
  const TYPE_GROUPS = { poi: POI_GROUPS, building: BUILDING_TYPES, road: ROAD_TYPES };

  const TYPE_SCOPE_LABEL = { poi: '点要素（POI）', building: '建筑', road: '道路等级' };

  /**
   * 类表里已经写过的所有 `<几何>|<key>=<value>`（poi→point / building→area / road→line）。
   * 预设表（window.G.Presets）里凡是命中这里的条目都不再显示 —— 同一种类型只允许有一个定义处，
   * 免得「建筑类型」芯片和「类型预设」列表里出现同一个 学校 / 高速公路。
   * 按几何分开索引很关键：点要素的「公园入口（leisure=park + entrance=yes）」不该把面状的「公园」也挤掉，
   * 公交站的 public_transport=platform 也不该把面状的「站台」挤掉。
   */
  const SCOPE_KIND = { poi: 'point', building: 'area', road: 'line' };

  const CLASS_TAG_PAIRS = (function () {
    const set = new Set();
    for (const scope of Object.keys(TYPE_GROUPS)) {
      const kind = SCOPE_KIND[scope];
      for (const group of TYPE_GROUPS[scope]) {
        for (const item of group.items) {
          for (const [k, v] of Object.entries(item.tags)) set.add(kind + '|' + k + '=' + v);
        }
      }
    }
    return set;
  })();

  /** 这条预设是不是已经被"同几何"的类表覆盖（任一对 key=value 命中即算覆盖） */
  function presetCoveredByClass(item) {
    if (!item || !item.tags) return true;
    const kind = item.kind || '';
    for (const [k, v] of Object.entries(item.tags)) {
      if (CLASS_TAG_PAIRS.has(kind + '|' + k + '=' + v)) return true;
    }
    return false;
  }

  /**
   * 建筑表里出现过的所有 `key=value`（不分几何）。
   * 预设表里的"点"条目凡是命中这里的，其实是建筑（餐厅 / 酒吧 / 超市 / 银行 / 图书馆…），
   * 一律不进点要素列表 —— 它们已经在建筑表里了，模型里没有第二个定义处。
   */
  const BUILDING_TAG_PAIRS = (function () {
    const set = new Set();
    for (const group of BUILDING_TYPES) {
      for (const item of group.items) {
        for (const [k, v] of Object.entries(item.tags)) set.add(k + '=' + v);
      }
    }
    return set;
  })();

  /** 这条预设是不是"其实是建筑"（建筑表里已经有同一个类型） */
  function presetIsBuilding(item) {
    if (!item || !item.tags) return false;
    return Object.entries(item.tags).some(([k, v]) => BUILDING_TAG_PAIRS.has(k + '=' + v));
  }

  /**
   * 点要素（POI）**唯一的一张表**：类表（POI_GROUPS，18 个真正的点）后面**直接接上**
   * 预设表里真正的点（树 / 电线杆 / 消防栓 / 大门 / 塔…）—— 合并成同一张表、同一个搜索框，
   * 不再出现"点要素类型（POI）"和"其它点要素"两段重复列表。
   * 建筑（图书馆 / 酒吧 / 学校 / 医院 / 超市 / 银行…）被 presetIsBuilding 挡在外面，只在建筑表里出现。
   */
  function poiTypeGroups() {
    const out = POI_GROUPS.map((g) => ({ id: g.id, name: g.name, ico: g.ico, items: g.items.slice() }));
    const G = window.G;
    if (G && G.Presets && typeof G.Presets.all === 'function') {
      const extra = G.Presets.all()
        .filter((it) => it.kind === 'point' && !presetCoveredByClass(it) && !presetIsBuilding(it))
        .map((it) => ({ id: it.id, name: it.name, ico: it.icon, tags: it.tags, kw: it.keywords || [] }));
      if (extra.length) out.push({ id: 'other-point', name: '其它点状要素', ico: '📍', items: extra });
    }
    return out;
  }

  /** 元素的主类型标签（判断"这个要素归哪一类"用） */
  const PRIMARY_KEYS = ['highway', 'railway', 'waterway', 'building', 'building:part', 'landuse', 'natural', 'leisure',
    'amenity', 'shop', 'tourism', 'office', 'barrier', 'power', 'man_made', 'aeroway', 'route', 'historic', 'emergency', 'public_transport'];

  /** 换类型时先清掉的"同类主标签"：预设表条目没写的这些键都要清掉，免得一个要素上留着两套分类 */
  const PRESET_CLEAR_KEYS = ['highway', 'railway', 'waterway', 'building', 'building:part', 'landuse', 'natural', 'leisure',
    'amenity', 'shop', 'tourism', 'office', 'barrier', 'power', 'man_made', 'aeroway', 'route', 'historic', 'emergency'];

  /**
   * 点要素（node）算"点"的标签：有这些键就用点要素表（POI_GROUPS + 预设表里真正的点）。
   * 树、电线杆、塔、大门这些也在这张表里，所以它们的主标签同样算"点"。
   */
  const POI_KEYS = ['amenity', 'shop', 'tourism', 'office', 'leisure', 'healthcare', 'emergency', 'historic', 'craft',
    'railway', 'highway', 'public_transport', 'natural', 'power', 'man_made', 'barrier'];

  /** 画面工具的区域大类 → 预设表里对应的主标签（建筑有自己的类表，不用预设表） */
  const AREA_KIND_PRESET_KEYS = {
    building: null,
    landuse: ['landuse'],
    natural: ['natural'],
    leisure: ['leisure'],
  };

  /* ---------------------- 车站（与服务端一致） ---------------------- */
  /**
   * 设站模式表：**唯一一份**，左侧「🚉 设站」面板和右侧检查器的「新建车站」面板都用它渲染芯片
   * （renderStationModeChooser），交通面板的「设站模式」是同一格共享状态。
   * id 直接就是服务端 station.create 认的 kind（server/transit.js 的 STATION_KINDS：
   * hsr / intercity / rail / subway / light_rail / tram / bus），
   * kind 归路网：'bus' = 公交站（贴可行驶道路），'rail' = 轨道站（贴轨道）。
   */
  const RAIL_SNAP_TEXT = '贴轨道放：服务端就近吸附到最近的轨道（约 120 米内优先）';
  const BUS_SNAP_TEXT = '贴道路放：服务道路、土路、生活街区、各级主干道都能放，服务端就近吸附';
  const STATION_MODES = [
    { id: 'rail', ico: '🚆', name: '铁路', kind: 'rail', snapText: RAIL_SNAP_TEXT, tip: '普速铁路车站：放在铁路旁边，服务端会吸附到最近的轨道' },
    { id: 'hsr', ico: '🚄', name: '高铁', kind: 'rail', snapText: RAIL_SNAP_TEXT, tip: '高铁站：城市尺度（缩放 9 起）就显示' },
    { id: 'intercity', ico: '🚈', name: '城际', kind: 'rail', snapText: RAIL_SNAP_TEXT, tip: '城际站：放大一点（缩放 11 起）显示' },
    { id: 'subway', ico: '🚇', name: '地铁', kind: 'rail', snapText: RAIL_SNAP_TEXT, tip: '地铁站：贴地铁/铁路轨道放' },
    { id: 'light_rail', ico: '🚊', name: '轻轨', kind: 'rail', snapText: RAIL_SNAP_TEXT, tip: '轻轨站：贴轻轨轨道放' },
    { id: 'tram', ico: '🚋', name: '有轨电车', kind: 'rail', snapText: RAIL_SNAP_TEXT, tip: '有轨电车站：贴街上那段轨道放' },
    { id: 'bus', ico: '🚌', name: '公交', kind: 'bus', snapText: BUS_SNAP_TEXT, tip: '公交站：旁边只要是能开车走的道路就行（人行道/小路/台阶/自行车道/在建道路除外）' },
  ];
  /**
   * 公交站旁边哪些道路算"能开车的"：**除了下面这几个等级，其它 highway=* 全部算**
   * （玩家说的"黄色的"主干道、服务道路、土路、生活街区…都能设站）。
   * 以前这里是一张白名单（BUS_ROADS），漏掉的等级会让站怎么点都放不下 —— 现在按黑名单判。
   */
  const BUS_FORBIDDEN = new Set(['footway', 'path', 'steps', 'cycleway', 'construction', 'proposed']);
  const RAIL_RUNNABLE = new Set(['rail', 'light_rail', 'subway', 'tram', 'narrow_gauge', 'monorail', 'funicular', 'preserved']);
  /**
   * 服务端就近吸附的搜索半径（60 / 120 米）**在客户端已经不存在**：
   * 吸附由服务端做，客户端不再拿它当门槛（公交站只要旁边有可行驶道路就能放，不再要求 60 米内）。
   * 客户端只保留一个"太远了"的提醒阈值：附近连一条可行驶道路/轨道都找不到（或超过它）时
   * 说一句中文提醒，照旧把位置交给服务端吸附。
   */
  const STATION_FAR_WARN_M = 200;
  const JOIN_SNAP_M = 25;                                   // 与服务端 mergeWays 的 snapMeters 默认值一致

  /** 框选类型过滤（面板上的一排芯片） */
  const BOX_FILTERS = [
    { id: 'all', name: '全部', tip: '框内所有元素：点、线、面、关系，以及自己名下的交通实体' },
    { id: 'point', name: '点', tip: '只选点要素（node），例如 POI、路灯' },
    { id: 'line', name: '线', tip: '只选开放线条：道路、铁路、水系等' },
    { id: 'area', name: '面', tip: '只选闭合区域：建筑、地块、水面等' },
    { id: 'transit', name: '交通', tip: '只选自己名下的交通实体：车站、线路、车辆' },
  ];

  /** 道路等级 → 限速（km/h，字符串写入 maxspeed） */
  const MAXSPEED_BY_CLASS = {
    motorway: '120', motorway_link: '60', trunk: '100', trunk_link: '50',
    primary: '70', primary_link: '40', secondary: '50', secondary_link: '35',
    tertiary: '40', tertiary_link: '30', unclassified: '30', residential: '30',
    living_street: '15', service: '20', track: '20', busway: '60',
    pedestrian: '5', road: '30',
  };

  /** 「限速」行里的常用限速芯片（km/h）：点一下就写进 maxspeed，旁边还有自定义数字框 */
  const MAXSPEED_CHOICES = ['5', '15', '20', '30', '40', '50', '60', '70', '80', '100', '120'];

  const MAXSPEED_BATCH_LIMIT = 300;   // 服务端 _batch 的上限，超过会被拒
  const DRAG_BATCH_LIMIT = 300;       // 拖动整条要素 = 每个节点一个 updateNode，同样受 _batch 上限约束
  /**
   * 版本冲突自愈时，一次最多逐元素刷新多少个（每个元素一次 `/api/element`）。
   * 单元素操作只花 1 次；批量操作（框选批量删除之类）会顺手把"还没执行的那几段"也刷新，
   * 这样一轮就能重放完，不用"点一次只前进一个元素"。上限是为了不让一次自愈变成几百个 HTTP 请求：
   * 超出的那部分不放进这次重放，改为如实提示"还有 N 项请再点一次"（下一次点击会继续前进）。
   */
  const MAX_CONFLICT_REFRESH = 8;
  const TRANSIT_TYPE = 'transit';     // 框选出来的交通实体在 multiSelect 里的 type

  const Editor = {
    map: null,
    tool: 'select',
    quickAction: 'select',   // 「选择」工具点地图时的动作：select / delete / copy（删除与复制是它的选项）
    selection: null,
    pending: [],
    cursorLatLng: null,
    players: [],
    myId: null,
    locks: {},
    // 每种工具各自记住自己的标签，互不串味：道路只有道路标签、建筑只有建筑标签、车站不写 OSM 标签
    drawTagsByTool: {
      point: {},
      line: { highway: 'residential', lanes: '2', oneway: 'no' },
      area: { building: 'yes' },
      station: {},
    },
    drawNamesByTool: { point: '', line: '', area: '', station: '' },
    drawTags: { highway: 'residential', lanes: '2', oneway: 'no' },   // 当前工具的标签
    drawName: '',
    drawFloors: 3,         // 新建建筑/区域的默认楼层（写入 building:levels）
    drawAreaKind: 'building',  // 画面工具的默认类型：building / landuse / natural / leisure
    stationMode: 'rail',   // 设站模式兜底值：有 Transit 时**唯一来源**是 Transit.stationMode（交通面板同一个值）
    multiSelect: [],       // 框选出来的多个元素
    boxFilter: 'all',      // 框选类型过滤：all / point / line / area / transit
    boxRect: null,         // 正在拖拽的框选矩形
    lastBoxRect: null,     // 上一次框选的矩形：切换过滤时用它重算，避免"只能越筛越少"
    boxMaxspeedOverwrite: false,  // 批量补限速（框选面板里的次级入口）是否覆盖已有值
    boxTypeScope: 'building',     // 框选「批量改类型」当前选的类型表：building / road / poi
    _typeUndo: {},         // 「改类型」芯片的开关记忆：type:id → { itemId, tags }（改类型前的整套标签）
    actionLog: [],         // 操作历史（用于 Ctrl+Z 判断该撤销 OSM 编辑还是交通操作）
    dragging: null,
    hover: null,
    busy: false,
    // 画线工具里的「改造已有道路」状态（延伸/分割/合并/加点/删点都住在这里，不再是独立工具）
    drawMode: null,        // null | 'addnode' | 'delnode' —— 节点增删模式
    drawOp: null,          // null | 'split' | 'merge' —— 一次性操作，点完地图就自动结束
    _extendAnchor: null,   // { wayId, end:'start'|'end', nodeId } —— 正在延伸道路
    _suppressClickUntil: 0,// 刚拖完的一小段时间内忽略 click，避免"拖完又被当成点选"
    /**
     * 已经单独问过版本号的元素（"type:id"）。
     * 节点从视口载荷进来时**没有版本号**（见 _learnVersion），选中时补问一次 `/api/element`；
     * 每个元素只问一次，之后版本号就由 World 自己维护（ack / 广播 / 冲突刷新都会更新它）。
     */
    _verAsked: new Set(),
    TOOLS,
    POI_GROUPS,
    BUILDING_TYPES,
    ROAD_TYPES,
    TYPE_GROUPS,
    // 设站模式的唯一一份表：检查器（inspector.js）的「新建车站」面板也读它渲染芯片
    STATION_MODES,
    // 类型表 / 限速表的只读出口：检查器（inspector.js）直接读这两张表，避免各写一份
    TYPE_SCOPE_LABEL,
    MAXSPEED_BY_CLASS,
    MAXSPEED_CHOICES,

    init(map, options = {}) {
      Editor.map = map;
      Editor.onStatus = options.onStatus || (() => {});
      Editor.labelsVisible = true;
      Editor._ensureOptionsHook();

      map.on('click', Editor._onClick);
      map.on('mousedown', Editor._onMouseDown);
      map.on('mousemove', Editor._onMouseMove);
      map.on('mouseup', Editor._onMouseUp);
      map.on('dblclick', Editor._onDblClick);
      map.on('contextmenu', Editor._onContextMenu);
      document.addEventListener('keydown', Editor._onKeyDown);
      map.on('zoomstart', () => { Editor._renderPreview(); });
      map.on('zoomend', () => { Editor._renderPreview(); });

      Editor.setTool('select');
      return Editor;
    },

    /* ------------------------------ 工具与选择 ------------------------------ */
    /**
     * 切工具。老 id（delete / copy）会落到「选择」工具上，并把它的"点击行为"设成删除 / 复制 ——
     * 这两个动作现在是「选择」工具的选项，不再是独立工具（data-tool 之类的老用法仍然能用）。
     */
    setTool(id) {
      const alias = TOOL_ALIASES[id];
      const want = alias || id;
      if (!TOOLS.some((t) => t.id === want)) return;
      if (alias) Editor.setQuickAction(id);
      // 切换工具时把该工具自己的标签集换上，避免"建车站却带着道路标签"
      if (Editor.tool !== want) {
        Editor.drawTagsByTool[Editor.tool] = Editor.drawTags;
        Editor.drawNamesByTool[Editor.tool] = Editor.drawName;
        Editor.cancel();
      }
      Editor.tool = want;
      if (want !== 'select') Editor.quickAction = 'select';   // 删除/复制只跟着「选择」工具
      Editor.drawTags = Object.assign({}, Editor.drawTagsByTool[want] || {});
      Editor.drawName = Editor.drawNamesByTool[want] || '';
      if (want !== 'select' && want !== 'nodes') Render.resetPickCycle();
      Editor.map.getContainer().style.cursor = ['select', 'nodes'].includes(want) ? '' : 'crosshair';
      document.body.dataset.tool = Editor._dataToolValue(want);
      const def = TOOLS.find((t) => t.id === want);
      // 提示只有一处：底部状态条最右边的那一格（右对齐、单行、超出省略号）。
      // 以前这里还会往地图右下角弹一个浮层提示框，已经删掉 —— 地图上不再有任何提示浮框。
      util.statusHint(def ? `${def.ico} ${def.name} · ${def.hint}` : '');
      if (Editor.onStatus) Editor.onStatus();
      Editor._renderPreview();
    },

    /**
     * body[data-tool] 的值。删除 / 复制并入「选择」工具之后，
     * 这一格仍写老值（app.css 里有 body[data-tool="delete"] 的禁用光标钩子，老用法/老测试也认这个）。
     */
    _dataToolValue(tool) {
      if (tool === 'select' && Editor.quickAction && Editor.quickAction !== 'select') return Editor.quickAction;
      return tool;
    },

    /** 「选择」工具点地图时的动作：select（默认）/ delete / copy —— 删除、复制不再是独立工具 */
    setQuickAction(id) {
      const want = QUICK_ACTIONS.includes(id) ? id : 'select';
      Editor.quickAction = want;
      if (Editor.tool === 'select') document.body.dataset.tool = Editor._dataToolValue('select');
      if (want !== 'select') util.statusHint(want === 'delete' ? '删除：点击地图上的元素即删除（Ctrl+Z 可撤销）' : '复制：点击地图即复制当前选中的元素');
      if (window.G.UI && typeof window.G.UI.renderToolOptions === 'function') window.G.UI.renderToolOptions();
      return want;
    },

    select(type, id, options = {}) {
      if (!type || !id) return Editor.deselect();
      const el = World.get(type, id);
      if (!el) {
        util.toast('这个元素不在本地缓存里，正在获取…', 'info', 1500);
        MapData.fetchElement(type, id).then(() => Editor.select(type, id, options)).catch(() => util.toast('元素不存在或已被删除', 'warn'));
        return;
      }
      const prev = Editor.selection;
      if (prev && (prev.type !== type || prev.id !== id)) Editor._releaseLock(prev);
      Editor.selection = { type, id };
      Editor.lastBoxRect = null;   // 改点选单个元素后，别再用旧框重算框选过滤
      World.pin(type, id);
      if (options.lock !== false) Editor._acquireLock(type, id);
      Editor._learnVersion(type, id);   // 本地没有版本号的元素：顺手补一次（不阻塞选中）
      Net.select(type, id);
      if (window.G.Inspector) window.G.Inspector.show(type, id);
      Editor._renderPreview();
      Editor._updateStatus();
      if (Editor.onStatus) Editor.onStatus();
    },

    deselect() {
      if (Editor.selection) Editor._releaseLock(Editor.selection);
      Editor.selection = null;
      for (const it of Editor.multiSelect) World.unpin(it.type, it.id);
      Editor.multiSelect = [];
      Editor.lastBoxRect = null;   // 框选也一起清掉，避免切换过滤时又选中旧的框
      Editor._highlightTransitPick([]);
      Net.select(null, null);
      if (window.G.Inspector) { window.G.Inspector.hide(); window.G.Inspector.showToolConfig(); }
      Editor._renderPreview();
      Editor._updateStatus();
      if (window.G.UI) window.G.UI.renderToolOptions();
      if (Editor.onStatus) Editor.onStatus();
    },

    _acquireLock(type, id) {
      Net.lock(type, id, true);
    },

    _releaseLock(sel) {
      if (sel) Net.lock(sel.type, sel.id, false);
    },

    cancel() {
      const hadMode = !!(Editor.drawMode || Editor.drawOp || Editor._extendAnchor || Editor.pending.length);
      Editor.pending = [];
      Editor.hover = null;
      Editor._extendAnchor = null;
      Editor.drawOp = null;
      Editor.drawMode = null;
      if (Editor.dragging) {
        Editor.dragging = null;
        Editor.map.dragging.enable();
      }
      Editor._renderPreview();
      if (hadMode && window.G.UI) window.G.UI.renderToolOptions();
    },

    _updateStatus() {
      const box = util.$('#status-select');
      if (!box) return;
      const sel = Editor.selection;
      if (!sel) { box.textContent = '未选中任何元素'; return; }
      const el = World.get(sel.type, sel.id);
      const name = el && el.tags && (el.tags.name || el.tags['name:zh']);
      const typeName = { node: '节点', way: '道路/区域', relation: '关系' }[sel.type];
      box.textContent = `已选中 ${typeName} #${sel.id}${name ? ' · ' + name : ''}`;
    },

    /* ------------------------------ 框选 ------------------------------ */
    /** 选中矩形范围内的所有元素（按当前类型过滤：全部/点/线/面/交通） */
    selectInBox(rect) {
      Editor.lastBoxRect = {
        start: { lat: rect.start.lat, lon: rect.start.lon },
        end: { lat: rect.end.lat, lon: rect.end.lon },
      };
      const picked = Editor.pickInBox(Editor.lastBoxRect);
      Editor.applyBoxPick(picked);
    },

    /** 当前过滤是否包含某一类（'all' 视为全都要） */
    _boxFilterWants(kind) {
      const cur = Editor.boxFilter || 'all';
      return cur === 'all' || cur === kind;
    },

    /**
     * 按当前类型过滤挑出框内元素（纯计算，不改动选择状态）。
     * 返回 [{type, id}]；交通实体带 entity: station / line / vehicle。
     */
    pickInBox(rect) {
      const minLat = Math.min(rect.start.lat, rect.end.lat);
      const maxLat = Math.max(rect.start.lat, rect.end.lat);
      const minLon = Math.min(rect.start.lon, rect.end.lon);
      const maxLon = Math.max(rect.start.lon, rect.end.lon);
      const inside = (lat, lon) => lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
      const picked = [];

      // 线 / 面：都是 way，按是否闭合分流
      if (Editor._boxFilterWants('line') || Editor._boxFilterWants('area')) {
        for (const way of World.ways.values()) {
          const closed = World.isClosed(way);
          if (closed ? !Editor._boxFilterWants('area') : !Editor._boxFilterWants('line')) continue;
          const coords = World.wayCoords(way);
          if (!coords.length) continue;
          // 只要有一个顶点落在框内就算（跨越式长路也能选中）
          if (coords.some((c) => inside(c[0], c[1]))) picked.push({ type: 'way', id: way.id });
        }
      }

      // 点
      if (Editor._boxFilterWants('point')) {
        for (const node of World.nodes.values()) {
          if (!inside(node.lat, node.lon)) continue;
          if (!node.tags && !Editor.includeUntaggedNodes) continue; // 只选有标签的点、除非显式要求
          picked.push({ type: 'node', id: node.id });
        }
      }

      // 关系：只有「全部」才带上，其它过滤里它既不是点也不是线面
      if ((Editor.boxFilter || 'all') === 'all') {
        for (const rel of World.relations.values()) {
          for (const m of rel.members) {
            if (m.type !== 'way') continue;
            const coords = World.wayCoords(World.getWay(m.ref));
            if (coords.length && coords.every((c) => inside(c[0], c[1]))) { picked.push({ type: 'relation', id: rel.id }); break; }
          }
        }
      }

      // 交通：自己名下的车站 / 线路 / 车辆
      if (Editor._boxFilterWants('transit')) picked.push(...Editor._pickTransitInBox(inside));

      return picked;
    },

    /** 框内的交通实体（车站 / 线路 / 车辆），只取自己名下的；transit.js 没准备好就返回空 */
    _pickTransitInBox(inside) {
      const Transit = window.G.Transit;
      if (!Transit || !Transit.data) return [];
      const me = Editor.myId || (typeof Transit.myId === 'function' ? Transit.myId() : null);
      const mine = (o) => !me || o.owner === me;
      const stations = Transit.data.stations || [];
      const byId = new Map();
      for (const st of stations) byId.set(st.id, st);
      const out = [];

      for (const st of stations) {
        if (!mine(st) || typeof st.lat !== 'number' || typeof st.lon !== 'number') continue;
        if (inside(st.lat, st.lon)) out.push({ type: TRANSIT_TYPE, entity: 'station', id: st.id, name: st.name });
      }
      for (const line of Transit.data.lines || []) {
        if (!mine(line)) continue;
        const coords = [];
        for (const c of line.pathCoords || []) { if (c) coords.push(c); }
        for (const sid of line.stops || []) {
          const st = byId.get(sid);
          if (st && typeof st.lat === 'number') coords.push([st.lat, st.lon]);
        }
        if (!coords.length) continue;
        if (coords.some((c) => inside(c[0], c[1]))) out.push({ type: TRANSIT_TYPE, entity: 'line', id: line.id, name: line.name });
      }
      for (const v of Transit.data.vehicles || []) {
        if (!mine(v) || typeof v.lat !== 'number' || typeof v.lon !== 'number') continue; // 没上线的车没有位置
        if (inside(v.lat, v.lon)) out.push({ type: TRANSIT_TYPE, entity: 'vehicle', id: v.id, name: v.name });
      }
      return out;
    },

    /** 把框选结果写进 multiSelect（交通实体也算"选中"，只是批量 OSM 操作会跳过它们） */
    applyBoxPick(picked, options = {}) {
      const keep = Editor.selection ? Editor.selection.type + ':' + Editor.selection.id : null;
      for (const it of Editor.multiSelect) {
        if (it.type === TRANSIT_TYPE) continue;
        if (keep && it.type + ':' + it.id === keep) continue;   // 单个选中的元素别解钉
        World.unpin(it.type, it.id);
      }
      Editor.multiSelect = picked;
      for (const it of picked) {
        if (it.type === TRANSIT_TYPE) continue;
        World.pin(it.type, it.id);
      }
      Editor._highlightTransitPick(picked);

      const names = { node: '点', way: '线/面', relation: '关系', [TRANSIT_TYPE]: '交通' };
      const byType = picked.reduce((acc, it) => { acc[it.type] = (acc[it.type] || 0) + 1; return acc; }, {});
      const detail = Object.entries(byType).map(([k, v]) => (names[k] || k) + ' ' + v).join('，');
      const filterName = (BOX_FILTERS.find((f) => f.id === (Editor.boxFilter || 'all')) || {}).name || '全部';
      if (!picked.length) {
        util.toast(`框内没有符合「${filterName}」的元素`, 'warn', 3000);
        util.statusHint(`框选（${filterName}）：框内没有元素`);
      } else {
        util.toast(`框选中 ${picked.length} 个元素（${detail}）`, options.refilter ? 'info' : 'success', 3500);
        util.statusHint(`已框选 ${picked.length} 个元素（过滤：${filterName}）· 可在左侧批量删除 / 批量套用标签 / 统计`);
      }
      Editor._renderPreview();
    },

    /** 只选到一个车站时给它加一圈高亮（复用交通面板的选中态绘制） */
    _highlightTransitPick(picked) {
      const Transit = window.G.Transit;
      if (!Transit) return;
      const stations = picked.filter((it) => it.entity === 'station');
      Transit.selectedStation = stations.length === 1 ? stations[0].id : null;
      if (Render.overlay) Render.overlay.redraw();
    },

    /** 切换框选类型过滤：立刻对已有框选重新生效，并作为下一次拖框的规则 */
    setBoxFilter(id) {
      const def = BOX_FILTERS.find((f) => f.id === id);
      if (!def) return;
      if (Editor.boxFilter === id) { Editor.renderBoxSelectOptions(); return; }
      Editor.boxFilter = id;
      if (Editor.lastBoxRect) {
        // 有上一次的矩形就重算，这样来回切换过滤不会"只能越筛越少"
        Editor.applyBoxPick(Editor.pickInBox(Editor.lastBoxRect), { refilter: true });
      } else if (Editor.multiSelect.length) {
        Editor.applyBoxPick(Editor.multiSelect.filter((it) => Editor._matchBoxFilter(it)), { refilter: true });
      } else {
        util.statusHint(`框选类型：${def.name} · 在地图上拖出矩形即可选中这一类元素`);
        util.toast(`框选类型：${def.name}`, 'info', 1800);
      }
      Editor.renderBoxSelectOptions();
    },

    /** 单个元素是否符合当前过滤（没有矩形可重算时的降级路径） */
    _matchBoxFilter(it) {
      if (it.type === TRANSIT_TYPE) return Editor._boxFilterWants('transit');
      if (it.type === 'node') return Editor._boxFilterWants('point');
      if (it.type === 'relation') return (Editor.boxFilter || 'all') === 'all';
      if (it.type === 'way') {
        const way = World.getWay(it.id);
        if (!way) return false;
        return World.isClosed(way) ? Editor._boxFilterWants('area') : Editor._boxFilterWants('line');
      }
      return false;
    },

    /** 批量删除框选的内容 */
    deleteMultiSelection() {
      const list = Editor.multiSelect.slice();
      if (!list.length) { util.toast('还没有框选任何元素', 'warn'); return; }
      const transitCount = list.filter((it) => it.type === TRANSIT_TYPE).length;
      if (!window.confirm(`确定删除这 ${list.length - transitCount} 个元素吗？（可以 Ctrl+Z 逐步撤销）`)) return;
      const ops = [];
      for (const it of list) {
        if (it.type === TRANSIT_TYPE) continue;   // 交通实体归交通面板管（车站/线路/车辆接口完全不同）
        const el = World.get(it.type, it.id);
        if (!el) continue;
        if (it.type === 'way') ops.push({ k: 'deleteWay', id: it.id, version: el.version });
        else if (it.type === 'node') ops.push({ k: 'deleteNode', id: it.id, version: el.version, cascade: true });
        else ops.push({ k: 'deleteRelation', id: it.id, version: el.version });
      }
      if (transitCount) util.toast(`框选里有 ${transitCount} 个交通实体已跳过：请在交通面板里删除车站/线路/车辆`, 'warn', 5000);
      if (!ops.length) return;
      Editor._send({ k: 'batch', ops, label: `批量删除 ${ops.length} 个元素` })
        .then(() => {
          util.toast(`已删除 ${ops.length} 个元素`, 'success');
          Editor.multiSelect = Editor.multiSelect.filter((it) => it.type === TRANSIT_TYPE);
          if (window.G.UI) window.G.UI.renderToolOptions();
          if (Render.markDirty) Render.markDirty();
        })
        .catch((err) => util.toast(err.message, 'error', 5000));
    },

    /** 批量套用标签 */
    applyTagsToSelection(key, value) {
      const list = Editor.multiSelect.slice();
      if (!list.length) { util.toast('请先框选元素', 'warn'); return; }
      if (!key) { util.toast('请填写标签名', 'warn'); return; }
      if (key.includes('=')) { util.toast('标签名不能包含等号', 'warn'); return; }
      const ops = [];
      let transitCount = 0;
      for (const it of list) {
        if (it.type === TRANSIT_TYPE) { transitCount += 1; continue; }   // 交通实体不写 OSM 标签
        const el = World.get(it.type, it.id);
        if (!el) continue;
        const tags = Object.assign({}, el.tags || {});
        if (value) tags[key] = value;
        else delete tags[key];
        // 只有明确知道版本的元素才带版本号（否则服务端会判为冲突）
        const v = el.version && el.version > 0 ? el.version : undefined;
        if (it.type === 'node') ops.push({ k: 'updateNode', id: it.id, version: v, tags });
        else if (it.type === 'way') ops.push({ k: 'updateWay', id: it.id, version: v, tags });
        else ops.push({ k: 'updateRelation', id: it.id, version: v, tags });
      }
      if (transitCount) util.toast(`${transitCount} 个交通实体不支持 OSM 标签，已跳过`, 'warn', 4000);
      if (!ops.length) return;
      if (ops.length > 200) { util.toast('一次最多批量修改 200 个元素，请缩小框选范围', 'warn', 4000); return; }
      Editor._send({ k: 'batch', ops, label: `批量设置 ${key}${value ? '=' + value : '（删除）'}` })
        .then(() => {
          util.toast(`已为 ${ops.length} 个元素${value ? `设置 ${key}=${value}` : `删除标签 ${key}`}`, 'success');
          Editor._refreshSelection();
        })
        .catch((err) => util.toast(err.message, 'error', 6000));
    },

    /** 统计框选内容 */
    summarizeSelection() {
      const list = Editor.multiSelect;
      if (!list.length) { util.toast('请先框选元素', 'warn'); return; }
      let length = 0;
      let area = 0;
      let nodes = 0;
      const cats = {};
      const transit = { station: 0, line: 0, vehicle: 0 };
      for (const it of list) {
        if (it.type === TRANSIT_TYPE) {
          transit[it.entity] = (transit[it.entity] || 0) + 1;
          continue;
        }
        if (it.type === 'way') {
          const way = World.getWay(it.id);
          if (!way) continue;
          nodes += way.nodes.length;
          const cat = window.G.Style ? window.G.Style.categoryOf(way.tags, World.isClosed(way) ? 'area' : 'line') : 'other';
          cats[cat] = (cats[cat] || 0) + 1;
          if (World.isClosed(way)) area += World.wayArea(way);
          else length += World.wayLength(way);
        } else if (it.type === 'node') {
          nodes += 1;
        }
      }
      const catText = Object.entries(cats).map(([k, v]) => `${k} ${v}`).join('，') || '—';
      const transitText = transit.station || transit.line || transit.vehicle
        ? `；交通：车站 ${transit.station} / 线路 ${transit.line} / 车辆 ${transit.vehicle}`
        : '';
      util.toast(`共 ${list.length} 个元素：线长合计 ${util.fmtLength(length)}，面积合计 ${util.fmtArea(area)}，节点 ${nodes} 个；分类：${catText}${transitText}`, 'info', 9000);
      util.statusHint(`框选统计：${list.length} 个元素 · 线长 ${util.fmtLength(length)} · 面积 ${util.fmtArea(area)}`);
    },

    /* ------------------------------ 左侧工具面板：追加编辑器自己的选项 ------------------------------ */
    /**
     * ui.js 每次重绘都会清空 #tool-options，所以在这里把它的 renderToolOptions 包一层，
     * 渲染完再把编辑器自己的选项（框选过滤、道路工具、节点/移动说明…）追加进去。
     * ui.js 的 renderToolOptions 里也会反过来调一次本函数，保证无论谁先加载都包得上。
     */
    _ensureOptionsHook() {
      const UI = window.G.UI;
      if (!UI || UI.__editorBoxOptionsHooked || typeof UI.renderToolOptions !== 'function') return;
      UI.__editorBoxOptionsHooked = true;
      const orig = UI.renderToolOptions;
      UI.renderToolOptions = function (...args) {
        const res = orig.apply(this, args);
        try { Editor.renderExtraOptions(); } catch (err) { console.warn('[editor] 工具选项渲染失败', err); }
        return res;
      };
    },

    /**
     * 按当前工具把编辑器的选项追加到「工具选项」面板。
     * 这里只放**这个工具自己的动作**：
     *   select     —— 点击行为（选择/删除/复制）、复制选中、删除选中，由 ui.js 画
     *   boxselect  —— 类型过滤 / 批量限速 / 批量改类型
     *   line       —— 道路工具（延伸 / 分割 / 合并）
     *   move/nodes —— 各自的开关
     * 新建要素的"画之前"设置（名字 / 类型表 / 楼层 / 设站模式）只在创作面板 #inspector-create 里出现一次，
     * 这里绝不再挂第二套类型表（那就是用户说的"同一个设置两套入口"）。
     */
    renderExtraOptions() {
      const box = util.$('#tool-options');
      if (!box) return;
      Editor._ensureOptionsHook();
      if (box.querySelector('.preset-cats')) return;   // 预设浏览器正开着，别挤进去
      switch (Editor.tool) {
        case 'boxselect': Editor.renderBoxSelectOptions(); break;
        case 'line': Editor.renderDrawOptions(); break;
        case 'move': Editor.renderMoveOptions(); break;
        case 'nodes': Editor.renderNodeOptions(); break;
        default: break;
      }
    },

    /* ------------------------------ 面板小零件 ------------------------------ */
    /**
     * 一行「标签 + ?」：长说明收进弹层（ui.js 的 optRow 是同一套零件，这里做个取用兜底）。
     * 加载顺序：editor.js 在 ui.js 之前，所以只能在渲染时（不是加载时）取 window.G.UI。
     */
    _helpRow(label, helpText) {
      const UI = window.G.UI;
      if (UI && typeof UI.optRow === 'function') return UI.optRow(label, helpText);
      return util.el('div', 'opt-row opt-row-label', util.esc(label));
    },
    /** 面板分隔线 */
    _panelSection(title, dataKey) {
      const wrap = util.el('div', 'opt-field');
      wrap.dataset[dataKey] = '1';
      wrap.style.borderTop = '1px solid rgba(255,255,255,0.10)';
      wrap.style.marginTop = '6px';
      wrap.style.paddingTop = '4px';
      if (title) wrap.appendChild(util.el('div', 'opt-head', title));
      return wrap;
    },

    _panelChip(text, onclick, opts = {}) {
      const b = util.el('button', 'chip' + (opts.active ? ' active' : ''), text);
      if (opts.title) b.title = opts.title;
      if (opts.dataAttr) b.dataset[opts.dataAttr] = opts.dataValue || '1';
      b.onclick = onclick;
      return b;
    },

    /**
     * 某一类要素的类型分组。
     * 点要素（poi）特殊：POI_GROUPS 后面直接接上"其它点状要素"（树 / 电线杆 / 消防栓…），
     * 于是「加点」面板只有**一张表、一个搜索框**，不再出现"点要素（POI）+ 其它点要素"两段重复列表。
     */
    typeGroupsFor(scope) {
      if (!TYPE_GROUPS[scope]) return TYPE_GROUPS[scope];
      return scope === 'poi' ? poiTypeGroups() : TYPE_GROUPS[scope];
    },

    /**
     * 「改类型」芯片列表：按中文名映射到标签，支持搜索。
     * 把整块（标题 + 搜索框 + 芯片）挂到 box 上，同时返回它，方便调用方再加说明文字。
     *
     * opts.matchTags —— 元素当前的标签：命中的那套类型会高亮成 active（"现在的类型"），
     * 于是芯片变成开关：点未选中的 = 换成这套类型，点已选中的 = 换回上一个类型
     * （onPick 的第 3 个参数就是"点的是不是当前类型"）。
     */
    renderTypePicker(box, opts = {}) {
      const scope = opts.scope;
      const groups = Editor.typeGroupsFor(scope);
      if (!groups || !groups.length || !box) return null;
      const matchTags = opts.matchTags || null;
      const wrap = util.el('div', 'opt-field');
      wrap.dataset.typePicker = scope;
      if (opts.title !== null) {
        wrap.appendChild(util.el('div', 'opt-head', opts.title || `改类型（${TYPE_SCOPE_LABEL[scope] || scope}）`));
      }
      const search = util.el('input', 'opt-search');
      search.placeholder = opts.searchPlaceholder || '搜索类型（如 学校 / 加油站 / 主干道）';
      wrap.appendChild(search);
      const list = util.el('div', 'preset-chips');
      wrap.appendChild(list);
      const matches = (it, q) => !q
        || it.name.toLowerCase().includes(q)
        || (it.kw || []).some((k) => String(k).toLowerCase().includes(q))
        || Object.entries(it.tags).some(([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q));
      /** 这套类型是不是元素现在的类型（每个标签都对得上才算） */
      const isCurrent = (it) => !!matchTags && Object.entries(it.tags)
        .every(([k, v]) => String(matchTags[k] == null ? '' : matchTags[k]) === String(v));
      const render = () => {
        const q = String(search.value || '').trim().toLowerCase();
        list.innerHTML = '';
        let shown = 0;
        for (const g of groups) {
          const items = g.items.filter((it) => matches(it, q));
          if (!items.length) continue;
          // 分组标题：工具面板和检查器两边都要好看，所以自带一点样式（app.css 由别人维护）
          const head = util.el('div', 'preset-hint', `${g.ico || ''} ${util.esc(g.name)}`.trim());
          head.style.width = '100%';
          head.style.fontSize = '10.5px';
          head.style.color = 'var(--fg-mute)';
          list.appendChild(head);
          for (const it of items) {
            const chip = util.el('button', 'preset-chip', `${it.ico || ''} ${util.esc(it.name)}`);
            chip.title = Object.entries(it.tags).map(([k, v]) => `${k}=${v}`).join('\n');
            const current = isCurrent(it);
            if (current) {
              chip.classList.add('active');
              chip.setAttribute('aria-pressed', 'true');
              chip.title += '\n（当前类型：再点一下换回上一个类型）';
            }
            chip.onclick = () => { if (opts.onPick) opts.onPick(it, scope, current); };
            list.appendChild(chip);
            shown += 1;
          }
        }
        if (!shown) list.innerHTML = '<div class="empty-hint small">没有匹配的类型</div>';
      };
      search.oninput = render;
      search.onkeydown = (ev) => { if (ev.key === 'Enter') ev.preventDefault(); };
      render();
      box.appendChild(wrap);
      return wrap;
    },

    /** 这个元素带了哪些"主类型标签"（判断它属于哪一类、该看预设表里的哪一段） */
    primaryKeysOf(tags) {
      const out = [];
      for (const k of PRIMARY_KEYS) {
        if (tags && tags[k] !== undefined) out.push(k === 'building:part' ? 'building' : k);
      }
      return Array.from(new Set(out));
    },

    /** 画面工具的「区域类型」大类 → 预设表里对应的主标签（建筑有类表，返回 null） */
    presetKeysForAreaKind(kind) {
      return AREA_KIND_PRESET_KEYS[kind] || null;
    },

    /**
     * 类型选择器的唯一入口 —— 下面四个地方都调它，别再各写一份芯片列表：
     *   1) 左侧工具面板（画线 / 画面 / 加点工具）
     *   2) 右侧新建面板（inspector.showToolConfig）
     *   3) 检查器元素面板的「改类型」（inspector.renderTypeSection）
     *   4) 框选（多选）面板的「批量改类型」
     *
     * 规则：一个元素类只有一张表（TYPE_GROUPS：点要素 POI_GROUPS / 建筑 BUILDING_TYPES / 道路 ROAD_TYPES）。
     * 类表覆盖不到的要素（铁路 / 水系 / 用地 / 自然 / 站台 / 电线…）再补一段预设表（window.G.Presets），
     * 而预设表里凡是类表已经定义过的条目都会被 presetCoveredByClass 过滤掉 ——
     * 所以同一个要素永远不会同时看到两套等价类型，同一种类型也只有一个定义处。
     * 点要素（scope='poi'）例外：真正的点已经并进那一张表了，**不再补第二段预设列表**。
     *
     * opts:
     *   scope                  'poi' | 'building' | 'road' | null（null 就是"没有类表，只用预设表"）
     *   classTitle             类表那一段的标题（默认「改类型（建筑/道路等级/点要素）」）
     *   presetKind             'point' | 'line' | 'area'：预设表只留这种几何
     *   presetKeys             ['landuse','natural'…]：预设表只留含这些主标签的条目
     *   presets                false = 这一段预设表不要（例如建筑类用左侧的「区域类型」切换）
     *   onPick(item, scope)    scope 为类表作用域，预设表条目给 null
     *   onPresetPick(item)     预设表条目的回调（不写就用 onPick(item, null)）
     */
    renderTypeChooser(box, opts = {}) {
      if (!box) return null;
      const scope = opts.scope || null;
      const wrap = util.el('div', 'type-chooser');
      wrap.dataset.typeChooser = scope || 'preset';
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '4px';
      let rendered = false;

      if (scope && TYPE_GROUPS[scope]) {
        const picker = Editor.renderTypePicker(wrap, {
          scope,
          title: opts.classTitle === undefined ? null : opts.classTitle,
          searchPlaceholder: opts.searchPlaceholder || Editor.typeSearchPlaceholder(scope),
          matchTags: opts.matchTags || null,
          onPick: opts.onPick,
        });
        rendered = !!picker;
      }

      if (opts.presets !== false && scope !== 'poi') {
        // 点要素那张表已经把"真正的点"合并进去了（见 poiTypeGroups），所以这里不再补第二段预设表
        const presetOpts = {
          presetKind: opts.presetKind || null,
          presetKeys: opts.presetKeys || null,
          title: opts.presetTitle,
          searchPlaceholder: opts.presetSearchPlaceholder,
          matchTags: opts.matchTags || null,
          onPick: opts.onPresetPick || ((item, sc, current) => { if (opts.onPick) opts.onPick(item, null, current); }),
        };
        const preset = Editor.renderPresetChooser(wrap, presetOpts);
        rendered = !!preset || rendered;
      }

      if (!rendered) return null;
      box.appendChild(wrap);
      return wrap;
    },

    /** 类表搜索框的提示文字（几处共用，别再各写一份） */
    typeSearchPlaceholder(scope) {
      if (scope === 'poi') return '搜索点要素类型（公交站牌 / 加油站 / 地铁出入口…）';
      if (scope === 'building') return '搜索建筑类型（学校 / 医院 / 超市 / 写字楼…）';
      if (scope === 'road') return '搜索道路等级（高速 / 主干道 / 步行街…）';
      return '搜索类型';
    },

    /**
     * 预设表选择器：只在类表覆盖不到的地方出现。
     * 铁路 / 水系 / 用地 / 自然 / 休闲 / 站台 / 电线 这些要素没有"类表"，
     * 它们唯一的一张表就是 presets.js —— 这里只是把它按几何与主标签筛出来。
     */
    renderPresetChooser(box, opts = {}) {
      const G = window.G;
      if (!G.Presets || !box || typeof G.Presets.all !== 'function') return null;
      const kind = opts.presetKind || null;
      const keys = opts.presetKeys || null;
      const all = G.Presets.all().filter((it) => {
        if (presetCoveredByClass(it)) return false;               // 类表里已有同一个类型 → 不重复列
        if (kind && it.kind !== kind) return false;
        if (keys && !keys.some((k) => it.tags[k] !== undefined)) return false;
        return true;
      });
      if (!all.length) return null;

      const wrap = util.el('div', 'opt-field');
      wrap.dataset.presetChooser = '1';
      if (opts.title !== null) {
        wrap.appendChild(util.el('div', 'opt-head', opts.title || '类型表之外的要素（预设表）'));
      }
      const search = util.el('input', 'opt-search');
      search.placeholder = opts.searchPlaceholder || '搜索（铁路 / 水系 / 公园 / 电线…）';
      wrap.appendChild(search);
      const list = util.el('div', 'preset-chips');
      wrap.appendChild(list);

      const matches = (it, q) => !q
        || it.name.toLowerCase().includes(q)
        || (it.keywords || []).some((k) => String(k).toLowerCase().includes(q))
        || Object.entries(it.tags).some(([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q));
      // 元素当前的类型（opts.matchTags）会高亮：点它一下就是换回上一个类型（和类表芯片同一套开关语义）
      const matchTags = opts.matchTags || null;
      const isCurrent = (it) => !!matchTags && Object.entries(it.tags)
        .every(([k, v]) => String(matchTags[k] == null ? '' : matchTags[k]) === String(v));
      const render = () => {
        const q = String(search.value || '').trim().toLowerCase();
        list.innerHTML = '';
        let shown = 0;
        for (const item of all) {
          if (!matches(item, q)) continue;
          if (shown >= 60) break;
          const chip = util.el('button', 'preset-chip', `${item.icon || ''} ${util.esc(item.name)}`);
          chip.title = Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join('\n');
          const current = isCurrent(item);
          if (current) {
            chip.classList.add('active');
            chip.setAttribute('aria-pressed', 'true');
            chip.title += '\n（当前类型：再点一下换回上一个类型）';
          }
          chip.onclick = () => { if (opts.onPick) opts.onPick(item, null, current); };
          list.appendChild(chip);
          shown += 1;
        }
        if (!shown) list.innerHTML = '<div class="empty-hint small">没有匹配的类型</div>';
      };
      search.oninput = render;
      search.onkeydown = (ev) => { if (ev.key === 'Enter') ev.preventDefault(); };
      render();

      // 全部预设（分类 + 搜索）仍然从 ui.js 的浏览器里进，但入口只留这一个
      if (opts.browse !== false && G.UI && typeof G.UI.showPresetBrowser === 'function' && opts.onPick) {
        const more = util.el('button', 'preset-chip more', '全部预设…');
        more.onclick = () => G.UI.showPresetBrowser((item) => opts.onPick(item), opts.browseTitle || '选择类型预设');
        list.appendChild(more);
      }
      box.appendChild(wrap);
      return wrap;
    },

    /** 预设表条目在"新建"语境下的处理：只改下一个新建要素的默认标签，不动已选中的元素 */
    onPresetPickForDraw(item) {
      if (!item || !item.tags) return;
      Editor.setDrawPreset(item);
      const text = Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join('，');
      util.statusHint(`新建要素默认标签：${text}`);
      util.toast(`新建时使用「${item.name}」：${text}`, 'success', 3200);
      if (window.G.UI) window.G.UI.renderToolOptions();
      if (window.G.Inspector) window.G.Inspector.showToolConfig();
    },

    /** 点一下类型芯片：有选中元素就改它，没有就当成"下一个新建要素的默认类型" */
    onTypePick(item, scope) {
      if (!item || !item.tags) return;
      if (scope) {
        if (Editor._elementTargets(scope).length) { Editor.applyType(item, scope); return; }
        Editor.setDrawType(item, scope);
        return;
      }
      // 预设表条目（类表没覆盖的要素，如 铁路/水系/公园）在检查器里：套到当前元素上
      if (Editor.selection) { Editor.applyPreset(item); return; }
      Editor.onPresetPickForDraw(item);
    },

    /** 把类型设为"新建要素的默认标签"（不落盘，画完才提交） */
    setDrawType(item, scope) {
      const tool = scope === 'poi' ? 'point' : scope === 'building' ? 'area' : 'line';
      const target = TOOLS.some((t) => t.id === Editor.tool) ? Editor.tool : tool;
      const tags = Object.assign({}, Editor.drawTags || {});
      for (const key of TYPE_CLEAR_KEYS[scope] || []) delete tags[key];
      // 换类型：先清掉同义标签（building/amenity/shop…），再写上这套新标签；
      // lanes / oneway / maxspeed / name / addr 之类的属性与名字都保留（道路除外）
      Object.assign(tags, item.tags);
      if (scope === 'building') {
        Editor.drawAreaKind = 'building';
        tags['building:levels'] = String(Editor.drawFloors || tags['building:levels'] || 3);
      }
      Editor.drawTags = tags;
      Editor.drawTagsByTool[target] = Object.assign({}, tags);
      if (scope === 'road') {
        Editor.drawName = '';
        Editor.drawNamesByTool[target] = '';
      }
      const text = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join('，');
      const targetName = TOOLS.find((t) => t.id === target);
      util.statusHint(`新建${TYPE_SCOPE_LABEL[scope] || ''}默认标签：${text}${scope === 'road' ? '（道路只写等级，不加名字）' : ''}`);
      util.toast(`新建时使用「${item.name}」：${text}`, 'success', 3000);
      if (window.G.UI && targetName && target !== Editor.tool) window.G.UI.selectTool(target);
      else if (window.G.UI) window.G.UI.renderToolOptions();
      if (window.G.Inspector) window.G.Inspector.showToolConfig();
    },

    /** 改类型的作用对象：优先当前选中的元素，其次框选结果，最后按工具语义兜底 */
    _elementTargets(scope) {
      const ok = (it) => {
        if (it.type === TRANSIT_TYPE) return false;
        const el = World.get(it.type, it.id);
        if (!el) return false;
        return Editor.typeScopeFor(it.type, el) === scope;
      };
      const out = [];
      const seen = new Set();
      const push = (it) => {
        if (!it || seen.has(it.type + ':' + it.id) || !ok(it)) return;
        seen.add(it.type + ':' + it.id);
        out.push(it);
      };
      push(Editor.selection);
      for (const it of Editor.multiSelect) push(it);
      return out;
    },

    /**
     * 一个元素该用哪套类型表（没有对应类表就返回 null，改用预设表那一段）：
     *   点要素 → POI（有 amenity/shop/railway… 这些 POI 标签，或干脆没标签）
     *   闭合线 → 建筑（building / building:part）；公园、水面、用地这些闭合面不是"建筑"，走预设表
     *   开放线 → 道路（有 highway，或没有任何"别的类"的标签）；铁路、水系、电线、围墙走预设表
     * 以前这里只看几何形状，于是给河流列「道路等级」芯片、给树列「POI 类型」芯片 —— 那是归类错误。
     */
    typeScopeFor(type, el) {
      if (!type || !el) return null;
      const tags = el.tags || {};
      if (type === 'node') {
        const keys = Object.keys(tags);
        if (!keys.length) return 'poi';
        if (keys.some((k) => POI_KEYS.includes(k))) return 'poi';
        // 只剩下 name / natural / power / man_made 之类的点（树、电线杆…）：类表不认识 → 预设表
        const onlyProps = keys.every((k) => k === 'name' || k.indexOf('name:') === 0 || k === 'ref' || k === 'ele' || k === 'addr' || k.indexOf('addr:') === 0);
        return onlyProps ? 'poi' : null;
      }
      if (type !== 'way') return null;
      if (World.isClosed(el)) {
        return (tags.building || tags['building:part']) ? 'building' : null;
      }
      if (tags.highway) return 'road';
      const others = ['railway', 'waterway', 'aeroway', 'barrier', 'power', 'man_made', 'route', 'natural', 'landuse', 'leisure', 'water'];
      if (others.some((k) => tags[k] !== undefined)) return null;
      return 'road';   // 没有任何明显归类的线条，仍按道路对待（默认新建的就是路）
    },

    /**
     * 把预设表的类型套到**当前选中的元素**上（检查器里"类表没覆盖的要素"那一段用）。
     * 先清掉这条预设没写的同类主标签（免得一条河流上同时留着 landuse=grass），再合并，
     * name / addr / 几何属性都保留。一次 updateXxx = 一步撤销。
     */
    applyPreset(item) {
      if (!item || !item.tags) return;
      const sel = Editor.selection;
      if (!sel) { util.toast('请先用「选择」工具点中一个元素', 'warn', 3500); return; }
      const el = World.get(sel.type, sel.id);
      if (!el) return;
      const tags = Object.assign({}, el.tags || {});
      for (const key of PRESET_CLEAR_KEYS) {
        if (item.tags[key] === undefined) delete tags[key];
      }
      Object.assign(tags, item.tags);
      const v = el.version && el.version > 0 ? el.version : undefined;
      const op = sel.type === 'node' ? { k: 'updateNode', id: sel.id, version: v, tags }
        : sel.type === 'way' ? { k: 'updateWay', id: sel.id, version: v, tags }
          : { k: 'updateRelation', id: sel.id, version: v, tags };
      const text = Object.entries(item.tags).map(([k, val]) => `${k}=${val}`).join('，');
      util.statusHint(`正在改为「${item.name}」…`);
      Editor._send(op)
        .then(() => {
          util.statusHint(`已改为「${item.name}」：${text}`);
          util.toast(`已改为「${item.name}」（${text}）；名称与地址等标签保留（Ctrl+Z 一步撤销）`, 'success', 4500);
          Editor._refreshSelection();
        })
        .catch((err) => {
          util.statusHint('');
          util.toast(err.message, 'error', 5000);
        });
    },

    /** 改类型：清掉同义标签再写上新类型，一次 batch 提交 = 一步撤销 */
    applyType(item, scope) {
      if (!item || !item.tags) return;
      const wanted = scope || item.scope;
      const targets = Editor._elementTargets(wanted);
      if (!targets.length) {
        util.toast(`没有可改类型的${TYPE_SCOPE_LABEL[wanted] || '元素'}：请先用「选择」工具点中它，或框选一批`, 'warn', 4500);
        return;
      }
      const ops = [];
      let droppedName = 0;
      for (const it of targets) {
        const el = World.get(it.type, it.id);
        if (!el) continue;
        const tags = Object.assign({}, el.tags || {});
        // 记下改之前的整套标签：同一个芯片再点一下就能"换回上一个类型"（见 revertType）
        Editor._typeUndo[it.type + ':' + it.id] = { itemId: item.id, tags: Object.assign({}, el.tags || {}) };
        for (const key of TYPE_CLEAR_KEYS[wanted] || []) {
          if (wanted === 'road' && (key === 'name' || key === 'name:zh' || key === 'name:en') && tags[key]) droppedName += 1;
          delete tags[key];
        }
        Object.assign(tags, item.tags);
        const v = el.version && el.version > 0 ? el.version : undefined;
        if (it.type === 'way') ops.push({ k: 'updateWay', id: it.id, version: v, tags });
        else if (it.type === 'node') ops.push({ k: 'updateNode', id: it.id, version: v, tags });
        else ops.push({ k: 'updateRelation', id: it.id, version: v, tags });
      }
      if (!ops.length) { util.toast('这些元素都没法改类型（关系暂不支持）', 'warn', 3500); return; }
      const tagText = Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join('，');
      util.statusHint(`正在改类型：${item.name}…`);
      Editor._send({ k: 'batch', ops, label: `改类型：${item.name}` })
        .then(() => {
          util.statusHint(`已改为「${item.name}」：${tagText}`);
          util.toast(`已改为「${item.name}」（${tagText}）${ops.length > 1 ? `，共 ${ops.length} 个元素` : ''}${droppedName ? '；道路不带名字，已清掉 name 标签' : ''}（Ctrl+Z 一步撤销）`, 'success', 5000);
          Editor._refreshMultiSelection();
        })
        .catch((err) => {
          util.statusHint('');
          util.toast(err.message, 'error', 6000);
        });
    },

    /**
     * 「改类型」芯片 = 开关：点未选中的那套类型 → 换成它（芯片高亮）；
     * 再点同一个高亮的芯片 → 换回换之前的那套类型（revertType）。
     * scope 为 null 表示这是预设表条目（铁路 / 水系 / 用地…），走 applyPreset 那条路。
     */
    applyTypeToggle(item, scope, wasCurrent) {
      if (wasCurrent) return Editor.revertType(item, scope);
      if (scope) return Editor.applyType(item, scope);
      Editor._rememberType(item);
      return Editor.applyPreset(item);
    },

    /** 记下当前选中元素在改类型前的整套标签（供 revertType 还原） */
    _rememberType(item) {
      const sel = Editor.selection;
      if (!sel) return;
      const el = World.get(sel.type, sel.id);
      if (!el) return;
      Editor._typeUndo[sel.type + ':' + sel.id] = { itemId: item && item.id, tags: Object.assign({}, el.tags || {}) };
    },

    /** 换回上一个类型：把 applyType 记下的那套旧标签原样写回去（一次 batch = 一步撤销） */
    revertType(item, scope) {
      const wanted = scope || (item && item.scope) || null;
      const targets = Editor._elementTargets(wanted);
      const ops = [];
      const done = [];
      for (const it of targets) {
        const key = it.type + ':' + it.id;
        const prev = Editor._typeUndo[key];
        const el = World.get(it.type, it.id);
        if (!prev || !el) continue;
        const op = it.type === 'way' ? { k: 'updateWay', id: it.id, version: el.version, tags: prev.tags }
          : it.type === 'node' ? { k: 'updateNode', id: it.id, version: el.version, tags: prev.tags }
            : { k: 'updateRelation', id: it.id, version: el.version, tags: prev.tags };
        ops.push(op);
        done.push(key);
      }
      if (!ops.length) {
        util.toast('没有可换回的上一个类型（这个类型是在别处改的，用 Ctrl+Z 撤销）', 'warn', 4000);
        return;
      }
      util.statusHint('正在换回上一个类型…');
      Editor._send({ k: 'batch', ops, label: '换回上一个类型' })
        .then(() => {
          for (const key of done) delete Editor._typeUndo[key];
          const text = Object.entries((item && item.tags) || {}).map(([k, v]) => `${k}=${v}`).join('，');
          util.statusHint('已换回上一个类型');
          util.toast(`已换回上一个类型（撤销刚才的「${(item && item.name) || text}」）${ops.length > 1 ? `，共 ${ops.length} 个元素` : ''}（Ctrl+Z 一步撤销）`, 'success', 4500);
          Editor._refreshMultiSelection();
        })
        .catch((err) => {
          util.statusHint('');
          util.toast(err.message, 'error', 6000);
        });
    },
    /* ------------------------------ 框选面板：类型过滤 + 补限速 ------------------------------ */
    /** 渲染「框选类型过滤」芯片 + 「按等级补 maxspeed」按钮（只在框选工具下出现） */
    renderBoxSelectOptions() {
      if (Editor.tool !== 'boxselect') return;
      const box = util.$('#tool-options');
      if (!box) return;
      Editor._ensureOptionsHook();
      if (box.querySelector('.preset-cats')) return;   // 预设浏览器正开着，别挤进去
      if (box.querySelector('[data-box-options]')) return;

      const wrap = util.el('div', 'opt-field');
      wrap.dataset.boxOptions = '1';
      wrap.style.borderTop = '1px solid rgba(255,255,255,0.10)';
      wrap.style.marginTop = '6px';
      wrap.style.paddingTop = '2px';

      // 类型过滤
      wrap.appendChild(Editor._helpRow('框选类型过滤', '切一次过滤就按上一次的框重算选中结果，下一次拖框也按它选；「全部」不留分类。'));
      const chips = util.el('div', 'opt-chips');
      for (const f of BOX_FILTERS) {
        const b = util.el('button', 'chip' + ((Editor.boxFilter || 'all') === f.id ? ' active' : ''), f.name);
        b.title = f.tip;
        b.dataset.boxFilter = f.id;
        b.onclick = () => Editor.setBoxFilter(f.id);
        chips.appendChild(b);
      }
      wrap.appendChild(chips);

      // 批量补限速：这是「限速」的**次要**入口，单条道路请到右侧检查器的「限速」行里改
      const roadIds = Editor._selectedWays();
      wrap.appendChild(Editor._helpRow(`批量限速（选中 ${roadIds.length} 条道路）`,
        '按 highway 等级填 maxspeed（motorway 120 / trunk 100 / primary 70 / residential 30…）；'
        + '单条道路在右侧检查器的「限速」行里改。一次最多 300 条，一步撤销。'));
      const btn = util.el('button', 'opt-btn', '按等级补限速');
      btn.title = '按 highway 等级给这批道路填 maxspeed';
      btn.onclick = () => Editor.fillMissingMaxspeed();
      wrap.appendChild(btn);

      const coverRow = util.el('label', 'opt-current row');
      coverRow.title = '勾上以后，连已经有 maxspeed 的道路也一起改成按等级的值';
      const cover = util.el('input');
      cover.type = 'checkbox';
      cover.checked = !!Editor.boxMaxspeedOverwrite;
      cover.dataset.boxOverwrite = '1';
      cover.onchange = () => {
        Editor.boxMaxspeedOverwrite = cover.checked;
        util.statusHint(cover.checked ? '批量补限速：会覆盖已有值' : '批量补限速：只补没有 maxspeed 的道路');
      };
      coverRow.appendChild(cover);
      coverRow.appendChild(util.el('span', null, '覆盖已有值'));
      wrap.appendChild(coverRow);

      // 批量改类型：建筑 / 道路 / 点要素各一套芯片，一次 batch = 一步撤销。
      // 没框到东西时不摆出来（"批量"的类型表要有一批元素才有意义，也免得和右侧检查器的单元素类型表同屏）
      wrap.appendChild(Editor._helpRow('批量改类型', `只对框选里的${TYPE_SCOPE_LABEL[Editor.boxTypeScope || 'building']}生效，`
        + '点一下芯片即提交（一步撤销）。'));
      if (!Editor.multiSelect.length) {
        // 框选数量那一行已经由「工具选项」上面的「框选结果」给出，这里不再重复一句话
        box.appendChild(wrap);
        return;
      }
      const scopeRow = util.el('div', 'opt-chips');
      for (const scope of ['building', 'road', 'poi']) {
        scopeRow.appendChild(Editor._panelChip(TYPE_SCOPE_LABEL[scope], () => {
          Editor.boxTypeScope = scope;
          Editor.renderBoxSelectOptions();
        }, { active: (Editor.boxTypeScope || 'building') === scope, title: `把框选到的${TYPE_SCOPE_LABEL[scope]}一次改成同一个类型`, dataAttr: 'boxScope', dataValue: scope }));
      }
      wrap.appendChild(scopeRow);
      const scope = Editor.boxTypeScope || 'building';
      Editor.renderTypeChooser(wrap, {
        scope,
        classTitle: null,
        presets: false,   // 批量只按三个类表改（类表没覆盖的要素不在这里动）
        onPick: (it, sc) => Editor.applyType(it, sc),
        searchPlaceholder: '搜索类型（学校 / 加油站 / 主干道…）',
      });

      box.appendChild(wrap);
    },

    /* ------------------------------ 画线工具：道路工具（延伸/分割/合并） ------------------------------ */
    /**
     * 画线工具的选项：只放"改造已选中的那条道路"的动作。
     * 不在这里挂类型表 —— 新建道路的默认等级在创作面板里选，选中道路的改类型在右侧检查器里改。
     */
    renderDrawOptions() {
      if (Editor.tool !== 'line') return;
      const box = util.$('#tool-options');
      if (!box || box.querySelector('[data-way-options]')) return;

      box.appendChild(Editor._helpRow('道路工具', '改造**已选中**的那条道路：延伸起点 / 终点、在此处分割、与相邻道路合并。<br>'
        + '延伸：点按钮后依次点落点，双击或 Enter 完成（25 米内自动接上）。<br>'
        + '分割：点按钮后点道路上的位置。合并：点按钮后再点另一条路。<br>'
        + '加 / 删点在「⬦ 节点」工具里（也可 Alt+点击道路加点、Alt+点击节点删点）。'));
      const wrap = Editor._panelSection(null, 'wayOptions');
      const sel = Editor.selection && Editor.selection.type === 'way' ? World.getWay(Editor.selection.id) : null;
      wrap.appendChild(util.el('div', 'opt-current', sel
        ? `当前道路 #${sel.id}${sel.tags && sel.tags.name ? `「${sel.tags.name}」` : ''} · ${sel.nodes.length} 个节点 · ${World.isClosed(sel) ? '闭合' : '开放'} · 长度 ${util.fmtLength(World.wayLength(sel))}`
        : '先用「选择」工具点一下要改造的道路，下面的按钮就会作用在它上面。'));

      // 延伸起点 / 延伸终点
      const row1 = util.el('div', 'opt-chips');
      row1.appendChild(Editor._panelChip('⌁ 延伸起点', () => Editor.extendFrom('start'), {
        title: '从这条路的起点继续往前延伸：之后依次点击落点，双击/Enter 完成。若新端点距相邻道路的端点 25 米以内，会自动接上（一步撤销）',
        active: !!Editor._extendAnchor && Editor._extendAnchor.end === 'start',
      }));
      row1.appendChild(Editor._panelChip('⌁ 延伸终点', () => Editor.extendFrom('end'), {
        title: '从这条路的终点继续往外延伸：之后依次点击落点，双击/Enter 完成。若新端点距相邻道路的端点 25 米以内，会自动接上（一步撤销）',
        active: !!Editor._extendAnchor && Editor._extendAnchor.end === 'end',
      }));
      wrap.appendChild(row1);

      // 分割 / 合并
      const row2 = util.el('div', 'opt-chips');
      row2.appendChild(Editor._panelChip('✂ 在此处分割', () => Editor.startDrawOp('split'), {
        title: '点一下按钮，然后点击这条道路上的任意位置：就地插入一个节点并一分为二（点在已有节点上直接分）',
        active: Editor.drawOp === 'split',
      }));
      row2.appendChild(Editor._panelChip('🔗 与相邻道路合并', () => Editor.startDrawOp('merge'), {
        title: '点一下按钮，再点另一条路：自动把两边最近的端点接上；25 米内并成同一个路口，更远则用直线接上缺口',
        active: Editor.drawOp === 'merge',
      }));
      wrap.appendChild(row2);

      if (Editor.drawMode || Editor.drawOp || Editor._extendAnchor) {
        const row3 = util.el('div', 'opt-chips');
        row3.appendChild(Editor._panelChip('✕ 结束改造', () => Editor.endWayOps(), { title: '回到普通画线状态' }));
        wrap.appendChild(row3);
      }

      const modeText = Editor._extendAnchor ? '延伸中：依次点击落点，双击/Enter 完成，Esc 取消'
        : Editor.drawOp === 'split' ? '分割：点击道路上的位置（点哪儿分哪儿）'
          : Editor.drawOp === 'merge' ? '合并：点击要接上的另一条道路'
            : Editor.drawMode === 'addnode' ? '加点：点击道路上的位置即插入节点'
              : Editor.drawMode === 'delnode' ? '删点：点击道路上的节点即删除（路口/关系节点会被拒绝）'
                : null;
      if (modeText) wrap.appendChild(util.el('div', 'opt-current', `当前：${modeText}`));

      box.appendChild(wrap);
    },

    /* ------------------------------ 设站：模式 + 站名 ------------------------------ */
    /**
     * 当前设站模式。**唯一来源是 Transit.stationMode** —— 交通面板的「设站模式」用的就是它，
     * 所以「设站」工具面板、检查器的「新建车站」面板、交通面板三处永远一致；
     * 没有 Transit 时（理论上不会发生）退回 Editor.stationMode 记住上次选择。
     */
    currentStationMode() {
      const T = window.G.Transit;
      const id = (T && T.stationMode) || Editor.stationMode || 'rail';
      return STATION_MODES.some((m) => m.id === id) ? id : 'rail';
    },

    /** 设站模式 id（就是服务端的站点 kind）→ 表项；认不出来的值一律当"铁路" */
    stationModeInfo(id) {
      const want = id || Editor.currentStationMode();
      return STATION_MODES.find((m) => m.id === want) || STATION_MODES[0];
    },

    /** 站点 kind 归到哪张路网：公交站贴道路，其余（含地铁/轻轨/有轨电车）贴轨道 */
    stationKindOf(kind) {
      return kind === 'bus' ? 'bus' : 'rail';
    },

    /**
     * 切换设站模式：写的是**共享状态** Transit.stationMode（交通面板同一个值），
     * 再让创作面板（#inspector-create）、交通面板一起重画 —— 芯片高亮永远同步。
     */
    setStationMode(id) {
      const m = STATION_MODES.find((x) => x.id === id);
      if (!m) return;
      const Transit = window.G.Transit;
      if (Transit) Transit.stationMode = m.id;      // 交通面板读的就是这个值
      Editor.stationMode = m.id;                    // 没有 Transit 时的兜底记忆
      util.statusHint(`设站模式：${m.ico} ${m.name} —— ${m.snapText}`);
      util.toast(`设站模式：${m.ico} ${m.name}（点地图放置）`, 'info', 2600);
      if (window.G.UI && typeof window.G.UI.renderToolOptions === 'function') window.G.UI.renderToolOptions();
      if (window.G.Inspector && typeof window.G.Inspector.showToolConfig === 'function') window.G.Inspector.showToolConfig();
      if (Transit && typeof Transit.renderPanelSoon === 'function') Transit.renderPanelSoon();
    },

    /**
     * 设站模式芯片（**唯一一份渲染**）：创作面板（#inspector-create）里用它，
     * 交通面板的「设站模式」用的是同一个 Transit.stationMode ——
     * 不许各写一份芯片列表，否则又会出现"同一个设置两套入口"。
     * 高亮的是 Editor.currentStationMode()（即 Transit.stationMode）。
     */
    renderStationModeChooser(box, opts = {}) {
      if (!box) return null;
      const cur = Editor.currentStationMode();
      const wrap = util.el('div', 'opt-field');
      wrap.dataset.stationModeChooser = '1';
      if (opts.title !== null) wrap.appendChild(util.el('div', 'opt-head', opts.title || '设站模式'));
      const chips = util.el('div', 'opt-chips');
      for (const m of STATION_MODES) {
        chips.appendChild(Editor._panelChip(`${m.ico} ${m.name}`, () => Editor.setStationMode(m.id), {
          active: m.id === cur,
          title: `${m.tip}（服务端 kind=${m.id}）`,
          dataAttr: 'stationMode',
          dataValue: m.id,
        }));
      }
      wrap.appendChild(chips);
      const info = Editor.stationModeInfo(cur);
      // 面板上只留「当前：🚉 铁路」这一小节；"贴哪张路网放、服务端怎么吸附"那一整句收进「?」
      const now = util.el('div', 'opt-current');
      now.appendChild(util.el('span', null, `当前：${info.ico} ${info.name}`));
      const UI = window.G.UI;
      if (UI && typeof UI.helpButton === 'function') now.appendChild(UI.helpButton(info.snapText, { label: '设站说明' }));
      wrap.appendChild(now);
      box.appendChild(wrap);
      return wrap;
    },

    /**
     * 「🚉 设站」工具的"画之前"设置（设站模式 + 站名）**只在创作面板（#inspector-create）里出现一次**：
     * 见 inspector.js 的 showToolConfig —— 那里用的是同一个 Transit.stationMode / Transit.stationName，
     * 交通面板里也是这一格。这里不再重复一份（同一个设置两套入口就是用户说的重复面板）。
     */

    /** 移动工具：拖动改位置（说明收在「?」里，面板上只留按钮） */
    renderMoveOptions() {
      if (Editor.tool !== 'move') return;
      const box = util.$('#tool-options');
      if (!box || box.querySelector('[data-move-options]')) return;
      const wrap = Editor._panelSection(null, 'moveOptions');
      box.appendChild(Editor._helpRow('拖动改位置', '按住左键把建筑/区域、道路或 POI/车站拖到新位置，松开即提交（一步撤销）。<br>'
        + '建筑/道路：整条平移；车站：只拖自己，松开时由服务端吸附到最近的路网。<br>'
        + `只有附近 ${STATION_FAR_WARN_M} 米内连一条路/轨道都没有时才提醒一句，不拦着你放。`));
      wrap.appendChild(util.el('div', 'opt-current', '按住左键拖动要移动的元素即可。'));
      box.appendChild(wrap);
    },

    /**
     * 节点工具：节点的增删改都住这里。
     * 「＋ 加点 / － 删点」以前挂在「📏 画线」面板里，但那是节点操作，
     * 而「节点」工具本来就有 Alt 点击删点、点击中点插点 —— 一个操作两个入口，现在只留这里。
     */
    renderNodeOptions() {
      if (Editor.tool !== 'nodes') return;
      const box = util.$('#tool-options');
      if (!box || box.querySelector('[data-node-options]')) return;
      box.appendChild(Editor._helpRow('节点编辑', '拖动节点改形状（Shift 拖动整体平移）；点线段中点插点；Alt+点击节点删点，也可以开下面的模式。<br>'
        + '路口节点或被关系引用的节点会拒绝删除；要对齐两条路请用「✥ 移动」或「画线」里的「与相邻道路合并」。'));
      const wrap = Editor._panelSection(null, 'nodeOptions');
      const sel = Editor.selection && Editor.selection.type === 'way' ? World.getWay(Editor.selection.id) : null;
      wrap.appendChild(util.el('div', 'opt-current', sel
        ? `当前道路 #${sel.id} · ${sel.nodes.length} 个节点 · ${World.isClosed(sel) ? '闭合' : '开放'}`
        : '先用「选择」工具点一下道路，节点手柄才会显示出来。'));

      const row = util.el('div', 'opt-chips');
      row.appendChild(Editor._panelChip('＋ 加点', () => Editor.toggleDrawMode('addnode'), {
        title: '开启后点击道路上的任意位置即可插入节点（也可以直接点线段中点）',
        active: Editor.drawMode === 'addnode',
      }));
      row.appendChild(Editor._panelChip('－ 删点', () => Editor.toggleDrawMode('delnode'), {
        title: '开启后点击道路上的节点即可删除；被两条以上道路共用（路口）或被关系引用的节点会拒绝删除',
        active: Editor.drawMode === 'delnode',
      }));
      if (Editor.drawMode) row.appendChild(Editor._panelChip('✕ 结束', () => Editor.toggleDrawMode(Editor.drawMode), { title: '回到普通节点编辑' }));
      wrap.appendChild(row);

      const modeText = Editor.drawMode === 'addnode' ? '加点：点击道路上的位置即插入节点'
        : Editor.drawMode === 'delnode' ? '删点：点击道路上的节点即删除（路口/关系节点会被拒绝）'
          : null;
      if (modeText) wrap.appendChild(util.el('div', 'opt-current', `当前：${modeText}`));
      box.appendChild(wrap);
    },

    /** 取当前要处理的道路：优先框选结果，没有框选时用单个选中的道路 */
    _selectedWays() {
      const out = [];
      const seen = new Set();
      for (const it of Editor.multiSelect) {
        if (it.type !== 'way' || seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it.id);
      }
      if (!out.length && Editor.selection && Editor.selection.type === 'way') out.push(Editor.selection.id);
      return out;
    },

    /** 道路等级 → 默认限速（查不到返回 null）：检查器「限速」行和批量补限速都读这一张表 */
    maxspeedDefaultFor(highway) {
      const speed = highway ? MAXSPEED_BY_CLASS[String(highway)] : null;
      return speed || null;
    },

    /**
     * 限速操作的**唯一实现**：检查器的「限速」行（逐条道路）和框选面板的批量入口都走这里。
     *   spec = { kind: 'class' }                 按 highway 等级填默认值（overwrite=false 时只补空值）
     *        | { kind: 'value', value: '50' }    写死一个值（覆盖已有值）
     *        | { kind: 'clear' }                 删除 maxspeed
     * 纯计算，不发送请求：返回 { ops, skipped, cleared }，由调用方决定怎么提交与提示。
     */
    buildMaxspeedOps(ids, spec = {}) {
      const kind = spec.kind || 'class';
      const overwrite = !!spec.overwrite;
      const ops = [];
      let skipped = 0;
      for (const id of ids || []) {
        const way = World.getWay(id);
        if (!way) continue;
        const tags = way.tags || {};
        const cls = tags.highway;
        const cur = tags.maxspeed;
        let next = null;
        if (kind === 'clear') {
          if (cur === undefined) { skipped += 1; continue; }
          next = Object.assign({}, tags);
          delete next.maxspeed;
        } else {
          const value = kind === 'value' ? String(spec.value == null ? '' : spec.value).trim() : Editor.maxspeedDefaultFor(cls);
          if (!value) { skipped += 1; continue; }                    // 没有等级 / 等级不在限速表里
          if (cur && !overwrite && kind === 'class') { skipped += 1; continue; }   // 已有值且要求"只补空"
          if (String(cur) === value) { skipped += 1; continue; }     // 已经是这个值，不用写
          next = Object.assign({}, tags, { maxspeed: value });
        }
        // 只有明确知道版本的元素才带版本号（否则服务端会判为冲突）
        const v = way.version && way.version > 0 ? way.version : undefined;
        ops.push({ k: 'updateWay', id: way.id, version: v, tags: next });
      }
      return { ops, skipped };
    },

    /**
     * 提交限速改动：一条道路 = 一个 updateWay（一步撤销），一批 = 一次 batch（同样一步撤销）。
     * 检查器的「限速」行和框选面板的「批量：按等级补限速」都调它，行为完全一致。
     */
    setMaxspeed(ids, spec = {}) {
      const list = (ids || []).filter((id) => !!World.getWay(id));
      if (!list.length) { util.toast('请先用「选择」工具点中一条道路，或框选一批道路', 'warn', 4000); return; }
      const { ops, skipped } = Editor.buildMaxspeedOps(list, spec);
      const kind = spec.kind || 'class';
      const value = kind === 'value' ? String(spec.value || '').trim() : '';
      const what = kind === 'clear' ? '清除限速' : kind === 'value' ? `设置限速 ${value} km/h` : '按等级填默认限速';
      if (ops.length > MAXSPEED_BATCH_LIMIT) {
        util.toast(`一次最多改 ${MAXSPEED_BATCH_LIMIT} 条道路（当前 ${ops.length} 条），请放大地图或缩小框选范围后再试`, 'error', 6000);
        return;
      }
      if (!ops.length) {
        if (kind === 'clear') util.toast('这些道路本来就没有 maxspeed 标签', 'info', 3500);
        else if (kind === 'value') util.toast('这些道路的限速已经是这个值了', 'info', 3500);
        else util.toast(spec.overwrite
          ? '选中的道路没有 highway 等级，或等级不在限速表里（可以自己填一个数字）'
          : '选中的道路都已有 maxspeed；要改写请改成具体数值，或勾选批量面板里的「覆盖已有值」', 'warn', 5500);
        return;
      }
      const one = ops.length === 1 ? World.getWay(ops[0].id) : null;
      const label = kind === 'clear' ? `清除 maxspeed（${ops.length} 条）`
        : kind === 'value' ? `设置 maxspeed=${value}（${ops.length} 条）`
          : `按等级补 maxspeed（${ops.length} 条）`;
      util.statusHint(`正在${what}…`);
      Editor._send(ops.length > 1 ? { k: 'batch', ops, label } : ops[0])
        .then(() => {
          util.statusHint(`已${what}${ops.length > 1 ? `：${ops.length} 条道路` : ''}`);
          if (ops.length === 1) {
            const idText = `#${ops[0].id}${one && one.tags && one.tags.name ? `「${one.tags.name}」` : ''}`;
            const written = (ops[0].tags || {}).maxspeed;
            util.toast(kind === 'clear'
              ? `已清除 ${idText} 的 maxspeed（一步撤销）`
              : `已把 ${idText} 的限速写成 maxspeed=${written}（一步撤销）`, 'success', 4500);
          } else {
            util.toast(`已${what}：${ops.length} 条道路${skipped ? `，跳过 ${skipped} 条（已有值/没有等级）` : ''}（Ctrl+Z 一步撤销）`, 'success', 5500);
          }
          Editor._refreshMultiSelection();
        })
        .catch((err) => {
          util.statusHint('');
          util.toast(err.message, 'error', 6000);
        });
    },

    /** 按等级给框选到的道路补 maxspeed（框选面板里的次要入口；逐条道路在检查器的「限速」行里改） */
    fillMissingMaxspeed() {
      return Editor.setMaxspeed(Editor._selectedWays(), { kind: 'class', overwrite: !!Editor.boxMaxspeedOverwrite });
    },

    /** 批量改完之后刷新画面、面板与检查器 */
    _refreshMultiSelection() {
      Editor._renderPreview();
      if (window.G.UI) window.G.UI.renderToolOptions();
      if (Editor.onStatus) Editor.onStatus();
      if (Editor.selection) Editor._refreshSelection();
    },

    /* ------------------------------ 覆盖层状态 ------------------------------ */
    getOverlayState() {
      const sel = Editor.selection;
      let selection = null;
      if (sel) {
        const handles = Render.nodeHandles(sel.type, sel.id);
        // 画线工具的「延伸」和节点工具的「加点/删点」都把手柄画出来，方便看清节点在哪
        const drawTinkering = (Editor.tool === 'line' && !!(Editor.drawMode || Editor.drawOp || Editor._extendAnchor))
          || (Editor.tool === 'nodes' && !!Editor.drawMode);
        selection = {
          type: sel.type, id: sel.id,
          showNodes: Editor.tool === 'nodes' || Editor.tool === 'select' || drawTinkering,
          showMidpoints: Editor.tool === 'nodes',
          handles,
        };
      }
      const preview = Editor._previewState();
      return {
        selection,
        preview,
        boxRect: Editor.boxRect,
        multi: Editor.multiSelect.map((it) => ({ type: it.type, id: it.id })),
        locks: Editor.locks,
        myId: Editor.myId,
        cursors: Editor.players.filter((p) => p.id !== Editor.myId && typeof p.lat === 'number'),
      };
    },

    _previewState() {
      const state = {};
      if (Editor.pending.length) {
        state.points = Editor.pending.slice();
        state.closed = Editor.tool === 'area';
        state.fill = Editor.tool === 'area' ? 'rgba(255,209,102,0.22)' : null;
        state.cursor = Editor.cursorLatLng ? Editor.map.latLngToContainerPoint(Editor.cursorLatLng) : null;
      }
      if (Editor.dragging) {
        const d = Editor.dragging;
        if (d.kind === 'station') {
          const st = Editor._stationOf(d.stationId);
          if (st) {
            state.points = [{ lat: st.lat, lon: st.lon }];
            state.color = '#4fc3f7';
          }
          const snap = d.snap;
          if (snap && Editor.cursorLatLng) {
            const label = snap.kind === 'bus' ? '道路' : '轨道';
            const far = snap.dist > STATION_FAR_WARN_M;
            state.tip = {
              at: Editor.cursorLatLng,
              text: `距最近${label} ${Math.round(snap.dist)} 米${far ? ` · 较远（超过 ${STATION_FAR_WARN_M} 米会提醒，但不会拦下）` : ' · 服务端会就近吸附'}`,
            };
          }
        } else {
          const way = World.getWay(d.wayId);
          if (way) {
            state.points = World.wayCoords(way).map((c) => ({ lat: c[0], lon: c[1] }));
            state.closed = World.isClosed(way);
            state.color = '#4fc3f7';
            state.fill = World.isClosed(way) ? 'rgba(79,195,247,0.18)' : null;
          }
        }
      }
      if (Editor.pending.length && Editor.cursorLatLng) {
        const pts = Editor.pending;
        if (Editor.tool === 'line') {
          const len = util.lineLengthM(pts.concat([{ lat: Editor.cursorLatLng.lat, lon: Editor.cursorLatLng.lng }]));
          state.tip = { at: Editor.cursorLatLng, text: `长度 ${util.fmtLength(len)} · ${pts.length + 1} 个点` };
        } else if (Editor.tool === 'area') {
          const all = pts.concat([{ lat: Editor.cursorLatLng.lat, lon: Editor.cursorLatLng.lng }]);
          const area = all.length >= 3 ? util.ringAreaM2(all) : 0;
          state.tip = { at: Editor.cursorLatLng, text: `面积 ${util.fmtArea(area)} · ${pts.length + 1} 个点` };
        }
      }
      // 延伸道路（画线工具里的「延伸起点/终点」）：端点 + 落点 + 跟随光标的虚线
      if (Editor._extendAnchor) {
        const anchorNode = World.getNode(Editor._extendAnchor.nodeId);
        const pts = [];
        if (anchorNode) pts.push({ lat: anchorNode.lat, lon: anchorNode.lon });
        for (const p of Editor.pending) pts.push({ lat: p.lat, lon: p.lon });
        if (pts.length >= 2) {
          state.points = pts;
          state.color = '#4fc3f7';
        }
        if (pts.length && Editor.cursorLatLng) {
          const cursor = { lat: Editor.cursorLatLng.lat, lon: Editor.cursorLatLng.lng };
          state.points = pts.concat([cursor]);
          const len = util.lineLengthM(pts.concat([cursor]));
          state.tip = { at: Editor.cursorLatLng, text: `延伸 ${util.fmtLength(len)} · ${Editor.pending.length} 个新节点` };
        }
      }
      return Object.keys(state).length ? state : null;
    },

    _renderPreview() {
      if (Render.overlay) Render.overlay.redraw();
    },

    /* ------------------------------ 鼠标事件 ------------------------------ */
    _onClick(ev) {
      if (ev.originalEvent && ev.originalEvent._handledByEditor) return;
      // 刚拖完的一小段时间内，浏览器仍会补一个 click：别把它当点选
      if (Editor._suppressClickUntil && Date.now() < Editor._suppressClickUntil) {
        Editor._suppressClickUntil = 0;
        return;
      }
      const latlng = ev.latlng;
      const oe = ev.originalEvent || {};
      const alt = !!oe.altKey;
      const shift = !!oe.shiftKey;

      // 给线路加站模式：点车站即加入，优先于其它工具
      if (window.G.Transit && window.G.Transit.addingStopsTo && Editor.tool !== 'pan') {
        const hit = window.G.Transit.hitTest(latlng);
        if (hit && hit.type === 'station') {
          window.G.Transit.appendStop(window.G.Transit.addingStopsTo, hit.id);
          return;
        }
        util.toast('请点击地图上的车站（白色圆点）', 'warn', 2500);
        return;
      }

      switch (Editor.tool) {
        case 'station': {
          if (!window.G.Transit) return;
          // 位置就按点击处交给服务端吸附（不再要求"落在地图物件 60/120 米内"）；
          // 只有附近 200 米内连一条可行驶道路/轨道都没有时才提醒一句，不拦着玩家放
          const mode = Editor.stationModeInfo();
          const near = Editor.nearestNetworkPoint(latlng.lat, latlng.lng, mode.kind);
          const warn = Editor.stationFarWarning(near, mode.kind);
          if (warn) util.toast(warn, 'warn', 8000);
          window.G.Transit.createStationAt(latlng).catch(() => {});
          return;
        }
        default: break;
      }

      switch (Editor.tool) {
        case 'select': {
          if (Editor.dragging) return;
          // 「选择」工具的两个选项：点中即删 / 点一下即复制（以前的独立工具）
          if (Editor.quickAction === 'delete') return Editor.deleteAt(latlng, alt);
          if (Editor.quickAction === 'copy') return Editor.duplicateSelection();
          // 车站/列车优先命中（它们的图标盖在道路上，点起来更顺手）
          if (window.G.Transit) {
            const th = window.G.Transit.hitTest(latlng);
            if (th) { window.G.Transit.selectOnMap(th, latlng); return; }
          }
          const hit = Render.pick(latlng, true);
          if (!hit) { Editor.deselect(); return; }
          Editor.select(hit.type, hit.id);
          return;
        }
        case 'move': {
          if (Editor.dragging) return;
          // 车站/列车优先命中（和「选择」工具一致）
          if (window.G.Transit) {
            const th = window.G.Transit.hitTest(latlng);
            if (th) { window.G.Transit.selectOnMap(th, latlng); return; }
          }
          const hit = Render.pick(latlng, true);
          if (hit) Editor.select(hit.type, hit.id);
          else Editor.deselect();
          return;
        }
        case 'nodes': {
          if (Editor.dragging) return;
          // 「节点」工具里开了「＋ 加点 / － 删点」模式：点击直接插点/删点
          if (Editor.drawMode === 'addnode') { Editor.addNodeAt(latlng); return; }
          if (Editor.drawMode === 'delnode') { Editor.deleteNodeAt(latlng); return; }
          const handle = Editor._hitHandle(latlng);
          if (handle && alt) { Editor.removeNode(handle.nodeId); return; }
          const mid = Editor._hitMidpoint(latlng);
          if (mid) { Editor.insertNode(mid.wayId, mid.index); return; }
          if (!handle) {
            const hit = Render.pick(latlng, true);
            if (hit) Editor.select(hit.type, hit.id);
            else Editor.deselect();
          }
          return;
        }
        case 'point': return Editor.createPoint(latlng);
        case 'area': return Editor._addDrawPoint(latlng);
        case 'line': return Editor.onDrawToolClick(latlng, { alt, shift });
        case 'joinnode': return Editor.joinNodeAt(latlng);
        // 老的 'rect' 工具已删：setTool('rect') 会在 TOOL_ALIASES 里落到 'select'，
        // 这里也就不会再收到 'rect'（这条分支连同工具栏按钮一起删掉了）。
        default: return undefined;
      }
    },

    /**
     * 画线工具里的点击分流：
     *   延伸中 → 落点；Alt / 加点模式 → 插点；Alt / 删点模式 → 删点；分割、合并模式 → 对应操作；
     *   否则就是普通画线。
     */
    onDrawToolClick(latlng, keys = {}) {
      if (Editor._extendAnchor) return Editor._addDrawPoint(latlng);
      const wantsNode = keys.alt || Editor.drawMode;
      if (wantsNode) {
        const nodeHit = Editor._hitWayNode(latlng, 12);
        if (keys.alt && nodeHit) return Editor.deleteNodeAt(latlng);
        if (Editor.drawMode === 'delnode') return Editor.deleteNodeAt(latlng);
        if (nodeHit) {
          util.toast('这里已经有一个节点了；要删它请用「－ 删点」或 Alt+点击', 'info', 3000);
          return;
        }
        return Editor.addNodeAt(latlng);
      }
      if (Editor.drawOp === 'split') return Editor.splitAt(latlng);
      if (Editor.drawOp === 'merge') return Editor.mergeWith(latlng);
      return Editor._addDrawPoint(latlng);
    },

    _onMouseDown(ev) {
      if (Editor.tool === 'boxselect') {
        Editor.boxRect = { start: { lat: ev.latlng.lat, lon: ev.latlng.lng }, end: { lat: ev.latlng.lat, lon: ev.latlng.lng } };
        Editor.map.dragging.disable();
        return;
      }
      if (Editor.tool === 'move') return Editor._startMoveDrag(ev);
      if (Editor.tool !== 'nodes' && Editor.tool !== 'select') return;
      const handle = Editor._hitHandle(ev.latlng);
      if (!handle) return;
      const way = Editor.selection && Editor.selection.type === 'way' ? World.getWay(Editor.selection.id) : null;
      const whole = !!(ev.originalEvent && ev.originalEvent.shiftKey) && way;
      const nodeIds = whole ? way.nodes.slice() : [handle.nodeId];
      const originals = new Map();
      for (const nid of nodeIds) {
        const n = World.getNode(nid);
        if (n) originals.set(nid, { lat: n.lat, lon: n.lon });
      }
      Editor.dragging = {
        kind: whole ? 'way' : 'node',
        nodeIds, originals, wayId: way ? way.id : null,
        start: { lat: ev.latlng.lat, lon: ev.latlng.lng },
        moved: false, whole,
      };
      Editor.map.dragging.disable();
    },

    _onMouseMove(ev) {
      Editor.cursorLatLng = ev.latlng;
      if (Editor.boxRect) {
        Editor.boxRect.end = { lat: ev.latlng.lat, lon: ev.latlng.lng };
        Editor._renderPreview();
        return;
      }
      if (Editor.dragging) {
        const d = Editor.dragging;
        const dLat = ev.latlng.lat - d.start.lat;
        const dLon = ev.latlng.lng - d.start.lon;
        if (Math.abs(dLat) > 1e-9 || Math.abs(dLon) > 1e-9) d.moved = true;
        if (d.kind === 'station') {
          const st = Editor._stationOf(d.stationId);
          if (st) { st.lat = d.orig.lat + dLat; st.lon = d.orig.lon + dLon; }
          // 实时告诉玩家"离最近的路网还有多远"（限流，别每帧扫全网）
          const now = Date.now();
          if (!d.snapAt || now - d.snapAt > 160) {
            d.snapAt = now;
            const st2 = Editor._stationOf(d.stationId);
            if (st2) {
              const near = Editor.nearestNetworkPoint(st2.lat, st2.lon, st2.kind);
              d.snap = near ? { dist: near.dist, kind: near.kind } : null;
              if (near) {
                const label = near.kind === 'bus' ? '道路' : '轨道';
                const far = near.dist > STATION_FAR_WARN_M;
                util.statusHint(`${st2.kind === 'bus' ? '公交站' : '车站'}距最近${label} ${Math.round(near.dist)} 米${far ? `（较远，超过 ${STATION_FAR_WARN_M} 米只提醒不拦下）` : ''}：松开后由服务端吸附到最近的${label}上`);
              } else {
                util.statusHint(`${st2.kind === 'bus' ? '公交站' : '车站'}附近没找到可用的路网：位置仍按你松开的地方放，成不成由服务端定`);
              }
            }
          }
        } else {
          for (const [nid, orig] of d.originals) {
            const n = World.getNode(nid);
            if (n) { n.lat = orig.lat + dLat; n.lon = orig.lon + dLon; }
          }
        }
        Editor._renderPreview();
        return;
      }
      if (Editor.pending.length) Editor._renderPreview();
    },

    _onMouseUp() {
      if (Editor.boxRect) {
        const rect = Editor.boxRect;
        Editor.boxRect = null;
        Editor.map.dragging.enable();
        if (util.metersBetween(rect.start, rect.end) < 8) {
          Editor.multiSelect = [];
          Editor.lastBoxRect = null;
          util.toast('拖出的范围太小了，请拉大一点再松手', 'warn', 2500);
        } else {
          Editor.selectInBox(rect);
        }
        Editor._renderPreview();
        if (window.G.UI) window.G.UI.renderToolOptions();
        return;
      }
      if (!Editor.dragging) return;
      const d = Editor.dragging;
      Editor.dragging = null;
      Editor.map.dragging.enable();
      if (!d.moved) { Editor._renderPreview(); return; }
      Editor._suppressClickUntil = Date.now() + 400;   // 拖完别把这一次 mouseup 又当成点选
      if (d.kind === 'station') { Editor._commitStationDrag(d); return; }
      Editor._commitNodeDrag(d);
    },

    /** 提交"拖动节点/整条道路"：一次 batch = 一步撤销 */
    _commitNodeDrag(d) {
      const ops = [];
      for (const [nid] of d.originals) {
        const n = World.getNode(nid);
        if (!n) continue;
        ops.push({ k: 'updateNode', id: nid, lat: n.lat, lon: n.lon, version: n.version || undefined });
      }
      if (!ops.length) return;
      const way = d.wayId ? World.getWay(d.wayId) : null;
      const building = way ? World.isClosed(way) : false;
      const label = d.kind === 'way' ? (building ? '移动建筑/区域' : '移动道路') : '移动节点';
      const restore = () => {
        for (const [nid, orig] of d.originals) {
          const n = World.getNode(nid);
          if (n) { n.lat = orig.lat; n.lon = orig.lon; }
        }
        if (Render.markDirty) Render.markDirty();
        Editor._renderPreview();
      };
      if (ops.length > DRAG_BATCH_LIMIT) {
        restore();
        util.statusHint('');
        util.toast(`这个要素有 ${ops.length} 个节点，超过一次批量操作的上限（${DRAG_BATCH_LIMIT}），没法整体拖动。`
          + '请放大后用「节点」工具（Shift 拖动）分段平移。', 'error', 8000);
        return;
      }
      util.statusHint(`正在${label}（${ops.length} 个节点）…`);
      Editor._send(ops.length > 1 ? { k: 'batch', ops, label } : ops[0])
        .then(() => {
          util.statusHint(`已${label}：${ops.length} 个节点（Ctrl+Z 一步撤销）`);
          util.toast(`已${label}${building ? '（建筑轮廓已整体平移）' : ''}，${ops.length} 个节点一起动，Ctrl+Z 一步撤销`, 'success', 3500);
          if (Render.markDirty) Render.markDirty();
          Editor._refreshSelection();
        })
        .catch((err) => {
          restore();
          util.statusHint('');
          util.toast(err.message, 'error', 6000);
          // 冲突或失败：拉回服务端真实几何
          if (Editor.selection) MapData.fetchElement(Editor.selection.type, Editor.selection.id)
            .then(() => { if (Render.markDirty) Render.markDirty(); Editor._renderPreview(); })
            .catch(() => { /* ignore */ });
        });
    },

    /* ------------------------------ 拖动车站 ------------------------------ */
    /**
     * 从某个车站上按下左键：开始拖动。
     * 协作编辑口径（与服务端对齐，2026-09 更新）：**谁的车站都能拖**，底图导入的公共车站也一样 ——
     * 服务端的 station.update / 改名 / 删除已经不看 owner、也不再看"是不是导入站"，
     * 所以导入站与自建站在这里走**完全同一条路径**。`Transit.isPublicStation()` 现在只当
     * **来源徽标**（列表 / 气泡上标"底图导入"）用，不再是权限判据 —— 这里不再读它。
     * 唯一还拦的是"别人正在编辑这个元素"（元素锁），那条语义没变。
     */
    _startMoveDrag(ev) {
      const latlng = ev.latlng;
      const Transit = window.G.Transit;
      if (Transit) {
        const hit = Transit.hitTest(latlng);
        if (hit && hit.type === 'station') {
          const st = Editor._stationOf(hit.id);
          if (!st) return;
          // 别人正在改这个车站（元素锁）时也先别拖：服务端一样会拒，拖完再弹回去更难看
          const lockBy = (typeof Transit.elemLockBy === 'function') ? Transit.elemLockBy('station', st.id) : null;
          if (lockBy) {
            util.toast(`${lockBy} 正在编辑这个元素，请稍后再试`, 'warn', 4500);
            return;
          }
          Editor.dragging = {
            kind: 'station', stationId: st.id,
            orig: { lat: st.lat, lon: st.lon },
            start: { lat: latlng.lat, lon: latlng.lng },
            moved: false, snap: null, snapAt: 0,
          };
          Editor.map.dragging.disable();
          util.statusHint(`正在拖动「${st.name}」（${st.kind === 'bus' ? '公交站' : '车站'}）：松开后会自动吸附到最近的路网`);
          return;
        }
        if (hit && hit.type === 'train') return;   // 列车在跑，不能拖
      }
      // 建筑/道路/POI：整条要素一起平移
      const pick = Render.pick(latlng, false);
      if (!pick) return;
      const el = World.get(pick.type, pick.id);
      if (!el) return;
      if (pick.type === 'node') {
        Editor.select('node', pick.id);
        Editor.dragging = {
          kind: 'node', nodeIds: [pick.id],
          originals: new Map([[pick.id, { lat: el.lat, lon: el.lon }]]),
          wayId: null, start: { lat: latlng.lat, lon: latlng.lng }, moved: false, whole: false,
        };
        Editor.map.dragging.disable();
        return;
      }
      if (pick.type !== 'way') return;
      const way = World.getWay(pick.id);
      if (!way || way.nodes.length < 2) return;
      Editor.select('way', pick.id);
      const originals = new Map();
      for (const nid of way.nodes) {
        const n = World.getNode(nid);
        if (n) originals.set(nid, { lat: n.lat, lon: n.lon });
      }
      const shared = Editor.sharedNodesOf(way);
      Editor.dragging = {
        kind: 'way', wayId: way.id, nodeIds: way.nodes.slice(), originals,
        start: { lat: latlng.lat, lon: latlng.lng }, moved: false, whole: true,
      };
      Editor.map.dragging.disable();
      const kindName = World.isClosed(way) ? '建筑/区域' : '道路';
      util.statusHint(shared.size
        ? `正在整体平移${kindName} #${way.id}：其中 ${shared.size} 个节点和别的要素共用，会一起被拖动`
        : `正在整体平移${kindName} #${way.id}（${originals.size} 个节点）：松开提交，一次撤销`);
    },

    /**
     * 松开：把车站放到鼠标松开的位置，**吸附交给服务端**（station.update 用车站自己的 kind 就近吸附）。
     * 客户端不再用 60 米 / 120 米的硬门槛拦下拖动 —— 只有附近 200 米内连一条可行驶道路/轨道都没有时
     * 才提醒一句（stationFarWarning），提醒完照旧提交；服务端要是拒了，再按服务端的话回退。
     */
    _commitStationDrag(d) {
      const Transit = window.G.Transit;
      const st = Editor._stationOf(d.stationId);
      if (!Transit || !st) return;
      const orig = d.orig;
      const isBus = st.kind === 'bus';
      const label = isBus ? '道路' : '轨道';
      const near = Editor.nearestNetworkPoint(st.lat, st.lon, st.kind);
      const restore = () => {
        st.lat = orig.lat;
        st.lon = orig.lon;
        if (Render.overlay) Render.overlay.redraw();
      };
      // 只提醒，不拦下
      const warn = Editor.stationFarWarning(near, st.kind);
      if (warn) {
        util.statusHint('车站离路网较远（已按你放的位置提交）');
        util.toast(warn, 'warn', 8000);
      }
      const moveLat = st.lat;
      const moveLon = st.lon;
      if (Render.overlay) Render.overlay.redraw();
      util.statusHint(`正在移动车站「${st.name}」…`);
      Transit.op({ k: 'station.update', id: st.id, lat: moveLat, lon: moveLon })
        .then((res) => {
          const out = res && res.result && res.result.station;
          if (out && typeof out.lat === 'number') {
            const moved = util.metersBetween({ lat: out.lat, lon: out.lon }, { lat: moveLat, lon: moveLon });
            st.lat = out.lat;
            st.lon = out.lon;
            if (moved > 5) {
              // 服务端没接受坐标（旧版接口只改名字/参数）：如实告诉玩家，别让人以为移动成功了
              util.statusHint('车站移动未被服务器接受');
              util.toast('服务器没有接受这次移动：当前服务端的 station.update 只改名称/参数，不接受坐标。'
                + '位置已按服务器数据还原，可以先用「设站」在旁边重新建一个站。', 'error', 9000);
            } else {
              const distText = near ? `，距最近${label} ${Math.round(near.dist)} 米` : '';
              util.statusHint(`已把「${st.name}」移到新的位置（服务端已就近吸附到${label}${distText}）`);
              util.toast(`已把「${st.name}」移到新位置：服务端吸附到最近${label}${distText}，Ctrl+Z 可撤销这一步`, 'success', 5500);
            }
          }
          if (Render.overlay) Render.overlay.redraw();
          if (Transit.renderPanelSoon) Transit.renderPanelSoon();
        })
        .catch((err) => {
          restore();
          util.statusHint('车站移动失败');
          util.toast(`移动「${st.name}」失败：${err.message}（车站要挨着路网：公交站挨着可行驶道路，火车站挨着轨道；别人正在编辑的车站也会被拒）`, 'error', 9000);
        });
    },

    /**
     * 找最近的**可行驶道路 / 轨道**：只用来告诉玩家"离路网还有多远"，
     * 判不判得下由服务端说了算（客户端不再据此拦下设站）。
     *   公交站：任何 highway=* 都算可行驶，只排除明确不能跑车的等级
     *           （footway / path / steps / cycleway / construction / proposed）——
     *           服务道路、土路、生活街区、各级主干道（玩家说的"黄色的"）都能设站；
     *   轨道站：railway=rail / light_rail / subway / tram / narrow_gauge…
     * 距离按**线段**算（不只是节点）：站放在两个节点之间的路段旁边也该算近。
     */
    nearestNetworkPoint(lat, lon, kind) {
      const wantBus = kind === 'bus';
      const p = { lat, lon };
      const nearEnough = (n) => Math.abs(n.lat - lat) <= 0.05 && Math.abs(n.lon - lon) <= 0.05;   // 粗筛，避免全量算距离
      let best = null;
      for (const way of World.ways.values()) {
        const tags = way.tags || {};
        if (wantBus) {
          if (!Editor.isDrivableHighway(tags.highway)) continue;
          if (tags.area === 'yes') continue;                    // 画成面状的道路区域不是中心线
        } else {
          const r = tags.railway;
          if (!r || !RAIL_RUNNABLE.has(r)) continue;
          if (tags.service === 'yard' || tags.service === 'spur') continue;
        }
        const nodes = [];
        let anyNear = false;
        for (const nid of way.nodes) {
          const n = World.getNode(nid);
          if (!n) continue;
          nodes.push(n);
          if (nearEnough(n)) anyNear = true;
        }
        if (!anyNear) continue;                                 // 整条路都不在附近：跳过（粗筛）
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          const b = i + 1 < nodes.length ? nodes[i + 1] : null;
          if (!nearEnough(a) && !(b && nearEnough(b))) continue;   // 这一段两端都很远：跳过
          const dist = b ? util.distToSegmentMeters(p, a, b) : util.metersBetween(p, a);
          if (best && dist >= best.dist) continue;
          const foot = b ? util.projectOnSegment(p, a, b) : { lat: a.lat, lng: a.lon };
          best = { lat: foot.lat, lon: foot.lng, dist, nodeId: a.id, wayId: way.id, kind: wantBus ? 'bus' : 'rail' };
        }
      }
      return best;
    },

    /** 公交站能放在哪些道路旁边：任何 highway=* 都算，只排除明确不能跑车的等级（与服务端放宽后的口径一致） */
    isDrivableHighway(h) {
      if (!h) return false;
      return !BUS_FORBIDDEN.has(String(h).trim());
    },

    /**
     * 离路网太远的**提醒**（纯提醒，绝不拦下）——设站不再要求"落在道路 60 米内"：
     * 公交站旁边只要有一条可行驶的道路就能放，服务端会把它吸附到最近的路上。
     * 返回中文提示；一切正常时返回 null。
     */
    stationFarWarning(near, kind) {
      const isBus = Editor.stationKindOf(kind) === 'bus';
      const what = isBus ? '可行驶的道路' : '轨道';
      const who = isBus ? '公交站' : '车站';
      if (!near) {
        return `${who}：附近 ${STATION_FAR_WARN_M} 米内没有找到${what}，位置先按你点的地方放。`
          + (isBus ? '服务端可能没法把它吸附到路上（可以先修一小段道路再放）。' : '服务端可能没法把它吸附到轨道上（可以先用「画线」铺一段 railway=rail）。');
      }
      if (near.dist > STATION_FAR_WARN_M) {
        return `${who}距最近${what} ${Math.round(near.dist)} 米（超过 ${STATION_FAR_WARN_M} 米）：位置按你点的地方放，服务端只会吸附到最近的${what}上；建议放到路边再放一次。`;
      }
      return null;
    },

    _stationOf(id) {
      const Transit = window.G.Transit;
      if (!Transit || !Transit.data) return null;
      return (Transit.data.stations || []).find((s) => s.id === Number(id)) || null;
    },

    _onDblClick() {
      if ((Editor.tool === 'line' || Editor.tool === 'area') && Editor.pending.length >= 2) Editor.finishDraw();
    },

    _onContextMenu(ev) {
      if (ev.originalEvent) L.DomEvent.preventDefault(ev.originalEvent);
      if (Editor.pending.length) { Editor.cancel(); util.toast('已取消绘制'); return; }
      if (Editor.selection) { Editor.deselect(); return; }
      if (window.G.Inspector) window.G.Inspector.hide();
    },

    _onKeyDown(ev) {
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (ev.key === 'Escape') ev.target.blur();
        return;
      }
      if (ev.ctrlKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); Editor.undo(); return; }
      if (ev.ctrlKey && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); Editor.redo(); return; }
      if (ev.key === 'Escape') {
        if (window.G.Transit && window.G.Transit.addingStopsTo) {
          window.G.Transit.addingStopsTo = null;
          util.statusHint('');
          util.toast('已结束加站', 'info', 1800);
          return;
        }
        Editor.cancel();
        Editor.deselect();
        return;
      }
      if (ev.key === 'Enter') { if (Editor.pending.length) Editor.finishDraw(); return; }
      if (ev.key === 'Backspace') { if (Editor.pending.length) { Editor.pending.pop(); Editor._renderPreview(); } return; }
      if (ev.key === 'Delete') { if (Editor.selection) Editor.deleteSelection(); return; }
      const idx = Number(ev.key);
      if (idx >= 1 && idx <= TOOLS.length) Editor.setTool(TOOLS[idx - 1].id);
    },

    /* ------------------------------ 手柄命中 ------------------------------ */
    _hitHandle(latlng) {
      if (!Editor.selection) return null;
      const handles = Render.nodeHandles(Editor.selection.type, Editor.selection.id);
      const pt = Editor.map.latLngToContainerPoint(latlng);
      for (const h of handles) {
        const p = Editor.map.latLngToContainerPoint([h.lat, h.lon]);
        if (Math.hypot(p.x - pt.x, p.y - pt.y) <= 8) return { nodeId: h.id, handle: h };
      }
      return null;
    },

    _hitMidpoint(latlng) {
      if (!Editor.selection || Editor.selection.type !== 'way') return null;
      const way = World.getWay(Editor.selection.id);
      if (!way) return null;
      const pt = Editor.map.latLngToContainerPoint(latlng);
      const coords = World.wayCoords(way);
      for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1];
        const b = coords[i];
        const mid = Editor.map.latLngToContainerPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        if (Math.hypot(mid.x - pt.x, mid.y - pt.y) <= 8) return { wayId: way.id, index: i };
      }
      return null;
    },

    /* ------------------------------ 节点增删（「⬦ 节点」工具面板） ------------------------------ */
    /** 开关「加点 / 删点」模式 */
    toggleDrawMode(mode) {
      Editor.drawMode = Editor.drawMode === mode ? null : mode;
      Editor.drawOp = null;
      Editor._extendAnchor = null;
      Editor.pending = [];
      if (Editor.drawMode === 'addnode') {
        util.statusHint('加点模式：点击道路上的任意位置即可插入一个节点（Alt+点击也行）');
        util.toast('加点模式：点一下道路就在那里插入节点', 'info', 3200);
      } else if (Editor.drawMode === 'delnode') {
        util.statusHint('删点模式：点击道路上的节点即可删除（路口 / 被关系引用的节点会拒绝）');
        util.toast('删点模式：点一下道路上的节点即可删除；两条路共用的路口节点会拒绝删除', 'info', 4000);
      } else {
        util.statusHint(Editor.tool === 'nodes' ? '已回到普通节点编辑' : '已回到普通画线');
      }
      if (window.G.UI) window.G.UI.renderToolOptions();
      Editor._renderPreview();
    },

    /** 一次性操作：分割 / 合并 */
    startDrawOp(op) {
      if (Editor.drawOp === op) { Editor.endWayOps(); return; }
      const sel = Editor.selection;
      if (!sel || sel.type !== 'way') {
        util.toast(op === 'split' ? '请先用「选择」工具点一下要分割的道路' : '请先用「选择」工具点一下其中一条道路', 'warn', 4500);
        return;
      }
      Editor.drawOp = op;
      Editor.drawMode = null;
      Editor._extendAnchor = null;
      Editor.pending = [];
      const text = op === 'split'
        ? '分割模式：点击这条道路上的位置，点哪儿就在哪儿分割（点到已有节点就直接分）'
        : '合并模式：点击要接上的另一条道路，系统会自动把两边最近的端点接上';
      util.statusHint(text);
      util.toast(text, 'info', 4200);
      if (window.G.UI) window.G.UI.renderToolOptions();
      Editor._renderPreview();
    },

    /** 结束延伸/分割/合并/加点删点，回到普通画线 */
    endWayOps() {
      Editor.drawMode = null;
      Editor.drawOp = null;
      Editor._extendAnchor = null;
      Editor.pending = [];
      util.statusHint('已回到普通画线');
      if (window.G.UI) window.G.UI.renderToolOptions();
      Editor._renderPreview();
    },

    /** 选中端点：点击道路两端附近（保留老的交互方式） */
    pickExtendAnchor(latlng) {
      const sel = Editor.selection;
      if (!sel || sel.type !== 'way') { util.toast('请先用「选择」工具选中一条道路，再点「延伸」', 'warn', 4000); return; }
      const way = World.getWay(sel.id);
      if (!way || way.nodes.length < 2) return;
      const pt = Editor.map.latLngToContainerPoint(latlng);
      const first = World.getNode(way.nodes[0]);
      const last = World.getNode(way.nodes[way.nodes.length - 1]);
      const distTo = (n) => {
        if (!n) return Infinity;
        const p = Editor.map.latLngToContainerPoint([n.lat, n.lon]);
        return Math.hypot(p.x - pt.x, p.y - pt.y);
      };
      const d1 = distTo(first);
      const d2 = distTo(last);
      if (Math.min(d1, d2) > 24) {
        util.toast('请点击这条道路两端的端点（离端点 24 像素以内）', 'warn', 4000);
        return;
      }
      Editor.extendFrom(d1 <= d2 ? 'start' : 'end');
    },

    /** 延伸起点 / 延伸终点：直接以选中道路的某一端为锚点进入延伸状态 */
    extendFrom(which) {
      const sel = Editor.selection;
      if (!sel || sel.type !== 'way') { util.toast('请先用「选择」工具点一下要延伸的道路', 'warn', 4500); return; }
      const way = World.getWay(sel.id);
      if (!way || way.nodes.length < 2) { util.toast('这条路没有足够的节点，没法延伸', 'warn'); return; }
      const end = which === 'start' ? 'start' : 'end';
      const nodeId = end === 'start' ? way.nodes[0] : way.nodes[way.nodes.length - 1];
      if (!World.getNode(nodeId)) { util.toast('这一端的节点没加载出来，请先放大地图', 'warn', 3500); return; }
      Editor.drawOp = null;
      Editor.drawMode = null;
      Editor.pending = [];
      Editor._extendAnchor = { wayId: way.id, end, nodeId };
      const label = end === 'start' ? '起点' : '终点';
      util.statusHint(`延伸${label}：依次点击落点，双击/Enter 完成，Esc 取消`);
      util.toast(`已锁定${label} #${nodeId}：继续点击延伸，双击或 Enter 完成；新端点离相邻道路 25 米以内会自动接上`, 'info', 5000);
      if (window.G.UI) window.G.UI.renderToolOptions();
      Editor._renderPreview();
    },

    /**
     * 找一条"可以自动接上"的相邻道路：把它和当前道路的端点两两比距离，
     * 只有当**离得最近的那一对**里包含我们刚延伸出来的那个端点时才自动合并
     * （和服务端 mergeWays 挑最近端点的逻辑保持一致，避免接错头）。
     */
    _findAutoJoin(way, newEndNode) {
      const newCoord = newEndNode ? { lat: newEndNode.lat, lon: newEndNode.lon } : null;
      const newId = newEndNode ? newEndNode.id : null;
      if (!newCoord) return null;
      const selfEnds = [];
      for (const nid of [way.nodes[0], way.nodes[way.nodes.length - 1]]) {
        if (nid === newId) continue;
        const n = World.getNode(nid);
        if (n) selfEnds.push({ id: n.id, lat: n.lat, lon: n.lon, isNew: false });
      }
      selfEnds.push({ id: newId, lat: newCoord.lat, lon: newCoord.lon, isNew: true });
      let best = null;
      for (const other of World.ways.values()) {
        if (other.id === way.id || other.nodes.length < 2) continue;
        if (way.nodes.length + other.nodes.length > 2000) continue;
        const lock = Editor.locks['way:' + other.id];
        if (lock && lock.userId !== Editor.myId) continue;   // 别人锁着，合并会被拒
        for (const ae of selfEnds) {
          for (const ref of [other.nodes[0], other.nodes[other.nodes.length - 1]]) {
            const nb = World.getNode(ref);
            if (!nb) continue;   // 视野外的端点不参与，免得接到看不见的地方
            const d = (ae.id === nb.id) ? 0 : util.metersBetween({ lat: ae.lat, lon: ae.lon }, { lat: nb.lat, lon: nb.lon });
            if (!best || d < best.dist) best = { dist: d, wayId: other.id, selfEnd: ae };
          }
        }
      }
      if (!best) return null;
      if (!best.selfEnd.isNew) return null;      // 最近的端点不是新延伸出来的那一头 → 不自动接
      if (best.dist > JOIN_SNAP_M) return null;  // 太远，交给玩家手动合并
      return best;
    },

    finishExtend() {
      const anchor = Editor._extendAnchor;
      if (!anchor) { util.toast('请先在「画线」面板里点「延伸起点」或「延伸终点」', 'warn', 4000); return; }
      if (!Editor.pending.length) { util.toast('还没有延伸的落点', 'warn'); return; }
      const way = World.getWay(anchor.wayId);
      if (!way) { Editor.cancel(); return; }
      const points = [];
      if (anchor.end === 'end') {
        for (const nid of way.nodes) points.push({ id: nid });
        for (const p of Editor.pending) points.push({ lat: p.lat, lon: p.lon });
      } else {
        for (const p of Editor.pending.slice().reverse()) points.push({ lat: p.lat, lon: p.lon });
        for (const nid of way.nodes) points.push({ id: nid });
      }
      const added = Editor.pending.length;
      const tip = anchor.end === 'end' ? Editor.pending[Editor.pending.length - 1] : Editor.pending[0];
      // 新端点坐标：服务端会在这个坐标上新建节点，可以据此先算"能不能自动接上"
      const newEnd = Editor._findAutoJoin(way, { id: -1, lat: tip.lat, lon: tip.lon });
      Editor.pending = [];
      Editor._extendAnchor = null;
      const ops = [{ k: 'updateWay', id: way.id, version: way.version, points, tags: way.tags }];
      if (newEnd) {
        const other = World.getWay(newEnd.wayId);
        ops.push({
          k: 'mergeWays', ids: [way.id, newEnd.wayId], snapMeters: JOIN_SNAP_M,
          version: other && other.version ? other.version : undefined, versionOf: newEnd.wayId,
        });
      }
      const label = newEnd ? `延伸并接上相邻道路 #${newEnd.wayId}` : '延伸道路';
      Editor._send(ops.length > 1 ? { k: 'batch', ops, label } : ops[0])
        .then((ack) => {
          const joined = (ack.ops || []).some((o) => o.k === 'wayDelete');
          if (newEnd && joined) {
            const other = World.getWay(newEnd.wayId) || {};
            const name = other.tags && other.tags.name ? `「${other.tags.name}」` : `#${newEnd.wayId}`;
            util.toast(`已延伸 ${added} 个节点，并自动与相邻道路 ${name} 接上（端点相距 ${Math.round(newEnd.dist)} 米）`, 'success', 6000);
            util.statusHint(`延伸 + 合并已完成（一步撤销）：${Math.round(newEnd.dist)} 米的缺口已接上`);
          } else {
            util.statusHint(`已延伸 ${added} 个节点`);
            util.toast(`已延伸 ${added} 个节点${newEnd ? '（合并未生效：可能是对方被锁住或几何变了）' : ''}`, newEnd ? 'warn' : 'success', 5000);
          }
          Editor._refreshSelection();
          if (window.G.UI) window.G.UI.renderToolOptions();
        })
        .catch((err) => {
          util.statusHint('');
          util.toast(err.message, 'error', 6000);
        });
      Editor._renderPreview();
    },

    /** 当前选中的那条道路（没有就返回 null） */
    selectedWay() {
      const sel = Editor.selection;
      if (!sel || sel.type !== 'way') return null;
      return World.getWay(sel.id);
    },

    /** 一条道路上有哪些节点被别的道路共用（路口） */
    sharedNodesOf(way) {
      const mine = new Set(way.nodes);
      const shared = new Set();
      for (const other of World.ways.values()) {
        if (other.id === way.id || !other.nodes.length) continue;
        for (const nid of other.nodes) if (mine.has(nid)) shared.add(nid);
        if (shared.size >= mine.size) break;
      }
      return shared;
    },

    /** 这个节点是否被关系引用（节点级成员） */
    nodeUsedByRelation(nodeId) {
      const id = Number(nodeId);
      for (const rel of World.relations.values()) {
        for (const m of rel.members) {
          if (m.type === 'node' && Number(m.ref) === id) return rel;
        }
      }
      return null;
    },

    /** 点在道路的哪个节点上（像素容差） */
    _hitWayNode(latlng, tol = 12) {
      const way = Editor.selectedWay();
      const target = way || null;
      const pt = Editor.map.latLngToContainerPoint(latlng);
      const scan = (w) => {
        for (const nid of w.nodes) {
          const n = World.getNode(nid);
          if (!n) continue;
          const p = Editor.map.latLngToContainerPoint([n.lat, n.lon]);
          if (Math.hypot(p.x - pt.x, p.y - pt.y) <= tol) return { wayId: w.id, nodeId: nid };
        }
        return null;
      };
      if (target) {
        const hit = scan(target);
        if (hit) return hit;
      }
      const pick = Render.pick(latlng, false);
      if (pick && pick.type === 'way') {
        const w = World.getWay(pick.id);
        if (w && (!target || w.id !== target.id)) {
          const hit = scan(w);
          if (hit) return hit;
        }
      }
      return null;
    },

    /** 要操作的道路：优先点到的，其次选中且离点击位置不太远的那条 */
    _targetWayFor(latlng, tolPx = 14) {
      const pick = Render.pick(latlng, false);
      if (pick && pick.type === 'way') return World.getWay(pick.id);
      const way = Editor.selectedWay();
      if (!way) return null;
      const pt = Editor.map.latLngToContainerPoint(latlng);
      const coords = World.wayCoords(way);
      for (let i = 1; i < coords.length; i++) {
        const mid = Editor.map.latLngToContainerPoint(coords[i]);
        if (Math.hypot(mid.x - pt.x, mid.y - pt.y) > tolPx * 4) continue;
        const d = util.distToSegmentMeters(latlng, coords[i - 1], coords[i]);
        if (d / (Render.metersPerPixel ? Render.metersPerPixel() : 2) <= tolPx) return way;
      }
      return null;
    },

    /** 加点：在点击处插入一个节点（updateWay，一次操作） */
    addNodeAt(latlng) {
      const way = Editor._targetWayFor(latlng);
      if (!way) { util.toast('请点在这条道路上（或先用「选择」工具选中它）', 'warn', 4000); return; }
      const detail = World.wayCoords(way);
      if (detail.length < 2) { util.toast('这条路还没加载完整，请先放大一点', 'warn'); return; }
      let best = null;
      for (let i = 1; i < detail.length; i++) {
        const d = util.distToSegmentMeters(latlng, detail[i - 1], detail[i]);
        if (!best || d < best.dist) best = { dist: d, index: i };
      }
      if (!best) return;
      const proj = util.projectOnSegment(latlng, detail[best.index - 1], detail[best.index]);
      const projLL = { lat: proj.lat, lon: proj.lng };
      let tooClose = null;
      for (const nid of way.nodes) {
        const n = World.getNode(nid);
        if (!n) continue;
        if (util.metersBetween(projLL, { lat: n.lat, lon: n.lon }) < 0.8) { tooClose = nid; break; }
      }
      if (tooClose) { util.toast(`这里已经有一个节点（#${tooClose}），不用再加了`, 'info', 3000); return; }
      const points = [];
      for (let i = 0; i < way.nodes.length; i++) {
        if (i === best.index) points.push({ lat: proj.lat, lon: proj.lng });
        points.push({ id: way.nodes[i] });
      }
      if (way.nodes.length + 1 > 2000) { util.toast('这条路节点太多了（上限 2000）', 'warn', 4000); return; }
      Editor._send({ k: 'updateWay', id: way.id, version: way.version, points, tags: way.tags })
        .then(() => {
          util.statusHint('已插入节点');
          util.toast(`已在点击处插入节点（第 ${best.index + 1} 个，共 ${way.nodes.length + 1} 个节点）`, 'success', 3200);
          Editor._refreshSelection();
        })
        .catch((err) => util.toast(err.message, 'error', 5000));
    },

    /** 删点：拒绝删除路口（≥2 条道路共用）与被关系引用的节点 */
    deleteNodeAt(latlng) {
      const hit = Editor._hitWayNode(latlng, 14);
      if (!hit) {
        const pick = Render.pick(latlng, false);
        if (pick && pick.type === 'node') return Editor._deleteStandaloneNode(pick.id);
        util.toast('请点在这条道路的某个节点上（白色小方块）', 'warn', 3500);
        return;
      }
      const way = World.getWay(hit.wayId);
      if (!way) return;
      const nodeId = hit.nodeId;
      if (way.nodes.length <= 2) {
        util.toast('道路至少需要保留 2 个节点；要整条删掉请用「删除」工具', 'warn', 4500);
        return;
      }
      const shared = Editor.sharedNodesOf(way);
      if (shared.has(nodeId)) {
        util.toast(`#${nodeId} 是路口：被 ${Editor.waysUsingNode(nodeId).length} 条道路共用，删掉会把路断开。`
          + '想拆路口请先在每条路上分别删点，或用「合点」把两个节点并成一个。', 'error', 8000);
        return;
      }
      const rel = Editor.nodeUsedByRelation(nodeId);
      if (rel) {
        const relName = (rel.tags && (rel.tags.name || rel.tags.type)) || '关系';
        util.toast(`#${nodeId} 被关系 #${rel.id}（${relName}）引用，不能直接删。请先在关系里移除它。`, 'error', 8000);
        return;
      }
      const points = way.nodes.filter((nid) => nid !== nodeId).map((nid) => ({ id: nid }));
      const ops = [{ k: 'updateWay', id: way.id, version: way.version, points, tags: way.tags }];
      const node = World.getNode(nodeId);
      const waysUsing = Editor.waysUsingNode(nodeId);
      if (node && !node.tags && waysUsing.length <= 1) ops.push({ k: 'deleteNode', id: nodeId, version: node.version || undefined });
      Editor._send(ops.length > 1 ? { k: 'batch', ops, label: '删除节点' } : ops[0])
        .then(() => {
          util.statusHint('已删除节点');
          util.toast(`已从道路 #${way.id} 上删除节点 #${nodeId}`, 'success', 3000);
          Editor._refreshSelection();
        })
        .catch((err) => util.toast(err.message, 'error', 5000));
    },

    /** 独立的 POI 节点（不属于任何道路）可以直接删；被引用的走路口/关系检查 */
    _deleteStandaloneNode(nodeId) {
      const waysUsing = Editor.waysUsingNode(nodeId);
      if (waysUsing.length) {
        util.toast(`#${nodeId} 被 ${waysUsing.length} 条道路引用，请用「删除」工具（会询问是否级联删除）`, 'warn', 5000);
        return;
      }
      const rel = Editor.nodeUsedByRelation(nodeId);
      if (rel) { util.toast(`#${nodeId} 被关系 #${rel.id} 引用，不能直接删`, 'error', 6000); return; }
      const node = World.getNode(nodeId);
      Editor._send({ k: 'deleteNode', id: nodeId, version: node ? node.version || undefined : undefined })
        .then(() => {
          if (Editor.selection && Editor.selection.id === nodeId) Editor.deselect();
          util.toast('已删除这个点要素', 'success', 2500);
        })
        .catch((err) => util.toast(err.message, 'error', 5000));
    },

    /** 哪些道路引用了这个节点 */
    waysUsingNode(nodeId) {
      const id = Number(nodeId);
      const out = [];
      for (const way of World.ways.values()) {
        if (way.nodes.includes(id)) out.push(way.id);
      }
      return out;
    },

    /** 当前工具的默认标签（新建要素时自动带上，用户只需补名字等） */
    defaultTagsFor(tool) {
      if (tool === 'station') return {};   // 车站是独立的交通实体，不写 OSM 标签
      const tags = Object.assign({}, Editor.drawTags || {});
      if (Editor.drawName) tags.name = Editor.drawName;
      if (tool === 'area') {
        if (Editor.drawAreaKind === 'building') {
          if (!tags.building) tags.building = 'yes';
          tags['building:levels'] = String(Editor.drawFloors);
        } else if (Editor.drawAreaKind === 'landuse' && !tags.landuse) {
          tags.landuse = 'residential';
        } else if (Editor.drawAreaKind === 'natural' && !tags.natural) {
          tags.natural = 'water';
        } else if (Editor.drawAreaKind === 'leisure' && !tags.leisure) {
          tags.leisure = 'park';
        }
      }
      if (tool === 'line' && !tags.highway && !tags.railway && !tags.waterway) tags.highway = 'residential';
      // 去掉空值
      for (const [k, v] of Object.entries(tags)) {
        if (v == null || String(v).trim() === '') delete tags[k];
      }
      return tags;
    },

    setDrawPreset(item) {
      const tool = Editor.tool === 'station' ? 'line' : Editor.tool;
      Editor.drawTags = Object.assign({}, item.tags);
      Editor.drawTagsByTool[tool] = Editor.drawTags;
      Editor.drawPresetName = item.name;
      if (item.kind === 'area' || item.kind === 'line') {
        if (item.tags.building) Editor.drawAreaKind = 'building';
        else if (item.tags.landuse) Editor.drawAreaKind = 'landuse';
        else if (item.tags.natural) Editor.drawAreaKind = 'natural';
        else if (item.tags.leisure) Editor.drawAreaKind = 'leisure';
      }
      if (item.tags['building:levels']) Editor.drawFloors = Number(item.tags['building:levels']) || Editor.drawFloors;
      if (item.tags.name !== undefined) delete Editor.drawTags.name;
    },

    /* ------------------------------ 新建要素 ------------------------------ */
    createPoint(latlng) {
      const tags = Editor.defaultTagsFor('point');
      const text = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join('，');
      Editor._send({ k: 'createNode', lat: latlng.lat, lon: latlng.lng, tags: Object.keys(tags).length ? tags : null })
        .then((ack) => {
          const op = (ack.ops || []).find((o) => o.k === 'nodeCreate');
          if (op) Editor.select('node', op.node.id);
          if (Object.keys(tags).length) {
            util.toast(`已创建点要素：${text}${tags.name ? '' : '（名字可在右侧填）'}`, 'success', 3500);
          } else {
            util.toast('已创建空白点要素：请在左侧选一个 POI 类型，或在右侧填标签', 'success', 3500);
          }
          if (window.G.UI) window.G.UI.renderToolOptions();
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    _addDrawPoint(latlng) {
      if (Editor.pending.length >= 2) {
        const last = Editor.pending[Editor.pending.length - 1];
        if (util.metersBetween(last, latlng) < 0.6) return;
      }
      Editor.pending.push({ lat: latlng.lat, lon: latlng.lng });
      Editor._renderPreview();
      if (Editor.onStatus) Editor.onStatus();
    },

    finishDraw() {
      if (Editor._extendAnchor) return Editor.finishExtend();
      if (Editor.pending.length < 2) { util.toast('至少需要 2 个点', 'warn'); return; }
      const points = Editor.pending.map((p) => ({ lat: p.lat, lon: p.lon }));
      if (Editor.tool === 'area') {
        const first = points[0];
        const last = points[points.length - 1];
        if (util.metersBetween(first, last) > 0.5) points.push({ lat: first.lat, lon: first.lon });
        if (points.length < 4) { util.toast('区域至少需要 3 个不同的点', 'warn'); return; }
      }
      const tags = Editor.defaultTagsFor(Editor.tool === 'area' ? 'area' : 'line');
      const label = Editor.tool === 'area' ? '绘制区域' : '绘制道路';
      Editor.pending = [];
      Editor._send({ k: 'createWay', points, tags: Object.keys(tags).length ? tags : null })
        .then((ack) => {
          const op = (ack.ops || []).find((o) => o.k === 'wayCreate');
          if (op) {
            Editor.select('way', op.way.id);
            // 名字还没填就直接把光标送进检查器的名字输入框
            if (!tags.name) {
              setTimeout(() => {
                const input = document.querySelector('#insp-tags .tag-row[data-key="name"] .tag-value')
                  || document.querySelector('#insp-tags .tag-row .tag-value');
                if (input) { input.focus(); input.select && input.select(); }
              }, 350);
            }
          }
          const names = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join('，');
          util.toast(`已创建：${names}${tags.name ? '' : '（可直接填名字）'}`, 'success', 3500);
        })
        .catch((err) => util.toast(err.message, 'error', 5000));
      Editor._renderPreview();
    },

    /* ------------------------------ 修改几何 ------------------------------ */
    insertNode(wayId, index) {
      const way = World.getWay(wayId);
      if (!way) return;
      const coords = World.wayCoords(way);
      const a = coords[index - 1];
      const b = coords[index];
      const points = [];
      for (let i = 0; i < way.nodes.length; i++) {
        if (i === index) points.push({ lat: (a[0] + b[0]) / 2, lon: (a[1] + b[1]) / 2 });
        points.push({ id: way.nodes[i] });
      }
      Editor._send({ k: 'updateWay', id: way.id, version: way.version, points, tags: way.tags })
        .then(() => util.toast('已插入节点', 'success', 1500))
        .catch((err) => util.toast(err.message, 'error'));
    },

    removeNode(nodeId) {
      if (!Editor.selection || Editor.selection.type !== 'way') return;
      const way = World.getWay(Editor.selection.id);
      if (!way) return;
      if (way.nodes.length <= 2) { util.toast('道路至少需要保留 2 个节点，要删除请用删除工具删掉整条路', 'warn', 4000); return; }
      const points = way.nodes.filter((nid) => nid !== nodeId).map((nid) => ({ id: nid }));
      const ops = [{ k: 'updateWay', id: way.id, version: way.version, points, tags: way.tags }];
      // 这个节点如果没有任何标签、也不再被别的道路引用，就顺手清理掉
      const node = World.getNode(nodeId);
      let usedElsewhere = false;
      for (const w of World.ways.values()) {
        if (w.id === way.id) continue;
        if (w.nodes.includes(nodeId)) { usedElsewhere = true; break; }
      }
      if (node && !node.tags && !usedElsewhere) ops.push({ k: 'deleteNode', id: nodeId });
      Editor._send(ops.length > 1 ? { k: 'batch', ops, label: '删除节点' } : ops[0])
        .then(() => util.toast('已删除节点', 'success', 1500))
        .catch((err) => util.toast(err.message, 'error'));
    },

    /**
     * 「在此处分割」：点哪儿分哪儿。
     *  - 点在已有节点上 → 直接 splitWay（一步撤销）
     *  - 点在两节点之间 → 先在该处插入一个新节点（updateWay），再 splitWay（两步，会明确提示）
     */
    splitAt(latlng) {
      const way = Editor.selectedWay() || Editor._targetWayFor(latlng);
      if (!way) { util.toast('请先用「选择」工具选中一条道路，再点「在此处分割」', 'warn', 4000); return; }
      const pt = Editor.map.latLngToContainerPoint(latlng);
      let best = null;
      let bestD = 14;
      for (const nid of way.nodes) {
        const n = World.getNode(nid);
        if (!n) continue;
        const p = Editor.map.latLngToContainerPoint([n.lat, n.lon]);
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestD) { bestD = d; best = nid; }
      }
      if (best) {
        const idx = way.nodes.indexOf(best);
        if (idx <= 0 || idx >= way.nodes.length - 1) {
          util.toast('端点上不能分割：请点这条道路中间的位置', 'warn', 4000);
          return;
        }
        Editor.drawOp = null;
        if (window.G.UI) window.G.UI.renderToolOptions();
        Editor._send({ k: 'splitWay', id: way.id, version: way.version, nodeId: best })
          .then((ack) => {
            const created = (ack.ops || []).find((o) => o.k === 'wayCreate');
            util.toast(`已在节点 #${best} 处把道路 #${way.id} 一分为二`, 'success', 4000);
            if (created) Editor.select('way', created.way.id);
            if (window.G.UI) window.G.UI.renderToolOptions();
          })
          .catch((err) => util.toast(err.message, 'error', 5000));
        return;
      }
      // 点在两节点之间：先在该处插一个节点，再分割
      const coords = World.wayCoords(way);
      if (coords.length < 2) { util.toast('这条路没加载完整，请先放大一点', 'warn'); return; }
      let seg = null;
      for (let i = 1; i < coords.length; i++) {
        const d = util.distToSegmentMeters(latlng, coords[i - 1], coords[i]);
        if (!seg || d < seg.dist) seg = { dist: d, index: i };
      }
      if (!seg || seg.index <= 0 || seg.index >= coords.length - 1) {
        util.toast('请点在这条道路中间的位置（两端不能分割）', 'warn', 4000);
        return;
      }
      const proj = util.projectOnSegment(latlng, coords[seg.index - 1], coords[seg.index]);
      const points = [];
      for (let i = 0; i < way.nodes.length; i++) {
        if (i === seg.index) points.push({ lat: proj.lat, lon: proj.lng });
        points.push({ id: way.nodes[i] });
      }
      Editor.drawOp = null;
      if (window.G.UI) window.G.UI.renderToolOptions();
      util.statusHint('正在插入节点并分割…');
      Editor._send({ k: 'updateWay', id: way.id, version: way.version, points, tags: way.tags })
        .then((ack) => {
          const created = (ack.ops || []).find((o) => o.k === 'nodeCreate');
          if (!created) throw new Error('插入节点失败，请刷新后重试');
          return Editor._send({ k: 'splitWay', id: way.id, nodeId: created.node.id })
            .then((ack2) => {
              const part = (ack2.ops || []).find((o) => o.k === 'wayCreate');
              util.statusHint('已在此处分割');
              util.toast('已在点击处插入节点并分割为两条道路（插入 + 分割两步，Ctrl+Z 按两次还原）', 'success', 5500);
              if (part) Editor.select('way', part.way.id);
              if (window.G.UI) window.G.UI.renderToolOptions();
            });
        })
        .catch((err) => {
          util.statusHint('');
          util.toast(err.message, 'error', 6000);
        });
    },

    mergeWith(latlng) {
      const way = Editor.selectedWay() || Editor._targetWayFor(latlng);
      if (!way) { util.toast('请先选中一条道路，再点击与它相连的另一条路', 'warn'); return; }
      const hit = Render.pick(latlng, true);
      if (!hit || hit.type !== 'way') { util.toast('这里没有道路', 'warn'); return; }
      if (hit.id === way.id) { util.toast('请点击另一条道路', 'warn'); return; }
      const other = World.getWay(hit.id);
      Editor.drawOp = null;
      if (window.G.UI) window.G.UI.renderToolOptions();
      Editor._send({ k: 'mergeWays', ids: [way.id, hit.id], version: other ? other.version : undefined, versionOf: hit.id, snapMeters: JOIN_SNAP_M })
        .then((ack) => {
          const m = ack.merged;
          if (m && m.joinedDistance > 0) util.toast(`已合并，并把相距 ${m.joinedDistance} 米的两个端点用一段直线接上了`, 'success', 5000);
          else if (m && m.snapped) util.toast('已合并，最近的两个端点自动并成了一个路口', 'success', 4000);
          else util.toast('已合并为一条道路', 'success', 3500);
          Editor._refreshSelection();
        })
        .catch((err) => util.toast(err.message, 'error', 5000));
    },

    joinNodeAt(latlng) {
      const hit = Render.pick(latlng, true);
      if (!hit || hit.type !== 'way') { util.toast('请点击道路上的节点', 'warn'); return; }
      const way = World.getWay(hit.id);
      const pt = Editor.map.latLngToContainerPoint(latlng);
      let best = null;
      let bestD = 14;
      for (const nid of way.nodes) {
        const n = World.getNode(nid);
        if (!n) continue;
        const p = Editor.map.latLngToContainerPoint([n.lat, n.lon]);
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestD) { bestD = d; best = nid; }
      }
      if (!best) { util.toast('请点击道路的端点节点', 'warn'); return; }
      if (!Editor._joinFrom) {
        Editor._joinFrom = best;
        util.toast('已选中第一个节点，再点击要合并到的节点', 'info', 4000);
        return;
      }
      const from = Editor._joinFrom;
      Editor._joinFrom = null;
      if (from === best) { util.toast('已取消', 'info', 1500); return; }
      Editor._send({ k: 'joinNodes', from, to: best })
        .then(() => util.toast('已合并节点，道路已连通', 'success'))
        .catch((err) => util.toast(err.message, 'error'));
    },

    /* ------------------------------ 其它操作 ------------------------------ */
    deleteAt(latlng, cascade) {
      // 车站也支持用删除工具直接点掉
      if (window.G.Transit) {
        const th = window.G.Transit.hitTest(latlng);
        if (th && th.type === 'station') {
          window.G.Transit.deleteStation(window.G.Transit.stationById(th.id), true);
          return;
        }
      }
      const hit = Render.pick(latlng, true);
      if (!hit) { util.toast('这里没有可删除的元素', 'warn', 1800); return; }
      if (hit.type === 'node') {
        const node = World.getNode(hit.id);
        const inUse = [];
        for (const w of World.ways.values()) if (w.nodes.includes(hit.id)) inUse.push(w.id);
        if (inUse.length && !cascade) {
          if (!window.confirm(`这个节点被 ${inUse.length} 条道路引用。\n确定要连同这些道路一起删除吗？（Alt+点击可直接级联删除）`)) return;
          cascade = true;
        }
        Editor._send({ k: 'deleteNode', id: hit.id, version: node ? node.version : undefined, cascade })
          .then(() => { Editor.deselect(); util.toast('已删除节点' + (cascade ? '及相关道路' : ''), 'success'); })
          .catch((err) => util.toast(err.message, 'error', 5000));
        return;
      }
      const el = World.get(hit.type, hit.id);
      const name = el && el.tags && el.tags.name ? `「${el.tags.name}」` : `#${hit.id}`;
      if (!window.confirm(`确定删除 ${name} 吗？（可用 Ctrl+Z 撤销）`)) return;
      const op = hit.type === 'way'
        ? { k: 'deleteWay', id: hit.id, version: el ? el.version : undefined }
        : { k: 'deleteRelation', id: hit.id, version: el ? el.version : undefined };
      Editor._send(op)
        .then(() => { if (Editor.selection && Editor.selection.id === hit.id) Editor.deselect(); util.toast('已删除', 'success'); })
        .catch((err) => util.toast(err.message, 'error'));
    },

    deleteSelection() {
      const sel = Editor.selection;
      if (!sel) return;
      const el = World.get(sel.type, sel.id);
      const op = sel.type === 'way' ? { k: 'deleteWay', id: sel.id, version: el ? el.version : undefined }
        : sel.type === 'relation' ? { k: 'deleteRelation', id: sel.id, version: el ? el.version : undefined }
          : { k: 'deleteNode', id: sel.id, version: el ? el.version : undefined, cascade: true };
      Editor._send(op)
        .then(() => { Editor.deselect(); util.toast('已删除（Ctrl+Z 可撤销）', 'success'); })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /**
     * 把轮廓整理成矩形：以最长边为主轴，取旋转后的外接矩形。
     * **工具栏的「📐 矩形化」按钮已删除**（用户要求），但这个动作本身保留着：
     * 属性检查器的「操作」里那一枚「📐 矩形化」调的就是它（inspector.js 直接调本函数，
     * 不再经过工具表）。删掉它会让检查器那条入口报错，所以留着。
     */
    orthogonalizeSelection() {
      const sel = Editor.selection;
      if (!sel || sel.type !== 'way') { util.toast('请先选中一个闭合的建筑/地块', 'warn'); return; }
      const way = World.getWay(sel.id);
      if (!way || !World.isClosed(way)) { util.toast('只有闭合的区域可以矩形化', 'warn'); return; }
      const coords = World.wayCoords(way);
      if (coords.length < 4) { util.toast('节点太少，无法矩形化', 'warn'); return; }
      const pts = coords.slice(0, -1);
      // 最长边方向作为主轴
      let bestLen = -1;
      let angle = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const d = util.metersBetween(a, b);
        if (d > bestLen) {
          bestLen = d;
          angle = Math.atan2(b[0] - a[0], (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180));
        }
      }
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);
      const k = Math.cos((pts[0][0] * Math.PI) / 180);
      const X = [];
      const Y = [];
      for (const p of pts) {
        const x = (p[1] * k);
        const y = p[0];
        X.push(x * cos - y * sin);
        Y.push(x * sin + y * cos);
      }
      const minX = Math.min(...X);
      const maxX = Math.max(...X);
      const minY = Math.min(...Y);
      const maxY = Math.max(...Y);
      const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
      const cos2 = Math.cos(angle);
      const sin2 = Math.sin(angle);
      const out = corners.map(([x, y]) => {
        const rx = x * cos2 - y * sin2;
        const ry = x * sin2 + y * cos2;
        return { lat: ry, lon: rx / k };
      });
      out.push({ lat: out[0].lat, lon: out[0].lon });
      Editor._send({ k: 'updateWay', id: way.id, version: way.version, points: out, tags: way.tags })
        .then(() => { util.toast('已矩形化', 'success'); Editor._refreshSelection(); })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /**
     * 复制：**「选择」/「框选」工具的选项**（不再是工具栏里的独立工具）。
     * 有单个选中元素就复制它；否则把框选到的一批整体复制一份（一次 batch = 一步撤销）。
     */
    duplicateSelection() {
      const sel = Editor.selection;
      if (!sel) {
        if (Editor.multiSelect.length) return Editor.duplicateMultiSelection();
        util.toast('请先选中要复制的元素（或用「框选」选一批）', 'warn');
        return;
      }
      const el = World.get(sel.type, sel.id);
      if (!el) return;
      const offsetM = 8;
      const dLat = offsetM / 111320;
      const dLon = dLat / Math.cos((Editor.map.getCenter().lat * Math.PI) / 180);
      if (sel.type === 'node') {
        Editor._send({ k: 'createNode', lat: el.lat + dLat, lon: el.lon + dLon, tags: el.tags })
          .then((ack) => {
            const op = (ack.ops || []).find((o) => o.k === 'nodeCreate');
            if (op) Editor.select('node', op.node.id);
          })
          .catch((err) => util.toast(err.message, 'error'));
        return;
      }
      if (sel.type !== 'way') { util.toast('暂时只支持复制点和道路/区域', 'warn'); return; }
      const points = World.wayCoords(el).map((c) => ({ lat: c[0] + dLat, lon: c[1] + dLon }));
      Editor._send({ k: 'createWay', points, tags: el.tags })
        .then((ack) => {
          const op = (ack.ops || []).find((o) => o.k === 'wayCreate');
          if (op) Editor.select('way', op.way.id);
          util.toast('已复制', 'success');
        })
        .catch((err) => util.toast(err.message, 'error'));
    },

    /**
     * 框选后整体复制：把框到的点与道路/区域各复制一份（偏移约 8 米），
     * 一次 batch = 一步撤销。与单条复制同一套规则，只是对象是一批。
     */
    duplicateMultiSelection() {
      const list = Editor.multiSelect.filter((it) => it.type === 'node' || it.type === 'way');
      if (!list.length) { util.toast('框选结果里没有可复制的点或道路/区域', 'warn'); return; }
      if (list.length > MAXSPEED_BATCH_LIMIT) { util.toast(`一次最多复制 ${MAXSPEED_BATCH_LIMIT} 个元素，请缩小框选范围`, 'warn', 5000); return; }
      const offsetM = 8;
      const dLat = offsetM / 111320;
      const dLon = dLat / Math.cos((Editor.map.getCenter().lat * Math.PI) / 180);
      const ops = [];
      for (const it of list) {
        const el = World.get(it.type, it.id);
        if (!el) continue;
        if (it.type === 'node') {
          ops.push({ k: 'createNode', lat: el.lat + dLat, lon: el.lon + dLon, tags: el.tags });
        } else {
          const points = World.wayCoords(el).map((c) => ({ lat: c[0] + dLat, lon: c[1] + dLon }));
          if (points.length >= 2) ops.push({ k: 'createWay', points, tags: el.tags });
        }
      }
      if (!ops.length) { util.toast('这一批里没有可复制的元素', 'warn'); return; }
      util.statusHint(`正在复制 ${ops.length} 个元素…`);
      Editor._send({ k: 'batch', ops, label: `批量复制 ${ops.length} 个元素` })
        .then(() => {
          util.statusHint(`已复制 ${ops.length} 个元素`);
          util.toast(`已复制 ${ops.length} 个元素（整体偏移约 8 米，Ctrl+Z 一步撤销）`, 'success', 4000);
        })
        .catch((err) => { util.statusHint(''); util.toast(err.message, 'error', 5000); });
    },

    _refreshSelection() {
      const sel = Editor.selection;
      if (!sel) return;
      if (!World.get(sel.type, sel.id)) { Editor.deselect(); util.toast('该元素已被删除', 'warn'); return; }
      if (window.G.Inspector) window.G.Inspector.refresh();
      Editor._renderPreview();
      Editor._updateStatus();
    },

    /* --------------------- 版本冲突自愈（"节点已被 X 修改" 这类错误的唯一出口） --------------------- */
    /**
     * 先说清楚这次修的是什么（真实用户 bug：删某些节点永远失败，报「节点已被 Herman LEE 修改」）：
     *
     * **根因：客户端的节点版本号根本没人喂给它。**
     *   · `World.nodes` 里的节点来自视口载荷，而服务端为了省流量只下发 `[lat, lon]`
     *     （server/osmdb.js 的 `_fetchNodes`；紧凑载荷 `packNodesColumnar` 也只有 ids/lat/lon 三列）
     *     —— **一个版本号都没有** → 本地一律是 `version: 0`；
     *   · 而真实数据集里几乎每个节点在服务端的版本都是 1、2、…、14（实测本机数据集：178 万个节点
     *     version=1，26 万个 version=2，还有 1.1 万个节点的最后编辑者是 "Herman Lee"）。
     * 于是"删除一个从地图上载入的节点"= 客户端发 `version: 0`、服务端拿 `cur.version` 一比 → 判冲突，
     * 报出「节点 #27486601 已被 Herman Lee 修改（版本 14）」。
     * 老代码收到这句只弹一条 toast：**不刷新、不重试**；而重新加载视口也永远不会把版本号补上
     * （载荷里就没有这个字段），所以那个节点**怎么点都删不掉** —— 这就是"一直失败、永远恢复不了"。
     *
     * 现在两条路一起管：
     *   1. **选中时就补版本号**（_learnVersion）：本地 version 为 0（= 我们不知道）时问一次
     *      `/api/element`（几十字节），把真实版本并进 World —— 绝大多数冲突在发生前就没了；
     *   2. **冲突时自愈**（_recoverConflict）：只处理 `CONFLICT`；用 `/api/element` 拉回真正的最新状态
     *      （版本 + 坐标 + 标签 + 最后编辑者）合并进 World，中文说清"被谁改了什么"，
     *      再用最新版本**自动重放一次**原操作（只重放一次）。
     *
     * 边界（刻意保留，别把这里做成"什么都吞"的兜底）：
     *   · `LOCKED`（别人正在编辑）/ `FORBIDDEN`（权限）/ `IN_USE`（被道路引用）/ 限流 / 网络错误
     *     **一律原样抛出** —— 它们各有各的中文提示，在这里"自愈"就等于把真实错误藏起来；
     *   · 只重放一次：重放又冲突时再刷新一次（此时本地缓存必定是最新的，用户再点一次一定成功）
     *     并把话说清楚，绝不留下"同一个动作怎么点都失败"的状态；
     *   · 元素已经被别人删掉（`/api/element` 404）：删除操作按"目的已达成"处理并同步本地，
     *     其他操作给出明确中文提示（不硬撞、不假装成功）。
     */

    /** 元素类型 → 中文名词（冲突提示里说"这个节点/道路/关系"） */
    _elemNoun(type) {
      return type === 'node' ? '节点' : type === 'way' ? '道路' : type === 'relation' ? '关系' : '元素';
    },

    /** 这条错误是不是"版本冲突"（服务端权威判据是 code；消息特征只作老服务端兜底） */
    _isConflict(err) {
      if (!err) return false;
      if (err.code === 'CONFLICT') return true;
      return /已被.{1,40}?(修改|改过)/.test(String(err.message || ''));
    },

    /** 这个操作是不是"删除"（元素已经被别人删掉时，删除算"目的已达成"） */
    _isDeleteOp(op) {
      if (!op) return false;
      if (op.k === 'batch') return (op.ops || []).length > 0 && (op.ops || []).every((s) => Editor._isDeleteOp(s));
      return op.k === 'deleteNode' || op.k === 'deleteWay' || op.k === 'deleteRelation';
    },

    /** 操作的中文动作名（冲突提示里说"重新执行了删除 / 请再点一次删除"） */
    _opActionText(op) {
      if (!op) return '操作';
      switch (op.k) {
        case 'deleteNode': return '删除';
        case 'deleteWay': return '删除道路';
        case 'deleteRelation': return '删除关系';
        case 'updateNode': return op.tags ? '修改标签' : '移动';
        case 'updateWay': return op.points ? '修改道路' : '修改标签';
        case 'splitWay': return '分割道路';
        case 'mergeWays': return '合并道路';
        case 'reverseWay': return '反转道路方向';
        case 'batch': return op.label || '批量编辑';
        default: return '操作';
      }
    },

    /** 操作涉及的元素（{type,id}）：冲突时用它决定"该刷新谁" */
    _opTargets(op) {
      const out = [];
      const push = (type, id) => {
        const n = Number(id);
        if (!Number.isFinite(n) || n <= 0) return;
        if (!out.some((t) => t.type === type && t.id === n)) out.push({ type, id: n });
      };
      if (!op || typeof op.k !== 'string') return out;
      if (op.k === 'batch') {
        for (const sub of op.ops || []) for (const t of Editor._opTargets(sub)) push(t.type, t.id);
        return out;
      }
      if (op.k === 'updateNode' || op.k === 'deleteNode') push('node', op.id);
      else if (op.k === 'updateWay' || op.k === 'deleteWay' || op.k === 'splitWay' || op.k === 'reverseWay') push('way', op.id);
      else if (op.k === 'mergeWays') { for (const id of op.ids || []) push('way', id); }
      else if (op.k === 'updateRelation' || op.k === 'deleteRelation') push('relation', op.id);
      return out;
    },

    /** 本地元素当前的样子（刷新前拍一张，用来讲"到底被改了什么"） */
    _captureElement(type, id) {
      const el = World.get(type, id);
      if (!el) return null;
      const tags = el.tags ? Object.assign({}, el.tags) : null;
      if (type === 'node') return { version: Number(el.version) || 0, lat: el.lat, lon: el.lon, tags };
      if (type === 'way') return { version: Number(el.version) || 0, nodes: (el.nodes || []).slice(), tags };
      return { version: Number(el.version) || 0, members: (el.members || []).map((m) => m.type + ':' + m.ref + ':' + (m.role || '')), tags };
    },

    /** 两个标签集内容是否一样 */
    _sameTags(a, b) {
      const ka = Object.keys(a || {});
      const kb = Object.keys(b || {});
      if (ka.length !== kb.length) return false;
      for (const k of ka) if ((a || {})[k] !== (b || {})[k]) return false;
      return true;
    },

    /** "到底被改了什么"的人话（说不出来就返回空串 —— 绝不编） */
    _changeText(type, before, after) {
      if (!before || !after) return '';
      const bits = [];
      if (type === 'node') {
        const d = util.metersBetween([before.lat, before.lon], [after.lat, after.lon]);
        if (d > 0.05) bits.push(`坐标移动了 ${util.fmtLength(d)}`);
      } else if (type === 'way') {
        const a = before.nodes || [];
        const b = after.nodes || [];
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) bits.push('形状/节点有变化');
      } else {
        const a = (before.members || []).join('|');
        const b = (after.members || []).join('|');
        if (a !== b) bits.push('成员有变化');
      }
      if (!Editor._sameTags(before.tags, after.tags)) bits.push('标签有变化');
      return bits.join('，');
    },

    /**
     * 冲突的"开场白"：被谁改过、版本从多少到多少、改了什么。
     * 本地版本号本来是 0（= 我们不知道，见 _learnVersion）时不说"0 → 14"，
     * 而是老实说"最新版本是 14" —— 那种情况下服务端报的"被某人修改"其实是**很久以前**的事。
     */
    _conflictHead(recs) {
      const parts = [];
      for (const r of recs.slice(0, 2)) {
        const noun = Editor._elemNoun(r.type);
        const who = r.editorName ? `刚被 ${r.editorName} 改过` : '刚被其他编辑者改过';
        const mine = Number(r.before && r.before.version) || 0;
        const fresh = Number(r.fresh) || 0;
        const ver = !fresh ? ''
          : mine > 0 ? `（版本 ${mine} → ${fresh}）` : `（服务端最新版本 ${fresh}）`;
        const change = r.change ? `，${r.change}` : '';
        parts.push(`这个${noun}${who}${ver}${change}`);
      }
      const more = recs.length > 2 ? `（另外 ${recs.length - 2} 个元素也一并刷新了）` : '';
      return parts.join('；') + more;
    },

    /** 自愈过程中抛出的错误：保留 CONFLICT 语义，消息是给人看的中文 */
    _conflictError(message, cause, info) {
      const e = new Error(message);
      e.code = 'CONFLICT';
      e.conflict = info || null;
      e.cause = cause || null;
      return e;
    },

    /**
     * 兜底学习版本号：**本地版本号未知（0）的元素**顺手问一次服务端。
     *
     * 为什么必须有它：视口载荷不带节点版本号（见本节开头的说明），所以"从地图上载入的节点"
     * 在本地永远是 0；而服务端真实版本是 1、2、14…。直接把 0 发过去必然被判冲突。
     * 选中的那一刻补一次 `/api/element`（几十字节），之后这个元素的版本号就是**真的**了 ——
     * 删除/改标签一次成功，不会再弹"已被 xxx 修改"。
     * 每个元素只问一次（`_verAsked`）；问不到也没关系，真冲突时还有 _recoverConflict 兜着。
     * @returns {boolean} 是否真的发出了一次请求（自检/测试可以据此断言）
     */
    _learnVersion(type, id) {
      const el = World.get(type, id);
      if (!el) return false;
      if (Number(el.version) > 0) return false;              // 已经知道版本号：什么都不做
      if (!MapData || typeof MapData.fetchElement !== 'function') return false;
      const key = type + ':' + Number(id);
      if (Editor._verAsked.has(key)) return false;
      Editor._verAsked.add(key);
      MapData.fetchElement(type, Number(id))
        .then(() => {
          if (Editor.selection && Editor.selection.type === type && Number(Editor.selection.id) === Number(id)) Editor._refreshSelection();
        })
        .catch(() => { /* 拉不到就算了：真冲突时走 _recoverConflict */ });
      return true;
    },

    /**
     * 刷新冲突涉及的元素：优先用服务端冲突回执里的 { type, id }（最准），
     * 回执缺失（老服务端）时退回从操作里推断。
     *
     * 批量操作额外多做一件事：把"还没执行的那几段"涉及的元素**也一起刷新**（最多 MAX_CONFLICT_REFRESH 个）。
     * 为什么：一次批量删除里每个节点都可能是那个过期的 0，只刷新服务端点名的第一个的话，
     * 重放到第二个就又会冲突 —— 用户看到的就是"点了没用、还得再点"。小批量一次刷干净，一轮就结束。
     *
     * @returns {Promise<{recs:Array, versions:Map, missing:Set}>}
     */
    async _refreshConflictTargets(op, info) {
      let targets = (info && info.type && info.id)
        ? [{ type: info.type, id: Number(info.id) }]
        : Editor._opTargets(op);
      if (op && op.k === 'batch' && info && Number.isFinite(Number(info.index))) {
        const rest = Editor._opTargets({ k: 'batch', ops: (op.ops || []).slice(Math.max(0, Number(info.index))) });
        for (const t of rest) {
          if (targets.length >= MAX_CONFLICT_REFRESH) break;
          if (!targets.some((x) => x.type === t.type && x.id === t.id)) targets.push(t);
        }
      }
      // 兜底上限：老服务端没有结构化回执时，批量操作这一步会推出"整批的元素"（可能几百个），
      // 那就不是"补几个版本号"而是"打几百个请求"了。截断到上限，超出的次数如实告诉用户。
      if (targets.length > MAX_CONFLICT_REFRESH) targets = targets.slice(0, MAX_CONFLICT_REFRESH);
      const recs = [];
      const versions = new Map();
      const missing = new Set();
      for (const t of targets) {
        const before = Editor._captureElement(t.type, t.id);
        let data = null;
        let fail = null;
        try { data = await MapData.fetchElement(t.type, t.id); } catch (e) { fail = e; }
        const el = data && data.element ? data.element : null;
        const after = Editor._captureElement(t.type, t.id);
        const isNamed = !!(info && info.type === t.type && Number(info.id) === Number(t.id));
        const fresh = el ? Number(el.version) : (isNamed ? Number(info.version) : NaN);
        const key = t.type + ':' + t.id;
        if (Number.isFinite(fresh) && fresh > 0) {
          versions.set(key, fresh);
          // /api/element 拉不到时，也要把服务端回执里的权威版本号写回本地 ——
          // 否则下一次点击还是拿着那个过期版本去撞同一堵墙（这正是老代码"怎么点都失败"的原因）。
          if (!el) World.applyConflictVersion(t.type, t.id, fresh, isNamed ? info.editorName : null);
          missing.delete(key);
        } else {
          missing.add(key);                                   // 服务端已经没有它了（或彻底拉不到）
        }
        recs.push({
          type: t.type, id: t.id, before, after, fresh,
          editorName: (el && el.editorName) || (isNamed && info.editorName) || null,
          change: Editor._changeText(t.type, before, after),
          gone: missing.has(key),
          error: fail ? String(fail.message || fail) : null,
        });
      }
      return { recs, versions, missing };
    },

    /**
     * 用最新版本号重建要重放的操作。
     * @returns {{op:object|null, dropped:number}|null} `dropped` = 有几步没能刷新/已经不存在、
     *   因此没有放进这次重放（调用方要如实告诉用户"还有几项需要再点一次"，不能悄悄吞掉）。
     *
     * · `batch`：服务端在冲突回执里给了**出错的下标**（info.index）→ 只重放还没执行的那几段。
     *   批量操作不是事务（server/osmops.js 的 _batch 逐条 apply，出错时前面的已经真的生效了），
     *   整批重发会把已经做过的事再做一遍；而下标之前那些"删除已经被别人删掉"的子操作直接丢掉
     *   （目的已达成，再发一次只会换来一句"节点不存在"）。
     * · `mergeWays`：版本号是成对的（version + versionOf），必须按 versionOf 指的那条取。
     * · 单目标操作拿不到新版本 → 返回 null（不猜、也不拿旧版本再撞一次）。
     */
    _rebaseOp(op, versions, info, missing) {
      if (!op) return null;
      const miss = missing || new Set();
      if (op.k === 'batch') {
        const from = (info && Number.isFinite(Number(info.index))) ? Math.max(0, Number(info.index)) : 0;
        const rest = [];
        let dropped = 0;
        for (const sub of (op.ops || []).slice(from)) {
          const targets = Editor._opTargets(sub);
          if (targets.length && targets.every((t) => miss.has(t.type + ':' + t.id))) {
            if (Editor._isDeleteOp(sub)) { dropped += 1; continue; }   // 已经没了：这一步不用再发
            return null;                                              // 想改的东西没了：不替用户硬撞
          }
          const next = Editor._rebaseOp(sub, versions, null, miss);
          if (!next || !next.op) { dropped += 1; continue; }           // 没刷新到最新版本：留到下一次点击
          rest.push(next.op);
        }
        return { op: rest.length ? Object.assign({}, op, { ops: rest }) : null, dropped };
      }
      if (op.k === 'mergeWays') {
        const vid = Number(op.versionOf);
        const v = versions.get('way:' + vid);
        if (!Number.isFinite(v)) return null;
        return { op: Object.assign({}, op, { versionOf: vid, version: v }), dropped: 0 };
      }
      const targets = Editor._opTargets(op);
      if (!targets.length) return null;
      let v = NaN;
      for (const t of targets) {
        const got = versions.get(t.type + ':' + t.id);
        if (Number.isFinite(got)) { v = got; break; }
      }
      if (!Number.isFinite(v)) return null;
      return { op: Object.assign({}, op, { version: v }), dropped: 0 };
    },

    /** 刷新之后把受影响的画面/面板/状态条更新一遍 */
    _afterConflictRefresh() {
      if (Render && Render.markDirty) Render.markDirty();
      const sel = Editor.selection;
      if (!sel) { Editor._updateStatus(); return; }
      if (!World.get(sel.type, sel.id)) {
        /**
         * 选中的元素在自愈过程中没了（典型情况就是"这次删除成功了"）：
         * 静默收掉选中状态即可 —— 调用点自己会把结果说清楚（"已删除"），
         * 这里再补一句「该元素已被删除」只会让用户看到两条互相重复的提示。
         */
        Editor.deselect();
        return;
      }
      Editor._refreshSelection();
    },

    /**
     * 版本冲突自愈：刷新 → 中文说清 → 用最新版本重放一次。
     * 只处理 `CONFLICT`；别的一律原样抛出（不能把权限/锁/引用错误藏起来）。
     * @returns {Promise<object>} 重放成功的 ack（或"元素已被删除"的等价结果）
     */
    async _recoverConflict(op, err) {
      const info = (err && err.conflict) || null;
      /**
       * 批量操作不是事务：服务端会把它**已经执行成功的那几条**（conflict.appliedOps）告诉我们。
       * 先合并进本地库 —— 否则会出现"服务端已经删了 3 个，屏幕上还画着 3 个"的假状态。
       */
      if (info && Array.isArray(info.appliedOps) && info.appliedOps.length) {
        World.applyOps(info.appliedOps);
        if (Render && Render.markDirty) Render.markDirty();
      }
      const first = await Editor._refreshConflictTargets(op, info);
      if (!first.recs.length) throw err;                       // 不知道该刷新谁：如实报错
      const head = Editor._conflictHead(first.recs);
      const action = Editor._opActionText(op);
      const gotAny = first.recs.some((r) => !first.missing.has(r.type + ':' + r.id));

      // ① 服务端已经没有它了
      if (!gotAny) {
        for (const r of first.recs) {
          World.delete(r.type, r.id);
          World.unpin(r.type, r.id);
          Editor._verAsked.delete(r.type + ':' + r.id);
        }
        Editor._afterConflictRefresh();
        if (Editor._isDeleteOp(op)) {
          util.toast(`${head}，服务端已经没有它了 —— 这次${action}不需要再做`, 'warn', 6000);
          return { ok: true, ops: [], label: '元素已被删除', conflictGone: true };
        }
        throw Editor._conflictError(`${head}，但它已经被删除，没法再${action}（本地已同步为最新状态）`, err, info);
      }

      // ② 用最新版本重放一次（只重放一次）
      const rebased = Editor._rebaseOp(op, first.versions, info, first.missing);
      if (!rebased || !rebased.op) {
        Editor._afterConflictRefresh();
        throw Editor._conflictError(`${head}，已刷新为最新版本，请按地图上的最新数据重做这次${action}`, err, info);
      }
      const retryOp = rebased.op;
      const doneCount = retryOp.k === 'batch' ? (retryOp.ops || []).length : 1;
      const leftText = rebased.dropped
        ? `，先重新执行了其中 ${doneCount} 项，还有 ${rebased.dropped} 项没刷新到最新版本，请再点一次`
        : `，已刷新为最新版本，并重新执行了${action}`;
      try {
        const ack = await Net.op(retryOp);
        util.toast(`${head}${leftText}`, 'warn', 6500);
        Editor._afterConflictRefresh();
        return ack;
      } catch (err2) {
        if (!Editor._isConflict(err2)) throw err2;             // 重放失败是别的原因：如实报
        // ③ 重放又冲突（这中间又被人改了）：再刷新一次，保证"用户再点一次必定成功"
        let again = first;
        try { again = await Editor._refreshConflictTargets(retryOp, err2.conflict || info); }
        catch { /* 刷新失败也要把话说出去：本地至少已经有第一次刷新的结果 */ }
        const head2 = Editor._conflictHead(again.recs.length ? again.recs : first.recs);
        Editor._afterConflictRefresh();
        throw Editor._conflictError(`${head2}，已刷新为最新版本，请再点一次${action}`, err2, err2.conflict || info);
      }
    },

    /* ------------------------------ 发送操作 ------------------------------ */
    /**
     * 所有编辑器操作的唯一出口：带上"版本冲突自愈"（见上面那一节）。
     * 各调用点的 `.catch((err) => util.toast(err.message, ...))` 保持不变 ——
     * 自愈成功时它们照常走成功分支，自愈不了时拿到的是一条**更准确的中文**错误。
     */
    _send(op) {
      Editor.busy = true;
      return Editor.op(op).finally(() => { Editor.busy = false; });
    },

    /** `Net.op` + 版本冲突自愈（别的模块想复用就直接调它，例如检查器的标签保存） */
    async op(op) {
      try {
        return await Net.op(op);
      } catch (err) {
        if (!Editor._isConflict(err)) throw err;               // 权限/锁/引用/限流：原样抛出
        return await Editor._recoverConflict(op, err);
      }
    },

    undo() {
      // 最近一步是交通操作就撤销交通操作，是 OSM 编辑就撤销 OSM 编辑
      const last = Editor.actionLog.pop();
      if (last && last.kind === 'transit' && window.G.Transit) {
        window.G.Transit.op({ k: 'undo' })
          .then((ack) => {
            const label = ack.result && ack.result.undone ? ack.result.undone : '交通操作';
            util.toast(`已撤销：${label}`, 'success', 2000);
            if (window.G.Transit.renderPanelSoon) window.G.Transit.renderPanelSoon();
          })
          .catch((err) => {
            util.toast(err.message, 'warn', 4000);
          });
        return;
      }
      Net.op({ k: 'undo' })
        .then((ack) => {
          util.toast(ack.label || '已撤销', 'success', 1600);
          if (Editor.selection) Editor._refreshSelection();
          if (MapData) MapData.ensure(false);
        })
        .catch((err) => util.toast(err.message, 'warn'));
    },

    redo() {
      const last = Editor.redoLog && Editor.redoLog.pop();
      if (last && last.kind === 'transit' && window.G.Transit) {
        window.G.Transit.op({ k: 'redo' })
          .then((ack) => {
            util.toast(`已重做：${(ack.result && ack.result.redone) || '交通操作'}`, 'success', 2000);
            if (window.G.Transit.renderPanelSoon) window.G.Transit.renderPanelSoon();
          })
          .catch((err) => util.toast(err.message, 'warn'));
        return;
      }
      Net.op({ k: 'redo' })
        .then((ack) => {
          util.toast(ack.label || '已重做', 'success', 1600);
          if (Editor.selection) Editor._refreshSelection();
        })
        .catch((err) => util.toast(err.message, 'warn'));
    },

    /** 把预设标签套用到当前选中元素 */
    applyTags(tags, mode = 'merge') {
      const sel = Editor.selection;
      if (!sel) { util.toast('请先选中一个元素', 'warn'); return; }
      const el = World.get(sel.type, sel.id);
      if (!el) return;
      const next = mode === 'replace' ? Object.assign({}, tags) : Object.assign({}, el.tags || {}, tags);
      const op = sel.type === 'node'
        ? { k: 'updateNode', id: sel.id, version: el.version, tags: next }
        : sel.type === 'way'
          ? { k: 'updateWay', id: sel.id, version: el.version, tags: next }
          : { k: 'updateRelation', id: sel.id, version: el.version, tags: next };
      Editor._send(op)
        .then(() => { util.toast('标签已更新', 'success', 1600); Editor._refreshSelection(); })
        .catch((err) => util.toast(err.message, 'error', 5000));
    },
  };

  window.G.Editor = Editor;
})();
