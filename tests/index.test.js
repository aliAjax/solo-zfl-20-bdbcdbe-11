const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { setupEngine, setupStore, seedArchive, tmpDir, rmrf } = require("./helpers");

async function withEngine(fn) {
  const dir = tmpDir("index");
  try {
    const ctx = await setupEngine(dir);
    await fn({ ...ctx, dir });
    ctx.engine.close();
    await ctx.store.close();
  } finally {
    rmrf(dir);
  }
}

test("记录变更后立刻可查（无需等重建）", async () => {
  await withEngine(async ({ engine, store }) => {
    await store.mutate([
      "upsertDamage",
      { id: "dInstant", rubbingId: "r1", position: "右下", type: "水渍", beforePhotoUrl: "", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: "2026-03-01T00:00:00Z", repairedAt: null }
    ]);
    const r = engine.search({ damageType: "水渍" });
    assert.ok(r.results.some((x) => x.id === "dInstant"), "写入后同进程立即可查");
  });
});

test("重建中断后保留检查点，续跑完成且不漏不重", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    let calls = 0;
    engine.cancelRebuild(); // 清理可能状态（无重建时为空操作）
    const p1 = engine.rebuild({
      batchSize: 2,
      onProgress: () => {
        calls++;
        if (calls === 1) engine.cancelRebuild();
      }
    });
    await assert.rejects(p1, (err) => err.code === "REBUILD_CANCELLED");
    assert.ok(fs.existsSync(path.join(dir, "rebuild-checkpoint.json")), "中断后检查点应落盘");

    const info = await engine.rebuild({ batchSize: 2 });
    assert.ok(info.resumed, "应识别为断点续跑");
    const expectCount =
      store.data.rubbings.length + store.data.damages.length + store.data.batches.length;
    assert.strictEqual(info.docs, expectCount);
    assert.strictEqual(engine.current.docs.size, expectCount, "最终索引条数与数据一致");
    assert.ok(!fs.existsSync(path.join(dir, "rebuild-checkpoint.json")), "完成后检查点应清除");

    // 不漏：每条记录都能按其关键字搜到
    assert.ok(engine.search({ code: "TP-清-014" }).total >= 1);
    assert.ok(engine.search({ damageType: "虫蛀孔" }).total === 1);
    assert.ok(engine.search({ q: "六月小批" }).total === 1);
  });
});

test("重建期间查询走旧代，读不到半成品", async () => {
  await withEngine(async ({ engine }) => {
    const genBefore = engine.current.generation;
    let sawHalfBuilt = false;
    const midQueries = [];
    const p = engine.rebuild({
      batchSize: 1,
      onProgress: () => {
        // 重建中途反复查询：必须始终命中旧代的完整数据
        const r = engine.search({ damageType: "虫蛀孔" });
        midQueries.push(r.total);
        if (r.total !== 1) sawHalfBuilt = true;
      }
    });
    await p;
    assert.strictEqual(sawHalfBuilt, false, "重建过程中不得读到半成品数据");
    assert.ok(midQueries.length > 0, "重建中应确实执行过查询");
    assert.strictEqual(engine.current.generation, genBefore + 1, "完成后世代原子推进");
  });
});

test("重建与写入并发：重建期间立即可查，切换后新代也包含该写入", async () => {
  await withEngine(async ({ engine, store }) => {
    let inserted = false;
    let visibleDuringRebuild = false;
    const p = engine.rebuild({
      batchSize: 1,
      onProgress: async () => {
        if (!inserted) {
          inserted = true;
          await store.mutate([
            "upsertRubbing",
            { id: "rConcurrent", code: "TP-并发-999", source: "并发测试来源", paperSize: "1x1cm", note: "", createdAt: "2026-07-01T00:00:00Z" }
          ]);
        }
        const r = engine.search({ code: "TP-并发-999" });
        if (r.total >= 1) visibleDuringRebuild = true;
      }
    });
    await p;
    assert.ok(visibleDuringRebuild, "重建期间旧代也必须立刻看到新写入");
    const after = engine.search({ code: "TP-并发-999" });
    assert.ok(after.total >= 1, "切换后新代包含重建窗口内写入");
  });
});

test("重建期间删除记录：新代与当前数据一致，不残留", async () => {
  await withEngine(async ({ engine, store }) => {
    let deleted = false;
    await engine.rebuild({
      batchSize: 1,
      onProgress: async () => {
        if (!deleted) {
          deleted = true;
          await store.mutate(["deleteDamage", "d2"]);
        }
      }
    });
    assert.strictEqual(engine.search({ q: "下边缘中央" }).total, 0, "被删记录不得残留在新代");
    assert.strictEqual(engine.current.docs.size, 6, "3+2+1=6");
  });
});

test("重复重建幂等，不产生重复文档", async () => {
  await withEngine(async ({ engine, store }) => {
    await engine.rebuild();
    await engine.rebuild();
    const expectCount =
      store.data.rubbings.length + store.data.damages.length + store.data.batches.length;
    assert.strictEqual(engine.current.docs.size, expectCount);
  });
});
