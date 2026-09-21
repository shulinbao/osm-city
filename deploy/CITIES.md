# 按城市切换数据集（设计 + 本次的最小实现）

> 结论先放最前面：**一座城市 = 一个 `.sqlite` 文件**，注册表是 `tools/cities.json`，
> 用 `--osm` / `OSM_DB`（现在）或 `config.json` 的 `cities`（待批）选库。
> 本次只做了安全的最小一步（注册表 + 下载/导入工具的 `--city` + 容器入口的 `OSM_CITY` +
> 导入时把城市写进库的 `meta`），**没有改 `server/**` 与 `public/**`** —— 需要服务端配合的
> 四处改动列在第 6 节，交给你决定。

---

## 1. 现状：先看清"数据集"和"玩法数据"是怎么绑在一起的

读代码得到的三个事实（`server/dbschema.js`、`server/index.js`）：

1. **数据集与玩法数据在同一个 sqlite 里。** `SCHEMA_SQL` 一份文件里既有 `nodes / ways / relations /
   way_nodes / relation_members / 三个 R*Tree`（地图数据），也有 `companies / stations / lines /
   vehicles / population_cells / population_sources / sim_state / changes / changesets`（玩法与历史）。
2. **用哪个库由三处决定**（`server/index.js` 的配置解析，优先级从高到低）：
   命令行 `--osm <path>` → 环境变量 `OSM_DB` → `config.json` 的 `osmDb`（默认 `data/osm/osm.sqlite`）。
3. **账号不在库里**：玩家账号/密码在 `data/users.json`（全局一份）；启动日志会打印
   `数据集： <相对路径>（节点/道路/关系）`；`GET /api/health` 返回 `data: db.info()`，其中包含
   `source`（导入时的源文件名，如 `china-latest.osm.pbf`）、`importedAt`、`bbox`、`sizeBytes`、`counts`。

于是"按城市切换"本质上就是**换一个 sqlite 文件**——难点不在代码，而在"玩法存档跟不跟着走"和
"怎么让玩家不觉得存档丢了"。

---

## 2. 数据集文件怎么组织：一城一个 `.sqlite`（推荐）

| 城市 id | 源文件 | 库文件 | 中心点 | 说明 |
| --- | --- | --- | --- | --- |
| `beijing` | `data/osm/Beijing.osm.gz`（47 MB，BBBike） | `data/osm/osm.sqlite` | 天安门 z16 | 老默认。**库名保持 `osm.sqlite` 不变**，老部署升级后行为零变化 |
| `beijing-pbf` | `data/osm/beijing-latest.osm.pbf`（36 MB，Geofabrik 分省） | `data/osm/beijing.sqlite` | 天安门 z16 | 同一座城、另一个来源（含铁路/行政边界），元素 id 与 BBBike **完全不同** |
| `hebei` | `data/osm/hebei-latest.osm.pbf`（约 190 MB） | `data/osm/hebei.sqlite` | 石家庄 z10 | 跨市的省域图 |
| `china` | `data/osm/china-latest.osm.pbf`（1.5 GB） | `data/osm/china.sqlite` | 全国 z5 | 库约 25~40 GB，见 `DEPLOY.md` 的容量表 |
| `monaco` | `data/osm/monaco-latest.osm.pbf`（676 KB） | `data/osm/monaco.sqlite` | 摩纳哥 z14 | 最小真实样本，用来验证整条链路 |

**为什么不是"一个库装多座城"**（把 `merge-osm.js` 那条路当常态）：

1. 地图侧不是不行（`tools/merge-osm.js` 就是干这个的），但**玩法与语义**会乱：`stations.node_id /
   way_id`、`lines.path` 都吸附在具体元素 id 上，多城共库时"切城市"就只是换视口，
   而玩家看到的是"同一张图的另一块"，不是"另一座城"；
2. 玩法表没有"城市"列，一个玩家的公司在两座城之间没有归属概念，要共用就必须给
   `companies / stations / lines / vehicles / population_cells` 全部加 `city` 列并回填（见第 4 节）；
3. 一份库重导入/损坏时，多城共库会把所有城一起赔进去；一城一库时只影响一座城。

所以：**库文件名 = 城市 id**，并在库里写 `meta.data_city`（本次已实现），让任何一次报告都能对上。

---

## 3. 怎么选"当前城市"

优先级（与现有配置解析一致，从高到低）：

```bash
# ① 命令行（最明确，推荐用于临时切换/排查）
node server/index.js --osm data/osm/hebei.sqlite

# ② 环境变量（容器里最方便）
docker run -e OSM_DB=/app/data/osm/hebei.sqlite ...

# ③ config.json（待批：见第 6 节）
{ "city": "hebei",
  "cities": { "hebei": { "db": "data/osm/hebei.sqlite", "name": "河北", "center": {...} } } }
```

⚠ **现状的坑**：`config.json` 现在只有 `osmDb` 与 `defaultCenter` 两个**互不相干**的字段。
切城市时如果只改了 `osmDb`（把库换成河北）而忘了改 `defaultCenter`（新玩家仍然降落在天安门 z16），
页面会打开在一块空白区域——这不算 bug，但很容易被当成 bug。这正是建议加 `cities`（城市 → {库, 中心}
一次配好）的理由。

---

## 4. 玩法数据与城市：绑定关系与迁移代价

| 玩法表 | 与城市的关系 | 切库后的状态 |
| --- | --- | --- |
| `companies` | 只属于"当前库" | 看不到老城市的公司（老库还在） |
| `stations` | `lat/lon` + `node_id`（吸附的轨道节点） | 坐标可能在新城市界外；`node_id` 在新库里**多半不存在或指向别处** |
| `lines` | `stops`（车站 id）+ `path`（沿轨道的 node 序列）+ `path_len` | `path` 必须整条重算，否则线路没有几何 |
| `vehicles` | 挂在 `line_id` 上 | 随线路一起失效 |
| `population_cells` | 由**该城市的建筑/用地**算出（`tools/rebuild-population.js`） | 必须为新库重算，否则客流全错 |
| `changes/changesets`（编辑历史/回滚） | 元素 id 属于旧库 | 回滚老库的历史对新库无意义 |
| `data/users.json` | **全局，不在库里** | 账号/密码/昵称不变，换库后照样能登录 |

**把一家公司从 A 城搬到 B 城的代价**（三件事，每件都有失败模式）：

1. 车站重新吸附：按坐标在新库里找最近的轨道节点/way（找不到 → 这个站只能删或降级成"无轨道站"）；
2. 线路 `path` 全部重算：调用 railgraph 在新库上寻路，任何两站之间不通就写进 `path_error`；
3. 车站坐标要在新城市范围内（北京 → 摩纳哥基本全在界外，只能整条线路作废）。

结论：**本次不做自动迁移**。要搬就得写一次性脚本（导出旧库玩法表 → 清空 → 按新库重吸附 + 重寻路），
属于后续工作；在此之前，切城市对玩家而言就是"换一份存档"。

---

## 5. 对玩家意味着什么（存档跟不跟着走）

- **切城市 = 换地图 + 换经济存档。** 老城市的库不会被动（`data/osm/<old>.sqlite` 还在），
  把 `OSM_DB` 指回去，公司/线路/车辆/车站就都回来了。
- **账号跟着走**（`users.json` 全局），**资产不跟着走**（在库里）。
- **必须公告**，否则玩家会以为存档丢了：切城市时页面至少要能看到"当前城市：河北"。
  服务端启动日志与 `GET /api/health` 已经能认出"哪一份数据"（路径 + 源文件名 + 元素数量），
  但**明确的城市名**需要服务端配合（第 6 节第 3、4 条）。
- 同一座城的两个来源（BBBike 北京 vs Geofabrik 北京分省包）算**两座城**：元素 id 体系完全不同，
  玩法数据互不通用。

---

## 6. 本次已实现（安全的最小一步）与"待批"清单

### 已实现（全部在 `tools/**` 与 `deploy/**`，没碰 `server/**`、`public/**`）

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 城市注册表 | `tools/cities.json` | URL / 来源包 / 库路径 / 中心点 / 容量与耗时预估，**唯一出处**（放 `tools/` 是因为 Dockerfile 只 `COPY tools/`，放 `deploy/` 容器里就没有这个文件） |
| 下载器按城市下载 | `tools/fetch-osm.js --city <id>` | 解析注册表 → 决定 URL 与落盘路径；`--print-env --env-prefix CITY_` 输出 shell 可 `eval` 的键值（值已用单引号包好，中文名带括号也不会把 `eval` 弄崩） |
| 导入器按城市选库 | `tools/import-osm.js --city <id>` | 没给 `--db` 时用注册表里的库路径；并把 `data_city / data_city_name / default_center` 写进库的 `meta` |
| 容器入口按城市选数据集 | `deploy/docker-entrypoint.sh` | `OSM_CITY=hebei` 一行 = 下该城的数据 + 导进该城的库；日志如实打印城市、库路径、来源 URL、预计耗时与容量 |
| 如实报告当前数据集 | 已有 + 本次补强 | 服务端启动日志本来就打印 `数据集： <库路径>（节点/道路/关系）`；`/api/health` 的 `data.source` 现在会是 `hebei-latest.osm.pbf` 这种**能认出城市来源**的源文件名；库里另有 `meta.data_city` 可查 |

### 待批（需要动 `server/**` 或 `public/**`，按纪律我没有改）

1. `config.json`：加 `"city": "beijing"` 与 `"cities": { "<id>": { "db", "name", "center" } }`。
2. `server/index.js`（配置解析，约 88~90 行）：读 `cfg.city` → 用它解出 `osmDb` 与 `defaultCenter`
   （保证"库"和"初始视角"不会各改一半）。
3. `GET /api/health`（约 1249~1256 行）：`data` 里加 `city`（来自 `meta.data_city`）与 `sourceFile`，
   这样运维一条命令就能确认"现在跑的是哪座城"。
4. `GET /api/meta` + 前端（`public/js/ui.js` / `main.js`）：把当前城市显示出来（登录时的提示或角标），
   避免切城市后被当成"存档丢了"。

（第 3、4 条也可以由 `server/osmdb.js` 的 `info()` 一次性带出来：`data_city` 已经在库里了。）

---

## 7. 风险与回滚

| 风险 | 表现 | 处理 |
| --- | --- | --- |
| 库与中心点不一致 | 页面打开是空白区域 | 用 `--osm`/`OSM_DB` 明确选库；待批的第 2 条能让二者绑定 |
| `OSM_FORCE_REIMPORT=1` 清掉地图编辑 | `--force` 会清空 `nodes/ways/relations/索引/changes`（**不动玩法表**） | 切城市/重导入前先 `node tools/backup-osm.js --db <库> --out <备份>` |
| 玩家以为存档丢了 | 抱怨"我的线路没了" | 公告 + 待批第 4 条的城市显示；老库一直在，指回去资产就回来 |
| 磁盘不够（全国） | 写到一半 ENOSPC | 下载前有磁盘预检（`tools/fetch-osm.js`），容量表见 `DEPLOY.md`；全国库 25~40 GB，多数便宜 VPS 装不下，改分省包 |
| 回滚 | 想回到上一座城 | 把 `OSM_DB`/`--osm` 指回老库即可；老库没被删，也没有被迁移过 |
