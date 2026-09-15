/**
 * 索引重建断点管理（单个 JSON 检查点文件，原子写）。
 *
 * 检查点内容：
 *   { section, offset, ids: [[拓片id…],[缺损id…],[批次id…]], done, total, at }
 * ids 是重建开始那一刻三类档案的稳定 ID 快照，保证：
 *   - 重建中源数组增删不影响遍历基准（靠 id 回查当前记录，删除则跳过）；
 *   - 中断后续跑仍按同一份基准推进；
 *   - 重建结束时对「基准之外新增的记录」做一次追平，最终不漏不重。
 */
const fsp = require("fs/promises");
const path = require("path");
const { atomicWriteFile } = require("./store");

const CHECKPOINT_FILE = "rebuild-checkpoint.json";

class CheckpointManager {
  constructor(dataDir) {
    this.file = path.join(dataDir, CHECKPOINT_FILE);
  }

  async load() {
    try {
      const cp = JSON.parse(await fsp.readFile(this.file, "utf8"));
      if (!Array.isArray(cp.ids) || cp.ids.length !== 3) return null;
      if (typeof cp.section !== "number") return null;
      return cp;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      // 损坏的检查点视为无（从头重建，代价只是慢一点）。
      return null;
    }
  }

  async save(cp) {
    await atomicWriteFile(this.file, JSON.stringify(cp));
  }

  async clear() {
    await fsp.unlink(this.file).catch(() => {});
  }
}

module.exports = { CheckpointManager, CHECKPOINT_FILE };
