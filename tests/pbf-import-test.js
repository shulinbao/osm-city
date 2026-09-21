'use strict';
/**
 * OSM PBF 解析器 + PBF 导入路径自动化测试（本文件是新增的，不改任何既有测试套件）
 *
 * 运行：node tests/pbf-import-test.js
 *
 * 覆盖：
 *   1. varint / zigzag 编解码往返（含边界值与负数）
 *   2. ProtoReader 的边界检查（截断的 varint、越界的长度前缀）
 *   3. **往返测试**：用 tools/pbf.js 自带的编码器拼一个最小 .pbf（HeaderBlock + DenseNodes +
 *      Node + Way + Relation + 各种未知字段 + raw/zlib 两种 Blob + 未知块类型），再用解析器读回来，
 *      逐字段核对（DenseNodes 增量、字符串表去重、Info/DenseInfo 映射、LocationsOnWays 忽略）
 *   4. visible=false（dense 与 Info 两种）被跳过，但仍然计入 occurrences / maxSeenId
 *   5. 缺几何的 way（引用了不在文件里的节点）不会崩，也不进空间索引（与 XML 路径同一条回填逻辑）
 *   6. CLI 导入合成 pbf：行数 / 字段 / tags / editor / ts / bbox / length / closed / R*Tree / meta
 *   7. --limit（node / way / relation 各自计数，被跳过的元素仍占配额）
 *   8. --force 重新导入幂等
 *   9. 截断文件：警告不崩（与 XML 路径一致）
 *  10. fetch-osm.js 的纯函数：格式识别 / md5 文本解析 / 磁盘预检（空间不足时给中文建议）/ --print-env
 *  11. 真实数据（可选）：tests/tmp-monaco.osm.pbf 存在时跑一遍，核对计数与索引规模
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
const pbf = require('../tools/pbf.js');
const fetchOsm = require('../tools/fetch-osm.js');
const { encode: E } = pbf;

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'import-osm.js');
const FETCH_CLI = path.join(ROOT, 'tools', 'fetch-osm.js');
const MONACO = path.join(__dirname, 'tmp-monaco.osm.pbf');

const TMP_PBF = path.join(__dirname, 'tmp-synth.osm.pbf');
const TMP_PBF_GZ = path.join(__dirname, 'tmp-synth.osm.pbf.gz');
const TMP_PBF_RAW = path.join(__dirname, 'tmp-synth-raw.osm.pbf');
const TMP_PBF_TRUNC = path.join(__dirname, 'tmp-synth-trunc.osm.pbf');
const DB_MAIN = path.join(__dirname, 'tmp-pbf-import.sqlite');
const DB_LIMIT = path.join(__dirname, 'tmp-pbf-limit.sqlite');
const DB_LIMIT2 = path.join(__dirname, 'tmp-pbf-limit2.sqlite');
const DB_MONACO = path.join(__dirname, 'tmp-pbf-monaco.sqlite');
const QUIET_OUT = path.join(__dirname, 'tmp-pbf-quiet-out.txt');
const ENV_OUT = path.join(__dirname, 'tmp-pbf-env-out.txt');

/* ================================================================== *
 * 断言工具（与 tests/import-test.js 同一套写法）
 * ================================================================== */
let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('✅ ' + name);
  } else {
    failed++;
    console.log('❌ ' + name + (detail === undefined ? '' : '  →  ' + detail));
  }
}

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

/* ================================================================== *
 * 用 tools/pbf.js 的编码器拼消息（这就是"我自己的编码器"那一侧）
 * ================================================================== */
/** Info 消息 */
function infoMsg(o = {}) {
  const p = [];
  if (o.version !== undefined) p.push(E.varintField(1, o.version));
  if (o.timestamp !== undefined) p.push(E.varintField(2, o.timestamp));
  if (o.uid !== undefined) p.push(E.varintField(4, o.uid));
  if (o.userSid !== undefined) p.push(E.varintField(5, o.userSid));
  if (o.visible !== undefined) p.push(E.varintField(6, o.visible ? 1 : 0));
  return Buffer.concat(p);
}

/** DenseInfo：version 是绝对值，timestamp/uid/user_sid 都是增量 */
function denseInfoMsg(o = {}) {
  const p = [];
  if (o.versions) p.push(E.packedField(1, o.versions, E.uvarint));
  if (o.ts) p.push(E.packedField(2, E.deltaEncode(o.ts), E.svarint));
  if (o.uids) p.push(E.packedField(4, E.deltaEncode(o.uids), E.svarint));
  if (o.userSids) p.push(E.packedField(5, E.deltaEncode(o.userSids), E.svarint));
  if (o.visible) p.push(E.packedField(6, o.visible.map((v) => (v ? 1 : 0)), E.uvarint));
  return Buffer.concat(p);
}

/** DenseNodes 消息 */
function denseNodesMsg(o) {
  const p = [E.packedField(1, E.deltaEncode(o.ids), E.svarint)];
  if (o.denseInfo) p.push(E.bytesField(5, o.denseInfo));
  p.push(E.packedField(8, E.deltaEncode(o.lats), E.svarint));
  p.push(E.packedField(9, E.deltaEncode(o.lons), E.svarint));
  if (o.keysVals) p.push(E.packedField(10, o.keysVals, E.uvarint));
  if (o.extra) p.push(o.extra);
  return Buffer.concat(p);
}

/** 单个 Node 消息（非 dense） */
function nodeMsg(o) {
  const p = [E.svarintField(1, o.id)];
  if (o.keys) p.push(E.packedField(2, o.keys, E.uvarint));
  if (o.vals) p.push(E.packedField(3, o.vals, E.uvarint));
  if (o.info) p.push(E.bytesField(4, o.info));
  p.push(E.svarintField(8, o.lat), E.svarintField(9, o.lon));
  if (o.extra) p.push(o.extra);
  return Buffer.concat(p);
}

/** Way 消息（id 是 int64 非 zigzag；refs 增量；locations 是可选的 LocationsOnWays 字段） */
function wayMsg(o) {
  const p = [E.varintField(1, o.id)];
  if (o.keys) p.push(E.packedField(2, o.keys, E.uvarint));
  if (o.vals) p.push(E.packedField(3, o.vals, E.uvarint));
  if (o.info) p.push(E.bytesField(4, o.info));
  if (o.refs) p.push(E.packedField(8, E.deltaEncode(o.refs), E.svarint));
  if (o.locations) {
    p.push(E.packedField(9, E.deltaEncode(o.locations.lats), E.svarint));
    p.push(E.packedField(10, E.deltaEncode(o.locations.lons), E.svarint));
  }
  if (o.extra) p.push(o.extra);
  return Buffer.concat(p);
}

/** Relation 消息（memids 增量；type 是枚举 0=node 1=way 2=relation） */
function relationMsg(o) {
  const p = [E.varintField(1, o.id)];
  if (o.keys) p.push(E.packedField(2, o.keys, E.uvarint));
  if (o.vals) p.push(E.packedField(3, o.vals, E.uvarint));
  if (o.info) p.push(E.bytesField(4, o.info));
  if (o.rolesSid) p.push(E.packedField(8, o.rolesSid, E.uvarint));
  if (o.memids) p.push(E.packedField(9, E.deltaEncode(o.memids), E.svarint));
  if (o.types) p.push(E.packedField(10, o.types, E.uvarint));
  if (o.extra) p.push(o.extra);
  return Buffer.concat(p);
}

/** PrimitiveGroup */
function groupMsg(o) {
  const p = [];
  for (const n of o.nodes || []) p.push(E.bytesField(1, n));
  if (o.dense) p.push(E.bytesField(2, o.dense));
  for (const w of o.ways || []) p.push(E.bytesField(3, w));
  for (const r of o.relations || []) p.push(E.bytesField(4, r));
  if (o.extra) p.push(o.extra);
  return Buffer.concat(p);
}

/** PrimitiveBlock */
function blockMsg(o) {
  const p = [E.bytesField(1, E.stringTable(o.strings))];
  for (const g of o.groups) p.push(E.bytesField(2, g));
  if (o.granularity !== undefined) p.push(E.varintField(17, o.granularity));
  if (o.dateGranularity !== undefined) p.push(E.varintField(18, o.dateGranularity));
  if (o.latOffset !== undefined) p.push(E.varintField(19, o.latOffset));
  if (o.lonOffset !== undefined) p.push(E.varintField(20, o.lonOffset));
  if (o.extra) p.push(o.extra);
  return Buffer.concat(p);
}

/** HeaderBlock */
function headerBlockMsg(o = {}) {
  const p = [];
  if (o.bbox) {
    p.push(E.bytesField(1, Buffer.concat([
      E.svarintField(1, o.bbox.left), E.svarintField(2, o.bbox.right),
      E.svarintField(3, o.bbox.top), E.svarintField(4, o.bbox.bottom),
    ])));
  }
  for (const f of o.requiredFeatures || []) p.push(E.stringField(4, f));
  for (const f of o.optionalFeatures || []) p.push(E.stringField(5, f));
  if (o.writingProgram) p.push(E.stringField(16, o.writingProgram));
  if (o.extra) p.push(o.extra);
  return Buffer.concat(p);
}

/* ------------------------- 夹具：一座"小城" ------------------------- */
/**
 * 字符串表（故意留了一条重复项 'highway' 在两个下标上，用来验证"字符串表去重/下标映射"）
 *   0 ''  1 highway  2 residential  3 name  4 测试路  5 alice  6 highway(重复)
 *   7 outer  8 sub  9 primary  10 water  11 type  12 multipolygon
 */
const ST = {
  empty: 0, highway: 1, residential: 2, name: 3, nameCn: 4, alice: 5,
  highwayDup: 6, outer: 7, sub: 8, primary: 9, water: 10, type: 11, multipolygon: 12,
};
const STRINGS = ['', 'highway', 'residential', 'name', '测试路', 'alice', 'highway',
  'outer', 'sub', 'primary', 'water', 'type', 'multipolygon'];

/** 度 → PBF 的整数单位（granularity=100 纳度 = 1e-7 度） */
function toUnits(deg, granularity = 100) { return Math.round(deg * 1e9 / granularity); }

/** 度 → 纳度（HeaderBBox 用的是纳度，与 PrimitiveBlock 的 granularity 无关） */
function toNano(deg) { return Math.round(deg * 1e9); }

const DENSE = {
  ids: [1, 2, 3, 4, 5],
  lats: [39.9, 39.901, 39.902, 39.9005, 39.903].map((d) => toUnits(d)),
  lons: [116.4, 116.401, 116.402, 116.4005, 116.403].map((d) => toUnits(d)),
  // 每个节点一条 key,val,…,0 的流；节点 3 用**重复字符串表下标 6** 取 'highway'
  keysVals: [
    ST.highway, ST.residential, 0,
    ST.name, ST.nameCn, 0,
    ST.highwayDup, ST.primary, 0,
    0,
    0,
  ],
  denseInfo: denseInfoMsg({
    versions: [1, 1, 2, 1, 1],
    ts: [1577934245, 1577934246, 1577934247, 1577934248, 1577934249],
    uids: [11, 0, 7, 0, 0],
    userSids: [ST.alice, -1, ST.alice, -1, -1],
    visible: [true, true, true, true, false],      // 节点 5 是 visible=false
  }),
};

/** 未知字段（不同 wire type 各来一个，解析器必须安全跳过） */
const UNKNOWN_VARINT = E.varintField(99, 123456);
const UNKNOWN_BYTES = E.bytesField(98, Buffer.from('这里是未知字段的内容', 'utf8'));
const UNKNOWN_FIXED32 = Buffer.concat([E.tag(97, 5), Buffer.from([1, 2, 3, 4])]);
const UNKNOWN_FIXED64 = Buffer.concat([E.tag(96, 1), Buffer.alloc(8, 7)]);

const HEADER = headerBlockMsg({
  bbox: {
    left: toNano(-180), right: toNano(180), top: toNano(90), bottom: toNano(-90),
  },
  requiredFeatures: ['OsmSchema-V0.6', 'DenseNodes'],
  optionalFeatures: ['Sort.Type_then_ID'],
  writingProgram: 'pbf-import-test',
  extra: UNKNOWN_BYTES,
});

/** 一块数据：dense 节点 + 普通 Node + Way + Relation */
const BLOCK1 = blockMsg({
  strings: STRINGS,
  groups: [
    groupMsg({ dense: denseNodesMsg({ ...DENSE, extra: UNKNOWN_FIXED64 }) }),
    groupMsg({
      nodes: [
        nodeMsg({
          id: 100,
          lat: toUnits(39.904), lon: toUnits(116.404),
          info: infoMsg({ version: 3, timestamp: 1577934300, uid: 42, userSid: ST.alice, visible: true }),
          extra: UNKNOWN_VARINT,
        }),
        nodeMsg({
          id: 101,
          lat: toUnits(39.905), lon: toUnits(116.405),
          info: infoMsg({ visible: false }),               // 非 dense 的 visible=false
        }),
      ],
      extra: UNKNOWN_FIXED32,
    }),
    groupMsg({
      ways: [
        // way 200：带 LocationsOnWays 字段（9/10）——本项目用 refs 重建几何，这两列必须被忽略
        wayMsg({
          id: 200,
          keys: [ST.highway, ST.name], vals: [ST.residential, ST.nameCn],
          refs: [1, 2, 3],
          locations: { lats: [toUnits(0), toUnits(0), toUnits(0)], lons: [toUnits(0), toUnits(0), toUnits(0)] },
          info: infoMsg({ version: 4, timestamp: 1577934400, uid: 11, userSid: ST.alice }),
        }),
        wayMsg({ id: 201, keys: [ST.highway], vals: [ST.primary], refs: [3, 4] }),
        wayMsg({ id: 202, keys: [ST.water], vals: [ST.water], refs: [2, 3, 4, 2] }),   // 闭环
        wayMsg({ id: 300, keys: [ST.highway], vals: [ST.primary], refs: [999] }),        // 节点不在文件里
        wayMsg({ id: 301, refs: [1, 2], info: infoMsg({ visible: false }) }),            // 不可见
      ],
    }),
    groupMsg({
      relations: [
        relationMsg({
          id: 400,
          keys: [ST.type], vals: [ST.multipolygon],
          rolesSid: [ST.outer, ST.empty], memids: [200, 1], types: [1, 0],
        }),
        relationMsg({
          id: 401, rolesSid: [ST.sub], memids: [400], types: [2],
          info: infoMsg({ visible: false }),
        }),
        relationMsg({ id: 402, rolesSid: [ST.sub], memids: [400], types: [2] }),
      ],
    }),
  ],
  extra: UNKNOWN_BYTES,
});

/** 第二块：只有一个节点，用来验证多块与 date_granularity=1（时间戳直接是毫秒） */
const BLOCK2 = blockMsg({
  strings: STRINGS,
  groups: [groupMsg({
    nodes: [nodeMsg({
      id: 500, lat: toUnits(39.906), lon: toUnits(116.406),
      info: infoMsg({ version: 9, timestamp: 1577934500000, uid: 5, userSid: ST.alice }),
    })],
  })],
  dateGranularity: 1,        // 时间戳单位 = 1 毫秒
});

function buildPbf(options = {}) {
  const blocks = [
    { type: 'OSMHeader', data: HEADER },
    { type: 'OSMData', data: BLOCK1, raw: !!options.rawFirst },
    { type: 'OSMData', data: BLOCK2 },
  ];
  if (options.unknownBlob) blocks.push({ type: 'OSMFutureThing', data: Buffer.from([1, 2, 3]) });
  return { buffer: E.pbfFile(blocks), blocks };
}

/* ================================================================== *
 * 临时文件
 * ================================================================== */
function sqliteFiles(base) { return [base, base + '-wal', base + '-shm', base + '-journal']; }

function cleanupAll() {
  for (const base of [DB_MAIN, DB_LIMIT, DB_LIMIT2, DB_MONACO]) {
    for (const f of sqliteFiles(base)) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }
  for (const f of [TMP_PBF, TMP_PBF_GZ, TMP_PBF_RAW, TMP_PBF_TRUNC, QUIET_OUT, ENV_OUT]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

function runCli(args, outFile) {
  if (outFile) {
    const fd = fs.openSync(outFile, 'w');
    let res;
    try {
      res = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: ['ignore', fd, 'ignore'], timeout: 180000 });
    } finally {
      fs.closeSync(fd);
    }
    return { status: res.status, out: fs.readFileSync(outFile, 'utf8') };
  }
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: 'ignore', timeout: 180000 });
  return { status: res.status, out: '' };
}

function runFetch(args, outFile) {
  // stdout 与 stderr 都写进同一个普通文件（沙箱禁止管道；中文报错大多走 stderr）
  const fd = fs.openSync(outFile, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [FETCH_CLI, ...args], { cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 60000 });
  } finally {
    fs.closeSync(fd);
  }
  return { status: res.status, out: fs.readFileSync(outFile, 'utf8') };
}

/* ================================================================== *
 * 测试主体
 * ================================================================== */
async function main() {
  cleanupAll();

  /* ---------------- 1. varint / zigzag 往返 ---------------- */
  console.log('\n=== 1. varint / zigzag 编解码往返 ===');
  const varintCases = [0, 1, 2, 127, 128, 129, 300, 16383, 16384, 2097151, 2097152,
    268435455, 2147483647, 2147483648, 4294967295, 9007199254740991];
  let varintOk = true;
  let varintBad = '';
  for (const v of varintCases) {
    const buf = E.uvarint(v);
    const back = E.decodeUvarint(buf, 0);
    if (back.value !== v || back.next !== buf.length) { varintOk = false; varintBad = `${v} → ${back.value}`; break; }
  }
  check('无符号 varint 往返（16 个值，含 2^31 / 2^53-1）', varintOk, varintBad);

  // 负数只到 2^52：JS 双精度下 |v| > 2^52 时 zigzag 的 `2v-1` 会丢精度（见 pbf.js 的注释）
  const zigzagCases = [0, 1, -1, 2, -2, 63, -64, 127, -128, 1000000, -1000000,
    2147483647, -2147483648, 4503599627370496, -4503599627370496];
  let zigOk = true;
  let zigBad = '';
  for (const v of zigzagCases) {
    const enc = E.zigzagEncode(v);
    const dec = pbf.zigzagDecode(enc);
    if (dec !== v || enc < 0) { zigOk = false; zigBad = `${v} → 编码 ${enc} → 解码 ${dec}`; break; }
  }
  check('zigzag 往返（15 个值，含负数与 ±2^52）', zigOk, zigBad);
  eq('zigzag(-1) = 1（规范：sint 用 zigzag）', E.zigzagEncode(-1), 1);
  eq('zigzag(1) = 2', E.zigzagEncode(1), 2);
  eq('zigzagDecode(3) = -2', pbf.zigzagDecode(3), -2);

  // 多字节 varint 的实际字节数（300 = 0xAC 0x02）
  eq('varint(300) 两个字节 [0xAC,0x02]', [...E.uvarint(300)], [0xac, 0x02]);
  eq('varint(0) 一个字节 [0x00]', [...E.uvarint(0)], [0x00]);

  /* ---------------- 2. ProtoReader 边界 ---------------- */
  console.log('\n=== 2. ProtoReader 边界检查 ===');
  let err1 = '';
  try { new pbf.ProtoReader(Buffer.from([0x80, 0x80])).uvarint(); } catch (e) { err1 = e.message; }
  check('截断的 varint 抛错（不静默返回脏值）', /越界|截断/.test(err1), err1);

  let err2 = '';
  try { new pbf.ProtoReader(Buffer.from([0x7f, 0x01, 0x02])).bytes(); } catch (e) { err2 = e.message; }
  check('长度前缀越界抛错', /超出剩余/.test(err2), err2);

  let err3 = '';
  try { new pbf.ProtoReader(Buffer.from([0x7f])).skip(5); } catch (e) { err3 = e.message; }
  check('fixed32 越界抛错', /fixed32 越界/.test(err3), err3);

  const r = new pbf.ProtoReader(Buffer.concat([E.tag(3, 2), E.lenPrefix(Buffer.from('abc'))]));
  eq('tag 解析 field/wire', r.tag(), { field: 3, wire: 2 });
  eq('bytes 解析长度前缀字符串', r.bytes().toString('utf8'), 'abc');
  check('读完之后 eof = true', r.eof, String(r.eof));

  /* ---------------- 3. 往返测试：自造最小 pbf → 解析器 ---------------- */
  console.log('\n=== 3. 往返测试（自写编码器 → parsePbf） ===');
  const built = buildPbf();
  fs.writeFileSync(TMP_PBF, built.buffer);

  const kind = pbf.detectKind(TMP_PBF);
  eq('detectKind 认出合成的 pbf', kind, 'pbf');
  eq('sniffBuffer 认出 gz 里的 xml', pbf.sniffBuffer(zlib.gzipSync(Buffer.from('<osm version="0.6"></osm>'))), 'gzip-xml');
  eq('sniffBuffer 认出 xml', pbf.sniffBuffer(Buffer.from('  <?xml version="1.0"?>')), 'xml');
  eq('sniffBuffer 对垃圾数据返回 unknown', pbf.sniffBuffer(Buffer.from('not an osm file at all')), 'unknown');

  const nodes = [];
  const ways = [];
  const relations = [];
  const warnings = [];
  const headers = [];
  const stats = await pbf.parsePbf(TMP_PBF, {
    onNode: (n) => nodes.push(n),
    onWay: (w) => ways.push(w),
    onRelation: (rel) => relations.push(rel),
    onHeader: (h) => headers.push(h),
    onWarning: (m) => warnings.push(m),
  });

  eq('解析出的元素总数（含 visible=false）', [nodes.length, ways.length, relations.length], [8, 5, 3]);
  eq('stats：数据块 2 个，元素计数含不可见元素', [stats.dataBlobs, stats.headerBlobs, stats.nodes, stats.ways, stats.relations], [2, 1, 8, 5, 3]);
  eq('HeaderBlock 的 bbox 换算成度', headers[0].bbox, { min_lat: -90, min_lon: -180, max_lat: 90, max_lon: 180 });
  eq('HeaderBlock 的 required_features（未知字段被跳过，不影响解析）',
    headers[0].requiredFeatures, ['OsmSchema-V0.6', 'DenseNodes']);

  // DenseNodes：增量解码出来的 id / 坐标
  const d1 = nodes.find((n) => n.id === 1);
  const d3 = nodes.find((n) => n.id === 3);
  const d5 = nodes.find((n) => n.id === 5);
  eq('DenseNodes 增量解码：5 个 id 依次为 1,2,3,4,5',
    nodes.filter((n) => n.id <= 5).map((n) => n.id), [1, 2, 3, 4, 5]);
  near('DenseNodes 增量解码：node 1 lat', d1.lat, 39.9, 1e-7);
  near('DenseNodes 增量解码：node 1 lon', d1.lon, 116.4, 1e-7);
  near('DenseNodes 增量解码：node 3 lat（第 3 个增量）', d3.lat, 39.902, 1e-7);
  near('DenseNodes 增量解码：node 3 lon', d3.lon, 116.402, 1e-7);
  near('DenseNodes 增量解码：node 4 lat（增量回退）', nodes.find((n) => n.id === 4).lat, 39.9005, 1e-7);
  eq('keys_vals 按 0 分隔：node 1 的 tags', d1.tags, { highway: 'residential' });
  eq('keys_vals：node 2 的 tags', nodes.find((n) => n.id === 2).tags, { name: '测试路' });
  eq('字符串表去重：下标 6 与下标 1 都是 "highway"', d3.tags, { highway: 'primary' });
  eq('没有标签的节点 tags = null', nodes.find((n) => n.id === 4).tags, null);
  eq('DenseInfo：node 1 version/editor/editorName',
    [d1.version, d1.editor, d1.editorName], [1, '11', 'alice']);
  eq('DenseInfo：node 3 version=2 / uid=7', [d3.version, d3.editor], [2, '7']);
  eq('DenseInfo：匿名节点 editor/editorName 都是 null',
    [nodes.find((n) => n.id === 2).editor, nodes.find((n) => n.id === 2).editorName], [null, null]);
  eq('DenseInfo：timestamp 按 date_granularity=1000 换算成毫秒', d1.ts, 1577934245000);
  eq('DenseNodes 里 visible=false 的 node 5 被标出来（由导入器决定跳过）', d5.visible, false);
  eq('visible=false 的节点仍然带 tags=null 且回调到了', d5.tags, null);

  // 普通 Node + Info
  const n100 = nodes.find((n) => n.id === 100);
  eq('普通 Node：id/lat/lon/version', [n100.id, Math.round(n100.lat * 1e6) / 1e6, Math.round(n100.lon * 1e6) / 1e6, n100.version],
    [100, 39.904, 116.404, 3]);
  eq('普通 Node 的 Info：uid/user_sid → editor/editorName', [n100.editor, n100.editorName], ['42', 'alice']);
  eq('普通 Node 的 Info：timestamp（date_granularity 默认 1000）', n100.ts, 1577934300000);
  eq('普通 Node 的 Info：visible=false 也被标出来', nodes.find((n) => n.id === 101).visible, false);
  eq('第二块用 date_granularity=1：时间戳直接就是毫秒',
    nodes.find((n) => n.id === 500).ts, 1577934500000);
  eq('第二块里 node 500 的 version=9', nodes.find((n) => n.id === 500).version, 9);

  // Way：refs 增量 + LocationsOnWays 被忽略
  const w200 = ways.find((w) => w.id === 200);
  eq('Way.refs 增量解码', w200.refs, [1, 2, 3]);
  eq('Way 的 tags（键值都走字符串表）', w200.tags, { highway: 'residential', name: '测试路' });
  eq('Way 的 Info → version/editor', [w200.version, w200.editor], [4, '11']);
  eq('Way.refs 用的是 refs 字段（locations 的 lat/lon 被安全跳过）', w200.refs.length, 3);
  eq('Way 202 闭环 refs', ways.find((w) => w.id === 202).refs, [2, 3, 4, 2]);
  eq('Way 300 引用了不在文件里的节点（解析阶段照收）', ways.find((w) => w.id === 300).refs, [999]);
  eq('Way 301 是 visible=false', ways.find((w) => w.id === 301).visible, false);

  // Relation：memids 增量 + type 枚举 + role
  const r400 = relations.find((x) => x.id === 400);
  eq('Relation.memids 增量解码 + role 字符串表 + type 枚举',
    r400.members, [{ type: 'way', ref: 200, role: 'outer' }, { type: 'node', ref: 1, role: '' }]);
  eq('Relation 402 的嵌套 relation 成员', relations.find((x) => x.id === 402).members,
    [{ type: 'relation', ref: 400, role: 'sub' }]);
  eq('Relation 401 是 visible=false', relations.find((x) => x.id === 401).visible, false);
  eq('Relation 400 的 tags（type=multipolygon）', r400.tags, { type: 'multipolygon' });

  // 未知字段 / 未知块类型 / raw blob
  check('未知字段（varint/bytes/fixed32/fixed64）全部被安全跳过，没有警告',
    warnings.length === 0, JSON.stringify(warnings));
  const withUnknown = buildPbf({ unknownBlob: true });
  fs.writeFileSync(TMP_PBF_RAW, withUnknown.buffer);
  const rawWarnings = [];
  const rawStats = await pbf.parsePbf(TMP_PBF_RAW, { onWarning: (m) => rawWarnings.push(m) });
  eq('raw（未压缩）Blob 也能解析', [rawStats.nodes, rawStats.ways, rawStats.relations], [8, 5, 3]);
  check('未知块类型只警告、不影响其余数据',
    rawWarnings.some((m) => /未知块类型/.test(m)) && rawStats.otherBlobs === 1,
    JSON.stringify(rawWarnings));

  // gz 包着的 pbf
  fs.writeFileSync(TMP_PBF_GZ, zlib.gzipSync(built.buffer));
  eq('detectKind 认出 gz 里的 pbf', pbf.detectKind(TMP_PBF_GZ), 'gzip-pbf');
  const gzStats = await pbf.parsePbf(TMP_PBF_GZ, { gunzip: true });
  eq('gunzip: true 能解析 gz 包着的 pbf', [gzStats.nodes, gzStats.ways, gzStats.relations], [8, 5, 3]);

  /* ---------------- 4. 截断文件 ---------------- */
  console.log('\n=== 4. 截断文件：警告不崩 ===');
  const truncated = built.buffer.subarray(0, built.buffer.length - 120);
  fs.writeFileSync(TMP_PBF_TRUNC, truncated);
  const truncWarnings = [];
  let truncErr = null;
  let truncStats = null;
  try {
    truncStats = await pbf.parsePbf(TMP_PBF_TRUNC, { onWarning: (m) => truncWarnings.push(m) });
  } catch (e) { truncErr = e; }
  check('截断的 pbf 不抛错，而是给出警告', truncErr === null, truncErr && truncErr.message);
  check('stats.truncated = true 且警告里说明被截断',
    truncStats && truncStats.truncated === true && truncWarnings.some((m) => /截断/.test(m)),
    JSON.stringify(truncWarnings));
  check('截断前已解析到的元素仍然有效', truncStats && truncStats.nodes >= 5, JSON.stringify(truncStats));

  /* ---------------- 5. CLI 导入（XML 与 PBF 共用写库路径） ---------------- */
  console.log('\n=== 5. CLI 导入合成 pbf → 行数 / 字段 / 回填 ===');
  const cap = runCli(['--file', TMP_PBF, '--db', DB_MAIN, '--quiet'], QUIET_OUT);
  eq('CLI 导入 pbf 退出码为 0', cap.status, 0);
  const quietLines = cap.out.split(/\r?\n/).filter((l) => l.trim() !== '');
  eq('--quiet 仍然只打印一行', quietLines.length, 1);
  check('--quiet 那一行里 nodes/ways/relations 计数正确',
    /nodes=6/.test(cap.out) && /ways=4/.test(cap.out) && /relations=2/.test(cap.out), cap.out.trim());

  const db = openDatabase(DB_MAIN);
  eq('nodes 表 6 行（dense 4 个可见 + node 100 + 第二块的 node 500；5/101 不可见被跳过）',
    one(db, 'SELECT COUNT(*) AS c FROM nodes').c, 6);
  eq('dense 里 visible=false 的 node 5 没有入库',
    one(db, 'SELECT COUNT(*) AS c FROM nodes WHERE id = 5').c, 0);
  eq('普通 Node 里 visible=false 的 node 101 没有入库',
    one(db, 'SELECT COUNT(*) AS c FROM nodes WHERE id = 101').c, 0);
  eq('ways 表 4 行（301 不可见被跳过）', one(db, 'SELECT COUNT(*) AS c FROM ways').c, 4);
  eq('relations 表 2 行（401 不可见被跳过）', one(db, 'SELECT COUNT(*) AS c FROM relations').c, 2);
  eq('way_nodes 行数（3 + 2 + 4 + 1）', one(db, 'SELECT COUNT(*) AS c FROM way_nodes').c, 10);
  eq('relation_members 行数（400 有 2 个成员，402 有 1 个）',
    one(db, 'SELECT COUNT(*) AS c FROM relation_members').c, 3);

  const row1 = one(db, 'SELECT * FROM nodes WHERE id = 1');
  eq('node 1 坐标', [row1.lat, row1.lon], [39.9, 116.4]);
  eq('node 1 tags 存成 JSON', JSON.parse(row1.tags), { highway: 'residential' });
  eq('node 1 editor/editor_name/version/ts',
    [row1.editor, row1.editor_name, row1.version, row1.ts], ['11', 'alice', 1, 1577934245000]);
  eq('node 4（无标签）tags = NULL', one(db, 'SELECT tags FROM nodes WHERE id = 4').tags, null);
  eq('node 100 的 version 与 ts（date_granularity=1000）',
    [one(db, 'SELECT version FROM nodes WHERE id = 100').version,
      one(db, 'SELECT ts FROM nodes WHERE id = 100').ts], [3, 1577934300000]);

  const w200row = one(db, 'SELECT * FROM ways WHERE id = 200');
  eq('way 200 node_count / closed', [w200row.node_count, w200row.closed], [3, 0]);
  eq('way 200 tags', JSON.parse(w200row.tags), { highway: 'residential', name: '测试路' });
  eq('way 200 bbox（由 way_nodes JOIN nodes 回填）',
    [w200row.min_lat, w200row.max_lat, w200row.min_lon, w200row.max_lon],
    [39.9, 39.902, 116.4, 116.402]);
  check(`way 200 length 在 250~330 米之间（实际 ${w200row.length}）`,
    typeof w200row.length === 'number' && w200row.length >= 250 && w200row.length <= 330, String(w200row.length));
  eq('way 202 是闭环（首尾 ref 相同）', one(db, 'SELECT closed FROM ways WHERE id = 202').closed, 1);
  eq('way 200 的 way_nodes 顺序', db.prepare('SELECT seq, node_id FROM way_nodes WHERE way_id = 200 ORDER BY seq').all()
    .map((x) => [x.seq, x.node_id]), [[0, 1], [1, 2], [2, 3]]);

  // 缺几何的 way：与 XML 路径完全一致（bbox NULL，不进 way_index，length NULL）
  const w300 = one(db, 'SELECT * FROM ways WHERE id = 300');
  eq('缺几何的 way 300 仍入库，但 bbox 是 NULL', [w300.min_lat, w300.max_lon, w300.length], [null, null, null]);
  eq('缺几何的 way 300 不进 way_index', one(db, 'SELECT COUNT(*) AS c FROM way_index WHERE id = 300').c, 0);
  eq('way_index 只有 3 行（200/201/202）', one(db, 'SELECT COUNT(*) AS c FROM way_index').c, 3);
  eq('node_index 6 行', one(db, 'SELECT COUNT(*) AS c FROM node_index').c, 6);
  eq('relation 400 的 bbox 来自 way 成员', (() => {
    const rel = one(db, 'SELECT min_lat, max_lat FROM relations WHERE id = 400');
    return [rel.min_lat, rel.max_lat];
  })(), [39.9, 39.902]);
  eq('relation 402（只有 relation 成员）没有 bbox，也不进 relation_index',
    [one(db, 'SELECT min_lat FROM relations WHERE id = 402').min_lat,
      one(db, 'SELECT COUNT(*) AS c FROM relation_index').c], [null, 1]);
  eq('relation 400 的成员（type/ref/role/seq）',
    db.prepare('SELECT seq, member_type, member_ref, role FROM relation_members WHERE relation_id = 400 ORDER BY seq').all()
      .map((x) => [x.seq, x.member_type, x.member_ref, x.role]),
    [[0, 'way', 200, 'outer'], [1, 'node', 1, '']]);

  // meta：与 XML 路径同口径（含 visible=false 与超限元素的 maxSeenId）
  const meta = {};
  for (const r2 of db.prepare('SELECT key, value FROM meta').all()) meta[r2.key] = r2.value;
  eq('meta.source_format = pbf', meta.source_format, 'pbf');
  eq('meta.source_file 记录源文件名', meta.source_file, 'tmp-synth.osm.pbf');
  eq('meta.counts 与行数一致', JSON.parse(meta.counts),
    { nodes: 6, ways: 4, relations: 2, way_nodes: 10, relation_members: 3 });
  eq('meta.next_node_id 含不可见的 node 101 与第二块的 500', Number(meta.next_node_id), 501);
  eq('meta.next_way_id 含不可见的 way 301', Number(meta.next_way_id), 302);
  eq('meta.next_relation_id 含不可见的 relation 401', Number(meta.next_relation_id), 403);
  eq('meta.source_bounds 来自 HeaderBlock 的 bbox（纳度 → 度）', JSON.parse(meta.source_bounds),
    { min_lat: -90, min_lon: -180, max_lat: 90, max_lon: 180 });
  eq('meta.data_bbox 取所有 node 的极值', JSON.parse(meta.data_bbox),
    { min_lat: 39.9, min_lon: 116.4, max_lat: 39.906, max_lon: 116.406 });
  db.close();

  /* ---------------- 6. --limit（逐类型计数） ---------------- */
  console.log('\n=== 6. --limit 3 / 2（node、way、relation 各自计数） ===');
  const lim3 = runCli(['--file', TMP_PBF, '--db', DB_LIMIT, '--limit', '3', '--quiet']);
  eq('--limit 3 退出码为 0', lim3.status, 0);
  const dbL = openDatabase(DB_LIMIT);
  eq('--limit 3 → nodes 只取前 3 个（dense 的 1,2,3）',
    dbL.prepare('SELECT id FROM nodes ORDER BY id').all().map((x) => x.id), [1, 2, 3]);
  eq('--limit 3 → ways 前 3 个', dbL.prepare('SELECT id FROM ways ORDER BY id').all().map((x) => x.id), [200, 201, 202]);
  eq('--limit 3 → relations：401 不可见但占配额，402 仍在限额内',
    dbL.prepare('SELECT id FROM relations ORDER BY id').all().map((x) => x.id), [400, 402]);
  dbL.close();

  const lim2 = runCli(['--file', TMP_PBF, '--db', DB_LIMIT2, '--limit', '2', '--quiet']);
  eq('--limit 2 退出码为 0', lim2.status, 0);
  const dbL2 = openDatabase(DB_LIMIT2);
  eq('--limit 2 → nodes 2 个', one(dbL2, 'SELECT COUNT(*) AS c FROM nodes').c, 2);
  eq('--limit 2 → ways 2 个', one(dbL2, 'SELECT COUNT(*) AS c FROM ways').c, 2);
  eq('--limit 2 → relations 1 个（401 不可见但占了第 2 个配额）',
    one(dbL2, 'SELECT COUNT(*) AS c FROM relations').c, 1);
  eq('--limit 2 → 被截掉的 way 300/301 不存在',
    [one(dbL2, 'SELECT COUNT(*) AS c FROM ways WHERE id = 300').c,
      one(dbL2, 'SELECT COUNT(*) AS c FROM ways WHERE id = 301').c], [0, 0]);
  dbL2.close();

  /* ---------------- 7. --force 幂等 ---------------- */
  console.log('\n=== 7. --force 重新导入幂等 ===');
  const forced = runCli(['--file', TMP_PBF, '--db', DB_MAIN, '--force', '--quiet']);
  eq('--force 退出码为 0', forced.status, 0);
  const dbF = openDatabase(DB_MAIN);
  eq('--force 后 nodes/ways/relations 行数不变',
    [one(dbF, 'SELECT COUNT(*) AS c FROM nodes').c, one(dbF, 'SELECT COUNT(*) AS c FROM ways').c,
      one(dbF, 'SELECT COUNT(*) AS c FROM relations').c], [6, 4, 2]);
  eq('--force 后 way_index / node_index 行数不变',
    [one(dbF, 'SELECT COUNT(*) AS c FROM way_index').c, one(dbF, 'SELECT COUNT(*) AS c FROM node_index').c], [3, 6]);
  eq('--force 后 next_node_id 仍然是 501', Number(one(dbF, "SELECT value FROM meta WHERE key='next_node_id'").value), 501);
  dbF.close();
  const dup = runCli(['--file', TMP_PBF, '--db', DB_MAIN, '--quiet']);
  eq('不带 --force 的重复导入退出码为 1', dup.status, 1);

  /* ---------------- 8. fetch-osm.js 的纯函数与离线路径 ---------------- */
  console.log('\n=== 8. fetch-osm.js：格式识别 / md5 / 磁盘预检 / --print-env ===');
  eq('kindFromName(.osm.pbf)', fetchOsm.kindFromName('china-latest.osm.pbf'), 'osm.pbf');
  eq('kindFromName(.pbf)', fetchOsm.kindFromName('x.pbf'), 'osm.pbf');
  eq('kindFromName(.osm.gz)', fetchOsm.kindFromName('Beijing.osm.gz'), 'osm.gz');
  eq('kindFromName(.osm)', fetchOsm.kindFromName('tiny.osm'), 'osm');
  eq('kindFromName(未知)', fetchOsm.kindFromName('foo.bin'), 'unknown');

  eq('parseMd5Text 只取摘要', fetchOsm.parseMd5Text('f7973b5d24ebceaa79afb33876bd4fb2\n'),
    'f7973b5d24ebceaa79afb33876bd4fb2');
  eq('parseMd5Text 兼容 "hash  文件名" 形式',
    fetchOsm.parseMd5Text('F7973B5D24EBCEAA79AFB33876BD4FB2  china-latest.osm.pbf'),
    'f7973b5d24ebceaa79afb33876bd4fb2');
  eq('parseMd5Text 对垃圾内容返回 null', fetchOsm.parseMd5Text('<html>404</html>'), null);

  const freeRes = fetchOsm.freeBytesOf(__dirname);
  check('freeBytesOf 能读到空闲空间（fs.statfsSync）', freeRes.free > 0, JSON.stringify(freeRes));
  const bigSpace = fetchOsm.checkSpace(path.join(__dirname, 'tmp-space-probe.osm.pbf'), 1.5 * 1024 ** 3, 'osm.pbf', 0);
  check('磁盘预检：1.5 GB 的 pbf 会要求"下载 + 库(26×) + 余量"',
    bigSpace.need > 1.5 * 1024 ** 3 * 20 && bigSpace.db === Math.ceil(1.5 * 1024 ** 3 * 26),
    JSON.stringify({ need: bigSpace.need, db: bigSpace.db }));
  const impossible = fetchOsm.checkSpace(path.join(__dirname, 'tmp-space-probe.osm.pbf'), 5 * 1024 ** 4, 'osm.pbf', 0);
  check('磁盘预检：空间不够时 ok=false', impossible.ok === false, JSON.stringify(impossible));
  eq('磁盘预检给出的倍数：pbf 26×（北京分省包实测 26.5×）、gz 12×',
    [fetchOsm.checkSpace(path.join(__dirname, 'a.osm.pbf'), 1000, 'osm.pbf', 0).factor,
      fetchOsm.checkSpace(path.join(__dirname, 'a.osm.gz'), 1000, 'osm.gz', 0).factor], [26, 12]);
  const cities = fetchOsm.loadCities();
  check('tools/cities.json 可读且含 beijing/china/monaco',
    !!(cities.cities.beijing && cities.cities.china && cities.cities.monaco), Object.keys(cities.cities).join(','));
  check('注册表放在 tools/ 里（Dockerfile 只 COPY tools/，放 deploy/ 容器里就没有）',
    fetchOsm.CITIES_FILE.replace(/\\/g, '/').endsWith('tools/cities.json'), fetchOsm.CITIES_FILE);
  eq('cities.json 里 beijing 的库路径保持老值（老部署升级后不变）', cities.cities.beijing.db, 'data/osm/osm.sqlite');
  eq('cities.json 里 china 指向 Geofabrik 全国 pbf',
    cities.cities.china.url, 'https://download.geofabrik.de/asia/china-latest.osm.pbf');

  const envRes = runFetch(['--city', 'monaco', '--print-env'], ENV_OUT);
  eq('--print-env --city monaco 退出码 0（不联网）', envRes.status, 0);
  check('--print-env 输出 OSM_SOURCE / OSM_DB / OSM_KIND（值带单引号，entrypoint 直接 eval 安全）',
    /OSM_SOURCE='[^']*monaco-latest\.osm\.pbf'/.test(envRes.out) && /OSM_DB='[^']*monaco\.sqlite'/.test(envRes.out)
    && /OSM_KIND='osm\.pbf'/.test(envRes.out)
    && /OSM_CITY_NAME='[^']*[（(][^']*'/.test(envRes.out), envRes.out.replace(/\n/g, ' | '));
  const badCity = runFetch(['--city', 'no-such-city', '--print-env'], ENV_OUT);
  eq('--print-env 对不存在的城市退出码 1', badCity.status, 1);
  check('不存在的城市会列出可选城市', /没有城市/.test(badCity.out), badCity.out.trim());
  const noSpace = runFetch(['--url', 'https://download.geofabrik.de/asia/china-latest.osm.pbf',
    '--out', path.join(__dirname, 'tmp-space-probe.osm.pbf'), '--min-free-gb', '99999'], ENV_OUT);
  eq('--min-free-gb 99999 时拒绝下载（退出码 1）', noSpace.status, 1);
  check('磁盘不足时输出中文说明与补救办法',
    /磁盘空间不足/.test(noSpace.out) && /扩容量|分省|别处导好/.test(noSpace.out), noSpace.out.slice(0, 300).replace(/\n/g, ' | '));
  check('磁盘不足时不会留下 .part 半成品',
    !fs.existsSync(path.join(__dirname, 'tmp-space-probe.osm.pbf.part')), '存在 .part 文件');

  // --check-space-for：entrypoint 在"卷里已经有来源包"时用的**离线**预检（不联网）
  const offlineSpace = runFetch(['--check-space-for', TMP_PBF, '--out', path.join(__dirname, 'tmp-offline-target.sqlite')], ENV_OUT);
  eq('--check-space-for 对本地文件退出码 0（不联网、不下载）', offlineSpace.status, 0);
  check('--check-space-for 打印"未联网"的预检结果',
    /空间预检通过（未联网）/.test(offlineSpace.out), offlineSpace.out.replace(/\n/g, ' | '));
  const offlineNoSpace = runFetch(['--check-space-for', TMP_PBF, '--out', path.join(__dirname, 'tmp-offline-target.sqlite'),
    '--min-free-gb', '99999'], ENV_OUT);
  eq('--check-space-for + --min-free-gb 99999 → 退出码 1', offlineNoSpace.status, 1);
  check('离线预检不足时也给出中文说明',
    /磁盘空间不足/.test(offlineNoSpace.out), offlineNoSpace.out.slice(0, 200).replace(/\n/g, ' | '));

  /* ---------------- 9. 真实数据（可选，需先手工下载 monaco） ---------------- */
  console.log('\n=== 9. 真实数据：Geofabrik monaco-latest.osm.pbf（若已下载） ===');
  if (!fs.existsSync(MONACO)) {
    skipped++;
    console.log('⏭  跳过：tests/tmp-monaco.osm.pbf 不存在。');
    console.log('   先跑：node tools/fetch-osm.js --url https://download.geofabrik.de/europe/monaco-latest.osm.pbf \\');
    console.log('              --out tests/tmp-monaco.osm.pbf');
  } else {
    eq('detectKind 认出真实的 monaco pbf', pbf.detectKind(MONACO), 'pbf');
    const mon = runCli(['--file', MONACO, '--db', DB_MONACO, '--force', '--quiet'], QUIET_OUT);
    eq('导入真实 pbf 退出码为 0', mon.status, 0);
    const dbM = openDatabase(DB_MONACO);
    const cNodes = one(dbM, 'SELECT COUNT(*) AS c FROM nodes').c;
    const cWays = one(dbM, 'SELECT COUNT(*) AS c FROM ways').c;
    const cRels = one(dbM, 'SELECT COUNT(*) AS c FROM relations').c;
    check(`摩纳哥节点数在合理区间（实际 ${cNodes}，期望 3 万~6 万）`,
      cNodes > 30000 && cNodes < 60000, String(cNodes));
    check(`摩纳哥 way 数在合理区间（实际 ${cWays}，期望 4000~9000）`,
      cWays > 4000 && cWays < 9000, String(cWays));
    check(`摩纳哥 relation 数在合理区间（实际 ${cRels}，期望 200~800）`,
      cRels > 200 && cRels < 800, String(cRels));
    eq('way_index 与有几何的 way 数一致', one(dbM, 'SELECT COUNT(*) AS c FROM way_index').c, cWays);
    eq('node_index 行数 = nodes 行数', one(dbM, 'SELECT COUNT(*) AS c FROM node_index').c, cNodes);
    const noGeom = one(dbM, 'SELECT COUNT(*) AS c FROM ways WHERE min_lat IS NULL').c;
    check(`摩纳哥里没有缺几何的 way（实际 ${noGeom} 个）`, noGeom === 0, String(noGeom));
    const roadWays = one(dbM, `SELECT COUNT(*) AS c FROM ways WHERE tags LIKE '%"highway":%'`).c;
    check(`带 highway 标签的 way 数量合理（实际 ${roadWays}）`, roadWays > 1000, String(roadWays));
    const withName = one(dbM, `SELECT COUNT(*) AS c FROM ways WHERE tags LIKE '%"name":%'`).c;
    check(`带 name 标签的 way 数量合理（实际 ${withName}）`, withName > 500, String(withName));
    dbM.close();
  }

  /* ---------------- 收尾 ---------------- */
  cleanupAll();

  console.log(`\n通过 ${passed} 条，失败 ${failed} 条${skipped ? `，跳过 ${skipped} 段` : ''}`);
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
