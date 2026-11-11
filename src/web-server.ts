import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createLivermoreChatAgent } from "./chat/livermore-chat-agent.js";
import { loadConfig } from "./config.js";
import { observeAgent, Telemetry } from "./observability/telemetry.js";
import { databasePath, nodeEntrypointArguments, projectRoot, reportsDirectory, webDirectory } from "./project-paths.js";
import { InvestmentDatabase } from "./storage/database.js";
import type { PortfolioPositionInput, TaskName } from "./storage/database.js";
import { createReportTool } from "./tools/report-tool.js";
import { createRuntimeTools, listSkillDescriptors } from "./tools/runtime-tools.js";
import { getTaskSettings, isTaskName, saveTaskSettings, scheduleDescription, taskNames, taskTitles, taskModes, defaultTaskPrompt, TaskSettingsError } from "./tasks/task-settings.js";
import { notificationPreview } from "./notifications/macos-channel.js";
import { createCustomResearchTask, defaultTaskSettings, isBuiltinTaskName, listTaskNames, modesForTask, titleForTask } from "./tasks/task-settings.js";
import { ChatSessionError, PersistentChatSessions, visibleChatMessages } from "./chat/persistent-sessions.js";
import { entryAtrStop } from "./portfolio/entry-stop.js";
import { refreshMcpServerTools } from "./mcp/agent-tools.js";
import { createMcpServer, deleteMcpServer, McpConfigError, toPublicMcp, updateMcpServer, resolveBriefingMcp } from "./mcp/registry.js";

const config = loadConfig();
const database = new InvestmentDatabase(databasePath);
const telemetry = Telemetry.create(config);
const sessions = new PersistentChatSessions(database, () => createLivermoreChatAgent(config, database, "Agent Web"));

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (response.headersSent) {
      sendSse(response, "error", { message: error instanceof Error ? error.message : String(error) });
      response.end();
    } else {
      sendJson(response, error instanceof TaskSettingsError || error instanceof ChatSessionError || error instanceof McpConfigError ? error.statusCode : 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
});

server.on("error", async (error) => {
  console.error(`Livermore Agent Web failed: ${error.message}`);
  await telemetry.shutdown();
  database.close();
  process.exit(1);
});

server.listen(config.webPort, "127.0.0.1", () => {
  database.recoverInterruptedChats();
  console.log(`Livermore Agent Web: ${config.webUiUrl}`);
});

const cleanup = setInterval(() => {
  sessions.cleanup();
}, 30 * 60_000);
cleanup.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await sessions.shutdown();
    await telemetry.shutdown();
    database.close();
    process.exit(0);
  });
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", config.webUiUrl);
  if (!["GET", "HEAD"].includes(request.method ?? "GET") && request.headers.origin) {
    const origin = new URL(request.headers.origin);
    if (!["127.0.0.1", "localhost"].includes(origin.hostname) || origin.port !== String(config.webPort)) return sendJson(response, 403, { error: "Origin not allowed." });
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: "livermore-agent-web",
      workspaceId: createHash("sha256").update(projectRoot).digest("hex").slice(0, 16),
    });
  } else if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const capabilities = await capabilitySnapshot();
    const runs = database.listRuns(30);
    sendJson(response, 200, {
      agent: {
        provider: config.provider,
        model: config.model,
        tavily: resolveBriefingMcp(database.listMcpServers()).state === "ready",
        skillCount: capabilities.skills.length,
        mcpCount: capabilities.mcps.filter((item) => item.status === "configured").length,
        toolCount: capabilities.tools.length,
        phoenixUrl: config.phoenixUiUrl,
      },
      tasks: listTaskNames(database).map((task) => {
        const settings = getTaskSettings(database, task, config.timezone);
        const taskRuns = database.listRuns(30, task);
        return { task, title: titleForTask(database, task), custom: !isBuiltinTaskName(task), schedule: scheduleDescription(settings), enabled: settings.enabled,
          latest: taskRuns[0] ?? null,
          running: taskRuns.find((run) => run.status === "running") ?? null,
          runs: taskRuns.slice(0, 12) };
      }),
      recentRuns: runs.slice(0, 12),
    });
  } else if (request.method === "GET" && url.pathname === "/api/tasks/template") {
    sendJson(response, 200, { ...defaultTaskSettings("custom-draft", config.timezone), task: null, title: "", custom: true, modes: ["research"], defaultPrompt: defaultTaskPrompt("custom-draft"), schedulerEnabled: config.taskSchedulerEnabled });
  } else if (request.method === "POST" && url.pathname === "/api/tasks") {
    sendJson(response, 201, createCustomResearchTask(database, await readJsonBody(request)));
  } else if (request.method === "DELETE" && /^\/api\/tasks\/custom-[^/]+$/.test(url.pathname)) {
    const task = url.pathname.split("/")[3]!;
    if (!isTaskName(task, database) || isBuiltinTaskName(task)) return sendJson(response, 404, { error: "Unknown custom task." });
    database.deleteCustomTask(task);
    sendJson(response, 200, { deleted: true });
  } else if (request.method === "GET" && url.pathname === "/api/notifications") {
    sendJson(response, 200, { unreadCount: database.unreadAlertCount(), macosEnabled: config.macosNotificationsEnabled, messages: database.listAlerts().map(({ body, ...item }) => ({ ...item, preview: notificationPreview(body, 220) })) });
  } else if (url.pathname.startsWith("/api/notifications/")) {
    const id = url.pathname.slice("/api/notifications/".length);
    if (request.method === "POST" && id.endsWith("/read")) {
      if (!database.acknowledgeAlert(id.slice(0, -"/read".length))) return sendJson(response, 404, { error: "Message not found." });
      return sendJson(response, 200, { ok: true });
    }
    const alert = database.getAlert(id);
    if (request.method !== "GET" || !alert) return sendJson(response, 404, { error: "Message not found." });
    sendJson(response, 200, alert);
  } else if (/^\/api\/tasks\/[^/]+\/config$/.test(url.pathname)) {
    const task = url.pathname.split("/")[3]!;
    if (!isTaskName(task, database)) return sendJson(response, 404, { error: "Unknown task." });
    if (request.method === "GET") sendJson(response, 200, { ...getTaskSettings(database, task, config.timezone), title: titleForTask(database, task), custom: !isBuiltinTaskName(task), modes: modesForTask(task), defaultPrompt: defaultTaskPrompt(task), schedulerEnabled: config.taskSchedulerEnabled });
    else if (request.method === "PUT") sendJson(response, 200, saveTaskSettings(database, task, await readJsonBody(request)));
    else sendJson(response, 405, { error: "Method not allowed." });
  } else if (request.method === "GET" && url.pathname === "/api/capabilities") {
    sendJson(response, 200, await capabilitySnapshot(url.searchParams.get("refresh") === "true"));
  } else if (url.pathname === "/api/mcp" && request.method === "POST") {
    const created = createMcpServer(database, await readJsonBody(request));
    sessions.dropIdleAgents();
    sendJson(response, 201, toPublicMcp(created));
  } else if (url.pathname.startsWith("/api/mcp/")) {
    const [id, action] = url.pathname.slice("/api/mcp/".length).split("/");
    if (!id || action && action !== "refresh") return sendJson(response, 404, { error: "Not found." });
    if (request.method === "DELETE" && !action) {
      deleteMcpServer(database, decodeURIComponent(id));
      sessions.dropIdleAgents();
      return sendJson(response, 200, { deleted: true });
    }
    if (request.method === "PATCH" && !action) {
      const updated = updateMcpServer(database, decodeURIComponent(id), await readJsonBody(request));
      sessions.dropIdleAgents();
      return sendJson(response, 200, toPublicMcp(updated));
    }
    if (request.method === "POST" && action === "refresh") {
      const updated = await refreshMcpServerTools(database, decodeURIComponent(id));
      sessions.dropIdleAgents();
      return sendJson(response, 200, toPublicMcp(updated));
    }
    sendJson(response, 405, { error: "Method not allowed." });
  } else if (request.method === "GET" && url.pathname === "/api/portfolio") {
    sendJson(response, 200, { positions: database.listPositions() });
  } else if (request.method === "POST" && url.pathname === "/api/portfolio") {
    const input = parsePositionInput(await readJsonBody(request));
    const stop = await entryAtrStop(config, input.symbol);
    sendJson(response, 201, database.createPosition({ ...input, ...stop }));
  } else if (request.method === "PUT" && url.pathname.startsWith("/api/portfolio/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/portfolio/".length));
    const updated = database.updatePosition(id, parsePositionInput(await readJsonBody(request)));
    if (!updated) return sendJson(response, 404, { error: "Position not found." });
    sendJson(response, 200, updated);
  } else if (request.method === "DELETE" && url.pathname.startsWith("/api/portfolio/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/portfolio/".length));
    if (!database.deletePosition(id)) return sendJson(response, 404, { error: "Position not found." });
    sendJson(response, 200, { deleted: true });
  } else if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
    const run = database.getRun(id);
    if (!run) return sendJson(response, 404, { error: "Run not found." });
    let report: string | null = null;
    if (run.reportPath) report = await safeReadReport(run.reportPath);
    sendJson(response, 200, { ...run, evaluations: database.getRunEvaluations(id), report });
  } else if (request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/run")) {
    const task = url.pathname.slice("/api/tasks/".length, -"/run".length) as TaskName;
    if (!isTaskName(task, database)) {
      return sendJson(response, 404, { error: "Unknown task." });
    }
    spawnTask(task);
    sendJson(response, 202, { accepted: true, task });
  } else if (url.pathname === "/api/chat/sessions" && request.method === "GET") {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
    sendJson(response, 200, { sessions: database.listChats(100, offset) });
  } else if (url.pathname === "/api/chat/sessions" && request.method === "POST") {
    sendJson(response, 201, database.createChat());
  } else if (url.pathname.startsWith("/api/chat/sessions/")) {
    const id = url.pathname.slice("/api/chat/sessions/".length);
    const stored = database.getChat(id);
    if (!stored) return sendJson(response, 404, { error: "会话不存在或已删除。" });
    if (request.method === "DELETE") { sessions.delete(id); sendJson(response, 200, { deleted: true }); }
    else if (request.method === "GET") sendJson(response, 200, { ...stored, messages: visibleChatMessages(stored.messages), busy: sessions.isBusy(id) });
    else sendJson(response, 405, { error: "Method not allowed." });
  } else if (request.method === "POST" && url.pathname === "/api/chat") {
    await chat(request, response);
  } else if (request.method === "GET") {
    await serveStatic(url.pathname, response);
  } else {
    sendJson(response, 404, { error: "Not found." });
  }
}

async function chat(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request) as { sessionId?: string; message?: string };
  const message = body.message?.trim();
  if (!message || message.length > 20_000) return sendJson(response, 400, { error: "Message must contain 1–20,000 characters." });
  if (body.sessionId && !validSessionId(body.sessionId)) return sendJson(response, 400, { error: "Invalid session ID." });
  const sessionId = body.sessionId ?? database.createChat().id;
  let agent: Agent;
  try { agent = await sessions.acquire(sessionId); }
  catch (error) {
    const stored = database.getChat(sessionId);
    if (stored && !(error instanceof ChatSessionError)) database.saveChat(sessionId, [...stored.messages, { role: "user", content: message, timestamp: Date.now() }], "error", error instanceof Error ? error.message : String(error));
    throw error;
  }
  database.saveChat(sessionId, agent.state.messages, "running");
  let failure: string | null = null;

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  sendSse(response, "session", { sessionId });

  const abortOnClose = () => {
    if (!response.writableEnded) agent.abort();
  };
  response.on("close", abortOnClose);

  try {
    await telemetry.withSpan("agent.chat", {
      "openinference.span.kind": "AGENT",
      "livermore.chat.session_id": sessionId,
      "livermore.chat.message_length": message.length,
    }, async (_span, activeContext) => {
      const observation = observeAgent(agent, telemetry, activeContext);
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "message_end" || event.type === "turn_end") database.saveChat(sessionId, agent.state.messages, "running");
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          sendSse(response, "delta", { text: event.assistantMessageEvent.delta });
        } else if (event.type === "tool_execution_start") {
          sendSse(response, "tool_start", { id: event.toolCallId, name: event.toolName });
        } else if (event.type === "tool_execution_end") {
          sendSse(response, "tool_end", { id: event.toolCallId, name: event.toolName, error: event.isError });
        }
      });
      try {
        await agent.prompt(message);
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        sendSse(response, "done", { usage: observation.usage });
      } finally {
        unsubscribe();
        observation.unsubscribe();
      }
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    sendSse(response, "error", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    response.off("close", abortOnClose);
    database.saveChat(sessionId, agent.state.messages, failure ? "error" : "idle", failure);
    sessions.release(sessionId);
    response.end();
    await telemetry.forceFlush();
  }
}

async function capabilitySnapshot(refresh = false) {
  const skills = await listSkillDescriptors(refresh);
  const tools = [createReportTool(), ...createRuntimeTools(config, database)].map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    status: "available",
  }));
  return {
    semantics: {
      skills: "仅列出 Livermore 项目 skills/ 目录中的技能，调用时按需读取。",
      mcps: "Livermore 运行时已登记的 MCP。",
    },
    skills: skills.map(({ name, description, location }) => ({
      name,
      description,
      location,
      loading: "on-demand",
      status: "loadable",
    })),
    mcps: database.listMcpServers().map(toPublicMcp),
    connections: [
      {
        name: "Feishu Agent Bot",
        kind: "WebSocket + OpenAPI",
        endpoint: "飞书开放平台",
        status: config.feishuAppId && config.feishuAppSecret ? "configured" : "needs-configuration",
        description: "接收飞书对话，并向已订阅会话推送定时报告和风险提醒。",
      },
      {
        name: "东方财富资金流向",
        kind: "Public HTTP",
        endpoint: "https://data.eastmoney.com/zjlx/",
        status: "configured",
        description: "查询 A 股主力净流入及超大单/大单/中单/小单明细；无需付费 API Key。",
      },
      {
        name: "公开财经网页",
        kind: "Direct fetch",
        endpoint: "内置来源清单",
        status: "configured",
        description: "Tavily 不可用时的日报降级数据源。",
      },
    ],
    tools,
  };
}

function spawnTask(task: TaskName): void {
  const argumentsByTask = !isBuiltinTaskName(task)
    ? [...nodeEntrypointArguments("custom-task-cli.ts"), "--task", task, "--force"] : task === "portfolio-risk-check"
    ? [...nodeEntrypointArguments("portfolio-risk-cli.ts"), "--force"]
    : [...nodeEntrypointArguments("briefing-cli.ts"), "--task", task, "--force"];
  const child = spawn(process.execPath, argumentsByTask, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function parsePositionInput(value: unknown): PortfolioPositionInput {
  if (!value || typeof value !== "object") throw new Error("Position body must be an object.");
  const input = value as Record<string, unknown>;
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const quantity = Number(input.quantity);
  const costBasis = Number(input.costBasis);
  const purchasedAt = String(input.purchasedAt ?? "").trim();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol)) {
    throw new Error("股票代码应为 1–20 位字母、数字、点或短横线。");
  }
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000_000) {
    throw new Error("持仓数量必须是大于 0 的有效数字。");
  }
  if (!Number.isFinite(costBasis) || costBasis <= 0 || costBasis > 100_000_000) {
    throw new Error("买入成本必须是大于 0 的有效数字。");
  }
  const parsedDate = new Date(purchasedAt);
  if (!purchasedAt || Number.isNaN(parsedDate.getTime()) || parsedDate.getTime() > Date.now() + 60_000) {
    throw new Error("买入时间无效，且不能晚于当前时间。");
  }
  const alertAbove = parseOptionalAlertPrice(input.alertAbove, "上涨预警价");
  const alertBelow = parseOptionalAlertPrice(input.alertBelow, "下跌预警价");
  if (alertAbove !== null && alertBelow !== null && alertAbove <= alertBelow) {
    throw new Error("上涨预警价必须高于下跌预警价。");
  }
  return { symbol, quantity, costBasis, purchasedAt: parsedDate.toISOString(), alertAbove, alertBelow };
}

function parseOptionalAlertPrice(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000_000) {
    throw new Error(`${label}必须是大于 0 的有效数字。`);
  }
  return parsed;
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filename = path.resolve(webDirectory, requested);
  const relative = path.relative(webDirectory, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return sendJson(response, 403, { error: "Forbidden." });
  let info;
  try {
    info = await stat(filename);
  } catch {
    return sendJson(response, 404, { error: "Not found." });
  }
  if (!info.isFile()) return sendJson(response, 404, { error: "Not found." });
  response.writeHead(200, {
    "Content-Type": contentType(filename),
    "Cache-Control": filename.endsWith(".html") ? "no-cache" : "public, max-age=300",
  });
  createReadStream(filename).pipe(response);
}

async function safeReadReport(filename: string): Promise<string> {
  const resolved = path.resolve(filename);
  const relative = path.relative(reportsDirectory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Report path is outside data/reports.");
  return (await readFile(resolved, "utf8")).slice(0, 100_000);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function validSessionId(value: string | undefined): boolean {
  return Boolean(value && /^[a-zA-Z0-9_-]{1,80}$/.test(value));
}

function sendSse(response: ServerResponse, event: string, data: unknown): void {
  if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

function contentType(filename: string): string {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
