#!/bin/sh
# ============================================================================
#  容器入口：保证"数据卷里有一份可用的数据集"，然后把命令交给 CMD。
#
#  为什么要有这一步：数据集不在镜像里，它在数据卷 /app/data 里。第一次启动时卷是空的，
#  这里负责 ① 下载数据源 ② 用 tools/import-osm.js 导入成 <城市>.sqlite。之后再启动就跳过。
#
#  数据集可以是**任何城市/省份/全国**（见 tools/cities.json 与 deploy/CITIES.md）：
#    OSM_CITY=beijing      BBBike 北京包，47 MB，导入约 1~2 分钟（默认，与旧版行为一致）
#    OSM_CITY=beijing-pbf  Geofabrik 北京分省包，36 MB，约 2 分钟（含铁路/边界，更全）
#    OSM_CITY=hebei        Geofabrik 河北分省包，约 190 MB，磁盘要 ≥ 6 GB
#    OSM_CITY=china        Geofabrik 全国，1.5 GB，**库约 25~40 GB、导入 1~2 小时**，磁盘要 ≥ 45 GB
#    OSM_CITY=monaco       676 KB 的小样本，用来验证整条链路（几秒钟）
#
#  想自己控制这份数据（推荐：本地已经有数据文件就传上去，省一次下载）：
#    ① 只放来源包：把 <城市>.osm.pbf / Beijing.osm.gz 放进卷的 /app/data/osm/，启动时会自动导入
#    ② 连库一起放：把 <城市>.sqlite 放进卷的 /app/data/osm/，启动时直接用，不再导入
#  不想让容器联网：OSM_AUTO_DOWNLOAD=0 —— 缺数据时**直接报错退出**，绝不会偷偷下载。
#  （注意它只关"下载"：卷里已经有来源包时照样会导入，而且导入全程离线。）
#  OSM_FORCE_REIMPORT=1 —— 卷里已经有库也强制重新导入（换城市时用它，否则会被"已有数据集"跳过）。
#  OSM_DB / OSM_SOURCE / OSM_SOURCE_URL —— 显式覆盖城市预设里的路径与地址（留空则用预设）。
#
#  关于磁盘：下载前会先算"源文件 + 入库后的库 + 余量"够不够，不够就用中文说清楚差多少、
#  可以怎么办（换分省包 / 扩卷 / 在别处导好再拷），而不是写到一半 ENOSPC。
#  关于端口：导入期间这个容器**不会监听 8787**（ENTRYPOINT 跑完才交给 CMD 里的服务器），
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

# ---- 2. 卷里已经有库 → 直接用（除非 OSM_FORCE_REIMPORT=1） --------------------------
if [ -f "$OSM_DB" ] && [ "$OSM_FORCE_REIMPORT" != "1" ]; then
  echo "[deploy] 已有数据集，跳过下载与导入：$OSM_DB（$(du -h "$OSM_DB" 2>/dev/null | cut -f1 || echo '?')）"
  echo "[deploy] 换数据集：把新库放进卷里并改 OSM_DB，或者用 OSM_CITY=<其它城市> + OSM_FORCE_REIMPORT=1 重新导入"
  echo "[deploy] 服务器启动日志里会打印数据集路径与节点/道路/关系数量，接口 /api/health 的 data 字段也一样汇报"
else
  mkdir -p "$(dirname "$OSM_DB")"
  mkdir -p "$(dirname "$OSM_SOURCE")"

  # ---- 3. 没有来源包 → 下载（或按开关拒绝） --------------------------------------
  if [ ! -f "$OSM_SOURCE" ]; then
    if [ "$OSM_AUTO_DOWNLOAD" = "0" ]; then
      echo "[deploy] 自动下载已关闭（OSM_AUTO_DOWNLOAD=0），而卷里没有来源包：$OSM_SOURCE"
      echo "[deploy] 请把 ${OSM_CITY} 的数据文件放进 $(dirname "$OSM_SOURCE") 后重启容器："
      echo "[deploy]   ${OSM_SOURCE_URL:-（该城市没配 URL，请自己准备文件）}"
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

  # ---- 4. 导入（复用与 XML 完全相同的写库/回填路径） ------------------------------
  echo "[deploy] 开始导入（预计约 ${OSM_EST_MINUTES:-?} 分钟，库约 ${CITY_OSM_EST_DB_MB:-?} MB）…"
  echo "[deploy] ⚠ 导入期间这个容器**不会监听 8787 端口**（ENTRYPOINT 跑完才交给服务器），"
  echo "[deploy]   浏览器连不上是正常的；docker compose logs -f 能看到进度（每 3 秒一行）。"
  # --force：确保是一份干净的库（卷里若残留半个库也一并清掉重来）
  node tools/import-osm.js --file "$OSM_SOURCE" --db "$OSM_DB" --city "$OSM_CITY" --force --quiet
  echo "[deploy] 导入完成：$OSM_DB（$(du -h "$OSM_DB" 2>/dev/null | cut -f1 || echo '?')）"
  echo "[deploy] 提示：来源包 $(basename "$OSM_SOURCE") 已经用不到了，可以删掉以省空间。"
fi

exec "$@"
