import { describe, expect, it } from "vitest";
import { evaluateAtrStopAlert } from "../src/portfolio/atr-stop-alert.js";

describe("ATR stop alerts", () => {
  const armed = { atrStopLoss: 1431, firedAt: null };

  it("fires once when price touches the stop and rearms after it recovers", () => {
    expect(evaluateAtrStopAlert(armed, 1431)).toEqual({ action: "fire", stop: 1431 });
    expect(evaluateAtrStopAlert({ atrStopLoss: 1431, firedAt: "2026-11-20T00:00:00.000Z" }, 1400)).toBeNull();
    expect(evaluateAtrStopAlert({ atrStopLoss: 1431, firedAt: "2026-11-20T00:00:00.000Z" }, 1431.1)).toEqual({
      action: "rearm",
      stop: 1431,
    });
    expect(evaluateAtrStopAlert(armed, 1500)).toBeNull();
  });

  it("does nothing without a price or a stop", () => {
    expect(evaluateAtrStopAlert(armed, undefined)).toBeNull();
    expect(evaluateAtrStopAlert({ atrStopLoss: null, firedAt: null }, 10)).toBeNull();
    expect(evaluateAtrStopAlert(armed, 0)).toBeNull();
  });
});
