import { describe, expect, it } from "vitest";
import { collectDirectSources, contentSourceId } from "../src/briefings/direct-source-provider.js";
import { collectLiveSources, parseTavilyToolResult, stableSourceId, type McpSearchClient } from "../src/briefings/source-provider.js";
import { resolveAiMode, resolveMarketMode } from "../src/briefings/task-definitions.js";
import { InvestmentDatabase } from "../src/storage/database.js";
import type { BriefingTaskDefinition, SourceItem } from "../src/briefings/types.js";

describe("briefing modes", () => {
  it("uses Beijing local time for market sessions", () => {
    expect(resolveMarketMode(new Date("2026-07-16T01:00:00Z"), "Asia/Shanghai")).toBe("pre-market");
    expect(resolveMarketMode(new Date("2026-07-16T04:00:00Z"), "Asia/Shanghai")).toBe("intraday");
    expect(resolveMarketMode(new Date("2026-07-16T08:00:00Z"), "Asia/Shanghai")).toBe("close");
  });

  it("supports AI pre-market and close modes", () => {
    expect(resolveAiMode(new Date("2026-07-16T00:30:00Z"), "Asia/Shanghai")).toBe("pre-market");
    expect(resolveAiMode(new Date("2026-07-16T08:00:00Z"), "Asia/Shanghai")).toBe("close");
  });
});

describe("source identity and deduplication", () => {
  it("ignores fragments and tracking parameters in stable IDs", () => {
    expect(stableSourceId("https://example.com/news?id=7&utm_source=x#top"))
      .toBe(stableSourceId("https://example.com/news?id=7"));
  });

  it("commits IDs only when explicitly requested", async () => {
    const store = new InvestmentDatabase(":memory:");
    const runId = store.startRun({
      task: "market-briefing",
      mode: "pre-market",
      scheduledAt: "2026-07-16T01:00:00.000Z",
      idempotencyKey: "test-run",
    });
    const source: SourceItem = {
      id: "source-1",
      category: "A股",
      title: "示例",
      url: "https://example.com/1",
      summary: "示例摘要",
      retrievedAt: "2026-07-16T01:00:00.000Z",
    };

    expect(store.unseenSources("market-briefing", "2026-07-16", [source])).toEqual([source]);
    store.commitSources("market-briefing", "2026-07-16", [source], runId);
    expect(store.unseenSources("market-briefing", "2026-07-16", [source])).toEqual([]);
    store.close();
  });
});

describe("Tavily MCP collection", () => {
  it("parses the text format returned by the Tavily MCP tool", () => {
    expect(parseTavilyToolResult([{ type: "text", text: [
      "Detailed Results:",
      "",
      "Title: Example one",
      "URL: https://example.com/one",
      "Content: First summary",
      "",
      "Title: Example two",
      "URL: https://example.com/two",
      "Content: Second summary",
    ].join("\n") }])).toEqual([
      { title: "Example one", url: "https://example.com/one", content: "First summary" },
      { title: "Example two", url: "https://example.com/two", content: "Second summary" },
    ]);
  });

  it("surfaces error envelopes returned as successful MCP tool results", () => {
    expect(() => parseTavilyToolResult([{ type: "text", text: JSON.stringify({
      error: "Search failed",
      status: 432,
      detail: { error: "Usage limit exceeded" },
    }) }])).toThrow("Tavily MCP search error (status 432): Usage limit exceeded");
  });

  it("discovers and calls tavily_search over MCP", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let connected = false;
    let closed = false;
    let endpoint = "";
    const fakeClient: McpSearchClient = {
      async connect() { connected = true; },
      async listTools() { return ["tavily_search"]; },
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: "text", text: "Detailed Results:\n\nTitle: News\nURL: https://example.com/news\nContent: Summary" }] };
      },
      async close() { closed = true; },
    };
    const definition: BriefingTaskDefinition = {
      task: "market-briefing",
      title: "test",
      queries: [{ category: "A股", query: "market news", topic: "finance" }],
      resolveMode: () => "pre-market",
      buildPrompt: () => "",
    };

    const sources = await collectLiveSources(
      definition,
      "https://mcp.tavily.com/mcp/",
      "secret-key",
      5,
      new Date("2026-07-20T01:00:00Z"),
      (url) => { endpoint = url.toString(); return fakeClient; },
    );

    expect(connected).toBe(true);
    expect(closed).toBe(true);
    expect(new URL(endpoint).searchParams.get("tavilyApiKey")).toBe("secret-key");
    expect(calls).toEqual([{ name: "tavily_search", args: {
      query: "market news",
      topic: "general",
      time_range: "day",
      search_depth: "advanced",
      max_results: 5,
      include_raw_content: false,
    } }]);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe("https://example.com/news");
  });
});

describe("direct web source fallback", () => {
  it("extracts configured pages and reports partial failures", async () => {
    const result = await collectDirectSources("ai-industry-chain", new Date("2026-07-20T01:00:00Z"), {
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("SMCI")) return new Response("blocked", { status: 403 });
        return new Response("<html><main>content</main></html>", { status: 200 });
      },
      extract: async (_html, url) => ({
        title: `Extracted ${new URL(url).hostname}`,
        content: `Current market information from ${url}. `.repeat(5),
      }),
    });

    expect(result.sources).toHaveLength(7);
    expect(result.failures).toEqual(["Super Micro 行情与新闻: HTTP 403"]);
    expect(result.sources.every((source) => source.retrievedAt === "2026-07-20T01:00:00.000Z")).toBe(true);
  });

  it("changes the dedupe ID when a live page changes", () => {
    expect(contentSourceId("https://example.com/live", "version one"))
      .not.toBe(contentSourceId("https://example.com/live", "version two"));
  });
});
