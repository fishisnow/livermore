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
      state: { systemPrompt: "只做研究", tools: [], messages: [userMessage] },
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
      toolName: "query_a_share_main_fund_flow",
      args: { query: "600519 最新价" },
    });
    listener?.({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "query_a_share_main_fund_flow",
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
      "llm.input_messages.0.message.role": "system",
      "llm.input_messages.0.message.content": "只做研究",
      "llm.input_messages.1.message.role": "user",
      "llm.input_messages.1.message.content": "检查持仓",
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.content": "风险可控",
    });
    expect(observation.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.002,
      costCurrency: "USD",
    });
    const chat = spans.find((span) => span.name === "gen_ai.chat");
    expect(chat?.attributes["output.value"]).toBeUndefined();
    expect(chat?.attributes["input.value"]).toBeUndefined();
    expect(spans.find((span) => span.name === "tool.query_a_share_main_fund_flow")?.attributes).toMatchObject({
      "openinference.span.kind": "TOOL",
      "tool.name": "query_a_share_main_fund_flow",
      "input.mime_type": "application/json",
      "output.mime_type": "application/json",
    });
  });

  it("records tool results and calls as Phoenix message cards without thinking text", async () => {
    const exporter = new InMemorySpanExporter();
    telemetry = Telemetry.create(loadConfig({
      TRACING_ENABLED: "true",
      TRACE_CONTENT_ENABLED: "true",
    }), exporter);
    let listener: ((event: AgentEvent) => void) | undefined;
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "query_a_share_main_fund_flow",
      content: [{ type: "text" as const, text: "{\"最新价\":1400}" }],
      isError: false,
      timestamp: 2,
    };
    const assistantMessage = {
      role: "assistant" as const,
      content: [
        { type: "thinking" as const, thinking: "内部推理不应入库" },
        { type: "toolCall" as const, id: "call-2", name: "read_skill", arguments: { name: "market" } },
      ],
      api: "openai-completions" as const,
      provider: "deepseek" as const,
      model: "deepseek-test",
      usage: {
        input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1, totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: 3,
    };
    const agent = {
      state: {
        systemPrompt: "只做研究",
        tools: [{ name: "read_skill", description: "读取技能", parameters: { type: "object" } }],
        messages: [
          { role: "system", content: "只做研究", sections: { focus: "资金流" }, timestamp: 0 },
          { role: "user", content: [{ type: "text", text: "检查持仓" }, { type: "image", mimeType: "image/png", data: "secret" }], timestamp: 1 },
          toolResult,
        ],
      },
      subscribe(callback: (event: AgentEvent) => void) {
        listener = callback;
        return () => { listener = undefined; };
      },
    } as unknown as Agent;

    const observation = observeAgent(agent, telemetry, ROOT_CONTEXT);
    listener?.({ type: "message_start", message: assistantMessage });
    listener?.({ type: "message_end", message: assistantMessage });
    observation.unsubscribe();
    await telemetry.forceFlush();

    const attributes = exporter.getFinishedSpans().find((span) => span.name === "gen_ai.chat")?.attributes;
    expect(attributes).toMatchObject({
      "llm.input_messages.0.message.role": "system",
      "llm.input_messages.0.message.content": "只做研究\n\n[focus]\n资金流",
      "llm.input_messages.1.message.role": "user",
      "llm.input_messages.1.message.content": "检查持仓\n[image]",
      "llm.input_messages.2.message.role": "tool",
      "llm.input_messages.2.message.name": "query_a_share_main_fund_flow",
      "llm.input_messages.2.message.tool_call_id": "call-1",
      "llm.input_messages.2.message.content": "{\"最新价\":1400}",
      "llm.tools.0.tool.json_schema": JSON.stringify({
        name: "read_skill",
        description: "读取技能",
        parameters: { type: "object" },
      }),
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.content": "[thinking redacted]",
      "llm.output_messages.0.message.tool_calls.0.tool_call.id": "call-2",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.name": "read_skill",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments": JSON.stringify({ name: "market" }),
    });
    expect(JSON.stringify(attributes)).not.toContain("内部推理不应入库");
    expect(JSON.stringify(attributes)).not.toContain("secret");
  });

  it("keeps message cards after the default 128 attribute limit", async () => {
    const exporter = new InMemorySpanExporter();
    telemetry = Telemetry.create(loadConfig({
      TRACING_ENABLED: "true",
      TRACE_CONTENT_ENABLED: "true",
    }), exporter);
    let listener: ((event: AgentEvent) => void) | undefined;
    const messages = Array.from({ length: 200 }, (_, index) => ({
      role: "user" as const,
      content: `消息 ${index}`,
      timestamp: index,
    }));
    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "完成" }],
      api: "openai-completions" as const,
      provider: "deepseek" as const,
      model: "deepseek-test",
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 201,
    };
    const agent = {
      state: { systemPrompt: "", tools: [], messages },
      subscribe(callback: (event: AgentEvent) => void) {
        listener = callback;
        return () => { listener = undefined; };
      },
    } as unknown as Agent;

    const observation = observeAgent(agent, telemetry, ROOT_CONTEXT);
    listener?.({ type: "message_start", message: assistantMessage });
    listener?.({ type: "message_end", message: assistantMessage });
    observation.unsubscribe();
    await telemetry.forceFlush();

    expect(exporter.getFinishedSpans().find((span) => span.name === "gen_ai.chat")?.attributes).toMatchObject({
      "llm.input_messages.199.message.role": "user",
      "llm.input_messages.199.message.content": "消息 199",
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
      state: { systemPrompt: "测试", tools: [], messages: [] },
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
