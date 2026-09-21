#!/bin/sh
# ============================================================================
#  deploy/build-seed.sh —— **构建期**生成"种子库"（把一次性计算烘进镜像）
#
#  为什么要有它
#  ------------
#  容器首次启动时，服务器要干的活远不止"导入 OSM"：
#    ① tools/import-osm.js 把源包写进 sqlite（写元素 + 回填 bbox/几何 + 建索引）；
#    ② 服务器**启动时**做数据库迁移（server/dbschema.js）与 **LOD 物化列回填**
#       （ways.road_class / ways.lod_zoom + 部分索引 idx_ways_lod_zoom）；
#    ③ **首次人口/岗位网格全量推算**（population.js 的 buildAll()）—— 北京这种数据集要扫
#       三十多万条带标签的 way。现在的实现**切片跑**（每片 ≤ 25 ms 让出事件循环，所以 1 GB 的
#       VPS 不再被"一整段同步循环"卡死），但它仍然是分钟级的 CPU + 磁盘活，
#       而且在当前实现下**永远算不完**（见下面"已知 bug"）—— 小机器上表现为反复重启、反复续算；
#    ④ 铁路网 / 道路网 / 线路路径的构建（这几个在**内存**里，不进库，每次启动都要重建）。
#
#  所以本脚本在**构建机**（CI runner / 开发机：CPU 与内存都富余）上把 ①②③ 一次走完，
#  产出一份"已经算好"的 osm.sqlite，由 Dockerfile 烘进镜像；用户那边首次启动只剩 `cp`。
#
#  ── 判据（不只看 /api/ready）──────────────────────────────────────────────
#  `/api/ready` 的 `ready=true` **不等于**算好了：index.js 在初始化**出错**时也会调 finishInit()，
#  那一刻 ready 也是 true（实测撞上过：ready=true 时人口网格只算了 2%，库里 done 还是 0）。
#  所以本脚本还直接查库里的 `meta.population_build_state`：**done=1 且 processed>=total** 才认。
#  这个判据不是洁癖：`done=0` 意味着"还能续算"，那台用户机器下次启动就会接着算 —— 正是本脚本要
#  消灭的那件事。库不合格时本脚本**直接失败退出**（不会把半成品交给 Dockerfile），
#  并且最多重试 6 次（库里已有断点，续算不会重复计数），失败信息里会带临时实例日志的最后几行。
#
#  用法（在项目根目录）
#  ------------------
#    sh deploy/build-seed.sh --out /opt/osm-seed/osm.sqlite
#  本机验证（**绝不碰线上库**）：
#    sh deploy/build-seed.sh --out logs/seed-test/osm.sqlite --data logs/seed-test/data \
#        --source data/osm/Beijing.osm.gz --port 8799
#
#  参数
#  ----
#    --root DIR       项目根（默认：本脚本的上一级目录）
#    --out FILE       种子库输出路径（默认 /opt/osm-seed/osm.sqlite）
#    --city ID        数据集 id（tools/cities.json，默认 beijing）
#    --source FILE    来源包路径（默认取城市预设）；**已存在就复用，不再下载**
#    --url URL        覆盖下载地址（默认取城市预设）
#    --data DIR       临时实例的数据目录（users.json 等；默认 <tmp>/osm-seed-data）
#    --port N         临时实例端口（默认 8799；**绝不要用 8787**，那是线上服）
#    --report FILE    报告 JSON（默认 <out>.seed.json）
#    --prebuilt FILE  直接用别人生成好的种子库（CI 预生成）：只校验 + 拷贝，跳过 ①②③
#    --timeout S      等"就绪 + 网格算完"的最长秒数（默认 1800）
#    --rm-source      收工后删掉下载的来源包（默认保留，方便复查/复用）
#    --allow-live-db  允许把种子库写进项目的 data/ 目录（默认**拒绝**，防手滑覆盖线上库）
#    --help
#
#  退出码：0 成功；1 参数/环境问题；2 下载失败；3 导入失败；4 初始化失败/超时；5 校验失败
#
#  注意：脚本是 POSIX sh（Debian slim 的 dash 与 Windows 的 Git bash 都要能跑），
#        所以不用 bash 专有语法（不用数组、不用 ${var//}、不用 local）。
# ============================================================================
set -eu

# ---------------------------------------------------------------- 参数解析 --
ARGS_ROOT=""; ARGS_OUT=""; ARGS_CITY="beijing"; ARGS_SOURCE=""; ARGS_URL=""
ARGS_DATA=""; ARGS_PORT="8799"; ARGS_REPORT=""; ARGS_PREBUILT=""; ARGS_TIMEOUT="1800"
ARGS_RM_SOURCE=0; ARGS_ALLOW_LIVE=0

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ARGS_ROOT="$2"; shift 2 ;;
    --out) ARGS_OUT="$2"; shift 2 ;;
    --city) ARGS_CITY="$2"; shift 2 ;;
    --source) ARGS_SOURCE="$2"; shift 2 ;;
    --url) ARGS_URL="$2"; shift 2 ;;
    --data) ARGS_DATA="$2"; shift 2 ;;
    --port) ARGS_PORT="$2"; shift 2 ;;
    --report) ARGS_REPORT="$2"; shift 2 ;;
    --prebuilt) ARGS_PREBUILT="$2"; shift 2 ;;
    --timeout) ARGS_TIMEOUT="$2"; shift 2 ;;
    --rm-source) ARGS_RM_SOURCE=1; shift ;;
    --allow-live-db) ARGS_ALLOW_LIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[seed] 不认识的参数：$1（--help 看用法）" >&2; exit 1 ;;
  esac
done

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT="${ARGS_ROOT:-$(cd "$SELF_DIR/.." && pwd)}"
ROOT=$(cd "$ROOT" && pwd)
OUT="${ARGS_OUT:-/opt/osm-seed/osm.sqlite}"
CITY="$ARGS_CITY"
PORT="$ARGS_PORT"
TIMEOUT_S="$ARGS_TIMEOUT"

log() { printf '[seed] %s\n' "$*"; }
die() { printf '[seed] ❌ %s\n' "$*" >&2; exit "${SEED_EXIT:-1}"; }
secs() { date +%s; }
human() {  # 字节 → 人类可读
  node -e 'const n=Number(process.argv[1]);const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<3){n/=1024;i++}process.stdout.write(n.toFixed(i?1:0)+u[i])' "$1" 2>/dev/null || echo "${1}B"
}
size_of() { [ -f "$1" ] && (wc -c < "$1" | tr -d ' ') || echo 0; }

T0=$(secs)
log "════════════════════════════════════════════════════════════════"
log "构建期种子生成（把一次性计算烘进镜像）：$CITY → $OUT"
log "项目根 = $ROOT · Node = $(node -v) · 临时端口 = $PORT"
log "════════════════════════════════════════════════════════════════"

# 目录准备：OUT 的父目录必须是可写的；工作目录放系统临时区（不进镜像上下文）
OUT_DIR=$(dirname "$OUT")
mkdir -p "$OUT_DIR" || die "无法创建输出目录：$OUT_DIR"
OUT_ABS="$OUT_DIR/$(basename "$OUT")"

# ⚠ 防手滑：默认拒绝把种子库写进项目的 data/ （那是**线上库**所在目录）
case "$OUT_ABS" in
  "$ROOT"/data/*)
    if [ "$ARGS_ALLOW_LIVE" != "1" ]; then
      die "拒绝把种子库写到项目 data/ 里：$OUT_ABS（那是线上数据目录，可能覆盖 data/osm/osm.sqlite）。
       请换 --out（例如 /opt/osm-seed/osm.sqlite 或 logs/seed-test/osm.sqlite）；
       确实要写进 data/ 就显式加 --allow-live-db。"
    fi
    ;;
esac

WORK="${TMPDIR:-/tmp}/osm-seed-build-$$"
mkdir -p "$WORK" 2>/dev/null || { WORK="$OUT_DIR/.seed-build-$$"; mkdir -p "$WORK"; }
DATA_DIR="${ARGS_DATA:-${TMPDIR:-/tmp}/osm-seed-data}"
REPORT="${ARGS_REPORT:-${OUT_ABS}.seed.json}"
SRV_LOG="$WORK/server.log"
mkdir -p "$DATA_DIR"

cleanup() {
  if [ -n "${SRV_PID:-}" ] && kill -0 "$SRV_PID" 2>/dev/null; then
    stop_server "收尾"
  fi
  rm -rf "$WORK" 2>/dev/null || true
}
trap 'cleanup' EXIT INT TERM

stop_server() {
  [ -n "${SRV_PID:-}" ] || return 0
  if ! kill -0 "$SRV_PID" 2>/dev/null; then SRV_PID=""; return 0; fi
  log "$1：正在停掉临时实例（pid $SRV_PID，端口 $PORT）…"
  kill -TERM "$SRV_PID" 2>/dev/null || true
  i=0
  while [ $i -lt 40 ] && kill -0 "$SRV_PID" 2>/dev/null; do sleep 0.5; i=$((i+1)); done
  if kill -0 "$SRV_PID" 2>/dev/null; then
    log "$1：SIGTERM 没停掉（Windows 上没有真正的信号），改用强杀"
    kill -KILL "$SRV_PID" 2>/dev/null || true
    i=0
    while [ $i -lt 20 ] && kill -0 "$SRV_PID" 2>/dev/null; do sleep 0.5; i=$((i+1)); done
  fi
  if kill -0 "$SRV_PID" 2>/dev/null && command -v taskkill >/dev/null 2>&1; then
    taskkill //F //PID "$SRV_PID" >/dev/null 2>&1 || true
    i=0
    while [ $i -lt 20 ] && kill -0 "$SRV_PID" 2>/dev/null; do sleep 0.5; i=$((i+1)); done
  fi
  if kill -0 "$SRV_PID" 2>/dev/null; then
    log "⚠ 停不掉 pid $SRV_PID —— 请手工结束它（它占着端口 $PORT，占的是临时库，不影响线上服）"
  else
    log "$1：临时实例已停止"
  fi
  SRV_PID=""
}

# ── 0. 环境与磁盘预检 ────────────────────────────────────────────────────────
log "── [1/6] 环境预检 ─────────────────────────────────────────────"
[ -f "$ROOT/server/index.js" ] || die "找不到 $ROOT/server/index.js —— --root 是不是指错了？"
[ -f "$ROOT/tools/import-osm.js" ] || die "找不到 $ROOT/tools/import-osm.js"
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[ "$NODE_MAJOR" -ge 22 ] || log "⚠ Node 版本 $NODE_MAJOR < 22：node:sqlite 可能不可用（本脚本需要 ≥ 22.5）"

# 城市预设（tools/cities.json）→ 默认的来源包路径 / 下载地址 / 预计库大小
CITY_ENV=$(cd "$ROOT" && node tools/fetch-osm.js --city "$CITY" --print-env --env-prefix CITY_ 2>&1) || {
  log "读取城市预设失败（--city $CITY）："; printf '%s\n' "$CITY_ENV" | sed 's/^/         /'
  die "可用的城市见 tools/cities.json"
}
eval "$CITY_ENV"
SRC="${ARGS_SOURCE:-${CITY_OSM_SOURCE:-}}"
[ -n "$SRC" ] || die "城市 $CITY 在 tools/cities.json 里没有 source 路径"
case "$SRC" in /*|[A-Za-z]:*) ;; *) SRC="$ROOT/$SRC" ;; esac
URL="${ARGS_URL:-${CITY_OSM_SOURCE_URL:-}}"

FREE_BYTES=$(node -e 'try{const s=require("fs").statfsSync(process.argv[1]);process.stdout.write(String(s.bavail*s.bsize))}catch{process.stdout.write("0")}' "$OUT_DIR")
log "输出目录 $OUT_DIR 可用空间：$(human "$FREE_BYTES")"
log "来源包 = $SRC（$( [ -f "$SRC" ] && echo "已存在，复用：$(human "$(size_of "$SRC")")" || echo "不存在，需要下载" )）"
if [ -n "${CITY_OSM_EST_DB_MB:-}" ] && [ "$FREE_BYTES" -lt $(( (CITY_OSM_EST_DB_MB + 200) * 1048576 )) ]; then
  log "⚠ 空间偏紧：预计库约 ${CITY_OSM_EST_DB_MB} MB，建议留足 ${CITY_OSM_EST_DB_MB} MB + 200 MB 余量"
fi

# ── --prebuilt：直接用 CI 预生成的种子（只校验 + 拷贝）────────────────────────
if [ -n "$ARGS_PREBUILT" ]; then
  log "── [*] 使用预生成种子（CI 产物）：$ARGS_PREBUILT ───────────────"
  [ -f "$ARGS_PREBUILT" ] || die "预生成种子不存在：$ARGS_PREBUILT"
  SRC_BYTES=$(size_of "$ARGS_PREBUILT")
  [ "$SRC_BYTES" -gt 1048576 ] || die "预生成种子太小（$(human "$SRC_BYTES")），像是坏文件：$ARGS_PREBUILT"
  cp -f "$ARGS_PREBUILT" "$OUT_ABS"
  log "已拷贝到 $OUT_ABS（$(human "$(size_of "$OUT_ABS")")），下面只做校验。"
  SKIP_BUILD=1
else
  SKIP_BUILD=0
fi

if [ "$SKIP_BUILD" != "1" ]; then
  # ── 1. 来源包：有就复用，没有就下载（断点续传 + md5 + 磁盘预检都在下载器里）──
  log "── [2/6] 准备来源包 ───────────────────────────────────────────"
  if [ -f "$SRC" ]; then
    log "复用已有来源包：$SRC（$(human "$(size_of "$SRC")")）—— 不重新下载"
    SRC_MD5=$(node -e 'const c=require("crypto"),f=require("fs");const h=c.createHash("md5");const s=f.createReadStream(process.argv[1]);s.on("data",(d)=>h.update(d));s.on("end",()=>process.stdout.write(h.digest("hex")));s.on("error",(e)=>{console.error(e.message);process.exit(1)})' "$SRC")
    log "来源包 md5 = $SRC_MD5"
  else
    [ -n "$URL" ] || die "没有来源包（$SRC），而城市 $CITY 没有配 url；请用 --source 指一个本地文件"
    mkdir -p "$(dirname "$SRC")"
    log "开始下载：$URL"
    log "（下载器自带断点续传/md5/磁盘预检；预计来源约 ${CITY_OSM_EST_SOURCE_MB:-?} MB）"
    if ! (cd "$ROOT" && node tools/fetch-osm.js --url "$URL" --out "$SRC"); then
      SEED_EXIT=2; die "下载失败（网络/磁盘？）；重跑本脚本会断点续传"
    fi
    SRC_MD5=$(node -e 'const c=require("crypto"),f=require("fs");const h=c.createHash("md5");const s=f.createReadStream(process.argv[1]);s.on("data",(d)=>h.update(d));s.on("end",()=>process.stdout.write(h.digest("hex")));s.on("error",(e)=>{console.error(e.message);process.exit(1)})' "$SRC")
    log "下载完成：$SRC（$(human "$(size_of "$SRC")")，md5 = $SRC_MD5）"
  fi

  # ── 2. 导入（写元素 + 几何回填 + 空间索引）──────────────────────────────
  T_IMPORT=$(secs)
  log "── [3/6] 导入 OSM → $OUT_ABS ──────────────────────────────────"
  log "预计：约 ${CITY_OSM_EST_MINUTES:-?} 分钟、库约 ${CITY_OSM_EST_DB_MB:-?} MB（构建机上通常比 VPS 快得多）"
  if ! (cd "$ROOT" && node tools/import-osm.js --file "$SRC" --db "$OUT_ABS" --city "$CITY" --force --quiet); then
    SEED_EXIT=3; die "导入失败（上面是导入器自己的日志）"
  fi
  IMPORT_S=$(($(secs) - T_IMPORT))
  log "导入完成：$(human "$(size_of "$OUT_ABS")")，用时 ${IMPORT_S} s"

  # ── 3. 起临时服务器：迁移 + LOD 回填 + 人口网格全量推算 + 索引 ───────
  #  这一步是本脚本的**重点**：这些活正是 1 GB VPS 上干不动、会把整机卡死的那些。
  #
  #  用**仓库里的 config.json 原样**跑，不加任何变通 —— 种子库应当与你本机
  #  `docker compose up -d --build` 建出来的库是同一个口径，差别只在"在哪里跑的"。

  cat > "$WORK/wait-ready.mjs" <<'EOF'
// 轮询 /api/ready，直到"服务器就绪**而且人口网格真的算完**"。
//
// 为什么不能只看 ready=true：index.js 的 runInit() 在初始化**出错**时也会调 finishInit()，
// 那一刻 initState.done=true、/api/ready 就回 ready=true（带 error 字段）—— 实测就撞上了：
// ready=true 时人口网格只算了 2%，库里的 population_build_state.done 还是 0。
// 所以这里加一道**直接查库**的判据：meta.population_build_state 的 done=1 且 processed>=total
//（population.js 的 buildState 注释：`done === 1` 才算完，0 = 还能续算）。
//
// 退出码：0 = 就绪且网格算完 · 3 = 就绪但网格没算完（外层会再起一次续算）· 4 = 超时/连不上
//
// 参数：port timeoutMs logFile outJson dbPath
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.argv[2]);
const timeoutMs = Number(process.argv[3]);
const logFile = process.argv[4];
const outJson = process.argv[5];
const dbPath = process.argv[6];

const t0 = Date.now();
let refusedSince = 0, lastLine = '', lastPrint = 0, nextSample = 0, readyAt = 0;
const samples = [];
const tail = (n = 12) => {
  try { return readFileSync(logFile, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return '(日志读不到)'; }
};

/** 直接查库里的断点：服务器正开着（WAL 允许并发读），这是我们能拿到的**最硬**的判据 */
function readBuildState() {
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'population_build_state'").get();
    const cells = db.prepare('SELECT COUNT(*) AS c FROM population_cells').get().c;
    const sources = db.prepare('SELECT COUNT(*) AS c FROM population_sources').get().c;
    let st = null;
    try { st = row && row.value ? JSON.parse(row.value) : null; } catch { st = null; }
    return { state: st, cells, sources };
  } catch (err) {
    return { error: err.message };
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

for (;;) {
  const elapsed = Date.now() - t0;
  if (elapsed > timeoutMs) {
    console.log(`[seed] ❌ 等了 ${Math.round(timeoutMs / 1000)} s 还是没能"就绪 + 人口网格算完"，判定超时。`);
    console.log('[seed] 临时实例日志的最后几行：\n' + tail(20));
    process.exit(4);
  }
  let payload = null;
  try {
    // 5 s 超时：人口网格那一段虽然切片跑，但机器慢时单次响应也可能很慢；
    // 给个上限，保证下面的"总超时"判断永远能走到（不会卡在一次 fetch 上）。
    const res = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(5000) });
    payload = await res.json();
    refusedSince = 0;
  } catch {
    if (!refusedSince) refusedSince = Date.now();
    // 连续 40 s 连不上：多半是临时实例已经挂了（端口没开/崩了），早点失败并给出日志
    if (Date.now() - refusedSince > 40000) {
      console.log('[seed] ❌ 连续 40 s 连不上临时实例的端口 ' + port + '（它可能已经退出了）。');
      console.log('[seed] 临时实例日志的最后几行：\n' + tail(20));
      process.exit(4);
    }
  }

  if (payload && payload.ready === true) {
    if (!readyAt) readyAt = Date.now();
    const got = readBuildState();
    const s = got.state || {};
    const complete = Number(s.done) === 1
      && Number(s.processed) > 0
      && Number(s.total) > 0
      && Number(s.processed) >= Number(s.total);
    console.log(`[seed] /api/ready ready=true（等 ${((Date.now() - t0) / 1000).toFixed(1)} s；`
      + `服务器自报：端口 ${payload.listenMs ?? '?'} ms 就开 · 初始化 ${payload.readyMs ?? '?'} ms）`
      + ` · 库里断点 done=${s.done ?? '?'} processed=${s.processed ?? '?'}/${s.total ?? '?'}`
      + ` · population_cells ${got.cells ?? got.error ?? '?'} 行 · population_sources ${got.sources ?? '?'} 行`);
    if (payload.error) console.log('[seed] ⚠ 服务器自报的初始化错误：' + payload.error);
    if (complete) {
      writeFileSync(outJson, JSON.stringify({
        elapsedMs: Date.now() - t0,
        listenMs: payload.listenMs ?? null,
        readyMs: payload.readyMs ?? null,
        initError: payload.error ?? null,
        stages: payload.stages ?? null,
        populationBuildState: got.state ?? null,
        populationCells: got.cells ?? null,
        populationSources: got.sources ?? null,
        samples,
      }, null, 2));
      console.log('[seed] ✅ 就绪，而且人口网格**确实算完了**（done=1，processed=total）');
      process.exit(0);
    }
    // ready 了但网格没算完：正常情况下 done=1 会在 ready 之前写进库，所以再给 20 s 观察期
    if (Date.now() - readyAt > 20000) {
      console.log('[seed] ❌ 服务器已经 ready 20 s，但人口网格还是没算完（done != 1）：这一轮不算成功，交给外层再起一次。');
      process.exit(3);
    }
  }

  if (payload) {
    const p = payload.progress || {};
    const line = `${p.stage ?? payload.phase ?? '?'} ${p.percent ?? 0}%`;
    if (line !== lastLine || Date.now() - lastPrint > 20000) {
      console.log(`[seed] 初始化进度：${p.label ?? ''} ${line}${p.stageMessage ? ' · ' + p.stageMessage : ''}`
        + `（已等 ${(elapsed / 1000).toFixed(0)} s）`);
      lastLine = line; lastPrint = Date.now();
    }
    if (Date.now() >= nextSample) { samples.push({ at: elapsed, stage: p.stage, percent: p.percent }); nextSample = Date.now() + 30000; }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
EOF

  MAX_ATTEMPTS=6
  ATTEMPT=1
  INIT_RC=1
  LOG_USED=""
  while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
    log "── [4/6] 第 $ATTEMPT/$MAX_ATTEMPTS 次：起临时服务器跑一次性初始化 ──"
    log "会依次做：数据库迁移 → LOD 物化列回填（ways.road_class/lod_zoom）+部分索引 →"
    log "         铁路网/道路网（内存，不落库）→ **人口网格全量推算** → 线路路径"
    log "就绪判据不只是 /api/ready 的 ready=true（初始化出错时它也是 true）："
    log "还要直接查库里的 meta.population_build_state（done=1 且 processed=total 才算真算完）。"
    log "端口 $PORT · 数据目录 $DATA_DIR · 最长等 ${TIMEOUT_S} s；期间**不要**关掉这个脚本。"
    ATTEMPT_LOG="$WORK/server-$ATTEMPT.log"
    : > "$ATTEMPT_LOG"
    ( cd "$ROOT" && exec node server/index.js --osm "$OUT_ABS" --port "$PORT" --data "$DATA_DIR" ) >>"$ATTEMPT_LOG" 2>&1 &
    SRV_PID=$!
    log "临时实例 pid = $SRV_PID（日志：$ATTEMPT_LOG）"
    if node "$WORK/wait-ready.mjs" "$PORT" "$((TIMEOUT_S * 1000))" "$ATTEMPT_LOG" "$WORK/ready.json" "$OUT_ABS"; then
      INIT_RC=0
    else
      INIT_RC=$?
    fi
    stop_server "第 $ATTEMPT 次"
    LOG_USED="$ATTEMPT_LOG"
    if [ "$INIT_RC" = "0" ]; then break; fi
    if [ "$INIT_RC" = "4" ]; then
      log "临时实例日志（最后 40 行）："
      tail -40 "$ATTEMPT_LOG" 2>/dev/null | sed 's/^/         /' || true
      SEED_EXIT=4; die "一次性初始化没能在 ${TIMEOUT_S} s 内跑完"
    fi
    log "第 $ATTEMPT 次没能把人口网格算完（exit=$INIT_RC）。日志最后 8 行："
    tail -8 "$ATTEMPT_LOG" 2>/dev/null | sed 's/^/         /' || true
    log "再起一次：库里已有断点（population_sources），续算不会重复计数。"
    ATTEMPT=$((ATTEMPT + 1))
  done
  [ "$INIT_RC" = "0" ] || { SEED_EXIT=4; die "试了 $MAX_ATTEMPTS 次，人口网格仍然是 done=0（见 $LOG_USED）"; }
  READY_JSON=$(cat "$WORK/ready.json" 2>/dev/null || echo '{}')
  SRV_LOG="$LOG_USED"

  # 服务器自己打的"[init] 就绪"那行（拿来做证据）
  if grep -q '\[init\] 就绪' "$SRV_LOG" 2>/dev/null; then
    log "服务器日志里的就绪行："
    grep '\[init\] 就绪' "$SRV_LOG" | tail -1 | sed 's/^/         /'
  fi
  log "── [5/6] 临时实例已停掉（端口 $PORT 已让出）────────────────────"
  log "初始化阶段日志（人口网格那几行）："
  grep -E '\[pop\]|\[bus\] 道路网构建完成|\[rail\] 铁路网构建完成' "$SRV_LOG" 2>/dev/null | tail -4 | sed 's/^/         /' || true
  if grep -q '初始化失败' "$SRV_LOG" 2>/dev/null; then
    log "⚠ 服务器日志里有「初始化失败」字样（先看清是哪一步；人口网格已经 done=1 才走到这里）："
    grep '初始化失败' "$SRV_LOG" | tail -3 | sed 's/^/         /'
  fi


fi

# ── 5. WAL 检查点 + 校验（拷贝之前必须做：库是 WAL 模式，新数据可能还在 -wal 里）──
#  注意时序：**先停实例再检查点**。Node 在 Windows 上没有真正的 SIGTERM，
#  强杀可能留下非空的 -wal；检查点会把 -wal 全部折回主库文件，之后拷 .sqlite 就是完整的。
log "── [6/6] WAL 检查点 + 校验 + 写报告 ───────────────────────────"
cat > "$WORK/inspect-seed.mjs" <<'EOF'
// 种子库体检：WAL 检查点（把 -wal 折回主库）+ 关键行数统计。只用 node:sqlite（零依赖）。
import { DatabaseSync } from 'node:sqlite';
import { statSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
const [dbPath, reportPath] = process.argv.slice(2);
if (!existsSync(dbPath)) { console.error('❌ 库不存在：' + dbPath); process.exit(5); }
const bytes = (p) => { try { return statSync(p).size; } catch { return 0; } };
const before = { db: bytes(dbPath), wal: bytes(dbPath + '-wal'), shm: bytes(dbPath + '-shm') };
const db = new DatabaseSync(dbPath);
let ckpt = null;
try { ckpt = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); } catch (err) { ckpt = { error: err.message }; }
const one = (sql) => { try { return db.prepare(sql).get(); } catch (err) { return { error: err.message }; } };
const num = (sql) => { const r = one(sql); return r && typeof r.c === 'number' ? r.c : null; };
const meta = {};
try { for (const r of db.prepare('SELECT key, value FROM meta').all()) meta[r.key] = r.value; } catch { /* 老库没有 meta */ }
const pop = one('SELECT COUNT(*) AS rows, SUM(CASE WHEN pop>0 OR jobs>0 THEN 1 ELSE 0 END) AS used, SUM(pop) AS pop, SUM(jobs) AS jobs FROM population_cells');
/**
 * 人口网格的"算完没有"**唯一判据**（population.js buildState 的说明）：meta.population_build_state
 * 里 done === 1。done=0 表示还能续算 —— 那就等于把"首次推算"留给了用户的机器，正是本脚本要消灭的东西。
 * processed / total 也要对得上（total = 这一轮要扫的"带标签 way"条数，processed = 已扫过）。
 */
let popStateRaw = null, popState = null;
try {
  const r = one("SELECT value FROM meta WHERE key = 'population_build_state'");
  popStateRaw = r && r.value ? r.value : null;
  popState = popStateRaw ? JSON.parse(popStateRaw) : null;
} catch (err) { popState = { parseError: err.message }; }
const popDone = !!popState && Number(popState.done) === 1;
const popProgress = popState ? Number(popState.processed) || 0 : 0;
const popTotal = popState ? Number(popState.total) || 0 : 0;
const indexes = [];
try { for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) indexes.push(r.name); } catch { /* ignore */ }
const out = {
  db: dbPath,
  bytes: { before, afterDb: bytes(dbPath), afterWal: bytes(dbPath + '-wal') },
  checkpoint: ckpt,
  counts: {
    nodes: num('SELECT COUNT(*) AS c FROM nodes'),
    ways: num('SELECT COUNT(*) AS c FROM ways'),
    waysLiving: num('SELECT COUNT(*) AS c FROM ways WHERE deleted = 0'),
    waysWithLodZoom: num('SELECT COUNT(*) AS c FROM ways WHERE lod_zoom IS NOT NULL'),
    waysWithRoadClass: num('SELECT COUNT(*) AS c FROM ways WHERE road_class IS NOT NULL'),
    relations: num('SELECT COUNT(*) AS c FROM relations'),
    wayNodes: num('SELECT COUNT(*) AS c FROM way_nodes'),
    populationCells: pop.rows ?? null,
    populationCellsUsed: pop.used ?? null,
    populationSources: num('SELECT COUNT(*) AS c FROM population_sources'),
  },
  population: { pop: pop.pop ?? null, jobs: pop.jobs ?? null },
  populationBuild: {
    done: popState ? popState.done ?? null : null,
    complete: popDone,
    processed: popProgress,
    total: popTotal,
    ways: popState ? popState.ways ?? null : null,
    cells: popState ? popState.cells ?? null : null,
    modelVersion: popState ? popState.v ?? null : null,
    jobsMode: popState ? popState.mode ?? null : null,
    resumed: popState ? popState.resumed ?? null : null,
    ms: popState ? popState.ms ?? null : null,
    startedAt: popState ? popState.startedAt ?? null : null,
    doneAt: popState ? popState.doneAt ?? null : null,
    raw: popStateRaw,
  },
  meta,
  indexes,
  at: new Date().toISOString(),
};
try { db.close(); } catch { /* ignore */ }
if (reportPath) {
  let prev = {};
  if (existsSync(reportPath)) { try { prev = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { prev = {}; } }
  writeFileSync(reportPath, JSON.stringify({ ...prev, verify: out }, null, 2));
}
console.log(JSON.stringify(out, null, 2));
EOF

if ! node "$WORK/inspect-seed.mjs" "$OUT_ABS" "$REPORT" > "$WORK/inspect.json"; then
  log "体检输出："; tail -20 "$WORK/inspect.json" 2>/dev/null | sed 's/^/         /' || true
  SEED_EXIT=5; die "种子库校验失败（检查点/查询出错）"
fi
node -e '
const j = require(process.argv[1]);
const c = j.counts;
console.log("[seed] 库文件：" + j.db);
console.log("[seed] 大小：" + (j.bytes.afterDb/1048576).toFixed(1) + " MB"
  + "（检查点前主库 " + (j.bytes.before.db/1048576).toFixed(1) + " MB / -wal " + (j.bytes.before.wal/1048576).toFixed(2) + " MB"
  + " → 之后 -wal " + (j.bytes.afterWal/1048576).toFixed(2) + " MB）");
console.log("[seed] WAL 检查点：" + JSON.stringify(j.checkpoint));
console.log("[seed] 元素：nodes=" + c.nodes + " ways=" + c.ways + "（未删除 " + c.waysLiving + "） relations=" + c.relations + " way_nodes=" + c.wayNodes);
console.log("[seed] LOD 回填：ways.lod_zoom 非空 " + c.waysWithLodZoom + " 行 · ways.road_class 非空 " + c.waysWithRoadClass + " 行");
console.log("[seed] 人口网格：population_cells " + c.populationCells + " 行（非空 " + c.populationCellsUsed + "）"
  + " · 合计 " + Math.round(j.population.pop||0) + " 人 / " + Math.round(j.population.jobs||0) + " 个岗位"
  + " · population_sources " + c.populationSources + " 行");
console.log("[seed] meta.population_model = " + (j.meta.population_model ?? "(未设置)") + " · 索引 " + j.indexes.length + " 个（含 idx_ways_lod_zoom: " + j.indexes.includes("idx_ways_lod_zoom") + "）");
const pb = j.populationBuild;
console.log("[seed] 人口网格断点：done=" + pb.done + "（complete=" + pb.complete + "）· processed=" + pb.processed + "/" + pb.total
  + " 条带标签 way · 有贡献 " + pb.ways + " 条 · 网格条目 " + pb.cells
  + " · 本轮耗时 " + (pb.ms == null ? "?" : (pb.ms / 1000).toFixed(1) + " s") + (pb.resumed ? "（续算）" : ""));
' "$WORK/inspect.json"

# 关键判据：不许把"没算好"的库交出去
node -e '
const j = require(process.argv[1]);
const c = j.counts;
const pb = j.populationBuild;
const bad = [];
if (!c.nodes || c.nodes < 1000) bad.push("nodes=" + c.nodes);
if (!c.ways || c.ways < 100) bad.push("ways=" + c.ways);
if (!c.waysWithLodZoom) bad.push("ways.lod_zoom 一行都没回填");
if (!c.populationCells) bad.push("population_cells 是空的（人口网格没算）");
if (!c.populationSources) bad.push("population_sources 是空的（way→格子 的贡献没记）");
if (j.meta.population_model === undefined) bad.push("meta.population_model 没写（网格口径版本缺失）");
if (!pb.complete) bad.push("人口网格没算完：population_build_state.done=" + pb.done + "（必须 =1，否则用户机器上还会再算一遍）");
if (!(pb.processed >= pb.total)) bad.push("人口网格的进度对不上：processed=" + pb.processed + " < total=" + pb.total);
if (pb.ways === 0) bad.push("一条有贡献的地块都没有（population_build_state.ways=0）");
if (!j.indexes.includes("idx_ways_lod_zoom")) bad.push("缺部分索引 idx_ways_lod_zoom");
if (bad.length) { console.error("[seed] ❌ 种子库不合格：" + bad.join("；")); process.exit(5); }
console.log("[seed] ✅ 种子库合格：迁移/LOD 回填/人口网格（done=1）/索引都在里面了");
' "$WORK/inspect.json" || { SEED_EXIT=5; die "种子库没通过合格判据（见上）"; }

# ── 报告 JSON（含生成参数，便于追溯"这份快照是哪天、哪个数据集做的"）──────
node -e '
const fs = require("fs");
const [reportPath, out, city, src, srcMd5, importS, readyJson, dataDir, port] = process.argv.slice(1);
let rep = {};
try { rep = JSON.parse(fs.readFileSync(reportPath, "utf8")); } catch { rep = {}; }
let ready = {};
try { ready = JSON.parse(fs.readFileSync(readyJson, "utf8")); } catch { ready = {}; }
rep.tool = "deploy/build-seed.sh";
rep.at = new Date().toISOString();
rep.city = city;
rep.node = process.version;
rep.seed = { path: out, bytes: fs.statSync(out).size };
rep.source = { file: src, md5: srcMd5 || null };
rep.build = { importSeconds: Number(importS) || null, readyWaitMs: ready.elapsedMs ?? null, serverListenMs: ready.listenMs ?? null, serverInitMs: ready.readyMs ?? null, initError: ready.initError ?? null, dataDir, port };
rep.populationBuild = ready.populationBuildState
  ? { done: ready.populationBuildState.done ?? null, processed: ready.populationBuildState.processed ?? null, total: ready.populationBuildState.total ?? null, ways: ready.populationBuildState.ways ?? null, cells: ready.populationBuildState.cells ?? null, ms: ready.populationBuildState.ms ?? null, mode: ready.populationBuildState.mode ?? null, v: ready.populationBuildState.v ?? null }
  : null;
rep.note = "这份库是**快照**：已含数据库迁移、ways.road_class/lod_zoom 回填与部分索引、population_cells / population_sources 的全量推算结果（population_build_state.done=1）。铁路网/道路网/线路路径是内存结构，不在库里，每次启动仍会重建。";
fs.writeFileSync(reportPath, JSON.stringify(rep, null, 2));
console.log("[seed] 报告：" + reportPath);
' "$REPORT" "$OUT_ABS" "$CITY" "$SRC" "${SRC_MD5:-}" "${IMPORT_S:-}" "$WORK/ready.json" "$DATA_DIR" "$PORT"

if [ "$ARGS_RM_SOURCE" = "1" ] && [ -f "$SRC" ]; then
  rm -f "$SRC" "$SRC.part" 2>/dev/null || true
  log "已删除来源包（--rm-source）"
fi

log "════════════════════════════════════════════════════════════════"
log "✅ 种子库就绪：$OUT_ABS（$(human "$(size_of "$OUT_ABS")")），总用时 $(($(secs) - T0)) s"
log "   用户那边首次启动只需要把这个文件拷进数据卷（几秒），不用下载、不用导入、不用推算人口。"
log "════════════════════════════════════════════════════════════════"
