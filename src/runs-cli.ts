import { loadConfig } from "./config.js";
import { databasePath } from "./project-paths.js";
import { InvestmentDatabase } from "./storage/database.js";
import type { TaskName } from "./storage/database.js";

const args = parseArgs(process.argv.slice(2));
const database = new InvestmentDatabase(databasePath);
try {
  if (args.runId) {
    const run = database.getRun(args.runId);
    if (!run) throw new Error(`Run not found: ${args.runId}`);
    console.log(JSON.stringify(run, null, 2));
    if (run.traceId) console.log(`\nPhoenix：${loadConfig().phoenixUiUrl}\nTrace ID：${run.traceId}`);
  } else {
    const rows = database.listRuns(args.limit, args.task);
    if (rows.length === 0) console.log("暂无任务运行记录。");
    else console.table(rows.map((run) => ({
      id: run.id.slice(0, 8),
      task: run.task,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      sources: run.sourceCount,
      tokens: run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens,
      cost: `${run.costCurrency} ${run.cost.toFixed(6)}`,
      traceId: run.traceId?.slice(0, 12) ?? "-",
    })));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  database.close();
}

function parseArgs(argv: string[]): { runId?: string; task?: TaskName; limit: number } {
  let runId: string | undefined;
  let task: TaskName | undefined;
  let limit = 20;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--run") runId = value(argv, ++index, argument);
    else if (argument === "--task") task = value(argv, ++index, argument) as TaskName;
    else if (argument === "--limit") limit = Number.parseInt(value(argv, ++index, argument), 10);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (task && task !== "market-briefing" && task !== "ai-industry-chain" && task !== "portfolio-risk-check") {
    throw new Error(`Unknown task: ${task}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be between 1 and 200.");
  return {
    ...(runId ? { runId } : {}),
    ...(task ? { task } : {}),
    limit,
  };
}

function value(argv: string[], index: number, flag: string): string {
  const result = argv[index];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return result;
}
