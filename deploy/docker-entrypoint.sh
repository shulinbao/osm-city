#!/bin/sh
# ============================================================================
#  容器入口：保证"数据卷里有一份可用的数据集"，然后把命令交给 CMD。
#
#  ── 两种来源，默认用第一种（镜像里预建好的"种子库"）─────────────────────────
#  ① **用镜像内预建库**（默认）：镜像里带着 /opt/osm-seed/osm.sqlite —— 这是**构建期**
#     在构建机上跑完"导入 + 数据库迁移 + LOD 回填 + 首次人口网格全量推算 + 索引"之后的
#     成品库（见 deploy/build-seed.sh）。卷里没有库时只需要 cp 一下，**几秒~1 分钟**
#     （取决于磁盘），不再下载 47 MB、不再导入、不再做那段会把 1 GB 小机器卡死的人口推算。
#  ② 下载 + 导入（旧行为，也是 OSM_SEED=0 时的行为）：卷里没有库时联网下载来源包，
#     再用 tools/import-osm.js 导入成库。1 GB 内存的 VPS 上这一步实测导入 ~500 s，
#     后面服务器还要在启动时补做人口网格推算（可能把整机卡到无法登录）。
#
#  ── 卷优先：更新镜像不会动你的数据 ─────────────────────────────────────────
#  卷里**已经有**库（osm.sqlite）时，两种来源都不碰它：玩家的账号、编辑、存档都在卷里，
#  `docker compose pull && docker compose up -d` 之后照旧。想换成新镜像里的快照：
#  删掉卷里的库（或设 OSM_FORCE_REIMPORT=1 走重新导入 / OSM_SEED=1 用快照）。
#
#  ── 开关（都有中文日志说明这次走了哪条路）──────────────────────────────────
#    OSM_SEED=auto  默认：卷里没有库时用镜像内预建库（除下面几种例外）
#    OSM_SEED=1     只要城市匹配就用镜像内预建库（**连"卷里已有来源包"也让位**）
#    OSM_SEED=0     完全不用镜像里的种子，走原来的下载 + 导入
#    OSM_SEED_DB    预建库的路径（默认 /opt/osm-seed/osm.sqlite）
#    OSM_CITY       数据集 id（默认 beijing）；与镜像内快照的城市不一致时**不会**用快照
#    OSM_AUTO_DOWNLOAD=0  缺数据时绝不联网，直接报错退出（只影响②）
#    OSM_FORCE_REIMPORT=1 卷里已有库也强制重新导入（换城市/换数据集时用它；它**等于**不用快照）
#    OSM_DB / OSM_SOURCE / OSM_SOURCE_URL  显式覆盖路径与地址（留空则用城市预设）
#
#  数据集可以是**任何城市/省份/全国**（见 tools/cities.json 与 deploy/CITIES.md）：
#    OSM_CITY=beijing      BBBike 北京包，47 MB，导入约 1~2 分钟（默认，与旧版行为一致）
#    OSM_CITY=beijing-pbf  Geofabrik 北京分省包，36 MB，约 2 分钟（含铁路/边界，更全）
#    OSM_CITY=hebei        Geofabrik 河北分省包，约 190 MB，磁盘要 ≥ 6 GB
#    OSM_CITY=china        Geofabrik 全国，1.5 GB，**库约 25~40 GB、导入 1~2 小时**，磁盘要 ≥ 45 GB
#    OSM_CITY=monaco       676 KB 的小样本，用来验证整条链路（几秒钟）
#  ⚠ 镜像里的种子库只对应构建时选定的城市（默认 beijing）。换城市请配 OSM_FORCE_REIMPORT=1，
#    否则会退到"下载 + 导入"（日志里会说清楚），或者用 OSM_CITY=<种子城市> 复用快照。
#
#  想自己控制这份数据（本地已经有数据文件就传上去，省一次下载）：
#    ① 只放来源包：把 <城市>.osm.pbf / Beijing.osm.gz 放进卷的 /app/data/osm/，启动时会自动导入它
#       （**只要卷里有来源包，默认就让位给你的文件，不用镜像快照** —— 那是你显式放进去的）
#    ② 连库一起放：把 <城市>.sqlite 放进卷的 /app/data/osm/，启动时直接用，不再导入
#
#  关于磁盘：拷贝前会先算空间够不够（种子库大小已知），不够就用中文说清楚差多少，不会拷到一半 ENOSPC。
#  关于端口：拷贝/导入期间这个容器**不会监听 8787**（ENTRYPOINT 跑完才交给 CMD 里的服务器），
#  日志里也会明说，别把"连不上"当成启动失败。
# ============================================================================
set -eu

# ---- 1. 城市预设（tools/cities.json）→ 默认的 URL / 来源包 / 库路径 ------------------
# 显式给了环境变量就以环境变量为准（下面前缀 CITY_ 的变量只是"默认值"）。
OSM_CITY="${OSM_CITY-beijing}"

CITY_ENV="$(node tools/fetch-osm.js --city "$OSM_CITY" --print-env --env-prefix CITY_ 2>&1)" || {
  echo "[deploy] 读取城市预设失败（OSM_CITY=$OSM_CITY）："
  echo "$CITY_ENV" | sed 's/^/         /'
  echo "[deploy] 可用的城市：$(node -e "console.log(Object.keys(require('./tools/cities.json').cities).join(', '))" 2>/dev/null || echo '(读不到 tools/cities.json)')"
  exit 1
}
eval "$CITY_ENV"

OSM_DB="${OSM_DB:-${CITY_OSM_DB:-}}"
OSM_SOURCE="${OSM_SOURCE:-${CITY_OSM_SOURCE:-}}"
# OSM_SOURCE_URL 用 `${VAR-def}`（只在该变量"未设置"时取默认值）：保留旧版"显式给空串 = 不下载"
# 的语义（虽然现在更推荐用 OSM_AUTO_DOWNLOAD=0）。
OSM_SOURCE_URL="${OSM_SOURCE_URL-${CITY_OSM_SOURCE_URL:-}}"
OSM_EST_MINUTES="${CITY_OSM_EST_MINUTES:-0}"
OSM_FORCE_REIMPORT="${OSM_FORCE_REIMPORT-0}"

# 镜像内预建库（种子）相关：路径与城市由 Dockerfile 烘进去，可用环境变量覆盖。
OSM_SEED="${OSM_SEED-auto}"
OSM_SEED_DB="${OSM_SEED_DB-/opt/osm-seed/osm.sqlite}"
OSM_SEED_CITY="${OSM_SEED_CITY-beijing}"

if [ -z "$OSM_DB" ] || [ -z "$OSM_SOURCE" ]; then
  echo "[deploy] 城市 $OSM_CITY 没有解析出数据集路径，请检查 tools/cities.json。"
  exit 1
fi

# 1 = 缺数据时允许自动下载；0 = 绝不联网，缺数据直接报错退出。
# 为什么不用"把 URL 设成空字符串"来关：`${VAR-default}` 只在变量**未设置**时才用默认值，
# 而"未设置"和"设成空"在不同环境里行为不一样（PowerShell 里赋空值往往等于删掉变量、
# docker-compose 里则是真的空串），很容易出现"我明明关了它却还在下载"。所以用显式开关。
OSM_AUTO_DOWNLOAD="${OSM_AUTO_DOWNLOAD-1}"

echo "[deploy] 数据集：城市=$OSM_CITY（${CITY_OSM_CITY_NAME:-未知}）"
echo "[deploy]   数据库   = $OSM_DB"
echo "[deploy]   来源文件 = $OSM_SOURCE"
echo "[deploy]   数据源   = ${OSM_SOURCE_URL:-（未设置）}"
echo "[deploy]   自动下载 = $OSM_AUTO_DOWNLOAD（0 = 绝不联网）"
echo "[deploy]   预建库   = $OSM_SEED_DB（城市 $OSM_SEED_CITY · OSM_SEED=$OSM_SEED）"

# ---- 2. 卷里已经有库 → 直接用（除非 OSM_FORCE_REIMPORT=1） --------------------------
if [ -f "$OSM_DB" ] && [ "$OSM_FORCE_REIMPORT" != "1" ]; then
  echo "[deploy] 已有数据集，跳过下载与导入：$OSM_DB（$(du -h "$OSM_DB" 2>/dev/null | cut -f1 || echo '?')）"
  echo "[deploy] 卷优先：更新镜像不会覆盖它（账号/编辑/存档都在这个库里）。"
  echo "[deploy] 想换成镜像里的快照：删掉这个库（或设 OSM_FORCE_REIMPORT=1 / OSM_CITY=<其它城市>）再启动"
  echo "[deploy] 服务器启动日志里会打印数据集路径与节点/道路/关系数量，接口 /api/health 的 data 字段也一样汇报"
else
  # ---- 3. 决定这次走哪条路：镜像内预建库（快）vs 下载 + 导入（慢） ----------------
  SEED_OK=1
  SEED_WHY=""
  if [ "$OSM_SEED" = "0" ]; then
    SEED_OK=0; SEED_WHY="OSM_SEED=0（你显式要求不用镜像里的预建库）"
  elif [ ! -f "$OSM_SEED_DB" ]; then
    SEED_OK=0; SEED_WHY="这个镜像里没有预建库（$OSM_SEED_DB 不存在）"
  elif [ "$OSM_CITY" != "$OSM_SEED_CITY" ]; then
    SEED_OK=0; SEED_WHY="城市不匹配：你要的是 $OSM_CITY，镜像里的预建库是 $OSM_SEED_CITY"
  elif [ "$OSM_FORCE_REIMPORT" = "1" ]; then
    SEED_OK=0; SEED_WHY="OSM_FORCE_REIMPORT=1（强制重新导入 = 不用快照）"
  elif [ -f "$OSM_SOURCE" ] && [ "$OSM_SEED" != "1" ]; then
    SEED_OK=0; SEED_WHY="卷里已经有来源包 $(basename "$OSM_SOURCE")（那是你显式放进去的，优先导入它；想改用快照就设 OSM_SEED=1）"
  fi

  if [ "$SEED_OK" = "1" ]; then
    echo "[deploy] ✅ 用镜像内预建库（已含人口网格与索引）：$OSM_SEED_DB"
    echo "[deploy]    这份库是**构建期**在构建机上算好的：导入 + 数据库迁移 + LOD 物化列回填"
    echo "[deploy]    + 首次人口/岗位网格全量推算 + 索引，全部已经完成并落库。"
    echo "[deploy]    所以现在**不下载、不导入、不推算**，只做一次文件拷贝 —— 预计几秒~1 分钟（看磁盘）。"
    echo "[deploy]    对比：走「下载 + 导入」的旧路径要下 47 MB、导入约 ${OSM_EST_MINUTES:-1~2} 分钟，"
    echo "[deploy]    之后服务器启动还要补做人口网格推算（1 GB 内存的小机器上这一段最吃力）。"
    mkdir -p "$(dirname "$OSM_DB")"

    # 空间预检：种子库大小是已知的，不够就直接说清楚，别拷到一半 ENOSPC
    SEED_BYTES=$(wc -c < "$OSM_SEED_DB" | tr -d ' ')
    FREE_BYTES=$(node -e 'try{const s=require("fs").statfsSync(process.argv[1]);process.stdout.write(String(s.bavail*s.bsize))}catch{process.stdout.write("0")}' "$(dirname "$OSM_DB")")
    NEED_BYTES=$((SEED_BYTES + 67108864))
    if [ "$FREE_BYTES" != "0" ] && [ "$FREE_BYTES" -lt "$NEED_BYTES" ]; then
      echo "[deploy] ❌ 磁盘空间不够：预建库 $((SEED_BYTES / 1048576)) MB，"
      echo "[deploy]    需要约 $((NEED_BYTES / 1048576)) MB（含 64 MB 余量），可是 $(dirname "$OSM_DB") 只剩 $((FREE_BYTES / 1048576)) MB。"
      echo "[deploy]    办法：给数据卷扩空间，或者用 OSM_SEED=0 换成更小的数据集（OSM_CITY=monaco 只有几 MB）。"
      exit 1
    fi

    T_COPY=$(date +%s)
    if ! cp -f "$OSM_SEED_DB" "$OSM_DB"; then
      rm -f "$OSM_DB" 2>/dev/null || true
      echo "[deploy] ❌ 拷贝预建库失败（磁盘满/权限？）。已清掉半个文件，重启前请先腾出空间。"
      echo "[deploy]    需要约 $((SEED_BYTES / 1048576)) MB 空闲，目标目录 $(dirname "$OSM_DB")。"
      exit 1
    fi
    COPY_S=$(($(date +%s) - T_COPY))

    # 拷贝后校验：大小必须一致，而且库必须真的能查询（免得把一个坏文件当"已有数据集"用下去）
    GOT_BYTES=$(wc -c < "$OSM_DB" | tr -d ' ')
    if [ "$GOT_BYTES" != "$SEED_BYTES" ]; then
      rm -f "$OSM_DB" 2>/dev/null || true
      echo "[deploy] ❌ 拷贝出来的库大小不对（期望 $SEED_BYTES 字节，实际 $GOT_BYTES 字节），已删掉它，请重试。"
      exit 1
    fi
    if ! node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      const cells = db.prepare("SELECT COUNT(*) AS c FROM population_cells").get().c;
      const lod = db.prepare("SELECT COUNT(*) AS c FROM ways WHERE lod_zoom IS NOT NULL").get().c;
      db.close();
      if (!cells || !lod) { console.error("[deploy] 预建库内容不完整：population_cells=" + cells + " · lod_zoom 回填=" + lod); process.exit(3); }
      console.log("[deploy] 校验通过：population_cells " + cells + " 行 · ways.lod_zoom 已回填 " + lod + " 行");
    ' "$OSM_DB"; then
      rm -f "$OSM_DB" 2>/dev/null || true
      echo "[deploy] ❌ 预建库校验失败（文件坏了或没算完），已删掉它。"
      echo "[deploy]    可以重试一次；仍不行就用 OSM_SEED=0 走「下载 + 导入」。"
      exit 1
    fi
    echo "[deploy] 拷贝完成：$OSM_DB（$(du -h "$OSM_DB" 2>/dev/null | cut -f1 || echo '?')，用时 ${COPY_S} s）"
    echo "[deploy] 接下来交给服务器：它仍会建铁路网/道路网/线路路径（这些是内存结构，不落库），"
    echo "[deploy] 但**不会再推算人口网格**（库里已经有了）—— 端口开出来之后就能连。"
  else
    echo "[deploy] 这次不用镜像内预建库，走「下载 + 导入」：$SEED_WHY"
    mkdir -p "$(dirname "$OSM_DB")"
    mkdir -p "$(dirname "$OSM_SOURCE")"

    # ---- 4. 没有来源包 → 下载（或按开关拒绝） ------------------------------------
    if [ ! -f "$OSM_SOURCE" ]; then
      if [ "$OSM_AUTO_DOWNLOAD" = "0" ]; then
        echo "[deploy] 自动下载已关闭（OSM_AUTO_DOWNLOAD=0），而卷里没有来源包：$OSM_SOURCE"
        echo "[deploy] 请把 ${OSM_CITY} 的数据文件放进 $(dirname "$OSM_SOURCE") 后重启容器："
        echo "[deploy]   ${OSM_SOURCE_URL:-（该城市没配 URL，请自己准备文件）}"
        echo "[deploy] （提示：镜像里其实带着预建库 $OSM_SEED_DB，用 OSM_SEED=1 就能直接拷它，连下载都不用）"
        exit 1
      fi
      if [ -z "$OSM_SOURCE_URL" ]; then
        echo "[deploy] 没有来源包，而且下载地址是空的（OSM_SOURCE_URL 为空）。"
        echo "[deploy] 请把数据文件放进 $(dirname "$OSM_SOURCE") 后重启容器。"
        exit 1
      fi
      echo "[deploy] 正在下载（$( [ "$OSM_EST_MINUTES" != "0" ] && echo "预计来源约 ${CITY_OSM_EST_SOURCE_MB:-?} MB、导入约 ${OSM_EST_MINUTES} 分钟" || echo "进度见下面每 3 秒一行" )）…"
      echo "[deploy] 磁盘预检（源文件 + 入库后的库 + 余量）不合格时会直接停下并说明原因。"
      # 下载器是纯 Node 的（tools/fetch-osm.js）：断点续传 + 重试 + 进度 + 可选 md5 校验，
      # 不依赖镜像里有没有 curl/wget。
      node tools/fetch-osm.js --url "$OSM_SOURCE_URL" --out "$OSM_SOURCE"
      echo "[deploy] 下载完成：$OSM_SOURCE"
    else
      echo "[deploy] 卷里已有来源包，跳过下载：$OSM_SOURCE（$(du -h "$OSM_SOURCE" 2>/dev/null | cut -f1 || echo '?')）"
      # 已经有来源包时也要做空间预检 —— 而且是**离线**的（OSM_AUTO_DOWNLOAD=0 的机器可能根本没网）
      node tools/fetch-osm.js --check-space-for "$OSM_SOURCE" --out "$OSM_DB"
    fi

    # ---- 5. 导入（复用与 XML 完全相同的写库/回填路径） ----------------------------
    echo "[deploy] 开始导入（预计约 ${OSM_EST_MINUTES:-?} 分钟，库约 ${CITY_OSM_EST_DB_MB:-?} MB）…"
    echo "[deploy] ⚠ 导入期间这个容器**不会监听 8787 端口**（ENTRYPOINT 跑完才交给服务器），"
    echo "[deploy]   浏览器连不上是正常的；docker compose logs -f 能看到进度（每 3 秒一行）。"
    echo "[deploy] ⚠ 导入之后服务器启动时还要**首次推算人口网格**（一整段同步循环）："
    echo "[deploy]   1 GB 内存的小机器上这一段可能把整机压到无法登录 —— 想避开它就用镜像里的预建库（OSM_SEED=auto）。"
    # --force：确保是一份干净的库（卷里若残留半个库也一并清掉重来）
    node tools/import-osm.js --file "$OSM_SOURCE" --db "$OSM_DB" --city "$OSM_CITY" --force --quiet
    echo "[deploy] 导入完成：$OSM_DB（$(du -h "$OSM_DB" 2>/dev/null | cut -f1 || echo '?')）"
    echo "[deploy] 提示：来源包 $(basename "$OSM_SOURCE") 已经用不到了，可以删掉以省空间。"
  fi
fi

exec "$@"
