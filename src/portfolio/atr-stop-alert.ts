export interface AtrStopAlertState {
  atrStopLoss: number | null;
  firedAt: string | null;
}

export interface AtrStopAlertDecision {
  action: "fire" | "rearm";
  stop: number;
}

/**
 * 最新价触及或跌破 ATR 止损时只报警一次。
 * 价格回到止损价上方后清除标记，下一次再跌破才会重新报警。
 */
export function evaluateAtrStopAlert(
  state: AtrStopAlertState,
  currentPrice: number | undefined,
): AtrStopAlertDecision | null {
  if (currentPrice === undefined || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  const stop = state.atrStopLoss;
  if (stop === null || !Number.isFinite(stop) || stop <= 0) return null;
  if (currentPrice <= stop) {
    return state.firedAt ? null : { action: "fire", stop };
  }
  return state.firedAt ? { action: "rearm", stop } : null;
}
