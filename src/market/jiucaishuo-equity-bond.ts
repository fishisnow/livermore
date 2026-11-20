const GZ_BASE = "https://vip.jiucaishuo.com/gz/gz";
const CACHE_MS = 10 * 60 * 1000;
const LOOKBACK_YEARS = 10;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_GZ_AUTHTOKEN = "DqimVW21l+SbM8XT469qbSU/gkpeEUed";

export const EQUITY_BOND_INDEXES = [
  { code: "881001.WI", name: "万得全A" },
  { code: "000906.SH", name: "中证800" },
  { code: "000300.SH", name: "沪深300" },
  { code: "000905.SH", name: "中证500" },
  { code: "000016.SH", name: "上证50" },
  { code: "000852.SH", name: "中证1000" },
  { code: "HSI.HI", name: "恒生指数" },
] as const;

export type EquityBondBandId = "extreme-cold" | "cold" | "neutral" | "hot" | "extreme-hot";
export type EquityBondMethod = "fed" | "gxl";

export interface EquityBondBand {
  id: EquityBondBandId;
  label: string;
  low: number;
  high: number;
  note: string;
}

export interface EquityBondPoint {
  date: string;
  value: number;
  mean: number | null;
}

export interface EquityBondSnapshot {
  source: "jiucaishuo";
  name: "股债性价比";
  endpoint: string;
  success: boolean;
  message?: string;
  indexCode: string;
  indexName: string;
  peCategory: EquityBondMethod;
  peLabel: string;
  year: number;
  formula: string;
  reading: string;
  latest?: {
    date: string;
    value: number;
    percentile: number | null;
    mean: number | null;
    band: EquityBondBandId | "outside";
    label: string;
    note: string;
  };
  bands: EquityBondBand[];
  points: EquityBondPoint[];
  bond?: { date: string; yield: number; temperature: number | null };
  temperature?: { value: number; summary: string };
}

interface EquityBondOptions {
  fetchImpl?: typeof fetch;
  now?: number;
  indexCode?: string;
  peCategory?: string;
  token?: string;
}

const BAND_DEFS: Array<{ id: EquityBondBandId; prefix: string; note: string }> = [
  { id: "extreme-cold", prefix: "极低温", note: "风险溢价处在近10年高位，股票相对债券很便宜。" },
  { id: "cold", prefix: "较低温", note: "风险溢价处在近10年偏高位置，股票相对债券偏便宜。" },
  { id: "neutral", prefix: "适中", note: "风险溢价处在近10年中位，股债性价比均衡。" },
  { id: "hot", prefix: "较高温", note: "风险溢价处在近10年偏低位置，股票相对债券偏贵。" },
  { id: "extreme-hot", prefix: "极高温", note: "风险溢价处在近10年低位，股票相对债券很贵。" },
];

const cache = new Map<string, { at: number; value: EquityBondSnapshot }>();

export function matchEquityBondBand(bands: readonly EquityBondBand[], value: number): EquityBondBand | undefined {
  return bands.find((band) => band.low <= value && value <= band.high);
}

export async function queryJiucaishuoEquityBond(options: EquityBondOptions = {}): Promise<EquityBondSnapshot> {
  const index = resolveIndex(options.indexCode);
  const method = resolveMethod(options.peCategory);
  if (!index) return blank(options.indexCode?.trim() || "", "", method ?? "fed", `不支持的指数：${options.indexCode?.trim() || "空"}`);
  if (!method) return blank(index.code, index.name, "fed", `不支持的口径：${options.peCategory?.trim() || "空"}`);
  const now = options.now ?? Date.now();
  const key = `${index.code}|${method}`;
  const cached = cache.get(key);
  if (!options.fetchImpl && cached && now - cached.at < CACHE_MS) return cached.value;

  const token = options.token?.trim() || process.env.JIUCAISHUO_GZ_AUTHTOKEN?.trim() || DEFAULT_GZ_AUTHTOKEN;
  const fetchImpl = options.fetchImpl ?? fetch;
  const [fed, bond, temperature] = await Promise.all([
    postGz(fetchImpl, "fed", {
      category_type: "cz",
      gu_code: index.code,
      year: LOOKBACK_YEARS,
      pe_category: method,
      year2: 1,
      mz: "",
    }, token),
    postGz(fetchImpl, "zhai", { code: "numb", year: LOOKBACK_YEARS }, token),
    postGz(fetchImpl, "gu", {}, token),
  ]);
  if (!fed.ok) return blank(index.code, index.name, method, fed.message);

  const snapshot = buildSnapshot(index, method, fed.data, bond.ok ? bond.data : undefined, temperature.ok ? temperature.data : undefined);
  if (!options.fetchImpl && snapshot.success) cache.set(key, { at: now, value: snapshot });
  return snapshot;
}

function resolveIndex(input?: string): { code: string; name: string } | undefined {
  const value = input?.trim() || "881001.WI";
  return EQUITY_BOND_INDEXES.find((item) => item.code === value || item.name === value);
}

function resolveMethod(input?: string): EquityBondMethod | undefined {
  const value = input?.trim() || "fed";
  return value === "fed" || value === "gxl" ? value : undefined;
}

function blank(indexCode: string, indexName: string, method: EquityBondMethod, message: string): EquityBondSnapshot {
  const peLabel = method === "gxl" ? "股息率风险溢价" : "FED风险溢价";
  return {
    source: "jiucaishuo",
    name: "股债性价比",
    endpoint: GZ_BASE,
    success: false,
    message,
    indexCode,
    indexName,
    peCategory: method,
    peLabel,
    year: LOOKBACK_YEARS,
    formula: "",
    reading: "",
    bands: [],
    points: [],
  };
}

function buildSnapshot(
  index: { code: string; name: string },
  method: EquityBondMethod,
  fed: unknown,
  bond: unknown,
  temperature: unknown,
): EquityBondSnapshot {
  const peLabel = method === "gxl" ? "股息率风险溢价" : "FED风险溢价";
  const base = blank(index.code, index.name, method, "");
  const root = record(fed);
  const bands = parseBands(root?.tuli_list);
  const points = parsePoints(root?.tb_data);
  const latestRaw = record(root?.new);
  const value = num(latestRaw?.fxyj) ?? points.at(-1)?.value;
  const date = text(latestRaw?.date) || points.at(-1)?.date || "";
  if (value === undefined || !date || points.length === 0) {
    return { ...base, success: false, message: "接口未返回股债性价比走势" };
  }
  if (!points.some((point) => point.date === date)) {
    points.push({ date, value, mean: num(latestRaw?.pjz) ?? null });
    points.sort((left, right) => left.date.localeCompare(right.date));
  }
  const band = matchEquityBondBand(bands, value);
  const formula = text(root?.desc) || (method === "gxl"
    ? `${index.name}股息率溢价=${index.name}股息率-十年期国债收益率`
    : `${index.name}风险溢价=1/${index.name}市盈率-十年期国债收益率`);
  const bondRoot = record(bond);
  const bondLatest = record(bondRoot?.new);
  const bondYield = num(bondLatest?.val);
  const bondDate = text(bondLatest?.date);
  const tempRoot = record(temperature);
  const tempValue = num(tempRoot?.temp);
  const snapshot: EquityBondSnapshot = {
    ...base,
    success: true,
    formula,
    reading: `${formula}。溢价越高，股票相对债券越便宜。`,
    latest: {
      date,
      value,
      percentile: num(latestRaw?.percent) ?? null,
      mean: num(latestRaw?.pjz) ?? null,
      band: band?.id ?? "outside",
      label: band?.label ?? "区间外",
      note: band?.note ?? "当前风险溢价落在平台温度带之外。",
    },
    bands,
    points,
  };
  delete snapshot.message;
  if (bondYield !== undefined && bondDate) snapshot.bond = { date: bondDate, yield: bondYield, temperature: num(bondRoot?.zq_temp) ?? null };
  if (tempValue !== undefined) snapshot.temperature = { value: tempValue, summary: stripHtml(text(tempRoot?.wd_str2)) };
  return snapshot;
}

function parseBands(value: unknown): EquityBondBand[] {
  if (!Array.isArray(value)) return [];
  const bands: EquityBondBand[] = [];
  for (const item of value) {
    const row = record(item);
    const name = text(row?.name);
    const definition = BAND_DEFS.find((band) => name.startsWith(band.prefix));
    const lowRaw = num(row?.lte);
    const highRaw = num(row?.gt);
    if (!definition || lowRaw === undefined || highRaw === undefined) continue;
    bands.push({
      id: definition.id,
      label: definition.prefix,
      low: Math.min(lowRaw, highRaw),
      high: Math.max(lowRaw, highRaw),
      note: definition.note,
    });
  }
  return bands;
}

function parsePoints(value: unknown): EquityBondPoint[] {
  const table = record(value);
  const dates = Array.isArray(table?.x_data) ? table.x_data : [];
  const series = Array.isArray(table?.series) ? table.series : [];
  const premium = seriesValues(series, (name) => name.includes("溢价") && !name.includes("平均") && !name.includes("标准差"));
  const mean = seriesValues(series, (name) => name.includes("平均"));
  if (!premium) return [];
  const points: EquityBondPoint[] = [];
  const count = Math.min(dates.length, premium.length);
  for (let index = 0; index < count; index += 1) {
    const date = text(dates[index]);
    const reading = num(premium[index]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || reading === undefined) continue;
    points.push({ date, value: reading, mean: mean ? num(mean[index]) ?? null : null });
  }
  points.sort((left, right) => left.date.localeCompare(right.date));
  return points;
}

function seriesValues(series: unknown[], predicate: (name: string) => boolean): unknown[] | undefined {
  const match = series.find((item) => predicate(text(record(item)?.name)));
  const data = record(match)?.data;
  return Array.isArray(data) ? data : undefined;
}

async function postGz(fetchImpl: typeof fetch, endpoint: string, body: Record<string, unknown>, token: string): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  try {
    const response = await fetchImpl(`${GZ_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ ...body, type: "h5", version: "2.5.9", authtoken: token, ss: "", act_time: Date.now() }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
    const payload = await response.json() as { code?: number; message?: string; data?: unknown };
    if (payload.code !== 0) return { ok: false, message: text(payload.message) || "股债性价比查询失败" };
    return { ok: true, data: payload.data ?? {} };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
