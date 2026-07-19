import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses stable project defaults", () => {
    expect(loadConfig({})).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      timezone: "Asia/Shanghai",
      tavilyMcpEnabled: true,
      tavilyMcpUrl: "https://mcp.tavily.com/mcp/",
      tavilyApiKey: undefined,
      searchMaxResults: 5,
      briefingReportApiUrl: undefined,
      briefingReportApiKey: undefined,
      briefingPublisher: "玄弈",
    });
  });

  it("accepts an explicit Pi model", () => {
    expect(loadConfig({ PI_PROVIDER: "openai", PI_MODEL: "gpt-5-mini" })).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      timezone: "Asia/Shanghai",
      tavilyMcpEnabled: true,
      tavilyMcpUrl: "https://mcp.tavily.com/mcp/",
      tavilyApiKey: undefined,
      searchMaxResults: 5,
      briefingReportApiUrl: undefined,
      briefingReportApiKey: undefined,
      briefingPublisher: "玄弈",
    });
  });

  it("validates the search result limit", () => {
    expect(() => loadConfig({ SEARCH_MAX_RESULTS: "0" })).toThrow("between 5 and 20");
    expect(() => loadConfig({ SEARCH_MAX_RESULTS: "4" })).toThrow("between 5 and 20");
  });

  it("allows Tavily MCP to be disabled for direct-source-only operation", () => {
    expect(loadConfig({ TAVILY_MCP_ENABLED: "false" }).tavilyMcpEnabled).toBe(false);
    expect(() => loadConfig({ TAVILY_MCP_ENABLED: "sometimes" })).toThrow("must be true or false");
  });
});
