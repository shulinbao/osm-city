'use strict';
/** 通用工具（浏览器端，非模块：挂在全局 G.util 下） */
window.G = window.G || {};

(function () {
  const D2R = Math.PI / 180;
  const R_EARTH = 6378137;

  const util = {
    $(sel, root) { return (root || document).querySelector(sel); },
    $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); },

    el(tag, cls, html) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (html != null) node.innerHTML = html;
      return node;
    },

    esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    fmt(n) {
      const v = Math.round(Number(n) || 0);
      return v.toLocaleString('zh-CN');
    },

    fmtShort(n) {
      const v = Number(n) || 0;
      if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
      if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1) + '万';
      return String(Math.round(v));
    },

    fmtLength(m) {
      const v = Number(m) || 0;
      if (v >= 1000) return (v / 1000).toFixed(2) + ' km';
      if (v >= 10) return Math.round(v) + ' m';
      return v.toFixed(1) + ' m';
    },

    fmtArea(m2) {
      const v = Number(m2) || 0;
      if (v >= 1e6) return (v / 1e6).toFixed(2) + ' km²';
      if (v >= 1e4) return (v / 1e4).toFixed(2) + ' 公顷';
      return Math.round(v) + ' m²';
    },

    fmtBytes(b) {
      const v = Number(b) || 0;
      if (v >= 1024 * 1024 * 1024) return (v / 1073741824).toFixed(2) + ' GB';
      if (v >= 1024 * 1024) return (v / 1048576).toFixed(1) + ' MB';
      if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
      return v + ' B';
    },

    fmtTime(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    /** 统一坐标表示：数组 [lat,lng]、{lat,lng}、{lat,lon} 都支持（服务端用 lon，Leaflet 用 lng） */
    toObj(p) {
      if (!p) return null;
      if (Array.isArray(p)) return { lat: Number(p[0]), lng: Number(p[1]) };
      const lat = Number(p.lat);
      const lng = Number(p.lng != null ? p.lng : p.lon);
      return { lat, lng };
    },

    metersBetween(a, b) {
      const p1 = util.toObj(a);
      const p2 = util.toObj(b);
      const dLat = (p2.lat - p1.lat) * D2R;
      const dLng = (p2.lng - p1.lng) * D2R;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1.lat * D2R) * Math.cos(p2.lat * D2R) * Math.sin(dLng / 2) ** 2;
      return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
    },

    /** 闭合环面积（平方米），同时也用于计算 way 的长度 */
    ringAreaM2(pts) {
      if (!pts || pts.length < 3) return 0;
      let latSum = 0;
      for (const p of pts) latSum += util.toObj(p).lat;
      const k = Math.cos((latSum / pts.length) * D2R);
      let area = 0;
      for (let i = 0; i < pts.length; i++) {
        const p1 = util.toObj(pts[i]);
        const p2 = util.toObj(pts[(i + 1) % pts.length]);
        const x1 = p1.lng * D2R * R_EARTH * k;
        const y1 = p1.lat * D2R * R_EARTH;
        const x2 = p2.lng * D2R * R_EARTH * k;
        const y2 = p2.lat * D2R * R_EARTH;
        area += x1 * y2 - x2 * y1;
      }
      return Math.abs(area / 2);
    },

    lineLengthM(pts) {
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += util.metersBetween(pts[i - 1], pts[i]);
      return total;
    },

    centroid(pts) {
      let lat = 0;
      let lng = 0;
      for (const p of pts) { const o = util.toObj(p); lat += o.lat; lng += o.lng; }
      return { lat: lat / pts.length, lng: lng / pts.length };
    },

    pointInRing(pt, ring) {
      const p = util.toObj(pt);
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = util.toObj(ring[i]);
        const b = util.toObj(ring[j]);
        if (((a.lat > p.lat) !== (b.lat > p.lat)) &&
          (p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng)) inside = !inside;
      }
      return inside;
    },

    /** 点到线段的最短距离（米） */
    distToSegmentMeters(p, a, b) {
      const o = util.toObj(p);
      const k = Math.cos(o.lat * D2R);
      const toXY = (q) => {
        const t = util.toObj(q);
        return [(t.lng - o.lng) * D2R * R_EARTH * k, (t.lat - o.lat) * D2R * R_EARTH];
      };
      const [x1, y1] = toXY(a);
      const [x2, y2] = toXY(b);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : -(x1 * dx + y1 * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = x1 + t * dx;
      const cy = y1 + t * dy;
      return Math.sqrt(cx * cx + cy * cy);
    },

    /** 点到线段的投影参数（0~1）与垂足，用于在道路上插点 */
    projectOnSegment(p, a, b) {
      const o = util.toObj(p);
      const k = Math.cos(o.lat * D2R);
      const toXY = (q) => {
        const t = util.toObj(q);
        return [(t.lng - o.lng) * D2R * R_EARTH * k, (t.lat - o.lat) * D2R * R_EARTH];
      };
      const [x1, y1] = toXY(a);
      const [x2, y2] = toXY(b);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2));
      const lat = util.toObj(a).lat + (util.toObj(b).lat - util.toObj(a).lat) * t;
      const lng = util.toObj(a).lng + (util.toObj(b).lng - util.toObj(a).lng) * t;
      return { t, lat, lng };
    },

    shade(hex, f) {
      const h = String(hex).replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const num = parseInt(full, 16);
      const r = Math.min(255, Math.max(0, Math.round(((num >> 16) & 255) * f)));
      const g = Math.min(255, Math.max(0, Math.round(((num >> 8) & 255) * f)));
      const b = Math.min(255, Math.max(0, Math.round((num & 255) * f)));
      return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
    },

    /** building:levels / height 标签 → 米 */
    buildingHeightMeters(tags) {
      if (!tags) return 6;
      const h = tags.height || tags['building:height'];
      if (h) {
        const m = parseFloat(String(h).replace(/[^\d.]/g, ''));
        if (Number.isFinite(m) && m > 0) return Math.min(500, m);
      }
      const lv = tags['building:levels'] || tags.levels;
      if (lv) {
        const n = parseFloat(String(lv).replace(/[^\d.]/g, ''));
        if (Number.isFinite(n) && n > 0) return Math.min(500, n * 3.2 + 1);
      }
      return 6;
    },

    /** 校验并规范化一个坐标，返回 {lat, lng} 或 null（用于任何可能拿到脏数据的地方） */
    validLL(a, b) {
      const check = (lat, lng) => {
        const la = Number(lat);
        const ln = Number(lng);
        if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
        if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
        return { lat: la, lng: ln };
      };
      if (a != null && typeof a === 'object') {
        const o = util.toObj(a);
        return o ? check(o.lat, o.lng) : null;
      }
      return check(a, b);
    },

    /** 安全地把地图移动到某个坐标；坐标不合法时返回 false 而不是抛异常 */
    flyToSafe(map, lat, lng, zoom, options) {
      const ll = util.validLL(lat, lng);
      if (!ll) return false;
      const z = Number.isFinite(Number(zoom)) ? Number(zoom) : Math.max(map.getZoom(), 18);
      map.flyTo([ll.lat, ll.lng], Math.max(3, Math.min(22, z)), options || { duration: 0.6 });
      return true;
    },

    /* ------------------------------ 调试输出（默认关） ------------------------------ */
    /**
     * 排查用的"逐次/逐帧"日志总开关：**默认关闭**，生产环境的控制台保持干净。
     * 打开方式（任选其一）：
     *   1. 控制台执行 `localStorage.setItem('osmcity.debug', '1')` 后刷新页面（全局生效，一直开着）；
     *   2. 或者当前页面直接 `window.G.util.debug = true`（立即生效，刷新后失效）。
     * 只有"排查用"的日志走这里；console.warn / console.error（真异常）一律照旧输出。
     */
    debug: false,
    /** 调试输出是否打开：先看运行时的 util.debug，再看 localStorage 的 osmcity.debug */
    debugOn() {
      if (util.debug) return true;
      try { return localStorage.getItem('osmcity.debug') === '1'; } catch { return false; }
    },
    /** 调试输出：关着的时候什么都不做（返回 false） */
    debugLog(...args) {
      if (!util.debugOn()) return false;
      try { console.log(...args); } catch { /* ignore */ }
      return true;
    },

    debounce(fn, ms) {
      let t = null;
      return function (...args) {
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
      };
    },

    throttle(fn, ms) {
      let last = 0;
      let timer = null;
      let lastArgs = null;
      return function (...args) {
        lastArgs = args;
        const now = Date.now();
        if (now - last >= ms) {
          last = now;
          fn.apply(this, args);
        } else if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            last = Date.now();
            fn.apply(this, lastArgs);
          }, ms - (now - last));
        }
      };
    },

    toast(message, kind = 'info', ms = 3200) {
      const box = util.$('#toasts');
      if (!box) return;
      const node = util.el('div', 'toast ' + kind, util.esc(message));
      box.appendChild(node);
      setTimeout(() => {
        node.classList.add('out');
        setTimeout(() => node.remove(), 400);
      }, ms);
    },

    hint(text) {
      const box = util.$('#hint');
      if (!box) return;
      if (!text) { box.classList.remove('show'); box.innerHTML = ''; return; }
      box.innerHTML = text;
      box.classList.add('show');
    },

    statusHint(text) {
      const box = util.$('#status-hint');
      if (box) box.textContent = text || '';
    },

    storage: {
      get(k, d) {
        try {
          const v = localStorage.getItem(k);
          return v == null ? d : JSON.parse(v);
        } catch { return d; }
      },
      set(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
      },
      del(k) {
        try { localStorage.removeItem(k); } catch { /* ignore */ }
      },
      /** 清掉指定前缀的历史遗留键（旧版本换了数据格式时用） */
      purge(prefix) {
        try {
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith(prefix)) localStorage.removeItem(k);
          }
        } catch { /* ignore */ }
      },
    },
  };

  window.G.util = util;
})();
