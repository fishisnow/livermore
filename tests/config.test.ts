import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses stable project defaults", () => {
    expect(loadConfig({})).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiBaseUrl: undefined,
      timezone: "Asia/Shanghai",
      tavilyMcpEnabled: true,
      tavilyMcpUrl: "https://mcp.tavily.com/mcp/",
      tavilyApiKey: undefined,
      iwencaiBaseUrl: "https://openapi.iwencai.com",
      iwencaiApiKey: undefined,
      futuPythonExecutable: "/usr/bin/python3",
      futuOpenDHost: "127.0.0.1",
      futuOpenDPort: 11111,
      searchMaxResults: 5,
      tracingEnabled: true,
      traceContentEnabled: true,
      modelCostInputPerMillion: undefined,
      modelCostOutputPerMillion: undefined,
      modelCostCurrency: "USD",
      otlpTraceEndpoint: "http://localhost:6006/v1/traces",
      phoenixUiUrl: "http://localhost:6006",
      webPort: 4310,
      webUiUrl: "http://127.0.0.1:4310",
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuWebhookUrl: undefined,
      wechatWebhookUrl: undefined,
      notifyOnSuccess: true,
    });
  });

  it("accepts an explicit Pi model", () => {
    expect(loadConfig({ PI_PROVIDER: "openai", PI_MODEL: "gpt-5-mini" })).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      apiBaseUrl: undefined,
      timezone: "Asia/Shanghai",
      tavilyMcpEnabled: true,
      tavilyMcpUrl: "https://mcp.tavily.com/mcp/",
      tavilyApiKey: undefined,
      iwencaiBaseUrl: "https://openapi.iwencai.com",
      iwencaiApiKey: undefined,
      futuPythonExecutable: "/usr/bin/python3",
      futuOpenDHost: "127.0.0.1",
      futuOpenDPort: 11111,
      searchMaxResults: 5,
      tracingEnabled: true,
      traceContentEnabled: true,
      modelCostInputPerMillion: undefined,
      modelCostOutputPerMillion: undefined,
      modelCostCurrency: "USD",
      otlpTraceEndpoint: "http://localhost:6006/v1/traces",
      phoenixUiUrl: "http://localhost:6006",
      webPort: 4310,
      webUiUrl: "http://127.0.0.1:4310",
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuWebhookUrl: undefined,
      wechatWebhookUrl: undefined,
      notifyOnSuccess: true,
    });
  });

  it("accepts an OpenAI-compatible custom base URL", () => {
    expect(loadConfig({
      PI_PROVIDER: "qwen",
      PI_MODEL: "qwen3.7-flash",
      PI_BASE_URL: "https://example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    })).toMatchObject({
      provider: "qwen",
      model: "qwen3.7-flash",
      apiBaseUrl: "https://example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
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

  it("accepts a dedicated Futu Python and validates the OpenD port", () => {
    expect(loadConfig({
      FUTU_PYTHON: "/opt/futu/bin/python",
      FUTU_OPEND_HOST: "localhost",
      FUTU_OPEND_PORT: "21111",
    })).toMatchObject({
      futuPythonExecutable: "/opt/futu/bin/python",
      futuOpenDHost: "localhost",
      futuOpenDPort: 21111,
    });
    expect(() => loadConfig({ FUTU_OPEND_PORT: "70000" })).toThrow("between 1 and 65535");
  });

  it("requires complete Feishu app credentials", () => {
    expect(loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
    })).toMatchObject({
      feishuAppId: "cli_test",
      feishuAppSecret: "secret",
    });
    expect(() => loadConfig({ FEISHU_APP_ID: "cli_test" })).toThrow("must be configured together");
  });

  it("allows Tavily MCP to be disabled for direct-source-only operation", () => {
    expect(loadConfig({ TAVILY_MCP_ENABLED: "false" }).tavilyMcpEnabled).toBe(false);
    expect(() => loadConfig({ TAVILY_MCP_ENABLED: "sometimes" })).toThrow("must be true or false");
  });

  it("allows local Trace content capture to be disabled", () => {
    expect(loadConfig({ TRACE_CONTENT_ENABLED: "false" }).traceContentEnabled).toBe(false);
    expect(() => loadConfig({ TRACE_CONTENT_ENABLED: "sometimes" })).toThrow("must be true or false");
  });

  it("accepts model pricing in a configured currency", () => {
    const config = loadConfig({
      MODEL_COST_INPUT_PER_MILLION: "0.025",
      MODEL_COST_OUTPUT_PER_MILLION: "3",
      MODEL_COST_CURRENCY: "cny",
    });
    expect(config).toMatchObject({
      modelCostInputPerMillion: 0.025,
      modelCostOutputPerMillion: 3,
      modelCostCurrency: "CNY",
    });
  });

  it("requires complete and valid model pricing", () => {
    expect(() => loadConfig({ MODEL_COST_INPUT_PER_MILLION: "1" })).toThrow("must be configured together");
    expect(() => loadConfig({
      MODEL_COST_INPUT_PER_MILLION: "-1",
      MODEL_COST_OUTPUT_PER_MILLION: "2",
    })).toThrow("non-negative");
    expect(() => loadConfig({ MODEL_COST_CURRENCY: "人民币" })).toThrow("three-letter");
  });
});
