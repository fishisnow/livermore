import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppConfig } from "../config.js";
import { resolveBriefingMcp } from "../mcp/registry.js";
import { parseTavilyToolResult, stableSourceId } from "../briefings/source-provider.js";
import type { InvestmentDatabase } from "../storage/database.js";
import type { EvidenceItem, SearchOutcome, WatchRecord } from "./types.js";

interface SearchClient {
  connect(): Promise<void>;
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
  close(): Promise<void>;
}

export async function searchRecent(input: {
  mcpUrl: string;
  apiKey: string;
  queries: string[];
  maxResults: number;
  now: Date;
  createClient?: (endpoint: URL) => SearchClient;
}): Promise<EvidenceItem[]> {
  const endpoint = new URL(input.mcpUrl);
  if (!endpoint.searchParams.has("tavilyApiKey")) endpoint.searchParams.set("tavilyApiKey", input.apiKey);
  const client = (input.createClient ?? createClient)(endpoint);
  const collected: EvidenceItem[] = [];
  try {
    await client.connect();
    const tools = await client.listTools();
    const searchTool = ["tavily_search", "tavily-search"].find((name) => tools.includes(name));
    if (!searchTool) throw new Error("搜索服务没有提供检索工具。");
    for (const query of input.queries.slice(0, 3)) {
      const response = await client.callTool(searchTool, {
        query,
        topic: "general",
        time_range: "day",
        search_depth: "advanced",
        max_results: input.maxResults,
        include_raw_content: false,
      });
      if (response.isError) throw new Error(`检索失败：${textContent(response.content)}`);
      collected.push(...evidenceFromResults(parseTavilyToolResult(response.content)));
    }
  } finally {
    await client.close();
  }
  return dedupeEvidence(collected);
}

export function evidenceFromResults(results: Array<{ title?: string; url?: string; content?: string; published_date?: string }>): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const result of results) {
    const url = result.url?.trim() ?? "";
    const title = result.title?.trim() ?? "";
    const summary = result.content?.trim() ?? "";
    if (!title || !summary || (!url.startsWith("https://") && !url.startsWith("http://"))) continue;
    items.push({
      title,
      url,
      summary,
      publishedAt: result.published_date?.trim() || null,
      publisher: publisherOf(url),
    });
  }
  return dedupeEvidence(items);
}

export function createWatchSearch(config: AppConfig, database: InvestmentDatabase) {
  return async (watch: WatchRecord): Promise<SearchOutcome> => {
    const queries = watch.scope.queries.length > 0 ? watch.scope.queries : [watch.question];
    const resolution = resolveBriefingMcp(database.listMcpServers());
    if (resolution.state !== "ready") {
      return { ok: false, reason: "unavailable", message: unavailableSearchMessage(resolution.state), queries };
    }
    try {
      const items = await searchRecent({
        mcpUrl: resolution.endpoint,
        apiKey: resolution.apiKey,
        queries,
        maxResults: Math.min(config.searchMaxResults, 8),
        now: new Date(),
      });
      return { ok: true, items, queries };
    } catch (error) {
      return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error), queries };
    }
  };
}

export function unavailableSearchMessage(state: "disabled" | "missing-key" | "absent"): string {
  if (state === "disabled") return "Tavily Search 已保存密钥，但开关是关闭的。在研究能力里打开后，雷达才会用它检索。";
  if (state === "missing-key") return "Tavily Search 还没有 API Key，这次检查没有完成。";
  return "还没有可用的 Tavily Search 配置，这次检查没有完成。";
}

export function publisherOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "unknown"; }
}

export function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const unique: EvidenceItem[] = [];
  for (const item of items) {
    let id = item.url;
    try { id = stableSourceId(item.url); } catch { continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }
  return unique;
}

function createClient(endpoint: URL): SearchClient {
  const client = new Client({ name: "livermore-watch", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(endpoint);
  return {
    connect: () => client.connect(transport as never),
    async listTools() { return (await client.listTools()).tools.map((tool) => tool.name); },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      return { content, ...(result.isError === true ? { isError: true } : {}) };
    },
    close: () => client.close(),
  };
}

function textContent(content: unknown[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(
      item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string",
    ))
    .map((item) => item.text)
    .join("\n");
}
