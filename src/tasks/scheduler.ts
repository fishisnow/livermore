import { spawn } from "node:child_process";
import type { InvestmentDatabase, TaskName } from "../storage/database.js";
import { nodeEntrypointArguments, projectRoot } from "../project-paths.js";
import { getTaskSettings, listTaskNames, isBuiltinTaskName } from "./task-settings.js";

export interface ScheduledInvocation { task: TaskName; mode: string; slot: string }
export async function dispatchDueTasks(database: InvestmentDatabase, options: {
  now?: Date; timezone?: string; launch?: (invocation: ScheduledInvocation) => Promise<void>;
} = {}): Promise<ScheduledInvocation[]> {
  const now = options.now ?? new Date();
  const dispatched: ScheduledInvocation[] = [];
  for (const task of listTaskNames(database)) {
    const settings = getTaskSettings(database, task, options.timezone);
    if (!settings.enabled) continue;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)!.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    if (!settings.weekdays.includes(day)) continue;
    const minute = Number(part("hour")) * 60 + Number(part("minute"));
    for (const time of settings.times) {
      const [hour, minutes] = time.time.split(":").map(Number);
      const delta = minute - (hour! * 60 + minutes!);
      // A short wake/start grace period; never replay a day's stale investment alerts.
      if (delta < 0 || delta * 60 + Number(part("second")) > 120) continue;
      const invocation = { task, mode: time.mode, slot: `${task}:${date}:${time.time}` };
      if (!database.claimScheduledTask(task, invocation.slot)) continue;
      try { await (options.launch ?? launchScheduledTask)(invocation); dispatched.push(invocation); }
      catch (error) { database.releaseScheduledTask(task, invocation.slot); throw error; }
    }
  }
  return dispatched;
}

async function launchScheduledTask(input: ScheduledInvocation): Promise<void> {
  const custom = !isBuiltinTaskName(input.task);
  const entrypoint = custom ? "custom-task-cli.ts" : input.task === "portfolio-risk-check" ? "portfolio-risk-cli.ts" : "briefing-cli.ts";
  const args = custom ? ["--task", input.task] : input.task === "portfolio-risk-check" ? [] : ["--task", input.task, "--mode", input.mode];
  const child = spawn(process.execPath, [...nodeEntrypointArguments(entrypoint), ...args, "--scheduled-slot", input.slot], { cwd: projectRoot, detached: true, stdio: "ignore", env: process.env });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
