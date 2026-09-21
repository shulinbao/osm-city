#!/usr/bin/env bash
# ============================================================================
#  在本机构建镜像并推到镜像仓库（不想用 CI 就手动跑这个）。
#
#  用法：
#    ./deploy/build-push.sh docker.io/你的用户名/osm-city:2.0
#    ./deploy/build-push.sh registry.cn-hangzhou.aliyuncs.com/你的命名空间/osm-city:2.0
#    ./deploy/build-push.sh ghcr.io/你的用户名/osm-city:2.0
#
#  只推本机架构（快）：
#    PLATFORMS=linux/amd64 ./deploy/build-push.sh <tag>
#  推多架构（amd64 + arm64，需要 buildx + QEMU，慢一些但服务器是哪种架构都能用）：
#    PLATFORMS=linux/amd64,linux/arm64 ./deploy/build-push.sh <tag>
#
#  推完在服务器上就一行：
#    docker run -d --name osm-city -p 8787:8787 -v osm-data:/app/data \
#      --restart unless-stopped <你推的 tag>
# ============================================================================
set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "用法：$0 <镜像tag>，例如 docker.io/yourname/osm-city:2.0" >&2
  exit 1
fi

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || { echo "[push] 本机没有 docker 命令，先装 Docker（Desktop 或 docker-ce）" >&2; exit 1; }

# 多架构必须走 buildx 的容器驱动（默认 docker 驱动不支持一次推多个平台）
if [ "$PLATFORMS" != "linux/amd64" ] && [ "$PLATFORMS" != "linux/arm64" ]; then
  if ! docker buildx inspect osm-city-builder >/dev/null 2>&1; then
    echo "[push] 创建 buildx 构建器 osm-city-builder（多架构需要）…"
    docker buildx create --name osm-city-builder --use >/dev/null
  else
    docker buildx use osm-city-builder >/dev/null
  fi
  docker buildx inspect --bootstrap >/dev/null
  echo "[push] 构建并推送：$TAG  （平台：$PLATFORMS）"
  docker buildx build --platform "$PLATFORMS" -t "$TAG" --push .
else
  # 单架构：普通 build + push 就够，不需要 buildx
  echo "[push] 构建：$TAG  （平台：$PLATFORMS）"
  docker build --platform "$PLATFORMS" -t "$TAG" .
  echo "[push] 推送…"
  docker push "$TAG"
fi

echo
echo "[push] 完成：$TAG"
echo "[push] 服务器上部署（一行）："
echo "  docker run -d --name osm-city -p 8787:8787 -v osm-data:/app/data --restart unless-stopped $TAG"
echo
echo "[push] 注意：镜像里**没有**数据集与玩法存档，它们都在数据卷 osm-data 里。"
echo "[push] 首次启动容器会自动下载北京数据包并导入（约 1~2 分钟）；"
echo "[push] 想跳过下载就先把 Beijing.osm.gz 或 osm.sqlite 放进卷里，见 deploy/DEPLOY.md。"
