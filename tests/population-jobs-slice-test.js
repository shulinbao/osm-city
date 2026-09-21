'use strict';
/**
 * **岗位开关 + 人口全量重建的切片 / 可续算 / 进度** —— 本次改造的专项测试（新建文件，
 * 不动任何既有套件；既有套件的数字是验收基线）。
 *
 * 覆盖：
 *   ① 默认 computeJobs=false（不算岗位）：
 *      · 商业/办公/工业建筑**既不产生人口也不产生岗位**（它们今天本来对人口/客流的贡献就是 0）；
 *      · population_cells.jobs 恒 0；
 *      · 住宅人口与"改造前的旧实现"**逐格逐值相同**（下面那组金标准数字就是旧实现跑出来的）。
 *   ② computeJobs=true：完整复现改造前的旧口径（人口与岗位两列都逐值相同）。
 *   ③ jobsBuildingsCountAsPopulation=true（旧口径 v1）：商业/办公/工业建筑改按人口算。
 *   ④ 切片：够大的库上真的会切好几片，**跑的过程中定时器能插进来**（事件循环没被占死）。
 *   ⑤ 进度是**精确**的（processed/total），算完 meta 里的 population_build_state.done=1。
 *   ⑥ **可续算**：中途"崩"掉（未提交的事务丢掉）→ 库里留下断点与部分结果；
 *      再跑一次 resume:true ⇒ 跳过已算过的 way，最终逐格结果与"一次跑完"**完全一致**。
 *   ⑦ 口径变了（算不算岗位）⇒ 断点作废，必须从头重建。
 *
 *   node tests/population-jobs-slice-test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  Population, MODEL_VERSION, COMPUTE_JOBS_DEFAULT, JOBS_BUILDINGS_COUNT_AS_POP_DEFAULT, jobsModeCode,
} = require('../server/population');
const { SCHEMA_SQL } = require('../server/dbschema');

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log('  ✅ ' + name + (detail ? `  (${detail})` : '')); }
  else { failed += 1; failures.push(name + ' :: ' + detail); console.log('  ❌ ' + name + `  → ${detail}`); }
};
const eq = (name, got, want) => check(name, got === want, `got=${got} want=${want}`);

const TMP = path.join(__dirname, 'tmp-jobs-slice');
const DB = path.join(TMP, 'pop.sqlite');

/* ------------------------------ 迷你库（确定性 fixture） ------------------------------ */
const BASE_LAT = 39.9042;
const BASE_LON = 116.4074;
const D = 0.0001;                       // ≈ 11 m
/** 与实测口径同一份 fixture：住宅 / 商业 / 办公 / building=yes+学校 / 住宅+店面 / 跨格大住宅 / 车库 / 工业 */
const CASES = [
  [{ building: 'apartments', 'building:levels': '10' }, 1.0],
  [{ building: 'house' }, 0.5],
  [{ building: 'commercial', 'building:levels': '5' }, 1.0],
  [{ building: 'office', 'building:levels': '20' }, 0.8],
  [{ building: 'yes', amenity: 'school', 'building:levels': '3' }, 0.6],
  [{ building: 'apartments', shop: 'convenience', 'building:levels': '6' }, 0.9],
  [{ building: 'apartments', 'building:levels': '30' }, 4.0],
  [{ building: 'garage' }, 0.4],
  [{ building: 'industrial', 'building:levels': '4' }, 1.2],
];

function newDb(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * @param filler 再铺多少栋普通住宅。**切片/分批/续算在大库上才trigger得到**：
 *   FILLER=0 → 11 条 way、整轮十几毫秒（撞不到片边界，onProgress 只会被收尾那一次调用）；
 *   FILLER_BIG=6000 → 几百毫秒，真的会切好几片、提交好几批。
 *   ⚠ 不能只用几百条：Windows 上 `Date.now()` 的粒度可以粗到 ~15 ms（实测：400 条的整轮
 *     只有 25 ms，切片判断整轮只跳了一次），所以库要够大才测得出"切了很多片"。
 */
const FILLER_BIG = 6000;
function seed(db, filler = 0) {
  let nodeId = 1000;
  const pt = (lat, lon) => {
    db.prepare('INSERT INTO nodes(id, lat, lon, version, deleted, tags) VALUES(?,?,?,1,0,NULL)').run(nodeId, lat, lon);
    const id = nodeId;
    nodeId += 1;
    return id;
  };
  const ring = (lat0, lon0, side) => {
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ids.push(pt(lat0 + Math.sin(a) * D * side, lon0 + Math.cos(a) * D * side));
    }
    ids.push(ids[0]);                    // 闭合
    return ids;
  };
  const putWay = (wid, tags, ids, box) => {
    db.prepare('INSERT INTO ways(id, version, deleted, tags, closed, node_count, min_lat, max_lat, min_lon, max_lon) VALUES(?,1,0,?,1,?,?,?,?,?)')
      .run(wid, JSON.stringify(tags), ids.length, box[0], box[1], box[2], box[3]);
    ids.forEach((nid, seq) => db.prepare('INSERT INTO way_nodes(way_id, node_id, seq) VALUES(?,?,?)').run(wid, nid, seq));
  };
  db.exec('BEGIN');
  let wid = 5000;
  for (const [tags, side] of CASES) {
    const lat = BASE_LAT + (wid - 5000) * 0.004;
    const ids = ring(lat, BASE_LON, side);
    putWay(wid, tags, ids, [lat - D * side, lat + D * side, BASE_LON - D * side, BASE_LON + D * side]);
    wid += 1;
  }
  // 400 条一行的密集住宅网格（2D 铺开，别铺成一个 5 度的长条）
  for (let k = 0; k < filler; k++) {
    const row = Math.floor(k / 40);
    const col = k % 40;
    const lat = BASE_LAT - 0.05 - row * 0.0009;
    const lon = BASE_LON + 0.05 + col * 0.0009;
    putWay(wid, { building: 'apartments', 'building:levels': '4' }, ring(lat, lon, 1.0), [lat - D, lat + D, lon - D, lon + D]);
    wid += 1;
  }
  db.exec('COMMIT');
  // 一条**不闭合**的住宅（不该算）+ 一条带标签的道路（不该算）+ 一条没有标签的 way（taggedWays 不该选它）
  const open = [];
  for (let i = 0; i < 5; i++) open.push(pt(BASE_LAT + 0.2 + i * D, BASE_LON));
  db.prepare('INSERT INTO ways(id, version, deleted, tags, closed, node_count) VALUES(?,1,0,?,0,?)')
    .run(wid, JSON.stringify({ building: 'apartments', 'building:levels': '8' }), open.length);
  open.forEach((nid, seq) => db.prepare('INSERT INTO way_nodes(way_id, node_id, seq) VALUES(?,?,?)').run(wid, nid, seq));
  wid += 1;
  db.prepare('INSERT INTO ways(id, version, deleted, tags, closed, node_count) VALUES(?,1,0,?,0,2)')
    .run(wid, JSON.stringify({ highway: 'residential', name: '测试路' }));
  db.prepare('INSERT INTO ways(id, version, deleted, tags, closed, node_count) VALUES(?,1,0,NULL,1,3)').run(wid + 1);
  db.close();
}

function dump(db) {
  return db.prepare('SELECT cell_x, cell_y, pop, jobs FROM population_cells ORDER BY cell_x, cell_y').all()
    .map((r) => `${r.cell_x},${r.cell_y},${r.pop},${r.jobs}`).join('\n');
}
function sums(db) {
  const r = db.prepare('SELECT COUNT(*) c, SUM(pop) pop, SUM(jobs) jobs FROM population_cells').get();
  return { cells: r.c, pop: r.pop, jobs: r.jobs };
}

/**
 * 旧实现（改造前）在 FILLER=0 这份 fixture 上的**实测结果**（金标准，来自改造前跑的那一遍）：
 *   sumPop = 4234.480546875 · sumJobs = 145.125703125 · 10 个格子 · 其中 6 个格子 jobs != 0
 * 改造后 computeJobs=true 必须**一模一样**；默认（不算岗位）必须 pop 一模一样、jobs 全 0。
 */
const GOLD = { cells: 10, pop: 4234.480546875, jobs: 145.125703125, entries: 10 };

(async () => {
  console.log('\n=== 岗位开关 + 人口全量重建（切片 / 可续算 / 进度）===\n');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  /* ------------------------------ ① 默认：不算岗位 ------------------------------ */
  console.log('▶ ① 默认 computeJobs=false（小库 · 金标准口径）');
  seed(newDb(DB));
  let dumpJobsOn = '';
  let dumpDefault = '';
  {
    const db = new DatabaseSync(DB);
    const pop = new Population(db);
    check('默认就是"不算岗位"（computeJobs=false）', pop.computeJobs === false, `computeJobs=${pop.computeJobs}`);
    check('两个默认值都是 false（不算岗位 / 商业楼不算人口）',
      COMPUTE_JOBS_DEFAULT === false && JOBS_BUILDINGS_COUNT_AS_POP_DEFAULT === false,
      `jobsModeCode(false,false)=${jobsModeCode(false, false)}`);
    const st = await pop.buildAll();
    const s = sums(db);
    eq('默认口径不算岗位：jobs 列恒 0', s.jobs, 0);
    eq('默认口径的格子数（比旧口径少掉的正是"只有岗位没有人口"的格子）', s.cells, 5);
    eq('默认口径的人口合计与旧实现**逐值相同**', s.pop, GOLD.pop);
    check('buildAll 结果里如实报告"不算岗位"', st.computeJobs === false && st.jobs === 0, `jobs=${st.jobs}`);
    dumpDefault = dump(db);
    db.close();
  }

  /* ------------------------------ ② computeJobs=true：复现旧口径 ------------------------------ */
  console.log('\n▶ ② computeJobs=true（改造前的口径 · 必须逐值复现）');
  seed(newDb(DB));
  {
    const db = new DatabaseSync(DB);
    const pop = new Population(db, { computeJobs: true });
    const st = await pop.buildAll();
    const s = sums(db);
    dumpJobsOn = dump(db);
    eq('算岗位时格子数与旧实现相同', s.cells, GOLD.cells);
    eq('算岗位时人口合计与旧实现**逐值相同**', s.pop, GOLD.pop);
    eq('算岗位时岗位合计与旧实现**逐值相同**', s.jobs, GOLD.jobs);
    eq('算岗位时"写进格子的条目数"与旧实现相同（buildAll 的 cells 记账口径）', st.cells, GOLD.entries);
    db.close();
  }

  /* ------------------------------ ③ 商业楼也算人口（旧口径 v1） ------------------------------ */
  console.log('\n▶ ③ jobsBuildingsCountAsPopulation=true（旧口径 v1）');
  seed(newDb(DB));
  {
    const db = new DatabaseSync(DB);
    const pop = new Population(db, { jobsBuildingsCountAsPopulation: true });
    await pop.buildAll();
    const s = sums(db);
    check('商业/办公/工业建筑改按人口算 ⇒ 人口变大（默认口径是**不变**）', s.pop > GOLD.pop, `pop=${s.pop} > ${GOLD.pop}`);
    eq('这个口径下 jobs 仍然是 0（不算岗位）', s.jobs, 0);
    db.close();
  }

  /* ------------------------------ ④ 默认口径逐格对拍 ② ------------------------------ */
  console.log('\n▶ ④ 默认口径逐格结果（与②只差"岗位列"）');
  {
    const onRows = new Map(dumpJobsOn.split('\n').map((l) => { const p = l.split(','); return [p[0] + ',' + p[1], p]; }));
    let samePop = 0;
    let diffPop = 0;
    let missingAllZeroPop = 0;
    const keysDefault = new Set();
    for (const line of dumpDefault.split('\n')) {
      const p = line.split(',');
      keysDefault.add(p[0] + ',' + p[1]);
      const a = onRows.get(p[0] + ',' + p[1]);
      if (!a) { diffPop += 1; continue; }
      if (a[2] === p[2]) samePop += 1; else diffPop += 1;
    }
    for (const [k, a] of onRows) {
      if (!keysDefault.has(k)) { if (Number(a[2]) === 0) missingAllZeroPop += 1; else diffPop += 1; }
    }
    check('默认口径的 pop 列与旧口径**逐格逐值相同**',
      diffPop === 0 && samePop === keysDefault.size, `samePop=${samePop} diffPop=${diffPop} 默认格子=${keysDefault.size}`);
    check('只在旧口径里出现的格子，pop 全是 0（它们只贡献岗位）', missingAllZeroPop === 5, `count=${missingAllZeroPop}`);
  }

  /* ------------------------------ ⑤ 切片 + 精确进度 + done 标记（大库） ------------------------------ */
  console.log(`\n▶ ⑤ 切片（事件循环没被占死）+ 精确进度 + done 标记（FILLER=${FILLER_BIG}）`);
  seed(newDb(DB), FILLER_BIG);
  let fullDump = '';
  let fullCells = 0;
  {
    const db = new DatabaseSync(DB);
    const pop = new Population(db, { sliceMs: 1, commitMs: 20, commitEveryWays: 200 });
    let turns = 0;
    const t = setInterval(() => { turns += 1; }, 1);
    const seen = [];
    const st = await pop.buildAll({ onProgress: (frac, info) => seen.push({ frac, ...info }) });
    clearInterval(t);
    fullDump = dump(db);
    fullCells = sums(db).cells;
    check('切片跑的时候定时器能插进来（事件循环是活的）', turns > 0, `定时器跑了 ${turns} 次`);
    check('真的切了好几片（不是一大块同步循环）', st.slices > 3 && st.batches > 1,
      `slices=${st.slices} batches=${st.batches} maxSliceMs=${st.maxSliceMs} 总耗时=${st.ms}ms`);
    check('进度回调给的是精确的 processed/total', seen.length > 1 && seen.every((s) => s.total === st.total && s.processed <= s.total),
      `回调 ${seen.length} 次 · total=${st.total}`);
    check('进度是按条数单调不减的，且覆盖全部 way',
      seen.length > 0 && seen[seen.length - 1].processed === st.total && (() => {
        for (let i = 1; i < seen.length; i++) if (seen[i].processed < seen[i - 1].processed) return false;
        return true;
      })(), `processed ${seen[0].processed}→${seen[seen.length - 1].processed}/${st.total}`);
    check('最长一次"占着事件循环不撒手"被如实量出来（>0 且远小于总耗时）',
      st.maxSliceMs > 0 && st.maxSliceMs <= st.ms, `maxSliceMs=${st.maxSliceMs} 总耗时=${st.ms}`);
    const state = pop.buildState();
    check('meta 里记下"算完了"（done=1）+ 口径 + 进度',
      !!state && state.done === 1 && Number(state.v) === MODEL_VERSION && state.processed === st.total,
      JSON.stringify(state));
    eq('population_model / population_jobs_mode 都写进 meta 了',
      db.prepare("SELECT COUNT(*) c FROM meta WHERE key IN ('population_model','population_jobs_mode')").get().c, 2);
    db.close();
  }

  /* ------------------------------ ⑥ 可续算 ------------------------------ */
  console.log('\n▶ ⑥ 中途被打断 ⇒ 从断点续算，结果与"一次跑完"完全一致');
  seed(newDb(DB), FILLER_BIG);
  {
    // 6a) 打断：借 onProgress 抛错模拟"进程在批次中途消失"（未提交的那一批会回滚）
    const db = new DatabaseSync(DB);
    const pop = new Population(db, { sliceMs: 1, commitMs: 20, commitEveryWays: 200 });
    let killed = false;
    try {
      await pop.buildAll({
        onProgress: (frac, info) => {
          if (!killed && info.processed >= Math.floor(info.total / 2)) { killed = true; throw new Error('模拟被打断'); }
        },
      });
    } catch { /* 预期：被打断 */ }
    check('打断确实发生了（onProgress 里抛出去了）', killed, '');
    const state1 = pop.buildState();
    const partial = sums(db);
    check('被打断之后：断点记着 done=0（还是"没算完"）', !!state1 && state1.done === 0, JSON.stringify(state1));
    check('被打断之后：库里留下了一部分结果（不是全丢）', partial.cells > 0 && partial.cells < fullCells,
      `cells=${partial.cells}/${fullCells}`);
    eq('被打断之后：断点与数据一致（source 行数 = 断点里的 ways）',
      db.prepare('SELECT COUNT(*) c FROM population_sources').get().c, state1.ways);
    db.close();

    // 6b) 续算
    const db2 = new DatabaseSync(DB);
    const pop2 = new Population(db2, { sliceMs: 1, commitMs: 20, commitEveryWays: 200 });
    check('库里那套断点被判定为"可以续算"', pop2.buildStateResumable(pop2.buildState()) === true, '');
    const st2 = await pop2.buildAll({ resume: true });
    check('续算这一轮确实走了续算分支', st2.resumed === true, `resumed=${st2.resumed}`);
    check('续算**只算了剩下的那部分**（不是从头再来）', st2.ways < FILLER_BIG,
      `本轮新增有贡献的 way=${st2.ways}（全量是 ${FILLER_BIG + 4}）· 扫过=${st2.scanned}/${st2.total}`);
    eq('续算后的逐格结果与"一次跑完"**完全一致**', dump(db2), fullDump);
    const state2 = pop2.buildState();
    check('续算完 ⇒ done=1（下次 buildAll 是重新全量，不会把两轮混在一起）', !!state2 && state2.done === 1, JSON.stringify(state2));
    db2.close();
  }

  /* ------------------------------ ⑦ 口径变了就不许续算 ------------------------------ */
  console.log('\n▶ ⑦ 口径变了 ⇒ 断点作废、从头重建');
  seed(newDb(DB), FILLER_BIG);
  {
    const db = new DatabaseSync(DB);
    const pop = new Population(db, { sliceMs: 1, commitMs: 20, commitEveryWays: 200 });
    let killed = false;
    try {
      await pop.buildAll({
        // 打断点要**落在第一批提交之后**（不然库里连断点都还没有，那就成了"全新"场景而不是"续算"场景）
        onProgress: (frac, info) => { if (!killed && info.processed >= 1500) { killed = true; throw new Error('断'); } },
      });
    } catch { /* 预期 */ }
    check('打断确实发生了（onProgress 里抛出去了）', killed, '');
    check('打断后断点可续算（同一口径）', pop.buildStateResumable(pop.buildState()) === true,
      JSON.stringify(pop.buildState()));
    const pop2 = new Population(db, { computeJobs: true, sliceMs: 1, commitMs: 20, commitEveryWays: 200 });
    check('换了岗位口径之后，同一份断点**不再**可续算（必须从头重建）',
      pop2.buildStateResumable(pop2.buildState()) === false, `jobsMode=${pop2.jobsMode}`);
    const st = await pop2.buildAll({ resume: true });
    check('口径不一致时即使传了 resume 也走全量重建（resumed=false，岗位也真的算出来了）',
      st.resumed === false && sums(db).jobs > 0, `resumed=${st.resumed} jobs=${sums(db).jobs}`);
    db.close();
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed) for (const f of failures) console.log('  ❌ ' + f);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('测试自身炸了:', err); process.exit(2); });
