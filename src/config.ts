import { loadEnvFile } from "node:process";
import { projectEnvPath } from "./project-paths.js";

export interface AppConfig {
  provider: string;
  model: string;
  timezone: string;
  tavilyApiKey: string | undefined;
  searchMaxResults: number;
  briefingReportApiUrl: string | undefined;
  briefingReportApiKey: string | undefined;
  briefingPublisher: string;
}

export function loadConfig(env?: NodeJS.ProcessEnv): AppConfig {
  if (!env) loadLocalEnv();
  const source = env ?? process.env;
  const searchMaxResults = Number.parseInt(source.SEARCH_MAX_RESULTS?.trim() || "5", 10);
  if (!Number.isInteger(searchMaxResults) || searchMaxResults < 1 || searchMaxResults > 20) {
    throw new Error("SEARCH_MAX_RESULTS must be an integer between 1 and 20.");
  }

  return {
    provider: source.PI_PROVIDER?.trim() || "anthropic",
    model: source.PI_MODEL?.trim() || "claude-sonnet-4-5",
    timezone: source.APP_TIMEZONE?.trim() || "Asia/Shanghai",
    tavilyApiKey: optional(source.TAVILY_API_KEY),
    searchMaxResults,
    briefingReportApiUrl: optional(source.BRIEFING_REPORT_API_URL),
    briefingReportApiKey: optional(source.BRIEFING_REPORT_API_KEY),
    briefingPublisher: source.BRIEFING_PUBLISHER?.trim() || "玄弈",
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
