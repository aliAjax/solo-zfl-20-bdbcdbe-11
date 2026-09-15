const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { Store } = require("../src/store");
const { tmpDir, rmrf, seedArchive } = require("./helpers");

test("写入持久化到 WAL，重开进程数据不丢", async () => {
  const dir = tmpDir("wal");
  try {
    const store = await new Store(dir).load();
    await seedArchive(store);
    await store.close();

    const store2 = await new Store(dir).load();
    assert.strictEqual(store2.data.rubbings.length, 3);
    assert.strictEqual(store2.data.damages.length, 3);
    assert.strictEqual(store2.data.batches.length, 1);
    assert.ok(store2.seq >= 1, "seq 应单调保留");
    await store2.close();
  } finally {
    rmrf(dir);
  }
});

test("原子批次（bulk）要么全成功，回放一致", async () => {
  const dir = tmpDir("bulk");
  try {
    const store = await new Store(dir).load();
    await store.mutate([
      ["upsertRubbing", { id: "a", code: "A", source: "s", createdAt: "2026-01-01" }],
      ["upsertRubbing", { id: "b", code: "B", source: "s", createdAt: "2026-01-02" }]
    ]);
    await store.close();
    const s2 = await new Store(dir).load();
    assert.deepStrictEqual(s2.data.rubbings.map((r) => r.id).sort(), ["a", "b"]);
    await s2.close();
  } finally {
    rmrf(dir);
  }
});

test("upsert 更新而非追加；删除生效", async () => {
  const dir = tmpDir("upsert");
  try {
    const store = await new Store(dir).load();
    await store.mutate(["upsertRubbing", { id: "a", code: "A", source: "s", createdAt: "2026-01-01" }]);
    await store.mutate(["upsertRubbing", { id: "a", code: "A2", source: "s", createdAt: "2026-01-01" }]);
    assert.strictEqual(store.data.rubbings.length, 1);
    assert.strictEqual(store.data.rubbings[0].code, "A2");
    await store.mutate(["deleteRubbing", "a"]);
    assert.strictEqual(store.data.rubbings.length, 0);
    await store.close();

    const s2 = await new Store(dir).load();
    assert.strictEqual(s2.data.rubbings.length, 0, "删除应在回放后保持");
    await s2.close();
  } finally {
    rmrf(dir);
  }
});

test("压实快照后 WAL 清空，数据不丢", async () => {
  const dir = tmpDir("compact");
  try {
    const store = await new Store(dir).load();
    for (let i = 0; i < 3; i++) {
      await store.mutate(["upsertRubbing", { id: `r${i}`, code: `C${i}`, source: "s", createdAt: "2026-01-01" }]);
    }
    await store.compact();
    const wal = fs.readFileSync(path.join(dir, "wal.log"), "utf8").trim();
    assert.strictEqual(wal, "", "压实后 WAL 应为空");
    const snap = JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"));
    assert.strictEqual(snap.data.rubbings.length, 3);

    // 压实之后的新写入进入新 WAL，重放不丢
    await store.mutate(["upsertRubbing", { id: "r9", code: "C9", source: "s", createdAt: "2026-01-01" }]);
    await store.close();

    const s2 = await new Store(dir).load();
    assert.strictEqual(s2.data.rubbings.length, 4);
    await s2.close();
  } finally {
    rmrf(dir);
  }
});

test("WAL 末行残缺（模拟写到一半崩溃）自愈：保留完整行、留证残行", async () => {
  const dir = tmpDir("corrupt");
  try {
    const store = await new Store(dir).load();
    await store.mutate(["upsertRubbing", { id: "ok1", code: "K1", source: "s", createdAt: "2026-01-01" }]);
    await store.close();
    fs.appendFileSync(path.join(dir, "wal.log"), '{"seq":99,"op":["upsertRubbing",{"id":"broken"}\n');

    const s2 = await new Store(dir).load(); // 不应抛错
    assert.strictEqual(s2.data.rubbings.length, 1, "完整行必须保留");
    assert.strictEqual(s2.data.rubbings[0].id, "ok1");
    assert.ok(fs.existsSync(path.join(dir, "wal.corrupt")), "残缺 WAL 应留证");
    assert.strictEqual(fs.readFileSync(path.join(dir, "wal.log"), "utf8"), "", "应启用全新空 WAL");
    // 自愈后新写入仍能持久化
    await s2.mutate(["upsertRubbing", { id: "ok2", code: "K2", source: "s", createdAt: "2026-01-02" }]);
    await s2.close();
    const s3 = await new Store(dir).load();
    assert.deepStrictEqual(s3.data.rubbings.map((r) => r.id).sort(), ["ok1", "ok2"]);
    await s3.close();
  } finally {
    rmrf(dir);
  }
});

test("迁移旧版 data/db.json 为快照", async () => {
  const dir = tmpDir("legacy");
  try {
    fs.writeFileSync(
      path.join(dir, "db.json"),
      JSON.stringify({
        rubbings: [{ id: "legacy_r", code: "L-1", source: "旧库", createdAt: "2026-01-01" }],
        damages: [],
        batches: []
      })
    );
    const store = await new Store(dir).load();
    assert.strictEqual(store.data.rubbings[0].id, "legacy_r");
    assert.ok(fs.existsSync(path.join(dir, "snapshot.json")), "应生成 snapshot.json");
    await store.close();
  } finally {
    rmrf(dir);
  }
});
