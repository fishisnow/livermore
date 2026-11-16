import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { computeNationalTeamSeries, queryNationalTeamFlow, sharesFromSseResult, sharesFromSzseWorkbook } from "../src/market/national-team-etf-flow.js";

describe("national team ETF net flow", () => {
  it("converts Shanghai lots of 10,000 shares and ignores funds outside the basket", () => {
    expect(sharesFromSseResult([
      { SEC_CODE: "510300", TOT_VOL: "10000" },
      { SEC_CODE: "999999", TOT_VOL: "1" },
    ])).toEqual({ "510300": 100_000_000 });
  });

  it("reads Shenzhen share counts in shares, not lots", () => {
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>日期</t></is></c><c r="B1" t="inlineStr"><is><t>基金代码</t></is></c><c r="C1" t="inlineStr"><is><t>基金简称</t></is></c><c r="D1" t="inlineStr"><is><t>基金规模(份)</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>2026-11-13</t></is></c><c r="B2" t="inlineStr"><is><t>159919</t></is></c><c r="C2" t="inlineStr"><is><t>沪深300ETF嘉实</t></is></c><c r="D2" t="inlineStr"><is><t>200000000.00</t></is></c></row>
      </sheetData></worksheet>`;
    expect(sharesFromSzseWorkbook(zipStored({ "xl/worksheets/sheet1.xml": sheet }))).toEqual({
      "20261113": { "159919": 200_000_000 },
    });
  });

  it("sums share changes times NAV and drops a session until both exchanges have reported", () => {
    const points = computeNationalTeamSeries({
      "20261112": { "510300": 100_000_000, "159919": 100_000_000 },
      "20261113": { "510300": 200_000_000, "159919": 100_000_000 },
      "20261116": { "510300": 300_000_000 },
    }, {
      "510300": { "20261112": 1, "20261113": 1, "20261116": 1 },
      "159919": { "20261112": 1, "20261113": 1 },
    });
    expect(points).toEqual([{ date: "2026-11-13", value: 1, label: "净买入" }]);
  });

  it("treats a reverse split as zero flow", () => {
    const points = computeNationalTeamSeries({
      "20261112": { "510300": 200_000_000, "159919": 100_000_000 },
      "20261113": { "510300": 100_000_000, "159919": 100_000_000 },
    }, {
      "510300": { "20261112": 1, "20261113": 2 },
      "159919": { "20261112": 1, "20261113": 1 },
    });
    expect(points).toEqual([{ date: "2026-11-13", value: 0, label: "持平" }]);
  });

  it("builds the daily total from the exchange and East Money responses", async () => {
    const now = Date.parse("2026-11-14T01:00:00+08:00");
    const result = await queryNationalTeamFlow({
      now,
      historyDays: 4,
      cacheFile: null,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("query.sse.com.cn")) {
          const date = new URL(url).searchParams.get("STAT_DATE");
          const lots = date === "2026-11-13" ? "20000" : "10000";
          return json({ result: [{ SEC_CODE: "510300", TOT_VOL: lots }] });
        }
        if (url.includes("szse.cn")) {
          const sheet = `<?xml version="1.0"?><worksheet><sheetData>
            <row><c r="A1" t="inlineStr"><is><t>日期</t></is></c><c r="B1" t="inlineStr"><is><t>基金代码</t></is></c><c r="D1" t="inlineStr"><is><t>基金规模(份)</t></is></c></row>
            <row><c r="A2" t="inlineStr"><is><t>2026-11-12</t></is></c><c r="B2" t="inlineStr"><is><t>159919</t></is></c><c r="D2" t="inlineStr"><is><t>100000000</t></is></c></row>
            <row><c r="A3" t="inlineStr"><is><t>2026-11-13</t></is></c><c r="B3" t="inlineStr"><is><t>159919</t></is></c><c r="D3" t="inlineStr"><is><t>100000000</t></is></c></row>
            </sheetData></worksheet>`;
          return new Response(new Uint8Array(zipStored({ "xl/worksheets/sheet1.xml": sheet })));
        }
        return json({ Data: { LSJZList: [{ FSRQ: "2026-11-12", DWJZ: "1" }, { FSRQ: "2026-11-13", DWJZ: "1" }] } });
      },
    });
    expect(result.success).toBe(true);
    expect(result.latest).toEqual({ date: "2026-11-13", value: 1, label: "净买入" });
    expect(result.asOf).toBe("2026-11-13");
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function zipStored(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, data]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(text), 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
