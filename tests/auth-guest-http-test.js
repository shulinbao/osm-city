'use strict';
/**
 * 「关掉游客登录」必须**两处口径一致**：WebSocket 与 HTTP。
 *
 * 起因（真实漏洞）：`server/index.js` 的 WS 握手有两道闸（升级握手 403 + 老游客 token 拒收），
 * 但 HTTP 侧的 `requireUser()` 只查"token 能不能解析出用户"——
 * 于是 `allowGuests: false` 之后，**手里还捏着以前发的游客 token 的客户端照样能读**
 * `/api/map`、`/api/transit`、`/api/element` 等全部只读接口（编辑走 WS 所以改不了）。
 * 表现成"半个关闭"：看得到、改不了，很容易被误判成正常。
 *
 * 本测试造出这个局面（先开着游客拿一个旧 token，再关掉游客重启），然后逐条断言：
 *   ① 旧游客 token 的 WS **连不上**（握手 403）
 *   ② 旧游客 token 的 HTTP **403 + code=GUESTS_DISABLED**（就是这次修的那一处）
 *   ③ 关掉游客后 POST /api/guest 仍然 403（原有的行为不能被改坏）
 *   ④ **正式账号不受影响**：注册的账号 token 在 HTTP/WS 上都照常能用
 *   ⑤ 开着游客的实例里，游客 token 依然能用（对照组，防止"一刀切"把游客彻底废掉）
 *
 *   node tests/auth-guest-http-test.js
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.GUEST_E2E_PORT || 8913);
const DATA_DIR = path.join(ROOT, 'tests', 'tmp-auth-guest');
const DB = path.join(DATA_DIR, 'osm.sqlite');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'tiny.osm');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + '  → ' + detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BBOX = 'minLon=116.39&minLat=39.89&maxLon=116.42&maxLat=39.92&zoom=16';

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

async function getMap(token) {
  const res = await fetch(`${BASE}/api/map?${BBOX}&token=${encodeURIComponent(token)}`);
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

function startServer(allowGuests) {
  const args = ['server/index.js', '--port', String(PORT), '--data', DATA_DIR, '--osm', DB];
  if (allowGuests) args.push('--allow-guests');
  return spawn(process.execPath, args, { cwd: ROOT, stdio: 'ignore' });
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

async function stopServer(server) {
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 4000);
    server.on('exit', () => { clearTimeout(t); resolve(); });
  });
  await sleep(250);
}

/**
 * 用 token 连 WS，返回结构化结果。
 * ⚠ 不能只看 `open`：服务端是**先升级成功、再发一条 fatal error 并 close** 的
 * （见 handleConnection 里 `!ALLOW_GUESTS && user.guest` 那一段），
 * 所以"连上了"不等于"被接纳"——必须再等一小会儿，看有没有被踢。
 */
function tryWS(token) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { ws.close(); } catch { /* ignore */ } resolve(v); };
    let ws;
    try { ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`); }
    catch (e) { resolve({ ok: false, err: 'throw: ' + e.message }); return; }
    ws.addEventListener('message', (ev) => {
      let m = null;
      try { m = JSON.parse(ev.data); } catch { /* 非 JSON 帧忽略 */ }
      if (m && m.t === 'error' && m.fatal) finish({ ok: false, code: m.code || null, message: m.message });
    });
    ws.addEventListener('close', (ev) => finish({ ok: false, closed: ev.code }));
    ws.addEventListener('error', (ev) => finish({ ok: false, err: (ev && ev.message) || 'websocket error' }));
    // 连上之后 500 毫秒内没被踢 = 真的接纳了
    ws.addEventListener('open', () => setTimeout(() => finish({ ok: true }), 500));
    setTimeout(() => finish({ ok: false, err: 'timeout' }), 6000);
  });
}

/** 等 auth 把 token 落盘（save 是 500ms 防抖的，不等就可能拿到一个"重启后不存在"的 token） */
async function waitTokenPersisted(token, timeoutMs = 5000) {
  const file = path.join(DATA_DIR, 'users.json');
  const t0 = Date.now();
  for (;;) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.tokens && raw.tokens[token]) return true;
    } catch { /* 还没写出来 */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(150);
  }
}

/* --------------------------------- 主流程 --------------------------------- */
(async () => {
  console.log('\n=== 关闭游客登录：HTTP 与 WS 口径一致 · 专项测试 ===\n');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  spawnSync(process.execPath, ['tools/import-osm.js', '--file', FIXTURE, '--db', DB, '--quiet'], { cwd: ROOT, stdio: 'ignore' });

  /* ---------- 阶段一：开着游客，拿一个"以前发的旧游客 token" ---------- */
  console.log('▶ 阶段一：allowGuests=true 的实例（造一个旧游客 token）');
  let server = startServer(true);
  await waitHealth();
  const g = await post('/api/guest');
  const guestToken = g.data.token;
  check('开游客时能拿到游客身份', g.status === 200 && !!guestToken, `user=${g.data.user && g.data.user.name}`);
  const guestMap = await getMap(guestToken);
  check('【对照组】开游客时，游客 token 能正常读 HTTP 接口', guestMap.status === 200, 'HTTP ' + guestMap.status);
  const guestWS = await tryWS(guestToken);
  check('【对照组】开游客时，游客 token 能正常连 WebSocket', guestWS.ok === true, JSON.stringify(guestWS));
  // 必须等它落盘再重启：auth.save 是 500ms 防抖的，不等的话第二阶段的实例里
  // 根本找不到这个 token（会得到 401「未登录」而不是 403「游客已关闭」，测试就白跑了）
  const persisted = await waitTokenPersisted(guestToken);
  check('游客 token 已落盘（否则第二阶段的结论不成立）', persisted === true);
  await stopServer(server);

  /* ---------- 阶段二：关掉游客重启（同一个 data 目录） ---------- */
  console.log('\n▶ 阶段二：allowGuests=false 的实例（旧游客 token 必须全面失效）');
  server = startServer(false);
  await waitHealth();

  const guestMap2 = await getMap(guestToken);
  check('★ 旧游客 token 读 HTTP 被拒：403 + code=GUESTS_DISABLED（这次修的那一处）',
    guestMap2.status === 403 && guestMap2.data.code === 'GUESTS_DISABLED',
    `HTTP ${guestMap2.status} ${JSON.stringify(guestMap2.data)}`);
  check('拒绝理由与 WS 侧是同一句中文（口径一致，便于客户端与排障）',
    typeof guestMap2.data.error === 'string' && /游客登录/.test(guestMap2.data.error),
    guestMap2.data.error);

  const guestWS2 = await tryWS(guestToken);
  check('★ 旧游客 token 连 WebSocket 被踢：fatal error code=GUESTS_DISABLED 或 close 4004',
    guestWS2.ok === false && (guestWS2.code === 'GUESTS_DISABLED' || guestWS2.closed === 4004),
    JSON.stringify(guestWS2));

  const guestAgain = await post('/api/guest');
  check('关游客后 POST /api/guest 仍然 403（原有行为没被改坏）',
    guestAgain.status === 403, `HTTP ${guestAgain.status} ${JSON.stringify(guestAgain.data)}`);

  /* ---------- 正式账号不受影响 ---------- */
  const name = '正式用户' + Math.floor(Math.random() * 10000);
  const reg = await post('/api/register', { name, password: 'pass1234' });
  const realToken = reg.data.token;
  check('关游客时注册正式账号照常可用', reg.status === 200 && !!realToken);
  const realMap = await getMap(realToken);
  check('★ 正式账号的 HTTP 访问不受影响（别把正常玩家一起挡了）', realMap.status === 200, 'HTTP ' + realMap.status);
  const realWS = await tryWS(realToken);
  check('★ 正式账号的 WebSocket 连接不受影响', realWS.ok === true, JSON.stringify(realWS));

  await stopServer(server);
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
