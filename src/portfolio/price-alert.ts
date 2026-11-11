export interface PriceAlertLevels {
  alertAbove: number | null;
  alertBelow: number | null;
  alertAboveFiredAt: string | null;
  alertBelowFiredAt: string | null;
}

export interface PriceAlertDecision {
  side: "above" | "below";
  threshold: number;
  action: "fire" | "rearm";
}

/**
 * 价格在区间外只提醒一次。回到区间内后清除触发标记，下一次再次越界才会重新提醒。
 */
export function evaluatePriceAlerts(
  levels: PriceAlertLevels,
  currentPrice: number | undefined,
): PriceAlertDecision[] {
  if (currentPrice === undefined || !Number.isFinite(currentPrice)) return [];
  const decisions: PriceAlertDecision[] = [];
  if (isPrice(levels.alertAbove)) {
    if (currentPrice >= levels.alertAbove) {
      if (!levels.alertAboveFiredAt) decisions.push({ side: "above", threshold: levels.alertAbove, action: "fire" });
    } else if (levels.alertAboveFiredAt) {
      decisions.push({ side: "above", threshold: levels.alertAbove, action: "rearm" });
    }
  }
  if (isPrice(levels.alertBelow)) {
    if (currentPrice <= levels.alertBelow) {
      if (!levels.alertBelowFiredAt) decisions.push({ side: "below", threshold: levels.alertBelow, action: "fire" });
    } else if (levels.alertBelowFiredAt) {
      decisions.push({ side: "below", threshold: levels.alertBelow, action: "rearm" });
    }
  }
  return decisions;
}

function isPrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}
