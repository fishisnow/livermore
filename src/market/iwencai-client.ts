import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import { projectSkillsDirectory } from "../project-paths.js";

const execFileAsync = promisify(execFile);
export const iwencaiScriptPath = path.join(
  projectSkillsDirectory,
  "hithink-market-query",
  "scripts",
  "cli.py",
);

export interface IwencaiQueryOptions {
  query: string;
  page?: number;
  limit?: number;
  retry?: boolean;
}

export interface IwencaiQueryResult {
  success?: boolean;
  query?: string;
  unavailable?: boolean;
  unavailable_reason?: "quota_exceeded";
  message?: string;
  code_count?: number;
  returned_count?: number;
  has_more?: boolean;
  trace_id?: string;
  datas?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export function isIwencaiQuotaExceeded(error: unknown): boolean {
  const message = errorMessage(error);
  return [
    /次数已用完/,
    /升级权益/,
    /额度.{0,12}(?:用完|不足|超出|达到|限制)/,
    /(?:usage|plan).{0,20}limit/i,
    /quota.{0,20}(?:exceed|limit|used)/i,
  ].some((pattern) => pattern.test(message));
}

export function iwencaiQuotaExceededResult(
  query: string,
  error: unknown,
): IwencaiQueryResult {
  return {
    success: false,
    query,
    unavailable: true,
    unavailable_reason: "quota_exceeded",
    message: errorMessage(error).slice(0, 2_000),
    datas: [],
  };
}

export async function queryIwencai(
  config: AppConfig,
  options: IwencaiQueryOptions,
): Promise<IwencaiQueryResult> {
  if (!config.iwencaiApiKey) throw new Error("IWENCAI_API_KEY is not configured in Livermore's local .env.");
  const query = options.query.trim();
  if (query.length < 2 || query.length > 300) throw new Error("Iwencai query must contain 2–300 characters.");
  const page = boundedInteger(options.page ?? 1, 1, 20, "page");
  const limit = boundedInteger(options.limit ?? 10, 1, 50, "limit");
  try {
    const { stdout } = await execFileAsync("/usr/bin/python3", [
      iwencaiScriptPath,
      "--query", query,
      "--page", String(page),
      "--limit", String(limit),
      "--call-type", options.retry ? "retry" : "normal",
    ], {
      cwd: path.dirname(iwencaiScriptPath),
      env: {
        ...process.env,
        IWENCAI_BASE_URL: config.iwencaiBaseUrl,
        IWENCAI_API_KEY: config.iwencaiApiKey,
      },
      timeout: 35_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(stdout) as IwencaiQueryResult;
  } catch (error) {
    const detail = commandOutput(error);
    throw new Error(detail || `Iwencai market query failed: ${errorMessage(error)}`);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function commandOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { stdout?: string | Buffer; stderr?: string | Buffer };
  return String(value.stdout || value.stderr || "").trim().slice(0, 50_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
