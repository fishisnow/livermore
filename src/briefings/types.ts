export type BriefingTask = "market-briefing" | "ai-industry-chain";
export type MarketMode = "pre-market" | "intraday" | "close";
export type AiMode = "pre-market" | "close";
export type BriefingMode = MarketMode | AiMode;

export interface SearchQuery {
  category: string;
  query: string;
  topic?: "general" | "news" | "finance";
}

export interface SourceItem {
  id: string;
  category: string;
  title: string;
  url: string;
  summary: string;
  publishedAt?: string;
  retrievedAt: string;
  score?: number;
}

export interface ReplayFile {
  task: BriefingTask;
  retrievedAt: string;
  items: Array<Omit<SourceItem, "id" | "retrievedAt"> & { id?: string; retrievedAt?: string }>;
}

export interface BriefingTaskDefinition {
  task: BriefingTask;
  title: string;
  queries: SearchQuery[];
  resolveMode(date: Date, timezone: string): BriefingMode;
  buildPrompt(input: BriefingPromptInput): string;
}

export interface BriefingPromptInput {
  mode: BriefingMode;
  nowIso: string;
  localNow: string;
  timezone: string;
  sources: SourceItem[];
}
