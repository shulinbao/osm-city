# 部署到自己的服务器（Docker）

按你的选择写的：**Linux + Docker**、**数据在服务器上重新导入**（默认只下北京 47 MB，
也可以一行换成 Geofabrik 的分省包 / 全国包 —— 见 [2C](#2c-选哪个数据集容量耗时内存实测优先) 的容量表）、
**直接开放 `IP:8787`**。

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
| 内存 | **建议 4 GB**（最低 2 GB） | 运行中 RSS 约 0.55~0.85 GB（路网 + 人口网格 + 车队都在内存里）；**导入的额外峰值**实测：北京 93 MB、北京分省包 194 MB（流式解析，与文件大小无关） |
| 磁盘 | **看城市**：北京 ≥ 2 GB · 分省 ≥ 6 GB · **全国 ≥ 45 GB** | 数据集 + 源文件 + 镜像约 200 MB。全国那份库按实测外推 **25~40 GB**（见下面 2C 的容量表），**不是** 4~6 GB —— 这一点请务必先看表再选数据集 |
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

1. 数据卷里没有数据集 → 从数据源下载（默认 BBBike 的 `Beijing.osm.gz`，约 47 MB）
2. 调用 `tools/import-osm.js` 导入成 `data/osm/osm.sqlite` —— **默认北京约 1~2 分钟**
3. 启动服务器：**端口 200 ms 内就开**，页面会显示进度条，后台重建路网/人口/线路路径（**约 15~20 秒**）

> **⚠ 导入期间容器不监听 8787：** 第 1、2 步在 `ENTRYPOINT` 里、服务器（`CMD`）还没起来，
> 所以这期间 `curl http://IP:8787/` 会**连接被拒**——这是正常的，不是启动失败。
> 看进度用 `docker compose logs -f`（下载每 3 秒一行进度，导入每 3 秒一行元素计数）。
> 想要"下载期间就能打开页面"是做不到的：数据集是服务器启动的输入，没有它 `/api/*` 只能 503。

### 换数据集（一行动作）

数据集由 `OSM_CITY` 决定（注册表 `tools/cities.json`，设计见 [CITIES.md](CITIES.md)）：

```bash
# compose 里加一行 environment: OSM_CITY: "hebei"，然后
docker compose up -d --build          # 首次：下河北的包 + 导成 data/osm/hebei.sqlite

OSM_CITY=china        # 全国：1.5 GB 源文件，库 25~40 GB，导入 1~2 小时 —— 先看 2C 的表再决定
OSM_CITY=beijing-pbf  # 北京（Geofabrik 分省包，36 MB，含铁路/边界）：同城更全的来源
OSM_CITY=monaco       # 676 KB 的小样本：用来验证整条链路（几秒钟，不占磁盘）
```

换到**另一座城**时，如果卷里已经有旧城市的库，要显式重建：

```bash
OSM_CITY=hebei OSM_FORCE_REIMPORT=1 docker compose up -d
# 只改 OSM_CITY 不改库名的话，容器会认为"已有数据集"而跳过导入
```

> **更快的做法（省掉那次下载）**：你本机已经有数据文件，直接传进数据卷再启动即可：
> ```bash
> docker compose create osm-city                       # 先把卷建出来
> docker cp data/osm/Beijing.osm.gz osm-city:/app/data/osm/Beijing.osm.gz
> docker compose up -d
> ```
>
> 想彻底禁止容器联网下载（缺数据时直接报错退出，而不是偷偷下载）：
> 在 `docker-compose.yml` 的 `environment` 里加 `OSM_AUTO_DOWNLOAD: "0"`。
> （不要用"把 `OSM_SOURCE_URL` 设成空字符串"这个办法 —— `未设置` 与 `设成空` 在不同环境下
> 行为不一致，很容易出现"我明明关了它却还在下载"。**注意**：`OSM_AUTO_DOWNLOAD=0` 只关掉
> "下载"，卷里已经有来源包时照样会导入它；导入过程中**完全不联网**。）

### 磁盘预检（空间不够时不会写到一半才失败）

下载与导入之前会算一笔账并用中文说明：

```
源文件大小 + 入库后的库（= 源文件 × 26，PBF 实测倍数）+ 512 MB 余量（WAL / R*Tree / 临时表）
```

空间不够时**在下载第一个字节之前**就停下，并给出三条出路（扩卷 / 换分省包 / 在别处导好再拷库），
`docker compose logs` 里能看到完整中文说明。卷里已经有来源包（只需导入）时也会做一次**离线**预检
（`node tools/fetch-osm.js --check-space-for <来源包> --out <库>`），这一步不联网。

---

## 2C. 选哪个数据集：容量、耗时、内存（实测优先）

| 数据集 | 怎么下 | 源文件 | 导入后的库 | 导入耗时 | 导入峰值内存 | 磁盘要求 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **北京**（BBBike 城市包，XML） | 默认，`OSM_CITY=beijing` | 47 MB | **555 MB**（实测，2.18M 节点 / 336K way） | **约 1~2 分钟** | 93 MB | ≥ 2 GB | 老默认，只有道路没有铁路 |
| **北京**（Geofabrik 分省包，PBF） | `OSM_CITY=beijing-pbf` | 35.1 MB | **928 MB**（实测，4.83M 节点 / 519K way / 12.6K relation） | **110 秒**（元素 54s + 几何回填 55s） | 194 MB | ≥ 3 GB | 含铁路、行政边界、POI，比 BBBike 全 |
| **摩纳哥**（Geofabrik 小样本） | `OSM_CITY=monaco` | 676 KB | **11.2 MB**（实测，41.7K 节点 / 6.2K way / 348 relation） | **0.9 秒** | 60 MB | ≥ 2 GB | 用来验证解析器/导入器，别当生产数据 |
| **单个省份**（Geofabrik 分省包） | `OSM_CITY=hebei`，或任意 `https://download.geofabrik.de/asia/china/<省拼音>-latest.osm.pbf` | 河北约 190 MB | 按实测 26× 外推 **约 5 GB**（未实测） | 估计 **10~20 分钟** | 约 300 MB | ≥ 8 GB | 分省包一次覆盖多座城市，是"想要大一点但装不下全国"的正解 |
| **全国**（Geofabrik `china-latest`） | `OSM_CITY=china` | **1.49 GB**（实测 HEAD `content-length=1597185288`） | **约 25~40 GB（外推）** | **估计 1~2 小时** | 约 1 GB（外推，仍与文件大小无关） | **≥ 45 GB** | 见下面的"全国数据：先说清楚风险" |

**这张表里的数字是怎么来的**（不是猜的）：

- 北京分省包是**真跑过一遍**的：`35.1 MB → 928 MB`、`110 秒`、`峰值 RSS 194 MB`。
- 全国那份是**只下了前 24 MiB**（HTTP Range）实测出来的：这段里 **3,136,000 个节点、0 个 way**
  （PBF 是 `Sort.Type_then_ID`，节点块全在前），即 **13.1 万节点 / MiB**；全国 1.49 GB → **约 1.5~2.0 亿节点**。
  再按北京那份实测的 **约 201 字节 / 节点**（含 R\*Tree 与索引）外推 → **库 25~40 GB**；
  按北京那份的 48.7K 元素/秒 → **1~2 小时**。
- 为什么"每节点 200 字节"这么多：每条 node 除了本体，还会产生 `node_index`（R\*Tree 一行）、
  `idx_nodes_ts`（一条索引项）；再加上 `way_nodes` 与它的索引。`dbstat` 实测北京分省包：
  `nodes 197 MB + node_index 269 MB + idx_nodes_ts 117 MB + way_nodes 214 MB + ways 65 MB …`

### 全国数据：先说清楚风险（再决定要不要下）

1. **磁盘**：库 25~40 GB，加上 1.5 GB 源文件与 WAL 峰值，**请准备 ≥ 45 GB 可用空间**。
   20 GB 的便宜 VPS 装不下——硬上的结果是导入到一半 ENOSPC（下载前会预检并拦住，除非你自己 `--no-space-check`）。
2. **时间**：1~2 小时（本机 SSD 实测外推；VPS 的 CPU/IO 更慢就更久）。这期间容器**不监听 8787**，
   页面打不开。想缩短停机：先在**别的机器**上导好 `china.sqlite`，再把库拷进数据卷（传输 25~40 GB）。
3. **内存**：导入本身是流式的（峰值约 1 GB，与文件大小无关）；但**服务器运行时**会为路网、
   人口网格、车队申请更多内存——全国数据建议 **8 GB 内存**，`docker-compose.yml` 里的 `mem_limit: 3g`
   要一起调大，否则会被 OOMKilled。
4. **体验**：全国 1.5~2 亿节点，低缩放视口查询、人口网格重建（`tools/rebuild-population.js`）、
   启动时的路网重建都会显著变慢；启动的 15~20 秒很可能变成几分钟。**先想清楚玩家是不是真的需要全国**。
5. **更稳的选择**：想要"大一点"就用**分省包**（5 GB / 10~20 分钟），想要"一座城玩得细"就用
   **BBBike 城市包或 Geofabrik 分省包**。分省包列表：`https://download.geofabrik.de/asia/china.html`
   （34 个省级包，如 `china/sichuan-latest.osm.pbf`）。

### `--limit` 在全国数据上的注意事项

`tools/import-osm.js --limit N` 是"三种元素各自取前 N 个"，而 PBF 里**节点块全在 way 块之前**，
所以对全国数据用 `--limit` 冒烟测试时，要一直读到 way 那一段的第 N 个才会停（可能读掉大半个文件）。
想快速冒烟请用**分省包或城市包**。

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
3. **首次启动要下载数据并导入**（北京 47 MB / 1~2 分钟；分省 ~10 分钟；全国 1.5 GB / 1~2 小时），
   期间容器**不监听端口**；有些平台的启动探针等不了这么久。稳妥做法：先在你自己的机器上把库导好，
   直接放进持久卷（`/app/data/osm/<城市>.sqlite`），容器启动时就会跳过导入。

> 镜像里**不含数据集与玩法存档**（它们在数据卷里），所以镜像本身很小（≈100 MB），
> 推拉都很快；但也意味着"换一台服务器"时别忘了把数据卷一起搬过去。

---

## 3. 验证

```bash
# ① 进程活着、数据集载入了（这个接口不需要登录）
curl -s http://127.0.0.1:8787/api/health
# → {"ok":true,... "data":{"nodes":2181032,"ways":335686,"source":"Beijing.osm.gz","sizeBytes":555581440,...}}
#    data.source 就是"这份库是从哪个源文件导入的"（例如 china-latest.osm.pbf / hebei-latest.osm.pbf），
#    配合启动日志那行「数据集： data/osm/xxx.sqlite（节点/道路/关系）」就能确认现在跑的是哪座城。

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
| `defaultCenter` | 天安门 z16 | 新玩家初始视角。**换数据集时必须一起改**（换成河北/全国就得换成那边的中心与更低的 zoom） |
| `osmDb` | `data/osm/osm.sqlite` | 换数据集时改这里；容器里更推荐用环境变量 `OSM_DB`（见 [CITIES.md](CITIES.md)） |
| `transit.economy` | false | 打开就变成真花钱的经营模式 |

> **注意 `defaultCenter` 与 `osmDb` 是两个互不相干的字段**：只改库不改中心，新玩家会降落在旧城市的
> 坐标上（一片空白）。想"一次改对"需要 `config.json` 里加一个 `cities` 表把两者绑起来 ——
> 那是需要改 `server/**` 的改动，方案已写在 [CITIES.md](CITIES.md) 第 6 节，**本次没有动服务端代码**。
>
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
| 页面一直转圈、地图不出来 | 初始化还没完（首次 15~20 秒，导入时 1~2 分钟，全国 1~2 小时）；`curl /api/ready` 看进度。反代场景多半是 WebSocket 升级头没配 |
| **导入期间 `curl` 8787 直接拒绝连接** | 正常现象：ENTRYPOINT 里的下载/导入跑完才会执行 `CMD` 里的服务器，这期间**没有进程监听端口**。看 `docker compose logs -f` 的进度 |
| `磁盘空间不足：… 需要约 xx GB` | 下载前的预检拦住了。按提示扩卷，或换分省包（`OSM_CITY=hebei`），或在别的机器上导好库再拷进卷里。想强行跳过：`node tools/fetch-osm.js … --no-space-check`（风险自负） |
| 全国数据导入太慢/装不下 | 见 2C 的容量表：库 **25~40 GB**、1~2 小时。便宜 VPS 请改用分省包；或者"别处导好 + 拷库进卷" |
| 下载中断（网络抖动） | `tools/fetch-osm.js` 会**断点续传**（HTTP Range）并在失败后退避重试；`.part` 文件会保留，重跑同一条命令就接着下。想强制重下加 `--force` |
| 下载的 md5 对不上 | 下载器会删除 `.part` 与半成品并退出 1（实测过）。重跑一次；老是失败就检查是不是被 CDN/代理改写了响应 |
| 想换成别的城市/加城市 | 见「附录 B」与 [CITIES.md](CITIES.md) |
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

前置：装 Node 22（≥22.5），先拿数据再导入一次：

```bash
# ① 下数据（可断点续传、失败重试、自动校验 md5；也可用 --city hebei 之类走城市预设）
node tools/fetch-osm.js --url https://download.bbbike.org/osm/bbbike/Beijing/Beijing.osm.gz \
     --out data/osm/Beijing.osm.gz
# 或：node tools/fetch-osm.js --city beijing-pbf        # Geofabrik 北京分省包（PBF）

# ② 导入（.osm / .osm.gz 是 XML，.osm.pbf / .pbf 是 PBF —— 自动识别，写库与回填完全共用同一条路径）
node tools/import-osm.js --file data/osm/Beijing.osm.gz --db data/osm/osm.sqlite --force

# ③ 想确认"现在这份库里是哪座城/哪份数据"：看 meta
node -e "const {openDatabase}=require('./server/dbschema.js');const db=openDatabase('data/osm/osm.sqlite');console.log(db.prepare(\"SELECT key,value FROM meta WHERE key IN ('source_file','source_format','data_city','imported_at','counts')\").all());db.close()"
```

注意：项目所有路径都相对**项目根目录**解析（`server/index.js` 里的 `ROOT = path.resolve(__dirname, '..')`），
所以 `WorkingDirectory` 不是必须的，但数据目录要有写权限。

---

## 附录 B：换数据集 / 加城市

```bash
# ① 用城市预设（推荐）：下该城的数据 + 导进该城的库，一条命令
node tools/fetch-osm.js --city hebei                                   # 只下载
node tools/import-osm.js --file data/osm/hebei-latest.osm.pbf --city hebei --force   # 只导入
node tools/fetch-osm.js --city hebei --print-env --env-prefix CITY_    # 只打印路径/URL（容器入口就是这么用的）

# ② 不用预设：任意 Geofabrik/BBBike 数据（.osm.pbf 与 .osm.gz 都直接支持）
node tools/fetch-osm.js --url https://download.geofabrik.de/asia/china/sichuan-latest.osm.pbf \
     --out data/osm/sichuan-latest.osm.pbf
node tools/import-osm.js --file data/osm/sichuan-latest.osm.pbf --db data/osm/sichuan.sqlite --force

# ③ 以后想把石家庄/河北并进同一张图：先用导入器把它导成一个独立库，再 merge 进主库
#   （--dry-run 先看一遍会加多少、冲突多少；主库既有数据不会被覆盖）
docker compose exec osm-city node tools/merge-osm.js --src data/osm/hebei.sqlite --db data/osm/osm.sqlite --dry-run
docker compose exec osm-city node tools/merge-osm.js --src data/osm/hebei.sqlite --db data/osm/osm.sqlite

# ④ 改完一大批建筑后重算人口网格
docker compose exec osm-city node tools/rebuild-population.js --db data/osm/osm.sqlite
```

**注意**：`--force` 会清空 `nodes/ways/relations/空间索引/变更日志`（也就是**所有地图编辑**），
但**不会**动交通玩法表（公司/线路/车辆/车站）。换城市前先备份。

**"按城市切换数据集"的完整设计**（一城一库、玩法数据与城市的关系、迁移代价、对玩家的影响、
以及需要改 `server/**` 的待批清单）见 **[CITIES.md](CITIES.md)**。

---

## 附录 C：这份部署没被验证到哪一步

诚实说明：**我没有 Docker 环境**，也没有 `bash` 能用（这台机器的沙箱禁止命名管道，Git Bash 一启动就报
`couldn't create signal pipe`，WSL 未安装），所以下面这些东西**没有被真正执行过**：

- `docker build` / `docker compose up`：`Dockerfile` / `docker-compose.yml` / `docker-entrypoint.sh`
  只做了逐条核对与语法审查。
- `bash -n deploy/docker-entrypoint.sh`：**没跑成**（沙箱禁止命名管道，bash/dash 都无法启动）。
  替代措施：脚本只用了 POSIX sh 的写法（`${VAR-default}`、`case`、`[ ]`，没有 `[[` / 数组 / `local`），
  且 `--print-env` 的值全部用单引号包好（中文城市名带括号也不会把 `eval` 弄崩），并用 Node 写了一个
  结构检查（配对 `if/fi`、`case/esac`、引号、CRLF）——**这只是启发式检查，不等于语法验证**。
- 容器里"curl 不存在"的假设**不成立**：`Dockerfile` 装了 curl。即便如此，下载仍改走纯 Node 的
  `tools/fetch-osm.js`（断点续传/重试/进度/校验/磁盘预检都自己做），这样不依赖镜像里装了什么。

已经在本机**真实跑过**的部分：

| 验证项 | 结果 |
| --- | --- |
| `tools/pbf.js` 解析真实的 Geofabrik PBF | 摩纳哥 675.8 KB → 41,703 节点 / 6,248 way / 348 relation，0.10 秒 |
| 导入真实的摩纳哥 PBF | `nodes=41703 ways=6248 relations=348`，库 11.2 MB，**0.9 秒**；R\*Tree 与 bbox/length 全齐，`--force` 二次导入幂等 |
| 导入真实的北京分省 PBF（35.1 MB） | 4,828,790 节点 / 518,666 way / 12,580 relation，库 928 MB，**110 秒**，峰值 RSS 194 MB |
| 下载器断点续传 | 人为保留 300,000 字节的 `.part` → 服务器 206 续传 → 最终大小 692,040 字节与源文件逐字节一致，md5 与 Geofabrik 的 `.md5` 相符 |
| 下载器 md5 校验失败路径 | 故意给错 md5 → 退出码 1、中文报错、`.part` 与半成品被删除 |
| 下载器磁盘预检 | `--min-free-gb 99999` → 退出码 1，中文说明差多少与三条出路；**未留下任何 `.part`** |
| `--print-env`（entrypoint 靠它取城市预设） | 输出单引号包裹的 `KEY='VALUE'`，可被 `eval` 安全消费 |
| Node 侧 | `node --check` 全部改过的文件通过；`node tests/import-test.js` 82/82、`node tests/pbf-import-test.js` 149/149、`node tools/check-dom.js`、`node tools/check-load-order.js` 全绿 |
| 健康检查用的 Node 单行命令（`fetch('http://127.0.0.1:8787/api/health')`）实测返回 200、退出码 0 |
| `/api/health`、`/api/ready` 的真实响应形状；端口 200 ms 内监听、初始化 15~20 秒 |
| 项目所有路径都相对项目根解析（与工作目录无关）；`DATA_DIR` 环境变量被 `server/index.js` 读取 |
| `.dockerignore` 排除了 `data/`（约 1 GB）与 `passport/`（约 2 GB），否则构建上下文会大到离谱 |

**没有验证到的部分（重要）**：

- 全国 `china-latest.osm.pbf` **没有真正导入过**（1.5 GB 源文件 + 25~40 GB 库，本机磁盘与时间都不划算）。
  表里的全国数字是"下前 24 MiB 实测节点密度 + 北京分省包实测字节/节点"的**外推**，误差可能有 ±50%。
  第一次上全国数据请**先 `--check` 看预检**，并留足磁盘。
- 分省包（河北等）同样只有外推，没有实测。
- `docker-entrypoint.sh` 的端到端流程（容器内下载 → 导入 → 起服务）没有在容器里跑过；
  它的每一步命令都在宿主机上单独验证过。

第一次 `docker compose up -d --build` 如果报错，把 `docker compose logs` 的输出发我，我照着改。
