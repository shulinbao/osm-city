'use strict';
/**
 * 清理没有挂线路的闲置车辆（历次浏览器测试/烟测留下的起步车队）。
 * 先把这些行导出成 JSON 备份，再删除；打印前后计数。
 *   node tools/cleanup-idle-vehicles.js            # 备份 + 删除
 *   node tools/cleanup-idle-vehicles.js --dry-run  # 只看数量，不动数据
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB = path.join(__dirname, '..', 'data', 'osm', 'osm.sqlite');
const dry = process.argv.includes('--dry-run');
const db = new DatabaseSync(DB);

const before = db.prepare('SELECT COUNT(*) AS n FROM vehicles').get().n;
const idle = db.prepare('SELECT * FROM vehicles WHERE line_id IS NULL').all();
console.log(`车辆总数 ${before}，其中闲置（未挂线路）${idle.length} 辆`);

if (dry) {
  console.log('--dry-run：没有改动数据库');
  db.close();
  process.exit(0);
}

// 只备份被删掉的那些行（避免复制 500MB 的整库）
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(__dirname, '..', 'tests', `backup-idle-vehicles-${stamp}.json`);
fs.writeFileSync(out, JSON.stringify({ exportedAt: Date.now(), table: 'vehicles', where: 'line_id IS NULL', rows: idle }, null, 1), 'utf8');
console.log(`已备份 ${idle.length} 行到 ${path.relative(path.join(__dirname, '..'), out)}`);

const res = db.prepare('DELETE FROM vehicles WHERE line_id IS NULL').run();
console.log(`已删除 ${res.changes} 辆闲置车`);
const after = db.prepare('SELECT COUNT(*) AS n FROM vehicles').get().n;
const online = db.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE line_id IS NOT NULL').get().n;
console.log(`清理后：车辆总数 ${after}（在线上运营 ${online} 辆）`);
db.close();
