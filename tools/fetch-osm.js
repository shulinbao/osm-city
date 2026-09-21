'use strict';
/**
 * OSM 数据源下载器（零第三方依赖，只用 Node 内置模块）
 *
 * 为什么不用 curl/wget：① node:22-slim 镜像里**没有 curl**（原来的 docker-entrypoint.sh
 * 用 curl 下载，在 slim 基础镜像里会直接失败）；② 断点续传 / 重试 / 校验 / 进度 / 磁盘预检
 * 这些东西自己写一遍反而更可控，也让"服务端自己下载"这条路径不依赖镜像里装了什么。
 *
 * 用法：
 *   node tools/fetch-osm.js --url https://download.geofabrik.de/europe/monaco-latest.osm.pbf \
 *        --out data/osm/monaco.osm.pbf
 *   node tools/fetch-osm.js --city china                 # 用 tools/cities.json 里的预设
 *   node tools/fetch-osm.js --city china --print-env      # 打印 shell 可 eval 的 KEY=VALUE（entrypoint 用）
 *   node tools/fetch-osm.js --url <...> --check           # 只做 HEAD + 磁盘预检，不下载
 *
 * 特性：
 *   · **断点续传**：本地 `xxx.part` 有多少就从哪里续（HTTP Range）；服务器不支持 Range
 *     （返回 200）就老老实实从头下；服务器返回 416 说明本地已经比服务器上的还全 → 直接收工。
 *   · **失败重试**：网络错误/超时/5xx 自动重试（指数退避），每次重试都接着续传，不会白下。
 *   · **进度输出**：每 3 秒一行（不是 \r 进度条，容器日志是逐行的），带速度与预计剩余时间。
 *   · **可选校验**：`--md5 auto`（默认）会顺手取 `<url>.md5`（Geofabrik 提供）并校验；
 *     对方没提供就只提示，不算失败。也可以 `--md5 <hex>` 手工指定。
 *   · **磁盘预检**：下载量 + 入库后的预计库大小（+ 余量）算出来，空间不够时**在下载之前**
 *     用中文说清楚差多少、可以怎么办，而不是写到一半 ENOSPC。
 *   · **格式识别**：下完用 tools/pbf.js 的 detectKind 认一下是 .osm.pbf / .osm.gz / .osm，
 *     认不出来（例如下到一张 HTML 错误页）就报错退出。
 *
 * 注意：本工具**只负责把文件拿到本地**，导入仍然走 tools/import-osm.js（见 deploy/DEPLOY.md）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { detectKind } = require('./pbf.js');

const ROOT = path.resolve(__dirname, '..');
/**
 * 城市注册表的位置：**和工具放在一起**（tools/cities.json），因为 Dockerfile 只 COPY tools/
 * 与 deploy/docker-entrypoint.sh —— 放 deploy/ 的话容器里就没有这个文件，城市预设会失效。
 * 需要换一份表时用 OSM_CITIES_FILE 环境变量指定。
 */
const CITIES_FILE = process.env.OSM_CITIES_FILE
  ? path.resolve(process.env.OSM_CITIES_FILE)
  : path.join(__dirname, 'cities.json');

/**
 * 入库后的库大小 ≈ 源文件 × 这个倍数。**实测**（本机、node:sqlite）：
 *   · PBF：摩纳哥 676 KB → 11.2 MB（16×）；北京分省包 35.1 MB → 928 MB（26×）→ 取 26 覆盖大文件；
 *   · XML gz：BBBike 北京 47 MB → 555 MB（12×）。
 * 这个倍数偏大的原因：每条 node 会额外产生 R*Tree(node_index) 一行 + idx_nodes_ts 一条索引项，
 * 加上 way_nodes 与其索引 —— 实测约 200~260 字节/节点（见 deploy/DEPLOY.md 的容量表）。
 * 宁可估大：估小了会导致"写到一半磁盘满"，那是最难收拾的失败方式。
 */
const DB_SIZE_FACTOR = { 'osm.pbf': 26, 'osm.gz': 12, 'osm': 1.2 };
/** 除了下载量 + 库大小，再多留这么多字节给 WAL / 索引 / 临时表 */
const SPACE_MARGIN = 512 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 3000;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  if (sec < 60) return sec.toFixed(0) + ' 秒';
  if (sec < 3600) return (sec / 60).toFixed(1) + ' 分钟';
  return (sec / 3600).toFixed(1) + ' 小时';
}

/** 按 URL 猜数据源类型（只看扩展名；真正的判断由 detectKind 做） */
function kindFromName(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.osm.pbf') || lower.endsWith('.pbf')) return 'osm.pbf';
  if (lower.endsWith('.osm.gz') || lower.endsWith('.osm.bz2') || lower.endsWith('.gz')) return 'osm.gz';
  if (lower.endsWith('.osm') || lower.endsWith('.xml')) return 'osm';
  return 'unknown';
}

/** 文件名（去掉查询串），用于默认 --out */
function basenameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = path.posix.basename(u.pathname);
    return base || 'download.osm.pbf';
  } catch {
    return path.posix.basename(String(url).split('?')[0]) || 'download.osm.pbf';
  }
}

/** 读 tools/cities.json（不存在就返回空表，城市切换是可选功能） */
function loadCities() {
  if (!fs.existsSync(CITIES_FILE)) return { default: null, cities: {} };
  const raw = JSON.parse(fs.readFileSync(CITIES_FILE, 'utf8'));
  return { default: raw.default || null, cities: raw.cities || {} };
}

/* ------------------------------------------------------------------ *
 * 磁盘空间预检
 * ------------------------------------------------------------------ */

/** 目标目录所在卷的空闲字节数（Node 18.15+ 的 fs.statfsSync，跨平台，Windows 也能用）。
 *  读不到时返回 free = null（不支持的平台/文件系统）——调用方按"跳过预检"处理，别把导入卡死。 */
function freeBytesOf(dir) {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const st = fs.statfsSync(probe);
    return { free: Number(st.bsize) * Number(st.bavail), dir: probe };
  } catch (err) {
    return { free: null, dir: probe, error: err.message };
  }
}

/**
 * 算出"这次操作需要多少空间"并核对。
 * @returns {{ok:boolean, free:number|null, need:number, download:number, db:number, dir:string, reason?:string}}
 */
function checkSpace(outFile, downloadBytes, kind, minFreeGb) {
  const { free, dir, error } = freeBytesOf(path.dirname(path.resolve(outFile)));
  const factor = DB_SIZE_FACTOR[kind] === undefined ? 26 : DB_SIZE_FACTOR[kind];
  const db = downloadBytes > 0 ? Math.ceil(downloadBytes * factor) : 0;
  let need = downloadBytes + db + SPACE_MARGIN;
  if (Number.isFinite(minFreeGb) && minFreeGb > 0) need = Math.max(need, minFreeGb * 1024 * 1024 * 1024);
  if (free === null) return { ok: true, free: null, need, download: downloadBytes, db, dir, factor, error, skipped: true };
  return { ok: free >= need, free, need, download: downloadBytes, db, dir, factor };
}

/** 空间不足时用中文讲清楚（差多少、能怎么办），而不是扔一个 ENOSPC */
function spaceAdvice(res, kind, outFile) {
  const lines = [
    `磁盘空间不足：${res.dir} 可用 ${formatBytes(res.free)}，这次需要约 ${formatBytes(res.need)}。`,
    `  其中：下载源文件约 ${formatBytes(res.download)} + 入库后的库约 ${formatBytes(res.db)}` +
    `（按 ${kind} × ${res.factor} 估算）+ 余量 ${formatBytes(SPACE_MARGIN)}（WAL / R*Tree / 临时表）。`,
    `  差 ${formatBytes(res.need - res.free)}。三个办法：`,
    '   ① 给数据卷扩容量（云主机加盘 / 换更大的卷）；',
    '   ② 换成更小的数据源：分省/城市提取包（BBBike 城市包、或 Geofabrik 的其它区域），见 deploy/DEPLOY.md 的表；',
    '   ③ 在别处导好再拷贝：在磁盘足够的机器上 `node tools/import-osm.js --file <源文件> --db <库>`，',
    '      然后把导好的 sqlite（比源文件更省事）放进数据卷，并把 OSM_AUTO_DOWNLOAD=0 打开，容器就完全不联网了。',
    `  目标路径：${outFile}`,
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * HTTP：HEAD + 小文件 GET
 * ------------------------------------------------------------------ */
async function httpHead(url, timeoutMs) {
  const res = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'osm-city/1.0 (tools/fetch-osm.js)' },
  });
  const len = Number(res.headers.get('content-length'));
  return {
    status: res.status,
    size: Number.isFinite(len) && len > 0 ? len : 0,
    acceptRanges: (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes'),
    finalUrl: res.url || url,
  };
}

/** 取一个很小的文本文件（.md5 只有几十字节） */
async function httpGetText(url, timeoutMs, maxBytes = 64 * 1024) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'osm-city/1.0 (tools/fetch-osm.js)' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (text.length > maxBytes) throw new Error('响应过大，不是 md5 文件');
  return text;
}

/** 从 .md5 文件内容里抠出 32 位十六进制摘要（Geofabrik 的文件里通常只有摘要本身） */
function parseMd5Text(text) {
  const m = String(text).match(/\b([0-9a-fA-F]{32})\b/);
  return m ? m[1].toLowerCase() : null;
}

/* ------------------------------------------------------------------ *
 * 下载（断点续传 + 重试 + 进度）
 * ------------------------------------------------------------------ */

/** 流式算 md5（1.5 GB 也不会进内存） */
async function md5File(file) {
  const hash = crypto.createHash('md5');
  await pipeline(fs.createReadStream(file, { highWaterMark: 1 << 20 }), hash);
  return hash.digest('hex');
}

/**
 * 把 url 下到 outFile（先写 outFile.part，全部成功后才改名）。
 * @returns {Promise<{bytes:number, resumedFrom:number, attempts:number, ms:number, md5:string|null, serverSize:number}>}
 */
async function download(url, outFile, options) {
  const log = options.log;
  const partFile = outFile + '.part';
  const retries = Number.isFinite(options.retries) ? options.retries : 4;
  const timeoutMs = options.timeoutMs || 30000;
  const idleMs = options.idleMs || 60000;
  const t0 = Date.now();
  let attempts = 0;
  let serverSize = 0;
  let lastErr = null;
  const resumedFromStart = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts++;
    if (attempt > 0) {
      const wait = Math.min(30, 2 ** (attempt - 1));
      log(`· 第 ${attempt} 次重试（${wait} 秒后继续，已下载的部分会保留并续传）：${lastErr && lastErr.message}`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    let have = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
    const headers = { 'user-agent': 'osm-city/1.0 (tools/fetch-osm.js)' };
    if (have > 0) headers.Range = 'bytes=' + have + '-';
    const controller = new AbortController();
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('下载停滞超过 ' + Math.round(idleMs / 1000) + ' 秒')), idleMs);
    };
    try {
      armIdle();
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers,
      });
      if (res.status === 416) {
        // 本地比服务器上还全（或正好下完）：用 Content-Range 里的总长度核对
        const cr = res.headers.get('content-range') || '';
        const m = cr.match(/bytes\s+\*\/(\d+)/);
        if (m) serverSize = Number(m[1]);
        if (serverSize > 0 && have === serverSize) {
          log('· 服务器返回 416：本地 .part 已经是完整的（' + formatBytes(have) + '）。');
          if (idleTimer) clearTimeout(idleTimer);
          return finishPart(partFile, outFile, have, resumedFromStart, attempts, t0, options);
        }
        log('· 服务器返回 416 但本地大小对不上（本地 ' + formatBytes(have) + '，服务器 ' +
          (serverSize ? formatBytes(serverSize) : '未知') + '）→ 丢弃 .part 重下。');
        if (idleTimer) clearTimeout(idleTimer);
        fs.rmSync(partFile, { force: true });
        lastErr = new Error('断点数据与服务端不一致');
        continue;
      }
      if (res.status === 404) {
        if (idleTimer) clearTimeout(idleTimer);
        throw new FatalError('HTTP 404：数据源地址不存在（' + url + '）。请核对 URL —— ' +
          '完整列表见 deploy/DEPLOY.md 与 https://download.geofabrik.de/');
      }
      if (!res.ok) {
        if (idleTimer) clearTimeout(idleTimer);
        throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      }
      const contentLen = Number(res.headers.get('content-length'));
      const ranged = res.status === 206;
      if (have > 0 && !ranged) {
        // 服务器不支持 Range（返回 200 全量）：只能从头写
        log('· 服务器不支持断点续传（返回 200），已丢弃 .part 从头下载。');
        fs.rmSync(partFile, { force: true });
        have = 0;
      } else if (ranged && have > 0) {
        const cr = res.headers.get('content-range') || '';
        const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
        if (m) serverSize = Number(m[3]);
        log(`· 断点续传：本地已有 ${formatBytes(have)}，从第 ${have} 字节继续` +
          (serverSize > 0 ? `（共 ${formatBytes(serverSize)}）` : '') + '。');
      }
      if (Number.isFinite(contentLen) && contentLen > 0) serverSize = have + contentLen;

      const sink = fs.createWriteStream(partFile, { flags: have > 0 ? 'a' : 'w' });
      let written = have;
      let lastLog = Date.now();
      const tStart = Date.now();
      const started = have;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        written += chunk.length;
        armIdle();
        if (options.quiet) return;
        const now = Date.now();
        if (now - lastLog < PROGRESS_INTERVAL_MS && (serverSize === 0 || written < serverSize)) return;
        lastLog = now;
        const speed = (written - started) / Math.max(0.001, (now - tStart) / 1000);
        const pct = serverSize > 0 ? ' (' + ((written / serverSize) * 100).toFixed(1) + '%)' : '';
        const eta = serverSize > 0 && speed > 0 ? '，剩余约 ' + formatDuration((serverSize - written) / speed) : '';
        log(`· 已下载 ${formatBytes(written)}${serverSize > 0 ? ' / ' + formatBytes(serverSize) : ''}${pct}` +
          `，${formatBytes(speed)}/s${eta}`);
      });
      await pipeline(body, sink);
      if (idleTimer) clearTimeout(idleTimer);
      const finalSize = fs.statSync(partFile).size;
      if (serverSize > 0 && finalSize !== serverSize) {
        throw new Error(`下载不完整：本地 ${formatBytes(finalSize)}，服务器声明 ${formatBytes(serverSize)}`);
      }
      return finishPart(partFile, outFile, finalSize, resumedFromStart, attempts, t0, options);
    } catch (err) {
      if (idleTimer) clearTimeout(idleTimer);
      if (err instanceof FatalError) throw err;
      lastErr = err;
      if (attempt >= retries) break;
    }
  }
  throw new Error('下载失败（已重试 ' + attempts + ' 次）：' + (lastErr && lastErr.message) +
    '\n提示：可以手工下载后放进数据目录，或者换一个网络更稳的镜像/时间点重试。');
}

/** .part → 正式文件（含可选 md5 校验） */
async function finishPart(partFile, outFile, bytes, resumedFrom, attempts, t0, options) {
  const log = options.log;
  let digest = null;
  if (options.md5 && options.md5 !== 'off') {
    digest = await md5File(partFile);
    if (options.md5 !== 'auto') {
      if (digest !== String(options.md5).toLowerCase()) {
        fs.rmSync(partFile, { force: true });
        throw new Error(`md5 校验失败：期望 ${options.md5}，实际 ${digest}。已删除下载的文件，请重试。`);
      }
      log('· md5 校验通过：' + digest);
    }
  }
  if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
  fs.renameSync(partFile, outFile);
  const kind = detectKind(outFile);
  if (kind === 'unknown' || kind === 'empty') {
    log('· 警告：下载的文件格式认不出来（' + kind + '）——可能是错误页或截断文件：' + outFile);
  }
  return {
    bytes, resumedFrom, attempts, ms: Date.now() - t0,
    md5: digest, serverSize: bytes, kind,
  };
}

class FatalError extends Error {}

/* ------------------------------------------------------------------ *
 * 命令行
 * ------------------------------------------------------------------ */
const USAGE = [
  '用法：node tools/fetch-osm.js (--url <URL> | --city <id>) [--out <path>] [选项]',
  '',
  '数据源：',
  '  --url URL           OSM 数据源地址（.osm.pbf / .osm.gz）',
  '  --city ID           用 tools/cities.json 里的城市预设（同时决定 --url 与 --out）',
  '  --out PATH          保存路径（默认用 URL 里的文件名）',
  '',
  '行为：',
  '  --force             已存在完整文件时也重新下载',
  '  --max-age HOURS     本地文件比这个时间新就不下（默认 0 = 不判断）',
  '  --retries N         失败重试次数（默认 4）',
  '  --timeout MS        单次请求超时（默认 30000）',
  '  --idle MS           多久没收到数据就判定停滞（默认 60000）',
  '  --md5 HEX|auto|off  校验方式（默认 auto：试着取 <url>.md5）',
  '  --min-free-gb N     磁盘预检的可用空间下限（默认 0，按估算值判断）',
  '  --no-space-check    跳过磁盘预检',
  '  --check             只做 HEAD + 磁盘预检，不下载',
  '  --check-space-for FILE  只做磁盘预检（**完全不联网**）：算把本地这个 FILE 导入成库需要多少空间',
  '  --print-env         打印 shell 可 eval 的 KEY=VALUE（城市预设 + 预计大小），供 entrypoint 用',
  '  --env-prefix P      给 --print-env 的键名加前缀（如 CITY_ 得到 CITY_OSM_DB）',
  '  --root DIR          --print-env 时的绝对路径前缀（默认项目根目录）',
  '  --quiet             不打印进度，只打印最后一行',
  '  --json              结果以 JSON 打印到 stdout',
].join('\n');

function parseArgs(argv) {
  const out = {
    url: null, city: null, out: null, force: false, maxAgeHours: 0, retries: 4,
    timeoutMs: 30000, idleMs: 60000, md5: 'auto', minFreeGb: 0, spaceCheck: true,
    check: false, checkSpaceFor: null, printEnv: false, envPrefix: '', root: ROOT,
    quiet: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const take = () => {
      if (inline !== null) return inline;
      i++;
      if (i >= argv.length) throw new Error('参数 ' + key + ' 缺少取值');
      return argv[i];
    };
    switch (key) {
      case '--url': out.url = take(); break;
      case '--city': out.city = take(); break;
      case '--out': case '-o': out.out = take(); break;
      case '--force': out.force = true; break;
      case '--max-age': out.maxAgeHours = Number(take()); break;
      case '--retries': out.retries = Number(take()); break;
      case '--timeout': out.timeoutMs = Number(take()); break;
      case '--idle': out.idleMs = Number(take()); break;
      case '--md5': out.md5 = take(); break;
      case '--min-free-gb': out.minFreeGb = Number(take()); break;
      case '--no-space-check': out.spaceCheck = false; break;
      case '--check': out.check = true; break;
      case '--check-space-for': out.checkSpaceFor = take(); break;
      case '--print-env': out.printEnv = true; break;
      case '--env-prefix': out.envPrefix = take(); break;
      case '--root': out.root = path.resolve(take()); break;
      case '--quiet': case '-q': out.quiet = true; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (key.startsWith('-')) throw new Error('未知参数：' + key);
        break;
    }
  }
  return out;
}

/** 把城市预设 + 命令行参数合成一次执行的完整计划 */
function resolvePlan(args) {
  if (!args.url && !args.city) throw new Error('必须给 --url 或 --city 之一');
  if (args.url && args.city) throw new Error('--url 与 --city 只能用其中一个');
  let city = null;
  let cityEntry = null;
  if (args.city) {
    const table = loadCities();
    cityEntry = table.cities[args.city];
    if (!cityEntry) {
      const ids = Object.keys(table.cities);
      throw new Error('tools/cities.json 里没有城市 "' + args.city + '"' +
        (ids.length ? '（可选：' + ids.join(', ') + '）' : '（文件不存在或为空）'));
    }
    city = args.city;
    args.url = cityEntry.url;
    if (!args.url) throw new Error('城市 "' + args.city + '" 没有配 url（只配了本地文件路径？）');
    if (!args.out) args.out = path.resolve(args.root, cityEntry.source);
  }
  if (!args.out) args.out = path.resolve(args.root, 'data', 'osm', basenameFromUrl(args.url));
  return { city, cityEntry };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write('参数错误：' + err.message + '\n' + USAGE + '\n');
    process.exitCode = 1;
    return;
  }
  if (args.help || (!args.url && !args.city && !args.printEnv && !args.checkSpaceFor)) {
    process.stdout.write(USAGE + '\n');
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const quiet = args.quiet || args.json;
  const log = quiet ? () => {} : (msg) => process.stdout.write(msg + '\n');

  /**
   * --check-space-for FILE：**完全不联网**的空间预检。
   * 用途：容器里已经有来源包（不需要下载）但要导入时，entrypoint 得先知道磁盘够不够 ——
   * 这时候不能顺手 HEAD 一下数据源（OSM_AUTO_DOWNLOAD=0 的机器可能根本没网）。
   * 这里把"要下载的量"当成 0，只算"入库后的库大小 + 余量"。
   */
  if (args.checkSpaceFor) {
    const src = path.resolve(args.checkSpaceFor);
    if (!fs.existsSync(src)) {
      process.stderr.write('找不到来源文件：' + src + '\n');
      process.exitCode = 1;
      return;
    }
    const srcBytes = fs.statSync(src).size;
    const kind = kindFromName(src) !== 'unknown' ? kindFromName(src) : kindFromName(args.url || '');
    const target = path.resolve(args.out || path.join('data', 'osm', 'osm.sqlite'));
    const sp = checkSpace(target, 0, kind, args.minFreeGb);
    if (sp.free === null) {
      log('· 警告：读不到磁盘可用空间（' + (sp.error || 'statfs 不可用') + '），跳过空间预检。');
      return;
    }
    // 真正要落盘的估算 = 库大小（源文件已经在本地，不再重复算它的体积）
    const need = sp.db + SPACE_MARGIN;
    if (sp.free < Math.max(need, Number.isFinite(args.minFreeGb) && args.minFreeGb > 0 ? args.minFreeGb * 1024 ** 3 : 0)) {
      process.stderr.write(spaceAdvice({ ...sp, need, download: 0 }, kind, target) + '\n');
      process.exitCode = 1;
      return;
    }
    log(`· 空间预检通过（未联网）：来源 ${formatBytes(srcBytes)}（${kind}）→ 目标 ${target}；` +
      `${sp.dir} 可用 ${formatBytes(sp.free)}，入库预计需要约 ${formatBytes(need)}` +
      `（库约 ${formatBytes(sp.db)} = 源文件 × ${sp.factor}，另加余量 ${formatBytes(SPACE_MARGIN)}）`);
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, free: sp.free, need, db: sp.db, target, kind }) + '\n');
    return;
  }

  let cityEntry = null;
  try {
    const plan = resolvePlan(args);
    cityEntry = plan.cityEntry;
  } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exitCode = 1;
    return;
  }

  // --print-env：给 docker-entrypoint.sh 用，避免 shell 里再抄一遍城市表
  if (args.printEnv) {
    const p = (rel) => (rel ? path.resolve(args.root, rel) : '');
    const k = (name) => args.envPrefix + name;
    // 值一律用单引号包住（城市名里带空格/括号，裸着 eval 会直接语法错误）
    const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
    const lines = [
      k('OSM_CITY') + '=' + q(args.city || ''),
      k('OSM_CITY_NAME') + '=' + q(cityEntry ? cityEntry.name || args.city : ''),
      k('OSM_SOURCE_URL') + '=' + q(args.url || ''),
      k('OSM_SOURCE') + '=' + q(p(cityEntry ? cityEntry.source : path.relative(ROOT, args.out))),
      k('OSM_DB') + '=' + q(p(cityEntry ? cityEntry.db : path.join('data', 'osm', 'osm.sqlite'))),
      k('OSM_EST_SOURCE_MB') + '=' + q(cityEntry && cityEntry.estSourceMB ? cityEntry.estSourceMB : 0),
      k('OSM_EST_DB_MB') + '=' + q(cityEntry && cityEntry.estDbMB ? cityEntry.estDbMB : 0),
      k('OSM_EST_MINUTES') + '=' + q(cityEntry && cityEntry.estImportMinutes ? cityEntry.estImportMinutes : 0),
      k('OSM_KIND') + '=' + q(cityEntry && cityEntry.kind ? cityEntry.kind : kindFromName(args.url)),
    ];
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  const outFile = path.resolve(args.out);
  const kind = kindFromName(outFile) !== 'unknown' ? kindFromName(outFile) : kindFromName(args.url);

  // ① 本地已有完整文件？
  if (fs.existsSync(outFile) && !args.force) {
    const st = fs.statSync(outFile);
    const ageHours = (Date.now() - st.mtimeMs) / 3600000;
    if (args.maxAgeHours > 0 && ageHours > args.maxAgeHours) {
      log(`· 本地文件已过期（${ageHours.toFixed(1)} 小时 > ${args.maxAgeHours} 小时），重新下载。`);
    } else {
      const result = { file: outFile, bytes: st.size, skipped: true, kind: detectKind(outFile), ageHours };
      if (args.json) process.stdout.write(JSON.stringify(result) + '\n');
      else log(`· 已存在：${outFile}（${formatBytes(st.size)}，${ageHours.toFixed(1)} 小时前）—— 跳过下载。`);
      return;
    }
  }

  // ② HEAD：拿大小与是否支持 Range
  let head = { status: 0, size: 0, acceptRanges: false, finalUrl: args.url };
  try {
    head = await httpHead(args.url, args.timeoutMs);
    log(`· 数据源：${args.url}`);
    log(`  HTTP ${head.status}，大小 ${head.size ? formatBytes(head.size) : '未知'}` +
      `，断点续传 ${head.acceptRanges ? '支持' : '不支持（服务器没说 Accept-Ranges: bytes）'}`);
  } catch (err) {
    log('· 警告：HEAD 请求失败（' + err.message + '），继续尝试直接下载。');
  }

  // ③ 磁盘预检（在写下第一个字节之前）
  if (args.spaceCheck) {
    const sp = checkSpace(outFile, head.size, kind, args.minFreeGb);
    if (sp.free === null) {
      log('· 警告：读不到磁盘可用空间（' + (sp.error || 'statfs 不可用') + '），跳过空间预检。');
    } else if (!sp.ok) {
      process.stderr.write(spaceAdvice(sp, kind, outFile) + '\n');
      process.exitCode = 1;
      return;
    } else {
      log(`· 磁盘预检通过：${sp.dir} 可用 ${formatBytes(sp.free)}，本次需要约 ${formatBytes(sp.need)}` +
        `（下载 ${formatBytes(sp.download)} + 库约 ${formatBytes(sp.db)} + 余量 ${formatBytes(SPACE_MARGIN)}）`);
    }
  }

  if (args.check) {
    log('· --check：只做检查，不下载。');
    return;
  }

  // ④ 校验值（默认试着取对方提供的 .md5）
  let md5 = args.md5;
  if (md5 === 'auto') {
    try {
      const text = await httpGetText(args.url + '.md5', args.timeoutMs);
      const got = parseMd5Text(text);
      if (got) {
        md5 = got;
        log('· 找到 ' + args.url + '.md5，下载后会校验：' + got);
      } else {
        md5 = 'off';
        log('· 对方有 .md5 但内容认不出来，跳过校验。');
      }
    } catch {
      md5 = 'off';
      log('· 对方没有提供 .md5（或取不到），跳过校验。');
    }
  }

  // ⑤ 下载
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const t0 = Date.now();
  const result = await download(args.url, outFile, {
    log, quiet, retries: args.retries, timeoutMs: args.timeoutMs, idleMs: args.idleMs, md5,
  });

  const summary = {
    file: outFile, bytes: result.bytes, kind: result.kind, md5: result.md5,
    attempts: result.attempts, ms: Date.now() - t0, resumedFrom: result.resumedFrom,
    city: args.city || null, url: args.url,
  };
  if (args.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else if (quiet) {
    process.stdout.write(`下载完成：${outFile} ${formatBytes(result.bytes)} 耗时 ${formatDuration(summary.ms / 1000)}\n`);
  } else {
    process.stdout.write([
      '',
      '===== 下载结果 =====',
      `文件      : ${outFile}`,
      `格式      : ${result.kind}`,
      `大小      : ${formatBytes(result.bytes)}${result.resumedFrom ? `（其中续传复用 ${formatBytes(result.resumedFrom)}）` : ''}`,
      `耗时      : ${formatDuration(summary.ms / 1000)}（重试 ${result.attempts - 1} 次）`,
      `md5       : ${result.md5 || '未校验'}`,
      `下一步    : node tools/import-osm.js --file "${outFile}" --db <目标库> --force`,
      '====================',
    ].join('\n') + '\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('下载失败：' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs, resolvePlan, download, md5File, checkSpace, freeBytesOf, loadCities,
  formatBytes, kindFromName, parseMd5Text, CITIES_FILE,
};
