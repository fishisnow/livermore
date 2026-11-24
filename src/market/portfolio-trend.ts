import type { AppConfig } from "../config.js";
import type { PortfolioPosition } from "../storage/database.js";
import { queryFutuHistoryKline, queryFutuRtData } from "./futu-client.js";
import { toFutuSecurityCode } from "./normalized-market.js";
import { buildIntradayTrendChart, buildTrendChart, type Ma5Position, type TrendChartModel, type TrendDirection } from "./trend-bands.js";
import { queryUsIndexHistory } from "./us-index-history.js";

export const TREND_KTYPES = ["rt", "1d", "1w", "1M", "1Q", "1Y"] as const;
export type TrendKtype = (typeof TREND_KTYPES)[number];

type HoldingQuote = Pick<PortfolioPosition, "latestPrice" | "lastCheckedAt">;
type TrendReversal = "strong" | "weak";

export interface HoldingTrendSummary {
  symbol: string;
  direction: TrendDirection | null;
  reversal: TrendReversal | null;
  ma5Position: Ma5Position | null;
  intraday?: IntradaySpark | null;
  intradayNote?: string | null;
  error?: string;
}

export interface HoldingTrendChart extends TrendChartModel {
  symbol: string;
  futuCode: string;
  ktype: TrendKtype;
}

const cache = new Map<string, { at: number; chart: HoldingTrendChart }>();
const CACHE_TTL_MS = 10 * 60_000;

const MARKET_INDICES = [
  { symbol: "US..IXIC", name: "纳斯达克综合指数", market: "美股" },
  { symbol: "US..SPX", name: "标普500指数", market: "美股" },
  { symbol: "SH.000001", name: "上证指数", market: "A股" },
  { symbol: "SZ.399006", name: "创业板指数", market: "A股" },
  { symbol: "SH.000688", name: "科创50指数", market: "A股" },
  { symbol: "HK.800000", name: "恒生指数", market: "港股" },
  { symbol: "HK.800700", name: "恒生科技指数", market: "港股" },
  { symbol: "HK.800804", name: "恒生医疗保健指数", market: "港股" },
] as const;

export function isTrendKtype(value: string): value is TrendKtype {
  return (TREND_KTYPES as readonly string[]).includes(value);
}

export async function loadHoldingTrend(config: AppConfig, symbol: string, ktype: TrendKtype = "1d"): Promise<HoldingTrendChart> {
  const futuCode = toFutuSecurityCode(symbol);
  if (!futuCode) throw new Error("只支持沪深和港股持仓的趋势图。");
  return loadTrendChart(config, symbol, futuCode, ktype);
}

export async function loadIndexTrend(config: AppConfig, symbol: string, ktype: TrendKtype): Promise<HoldingTrendChart | undefined> {
  if (!MARKET_INDICES.some((index) => index.symbol === symbol)) return undefined;
  return loadTrendChart(config, symbol, symbol, ktype);
}

export interface IntradaySpark {
  prices: number[];
  vwap: Array<number | null>;
  prevClose?: number | null;
}

export function downsampleIntradaySpark(
  prices: number[],
  vwap: Array<number | null>,
  maxPoints = 72,
): IntradaySpark {
  if (prices.length <= maxPoints) return { prices, vwap };
  const step = prices.length / maxPoints;
  const sampledPrices: number[] = [];
  const sampledVwap: Array<number | null> = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const source = Math.min(prices.length - 1, Math.floor(index * step));
    sampledPrices.push(prices[source]!);
    sampledVwap.push(vwap[source] ?? null);
  }
  return { prices: sampledPrices, vwap: sampledVwap };
}

export async function loadMarketIndices(config: AppConfig) {
  return mapPool([...MARKET_INDICES], 3, async (index) => {
    try {
      const chart = await loadTrendChart(config, index.symbol, index.symbol, "1d", true);
      const latest = chart.candles.at(-1)?.[1];
      if (latest === undefined) throw new Error("暂无日 K 线数据。");
      const previous = chart.candles.at(-2)?.[1];
      const { intraday, intradayNote } = await loadIntradaySparkForSymbol(config, index.symbol, index.symbol, index.symbol.startsWith("US.."));
      return {
        ...index,
        date: chart.dates.at(-1),
        latest,
        dayChangePct: previous === undefined ? null : (latest - previous) / previous * 100,
        direction: chart.direction,
        reversal: holdingTrendReversal(chart),
        ma5Position: chart.ma5Position,
        intraday,
        intradayNote,
      };
    } catch (error) {
      return { ...index, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

async function loadTrendChart(config: AppConfig, symbol: string, futuCode: string, ktype: TrendKtype, refresh = false): Promise<HoldingTrendChart> {
  const key = `${futuCode}:${ktype}`;
  const cached = cache.get(key);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.chart, symbol };
  const yahooSymbol = futuCode === "US..IXIC" ? "^IXIC" : futuCode === "US..SPX" ? "^GSPC" : null;
  if (ktype === "rt") {
    if (yahooSymbol) throw new Error("该指数暂无分时图，请查看日 K。");
    const ttl = 60_000;
    if (!refresh && cached && Date.now() - cached.at < ttl) return { ...cached.chart, symbol };
    const chart: HoldingTrendChart = { symbol, futuCode, ktype, ...buildIntradayTrendChart(await queryFutuRtData(config, futuCode)) };
    cache.set(key, { at: Date.now(), chart });
    return chart;
  }
  const range = trendRange(ktype);
  const bars = yahooSymbol
    ? await queryUsIndexHistory(yahooSymbol, ktype, range.start, range.end)
    : await queryFutuHistoryKline(config, futuCode, ktype, range.start, range.end);
  const chart: HoldingTrendChart = { symbol, futuCode, ktype, ...buildTrendChart(bars) };
  cache.set(key, { at: Date.now(), chart });
  return chart;
}

export async function loadHoldingTrends(config: AppConfig, positions: Array<HoldingQuote & { symbol: string }>): Promise<HoldingTrendSummary[]> {
  return mapPool(positions, 3, async (position) => {
    const { symbol } = position;
    try {
      const chart = await loadHoldingTrend(config, symbol, "1d");
      const spark = await loadIntradaySparkForSymbol(config, symbol, chart.futuCode, false);
      return {
        symbol,
        direction: chart.direction,
        reversal: holdingTrendReversal(chart, position),
        ma5Position: chart.ma5Position,
        intraday: spark.intraday,
        intradayNote: spark.intradayNote,
      };
    } catch (error) {
      const futuCode = toFutuSecurityCode(symbol);
      const spark = futuCode
        ? await loadIntradaySparkForSymbol(config, symbol, futuCode, false)
        : { intraday: null, intradayNote: "暂无分时" as const };
      return {
        symbol,
        direction: null,
        reversal: null,
        ma5Position: null,
        intraday: spark.intraday,
        intradayNote: spark.intradayNote,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function loadIntradaySparkForSymbol(
  config: AppConfig,
  symbol: string,
  futuCode: string,
  usIndex: boolean,
): Promise<{ intraday: IntradaySpark | null; intradayNote: string | null }> {
  if (usIndex) return { intraday: null, intradayNote: "暂无分时" };
  try {
    const rt = await loadTrendChart(config, symbol, futuCode, "rt", false);
    const prices = rt.linePrices ?? [];
    const vwap = rt.vwap ?? [];
    if (prices.length < 2) return { intraday: null, intradayNote: "暂无分时" };
    return {
      intraday: { ...downsampleIntradaySpark(prices, vwap), prevClose: rt.prevClose ?? null },
      intradayNote: null,
    };
  } catch (error) {
    return { intraday: null, intradayNote: error instanceof Error ? error.message : "暂无分时" };
  }
}

export function holdingTrendReversal(chart: TrendChartModel, quote?: HoldingQuote): TrendReversal | null {
  if (chart.direction !== "down") return null;
  const date = chart.dates.at(-1);
  let price = chart.candles.at(-1)?.[1];
  if (date && quote?.latestPrice != null && quote.lastCheckedAt
    && shanghaiDate(new Date(quote.lastCheckedAt)) >= date) {
    price = quote.latestPrice;
  }

  const shortA = chart.shortA.at(-1);
  const shortB = chart.shortB.at(-1);
  const longA = chart.longA.at(-1);
  const longB = chart.longB.at(-1);
  if (price == null || shortA == null || shortB == null || longA == null || longB == null) return null;
  if (price > Math.max(longA, longB)) return "strong";
  if (price > Math.max(shortA, shortB)) return "weak";
  return null;
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
