import { inflateRawSync } from "node:zlib";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setDefaultResultOrder } from "node:dns";
import { projectRoot } from "../project-paths.js";

// East Money drops some IPv6 connections. Exchange endpoints are unaffected.
setDefaultResultOrder("ipv4first");

const SSE_URL = "https://query.sse.com.cn/commonQuery.do";
const SZSE_URL = "https://www.szse.cn/api/report/ShowReport";
const NAV_URL = "https://api.fund.eastmoney.com/f10/lsjz";
const HISTORY_DAYS = 380;
const REFRESH_DAYS = 12;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_FILE = path.join(projectRoot, "data", "national-team-etf.json");

export const NATIONAL_TEAM_ETFS = [
  { code: "510300", market: "sh" },
  { code: "510310", market: "sh" },
  { code: "510330", market: "sh" },
  { code: "159919", market: "sz" },
  { code: "515330", market: "sh" },
  { code: "510050", market: "sh" },
  { code: "510100", market: "sh" },
  { code: "510500", market: "sh" },
  { code: "512500", market: "sh" },
  { code: "159922", market: "sz" },
  { code: "512100", market: "sh" },
  { code: "159845", market: "sz" },
  { code: "560010", market: "sh" },
  { code: "159629", market: "sz" },
  { code: "159633", market: "sz" },
  { code: "159915", market: "sz" },
  { code: "159952", market: "sz" },
  { code: "159977", market: "sz" },
  { code: "588080", market: "sh" },
  { code: "588050", market: "sh" },
  { code: "588000", market: "sh" },
  { code: "563360", market: "sh" },
  { code: "512050", market: "sh" },
  { code: "563800", market: "sh" },
  { code: "563220", market: "sh" },
  { code: "159338", market: "sz" },
  { code: "159352", market: "sz" },
  { code: "159361", market: "sz" },
  { code: "159351", market: "sz" },
  { code: "510180", market: "sh" },
  { code: "510230", market: "sh" },
  { code: "159901", market: "sz" },
  { code: "515800", market: "sh" },
  { code: "560050", market: "sh" },
] as const;

const TARGET_CODES = new Set<string>(NATIONAL_TEAM_ETFS.map((etf) => etf.code));
const MARKET_OF = new Map(NATIONAL_TEAM_ETFS.map((etf) => [etf.code, etf.market]));

export interface NationalTeamPoint {
  date: string;
  value: number;
  label: "净买入" | "净卖出" | "持平";
}

export interface NationalTeamSnapshot {
  source: "sse-szse";
  name: "国家队净买卖";
  unit: "亿元";
  endpoint: string;
  success: boolean;
  message?: string;
  asOf?: string;
  latest?: NationalTeamPoint;
  points: NationalTeamPoint[];
}

interface ShareCache {
  shares: Record<string, Record<string, number>>;
  empty: string[];
  nav: Record<string, Record<string, number>>;
}

interface QueryOptions {
  fetchImpl?: typeof fetch;
  now?: number;
  historyDays?: number;
  cacheFile?: string | null;
}

const ENDPOINT = "query.sse.com.cn + www.szse.cn + api.fund.eastmoney.com";
let memory: { at: number; value: NationalTeamSnapshot } | undefined;

export function sharesFromSseResult(result: unknown): Record<string, number> {
  if (!Array.isArray(result)) return {};
  const shares: Record<string, number> = {};
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const row = item as { SEC_CODE?: unknown; TOT_VOL?: unknown };
    const code = String(row.SEC_CODE ?? "").padStart(6, "0");
    const lots = typeof row.TOT_VOL === "number" ? row.TOT_VOL : Number(row.TOT_VOL);
    if (!TARGET_CODES.has(code) || !Number.isFinite(lots)) continue;
    shares[code] = lots * 10_000;
  }
  return shares;
}

export function sharesFromSzseWorkbook(bytes: Buffer): Record<string, Record<string, number>> {
  let sheet: Buffer | undefined;
  try {
    sheet = readZip(bytes).get("xl/worksheets/sheet1.xml");
  } catch {
    return {};
  }
  if (!sheet) return {};
  return sharesFromSzseSheet(sheet.toString("utf8"));
}

function sharesFromSzseSheet(xml: string): Record<string, Record<string, number>> {
  const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
  if (rows.length === 0) return {};
  const header = cellsOf(rows[0]?.[1] ?? "");
  const dateCol = header.indexOf("日期");
  const codeCol = header.indexOf("基金代码");
  const shareCol = header.findIndex((cell) => cell?.startsWith("基金规模"));
  if (dateCol < 0 || codeCol < 0 || shareCol < 0) return {};
  const shares: Record<string, Record<string, number>> = {};
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row[1] ?? "");
    const date = compactDate(cells[dateCol] ?? "");
    const code = (cells[codeCol] ?? "").replace(/\D/g, "").padStart(6, "0");
    const amount = Number((cells[shareCol] ?? "").replace(/,/g, ""));
    if (!date || !TARGET_CODES.has(code) || !Number.isFinite(amount)) continue;
    const day = shares[date] ?? {};
    day[code] = amount;
    shares[date] = day;
  }
  return shares;
}

export function computeNationalTeamSeries(
  sharesByDate: Record<string, Record<string, number>>,
  navByCode: Record<string, Record<string, number>>,
): NationalTeamPoint[] {
  const dates = Object.keys(sharesByDate).filter((date) => Object.keys(sharesByDate[date] ?? {}).length > 0).sort();
  const totals = new Map<string, number>();
  const markets = new Map<string, Set<"sh" | "sz">>();
  for (const etf of NATIONAL_TEAM_ETFS) {
    let previousShares: number | undefined;
    let nav: number | undefined;
    let previousNav: number | undefined;
    for (const date of dates) {
      const shares = sharesByDate[date]?.[etf.code];
      if (shares === undefined) continue;
      const published = navByCode[etf.code]?.[date];
      if (published !== undefined) {
        previousNav = nav;
        nav = published;
      }
      let net: number | undefined;
      if (previousShares !== undefined && nav !== undefined) {
        net = (shares - previousShares) * nav;
        if (shares !== previousShares && previousNav && previousNav !== 0) {
          const shareRatio = shares / previousShares;
          const navRatio = nav / previousNav;
          if (Math.abs(shareRatio - 1) > 0.3 && (shareRatio - 1) * (navRatio - 1) < 0 && shareRatio * navRatio > 0.6 && shareRatio * navRatio < 1.6) {
            net = 0;
          }
        }
      }
      if (net !== undefined) totals.set(date, (totals.get(date) ?? 0) + net);
      const seen = markets.get(date) ?? new Set<"sh" | "sz">();
      const market = MARKET_OF.get(etf.code);
      if (market) seen.add(market);
      markets.set(date, seen);
      previousShares = shares;
    }
  }
  const synced = dates.filter((date) => markets.get(date)?.size === 2);
  const cut = synced.at(-1);
  if (!cut) return [];
  return dates.filter((date) => date <= cut && totals.has(date)).map((date) => pointFromYuan(date, totals.get(date) ?? 0));
}

export async function queryNationalTeamFlow(options: QueryOptions = {}): Promise<NationalTeamSnapshot> {
  const now = options.now ?? Date.now();
  const cacheFile = options.cacheFile === undefined ? (options.fetchImpl ? null : CACHE_FILE) : options.cacheFile;
  if (!options.fetchImpl && cacheFile === CACHE_FILE && options.historyDays === undefined && memory && now - memory.at < CACHE_MS) return memory.value;
  const snapshot = await loadNationalTeamFlow(options.fetchImpl ?? fetch, now, options.historyDays ?? HISTORY_DAYS, cacheFile);
  if (!options.fetchImpl && cacheFile === CACHE_FILE && options.historyDays === undefined && snapshot.success) memory = { at: now, value: snapshot };
  return snapshot;
}

async function loadNationalTeamFlow(fetchImpl: typeof fetch, now: number, historyDays: number, cacheFile: string | null): Promise<NationalTeamSnapshot> {
  const base = { source: "sse-szse" as const, name: "国家队净买卖" as const, unit: "亿元" as const, endpoint: ENDPOINT, points: [] as NationalTeamPoint[] };
  try {
    const today = shanghaiDate(now);
    const start = addCalendarDays(today, -historyDays);
    const weekdays = calendarDays(start, today).filter((date) => weekday(date) >= 1 && weekday(date) <= 5);
    const cache = await readShareCache(cacheFile);
    const refreshFrom = addCalendarDays(today, -REFRESH_DAYS);
    const pending = weekdays.filter((date) => date >= refreshFrom || (!cache.shares[compactDate(date)] && !cache.empty.includes(compactDate(date))));
    const hasSzseHistory = weekdays.some((date) => date < refreshFrom && hasMarket(cache.shares[compactDate(date)], "sz"));
    await mapPool(pending, 8, async (date) => {
      try {
        const shares = await fetchSseShares(fetchImpl, date);
        const key = compactDate(date);
        if (Object.keys(shares).length === 0) {
          if (!cache.empty.includes(key)) cache.empty.push(key);
          return;
        }
        cache.shares[key] = { ...cache.shares[key], ...shares };
        cache.empty = cache.empty.filter((item) => item !== key);
      } catch {
        // A missing Shanghai session is retried on the next refresh window.
      }
    });
    for (const [from, to] of szseWindows(hasSzseHistory ? refreshFrom : start, today)) {
      try {
        const shares = sharesFromSzseWorkbook(await fetchSzseWorkbook(fetchImpl, from, to));
        for (const [date, row] of Object.entries(shares)) {
          cache.shares[date] = { ...cache.shares[date], ...row };
          cache.empty = cache.empty.filter((item) => item !== date);
        }
      } catch {
        // Shenzhen history is requested again next time; cached days still render.
      }
    }
    const nav = await fetchNavHistories(fetchImpl, compactDate(start), cache.nav);
    cache.nav = nav;
    await writeShareCache(cacheFile, cache);
    const points = computeNationalTeamSeries(cache.shares, nav);
    const latest = points.at(-1);
    if (!latest) return { ...base, success: false, message: "交易所尚未返回可计算的国家队 ETF 份额" };
    return { ...base, success: true, asOf: latest.date, latest, points };
  } catch (error) {
    return { ...base, success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function pointFromYuan(compact: string, yuan: number): NationalTeamPoint {
  const value = round3(yuan / 1e8);
  const label = value > 0 ? "净买入" : value < 0 ? "净卖出" : "持平";
  return { date: `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`, value, label };
}

async function fetchSseShares(fetchImpl: typeof fetch, date: string): Promise<Record<string, number>> {
  const url = new URL(SSE_URL);
  url.searchParams.set("isPagination", "true");
  url.searchParams.set("pageHelp.pageSize", "10000");
  url.searchParams.set("pageHelp.pageNo", "1");
  url.searchParams.set("pageHelp.beginPage", "1");
  url.searchParams.set("pageHelp.cacheSize", "1");
  url.searchParams.set("pageHelp.endPage", "1");
  url.searchParams.set("sqlId", "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L");
  url.searchParams.set("STAT_DATE", date);
  const response = await fetchImpl(url, {
    headers: { Referer: "https://www.sse.com.cn/", "User-Agent": "Mozilla/5.0 (compatible; Livermore/0.1; +local)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);
  const payload = await response.json() as { result?: unknown };
  return sharesFromSseResult(payload.result);
}

async function fetchSzseWorkbook(fetchImpl: typeof fetch, start: string, end: string): Promise<Buffer> {
  const url = new URL(SZSE_URL);
  url.searchParams.set("SHOWTYPE", "xlsx");
  url.searchParams.set("CATALOGID", "scsj_fund_jjgm");
  url.searchParams.set("TABKEY", "tab1");
  url.searchParams.set("txtStart", start);
  url.searchParams.set("txtEnd", end);
  url.searchParams.set("jjlb", "ETF");
  const response = await fetchImpl(url, {
    headers: { Referer: "https://www.szse.cn/market/fund/volume/etf/index.html", "User-Agent": "Mozilla/5.0 (compatible; Livermore/0.1; +local)" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`SZSE HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchNavHistories(
  fetchImpl: typeof fetch,
  since: string,
  cached: Record<string, Record<string, number>>,
): Promise<Record<string, Record<string, number>>> {
  const nav: Record<string, Record<string, number>> = {};
  await mapPool(NATIONAL_TEAM_ETFS, 6, async (etf) => {
    try {
      nav[etf.code] = await fetchNav(fetchImpl, etf.code, since, cached[etf.code] ?? {});
    } catch {
      nav[etf.code] = cached[etf.code] ?? {};
    }
  });
  return nav;
}

async function fetchNav(fetchImpl: typeof fetch, code: string, since: string, cached: Record<string, number>): Promise<Record<string, number>> {
  const points = { ...cached };
  const cachedOldest = Object.keys(points).sort()[0] ?? "";
  const maxPages = !cachedOldest || cachedOldest > since ? 20 : 1;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(NAV_URL);
    url.searchParams.set("fundCode", code);
    url.searchParams.set("pageIndex", String(page));
    url.searchParams.set("pageSize", "20");
    const response = await fetchImpl(url, {
      headers: { Referer: "https://fundf10.eastmoney.com/", Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; Livermore/0.1; +local)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`NAV HTTP ${response.status}`);
    const payload = await response.json() as { Data?: { LSJZList?: Array<{ FSRQ?: string; DWJZ?: string }> } };
    const rows = payload.Data?.LSJZList ?? [];
    let oldest = "";
    for (const row of rows) {
      const date = compactDate(row.FSRQ ?? "");
      const value = Number(row.DWJZ);
      if (!date || !Number.isFinite(value)) continue;
      points[date] = value;
      if (!oldest || date < oldest) oldest = date;
    }
    if (rows.length < 20 || !oldest || oldest <= since) break;
  }
  return points;
}

function szseWindows(start: string, end: string): Array<[string, string]> {
  const windows: Array<[string, string]> = [];
  let cursor = start;
  while (cursor <= end) {
    const windowEnd = addCalendarDays(cursor, 150);
    const to = windowEnd < end ? windowEnd : end;
    windows.push([cursor, to]);
    cursor = addCalendarDays(to, 1);
  }
  return windows;
}

function readZip(bytes: Buffer): Map<string, Buffer> {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return new Map();
  const count = bytes.readUInt16LE(eocd + 8);
  let offset = bytes.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    files.set(name, method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function cellsOf(rowXml: string): string[] {
  const cells: string[] = [];
  for (const match of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const ref = /r="([A-Z]+)/.exec(match[1] ?? "")?.[1] ?? "";
    const column = [...ref].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
    if (column < 0) continue;
    const inlineBody = /<is>([\s\S]*?)<\/is>/.exec(match[2] ?? "")?.[1];
    const text = inlineBody
      ? [...inlineBody.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1] ?? "")).join("")
      : decodeXml(/<v>([\s\S]*?)<\/v>/.exec(match[2] ?? "")?.[1] ?? "");
    cells[column] = text;
  }
  return cells;
}

function decodeXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function compactDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return match ? `${match[1]}${match[2]}${match[3]}` : "";
}

function hasMarket(row: Record<string, number> | undefined, market: "sh" | "sz"): boolean {
  if (!row) return false;
  return NATIONAL_TEAM_ETFS.some((etf) => etf.market === market && row[etf.code] !== undefined);
}

function round3(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value) * 1000) / 1000;
}

function shanghaiDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function addCalendarDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) + days * 86_400_000).toISOString().slice(0, 10);
}

function weekday(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

function calendarDays(start: string, end: string): string[] {
  const days: string[] = [];
  for (let date = start; date <= end; date = addCalendarDays(date, 1)) days.push(date);
  return days;
}

async function mapPool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await task(item);
    }
  });
  await Promise.all(workers);
}

async function readShareCache(file: string | null): Promise<ShareCache> {
  if (!file) return { shares: {}, empty: [], nav: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ShareCache>;
    return {
      shares: parsed.shares && typeof parsed.shares === "object" ? parsed.shares : {},
      empty: Array.isArray(parsed.empty) ? parsed.empty.filter((item) => typeof item === "string") : [],
      nav: parsed.nav && typeof parsed.nav === "object" ? parsed.nav : {},
    };
  } catch {
    return { shares: {}, empty: [], nav: {} };
  }
}

async function writeShareCache(file: string | null, cache: ShareCache): Promise<void> {
  if (!file) return;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(cache));
    await rename(temporary, file);
  } catch {
    // The chart can still be served from the shares already in memory.
  }
}
