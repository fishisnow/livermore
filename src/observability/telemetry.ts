import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config.js";
import type { RunUsage } from "../storage/database.js";

const emptyUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  cost: 0,
});

export class Telemetry {
  private constructor(
    readonly enabled: boolean,
    readonly captureContent: boolean,
    private readonly provider: NodeTracerProvider | undefined,
    readonly tracer: Tracer,
  ) {}

  static create(config: AppConfig, spanExporter?: SpanExporter): Telemetry {
    if (!config.tracingEnabled) return new Telemetry(false, false, undefined, trace.getTracer("livermore"));
    const exporter = spanExporter ?? new OTLPTraceExporter({ url: config.otlpTraceEndpoint, timeoutMillis: 5_000 });
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "livermore-agent",
        "service.version": "0.1.0",
        "deployment.environment.name": process.env.NODE_ENV ?? "local",
        "openinference.project.name": "livermore",
      }),
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 500, exportTimeoutMillis: 5_000 })],
    });
    provider.register();
    return new Telemetry(true, config.traceContentEnabled, provider, provider.getTracer("livermore-agent", "0.1.0"));
  }

  async withSpan<T>(name: string, attributes: Attributes, fn: (span: Span, activeContext: Context) => Promise<T>): Promise<T> {
    if (!this.enabled) {
      const span = this.tracer.startSpan(name, { attributes }, ROOT_CONTEXT);
      try {
        return await fn(span, ROOT_CONTEXT);
      } finally {
        span.end();
      }
    }
    return this.tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
      try {
        const result = await fn(span, context.active());
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async forceFlush(): Promise<void> {
    if (!this.provider) return;
    try {
      await this.provider.forceFlush();
    } catch (error) {
      console.warn(`Trace flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.provider) return;
    try {
      await this.provider.shutdown();
    } catch (error) {
      console.warn(`Trace shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function observeAgent(
  agent: Agent,
  telemetry: Telemetry,
  parentContext: Context,
): { usage: RunUsage; unsubscribe: () => void } {
  const result = { usage: emptyUsage() };
  if (!telemetry.enabled) return { ...result, unsubscribe: () => {} };
  let turnSpan: Span | undefined;
  let modelSpan: Span | undefined;
  let turnContext = parentContext;
  const toolSpans = new Map<string, Span>();

  const unsubscribe = agent.subscribe((event) => {
    handleAgentEvent(event);
  });
  return { ...result, unsubscribe };

  function handleAgentEvent(event: AgentEvent): void {
    if (event.type === "turn_start") {
      turnSpan = telemetry.tracer.startSpan("agent.turn", {
        attributes: {
          "openinference.span.kind": "AGENT",
          ...(telemetry.captureContent ? traceInput(serializeAgentContext(agent)) : {}),
        },
      }, parentContext);
      turnContext = trace.setSpan(parentContext, turnSpan);
    } else if (event.type === "message_start" && event.message.role === "assistant") {
      modelSpan = telemetry.tracer.startSpan("gen_ai.chat", {
        attributes: {
          "openinference.span.kind": "LLM",
          "gen_ai.operation.name": "chat",
          "llm.provider": event.message.provider,
          "llm.system": event.message.provider,
          "llm.model_name": event.message.model,
          ...(telemetry.captureContent ? traceInput(serializeAgentContext(agent)) : {}),
        },
      }, turnContext);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      finishModelSpan(event.message);
    } else if (event.type === "tool_execution_start") {
      const span = telemetry.tracer.startSpan(`tool.${event.toolName}`, {
        attributes: {
          "openinference.span.kind": "TOOL",
          "tool.name": event.toolName,
          "gen_ai.tool.name": event.toolName,
          "gen_ai.tool.call.id": event.toolCallId,
          ...(telemetry.captureContent ? traceInput(safeJson(event.args)) : {}),
        },
      }, turnContext);
      toolSpans.set(event.toolCallId, span);
    } else if (event.type === "tool_execution_end") {
      const span = toolSpans.get(event.toolCallId);
      if (span) {
        if (telemetry.captureContent) span.setAttributes(traceOutput(safeJson(event.result)));
        span.setAttribute("error.type", event.isError ? "tool_execution_error" : "");
        span.setStatus({ code: event.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span.end();
        toolSpans.delete(event.toolCallId);
      }
    } else if (event.type === "turn_end") {
      if (turnSpan && telemetry.captureContent) turnSpan.setAttributes(traceOutput(serializeMessage(event.message)));
      turnSpan?.end();
      turnSpan = undefined;
      turnContext = parentContext;
    } else if (event.type === "agent_end") {
      modelSpan?.end();
      turnSpan?.end();
      for (const span of toolSpans.values()) span.end();
      toolSpans.clear();
    }
  }

  function finishModelSpan(message: AssistantMessage): void {
    const usage = message.usage;
    result.usage.inputTokens += usage.input;
    result.usage.outputTokens += usage.output;
    result.usage.cacheReadTokens += usage.cacheRead;
    result.usage.cacheWriteTokens += usage.cacheWrite;
    result.usage.reasoningTokens += usage.reasoning ?? 0;
    result.usage.cost += usage.cost.total;
    if (!modelSpan) return;
    modelSpan.setAttributes({
      "gen_ai.provider.name": message.provider,
      "gen_ai.request.model": message.model,
      "gen_ai.response.model": message.responseModel ?? message.model,
      "gen_ai.response.finish_reasons": message.stopReason,
      "gen_ai.usage.input_tokens": usage.input,
      "gen_ai.usage.output_tokens": usage.output,
      "gen_ai.usage.cache_read_tokens": usage.cacheRead,
      "gen_ai.usage.cache_write_tokens": usage.cacheWrite,
      "gen_ai.usage.reasoning_tokens": usage.reasoning ?? 0,
      "gen_ai.usage.cost": usage.cost.total,
      "llm.token_count.prompt": usage.input,
      "llm.token_count.completion": usage.output,
      "llm.token_count.total": usage.totalTokens,
      ...(telemetry.captureContent ? traceOutput(serializeMessage(message)) : {}),
    });
    if (message.errorMessage) {
      modelSpan.setStatus({ code: SpanStatusCode.ERROR, message: message.errorMessage });
      modelSpan.recordException(new Error(message.errorMessage));
    } else {
      modelSpan.setStatus({ code: SpanStatusCode.OK });
    }
    modelSpan.end();
    modelSpan = undefined;
  }
}

function traceInput(value: string): Attributes {
  return { "input.value": truncate(value), "input.mime_type": "application/json" };
}

function traceOutput(value: string): Attributes {
  return { "output.value": truncate(value), "output.mime_type": "application/json" };
}

function serializeAgentContext(agent: Agent): string {
  return safeJson({
    systemPrompt: agent.state.systemPrompt,
    messages: agent.state.messages.map(messageForTrace),
  });
}

function serializeMessage(message: unknown): string {
  return safeJson(messageForTrace(message));
}

function messageForTrace(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const value = message as Record<string, unknown>;
  const role = value.role;
  const content = Array.isArray(value.content)
    ? value.content.map((item) => {
      if (!item || typeof item !== "object") return item;
      const block = item as Record<string, unknown>;
      if (block.type === "thinking") return { type: "thinking", redacted: true };
      if (block.type === "image") return { type: "image", mimeType: block.mimeType };
      return block;
    })
    : value.content;
  return {
    role,
    ...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
    ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
    content,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function truncate(value: string): string {
  const maximum = 100_000;
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…[truncated]`;
}
