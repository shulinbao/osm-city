'use strict';
/**
 * **版本冲突自愈 · 两客户端端到端用例**（真实服务器 + 真实客户端模块）。
 *
 * 复现并回归的真实用户 bug：
 *   删除某些节点永远失败，报「节点 #27486601 已被 Herman Lee 修改（版本 14）」，
 *   而且怎么点都删不掉（客户端发的是过期的版本号，冲突之后既不刷新也不重试）。
 *
 * 这个用例的两个客户端不是"裸 WebSocket"，而是把 **public/js 里的真模块**
 * （util / net / world / mapdata / editor）装进一个最小 DOM 里跑（见 tests/client-vm.js）——
 * 于是断言的正是浏览器里那一份代码：真 `World.mergePayload`、真 `Net.op`、
 * 真 `Editor.select / deleteSelection / deleteAt`、真冲突自愈。
 *
 * 覆盖：
 *   1. 结构性证据：视口载荷**不带节点版本号**（紧凑载荷只有 ids/lat/lon 三列），
 *      客户端把从地图上载入的节点记成 version 0，而服务端真实版本是 1、2、3…（道路却有版本号）；
 *   2. 用**过期版本**删除 → 服务端回 CONFLICT（就是用户看到的那句话）+ 结构化 conflict 回执；
 *      再用同一个过期版本重试 → 还是同一句冲突、节点还在（"怎么点都删不掉"）；
 *   3. 修复后的行为：`Editor.deleteSelection()` 冲突后自动刷新 + **自动重放一次** → 删除成功，
 *      中文提示说清"被谁改过、版本是多少"，且只重放了一次；
 *   4. 预防：选中一个本地版本未知的节点时补一次 `/api/element` → 删除**第一次就成功**、没有冲突；
 *   5. 级联：节点被道路引用时的版本冲突，冲突的是**节点**的版本（道路版本本来就是对的，服务端级联时不校验道路版本）；
 *   6. 所有权不是权限：甲的节点乙照样能删；
 *   7. **权限错误不被自愈吞掉**：别人锁着的节点 → LOCKED 原样抛出、不重试、不刷新；
 *      解锁后再删一次即成功（说明恢复后本地状态是可用的，不会"卡死在失败"）。
 *
 *   node tests/version-conflict-e2e.js
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeClient, serverElement } = require('./client-vm');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.VC_PORT || 8921);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = path.join(ROOT, 'tests', 'tmp-versionfix');
const DB = path.join(DIR, 'osm', 'osm.sqlite');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'tiny.osm');
/** 测试视野（覆盖夹具节点 1/2/3 与本次新建的所有要素） */
const BOX = { minLon: 116.393, minLat: 39.895, maxLon: 116.415, maxLat: 39.912 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

function startServer() {
  return spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--data', DIR, '--osm', DB],
    { cwd: ROOT, stdio: 'ignore' });
}

async function waitHealth(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try { const res = await fetch(BASE + '/api/health'); if (res.ok) return await res.json(); } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('服务器启动超时');
    await sleep(200);
  }
}

const lastToast = (c) => (c.toasts.length ? c.toasts[c.toasts.length - 1].message : '');
const toastText = (c) => c.toasts.map((t) => t.message).join(' ｜ ');
const hasToast = (c, needle) => c.toasts.some((t) => t.message.includes(needle));
/**
 * 关掉"选中即补版本号"这一层（editor.js 的 _learnVersion），**强制走冲突自愈那条兜底路**：
 * 兜底路必须自己也能走通，不能只靠"提前补版本号"把冲突绕过去。
 * 先存一份原实现，后面用 enableLearn() 还原。
 */
function disableLearn(c) {
  c.eval('window.G.__learnVersionSaved = window.G.Editor._learnVersion; window.G.Editor._learnVersion = () => false;');
}
function enableLearn(c) {
  c.eval('window.G.Editor._learnVersion = window.G.__learnVersionSaved;');
}

/** 轮询等待一个（可能是异步的）条件 */
async function waitUntil(pred, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await pred()); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
    await sleep(30);
  }
}

/* --------------------------------- 主流程 --------------------------------- */
(async () => {
  console.log('\n=== 版本冲突自愈 · 两客户端端到端 ===\n');

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'osm'), { recursive: true });
  console.log('▶ 导入测试夹具到**数据集副本**（不碰 data/osm/osm.sqlite）');
  const imp = spawnSync(process.execPath, ['tools/import-osm.js', '--file', FIXTURE, '--db', DB, '--quiet'],
    { cwd: ROOT, stdio: 'ignore' });
  check('夹具导入成功', imp.status === 0, 'exit=' + imp.status);

  let server = startServer();
  const health = await waitHealth();
  check('自己的服务器实例已就绪（端口 ' + PORT + '，数据副本 ' + path.relative(ROOT, DB) + '）',
    health.ok === true && health.data.ways === 2, `nodes=${health.data.nodes} ways=${health.data.ways}`);

  const nameA = '甲' + Math.floor(Math.random() * 100000);
  const nameB = '乙' + Math.floor(Math.random() * 100000);
  const regA = (await post('/api/register', { name: nameA, password: 'pass1234' })).data;
  const regB = (await post('/api/register', { name: nameB, password: 'pass5678' })).data;
  check('注册两个玩家', !!regA.token && !!regB.token, `${nameA} / ${nameB}`);
  const waitGone = (type, id) => waitUntil(async () => (await serverElement(BASE, regA.token, type, id)) === null,
    10000, `${type} #${id} 在服务端消失`);

  /* =============================== ① 结构性证据 =============================== */
  console.log('\n▶ ① 视口载荷里到底有没有节点版本号');
  const rawRes = await fetch(`${BASE}/api/map?minLon=${BOX.minLon}&minLat=${BOX.minLat}&maxLon=${BOX.maxLon}&maxLat=${BOX.maxLat}`
    + `&zoom=16&token=${encodeURIComponent(regA.token)}`);
  const raw = await rawRes.json();
  const packKeys = raw.nodePack ? Object.keys(raw.nodePack).sort().join(',') : '(没有紧凑载荷)';
  check('紧凑载荷的节点列**只有** ids/lat/lon（没有版本号这一列）', packKeys === 'ids,lat,lon', 'nodePack 列 = ' + packKeys);
  check('节点字典形状是 [lat, lon]（没有第三个位置放版本号）',
    !raw.nodes || Object.values(raw.nodes).every((v) => Array.isArray(v) && v.length === 2),
    raw.nodes ? `样例 ${JSON.stringify(Object.entries(raw.nodes)[0])}` : '（本次是紧凑载荷，见上一项）');
  check('道路是**带版本号**的（ways[id][0]）', Number.isFinite(Number(raw.ways[100] && raw.ways[100][0])),
    'way 100 version=' + (raw.ways[100] && raw.ways[100][0]));

  /* =============================== ② 甲的准备动作 =============================== */
  console.log('\n▶ ② 甲（登录中的第一个玩家）先造素材：乙还没上线，所以乙只知道"地图上有什么"');
  const A = makeClient({ base: BASE, token: regA.token, name: nameA });
  await A.connect();
  check('甲的真客户端连上（net.js + WebSocket）', A.Net.connected === true);

  const mkWay = async (lat, lon, name) => {
    const ack = await A.op({ k: 'createWay', points: [{ lat, lon }, { lat: lat + 0.0005, lon: lon + 0.0005 }], tags: { highway: 'residential', name } });
    if (!ack.ok) throw new Error('建路失败: ' + ack.error);
    return (ack.ops || []).find((o) => o.k === 'wayCreate').way;
  };

  const W1 = await mkWay(39.9055, 116.4055, '冲突测试路1');   // 节点 X/Y（乙要删 X）
  const X = W1.nodes[0];
  const W2 = await mkWay(39.9075, 116.4095, '冲突测试路2');   // 节点 P/Q（预防：选中即补版本号）
  const P = W2.nodes[0];
  const W3 = await mkWay(39.9085, 116.4115, '冲突测试路3');   // 节点 R/S（所有权：乙删甲的节点）
  const R = W3.nodes[0];
  const W4 = await mkWay(39.9045, 116.4125, '冲突测试路4');   // 节点 L/M（备用素材）
  const L = W4.nodes[0];
  const W5 = await mkWay(39.9035, 116.4005, '冲突测试路5');   // 权限场景：乙拿着视口给的（过期）道路版本去删
  const W6 = await mkWay(39.9025, 116.4035, '冲突测试路6');   // 批量场景：两个节点都属于"乙只知道版本 0"的那一类
  const W7 = await mkWay(39.9015, 116.4015, '冲突测试路7');
  const N1 = W6.nodes[0];
  const N2 = W7.nodes[0];
  check('甲新建 7 条道路（每条自动建 2 个节点）', W1.nodes.length === 2 && W7.nodes.length === 2, `W1#${W1.id} W5#${W5.id} W6#${W6.id} W7#${W7.id}`);

  // X 再改一次 → 服务端版本 2、最后编辑者=甲（乙从没见过这个过程）
  const ackX = await A.op({ k: 'updateNode', id: X, version: 1, tags: { amenity: 'cafe', name: '冲突测试点' } });
  check('甲把 X 改成版本 2（最后编辑者=甲）', ackX.ok && ackX.ops.some((o) => o.k === 'nodeUpdate' && o.node.version === 2), ackX.error || '');

  // 批量场景的两个节点也由甲改到版本 2（都在乙上线之前，乙只会从视口拿到版本 0）
  const ackN1 = await A.op({ k: 'updateNode', id: N1, version: 1, tags: { amenity: 'bench', name: '批量甲' } });
  const ackN2 = await A.op({ k: 'updateNode', id: N2, version: 1, tags: { amenity: 'bench', name: '批量乙' } });
  check('甲把批量场景的两个节点都改到版本 2', ackN1.ok === true && ackN2.ok === true, ackN1.error || ackN2.error || '');

  // 夹具节点 1（被 way#100 引用，夹具里就是 version 2）→ 甲改成 version 3（级联场景用）
  const fixNode1 = await serverElement(BASE, regA.token, 'node', 1);
  const ackFix = await A.op({ k: 'updateNode', id: 1, version: fixNode1.version, tags: Object.assign({}, fixNode1.tags, { name: '被道路引用的点' }) });
  check('甲把夹具节点 1 改到版本 3', ackFix.ok === true, ackFix.error || `version ${fixNode1.version} → 3`);

  // 甲锁住 L（权限场景备用素材；注意实测：服务端 _deleteNode **不查元素锁**，见 ⑨ 的说明）
  A.Net.lock('node', L, true);
  await sleep(200);

  const srvX = await serverElement(BASE, regA.token, 'node', X);
  const srvP = await serverElement(BASE, regA.token, 'node', P);
  const srvNode1 = await serverElement(BASE, regA.token, 'node', 1);

  /* =============================== ③ 乙上线并只通过视口认识地图 =============================== */
  console.log('\n▶ ③ 乙上线：只用 /api/map 视口载荷认识地图（真实的握手路径）');
  const B = makeClient({ base: BASE, token: regB.token, name: nameB });
  await B.connect();
  const vp = await B.loadViewport(BOX, 16);
  const worldX = B.world('node', X);
  const worldWay1 = B.world('way', W1.id);
  const worldNode1 = B.world('node', 1);
  const worldWay100 = B.world('way', 100);
  check('乙本地缓存里 X 的版本号是 0 —— 而服务端是 ' + srvX.version,
    worldX && Number(worldX.version) === 0 && srvX.version === 2, `本地 ${worldX && worldX.version} / 服务端 ${srvX.version}`);
  check('同一个载荷里**道路**的版本号是对的（way 100 本地=服务端）',
    worldWay100 && Number(worldWay100.version) === 4, `本地 ${worldWay100 && worldWay100.version} / 服务端 4`);
  check('乙本地缓存里夹具节点 1 的版本号同样是 0（服务端 ' + srvNode1.version + '）',
    worldNode1 && Number(worldNode1.version) === 0, `本地 ${worldNode1 && worldNode1.version}`);

  await B.loadViewport(BOX, 16);         // 再取一次视口（相当于玩家拖了一圈回来 / 刷新页面）
  check('**重新加载视口也补不上版本号**（载荷里根本没有这个字段）→ 这就是"怎么点都删不掉"',
    Number(B.world('node', X).version) === 0, '第二次视口合并后仍是 ' + B.world('node', X).version);

  /* =============================== ④ 复现用户报的错 =============================== */
  console.log('\n▶ ④ 复现：「节点已被 <最后编辑者> 修改」且反复失败');
  const staleVersion = Number(B.world('node', X).version);
  check('客户端手里那个过期版本号就是 0（服务端是 ' + srvX.version + '）', staleVersion === 0, 'stale=' + staleVersion);
  const conflict1 = await B.tryOp({ k: 'deleteNode', id: X, version: staleVersion, cascade: true });
  check('用本地这个过期版本删除 → 服务端判冲突（正是用户看到的那句话）',
    conflict1.ok === false && conflict1.code === 'CONFLICT', conflict1.message);
  check('冲突消息里点名了"谁改的"和"服务端当前版本"',
    conflict1.message.includes(nameA) && conflict1.message.includes(String(srvX.version)),
    conflict1.message);
  check('回执里带上了结构化 conflict（客户端不用再猜该刷新谁）',
    conflict1.conflict && conflict1.conflict.type === 'node' && conflict1.conflict.id === X
      && conflict1.conflict.version === srvX.version && conflict1.conflict.editorName === nameA
      && conflict1.conflict.yourVersion === 0,
    JSON.stringify(conflict1.conflict));

  const conflict2 = await B.tryOp({ k: 'deleteNode', id: X, version: staleVersion, cascade: true });
  check('老客户端就是这么重试的：同一个过期版本再点一次 → 还是同一句冲突',
    conflict2.ok === false && conflict2.code === 'CONFLICT', conflict2.message);
  check('节点还在服务器上（用户视角："这个节点怎么点都删不掉"）',
    !!(await serverElement(BASE, regA.token, 'node', X)));

  /* =============================== ⑤ 冲突自愈：刷新 + 自动重放一次 =============================== */
  console.log('\n▶ ⑤ 修复后的行为：真 Editor.deleteSelection()');
  // 关掉"选中即补版本号"，强制走冲突自愈这条路（这条路径是兜底，必须自己也走得通）
  disableLearn(B);
  const spy = B.spyOpCalls();
  const baseCalls = spy.length;
  B.eval(`window.G.Editor.selection = { type: 'node', id: ${X} };`);
  /**
   * 注意：`Editor.deleteSelection()` 与界面上的按钮一样是**发射后不管**的
   * （它不 return 那条 promise，结果由 toast 呈现），所以这里等的是"可观察的结果"：
   * 服务端上元素消失 + 出现那句中文提示。
   */
  B.eval('window.G.Editor.deleteSelection();');
  await waitGone('node', X);
  await B.waitFor(() => hasToast(B, '已刷新为最新版本'), 8000, '自愈提示');
  const calls = spy.slice(baseCalls);
  check('删除**成功了**，没有任何错误提示（冲突没有被抛给用户）',
    B.toasts.filter((t) => t.kind === 'error').length === 0, toastText(B));
  check('一共发了 2 次操作：原来那次 + **自动重放一次**（只重放一次，不会无限循环）',
    calls.length === 2, JSON.stringify(calls));
  check('重放时用的是**服务端的最新版本号**' + srvX.version + '（不是那个过期的 0）',
    calls[1] && Number(calls[1].version) === srvX.version, JSON.stringify(calls[1]));
  check('重放保留了原来的意图（级联删除 cascade 还在）', calls[1] && calls[1].cascade === true, JSON.stringify(calls[1]));
  check('节点真的删掉了（服务端 404）', (await serverElement(BASE, regA.token, 'node', X)) === null);
  check('乙本地也同步删掉了（不需要重新加载页面）', B.eval(`!window.G.World.getNode(${X})`) === true);
  check('用中文说清了"被谁改过、版本是多少、已经重新执行"',
    hasToast(B, '刚被 ' + nameA + ' 改过') && hasToast(B, '已刷新为最新版本，并重新执行了删除'), toastText(B));
  check('提示里带上了服务端的真实版本号', hasToast(B, String(srvX.version)), lastToast(B));

  /* =============================== ⑥ 预防：选中即补版本号 =============================== */
  console.log('\n▶ ⑥ 预防：选中一个本地版本未知的节点 → 直接一次删掉，不再弹冲突');
  const ackP = await A.op({ k: 'updateNode', id: P, version: 1, tags: { amenity: 'atm', name: '甲又改了一次' } });
  check('甲在乙看着地图的时候又改了节点 P（服务端 → 版本 2）', ackP.ok === true, ackP.error || '');
  enableLearn(B);   // 恢复真实现（见 editor.js 的 _learnVersion）
  const beforeLearn = spy.length;
  const toastsBefore = B.toasts.length;
  B.eval(`window.G.Editor.select('node', ${P}, { lock: false });`);
  await B.waitFor(() => Number(B.world('node', P).version) === 2, 5000, '选中后自动补上版本号');
  check('选中之后，本地版本号被补成服务端的真实版本（不再是我们瞎猜的 0）',
    Number(B.world('node', P).version) === 2 && B.eval(`window.G.Editor._verAsked.has('node:${P}')`) === true,
    '本地 ' + B.world('node', P).version);
  B.eval(`window.G.Editor.selection = { type: 'node', id: ${P} };`);
  B.eval('window.G.Editor.deleteSelection();');
  await waitGone('node', P);
  const callsP = spy.slice(beforeLearn);
  check('删除**第一次就成功**，没有多花一次重放', callsP.length === 1, JSON.stringify(callsP));
  const newToastsP = B.toasts.slice(toastsBefore);
  check('全程没有弹任何"已被 xxx 修改 / 已刷新版本"这类冲突提示',
    !newToastsP.some((t) => t.message.includes('已刷新为最新版本')) && !newToastsP.some((t) => t.kind === 'error'),
    newToastsP.map((t) => t.message).join(' ｜ '));
  check('节点 P 已删除', (await serverElement(BASE, regA.token, 'node', P)) === null);

  /* =============================== ⑦ 级联：节点被道路引用 =============================== */
  console.log('\n▶ ⑦ 级联删除：节点被道路引用时，冲突的是**节点**的版本（服务端级联时不校验道路版本）');
  disableLearn(B);   // 再次强制走冲突自愈
  B.eval('window.G.Render.pick = () => ({ type: "node", id: 1 });');
  const beforeCascade = spy.length;
  B.eval('window.G.Editor.deleteAt({ lat: 39.9, lng: 116.4 }, true);');
  await waitGone('node', 1);
  await B.waitFor(() => hasToast(B, '已刷新为最新版本'), 8000, '级联自愈提示');
  const callsCascade = spy.slice(beforeCascade);
  check('级联删除自愈成功（没有错误提示）',
    !B.toasts.some((t) => t.kind === 'error'), toastText(B));
  check('乙本地对 way#100 的版本号本来就是对的（' + (worldWay100 && worldWay100.version) + '）→ 冲突只可能来自节点',
    Number(worldWay100.version) === 4, '本地 ' + worldWay100.version);
  check('重放用的版本号 = 节点的服务端版本 ' + srvNode1.version + '（不是道路的版本）',
    callsCascade[1] && Number(callsCascade[1].version) === srvNode1.version, JSON.stringify(callsCascade[1]));
  check('节点 1 与被它引用的道路 100 一起被级联删除（服务端）',
    (await serverElement(BASE, regA.token, 'node', 1)) === null
      && (await serverElement(BASE, regA.token, 'way', 100)) === null);
  check('乙本地也一起清掉了（节点 + 道路）',
    B.eval('!window.G.World.getNode(1)') === true && B.eval('!window.G.World.getWay(100)') === true);

  /* =============================== ⑧ 所有权不是权限 =============================== */
  console.log('\n▶ ⑧ 所有权不是权限：甲建的节点，乙照样能删');
  const srvR = await serverElement(BASE, regA.token, 'node', R);
  check('要删的这个节点在服务端确实是甲建的/最后编辑者是甲',
    !!srvR && srvR.editorName === nameA, `node #${R} editorName=${srvR && srvR.editorName}`);
  B.eval('window.G.Editor.selection = { type: "node", id: ' + R + ' };');
  const beforeOwn = spy.length;
  B.eval('window.G.Editor.deleteSelection();');
  await waitGone('node', R);
  check('乙删掉了甲建的节点 R（没有 FORBIDDEN / 没有权限错误）',
    !B.toasts.some((t) => t.kind === 'error' && /权限/.test(t.message)),
    `node #${R} 已被乙删除`);
  check('同样是先冲突（版本号过期）再自愈成功，全程只有一次重放',
    spy.slice(beforeOwn).length === 2, JSON.stringify(spy.slice(beforeOwn)));

  /* =============================== ⑨ 权限错误不被吞掉 =============================== */
  console.log('\n▶ ⑨ 别人的锁是权限问题：**不能被自愈吞掉**');
  /**
   * 用**道路**而不是节点来验这件事，原因是实测出来的服务端口径：
   * `_deleteNode` 里**没有** checkLock（删节点不看元素锁），而 `_deleteWay / _updateWay /
   * _deleteRelation / _updateRelation` 都会 checkLock。要验"权限错误不会被自愈吞掉"，
   * 就得挑一条**真的会返回权限错误**的路。
   *
   * 这个场景同时验了顺序：甲先改道路（→ 版本 2）再上锁 → 乙手里还是视口给的版本 1：
   *   ① 第一次删除 → 版本冲突 → 自愈刷新（拿到版本 2）→ 自动重放；
   *   ② 重放时版本对了，于是撞上**锁** → LOCKED；
   *   ③ 这一刻自愈必须**如实抛出 LOCKED**（不能假装删掉了、也不能无止境重试）。
   */
  /**
   * 先让乙**掉线一小会儿**再重连：断线期间甲改这条路并上锁，乙收不到那条广播 ——
   * 于是乙本地留着视口给的旧版本（1），而服务端已经是 2。
   * 这正是"上一次会话 / 断线期间别人改了"的真实形状（也是版本号过期的另一条来源）。
   */
  B.close();
  await B.waitFor(() => !B.Net.connected, 5000, '乙断线');
  const ackW5 = await A.op({ k: 'updateWay', id: W5.id, version: W5.version, tags: { highway: 'residential', name: '甲锁着的路' } });
  A.Net.lock('way', W5.id, true);
  await sleep(250);
  B.Net.connect(regB.token);
  await B.waitFor(() => B.Net.connected, 8000, '乙重连');
  const elW5 = await (await fetch(`${BASE}/api/element?type=way&id=${W5.id}&token=${encodeURIComponent(regA.token)}`)).json();
  check('甲锁住了这条道路（服务端 locks 里能看到）',
    !!(elW5.locks && elW5.locks['way:' + W5.id] && elW5.locks['way:' + W5.id].name === nameA),
    JSON.stringify(elW5.locks));
  check('服务端已改到版本 ' + elW5.element.version + '，而乙本地还是断线前那个版本 1（过期）',
    ackW5.ok === true && elW5.element.version === 2 && Number(B.world('way', W5.id).version) === 1,
    `way#${W5.id} 服务端=${elW5.element.version} 乙本地=${B.world('way', W5.id).version}`);

  enableLearn(B);   // 版本号"提前补"这一层开着也不影响：道路版本号本来就是视口给的（是过期的）
  const lockToasts = B.toasts.length;
  const beforeLock = spy.length;
  B.eval(`window.G.Editor.selection = { type: 'way', id: ${W5.id} };`);
  B.eval('window.G.Editor.deleteSelection();');
  await B.waitFor(() => B.toasts.slice(lockToasts).some((t) => t.message.includes('正在编辑这个元素')), 8000, 'LOCKED 提示');
  await sleep(300);                       // 留一点时间：万一它偷偷又重试就会被抓到
  const lockCalls = spy.slice(beforeLock);
  const lockToastsNow = B.toasts.slice(lockToasts);
  check('提示的是权限语义"甲正在编辑这个元素"，不是被换成"已刷新版本/已删除"那套话',
    lockToastsNow.some((t) => t.message.includes('正在编辑这个元素')), lockToastsNow.map((t) => t.message).join(' ｜ '));
  check('自愈确实先刷新并重放了一次（版本冲突那一层照常工作）',
    lockCalls.length === 2 && Number(lockCalls[1].version) === elW5.element.version, JSON.stringify(lockCalls));
  check('但重放撞上锁之后**就停手了**：没有第三次、也没有换成别的话术',
    lockCalls.length === 2 && !lockToastsNow.some((t) => t.message.includes('已刷新为最新版本，并重新执行了')),
    JSON.stringify(lockToastsNow.map((t) => t.message)));
  check('道路 W5 还在（没有被"自愈"弄成删除成功）', !!(await serverElement(BASE, regA.token, 'way', W5.id)));

  // 甲解锁 → 乙再点一次就成功（说明本地状态没有被卡死：版本号在上一轮已经刷新到最新）
  A.Net.lock('way', W5.id, false);
  await sleep(300);
  const beforeUnlock = spy.length;
  B.eval('window.G.Editor.deleteSelection();');
  await waitGone('way', W5.id);
  check('甲解锁后，乙**再点一次**就删掉了（不需要刷新页面，也不需要再补一次版本号）',
    (await serverElement(BASE, regA.token, 'way', W5.id)) === null, '已删除');
  check('这次只发了 1 次操作（版本号在上一轮自愈时就已经是最新的了）', spy.slice(beforeUnlock).length === 1,
    JSON.stringify(spy.slice(beforeUnlock)));

  /* =============================== ⑩ 批量操作：一轮重放完 =============================== */
  console.log('\n▶ ⑩ 批量删除（框选那条路）：多个过期元素在一轮自愈里一起解决');
  /**
   * 批量操作**不是事务**（服务端 _batch 逐条 apply），所以自愈时必须：
   *   · 只重放"还没执行的那几段"（服务端在回执里给了出错下标 index）；
   *   · 顺手把剩下那几段的元素也刷新到最新版本（小批量），否则重放到第二个又会冲突；
   *   · 把服务端"已经生效的那几条"（conflict.appliedOps）合并进本地，别让画面和服务器不一致。
   * 这两个节点在甲的编辑之后才进乙的视口（它们在建 W6/W7 之后由甲改到版本 2，而乙是在那之后
   * 才加载视口的），所以乙手里必然是那个过期的 0 —— 这一批**一定**会冲突，断言才是确定的。
   */
  check('乙手里这两个节点的版本号都是 0（服务端都是 2）→ 这一批必然冲突',
    Number(B.world('node', N1).version) === 0 && Number(B.world('node', N2).version) === 0,
    `本地 ${B.world('node', N1).version}/${B.world('node', N2).version}，服务端 2/2`);
  const beforeBatch = spy.length;
  const batchToasts = B.toasts.length;
  B.eval(`window.G.Editor.multiSelect = [{ type: 'node', id: ${N1} }, { type: 'node', id: ${N2} }];`);
  B.eval('window.G.Editor.deleteMultiSelection();');
  await waitGone('node', N1);
  await waitGone('node', N2);
  await B.waitFor(() => B.toasts.length > batchToasts && B.toasts.slice(batchToasts).some((t) => t.message.includes('已删除')), 8000, '批量删除结果');
  const batchCalls = spy.slice(beforeBatch);
  check('两个过期节点都被删掉了（服务端 404）',
    (await serverElement(BASE, regA.token, 'node', N1)) === null
      && (await serverElement(BASE, regA.token, 'node', N2)) === null);
  check('只发了两轮：整批一次 + 自愈重放一次（重放里只含"还没执行的那一段之后"）',
    batchCalls.length === 2 && batchCalls[0].k === 'batch' && batchCalls[1].k === 'batch',
    JSON.stringify(batchCalls));
  check('重放用的都是最新版本（2），不是批量开始时那两个过期的 0',
    batchCalls[1] && (batchCalls[1].subVersions || []).every((v) => Number(v) === 2),
    JSON.stringify(batchCalls));
  check('本地也同步删掉了（appliedOps 不会留下"服务端删了、屏幕还画着"的假状态）',
    B.eval(`!window.G.World.getNode(${N1}) && !window.G.World.getNode(${N2})`) === true);
  check('提示里说清了这次批量删除是被谁改过之后才重做的',
    B.toasts.slice(batchToasts).some((t) => t.message.includes(nameA)), toastText(B).slice(-200));

  /* =============================== 收尾 =============================== */
  A.close();
  B.close();
  await sleep(300);
  server.kill('SIGTERM');
  await sleep(400);
  fs.rmSync(DIR, { recursive: true, force: true });

  console.log('\n' + '─'.repeat(56));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  · ' + f);
  }
  console.log('─'.repeat(56) + '\n');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\n用例异常终止:', err);
  try { process.exit(1); } catch { /* ignore */ }
});
