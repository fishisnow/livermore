const FEAR_GREED_URL = "https://pre.jiucaishuo.com/v4/open-ai/kt";
const CACHE_MS = 10 * 60 * 1000;

export type FearGreedBand = "extreme-fear" | "fear" | "neutral" | "greed" | "extreme-greed";

export interface FearGreedPoint {
  date: string;
  value: number;
  band: FearGreedBand;
  label: string;
  note: string;
}

export interface FearGreedSnapshot {
  source: "jiucaishuo";
  name: "韭圈恐贪指数";
  endpoint: string;
  success: boolean;
  message?: string;
  latest?: FearGreedPoint;
  points: FearGreedPoint[];
}

interface FearGreedResponse {
  code?: number;
  message?: string;
  data?: unknown;
}

let cache: { at: number; value: FearGreedSnapshot } | undefined;

export function classifyFearGreed(value: number): Pick<FearGreedPoint, "band" | "label" | "note"> {
  if (value < 10) return { band: "extreme-fear", label: "极度恐惧", note: "市场处于极度恐惧区间，情绪非常谨慎，往往对应阶段性低位附近。" };
  if (value < 30) return { band: "fear", label: "恐惧", note: "市场偏恐惧，避险情绪占上风。" };
  if (value < 50) return { band: "neutral", label: "中性", note: "市场情绪中性，多空相对均衡。" };
  if (value < 70) return { band: "greed", label: "贪婪", note: "市场偏贪婪，风险偏好升温。" };
  return { band: "extreme-greed", label: "极度贪婪", note: "市场处于极度贪婪区间，需警惕短期过热。" };
}

export async function queryJiucaishuoFearGreed(options: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<FearGreedSnapshot> {
  const now = options.now ?? Date.now();
  if (!options.fetchImpl && cache && now - cache.at < CACHE_MS) return cache.value;
  const snapshot = await fetchFearGreed(options.fetchImpl ?? fetch);
  if (!options.fetchImpl && snapshot.success) cache = { at: now, value: snapshot };
  return snapshot;
}

async function fetchFearGreed(fetchImpl: typeof fetch): Promise<FearGreedSnapshot> {
  const base = { source: "jiucaishuo" as const, name: "韭圈恐贪指数" as const, endpoint: FEAR_GREED_URL, points: [] };
  try {
    const response = await fetchImpl(FEAR_GREED_URL, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; Livermore/0.1; +local)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { ...base, success: false, message: `HTTP ${response.status}` };
    const payload = await response.json() as FearGreedResponse;
    if (payload.code !== 0) return { ...base, success: false, message: payload.message || "韭圈恐贪指数查询失败" };
    const points = parseFearGreedPoints(payload.data);
    const latest = points.at(-1);
    if (!latest) return { ...base, success: false, message: "接口未返回恐贪指数数据" };
    return { ...base, success: true, latest, points };
  } catch (error) {
    return { ...base, success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function parseFearGreedPoints(value: unknown): FearGreedPoint[] {
  if (!Array.isArray(value)) return [];
  const points: FearGreedPoint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { date?: unknown; percent?: unknown };
    const date = typeof row.date === "string" ? row.date : "";
    const reading = typeof row.percent === "number" ? row.percent : Number(row.percent);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(reading)) continue;
    points.push({ date, value: reading, ...classifyFearGreed(reading) });
  }
  points.sort((left, right) => left.date.localeCompare(right.date));
  return points;
}
