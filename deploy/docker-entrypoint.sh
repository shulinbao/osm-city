#!/bin/sh
# ============================================================================
#  容器入口：保证"数据卷里有一份可用的数据集"，然后把命令交给 CMD。
#
#  为什么要有这一步：本项目的数据集（约 530 MB 的 SQLite）不在镜像里，
#  它放在数据卷 /app/data 里。第一种启动时卷是空的 —— 这里负责
#   ① 下载北京数据包（约 47 MB，BBBike 城市提取包）
#   ② 用 tools/import-osm.js 导入成 data/osm/osm.sqlite（约 1~2 分钟）
#  之后再启动就直接跳过（卷里已经有库了），只走正常的 ~15~20 秒路网重建。
#
#  想自己控制这份数据（推荐：本地已经有 Beijing.osm.gz 的话直接传上去，省一次下载）：
#    ① 只放来源包：把 Beijing.osm.gz 放进卷的 /app/data/osm/，启动时会自动导入
#    ② 连库一起放：把 osm.sqlite 放进卷的 /app/data/osm/，启动时直接用，不再导入
#  关掉自动下载：OSM_SOURCE_URL= （空字符串）—— 缺数据时会直接报错退出，不会偷偷下载。
# ============================================================================
set -eu

OSM_DB="${OSM_DB:-/app/data/osm/osm.sqlite}"
OSM_SOURCE="${OSM_SOURCE:-/app/data/osm/Beijing.osm.gz}"
OSM_SOURCE_URL="${OSM_SOURCE_URL-https://download.bbbike.org/osm/bbbike/Beijing/Beijing.osm.gz}"
# 1 = 缺数据时允许自动下载；0 = 绝不联网，缺数据直接报错退出。
# 为什么不用"把 URL 设成空字符串"来关：`${VAR-default}` 只在变量**未设置**时才用默认值，
# 而"未设置"和"设成空"在不同环境里行为不一样（PowerShell 里赋空值往往等于删掉变量、
# docker-compose 里则是真的空串），很容易出现"我明明关了它却还在下载"。所以用显式开关。
OSM_AUTO_DOWNLOAD="${OSM_AUTO_DOWNLOAD-1}"

if [ ! -f "$OSM_DB" ]; then
  echo "[deploy] 数据卷里还没有数据集：$OSM_DB"
  mkdir -p "$(dirname "$OSM_DB")"

  if [ ! -f "$OSM_SOURCE" ]; then
    # 显式开关优先：OSM_AUTO_DOWNLOAD=0 时**绝不联网**，缺数据就报错退出。
    if [ "$OSM_AUTO_DOWNLOAD" = "0" ]; then
      echo "[deploy] 自动下载已关闭（OSM_AUTO_DOWNLOAD=0），而数据卷里没有来源包：$OSM_SOURCE"
      echo "[deploy] 请把 Beijing.osm.gz（或任意 .osm / .osm.gz）放进 $(dirname "$OSM_SOURCE") 后重启容器。"
      exit 1
    fi
    if [ -z "$OSM_SOURCE_URL" ]; then
      echo "[deploy] 没有来源包，而且下载地址是空的（OSM_SOURCE_URL 为空）。"
      echo "[deploy] 请把 Beijing.osm.gz（或任意 .osm / .osm.gz）放进 $(dirname "$OSM_SOURCE") 后重启容器。"
      exit 1
    fi
    echo "[deploy] 正在下载数据包（约 47 MB）：$OSM_SOURCE_URL"
    # 先写 .part 再改名：下载中途失败不会留下一个"看起来完整"的坏文件。
    # 用 --silent --show-error 而不是进度条：容器日志是逐行的，进度条会把 docker logs 刷爆。
    if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --silent --show-error \
         -o "$OSM_SOURCE.part" "$OSM_SOURCE_URL"; then
      mv "$OSM_SOURCE.part" "$OSM_SOURCE"
    else
      rm -f "$OSM_SOURCE.part"
      echo "[deploy] 下载失败（网络 / 镜像站不可达 / 对方限流）。"
      echo "[deploy] 两个办法：① 在能上网的机器上下载后放进 $(dirname "$OSM_SOURCE")；"
      echo "[deploy]           ② 把本机 data/osm/Beijing.osm.gz（46.8 MB）直接传上去。"
      exit 1
    fi
  fi

  echo "[deploy] 开始导入（约 1~2 分钟，导入期间这个容器不会监听端口，稍等即可）…"
  # --force：确保是一份干净的库（卷里若残留半个库也一并清掉重来）
  node tools/import-osm.js --file "$OSM_SOURCE" --db "$OSM_DB" --force --quiet
  echo "[deploy] 导入完成：$OSM_DB"
  echo "[deploy] 提示：来源包 $(basename "$OSM_SOURCE") 已经用不到了，可以删掉以省空间。"
else
  echo "[deploy] 已有数据集，跳过导入：$OSM_DB"
fi

exec "$@"
