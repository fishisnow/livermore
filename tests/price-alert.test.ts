import { describe, expect, it } from "vitest";
import { evaluatePriceAlerts, type PriceAlertLevels } from "../src/portfolio/price-alert.js";

const armed: PriceAlertLevels = {
  alertAbove: 12,
  alertBelow: 9,
  alertAboveFiredAt: null,
  alertBelowFiredAt: null,
};

describe("position price alerts", () => {
  it("fires once when price crosses a level and rearms after it returns inside the band", () => {
    expect(evaluatePriceAlerts(armed, 12)).toEqual([
      { side: "above", threshold: 12, action: "fire" },
    ]);
    expect(evaluatePriceAlerts({ ...armed, alertAboveFiredAt: "2026-08-01T00:00:00.000Z" }, 13)).toEqual([]);
    expect(evaluatePriceAlerts({ ...armed, alertAboveFiredAt: "2026-08-01T00:00:00.000Z" }, 11.5)).toEqual([
      { side: "above", threshold: 12, action: "rearm" },
    ]);
    expect(evaluatePriceAlerts(armed, 9)).toEqual([
      { side: "below", threshold: 9, action: "fire" },
    ]);
    expect(evaluatePriceAlerts({ ...armed, alertBelowFiredAt: "2026-08-01T00:00:00.000Z" }, 8)).toEqual([]);
    expect(evaluatePriceAlerts({ ...armed, alertBelowFiredAt: "2026-08-01T00:00:00.000Z" }, 9.1)).toEqual([
      { side: "below", threshold: 9, action: "rearm" },
    ]);
  });

  it("does nothing without a latest price or configured levels", () => {
    expect(evaluatePriceAlerts(armed, undefined)).toEqual([]);
    expect(evaluatePriceAlerts({
      alertAbove: null,
      alertBelow: null,
      alertAboveFiredAt: null,
      alertBelowFiredAt: null,
    }, 10)).toEqual([]);
  });
});
