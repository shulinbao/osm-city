'use strict';
/**
 * ==================== 区域分片（region sharding）· 第一阶段：只读查询走分片 ====================
 *
 * 设计文档：`deploy/REGIONS.md`（本文件只实现它的 **P1：多分片查询合并**，不含 P2 写入路由、
 * 不含 P3 拆库、不含 P4 惰性建图）。行号不写死，符号名与设计文档对齐。
 *
 * ## 一句话
 * `openRegionDB(config, options)` 返回一个**与 `OsmDB` 同形**的对象（鸭子类型）：
 *   · 分区**关**（默认）→ 原样返回 `new OsmDB(config.osmDb, …)`：**一个新库都不开、一份注册表都不读**，
 *     服务端行为与改动前逐字节相同（这是"游戏其他功能不受影响"的前提，也是所有既有测试的基线）；
 *   · 分区**开** → 返回本文件的 `RegionDB`：`queryBbox` 按视口选片、扇出、合并；
 *     **其余每一个方法（含全部写操作）都原样转发给那个单库**（`this.fallback`）——
 *     所以"新增元素（IdAllocator）"与所有写操作**仍然只走原来的单库**。
 *
 * ## 写路径为什么还是单库（本阶段的硬边界）
 * 分片之间会撞号（实测两片 `meta.next_relation_id` 完全相同，见 REGIONS.md §0 事实 6），
 * 所以只要写入路由一开，就必须先做 §5.5/§5.9 的 `idseq` 上收。**那是 P2 的事**。
 * 本文件**一行都没碰** `IdAllocator`、`insertNode/Way/Relation`、`changes` 这些写路径：
 * 写请求经 `RegionDB` 的转发**全部落在那一个单库上**，因此"两片各新建一条 relation 撞同一个 id"
 * 在 P1 **结构上不可能发生**（根本没有第二个可写的库）。
 *
 * ## 只读、惰性
 *   · 分片库一律用 `OsmDB(..., {readOnly: true})` 打开（见 osmdb.js 的 openReadOnlyDatabase）：
 *     启动时的迁移/回填/自愈在只读连接上会直接报 `attempt to write a readonly database`，
 *     所以那些路径整段跳过 —— 分片文件一个字节都不会被服务端改；
 *   · **惰性**：注册表在构造时读一次（纯 JSON），但**分片库一个都不在启动时打开**，
 *     第一次真正被视口命中时才 `new OsmDB(...)`（`/api/health` 的 `regions.opened` 可以自证）。
 *
 * ## 与单库的语义关系（判据 1/3 的口径）
 * 合并**早于打包**（§4.2 末尾）：各片用 `compact: false` 拿到"老形状"（`nodes` 字典 + 原始
 * `ways[id][1]` 节点 id 数组 + 未量化的折线），JS 侧按 id 去重合并，**然后**用 osmdb.js 里
 * 同一份 `packQueryResult()` 打包。这样"合并后的载荷"与"单库直出的载荷"是同一段代码的产物，
 * 形状必然一致（`dedupe → pack` 的顺序也不能反：`packNodesColumnar` 出来的是 delta 列，
 * 压完就再也无法按 id 去重了 —— 这是 §4.2 的实现要点，写错会很难查）。
 *
 * ## 三道闸门（§3.4 / §4.5）
 *   1. `fallbackBelowZoom`（默认 11）：`zoom < 它` ⇒ **一律回退单库**，低缩放 payload 逐字节不变；
 *   2. `fanoutMax`（默认 2）：命中片数 > 它 ⇒ 回退单库（扇出 N 次 = 同样多的行 + N 份固定开销，净更慢）；
 *   3. `mergedBytesLimit`（默认 4 MB）：合并过程中累计**最终载荷的 JSON 字节数**，超限就不再追加
 *      后续分片，并把它们标 `skipped:'bytes'`（同时整体 `complete=false`，客户端按既有协议拆块）。
 *   另外 `hit.length === 1` 时**直通**（不经过任何合并代码），并且**不加** `truncation.regions`
 *      （§9.0 的 R40：单片直通完全不加，默认路径零差异）。
 *
 * ## 同 id 去重（§4.2「问题 A：边界重复 id」）—— 规则与例外都写在这里
 * 键是 `(type, id)`。文档规则 0 是"先按 version 判"：
 *   1. 内容全同（version 也同）→ 取**属主片**那一行（内容一样，取谁不影响画面，但必须**确定**，
 *      否则同一个请求两次的字节可能不同，破坏对照实测与 BIN 的逐字节可比性）。
 *   2. version 不同 → 取 version **最大**的那一行，并且**必须报警**（conflicts + WARN + health 计数）。
 *   3. version 相同但内容不同 → nodes/ways 视为**数据损坏**：取属主片 + 报警 + health `degraded`。
 *
 * ⚠ **relations 的例外（本阶段的显式规则，必须写在代码里）**：
 * `relation` 的 bbox 与成员裁剪账本（`relations[id][3]`）是**派生量**，不是真相 ——
 * 它反映的是"**这一片手里有多少成员几何**"。实测（REGIONS.md §0 事实 5）：
 * 12,580 条共有 relation 里 **219 条的 bbox 不同，且 219/219 都是河北完全包含北京**；
 * `rel 912998（河北省）` 两片都有 416 个 way 成员行，但北京片只有 96 条**能解析出几何**；
 * `relation 2075515` 在**北京片里 bbox 全 NULL** —— 若取北京那一份，**它会因为没有 bbox
 * 而直接从空间索引（relation_index 的 R*Tree）里消失**。
 * 所以 relations 的去重**不看 version 谁大**，按"派生量更全"的那一份为准，判据按顺序是：
 *     ① bbox 非 NULL 优先（NULL 会被 R*Tree 排除）→ ② bbox 范围（面积）更大优先
 *     → ③ 成员账本更全（memberTotal → kept 条数）优先 → ④ 属主片优先 → ⑤ 分片 id 升序
 * 并且**照旧报冲突**（不许静默选一份）。version 不同时仍然先按 version 取大者，
 * 只有"同一批 version"里才用上面这串判据。（这是**读路径**的 P1 规则；P2 有了 `owner.sqlite`
 * 之后"关系只由属主片提供"才是正解，见 §4.4/§5.8。）
 *
 * ## 账本合并（§4.3）
 * `truncation` 的四类字段严格按文档处理，且**结果侧与扫描侧分开**：
 *   · **结果侧**（`truncation.payload.*`、`truncation.viewOnly.nodePayload.*`）：**按合并后的
 *     载荷重新数**（它们本来就在代码里写作 `Object.keys(ways).length`）—— 所以去重之后
 *     这几个数与单库**逐字段相同**（验收判据 3 就断言在这里）；
 *   · **扫描侧**（`kinds.*`、`summary.*`、`totals`）：按文档规则 **求和 / AND / null 传播**。
 *     ⚠ 如实说明：矩形互斥时"各片要素集合不相交"成立，求和就是全局真值；但当注册表里是
 *     **嵌套片（A ⊂ B，本次这两片就是）**时，同一批要素被两片各扫了一遍，扫描侧的账
 *     **会按片数翻倍** —— 这不是算错，而是"确实扫了两遍"的如实记录（也和 §5.8"镜像片不该
 *     同时参与读"的结论一致：正是它要避免的浪费）。文档里 `complete`/`exact`/`dropped`
 *     用的是证据语义（AND / 全精确才相加），那几条不受影响。
 *
 * ## 折线/面合并（displayLines / displayAreas）
 * 各片**各自合并**，然后**数组拼接**（§4.3）。已知偏差（文档已声明）：跨片缝的同名折线会
 * 被接成两段而不是一段，字节数与 `lines`/`paths` 计数会与单库不同。多片时按文档把合并预算
 * 摊薄为 `budget / N`（下限 0.05），生效值仍由各片在 `truncation.coalesce.budgetFrac` 里回显。
 *
 * ## 明确**没做**的事（诚实清单）
 *   · 不读 `data_bbox` / `source_bounds` 做寻址（§3.6 明令禁止）；
 *   · 不用 ATTACH（§3.3 已给出取舍：主路径是"每片一个 OsmDB + JS 侧合并"）；
 *   · 不做重切/迁移/删除（§10 的 P2+）；
 *   · `getElement` / `search` / `exportOsm` 等**单元素/全库**接口仍只走那个单库
 *     （它们在 P1 的语义是"读主库"，转发即可；视口查询才是分区的那一条）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { OsmDB, packQueryResult, packOptsOf, coalesceOptsOf } = require('./osmdb');
// P4 惰性建图：每张"区域图 / 走廊图"都是一个**独立**的 RailGraph 实例（禁止拼图，见 §6.5.1）
const {
  RailGraph, normalizeScopeBbox, JUNCTION_DENSITY_SCALE, JUNCTION_CELL_M,
} = require('./railgraph');

const ROOT = path.resolve(__dirname, '..');

/**
 * 分片 id 的白名单（§1.4 的硬约束 + 磁盘现状的放宽）：
 *   · **只允许小写字母 / 数字 / 连字符** —— 非白名单字符一律拒绝（不给"拼进 SQL / 拼成路径"留下注入面）；
 *   · `^[a-z][a-z0-9]{0,9}(-[a-z0-9]{1,4})?$`：既能表达 `<region>-<tile>`（`bj-1`），
 *     也能表达"只有一片的城市省略 -<tile> 后缀"（磁盘上就是 `beijing.sqlite` / `hebei.sqlite`），
 *     还能表达并行进展里 `tools/tile-cut.js` 产出的方向后缀（`bj-sw` / `heb-lf`）。
 *     设计文档 §1.4 的原正则要求 tile 是**数字**；这里按文档"并行进展"第 1 条的指引放宽成
 *     "字母数字后缀"，但**字符集（安全性那一条）不放宽**。
 * 无论哪种写法，**注册表里的 `id` 必须与文件名的 basename 逐字一致**（迁移与回滚全靠这个等式）。
 */
const REGION_ID_RE = /^[a-z][a-z0-9]{0,9}(-[a-z0-9]{1,4})?$/;

/** 合并时"回显型"的数字键：它们描述"这次请求用了什么上限/规则"，相加没有意义，取第一片 */
const ECHO_NUMBERS = new Set([
  'zoom', 'lodDetail', 'detail', 'detailFloor', 'minZoom', 'maxZoom', 'tolPx', 'coordDigits',
  'minClassWays', 'budgetFrac', 'pad', 'minMembers', 'clientAreaM2', 'landuseAreaM2',
  'roadSendRank', 'candidateLimit', 'pickLimit', 'scanCap',
]);

/** 与 osmdb.js 里 queryBbox 用的那一句**逐字相同**（合并导致不完整时也要给出同一句提示） */
const INCOMPLETE_HINT = '视口内有要素被上限截断：把这一块继续拆小再请求（拆开后每一块都会给出 complete=true 的完整证据）';

const REGION_DEFAULTS = {
  /** 总开关。**默认关**（"删掉这个块 = 回到今天"） */
  mode: 'off',
  /** 注册表路径（相对仓库根；写成绝对路径也认） */
  registry: 'data/regions/registry.json',
  /** 命中片数超过它就不走分片、回退单库（H2 的护城河，§3.4） */
  fanoutMax: 2,
  /** 低于这个缩放一律回退单库（低缩放 payload 因此逐字节不变） */
  fallbackBelowZoom: 11,
  /** 一次响应最多允许多少字节（合并后最终载荷的 JSON 字节数）；0 = 不限 */
  mergedBytesLimit: 4 * 1024 * 1024,
  /**
   * 分片矩形相交时怎么办：
   *   true （默认）—— 照常路由合并，**但打 WARN + 记 health**。理由：§4.2 的去重规则本来就
   *                   是为"边界复制/同 id 两片"准备的（"是必需的，不是可选的"），
   *                   而"矩形互斥"只是 §2.3 的**浪费**判据（重复查一遍），不是正确性判据。
   *                   本次磁盘上那两片（beijing ⊂ hebei）就是相交的，P1 必须能跑它们才能验证去重。
   *   false         —— 按 §2.3 自检项 4 降级：只用单库（`/api/health` 里 mode='degraded' 并说明原因）。
   * 生产口径：相交片会白白浪费一倍带宽，应按 §5.8 让镜像片退出读路径（P2）。
   */
  allowOverlap: true,
  /** `truncation.regions[].conflicts` 里最多列几条明细（总数另记 conflictCount） */
  conflictListMax: 20,
  /** 分片是否只读打开（**不要关**：分片库是只读素材） */
  readOnlyShards: true,
  /** 多片时是否按 §4.3 把合并预算摊薄成 budget/N */
  budgetTrowel: true,
  /** 每个请求打一行路由日志（排查/验收用，默认关） */
  logQueries: false,
  /* ------------------------- P4：按区域惰性建图（§7） ------------------------- */
  /**
   * **按区域惰性建图/启动**（deploy/REGIONS.md §7 的全部内容）。
   * ⚠ **只在 `mode:'on'` 时生效**：`mode:'off'` 时连这个字段都不读、一行相关代码都不执行
   * （`regionsOptionsOf` 只做纯计算，`openRegionDB` 的 off 分支在此之前就返回了）。
   * false = P4 的一行回滚：等价于"启动时按 assetShards/alwaysActive 全建"的老行为。
   */
  lazy: true,
  /** 图空闲多久后卸载（毫秒；0 = 永不自动卸载）。**资产片与 alwaysActive 永不卸载**（§7.2 / R28） */
  lazyIdleMs: 600000,
  /** 后台巡检周期（重算激活集 + 建图 + 卸载） */
  lazySweepMs: 30000,
  /** 运维强制常驻的片 id（与注册表里每片的 `alwaysActive` 取并集） */
  lazyAlwaysActive: [],
  /** 跨区域寻路：按走廊 bbox **新建一张临时图**（§6.5.2 方案 C）。false = 跨区域建线直接报错 */
  corridorGraph: true,
  /** 走廊 bbox 每边至少外扩多少米（§6.5.2：保证"绕行"的替代路径也在框内） */
  corridorPadMeters: 5000,
  /** 走廊图的缓存：TTL 与最多几张（§6.5.2 的"TTL 5 分钟、上限 4 张"） */
  corridorTtlMs: 300000,
  corridorMax: 4,
  /** 走廊/点图 bbox 量化步长（度）：库存在缓存里按它取整，避免抖动导致无限建图 */
  corridorQuantDeg: 0.05,
  /** "点不在任何区域矩形内"时，按点周围这么大的一张图兜底（米） */
  pointGraphRadiusM: 20000,
  /** 惰性相关的日志（建图/卸载/复用），默认开 */
  lazyLog: true,
};

/** 解析 config.regions（+ index.js 传进来的 CLI 覆盖），缺省全部走 REGION_DEFAULTS */
function regionsOptionsOf(config, override = {}) {
  const raw = (config && typeof config.regions === 'object' && config.regions) || {};
  const o = Object.assign({}, REGION_DEFAULTS, raw);
  if (override.mode !== undefined) o.mode = override.mode;
  if (override.registryPath) o.registry = override.registryPath;
  o.modeOn = o.mode === 'on' || o.mode === true || o.mode === '1' || o.mode === 'true';
  o.registryFile = path.resolve(ROOT, String(o.registry));
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  o.fanoutMax = Math.max(1, Math.floor(num(o.fanoutMax, REGION_DEFAULTS.fanoutMax)));
  o.fallbackBelowZoom = Math.max(0, Math.min(22, Math.floor(num(o.fallbackBelowZoom, REGION_DEFAULTS.fallbackBelowZoom))));
  o.mergedBytesLimit = Math.max(0, Math.floor(num(o.mergedBytesLimit, REGION_DEFAULTS.mergedBytesLimit)));
  o.conflictListMax = Math.max(0, Math.floor(num(o.conflictListMax, REGION_DEFAULTS.conflictListMax)));
  o.allowOverlap = o.allowOverlap !== false;
  o.readOnlyShards = o.readOnlyShards !== false;
  o.budgetTrowel = o.budgetTrowel !== false;
  o.logQueries = o.logQueries === true;
  /* ---- P4：惰性建图（§7）---- */
  o.lazy = o.lazy !== false;
  /** 惰性建图的真正开关：**必须同时** mode 开着（关着时一切照旧，一个字都不生效） */
  o.lazyOn = o.lazy === true && o.modeOn === true;
  o.lazyIdleMs = Math.max(0, Math.floor(num(o.lazyIdleMs, REGION_DEFAULTS.lazyIdleMs)));
  o.lazySweepMs = Math.max(1000, Math.floor(num(o.lazySweepMs, REGION_DEFAULTS.lazySweepMs)));
  o.lazyAlwaysActive = Array.isArray(o.lazyAlwaysActive)
    ? o.lazyAlwaysActive.map((v) => String(v)).filter(Boolean) : [];
  o.corridorGraph = o.corridorGraph !== false;
  o.corridorPadMeters = Math.max(0, num(o.corridorPadMeters, REGION_DEFAULTS.corridorPadMeters));
  o.corridorTtlMs = Math.max(0, Math.floor(num(o.corridorTtlMs, REGION_DEFAULTS.corridorTtlMs)));
  o.corridorMax = Math.max(0, Math.floor(num(o.corridorMax, REGION_DEFAULTS.corridorMax)));
  o.corridorQuantDeg = Math.max(0.0001, num(o.corridorQuantDeg, REGION_DEFAULTS.corridorQuantDeg));
  o.pointGraphRadiusM = Math.max(100, num(o.pointGraphRadiusM, REGION_DEFAULTS.pointGraphRadiusM));
  o.lazyLog = o.lazyLog !== false;
  o.source = override.source || (config && config.regions ? 'config.json' : 'default');
  return o;
}

/* ------------------------------ 注册表（§2） ------------------------------ */

/**
 * 读注册表 + §2.3 的启动自检。**纯只读**（不打开任何分片库、不查任何 meta）。
 * 返回值：
 *   { file, ok, errors[], warnings[], list[]（按 id 升序）, byId, primary, overlaps[], degradedReason|null }
 * 自检项（任一项硬错误 → 调用方降级到单库，不让服务起不来）：
 *   1. 文件存在且能解析出 JSON；
 *   2. `id` 合法（白名单）且与注册表键一致；
 *   3. `bbox` 合法（min<max 且在经纬度范围内）；
 *   4. 文件存在，且 `id === basename(file, '.sqlite')`（§1.4 的硬约束）；
 *   5. `primary` 指向一个存在的 id（**没写就按"节点最多的那一片"推导**，见下）；
 *   6. **矩形两两相交**：默认只 WARN（见 REGION_DEFAULTS.allowOverlap 的说明）；
 *      `allowOverlap:false` 时按 §2.3 自检项 4 变成硬错误。
 *
 * **两种注册表格式都认**（并行进展里的 `tools/tile-cut.js` 用的是第二种，字段名不同但语义相同）：
 *   A. 设计文档 §2.2 的形状：`{ primary, regions: { "<id>": { id, file, bbox:{minLon,…} , counts } } }`
 *   B. tile-cut 的形状：`{ tiles: [ { id, db, bbox:{min_lat,…}, rects:[…], counts } ] }`
 * 归一化后每片都拿到同一个结构（`file / bbox / rects / counts / …`）。两条要点：
 *   · **`rects`（多矩形）优先于 `bbox`**：tile-cut 的承德片是 L 形（两段矩形拼成），
 *     用它的外接 bbox 会把北京片整块盖住（选片时多打一片、低缩放直接顶到 fanoutMax）。
 *     用 `rects` 做寻址才符合 §3.1 不变量 1（"分片矩形并集 ⊇ 该要素几何范围"）。
 *   · `primary` 缺失时按 **counts.nodes 最大**的那一片推导（§5.8：属主 = 最全的那一片），
 *     并列取 id 升序 —— 它只影响去重时的平手判据，是确定性的。
 */
function loadRegistry(file, opts = {}) {
  const out = {
    file, ok: false, errors: [], warnings: [], list: [], byId: new Map(),
    primary: null, overlaps: [], degradedReason: null,
  };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    out.errors.push(`注册表读取/解析失败：${err.message}`);
    out.degradedReason = 'registry-unreadable';
    return out;
  }
  const numOf = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  /** `{minLon,minLat,maxLon,maxLat}` / `{min_lon,…}` 两种写法都认 */
  const rectOf = (r) => {
    if (!r || typeof r !== 'object') return null;
    const rect = {
      minLon: numOf(r.minLon !== undefined ? r.minLon : r.min_lon),
      minLat: numOf(r.minLat !== undefined ? r.minLat : r.min_lat),
      maxLon: numOf(r.maxLon !== undefined ? r.maxLon : r.max_lon),
      maxLat: numOf(r.maxLat !== undefined ? r.maxLat : r.max_lat),
    };
    return Object.values(rect).every((v) => v !== null) ? rect : null;
  };
  // 格式 A（regions 对象）或格式 B（tiles 数组）
  const entries = [];
  if (raw && raw.regions && typeof raw.regions === 'object') {
    for (const [key, rec] of Object.entries(raw.regions)) entries.push([key, rec]);
  } else if (raw && Array.isArray(raw.tiles)) {
    for (const rec of raw.tiles) entries.push([rec && rec.id, rec]);
  }
  if (!entries.length) {
    out.errors.push('注册表里既没有 regions（§2.2）也没有 tiles（tools/tile-cut.js 的形状）');
    out.degradedReason = 'registry-empty';
    return out;
  }
  out.builtAt = raw.builtAt || raw.generated_at || null;
  out.v = raw.v || null;
  out.generator = raw.generator || null;
  for (const [key, rec0] of entries) {
    const rec = rec0 && typeof rec0 === 'object' ? rec0 : {};
    const id = String(rec.id || key);
    const problems = [];
    if (!REGION_ID_RE.test(id)) problems.push(`id「${id}」不合法（只允许小写字母/数字/连字符，见 §1.4）`);
    if (raw.regions && id !== key) problems.push(`id「${id}」与注册表键「${key}」不一致`);
    const relFile = rec.file || rec.db || null;
    let absFile = null;
    if (!relFile) problems.push('没有 file / db 字段');
    else {
      absFile = path.resolve(ROOT, String(relFile));
      const base = path.basename(absFile);
      const stem = base.endsWith('.sqlite') ? base.slice(0, -'.sqlite'.length) : base;
      if (stem !== id) problems.push(`文件名「${base}」与 id「${id}」不一致（§1.4：文件名 = <id>.sqlite）`);
    }
    const rects = Array.isArray(rec.rects) ? rec.rects.map(rectOf).filter(Boolean) : [];
    const bbox = rectOf(rec.bbox) || (rects.length ? rects.reduce((acc, r) => ({
      minLon: Math.min(acc.minLon, r.minLon), minLat: Math.min(acc.minLat, r.minLat),
      maxLon: Math.max(acc.maxLon, r.maxLon), maxLat: Math.max(acc.maxLat, r.maxLat),
    }), { ...rects[0] }) : null);
    const bboxOk = !!bbox && bbox.minLon < bbox.maxLon && bbox.minLat < bbox.maxLat
      && bbox.minLon >= -180 && bbox.maxLon <= 180 && bbox.minLat >= -90 && bbox.maxLat <= 90;
    if (!bboxOk) problems.push('bbox 不合法（需要 min<max 且在经纬度范围内）');
    if (rects.some((r) => !(r.minLon < r.maxLon && r.minLat < r.maxLat))) problems.push('rects 里有不合法矩形');
    const counts = rec.counts || {};
    const item = {
      id,
      region: rec.region || rec.group || id,
      name: rec.name || id,
      file: absFile,
      relFile,
      bbox,
      /** 寻址用：多矩形优先（tile-cut 的 L 形片靠它才不会盖住邻片） */
      rects: rects.length ? rects : (bbox ? [bbox] : []),
      dataBbox: rec.dataBbox || rec.data_bbox || null,
      counts: {
        nodes: Number(counts.nodes) || 0,
        ways: Number(counts.ways) || 0,
        relations: Number(counts.relations) || 0,
        wayNodes: Number(counts.wayNodes || counts.way_nodes) || 0,
        relationMembers: Number(counts.relationMembers || counts.relation_members) || 0,
      },
      sizeBytes: Number(rec.sizeBytes || rec.bytes) || 0,
      weight: Number.isFinite(Number(rec.weight)) ? Number(rec.weight) : 1,
      alwaysActive: rec.alwaysActive === true,
      source: rec.source || rec.source_file || null,
      importedAt: rec.importedAt || rec.generated_at || null,
      exists: !!absFile && fs.existsSync(absFile),
      problems,
    };
    if (!item.exists) problems.push('文件不存在');
    if (item.problems.length) out.errors.push(`${id}：${item.problems.join('；')}`);
    out.list.push(item);
    out.byId.set(id, item);
  }
  out.list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  out.primary = raw.primary ? String(raw.primary) : null;
  if (!out.primary) {
    // 没写 primary ⇒ 按 §5.8"属主 = 最全的那一片"推导（并列取 id 升序，确定性）
    const best = out.list.slice().sort((a, b) => (b.counts.nodes - a.counts.nodes) || (a.id < b.id ? -1 : 1))[0];
    out.primary = best ? best.id : null;
    out.primaryDerived = true;
  }
  if (!out.primary || !out.byId.has(out.primary)) {
    out.errors.push(`primary「${out.primary}」不指向任何一片（§2.3 自检项 5）`);
  }
  // 矩形两两相交（§2.3 自检项 4）：默认只 WARN —— 见 REGION_DEFAULTS.allowOverlap。
  // 逐**矩形**两两比（不是拿外接 bbox 比）：tile-cut 的 L 形片只有这样才不会被误判成相交。
  for (let i = 0; i < out.list.length; i++) {
    for (let j = i + 1; j < out.list.length; j++) {
      let worst = null;
      for (const ra of out.list[i].rects) {
        for (const rb of out.list[j].rects) {
          const w = Math.min(ra.maxLon, rb.maxLon) - Math.max(ra.minLon, rb.minLon);
          const h = Math.min(ra.maxLat, rb.maxLat) - Math.max(ra.minLat, rb.minLat);
          if (w > 0 && h > 0 && (!worst || w * h > worst.area)) worst = { area: w * h, width: w, height: h };
        }
      }
      if (worst) out.overlaps.push({ a: out.list[i].id, b: out.list[j].id, ...worst });
    }
  }
  if (out.overlaps.length) {
    out.warnings.push(out.overlaps.map((o) => `${o.a} ∩ ${o.b}（${o.width.toFixed(3)}°×${o.height.toFixed(3)}°）`).join('、'));
  }
  out.missing = out.list.filter((r) => !r.exists).map((r) => r.id);
  out.ok = out.errors.length === 0;
  if (!out.ok) out.degradedReason = 'registry-selfcheck-failed';
  else if (out.overlaps.length && opts.allowOverlap === false) out.degradedReason = 'registry-overlap';
  return out;
}

/* ------------------------------ 小的合并工具 ------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 结构化相等（只用于"这两个数/结构一样吗"的判断，元素量很小） */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** 面的"面积"（度²）：只用来比较两个派生 bbox 谁更大，不做地理计算 */
function bboxArea(b) {
  if (!b || ![b.minLon, b.maxLon, b.minLat, b.maxLat].every(Number.isFinite)) return -1;
  return Math.max(0, b.maxLon - b.minLon) * Math.max(0, b.maxLat - b.minLat);
}

/** `byFamily` / `classes` 这类"按 class 键的数组"相加（coalesced / always 这类 0/1 标记取 OR） */
function mergeClassArrays(arrays) {
  const byClass = new Map();
  for (const arr of arrays) {
    for (const item of arr) {
      if (!isPlainObject(item)) continue;
      const key = String(item.class === undefined ? item.family : item.class);
      const cur = byClass.get(key);
      if (!cur) { byClass.set(key, Object.assign({}, item)); continue; }
      for (const [k, v] of Object.entries(item)) {
        const old = cur[k];
        if (typeof v === 'number' && typeof old === 'number') {
          // coalesced / always 是"这个类有没有被合并"的 0/1 标记，相加会变成 2（语义错）
          cur[k] = (k === 'coalesced' || k === 'always') ? Math.max(old, v) : old + v;
        } else if (typeof v === 'boolean' && typeof old === 'boolean') cur[k] = old || v;
        else if (old === undefined) cur[k] = v;
      }
    }
  }
  return [...byClass.values()].sort((a, b) => (Number(b.ways) || 0) - (Number(a.ways) || 0));
}

/**
 * 账本（truncation 的某个路径）在多片上的合并。规则见文件头「账本合并」：
 *   · 全部相等 → 原样回显（回显/规则字段走这条）
 *   · 数字 → 相加（ECHO_NUMBERS 例外：取第一片）
 *   · 布尔 → AND（complete / exact / scannedAll / candidatesCapped …）
 *   · 对象 → 逐键；数组 → 按 class 相加 / 字符串取并集
 *   · null 与值混用 → 取非 null 的那个（并记一条 warn）
 *   · 特殊键：dropped（任一片不精确 ⇒ null）、limitHit、stopReason
 */
function mergeLedgerValues(values, key, warn) {
  const vals = values.filter((v) => v !== undefined);
  if (!vals.length) return undefined;
  const first = vals[0];
  if (vals.every((v) => deepEqual(v, first))) return first;
  // dropped：数不出来就说数不出来（只要有一片不精确，合并后的值只能是 null）
  if (key === 'dropped') return vals.some((v) => v === null) ? null : vals.reduce((s, v) => s + (Number(v) || 0), 0);
  if (key === 'limitHit') {
    const set = new Set(vals);
    if (set.has('candidates')) return 'candidates';
    if (set.has('pick')) return 'pick';
    return null;
  }
  if (key === 'stopReason') {
    if (vals.every((v) => v === 'exhausted')) return 'exhausted';
    return vals.find((v) => v !== 'exhausted');
  }
  if (vals.every((v) => typeof v === 'number')) {
    if (ECHO_NUMBERS.has(key)) return first;
    return vals.reduce((s, v) => s + v, 0);
  }
  if (vals.every((v) => typeof v === 'boolean')) return vals.every((v) => v === true);
  if (vals.every((v) => v === null)) return null;
  if (vals.every(isPlainObject)) {
    const out = {};
    const keys = new Set();
    for (const v of vals) for (const k of Object.keys(v)) keys.add(k);
    for (const k of keys) {
      out[k] = mergeLedgerValues(vals.map((v) => (k in v ? v[k] : undefined)), k, warn);
    }
    return out;
  }
  if (vals.every(Array.isArray)) {
    const flat = vals.flat();
    if (flat.every((x) => typeof x === 'string')) return [...new Set(flat)];
    return mergeClassArrays(vals);
  }
  if (vals.some((v) => v === null)) {
    // 一边有值一边 null（例如 viewOnly.areas 在某片没生效）：取有值的那一个
    const nonNull = vals.find((v) => v !== null);
    if (nonNull !== undefined) {
      if (warn) warn(`账本字段 ${key} 各片不一致（null / 有值），按"有值的那个"处理`);
      return nonNull;
    }
  }
  if (warn) warn(`账本字段 ${key} 类型不一致，取第一片的值（${JSON.stringify(first)} ≠ ${JSON.stringify(vals[1])}）`);
  return first;
}

/** 属主优先的确定性顺序：primary 片排最前，其余按 id 升序（§3.1 不变量 3：同一请求结果可复现） */
function orderByOwner(ids, primary) {
  return ids.slice().sort((a, b) => {
    const pa = a === primary ? 0 : 1;
    const pb = b === primary ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/* ------------------------------ RegionDB ------------------------------ */

class RegionDB {
  constructor(config, options = {}) {
    this.config = config;
    this.opts = options.regions;                  // 已解析的分区选项（regionsOptionsOf 的产物）
    this.mode = 'on';
    /**
     * **那个单库**（= `config.osmDb`，就是今天的库）：写路径、低缩放回退、单片以外的一切接口。
     * 它的打开方式与改动前**一模一样**（可写、跑迁移与自愈）—— 服务端自己那个库的行为不变。
     */
    this.fallback = new OsmDB(config.osmDb, {
      auditIndexes: options.auditIndexes,
      wayLodIndexMaxZoom: options.wayLodIndexMaxZoom,
      wayLodSample: options.wayLodSample,
      nodePoiIndexMaxZoom: options.nodePoiIndexMaxZoom,
    });
    this.registry = loadRegistry(this.opts.registryFile, { allowOverlap: this.opts.allowOverlap });
    this.shards = new Map();                      // id → { rec, db|null, openMs, openedAt, queries }
    /**
     * **P4 惰性建图的世界**（`RegionLazyWorld`）：由 `server/index.js` 在装配阶段挂上来
     * （`db.lazyWorld = world`）。为 null 时 `info()` 里**不会多出 `lazy` 键** ——
     * 所以单测直接 `new RegionDB(...)` 时的输出与改动前逐字段相同。
     */
    this.lazyWorld = null;
    this.stats = {
      requests: 0, single: 0, multi: 0,
      fallbackLowZoom: 0, fallbackFanout: 0, fallbackNoHit: 0, fallbackDegraded: 0,
      opens: 0, conflicts: 0, sameVersionConflicts: 0, derivedConflicts: 0,
      bytesGateSkips: 0, lastConflict: null, lastQuery: null,
    };
    this.degraded = this.registry.ok ? null : {
      reason: this.registry.degradedReason || 'registry-selfcheck-failed',
      errors: this.registry.errors.slice(),
    };
    if (this.registry.ok && this.registry.overlaps.length && this.opts.allowOverlap === false) {
      this.degraded = { reason: 'registry-overlap', errors: [`分片矩形相交：${this.registry.warnings.join('；')}`] };
    }
    if (this.degraded) {
      this.mode = 'degraded';
      console.warn('[regions] ⚠ 分区降级为单库（' + this.degraded.reason + '）：'
        + this.degraded.errors.join(' · ')
        + ` —— 服务照常，只是查询走单库 ${config.osmDb}`);
    } else {
      for (const w of this.registry.warnings) {
        console.warn(`[regions] ⚠ 分片矩形相交（${w}）：同一要素会被两片各查一遍、合并时按 id 去重；`
          + '这是 §2.3 的"浪费"判据（不是正确性判据），P1 照常路由并如实报冲突；'
          + '生产口径见 §5.8（镜像片退出读路径，属于 P2）');
      }
      console.log(`[regions] 区域分片：**已开启** · 注册表 ${path.relative(ROOT, this.opts.registryFile)}`
        + ` · ${this.registry.list.length} 片（${this.registry.list.map((r) => r.id).join(', ')}）`
        + ` · 主片 ${this.registry.primary}`
        + ` · fanoutMax=${this.opts.fanoutMax} · fallbackBelowZoom=${this.opts.fallbackBelowZoom}`
        + ` · mergedBytesLimit=${this.opts.mergedBytesLimit ? (this.opts.mergedBytesLimit / 1024).toFixed(0) + ' KB' : '不限'}`
        + ` · 分片只读 · **惰性打开（启动时打开 0 个分片库）**`);
      console.log('[regions] 写路径：**仍然只走单库** ' + config.osmDb
        + '（IdAllocator / insertNode / insertWay / insertRelation / changes 一行未改；'
        + '两片 next_relation_id 相同的撞号问题属于 P2，P1 结构上不会发生）');
    }
    // 鸭子类型：没在本类上实现的属性/方法一律转发给单库（写路径就是靠这一条"原样不动"）
    return new Proxy(this, {
      get(target, prop, recv) {
        if (prop in target) return Reflect.get(target, prop, recv);
        const v = target.fallback[prop];
        return typeof v === 'function' ? v.bind(target.fallback) : v;
      },
      has(target, prop) {
        return (prop in target) || (prop in target.fallback);
      },
    });
  }

  /* ------------------------------ 视口 → 分片（§3） ------------------------------ */

  /**
   * 第一级（粗筛，§3.6）：候选分片 = { r ∈ 注册表 : r 的任一矩形 ∩ viewport ≠ ∅ }，输出**有序** id 列表。
   * 用注册表里人定的矩形（`rects`，缺省时退化成单个 `bbox`），**绝不**用 dataBbox / source_bounds（§3.6 明令）。
   * O(N) 扫描：试点 8~12 片时是几十次浮点比较（纳秒级），不值得做空间索引（§3.2）。
   * ⚠ 分片数一旦超过 64 就必须换成"按经度分桶 + 桶内线性"或网格哈希（§3.2 的规矩，此处留痕）。
   */
  resolve(bbox) {
    const out = [];
    if (!bbox) return out;
    const { minLon, minLat, maxLon, maxLat } = bbox;
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return out;
    for (const rec of this.registry.list) {
      const rects = rec.rects && rec.rects.length ? rec.rects : [rec.bbox];
      // 宽松相交（§3.1 不变量 1）：边界复制的要素可能落在邻片，所以不能用"要素中心在框内"那种严格判据
      for (const b of rects) {
        if (!b) continue;
        if (b.minLon <= maxLon && b.maxLon >= minLon && b.minLat <= maxLat && b.maxLat >= minLat) { out.push(rec.id); break; }
      }
    }
    return out;
  }

  /** 惰性打开一片（第一次真的被命中时才开；只读连接，见文件头） */
  shard(id) {
    let rec = this.shards.get(id);
    if (rec && rec.db) return rec.db;
    const meta = this.registry.byId.get(id);
    if (!meta) throw new Error(`分片 ${id} 不在注册表里`);
    if (!rec) {
      rec = { id, rec: meta, db: null, openMs: 0, openedAt: null, queries: 0 };
      this.shards.set(id, rec);
    }
    const t0 = Date.now();
    rec.db = new OsmDB(meta.file, {
      readOnly: this.opts.readOnlyShards,
      auditIndexes: false,                        // 只读库不做自愈（见 osmdb.js 的 readOnly 分支）
      wayLodIndexMaxZoom: this.optsWayLodIndexMaxZoom,
      wayLodSample: this.optsWayLodSample,
      nodePoiIndexMaxZoom: this.optsNodePoiIndexMaxZoom,
    });
    rec.openMs = Date.now() - t0;
    rec.openedAt = new Date().toISOString();
    this.stats.opens += 1;
    console.log(`[regions] 惰性打开分片 ${id}（${path.relative(ROOT, meta.file)}，只读，${rec.openMs} ms）`
      + ` —— 累计打开 ${this.stats.opens} 片`);
    return rec.db;
  }

  /* ------------------------------ 视口查询 ------------------------------ */

  queryBbox(opts) {
    const s = this.stats;
    s.requests += 1;
    if (this.mode === 'degraded') {
      s.fallbackDegraded += 1;
      return this.fallback.queryBbox(opts);
    }
    const t0 = Date.now();
    const hit = this.resolve(opts);
    const zoom = Number.isFinite(Number(opts.zoom)) ? Number(opts.zoom) : 16;
    const why = (kind, extra = {}) => {
      s.lastQuery = { at: new Date().toISOString(), kind, hit: hit.slice(), zoom, ...extra };
      if (this.opts.logQueries) {
        console.log(`[regions] ${kind} zoom=${zoom} bbox=[${opts.minLon},${opts.minLat},${opts.maxLon},${opts.maxLat}]`
          + ` 命中=${hit.length ? hit.join(',') : '无'} ${Date.now() - t0} ms`);
      }
    };
    // 闸门 1：视口完全落在所有分片之外 → 单库（与今天一致，正常返回空）
    if (!hit.length) { s.fallbackNoHit += 1; why('fallback:no-hit'); return this.fallback.queryBbox(opts); }
    // 闸门 2：低缩放一律回退单库（§3.4）—— 低缩放 payload 因此**逐字节不变**
    if (zoom < this.opts.fallbackBelowZoom) {
      s.fallbackLowZoom += 1; why('fallback:low-zoom'); return this.fallback.queryBbox(opts);
    }
    // 闸门 3：扇出超过上限 → 回退单库（§3.4：扇出 N 次 = 同样的候选行 + N 份固定开销，净更慢）
    if (hit.length > this.opts.fanoutMax) {
      s.fallbackFanout += 1; why('fallback:fanout', { fanoutMax: this.opts.fanoutMax });
      return this.fallback.queryBbox(opts);
    }
    // 单片：**直通**（不经过任何合并代码，也不加 truncation.regions，见 §9.0 R40）
    if (hit.length === 1) {
      s.single += 1;
      const res = this.shard(hit[0]).queryBbox(opts);
      this.shards.get(hit[0]).queries += 1;
      why('passthrough:single', { shard: hit[0] });
      return res;
    }
    s.multi += 1;
    const out = this.queryMulti(opts, hit, zoom, t0);
    why('fanout:merged', { shards: hit.slice(), ms: Date.now() - t0 });
    return out;
  }

  /** 多片：按 id 升序依次查 → 合并 → 打包；字节闸门越限就不再追加后续分片（§4.5） */
  queryMulti(opts, hit, zoom, t0) {
    const order = hit.slice().sort();               // 固定顺序（§4.5 规则 4：注册表 id 升序，可复现）
    const effCoalesce = this.coalesceForFanout(opts.coalesce, order.length);
    const parts = [];
    const skipped = [];
    let built = null;
    let gate = null;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const tShard = Date.now();
      // compact:false —— 拿"老形状"才能在打包之前按 id 去重（见文件头「合并早于打包」）
      const res = this.shard(id).queryBbox(Object.assign({}, opts, { compact: false, coalesce: effCoalesce }));
      const ms = Date.now() - tShard;
      this.shards.get(id).queries += 1;
      const part = { id, res, ms };
      const next = parts.concat([part]);
      const cand = this.build(opts, next, effCoalesce, skipped.slice());
      const limit = this.opts.mergedBytesLimit;
      if (limit > 0 && cand.bytes > limit && parts.length >= 1) {
        // 超限：**不采用**这一片，把这一片与后面所有片标 skipped:'bytes'
        skipped.push({ id, reason: 'bytes' });
        for (let j = i + 1; j < order.length; j++) skipped.push({ id: order[j], reason: 'bytes' });
        this.stats.bytesGateSkips += skipped.length;
        gate = { limit, at: cand.bytes, shard: id, order: order.slice() };
        break;
      }
      parts.push(part);
      built = cand;
    }
    if (!built) {
      // 理论上不会发生（第一片永远被采用）；防御性兜底：回退单库，绝不给半截载荷
      console.warn('[regions] 合并结果为空（字节闸门？），本次回退单库');
      this.stats.fallbackFanout += 1;
      return this.fallback.queryBbox(opts);
    }
    const result = built.result;
    /**
     * `truncation.regions`：**只有多片时才加**（单片直通不加，见 §9.0 R40）。
     * 每片一条：{id, hit, ms, features, complete, exact, totals, empty, overQuota, skipped, conflicts}
     * —— 空的片也如实出现（§3.6 规则 2：运维要能看出"这个 bbox 打了几片、几片是空的"）。
     */
    const entries = [];
    for (const p of parts) {
      const feats = featureCounts(p.res);
      /**
       * ⚠ 这里**只放"这一次请求"的事实**：不要放累计计数器（比如"这一片被查过几次"）——
       * 那会让"同一个 (bbox, zoom) 两次请求"的载荷逐字节不同，破坏 §3.1 不变量 3。
       * 累计量在 `/api/health` 的 `regions.shards[].queries` 里。
       */
      const entry = {
        id: p.id,
        hit: true,
        ms: p.ms,
        features: feats,
        complete: !!(p.res.truncation && p.res.truncation.complete),
        exact: !!(p.res.truncation && p.res.truncation.exact),
        totals: p.res.totals || null,
        empty: !(feats.ways || feats.nodes || feats.relations || feats.displayLines || feats.displayAreas),
        overQuota: false,
      };
      const c = built.byShardConflicts.get(p.id);
      if (c && c.total) {
        entry.conflictCount = c.total;
        if (c.list.length) entry.conflicts = c.list;
      }
      entries.push(entry);
    }
    for (const s of skipped) entries.push({ id: s.id, hit: false, skipped: s.reason });
    /**
     * 配额（§4.5 规则 2）：每片按**自己的** limit 扫（各片独立证明 complete），合并后如果某个类的
     * 总数超过**它自己那道上限**，就如实置 `complete = false`（客户端按既有协议拆块）并在每片上标 `overQuota`。
     * ⚠ 每类的上限口径必须与 `OsmDB.queryBbox` 一致，不能把三个类加起来跟一个数比：
     *   ways      → `viewportLimit`
     *   nodes     → `viewportLimit × nodeCandidates`（节点那一档是"POI 候选"，不是"所有节点"）
     *   relations → `relationLimit`
     * （第一版把三者相加与 `viewportLimit` 比，z15/z16 直接误判成 truncated —— 这里按类比。）
     */
    const capOf = {
      ways: Number.isFinite(opts.limit) ? opts.limit : Infinity,
      nodes: Number.isFinite(opts.limit) ? opts.limit * (Number(opts.nodeCandidates) || 8) : Infinity,
      relations: Number.isFinite(opts.relationLimit) ? opts.relationLimit : Infinity,
    };
    const returnedSum = { ways: 0, nodes: 0, relations: 0 };
    for (const p of parts) {
      const k = p.res.truncation && p.res.truncation.kinds;
      if (!k) continue;
      returnedSum.ways += k.ways.returned || 0;
      returnedSum.nodes += k.nodes.returned || 0;
      returnedSum.relations += k.relations.returned || 0;
    }
    let overQuota = false;
    for (const cls of ['ways', 'nodes', 'relations']) {
      if (returnedSum[cls] > capOf[cls]) overQuota = true;
    }
    let complete = !!built.complete;
    if (skipped.length) complete = false;
    if (overQuota) complete = false;
    for (const e of entries) if (e.hit && overQuota) e.overQuota = true;
    built.truncation.returnedSum = returnedSum;
    built.truncation.regions = entries;
    if (gate) built.truncation.regionsBytesLimit = gate;
    if (!complete) {
      result.truncated = true;
      built.truncation.complete = false;
      built.truncation.hint = INCOMPLETE_HINT;
    }
    result.truncation = built.truncation;
    // 冲突记账 + 一条 WARN（只对**最终采用**的那一次合并做，见 build 里的说明）
    this.commitConflicts(built.conflicts, opts, order, skipped);
    if (this.opts.logQueries || built.conflictTotal) {
      const f = built.features;
      console.log(`[regions] 扇出合并：${parts.length}/${order.length} 片 · `
        + `ways=${f.ways} nodes=${f.nodes} relations=${f.relations} lines=${f.displayLines} areas=${f.displayAreas} · `
        + `${built.bytes} B（上限 ${this.opts.mergedBytesLimit || '不限'}）· complete=${complete} · ${Date.now() - t0} ms`
        + (skipped.length ? ` · 跳过 ${skipped.map((x) => x.id).join(',')}` : ''));
    }
    return result;
  }

  /**
   * 多片时的合并预算摊薄（§4.3 末尾）：`budget / N`，下限 0.05（与 coalesceOptsOf 同一条下限）。
   * 理由：每片的 `COALESCE_DEFAULTS.budget` 是各片独立算的，N 片就是 N 倍预算 ⇒ displayLines 可能变多。
   * 注意：**只改 budget**，`minZoom / tolPx / coordDigits / wayCandidates` 一律不动 ——
   * 否则 nodeScale / lineScale 会跟着变，合并载荷就不再与单库可比了。
   */
  coalesceForFanout(raw, n) {
    if (!this.opts.budgetTrowel || n <= 1) return raw;
    const o = coalesceOptsOf(raw);
    const frac = Math.max(0.05, o.budget / n);
    const base = (raw && typeof raw === 'object' && raw !== false) ? raw : {};
    return Object.assign({}, base, { budget: frac });
  }

  /* ------------------------------ 合并（§4.2 / §4.3） ------------------------------ */

  /**
   * 合并若干片的"老形状"结果 → 一份载荷。每片的值都**复制**一份再进合并结果：
   * 打包（`packQueryResult`）是**就地改**（ways[id][1] 换成 delta、折线坐标换成量化整数），
   * 所以分片自己的结果对象必须保持未被修改 —— 否则字节闸门要"退掉最后一片重算"时就没法重算了。
   */
  build(opts, parts, effCoalesce, skipped) {
    const nodes = {};
    const nodeTags = {};
    const ways = {};
    const relations = {};
    const lines = [];
    const areas = [];
    const conflicts = [];
    const byShardConflicts = new Map();
    const partOf = new Map();                       // id → 分片结果（去重时要用）
    /**
     * 冲突**只在这里收集**（不改 this.stats、不打日志）：字节闸门会"试合并 → 不满意就退掉最后一片"
     * 重算一次，若在这一层就记账，被退掉的那一次会污染 health 计数、还会多打一遍 WARN。
     * 记账与 WARN 由调用方在**最终采用的那一次**用 commitConflicts() 做。
     */
    const addConflict = (rec) => {
      conflicts.push(rec);
      for (const sid of rec.shards) {
        let c = byShardConflicts.get(sid);
        if (!c) { c = { total: 0, list: [] }; byShardConflicts.set(sid, c); }
        c.total += 1;
        if (c.list.length < this.opts.conflictListMax) c.list.push(rec);
      }
    };
    for (const p of parts) partOf.set(p.id, p.res);
    const order = parts.map((p) => p.id);
    const ownerFirst = orderByOwner(order, this.registry.primary);

    for (const p of parts) {
      const res = p.res;
      // ---- ① 节点：载荷行里只有 1e-7 量化后的 [lat, lon]（**没有 version**），所以冲突时去基表点查 version ----
      for (const key in res.nodes) {
        const v = res.nodes[key];
        const cur = nodes[key];
        if (cur === undefined) { nodes[key] = [v[0], v[1]]; continue; }
        if (cur[0] !== v[0] || cur[1] !== v[1]) {
          const holders = order.filter((id) => partOf.get(id).nodes[key] !== undefined);
          const versions = holders.map((id) => this.nodeVersion(id, Number(key)));
          const picked = this.pickByVersionThenOwner(holders, versions);
          addConflict({
            type: 'node', id: Number(key),
            kind: versions.some((x) => x !== null && x !== versions[0]) ? 'version' : 'same-version',
            reason: versions.some((x) => x !== null && x !== versions[0]) ? 'version-newer-wins' : 'content-differs',
            shards: holders, versions, ownerShard: this.registry.primary, picked,
            values: holders.map((id) => partOf.get(id).nodes[key]),
          });
          if (picked === p.id) { nodes[key] = [v[0], v[1]]; }
        }
      }
      // ---- ② 节点标签（同 id ⇒ 同一行 ⇒ 与坐标共用同一套 version 判据）----
      for (const key in res.nodeTags) {
        const v = res.nodeTags[key];
        const cur = nodeTags[key];
        if (cur === undefined) { nodeTags[key] = v; continue; }
        if (!deepEqual(cur, v)) {
          const holders = order.filter((id) => partOf.get(id).nodeTags[key] !== undefined);
          const versions = holders.map((id) => this.nodeVersion(id, Number(key)));
          const picked = this.pickByVersionThenOwner(holders, versions);
          addConflict({
            type: 'node-tags', id: Number(key), kind: 'version', reason: 'version-newer-wins',
            shards: holders, versions, ownerShard: this.registry.primary, picked,
          });
          if (picked === p.id) nodeTags[key] = v;
        }
      }
      // ---- ③ way：规则 0 严格按 version 判（取大者），并列取属主片 ----
      for (const key in res.ways) {
        const row = res.ways[key];
        const cur = ways[key];
        if (cur === undefined) {
          ways[key] = [row[0], row[1].slice(), row[2], row[3], row[4]];
          continue;
        }
        if (!sameWayRow(cur, row)) {
          const holders = order.filter((id) => partOf.get(id).ways[key] !== undefined);
          const versions = holders.map((id) => partOf.get(id).ways[key][0]);
          const picked = this.pickByVersionThenOwner(holders, versions);
          addConflict({
            type: 'way', id: Number(key), kind: versions.some((v) => v !== versions[0]) ? 'version' : 'same-version',
            reason: versions.some((v) => v !== versions[0]) ? 'version-newer-wins' : 'content-differs',
            shards: holders, versions, ownerShard: this.registry.primary, picked,
          });
          if (picked === p.id) {
            const r = partOf.get(p.id).ways[key];
            ways[key] = [r[0], r[1].slice(), r[2], r[3], r[4]];
          }
        }
      }
      // ---- ④ relation：见文件头「relations 的例外」——派生 bbox / 成员账本更全的那一份为准 ----
      for (const key in res.relations) {
        const row = res.relations[key];
        const cur = relations[key];
        if (cur === undefined) { relations[key] = [row[0], row[1], row[2], row[3]]; continue; }
        if (!deepEqual(cur, row)) {
          const pick = this.pickRelation(order, partOf, key);
          addConflict({
            type: 'relation', id: Number(key), kind: pick.kind, reason: pick.reason,
            shards: pick.shards, versions: pick.versions, ownerShard: this.registry.primary,
            picked: pick.picked, bbox: pick.bbox,
          });
          if (pick.picked === p.id) {
            const r = partOf.get(p.id).relations[key];
            relations[key] = [r[0], r[1], r[2], r[3]];
          }
        }
      }
      // ---- ⑤ 折线 / 面：各片各自合并，然后数组拼接（§4.3）----
      for (const l of res.displayLines || []) lines.push(copyDisplayEntry(l));
      for (const a of res.displayAreas || []) areas.push(copyDisplayEntry(a));
    }

    const totals = {};
    for (const k of ['ways', 'nodes', 'relations']) {
      totals[k] = parts.some((p) => p.res.totals[k] === null || p.res.totals[k] === undefined)
        ? null : parts.reduce((s, p) => s + (Number(p.res.totals[k]) || 0), 0);
    }
    /**
     * **规范化 id 升序**（合并路径的确定性，§3.1 不变量 3）。
     *
     * 为什么必须做：JS 的 `for (const key in obj)` 只对"数组下标"（0 ≤ n < 2^32−1）保证数值升序，
     * 而 OSM 的 node id 早就超过 2^32（本数据集实测到 14,201,758,761）——那些键是按**插入顺序**枚举的。
     * 于是"先插第一片、再插第二片"的合并结果，其 `nodePack.ids` 的顺序会依赖分片顺序与各片扫描顺序：
     * 同一个 bbox 两次请求可能给出不同的字节（违背 §3.1 不变量 3），BIN 段也无法逐字节复现。
     * 这里统一按数值升序重排四个字典（重排只影响**顺序**，不影响任何内容），于是：
     *   · 合并结果与分片处理顺序无关（可复现）；
     *   · `nodePack.ids` 严格递增且无重复（§4.7 R16 要求的那条断言）；
     *   · 与"单库直出"的顺序**可能不同**（单库那些 ≥2^32 的键仍是插入顺序）——
     *     这只影响字节数（实测 z16 约 0.008%）、不影响解码后的几何，
     *     所以判据是"解码后逐字段相同"，不是逐字节相同（见 tests/region-shards-test.js）。
     */
    const nodesSorted = sortDictNumeric(nodes);
    const waysSorted = sortDictNumeric(ways);
    const relationsSorted = sortDictNumeric(relations);
    const truncation = this.mergeTruncation(parts, {
      nodes: nodesSorted, nodeTags, ways: waysSorted, relations: relationsSorted, lines, areas,
    });
    const pack = packOptsOf(opts.compact);
    const result = packQueryResult({
      nodes: nodesSorted, nodeTags, ways: waysSorted, relations: relationsSorted,
      truncation, totals, zoom: opts.zoom,
      complete: !!truncation.complete,
      viewOnly: !!(truncation.viewOnly && truncation.viewOnly.active),
      lines, areas, pack,
      coalesceOpts: coalesceOptsOf(effCoalesce),
      capsFlat: opts.flatCaps === true,
    });
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    return {
      result,
      bytes,
      truncation,
      complete: !!truncation.complete,
      conflicts,
      conflictTotal: conflicts.length,
      byShardConflicts,
      features: featureCounts({ ways, nodes, relations, displayLines: lines, displayAreas: areas }),
    };
  }

  /**
   * 合并各片的 `truncation`（§4.3 的四类规则），再把**结果侧**的条数按合并后的载荷重新数一遍。
   * 结果侧 = `truncation.payload.*` 与 `truncation.viewOnly.nodePayload.*`：
   * 它们的定义本来就是 `Object.keys(载荷字典).length`，所以去重之后必须重数，
   * 这样"开关开 vs 开关关"在同一个 bbox 上这几个数**逐字段相同**（验收判据 3）。
   */
  mergeTruncation(parts, merged) {
    const warn = (m) => console.warn('[regions] 账本合并：' + m);
    const keys = new Set();
    for (const p of parts) for (const k of Object.keys(p.res.truncation || {})) keys.add(k);
    const out = {};
    for (const k of keys) out[k] = mergeLedgerValues(parts.map((p) => p.res.truncation[k]), k, warn);
    // 结果侧：按合并后的载荷重数（去重之后才是真值）
    out.payload = {
      ways: Object.keys(merged.ways).length,
      nodes: Object.keys(merged.nodes).length,
      nodeTags: Object.keys(merged.nodeTags).length,
      relations: Object.keys(merged.relations).length,
      displayLines: merged.lines.length,
      displayLinePaths: merged.lines.reduce((n, l) => n + 1 + ((l.paths && l.paths.length) || 0), 0),
      displayAreas: merged.areas.length,
      displayAreaRings: merged.areas.reduce((n, a) => n + 1 + ((a.paths && a.paths.length) || 0), 0),
    };
    if (out.viewOnly && out.viewOnly.nodePayload) {
      out.viewOnly.nodePayload.nodes = Object.keys(merged.nodes).length;
      out.viewOnly.nodePayload.wayRefs = Object.keys(merged.ways).length;
    }
    if (!out.complete) out.hint = INCOMPLETE_HINT;
    return out;
  }

  /**
   * relation 的去重（**本阶段的显式规则**，见文件头「relations 的例外」）：
   *   ① bbox 非 NULL 优先（NULL 会被 relation_index 的 R*Tree 排除 ⇒ 那份副本"在空间索引里不存在"）
   *   ② bbox 面积更大优先   ③ 成员账本更全优先（memberTotal → kept）   ④ 属主片   ⑤ id 升序
   * version 不同时**先取 version 最大的一批**（文档规则 0），再在这批里用上面的判据。
   * bbox 从**基表 `relations`** 里点查（不用 relation_index：它的第 5 列在导入器里有已知笔误，
   * 见 osmdb.js 的 `_auditSpatialIndexes`）——只对"两片真的不一致"的 id 查，条数很少。
   */
  pickRelation(order, partOf, key) {
    const holders = order.filter((id) => partOf.get(id).relations[key] !== undefined);
    const versions = holders.map((id) => partOf.get(id).relations[key][0]);
    const maxV = Math.max(...versions);
    const byVersion = holders.filter((id) => partOf.get(id).relations[key][0] === maxV);
    const cands = byVersion.map((id) => {
      const row = partOf.get(id).relations[key];
      const crop = row[3] || {};
      return {
        id, row, bbox: this.relationBbox(id, Number(key)),
        memberTotal: Number(crop.memberTotal) || 0,
        kept: Array.isArray(row[1]) ? row[1].length : 0,
      };
    });
    cands.sort((a, b) => {
      const an = a.bbox ? 1 : 0;
      const bn = b.bbox ? 1 : 0;
      if (an !== bn) return bn - an;                       // ① 非 NULL 优先
      if (an && bn) {
        const aa = bboxArea(a.bbox);
        const ba = bboxArea(b.bbox);
        if (aa !== ba) return ba - aa;                     // ② 面积大者优先
      }
      if (a.memberTotal !== b.memberTotal) return b.memberTotal - a.memberTotal;   // ③ 成员账本更全
      if (a.kept !== b.kept) return b.kept - a.kept;
      return orderByOwner([a.id, b.id], this.registry.primary)[0] === a.id ? -1 : 1;   // ④⑤ 确定性
    });
    const win = cands[0];
    const allEmptyBbox = cands.every((c) => !c.bbox);
    return {
      picked: win.id,
      shards: holders,
      versions,
      bbox: win.bbox || null,
      kind: versions.some((v) => v !== versions[0]) ? 'version'
        : (allEmptyBbox ? 'same-version' : 'derived-bbox'),
      reason: versions.some((v) => v !== versions[0]) ? 'version-newer-wins'
        : (allEmptyBbox ? 'content-differs' : 'derived-bbox-extent-wins'),
    };
  }

  /**
   * 从某一片的 `nodes` 基表点查 version（**只在"同 id 坐标/标签不同"时才查**）：
   * 载荷里的节点行只有 `[lat, lon]`，没有 version，而文档规则 0 要求"先按 version 判"，
   * 所以冲突时按需回查一次基表 —— 冲突是极少见的，这一次点查不影响热路径。
   */
  nodeVersion(shardId, nodeId) {
    const rec = this.shards.get(shardId);
    if (!rec || !rec.db) return null;
    if (!rec.verStmt) {
      try { rec.verStmt = rec.db.raw.prepare('SELECT version FROM nodes WHERE id = ?'); } catch { rec.verStmt = false; }
    }
    if (!rec.verStmt) return null;
    try {
      const row = rec.verStmt.get(nodeId);
      return row && Number.isFinite(row.version) ? row.version : null;
    } catch {
      return null;
    }
  }

  /** 规则 0 的选择：version 最大者优先（并列或无 version 时取属主片，再按 id 升序）—— 确定性 */
  pickByVersionThenOwner(holders, versions) {
    const known = versions.filter((v) => v !== null && v !== undefined);
    if (known.length === versions.length) {
      const maxV = Math.max(...known);
      return orderByOwner(holders.filter((_, i) => versions[i] === maxV), this.registry.primary)[0];
    }
    return orderByOwner(holders, this.registry.primary)[0];
  }

  /** 从某一片的 `relations` 基表读派生 bbox（只对冲突 id 点查；结果缓存，避免重复查） */
  relationBbox(shardId, relId) {
    const rec = this.shards.get(shardId);
    if (!rec || !rec.db) return null;
    if (!rec.bboxStmt) {
      try {
        rec.bboxStmt = rec.db.raw.prepare('SELECT min_lon, max_lon, min_lat, max_lat FROM relations WHERE id = ?');
      } catch (err) {
        console.warn('[regions] 读分片 relation bbox 失败：' + err.message);
        rec.bboxStmt = false;
      }
    }
    if (!rec.bboxStmt) return null;
    try {
      const row = rec.bboxStmt.get(relId);
      if (!row || row.min_lon === null || row.max_lon === null || row.min_lat === null || row.max_lat === null) return null;
      return { minLon: row.min_lon, maxLon: row.max_lon, minLat: row.min_lat, maxLat: row.max_lat };
    } catch {
      return null;
    }
  }

  /**
   * 冲突**绝不静默**：一条 WARN（带样本）+ health 计数（明细在 truncation.regions[].conflicts）。
   * 只对**最终采用**的那一次合并调（见 build 里的说明）。
   */
  commitConflicts(conflicts, opts, order, skipped) {
    if (!conflicts.length) return;
    const byType = {};
    for (const c of conflicts) {
      byType[c.type] = (byType[c.type] || 0) + 1;
      this.stats.conflicts += 1;
      if (c.kind === 'same-version') this.stats.sameVersionConflicts += 1;
      else this.stats.derivedConflicts += 1;
      this.stats.lastConflict = { at: new Date().toISOString(), ...c };
    }
    const sample = conflicts.slice(0, 5).map((c) => `${c.type}#${c.id}(${c.shards.join('|')}→${c.picked})`);
    console.warn(`[regions] ⚠ 同 id 内容不同：${conflicts.length} 处`
      + `（${Object.entries(byType).map(([k, v]) => k + ' ' + v).join(' / ')}）`
      + ` · bbox=[${opts.minLon},${opts.minLat},${opts.maxLon},${opts.maxLat}] zoom=${opts.zoom}`
      + ` · 片=${order.join(',')}${skipped.length ? '（跳过 ' + skipped.map((s) => s.id).join(',') + '）' : ''}`
      + ` · 取属主片/派生量更全的那一份（绝不静默），明细见 truncation.regions[].conflicts（前 ${this.opts.conflictListMax} 条）`
      + ` · 例：${sample.join(' ')}`);
  }

  /* ------------------------------ 对外信息 ------------------------------ */

  /** `/api/health` 的 `regions` 块（设计 P0 的可验证产出：declared / opened / missing） */
  regionsInfo() {
    const opened = [...this.shards.values()].filter((r) => r.db);
    const out = {
      mode: this.mode,
      degraded: this.degraded,
      registry: path.relative(ROOT, this.opts.registryFile),
      declared: this.registry.list.length,
      opened: opened.length,
      missing: this.registry.missing || [],
      primary: this.registry.primary,
      primaryDerived: this.registry.primaryDerived === true,
      overlaps: this.registry.overlaps,
      registryGenerator: this.registry.generator || null,
      rectsUsed: this.registry.list.some((r) => r.rects && r.rects.length > 1),
      readOnlyShards: this.opts.readOnlyShards,
      fanoutMax: this.opts.fanoutMax,
      fallbackBelowZoom: this.opts.fallbackBelowZoom,
      mergedBytesLimit: this.opts.mergedBytesLimit,
      budgetTrowel: this.opts.budgetTrowel,
      fallbackDb: path.relative(ROOT, this.config.osmDb),
      writePath: 'single-db',
      shards: this.registry.list.map((r) => {
        const st = this.shards.get(r.id);
        return {
          id: r.id, name: r.name, file: path.relative(ROOT, r.file || ''), exists: r.exists,
          bbox: r.bbox, counts: r.counts, sizeBytes: r.sizeBytes,
          opened: !!(st && st.db), openMs: st ? st.openMs : null, queries: st ? st.queries : 0,
        };
      }),
      requests: {
        total: this.stats.requests, singleShard: this.stats.single, multiShard: this.stats.multi,
        fallbackLowZoom: this.stats.fallbackLowZoom, fallbackFanout: this.stats.fallbackFanout,
        fallbackNoHit: this.stats.fallbackNoHit, fallbackDegraded: this.stats.fallbackDegraded,
      },
      conflicts: {
        count: this.stats.conflicts,
        sameVersion: this.stats.sameVersionConflicts,
        derived: this.stats.derivedConflicts,
        last: this.stats.lastConflict,
      },
      bytesGateSkips: this.stats.bytesGateSkips,
      lastQuery: this.stats.lastQuery,
    };
    // P4：惰性建图的运行状态（**只有真的挂着世界时才出现**，见构造函数里的说明）
    if (this.lazyWorld) out.lazy = this.lazyWorld.info();
    else if (this.opts.lazyOn) out.lazy = { on: true, world: null, note: 'lazy 已配置但世界还没挂上（启动早期）' };
    return out;
  }

  /** 与 `OsmDB.info()` 同形（单库的信息）+ 一个 `regions` 块（只有分区开着时才存在） */
  info() {
    const base = this.fallback.info();
    return Object.assign({}, base, { regions: this.regionsInfo() });
  }

  /** 关掉单库 + 全部已打开的分片（只读分片直接 close 即可，没有要落盘的东西） */
  close() {
    if (this.lazyWorld) { try { this.lazyWorld.stop(); } catch { /* ignore */ } }
    for (const rec of this.shards.values()) {
      if (!rec.db) continue;
      try { rec.db.close(); } catch { /* ignore */ }
      rec.db = null;
    }
    this.fallback.close();
  }
}

/** way 行是否"内容相同"（version / 节点序列 / 标签 / 闭合标记 全等） */
function sameWayRow(a, b) {
  if (a[0] !== b[0] || a[3] !== b[3]) return false;
  if (!deepEqual(a[2], b[2])) return false;
  const ra = a[1];
  const rb = b[1];
  if (!Array.isArray(ra) || !Array.isArray(rb) || ra.length !== rb.length) return false;
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return false;
  return true;
}

/**
 * displayLines / displayAreas 条目 → 浅拷贝（打包会就地改 coords / 删 paths，
 * 所以合并结果里必须是自己的副本；`paths` 数组也要换一个，否则第一片的分片对象会被改到）。
 */
function copyDisplayEntry(e) {
  const out = Object.assign({}, e);
  if (Array.isArray(e.paths)) out.paths = e.paths.slice();
  return out;
}

/** 一片返回了多少东西（`truncation.regions[].features`） */
function featureCounts(res) {
  const len = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0));
  return {
    ways: len(res.ways),
    nodes: len(res.nodes),
    relations: len(res.relations),
    displayLines: len(res.displayLines),
    displayAreas: len(res.displayAreas),
  };
}

/**
 * 字典按 id **数值升序**重排（只改枚举顺序，不改内容）。
 * 见 build() 里的长注释：OSM id 超过 2^32 之后 `for…in` 不再保证数值升序，
 * 不重排的话"同一个 bbox 两次请求"可能给出不同字节。
 */
function sortDictNumeric(dict) {
  const keys = Object.keys(dict);
  if (keys.length < 2) return dict;
  const nums = keys.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return dict;      // 非数值键：原样返回（防御）
  const out = {};
  const order = nums.slice().sort((a, b) => a - b);
  for (const n of order) out[n] = dict[n];
  return out;
}

/* ==========================================================================
 * P4：按区域惰性建图 / 启动 / 卸载（deploy/REGIONS.md §7；跨区域寻路 §6.5.2 方案 C）
 *
 * ## 一句话
 * 分区**开**且 `lazy` 不为 false 时，`server/index.js` 不再为**整个数据集**建图，而是把
 * 铁路网 / 道路网 / 人口网格按**注册表里的区域矩形**切成若干份，**只为"激活"的区域建**，
 * 长时间不用的区域**卸载**（清空内部结构 + 丢引用）。
 *
 * ## 激活判据（§7.1，三者取并集）
 *      active(shard) := alwaysActive(shard)                 ← 注册表 rec.alwaysActive ∪ config.regions.lazyAlwaysActive
 *                     ∪ assetShards(shard)                  ← 车站（线路/车辆都挂在车站上，所以车站覆盖了它们）
 *                     ∪ viewportShards(在线玩家上报的视口)   ← 就是 #广播按需 那条现成信号，零新协议
 * 另外有一条**按需兜底**：站点吸附/寻路拿到的坐标若落在某个尚未激活的区域里，
 * 会**同步**建出那一区域的图（并记一行日志）—— 否则"玩家在那儿点了却告诉他没轨道"。
 *
 * ## 为什么不能拼图（§6.5.1，本设计最硬的一条禁令）
 * `VIRTUAL_NODE_ID = -1` 且虚拟 id = `-1 - _vnodeSeq++` ⇒ **每个 RailGraph 实例都从 −1 开始编号**，
 * 两个实例的虚拟路口 id **必然全撞**；投影基准 `_kx` 也各按自己的第一条路段取。
 * 所以这里**只做"选一张图"**，绝不把两张图的 `nodes` / `wayInfo` 并起来用；
 * 跨区域寻路一律走 §6.5.2 方案 C：按**走廊 bbox 新建一张** RailGraph，在它上面跑完整的
 * `routeThrough`（正确性由构造保证：完整的走廊数据 → 一张完整的图 → 与单片完全同源）。
 *
 * ## 卸载（§7.2 / R33）
 * `idle → unloading` 走 `RailGraph#dispose()`（清空内部结构、段平行数组置 null），
 * 然后把引用丢掉交给 GC。**资产片与 alwaysActive 永不卸载**（R28：否则一次 tick 要等重建）。
 * 如实说明：`dispose()` 之后 **RSS 不一定立刻下降**（V8 不急着把页还给 OS）——
 * 这一点在测试里用"内部结构确实空了 + 能重新建起来"来断言，不拿 RSS 当判据。
 *
 * ## 与开关关着时的关系（**这是本文件的硬约束**）
 * `opts.lazyOn === false`（= `mode:'off'`，或者显式 `lazy:false`）时：
 * `createRegionGraphSource` 返回 **null**，`server/index.js` 照旧 `new RailGraph(db, {mode})`，
 * 下面这些代码**一行都不会被执行** —— 关闭时的行为与改动前逐字节相同。
 * ======================================================================== */

/** 一张图属于哪一种路网（与 transit.js 的 graphFor 同一口径） */
const GRAPH_MODES = ['rail', 'bus'];
const lineGraphMode = (kind) => (kind === 'bus' ? 'bus' : 'rail');
/** 每纬度 / 每经度多少米（与 railgraph.js 里的近似一致，只为算 pad 与 bbox） */
const M_PER_DEG_LAT_P4 = 110574;
const M_PER_DEG_LON_P4 = 111320;

function bboxOfRect(r) {
  if (!r) return null;
  const b = {
    minLon: Number(r.minLon !== undefined ? r.minLon : r.min_lon),
    minLat: Number(r.minLat !== undefined ? r.minLat : r.min_lat),
    maxLon: Number(r.maxLon !== undefined ? r.maxLon : r.max_lon),
    maxLat: Number(r.maxLat !== undefined ? r.maxLat : r.max_lat),
  };
  return [b.minLon, b.minLat, b.maxLon, b.maxLat].every(Number.isFinite) ? b : null;
}

function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / M_PER_DEG_LAT_P4;
  const cos = Math.max(0.1, Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180));
  const dLon = radiusM / (M_PER_DEG_LON_P4 * cos);
  return {
    minLat: Math.max(-90, lat - dLat), maxLat: Math.min(90, lat + dLat),
    minLon: Math.max(-180, lon - dLon), maxLon: Math.min(180, lon + dLon),
  };
}

const bboxHit = (a, b) => !!a && !!b
  && a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;

/** outer 完全包含 inner（走廊能不能直接复用某一张区域图，就靠它判） */
const bboxCovers = (outer, inner) => !!outer && !!inner
  && outer.minLon <= inner.minLon && outer.maxLon >= inner.maxLon
  && outer.minLat <= inner.minLat && outer.maxLat >= inner.maxLat;

/** 矩形按步长量化成缓存键（避免玩家/线路轻微抖动就无限建图） */
function quantKeyOf(b, step) {
  const q = (v) => Math.round(v / step) * step;
  return `${q(b.minLon).toFixed(4)},${q(b.minLat).toFixed(4)},${q(b.maxLon).toFixed(4)},${q(b.maxLat).toFixed(4)}`;
}

/**
 * 矩形**向外**量化：min 向下取整、max 向上取整。
 * 缓存命中时返回的图是**同一把键**建出来的，所以建图与查键必须用同一个矩形 ——
 * 而且必须是"向外取整"的那个（保证缓存里的图**始终覆盖**这一次请求的走廊，绝不比它小）。
 */
function quantBboxOutward(b, step) {
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return b;
  const f = (v) => Math.floor(v / s) * s;
  const c = (v) => Math.ceil(v / s) * s;
  const q = { minLon: f(b.minLon), minLat: f(b.minLat), maxLon: c(b.maxLon), maxLat: c(b.maxLat) };
  if (!(q.minLon < q.maxLon && q.minLat < q.maxLat)) return b;
  return q;
}

function padBbox(b, padMeters) {
  const dLat = padMeters / M_PER_DEG_LAT_P4;
  const cos = Math.max(0.1, Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180));
  const dLon = padMeters / (M_PER_DEG_LON_P4 * cos);
  return {
    minLat: Math.max(-90, b.minLat - dLat), maxLat: Math.min(90, b.maxLat + dLat),
    minLon: Math.max(-180, b.minLon - dLon), maxLon: Math.min(180, b.maxLon + dLon),
  };
}

/**
 * 一张区域图 / 走廊图 / 点图 的构造：都是**独立的** RailGraph 实例，
 * 只是 `_st.railWays` 被 `options.bbox` 限定在矩形内（见 railgraph.js 的说明）。
 */
function makeScopedGraph(db, mode, bbox) {
  return new RailGraph(db, { mode, bbox: normalizeScopeBbox(bbox) });
}

/* --------------------------------------------------------------------------
 * RegionLazyWorld：区域图集合的生命周期（建 / 用 / 卸）+ 激活集
 * ------------------------------------------------------------------------ */

class RegionLazyWorld {
  /**
   * @param db      那个单库（`RegionDB`，其 `prepare` 转发给 fallback）—— 图的**唯一数据来源**
   * @param options `{ registry, opts, buildGraph, population, populationMode, needsBusGraph,
   *                   onPathsStale, linesOf }`
   *   · `buildGraph(graph, o)` = `server/index.js` 的 **切片建图**（异步、不锁事件循环，§7.2 要求必须走它）；
   *     不传就退回 `graph.build()`（同步、会锁事件循环 —— 只在没有切片入口时才这样）
   *   · `linesOf()` 返回 `[{ kind, nodeIds }]`：用来在后台**预热走廊图**（§6.5.2），
   *     省掉"第一次重建线路路径时同步建走廊图"的那一下卡顿
   */
  constructor(db, options = {}) {
    this.db = db;
    this.registry = options.registry;
    this.opts = options.opts || {};
    this.buildGraph = typeof options.buildGraph === 'function' ? options.buildGraph : null;
    this.population = options.population || null;
    this.populationMode = options.populationMode || 'skip';     // 'region' = 只对激活区域 buildRegion
    this.needsBusGraph = typeof options.needsBusGraph === 'function' ? options.needsBusGraph : (() => true);
    this.onPathsStale = typeof options.onPathsStale === 'function' ? options.onPathsStale : (() => {});
    this.linesOf = typeof options.linesOf === 'function' ? options.linesOf : null;
    this.modeOn = this.opts.lazyOn === true;

    /** mode → (shardId → slot)；slot = {state, graph, builtMs, stats, lastUsedAt, unloads} */
    this.graphs = { rail: new Map(), bus: new Map() };
    /** 点图缓存：mode → (量化键 → { graph, at }) */
    this.points = { rail: new Map(), bus: new Map() };
    /** 走廊图缓存（§6.5.2）：mode → (量化键 → { graph, at, key, bbox }) + LRU 顺序 */
    this.corridors = { rail: new Map(), bus: new Map() };
    this.corridorOrder = [];
    /** 激活输入 */
    this.alwaysActive = new Set(
      (this.registry.list || []).filter((r) => r.alwaysActive === true).map((r) => r.id)
        .concat(this.opts.lazyAlwaysActive || [])
    );
    this.assetShards = new Set();
    this.viewports = new Map();
    this.popDone = new Set();
    this.active = new Set();
    this.stats = {
      builds: 0, buildMs: 0, unloads: 0, syncBuilds: 0, syncBuildMs: 0,
      pointBuilds: 0, corridorBuilds: 0, corridorReuse: 0, corridorHits: 0,
      corridorSyncBuilds: 0, populationBuilds: 0, populationMs: 0,
      updateWayCalls: 0, errors: 0, lastError: null, lastBuild: null, lastUnload: null,
      startedAt: Date.now(),
    };
    this._st = {};
    this._timer = null;
    this._kickTimer = null;
    this._queue = Promise.resolve();
    this._pathsTimer = null;
    this._stopped = false;
  }

  /* --------------------------- 小工具 --------------------------- */

  log(msg) { if (this.opts.lazyLog) console.log(`[regions.lazy] ${msg}`); }
  warn(msg) { console.warn(`[regions.lazy] ⚠ ${msg}`); }

  _stmt(key, sql) {
    if (!this._st[key]) this._st[key] = this.db.prepare(sql);
    return this._st[key];
  }

  /** 这个坐标落在哪一片的矩形里（注册表矩形，**不是** data_bbox —— §3.6 明令） */
  shardOf(lat, lon) {
    const la = Number(lat); const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    for (const rec of this.registry.list) {
      for (const rect of (rec.rects && rec.rects.length ? rec.rects : [rec.bbox])) {
        const b = bboxOfRect(rect);
        if (!b) continue;
        if (lo >= b.minLon && lo <= b.maxLon && la >= b.minLat && la <= b.maxLat) return rec.id;
      }
    }
    return null;
  }

  /** 与给定矩形相交的所有片 id（注册表矩形，O(N)，N ≤ 64；§3.2 的规矩） */
  shardsInBbox(bbox) {
    const out = [];
    if (!bbox) return out;
    for (const rec of this.registry.list) {
      for (const rect of (rec.rects && rec.rects.length ? rec.rects : [rec.bbox])) {
        const b = bboxOfRect(rect);
        if (b && bboxHit(b, bbox)) { out.push(rec.id); break; }
      }
    }
    return out;
  }

  slot(mode, id) {
    const m = this.graphs[mode];
    let s = m.get(id);
    if (!s) {
      s = {
        id, mode, state: 'absent', graph: null, builtMs: 0, stats: null,
        lastUsedAt: 0, unloads: 0, used: 0, error: null,
      };
      m.set(id, s);
    }
    return s;
  }

  readyGraphs(mode) {
    const out = [];
    for (const s of this.graphs[mode].values()) if (s.state === 'ready' && s.graph) out.push(s.graph);
    return out;
  }

  /**
   * 按**正 id**（OSM node id）在就绪区域图里找节点。
   * 负 id（虚拟路口）**一定返回 undefined**：虚拟 id 每个图实例都从 −1 起算，跨实例不是全局唯一的，
   * "并集"里出现它必然指向另一张图的错误节点（§6.5.1 那条禁令的运行时守卫）。
   */
  nodeAt(mode, id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n < 0) return undefined;
    for (const g of this.readyGraphs(mode)) {
      const node = g.nodes.get(n);
      if (node) return node;
    }
    return undefined;
  }

  wayInfoCount(mode) {
    let n = 0;
    for (const g of this.readyGraphs(mode)) n += g.wayInfo.size;
    return n;
  }

  wayInfoGet(mode, id) {
    const w = Number(id);
    for (const g of this.readyGraphs(mode)) {
      const info = g.wayInfo.get(w);
      if (info) return info;
    }
    return undefined;
  }

  isPermanent(id) { return this.alwaysActive.has(id) || this.assetShards.has(id); }

  /* --------------------------- 激活集 --------------------------- */

  /** 车站所在片（线路/车辆都挂在车站上 ⇒ 车站覆盖了它们；这是一次 `stations` 全表读，几十~几千行） */
  refreshAssets() {
    const set = new Set();
    try {
      const rows = this._stmt('stationsLatLon',
        'SELECT lat, lon FROM stations WHERE lat IS NOT NULL AND lon IS NOT NULL').all();
      for (const r of rows) {
        const id = this.shardOf(r.lat, r.lon);
        if (id) set.add(id);
      }
    } catch { /* 没有 stations 表（纯 OSM 库）就算了：那样资产集就是空集 */ }
    this.assetShards = set;
    return set;
  }

  activeShards() {
    const out = new Set(this.alwaysActive);
    for (const id of this.assetShards) out.add(id);
    for (const b of this.viewports.values()) for (const id of this.shardsInBbox(b)) out.add(id);
    return out;
  }

  noteViewport(userId, view) {
    if (!this.modeOn || !view) return;
    const lat = Number(view.lat); const lon = Number(view.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const radiusM = Math.max(200, Math.min(200000, Number(view.radiusM) || 12000));
    this.viewports.set(String(userId), bboxAround(lat, lon, radiusM));
    this.kick();
  }

  dropViewport(userId) {
    if (!this.modeOn) return;
    if (this.viewports.delete(String(userId))) this.kick();
  }

  /** 激活集变了：安排一次很快的巡检（200 ms 去抖） */
  kick() {
    if (this._stopped || this._kickTimer) return;
    this._kickTimer = setTimeout(() => { this._kickTimer = null; this.sweep(); }, 200);
    if (this._kickTimer.unref) this._kickTimer.unref();
  }

  /* --------------------------- 建图 --------------------------- */

  /**
   * 异步建一片的图（**走切片建图**，每片之间让出事件循环，§7.2 的硬要求）。
   * 所有建图都排在同一条 promise 链上：同一时刻只有一次建图在跑（避免几个大图同时抢事件循环）。
   */
  ensureAsync(mode, id) {
    const slot = this.slot(mode, id);
    if (slot.state === 'ready' || slot.state === 'building') return this._queue;
    const rec = this.registry.byId.get(id);
    if (!rec) return this._queue;
    slot.state = 'building';
    slot.error = null;
    const run = async () => {
      if (this._stopped) { slot.state = 'absent'; return; }
      const t0 = Date.now();
      try {
        const g = makeScopedGraph(this.db, mode, rec.bbox);
        const stats = this.buildGraph
          ? await this.buildGraph(g, { estimateMs: mode === 'bus' ? 20000 : 1500 })
          : g.build();
        if (slot.state === 'ready' && slot.graph) {
          // 同步兜底路径抢先建好了：这张异步图是多余的一份，直接放掉（绝不两张图同时留着）
          g.dispose();
          return;
        }
        slot.graph = g;
        slot.state = 'ready';
        slot.stats = stats;
        slot.builtMs = Date.now() - t0;
        slot.lastUsedAt = Date.now();
        this.stats.builds += 1;
        this.stats.buildMs += slot.builtMs;
        this.stats.lastBuild = { mode, id, ms: slot.builtMs, ways: stats.ways, nodes: stats.nodes, at: new Date().toISOString() };
        this.log(`建图 ${mode} · 区域 ${id}（${rec.name || id}）：${stats.ways} 条 way / ${stats.nodes} 个节点`
          + ` · ${slot.builtMs} ms${this.buildGraph ? '（切片）' : '（同步 build()）'}`);
        /**
         * 任何一个模式的图就绪都可能是"上一条线路算不出路径"的原因（铁路图管铁路线、道路图管公交线），
         * 所以**两种模式都**踢一次路径重算（去抖 300 ms，`onRailChanged()` 本身是幂等的）。
         */
        this.markPathsStale();
      } catch (err) {
        slot.state = 'absent';
        slot.graph = null;
        slot.error = err.message;
        this.stats.errors += 1;
        this.stats.lastError = { mode, id, message: err.message, at: new Date().toISOString() };
        this.warn(`建图失败 ${mode} · 区域 ${id}：${err.message}`);
      }
    };
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  /**
   * **同步**建一片的图：只走"按需兜底"（玩家点了还没建的区域，或寻路必须立刻拿到图）。
   * 这会**阻塞事件循环** `build()` 那么久 —— 所以一定打日志，并如实记进 `stats.syncBuilds/syncBuildMs`。
   */
  ensureSync(mode, id) {
    const slot = this.slot(mode, id);
    if (slot.state === 'ready' && slot.graph) { slot.lastUsedAt = Date.now(); slot.used += 1; return slot.graph; }
    const rec = this.registry.byId.get(id);
    if (!rec) return null;
    const t0 = Date.now();
    try {
      const g = makeScopedGraph(this.db, mode, rec.bbox);
      const stats = g.build();
      slot.graph = g;
      slot.state = 'ready';
      slot.stats = stats;
      slot.builtMs = Date.now() - t0;
      slot.lastUsedAt = Date.now();
      slot.used += 1;
      this.stats.syncBuilds += 1;
      this.stats.syncBuildMs += slot.builtMs;
      this.log(`**同步**建图（按需兜底）${mode} · 区域 ${id}：${stats.ways} 条 way / ${stats.nodes} 个节点`
        + ` · ${slot.builtMs} ms —— 这一段时间事件循环被占住`);
      if (slot.builtMs > 2000) {
        this.warn(`同步建图 ${slot.builtMs} ms 偏长（${mode} · ${id}）：说明这个坐标的视口/资产还没有把该区域预热起来`);
      }
      this.markPathsStale();
      return g;
    } catch (err) {
      slot.state = 'absent';
      slot.error = err.message;
      this.stats.errors += 1;
      this.stats.lastError = { mode, id, message: err.message, at: new Date().toISOString() };
      this.warn(`同步建图失败 ${mode} · 区域 ${id}：${err.message}`);
      return null;
    }
  }

  /** 节点坐标（走廊 bbox 要用；**不按区域限定**：走廊本来就可能跨区域） */
  nodeCoord(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    try { return this._stmt('nodeLatLon', 'SELECT lat, lon FROM nodes WHERE id = ? AND deleted = 0').get(n) || null; } catch { return null; }
  }

  /** 一组节点 id → 走廊 bbox（所有节点的 bbox，每边外扩 `pad`；pad ≥ 相邻站点最大间距 × 1.5，§6.5.2） */
  corridorBboxOf(nodeIds) {
    let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
    const pts = [];
    for (const id of nodeIds || []) {
      const p = this.nodeCoord(id);
      if (!p) continue;
      pts.push(p);
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    if (pts.length < 2) return null;
    // 相邻站点最大间距（按给定的顺序，含 loop 的收尾重复点）—— pad 至少是它的 1.5 倍
    let maxGapM = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]; const b = pts[i];
      const dx = (b.lon - a.lon) * M_PER_DEG_LON_P4 * Math.cos((a.lat * Math.PI) / 180);
      const dy = (b.lat - a.lat) * M_PER_DEG_LAT_P4;
      maxGapM = Math.max(maxGapM, Math.sqrt(dx * dx + dy * dy));
    }
    const pad = Math.min(200000, Math.max(this.opts.corridorPadMeters, maxGapM * 1.5));
    const stopBbox = { minLat, maxLat, minLon, maxLon };
    return { bbox: padBbox(stopBbox, pad), padMeters: Math.round(pad), stopBbox };
  }

  /**
   * 走廊图（§6.5.2 方案 C）：按走廊 bbox **新建**一张图；TTL + LRU 缓存。
   * 缓存键与**建图用的矩形**都是"向外量化"后的那一个（`quantBboxOutward`）——
   * 同一个键永远对应用同一张图，且那张图覆盖请求的走廊。
   */
  corridorGraphSync(mode, bbox) {
    const use = quantBboxOutward(bbox, this.opts.corridorQuantDeg);
    const key = `${mode}|${quantKeyOf(use, this.opts.corridorQuantDeg)}`;
    const cache = this.corridors[mode];
    const hit = cache.get(key);
    if (hit && (this.opts.corridorTtlMs <= 0 || Date.now() - hit.at < this.opts.corridorTtlMs)) {
      this.stats.corridorHits += 1;
      hit.at = Date.now();
      this.touchCorridor(key);
      return hit.graph;
    }
    if (hit) { hit.graph.dispose(); cache.delete(key); }
    const t0 = Date.now();
    const g = makeScopedGraph(this.db, mode, use);
    const stats = g.build();
    const ms = Date.now() - t0;
    cache.set(key, { graph: g, at: Date.now(), key, bbox: use, ms, ways: stats.ways, nodes: stats.nodes });
    this.touchCorridor(key);
    this.stats.corridorBuilds += 1;
    this.stats.corridorSyncBuilds += 1;
    if (ms > 1000) {
      this.warn(`走廊建图 ${ms} ms 偏长（${mode} · ${key}）：跨区域建线时这一段会阻塞事件循环`
        + `（${stats.ways} 条 way / ${stats.nodes} 个节点）`);
    } else {
      this.log(`走廊建图 ${mode} · ${key}：${stats.ways} 条 way / ${stats.nodes} 个节点 · ${ms} ms`
        + `（不是拼图：这是一张新的 RailGraph，虚拟路口 id 从 −1 重新起算）`);
    }
    // LRU 上限
    while (this.corridorOrder.length > Math.max(1, this.opts.corridorMax)) {
      const old = this.corridorOrder.shift();
      for (const m of GRAPH_MODES) {
        const e = this.corridors[m].get(old);
        if (e && e.key !== key) { e.graph.dispose(); this.corridors[m].delete(old); }
      }
    }
    return g;
  }

  touchCorridor(key) {
    const at = this.corridorOrder.indexOf(key);
    if (at >= 0) this.corridorOrder.splice(at, 1);
    this.corridorOrder.push(key);
  }

  /** 走廊图是否已有可用的（后台预热用，不建） */
  corridorReady(mode, bbox) {
    const use = quantBboxOutward(bbox, this.opts.corridorQuantDeg);
    const key = `${mode}|${quantKeyOf(use, this.opts.corridorQuantDeg)}`;
    const hit = this.corridors[mode].get(key);
    if (!hit) return null;
    if (this.opts.corridorTtlMs > 0 && Date.now() - hit.at >= this.opts.corridorTtlMs) return null;
    return hit.graph;
  }

  /** 点图（坐标不落在任何区域矩形内时的兜底）：按点周围 `pointGraphRadiusM` 建一张 */
  pointGraphSync(mode, lat, lon) {
    const bbox = quantBboxOutward(bboxAround(lat, lon, this.opts.pointGraphRadiusM), this.opts.corridorQuantDeg);
    const key = `${mode}|${quantKeyOf(bbox, this.opts.corridorQuantDeg)}`;
    const cache = this.points[mode];
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < Math.max(60000, this.opts.corridorTtlMs)) { hit.at = Date.now(); return hit.graph; }
    if (hit) { hit.graph.dispose(); cache.delete(key); }
    const t0 = Date.now();
    const g = makeScopedGraph(this.db, mode, bbox);
    const stats = g.build();
    const ms = Date.now() - t0;
    cache.set(key, { graph: g, at: Date.now(), ms });
    while (cache.size > 8) {
      const first = cache.keys().next().value;
      const e = cache.get(first);
      if (e) e.graph.dispose();
      cache.delete(first);
    }
    this.stats.pointBuilds += 1;
    this.log(`点图兜底建图 ${mode}（坐标不在任何区域矩形内）：${stats.ways} 条 way · ${ms} ms`
      + `（半径 ${Math.round(this.opts.pointGraphRadiusM / 1000)} km）`);
    return g;
  }

  /* --------------------------- 取图 --------------------------- */

  /**
   * 按坐标取"属于这个坐标的那一张图"：
   *   1. 坐标落在某片矩形内 → 那一片的图（没建就**同步**建出来，并记日志）；
   *   2. 落在所有矩形之外 → 点图兜底。
   * 返回的一定是**一个 RailGraph 实例**（绝不返回多张图的并集）。
   */
  graphAt(mode, lat, lon) {
    const id = this.shardOf(lat, lon);
    if (id) {
      const g = this.ensureSync(mode, id);
      if (g) return g;
    }
    return this.pointGraphSync(mode, lat, lon);
  }

  /**
   * **跨区域寻路**（§6.5.2）：
   *   · **所有站点**都落在**同一张已就绪的区域图**的矩形内 ⇒ 直接复用那张图（零建图代价）。
   *     ⚠ 已知近似（§6.6 R27）：那条线路的最优路径若绕出该区域就可能算不到 ⇒ 里程偏大。
   *     这是"惰性建图"的固有取舍：**要看范围就得多建图**。要严格按走廊算：
   *     把注册表的矩形划小（一条线跨片就必然走走廊图）。
   *   · 否则按**走廊 bbox**（站点 bbox + pad，见 corridorBboxOf）**新建一张**临时图（方案 C；禁止拼图）；
   *   · `corridorGraph:false` ⇒ 跨区域直接报错（如实说明原因，不静默给一条错的路径）。
   * 返回 `{ graph, route, reused?, corridor? }`，或 `{ error }`。
   */
  routeFor(mode, nodeIds) {
    const ids = (nodeIds || []).map(Number).filter((n) => Number.isFinite(n));
    if (ids.length < 2) return { graph: null, route: { error: '至少需要 2 个车站才能寻路' } };
    if (!this.modeOn) return null;
    const cb = this.corridorBboxOf(ids);
    if (!cb) return { graph: null, route: { error: '车站的坐标取不到（节点不在库里）' } };
    // ① 站点全在同一张就绪区域图的矩形内 ⇒ 复用
    for (const s of this.graphs[mode].values()) {
      if (s.state !== 'ready' || !s.graph) continue;
      const rec = this.registry.byId.get(s.id);
      if (!rec) continue;
      const rects = (rec.rects && rec.rects.length ? rec.rects : [rec.bbox]).map(bboxOfRect).filter(Boolean);
      if (rects.some((r) => bboxCovers(r, cb.stopBbox))) {
        this.stats.corridorReuse += 1;
        s.lastUsedAt = Date.now(); s.used += 1;
        return { graph: s.graph, route: s.graph.routeThrough(ids), reused: true, corridorShard: s.id, corridor: cb };
      }
    }
    if (!this.opts.corridorGraph) {
      const anyReady = this.readyGraphs(mode)[0] || null;
      return {
        graph: anyReady,
        route: {
          error: '这条线路跨出了单个区域，而 `regions.corridorGraph` 被关掉了'
            + '（默认开启：按走廊 bbox 新建一张临时图，见 deploy/REGIONS.md §6.5.2 方案 C）',
        },
        corridor: cb, refused: true,
      };
    }
    const g = this.corridorGraphSync(mode, cb.bbox);
    const use = quantBboxOutward(cb.bbox, this.opts.corridorQuantDeg);
    return {
      graph: g, route: g.routeThrough(ids), corridor: cb,
      corridorBuild: this.corridors[mode].get(`${mode}|${quantKeyOf(use, this.opts.corridorQuantDeg)}`) || null,
    };
  }

  /* --------------------------- 人口网格 --------------------------- */

  /** 只为激活区域算人口网格（幂等：population.buildRegion 内部逐 way 先减后加） */
  ensurePopulation(id) {
    if (this.populationMode !== 'region' || !this.population || this.popDone.has(id)) return this._queue;
    const rec = this.registry.byId.get(id);
    if (!rec || !rec.bbox) return this._queue;
    this.popDone.add(id);
    const run = async () => {
      const t0 = Date.now();
      try {
        const st = this.population.buildRegion(rec.bbox);
        this.stats.populationBuilds += 1;
        this.stats.populationMs += st.ms;
        this.log(`人口网格 · 区域 ${id}：${st.ways} 个地块 → 网格 ${st.cellsBefore} → ${st.cellsAfter} 格`
          + `（全库 ${st.population} 人 / ${st.jobs} 岗位 · 本区域 ${st.ms} ms）`);
      } catch (err) {
        this.popDone.delete(id);
        this.stats.errors += 1;
        this.stats.lastError = { id, message: err.message, at: new Date().toISOString() };
        this.warn(`人口网格 · 区域 ${id} 失败：${err.message}`);
      }
      // onPathsStale 不在这里触发：网格变了 transit 自己按 version 失效缓存
      return t0;
    };
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  /* --------------------------- 卸载 --------------------------- */

  /** 卸掉一片的图：`dispose()`（清空内部结构）+ 丢引用等 GC。**永不卸资产片/alwaysActive** */
  unload(mode, id, reason) {
    const slot = this.slot(mode, id);
    if (slot.state !== 'ready' || !slot.graph) return false;
    if (this.isPermanent(id)) return false;
    const g = slot.graph;
    const info = {
      mode, id, reason: reason || 'idle',
      ways: g.wayCount, nodes: g.nodes.size, edges: g.edgeCount,
      builtMs: slot.builtMs, idleMs: Date.now() - (slot.lastUsedAt || 0),
      used: slot.used,
    };
    g.dispose();
    slot.graph = null;
    slot.state = 'absent';
    slot.unloads += 1;
    this.stats.unloads += 1;
    this.stats.lastUnload = Object.assign({ at: new Date().toISOString() }, info);
    this.log(`卸载 ${mode} · 区域 ${id}（${reason || 'idle'}）：释放 ${info.ways} 条 way / ${info.nodes} 个节点`
      + `（空闲 ${Math.round(info.idleMs / 1000)} s · 被用过 ${info.used} 次 · 重建预计 ${info.builtMs} ms）`
      + ' —— RSS 不一定立刻下降（V8 不急着把页还给 OS），下一次用到这个区域时会重建');
    /**
     * ⚠ 这里**故意不**调 `markPathsStale()`：线路路径是**存在库里的节点 id 列表**，
     * 它不依赖图是否常驻 —— 卸载不改变任何已有路径。反过来若在这里触发全量重建，
     * 反而会把"跨区域线路"推去建走廊图，用一张近似的图覆盖掉原来正确的路径。
     * 只有"某个区域的图**建好了**"才需要重算（那是为了让之前算不出来的线路有机会成功）。
     */
    return true;
  }

  /** 巡检：重算激活集 → 建缺失的 → 卸空闲的（§7.2 的状态机就靠这个循环驱动） */
  sweep() {
    if (!this.modeOn || this._stopped) return;
    this.refreshAssets();
    const active = this.activeShards();
    this.active = active;
    const busWanted = this.busWanted();
    for (const id of active) {
      this.ensureAsync('rail', id);
      if (busWanted) this.ensureAsync('bus', id);
      this.ensurePopulation(id);
    }
    if (this.opts.lazyIdleMs > 0) {
      const now = Date.now();
      for (const mode of GRAPH_MODES) {
        for (const slot of [...this.graphs[mode].values()]) {
          if (slot.state !== 'ready' || !slot.graph) continue;
          if (active.has(slot.id) || this.isPermanent(slot.id)) continue;
          if (now - (slot.lastUsedAt || 0) < this.opts.lazyIdleMs) continue;
          this.unload(mode, slot.id, 'idle');
        }
      }
    }
    return active;
  }

  busWanted() {
    try { return !!this.needsBusGraph(); } catch { return true; }
  }

  /** 线路路径该重算了（去抖 300 ms —— 一次建图可能连着动好几个区域） */
  markPathsStale() {
    if (this._stopped) return;
    if (this._pathsTimer) return;
    this._pathsTimer = setTimeout(() => {
      this._pathsTimer = null;
      try { this.onPathsStale(); } catch (err) { this.warn(`线路路径重算失败：${err.message}`); }
    }, 300);
    if (this._pathsTimer.unref) this._pathsTimer.unref();
  }

  /** 启动：把"启动激活集"（alwaysActive ∪ assetShards）的图建好（走切片建图，await） */
  async activateStartup() {
    this.refreshAssets();
    const set = new Set(this.alwaysActive);
    for (const id of this.assetShards) set.add(id);
    this.active = set;
    const busWanted = this.busWanted();
    this.log(`启动激活集：${set.size ? [...set].join(', ') : '（空）'}`
      + `（alwaysActive ${this.alwaysActive.size} 片 + 资产片 ${this.assetShards.size} 片；`
      + `道路网${busWanted ? '需要（有公交线路）' : '不需要（没有公交线路）'}）`);
    for (const id of set) {
      await this.ensureAsync('rail', id);
      if (busWanted) await this.ensureAsync('bus', id);
    }
    return { shards: [...set], busWanted };
  }

  /** 启动：只为启动激活集算人口网格（populationMode==='region' 时才做） */
  async populationStartup() {
    if (this.populationMode !== 'region') return null;
    const out = [];
    for (const id of this.active) {
      if (this.popDone.has(id)) continue;
      await this.ensurePopulation(id);
      out.push(id);
    }
    return out;
  }

  /**
   * 后台预热走廊图（§6.5.2 的"必须先建好，否则第一次重建线路路径会同步卡住"）：
   * 用**切片建图**把每条线路的走廊图建好，`await` 在 init 的 regions 阶段里跑（不进 /api/ready 的判据）。
   */
  async warmupCorridors() {
    if (!this.linesOf || !this.opts.corridorGraph) return { built: 0, skipped: 0 };
    let lines = [];
    try { lines = this.linesOf() || []; } catch (err) { this.warn(`取线路失败：${err.message}`); return { built: 0, skipped: 0 }; }
    let built = 0; let skipped = 0;
    for (const line of lines) {
      const mode = lineGraphMode(line.kind);
      if (mode === 'bus' && !this.busWanted()) { skipped += 1; continue; }
      const cb = this.corridorBboxOf(line.nodeIds || []);
      if (!cb) { skipped += 1; continue; }
      // 站点全在同一张已就绪的区域图里 ⇒ 不用建走廊（routeFor 会直接复用）
      let covered = false;
      for (const s of this.graphs[mode].values()) {
        if (s.state !== 'ready' || !s.graph) continue;
        const rec = this.registry.byId.get(s.id);
        if (!rec) continue;
        const rects = (rec.rects && rec.rects.length ? rec.rects : [rec.bbox]).map(bboxOfRect).filter(Boolean);
        if (rects.some((r) => bboxCovers(r, cb.stopBbox))) { covered = true; break; }
      }
      if (covered) { skipped += 1; continue; }
      if (this.corridorReady(mode, cb.bbox)) { skipped += 1; continue; }
      const use = quantBboxOutward(cb.bbox, this.opts.corridorQuantDeg);
      const key = `${mode}|${quantKeyOf(use, this.opts.corridorQuantDeg)}`;
      if (this.corridors[mode].has(key)) { skipped += 1; continue; }
      const t0 = Date.now();
      const g = makeScopedGraph(this.db, mode, use);
      const stats = this.buildGraph
        ? await this.buildGraph(g, { estimateMs: mode === 'bus' ? 20000 : 1500 })
        : g.build();
      const ms = Date.now() - t0;
      this.corridors[mode].set(key, { graph: g, at: Date.now(), key, bbox: use, ms, ways: stats.ways, nodes: stats.nodes });
      this.touchCorridor(key);
      this.stats.corridorBuilds += 1;
      built += 1;
      this.log(`预热走廊图 ${mode}（线路 ${line.id}）：${stats.ways} 条 way / ${stats.nodes} 个节点 · ${ms} ms`
        + `（切片建图，不锁事件循环；虚拟路口 id 从 −1 重新起算 —— 这是新的一张图，不是拼图）`);
      while (this.corridorOrder.length > Math.max(1, this.opts.corridorMax)) {
        const old = this.corridorOrder.shift();
        for (const m of GRAPH_MODES) {
          const e = this.corridors[m].get(old);
          if (e) { e.graph.dispose(); this.corridors[m].delete(old); }
        }
      }
    }
    return { built, skipped };
  }

  /** way 的物化 bbox（`updateWay` 判断"这一改是否落在某张区域图的范围内"用；NULL ⇒ 一律算落在范围内） */
  wayBbox(id) {
    try {
      const r = this._stmt('wayBbox',
        'SELECT min_lat, max_lat, min_lon, max_lon, deleted FROM ways WHERE id = ?').get(Number(id));
      return r || null;
    } catch { return null; }
  }

  /** 给定的 way bbox 是否与这一片的矩形相交（与建图时用的 SQL 判据同一口径：NULL 一律收录） */
  wayInShard(id, box) {
    const rec = this.registry.byId.get(id);
    if (!rec) return false;
    if (!box) return false;
    if (box.min_lat === null || box.min_lat === undefined) return true;    // bbox 为 NULL 的 way：建图时也收录
    if (box.deleted) return false;
    for (const rect of (rec.rects && rec.rects.length ? rec.rects : [rec.bbox])) {
      const b = bboxOfRect(rect);
      if (!b) continue;
      if (box.max_lat >= b.minLat && box.min_lat <= b.maxLat && box.max_lon >= b.minLon && box.min_lon <= b.maxLon) return true;
    }
    return false;
  }

  /**
   * way 改了：已就绪的区域图/走廊图就地 `updateWay`。
   * **判据不能只看"这张图里原来有没有这条 way"**：玩家新画的轨道/道路在原来的图里当然没有，
   * 但它可能落在**已激活**的区域里 —— 那种情况必须也调 `updateWay` 把它加进去，
   * 否则"刚铺好的轨道吸附不上车站"（老路径 `rail.updateWay(id)` 正是这个语义）。
   * 未建的区域直接跳过：等它被激活建图时自然会带上最新数据。
   */
  updateWay(wayId) {
    const id = Number(wayId);
    this.stats.updateWayCalls += 1;
    const box = this.wayBbox(id);
    let added = 0; let removed = false;
    for (const mode of GRAPH_MODES) {
      for (const slot of this.graphs[mode].values()) {
        if (slot.state !== 'ready' || !slot.graph) continue;
        const inGraph = !!(slot.graph.wayInfo && slot.graph.wayInfo.has(id));
        if (!inGraph && !this.wayInShard(slot.id, box)) continue;
        try {
          const r = slot.graph.updateWay(id);
          if (r && r.added) added += r.added;
          if (r && r.removed) removed = true;
          slot.lastUsedAt = Date.now();
        } catch (err) { this.warn(`updateWay(${id}) 失败（${mode} · ${slot.id}）：${err.message}`); }
      }
      for (const e of this.corridors[mode].values()) {
        if (!e.graph.wayInfo || !e.graph.wayInfo.has(id)) continue;
        try {
          const r = e.graph.updateWay(id);
          if (r && r.added) added += r.added;
          if (r && r.removed) removed = true;
        } catch { /* 走廊图是临时的，失败就让它过期重建 */ }
      }
    }
    return { added, removed, lazy: true };
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._kickTimer) { clearTimeout(this._kickTimer); this._kickTimer = null; }
    if (this._pathsTimer) { clearTimeout(this._pathsTimer); this._pathsTimer = null; }
  }

  /** 让整个世界跑起来（后台巡检定时器；`unref` 掉，不影响进程退出） */
  start() {
    if (!this.modeOn || this._timer) return;
    this._timer = setInterval(() => this.sweep(), this.opts.lazySweepMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** `/api/health` 的 `regions.lazy` 块（**与 /api/ready 一样是纯读**） */
  info() {
    const slotInfo = (mode) => {
      const out = { ready: [], building: [], unloading: [] };
      let ways = 0; let nodes = 0; let edges = 0; let builtMs = 0;
      const phases = {};
      for (const s of this.graphs[mode].values()) {
        if (s.state === 'ready' && s.graph) {
          out.ready.push(s.id);
          ways += s.graph.wayCount; nodes += s.graph.nodes.size; edges += s.graph.edgeCount || 0;
          builtMs += s.builtMs;
          if (s.stats && s.stats.phases) {
            for (const [k, v] of Object.entries(s.stats.phases)) {
              if (typeof v === 'number') phases[k] = (phases[k] || 0) + v;
            }
          }
        } else if (s.state === 'building') out.building.push(s.id);
        else if (s.state === 'unloading') out.unloading.push(s.id);
      }
      out.ready.sort();
      /**
       * `absent` = **注册表里有、但这张图没建**的全部片（不只是"曾经建过又被卸掉的"）——
       * 这才是"未激活的区域不建图、不常驻"的可验证口径（§7 的自证）。
       */
      const readySet = new Set(out.ready);
      out.absent = (this.registry.list || []).map((r) => r.id).filter((id) => !readySet.has(id)).sort();
      return { ready: out.ready, building: out.building, unloading: out.unloading, absent: out.absent, ways, nodes, edges, builtMs, phases };
    };
    const corridorInfo = (mode) => [...this.corridors[mode].values()].map((e) => ({
      key: e.key, ways: e.ways, nodes: e.nodes, ms: e.ms, ageMs: Date.now() - e.at,
    }));
    return {
      on: true,
      lazy: true,
      idleMs: this.opts.lazyIdleMs,
      sweepMs: this.opts.lazySweepMs,
      corridorGraph: this.opts.corridorGraph,
      alwaysActive: [...this.alwaysActive],
      assetShards: [...this.assetShards],
      activeShards: [...this.active],
      viewports: this.viewports.size,
      populationMode: this.populationMode,
      populationShards: [...this.popDone],
      rail: slotInfo('rail'),
      bus: slotInfo('bus'),
      corridors: { rail: corridorInfo('rail'), bus: corridorInfo('bus'), max: this.opts.corridorMax, ttlMs: this.opts.corridorTtlMs },
      pointGraphs: { rail: this.points.rail.size, bus: this.points.bus.size },
      counters: {
        builds: this.stats.builds, unloads: this.stats.unloads,
        syncBuilds: this.stats.syncBuilds, syncBuildMs: this.stats.syncBuildMs,
        corridorBuilds: this.stats.corridorBuilds, corridorSyncBuilds: this.stats.corridorSyncBuilds,
        corridorReuse: this.stats.corridorReuse, corridorHits: this.stats.corridorHits,
        pointBuilds: this.stats.pointBuilds, populationBuilds: this.stats.populationBuilds,
        populationMs: this.stats.populationMs, updateWayCalls: this.stats.updateWayCalls,
        errors: this.stats.errors,
      },
      lastBuild: this.stats.lastBuild,
      lastUnload: this.stats.lastUnload,
      lastError: this.stats.lastError,
      startedAt: new Date(this.stats.startedAt).toISOString(),
    };
  }
}

/* --------------------------------------------------------------------------
 * RegionGraphSource：把"一组区域图"伪装成**一张图**交给 transit.js
 *
 * ⚠ 它**不是**一张 RailGraph：`nodes` / `wayInfo` 是**只读视图**（`size/get/has/values/keys`），
 * `values()` **跳过虚拟路口节点** —— 因为虚拟 id 每个实例都从 −1 起算，跨实例不是全局唯一的，
 * 让它们出现在"并集视图"里必然指向另一张图的错误节点。正 id（OSM node id）是全局唯一的，
 * 所以按 id 取值是安全的（`nodeAt`）。
 * 其余方法一律**选一张图再委派**（`nearestNode` / `nearestRoadPoint` / `routeFor` / …），
 * 从不把两张图的数据混在一起算。
 * ------------------------------------------------------------------------ */
class RegionGraphSource {
  constructor(world, mode) {
    this.world = world;
    this.mode = mode;
    this.busJunctions = mode === 'bus';
    this.lazy = true;
    this._lastRouteGraph = null;
  }

  /* ---- 只读视图（transit.js 只用到 size / has / values） ---- */

  get nodes() {
    const world = this.world;
    const mode = this.mode;
    return {
      /** **非虚拟**节点总数（`graphReady()` / `_importGrid` 的缓存判据都读它） */
      get size() {
        let n = 0;
        for (const g of world.readyGraphs(mode)) n += Math.max(0, g.nodes.size - (g.virtualNodeCount || 0));
        return n;
      },
      has(id) { return world.nodeAt(mode, id) !== undefined; },
      get(id) { return world.nodeAt(mode, id); },
      *values() {
        for (const g of world.readyGraphs(mode)) {
          for (const n of g.nodes.values()) if (!n.virtual) yield n;
        }
      },
      *keys() { for (const n of this.values()) yield n.id; },
    };
  }

  get wayInfo() {
    const world = this.world;
    const mode = this.mode;
    return {
      get size() { return world.wayInfoCount(mode); },
      has(id) { return world.wayInfoGet(mode, id) !== undefined; },
      get(id) { return world.wayInfoGet(mode, id); },
      *values() { for (const g of world.readyGraphs(mode)) yield* g.wayInfo.values(); },
      *keys() { for (const g of world.readyGraphs(mode)) yield* g.wayInfo.keys(); },
    };
  }

  get wayCount() { let n = 0; for (const g of this.world.readyGraphs(this.mode)) n += g.wayCount; return n; }
  get edgeCount() { let n = 0; for (const g of this.world.readyGraphs(this.mode)) n += g.edgeCount || 0; return n; }
  get segmentCount() { let n = 0; for (const g of this.world.readyGraphs(this.mode)) n += g.segmentCount || 0; return n; }
  get virtualNodeCount() { let n = 0; for (const g of this.world.readyGraphs(this.mode)) n += g.virtualNodeCount || 0; return n; }
  get junctionCount() { let n = 0; for (const g of this.world.readyGraphs(this.mode)) n += g.junctionCount || 0; return n; }
  get builtAt() { let t = 0; for (const g of this.world.readyGraphs(this.mode)) t = Math.max(t, g.builtAt || 0); return t; }

  /* ---- 按坐标选图 ---- */

  graphAt(lat, lon) { return this.world.graphAt(this.mode, lat, lon); }

  nearestNode(lat, lon, maxMeters) {
    const g = this.world.graphAt(this.mode, lat, lon);
    return g ? g.nearestNode(lat, lon, maxMeters) : null;
  }

  nearestRoadPoint(lat, lon, maxMeters) {
    const g = this.world.graphAt(this.mode, lat, lon);
    return g && typeof g.nearestRoadPoint === 'function' ? g.nearestRoadPoint(lat, lon, maxMeters) : null;
  }

  wayOfNode(nodeId) {
    for (const g of this.world.readyGraphs(this.mode)) {
      const n = g.nodes.get(Number(nodeId));
      if (!n) continue;
      if (n.virtual) return null;
      const w = g.wayOfNode(nodeId);
      if (w != null) return w;
    }
    return undefined;                       // undefined = "这张图里没有"（调用方会退回 SQL 反查）
  }

  /* ---- 寻路（走廊图，§6.5.2 方案 C） ---- */

  routeFor(nodeIds) { return this.world.routeFor(this.mode, nodeIds); }

  routeThrough(nodeIds) {
    const plan = this.routeFor(nodeIds);
    if (plan && plan.graph && !plan.route.error) {
      this._lastRouteGraph = plan.graph;
      return plan.route;
    }
    if (plan && plan.route) return plan.route;
    return { error: '没有可用于寻路的区域图（该模式一张图都没建起来）' };
  }

  pathGeometry(path, speeds) {
    const g = this._lastRouteGraph || this.world.readyGraphs(this.mode)[0] || null;
    return g ? g.pathGeometry(path, speeds) : [];
  }

  /* ---- 别的委托 ---- */

  updateWay(wayId) { return this.world.updateWay(wayId); }

  nodeOf(nodeId) {
    for (const g of this.world.readyGraphs(this.mode)) {
      const n = g.nodes.get(Number(nodeId));
      if (n) return { id: n.id, lat: n.lat, lon: n.lon, virtual: !!n.virtual, degree: n.edges.length };
    }
    const row = this.world.nodeCoord(nodeId);
    return row ? { id: Number(nodeId), lat: row.lat, lon: row.lon, virtual: false, degree: 0 } : null;
  }

  wayStats(wayId) {
    for (const g of this.world.readyGraphs(this.mode)) {
      if (typeof g.wayStats !== 'function') continue;
      const w = g.wayStats(Number(wayId));
      if (w) return w;
    }
    return null;
  }

  wayCoords(wayId, maxPoints) {
    for (const g of this.world.readyGraphs(this.mode)) {
      if (typeof g.wayCoords !== 'function') continue;
      const c = g.wayCoords(Number(wayId), maxPoints);
      if (c && c.length) return c;
    }
    return [];
  }

  /** 视野内的道路拥堵：逐张就绪图各算一次再合并（每张图只负责自己那一块，不混数据） */
  congestionInBbox(minLon, minLat, maxLon, maxLat, options = {}) {
    const limit = Math.max(1, Math.min(50000, Math.round(Number(options.limit) || 4000)));
    const merged = [];
    for (const g of this.world.readyGraphs(this.mode)) {
      if (typeof g.congestionInBbox !== 'function') continue;
      const res = g.congestionInBbox(minLon, minLat, maxLon, maxLat, Object.assign({}, options, { limit }));
      if (res && Array.isArray(res.ways)) merged.push(res);
    }
    if (!merged.length) return { ways: [], regions: 0, lazy: true };
    const ways = [];
    for (const res of merged) for (const w of res.ways) ways.push(w);
    ways.sort((a, b) => (a.congestion || 0) - (b.congestion || 0));
    return {
      ways: ways.slice(0, limit), regions: merged.length, lazy: true,
      total: ways.length,
    };
  }

  stats() {
    const w = this.world;
    const s = {
      mode: this.mode,
      ways: this.wayCount,
      edges: this.edgeCount,
      nodes: this.nodes.size,
      builtAt: this.builtAt,
      segments: this.segmentCount,
      lazy: true,
      regions: [...w.graphs[this.mode].values()]
        .filter((x) => x.state === 'ready' && x.graph)
        .map((x) => ({ id: x.id, ways: x.graph.wayCount, nodes: x.graph.nodes.size, ms: x.builtMs })),
    };
    if (this.busJunctions) {
      s.virtualJunctions = this.virtualNodeCount;
      s.junctions = this.junctionCount;
      s.avgCongestion = this.congestionStats().avgCongestion;
    }
    return s;
  }

  congestionStats() {
    let n = 0; let sum = 0; let min = Infinity; let max = -Infinity; let slowest = null;
    let junctions = 0; let virtualJunctions = 0;
    for (const g of this.world.readyGraphs(this.mode)) {
      if (typeof g.congestionStats !== 'function') continue;
      const st = g.congestionStats();
      n += st.ways; sum += st.avgCongestion * st.ways;
      min = Math.min(min, st.minCongestion); max = Math.max(max, st.maxCongestion);
      junctions += st.junctions || 0; virtualJunctions += st.virtualJunctions || 0;
      if (st.slowest && (!slowest || st.slowest.speed < slowest.speed)) slowest = st.slowest;
    }
    return {
      ways: n,
      avgCongestion: n ? Math.round((sum / n) * 1000) / 1000 : 0,
      minCongestion: n ? min : 0,
      maxCongestion: n ? max : 1,
      junctions, virtualJunctions, slowest,
      densityScale: JUNCTION_DENSITY_SCALE, cellM: JUNCTION_CELL_M,
      lazy: true,
    };
  }

  close() { this.world.stop(); }
}

/**
 * 建"按区域惰性建图"的那套东西。**返回 null = 惰性建图没开**（`mode:'off'`，或显式 `lazy:false`）——
 * 调用方（`server/index.js`）据此照旧 `new RailGraph(db, {mode})`，一行行为都不变。
 */
function createRegionLazyWorld(db, options = {}) {
  const opts = options.opts;
  if (!opts || opts.lazyOn !== true) return null;
  if (!db || !db.registry || db.registry.ok !== true) return null;   // 注册表不可用 ⇒ 不惰性（照旧全量建）
  return new RegionLazyWorld(db, Object.assign({}, options, { opts, registry: options.registry || db.registry }));
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * 分区流式的唯一入口（`server/index.js` 只改这一行：`new OsmDB(...)` → `openRegionDB(...)`）。
 *
 *   · 默认（`config.regions` 不存在 / `mode !== 'on'`）→ **原样返回 `new OsmDB(config.osmDb, …)`**：
 *     不读注册表、不开分片、多一行日志都没有 —— 行为与改动前逐字节相同（既有测试全部照旧）。
 *   · `mode: 'on'` → 返回 `RegionDB`（鸭子类型；写路径与一切非视口查询都转发给那个单库）。
 *
 * @param config  index.js 解析出来的配置（要 `config.osmDb` 与 `config.regions`）
 * @param options `{ auditIndexes, wayLodIndexMaxZoom, wayLodSample, nodePoiIndexMaxZoom, regions: {mode, registryPath, source} }`
 */
function openRegionDB(config, options = {}) {
  const regionsOpts = regionsOptionsOf(config, options.regions || {});
  const osmOptions = {
    auditIndexes: options.auditIndexes,
    wayLodIndexMaxZoom: options.wayLodIndexMaxZoom,
    wayLodSample: options.wayLodSample,
    nodePoiIndexMaxZoom: options.nodePoiIndexMaxZoom,
  };
  if (!regionsOpts.modeOn) {
    // 关：**一个分片库都不打开、注册表都不读**（用启动日志可自证：这一支不打印任何 [regions] 行）
    return new OsmDB(config.osmDb, osmOptions);
  }
  return new RegionDB(config, { ...osmOptions, regions: regionsOpts,
    optsWayLodIndexMaxZoom: options.wayLodIndexMaxZoom,
    optsWayLodSample: options.wayLodSample,
    optsNodePoiIndexMaxZoom: options.nodePoiIndexMaxZoom });
}

module.exports = {
  openRegionDB, RegionDB, loadRegistry, regionsOptionsOf,
  REGION_DEFAULTS, REGION_ID_RE,
  // P4：按区域惰性建图（见文件里 "P4" 那一大段）
  RegionLazyWorld, RegionGraphSource, createRegionLazyWorld,
  GRAPH_MODES, lineGraphMode,
};
