#!/usr/bin/env bash
# ============================================================================
#  在本机构建镜像并推到镜像仓库（不想用 CI 就手动跑这个）。
#
#  用法：
#    ./deploy/build-push.sh ghcr.io/你的用户名/osm-city:latest
#    ./deploy/build-push.sh docker.io/你的用户名/osm-city:2.0
#    ./deploy/build-push.sh registry.cn-hangzhou.aliyuncs.com/你的命名空间/osm-city:2.0
#
#  只推本机架构（快）：
#    ./deploy/build-push.sh --platforms linux/amd64 ghcr.io/你/osm-city:latest
#  推多架构（amd64 + arm64，服务器是哪种架构都能用；需要 buildx + QEMU）：
#    ./deploy/build-push.sh ghcr.io/你/osm-city:latest          # 默认就是两个架构
#
#  ── 镜像里现在**带着数据集**（这是重点，别按老印象理解）────────────────────
#  Dockerfile 是两阶段的：种子阶段在构建期就把"一次性计算"跑完（导入 OSM → 迁移 →
#  ways.road_class / lod_zoom 回填 + 部分索引 → 人口网格全量推算 done=1），
#  产出一份约 492 MB 的种子库烘进镜像（压缩后约 160 MB 的下载增量）。
#  用户那边首次启动只剩"把种子拷进数据卷"（秒级），不再下载、不再导入、不再推算人口。
#  所以：**镜像≈代码+数据**，数据卷里放的是可写副本（存档与后续改动都在卷里）。
#
#  种子怎么来的（三条路，脚本会自动选）：
#    ① 上下文里有 deploy/seed/osm.sqlite（CI 先用原生 Node 生成好）→ 只校验 + 拷贝，几秒；
#    ② 没有它就 `--with-seed`：本脚本先跑 deploy/build-seed.sh 生成一份（推荐，多架构必用）；
#    ③ 都没有：Dockerfile 的种子阶段自己在容器里下载 + 导入 + 推算 ——
#       **本机同架构**没问题（就是慢几分钟）；**arm64 走 QEMU** 会慢很多倍，
#       所以多架构 + 没有种子时本脚本默认**拒绝**（要硬跑加 --allow-slow）。
#
#  推完在服务器上就两行（或一行 docker run）：
#    docker compose pull && docker compose up -d
#    docker run -d --name osm-city -p 8787:8787 -v osm-data:/app/data \
#      --restart unless-stopped <你推的 tag>
# ============================================================================
set -euo pipefail

TAG=""
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
WITH_SEED=0
ALLOW_SLOW=0

while [ $# -gt 0 ]; do
  case "$1" in
    --with-seed) WITH_SEED=1; shift ;;
    --allow-slow) ALLOW_SLOW=1; shift ;;
    --platforms) PLATFORMS="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "[push] 不认识的参数：$1（--help 看用法）" >&2; exit 1 ;;
    *) TAG="$1"; shift ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "用法：$0 [--with-seed] [--platforms linux/amd64,linux/arm64] <镜像tag>" >&2
  echo "例如：$0 --with-seed ghcr.io/yourname/osm-city:latest" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SEED="deploy/seed/osm.sqlite"

command -v docker >/dev/null 2>&1 || { echo "[push] 本机没有 docker 命令，先装 Docker（Desktop 或 docker-ce）" >&2; exit 1; }

# ---------------------------------------------------------------- 种子库 --
if [ "$WITH_SEED" = "1" ]; then
  echo "[push] 先用构建期的种子脚本算好一次性计算（导入 / 迁移 / LOD 回填 / 人口网格）…"
  echo "[push] 产物：$SEED（已存在时来源包会复用，不会重新下载 46.8 MB）"
  # --port 8799 是临时实例端口：**绝不用 8787**（那是线上服）
  sh deploy/build-seed.sh --out "$SEED" --city "${OSM_SEED_CITY:-beijing}" \
    --data "${TMPDIR:-/tmp}/osm-city-seed-data" --port 8799 --timeout 1800
fi

if [ -s "$SEED" ]; then
  SEED_MB=$(( $(wc -c < "$SEED" | tr -d ' ') / 1048576 ))
  echo "[push] 上下文里有预生成种子：deploy/seed/osm.sqlite（${SEED_MB} MB）"
  echo "[push] → 两个架构**共用**这一份快照，构建期只做校验 + 拷贝，几十秒级。"
else
  echo "[push] 上下文里没有预生成种子（deploy/seed/osm.sqlite）。"
  echo "[push] → Dockerfile 的种子阶段会在容器里自己下载 + 导入 + 推算人口网格。"
  case "$PLATFORMS" in
    *,*)
      if [ "$ALLOW_SLOW" != "1" ]; then
        cat >&2 <<'EOF'
[push] ❌ 拒绝这么干：你推的是**多架构**，其中一条腿要在本机用 QEMU 模拟跑。
       把"导入 OSM + 全量推算人口网格"塞进模拟环境会慢很多倍（也可能 OOM/超时），
       而且两个架构各算一遍没有任何意义（库内容应当一致）。
       两条正路（随便挑一条）：
         a) 先算好种子再推（推荐，一次算两架构共用）：
              ./deploy/build-push.sh --with-seed <tag>
         b) 只推本机架构（同架构构建，容器里自己算也没问题）：
              ./deploy/build-push.sh --platforms linux/amd64 <tag>
       确实想在模拟环境里硬跑：加 --allow-slow。
EOF
        exit 1
      fi
      echo "[push] ⚠ --allow-slow：真要在 QEMU 里跑导入 + 人口推算，会很慢，请耐心等。"
      ;;
    *)
      echo "[push] 单架构本机构建：容器里自己算也没问题（多花几分钟）。"
      ;;
  esac
fi

# ---------------------------------------------------------------- 构建 --
BASH_ARCH="$(uname -m 2>/dev/null || echo '?')"
case "$PLATFORMS" in
  linux/amd64|linux/arm64)
    # 单架构：普通 build + push 就够，不需要 buildx
    echo "[push] 构建：$TAG（平台 $PLATFORMS，本机 $BASH_ARCH）"
    docker build --platform "$PLATFORMS" -t "$TAG" .
    echo "[push] 推送…"
    docker push "$TAG"
    ;;
  *)
    # 多架构必须走 buildx 的容器驱动（默认 docker 驱动不支持一次推多个平台）
    if ! docker buildx inspect osm-city-builder >/dev/null 2>&1; then
      echo "[push] 创建 buildx 构建器 osm-city-builder（多架构需要）…"
      docker buildx create --name osm-city-builder --use >/dev/null
    else
      docker buildx use osm-city-builder >/dev/null
    fi
    docker buildx inspect --bootstrap >/dev/null
    echo "[push] 构建并推送：$TAG（平台 $PLATFORMS，本机 $BASH_ARCH）"
    docker buildx build --platform "$PLATFORMS" -t "$TAG" --push .
    ;;
esac

echo
echo "[push] 完成：$TAG"
echo "[push] ⚠ 镜像里**已经带着数据集**（种子库：人口网格 / LOD 回填 / 空间索引都算好了）："
echo "[push]   容器首次启动只把种子拷进数据卷（实测 492 MB 约 0.2 秒），不再下载/导入/推算。"
echo "[push]   之后容器**永远以数据卷里的库为准** —— 更新镜像不会覆盖你的存档与世界。"
echo
echo "[push] 服务器上部署（任选一行）："
echo "  docker run -d --name osm-city -p 8787:8787 -v osm-data:/app/data --restart unless-stopped $TAG"
echo "  docker compose pull && docker compose up -d      # 已经有 compose 文件时"
echo
echo "[push] 留个底：更新前先备份（卷里是你和玩家的存档）："
echo '  docker exec osm-city node tools/backup-osm.js --db data/osm/osm.sqlite --out data/osm/backup/osm-<时间戳>.sqlite'
echo "[push] 想强制走「下载 + 导入」的老路径（不用镜像里的种子）：给容器加环境变量 OSM_SEED=0。"
echo "[push] ⚠ 别用 docker compose down -v：那会连数据卷一起删。"
