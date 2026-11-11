import { describe, expect, it } from "vitest";
import {
  ATR_PERIOD,
  ATR_STOP_MULTIPLIER,
  atrStopFromDailyBars,
  calculateStopLoss,
  calculateWilderATR,
  type CandleBar,
} from "../src/market/atr.js";

describe("ATR stop loss", () => {
  it("uses Wilder ATR(14) and a 2× stop below the latest price", () => {
    expect(ATR_PERIOD).toBe(14);
    expect(ATR_STOP_MULTIPLIER).toBe(2);
    const bars: CandleBar[] = Array.from({ length: 20 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      open: null,
      high: 12,
      low: 10,
      close: 11,
    }));
    expect(calculateWilderATR(bars)).toBe(2);
    expect(calculateStopLoss(20, 2)).toBe(16);
  });

  it("returns null until there are period + 1 usable bars", () => {
    const bars: CandleBar[] = Array.from({ length: ATR_PERIOD }, (_, index) => ({
      date: `2026-02-${String(index + 1).padStart(2, "0")}`,
      open: null,
      high: 10,
      low: 9,
      close: 9.5,
    }));
    expect(calculateWilderATR(bars)).toBeNull();
  });

  it("smooths a new true range with the Wilder recurrence", () => {
    const bars: CandleBar[] = [
      { date: "2026-03-01", open: null, high: 10, low: 8, close: 9 },
      { date: "2026-03-02", open: null, high: 11, low: 9, close: 10 },
      { date: "2026-03-03", open: null, high: 12, low: 9, close: 11 },
      { date: "2026-03-04", open: null, high: 11, low: 10, close: 10.5 },
    ];
    const atr = calculateWilderATR(bars, 3);
    expect(atr).toBeCloseTo((7 / 3 * 2 + 1) / 3, 10);
    expect(calculateStopLoss(10.5, atr!, 2)).toBeCloseTo(10.5 - 2 * atr!, 10);
  });

  it("sorts daily bars and ignores unusable candles before calculating the stop", () => {
    const usable = Array.from({ length: 16 }, (_, index) => ({
      time: `2026-04-${String(16 - index).padStart(2, "0")}`,
      high: 12,
      low: 10,
      close: 11,
    }));
    const result = atrStopFromDailyBars([
      { time: "2026-04-01", high: 0, low: 0, close: 0 },
      ...usable,
    ], 30);
    expect(result).toEqual({ atr: 2, stopLoss: 26 });
  });
});
