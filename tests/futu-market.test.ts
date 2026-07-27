import { describe, expect, it } from "vitest";
import {
  extractIndicatorValue,
  normalizeFutuResult,
} from "../src/market/futu-client.js";
import { normalizePortfolioMarketData } from "../src/market/portfolio-market-normalizer.js";
import {
  normalizeSecurityCode,
  toFutuSecurityCode,
} from "../src/market/normalized-market.js";

describe("Futu portfolio market data", () => {
  it("maps Livermore A-share and Hong Kong symbols to Futu codes", () => {
    expect(toFutuSecurityCode("600519.SH")).toBe("SH.600519");
    expect(toFutuSecurityCode("000001")).toBe("SZ.000001");
    expect(toFutuSecurityCode("HK00700")).toBe("HK.00700");
    expect(toFutuSecurityCode("58200")).toBe("HK.58200");
    expect(normalizeSecurityCode("58200")).toBe("58200.HK");
    expect(toFutuSecurityCode("430001.BJ")).toBeUndefined();
  });

  it("extracts the latest named value from Futu indicator output", () => {
    const result = {
      success: true,
      outputs: [{ name: "DIF" }, { name: "DEA" }, { name: "MACD" }],
      output_rows: [
        { time: "2026-07-26", values: [1, 0.5, 1] },
        { time: "2026-07-27", values: [1.2, 0.7, 1.25] },
      ],
    };
    expect(extractIndicatorValue(result, "MACD")).toBe(1.25);
    expect(extractIndicatorValue(result, "RSI1")).toBeUndefined();
  });

  it("keeps Futu ownership of quotes and accepts only Iwencai main fund flow", () => {
    const futu = {
      source: "futuapi" as const,
      rows: [{
        requestedSymbol: "600519.SH",
        symbol: "600519.SH",
        futuCode: "SH.600519",
        name: "贵州茅台",
        currentPrice: 1_500,
        dayChangePct: -1.2,
        rsi: 48,
        macd: -0.5,
        raw: { klineCount: 80 },
      }],
    };
    expect(normalizeFutuResult(futu)[0]).toMatchObject({
      currentPrice: 1_500,
      evidence: [expect.objectContaining({ source: "futuapi" })],
    });

    const merged = normalizePortfolioMarketData([futu], [{
      query: "600519 主力净流入",
      datas: [{
        股票代码: "600519.SH",
        股票简称: "问财名称不应覆盖",
        最新价: 9_999,
        最新涨跌幅: 8.8,
        RSI: 99,
        MACD: 99,
        主力净流入: -123_000,
      }],
    }]);
    expect(merged[0]).toMatchObject({
      name: "贵州茅台",
      currentPrice: 1_500,
      dayChangePct: -1.2,
      rsi: 48,
      macd: -0.5,
      mainNetInflow: -123_000,
    });
  });

  it("does not apply Iwencai fields to Hong Kong holdings", () => {
    const merged = normalizePortfolioMarketData([{
      source: "futuapi",
      rows: [{
        requestedSymbol: "HK00700",
        symbol: "00700.HK",
        currentPrice: 443,
        raw: {},
      }],
    }], [{
      datas: [{
        股票代码: "00700.HK",
        最新价: 1,
        主力净流入: 999,
      }],
    }]);
    expect(merged[0]).toMatchObject({ currentPrice: 443 });
    expect(merged[0]?.mainNetInflow).toBeUndefined();
  });
});
