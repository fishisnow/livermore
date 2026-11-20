import { describe, expect, it } from "vitest";
import { matchEquityBondBand, queryJiucaishuoEquityBond, type EquityBondBand } from "../src/market/jiucaishuo-equity-bond.js";

const bands: EquityBondBand[] = [
  { id: "cold", label: "较低温", low: 3, high: 4, note: "偏便宜" },
  { id: "neutral", label: "适中", low: 2, high: 3, note: "均衡" },
];

describe("Jiucaishuo equity-bond premium", () => {
  it("keeps the colder band when a boundary belongs to two ranges", () => {
    expect(matchEquityBondBand(bands, 3)?.label).toBe("较低温");
    expect(matchEquityBondBand(bands, 2.2)?.id).toBe("neutral");
  });

  it("builds the premium series, bond yield, and equity temperature", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await queryJiucaishuoEquityBond({
      indexCode: "沪深300",
      peCategory: "gxl",
      token: "test-token",
      fetchImpl: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ url: String(input), body });
        const endpoint = String(input).split("/").at(-1);
        if (endpoint === "fed") {
          return json({
            code: 0,
            data: {
              desc: "沪深300股息率溢价=沪深300股息率-十年期国债收益率",
              new: { date: "2026-11-16", fxyj: 3.5, percent: 68.91, pjz: 3.12 },
              tuli_list: [
                { name: "较低温 (前10%-30%)", gt: 4, lte: 3 },
                { name: "适中 (前30%-70%)", gt: 3, lte: 2 },
                { name: "收盘价", color: "#999" },
              ],
              tb_data: {
                x_data: ["2026-11-14", "2026-11-13"],
                series: [
                  { name: "股息率溢价(差)", data: [3.4, 3.1] },
                  { name: "滚动平均值", data: [3.2, 3] },
                  { name: "收盘价", data: [4000, 4010] },
                ],
              },
            },
          });
        }
        if (endpoint === "zhai") return json({ code: 0, data: { new: { date: "2026-11-17", val: "1.6055" }, zq_temp: "99" } });
        return json({ code: 0, data: { temp: 24, wd_str2: "当前温度<span>较低</span>，股票多配" } });
      },
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://vip.jiucaishuo.com/gz/gz/fed",
      "https://vip.jiucaishuo.com/gz/gz/zhai",
      "https://vip.jiucaishuo.com/gz/gz/gu",
    ]);
    expect(calls[0]?.body).toMatchObject({ gu_code: "000300.SH", pe_category: "gxl", year: 10, authtoken: "test-token", type: "h5" });
    expect(result).toMatchObject({
      success: true,
      indexCode: "000300.SH",
      indexName: "沪深300",
      peCategory: "gxl",
      peLabel: "股息率风险溢价",
      formula: "沪深300股息率溢价=沪深300股息率-十年期国债收益率",
      latest: { date: "2026-11-16", value: 3.5, percentile: 68.91, mean: 3.12, band: "cold", label: "较低温" },
      bond: { date: "2026-11-17", yield: 1.6055, temperature: 99 },
      temperature: { value: 24, summary: "当前温度较低，股票多配" },
    });
    expect(result.points.map((point) => [point.date, point.value, point.mean])).toEqual([
      ["2026-11-13", 3.1, 3],
      ["2026-11-14", 3.4, 3.2],
      ["2026-11-16", 3.5, 3.12],
    ]);
  });

  it("reports an upstream failure without throwing", async () => {
    const result = await queryJiucaishuoEquityBond({
      fetchImpl: async () => json({ code: 1, message: "token expired" }),
    });
    expect(result).toMatchObject({ success: false, message: "token expired", points: [] });
  });

  it("rejects an unknown index before calling upstream", async () => {
    const result = await queryJiucaishuoEquityBond({
      indexCode: "道琼斯",
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(result).toMatchObject({ success: false, message: "不支持的指数：道琼斯" });
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
