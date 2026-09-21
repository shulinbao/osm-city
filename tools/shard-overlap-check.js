'use strict';
/**
 * 跨分片对账（我自己的独立验收脚本，不依赖任何 agent 的自述）
 *
 *   node logs/shard-overlap-check.js [分片库...]
 *   不传参数时自动扫 data/regions/*.sqlite
 *
 * 它回答三个问题 —— 这三个正是"分区流式"能不能成立的前提：
 *   ① 每片规模（nodes/ways/relations + 库大小）
 *   ② **id 区间是否相交（硬断言）**：两片都用"自己 max+1"发号的话，
 *      迟早发出同一个 id —— 那会让"新建元素"在合并时静默覆盖已有元素。
 *   ③ **同 id 重叠与内容一致性**：跨边界的 way 会在两个提取包里各被截断一段，
 *      于是同 id 但 refs/几何不同；连节点坐标是否一致也要查。
 *
 * 实现要点：用 SQLite 的 ATTACH 把其它分片挂到同一个连接上，让 SQL JOIN 干活
 * （两边 id 都是主键，走索引；几百万行也很快）。注意 **第 0 片是主连接，表名不带别名**，
 * 其余片才用 s1/s2/… 前缀 —— 第一版就是在这里写错成 s0 直接崩的。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const files = argv.length
  ? argv
  : (fs.existsSync('data/regions')
    ? fs.readdirSync('data/regions').filter((f) => f.endsWith('.sqlite')).map((f) => path.join('data/regions', f))
    : []);
if (!files.length) { console.error('没找到分片库：传路径，或先建 data/regions/*.sqlite'); process.exit(1); }
if (files.length > 4) { console.error('分片太多（>4）：本脚本按两两组合做 JOIN，请分批跑'); process.exit(1); }

const short = (f) => path.basename(f, '.sqlite');
const main = new DatabaseSync(files[0], { readOnly: true });
files.forEach((f, i) => {
  if (i > 0) main.exec(`ATTACH DATABASE '${path.resolve(f).replace(/'/g, "''")}' AS s${i}`);
});
/** 第 0 片是主连接（表名不带前缀），其余片加 s<i>. 前缀 */
const T = (i, name) => (i === 0 ? name : `s${i}.${name}`);

console.log('=== ① 每片规模 ===');
const sizes = files.map((f, i) => {
  const r = {
    name: short(f),
    nodes: main.prepare(`SELECT COUNT(*) c FROM ${T(i, 'nodes')}`).get().c,
    ways: main.prepare(`SELECT COUNT(*) c FROM ${T(i, 'ways')}`).get().c,
    relations: main.prepare(`SELECT COUNT(*) c FROM ${T(i, 'relations')}`).get().c,
  };
  console.log(`  ${r.name.padEnd(12)} nodes=${String(r.nodes).padStart(9)} ways=${String(r.ways).padStart(8)} `
    + `relations=${String(r.relations).padStart(6)}  库 ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
  return r;
});

console.log('\n=== ② id 区间是否相交（硬断言）===');
const ranges = files.map((f, i) => {
  const next = (key) => {
    try { const r = main.prepare(`SELECT value v FROM ${T(i, 'meta')} WHERE key = ?`).get(key); return r ? Number(r.v) : null; } catch { return null; }
  };
  const maxOf = (t) => main.prepare(`SELECT COALESCE(MAX(id),0) m FROM ${T(i, t)}`).get().m;
  const r = { name: short(f), nextNode: next('next_node_id'), maxNode: maxOf('nodes'), maxWay: maxOf('ways'), maxRel: maxOf('relations') };
  console.log(`  ${r.name.padEnd(12)} 现有最大 id: node=${r.maxNode} way=${r.maxWay} relation=${r.maxRel}`);
  console.log(`  ${''.padEnd(12)} 新建发号起点 next_node_id=${r.nextNode}`);
  return r;
});
let overlap = false;
for (let i = 0; i < ranges.length; i++) {
  for (let j = i + 1; j < ranges.length; j++) {
    const A = ranges[i], B = ranges[j];
    const hit = (A.nextNode != null && B.maxNode != null && A.nextNode <= B.maxNode)
      || (B.nextNode != null && A.maxNode != null && B.nextNode <= A.maxNode);
    if (hit) overlap = true;
    console.log(`  ${A.name} × ${B.name}: 一方的发号起点是否已落进对方已有 id 范围 → ${hit ? '❌ 是' : '✅ 否'}`);
  }
}
console.log('  → ' + (overlap
  ? '已存在交叠风险：两片各自发号会撞号，必须引入互不相交的 id 区间或全局分配器'
  : '当前无交叠；但两片都按"自己 max+1"发号，随着新建元素必然走向交叠 —— 设计必须改成互不相交的 id 区间'));

if (files.length > 1) {
  console.log('\n=== ③ 同 id 重叠与内容一致性 ===');
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const A = i, B = j;
      const pair = (t) => main.prepare(`SELECT COUNT(*) c FROM ${T(A, t)} a JOIN ${T(B, t)} b ON b.id = a.id`).get().c;
      const nSame = pair('nodes'), wSame = pair('ways'), rSame = pair('relations');
      console.log(`  ${ranges[i].name} × ${ranges[j].name}: 同 id  node=${nSame}  way=${wSame}  relation=${rSame}`);
      if (nSame) {
        const diffCoord = main.prepare(
          `SELECT COUNT(*) c FROM ${T(A, 'nodes')} a JOIN ${T(B, 'nodes')} b ON b.id = a.id
           WHERE a.lat <> b.lat OR a.lon <> b.lon`).get().c;
        console.log(`     同 id 节点里坐标不同的: ${diffCoord}（应为 0）`);
      }
      if (wSame) {
        const diffCount = main.prepare(
          `SELECT COUNT(*) c FROM ${T(A, 'ways')} a JOIN ${T(B, 'ways')} b ON b.id = a.id
           WHERE a.node_count <> b.node_count`).get().c;
        const diffMeta = main.prepare(
          `SELECT COUNT(*) c FROM ${T(A, 'ways')} a JOIN ${T(B, 'ways')} b ON b.id = a.id
           WHERE a.version <> b.version OR COALESCE(a.tags,'') <> COALESCE(b.tags,'')`).get().c;
        console.log(`     way 里"节点数不同"（几何被各自截断）: ${diffCount}   "版本或标签不同": ${diffMeta}`);
        for (const r of main.prepare(
          `SELECT a.id, a.node_count an, b.node_count bn, a.tags at
           FROM ${T(A, 'ways')} a JOIN ${T(B, 'ways')} b ON b.id = a.id
           WHERE a.node_count <> b.node_count LIMIT 5`).all()) {
          console.log(`       way ${r.id}: ${ranges[i].name}=${r.an} 节点 / ${ranges[j].name}=${r.bn} 节点  tags=${String(r.at).slice(0, 70)}`);
        }
      }
    }
  }
}
main.close();
