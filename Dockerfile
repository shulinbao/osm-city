# 我是市委书记（OSM 城市在线）—— 生产镜像
#
# 这个项目**零第三方依赖**：没有 npm install，没有构建步骤，只有 Node 自带的模块。
# 所以镜像里不需要 node_modules，也不需要编译工具链。
#
# 基础镜像用 node:22-slim（22.x 最新补丁版）。要求 Node ≥ 22.5，因为存储引擎用的是
# Node 内置的 `node:sqlite`（见 server/dbschema.js）。本机实测 v22.22.0 无需任何实验标志；
# 如果你的运行时较老、报 `Cannot find module 'node:sqlite'`，换 22.x 最新版即可，
# 或给命令加 `--experimental-sqlite`。
FROM node:22-slim

# curl 只用于"数据卷里还没有数据集时自动下载北京数据包（约 47 MB）"。
# 你也可以不装它：把 Beijing.osm.gz 直接放进卷里即可（见 deploy/DEPLOY.md）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只拷贝运行需要的东西。构建上下文由 .dockerignore 收窄 —— 注意 data/（约 1 GB 数据集）
# 与 passport/（约 2 GB，跟本项目无关的另一份代码）都必须排除，否则上下文会上传几个 GB。
COPY package.json config.json ./
COPY server ./server
COPY public ./public
COPY tools ./tools
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# 这份代码在 Windows 上开发：如果工作区被 CRLF 污染过，`#!/bin/sh\r` 会让容器起不来，
# 所以这里统一把 CR 去掉再赋可执行权限（幂等，重复构建无副作用）。
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
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

EXPOSE 8787

# 健康检查用 Node 自己发请求（slim 镜像里没有 curl 之外的工具，这里连 curl 都不依赖）。
# start-period 给足：首次启动要导入数据 + 重建路网，之后每次启动也要 15~20 秒。
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
