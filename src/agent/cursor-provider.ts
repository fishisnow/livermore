import { fork, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type Provider,
  type SimpleStreamOptions, type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { projectRoot, runtimeDirectory, nodeEntrypointArguments } from "../project-paths.js";
import type { CursorCommand, CursorHostRequest, CursorHostResponse, CursorStreamOptions } from "./cursor-protocol.js";

export const cursorAuthDirectory = path.join(runtimeDirectory, "pi-cursor");

export function cursorEnvironment(source: NodeJS.ProcessEnv = process.env, workspace = projectRoot): NodeJS.ProcessEnv {
  const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LC_.*|TZ|SYSTEMROOT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR)$/;
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
  const directory = path.join(workspace, "data", "runtime", "pi-cursor");
  return {
    ...env, NO_COLOR: "1", PI_CODING_AGENT_DIR: directory, PI_CURSOR_SYSTEM_CREDENTIALS: "0",
    PI_CURSOR_CACHE_DIR: path.join(directory, "cache"), PI_CURSOR_LIFECYCLE_LOG: path.join(directory, "lifecycle.jsonl"),
  };
}

type Pending = { receive: (message: CursorHostResponse) => void; fail: (error: Error) => void };
export class CursorRuntime {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: { workspace?: string; hostPath?: string; timeoutMs?: number; openAuthUrl?: (url: string) => Promise<void> } = {}) {}

  private start(): ChildProcess {
    if (this.child?.connected) return this.child;
    const args = this.options.hostPath ? [this.options.hostPath] : nodeEntrypointArguments("agent/cursor-host.ts");
    const hostPath = args.at(-1)!;
    const child = fork(hostPath, [], {
      execArgv: args.slice(0, -1).map((arg) => arg === "tsx" ? import.meta.resolve("tsx") : arg), execPath: process.execPath,
      cwd: this.options.workspace ?? projectRoot, env: cursorEnvironment(process.env, this.options.workspace ?? projectRoot),
      stdio: ["ignore", "ignore", "inherit", "ipc"], serialization: "json",
    });
    child.unref();
    child.on("message", (message: CursorHostResponse) => { this.pending.get(message.id)?.receive(message); });
    const fail = (error: Error): void => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const item of this.pending.values()) item.fail(error);
      this.pending.clear();
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => fail(new Error(`Cursor Provider 进程退出（${signal ?? code}）。请重试；若持续失败，请重新授权。`)));
    this.child = child;
    return child;
  }

  private submit(request: CursorHostRequest, pending: Pending): () => void {
    const child = this.start();
    this.pending.set(request.id, pending);
    child.channel?.ref();
    child.send(request, (error) => { if (error) pending.fail(error); });
    return () => {
      this.pending.delete(request.id);
      if (!this.pending.size) child.channel?.unref();
    };
  }

  async command(command: CursorCommand | "catalog"): Promise<string | Model<Api>[]> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let release = (): void => {};
      const finish = (error?: Error, value?: string | Model<Api>[]): void => {
        clearTimeout(timer); release();
        if (error) reject(error); else resolve(value ?? "");
      };
      const timer = setTimeout(() => { this.child?.send({ id, command: "abort" }); finish(new Error(command === "login" ? "Cursor 浏览器授权超时，请重新登录。" : "Cursor Provider 操作超时。")); }, command === "login" ? 5 * 60_000 : 40_000);
      try {
        release = this.submit({ id, command }, {
          fail: (error) => finish(error),
          receive: (message) => {
            if (message.type === "error") finish(new Error(message.message));
            else if (message.type === "result") finish(undefined, message.value);
            else if (message.type === "auth_url") {
              void this.openBrowser(message.url).catch((error: unknown) => { this.child?.send({ id, command: "abort" }); finish(error instanceof Error ? error : new Error(String(error))); });
            }
          },
        });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private async openBrowser(value: string): Promise<void> {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "cursor.com" || url.pathname !== "/loginDeepControl") throw new Error("拒绝打开非 Cursor 官方授权地址。");
    if (this.options.openAuthUrl) return this.options.openAuthUrl(value);
    const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    await new Promise<void>((resolve, reject) => { execFile(command, [value], (error) => error ? reject(error) : resolve()); });
    console.log("已打开 Cursor 官方授权页，请在浏览器中完成 Livermore 独立授权。");
  }

  stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const events = createAssistantMessageEventStream();
    const id = randomUUID();
    let release = (): void => {};
    let finished = false;
    const cleanup = (): void => { clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); release(); };
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true; cleanup();
      const message: AssistantMessage = {
        role: "assistant", content: [], api: "cursor-native", provider: "cursor", model: model.id,
        timestamp: Date.now(), stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: error.message,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      events.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message }); events.end();
    };
    const abort = (): void => { this.child?.send({ id, command: "abort" }); fail(new Error("Cursor 请求已取消。")); };
    const timer = setTimeout(() => { this.child?.send({ id, command: "abort" }); fail(new Error("Cursor 模型调用超时，请检查网络或重试。")); }, this.options.timeoutMs ?? 180_000);
    if (options?.signal?.aborted) { abort(); return events; }
    options?.signal?.addEventListener("abort", abort, { once: true });
    const forwarded: CursorStreamOptions = {};
    for (const key of ["sessionId", "temperature", "maxTokens", "reasoning", "toolChoice"] as const) {
      if (options?.[key] !== undefined) Object.assign(forwarded, { [key]: options[key] });
    }
    try {
      release = this.submit({ id, command: "stream", modelId: model.id, context, options: forwarded }, {
        fail,
        receive: (message) => {
          if (finished) return;
          if (message.type === "error") fail(new Error(message.message));
          else if (message.type === "event") {
            events.push(message.event);
            if (message.event.type === "done" || message.event.type === "error") { finished = true; cleanup(); events.end(); }
          }
        },
      });
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    return events;
  }

  close(): void {
    const child = this.child;
    for (const pending of this.pending.values()) pending.fail(new Error("Cursor Provider 已关闭。"));
    this.pending.clear(); this.child = undefined; child?.kill("SIGTERM");
  }
}

let sharedRuntime: CursorRuntime | undefined;
export function getCursorRuntime(): CursorRuntime { return sharedRuntime ??= new CursorRuntime(); }

export async function cursorProvider(modelId: string, runtime = getCursorRuntime()): Promise<Provider> {
  const catalog = await runtime.command("catalog") as Model<Api>[];
  const model = catalog.find((item) => item.id === modelId);
  if (!model) throw new Error(`Cursor 模型不可用：${modelId}。请刷新可用模型。`);
  return {
    id: "cursor", name: "Cursor 订阅（Pi Native Provider）",
    auth: { apiKey: { name: "Livermore 独立 Cursor OAuth", resolve: async () => ({ auth: {}, source: "Livermore Cursor OAuth" }) } },
    getModels: () => [model],
    stream: (selected, context, options?: StreamOptions) => runtime.stream(selected, context, options),
    streamSimple: (selected, context, options) => runtime.stream(selected, context, options),
  };
}

export async function cursorCommand(command: CursorCommand): Promise<string> {
  const runtime = new CursorRuntime();
  try { return String(await runtime.command(command)); } finally { runtime.close(); }
}
