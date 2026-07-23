import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../config.js";
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

let skillCache: { expiresAt: number; value: SkillDescriptor[] } | undefined;
const execFileAsync = promisify(execFile);
const iwencaiScript = path.join(projectSkillsDirectory, "hithink-market-query", "scripts", "cli.py");

const listRunsParameters = Type.Object({
  task: Type.Optional(Type.Union([
    Type.Literal("market-briefing"),
    Type.Literal("ai-industry-chain"),
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

export function createRuntimeTools(config: AppConfig, database: InvestmentDatabase): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    {
      name: "list_task_runs",
      label: "List task runs",
      description: "List recent local market briefing and AI industry chain task runs, including status, timing, source count, token usage, cost, and trace ID.",
      parameters: listRunsParameters,
      async execute(_id, rawParams) {
        const params = rawParams as { task?: "market-briefing" | "ai-industry-chain"; limit?: number };
        const runs = database.listRuns(params.limit ?? 10, params.task);
        return textResult(JSON.stringify(runs, null, 2));
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
    ...(existsSync(iwencaiScript) ? [{
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
          const { stdout } = await execFileAsync("/usr/bin/python3", [
            iwencaiScript,
            "--query", params.query,
            "--page", String(params.page ?? 1),
            "--limit", String(params.limit ?? 10),
            "--call-type", params.retry ? "retry" : "normal",
          ], {
            cwd: path.dirname(iwencaiScript),
            env: {
              ...process.env,
              IWENCAI_BASE_URL: config.iwencaiBaseUrl,
              IWENCAI_API_KEY: config.iwencaiApiKey,
            },
            timeout: 35_000,
            maxBuffer: 2 * 1024 * 1024,
          });
          return textResult(stdout.trim());
        } catch (error) {
          const detail = commandOutput(error);
          return textResult(detail || `Iwencai market query failed: ${errorMessage(error)}`, true);
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

function commandOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { stdout?: string | Buffer; stderr?: string | Buffer };
  return String(value.stdout || value.stderr || "").trim().slice(0, 50_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
