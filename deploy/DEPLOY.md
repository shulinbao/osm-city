# 部署到自己的服务器（Docker）

按你的选择写的：**Linux + Docker**、**数据集在构建期就算好、烘进镜像**（服务器上首次启动只做一次
拷贝，**几秒~1 分钟**；也可以一行换成分省包 / 全国包 —— 见 [2C](#2c-选哪个数据集容量耗时内存实测优先) 的容量表）、
**直接开放 `IP:8787`**。

> **这一版最大的变化**：以前"镜像里没有数据"，容器首次启动要**下载 47 MB → 导入 → 服务器再推算人口网格**，
> 在 1 GB 内存的小机器上实测导入就要 **497.9 秒**，之后那段人口推算还会把整机压到无法登录。
> 现在这些"一次性计算"全部搬到了**构建期**（`deploy/build-seed.sh`），镜像里带着一份已经算好的
> `osm.sqlite`（已含人口网格与索引）；容器首次启动**只拷贝、不计算**。
> 想回到旧行为：`OSM_SEED=0`（见 [2 节](#2-起服务首次是拷贝即用不再下载不再导入不再算人口)）。

两种部署方式，选一种就行：

| 方式 | 服务器上需要什么 | 命令 | 章节 |
| --- | --- | --- | --- |
| **A. 就地构建**（下面 1~3 节） | 源码 + 构建（**约 4~6 分钟**：构建期要下数据、导入、算人口网格） | `docker compose up -d --build` | [1](#1-把代码传上服务器) 起 |
| **B. 预构建镜像**（2B 节） | 只要镜像，不要源码 | `docker run -d … <镜像>` | [2B](#2b-方式-b先把镜像推到仓库服务器一行命令) |

想"装的时候一行命令"就用 **方式 B**：本机或 CI 构建一次推到镜像仓库（Docker Hub / GHCR / 阿里云 ACR），
服务器上 `docker run` 一行搞定；代价是多一次"构建+推送"的准备步骤，而且升级时要 `docker pull`。

---

## 0. 服务器要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 系统 | Linux x86_64 / arm64 | 任何主流发行版；镜像基于 `node:22-slim`（Debian） |
| Docker | 20.10+ 且带 compose v2 | `docker compose version` 能打出来就行 |
| 内存 | **建议 4 GB**（最低 2 GB） | 运行中 RSS 约 0.55~0.85 GB（路网 + 人口网格 + 车队都在内存里）。**新方案下首次启动不再需要导入/推算的额外内存**（那些在构建机上做完了）；只有你显式用 `OSM_SEED=0` 走旧路径时才有导入峰值（实测北京 93 MB、北京分省包 194 MB） |
| 磁盘 | **看城市**：北京 ≥ 2 GB · 分省 ≥ 6 GB · **全国 ≥ 45 GB** | 数据卷里是数据集（北京实测 **492 MB**）+ 玩家存档；**镜像本身现在也大了一圈**：多带了那份预建库（`gzip -6` 后 **158.7 MB**）⇒ **镜像实测 241.5 MB**（amd64 压缩后 16 层，其中种子库那一层 158.6 MB；CI 真构建过，见 2B 末尾与附录 C）。全国那份库按实测外推 **25~40 GB**（见 2C 的容量表） |
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

## 2. 起服务（首次是「拷贝即用」：不再下载、不再导入、不再算人口）

```bash
cd /opt/osm-city
docker compose up -d --build
docker compose logs -f          # 看它干活；看到「[init] 就绪」就是好了
```

**镜像里已经带了一份"算好的"数据集**（`/opt/osm-seed/osm.sqlite`）：它是**构建期**在构建机上跑完
「导入 → 数据库迁移 → LOD 回填 → 首次人口网格全量推算 → 建索引」之后的成品（`deploy/build-seed.sh`）。
数据卷里没有库时，容器只做一件事：**把它拷进卷里**（北京实测 492 MB）。之后服务器照旧启动，
但它**不会再推算人口网格**（库里已经有了），端口开出来就能连。

首次启动实际会看到什么（默认数据集：北京 BBBike 包）：

| 步骤 | 新方案（默认：用镜像内预建库） | 旧方案（`OSM_SEED=0`：下载 + 导入） |
| --- | --- | --- |
| 下载来源包（47 MB） | **不做** | 联网下载，几十秒~几分钟（看带宽） |
| `tools/import-osm.js` 导入 | **不做** | 实测 **497.9 秒**（1 GB VPS）／本机实测 54 秒（另一次 63 秒） |
| 数据库迁移 + LOD 回填（`ways.road_class/lod_zoom` + 部分索引） | **库里已经做好** | 服务器启动时做（本机实测 1.8 秒：回填 319,818 行 1.4 s + 两个索引 0.3 s） |
| **首次人口/岗位网格全量推算** | **库里已经算完**（`done=1`：17,065 个格子 / 10,805,312 人 / 102,955 条有贡献的地块） | 服务器启动时做（本机 20 核实测 9.9 秒；**1 GB 的机器上这一段最吃力**） |
| 把库拷进数据卷 | **492 MB**，本机实测 **0.2 秒**（D: 盘、热缓存）；容器里（overlayfs → 卷）通常几秒 | —— |
| 建铁路网 / 道路网 / 线路路径 | 本机实测 1.0 秒（内存结构，每次启动都要重建） | 同左 |
| 期间是否监听 8787 | 拷贝阶段不监听（几秒），之后**立刻就开** | 导入全程（几分钟~几小时）**不监听** |

> **⚠ 拷贝期间容器不监听 8787：** 拷贝在 `ENTRYPOINT` 里、服务器（`CMD`）还没起来，
> 所以这几秒 `curl http://IP:8787/` 会**连接被拒绝**——正常现象，不是启动失败。
> 日志会明说这次走的是哪条路（「用镜像内预建库（已含人口网格与索引）」还是「下载 + 导入」）。
> 想要"拷贝期间就能打开页面"是做不到的：数据集是服务器启动的输入，没有它 `/api/*` 只能 503。

### 这次到底走了哪条路：几个开关

`deploy/docker-entrypoint.sh` 会自己判断并打印中文说明。判据与开关：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OSM_SEED` | `auto` | `auto`：卷里没有库时用镜像内预建库（但**卷里已经有来源包**时让位给你放的文件）。<br>`1`：只要城市匹配就用预建库（连"卷里已有来源包"也让位）。<br>`0`：**完全不用**预建库，走原来的下载 + 导入 |
| `OSM_SEED_DB` | `/opt/osm-seed/osm.sqlite` | 预建库在镜像里的路径（一般不用改） |
| `OSM_SEED_CITY` | `beijing` | 预建库是哪个城市的数据集（构建时烘进去的）。**`OSM_CITY` 与它不一致时不会用预建库**，而是退回下载 + 导入 |
| `OSM_FORCE_REIMPORT` | `0` | `1` = 卷里已有库也强制**重新导入**（等于不用预建库）。换城市/换数据集时用它 |
| `OSM_AUTO_DOWNLOAD` | `1` | `0` = 缺数据时**绝不联网**、直接报错退出（只影响"下载 + 导入"那条路） |

几条容易踩的组合：

```bash
OSM_SEED=0 docker compose up -d                            # 退回旧行为：下载 47 MB + 现场导入 + 现场算人口
OSM_CITY=hebei docker compose up -d                        # 换城市：城市不匹配 ⇒ 自动走下载 + 导入（日志会说明原因）
OSM_CITY=hebei OSM_FORCE_REIMPORT=1 docker compose up -d    # 换城市时显式说明"我知道要重新导入"
```

> **卷优先（这一点最重要）**：卷里**已经有** `osm.sqlite` 时，容器**什么都不做**（除非
> `OSM_FORCE_REIMPORT=1`）——玩家的账号、编辑、存档都在这个库里，`docker compose pull && docker compose up -d`
> 更新镜像不会覆盖它。想改成用镜像里的快照：删掉卷里的库（或改名），再重启容器即可。
>
> 顺带一提：`OSM_SEED_DB` 那份预建库在**镜像里**（`/opt/osm-seed/`），不是挂载出来的卷；
> 它只读、不会被容器写坏，容器重启也不需要重新解压。

### 换数据集（一行动作）

数据集由 `OSM_CITY` 决定（注册表 `tools/cities.json`，设计见 [CITIES.md](CITIES.md)）：

```bash
# compose 里加一行 environment: OSM_CITY: "hebei"，然后
docker compose up -d --build          # 首次：下河北的包 + 导成 data/osm/hebei.sqlite

OSM_CITY=china        # 全国：1.5 GB 源文件，库 25~40 GB，导入 1~2 小时 —— 先看 2C 的表再决定
OSM_CITY=beijing-pbf  # 北京（Geofabrik 分省包，36 MB，含铁路/边界）：同城更全的来源
OSM_CITY=monaco       # 676 KB 的小样本：用来验证整条链路（几秒钟，不占磁盘）
```

> **注意**：镜像里的预建库只有**一个城市**（默认 beijing）。`OSM_CITY` 一旦与它不一致，
> 入口就会**自动退回「下载 + 导入」**并在日志里说明原因（"城市不匹配：你要的是 hebei，
> 镜像里的预建库是 beijing"）—— 也就是说换城市意味着你又要付一次导入的代价。
> 想让镜像直接带另一座城的预建库：重新构建（CI 里把 `seed_city` 填成 hebei，见 2B ①）。
>
> 想换**同一座城的新鲜数据**（比如 BBBike 更新了包）：`OSM_CITY=beijing OSM_FORCE_REIMPORT=1`
> 会强制重新下载 + 导入（快照是"构建那一刻"的，不会自己变新）。

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

> 这一节只对「下载 + 导入」那条路有意义（`OSM_SEED=0`，或者城市与镜像里的预建库不一致）。
> 走「拷贝预建库」时也会先算一次：预建库 492 MB + 64 MB 余量不够就直接用中文报错退出，
> 不会拷到一半 `ENOSPC` 留下一个坏库。

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
- **（新方案补充实测）** 用 `deploy/build-seed.sh` 从同一个 `Beijing.osm.gz` **重新导了一遍**：
  导入 **53.9 秒 → 479.0 MB**，再让服务器把人口网格算完 → **492.1 MB**
  （2,071,057 节点 / 319,818 way / 10,004 relation）。表里北京那行的 555 MB / 2.18M 节点 / 336K way
  是**老库**的数字（含此前玩出来的编辑与变更日志）；**镜像里的预建库按这份新建口径是 492 MB**。
  这张表讲的是"导入"的成本，而新方案下**这些成本都发生在构建机上**、不在你的服务器上；
  首次启动耗时见 [2 节](#2-起服务首次是拷贝即用不再下载不再导入不再算人口) 的对照表。
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
  > **这条流水线现在分两步**（见文件里的中文注释）：
  > ① 先在 runner 上用**原生 Node 22** 跑 `deploy/build-seed.sh`：下载 47 MB → 导入 → 起一次临时服务器
  > 把「迁移 + LOD 回填 + 人口网格全量推算」跑完 → 停掉 → 校验（**要求 `population_build_state.done=1`**），
  > 产物是 `deploy/seed/osm.sqlite`（几百 MB）；② 再 `docker build`，Dockerfile 的种子阶段发现这份产物
  > 就直接拷进镜像，**amd64 与 arm64 共用同一份快照**。
  > 为什么不把生成过程放进 Dockerfile 让两个架构各自算：arm64 那条腿要在 amd64 runner 上走 **QEMU 模拟**，
  > 把"导入 + 人口推算"塞进模拟环境会慢好几倍、还更容易 OOM/超时。
  > 想换种子对应的数据集：Run workflow 时把 `seed_city` 填成 `beijing-pbf` / `hebei` / `monaco` 之类
  > （默认 `beijing`），它会透传给 `--city` 与 `build-args: OSM_SEED_CITY`。
  > 预计耗时：下载几十秒（首次）+ 导入本机实测 53.9 秒 + 初始化 10.3 秒 + 两个架构的构建与推送。
  > **内存与超时**（构建期"起服务器再停掉"这件事在 CI 里可行吗？—— 本机实测可行）：
  > 临时实例**峰值 RSS 286 MB**（导入 479 MB 的库 + 建 2.07M 节点的路网 + 算 17,065 个格子），
  > runner 有 16 GB，流水线里另外给了 `NODE_OPTIONS=--max-old-space-size=4096` 当上限；
  > 等待初始化完成的上限是 30 分钟（`--timeout 1800`，判据是"就绪 + 人口网格 done=1"），
  > 这个 step 的硬超时 45 分钟、整个 job 120 分钟。
- **本机有 Docker**：`./deploy/build-push.sh docker.io/你的用户名/osm-city:2.0`
  （只推本机架构用 `PLATFORMS=linux/amd64 ./deploy/build-push.sh <tag>`，快得多）
  > 本机构建时上下文里一般**没有** `deploy/seed/osm.sqlite`，所以 Dockerfile 的种子阶段会**自己**下载 +
  > 导入 + 跑完一次性初始化（同架构构建，速度与上表实测同量级；构建时间因此从"约 1 分钟"变成 3~6 分钟）。
  > 想让本机构建也快：先 `sh deploy/build-seed.sh --out deploy/seed/osm.sqlite`（Git Bash / WSL / Linux 都行），
  > 再构建；或者干脆用 CI。
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

用 compose 的（把 `build: .` 换成 `image:` 之后）：

```bash
docker compose pull && docker compose up -d     # 拉新镜像并重启容器
```

用 `docker run` 的：

```bash
docker pull ghcr.io/你的用户名/你的仓库:latest
docker stop osm-city && docker rm osm-city
# 再跑一遍 ② 那条 run；数据在 osm-data 卷里，删容器不丢档
```

**卷优先**：新镜像里的预建库**不会**覆盖你卷里已有的 `osm.sqlite`（玩家账号/编辑/存档都在里面），
所以升级只是换代码 + 换 `/opt/osm-seed/` 那份只读快照，启动路径与原来完全一样（几秒）。

用 `:2.0` / `:sha-xxxxxxx` 这类固定 tag 部署，就随时能 `docker run` 回上一个版本。
**升级前先备份**（`docker compose exec osm-city node tools/backup-osm.js …`），因为启动时数据库会自动迁移。

### ④ 关于"平台上部署"（Railway / Render / Zeabur / Sealos / 阿里云 SAE 之类）

这些平台能吃 Dockerfile 或镜像，但有三个坑，先看清楚再上：

1. **必须挂持久卷到 `/app/data`**。多数平台默认文件系统是**临时的**：重新部署/重启一次，
   数据集和玩家存档（公司/线路/车辆/车站）就全没了。没有持久卷就别在这类平台开长期存档。
2. **内存给足 1 GB 以上**：实测运行中 RSS 0.55~0.85 GB（路网 + 人口网格 + 车队都在内存里）。
   新方案下首次启动**不再需要导入与人口推算的额外内存**，比老版本对 1 GB 的小实例友好得多。
3. **首次启动不再联网下载、也不再现场导入**（镜像里带的是构建期算好的库），
   所以启动探针只需要等"拷一次 + 建路网"（秒级~几十秒）；老版本要等下载 + 导入几分钟~几小时，
   探针经常等不了。想更稳：把库直接放进持久卷（`/app/data/osm/osm.sqlite`），容器连拷贝都跳过。

> ⚠ **镜像现在带着数据集**：里面有一份构建期算好的预建库（北京实测 492 MB，`gzip -6` 后 158.7 MB），
> 所以镜像**不再是** ≈83 MB 的"纯代码镜像"，而是**实测 241.5 MB**（amd64 压缩后、16 层，
> 其中种子库那一层 158.6 MB；CI 真构建过并推到了 GHCR，见附录 C）。推拉要多花一点时间，
> 换来的是**首次启动几秒可用**。
> 玩法存档与玩家账号仍然**只在数据卷里**，镜像里那份是只读的初始快照："换一台服务器"时别忘了把卷一起搬过去。
> 不想要这份快照：`OSM_SEED=0`（运行时不使用）—— 但它仍然在镜像里占体积，要彻底去掉得自己构建时删掉
> `COPY --from=seed` 那两行。

---

## 3. 验证

```bash
# ① 进程活着、数据集载入了（这个接口不需要登录）
curl -s http://127.0.0.1:8787/api/health
# → {"ok":true,... "data":{"nodes":2071057,"ways":319818,"source":"Beijing.osm.gz","sizeBytes":516018176,...}}
#    data.source 就是"这份库是从哪个源文件导入的"（例如 china-latest.osm.pbf / hebei-latest.osm.pbf），
#    配合启动日志那行「数据集： data/osm/xxx.sqlite（节点/道路/关系）」就能确认现在跑的是哪座城。

# ② 初始化进度（ready=true 才是真的可用）
curl -s http://127.0.0.1:8787/api/ready

# ③ 容器健康状态
docker compose ps          # STATUS 里应出现 (healthy)

# ④ 这次走的是哪条路？（入口日志里第一条中文说明就是答案）
docker compose logs osm-city | head -20
#   走预建库时：「[deploy] ✅ 用镜像内预建库（已含人口网格与索引）：/opt/osm-seed/osm.sqlite」
#                「[deploy] 校验通过：population_cells 17065 行 · ways.lod_zoom 已回填 319818 行」
#                「[deploy] 拷贝完成：…（492.0M，用时 N s）」
#   走下载+导入时：「[deploy] 这次不用镜像内预建库，走「下载 + 导入」：<原因>」
#   已有库时：    「[deploy] 已有数据集，跳过下载与导入：…」

# ⑤ 服务器是否跳过人口推算（这是"一次性计算已经烘进镜像"的直接证据）
docker compose logs osm-city | grep '\[pop\]'
#   期望看到：「[pop] 已有人口网格：10805312 人 / 0 个岗位 / 17065 格」
#   而不是：    「[pop] 首次启动：正在从 OSM 建筑/用地推算人口网格…」（那是 `OSM_SEED=0` 的路径）
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
docker compose restart                     # 重启：卷里已经有库 ⇒ 只重建路网，本机实测约 1 秒初始化
docker compose down                        # 停掉，数据卷保留
docker compose up -d                       # 再起
docker compose up -d --force-recreate      # 换了环境变量（例如 OSM_SEED/OSM_CITY）时用这个
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
| **镜像怎么变大了？**（实测 241.5 MB，而不是 ≈83 MB） | 镜像里多带了一份**构建期算好的预建库**（`/opt/osm-seed/osm.sqlite`：北京 492 MB，`gzip -6` 后 158.7 MB，镜像里那一层实测 158.6 MB）。这是为了把"下载 + 导入 + 首次人口推算"从**你的服务器**搬到**构建机**上：换来的是一次 `docker run` 几秒可用，而不是 497.9 秒导入 + 一段把小机器压死的推算。不想要：`OSM_SEED=0`（行为回到老版本），但体积还得自己改 Dockerfile 才能去掉 |
| **首次启动日志里说"城市不匹配，退回下载 + 导入"** | 镜像里的预建库只有一个城市（默认 beijing），而你设了别的 `OSM_CITY`。要么改回 `OSM_CITY=beijing`，要么重新构建一个带该城市预建库的镜像（CI 的 `seed_city` 输入） |
| **面板上的「岗位」怎么没了？** | 这个游戏没有岗位系统（NIMBY Rails 里也没有）。默认 `population.computeJobs=false`：**不算岗位**，新算出来的网格里 `population_cells.jobs` 恒 0（列保留、表结构一行没动）。岗位从来只用于界面显示、**不参与客流**（接口里 `demandModel.usesJobs=false`，客流只看人口），所以关掉之后人口 / 覆盖 / 需求 / 客流**一个数都不变**；老库里残留的历史岗位值照旧返回给接口，只是前端不再显示。想恢复计算：`config.json` 的 `population.computeJobs=true`，然后清空网格重算（`node tools/rebuild-population.js` 后重启）。想连"商业楼也算人口"（旧口径 v1，全市人口 +24.87%）就再加 `"jobsBuildingsCountAsPopulation": true` |
| **想更新地图数据（同一座城的新包）** | 预建库是**快照**，不会自己变新：`OSM_CITY=beijing OSM_FORCE_REIMPORT=1 docker compose up -d` 会强制重新下载 + 导入（旧行为），或者在别处导好库再拷进卷 |
| 端口 8787 已被占用 | 宿主机上有别的进程占用。`sudo ss -ltnp \| grep 8787` 找到并停掉，或换端口（同时改 compose 的映射） |
| 容器起来了但浏览器打不开 | 云**安全组**没放行 8787；或 `host` 被改成了 `127.0.0.1` |
| 页面一直转圈、地图不出来 | 初始化还没完（用预建库时：拷贝几秒 + 建路网约 1~20 秒；`OSM_SEED=0` 时导入 1~2 分钟、全国 1~2 小时）；`curl /api/ready` 看进度。反代场景多半是 WebSocket 升级头没配 |
| **启动时 `curl` 8787 直接拒绝连接（几秒）** | 正常现象：ENTRYPOINT 里在拷预建库（或旧路径里在下载/导入），这时还没执行 `CMD` 里的服务器，**没有进程监听端口**。看 `docker compose logs -f`：会打印这次走的是哪条路 |
| **日志出现"预建库校验失败/内容不完整"** | 入口拷完之后会开库查一次（`population_cells` 与 `ways.lod_zoom` 都不能为空），不合格就把文件删掉并退出（不会把一个坏库当"已有数据集"用下去）。重试一次；仍不行就 `OSM_SEED=0` 走下载 + 导入 |
| `磁盘空间不足：…` | 下载前的预检拦住了。按提示扩卷，或换分省包（`OSM_CITY=hebei`），或在别的机器上导好库再拷进卷里。想强行跳过：`node tools/fetch-osm.js … --no-space-check`（风险自负） |
| `要 XX MB（含 64 MB 余量），可是 /app/data 只剩 …` | 拷贝预建库前的空间预检。给卷扩空间，或者换更小的数据集（`OSM_CITY=monaco` 只有几 MB） |
| 全国数据导入太慢/装不下 | 见 2C 的容量表：库 **25~40 GB**、1~2 小时。便宜 VPS 请改用分省包；或者"别处导好 + 拷库进卷" |
| 下载中断（网络抖动） | `tools/fetch-osm.js` 会**断点续传**（HTTP Range）并在失败后退避重试；`.part` 文件会保留，重跑同一条命令就接着下。想强制重下加 `--force` |
| 下载的 md5 对不上 | 下载器会删除 `.part` 与半成品并退出 1（实测过）。重跑一次；老是失败就检查是不是被 CDN/代理改写了响应 |
| 想换成别的城市/加城市 | 见「附录 B」与 [CITIES.md](CITIES.md) |
| `/app/... entrypoint.sh: not found` 或 `\r` 相关报错 | 代码从 Windows 传来时带了 CRLF。Dockerfile 里已经 `sed -i 's/\r$//'` 兜住（`docker-entrypoint.sh` 与构建用的 `build-seed.sh` 都处理了）；若你手动挂载脚本，请先 `dos2unix deploy/docker-entrypoint.sh` |
| `Cannot find module 'node:sqlite'` | Node 太老。基础镜像固定 `node:22-slim`（需 ≥22.5）；自建镜像请用 22.x 最新版，或给命令加 `--experimental-sqlite` |
| 重启后存档没了 | 数据卷没挂上（绑错目录/用了 `down -v`）。确认 `docker compose ps` 里挂载了 `osm-data:/app/data` |
| 内存被杀（OOMKilled） | `docker inspect osm-city \| grep OOMKilled`。调高 `mem_limit` 或加内存（见「服务器要求」） |

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

诚实说明：**本机没有 Docker 环境**（`docker --version` 直接是"命令不存在"），也没有 `bash` 能用
（这台机器的沙箱禁止命名管道，Git Bash / dash 一启动就报 `couldn't create signal pipe, Win32 error 5`，
WSL 未安装）。所以"在**本机**构建镜像"这件事没做过 —— 但**镜像已经在 GitHub Actions 的 runner 上
真正构建、推送、并匿名拉取验证过了**（见下面「CI 真实构建」一节）。

本机仍然**没有执行过**的：

- `docker run` / `docker compose up`：容器确实构建出来了（CI 双架构推送成功），但"在一台机器上把容器
  跑起来、看健康检查探针怎么调度"没有在本机或 runner 上验证（runner 只构建与推送，不运行容器）。
- `docker build .`（**上下文里没有** `deploy/seed/osm.sqlite` 的那条路 = Dockerfile 自己在容器里
  下载 + 导入 + 推算人口）：CI 走的是"runner 先用原生 Node 生成种子"那条路（就是本文档推荐的路径），
  所以"容器内自算"这条分支仍然只做过逐条核对。
- `bash -n deploy/docker-entrypoint.sh` 与 `bash -n deploy/build-seed.sh`：**都没跑成**
  （沙箱禁止命名管道，bash / dash / sh 都无法启动）。替代措施：
  ① 两个脚本都只用 POSIX sh 写法（`${VAR-default}`、`case`、`[ ]`，没有 `[[` / 数组 / `local`）；
  ② 用 Node 写了个结构检查（BOM/CRLF、`if/fi` 配对、`"…"` 里再套 `"…"` 的可疑行）；
  ③ **脚本里内嵌的两个 Node 小程序被原样抽出来真跑过**（`wait-ready.mjs` / `inspect-seed.mjs`）——
  这意味着脚本里那段 JS 是对的，但**外壳（sh 的控制流）没有语法验证**。这是本次最大的未验证项。
- 容器里 `node tools/import-osm.js` / `node server/index.js` 组合**没有在容器里跑过**：
  它们在**宿主机上**用同一批 Node 命令、同样的参数（`--osm` / `--port 8799` / `--data <临时目录>`）跑过，
  但"容器里再跑一遍"这件事只能等真 Docker。

已经在本机**真实跑过**的部分：

| 验证项 | 结果 |
| --- | --- |
| **构建期种子链（`deploy/build-seed.sh` 里那条命令链，逐条在宿主机上真跑）** | 见下面单独一节 |
| `tools/pbf.js` 解析真实的 Geofabrik PBF | 摩纳哥 675.8 KB → 41,703 节点 / 6,248 way / 348 relation，0.10 秒 |
| 导入真实的摩纳哥 PBF | `nodes=41703 ways=6248 relations=348`，库 11.2 MB，**0.9 秒**；R\*Tree 与 bbox/length 全齐，`--force` 二次导入幂等 |
| 导入真实的北京分省 PBF（35.1 MB） | 4,828,790 节点 / 518,666 way / 12,580 relation，库 928 MB，**110 秒**，峰值 RSS 194 MB |
| 下载器断点续传 | 人为保留 300,000 字节的 `.part` → 服务器 206 续传 → 最终大小 692,040 字节与源文件逐字节一致，md5 与 Geofabrik 的 `.md5` 相符 |
| 下载器 md5 校验失败路径 | 故意给错 md5 → 退出码 1、中文报错、`.part` 与半成品被删除 |
| 下载器磁盘预检 | `--min-free-gb 99999` → 退出码 1，中文说明差多少与三条出路；**未留下任何 `.part`** |
| `--print-env`（entrypoint 靠它取城市预设） | 输出单引号包裹的 `KEY='VALUE'`，可被 `eval` 安全消费 |
| Node 侧 | `node --check` 全部改过的文件通过；`node tests/import-test.js` 82/82、`node tests/pbf-import-test.js` 149/149、`node tools/check-dom.js`、`node tools/check-load-order.js` 全绿 |
| 健康检查用的 Node 单行命令（`fetch('http://127.0.0.1:8787/api/health')`） | 实测返回 200、退出码 0 |
| `/api/health`、`/api/ready` 的真实响应形状 | 形状确认；端口 **139 ms** 就开（本次种子实例实测） |
| 项目所有路径都相对项目根解析（与工作目录无关） | 确认：`--osm` / `--data` 都按项目根解析，`DATA_DIR` 环境变量被 `server/index.js` 读取 |
| **入口里那段"拷完种子库之后的开库校验"（`node -e` 内联代码）** | 从 `docker-entrypoint.sh` 里**原样抽出**、对着真种子库跑：输出「校验通过：population_cells 17065 行 · ways.lod_zoom 已回填 319818 行」，退出码 0，耗时 0.12 s |
| `.dockerignore` 的规则 | 排除了 `data/`（约 1 GB）与 `passport/`（约 2 GB），并**放行** `deploy/seed/**`（CI 预生成种子的必经之路）；按"最后匹配者胜"逐条核对（**没有**运行 docker 的 matcher，因为没有 Docker） |

### 构建期种子链：本机实测（2026-09-21，Windows 10 / Node v22.22.0 / 20 核 / D: 盘）

跑的是 `deploy/build-seed.sh` 会执行的**同一条命令链**（同参数、同顺序，端口 8799、`--data` 用临时目录、
**绝不碰 `data/osm/osm.sqlite`**）；两个内嵌 Node 小程序是从脚本里原样抽出来的：

| 步骤 | 实测 |
| --- | --- |
| ① 来源包 | 复用已有的 `data/osm/Beijing.osm.gz`（49,094,438 字节，md5 计算通过；**没有**重新下载，只读使用） |
| ② `node tools/import-osm.js --file … --db <临时库> --city beijing --force --quiet` | **53.9 秒**，库 **479.0 MB**，2,071,057 节点 / 319,818 way / 10,004 relation / 2,541,654 way_nodes |
| ③ 起临时服务器（`--osm <临时库> --port 8799 --data <临时目录>`，**用仓库 config.json 原样**） | 迁移：`ways.road_class/lod_zoom` 回填 **319,818 行 / 1.43 s** + `idx_ways_lod_zoom` 0.10 s + `idx_nodes_poi_low` 0.23 s；铁路网 376 ms；**人口网格全量推算 9.9 s**（扫 317,090/317,090 条 way，102,955 条有贡献 → 10,805,312 人，分 34 批提交，让出事件循环 241 次、最长一次占住 48 ms）；服务器自报**初始化 10.3 s**；**临时实例峰值 RSS 286 MB** |
| ④ 停掉临时实例（Windows 上只能强杀）→ WAL 检查点 | 强杀后 `PRAGMA wal_checkpoint(TRUNCATE)` 返回 `busy=0 log=0 checkpointed=0`（说明数据本来就已全部落盘），`-wal` 从 50.9 MB → **0 字节** |
| ⑤ 种子库体检（`inspect-seed.mjs`） | **492.1 MB**（516,018,176 字节）· `ways.lod_zoom` 非空 **319,818 行**（= 全部）· `population_cells` **17,065 行** · `population_sources` **102,955 行** · `meta.population_model=2` · `population_build_state.done=1`、`processed=317,090/317,090` · 索引 17 个（含 `idx_ways_lod_zoom`） |
| ⑥ **用这份种子库再起一次服务器**（＝用户拿到镜像后的首次启动） | `/api/ready` **1.4 秒**就 ready（服务器自报：端口 139 ms 就开、**初始化 1039 ms**）；日志是「`[pop] 已有人口网格：10805312 人 / 0 个岗位 / 17065 格`」——**确认跳过了人口推算**；峰值 RSS 192 MB |
| ⑥b 同一步，在**改完岗位/切片那版代码**上复测（`--osm` 指向种子副本） | 第一次 HTTP 200 = **710 ms**、`ready=true` = **1.67 秒**（服务器自报：端口 150 ms 就开、初始化 **1233 ms**）；`population_cells` 17,065→17,065、`population_sources` 102,955→102,955 **一行没变**（确认没有重算）；本次最大同步停顿 732 ms（阶段 population，是**活跃度图层**那一步，不在本次改造范围内） |
| ⑦ 拷贝成本（入口要做的唯一一件事） | `cp` 492.1 MB：**0.20 秒**（宿主机 D: 盘、热缓存；容器里 overlayfs → 卷会慢一些，量级仍是秒） |
| ⑧ `gzip -6` 压缩率 | 492.1 MB → **158.7 MB（32.3%）**；**已被 CI 真实镜像层证实**：GHCR 上那一层实测 **158.6 MB** |

### CI 真实构建：GitHub Actions runner 上的实测（2026-09-21，ubuntu-latest，整个 job 4 分 29 秒）

这一节里的数字**不是估算**，是流水线日志与 GHCR 清单 API 的原始读数
（工作流 `.github/workflows/docker-publish.yml`，运行 35622662852，全程 1 次成功、0 次重试）：

| 步骤 | 实测 |
| --- | --- |
| ① 下载来源包 | 49,182,227 字节 / **5.7 秒**（BBBike 北京包，md5 `b2d631f93fccac2d03849f64e6776cea`） |
| ② 导入 | **50 秒** → 库 **503.4 MB**（runner 是 4 核；本机 20 核是 53.9 秒） |
| ③ 起临时服务器跑一次性初始化 | 端口 **73 ms** 就开 · 服务器自报初始化 **6,628 ms** · `/api/ready` 等 **9.5 秒**拿到 `ready=true` |
| ③a **人口网格全量推算（切片跑的现场证据）** | 扫 **317,516/317,516** 条带标签 way、**6.3 秒**、17,070 格、10,807,006 人 / **0 个岗位**、`done=1`。**推算期间 `/api/ready` 一路在答**，且进度是精确值：日志里连着抓到 `人口网格计算中 · 8%（24,546/317,516 地块）` → 24% → 41% → 57% → 74% → 92% |
| ④ WAL 检查点 + 体检 | 种子 **493.1 MB** · `-wal` 0 字节 · `ways.lod_zoom` 回填 320,246 行（= 全部）· 索引 17 个（含 `idx_ways_lod_zoom`） |
| ⑤ 构建并推送镜像 | `ghcr.io/shulinbao/osm-city:latest` + `sha-<commit>`，**amd64 与 arm64 一起推成功**（两个架构共用 runner 上生成的那一份种子） |
| ⑥ 镜像体积（GHCR 匿名拉取清单 API 的读数） | **241.5 MB**（amd64 压缩后、**16 层**）· 其中最大一层 **158.6 MB = 种子库层** · `latest` 清单 digest `sha256:b84026c4…` |
| ⑦ 匿名可拉取 + 镜像内环境变量 | 匿名 token 拿得到（= 服务器上不用 `docker login`）· `ENTRYPOINT=/usr/local/bin/docker-entrypoint.sh` · `OSM_SEED=auto` · `OSM_SEED_DB=/opt/osm-seed/osm.sqlite` · `OSM_SEED_CITY=beijing` · `DATA_DIR=/app/data` |

> 结论：**"把一次性计算烘进镜像"这条路在真 Docker 里走通了** —— 用户那边首次启动只需要
> `cp` 一次（本机实测 492.1 MB / 0.20 秒）再建路网，不再下载、不再导入、不再推算人口。

> 顺带说明一个**本次验证中撞到的坑**：第一次跑③时，`/api/ready` 在 5.1 秒就回了 `ready=true`，
> 但库里 `population_build_state.done` 还是 0、人口网格只算了 2% —— 因为 `index.js` 在初始化**出错**时
> 也会调 `finishInit()`，`ready=true` 并不代表算好。所以 `build-seed.sh` 的判据是
> **`ready=true` 且库里 `done=1` 且 `processed>=total`**，不合格就**失败退出**（最多重试 6 次续算），
> 绝不把一个只算了一半的库交给 Dockerfile。

**没有验证到的部分（重要）**：

- ~~镜像是怎么分层的、体积到底多大、两个架构能不能都构建成功~~ → **已经实测**（2026-09-21 首次跑通
  CI：241.5 MB / 16 层 / amd64 + arm64 都推成功 / 匿名可拉取，见上面「CI 真实构建」一节）。
  仍然没验证的是"容器真的跑起来"（`docker run` / compose / 健康检查探针的调度）。
- 全国 `china-latest.osm.pbf` **没有真正导入过**（1.5 GB 源文件 + 25~40 GB 库，本机磁盘与时间都不划算）。
  表里的全国数字是"下前 24 MiB 实测节点密度 + 北京分省包实测字节/节点"的**外推**，误差可能有 ±50%。
  第一次上全国数据请**先 `--check` 看预检**，并留足磁盘。
- 分省包（河北等）同样只有外推，没有实测。
- `docker-entrypoint.sh` 的端到端流程（容器内拷贝/下载 → 导入 → 起服务）没有在容器里跑过；
  它的每一步命令都在宿主机上单独验证过（上面的种子链 + 入口里那段 `node -e` 校验逻辑同样在宿主机上验证过）。
- 1 GB 内存 VPS 上的行为**不能**由本机（20 核、内存充足）实测推断：文里"1 GB 机器上这一段最吃力"
  依据的是用户在 1 GB VPS 上的实测（导入 497.9 秒、整机被拖到无法登录）。

第一次 `docker compose up -d --build` 如果报错，把 `docker compose logs` 的输出发我，我照着改。
