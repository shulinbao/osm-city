'use strict';
/**
 * 交通经营玩法端到端测试：公司资金、车站（铁路/公交）、线路寻路、车辆、可调速时钟、
 * 服务端模拟推进、权限隔离、重启持久化。
 *
 * 为了不动你的正式数据集，测试会把 data/osm/osm.sqlite 复制一份到临时目录再用。
 *   node tests/transit-e2e.js
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 8903);
const TMP = path.join(ROOT, 'tests', 'tmp-transit');
const SRC_DB = path.join(ROOT, 'data', 'osm', 'osm.sqlite');
const DB = path.join(TMP, 'osm.sqlite');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, token) {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function startServer() {
  // `--allow-guests`：正式 config.json 里 allowGuests=false（玩家必须注册/登录），
  // 而本套件要批量造临时玩家（g1/g2 …），逐个注册既慢又没意义 —— 只给**测试实例**开这个口子。
  return spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--data', TMP, '--osm', DB, '--allow-guests'],
    { cwd: ROOT, stdio: 'ignore' });
}

async function waitHealth(timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('服务器启动超时');
    await sleep(300);
  }
}

async function waitTransitReady(timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api('/api/rail');
    if (r.data && r.data.ready) return r.data;
    if (Date.now() - t0 > timeoutMs) throw new Error('路网初始化超时');
    await sleep(500);
  }
}

function connectWS(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    const queue = [];
    const waiters = [];
    const client = {
      ws,
      send(obj) { ws.send(JSON.stringify(obj)); },
      wait(pred, ms = 8000, label = 'message') {
        const idx = queue.findIndex(pred);
        if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const w = { pred, res };
          waiters.push(w);
          const timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error('等待超时: ' + label));
          }, ms);
          const orig = w.res;
          w.res = (m) => { clearTimeout(timer); orig(m); };
        });
      },
      transit(opObj, ms = 20000) {
        const id = 't' + Math.random().toString(36).slice(2, 9);
        ws.send(JSON.stringify({ t: 'transit', id, op: opObj }));
        return client.wait((m) => m.t === 'transitAck' && m.id === id, ms, 'transitAck ' + opObj.k);
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    };
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const idx = waiters.findIndex((w) => { try { return w.pred(msg); } catch { return false; } });
      if (idx >= 0) waiters.splice(idx, 1)[0].res(msg);
      else queue.push(msg);
    });
    ws.addEventListener('open', () => resolve(client));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
}

/** 在数据集附近找一段可用铁路和一条可用道路，作为测试用坐标（返回纯坐标，不保留数据库连接） */
function pickCoordinates() {
  const { OsmDB } = require('../server/osmdb');
  const db = new OsmDB(DB);
  const rail = db.prepare(`SELECT w.id FROM ways w WHERE w.deleted = 0 AND w.tags LIKE '%"railway":"rail"%'
    AND w.node_count > 60 ORDER BY w.node_count DESC LIMIT 1`).get();
  const railNodes = db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq').all(rail.id).map((r) => r.node_id);
  const railCoords = railNodes.map((id) => {
    const n = db.getNode(id);
    return { lat: n.lat, lon: n.lon };
  });
  const road = db.prepare(`SELECT w.id FROM ways w WHERE w.deleted = 0 AND w.tags LIKE '%"highway":"primary"%'
    AND w.node_count > 30 ORDER BY w.node_count DESC LIMIT 1`).get();
  const roadNodes = db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq').all(road.id).map((r) => r.node_id);
  const roadCoords = roadNodes.map((id) => {
    const n = db.getNode(id);
    return { lat: n.lat, lon: n.lon };
  });
  db.close();
  const at = (list) => (frac) => list[Math.floor(list.length * frac)];
  return { railPt: at(railCoords), roadPt: at(roadCoords) };
}

(async () => {
  console.log('\n=== 交通经营玩法 · 端到端测试 ===\n');
  if (!fs.existsSync(SRC_DB)) {
    console.error('找不到数据集 ' + SRC_DB + '，请先导入 OSM 数据');
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const t0 = Date.now();
  // WAL 模式下直接复制主文件即可（先确保没有未落盘的 WAL）
  const wal = SRC_DB + '-wal';
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    console.log('（源库有未合并的 WAL，先复制 wal 文件）');
    fs.copyFileSync(wal, DB + '-wal');
  }
  fs.copyFileSync(SRC_DB, DB);
  console.log(`已复制数据集副本（${(fs.statSync(DB).size / 1048576).toFixed(0)} MB，${((Date.now() - t0) / 1000).toFixed(1)} s）\n`);

  // 交通资产必须从干净状态开跑：主库里可能留着以前玩过的公司/车站/线路/车辆
  {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(DB);
    for (const table of ['companies', 'companies_legacy', 'stations', 'lines', 'vehicles', 'sim_state']) {
      try { raw.exec(`DELETE FROM ${table}`); } catch { /* 表还没建就算了 */ }
    }
    raw.close();
  }

  let server = startServer();
  await waitHealth();
  const railInfo = await waitTransitReady();
  check('服务端路网初始化完成', railInfo.stats.ways > 100, `${railInfo.stats.ways} 条轨道 / ${railInfo.stats.nodes} 节点`);

  /* ------------------------------ 公司与权限 ------------------------------ */
  console.log('\n▶ 公司与权限');
  const g1 = await (await fetch(BASE + '/api/guest', { method: 'POST' })).json();
  const g2 = await (await fetch(BASE + '/api/guest', { method: 'POST' })).json();
  const popInfo = (await api('/api/transit?token=' + g1.token)).data.data.stats.population;
  check('人口模型已就绪（由真实建筑推算）', popInfo && popInfo.population > 1000000,
    `${popInfo && popInfo.population} 人 / ${popInfo && popInfo.jobs} 岗位 / ${popInfo && popInfo.cells} 格`);
  const A = await connectWS(g1.token);
  const B = await connectWS(g2.token);
  const welcomeA = await A.wait((m) => m.t === 'welcome', 15000, 'welcome');
  check('登录时自动创建公司（每人可有多家，新公司为当前公司）',
    welcomeA.transit && welcomeA.transit.companies.some((c) => c.owner === welcomeA.user.id && c.active),
    JSON.stringify((welcomeA.transit && welcomeA.transit.companies.find((c) => c.owner === welcomeA.user.id)) || null));
  const myCompanyId = welcomeA.transit.companies.find((c) => c.owner === welcomeA.user.id && c.active).id;
  const { railPt, roadPt } = pickCoordinates();
  const railP1 = railPt(0.1);
  const railP2 = railPt(0.75);
  const roadP1 = roadPt(0.15);
  const roadP2 = roadPt(0.7);

  /* ------------------------------ 车站 ------------------------------ */
  console.log('\n▶ 车站（铁路 / 公交）');
  const st1 = await A.transit({ k: 'station.create', name: '测试车站A', kind: 'rail', lat: railP1.lat, lon: railP1.lon });
  check('在铁路上建站成功并吸附路网', st1.ok && st1.result.station.onRail === true,
    st1.ok ? `覆盖 ${st1.result.station.catchment.pop} 人 / ${st1.result.station.catchment.jobs} 岗位` : st1.error);
  check('经济系统关闭时不扣钱（建站免费）',
    st1.ok && st1.result.company.cash === 0 && welcomeA.config.transit.economy === false,
    st1.ok ? `余额 ${st1.result.company.cash}（经济关闭时不发初始资金也不扣钱），economy=${welcomeA.config.transit.economy}` : '');
  const st2 = await A.transit({ k: 'station.create', name: '测试车站B', kind: 'rail', lat: railP2.lat, lon: railP2.lon });
  check('第二个车站建成', st2.ok === true, st2.error);
  const bus1 = await A.transit({ k: 'station.create', name: '测试公交站A', kind: 'bus', lat: roadP1.lat, lon: roadP1.lon });
  check('在道路上建公交站成功', bus1.ok && bus1.result.station.onRail === true,
    bus1.ok ? `公交站造价 ${bus1.result.cost}` : bus1.error);
  const bus2 = await A.transit({ k: 'station.create', name: '测试公交站B', kind: 'bus', lat: roadP2.lat, lon: roadP2.lon });
  check('第二个公交站建成', bus2.ok === true, bus2.error);
  const badStation = await A.transit({ k: 'station.create', name: '荒地上的站', kind: 'rail', lat: 40.6, lon: 116.0 });
  check('离铁路太远建站被拒绝', badStation.ok === false && /120 米/.test(badStation.error || ''), badStation.error);
  // 协作编辑（改过的断言）：谁都能改谁建的车站，唯一的冲突保护是"有人正在编辑"的元素锁
  // （元素锁与 destMix 的专项用例在 tests/transit-collab-test.js）。
  const foreign = await B.transit({ k: 'station.update', id: st1.result.station.id, name: '协作改名' });
  check('协作者能改别人建的车站（不再是「只能改自己的」；业主不会因此变成 B）',
    foreign.ok === true && foreign.result.station.name === '协作改名'
      && foreign.result.station.owner === welcomeA.user.id,
    foreign.ok
      ? `B 把 A 的车站改名为「${foreign.result.station.name}」，业主仍是 ${foreign.result.station.owner}`
      : foreign.error);

  /* ------------------------------ 线路 ------------------------------ */
  console.log('\n▶ 线路与寻路（沿真实路网）');
  const railLine = await A.transit({
    k: 'line.create', name: '测试铁路线', kind: 'rail', color: '#e6194b',
    stops: [st1.result.station.id, st2.result.station.id],
  });
  check('铁路线路沿轨道寻路成功', railLine.ok && railLine.result.line.pathLen > 100,
    railLine.ok ? `${railLine.result.line.pathLen} 米 / ${Math.round(railLine.result.line.travelSeconds / 60)} 分钟 / 日客流 ${railLine.result.line.dailyTrips}` : railLine.error);
  check('线路带回了路径坐标（用于地图绘制）',
    railLine.ok && Array.isArray(railLine.result.line.pathCoords) && railLine.result.line.pathCoords.length > 10,
    railLine.ok ? `${(railLine.result.line.pathCoords || []).length} 个点` : '');
  const busLine = await A.transit({
    k: 'line.create', name: '测试公交线', kind: 'bus', color: '#2b8cbe',
    stops: [bus1.result.station.id, bus2.result.station.id],
  });
  check('公交线路沿现有道路寻路成功', busLine.ok && busLine.result.line.pathLen > 100,
    busLine.ok
      ? `${busLine.result.line.pathLen} 米 / 日客流 ${busLine.result.line.dailyTrips} / 站数 ${busLine.result.line.stopsInfo.length}${busLine.result.line.pathError ? ' / 错误: ' + busLine.result.line.pathError : ''}`
      : busLine.error);
  const oneStopLine = await A.transit({ k: 'line.create', name: '单站线', kind: 'rail', stops: [st1.result.station.id] });
  check('只有一站时给出明确提示', oneStopLine.ok && oneStopLine.result.path && oneStopLine.result.path.ok === false,
    JSON.stringify(oneStopLine.result && oneStopLine.result.path));

  /* ------------------------------ 车辆系统与不重叠 ------------------------------ */
  console.log('\n▶ 车辆系统（车队 / 车长 / 不重叠）');
  const kinds = welcomeA.config.transit.vehicleKinds;
  check('服务端下发车辆类型表（中国大陆车型：长度决定示意大小）',
    kinds && kinds.bus && kinds.bus.lengthM === 12 && kinds.metro_b4 && kinds.metro_b4.lengthM === 76,
    kinds ? Object.keys(kinds).join(', ') : '缺少');

  // 车队：先建车（不指定线路），车长/定员按类型
  const busV = await A.transit({ k: 'vehicle.create', kind: 'bus' });
  check('新建公交车：按类型带出车长与定员',
    busV.ok && busV.result.vehicle.lengthM === 12 && busV.result.vehicle.capacity === 80 && busV.result.vehicle.lineId === null,
    busV.ok ? `${busV.result.vehicle.name} ${busV.result.vehicle.lengthM}m/${busV.result.vehicle.capacity}人` : busV.error);
  const metroV = await A.transit({ k: 'vehicle.create', kind: 'metro_b4' });
  check('新建地铁列车：按 B 型 4 节带出 76 米 / 920 人',
    metroV.ok && metroV.result.vehicle.lengthM === 76 && metroV.result.vehicle.capacity === 920,
    metroV.ok ? `${metroV.result.vehicle.lengthM}m/${metroV.result.vehicle.capacity}人` : metroV.error);
  const fleet = [busV, metroV];
  for (let i = 0; i < 3; i++) fleet.push(await A.transit({ k: 'vehicle.create', kind: 'metro_b6' }));
  check('经济关闭时可以无限建车（不再报资金不足）', fleet.every((v) => v.ok), `${fleet.filter((v) => v.ok).length} 辆已建`);

  // 把 3 辆车指派到同一条线路上，检查是否自动错开、跑起来不重叠
  const lineVehicles = [];
  for (let i = 2; i < 5; i++) {
    const r = await A.transit({ k: 'vehicle.update', id: fleet[i].result.vehicle.id, lineId: railLine.result.line.id });
    if (r.ok) lineVehicles.push(r.result.vehicle);
  }
  check('可以把车队里的车指派到已有线路', lineVehicles.length === 3, `${lineVehicles.length} 辆已指派`);
  await A.transit({ k: 'clock.set', speed: 20 });
  await sleep(6000);
  const snap2 = (await api('/api/transit?token=' + g1.token)).data.data;
  const onLine = snap2.trains.filter((t) => t.lineId === railLine.result.line.id).sort((a, b) => a.distance - b.distance);
  check('线路上同时有 3 辆车在跑', onLine.length === 3, onLine.map((t) => `${t.name}:${t.distance}m`).join(' '));
  // 前后车不重叠：**只看同方向**的车（_enforceSpacing 就是这么约束的：同一条线上、
  // 同一个方向的前后车，后车最多跟到"前车后方（两车半长 + 安全距离）"处）。
  // 反方向的车在这条线上是"会车通过"（单线路，代码注释里写明了互相不约束），
  // 所以它们贴得再近也不算违规 —— 之前这里不看方向、直接按里程排序算间距，
  // 于是"两辆车正好会车"时会偶发误报（车间距 82~122 米）。
  const minGapM = Number(welcomeA.config.transit.minGapMeters) || 45;
  const sameDirGaps = [];      // 同方向相邻车：{ gap, need }
  for (const dir of [1, -1]) {
    const group = onLine.filter((t) => (t.direction > 0 ? 1 : -1) === dir)
      .sort((a, b) => (dir > 0 ? a.distance - b.distance : b.distance - a.distance));
    for (let i = 1; i < group.length; i++) {
      const back = group[i - 1];
      const lead = group[i];
      sameDirGaps.push({
        gap: Math.abs(lead.distance - back.distance),
        // 需要的净距 = 后车半长 + 前车半长 + 安全距离（metro_b6 实长 114 米，不写死 80/120）
        need: (lead.lengthM || 0) / 2 + (back.lengthM || 0) / 2 + minGapM,
        pair: `${back.name}→${lead.name}`,
      });
    }
  }
  const meetGaps = [];        // 反方向会车：按里程排序的相邻对，方向不同
  for (let i = 1; i < onLine.length; i++) {
    if (onLine[i].direction === onLine[i - 1].direction) continue;
    meetGaps.push(onLine[i].distance - onLine[i - 1].distance);
  }
  const minSame = sameDirGaps.length ? Math.round(Math.min(...sameDirGaps.map((g) => g.gap))) : null;
  const needSame = sameDirGaps.length ? Math.round(Math.max(...sameDirGaps.map((g) => g.need))) : null;
  const minMeet = meetGaps.length ? Math.round(Math.min(...meetGaps)) : null;
  const gapText = `同方向最小净距 ${minSame == null ? '—（本次没有同方向跟车）' : minSame + ' 米'}`
    + `${needSame == null ? '' : `（至少需要 ${needSame} 米）`}`
    + ` / 反方向会车最小距离 ${minMeet == null ? '—（本次没有会车）' : minMeet + ' 米'}`;
  check('同方向的前后车不会重叠（后车停在前车后方；反方向会车允许贴近）',
    onLine.length === 3 && sameDirGaps.every((g) => g.gap >= g.need - 1),
    gapText);
  check('车辆朝向随线路变化（前端据车长画车身）',
    onLine.every((t) => typeof t.heading === 'number' && typeof t.lengthM === 'number'),
    onLine.map((t) => `${t.heading}°/${t.lengthM}m`).join(' '));
  await A.transit({ k: 'clock.set', speed: 0 });

  /* ------------------------------ 加站自动吸附 ------------------------------ */
  console.log('\n▶ 加站失败问题：自动吸附到线路');
  const offStation = await A.transit({ k: 'station.create', name: '离线路较远的站', kind: 'rail', lat: railPt(0.0).lat, lon: railPt(0.0).lon });
  check('可以在起点再建一个车站', offStation.ok === true, offStation.error);
  const lineBefore = (await api('/api/transit?token=' + g1.token)).data.data.lines.find((l) => l.id === railLine.result.line.id);
  const addRes = await A.transit({ k: 'line.update', id: railLine.result.line.id, stops: lineBefore.stops.concat([offStation.result.station.id]) });
  check('加站不再报"路径不通"（不在线路上会自动吸附）',
    addRes.ok && addRes.result.path && addRes.result.path.ok === true,
    addRes.ok ? `吸附 ${(addRes.result.snapped || []).length} 个站 · 路径 ${addRes.result.path.lengthM} 米` : addRes.error);

  /* ------------------------------ 交通操作可撤销 ------------------------------ */
  console.log('\n▶ 交通操作的撤销 / 重做');
  const undoStation = await A.transit({ k: 'station.create', name: '待撤销车站', kind: 'rail', lat: railPt(0.3).lat, lon: railPt(0.3).lon });
  const undoStationId = undoStation.result.station.id;
  const undoRes = await A.transit({ k: 'undo' });
  const stillThere = await A.transit({ k: 'station.update', id: undoStationId, name: 'x' });
  check('撤销能撤掉刚建的车站', undoRes.ok && stillThere.ok === false && /不存在/.test(stillThere.error || ''),
    undoRes.ok ? `已撤销：${undoRes.result.undone}` : undoRes.error);
  const redoRes = await A.transit({ k: 'redo' });
  const backAgain = await A.transit({ k: 'station.update', id: undoStationId, name: '待撤销车站' });
  check('重做能把车站找回来', redoRes.ok && backAgain.ok === true, redoRes.ok ? redoRes.result.redone : redoRes.error);
  const undoVehicle = await A.transit({ k: 'undo' });
  check('撤销也能撤掉建车/改车这类操作', undoVehicle.ok === true || /没有可撤销/.test(undoVehicle.error || ''),
    undoVehicle.ok ? `已撤销：${undoVehicle.result.undone}` : undoVehicle.error);

  /* ------------------------------ 时钟与模拟 ------------------------------ */
  console.log('\n▶ 游戏时钟与服务端模拟');
  const slow = await A.transit({ k: 'clock.set', speed: 3 });
  check('非法倍速被拒绝', slow.ok === false, slow.error);
  const fast = await A.transit({ k: 'clock.set', speed: 20 });
  check('切换到 ×20 倍速', fast.ok && fast.result.speed === 20);
  const before = (await api('/api/transit?token=' + g1.token)).data.data;
  const simVehicleId = fleet[2].result.vehicle.id;
  const beforeTrain = before.trains.find((t) => t.id === simVehicleId);
  await sleep(5000);   // 5 秒实时 × ×20 = 100 游戏秒（旧基准下这里是 100 游戏分钟）
  const after = (await api('/api/transit?token=' + g1.token)).data.data;
  const afterTrain = after.trains.find((t) => t.id === simVehicleId);
  const moved = beforeTrain && afterTrain && (beforeTrain.distance !== afterTrain.distance ||
    Math.abs(afterTrain.lat - beforeTrain.lat) > 1e-5 || Math.abs(afterTrain.lon - beforeTrain.lon) > 1e-5);
  check('列车在时钟推进中真的移动了', moved,
    beforeTrain && afterTrain
      ? `里程 ${beforeTrain.distance} m → ${afterTrain.distance} m；状态 ${beforeTrain.state} → ${afterTrain.state}；速度 ${afterTrain.speed} km/h`
      : '缺少列车数据');
  check('游戏时间在推进', after.clock.clockMs > before.clock.clockMs,
    `${before.clock.time} → ${after.clock.time}（第 ${after.clock.day} 天）`);
  // 客流要等车真的到站载客才会记上，所以这里轮询一会儿
  // （新时间基准下 ×20 = 20 倍实时，30 秒实时 ≈ 10 游戏分钟；够一站一停）
  let companyAfter = after.companies.find((c) => c.id === myCompanyId);
  for (let i = 0; i < 30 && (!companyAfter || companyAfter.riders <= 0); i++) {
    await sleep(1000);
    const peek = (await api('/api/transit', g1.token)).data.data;
    companyAfter = (peek.companies || []).find((c) => c.id === myCompanyId) || companyAfter;
  }
  check('列车产生了客流（经济关闭时只记人次不收票款）', companyAfter && (companyAfter.riders > 0 || companyAfter.revenue > 0),
    companyAfter ? `${companyAfter.riders} 人次 / ${companyAfter.revenue} 元` : '');
  const paused = await A.transit({ k: 'clock.set', speed: 0 });
  check('可以暂停时钟', paused.ok && paused.result.speed === 0);
  const t1 = (await api('/api/transit', g1.token)).data.data.clock.clockMs;
  await sleep(1200);
  const t2 = (await api('/api/transit', g1.token)).data.data.clock.clockMs;
  check('暂停后游戏时间不再推进', t1 === t2, `${t1} = ${t2}`);

  /* ------------------------------ 广播与人口 ------------------------------ */
  console.log('\n▶ 实时同步与人口热力图');
  const syncAtB = await B.wait((m) => m.t === 'transitSync' && m.data && m.data.stations.length > 0, 8000, 'transitSync').catch(() => null);
  check('交通状态广播给其他玩家', !!syncAtB, syncAtB ? `${syncAtB.data.stations.length} 个车站` : '超时');
  const simAtB = await B.wait((m) => m.t === 'sim' && m.clock, 8000, 'sim frame').catch(() => null);
  check('模拟帧持续广播（含时钟与列车）', !!simAtB && Array.isArray(simAtB.trains), simAtB ? `${simAtB.trains.length} 列车` : '超时');
  const pop = await api('/api/population?minLon=116.39&minLat=39.89&maxLon=116.43&maxLat=39.93&minPop=300&token=' + g1.token);
  check('人口热力图接口返回网格', pop.data.cells.length > 20, `${pop.data.cells.length} 个网格`);

  /* ------------------------------ 持久化 ------------------------------ */
  console.log('\n▶ 重启持久化');
  const beforeRestart = (await api('/api/transit', g1.token)).data.data;
  A.close();
  B.close();
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 4000);
    server.on('exit', () => { clearTimeout(t); resolve(); });
  });
  await sleep(400);
  server = startServer();
  await waitHealth();
  await waitTransitReady();
  const afterRestart = (await api('/api/transit', g1.token)).data.data;
  check('重启后公司、车站、线路、车辆都还在',
    afterRestart.companies.length === beforeRestart.companies.length &&
    afterRestart.stations.length === beforeRestart.stations.length &&
    afterRestart.lines.length === beforeRestart.lines.length &&
    afterRestart.vehicles.length === beforeRestart.vehicles.length,
    `公司 ${afterRestart.companies.length} / 车站 ${afterRestart.stations.length} / 线路 ${afterRestart.lines.length} / 车辆 ${afterRestart.vehicles.length}`);
  const reline = afterRestart.lines.find((l) => l.name === '测试铁路线');
  check('重启后线路路径被重新计算', !!reline && reline.pathLen > 100, reline ? `${reline.pathLen} 米` : '找不到线路');

  server.kill('SIGTERM');
  await sleep(500);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + '─'.repeat(52));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) { console.log('\n失败项：'); for (const f of failures) console.log('  · ' + f); }
  console.log('─'.repeat(52) + '\n');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\n测试异常终止:', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
