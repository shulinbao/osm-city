'use strict';
/**
 * 截图自检：解码 PNG 并检查界面是否真的渲染出来了（无第三方依赖）。
 * 用法：node tools/check-screenshot.js tests/shot1.png
 */
const fs = require('node:fs');
const zlib = require('node:zlib');

function decodePNG(buf) {
  if (!(buf[0] === 0x89 && buf[1] === 0x50)) throw new Error('不是 PNG 文件');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace) throw new Error('不支持交错 PNG');
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = raw[rp + x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      row[x] = v;
    }
    rp += stride;
  }
  return { width, height, bpp, data: out };
}

function makeImage(png) {
  const { width, height, bpp, data } = png;
  return {
    width,
    height,
    px(x, y) {
      const o = (y * width + x) * bpp;
      return [data[o], data[o + 1], data[o + 2]];
    },
    near(x, y, rgb, tol) {
      const p = this.px(x, y);
      return Math.abs(p[0] - rgb[0]) <= tol && Math.abs(p[1] - rgb[1]) <= tol && Math.abs(p[2] - rgb[2]) <= tol;
    },
    countNear(rgb, tol, region) {
      const [x0, y0, x1, y1] = region;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) if (this.near(x, y, rgb, tol)) n += 1;
      }
      return n;
    },
    stats(region) {
      const [x0, y0, x1, y1] = region;
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const p = this.px(x, y);
          const lum = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
          sum += lum;
          sum2 += lum * lum;
          n += 1;
        }
      }
      const mean = sum / n;
      return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), samples: n };
    },
  };
}

const file = process.argv[2] || 'tests/shot1.png';
const img = makeImage(decodePNG(fs.readFileSync(file)));

let ok = 0;
let bad = 0;
const check = (name, cond, detail) => {
  if (cond) { ok += 1; console.log('  ✅ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { bad += 1; console.log('  ❌ ' + name + (detail ? '  (' + detail + ')' : '')); }
};

console.log(`\n=== 截图像素自检：${file} ===\n`);
console.log(`尺寸 ${img.width}×${img.height}`);

const W = img.width;
const H = img.height;

/**
 * 把画面按亮度降采样成文字网格：眼睛看不见图，也能从字符判断版面
 * （黑=深色面板/文字，. =浅色地图，空格=接近纯白）
 */
function asciiPreview(cols = 44, rows = 18) {
  const chars = ' .:-=+*#%@';
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * W) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * W) / cols));
      const y0 = Math.floor((r * H) / rows);
      const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * H) / rows));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const p = img.px(x, y);
          sum += 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
          n += 1;
        }
      }
      const lum = sum / Math.max(1, n);
      line += chars[Math.min(chars.length - 1, Math.max(0, Math.round(((255 - lum) / 255) * (chars.length - 1) * 2.2)))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

console.log('\n--- 画面亮度预览（越深表示越暗：面板/文字）---');
console.log(asciiPreview());
console.log('--- 预览结束 ---\n');

// 区域统计（不依赖具体像素坐标，按"暗像素比例"判断版面）
const regionStats = (x0, y0, x1, y1) => {
  let dark = 0;
  let n = 0;
  let sum = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const p = img.px(x, y);
      const lum = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      sum += lum;
      if (lum < 110) dark += 1;
      n += 1;
    }
  }
  return { mean: sum / n, darkRatio: dark / n };
};

const center = regionStats(Math.round(W * 0.3), Math.round(H * 0.35), Math.round(W * 0.7), Math.round(H * 0.75));
const leftStrip = regionStats(0, 0, Math.round(W * 0.16), Math.round(H * 0.6));
const rightStrip = regionStats(Math.round(W * 0.84), 0, W, Math.round(H * 0.6));
const whole = regionStats(0, 0, W, H);

check('画面不是空白（有明暗变化）', whole.mean > 20 && whole.mean < 250 && whole.darkRatio > 0.02 && whole.darkRatio < 0.98,
  `整体亮度 ${whole.mean.toFixed(0)}，暗像素占比 ${(whole.darkRatio * 100).toFixed(1)}%`);
check('地图主体为浅色矢量底图', center.mean > 150, `中心区域亮度 ${center.mean.toFixed(0)}`);
check('左侧工具栏已绘制（深色面板）', leftStrip.darkRatio > 0.05, `暗像素 ${(leftStrip.darkRatio * 100).toFixed(1)}%`);
check('右侧属性面板已绘制（深色面板）', rightStrip.darkRatio > 0.03, `暗像素 ${(rightStrip.darkRatio * 100).toFixed(1)}%`);
check('界面深色面板与浅色地图形成对比', center.mean - leftStrip.mean > 60,
  `${center.mean.toFixed(0)} vs ${leftStrip.mean.toFixed(0)}`);

// 矢量底图配色（来自 public/js/style.js 的 OSM Carto 调色板）
const full = [0, 60, W, H];
const buildings = img.countNear([217, 208, 201], 24, full);
const roads = img.countNear([255, 255, 255], 5, full);
const greens = img.countNear([200, 230, 160], 30, full);
const blues = img.countNear([170, 211, 223], 26, full);
check('建筑（米色填充）已渲染', buildings > 150, `${buildings} px`);
check('道路（白色路面）已渲染', roads > 200, `${roads} px`);
check('绿地/公园配色已渲染', greens > 30, `${greens} px`);
console.log(`  ℹ 水面配色像素：${blues}（北京城区视口内水域较少，仅作参考）`);

const accent = img.countNear([110, 231, 168], 60, [0, 0, W, 60]);
check('顶栏与状态指示已渲染', accent > 20, `${accent} px`);

console.log(`\n结果：${ok} 项通过，${bad} 项失败\n`);
process.exit(bad ? 1 : 0);
