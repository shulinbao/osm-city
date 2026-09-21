'use strict';
/** 下载前端依赖到 public/vendor（只跑一次；离线环境可跳过，改用 CDN 或离线网格底图） */
const fs = require('node:fs');
const path = require('node:path');

const VER = '1.9.4';
const BASE = `https://unpkg.com/leaflet@${VER}/dist/`;
const FILES = [
  'leaflet.js',
  'leaflet.css',
  'images/marker-icon.png',
  'images/marker-icon-2x.png',
  'images/marker-shadow.png',
  'images/layers.png',
  'images/layers-2x.png',
];

const outDir = path.resolve(__dirname, '..', 'public', 'vendor', 'leaflet');

(async () => {
  for (const f of FILES) {
    const dest = path.join(outDir, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(BASE + f, { headers: { 'User-Agent': 'OSM-City-Online/vendor-fetch' } });
    if (!res.ok) throw new Error(`${f} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log('saved', path.relative(process.cwd(), dest), buf.length, 'bytes');
  }
  console.log('Leaflet', VER, '已就绪');
})().catch((err) => {
  console.error('下载失败:', err.message);
  process.exit(1);
});
