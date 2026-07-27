export type MarketDataSource = "futuapi" | "iwencai";

export interface NormalizedMarketEvidence {
  source: MarketDataSource;
  query?: string;
  traceId?: string;
  row: Record<string, unknown>;
}

export interface NormalizedMarketQuote {
  symbol: string;
  name?: string;
  currentPrice?: number;
  dayChangePct?: number;
  mainNetInflow?: number;
  rsi?: number;
  macd?: number;
  evidence: NormalizedMarketEvidence[];
}

export function findNormalizedQuote(
  quotes: NormalizedMarketQuote[],
  requestedSymbol: string,
): NormalizedMarketQuote | undefined {
  const symbol = normalizeSecurityCode(requestedSymbol);
  return symbol ? quotes.find((quote) => quote.symbol === symbol) : undefined;
}

export function normalizeSecurityCode(value: string): string | undefined {
  const compact = value.trim().toUpperCase().replaceAll(/\s+/g, "");
  if (!compact) return undefined;
  const prefixed = compact.match(/^(SH|SZ|BJ|HK)[.:\-]?(\d+)$/);
  if (prefixed) return canonicalCode(prefixed[2]!, prefixed[1]!);
  const suffixed = compact.match(/^(\d+)[.:\-]?(SH|SZ|BJ|HK)$/);
  if (suffixed) return canonicalCode(suffixed[1]!, suffixed[2]!);
  if (!/^\d+$/.test(compact)) return compact;
  if (compact.length === 5) return `${compact}.HK`;
  if (compact.length !== 6) return compact;
  const exchange = inferMainlandExchange(compact);
  return exchange ? `${compact}.${exchange}` : compact;
}

export function isMainlandSecurity(value: string): boolean {
  return /\.(SH|SZ|BJ)$/.test(normalizeSecurityCode(value) ?? "");
}

export function toFutuSecurityCode(value: string): string | undefined {
  const normalized = normalizeSecurityCode(value);
  if (!normalized) return undefined;
  const match = normalized.match(/^(\d+)\.(SH|SZ|HK)$/);
  return match ? `${match[2]}.${match[1]}` : undefined;
}

function canonicalCode(digits: string, exchange: string): string {
  if (exchange === "HK") {
    const significant = digits.replace(/^0+/, "") || "0";
    return `${significant.padStart(5, "0")}.HK`;
  }
  return `${digits.padStart(6, "0")}.${exchange}`;
}

function inferMainlandExchange(code: string): "SH" | "SZ" | "BJ" | undefined {
  if (/^[569]/.test(code)) return "SH";
  if (/^[0123]/.test(code)) return "SZ";
  if (/^[48]/.test(code)) return "BJ";
  return undefined;
}
