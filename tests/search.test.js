const test = require("node:test");
const assert = require("node:assert");
const { setupEngine, tmpDir, rmrf } = require("./helpers");

async function withEngine(fn) {
  const dir = tmpDir("search");
  try {
    const ctx = await setupEngine(dir);
    await fn(ctx);
    ctx.engine.close();
    await ctx.store.close();
  } finally {
    rmrf(dir);
  }
}

test("统一入口：三类档案同一查询可命中", async () => {
  await withEngine(({ engine }) => {
    const r = engine.search({ q: "修补" });
    const kinds = new Set(r.results.map((x) => x.kind));
    assert.ok(kinds.has("batch"), "批次应被命中");
  });
});

test("按编号查：全半角、大小写、空格差异归一", async () => {
  await withEngine(({ engine }) => {
    const variants = ["tp-清-014", "ＴＰ－清　０１４", "TP 清 014", "Tp-清-014"];
    for (const code of variants) {
      const r = engine.search({ code });
      const ids = r.results.filter((x) => x.id === "r1");
      assert.ok(ids.length === 1, `编号 ${code} 应命中拓片 r1，实际 ${r.total}`);
    }
  });
});

test("按来源查", async () => {
  await withEngine(({ engine }) => {
    const r = engine.search({ source: "碑刻" });
    // r1 来源含「碑刻」，d1/d2 继承拓片来源
    const ids = new Set(r.results.map((x) => x.id));
    assert.ok(ids.has("r1"));
    assert.ok(ids.has("d1"));
    assert.ok(ids.has("d2"));
    assert.ok(!ids.has("r2"));
  });
});

test("按病害类型查", async () => {
  await withEngine(({ engine }) => {
    const r = engine.search({ damageType: "虫蛀孔" });
    assert.deepStrictEqual(r.results.map((x) => x.id), ["d1"]);
  });
});

test("时间范围过滤（含边界）", async () => {
  await withEngine(({ engine }) => {
    const r = engine.search({ dateFrom: "2026-02-01", dateTo: "2026-02-28" });
    // r2 day(40)=2026-02-10、d3 day(41)
    const ids = new Set(r.results.map((x) => x.id));
    assert.ok(ids.has("r2"));
    assert.ok(ids.has("d3"));
    assert.ok(!ids.has("r1")); // day10 = 1月11日
  });
});

test("组合查询：编号 + 来源 + 病害类型 + 时间范围", async () => {
  await withEngine(({ engine }) => {
    const r = engine.search({
      code: "014",
      source: "碑刻",
      damageType: "虫蛀",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31"
    });
    assert.deepStrictEqual(r.results.map((x) => x.id), ["d1"]);
  });
});

test("错一个字仍命中，结果标明命中原因（fuzzy + distance + window）", async () => {
  await withEngine(({ engine }) => {
    const r = engine.search({ q: "蟲柱孔" }); // 繁体 + 错字「柱」
    const hit = r.results.find((x) => x.id === "d1");
    assert.ok(hit, "d1 应被错字+繁简查询命中");
    const reason = hit.matchedReasons.find((x) => x.match === "fuzzy");
    assert.ok(reason, "应标注 fuzzy 命中原因");
    assert.strictEqual(reason.distance, 1);
    assert.match(reason.detail, /错一个字/);
  });
});

test("精确命中优先于模糊命中（评分排序）", async () => {
  await withEngine(({ engine, store }) => {
    return (async () => {
      await store.mutate([
        "upsertDamage",
        { id: "dX", rubbingId: "r1", position: "x", type: "虫蛀孔", beforePhotoUrl: "", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-05-01T00:00:00Z", repairedAt: null }
      ]);
      const r = engine.search({ damageType: "虫蛀孔" });
      assert.ok(r.results[0].matchedReasons.every((x) => x.match === "exact"));
    })();
  });
});

test("同分按登记时间、编号稳定排列", async () => {
  await withEngine(({ engine }) => {
    // d1(day12) 与 d2(day12? 实际 d1=day11,d2=day12) 用 source=碑刻 命中
    const r = engine.search({ source: "碑刻" });
    const ids = r.results.map((x) => x.id);
    // r1 day10 早于 d1 day11 早于 d2 day12
    assert.deepStrictEqual(ids, ["r1", "d1", "d2"]);
    // 两次查询顺序完全一致
    const r2 = engine.search({ source: "碑刻" });
    assert.deepStrictEqual(r2.results.map((x) => x.id), ids);
  });
});

test("kind 过滤只返回指定类型", async () => {
  await withEngine(({ engine }) => {
    const r = engine.search({ q: "014", kind: "damage" });
    assert.ok(r.results.every((x) => x.kind === "damage"));
    assert.ok(r.results.some((x) => x.id === "d1"));
  });
});

test("无匹配返回空且不报错", async () => {
  await withEngine(({ engine }) => {
    const r = engine.search({ q: "根本不存在的词条xyz" });
    assert.strictEqual(r.total, 0);
  });
});

test("时间格式非法返回 400 语义错误", async () => {
  await withEngine(({ engine }) => {
    assert.throws(() => engine.search({ dateFrom: "not-a-date" }), /时间范围/);
  });
});
