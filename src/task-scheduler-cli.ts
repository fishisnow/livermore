import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { databasePath, runtimeDirectory } from "./project-paths.js";
import { InvestmentDatabase } from "./storage/database.js";
import { dispatchDueTasks, nextSchedulerTick, type SchedulerTickState } from "./tasks/scheduler.js";

const config = loadConfig();
const database = new InvestmentDatabase(databasePath);
let busy = false;
let tickState: SchedulerTickState | undefined;
async function tick() {
  if (busy) return;
  busy = true;
  const scheduleTick = nextSchedulerTick(tickState, Date.now());
  tickState = scheduleTick;
  try {
    const runs = config.taskSchedulerEnabled ? await dispatchDueTasks(database, { timezone: config.timezone, catchUp: scheduleTick.catchUp }) : [];
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(path.join(runtimeDirectory, "task-scheduler.json"), JSON.stringify({ checkedAt: new Date().toISOString(), dispatched: runs }), { mode: 0o600 });
  } catch (error) { console.error(`Task scheduler: ${error instanceof Error ? error.message : error}`); }
  finally { busy = false; }
}
await tick();
if (process.argv.includes("--watch")) {
  const timer = setInterval(tick, 30_000);
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { clearInterval(timer); database.close(); process.exit(0); });
} else database.close();
