# 🗺️ OSM 城市在线 —— 多人在线 OSM 地图编辑器

**服务器自己持有一套真实的 OpenStreetMap 数据集**（默认导入北京），所有玩家登录后看到的是同一份 OSM 矢量数据，可以**实时协作修改地图上的一切**：道路、建筑、用地、水系、POI、关系……改完之后可以导出标准 `.osm` / `.osmChange` 文件。

- 数据来源：`Beijing.osm.gz`（BBBike 城市提取包）→ 导入服务器本地 SQLite（**207 万节点 / 32 万道路 / 1 万关系 / 478 MB**）
- 存储引擎：Node 22 内置 `node:sqlite`（含 R\*Tree 空间索引），**零第三方依赖**（没有 npm 包，没有网络依赖）
- 渲染：不用瓦片，自己用 canvas 画矢量底图（819 条 OSM Carto 风格样式规则 + 2.5D 建筑挤出）
- **不会写入 OpenStreetMap 官方数据库**，也不需要 OAuth：这是一份本地镜像，改动只落在你自己的服务器上

```
node server/index.js          # 启动（默认 8787）
# 浏览器打开 http://127.0.0.1:8787/ ，**注册一个账号或登录已有账号**即可开始编辑
# （游客登录默认关闭，见下面的「配置」里的 allowGuests）
```

---

## 📦 快速开始

要求 **Node.js ≥ 22.5**（用到内置 `node:sqlite`），无需 `npm install`。

```bash
# 1) 下载 OSM 数据（北京，46.8 MB；已下载过可跳过）
#    来源：https://download.bbbike.org/osm/bbbike/Beijing/Beijing.osm.gz
node tools/fetch-osm.js --city beijing      # 断点续传 + .md5 校验 + 下载前磁盘预检（也可以自己下）
#    可用的数据集预设：beijing / beijing-pbf / hebei / china / monaco（见 tools/cities.json）
#    node tools/fetch-osm.js --city hebei --print-env    # 只打印它会用的 URL/库/容量预估，不下载

# 2) 导入数据集（北京约 1 分钟；给了 --city 就不用再给 --db，它会自己决定库路径）
node tools/import-osm.js --city beijing --force

#    也直接支持 Geofabrik 的 **.osm.pbf**（按魔数识别格式，不需要先转 XML）：
#    node tools/import-osm.js --file data/osm/hebei-latest.osm.pbf --db data/osm/osm.sqlite --force
#    ⚠ 全国包（china-latest.osm.pbf，1.5 GB）导出来的库**不是几 GB**：实测外推约 **25~40 GB**、
#      导入 1~2 小时、需要 ≥45 GB 可用磁盘（见 deploy/DEPLOY.md §2C 的容量表）。单机玩请用**分省包**；
#      另外 `--limit` 在全国包上基本没用（PBF 把节点排在最前面，要读到 way 段才停）。

# 3) 启动服务器
node server/index.js

# 4) 浏览器打开 http://127.0.0.1:8787/
#    首次进入点「注册新账号」建一个账号（昵称 + 至少 4 位密码），之后用同一个账号登录
#    局域网协作：把启动日志里的 http://<内网IP>:8787/ 发给同事/朋友
```

Windows 可以直接双击 `start.cmd`。

**部署到自己的服务器**（Linux + Docker，含数据导入、备份、更新、HTTPS 反代与安全注意事项）：
见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md) —— 一条命令起步：`docker compose up -d --build`。

> **账号**：服务器默认**不接受游客**（`allowGuests: false`）—— 页面上没有「以游客身份先上任」按钮，
> `?guest=1` 也不会自动登录，`POST /api/guest` 一律回
> `403 {"error":"本服务器已关闭游客登录，请注册账号或使用已有账号登录"}`。
> 想临时放开（本地开发 / 测试）用 `node server/index.js --allow-guests`、`DSH_ALLOW_GUESTS=1`
> 或把 `config.json` 的 `allowGuests` 改成 `true`（详见下面「配置」）。

---

## 🎮 能改什么

| 工具 | 快捷键 | 说明 |
| --- | --- | --- |
| 🔍 选择 | `1` | 点选道路/区域/POI，右侧面板查看并编辑它的**全部 OSM 标签**；同一位置重复点击可切换重叠元素 |
| ⬦ 节点 | `2` | 拖动节点改变形状（`Shift` 拖动整条路平移）；点击线段中点插入节点；`Alt`+点击删除节点 |
| 📍 加点 | `3` | 新建点要素（POI），可先从预设里选类型（159 个预设） |
| 📏 画线 | `4` | 依次点击画线，双击/`Enter` 结束，`Backspace` 退格，`Esc` 取消 |
| ⬛ 画面 | `5` | 画闭合区域（建筑、用地、水面……），自动首尾共用节点 |
| ✂️ 分割 | `6` | 在节点处把一条道路一分为二 |
| 🔗 合并 | `7` | 把端点相连的两条道路合并成一条 |
| ⊙ 合点 | `8` | 把两个节点合并成一个（修复断开的道路） |
| 🗑️ 删除 | `9` | 删除元素；被道路引用的节点会询问是否**级联删除** |
| 📐 矩形化 | `0` | 把建筑轮廓整理成直角矩形（以最长边为主轴） |
| ⧉ 复制 | — | 复制一份并偏移约 8 米 |

**其它能力**
- **标签编辑**：右侧检查器直接增删改 key/value，写入前做完整校验（数量、key 合法性、值长度），冲突会明确提示
- **关系**：`type=multipolygon` 关系会按外环填充 + 内环挖洞渲染；可新建关系、改成员角色
- **搜索**：`Ctrl+F`，支持「按名称」（天安门）、`key=value`（amenity=restaurant）、按 key（building）
- **图层开关**：12 个分类（道路/铁路/步道/建筑/用地/水系/边界/电力/围栏/POI/公交/其它），实时隐藏显示
- **撤销/重做**：`Ctrl+Z` / `Ctrl+Y`，批量操作（例如整体平移一条路）算作一步，每人最多 100 步
- **元素锁**：你选中的元素会被软锁（120 秒 TTL），别人改不动，避免两人同时改一条路；右下角能看到谁锁了什么
- **实时协作**：协作者光标、当前正在编辑的元素（`正在编辑 #12345`）、聊天频道
- **编辑历史**：每次会话是一个变更集，可查看、**下载 osmChange**、**回滚**（默认只能回滚自己的，`allowAnyRollback` 可放开）
- **导出**：当前视野 / 全部数据 → 标准 `.osm` XML，可直接导入 JOSM / iD
- **显示分级**：低缩放下发概略要素，高缩放才给细节（服务端按 zoom 过滤），保证大范围浏览不卡

---

## 🏗 架构

```
浏览器
 ├─ Leaflet（本地内置，只当几何/交互引擎，不用瓦片底图）
 ├─ world.js      客户端 OSM 数据模型（nodes/ways/relations 三张 Map，增量合并服务器操作）
 ├─ mapdata.js    视口取数（按当前缩放拉 bbox，缓存已取范围）
 ├─ render.js     矢量渲染：面/线分图层画在 4 张 canvas 上，标签/POI/光标/选中/锁画在第 5 张覆盖画布
 ├─ style.js      819 条 OSM Carto 风格规则（ruleFor / labelFor / categoryOf）
 ├─ presets.js    159 个新建要素预设（中文名 + 真实 OSM 标签）
 ├─ editor.js     11 个编辑工具 + 节点拖拽 + 绘制预览
 ├─ inspector.js  OSM 标签表格编辑器、预设、关系、元素历史
 └─ ui.js/main.js 面板、搜索、导出、历史、图层、聊天、状态栏

     ⇅ WebSocket（操作请求/广播、元素锁、光标、聊天）
        HTTP（/api/map 视口数据、/api/element、/api/search、/api/export、/api/history）

服务器（Node，零依赖）
 ├─ server/index.js     路由、鉴权、WebSocket 会话、在线状态
 ├─ server/websocket.js 自研 RFC6455 WebSocket 服务器
 ├─ server/auth.js      账号（scrypt 哈希 + token 会话 + 游客，游客默认关闭）
 ├─ server/osmdb.js     SQLite 数据访问：视口查询、元素读写、R\*Tree 索引维护、变更日志、导出
 ├─ server/osmops.js    编辑操作层：几何/标签/引用完整性/版本冲突校验、元素锁、撤销栈、变更集
 └─ server/dbschema.js  表结构（唯一权威定义，导入器与服务端共用）

SQLite（data/osm/osm.sqlite）
 nodes / ways / way_nodes / relations / relation_members
 node_index / way_index / relation_index（R\*Tree 空间索引）
 changesets / changes（编辑历史与回滚）
```

**关键设计**
- **服务端权威**：所有编辑都在服务端校验后落库，再广播给其他玩家；客户端只做乐观预览
- **版本冲突检测**：改标签等操作必须带 `version`，版本不符直接拒绝并提示是谁改的（OSM 语义）
- **撤销 = 快照还原**：每次操作记录反向步骤（恢复哪个元素的哪个快照），撤销/重做天然对称，且能还原被级联删除的节点
- **引用完整性**：删除被引用的节点会被拒绝（除非显式级联），删除道路会回收只属于它的孤立节点
- **视口查询**：R\*Tree 范围查询 + 按显示分级过滤 + 批量取节点几何（避免 N+1 查询），单次请求 < 800 ms / < 8 MB

---

## 🚈 交通经营玩法（NIMBY Rails 风格）

在真实的北京地图上开一家交通公司：铺轨、设站、开线、买车，靠客流和票价赚钱。

| 模块 | 说明 |
| --- | --- |
| 双路网 | 铁路网（`railway=*`，4491 条 / 3.4 万节点，280 ms 建图）与**公交道路网**（`highway=*`，91,245 条 / 52.9 万段 / 47.7 万节点，3.6 s 建图，按需构建） |
| 寻路 | Dijkstra，权重用"时间"而非距离，限速取真实 `maxspeed`（铁路 15~160 km/h、道路按等级 12~120 km/h），站场/专用线排除 |
| 人口系统 | 从真实建筑推算：占地面积 × 楼层 × 密度 → 人口；商业/办公用地 → 岗位。全北京 **1693 万人 / 483 万岗位**，250 米网格 3.2 万格。改一栋楼只重算它覆盖的格子（增量） |
| 车站 | 吸附到最近路网节点（铁路 120 m／公交 60 m），带站台长度与吸引半径，实时显示覆盖人口/岗位 |
| 线路 | 站点序列 → 沿真实路网自动寻路，给出里程/单程时间/潜在日客流；不连通会指明哪一段不通 |
| 车辆 | 车厢数/定员/最高速度，服务端权威模拟：按限速加减速、进站停靠 30 秒、先下后上、按里程计价（3 元 + 0.5 元/公里）、每节每天 2 万维护费 |
| 游戏时钟 | 暂停 / ×1 / ×5 / ×20（1 实时秒 = 1 游戏分钟），服务器统一推进，所有玩家同一时刻 |
| 公司 | 每人一家，起步 2 亿；车站 3000 万（公交站 250 万）、列车 2000 万 + 每节 500 万 |

```
# 协议级测试（用真实数据副本，不动你的数据集）
node tests/transit-e2e.js        # 29 项：公司/车站(铁路+公交)/寻路/车辆/时钟/模拟/权限/重启持久化
# 冒烟脚本：在真实铁路上建站开线跑车，跑完自动清理
node tools/smoke-transit.js
```

## 🧪 测试

```bash
npm run check            # 静态自检：DOM id 完整性 + 前端脚本加载顺序
npm run test:import      # 导入器：82 项断言（含 visible=false 跳过、bbox/length 回填、rtree 索引、--force/--limit）
npm run test:style       # 样式表与预设：133 项断言（819 条规则字段合法性、186 个标签取值可达性）
npm test                 # 协议级端到端：77 项（视口分级、编辑、冲突、元素锁、撤销重做、回滚、导出、重启持久化、限流，含"默认配置下游客登录已关闭"）
npm run test:browser     # 浏览器端到端：28 项（CDP 驱动真实界面：选中真实建筑→改标签→画面→Ctrl+Z→搜索→导出→图层→缩放）
npm run test:boot       # 启动健壮性：18 项（历史残留/脏 localStorage 不能让页面卡死，含游客登录全流程）
node tools/check-screenshot.js tests/screenshot.png   # 截图像素自检（含文字版画面预览）
```

`npm run test:browser` 需要本机有 Edge 或 Chrome；它会自己截图到 `tests/screenshot.png`，并在结束时**回滚自己产生的改动**（不污染数据集）。

> **测试与游客开关**：正式服务器默认不收游客（`allowGuests: false`），而
> `tests/transit-e2e.js`（临时数据集副本）、`tests/browser-osm-e2e.js` 与 `tests/browser-boot-e2e.js`
> 全程靠 `?guest=1` 免注册登录。这几个套件**各自拉起一台测试实例并加 `--allow-guests`**：
> transit-e2e 用 `tests/tmp-transit` 的副本（端口 8903）；
> 两个浏览器套件（端口 8911 / 8912）**不需要你先把服务器跑起来**，自己起来、跑完自己关掉，
> 数据集仍是默认的 `data/osm/osm.sqlite`，而临时游客账号写在 `tests/tmp-browser-osm/`、
> `tests/tmp-browser-boot/` 里（`--data`），不会往正式的 `data/users.json` 里灌游客。
> 想指向已经在跑的那台就设 `BASE=http://127.0.0.1:8787`
> —— 但**那台必须允许游客**（`--allow-guests` / `DSH_ALLOW_GUESTS=1` / `config.json` `allowGuests: true`），
> 否则套件里的游客登录会拿到 403。同理想换端口用 `E2E_PORT=…`。

> 协议级测试使用临时数据集（从 `tests/fixtures/tiny.osm` 导入），不会碰你的 `data/osm/osm.sqlite`。

### 实测数字（北京全量数据）

| 环节 | 结果 |
| --- | --- |
| 导入 | 207 万节点 / 32 万道路 / 1 万关系，**60 秒**，峰值内存 214 MB，库 478 MB |
| 视口查询 | z16 中心城区：13,411 条道路 / 79,596 节点，SQL 523 ms，传输 8.5 MB（已按 1e-7 度精度压缩坐标） |
| 渲染 | 视口内 2,817 个要素 + 141 个标签，**101 ms** |
| 浏览器操作链路 | 25/25 通过，无脚本错误 |

**低缩放视图载荷**（z ≤ 14，合并生效的那一档；1400×900 + pad 0.05 一屏整框，真实 HTTP 实测）。
这一档客户端**只看不改**，所以服务端连"面"的几何也只发"画得出来的紧凑几何"（`displayAreas`），
原始 way 几何与节点坐标不下发：

| 缩放 | 改前 | 改后 | 变化 | 主要贡献 |
| --- | --- | --- | --- | --- |
| z9 | 2405 KB | **916 KB** | −62% | 水面环 + 面关系成员改走 displayAreas（10.4 万节点坐标不再下发） |
| z10 | 2476 KB | **1009 KB** | −59% | 同上 |
| z11 | 2451 KB | **1043 KB** | −57% | 同上 |
| z12 | 1804 KB | **917 KB** | −49% | 同上 |
| z13 | 1470 KB | **860 KB** | −41% | 同上 |
| z14 | 693 KB | **453 KB** | −35% | 同上 |
| z15 | 622 KB | **408 KB** | −34% | 同上（**这一档现在不适用了**：边界改为 z ≤ 14 后，z15 变成完整可编辑档 —— 见下表） |
| z16（编辑档） | 1402 KB | 1402 KB | 0% | 编辑档一条都不省：真 way id + 全量几何 |
| z4–z8（全国/省级尺度） | 11–363 KB | 11–363 KB | ≈0% | 这一档本来就只有行政边界/地名（见下） |

**边界改动（"只看不改"从 z `< 16` 收到 z ≤ 14，即 `VIEW_ONLY_MAX_ZOOM = 14`）**：
`z ≤ 14` 仍是视图载荷（`displayLines` / `displayAreas` 都没有 way id → 点不中、改不了），
**`z15` 起是真 way id + 真实几何的完整可编辑档**。同一数据集 + 同一屏实测（1400×900 pad 0.05）：

| 缩放 | payload | ways | displayLines | displayAreas | 点选/编辑 | complete |
| --- | --- | --- | --- | --- | --- | --- |
| z13 | 861 KB | 0 | 954 | 1283 | ❌ 只看不改 | true（`stopReason=exhausted` · dropped 0） |
| z14 | 453 KB | 213 | 641 | 380 | ❌ 只看不改 | true（同上） |
| z15 | 873 KB | 2631 | 0 | 0 | ✅ 有 way id，可点选/编辑 | true（同上） |

（改前 z15 是 408 KB / 338 way / 365 折线 / 277 面、只看不改；改动后 z13、z14 一个字节都没变。）

逃逸阀：`/api/map?detail=0`（或 `1`，客户端「完整 / 全部道路」档）时**折线合并与视图载荷一起关掉**，
真 way id + 全量几何 + 节点坐标照旧下发（z10 实测 5013 KB，超上限时如实报 `truncated`，客户端拆块）——
低缩放也能编辑。`&view=0` 是更窄的一档：只关掉"面几何的压缩"，保留 LOD 与折线合并（z10 = 2476 KB）。

> 目前**浏览器客户端不带 `detail` 请求参数**（这一轮之前就是这样）：UI 里的详细度档位只在客户端生效。
> 要让「完整 / 全部道路」档也向服务端要全量数据，在 `public/js/mapdata.js` 的 `_fetch` 里给
> `/api/map?...` 补一个 `&detail=${Render.detail}` 即可（代价见上一段）。

---

## ⚙️ 配置（`config.json`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` / `host` | 8787 / `0.0.0.0` | 监听端口与地址（`0.0.0.0` 表示局域网可访问） |
| `dataDir` | `data` | 账号等数据目录 |
| `osmDb` | `data/osm/osm.sqlite` | 本地 OSM 数据集路径 |
| `defaultCenter` | 天安门 `39.9042, 116.4074, z16` | 新玩家初始视角 |
| `maxPlayers` | 64 | 同时在线上限 |
| `allowAnyRollback` | false | 是否允许回滚**别人**的变更集 |
| `allowGuests` | **false** | 是否允许**游客登录**（免注册）。关闭时：`POST /api/guest` → `403`＋中文提示、`Auth.guest()` 直接拒绝、WebSocket `?guest=1` 在握手阶段就被 403；页面上「以游客身份先上任」按钮藏起来，`?guest=1` 不再自动登录，注册/登录照旧可用。开启方式（优先级 命令行 > 环境变量 > config.json）：`--allow-guests` / `DSH_ALLOW_GUESTS=1` / `"allowGuests": true`；反向开关 `--no-guests`、`--allow-guests=false`。服务器的**默认值就是 false**，即使 config.json 里没写这一项也照样关着 |
| `limits.viewportLimit` | 15000 | 单次视口查询最多下发多少条道路/区域 |
| `limits.coalesce.minZoom` | 15 | z < 这个值时进"只看不改"的低缩放档（也就是 **z ≤ 14**）：折线合并成 `displayLines`、面合并成 `displayAreas`（都没有 way id） |
| `limits.opsPer10s` | 120 | 每人 10 秒内操作上限（超出会被限流） |

---

## ⚠️ 说明与限制

- **这是本地镜像编辑器，不是 OSM 上传工具。** 改动只写进你自己的 `data/osm/osm.sqlite`；想同步到 OpenStreetMap 官方数据库需要另行接入 OSM API + OAuth2（并且需要遵守社区规范，批量/自动化编辑会被要求先与社区沟通）。
- **数据现实**：OSM 中国境内数据密度不均；中国境内公开地图服务另有 GCJ-02 偏移的法规要求，这里展示与编辑的都是 OSM 原始的 WGS-84 坐标。
- **并发模型**：服务端权威 + 元素级软锁 + 版本校验，不做 OT/CRDT。极端情况下（两人先后改同一元素的同一字段）后提交者会收到冲突提示并需要重新加载，而不是静默覆盖。
- **撤销栈在内存里**：每人最近 100 步，服务器重启后清空；要长期追溯请用「编辑历史」里的变更集回滚。
- **街道级道路/建筑只在较高缩放可见**（分级显示），这是刻意的性能取舍；想一次拉全量请把 `viewportLimit` 调大并配合更大的缩放。
- **低缩放（z ≤ `limits.coalesce.minZoom − 1`，默认 ≤ 14）是"只看不改"的档**：这一档服务端把线和面都压成没有 way id 的紧凑几何（`displayLines` / `displayAreas`，坐标按该缩放的 1 像素简化 + 量化），所以低缩放**点不中、也改不了**具体要素 —— 拾取与编辑从 **z15** 起完整可用（z15 一条都不合并）。边界常量是 `server/osmdb.js` 的 `VIEW_ONLY_MAX_ZOOM = 14`，客户端只认服务端回显（`limits.coalesce` 与 `truncation.viewOnly.minZoom/maxZoom`），两侧不会各说一个数。想在这一档拿全量数据（含几何）就带 `detail=0`。
- **想在全国尺度也看见路网**：默认地板是 z9 起发主干道、z6 起发省级行政边界，所以 z4–z8 的响应几乎是空的（实测 11–363 KB）。把 `limits.roadClassFloor` 调低（例如 `{"trunk":5,"secondary":7}`）就能让全国尺度也有路网，但**记得重跑一次回填**（`ways.lod_zoom` 是按地板物化的，地板调早之后低缩放候选扫描会退回 R\*Tree，实测 z4–z8 一个视口 2.2–2.9 s；回填后回到索引路径）。
- `legacy/` 目录里是第一版（在 OSM 底图上叠一层自建城市的合作建造游戏）的代码，已不参与运行，保留仅作参考。

## 🛠 可以继续做的方向

- 把视口数据换成**二进制矢量瓦片**（坐标增量编码），传输体积可再降约 10 倍
- **低缩放 payload 的下一块肥肉是 `displayLines` 的 JSON 结构开销**：z10 那一屏 753 KB 里，
  坐标点本身只占约 330 KB，其余约 420 KB 是"条目标签 + 一万多条 `paths` 小数组"的括号与键名
  （11626 段 / 25554 点，平均一段 2.2 个点）。把 `coords` + `paths` 摊平成一个数组 + 段长表，
  按实测大约能再省 200 KB/屏（约 −20%），这一改动纯属编码、不碰语义。
- 接入 OSM API + OAuth2，把「变更集」真正提交到 OpenStreetMap（带人工确认与冲突解决）
- ~~导入 Geofabrik 全国数据（1.5 GB PBF，需要补一个 PBF 解析器）、按城市切换数据集~~ —— **已做**：
  零依赖 PBF 解析器（`tools/pbf.js`）+ 导入器支持 `.osm.pbf`（`tools/import-osm.js`）
  + 服务端自下载（`tools/fetch-osm.js`，断点续传/校验/磁盘预检）
  + 城市注册表与 `--city`（`tools/cities.json`）；设计与"还差哪几处 `server/**` 改动"见 `deploy/CITIES.md`。
  注意**全国库实测外推 25~40 GB**（不是几 GB），单机请用分省包。
- 更完整的 OSM 语义：完善的 relation 编辑（route/边界）、`area` 判定、历史版本浏览与回滚单条改动
- 移动端触控编辑、离线编辑队列、审阅模式（改动先进入待审列表再合并）
