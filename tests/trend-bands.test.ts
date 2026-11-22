import { describe, expect, it } from "vitest";
import { holdingTrendReversal } from "../src/market/portfolio-trend.js";
import { buildTrendChart, type TrendBar } from "../src/market/trend-bands.js";

function bars(step: number): TrendBar[] {
  return Array.from({ length: 120 }, (_, index) => {
    const base = 150 + step * index;
    return {
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.4,
      volume: 1_000,
    };
  });
}

describe("trend bands", () => {
  it("marks an uptrend when the entire short band is above the long band", () => {
    const chart = buildTrendChart(bars(1));
    expect(chart.direction).toBe("up");
    expect(chart.shortStickUp.length).toBeGreaterThan(0);
  });

  it("marks a downtrend when the entire short band is below the long band", () => {
    const chart = buildTrendChart(bars(-1));
    expect(chart.direction).toBe("down");
  });

  it("marks overlapping bands as flat even when all tracks are rising", () => {
    const chart = buildTrendChart(bars(0.01));
    expect(chart.direction).toBe("flat");
  });

  it("marks touching bands as flat", () => {
    const chart = buildTrendChart(bars(0).map((bar) => ({ ...bar, high: bar.open, low: bar.open, close: bar.open })));
    expect(chart.direction).toBe("flat");
  });

  it("returns no direction without bars", () => {
    expect(buildTrendChart([]).direction).toBeNull();
  });
});

describe("latest candle position relative to MA5", () => {
  it.each([
    { open: 102, close: 105, expected: "above" },
    { open: 98, close: 95, expected: "below" },
    { open: 99, close: 105, expected: null },
    { open: 101, close: 105, expected: null },
    { open: 102, close: 100, expected: null },
  ])("classifies open $open and close $close as $expected", ({ open, close, expected }) => {
    const history = bars(0).slice(0, 5).map((bar) => ({ ...bar, open: 100, close: 100, low: 90, high: 110 }));
    history[4] = { ...history[4]!, open, close };
    expect(buildTrendChart(history).ma5Position).toBe(expected);
  });

  it("requires at least five candles", () => {
    expect(buildTrendChart(bars(1).slice(0, 4)).ma5Position).toBeNull();
  });
});

describe("holding trend reversals", () => {
  const chart = buildTrendChart(bars(-0.25));
  const shortUpper = chart.shortA.at(-1)!;
  const longUpper = chart.longA.at(-1)!;

  function quote(latestPrice: number) {
    return { latestPrice, lastCheckedAt: "2025-01-01T01:00:00.000Z" };
  }

  it("prioritizes a strong reversal above the long upper track", () => {
    expect(holdingTrendReversal(chart, quote(longUpper + 0.01))).toBe("strong");
  });

  it("shows a weak reversal above the short upper track through the long upper track", () => {
    expect(holdingTrendReversal(chart, quote(shortUpper + 0.01))).toBe("weak");
    expect(holdingTrendReversal(chart, quote(longUpper))).toBe("weak");
  });

  it("requires a strict break above the short upper track and a downtrend", () => {
    expect(holdingTrendReversal(chart, quote(shortUpper))).toBeNull();
    expect(holdingTrendReversal(buildTrendChart(bars(0)), quote(longUpper + 100))).toBeNull();
    expect(holdingTrendReversal(buildTrendChart(bars(1)), quote(longUpper + 100))).toBeNull();
  });

  it("falls back to the latest candle when the stored quote is missing or older", () => {
    const history = bars(-0.25);
    const close = (shortUpper + longUpper) / 2;
    history[history.length - 1] = { ...history.at(-1)!, open: close, high: close + 1, low: close - 1, close };
    const chartWithBreakout = buildTrendChart(history);
    expect(holdingTrendReversal(chartWithBreakout)).toBe("weak");
    expect(holdingTrendReversal(chartWithBreakout, {
      latestPrice: longUpper + 1,
      lastCheckedAt: "2023-12-31T01:00:00.000Z",
    })).toBe("weak");
  });
});
