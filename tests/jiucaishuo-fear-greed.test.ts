import { describe, expect, it } from "vitest";
import { classifyFearGreed, queryJiucaishuoFearGreed } from "../src/market/jiucaishuo-fear-greed.js";

describe("Jiucaishuo fear-greed index", () => {
  it("classifies the five published bands", () => {
    expect(classifyFearGreed(9.9).label).toBe("极度恐惧");
    expect(classifyFearGreed(10).label).toBe("恐惧");
    expect(classifyFearGreed(30).label).toBe("中性");
    expect(classifyFearGreed(50).label).toBe("贪婪");
    expect(classifyFearGreed(70).label).toBe("极度贪婪");
  });

  it("sorts the public series and keeps the latest reading", async () => {
    const result = await queryJiucaishuoFearGreed({
      fetchImpl: async (input) => {
        expect(String(input)).toBe("https://pre.jiucaishuo.com/v4/open-ai/kt");
        return new Response(JSON.stringify({
          code: 0,
          data: [
            { date: "2026-11-16", percent: 13.2 },
            { date: "2026-11-14", percent: 8 },
          ],
        }), { status: 200 });
      },
    });
    expect(result).toMatchObject({
      source: "jiucaishuo",
      success: true,
      latest: { date: "2026-11-16", value: 13.2, band: "fear", label: "恐惧" },
    });
    expect(result.points.map((point) => point.date)).toEqual(["2026-11-14", "2026-11-16"]);
  });

  it("reports an upstream failure without throwing", async () => {
    const result = await queryJiucaishuoFearGreed({
      fetchImpl: async () => new Response(JSON.stringify({ code: 1, message: "busy" }), { status: 200 }),
    });
    expect(result).toMatchObject({ success: false, message: "busy", points: [] });
  });
});
