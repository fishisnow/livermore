import type { InvestmentDatabase, McpServerRecord } from "../storage/database.js";

export class McpConfigError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export const SYSTEM_TAVILY_ID = "tavily";

export interface McpEditableConfig {
  name: string;
  url: string;
  description: string;
  authQueryParam: string | null;
  apiKey: string;
}

export interface PublicMcpServer {
  id: string;
  name: string;
  label: string;
  endpoint: string;
  enabled: boolean;
  description: string;
  system: boolean;
  briefingSearch: boolean;
  authQueryParam: string | null;
  hasApiKey: boolean;
  status: "disabled" | "needs-configuration" | "configured";
  lastError: string | null;
  transport: "HTTP MCP";
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  config: McpEditableConfig;
}

export type BriefingMcpResolution =
  | { state: "ready"; endpoint: string; apiKey: string }
  | { state: "disabled"; name: string }
  | { state: "missing-key"; name: string }
  | { state: "absent" };

const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;
const ENDPOINT_LIMIT = 500;
const KEY_LIMIT = 500;

export function isSystemMcp(id: string): boolean {
  return id === SYSTEM_TAVILY_ID;
}

export function toPublicMcp(server: McpServerRecord): PublicMcpServer {
  return {
    id: server.id,
    name: server.name,
    label: server.name,
    endpoint: server.endpoint,
    enabled: server.enabled,
    description: server.description,
    system: isSystemMcp(server.id),
    briefingSearch: server.briefingSearch,
    authQueryParam: server.authQueryParam,
    hasApiKey: Boolean(server.apiKey),
    status: mcpStatus(server),
    lastError: server.lastError,
    transport: "HTTP MCP",
    toolCount: server.tools.length,
    tools: server.tools.map(({ name, description }) => ({ name, description })),
    config: editableConfig(server),
  };
}

export function editableConfig(server: McpServerRecord): McpEditableConfig {
  return {
    name: server.name,
    url: server.endpoint,
    description: server.description,
    authQueryParam: server.authQueryParam,
    apiKey: "",
  };
}

export function mcpStatus(server: Pick<McpServerRecord, "enabled" | "briefingSearch" | "apiKey">): PublicMcpServer["status"] {
  if (!server.enabled) return "disabled";
  if (server.briefingSearch && !server.apiKey) return "needs-configuration";
  return "configured";
}

export function resolveBriefingMcp(servers: readonly McpServerRecord[]): BriefingMcpResolution {
  const selected = servers.find((server) => server.id === SYSTEM_TAVILY_ID) ?? servers.find((server) => server.briefingSearch);
  if (!selected) return { state: "absent" };
  if (!selected.enabled) return { state: "disabled", name: selected.name };
  if (!selected.apiKey) return { state: "missing-key", name: selected.name };
  return { state: "ready", endpoint: selected.endpoint, apiKey: selected.apiKey };
}

export function mcpEndpoint(server: Pick<McpServerRecord, "endpoint" | "apiKey" | "authQueryParam">): URL {
  const endpoint = new URL(server.endpoint);
  if (server.apiKey && server.authQueryParam && !endpoint.searchParams.has(server.authQueryParam)) {
    endpoint.searchParams.set(server.authQueryParam, server.apiKey);
  }
  return endpoint;
}

export function createMcpServer(database: InvestmentDatabase, input: unknown): McpServerRecord {
  const config = parseEditableConfig(input, false);
  if (!config.name || !config.url) throw new McpConfigError("JSON 需要 name 和 url。");
  return database.insertMcpServer({
    name: config.name,
    endpoint: config.url,
    enabled: true,
    apiKey: config.apiKey || null,
    authQueryParam: config.authQueryParam ?? null,
    description: config.description ?? "",
    briefingSearch: false,
  });
}

export function updateMcpServer(database: InvestmentDatabase, id: string, input: unknown): McpServerRecord {
  const current = requireServer(database, id);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpConfigError("MCP 配置必须是 JSON 对象。");
  const body = input as Record<string, unknown>;

  if (isSystemMcp(id)) {
    const patch: { enabled?: boolean; apiKey?: string | null } = {};
    if ("enabled" in body) patch.enabled = requiredBoolean(body.enabled, "enabled");
    if ("apiKey" in body) patch.apiKey = optionalSecret(body.apiKey);
    if (Object.keys(patch).length === 0) throw new McpConfigError("Tavily Search 只需设置 API Key 或开关。");
    const updated = database.updateMcpServer(id, patch);
    if (!updated) throw new McpConfigError("MCP 不存在。", 404);
    return updated;
  }

  if (Object.keys(body).length === 1 && "enabled" in body) {
    const updated = database.updateMcpServer(id, { enabled: requiredBoolean(body.enabled, "enabled") });
    if (!updated) throw new McpConfigError("MCP 不存在。", 404);
    return updated;
  }

  const config = parseEditableConfig(body, true);
  const updated = database.updateMcpServer(id, {
    name: config.name ?? current.name,
    endpoint: config.url ?? current.endpoint,
    description: config.description ?? current.description,
    authQueryParam: config.authQueryParam === undefined ? current.authQueryParam : config.authQueryParam,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    briefingSearch: false,
  });
  if (!updated) throw new McpConfigError("MCP 不存在。", 404);
  return updated;
}

export function deleteMcpServer(database: InvestmentDatabase, id: string): void {
  if (isSystemMcp(id)) throw new McpConfigError("Tavily Search 是系统默认 MCP，不能删除。");
  if (!database.deleteMcpServer(id)) throw new McpConfigError("MCP 不存在。", 404);
}

function requireServer(database: InvestmentDatabase, id: string): McpServerRecord {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new McpConfigError("MCP 不存在。", 404);
  const server = database.getMcpServer(id);
  if (!server) throw new McpConfigError("MCP 不存在。", 404);
  return server;
}

function parseEditableConfig(input: unknown, partial: boolean): {
  name?: string;
  url?: string;
  description?: string;
  authQueryParam?: string | null;
  apiKey?: string | null;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpConfigError("MCP 配置必须是 JSON 对象。");
  const body = input as Record<string, unknown>;
  const source = body.config && typeof body.config === "object" && !Array.isArray(body.config)
    ? body.config as Record<string, unknown>
    : body;
  const parsed: {
    name?: string;
    url?: string;
    description?: string;
    authQueryParam?: string | null;
    apiKey?: string | null;
  } = {};
  if (!partial || "name" in source) parsed.name = requiredText(source.name, "name", NAME_LIMIT);
  if (!partial || "url" in source || "endpoint" in source) {
    parsed.url = parseEndpoint(source.url ?? source.endpoint);
  }
  if ("description" in source) parsed.description = optionalText(source.description, DESCRIPTION_LIMIT);
  else if (!partial) parsed.description = "";
  if ("authQueryParam" in source) parsed.authQueryParam = optionalQueryParam(source.authQueryParam);
  else if (!partial) parsed.authQueryParam = null;
  if ("apiKey" in source) parsed.apiKey = optionalSecret(source.apiKey);
  return parsed;
}

function parseEndpoint(value: unknown): string {
  const text = requiredText(value, "url", ENDPOINT_LIMIT);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new McpConfigError("url 必须是 http 或 https 地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new McpConfigError("url 必须是 http 或 https 地址。");
  if (url.username || url.password) throw new McpConfigError("请把 API Key 写在 apiKey 字段，不要写进 url。");
  return url.toString();
}

function requiredText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string") throw new McpConfigError(`${label} 必须是文本。`);
  const text = value.trim();
  if (!text || text.length > limit) throw new McpConfigError(`${label} 需要 1–${limit} 个字符。`);
  return text;
}

function optionalText(value: unknown, limit: number): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new McpConfigError("description 必须是文本。");
  const text = value.trim();
  if (text.length > limit) throw new McpConfigError(`description 不能超过 ${limit} 个字符。`);
  return text;
}

function optionalSecret(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new McpConfigError("apiKey 必须是文本。");
  const text = value.trim();
  if (text.length > KEY_LIMIT) throw new McpConfigError(`apiKey 不能超过 ${KEY_LIMIT} 个字符。`);
  return text;
}

function optionalQueryParam(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(value.trim())) {
    throw new McpConfigError("authQueryParam 只能包含字母、数字、下划线和连字符。");
  }
  return value.trim();
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new McpConfigError(`${label} 必须是布尔值。`);
  return value;
}
