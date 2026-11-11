import { spawn } from "node:child_process";
import type { InvestmentDatabase, TaskName } from "../storage/database.js";
import { nodeEntrypointArguments, projectRoot } from "../project-paths.js";
import { getTaskSettings, listTaskNames, isBuiltinTaskName } from "./task-settings.js";

export interface ScheduledInvocation { task: TaskName; mode: string; slot: string }
export interface SchedulerTickState { at: number; count: number }
export function nextSchedulerTick(previous: SchedulerTickState | undefined, now: number): SchedulerTickState & { catchUp: boolean } {
  const count = previous && now - previous.at < 45_000 ? previous.count + 1 : 1;
  // Sleep and maintenance wakes reset the streak. Catch-up waits until the machine has stayed awake.
  return { at: now, count, catchUp: count >= 3 };
}
export async function dispatchDueTasks(database: InvestmentDatabase, options: {
  now?: Date; timezone?: string; catchUp?: boolean; launch?: (invocation: ScheduledInvocation) => Promise<void>;
} = {}): Promise<ScheduledInvocation[]> {
  const now = options.now ?? new Date();
  const dispatched: ScheduledInvocation[] = [];
  const failures: string[] = [];
  for (const task of listTaskNames(database)) {
    let settings;
    try { settings = getTaskSettings(database, task, options.timezone); }
    catch (error) { failures.push(`${task}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    if (!settings.enabled) continue;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)!.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    if (!settings.weekdays.includes(day)) continue;
    const minute = Number(part("hour")) * 60 + Number(part("minute"));
    const latestPassed = settings.times.reduce<{ time: string; minute: number } | undefined>((latest, time) => {
      const scheduled = scheduledMinute(time.time);
      if (scheduled > minute) return latest;
      return !latest || scheduled > latest.minute ? { time: time.time, minute: scheduled } : latest;
    }, undefined);
    for (const time of settings.times) {
      const delta = minute - scheduledMinute(time.time);
      const lateSeconds = delta * 60 + Number(part("second"));
      const onTime = delta >= 0 && lateSeconds <= 120;
      // The latest missed time can still run after a sleep, but not once it is more than an hour old.
      const catchUp = options.catchUp === true && latestPassed?.time === time.time && lateSeconds > 120 && delta <= 60;
      if (!onTime && !catchUp) continue;
      const invocation = { task, mode: time.mode, slot: `${task}:${date}:${time.time}` };
      if (!database.claimScheduledTask(task, invocation.slot)) continue;
      try { await (options.launch ?? launchScheduledTask)(invocation); dispatched.push(invocation); }
      catch (error) {
        database.releaseScheduledTask(task, invocation.slot);
        failures.push(`${invocation.slot}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (failures.length > 0) console.error(`Task scheduler: ${failures.join("; ")}`);
  return dispatched;
}

function scheduledMinute(time: string): number {
  const [hour, minutes] = time.split(":").map(Number);
  return hour! * 60 + minutes!;
}

async function launchScheduledTask(input: ScheduledInvocation): Promise<void> {
  const custom = !isBuiltinTaskName(input.task);
  const entrypoint = custom ? "custom-task-cli.ts" : input.task === "portfolio-risk-check" ? "portfolio-risk-cli.ts" : "briefing-cli.ts";
  const args = custom ? ["--task", input.task] : input.task === "portfolio-risk-check" ? [] : ["--task", input.task, "--mode", input.mode];
  const child = spawn(process.execPath, [...nodeEntrypointArguments(entrypoint), ...args, "--scheduled-slot", input.slot], { cwd: projectRoot, detached: true, stdio: "ignore", env: process.env });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
