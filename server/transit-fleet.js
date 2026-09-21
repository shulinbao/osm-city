'use strict';
/**
 * 车队内存态（#规模：NIMBY Rails 那种"几万辆车同时在跑"的地基）。
 *
 * 为什么需要它：旧实现的热路径（每一小步模拟、每一次净距检查、每一帧广播）都要
 * `SELECT * FROM vehicles WHERE line_id IS NOT NULL` —— 即使有索引、即使 SQL 层已经
 * 把闲置车过滤掉，每一小步也仍然要把每一行做成一个 JS 对象再丢掉。车一多，
 * "每 3 游戏秒 10k 行 × 25 小步/tick"就是每秒钟几十万个临时对象，全花在把数据库
 * 里的静态字段（名字 / 颜色 / 车长 / 定员）搬进内存这件事上。
 *
 * 现在改成**启动时把车队读一次**，之后：
 *   · 模拟的一小步只遍历 `running`（挂了线路的车）—— 闲置车一辆都不碰，成本 ~0；
 *   · 每一帧广播也只遍历内存数组，一次 SQL 都不发；
 *   · 只有在"位置/班次状态真的变了"的时候才按批（默认每 3 秒一次、一个复用的
 *     prepared statement、一次事务）把该持久化的部分写回去。
 *
 * 数据结构（都是扁平对象 + Map，没有原型链、没有 getter）：
 *   byId       Map<vehicleId, veh>          —— 车辆静态/半静态字段（一行 vehicles 的内存镜像）
 *   all        veh[]                        —— 全部车（含闲置），广播"聚合计数"用
 *   running    veh[]                        —— 挂了线路的车：**热路径只遍历它**
 *   byLine     Map<lineId, veh[]>           —— 按线路分组（净距 / 排班 / 线路详情用）
 *   cells      Map<cellKey, veh[]>          —— 经纬度粗网格（≈1 km），按视口取车用
 *
 * veh 上的运行时字段（rt）：distance / speed / state / lat / lon / load / paxGroups /
 * heading / lod / nextStepMs …（见 transit.js 的 _runtimeFor 与 _updateVehiclePoint）。
 * 把 rt 直接挂在 veh 上，热路径就不需要 `Map.get(vehicleId)` 再来一次哈希查找。
 *
 * 这个模块**不认识 SQLite 之外的任何东西**，也不认识 Transit：它只被喂 db、config 和
 * 几个纯函数形式的回调（怎么取线段限速、怎么算加减速）。这样它可以被单独压测。
 */

/** 经纬度网格的粗细：0.01° ≈ 1.1 km（视口取车只会多取几个格子，不会漏） */
const CELL_SCALE = 100;

/** 取经纬度所在网格的 key（整数，避免字符串哈希的分配） */
function cellKey(lat, lon) {
  return (Math.floor(lat * CELL_SCALE) + 9000) * 100000 + (Math.floor(lon * CELL_SCALE) + 18000);
}

class FleetStore {
  /**
   * @param {object} db            node:sqlite 的 DatabaseSync
   * @param {object} opts
   *   opts.config      transit 的 DEFAULTS 合并结果（meterPerCar 等）
   *   opts.dynamicsFor (veh) => {accel, brake}：按车型算加减速（纯函数，热路径用）
   *   opts.segLimit    (veh) => number|null：本车所在路段的限速 km/h（按里程查）
   *   opts.onPersist   (n) => void：一批落盘之后的回调（记账/日志用）
   *   opts.persistMs   落盘间隔（真实毫秒），默认 3000
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.config = opts.config || {};
    this.dynamicsFor = opts.dynamicsFor || (() => ({ accel: 0.8, brake: 0.9 }));
    this.segLimit = opts.segLimit || null;
    this.onPersist = opts.onPersist || null;
    this.persistMs = Math.max(250, Number(opts.persistMs) || 3000);
    // 每辆车"当前位置脏了没有"的位图：用 id 当下标（id 从 1 开始自增）
    this._dirty = [];

    this.byId = new Map();
    this.all = [];
    this.running = [];
    this.byLine = new Map();
    this.cells = new Map();

    this.stats = {
      loaded: 0, loadMs: 0, persisted: 0, persistOps: 0, persistMs: 0,
      dirty: 0, upserts: 0, removes: 0,
    };
  }

  /* ------------------------------ 装载 / 落盘 ------------------------------ */

  /**
   * 启动时读一次车队。这一步只做一次（启动阶段，见 transit.js 构造函数），
   * 之后模拟与广播都不会再读 vehicles 表。
   * @param {Array<object>} [rows] 不给就自己 SELECT（测试可以注入行，跳过数据库）
   */
  load(rows) {
    const t0 = Date.now();
    const list = rows || this.db.prepare('SELECT * FROM vehicles').all();
    this.byId.clear();
    this.all.length = 0;
    this.running.length = 0;
    this.byLine.clear();
    this.cells.clear();
    this._dirty.length = 0;
    for (const row of list) {
      const veh = this._make(row);
      this._link(veh);
      this.stats.loaded += 1;
    }
    // 持久化的语句**第一次真的要写的时候**才准备（load(rows) 那种"纯内存"用法不该碰数据库）
    this._stSave = null;
    this.stats.loadMs = Date.now() - t0;
    return this.stats.loaded;
  }

  /** 一行 vehicles → 内存里的 veh（不做任何校验，字段与表一一对应） */
  _make(row) {
    const cars = Math.max(1, Number(row.cars) || 1);
    const capPerCar = Math.max(0, Number(row.capacity_per_car) || 0);
    const dyn = this.dynamicsFor(row);
    return {
      id: Number(row.id),
      owner: row.owner,
      companyId: row.company_id == null ? null : Number(row.company_id),
      lineId: row.line_id == null ? null : Number(row.line_id),
      name: row.name,
      kind: row.kind || 'rail',
      cars,
      capacityPerCar: capPerCar,
      capacity: cars * capPerCar,
      maxSpeed: Number(row.max_speed) || 0,
      lengthM: Number(row.length_m) || cars * (Number(this.config.meterPerCar) || 20),
      cost: Number(row.cost) || 0,
      createdAt: row.created_at == null ? null : Number(row.created_at),
      // ── 兼容别名 ──
      // transit.js 里有一批老代码是按**数据库行的形状**读车辆的（`vehicle.max_speed`、
      // `vehicle.company_id`、`vehicle.capacity_per_car`…，见 _runTable / _companyFor /
      // _serveStation）。这些别名让内存车队成为"数据库行的超集"：热路径可以直接把 veh
      // 当行用，不必为了字段名不同而多拷一个对象。两边永远同步（只在这里和 upsert 里写）。
      company_id: row.company_id == null ? null : Number(row.company_id),
      line_id: row.line_id == null ? null : Number(row.line_id),
      capacity_per_car: capPerCar,
      max_speed: Number(row.max_speed) || 0,
      length_m: Number(row.length_m) || cars * (Number(this.config.meterPerCar) || 20),
      created_at: row.created_at == null ? null : Number(row.created_at),
      // 加减速一次算好挂在车上（热路径每一步都要用，别再走 config 解析）
      dyn,
      // 热路径里"这辆车在跑吗"的判据（等价于老代码的 `WHERE line_id IS NOT NULL`）
      running: row.line_id != null,
      // #19 服役时间 / 今日里程（跨天归零，见 transit.js）
      dayKm: 0, dayKmDay: null,
      // LOD：#分级调度 用（0 = 粗步长，1 = 细步长），nextStepMs = 下一次算它的游戏时刻
      lod: 0, nextStepMs: 0,
      // 空间索引用的当前格子（-1 = 还没有位置）
      cell: -1,
      // 这一辆车"位置脏了"的标记（批量落盘用；只对需要持久化的字段有意义）
      dirty: false,
      // 运行时状态（rt）：由 transit.js 的 _runtimeFor 填，这里先给 null
      rt: null,
    };
  }

  /** 把一辆车挂进各个索引（byId / all / running / byLine） */
  _link(veh) {
    this.byId.set(veh.id, veh);
    this.all.push(veh);
    if (veh.running) {
      this.running.push(veh);
      let arr = this.byLine.get(veh.lineId);
      if (!arr) { arr = []; this.byLine.set(veh.lineId, arr); }
      arr.push(veh);
    }
  }

  /**
   * 从各个索引里摘掉一辆车（byId / all / running / byLine / cells / 脏位图）。
   * ⚠ lineId 一定要传"**摘的时候**这辆车所在的线路"：改派（line_id 变了）之后
   * veh.lineId 已经是新线路了，用它去旧线路的数组里找永远找不到 —— 于是旧线路的
   * byLine 里会留着一个"已经不在这条线上"的车（实测：车从 L1 改派到 L2 后
   * L1 的列表还是 [4,5]、audit 报 byLine 3 ≠ running 2）。
   */
  _unlink(veh, lineId) {
    this.byId.delete(veh.id);
    const ai = this.all.indexOf(veh);
    if (ai >= 0) this.all.splice(ai, 1);
    if (veh.running) {
      const ri = this.running.indexOf(veh);
      if (ri >= 0) this.running.splice(ri, 1);
      const key = lineId == null ? veh.lineId : lineId;
      const arr = this.byLine.get(key);
      if (arr) {
        const i = arr.indexOf(veh);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) this.byLine.delete(key);
      }
    }
    if (veh.cell >= 0) this._unindex(veh);
    this._dirty[veh.id] = false;
  }

  /**
   * 新建/修改一辆车（createVehicle / updateVehicle / 撤销重做都走这里）。
   * 传的是**数据库行的形状**（与 _row('vehicles', id) 一致），所以撤销重做可以直接喂进来。
   * 返回内存里的 veh（runtime 会保留——改名字不该把车重置到起点）。
   */
  upsert(row) {
    if (!row) return null;
    const id = Number(row.id);
    const cur = this.byId.get(id);
    if (!cur) {
      const veh = this._make(row);
      this._link(veh);
      this.stats.upserts += 1;
      return veh;
    }
    // 有没有"要重新挂索引"的变化（换线路 = running/byLine 都要动）
    const wasRunning = cur.running;
    const wasLine = cur.lineId;
    const cars = Math.max(1, Number(row.cars) || 1);
    const capPerCar = Math.max(0, Number(row.capacity_per_car) || 0);
    const lineId = row.line_id == null ? null : Number(row.line_id);
    const lengthM = Number(row.length_m) || cars * (Number(this.config.meterPerCar) || 20);
    const running = row.line_id != null;
    const reindex = wasRunning !== running || wasLine !== lineId;
    // ⚠ 顺序很重要：**先摘索引、再改字段、最后挂回去**。
    // 反过来的话，_unlink 会看到"已经变成新值的" veh.running —— 从 running 退到 idle 的车
    // （line_id 由 10 改成 null）会因为 veh.running 已经是 false 而**永远留在 running 数组里**
    // （实测：running 3 / byLine 还是两条线，audit 立刻报出来）。
    const cell = cur.cell;
    if (reindex) {
      if (cell >= 0) this._unindex(cur);
      this._unlink(cur, wasLine);       // 显式传**旧线路**：此时 cur.lineId 还是旧值
    }
    cur.owner = row.owner;
    cur.companyId = row.company_id == null ? null : Number(row.company_id);
    cur.lineId = lineId;
    cur.name = row.name;
    cur.kind = row.kind || 'rail';
    cur.cars = cars;
    cur.capacityPerCar = capPerCar;
    cur.capacity = cars * capPerCar;
    cur.maxSpeed = Number(row.max_speed) || 0;
    cur.lengthM = lengthM;
    cur.cost = Number(row.cost) || 0;
    cur.createdAt = row.created_at == null ? null : Number(row.created_at);
    // 兼容别名与上面同步（见 _make 里的说明）
    cur.company_id = cur.companyId;
    cur.line_id = lineId;
    cur.capacity_per_car = capPerCar;
    cur.max_speed = cur.maxSpeed;
    cur.length_m = lengthM;
    cur.created_at = cur.createdAt;
    cur.dyn = this.dynamicsFor(cur);
    cur.running = running;
    if (reindex) {
      this._link(cur);
      if (cell >= 0) { this._index(cur, cell); cur.cell = cell; }
    }
    this.stats.upserts += 1;
    return cur;
  }

  /** 删掉一辆车（deleteVehicle / 撤销重做都走这里） */
  remove(vehicleId) {
    const veh = this.byId.get(Number(vehicleId));
    if (!veh) return false;
    this._unlink(veh);
    this.stats.removes += 1;
    return true;
  }

  /**
   * 一批脏车落盘：**一个事务 + 一条复用的 prepared statement**。
   * 只有"位置/班次状态真的变了"的车会进来（位置由 transit.js 的 _markDirty 标记）。
   * 返回写了几行。
   */
  flush(force) {
    const list = [];
    for (let i = 0; i < this._dirty.length; i++) {
      if (!this._dirty[i]) continue;
      const veh = this.byId.get(i);
      if (!veh) { this._dirty[i] = false; continue; }
      list.push(veh);
    }
    if (!list.length) return 0;
    const t0 = Date.now();
    const save = this._stSave || (this._stSave = this.db.prepare('UPDATE vehicles SET line_id = ?, name = ?, cars = ?, capacity_per_car = ?, max_speed = ?, length_m = ?, kind = ? WHERE id = ?'));
    try {
      this.db.exec('BEGIN');
      for (const veh of list) {
        save.run(veh.lineId, veh.name, veh.cars, veh.capacityPerCar, veh.maxSpeed, veh.lengthM, veh.kind, veh.id);
        this._dirty[veh.id] = false;
        veh.dirty = false;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    const ms = Date.now() - t0;
    this.stats.persisted += list.length;
    this.stats.persistOps += 1;
    this.stats.persistMs += ms;
    this.stats.dirty = 0;
    if (this.onPersist) this.onPersist(list.length, ms);
    return list.length;
  }

  /** 标一辆车"该落盘了"（热路径只写一个布尔 + 位图，不做任何 I/O） */
  markDirty(veh) {
    if (!veh || this._dirty[veh.id]) return;
    this._dirty[veh.id] = true;
    veh.dirty = true;
    this.stats.dirty += 1;
  }

  /* ------------------------------ 索引 / 查询 ------------------------------ */

  /** 某条线上的全部车（运行时**直接遍历返回的数组**，别改动它） */
  vehiclesOnLine(lineId) {
    return this.byLine.get(Number(lineId)) || EMPTY;
  }

  /** 一行车的数量（线路详情里"这条线上几辆车"用） */
  countOnLine(lineId) {
    const arr = this.byLine.get(Number(lineId));
    return arr ? arr.length : 0;
  }

  get(vehicleId) { return this.byId.get(Number(vehicleId)) || null; }

  /** 在跑的车（挂线路）的条数；idle 车不算 */
  get runningCount() { return this.running.length; }
  get totalCount() { return this.all.length; }

  /** 一辆车当前所在的空间格子（没位置时返回 -1） */
  cellOf(veh) { return veh.cell; }

  /** 经纬度 → 网格坐标（整数）。单独抽出来是因为"取车"与"放车"两处必须用同一个算法。 */
  static coordX(lat) { return Math.floor(Number(lat) * CELL_SCALE); }
  static coordY(lon) { return Math.floor(Number(lon) * CELL_SCALE); }

  /** 网格坐标 → 索引 key */
  static keyOf(x, y) { return (x + 9000) * 100000 + (y + 18000); }

  /** 把车挪到新格子（位置更新时调用；同一个格子内移动是零成本） */
  updateCell(veh, lat, lon) {
    // 位置也记在 veh 上（同一格里几乎零成本）：网格只能粗筛到 ~1 km，
    // 真正"在不在视口框里"要按车的位置精确判一次（见 pickVisible）。
    veh.lat = lat;
    veh.lon = lon;
    const k = cellKey(lat, lon);
    if (veh.cell === k) return;
    if (veh.cell >= 0) this._unindex(veh);
    veh.cell = k;
    this._index(veh, k);
  }

  _index(veh, key) {
    let arr = this.cells.get(key);
    if (!arr) { arr = []; this.cells.set(key, arr); }
    arr.push(veh);
  }

  _unindex(veh) {
    const arr = this.cells.get(veh.cell);
    if (arr) {
      const i = arr.indexOf(veh);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) this.cells.delete(veh.cell);
    }
    veh.cell = -1;
  }

  /**
   * 视口取车（#广播按需 的"这一帧要给这个客户端发哪些车"）：
   * 只返回"看得见的那一批"，最多 maxCount 辆 —— 视口外的车不进这一帧。
   *
   * 口径（三条都在，先到先得）：
   *   ① own：客户端自己的车**永远带上**（车辆管理器 / 面板要看它们，不管在哪）
   *   ② 视口内的车（用经纬度网格粗筛，再按米制精确判一次，避免 1 km 网格的边角误收）
   *   ③ 视口半径外扩一档 bufferM 内的车也算"在视野附近"（跨视口边界时不会闪一下）
   *
   * 返回的数组由调用方使用；顺序 = 网格扫描顺序（稳定，便于做增量 diff）。
   */
  pickVisible(bounds, opts = {}) {
    const out = [];
    const maxCount = Math.max(1, Number(opts.maxCount) || 400);
    const bufferM = Math.max(0, Number(opts.bufferM) || 0);
    const ownId = opts.ownId || null;
    const seen = opts.seen || new Set();
    const take = (veh, force) => {
      if (seen.has(veh.id)) return;
      if (out.length >= maxCount && !force) return;
      seen.add(veh.id);
      out.push(veh);
    };
    if (ownId) {
      for (const veh of this.all) if (veh.owner === ownId) take(veh, true);
    }
    if (!bounds) return out;
    // bounds 就是**视口本身**（transit.viewBounds 已经把半径换算好了），
    // 这里只再外扩 bufferM —— 不要再加一次"半个视口宽"的 pad：
    // 那会把取车范围放大到 3 倍边长（实测：2 km 视口配 2 km 缓冲 → 6 km 的取车框，
    // 一辆 5 km 外的车都被收进来了，等于没做按需）。
    const latPad = bufferM / 111320;
    const lat0 = bounds.minLat - latPad;
    const lat1 = bounds.maxLat + latPad;
    const midLat = (bounds.minLat + bounds.maxLat) / 2;
    const lonPad = bufferM / (111320 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));
    const lon0 = bounds.minLon - lonPad;
    const lon1 = bounds.maxLon + lonPad;
    // #分级/广播：按网格扫出"视口范围内"的车。
    // x0..x1 / y0..y1 是用 **floor(lat*100) 的整数网格**算的（与放车时同一个算法），
    // 不是"从浮点边界再 floor 一次" —— 后者会在纬度正好落在格线上时差一个格子
    // （实测：lat=39.9 时 39.9*100 = 3989.9999…，floor 之后与"边界减半径再 floor"对不上，
    //  于是视口里明明有车却一辆也取不到）。
    const x0 = Math.floor(lat0 * CELL_SCALE);
    const x1 = Math.floor(lat1 * CELL_SCALE);
    const y0 = Math.floor(lon0 * CELL_SCALE);
    const y1 = Math.floor(lon1 * CELL_SCALE);
    // 视口太大时网格会扫出非常多的格子：退化成按"到视口中心的距离"取最近的 maxCount 辆
    const cellCount = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (cellCount > 4096) return this._pickVisibleByDistance(bounds, out, maxCount, seen, ownId);
    // 多扫一圈格子：车在格子内部的位置可能刚过界，多一圈既便宜又不会漏
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      for (let y = y0 - 1; y <= y1 + 1; y++) {
        const arr = this.cells.get((x + 9000) * 100000 + (y + 18000));
        if (!arr) continue;
        for (const veh of arr) {
          if (seen.has(veh.id)) continue;
          // 精确判一次"在不在框里"（用车辆自己的位置，别信格子 —— 格子是 1 km 的粗筛）。
          // 位置优先取运行时状态（模拟里最准、每小步更新），没有 rt 时退回 updateCell 记下的
          // 那一份（纯内存用法 / 单元测试 / 只由外部摆放的场合）。
          const lat = veh.rt && veh.rt.lat != null ? veh.rt.lat : veh.lat;
          const lon = veh.rt && veh.rt.lon != null ? veh.rt.lon : veh.lon;
          if (lat == null || lon == null) continue;
          if (lat < lat0 || lat > lat1 || lon < lon0 || lon > lon1) continue;
          take(veh, false);
          if (out.length >= maxCount) return out;
        }
      }
    }
    return out;
  }

  /** 视口宽到网格扫不动时（缩到全省/全国）：按到视口中心的距离取最近的 maxCount 辆 */
  _pickVisibleByDistance(bounds, out, maxCount, seen, ownId) {
    const cLat = (bounds.minLat + bounds.maxLat) / 2;
    const cLon = (bounds.minLon + bounds.maxLon) / 2;
    const cos = Math.max(0.05, Math.cos((cLat * Math.PI) / 180));
    const cLat2 = (bounds.maxLat - bounds.minLat) / 2;
    const cLon2 = (bounds.maxLon - bounds.minLon) / 2;
    const half = Math.hypot(cLat2 * 111320, cLon2 * 111320 * cos);
    const cands = [];
    for (const veh of this.running) {
      const lat = veh.rt && veh.rt.lat != null ? veh.rt.lat : veh.lat;
      const lon = veh.rt && veh.rt.lon != null ? veh.rt.lon : veh.lon;
      if (lat == null || lon == null) continue;
      if (seen.has(veh.id) || veh.owner === ownId) continue;
      const d = Math.hypot((lat - cLat) * 111320, (lon - cLon) * 111320 * cos);
      if (d > half * 1.2) continue;
      cands.push([d, veh]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < cands.length && out.length < maxCount; i++) take(cands[i][1], false);
    return out;
  }

  /**
   * 视口外那一大批车怎么交代：#广播按需 里"其余按线路聚合"。
   * 返回 { [lineId]: count }，**最多 max 条 + 一条 'other'**：
   * 线路特别多时（实测 1500 条线 = 13.9 KB，比视口内那些车还大）只给最忙的前 max 条，
   * 其余汇总成 'other' —— 客户端要的是"别的地方还在跑"这件事，不是每条线的精确条数。
   */
  lineCounts(max) {
    const limit = Math.max(1, Number(max) || 256);
    const entries = [...this.byLine];
    if (entries.length <= limit) {
      const out = Object.create(null);
      for (const [lineId, arr] of entries) out[lineId] = arr.length;
      return out;
    }
    entries.sort((a, b) => b[1].length - a[1].length);
    const out = Object.create(null);
    let other = 0;
    for (let i = 0; i < entries.length; i++) {
      if (i < limit) out[entries[i][0]] = entries[i][1].length;
      else other += entries[i][1].length;
    }
    out.other = other;      // "其余 N 条线上一共还有多少辆在跑"
    return out;
  }

  /** 索引的一致性自检（测试用）：byId / all / running / byLine / cells 必须互相对得上 */
  audit() {
    const problems = [];
    if (this.byId.size !== this.all.length) problems.push(`byId ${this.byId.size} ≠ all ${this.all.length}`);
    let run = 0;
    for (const arr of this.byLine.values()) run += arr.length;
    if (run !== this.running.length) problems.push(`byLine 合计 ${run} ≠ running ${this.running.length}`);
    let cells = 0;
    for (const [k, arr] of this.cells) {
      cells += arr.length;
      for (const veh of arr) if (veh.cell !== k) problems.push(`车 ${veh.id} 在格子 ${k}，但自己的 cell=${veh.cell}`);
    }
    let withCell = 0;
    for (const veh of this.all) if (veh.cell >= 0) withCell += 1;
    if (cells !== withCell) problems.push(`网格里 ${cells} 辆 ≠ 有位置的车 ${withCell} 辆`);
    for (const veh of this.all) {
      if (!this.byId.has(veh.id)) problems.push(`车 ${veh.id} 不在 byId 里`);
      if (veh.running && !veh.lineId) problems.push(`车 ${veh.id} 标了 running 却没有线路`);
    }
    return problems;
  }
}

const EMPTY = [];

module.exports = { FleetStore, cellKey, CELL_SCALE };
