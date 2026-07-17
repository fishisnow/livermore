import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../config.js";
import { reportsDirectory, runtimeDirectory } from "../project-paths.js";
import { createInvestmentAgent } from "../agent/create-investment-agent.js";
import { DedupeStore } from "./dedupe-store.js";
import { deliverBriefing } from "./delivery.js";
import { collectLiveSources, loadReplaySources } from "./source-provider.js";
import { taskDefinitions } from "./task-definitions.js";
import type { BriefingTask } from "./types.js";

export interface RunBriefingOptions {
  task: BriefingTask;
  now?: Date;
  replayPath?: string;
  deliver?: boolean;
  config: AppConfig;
  createAgent?: (config: AppConfig) => Promise<Agent>;
}

export interface RunBriefingResult {
  task: BriefingTask;
  mode: string;
  reportPath: string;
  sourceCount: number;
  delivered: boolean;
}

export async function runBriefing(options: RunBriefingOptions): Promise<RunBriefingResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid briefing time.");
  const definition = taskDefinitions[options.task];
  const mode = definition.resolveMode(now, options.config.timezone);
  const localDate = formatLocal(now, options.config.timezone, "date");
  const localTime = formatLocal(now, options.config.timezone, "time");

  const collected = options.replayPath
    ? await loadReplaySources(options.replayPath, options.task)
    : await collectLive(options, definition, now);
  const store = new DedupeStore(path.join(runtimeDirectory, "reported-news"));
  const sources = await store.unseen(options.task, localDate, collected);

  const content = sources.length === 0
    ? emptyReport(options.task, mode, localDate, localTime)
    : await generateReport(options, definition.buildPrompt({
        mode,
        nowIso: now.toISOString(),
        timezone: options.config.timezone,
        sources,
      }));

  await mkdir(reportsDirectory, { recursive: true });
  const reportPath = path.join(reportsDirectory, `${localDate}-${localTime}-${options.task}.md`);
  await writeFile(reportPath, `${content.trim()}\n`, "utf8");

  let delivered = false;
  if (options.deliver !== false && options.config.briefingReportApiUrl) {
    await deliverBriefing({
      apiUrl: options.config.briefingReportApiUrl,
      apiKey: options.config.briefingReportApiKey,
      publisher: options.config.briefingPublisher,
    }, content, now.toISOString());
    delivered = true;
  }

  await store.commit(options.task, localDate, sources, now);
  return { task: options.task, mode, reportPath, sourceCount: sources.length, delivered };
}

async function collectLive(
  options: RunBriefingOptions,
  definition: (typeof taskDefinitions)[BriefingTask],
  now: Date,
) {
  if (!options.config.tavilyApiKey) {
    throw new Error("TAVILY_API_KEY is required for live collection. Add it to the project .env or use --replay.");
  }
  return collectLiveSources(definition, options.config.tavilyApiKey, options.config.searchMaxResults, now);
}

async function generateReport(options: RunBriefingOptions, prompt: string): Promise<string> {
  const agent = await (options.createAgent ?? createInvestmentAgent)(options.config);
  let content = "";
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      content += event.assistantMessageEvent.delta;
    }
  });
  await agent.prompt(prompt);
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  if (!content.trim()) throw new Error("The model returned an empty briefing.");
  return content;
}

function emptyReport(task: BriefingTask, mode: string, date: string, time: string): string {
  const title = task === "market-briefing" ? "每日市场简报" : "玄弈·AI产业链日报";
  return `# ${title}\n\n日期：${date} ${time}（${mode}）\n\n本时段暂无重要增量信息。\n\n以上内容仅供研究参考，不构成投资建议。`;
}

function formatLocal(date: Date, timezone: string, kind: "date" | "time"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: kind === "date" ? "numeric" : undefined,
    month: kind === "date" ? "2-digit" : undefined,
    day: kind === "date" ? "2-digit" : undefined,
    hour: kind === "time" ? "2-digit" : undefined,
    minute: kind === "time" ? "2-digit" : undefined,
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return kind === "date"
    ? `${value("year")}-${value("month")}-${value("day")}`
    : `${value("hour") === "24" ? "00" : value("hour")}${value("minute")}`;
}
