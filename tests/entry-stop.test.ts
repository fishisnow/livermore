import { describe, expect, it } from "vitest";
import { readEntryAtrStop } from "../src/portfolio/entry-stop.js";

describe("entry ATR stop", () => {
  it("keeps the stop calculated for the requested symbol", () => {
    expect(readEntryAtrStop({
      source: "futuapi",
      rows: [{
        requestedSymbol: "600519.SH",
        symbol: "600519.SH",
        currentPrice: 1488,
        atr: 28.5,
        atrStopLoss: 1,
        raw: {},
      }],
    }, "600519.sh", 2)).toEqual({ atr: 28.5, atrStopLoss: 1431 });
    expect(readEntryAtrStop({
      source: "futuapi",
      rows: [{
        requestedSymbol: "600519.SH",
        symbol: "600519.SH",
        currentPrice: 1488,
        atr: 28.5,
        raw: {},
      }],
    }, "600519.sh", 3).atrStopLoss).toBe(1402.5);
  });

  it("rejects a quote that has no fixed stop", () => {
    expect(() => readEntryAtrStop({
      source: "futuapi",
      rows: [{ requestedSymbol: "000001.SZ", symbol: "000001.SZ", currentPrice: 10, raw: {} }],
    }, "000001.SZ")).toThrow(/持仓未添加/);
  });
});