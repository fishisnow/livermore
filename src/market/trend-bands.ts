export interface TrendBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TrendDirection = "up" | "down" | "flat";
export type Ma5Position = "above" | "below";

export interface TrendChartModel {
  dates: string[];
  candles: Array<[number, number, number, number]>;
  volumes: number[];
  ma5: Array<number | null>;
  ma10: Array<number | null>;
  ma20: Array<number | null>;
  shortA: Array<number | null>;
  shortB: Array<number | null>;
  longA: Array<number | null>;
  longB: Array<number | null>;
  shortAUp: Array<number | null>;
  shortADown: Array<number | null>;
  shortBUp: Array<number | null>;
  shortBDown: Array<number | null>;
  longAUp: Array<number | null>;
  longADown: Array<number | null>;
  longBUp: Array<number | null>;
  longBDown: Array<number | null>;
  shortStickUp: Array<[string, number, number]>;
  shortStickDown: Array<[string, number, number]>;
  shortStickFlat: Array<[string, number, number]>;
  longStickUp: Array<[string, number, number]>;
  longStickDown: Array<[string, number, number]>;
  longStickFlat: Array<[string, number, number]>;
  direction: TrendDirection | null;
  ma5Position: Ma5Position | null;
}

export function buildTrendChart(bars: TrendBar[]): TrendChartModel {
  const dates = bars.map((bar) => bar.date);
  const candles = bars.map((bar) => [bar.open, bar.close, bar.low, bar.high] as [number, number, number, number]);
  const volumes = bars.map((bar) => bar.volume);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const ma5 = movingAverage(bars, 5);
  const shortA = ema(highs, 24);
  const shortB = ema(lows, 23);
  const longA = ema(highs, 89);
  const longB = ema(lows, 90);
  const shortUp: boolean[] = [];
  const shortDown: boolean[] = [];
  const shortFlat: boolean[] = [];
  const shortInside: boolean[] = [];
  const shortOrdered: boolean[] = [];
  const longUp: boolean[] = [];
  const longDown: boolean[] = [];
  const longFlat: boolean[] = [];
  const longInside: boolean[] = [];
  const longOrdered: boolean[] = [];

  for (let index = 0; index < bars.length; index += 1) {
    const close = bars[index]?.close ?? null;
    const shortState = bandState(close, shortA[index] ?? null, shortB[index] ?? null, index > 0 ? shortA[index - 1] ?? null : null, index > 0 ? shortB[index - 1] ?? null : null);
    shortOrdered.push(shortState.ordered);
    shortInside.push(shortState.inside);
    shortUp.push(shortState.up);
    shortDown.push(shortState.down);
    shortFlat.push(shortState.flat);
    const longState = bandState(close, longA[index] ?? null, longB[index] ?? null, index > 0 ? longA[index - 1] ?? null : null, index > 0 ? longB[index - 1] ?? null : null);
    longOrdered.push(longState.ordered);
    longInside.push(longState.inside);
    longUp.push(longState.up);
    longDown.push(longState.down);
    longFlat.push(longState.flat);
  }

  return {
    dates,
    candles,
    volumes,
    ma5,
    ma10: movingAverage(bars, 10),
    ma20: movingAverage(bars, 20),
    shortA,
    shortB,
    longA,
    longB,
    shortAUp: mask(shortA, shortUp),
    shortADown: mask(shortA, shortDown),
    shortBUp: mask(shortB, shortUp),
    shortBDown: mask(shortB, shortDown),
    longAUp: mask(longA, longUp),
    longADown: mask(longA, longDown),
    longBUp: mask(longB, longUp),
    longBDown: mask(longB, longDown),
    shortStickUp: sticks(dates, shortA, shortB, shortOrdered, shortInside, shortUp),
    shortStickDown: sticks(dates, shortA, shortB, shortOrdered, shortInside, shortDown),
    shortStickFlat: sticks(dates, shortA, shortB, shortOrdered, shortInside, shortFlat),
    longStickUp: sticks(dates, longA, longB, longOrdered, longInside, longUp),
    longStickDown: sticks(dates, longA, longB, longOrdered, longInside, longDown),
    longStickFlat: sticks(dates, longA, longB, longOrdered, longInside, longFlat),
    direction: compareBands(shortA.at(-1), shortB.at(-1), longA.at(-1), longB.at(-1)),
    ma5Position: candleBodyPosition(bars.at(-1), ma5.at(-1)),
  };
}

function candleBodyPosition(bar: TrendBar | undefined, average: number | null | undefined): Ma5Position | null {
  if (!bar || average == null) return null;
  if (bar.open > average && bar.close > average) return "above";
  if (bar.open < average && bar.close < average) return "below";
  return null;
}

function bandState(
  close: number | null,
  upper: number | null,
  lower: number | null,
  previousUpper: number | null,
  previousLower: number | null,
): { ordered: boolean; inside: boolean; up: boolean; down: boolean; flat: boolean } {
  const ready = upper !== null && lower !== null && close !== null;
  const ordered = ready && upper > lower;
  const inside = ready && close < upper && close > lower;
  const comparable = ready && previousUpper !== null && previousLower !== null;
  const up = comparable && upper > previousUpper && lower > previousLower;
  const down = comparable && upper < previousUpper && lower < previousLower;
  const flat = ready && !up && !down;
  return { ordered, inside, up, down, flat };
}

function compareBands(
  shortA: number | null | undefined,
  shortB: number | null | undefined,
  longA: number | null | undefined,
  longB: number | null | undefined,
): TrendDirection | null {
  if (shortA == null || shortB == null || longA == null || longB == null) return null;
  if (Math.min(shortA, shortB) > Math.max(longA, longB)) return "up";
  if (Math.max(shortA, shortB) < Math.min(longA, longB)) return "down";
  return "flat";
}

function ema(values: number[], period: number): Array<number | null> {
  const actualPeriod = Math.min(period, values.length);
  if (actualPeriod === 0) return [];
  const multiplier = 2 / (actualPeriod + 1);
  const result: Array<number | null> = [];
  for (let index = 0; index < values.length; index += 1) {
    if (index < actualPeriod - 1) {
      const slice = values.slice(0, index + 1);
      result.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
      continue;
    }
    if (index === actualPeriod - 1) {
      const slice = values.slice(index - actualPeriod + 1, index + 1);
      result.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
      continue;
    }
    const previous = result[index - 1];
    result.push(previous === null || previous === undefined ? values[index]! : (values[index]! - previous) * multiplier + previous);
  }
  return result;
}

function movingAverage(bars: TrendBar[], period: number): Array<number | null> {
  return bars.map((_, index) => {
    if (index < period - 1) return null;
    let sum = 0;
    for (let offset = 0; offset < period; offset += 1) sum += bars[index - offset]!.close;
    return Number((sum / period).toFixed(4));
  });
}

function mask(values: Array<number | null>, flags: boolean[]): Array<number | null> {
  return values.map((value, index) => flags[index] ? value : null);
}

function sticks(
  dates: string[],
  upper: Array<number | null>,
  lower: Array<number | null>,
  ordered: boolean[],
  inside: boolean[],
  active: boolean[],
): Array<[string, number, number]> {
  const points: Array<[string, number, number]> = [];
  for (let index = 0; index < upper.length; index += 1) {
    const top = upper[index];
    const bottom = lower[index];
    const date = dates[index];
    if (!date || !ordered[index] || inside[index] || !active[index] || top == null || bottom == null) continue;
    points.push([date, top, bottom]);
  }
  return points;
}
