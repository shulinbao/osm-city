'use strict';
/**
 * 地理计算工具（服务端与前端保持同一套公式，保证面积/距离口径一致）。
 * 坐标统一入口：数组 [lat,lng]、{lat,lng}（Leaflet 风格）、{lat,lon}（本项目数据模型）都接受，
 * 避免"两种经度命名混用"导致 NaN 这类问题。
 */

const R_EARTH = 6378137; // WGS84 长半轴
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** 规范化坐标 → {lat, lng}；非法返回 null */
function toLL(p) {
  if (!p) return null;
  if (Array.isArray(p)) {
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const lat = Number(p.lat);
  const lng = Number(p.lng != null ? p.lng : p.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function toRad(d) { return d * D2R; }

/** 两点间距离（米，Haversine） */
function metersBetween(a, b) {
  const p = toLL(a);
  const q = toLL(b);
  if (!p || !q) return NaN;
  const dLat = (q.lat - p.lat) * D2R;
  const dLng = (q.lng - p.lng) * D2R;
  const lat1 = p.lat * D2R;
  const lat2 = q.lat * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 球面多边形面积（平方米），等距圆柱近似 */
function ringAreaM2(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  const list = pts.map(toLL);
  if (list.some((p) => !p)) return 0;
  let latSum = 0;
  for (const p of list) latSum += p.lat;
  const lat0 = latSum / list.length;
  const k = Math.cos(lat0 * D2R);
  let area = 0;
  for (let i = 0; i < list.length; i++) {
    const p1 = list[i];
    const p2 = list[(i + 1) % list.length];
    const x1 = p1.lng * D2R * R_EARTH * k;
    const y1 = p1.lat * D2R * R_EARTH;
    const x2 = p2.lng * D2R * R_EARTH * k;
    const y2 = p2.lat * D2R * R_EARTH;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

/** 重心（经纬度平均，足够用于排序/过滤） */
function centroid(pts) {
  const list = (pts || []).map(toLL).filter(Boolean);
  if (!list.length) return null;
  let lat = 0;
  let lng = 0;
  for (const p of list) { lat += p.lat; lng += p.lng; }
  return { lat: lat / list.length, lng: lng / list.length };
}

/** 由中心点按米偏移得到新坐标（返回 {lat, lon}，与服务端数据模型一致） */
function offsetMeters(pt, dxEast, dyNorth) {
  const p = toLL(pt);
  if (!p) return null;
  const lat = p.lat + (dyNorth / R_EARTH) * R2D;
  const lon = p.lng + (dxEast / (R_EARTH * Math.cos(p.lat * D2R))) * R2D;
  return { lat, lon };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

module.exports = { R_EARTH, toRad, toLL, metersBetween, ringAreaM2, centroid, offsetMeters, clamp };
