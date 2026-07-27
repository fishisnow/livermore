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
      iwencaiBaseUrl: "https://openapi.iwencai.com",
      iwencaiApiKey: undefined,
      searchMaxResults: 5,
      tracingEnabled: true,
      traceContentEnabled: true,
      otlpTraceEndpoint: "http://localhost:6006/v1/traces",
      phoenixUiUrl: "http://localhost:6006",
      webPort: 4310,
      webUiUrl: "http://127.0.0.1:4310",
      feishuWebhookUrl: undefined,
      wechatWebhookUrl: undefined,
      notifyOnSuccess: true,
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
      iwencaiBaseUrl: "https://openapi.iwencai.com",
      iwencaiApiKey: undefined,
      searchMaxResults: 5,
      tracingEnabled: true,
      traceContentEnabled: true,
      otlpTraceEndpoint: "http://localhost:6006/v1/traces",
      phoenixUiUrl: "http://localhost:6006",
      webPort: 4310,
      webUiUrl: "http://127.0.0.1:4310",
      feishuWebhookUrl: undefined,
      wechatWebhookUrl: undefined,
      notifyOnSuccess: true,
    });
  });

  it("validates the search result limit", () => {
    expect(() => loadConfig({ SEARCH_MAX_RESULTS: "0" })).toThrow("between 5 and 20");
    expect(() => loadConfig({ SEARCH_MAX_RESULTS: "4" })).toThrow("between 5 and 20");
  });

  it("validates the local Agent Web port", () => {
    expect(() => loadConfig({ LIVERMORE_WEB_PORT: "80" })).toThrow("between 1024 and 65535");
    expect(loadConfig({ LIVERMORE_WEB_PORT: "5310" }).webUiUrl).toBe("http://127.0.0.1:5310");
  });

  it("allows Tavily MCP to be disabled for direct-source-only operation", () => {
    expect(loadConfig({ TAVILY_MCP_ENABLED: "false" }).tavilyMcpEnabled).toBe(false);
    expect(() => loadConfig({ TAVILY_MCP_ENABLED: "sometimes" })).toThrow("must be true or false");
  });

  it("allows local Trace content capture to be disabled", () => {
    expect(loadConfig({ TRACE_CONTENT_ENABLED: "false" }).traceContentEnabled).toBe(false);
    expect(() => loadConfig({ TRACE_CONTENT_ENABLED: "sometimes" })).toThrow("must be true or false");
  });
});
