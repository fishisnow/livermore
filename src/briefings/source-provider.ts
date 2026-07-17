import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

export async function collectLiveSources(
  definition: BriefingTaskDefinition,
  apiKey: string,
  maxResults: number,
  now: Date,
): Promise<SourceItem[]> {
  const collected: SourceItem[] = [];
  for (const query of definition.queries) {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: query.query,
        topic: query.topic ?? "news",
        time_range: "day",
        search_depth: "advanced",
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Tavily search failed for "${query.query}": HTTP ${response.status}`);
    }
    const payload = await response.json() as TavilyResponse;
    for (const result of payload.results ?? []) {
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
  return uniqueById(collected);
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
