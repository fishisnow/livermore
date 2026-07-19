import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BriefingTaskDefinition, ReplayFile, SourceItem } from "./types.js";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

export interface McpSearchClient {
  connect(): Promise<void>;
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
  close(): Promise<void>;
}

type McpClientFactory = (endpoint: URL) => McpSearchClient;

export async function collectLiveSources(
  definition: BriefingTaskDefinition,
  mcpUrl: string,
  apiKey: string,
  maxResults: number,
  now: Date,
  createClient: McpClientFactory = createTavilyMcpClient,
): Promise<SourceItem[]> {
  const endpoint = new URL(mcpUrl);
  if (!endpoint.searchParams.has("tavilyApiKey")) endpoint.searchParams.set("tavilyApiKey", apiKey);
  const client = createClient(endpoint);
  const collected: SourceItem[] = [];
  try {
    await client.connect();
    const tools = await client.listTools();
    const searchTool = ["tavily_search", "tavily-search"].find((name) => tools.includes(name));
    if (!searchTool) throw new Error("Tavily MCP server does not expose a search tool.");

    for (const query of definition.queries) {
      const response = await client.callTool(searchTool, {
        query: query.query,
        // Tavily Remote MCP currently exposes topic as Literal["general"].
        // Domain intent remains encoded in the query and local category.
        topic: "general",
        time_range: "day",
        search_depth: "advanced",
        max_results: maxResults,
        include_raw_content: false,
      });
      if (response.isError) {
        throw new Error(`Tavily MCP search failed for "${query.query}": ${textContent(response.content)}`);
      }
      for (const result of parseTavilyToolResult(response.content)) {
        if (!result.url || !result.title || !result.content) continue;
        collected.push(normalizeSource({
          category: query.category,
          title: result.title,
          url: result.url,
          summary: result.content,
          retrievedAt: now.toISOString(),
          ...(result.published_date ? { publishedAt: result.published_date } : {}),
          ...(result.score === undefined ? {} : { score: result.score }),
        }));
      }
    }
  } finally {
    await client.close();
  }
  return uniqueById(collected);
}

export function parseTavilyToolResult(content: unknown[]): TavilyResult[] {
  const text = textContent(content).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as TavilyResponse | TavilyResult[] | Record<string, unknown>;
    if (!Array.isArray(parsed) && "error" in parsed) {
      const nested = parsed.detail && typeof parsed.detail === "object" && "error" in parsed.detail
        ? parsed.detail.error
        : undefined;
      const message = typeof nested === "string" ? nested : String(parsed.error);
      const status = typeof parsed.status === "number" ? ` (status ${parsed.status})` : "";
      throw new Error(`Tavily MCP search error${status}: ${message}`);
    }
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.results) ? parsed.results as TavilyResult[] : [];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Tavily MCP search error")) throw error;
    const matches = [...text.matchAll(/(?:^|\n)Title:\s*(.*?)\nURL:\s*(https?:\/\/\S+)\nContent:\s*([\s\S]*?)(?=\nTitle:|\nImages:|$)/g)];
    return matches.map((match) => ({
      title: match[1]!.trim(),
      url: match[2]!.trim(),
      content: match[3]!.trim(),
    }));
  }
}

function createTavilyMcpClient(endpoint: URL): McpSearchClient {
  const client = new Client({ name: "xuanyi-investment-agent", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(endpoint);
  return {
    connect: () => client.connect(transport as never),
    async listTools() {
      return (await client.listTools()).tools.map((tool) => tool.name);
    },
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

export async function loadReplaySources(path: string, expectedTask: string): Promise<SourceItem[]> {
  const payload = JSON.parse(await readFile(path, "utf8")) as ReplayFile;
  if (payload.task !== expectedTask) {
    throw new Error(`Replay task mismatch: expected ${expectedTask}, received ${payload.task}.`);
  }
  if (!Array.isArray(payload.items) || !payload.retrievedAt) {
    throw new Error("Replay file must contain retrievedAt and an items array.");
  }
  return uniqueById(payload.items.map((item) => normalizeSource({
    ...item,
    retrievedAt: item.retrievedAt ?? payload.retrievedAt,
  })));
}

export function normalizeSource(source: Omit<SourceItem, "id"> & { id?: string }): SourceItem {
  const url = source.url.trim();
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`Source URL must use HTTP(S): ${url}`);
  }
  return {
    ...source,
    id: source.id?.trim() || stableSourceId(url),
    title: source.title.trim(),
    url,
    summary: source.summary.trim(),
  };
}

export function stableSourceId(url: string): string {
  const normalized = new URL(url);
  normalized.hash = "";
  for (const key of [...normalized.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) normalized.searchParams.delete(key);
  }
  normalized.searchParams.sort();
  return createHash("sha256").update(normalized.toString()).digest("hex").slice(0, 24);
}

function uniqueById(items: SourceItem[]): SourceItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
