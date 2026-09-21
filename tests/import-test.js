'use strict';
/**
 * OSM 流式导入器自动化测试
 *
 * 运行：node tests/import-test.js
 *
 * 覆盖：
 *   - 命令行导入 tiny.osm（含 --quiet 只输出一行）
 *   - 行数 / 字段 / tags / bbox / length / 空间索引 / meta 的逐项断言
 *   - visible="false" 的元素被跳过
 *   - 重复导入（不带 --force）必须失败，且错误信息里要有 --force
 *   - --force 重新导入不产生重复数据
 *   - --limit 只导入前 N 个元素（node / way / relation 各自计数），且到达上限后能安全断开输入流
 *   - .osm.gz 走 gunzip 流式解压路径
 *   - 参数/文件错误时退出码为 1
 *
 * 注意：本环境沙箱禁止带管道的子进程 stdio，因此子进程一律 stdio:'ignore'，
 * 需要检查输出时把 stdout 重定向到普通文件（不是管道）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

// node:sqlite 的 ExperimentalWarning 在 require 阶段就会打印，先静音（与 server/dbschema.js 一致）
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};

const { openDatabase } = require('../server/dbschema.js');
const importer = require('../tools/import-osm.js');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'import-osm.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'tiny.osm');

const TMP_DB = path.join(__dirname, 'tmp-import.sqlite');
const LIMIT_DB = path.join(__dirname, 'tmp-import-limit.sqlite');
const ABORT_DB = path.join(__dirname, 'tmp-import-abort.sqlite');
const GZ_DB = path.join(__dirname, 'tmp-import-gz.sqlite');
const TMP_GZ = path.join(__dirname, 'tmp-tiny.osm.gz');
const TMP_ABORT_OSM = path.join(__dirname, 'tmp-abort.osm');
const QUIET_OUT = path.join(__dirname, 'tmp-quiet-out.txt');

/** --limit 提前收工时用的临时文件：三种元素都超过 2 个，确保中途就断开输入流 */
const ABORT_OSM = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="abort-fixture">
  <node id="1" lat="39.90" lon="116.40"/>
  <node id="2" lat="39.91" lon="116.41"/>
  <node id="3" lat="39.92" lon="116.42"/>
  <node id="4" lat="39.93" lon="116.43"/>
  <way id="10" version="1"><nd ref="1"/><nd ref="2"/></way>
  <way id="20" version="1"><nd ref="2"/><nd ref="3"/></way>
  <way id="30" version="1"><nd ref="3"/><nd ref="4"/></way>
  <relation id="100" version="1"><member type="way" ref="10" role="outer"/></relation>
  <relation id="200" version="1"><member type="way" ref="20" role="outer"/></relation>
  <relation id="300" version="1"><member type="way" ref="30" role="outer"/></relation>
</osm>
`;

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('✅ ' + name);
  } else {
    failed++;
    console.log('❌ ' + name + (detail === undefined ? '' : '  →  ' + detail));
  }
}

/** 值相等（对象/数组按 JSON 比较） */
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `期望 ${b}，实际 ${a}`);
}

function near(name, actual, expected, eps) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= eps;
  check(name, ok, `期望 ${expected}±${eps}，实际 ${actual}`);
}

function one(db, sql, ...params) { return db.prepare(sql).get(...params); }
function many(db, sql, ...params) { return db.prepare(sql).all(...params); }

/* ------------------------------------------------------------------ *
 * 临时文件工具
 * ------------------------------------------------------------------ */
function sqliteFiles(base) {
  return [base, base + '-wal', base + '-shm', base + '-journal'];
}

function removeTmp(base) {
  for (const f of sqliteFiles(base)) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

function cleanupAll() {
  removeTmp(TMP_DB);
  removeTmp(LIMIT_DB);
  removeTmp(ABORT_DB);
  removeTmp(GZ_DB);
  try { fs.rmSync(TMP_GZ, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(TMP_ABORT_OSM, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(QUIET_OUT, { force: true }); } catch { /* ignore */ }
}

/** 跑一次 CLI，子进程输出全部丢弃（避免沙箱的管道限制）；超时视为失败，防止测试挂死 */
function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: 'ignore', timeout: 120000 });
}

/** 跑一次 CLI，把 stdout 重定向到普通文件后读回来 */
function runCliCapture(args, outFile) {
  const fd = fs.openSync(outFile, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [CLI, ...args],
      { cwd: ROOT, stdio: ['ignore', fd, 'ignore'], timeout: 120000 });
  } finally {
    fs.closeSync(fd);
  }
  return { status: res.status, out: fs.readFileSync(outFile, 'utf8') };
}

/* ------------------------------------------------------------------ *
 * 测试主体
 * ------------------------------------------------------------------ */
async function main() {
  cleanupAll();

  /* ---------------- 1. CLI 导入 tiny.osm ---------------- */
  console.log('\n=== 1. 命令行导入 tests/fixtures/tiny.osm ===');
  const cap = runCliCapture(['--file', FIXTURE, '--db', TMP_DB, '--quiet'], QUIET_OUT);
  eq('CLI 导入退出码为 0', cap.status, 0);
  const quietLines = cap.out.split(/\r?\n/).filter((l) => l.trim() !== '');
  eq('--quiet 只在最后打印一行', quietLines.length, 1);
  check('--quiet 那一行包含 nodes/ways/relations 统计',
    /nodes=8/.test(cap.out) && /ways=2/.test(cap.out) && /relations=1/.test(cap.out), cap.out.trim());

  /* ---------------- 2. 数据断言 ---------------- */
  console.log('\n=== 2. 行数与字段断言 ===');
  const db = openDatabase(TMP_DB);

  // 行数
  eq('nodes 表 8 行', one(db, 'SELECT COUNT(*) AS c FROM nodes').c, 8);
  eq('visible="false" 的 node 9 被跳过', one(db, 'SELECT COUNT(*) AS c FROM nodes WHERE id = 9').c, 0);
  eq('ways 表 2 行', one(db, 'SELECT COUNT(*) AS c FROM ways').c, 2);
  eq('visible="false" 的 way 300 被跳过', one(db, 'SELECT COUNT(*) AS c FROM ways WHERE id = 300').c, 0);
  eq('relations 表 1 行', one(db, 'SELECT COUNT(*) AS c FROM relations').c, 1);
  eq('way_nodes 表 8 行（3 + 5）', one(db, 'SELECT COUNT(*) AS c FROM way_nodes').c, 8);
  eq('relation_members 表 1 行', one(db, 'SELECT COUNT(*) AS c FROM relation_members').c, 1);

  // node 1
  const n1 = one(db, 'SELECT * FROM nodes WHERE id = 1');
  eq('node 1 lat = 39.9', n1.lat, 39.9);
  eq('node 1 lon = 116.4', n1.lon, 116.4);
  eq('node 1 version = 2', n1.version, 2);
  eq('node 1 deleted = 0', n1.deleted, 0);
  const n1tags = JSON.parse(n1.tags);
  eq('node 1 tags.name = 天安门东', n1tags.name, '天安门东');
  eq('node 1 tags.highway = bus_stop', n1tags.highway, 'bus_stop');
  eq('node 1 editor = uid(11)', n1.editor, '11');
  eq('node 1 editor_name = user(alice)', n1.editor_name, 'alice');
  eq('node 1 ts 为毫秒时间戳', n1.ts, Date.parse('2020-01-02T03:04:05Z'));
  const n2 = one(db, 'SELECT version, tags, editor, editor_name, ts FROM nodes WHERE id = 2');
  eq('node 2（无 tag/无 user）tags 为 NULL', n2.tags, null);
  eq('node 2 version 默认 1', n2.version, 1);
  eq('node 2 ts 为 NULL', n2.ts, null);

  // way 100
  const w100 = one(db, 'SELECT * FROM ways WHERE id = 100');
  eq('way 100 node_count = 3', w100.node_count, 3);
  eq('way 100 closed = 0（首尾不同）', w100.closed, 0);
  eq('way 100 version = 4', w100.version, 4);
  const w100tags = JSON.parse(w100.tags);
  eq('way 100 tags.highway = residential', w100tags.highway, 'residential');
  eq('way 100 tags.name = 测试路', w100tags.name, '测试路');
  eq('way 100 tags.lanes = "2"（字符串）', w100tags.lanes, '2');
  eq('way 100 bbox.lat = [39.9, 39.902]', [w100.min_lat, w100.max_lat], [39.9, 39.902]);
  eq('way 100 bbox.lon = [116.4, 116.402]', [w100.min_lon, w100.max_lon], [116.4, 116.402]);
  // 1→2、2→3 每段约 140.3 米（Haversine, R=6378137），合计约 280.6 米，允许 250~330 米
  check(`way 100 length 在 250~330 米之间（实际 ${w100.length}，理论 ≈280.6）`,
    typeof w100.length === 'number' && w100.length >= 250 && w100.length <= 330, String(w100.length));
  eq('way 100 way_nodes 顺序为 1,2,3 / seq 0,1,2',
    many(db, 'SELECT seq, node_id FROM way_nodes WHERE way_id = 100 ORDER BY seq')
      .map((r) => [r.seq, r.node_id]), [[0, 1], [1, 2], [2, 3]]);

  // way 200
  const w200 = one(db, 'SELECT * FROM ways WHERE id = 200');
  eq('way 200 node_count = 5', w200.node_count, 5);
  eq('way 200 closed = 1（首尾同为 node 5）', w200.closed, 1);
  eq('way 200 bbox.lat = [39.91, 39.9105]', [w200.min_lat, w200.max_lat], [39.91, 39.9105]);
  eq('way 200 bbox.lon = [116.41, 116.411]', [w200.min_lon, w200.max_lon], [116.41, 116.411]);
  check(`way 200 length 合理（闭环，4 段实际路程 ≈ ${w200.length} 米）`,
    typeof w200.length === 'number' && w200.length > 150 && w200.length < 300, String(w200.length));

  // relation 400
  const rel = one(db, 'SELECT * FROM relations WHERE id = 400');
  eq('relation 400 member_count = 1', rel.member_count, 1);
  eq('relation 400 tags.type = multipolygon', JSON.parse(rel.tags).type, 'multipolygon');
  eq('relation 400 bbox 与 way 200 一致',
    [rel.min_lat, rel.max_lat, rel.min_lon, rel.max_lon],
    [w200.min_lat, w200.max_lat, w200.min_lon, w200.max_lon]);
  const rm = one(db, 'SELECT * FROM relation_members WHERE relation_id = 400');
  eq('relation 400 成员 = way 200 / role outer', [rm.member_type, rm.member_ref, rm.role, rm.seq],
    ['way', 200, 'outer', 0]);

  // 空间索引
  const wayHit = many(db,
    'SELECT id FROM way_index WHERE max_lon >= 116.4105 AND min_lon <= 116.4105 AND max_lat >= 39.9102 AND min_lat <= 39.9102');
  check('way_index 按点(116.4105, 39.9102)能查到 way 200',
    wayHit.length === 1 && wayHit[0].id === 200, JSON.stringify(wayHit));
  const nodeHit = many(db,
    'SELECT id FROM node_index WHERE max_lon >= 116.4 AND min_lon <= 116.4 AND max_lat >= 39.9 AND min_lat <= 39.9');
  check('node_index 按点(116.4, 39.9)能查到 node 1',
    nodeHit.some((r) => r.id === 1), JSON.stringify(nodeHit));
  eq('way_index 2 行', one(db, 'SELECT COUNT(*) AS c FROM way_index').c, 2);
  eq('node_index 8 行', one(db, 'SELECT COUNT(*) AS c FROM node_index').c, 8);
  eq('relation_index 1 行', one(db, 'SELECT COUNT(*) AS c FROM relation_index').c, 1);

  // meta
  const meta = {};
  for (const r of many(db, 'SELECT key, value FROM meta')) meta[r.key] = r.value;
  eq('meta.next_node_id = 10（含被跳过的 node 9）', Number(meta.next_node_id), 10);
  eq('meta.next_way_id = 301（含被跳过的 way 300）', Number(meta.next_way_id), 301);
  eq('meta.next_relation_id = 401', Number(meta.next_relation_id), 401);
  eq('meta.counts 与行数一致', JSON.parse(meta.counts),
    { nodes: 8, ways: 2, relations: 1, way_nodes: 8, relation_members: 1 });
  eq('meta.source_file = tiny.osm', meta.source_file, 'tiny.osm');
  eq('meta.source_version = 0.6', meta.source_version, '0.6');
  eq('meta.data_bbox 取所有 node 极值',
    JSON.parse(meta.data_bbox),
    { min_lat: 39.9, min_lon: 116.4, max_lat: 39.9105, max_lon: 116.411 });
  check('meta.imported_at 是可解析的 ISO 时间',
    typeof meta.imported_at === 'string' && Number.isFinite(Date.parse(meta.imported_at)), meta.imported_at);

  db.close();

  /* ---------------- 3. 重复导入必须失败 ---------------- */
  console.log('\n=== 3. 重复导入（不带 --force）必须失败 ===');
  const dup = runCli(['--file', FIXTURE, '--db', TMP_DB, '--quiet']);
  eq('重复导入退出码为 1', dup.status, 1);

  // 用库内 API 直接验证错误信息（沙箱禁止管道，所以不用 stderr 管道）
  let errMsg = '';
  try {
    await importer.importOsm({ file: FIXTURE, db: TMP_DB, quiet: true });
  } catch (err) {
    errMsg = String(err && err.message);
  }
  check('重复导入的错误信息提示加 --force', /--force/.test(errMsg), errMsg.replace(/\n/g, ' | '));
  check('重复导入的错误信息说明已有数据量', /nodes=8/.test(errMsg), errMsg.replace(/\n/g, ' | '));
  const dbAfterDup = openDatabase(TMP_DB);
  eq('失败的重复导入没有改动数据（nodes 仍为 8）', one(dbAfterDup, 'SELECT COUNT(*) AS c FROM nodes').c, 8);
  dbAfterDup.close();

  /* ---------------- 4. --force 重新导入 ---------------- */
  console.log('\n=== 4. --force 清空后重新导入 ===');
  const forced = runCli(['--file', FIXTURE, '--db', TMP_DB, '--force', '--quiet']);
  eq('--force 导入退出码为 0', forced.status, 0);
  const dbF = openDatabase(TMP_DB);
  eq('--force 后 nodes 仍为 8（没有重复行）', one(dbF, 'SELECT COUNT(*) AS c FROM nodes').c, 8);
  eq('--force 后 ways 仍为 2', one(dbF, 'SELECT COUNT(*) AS c FROM ways').c, 2);
  eq('--force 后 way_nodes 仍为 8', one(dbF, 'SELECT COUNT(*) AS c FROM way_nodes').c, 8);
  eq('--force 后 way_index 仍为 2', one(dbF, 'SELECT COUNT(*) AS c FROM way_index').c, 2);
  dbF.close();

  /* ---------------- 5. --limit ---------------- */
  console.log('\n=== 5. --limit 3（node/way/relation 各自计数） ===');
  const lim = runCli(['--file', FIXTURE, '--db', LIMIT_DB, '--limit', '3', '--quiet']);
  eq('--limit 3 退出码为 0', lim.status, 0);
  const dbL = openDatabase(LIMIT_DB);
  eq('--limit 3 → nodes 只导入前 3 个', one(dbL, 'SELECT COUNT(*) AS c FROM nodes').c, 3);
  eq('--limit 3 → ways 只有 2 个（文件里本来就只有 2 个可见 way）',
    one(dbL, 'SELECT COUNT(*) AS c FROM ways').c, 2);
  eq('--limit 3 → relations 1 个', one(dbL, 'SELECT COUNT(*) AS c FROM relations').c, 1);
  eq('--limit 3 → way 100 仍有 length（它的 3 个节点都在）',
    typeof one(dbL, 'SELECT length FROM ways WHERE id = 100').length, 'number');
  // way 200 的节点 5~8 被 --limit 截掉了，没有 bbox，也就不进 way_index（不会写错数据）
  eq('--limit 3 → way 200 没有 bbox 时不进 way_index', one(dbL, 'SELECT COUNT(*) AS c FROM way_index').c, 1);
  dbL.close();

  /* ---------------- 5b. --limit 中途提前收工（断开输入流） ---------------- */
  console.log('\n=== 5b. --limit 2 在文件中途断开输入流 ===');
  fs.writeFileSync(TMP_ABORT_OSM, ABORT_OSM, 'utf8');
  const abort = runCli(['--file', TMP_ABORT_OSM, '--db', ABORT_DB, '--limit', '2', '--quiet']);
  eq('--limit 2 提前收工退出码为 0（没有挂死或报错）', abort.status, 0);
  const dbA = openDatabase(ABORT_DB);
  eq('提前收工 → nodes 2', one(dbA, 'SELECT COUNT(*) AS c FROM nodes').c, 2);
  eq('提前收工 → ways 2', one(dbA, 'SELECT COUNT(*) AS c FROM ways').c, 2);
  eq('提前收工 → relations 2', one(dbA, 'SELECT COUNT(*) AS c FROM relations').c, 2);
  eq('提前收工 → way_nodes 4', one(dbA, 'SELECT COUNT(*) AS c FROM way_nodes').c, 4);
  eq('提前收工 → 未读到的 way 30 / relation 300 不存在',
    [one(dbA, 'SELECT COUNT(*) AS c FROM ways WHERE id = 30').c,
      one(dbA, 'SELECT COUNT(*) AS c FROM relations WHERE id = 300').c], [0, 0]);
  dbA.close();

  /* ---------------- 6. .osm.gz ---------------- */
  console.log('\n=== 6. .osm.gz（gunzip 流式解压） ===');
  fs.writeFileSync(TMP_GZ, zlib.gzipSync(fs.readFileSync(FIXTURE)));
  const gz = runCli(['--file', TMP_GZ, '--db', GZ_DB, '--quiet']);
  eq('.osm.gz 导入退出码为 0', gz.status, 0);
  const dbG = openDatabase(GZ_DB);
  eq('.osm.gz 导入 nodes 8 行', one(dbG, 'SELECT COUNT(*) AS c FROM nodes').c, 8);
  eq('.osm.gz 导入 ways 2 行', one(dbG, 'SELECT COUNT(*) AS c FROM ways').c, 2);
  eq('.osm.gz 的 meta.source_file 记录压缩包文件名', one(dbG, "SELECT value FROM meta WHERE key='source_file'").value,
    'tmp-tiny.osm.gz');
  dbG.close();

  /* ---------------- 7. 错误路径 ---------------- */
  console.log('\n=== 7. 错误参数 / 文件不存在 ===');
  const missingFile = runCli(['--file', path.join(__dirname, 'no-such-file.osm'), '--db', GZ_DB, '--force', '--quiet']);
  eq('输入文件不存在时退出码为 1', missingFile.status, 1);
  const missingArg = runCli(['--file', FIXTURE, '--quiet']);
  eq('缺少 --db 时退出码为 1', missingArg.status, 1);
  const help = runCli(['--help']);
  eq('--help 退出码为 0', help.status, 0);

  /* ---------------- 收尾 ---------------- */
  cleanupAll();

  console.log(`\n通过 ${passed} 条，失败 ${failed} 条`);
  if (failed > 0) {
    console.log('❌ 测试未通过');
    process.exitCode = 1;
  } else {
    console.log('✅ 全部通过');
  }
}

main().catch((err) => {
  console.error('❌ 测试脚本异常：' + (err && err.stack ? err.stack : err));
  cleanupAll();
  process.exitCode = 1;
});
