/**
 * 测试辅助：临时目录 + 直接构造数据集。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");
const { SearchEngine } = require("../src/search");
const { CheckpointManager } = require("../src/checkpoint");

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rubbing-${name || "test"}-`));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

async function setupStore(dir) {
  const store = await new Store(dir).load();
  return store;
}

async function seedArchive(store) {
  const ops = [];
  const rubbings = [
    { id: "r1", code: "TP-清-014", source: "地方碑刻残页", paperSize: "42x68cm", note: "边缘旧折痕", createdAt: day(10) },
    { id: "r2", code: "TP-明-201", source: "馆藏拓片征集", paperSize: "38x60cm", note: "保存完好", createdAt: day(40) },
    { id: "r3", code: "TB-宋-007", source: "考古发掘出土", paperSize: "50x90cm", note: "大幅摩崖", createdAt: day(100) }
  ];
  const damages = [
    { id: "d1", rubbingId: "r1", position: "左上角第3列题字旁", type: "虫蛀孔", beforePhotoUrl: "b1", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: day(11), repairedAt: null },
    { id: "d2", rubbingId: "r1", position: "下边缘中央", type: "撕裂", beforePhotoUrl: "b2", afterPhotoUrl: "", status: "pending", repairNote: "", batchId: null, createdAt: day(12), repairedAt: null },
    { id: "d3", rubbingId: "r2", position: "右上角", type: "霉变", beforePhotoUrl: "b3", afterPhotoUrl: "a3", status: "repaired", repairNote: "已除菌", batchId: null, createdAt: day(41), repairedAt: day(60) }
  ];
  const batches = [
    { id: "b1", name: "六月小批修补", status: "completed", damageIds: ["d3"], note: "首批", createdAt: day(55), completedAt: day(60) }
  ];
  for (const r of rubbings) ops.push(["upsertRubbing", r]);
  for (const d of damages) ops.push(["upsertDamage", d]);
  for (const b of batches) ops.push(["upsertBatch", b]);
  await store.mutate(ops);
  return { rubbings, damages, batches };
}

async function setupEngine(dir) {
  const store = await setupStore(dir);
  await seedArchive(store);
  const engine = new SearchEngine(store, { checkpointManager: new CheckpointManager(dir) });
  await engine.rebuild();
  return { store, engine };
}

/** 直接在内存构造 N 条文档（不落盘），用于性能测试。 */
function makePerfDocs(n) {
  const { buildDoc } = require("../src/search");
  const sources = ["地方碑刻残页", "馆藏拓片征集", "考古发掘出土", "民间捐赠旧拓", "寺院经幢拓本", "地方志石刻", "摩崖石刻拓片", "墓誌銘拓本"];
  const types = ["虫蛀孔", "撕裂", "霉变", "缺损", "水渍", "折痕断裂", "烟熏变色", "墨迹脱落"];
  const dynasties = ["清", "明", "宋", "唐", "元"];
  const db = { rubbings: [], damages: [], batches: [] };
  const nR = Math.floor(n / 3);
  const nD = n - nR - Math.floor(n / 12);
  const nB = n - nR - nD;
  for (let i = 0; i < nR; i++) {
    db.rubbings.push({
      id: `r${i}`,
      code: `TP-${dynasties[i % dynasties.length]}-${String(i % 1000).padStart(3, "0")}`,
      source: sources[i % sources.length],
      paperSize: "40x70cm",
      note: i % 5 === 0 ? "边缘旧折痕" : "",
      createdAt: new Date(Date.UTC(2024, i % 12, (i % 27) + 1)).toISOString()
    });
  }
  for (let i = 0; i < nD; i++) {
    db.damages.push({
      id: `d${i}`,
      rubbingId: `r${i % nR}`,
      position: ["左上角", "下边缘中央", "右上角", "中部折痕"][i % 4],
      type: types[i % types.length],
      status: i % 3 === 0 ? "repaired" : "pending",
      repairNote: "",
      createdAt: new Date(Date.UTC(2024, i % 12, (i % 27) + 1)).toISOString(),
      repairedAt: null
    });
  }
  for (let i = 0; i < nB; i++) {
    db.batches.push({
      id: `b${i}`,
      name: `2025年第${i + 1}批修补`,
      status: "open",
      damageIds: [],
      note: "",
      createdAt: new Date(Date.UTC(2025, i % 12, (i % 27) + 1)).toISOString(),
      completedAt: null
    });
  }
  const docs = [
    ...db.rubbings.map((r) => buildDoc(r, "rubbing", db)),
    ...db.damages.map((d) => buildDoc(d, "damage", db)),
    ...db.batches.map((b) => buildDoc(b, "batch", db))
  ];
  return { db, docs };
}

module.exports = { tmpDir, rmrf, day, setupStore, seedArchive, setupEngine, makePerfDocs };
