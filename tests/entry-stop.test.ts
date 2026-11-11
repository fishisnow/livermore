import { describe, expect, it } from "vitest";
import { readEntryAtrStop } from "../src/portfolio/entry-stop.js";

describe("entry ATR stop", () => {
  it("keeps the stop calculated for the requested symbol", () => {
    expect(readEntryAtrStop({
      source: "futuapi",
      rows: [{
        requestedSymbol: "600519.SH",
        symbol: "600519.SH",
        atr: 28.5,
        atrStopLoss: 1431,
        raw: {},
      }],
    }, "600519.sh")).toEqual({ atr: 28.5, atrStopLoss: 1431 });
  });

  it("rejects a quote that has no fixed stop", () => {
    expect(() => readEntryAtrStop({
      source: "futuapi",
      rows: [{ requestedSymbol: "000001.SZ", symbol: "000001.SZ", currentPrice: 10, raw: {} }],
    }, "000001.SZ")).toThrow(/持仓未添加/);
  });
});