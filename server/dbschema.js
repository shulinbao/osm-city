'use strict';
/**
 * OSM 数据表结构（唯一权威定义，导入器与服务端共用）。
 *
 * 存储引擎用 Node 内置的 node:sqlite —— 零第三方依赖，带 R*Tree 空间索引。
 * 坐标轴约定：R*Tree 的 (min_lon, max_lon, min_lat, max_lat) 即 (x 轴 = 经度, y 轴 = 纬度)。
 * 标签统一存成 JSON 字符串，如 {"highway":"residential","name":"长安街"}。
 */
const { DatabaseSync } = require('node:sqlite');

// node:sqlite 目前是实验特性，会在启动时打印 ExperimentalWarning，这里静音以免干扰游戏日志
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS nodes(
  id INTEGER PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  tags TEXT,
  editor TEXT,
  editor_name TEXT,
  ts INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_nodes_ts ON nodes(ts DESC);

CREATE TABLE IF NOT EXISTS ways(
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  tags TEXT,
  editor TEXT,
  editor_name TEXT,
  ts INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  min_lat REAL, max_lat REAL, min_lon REAL, max_lon REAL,
  length REAL,
  -- 低缩放候选索引用的两列（见文件末尾「道路等级 / 最低可见缩放」那一段）：老库由 migrate() 补列 + 回填
  road_class INTEGER,          -- 0 主干 · 1 secondary · 2 tertiary · 3 支路 · 4 细路 · 5 未知等级 · −1 不是道路
  lod_zoom INTEGER             -- 这条 way 最早在哪个缩放可见（= lodVisible 的阈值）
);
CREATE INDEX IF NOT EXISTS idx_ways_ts ON ways(ts DESC);

CREATE TABLE IF NOT EXISTS way_nodes(
  way_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  PRIMARY KEY(way_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_way_nodes_node ON way_nodes(node_id);

CREATE TABLE IF NOT EXISTS relations(
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  tags TEXT,
  editor TEXT,
  editor_name TEXT,
  ts INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  min_lat REAL, max_lat REAL, min_lon REAL, max_lon REAL
);
CREATE INDEX IF NOT EXISTS idx_relations_ts ON relations(ts DESC);

CREATE TABLE IF NOT EXISTS relation_members(
  relation_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  member_type TEXT NOT NULL,
  member_ref INTEGER NOT NULL,
  role TEXT,
  PRIMARY KEY(relation_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_rel_members_ref ON relation_members(member_type, member_ref);

CREATE VIRTUAL TABLE IF NOT EXISTS node_index USING rtree(id, min_lon, max_lon, min_lat, max_lat);
CREATE VIRTUAL TABLE IF NOT EXISTS way_index USING rtree(id, min_lon, max_lon, min_lat, max_lat);
CREATE VIRTUAL TABLE IF NOT EXISTS relation_index USING rtree(id, min_lon, max_lon, min_lat, max_lat);

CREATE TABLE IF NOT EXISTS changesets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  author_name TEXT,
  comment TEXT,
  ts INTEGER NOT NULL,
  op_count INTEGER NOT NULL DEFAULT 0,
  reverted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS changes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changeset_id INTEGER NOT NULL,
  elem_type TEXT NOT NULL,
  elem_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  ts INTEGER NOT NULL,
  author TEXT,
  author_name TEXT,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_changes_ts ON changes(ts DESC);
CREATE INDEX IF NOT EXISTS idx_changes_elem ON changes(elem_type, elem_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_changes_changeset ON changes(changeset_id);

-- ===================== 铁路经营玩法（每人一家公司） =====================

CREATE TABLE IF NOT EXISTS companies(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,                 -- 玩家 id（用户数据存在 users.json 里，这里不加外键）
  name TEXT NOT NULL,
  color TEXT,
  cash REAL NOT NULL DEFAULT 0,
  riders INTEGER NOT NULL DEFAULT 0,
  revenue REAL NOT NULL DEFAULT 0,
  spent REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,   -- 该玩家当前选中的公司
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(owner);

CREATE TABLE IF NOT EXISTS stations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  company_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'rail',      -- hsr 高铁站 / intercity 城际站 / rail 普速 / subway 地铁 / tram 有轨电车 / bus 公交站
  lat REAL NOT NULL, lon REAL NOT NULL,
  node_id INTEGER,                         -- 吸附到的轨道节点（可空）
  way_id INTEGER,                          -- 所在轨道（用于校验连通性）
  platform_m REAL NOT NULL DEFAULT 120,    -- 站台长度：决定能停多长的车
  catchment_m REAL NOT NULL DEFAULT 700,   -- 客流吸引半径
  show_catchment INTEGER NOT NULL DEFAULT 0, -- 是否在地图上显示覆盖范围
  cost REAL NOT NULL DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stations_owner ON stations(owner);

CREATE TABLE IF NOT EXISTS lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  company_id INTEGER,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#e6194b',
  kind TEXT NOT NULL DEFAULT 'rail',
  stops TEXT NOT NULL DEFAULT '[]',        -- JSON: [stationId, ...] 按顺序
  loop INTEGER NOT NULL DEFAULT 0,         -- 环形线路
  path TEXT,                               -- JSON: [nodeId, ...] 沿轨道的实际走行路径
  path_len REAL NOT NULL DEFAULT 0,        -- 米
  path_error TEXT,                         -- 寻路失败原因（哪两站之间不通）
  path_built_at INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lines_owner ON lines(owner);

CREATE TABLE IF NOT EXISTS vehicles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  company_id INTEGER,
  line_id INTEGER,
  name TEXT NOT NULL,
  cars INTEGER NOT NULL DEFAULT 4,
  capacity_per_car INTEGER NOT NULL DEFAULT 60,
  max_speed REAL NOT NULL DEFAULT 80,      -- km/h
  length_m REAL NOT NULL DEFAULT 20,       -- 车辆长度（米）：决定地图上示意大小与前后车净距
  kind TEXT NOT NULL DEFAULT 'rail',       -- 车型：bus / metro4 / train8 ...
  cost REAL NOT NULL DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner ON vehicles(owner);
CREATE INDEX IF NOT EXISTS idx_vehicles_line ON vehicles(line_id);

-- 人口/岗位网格：由真实 OSM 建筑与用地推算而来
CREATE TABLE IF NOT EXISTS population_cells(
  cell_x INTEGER NOT NULL,
  cell_y INTEGER NOT NULL,
  pop REAL NOT NULL DEFAULT 0,
  jobs REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(cell_x, cell_y)
);
-- 每个 OSM way 对网格的贡献，便于增量更新（改了建筑就只重算它覆盖的格子）
CREATE TABLE IF NOT EXISTS population_sources(
  way_id INTEGER PRIMARY KEY,
  cells TEXT NOT NULL,     -- JSON: {"x,y": [pop, jobs], ...}
  ts INTEGER
);

CREATE TABLE IF NOT EXISTS sim_state(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  clock_ms INTEGER NOT NULL DEFAULT 0,     -- 游戏内时间（毫秒）
  speed INTEGER NOT NULL DEFAULT 1,        -- 0=暂停 1/5/20 倍速
  day INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER
);
`;

/** 打开（必要时创建）OSM 数据库并确保表结构存在 */
function openDatabase(file, options = {}) {
  const db = new DatabaseSync(file);
  if (options.wal !== false) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -64000');
  preMigrate(db);
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

/**
 * 建表之前的迁移：老库里的 companies 是"一人一家（id = 玩家 id）"，没有 owner 列，
 * 而新建的索引会引用 owner —— 所以必须在执行 SCHEMA_SQL 之前把它挪开，
 * 否则 CREATE INDEX idx_companies_owner 会直接让服务起不来。
 */
function preMigrate(db) {
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'").get();
    if (!exists) return;
    const cols = db.prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
    if (cols.includes('owner')) return;
    warnOnce('公司表升级为一家公司一行（支持每人多家公司）');
    db.exec('ALTER TABLE companies RENAME TO companies_legacy');
  } catch (err) {
    console.warn('[db] 公司表预迁移失败:', err.message);
  }
}

/** 轻量迁移：给已存在的表补上后来新增的列 */
function migrate(db) {
  const addColumn = (table, column, ddl) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.length || cols.includes(column)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      // 迁移提示走 stderr，避免污染 --quiet 模式下的标准输出
      console.warn(`[db] 迁移：${table} 增加列 ${column}`);
    } catch (err) {
      console.warn(`[db] 迁移 ${table}.${column} 失败:`, err.message);
    }
  };
  /**
   * 低缩放候选索引的两列（见文件末尾「道路等级 / 最低可见缩放」）：
   * 老库在这里补列（`ALTER TABLE ... ADD COLUMN` 是 O(1) 的，不重写 32 万行、**不需重导入**），
   * 新库由 SCHEMA_SQL 直接建好。
   * 注意这里**只补列**：数据回填（backfillWayLod）与部分索引（ensureLodIndexes）由
   * `server/osmdb.js` 的 OsmDB 构造函数紧接着按"先填、后建索引"的顺序做 ——
   * 顺序很要紧：先填后建索引时索引是一次批量构建（实测 159 ms），反过来要 32 万次 UPDATE
   * 各自维护索引（实测 1.4 s → 2.6 s）。导入器只走 openDatabase，因此导入时
   * **一列不填、一个索引不建**，导入速度和以前一样。
   */
  addColumn('ways', 'road_class', 'road_class INTEGER');
  addColumn('ways', 'lod_zoom', 'lod_zoom INTEGER');
  addColumn('vehicles', 'length_m', "length_m REAL NOT NULL DEFAULT 20");
  addColumn('vehicles', 'kind', "kind TEXT NOT NULL DEFAULT 'rail'");
  addColumn('stations', 'sidings', 'sidings INTEGER NOT NULL DEFAULT 0');
  addColumn('stations', 'show_catchment', 'show_catchment INTEGER NOT NULL DEFAULT 0');
  addColumn('stations', 'company_id', 'company_id INTEGER');
  addColumn('lines', 'company_id', 'company_id INTEGER');
  addColumn('vehicles', 'company_id', 'company_id INTEGER');
  migrateCompanies(db);
}

/**
 * 公司从"一人一家（id = user id）"升级成"一人多家（自增 id + owner）"。
 * 老库里的公司行会被搬到新表，并把已有的车站/线路/车辆归到对应公司名下。
 */
/** 迁移提示走 stderr，避免污染 --quiet 模式下的标准输出；同一条提示只打印一次 */
const warned = new Set();
function warnOnce(msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn('[db] 迁移：' + msg);
}

/** 公司表的结构（新库由 SCHEMA_SQL 建，老库迁移时也用这一份） */
const COMPANIES_DDL = `CREATE TABLE companies(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      cash REAL NOT NULL DEFAULT 0,
      riders INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      spent REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER)`;

function migrateCompanies(db) {
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies'").get();
    if (!exists) return;                       // 新库：SCHEMA_SQL 已经建好
    // 早期版本给 owner 加了 REFERENCES users(id)，但用户其实存在 users.json 里，
    // 这个外键指向不存在的表，会让所有写入报 "no such table: main.users" —— 重建去掉它。
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='companies'").get();
    if (ddl && /REFERENCES\s+users/i.test(String(ddl.sql))) {
      const rows = db.prepare('SELECT * FROM companies').all();
      db.exec('DROP TABLE companies');
      db.exec(COMPANIES_DDL);
      db.exec('CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(owner)');
      const back = db.prepare('INSERT OR IGNORE INTO companies(id, owner, name, color, cash, riders, revenue, spent, active, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const r of rows) back.run(r.id, r.owner, r.name, r.color, r.cash, r.riders, r.revenue, r.spent, r.active || 1, r.created_at, r.updated_at);
      warnOnce('公司表去掉指向 users.json 的失效外键');
    }
    const legacyExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companies_legacy'").get();
    const cols = db.prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
    if (!legacyExists && (!cols.length || cols.includes('owner'))) return;   // 已经是新结构
    if (!legacyExists) {
      warnOnce('公司表升级为一家公司一行（支持每人多家公司）');
      db.exec('ALTER TABLE companies RENAME TO companies_legacy');
      db.exec(COMPANIES_DDL);
      db.exec('CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(owner)');
    }
    const legacy = db.prepare('SELECT * FROM companies_legacy').all();
    // 老结构里 id 是玩家 user id（TEXT），新结构是自增整数 —— 所以不能沿用老 id，
    // 让 SQLite 自己编号，再用 owner 把车站/线路/车辆归到对应公司名下。
    const ins = db.prepare('INSERT INTO companies(owner, name, color, cash, riders, revenue, spent, active, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const hasOwner = db.prepare('SELECT id FROM companies WHERE owner = ?');
    for (const row of legacy) {
      if (hasOwner.get(row.id)) continue;
      ins.run(row.id, row.name, row.color, row.cash, row.riders, row.revenue, row.spent, 1, row.created_at, row.updated_at);
    }
    for (const table of ['stations', 'lines', 'vehicles']) {
      db.exec(`UPDATE ${table} SET company_id = (SELECT c.id FROM companies c WHERE c.owner = ${table}.owner) WHERE company_id IS NULL`);
    }
    db.exec('DROP TABLE companies_legacy');
  } catch (err) {
    console.warn('[db] 公司表迁移失败（将按新库继续运行）:', err.message);
  }
}

/* ==================== 道路等级 / 最低可见缩放（低缩放候选索引） ==================== */
/**
 * **为什么要这两列**：低缩放（z10~z12）一个视口几乎覆盖整座城市，而服务端的
 * `lodVisible`（按缩放的显示分级）会把等级不够的道路整条扔掉 —— 改造前候选扫描
 * 走 R*Tree，只能"先把 32 万行全读出来、再逐行判断丢掉"，z10 实测 1.6 秒就花在这上面。
 *
 * 于是把两个**只跟 tags 有关**的派生值物化到 ways 上（一列一个整数）：
 *   road_class   0 主干(motorway/trunk/primary) · 1 secondary · 2 tertiary · 3 支路(residential/unclassified/
 *                living_street/road) · 4 细路(service/track/footway/path/…) · 5 未知等级（表里没写的 highway 值）
 *                **−1 = 不是道路**（铁路/水系/建筑/用地/边界/…）。用 −1 而不是 NULL：这样
 *                `road_class <= ?` 的索引范围扫描天然跳过非道路，不必额外判 NULL。
 *   lod_zoom     这条 way **最早在哪个缩放可见**，也就是 `lodVisible(tags, z, 'line')` 的最小 z：
 *                道路 = 它那一级的地板（rank0=9 · rank1=12 · rank2=13 · rank3=14 · rank4/未知=16）；
 *                例外类各按自己的门槛（干线铁路 10 · 支线 14 · 地铁/轻轨/有轨 13 · 站台 16 · 水系 12 ·
 *                水域 9 · 建筑 15 · 住宅/商业/工业用地 13 · 停车/公园/林地 13 · 其余用地 15 ·
 *                行政边界 6/9/12 · 电力线 14 · 屏障 17 · 其余 16）。
 *
 * 有了 lod_zoom 之后，低缩放候选查询只要 `lod_zoom <= zoom` 就**恰好**是
 * "等级够的道路 + 铁路/水系/水域/行政边界这些例外"，一条不多一条不少 —— 这正是
 * `idx_ways_lod_zoom`（部分索引，只收未删除且有 bbox 的 way）的范围扫描。
 *
 * **幂等**：回填结果连同"规则指纹"写进 meta；启动时先抽 3000 行核对（与空间索引自检同一套做法），
 * 对得上就**一行都不动**，对不上（换过导入器/改过规则/上次被打断）就整表重填一遍。
 * **不重导入**：`ALTER TABLE ADD COLUMN` 是 O(1)，32 万行的回填在一个事务里跑完（实测见 RESULTS-lodidx.md）。
 */
const WAY_LOD_META = 'way_lod_backfill';
/** 规则指纹：lodVisible 的判据改了就把这里改一下 → 老库下次启动自动重填 */
const WAY_LOD_SIGNATURE = 'ways-lod-v1';
const WAY_LOD_INDEX = 'idx_ways_lod_zoom';

/**
 * **低缩放的 POI 侧**：同一个病（z10 一个视口把全城 10.5 万个"带标签节点"读一遍，
 * 其中真正该显示的只有 2150 个地名），同一个治法 —— 用**部分索引**把"低缩放可能可见的节点"
 * 单独收一份，让候选扫描只碰这些行。
 *
 * 判据严格对齐 `osmdb.js` 的 `lodVisible(tags, z, 'point')` 在 z ≤ 15 时的可见集合：
 *   z ≥ 8   ：地名（place）
 *   z ≥ 13  ：山峰 / 泉 / 洞口（natural=peak|spring|cave_entrance）
 *   z ≥ 16  ：amenity/shop/tourism/... 那一大票（本索引**不收**，那一档仍然走 R*Tree）
 * 所以谓词里这两组的键名与 `pointTagsMaybeVisible` 完全一致（键名本身含引号和冒号，
 * 保证 `"building:levels"` 不会被当成 building —— 与可见性判断同一口径）。
 * 误判只允许"多收"（某个标签的**值**里正好含 `"place":` 这种子串），绝不会少收。
 */
const NODE_POI_INDEX = 'idx_nodes_poi_low';
const NODE_POI_LOW_PREDICATE = `(tags LIKE '%"place":%'`
  + ` OR tags LIKE '%"natural":"peak"%'`
  + ` OR tags LIKE '%"natural":"spring"%'`
  + ` OR tags LIKE '%"natural":"cave_entrance"%')`;
const NODE_POI_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${NODE_POI_INDEX} ON nodes(id)
  WHERE deleted = 0 AND tags IS NOT NULL AND ${NODE_POI_LOW_PREDICATE}`;

/**
 * 部分索引：只索引"没被删、有 bbox"的 way（与 R*Tree 里有没有行完全一致）。
 * 不把 `lod_zoom IS NOT NULL` 写进谓词是**故意的**：万一库还没回填（全新导入后立刻起服务），
 * 那些行仍然在索引里、只是排在 NULL 段，查询会把它们读出来交给 accept() 判断 ——
 * 结果是"慢但正确"；反过来若把它们排除在索引外，查询就会**漏要素**。
 */
const WAY_LOD_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${WAY_LOD_INDEX} ON ways(lod_zoom)
  WHERE deleted = 0 AND min_lon IS NOT NULL`;

/** 建部分索引（幂等；列/表不对时什么都不做，返回 false = 低缩放退回 R*Tree 扫描） */
function ensureLodIndexes(db) {
  let ok = false;
  try {
    const cols = db.prepare('PRAGMA table_info(ways)').all().map((c) => c.name);
    if (cols.includes('lod_zoom') && cols.includes('min_lon') && cols.includes('deleted')) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(WAY_LOD_INDEX)) {
        ok = true;
      } else {
        const t0 = Date.now();
        db.exec(WAY_LOD_INDEX_SQL);
        warnOnce(`建立低缩放候选索引 ${WAY_LOD_INDEX}（${Date.now() - t0} ms）`);
        ok = true;
      }
    }
  } catch (err) {
    console.warn('[db] 低缩放候选索引不可用（低缩放退回 R*Tree 扫描）:', err.message);
  }
  try {
    // POI 侧的部分索引：与 way 侧那条无关，单独 try（少一条也不影响画面）
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(NODE_POI_INDEX)) {
      const t0 = Date.now();
      db.exec(NODE_POI_INDEX_SQL);
      const n = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE deleted = 0 AND tags IS NOT NULL AND ' + NODE_POI_LOW_PREDICATE).get().c;
      warnOnce(`建立低缩放 POI 索引 ${NODE_POI_INDEX}（低缩放可见 POI ${n} 个，${Date.now() - t0} ms）`);
    }
  } catch (err) {
    console.warn('[db] 低缩放 POI 索引不可用（低缩放退回 R*Tree 扫描）:', err.message);
  }
  return ok;
}

/** 抽检：库里存的 road_class / lod_zoom 跟"现在按 tags 重算"的结果对不对得上 */
function wayLodSample(db, wayLodKeysOf, n) {
  const rows = db.prepare('SELECT id, tags, road_class, lod_zoom FROM ways LIMIT ?').all(Math.max(1, n));
  let checked = 0;
  let bad = 0;
  for (const r of rows) {
    const k = wayLodKeysOf(r.tags);
    checked += 1;
    if (!k || Number(r.road_class) !== k.roadClass || Number(r.lod_zoom) !== k.lodZoom) bad += 1;
  }
  return { checked, bad, ok: checked > 0 && bad / checked <= 0.02 };
}

/**
 * 回填 ways.road_class / ways.lod_zoom（幂等，服务端启动时跑一次，跟空间索引自检同一个位置）。
 *
 *   wayLodKeysOf(tagsRaw) → { roadClass, lodZoom }
 *     由调用方给（`server/osmdb.js` 的 wayLodKeysOf：直接调用查询时用的那个 lodVisible，
 *     于是"存进库的判断"与"查询时的判断"**不可能对不上**）。
 * 返回 true = 这两列现在是可用的（低缩放可以走索引）。
 */
function backfillWayLod(db, wayLodKeysOf, opts = {}) {
  if (typeof wayLodKeysOf !== 'function') return false;
  const t0 = Date.now();
  try {
    const cols = db.prepare('PRAGMA table_info(ways)').all().map((c) => c.name);
    if (!cols.includes('road_class') || !cols.includes('lod_zoom')) return false;
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ways'").get()) return false;
    const total = db.prepare('SELECT COUNT(*) AS c FROM ways').get().c;
    if (!total) {                       // 空库（刚导入完还没灌数据）：先记上，等真有了数据再抽检
      setMeta(db, WAY_LOD_META, WAY_LOD_SIGNATURE);
      return true;
    }
    if (!opts.force && getMeta(db, WAY_LOD_META, '') === WAY_LOD_SIGNATURE) {
      const s = wayLodSample(db, wayLodKeysOf, opts.sample || 3000);
      if (s.ok) return true;             // 已经填好：一行都不动（启动零成本）
      warnOnce(`道路等级列抽检 ${s.checked} 行有 ${s.bad} 行与 tags 不符，重新回填一次`);
    }
    const upd = db.prepare('UPDATE ways SET road_class = ?, lod_zoom = ? WHERE id = ?');
    db.exec('BEGIN');
    let filled = 0;
    try {
      let udfReady = typeof db.function === 'function';
      if (udfReady) {
        try {
          let memoRaw = null;
          let memoKeys = null;
          const keysOf = (raw) => {
            if (raw !== memoRaw) { memoRaw = raw; memoKeys = wayLodKeysOf(raw); }
            return memoKeys;
          };
          db.function('way_road_class', (raw) => keysOf(raw).roadClass);
          db.function('way_lod_zoom', (raw) => keysOf(raw).lodZoom);
        } catch (err) {
          udfReady = false;              // 注册不了（老运行时/名字已占用）→ 退回逐条写，结果一样
          console.warn('[db] node:sqlite 自定义函数不可用，改走逐条回填:', err.message);
        }
      }
      if (udfReady) {
        /**
         * **一条 SQL 过**（真实数据集实测：32 万行 1.38~2.05 s）：把 JS 的那份规则注册成
         * SQLite 自定义函数，于是"回填"就是**一条 UPDATE**（省掉 32 万次语句开销），
         * 而规则仍然只有一份（`wayLodKeysOf` → `lodVisible`）。
         * 同一行上两个函数连着被调用，memo 一下省掉一次 JSON.parse。
         *
         * 三种写法的对照（tests/tmp-lodidx/probe-backfill.js，同库同机，32 万行：
         *   · 纯 SQL `CASE json_extract(...)` 0.58~0.87 s —— **最快**，但规则要在 SQL 里
         *     再写一遍；两份规则一旦不一致就会**悄悄少要素**（索引把该显示的 way 筛掉），不划算；
         *   · JS 逐条 UPDATE 1.54~2.00 s；
         *   · 本方案 1.38 s（单条 SQL + JS 规则），与纯 SQL 方案的输出**逐行相同**（0/319951 差异）。
         */
        db.exec('UPDATE ways SET road_class = way_road_class(tags), lod_zoom = way_lod_zoom(tags)');
        filled = total;
      } else {
        // 老运行时（node:sqlite 还没有自定义函数）：一次读出 id+tags（免得边读边改同一张表），
        // 逐条算 + 逐条写，结果和上面那条 SQL 完全一样（实测 32 万行 1.54~2.00 s）
        const rows = db.prepare('SELECT id, tags FROM ways').all();
        for (const r of rows) {
          const k = wayLodKeysOf(r.tags);
          if (!k) continue;
          upd.run(k.roadClass, k.lodZoom, r.id);
          filled += 1;
        }
      }
      // 指纹与数据在**同一个事务**里落盘：中途崩了下次启动会重填，绝不会"标记了但没填完"
      setMeta(db, WAY_LOD_META, WAY_LOD_SIGNATURE);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    warnOnce(`回填道路等级列 ways.road_class / lod_zoom：${filled} 行 / ${Date.now() - t0} ms，`
      + `低缩放候选扫描改走部分索引 ${WAY_LOD_INDEX}`);
    return true;
  } catch (err) {
    console.warn('[db] 道路等级列回填失败（低缩放退回旧的 R*Tree 扫描，画面不受影响）:', err.message);
    return false;
  }
}

function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** 元素 id 分配器：从当前最大值继续递增（负号留给"本地新建"语义，这里直接用大 id 保证唯一） */
class IdAllocator {
  constructor(db) {
    this.db = db;
    this.next = {
      node: Number(getMeta(db, 'next_node_id', 0)) || (db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM nodes').get().m + 1),
      way: Number(getMeta(db, 'next_way_id', 0)) || (db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM ways').get().m + 1),
      relation: Number(getMeta(db, 'next_relation_id', 0)) || (db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM relations').get().m + 1),
    };
  }

  alloc(type) {
    const id = this.next[type]++;
    setMeta(this.db, 'next_' + type + '_id', this.next[type]);
    return id;
  }

  persist() {
    setMeta(this.db, 'next_node_id', this.next.node);
    setMeta(this.db, 'next_way_id', this.next.way);
    setMeta(this.db, 'next_relation_id', this.next.relation);
  }
}

module.exports = {
  openDatabase, SCHEMA_SQL, getMeta, setMeta, IdAllocator,
  backfillWayLod, ensureLodIndexes,
  WAY_LOD_INDEX, WAY_LOD_SIGNATURE, NODE_POI_INDEX, NODE_POI_LOW_PREDICATE,
};
