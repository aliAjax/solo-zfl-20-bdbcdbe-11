/**
 * 服务启动入口（零依赖）。
 *
 *   PORT=3020 DATA_DIR=./data node server.js
 *
 * 首次启动会自动把旧版 data/db.json 迁移为 snapshot.json + wal.log，
 * 原有接口路径与响应结构保持不变，新增 /search 统一检索入口。
 */
const path = require("path");
const { createApp } = require("./src/app");

const PORT = Number(process.env.PORT || 3020);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

createApp({ dataDir: DATA_DIR })
  .then((server) => {
    server.listen(PORT, () => {
      console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
      console.log(`Data directory: ${DATA_DIR}`);
    });

    const shutdown = async () => {
      console.log("\n正在关闭服务…");
      try {
        await server.shutdown();
        console.log("已安全退出。");
        process.exit(0);
      } catch (err) {
        console.error("关闭异常:", err);
        process.exit(1);
      }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err) => {
    console.error("服务启动失败:", err);
    process.exit(1);
  });
