import { setDefaultResultOrder } from "node:dns";
import { isMainlandSecurity, normalizeSecurityCode } from "./normalized-market.js";
import type { NormalizedMarketQuote } from "./normalized-market.js";

// East Money often rejects or drops Node's IPv6 connections.
setDefaultResultOrder("ipv4first");

const EASTMONEY_ULIST_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const EASTMONEY_CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get";
const EASTMONEY_DAYKLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get";
const EASTMONEY_A_SHARE_FS = "m:0+t:6+f:!2,m:0+t:13+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2";
const EASTMONEY_CLIST_UT = "b2884a393a59ad64002292a3e90d46a5";
const EASTMONEY_REFERER = "https://data.eastmoney.com/zjlx/detail.html";
const EASTMONEY_FIELDS = [
  "f12", // code
  "f14", // name
  "f62", // 主力净流入
  "f184", // 主力净占比%
  "f66", // 超大单净流入
  "f69", // 超大单净占比%
  "f72", // 大单净流入
  "f75", // 大单净占比%
  "f78", // 中单净流入
  "f81", // 中单净占比%
  "f84", // 小单净流入
  "f87", // 小单净占比%
  "f124", // 更新时间戳（秒）
].join(",");

export interface EastmoneyFundFlowRow {
  symbol: string;
  code: string;
  name?: string;
  mainNetInflow?: number;
  mainNetInflowPct?: number;
  superLargeNetInflow?: number;
  superLargeNetInflowPct?: number;
  largeNetInflow?: number;
  largeNetInflowPct?: number;
  mediumNetInflow?: number;
  mediumNetInflowPct?: number;
  smallNetInflow?: number;
  smallNetInflowPct?: number;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

export interface EastmoneyFundFlowResult {
  source: "eastmoney";
  query: string;
  endpoint: string;
  success: boolean;
  message?: string;
  rows: EastmoneyFundFlowRow[];
}

export type EastmoneyMainFundFlowRankDirection = "inflow" | "outflow";

export interface EastmoneyMainFundFlowRankRow {
  rank: number;
  symbol: string;
  code: string;
  name?: string;
  price?: number;
  changePct?: number;
  mainNetInflow?: number;
  mainNetInflowPct?: number;
  superLargeNetInflow?: number;
  largeNetInflow?: number;
  updatedAt?: string;
}

export interface EastmoneyMainFundFlowRankResult {
  source: "eastmoney";
  endpoint: string;
  market: "沪深A股";
  direction: EastmoneyMainFundFlowRankDirection;
  amountUnit: "CNY";
  success: boolean;
  message?: string;
  total?: number;
  rows: EastmoneyMainFundFlowRankRow[];
}

interface EastmoneyUlistResponse {
  data?: {
    total?: number;
    diff?: Array<Record<string, unknown>> | Record<string, Record<string, unknown>>;
  } | null;
}

interface EastmoneyDayKlineResponse {
  data?: {
    code?: string;
    name?: string;
    klines?: string[];
  } | null;
}

export function toEastmoneySecId(symbol: string): string | undefined {
  const normalized = normalizeSecurityCode(symbol);
  if (!normalized || !isMainlandSecurity(normalized)) return undefined;
  const [code, exchange] = normalized.split(".");
  if (!code || !exchange) return undefined;
  if (exchange === "SH") return `1.${code}`;
  // SZ / BJ share the 0. prefix on East Money fund-flow endpoints.
  return `0.${code}`;
}

export async function queryEastmoneyMainFundFlow(
  symbols: string[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<EastmoneyFundFlowResult> {
  const unique = [...new Set(symbols.map((symbol) => normalizeSecurityCode(symbol) ?? symbol.trim().toUpperCase()))]
    .filter(Boolean);
  const query = unique.join(",");
  const secids = unique.map((symbol) => {
    const secid = toEastmoneySecId(symbol);
    if (!secid) throw new Error(`Only mainland SH/SZ/BJ symbols are allowed: ${symbol}`);
    return { symbol, secid };
  });
  if (secids.length === 0) {
    return {
      source: "eastmoney",
      query,
      endpoint: EASTMONEY_ULIST_URL,
      success: true,
      rows: [],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const batch = await queryUlistBatch(secids, fetchImpl);
  if (batch.success && batch.rows.length > 0) return { ...batch, query };

  const fallbackRows: EastmoneyFundFlowRow[] = [];
  const errors: string[] = [];
  for (const item of secids) {
    const day = await queryDayKline(item.symbol, item.secid, fetchImpl);
    if (day.row) fallbackRows.push(day.row);
    else if (day.message) errors.push(`${item.symbol}: ${day.message}`);
  }
  if (fallbackRows.length > 0) {
    return {
      source: "eastmoney",
      query,
      endpoint: EASTMONEY_DAYKLINE_URL,
      success: true,
      ...(batch.message || errors.length > 0
        ? { message: [batch.message, ...errors].filter(Boolean).join("; ") }
        : {}),
      rows: fallbackRows,
    };
  }

  return {
    source: "eastmoney",
    query,
    endpoint: batch.endpoint,
    success: false,
    message: batch.message || errors.join("; ") || "East Money returned no fund-flow rows.",
    rows: [],
  };
}

export async function queryEastmoneyMainFundFlowRank(
  options: { direction: EastmoneyMainFundFlowRankDirection; limit?: number; fetchImpl?: typeof fetch },
): Promise<EastmoneyMainFundFlowRankResult> {
  if (options.direction !== "inflow" && options.direction !== "outflow") {
    throw new Error("direction must be inflow or outflow.");
  }
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("limit must be an integer from 1 to 50.");
  }
  const url = new URL(EASTMONEY_CLIST_URL);
  url.searchParams.set("fid", "f62");
  url.searchParams.set("po", options.direction === "inflow" ? "1" : "0");
  url.searchParams.set("pz", String(limit));
  url.searchParams.set("pn", "1");
  url.searchParams.set("np", "1");
  url.searchParams.set("fltt", "2");
  url.searchParams.set("invt", "2");
  url.searchParams.set("ut", EASTMONEY_CLIST_UT);
  url.searchParams.set("fs", EASTMONEY_A_SHARE_FS);
  url.searchParams.set("fields", "f12,f14,f2,f3,f62,f184,f66,f72,f124");
  const payload = await fetchJson<EastmoneyUlistResponse>(url, options.fetchImpl ?? fetch, 2);
  if (!payload.ok) {
    return {
      source: "eastmoney",
      endpoint: EASTMONEY_CLIST_URL,
      market: "沪深A股",
      direction: options.direction,
      amountUnit: "CNY",
      success: false,
      message: payload.message,
      rows: [],
    };
  }
  const total = numericValue(payload.value.data?.total);
  return {
    source: "eastmoney",
    endpoint: EASTMONEY_CLIST_URL,
    market: "沪深A股",
    direction: options.direction,
    amountUnit: "CNY",
    success: true,
    ...(total === undefined ? {} : { total }),
    rows: parseEastmoneyRankRows(payload.value),
  };
}

export function normalizeEastmoneyFundFlowResults(
  results: EastmoneyFundFlowResult[],
): NormalizedMarketQuote[] {
  const quotes = new Map<string, NormalizedMarketQuote>();
  for (const result of results) {
    for (const row of result.rows) {
      if (!/\.(SH|SZ|BJ)$/.test(row.symbol)) continue;
      let quote = quotes.get(row.symbol);
      if (!quote) {
        quote = { symbol: row.symbol, evidence: [] };
        quotes.set(row.symbol, quote);
      }
      quote.evidence.push({
        source: "eastmoney",
        query: result.query,
        row: row.raw,
      });
      if (quote.name === undefined && row.name) quote.name = row.name;
      if (quote.mainNetInflow === undefined && row.mainNetInflow !== undefined) {
        quote.mainNetInflow = row.mainNetInflow;
      }
    }
  }
  return [...quotes.values()];
}

async function queryUlistBatch(
  secids: Array<{ symbol: string; secid: string }>,
  fetchImpl: typeof fetch,
): Promise<EastmoneyFundFlowResult> {
  const url = new URL(EASTMONEY_ULIST_URL);
  url.searchParams.set("fltt", "2");
  url.searchParams.set("secids", secids.map((item) => item.secid).join(","));
  url.searchParams.set("fields", EASTMONEY_FIELDS);
  url.searchParams.set("_", String(Date.now()));

  const payload = await fetchJson<EastmoneyUlistResponse>(url, fetchImpl);
  if (!payload.ok) {
    return {
      source: "eastmoney",
      query: secids.map((item) => item.symbol).join(","),
      endpoint: url.toString(),
      success: false,
      message: payload.message,
      rows: [],
    };
  }

  const rows = parseEastmoneyRows(payload.value);
  return {
    source: "eastmoney",
    query: secids.map((item) => item.symbol).join(","),
    endpoint: url.toString(),
    success: true,
    ...(rows.length === 0 ? { message: "East Money ulist returned no fund-flow rows." } : {}),
    rows,
  };
}

async function queryDayKline(
  symbol: string,
  secid: string,
  fetchImpl: typeof fetch,
): Promise<{ row?: EastmoneyFundFlowRow; message?: string }> {
  const url = new URL(EASTMONEY_DAYKLINE_URL);
  url.searchParams.set("lmt", "1");
  url.searchParams.set("klt", "101");
  url.searchParams.set("secid", secid);
  url.searchParams.set("fields1", "f1,f2,f3,f7");
  // f51 date, f52 main, f53 small, f54 medium, f55 large, f56 super, f57 main pct
  url.searchParams.set("fields2", "f51,f52,f53,f54,f55,f56,f57");
  url.searchParams.set("_", String(Date.now()));

  const payload = await fetchJson<EastmoneyDayKlineResponse>(url, fetchImpl);
  if (!payload.ok) return { message: payload.message };
  const latest = payload.value.data?.klines?.at(-1);
  if (!latest) return { message: "East Money daykline returned no bars." };
  const parts = latest.split(",");
  const mainNetInflow = numericValue(parts[1]);
  const smallNetInflow = numericValue(parts[2]);
  const mediumNetInflow = numericValue(parts[3]);
  const largeNetInflow = numericValue(parts[4]);
  const superLargeNetInflow = numericValue(parts[5]);
  const mainNetInflowPct = numericValue(parts[6]);
  const code = symbol.split(".")[0]!;
  const name = textValue(payload.value.data?.name);
  return {
    row: {
      symbol,
      code,
      ...(name ? { name } : {}),
      ...(mainNetInflow === undefined ? {} : { mainNetInflow }),
      ...(mainNetInflowPct === undefined ? {} : { mainNetInflowPct }),
      ...(superLargeNetInflow === undefined ? {} : { superLargeNetInflow }),
      ...(largeNetInflow === undefined ? {} : { largeNetInflow }),
      ...(mediumNetInflow === undefined ? {} : { mediumNetInflow }),
      ...(smallNetInflow === undefined ? {} : { smallNetInflow }),
      raw: {
        证券代码: symbol,
        证券简称: name,
        日期: parts[0],
        主力净流入: mainNetInflow,
        主力净占比: mainNetInflowPct,
        超大单净流入: superLargeNetInflow,
        大单净流入: largeNetInflow,
        中单净流入: mediumNetInflow,
        小单净流入: smallNetInflow,
        source: "eastmoney",
        endpoint: "data.eastmoney.com/zjlx",
      },
    },
  };
}

async function fetchJson<T>(
  url: URL,
  fetchImpl: typeof fetch,
  attempts = 3,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  let lastError = "East Money request failed";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Livermore/0.1; +local)",
          Referer: EASTMONEY_REFERER,
          Accept: "application/json,text/plain,*/*",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        lastError = `East Money fund-flow HTTP ${response.status}`;
      } else {
        return { ok: true, value: await response.json() as T };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < attempts) await sleep(250 * (attempt + 1));
  }
  return { ok: false, message: lastError };
}

function parseEastmoneyRows(payload: EastmoneyUlistResponse): EastmoneyFundFlowRow[] {
  const diff = payload.data?.diff;
  const items = Array.isArray(diff)
    ? diff
    : diff && typeof diff === "object"
      ? Object.values(diff)
      : [];
  const rows: EastmoneyFundFlowRow[] = [];
  for (const item of items) {
    const code = textValue(item.f12);
    if (!code) continue;
    const symbol = normalizeSecurityCode(code);
    if (!symbol || !isMainlandSecurity(symbol)) continue;
    const name = textValue(item.f14);
    const mainNetInflow = numericValue(item.f62);
    const mainNetInflowPct = numericValue(item.f184);
    const superLargeNetInflow = numericValue(item.f66);
    const superLargeNetInflowPct = numericValue(item.f69);
    const largeNetInflow = numericValue(item.f72);
    const largeNetInflowPct = numericValue(item.f75);
    const mediumNetInflow = numericValue(item.f78);
    const mediumNetInflowPct = numericValue(item.f81);
    const smallNetInflow = numericValue(item.f84);
    const smallNetInflowPct = numericValue(item.f87);
    const updatedAt = timestampValue(item.f124);
    rows.push({
      symbol,
      code,
      ...(name ? { name } : {}),
      ...(mainNetInflow === undefined ? {} : { mainNetInflow }),
      ...(mainNetInflowPct === undefined ? {} : { mainNetInflowPct }),
      ...(superLargeNetInflow === undefined ? {} : { superLargeNetInflow }),
      ...(superLargeNetInflowPct === undefined ? {} : { superLargeNetInflowPct }),
      ...(largeNetInflow === undefined ? {} : { largeNetInflow }),
      ...(largeNetInflowPct === undefined ? {} : { largeNetInflowPct }),
      ...(mediumNetInflow === undefined ? {} : { mediumNetInflow }),
      ...(mediumNetInflowPct === undefined ? {} : { mediumNetInflowPct }),
      ...(smallNetInflow === undefined ? {} : { smallNetInflow }),
      ...(smallNetInflowPct === undefined ? {} : { smallNetInflowPct }),
      ...(updatedAt ? { updatedAt } : {}),
      raw: {
        证券代码: symbol,
        证券简称: name,
        主力净流入: mainNetInflow,
        主力净占比: mainNetInflowPct,
        超大单净流入: superLargeNetInflow,
        超大单净占比: superLargeNetInflowPct,
        大单净流入: largeNetInflow,
        大单净占比: largeNetInflowPct,
        中单净流入: mediumNetInflow,
        中单净占比: mediumNetInflowPct,
        小单净流入: smallNetInflow,
        小单净占比: smallNetInflowPct,
        更新时间: updatedAt,
        source: "eastmoney",
        endpoint: "data.eastmoney.com/zjlx",
      },
    });
  }
  return rows;
}

function parseEastmoneyRankRows(payload: EastmoneyUlistResponse): EastmoneyMainFundFlowRankRow[] {
  const diff = payload.data?.diff;
  const items = Array.isArray(diff) ? diff : diff && typeof diff === "object" ? Object.values(diff) : [];
  const rows: EastmoneyMainFundFlowRankRow[] = [];
  for (const item of items) {
    const code = textValue(item.f12);
    if (!code) continue;
    const symbol = normalizeSecurityCode(code) ?? code;
    const name = textValue(item.f14);
    const price = numericValue(item.f2);
    const changePct = numericValue(item.f3);
    const mainNetInflow = numericValue(item.f62);
    const mainNetInflowPct = numericValue(item.f184);
    const superLargeNetInflow = numericValue(item.f66);
    const largeNetInflow = numericValue(item.f72);
    const updatedAt = timestampValue(item.f124);
    rows.push({
      rank: rows.length + 1,
      symbol,
      code,
      ...(name ? { name } : {}),
      ...(price === undefined ? {} : { price }),
      ...(changePct === undefined ? {} : { changePct }),
      ...(mainNetInflow === undefined ? {} : { mainNetInflow }),
      ...(mainNetInflowPct === undefined ? {} : { mainNetInflowPct }),
      ...(superLargeNetInflow === undefined ? {} : { superLargeNetInflow }),
      ...(largeNetInflow === undefined ? {} : { largeNetInflow }),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  return rows;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll(",", "");
  if (!normalized || normalized === "-" || normalized === "—") return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function timestampValue(value: unknown): string | undefined {
  const seconds = numericValue(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
