import { loadConfig } from "./config.js";
import { startFeishuBotService } from "./feishu/feishu-bot-service.js";
import { Telemetry } from "./observability/telemetry.js";
import { databasePath } from "./project-paths.js";
import { InvestmentDatabase } from "./storage/database.js";

const config = loadConfig();
const database = new InvestmentDatabase(databasePath);
const telemetry = Telemetry.create(config);

try {
  const service = await startFeishuBotService(config, database, telemetry);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await service.close();
      await telemetry.shutdown();
      database.close();
      process.exit(0);
    });
  }
} catch (error) {
  await telemetry.shutdown();
  database.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
