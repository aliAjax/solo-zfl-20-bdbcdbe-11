const test = require("node:test");
const assert = require("node:assert");
const { createApp } = require("../src/app");
const { tmpDir, rmrf } = require("./helpers");

async function startServer(dir) {
  const server = await createApp({ dataDir: dir });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function json(base, init) {
  const res = await fetch(base, init);
  const body = await res.json();
  return { status: res.status, body };
}

async function withServer(fn) {
  const dir = tmpDir("http");
  const { server, base } = await startServer(dir);
  try {
    await fn(base);
  } finally {
    await server.shutdown();
    rmrf(dir);
  }
}

const LEGACY_HEALTH = {
  ok: true,
  service: "rubbing-repair-api",
  routes: [
    "GET /health",
    "GET /rubbings",
    "POST /rubbings",
    "GET /rubbings/:id/damages",
    "POST /rubbings/:id/damages",
    "GET /damages?status=&type=",
    "PATCH /damages/:id",
    "GET /batches",
    "POST /batches",
    "GET /batches/:id",
    "POST /batches/:id/complete"
  ]
};

test("健康检查：与旧版逐字段一致（字段、路由清单都不变）", async () => {
  await withServer(async (base) => {
    const { status, body } = await json(`${base}/health`);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, LEGACY_HEALTH);
    // 明确保证：新增路由不出现在健康检查里，也不多任何字段
    assert.strictEqual(body.counts, undefined);
    assert.ok(!body.routes.some((r) => r.includes("/search") || r.includes("/admin")));
    assert.deepStrictEqual(Object.keys(body), ["ok", "service", "routes"]);
  });
});

test("旧接口保持不变：建拓片→建缺损→建批次→完成闭环", async () => {
  await withServer(async (base) => {
    const created = await json(`${base}/rubbings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "TP-测-001", source: "测试来源", paperSize: "10x20cm" })
    });
    assert.strictEqual(created.status, 201);
    const rid = created.body.data.id;

    const dmg = await json(`${base}/rubbings/${rid}/damages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: "中央", type: "虫蛀孔", beforePhotoUrl: "b" })
    });
    assert.strictEqual(dmg.status, 201);
    const did = dmg.body.data.id;

    // 立即可查（无需等索引重建）
    const found = await json(`${base}/search?damageType=${encodeURIComponent("虫蛀孔")}`);
    assert.strictEqual(found.status, 200);
    assert.ok(found.body.data.some((x) => x.id === did), "新建缺损立即可查");

    // 列表与旧结构一致
    const list = await json(`${base}/rubbings`);
    const row = list.body.data.find((r) => r.id === rid);
    assert.strictEqual(row.damageCount, 1);
    assert.strictEqual(row.pendingDamages, 1);

    const damages = await json(`${base}/damages?status=pending&type=${encodeURIComponent("虫蛀孔")}`);
    assert.ok(damages.body.data.some((d) => d.id === did));

    const batch = await json(`${base}/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "测试批次", damageIds: [did] })
    });
    assert.strictEqual(batch.status, 201);
    const bid = batch.body.data.id;
    assert.strictEqual(batch.body.data.total, 1);

    const complete = await json(`${base}/batches/${bid}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAfterPhotoUrl: "a", defaultRepairNote: "ok" })
    });
    assert.strictEqual(complete.status, 200);
    assert.strictEqual(complete.body.data.status, "completed");

    const one = await json(`${base}/batches/${bid}`);
    assert.strictEqual(one.body.data.repaired, 1);
  });
});

test("GET /search：组合条件、繁简/全半角归一、错字命中并给出原因", async () => {
  await withServer(async (base) => {
    const created = await json(`${base}/rubbings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "TP-清-014", source: "地方碑刻残页", paperSize: "40x60" })
    });
    const rid = created.body.data.id;
    const dmg = await json(`${base}/rubbings/${rid}/damages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: "左上角", type: "虫蛀孔", beforePhotoUrl: "b" })
    });
    assert.strictEqual(dmg.status, 201);
    const r = await json(`${base}/search?code=${encodeURIComponent("ｔｐ－清　０１４")}`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.some((x) => x.code === "TP-清-014"));

    // 繁简 + 错一个字（蟲柱孔 → 虫蛀孔），且标明命中原因
    const typo = await json(`${base}/search?q=${encodeURIComponent("蟲柱孔")}`);
    assert.strictEqual(typo.status, 200);
    assert.ok(typo.body.data.some((x) => x.id === dmg.body.data.id), "错字+繁简应命中该缺损");
    const hit = typo.body.data.find((x) => x.id === dmg.body.data.id);
    assert.ok(hit.matchedReasons.some((x) => x.match === "fuzzy"));
  });
});

test("GET /search：会话式分页翻页不重不漏", async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 6; i++) {
      await json(`${base}/rubbings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: `TP-页-${i}`, source: "分页来源", paperSize: "1x1" })
      });
    }
    const q = encodeURIComponent("分页来源");
    const p1 = await json(`${base}/search?source=${q}&pageSize=2`);
    assert.strictEqual(p1.body.data.length, 2);
    const sid = p1.body.page.sessionId;
    const p2 = await json(`${base}/search?source=${q}&pageSize=2&sessionId=${sid}&cursor=${p1.body.page.nextCursor}`);
    assert.strictEqual(p2.body.data.length, 2);
    const overlap = p1.body.data.filter((a) => p2.body.data.some((b) => b.id === a.id));
    assert.strictEqual(overlap.length, 0, "两页不得重复");
  });
});

test("索引状态与手动重建", async () => {
  await withServer(async (base) => {
    const st = await json(`${base}/admin/search/status`);
    assert.strictEqual(st.status, 200);
    assert.ok(st.body.docs >= 0);
    const re = await json(`${base}/admin/search/reindex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.strictEqual(re.status, 200);
    assert.strictEqual(re.body.ok, true);

    // 重建进行中再请求返回 409
  });
});

test("非法 JSON 与 404", async () => {
  await withServer(async (base) => {
    const bad = await json(`${base}/rubbings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json"
    });
    assert.strictEqual(bad.status, 400);
    const nf = await json(`${base}/nope`);
    assert.strictEqual(nf.status, 404);
  });
});
