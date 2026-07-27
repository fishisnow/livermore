import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../config.js";
import {
  futuKlineScriptPath,
  futuIndicatorScriptPath,
  futuNewsScriptPath,
  futuSnapshotScriptPath,
  queryFutuMarket,
  queryFutuNews,
} from "../market/futu-client.js";
import {
  isIwencaiQuotaExceeded,
  iwencaiQuotaExceededResult,
  queryIwencai,
  iwencaiScriptPath,
} from "../market/iwencai-client.js";
import { isMainlandSecurity, normalizeSecurityCode } from "../market/normalized-market.js";
import { projectRoot, projectSkillsDirectory, reportsDirectory } from "../project-paths.js";
import type { InvestmentDatabase } from "../storage/database.js";
import { collectLiveSources } from "../briefings/source-provider.js";
import type { BriefingTaskDefinition } from "../briefings/types.js";

export interface SkillDescriptor {
  name: string;
  description: string;
  path: string;
  location: string;
}

export interface RuntimeToolHooks {
  onSkillRead?: (name: string, content: string) => void;
  onIwencaiResult?: (query: string, result: unknown) => void;
  onFutuResult?: (symbols: string[], result: unknown) => void;
  onFutuNewsResult?: (keywords: string[], result: unknown) => void;
}

let skillCache: { expiresAt: number; value: SkillDescriptor[] } | undefined;

const listRunsParameters = Type.Object({
  task: Type.Optional(Type.Union([
    Type.Literal("market-briefing"),
    Type.Literal("ai-industry-chain"),
    Type.Literal("portfolio-risk-check"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const getRunParameters = Type.Object({
  runId: Type.String({ minLength: 4, description: "Full run ID or a unique leading prefix." }),
  includeReport: Type.Optional(Type.Boolean()),
});

const searchParameters = Type.Object({
  query: Type.String({ minLength: 2, maxLength: 300 }),
});

const skillParameters = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
});

const securityListParameters = Type.Object({
  symbols: Type.Array(Type.String({ minLength: 2, maxLength: 30 }), {
    minItems: 1,
    maxItems: 50,
  }),
});

const futuNewsParameters = Type.Object({
  keywords: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
    minItems: 1,
    maxItems: 10,
  }),
  maxCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
});

export function createRuntimeTools(
  config: AppConfig,
  database: InvestmentDatabase,
  hooks: RuntimeToolHooks = {},
): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    {
      name: "list_task_runs",
      label: "List task runs",
      description: "List recent local market briefing, AI industry chain, and portfolio risk-check runs, including status, timing, item count, warnings, token usage, cost, and trace ID.",
      parameters: listRunsParameters,
      async execute(_id, rawParams) {
        const params = rawParams as { task?: "market-briefing" | "ai-industry-chain" | "portfolio-risk-check"; limit?: number };
        const runs = database.listRuns(params.limit ?? 10, params.task);
        return textResult(JSON.stringify(runs, null, 2));
      },
    },
    {
      name: "list_portfolio_positions",
      label: "List portfolio positions",
      description: "List the user's locally maintained portfolio positions and their latest saved risk-check snapshot. This is read-only.",
      parameters: Type.Object({}),
      async execute() {
        return textResult(JSON.stringify(database.listPositions(), null, 2));
      },
    },
    {
      name: "get_task_run",
      label: "Get task run",
      description: "Inspect one local task run and optionally read its generated Markdown report.",
      parameters: getRunParameters,
      async execute(_id, rawParams) {
        const params = rawParams as { runId: string; includeReport?: boolean };
        const matches = database.listRuns(200).filter((run) => run.id.startsWith(params.runId));
        if (matches.length === 0) return textResult(`No task run matches ${params.runId}.`, true);
        if (matches.length > 1) return textResult(`Run prefix is ambiguous: ${matches.map((run) => run.id).join(", ")}`, true);
        const run = matches[0]!;
        let report: string | undefined;
        if (params.includeReport && run.reportPath) report = await readLocalReport(run.reportPath);
        return textResult(JSON.stringify({ ...run, ...(report ? { report } : {}) }, null, 2));
      },
    },
    {
      name: "search_investment_web",
      label: "Search investment web",
      description: "Search current investment, market, company, policy, or AI industry information through the configured Tavily MCP. Use only when current external evidence is required.",
      parameters: searchParameters,
      async execute(_id, rawParams) {
        const params = rawParams as { query: string };
        if (!config.tavilyMcpEnabled || !config.tavilyApiKey) {
          return textResult("Tavily MCP is not configured. Use local task runs and reports, or explain that current web evidence is unavailable.", true);
        }
        const definition: BriefingTaskDefinition = {
          task: "market-briefing",
          title: "Interactive research search",
          queries: [{ category: "交互研究", query: params.query, topic: "general" }],
          resolveMode: () => "intraday",
          buildPrompt: () => "",
        };
        const sources = await collectLiveSources(
          definition,
          config.tavilyMcpUrl,
          config.tavilyApiKey,
          config.searchMaxResults,
          new Date(),
        );
        return textResult(JSON.stringify(sources.map((source) => ({
          title: source.title,
          url: source.url,
          summary: source.summary.slice(0, 2_000),
          publishedAt: source.publishedAt,
          retrievedAt: source.retrievedAt,
        })), null, 2));
      },
    },
    ...(existsSync(iwencaiScriptPath) ? [{
      name: "query_iwencai_market",
      label: "Query Iwencai market data",
      description: "Query current stock, ETF, index, price, turnover, fund-flow, or technical-indicator data through the installed hithink-market-query skill. Use this instead of web search for structured market quotes.",
      parameters: Type.Object({
        query: Type.String({ minLength: 2, maxLength: 300 }),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        retry: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, rawParams) {
        const params = rawParams as { query: string; page?: number; limit?: number; retry?: boolean };
        if (!config.iwencaiApiKey) {
          return textResult("IWENCAI_API_KEY is not configured in Livermore's local .env.", true);
        }
        try {
          const result = await queryIwencai(config, params);
          hooks.onIwencaiResult?.(params.query, result);
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          if (isIwencaiQuotaExceeded(error)) {
            const result = iwencaiQuotaExceededResult(params.query, error);
            hooks.onIwencaiResult?.(params.query, result);
            return textResult(JSON.stringify(result, null, 2));
          }
          return textResult(errorMessage(error), true);
        }
      },
    } satisfies AgentTool<any>] : []),
    ...(existsSync(iwencaiScriptPath) ? [{
      name: "query_a_share_main_fund_flow",
      label: "Query A-share main fund flow",
      description: "Query only the main net capital inflow of mainland A-share/ETF symbols through the installed hithink-market-query skill. Do not use this tool for latest price, daily change, RSI, MACD, Hong Kong securities, or other market fields.",
      parameters: securityListParameters,
      async execute(_id, rawParams) {
        const params = rawParams as { symbols: string[] };
        const symbols = [...new Set(params.symbols.map((symbol) => normalizeSecurityCode(symbol) ?? symbol))];
        const invalid = symbols.filter((symbol) => !isMainlandSecurity(symbol));
        if (invalid.length > 0) {
          return textResult(`Only mainland SH/SZ/BJ symbols are allowed: ${invalid.join(", ")}`, true);
        }
        if (!config.iwencaiApiKey) {
          return textResult("IWENCAI_API_KEY is not configured in Livermore's local .env.", true);
        }
        const iwencaiCodes = symbols.map((symbol) => symbol.split(".")[0]!);
        const query = `${iwencaiCodes.join("、")} 今日主力资金净流入，只返回证券代码、证券简称、主力净流入`;
        try {
          const result = await queryIwencai(config, {
            query,
            limit: Math.min(50, Math.max(10, symbols.length)),
          });
          hooks.onIwencaiResult?.(query, result);
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          if (isIwencaiQuotaExceeded(error)) {
            const result = iwencaiQuotaExceededResult(query, error);
            hooks.onIwencaiResult?.(query, result);
            return textResult(JSON.stringify(result, null, 2));
          }
          return textResult(errorMessage(error), true);
        }
      },
    } satisfies AgentTool<any>] : []),
    ...(existsSync(futuSnapshotScriptPath)
      && existsSync(futuKlineScriptPath)
      && existsSync(futuIndicatorScriptPath) ? [{
      name: "query_futu_market",
      label: "Query Futu market data",
      description: "Query latest price, daily change, and daily-K-line RSI/MACD for A-share and Hong Kong holdings through the installed read-only futuapi skill. Requires a running Futu OpenD and a FUTU_PYTHON environment with futu-api installed.",
      parameters: securityListParameters,
      async execute(_id, rawParams) {
        const params = rawParams as { symbols: string[] };
        try {
          const result = await queryFutuMarket(config, params.symbols);
          hooks.onFutuResult?.(params.symbols, result);
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return textResult(errorMessage(error), true);
        }
      },
    } satisfies AgentTool<any>] : []),
    ...(existsSync(futuNewsScriptPath) ? [{
      name: "query_futu_news",
      label: "Query Futu holding news",
      description: "Search the latest news, announcements, and ratings related to portfolio holdings through the installed read-only futuapi skill. Use security names returned by query_futu_market as keywords. Query at most 10 holdings per call.",
      parameters: futuNewsParameters,
      async execute(_id, rawParams) {
        const params = rawParams as { keywords: string[]; maxCount?: number };
        try {
          const result = await queryFutuNews(config, params.keywords, params.maxCount ?? 3);
          hooks.onFutuNewsResult?.(params.keywords, result);
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return textResult(errorMessage(error), true);
        }
      },
    } satisfies AgentTool<any>] : []),
    {
      name: "list_available_skills",
      label: "List Livermore skills",
      description: "List only the skills installed for this Livermore project. These skills are read on demand; global Codex skills are intentionally excluded.",
      parameters: Type.Object({}),
      async execute() {
        const skills = await listSkillDescriptors();
        return textResult(JSON.stringify(skills.map(({ name, description, location }) => ({
          name,
          description,
          location,
          loading: "on-demand",
        })), null, 2));
      },
    },
    {
      name: "read_skill",
      label: "Read installed skill",
      description: "Read one installed SKILL.md by its exact name. Use list_available_skills first and apply only skills relevant to the user's request.",
      parameters: skillParameters,
      async execute(_id, rawParams) {
        const params = rawParams as { name: string };
        const skills = await listSkillDescriptors();
        const matches = skills.filter((skill) => skill.name === params.name);
        if (matches.length === 0) return textResult(`Skill not found: ${params.name}`, true);
        const content = await readFile(matches[0]!.path, "utf8");
        hooks.onSkillRead?.(params.name, content);
        return textResult(content.slice(0, 30_000));
      },
    },
  ];
  return tools;
}

export async function listSkillDescriptors(
  refresh = false,
  root = projectSkillsDirectory,
): Promise<SkillDescriptor[]> {
  const projectScope = root === projectSkillsDirectory;
  if (projectScope && !refresh && skillCache && skillCache.expiresAt > Date.now()) return skillCache.value;
  const files = await findSkillFiles(root);
  const descriptors = await Promise.all(files.map(async (file) => {
    const content = await readFile(file, "utf8");
    const name = frontmatter(content, "name") || path.basename(path.dirname(file));
    const description = frontmatter(content, "description") || firstParagraph(content);
    return {
      name,
      description: description.slice(0, 500),
      path: file,
      location: path.relative(projectRoot, path.dirname(file)),
    };
  }));
  const value = [...new Map(descriptors.map((skill) => [skill.name, skill])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  if (projectScope) skillCache = { expiresAt: Date.now() + 5_000, value };
  return value;
}

async function findSkillFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 7) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") files.push(target);
      else if (entry.isDirectory() && (!entry.name.startsWith(".") || entry.name === ".system")) await walk(target, depth + 1);
    }
  }
  await walk(root, 0);
  return files;
}

async function readLocalReport(filename: string): Promise<string> {
  const resolvedReports = await realpath(reportsDirectory);
  const resolvedFile = await realpath(filename);
  const relative = path.relative(resolvedReports, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Report path is outside data/reports.");
  return (await readFile(resolvedFile, "utf8")).slice(0, 50_000);
}

function frontmatter(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
}

function firstParagraph(content: string): string {
  return content.replace(/^---[\s\S]*?---/, "").split(/\n\s*\n/).find((part) => part.trim())?.trim() ?? "";
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    ...(isError ? { isError: true } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
