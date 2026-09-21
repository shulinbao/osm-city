'use strict';
/**
 * OSM XML 流式导入器（零第三方依赖，只用 Node 内置模块）
 *
 * 用法：
 *   node tools/import-osm.js --file <path.osm|path.osm.gz> --db <path.sqlite> [--limit N] [--force] [--quiet]
 *
 * 设计要点：
 *   1) 全程流式：fs.createReadStream + zlib.createGunzip，自己写增量 XML 扫描器（找 '<'…'>'，
 *      解析属性，跨 chunk 断裂用 carry 缓冲区拼接），600 MB 的 XML 也不会整块进内存。
 *   2) 批量事务：每 5 万个元素（node + way 合计）COMMIT 一次，prepared statement 全程复用。
 *   3) 几何信息（ways 的 bbox / length、relations 的 bbox、三个 R*Tree 索引）在遍历结束后
 *      一次性用 SQL 批处理 + 一次有序流式遍历回填，绝不在 JS 里逐条查库。
 *
 * 元素处理约定（与 server/osmdb.js 保持一致）：
 *   - visible="false" 的元素直接跳过（不插入任何行）；
 *   - tags 存成 JSON 字符串（无标签则 NULL）；
 *   - editor = uid（没有 uid 时退回 user），editor_name = user；
 *   - ts = timestamp 的毫秒时间戳（无 timestamp 则 NULL）；
 *   - way_nodes / relation_members 的 seq 从 0 开始；
 *   - closed = 节点数 >= 2 且首尾 ref 相同。
 *
 * --limit N 的语义：node / way / relation **各自**计数（各自按文件顺序取前 N 个），
 * 三种元素都达到 N 后会提前结束读取。--limit 用于冒烟测试，被跳过的元素仍然占用配额。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { StringDecoder } = require('node:string_decoder');

// node:sqlite 在 require 阶段就会打印 ExperimentalWarning，早于 server/dbschema.js 里的静音处理，
// 这里提前拦掉，保证 --quiet 模式下输出干净（做法与 server/dbschema.js 保持一致）
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};

const { openDatabase, setMeta } = require('../server/dbschema.js');

const EARTH_R = 6378137;              // WGS84 长半轴（米），与 server/osmdb.js 一致
const D2R = Math.PI / 180;
const BATCH_ELEMENTS = 50000;         // 每 5 万个元素提交一次事务
const READ_CHUNK = 1 << 20;           // 每次读取 1 MiB
const EMPTY_ATTRS = Object.freeze({});

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 还原 XML 实体（&amp; / &lt; / &#x4e2d; …）；没有 '&' 时原样返回，避免无谓开销 */
function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    const v = XML_ENTITIES[body];
    return v === undefined ? whole : v;
  });
}

/**
 * 找到标签结束的 '>'（跳过属性值里可能出现的 '>'）。
 * 先用 indexOf 快进到候选位置，再数一次引号数量判断引号是否闭合，绝大多数标签只需 1~2 次 indexOf。
 */
function findTagEnd(text, from) {
  let end = text.indexOf('>', from);
  while (end !== -1) {
    // 统计 [from, end] 区间内的双引号个数，偶数说明 '>' 不在引号内
    let quotes = 0;
    let p = from;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1 || q > end) break;
      quotes++;
      p = q + 1;
    }
    if ((quotes & 1) === 0) return end;
    end = text.indexOf('>', end + 1);
  }
  return -1;
}

/** 解析 [from, to) 区间内的属性串，返回普通对象；值会做 XML 反转义 */
function parseAttrs(text, from, to) {
  const attrs = {};
  let i = from;
  while (i < to) {
    while (i < to && text.charCodeAt(i) <= 32) i++;
    if (i >= to) break;
    const keyStart = i;
    while (i < to) {
      const c = text.charCodeAt(i);
      if (c === 61 /* = */ || c <= 32) break;
      i++;
    }
    const key = text.slice(keyStart, i);
    while (i < to && text.charCodeAt(i) <= 32) i++;
    if (i >= to || text.charCodeAt(i) !== 61 /* = */) continue; // 没有值的伪属性直接丢掉
    i++;                                                        // 跳过 '='
    while (i < to && text.charCodeAt(i) <= 32) i++;
    if (i >= to) { attrs[key] = ''; break; }
    const quote = text.charCodeAt(i);
    if (quote === 34 /* " */ || quote === 39 /* ' */) {
      i++;
      const valueStart = i;
      while (i < to && text.charCodeAt(i) !== quote) i++;
      attrs[key] = unescapeXml(text.slice(valueStart, i));
      if (i < to) i++;                                          // 跳过收尾引号
    } else {
      const valueStart = i;
      while (i < to && text.charCodeAt(i) > 32) i++;
      attrs[key] = unescapeXml(text.slice(valueStart, i));
    }
  }
  return attrs;
}

/** 把 "2020-01-02T03:04:05Z" 转成毫秒时间戳；无法解析返回 null */
function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 正整数解析，失败返回 fallback */
function parseIntOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 标签对象 → JSON 字符串；无标签返回 null（与 server 端 stringifyTags 行为一致） */
function tagsToJson(tags) {
  for (const _ in tags) return JSON.stringify(tags);
  return null;
}

/** Haversine 球面距离（米） */
function metersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/* ------------------------------------------------------------------ *
 * OSM XML 增量（SAX 风格）解析器
 * ------------------------------------------------------------------ */

class OsmXmlSax {
  /**
   * @param {object} handlers onOsm / onBounds / onElementStart / onTag / onNd / onMember / onElementEnd
   */
  constructor(handlers) {
    this.h = handlers;
    this.carry = '';        // 上一块里没凑齐一个完整标签的尾巴
    this.curType = null;    // 当前打开着的要素类型（node / way / relation）
    this.truncated = false; // 结束时 carry 还有残留，说明文件被截断
  }

  /** 送入一段解码后的文本 */
  write(chunk) {
    const text = this.carry ? this.carry + chunk : chunk;
    this.carry = '';
    this._scan(text);
  }

  /** 流结束 */
  end() {
    this.truncated = this.carry.length > 0;
    this.carry = '';
  }

  _scan(text) {
    const len = text.length;
    let pos = 0;
    while (pos < len) {
      const lt = text.indexOf('<', pos);
      if (lt === -1) return; // 剩余都是元素外文本，OSM XML 里没有意义，直接丢
      const c1 = text.charCodeAt(lt + 1);
      if (c1 === 33 /* ! */) {
        if (text.startsWith('!--', lt + 1)) {
          const close = text.indexOf('-->', lt + 4);
          if (close === -1) { this.carry = text.slice(lt); return; }
          pos = close + 3;
          continue;
        }
        if (text.startsWith('![CDATA[', lt + 1)) {
          const close = text.indexOf(']]>', lt + 9);
          if (close === -1) { this.carry = text.slice(lt); return; }
          pos = close + 3;
          continue;
        }
        const close = text.indexOf('>', lt + 1);
        if (close === -1) { this.carry = text.slice(lt); return; }
        pos = close + 1;
        continue;
      }
      const end = findTagEnd(text, lt + 1);
      if (end === -1) { this.carry = text.slice(lt); return; } // 标签跨块，留到下一块
      this._tag(text, lt + 1, end);
      pos = end + 1;
    }
  }

  _tag(text, from, to) {
    let i = from;
    if (text.charCodeAt(i) === 47 /* / */) {
      // 结束标签
      const name = text.slice(i + 1, to).trim();
      if ((name === 'node' || name === 'way' || name === 'relation') && this.curType === name) {
        this.curType = null;
        this.h.onElementEnd(name);
      }
      return;
    }
    if (text.charCodeAt(i) === 63 /* ? */) return; // <?xml ... ?> 之类的处理指令

    // 读元素名
    let e = i;
    while (e < to) {
      const c = text.charCodeAt(e);
      if (c <= 32 || c === 47) break;
      e++;
    }
    const name = text.slice(i, e);
    if (!name) return;

    // 是否自闭合（<node .../>）
    let selfClosing = false;
    for (let k = to - 1; k >= e; k--) {
      const c = text.charCodeAt(k);
      if (c <= 32) continue;
      selfClosing = c === 47;
      break;
    }
    const attrs = e >= to ? EMPTY_ATTRS : parseAttrs(text, e, to);

    switch (name) {
      case 'node':
      case 'way':
      case 'relation':
        this.curType = name;
        this.h.onElementStart(name, attrs);
        if (selfClosing) {
          this.curType = null;
          this.h.onElementEnd(name);
        }
        break;
      case 'tag':
        if (this.curType) this.h.onTag(attrs.k, attrs.v);
        break;
      case 'nd':
        if (this.curType === 'way') this.h.onNd(attrs.ref);
        break;
      case 'member':
        if (this.curType === 'relation') this.h.onMember(attrs.type, attrs.ref, attrs.role);
        break;
      case 'bounds':
        this.h.onBounds(attrs);
        break;
      case 'osm':
        this.h.onOsm(attrs);
        break;
      default:
        break; // note / meta / 未知元素一律忽略
    }
  }
}

/* ------------------------------------------------------------------ *
 * 导入主流程
 * ------------------------------------------------------------------ */

/** --force：清空所有 OSM 相关表（含三个 R*Tree 索引与变更日志） */
function clearOsmData(db) {
  const tables = [
    'nodes', 'ways', 'way_nodes', 'relations', 'relation_members',
    'node_index', 'way_index', 'relation_index', 'changes', 'changesets',
  ];
  db.exec('BEGIN');
  try {
    for (const t of tables) db.exec('DELETE FROM ' + t);
    // changesets 用了 AUTOINCREMENT，清表后把自增序列也复位
    try { db.exec("DELETE FROM sqlite_sequence WHERE name = 'changesets'"); } catch { /* 表不存在时忽略 */ }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/** 打开输入流：.gz 用 gunzip 流式解压，其余按纯文本读 */
function openInputStream(file) {
  const read = fs.createReadStream(file, { highWaterMark: READ_CHUNK });
  if (/\.gz$/i.test(file)) {
    const gunzip = zlib.createGunzip({ chunkSize: READ_CHUNK });
    read.on('error', (err) => gunzip.destroy(err));
    return { stream: read.pipe(gunzip), read, gunzip };
  }
  return { stream: read, read, gunzip: null };
}

/**
 * 执行导入。
 * @param {{file:string, db:string, limit?:number|null, force?:boolean, quiet?:boolean}} options
 * @returns {Promise<object>} 导入结果摘要
 */
async function importOsm(options) {
  const t0 = Date.now();
  const file = options.file;
  const dbFile = options.db;
  const quiet = !!options.quiet;
  const force = !!options.force;
  const limit = Number.isFinite(options.limit) && options.limit >= 0 ? Math.trunc(options.limit) : null;

  if (!file || !dbFile) throw new Error('必须同时指定 --file 与 --db');
  if (!fs.existsSync(file)) throw new Error('找不到输入文件：' + file);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('输入路径不是文件：' + file);

  const db = openDatabase(dbFile);
  const log = quiet ? () => {} : (msg) => process.stdout.write(msg + '\n');

  try {
    // 目标库非空且没有 --force → 直接报错
    const before = db.prepare(
      `SELECT (SELECT COUNT(*) FROM nodes) AS nodes,
              (SELECT COUNT(*) FROM ways) AS ways,
              (SELECT COUNT(*) FROM relations) AS relations`).get();
    if (!force && (before.nodes > 0 || before.ways > 0)) {
      throw new Error(
        `目标数据库已存在 OSM 数据（nodes=${before.nodes}, ways=${before.ways}, relations=${before.relations}）: ${dbFile}\n` +
        '如需清空后重新导入，请加 --force（会清空 nodes/ways/way_nodes/relations/relation_members/空间索引/changes/changesets）');
    }
    if (force) {
      log('· --force：正在清空已有 OSM 数据 …');
      clearOsmData(db);
    }

    /* ---------------- prepared statement（全程复用） ---------------- */
    const stNode = db.prepare(
      'INSERT OR REPLACE INTO nodes(id, lat, lon, version, tags, editor, editor_name, ts, deleted) VALUES(?,?,?,?,?,?,?,?,0)');
    const stWay = db.prepare(
      'INSERT OR REPLACE INTO ways(id, version, tags, editor, editor_name, ts, deleted, node_count, closed) VALUES(?,?,?,?,?,?,0,?,?)');
    const stWayNode = db.prepare('INSERT OR REPLACE INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
    const stRelation = db.prepare(
      'INSERT OR REPLACE INTO relations(id, version, tags, editor, editor_name, ts, deleted, member_count) VALUES(?,?,?,?,?,?,0,?)');
    const stRelMember = db.prepare(
      'INSERT OR REPLACE INTO relation_members(relation_id, seq, member_type, member_ref, role) VALUES(?,?,?,?,?)');

    /* ---------------- 解析状态 ---------------- */
    const counts = { nodes: 0, ways: 0, relations: 0, way_nodes: 0, relation_members: 0 };
    const encountered = { node: 0, way: 0, relation: 0 };  // 按文件顺序遇到的元素个数（含被跳过的）
    const maxSeenId = { node: 0, way: 0, relation: 0 };    // 文件里出现过的最大 id（含 visible=false 的）
    let skippedInvisible = 0;
    let skippedInvalid = 0;
    let pending = 0;              // 距离上次 COMMIT 的 node + way 数量
    let sourceVersion = null;
    let sourceBounds = null;
    let active = false;           // 当前要素是否真的在处理（--limit / visible=false 时为 false）
    let currentType = null;
    let currentAttrs = null;
    let currentTags = null;
    let currentTagCount = 0;
    let currentRefs = null;       // way 的 nd 引用
    let currentMembers = null;    // relation 的成员
    let aborted = false;

    const limits = limit === null
      ? { node: Infinity, way: Infinity, relation: Infinity }
      : { node: limit, way: limit, relation: limit };

    // 进度日志（--quiet 时静默）：最多每 3 秒打一行
    let lastLog = Date.now();
    // 采样常驻内存峰值：流式导入的内存占用应该和文件大小无关
    let peakRss = process.memoryUsage.rss();
    const sampleMemory = () => {
      const rss = process.memoryUsage.rss();
      if (rss > peakRss) peakRss = rss;
    };
    const maybeLog = () => {
      if (quiet) return;
      const now = Date.now();
      if (now - lastLog < 3000) return;
      lastLog = now;
      const secs = (now - t0) / 1000;
      const done = counts.nodes + counts.ways + counts.relations;
      log(`· 进度：nodes=${counts.nodes} ways=${counts.ways} relations=${counts.relations} ` +
        `(${(done / secs).toFixed(0)} 元素/秒，已用 ${secs.toFixed(1)}s）`);
    };

    const sax = new OsmXmlSax({
      onOsm(attrs) {
        if (attrs.version) sourceVersion = attrs.version;
      },
      onBounds(attrs) {
        sourceBounds = {
          min_lat: Number(attrs.minlat), min_lon: Number(attrs.minlon),
          max_lat: Number(attrs.maxlat), max_lon: Number(attrs.maxlon),
        };
      },
      onElementStart(type, attrs) {
        encountered[type]++;
        // 文件里出现过的最大 id：被 --limit 截掉或 visible="false" 的元素也要算，
        // 这样 next_*_id 一定大于源文件里的任何 id（IdAllocator 靠它避免新建元素撞号）
        const seenId = Number(attrs.id);
        if (Number.isFinite(seenId)) {
          const v = Math.trunc(seenId);
          if (v > maxSeenId[type]) maxSeenId[type] = v;
        }
        if (encountered[type] > limits[type]) { active = false; return; }
        if (attrs.visible === 'false') { skippedInvisible++; active = false; return; }
        active = true;
        currentType = type;
        currentAttrs = attrs;
        currentTags = Object.create(null);
        currentTagCount = 0;
        currentRefs = null;
        currentMembers = null;
        if (type === 'way') currentRefs = [];
        else if (type === 'relation') currentMembers = [];
      },
      onTag(k, v) {
        if (!active || k === undefined || v === undefined) return;
        if (currentType !== 'node' && currentType !== 'way' && currentType !== 'relation') return;
        // 与 server 端 stringifyTags 一致：最多保留 200 个标签
        if (currentTags[k] === undefined) {
          if (currentTagCount >= 200) return;
          currentTagCount++;
        }
        currentTags[k] = v;
      },
      onNd(ref) {
        if (!active) return;
        const id = Number(ref);
        if (Number.isFinite(id)) currentRefs.push(Math.trunc(id));
      },
      onMember(type, ref, role) {
        if (!active) return;
        const id = Number(ref);
        if (!Number.isFinite(id)) return;
        currentMembers.push({ type: type || '', ref: Math.trunc(id), role: role || '' });
      },
      onElementEnd(type) {
        if (!active) { active = false; return; }
        active = false;
        const attrs = currentAttrs;
        const id = Number(attrs.id);
        const rowId = Number.isFinite(id) ? Math.trunc(id) : NaN;
        if (!Number.isFinite(rowId)) { skippedInvalid++; return; }

        const version = parseIntOr(attrs.version, 1);
        const editor = attrs.uid || attrs.user || null;
        const editorName = attrs.user || null;
        const ts = parseTimestamp(attrs.timestamp);

        if (type === 'node') {
          const lat = Number(attrs.lat);
          const lon = Number(attrs.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skippedInvalid++; return; }
          stNode.run(rowId, lat, lon, version, tagsToJson(currentTags), editor, editorName, ts);
          counts.nodes++;
          pending++;
        } else if (type === 'way') {
          const refs = currentRefs;
          const n = refs.length;
          const closed = n >= 2 && refs[0] === refs[n - 1] ? 1 : 0;
          stWay.run(rowId, version, tagsToJson(currentTags), editor, editorName, ts, n, closed);
          for (let i = 0; i < n; i++) stWayNode.run(rowId, i, refs[i]);
          counts.ways++;
          counts.way_nodes += n;
          pending++;
        } else {
          const members = currentMembers;
          stRelation.run(rowId, version, tagsToJson(currentTags), editor, editorName, ts, members.length);
          for (let i = 0; i < members.length; i++) {
            const m = members[i];
            stRelMember.run(rowId, i, m.type, m.ref, m.role);
          }
          counts.relations++;
          counts.relation_members += members.length;
        }

        if (pending >= BATCH_ELEMENTS) {
          db.exec('COMMIT');
          db.exec('BEGIN');
          pending = 0;
          sampleMemory();
          maybeLog();
        }
        // 三种元素都到达 --limit 就可以收工了
        if (limits.node !== Infinity &&
          encountered.node >= limits.node && encountered.way >= limits.way && encountered.relation >= limits.relation) {
          aborted = true;
        }
      },
    });

    /* ---------------- 流式读取 ---------------- */
    log(`· 读取 ${path.basename(file)}（${formatBytes(stat.size)}${/\.gz$/i.test(file) ? '，gunzip 流式解压' : ''}）…`);
    const { stream, read, gunzip } = openInputStream(file);
    const decoder = new StringDecoder('utf8');

    db.exec('BEGIN');
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        const stopInput = () => {
          read.destroy();
          if (gunzip) gunzip.destroy();
        };
        stream.on('data', (chunk) => {
          try {
            sax.write(decoder.write(chunk));
          } catch (err) {
            done(reject, err);
            stopInput();
            return;
          }
          if (aborted) stopInput();
        });
        stream.on('end', () => {
          try { sax.write(decoder.end()); } catch { /* 尾部解码失败忽略 */ }
          done(resolve);
        });
        stream.on('error', (err) => {
          if (aborted) { done(resolve); return; } // --limit 提前断开导致的 premature close 不算失败
          done(reject, err);
        });
        stream.on('close', () => { if (aborted) done(resolve); });
      });
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    pending = 0;

    if (sax.truncated) log('· 注意：文件末尾有未闭合的标签，可能被截断，已忽略残片。');
    const elementMs = Date.now() - t0;
    log(`· 元素写入完成：nodes=${counts.nodes} ways=${counts.ways} relations=${counts.relations}` +
      `${aborted ? '（已到达 --limit，提前结束读取）' : ''}，耗时 ${(elementMs / 1000).toFixed(1)}s`);

    /* ---------------- 回填几何与空间索引 ---------------- */
    if (!quiet) log('· 回填 ways 的 bbox / length、relations 的 bbox 与空间索引 …');
    const geom = backfillGeometry(db, log, quiet);

    /* ---------------- meta ---------------- */
    const finalCounts = {
      nodes: db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c,
      ways: db.prepare('SELECT COUNT(*) AS c FROM ways').get().c,
      relations: db.prepare('SELECT COUNT(*) AS c FROM relations').get().c,
      way_nodes: db.prepare('SELECT COUNT(*) AS c FROM way_nodes').get().c,
      relation_members: db.prepare('SELECT COUNT(*) AS c FROM relation_members').get().c,
    };
    const box = db.prepare(
      'SELECT MIN(lat) AS min_lat, MAX(lat) AS max_lat, MIN(lon) AS min_lon, MAX(lon) AS max_lon FROM nodes').get();
    const maxDbId = {
      node: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM nodes').get().m,
      way: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ways').get().m,
      relation: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM relations').get().m,
    };
    // 分配器要从"表里的最大 id"和"文件里出现过的最大 id"两者取大，保证新建元素不与源数据冲突
    // （visible="false" 被跳过的元素也算，例如 fixture 里被跳过的 node 9 / way 300）
    const nextIds = {
      node: Math.max(maxDbId.node, maxSeenId.node) + 1,
      way: Math.max(maxDbId.way, maxSeenId.way) + 1,
      relation: Math.max(maxDbId.relation, maxSeenId.relation) + 1,
    };

    db.exec('BEGIN');
    setMeta(db, 'source_file', path.basename(file));
    setMeta(db, 'source_version', sourceVersion || '0.6');
    setMeta(db, 'imported_at', new Date().toISOString());
    setMeta(db, 'counts', JSON.stringify(finalCounts));
    setMeta(db, 'data_bbox', JSON.stringify(
      box.min_lat === null ? null : {
        min_lat: box.min_lat, min_lon: box.min_lon, max_lat: box.max_lat, max_lon: box.max_lon,
      }));
    if (sourceBounds) setMeta(db, 'source_bounds', JSON.stringify(sourceBounds));
    setMeta(db, 'next_node_id', nextIds.node);
    setMeta(db, 'next_way_id', nextIds.way);
    setMeta(db, 'next_relation_id', nextIds.relation);
    db.exec('COMMIT');

    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }

    sampleMemory();
    const ms = Date.now() - t0;
    const dbBytes = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
    return {
      file, db: dbFile, ms,
      counts: finalCounts,
      inserted: counts,
      aborted, skippedInvisible, skippedInvalid,
      elementMs, geometryMs: geom.geometryMs,
      sourceVersion: sourceVersion || '0.6',
      sourceBounds,
      dataBbox: box.min_lat === null ? null : box,
      nextIds,
      indexes: { node_index: geom.nodeIndex, way_index: geom.wayIndex, relation_index: geom.relIndex },
      dbBytes,
      peakRss,
      elementsPerSec: ms > 0 ? (finalCounts.nodes + finalCounts.ways + finalCounts.relations) / (ms / 1000) : 0,
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 回填几何信息：
 *  1) ways 的 bbox：way_nodes JOIN nodes 聚合到 TEMP TABLE，再 UPDATE ways，最后灌 way_index；
 *  2) ways.length：按 (way_id, seq) 有序流式遍历，内存里只保留当前 way 的坐标；
 *  3) relations 的 bbox：由 way 成员的 bbox / node 成员坐标聚合（嵌套 relation 成员忽略）；
 *  4) node_index：nodes 表极值一次性插入。
 */
function backfillGeometry(db, log, quiet) {
  const t0 = Date.now();

  // ---- 1) node_index（批量插入，比逐条 upsert 快得多）----
  db.exec('BEGIN');
  db.exec('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) ' +
    'SELECT id, lon, lon, lat, lat FROM nodes');
  db.exec('COMMIT');
  const nodeIndex = db.prepare('SELECT COUNT(*) AS c FROM node_index').get().c;

  // ---- 2) ways 的 bbox ----
  db.exec('BEGIN');
  db.exec('DROP TABLE IF EXISTS temp.way_bbox');
  db.exec('CREATE TEMP TABLE way_bbox(id INTEGER PRIMARY KEY, min_lat REAL, max_lat REAL, min_lon REAL, max_lon REAL)');
  // way_nodes 主键是 (way_id, seq)，按 way_id 分组扫描是顺序的
  db.exec(`INSERT INTO temp.way_bbox(id, min_lat, max_lat, min_lon, max_lon)
           SELECT wn.way_id, MIN(n.lat), MAX(n.lat), MIN(n.lon), MAX(n.lon)
           FROM way_nodes wn JOIN nodes n ON n.id = wn.node_id
           GROUP BY wn.way_id`);
  // 没有节点的 way（或节点不在库里的 way）不会出现在 way_bbox 里，bbox 保持 NULL，也不会进 way_index
  db.exec(`UPDATE ways SET min_lat = b.min_lat, max_lat = b.max_lat, min_lon = b.min_lon, max_lon = b.max_lon
           FROM temp.way_bbox b WHERE ways.id = b.id`);
  db.exec('DROP TABLE temp.way_bbox');
  // 索引列顺序必须是 (id, min_lon, max_lon, min_lat, max_lat) —— 与基表列一一对应。
  // 注意别写成第 5 列 = max_lon：那样 max_lat 里存的是经度，视口查询
  // `i.max_lat >= minLat AND i.min_lat <= maxLat` 会失去**纬度下界**，
  // 视口南边同经度带的 way 全被当成候选（实测多搬 37% 的数据，画面不错但纯浪费）。
  // tests/tmp-lodsvr/verify-importer.js 会逐列核对这里写出来的索引。
  db.exec('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) ' +
    'SELECT id, min_lon, max_lon, min_lat, max_lat FROM ways WHERE min_lon IS NOT NULL');
  db.exec('COMMIT');
  const wayIndex = db.prepare('SELECT COUNT(*) AS c FROM way_index').get().c;

  // ---- 3) ways.length：有序流式遍历，内存只留当前 way 的坐标 ----
  db.exec('BEGIN');
  const stSetLength = db.prepare('UPDATE ways SET length = ? WHERE id = ?');
  const cursor = db.prepare(`SELECT wn.way_id AS way_id, n.lat AS lat, n.lon AS lon
                             FROM way_nodes wn JOIN nodes n ON n.id = wn.node_id
                             ORDER BY wn.way_id, wn.seq`).iterate();
  let curWay = -1;
  let prevLat = 0;
  let prevLon = 0;
  let acc = 0;
  let lengthWays = 0;
  for (const row of cursor) {
    if (row.way_id !== curWay) {
      if (curWay !== -1) { stSetLength.run(Math.round(acc * 10) / 10, curWay); lengthWays++; }
      curWay = row.way_id;
      acc = 0;
      prevLat = row.lat;
      prevLon = row.lon;
      continue;
    }
    acc += metersBetween(prevLat, prevLon, row.lat, row.lon);
    prevLat = row.lat;
    prevLon = row.lon;
  }
  if (curWay !== -1) { stSetLength.run(Math.round(acc * 10) / 10, curWay); lengthWays++; }
  db.exec('COMMIT');

  // ---- 4) relations 的 bbox ----
  db.exec('BEGIN');
  db.exec('DROP TABLE IF EXISTS temp.rel_bbox_raw');
  db.exec('CREATE TEMP TABLE rel_bbox_raw(relation_id INTEGER, min_lat REAL, max_lat REAL, min_lon REAL, max_lon REAL)');
  // way 成员：直接用 way 的 bbox
  db.exec(`INSERT INTO temp.rel_bbox_raw(relation_id, min_lat, max_lat, min_lon, max_lon)
           SELECT rm.relation_id, w.min_lat, w.max_lat, w.min_lon, w.max_lon
           FROM relation_members rm JOIN ways w ON w.id = rm.member_ref
           WHERE rm.member_type = 'way' AND w.min_lat IS NOT NULL`);
  // node 成员：退化成自身坐标
  db.exec(`INSERT INTO temp.rel_bbox_raw(relation_id, min_lat, max_lat, min_lon, max_lon)
           SELECT rm.relation_id, n.lat, n.lat, n.lon, n.lon
           FROM relation_members rm JOIN nodes n ON n.id = rm.member_ref
           WHERE rm.member_type = 'node'`);
  // relation 成员（嵌套）忽略
  db.exec(`UPDATE relations SET min_lat = b.min_lat, max_lat = b.max_lat, min_lon = b.min_lon, max_lon = b.max_lon
           FROM (SELECT relation_id, MIN(min_lat) AS min_lat, MAX(max_lat) AS max_lat,
                        MIN(min_lon) AS min_lon, MAX(max_lon) AS max_lon
                 FROM temp.rel_bbox_raw GROUP BY relation_id) b
           WHERE relations.id = b.relation_id`);
  db.exec('DROP TABLE temp.rel_bbox_raw');
  // 同上：第 5 列必须是 max_lat（写成 max_lon 会让 relation_index 也丢掉纬度下界）
  db.exec('INSERT OR REPLACE INTO relation_index(id, min_lon, max_lon, min_lat, max_lat) ' +
    'SELECT id, min_lon, max_lon, min_lat, max_lat FROM relations WHERE min_lon IS NOT NULL');
  db.exec('COMMIT');
  const relIndex = db.prepare('SELECT COUNT(*) AS c FROM relation_index').get().c;

  const geometryMs = Date.now() - t0;
  if (!quiet) {
    log(`· 几何回填完成：way_index=${wayIndex} relation_index=${relIndex} node_index=${nodeIndex} ` +
      `（含 length 的 way=${lengthWays}），耗时 ${(geometryMs / 1000).toFixed(1)}s`);
  }
  return { geometryMs, nodeIndex, wayIndex, relIndex, lengthWays };
}

/* ------------------------------------------------------------------ *
 * 命令行
 * ------------------------------------------------------------------ */

const USAGE = [
  '用法：node tools/import-osm.js --file <path.osm|path.osm.gz> --db <path.sqlite> [--limit N] [--force] [--quiet]',
  '  --file   要导入的 OSM XML 文件（支持 .osm 与 .osm.gz）',
  '  --db     目标 SQLite 数据库文件（不存在会自动创建表结构）',
  '  --limit  只导入前 N 个元素（node / way / relation 各自计数），用于冒烟测试',
  '  --force  目标库已有数据时清空后重新导入',
  '  --quiet  只打印最后一行摘要',
].join('\n');

function parseArgs(argv) {
  const out = { file: null, db: null, limit: null, force: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const inlineValue = eq === -1 ? null : a.slice(eq + 1);
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      i++;
      if (i >= argv.length) throw new Error('参数 ' + key + ' 缺少取值');
      return argv[i];
    };
    switch (key) {
      case '--file': case '-f': out.file = takeValue(); break;
      case '--db': case '-d': out.db = takeValue(); break;
      case '--limit': case '-n': {
        const v = Number(takeValue());
        if (!Number.isFinite(v) || v < 0) throw new Error('--limit 需要是非负整数');
        out.limit = Math.trunc(v);
        break;
      }
      case '--force': out.force = true; break;
      case '--quiet': case '-q': out.quiet = true; break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (key.startsWith('-')) throw new Error('未知参数：' + key);
        break;
    }
  }
  return out;
}

function buildSummaryLine(r) {
  return `导入完成：nodes=${r.counts.nodes} ways=${r.counts.ways} relations=${r.counts.relations} ` +
    `way_nodes=${r.counts.way_nodes} relation_members=${r.counts.relation_members} ` +
    `耗时=${(r.ms / 1000).toFixed(1)}s 库大小=${formatBytes(r.dbBytes)} 峰值内存=${formatBytes(r.peakRss)}`;
}

function printSummary(r) {
  const lines = [
    '',
    '===== OSM 导入结果 =====',
    `源文件        : ${path.basename(r.file)}`,
    `目标数据库    : ${r.db}（${formatBytes(r.dbBytes)}）`,
    `nodes         : ${r.counts.nodes}（空间索引 ${r.indexes.node_index}）`,
    `ways          : ${r.counts.ways}（way_nodes ${r.counts.way_nodes}，空间索引 ${r.indexes.way_index}）`,
    `relations     : ${r.counts.relations}（relation_members ${r.counts.relation_members}，空间索引 ${r.indexes.relation_index}）`,
    `source_version: ${r.sourceVersion}`,
    `导入耗时      : ${(r.ms / 1000).toFixed(1)}s（元素写入 ${(r.elementMs / 1000).toFixed(1)}s，几何回填 ${(r.geometryMs / 1000).toFixed(1)}s）`,
    `平均速度      : ${r.elementsPerSec.toFixed(0)} 元素/秒`,
    `峰值内存      : ${formatBytes(r.peakRss)}（流式解析，与文件大小无关）`,
    `next ids      : node=${r.nextIds.node} way=${r.nextIds.way} relation=${r.nextIds.relation}`,
  ];
  if (r.skippedInvisible || r.skippedInvalid) {
    lines.push(`已跳过        : visible=false ${r.skippedInvisible} 个，非法元素 ${r.skippedInvalid} 个`);
  }
  lines.push('========================');
  process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write('参数错误：' + err.message + '\n' + USAGE + '\n');
    process.exitCode = 1;
    return;
  }
  if (args.help || (!args.file && !args.db)) {
    process.stdout.write(USAGE + '\n');
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const quiet = args.quiet;
  try {
    const result = await importOsm(args);
    if (quiet) {
      process.stdout.write(buildSummaryLine(result) + '\n');
    } else {
      printSummary(result);
    }
  } catch (err) {
    process.stderr.write('导入失败：' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { importOsm, parseArgs, OsmXmlSax, clearOsmData, formatBytes, metersBetween, buildSummaryLine };
