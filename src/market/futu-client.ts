import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import { projectSkillsDirectory } from "../project-paths.js";
import {
  normalizeSecurityCode,
  toFutuSecurityCode,
  type NormalizedMarketQuote,
} from "./normalized-market.js";

const execFileAsync = promisify(execFile);
export const futuSnapshotScriptPath = path.join(
  projectSkillsDirectory,
  "futuapi",
  "scripts",
  "quote",
  "get_snapshot.py",
);
export const futuKlineScriptPath = path.join(
  projectSkillsDirectory,
  "futuapi",
  "scripts",
  "quote",
  "get_kline.py",
);
export const futuIndicatorScriptPath = path.join(
  projectSkillsDirectory,
  "futuapi",
  "scripts",
  "quote",
  "get_indicator_calc_result.py",
);
export const futuNewsScriptPath = path.join(
  projectSkillsDirectory,
  "futuapi",
  "scripts",
  "quote",
  "get_search_news.py",
);

interface FutuSnapshotRow {
  code?: string;
  name?: string;
  last_price?: number;
  prev_close?: number;
  [key: string]: unknown;
}

interface FutuKlineRow {
  time?: string;
  close?: number;
  [key: string]: unknown;
}

interface FutuIndicatorResult {
  success?: boolean;
  err_msg?: string;
  outputs?: Array<{ name?: string }>;
  output_rows?: Array<{ time?: string; values?: unknown[] }>;
}

export interface FutuMarketRow {
  requestedSymbol: string;
  symbol: string;
  futuCode?: string;
  name?: string;
  currentPrice?: number;
  dayChangePct?: number;
  rsi?: number;
  macd?: number;
  asOf?: string;
  error?: string;
  raw: {
    snapshot?: FutuSnapshotRow;
    klineCount?: number;
    indicatorEngine?: "Futu OpenD";
  };
}

export interface FutuMarketResult {
  source: "futuapi";
  rows: FutuMarketRow[];
}

export interface FutuNewsItem {
  title?: string;
  news_sub_type?: string;
  source?: string;
  publish_time?: string;
  related_securities?: unknown;
  url?: string;
  [key: string]: unknown;
}

export interface FutuNewsQueryResult {
  keyword: string;
  items: FutuNewsItem[];
  error?: string;
}

export interface FutuNewsResult {
  source: "futuapi";
  queries: FutuNewsQueryResult[];
}

export async function queryFutuMarket(
  config: AppConfig,
  symbols: string[],
): Promise<FutuMarketResult> {
  const requested = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))];
  if (requested.length === 0 || requested.length > 50) {
    throw new Error("Futu market query requires between 1 and 50 security symbols.");
  }
  const mapped = requested.map((requestedSymbol) => {
    const symbol = normalizeSecurityCode(requestedSymbol) ?? requestedSymbol.toUpperCase();
    return { requestedSymbol, symbol, futuCode: toFutuSecurityCode(requestedSymbol) };
  });
  const supported = mapped.filter(
    (item): item is typeof item & { futuCode: string } => item.futuCode !== undefined,
  );
  const snapshots = supported.length > 0
    ? await readSnapshots(config, supported.map((item) => item.futuCode))
    : new Map<string, FutuSnapshotRow>();
  const rows: FutuMarketRow[] = [];

  for (const item of mapped) {
    if (!item.futuCode) {
      rows.push({
        requestedSymbol: item.requestedSymbol,
        symbol: item.symbol,
        error: `futuapi 不支持或无法识别代码 ${item.requestedSymbol}；仅支持 SH、SZ、HK`,
        raw: {},
      });
      continue;
    }
    const snapshot = snapshots.get(item.futuCode);
    let klines: FutuKlineRow[] = [];
    let klineError: string | undefined;
    try {
      klines = await readDailyKlines(config, item.futuCode);
    } catch (error) {
      klineError = errorMessage(error);
    }
    let rsi: number | undefined;
    let macd: number | undefined;
    if (klines.length > 0) {
      try {
        ({ rsi, macd } = await readTechnicalIndicators(config, item.futuCode, klines));
      } catch (error) {
        klineError = [klineError, `Futu 指标计算不可用：${errorMessage(error)}`]
          .filter(Boolean)
          .join("；");
      }
    }
    const lastKline = klines.at(-1);
    const currentPrice = positiveNumber(snapshot?.last_price) ?? positiveNumber(lastKline?.close);
    const previousClose = positiveNumber(snapshot?.prev_close) ?? positiveNumber(klines.at(-2)?.close);
    rows.push({
      requestedSymbol: item.requestedSymbol,
      symbol: item.symbol,
      futuCode: item.futuCode,
      ...(text(snapshot?.name) ? { name: text(snapshot?.name)! } : {}),
      ...(currentPrice === undefined ? {} : { currentPrice }),
      ...(currentPrice === undefined || previousClose === undefined
        ? {}
        : { dayChangePct: round(((currentPrice - previousClose) / previousClose) * 100) }),
      ...(rsi === undefined ? {} : { rsi }),
      ...(macd === undefined ? {} : { macd }),
      ...(text(lastKline?.time) ? { asOf: text(lastKline?.time)! } : {}),
      ...(klineError ? { error: `日 K 线/技术指标不可用：${klineError}` } : {}),
      raw: {
        ...(snapshot ? { snapshot } : {}),
        klineCount: klines.length,
        ...(rsi !== undefined || macd !== undefined ? { indicatorEngine: "Futu OpenD" } : {}),
      },
    });
  }
  return { source: "futuapi", rows };
}

export async function queryFutuNews(
  config: AppConfig,
  keywords: string[],
  maxCount = 3,
): Promise<FutuNewsResult> {
  const requested = [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))];
  if (requested.length === 0 || requested.length > 10) {
    throw new Error("Futu news query requires between 1 and 10 keywords.");
  }
  const count = Math.min(5, Math.max(1, Math.trunc(maxCount)));
  const queries: FutuNewsQueryResult[] = [];
  for (const keyword of requested) {
    try {
      const output = await runFutuScript(
        config,
        futuNewsScriptPath,
        [keyword, "--max-count", String(count), "--news-sub-type", "ALL", "--json"],
        35_000,
      );
      const parsed = parseJson<{ data?: FutuNewsItem[]; error?: string }>(
        output,
        `Futu news search ${keyword}`,
      );
      queries.push({
        keyword,
        items: parsed.data ?? [],
        ...(parsed.error ? { error: parsed.error } : {}),
      });
    } catch (error) {
      queries.push({ keyword, items: [], error: errorMessage(error) });
    }
  }
  return { source: "futuapi", queries };
}

export function normalizeFutuResult(result: FutuMarketResult): NormalizedMarketQuote[] {
  return result.rows.map((row) => ({
    symbol: row.symbol,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.currentPrice === undefined ? {} : { currentPrice: row.currentPrice }),
    ...(row.dayChangePct === undefined ? {} : { dayChangePct: row.dayChangePct }),
    ...(row.rsi === undefined ? {} : { rsi: row.rsi }),
    ...(row.macd === undefined ? {} : { macd: row.macd }),
    evidence: [{
      source: "futuapi",
      row: {
        requestedSymbol: row.requestedSymbol,
        ...(row.futuCode ? { futuCode: row.futuCode } : {}),
        ...(row.asOf ? { asOf: row.asOf } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...row.raw,
      },
    }],
  }));
}

async function readSnapshots(
  config: AppConfig,
  codes: string[],
): Promise<Map<string, FutuSnapshotRow>> {
  const output = await runFutuScript(config, futuSnapshotScriptPath, [...codes, "--json"], 35_000);
  const parsed = parseJson<{ data?: FutuSnapshotRow[] }>(output, "Futu snapshot");
  return new Map((parsed.data ?? [])
    .filter((row) => text(row.code))
    .map((row) => [text(row.code)!, row]));
}

async function readTechnicalIndicators(
  config: AppConfig,
  code: string,
  klines: FutuKlineRow[],
): Promise<{ rsi?: number; macd?: number }> {
  const directory = await mkdtemp(path.join(tmpdir(), "livermore-futu-"));
  const filename = path.join(directory, "daily-kline.json");
  try {
    await writeFile(filename, JSON.stringify({
      code,
      ktype: "1d",
      data: klines,
    }), "utf8");
    const [rsiResult, macdResult] = await Promise.all([
      readIndicator(config, filename, "RSI", ["0=14", "1=14", "2=14"]),
      readIndicator(config, filename, "MACD", ["0=12", "1=26", "2=9"]),
    ]);
    return {
      ...(extractIndicatorValue(rsiResult, "RSI1") === undefined
        ? {}
        : { rsi: extractIndicatorValue(rsiResult, "RSI1")! }),
      ...(extractIndicatorValue(macdResult, "MACD") === undefined
        ? {}
        : { macd: extractIndicatorValue(macdResult, "MACD")! }),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readIndicator(
  config: AppConfig,
  klFile: string,
  shortName: "RSI" | "MACD",
  params: string[],
): Promise<FutuIndicatorResult> {
  const args = [
    "--short-name", shortName,
    "--lang", "1",
    "--kl-file", klFile,
    ...params.flatMap((value) => ["--param", value]),
    "--json",
  ];
  const output = await runFutuScript(config, futuIndicatorScriptPath, args, 75_000);
  const result = parseJson<FutuIndicatorResult>(output, `Futu indicator ${shortName}`);
  if (!result.success) throw new Error(result.err_msg || `${shortName} calculation failed`);
  return result;
}

export function extractIndicatorValue(
  result: FutuIndicatorResult,
  outputName: string,
): number | undefined {
  const index = (result.outputs ?? []).findIndex(
    (output) => text(output.name)?.toUpperCase() === outputName.toUpperCase(),
  );
  if (index < 0) return undefined;
  const value = result.output_rows?.at(-1)?.values?.[index];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? round(parsed) : undefined;
}

async function readDailyKlines(config: AppConfig, code: string): Promise<FutuKlineRow[]> {
  const output = await runFutuScript(
    config,
    futuKlineScriptPath,
    [code, "--ktype", "1d", "--num", "80", "--rehab", "forward", "--json"],
    35_000,
  );
  const parsed = parseJson<{ data?: FutuKlineRow[] }>(output, `Futu K-line ${code}`);
  return parsed.data ?? [];
}

async function runFutuScript(
  config: AppConfig,
  script: string,
  args: string[],
  timeout: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(config.futuPythonExecutable, [script, ...args], {
      cwd: path.dirname(script),
      env: {
        ...process.env,
        FUTU_OPEND_HOST: config.futuOpenDHost,
        FUTU_OPEND_PORT: String(config.futuOpenDPort),
      },
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout);
  } catch (error) {
    const detail = commandOutput(error);
    throw new Error(detail || `futuapi command failed: ${errorMessage(error)}`);
  }
}

function parseJson<T>(value: string, label: string): T {
  const candidates = [value.trim(), ...value.split(/\r?\n/).map((line) => line.trim()).reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Futu SDK may write connection logs to stdout around the JSON line.
    }
  }
  throw new Error(`${label} returned invalid JSON: ${value.slice(0, 500)}`);
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function commandOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { stdout?: string | Buffer; stderr?: string | Buffer };
  return String(value.stdout || value.stderr || "").trim().slice(0, 50_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
