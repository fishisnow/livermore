import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createLivermoreChatAgent } from "./chat/livermore-chat-agent.js";
import { loadConfig } from "./config.js";
import { observeAgent, Telemetry } from "./observability/telemetry.js";
import { databasePath, projectRoot, reportsDirectory, webDirectory } from "./project-paths.js";
import { InvestmentDatabase } from "./storage/database.js";
import type { PortfolioPositionInput, TaskName } from "./storage/database.js";
import { createReportTool } from "./tools/report-tool.js";
import { createRuntimeTools, listSkillDescriptors } from "./tools/runtime-tools.js";

interface ChatSession {
  agent: Agent;
  busy: boolean;
  lastUsedAt: number;
}

const config = loadConfig();
const database = new InvestmentDatabase(databasePath);
const telemetry = Telemetry.create(config);
const sessions = new Map<string, ChatSession>();

const taskSchedules = [
  { task: "market-briefing", title: "每日市场简报", schedule: "工作日 08:30 / 12:00 / 16:10" },
  { task: "ai-industry-chain", title: "AI 产业链日报", schedule: "工作日 08:45 / 17:00" },
  { task: "portfolio-risk-check", title: "持仓风险巡检", schedule: "工作日 09:30—15:00 · 每小时" },
] as const;

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (response.headersSent) {
      sendSse(response, "error", { message: error instanceof Error ? error.message : String(error) });
      response.end();
    } else {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
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
  console.log(`Livermore Agent Web: ${config.webUiUrl}`);
});

const cleanup = setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60_000;
  for (const [id, session] of sessions) {
    if (!session.busy && session.lastUsedAt < cutoff) sessions.delete(id);
  }
}, 30 * 60_000);
cleanup.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    for (const session of sessions.values()) session.agent.abort();
    await telemetry.shutdown();
    database.close();
    process.exit(0);
  });
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", config.webUiUrl);
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "livermore-agent-web" });
  } else if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const capabilities = await capabilitySnapshot();
    const runs = database.listRuns(30);
    sendJson(response, 200, {
      agent: {
        provider: config.provider,
        model: config.model,
        tavily: config.tavilyMcpEnabled && Boolean(config.tavilyApiKey),
        skillCount: capabilities.skills.length,
        mcpCount: capabilities.mcps.filter((item) => item.status === "configured").length,
        toolCount: capabilities.tools.length,
        phoenixUrl: config.phoenixUiUrl,
      },
      tasks: taskSchedules.map((task) => ({
        ...task,
        latest: runs.find((run) => run.task === task.task) ?? null,
        running: runs.find((run) => run.task === task.task && run.status === "running") ?? null,
      })),
      recentRuns: runs.slice(0, 12),
    });
  } else if (request.method === "GET" && url.pathname === "/api/capabilities") {
    sendJson(response, 200, await capabilitySnapshot(url.searchParams.get("refresh") === "true"));
  } else if (request.method === "GET" && url.pathname === "/api/portfolio") {
    sendJson(response, 200, { positions: database.listPositions() });
  } else if (request.method === "POST" && url.pathname === "/api/portfolio") {
    const input = parsePositionInput(await readJsonBody(request));
    sendJson(response, 201, database.createPosition(input));
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
    if (task !== "market-briefing" && task !== "ai-industry-chain" && task !== "portfolio-risk-check") {
      return sendJson(response, 404, { error: "Unknown task." });
    }
    spawnTask(task);
    sendJson(response, 202, { accepted: true, task });
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
  const sessionId = validSessionId(body.sessionId) ? body.sessionId! : randomUUID();
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      agent: await createLivermoreChatAgent(config, database, "Agent Web"),
      busy: false,
      lastUsedAt: Date.now(),
    };
    sessions.set(sessionId, session);
  }
  if (session.busy) return sendJson(response, 409, { error: "This conversation is still processing the previous message." });
  session.busy = true;
  session.lastUsedAt = Date.now();

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  sendSse(response, "session", { sessionId });

  const abortOnClose = () => {
    if (!response.writableEnded) session!.agent.abort();
  };
  response.on("close", abortOnClose);

  try {
    await telemetry.withSpan("agent.chat", {
      "openinference.span.kind": "AGENT",
      "livermore.chat.session_id": sessionId,
      "livermore.chat.message_length": message.length,
    }, async (_span, activeContext) => {
      const observation = observeAgent(session!.agent, telemetry, activeContext);
      const unsubscribe = session!.agent.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          sendSse(response, "delta", { text: event.assistantMessageEvent.delta });
        } else if (event.type === "tool_execution_start") {
          sendSse(response, "tool_start", { id: event.toolCallId, name: event.toolName });
        } else if (event.type === "tool_execution_end") {
          sendSse(response, "tool_end", { id: event.toolCallId, name: event.toolName, error: event.isError });
        }
      });
      try {
        await session!.agent.prompt(message);
        if (session!.agent.state.errorMessage) throw new Error(session!.agent.state.errorMessage);
        sendSse(response, "done", { usage: observation.usage });
      } finally {
        unsubscribe();
        observation.unsubscribe();
      }
    });
  } catch (error) {
    sendSse(response, "error", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    response.off("close", abortOnClose);
    session.busy = false;
    session.lastUsedAt = Date.now();
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
      mcps: "仅列出 Livermore 运行时实际配置的 MCP，不包含 Codex 桌面环境的 MCP。",
    },
    skills: skills.map(({ name, description, location }) => ({
      name,
      description,
      location,
      loading: "on-demand",
      status: name === "hithink-market-query" && !config.iwencaiApiKey ? "needs-configuration" : "loadable",
    })),
    mcps: [{
      name: "Tavily Search",
      transport: "HTTP MCP",
      endpoint: config.tavilyMcpUrl,
      status: !config.tavilyMcpEnabled
        ? "disabled"
        : config.tavilyApiKey ? "configured" : "needs-configuration",
      description: "交互研究和日报使用的实时网页搜索。",
    }],
    connections: [
      {
        name: "Feishu Agent Bot",
        kind: "WebSocket + OpenAPI",
        endpoint: "飞书开放平台",
        status: config.feishuAppId && config.feishuAppSecret ? "configured" : "needs-configuration",
        description: "接收飞书对话，并向已订阅会话推送定时报告和风险提醒。",
      },
      {
        name: "Iwencai OpenAPI",
        kind: "Skill API",
        endpoint: config.iwencaiBaseUrl,
        status: config.iwencaiApiKey ? "configured" : "needs-configuration",
        description: "供 hithink-market-query 技能使用；它是 API 连接，不是 MCP。",
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
  const argumentsByTask = task === "portfolio-risk-check"
    ? ["--import", "tsx", path.join(projectRoot, "src", "portfolio-risk-cli.ts"), "--force"]
    : ["--import", "tsx", path.join(projectRoot, "src", "briefing-cli.ts"), "--task", task, "--force"];
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
  return { symbol, quantity, costBasis, purchasedAt: parsedDate.toISOString() };
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
    if (size > 64 * 1024) throw new Error("Request body is too large.");
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
