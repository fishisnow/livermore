import { formatBriefingSources, taskDefinitions } from "../briefings/task-definitions.js";
import type { BriefingPromptInput, BriefingTask } from "../briefings/types.js";
import { portfolioRiskInstructions } from "../portfolio/risk-instructions.js";
import { randomUUID } from "node:crypto";
import type { InvestmentDatabase, TaskName, BuiltinTaskName } from "../storage/database.js";

export const taskNames: BuiltinTaskName[] = ["market-briefing", "ai-industry-chain", "portfolio-risk-check"];
export const taskTitles: Record<BuiltinTaskName, string> = { "market-briefing": "每日市场简报", "ai-industry-chain": "AI 产业链日报", "portfolio-risk-check": "持仓风险巡检" };
export const taskModes: Record<BuiltinTaskName, string[]> = { "market-briefing": ["pre-market", "intraday", "close"], "ai-industry-chain": ["pre-market", "close"], "portfolio-risk-check": ["hourly"] };
export interface TaskSettings {
  task: TaskName;
  enabled: boolean;
  timezone: string;
  weekdays: number[];
  times: Array<{ time: string; mode: string }>;
  prompt: string;
  revision: number;
  updatedAt: string | null;
}
export class TaskSettingsError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
export function isBuiltinTaskName(value: string): value is BuiltinTaskName { return taskNames.includes(value as BuiltinTaskName); }
export function isTaskName(value: string, database?: InvestmentDatabase): value is TaskName { return isBuiltinTaskName(value) || Boolean(database?.getCustomTask(value)); }
export function listTaskNames(database: InvestmentDatabase): TaskName[] { return [...taskNames, ...database.listCustomTasks().map((item) => item.id)]; }
export function modesForTask(task: TaskName): string[] { return isBuiltinTaskName(task) ? taskModes[task] : ["research"]; }
export function titleForTask(database: InvestmentDatabase, task: TaskName): string { return isBuiltinTaskName(task) ? taskTitles[task] : database.getCustomTask(task)?.title ?? "已删除的研究任务"; }

export function defaultTaskPrompt(task: TaskName): string {
  if (!isBuiltinTaskName(task)) return `执行以下投资研究任务，使用中文 Markdown 输出报告。
当前时间：{{localNow}}（{{timezone}}）。

研究目标：请在这里填写要研究的主题、标的、数据范围和重点问题。

工作要求：
1. 根据任务需要调用实际可用的只读工具。使用 Skill 前先列出并读取其说明；实时行情和新闻必须来自本轮工具返回，禁止编造。
2. 说明资料来源、发布时间与数据缺口，严格区分事实、推断和待验证项。
3. 报告包含简明总结、关键发现、风险与后续观察。只输出最终报告，不执行交易，不自行发送消息或保存报告。
4. 结尾注明“以上内容仅供研究参考，不构成投资建议。”`;
  if (task === "portfolio-risk-check") return portfolioRiskInstructions;
  return taskDefinitions[task].buildPrompt({ mode: "{{mode}}" as BriefingPromptInput["mode"], nowIso: "{{nowIso}}", localNow: "{{localNow}}", timezone: "{{timezone}}", sources: [], sourceText: "{{sources}}" });
}
export function defaultTaskSettings(task: TaskName, timezone = "Asia/Shanghai"): TaskSettings {
  const times = task === "market-briefing" ? [["08:30", "pre-market"], ["12:00", "intraday"], ["16:10", "close"]]
    : task === "ai-industry-chain" ? [["08:45", "pre-market"], ["17:00", "close"]] : task === "portfolio-risk-check" ? [["11:00", "hourly"], ["14:30", "hourly"]] : [["09:00", "research"]];
  return { task, enabled: isBuiltinTaskName(task), timezone, weekdays: [1, 2, 3, 4, 5], times: times.map(([time, mode]) => ({ time: time!, mode: mode! })), prompt: defaultTaskPrompt(task), revision: 0, updatedAt: null };
}
export function getTaskSettings(database: InvestmentDatabase, task: TaskName, timezone = "Asia/Shanghai"): TaskSettings {
  const stored = database.getTaskConfiguration(task);
  return stored ? { ...validateTaskSettings(task, stored.value), revision: stored.revision, updatedAt: stored.updatedAt } : defaultTaskSettings(task, timezone);
}
export function saveTaskSettings(database: InvestmentDatabase, task: TaskName, input: unknown): TaskSettings {
  const valid = validateTaskSettings(task, input);
  const revision = (input as Record<string, unknown>).revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw new TaskSettingsError("配置版本无效，请重新打开任务。" );
  const saved = isBuiltinTaskName(task) ? database.saveTaskConfiguration(task, valid, Number(revision)) : database.updateCustomTask(task, validateTaskTitle((input as Record<string, unknown>).title), valid, Number(revision));
  if (!saved) throw new TaskSettingsError("任务已在其他窗口修改，请重新打开后再保存。", 409);
  return getTaskSettings(database, task);
}
export function validateTaskSettings(task: TaskName, input: unknown): Omit<TaskSettings, "revision" | "updatedAt"> {
  if (!input || typeof input !== "object") throw new TaskSettingsError("任务配置必须是对象。");
  const value = input as Record<string, unknown>;
  if (typeof value.enabled !== "boolean") throw new TaskSettingsError("请选择是否启用定时运行。");
  if (typeof value.timezone !== "string" || value.timezone.length > 80) throw new TaskSettingsError("时区无效。");
  try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format(); } catch { throw new TaskSettingsError("请输入有效的 IANA 时区，例如 Asia/Shanghai。"); }
  if (!Array.isArray(value.weekdays) || value.weekdays.length < 1 || value.weekdays.length > 7 || value.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new TaskSettingsError("请至少选择一个运行日。");
  if (!Array.isArray(value.times) || value.times.length < 1 || value.times.length > 24) throw new TaskSettingsError("请配置 1—24 个运行时间。");
  const times = value.times.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new TaskSettingsError("运行时间无效。");
    const row = item as Record<string, unknown>;
    if (typeof row.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time) || typeof row.mode !== "string" || !modesForTask(task).includes(row.mode)) throw new TaskSettingsError("运行时间或任务模式无效。");
    return { time: row.time, mode: row.mode };
  }).sort((a, b) => a.time.localeCompare(b.time));
  if (new Set(times.map((item) => item.time)).size !== times.length) throw new TaskSettingsError("同一任务的运行时间不能重复。");
  if (typeof value.prompt !== "string" || value.prompt.trim().length < 20 || value.prompt.length > 30_000) throw new TaskSettingsError("Prompt 长度应为 20—30,000 字符。");
  if (task !== "portfolio-risk-check" && isBuiltinTaskName(task)) {
    if (!value.prompt.includes("{{sources}}")) throw new TaskSettingsError("日报 Prompt 必须保留 {{sources}}，用于注入本次来源材料。");
    for (const match of value.prompt.matchAll(/\{\{(.*?)\}\}/g)) if (!["sources", "localNow", "timezone", "nowIso", "mode"].includes(match[1]!)) throw new TaskSettingsError(`不支持的 Prompt 变量：${match[0]}`);
  }
  if (!isBuiltinTaskName(task)) for (const match of value.prompt.matchAll(/\{\{(.*?)\}\}/g)) if (!["localNow", "timezone", "nowIso", "mode"].includes(match[1]!)) throw new TaskSettingsError(`不支持的研究任务变量：${match[0]}`);
  return { task, enabled: value.enabled, timezone: value.timezone, weekdays: [...new Set(value.weekdays as number[])].sort(), times, prompt: value.prompt.trim() };
}
export function renderBriefingPrompt(settings: TaskSettings, input: BriefingPromptInput): string {
  const variables: Record<string, string> = { mode: input.mode, localNow: input.localNow, timezone: input.timezone, nowIso: input.nowIso, sources: formatBriefingSources(input.sources) };
  // Single pass: source text containing {{...}} is data, never another template.
  return settings.prompt.replace(/\{\{(sources|localNow|timezone|nowIso|mode)\}\}/g, (_match, key: string) => variables[key]!);
}
export function validateTaskTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw new TaskSettingsError("任务名称应为 1—80 字符。");
  return value.trim();
}
export function createCustomResearchTask(database: InvestmentDatabase, input: unknown) {
  if (!input || typeof input !== "object") throw new TaskSettingsError("任务配置无效。");
  const task = `custom-${randomUUID()}` as const;
  const value = input as Record<string, unknown>;
  const title = validateTaskTitle(value.title);
  database.createCustomTask(task, title, validateTaskSettings(task, value));
  return { ...getTaskSettings(database, task), title };
}
export function scheduleDescription(settings: TaskSettings): string {
  const days = settings.weekdays.join() === "1,2,3,4,5" ? "工作日" : settings.weekdays.map((day) => ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][day]).join("、");
  return `${settings.enabled ? days : "已暂停 · " + days} ${settings.times.map((item) => item.time).join(" / ")} · ${settings.timezone}`;
}
