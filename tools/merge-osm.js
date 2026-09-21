'use strict';
/**
 * OSM 数据集**合并**工具（零第三方依赖，只用 Node 内置模块）
 *
 * 用途：把一个"只含某个新区域"的 OSM 库（由 `tools/import-osm.js` + `tools/fetch-overpass.js`
 * 得到）**追加**进一个已经在用的库（例如北京数据集），做成"北京 + 河北某市"在同一份库里。
 *
 * 为什么需要这个工具：`tools/import-osm.js` 是**整库导入**语义 ——
 *   目标库非空时直接报错，`--force` 又会 `DELETE FROM` 掉 nodes/ways/relations/way_nodes/
 *   relation_members 与三个 R*Tree 索引、changesets、changes。对一份**有人编辑过**的库
 *   （线上库现有 710 个 changeset / 1.4 万条 change，还有 67 个车站、13 条线路、35 台车）
 *   来说，"重新导入"等于把玩家的全部成果删掉。所以增量导入必须走合并，不能走 --force。
 *
 * 用法：
 *   node tools/merge-osm.js --src <new-region.sqlite> --db <target.sqlite>
 *                         [--dry-run] [--no-lod-refill] [--quiet]
 *
 * 合并口径（每一项都是"只碰新增行"，既有数据一行不动）：
 *   1) 只复制 5 张 OSM 元素表（nodes / ways / way_nodes / relations / relation_members），
 *      **不复制** changesets / changes（那是目标库自己的编辑历史）与 transit/population 表；
 *   2) 一律 `INSERT OR IGNORE` —— id 撞上了就保留目标库原有的行，**绝不覆盖**玩家编辑；
 *   3) 新 way 的 bbox / length、新 relation 的 bbox **重新算**（不照抄来源库的值），
 *      因为坐标的权威来源是 nodes，重算顺带能把来源库的坏几何挡在外面；
 *   4) 三个 R*Tree 索引只给新增行补行。**列序必须是
 *      `(id, min_lon, max_lon, min_lat, max_lat)` 对 `(id, min_lon, max_lon, min_lat, max_lat)`** ——
 *      `tools/import-osm.js` 的 backfillGeometry 有个历史笔误：第 5 列 max_lat 里塞的是 max_lon
 *      （见 `server/osmdb.js` 的 `_auditSpatialIndexes` 与 tests/tmp-lodsvr/probe-index-audit.js）。
 *      线上库已经被启动自检修好了，本工具**不能**再把那个错位引回来，所以这里自己写正确的列序，
 *      而不是去复用导入器那段 SQL；
 *   5) `ways.road_class` / `ways.lod_zoom` 必须**整表强制重填**。原因见下面 `describeLodTrap()`：
 *      这两列的启动回填是"抽 3000 行核对、对得上就一行不动"的幂等设计，而抽样是
 *      `SELECT ... FROM ways LIMIT 3000`（rowid 序 = 最小 id 那批，全是老数据），
 *      所以新追加的行即使 road_class/lod_zoom 是 NULL，抽检也会通过、回填**不会**触发，
 *      于是这些 way 在 z ≤ 13 的索引路径（`WHERE lod_zoom <= zoom`）上**永远查不到**（NULL 比较为假）。
 *
 * 幂等：重复执行同一份 --src 不会产生重复行（INSERT OR IGNORE + 主键），只是白算一遍几何。
 */
const fs = require('fs');
const path = require('path');

// node:sqlite 在 require 阶段就会打印 ExperimentalWarning，这里提前静音（与其它工具一致）
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};

const { openDatabase, setMeta, getMeta, backfillWayLod, ensureLodIndexes } = require('../server/dbschema.js');
const { wayLodKeysOf } = require('../server/osmdb.js');
const { metersBetween } = require('./import-osm.js');

const BATCH = 50000;

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 这两列为什么必须强制重填（把病根写清楚，免得后人"优化"掉这次重填） */
function describeLodTrap() {
  return [
    'road_class / lod_zoom 的启动回填是幂等的：先比对 meta.way_lod_backfill 指纹，',
    '一致就只抽 ways 表前 3000 行核对（`SELECT id, tags, road_class, lod_zoom FROM ways LIMIT 3000`，',
    'rowid 序 → 抽到的全是 id 最小的老行）。新追加的 Hebei 行 id 都在后面、抽不到，',
    '于是"抽检通过 → 不回填 → 新行 lod_zoom 仍是 NULL"；而 z ≤ 13 的 way 候选扫描走',
    '`FROM ways INDEXED BY idx_ways_lod_zoom WHERE lod_zoom <= zoom`，NULL 比较为假 → 新区域整片消失。',
    '所以合并后必须 force 重填一次。',
  ].join('\n * ');
}

/** 目标库里各表的行数（合并前后对比用） */
function countsOf(db, schema = 'main') {
  const q = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${schema}.${t}`).get().c;
  return {
    nodes: q('nodes'), ways: q('ways'), relations: q('relations'),
    way_nodes: q('way_nodes'), relation_members: q('relation_members'),
  };
}

/**
 * 执行合并。
 * @param {{src:string, db:string, quiet?:boolean, dryRun?:boolean, lodRefill?:boolean}} options
 */
async function mergeOsm(options) {
  const t0 = Date.now();
  const srcFile = options.src;
  const dbFile = options.db;
  const quiet = !!options.quiet;
  const dryRun = !!options.dryRun;
  const lodRefill = options.lodRefill !== false;
  const log = quiet ? () => {} : (m) => process.stdout.write(m + '\n');

  if (!srcFile || !dbFile) throw new Error('必须同时指定 --src 与 --db');
  if (!fs.existsSync(srcFile)) throw new Error('找不到来源库：' + srcFile);
  if (!fs.existsSync(dbFile)) throw new Error('找不到目标库：' + dbFile);
  if (path.resolve(srcFile) === path.resolve(dbFile)) throw new Error('--src 与 --db 不能是同一个文件');

  const db = openDatabase(dbFile);
  let attached = false;
  try {
    const before = countsOf(db);

    db.exec(`ATTACH DATABASE '${path.resolve(srcFile).replace(/\\/g, '/').replace(/'/g, "''")}' AS src`);
    attached = true;
    const srcCounts = countsOf(db, 'src');
    if (!srcCounts.nodes && !srcCounts.ways) throw new Error('来源库里没有 OSM 数据：' + srcFile);

    log(`· 来源库 ${path.basename(srcFile)}：nodes=${srcCounts.nodes} ways=${srcCounts.ways} relations=${srcCounts.relations}`);
    log(`· 目标库 ${path.basename(dbFile)}：nodes=${before.nodes} ways=${before.ways} relations=${before.relations}`);

    if (dryRun) {
      db.exec('DETACH DATABASE src');
      attached = false;
      return { dryRun: true, src: srcFile, db: dbFile, before, srcCounts, ms: Date.now() - t0 };
    }

    /* -------- 1) 新增 id 清单（后续所有"只碰新增行"的步骤都靠这三张临时表） -------- */
    db.exec('BEGIN');
    db.exec('DROP TABLE IF EXISTS temp.new_nodes');
    db.exec('DROP TABLE IF EXISTS temp.new_ways');
    db.exec('DROP TABLE IF EXISTS temp.new_relations');
    db.exec('CREATE TEMP TABLE new_nodes(id INTEGER PRIMARY KEY)');
    db.exec('CREATE TEMP TABLE new_ways(id INTEGER PRIMARY KEY)');
    db.exec('CREATE TEMP TABLE new_relations(id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO new_nodes(id) SELECT id FROM src.nodes');
    db.exec('INSERT INTO new_ways(id) SELECT id FROM src.ways');
    db.exec('INSERT INTO new_relations(id) SELECT id FROM src.relations');
    db.exec('COMMIT');

    /* -------- 2) 复制 5 张 OSM 元素表（INSERT OR IGNORE：绝不覆盖既有行） -------- */
    db.exec('BEGIN');
    const ins = [
      ['nodes', 'id, lat, lon, version, tags, editor, editor_name, ts, deleted'],
      ['ways', 'id, version, tags, editor, editor_name, ts, deleted, node_count, closed'],
      ['way_nodes', 'way_id, seq, node_id'],
      ['relations', 'id, version, tags, editor, editor_name, ts, deleted, member_count'],
      ['relation_members', 'relation_id, seq, member_type, member_ref, role'],
    ];
    const inserted = {};
    for (const [table, cols] of ins) {
      const stmt = db.prepare(`INSERT OR IGNORE INTO ${table}(${cols}) SELECT ${cols} FROM src.${table}`);
      const r = stmt.run();
      inserted[table] = Number(r.changes);
      log(`· 复制 ${table}：新增 ${inserted[table]} 行`);
    }
    db.exec('COMMIT');
    const elementMs = Date.now() - t0;

    /* -------- 3) 新 way 的 bbox（用 nodes 重算，不照抄来源库） -------- */
    log('· 重算新 way 的 bbox / length、新 relation 的 bbox，并补空间索引 …');
    const g0 = Date.now();
    db.exec('BEGIN');
    db.exec('DROP TABLE IF EXISTS temp.new_way_bbox');
    db.exec('CREATE TEMP TABLE new_way_bbox(id INTEGER PRIMARY KEY, min_lat REAL, max_lat REAL, min_lon REAL, max_lon REAL)');
    db.exec(`INSERT INTO temp.new_way_bbox(id, min_lat, max_lat, min_lon, max_lon)
             SELECT wn.way_id, MIN(n.lat), MAX(n.lat), MIN(n.lon), MAX(n.lon)
             FROM way_nodes wn JOIN nodes n ON n.id = wn.node_id
             WHERE wn.way_id IN (SELECT id FROM temp.new_ways)
             GROUP BY wn.way_id`);
    db.exec(`UPDATE ways SET min_lat = b.min_lat, max_lat = b.max_lat, min_lon = b.min_lon, max_lon = b.max_lon
             FROM temp.new_way_bbox b WHERE ways.id = b.id`);
    const geomWays = db.prepare('SELECT COUNT(*) AS c FROM temp.new_way_bbox').get().c;

    /* -------- 4) 新 way 的 length（按 (way_id, seq) 有序流式遍历，内存只留当前 way） -------- */
    const stSetLength = db.prepare('UPDATE ways SET length = ? WHERE id = ?');
    const cursor = db.prepare(`SELECT wn.way_id AS way_id, n.lat AS lat, n.lon AS lon
                               FROM way_nodes wn JOIN nodes n ON n.id = wn.node_id
                               WHERE wn.way_id IN (SELECT id FROM temp.new_ways)
                               ORDER BY wn.way_id, wn.seq`).iterate();
    let curWay = -1; let prevLat = 0; let prevLon = 0; let acc = 0; let lengthWays = 0;
    for (const row of cursor) {
      if (row.way_id !== curWay) {
        if (curWay !== -1) { stSetLength.run(Math.round(acc * 10) / 10, curWay); lengthWays++; }
        curWay = row.way_id; acc = 0; prevLat = row.lat; prevLon = row.lon;
        continue;
      }
      acc += metersBetween(prevLat, prevLon, row.lat, row.lon);
      prevLat = row.lat; prevLon = row.lon;
    }
    if (curWay !== -1) { stSetLength.run(Math.round(acc * 10) / 10, curWay); lengthWays++; }
    db.exec('COMMIT');

    /* -------- 5) 新 relation 的 bbox（way 成员用 way 的 bbox，node 成员退化成自身） -------- */
    db.exec('BEGIN');
    db.exec('DROP TABLE IF EXISTS temp.new_rel_bbox_raw');
    db.exec('CREATE TEMP TABLE new_rel_bbox_raw(relation_id INTEGER, min_lat REAL, max_lat REAL, min_lon REAL, max_lon REAL)');
    db.exec(`INSERT INTO temp.new_rel_bbox_raw(relation_id, min_lat, max_lat, min_lon, max_lon)
             SELECT rm.relation_id, w.min_lat, w.max_lat, w.min_lon, w.max_lon
             FROM relation_members rm JOIN ways w ON w.id = rm.member_ref
             WHERE rm.member_type = 'way' AND w.min_lat IS NOT NULL
               AND rm.relation_id IN (SELECT id FROM temp.new_relations)`);
    db.exec(`INSERT INTO temp.new_rel_bbox_raw(relation_id, min_lat, max_lat, min_lon, max_lon)
             SELECT rm.relation_id, n.lat, n.lat, n.lon, n.lon
             FROM relation_members rm JOIN nodes n ON n.id = rm.member_ref
             WHERE rm.member_type = 'node'
               AND rm.relation_id IN (SELECT id FROM temp.new_relations)`);
    db.exec(`UPDATE relations SET min_lat = b.min_lat, max_lat = b.max_lat, min_lon = b.min_lon, max_lon = b.max_lon
             FROM (SELECT relation_id, MIN(min_lat) AS min_lat, MAX(max_lat) AS max_lat,
                          MIN(min_lon) AS min_lon, MAX(max_lon) AS max_lon
                   FROM temp.new_rel_bbox_raw GROUP BY relation_id) b
             WHERE relations.id = b.relation_id`);
    db.exec('DROP TABLE temp.new_rel_bbox_raw');
    db.exec('COMMIT');

    /* -------- 6) 三个 R*Tree 索引：只给新增行补行，列序按 rtree 定义一一对应 -------- */
    db.exec('BEGIN');
    db.exec(`INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat)
             SELECT id, lon, lon, lat, lat FROM nodes WHERE id IN (SELECT id FROM temp.new_nodes)`);
    // 注意第 5 列是 max_lat（不是 max_lon）—— 导入器的历史笔误不要在这里复现
    db.exec(`INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat)
             SELECT id, min_lon, max_lon, min_lat, max_lat FROM ways
             WHERE min_lon IS NOT NULL AND id IN (SELECT id FROM temp.new_ways)`);
    db.exec(`INSERT OR REPLACE INTO relation_index(id, min_lon, max_lon, min_lat, max_lat)
             SELECT id, min_lon, max_lon, min_lat, max_lat FROM relations
             WHERE min_lon IS NOT NULL AND id IN (SELECT id FROM temp.new_relations)`);
    db.exec('COMMIT');
    const geometryMs = Date.now() - g0;

    const idx = {
      node_index: db.prepare('SELECT COUNT(*) AS c FROM node_index').get().c,
      way_index: db.prepare('SELECT COUNT(*) AS c FROM way_index').get().c,
      relation_index: db.prepare('SELECT COUNT(*) AS c FROM relation_index').get().c,
    };

    /* -------- 7) road_class / lod_zoom：整表强制重填（见 describeLodTrap） -------- */
    let lodFilled = false;
    if (lodRefill) {
      const l0 = Date.now();
      // 先把指纹抹掉，这样即使 backfillWayLod 内部逻辑变化也会走整表重填；
      // 传 force 是显式意图，抹指纹是"万一 force 没被遵守"的兜底。
      db.prepare('DELETE FROM meta WHERE key = ?').run('way_lod_backfill');
      lodFilled = backfillWayLod(db, wayLodKeysOf, { force: true }) === true;
      const lodIndexed = ensureLodIndexes(db) === true;
      const nulls = db.prepare('SELECT SUM(road_class IS NULL) rc, SUM(lod_zoom IS NULL) lod FROM ways').get();
      log(`· road_class / lod_zoom 强制重填：${lodFilled ? '成功' : '失败'}（剩余 NULL：road_class=${nulls.rc} lod_zoom=${nulls.lod}），`
        + `低缩放索引 ${lodIndexed ? '就绪' : '不可用'}，${Date.now() - l0} ms`);
      if (!lodFilled || nulls.lod) {
        throw new Error('road_class / lod_zoom 回填失败或仍有 NULL —— 新区域在 z<=13 会查不到，已中止（库已写入，请重跑修复）');
      }
    } else {
      log('· --no-lod-refill：跳过了 road_class / lod_zoom 重填（新区域在 z<=13 将不可见，除非启动前手动重填）');
    }

    /* -------- 8) meta：计数 / bbox / next_*_id（必须取大，免得新元素撞上已用 id） -------- */
    const after = countsOf(db);
    const box = db.prepare('SELECT MIN(lat) AS min_lat, MAX(lat) AS max_lat, MIN(lon) AS min_lon, MAX(lon) AS max_lon FROM nodes').get();
    const maxDbId = {
      node: db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM nodes').get().m,
      way: db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM ways').get().m,
      relation: db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM relations').get().m,
    };
    const srcNext = {
      node: Number(getMeta(db, 'next_node_id', 0)) || 0,
      way: Number(getMeta(db, 'next_way_id', 0)) || 0,
      relation: Number(getMeta(db, 'next_relation_id', 0)) || 0,
    };
    // 来源库的 next_*_id 读得到就取大（它已经大于来源文件里出现过的任何 id）
    const srcNextMeta = db.prepare("SELECT key, value FROM src.meta WHERE key IN ('next_node_id','next_way_id','next_relation_id')").all();
    for (const r of srcNextMeta) {
      const v = Number(r.value) || 0;
      if (r.key === 'next_node_id') srcNext.node = Math.max(srcNext.node, v);
      else if (r.key === 'next_way_id') srcNext.way = Math.max(srcNext.way, v);
      else if (r.key === 'next_relation_id') srcNext.relation = Math.max(srcNext.relation, v);
    }
    // 来源库的 source_file 在 **src.meta** 里（读 main.meta 会拿到目标库自己的来源文件名，
    // 那样就变成"北京合并了北京"，把真正的来源记丢了）
    const srcRow = db.prepare("SELECT value FROM src.meta WHERE key = 'source_file'").get();
    const srcName = String((srcRow && srcRow.value) || path.basename(srcFile));
    const prevMerged = String(db.prepare("SELECT value FROM meta WHERE key='merged_sources'").get()?.value || '');
    const mergedList = (prevMerged ? prevMerged.split(',') : []).filter(Boolean);
    if (!mergedList.includes(srcName)) mergedList.push(srcName);

    db.exec('BEGIN');
    setMeta(db, 'counts', JSON.stringify(after));
    if (box.min_lat !== null) {
      setMeta(db, 'data_bbox', JSON.stringify({
        min_lat: box.min_lat, min_lon: box.min_lon, max_lat: box.max_lat, max_lon: box.max_lon,
      }));
    }
    // 记录合并进来的来源清单；source_file 保持目标库原本的值不动（它是"原库从哪来"）
    setMeta(db, 'merged_sources', mergedList.join(','));
    setMeta(db, 'merged_at', new Date().toISOString());
    setMeta(db, 'next_node_id', Math.max(srcNext.node, maxDbId.node + 1));
    setMeta(db, 'next_way_id', Math.max(srcNext.way, maxDbId.way + 1));
    setMeta(db, 'next_relation_id', Math.max(srcNext.relation, maxDbId.relation + 1));
    db.exec('COMMIT');

    db.exec('DETACH DATABASE src');
    attached = false;
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }

    const dbBytes = fs.statSync(dbFile).size;
    return {
      src: srcFile, db: dbFile, ms: Date.now() - t0, elementMs, geometryMs,
      before, after, inserted, srcCounts,
      geometry: { waysWithBbox: geomWays, waysWithLength: lengthWays },
      indexes: idx, lodFilled, dbBytes,
      dataBbox: box.min_lat === null ? null : box,
      nextIds: { node: Math.max(srcNext.node, maxDbId.node + 1), way: Math.max(srcNext.way, maxDbId.way + 1), relation: Math.max(srcNext.relation, maxDbId.relation + 1) },
    };
  } finally {
    if (attached) { try { db.exec('DETACH DATABASE src'); } catch { /* ignore */ } }
    try { db.close(); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ *
 * 命令行
 * ------------------------------------------------------------------ */
const USAGE = [
  '用法：node tools/merge-osm.js --src <new-region.sqlite> --db <target.sqlite> [--dry-run] [--no-lod-refill] [--quiet]',
  '  --src            来源库（只含新区域的 OSM 数据，由 import-osm.js 生成）',
  '  --db             目标库（会被就地追加，既有数据不覆盖）',
  '  --dry-run        只打印两侧计数，不写入',
  '  --no-lod-refill  跳过 road_class / lod_zoom 整表重填（不推荐，见文件头说明）',
  '  --quiet          只打印一行摘要',
].join('\n');

function parseArgs(argv) {
  const out = { src: null, db: null, dryRun: false, lodRefill: true, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const take = () => { if (inline !== null) return inline; i++; if (i >= argv.length) throw new Error('参数 ' + key + ' 缺少取值'); return argv[i]; };
    switch (key) {
      case '--src': out.src = take(); break;
      case '--db': out.db = take(); break;
      case '--dry-run': out.dryRun = true; break;
      case '--no-lod-refill': out.lodRefill = false; break;
      case '--quiet': case '-q': out.quiet = true; break;
      case '--help': case '-h': out.help = true; break;
      default: if (key.startsWith('-')) throw new Error('未知参数：' + key); break;
    }
  }
  return out;
}

function printSummary(r) {
  const d = (k) => `${r.before[k]} → ${r.after[k]}（+${r.after[k] - r.before[k]}）`;
  process.stdout.write([
    '',
    '===== OSM 合并结果 =====',
    `来源库        : ${path.basename(r.src)}`,
    `目标库        : ${r.db}（${formatBytes(r.dbBytes)}）`,
    `nodes         : ${d('nodes')}`,
    `ways          : ${d('ways')}`,
    `relations     : ${d('relations')}`,
    `way_nodes     : ${d('way_nodes')}`,
    `relation_members: ${d('relation_members')}`,
    `新算几何      : way bbox ${r.geometry.waysWithBbox} 条、way length ${r.geometry.waysWithLength} 条`,
    `空间索引      : node=${r.indexes.node_index} way=${r.indexes.way_index} relation=${r.indexes.relation_index}`,
    `road_class/lod_zoom 重填: ${r.lodFilled ? '已重填' : '未重填（z<=13 新区域不可见）'}`,
    `数据 bbox     : ${JSON.stringify(r.dataBbox)}`,
    `next ids      : node=${r.nextIds.node} way=${r.nextIds.way} relation=${r.nextIds.relation}`,
    `耗时          : ${(r.ms / 1000).toFixed(1)}s（元素写入 ${(r.elementMs / 1000).toFixed(1)}s，几何 ${(r.geometryMs / 1000).toFixed(1)}s）`,
    '========================',
    '· road_class / lod_zoom 为什么必须重填：\n * ' + describeLodTrap(),
  ].join('\n') + '\n');
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) {
    process.stderr.write('参数错误：' + err.message + '\n' + USAGE + '\n');
    process.exitCode = 1;
    return;
  }
  if (args.help || !args.src || !args.db) {
    process.stdout.write(USAGE + '\n');
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  try {
    const r = await mergeOsm(args);
    if (args.quiet) {
      process.stdout.write(`合并完成：nodes=${r.after.nodes} ways=${r.after.ways} relations=${r.after.relations} `
        + `(+${r.inserted.nodes}/${r.inserted.ways}/${r.inserted.relations}) 耗时=${(r.ms / 1000).toFixed(1)}s\n`);
    } else if (r.dryRun) {
      process.stdout.write(`· --dry-run：目标 nodes=${r.before.nodes} ways=${r.before.ways}；`
        + `来源 nodes=${r.srcCounts.nodes} ways=${r.srcCounts.ways}；未写入\n`);
    } else {
      printSummary(r);
    }
  } catch (err) {
    process.stderr.write('合并失败：' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { mergeOsm, countsOf, describeLodTrap, formatBytes };
