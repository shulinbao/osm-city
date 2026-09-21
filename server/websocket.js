'use strict';
/**
 * 零依赖 WebSocket 服务器（RFC 6455 服务端实现）。
 * 支持：文本/二进制帧、分片、ping/pong、关闭握手、掩码校验、负载上限。
 *
 * 发送侧带**真背压**（send() 的 opts.slot，规则见下面的 DEFAULT_BULK_WATER）：
 * 整份状态帧（sim / players / info / locks）在客户端读不动时只保留最新的一份，
 * 控制帧（ack / transitAck / pong / error / chat / welcome）永远优先发出去。
 *
 * #规模（几万辆车同时在跑）时这里的角色：**sim 帧是每 250 ms 一条、每帧几十 KB 的"整份状态"**，
 * 它天生就能被"只留最新的一份"替代（客户端要的是"现在长什么样"，不是 15 秒的动画），
 * 所以 index.js 的仿真广播给每一帧带 slot:'sim'。于是：
 *   · 健康客户端（socket 待发 < bulkWater，默认 32 KB）：行为与以前完全一样，一帧不丢；
 *   · 慢客户端（正在解析上一帧 / 重绘地图）：中间那些帧被合并掉，它永远只拿到最新的一份，
 *     而且**它自己发来的 op 的 ack 不会被埋在这些过期帧后面**（ack 是控制帧，永远立刻写）。
 * 这条机制在"车队上万"时尤其重要：一帧就是几十 KB，客户端稍一停顿就会堆出好几帧，
 * 没有这层合并的话，慢客户端的 ack 延迟会随着车队规模线性变差。
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * 慢客户端的默认水位（可以被 send() 的 opts.slot / 构造选项覆盖）：
 *
 *   bulkWater     socket 待发字节超过它以后，**"整份状态"帧不再直接写**，改为在内存队列里
 *                 按 slot 合并（同一个 slot 只留最新的一份）。默认 32 KB ≈ 一帧的余量。
 *   maxQueueBytes 队列里最多替客户端留多少字节；超了就丢掉整份状态帧（控制帧永远不丢）。
 *
 * 为什么需要它：客户端只要十几秒不读（在解析 1 MB 的整份快照 / 重绘地图 / 主线程跑长脚本），
 * socket.write() 就会一路把几 MB 的帧堆进这个连接，而这个连接自己发来的 op 的 ack 只能排在
 * 这些过期帧**后面** —— 客户端自己的 15 秒超时于是先到（"服务器响应超时"）。
 * 现在的规则：
 *   ① 控制帧（ack / transitAck / pong / error / chat / ops / welcome…）不带 slot，永远立刻写，
 *      只在硬上限（8 MB）之上才排队等 drain —— 所以 ack 前面最多只有一帧左右的旧数据；
 *   ② 带 slot 的整份状态帧（sim / players / info / locks / transitSync）在背后追上水位时只保留
 *      最新一份，过期的直接丢掉（客户端要的是"现在长什么样"，不是 15 秒的动画）；
 *   ③ 于是"客户端不读"只影响它自己看到的画面新鲜度，不会把它自己的 op 拖进超时；
 *      而且服务端不再无界增长（旧版是每 250ms 堆 70 KB，堆到几 MB 还在堆）。
 */
const DEFAULT_BULK_WATER = 32 * 1024;
const DEFAULT_MAX_QUEUE = 2 * 1024 * 1024;
const HARD_LIMIT = 8 * 1024 * 1024;

class WSConnection extends EventEmitter {
  constructor(socket, req, options = {}) {
    super();
    this.socket = socket;
    this.req = req;
    this.maxPayload = options.maxPayload || 1024 * 1024; // 1 MiB
    this.state = 'open'; // open | closing | closed
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOpcode = 0;
    this._fragLength = 0;
    this._closeTimer = null;
    this._emittedClose = false;
    this.isAlive = true;
    this.lastActivity = Date.now();
    this.data = Object.create(null); // 供上层挂载会话信息

    /* 背压：见文件顶部 DEFAULT_BULK_WATER 的说明 */
    this.bulkWater = Math.max(16 * 1024, Number(options.bulkWater) || DEFAULT_BULK_WATER);
    this.maxQueueBytes = Math.max(this.bulkWater, Number(options.maxQueueBytes) || DEFAULT_MAX_QUEUE);
    this._prio = [];                 // 控制帧（FIFO，绝不丢）
    this._prioBytes = 0;
    this._bulk = [];                 // 整份状态帧（每个 slot 只留最新一份）
    this._bulkBytes = 0;
    this._bulkSlots = new Map();      // slot -> _bulk 里的下标
    this._drainBound = () => this._flushQueue();
    // 统计（实测 / 排查用）：丢掉了多少过期帧、合并了多少帧、见过的最大待发字节
    this.droppedFrames = 0;
    this.replacedFrames = 0;
    this.maxBacklog = 0;

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('drain', this._drainBound);

    socket.on('data', (d) => this._onData(d));
    socket.on('error', () => this._finalize());
    socket.on('close', () => this._finalize());
    socket.on('end', () => {
      if (this.state === 'open') this.close(1000, '');
    });
  }

  /** 这个连接还没写出去的字节数（socket 里的 + 我们队列里的） */
  get pendingBytes() {
    let wl = 0;
    try { wl = this.socket.writableLength || 0; } catch { /* ignore */ }
    return wl + this._prioBytes + this._bulkBytes;
  }

  get remoteAddress() {
    return this.socket.remoteAddress || '';
  }

  _onData(data) {
    this.lastActivity = Date.now();
    if (this.state === 'closed') return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, data]) : data;
    try {
      this._parse();
    } catch (err) {
      this.close(err.wsCode || 1002, err.message || 'protocol error');
    }
  }

  _parse() {
    for (;;) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) throw protocolError(1002, 'RSV bits must be zero');
      if (!masked) throw protocolError(1002, 'client frames must be masked');

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(this.maxPayload)) throw protocolError(1009, 'frame too large');
        len = Number(big);
        offset += 8;
      }
      if (len > this.maxPayload) throw protocolError(1009, 'frame too large');
      if (buf.length < offset + 4 + len) return; // 等待更多数据

      const mask = buf.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
      offset += len;
      this._buf = buf.subarray(offset);

      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === OP_PING) {
      this._frame(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) {
      this.isAlive = true;
      return;
    }
    if (opcode === OP_CLOSE) {
      if (this.state === 'open') {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this._frame(OP_CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        this.state = 'closing';
        this._finalize(code, 'peer closed');
      }
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BIN) {
      if (this._fragOpcode) throw protocolError(1002, 'expected continuation frame');
      if (fin) return this._deliver(opcode, payload);
      this._fragOpcode = opcode;
      this._fragLength = payload.length;
      this._frags = [payload];
      return;
    }
    if (opcode === OP_CONT) {
      if (!this._fragOpcode) throw protocolError(1002, 'unexpected continuation frame');
      this._fragLength += payload.length;
      if (this._fragLength > this.maxPayload) throw protocolError(1009, 'message too large');
      this._frags.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this._frags, this._fragLength);
      const op = this._fragOpcode;
      this._frags = [];
      this._fragOpcode = 0;
      this._fragLength = 0;
      return this._deliver(op, full);
    }
    throw protocolError(1002, 'unknown opcode ' + opcode);
  }

  _deliver(opcode, payload) {
    if (opcode === OP_TEXT) {
      this.emit('message', payload.toString('utf8'), false);
    } else {
      this.emit('message', payload, true);
    }
  }

  /** 把 opcode + 负载编码成一帧（一条 Buffer：队列/合并只按字节数记账，不用管两段写） */
  _encode(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    if (!len) return header;
    return Buffer.concat([header, payload], header.length + len);
  }

  /**
   * 一帧出去（带背压，规则见文件顶部）。
   *   · opts.slot 给了 = "整份状态帧"：背后追上水位时会被更新的一份替代 / 丢弃；
   *   · 没给 = 控制帧（ack / pong / error…）：永远立刻写，绝不因为排队被拖后。
   * 返回 false 只表示"这个连接已经不能发了"。
   */
  _frame(opcode, payload, opts) {
    if (this.state === 'closed' || !this.socket.writable) return false;
    const frame = this._encode(opcode, payload);
    let backlog = 0;
    try { backlog = this.socket.writableLength || 0; } catch { /* ignore */ }
    if (backlog > this.maxBacklog) this.maxBacklog = backlog;
    const slot = opts && opts.slot ? String(opts.slot) : null;

    if (!slot) {
      // 控制帧：立刻写（哪怕背后已经积压）；只有到了硬上限才排队等 drain，避免内存无界
      if (backlog < HARD_LIMIT) return this._writeNow(frame);
      this._prio.push(frame);
      this._prioBytes += frame.length;
      return true;
    }

    // 整份状态帧：背后没追上水位就直接写（健康客户端的行为与以前完全一样）
    if (backlog + this._bulkBytes + this._prioBytes <= this.bulkWater) {
      return this._writeNow(frame);
    }
    // 追上了水位：同一个 slot 只留最新的一份 —— 这就是"永远发最新的 sim 帧、丢掉被顶替的"
    const idx = this._bulkSlots.get(slot);
    if (idx != null) {
      const old = this._bulk[idx];
      if (old) this._bulkBytes -= old.buf.length;
      this._bulk[idx] = { slot, buf: frame };
      this._bulkBytes += frame.length;
      this.replacedFrames += 1;
      return true;
    }
    if (this._bulkBytes + this._prioBytes + frame.length > this.maxQueueBytes) {
      // 队列也满了：这一份整份状态直接不要（客户端早已落后，补一帧过期的没有意义；
      // 它一旦读起来，drain 之后会立刻收到当时最新的一份）
      this.droppedFrames += 1;
      return false;
    }
    this._bulkSlots.set(slot, this._bulk.length);
    this._bulk.push({ slot, buf: frame });
    this._bulkBytes += frame.length;
    return true;
  }

  _writeNow(frame) {
    try {
      this.socket.write(frame);
      return true;
    } catch {
      this._finalize();
      return false;
    }
  }

  /** socket 腾空了：先把控制帧发完，再把每个 slot 最新的一份整份状态发出去 */
  _flushQueue() {
    if (this.state === 'closed' || !this.socket.writable) return;
    let backlog = 0;
    try { backlog = this.socket.writableLength || 0; } catch { /* ignore */ }
    if (backlog >= HARD_LIMIT) return;         // 还没轮到我，等下一次 drain
    while (this._prio.length) {
      const frame = this._prio.shift();
      this._prioBytes -= frame.length;
      this._writeNow(frame);
      try { if (this.socket.writableLength >= HARD_LIMIT) return; } catch { return; }
    }
    if (!this._bulk.length) return;
    const frames = this._bulk;
    this._bulk = [];
    this._bulkSlots.clear();
    this._bulkBytes = 0;
    for (let i = 0; i < frames.length; i++) {
      this._writeNow(frames[i].buf);
      let full = false;
      try { full = this.socket.writableLength > this.bulkWater; } catch { full = true; }
      if (full && i + 1 < frames.length) {
        // 又追上了水位：剩下的原样放回队列，等下一轮 drain（一个 slot 一份，不会积起来）
        for (let j = i + 1; j < frames.length; j++) {
          this._bulkSlots.set(frames[j].slot, this._bulk.length);
          this._bulk.push(frames[j]);
          this._bulkBytes += frames[j].buf.length;
        }
        break;
      }
    }
  }

  /** 发送文本（string）或二进制（Buffer）。opts.slot = 可合并/可丢弃的整份状态帧 */
  send(data, opts) {
    if (this.state !== 'open') return false;
    if (typeof data === 'string') return this._frame(OP_TEXT, Buffer.from(data, 'utf8'), opts);
    return this._frame(OP_BIN, Buffer.from(data), opts);
  }

  /** 发送 JSON 对象（opts 同 send） */
  sendJSON(obj, opts) {
    return this.send(JSON.stringify(obj), opts);
  }

  ping() {
    this._frame(OP_PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.state !== 'open') return;
    this.state = 'closing';
    const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._frame(OP_CLOSE, payload);
    this._closeTimer = setTimeout(() => this._finalize(code, reason), 1500);
    if (this._closeTimer.unref) this._closeTimer.unref();
  }

  terminate() {
    this._finalize(1006, 'terminated');
  }

  _finalize(code = 1006, reason = '') {
    if (this._emittedClose) return;
    this._emittedClose = true;
    this.state = 'closed';
    if (this._closeTimer) clearTimeout(this._closeTimer);
    // 连接没了：队列里那些还没发出去的帧直接扔掉（它们本来就是"整份状态"，没有补发的意义）
    this._prio = [];
    this._prioBytes = 0;
    this._bulk = [];
    this._bulkBytes = 0;
    this._bulkSlots.clear();
    try {
      this.socket.removeListener('drain', this._drainBound);
    } catch { /* ignore */ }
    try {
      this.socket.destroy();
    } catch { /* ignore */ }
    this.emit('close', code, reason);
  }
}

function protocolError(code, message) {
  const e = new Error(message);
  e.wsCode = code;
  return e;
}

/* ------------------------- #规模：车辆位置的紧凑编码 ------------------------- */
/**
 * 一辆车的实时位置/状态 → 一个**紧凑数组**（可选的高效帧格式）。
 *
 * 背景（为什么值得单开一个格式）：sim 帧里的车是一个带 33 个字段的 JSON 对象 —— 名字、
 * 车型、`paxByDest`、`remainingStops`… 这些字段**大部分帧之间根本不变**。1 万辆车时
 * 每个字段名都要重复 1 万遍（实测单车 1621 字节，其中字段名占了约 40%）。
 * 只要客户端能接受"位置是数组"，同样的信息可以压到 200 字节上下：
 *
 *   [id, lat, lon, heading, speedKmh, load, state, distance, direction, delaySeconds, flags]
 *
 * 编码规则（读的时候照这个顺序解）：
 *   id            整数
 *   lat/lon       6 位小数（≈0.1 米精度，比 GPS 高一个量级；砍掉浮点尾巴省字节）
 *   heading       0~359 整数（度）
 *   speedKmh      整数
 *   load          整数
 *   state         0=run 1=dwell 2=scheduled 3=paused（**枚举下标**，不是字符串）
 *   distance      整数米
 *   direction     ±1
 *   delaySeconds  整数或 null
 *   flags         位掩码：1 = 有 paxByDest、2 = 有 remainingStops、4 = 有晚点、8 = 本帧位置变了
 *
 * 数组里**没有**的那些字段（owner / name / kind / lengthM / capacity / 线路 / 站点 id…）
 * 由 welcome/transitSync 的整份快照给一次，客户端按 id 查 —— 与 paxByDest 不带站名同一个思路。
 *
 * ⚠ 这是**可选的加速路径**：客户端上报 `{t:'opts', sim:'compact'}` 才启用；
 * 没上报的一律走原来的对象格式（老客户端零改动）。服务端侧见 transit.frameFor。
 */
const VEHICLE_STATE_CODE = { run: 0, dwell: 1, scheduled: 2, paused: 3 };
const VEHICLE_STATE_NAME = ['run', 'dwell', 'scheduled', 'paused'];

/** 一辆车 → 紧凑数组（缺字段给安全的默认值，绝不抛） */
function encodeVehicleTuple(t, flags) {
  if (!t) return null;
  const state = VEHICLE_STATE_CODE[t.state];
  return [
    Number(t.id) || 0,
    round6(t.lat),
    round6(t.lon),
    Math.round(Number(t.heading) || 0),
    Math.round(Number(t.speed) || 0),
    Math.round(Number(t.load) || 0),
    state === undefined ? 0 : state,
    Math.round(Number(t.distance) || 0),
    Number(t.direction) < 0 ? -1 : 1,
    t.delaySeconds == null ? null : Math.round(Number(t.delaySeconds)),
    Number(flags) || 0,
  ];
}

/** 紧凑数组 → 对象（**服务端测试与将来的客户端移植共用同一份解码逻辑**） */
function decodeVehicleTuple(tuple) {
  if (!Array.isArray(tuple)) return null;
  const [id, lat, lon, heading, speed, load, state, distance, direction, delaySeconds, flags] = tuple;
  return {
    id, lat, lon, heading, speed, load,
    state: VEHICLE_STATE_NAME[state] || 'run',
    distance, direction, delaySeconds: delaySeconds == null ? null : delaySeconds,
    flags: Number(flags) || 0,
    hasPaxByDest: (Number(flags) & 1) !== 0,
    hasRemainingStops: (Number(flags) & 2) !== 0,
    delayed: (Number(flags) & 4) !== 0,
    moved: (Number(flags) & 8) !== 0,
  };
}

/** 6 位小数（≈0.1 米）：位置够用，且不再带一长串浮点尾巴 */
function round6(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

/**
 * 把 WebSocket 服务挂到一个 http.Server 上。
 * @param {import('node:http').Server} server
 * @param {{path?: string, onConnection: (conn: WSConnection, req: any) => void, maxPayload?: number}} options
 */
function attachWebSocketServer(server, options) {
  const path = options.path || '/ws';

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const upgrade = String(req.headers['upgrade'] || '').toLowerCase();
    if (!key || upgrade !== 'websocket' || (version !== '13' && version !== '8')) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const conn = new WSConnection(socket, req, {
      maxPayload: options.maxPayload,
      bulkWater: options.bulkWater,
      maxQueueBytes: options.maxQueueBytes,
    });
    if (head && head.length) conn._onData(head);
    try {
      options.onConnection(conn, req);
    } catch (err) {
      try {
        conn.sendJSON({ t: 'error', message: 'server error: ' + err.message });
      } catch { /* ignore */ }
      conn.close(1011, 'internal error');
    }
  });
}

module.exports = {
  attachWebSocketServer, WSConnection,
  // #规模：紧凑车辆元组的编解码（服务端测试与客户端移植共用同一份口径）
  encodeVehicleTuple, decodeVehicleTuple, VEHICLE_STATE_CODE, VEHICLE_STATE_NAME,
};
