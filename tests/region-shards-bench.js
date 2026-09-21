'use strict';
/**
 * 分区（分片）数据集基准与重叠测量
 *
 * ---------------------------------------------------------------------------
 * 运行方式
 * ---------------------------------------------------------------------------
 *   # 1) 自动发现：跑 data/regions/ 下所有 *.sqlite，两两做重叠统计
 *   node tests/region-shards-bench.js
 *
 *   # 2) 显式指定分片（顺序即 --pair 的顺序，标签随便起）
 *   node tests/region-shards-bench.js --db beijing=data/regions/beijing.sqlite \
 *                                     --db hebei=data/regions/hebei.sqlite
 *
 *   # 3) 换一个 bbox 做"路由判定"演示（minLat,minLon,maxLat,maxLon，WGS84）
 *   node tests/region-shards-bench.js --bbox 39.68,116.08,40.18,116.77
 *
 *   # 4) 只要机器可读结果（贴报告/喂给别的脚本）
 *   node tests/region-shards-bench.js --json
 *
 *   # 5) 重叠样例打印多少条（默认 6）
 *   node tests/region-shards-bench.js --samples 10
 *
 *   不传 --db 时默认扫 data/regions/*.sqlite；一个都没找到就直接报错退出。
 *
 * ---------------------------------------------------------------------------
 * 它打印七块东西
 * ---------------------------------------------------------------------------
 *   ① 每片要素计数与体积
 *        nodes / ways / relations / way_nodes / relation_members
 *        + 三个 R*Tree 索引（node_index / way_index / relation_index）条数
 *        + 库文件大小、库内 meta（source_file / imported_at / counts / data_bbox）
 *
 *   ② 跨片"同 id"重叠统计（这是"分区流式"最怕的东西：OSM id 是全局的）
 *        对每一对分片统计：同 id 的 node / way / relation 各多少条，占各自比例多少
 *        其中"内容不一致"的多少条（坐标 / version / tags 任一项不同）
 *        并打印 N 条样例做人工比对（tags 里的中文原样打印）
 *
 *   ③ 重叠样例对比（同 id 元素的两侧字段并排）
 *
 *   ④ **同 id 的「成员级」比对（最关键的一层）**：直接比 way 的 refs 序列
 *        （way_nodes 的 (way_id,seq) → node_id）与 relation 的成员列表
 *        （relation_members 的 (relation_id,seq) → 类型/ref/角色）。
 *        bbox / length 相同**不能**证明 refs 相同 —— 两条不同折线可以有同一外接矩形，
 *        所以"同 id 不同几何"（跨边界要素被两个提取包各自截断）只能在这一层证实或否认。
 *        同时给出"只在这一片"的要素数（B 独有，不是同 id 差异但同属重叠研究）。
 *
 *   ⑤ 成员级样例：refs 前 5 个 + 末 2 个并排、way 名字（中文原样）、公共前缀长度，
 *        一眼看出是不是"各截一段"；relation 样例还给"成员几何在本片能解析出多少"。
 *
 *   ⑥ 跨界要素画像：声明框（source_bounds）外的节点有多少、其中带标签多少、
 *        被几条 way 引用 —— 用来判断 data_bbox 远大于 source_bounds 属良性溢出还是真有大片数据。
 *
 *   ⑦ bbox 路由判定演示
 *        给定一个 bbox，量出：点（node）落在框内的节点数 —— 这是最精确的"几何归属"证据；
 *        以及 bbox 与框相交的 way / relation 数（R*Tree 相交，是上界，长条要素会跨片）
 *
 * ---------------------------------------------------------------------------
 * 只读保证
 * ---------------------------------------------------------------------------
 *   所有连接都是 readOnly；ATTACH 一律走 `file:…?mode=ro` URI，绝不写任何库。
 *   **不会**去碰 data/osm/osm.sqlite（线上库）—— 只在你显式 --db 指过去时才读它。
 *
 * 退出码：全部成功 0；参数错 / 库打不开 / 缺表 1。
 */

const fs = require('fs');
const path = require('path');

// node:sqlite 的 ExperimentalWarning 在 require 阶段就会打印，先静音（与 tests/import-test.js 一致）
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

/** 默认演示 bbox：北京（含 Geofabrik 分省包实际数据范围外扩一点），minLat,minLon,maxLat,maxLon */
const DEFAULT_BBOX = [39.4, 115.4, 40.5, 117.5];

/** 每片要数的表（顺序即打印顺序） */
const CORE_TABLES = ['nodes', 'ways', 'relations', 'way_nodes', 'relation_members'];
/** 三个 R*Tree 空间索引 */
const RTREE_TABLES = ['node_index', 'way_index', 'relation_index'];

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const out = { shards: [], bbox: DEFAULT_BBOX.slice(), json: false, samples: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      const v = argv[++i];
      if (!v) throw new Error('--db 后面要给 id=path');
      const eq = v.indexOf('=');
      let id;
      let p;
      if (eq > 0) { id = v.slice(0, eq); p = v.slice(eq + 1); }
      else { p = v; id = path.basename(v).replace(/\.sqlite$/, ''); }
      out.shards.push({ id, path: path.resolve(ROOT, p) });
    } else if (a === '--bbox') {
      const v = argv[++i];
      if (!v) throw new Error('--bbox 后面要给 minLat,minLon,maxLat,maxLon');
      const n = v.split(',').map(Number);
      if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) throw new Error('--bbox 要 4 个数字：minLat,minLon,maxLat,maxLon');
      out.bbox = n;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--samples') {
      out.samples = Math.max(0, Number(argv[++i]) || 0);
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      throw new Error('不认识的参数：' + a);
    }
  }
  if (!out.help && out.shards.length === 0) {
    const dir = path.join(ROOT, 'data', 'regions');
    const found = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort()
      : [];
    for (const f of found) out.shards.push({ id: f.replace(/\.sqlite$/, ''), path: path.join(dir, f) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
const fmt = (n) => (n === null || n === undefined) ? '-' : Number(n).toLocaleString('en-US');
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(4) + '%' : '-');

/** 等宽表：列宽按内容自适应（中文按 2 格算，避免表格错位） */
function width(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s, w) {
  const d = w - width(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}
function table(headers, rows) {
  const all = [headers].concat(rows);
  const widths = headers.map((_, i) => Math.max(...all.map((r) => width(r[i] === undefined ? '' : r[i]))));
  const line = (r) => '  ' + r.map((c, i) => pad(c === undefined ? '' : String(c), widths[i])).join('  ');
  console.log(line(headers));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

/** 只读打开 + 只读 ATTACH */
function openRo(file) {
  if (!fs.existsSync(file)) throw new Error('库不存在：' + file);
  return new DatabaseSync(file, { readOnly: true });
}
function attachRo(db, alias, file) {
  const uri = 'file:' + file.replace(/\\/g, '/') + '?mode=ro';
  db.exec(`ATTACH DATABASE '${uri}' AS ${alias}`);
}
/** 表是否存在（含虚拟表） */
function hasTable(db, schema, name) {
  return !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE name = ?`).get(name);
}
function tableCount(db, schema, name) {
  if (!hasTable(db, schema, name)) return null;
  return db.prepare(`SELECT COUNT(*) c FROM ${schema}."${name}"`).get().c;
}
function readMeta(db) {
  const out = {};
  try {
    for (const r of db.prepare('SELECT key, value FROM meta').all()) out[r.key] = r.value;
  } catch { /* 老库可能没 meta 表 */ }
  return out;
}

/* ------------------------------------------------------------------ *
 * ① 单片普查
 * ------------------------------------------------------------------ */
function census(shard) {
  const st = fs.statSync(shard.path);
  // WAL 文件里的内容也算"这个库有多大"，但报告里分开列更好解释（vacuum 前 WAL 可能很大）
  const wal = shard.path + '-wal';
  const walSize = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
  const db = openRo(shard.path);
  const meta = readMeta(db);
  const counts = {};
  for (const t of CORE_TABLES) counts[t] = tableCount(db, 'main', t);
  const rtree = {};
  for (const t of RTREE_TABLES) rtree[t] = tableCount(db, 'main', t);
  const bbox = db.prepare(
    'SELECT MIN(min_lat) minLat, MAX(max_lat) maxLat, MIN(min_lon) minLon, MAX(max_lon) maxLon'
    + ` FROM ${hasTable(db, 'main', 'node_index') ? 'node_index' : 'nodes'}`
  ).get();
  db.close();
  let declared = null;
  try { declared = meta.counts ? JSON.parse(meta.counts) : null; } catch { declared = null; }
  let dataBbox = null;
  try { dataBbox = meta.data_bbox ? JSON.parse(meta.data_bbox) : null; } catch { dataBbox = null; }
  return {
    id: shard.id, path: shard.path, bytes: st.size, walBytes: walSize,
    meta, declared, counts, rtree, bbox, dataBbox,
  };
}

/* ------------------------------------------------------------------ *
 * ② 跨片同 id 重叠
 * ------------------------------------------------------------------ */
/**
 * 三种元素各自的"语义指纹"字段：任一项不同 = 同 id 但**内容真不一致**（真冲突）
 */
const CONTENT_FIELDS = {
  nodes: ['lat', 'lon', 'version', 'tags'],
  ways: ['version', 'tags', 'node_count', 'closed'],
  relations: ['version', 'tags', 'member_count'],
};
/**
 * **派生几何**字段（导入时按"本片里能看到的成员/节点"算出来的）：
 * 它们在不同分片里天然可能不同 —— 同一个 way / relation，在 A 片里成员只到边界，
 * 在 B 片里成员还继续往外伸，算出来的 bbox / length / LOD 列就不一样。
 * 所以单独统计、单独报告：它**不是**"同 id 内容冲突"，但会让"按 id 合并两片"产生歧义。
 */
const DERIVED_FIELDS = {
  nodes: [],
  ways: ['min_lat', 'max_lat', 'min_lon', 'max_lon', 'length', 'road_class', 'lod_zoom'],
  relations: ['min_lat', 'max_lat', 'min_lon', 'max_lon'],
};
function diffSql(a, b, kind, fields) {
  if (fields.length === 0) return '0';
  return fields.map((f) => `IFNULL(${a}."${f}",'') <> IFNULL(${b}."${f}",'')`).join(' OR ');
}
function contentDiffSql(a, b, kind) { return diffSql(a, b, kind, CONTENT_FIELDS[kind]); }
function derivedDiffSql(a, b, kind) { return diffSql(a, b, kind, DERIVED_FIELDS[kind]); }

/** 样例要打印的列（两侧加 a_ / b_ 前缀，避免 JSON 里同名键互相覆盖） */
const SAMPLE_COLS = {
  nodes: ['id', 'lat', 'lon', 'version', 'tags'],
  ways: ['id', 'version', 'node_count', 'closed', 'min_lat', 'min_lon', 'length', 'tags'],
  relations: ['id', 'version', 'member_count', 'min_lat', 'min_lon', 'tags'],
};
/** tags 太长会把整行淹掉（北京市那个 admin 节点有 8 KB tags），样例里截断 */
function trimTags(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if ((k === 'a_tags' || k === 'b_tags') && typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + `…(共 ${v.length} 字符)`;
    } else out[k] = v;
  }
  return out;
}

/**
 * 量一对分片的重叠。
 * 做法：把 B 只读 ATTACH 进 A 的连接，让 SQLite 自己做 PK 索引 join。
 * 走 PK 的话，一个 4.8M 行的表去探 14M 行的表也就几秒。
 */
function overlap(openShard, otherShard, otherFile, samples) {
  const db = openRo(openShard.path);
  const alias = 'o';
  attachRo(db, alias, otherFile);
  const res = { pair: [openShard.id, otherShard.id], kinds: {} };
  for (const kind of ['nodes', 'ways', 'relations']) {
    const same = db.prepare(`SELECT COUNT(*) c FROM main.${kind} a JOIN ${alias}.${kind} b ON a.id = b.id`).get().c;
    let diff = null;
    let derivedDiff = null;
    let examples = [];
    if (same > 0) {
      diff = db.prepare(
        `SELECT COUNT(*) c FROM main.${kind} a JOIN ${alias}.${kind} b ON a.id = b.id WHERE ${contentDiffSql('a', 'b', kind)}`
      ).get().c;
      if (DERIVED_FIELDS[kind].length) {
        derivedDiff = db.prepare(
          `SELECT COUNT(*) c FROM main.${kind} a JOIN ${alias}.${kind} b ON a.id = b.id WHERE ${derivedDiffSql('a', 'b', kind)}`
        ).get().c;
      }
      if (samples > 0) {
        // 列名加 a_ / b_ 前缀：不加的话 JSON 里同名键会互相覆盖，只剩一侧的值（看不出对比）
        const sel = SAMPLE_COLS[kind].map((c) => `a."${c}" AS a_${c}`)
          .concat(SAMPLE_COLS[kind].map((c) => `b."${c}" AS b_${c}`)).join(', ');
        // 优先打"真的不一致"的行，其次打派生几何不一致的行
        const order = DERIVED_FIELDS[kind].length
          ? `ORDER BY (CASE WHEN ${contentDiffSql('a', 'b', kind)} THEN 0 ELSE 1 END), (CASE WHEN ${derivedDiffSql('a', 'b', kind)} THEN 0 ELSE 1 END)`
          : `ORDER BY (CASE WHEN ${contentDiffSql('a', 'b', kind)} THEN 0 ELSE 1 END)`;
        examples = db.prepare(
          `SELECT ${sel} FROM main.${kind} a JOIN ${alias}.${kind} b ON a.id = b.id ${order} LIMIT ?`
        ).all(samples).map(trimTags);
      }
    }
    res.kinds[kind] = { same, diff, derivedDiff, examples };
  }
  // 顺带量一下"几何越界"：以 A 的数据 bbox 为准，看 B 里有多少 node 点真的落在 A 的 bbox 内
  const aIdx = hasTable(db, 'main', 'node_index') ? 'main.node_index' : null;
  if (aIdx) {
    const bb = db.prepare(`SELECT MIN(min_lat) a, MAX(max_lat) b, MIN(min_lon) c, MAX(max_lon) d FROM ${aIdx}`).get();
    res.bbox = bb;
    const inner = db.prepare(
      `SELECT COUNT(*) c FROM ${alias}.node_index
       WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?`
    ).get(bb.a, bb.b, bb.c, bb.d);
    res.nodesInsideOtherBbox = inner.c;
    for (const kind of ['way', 'relation']) {
      if (!hasTable(db, alias, `${kind}_index`)) continue;
      const n = db.prepare(
        `SELECT COUNT(*) c FROM ${alias}.${kind}_index
         WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?`
      ).get(bb.a, bb.b, bb.c, bb.d);
      res[`${kind}sIntersectOtherBbox`] = n.c;
    }
  }
  db.close();
  return res;
}

/* ------------------------------------------------------------------ *
 * ⑤ 同 id 的"成员级"比对（refs 序列 / relation 成员列表）
 *
 * 为什么必须单独做这一层：**bbox / length 相同不能证明 refs 相同**。
 * 两条不同的折线完全可以有同一个外接矩形且同样的长度，所以"同 id 不同几何"这件事
 * 只能直接比 way_nodes 的 (way_id, seq) → node_id 序列、以及 relation_members 的
 * (relation_id, seq) → (member_type, member_ref, role)，不能靠 bbox 推断。
 *
 * 这一层要回答的问题是：**跨边界的长要素，会不会在两个提取包里被各自截断，
 * 变成"同 id 但 refs 不一样"？** 这是分区合并最危险的重叠形式（同一元素有两个几何，
 * 画面上会闪、写回时会互相覆盖）。
 * ------------------------------------------------------------------ */

/** way 的名字：优先 name / name:zh，其次 ref / highway，都解析不出来就给 null */
function wayLabel(tagsJson) {
  if (!tagsJson) return null;
  let t;
  try { t = JSON.parse(tagsJson); } catch { return null; }
  const pick = ['name', 'name:zh', 'name:en', 'ref', 'highway', 'railway', 'power', 'route', 'waterway'];
  const out = [];
  for (const k of pick) if (t[k] !== undefined) out.push(`${k}=${t[k]}`);
  return out.length ? out.slice(0, 3).join(' ') : null;
}

/** 取一条 way 的 node_id 序列（按 seq 升序） */
function wayRefs(db, schema, wayId) {
  return db.prepare(`SELECT node_id FROM ${schema}.way_nodes WHERE way_id = ? ORDER BY seq`).all(wayId).map((r) => r.node_id);
}
/**
 * 判断两条 refs 的关系：完全一致 / 一侧是另一侧的前缀（=各截一段的典型形态）/ 其它
 * 注意"前缀"只是"截断"的一种表现；交集但不互为前缀也是截断（从中间各取一段）。
 */
function refsRelation(x, y) {
  const n = Math.min(x.length, y.length);
  let samePrefix = 0;
  while (samePrefix < n && x[samePrefix] === y[samePrefix]) samePrefix++;
  const setX = new Set(x);
  let common = 0;
  for (const v of new Set(y)) if (setX.has(v)) common++;
  const setY = new Set(y).size;
  return {
    samePrefix,
    prefixOnly: samePrefix === n,
    commonInY: `${common}/${setY}`,
  };
}

/**
 * 量一对分片的"成员级"差异。
 * 用 (way_id, seq) 主键做 LEFT JOIN 逐位置比：两边都是 WITHOUT ROWID + PK(way_id,seq)，
 * 所以 560 万 × 1750 万行也能走索引，不需要把 refs 拉进 JS。
 */
function memberDiff(openShard, otherShard, otherFile, samples) {
  const db = openRo(openShard.path);
  const alias = 'o';
  attachRo(db, alias, otherFile);
  const out = { pair: [openShard.id, otherShard.id] };

  // ---- way 的 refs ----
  // A 侧每个 (way_id, seq) 在 B 里是否存在且 node_id 相同
  out.wayRefMismatchFromA = db.prepare(
    `SELECT COUNT(*) c FROM main.way_nodes a
     LEFT JOIN ${alias}.way_nodes b ON b.way_id = a.way_id AND b.seq = a.seq
     WHERE b.node_id IS NULL OR b.node_id <> a.node_id`
  ).get().c;
  // B 侧：只看 way_id 也在 A 里的那些（B 独有的 way 不算"同 id 差异"）
  out.wayRefMismatchFromB = db.prepare(
    `SELECT COUNT(*) c FROM ${alias}.way_nodes b
     JOIN main.ways w ON w.id = b.way_id
     LEFT JOIN main.way_nodes a ON a.way_id = b.way_id AND a.seq = b.seq
     WHERE a.node_id IS NULL OR a.node_id <> b.node_id`
  ).get().c;
  // 至少有一个位置不同的 way 条数（两侧并集）
  out.waysWithRefDiff = db.prepare(
    `SELECT COUNT(*) c FROM (
       SELECT a.way_id AS id FROM main.way_nodes a
         LEFT JOIN ${alias}.way_nodes b ON b.way_id = a.way_id AND b.seq = a.seq
         WHERE b.node_id IS NULL OR b.node_id <> a.node_id
       UNION
       SELECT b.way_id AS id FROM ${alias}.way_nodes b
         JOIN main.ways w ON w.id = b.way_id
         LEFT JOIN main.way_nodes a ON a.way_id = b.way_id AND a.seq = b.seq
         WHERE a.node_id IS NULL OR a.node_id <> b.node_id
     )`
  ).get().c;
  // 反面：逐位置全同的 way 条数（即"几何确实一样"）
  out.waysRefIdentical = db.prepare(
    `SELECT COUNT(*) c FROM main.ways w WHERE EXISTS (
       SELECT 1 FROM main.way_nodes a
         JOIN ${alias}.way_nodes b ON b.way_id = a.way_id AND b.seq = a.seq
         WHERE a.way_id = w.id AND a.node_id = b.node_id
     ) AND NOT EXISTS (
       SELECT 1 FROM main.way_nodes a
         LEFT JOIN ${alias}.way_nodes b ON b.way_id = a.way_id AND b.seq = a.seq
         WHERE a.way_id = w.id AND (b.node_id IS NULL OR b.node_id <> a.node_id)
     )`
  ).get().c;

  // ---- relation 的成员列表 ----
  const memDiff = `(b.member_ref IS NULL OR b.member_ref <> a.member_ref
                    OR IFNULL(b.member_type,'') <> IFNULL(a.member_type,'')
                    OR IFNULL(b.role,'') <> IFNULL(a.role,''))`;
  out.relMemberMismatchFromA = db.prepare(
    `SELECT COUNT(*) c FROM main.relation_members a
     LEFT JOIN ${alias}.relation_members b ON b.relation_id = a.relation_id AND b.seq = a.seq
     WHERE b.member_ref IS NULL OR ${memDiff}`
  ).get().c;
  out.relMemberMismatchFromB = db.prepare(
    `SELECT COUNT(*) c FROM ${alias}.relation_members b
     JOIN main.relations r ON r.id = b.relation_id
     LEFT JOIN main.relation_members a ON a.relation_id = b.relation_id AND a.seq = b.seq
     WHERE a.member_ref IS NULL OR (a.member_ref <> b.member_ref
       OR IFNULL(a.member_type,'') <> IFNULL(b.member_type,'')
       OR IFNULL(a.role,'') <> IFNULL(b.role,''))`
  ).get().c;
  out.relsWithMemberDiff = db.prepare(
    `SELECT COUNT(*) c FROM (
       SELECT a.relation_id AS id FROM main.relation_members a
         LEFT JOIN ${alias}.relation_members b ON b.relation_id = a.relation_id AND b.seq = a.seq
         WHERE b.member_ref IS NULL OR ${memDiff}
       UNION
       SELECT b.relation_id AS id FROM ${alias}.relation_members b
         JOIN main.relations r ON r.id = b.relation_id
         LEFT JOIN main.relation_members a ON a.relation_id = b.relation_id AND a.seq = b.seq
         WHERE a.member_ref IS NULL OR (a.member_ref <> b.member_ref
           OR IFNULL(a.member_type,'') <> IFNULL(b.member_type,'')
           OR IFNULL(a.role,'') <> IFNULL(b.role,''))
     )`
  ).get().c;

  // ---- 逐字段差异明细：把"refs 不同"与"只是 version/tags 不同（几何相同）"彻底分开 ----
  out.wayFieldDiffs = {};
  for (const f of ['version', 'tags', 'node_count', 'closed']) {
    out.wayFieldDiffs[f] = db.prepare(
      `SELECT COUNT(*) c FROM main.ways a JOIN ${alias}.ways b ON a.id = b.id
       WHERE IFNULL(a."${f}",'') <> IFNULL(b."${f}",'')`).get().c;
  }
  out.relFieldDiffs = {};
  for (const f of ['version', 'tags', 'member_count']) {
    out.relFieldDiffs[f] = db.prepare(
      `SELECT COUNT(*) c FROM main.relations a JOIN ${alias}.relations b ON a.id = b.id
       WHERE IFNULL(a."${f}",'') <> IFNULL(b."${f}",'')`).get().c;
  }

  // ---- B 独有的 way（"只在这一片"的要素，不是"同 id 差异"，但也是重叠研究要看的）----
  out.waysOnlyInB = db.prepare(
    `SELECT COUNT(*) c FROM ${alias}.ways b WHERE NOT EXISTS (SELECT 1 FROM main.ways a WHERE a.id = b.id)`
  ).get().c;
  out.relsOnlyInB = db.prepare(
    `SELECT COUNT(*) c FROM ${alias}.relations b WHERE NOT EXISTS (SELECT 1 FROM main.relations a WHERE a.id = b.id)`
  ).get().c;
  out.nodesOnlyInB = db.prepare(
    `SELECT COUNT(*) c FROM ${alias}.nodes b WHERE NOT EXISTS (SELECT 1 FROM main.nodes a WHERE a.id = b.id)`
  ).get().c;

  // ---- 样例：refs 不同的 way（有就打差异的，没有就打"跨界 way"当反证）----
  out.wayExamples = [];
  out.relationExamples = [];
  out.exampleBasis = '';
  if (samples > 0) {
    const declared = (() => {
      try { return JSON.parse(readMeta(db).source_bounds || 'null'); } catch { return null; }
    })();
    let ids;
    if (out.waysWithRefDiff > 0) {
      out.exampleBasis = 'refs 不同的 way';
      ids = db.prepare(
        `SELECT DISTINCT a.way_id AS id FROM main.way_nodes a
         LEFT JOIN ${alias}.way_nodes b ON b.way_id = a.way_id AND b.seq = a.seq
         WHERE b.node_id IS NULL OR b.node_id <> a.node_id
         UNION
         SELECT DISTINCT b.way_id AS id FROM ${alias}.way_nodes b
         JOIN main.ways w ON w.id = b.way_id
         LEFT JOIN main.way_nodes a ON a.way_id = b.way_id AND a.seq = b.seq
         WHERE a.node_id IS NULL OR a.node_id <> b.node_id
         LIMIT ?`
      ).all(samples).map((r) => r.id);
    } else {
      // 没有 refs 差异 → 挑"跨界 way"做反证。两类都挑，因为它们覆盖不同的截断风险：
      //   (a) 伸得**最远**的：最能暴露"把长要素在边界处剪断"（这是最像会被裁的一批）
      //   (b) 节点**最多**的：最能暴露"只保留框内那段"
      out.exampleBasis = declared
        ? '跨界 way：(a) 伸出 source_bounds 最远的 + (b) 节点最多的（最可能被截断的两批，用来反证）'
        : '节点最多的 way（最可能被截断的那批，用来反证）';
      const picked = new Map();   // id -> criterion
      if (declared) {
        // 注意：这个 SQLite 构建里没有 GREATEST()（实测报 no such function），
        // 用 SQLite 的标量形式 max(a,b,c…) 代替（它按参数个数区分标量/聚合，多参数即标量）。
        const far = `SELECT w.id AS id,
              MAX(max(n.lat - ?, ? - n.lat, n.lon - ?, ? - n.lon, 0)) AS outBy,
              MAX(ABS(n.lat - (? + ?) / 2) + ABS(n.lon - (? + ?) / 2)) AS farBy
            FROM main.ways w JOIN main.way_nodes wn ON wn.way_id = w.id JOIN main.nodes n ON n.id = wn.node_id
            GROUP BY w.id HAVING outBy > 0 ORDER BY farBy DESC LIMIT ?`;
        const args = [declared.max_lat, declared.min_lat, declared.max_lon, declared.min_lon,
          declared.min_lat, declared.max_lat, declared.min_lon, declared.max_lon, samples];
        for (const r of db.prepare(far).all(...args)) picked.set(r.id, `伸出声明框最远（最远节点离框心约 ${r.farBy.toFixed(2)}°）`);
      }
      for (const r of db.prepare('SELECT id FROM main.ways ORDER BY node_count DESC LIMIT ?').all(samples)) {
        if (!picked.has(r.id)) picked.set(r.id, '节点最多');
      }
      ids = [...picked.keys()];
      out.wayExampleCriteria = picked;
    }
    for (const id of ids) {
      const aRefs = wayRefs(db, 'main', id);
      const bRefs = wayRefs(db, alias, id);
      const w = db.prepare(`SELECT id, version, node_count, tags, min_lat, max_lat, min_lon, max_lon FROM main.ways WHERE id = ?`).get(id);
      // 这条 way 的节点里最极端的坐标（判断它到底伸出去多远）
      const ext = db.prepare(
        `SELECT MIN(n.lat) minLat, MAX(n.lat) maxLat, MIN(n.lon) minLon, MAX(n.lon) maxLon
         FROM main.way_nodes wn JOIN main.nodes n ON n.id = wn.node_id WHERE wn.way_id = ?`).get(id);
      out.wayExamples.push({
        id,
        criterion: out.wayExampleCriteria ? (out.wayExampleCriteria.get(id) || '') : '',
        a: openShard.id,
        b: otherShard.id,
        label: wayLabel(w ? w.tags : null),
        aVersion: w ? w.version : null,
        aNodeCount: aRefs.length,
        bNodeCount: bRefs.length,
        identical: aRefs.length === bRefs.length && aRefs.every((v, i) => v === bRefs[i]),
        relation: refsRelation(aRefs, bRefs),
        extreme: ext,
        aFirst5: aRefs.slice(0, 5),
        bFirst5: bRefs.slice(0, 5),
        aLast2: aRefs.slice(-2),
        bLast2: bRefs.slice(-2),
      });
    }
    // relation 样例：成员不同的优先，否则挑成员最多的
    const relIds = out.relsWithMemberDiff > 0
      ? db.prepare(
        `SELECT DISTINCT a.relation_id AS id FROM main.relation_members a
         LEFT JOIN ${alias}.relation_members b ON b.relation_id = a.relation_id AND b.seq = a.seq
         WHERE b.member_ref IS NULL OR ${memDiff} LIMIT ?`
      ).all(samples).map((r) => r.id)
      : db.prepare('SELECT id FROM main.relations ORDER BY member_count DESC LIMIT ?').all(samples).map((r) => r.id);
    for (const id of relIds) {
      const aM = db.prepare(`SELECT seq, member_type, member_ref, role FROM main.relation_members WHERE relation_id = ? ORDER BY seq`).all(id);
      const bM = db.prepare(`SELECT seq, member_type, member_ref, role FROM ${alias}.relation_members WHERE relation_id = ? ORDER BY seq`).all(id);
      const r0 = db.prepare(`SELECT id, version, member_count, tags FROM main.relations WHERE id = ?`).get(id);
      const key = (m) => `${m.member_type}:${m.member_ref}:${m.role === null ? '' : m.role}`;
      const identical = aM.length === bM.length && aM.every((m, i) => key(m) === key(bM[i]));
      // 成员成员几何在"本片"能否解析（这才是 relation 派生 bbox 不同的真正成因）
      const resolvable = (schema, rows) => {
        let n = 0;
        const chkW = db.prepare(`SELECT 1 FROM ${schema}.ways WHERE id = ?`);
        const chkN = db.prepare(`SELECT 1 FROM ${schema}.nodes WHERE id = ?`);
        const chkR = db.prepare(`SELECT 1 FROM ${schema}.relations WHERE id = ?`);
        for (const m of rows) {
          const hit = m.member_type === 'way' ? chkW.get(m.member_ref)
            : m.member_type === 'node' ? chkN.get(m.member_ref)
              : m.member_type === 'relation' ? chkR.get(m.member_ref) : null;
          if (hit) n++;
        }
        return n;
      };
      out.relationExamples.push({
        id,
        label: wayLabel(r0 ? r0.tags : null),
        aVersion: r0 ? r0.version : null,
        aMemberCount: aM.length,
        bMemberCount: bM.length,
        identical,
        aResolvable: resolvable('main', aM),
        bResolvable: resolvable(alias, bM),
        aFirst3: aM.slice(0, 3).map(key),
        bFirst3: bM.slice(0, 3).map(key),
      });
    }
  }
  db.close();
  return out;
}

/**
 * 单片"跨界要素画像"：声明框外的节点有多少、其中带标签多少、被多少条 way 引用。
 * 用来判断"data_bbox 远大于 source_bounds"到底是良性溢出还是真有大片数据在外面。
 */
function spillProfile(shard) {
  const db = openRo(shard.path);
  const meta = readMeta(db);
  let sb = null;
  try { sb = meta.source_bounds ? JSON.parse(meta.source_bounds) : null; } catch { sb = null; }
  if (!sb) { db.close(); return null; }
  const [a, b, c, d] = [sb.min_lat, sb.max_lat, sb.min_lon, sb.max_lon];
  const out = {
    id: shard.id,
    sourceBounds: sb,
    nodesOutside: db.prepare(
      `SELECT COUNT(*) x FROM main.nodes WHERE lat < ? OR lat > ? OR lon < ? OR lon > ?`).get(a, b, c, d).x,
    nodesOutsideTagged: db.prepare(
      `SELECT COUNT(*) x FROM main.nodes WHERE (lat < ? OR lat > ? OR lon < ? OR lon > ?) AND tags IS NOT NULL`).get(a, b, c, d).x,
    waysTouchingOutside: db.prepare(
      `SELECT COUNT(DISTINCT wn.way_id) x FROM main.way_nodes wn JOIN main.nodes n ON n.id = wn.node_id
       WHERE n.lat < ? OR n.lat > ? OR n.lon < ? OR n.lon > ?`).get(a, b, c, d).x,
  };
  // 框外节点被几条 way 引用：1 条 / 2 条 / 3 条以上
  out.refHistogram = db.prepare(
    `SELECT cnt, COUNT(*) n FROM (
       SELECT wn.node_id, COUNT(*) cnt FROM main.way_nodes wn JOIN main.nodes n ON n.id = wn.node_id
       WHERE n.lat < ? OR n.lat > ? OR n.lon < ? OR n.lon > ?
       GROUP BY wn.node_id
     ) GROUP BY cnt ORDER BY cnt LIMIT 6`).all(a, b, c, d);
  out.nodesOutsideTotal = out.nodesOutside;
  db.close();
  return out;
}

/* ------------------------------------------------------------------ *
 * ③ bbox 路由判定
 * ------------------------------------------------------------------ */
function routeBbox(shards, bbox) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const rows = [];
  for (const s of shards) {
    const db = openRo(s.path);
    const nodes = tableCount(db, 'main', 'node_index') === null
      ? db.prepare('SELECT COUNT(*) c FROM nodes WHERE lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?').get(minLat, maxLat, minLon, maxLon).c
      : db.prepare('SELECT COUNT(*) c FROM node_index WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?').get(minLat, maxLat, minLon, maxLon).c;
    const ways = hasTable(db, 'main', 'way_index')
      ? db.prepare('SELECT COUNT(*) c FROM way_index WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?').get(minLat, maxLat, minLon, maxLon).c
      : null;
    const rels = hasTable(db, 'main', 'relation_index')
      ? db.prepare('SELECT COUNT(*) c FROM relation_index WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?').get(minLat, maxLat, minLon, maxLon).c
      : null;
    db.close();
    rows.push({ id: s.id, nodes, ways, relations: rels });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('参数错误：' + e.message);
    process.exit(1);
  }
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    process.exit(0);
  }
  if (args.shards.length === 0) {
    console.error('没找到分片：给 --db id=path，或先把库放到 data/regions/*.sqlite');
    process.exit(1);
  }
  for (const s of args.shards) {
    if (!fs.existsSync(s.path)) { console.error('库不存在：' + s.path); process.exit(1); }
  }

  console.log('');
  console.log('=== 分区数据集基准与重叠测量 ===');
  console.log('  分片数：' + args.shards.length + '（' + args.shards.map((s) => s.id).join(', ') + '）');
  console.log('  演示 bbox：' + args.bbox.join(', ') + '（minLat,minLon,maxLat,maxLon）');
  console.log('');

  /* ---- ① 每片普查 ---- */
  const censuses = [];
  for (const s of args.shards) {
    try {
      censuses.push(census(s));
    } catch (e) {
      console.error('读 ' + s.path + ' 失败：' + e.message);
      process.exit(1);
    }
  }
  console.log('① 每片要素计数与体积');
  const head = ['分片', '库大小', 'WAL'].concat(CORE_TABLES, RTREE_TABLES);
  const rows = censuses.map((c) => [c.id, mb(c.bytes), mb(c.walBytes)]
    .concat(CORE_TABLES.map((t) => fmt(c.counts[t])), RTREE_TABLES.map((t) => fmt(c.rtree[t]))));
  table(head, rows);
  console.log('');
  for (const c of censuses) {
    const b = c.dataBbox || c.bbox;
    console.log(`  · ${c.id}`);
    console.log(`      来源      : ${c.meta.source_file || '(meta 无)'}`);
    console.log(`      导入时间  : ${c.meta.imported_at || '(meta 无)'}`);
    if (b) console.log(`      数据 bbox : lat ${b.min_lat ?? b.minLat} ~ ${b.max_lat ?? b.maxLat} · lon ${b.min_lon ?? b.minLon} ~ ${b.max_lon ?? b.maxLon}`);
    if (c.declared) console.log(`      meta 计数 : ${JSON.stringify(c.declared)}`);
    // 库内计数 vs meta 自报，对不上就是真问题（导入中断/WAL 未 checkpoint）
    if (c.declared) {
      for (const t of CORE_TABLES) {
        if (c.declared[t] !== undefined && c.declared[t] !== c.counts[t]) {
          console.log(`      ⚠ meta 自报 ${t}=${c.declared[t]}，实测 ${c.counts[t]}（不一致）`);
        }
      }
    }
  }
  console.log('');

  /* ---- ② 两两重叠 ---- */
  const overlaps = [];
  if (args.shards.length >= 2) {
    console.log('② 跨片同 id 重叠（OSM id 全局唯一 → 同 id 出现在两片就是"分区流式"的冲突面）');
    const orows = [];
    for (let i = 0; i < args.shards.length; i++) {
      for (let j = 0; j < args.shards.length; j++) {
        if (i === j) continue;
        const A = censuses[i];
        const B = args.shards[j];
        const r = overlap(args.shards[i], B, B.path, args.samples);
        overlaps.push(r);
        for (const kind of ['nodes', 'ways', 'relations']) {
          const k = r.kinds[kind];
          orows.push([
            `${A.id} ∩ ${B.id}`, kind, fmt(k.same),
            pct(k.same, A.counts[kind]), pct(k.same, censuses[j].counts[kind]),
            k.diff === null ? '-' : fmt(k.diff),
            k.derivedDiff === null ? '—' : fmt(k.derivedDiff),
          ]);
        }
      }
    }
    table(['A ∩ B', '类型', '同 id 条数', '占 A', '占 B', '内容真不一致', '派生几何不一致'], orows);
    console.log('  说明：内容真不一致 = version/tags/坐标/成员数 任一项不同（真冲突）；');
    console.log('        派生几何不一致 = 只有 bbox/length/LOD 这些"按本片可见成员算出来"的列不同（不是冲突，但按 id 合并会产生歧义）。');
    console.log('');
    for (const r of overlaps) {
      console.log(`  · ${r.pair[0]} 的数据 bbox 内，${r.pair[1]} 的点/面（bbox 见 ①，含完整 way 拉进来的离群点）：`);
      console.log(`      node 点落在 bbox 内 : ${fmt(r.nodesInsideOtherBbox)}`);
      console.log(`      way bbox 相交       : ${fmt(r.waysIntersectOtherBbox)}`);
      console.log(`      relation bbox 相交  : ${fmt(r.relationsIntersectOtherBbox)}`);
    }
    console.log('');
    // 样例：每对只打一个方向（A ∩ B 与 B ∩ A 是同一批 id），不一致的行排在前面
    if (args.samples > 0) {
      console.log(`③ 重叠样例对比（每类最多 ${args.samples} 条，a_ 是前一片、b_ 是后一片）`);
      for (let i = 0; i < args.shards.length; i++) {
        for (let j = i + 1; j < args.shards.length; j++) {
          const r = overlaps.find((x) => x.pair[0] === args.shards[i].id && x.pair[1] === args.shards[j].id);
          if (!r) continue;
          for (const kind of ['nodes', 'ways', 'relations']) {
            const k = r.kinds[kind];
            if (!k.examples || k.examples.length === 0) continue;
            console.log(`  · ${r.pair[0]} ∩ ${r.pair[1]} · ${kind}（同 id ${fmt(k.same)} 条`
              + ` · 内容真不一致 ${k.diff === null ? '-' : fmt(k.diff)} 条`
              + ` · 派生几何不一致 ${k.derivedDiff === null ? '—' : fmt(k.derivedDiff)} 条）`);
            for (const ex of k.examples) console.log('    ' + JSON.stringify(ex));
          }
        }
      }
      console.log('');
    }
  }

  /* ---- ⑤ 同 id 的成员级比对（refs / 成员列表） ---- */
  const memberDiffs = [];
  if (args.shards.length >= 2) {
    console.log('④ 同 id 的「成员级」比对：way 的 refs 序列 / relation 的成员列表');
    console.log('   （bbox 相同不等于 refs 相同 —— 两条不同折线可以有同一外接矩形，所以这一层必须直接比 refs）');
    const mrows = [];
    for (let i = 0; i < args.shards.length; i++) {
      for (let j = i + 1; j < args.shards.length; j++) {
        const A = args.shards[i];
        const B = args.shards[j];
        const m = memberDiff(A, B, B.path, args.samples);
        memberDiffs.push(m);
        mrows.push([
          `${A.id} ∩ ${B.id}`, 'way 的 refs',
          fmt(m.waysWithRefDiff), `${fmt(m.wayRefMismatchFromA)} / ${fmt(m.wayRefMismatchFromB)}`,
          fmt(m.waysRefIdentical),
        ]);
        mrows.push([
          `${A.id} ∩ ${B.id}`, 'relation 的成员',
          fmt(m.relsWithMemberDiff), `${fmt(m.relMemberMismatchFromA)} / ${fmt(m.relMemberMismatchFromB)}`,
          '—',
        ]);
      }
    }
    table(['A ∩ B', '比什么', '同 id 但列表不同', '错位位置数（A侧/B侧）', '逐位置全同'], mrows);
    console.log('');
    for (const m of memberDiffs) {
      console.log(`  · ${m.pair[0]} ∩ ${m.pair[1]} 独有（不在对方片里）的要素：`
        + `node ${fmt(m.nodesOnlyInB)} / way ${fmt(m.waysOnlyInB)} / relation ${fmt(m.relsOnlyInB)}`);
    }
    console.log('');
    console.log('  逐字段差异明细（直接回答"只是 version/tags 不同、几何相同"的条数）：');
    for (const m of memberDiffs) {
      const w = m.wayFieldDiffs;
      const r = m.relFieldDiffs;
      console.log(`    ${m.pair[0]} ∩ ${m.pair[1]} · way：version ${fmt(w.version)} · tags ${fmt(w.tags)}`
        + ` · node_count ${fmt(w.node_count)} · closed ${fmt(w.closed)}　→ **refs 序列不同 ${fmt(m.waysWithRefDiff)}**`);
      console.log(`    ${m.pair[0]} ∩ ${m.pair[1]} · relation：version ${fmt(r.version)} · tags ${fmt(r.tags)}`
        + ` · member_count ${fmt(r.member_count)}　→ **成员列表不同 ${fmt(m.relsWithMemberDiff)}**`);
    }
    console.log('  说明：「错位位置数」= (way_id,seq) 或 (relation_id,seq) 这个位置上对方的 node_id/成员不存在或不相同的个数；');
    console.log('        它是 0 就说明两条同 id 要素的 refs/成员**逐位置完全一致**，不存在"各截一段"。');
    console.log('');
  }

  /* ---- ⑥ 样例人工比对 ---- */
  if (args.shards.length >= 2 && args.samples > 0 && memberDiffs.length) {
    console.log('⑤ 成员级样例（用于人工比对：a 是前一片、b 是后一片）');
    for (const m of memberDiffs) {
      console.log(`  ── ${m.pair[0]} ∩ ${m.pair[1]} · 样例挑选依据：${m.exampleBasis}`);
      console.log('  way 样例（refs 前 5 个 + 末尾 2 个 + 名字）：');
      for (const e of m.wayExamples) {
        console.log(`    way ${e.id}  ${e.label ? '「' + e.label + '」' : '(无 name/ref 标签)'}  version=${e.aVersion}`
          + (e.criterion ? `  [${e.criterion}]` : ''));
        console.log(`      节点范围 lat ${e.extreme.minLat}~${e.extreme.maxLat} / lon ${e.extreme.minLon}~${e.extreme.maxLon}`);
        console.log(`      ${m.pair[0]} node_count=${e.aNodeCount}  refs 前5=${JSON.stringify(e.aFirst5)} 末2=${JSON.stringify(e.aLast2)}`);
        console.log(`      ${m.pair[1]} node_count=${e.bNodeCount}  refs 前5=${JSON.stringify(e.bFirst5)} 末2=${JSON.stringify(e.bLast2)}`);
        console.log(`      → refs ${e.identical ? '**逐位置完全一致 ✔**' : '不一致 ✘'}`
          + `（公共前缀长度 ${e.relation.samePrefix}，一侧是另一侧前缀：${e.relation.prefixOnly}，b 侧节点落在 a 侧的比例 ${e.relation.commonInY}）`);
      }
      console.log('  relation 样例（member_count + 成员前 3 个 + 成员几何在本片可解析数）：');
      for (const e of m.relationExamples) {
        console.log(`    rel ${e.id}  ${e.label ? '「' + e.label + '」' : '(无 name/ref 标签)'}  version=${e.aVersion}`);
        console.log(`      ${m.pair[0]} member_count=${e.aMemberCount} 可解析成员=${e.aResolvable}  前3=${JSON.stringify(e.aFirst3)}`);
        console.log(`      ${m.pair[1]} member_count=${e.bMemberCount} 可解析成员=${e.bResolvable}  前3=${JSON.stringify(e.bFirst3)}`);
        console.log(`      → 成员列表 ${e.identical ? '**逐位置完全一致 ✔**' : '不一致 ✘'}`);
      }
      console.log('');
    }
  }

  /* ---- ⑦ 单片"跨界要素画像"：data_bbox 远大于 source_bounds 是良性溢出还是真数据 ---- */
  console.log('⑥ 跨界要素画像（data_bbox 为什么远大于 source_bounds）');
  const spills = [];
  for (const s of args.shards) {
    const p = spillProfile(s);
    if (!p) continue;
    spills.push(p);
    const rate = (p.nodesOutside / (censuses.find((c) => c.id === s.id) || {}).counts.nodes * 100).toFixed(4);
    console.log(`  · ${p.id}  声明框 lat ${p.sourceBounds.min_lat}~${p.sourceBounds.max_lat} / lon ${p.sourceBounds.min_lon}~${p.sourceBounds.max_lon}`);
    console.log(`      框外节点 ${fmt(p.nodesOutside)}（占全片 ${rate}%），其中**带标签** ${fmt(p.nodesOutsideTagged)}`
      + `（占框外 ${(p.nodesOutsideTagged / (p.nodesOutside || 1) * 100).toFixed(1)}%）`);
    console.log(`      牵涉到框外节点的 way：${fmt(p.waysTouchingOutside)} 条`);
    console.log(`      框外节点被几条 way 引用（引用数 → 节点数）：`
      + p.refHistogram.map((h) => `${h.cnt}→${fmt(h.n)}`).join(' · '));
  }
  console.log('');

  /* ---- ③ bbox 路由 ---- */
  console.log('⑦ bbox 路由判定演示');
  const route = routeBbox(args.shards, args.bbox);
  table(['分片', '框内 node 点', 'bbox 相交 way', 'bbox 相交 relation'],
    route.map((r) => [r.id, fmt(r.nodes), fmt(r.ways), fmt(r.relations)]));
  const owners = route.filter((r) => r.nodes > 0).map((r) => r.id);
  console.log('');
  console.log('  点（node）归属 → 命中分片：' + (owners.length ? owners.join(', ') : '(无)')
    + `　·　命中分片数 ${owners.length}`);
  console.log('  注：node 是点，落框判定精确；way/relation 用 R*Tree 外接矩形相交，长条要素跨片属正常上界。');
  console.log('');

  if (args.json) {
    console.log('--- JSON ---');
    console.log(JSON.stringify({
      shards: censuses.map((c) => ({
        id: c.id, path: path.relative(ROOT, c.path), bytes: c.bytes, walBytes: c.walBytes,
        counts: c.counts, rtree: c.rtree, meta: c.meta, dataBbox: c.dataBbox, measuredBbox: c.bbox,
      })),
      overlaps: overlaps.map((r) => ({
        pair: r.pair,
        kinds: Object.fromEntries(Object.entries(r.kinds).map(([k, v]) => [k, { same: v.same, diff: v.diff, derivedDiff: v.derivedDiff }])),
        nodesInsideOtherBbox: r.nodesInsideOtherBbox,
        waysIntersectOtherBbox: r.waysIntersectOtherBbox,
        relationsIntersectOtherBbox: r.relationsIntersectOtherBbox,
      })),
      bbox: args.bbox,
      route,
      memberDiffs: memberDiffs.map((m) => ({
        pair: m.pair,
        waysWithRefDiff: m.waysWithRefDiff,
        wayRefMismatchFromA: m.wayRefMismatchFromA,
        wayRefMismatchFromB: m.wayRefMismatchFromB,
        waysRefIdentical: m.waysRefIdentical,
        relsWithMemberDiff: m.relsWithMemberDiff,
        relMemberMismatchFromA: m.relMemberMismatchFromA,
        relMemberMismatchFromB: m.relMemberMismatchFromB,
        wayFieldDiffs: m.wayFieldDiffs,
        relFieldDiffs: m.relFieldDiffs,
        onlyInB: { nodes: m.nodesOnlyInB, ways: m.waysOnlyInB, relations: m.relsOnlyInB },
        wayExamples: m.wayExamples,
        relationExamples: m.relationExamples,
      })),
      spills,
    }, null, 2));
    console.log('--- /JSON ---');
    console.log('');
  }

  console.log('完成。');
  process.exit(0);
}

main();
