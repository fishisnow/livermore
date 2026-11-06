import { loadConfig } from "./config.js";
import { runCustomTask } from "./tasks/run-custom-task.js";
import type { CustomTaskName } from "./storage/database.js";

const value = (flag: string) => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
try {
  const task = value("--task");
  if (!task || !/^custom-[a-f0-9-]{36}$/.test(task)) throw new Error("无效的自定义研究任务 ID。");
  const slot = value("--scheduled-slot");
  console.log(JSON.stringify(await runCustomTask({ task: task as CustomTaskName, config: loadConfig(), force: process.argv.includes("--force"), ...(slot ? { scheduledSlot: slot } : {}) })));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
