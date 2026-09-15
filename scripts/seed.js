/**
 * 十万级测试数据生成脚本（确定性，零依赖）。
 *
 * 用法：
 *   node scripts/seed.js --count=100000          # 默认写入独立目录 data-perf
 *   DATA_DIR=./data-perf node scripts/seed.js --count=100000 --wipe
 *
 * 直接写存储层（绕过 HTTP），批量 append WAL 以保证生成速度；
 * 生成后可启动服务，由启动时的索引重建（或 POST /admin/search/reindex）建索引。
 * 为让「立即可查」，脚本末尾会触发一次索引构建并打印耗时。
 *
 * @example
 *   node scripts/seed.js --count=100000 --wipe
 *   DATA_DIR=./data-perf PORT=3021 node server.js
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Store } = require("../src/store");
const { SearchEngine } = require("../src/search");
const { CheckpointManager } = require("../src/checkpoint");

function parseArgs(argv) {
  const out = { count: 100000, wipe: false, dataDir: process.env.DATA_DIR || path.join(__dirname, "..", "data-perf"), noIndex: false };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === "count") out.count = Number(m[2]);
    if (m[1] === "wipe") out.wipe = true;
    if (m[1] === "dir") out.dataDir = m[2];
    if (m[1] === "no-index") out.noIndex = true;
  }
  return out;
}

// 确定性 LCG，保证每次生成数据分布一致，便于性能基准对比。
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SOURCES = [
  "地方碑刻残页", "馆藏拓片征集", "考古发掘出土", "民间捐赠旧拓",
  "寺院经幢拓本", "地方志石刻", "摩崖石刻拓片", "墓誌銘拓本"
];
const DAMAGE_TYPES = ["虫蛀孔", "撕裂", "霉变", "缺损", "水渍", "折痕断裂", "烟熏变色", "墨迹脱落"];
const POSITIONS = ["左上角", "下边缘中央", "右上角题字旁", "中部折痕处", "右侧边缘", "碑额位置", "左下角", "正文第三列"];
const DYNASTIES = ["清", "明", "宋", "唐", "元", "漢", "魏"];
const NOTES = ["边缘有旧折痕", "纸色偏黄", "保存状态一般", "曾做过托裱", "墨色较浓", "局部酥脆", "背面有旧衬纸", ""];

function isoFromDaysAgo(rand, maxDaysAgo) {
  const days = Math.floor(rand() * maxDaysAgo);
  const d = new Date("2026-09-15T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
  return d.toISOString();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.wipe && fs.existsSync(args.dataDir)) {
    await fsp.rm(args.dataDir, { recursive: true, force: true });
  }
  await fsp.mkdir(args.dataDir, { recursive: true });

  const store = await new Store(args.dataDir).load();
  const rand = lcg(20260915);

  const rubbingCount = Math.max(1, Math.floor(args.count / 3));
  const damageCount = Math.max(0, args.count - rubbingCount - Math.floor(args.count / 12));
  const batchCount = Math.max(0, Math.floor(args.count / 12));

  console.log(`生成：拓片 ${rubbingCount}，缺损 ${damageCount}，批次 ${batchCount}，合计 ${rubbingCount + damageCount + batchCount}`);

  const t0 = Date.now();
  let BATCH = 2000;
  let ops = [];
  let written = 0;
  const flush = async () => {
    if (!ops.length) return;
    await store.mutate(ops);
    ops = [];
  };

  const rubbingIds = [];
  for (let i = 0; i < rubbingCount; i++) {
    const id = `rub_seed_${String(i).padStart(7, "0")}`;
    rubbingIds.push(id);
    const dynasty = DYNASTIES[Math.floor(rand() * DYNASTIES.length)];
    ops.push([
      "upsertRubbing",
      {
        id,
        code: `TP-${dynasty}-${String(i % 1000).padStart(3, "0")}`,
        source: SOURCES[Math.floor(rand() * SOURCES.length)],
        paperSize: `${30 + Math.floor(rand() * 40)}x${50 + Math.floor(rand() * 50)}cm`,
        note: NOTES[Math.floor(rand() * NOTES.length)],
        createdAt: isoFromDaysAgo(rand, 365 * 5)
      }
    ]);
    if (ops.length >= BATCH) {
      await flush();
      written += BATCH;
      if (written % 20000 < BATCH) console.log(`  已写入 ${written} …`);
    }
  }

  const damageIds = [];
  for (let i = 0; i < damageCount; i++) {
    const id = `dmg_seed_${String(i).padStart(7, "0")}`;
    damageIds.push(id);
    const rubbingId = rubbingIds[Math.floor(rand() * rubbingIds.length)];
    ops.push([
      "upsertDamage",
      {
        id,
        rubbingId,
        position: POSITIONS[Math.floor(rand() * POSITIONS.length)],
        type: DAMAGE_TYPES[Math.floor(rand() * DAMAGE_TYPES.length)],
        beforePhotoUrl: `https://example.local/before/${i}.jpg`,
        afterPhotoUrl: "",
        status: rand() > 0.4 ? "pending" : "repaired",
        repairNote: "",
        batchId: null,
        createdAt: isoFromDaysAgo(rand, 365 * 5),
        repairedAt: rand() > 0.4 ? isoFromDaysAgo(rand, 365 * 2) : null
      }
    ]);
    if (ops.length >= BATCH) {
      await flush();
      written += BATCH;
      if (written % 20000 < BATCH) console.log(`  已写入 ${written} …`);
    }
  }

  for (let i = 0; i < batchCount; i++) {
    const size = 1 + Math.floor(rand() * 6);
    const damageIdsBatch = [];
    for (let j = 0; j < size; j++) damageIdsBatch.push(damageIds[Math.floor(rand() * damageIds.length)]);
    ops.push([
      "upsertBatch",
      {
        id: `bat_seed_${String(i).padStart(7, "0")}`,
        name: `${2024 + (i % 3)}年第${i + 1}批修补`,
        status: rand() > 0.5 ? "open" : "completed",
        damageIds: damageIdsBatch,
        note: "",
        createdAt: isoFromDaysAgo(rand, 365 * 3),
        completedAt: null
      }
    ]);
    if (ops.length >= BATCH) {
      await flush();
      written += BATCH;
    }
  }
  await flush();
  console.log(`数据写入完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，seq=${store.seq}`);

  // 压实一次，让后续服务启动直接读快照，不必回放整条 WAL。
  await store.compact();

  if (!args.noIndex) {
    const engine = new SearchEngine(store, { checkpointManager: new CheckpointManager(args.dataDir) });
    const ti = Date.now();
    const info = await engine.rebuild({ batchSize: 10000 });
    console.log(`索引构建完成：${info.docs} 条，用时 ${((Date.now() - ti) / 1000).toFixed(2)}s`);
    // 抽样查询，打印单次耗时
    const probes = ["虫蛀孔", "TP-清", "地方碑刻", "撕裂", "2025年"];
    for (const q of probes) {
      const r = engine.search({ q });
      console.log(`  查询「${q}」 → ${r.total} 条，${r.tookMs} ms`);
    }
    engine.close();
  }
  await store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
