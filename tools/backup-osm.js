'use strict';
/**
 * OSM 库备份工具（零第三方依赖，只用 Node 内置模块）
 *
 * 用 SQLite 的 `VACUUM INTO` 做一份**一致**的副本：走一次读事务（能看到 WAL 里已提交的内容），
 * 生成单文件、无 WAL、且顺带整理过（体积通常比原文件小 10% 左右，实测 501.7 MB → 457.0 MB / 3.1 s）。
 *
 * 为什么不用文件复制：库开着 WAL 时，`osm.sqlite` 与 `osm.sqlite-wal` 必须**一起**拷才一致；
 * 只拷主文件会丢掉最近提交的事务。VACUUM INTO 没有这个坑，也不需要在复制前停服务。
 *
 * 用法：
 *   node tools/backup-osm.js [--db <path.sqlite>] [--out <path.sqlite>] [--quiet]
 *
 * 默认：--db data/osm/osm.sqlite，--out data/osm/backup/osm-<YYYYMMDD-HHmmss>.sqlite
 * 目标文件已存在时报错退出（不会覆盖已有备份）。成功后打印行数核对，便于和原库对照。
 */
const fs = require('fs');
const path = require('path');

const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return _emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const USAGE = [
  '用法：node tools/backup-osm.js [--db <path.sqlite>] [--out <path.sqlite>] [--quiet]',
  '  --db    要备份的库（默认 data/osm/osm.sqlite）',
  '  --out   输出文件（默认 data/osm/backup/osm-<时间戳>.sqlite；已存在则报错，不覆盖）',
  '  --quiet 只打印一行摘要',
].join('\n');

function parseArgs(argv) {
  const out = { db: 'data/osm/osm.sqlite', out: null, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const take = () => { if (inline !== null) return inline; i++; if (i >= argv.length) throw new Error('参数 ' + key + ' 缺少取值'); return argv[i]; };
    switch (key) {
      case '--db': out.db = take(); break;
      case '--out': out.out = take(); break;
      case '--quiet': case '-q': out.quiet = true; break;
      case '--help': case '-h': out.help = true; break;
      default: if (key.startsWith('-')) throw new Error('未知参数：' + key); break;
    }
  }
  return out;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) {
    process.stderr.write('参数错误：' + err.message + '\n' + USAGE + '\n');
    process.exitCode = 1;
    return;
  }
  if (args.help) { process.stdout.write(USAGE + '\n'); return; }
  const log = args.quiet ? () => {} : (m) => process.stdout.write(m + '\n');

  if (!fs.existsSync(args.db)) {
    process.stderr.write('找不到库文件：' + args.db + '\n');
    process.exitCode = 1;
    return;
  }
  const out = args.out || path.join(path.dirname(args.db), 'backup', `osm-${timestamp()}.sqlite`);
  if (fs.existsSync(out)) {
    process.stderr.write(`目标文件已存在，拒绝覆盖：${out}\n（备份工具不该悄悄盖掉旧备份，请换个 --out）\n`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

  const t0 = Date.now();
  const db = new DatabaseSync(args.db);
  try {
    const srcBytes = fs.statSync(args.db).size;
    log(`· 备份 ${args.db}（${(srcBytes / 1048576).toFixed(1)} MB）→ ${out}`);
    db.exec(`VACUUM INTO '${path.resolve(out).replace(/\\/g, '/').replace(/'/g, "''")}'`);
    const outBytes = fs.statSync(out).size;
    const probe = new DatabaseSync(out, { readOnly: true });
    const c = probe.prepare(`SELECT (SELECT COUNT(*) FROM nodes) nodes,
      (SELECT COUNT(*) FROM ways) ways,
      (SELECT COUNT(*) FROM relations) relations,
      (SELECT COUNT(*) FROM changesets) changesets`).get();
    const check = probe.prepare('PRAGMA quick_check').get().quick_check;
    probe.close();
    if (args.quiet) {
      process.stdout.write(`备份完成：${out}（${(outBytes / 1048576).toFixed(1)} MB，${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);
    } else {
      process.stdout.write([
        '',
        '===== OSM 备份完成 =====',
        `源库      : ${args.db}（${(srcBytes / 1048576).toFixed(1)} MB）`,
        `备份      : ${path.resolve(out)}（${(outBytes / 1048576).toFixed(1)} MB）`,
        `计数      : nodes=${c.nodes} ways=${c.ways} relations=${c.relations} changesets=${c.changesets}`,
        `完整性    : quick_check=${check}`,
        `耗时      : ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        '========================',
      ].join('\n') + '\n');
    }
    if (check !== 'ok') process.exitCode = 2;
  } catch (err) {
    process.stderr.write('备份失败：' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

if (require.main === module) main();

module.exports = { parseArgs, timestamp };
