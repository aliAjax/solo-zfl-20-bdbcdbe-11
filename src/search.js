/**
 * 检索引擎：统一索引拓片 / 缺损项 / 修补批次三类档案。
 *
 * 设计：
 *  - 每条档案构造成统一 Doc：{kind, id, code, source, damageType, dates, createdAt, …}
 *  - 倒排索引 gram -> Map(docKey -> tf)，覆盖：编号(code)、来源(source)、
 *    病害类型(damageType) 及其他可检索文本（名称、位置、备注等）。
 *  - 查询归一化（全半角/繁简/大小写/空格差异全部消除），gram 求交并/候选集，
 *    再做字段级精确与「错一个字」模糊校验（编辑距离 ≤1）。
 *  - 评分排序：字段权重 + 完全包含/词边界 + 错字惩罚；同分按
 *    createdAt 升序、code 升序、id 升序稳定排列。
 *  - 世代（generation）：索引整体是不可变快照，写入经 applyOp 增量维护「当前代」；
 *    重建期间旧代继续提供查询，重建完成后原子切换，查询永远读不到半成品。
 */
const { normalize, tokenize, segments, fuzzyContains } = require("./normalize");

const KIND_WEIGHT = { code: 10, damageType: 8, source: 6, name: 4, other: 2 };
const KIND_LABEL = {
  rubbing: "拓片",
  damage: "缺损项",
  batch: "修补批次"
};

/** 取缺损项关联拓片（用于把拓片编号/来源带入缺损文档）。 */
function rubbingOf(db, rubbingId) {
  if (db._rubbingById) return db._rubbingById.get(rubbingId) || null;
  return db.rubbings.find((item) => item.id === rubbingId) || null;
}

/**
 * 把三类记录构造成统一检索文档。返回多条时（批次按其缺损项展开时间维度）
 * 以主键去重，这里每条业务记录恰好一条 Doc。
 */
function buildDoc(record, kind, db) {
  if (kind === "rubbing") {
    return {
      kind,
      key: `${kind}:${record.id}`,
      id: record.id,
      code: record.code || "",
      source: record.source || "",
      damageType: "",
      name: record.note || "",
      other: [record.paperSize].filter(Boolean).join(" "),
      dates: [record.createdAt].filter(Boolean),
      createdAt: record.createdAt || ""
    };
  }
  if (kind === "damage") {
    const rubbing = rubbingOf(db, record.rubbingId);
    return {
      kind,
      key: `${kind}:${record.id}`,
      id: record.id,
      code: rubbing ? rubbing.code : "",
      source: rubbing ? rubbing.source : "",
      damageType: record.type || "",
      name: record.position || "",
      other: [record.repairNote, record.status].filter(Boolean).join(" "),
      dates: [record.createdAt, record.repairedAt].filter(Boolean),
      createdAt: record.createdAt || "",
      rubbingId: record.rubbingId || null
    };
  }
  // batch
  return {
    kind,
    key: `${kind}:${record.id}`,
    id: record.id,
    code: record.id, // 批次没有独立编号，以其 id 作为编号检索维度
    source: "",
    damageType: "",
    name: record.name || "",
    other: [record.note, record.status].filter(Boolean).join(" "),
    dates: [record.createdAt, record.completedAt].filter(Boolean),
    createdAt: record.createdAt || ""
  };
}

function docFields(doc) {
  return [
    { key: "code", value: doc.code, weight: KIND_WEIGHT.code },
    { key: "damageType", value: doc.damageType, weight: KIND_WEIGHT.damageType },
    { key: "source", value: doc.source, weight: KIND_WEIGHT.source },
    { key: "name", value: doc.name, weight: KIND_WEIGHT.name },
    { key: "other", value: doc.other, weight: KIND_WEIGHT.other }
  ].filter((f) => f.value);
}

class SearchIndex {
  constructor() {
    this.generation = 0;
    this.docs = new Map(); // key -> {doc, fields: [{key,weight,raw,fi}]}
    this.postings = new Map(); // gram -> Set(key)
    this.fiCache = new Map(); // 原始字段值 -> {norm, grams}（type/source/code 重复度极高）
    this.stats = { docs: 0, generations: 0 };
  }

  fieldIndex(value) {
    let fi = this.fiCache.get(value);
    if (!fi) {
      const norm = normalize(value);
      fi = { norm, grams: new Set(tokenize(norm)) };
      this.fiCache.set(value, fi);
    }
    return fi;
  }

  addDoc(doc) {
    if (this.docs.has(doc.key)) this.removeDoc(doc.key);
    const fields = docFields(doc).map((f) => ({
      key: f.key,
      weight: f.weight,
      raw: f.value,
      fi: this.fieldIndex(f.value)
    }));
    this.docs.set(doc.key, { doc, fields });
    for (const f of fields) {
      for (const g of f.fi.grams) {
        let posting = this.postings.get(g);
        if (!posting) {
          posting = new Set();
          this.postings.set(g, posting);
        }
        posting.add(doc.key);
      }
    }
    this.stats.docs = this.docs.size;
  }

  removeDoc(key) {
    const entry = this.docs.get(key);
    if (!entry) return;
    for (const f of entry.fields) {
      for (const g of f.fi.grams) {
        const posting = this.postings.get(g);
        if (!posting) continue;
        posting.delete(key);
        if (posting.size === 0) this.postings.delete(g);
      }
    }
    this.docs.delete(key);
    this.stats.docs = this.docs.size;
  }

  allKeys() {
    return new Set(this.docs.keys());
  }
}

/**
 * 搜索引擎。持有「当前代」索引，重建时产生新代并原子替换。
 */
class SearchEngine {
  constructor(store, { checkpointManager = null } = {}) {
    this.store = store;
    this.checkpointManager = checkpointManager;
    this.current = new SearchIndex();
    this.current.generation = 1;
    // 三类记录 id -> record 查找表（不可枚举，不进 JSON 快照），
    // 让缺损关联拓片与结果呈现都从 O(n) 降为 O(1)。store 的 upsert
    // 为就地 Object.assign，Map 持有的引用始终是最新值。
    this._byId = {
      rubbings: new Map(this.store.data.rubbings.map((r) => [r.id, r])),
      damages: new Map(this.store.data.damages.map((r) => [r.id, r])),
      batches: new Map(this.store.data.batches.map((r) => [r.id, r]))
    };
    Object.defineProperty(this.store.data, "_rubbingById", {
      value: this._byId.rubbings,
      enumerable: false,
      writable: true,
      configurable: true
    });
    this.sessions = new Map();
    this._rebuildPromise = null;
    // 周期性清理过期分页会话；unref 让定时器不阻止进程退出。
    this._sessionTimer = setInterval(() => this.cleanupSessions(), 60 * 1000);
    if (typeof this._sessionTimer.unref === "function") this._sessionTimer.unref();
    this._applyStoreChange = ({ op }) => {
      // 维护 id 查找表（store upsert 为就地 Object.assign，既有引用自动最新）
      const upsertMap = { upsertRubbing: "rubbings", upsertDamage: "damages", upsertBatch: "batches" };
      const deleteMap = { deleteRubbing: "rubbings", deleteDamage: "damages", deleteBatch: "batches" };
      const touch = (t, recOrId) => {
        if (upsertMap[t]) {
          const name = upsertMap[t];
          const live = this.store.data[name].find((r) => r.id === recOrId.id) || recOrId;
          this._byId[name].set(recOrId.id, live);
        } else if (deleteMap[t]) {
          this._byId[deleteMap[t]].delete(recOrId);
        }
      };
      if (op[0] === "bulk") for (const sub of op[1]) touch(sub[0], sub[1]);
      else touch(op[0], op[1]);

      // 在线增量维护。重建期间两代都要更新：
      //  - current（旧代）保证重建期间查询也能立刻看到变更；
      //  - pending（新代）保证切换后不丢重建窗口内的写入；
      //  - pendingIdMaps 让主循环对重建期间的增删取到最新存活记录。
      this._applyOpToIndex(this.current, op);
      if (this._pending) this._applyOpToIndex(this._pending, op);
      if (this._pendingIdMaps) this._applyOpToIdMaps(this._pendingIdMaps, op);
      // 拓片编号/来源变更会改变其缺损文档的冗余字段，级联重建相关缺损。
      this._cascadeRubbingChange(this.current, op);
      if (this._pending) this._cascadeRubbingChange(this._pending, op);
    };
    this.store.on("change", this._applyStoreChange);
  }

  _cascadeRubbingChange(index, op) {
    const [type, ...args] = op;
    const ops = type === "bulk" ? args[0] : [op];
    for (const [t, rec] of ops) {
      if (t !== "upsertRubbing" || !rec || (!("code" in rec) && !("source" in rec))) continue;
      for (const d of this.store.data.damages) {
        if (d.rubbingId === rec.id) index.addDoc(buildDoc(d, "damage", this.store.data));
      }
    }
  }

  _applyOpToIndex(index, op) {
    const [type, ...args] = op;
    const db = this.store.data;
    const kinds = {
      upsertRubbing: "rubbings",
      upsertDamage: "damages",
      upsertBatch: "batches"
    };
    if (type === "bulk") {
      for (const sub of args[0]) this._applyOpToIndex(index, sub);
      return;
    }
    if (kinds[type]) {
      // upsert 的记录已在内存中（change 在 applyOp 之后触发），直接用传入记录建文档。
      const kind = kinds[type].replace(/s$/, "");
      index.addDoc(buildDoc(args[0], kind, db));
      return;
    }
    const delKind = {
      deleteRubbing: "rubbings",
      deleteDamage: "damages",
      deleteBatch: "batches"
    }[type];
    if (delKind) {
      const kind = delKind.replace(/s$/, "");
      index.removeDoc(`${kind}:${args[0]}`);
    }
  }

  _applyOpToIdMaps(idMaps, op) {
    const [type, ...args] = op;
    const db = this.store.data;
    const mapOf = { upsertRubbing: 0, upsertDamage: 1, upsertBatch: 2 };
    const delOf = { deleteRubbing: 0, deleteDamage: 1, deleteBatch: 2 };
    if (type === "bulk") {
      for (const sub of args[0]) this._applyOpToIdMaps(idMaps, sub);
    } else if (mapOf[type] !== undefined) {
      const rec = args[0];
      const name = ["rubbings", "damages", "batches"][mapOf[type]];
      const live = db[name].find((item) => item.id === rec.id) || rec;
      idMaps[mapOf[type]].set(rec.id, live);
    } else if (delOf[type] !== undefined) {
      idMaps[delOf[type]].delete(args[0]);
    }
  }

  /**
   * 全量（再）建索引，支持断点续跑。
   * @param {object} opts {onProgress, batchSize}  进度回调与每批条数
   *
   * 并发模型：
   *  - 重建在新的 pending 索引上进行，current 旧代始终可查（读不到半成品）；
   *  - 重建期间的写入经 change 监听同时更新两代（见构造函数监听器）；
   *  - 以稳定 ID 快照为遍历基准，断点记录 [段,偏移]，中断后续跑，末尾追平差异。
   */
  rebuild(opts = {}) {
    if (this._rebuildPromise) return this._rebuildPromise;
    const batchSize = opts.batchSize || 5000;

    this._rebuildPromise = (async () => {
      const sections = ["rubbing", "damage", "batch"];
      const listName = ["rubbings", "damages", "batches"];

      // 续跑：复用同进程内「被中断但保留」的半成品索引，从断点后继续。
      let pending;
      let ids;
      let startSection;
      let startOffset;
      let resumed = false;

      if (this._pausedRebuild) {
        const saved = this._pausedRebuild.cp;
        pending = this._pausedRebuild.pending;
        ids = this._pausedRebuild.ids;
        startSection = saved.section || 0;
        startOffset = saved.offset || 0;
        resumed = true;
        this._pausedRebuild = null;
      } else {
        pending = new SearchIndex();
        // 稳定 ID 基准：进程重启后磁盘检查点存在也从头幂等重建
        // （新索引内存为空，无法只补后半段；addDoc 幂等，最终不漏不重）。
        const cp = this.checkpointManager ? await this.checkpointManager.load() : null;
        ids = cp && Array.isArray(cp.ids) ? cp.ids : listName.map((name) => this.store.data[name].map((r) => r.id));
        startSection = 0;
        startOffset = 0;
      }
      pending.generation = this.current.generation + 1;
      // 重建期间两代并行维护：旧代（current）让在线查询立刻看到新写入，
      // 新代（pending）保证切换后包含重建窗口内的全部变更。
      this._pending = pending;

      try {
        const total = ids.flat().length;
        let done = 0;
        for (let s = 0; s < startSection; s++) done += ids[s].length;
        done += startOffset;

        // id -> record 映射随 change 监听实时维护，主循环 O(1) 取存活记录，
        // 同时保证重建期间被删除的记录不会被重新加回。
        const idMaps = listName.map((name) => {
          const m = new Map();
          for (const r of this.store.data[name]) m.set(r.id, r);
          return m;
        });
        this._pendingIdMaps = idMaps;

        for (let s = startSection; s < sections.length; s++) {
          const kind = sections[s];
          const idMap = idMaps[s];
          const start = s === startSection ? startOffset : 0;
          for (let i = start; i < ids[s].length; i++) {
            const record = idMap.get(ids[s][i]); // 已删则 undefined，跳过
            if (record) pending.addDoc(buildDoc(record, kind, this.store.data));
            done++;
            if (done % batchSize === 0 || i + 1 === ids[s].length) {
              const nextCp = {
                section: i + 1 === ids[s].length ? s + 1 : s,
                offset: i + 1 === ids[s].length ? 0 : i + 1,
                ids,
                done,
                total
              };
              if (this.checkpointManager) await this.checkpointManager.save(nextCp);
              if (opts.onProgress) opts.onProgress({ done, total });
              if (this._cancelRequested) {
                // 中断：半成品索引与断点保留在内存（并继续接收写入更新），供同进程续跑。
                this._pausedRebuild = { pending, ids, cp: nextCp };
                const err = new Error("索引重建已取消（断点已保留，可续跑）");
                err.code = "REBUILD_CANCELLED";
                err.checkpoint = nextCp;
                throw err;
              }
              await new Promise((r) => setImmediate(r));
            }
          }
        }

        // pending 在整个重建期间经 change 监听器实时同步了全部 upsert/delete，
        // 与当前数据天然一致，无需再做全量追平（避免 O(n) 二次遍历）。

        // 原子切换世代：此前所有查询都走旧代，读不到半成品。
        pending.generation = this.current.generation + 1;
        pending.stats.generations = pending.generation;
        this.current = pending;
        this.stats = pending.stats;
        if (this.checkpointManager) await this.checkpointManager.clear();
        return { generation: pending.generation, docs: pending.docs.size, resumed, total };
      } finally {
        if (!this._pausedRebuild) {
          this._pending = null;
          this._pendingIdMaps = null;
        }
        // 取消时保留 _pending/_pendingIdMaps，让暂停期间的写入继续同步到半成品。
        this._cancelRequested = false;
        this._rebuildPromise = null;
      }
    })();

    return this._rebuildPromise;
  }

  cancelRebuild() {
    this._cancelRequested = true;
  }

  close() {
    if (this._sessionTimer) clearInterval(this._sessionTimer);
    this.sessions.clear();
  }

  /**
   * 查询入口（不分页，返回全部匹配）。HTTP 层通常调用 searchPaged。
   * @param {object} q 见 README：q/code/source/damageType/kind/dateFrom/dateTo
   */
  search(q = {}) {
    const { hits, tookMs, generation } = this._collect(q);
    const results = hits.map((h) => this._present(h));
    return { results, total: results.length, tookMs, generation };
  }

  /**
   * 分页查询（会话式快照）。
   *
   * 首次请求（无 sessionId）执行查询，把命中的有序「结果快照」存入会话；
   * 之后翻页（带 sessionId + cursor）从同一份快照切片。
   * 因此翻页期间数据有增改：同一查询既不会重复也不会漏项
   * （新增项落在新查询里；删除项在会话中标记 isDeleted，不占位以外的影响）。
   *
   * @param {object} q 查询参数
   * @param {object} page {sessionId?, cursor?, pageSize?}
   */
  searchPaged(q = {}, page = {}) {
    const t0 = Date.now();
    const pageSize = clampPageSize(page.pageSize);
    let session = null;
    let created = false;
    if (page.sessionId) {
      session = this.sessions.get(page.sessionId);
      if (!session) {
        const err = new Error("分页会话不存在或已过期，请重新发起查询");
        err.status = 400;
        throw err;
      }
    }
    if (!session) {
      const { hits, generation } = this._collect(q);
      session = {
        id: makeSessionId(),
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
        query: normalizeQueryKey(q),
        params: q,
        generation,
        items: hits.map((h) => ({
          kind: h.doc.kind,
          id: h.doc.id,
          score: h.score,
          reasons: h.reasons,
          // 冗余稳定排序键与会话时刻字段，保证即使记录后来被删也不影响顺序
          createdAt: h.doc.createdAt,
          code: h.doc.code
        }))
      };
      this.sessions.set(session.id, session);
      created = true;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS; // 翻页即续期

    const cursor = Number.isInteger(page.cursor) ? page.cursor : 0;
    const start = Math.max(0, cursor);
    const slice = session.items.slice(start, start + pageSize);
    const results = slice.map((item, i) => {
      const presented = this._presentItem(item);
      presented.cursor = start + i;
      return presented;
    });
    const nextCursor = start + pageSize;
    return {
      data: results,
      total: session.items.length,
      tookMs: Date.now() - t0,
      generation: session.generation,
      page: {
        sessionId: session.id,
        pageSize,
        cursor: start,
        nextCursor: nextCursor < session.items.length ? nextCursor : null,
        hasMore: nextCursor < session.items.length,
        index: Math.floor(start / pageSize) + 1
      },
      sessionCreated: created
    };
  }

  endSession(sessionId) {
    if (sessionId) this.sessions.delete(sessionId);
  }

  cleanupSessions(now = Date.now()) {
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(id);
    }
  }

  /**
   * 执行一次查询，返回未呈现、已排序的命中列表。
   * 纯计算、同步（倒排 + 滑窗均为内存操作），十万级数据亚秒完成。
   */
  _collect(q = {}) {
    const t0 = Date.now();
    const index = this.current; // 查询期间固定世代：并发重建/写入都不换表
    const kinds = parseKinds(q.kind);
    const dateFrom = q.dateFrom ? Date.parse(q.dateFrom) : null;
    const dateTo = q.dateTo ? Date.parse(q.dateTo) : null;
    if ((q.dateFrom && Number.isNaN(dateFrom)) || (q.dateTo && Number.isNaN(dateTo))) {
      const err = new Error("时间范围格式无法解析，请使用 ISO 日期，如 2026-01-01");
      err.status = 400;
      throw err;
    }

    const fieldQueries = [];
    const pushField = (key, text) => {
      if (text === undefined || text === null || String(text).trim() === "") return;
      fieldQueries.push({ key, raw: String(text), norm: normalize(text) });
    };
    pushField("code", q.code);
    pushField("source", q.source);
    pushField("damageType", q.damageType);
    const freeText = q.q || q.query || q.keyword || q.qText || "";
    const freeNorm = normalize(freeText);

    // 候选集：查询被拆为若干「分段」（拉丁 token / CJK 段），分段之间 AND，
    // 同一分段内 bigram/unigram 取并集（错一字也能通过未受损的相邻 gram 召回）。
    let candidates = null;
    const intersect = (set) => {
      if (!set.size) {
        candidates = new Set();
        return;
      }
      if (candidates === null) candidates = new Set(set);
      else for (const k of candidates) if (!set.has(k)) candidates.delete(k);
    };
    const fieldHasGram = (docKey, fieldName, g) => {
      const entry = index.docs.get(docKey);
      return !!(entry && entry.fields.some((f) => f.key === fieldName && f.fi.grams.has(g)));
    };
    const addSegmentCandidates = (norm, fieldKey) => {
      const { latin, cjk } = segments(norm);
      const segs = [
        ...latin.map((t) => ({ type: "latin", grams: [t] })),
        ...cjk.map((c) => {
          if (c.length === 1) return { type: "cjk", grams: [c] };
          // bigram 为主（AND 召回仍精确），另加首尾 unigram 覆盖边界错字。
          const chars = [...c];
          const grams = [];
          for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i] + chars[i + 1]);
          grams.push(chars[0], chars[chars.length - 1]);
          return { type: "cjk", grams: [...new Set(grams)] };
        })
      ];
      for (const seg of segs) {
        const union = new Set();
        for (const g of seg.grams) {
          const posting = index.postings.get(g);
          if (!posting) continue;
          if (!fieldKey) {
            for (const key of posting.keys()) union.add(key);
          } else {
            for (const key of posting.keys()) if (fieldHasGram(key, fieldKey, g)) union.add(key);
          }
        }
        intersect(union);
        if (candidates && candidates.size === 0) break;
      }
    };

    for (const fq of fieldQueries) addSegmentCandidates(fq.norm, fq.key);
    if (freeNorm) addSegmentCandidates(freeNorm, null);
    if (candidates === null) candidates = index.allKeys();

    const hits = [];
    for (const key of candidates) {
      const entry = index.docs.get(key);
      if (!entry) continue;
      const doc = entry.doc;
      if (kinds && !kinds.has(doc.kind)) continue;
      if (dateFrom !== null || dateTo !== null) {
        const inRange = doc.dates.some((d) => {
          const t = Date.parse(d);
          if (Number.isNaN(t)) return false;
          if (dateFrom !== null && t < dateFrom) return false;
          if (dateTo !== null && t > dateTo) return false;
          return true;
        });
        if (!inRange) continue;
      }
      const match = this._scoreEntry(entry, fieldQueries, freeNorm, freeText);
      if (!match) continue;
      hits.push({ doc, score: match.score, reasons: match.reasons });
    }

    hits.sort((a, b) => compareDocs(a, b));
    return { hits, tookMs: Date.now() - t0, generation: index.generation };
  }

  _scoreEntry(entry, fieldQueries, freeNorm, freeText) {
    let score = 0;
    const reasons = [];
    let matched = true;

    const scoreField = (targetKey, norm) => {
      const targets = targetKey ? entry.fields.filter((f) => f.key === targetKey) : entry.fields;
      if (!targets.length) return null;
      let best = null;
      for (const f of targets) {
        const exact = f.fi.norm.includes(norm);
        let distance = Infinity;
        let window = "";
        let hit = false;
        if (exact) {
          hit = true;
          distance = 0;
          window = norm;
        } else {
          const fm = fuzzyContains(norm, f.fi.norm, 1);
          if (fm.matched) {
            hit = true;
            distance = fm.distance;
            window = fm.window;
          }
        }
        if (!hit) continue;
        // 完全相等加权最高；包含次之；错字按编辑距离惩罚。
        let s = f.weight * 10;
        if (f.fi.norm === norm) s += 20;
        else if (exact) s += 8;
        if (distance >= 1) s -= 6 + distance * 4;
        if (!best || s > best.score) best = { field: f.key, score: s, distance, window };
      }
      return best;
    };

    for (const fq of fieldQueries) {
      const r = scoreField(fq.key, fq.norm);
      if (!r) {
        matched = false;
        break;
      }
      score += r.score;
      reasons.push({
        field: fieldLabel(fq.key),
        query: fq.raw,
        match: r.distance === 0 ? "exact" : "fuzzy",
        distance: r.distance,
        detail:
          r.distance === 0
            ? `命中${fieldLabel(fq.key)}`
            : `命中${fieldLabel(fq.key)}（与「${r.window}」相差 ${r.distance} 字，已按错一个字容错）`
      });
    }

    if (matched && freeNorm) {
      const r = scoreField(null, freeNorm);
      if (!r) {
        matched = false;
      } else {
        score += r.score;
        reasons.push({
          field: fieldLabel(r.field),
          query: freeText,
          match: r.distance === 0 ? "exact" : "fuzzy",
          distance: r.distance,
          detail:
            r.distance === 0
              ? `关键词命中${fieldLabel(r.field)}`
              : `关键词近似命中${fieldLabel(r.field)}（与「${r.window}」相差 ${r.distance} 字，已按错一个字容错）`
        });
      }
    }

    if (!matched) return null;
    return { score, reasons };
  }

  _present(hit) {
    return this._presentItem({
      kind: hit.doc.kind,
      id: hit.doc.id,
      score: hit.score,
      reasons: hit.reasons,
      createdAt: hit.doc.createdAt,
      code: hit.doc.code
    });
  }

  /** 按会话快照项呈现当前数据；记录被删时保留占位并标记，保证翻页不重不漏。 */
  _presentItem(item) {
    const listName = { rubbing: "rubbings", damage: "damages", batch: "batches" }[item.kind];
    const record = (this._byId[listName] && this._byId[listName].get(item.id)) || null;

    const base = {
      kind: item.kind,
      kindLabel: KIND_LABEL[item.kind],
      id: item.id,
      code: item.code,
      createdAt: item.createdAt,
      score: item.score,
      matchedReasons: item.reasons,
      isDeleted: !record
    };

    if (!record) {
      base.stale = "该记录在本次查询会话建立后已被删除";
      return base;
    }

    if (item.kind === "rubbing") {
      Object.assign(base, {
        code: record.code,
        source: record.source,
        name: record.note || "",
        record
      });
    } else if (item.kind === "damage") {
      const rub = this._byId.rubbings.get(record.rubbingId) || null;
      Object.assign(base, {
        code: rub ? rub.code : "",
        source: rub ? rub.source : "",
        damageType: record.type || "",
        name: record.position || "",
        record,
        rubbing: rub ? { id: rub.id, code: rub.code, source: rub.source } : null
      });
    } else {
      Object.assign(base, {
        code: record.id,
        name: record.name || "",
        record
      });
    }
    return base;
  }
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function clampPageSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(v));
}

let SESSION_SEQ = 0;
function makeSessionId() {
  SESSION_SEQ += 1;
  return `s_${Date.now().toString(36)}_${SESSION_SEQ.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 规范化查询参数为可缓存键（仅用于会话展示，不参与判定）。 */
function normalizeQueryKey(q) {
  const keys = ["q", "code", "source", "damageType", "kind", "dateFrom", "dateTo"];
  const out = {};
  for (const k of keys) if (q[k] !== undefined) out[k] = String(q[k]);
  return out;
}

function fieldLabel(key) {
  return (
    {
      code: "编号",
      source: "来源",
      damageType: "病害类型",
      name: "名称/位置",
      other: "备注信息"
    }[key] || key
  );
}

function parseKinds(input) {
  if (!input) return null;
  const arr = Array.isArray(input) ? input : String(input).split(",");
  const set = new Set();
  for (const item of arr) {
    const v = String(item).trim().toLowerCase();
    if (v === "rubbing" || v === "rubbings" || v === "拓片") set.add("rubbing");
    else if (v === "damage" || v === "damages" || v === "缺损项") set.add("damage");
    else if (v === "batch" || v === "batches" || v === "批次" || v === "修补批次") set.add("batch");
  }
  return set.size ? set : null;
}

/** 总分相同下的稳定排序：登记时间升序 → 编号升序 → id 升序。 */
function compareDocs(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return tieBreak(a.doc, b.doc);
}

function tieBreak(da, db) {
  const ta = da.createdAt || "";
  const tb = db.createdAt || "";
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ca = da.code || "";
  const cb = db.code || "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return da.id < db.id ? -1 : da.id > db.id ? 1 : 0;
}

module.exports = { SearchEngine, SearchIndex, buildDoc, compareDocs, parseKinds, KIND_LABEL, clampPageSize };
