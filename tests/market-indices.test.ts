import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { downsampleIntradaySpark, loadHoldingTrends, loadIndexTrend, loadMarketIndices } from "../src/market/portfolio-trend.js";
import { queryFutuHistoryKline, queryFutuRtData } from "../src/market/futu-client.js";
import { queryUsIndexHistory } from "../src/market/us-index-history.js";

vi.mock("../src/market/futu-client.js", () => ({ queryFutuHistoryKline: vi.fn(), queryFutuRtData: vi.fn() }));

const dates = ["2025-01-02", "2025-02-03", "2025-03-03", "2025-04-01"];
const open = [100, 110, 108, 105];
const close = [110, 108, 105, 115];
const high = [115, 120, 110, 118];
const low = [99, 107, 102, 104];
const volume = [1, 2, 3, 4];
const bars = dates.map((date, i) => ({
  date, open: open[i]!, high: high[i]!, low: low[i]!, close: close[i]!, volume: volume[i]!,
}));

function mockYahoo() {
  const request = vi.fn(async (_url: URL) => Response.json({
    chart: {
      result: [{
        timestamp: dates.map((date) => Date.parse(`${date}T14:30:00Z`) / 1000),
        indicators: { quote: [{ open, close, high, low, volume }] },
      }],
    },
  }));
  vi.stubGlobal("fetch", request);
  return request;
}

afterEach(() => vi.unstubAllGlobals());

describe("market indices", () => {
  it("loads both US indices and keeps a failed local index visible", async () => {
    const yahoo = mockYahoo();
    vi.mocked(queryFutuHistoryKline).mockImplementation(async (_config, code) => {
      if (code === "HK.800804") throw new Error("行情不可用");
      return bars;
    });
    vi.mocked(queryFutuRtData).mockImplementation(async (_config, code) => {
      if (code === "HK.800804") throw new Error("分时不可用");
      return [
        { time: "2025-04-01 09:31:00", price: 100, avgPrice: 100, volume: 1, turnover: 1 },
        { time: "2025-04-01 09:32:00", price: 101, avgPrice: 100.5, volume: 1, turnover: 1 },
        { time: "2025-04-01 09:33:00", price: 102, avgPrice: 101, volume: 1, turnover: 1 },
      ];
    });

    const indices = await loadMarketIndices(loadConfig({}));
    expect(indices.map(({ symbol }) => symbol)).toEqual([
      "US..IXIC", "US..SPX", "SH.000001", "SZ.399006", "SH.000688", "HK.800000", "HK.800700", "HK.800804",
    ]);
    expect(yahoo.mock.calls.map(([url]) => decodeURIComponent(url.pathname.split("/").at(-1)!))).toEqual(["^IXIC", "^GSPC"]);
    expect(indices[0]).toMatchObject({ date: "2025-04-01", latest: 115, dayChangePct: (115 - 105) / 105 * 100, intraday: null, intradayNote: "暂无分时" });
    const shIndex = indices.find((item) => item.symbol === "SH.000001");
    expect(shIndex && "intraday" in shIndex && shIndex.intraday).toEqual({ prices: [100, 101, 102], vwap: [100, 100.5, 101], prevClose: 100 });
    expect(indices.at(-1)).toMatchObject({ name: "恒生医疗保健指数", error: "行情不可用" });
    expect(await loadIndexTrend(loadConfig({}), "SZ.000001", "1d")).toBeUndefined();
  });

  it("attaches intraday spark to holding trend summaries", async () => {
    mockYahoo();
    vi.mocked(queryFutuHistoryKline).mockResolvedValue(bars);
    vi.mocked(queryFutuRtData).mockResolvedValue([
      { time: "2025-04-01 09:31:00", price: 10, avgPrice: 10, volume: 1, turnover: 1 },
      { time: "2025-04-01 09:32:00", price: 10.2, avgPrice: 10.1, volume: 1, turnover: 1 },
    ]);
    const trends = await loadHoldingTrends(loadConfig({}), [{
      symbol: "SH.600000",
      latestPrice: 10.2,
      lastCheckedAt: "2025-04-01T01:00:00.000Z",
    }]);
    expect(trends[0]?.intraday).toMatchObject({ prices: [10, 10.2] });
  });

  it("downsamples intraday spark points for table preview", () => {
    const prices = Array.from({ length: 200 }, (_, index) => 100 + index * 0.1);
    const vwap = prices.map((value) => value - 0.05);
    const spark = downsampleIntradaySpark(prices, vwap, 40);
    expect(spark.prices).toHaveLength(40);
    expect(spark.vwap).toHaveLength(40);
  });

  it("aggregates US monthly bars using calendar quarters and years", async () => {
    mockYahoo();
    const firstQuarter = { date: dates[0], open: 100, high: 120, low: 99, close: 105, volume: 6 };
    expect(await queryUsIndexHistory("^IXIC", "1Q", "2025-01-01", "2025-04-30")).toEqual([firstQuarter, bars[3]]);
    expect(await queryUsIndexHistory("^GSPC", "1Y", "2025-01-01", "2025-04-30")).toEqual([
      { ...firstQuarter, close: 115, volume: 10 },
    ]);
  });
});
