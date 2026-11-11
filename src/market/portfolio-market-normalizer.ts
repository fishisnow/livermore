import type { FutuMarketResult } from "./futu-client.js";
import { normalizeFutuResult } from "./futu-client.js";
import {
  normalizeEastmoneyFundFlowResults,
  type EastmoneyFundFlowResult,
} from "./eastmoney-fund-flow.js";
import type { NormalizedMarketQuote } from "./normalized-market.js";

/**
 * Field ownership is deliberately strict:
 * - Futu owns name, latest price, day change, RSI and MACD for every supported holding.
 * - East Money contributes only main net inflow and only for mainland securities.
 *
 * Keeping this merge deterministic prevents an Agent answer or an unexpected
 * fund-flow column from overwriting the Futu quote used by risk calculations.
 */
export function normalizePortfolioMarketData(
  futuResults: FutuMarketResult[],
  fundFlowResults: EastmoneyFundFlowResult[],
): NormalizedMarketQuote[] {
  const merged = new Map<string, NormalizedMarketQuote>();
  for (const result of futuResults) {
    for (const quote of normalizeFutuResult(result)) {
      const existing = merged.get(quote.symbol);
      if (!existing) {
        merged.set(quote.symbol, quote);
        continue;
      }
      if (existing.name === undefined && quote.name !== undefined) existing.name = quote.name;
      if (existing.currentPrice === undefined && quote.currentPrice !== undefined) {
        existing.currentPrice = quote.currentPrice;
      }
      if (existing.dayChangePct === undefined && quote.dayChangePct !== undefined) {
        existing.dayChangePct = quote.dayChangePct;
      }
      if (existing.rsi === undefined && quote.rsi !== undefined) existing.rsi = quote.rsi;
      if (existing.macd === undefined && quote.macd !== undefined) existing.macd = quote.macd;
      if (existing.atr === undefined && quote.atr !== undefined) existing.atr = quote.atr;
      if (existing.atrStopLoss === undefined && quote.atrStopLoss !== undefined) {
        existing.atrStopLoss = quote.atrStopLoss;
      }
      existing.evidence.push(...quote.evidence);
    }
  }

  for (const quote of normalizeEastmoneyFundFlowResults(fundFlowResults)) {
    if (!/\.(SH|SZ|BJ)$/.test(quote.symbol)) continue;
    const existing = merged.get(quote.symbol);
    if (!existing || quote.mainNetInflow === undefined) continue;
    existing.mainNetInflow = quote.mainNetInflow;
    existing.evidence.push(...quote.evidence);
  }
  return [...merged.values()];
}
