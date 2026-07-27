import { loadEnvFile } from "node:process";
import { projectEnvPath } from "./project-paths.js";

export interface AppConfig {
  provider: string;
  model: string;
  timezone: string;
  tavilyMcpEnabled: boolean;
  tavilyMcpUrl: string;
  tavilyApiKey: string | undefined;
  iwencaiBaseUrl: string;
  iwencaiApiKey: string | undefined;
  searchMaxResults: number;
  tracingEnabled: boolean;
  traceContentEnabled: boolean;
  modelCostInputPerMillion: number | undefined;
  modelCostOutputPerMillion: number | undefined;
  modelCostCurrency: string;
  otlpTraceEndpoint: string;
  phoenixUiUrl: string;
  webPort: number;
  webUiUrl: string;
  feishuWebhookUrl: string | undefined;
  wechatWebhookUrl: string | undefined;
  notifyOnSuccess: boolean;
}

export function loadConfig(env?: NodeJS.ProcessEnv): AppConfig {
  if (!env) loadLocalEnv();
  const source = env ?? process.env;
  const searchMaxResults = Number.parseInt(source.SEARCH_MAX_RESULTS?.trim() || "5", 10);
  if (!Number.isInteger(searchMaxResults) || searchMaxResults < 5 || searchMaxResults > 20) {
    throw new Error("SEARCH_MAX_RESULTS must be an integer between 5 and 20 for Tavily MCP.");
  }
  const tavilyMcpEnabled = booleanValue(source.TAVILY_MCP_ENABLED, true, "TAVILY_MCP_ENABLED");
  const webPort = Number.parseInt(source.LIVERMORE_WEB_PORT?.trim() || "4310", 10);
  if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
    throw new Error("LIVERMORE_WEB_PORT must be an integer between 1024 and 65535.");
  }
  const modelCostInputPerMillion = optionalNonNegativeNumber(
    source.MODEL_COST_INPUT_PER_MILLION,
    "MODEL_COST_INPUT_PER_MILLION",
  );
  const modelCostOutputPerMillion = optionalNonNegativeNumber(
    source.MODEL_COST_OUTPUT_PER_MILLION,
    "MODEL_COST_OUTPUT_PER_MILLION",
  );
  if ((modelCostInputPerMillion === undefined) !== (modelCostOutputPerMillion === undefined)) {
    throw new Error("MODEL_COST_INPUT_PER_MILLION and MODEL_COST_OUTPUT_PER_MILLION must be configured together.");
  }
  const modelCostCurrency = (source.MODEL_COST_CURRENCY?.trim() || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(modelCostCurrency)) {
    throw new Error("MODEL_COST_CURRENCY must be a three-letter currency code such as CNY or USD.");
  }

  return {
    provider: source.PI_PROVIDER?.trim() || "deepseek",
    model: source.PI_MODEL?.trim() || "deepseek-v4-flash",
    timezone: source.APP_TIMEZONE?.trim() || "Asia/Shanghai",
    tavilyMcpEnabled,
    tavilyMcpUrl: source.TAVILY_MCP_URL?.trim() || "https://mcp.tavily.com/mcp/",
    tavilyApiKey: optional(source.TAVILY_API_KEY),
    iwencaiBaseUrl: source.IWENCAI_BASE_URL?.trim() || "https://openapi.iwencai.com",
    iwencaiApiKey: optional(source.IWENCAI_API_KEY),
    searchMaxResults,
    tracingEnabled: booleanValue(source.TRACING_ENABLED, true, "TRACING_ENABLED"),
    traceContentEnabled: booleanValue(source.TRACE_CONTENT_ENABLED, true, "TRACE_CONTENT_ENABLED"),
    modelCostInputPerMillion,
    modelCostOutputPerMillion,
    modelCostCurrency,
    otlpTraceEndpoint: source.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || "http://localhost:6006/v1/traces",
    phoenixUiUrl: source.PHOENIX_UI_URL?.trim() || "http://localhost:6006",
    webPort,
    webUiUrl: source.LIVERMORE_WEB_UI_URL?.trim() || `http://127.0.0.1:${webPort}`,
    feishuWebhookUrl: optional(source.FEISHU_WEBHOOK_URL),
    wechatWebhookUrl: optional(source.WECHAT_WEBHOOK_URL),
    notifyOnSuccess: booleanValue(source.NOTIFY_ON_SUCCESS, true, "NOTIFY_ON_SUCCESS"),
  };
}

export function loadLocalEnv(): void {
  try {
    loadEnvFile(projectEnvPath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function optionalNonNegativeNumber(value: string | undefined, name: string): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return parsed;
}
