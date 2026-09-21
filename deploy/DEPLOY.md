# 部署到自己的服务器（Docker）

按你的选择写的：**Linux + Docker**、**数据在服务器上重新导入**（只下北京 47 MB）、**直接开放 `IP:8787`**。

两种部署方式，选一种就行：

| 方式 | 服务器上需要什么 | 命令 | 章节 |
| --- | --- | --- | --- |
| **A. 就地构建**（下面 1~3 节） | 源码 + 构建（约 1 分钟） | `docker compose up -d --build` | [1](#1-把代码传上服务器) 起 |
| **B. 预构建镜像**（2B 节） | 只要镜像，不要源码 | `docker run -d … <镜像>` | [2B](#2b-方式-b先把镜像推到仓库服务器一行命令) |

想"装的时候一行命令"就用 **方式 B**：本机或 CI 构建一次推到镜像仓库（Docker Hub / GHCR / 阿里云 ACR），
服务器上 `docker run` 一行搞定；代价是多一次"构建+推送"的准备步骤，而且升级时要 `docker pull`。

---

## 0. 服务器要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 系统 | Linux x86_64 / arm64 | 任何主流发行版；镜像基于 `node:22-slim`（Debian） |
| Docker | 20.10+ 且带 compose v2 | `docker compose version` 能打出来就行 |
| 内存 | **建议 4 GB**（最低 2 GB） | 本机实测运行中 RSS 约 0.55~0.85 GB（路网 + 人口网格 + 车队都在内存里） |
| 磁盘 | ≥ 2 GB 可用 | 数据集约 530 MB + 数据包 47 MB + 镜像约 200 MB |
| 端口 | 8787/tcp 放开 | 云服务器记得在**安全组**里也放行，不只是 `ufw` |

**不需要**装 Node、npm、数据库、编译工具链：这个项目零第三方依赖，全部跑在容器里的 Node 上。
（如果你不用 Docker 想裸跑，见文末「附录 A」。）

---

## 1. 把代码传上服务器

只需要 **代码**，**不要传 `data/`**（本机那份数据集 530 MB，而你要在服务器上重新导入）。
特别提醒：本机工作区里的 `passport/`（约 2 GB）跟这个项目无关，别一起传。

```bash
# 方式一：git（推荐，后续更新一条命令）
git clone <你的仓库地址> /opt/osm-city && cd /opt/osm-city

# 方式二：从 Windows 传（只传这些就够）
#   scp -r server public tools config.json package.json Dockerfile docker-compose.yml .dockerignore \
#       deploy user@你的服务器:/opt/osm-city/
```

`start.cmd` 是 Windows 双击用的，服务器上不需要。

---

## 2. 起服务（首次会自动下载 + 导入）

```bash
cd /opt/osm-city
docker compose up -d --build
docker compose logs -f          # 看它干活；看到「[init] 就绪」就是好了
```

首次启动会依次做三件事（`deploy/docker-entrypoint.sh` 里的逻辑）：

1. 数据卷里没有数据集 → 从 BBBike 下载 `Beijing.osm.gz`（约 47 MB）
2. 调用 `tools/import-osm.js` 导入成 `data/osm/osm.sqlite` —— **约 1~2 分钟**，这期间端口还没监听
3. 启动服务器：**端口 200 ms 内就开**，页面会显示进度条，后台重建路网/人口/线路路径（**约 15~20 秒**）

> **更快的做法（省掉那次 47 MB 下载）**：你本机已经有 `data/osm/Beijing.osm.gz`（46.8 MB），
> 直接传进数据卷再启动即可：
> ```bash
> docker compose create osm-city                       # 先把卷建出来
> docker cp data/osm/Beijing.osm.gz osm-city:/app/data/osm/Beijing.osm.gz
> docker compose up -d
> ```
>
> 想彻底禁止容器联网下载（缺数据时直接报错退出，而不是偷偷下 47 MB）：
> 在 `docker-compose.yml` 的 `environment` 里加 `OSM_AUTO_DOWNLOAD: "0"`。
> （不要用"把 `OSM_SOURCE_URL` 设成空字符串"这个办法 —— `未设置` 与 `设成空` 在不同环境下
> 行为不一致，很容易出现"我明明关了它却还在下载"。）

---

## 2B. 方式 B：先把镜像推到仓库，服务器一行命令

服务器上**不放源码、不做构建**：镜像构建一次（本机或 CI），之后每台服务器只拉镜像。

### ① 构建 + 推送（三选一）

- **CI（推荐，不用本地装 Docker）**：仓库里已经有 `.github/workflows/docker-publish.yml`。
  推代码后到 Actions 页面点 `docker-publish` → **Run workflow**（或打 `v2.0` 这样的 tag 自动触发），
  它会构建 **amd64 + arm64 两个架构**并推到 GHCR。
  首次使用要在仓库 **Settings → Actions → General → Workflow permissions** 里选
  **Read and write permissions**，否则 `GITHUB_TOKEN` 没有推包权限。
- **本机有 Docker**：`./deploy/build-push.sh docker.io/你的用户名/osm-city:2.0`
  （只推本机架构用 `PLATFORMS=linux/amd64 ./deploy/build-push.sh <tag>`，快得多）
- **任意镜像仓库都行**：Docker Hub、阿里云 ACR、腾讯云 TCR、`ghcr.io` 都只是把上面的 tag 换掉。

> arm64 值得一起推：便宜 VPS（Oracle/Ampere、鲲鹏）很多是 arm64，
> 构建时你不知道服务器是什么架构，两个都推上去最省事。

### ② 服务器上就一行

```bash
docker run -d --name osm-city \
  -p 8787:8787 \
  -v osm-data:/app/data \
  --restart unless-stopped \
  ghcr.io/你的用户名/你的仓库:latest
```

私有镜像要先登录（GHCR 的密码用带 `read:packages` 权限的 PAT）：

```bash
docker login ghcr.io -u 你的用户名
```

习惯用 compose 的话，把 `docker-compose.yml` 里的 `build: .` 换成 `image:` 即可：

```yaml
services:
  osm-city:
    image: ghcr.io/你的用户名/你的仓库:latest     # ← 去掉 build: .，其余（卷/端口/内存/健康检查）都不变
```

### ③ 升级与回滚

```bash
docker pull ghcr.io/你的用户名/你的仓库:latest
docker stop osm-city && docker rm osm-city
# 再跑一遍 ② 那条 run；数据在 osm-data 卷里，删容器不丢档
```

用 `:2.0` / `:sha-xxxxxxx` 这类固定 tag 部署，就随时能 `docker run` 回上一个版本。
**升级前先备份**（`docker compose exec osm-city node tools/backup-osm.js …`），因为启动时数据库会自动迁移。

### ④ 关于"平台上部署"（Railway / Render / Zeabur / Sealos / 阿里云 SAE 之类）

这些平台能吃 Dockerfile 或镜像，但有三个坑，先看清楚再上：

1. **必须挂持久卷到 `/app/data`**。多数平台默认文件系统是**临时的**：重新部署/重启一次，
   数据集和玩家存档（公司/线路/车辆/车站）就全没了。没有持久卷就别在这类平台开长期存档。
2. **内存给足 1 GB 以上**：实测运行中 RSS 0.55~0.85 GB（路网 + 人口网格 + 车队都在内存里），首次导入还要额外内存。
3. **首次启动要下载 47 MB 并导入 1~2 分钟**，期间端口虽已监听但 `/api/*` 会 503；
   有些平台的启动探针等不了这么久。稳妥做法：先在你自己的机器上把 `osm.sqlite` 导好，
   直接放进持久卷（`/app/data/osm/osm.sqlite`），容器启动时就会跳过导入。

> 镜像里**不含数据集与玩法存档**（它们在数据卷里），所以镜像本身很小（≈100 MB），
> 推拉都很快；但也意味着"换一台服务器"时别忘了把数据卷一起搬过去。

---

## 3. 验证

```bash
# ① 进程活着、数据集载入了（这个接口不需要登录）
curl -s http://127.0.0.1:8787/api/health
# → {"ok":true,... "data":{"nodes":2181032,"ways":335686,...}}

# ② 初始化进度（ready=true 才是真的可用）
curl -s http://127.0.0.1:8787/api/ready

# ③ 容器健康状态
docker compose ps          # STATUS 里应出现 (healthy)
```

然后浏览器打开 `http://你的服务器IP:8787/`，点「注册新账号」建一个账号（昵称 + 至少 4 位密码）就能开始玩。
外面连不上时按顺序查：**云安全组 → 系统防火墙 → 容器是否在跑**：

```bash
sudo ufw allow 8787/tcp                    # 如果开了 ufw
docker compose ps                          # 容器在跑吗
sudo ss -ltnp | grep 8787                  # 宿主机在监听吗
```

---

## 4. 日常运维

```bash
docker compose logs -f --tail 200          # 日志（stdout，没有日志文件）
docker compose restart                     # 重启（约 15~20 秒恢复）
docker compose down                        # 停掉，数据卷保留
docker compose up -d                       # 再起
```

**备份**（重要：这是一份**多人共享的可编辑数据集**，误删无法从 OSM 官方恢复）：

```bash
# 用项目自带的工具导出干净副本（VACUUM INTO，运行中也安全，不会拷到写一半的状态）
docker compose exec osm-city node tools/backup-osm.js \
  --db data/osm/osm.sqlite --out data/osm/backup/osm-$(date +%Y%m%d-%H%M%S).sqlite

# 把备份捞到宿主机（容器删了备份也就没了，别只留在卷里）
docker cp osm-city:/app/data/osm/backup/. ./backups/
```

想每天自动备份，宿主机加一条 cron（凌晨 4 点）：

```cron
0 4 * * * cd /opt/osm-city && docker compose exec -T osm-city node tools/backup-osm.js --db data/osm/osm.sqlite --out data/osm/backup/osm-$(date +\%Y\%m\%d).sqlite && docker cp osm-city:/app/data/osm/backup/osm-$(date +\%Y\%m\%d).sqlite /opt/backups/
```

**更新到新版本**：

```bash
cd /opt/osm-city
# 先备份（见上）
git pull                                   # 或重新传代码
docker compose up -d --build               # 重建镜像并重启
```

数据库迁移、空间索引自愈、LOD 回填都在启动时**自动**进行（`server/dbschema.js`），不需要手动跑脚本。
要注意的是：**启动时会改动 `osm.sqlite` 的结构与索引**，所以「先备份、再升级」不是客套话。

---

## 5. 配置（`config.json`）

改完 `config.json` 要 `docker compose up -d`（重建并重启）才生效。服务器上通常会动这几项：

| 字段 | 当前 | 什么时候改 |
| --- | --- | --- |
| `port` | 8787 | 想换端口（同时要改 `docker-compose.yml` 的 `ports` 映射） |
| `host` | `0.0.0.0` | **容器里保持 0.0.0.0 别动**，否则容器外连不上 |
| `maxPlayers` | 64 | 同屏人数上限 |
| `allowGuests` | `false` | **建议保持关闭**，见下面的「安全」 |
| `limits.opsPer10s` | 120 | 每人 10 秒操作上限（防手滑/防刷） |
| `defaultCenter` | 天安门 z16 | 新玩家初始视角（**不要**改成别的城市，除非你也换了数据集） |
| `transit.economy` | false | 打开就变成真花钱的经营模式 |

> 数据集是只读来源 + 服务器本地镜像：所有编辑只写进你这台服务器的 `osm.sqlite`，
> **不会**提交到 OpenStreetMap 官方数据库，也不需要 OAuth。

---

## 6. 安全（你选了「直接开放 IP:8787」，请务必读这一节）

1. **这是明文 HTTP。** 登录密码和会话 token 在网络上不加 TLS，同链路/同网段可被截获。
   本项目**没有内置 HTTPS**（自研 WebSocket 服务器只做 HTTP/WS），所以：
   - **最小风险做法**：防火墙只放行你自己的 IP，别人一律拒绝：
     ```bash
     sudo ufw allow from 你的家宽IP to any port 8787 proto tcp
     sudo ufw deny 8787/tcp
     ```
   - **要公开给朋友玩**：加个反代拿 TLS（Caddy 最省事，见下一节），把 `ports` 改成 `127.0.0.1:8787:8787`
     只让反代访问，公网只开 443。
   - 或者先不开放公网，用 SSH 隧道自己玩：`ssh -L 8787:127.0.0.1:8787 user@服务器`，然后开 `http://127.0.0.1:8787/`。
2. **谁都能注册，而玩法上玩家之间可以互相改删资产。** 这是刻意的设计（协作编辑 + 元素锁，
   只有"别人正在编辑"的元素锁能挡住操作，归属不构成保护）。所以**别把地址到处发**；
   `maxPlayers: 64` 与限流（`opsPer10s` 等）是现有的唯一约束。
3. **游客登录默认关闭**（`allowGuests: false`）：`POST /api/guest` 直接 403，页面上没有游客按钮。
   别为了图省事打开它 —— 打开等于"任何人可匿名进来改你的地图"。
4. 容器以非 root（uid 1000 的 `node` 用户）运行；数据卷是唯一的可写目录。
   用**绑定挂载**代替命名卷时记得改属主：`sudo chown -R 1000:1000 /opt/osm-city-data`。

### 想加 HTTPS（Caddy 反代，约 2 分钟）

**关键点：WebSocket 必须被正常转发**（客户端全程用 WS 收帧），漏了这一步页面能打开、
但地图一直连不上/反复掉线。

```caddy
# /etc/caddy/Caddyfile  —— 把域名解析到这台服务器，Caddy 自动申请证书
你的域名.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 默认就会转发 WebSocket 升级头，不用额外配置，而且**Caddy 默认不写访问日志**，
所以 token 不会因为反代而落盘。用 Nginx 的话这两行不能少：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # ← 少了这两行 WS 握手会失败
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;                    # WS 长连接别被 60 秒掐断
}
```

> ⚠ **Nginx 的访问日志会把 token 记下来。** 客户端把会话 token 放在查询串里
> （`/ws?token=…`、`/api/map?token=…`、导出下载链接也是），而 Nginx 默认的 `log_format`
> 用 `$request`，它**包含完整的查询串** —— 于是你的 `access.log` 里会躺着一串串可直接冒充登录的 token。
> 两种收口方式，选一种：
>
> ```nginx
> # 方式一（最省事）：这一站干脆不写访问日志
> access_log off;
>
> # 方式二：照旧记日志，但只记路径、不记查询串
> #   在 http {} 块里定义：
> log_format no_query '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
>                     '$status $body_bytes_sent "$http_referer" "$http_user_agent"';
> #   在 server {} 块里用：
> access_log /var/log/nginx/osm-city.access.log no_query;
> ```
>
> 顺带提醒：`$request` 含查询串这件事对所有"token 放 URL 里"的应用都成立，
> 更彻底的修法是把 token 改成走 `Authorization` 头（属于代码改动，目前没做）。

改完把 compose 的端口收成 `127.0.0.1:8787:8787`，重启即可。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `端口 8787 已被占用` | 宿主机上有别的进程占用。`sudo ss -ltnp \| grep 8787` 找到并停掉，或换端口（同时改 compose 的映射） |
| 容器起来了但浏览器打不开 | 云**安全组**没放行 8787；或 `host` 被改成了 `127.0.0.1` |
| 页面一直转圈、地图不出来 | 初始化还没完（首次 15~20 秒，导入时 1~2 分钟）；`curl /api/ready` 看进度。反代场景多半是 WebSocket 升级头没配 |
| `/app/... entrypoint.sh: not found` 或 `\r` 相关报错 | 代码从 Windows 传来时带了 CRLF。Dockerfile 里已经 `sed -i 's/\r$//'` 兜住；若你手动挂载脚本，请先 `dos2unix deploy/docker-entrypoint.sh` |
| `Cannot find module 'node:sqlite'` | Node 太老。基础镜像固定 `node:22-slim`（需 ≥22.5）；自建镜像请用 22.x 最新版，或给命令加 `--experimental-sqlite` |
| 重启后存档没了 | 数据卷没挂上（绑错目录/用了 `down -v`）。确认 `docker compose ps` 里挂载了 `osm-data:/app/data` |
| 内存被杀（OOMKilled） | `docker inspect osm-city \| grep OOMKilled`。调高 `mem_limit` 或加内存（见「服务器要求」） |
| 想换成别的城市/加城市 | 见文末「附录 B」 |

---

## 附录 A：不用 Docker，裸跑（systemd）

```ini
# /etc/systemd/system/osm-city.service
[Unit]
Description=OSM City Online
After=network.target

[Service]
Type=simple
User=osmcity
WorkingDirectory=/opt/osm-city
Environment=DATA_DIR=/opt/osm-city/data
ExecStart=/usr/bin/node server/index.js --port 8787
Restart=always
RestartSec=5
# 内存上限（可选）：超了会被 OOM 杀掉，按需调
MemoryMax=3G

[Install]
WantedBy=multi-user.target
```

前置：装 Node 22（≥22.5），`node tools/import-osm.js --file data/osm/Beijing.osm.gz --db data/osm/osm.sqlite --force` 导入一次。
注意：项目所有路径都相对**项目根目录**解析（`server/index.js` 里的 `ROOT = path.resolve(__dirname, '..')`），
所以 `WorkingDirectory` 不是必须的，但数据目录要有写权限。

---

## 附录 B：换数据集 / 以后加城市

```bash
# 换一个城市：下载该城市的 BBBike 包，导入（--force 会清空现有 OSM 数据）
docker compose exec osm-city node tools/import-osm.js \
  --file data/osm/Shanghai.osm.gz --db data/osm/osm.sqlite --force

# 以后想把石家庄/河北并进同一张图：先用导入器把它导成一个独立库，再 merge 进主库
#   （--dry-run 先看一遍会加多少、冲突多少；主库既有数据不会被覆盖）
docker compose exec osm-city node tools/merge-osm.js --src data/osm/hebei.sqlite --db data/osm/osm.sqlite --dry-run
docker compose exec osm-city node tools/merge-osm.js --src data/osm/hebei.sqlite --db data/osm/osm.sqlite

# 改完一大批建筑后重算人口网格
docker compose exec osm-city node tools/rebuild-population.js --db data/osm/osm.sqlite
```

**注意**：`--force` 会清空 `nodes/ways/relations/空间索引/变更日志`（也就是**所有地图编辑**），
但**不会**动交通玩法表（公司/线路/车辆/车站）。换城市前先备份。

---

## 附录 C：这份部署没被验证到哪一步

诚实说明：**我没有 Docker 环境**，所以 `Dockerfile` / `docker-compose.yml` 只做了逐条核对，
没有真正 `docker build` 过。已经在本机验证过的部分是：

- `tools/import-osm.js --file … --db … --force --quiet`（入口脚本调用的那条命令）参数与行为正确
- 健康检查用的 Node 单行命令（`fetch('http://127.0.0.1:8787/api/health')`）实测返回 200、退出码 0
- `/api/health`、`/api/ready` 的真实响应形状；端口 200 ms 内监听、初始化 15~20 秒
- 项目所有路径都相对项目根解析（与工作目录无关）；`DATA_DIR` 环境变量被 `server/index.js` 读取
- `.dockerignore` 排除了 `data/`（约 1 GB）与 `passport/`（约 2 GB），否则构建上下文会大到离谱

第一次 `docker compose up -d --build` 如果报错，把 `docker compose logs` 的输出发我，我照着改。
