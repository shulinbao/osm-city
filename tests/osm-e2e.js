'use strict';
/**
 * OSM 编辑器端到端测试：真实启动服务器 + 两个玩家连接，验证
 * 视口查询 / 编辑操作 / 版本冲突 / 元素锁 / 撤销重做 / 变更集回滚 / 导出 / 重启持久化。
 *
 *   node tests/osm-e2e.js
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 8901);
const DATA_DIR = path.join(ROOT, 'tests', 'tmp-osm');
const DB = path.join(DATA_DIR, 'osm.sqlite');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'tiny.osm');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, token) {
  const res = await fetch(BASE + pathname, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

function startServer() {
  return spawn(process.execPath, [
    'server/index.js', '--port', String(PORT), '--data', DATA_DIR, '--osm', DB,
  ], { cwd: ROOT, stdio: 'ignore' });
}

async function waitHealth(timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('服务器启动超时');
    await sleep(200);
  }
}

function connectWS(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
    const queue = [];
    const waiters = [];
    const client = {
      ws,
      closed: null,
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
      waitAny(pred, ms = 3000) { return client.wait(pred, ms, 'any').catch(() => null); },
      op(opObj, ms = 15000) {
        const id = 'o' + Math.random().toString(36).slice(2, 9);
        ws.send(JSON.stringify({ t: 'op', id, op: opObj }));
        return client.wait((m) => m.t === 'ack' && m.id === id, ms, 'ack ' + opObj.k);
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
      waitClose(ms = 3000) {
        if (client.closed) return Promise.resolve(client.closed);
        return new Promise((resolve) => {
          const t0 = Date.now();
          const timer = setInterval(() => {
            if (client.closed || Date.now() - t0 > ms) { clearInterval(timer); resolve(client.closed); }
          }, 40);
        });
      },
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
    ws.addEventListener('close', (ev) => { client.closed = { code: ev.code, reason: ev.reason }; });
  });
}

const opOf = (ack, kind) => (ack.ops || []).find((o) => o.k === kind) || null;

/* --------------------------------- 主流程 --------------------------------- */
(async () => {
  console.log('\n=== OSM 编辑器 · 端到端测试 ===\n');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('▶ 用测试夹具导入 OSM 数据');
  const imp = spawnSync(process.execPath, ['tools/import-osm.js', '--file', FIXTURE, '--db', DB, '--quiet'], { cwd: ROOT, stdio: 'ignore' });
  check('导入器执行成功', imp.status === 0, 'exit=' + imp.status);

  let server = startServer();
  let health = await waitHealth();
  check('服务器启动并载入数据集', health.ok === true && health.data.ways === 2,
    `节点 ${health.data.nodes} / 道路 ${health.data.ways} / 关系 ${health.data.relations}`);

  /* ------------------------------ 账号 ------------------------------ */
  console.log('\n▶ 账号与鉴权');
  const nameA = '编辑者甲' + Math.floor(Math.random() * 1000);
  const nameB = '编辑者乙' + Math.floor(Math.random() * 1000);
  const regA = await post('/api/register', { name: nameA, password: 'pass1234' });
  const regB = await post('/api/register', { name: nameB, password: 'pass5678' });
  const tokenA = regA.data.token;
  const tokenB = regB.data.token;
  check('注册两个账号', regA.status === 200 && regB.status === 200);
  /**
   * 游客登录的回归护栏：这台测试服务器用的是**正式 config.json**（allowGuests=false），
   * 所以 `POST /api/guest` 必须是 403 + 那句中文。想放开游客去跑别的套件的那一套
   * （--allow-guests / DSH_ALLOW_GUESTS=1）不该泄漏到"默认配置"这一档上。
   */
  const guestOff = await post('/api/guest');
  check('默认配置下游客登录已关闭（POST /api/guest → 403 + 中文提示）',
    guestOff.status === 403 && /已关闭游客登录/.test(String(guestOff.data && guestOff.data.error)),
    `HTTP ${guestOff.status} ${JSON.stringify(guestOff.data)}`);
  const noAuth = await api('/api/map?minLon=116.39&minLat=39.89&maxLon=116.42&maxLat=39.92');
  check('未登录读取地图数据被拒绝', noAuth.status === 401);
  const badBbox = await api('/api/map?minLon=1&minLat=2&maxLon=0&maxLat=0', tokenA);
  check('非法 bbox 被拒绝', badBbox.status === 400);

  /* ------------------------------ 视口查询 ------------------------------ */
  console.log('\n▶ 视口查询与显示分级');
  const view = await api('/api/map?minLon=116.39&minLat=39.89&maxLon=116.42&maxLat=39.92&zoom=16', tokenA);
  // 紧凑载荷（server/osmdb.js 的「紧凑载荷」）：节点在列式 nodePack 里，没有 nodePack 才是老的 nodes 字典
  const viewNodes = view.data.nodePack ? (view.data.nodePack.ids || []).length : Object.keys(view.data.nodes || {}).length;
  check('读到视口内的要素', view.status === 200 && Object.keys(view.data.ways).length === 2,
    `ways=${Object.keys(view.data.ways).length} nodes=${viewNodes}`);
  check('POI 节点带标签下发', !!(view.data.nodeTags && view.data.nodeTags['1'] && view.data.nodeTags['1'].highway === 'bus_stop'),
    JSON.stringify(view.data.nodeTags && view.data.nodeTags['1']));
  check('关系随成员一并下发', !!view.data.relations['400'], JSON.stringify(Object.keys(view.data.relations)));
  const viewLow = await api('/api/map?minLon=116.39&minLat=39.89&maxLon=116.42&maxLat=39.92&zoom=10', tokenA);
  check('低缩放不下发小路/建筑（分级显示）', Object.keys(viewLow.data.ways).length === 0,
    `z10 ways=${Object.keys(viewLow.data.ways).length}`);

  const el = await api('/api/element?type=way&id=200', tokenA);
  check('读取单个元素（含几何）', el.status === 200 && el.data.element.closed === true && el.data.element.coords.length === 5,
    `closed=${el.data.element.closed} coords=${el.data.element.coords.length}`);
  const elRel = await api('/api/element?type=relation&id=400', tokenA);
  check('读取关系（含成员）', elRel.status === 200 && elRel.data.element.members.length === 1);
  const el404 = await api('/api/element?type=way&id=999999', tokenA);
  check('读取不存在的元素返回 404', el404.status === 404);

  const s1 = await api('/api/search?name=' + encodeURIComponent('测试路'), tokenA);
  check('按名称搜索能命中真实道路', s1.data.results.some((r) => r.type === 'way' && r.id === 100),
    JSON.stringify(s1.data.results.map((r) => r.id)));
  const s2 = await api('/api/search?key=highway&value=bus_stop', tokenA);
  check('按标签搜索能命中 POI', s2.data.results.some((r) => r.type === 'node' && r.id === 1));
  const exp = await fetch(BASE + '/api/export?token=' + tokenA);
  const expText = await exp.text();
  check('导出 .osm 文件结构正确', exp.status === 200 && expText.includes('<way id="100"') && expText.trim().endsWith('</osm>'));

  /* ------------------------------ 连接 ------------------------------ */
  console.log('\n▶ 多玩家连接与实时同步');
  const A = await connectWS(tokenA);
  const welcomeA = await A.wait((m) => m.t === 'welcome', 8000, 'welcome A');
  check('玩家甲收到 welcome（含数据集信息与变更集）', !!welcomeA.info && !!welcomeA.changesetId,
    `changeset #${welcomeA.changesetId}`);
  const B = await connectWS(tokenB);
  const welcomeB = await B.wait((m) => m.t === 'welcome', 8000, 'welcome B');
  check('玩家乙收到 welcome', !!welcomeB.info);
  const badToken = await connectWS('nope');
  const badMsg = await badToken.waitAny((m) => m.t === 'error', 3000);
  const badClosed = await badToken.waitClose(3000);
  check('无效 token 被拒绝并断开', !!badMsg && !!badClosed && badClosed.code === 4001, JSON.stringify(badClosed));

  /* ------------------------------ 编辑：点 ------------------------------ */
  console.log('\n▶ 编辑点要素');
  const ackNode = await A.op({ k: 'createNode', lat: 39.9055, lon: 116.4055, tags: { amenity: 'restaurant', name: '测试面馆' } });
  const newNode = ackNode.ok ? opOf(ackNode, 'nodeCreate').node : null;
  check('新建点要素成功', !!newNode && newNode.id > 0, JSON.stringify(newNode));
  const nodeAtB = await B.wait((m) => m.t === 'ops' && (m.ops || []).some((o) => o.k === 'nodeCreate'), 5000, 'broadcast nodeCreate');
  check('新点要素实时广播给其他玩家', nodeAtB.ops.some((o) => o.k === 'nodeCreate' && o.node.id === newNode.id));

  const ackMove = await A.op({ k: 'updateNode', id: newNode.id, version: newNode.version, lat: 39.9060, lon: 116.4060 });
  check('移动点要素成功且版本号递增', ackMove.ok && opOf(ackMove, 'nodeUpdate').node.version === newNode.version + 1);
  const conflict = await A.op({ k: 'updateNode', id: newNode.id, version: newNode.version, lat: 39.9070, lon: 116.4070 });
  check('用过期版本号修改被拒绝（冲突检测）', conflict.ok === false && conflict.code === 'CONFLICT', conflict.error);
  const badCoord = await A.op({ k: 'createNode', lat: 999, lon: 0 });
  check('非法坐标被拒绝', badCoord.ok === false);

  /* ------------------------------ 编辑：道路 ------------------------------ */
  console.log('\n▶ 编辑道路/区域');
  const housePoints = [
    { lat: 39.9060, lon: 116.4100 },
    { lat: 39.9060, lon: 116.4106 },
    { lat: 39.9064, lon: 116.4106 },
    { lat: 39.9064, lon: 116.4100 },
    { lat: 39.9060, lon: 116.4100 },
  ];
  const ackWay = await A.op({ k: 'createWay', points: housePoints, tags: { building: 'yes', 'building:levels': '6' } });
  const newWay = ackWay.ok ? opOf(ackWay, 'wayCreate').way : null;
  const createdNodes = (ackWay.ops || []).filter((o) => o.k === 'nodeCreate').length;
  check('用坐标数组新建闭合区域（自动建节点）', !!newWay && newWay.closed === true && createdNodes === 4,
    `way#${newWay && newWay.id} 自动建了 ${createdNodes} 个节点`);
  const wayInfo = await api(`/api/element?type=way&id=${newWay.id}`, tokenA);
  check('新区域的几何与面积信息正确', wayInfo.data.element.coords.length === 5 && wayInfo.data.element.length > 100,
    `长度 ${wayInfo.data.element.length} m`);
  const tagged = await A.op({ k: 'updateWay', id: newWay.id, version: newWay.version, tags: { building: 'apartments', 'building:levels': '9', name: '测试公寓' } });
  check('修改道路标签成功', tagged.ok && opOf(tagged, 'wayUpdate').way.tags['building:levels'] === '9');
  const staleWay = await A.op({ k: 'updateWay', id: newWay.id, version: newWay.version, tags: { building: 'house' } });
  check('用过期版本号改道路被拒绝', staleWay.ok === false && staleWay.code === 'CONFLICT');

  // 分割：在中间插入一个节点后从该节点切开
  const wayNow = await api(`/api/element?type=way&id=${newWay.id}`, tokenA);
  const midNodeId = wayNow.data.element.nodes[1];
  const ackSplit = await A.op({ k: 'splitWay', id: newWay.id, version: wayNow.data.element.version, nodeId: midNodeId });
  const splitNew = ackSplit.ok ? opOf(ackSplit, 'wayCreate') : null;
  check('在节点处分割道路成功', ackSplit.ok && !!splitNew && splitNew.way.nodes[0] === midNodeId,
    `新道路 #${splitNew && splitNew.way.id}，起点是分割点`);
  const ackMerge = await A.op({ k: 'mergeWays', ids: [newWay.id, splitNew.way.id], version: splitNew.way.version, versionOf: splitNew.way.id });
  const mergedWay = ackMerge.ok ? opOf(ackMerge, 'wayUpdate').way : null;
  check('把两条道路合并回一条', ackMerge.ok && mergedWay && mergedWay.nodes.length === 5,
    `合并后 ${mergedWay && mergedWay.nodes.length} 个节点`);
  check('合并会删除被合并的那条', (ackMerge.ops || []).some((o) => o.k === 'wayDelete' && o.id === splitNew.way.id));

  // 合并节点：把两条独立道路的端点接起来
  const a = await A.op({ k: 'createWay', points: [{ lat: 39.9200, lon: 116.4200 }, { lat: 39.9205, lon: 116.4205 }], tags: { highway: 'residential' } });
  const b = await A.op({ k: 'createWay', points: [{ lat: 39.9206, lon: 116.4206 }, { lat: 39.9210, lon: 116.4210 }], tags: { highway: 'residential' } });
  const wayA = opOf(a, 'wayCreate').way;
  const wayB = opOf(b, 'wayCreate').way;
  const ackJoin = await A.op({ k: 'joinNodes', from: wayA.nodes[1], to: wayB.nodes[0] });
  const joined = await api(`/api/element?type=way&id=${wayA.id}`, tokenA);
  check('合并两个节点后道路连通且旧节点被删', ackJoin.ok && joined.data.element.nodes[1] === wayB.nodes[0],
    `${wayA.nodes[1]} → ${wayB.nodes[0]}`);

  // 删除道路会回收孤立节点
  const standaloneNode = wayA.nodes[0];
  const del = await A.op({ k: 'deleteWay', id: wayA.id, version: joined.data.element.version });
  const orphan = await api(`/api/element?type=node&id=${standaloneNode}`, tokenA);
  check('删除道路成功', del.ok && (del.ops || []).some((o) => o.k === 'wayDelete'));
  check('删除道路后只属于它的节点被回收', orphan.status === 404, 'node ' + standaloneNode);
  const sharedNode = await api(`/api/element?type=node&id=${wayB.nodes[0]}`, tokenA);
  check('仍被其它道路引用的共享节点保留', sharedNode.status === 200, 'node ' + wayB.nodes[0]);

  // 引用完整性
  const inUse = await A.op({ k: 'deleteNode', id: 1, version: 2 });
  check('删除被道路引用的节点被拒绝', inUse.ok === false && inUse.code === 'IN_USE', inUse.error);
  const cascade = await A.op({ k: 'deleteNode', id: 1, version: 2, cascade: true });
  const goneWay = await api('/api/element?type=way&id=100', tokenA);
  check('级联删除节点会一并删除引用它的道路', cascade.ok && goneWay.status === 404,
    cascade.ok ? ('way#100 → ' + goneWay.status) : cascade.error);

  /* --------------------- 合并自动接端点 / 延长道路 --------------------- */
  console.log('\n▶ 合并道路时自动接上最近端点');
  // ① 两条端点相距很近（约 9 米）的道路：应该把两个端点并成同一个路口
  const near1 = await A.op({ k: 'createWay', points: [{ lat: 39.9500, lon: 116.4500 }, { lat: 39.9505, lon: 116.4505 }], tags: { highway: 'residential' } });
  const nw1 = opOf(near1, 'wayCreate').way;
  const near2 = await A.op({ k: 'createWay', points: [{ lat: 39.95058, lon: 116.45058 }, { lat: 39.9510, lon: 116.4510 }], tags: { highway: 'residential' } });
  const nw2 = opOf(near2, 'wayCreate').way;
  const mergedNear = await A.op({ k: 'mergeWays', ids: [nw1.id, nw2.id], version: nw2.version, versionOf: nw2.id });
  check('端点很近时合并成功并自动并成一个路口',
    mergedNear.ok && mergedNear.merged && mergedNear.merged.snapped === true && mergedNear.merged.joinedDistance === 0,
    JSON.stringify(mergedNear.merged || mergedNear.error));
  const nearMerged = await api(`/api/element?type=way&id=${nw1.id}`, tokenA);
  check('合并后节点数=3（重复的端点被合并）', nearMerged.data.element.nodes.length === 3,
    `${nearMerged.data.element.nodes.length} 个节点`);
  check('被合并掉的那个端点节点已删除', (await api(`/api/element?type=node&id=${nw2.nodes[0]}`, tokenA)).status === 404,
    'node ' + nw2.nodes[0]);

  // ② 两条端点相距较远（约 110 米）的道路：应该拼接并用一段直线接上
  const far1 = await A.op({ k: 'createWay', points: [{ lat: 39.9600, lon: 116.4600 }, { lat: 39.9605, lon: 116.4605 }], tags: { highway: 'residential' } });
  const fw1 = opOf(far1, 'wayCreate').way;
  const far2 = await A.op({ k: 'createWay', points: [{ lat: 39.9615, lon: 116.4615 }, { lat: 39.9620, lon: 116.4620 }], tags: { highway: 'residential' } });
  const fw2 = opOf(far2, 'wayCreate').way;
  const mergedFar = await A.op({ k: 'mergeWays', ids: [fw1.id, fw2.id], version: fw2.version, versionOf: fw2.id });
  check('端点相距较远时也能合并，并报告补上的缺口距离',
    mergedFar.ok && mergedFar.merged && mergedFar.merged.joinedDistance > 50,
    `缺口 ${mergedFar.merged && mergedFar.merged.joinedDistance} 米`);
  const farMerged = await api(`/api/element?type=way&id=${fw1.id}`, tokenA);
  check('桥接后节点数为两条之和（4 个）', farMerged.data.element.nodes.length === 4,
    `${farMerged.data.element.nodes.length} 个节点`);
  check('合并结果是一条连续道路（起终点来自原来的两条）',
    farMerged.data.element.nodes[0] === fw1.nodes[0] && farMerged.data.element.nodes[3] === fw2.nodes[1],
    JSON.stringify(farMerged.data.element.nodes));

  console.log('\n▶ 延长已有道路');
  const beforeExtend = farMerged.data.element;
  const extendOp = {
    k: 'updateWay', id: fw1.id, version: beforeExtend.version, tags: beforeExtend.tags,
    points: beforeExtend.nodes.map((id) => ({ id })).concat([{ lat: 39.9625, lon: 116.4625 }, { lat: 39.9630, lon: 116.4630 }]),
  };
  const extended = await A.op(extendOp);
  check('延长：在末端追加两个新节点', extended.ok === true, extended.error);
  const afterExtend = await api(`/api/element?type=way&id=${fw1.id}`, tokenA);
  check('延长后节点数 +2 且原有首尾顺序不变',
    afterExtend.data.element.nodes.length === beforeExtend.nodes.length + 2 &&
    afterExtend.data.element.nodes[0] === beforeExtend.nodes[0],
    `${beforeExtend.nodes.length} → ${afterExtend.data.element.nodes.length}`);
  const undoExtend = await A.op({ k: 'undo' });
  const afterUndoExtend = await api(`/api/element?type=way&id=${fw1.id}`, tokenA);
  check('一次 Ctrl+Z 就能撤销整个延长', undoExtend.ok && afterUndoExtend.data.element.nodes.length === beforeExtend.nodes.length,
    `${afterUndoExtend.data.element.nodes.length} 个节点`);

  /* ------------------------------ 关系 ------------------------------ */
  console.log('\n▶ 关系（multipolygon）');
  const ackRel = await A.op({
    k: 'createRelation',
    members: [{ type: 'way', ref: newWay.id, role: 'outer' }],
    tags: { type: 'multipolygon', building: 'yes', name: '测试综合体' },
  });
  const newRel = ackRel.ok ? opOf(ackRel, 'relationCreate').relation : null;
  check('新建多面体关系成功', !!newRel && newRel.members.length === 1, JSON.stringify(newRel && newRel.id));
  const badRel = await A.op({ k: 'createRelation', members: [{ type: 'way', ref: newWay.id, role: 'outer' }], tags: { name: '缺少 type' } });
  check('关系缺少 type 标签被拒绝', badRel.ok === false, badRel.error);
  const updRel = await A.op({ k: 'updateRelation', id: newRel.id, version: newRel.version, members: [{ type: 'way', ref: newWay.id, role: 'inner' }] });
  check('修改关系成员角色成功', updRel.ok && opOf(updRel, 'relationUpdate').relation.members[0].role === 'inner');
  const missingMember = await A.op({ k: 'updateRelation', id: newRel.id, version: newRel.version + 1, members: [{ type: 'way', ref: 999999, role: 'outer' }] });
  check('关系引用不存在的成员被拒绝', missingMember.ok === false, missingMember.error);

  /* ------------------------------ 元素锁 ------------------------------ */
  console.log('\n▶ 元素锁与协作状态');
  B.send({ t: 'lock', elemType: 'relation', id: newRel.id, on: true });
  const lockMsg = await B.wait((m) => m.t === 'lockResult' && m.id === newRel.id, 4000, 'lockResult');
  check('玩家乙成功锁定关系', lockMsg.locked === false);
  const lockBroadcast = await A.waitAny((m) => m.t === 'locks' && m.locks && m.locks['relation:' + newRel.id], 4000);
  check('锁状态广播给其他玩家', !!lockBroadcast, JSON.stringify(lockBroadcast && lockBroadcast.locks));
  const lockedEdit = await A.op({ k: 'updateRelation', id: newRel.id, version: newRel.version + 1, tags: { type: 'multipolygon', name: '被锁住也要改' } });
  check('别人锁定的元素改不动', lockedEdit.ok === false && lockedEdit.code === 'LOCKED', lockedEdit.error);
  B.send({ t: 'lock', elemType: 'relation', id: newRel.id, on: false });
  await B.waitAny((m) => m.t === 'lockResult' && m.locked === false, 3000);
  const afterUnlock = await A.op({ k: 'updateRelation', id: newRel.id, version: newRel.version + 1, tags: { type: 'multipolygon', building: 'yes', name: '解锁后改名' } });
  check('解锁后可以修改', afterUnlock.ok === true, afterUnlock.error);

  /* ------------------------------ 批量与撤销 ------------------------------ */
  console.log('\n▶ 批量操作 / 撤销 / 重做');
  const n1 = opOf(await A.op({ k: 'createNode', lat: 39.9300, lon: 116.4300, tags: { amenity: 'cafe' } }), 'nodeCreate').node;
  const n2 = opOf(await A.op({ k: 'createNode', lat: 39.9310, lon: 116.4310, tags: { amenity: 'bank' } }), 'nodeCreate').node;
  const depthBefore = (await A.op({ k: 'createNode', lat: 39.9320, lon: 116.4320, tags: { amenity: 'atm' } })).undoDepth;
  const ackBatch = await A.op({
    k: 'batch',
    label: '整体移动两个点',
    ops: [
      { k: 'updateNode', id: n1.id, version: n1.version, lat: n1.lat + 0.001, lon: n1.lon + 0.001 },
      { k: 'updateNode', id: n2.id, version: n2.version, lat: n2.lat + 0.001, lon: n2.lon + 0.001 },
    ],
  });
  check('批量操作一次往返完成两步编辑', ackBatch.ok && (ackBatch.ops || []).length === 2, `ops=${(ackBatch.ops || []).length}`);
  check('批量操作在撤销栈里只占一步', ackBatch.undoDepth === depthBefore + 1, `${depthBefore} → ${ackBatch.undoDepth}`);
  const undo = await A.op({ k: 'undo' });
  const n1AfterUndo = await api(`/api/element?type=node&id=${n1.id}`, tokenA);
  check('撤销把两个点一起还原', undo.ok && Math.abs(n1AfterUndo.data.element.lat - n1.lat) < 1e-9,
    `${n1AfterUndo.data.element.lat} vs ${n1.lat}`);
  const redo = await A.op({ k: 'redo' });
  const n1AfterRedo = await api(`/api/element?type=node&id=${n1.id}`, tokenA);
  check('重做再次应用改动', redo.ok && Math.abs(n1AfterRedo.data.element.lat - (n1.lat + 0.001)) < 1e-9,
    String(n1AfterRedo.data.element.lat));
  check('撤销/重做可继续的步数被返回', typeof redo.undoDepth === 'number' && typeof redo.redoDepth === 'number',
    `undo=${redo.undoDepth} redo=${redo.redoDepth}`);

  /* ------------------------------ 变更集回滚 ------------------------------ */
  console.log('\n▶ 变更集与回滚');
  const hist = await api('/api/history?token=' + tokenA);
  const csA = (hist.data.changesets || []).find((c) => c.author === welcomeA.user.id);
  check('历史里能看到自己的变更集', !!csA && csA.op_count > 0, `#${csA && csA.id} · ${csA && csA.op_count} 处改动`);
  const csXml = await fetch(`${BASE}/api/export/changeset/${csA.id}?token=${tokenA}`);
  const csText = await csXml.text();
  check('可导出该变更集的 osmChange', csXml.status === 200 && csText.includes('<osmChange'), csText.slice(0, 40));
  const revertByOther = await B.op({ k: 'revertChangeset', id: csA.id });
  check('服务端拒绝回滚别人的变更集', revertByOther.ok === false && revertByOther.code === 'FORBIDDEN', revertByOther.error);
  const revertOwn = await A.op({ k: 'revertChangeset', id: csA.id });
  const relAfterRevert = await api(`/api/element?type=relation&id=${newRel.id}`, tokenA);
  check('回滚后新建的关系消失', revertOwn.ok && relAfterRevert.status === 404,
    revertOwn.ok ? ('relation → ' + relAfterRevert.status) : revertOwn.error);
  const revertAgain = await A.op({ k: 'revertChangeset', id: csA.id });
  check('同一个变更集不能重复回滚', revertAgain.ok === false, revertAgain.error);

  // 回滚之后重新建一个元素，用于验证重启持久化
  const persistAck = await A.op({ k: 'createNode', lat: 39.9999, lon: 116.3999, tags: { amenity: 'cafe', name: '持久化测试点' } });
  const persistId = opOf(persistAck, 'nodeCreate').node.id;
  check('回滚后仍可继续编辑（新变更集）', persistAck.ok === true, 'node#' + persistId);

  /* ------------------------------ 聊天与位置 ------------------------------ */
  console.log('\n▶ 协作：聊天 / 位置 / 选中状态');
  A.send({ t: 'chat', text: '大家注意，我在改中关村大街' });
  const chatAtB = await B.wait((m) => m.t === 'chat', 4000, 'chat');
  check('聊天实时送达', chatAtB.text.includes('中关村') && chatAtB.from.name === nameA);
  A.send({ t: 'move', lat: 39.95, lon: 116.45 });
  const playersMsg = await B.wait((m) => m.t === 'players' && m.players.some((p) => p.id === welcomeA.user.id && p.lat === 39.95), 4000, 'players');
  check('协作者位置实时同步', !!playersMsg);
  B.send({ t: 'select', type: 'way', id: newWay.id });
  const selMsg = await A.wait((m) => m.t === 'players' && m.players.some((p) => p.select && p.select.id === newWay.id), 5000, 'select');
  check('协作者正在编辑的元素同步显示', !!selMsg);

  /* ------------------------------ 服务端保护 ------------------------------ */
  console.log('\n▶ 服务端保护：标签与操作校验');
  const unknown = await A.op({ k: 'hackThePlanet' });
  check('未知操作被拒绝', unknown.ok === false);
  const hugeTags = {};
  for (let i = 0; i < 200; i++) hugeTags['k' + i] = 'v';
  const tooManyTags = await A.op({ k: 'createNode', lat: 39.9, lon: 116.4, tags: hugeTags });
  check('标签数量超限被拒绝', tooManyTags.ok === false && /标签数量/.test(tooManyTags.error || ''), tooManyTags.error);
  const badKeyTag = await A.op({ k: 'createNode', lat: 39.9, lon: 116.4, tags: { 'bad=key': 'v' } });
  check('非法标签名被拒绝', badKeyTag.ok === false && /等号/.test(badKeyTag.error || ''), badKeyTag.error);
  const tooManyNodes = await A.op({ k: 'createWay', points: new Array(2100).fill(0).map((_, i) => ({ lat: 39.9 + i * 1e-6, lon: 116.4 })), tags: { highway: 'residential' } });
  check('道路节点数超限被拒绝', tooManyNodes.ok === false && /最多/.test(tooManyNodes.error || ''), tooManyNodes.error);

  console.log('\n▶ 服务端保护：限流');
  const burst = [];
  for (let i = 0; i < 150; i++) {
    const id = 'b' + i;
    A.ws.send(JSON.stringify({ t: 'op', id, op: { k: 'createNode', lat: 39.94 + i * 0.0001, lon: 116.44, tags: { amenity: 'bench' } } }));
    burst.push(A.wait((m) => m.t === 'ack' && m.id === id, 20000, id).catch(() => null));
  }
  const results = await Promise.all(burst);
  const limited = results.some((r) => r && r.ok === false && /太快/.test(r.error || ''));
  check('突发大量操作被限流', limited, `成功 ${results.filter((r) => r && r.ok).length} / 被限 ${results.filter((r) => r && !r.ok).length}`);

  /* ------------------------------ 持久化 ------------------------------ */
  console.log('\n▶ 持久化与重启');
  A.close();
  B.close();
  await sleep(600);
  const beforeRestart = await api('/api/health');
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 4000);
    server.on('exit', () => { clearTimeout(t); resolve(); });
  });
  await sleep(300);
  server = startServer();
  health = await waitHealth();
  check('重启后数据一致', health.data.ways === beforeRestart.data.data.ways && health.data.nodes === beforeRestart.data.data.nodes,
    `ways ${beforeRestart.data.data.ways} → ${health.data.ways}，nodes ${beforeRestart.data.data.nodes} → ${health.data.nodes}`);
  const relLogin = await post('/api/login', { name: nameA, password: 'pass1234' });
  const persisted = await api(`/api/element?type=node&id=${persistId}`, relLogin.data.token);
  check('重启后编辑过的元素仍在', persisted.status === 200 && persisted.data.element.tags.name === '持久化测试点',
    JSON.stringify(persisted.data.element && persisted.data.element.tags));
  const persistedHist = await api('/api/history?token=' + relLogin.data.token);
  check('重启后编辑历史仍在', (persistedHist.data.changesets || []).length > 0,
    `${(persistedHist.data.changesets || []).length} 个变更集`);
  const C = await connectWS(relLogin.data.token);
  await C.wait((m) => m.t === 'welcome', 8000, 'welcome C');
  const undoNothing = await C.op({ k: 'undo' });
  check('重启后撤销栈清空（内存态不复原）', undoNothing.ok === false && /没有可撤销/.test(undoNothing.error), undoNothing.error);
  C.close();

  server.kill('SIGTERM');
  await sleep(400);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log('\n' + '─'.repeat(52));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  · ' + f);
  }
  console.log('─'.repeat(52) + '\n');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\n测试异常终止:', err);
  process.exit(1);
});
