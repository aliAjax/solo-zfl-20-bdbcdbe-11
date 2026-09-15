const test = require("node:test");
const assert = require("node:assert");
const v8 = require("node:v8");
const { setupEngine, tmpDir, rmrf } = require("./helpers");

async function withEngine(fn) {
  const dir = tmpDir("page");
  try {
    const ctx = await setupEngine(dir);
    await fn(ctx);
    ctx.engine.close();
    await ctx.store.close();
  } finally {
    rmrf(dir);
  }
}

/** 从首页起用不透明游标遍历整个会话，返回 kind:id 列表。 */
function walkSession(engine, query, pageSize = 2, existingSid = null, startCursor = null) {
  const seen = [];
  let cursor = startCursor;
  let sessionId = existingSid;
  for (let guard = 0; guard < 10000; guard++) {
    const out = engine.searchPaged(query, { pageSize, cursor, sessionId });
    if (!sessionId) sessionId = out.page.sessionId;
    for (const item of out.data) seen.push(item.kind + ":" + item.id);
    if (out.page.nextCursor === null) break;
    cursor = out.page.nextCursor;
  }
  return { items: seen, sessionId };
}

function allPages(engine, query, pageSize = 2) {
  return walkSession(engine, query, pageSize).items;
}

test("分页：逐页拼接与一次性全量结果一致（不重不漏）", async () => {
  await withEngine(({ engine }) => {
    const query = { source: "碑刻" };
    const full = engine.search(query).results.map((r) => r.kind + ":" + r.id);
    const paged = allPages(engine, query, 2);
    assert.strictEqual(paged.length, full.length);
    assert.deepStrictEqual(paged, full);
    assert.strictEqual(new Set(paged).size, paged.length, "页间不得重复");
  });
});

test("分页：keyset 游标顺序稳定，相邻页零重叠", async () => {
  await withEngine(({ engine }) => {
    const query = {};
    const a = engine.searchPaged(query, { pageSize: 3 });
    const b = engine.searchPaged(query, { pageSize: 3, sessionId: a.page.sessionId, cursor: a.page.nextCursor });
    const c = engine.searchPaged(query, { pageSize: 3, sessionId: a.page.sessionId, cursor: b.page.nextCursor });
    const ids = [...a.data, ...b.data, ...c.data].map((d) => d.kind + ":" + d.id);
    assert.strictEqual(new Set(ids).size, ids.length, "三页之间不得有重复");
    assert.strictEqual(a.data[0].id, engine.search(query).results[0].id, "首页首项与全量首项一致");
  });
});

test("翻页期间新增/修改：同一会话保持查询时刻快照，新查询才看到变化", async () => {
  await withEngine(async ({ engine, store }) => {
    const query = { damageType: "虫蛀孔" };
    const first = engine.searchPaged(query, { pageSize: 1 });
    const sid = first.page.sessionId;
    assert.strictEqual(first.total, 1, "会话建立时仅 d1");

    // 新增一条同类缺损、修改 d1 的位置
    await store.mutate([
      "upsertDamage",
      { id: "dNew", rubbingId: "r1", position: "新虫蛀处", type: "虫蛀孔", beforePhotoUrl: "", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-02-01T00:00:00Z", repairedAt: null }
    ]);
    await store.mutate([
      "upsertDamage",
      { id: "d1", rubbingId: "r1", position: "左上角（已复核）", type: "虫蛀孔", beforePhotoUrl: "b1", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-12T00:00:00.000Z", repairedAt: null }
    ]);

    // 同一会话：总数仍为 1，且没有下一页（新增项不插入本会话、不重不漏）
    assert.strictEqual(first.page.hasMore, false, "会话建立时只有 1 条，没有下一页");
    assert.strictEqual(first.total, 1, "会话总数不随后续新增而变");

    // 重取首页：仍是会话时刻结果，既有项展示旧字段
    const replay = engine.searchPaged(query, { pageSize: 1, sessionId: sid, cursor: null });
    assert.strictEqual(replay.total, 1);
    assert.strictEqual(replay.data[0].record.position, "左上角第3列题字旁", "会话内展示查询时刻的旧字段");

    // 全新查询立即看到新增与修改
    const fresh = engine.search(query);
    assert.ok(fresh.results.some((x) => x.id === "dNew"), "新增立即可查");
    assert.strictEqual(fresh.results.find((x) => x.id === "d1").record.position, "左上角（已复核）");
  });
});

test("翻页期间删除：会话仍是查询时刻快照（仍能翻到该项、字段为删除前状态）", async () => {
  await withEngine(async ({ engine, store }) => {
    const query = { damageType: "虫蛀孔" };
    const first = engine.searchPaged(query, { pageSize: 1 });
    const sid = first.page.sessionId;
    assert.strictEqual(first.total, 1);
    await store.mutate(["deleteDamage", "d1"]);

    // 同一会话重取首页：仍是删除前快照，记录可正常展示（无 isDeleted 标记）
    const out = engine.searchPaged(query, { pageSize: 1, sessionId: sid, cursor: null });
    assert.strictEqual(out.total, 1, "会话总数不变");
    assert.strictEqual(out.data.length, 1);
    assert.strictEqual(out.data[0].id, "d1");
    assert.strictEqual(out.data[0].record.position, "左上角第3列题字旁", "展示删除前内容");
    assert.strictEqual(out.data[0].isDeleted, undefined);

    // 全新查询不再包含
    assert.strictEqual(engine.search(query).total, 0);
  });
});

test("翻页期间记录被改成不再匹配：会话仍包含旧命中，新查询排除", async () => {
  await withEngine(async ({ engine, store }) => {
    const query = { damageType: "虫蛀孔" };
    const first = engine.searchPaged(query, { pageSize: 1 });
    const sid = first.page.sessionId;
    await store.mutate([
      "upsertDamage",
      { id: "d1", rubbingId: "r1", position: "左上角第3列题字旁", type: "撕裂", beforePhotoUrl: "b1", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-12T00:00:00.000Z", repairedAt: null }
    ]);
    const same = engine.searchPaged(query, { pageSize: 1, sessionId: sid, cursor: null });
    assert.strictEqual(same.total, 1, "会话按查询时刻仍命中旧病害类型");
    assert.strictEqual(same.data[0].damageType, "虫蛀孔");
    assert.strictEqual(engine.search(query).total, 0, "新查询按当前数据排除");
  });
});

test("会话占用为 O(1)：十个大结果查询后常驻内存不随结果条数增长", async () => {
  await withEngine(async ({ engine, store }) => {
    // 在活动会话下制造 400 条同类缺损（大结果集），开多个会话
    const ops = [];
    for (let i = 0; i < 400; i++) {
      ops.push([
        "upsertDamage",
        { id: `dBulk${i}`, rubbingId: "r1", position: "批量位置", type: "批量病害XYZ", beforePhotoUrl: "", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: `2026-03-0${(i % 9) + 1}T00:00:00Z`, repairedAt: null }
      ]);
    }
    await store.mutate(ops);

    const sessions = [];
    for (let k = 0; k < 10; k++) {
      const out = engine.searchPaged({ damageType: "批量病害XYZ" }, { pageSize: 20 });
      assert.strictEqual(out.total, 400);
      sessions.push(out.page.sessionId);
    }

    // 会话本体：每个只存参数/seq/总数/到期时间，不持有结果数组
    for (const sid of sessions) {
      const s = engine.sessions.get(sid);
      assert.strictEqual(s.items, undefined, "会话不得保存结果列表");
      const jsonSize = v8.serialize(s).length;
      assert.ok(jsonSize < 2000, `会话序列化体积应是 O(1)，实际 ${jsonSize}`);
    }
    // 历史只含「会话期间被改动的记录」版本；这里建会话后无写入，历史应为空
    assert.strictEqual(engine.history.isEmpty(), true);

    // 每个会话仍能正确翻完全部 400 条且不重不漏
    for (const sid of sessions) {
      const seen = [];
      let cursor = null;
      for (let g = 0; g < 30; g++) {
        const p = engine.searchPaged({ damageType: "批量病害XYZ" }, { pageSize: 50, sessionId: sid, cursor });
        for (const d of p.data) seen.push(d.id);
        if (p.page.nextCursor === null) break;
        cursor = p.page.nextCursor;
      }
      assert.strictEqual(seen.length, 400);
      assert.strictEqual(new Set(seen).size, 400);
    }
  });
});

test("过期/未知 sessionId 返回 400 语义错误", async () => {
  await withEngine(({ engine }) => {
    assert.throws(() => engine.searchPaged({ q: "x" }, { sessionId: "s_not_exist" }), /会话不存在/);
  });
});
