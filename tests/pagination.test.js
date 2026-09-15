const test = require("node:test");
const assert = require("node:assert");
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

function allPages(engine, query, pageSize = 2) {
  return walkSession(engine, query, pageSize).items;
}

/** 从 cursor 0 开始遍历一个会话的全部分页，返回 kind:id 列表与会话 id。 */
function walkSession(engine, query, pageSize = 2, existingSid = null, startCursor = 0) {
  const seen = [];
  let cursor = startCursor;
  let sessionId = existingSid;
  for (let guard = 0; guard < 5000; guard++) {
    const out = engine.searchPaged(query, { pageSize, cursor, sessionId });
    if (!sessionId) sessionId = out.page.sessionId;
    for (const item of out.data) seen.push(item.kind + ":" + item.id);
    if (out.page.nextCursor === null) break;
    cursor = out.page.nextCursor;
  }
  return { items: seen, sessionId };
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

test("翻页期间数据新增/修改：同一会话不重不漏；新查询包含新增项", async () => {
  await withEngine(async ({ engine, store }) => {
    const query = { damageType: "虫蛀孔" };
    const first = engine.searchPaged(query, { pageSize: 1 });
    const sid = first.page.sessionId;
    assert.strictEqual(first.total, 1, "会话建立时仅 d1");

    // 翻页过程中：新增一条同类缺损、修改一条既有缺损、再新增一条别的类型
    const ts = "2026-02-01T00:00:00Z";
    await store.mutate([
      "upsertDamage",
      { id: "dNew", rubbingId: "r1", position: "新虫蛀处", type: "虫蛀孔", beforePhotoUrl: "", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: ts, repairedAt: null }
    ]);
    await store.mutate([
      "upsertDamage",
      { id: "d1", rubbingId: "r1", position: "左上角（已复核）", type: "虫蛀孔", beforePhotoUrl: "b1", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-01-12T00:00:00.000Z", repairedAt: null }
    ]);

    // 同一会话继续翻页：集合与会话建立时一致
    const { items: sessionItems } = walkSession(engine, query, 1, sid);
    assert.strictEqual(new Set(sessionItems).size, sessionItems.length, "会话内不重复");
    assert.strictEqual(sessionItems.includes("damage:dNew"), false, "会话不中途插入新记录（不漏不重");

    // 全新查询应立刻看到新增与修改
    const fresh = engine.search(query);
    const freshIds = fresh.results.map((x) => x.id);
    assert.ok(freshIds.includes("dNew"), "新增记录立即可查");
    const d1 = fresh.results.find((x) => x.id === "d1");
    assert.ok(d1.record.position.includes("已复核"), "修改立即生效");
  });
});

test("翻页期间记录被删除：标记 isDeleted 但仍占位，不引发跳漏或重复", async () => {
  await withEngine(async ({ engine, store }) => {
    const query = { damageType: "虫蛀孔" };
    const first = engine.searchPaged(query, { pageSize: 1 });
    const sid = first.page.sessionId;
    assert.strictEqual(first.total, 1, "会话建立时仅 d1 一条");
    await store.mutate(["deleteDamage", "d1"]);

    // 删除后用同一会话重取首页：仍占位且标记已删
    const out = engine.searchPaged(query, { pageSize: 1, cursor: 0, sessionId: sid });
    const deletedHit = out.data.find((x) => x.id === "d1");
    assert.ok(deletedHit, "会话快照中仍保留该项占位");
    assert.strictEqual(deletedHit.isDeleted, true);

    // 全部页拼起来总数与会话建立时一致（不跳漏、不重复）
    const { items } = walkSession(engine, query, 1, sid);
    assert.strictEqual(items.length, first.total);
    assert.strictEqual(new Set(items).size, items.length);

    // 全新查询不再包含已删项
    assert.strictEqual(engine.search(query).total, 0);
  });
});

test("过期/未知 sessionId 返回 400 语义错误，引导重新查询", async () => {
  await withEngine(({ engine }) => {
    assert.throws(() => engine.searchPaged({ q: "x" }, { sessionId: "s_not_exist" }), /会话不存在/);
  });
});
