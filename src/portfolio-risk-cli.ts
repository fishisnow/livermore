import { loadConfig } from "./config.js";
import { runPortfolioRiskCheck } from "./portfolio/risk-check.js";

const force = process.argv.includes("--force");
const slotIndex = process.argv.indexOf("--scheduled-slot");
const scheduledSlot = slotIndex >= 0 ? process.argv[slotIndex + 1] : undefined;
try {
  const result = await runPortfolioRiskCheck({ config: loadConfig(), force, ...(scheduledSlot ? { scheduledSlot } : {}) });
  console.log(`持仓巡检完成：${result.reportPath}`);
  console.log(`检查 ${result.checked} 项，警告 ${result.warningCount}，严重 ${result.criticalCount}，发送告警 ${result.alertCount}`);
  if (result.traceId) console.log(`Trace ID：${result.traceId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
