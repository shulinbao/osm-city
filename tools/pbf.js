'use strict';
/**
 * 零依赖 OSM PBF（Protocol Buffers）流式解析器
 *
 * 为什么有这个文件：OSM 的官方全量/分省数据（Geofabrik 的 china-latest.osm.pbf 等）
 * 是 **PBF** 而不是 XML，而本项目的导入器原先只认 XML。这里用 Node 内置模块
 * （fs + zlib）自己实现 protobuf 的 varint/字段解析，不引任何第三方包。
 *
 * 覆盖的格式（fileformat.proto + osmformat.proto）：
 *   · 文件骨架：4 字节大端 BlobHeader 长度 → BlobHeader → Blob（datasize 字节）
 *   · Blob：raw（字段 1）与 zlib_data（字段 3）；lzma/bzip2/lz4/zstd 明确报错（不做静默丢数据）
 *   · BlobHeader.type = OSMHeader / OSMData；其它类型整块跳过
 *   · HeaderBlock：bbox / required_features / optional_features / writingprogram 等
 *   · PrimitiveBlock：StringTable + 若干 PrimitiveGroup + granularity/lat_offset/lon_offset/date_granularity
 *   · DenseNodes（id/lat/lon 增量编码；keys_vals 是一条 key,val,key,val,…,0 的打包流）
 *   · Node / Way / Relation（refs、memids 增量编码；keys/vals 是字符串表下标）
 *   · Info / DenseInfo（version、timestamp、uid、user_sid、visible）
 *   · visible=false、未知字段、未知 Blob 类型、ChangeSet 一律**安全跳过**，绝不抛错
 *
 * 设计要点：
 *   1) **流式、内存有界**：绝不把整个文件读进内存。自己写了一个按需拉取的字节源
 *      （ChunkedByteSource），按 4 字节长度 / BlobHeader / Blob 逐段消费；同一时刻内存里
 *      只有一个 blob（规范上限 32 MB 压缩、raw 上限另有 64 MB 兜底）。1.5 GB 的全国数据
 *      与几百 KB 的摩纳哥数据，常驻内存没有数量级差别。
 *   2) **零拷贝优先**：能在一段 buffer 内满足的读取返回 subarray；跨段才拷一次。
 *   3) **字符串表懒解码**：StringTable 只在被引用时才把 bytes 转成 JS 字符串（并缓存），
 *      避免为每个块把几万条字符串全解一遍。
 *   4) **可复用接口**：`parsePbf(file, { onNode, onWay, onRelation, onEnd, limit })`，
 *      元素回调收到的记录形状与 XML 解析路径**完全一致**，于是导入器两条路径共用同一段写库代码。
 *
 * 元素记录形状（与 tools/import-osm.js 的 XML 路径逐字段对齐）：
 *   node     { id, lat, lon, version, tags, editor, editorName, ts, visible }
 *   way      { id, version, tags, editor, editorName, ts, refs: [nodeId, …], visible }
 *   relation { id, version, tags, editor, editorName, ts, members: [{type, ref, role}, …], visible }
 * 其中 tags 是普通对象（无标签时为 null）—— 与 XML 路径的 tagsToJson 语义一致：
 * 空对象与 null 写库后都是 NULL。visible=false 的元素**也会回调**（带 visible:false），
 * 由导入器决定跳过 —— 这样 id 分配器要用的"文件里出现过的最大 id"和 XML 路径口径一致。
 *
 * 用法：
 *   const { parsePbf, detectKind } = require('./pbf.js');
 *   await parsePbf('china-latest.osm.pbf', {
 *     onNode: (n) => …, onWay: (w) => …, onRelation: (r) => …,
 *     onHeader: (h) => …, onWarning: (msg) => …, onEnd: (stats) => …, limit: 1000,
 *   });
 */
const fs = require('fs');
const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */
/** BlobHeader 长度上限（规范：64 KiB） */
const MAX_BLOB_HEADER = 64 * 1024;
/** BlobHeader.datasize 上限（规范：32 MiB） */
const MAX_BLOB_DATASIZE = 32 * 1024 * 1024;
/** 解压后单个 blob 的上限（防 zip bomb；真实数据的块通常 < 8 MiB） */
const MAX_RAW_BLOB = 64 * 1024 * 1024;
/** 读取流的分块大小 */
const READ_CHUNK = 1 << 20;
/** 纳度 → 度 */
const NANO = 1e-9;

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

/** protobuf 支持的 required_features；遇到不认识的只在 warning 里说清楚，不中断导入 */
const KNOWN_REQUIRED_FEATURES = new Set([
  'OsmSchema-V0.6',
  'DenseNodes',
  'HistoricalInformation',   // 历史文件里会有 visible=false 的元素，我们本来就跳过它们
  'LocationsOnWays',         // way 自带 lat/lon，我们仍然用 refs（更重要：refs 是编辑语义）
]);

const MAX_TAGS = 200;          // 与 server/osmdb.js 的 stringifyTags 以及 XML 路径一致

/** 2 的幂：用乘法累加 varint，避免 `<<` 的 32 位截断（id/时间戳可能超过 2^31） */
const POW2 = new Float64Array(64);
for (let i = 0; i < 64; i++) POW2[i] = Math.pow(2, i);

/* ------------------------------------------------------------------ *
 * protobuf 解码基元
 * ------------------------------------------------------------------ */

/** zigzag 解码：protobuf 的 sint32/sint64（负数用这种编码） */
function zigzagDecode(n) {
  return n % 2 === 1 ? -(n + 1) / 2 : n / 2;
}

/** zigzag 编码（与 zigzagDecode 互逆，见 tests/pbf-import-test.js 的往返断言）
 *  注意：JS 是双精度浮点，|v| > 2^52 时 `2v-1` 会丢精度（OSM 的 sint 值远小于这个量级：
 *  id/坐标增量都在 2^40 以内，ns 级时间戳也在 2^53 以内）。 */
function zigzagEncode(v) {
  return v < 0 ? (-v) * 2 - 1 : v * 2;
}

/**
 * 一个极小的 protobuf 读取器：在一个 buffer 的 [pos, end) 区间上顺序读字段。
 * 所有方法都做边界检查，遇到截断抛 RangeError（调用方按"文件被截断"处理）。
 */
class ProtoReader {
  constructor(buf, start, end) {
    this.buf = buf;
    this.pos = start === undefined ? 0 : start;
    this.end = end === undefined ? buf.length : end;
  }

  get eof() { return this.pos >= this.end; }
  get remaining() { return this.end - this.pos; }

  /** 读无符号 varint（最多 10 字节）；超过 2^53 会丢精度，OSM 里用不到那么大的值 */
  uvarint() {
    let result = 0;
    let shift = 0;
    let pos = this.pos;
    const buf = this.buf;
    const end = this.end;
    for (let i = 0; i < 10; i++) {
      if (pos >= end) throw new RangeError('protobuf：varint 越界（字段被截断）');
      const b = buf[pos++];
      if (b < 0x80) {
        this.pos = pos;
        return result + b * POW2[shift];
      }
      result += (b & 0x7f) * POW2[shift];
      shift += 7;
    }
    throw new RangeError('protobuf：varint 超过 10 字节');
  }

  /** 读 sint32/sint64（zigzag） */
  svarint() { return zigzagDecode(this.uvarint()); }

  /** 读 int64：负数按两位补码写出的 10 字节 varint 会被还原成负值 */
  int64() {
    const v = this.uvarint();
    return v >= POW2[63] ? v - POW2[63] * 2 : v;
  }

  /** 读 int32：拒绝不了"用 64 位写出来的负数"，这里一并还原（version / granularity 可能是负） */
  int32() {
    const v = this.int64();
    if (v >= 2147483648) return v - 4294967296;
    if (v < -2147483648) return v + 4294967296;
    return v;
  }

  bool() { return this.uvarint() !== 0; }

  /** 读长度前缀的字节段（返回 subarray，零拷贝） */
  bytes() {
    const len = this.uvarint();
    if (len > this.end - this.pos) {
      throw new RangeError(`protobuf：长度前缀 ${len} 超出剩余 ${this.end - this.pos} 字节`);
    }
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string() { return this.bytes().toString('utf8'); }

  /** 读字段头：返回 { field, wire } */
  tag() {
    const key = this.uvarint();
    return { field: Math.floor(key / 8), wire: key % 8 };
  }

  /** 跳过当前字段的值（未知字段一律走这里） */
  skip(wire) {
    switch (wire) {
      case WIRE_VARINT: this.uvarint(); return;
      case WIRE_I64:
        if (this.end - this.pos < 8) throw new RangeError('protobuf：fixed64 越界');
        this.pos += 8;
        return;
      case WIRE_LEN: this.bytes(); return;
      case WIRE_I32:
        if (this.end - this.pos < 4) throw new RangeError('protobuf：fixed32 越界');
        this.pos += 4;
        return;
      default:
        // 3/4 是已废弃的 group；OSM PBF 不会产生，遇到就明确报错，别静默错位
        throw new RangeError('protobuf：不支持的 wire type ' + wire);
    }
  }

  /** 读 packed 的 uint32/int32（也兼容"非 packed"写法：wire=0 的单个值） */
  packedInt32s(out) {
    const arr = out || [];
    const len = this.uvarint();
    const end = this.pos + len;
    if (end > this.end) throw new RangeError('protobuf：packed 字段越界');
    while (this.pos < end) arr.push(this.int32());
    return arr;
  }

  /** 读 packed 的 sint32/sint64 */
  packedSvarints(out) {
    const arr = out || [];
    const len = this.uvarint();
    const end = this.pos + len;
    if (end > this.end) throw new RangeError('protobuf：packed 字段越界');
    while (this.pos < end) arr.push(this.svarint());
    return arr;
  }

  /** 读 packed 的 bool */
  packedBools(out) {
    const arr = out || [];
    const len = this.uvarint();
    const end = this.pos + len;
    if (end > this.end) throw new RangeError('protobuf：packed 字段越界');
    while (this.pos < end) arr.push(this.uvarint() !== 0);
    return arr;
  }

  /** packed sint64 → 原地前缀和（增量编码：id / lat / lon / refs / memids） */
  packedSvarintsDelta(out) {
    const arr = this.packedSvarints(out);
    let acc = 0;
    for (let i = 0; i < arr.length; i++) { acc += arr[i]; arr[i] = acc; }
    return arr;
  }
}

/* ------------------------------------------------------------------ *
 * 字符串表（懒解码）
 * ------------------------------------------------------------------ */
class StringTable {
  constructor(blockBuf) {
    this.entries = [];      // Buffer 视图（未解码）
    this.cache = [];        // 解码后的字符串（按需填充）
    const r = new ProtoReader(blockBuf);
    while (!r.eof) {
      const { field, wire } = r.tag();
      if (field === 1 && wire === WIRE_LEN) this.entries.push(r.bytes());
      else r.skip(wire);
    }
  }

  get size() { return this.entries.length; }

  /** 取第 i 条字符串；越界视为数据损坏（明确抛错，不静默给空串） */
  get(i) {
    if (i < 0 || i >= this.entries.length) {
      throw new RangeError(`PBF：字符串表下标 ${i} 越界（表长 ${this.entries.length}）`);
    }
    const hit = this.cache[i];
    if (hit !== undefined) return hit;
    const s = this.entries[i].toString('utf8');
    this.cache[i] = s;
    return s;
  }
}

/* ------------------------------------------------------------------ *
 * Blob / BlobHeader
 * ------------------------------------------------------------------ */

/** 解析 BlobHeader：{ type, indexdata, datasize } */
function decodeBlobHeader(buf) {
  const r = new ProtoReader(buf);
  const out = { type: '', indexdata: null, datasize: 0 };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: out.type = r.string(); break;
      case 2: out.indexdata = r.bytes(); break;
      case 3: out.datasize = r.int32(); break;
      default: r.skip(wire);
    }
  }
  if (out.datasize < 0 || out.datasize > MAX_BLOB_DATASIZE) {
    throw new RangeError(`PBF：BlobHeader.datasize=${out.datasize} 不合理（上限 ${MAX_BLOB_DATASIZE}）`);
  }
  return out;
}

/**
 * 解析 Blob 并返回**未压缩**的数据。
 * raw（1）直接返回；zlib_data（3）用 zlib.inflateSync 解压，并用 raw_size（2）限制输出
 * （防 zip bomb）。lzma/bzip2/lz4/zstd 明确报错：与其猜，不如让人看到真正的原因。
 */
function decodeBlob(buf) {
  const r = new ProtoReader(buf);
  let rawSize = -1;
  let compressed = null;
  let unsupported = null;
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: {
        const raw = r.bytes();
        // raw 已经解压好了，同块里若还有 zlib_data 也不管（规范只会写一种）
        if (raw.length > MAX_RAW_BLOB) throw new RangeError('PBF：raw blob 过大（' + raw.length + '）');
        return raw;
      }
      case 2: rawSize = r.int32(); break;
      case 3:
        if (wire !== WIRE_LEN) { r.skip(wire); break; }
        compressed = r.bytes();
        break;
      case 4: unsupported = unsupported || 'lzma_data'; r.skip(wire); break;
      case 5: unsupported = unsupported || 'OBSOLETE_bzip2_data'; r.skip(wire); break;
      case 6: unsupported = unsupported || 'lz4_data'; r.skip(wire); break;
      case 7: unsupported = unsupported || 'zstd_data'; r.skip(wire); break;
      default: r.skip(wire);
    }
  }
  if (compressed) {
    const limit = rawSize > 0 ? rawSize : MAX_RAW_BLOB;
    if (limit > MAX_RAW_BLOB) throw new RangeError('PBF：Blob.raw_size 过大（' + limit + '）');
    return zlib.inflateSync(compressed, { maxOutputLength: limit });
  }
  if (unsupported) {
    throw new Error('PBF：这个文件的压缩方式是 ' + unsupported + '，本解析器只支持 raw 与 zlib_data。' +
      '请改用 Geofabrik / BBBike 提供的 .osm.pbf（zlib），或先用 osmium convert 转成 .osm.pbf');
  }
  throw new Error('PBF：Blob 里既没有 raw 也没有 zlib_data（文件损坏？）');
}

/* ------------------------------------------------------------------ *
 * HeaderBlock
 * ------------------------------------------------------------------ */

/** HeaderBBox：字段都是纳度的 sint64 */
function decodeHeaderBBox(buf) {
  const r = new ProtoReader(buf);
  const out = { left: 0, right: 0, top: 0, bottom: 0 };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: out.left = r.svarint(); break;
      case 2: out.right = r.svarint(); break;
      case 3: out.top = r.svarint(); break;
      case 4: out.bottom = r.svarint(); break;
      default: r.skip(wire);
    }
  }
  return out;
}

/** 解析 HeaderBlock；内容基本用不上，但 bbox / required_features 值得看一眼 */
function decodeHeaderBlock(buf) {
  const r = new ProtoReader(buf);
  const out = {
    bbox: null, requiredFeatures: [], optionalFeatures: [],
    writingProgram: null, source: null,
    replicationTimestamp: null, replicationSequence: null, replicationBaseUrl: null,
  };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: {
        const b = decodeHeaderBBox(r.bytes());
        // 统一成导入器用的 { min_lat, min_lon, max_lat, max_lon }（单位：度）
        out.bbox = {
          min_lat: b.bottom * NANO, min_lon: b.left * NANO,
          max_lat: b.top * NANO, max_lon: b.right * NANO,
        };
        break;
      }
      case 4: out.requiredFeatures.push(r.string()); break;
      case 5: out.optionalFeatures.push(r.string()); break;
      case 16: out.writingProgram = r.string(); break;
      case 17: out.source = r.string(); break;
      case 32: out.replicationTimestamp = r.int64(); break;
      case 33: out.replicationSequence = r.int64(); break;
      case 34: out.replicationBaseUrl = r.string(); break;
      default: r.skip(wire);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Info / DenseInfo → 统一的 { version, uid, editorName, ts, visible }
 * ------------------------------------------------------------------ */

/** Info 消息（Node/Way/Relation 共用）；ctx 提供 date_granularity（时间戳单位：毫秒） */
function decodeInfo(buf, ctx) {
  const r = new ProtoReader(buf);
  const info = { version: 1, uid: 0, userSid: -1, ts: null, visible: true };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: info.version = r.int32(); break;
      case 2: {
        const t = r.int64();
        info.ts = t * ctx.dateGranularity;
        break;
      }
      case 3: r.uvarint(); break;                       // changeset：本项目不存
      case 4: info.uid = r.int32(); break;
      case 5: info.userSid = r.int32(); break;
      case 6: info.visible = r.bool(); break;
      default: r.skip(wire);
    }
  }
  if (info.version < 0) info.version = 1;               // 规范缺省 -1 == "没有版本"，与 XML 路径一致退回 1
  return info;
}

/** DenseInfo：version 是绝对值，timestamp/changeset/uid/user_sid 都是增量 */
function decodeDenseInfo(buf, ctx) {
  const r = new ProtoReader(buf);
  const out = { versions: null, ts: null, uids: null, userSids: null, visible: null };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: out.versions = r.packedInt32s(); break;
      case 2: {
        const d = r.packedSvarintsDelta();
        for (let i = 0; i < d.length; i++) d[i] *= ctx.dateGranularity;   // 单位 → 毫秒
        out.ts = d;
        break;
      }
      case 3: r.packedSvarintsDelta(); break;           // changeset：忽略（但仍要解码以跳过正确的字节数）
      case 4: out.uids = r.packedSvarintsDelta(); break;
      case 5: out.userSids = r.packedSvarintsDelta(); break;
      case 6: out.visible = r.packedBools(); break;
      default: r.skip(wire);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 元素解码
 * ------------------------------------------------------------------ */

/** keys/vals 下标 → 标签对象（最多 200 个，重复 key 后来者覆盖；空 key 跳过） */
function decodeTags(st, keys, vals) {
  if (!keys || !keys.length) return null;
  const n = Math.min(keys.length, vals ? vals.length : 0);
  if (!n) return null;
  let tags = null;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const k = st.get(keys[i]);
    if (!k) continue;
    if (tags === null) tags = Object.create(null);
    if (tags[k] === undefined) {
      if (count >= MAX_TAGS) continue;
      count++;
    }
    tags[k] = st.get(vals[i]);
  }
  return tags;
}

/** Info（或 dense 里的对应位置）→ 统一的 editor / editorName（与 XML 的 uid||user / user 对齐） */
function editorFrom(ctx, st, uid, userSid) {
  const name = userSid >= 0 ? st.get(userSid) : null;
  if (uid > 0) return { editor: String(uid), editorName: name };
  return { editor: name || null, editorName: name };
}

/** 单个 Node 消息（非 DenseNodes） */
function decodeNodeMessage(buf, st, ctx, onNode) {
  const r = new ProtoReader(buf);
  let id = 0;
  let keys = null;
  let vals = null;
  let latRaw = 0;
  let lonRaw = 0;
  let info = null;
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: id = r.svarint(); break;
      case 2: keys = r.packedInt32s(keys || undefined); break;
      case 3: vals = r.packedInt32s(vals || undefined); break;
      case 4: info = decodeInfo(r.bytes(), ctx); break;
      case 8: latRaw = r.svarint(); break;
      case 9: lonRaw = r.svarint(); break;
      default: r.skip(wire);
    }
  }
  const e = editorFrom(ctx, st, info ? info.uid : 0, info ? info.userSid : -1);
  onNode({
    id,
    lat: coordOf(ctx.latOffset, ctx.granularity, latRaw),
    lon: coordOf(ctx.lonOffset, ctx.granularity, lonRaw),
    version: info ? info.version : 1,
    tags: decodeTags(st, keys, vals),
    editor: e.editor,
    editorName: e.editorName,
    ts: info ? info.ts : null,
    visible: info ? info.visible : true,
  });
}

/** DenseNodes：一个消息里装一整块节点，id/lat/lon 增量，keys_vals 是一条打包流 */
function decodeDenseNodes(buf, st, ctx, onNode, stats) {
  const r = new ProtoReader(buf);
  let ids = null;
  let lats = null;
  let lons = null;
  let keysVals = null;
  let dense = null;
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: ids = r.packedSvarintsDelta(ids || undefined); break;
      case 5: dense = decodeDenseInfo(r.bytes(), ctx); break;
      case 8: lats = r.packedSvarintsDelta(lats || undefined); break;
      case 9: lons = r.packedSvarintsDelta(lons || undefined); break;
      case 10: keysVals = r.packedInt32s(keysVals || undefined); break;
      default: r.skip(wire);
    }
  }
  const n = ids ? ids.length : 0;
  stats.denseNodes += n;
  let kv = 0;
  for (let i = 0; i < n; i++) {
    // keys_vals 是 key,val,key,val,…,0 的一条流：每个节点以 0 结尾（所以必须逐节点推进）
    let tags = null;
    if (keysVals) {
      let count = 0;
      while (kv < keysVals.length && keysVals[kv] !== 0) {
        const k = st.get(keysVals[kv]);
        const v = st.get(keysVals[kv + 1]);
        kv += 2;
        if (!k) continue;
        if (tags === null) tags = Object.create(null);
        if (tags[k] === undefined) {
          if (count >= MAX_TAGS) continue;
          count++;
        }
        tags[k] = v;
      }
      if (kv < keysVals.length) kv++;                 // 跳过节点结束符 0
    }
    const uid = dense && dense.uids ? dense.uids[i] : 0;
    const userSid = dense && dense.userSids ? dense.userSids[i] : -1;
    const e = editorFrom(ctx, st, uid > 0 ? uid : 0, userSid === undefined ? -1 : userSid);
    const version = dense && dense.versions && dense.versions[i] >= 0 ? dense.versions[i] : 1;
    const latRaw = lats ? lats[i] : 0;
    const lonRaw = lons ? lons[i] : 0;
    onNode({
      id: ids[i],
      lat: coordOf(ctx.latOffset, ctx.granularity, latRaw),
      lon: coordOf(ctx.lonOffset, ctx.granularity, lonRaw),
      version,
      tags,
      editor: e.editor,
      editorName: e.editorName,
      ts: dense && dense.ts ? dense.ts[i] : null,
      visible: dense && dense.visible ? dense.visible[i] !== false : true,
    });
  }
}

/** Way 消息：id 是 int64（非 zigzag），refs 是增量的 sint64 */
function decodeWayMessage(buf, st, ctx, onWay) {
  const r = new ProtoReader(buf);
  let id = 0;
  let keys = null;
  let vals = null;
  let info = null;
  let refs = null;
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: id = r.int64(); break;
      case 2: keys = r.packedInt32s(keys || undefined); break;
      case 3: vals = r.packedInt32s(vals || undefined); break;
      case 4: info = decodeInfo(r.bytes(), ctx); break;
      case 8: refs = r.packedSvarintsDelta(refs || undefined); break;
      // 9/10 = LocationsOnWays 的 lat/lon：本项目用 refs 重建几何，这里按未知字段跳过
      default: r.skip(wire);
    }
  }
  const e = editorFrom(ctx, st, info ? info.uid : 0, info ? info.userSid : -1);
  onWay({
    id, version: info ? info.version : 1,
    tags: decodeTags(st, keys, vals),
    editor: e.editor, editorName: e.editorName,
    ts: info ? info.ts : null,
    refs: refs || [],
    visible: info ? info.visible : true,
  });
}

const MEMBER_TYPES = ['node', 'way', 'relation'];

/**
 * PBF 的坐标解码（规范：lat = 1e-9 × (lat_offset + granularity × raw)）。
 * 写成"先乘后除"而不是直接乘 1e-9：除法是正确舍入的，39.9 这种十进制值能拿回最近的双精度数，
 * 乘 1e-9 会多出 ~6e-15 的尾差（对地图毫无影响，但会让"同一个点导入两次"的数值对不上）。
 */
function coordOf(offset, granularity, raw) {
  return (offset + granularity * raw) / 1e9;
}
/** Relation 消息：memids 增量，type 走枚举（0=node 1=way 2=relation） */
function decodeRelationMessage(buf, st, ctx, onRelation) {
  const r = new ProtoReader(buf);
  let id = 0;
  let keys = null;
  let vals = null;
  let info = null;
  let rolesSid = null;
  let memids = null;
  let types = null;
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: id = r.int64(); break;
      case 2: keys = r.packedInt32s(keys || undefined); break;
      case 3: vals = r.packedInt32s(vals || undefined); break;
      case 4: info = decodeInfo(r.bytes(), ctx); break;
      case 8: rolesSid = r.packedInt32s(rolesSid || undefined); break;
      case 9: memids = r.packedSvarintsDelta(memids || undefined); break;
      case 10: types = r.packedInt32s(types || undefined); break;
      default: r.skip(wire);
    }
  }
  const members = [];
  const n = memids ? memids.length : 0;
  for (let i = 0; i < n; i++) {
    const t = types ? types[i] : -1;
    members.push({
      type: MEMBER_TYPES[t] === undefined ? '' : MEMBER_TYPES[t],
      ref: memids[i],
      role: rolesSid && rolesSid[i] >= 0 ? st.get(rolesSid[i]) : '',
    });
  }
  const e = editorFrom(ctx, st, info ? info.uid : 0, info ? info.userSid : -1);
  onRelation({
    id, version: info ? info.version : 1,
    tags: decodeTags(st, keys, vals),
    editor: e.editor, editorName: e.editorName,
    ts: info ? info.ts : null,
    members,
    visible: info ? info.visible : true,
  });
}

/** PrimitiveGroup：一块里可能同时有多种元素（实际是 nodes / dense / ways / relations 各一组） */
function decodePrimitiveGroup(buf, st, ctx, handlers, stats) {
  const r = new ProtoReader(buf);
  while (!r.eof) {
    const { field, wire } = r.tag();
    // 元素计数统一在 parsePbf 包装过的回调里做（含 visible=false 的元素），这里不重复计数
    switch (field) {
      case 1: decodeNodeMessage(r.bytes(), st, ctx, handlers.onNode); break;
      case 2: decodeDenseNodes(r.bytes(), st, ctx, handlers.onNode, stats); break;
      case 3: decodeWayMessage(r.bytes(), st, ctx, handlers.onWay); break;
      case 4: decodeRelationMessage(r.bytes(), st, ctx, handlers.onRelation); break;
      // 5 = ChangeSet：本项目不存变更集，跳过
      default: r.skip(wire);
    }
  }
}

/**
 * PrimitiveBlock：先收字段（StringTable 不保证排在最前，所以 group 先存字节视图），
 * 再按 granularity / offset 组装 ctx 解各组。
 */
function decodePrimitiveBlock(buf, handlers, stats) {
  const r = new ProtoReader(buf);
  let stringTableBuf = null;
  const groups = [];
  const ctx = {
    granularity: 100, latOffset: 0, lonOffset: 0, dateGranularity: 1000,
  };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: stringTableBuf = r.bytes(); break;
      case 2: groups.push(r.bytes()); break;
      case 17: ctx.granularity = r.int32(); break;
      case 19: ctx.latOffset = r.int64(); break;
      case 20: ctx.lonOffset = r.int64(); break;
      case 18: ctx.dateGranularity = r.int32(); break;
      default: r.skip(wire);
    }
  }
  if (!stringTableBuf) throw new Error('PBF：PrimitiveBlock 缺少 stringtable（文件损坏？）');
  if (!(ctx.dateGranularity > 0)) ctx.dateGranularity = 1000;
  const st = new StringTable(stringTableBuf);
  for (const g of groups) decodePrimitiveGroup(g, st, ctx, handlers, stats);
  return groups.length;
}

/* ------------------------------------------------------------------ *
 * 流式字节源：内存里只保留"还没被消费"的字节
 * ------------------------------------------------------------------ */
class ChunkedByteSource {
  constructor(stream) {
    this.stream = stream;
    this.iter = stream[Symbol.asyncIterator]();
    this.chunks = [];
    this.headOff = 0;
    this.available = 0;
    this.eof = false;
  }

  async _pull() {
    if (this.eof) return false;
    const { value, done } = await this.iter.next();
    if (done) { this.eof = true; return false; }
    if (value && value.length) {
      this.chunks.push(value);
      this.available += value.length;
    }
    return true;
  }

  /** 保证至少有 n 字节可读；返回 false 表示文件到此结束 */
  async ensure(n) {
    while (this.available < n) {
      if (!(await this._pull())) return false;
    }
    return true;
  }

  /** 取 n 字节（调用前必须先 ensure(n)） */
  take(n) {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    const availInFirst = first.length - this.headOff;
    if (availInFirst >= n) {
      const out = first.subarray(this.headOff, this.headOff + n);
      this.headOff += n;
      this.available -= n;
      if (this.headOff === first.length) { this.chunks.shift(); this.headOff = 0; }
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const c = this.chunks[0];
      const take = Math.min(c.length - this.headOff, n - written);
      c.copy(out, written, this.headOff, this.headOff + take);
      written += take;
      this.headOff += take;
      this.available -= take;
      if (this.headOff === c.length) { this.chunks.shift(); this.headOff = 0; }
    }
    return out;
  }

  /** 读 n 字节；文件不足返回 null */
  async read(n) {
    if (!(await this.ensure(n))) return null;
    return this.take(n);
  }

  destroy(err) {
    try { this.iter.return(); } catch { /* ignore */ }
    try { this.stream.destroy(err); } catch { /* ignore */ }
  }
}

/** 打开输入流；.gz 包着的 pbf（少见）用 gunzip 先解 */
function openSourceStream(file, options) {
  const read = fs.createReadStream(file, { highWaterMark: options.readChunk || READ_CHUNK });
  if (!options.gunzip) return read;
  const gunzip = zlib.createGunzip({ chunkSize: options.readChunk || READ_CHUNK });
  read.on('error', (err) => gunzip.destroy(err));
  return read.pipe(gunzip);
}

/**
 * 按 blob 逐个产出 { type, raw, bytes }。
 * 用 async generator：调用方 break/return 时会自动关掉输入流（--limit 提前收工就靠这个）。
 */
async function* readBlobStream(file, options = {}) {
  const stream = openSourceStream(file, options);
  const src = new ChunkedByteSource(stream);
  try {
    for (;;) {
      const lenBuf = await src.read(4);
      if (lenBuf === null) return;                    // 干净的文件末尾
      const headerSize = lenBuf.readUInt32BE(0);
      if (headerSize <= 0 || headerSize > MAX_BLOB_HEADER) {
        throw new Error(`PBF：BlobHeader 长度 ${headerSize} 不合理（上限 ${MAX_BLOB_HEADER}）——` +
          '这个文件不是 OSM PBF（或者开头被破坏）');
      }
      const headerBuf = await src.read(headerSize);
      if (headerBuf === null) throw new BlobTruncatedError('BlobHeader 不完整');
      const header = decodeBlobHeader(headerBuf);
      const dataBuf = await src.read(header.datasize);
      if (dataBuf === null) throw new BlobTruncatedError('Blob 不完整');
      yield { type: header.type, raw: decodeBlob(dataBuf), bytes: header.datasize + headerSize + 4 };
    }
  } finally {
    src.destroy();
  }
}

/** 文件在 blob 中间结束（可能只是被截断，由调用方决定是警告还是报错） */
class BlobTruncatedError extends Error {
  constructor(what) {
    super('PBF：文件在末尾被截断（' + what + '）');
    this.name = 'BlobTruncatedError';
    this.truncated = true;
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 流式解析一个 .osm.pbf。
 *
 * @param {string} file 文件路径
 * @param {object} options
 *   onNode(node) / onWay(way) / onRelation(relation)  元素回调（**含 visible=false 的**）
 *   onHeader(header)                                  HeaderBlock（bbox / required_features / …）
 *   onWarning(msg)                                    可恢复的问题（未知必需特性、文件被截断…）
 *   onEnd(stats)                                      正常读完时调用一次
 *   limit                                             每种元素各取前 N 个，都到齐就停止读取
 *   gunzip                                            true = 输入是 .gz 包着的 pbf
 *   readChunk                                         读缓冲大小（默认 1 MiB）
 * @returns {Promise<object>} stats
 */
async function parsePbf(file, options = {}) {
  const handlers = {
    onNode: options.onNode || (() => {}),
    onWay: options.onWay || (() => {}),
    onRelation: options.onRelation || (() => {}),
  };
  const onHeader = options.onHeader || (() => {});
  const onWarning = options.onWarning || (() => {});
  const stats = {
    blobs: 0, headerBlobs: 0, dataBlobs: 0, otherBlobs: 0,
    nodes: 0, denseNodes: 0, ways: 0, relations: 0,
    bytes: 0, truncated: false, aborted: false,
    header: null, unsupportedFeatures: [],
  };
  const limit = Number.isFinite(options.limit) && options.limit >= 0 ? Math.trunc(options.limit) : null;
  const seen = { node: 0, way: 0, relation: 0 };

  const countingOnNode = (n) => { seen.node++; stats.nodes++; handlers.onNode(n); };
  const countingOnWay = (w) => { seen.way++; stats.ways++; handlers.onWay(w); };
  const countingOnRelation = (r) => { seen.relation++; stats.relations++; handlers.onRelation(r); };
  const wrappedHandlers = { onNode: countingOnNode, onWay: countingOnWay, onRelation: countingOnRelation };

  try {
    for await (const blob of readBlobStream(file, options)) {
      stats.blobs++;
      stats.bytes += blob.bytes;
      if (blob.type === 'OSMHeader') {
        stats.headerBlobs++;
        const header = decodeHeaderBlock(blob.raw);
        stats.header = header;
        for (const f of header.requiredFeatures) {
          if (!KNOWN_REQUIRED_FEATURES.has(f)) {
            stats.unsupportedFeatures.push(f);
            onWarning('PBF 头里声明了不认识的必需特性 "' + f + '"（按规范本应拒绝），' +
              '这里选择继续：未知字段会被安全跳过，但相关数据可能不完整');
          }
        }
        onHeader(header);
      } else if (blob.type === 'OSMData') {
        stats.dataBlobs++;
        decodePrimitiveBlock(blob.raw, wrappedHandlers, stats);
      } else {
        // 未知类型（例如将来新增的块）：整块跳过，不猜
        stats.otherBlobs++;
        onWarning('PBF 里出现未知块类型 "' + blob.type + '"，已整块跳过');
      }
      if (limit !== null &&
        seen.node >= limit && seen.way >= limit && seen.relation >= limit) {
        stats.aborted = true;
        break;                                  // 提前收工：generator 的 finally 会关掉输入流
      }
    }
  } catch (err) {
    // 文件在末尾被截断（下载没下完 / 磁盘写坏）：与 XML 路径一样"警告 + 保留已解析的部分"，
    // 而不是把已经写进库的元素全部回滚。调用方看 stats.truncated 就知道发生过这件事。
    if (err && err.truncated) {
      stats.truncated = true;
      onWarning(err.message + '，已忽略残片（解析到的元素保持有效）');
    } else {
      throw err;
    }
  }
  if (options.onEnd) options.onEnd(stats);
  return stats;
}

/**
 * 判断一个文件是什么格式（导入器靠它自动选解析路径）。
 * 返回 'pbf' | 'gzip-pbf' | 'xml' | 'gzip-xml' | 'empty' | 'unknown'
 */
function sniffBuffer(buf) {
  if (!buf || buf.length === 0) return 'empty';
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    // gz 包着什么？只解开头一段看看。finishFlush: Z_SYNC_FLUSH 让 zlib 容忍"输入还没读完"
    // （否则 gunzipSync 会因为 unexpected end of file 直接抛错）——这正是我们想要的：
    // 判断格式只需要开头几十字节，不必把 47 MB 全解开。
    let head;
    try {
      head = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      return 'unknown';
    }
    const inner = sniffBuffer(head.subarray(0, 64));
    return inner === 'pbf' ? 'gzip-pbf' : (inner === 'xml' ? 'gzip-xml' : 'unknown');
  }
  // PBF：4 字节大端长度 + BlobHeader（内嵌 "OSMHeader"/"OSMData" 的 type）
  if (buf.length >= 4) {
    const size = buf.readUInt32BE(0);
    if (size > 0 && size <= MAX_BLOB_HEADER && buf.length >= 4 + Math.min(size, buf.length - 4)) {
      const tail = buf.subarray(4, Math.min(buf.length, 4 + size)).toString('latin1');
      if (tail.includes('OSMHeader') || tail.includes('OSMData')) return 'pbf';
    }
  }
  // XML：跳过 BOM 与空白后是 '<'
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  if (i < buf.length && buf[i] === 0x3c /* < */) return 'xml';
  return 'unknown';
}

/** 读文件开头（默认 256 KiB，足够覆盖 BlobHeader 与 gz 头）后判断格式 */
function detectKind(file, sampleBytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(sampleBytes);
    const n = fs.readSync(fd, buf, 0, sampleBytes, 0);
    return sniffBuffer(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ *
 * 编码器（只给测试与夹具生成用；导入路径不用它）
 * ------------------------------------------------------------------ */

/** 无符号 varint 编码 */
function encodeUvarint(value) {
  let v = value;
  const out = [];
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

/** 与 encodeUvarint 配对：从 buffer 的 pos 处读一个 varint（测试往返用） */
function decodeUvarint(buf, pos = 0) {
  const r = new ProtoReader(buf, pos);
  const v = r.uvarint();
  return { value: v, next: r.pos };
}

function encodeSvarint(value) { return encodeUvarint(zigzagEncode(value)); }

function encodeTag(field, wire) { return encodeUvarint(field * 8 + wire); }

function encodeVarintField(field, value) { return Buffer.concat([encodeTag(field, WIRE_VARINT), encodeUvarint(value)]); }
function encodeSvarintField(field, value) { return Buffer.concat([encodeTag(field, WIRE_VARINT), encodeSvarint(value)]); }

/** 长度前缀消息（嵌套消息与 bytes/string 字段都用它） */
function withLengthPrefix(payload) {
  return Buffer.concat([encodeUvarint(payload.length), payload]);
}

function encodeBytesField(field, payload) {
  return Buffer.concat([encodeTag(field, WIRE_LEN), withLengthPrefix(payload)]);
}

function encodeStringField(field, s) { return encodeBytesField(field, Buffer.from(s, 'utf8')); }

/** packed 字段；encodeOne 决定每个值的编码方式 */
function encodePackedField(field, values, encodeOne) {
  const parts = [];
  for (const v of values) parts.push(encodeOne(v));
  return encodeBytesField(field, Buffer.concat(parts));
}

/** 增量序列（DenseNodes 的 id/lat/lon、Way.refs、Relation.memids） */
function deltaEncode(values) {
  const out = [];
  let prev = 0;
  for (const v of values) { out.push(v - prev); prev = v; }
  return out;
}

/** BlobHeader 消息 */
function encodeBlobHeader(type, datasize) {
  return Buffer.concat([
    encodeStringField(1, type),
    encodeVarintField(3, datasize),
  ]);
}

/** zlib 压缩的 Blob 消息 */
function encodeZlibBlob(raw) {
  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    encodeVarintField(2, raw.length),
    encodeBytesField(3, compressed),
  ]);
}

/** raw（未压缩）Blob 消息 */
function encodeRawBlob(raw) {
  return encodeBytesField(1, raw);
}

/**
 * 把若干 { type, data } 块拼成一个完整的 .pbf：
 * 4 字节大端 BlobHeader 长度 + BlobHeader + Blob
 */
function encodePbfFile(blocks) {
  const parts = [];
  for (const b of blocks) {
    const blob = b.raw ? encodeRawBlob(b.data) : encodeZlibBlob(b.data);
    const header = encodeBlobHeader(b.type, blob.length);
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(header.length, 0);
    parts.push(lenBuf, header, blob);
  }
  return Buffer.concat(parts);
}

/** StringTable 消息（下标 0 按规范是空串） */
function encodeStringTable(strings) {
  const parts = [];
  for (const s of strings) parts.push(encodeStringField(1, s));
  return Buffer.concat(parts);
}

const encode = {
  zigzagEncode, zigzagDecode,
  uvarint: encodeUvarint, svarint: encodeSvarint,
  decodeUvarint,
  tag: encodeTag,
  varintField: encodeVarintField,
  svarintField: encodeSvarintField,
  bytesField: encodeBytesField,
  stringField: encodeStringField,
  packedField: encodePackedField,
  lenPrefix: withLengthPrefix,
  deltaEncode,
  blobHeader: encodeBlobHeader,
  zlibBlob: encodeZlibBlob,
  rawBlob: encodeRawBlob,
  pbfFile: encodePbfFile,
  stringTable: encodeStringTable,
};

module.exports = {
  parsePbf,
  readBlobStream,
  detectKind,
  sniffBuffer,
  decodeBlobHeader,
  decodeBlob,
  decodeHeaderBlock,
  decodePrimitiveBlock,
  ProtoReader,
  StringTable,
  ChunkedByteSource,
  BlobTruncatedError,
  zigzagEncode,
  zigzagDecode,
  encode,
  MAX_BLOB_HEADER,
  MAX_BLOB_DATASIZE,
  KNOWN_REQUIRED_FEATURES,
};

if (require.main === module) {
  // 自检用法：node tools/pbf.js <file.osm.pbf> [--limit N]
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('-'));
  const li = args.indexOf('--limit');
  const limit = li === -1 ? null : Number(args[li + 1]);
  if (!file) {
    process.stdout.write('用法：node tools/pbf.js <file.osm.pbf> [--limit N]\n');
    process.exitCode = 1;
  } else {
    const t0 = Date.now();
    parsePbf(file, {
      limit,
      onHeader: (h) => process.stdout.write('HeaderBlock：required=' + JSON.stringify(h.requiredFeatures) +
        ' 写出程序=' + h.writingProgram + '\n'),
      onWarning: (m) => process.stderr.write('警告：' + m + '\n'),
      onNode: (n) => { if (process.env.PBF_VERBOSE) process.stdout.write('node ' + JSON.stringify(n) + '\n'); },
      onWay: (w) => { if (process.env.PBF_VERBOSE) process.stdout.write('way ' + JSON.stringify(w) + '\n'); },
      onRelation: (r) => { if (process.env.PBF_VERBOSE) process.stdout.write('relation ' + JSON.stringify(r) + '\n'); },
    }).then((stats) => {
      process.stdout.write(`解析完成：nodes=${stats.nodes}（其中 DenseNodes ${stats.denseNodes}） ` +
        `ways=${stats.ways} relations=${stats.relations} blobs=${stats.blobs}` +
        `${stats.aborted ? '（到达 --limit 提前结束）' : ''} 耗时=${((Date.now() - t0) / 1000).toFixed(2)}s\n`);
    }).catch((err) => {
      process.stderr.write('解析失败：' + (err && err.message ? err.message : String(err)) + '\n');
      process.exitCode = 1;
    });
  }
}
