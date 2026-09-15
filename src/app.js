/**
 * HTTP 应用工厂（零依赖）。
 *
 * 在原有接口完全不变的前提下，存储层从「每请求读写 data/db.json」
 * 换成「内存数据集 + WAL + 快照」，并新增统一检索与索引管理接口：
 *
 *   GET  /search                统一检索（拓片/缺损项/批次同一入口，支持分页）
 *   POST /admin/search/reindex  （再）建索引，支持断点续跑
 *   GET  /admin/search/status   索引与数据量状态
 *
 * createApp 返回 http.Server，便于自动化测试随机端口拉起。
 */
const http = require("http");
const { URL } = require("url");
const { Store } = require("./store");
const { SearchEngine } = require("./search");
const { CheckpointManager } = require("./checkpoint");

const routes = [
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
  "POST /batches/:id/complete",
  "GET /search?q=&code=&source=&damageType=&dateFrom=&dateTo=&kind=&pageSize=&cursor=&sessionId=",
  "GET /admin/search/status",
  "POST /admin/search/reindex"
];

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function createApp({ dataDir } = {}) {
  const store = await new Store(dataDir).load();
  const checkpointManager = new CheckpointManager(dataDir);
  const engine = new SearchEngine(store, { checkpointManager });
  // 启动即建立首代索引（存在检查点则续跑），保证服务起来后立刻可查。
  await engine.rebuild().catch((err) => {
    if (err.code !== "REBUILD_CANCELLED") console.error("初始索引建立失败:", err.message);
  });

  function send(res, status, body) {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  }

  async function parseBody(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const error = new Error("请求体必须是合法JSON");
      error.status = 400;
      throw error;
    }
  }

  function required(body, fields) {
    const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
    if (missing.length) {
      const error = new Error(`缺少字段：${missing.join(", ")}`);
      error.status = 400;
      throw error;
    }
  }

  function findRubbing(rubbingId) {
    const rubbing = store.data.rubbings.find((item) => item.id === rubbingId);
    if (!rubbing) {
      const error = new Error("拓片不存在");
      error.status = 404;
      throw error;
    }
    return rubbing;
  }

  function enrichBatch(batch) {
    const damages = store.data.damages.filter((item) => batch.damageIds.includes(item.id));
    return {
      ...batch,
      damages,
      total: damages.length,
      repaired: damages.filter((item) => item.status === "repaired").length,
      pending: damages.filter((item) => item.status !== "repaired").length
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const p = url.searchParams;

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, {
        ok: true,
        service: "rubbing-repair-api",
        routes,
        counts: {
          rubbings: store.data.rubbings.length,
          damages: store.data.damages.length,
          batches: store.data.batches.length
        }
      });
    }

    /* ---------------- 统一检索 ---------------- */
    if (req.method === "GET" && pathname === "/search") {
      const query = {
        q: p.get("q") || p.get("keyword") || "",
        code: p.get("code") || "",
        source: p.get("source") || "",
        damageType: p.get("damageType") || p.get("type") || "",
        kind: p.get("kind") || "",
        dateFrom: p.get("dateFrom") || p.get("from") || "",
        dateTo: p.get("dateTo") || p.get("to") || ""
      };
      const page = {
        pageSize: p.get("pageSize") ? Number(p.get("pageSize")) : undefined,
        cursor: p.get("cursor") ? Number(p.get("cursor")) : undefined,
        sessionId: p.get("sessionId") || undefined
      };
      const out = engine.searchPaged(query, page);
      return send(res, 200, out);
    }

    if (req.method === "GET" && pathname === "/admin/search/status") {
      return send(res, 200, {
        generation: engine.current.generation,
        docs: engine.current.docs.size,
        rubbings: store.data.rubbings.length,
        damages: store.data.damages.length,
        batches: store.data.batches.length,
        seq: store.seq,
        rebuilding: !!engine._rebuildPromise,
        sessions: engine.sessions.size
      });
    }

    if (req.method === "POST" && pathname === "/admin/search/reindex") {
      await parseBody(req).catch(() => ({}));
      if (engine._rebuildPromise) {
        return send(res, 409, { error: "索引重建正在进行中", generation: engine.current.generation });
      }
      const info = await engine.rebuild({ batchSize: 10000 });
      return send(res, 200, { ok: true, ...info });
    }

    /* ---------------- 拓片 ---------------- */
    if (req.method === "GET" && pathname === "/rubbings") {
      const data = store.data.rubbings.map((rubbing) => {
        const damages = store.data.damages.filter((item) => item.rubbingId === rubbing.id);
        return {
          ...rubbing,
          damageCount: damages.length,
          pendingDamages: damages.filter((item) => item.status !== "repaired").length
        };
      });
      return send(res, 200, { data });
    }

    if (req.method === "POST" && pathname === "/rubbings") {
      const body = await parseBody(req);
      required(body, ["code", "source", "paperSize"]);
      const rubbing = {
        id: makeId("rubbing"),
        code: body.code,
        source: body.source,
        paperSize: body.paperSize,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      await store.mutate(["upsertRubbing", rubbing]);
      return send(res, 201, { data: rubbing });
    }

    const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
    if (rubbingDamagesMatch && req.method === "GET") {
      const rubbingId = rubbingDamagesMatch[1];
      findRubbing(rubbingId);
      return send(res, 200, { data: store.data.damages.filter((item) => item.rubbingId === rubbingId) });
    }

    if (rubbingDamagesMatch && req.method === "POST") {
      const rubbingId = rubbingDamagesMatch[1];
      findRubbing(rubbingId);
      const body = await parseBody(req);
      required(body, ["position", "type", "beforePhotoUrl"]);
      const damage = {
        id: makeId("damage"),
        rubbingId,
        position: body.position,
        type: body.type,
        beforePhotoUrl: body.beforePhotoUrl,
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: new Date().toISOString(),
        repairedAt: null
      };
      await store.mutate(["upsertDamage", damage]);
      return send(res, 201, { data: damage });
    }

    /* ---------------- 缺损项 ---------------- */
    if (req.method === "GET" && pathname === "/damages") {
      const status = p.get("status");
      const type = p.get("type");
      const data = store.data.damages.filter(
        (item) => (!status || item.status === status) && (!type || item.type === type)
      );
      return send(res, 200, { data });
    }

    const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
    if (damagePatchMatch && req.method === "PATCH") {
      const id = damagePatchMatch[1];
      const damage = store.data.damages.find((item) => item.id === id);
      if (!damage) return send(res, 404, { error: "缺损项不存在" });
      const body = await parseBody(req);
      const updated = {
        ...damage,
        position: body.position ?? damage.position,
        type: body.type ?? damage.type,
        beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
        afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
        status: body.status ?? damage.status,
        repairNote: body.repairNote ?? damage.repairNote
      };
      updated.repairedAt = updated.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
      await store.mutate(["upsertDamage", updated]);
      return send(res, 200, { data: updated });
    }

    /* ---------------- 批次 ---------------- */
    if (req.method === "GET" && pathname === "/batches") {
      return send(res, 200, { data: store.data.batches.map((batch) => enrichBatch(batch)) });
    }

    if (req.method === "POST" && pathname === "/batches") {
      const body = await parseBody(req);
      required(body, ["name", "damageIds"]);
      if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
        return send(res, 400, { error: "damageIds必须是非空数组" });
      }
      const invalid = body.damageIds.filter((id) => !store.data.damages.find((damage) => damage.id === id));
      if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
      const batch = {
        id: makeId("batch"),
        name: body.name,
        status: "open",
        damageIds: body.damageIds,
        note: body.note || "",
        createdAt: new Date().toISOString(),
        completedAt: null
      };
      const ops = [["upsertBatch", batch]];
      for (const id of body.damageIds) {
        const damage = store.data.damages.find((d) => d.id === id);
        ops.push(["upsertDamage", { ...damage, batchId: batch.id, status: "in_repair" }]);
      }
      await store.mutate(ops);
      return send(res, 201, { data: enrichBatch(batch) });
    }

    const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
    if (batchMatch && req.method === "GET") {
      const batch = store.data.batches.find((item) => item.id === batchMatch[1]);
      if (!batch) return send(res, 404, { error: "修补批次不存在" });
      return send(res, 200, { data: enrichBatch(batch) });
    }

    const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
    if (completeMatch && req.method === "POST") {
      const batch = store.data.batches.find((item) => item.id === completeMatch[1]);
      if (!batch) return send(res, 404, { error: "修补批次不存在" });
      const body = await parseBody(req);
      const results = Array.isArray(body.results) ? body.results : [];
      const updatedBatch = {
        ...batch,
        status: "completed",
        completedAt: new Date().toISOString(),
        note: body.note ?? batch.note
      };
      const ops = [["upsertBatch", updatedBatch]];
      for (const id of batch.damageIds) {
        const damage = store.data.damages.find((d) => d.id === id);
        if (!damage) continue;
        const result = results.find((item) => item.damageId === id) || {};
        ops.push([
          "upsertDamage",
          {
            ...damage,
            status: "repaired",
            afterPhotoUrl: result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl,
            repairNote: result.repairNote || body.defaultRepairNote || damage.repairNote,
            repairedAt: new Date().toISOString()
          }
        ]);
      }
      await store.mutate(ops);
      return send(res, 200, { data: enrichBatch(updatedBatch) });
    }

    return send(res, 404, { error: "接口不存在", routes });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
  });

  server._store = store;
  server._engine = engine;
  server.shutdown = async () => {
    engine.close();
    await store.close();
    await new Promise((resolve) => server.close(resolve));
  };
  return server;
}

module.exports = { createApp, routes };
