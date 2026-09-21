'use strict';
// 清空人口网格，让服务端下次启动用新公式（只有建筑算人口 + 区域活跃度）重建
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/osm/osm.sqlite');
for (const t of ['population_cells', 'population_sources']) {
  try { db.exec('DELETE FROM ' + t); console.log('已清空 ' + t); } catch (e) { console.log(t + ' 跳过: ' + e.message); }
}
db.close();
