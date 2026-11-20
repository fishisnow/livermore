import { describe, expect, it } from "vitest";
import { queryAshareRiseFall, riseFallHeat, summarizeRiseFall } from "../src/market/futu-rise-fall.js";

const liveRanges = [
  { type: "NEGATIVE_INFINITY", left_border: 0, right_border: -7, stock_count: 91 },
  { type: "NORMAL_RANGE", left_border: -7, right_border: -5, stock_count: 146 },
  { type: "NORMAL_RANGE", left_border: -5, right_border: -3, stock_count: 562 },
  { type: "NORMAL_RANGE", left_border: 0, right_border: 0, stock_count: 144 },
  { type: "NORMAL_RANGE", left_border: 3, right_border: 5, stock_count: 133 },
  { type: "NORMAL_RANGE", left_border: 5, right_border: 7, stock_count: 59 },
  { type: "POSITIVE_INFINITY", left_border: 7, right_border: 0, stock_count: 50 },
  { type: "RISE_LIMIT", left_border: 0, right_border: 0, stock_count: 43 },
  { type: "FALL_LIMIT", left_border: 0, right_border: 0, stock_count: 48 },
  { type: "NORMAL_RANGE", left_border: -3, right_border: 0, stock_count: 3288 },
  { type: "NORMAL_RANGE", left_border: 0, right_border: 3, stock_count: 1033 },
];

describe("A-share rise-fall distribution", () => {
  it("sums the live Futu buckets into rise, fall, and flat", () => {
    expect(summarizeRiseFall(liveRanges)).toEqual({ rise: 1318, fall: 4135, flat: 144, limitUp: 43, limitDown: 48 });
  });

  it("measures the rising share among names that moved", () => {
    expect(riseFallHeat(0, 100)).toBe(0);
    expect(riseFallHeat(50, 50)).toBe(0.5);
    expect(riseFallHeat(100, 0)).toBe(1);
    expect(riseFallHeat(0, 0)).toBe(0.5);
  });

  it("reads one distribution payload without counting a crossing bucket", async () => {
    const result = await queryAshareRiseFall({
      now: Date.parse("2026-11-18T15:00:00+08:00"),
      runImpl: async () => JSON.stringify({
        plate: "SH.LIST3000005",
        range_list: [
          ...liveRanges,
          { type: "NORMAL_RANGE", left_border: -1, right_border: 1, stock_count: 9 },
        ],
      }),
    });
    expect(result).toMatchObject({
      source: "futuapi",
      success: true,
      plate: "SH.LIST3000005",
      date: "2026-11-18",
      rise: 1318,
      fall: 4135,
      flat: 144,
      limitUp: 43,
      limitDown: 48,
      total: 5597,
    });
    expect(result.heat).toBeCloseTo(1318 / 5453);
  });

  it("reports a script failure without throwing", async () => {
    const result = await queryAshareRiseFall({
      runImpl: async () => { throw new Error("OpenD 未连接"); },
    });
    expect(result).toEqual({ source: "futuapi", name: "大A涨跌家数", success: false, message: "OpenD 未连接" });
  });
});
