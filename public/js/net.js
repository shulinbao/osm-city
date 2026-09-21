'use strict';
/** WebSocket 客户端：操作请求/应答、广播接收、断线重连 */
(function () {
  const listeners = Object.create(null);
  let ws = null;
  let token = null;
  let seq = 0;
  let backoff = 800;
  let manualClose = false;
  const pending = new Map();

  /**
   * 别人改动的提示（toast）节流：最多每 2 秒一条。
   * 第一条到达后先等 REMOTE_COALESCE_MS 攒一下同一批改动，再合并成一句
   * （例如「张三 改动了 2 条道路（共 3 处改动）」），避免连续操作时提示跳个不停。
   */
  const REMOTE_TOAST_MS = 2000;
  const REMOTE_COALESCE_MS = 300;
  let remoteToastAt = 0;
  let remoteToastTimer = null;
  let remoteItems = [];
  const remoteNames = new Set();

  /** net.js 在 world/mapdata/render 之前加载，只能在调用时从 window.G 取模块，不能在顶层解构 */
  const G = () => window.G || {};

  /** 改动点是否在当前视野里（视野外的改动不弹提示，避免满屏"别人改了什么"）。 */
  function inViewport(pt) {
    const MapData = G().MapData;
    if (!pt || !MapData || !MapData.map || typeof MapData.map.getBounds !== 'function') return false;
    return MapData.map.getBounds().contains([pt.lat, pt.lon]);
  }

  function flushRemoteToast() {
    if (remoteToastTimer) { clearTimeout(remoteToastTimer); remoteToastTimer = null; }
    if (!remoteItems.length) return;
    const items = remoteItems;
    const names = Array.from(remoteNames);
    remoteItems = [];
    remoteNames.clear();
    remoteToastAt = Date.now();
    const g = G();
    if (!g.util || !g.util.toast) return;
    const info = (g.World && g.World.summarizeItems) ? g.World.summarizeItems(items) : { text: '改动了地图数据' };
    const who = names.length === 1 ? names[0]
      : (names.length ? `${names[0]} 等 ${names.length} 人` : '其他编辑者');
    g.util.toast(`${who} ${info.text}`);
  }

  /** 攒着的改动条目加上限，避免异常刷屏时无限增长 */
  const REMOTE_MAX_ITEMS = 400;

  function queueRemoteToast(by, items) {
    if (!items.length) return;
    for (const it of items) remoteItems.push(it);
    if (remoteItems.length > REMOTE_MAX_ITEMS) remoteItems.splice(0, remoteItems.length - REMOTE_MAX_ITEMS);
    if (by && by.name) remoteNames.add(by.name);
    // 至少等一小会儿攒同一批操作，同时保证距上一条提示满 2 秒
    const wait = Math.max(REMOTE_COALESCE_MS, REMOTE_TOAST_MS - (Date.now() - remoteToastAt));
    if (!remoteToastTimer) remoteToastTimer = setTimeout(flushRemoteToast, wait);
  }

  /**
   * 处理别人广播过来的改动（服务器广播的 ops 不带 self，作者自己是走 ack 的 self:true）：
   *  1) 合并进 World 的既有 upsert 路径（删除类操作会真的删掉本地元素）
   *  2) 撤掉包含这些改动的视口缓存范围，免得 MapData.covered() 谎报"已覆盖"而不再取新数据
   *  3) 触发一次重绘
   *  4) 只有改动落在当前视野里才提示，且最多 2 秒一条
   * 必须在 Net.emit('ops') 之前跑：删除类操作执行后就取不到旧位置/旧标签了。
   */
  function applyRemoteOps(msg) {
    const g = G();
    if (!g.World || !g.World.applyRemoteOps) return 0;
    const info = g.World.applyRemoteOps(msg.ops || []);
    if (!info.count) return 0;
    if (g.MapData && g.MapData.invalidateAt) g.MapData.invalidateAt(info.points);
    if (g.Render && g.Render.markDirty) g.Render.markDirty();
    queueRemoteToast(msg.by, (info.items || []).filter((it) => it.at && inViewport(it.at)));
    return info.count;
  }

  const Net = {
    get connected() { return !!ws && ws.readyState === 1; },
    get token() { return token; },

    on(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
      return Net;
    },

    emit(type, payload) {
      for (const fn of listeners[type] || []) {
        try { fn(payload); } catch (err) { console.error('[net] handler error', type, err); }
      }
    },

    /** 供自检/调试用手动灌一条广播 */
    applyRemoteOps,

    connect(t) {
      token = t || token;
      manualClose = false;
      if (ws) {
        try { ws.onclose = null; ws.close(); } catch { /* ignore */ }
      }
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token || '')}`);
      Net.emit('status', { state: 'connecting' });

      ws.onopen = () => {
        backoff = 800;
        Net.emit('status', { state: 'open' });
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'pong') {
          if (typeof msg.undoDepth === 'number') Net.emit('depth', msg);
          return;
        }
        if (msg.t === 'ops') {
          // 广播路径：别人改的（self=false）。先合并进本地缓存并刷新，再交给既有监听处理选择/统计。
          const payload = {
            ops: msg.ops || [],
            self: false,
            by: msg.by || null,
            label: msg.label || '',
            changesetId: msg.changesetId,
            ts: msg.ts || Date.now(),
          };
          applyRemoteOps(payload);
          Net.emit('ops', payload);
          return;
        }
        if (msg.t === 'ack' && msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          const pendingOp = p.op;
          pending.delete(msg.id);
          if (msg.ok) {
            // 服务端只把操作广播给别人，作者端要靠 ack 里的 ops 更新自己的画面
            if (msg.ops && msg.ops.length) Net.emit('ops', { ops: msg.ops, self: true, label: msg.label });
            if (typeof msg.undoDepth === 'number') Net.emit('depth', msg);
            // 记录操作类型，供 Ctrl+Z 判断该撤销哪一边
            if (pendingOp && pendingOp.k !== 'undo' && pendingOp.k !== 'redo' && window.G.Editor) {
              window.G.Editor.actionLog.push({ kind: 'osm', label: msg.label || pendingOp.k });
              window.G.Editor.redoLog = [];
            }
            p.resolve(msg);
          } else {
            /**
             * 失败时把服务端给的结构化信息一并带出去（不只是那句中文）：
             *   · `code`     —— 'CONFLICT' / 'LOCKED' / 'IN_USE' / 'FORBIDDEN' …（调用方按它分流）；
             *   · `conflict` —— 版本冲突时才有：{ type, id, version, editorName, yourVersion, index? }
             *     服务端现在的版本号与最后编辑者。编辑器拿到它就能**立刻刷新并自动重放一次**，
             *     不必等 `/api/element` 往返（见 editor.js 的「版本冲突自愈」一节）。
             */
            p.reject(Object.assign(new Error(msg.error || '操作失败'), {
              code: msg.code,
              conflict: msg.conflict || null,
            }));
          }
          return;
        }
        Net.emit(msg.t, msg);
      };

      ws.onclose = (ev) => {
        for (const [, p] of pending) p.reject(new Error('连接已断开'));
        pending.clear();
        if (manualClose) return;
        if (ev && ev.code === 4001) {
          Net.emit('status', { state: 'unauthorized' });
          return;
        }
        Net.emit('status', { state: 'reconnecting' });
        setTimeout(() => Net.connect(token), backoff);
        backoff = Math.min(backoff * 1.7, 8000);
      };

      ws.onerror = () => { /* onclose 处理 */ };
      return Net;
    },

    send(obj) {
      if (!Net.connected) return false;
      try {
        ws.send(JSON.stringify(obj));
        return true;
      } catch {
        return false;
      }
    },

    /** 发送编辑操作，返回服务器确认结果 { ok, ops, label, undoDepth } */
    op(opObject, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const id = 'c' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
        pending.set(id, { resolve, reject, op: opObject });
        if (!Net.send({ t: 'op', id, op: opObject })) {
          pending.delete(id);
          reject(new Error('尚未连接到服务器'));
          return;
        }
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('服务器响应超时'));
          }
        }, timeoutMs);
      });
    },

    move(lat, lon) { Net.send({ t: 'move', lat, lon }); },
    select(type, id) { Net.send({ t: 'select', type, id: id == null ? null : id }); },
    lock(elemType, id, on) { Net.send({ t: 'lock', elemType, id, on }); },
    chat(text) { Net.send({ t: 'chat', text }); },
    ping() { Net.send({ t: 'ping', ts: Date.now() }); },

    disconnect() {
      manualClose = true;
      if (ws) { try { ws.close(1000, 'bye'); } catch { /* ignore */ } }
      ws = null;
    },
  };

  window.G.Net = Net;
})();
