'use strict';
/**
 * OSM 编辑操作层（服务端权威）。
 *
 * 设计要点：
 *  - 每个操作都校验几何/标签/引用完整性/版本号，版本不一致直接拒绝（OSM 的冲突语义）。
 *  - 元素软锁：玩家选中某元素开始编辑时上锁，别人改不动，避免两个人同时改一条路。
 *  - 撤销/重做用"快照还原"实现：撤销项记录反向步骤，执行前再取当前状态作为重做步骤，天然对称。
 *  - 一次操作可能产出多条广播（例如分割道路 = 修改一条 + 新建一条），统一按数组下发。
 *  - 分组撤销：beginGroup / endGroup 之间的操作、以及带同一个 groupLabel 的连续操作，
 *    会合并成"一步"（一次 undo 全撤、一次 redo 全放回）。跨 osmops / transit 的合并由
 *    本文件里的 UndoBus 负责（index.js 建一条总线同时注入给两边），详见那里的说明。
 */
const { metersBetween } = require('./osmdb');
const LIMITS = {
  maxWayNodes: 2000,
  maxRelationMembers: 500,
  maxTags: 100,
  maxTagKeyLength: 64,
  maxTagValueLength: 1024,
  maxWayLengthMeters: 500000,
  maxCreateNodesPerWay: 2000,
};

const LOCK_TTL_MS = 120000;
const MAX_UNDO = 100;

class OpError extends Error {
  /**
   * @param {string} message 给玩家看的中文（一个字都没变，老客户端/测试仍然按消息判断）
   * @param {string} code    'CONFLICT' / 'LOCKED' / 'IN_USE' / 'FORBIDDEN' …
   * @param {object} [info]  结构化补充信息，原样发回客户端（目前只有版本冲突用：`{ conflict }`）
   */
  constructor(message, code = 'OP', info) {
    super(message);
    this.code = code;
    if (info) Object.assign(this, info);
  }
}

/**
 * **版本冲突回执**（结构化，随 ack 的 `conflict` 字段下发）。
 *
 * 为什么要有它：客户端收到「节点 #X 已被张三修改（版本 14）」这句中文时，只能靠**猜**才知道
 * 该刷新哪个元素、服务端现在的版本是多少。而客户端的节点版本号本来是**拿不到**的
 * （视口载荷只下发 [lat, lon]，见 server/osmdb.js 的 _fetchNodes），本地一律 0 ——
 * 于是删除这类节点永远冲突，而老客户端既不刷新也不重试，就"怎么点都失败"。
 * 有了这份回执，客户端可以立刻知道 { 类型, id, 服务端当前版本, 最后编辑者 }，
 * 刷新后自动用新版本重放一次（见 editor.js 的「版本冲突自愈」）。
 *
 * 注意：**消息文本一个字都没改**，只是多带了结构化字段，所以老客户端/老测试不受影响。
 */
function conflictInfo(type, id, cur, op) {
  const info = { conflict: { type, id: Number(id), version: Number(cur && cur.version) } };
  if (cur && cur.editorName) info.conflict.editorName = cur.editorName;
  const mine = Number(op && op.version);
  if (Number.isFinite(mine)) info.conflict.yourVersion = mine;
  return info;
}

/* ====================== 分组撤销总线（beginGroup / endGroup / groupLabel） ====================== */
/**
 * 玩家按 Ctrl+Z 时，心里只有一条时间线；但服务端本来有两套互相独立的撤销栈：
 *   · OSM 编辑（本文件）：每个操作记一组"快照步骤"；
 *   · 交通玩法（transit.js）：每个操作记一组"整行快照"。
 * 两边记法不同、深度上限也不同（100 / 50），所以"一次撤销撤掉一整组"需要一条**共用**的总线：
 * index.js 建一个 UndoBus 同时注入给 OsmOps 与 Transit，两边每压入一个撤销项都会先来总线
 * 登记（拿到全局递增的 seq）。于是：
 *
 *   · 谁的 seq 大，谁就是"最近一步"：一次 undo 永远先撤真正在时间线最上面的那一步，
 *     哪怕客户端把它发到了另一条通道（同一个通道内的行为与以前完全一样）；
 *   · beginGroup / endGroup 之间的操作，以及带同一个 groupLabel 的连续操作，会合并成
 *     一条**跨模块**的"组合步骤"（parts 按时间顺序记着每一步属于哪个模块）；
 *     一次 undo 按时间**倒序**执行组里每一步，一次 redo 再按时间**正序**放回去。
 *
 * 边界（老实写清楚，客户端按这个来用）：
 *   · 组合步骤只活在总线上（它跨两个模块，谁的栈都放不下），所以 ack 里的 undoDepth 给的是
 *     **总数** = osm + transit + 分组，另给 undoBySource / redoBySource 明细；
 *   · 组里只有一条操作时不做合并：就地改个标签，栈里还是一条（行为和以前完全一样）；
 *   · 显式分组（beginGroup）还没结束就收到 undo → 报错 GROUP_OPEN（code='GROUP_OPEN'），
 *     先 endGroup 或 abortGroup；客户端崩了留下的分组由 ttlMs 自动收尾，不会把撤销永久卡住；
 *   · 自动分组（groupLabel）在"下一条没带标签的操作 / 换标签的操作 / 下一次 undo /
 *     距上一条超过 idleMs"时收尾；
 *   · 没有共享总线时（例如测试里直接 new Transit(db)），每个模块自带一条总线，分组照样能用，
 *     只是组里只会有这一个模块的操作。
 *
 * 客户端用法（两条通道都支持，op 形状完全一样）：
 *   { k:'beginGroup', label }                     开始分组（可嵌套，最多 maxDepth 层）
 *   { k:'endGroup',   label }                     收尾并合并成一步；label 覆盖组名
 *   { k:'abortGroup' }                            放弃分组（每条操作各自保留一步，不合并）
 *   { k:'groupStatus' }                           查当前分组状态（不改变任何东西）
 *   { 任意操作, groupLabel:'生成示例线路' }        自动分组：相邻的同名操作算一组
 * 每个 ack 里都会带 group 字段：{ id, label, display, open, depth, parts, steps, osm, transit,
 * sources, undoLabel, redoLabel, merged }，客户端可以直接显示「撤销：生成示例线路（12 步）」。
 */
const GROUP_DEFAULTS = {
  maxDepth: 8,       // 最多能嵌套几层分组（beginGroup 可以嵌套）
  maxParts: 500,     // 一组最多几条操作：超了自动收尾，避免客户端忘了 endGroup
  idleMs: 5000,      // 自动分组：相邻两条带 groupLabel 的操作间隔超过这么久就算新的一组
  ttlMs: 120000,     // 显式分组：这么久没动静就自动收尾
  maxGroups: 50,     // 每个玩家最多记着多少个"已收尾的分组"（与各模块栈上限同量级）
};

/** 分组类操作：由总线自己处理，不走模块的编辑逻辑 */
const GROUP_OPS = new Set(['beginGroup', 'endGroup', 'abortGroup', 'groupStatus']);

/** 分组相关的错误：继承 OpError，这样 OSM 通道原有的 instanceof 判断一个字都不用改 */
class GroupError extends OpError {
  constructor(message, code = 'GROUP') { super(message, code); }
}

function groupStepsOf(entry) {
  return entry && Array.isArray(entry.steps) ? entry.steps.length : 0;
}

function cleanGroupLabel(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
}

class UndoBus {
  constructor(options = {}) {
    this.options = Object.assign({}, GROUP_DEFAULTS, options || {});
    this.modules = new Map();     // 'osm' | 'transit' -> 模块实例
    this.users = new Map();       // userId -> { frames, groups, redos, seq }
    this.groupCounter = 0;
  }

  /** 把模块挂到总线上（src 是这条通道的名字：osm / transit） */
  attach(src, mod) {
    this.modules.set(src, mod);
    if (mod) {
      mod.undoBus = this;
      if (!mod.undoSrc) mod.undoSrc = src;
    }
    return this;
  }

  module(src) { return this.modules.get(src) || null; }

  _key(user) { return (user && typeof user === 'object') ? user.id : user; }

  _state(user, create = true) {
    const key = this._key(user);
    if (key === undefined || key === null) return null;
    let st = this.users.get(key);
    if (!st && create) {
      st = { key, frames: [], stickyId: null, groups: [], redos: [], seq: 0, lastAt: 0 };
      this.users.set(key, st);
    }
    return st || null;
  }

  /**
   * 新会话（断线重连）时调用：把**还开着**的分组正常收尾（合并成一步），不让它悬在那里。
   * 已收尾的分组（组合步骤）与两侧模块自己的撤销栈都不动 —— 与"重连后 OSM 撤销栈清空、
   * 交通撤销栈保留"这件事保持一致：分组的存在与否不改变两边各自的既有语义。
   */
  reset(user) {
    const st = this._state(user, false);
    if (!st) return;
    this._sweep(st);
    for (let i = st.frames.length - 1; i >= 0; i--) {
      const frame = st.frames[i];
      if (frame) this._closeFrame(st, frame);
    }
    st.stickyId = null;
  }

  /* ------------------------------ 记录与收尾 ------------------------------ */

  /**
   * 每个**成功**的操作都会经过这里（模块的 _pushUndo 调用）：
   * 发一个全局递增序号；如果正处在某个分组里，就把这一步登记进这一组。
   */
  tag(src, user, entry) {
    const st = this._state(user, true);
    if (!st || !entry) return entry;
    st.seq += 1;
    entry.seq = st.seq;
    entry.src = src;
    st.lastAt = Date.now();
    let frame = st.frames[st.frames.length - 1];
    // 一组最多 maxParts 条：超了就先把当前这组收尾（合并成一步），再开一组同名的接着记。
    // 客户端忘发 endGroup 也不会把内存/一步的规模撑爆（最多多按一次 Ctrl+Z）。
    if (frame && frame.parts.length >= this.options.maxParts) {
      const label = frame.label;
      const sticky = frame.sticky;
      this._closeFrame(st, frame);
      frame = this._openFrame(st, { label, sticky });
    }
    if (frame) {
      frame.parts.push({ src, entry });
      frame.touchedAt = Date.now();
    }
    st.redos.length = 0;   // 有新的动作：重做栈作废（与两个模块各自的行为一致）
    return entry;
  }

  /** 操作开始之前调用：处理 groupLabel 自动分组、以及过期分组收尾 */
  note(user, op) {
    const st = this._state(user, true);
    if (!st || !op || typeof op.k !== 'string') return;
    if (GROUP_OPS.has(op.k) || op.k === 'undo' || op.k === 'redo') return;
    this._sweep(st);
    const label = cleanGroupLabel(op.groupLabel);
    const frame = st.frames[st.frames.length - 1];
    if (!label) {
      if (frame && frame.sticky) this._closeFrame(st, frame);   // 一次"带标签的连续操作"到此为止
      return;
    }
    if (frame && frame.explicit) { frame.touchedAt = Date.now(); return; }   // 显式分组里的一切都归这一组
    if (frame && frame.sticky) {
      if (frame.label === label && frame.parts.length < this.options.maxParts) { frame.touchedAt = Date.now(); return; }
      this._closeFrame(st, frame);   // 换了标签（或者这一组已经够长）→ 上一组收尾
    }
    this._openFrame(st, { label, sticky: true });
  }

  /** 惰性收尾：太久没动静的分组自动合并（自动分组看 idleMs，显式分组看 ttlMs） */
  _sweep(st) {
    if (!st || !st.frames.length) return;
    const now = Date.now();
    for (let i = st.frames.length - 1; i >= 0; i--) {
      const frame = st.frames[i];
      if (!frame) continue;
      const limit = frame.sticky ? this.options.idleMs : this.options.ttlMs;
      if (now - frame.touchedAt <= limit) continue;
      this._closeFrame(st, frame);
    }
  }

  _openFrame(st, opts = {}) {
    if (st.frames.length >= this.options.maxDepth) {
      throw new GroupError(`分组最多嵌套 ${this.options.maxDepth} 层`, 'GROUP_DEPTH');
    }
    this.groupCounter += 1;
    const sticky = !!opts.sticky;
    const frame = {
      id: this.groupCounter, label: cleanGroupLabel(opts.label) || '分组操作',
      sticky, explicit: !sticky, parts: [], openedAt: Date.now(), touchedAt: Date.now(),
    };
    st.frames.push(frame);
    if (sticky) st.stickyId = frame.id;
    return frame;
  }

  /**
   * 收尾一个分组：把两个模块栈里属于它的撤销项摘出来，按时间顺序合并成"一步"。
   * 只有一条操作时不动两个模块的栈（就地改标签），保证单条操作的行为与以前完全一致。
   */
  _closeFrame(st, frame, opts = {}) {
    const idx = st.frames.indexOf(frame);
    if (idx >= 0) st.frames.splice(idx, 1);
    if (st.stickyId === frame.id) st.stickyId = null;
    const label = cleanGroupLabel(opts.label) || frame.label || '分组操作';
    const parts = frame.parts.slice();
    const info = this._info(st, frame, parts, { label, open: false, aborted: !!opts.abort });

    if (opts.abort || !parts.length) {
      frame.info = info;               // 放弃分组：两个模块的栈一个字都不动
      return info;
    }
    if (parts.length === 1) {
      parts[0].entry.label = label;    // 单条：就地换标签，栈里还是一条
      frame.info = info;
      return info;
    }

    const perSrc = new Map();
    for (const p of parts) {
      const list = perSrc.get(p.src);
      if (list) list.push(p.entry); else perSrc.set(p.src, [p.entry]);
    }
    for (const [src, entries] of perSrc) {
      const mod = this.module(src);
      if (mod && typeof mod.drainUndoEntries === 'function') mod.drainUndoEntries(st.key, entries);
    }
    const group = {
      id: frame.id, label, seq: st.seq, parts,
      steps: parts.reduce((n, p) => n + groupStepsOf(p.entry), 0),
      osm: parts.filter((p) => p.src === 'osm').length,
      transit: parts.filter((p) => p.src === 'transit').length,
      sticky: frame.sticky,
    };
    st.groups.push(group);
    while (st.groups.length > this.options.maxGroups) st.groups.shift();
    st.redos.length = 0;
    frame.info = info;
    return info;
  }

  /** ack / groupStatus 用的分组描述（客户端直接显示 display / undoLabel） */
  _info(st, frame, parts, extra = {}) {
    const steps = parts.reduce((n, p) => n + groupStepsOf(p.entry), 0);
    const label = extra.label || frame.label;
    const open = extra.open !== undefined ? extra.open : false;
    const display = `${label}（${steps} 步）`;
    const sources = [...new Set(parts.map((p) => p.src))];
    return {
      id: frame.id,
      label,
      display,
      open,
      closed: !open,
      aborted: !!extra.aborted,
      sticky: !!frame.sticky,
      explicit: !!frame.explicit,
      depth: st.frames.length,        // 还开着几层分组（开着的时候包含自己这一层）
      parts: parts.length,
      steps,
      osm: parts.filter((p) => p.src === 'osm').length,
      transit: parts.filter((p) => p.src === 'transit').length,
      sources,
      crossStack: sources.length > 1, // 这一组横跨了 OSM 编辑与交通玩法两边
      undoLabel: `撤销：${display}`,
      redoLabel: `重做：${display}`,
      merged: parts.length > 1 && !extra.aborted,
    };
  }

  /* ------------------------------ 分组类操作 ------------------------------ */

  /** beginGroup / endGroup / abortGroup / groupStatus（OSM 与交通两条通道共用） */
  op(user, op, extra = {}) {
    const st = this._state(user, true);
    if (!st) throw new GroupError('分组状态不可用');
    this._sweep(st);
    const top = () => st.frames[st.frames.length - 1] || null;
    switch (op.k) {
      case 'beginGroup': {
        const cur = top();
        if (cur && cur.sticky) this._closeFrame(st, cur);   // 上一个自动分组到此为止
        const frame = this._openFrame(st, { label: cleanGroupLabel(op.label) || '分组操作', sticky: false });
        const info = this._info(st, frame, frame.parts, { open: true });
        return { ops: [], label: `开始分组：${info.label}`, group: info, src: extra.src || null, depths: this.depths(user) };
      }
      case 'endGroup': {
        const cur = top();
        if (!cur) throw new GroupError('没有打开的分组（先发 beginGroup，或者给操作加 groupLabel）', 'GROUP_EMPTY');
        const info = this._closeFrame(st, cur, { label: op.label || op.groupLabel });
        return { ops: [], label: `结束分组：${info.display}`, group: info, src: extra.src || null, depths: this.depths(user) };
      }
      case 'abortGroup': {
        const cur = top();
        if (!cur) throw new GroupError('没有打开的分组', 'GROUP_EMPTY');
        const info = this._closeFrame(st, cur, { abort: true });
        return { ops: [], label: `放弃分组：${info.label}（${info.parts} 条操作各自保留一步）`, group: info, depths: this.depths(user) };
      }
      case 'groupStatus':
      default: {
        const info = this.frameInfo(user);
        return { ops: [], label: info ? `分组进行中：${info.display}` : '当前没有分组', group: info, depths: this.depths(user) };
      }
    }
  }

  /* ------------------------------ 深度 / 查询 ------------------------------ */

  /** 当前开着的分组（没有就是 null）：ack 里用它告诉客户端「撤销：生成示例线路（12 步）」 */
  frameInfo(user) {
    const st = this._state(user, true);
    if (!st) return null;
    const frame = st.frames[st.frames.length - 1];
    if (!frame) return null;
    return this._info(st, frame, frame.parts, { open: true });
  }

  /** 统一的深度：两个模块各自的栈 + 总线上的组合步骤 */
  depths(user) {
    const st = this._state(user, true);
    const out = { osm: 0, transit: 0, group: 0, total: 0, redo: { osm: 0, transit: 0, group: 0, total: 0 } };
    let total = 0;
    let redoTotal = 0;
    for (const [src, mod] of this.modules) {
      if (!mod) continue;
      if (typeof mod.undoDepth === 'function') { out[src] = mod.undoDepth(this._key(user)); total += out[src]; }
      if (typeof mod.redoDepth === 'function') { out.redo[src] = mod.redoDepth(this._key(user)); redoTotal += out.redo[src]; }
    }
    if (st) { out.group = st.groups.length; out.redo.group = st.redos.length; }
    out.total = total + out.group;
    out.redo.total = redoTotal + out.redo.group;
    return out;
  }

  /* ------------------------------ 撤销 / 重做 ------------------------------ */

  /**
   * 统一撤销入口（两个模块的 _undo 都会先问这里）：
   *   · 返回 null → "最近一步"就在调用方自己的栈顶，交给它按原有逻辑处理；
   *   · 返回结果 → 总线已经代跑（一个跨模块的分组，或者另一条通道上的最新一步）。
   */
  undo(user, ctx, src) {
    const st = this._state(user, true);
    if (!st) return null;
    this._sweep(st);
    const frame = st.frames[st.frames.length - 1];
    if (frame && frame.explicit) {
      throw new GroupError(`分组「${frame.label}」还没结束（${frame.parts.length} 条操作）：先 endGroup 或 abortGroup，再撤销`, 'GROUP_OPEN');
    }
    if (frame && frame.sticky) this._closeFrame(st, frame);   // 按下撤销 = "这一组到此为止"
    return this._route(user, ctx, src, 'undo');
  }

  redo(user, ctx, src) {
    const st = this._state(user, true);
    if (!st) return null;
    this._sweep(st);
    const frame = st.frames[st.frames.length - 1];
    if (frame && frame.explicit) {
      throw new GroupError(`分组「${frame.label}」还没结束（${frame.parts.length} 条操作）：先 endGroup 或 abortGroup，再重做`, 'GROUP_OPEN');
    }
    if (frame && frame.sticky) this._closeFrame(st, frame);
    return this._route(user, ctx, src, 'redo');
  }

  /** 谁在时间线最上面就先处理谁：分组 > 两边模块栈顶（按 seq 比大小） */
  _route(user, ctx, src, dir) {
    const st = this._state(user, false);
    if (!st) return null;
    const cand = [];
    const list = dir === 'undo' ? st.groups : st.redos;
    const g = list[list.length - 1];
    if (g) cand.push({ kind: 'group', seq: g.seq });
    for (const [name, mod] of this.modules) {
      if (!mod) continue;
      const fn = dir === 'undo' ? mod.topSeq : mod.topRedoSeq;
      if (typeof fn !== 'function') continue;
      const seq = fn.call(mod, this._key(user));
      if (Number.isFinite(seq) && seq >= 0) cand.push({ kind: name, seq });
    }
    if (!cand.length) return null;
    cand.sort((a, b) => b.seq - a.seq);
    const win = cand[0];
    if (win.kind === 'group') return dir === 'undo' ? this._undoGroup(user, ctx, st) : this._redoGroup(user, ctx, st);
    if (win.kind === src) return null;   // 调用方自己的栈顶：交给它按原有逻辑处理（标签/返回结构都不变）
    const other = this.module(win.kind);
    if (!other) return null;
    // 另一条通道上的动作更新：由总线代跑，保证两个栈在同一条时间线上
    const fn = dir === 'undo' ? other.undoViaBus : other.redoViaBus;
    return typeof fn === 'function' ? fn.call(other, user, ctx) : null;
  }

  /**
   * 撤销一整组：按时间**倒序**执行组里每一步。
   * 每一步的反向步骤都用"执行它之前的那一刻库状态"算出来 —— 那正是之后重做要执行的东西。
   */
  _undoGroup(user, ctx, st) {
    const group = st.groups.pop();
    const redoParts = [];
    const ops = [];
    this._bulkBegin();
    try {
      for (let i = group.parts.length - 1; i >= 0; i--) {
        const part = group.parts[i];
        const mod = this.module(part.src);
        if (!mod) continue;
        const useCtx = typeof mod.busContext === 'function' ? mod.busContext(user, ctx) : ctx;
        const steps = mod.invertEntrySteps(part.entry);
        const out = mod.applyEntrySteps(user, useCtx, part.entry, 'undo') || [];
        for (const op of out) ops.push(op);
        redoParts.unshift({ src: part.src, entry: { label: part.entry.label, seq: part.entry.seq, steps } });
      }
    } finally {
      this._bulkEnd();
    }
    st.redos.push({ label: group.label, seq: group.seq, steps: group.steps, parts: redoParts });
    while (st.redos.length > this.options.maxGroups) st.redos.shift();
    const depths = this.depths(user);
    const sources = [...new Set(group.parts.map((p) => p.src))];
    return {
      ops,
      label: `撤销：${group.label}（${group.steps} 步）`,
      group: {
        id: group.id, label: group.label, display: `${group.label}（${group.steps} 步）`,
        open: false, closed: true, merged: true, undone: true, steps: group.steps,
        parts: group.parts.length, osm: group.osm, transit: group.transit,
        sources, crossStack: sources.length > 1, depth: 0,
        undoLabel: `撤销：${group.label}（${group.steps} 步）`,
      },
      depths,
      undoDepth: depths.total,
      redoDepth: depths.redo.total,
    };
  }

  /** 重做一整组：按时间**正序**把每一步放回去，并把"撤销这一组"重新装好 */
  _redoGroup(user, ctx, st) {
    const group = st.redos.pop();
    const undoParts = [];
    const ops = [];
    this._bulkBegin();
    try {
      for (let i = 0; i < group.parts.length; i++) {
        const part = group.parts[i];
        const mod = this.module(part.src);
        if (!mod) continue;
        const useCtx = typeof mod.busContext === 'function' ? mod.busContext(user, ctx) : ctx;
        const steps = mod.invertEntrySteps(part.entry);
        const out = mod.applyEntrySteps(user, useCtx, part.entry, 'redo') || [];
        for (const op of out) ops.push(op);
        undoParts.push({ src: part.src, entry: { label: part.entry.label, seq: part.entry.seq, steps } });
      }
    } finally {
      this._bulkEnd();
    }
    st.groups.push({
      id: group.id, label: group.label, seq: group.seq, steps: group.steps, parts: undoParts,
      osm: undoParts.filter((p) => p.src === 'osm').length,
      transit: undoParts.filter((p) => p.src === 'transit').length,
    });
    const depths = this.depths(user);
    const sources = [...new Set(group.parts.map((p) => p.src))];
    return {
      ops,
      label: `重做：${group.label}（${group.steps} 步）`,
      group: {
        id: group.id, label: group.label, display: `${group.label}（${group.steps} 步）`,
        open: false, closed: true, merged: true, redone: true, steps: group.steps,
        parts: group.parts.length, osm: group.osm, transit: group.transit,
        sources, crossStack: sources.length > 1, depth: 0,
        redoLabel: `重做：${group.label}（${group.steps} 步）`,
      },
      depths,
      undoDepth: depths.total,
      redoDepth: depths.redo.total,
    };
  }

  /** 组合步可能一次要跑几十个模块步骤（例如一次撤销 12 步的示例数据）：让模块攒到最后只重建一次 */
  _bulkBegin() { for (const [, mod] of this.modules) if (mod && typeof mod.beginBulk === 'function') mod.beginBulk(); }
  _bulkEnd() { for (const [, mod] of this.modules) if (mod && typeof mod.endBulk === 'function') mod.endBulk(); }
}

function validCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** 标签清洗与校验：返回规范化后的对象，非法直接抛错 */
function sanitizeTags(tags, prefix = '') {
  if (tags === undefined || tags === null) return undefined;
  if (typeof tags !== 'object' || Array.isArray(tags)) throw new OpError(prefix + '标签格式不正确');
  const out = {};
  const entries = Object.entries(tags);
  if (entries.length > LIMITS.maxTags) throw new OpError(`${prefix}标签数量过多（最多 ${LIMITS.maxTags} 个）`);
  for (const [rawKey, rawVal] of entries) {
    const key = String(rawKey).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!key) continue;
    if (key.length > LIMITS.maxTagKeyLength) throw new OpError(prefix + `标签名过长：${key.slice(0, 20)}…`);
    if (key.includes('=')) throw new OpError(prefix + `标签名不能包含等号：${key}`);
    if (rawVal === null || rawVal === undefined) continue;
    const value = String(rawVal).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!value) continue;
    if (value.length > LIMITS.maxTagValueLength) throw new OpError(prefix + `标签值过长：${key}`);
    out[key] = value;
  }
  return out;
}

class OsmOps {
  constructor(db, options = {}) {
    this.db = db;
    this.options = Object.assign({ maxCreateNodes: 5000 }, options);
    this.locks = new Map();          // "way:123" -> { userId, name, ts }
    this.undoStacks = new Map();     // userId -> [entry]
    this.redoStacks = new Map();
    this.sessionChangesets = new Map();
    // 分组撤销：默认自带一条总线（单元测试里直接 new OsmOps 也能用分组）；
    // index.js 会传一条与 Transit 共用的总线进来（选项名 undoBus），于是分组可以横跨两边。
    // 传进来的总线一定在这里 attach 一次：分组收尾时要靠总线找到"另一个模块"去摘撤销项。
    // （同一条总线上每个 src 只能挂一个模块，测试里造多个世界时请各自用一条总线。）
    this.undoSrc = options.src || 'osm';
    this.undoBus = options.undoBus || new UndoBus();
    this.undoBus.attach(this.undoSrc, this);
    this._groupSuspend = 0;          // >0 时（批量操作的子操作）不往分组里登记
  }

  /* ------------------------------- 元素锁 ------------------------------- */
  _lockKey(type, id) { return type + ':' + id; }

  lock(type, id, user, on = true) {
    const key = this._lockKey(type, id);
    const cur = this.locks.get(key);
    if (!on) {
      if (cur && cur.userId === user.id) this.locks.delete(key);
      return { locked: false };
    }
    if (cur && cur.userId !== user.id && Date.now() - cur.ts < LOCK_TTL_MS) {
      return { locked: true, by: cur.name };
    }
    this.locks.set(key, { userId: user.id, name: user.name, ts: Date.now() });
    return { locked: false };
  }

  checkLock(type, id, user) {
    const cur = this.locks.get(this._lockKey(type, id));
    if (cur && cur.userId !== user.id && Date.now() - cur.ts < LOCK_TTL_MS) {
      throw new OpError(`${cur.name} 正在编辑这个元素，请稍后再试`, 'LOCKED');
    }
  }

  refreshLocks(userId) {
    for (const [, v] of this.locks) if (v.userId === userId) v.ts = Date.now();
  }

  releaseLocks(userId) {
    for (const [key, v] of [...this.locks]) if (v.userId === userId) this.locks.delete(key);
  }

  locksSnapshot() {
    const out = {};
    const now = Date.now();
    for (const [key, v] of this.locks) {
      if (now - v.ts > LOCK_TTL_MS) { this.locks.delete(key); continue; }
      out[key] = { name: v.name, userId: v.userId };
    }
    return out;
  }

  /* ------------------------------ 撤销栈 ------------------------------ */
  _pushUndo(userId, entry) {
    const stack = this.undoStacks.get(userId) || [];
    stack.push(this._tagEntry(userId, entry));
    while (stack.length > MAX_UNDO) stack.shift();
    this.undoStacks.set(userId, stack);
    this.redoStacks.set(userId, []);
  }

  /** 交给分组总线登记：拿到全局 seq，正处在分组里就登记进这一组（批量操作的子操作不登记） */
  _tagEntry(userId, entry) {
    if (!this.undoBus || this._groupSuspend) return entry;
    return this.undoBus.tag(this.undoSrc, userId, entry);
  }

  undoDepth(userId) { return (this.undoStacks.get(userId) || []).length; }
  redoDepth(userId) { return (this.redoStacks.get(userId) || []).length; }

  /* ------------- 与分组总线对接（UndoBus 通过这几个入口代跑本模块的步骤） ------------- */
  topSeq(userId) {
    const stack = this.undoStacks.get(userId) || [];
    const entry = stack[stack.length - 1];
    return entry && Number.isFinite(entry.seq) ? entry.seq : -1;
  }

  topRedoSeq(userId) {
    const stack = this.redoStacks.get(userId) || [];
    const entry = stack[stack.length - 1];
    return entry && Number.isFinite(entry.seq) ? entry.seq : -1;
  }

  /** 把指定撤销项从栈里摘出来（分组收尾时），顺序与相对位置都不变 */
  drainUndoEntries(userId, entries) {
    const stack = this.undoStacks.get(userId) || [];
    const drop = new Set(entries);
    const kept = stack.filter((e) => !drop.has(e));
    this.undoStacks.set(userId, kept);
    return stack.length - kept.length;
  }

  invertEntrySteps(entry) { return this._invertSteps(entry.steps); }
  applyEntrySteps(user, ctx, entry, reason) { return this._applySteps(entry.steps, user, ctx, reason); }

  /** 分组总线在另一条通道里代跑 OSM 撤销时，需要自己补一个变更集 */
  busContext(user, ctx) {
    const out = ctx ? Object.assign({}, ctx) : {};
    if (!out.changesetId) out.changesetId = this._changesetFor(user, out.comment);
    return out;
  }

  undoViaBus(user, ctx) { return this._undo(user, null, ctx, true); }
  redoViaBus(user, ctx) { return this._redo(user, null, ctx, true); }

  /* ------------------------------ 快照步骤 ------------------------------ */
  _snapshotSteps(type, id) {
    const snap = this.db.snapshot(type, id);
    return snap ? [{ op: 'restore', type, snapshot: snap }] : [];
  }

  /** 把一组步骤取反（用当前数据库状态生成反向步骤） */
  _invertSteps(steps) {
    const out = [];
    for (const step of steps) {
      if (step.op === 'restore') {
        const cur = this.db.snapshot(step.type, step.snapshot.id);
        out.push(cur ? { op: 'restore', type: step.type, snapshot: cur } : { op: 'delete', type: step.type, id: step.snapshot.id });
      } else if (step.op === 'delete') {
        const cur = this.db.snapshot(step.type, step.id);
        if (cur) out.push({ op: 'restore', type: step.type, snapshot: cur });
      }
    }
    return out;
  }

  /** 执行一组"快照步骤"，返回广播操作数组 */
  _applySteps(steps, user, ctx, reason) {
    const ops = [];
    for (const step of steps) {
      if (step.op === 'restore') {
        const type = step.type;
        const before = this.db.snapshot(type, step.snapshot.id);
        const el = type === 'node' ? this.db.restoreNode(step.snapshot, user)
          : type === 'way' ? this.db.restoreWay(step.snapshot, user)
            : this.db.restoreRelation(step.snapshot, user);
        this.db.logChange(ctx.changesetId, type, el.id, before ? 'modify' : 'create', before, this.db.snapshot(type, el.id), user);
        ops.push(this._broadcastFor(type, el, before ? 'update' : 'create'));
      } else if (step.op === 'delete') {
        const before = this.db.snapshot(step.type, step.id);
        if (!before) continue;
        this.db.hardDelete(step.type, step.id, user);
        this.db.logChange(ctx.changesetId, step.type, step.id, 'delete', before, null, user);
        ops.push({ k: step.type + 'Delete', id: step.id, reason: reason || 'undo' });
      }
    }
    return ops;
  }

  _broadcastFor(type, el, action) {
    if (type === 'node') {
      return { k: action === 'create' ? 'nodeCreate' : 'nodeUpdate', node: { id: el.id, lat: el.lat, lon: el.lon, version: el.version, tags: el.tags || null } };
    }
    if (type === 'way') {
      const nodes = {};
      for (const nid of el.nodes) {
        const n = this.db.getNode(nid);
        if (n) nodes[nid] = [n.lat, n.lon];
      }
      return {
        k: action === 'create' ? 'wayCreate' : 'wayUpdate',
        way: { id: el.id, version: el.version, tags: el.tags || null, nodes: el.nodes, closed: !!el.closed, length: el.length || 0 },
        nodes,
      };
    }
    return {
      k: action === 'create' ? 'relationCreate' : 'relationUpdate',
      relation: { id: el.id, version: el.version, tags: el.tags || null, members: el.members },
    };
  }

  _wayBroadcast(way) { return this._broadcastFor('way', this.db.getWay(way.id), way.isNew ? 'create' : 'update'); }

  /* ------------------------------ 主入口 ------------------------------ */
  apply(user, op, ctx = {}) {
    if (!op || typeof op !== 'object' || typeof op.k !== 'string') throw new OpError('操作格式不正确');
    if (!ctx.changesetId) ctx.changesetId = this._changesetFor(user, ctx.comment);
    // 分组（beginGroup / endGroup / groupLabel）统一交给总线：它管着"谁在时间线最上面"
    if (this.undoBus && !this._groupSuspend) this.undoBus.note(user, op);

    switch (op.k) {
      case 'createNode': return this._createNode(user, op, ctx);
      case 'updateNode': return this._updateNode(user, op, ctx);
      case 'deleteNode': return this._deleteNode(user, op, ctx);
      case 'createWay': return this._createWay(user, op, ctx);
      case 'updateWay': return this._updateWay(user, op, ctx);
      case 'deleteWay': return this._deleteWay(user, op, ctx);
      case 'splitWay': return this._splitWay(user, op, ctx);
      case 'mergeWays': return this._mergeWays(user, op, ctx);
      case 'joinNodes': return this._joinNodes(user, op, ctx);
      case 'reverseWay': return this._reverseWay(user, op, ctx);
      case 'createRelation': return this._createRelation(user, op, ctx);
      case 'updateRelation': return this._updateRelation(user, op, ctx);
      case 'deleteRelation': return this._deleteRelation(user, op, ctx);
      case 'undo': return this._undo(user, op, ctx);
      case 'redo': return this._redo(user, op, ctx);
      case 'batch': return this._batch(user, op, ctx);
      case 'revertChangeset': return this._revertChangeset(user, op, ctx);
      // 分组撤销：两条通道（这里的 op、transit.js 的 transit）共用同一条时间线
      case 'beginGroup':
      case 'endGroup':
      case 'abortGroup':
      case 'groupStatus':
        return this.undoBus.op(user, op, { src: this.undoSrc });
      default: throw new OpError('未知操作：' + op.k);
    }
  }

  /** 批量操作：一次网络往返完成多步编辑，撤销时算作一步（拖动整条路、整体移动多个节点等） */
  _batch(user, op, ctx) {
    if (!Array.isArray(op.ops) || !op.ops.length) throw new OpError('批量操作内容为空');
    if (op.ops.length > 300) throw new OpError('一次最多批量执行 300 步操作');
    const stack = this.undoStacks.get(user.id) || [];
    const depth = stack.length;
    const allOps = [];
    this._groupSuspend += 1;   // 子操作不单独登记进分组：整批只算一步
    try {
      for (let i = 0; i < op.ops.length; i++) {
        const sub = op.ops[i];
        if (!sub || typeof sub.k !== 'string') throw new OpError('批量操作里有非法子操作');
        if (sub.k === 'batch' || sub.k === 'undo' || sub.k === 'redo' || sub.k === 'revertChangeset'
          || GROUP_OPS.has(sub.k)) {
          throw new OpError('批量操作里不能嵌套撤销/回滚/分组');
        }
        /**
         * 批量操作**不是事务**：逐条 apply，前面的已经真的写进库了。
         * 所以冲突回执里必须带上"是第几条出错"（`conflict.index`）——
         * 客户端自愈时只重放 `ops.slice(index)`，不会把已经生效的那几步再做一遍
         * （见 editor.js 的 _rebaseOp 与「版本冲突自愈」一节）。
         */
        let res;
        try {
          res = this.apply(user, sub, ctx);
        } catch (err) {
          if (err && err.conflict) {
            err.conflict.index = i;
            /**
             * 下标之前的子操作**已经真的写进库了**，但整批失败时一条广播都不会发出去
             * （index.js 只在整批成功后才 broadcast 那次 ack 的 ops）。
             * 把"已经生效的那几条"一起回执给作者端，客户端就能先把本地画面同步成真实状态，
             * 再从第 i 条接着重放（见 editor.js 的 _recoverConflict / _rebaseOp）。
             */
            if (allOps.length) err.conflict.appliedOps = allOps;
          }
          throw err;
        }
        allOps.push(...res.ops);
      }
    } finally {
      this._groupSuspend -= 1;
    }
    const after = this.undoStacks.get(user.id) || [];
    if (after.length > depth) {
      const merged = after.splice(depth, after.length - depth);
      const steps = [];
      for (const e of merged) steps.push(...e.steps);
      // 重新入栈"合并后的一步"（照常交给总线登记，所以批量操作也能作为分组里的一步）
      this._pushUndo(user.id, { label: op.label || '批量编辑', steps: this._dedupeSteps(steps) });
    }
    this.redoStacks.set(user.id, []);
    return { ops: allOps, label: op.label || '批量编辑' };
  }

  _changesetFor(user, comment) {
    let id = this.sessionChangesets.get(user.id);
    if (!id) {
      id = this.db.beginChangeset(user, comment || '在 OSM 城市在线编辑');
      this.sessionChangesets.set(user.id, id);
    }
    return id;
  }

  newSession(user, comment) {
    const id = this.db.beginChangeset(user, comment || '在 OSM 城市在线编辑');
    this.sessionChangesets.set(user.id, id);
    this.undoStacks.set(user.id, []);
    this.redoStacks.set(user.id, []);
    if (this.undoBus) this.undoBus.reset(user.id);   // 分组状态跟着撤销栈一起清掉
    return id;
  }

  /* -------------------------------- 节点 -------------------------------- */
  _createNode(user, op, ctx) {
    if (!validCoord(op.lat, op.lon)) throw new OpError('坐标不合法');
    const tags = sanitizeTags(op.tags) || null;
    const node = this.db.insertNode({ lat: op.lat, lon: op.lon, tags }, user);
    this.db.logChange(ctx.changesetId, 'node', node.id, 'create', null, this.db.snapshot('node', node.id), user);
    this._pushUndo(user.id, { label: '新建节点', steps: [{ op: 'delete', type: 'node', id: node.id }] });
    return { ops: [this._broadcastFor('node', node, 'create')], label: '新建节点' };
  }

  _updateNode(user, op, ctx) {
    const cur = this.db.getNode(op.id);
    if (!cur || cur.deleted) throw new OpError('节点不存在');
    if (op.version !== undefined && Number(op.version) !== cur.version) {
      throw new OpError(`节点 #${op.id} 已被 ${cur.editorName || '其他人'} 修改（版本 ${cur.version}），请重新加载后再改`, 'CONFLICT', conflictInfo('node', op.id, cur, op));
    }
    this.checkLock('node', op.id, user);
    const before = this.db.snapshot('node', op.id);
    const lat = op.lat === undefined ? cur.lat : Number(op.lat);
    const lon = op.lon === undefined ? cur.lon : Number(op.lon);
    if (!validCoord(lat, lon)) throw new OpError('坐标不合法');
    const tags = op.tags === undefined ? cur.tags : (sanitizeTags(op.tags) || null);
    const node = this.db.updateNode(op.id, { lat, lon, tags, version: cur.version + 1 }, user);
    this.db.logChange(ctx.changesetId, 'node', op.id, 'modify', before, this.db.snapshot('node', op.id), user);
    this._pushUndo(user.id, { label: '修改节点', steps: [{ op: 'restore', type: 'node', snapshot: before }] });
    return { ops: [this._broadcastFor('node', node, 'update')], label: '修改节点' };
  }

  _deleteNode(user, op, ctx) {
    const cur = this.db.getNode(op.id);
    if (!cur || cur.deleted) throw new OpError('节点不存在');
    if (op.version !== undefined && Number(op.version) !== cur.version) {
      throw new OpError(`节点 #${op.id} 已被 ${cur.editorName || '其他人'} 修改（版本 ${cur.version}）`, 'CONFLICT', conflictInfo('node', op.id, cur, op));
    }
    /**
     * 元素锁是**唯一**的拦截手段（谁能改谁不能改不看归属，只看锁）：
     * 所以删除也必须查锁，否则"对方正在编辑这个节点"时照样能被删掉，
     * 对方画到一半的几何就被抽走了。_updateNode / 各 way、relation 操作都查，
     * 这里漏了会导致锁形同虚设。
     */
    this.checkLock('node', op.id, user);
    const topo = this.db.nodeTopology(op.id);
    /**
     * cascade 会顺带 hardDelete 引用它的道路与关系（见下面两段循环），
     * 那同样是"删别人的东西"，所以级联到的每一个元素也要各自查锁：
     * 有一条被锁就整条 op 失败（宁可不删，也不要抽掉别人正在编的路）。
     */
    if (op.cascade) {
      for (const wid of topo.ways) this.checkLock('way', wid, user);
      for (const rid of topo.relations) this.checkLock('relation', rid, user);
    }
    if ((topo.ways.length || topo.relations.length) && !op.cascade) {
      throw new OpError(`该节点被 ${topo.ways.length} 条道路和 ${topo.relations.length} 个关系引用，请先删除它们，或使用级联删除`, 'IN_USE');
    }
    const steps = this._snapshotSteps('node', op.id);
    const ops = [];
    if (op.cascade) {
      for (const wid of topo.ways) {
        steps.push(...this._snapshotSteps('way', wid));
        steps.push(...this._wayNodeSnapshots(wid));
      }
      for (const rid of topo.relations) steps.push(...this._snapshotSteps('relation', rid));
    }
    const inverse = this._dedupeSteps(steps);

    // 先删引用它的道路/关系，再删节点
    for (const wid of topo.ways) {
      const w = this.db.snapshot('way', wid);
      if (!w) continue;
      this.db.hardDelete('way', wid, user);
      this.db.logChange(ctx.changesetId, 'way', wid, 'delete', w, null, user);
      const orphans = this.db.orphanNodes(w.nodes);
      for (const nid of orphans) {
        const snap = this.db.snapshot('node', nid);
        if (snap) {
          this.db.hardDelete('node', nid, user);
          this.db.logChange(ctx.changesetId, 'node', nid, 'delete', snap, null, user);
          ops.push({ k: 'nodeDelete', id: nid });
        }
      }
      ops.push({ k: 'wayDelete', id: wid });
    }
    for (const rid of topo.relations) {
      const r = this.db.snapshot('relation', rid);
      if (!r) continue;
      this.db.hardDelete('relation', rid, user);
      this.db.logChange(ctx.changesetId, 'relation', rid, 'delete', r, null, user);
      ops.push({ k: 'relationDelete', id: rid });
    }
    const before = this.db.snapshot('node', op.id);
    this.db.hardDelete('node', op.id, user);
    this.db.logChange(ctx.changesetId, 'node', op.id, 'delete', before, null, user);
    ops.push({ k: 'nodeDelete', id: op.id });

    this._pushUndo(user.id, { label: '删除节点', steps: inverse });
    return { ops, label: '删除节点' };
  }

  _dedupeSteps(steps) {
    const seen = new Set();
    const out = [];
    for (const s of steps) {
      const key = s.op + ':' + s.type + ':' + (s.snapshot ? s.snapshot.id : s.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }

  _wayNodeSnapshots(wayId) {
    const way = this.db.getWay(wayId);
    if (!way) return [];
    const out = [];
    for (const nid of way.nodes) {
      const snap = this.db.snapshot('node', nid);
      if (snap) out.push({ op: 'restore', type: 'node', snapshot: snap });
    }
    return out;
  }

  /* -------------------------------- 道路 -------------------------------- */
  _resolveWayGeometry(user, op, ctx, ops) {
    // 支持两种输入：nodes=[已有节点 id]，或 points=[{id?, lat, lon}]（没有 id 就新建节点）
    if (Array.isArray(op.points)) {
      if (op.points.length < 2) throw new OpError('一条道路至少需要 2 个点');
      if (op.points.length > LIMITS.maxWayNodes) throw new OpError(`一条道路最多 ${LIMITS.maxWayNodes} 个点`);
      let created = 0;
      const ids = [];
      let firstNode = null;
      for (let i = 0; i < op.points.length; i++) {
        const p = op.points[i];
        if (p && p.id) {
          const n = this.db.getNode(Number(p.id));
          if (!n || n.deleted) throw new OpError('引用的节点不存在：' + p.id);
          ids.push(n.id);
          if (i === 0) firstNode = n;
          continue;
        }
        if (!validCoord(Number(p.lat), Number(p.lon))) throw new OpError('坐标不合法');
        // 闭合区域的收尾点：直接复用第一个节点，避免在同一位置建两个节点
        if (firstNode && i === op.points.length - 1 && metersBetween(firstNode.lat, firstNode.lon, Number(p.lat), Number(p.lon)) < 0.5) {
          ids.push(firstNode.id);
          continue;
        }
        if (created >= this.options.maxCreateNodes) throw new OpError('一次新建的节点过多');
        const node = this.db.insertNode({ lat: Number(p.lat), lon: Number(p.lon), tags: sanitizeTags(p.tags) || null }, user);
        this.db.logChange(ctx.changesetId, 'node', node.id, 'create', null, this.db.snapshot('node', node.id), user);
        ops.push(this._broadcastFor('node', node, 'create'));
        created += 1;
        if (!firstNode) firstNode = node;
        ids.push(node.id);
      }
      return { ids, created };
    }
    if (Array.isArray(op.nodes)) {
      if (op.nodes.length < 2) throw new OpError('一条道路至少需要 2 个节点');
      if (op.nodes.length > LIMITS.maxWayNodes) throw new OpError(`一条道路最多 ${LIMITS.maxWayNodes} 个节点`);
      const ids = op.nodes.map((n) => Number(n));
      for (const id of ids) {
        const n = this.db.getNode(id);
        if (!n || n.deleted) throw new OpError('引用的节点不存在：' + id);
      }
      return { ids, created: 0 };
    }
    return null;
  }

  _createWay(user, op, ctx) {
    const ops = [];
    const geom = this._resolveWayGeometry(user, op, ctx, ops);
    if (!geom) throw new OpError('缺少道路几何（nodes 或 points）');
    const tags = sanitizeTags(op.tags) || null;
    const way = this.db.insertWay({ nodes: geom.ids, tags }, user);
    this.db.logChange(ctx.changesetId, 'way', way.id, 'create', null, this.db.snapshot('way', way.id), user);
    ops.push(this._broadcastFor('way', way, 'create'));

    // 撤销：删掉新建的道路，并清理这次一并新建的孤立节点
    const steps = [{ op: 'delete', type: 'way', id: way.id }];
    this._pushUndo(user.id, { label: '绘制道路', steps });
    return { ops, label: '绘制道路', created: { way: way.id, nodes: geom.created } };
  }

  _updateWay(user, op, ctx) {
    const cur = this.db.getWay(op.id);
    if (!cur || cur.deleted) throw new OpError('道路不存在');
    if (op.version !== undefined && Number(op.version) !== cur.version) {
      throw new OpError(`道路 #${op.id} 已被 ${cur.editorName || '其他人'} 修改（版本 ${cur.version}），请重新加载后再改`, 'CONFLICT', conflictInfo('way', op.id, cur, op));
    }
    this.checkLock('way', op.id, user);
    const before = this.db.snapshot('way', op.id);
    const ops = [];
    let nodes = cur.nodes;
    if (op.points || op.nodes) {
      const geom = this._resolveWayGeometry(user, op, ctx, ops);
      if (geom) nodes = geom.ids;
    }
    const tags = op.tags === undefined ? cur.tags : (sanitizeTags(op.tags) || null);
    const way = this.db.updateWayTags(op.id, { version: cur.version + 1, tags, nodes: (op.points || op.nodes) ? nodes : null }, user);
    this.db.logChange(ctx.changesetId, 'way', op.id, 'modify', before, this.db.snapshot('way', op.id), user);
    ops.push(this._broadcastFor('way', way, 'update'));
    this._pushUndo(user.id, { label: '修改道路', steps: [{ op: 'restore', type: 'way', snapshot: before }] });
    return { ops, label: '修改道路' };
  }

  _deleteWay(user, op, ctx) {
    const cur = this.db.getWay(op.id);
    if (!cur || cur.deleted) throw new OpError('道路不存在');
    if (op.version !== undefined && Number(op.version) !== cur.version) {
      throw new OpError(`道路 #${op.id} 已被 ${cur.editorName || '其他人'} 修改（版本 ${cur.version}）`, 'CONFLICT', conflictInfo('way', op.id, cur, op));
    }
    this.checkLock('way', op.id, user);
    const inverse = this._dedupeSteps([...this._snapshotSteps('way', op.id), ...this._wayNodeSnapshots(op.id)]);
    const before = this.db.snapshot('way', op.id);
    const ops = [];
    this.db.hardDelete('way', op.id, user);
    this.db.logChange(ctx.changesetId, 'way', op.id, 'delete', before, null, user);
    ops.push({ k: 'wayDelete', id: op.id });
    for (const nid of this.db.orphanNodes(cur.nodes)) {
      const snap = this.db.snapshot('node', nid);
      this.db.hardDelete('node', nid, user);
      this.db.logChange(ctx.changesetId, 'node', nid, 'delete', snap, null, user);
      ops.push({ k: 'nodeDelete', id: nid });
    }
    this._pushUndo(user.id, { label: '删除道路', steps: inverse });
    return { ops, label: '删除道路' };
  }

  _splitWay(user, op, ctx) {
    const cur = this.db.getWay(op.id);
    if (!cur || cur.deleted) throw new OpError('道路不存在');
    if (op.version !== undefined && Number(op.version) !== cur.version) {
      throw new OpError(`道路 #${op.id} 已被 ${cur.editorName || '其他人'} 修改（版本 ${cur.version}）`, 'CONFLICT', conflictInfo('way', op.id, cur, op));
    }
    this.checkLock('way', op.id, user);
    const idx = cur.nodes.indexOf(Number(op.nodeId));
    if (idx <= 0 || idx >= cur.nodes.length - 1) throw new OpError('只能在道路中间的节点处分割');

    const beforeA = this.db.snapshot('way', op.id);
    const partA = cur.nodes.slice(0, idx + 1);
    const partB = cur.nodes.slice(idx);
    const tags = sanitizeTags(op.tags) || cur.tags;
    const ops = [];

    const wayA = this.db.updateWayTags(op.id, { version: cur.version + 1, tags, nodes: partA }, user);
    this.db.logChange(ctx.changesetId, 'way', op.id, 'modify', beforeA, this.db.snapshot('way', op.id), user);
    ops.push(this._broadcastFor('way', wayA, 'update'));

    const wayB = this.db.insertWay({ nodes: partB, tags }, user);
    this.db.logChange(ctx.changesetId, 'way', wayB.id, 'create', null, this.db.snapshot('way', wayB.id), user);
    ops.push(this._broadcastFor('way', wayB, 'create'));

    this._pushUndo(user.id, {
      label: '分割道路',
      steps: [{ op: 'delete', type: 'way', id: wayB.id }, { op: 'restore', type: 'way', snapshot: beforeA }],
    });
    return { ops, label: '分割道路', created: { way: wayB.id } };
  }

  /**
   * 合并两条道路。
   * 优先复用共享端点；没有共享端点时自动找出**最近的**一对端点接上：
   *   - 距离 ≤ snapMeters（默认 25 米）→ 把两个端点节点合并成一个（位置取中点），拓扑真正连通
   *   - 距离更大 → 直接拼接，两点之间由一段直线连接（返回 bridged 距离告知调用方）
   */
  _mergeWays(user, op, ctx) {
    const ids = (op.ids || []).map(Number);
    if (ids.length !== 2 || ids[0] === ids[1]) throw new OpError('需要选择两条相连的道路');
    const a = this.db.getWay(ids[0]);
    const b = this.db.getWay(ids[1]);
    if (!a || a.deleted || !b || b.deleted) throw new OpError('道路不存在');
    if (op.version !== undefined && op.versionOf) {
      const target = Number(op.versionOf) === b.id ? b : a;
      if (Number(op.version) !== target.version) throw new OpError('道路已被他人修改，请重新加载', 'CONFLICT', conflictInfo('way', target.id, target, op));
    }
    this.checkLock('way', a.id, user);
    this.checkLock('way', b.id, user);
    if (a.nodes.length < 2 || b.nodes.length < 2) throw new OpError('道路没有足够的节点');

    // 四个端点组合里挑最近的一对
    const endsA = [{ node: a.nodes[0], end: 'start' }, { node: a.nodes[a.nodes.length - 1], end: 'end' }];
    const endsB = [{ node: b.nodes[0], end: 'start' }, { node: b.nodes[b.nodes.length - 1], end: 'end' }];
    let best = null;
    for (const ea of endsA) {
      for (const eb of endsB) {
        const na = this.db.getNode(ea.node);
        const nb = this.db.getNode(eb.node);
        if (!na || !nb) continue;
        const d = na.id === nb.id ? 0 : metersBetween(na.lat, na.lon, nb.lat, nb.lon);
        if (!best || d < best.dist) best = { ea, eb, dist: d, na, nb };
      }
    }
    if (!best) throw new OpError('找不到可连接的端点');

    const snapMeters = Number.isFinite(Number(op.snapMeters)) ? Number(op.snapMeters) : 25;
    const beforeA = this.db.snapshot('way', a.id);
    const beforeB = this.db.snapshot('way', b.id);
    const steps = [
      { op: 'restore', type: 'way', snapshot: beforeA },
      { op: 'restore', type: 'way', snapshot: beforeB },
    ];
    const ops = [];
    let mergedNodeId = best.na.id;
    let bridged = 0;

    if (best.na.id === best.nb.id) {
      mergedNodeId = best.na.id; // 本来就共用一个端点
    } else if (best.dist <= snapMeters) {
      // 把两个端点节点合并成一个：位置取中点，所有引用同步重指向
      const victim = best.nb.id;      // 被合并掉的节点
      const keeper = best.na.id;      // 保留下来的节点
      const midLat = (best.na.lat + best.nb.lat) / 2;
      const midLon = (best.na.lon + best.nb.lon) / 2;
      const affected = new Set();
      for (const w of this.db.nodeTopology(keeper).ways) affected.add(w);
      for (const w of this.db.nodeTopology(victim).ways) affected.add(w);
      for (const wid of affected) {
        const snap = this.db.snapshot('way', wid);
        if (snap) steps.push({ op: 'restore', type: 'way', snapshot: snap });
      }
      const keeperSnap = this.db.snapshot('node', keeper);
      const victimSnap = this.db.snapshot('node', victim);
      if (keeperSnap) steps.push({ op: 'restore', type: 'node', snapshot: keeperSnap });
      if (victimSnap) steps.push({ op: 'restore', type: 'node', snapshot: victimSnap });

      // 移动 keeper 到中点，并把其它道路里对 victim 的引用改成 keeper（去掉重复相邻节点）
      this.db.updateNode(keeper, { lat: midLat, lon: midLon, tags: keeperSnap ? keeperSnap.tags : null, version: (keeperSnap ? keeperSnap.version : 1) + 1 }, user);
      for (const wid of affected) {
        const w = this.db.getWay(wid);
        if (!w) continue;
        const beforeW = this.db.snapshot('way', wid);
        const next = [];
        for (const nid of w.nodes) {
          const mapped = nid === victim ? keeper : nid;
          if (next.length && next[next.length - 1] === mapped) continue;
          next.push(mapped);
        }
        const finalNodes = next.length >= 2 ? next : w.nodes;
        this.db.updateWayTags(wid, { version: w.version + 1, tags: w.tags, nodes: finalNodes }, user);
        this.db.logChange(ctx.changesetId, 'way', wid, 'modify', beforeW, this.db.snapshot('way', wid), user);
      }
      this.db.hardDelete('node', victim, user);
      this.db.logChange(ctx.changesetId, 'node', victim, 'delete', victimSnap, null, user);
      ops.push({ k: 'nodeDelete', id: victim });
      mergedNodeId = keeper;
      // 让客户端刷新受影响道路的几何
      for (const wid of affected) {
        const w = this.db.getWay(wid);
        if (w) ops.push(this._broadcastFor('way', w, 'update'));
      }
    } else {
      bridged = Math.round(best.dist * 10) / 10;
      ops.push({ k: 'note', kind: 'bridge', distance: bridged });
    }

    // 拼接：把 A 的方向调整为"从 A 的选定端点到另一端"，B 同理
    const orient = (way, end) => (end === 'end' ? way.nodes.slice() : way.nodes.slice().reverse());
    const partA = orient(this.db.getWay(a.id) || a, best.ea.end);
    const partB = orient(this.db.getWay(b.id) || b, best.eb.end === 'start' ? 'end' : 'start');
    // 此时 partA 末尾与 partB 开头是要接上的两个端点
    const merged = partA.concat(partB[0] === partA[partA.length - 1] ? partB.slice(1) : partB);
    if (merged.length > LIMITS.maxWayNodes) throw new OpError('合并后节点数超出上限');

    const tags = sanitizeTags(op.tags) || a.tags || b.tags;
    const mergedWay = this.db.updateWayTags(a.id, { version: (this.db.getWay(a.id) || a).version + 1, tags, nodes: merged }, user);
    this.db.logChange(ctx.changesetId, 'way', a.id, 'modify', beforeA, this.db.snapshot('way', a.id), user);
    this.db.hardDelete('way', b.id, user);
    this.db.logChange(ctx.changesetId, 'way', b.id, 'delete', beforeB, null, user);
    ops.push(this._broadcastFor('way', mergedWay, 'update'));
    ops.push({ k: 'wayDelete', id: b.id });

    this._pushUndo(user.id, { label: '合并道路', steps: this._dedupeSteps(steps) });
    return {
      ops,
      label: bridged ? `合并道路（接上 ${bridged} 米的缺口）` : '合并道路',
      merged: { way: a.id, removed: b.id, nodes: merged.length, joinedDistance: bridged, snapped: best.dist <= snapMeters },
    };
  }

  _joinNodes(user, op, ctx) {
    const from = this.db.getNode(op.from);
    const to = this.db.getNode(op.to);
    if (!from || from.deleted || !to || to.deleted) throw new OpError('节点不存在');
    if (from.id === to.id) throw new OpError('两个节点是同一个');
    this.checkLock('node', from.id, user);
    this.checkLock('node', to.id, user);

    const ways = this.db.nodeTopology(from.id).ways;
    const inverse = [];
    const ops = [];
    for (const wid of ways) {
      const before = this.db.snapshot('way', wid);
      if (!before) continue;
      inverse.push({ op: 'restore', type: 'way', snapshot: before });
      const dedup = [];
      for (const nid of before.nodes) {
        const mapped = nid === from.id ? to.id : nid;
        if (dedup.length && dedup[dedup.length - 1] === mapped) continue;
        dedup.push(mapped);
      }
      if (dedup.length < 2) {
        this.db.hardDelete('way', wid, user);
        this.db.logChange(ctx.changesetId, 'way', wid, 'delete', before, null, user);
        ops.push({ k: 'wayDelete', id: wid });
        continue;
      }
      const way = this.db.updateWayTags(wid, { version: before.version + 1, tags: before.tags, nodes: dedup }, user);
      this.db.logChange(ctx.changesetId, 'way', wid, 'modify', before, this.db.snapshot('way', wid), user);
      ops.push(this._broadcastFor('way', way, 'update'));
    }
    inverse.push({ op: 'restore', type: 'node', snapshot: this.db.snapshot('node', from.id) });
    const nodeBefore = this.db.snapshot('node', from.id);
    this.db.hardDelete('node', from.id, user);
    this.db.logChange(ctx.changesetId, 'node', from.id, 'delete', nodeBefore, null, user);
    ops.push({ k: 'nodeDelete', id: from.id });

    this._pushUndo(user.id, { label: '合并节点', steps: this._dedupeSteps(inverse) });
    return { ops, label: '合并节点' };
  }

  _reverseWay(user, op, ctx) {
    const cur = this.db.getWay(op.id);
    if (!cur || cur.deleted) throw new OpError('道路不存在');
    if (op.version !== undefined && Number(op.version) !== cur.version) throw new OpError('道路已被他人修改，请重新加载', 'CONFLICT', conflictInfo('way', op.id, cur, op));
    const before = this.db.snapshot('way', op.id);
    const way = this.db.updateWayTags(op.id, { version: cur.version + 1, tags: cur.tags, nodes: cur.nodes.slice().reverse() }, user);
    this.db.logChange(ctx.changesetId, 'way', op.id, 'modify', before, this.db.snapshot('way', op.id), user);
    this._pushUndo(user.id, { label: '反转道路方向', steps: [{ op: 'restore', type: 'way', snapshot: before }] });
    return { ops: [this._broadcastFor('way', way, 'update')], label: '反转道路方向' };
  }

  /* -------------------------------- 关系 -------------------------------- */
  _sanitizeMembers(members) {
    if (!Array.isArray(members)) throw new OpError('关系成员格式不正确');
    if (members.length > LIMITS.maxRelationMembers) throw new OpError(`关系成员最多 ${LIMITS.maxRelationMembers} 个`);
    return members.map((m) => {
      const type = String(m.type || '');
      if (!['node', 'way', 'relation'].includes(type)) throw new OpError('关系成员类型必须是 node/way/relation');
      const ref = Number(m.ref);
      if (!Number.isFinite(ref)) throw new OpError('关系成员引用不合法');
      const role = String(m.role == null ? '' : m.role).slice(0, 64);
      const target = this.db.getElement(type, ref);
      if (!target || target.deleted) throw new OpError(`关系成员不存在：${type} ${ref}`);
      return { type, ref, role };
    });
  }

  _createRelation(user, op, ctx) {
    const members = this._sanitizeMembers(op.members || []);
    const tags = sanitizeTags(op.tags) || null;
    if (!tags || !tags.type) throw new OpError('关系必须有一个 type 标签（如 multipolygon / route）');
    const rel = this.db.insertRelation({ members, tags }, user);
    this.db.logChange(ctx.changesetId, 'relation', rel.id, 'create', null, this.db.snapshot('relation', rel.id), user);
    this._pushUndo(user.id, { label: '新建关系', steps: [{ op: 'delete', type: 'relation', id: rel.id }] });
    return { ops: [this._broadcastFor('relation', rel, 'create')], label: '新建关系' };
  }

  _updateRelation(user, op, ctx) {
    const cur = this.db.getRelation(op.id);
    if (!cur || cur.deleted) throw new OpError('关系不存在');
    if (op.version !== undefined && Number(op.version) !== cur.version) {
      throw new OpError(`关系 #${op.id} 已被 ${cur.editorName || '其他人'} 修改（版本 ${cur.version}）`, 'CONFLICT', conflictInfo('relation', op.id, cur, op));
    }
    this.checkLock('relation', op.id, user);
    const before = this.db.snapshot('relation', op.id);
    const members = op.members === undefined ? cur.members : this._sanitizeMembers(op.members);
    const tags = op.tags === undefined ? cur.tags : (sanitizeTags(op.tags) || null);
    const rel = this.db.updateRelation(op.id, { version: cur.version + 1, members: op.members === undefined ? null : members, tags }, user);
    this.db.logChange(ctx.changesetId, 'relation', op.id, 'modify', before, this.db.snapshot('relation', op.id), user);
    this._pushUndo(user.id, { label: '修改关系', steps: [{ op: 'restore', type: 'relation', snapshot: before }] });
    return { ops: [this._broadcastFor('relation', rel, 'update')], label: '修改关系' };
  }

  _deleteRelation(user, op, ctx) {
    const cur = this.db.getRelation(op.id);
    if (!cur || cur.deleted) throw new OpError('关系不存在');
    if (op.version !== undefined && Number(op.version) !== cur.version) throw new OpError('关系已被他人修改', 'CONFLICT', conflictInfo('relation', op.id, cur, op));
    this.checkLock('relation', op.id, user);
    const before = this.db.snapshot('relation', op.id);
    this.db.hardDelete('relation', op.id, user);
    this.db.logChange(ctx.changesetId, 'relation', op.id, 'delete', before, null, user);
    this._pushUndo(user.id, { label: '删除关系', steps: [{ op: 'restore', type: 'relation', snapshot: before }] });
    return { ops: [{ k: 'relationDelete', id: op.id }], label: '删除关系' };
  }

  /* ------------------------------ 撤销 / 重做 ------------------------------ */
  _undo(user, op, ctx, viaBus) {
    // 先问分组总线：最新一步可能是"一整组"，也可能在交通那条栈上（viaBus=true 时是总线叫我们来的）
    if (!viaBus && this.undoBus) {
      const fromBus = this.undoBus.undo(user, ctx, this.undoSrc);
      if (fromBus) return fromBus;
    }
    const stack = this.undoStacks.get(user.id) || [];
    const entry = stack.pop();
    if (!entry) throw new OpError('没有可撤销的操作了');
    const redoSteps = this._invertSteps(entry.steps);
    const ops = this._applySteps(entry.steps, user, ctx, 'undo');
    const redoStack = this.redoStacks.get(user.id) || [];
    redoStack.push({ label: entry.label, steps: redoSteps, seq: entry.seq });
    this.redoStacks.set(user.id, redoStack);
    return { ops, label: '撤销：' + entry.label, undoDepth: stack.length };
  }

  _redo(user, op, ctx, viaBus) {
    if (!viaBus && this.undoBus) {
      const fromBus = this.undoBus.redo(user, ctx, this.undoSrc);
      if (fromBus) return fromBus;
    }
    const stack = this.redoStacks.get(user.id) || [];
    const entry = stack.pop();
    if (!entry) throw new OpError('没有可重做的操作了');
    const undoSteps = this._invertSteps(entry.steps);
    const ops = this._applySteps(entry.steps, user, ctx, 'redo');
    const undoStack = this.undoStacks.get(user.id) || [];
    undoStack.push({ label: entry.label, steps: undoSteps, seq: entry.seq });
    this.undoStacks.set(user.id, undoStack);
    return { ops, label: '重做：' + entry.label, redoDepth: stack.length };
  }

  /* ------------------------------ 回滚变更集 ------------------------------ */
  _revertChangeset(user, op, ctx) {
    const changeset = this.db.getChangeset(Number(op.id));
    if (!changeset) throw new OpError('变更集不存在');
    if (!this.options.allowAnyRollback && changeset.author !== user.id) {
      throw new OpError('只能回滚自己的变更集（服务器配置允许所有人回滚时可放开）', 'FORBIDDEN');
    }
    const changes = this.db.changesOfChangeset(Number(op.id));
    if (!changes.length) throw new OpError('该变更集没有改动');
    if (changes.every((c) => c.undone)) throw new OpError('该变更集已经回滚过了');
    const ops = [];
    // 反向遍历：先撤销最后的改动
    for (const c of changes) {
      if (c.undone) continue;
      const before = c.before_json ? JSON.parse(c.before_json) : null;
      const after = c.after_json ? JSON.parse(c.after_json) : null;
      if (before) {
        const el = c.elem_type === 'node' ? this.db.restoreNode(before, user)
          : c.elem_type === 'way' ? this.db.restoreWay(before, user)
            : this.db.restoreRelation(before, user);
        ops.push(this._broadcastFor(c.elem_type, el, 'update'));
      } else if (after) {
        this.db.hardDelete(c.elem_type, c.elem_id, user);
        ops.push({ k: c.elem_type + 'Delete', id: c.elem_id });
      }
      this.db.logChange(ctx.changesetId, c.elem_type, c.elem_id, before ? 'modify' : 'delete', after, before, user);
    }
    this.db.markChangesetReverted(Number(op.id));
    return { ops, label: `回滚变更集 #${op.id}`, reverted: Number(op.id) };
  }
}

module.exports = { OsmOps, OpError, GroupError, UndoBus, GROUP_OPS, LIMITS, sanitizeTags };
