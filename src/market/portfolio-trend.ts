import type { AppConfig } from "../config.js";
import { queryFutuHistoryKline } from "./futu-client.js";
import { toFutuSecurityCode } from "./normalized-market.js";
import { buildTrendChart, type TrendChartModel, type TrendDirection } from "./trend-bands.js";

export const TREND_KTYPES = ["1d", "1w", "1M", "1Q", "1Y"] as const;
export type TrendKtype = (typeof TREND_KTYPES)[number];

export interface HoldingTrendSummary {
  symbol: string;
  short: TrendDirection | null;
  long: TrendDirection | null;
  error?: string;
}

export interface HoldingTrendChart extends TrendChartModel {
  symbol: string;
  futuCode: string;
  ktype: TrendKtype;
}

const cache = new Map<string, { at: number; chart: HoldingTrendChart }>();
const CACHE_TTL_MS = 10 * 60_000;

export function isTrendKtype(value: string): value is TrendKtype {
  return (TREND_KTYPES as readonly string[]).includes(value);
}

export async function loadHoldingTrend(config: AppConfig, symbol: string, ktype: TrendKtype = "1d"): Promise<HoldingTrendChart> {
  const futuCode = toFutuSecurityCode(symbol);
  if (!futuCode) throw new Error("只支持沪深和港股持仓的趋势图。");
  const key = `${futuCode}:${ktype}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.chart;
  const range = trendRange(ktype);
  const bars = await queryFutuHistoryKline(config, futuCode, ktype, range.start, range.end);
  const chart: HoldingTrendChart = { symbol, futuCode, ktype, ...buildTrendChart(bars) };
  cache.set(key, { at: Date.now(), chart });
  return chart;
}

export async function loadHoldingTrends(config: AppConfig, symbols: string[]): Promise<HoldingTrendSummary[]> {
  return mapPool(symbols, 3, async (symbol) => {
    try {
      const chart = await loadHoldingTrend(config, symbol, "1d");
      return { symbol, short: chart.short, long: chart.long };
    } catch (error) {
      return { symbol, short: null, long: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function trendRange(ktype: TrendKtype): { start: string; end: string } {
  const end = shanghaiDate(new Date());
  if (ktype === "1Y") return { start: "2000-01-01", end };
  const start = new Date();
  const years = ktype === "1w" ? 3 : ktype === "1M" ? 10 : ktype === "1Q" ? 20 : 1;
  start.setFullYear(start.getFullYear() - years);
  return { start: shanghaiDate(start), end };
}

function shanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

async function mapPool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
