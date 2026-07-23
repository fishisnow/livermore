import path from "node:path";
import { loadConfig } from "./config.js";
import { runBriefing } from "./briefings/run-briefing.js";
import type { BriefingTask } from "./briefings/types.js";

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await runBriefing({
    task: args.task,
    ...(args.at ? { now: new Date(args.at) } : {}),
    ...(args.replay ? { replayPath: path.resolve(args.replay) } : {}),
    force: args.force,
    config: loadConfig(),
  });
  console.log(`已生成 ${result.task}（${result.mode}），采用 ${result.sourceCount} 条新来源。运行 ID：${result.runId}`);
  if (result.traceId) console.log(`Trace ID：${result.traceId}`);
  console.log(`报告：${path.relative(process.cwd(), result.reportPath)}`);
  for (const warning of result.warnings) console.warn(`提示：${warning}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(argv: string[]): { task: BriefingTask; at: string | undefined; replay: string | undefined; force: boolean } {
  let task: BriefingTask | undefined;
  let at: string | undefined;
  let replay: string | undefined;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--task") task = requiredValue(argv, ++index, "--task") as BriefingTask;
    else if (argument === "--at") at = requiredValue(argv, ++index, "--at");
    else if (argument === "--replay") replay = requiredValue(argv, ++index, "--replay");
    else if (argument === "--force") force = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (task !== "market-briefing" && task !== "ai-industry-chain") {
    throw new Error("Usage: npm run briefing -- --task <market-briefing|ai-industry-chain> [--replay file.json] [--at ISO] [--force]");
  }
  return { task, at, replay, force };
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}
