import { describe, expect, it } from "vitest";
import {
  findNormalizedQuote,
  normalizeIwencaiResults,
  normalizeSecurityCode,
} from "../src/market/iwencai-normalizer.js";

describe("Iwencai market-data normalization", () => {
  it("normalizes mainland and Hong Kong security-code variants", () => {
    expect(normalizeSecurityCode("600487")).toBe("600487.SH");
    expect(normalizeSecurityCode("159558")).toBe("159558.SZ");
    expect(normalizeSecurityCode("HK00700")).toBe("00700.HK");
    expect(normalizeSecurityCode("HK07000")).toBe("07000.HK");
    expect(normalizeSecurityCode("0700.HK")).toBe("00700.HK");
    expect(normalizeSecurityCode("00700.hk")).toBe("00700.HK");
  });

  it("maps ETF and stock price aliases into stable fields", () => {
    const quotes = normalizeIwencaiResults([{
      query: "持仓行情",
      trace_id: "iwencai-trace",
      datas: [{
        基金代码: "159558.SZ",
        基金简称: "易方达中证半导体材料设备主题etf",
        基金扩位简称: "半导体设备ETF易方达",
        最新收盘价: "1.204",
        最新涨跌幅: 3.436,
        主力净买入额: -234_291_015,
        "rsi[20260727]": 50.702,
        "macd[20260727]": -0.059,
      }, {
        股票代码: "600487.SH",
        股票简称: "亨通光电",
        "收盘价:不复权[20260727]": "55.55",
        "涨跌幅:前复权[20260727]": "5.9507915",
        "主力资金流向[20260727]": "8.1564814921E8",
        "rsi买入信号(条件说明)[20260727]": "rsi买入信号",
        "macd(macd值)[20260727]": "-4.319",
      }],
    }]);

    expect(findNormalizedQuote(quotes, "159558")).toMatchObject({
      symbol: "159558.SZ",
      name: "半导体设备ETF易方达",
      currentPrice: 1.204,
      dayChangePct: 3.436,
      mainNetInflow: -234_291_015,
      rsi: 50.702,
      macd: -0.059,
    });
    expect(findNormalizedQuote(quotes, "600487")).toMatchObject({
      symbol: "600487.SH",
      name: "亨通光电",
      currentPrice: 55.55,
      dayChangePct: 5.9507915,
      mainNetInflow: 815_648_149.21,
      macd: -4.319,
    });
  });

  it("merges complementary rows for the same security", () => {
    const quotes = normalizeIwencaiResults([{
      query: "600309 收盘价 涨跌幅",
      datas: [{
        股票代码: "600309.SH",
        股票简称: "万华化学",
        最新价: "74.15",
        最新涨跌幅: 0.542373,
      }],
    }, {
      query: "600309 RSI",
      datas: [{
        股票代码: "600309.SH",
        股票简称: "万华化学",
        "rsi[20260727]": "63.866",
      }],
    }, {
      query: "600309 MACD 主力净流入",
      datas: [{
        股票代码: "600309.SH",
        "macd[20260727]": 1.59,
        "主力资金流向[20260727]": 12_530_865.14,
      }],
    }]);

    expect(findNormalizedQuote(quotes, "600309.SH")).toMatchObject({
      currentPrice: 74.15,
      dayChangePct: 0.542373,
      rsi: 63.866,
      macd: 1.59,
      mainNetInflow: 12_530_865.14,
      evidence: expect.arrayContaining([
        expect.objectContaining({ query: "600309 收盘价 涨跌幅" }),
        expect.objectContaining({ query: "600309 RSI" }),
        expect.objectContaining({ query: "600309 MACD 主力净流入" }),
      ]),
    });
  });

  it("matches a Livermore Hong Kong symbol to Iwencai's code", () => {
    const quotes = normalizeIwencaiResults([{
      datas: [{
        股票代码: "0700.HK",
        股票简称: "腾讯控股",
        最新价: "443.000",
        最新涨跌幅: 1.933,
      }],
    }]);

    expect(findNormalizedQuote(quotes, "HK00700")).toMatchObject({
      symbol: "00700.HK",
      name: "腾讯控股",
      currentPrice: 443,
      dayChangePct: 1.933,
    });
  });
});
