# 我是市委书记（OSM 城市在线）—— 生产镜像
#
# 这个项目**零第三方依赖**：没有 npm install，没有构建步骤，只有 Node 自带的模块。
# 所以镜像里不需要 node_modules，也不需要编译工具链。
#
# 基础镜像用 node:22-slim（22.x 最新补丁版）。要求 Node ≥ 22.5，因为存储引擎用的是
# Node 内置的 `node:sqlite`（见 server/dbschema.js）。本机实测 v22.22.0 无需任何实验标志；
# 如果你的运行时较老、报 `Cannot find module 'node:sqlite'`，换 22.x 最新版即可，
# 或给命令加 `--experimental-sqlite`。
#
# ============================================================================
#  两个阶段：① 构建期把"一次性计算"跑完 → 种子库；② 运行镜像 = 代码 + 种子库
#
#  为什么要把这些活挪到构建期：容器首次启动时，服务器要干的远不止"导入 OSM"——
#    ① tools/import-osm.js 写元素 + 回填 bbox/几何 + 建索引（北京实测 53.9 秒 / 库 479 MB）；
#    ② 服务器启动时做数据库迁移 + ways.road_class / ways.lod_zoom 回填 + 部分索引；
#    ③ **首次人口/岗位网格全量推算**（population.js 的 buildAll()）：北京要扫 31.7 万条带标签的
#       way（本机 20 核算 9.9 秒）。现在的实现是**切片跑**（每片 ≤ sliceMs 就让出事件循环，
#       所以不会像老版本那样把事件循环整个占住），但它仍然是分钟级的纯 CPU + 磁盘活 ——
#       1 GB 内存的小机器上，用户在导入（497.9 秒）之后就是被这一段拖到无法登录；
#    ④ 铁路网 / 道路网 / 线路路径（内存结构，不落库，每次启动照样要重建）。
#  ①②③ 的结果全都在 sqlite 里，所以可以在**构建机**（CI runner / 开发机，CPU 与内存富余）
#  上一次算完，烘进镜像；用户那边首次启动只剩 `cp`（492 MB，秒级），不再有下载/导入/推算。
#  详细命令与超时见 deploy/build-seed.sh；部署影响见 deploy/DEPLOY.md。
# ============================================================================

# ---------------------------------------------------------------------------
# 阶段 1：构建期生成"种子库"（导入 + 迁移 + LOD 回填 + 人口网格推算 + 索引）
# ---------------------------------------------------------------------------
FROM node:22-slim AS seed

# 种子阶段只需要这几样：导入器/下载器（tools/）、服务器（server/）、城市注册表（tools/cities.json）
# 与 config.json。不装 curl：下载与健康探测都是纯 Node（tools/fetch-osm.js / fetch）。
WORKDIR /app
COPY package.json config.json ./
COPY server ./server
COPY tools ./tools
COPY deploy ./deploy

# 这份代码在 Windows 上开发：工作区可能被 CRLF 污染过，而 CRLF 会让 sh 脚本直接跑不起来。
# 统一去掉 CR（幂等）。entrypoint 在阶段 2 也做一次同样的处理。
RUN sed -i 's/\r$//' deploy/build-seed.sh deploy/docker-entrypoint.sh

# 种子库对应的数据集（与运行时给用户看的 OSM_SEED_CITY 必须一致，否则运行时不会用它）
ARG OSM_SEED_CITY=beijing
# 构建期临时实例的端口与超时：**8799 是特意挑的，绝不用 8787**（那是线上服）
ARG OSM_SEED_PORT=8799
ARG OSM_SEED_TIMEOUT=1800

# 两种构建路径，自动选：
#   · 上下文里有 deploy/seed/osm.sqlite（CI 先用原生 Node 在 runner 上生成好，见
#     .github/workflows/docker-publish.yml）→ 只校验 + 拷贝，**几秒**，多架构共用同一份快照；
#   · 没有（例如你本机 `docker build .`）→ 这个阶段自己下载 + 导入 + 起一次服务器把初始化跑完。
#     这条路在本机同架构构建下也没问题；但如果是 arm64 走 QEMU 模拟，会非常慢（见 DEPLOY.md）。
RUN set -eu; \
    if [ -s deploy/seed/osm.sqlite ]; then \
      echo "[build] 上下文里有预生成种子（CI 产物）：只校验 + 拷贝，跳过下载/导入/初始化"; \
      sh deploy/build-seed.sh --prebuilt deploy/seed/osm.sqlite \
        --out /opt/osm-seed/osm.sqlite --city "$OSM_SEED_CITY"; \
    else \
      echo "[build] 上下文里没有预生成种子：本阶段自己下载 + 导入 + 跑完一次性初始化"; \
      sh deploy/build-seed.sh --out /opt/osm-seed/osm.sqlite --city "$OSM_SEED_CITY" \
        --port "$OSM_SEED_PORT" --timeout "$OSM_SEED_TIMEOUT"; \
    fi

# ---------------------------------------------------------------------------
# 阶段 2：运行镜像
# ---------------------------------------------------------------------------
FROM node:22-slim

# curl 现在只是给你进容器调试用的（下载数据包、健康检查都是纯 Node 实现的，
# 不依赖 curl/wget）：`docker compose exec osm-city sh` 里想 curl 一下才有。
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只拷贝运行需要的东西。构建上下文由 .dockerignore 收窄 —— 注意 data/（约 1 GB 数据集）
# 与 passport/（约 2 GB，跟本项目无关的另一份代码）都必须排除，否则上下文会上传几个 GB。
COPY package.json config.json ./
COPY server ./server
COPY public ./public
# tools/ 整个进镜像：导入器、下载器（fetch-osm.js）、备份工具（backup-osm.js）都在里面，
# 你可以在容器里直接 `node tools/backup-osm.js`，也可以自己 `node tools/import-osm.js` 换数据集。
COPY tools ./tools
# deploy/ 里的脚本也进镜像：entrypoint 与构建期的 build-seed.sh 随时能查/能重跑。
# ⚠ 这里**逐个文件**拷，不用 `COPY deploy ./deploy` —— 因为 CI 会把预生成种子放在
#   deploy/seed/osm.sqlite（几百 MB），拷目录的话会被塞进最终镜像第二份。
COPY deploy/docker-entrypoint.sh deploy/build-seed.sh deploy/build-push.sh deploy/DEPLOY.md ./deploy/
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# 构建期算好的**种子库**（已含人口网格/索引）——只拷这一个文件与它的报告，
# 不带 -wal/-shm（构建脚本已经做过 WAL 检查点，把 -wal 全折回主库了）。
COPY --from=seed --chown=node:node /opt/osm-seed/osm.sqlite /opt/osm-seed/osm.sqlite
COPY --from=seed --chown=node:node /opt/osm-seed/osm.sqlite.seed.json /opt/osm-seed/seed.json

# 这份代码在 Windows 上开发：如果工作区被 CRLF 污染过，`#!/bin/sh\r` 会让容器起不来，
# 所以这里统一把 CR 去掉再赋可执行权限（幂等，重复构建无副作用）。
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
  && chmod +x /usr/local/bin/docker-entrypoint.sh \
  && chmod 0644 /opt/osm-seed/osm.sqlite /opt/osm-seed/seed.json \
  && mkdir -p /app/data/osm \
  && chown -R node:node /app/data

# 以非 root 运行（官方 node 镜像自带 uid 1000 的 node 用户）。
# 用命名卷（docker compose 默认）时权限自动正确；用宿主机目录做绑定挂载时
# 需要 `sudo chown -R 1000:1000 <宿主机目录>`，见 deploy/DEPLOY.md。
USER node

# DATA_DIR 会被 server/index.js 读取（优先级：命令行 --data > 环境变量 > config.json）。
# /app/data 就是数据卷：OSM 数据集 + 账号（users.json）+ 玩法存档（同一份 sqlite）都在这里。
ENV DATA_DIR=/app/data
# 数据集与来源包的位置（docker-entrypoint.sh 用；也可在 compose 里覆盖）
ENV OSM_DB=/app/data/osm/osm.sqlite
ENV OSM_SOURCE=/app/data/osm/Beijing.osm.gz
ENV OSM_SOURCE_URL=https://download.bbbike.org/osm/bbbike/Beijing/Beijing.osm.gz
# 镜像内预建库（种子）：卷里没有库时直接拷贝它，不再下载/导入/推算人口网格。
# 想强制走回旧路径（下载 + 导入）：OSM_SEED=0。
ENV OSM_SEED_DB=/opt/osm-seed/osm.sqlite
ENV OSM_SEED=auto
# 种子库是哪个城市的数据集：只在 OSM_CITY 与它一致时才会用（不一致就退回下载 + 导入）
ARG OSM_SEED_CITY=beijing
ENV OSM_SEED_CITY=${OSM_SEED_CITY}

EXPOSE 8787

# 健康检查用 Node 自己发请求（不依赖 curl）。
# start-period 给足：改用镜像内预建库之后，首次启动只剩"拷贝（秒级）+ 建路网/线路路径" ——
# 全新库（还没有公交线路）实测初始化 1.0 秒；玩家存档里公交线路很多时这一项仍是 10~20 秒量级。
# 走 OSM_SEED=0 或换城市时更可能长达几分钟，所以这里不做激进的下调。
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
