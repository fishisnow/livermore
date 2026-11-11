import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createInvestmentAgent } from "../agent/create-investment-agent.js";
import { finalAssistantText } from "../chat/livermore-chat-agent.js";
import type { AppConfig } from "../config.js";
import { MessageCenter } from "../notifications/message-center.js";
import { observeAgent, Telemetry } from "../observability/telemetry.js";
import { databasePath, reportsDirectory } from "../project-paths.js";
import { InvestmentDatabase, type CustomTaskName } from "../storage/database.js";
import { createRuntimeTools } from "../tools/runtime-tools.js";
import { createMcpAgentTools } from "../mcp/agent-tools.js";
import { getTaskSettings } from "./task-settings.js";

export async function runCustomTask(options: { task: CustomTaskName; config: AppConfig; scheduledSlot?: string; force?: boolean; database?: InvestmentDatabase; reportDirectory?: string; createAgent?: () => Promise<Agent> }) {
  const db = options.database ?? new InvestmentDatabase(databasePath);
  const telemetry = Telemetry.create(options.config);
  let runId: string | undefined;
  let locked = false;
  let agent: Agent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const center = new MessageCenter(options.config, db);
  const task = db.getCustomTask(options.task);
  try {
    if (!task) throw new Error("研究任务不存在或已删除。");
    const settings = getTaskSettings(db, task.id, options.config.timezone);
    const now = new Date();
    runId = db.startRun({ task: task.id, mode: "research", scheduledAt: now.toISOString(), idempotencyKey: options.scheduledSlot ?? `${task.id}:${now.toISOString()}`, ...(options.force === undefined ? {} : { force: options.force }) });
    locked = db.acquireTaskLock(task.id, runId, 12 * 60_000);
    if (!locked) throw new Error("该研究任务已在运行中。");
    return await telemetry.withSpan("research.custom_task", { "openinference.span.kind": "AGENT", "livermore.run.id": runId, "livermore.task": task.id, "livermore.task.config_revision": settings.revision }, async (span, context) => {
      const traceId = telemetry.enabled ? span.spanContext().traceId : undefined;
      if (traceId) db.setTraceId(runId!, traceId);
      agent = options.createAgent ? await options.createAgent() : await createInvestmentAgent(options.config, {
        tools: [...createRuntimeTools(options.config, db), ...createMcpAgentTools(db.listMcpServers())], includeReportTool: false,
        systemPromptAppend: "你正在执行用户配置的独立研究任务。按任务目标使用实际注册的只读工具，实时资料必须有来源与时间。只输出最终中文 Markdown 报告；不要执行交易或自行发送消息。",
      });
      timer = setTimeout(() => agent?.abort(), 10 * 60_000);
      const variables: Record<string, string> = { localNow: new Intl.DateTimeFormat("zh-CN", { timeZone: settings.timezone, dateStyle: "full", timeStyle: "short" }).format(now), nowIso: now.toISOString(), timezone: settings.timezone, mode: "research" };
      const prompt = settings.prompt.replace(/\{\{(localNow|nowIso|timezone|mode)\}\}/g, (_match, key: string) => variables[key]!);
      const observation = observeAgent(agent, telemetry, context);
      let toolCalls = 0;
      const unsubscribe = agent.subscribe((event) => { if (event.type === "tool_execution_start") toolCalls++; });
      try {
        await agent.prompt(prompt);
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        const report = finalAssistantText(agent.state.messages);
        if (!report) throw new Error("研究任务未返回报告。");
        const directory = options.reportDirectory ?? reportsDirectory;
        await mkdir(directory, { recursive: true });
        const reportPath = path.join(directory, `${now.toISOString().slice(0, 10)}-${task.id}-${runId}.md`);
        await writeFile(reportPath, `${report}\n`, "utf8");
        db.saveReport(runId!, reportPath, createHash("sha256").update(report).digest("hex"));
        db.succeedRun({ runId: runId!, reportPath, sourceCount: toolCalls, warningCount: 0, usage: observation.usage });
        if (options.config.notifyOnSuccess) await center.publish({ runId: runId!, severity: "info", title: `Livermore 研究完成：${task.title}`, body: report.slice(0, 12_000) });
        return { runId, traceId, reportPath };
      } finally { observation.unsubscribe(); unsubscribe(); }
    });
  } catch (error) {
    if (runId) {
      db.failRun(runId, error);
      await center.publish({ runId, severity: "critical", title: `Livermore 研究失败：${task?.title ?? "自定义任务"}`, body: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer); agent?.abort();
    if (locked && runId) db.releaseTaskLock(options.task, runId);
    await telemetry.shutdown();
    if (!options.database) db.close();
  }
}
