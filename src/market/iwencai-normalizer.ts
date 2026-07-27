import type { IwencaiQueryResult } from "./iwencai-client.js";
import {
  normalizeSecurityCode,
  type NormalizedMarketQuote,
} from "./normalized-market.js";

export {
  findNormalizedQuote,
  isMainlandSecurity,
  normalizeSecurityCode,
  toFutuSecurityCode,
  type NormalizedMarketQuote,
} from "./normalized-market.js";

const fieldAliases = {
  code: [
    /^股票代码/,
    /^基金代码/,
    /^证券代码/,
    /^指数代码/,
    /^可转债代码/,
    /代码/,
  ],
  name: [
    /^基金扩位简称/,
    /^股票简称/,
    /^基金简称/,
    /^证券简称/,
    /^指数简称/,
    /^简称/,
  ],
  currentPrice: [
    /^最新价/,
    /^最新收盘价/,
    /^现价/,
    /^收盘价/,
  ],
  dayChangePct: [
    /^最新涨跌幅/,
    /^涨跌幅/,
    /^日涨跌幅/,
  ],
  mainNetInflow: [
    /^主力净流入/,
    /^主力资金净流入/,
    /^主力资金流向/,
    /^主力净买入额/,
    /^主力资金净买入额/,
  ],
  rsi: [
    /^RSI/,
  ],
  macd: [
    /^MACD/,
  ],
} as const;

export function normalizeIwencaiResults(results: IwencaiQueryResult[]): NormalizedMarketQuote[] {
  const quotes = new Map<string, NormalizedMarketQuote>();
  for (const result of results) {
    for (const row of result.datas ?? []) {
      const rawCode = readText(row, fieldAliases.code);
      const symbol = rawCode ? normalizeSecurityCode(rawCode) : undefined;
      if (!symbol) continue;
      let quote = quotes.get(symbol);
      if (!quote) {
        quote = { symbol, evidence: [] };
        quotes.set(symbol, quote);
      }
      quote.evidence.push({
        source: "iwencai",
        ...(result.query ? { query: result.query } : {}),
        ...(result.trace_id ? { traceId: result.trace_id } : {}),
        row,
      });
      const name = readText(row, fieldAliases.name);
      const currentPrice = readNumeric(row, fieldAliases.currentPrice);
      const dayChangePct = readNumeric(row, fieldAliases.dayChangePct);
      const mainNetInflow = readNumeric(row, fieldAliases.mainNetInflow);
      const rsi = readNumeric(row, fieldAliases.rsi);
      const macd = readNumeric(row, fieldAliases.macd);
      if (quote.name === undefined && name !== undefined) quote.name = name;
      if (quote.currentPrice === undefined && currentPrice !== undefined) quote.currentPrice = currentPrice;
      if (quote.dayChangePct === undefined && dayChangePct !== undefined) quote.dayChangePct = dayChangePct;
      if (quote.mainNetInflow === undefined && mainNetInflow !== undefined) quote.mainNetInflow = mainNetInflow;
      if (quote.rsi === undefined && rsi !== undefined) quote.rsi = rsi;
      if (quote.macd === undefined && macd !== undefined) quote.macd = macd;
    }
  }
  return [...quotes.values()];
}

function readNumeric(row: Record<string, unknown>, aliases: readonly RegExp[]): number | undefined {
  for (const alias of aliases) {
    for (const [key, value] of Object.entries(row)) {
      if (!alias.test(normalizeFieldName(key))) continue;
      const parsed = parseNumeric(value);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function readText(row: Record<string, unknown>, aliases: readonly RegExp[]): string | undefined {
  for (const alias of aliases) {
    for (const [key, value] of Object.entries(row)) {
      if (!alias.test(normalizeFieldName(key)) || value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return undefined;
}

function normalizeFieldName(value: string): string {
  return value
    .toUpperCase()
    .replaceAll(/\[[^\]]*]/g, "")
    .replaceAll(/[（(][^）)]*[）)]/g, "")
    .replaceAll(/[\s_:：\-]/g, "");
}

function parseNumeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll(",", "").replace("%", "");
  if (!normalized || normalized === "—" || normalized === "-") return undefined;
  const unit = normalized.endsWith("亿") ? 100_000_000 : normalized.endsWith("万") ? 10_000 : 1;
  const parsed = Number(normalized.replace(/[万亿]$/, ""));
  return Number.isFinite(parsed) ? parsed * unit : undefined;
}
