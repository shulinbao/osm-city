'use strict';
/**
 * 协作编辑 + 元素锁 + 候车明细（按目的地分组）的专项测试。
 * 不需要那份几百 MB 的真实数据集，跑得很快：
 *
 *   node tests/transit-collab-test.js
 *
 * 三组验收（对应用户提的三条要求）：
 *   1. **协作编辑**：第二个玩家可以改 / 删第一个玩家建的车站、线路、车辆、公司；
 *      **车站没有归属**：底图导入的站（imported=1）与玩家自建的站完全一样，谁都能改名 / 删除 /
 *      挪位置，不存在"公共车站 / 系统公司"这回事（imported / osm_type / osm_id 只是来源信息）；
 *      撤销栈仍然按玩家分开（B 的 Ctrl+Z 只回退 B 自己做过的那几步）。
 *   2. **元素锁**：A 锁着某个元素时 B 改不动（明确的中文错误，code=LOCKED），
 *      直到 A 解锁 / 锁超时；锁在自己手里不受影响；没有 OSM 模块时（独立 new Transit）同样管用。
 *   3. **候车明细按目的地分组**：waitingByLine[].destMix 与 waitingByDest 与真实候车批次（cohort）
 *      逐条对得上（直接拿 cohort 里的 destId/people 复算一遍做对比），
 *      并且快照里只有"真有人在等"的车站才带这两块明细。
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/dbschema');
const { RailGraph } = require('../server/railgraph');
const { Transit } = require('../server/transit');
const { OsmOps, UndoBus } = require('../server/osmops');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tests', 'tmp-collab');
const LAT = 39.9;
const LON0 = 116.4;
const STEP_LON = 0.0025;      // ≈ 213 米一个节点
const NODES = 12;             // 一条 2.4 公里的短线
const RAIL_BASE = 1000;
const RAIL_WAY = 500;

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const lonOf = (i) => LON0 + i * STEP_LON;
const railNode = (i) => RAIL_BASE + i;

/** 造一份人造底图：一条小铁路（都插进 rtree 索引，吸附时要用） */
function buildFixture(db) {
  const insNode = db.prepare('INSERT INTO nodes(id, lat, lon, version, tags, ts, deleted) VALUES(?,?,?,1,NULL,?,0)');
  const insIndex = db.prepare('INSERT OR REPLACE INTO node_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWay = db.prepare(`INSERT INTO ways(id, version, tags, ts, deleted, node_count, closed, min_lat, max_lat, min_lon, max_lon)
    VALUES(?,1,?,?,0,?,0,?,?,?,?)`);
  const insWayIndex = db.prepare('INSERT OR REPLACE INTO way_index(id, min_lon, max_lon, min_lat, max_lat) VALUES(?,?,?,?,?)');
  const insWayNode = db.prepare('INSERT INTO way_nodes(way_id, seq, node_id) VALUES(?,?,?)');
  const now = Date.now();
  for (let i = 0; i < NODES; i++) {
    insNode.run(railNode(i), LAT, lonOf(i), now);
    insIndex.run(railNode(i), lonOf(i), lonOf(i), LAT, LAT);
    insWayNode.run(RAIL_WAY, i, railNode(i));
  }
  insWay.run(RAIL_WAY, JSON.stringify({ railway: 'rail', maxspeed: '80' }), now, NODES, LAT, LAT, lonOf(0), lonOf(NODES - 1));
  insWayIndex.run(RAIL_WAY, lonOf(0), lonOf(NODES - 1), LAT, LAT);
}

/**
 * 人造世界：每次换一个临时库文件，路网用真正的 RailGraph。
 * sharedLocks !== false 时按 index.js 的接法把 OsmOps 与 Transit 挂在**同一条 UndoBus** 上
 * （交通资产的元素锁借的就是 OSM 那一张锁表）；sharedLocks === false 时模拟"独立 new Transit"。
 */
let worldSeq = 0;
function makeWorld(config, opts = {}) {
  worldSeq += 1;
  const file = path.join(TMP, `osm-${worldSeq}.sqlite`);
  const raw = openDatabase(file);
  buildFixture(raw);
  const db = { raw, prepare: (sql) => raw.prepare(sql), exec: (sql) => raw.exec(sql) };
  const rail = new RailGraph(db, { mode: 'rail' });
  rail.build();
  const road = new RailGraph(db, { mode: 'bus' });
  let roadBuilt = false;
  const ensureBusGraph = () => { if (!roadBuilt) { road.build(); roadBuilt = true; } return road; };
  const population = {
    catchment: () => ({ pop: 3000, jobs: 500, weightedPop: 3600, activity: 1.2 }),
    totals: () => ({ population: 3000, jobs: 500, cells: 1 }),
  };
  const undoBus = new UndoBus();
  const ops = opts.sharedLocks === false ? null : new OsmOps(db, { undoBus, src: 'osm' });
  const transit = new Transit(db, {
    rail, ensureBusGraph, population, undoBus, src: 'transit',
    config: Object.assign({ dwellSeconds: 30, patienceSeconds: 1000000, cohortSeconds: 30, tripRatePerDay: 0 }, config || {}),
  });
  const userA = { id: 'u-alice', name: '小爱', color: '#e6194b' };
  const userB = { id: 'u-bob', name: '小博', color: '#2b8cbe' };
  const companyA = transit.ensureCompany(userA);
  const companyB = transit.ensureCompany(userB);
  const at = (idx) => ({ lat: LAT, lon: lonOf(idx) });
  return { raw, db, rail, road, transit, ops, undoBus, userA, userB, companyA, companyB, at };
}

/** 让游戏时间走 gameSec 游戏秒（与别的交通测试同一套粒度：3 游戏秒一小步） */
function run(transit, gameSec, chunkMs = 3000) {
  let done = 0;
  while (done < gameSec) {
    const chunk = Math.min(chunkMs, Math.ceil((gameSec - done) * 1000));
    transit.tick(Math.max(1, chunk));
    done += (Math.max(1, chunk) * transit.speed) / 1000;
  }
}

/** 调一个 op 并把错误抓下来（不想让一条断言失败就把整组测试打断） */
function tryOp(transit, user, op) {
  try { return { ok: true, result: transit.apply(user, op) }; }
  catch (err) { return { ok: false, error: err.message, code: err.code, err }; }
}

/** 某个桶里"按目的站的原始账"：直接读 cohort（destId/people），与 destMix 对比用 */
function cohortMix(transit, stationId, companyId, owner, lineId) {
  const byCompany = transit.stationQueues.get(Number(stationId));
  if (!byCompany) return [];
  const entry = byCompany.get(transit._companyKey(companyId, owner));
  if (!entry) return [];
  const bucket = entry.buckets.get(transit._bucketKey(lineId));
  if (!bucket) return [];
  const agg = new Map();
  for (const c of bucket.cohorts) {
    if (!(c.people > 0)) continue;
    const key = c.destId == null ? 0 : Number(c.destId);
    agg.set(key, (agg.get(key) || 0) + c.people);
  }
  return [...agg]
    .sort((a, b) => (b[1] - a[1]) || ((a[0] ? 0 : 1) - (b[0] ? 0 : 1)) || (a[0] - b[0]))
    .map(([key, people]) => ({ stationId: key ? Number(key) : null, people: Math.round(people * 10) / 10 }));
}

/** 两个 destMix/waitingByDest 行数组是否"同一份账"（忽略站名，比 id 与人数） */
const sameMix = (a, b) => a.length === b.length
  && a.every((row, i) => row.stationId === b[i].stationId && row.people === b[i].people);

/* ---------------------------------- 开始 ---------------------------------- */
console.log('\n=== 协作编辑 / 元素锁 / 候车明细（按目的地）· 专项测试 ===\n');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

try {
  /* ============ 1. 协作编辑：B 能改 / 删 A 的车站、线路、车辆 ============ */
  console.log('▶ 协作编辑：谁都能改谁建的交通资产');
  {
    const w = makeWorld();
    const { transit, userA, userB } = w;
    const S甲 = transit.createStation(userA, { name: '甲站', kind: 'rail', ...w.at(0) }).station.id;
    const S乙 = transit.createStation(userA, { name: '乙站', kind: 'rail', ...w.at(4) }).station.id;
    const S丙 = transit.createStation(userA, { name: '丙站', kind: 'rail', ...w.at(8) }).station.id;
    const lineA = transit.createLine(userA, { name: 'A 的线', kind: 'rail', stops: [S乙, S丙] }).line;
    const vehA = transit.createVehicle(userA, { kind: 'metro_b4', lineId: lineA.id, name: 'A 的车' }).vehicle;

    // (1) B 改 A 的车站名
    const upSt = tryOp(transit, userB, { k: 'station.update', id: S甲, name: 'B 改的站名', kind: 'rail' });
    const stAfter = transit._st.station.get(S甲);
    check('B 能改 A 建的车站（改名成功，业主仍然是 A）',
      upSt.ok === true && stAfter.name === 'B 改的站名' && stAfter.owner === userA.id && stAfter.company_id === w.companyA.id,
      upSt.ok ? `名字「${stAfter.name}」/ 业主 ${stAfter.owner}` : upSt.error);

    // (2) B 改 A 的线路：客户端会把整份 stops 一起回传 —— A 的车站一个都不能被过滤掉
    const stopsBefore = transit.linePublic(transit._st.line.get(lineA.id)).stops;
    const upLine = tryOp(transit, userB, { k: 'line.update', id: lineA.id, name: 'B 改的线名', stops: stopsBefore });
    const lineAfter = transit.linePublic(transit._st.line.get(lineA.id));
    check('B 能改 A 建的线路（改名成功）', upLine.ok === true && lineAfter.name === 'B 改的线名', upLine.ok ? lineAfter.name : upLine.error);
    check('B 改 A 的线路时，A 的车站不会被静默摘掉（_usableStop 不再按业主过滤）',
      upLine.ok === true && lineAfter.stops.length === stopsBefore.length
        && stopsBefore.every((id) => lineAfter.stops.includes(id)),
      `改动前 ${JSON.stringify(stopsBefore)} → 改动后 ${JSON.stringify(lineAfter.stops)}`);

    // (3) B 用自己的公司建一条线路，站用的是 A 的车站（协作：车站是共享的）
    const lineB = tryOp(transit, userB, { k: 'line.create', name: 'B 的线', kind: 'rail', stops: [S乙, S丙] });
    check('B 能把 A 的车站加进自己新建的线路',
      lineB.ok === true && lineB.result.line.stops.length === 2, lineB.ok ? JSON.stringify(lineB.result.line.stops) : lineB.error);

    // (4) B 把 A 的车改派到自己的线路上，再改名
    const upVeh = tryOp(transit, userB, { k: 'vehicle.update', id: vehA.id, name: 'B 改的车', lineId: lineB.result.line.id });
    const vehRow = transit._st.vehicle.get(vehA.id);
    check('B 能改 A 建的车辆（改名 + 改派到自己的线路）',
      upVeh.ok === true && vehRow.name === 'B 改的车' && vehRow.line_id === lineB.result.line.id,
      upVeh.ok ? `${vehRow.name} → 线路 #${vehRow.line_id}` : upVeh.error);

    // (5) 撤销栈按玩家分开：先记下各自深度
    const depthA = transit.undoDepth(userA.id);
    const depthB = transit.undoDepth(userB.id);

    const delVeh = tryOp(transit, userB, { k: 'vehicle.delete', id: vehA.id });
    const delLine = tryOp(transit, userB, { k: 'line.delete', id: lineA.id });
    const delSt = tryOp(transit, userB, { k: 'station.delete', id: S甲 });
    check('B 能删 A 建的车辆 / 线路 / 车站',
      delVeh.ok === true && delLine.ok === true && delSt.ok === true
        && !transit._st.vehicle.get(vehA.id) && !transit._st.line.get(lineA.id) && !transit._st.station.get(S甲),
      `车辆 ${delVeh.ok} / 线路 ${delLine.ok} / 车站 ${delSt.ok}`);

    check('撤销栈仍然按玩家分开（B 的 6 步记在 B 的栈上，A 的栈一动不动）',
      transit.undoDepth(userB.id) === depthB + 3 && transit.undoDepth(userA.id) === depthA,
      `A ${depthA} → ${transit.undoDepth(userA.id)}；B ${depthB} → ${transit.undoDepth(userB.id)}`);

    // (6) B 撤销一步：把刚删掉的车站放回来（回的是 B 自己那一步，A 的栈还是不动）
    const undo = tryOp(transit, userB, { k: 'undo' });
    check('B 撤销的是 B 自己删的那个车站（A 的撤销栈不受影响）',
      undo.ok === true && !!transit._st.station.get(S甲) && transit.undoDepth(userA.id) === depthA,
      undo.ok ? `${undo.result.undone} / 车站 #${S甲} 回来了 / A 的栈仍 ${transit.undoDepth(userA.id)} 步` : undo.error);
    w.raw.close();
  }

  /* ============ 2. 车站没有归属：底图导入的站也能改名 / 挪动 / 删除 ============ */
  console.log('\n▶ 车站没有归属：底图导入的站一样能改名 / 挪动 / 删除，也没有"系统公司"这回事');
  {
    const w = makeWorld();
    const { transit, userA, userB } = w;
    // 与 importStations 写进去的是同一形状：owner = '__system__'、imported = 1、挂在那家名义公司名下
    const sysCompany = transit.ensureSystemCompany();
    const pub = Number(transit._st.insertImportedStation.run(
      '__system__', sysCompany.id, '底图火车站', 'rail', LAT, lonOf(5), railNode(5), RAIL_WAY,
      120, 700, 0, 0, Date.now(), 'node', 990001).lastInsertRowid);
    const pubRow = transit._st.station.get(pub);
    const pubPub = transit.stationPublic(pubRow);

    // ⚠ 这条断言原来写的是"底图导入站是只读的公共车站（isPublic 为真 = 客户端按只读显示）"。
    //    用户要求车站**不再有归属概念**，所以现在这几个字段只是"这个站从底图哪个元素来的"这条信息：
    //    owner / companyId 是记账用的挂靠账号，imported / osmType / osmId 是来源，谁都能改能删。
    check('导入站的 owner / imported / osmType 只是来源信息（不是"公共车站"这种身份，也不代表权限）',
      !!pubRow && pubRow.owner === '__system__' && pubRow.imported === 1
        && pubPub.isPublic === true && pubPub.osmType === 'node' && pubPub.osmId === 990001,
      pubRow ? `owner=${pubRow.owner} imported=${pubRow.imported} osm=${pubPub.osmType}/${pubPub.osmId}` : '没建成');

    // ⚠ 这两条原来是"公共车站不能被改名 / 删除（协作编辑的例外）"+"公共车站没被改动"，现在反过来：
    //    谁都能改（改名 + 挪位置），改完之后 imported / osm_type / osm_id 这些来源信息照样留着。
    const rename = tryOp(transit, userB, { k: 'station.update', id: pub, name: 'B 改的导入站名' });
    const renamedRow = transit._st.station.get(pub);
    const moved = tryOp(transit, userB, { k: 'station.update', id: pub, lat: LAT, lon: lonOf(6) });
    check('别的玩家能改底图导入站（改名 + 挪位置，重新吸附到路网；原来的 FORBIDDEN 已经删掉）',
      rename.ok === true && !!renamedRow && renamedRow.name === 'B 改的导入站名'
        && renamedRow.imported === 1 && renamedRow.osm_type === 'node' && renamedRow.osm_id === 990001
        && moved.ok === true && Math.abs(moved.result.station.lon - lonOf(6)) < 1e-6,
      `${renamedRow ? renamedRow.name : rename.error} / lon=${moved.ok ? moved.result.station.lon : moved.error} / imported=${renamedRow && renamedRow.imported}`);

    // 而且可以当站点用：B 建一条线路穿过它
    const my = transit.createStation(userB, { name: 'B 的站', kind: 'rail', ...w.at(9) }).station.id;
    const line = tryOp(transit, userB, { k: 'line.create', name: '过导入站', kind: 'rail', stops: [pub, my] });
    check('任何玩家都能把导入站加进自己的线路（当好站点用）',
      line.ok === true && line.result.line.stops.includes(pub) && line.result.line.pathLen > 0,
      line.ok ? `${line.result.line.pathLen} 米 / 站 ${JSON.stringify(line.result.line.stops)}` : line.error);

    // ⚠ 这条原来也是"公共车站不能删"，并且"没被改动"；现在导入站能删，而且撤销一步能连站带线放回来
    const del = tryOp(transit, userB, { k: 'station.delete', id: pub });
    const lineId = line.result.line.id;
    const goneAfterDel = !transit._st.station.get(pub);
    const stopsAfterDel = transit.linePublic(transit._st.line.get(lineId)).stops;
    const undo = tryOp(transit, userB, { k: 'undo' });
    const stopsAfterUndo = transit.linePublic(transit._st.line.get(lineId)).stops;
    check('导入站也能删（线路上的那一站被摘掉；撤销一步站和线路都放回来）',
      del.ok === true && goneAfterDel && stopsAfterDel.length === 1
        && undo.ok === true && !!transit._st.station.get(pub) && stopsAfterUndo.includes(pub),
      `删：站还在？${!goneAfterDel} / 线 ${JSON.stringify(stopsAfterDel)}；撤销后 ${JSON.stringify(stopsAfterUndo)}`);

    // ⚠ 这条原来是"系统公司（公共车站的业主）不能被删除"。车站没有归属之后，那家挂靠公司
    //    与玩家公司地位完全相同，deleteCompany 里那条特判已经删掉 —— 只剩通用的"至少要保留一家公司"。
    const delSys = tryOp(transit, userB, { k: 'company.delete', id: sysCompany.id });
    check('导入站挂靠的那家公司没有"系统公司不能删"的特权（只剩通用的"至少要保留一家公司"）',
      delSys.ok === false && /至少要保留一家公司/.test(delSys.error || ''), delSys.error);

    // 协作编辑下公司本身也能改（别人家的公司照样能改名）
    const compB = transit.ensureCompany(userA, undefined);   // 顺手确认 A 的公司拿得到
    const ren = tryOp(transit, userB, { k: 'company.set', companyId: compB.id, name: 'B 给 A 的公司改名', color: '#123456' });
    check('B 能给 A 的公司改名 / 换色（公司也是共享资产）',
      ren.ok === true && !!ren.result && ren.result.name === 'B 给 A 的公司改名' && ren.result.owner === userA.id,
      ren.ok ? `${ren.result && ren.result.name} / 业主 ${ren.result && ren.result.owner}` : ren.error);
    w.raw.close();
  }

  /* ============ 3. 元素锁：A 锁着时 B 改不动 ============ */
  console.log('\n▶ 元素锁：谁在改谁上锁，别人拿到明确的中文错误');
  {
    const w = makeWorld();
    const { transit, ops, userA, userB } = w;
    const S = transit.createStation(userA, { name: '被锁的站', kind: 'rail', ...w.at(0) }).station.id;
    const S2 = transit.createStation(userA, { name: '另一站', kind: 'rail', ...w.at(4) }).station.id;
    const line = transit.createLine(userA, { name: '被锁的线', kind: 'rail', stops: [S, S2] }).line;
    const veh = transit.createVehicle(userA, { kind: 'metro_b4', lineId: line.id }).vehicle;

    const lockA = tryOp(transit, userA, { k: 'lock.set', elemType: 'station', id: S });
    check('A 拿到车站的元素锁（locked=false）',
      lockA.ok === true && lockA.result.locked === false && lockA.result.elemType === 'station',
      JSON.stringify(lockA.ok ? lockA.result : lockA.error));
    check('锁在全服可见（elementLocksSnapshot 与 OSM 那张锁表里都有，会跟着 locks 广播发出去）',
      !!transit.elementLocksSnapshot()['station:' + S] && !!ops.locksSnapshot()['station:' + S],
      JSON.stringify(transit.elementLocksSnapshot()));

    const lockB = tryOp(transit, userB, { k: 'lock.set', elemType: 'station', id: S });
    check('B 去抢同一把锁只会被"告知"（locked=true + by），不会报错',
      lockB.ok === true && lockB.result.locked === true && lockB.result.by === userA.name,
      JSON.stringify(lockB.ok ? lockB.result : lockB.error));

    const upB = tryOp(transit, userB, { k: 'station.update', id: S, name: 'B 想改' });
    const delB = tryOp(transit, userB, { k: 'station.delete', id: S });
    check('A 锁着车站时，B 改 / 删都被拒绝（中文原因 + code=LOCKED）',
      upB.ok === false && delB.ok === false && upB.code === 'LOCKED'
        && /小爱 正在编辑这个元素/.test(upB.error || '') && upB.error === delB.error,
      `${upB.error}（code=${upB.code}）`);

    const upA = tryOp(transit, userA, { k: 'station.update', id: S, name: 'A 自己改' });
    check('锁在自己手里时自己照常编辑（不会被自己挡住）',
      upA.ok === true && transit._st.station.get(S).name === 'A 自己改', upA.ok ? '' : upA.error);

    const unlock = tryOp(transit, userA, { k: 'lock.set', elemType: 'station', id: S, on: false });
    const upB2 = tryOp(transit, userB, { k: 'station.update', id: S, name: 'B 现在能改了' });
    check('A 解锁之后 B 立刻能改（锁是"一直挡到释放"的）',
      unlock.ok === true && upB2.ok === true && transit._st.station.get(S).name === 'B 现在能改了',
      upB2.ok ? transit._st.station.get(S).name : upB2.error);

    // 线路 / 车辆 / 公司也是同一套锁
    transit.apply(userA, { k: 'lock.set', elemType: 'line', id: line.id });
    const upLineB = tryOp(transit, userB, { k: 'line.update', id: line.id, name: 'B 改线' });
    const delLineB = tryOp(transit, userB, { k: 'line.delete', id: line.id });
    check('A 锁着线路时，B 改 / 删线路都被拒绝',
      upLineB.ok === false && delLineB.ok === false && upLineB.code === 'LOCKED' && /正在编辑/.test(upLineB.error || ''),
      `${upLineB.error}`);
    transit.apply(userA, { k: 'lock.set', elemType: 'vehicle', id: veh.id });
    const delVehB = tryOp(transit, userB, { k: 'vehicle.delete', id: veh.id });
    check('A 锁着车辆时，B 删不掉它', delVehB.ok === false && delVehB.code === 'LOCKED', delVehB.error);
    const lockComp = transit.apply(userA, { k: 'lock.set', elemType: 'company', id: w.companyA.id });
    const compB = tryOp(transit, userB, { k: 'company.set', companyId: w.companyA.id, name: 'B 想改 A 的公司' });
    check('A 锁着公司时，B 改不了它的名字/配色',
      lockComp.locked === false && compB.ok === false && compB.code === 'LOCKED', compB.error);

    // 超时：锁的时间戳往前拨 3 分钟（LOCK_TTL_MS = 120 秒）→ 等于过期，B 又能改了
    transit.apply(userA, { k: 'lock.set', elemType: 'station', id: S });
    ops.locks.get('station:' + S).ts = Date.now() - 3 * 60 * 1000;
    const upB3 = tryOp(transit, userB, { k: 'station.update', id: S, name: '锁过期后能改' });
    check('锁超时（120 秒）之后自己失效：B 不用等 A 也能改',
      upB3.ok === true && transit._st.station.get(S).name === '锁过期后能改', upB3.ok ? '' : upB3.error);

    const bad = tryOp(transit, userA, { k: 'lock.set', elemType: 'way', id: 1 });
    check('lock.set 只认交通资产类型（别的类型给明确原因，不会被拿来乱锁 OSM 元素）',
      bad.ok === false && bad.code === 'BAD_LOCK' && /元素锁只支持/.test(bad.error || ''), bad.error);
    w.raw.close();
  }

  /* ============ 4. 没有 OSM 模块时（独立 new Transit）锁照样管用 ============ */
  console.log('\n▶ 独立 new Transit（没有 OSM 模块）：元素锁退化成自带锁表，语义一样');
  {
    const w = makeWorld(null, { sharedLocks: false });
    const { transit, userA, userB } = w;
    const S = transit.createStation(userA, { name: '站', kind: 'rail', ...w.at(2) }).station.id;
    const l1 = transit.apply(userA, { k: 'lock.set', elemType: 'station', id: S });
    const blocked = tryOp(transit, userB, { k: 'station.update', id: S, name: 'B 改' });
    transit.apply(userA, { k: 'lock.set', elemType: 'station', id: S, on: false });
    const ok = tryOp(transit, userB, { k: 'station.update', id: S, name: 'B 改好了' });
    check('自带锁表：上锁 → B 被挡（LOCKED）→ 解锁 → B 能改',
      l1.locked === false && blocked.ok === false && blocked.code === 'LOCKED'
        && ok.ok === true && transit._st.station.get(S).name === 'B 改好了',
      `${blocked.error} → ${ok.ok ? '解锁后可改' : ok.error}`);
    transit.apply(userA, { k: 'lock.set', elemType: 'station', id: S });
    transit.releaseUserLocks(userA.id);
    const after = tryOp(transit, userB, { k: 'station.update', id: S, name: '断线后也能改' });
    check('自带锁表：releaseUserLocks（断线收工）之后锁立刻消失',
      after.ok === true && Object.keys(transit.elementLocksSnapshot()).length === 0, after.ok ? '' : after.error);
    w.raw.close();
  }

  /* ============ 5. 候车明细：destMix / waitingByDest 与 cohort 对得上 ============ */
  console.log('\n▶ 候车明细按目的地分组（waitingByLine[].destMix / waitingByDest）');
  {
    const w = makeWorld();
    const { transit, userA } = w;
    const A = transit.createStation(userA, { name: '站台', kind: 'rail', ...w.at(0) }).station.id;
    const B = transit.createStation(userA, { name: 'B 终点', kind: 'rail', ...w.at(4) }).station.id;
    const C = transit.createStation(userA, { name: 'C 终点', kind: 'rail', ...w.at(8) }).station.id;
    const line1 = transit.createLine(userA, { name: '1 号线', kind: 'rail', stops: [A, B, C] }).line;   // 两个方向都能拉
    const line2 = transit.createLine(userA, { name: '2 号线', kind: 'rail', stops: [A, C] }).line;
    const c1 = transit.lineCache.get(line1.id);
    const c2 = transit.lineCache.get(line2.id);
    const q = (cache) => [cache.queueCompanyId, cache.companyOwner];

    // 兜底桶（"不知道能坐哪条线"的人）：lineId = null，也要能进按目的地的明细
    const [q1c, q1o] = q(c1);
    const [q2c, q2o] = q(c2);
    transit._addWaiting(A, q1c, q1o, line1.id, 6, transit.clockMs, B);
    transit._addWaiting(A, q1c, q1o, line1.id, 4, transit.clockMs, C);
    transit._addWaiting(A, q2c, q2o, line2.id, 5, transit.clockMs, C);
    transit._addWaiting(A, q2c, q2o, line2.id, 3, transit.clockMs, null);    // 不知道去哪
    transit._addWaiting(A, q1c, q1o, null, 4, transit.clockMs, B);          // 兜底桶（未指定线路）
    // 时间往前走（> cohortSeconds）再补一批去 B 的人：同一个目的站、两个 cohort，明细要合并成一条
    transit.speed = 1;
    run(transit, 60);
    transit._addWaiting(A, q1c, q1o, line1.id, 2, transit.clockMs, B);

    const wl = transit.stationWaiting(A);
    const row1 = wl.waitingByLine.find((r) => r.lineId === line1.id);
    const row2 = wl.waitingByLine.find((r) => r.lineId === line2.id);
    const rowF = wl.waitingByLine.find((r) => r.lineId === null);
    check('waitingByLine 里每行都带 destMix（这条线的人分别要去哪一站）',
      !!row1 && !!row2 && !!rowF && Array.isArray(row1.destMix) && Array.isArray(row2.destMix) && Array.isArray(rowF.destMix),
      JSON.stringify((row1 || {}).destMix));

    check('1 号线的 destMix：去 B 的 6+2=8 人（两批 cohort 并成一条）+ 去 C 的 4 人，人多的排前面',
      sameMix(row1.destMix, [{ stationId: B, people: 8 }, { stationId: C, people: 4 }])
        && row1.destMix[0].name === 'B 终点' && row1.destMix[1].name === 'C 终点',
      JSON.stringify(row1.destMix));
    check('2 号线的 destMix：去 C 的 5 人 + 「不知道去哪」的 3 人（stationId=null，排最后）',
      sameMix(row2.destMix, [{ stationId: C, people: 5 }, { stationId: null, people: 3 }])
        && row2.destMix[1].name === '未知目的地',
      JSON.stringify(row2.destMix));
    check('兜底桶那一行也有 destMix（这些人是"哪个线路桶都没收"的，去向照样算得出来）',
      rowF.lineId === null && rowF.waiting === 4
        && sameMix(rowF.destMix, [{ stationId: B, people: 4 }]),
      JSON.stringify(rowF.destMix));

    check('destMix 就是 cohort 的账：逐条与原始候车批次复算的结果一致',
      sameMix(row1.destMix, cohortMix(transit, A, q1c, q1o, line1.id))
        && sameMix(row2.destMix, cohortMix(transit, A, q2c, q2o, line2.id))
        && sameMix(rowF.destMix, cohortMix(transit, A, q1c, q1o, null)),
      `1 号线 cohort ${JSON.stringify(cohortMix(transit, A, q1c, q1o, line1.id))} / destMix ${JSON.stringify(row1.destMix)}`);

    check('每条线 destMix 的人数加起来 = 这条线的 waiting（一条人都不会丢）',
      row1.destMix.reduce((s, r) => s + r.people, 0) === row1.waiting
        && row2.destMix.reduce((s, r) => s + r.people, 0) === row2.waiting
        && rowF.destMix.reduce((s, r) => s + r.people, 0) === rowF.waiting,
      `1 号线 ${row1.waiting} 人 / 2 号线 ${row2.waiting} 人 / 兜底 ${rowF.waiting} 人`);

    const wd = wl.waitingByDest;
    check('waitingByDest：整个站台按目的站汇总，并给出这些人在等哪几条线（兜底桶在 lines 里是 null）',
      sameMix(wd, [{ stationId: B, people: 12 }, { stationId: C, people: 9 }, { stationId: null, people: 3 }])
        && JSON.stringify(wd[0].lines) === JSON.stringify([line1.id, null])
        && JSON.stringify(wd[1].lines) === JSON.stringify([line1.id, line2.id])
        && JSON.stringify(wd[2].lines) === JSON.stringify([line2.id]),
      JSON.stringify(wd));
    check('waitingByDest 的人数是全站合计（= waiting），没人在等的目的站不会出现',
      wd.reduce((s, r) => s + r.people, 0) === wl.waiting && !wd.some((r) => r.stationId === A) && wl.waiting === 24,
      `合计 ${wd.reduce((s, r) => s + r.people, 0)} 人 / waiting=${wl.waiting}`);

    const pub = transit.stationPublic(transit._st.station.get(A));
    check('stationPublic 里能直接拿到这两块明细，老的字段一个没少',
      Array.isArray(pub.waitingByDest) && Array.isArray(pub.waitingByLine[0].destMix)
        && pub.waiting === 24 && Number.isFinite(pub.lost) && Number.isFinite(pub.waitSeconds)
        && Array.isArray(pub.waitingByCompany) && pub.waitingByCompany.length === 1,
      `waiting=${pub.waiting} / byDest=${pub.waitingByDest.length} 条 / byLine=${pub.waitingByLine.length} 条`);

    // 250 ms 快照：只有"有人在等"的车站才带这两块（空站一个字段都不多花）
    const snap = transit.snapshot();
    const snapA = snap.stations.find((s) => s.id === A);
    const snapB = snap.stations.find((s) => s.id === B);
    check('快照里只有"有人在等"的车站带 destMix / waitingByDest（空站不带，帧不会变大）',
      !!snapA && Array.isArray(snapA.waitingByDest) && Array.isArray(snapA.waitingByLine[0].destMix)
        && !!snapB && snapB.waitingByDest === undefined && snapB.waitingByLine === undefined,
      `A 有明细（${snapA && snapA.waitingByDest && snapA.waitingByDest.length} 条）/ B 没有（waitingByDest=${snapB && snapB.waitingByDest}）`);

    // 乘客上车之后：被拉走的那部分要从明细里同步消失（明细=当下还站在站台上的人）
    const veh1 = transit.createVehicle(userA, { kind: 'metro_b4', lineId: line1.id }).vehicle;
    const rt = transit._runtimeFor(veh1.id);
    transit._dock(transit._st.vehicle.get(veh1.id), c1, rt, c1.path, c1.stops.find((s) => s.stationId === A));
    const wl2 = transit.stationWaiting(A);
    const row1b = wl2.waitingByLine.find((r) => r.lineId === line1.id);
    const rowFb = wl2.waitingByLine.find((r) => r.lineId === null);
    check('车拉走一批人之后，destMix 跟着候车批次一起减（明细不是历史累计）',
      rt.lastBoarded === 16 && row1b.waiting === 0 && row1b.destMix.length === 0
        && rowFb.waiting === 0 && rowFb.destMix.length === 0
        && sameMix(wl2.waitingByDest, [{ stationId: C, people: 5 }, { stationId: null, people: 3 }]),
      `本站上客 ${rt.lastBoarded} 人 / 1 号线剩 ${row1b.waiting} 人 / 站台明细 ${JSON.stringify(wl2.waitingByDest)}`);
    w.raw.close();
  }
} catch (err) {
  console.error('\n测试异常终止:', err && err.stack ? err.stack : err);
  failed += 1;
  failures.push('异常: ' + (err && err.message));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('\n' + '─'.repeat(52));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) { console.log('\n失败项：'); for (const f of failures) console.log('  · ' + f); }
console.log('─'.repeat(52) + '\n');
process.exit(failed ? 1 : 0);
