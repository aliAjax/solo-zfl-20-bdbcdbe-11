# 古籍拓片缺损修补档案 API

零依赖 Node 服务，统一管理**拓片、缺损项、修补批次**三类档案，并提供一个统一检索入口。
数据以「内存数据集 + append-only WAL + 快照」持久化，支持崩溃恢复、在线索引重建与会话式稳定分页。

## 启动

```bash
# 默认端口 3020，数据目录 ./data
node server.js

# 自定义
PORT=3020 DATA_DIR=/var/lib/rubbing node server.js
```

要求 Node.js ≥ 18（使用内置 `fetch` 仅测试需要）。首次启动若发现旧版 `data/db.json`，
会自动迁移为 `snapshot.json` + `wal.log`，**原有接口路径与响应结构完全不变**。

## 十万级性能数据

在 10 万条档案（拓片 3.3 万 / 缺损 5.8 万 / 批次 0.8 万）上实测：

| 查询 | 命中量 | 耗时 |
| --- | --- | --- |
| 自由词 `虫蛀孔` | 7 447 | ~100 ms |
| 自由词 `TP-清`（拉丁+汉字分段 AND） | 12 821 | ~160 ms |
| 错一个字 `蟲柱孔` | 7 447 | ~100 ms |
| 病害类型 `撕裂` | 14 584 | ~50 ms |
| 类型 + 一年时间范围 | 数千 | ~50 ms |
| 无查询词首页（pageSize=20） | 总量 10 万 | ~140 ms |

均为 HTTP 端到端、单次查询 1 秒内返回。生成压测数据：

```bash
node scripts/seed.js --count=100000 --wipe          # 写入 ./data-perf 并建索引
DATA_DIR=./data-perf PORT=3021 node server.js        # 用大数据集启动
```

## 统一检索

三类档案（拓片、缺损项、修补批次）从**同一个入口**查询：

```
GET /search
```

### 查询参数（可任意组合，条件之间为 AND）

| 参数 | 含义 | 示例 |
| --- | --- | --- |
| `q` | 自由关键词，匹配编号/来源/病害类型/名称位置/备注等所有文本字段 | `q=虫蛀孔` |
| `code` | 编号（拓片编号；缺损项会继承所属拓片编号；批次为其 id） | `code=TP-清-014` |
| `source` | 来源（缺损项继承所属拓片来源） | `source=地方碑刻` |
| `damageType` | 病害类型（兼容别名 `type`） | `damageType=撕裂` |
| `dateFrom` / `dateTo` | 登记时间范围（含边界，ISO 日期） | `dateFrom=2026-01-01&dateTo=2026-06-30` |
| `kind` | 限定类型，可多选：`rubbing`(拓片) / `damage`(缺损项) / `batch`(批次)，逗号分隔 | `kind=damage,batch` |
| `pageSize` | 每页条数，默认 20，最大 100 | `pageSize=50` |
| `cursor` / `sessionId` | 翻页游标与会话（见下） |  |

别名：`keyword` 等同 `q`；`from`/`to` 等同 `dateFrom`/`dateTo`。

### 匹配规则

- **忽略全角/半角差异**：`ＴＰ－清　０１４` 与 `TP-清 014` 等价（NFKC 归一）。
- **忽略大小写**：`tp` 与 `TP` 等价。
- **忽略繁简差异**：`蟲蛀孔` 与 `虫蛀孔` 等价（内置 900 余字繁体→简体单字表）。
- **忽略空格与标点差异**：全角空格、Tab、连字符、括号等不影响匹配。
- **容错一个错字**：查询与字段相差恰好一个字（一次替换/插入/删除，编辑距离 ≤ 1）仍命中。
  单字查询不做容错（避免单字泛匹配）；错两个字不命中。
- 每条结果带 `matchedReasons`，逐条说明**命中原因**：命中字段、原文、精确/模糊、编辑距离。
  例如 `命中病害类型（与「虫蛀孔」相差 1 字，已按错一个字容错）`。

### 排序

先按**匹配度评分**降序（编号权重最高，其次病害类型、来源、名称、备注；完全相等 >
包含 > 错字，错字按编辑距离扣分）。总分相同时按稳定次序排列：

1. 登记时间 `createdAt` 升序
2. 编号 `code` 升序
3. 档案 `id` 升序

### 响应示例

```json
{
  "data": [
    {
      "kind": "damage",
      "kindLabel": "缺损项",
      "id": "damage_demo_1",
      "code": "TP-清-014",
      "source": "地方碑刻残页",
      "damageType": "虫蛀孔",
      "name": "左上角第3列题字旁",
      "createdAt": "2026-06-16T00:00:00.000Z",
      "score": 102,
      "matchedReasons": [
        { "field": "病害类型", "query": "蟲柱孔", "match": "fuzzy", "distance": 1,
          "detail": "关键词近似命中病害类型（与「虫蛀孔」相差 1 字，已按错一个字容错）" }
      ],
      "isDeleted": false,
      "record": { "...完整缺损项记录..." },
      "rubbing": { "id": "rubbing_demo", "code": "TP-清-014", "source": "地方碑刻残页" },
      "cursor": 0
    }
  ],
  "total": 1,
  "tookMs": 3,
  "generation": 2,
  "page": { "sessionId": "s_…", "pageSize": 20, "cursor": 0, "nextCursor": null, "hasMore": false, "index": 1 }
}
```

### 分页（翻页期间数据增改也不重不漏）

首次请求不带 `sessionId`，服务端为这次查询建立一个**结果快照会话**（默认保留 10 分钟，
翻页自动续期），返回 `page.sessionId` 与 `page.nextCursor`。后续翻页带上二者即可：

```bash
curl '/search?q=碑刻&pageSize=20'
curl '/search?q=碑刻&pageSize=20&sessionId=s_xxx&cursor=20'
```

因为每页都从**同一份查询快照**切片，所以翻页过程中即使有新增、修改、删除：

- 已在翻的结果**不会重复、不会漏项、顺序不乱**；
- 会话期间某条被删除，该页会保留占位并标记 `isDeleted: true`（不影响其它项位置）；
- 想看到最新数据，不带 `sessionId` 重新发起一次查询即可（新查询立即包含全部已提交变更）。

## 索引管理

```
GET  /admin/search/status     索引世代、文档数、各类型数量、WAL seq、是否重建中、会话数
POST /admin/search/reindex    （再）建索引，返回 {ok, generation, docs, resumed, total}
```

- 服务启动时自动建立首代索引（存在检查点则续跑）。
- **记录变更后立即可查**：每次写入经事件监听增量更新当前索引，无需等待重建。
- **重建可中断续跑**：重建分批进行并把检查点（稳定的 ID 快照 + 段/偏移）原子写入
  `rebuild-checkpoint.json`。进程内取消会保留半成品，下次从断点继续；进程重启后按同一
  ID 基准从头幂等重建（`addDoc` 幂等），完成后清除检查点，**最终不漏不重**。
- **重建与写入并发安全**：重建在新一代（pending）索引上进行，旧代始终对外服务，
  重建期间的每条写入同时更新两代；全部完成后才原子切换世代，因此查询**绝不会读到半成品**。

## 数据存储与一致性

- `snapshot.json`：压实快照（临时文件 + `rename` 原子替换）。
- `wal.log`：快照之后的增量日志，每条写入先 append + fsync 再更新内存；写入串行化。
- 批次创建/完成等涉及多记录的操作落为一条 `bulk`，保证原子性。
- WAL 超过阈值自动在后台压实。WAL 末尾若有崩溃造成的残缺行会被忽略、留证为
  `wal.corrupt`，已确认的完整行不丢，服务照常启动。
- 批次内多记录操作、索引世代切换均在单事件循环内串行完成，读永远拿到一致状态。

## 原有业务接口（保持不变）

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=` / `PATCH /damages/:id`
- `GET /batches` / `POST /batches`
- `GET /batches/:id` / `POST /batches/:id/complete`

字段与响应结构与旧版一致（如批次的 `damages/total/repaired/pending`，
拓片列表的 `damageCount/pendingDamages`）。

## 测试

```bash
npm test          # node --test tests/，共 54 个用例
```

覆盖：归一化与模糊匹配、组合查询、命中原因、评分与稳定排序、会话分页不重不漏、
写入立即可查、WAL 持久化/压实/残缺自愈、旧库迁移、重建中断续跑、重建并发隔离、
幂等重建、HTTP 端到端与旧接口兼容，以及 10 万条数据下的查询性能（断言 < 1s）。

## 目录结构

```
server.js                启动入口（薄封装）
src/app.js               HTTP 应用工厂（业务接口 + /search + 管理接口）
src/search.js            统一文档模型、倒排索引、评分、分页世代、重建
src/normalize.js         NFKC/繁简/大小写/空格归一、分词、编辑距离、错字滑窗
src/t2s.js               繁体→简体单字表
src/store.js             内存数据集 + WAL + 快照（原子写、串行写、崩溃恢复）
src/checkpoint.js        重建断点管理
scripts/seed.js          确定性十万级数据生成
tests/                   node:test 自动化测试
data/                    运行数据（db.json 旧库 / snapshot.json / wal.log）
```
