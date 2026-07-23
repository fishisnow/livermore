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
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
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
    private readonly provider: NodeTracerProvider | undefined,
    readonly tracer: Tracer,
  ) {}

  static create(config: AppConfig, spanExporter?: SpanExporter): Telemetry {
    if (!config.tracingEnabled) return new Telemetry(false, undefined, trace.getTracer("livermore"));
    const exporter = spanExporter ?? new OTLPTraceExporter({ url: config.otlpTraceEndpoint, timeoutMillis: 5_000 });
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "livermore-agent",
        "service.version": "0.1.0",
        "deployment.environment.name": process.env.NODE_ENV ?? "local",
      }),
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 500, exportTimeoutMillis: 5_000 })],
    });
    provider.register();
    return new Telemetry(true, provider, provider.getTracer("livermore-agent", "0.1.0"));
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

export function observeAgent(agent: Agent, telemetry: Telemetry, parentContext: Context): { usage: RunUsage; unsubscribe: () => void } {
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
      turnSpan = telemetry.tracer.startSpan("agent.turn", {}, parentContext);
      turnContext = trace.setSpan(parentContext, turnSpan);
    } else if (event.type === "message_start" && event.message.role === "assistant") {
      modelSpan = telemetry.tracer.startSpan("gen_ai.chat", {
        attributes: { "gen_ai.operation.name": "chat" },
      }, turnContext);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      finishModelSpan(event.message);
    } else if (event.type === "tool_execution_start") {
      const span = telemetry.tracer.startSpan(`tool.${event.toolName}`, {
        attributes: { "gen_ai.tool.name": event.toolName, "gen_ai.tool.call.id": event.toolCallId },
      }, turnContext);
      toolSpans.set(event.toolCallId, span);
    } else if (event.type === "tool_execution_end") {
      const span = toolSpans.get(event.toolCallId);
      if (span) {
        span.setAttribute("error.type", event.isError ? "tool_execution_error" : "");
        span.setStatus({ code: event.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        span.end();
        toolSpans.delete(event.toolCallId);
      }
    } else if (event.type === "turn_end") {
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
