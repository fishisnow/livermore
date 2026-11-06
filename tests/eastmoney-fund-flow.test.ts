import { describe, expect, it } from "vitest";
import {
  normalizeEastmoneyFundFlowResults,
  queryEastmoneyMainFundFlow,
  toEastmoneySecId,
} from "../src/market/eastmoney-fund-flow.js";
import { normalizePortfolioMarketData } from "../src/market/portfolio-market-normalizer.js";

describe("East Money fund-flow client", () => {
  it("maps mainland symbols to East Money secids", () => {
    expect(toEastmoneySecId("600519.SH")).toBe("1.600519");
    expect(toEastmoneySecId("000001.SZ")).toBe("0.000001");
    expect(toEastmoneySecId("430047.BJ")).toBe("0.430047");
    expect(toEastmoneySecId("00700.HK")).toBeUndefined();
  });

  it("parses batch fund-flow rows from the public ulist endpoint", async () => {
    const result = await queryEastmoneyMainFundFlow(["000001.SZ", "600519.SH"], {
      fetchImpl: async () => new Response(JSON.stringify({
        data: {
          diff: [
            {
              f12: "000001",
              f14: "平安银行",
              f62: -100_000,
              f184: -1.2,
              f66: -80_000,
              f69: -0.8,
              f72: -20_000,
              f75: -0.4,
              f78: 10_000,
              f81: 0.1,
              f84: 90_000,
              f87: 1.1,
              f124: 1_700_000_000,
            },
            {
              f12: "600519",
              f14: "贵州茅台",
              f62: 50_000,
              f184: 0.5,
              f66: 40_000,
              f69: 0.4,
              f72: 10_000,
              f75: 0.1,
              f78: -5_000,
              f81: -0.05,
              f84: -45_000,
              f87: -0.45,
              f124: 1_700_000_000,
            },
          ],
        },
      }), { status: 200 }),
    });

    expect(result).toMatchObject({
      source: "eastmoney",
      success: true,
      rows: [
        {
          symbol: "000001.SZ",
          name: "平安银行",
          mainNetInflow: -100_000,
          superLargeNetInflow: -80_000,
          largeNetInflow: -20_000,
        },
        {
          symbol: "600519.SH",
          name: "贵州茅台",
          mainNetInflow: 50_000,
        },
      ],
    });
  });

  it("normalizes only main net inflow into portfolio quotes", () => {
    const quotes = normalizeEastmoneyFundFlowResults([{
      source: "eastmoney",
      query: "600519.SH",
      endpoint: "https://push2.eastmoney.com/api/qt/ulist.np/get",
      success: true,
      rows: [{
        symbol: "600519.SH",
        code: "600519",
        name: "贵州茅台",
        mainNetInflow: -123_000,
        raw: { 主力净流入: -123_000 },
      }],
    }]);
    expect(quotes[0]).toMatchObject({
      symbol: "600519.SH",
      mainNetInflow: -123_000,
      evidence: [expect.objectContaining({ source: "eastmoney" })],
    });
  });

  it("keeps Futu ownership of quotes and accepts only East Money main fund flow", () => {
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
    const merged = normalizePortfolioMarketData([futu], [{
      source: "eastmoney",
      query: "600519.SH",
      endpoint: "https://push2.eastmoney.com/api/qt/ulist.np/get",
      success: true,
      rows: [{
        symbol: "600519.SH",
        code: "600519",
        name: "东方财富名称不应覆盖",
        mainNetInflow: -123_000,
        raw: {
          证券简称: "东方财富名称不应覆盖",
          最新价: 9_999,
          主力净流入: -123_000,
        },
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

  it("falls back to daykline when the batch ulist endpoint fails", async () => {
    let calls = 0;
    const result = await queryEastmoneyMainFundFlow(["000001.SZ"], {
      fetchImpl: async (input) => {
        calls += 1;
        const url = String(input);
        if (url.includes("ulist.np")) {
          throw new Error("ulist unavailable");
        }
        return new Response(JSON.stringify({
          data: {
            code: "000001",
            name: "平安银行",
            klines: ["2026-09-16,23656383.0,-97023776.0,73367401.0,72745050.0,-49088667.0,2.14"],
          },
        }), { status: 200 });
      },
    });
    expect(calls).toBeGreaterThan(1);
    expect(result).toMatchObject({
      success: true,
      rows: [{
        symbol: "000001.SZ",
        name: "平安银行",
        mainNetInflow: 23_656_383,
        smallNetInflow: -97_023_776,
        mediumNetInflow: 73_367_401,
        largeNetInflow: 72_745_050,
        superLargeNetInflow: -49_088_667,
        mainNetInflowPct: 2.14,
      }],
    });
  });
});
