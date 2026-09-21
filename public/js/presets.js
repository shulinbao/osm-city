'use strict';
/**
 * 新建要素标签预设表（纯数据 + 纯函数，零第三方依赖，传统 script）
 * ============================================================================
 * 用途：编辑器左侧「新建要素」面板。每个预设 = 一条真实 OSM 标签组合，
 *      用户点一下就得到该类型的要素；kind 决定前端是「点一下」还是「画多边形」。
 * 形式：非 ES module，IIFE 挂到 window.G.Presets，与 style.js / util.js 一致。
 *
 * 公开接口（window.G.Presets）
 * ----------------------------------------------------------------------------
 *   categories   [{ id, name, icon, items: [{ id, name, kind, tags, icon, keywords, category }] }]
 *   byId(id)     按条目 id 取条目，取不到返回 null
 *   all()        全部条目（扁平数组，新数组，可安全排序/过滤）
 *   search(kw)   按中文名 / id / 标签键值 / 别名模糊搜索，按相关度排序
 *
 * 条目字段
 * ----------------------------------------------------------------------------
 *   id        全局唯一（分类前缀 + 标签名，如 road-motorway）
 *   name      中文名（面板显示 / 搜索）
 *   kind      'point' | 'line' | 'area'（前端据此选择绘制交互）
 *             有轮廓、能画成面的类型（建筑 / 场馆 / 站房 / 用地）一律 'area'：
 *             「点要素」列表只收 kind==='point' 的条目（editor.js 的 poiTypeGroups），
 *             把建筑写成点会让它出现在点要素列表里，和建筑类表重复。
 *   tags      真实 OSM 标签（点「新建」时请拷贝后再改，例如叠加 building:levels）
 *   icon      emoji 图标
 *   keywords  搜索别名（可选，中英文口语叫法）
 *   category  所属分类 id（初始化时自动写入）
 *
 * 注意：tags 是共享的只读模板；前端写要素时应 Object.assign({}, item.tags, extra)，
 *      不要直接改 item.tags，否则会污染后续新建的要素。
 */
window.G = window.G || {};

(function () {
  /** 把表格行转成条目：[id, 中文名, kind, 标签, emoji, 别名数组?] */
  function buildItems(rows) {
    const items = [];
    for (const row of rows) {
      items.push({
        id: row[0],
        name: row[1],
        kind: row[2],
        tags: row[3],
        icon: row[4],
        keywords: row[5] || [],
      });
    }
    return items;
  }

  /** 分类工厂 */
  function category(id, name, icon, rows) {
    return { id: id, name: name, icon: icon, items: buildItems(rows) };
  }

  const CATEGORIES = [
    // -------------------------------------------------------------------------
    category('road', '道路与交通', '🛣️', [
      ['road-motorway', '高速公路', 'line', { highway: 'motorway', oneway: 'yes' }, '🛣️', ['高速', 'motorway', '高速路']],
      ['road-trunk', '国道', 'line', { highway: 'trunk' }, '🛣️', ['trunk', '快速路']],
      ['road-primary', '省道', 'line', { highway: 'primary' }, '🛣️', ['primary', '主干道']],
      ['road-secondary', '城市主干道', 'line', { highway: 'secondary' }, '🛣️', ['secondary']],
      ['road-tertiary', '次干道', 'line', { highway: 'tertiary' }, '🛣️', ['tertiary', '支路']],
      ['road-residential', '住宅区道路', 'line', { highway: 'residential' }, '🛣️', ['residential', '小区道路']],
      ['road-living-street', '生活街区', 'line', { highway: 'living_street' }, '🚸', ['living_street', '共享街道']],
      ['road-pedestrian', '步行街', 'line', { highway: 'pedestrian' }, '🚶', ['pedestrian', '步行道']],
      ['road-footway', '人行道', 'line', { highway: 'footway' }, '🚶', ['footway', '小路']],
      ['road-cycleway', '自行车道', 'line', { highway: 'cycleway' }, '🚲', ['cycleway', '骑行道']],
      ['road-steps', '台阶', 'line', { highway: 'steps' }, '🪜', ['steps', '楼梯']],
      ['road-service', '服务道路', 'line', { highway: 'service' }, '🛠️', ['service', '内部道路']],
      ['road-track', '田间小路', 'line', { highway: 'track' }, '🌾', ['track', '土路']],
      ['road-rail', '铁路', 'line', { railway: 'rail' }, '🛤️', ['rail', '铁轨', '火车']],
      ['road-subway', '地铁', 'line', { railway: 'subway' }, '🚇', ['subway', 'metro', '地下铁']],
      ['road-light-rail', '轻轨', 'line', { railway: 'light_rail' }, '🚈', ['light_rail', '轻铁']],
      ['road-tram', '有轨电车', 'line', { railway: 'tram' }, '🚊', ['tram', '电车']],
      ['road-funicular', '缆索铁路', 'line', { railway: 'funicular' }, '🚡', ['funicular', '缆车']],
      ['road-narrow-gauge', '窄轨铁路', 'line', { railway: 'narrow_gauge' }, '🛤️', ['narrow_gauge']],
      ['road-monorail', '单轨铁路', 'line', { railway: 'monorail' }, '🚝', ['monorail', '轻轨列车']],
      ['road-disused-rail', '废弃铁路', 'line', { railway: 'disused' }, '🛤️', ['disused', '废线']],
      ['road-platform', '站台', 'area', { railway: 'platform', public_transport: 'platform' }, '🚏', ['platform', '月台']],
      ['road-bus-stop', '公交站', 'point', { highway: 'bus_stop', public_transport: 'platform' }, '🚌', ['bus_stop', '公交车站', '巴士站']],
      // 站房是有轮廓的面（建筑类表里是「车站大楼」），所以这里是 area 不是 point
      ['road-station', '地铁站', 'area', { railway: 'station', station: 'subway', public_transport: 'station' }, '🚉', ['station', '地铁站', '车站']],
      ['road-taxi-stand', '出租车站', 'point', { amenity: 'taxi' }, '🚕', ['taxi', '的士站']],
      ['road-ferry-terminal', '轮渡码头', 'area', { amenity: 'ferry_terminal' }, '⛴️', ['ferry', '轮渡', '码头']],
      ['road-ferry-route', '轮渡航线', 'line', { route: 'ferry' }, '⛴️', ['ferry', '航线']],
      ['road-runway', '机场跑道', 'line', { aeroway: 'runway' }, '🛫', ['runway', '跑道']],
      ['road-taxiway', '滑行道', 'line', { aeroway: 'taxiway' }, '🛬', ['taxiway', '联络道']],
      ['road-helipad', '停机坪', 'area', { aeroway: 'helipad' }, '🚁', ['helipad', '直升机坪']],
      ['road-terminal', '航站楼', 'area', { aeroway: 'terminal', building: 'yes', 'building:levels': '2' }, '🛫', ['terminal', '候机楼']],
      ['road-aerodrome', '机场', 'area', { aeroway: 'aerodrome' }, '🛩️', ['aerodrome', 'airport', '飞行场']],
      ['road-parking', '停车场', 'area', { amenity: 'parking' }, '🅿️', ['parking', '停车']],
      ['road-bicycle-parking', '自行车停车处', 'area', { amenity: 'bicycle_parking' }, '🚲', ['bicycle_parking', '车棚']],
    ]),

    // -------------------------------------------------------------------------
    category('building', '建筑', '🏢', [
      ['building-apartments', '住宅楼', 'area', { building: 'apartments', 'building:levels': '6' }, '🏢', ['apartments', '公寓', '居民楼']],
      ['building-house', '独立住宅', 'area', { building: 'house', 'building:levels': '2' }, '🏠', ['house', '民房', '别墅']],
      ['building-commercial', '商业楼', 'area', { building: 'commercial', 'building:levels': '4' }, '🏬', ['commercial', '商场楼']],
      ['building-office', '写字楼', 'area', { building: 'office', 'building:levels': '8' }, '🏢', ['office', '办公楼']],
      ['building-school', '学校教学楼', 'area', { building: 'school', 'building:levels': '4' }, '🏫', ['school', '教学楼']],
      ['building-hospital', '医院大楼', 'area', { building: 'hospital', 'building:levels': '5' }, '🏥', ['hospital', '住院楼']],
      ['building-industrial', '工业厂房', 'area', { building: 'industrial', 'building:levels': '2' }, '🏭', ['industrial', '厂房']],
      ['building-warehouse', '仓库', 'area', { building: 'warehouse', 'building:levels': '1' }, '📦', ['warehouse', '库房']],
      ['building-garage', '车库', 'area', { building: 'garage', 'building:levels': '1' }, '🚗', ['garage', '停车房']],
      ['building-shed', '棚屋', 'area', { building: 'shed', 'building:levels': '1' }, '🛖', ['shed', '小屋']],
      ['building-religious', '宗教建筑', 'area', { building: 'religious', 'building:levels': '2' }, '⛪', ['religious', '寺庙', '教堂']],
      ['building-toilets', '公共厕所', 'area', { building: 'yes', amenity: 'toilets', 'building:levels': '1' }, '🚻', ['toilets', '厕所', '卫生间']],
      ['building-hut', '岗亭', 'area', { building: 'hut', 'building:levels': '1' }, '🛖', ['hut', '门房']],
      ['building-construction', '在建建筑', 'area', { building: 'construction' }, '🚧', ['construction', '施工中']],
    ]),

    // -------------------------------------------------------------------------
    category('landuse', '用地与自然', '🌳', [
      ['landuse-residential', '住宅区', 'area', { landuse: 'residential' }, '🏘️', ['residential', '居住区']],
      ['landuse-commercial', '商业区', 'area', { landuse: 'commercial' }, '🏙️', ['commercial', '商务区']],
      ['landuse-industrial', '工业区', 'area', { landuse: 'industrial' }, '🏭', ['industrial', '厂区']],
      ['landuse-retail', '零售区', 'area', { landuse: 'retail' }, '🛍️', ['retail', '商圈']],
      ['landuse-construction', '在建用地', 'area', { landuse: 'construction' }, '🚧', ['construction', '工地']],
      ['landuse-farmland', '农田', 'area', { landuse: 'farmland' }, '🌾', ['farmland', '耕地', '田地']],
      ['landuse-orchard', '果园', 'area', { landuse: 'orchard' }, '🍎', ['orchard', '果林']],
      ['landuse-vineyard', '葡萄园', 'area', { landuse: 'vineyard' }, '🍇', ['vineyard', '酒庄']],
      ['landuse-forest', '森林', 'area', { landuse: 'forest' }, '🌲', ['forest', '林地']],
      ['landuse-meadow', '草地', 'area', { landuse: 'meadow' }, '🌿', ['meadow', '草坪']],
      ['landuse-cemetery', '墓地', 'area', { landuse: 'cemetery' }, '⚰️', ['cemetery', '陵园']],
      ['landuse-quarry', '采石场', 'area', { landuse: 'quarry' }, '⛏️', ['quarry', '石场']],
      ['landuse-landfill', '垃圾填埋场', 'area', { landuse: 'landfill' }, '🗑️', ['landfill', '填埋']],
      ['landuse-military', '军事区', 'area', { landuse: 'military' }, '🪖', ['military', '军事用地']],
      ['leisure-park', '公园', 'area', { leisure: 'park' }, '🏞️', ['park', '绿地']],
      ['leisure-garden', '花园', 'area', { leisure: 'garden' }, '🌷', ['garden', '园林']],
      ['leisure-pitch', '运动场', 'area', { leisure: 'pitch', sport: 'soccer' }, '⚽', ['pitch', 'soccer', '足球场', '球场']],
      ['leisure-playground', '操场', 'area', { leisure: 'playground' }, '🛝', ['playground', '游乐场']],
      ['leisure-golf', '高尔夫球场', 'area', { leisure: 'golf_course' }, '⛳', ['golf', '高尔夫']],
      ['leisure-nature-reserve', '自然保护区', 'area', { leisure: 'nature_reserve' }, '🦌', ['nature_reserve', '保护区']],
      ['natural-beach', '沙滩', 'area', { natural: 'beach' }, '🏖️', ['beach', '海滨']],
      ['natural-wetland', '湿地', 'area', { natural: 'wetland' }, '🪷', ['wetland', '沼泽']],
      ['natural-bare-rock', '裸岩', 'area', { natural: 'bare_rock' }, '🪨', ['bare_rock', '岩石']],
      ['natural-scrub', '灌木丛', 'area', { natural: 'scrub' }, '🌿', ['scrub', '灌丛']],
      ['natural-heath', '荒地', 'area', { natural: 'heath' }, '🌾', ['heath', '荒原']],
      ['natural-grassland', '草原', 'area', { natural: 'grassland' }, '🌱', ['grassland', '草场']],
      ['natural-glacier', '冰川', 'area', { natural: 'glacier' }, '🧊', ['glacier', '雪山']],
      ['natural-water', '水体', 'area', { natural: 'water' }, '💧', ['water', '湖', '池塘', '水面']],
      ['waterway-river', '河流', 'line', { waterway: 'river' }, '🏞️', ['river', '河']],
      ['waterway-canal', '运河', 'line', { waterway: 'canal' }, '🚢', ['canal', '渠道']],
      ['waterway-stream', '小溪', 'line', { waterway: 'stream' }, '💦', ['stream', '溪流']],
      ['waterway-ditch', '排水沟', 'line', { waterway: 'ditch' }, '🕳️', ['ditch', '沟渠']],
    ]),

    // -------------------------------------------------------------------------
    // 注意：本分类里「其实是建筑」的条目（餐厅 / 咖啡馆 / 超市 / 银行 / 图书馆 / 酒吧…）kind 一律是
    // 'area'，**不是 'point'** —— 它们都有轮廓，而且建筑类表（editor.js 的 BUILDING_TYPES）
    // 里已经有同一个类型。只有 kind==='point' 的条目才会进「点要素」列表
    // （editor.js 的 poiTypeGroups 只收 kind==='point'），所以这里绝不把建筑写成点。
    // 这些面状条目的同义去重交给 Editor.presetCoveredByClass()：几何(area) + 同一个 key=value
    // 命中建筑类表就不再列出来 —— 模型里同一种类型只有一个定义处。
    category('poi', '设施与 POI', '📍', [
      // 餐饮
      ['poi-restaurant', '餐厅', 'area', { amenity: 'restaurant' }, '🍜', ['restaurant', '饭店', '餐馆']],
      ['poi-cafe', '咖啡馆', 'area', { amenity: 'cafe' }, '☕', ['cafe', '咖啡']],
      ['poi-fast-food', '快餐', 'area', { amenity: 'fast_food' }, '🍔', ['fast_food', '汉堡', '麦当劳']],
      ['poi-bar', '酒吧', 'area', { amenity: 'bar' }, '🍺', ['bar', 'pub', '酒馆']],
      ['poi-ice-cream', '冰淇淋店', 'area', { building: 'yes', amenity: 'ice_cream' }, '🍦', ['ice_cream', '雪糕']],
      ['poi-supermarket', '超市', 'area', { shop: 'supermarket' }, '🛒', ['supermarket', '卖场']],
      ['poi-convenience', '便利店', 'area', { shop: 'convenience' }, '🏪', ['convenience', '小卖部']],
      ['poi-mall', '商场', 'area', { shop: 'mall' }, '🏬', ['mall', '购物中心']],
      ['poi-bakery', '面包店', 'area', { shop: 'bakery' }, '🥖', ['bakery', '烘培']],
      ['poi-hairdresser', '理发店', 'area', { shop: 'hairdresser' }, '💈', ['hairdresser', '理发']],
      // 金融与政务
      ['poi-bank', '银行', 'area', { amenity: 'bank' }, '🏦', ['bank', '储蓄所']],
      ['poi-atm', 'ATM', 'point', { amenity: 'atm' }, '🏧', ['atm', '取款机']],
      ['poi-post-office', '邮局', 'area', { amenity: 'post_office' }, '📮', ['post_office', '邮政']],
      ['poi-government', '政府机构', 'area', { office: 'government' }, '🏛️', ['government', '机关', '政务']],
      ['poi-townhall', '市政厅', 'area', { amenity: 'townhall' }, '🏛️', ['townhall', '市政府']],
      // 医疗
      ['poi-pharmacy', '药店', 'area', { amenity: 'pharmacy' }, '💊', ['pharmacy', '药房']],
      ['poi-hospital', '医院', 'area', { amenity: 'hospital' }, '🏥', ['hospital', '住院']],
      ['poi-clinic', '诊所', 'area', { amenity: 'clinic' }, '🩺', ['clinic', '门诊']],
      ['poi-doctors', '卫生站', 'area', { amenity: 'doctors' }, '🩺', ['doctors', '医生']],
      ['poi-veterinary', '宠物医院', 'area', { building: 'yes', amenity: 'veterinary' }, '🐾', ['veterinary', '兽医']],
      // 教育
      ['poi-school', '学校', 'area', { amenity: 'school' }, '🏫', ['school', '中小学']],
      ['poi-university', '大学', 'area', { amenity: 'university' }, '🎓', ['university', '高校']],
      ['poi-kindergarten', '幼儿园', 'area', { amenity: 'kindergarten' }, '🧸', ['kindergarten', '托儿所']],
      ['poi-library', '图书馆', 'area', { amenity: 'library' }, '📚', ['library', '图书室']],
      // 文化娱乐
      ['poi-museum', '博物馆', 'area', { tourism: 'museum' }, '🏛️', ['museum', '展览馆']],
      ['poi-gallery', '美术馆', 'area', { tourism: 'gallery' }, '🖼️', ['gallery', '画廊']],
      ['poi-cinema', '电影院', 'area', { amenity: 'cinema' }, '🎬', ['cinema', '影城']],
      ['poi-theatre', '剧院', 'area', { amenity: 'theatre' }, '🎭', ['theatre', '戏院']],
      ['poi-sports-centre', '体育馆', 'area', { leisure: 'sports_centre' }, '🏟️', ['sports_centre', '健身馆']],
      ['poi-swimming-pool', '游泳馆', 'area', { leisure: 'swimming_pool' }, '🏊', ['swimming_pool', '游泳池']],
      ['poi-zoo', '动物园', 'area', { tourism: 'zoo' }, '🦁', ['zoo', '动物园']],
      ['poi-theme-park', '主题公园', 'area', { tourism: 'theme_park' }, '🎢', ['theme_park', '游乐园']],
      // 住宿与旅游
      ['poi-hotel', '酒店', 'area', { tourism: 'hotel' }, '🏨', ['hotel', '宾馆']],
      ['poi-guest-house', '客栈', 'area', { tourism: 'guest_house' }, '🛏️', ['guest_house', '民宿']],
      ['poi-camp-site', '露营地', 'area', { tourism: 'camp_site' }, '⛺', ['camp_site', '营地']],
      ['poi-caravan-site', '房车营地', 'area', { tourism: 'caravan_site' }, '🚐', ['caravan_site', '房车']],
      ['poi-viewpoint', '观景台', 'point', { tourism: 'viewpoint' }, '👀', ['viewpoint', '观景点']],
      ['poi-attraction', '景点', 'point', { tourism: 'attraction' }, '🎡', ['attraction', '游乐']],
      // 交通服务
      ['poi-fuel', '加油站', 'point', { amenity: 'fuel' }, '⛽', ['fuel', '油站', '中石化']],
      ['poi-charging-station', '充电站', 'point', { amenity: 'charging_station' }, '🔌', ['charging_station', '充电桩']],
      ['poi-police', '警察局', 'area', { amenity: 'police' }, '🚓', ['police', '派出所']],
      ['poi-fire-station', '消防站', 'area', { amenity: 'fire_station' }, '🚒', ['fire_station', '消防队']],
      ['poi-ambulance-station', '急救站', 'area', { emergency: 'ambulance_station' }, '🚑', ['ambulance', '急救']],
      ['poi-fire-hydrant', '消防栓', 'point', { emergency: 'fire_hydrant' }, '🧯', ['fire_hydrant', '消火栓']],
      // 宗教与市集
      ['poi-place-of-worship', '宗教场所', 'area', { amenity: 'place_of_worship' }, '⛪', ['place_of_worship', '寺庙', '教堂', '清真寺']],
      ['poi-marketplace', '市场', 'area', { amenity: 'marketplace' }, '🛒', ['marketplace', '菜场', '集市']],
      ['poi-castle', '城堡', 'area', { historic: 'castle' }, '🏰', ['castle', '古堡']],
      ['poi-ruins', '遗址', 'area', { historic: 'ruins' }, '🏚️', ['ruins', '废墟']],
      ['poi-monument', '纪念碑', 'point', { historic: 'monument' }, '🗿', ['monument', '雕像']],
      // 生活服务
      ['poi-drinking-water', '饮水点', 'point', { amenity: 'drinking_water' }, '🚰', ['drinking_water', '直饮水']],
      ['poi-toilets', '公共厕所', 'point', { amenity: 'toilets' }, '🚻', ['toilets', '厕所', '洗手间']],
      ['poi-bench', '长椅', 'point', { amenity: 'bench' }, '🪑', ['bench', '座椅']],
      ['poi-waste-basket', '垃圾桶', 'point', { amenity: 'waste_basket' }, '🗑️', ['waste_basket', '果皮箱']],
      ['poi-recycling', '回收站', 'point', { amenity: 'recycling' }, '♻️', ['recycling', '废品回收']],
      ['poi-shelter', '候车亭', 'point', { amenity: 'shelter' }, '⛺', ['shelter', '雨棚']],
    ]),

    // -------------------------------------------------------------------------
    category('infra', '电力与基础设施', '⚡', [
      ['infra-power-line', '输电线', 'line', { power: 'line' }, '🔌', ['power', '高压线', '电线']],
      ['infra-power-pole', '电线杆', 'point', { power: 'pole' }, '🪵', ['pole', '电杆']],
      ['infra-power-tower', '输电塔', 'point', { power: 'tower' }, '🗼', ['tower', '铁塔']],
      ['infra-substation', '变电站', 'area', { power: 'substation' }, '⚡', ['substation', '配电']],
      ['infra-power-plant', '发电厂', 'area', { power: 'plant' }, '🏭', ['plant', '电厂']],
      ['infra-generator', '风力发电机', 'point', { power: 'generator' }, '🌬️', ['generator', '风机']],
      ['infra-pipeline', '管道', 'line', { man_made: 'pipeline' }, '🛢️', ['pipeline', '输油管', '燃气']],
      ['infra-water-tower', '水塔', 'point', { man_made: 'water_tower' }, '🗼', ['water_tower', '水箱']],
      ['infra-mast', '通信塔', 'point', { man_made: 'mast' }, '📡', ['mast', '信号塔', '基站']],
      ['infra-tower', '瞭望塔', 'point', { man_made: 'tower' }, '🗼', ['tower', '塔']],
      ['infra-lighthouse', '灯塔', 'point', { man_made: 'lighthouse' }, '🗼', ['lighthouse', '航标']],
      ['infra-chimney', '烟囱', 'point', { man_made: 'chimney' }, '🏭', ['chimney', '排气筒']],
      ['infra-storage-tank', '储罐', 'area', { man_made: 'storage_tank' }, '🛢️', ['storage_tank', '油罐']],
      ['infra-bridge', '桥梁', 'area', { man_made: 'bridge' }, '🌉', ['bridge', '桥']],
      ['infra-pier', '码头栈桥', 'area', { man_made: 'pier' }, '⚓', ['pier', '栈桥']],
      ['infra-breakwater', '防波堤', 'line', { man_made: 'breakwater' }, '🌊', ['breakwater', '海堤']],
      ['infra-dam', '水坝', 'line', { waterway: 'dam' }, '🚧', ['dam', '大坝']],
      ['infra-wall', '围墙', 'line', { barrier: 'wall' }, '🧱', ['wall', '墙']],
      ['infra-fence', '栅栏', 'line', { barrier: 'fence' }, '🚧', ['fence', '围栏']],
      ['infra-hedge', '树篱', 'line', { barrier: 'hedge' }, '🌳', ['hedge', '绿篱']],
      ['infra-retaining-wall', '挡土墙', 'line', { barrier: 'retaining_wall' }, '🧱', ['retaining_wall', '护坡']],
      ['infra-city-wall', '城墙', 'line', { barrier: 'city_wall' }, '🏯', ['city_wall', '古城墙']],
      ['infra-gate', '大门', 'point', { barrier: 'gate' }, '🚪', ['gate', '门']],
      ['infra-tree', '树', 'point', { natural: 'tree' }, '🌳', ['tree', '树木', '行道树']],
    ]),
  ];

  // 扁平化 + 建立 id 索引（加载期自检 id 唯一性）
  const ALL = [];
  const BY_ID = new Map();
  for (const cat of CATEGORIES) {
    for (const item of cat.items) {
      if (BY_ID.has(item.id)) throw new Error('预设 id 重复：' + item.id);
      item.category = cat.id;
      item.categoryName = cat.name;
      BY_ID.set(item.id, item);
      ALL.push(item);
    }
  }

  /**
   * 相关度打分：越小越相关，-1 表示不匹配
   * 中文名精确 > 前缀 > 包含 > id > 分类名 / 别名 > 标签键值
   */
  function scoreItem(item, kw) {
    const name = item.name.toLowerCase();
    if (name === kw) return 0;
    if (name.indexOf(kw) === 0) return 1;
    if (name.indexOf(kw) >= 0) return 2;
    if (item.id.toLowerCase().indexOf(kw) >= 0) return 3;
    if (item.categoryName && item.categoryName.toLowerCase().indexOf(kw) >= 0) return 4;
    for (const alias of item.keywords) {
      if (String(alias).toLowerCase().indexOf(kw) >= 0) return 4;
    }
    for (const key in item.tags) {
      if (key.toLowerCase().indexOf(kw) >= 0) return 5;
      if (String(item.tags[key]).toLowerCase().indexOf(kw) >= 0) return 5;
    }
    return -1;
  }

  const Presets = {
    categories: CATEGORIES,

    /** 按 id 查预设 */
    byId(id) {
      return BY_ID.get(String(id)) || null;
    },

    /** 全部预设（扁平数组的副本） */
    all() {
      return ALL.slice();
    },

    /** 模糊搜索：中文名 / id / 标签键值 / 别名，按相关度排序 */
    search(keyword) {
      const kw = keyword == null ? '' : String(keyword).trim().toLowerCase();
      if (!kw) return ALL.slice();
      const hits = [];
      for (let i = 0; i < ALL.length; i++) {
        const score = scoreItem(ALL[i], kw);
        if (score >= 0) hits.push({ item: ALL[i], score: score, index: i });
      }
      hits.sort(function (a, b) { return (a.score - b.score) || (a.index - b.index); });
      const out = [];
      for (const hit of hits) out.push(hit.item);
      return out;
    },
  };

  window.G.Presets = Presets;
})();
