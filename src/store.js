/**
 * 存储层：内存数据集 + append-only WAL + 快照压实，全部原子落盘。
 *
 * 目录文件：
 *   snapshot.json        最新快照 {"version":1,"seq":N,"data":{...}}
 *   wal.log              快照之后的增量日志，每行一条 JSON：{"seq":n,"op":[...]}
 *
 * 保证：
 *   - 写入串行化（writeLock 链），读永远拿到完整一致的内存快照（getSnapshot）。
 *   - 每条变更先 append WAL（fsync）再更新内存并通知订阅者；进程崩溃后回放 WAL 不丢。
 *   - 压实：写 snapshot.tmp → fsync → rename 原子替换 snapshot.json，再截断 WAL。
 *   - 旧版 data/db.json（单文件库）首次启动时自动迁移为基线快照。
 *   - 每条变更带单调递增 seq；记录变更后内存与索引同步更新，立刻可查。
 */
const EventEmitter = require("events");
const fsp = require("fs/promises");
const path = require("path");

const SNAPSHOT_FILE = "snapshot.json";
const SNAPSHOT_TMP = "snapshot.tmp";
const WAL_FILE = "wal.log";
const LEGACY_DB = "db.json";

const EMPTY_DATA = () => ({ rubbings: [], damages: [], batches: [] });

async function atomicWriteFile(file, content) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, content);
  const fh = await fsp.open(tmp, "r");
  try {
    await fh.sync();
  } catch {
    /* ignore */
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

function normalizeData(raw) {
  const data = raw || {};
  return {
    rubbings: Array.isArray(data.rubbings) ? data.rubbings : [],
    damages: Array.isArray(data.damages) ? data.damages : [],
    batches: Array.isArray(data.batches) ? data.batches : []
  };
}

/** 把一条 op 应用到数据集（纯函数，崩溃恢复与实时写入共用同一份逻辑）。 */
function applyOp(data, op) {
  const [type, ...args] = op;
  const upsert = (list, record) => {
    const idx = list.findIndex((item) => item.id === record.id);
    if (idx === -1) list.push(record);
    else Object.assign(list[idx], record); // 就地更新：既有引用保持最新
  };
  const remove = (list, id) => {
    const idx = list.findIndex((item) => item.id === id);
    if (idx !== -1) list.splice(idx, 1);
  };

  switch (type) {
    case "upsertRubbing":
      upsert(data.rubbings, args[0]);
      break;
    case "deleteRubbing":
      remove(data.rubbings, args[0]);
      break;
    case "upsertDamage":
      upsert(data.damages, args[0]);
      break;
    case "deleteDamage":
      remove(data.damages, args[0]);
      break;
    case "upsertBatch":
      upsert(data.batches, args[0]);
      break;
    case "deleteBatch":
      remove(data.batches, args[0]);
      break;
    case "bulk": {
      for (const sub of args[0]) applyOp(data, sub);
      break;
    }
    default:
      throw new Error(`未知的WAL操作: ${type}`);
  }
}

class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.snapshotPath = path.join(dataDir, SNAPSHOT_FILE);
    this.walPath = path.join(dataDir, WAL_FILE);
    this.data = EMPTY_DATA();
    this.seq = 0;
    this._chain = Promise.resolve();
    this._walFh = null;
    this._compactionThreshold = 2000; // WAL 超过该条数自动压实
    this._loaded = false;
  }

  async load() {
    await fsp.mkdir(this.dataDir, { recursive: true });

    let snap = null;
    try {
      snap = JSON.parse(await fsp.readFile(this.snapshotPath, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    if (!snap) {
      // 兼容旧版单文件 data/db.json：迁移为基线快照。
      const legacyPath = path.join(this.dataDir, LEGACY_DB);
      try {
        const legacy = JSON.parse(await fsp.readFile(legacyPath, "utf8"));
        snap = { version: 1, seq: 0, data: normalizeData(legacy), migratedFrom: LEGACY_DB };
        await atomicWriteFile(this.snapshotPath, JSON.stringify(snap, null, 2));
      } catch (err) {
        if (err.code !== "ENOENT") {
          // db.json 损坏时不要静默吞掉，但也不阻塞全新启动：仅在它确实存在时抛出。
          if (err instanceof SyntaxError) throw err;
          throw err;
        }
        snap = { version: 1, seq: 0, data: EMPTY_DATA() };
      }
    }

    this.data = normalizeData(snap.data);
    this.seq = snap.seq || 0;

    // 回放 WAL。末尾若有「写到一半」的残缺行（崩溃常见），忽略它并把
    // 原 WAL 留证为 wal.corrupt，前面已确认（fsync）的完整行全部生效。
    let walText = "";
    try {
      walText = await fsp.readFile(this.walPath, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    let walCount = 0;
    let sawCorruption = false;
    if (walText.trim()) {
      const lines = walText.split("\n");
      // 最后一个换行之后若还有内容，可能是残缺行。
      const tailPartial = walText.endsWith("\n") ? "" : lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          applyOp(this.data, entry.op);
          this.seq = Math.max(this.seq, entry.seq);
          walCount++;
        } catch {
          sawCorruption = true; // 理论上不会发生（整行落盘）
        }
      }
      if (tailPartial && tailPartial.trim()) {
        try {
          const entry = JSON.parse(tailPartial);
          applyOp(this.data, entry.op);
          this.seq = Math.max(this.seq, entry.seq);
          walCount++;
        } catch {
          sawCorruption = true;
        }
      }
    }
    if (sawCorruption) {
      // 旧 WAL 含残缺尾行：留证后移走，并立即把已回放成功的数据压实为快照，
      // 再以空 WAL 继续，保证这些「完整行」不会因 WAL 被移走而在重启后丢失。
      try {
        await fsp.rename(this.walPath, path.join(this.dataDir, "wal.corrupt"));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      await this.compact();
    }

    if (!this._walFh) this._walFh = await fsp.open(this.walPath, "a");
    this._loaded = true;
    if (!sawCorruption && walCount >= this._compactionThreshold) {
      this.compact().catch(() => {});
    }
    return this;
  }

  /** 一致性读：返回当前数据集的浅拷贝（数组为新数组，元素仍是同一记录引用——读侧不改记录）。 */
  getSnapshot() {
    return {
      rubbings: this.data.rubbings.slice(),
      damages: this.data.damages.slice(),
      batches: this.data.batches.slice()
    };
  }

  findById(kind, id) {
    return this.data[kind].find((item) => item.id === id) || null;
  }

  /**
   * 串行化写入。
   * @param {Array} opOrOps 单条 op（["upsertRubbing", {...}]）
   *        或多条 op 组成的数组（[["upsertRubbing",…],["upsertDamage",…]]，
   *        作为一个原子批次落一条 bulk 日志）。以首元素是否为字符串区分。
   * @returns {Promise<{seq:number, data:object}>}
   */
  mutate(opOrOps) {
    const list = typeof opOrOps[0] === "string" ? [opOrOps] : opOrOps;
    if (!list.length) return Promise.resolve({ seq: this.seq, data: this.getSnapshot() });

    const run = async () => {
      const bulkOp = list.length === 1 ? list[0] : ["bulk", list];
      this.seq += 1;
      const seq = this.seq;
      const line = JSON.stringify({ seq, op: bulkOp }) + "\n";
      if (!this._walFh) {
        this._walFh = await fsp.open(this.walPath, "a");
      }
      // 先持久化（append + fsync），再改内存 —— 崩溃也不丢已确认写入。
      await this._walFh.appendFile(line);
      await this._walFh.sync();
      applyOp(this.data, bulkOp);
      this.emit("change", { seq, op: bulkOp, data: this.data });
      // 压实不能在写链运行中同步等待（会与链尾新写入形成并发），
      // 而是把 compact 续接到链尾：当前写入立即返回，之后的写入自动排在压实之后。
      if (!this._compactQueued) {
        this._walLineCount()
          .then((walSize) => {
            if (walSize >= this._compactionThreshold) {
              this._compactQueued = true;
              this._chain = this._chain
                .then(() => this.compact())
                .catch(() => {})
                .then(() => {
                  this._compactQueued = false;
                });
            }
          })
          .catch(() => {});
      }
      return { seq, data: this.getSnapshot() };
    };

    // 上一笔失败不阻断后续写入；run 自身只执行一次（不能把 run 同时作为 reject 回调）。
    this._chain = this._chain.then(run, () => run());
    return this._chain;
  }

  async _walLineCount() {
    const stat = await fsp.stat(this.walPath).catch(() => null);
    if (!stat || stat.size === 0) return 0;
    const content = await fsp.readFile(this.walPath, "utf8");
    let n = 0;
    for (const line of content.split("\n")) if (line.trim()) n++;
    return n;
  }

  /** 快照压实：原子替换 snapshot.json 后清空 WAL；并发安全（同一写链之外也可手动调用）。 */
  async compact() {
    const snap = { version: 1, seq: this.seq, data: this.data };
    const tmpPath = path.join(this.dataDir, SNAPSHOT_TMP);
    await atomicWriteFile(tmpPath, JSON.stringify(snap));
    await fsp.rename(tmpPath, this.snapshotPath);
    // 截断 WAL（rename 快照后）。
    if (this._walFh) {
      try {
        await this._walFh.close();
      } catch {
        /* ignore */
      }
      this._walFh = null;
    }
    await fsp.writeFile(this.walPath, "");
    this._walFh = await fsp.open(this.walPath, "a");
  }

  async close() {
    await this._chain.catch(() => {});
    if (this._walFh) {
      try {
        await this._walFh.close();
      } catch {
        /* ignore */
      }
      this._walFh = null;
    }
  }
}

module.exports = { Store, applyOp, normalizeData, EMPTY_DATA, atomicWriteFile };
