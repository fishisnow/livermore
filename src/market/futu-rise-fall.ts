import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig, type AppConfig } from "../config.js";
import { projectSkillsDirectory } from "../project-paths.js";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const SCRIPT = path.join(projectSkillsDirectory, "futuapi", "scripts", "quote", "get_rise_fall_distribution.py");

export interface AshareRiseFallSnapshot {
  source: "futuapi";
  name: "大A涨跌家数";
  success: boolean;
  message?: string;
  plate?: string;
  date?: string;
  rise?: number;
  fall?: number;
  flat?: number;
  limitUp?: number;
  limitDown?: number;
  total?: number;
  /** Share of rising names among rising and falling names. Flat names are excluded. */
  heat?: number;
}

interface RiseFallOptions {
  config?: AppConfig;
  runImpl?: () => Promise<string>;
  now?: number;
}

let cache: { at: number; value: AshareRiseFallSnapshot } | undefined;

export function summarizeRiseFall(rangeList: unknown): { rise: number; fall: number; flat: number; limitUp: number; limitDown: number } {
  const totals = { rise: 0, fall: 0, flat: 0, limitUp: 0, limitDown: 0 };
  if (!Array.isArray(rangeList)) return totals;
  for (const item of rangeList) {
    if (!item || typeof item !== "object") continue;
    const row = item as { type?: unknown; left_border?: unknown; right_border?: unknown; stock_count?: unknown };
    const count = typeof row.stock_count === "number" ? row.stock_count : Number(row.stock_count);
    const side = bucketSide(row.type, row.left_border, row.right_border);
    if (!side || !Number.isInteger(count) || count < 0) continue;
    totals[side] += count;
    if (row.type === "RISE_LIMIT") totals.limitUp += count;
    if (row.type === "FALL_LIMIT") totals.limitDown += count;
  }
  return totals;
}

export function riseFallHeat(rise: number, fall: number): number {
  const moving = rise + fall;
  if (moving <= 0) return 0.5;
  return rise / moving;
}

export async function queryAshareRiseFall(options: RiseFallOptions = {}): Promise<AshareRiseFallSnapshot> {
  const now = options.now ?? Date.now();
  if (!options.runImpl && cache && now - cache.at < CACHE_MS) return cache.value;
  const snapshot = await fetchRiseFall(options, now);
  if (!options.runImpl && snapshot.success) cache = { at: now, value: snapshot };
  return snapshot;
}

async function fetchRiseFall(options: RiseFallOptions, now: number): Promise<AshareRiseFallSnapshot> {
  const base = { source: "futuapi" as const, name: "大A涨跌家数" as const };
  try {
    const stdout = options.runImpl ? await options.runImpl() : await runDistributionScript(options.config ?? loadConfig());
    const payload = parsePayload(stdout);
    const counts = summarizeRiseFall(payload.range_list);
    const total = counts.rise + counts.fall + counts.flat;
    if (total <= 0) return { ...base, success: false, message: "涨跌分布没有返回家数" };
    const plate = typeof payload.plate === "string" ? payload.plate : "";
    const heat = riseFallHeat(counts.rise, counts.fall);
    return {
      ...base,
      success: true,
      ...(plate ? { plate } : {}),
      date: tradingDate(now),
      ...counts,
      total,
      heat,
    };
  } catch (error) {
    return { ...base, success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function bucketSide(type: unknown, leftBorder: unknown, rightBorder: unknown): "rise" | "fall" | "flat" | null {
  if (type === "RISE_LIMIT" || type === "POSITIVE_INFINITY") return "rise";
  if (type === "FALL_LIMIT" || type === "NEGATIVE_INFINITY") return "fall";
  const left = typeof leftBorder === "number" ? leftBorder : Number(leftBorder);
  const right = typeof rightBorder === "number" ? rightBorder : Number(rightBorder);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const low = Math.min(left, right);
  const high = Math.max(left, right);
  if (low === 0 && high === 0) return "flat";
  if (low >= 0) return "rise";
  if (high <= 0) return "fall";
  return null;
}

function tradingDate(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function runDistributionScript(config: AppConfig): Promise<string> {
  try {
    const { stdout } = await execFileAsync(config.futuPythonExecutable, [SCRIPT, "--market", "CN"], {
      cwd: path.dirname(SCRIPT),
      env: {
        ...process.env,
        FUTU_OPEND_HOST: config.futuOpenDHost,
        FUTU_OPEND_PORT: String(config.futuOpenDPort),
      },
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return String(stdout);
  } catch (error) {
    const output = error && typeof error === "object"
      ? String((error as { stderr?: string; stdout?: string }).stderr || (error as { stdout?: string }).stdout || "")
      : "";
    throw new Error(output.trim().slice(0, 500) || (error instanceof Error ? error.message : String(error)));
  }
}

function parsePayload(stdout: string): { plate?: unknown; range_list?: unknown } {
  const text = stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("涨跌分布没有返回 JSON");
  const payload = JSON.parse(text.slice(start, end + 1)) as { plate?: unknown; range_list?: unknown };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("涨跌分布没有返回 JSON");
  return payload;
}
