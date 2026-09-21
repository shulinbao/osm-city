'use strict';
/**
 * 元素锁 × 删除 × 批量失败补偿 的端到端测试。
 *
 * 起因（两处真实漏洞）：
 *   ① `server/osmops.js` 的 `_deleteNode` **没有查元素锁**（_updateNode 与各 way/relation
 *      操作都查了），于是"对方正在编辑这个节点"时照样能把它删掉，对方的锁形同虚设；
 *      级联删除（cascade）还会顺带 hardDelete 引用它的道路/关系 —— 那同样是"删别人的东西"，
 *      也必须各自查锁。
 *   ② `server/index.js` 在批量操作**中途失败**时，只把"已经生效的那几步"
 *      （`err.conflict.appliedOps`）回执给作者端，**没有广播给其他玩家**：
 *      其他玩家的画面会一直停在旧几何上，直到自己碰巧重新拉一次视口。
 *
 * 口径（用户明确要求）：**谁能改谁不能改不看归属，只看元素锁** ——
 * 任何玩家都能改/删任何元素，唯独别人锁着的不能动；自己锁着的自己照样能删。
 *
 *   node tests/osm-lock-delete-test.js
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.LOCK_E2E_PORT || 8911);
const DATA_DIR = path.join(ROOT, 'tests', 'tmp-osm-lock');
const DB = path.join(DATA_DIR, 'osm.sqlite');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'tiny.osm');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ❌ ' + name + '  → ' + detail); }
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
      // 线上协议里锁的字段名是 `elemType`（server/index.js 的 case 'lock'）；
      // 字段不对时服务端**静默 return**（不报错也不回执），所以这里务必对齐。
      lock(type, id, on = true, ms = 8000) {
        ws.send(JSON.stringify({ t: 'lock', elemType: type, id, on }));
        return client.wait((m) => m.t === 'lockResult' && m.elemType === type && m.id === id, ms, 'lockResult');
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

const newNodeId = (ack) => {
  const o = (ack.ops || []).find((x) => x.k === 'nodeCreate');
  return o && o.node ? o.node.id : null;
};

/* --------------------------------- 主流程 --------------------------------- */
(async () => {
  console.log('\n=== 元素锁 × 删除 × 批量失败补偿 · 端到端测试 ===\n');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('▶ 用测试夹具导入 OSM 数据');
  const imp = spawnSync(process.execPath, ['tools/import-osm.js', '--file', FIXTURE, '--db', DB, '--quiet'], { cwd: ROOT, stdio: 'ignore' });
  check('导入器执行成功', imp.status === 0, 'exit=' + imp.status);

  const server = startServer();
  const health = await waitHealth();
  check('服务器启动并载入数据集', health.ok === true && health.data.ways === 2,
    `节点 ${health.data.nodes} / 道路 ${health.data.ways}`);

  const stamp = Math.floor(Math.random() * 10000);
  const regA = await post('/api/register', { name: '锁甲' + stamp, password: 'pass1234' });
  const regB = await post('/api/register', { name: '锁乙' + stamp, password: 'pass5678' });
  const regC = await post('/api/register', { name: '旁观丙' + stamp, password: 'pass9012' });
  check('注册三个账号（作者 / 对手 / 旁观者）',
    regA.status === 200 && regB.status === 200 && regC.status === 200);
  const tokenA = regA.data.token;
  const tokenB = regB.data.token;

  const A = await connectWS(regA.data.token);
  const B = await connectWS(regB.data.token);
  const C = await connectWS(regC.data.token);
  await A.wait((m) => m.t === 'welcome', 8000, 'welcome A');
  await B.wait((m) => m.t === 'welcome', 8000, 'welcome B');
  await C.wait((m) => m.t === 'welcome', 8000, 'welcome C');

  /* ------------------------- ① 锁拦住别人删除 ------------------------- */
  console.log('\n▶ ① 元素锁拦住别人删除（_deleteNode 必须查锁）');
  const made = await A.op({ k: 'createNode', lat: 39.905, lon: 116.405, tags: { name: '锁测试点' } });
  const nodeId = newNodeId(made);
  check('甲新建了一个节点', made.ok === true && Number.isFinite(nodeId), 'node #' + nodeId);

  const lockA = await A.lock('node', nodeId, true);
  check('甲把这个节点锁上', lockA.locked === false, JSON.stringify(lockA));

  const delByB = await B.op({ k: 'deleteNode', id: nodeId });
  check('乙删不掉别人锁着的节点（报 LOCKED，附"正在编辑"中文提示）',
    delByB.ok === false && delByB.code === 'LOCKED' && /正在编辑/.test(String(delByB.error)),
    `ok=${delByB.ok} code=${delByB.code} error=${delByB.error}`);
  const stillThere = await api(`/api/element?type=node&id=${nodeId}`, tokenA);
  check('被拒之后节点**确实还在**（没有删一半）', stillThere.status === 200 && !!stillThere.data.element,
    `HTTP ${stillThere.status}`);

  /* --------------------- ② 锁不拦本人（只看锁，不看归属） --------------------- */
  console.log('\n▶ ② 锁只拦别人，不拦持锁者自己');
  const delByA = await A.op({ k: 'deleteNode', id: nodeId });
  check('甲删得掉自己锁着的节点', delByA.ok === true, JSON.stringify(delByA.error || ''));

  const made2 = await A.op({ k: 'createNode', lat: 39.9055, lon: 116.4055, tags: { name: '无锁点' } });
  const freeId = newNodeId(made2);
  const delFree = await B.op({ k: 'deleteNode', id: freeId });
  check('乙删得掉甲建的、**没有锁**的节点（口径：不看归属）',
    delFree.ok === true && Number.isFinite(freeId), 'node #' + freeId);

  /* ------------------- ③ 级联删除不能抽走别人锁着的路 ------------------- */
  console.log('\n▶ ③ 级联删除要连带查引用元素的锁');
  const lockWay = await A.lock('way', 100, true);
  check('甲把夹具里的道路 #100 锁上', lockWay.locked === false, JSON.stringify(lockWay));

  const cascadeByB = await B.op({ k: 'deleteNode', id: 2, cascade: true });
  check('乙级联删节点 #2 被拦下（#2 属于被锁的 #100）',
    cascadeByB.ok === false && cascadeByB.code === 'LOCKED',
    `ok=${cascadeByB.ok} code=${cascadeByB.code} error=${cascadeByB.error}`);
  const wayAlive = await api('/api/element?type=way&id=100', tokenA);
  const node2Alive = await api('/api/element?type=node&id=2', tokenA);
  check('被拒之后道路 #100 与节点 #2 都还在（级联没有先删一半）',
    wayAlive.status === 200 && node2Alive.status === 200,
    `way HTTP ${wayAlive.status} / node HTTP ${node2Alive.status}`);

  await A.lock('way', 100, false);
  const cascadeOk = await B.op({ k: 'deleteNode', id: 2, cascade: true });
  check('甲放开锁之后，乙的同一操作立刻成功（锁是唯一拦截手段）',
    cascadeOk.ok === true, String(cascadeOk.error || ''));

  /* ------------- ④ 批量中途失败：其他玩家也要收到已生效的那几步 ------------- */
  console.log('\n▶ ④ 批量操作中途失败 → 已生效的前缀必须广播给其他玩家');
  const p1 = newNodeId(await A.op({ k: 'createNode', lat: 39.906, lon: 116.406, tags: { name: '批量甲' } }));
  const p2 = newNodeId(await A.op({ k: 'createNode', lat: 39.9065, lon: 116.4065, tags: { name: '批量乙' } }));
  check('准备好两个新节点', Number.isFinite(p1) && Number.isFinite(p2), `#${p1} / #${p2}`);

  // 旁观者丙的队列里先清掉噪声：只关心"批量前缀"那次广播
  const bystanderGot = C.wait(
    (m) => m.t === 'ops' && (m.ops || []).some((o) => o.k === 'nodeUpdate' && o.node && o.node.id === p1),
    5000, '旁观者收到已生效前缀',
  ).then(() => true).catch(() => false);

  const batchAck = await B.op({
    k: 'batch',
    label: '批量改两个点',
    ops: [
      { k: 'updateNode', id: p1, lat: 39.9070, lon: 116.4070 },            // 第 0 条：确实写进库
      { k: 'updateNode', id: p2, lat: 39.9075, lon: 116.4075, version: 999 }, // 第 1 条：版本冲突
    ],
  });
  check('批量操作整体失败（第 1 条版本冲突）',
    batchAck.ok === false && !!batchAck.conflict && batchAck.conflict.index === 1,
    `ok=${batchAck.ok} index=${batchAck.conflict && batchAck.conflict.index} error=${batchAck.error}`);
  check('回执里带上"已生效的那几条"（作者端自愈用）',
    Array.isArray(batchAck.conflict && batchAck.conflict.appliedOps)
    && batchAck.conflict.appliedOps.some((o) => o.k === 'nodeUpdate' && o.node && o.node.id === p1),
    JSON.stringify((batchAck.conflict && batchAck.conflict.appliedOps || []).map((o) => o.k)));

  const gotByBystander = await bystanderGot;
  check('旁观者（非作者）**也收到**了已生效前缀的广播（修前收不到，画面会一直停在旧几何）',
    gotByBystander === true);

  const p1Now = await api(`/api/element?type=node&id=${p1}`, tokenA);
  check('那一前缀在库里**真的生效了**（确实是"已写进库但没广播"的问题）',
    p1Now.status === 200 && Math.abs(p1Now.data.element.lat - 39.9070) < 1e-6,
    'lat=' + (p1Now.data.element && p1Now.data.element.lat));

  A.close(); B.close(); C.close();
  await sleep(400);
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 4000);
    server.on('exit', () => { clearTimeout(t); resolve(); });
  });
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
