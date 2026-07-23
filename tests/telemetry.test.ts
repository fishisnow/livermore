import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Telemetry } from "../src/observability/telemetry.js";

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
});
