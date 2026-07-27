import { loadConfig } from "./config.js";
import { MessageCenter } from "./notifications/message-center.js";
import { databasePath } from "./project-paths.js";
import { InvestmentDatabase } from "./storage/database.js";

const config = loadConfig();
const database = new InvestmentDatabase(databasePath);
try {
  const center = new MessageCenter(config, database);
  if (!center.hasChannels()) {
    throw new Error("未配置消息通道，或飞书 Agent 尚未通过首次对话绑定报告接收会话。");
  }
  await center.publish({
    runId: null,
    severity: "info",
    title: "Livermore 消息中心测试",
    body: [
      "### Markdown 渲染验证",
      "",
      "- **飞书应用机器人**：连接正常",
      "- **定时报告通道**：连接正常",
      `- **测试时间**：${new Date().toISOString()}`,
      "",
      `[打开 Livermore Agent Web](${config.webUiUrl})`,
    ].join("\n"),
  });
  console.log("测试消息已发送。");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}
