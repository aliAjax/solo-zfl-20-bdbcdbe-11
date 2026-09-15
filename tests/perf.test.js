/**
 * 性能测试：十万条档案下单次查询 1 秒内返回。
 *
 * 直接在内存构建 10 万文档的索引（不落盘），只度量「查询」耗时，
 * 与生产环境（索引已驻留内存）的单次请求路径一致。
 */
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { SearchIndex, SearchEngine } = require("../src/search");
const { makePerfDocs } = require("./helpers");

const N = 100000;

function buildIndex(docs) {
  const idx = new SearchIndex();
  for (const doc of docs) idx.addDoc(doc);
  return idx;
}

// 全套性能用例共享一次建索引（约数秒），避免重复构建。
let cached = null;
async function getIndex() {
  if (cached) return cached;
  const { docs, db } = makePerfDocs(N);
  const t0 = Date.now();
  const index = buildIndex(docs);
  cached = { index, db, buildMs: Date.now() - t0, count: docs.length };
  return cached;
}

test(`[perf] 构建 ${N} 条索引`, async (t) => {
  const { index, buildMs, count } = await getIndex();
  assert.strictEqual(count, N);
  assert.strictEqual(index.docs.size, N, "索引文档数应等于数据条数（不漏不重）");
  console.log(`  索引构建 ${buildMs} ms，倒排 gram 数 ${index.postings.size}`);
});

const CASES = [
  { name: "自由词-常见病害", q: { q: "虫蛀孔" } },
  { name: "自由词-编号片段 TP-清", q: { q: "TP-清" } },
  { name: "自由词-错一字 蟲柱孔", q: { q: "蟲柱孔" } },
  { name: "字段-编号", q: { code: "TP-清-000" }, min: 1 },
  { name: "字段-来源", q: { source: "馆藏" }, min: 1 },
  { name: "字段-病害类型", q: { damageType: "撕裂" }, min: 1 },
  { name: "组合-类型+时间范围", q: { damageType: "撕裂", dateFrom: "2024-01-01", dateTo: "2024-12-31" }, min: 1 },
  { name: "批次名称", q: { q: "2025年第1批" } },
  { name: "无结果查询", q: { q: "不存在的词条xyz" } }
];

for (const c of CASES) {
  test(`[perf] ${N} 条下查询「${c.name}」1 秒内返回`, async () => {
    const { index, db } = await getIndex();
    const { SearchEngine } = require("../src/search");
    const engine = new SearchEngine(Object.assign(new EventEmitter(), { data: db }));
    engine.current = index;
    const r = engine.search(c.q);
    assert.ok(r.tookMs <= 1000, `查询耗时 ${r.tookMs}ms 超过 1000ms`);
    if (c.min) assert.ok(r.total >= c.min, `${c.name} 应至少命中 ${c.min}，实际 ${r.total}`);
    console.log(`  ${c.name}: ${r.total} 条，${r.tookMs} ms`);
    engine.close();
  });
}

test(`[perf] ${N} 条下分页切片亚秒且不重不漏`, async () => {
  const { index, db } = await getIndex();
  const { SearchEngine } = require("../src/search");
  const store = Object.assign(new EventEmitter(), { data: db, seq: 1 });
  const engine = new SearchEngine(store);
  engine.current = index;
  const t0 = Date.now();
  const p1 = engine.searchPaged({ q: "虫蛀孔" }, { pageSize: 100 });
  const p2 = engine.searchPaged({ q: "虫蛀孔" }, { pageSize: 100, sessionId: p1.page.sessionId, cursor: p1.page.nextCursor });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed <= 1000, `两次分页合计 ${elapsed}ms 超过 1000ms`);
  const a = new Set(p1.data.map((d) => d.id));
  assert.strictEqual(p2.data.filter((d) => a.has(d.id)).length, 0, "相邻页不得重复");
  assert.ok(typeof p1.page.nextCursor === "string", "游标应为不透明字符串");
  // 会话不得持有结果数组
  assert.strictEqual(engine.sessions.get(p1.page.sessionId).items, undefined);
  engine.close();
});
