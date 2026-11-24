import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { Telemetry } from "../observability/telemetry.js";
import type { InvestmentDatabase } from "../storage/database.js";
import {
  checkWatch,
  deleteTrackingWatch,
  dismissCandidate,
  listRadar,
  proposeIdea,
  refreshCandidates,
  regenerateWatchFocus,
  startTracking,
  updateWatchFocus,
  updateWatchStatus,
  updateWatchTheme,
  watchDetail,
  type SignalNotice,
} from "./service.js";

export async function handleWatchApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: {
    config: AppConfig;
    database: InvestmentDatabase;
    telemetry: Telemetry;
    readJson: (request: IncomingMessage) => Promise<unknown>;
    notify: (notice: SignalNotice) => Promise<void>;
  },
): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/watches")) return false;
  const { config, database } = deps;
  if (pathname === "/api/watches" && request.method === "GET") {
    send(response, 200, listRadar(database, config));
    return true;
  }
  if (pathname === "/api/watches/candidates" && request.method === "POST") {
    send(response, 200, await refreshCandidates(database, config));
    return true;
  }
  if (pathname === "/api/watches/ideas" && request.method === "POST") {
    const body = await deps.readJson(request) as { text?: unknown };
    if (typeof body.text !== "string") {
      send(response, 400, { error: "请写下要跟踪的问题。" });
      return true;
    }
    send(response, 201, await proposeIdea(database, config, body.text));
    return true;
  }
  if (pathname === "/api/watches" && request.method === "POST") {
    const body = await deps.readJson(request) as { candidateId?: unknown };
    if (typeof body.candidateId !== "string") {
      send(response, 400, { error: "请选择一个观察后再开始跟踪。" });
      return true;
    }
    const watch = startTracking(database, decodeURIComponent(body.candidateId));
    send(response, 201, { watch: watchDetail(database, config, watch.id) });
    return true;
  }
  const match = pathname.match(/^\/api\/watches\/([^/]+)(?:\/(check|status|question|focus))?$/);
  if (!match) {
    send(response, 404, { error: "Not found." });
    return true;
  }
  const id = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  if (!action && request.method === "GET") {
    send(response, 200, watchDetail(database, config, id));
    return true;
  }
  if (!action && request.method === "DELETE") {
    const existing = database.watches.getWatch(id);
    if (!existing) {
      send(response, 404, { error: "没有找到这个观察。" });
      return true;
    }
    if (existing.status === "candidate") dismissCandidate(database, id);
    else deleteTrackingWatch(database, id);
    send(response, 200, { deleted: true });
    return true;
  }
  if (action === "check" && request.method === "POST") {
    const wantsStream = (request.headers.accept ?? "").includes("text/event-stream");
    if (wantsStream) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      try {
        const run = await checkWatch(database, id, {
          config,
          database,
          telemetry: deps.telemetry,
          notify: deps.notify,
          onProgress: (event) => sendSse(response, event.type === "delta" ? "delta" : "progress", event),
        });
        sendSse(response, "done", { run, detail: watchDetail(database, config, id) });
      } catch (error) {
        if (error instanceof Error && "statusCode" in error) {
          sendSse(response, "error", { message: error.message });
        } else {
          sendSse(response, "error", { message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        response.end();
        await deps.telemetry.forceFlush();
      }
      return true;
    }
    const run = await checkWatch(database, id, { config, database, telemetry: deps.telemetry, notify: deps.notify });
    send(response, 200, { run, detail: watchDetail(database, config, id) });
    return true;
  }
  if (action === "status" && request.method === "POST") {
    const body = await deps.readJson(request) as { status?: unknown };
    if (body.status !== "active" && body.status !== "paused" && body.status !== "ended") {
      send(response, 400, { error: "状态只能是跟踪、暂停或结束。" });
      return true;
    }
    updateWatchStatus(database, id, body.status);
    send(response, 200, watchDetail(database, config, id));
    return true;
  }
  if (action === "question" && request.method === "POST") {
    const body = await deps.readJson(request) as { question?: unknown };
    if (typeof body.question !== "string") {
      send(response, 400, { error: "请写下新的观察主题。" });
      return true;
    }
    send(response, 200, updateWatchTheme(database, config, id, body.question));
    return true;
  }
  if (action === "focus" && request.method === "POST") {
    const body = await deps.readJson(request) as { regenerate?: unknown; focus?: unknown; add?: unknown };
    if (body.regenerate === true) {
      send(response, 200, await regenerateWatchFocus(database, config, id));
      return true;
    }
    if (Array.isArray(body.focus)) {
      const values = body.focus.filter((item): item is string => typeof item === "string");
      send(response, 200, updateWatchFocus(database, config, id, values));
      return true;
    }
    if (typeof body.add === "string" && body.add.trim()) {
      const watch = database.watches.getWatch(id);
      if (!watch) {
        send(response, 404, { error: "没有找到这个观察。" });
        return true;
      }
      send(response, 200, updateWatchFocus(database, config, id, [...watch.scope.focus, body.add]));
      return true;
    }
    send(response, 400, { error: "请提供监测维度，或使用重新生成。" });
    return true;
  }
  send(response, 405, { error: "Method not allowed." });
  return true;
}

function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

function sendSse(response: ServerResponse, event: string, data: unknown): void {
  if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
