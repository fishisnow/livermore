import type { AppConfig } from "../config.js";
import { queryFutuMarket, type FutuMarketResult } from "../market/futu-client.js";
import { normalizeSecurityCode } from "../market/normalized-market.js";

const unavailable = "未能取得该标的行情，持仓未添加。请确认 Futu OpenD 已启动并登录。";

/** 只接受添加持仓当下行情算出的止损价。巡检结果不能改写它。 */
export function readEntryAtrStop(result: FutuMarketResult, symbol: string): { atr: number; atrStopLoss: number } {
  const wanted = normalizeSecurityCode(symbol) ?? symbol.trim().toUpperCase();
  const row = result.rows.find((item) => item.symbol === wanted) ?? result.rows[0];
  if (row?.atr == null || row.atrStopLoss == null || !Number.isFinite(row.atr) || !Number.isFinite(row.atrStopLoss)) {
    throw new Error(unavailable);
  }
  return { atr: row.atr, atrStopLoss: row.atrStopLoss };
}

export async function entryAtrStop(config: AppConfig, symbol: string): Promise<{ atr: number; atrStopLoss: number }> {
  try {
    return readEntryAtrStop(await queryFutuMarket(config, [symbol]), symbol);
  } catch (error) {
    if (error instanceof Error && error.message === unavailable) throw error;
    throw new Error(unavailable);
  }
}
