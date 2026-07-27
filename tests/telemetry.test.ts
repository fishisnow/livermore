import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { loadConfig } from "../src/config.js";
import { observeAgent, Telemetry } from "../src/observability/telemetry.js";

describe("local OTLP tracing", () => {
  let telemetry: Telemetry | undefined;

  afterEach(async () => {
    await telemetry?.shutdown();
  });

  it("exports a completed task span through the configured provider", async () => {
    const exporter = new InMemorySpanExporter();
    telemetry = Telemetry.create(loadConfig({ TRACING_ENABLED: "true" }), exporter);
    await telemetry.withSpan("briefing.run", { "livermore.task": "test" }, async (span) => {
      span.setAttribute("livermore.run.id", "test-run");
    });
    await telemetry.forceFlush();

    expect(exporter.getFinishedSpans()).toEqual([
      expect.objectContaining({
        name: "briefing.run",
        attributes: expect.objectContaining({
          "livermore.task": "test",
          "livermore.run.id": "test-run",
        }),
      }),
    ]);
  });

  it("emits Phoenix-compatible AGENT, LLM and TOOL spans with local content", async () => {
    const exporter = new InMemorySpanExporter();
    telemetry = Telemetry.create(loadConfig({
      TRACING_ENABLED: "true",
      TRACE_CONTENT_ENABLED: "true",
    }), exporter);
    let listener: ((event: AgentEvent) => void) | undefined;
    const userMessage = { role: "user" as const, content: "检查持仓", timestamp: 1 };
    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "风险可控" }],
      api: "openai-completions" as const,
      provider: "deepseek" as const,
      model: "deepseek-test",
      usage: {
        input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
        cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
      },
      stopReason: "stop" as const,
      timestamp: 2,
    };
    const agent = {
      state: { systemPrompt: "只做研究", messages: [userMessage] },
      subscribe(callback: (event: AgentEvent) => void) {
        listener = callback;
        return () => { listener = undefined; };
      },
    } as unknown as Agent;

    const rootSpan = telemetry.tracer.startSpan("portfolio.risk_check", {
      attributes: { "openinference.span.kind": "CHAIN" },
    });
    const parentContext = (await import("@opentelemetry/api")).trace.setSpan(
      (await import("@opentelemetry/api")).context.active(),
      rootSpan,
    );
    const observation = observeAgent(agent, telemetry, parentContext);
    listener?.({ type: "turn_start" });
    listener?.({ type: "message_start", message: assistantMessage });
    listener?.({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "query_iwencai_market",
      args: { query: "600519 最新价" },
    });
    listener?.({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "query_iwencai_market",
      result: { content: [{ type: "text", text: "{\"最新价\":1400}" }] },
      isError: false,
    });
    listener?.({ type: "message_end", message: assistantMessage });
    listener?.({ type: "turn_end", message: assistantMessage, toolResults: [] });
    rootSpan.end();
    observation.unsubscribe();
    await telemetry.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.find((span) => span.name === "agent.turn")?.attributes).toMatchObject({
      "openinference.span.kind": "AGENT",
      "input.mime_type": "application/json",
    });
    expect(spans.find((span) => span.name === "gen_ai.chat")?.attributes).toMatchObject({
      "openinference.span.kind": "LLM",
      "llm.provider": "deepseek",
      "llm.model_name": "deepseek-test",
      "llm.token_count.total": 15,
      "output.mime_type": "application/json",
    });
    expect(observation.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.002,
      costCurrency: "USD",
    });
    expect(spans.find((span) => span.name === "tool.query_iwencai_market")?.attributes).toMatchObject({
      "openinference.span.kind": "TOOL",
      "tool.name": "query_iwencai_market",
      "input.mime_type": "application/json",
      "output.mime_type": "application/json",
    });
  });

  it("uses configured pricing and still collects usage when tracing is disabled", () => {
    telemetry = Telemetry.create(loadConfig({
      TRACING_ENABLED: "false",
      MODEL_COST_INPUT_PER_MILLION: "0.025",
      MODEL_COST_OUTPUT_PER_MILLION: "3",
      MODEL_COST_CURRENCY: "CNY",
    }));
    let listener: ((event: AgentEvent) => void) | undefined;
    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "完成" }],
      api: "openai-completions" as const,
      provider: "deepseek" as const,
      model: "deepseek-test",
      usage: {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 100_000,
        cacheWrite: 50_000,
        reasoning: 0,
        totalTokens: 2_150_000,
        cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99, total: 396 },
      },
      stopReason: "stop" as const,
      timestamp: 2,
    };
    const agent = {
      state: { systemPrompt: "测试", messages: [] },
      subscribe(callback: (event: AgentEvent) => void) {
        listener = callback;
        return () => { listener = undefined; };
      },
    } as unknown as Agent;

    const observation = observeAgent(agent, telemetry, ROOT_CONTEXT);
    listener?.({ type: "message_end", message: assistantMessage });

    expect(observation.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 50_000,
      reasoningTokens: 0,
      cost: 3.02875,
      costCurrency: "CNY",
    });
    observation.unsubscribe();
  });
});
