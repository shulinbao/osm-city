'use strict';
/**
 * 线路管理器（Line Manager）：线路这一块的"唯一实现"。
 *
 * **它只有交通面板这一个家**：线路详情就是面板「线路」分区右侧那一块（transit.js 的
 * renderLineDetail → LineMgr.embed）。原来那个独立的浮动窗口（#linemgr.lm-win：左侧线路列表 +
 * 右侧详情、可拖动可缩放、位置记忆、2 秒轮询、Esc 关闭）已经**整套删掉**，不再复活：
 * 左侧列表由交通面板自己的统一列表负责（那份带搜索 / 筛选 / 排序 / 分页，比窗口里的更全）。
 *
 * 传统 script（非模块），挂在 window.G.LineMgr 下：
 *   window.G.LineMgr.open(lineId?)              切到交通面板的「线路」分区并选中这条线（不再开窗口）
 *   window.G.LineMgr.embed(host, {lineId})      把"一条线路的详情"嵌进交通面板右侧详情区
 *   window.G.LineMgr.liveRefresh(force?)        模拟帧里刷新嵌入详情的实时数字（节流 + 鼠标悬停时让路）
 *   window.G.LineMgr.detach(host)               面板关掉这块详情时解绑
 *   window.G.LineMgr.render() / refresh(opts)   重新渲染（数据变了可以手动叫一次）
 *   window.G.LineMgr.onTransitData()            Transit 的数据钩子（快照 / 模拟帧之后）
 *   window.G.LineMgr.compareBlock(lines)        线路对比表（日客流 / 车辆数并排）
 *   window.G.LineMgr.exportCsv(lines)           导出线路 CSV
 *   window.G.LineMgr.rebuildBroken(lines)       一键重算所有异常线路（路径不通 / 空线路）
 *   window.G.LineMgr.lineProblem(line)          { empty, broken, noVehicle, bad } 与 problemText(line)
 *   window.G.LineMgr.lineSchedule(line)         线路的班次（流水班 / 定班车）与 scheduleText(line) 摘要
 *
 * 设计约定：
 *   - 线路相关的"重量级"界面（站点顺序表、班次编辑器、车辆表与勾选、客流统计、模式/配色、对比、CSV）
 *     全部在这里实现；交通面板不再另写一份，避免同一件事两个入口。
 *   - 只读 window.G.Transit.data，所有改动都通过 Transit 的操作（op / rebuildLine / addStationToLine …）下发。
 *   - **可写 / 只读只看元素锁**（别人正在改这条线），不看归属：服务端的 updateLine / deleteLine /
 *     line.transfer / line.setService / vehicle.update 一律如此。「我的 / 别家的」只用来排序与画标签。
 */
(function () {
  const { util } = window.G;

  const MIN_REFRESH_MS = 300;   // 合并高频数据帧（服务每 250ms 推一次模拟帧）
  const LIVE_MS = 600;          // 嵌入详情在模拟帧里的刷新节流
  const STATS_DAYS = 7;
  const LIST_LIMIT = 80;        // 一次最多画多少行（和面板一致的"显示更多"策略）

  /** 线路类型（与 server/transit.js 的 STATION_KINDS 一致） */
  const KIND_ORDER = ['rail', 'hsr', 'intercity', 'subway', 'light_rail', 'tram', 'bus'];
  const KIND_LABEL = {
    rail: '铁路', hsr: '高铁', intercity: '城际', subway: '地铁',
    light_rail: '轻轨', tram: '有轨电车', bus: '公交',
  };
  const VEHICLE_STATE = { idle: '待发车', dwell: '停站中', run: '运行中' };
  const SORT_DEFS = [['default', '默认'], ['name', '名称'], ['stops', '站数'], ['vehicles', '车辆数'], ['riders', '日客流'], ['waiting', '等车人数']];
  /** 这些列「大的先来」更自然（默认降序）；名称/默认默认升序。点芯片换列时按这个定方向，再点同一列就反向。 */
  const SORT_DESC_KEYS = { stops: 1, vehicles: 1, riders: 1, waiting: 1 };
  const STATUS_DEFS = [['all', '全部状态'], ['ok', '正常'], ['broken', '路径不通'], ['empty', '空线路'], ['novehicle', '没有车辆']];

  /** 客流统计接口里可能出现的字段名（比较时会把大小写/下划线/空格都抹掉） */
  const RIDER_KEYS = ['riders', 'ridership', 'passengers', 'passenger', 'pax', 'totalriders', 'todayriders', 'passengercount', 'riderscount'];
  const KM_KEYS = ['vehiclekm', 'vehiclekilometers', 'kilometers', 'km', 'buskm', 'trainkm', 'distancekm', 'vehkm', 'totalvehiclekm'];
  const LOAD_KEYS = ['avgload', 'avgloadpct', 'avgloadpercent', 'averageload', 'loadfactor', 'loadrate', 'occupancy', 'avgrundload'];
  const WAIT_KEYS = ['avgwait', 'avgwaitseconds', 'avgwaitsec', 'avgwaits', 'avgwaitingtime', 'averagewait', 'waitseconds', 'avgwaittime'];
  const DAY_KEYS = ['days', 'series', 'daily', 'rows', 'perday', 'byday', 'history', 'items', 'list'];
  const TODAY_KEYS = ['today', 'todaystats', 'todaydata', 'current', 'currentday'];
  const WEEK_KEYS = ['week', 'days7', 'last7', 'last7days', 'sevendays', 'week7', 'totals', 'total', 'summary', 'range'];

  /* ------------------------------ 上下文（面板「线路」分区右侧详情那一份） ------------------------------ */

  function createCtx(kind) {
    return {
      kind,                       // 现在只有 'embed'（面板里嵌的那一块详情）
      detailHost: null,           // 详情容器
      statsHost: null,            // 客流数据块（异步回填用）
      statsLine: null,
      lineId: null,
      picked: [],                 // 车辆列表里勾选的车 id（加入 / 撤下用）
      stats: {},                  // lineId -> { loading, ok, error, data, at }
      filters: { company: 'mine', kind: 'all', status: 'all', search: '', sort: 'default', dir: 'desc' },
      limit: LIST_LIMIT,
      compare: false,             // 详情里是否展开"线路对比"表
      schedDraft: null,           // 班次编辑器里还没保存的改动（服务端数据帧重建详情时不能把它冲掉）
      day: null,
      lastRenderAt: 0,
      pendingRefresh: null,
    };
  }

  let embedCtx = null;          // 面板里同一时刻只有一块详情（独立窗口已删：不再有第二份上下文）

  /* ------------------------------ 全局数据读取（只读） ------------------------------ */

  const transit = () => (window.G && window.G.Transit) || null;

  function data() {
    const t = transit();
    return (t && t.data) || null;
  }

  const allLines = () => (data() && data().lines) || [];
  const allStations = () => (data() && data().stations) || [];
  const allVehicles = () => (data() && data().vehicles) || [];
  const allCompanies = () => (data() && data().companies) || [];
  const allTrains = () => (data() && data().trains) || [];

  const lineById = (id) => allLines().find((l) => l.id === Number(id)) || null;
  const stationById = (id) => allStations().find((s) => s.id === Number(id)) || null;
  const companyById = (id) => allCompanies().find((c) => c.id === Number(id)) || null;

  /** 模拟帧里的实时数据（载客 / 状态 / 速度）：车 id 与 runtime id 一致 */
  function liveTrain(id) {
    if (id == null) return null;
    return allTrains().find((t) => t.id === Number(id)) || null;
  }

  function selectedLineOf(ctx) {
    if (!ctx || ctx.lineId == null) return null;
    return lineById(ctx.lineId);
  }

  /** 我的公司 id 集合（和交通面板的「只看我的公司」口径一致） */
  function myCompanyIds() {
    const t = transit();
    const d = data();
    const ids = new Set();
    if (!d) return ids;
    const me = t && typeof t.myId === 'function' ? t.myId() : null;
    for (const c of d.companies || []) {
      if ((me && c.owner === me) || (d.myCompanyId && c.id === d.myCompanyId)) ids.add(c.id);
    }
    return ids;
  }

  /**
   * 这条线路**现在能不能改**：只看一件事 —— 有没有别人正锁着它（元素锁）。
   *
   * 归属（owner / companyId）**不是权限**：服务端的 updateLine / deleteLine / line.transfer /
   * line.setService / vehicle.update 一律只挡元素锁，谁建的线路都能改名 / 换色 / 改站序 / 改班次 / 删除，
   * 车辆也一样。所以这里不再走 Transit.isMyLine（那是"筛选与徽标"的口径，不是能不能改的口径）。
   * 「我的 / 别家的」只用来给列表排序和画「别家公司」标签。
   */
  function canEdit(line) {
    if (!line) return false;
    return !lockReason(line);
  }

  /** 被别人锁着时服务端那句中文原因（没人锁 → null，界面就是可写的） */
  function lockReason(line) {
    const t = transit();
    if (!line || !t || typeof t.elemLockBy !== 'function') return null;
    const by = t.elemLockBy('line', line.id);
    if (!by) return null;
    return typeof t.lockBusyText === 'function'
      ? t.lockBusyText(by)
      : `${by} 正在编辑这个元素，请稍后再试`;
  }

  function companyVehicles(line) {
    if (!line) return [];
    return allVehicles().filter((v) => v.companyId === line.companyId || (line.companyId == null && v.owner === line.owner));
  }

  function lineVehicles(line) {
    if (!line) return [];
    return allVehicles().filter((v) => v.lineId === line.id);
  }

  /* ------------------------------ 运营状态（#3 暂停运营 / #2 转移归属） ------------------------------ */

  /** 这条线是不是被"一键暂停运营"了（服务端 linePublic().service.paused；暂停时 noServiceNow 一定为 true） */
  function linePaused(line) {
    return !!(line && line.service && line.service.paused);
  }

  /** 现在真的在跑的车有几辆（暂停时用来说明「在跑的 N 辆车会跑完当前趟」） */
  function runningVehicleCount(line) {
    if (!line) return 0;
    return lineVehicles(line).filter((v) => {
      const t = liveTrain(v.id);
      if (!t) return false;
      return t.state === 'run' || t.state === 'dwell' || Number(t.speed) > 0;
    }).length;
  }

  /** 「?」：长说明收进一个小问号里（悬停看 title，点一下展开/收起旁边那段 .lm-help-note） */
  function helpChip(text) {
    const el = util.el('span', 'lm-help', '?');
    el.title = text;
    el.onclick = (ev) => {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      const host = el.closest ? el.closest('.lm-sec') : null;
      const note = host ? host.querySelector('.lm-help-note') : null;
      if (note) note.classList.toggle('hidden');
    };
    return el;
  }

  /** 暂停 / 恢复运营（transit op line.setService { id, running }） */
  function toggleService(ctx, line) {
    const t = transit();
    if (!t || typeof t.op !== 'function') { toast('交通系统还没准备好', 'warn'); return; }
    const paused = linePaused(line);
    const running = runningVehicleCount(line);
    const vehCount = lineVehicles(line).length;
    const ask = paused
      ? [`恢复「${line.name}」的运营？`, '', '· 按班次表重新排"现在之后的下一班"，之后照常发车',
        '· 自由发车线直接回到首站重新开跑', '· 一步可撤销'].join('\n')
      : [`暂停「${line.name}」的运营？`, '',
        `· 不再发新车；已经在跑的 ${running} 辆车会跑完当前趟（含回到首站）再收车`,
        `· 不删车、不藏车、不瞬移：线上 ${vehCount} 辆车都还在，只是不再发车`,
        '· 站台上等车的人一个不动（继续按耐心规则等）', '· 一步可撤销（再点「恢复运营」或 Ctrl+Z）'].join('\n');
    if (!window.confirm(ask)) return;
    t.op({ k: 'line.setService', id: line.id, running: paused })
      .then((res) => {
        const saved = (res && res.result && res.result.line) || null;
        if (saved) Object.assign(line, saved);
        const changed = !(res && res.result && res.result.changed === false);
        const note = (res && res.result && res.result.note) || '';
        toast(changed
          ? (paused ? `已恢复「${line.name}」的运营` : `已暂停「${line.name}」的运营：在跑的 ${running} 辆车会跑完当前趟再收车`)
          : note || '状态没有变化', changed ? 'success' : 'info', 4500);
        renderCtx(ctx);
        if (typeof t.renderPanelSoon === 'function') t.renderPanelSoon();
      })
      .catch((err) => toast((err && err.message) || '暂停 / 恢复运营失败', 'error', 5000));
  }

  /** 转移归属（transit op line.transfer { id, companyId, withVehicles }） */
  function transferLineTo(ctx, line, companyId, withVehicles) {
    const t = transit();
    if (!t || typeof t.op !== 'function') { toast('交通系统还没准备好', 'warn'); return; }
    const cid = Number(companyId);
    if (!Number.isFinite(cid) || !cid) { toast('先在下拉框里选一家目标公司', 'warn', 3500); return; }
    const target = companyById(cid);
    if (target && Number(line.companyId) === cid) { toast('这条线路本来就属于这家公司', 'info', 3500); return; }
    const fleet = lineVehicles(line).length;
    const ask = [`把「${line.name}」转到${target ? '「' + target.name + '」' : '#' + cid}名下？`, '',
      withVehicles ? `· 连同现在派在这条线上的 ${fleet} 辆车一起转过去（车的归属跟着换）` : '· 只转线路，车辆留在原来的公司（车照样能跑这条线）',
      '· 站台上等这条线的人会跟着搬到新公司名下（一个不少，等待计时继续走）',
      '· 一步可撤销'].join('\n');
    if (!window.confirm(ask)) return;
    t.op({ k: 'line.transfer', id: line.id, companyId: cid, withVehicles: !!withVehicles })
      .then((res) => {
        const r = (res && res.result) || {};
        const saved = r.line || null;
        if (saved) Object.assign(line, saved);
        if (r.moved === false) { toast(r.note || '线路归属没有变化', 'info', 4000); }
        else {
          const toName = (r.to && r.to.name) || (target && target.name) || ('#' + cid);
          const moved = Number(r.vehiclesMoved) || 0;
          toast(`「${line.name}」已转到「${toName}」名下${moved ? `（连同 ${moved} 辆车）` : ''}`, 'success', 5000);
        }
        renderCtx(ctx);
        if (typeof t.renderPanelSoon === 'function') t.renderPanelSoon();
      })
      .catch((err) => toast((err && err.message) || '转移归属失败', 'error', 5000));
  }

  /* ------------------------------ 线路异常（面板详情与「异常清单」分区共用同一份判断） ------------------------------ */

  function lineProblem(line) {
    const stops = (line && line.stops) || [];
    const empty = stops.length < 2;
    const broken = !!(line && line.pathError);
    // 车辆数优先用交通面板的 O(1) 索引（列表里每条线路都要算，不能每次遍历整个车队）
    const t = transit();
    const vehCount = (t && typeof t.lineVehicleCount === 'function') ? t.lineVehicleCount(line) : lineVehicles(line).length;
    return { empty, broken, noVehicle: !vehCount, bad: empty || broken };
  }

  function problemText(line) {
    const p = lineProblem(line);
    if (p.broken) return shortText(line.pathError, 60) || '路径不通';
    if (p.empty) return ((line.stops || []).length ? '只有 1 站，成不了线路' : '还没有站点');
    if (p.noVehicle) return '还没有指派车辆，线路上不会有车跑';
    return '';
  }

  /* ------------------------------ 小工具 ------------------------------ */

  function kindLabel(kind) {
    return KIND_LABEL[kind] || kind || '未知';
  }

  function shortText(s, n) {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) {
      const r = s % 60;
      return r ? m + ' 分 ' + r + ' 秒' : m + ' 分钟';
    }
    return Math.floor(m / 60) + ' 时 ' + String(m % 60).padStart(2, '0') + ' 分';
  }

  function fmtMeters(m) {
    const v = Number(m);
    if (!Number.isFinite(v)) return '—';
    return util.fmt(v) + ' 米';
  }

  function fmtPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return Math.round(n) + '%';
  }

  /** 一行「标签 + 值」 */
  function kvRow(label, value) {
    return util.el('div', 'tp-row', `<span>${util.esc(label)}</span><b>${value}</b>`);
  }

  function button(cls, text, title, onClick, disabled) {
    const b = util.el('button', cls, util.esc(text));
    if (title) b.title = title;
    if (onClick) b.onclick = onClick;
    if (disabled) b.disabled = true;
    return b;
  }

  function toast(msg, kind, ms) {
    util.toast(msg, kind || 'info', ms || 3200);
  }

  function isTyping(container) {
    const a = document.activeElement;
    if (!a || !container || typeof container.contains !== 'function') return false;
    if (!container.contains(a)) return false;
    const tag = (a.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    const type = (a.type || 'text').toLowerCase();
    // time 也要算进来：班次编辑器里有首班 / 末班的时间框，模拟帧一来重建就把正在填的时间冲掉了
    return type === 'text' || type === 'search' || type === 'number' || type === 'email' || type === 'url' || type === 'time';
  }

  /** 鼠标停在详情里时先别重建：正要点「从该线路移除」的时候把按钮换掉，点击就丢了 */
  function bindHoverGuard(host) {
    if (!host || host.__lmHoverBound) return;
    host.__lmHoverBound = true;
    host.addEventListener('mouseenter', () => { host.__lmHover = true; });
    host.addEventListener('mouseleave', () => {
      host.__lmHover = false;
      if (embedCtx && embedCtx.detailHost === host) liveRefresh(true);
    });
  }

  /* ------------------------------ 客流统计接口 ------------------------------ */

  const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

  function pickNum(src, names) {
    if (!src || typeof src !== 'object') return null;
    for (const key of Object.keys(src)) {
      if (!names.includes(normKey(key))) continue;
      const v = src[key];
      if (v == null || typeof v === 'object') continue;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function findFirst(obj, names) {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of Object.keys(obj)) {
      if (names.includes(normKey(key))) return obj[key];
    }
    return null;
  }

  function findArray(obj, names) {
    const v = findFirst(obj, names);
    return Array.isArray(v) ? v : null;
  }

  /** 0~1 的满载率换算成百分比 */
  function asPercent(v) {
    if (v == null) return null;
    return v > 0 && v <= 1 ? v * 100 : v;
  }

  function emptyBucket() {
    return { riders: null, vehicleKm: null, avgLoad: null, avgWait: null };
  }

  function readBucket(src) {
    const b = emptyBucket();
    if (!src || typeof src !== 'object') return b;
    b.riders = pickNum(src, RIDER_KEYS);
    if (b.riders == null) b.riders = pickNum(src, ['count']);
    b.vehicleKm = pickNum(src, KM_KEYS);
    b.avgLoad = asPercent(pickNum(src, LOAD_KEYS));
    b.avgWait = pickNum(src, WAIT_KEYS);
    return b;
  }

  function mergeBucket(base, extra) {
    const out = Object.assign(emptyBucket(), base);
    for (const k of Object.keys(out)) if (extra[k] != null) out[k] = extra[k];
    return out;
  }

  function aggregate(buckets) {
    const out = emptyBucket();
    let riderSum = 0;
    let kmSum = 0;
    let hasRiders = false;
    let hasKm = false;
    let loadSum = 0;
    let loadW = 0;
    let waitSum = 0;
    let waitW = 0;
    for (const b of buckets) {
      const w = b.riders != null && b.riders > 0 ? b.riders : 1;
      if (b.riders != null) { riderSum += b.riders; hasRiders = true; }
      if (b.vehicleKm != null) { kmSum += b.vehicleKm; hasKm = true; }
      if (b.avgLoad != null) { loadSum += b.avgLoad * w; loadW += w; }
      if (b.avgWait != null) { waitSum += b.avgWait * w; waitW += w; }
    }
    if (hasRiders) out.riders = riderSum;
    if (hasKm) out.vehicleKm = kmSum;
    if (loadW) out.avgLoad = loadSum / loadW;
    if (waitW) out.avgWait = waitSum / waitW;
    return out;
  }

  function dayLabel(row, index) {
    const v = findFirst(row, ['date', 'day', 'label', 'name', 'ts', 'time', 'timestamp', 'at']);
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v > 1e11) {
        const d = new Date(v);
        return `${d.getMonth() + 1}/${d.getDate()}`;
      }
      return `第 ${Math.round(v)} 天`;
    }
    if (typeof v === 'string' && v) return shortText(v, 18);
    return `第 ${index + 1} 天`;
  }

  /**
   * 把服务端返回的客流统计规范化成 { today, week, days, updatedAt }。
   * 服务端字段名还没定稿，所以这里对多种形状都做兼容：
   *   { today:{...}, week:{...} } / { days:[{date,riders,vehicleKm,avgLoad,avgWait}] } / 直接给一组数组
   */
  function normalizeStats(body) {
    const out = { today: emptyBucket(), week: emptyBucket(), days: [], updatedAt: null };
    if (!body || typeof body !== 'object') return out;
    const root = Array.isArray(body) ? { days: body } : body;

    const ts = findFirst(root, ['updatedAt', 'updated', 'generatedAt', 'ts', 'at']);
    if (typeof ts === 'number' && ts > 1e11) out.updatedAt = ts;

    const list = findArray(root, DAY_KEYS);
    if (list && list.length) {
      const rows = [];
      let i = 0;
      for (const r of list) {
        if (!r || typeof r !== 'object') { i++; continue; }
        const b = readBucket(r);
        b.label = dayLabel(r, i);
        rows.push(b);
        i++;
      }
      out.days = rows;
      if (rows.length) {
        out.week = aggregate(rows.slice(-STATS_DAYS));
        out.today = aggregate(rows.slice(-1));
      }
    }

    const todayObj = findFirst(root, TODAY_KEYS);
    if (todayObj && typeof todayObj === 'object' && !Array.isArray(todayObj)) {
      out.today = mergeBucket(out.today, readBucket(todayObj));
    }
    const weekObj = findFirst(root, WEEK_KEYS);
    if (weekObj && typeof weekObj === 'object' && !Array.isArray(weekObj)) {
      out.week = mergeBucket(out.week, readBucket(weekObj));
    }
    // 顶层直接给数字（说明接口返回的就是请求区间 7 天的汇总）
    out.week = mergeBucket(out.week, readBucket(root));
    return out;
  }

  function fetchStats(ctx, line, force) {
    if (!ctx || !line) return;
    const id = line.id;
    const slot = ctx.stats[id] || (ctx.stats[id] = { loading: false, ok: false, error: null, data: null, at: 0 });
    if (slot.loading) return;
    if (!force && slot.ok && Date.now() - slot.at < 60000) return;
    slot.loading = true;
    slot.error = null;
    paintStats(ctx);
    const net = window.G && window.G.Net;
    const token = (net && net.token) || '';
    const url = `/api/transit/line/${encodeURIComponent(id)}/stats?days=${STATS_DAYS}&token=${encodeURIComponent(token)}`;
    fetch(url, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (res.status === 404 || res.status === 501) {
          const err = new Error('客流统计还没准备好');
          err.notReady = true;
          throw err;
        }
        if (!res.ok) throw new Error(`客流统计读取失败（HTTP ${res.status}）`);
        return res.json();
      })
      .then((body) => {
        if (!body || typeof body !== 'object') {
          const err = new Error('客流统计还没准备好');
          err.notReady = true;
          throw err;
        }
        slot.ok = true;
        slot.data = normalizeStats(body);
        slot.at = Date.now();
      })
      .catch((err) => {
        slot.ok = false;
        slot.data = null;
        slot.error = err && (err.notReady || err.name === 'SyntaxError') ? 'notready' : ((err && err.message) || '客流统计读取失败');
      })
      .then(() => {
        slot.loading = false;
        paintStats(ctx);
      });
  }

  /* ------------------------------ 站点（顺序 / 间距 / 里程 / 时间） ------------------------------ */

  /**
   * 由 line.stops + line.stopsInfo 算出每一站的 相邻间距 / 累计里程 / 单程时间。
   * stopsInfo 是服务端沿路网算出来的（含每站里程），没有它时退化成站点间的直线距离（标 approx）。
   */
  function stopRows(line) {
    const stops = Array.isArray(line.stops) ? line.stops : [];
    const info = new Map();
    for (const it of line.stopsInfo || []) {
      if (it && it.stationId != null) info.set(Number(it.stationId), it);
    }
    const totalSecs = Number(line.travelSeconds) || 0;
    const rows = [];
    let cum = 0;
    let prevStation = null;
    let approx = false;

    for (let i = 0; i < stops.length; i++) {
      const st = stationById(stops[i]);
      const meta = info.get(Number(stops[i])) || null;
      let seg = null;
      if (i === 0) {
        cum = 0;
      } else if (meta && Number.isFinite(Number(meta.distance))) {
        const d = Number(meta.distance);
        seg = Math.max(0, d - cum);
        cum = d;
      } else if (st && prevStation) {
        seg = util.metersBetween(prevStation, st);
        cum += seg;
        approx = true;
      } else {
        approx = true;
      }
      rows.push({
        index: i,
        stationId: stops[i],
        name: (meta && meta.name) || (st && st.name) || `车站 #${stops[i]}`,
        missing: !st,
        seg,
        cum,
        secs: null,
      });
      if (st) prevStation = st;
    }

    // 单程时间按里程占比折算（服务端只给整条线的 totalSeconds）
    const totalLen = Number(line.pathLen) || (rows.length ? rows[rows.length - 1].cum : 0);
    if (totalSecs > 0 && totalLen > 0) {
      for (const r of rows) r.secs = (totalSecs * r.cum) / totalLen;
    }
    return { rows, approx };
  }

  /* ------------------------------ 操作（全部走 Transit 的公开操作） ------------------------------ */

  function applyStops(ctx, line, stops, okMsg) {
    const t = transit();
    if (!t || typeof t.op !== 'function') { toast('交通系统还没准备好', 'warn'); return; }
    t.op({ k: 'line.update', id: line.id, stops })
      .then((res) => {
        const info = (res && res.result && res.result.path) || {};
        if (info.error) toast('已保存，但路径不通：' + info.error, 'warn', 6000);
        else toast(okMsg || '站点顺序已更新', 'success', 3000);
        renderCtx(ctx);
      })
      .catch((err) => toast((err && err.message) || '操作失败', 'error', 5000));
  }

  function removeStopAt(ctx, line, index) {
    const t = transit();
    if (t && typeof t.removeStop === 'function') {
      t.removeStop(line, index);
      setTimeout(() => renderCtx(ctx), 400);
      return;
    }
    const stops = (line.stops || []).slice();
    stops.splice(index, 1);
    applyStops(ctx, line, stops, '已删除该站');
  }

  function moveStop(ctx, line, index, delta) {
    const stops = (line.stops || []).slice();
    const j = index + delta;
    if (j < 0 || j >= stops.length) return;
    const tmp = stops[index];
    stops[index] = stops[j];
    stops[j] = tmp;
    applyStops(ctx, line, stops, delta < 0 ? '已上移一站' : '已下移一站');
  }

  function addStop(line) {
    const t = transit();
    if (!t || typeof t.addStationToLine !== 'function') { toast('交通面板还没准备好，暂时不能加站', 'warn'); return; }
    t.addStationToLine(line);   // 面板不关：既能点左侧车站列表，也能点地图上的车站
  }

  function rebuildLine(ctx, line) {
    const t = transit();
    if (t && typeof t.rebuildLine === 'function') {
      Promise.resolve(t.rebuildLine(line)).then(() => setTimeout(() => renderCtx(ctx), 500)).catch(() => {});
      return;
    }
    applyStops(ctx, line, line.stops || [], '路径已重算');
  }

  /** 一键重算所有异常线路（路径不通 / 空线路之外但没路径的） */
  function rebuildBroken(lines) {
    const t = transit();
    const list = (lines || []).filter((l) => l && (l.pathError || !(l.stops || []).length || !(l.pathLen > 0)));
    if (!list.length) { toast('没有需要重算的线路', 'info', 2500); return Promise.resolve(0); }
    if (!window.confirm(`重算 ${list.length} 条异常线路的路径？\n站点顺序不变，只按当前路网重新算一遍走向。`)) return Promise.resolve(0);
    let chain = Promise.resolve();
    let okCount = 0;
    for (const line of list) {
      chain = chain.then(() => (t && typeof t.op === 'function'
        ? t.op({ k: 'line.update', id: line.id, stops: line.stops || [] })
        : Promise.resolve())
        .then((res) => {
          const info = (res && res.result && res.result.path) || {};
          if (!info.error) okCount += 1;
        })
        .catch(() => { /* 单条失败继续下一条 */ }));
    }
    return chain.then(() => {
      toast(`已重算 ${list.length} 条异常线路，其中 ${okCount} 条通了`, okCount ? 'success' : 'warn', 5000);
      if (t && typeof t.renderPanelSoon === 'function') t.renderPanelSoon();
      renderCtx(embedCtx);
      return okCount;
    });
  }

  /** 车辆加入 / 撤下：勾选列表 + 按钮，绝不用输入框 */
  function assignPicked(ctx, line, target) {
    const t = transit();
    if (!t) { toast('交通系统还没准备好', 'warn'); return; }
    const list = ctx.picked.map((id) => allVehicles().find((v) => v.id === id)).filter(Boolean);
    if (!list.length) { toast('先在下面的车辆列表里勾选车辆', 'warn'); return; }
    const lineId = target === null ? null : Number(target);
    if (typeof t.assignVehicles === 'function') {
      t.assignVehicles(list, lineId);   // 交通面板的同一套逻辑：批量 vehicle.update
      ctx.picked = [];
      renderCtx(ctx);
      return;
    }
    let chain = Promise.resolve();
    for (const v of list) chain = chain.then(() => t.op({ k: 'vehicle.update', id: v.id, lineId }));
    chain
      .then(() => {
        ctx.picked = [];
        toast(lineId === null ? `已把 ${list.length} 辆车撤下线路` : `已把 ${list.length} 辆车加入线路`, 'success');
        renderCtx(ctx);
      })
      .catch((err) => toast((err && err.message) || '操作失败', 'error'));
  }

  /** 批量把车队加入本线：一次把公司里所有闲置车辆挂上来 */
  function addIdleFleet(ctx, line) {
    const t = transit();
    const idle = companyVehicles(line).filter((v) => !v.lineId);
    if (!idle.length) { toast('这家公司没有闲置车辆（都已在线上）', 'info', 3000); return; }
    if (!window.confirm(`把 ${idle.length} 辆闲置车辆全部加入「${line.name}」？`)) return;
    if (t && typeof t.assignVehicles === 'function') {
      t.assignVehicles(idle, line.id);
      setTimeout(() => renderCtx(ctx), 600);
      return;
    }
    let chain = Promise.resolve();
    for (const v of idle) chain = chain.then(() => t.op({ k: 'vehicle.update', id: v.id, lineId: line.id }));
    chain.then(() => { toast(`已把 ${idle.length} 辆车加入「${line.name}」`, 'success'); renderCtx(ctx); })
      .catch((err) => toast((err && err.message) || '操作失败', 'error'));
  }

  /* ------------------------------ 线路对比 / 导出 CSV ------------------------------ */

  /** 对比用的数字：日客流 / 车辆数 / 站数 / 里程 / 单程 / 覆盖人口 */
  function compareRows(lines) {
    return (lines || []).map((line) => {
      const stops = (line.stops || []).length;
      const veh = lineVehicles(line).length;
      return {
        line,
        name: line.name,
        kind: kindLabel(line.kind),
        stops,
        vehicles: veh,
        riders: Number(line.dailyTrips || 0),
        lengthM: Number(line.pathLen || 0),
        seconds: Number(line.travelSeconds || 0),
        pop: Number(line.popTotal || 0),
        broken: !!line.pathError,
      };
    }).sort((a, b) => b.riders - a.riders || b.vehicles - a.vehicles || a.name.localeCompare(b.name, 'zh'));
  }

  /** 线路对比表：一行一条线，日客流 / 车辆数并排（面板「线路」分区的「📊 线路对比」用它） */
  function compareBlock(lines) {
    const rows = compareRows(lines);
    const box = util.el('div', 'lm-sec lm-cmp');
    const head = util.el('div', 'lm-sec-head');
    head.appendChild(util.el('div', 'lm-sec-title', `线路对比（${rows.length} 条 · 按日客流排序）`));
    box.appendChild(head);
    if (!rows.length) {
      box.appendChild(util.el('div', 'empty-hint small', '没有可对比的线路（换个筛选条件看看）'));
      return box;
    }
    const table = util.el('table', 'lm-table');
    table.innerHTML = '<thead><tr><th>线路</th><th>类型</th><th>站数</th><th>车辆数</th><th>日客流</th><th>里程</th><th>单程</th><th>覆盖人口</th></tr></thead>';
    const tbody = util.el('tbody');
    const maxRiders = Math.max(1, ...rows.map((r) => r.riders));
    for (const r of rows) {
      const tr = util.el('tr');
      const bar = Math.round((r.riders / maxRiders) * 100);
      tr.innerHTML = `<td class="name"><span class="lm-dot" style="background:${util.esc((transit() && transit().lineColor) ? transit().lineColor(r.line) : (r.line.color || '#8ab4f8'))}"></span>${util.esc(r.name)}${r.broken ? ' <span class="warn">路径不通</span>' : ''}</td>
        <td>${util.esc(r.kind)}</td>
        <td class="num">${r.stops}</td>
        <td class="num">${r.vehicles}</td>
        <td class="num">${util.fmt(r.riders)}<span class="lm-bar" style="--w:${bar}%"></span></td>
        <td class="num">${util.esc(util.fmtLength(r.lengthM))}</td>
        <td class="num">${r.seconds ? util.esc(fmtDur(r.seconds)) : '—'}</td>
        <td class="num">${util.fmt(r.pop)}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    box.appendChild(util.el('div', 'lm-note',
      '日客流是服务端按线路算出的每日运送人次估算（约值）；车辆数是已经指派到该线路上、真正会跑起来的车。'));
    return box;
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** 导出线路 CSV（Excel 能直接打开：带 BOM，字段加引号转义） */
  function exportCsv(lines) {
    const list = (lines || []).filter(Boolean);
    if (!list.length) { toast('没有可导出的线路', 'warn', 3000); return 0; }
    const rows = [['线路', '公司', '类型', '状态', '站数', '车辆数', '日客流(人次)', '里程(米)', '单程(秒)', '起点', '终点', '站点顺序']];
    for (const line of list) {
      const stops = (line.stops || []).map((id) => (stationById(id) || {}).name || `#${id}`);
      const p = lineProblem(line);
      rows.push([
        line.name, (companyById(line.companyId) || {}).name || '', kindLabel(line.kind),
        p.broken ? '路径不通' : (p.empty ? '空线路' : '正常'),
        stops.length, lineVehicles(line).length, Number(line.dailyTrips || 0),
        Math.round(Number(line.pathLen || 0)), Math.round(Number(line.travelSeconds || 0)),
        stops[0] || '', stops[stops.length - 1] || '', stops.join(' → '),
      ]);
    }
    const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    try {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      a.href = url;
      a.download = `线路_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`已导出 ${list.length} 条线路到 CSV`, 'success', 3500);
    } catch (err) {
      toast('导出失败：' + ((err && err.message) || '浏览器不支持下载'), 'error', 5000);
    }
    return list.length;
  }

  /* ------------------------------ 样式（只服务交通面板里嵌的那一块详情） ------------------------------ */

  const STYLE = `
.tp-embed .lm-sec { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: rgba(255,255,255,0.04); }
.tp-embed .lm-sec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.tp-embed .lm-sec-title { flex: 1 1 auto; font-size: 12.5px; font-weight: 700; color: #fff; min-width: 0; }
.tp-embed .lm-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.tp-embed .lm-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.tp-embed .lm-table th { text-align: left; font-weight: 600; color: var(--fg-mute); padding: 3px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.tp-embed .lm-table td { padding: 3px 6px; border-bottom: 1px dashed var(--line-3); color: var(--fg-dim); white-space: nowrap; }
.tp-embed .lm-table tr:last-child td { border-bottom: none; }
.tp-embed .lm-table td.num { text-align: right; font-family: var(--mono); }
.tp-embed .lm-table td.name { color: var(--fg); white-space: normal; }
.tp-embed .lm-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
.tp-embed .lm-bar { display: inline-block; height: 3px; width: var(--w, 0%); max-width: 42px; margin-left: 5px; border-radius: 2px; background: var(--accent, #6ee7a8); vertical-align: middle; opacity: .7; }
.tp-embed .lm-note { font-size: 11px; color: var(--fg-mute); line-height: 1.65; padding-top: 5px; }
.tp-embed .opt-btn { margin: 0; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--line); background: rgba(255,255,255,0.07); color: var(--fg-dim); font-size: 11.5px; cursor: pointer; }
.tp-embed .opt-btn:hover { background: rgba(255,255,255,0.14); color: var(--fg); border-color: var(--accent-line); }
.tp-embed .opt-btn.danger { background: rgba(255,107,107,0.16); border-color: rgba(255,107,107,0.4); color: #ffb3b3; }
.tp-embed .opt-btn[disabled] { opacity: .45; cursor: not-allowed; }
.tp-embed .lm-icon { min-width: 24px; padding: 3px 6px; }
.tp-embed .lm-tags { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 11.5px; color: var(--fg-mute); }
.tp-embed .lm-cmp { margin-top: 6px; }
/* 班次编辑器（流水班 / 定班车）：原生 date/time 控件要显式声明深色，否则在深色面板里是白的 */
.tp-embed .lm-sched { display: flex; flex-direction: column; gap: 6px; color-scheme: dark; }
.tp-embed .lm-sched-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px; color: var(--fg-mute); }
.tp-embed .lm-sched-row > span { color: var(--fg-mute); }
.tp-embed .lm-sched-row input[type="number"],
.tp-embed .lm-sched-row input[type="time"] {
  background: rgba(0,0,0,0.28); border: 1px solid var(--line); border-radius: 7px;
  color: var(--fg); font-size: 11.5px; padding: 3px 5px; font-family: var(--mono);
}
.tp-embed .lm-sched-row input[type="number"] { width: 64px; }
.tp-embed .lm-sched-row input:focus { outline: none; border-color: var(--accent-line); }
.tp-embed .lm-sched-tt {
  width: 100%; min-height: 64px; resize: vertical; padding: 5px 7px;
  background: rgba(0,0,0,0.28); border: 1px solid var(--line); border-radius: 8px;
  color: var(--fg); font-family: var(--mono); font-size: 11.5px; line-height: 1.6;
}
.tp-embed .lm-sched-tt:focus { outline: none; border-color: var(--accent-line); }
.tp-embed .lm-sched-now { font-family: var(--mono); font-size: 11px; color: var(--fg-dim); }
/* 运营控制（暂停 / 恢复运营 · 转移归属）：一行状态 + 一行操作，紧凑排，长说明收进「?」 */
.tp-embed .lm-op-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px; padding: 2px 0; }
.tp-embed .lm-op-label { flex: 0 0 34px; color: var(--fg-mute); font-size: 11px; }
.tp-embed .lm-op-text { flex: 1 1 160px; min-width: 0; color: var(--fg-dim); line-height: 1.5; }
.tp-embed .lm-op-text.warn { color: #ffd166; }
.tp-embed .lm-op-hint { color: var(--fg-mute); font-size: 10.5px; }
.tp-embed .lm-op-pause { border-color: rgba(255,209,102,0.42); color: #ffd166; }
.tp-embed .lm-op-resume { border-color: rgba(110,231,168,0.45); color: #dffbea; }
.tp-embed .lm-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); color: var(--fg-dim); }
.tp-embed .lm-tag.ok { color: #6ee7a8; border-color: rgba(110,231,168,0.45); }
.tp-embed .lm-tag.warn { color: #ffd166; border-color: rgba(255,209,102,0.5); }
.tp-embed .lm-check { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fg-dim); cursor: pointer; }
.tp-embed .lm-help {
  flex: 0 0 auto; width: 16px; height: 16px; line-height: 15px; text-align: center; border-radius: 50%;
  border: 1px solid var(--line); color: var(--fg-mute); font-size: 10.5px; cursor: pointer; user-select: none;
}
.tp-embed .lm-help:hover { color: #fff; border-color: var(--accent-line); background: rgba(255,255,255,0.12); }
.tp-embed .lm-help-note { white-space: pre-line; }
/* 每个班次一辆车：一行一班（发车时刻 + 车辆下拉），默认「自动轮转」 */
.tp-embed .lm-runs { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; padding-top: 5px; border-top: 1px dashed var(--line-3); }
.tp-embed .lm-run-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px; }
.tp-embed .lm-run-time { flex: 0 0 88px; font-family: var(--mono); font-size: 11px; color: var(--fg-dim); }
.tp-embed .lm-run-sel { flex: 0 1 190px; min-width: 120px; }
.tp-embed .lm-run-hint { color: var(--fg-mute); font-size: 10.5px; }
.tp-embed .lm-run-miss { color: #ffd166; font-size: 10.5px; }
.tp-embed .lm-note.warn { color: #ffd166; }
/* 营运列（下一站 / 预计到站 / 班次准点）：列变多了，窄面板里横向滚动而不是把字挤掉；
   晚点统一用红字（和地图气泡、交通面板里的 tp-lag.late 同一个颜色） */
.tp-embed .lm-scroll { overflow-x: auto; }
.tp-embed .tp-lag.late { color: #ffb3b3; font-weight: 700; }
.tp-embed .tp-lag { color: var(--fg-dim); }
.tp-embed .lm-sched-hint { font-size: 10.5px; color: var(--fg-mute); }
.tp-embed .lm-sched-count { font-size: 11px; color: var(--fg-dim); }

`;

  function injectStyle() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.head.querySelector('style[data-linemgr]')) return;
    const st = util.el('style');
    st.setAttribute('data-linemgr', '1');
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  /* ------------------------------ 列表筛选（只给导出 CSV / 对比表用的那份口径） ------------------------------ */

  function scopedLines(ctx) {
    const t = transit();
    const list = allLines();
    if (t && typeof t.query === 'function') return t.query('lines', list, ctx.filters);
    // 兜底：Transit 还没就绪时只做最基本的过滤
    const f = ctx.filters;
    let out = list;
    if (f.company === 'mine') { const mine = myCompanyIds(); out = out.filter((l) => mine.has(l.companyId)); }
    if (f.kind !== 'all') out = out.filter((l) => l.kind === f.kind);
    const q = String(f.search || '').trim().toLowerCase();
    if (q) out = out.filter((l) => String(l.name || '').toLowerCase().includes(q));
    return out;
  }

  /* ------------------------------ 右侧详情 ------------------------------ */

  function colorPicker(line) {
    const t = transit();
    if (!t || typeof t.lineColorPicker !== 'function') return null;
    if (!canEdit(line)) return null;
    return t.lineColorPicker(line, {
      onApply: (color) => {
        Promise.resolve(t.setLineColor(line, color))
          .then(() => { if (embedCtx && Number(embedCtx.lineId) === Number(line.id)) refresh({ force: true }); })
          .catch(() => { /* setLineColor 已经弹过错误提示了 */ });
      },
    });
  }

  function locateLine(line) {
    const render = window.G && window.G.Render;
    const stops = (line.stops || []).map((id) => stationById(id)).filter(Boolean);
    if (!render || !render.map || !stops.length) { toast('这条线路上的车站还没有坐标', 'warn'); return; }
    const mid = stops[Math.floor(stops.length / 2)];
    if (!util.flyToSafe(render.map, mid.lat, mid.lon, Math.max(14, render.map.getZoom()))) {
      toast('这条线路上的车站还没有坐标', 'warn');
    }
  }

  function deleteLine(line) {
    const t = transit();
    if (t && typeof t.deleteLine === 'function') { t.deleteLine(line); return; }
    if (!window.confirm(`删除线路「${line.name}」？线路上的车辆会变成闲置。`)) return;
    t.op({ k: 'line.delete', id: line.id }).then(() => { toast('线路已删除', 'success'); renderCtx(embedCtx); })
      .catch((err) => toast((err && err.message) || '删除失败', 'error'));
  }

  /* ------------------------------ 改名（transit op line.update { id, name }） ------------------------------ */

  /** 线路名的口径（与服务端 updateLine 的 sanitise 一字不差）：控制字符抹掉、首尾空白去掉、最多 32 个字 */
  const LINE_NAME_MAX = 32;

  function sanitizeLineName(raw) {
    return String(raw == null ? '' : raw).replace(/[\u0000-\u001f]/g, '').trim().slice(0, LINE_NAME_MAX);
  }

  /**
   * 「✏ 改名」：调用 **Transit.op({ k:'line.update', id, name })**（服务端 updateLine 收 name）。
   *
   * 口径：
   *   · **谁建的线路都能改名**（归属不是权限）—— 唯一的拦路虎是**元素锁**：别人正编辑这条线时，
   *     服务端会抛 code=LOCKED 的中文原因，客户端这边先拦一次（按钮也会是禁用 + 那句中文 title）；
   *   · 客户端按服务端的同一口径先校验一遍（trim / 非空 / ≤32 字 / 无控制字符），
   *     不合格就当场说中文原因，不白跑一趟；服务端真拒了（锁 / 别的校验）就把**它那句中文原因**如实弹出来；
   *   · 改完立刻刷新：本地先改名（地图上的车辆气泡写的就是线路名），成功后重新拉面板与详情，
   *     失败则回滚旧名字 —— 不会出现"界面上改了、服务端没改"的错觉。
   */
  function renameLine(ctx, line) {
    const t = transit();
    if (!t || typeof t.op !== 'function') { toast('交通系统还没准备好', 'warn'); return; }
    if (!canEdit(line)) { toast(lockReason(line) || '现在不能改这条线路的名字', 'warn', 4500); return; }
    const raw = typeof window.prompt === 'function'
      ? window.prompt(`线路名称（1–${LINE_NAME_MAX} 个字，不能有控制字符）`, line.name)
      : null;
    if (raw == null) return;                       // 取消（prompt 返回 null）
    const name = sanitizeLineName(raw);
    if (!name) { toast('线路名不能为空（去掉首尾空格与控制字符后要有内容）', 'warn', 4500); return; }
    if (String(raw).replace(/[\u0000-\u001f]/g, '').trim().length > LINE_NAME_MAX) {
      toast(`线路名最多 ${LINE_NAME_MAX} 个字，超出的部分会被截掉`, 'warn', 4500);
    }
    if (name === line.name) { toast('名字没有变', 'info', 2000); return; }
    const prev = line.name;
    line.name = name;                              // 先本地改掉：地图气泡 / 列表立刻变
    redrawMapLabels(t);
    t.op({ k: 'line.update', id: line.id, name })
      .then((res) => {
        const saved = (res && res.result && res.result.line) || null;
        if (saved) {
          const local = lineById(saved.id);
          if (local) Object.assign(local, saved);
        }
        toast(`线路已改名为「${name}」`, 'success', 3000);
        refresh({ force: true });                  // 面板里嵌的这份详情
        if (typeof t.renderPanelSoon === 'function') t.renderPanelSoon();   // 左侧线路列表 / 地图
        if (!saved && Number(line.id) !== Number(embedCtx && embedCtx.lineId)) renderCtx(ctx);
        redrawMapLabels(t);
      })
      .catch((err) => {
        line.name = prev;                          // 服务端拒了：把旧名字放回去
        redrawMapLabels(t);
        toast((err && err.message) || '改名失败', 'error', 5000);
        refresh({ force: true });
      });
  }

  /** 地图上"线路名"出现在车辆气泡里（Transit.drawVehicleBubble 读 line.name）——改完名重画一次 */
  function redrawMapLabels(t) {
    const render = window.G && window.G.Render;
    if (render && render.overlay && typeof render.overlay.redraw === 'function') render.overlay.redraw();
    if (t && typeof t.refreshVehiclePopup === 'function') t.refreshVehiclePopup();
  }

  function detailHead(ctx, line) {
    const box = util.el('div', 'lm-sec');
    const t = transit();
    const company = companyById(line.companyId);
    const problem = lineProblem(line);
    const head = util.el('div', 'lm-sec-head');
    head.appendChild(util.el('div', 'lm-sec-title',
      `<span style="color:${util.esc((t && t.lineColor) ? t.lineColor(line) : (line.color || '#8ab4f8'))}">${util.esc(line.name)}</span>`));
    const actions = util.el('div', 'lm-actions');
    // 「＋ 加站」「⟳ 重算路径」只在下面的「站点」区块里挂一份（同一个屏幕上不再出现两个一样的按钮）；
    // 这里只留这条线路自己的动作：改名 / 定位 / 删除线路。
    // 协作编辑：**谁建的线路都能改名**（服务端 line.update 不看 owner），唯一能拦的是元素锁 ——
    // 所以按钮**永远画出来**（不按归属藏），被别人锁着时禁用 + 服务端那句中文原因。
    const renameLock = lockReason(line);
    actions.appendChild(button('opt-btn', '✏ 改名',
      renameLock || `改这条线路的名字（谁建的线路都能改；地图上的车辆气泡、班次表都会跟着变）`,
      () => renameLine(ctx, line), !!renameLock));
    actions.appendChild(button('opt-btn', '🗺 定位', '把地图移到这条线路的中间一站', () => locateLine(line)));
    // 协作编辑：**谁建的线路都能删**（服务端 line.delete 不看 owner），唯一能拦的是元素锁 ——
    // 所以「删除线路」按钮**永远画出来**（不再按归属藏起来），被别人锁着时禁用 + 中文原因。
    const delLock = lockReason(line);
    actions.appendChild(button('opt-btn danger', '🗑 删除线路',
      delLock || '删除这条线路（线路上的车辆会变成闲置，可撤销；谁建的线路都能删）',
      () => deleteLine(line), !!delLock));
    head.appendChild(actions);
    box.appendChild(head);

    const tags = util.el('div', 'lm-tags');
    tags.innerHTML = `<span class="tp-tag">#${line.id}</span>
      <span class="tp-tag">${util.esc(kindLabel(line.kind))}</span>
      <span class="tp-tag">${util.esc(company ? company.name : '未知公司')}</span>
      <span class="tp-tag">${(line.stops || []).length} 站</span>
      <span class="tp-tag">${util.fmtLength(line.pathLen)}</span>
      <span class="tp-tag ${problem.bad ? 'warn' : 'ok'}">${problem.broken ? '路径不通' : (problem.empty ? '空线路' : '正常')}</span>
      ${linePaused(line) ? '<span class="tp-tag warn">已暂停运营</span>' : ''}`;
    box.appendChild(tags);

    const info = util.el('div', 'tp-item-sub');
    info.innerHTML = `单程 ${line.travelSeconds ? util.esc(fmtDur(line.travelSeconds)) : '—'} · 日客流约 ${util.fmt(line.dailyTrips || 0)} 人次`
      // ⚠ 只显示"站点覆盖人口"：本作没有岗位系统（服务端默认也不算岗位），
      //    而客流本来就只看人口 —— 见 server/population.js 的文件头第 1 条。
      + ` · 站点覆盖合计 ${util.fmt(line.popTotal || 0)} 人`
      + (line.pathError ? ` · <span class="warn">${util.esc(shortText(line.pathError, 80))}</span>` : '');
    box.appendChild(info);

    // 班次摘要 + 下一班：线路列表、详情头部、下面的班次编辑器口径完全一致
    const sched = util.el('div', 'tp-item-sub');
    sched.innerHTML = `班次：${util.esc(lineScheduleSummary(line))}`;
    box.appendChild(sched);

    // 模式（类型）：改类型 = 按新制式重建路径
    if (t && typeof t.lineKindSelect === 'function') {
      const kindRow = t.lineKindSelect(line);
      if (kindRow) box.appendChild(kindRow);
    }
    // 配色：唯一的颜色入口（预设色 + #rrggbb）
    const colors = colorPicker(line);
    if (colors) box.appendChild(colors);
    return box;
  }

  function stopsSection(ctx, line) {
    const box = util.el('div', 'lm-sec');
    const rowsInfo = stopRows(line);
    const head = util.el('div', 'lm-sec-head');
    head.appendChild(util.el('div', 'lm-sec-title', `站点（${(line.stops || []).length} 站）`));
    const actions = util.el('div', 'lm-actions');
    if (canEdit(line)) {
      actions.appendChild(button('opt-btn', '＋ 加站', '点左侧车站列表里的站或地图上的车站，加到末尾', () => addStop(line)));
      actions.appendChild(button('opt-btn', '⟳ 重算路径', '按当前站点顺序重新沿路网算一遍路径', () => rebuildLine(ctx, line)));
    }
    head.appendChild(actions);
    box.appendChild(head);

    if (!(line.stops || []).length) {
      box.appendChild(util.el('div', 'empty-hint small', '这条线路还没有站点：点上面的「＋ 加站」，然后点车站。'));
      return box;
    }

    const table = util.el('table', 'lm-table');
    table.innerHTML = '<thead><tr><th>#</th><th>站名</th><th>相邻间距</th><th>累计里程</th><th>单程时间</th><th>操作</th></tr></thead>';
    const tbody = util.el('tbody');
    for (const r of rowsInfo.rows) {
      const tr = util.el('tr');
      const cells = [
        ['num', String(r.index + 1)],
        ['name', util.esc(r.name) + (r.missing ? ' <span class="warn">（车站已不存在）</span>' : '')],
        ['num', r.index === 0 ? '—' : (r.seg == null ? '—' : fmtMeters(r.seg))],
        ['num', r.index === 0 ? '0 米' : util.esc(util.fmtLength(r.cum))],
        ['num', r.secs == null ? '—' : (r.index === 0 ? '0 秒' : (rowsInfo.approx ? '≈' : '') + util.esc(fmtDur(r.secs)))],
      ];
      for (const [cls, html] of cells) {
        const td = util.el('td', cls, html);
        tr.appendChild(td);
      }
      const ops = util.el('td');
      const wrap = util.el('div', 'lm-actions');
      if (canEdit(line)) {
        const up = button('mini lm-icon', '↑', '上移一站', () => moveStop(ctx, line, r.index, -1));
        up.disabled = r.index === 0;
        const down = button('mini lm-icon', '↓', '下移一站', () => moveStop(ctx, line, r.index, 1));
        down.disabled = r.index === rowsInfo.rows.length - 1;
        const del = button('mini lm-icon danger', '删站', '把这一站从线路里删掉', () => removeStopAt(ctx, line, r.index));
        wrap.appendChild(up);
        wrap.appendChild(down);
        wrap.appendChild(del);
      } else {
        wrap.appendChild(util.el('span', 'lm-note', '只读'));
      }
      ops.appendChild(wrap);
      tr.appendChild(ops);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);

    const note = '相邻间距与累计里程来自服务端沿路网算出的站间里程；单程时间按里程占比折算，只作参考。'
      + (rowsInfo.approx ? '（这条线路的部分站间里程是直线距离估算，重算路径后会变准）' : '');
    box.appendChild(util.el('div', 'lm-note', note));
    return box;
  }

  /* ------------------------------ 运营控制（暂停 / 恢复运营 · 转移归属） ------------------------------ */

  /**
   * 运营控制：**一键暂停 / 恢复运营**（transit op line.setService）与**转移归属**（transit op line.transfer）。
   * 排版只留三行（状态 / 运营 / 归属），长说明全收进右上角的「?」——点开或悬停才看，
   * 免得把详情区堆成一屏字。
   */
  function opsSection(ctx, line) {
    const t = transit();
    const box = util.el('div', 'lm-sec');
    const paused = linePaused(line);
    const lockBy = (t && typeof t.elemLockBy === 'function') ? t.elemLockBy('line', line.id) : null;
    const editable = canEdit(line) && !lockBy;
    const running = runningVehicleCount(line);
    const fleet = lineVehicles(line).length;
    const svc = (line && line.service) || {};
    const lockHint = lockBy ? (typeof t.lockBusyText === 'function' ? t.lockBusyText(lockBy) : `${lockBy} 正在编辑这个元素，请稍后再试`)
      : '别家公司也无所谓：协作编辑下谁都能暂停 / 恢复运营与转移归属，只有元素锁才拦';

    const head = util.el('div', 'lm-sec-head');
    head.appendChild(util.el('div', 'lm-sec-title',
      `运营控制 ${paused ? '<span class="lm-tag warn">已暂停运营</span>' : '<span class="lm-tag ok">正常运营</span>'}`));
    const acts = util.el('div', 'lm-actions');
    acts.appendChild(helpChip([
      '暂停运营（line.setService, running:false）：只挡新的发车，不打断已经在跑的那一趟 ——',
      `已经在路上的车会把这一趟跑完（含回到首站）再收车；不删车、不藏车、不瞬移；线上 ${fleet} 辆车都还在。`,
      '站台上等车的人一个不动（继续按耐心规则等）。恢复运营（running:true）会按班次表重新排"现在之后的下一班"。',
      '',
      '转移归属（line.transfer）：把线路转到另一家公司名下（可以是别人家的公司）；',
      '勾「连车辆一起转」时，现在派在这条线上的车跟着换东家；不勾就只转线路（车照样能跑这条线）。',
      '站台上等这条线的人会跟着搬到新公司名下（一个不少，等待计时继续走）。两步都可以撤销。',
    ].join('\n')));
    head.appendChild(acts);
    box.appendChild(head);

    // 第一行：现在的运营状态（暂停时把"在跑的 N 辆会跑完当前趟"说清楚）
    const stateRow = util.el('div', 'lm-op-row');
    stateRow.appendChild(util.el('span', 'lm-op-label', '状态'));
    const stateText = paused
      ? `已暂停运营：不会再有新车发出；在跑的 ${running} 辆车会跑完当前趟再收车`
      : (svc.noServiceNow ? (svc.note || '现在没有车在按班次跑') : `正在运营：线上 ${fleet} 辆车`);
    stateRow.appendChild(util.el('span', 'lm-op-text' + (paused ? ' warn' : ''), util.esc(stateText)));
    box.appendChild(stateRow);

    // 第二行：暂停 / 恢复
    const runRow = util.el('div', 'lm-op-row');
    runRow.appendChild(util.el('span', 'lm-op-label', '运营'));
    const svcBtn = button('opt-btn', paused ? '▶ 恢复运营' : '⏸ 暂停运营',
      paused
        ? '恢复运营：按班次表重新排"现在之后的下一班"，之后照常发车（可撤销）'
        : `暂停运营：不再发新车；已经在跑的 ${running} 辆车会跑完当前趟再收车，站台上等车的人一个不动（可撤销）`,
      () => toggleService(ctx, line));
    if (!editable) { svcBtn.disabled = true; svcBtn.title = lockHint; }
    svcBtn.classList.add(paused ? 'lm-op-resume' : 'lm-op-pause');
    runRow.appendChild(svcBtn);
    runRow.appendChild(util.el('span', 'lm-op-hint',
      paused ? `在跑的 ${running} 辆会跑完当前趟` : '暂停只挡新车，不打断已经在跑的那一趟'));
    box.appendChild(runRow);

    // 第三行：转移归属（选目标公司 + 是否连车辆一起转）
    const ownRow = util.el('div', 'lm-op-row');
    ownRow.appendChild(util.el('span', 'lm-op-label', '归属'));
    const sel = util.el('select', 'tp-select small');
    sel.title = '把这条线路转到哪家公司名下（可以是别人家的公司）';
    const selfOpt = util.el('option', null, `当前：${(companyById(line.companyId) || {}).name || '未知公司'}`);
    selfOpt.value = '';
    sel.appendChild(selfOpt);
    for (const c of allCompanies()) {
      if (Number(c.id) === Number(line.companyId)) continue;
      const o = util.el('option', null,
        `${c.name}${String(c.owner) === '__system__' ? '（系统公司）' : (myCompanyIds().has(c.id) ? '' : '（别家公司）')}`);
      o.value = String(c.id);
      sel.appendChild(o);
    }
    sel.disabled = !editable;
    ownRow.appendChild(sel);
    const chk = util.el('input');
    chk.type = 'checkbox';
    chk.title = '勾上：现在派在这条线上的车一起转到新公司名下；不勾：只转线路（车照样能跑这条线）';
    chk.disabled = !editable;
    const chkLab = util.el('label', 'lm-check');
    chkLab.title = chk.title;
    chkLab.appendChild(chk);
    chkLab.appendChild(util.el('span', null, `连车辆一起转（${fleet} 辆）`));
    ownRow.appendChild(chkLab);
    const goBtn = button('opt-btn', '↗ 转移归属', '把这条线路转到下拉里选中的公司名下（可撤销）',
      () => transferLineTo(ctx, line, sel.value, chk.checked));
    if (!editable) { goBtn.disabled = true; goBtn.title = lockHint; }
    ownRow.appendChild(goBtn);
    box.appendChild(ownRow);

    box.appendChild(util.el('div', 'lm-note lm-help-note hidden',
      '长说明：「暂停运营」只挡新的发车，不打断已经在跑的那一趟（车会跑完当前趟再收车，车一辆不删、不瞬移）；'
      + '站台上等车的人一个不动。「转移归属」可以把线路转到任何一家已存在的公司名下（含别人家的公司），'
      + '勾上「连车辆一起转」时线上车辆跟着换东家；两种操作都是一步可撤销的线路 op。'));
    return box;
  }

  /* ------------------------------ 班次（发车计划：流水班 / 定班车） ------------------------------ */

  /** 没配过班次的线路，表单从这个默认值起步 */
  const SCHEDULE_DEFAULT = { headwayMin: 10, first: '06:00', last: '22:30' };
  const SCHEDULE_HEADWAY_MIN = 1;      // 发车间隔下限（分钟）
  const SCHEDULE_HEADWAY_MAX = 180;    // 发车间隔上限（分钟）
  const SCHEDULE_MAX_TRIPS = 200;      // 定班车最多排多少班

  /**
   * 本机记住的「每个班次指定车辆」（lineId -> Map(runIndex -> vehicleId)）。
   * 为什么需要它：服务端 linePublic().runs 只回**接下来 5 班**，而 schedule.assignments 是整表替换的
   * （line.update 的 schedule 字段说什么就是什么）。没有这份记忆的话，玩家只改第 1 班的指定车，
   * 保存时就会把看不到的那些班次的指定车一起冲掉。这一份只活在本机当前会话里，不当权限用。
   */
  const assignMemory = new Map();

  /**
   * 这条线现在的「每个班次指定车辆」：runIndex -> vehicleId。
   * 以服务端为准：runs[].pinnedVehicleId 就是玩家填进去的那辆车（哪怕那一班最后没满足、
   * 退回了自动轮转，pinnedVehicleId 仍然是"填了什么"）；本机记忆里那些"看不到的班次"照旧带上。
   */
  function assignmentsOf(line) {
    const out = new Map();
    const mem = assignMemory.get(Number(line && line.id));
    if (mem) for (const [k, v] of mem) out.set(Number(k), Number(v));
    for (const r of ((line && Array.isArray(line.runs)) ? line.runs : [])) {
      if (!r || r.index == null) continue;
      const idx = Number(r.index);
      const pinned = (r.pinnedVehicleId == null || !Number(r.pinnedVehicleId)) ? null : Number(r.pinnedVehicleId);
      if (pinned) out.set(idx, pinned);
      else out.delete(idx);        // 服务端说这一班没指定车（玩家清掉了 / 车已不在线上）→ 以它为准
    }
    return out;
  }

  /** 保存成功后把这份指定表记到本机（下一次渲染 / 只改一班时都不会把别的班次冲掉） */
  function rememberAssignments(line, map) {
    const id = Number(line && line.id);
    if (!Number.isFinite(id)) return;
    const copy = new Map();
    for (const [k, v] of (map || new Map())) {
      const idx = Number(k);
      const vid = Number(v);
      if (Number.isFinite(idx) && Number.isFinite(vid) && vid) copy.set(idx, vid);
    }
    if (copy.size) assignMemory.set(id, copy);
    else assignMemory.delete(id);
  }

  /** 把 state.assignments（普通对象）整理成服务端认的数组：[{ runIndex, vehicleId }, …] */
  function assignmentList(state) {
    const out = [];
    for (const [k, v] of Object.entries((state && state.assignments) || {})) {
      const runIndex = Number(k);
      const vehicleId = Number(v);
      if (Number.isFinite(runIndex) && runIndex >= 0 && Number.isFinite(vehicleId) && vehicleId) {
        out.push({ runIndex, vehicleId });
      }
    }
    out.sort((a, b) => a.runIndex - b.runIndex);
    return out;
  }

  /** 'HH:MM' 归一化：06:00 / 6:00 / 6：00 / 600 / 6 都认，认不出返回 null */
  function normTime(v) {
    const s = String(v == null ? '' : v).trim().replace(/：/g, ':');
    if (!s) return null;
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/) || s.match(/^(\d{1,2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = m[2] === undefined ? 0 : Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }

  /** 发车时刻表：数组 / "06:30, 07:00" / "06:30 07:00" / 换行分隔都能吃 */
  function parseTimetable(v) {
    if (Array.isArray(v)) return v.map(normTime).filter(Boolean);
    return String(v == null ? '' : v).split(/[^0-9:：]+/).map(normTime).filter(Boolean);
  }

  /**
   * 线路当前的班次状态。
   * **服务端口径优先**：line.schedule = { mode, headwaySec, firstSec, lastSec, firstTime, lastTime,
   * departuresPerDay, vehicleHeadwaySec, nextDepartures, note }（见 server/transit.js 的 scheduleInfo）。
   * mode: 'free'（自由发车，车一直跑）/ 'headway'（流水班）/ 'timetable'（定班车）。
   * 服务端没回 schedule 时才退回读老接口的扁平字段（headwaySeconds / firstDeparture / timetable）。
   */
  function lineSchedule(line) {
    const srv = (line && line.schedule && typeof line.schedule === 'object') ? line.schedule : null;
    if (srv && srv.mode && srv.mode !== 'free') {
      const mode = srv.mode === 'timetable' ? 'timetable' : 'headway';
      const next = Array.isArray(srv.nextDepartures) ? srv.nextDepartures.filter(Boolean) : [];
      return {
        mode,
        server: true,
        // 定班车的**完整**时刻表服务端只回"接下来几班"，所以这里不拿它当完整表用（partial=true）
        timetable: [],
        timetableNext: next,
        partial: next.length > 0,
        headwaySeconds: Number(srv.headwaySec) || 0,
        firstDeparture: normTime(srv.firstTime),
        lastDeparture: normTime(srv.lastTime),
        departuresPerDay: Number(srv.departuresPerDay) || 0,
        note: String(srv.note || ''),
        configured: true,
      };
    }
    const timetable = parseTimetable(line && line.timetable);
    const headway = Number(line && line.headwaySeconds);
    const first = normTime(line && line.firstDeparture);
    const last = normTime(line && line.lastDeparture);
    const hasHeadway = Number.isFinite(headway) && headway > 0;
    return {
      mode: timetable.length ? 'timetable' : (hasHeadway ? 'headway' : 'free'),
      server: !!srv,
      timetable,
      timetableNext: [],
      partial: false,
      headwaySeconds: hasHeadway ? Math.round(headway) : 0,
      firstDeparture: first,
      lastDeparture: last,
      departuresPerDay: 0,
      note: '',
      configured: !!(timetable.length || hasHeadway || first || last),
    };
  }

  /** 班次摘要（区块右上角那行小字；交通面板的 lineScheduleSummary 也用它） */
  function scheduleText(line) {
    const s = lineSchedule(line);
    if (s.server) {
      if (s.mode === 'timetable') {
        const n = s.departuresPerDay ? `${s.departuresPerDay} 班/日` : '定班车';
        const span = (s.firstDeparture || s.lastDeparture)
          ? ` · 首 ${s.firstDeparture || '—'} 末 ${s.lastDeparture || '—'}` : '';
        return `定班车 · ${n}${span}`;
      }
      const mins = Math.max(1, Math.round(s.headwaySeconds / 60));
      const span = (s.firstDeparture || s.lastDeparture)
        ? ` · ${s.firstDeparture || '—'}–${s.lastDeparture || '—'}` : '';
      const per = s.departuresPerDay ? ` · ${s.departuresPerDay} 班/日` : '';
      return `流水班 · 每 ${mins} 分钟一班${span}${per}`;
    }
    if (s.timetable.length) {
      return `定班车 · ${s.timetable.length} 班/日 · 首 ${s.timetable[0]} 末 ${s.timetable[s.timetable.length - 1]}`;
    }
    if (!s.configured) return '自由发车（没有班次表：车一直在线路上跑）';
    const mins = Math.max(1, Math.round(s.headwaySeconds / 60));
    const span = (s.firstDeparture || s.lastDeparture) ? ` · ${s.firstDeparture || '—'}–${s.lastDeparture || '—'}` : '';
    return `流水班 · 每 ${mins} 分钟一班${span}`;
  }

  /* ------------------------------ 营运信息（下一站 / 预计到站 / 班次准点） ------------------------------ */

  /**
   * 这些口径全部由交通面板（transit.js）提供，这里只做"拿不到就别显示"的兜底：
   *   Transit.lineScheduleSummary(line)     班次摘要 + 下一班（服务端有 runs 就用 runs）
   *   Transit.nextDepartureText(line)       线路的下一班发车
   *   Transit.vehicleRunInfo(vehicle, live) 一辆车的营运信息（下一站 / 预计到站 / 班次偏差）
   */
  function lineScheduleSummary(line) {
    const t = transit();
    if (t && typeof t.lineScheduleSummary === 'function') {
      try { return String(t.lineScheduleSummary(line) || ''); } catch { /* 落到本地摘要 */ }
    }
    return scheduleText(line);
  }

  function lineNextDeparture(line) {
    const t = transit();
    if (t && typeof t.nextDepartureText === 'function') {
      try { return String(t.nextDepartureText(line) || ''); } catch { return ''; }
    }
    return '';
  }

  /** 一辆车的营运信息（交通面板没就绪时返回 null，界面显示 '—'） */
  function vehicleRun(v, live) {
    const t = transit();
    if (!t || typeof t.vehicleRunInfo !== 'function') return null;
    try { return t.vehicleRunInfo(v, live); } catch { return null; }
  }

  /** 下一站（没有就 '—'） */
  const runNextStop = (run) => (run && run.nextStop) ? run.nextStop : '—';
  /** 预计到站（没有就 '—'） */
  const runEta = (run) => (run && run.etaText) ? run.etaText : '—';

  /**
   * 班次那一格：下一班发车 + 准点情况，晚点用红字（现在没有班次时直接说明）。
   * 只用交通面板给的文本，自己不重算，两个界面永远是同一个口径。
   */
  function runScheduleCell(run) {
    if (!run) return '—';
    if (run.noService) return '<span class="tp-lag">现在没有班次</span>';
    const lag = `<span class="tp-lag${run.late ? ' late' : ''}">${util.esc(run.lagText || '—')}</span>`;
    return run.departure ? `${util.esc(run.departure)} 发车 · ${lag}` : lag;
  }

  /** 按 首班 / 末班 / 间隔 排一份时刻表（定班车里的「按间隔生成」用） */
  function buildTimetable(first, last, headwayMin) {
    const f = normTime(first);
    const l = normTime(last);
    const step = Math.max(1, Math.round(Number(headwayMin) || 0));
    if (!f || !l || !step) return [];
    const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const a = toMin(f);
    let b = toMin(l);
    if (b < a) b += 24 * 60;      // 末班过了午夜（例如 00:30）
    const out = [];
    for (let m = a; m <= b && out.length < SCHEDULE_MAX_TRIPS; m += step) {
      out.push(String(Math.floor((m % 1440) / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
    }
    return out;
  }

  /**
   * 保存班次：line.update { id, headwaySeconds, firstDeparture, lastDeparture, timetable }
   *   流水班：headwaySeconds = 间隔秒数，timetable 传空数组（空 = 流水班）
   *   定班车：headwaySeconds = 0，timetable = ['HH:MM', …]（首班 / 末班取第一个和最后一个）
   */
  /**
   * 保存班次。**服务端口径**（server/transit.js 的 updateLine → parseSchedule）：line.update 的
   *   schedule 字段必须是对象：
   *     流水班   { mode: 'headway', headwaySec, first, last }        （first/last 是 'HH:MM' 或当天秒数）
   *     定班车   { mode: 'timetable', times: ['07:00', '08:30'…] }
   *     自由发车 { mode: 'free' } 或 schedule: null
   * 两张表都可以再带 #4 的「每个班次指定车辆」：assignments: [{ runIndex, vehicleId }, …]，
   * runIndex 就是 linePublic().runs[].index（自由发车没有班次表，服务端会把 assignments 丢掉）。
   * 只有 schedule 里的字段会被服务端认；以前这里发的是 headwaySeconds / firstDeparture / timetable 这些
   * 顶层字段，updateLine 会整个忽略（班次根本存不进去），所以这里改成嵌套的 schedule 对象。
   */
  function saveSchedule(ctx, line, state) {
    const t = transit();
    if (!t || typeof t.op !== 'function') { toast('交通系统还没准备好', 'warn'); return; }
    let payload;
    if (state.mode === 'free') {
      payload = { schedule: { mode: 'free' } };
    } else if (state.mode === 'timetable') {
      const tt = parseTimetable(state.timetableText);
      if (!tt.length) { toast('定班车至少要有一个发车时刻，例如 06:30（多个用逗号或换行分开）', 'warn', 5000); return; }
      payload = { schedule: { mode: 'timetable', times: tt } };
    } else {
      const mins = Number(state.headwayMin);
      if (!Number.isFinite(mins) || mins < SCHEDULE_HEADWAY_MIN || mins > SCHEDULE_HEADWAY_MAX) {
        toast(`发车间隔要填 ${SCHEDULE_HEADWAY_MIN} ~ ${SCHEDULE_HEADWAY_MAX} 分钟`, 'warn', 4500);
        return;
      }
      const first = normTime(state.first);
      const last = normTime(state.last);
      if (!first || !last) { toast('首班 / 末班时间要写成 HH:MM（例如 06:00）', 'warn', 4500); return; }
      if (normTime(last) < normTime(first)) { toast('末班时间不能早于首班时间', 'warn', 4500); return; }
      payload = { schedule: { mode: 'headway', headwaySec: Math.max(60, Math.round(mins * 60)), first, last } };
    }
    // 每个班次指定车辆（#4）：和班次表放在同一份 schedule 里一起下发
    const assigns = assignmentList(state);
    if (assigns.length && payload.schedule.mode !== 'free') payload.schedule.assignments = assigns;
    t.op(Object.assign({ k: 'line.update', id: line.id }, payload))
      .then((res) => {
        // 服务端回话里的 line.schedule 是权威值（含 departuresPerDay / nextDepartures / assignmentsMissed），用它回填
        const saved = (res && res.result && res.result.line) || null;
        if (saved) Object.assign(line, saved);
        else if (payload.schedule.mode === 'free') delete line.schedule;
        rememberAssignments(line, assigns.length && payload.schedule.mode !== 'free'
          ? new Map(assigns.map((a) => [a.runIndex, a.vehicleId])) : new Map());
        if (ctx && ctx.schedDraft && Number(ctx.schedDraft.lineId) === Number(line.id)) ctx.schedDraft = null;
        const missed = Number((line.schedule && line.schedule.assignmentsMissed) || 0);
        toast(`班次已保存：${scheduleText(line)}`
          + (assigns.length ? ` · 指定了 ${assigns.length} 班的车` : '')
          + (missed ? `（${missed} 班没满足，已退回自动轮转）` : ''), missed ? 'warn' : 'success', 5000);
        renderCtx(ctx);
        if (typeof t.renderPanelSoon === 'function') t.renderPanelSoon();
      })
      .catch((err) => toast((err && err.message) || '班次保存失败', 'error', 5000));
  }

  /**
   * 「每个班次的车」（#4 schedule.assignments）：一班一行 —— 发车时刻 + 车辆下拉（默认「自动轮转」）。
   *
   * 行来自服务端 linePublic().runs（**接下来 5 班**，runs[].index 就是填 assignments 用的那个下标）；
   * 下拉里只列**这条线上的车**：服务端派车时只认它们，指定了别处的车那一班会被记进 assignmentsMissed
   * 并退回自动轮转（那一行会挂一枚「指定车忙」的提示）。
   * state.assignments 是 runIndex -> vehicleId 的普通对象（随草稿一起活过数据帧重建）；
   * 只读（别人的线路 / 被别人锁着）时下拉禁用，但仍然把服务端当前的指定情况显示出来。
   */
  function runsAssignBlock(line, state, editable, keepFn) {
    const box = util.el('div', 'lm-runs');
    const runs = (line && Array.isArray(line.runs)) ? line.runs : [];
    const sched = (line && line.schedule) || {};
    const requested = Number(sched.assignmentsRequested) || 0;
    const missed = Number(sched.assignmentsMissed) || 0;
    const fleet = lineVehicles(line);
    const freeMode = !sched.mode || sched.mode === 'free';

    const head = util.el('div', 'lm-sec-head');
    head.appendChild(util.el('div', 'lm-sec-title', '每个班次的车 <small>'
      + (runs.length ? `接下来 ${runs.length} 班` : '还没有班次明细')
      + (requested ? ` · 已指定 ${requested} 班` : '')
      + (missed ? ` · <span class="warn">${missed} 班没满足</span>` : '')
      + '</small>'));
    const acts = util.el('div', 'lm-actions');
    acts.appendChild(helpChip([
      '默认「自动轮转」：线上的车按顺序一轮一轮地发车（第 j 班给第 (j % 车数) 辆车）。',
      '想钉死某一班就点它那一行的下拉，选一辆车（只会列出这条线上的车）——',
      '保存后服务端把这张指定表和班次表一起记住，到点就把那一班交给指定的车。',
      '',
      '指定的车在别处忙 / 已经被删：那一班不空等，直接退回自动轮转，',
      '并把没满足的班次数报成 assignmentsMissed（这一行会出现「指定车忙 · 已退回轮转」的提示）。',
      '服务端只回接下来 5 班，所以这里列的是最近这几班；改其中一班不会动到别的班次。',
    ].join('\n')));
    head.appendChild(acts);
    box.appendChild(head);

    if (!runs.length) {
      box.appendChild(util.el('div', 'lm-note', freeMode
        ? '自由发车没有班次表，也就没有"每个班次指定车辆"这回事：线上的车一直跑。改成「流水班」或「定班车」并保存后，这里会列出接下来的班次。'
        : '服务端还没算出今天的班次明细（等时钟走到运营时段 / 先给这条线加车），这里暂时没有可指定的班次。'));
      return box;
    }
    for (const r of runs) {
      if (!r || r.index == null) continue;
      const idx = Number(r.index);
      const row = util.el('div', 'lm-run-row');
      row.appendChild(util.el('span', 'lm-run-time', `#${idx + 1} · ${util.esc(r.departure || '—')}`));
      const sel = util.el('select', 'tp-select small lm-run-sel');
      const autoOpt = util.el('option', null, '自动轮转');
      autoOpt.value = '';
      sel.appendChild(autoOpt);
      for (const v of fleet) {
        const o = util.el('option', null, `${v.name}（${util.esc(fmtMeters(v.lengthM))}）`);
        o.value = String(v.id);
        sel.appendChild(o);
      }
      const want = state ? Number(state.assignments[idx] || 0) : (Number(r.pinnedVehicleId) || 0);
      if (want && !fleet.some((v) => Number(v.id) === want)) {
        // 指定的车已经不在这条线上了（被撤下 / 被删）：照样显示出来，保存时由服务端判定
        const gone = util.el('option', null, `${(r.pinnedVehicleName || ('#' + want))}（已不在线上）`);
        gone.value = String(want);
        sel.appendChild(gone);
      }
      sel.value = want ? String(want) : '';
      sel.disabled = !editable || !fleet.length;
      sel.title = !fleet.length ? '这条线上还没有车：先把车指派到这条线路，才能指定某一班由谁开'
        : (editable ? '指定这一班由哪辆车开（默认「自动轮转」）；保存班次时一起写回服务端' : '这条线正被别人编辑（元素锁）：只能看');
      sel.onchange = () => {
        if (!state) return;
        if (sel.value) state.assignments[idx] = Number(sel.value);
        else delete state.assignments[idx];
        if (typeof keepFn === 'function') keepFn();
      };
      row.appendChild(sel);
      if (r.assignmentMissed) {
        row.appendChild(util.el('span', 'lm-run-miss',
          `指定车忙 · 已退回轮转${r.vehicleName ? `（这一班实际是 ${util.esc(r.vehicleName)}）` : ''}`));
      } else if (r.vehicleName) {
        row.appendChild(util.el('span', 'lm-run-hint', `实际 ${util.esc(r.vehicleName)}`));
      }
      box.appendChild(row);
    }
    if (missed) {
      box.appendChild(util.el('div', 'lm-note warn',
        `${missed} 班的指定车没满足（在别处忙 / 已经被删）：这些班已经退回自动轮转，不会空等；`
        + '换一辆线上的车再保存，或者让那辆车先回到这条线上。'));
    }
    return box;
  }

  /** 班次编辑器：流水班（间隔 + 首末班）或定班车（时刻列表），保存走 line.update */
  function scheduleSection(ctx, line) {
    const box = util.el('div', 'lm-sec');
    const cur = lineSchedule(line);
    const editable = canEdit(line);
    const head = util.el('div', 'lm-sec-head');
    head.appendChild(util.el('div', 'lm-sec-title', '班次（发车计划）'));
    const actions = util.el('div', 'lm-actions');
    actions.appendChild(util.el('span', 'lm-sched-now', util.esc(scheduleText(line))));
    head.appendChild(actions);
    box.appendChild(head);

    // 班次摘要 + 下一班（服务端有 runs 就用 runs 里的真实发车时刻）
    const runs = (line && Array.isArray(line.runs)) ? line.runs : [];
    const nextDep = lineNextDeparture(line);
    const nowRow = util.el('div', 'tp-item-sub');
    nowRow.innerHTML = `班次：${util.esc(lineScheduleSummary(line))}`
      + (runs.length ? ` · 今日 ${runs.length} 班` : '')
      + (nextDep ? ` · <b>下一班 ${util.esc(nextDep)}</b>` : '');
    box.appendChild(nowRow);

    if (!editable) {
      const reason = lockReason(line);
      box.appendChild(util.el('div', 'lm-note', reason
        ? `🔒 ${reason}：班次现在只能看，不能改。`
        : '班次现在只能看（这条线正被别人编辑）。'));
      // 只读也把"每个班次的车"列出来（下拉禁用），一眼能看出这班车是谁在开、哪一班没满足
      box.appendChild(runsAssignBlock(line, null, false, null));
      return box;
    }

    // 服务端数据帧每 600ms 就会重建这块详情：没保存的改动先存在 ctx.schedDraft 里，
    // 重建时再读回来，免得玩家刚排好的时刻表被一次刷新冲掉。
    const draft = (ctx.schedDraft && Number(ctx.schedDraft.lineId) === Number(line.id)) ? ctx.schedDraft : null;
    const state = draft ? Object.assign({}, draft)
      : {
        // 模式以服务端口径为准（line.schedule.mode）；定班车的完整时刻表服务端只回"接下来几班"，
        // 所以 partial 时**不预填**文本框 —— 拿它保存会把班次表砍成只剩那几班。
        mode: cur.mode === 'timetable' ? 'timetable' : (cur.mode === 'free' ? 'free' : 'headway'),
        headwayMin: cur.headwaySeconds ? Math.max(1, Math.round(cur.headwaySeconds / 60)) : SCHEDULE_DEFAULT.headwayMin,
        first: cur.firstDeparture || SCHEDULE_DEFAULT.first,
        last: cur.lastDeparture || SCHEDULE_DEFAULT.last,
        timetableText: cur.partial ? '' : (cur.timetable.length ? cur.timetable.join(', ') : ''),
        genFirst: cur.firstDeparture || SCHEDULE_DEFAULT.first,
        genLast: cur.lastDeparture || SCHEDULE_DEFAULT.last,
        // 每个班次指定的车（runIndex -> vehicleId）：服务端 runs[].pinnedVehicleId + 本机记忆
        assignments: (() => {
          const out = {};
          for (const [idx, vid] of assignmentsOf(line)) out[idx] = vid;
          return out;
        })(),
      };
    state.lineId = Number(line.id);
    if (!state.assignments || typeof state.assignments !== 'object') state.assignments = {};

    /** 记一份草稿（每次输入 / 切模式 / 用快捷生成都调一次） */
    function keep() { if (ctx) ctx.schedDraft = Object.assign({}, state); }

    const modeRow = util.el('div', 'opt-chips');
    const chips = {};
    for (const [id, label, title] of [
      ['headway', '流水班', '固定发车间隔：首班到末班之间按间隔发车，适合公交与地铁'],
      ['timetable', '定班车', '固定发车时刻：一班一班列出来，适合班次不多的线路'],
      ['free', '自由发车', '不排班次：车一直在线路上跑（服务端 schedule = null）'],
    ]) {
      const chip = util.el('button', 'chip' + (state.mode === id ? ' active' : ''), label);
      chip.title = title;
      chips[id] = chip;
      chip.onclick = () => {
        if (state.mode === id) return;
        if (state.mode === 'timetable' && ttArea) state.timetableText = ttArea.value;
        state.mode = id;
        keep();
        paint();
      };
      modeRow.appendChild(chip);
    }
    box.appendChild(modeRow);
    const body = util.el('div', 'lm-sched');
    box.appendChild(body);

    let ttArea = null;
    let ttCount = null;

    /** 时间框：改一下就记进 state + 草稿（切模式 / 重建都不会把填的东西弄丢） */
    function timeInput(value, onPick) {
      const el = util.el('input');
      el.type = 'time';
      el.value = value;
      el.oninput = () => { onPick(el.value); keep(); };
      return el;
    }

    function paint() {
      keep();   // 每一次重画都先把当前输入存成草稿
      chips.headway.classList.toggle('active', state.mode === 'headway');
      chips.timetable.classList.toggle('active', state.mode === 'timetable');
      chips.free.classList.toggle('active', state.mode === 'free');
      body.innerHTML = '';
      ttArea = null;
      ttCount = null;

      if (state.mode === 'free') {
        body.appendChild(util.el('div', 'lm-note',
          '自由发车：这条线不排班次，线上的车一直跑（到终点掉头接着跑）。'
          + '服务端会把 schedule 清空；想回到按时刻表发车就切回「流水班」或「定班车」再保存。'));
        return;
      }

      if (state.mode === 'headway') {
        const row = util.el('div', 'lm-sched-row');
        row.appendChild(util.el('span', null, '发车间隔'));
        const hw = util.el('input');
        hw.type = 'number';
        hw.min = String(SCHEDULE_HEADWAY_MIN);
        hw.max = String(SCHEDULE_HEADWAY_MAX);
        hw.step = '1';
        hw.value = String(state.headwayMin);
        hw.title = '每多少分钟发一班车（服务端存 headwaySeconds）';
        hw.oninput = () => { state.headwayMin = hw.value; keep(); };
        row.appendChild(hw);
        row.appendChild(util.el('span', null, '分钟一班'));
        body.appendChild(row);

        const row2 = util.el('div', 'lm-sched-row');
        row2.appendChild(util.el('span', null, '首班'));
        row2.appendChild(timeInput(state.first, (v) => { state.first = v; }));
        row2.appendChild(util.el('span', null, '末班'));
        row2.appendChild(timeInput(state.last, (v) => { state.last = v; }));
        row2.appendChild(button('mini', '按这个间隔排出时刻表', '用「首班 / 末班 / 间隔」生成一份时刻表，切到「定班车」直接改', () => {
          const tt = buildTimetable(state.first, state.last, state.headwayMin);
          if (!tt.length) { toast('先把首班 / 末班时间填好（HH:MM）', 'warn', 4000); return; }
          state.timetableText = tt.join(', ');
          state.genFirst = normTime(state.first) || state.genFirst;
          state.genLast = normTime(state.last) || state.genLast;
          state.mode = 'timetable';
          paint();
          toast(`已按每 ${state.headwayMin} 分钟排出 ${tt.length} 班（在「定班车」里可以直接改）`, 'success', 5000);
        }));
        body.appendChild(row2);
        body.appendChild(util.el('div', 'lm-note',
          '流水班：车辆按固定间隔发车，服务端记住 headwaySeconds / firstDeparture / lastDeparture。'));
      } else {
        ttArea = util.el('textarea', 'lm-sched-tt');
        ttArea.value = state.timetableText;
        ttArea.placeholder = '06:30, 07:00, 07:30 …（逗号 / 空格 / 换行都可以，最多 ' + SCHEDULE_MAX_TRIPS + ' 班）';
        ttArea.title = '一行一个发车时刻，也可以用逗号分隔';
        ttArea.oninput = () => { state.timetableText = ttArea.value; keep(); paintCount(); };
        body.appendChild(ttArea);

        const row = util.el('div', 'lm-sched-row');
        ttCount = util.el('span', 'lm-sched-count', '');
        row.appendChild(ttCount);
        row.appendChild(button('mini', '按间隔生成时刻表', '用下面的首班 / 末班 / 间隔自动填满这个列表', () => {
          const tt = buildTimetable(state.genFirst, state.genLast, state.headwayMin);
          if (!tt.length) { toast('先把下面的首班 / 末班时间填好（HH:MM）', 'warn', 4000); return; }
          state.timetableText = tt.join(', ');
          paint();
        }));
        body.appendChild(row);

        const row2 = util.el('div', 'lm-sched-row');
        row2.appendChild(util.el('span', null, '生成用：首班'));
        row2.appendChild(timeInput(state.genFirst, (v) => { state.genFirst = v; }));
        row2.appendChild(util.el('span', null, '末班'));
        row2.appendChild(timeInput(state.genLast, (v) => { state.genLast = v; }));
        row2.appendChild(util.el('span', 'lm-sched-hint', `间隔 ${state.headwayMin} 分钟（在上面的「流水班」里改）`));
        body.appendChild(row2);
        body.appendChild(util.el('div', 'lm-note',
          '定班车：一班一班列出发车时刻（保存给服务端的是 schedule.times，第一个是首班、最后一个是末班）。'
          + (cur.partial && cur.timetableNext.length
            ? ` 服务端只回传接下来几班（${cur.timetableNext.join('、')}…），完整表请用「按间隔生成」或自己填。`
            : '')));
      }
      paintCount();
    }

    function paintCount() {
      if (!ttCount) return;
      const n = parseTimetable(state.timetableText).length;
      ttCount.textContent = n ? `已识别 ${n} 个发车时刻` : '还没填发车时刻';
      ttCount.classList.toggle('warn', !n);
    }

    paint();

    // 每个班次指定车辆（#4）：一班一行 + 一个车辆下拉（默认「自动轮转」），和班次表一起保存
    box.appendChild(runsAssignBlock(line, state, true, keep));

    const saveRow = util.el('div', 'lm-actions');
    saveRow.appendChild(button('opt-btn', '💾 保存班次',
      '把班次写回线路（line.update 的 schedule 字段：{mode:"headway",headwaySec,first,last} / {mode:"timetable",times} / {mode:"free"}'
      + '，外加 assignments:[{runIndex,vehicleId}] 这张"每个班次指定车"的表）',
      () => saveSchedule(ctx, line, state)));
    saveRow.appendChild(button('mini', '↺ 还原', '放弃这次改动，恢复成服务端当前的班次', () => {
      if (ctx) ctx.schedDraft = null;
      renderCtx(ctx);
    }));
    box.appendChild(saveRow);
    return box;
  }

  function vehiclesSection(ctx, line) {
    const box = util.el('div', 'lm-sec');
    const assigned = lineVehicles(line);
    const fleet = companyVehicles(line);
    const head = util.el('div', 'lm-sec-head');
    head.appendChild(util.el('div', 'lm-sec-title', `车辆（本线 ${assigned.length} 辆 / 公司车队 ${fleet.length} 辆）`));
    const actions = util.el('div', 'lm-actions');
    if (canEdit(line)) {
      actions.appendChild(button('opt-btn', '＋ 闲置车辆全部加入', '把公司里所有闲置车辆一次性指派到这条线路', () => addIdleFleet(ctx, line)));
    }
    head.appendChild(actions);
    box.appendChild(head);

    // 已在本线的车：车长 / 定员 / 当前载客 / 满载率 / 下一站 / 预计到站 / 班次（准点）/ 状态
    if (!assigned.length) {
      box.appendChild(util.el('div', 'empty-hint small', '这条线路上还没有车：在下面的车队列表里勾选车辆，再点「加入勾选车辆」。'));
    } else {
      const table = util.el('table', 'lm-table');
      table.innerHTML = '<thead><tr><th>车辆</th><th>车长</th><th>定员</th><th>当前载客</th><th>满载率</th>'
        + '<th>下一站</th><th>预计到站</th><th>班次（准点）</th><th>状态</th></tr></thead>';
      const tbody = util.el('tbody');
      for (const v of assigned) {
        const live = liveTrain(v.id);
        const load = Number((live && live.load) || v.load || 0);
        const pct = v.capacity ? (load / v.capacity) * 100 : null;
        const run = vehicleRun(v, live);
        const tr = util.el('tr');
        tr.innerHTML = `<td class="name">${util.esc(v.name)}</td>
          <td class="num">${util.esc(fmtMeters(v.lengthM))}</td>
          <td class="num">${util.fmt(v.capacity || 0)} 人</td>
          <td class="num">${util.fmt(load)} 人</td>
          <td class="num">${pct == null ? '—' : util.esc(fmtPct(pct))}</td>
          <td class="name">${util.esc(runNextStop(run))}</td>
          <td class="num">${util.esc(runEta(run))}</td>
          <td>${runScheduleCell(run)}</td>
          <td>${util.esc(VEHICLE_STATE[(live && live.state) || v.state] || (v.lineId ? '运行中' : '闲置'))}</td>`;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      // 列变多了：窄面板（交通面板右侧详情）里给表格一条横向滚动，不然列会被挤成一团
      const wrap = util.el('div', 'lm-scroll');
      wrap.appendChild(table);
      box.appendChild(wrap);
    }

    // 车队勾选列表（加入 / 撤下都用它，不弹输入框）
    const picker = util.el('div', 'tp-picker');
    picker.appendChild(util.el('div', 'tp-picker-title', '勾选车辆后可一键加入本线或撤下（列表选择，不用记编号）：'));
    if (!fleet.length) {
      picker.appendChild(util.el('div', 'empty-hint small', '这家公司还没有车辆：先去交通面板的「车辆」分区造几辆。'));
      box.appendChild(picker);
      return box;
    }
    const sorted = fleet.slice().sort((a, b) => {
      const rank = (v) => (v.lineId === line.id ? 0 : (v.lineId ? 2 : 1));
      return rank(a) - rank(b) || a.id - b.id;
    });
    for (const v of sorted.slice(0, LIST_LIMIT)) {
      const lab = util.el('label', 'tp-check');
      const cb = util.el('input', 'tp-pick');
      cb.type = 'checkbox';
      cb.checked = ctx.picked.includes(v.id);
      cb.onchange = () => {
        const i = ctx.picked.indexOf(v.id);
        if (cb.checked && i < 0) ctx.picked.push(v.id);
        if (!cb.checked && i >= 0) ctx.picked.splice(i, 1);
        const count = picker.querySelector('.lm-picked');
        if (count) count.textContent = `已勾选 ${ctx.picked.length} 辆`;
      };
      lab.appendChild(cb);
      const where = v.lineId === line.id ? '已在本线'
        : (v.lineId ? '在别条线：' + ((lineById(v.lineId) || {}).name || '#' + v.lineId) : '闲置');
      // 在跑的车顺手报一下下一站与预计到站（点一下就知道它跑到哪儿了）
      const live = liveTrain(v.id);
      const run = vehicleRun(v, live);
      const at = run && run.nextStop && run.nextStop !== '—' ? ` · 下一站 ${run.nextStop}${run.etaText && run.etaText !== '—' ? '（' + run.etaText + '）' : ''}` : '';
      lab.appendChild(util.el('span', null,
        `${util.esc(v.name)} · ${util.esc(kindLabel(v.kind))} ${util.esc(fmtMeters(v.lengthM))} · 定员 ${util.fmt(v.capacity || 0)} 人 · ${util.esc(where)}${util.esc(at)}`));
      picker.appendChild(lab);
    }
    if (fleet.length > LIST_LIMIT) {
      picker.appendChild(util.el('div', 'lm-note', `车队里还有 ${fleet.length - LIST_LIMIT} 辆车没列出来：用交通面板的「车辆」分区按状态筛选后再批量指派。`));
    }
    const bulk = util.el('div', 'tp-bulk');
    if (canEdit(line)) {
      bulk.appendChild(button('opt-btn', '＋ 加入勾选车辆', '把勾选的车辆指派到这条线路', () => assignPicked(ctx, line, line.id)));
      bulk.appendChild(button('opt-btn danger', '－ 撤下勾选车辆', '把勾选的车辆从线路上撤下来（变成闲置）', () => assignPicked(ctx, line, null)));
    }
    const pickedCount = util.el('span', 'tp-picker-title lm-picked', `已勾选 ${ctx.picked.length} 辆`);
    pickedCount.title = '勾选数量';
    bulk.appendChild(pickedCount);
    picker.appendChild(bulk);
    box.appendChild(picker);
    return box;
  }

  function statBlock(title, b) {
    const box = util.el('div', 'tp-block');
    box.appendChild(util.el('div', 'tp-row', `<b>${util.esc(title)}</b>`));
    box.appendChild(kvRow('运送人次', b.riders == null ? '—' : util.fmt(b.riders) + ' 人次'));
    box.appendChild(kvRow('车公里', b.vehicleKm == null ? '—' : util.fmt(b.vehicleKm) + ' 车公里'));
    box.appendChild(kvRow('平均满载率', b.avgLoad == null ? '—' : util.esc(fmtPct(b.avgLoad))));
    box.appendChild(kvRow('平均等待时间', b.avgWait == null ? '—' : util.esc(fmtDur(b.avgWait))));
    return box;
  }

  /** 把客流数据画进指定容器（异步取回后就地重绘，不动别处） */
  function paintStatsInto(host, line, ctx) {
    if (!host || !line) return;
    host.innerHTML = '';
    const slot = ctx.stats[line.id];

    if (!slot || (slot.loading && !slot.ok)) {
      host.appendChild(util.el('div', 'empty-hint small', '正在读取客流统计…'));
      return;
    }
    if (slot.error === 'notready') {
      host.appendChild(util.el('div', 'empty-hint small', '客流统计还没准备好'));
      host.appendChild(util.el('div', 'lm-note',
        '服务端的客流统计接口（GET /api/transit/line/&lt;线路 id&gt;/stats）还没上线，等它就位后点「⟳ 刷新」即可看到今日与近 7 天的数据；'
        + '在那之前，可以先看列表里这条线路的「日客流」估算。'));
      const retry = util.el('div', 'lm-actions');
      retry.appendChild(button('opt-btn', '⟳ 再试一次', '重新请求客流统计接口', () => fetchStats(ctx, line, true)));
      host.appendChild(retry);
      return;
    }
    if (slot.error) {
      host.appendChild(util.el('div', 'empty-hint small', '客流统计读取失败：' + util.esc(slot.error)));
      const retry = util.el('div', 'lm-actions');
      retry.appendChild(button('opt-btn', '⟳ 重试', '再请求一次客流统计接口', () => fetchStats(ctx, line, true)));
      host.appendChild(retry);
      return;
    }
    if (!slot.ok || !slot.data) {
      host.appendChild(util.el('div', 'empty-hint small', '还没有取到客流统计'));
      return;
    }

    const d = slot.data;
    const grid = util.el('div', 'lm-stats-grid');
    grid.appendChild(statBlock('今日', d.today));
    grid.appendChild(statBlock(`近 ${STATS_DAYS} 天`, d.week));
    host.appendChild(grid);

    if (d.days.length > 1) {
      const table = util.el('table', 'lm-table');
      table.innerHTML = '<thead><tr><th>日期</th><th>运送人次</th><th>车公里</th><th>平均满载率</th><th>平均等待</th></tr></thead>';
      const tbody = util.el('tbody');
      for (const row of d.days.slice(-STATS_DAYS)) {
        const tr = util.el('tr');
        tr.innerHTML = `<td class="name">${util.esc(row.label || '—')}</td>
          <td class="num">${row.riders == null ? '—' : util.fmt(row.riders)}</td>
          <td class="num">${row.vehicleKm == null ? '—' : util.fmt(row.vehicleKm)}</td>
          <td class="num">${row.avgLoad == null ? '—' : util.esc(fmtPct(row.avgLoad))}</td>
          <td class="num">${row.avgWait == null ? '—' : util.esc(fmtDur(row.avgWait))}</td>`;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      host.appendChild(table);
    }

    const allEmpty = d.today.riders == null && d.week.riders == null && d.days.length === 0;
    host.appendChild(util.el('div', 'lm-note', allEmpty
      ? '接口已就绪，但这条线路还没有客流数据（线路跑起来、把时钟调到 ×5 以上就会有）。'
      : `数据来自服务端统计${d.updatedAt ? '，更新于 ' + util.fmtTime(d.updatedAt) : ''}：今日与近 ${STATS_DAYS} 天的运送人次、车公里、平均满载率、平均等待时间。`));
  }

  function statsSection(ctx, line) {
    const box = util.el('div', 'lm-sec');
    const head = util.el('div', 'lm-sec-head');
    head.appendChild(util.el('div', 'lm-sec-title', '客流数据'));
    const actions = util.el('div', 'lm-actions');
    actions.appendChild(button('opt-btn', '⟳ 刷新', '重新从服务端读取这条线路的客流统计', () => fetchStats(ctx, line, true)));
    head.appendChild(actions);
    box.appendChild(head);

    const statsHost = util.el('div', 'lm-stats');
    ctx.statsHost = statsHost;
    ctx.statsLine = line.id;
    paintStatsInto(statsHost, line, ctx);
    box.appendChild(statsHost);
    return box;
  }

  function paintStats(ctx) {
    if (!ctx || !ctx.statsHost || !ctx.statsHost.isConnected) return;
    const line = lineById(ctx.statsLine);
    if (!line) return;
    paintStatsInto(ctx.statsHost, line, ctx);
  }

  /** 把一条线路的详情画进 ctx.detailHost（就是交通面板「线路」分区右侧那一块） */
  function renderDetail(ctx) {
    const host = ctx.detailHost;
    if (!host) return;
    const keepTop = host.scrollTop;
    host.innerHTML = '';
    ctx.statsHost = null;
    ctx.statsLine = null;
    bindHoverGuard(host);
    if (!data()) {
      host.appendChild(util.el('div', 'empty-hint small', '正在载入交通数据…'));
      ctx.lastRenderAt = Date.now();
      return;
    }
    if (ctx.lineId != null && !lineById(ctx.lineId)) ctx.lineId = null;
    const line = selectedLineOf(ctx);
    if (!line) {
      host.appendChild(util.el('div', 'empty-hint small', '在左侧选一条线路，这里会显示它的站点顺序、车辆与客流数据。'));
      ctx.lastRenderAt = Date.now();
      return;
    }
    host.appendChild(detailHead(ctx, line));
    // 运营控制（暂停 / 恢复运营 · 转移归属）就挂在头部下面：一眼能看到状态，操作也离手边最近
    host.appendChild(opsSection(ctx, line));
    host.appendChild(stopsSection(ctx, line));
    host.appendChild(scheduleSection(ctx, line));
    host.appendChild(vehiclesSection(ctx, line));
    host.appendChild(statsSection(ctx, line));
    host.scrollTop = keepTop;
    ctx.lastRenderAt = Date.now();
  }

  /* ------------------------------ 刷新 ------------------------------ */

  /** 重画一个上下文（现在只有面板里嵌的那一份；ctx 省略时用当前嵌入上下文） */
  function renderCtx(ctx) {
    const c = ctx || embedCtx;
    if (!c) return false;
    renderDetail(c);
    return true;
  }

  /**
   * 重新渲染（数据变了、或手动叫一次）。
   * 只作用于**面板里嵌的那一份详情**（独立窗口已经删掉）：鼠标停在详情里 / 玩家正在输入框里打字时
   * 什么都不做（返回 false），免得把输入焦点和光标冲掉；高频模拟帧也走这里，由 MIN_REFRESH_MS 合并。
   */
  function refresh(opts) {
    const opt = opts || {};
    const ctx = embedCtx;
    if (!ctx || !ctx.detailHost) return false;
    if (isTyping(ctx.detailHost)) return false;
    if (!opt.force && Date.now() - (ctx.lastRenderAt || 0) < MIN_REFRESH_MS) return scheduleRefresh();
    renderDetail(ctx);
    return true;
  }

  /** 把这一小段时间里的多次数据更新合并成一次重绘 */
  function scheduleRefresh() {
    if (!embedCtx || embedCtx.pendingRefresh) return true;
    const wait = Math.max(0, MIN_REFRESH_MS - (Date.now() - (embedCtx.lastRenderAt || 0)));
    embedCtx.pendingRefresh = setTimeout(() => {
      if (embedCtx) embedCtx.pendingRefresh = null;
      refresh({ force: true });
    }, wait);
    return true;
  }

  /** Transit 的数据钩子：每次 setSnapshot / applySim 之后都会叫到这里 */
  function onTransitData() {
    if (embedCtx) refresh();
  }

  /**
   * 把一条线路的详情嵌进任意容器（交通面板「线路」分区右侧详情区就用它）。
   * 同一个容器 + 同一条线路时只是重绘，不会重复挂监听。
   */
  function embed(host, opts) {
    if (!host || !host.appendChild) return null;
    injectStyle();
    const opt = opts || {};
    const lineId = opt.lineId == null ? null : Number(opt.lineId);
    if (!embedCtx || embedCtx.detailHost !== host) {
      embedCtx = createCtx('embed');
      embedCtx.detailHost = host;
    }
    embedCtx.lineId = lineId;
    if (host.__lmHoverBound !== true) bindHoverGuard(host);
    renderDetail(embedCtx);
    const line = selectedLineOf(embedCtx);
    if (line) fetchStats(embedCtx, line, false);
    return {
      ctx: embedCtx,
      lineId,
      render: () => renderDetail(embedCtx),
      run: (fn) => fn(embedCtx),
    };
  }

  /** 面板里这块详情被换掉时解绑（避免往已经不在 DOM 里的节点上写） */
  function detach(host) {
    if (embedCtx && (!host || embedCtx.detailHost === host)) embedCtx = null;
  }

  /** 模拟帧里刷新嵌入详情的实时数字（节流；鼠标停在详情里 / 正在打字时让路） */
  function liveRefresh(force) {
    const ctx = embedCtx;
    if (!ctx || !ctx.detailHost || ctx.detailHost.isConnected === false) return false;
    if (ctx.detailHost.__lmHover && !force) return false;
    if (isTyping(ctx.detailHost)) return false;
    const now = Date.now();
    if (!force && now - (ctx.lastRenderAt || 0) < LIVE_MS) return false;
    renderDetail(ctx);
    return true;
  }

  /* ------------------------------ 对外 API ------------------------------ */

  /**
   * 「线路管理器」现在**只有交通面板这一个家**（独立窗口那一整套已经彻底删掉：
   * .lm-win 的 DOM / 拖动 / 缩放 / 位置记忆 / 轮询 / Esc，还有那个左侧线路列表）。
   *
   * open(lineId) 因此不再开窗口，而是**切到交通面板的「线路」分区并选中这条线** ——
   * ui.js 的 UI.openLineMgr()、旧脚本里的 window.G.LineMgr.open() 都照旧能用，
   * 只是打开的是面板里那块同样的详情（面板左侧列表带搜索 / 筛选 / 排序 / 分页，比原来窗口里的那份更全）。
   */
  function openInPanel(lineId) {
    const t = transit();
    if (!t) { toast('交通系统还没准备好', 'warn'); return false; }
    injectStyle();
    const id = lineId == null ? null : Number(lineId);
    if (id != null && Number.isFinite(id) && id && lineById(id) && typeof t.openPanelFor === 'function') {
      t.openPanelFor('line', id);
      return true;
    }
    if (typeof t.openPanel === 'function') { t.openPanel('lines'); return true; }
    toast('交通面板还没准备好', 'warn');
    return false;
  }

  const LineMgr = {
    open: openInPanel,
    render: () => renderCtx(embedCtx),
    /** 数据一变就调它：只重画面板里嵌的那一份（正在打字时什么都不做） */
    refresh,
    subscribe: () => { /* 兼容旧接口：数据刷新现在由交通面板统一驱动 */ },
    // ---- 线路工具（面板详情用；也是 transit.js 与调试脚本用的那一套）----
    embed,
    detach,
    liveRefresh,
    onTransitData,
    compareBlock,
    compareRows,
    exportCsv,
    rebuildBroken,
    lineProblem,
    problemText,
    kindLabel,
    // ---- 班次（发车计划）----
    lineSchedule,
    scheduleText,
  };

  window.G.LineMgr = LineMgr;
})();
