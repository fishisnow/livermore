import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@opentelemetry/api";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../config.js";
import { MessageCenter } from "../notifications/message-center.js";
import { observeAgent, Telemetry } from "../observability/telemetry.js";
import { databasePath, reportsDirectory } from "../project-paths.js";
import { InvestmentDatabase, type RunUsage } from "../storage/database.js";
import { createInvestmentAgent } from "../agent/create-investment-agent.js";
import { collectDirectSources } from "./direct-source-provider.js";
import { evaluateBriefing, type EvaluationResult } from "./evaluation.js";
import { collectLiveSources, loadReplaySources } from "./source-provider.js";
import { taskDefinitions } from "./task-definitions.js";
import type { BriefingTask, SourceItem } from "./types.js";

export interface RunBriefingOptions {
  task: BriefingTask;
  now?: Date;
  replayPath?: string;
  force?: boolean;
  config: AppConfig;
  createAgent?: (config: AppConfig) => Promise<Agent>;
  database?: InvestmentDatabase;
  telemetry?: Telemetry;
}

export interface RunBriefingResult {
  runId: string;
  traceId: string | undefined;
  task: BriefingTask;
  mode: string;
  reportPath: string;
  sourceCount: number;
  warnings: string[];
  evaluations: EvaluationResult[];
}

const zeroUsage = (costCurrency: string): RunUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, cost: 0, costCurrency,
});

export async function runBriefing(options: RunBriefingOptions): Promise<RunBriefingResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid briefing time.");
  const definition = taskDefinitions[options.task];
  const mode = definition.resolveMode(now, options.config.timezone);
  const localDate = formatLocal(now, options.config.timezone, "date");
  const localTime = formatLocal(now, options.config.timezone, "time");
  const database = options.database ?? new InvestmentDatabase(databasePath);
  const ownsDatabase = !options.database;
  const idempotencyKey = `${options.task}:${localDate}:${mode}`;
  let runId: string;
  try {
    runId = database.startRun({
      task: options.task,
      mode,
      scheduledAt: now.toISOString(),
      idempotencyKey,
      ...(options.force === undefined ? {} : { force: options.force }),
    });
  } catch (error) {
    if (ownsDatabase) database.close();
    throw error;
  }
  const telemetry = options.telemetry ?? Telemetry.create(options.config);
  const ownsTelemetry = !options.telemetry;
  const messageCenter = new MessageCenter(options.config, database);
  let locked = false;

  try {
    locked = database.acquireTaskLock(options.task, runId);
    if (!locked) throw new Error(`Task ${options.task} is already running.`);

    const result = await telemetry.withSpan("briefing.run", {
      "openinference.span.kind": "CHAIN",
      "livermore.run.id": runId,
      "livermore.task": options.task,
      "livermore.mode": mode,
      "livermore.replay": Boolean(options.replayPath),
    }, async (rootSpan, rootContext) => {
      const spanContext = rootSpan.spanContext();
      const traceId = spanContext.isRemote || spanContext.traceId !== "00000000000000000000000000000000"
        ? spanContext.traceId
        : undefined;
      if (traceId) database.setTraceId(runId, traceId);

      const collection = await telemetry.withSpan("source.collect", {
        "openinference.span.kind": "CHAIN",
        "livermore.task": options.task,
      }, async (span) => {
        const collected = options.replayPath
          ? { sources: await loadReplaySources(options.replayPath, options.task), warnings: [] }
          : await collectLive(options, definition, now, telemetry);
        span.setAttribute("livermore.source.count", collected.sources.length);
        span.setAttribute("livermore.warning.count", collected.warnings.length);
        return collected;
      });

      const sources = await telemetry.withSpan("source.deduplicate", {
        "openinference.span.kind": "CHAIN",
        "livermore.source.input_count": collection.sources.length,
      }, async (span) => {
        const unseen = database.unseenSources(options.task, localDate, collection.sources);
        span.setAttribute("livermore.source.unseen_count", unseen.length);
        return unseen;
      });

      const generated = sources.length === 0
        ? {
          content: emptyReport(options.task, mode, localDate, localTime),
          usage: zeroUsage(options.config.modelCostCurrency),
        }
        : await telemetry.withSpan("agent.run", {
          "openinference.span.kind": "AGENT",
          "livermore.task": options.task,
          "livermore.source.count": sources.length,
        }, async (_span, agentContext) => generateReport(options, definition.buildPrompt({
          mode,
          nowIso: now.toISOString(),
          localNow: `${localDate} ${localTime.slice(0, 2)}:${localTime.slice(2)}`,
          timezone: options.config.timezone,
          sources,
        }), telemetry, agentContext));

      const reportPath = await telemetry.withSpan("report.persist", {
        "openinference.span.kind": "TOOL",
      }, async () => {
        await mkdir(reportsDirectory, { recursive: true });
        const filename = `${localDate}-${localTime}-${options.task}-${runId.slice(0, 8)}.md`;
        const target = path.join(reportsDirectory, filename);
        await writeFile(target, `${generated.content.trim()}\n`, "utf8");
        database.saveReport(runId, target, createHash("sha256").update(generated.content).digest("hex"));
        return target;
      });

      const evaluations = await telemetry.withSpan("report.evaluate", {
        "openinference.span.kind": "CHAIN",
      }, async (span) => {
        const values = evaluateBriefing(options.task, generated.content, sources);
        for (const value of values) {
          database.saveEvaluation(runId, value.evaluator, value.score, value.label, value.explanation);
          span.setAttribute(`livermore.evaluation.${value.evaluator}`, value.score);
        }
        return values;
      });

      database.commitSources(options.task, localDate, sources, runId);
      database.succeedRun({
        runId,
        reportPath,
        sourceCount: sources.length,
        warningCount: collection.warnings.length,
        usage: generated.usage,
      });

      if (options.config.notifyOnSuccess) {
        const evaluationSummary = evaluations.map((item) => `${item.evaluator}: ${item.label} (${item.score.toFixed(2)})`).join("\n");
        await telemetry.withSpan("notification.deliver", {
          "openinference.span.kind": "TOOL",
        }, async () => publishSafely(messageCenter, {
          runId,
          severity: evaluations.some((item) => item.label === "fail") || collection.warnings.length > 0 ? "warning" : "info",
          title: `Livermore 任务完成：${definition.title}`,
          body: [
            `运行 ID：${runId}`,
            `模式：${mode}`,
            `新增来源：${sources.length}`,
            `Trace ID：${traceId ?? "未启用"}`,
            collection.warnings.length > 0 ? `提示：${collection.warnings.join("；")}` : "",
            `评估：\n${evaluationSummary}`,
            "",
            generated.content.slice(0, 12_000),
          ].filter(Boolean).join("\n"),
        }));
      }

      return {
        runId, traceId, task: options.task, mode, reportPath,
        sourceCount: sources.length, warnings: collection.warnings, evaluations,
      };
    });
    return result;
  } catch (error) {
    database.failRun(runId, error);
    await publishSafely(messageCenter, {
      runId,
      severity: "critical",
      title: `Livermore 任务失败：${definition.title}`,
      body: `运行 ID：${runId}\n模式：${mode}\n错误：${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  } finally {
    if (locked) database.releaseTaskLock(options.task, runId);
    await telemetry.forceFlush();
    if (ownsTelemetry) await telemetry.shutdown();
    if (ownsDatabase) database.close();
  }
}

async function publishSafely(messageCenter: MessageCenter, message: Parameters<MessageCenter["publish"]>[0]): Promise<void> {
  try {
    await messageCenter.publish(message);
  } catch (error) {
    console.warn(`Message center failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function collectLive(
  options: RunBriefingOptions,
  definition: (typeof taskDefinitions)[BriefingTask],
  now: Date,
  telemetry: Telemetry,
) {
  const warnings: string[] = [];
  let mcpSources: SourceItem[] = [];
  if (options.config.tavilyMcpEnabled && options.config.tavilyApiKey) {
    try {
      mcpSources = await telemetry.withSpan("tavily.mcp.search", {
        "openinference.span.kind": "TOOL",
      }, async () => collectLiveSources(
        definition,
        options.config.tavilyMcpUrl,
        options.config.tavilyApiKey!,
        options.config.searchMaxResults,
        now,
      ));
    } catch (error) {
      warnings.push(`Tavily MCP unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!options.config.tavilyMcpEnabled) {
    warnings.push("Tavily MCP is disabled; using direct web sources only.");
  } else {
    warnings.push("TAVILY_API_KEY is not configured; using direct web sources only.");
  }

  const direct = await telemetry.withSpan("source.direct.fetch", {
    "openinference.span.kind": "TOOL",
  }, async () => collectDirectSources(options.task, now));
  if (direct.failures.length > 0) warnings.push(`Direct source failures: ${direct.failures.join("; ")}`);
  const sources = [...new Map([...mcpSources, ...direct.sources].map((source) => [source.id, source])).values()];
  if (sources.length === 0) throw new Error(`No live sources could be collected. ${warnings.join(" ")}`);
  return { sources, warnings };
}

async function generateReport(
  options: RunBriefingOptions,
  prompt: string,
  telemetry: Telemetry,
  parentContext: Context,
): Promise<{ content: string; usage: RunUsage }> {
  const agent = await (options.createAgent ?? createInvestmentAgent)(options.config);
  let content = "";
  const observation = observeAgent(agent, telemetry, parentContext);
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      content += event.assistantMessageEvent.delta;
    }
  });
  await agent.prompt(prompt);
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  if (!content.trim()) throw new Error("The model returned an empty briefing.");
  return { content, usage: observation.usage };
}

function emptyReport(task: BriefingTask, mode: string, date: string, time: string): string {
  const title = task === "market-briefing" ? "Livermore 每日市场简报" : "Livermore AI 产业链日报";
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
