import { loadConfig } from "./config.js";
import { MessageCenter } from "./notifications/message-center.js";
import { databasePath } from "./project-paths.js";
import { InvestmentDatabase } from "./storage/database.js";

const config = loadConfig();
const database = new InvestmentDatabase(databasePath);
try {
  const center = new MessageCenter(config, database);
  if (!center.hasChannels()) throw new Error("未配置 FEISHU_WEBHOOK_URL 或 WECHAT_WEBHOOK_URL。");
  await center.publish({
    runId: null,
    severity: "info",
    title: "Livermore 消息中心测试",
    body: `本地消息通道工作正常。\n时间：${new Date().toISOString()}`,
  });
  console.log("测试消息已发送。");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
