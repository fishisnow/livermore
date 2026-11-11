/**
 * ATR 止损与 stock-scope `frontend/lib/atr.ts` 保持同一口径：
 * Wilder 平滑 14 日 ATR，止损价 = 最新价 − 2 × ATR。
 */

export const ATR_PERIOD = 14;
export const ATR_STOP_MULTIPLIER = 2;
/** 与 stock-scope 计算器的日 K 请求上限一致，供 Wilder 平滑使用。 */
export const ATR_DAILY_BAR_COUNT = 120;

export interface CandleBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

export interface DailyBarInput {
  time?: string | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
}

export function calculateTrueRange(
  high: number,
  low: number,
  prevClose: number | null,
): number {
  if (prevClose === null) return high - low;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/** Wilder 平滑法 ATR。有效 K 线不足 period + 1 根时返回 null。 */
export function calculateWilderATR(bars: CandleBar[], period = ATR_PERIOD): number | null {
  const validBars = bars.filter((bar) =>
    bar.high != null && bar.low != null && bar.close != null
    && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close)
  );
  if (validBars.length < period + 1) return null;

  const trs: number[] = [];
  for (let index = 0; index < validBars.length; index += 1) {
    const bar = validBars[index]!;
    const previousClose = index > 0 ? validBars[index - 1]!.close : null;
    trs.push(calculateTrueRange(bar.high!, bar.low!, previousClose));
  }

  let atr = trs.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < trs.length; index += 1) {
    atr = (atr * (period - 1) + trs[index]!) / period;
  }
  return atr;
}

export function calculateStopLoss(currentPrice: number, atr: number, multiplier = ATR_STOP_MULTIPLIER): number {
  return currentPrice - multiplier * atr;
}

export function atrStopFromDailyBars(
  bars: DailyBarInput[],
  currentPrice: number,
  period = ATR_PERIOD,
  multiplier = ATR_STOP_MULTIPLIER,
): { atr: number; stopLoss: number } | null {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  const candles = [...bars]
    .filter(isUsableDailyBar)
    .sort((left, right) => String(left.time ?? "").localeCompare(String(right.time ?? "")))
    .map((bar) => ({
      date: String(bar.time ?? ""),
      open: null,
      high: bar.high ?? null,
      low: bar.low ?? null,
      close: bar.close ?? null,
    }));
  const atr = calculateWilderATR(candles, period);
  if (atr === null) return null;
  return { atr, stopLoss: calculateStopLoss(currentPrice, atr, multiplier) };
}

function isUsableDailyBar(bar: DailyBarInput): boolean {
  const { high, low, close } = bar;
  return typeof high === "number" && typeof low === "number" && typeof close === "number"
    && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)
    && high > 0 && low > 0 && close > 0
    && high >= low;
}
