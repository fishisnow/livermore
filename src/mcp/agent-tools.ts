import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { InvestmentDatabase, McpServerRecord, McpToolRecord } from "../storage/database.js";
import { withHttpMcp, type HttpMcpSession } from "./http-mcp.js";
import { mcpEndpoint, McpConfigError } from "./registry.js";

const RESERVED_TOOL_NAMES = new Set([
  "list_task_runs",
  "list_portfolio_positions",
  "get_task_run",
  "query_a_share_main_fund_flow",
  "query_futu_market",
  "query_futu_news",
  "list_available_skills",
  "read_skill",
  "save_research_report",
]);

export function createMcpAgentTools(servers: readonly McpServerRecord[]): AgentTool<any>[] {
  const used = new Set<string>(RESERVED_TOOL_NAMES);
  const tools: AgentTool<any>[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    for (const tool of server.tools) {
      const name = uniqueToolName(server, tool.name, used);
      tools.push({
        name,
        label: tool.name,
        description: `${server.name}: ${tool.description || tool.name}`,
        parameters: objectSchema(tool.inputSchema),
        async execute(_id, params) {
          try {
            const text = await withHttpMcp(mcpEndpoint(server), async (session) => {
              const result = await session.callTool(tool.name, params && typeof params === "object" ? params as Record<string, unknown> : {});
              if (result.isError) throw new Error(textContent(result.content) || `${tool.name} failed`);
              return textContent(result.content).slice(0, 20_000);
            });
            return { content: [{ type: "text" as const, text }], details: {} };
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
              details: {},
              isError: true,
            };
          }
        },
      });
    }
  }
  return tools;
}

export async function refreshMcpServerTools(
  database: InvestmentDatabase,
  id: string,
  open?: (endpoint: URL) => HttpMcpSession,
): Promise<McpServerRecord> {
  const server = database.getMcpServer(id);
  if (!server) throw new McpConfigError("MCP 不存在。", 404);
  if (server.briefingSearch && !server.apiKey) {
    database.updateMcpServer(id, { lastError: "填写 API Key 后再检测工具。" });
    throw new McpConfigError("填写 API Key 后再检测工具。", 400);
  }
  try {
    const discovered = await withHttpMcp(
      mcpEndpoint(server),
      (session) => session.listToolDescriptors(),
      ...(open ? [open] as const : []),
    );
    const tools = discovered.slice(0, 50).map((tool) => normalizeDiscoveredTool(tool));
    const lastError = discovered.length > 50 ? "只登记了前 50 个工具。" : null;
    const updated = database.updateMcpServer(id, { tools, lastError });
    if (!updated) throw new McpConfigError("MCP 不存在。", 404);
    return updated;
  } catch (error) {
    if (error instanceof McpConfigError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    database.updateMcpServer(id, { lastError: message });
    throw new McpConfigError(message, 502);
  }
}

function normalizeDiscoveredTool(tool: { name: string; description: string; inputSchema: Record<string, unknown> }): McpToolRecord {
  return {
    name: tool.name.slice(0, 120),
    description: tool.description.slice(0, 500),
    inputSchema: objectSchema(tool.inputSchema),
    enabled: true,
  };
}

function objectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === "object" || schema.properties) return schema;
  return { type: "object", properties: {} };
}

function uniqueToolName(server: McpServerRecord, toolName: string, used: Set<string>): string {
  const base = sanitizeToolName(toolName);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const prefix = sanitizeToolName(server.name).slice(0, 24) || "mcp";
  let candidate = `${prefix}_${base}`.slice(0, 80);
  let suffix = 2;
  while (used.has(candidate)) candidate = `${prefix}_${base}_${suffix++}`.slice(0, 80);
  used.add(candidate);
  return candidate;
}

function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+/, "").slice(0, 80);
  return /^[A-Za-z]/.test(sanitized) ? sanitized : `mcp_${sanitized || "tool"}`;
}

function textContent(content: unknown[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(
      item && typeof item === "object" && "type" in item && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string",
    ))
    .map((item) => item.text)
    .join("\n");
}
