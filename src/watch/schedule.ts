import { spawn } from "node:child_process";
import { nodeEntrypointArguments, projectRoot } from "../project-paths.js";
import type { InvestmentDatabase } from "../storage/database.js";
import { isWatchDue } from "./service.js";

export async function dispatchDueWatches(database: InvestmentDatabase, options: {
  now?: Date;
  timeZone: string;
  enabled: boolean;
  launch?: () => Promise<void>;
}): Promise<boolean> {
  if (!options.enabled) return false;
  const now = options.now ?? new Date();
  const due = database.watches.listCheckTargets().some((target) => isWatchDue({
    status: target.status,
    lastCheckedAt: target.lastCheckedAt,
    latestFinishedAt: target.latestFinishedAt,
    now,
    timeZone: options.timeZone,
  }));
  if (!due) return false;
  const stamped = Number(database.watches.getMeta("watch.dispatch_at") ?? "0");
  if (Number.isFinite(stamped) && now.getTime() - stamped < 30 * 60_000) return false;
  database.watches.setMeta("watch.dispatch_at", String(now.getTime()));
  try {
    await (options.launch ?? launchWatchCli)();
    return true;
  } catch (error) {
    database.watches.setMeta("watch.dispatch_at", "0");
    throw error;
  }
}

async function launchWatchCli(): Promise<void> {
  const child = spawn(process.execPath, nodeEntrypointArguments("watch-cli.ts"), {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}
