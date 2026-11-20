import type { AppConfig } from "../config.js";
import { ATR_STOP_MULTIPLIER, portfolioAtrStop } from "../market/atr.js";
import { queryFutuMarket, type FutuMarketResult } from "../market/futu-client.js";
import { normalizeSecurityCode } from "../market/normalized-market.js";

const unavailable = "未能取得该标的行情，持仓未添加。请确认 Futu OpenD 已启动并登录。";

/** 添加持仓时用当前倍数先算一版；之后每次巡检按最新价和最新 ATR 重算。 */
export function readEntryAtrStop(
  result: FutuMarketResult,
  symbol: string,
  multiplier = ATR_STOP_MULTIPLIER,
): { atr: number; atrStopLoss: number } {
  const wanted = normalizeSecurityCode(symbol) ?? symbol.trim().toUpperCase();
  const row = result.rows.find((item) => item.symbol === wanted) ?? result.rows[0];
  const stop = row?.atr == null || row.currentPrice == null ? null : portfolioAtrStop(row.currentPrice, row.atr, multiplier);
  if (row?.atr == null || stop == null) throw new Error(unavailable);
  return { atr: row.atr, atrStopLoss: stop };
}

export async function entryAtrStop(
  config: AppConfig,
  symbol: string,
  multiplier = ATR_STOP_MULTIPLIER,
): Promise<{ atr: number; atrStopLoss: number }> {
  try {
    return readEntryAtrStop(await queryFutuMarket(config, [symbol]), symbol, multiplier);
  } catch (error) {
    if (error instanceof Error && error.message === unavailable) throw error;
    throw new Error(unavailable);
  }
}
