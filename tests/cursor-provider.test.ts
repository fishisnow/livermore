import { describe, expect, it, afterEach, vi } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { createModels, normalizeContext } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import { cursorEnvironment, cursorProvider, CursorRuntime } from "../src/agent/cursor-provider.js";
import { loadConfig } from "../src/config.js";
import { observeAgent, Telemetry } from "../src/observability/telemetry.js";
import { verifyCursorToolCalls } from "../src/agent/cursor-verification.js";

describe("Cursor native Pi provider", () => {
  const runtimes: CursorRuntime[] = [];
  afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); vi.unstubAllEnvs(); });
  function fakeRuntime(options: { timeoutMs?: number; hostPath?: string; openAuthUrl?: (url: string) => Promise<void> } = {}) {
    const runtime = new CursorRuntime({ hostPath: path.resolve("tests/fixtures/cursor-host.mjs"), ...options });
    runtimes.push(runtime); return runtime;
  }

  it("isolates auth, disallows system credential reuse, and drops inherited secrets and Node preload flags", () => {
    const env = cursorEnvironment({ HOME: "/home/test", PATH: "/bin", CURSOR_ACCESS_TOKEN: "do-not-read", CURSOR_API_KEY: "secret", DEEPSEEK_API_KEY: "secret", PI_API_KEY: "secret", FEISHU_APP_SECRET: "secret", NODE_OPTIONS: "--require arbitrary", PI_CODING_AGENT_DIR: "/global/pi", PI_CURSOR_SYSTEM_CREDENTIALS: "1" }, "/workspace");
    expect(env).toMatchObject({ HOME: "/home/test", PI_CODING_AGENT_DIR: "/workspace/data/runtime/pi-cursor", PI_CURSOR_SYSTEM_CREDENTIALS: "0" });
    for (const key of ["CURSOR_ACCESS_TOKEN", "CURSOR_API_KEY", "DEEPSEEK_API_KEY", "PI_API_KEY", "FEISHU_APP_SECRET", "NODE_OPTIONS"]) expect(env[key]).toBeUndefined();
  });

  it("loads the real pinned Pi extension in an empty private workspace without credentials", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "livermore-cursor-native-"));
    const runtime = new CursorRuntime({ workspace: directory }); runtimes.push(runtime);
    try {
      expect(await runtime.command("status")).toContain("尚未登录");
      const catalog = await runtime.command("catalog");
      expect(Array.isArray(catalog) && catalog.some((model) => model.id === "auto")).toBe(true);
    } finally { runtime.close(); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  async function runLoop(systemPrompt: string, execute = vi.fn(async (_id: string, _params: unknown) => ({ content: [{ type: "text" as const, text: '{"symbol":"600519"}' }], details: {} }))) {
    const models = createModels(); models.setProvider(await cursorProvider("auto", fakeRuntime()));
    const agent = new Agent({ initialState: { systemPrompt, model: models.getModel("cursor", "auto")!, tools: [{ name: "portfolio", label: "Portfolio", description: "Read portfolio", parameters: obj({ symbol: str() }), execute }] }, streamFn: models.streamSimple.bind(models), sessionId: "native-test-session" });
    return { agent, execute };
  }

  it("executes native tool calls in Pi and emits LLM/tool traces without applying API prices", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = Telemetry.create(loadConfig({ TRACING_ENABLED: "true", MODEL_COST_INPUT_PER_MILLION: "100", MODEL_COST_OUTPUT_PER_MILLION: "100" }), exporter);
    const { agent, execute } = await runLoop("research only");
    const observation = observeAgent(agent, telemetry, ROOT_CONTEXT);
    try {
      await agent.prompt("查看持仓。");
      expect(agent.state.errorMessage).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toEqual({ symbol: "600519" });
      expect(observation.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, cost: 0 });
      expect(JSON.stringify(agent.state.messages.at(-1))).toContain("通过 Pi 工具核对");
      await telemetry.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans.filter((span) => span.name === "gen_ai.chat")).toHaveLength(2);
      expect(spans.find((span) => span.name === "tool.portfolio")?.attributes["input.value"]).toContain("600519");
      expect(spans.find((span) => span.name === "gen_ai.chat")?.attributes["input.value"]).toContain("research only");
      expect(spans.find((span) => span.name === "gen_ai.chat")?.attributes["input.value"]).toContain('"parameters"');
    } finally { observation.unsubscribe(); await telemetry.shutdown(); }
  });

  it("checks a fresh tool-generated proof with the same diagnostic used for live verification", async () => {
    const result = await verifyCursorToolCalls(loadConfig({ PI_PROVIDER: "cursor", PI_MODEL: "auto", TRACING_ENABLED: "false" }), fakeRuntime());
    expect(result).toMatchObject({ ok: true, provider: "cursor-native", toolCalls: 1, modelTurns: 2, traceId: null });
  });

  it.each(["unknown-tool", "bad-args"])("keeps Pi validation for %s instead of executing unauthorized tools", async (system) => {
    const { agent, execute } = await runLoop(system);
    await agent.prompt("检查持仓。");
    expect(execute).not.toHaveBeenCalled();
    expect(agent.state.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
  });

  it("returns failed tool results to the next model turn", async () => {
    const execute = vi.fn(async (_id: string, _params: unknown) => { throw new Error("data source quota"); });
    const { agent } = await runLoop("research only", execute);
    await agent.prompt("检查持仓。");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(agent.state.messages.at(-1))).toContain("工具查询失败");
  });

  it.each(["cancel", "timeout", "host-exit"])("handles %s without hanging a Pi request", async (mode) => {
    const runtime = fakeRuntime({ timeoutMs: 200 });
    const models = createModels(); models.setProvider(await cursorProvider("auto", runtime));
    const controller = new AbortController();
    const stream = models.streamSimple(models.getModel("cursor", "auto")!, normalizeContext({ messages: [], systemPrompt: mode === "host-exit" ? mode : "hang" }), { signal: controller.signal });
    const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 30) : undefined;
    const result = await stream.result(); clearTimeout(timer);
    expect(result.stopReason).toBe(mode === "cancel" ? "aborted" : "error");
  });

  it("rejects non-Cursor browser authorization URLs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "livermore-cursor-evil-"));
    const hostPath = path.join(directory, "evil-host.mjs");
    await cp(path.resolve("tests/fixtures/cursor-host.mjs"), hostPath);
    const open = vi.fn(async () => {});
    const runtime = fakeRuntime({ hostPath, openAuthUrl: open });
    try { await expect(runtime.command("login")).rejects.toThrow("非 Cursor 官方"); expect(open).not.toHaveBeenCalled(); }
    finally { runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
