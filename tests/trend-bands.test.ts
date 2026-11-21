import { describe, expect, it } from "vitest";
import { buildTrendChart, type TrendBar } from "../src/market/trend-bands.js";

function bars(step: number): TrendBar[] {
  return Array.from({ length: 120 }, (_, index) => {
    const base = 50 + step * index;
    return {
      date: `2024-01-${String(index + 1).padStart(2, "0")}`,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.4,
      volume: 1_000,
    };
  });
}

describe("trend bands", () => {
  it("marks a rising market as an uptrend on both horizons", () => {
    const chart = buildTrendChart(bars(1));
    expect(chart.short).toBe("up");
    expect(chart.long).toBe("up");
    expect(chart.shortStickUp.length).toBeGreaterThan(0);
  });

  it("marks a falling market as a downtrend", () => {
    const chart = buildTrendChart(bars(-1));
    expect(chart.short).toBe("down");
    expect(chart.long).toBe("down");
  });

  it("marks an unchanged market as flat", () => {
    const chart = buildTrendChart(bars(0));
    expect(chart.short).toBe("flat");
    expect(chart.long).toBe("flat");
  });
});
