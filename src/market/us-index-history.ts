import type { TrendKtype } from "./portfolio-trend.js";
import type { TrendBar } from "./trend-bands.js";

type UsIndexSymbol = "^IXIC" | "^GSPC";

interface YahooIndexChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<Partial<Record<"open" | "high" | "low" | "close" | "volume", Array<number | null>>>>;
      };
    }>;
  };
}

const marketDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

export async function queryUsIndexHistory(
  symbol: UsIndexSymbol,
  ktype: TrendKtype,
  start: string,
  end: string,
): Promise<TrendBar[]> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.search = new URLSearchParams({
    interval: ktype === "1d" ? "1d" : ktype === "1w" ? "1wk" : "1mo",
    period1: String(Date.parse(start) / 1000),
    period2: String(Date.parse(end) / 1000 + 86400),
  }).toString();
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Yahoo Finance 指数行情读取失败（HTTP ${response.status}）。`);
  const chart = (await response.json() as YahooIndexChart).chart?.result?.[0];
  const quote = chart?.indicators?.quote?.[0];
  const bars = (chart?.timestamp ?? []).flatMap((timestamp, index) => {
    const open = quote?.open?.[index];
    const high = quote?.high?.[index];
    const low = quote?.low?.[index];
    const close = quote?.close?.[index];
    const volume = quote?.volume?.[index] ?? 0;
    if (open == null || high == null || low == null || close == null) return [];
    return [{ date: marketDate.format(timestamp * 1000), open, high, low, close, volume }];
  });
  if (!bars.length) throw new Error("Yahoo Finance 暂无该指数的 K 线数据。");
  if (ktype === "1Q" || ktype === "1Y") return aggregateMonths(bars, ktype);
  return bars;
}

function aggregateMonths(bars: TrendBar[], ktype: "1Q" | "1Y"): TrendBar[] {
  const periods = new Map<string, TrendBar>();
  for (const bar of bars) {
    const year = bar.date.slice(0, 4);
    const quarter = Math.floor((Number(bar.date.slice(5, 7)) - 1) / 3);
    const key = ktype === "1Y" ? year : `${year}-${quarter}`;
    const period = periods.get(key);
    if (!period) {
      periods.set(key, { ...bar });
      continue;
    }
    period.high = Math.max(period.high, bar.high);
    period.low = Math.min(period.low, bar.low);
    period.close = bar.close;
    period.volume += bar.volume;
  }
  return [...periods.values()];
}
