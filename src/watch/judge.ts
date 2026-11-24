import { createHash } from "node:crypto";
import type {
  EvidenceItem,
  KnownEvidence,
  SignalConfidence,
  SignalDirection,
  SignalImpact,
  SignalImportance,
  SignalType,
  WatchState,
} from "./types.js";

export interface ProposedSignal {
  type: SignalType;
  direction: SignalDirection;
  importance: SignalImportance;
  summary: string;
  previousState: string;
  newEvidence: string;
  impact: SignalImpact;
  confidence: SignalConfidence;
  sources: EvidenceItem[];
  dedupeKey: string;
  detectedAt: string;
}

export interface Judgment {
  baseline: boolean;
  signals: ProposedSignal[];
  state: WatchState;
  summary: string;
}

export interface WatchLens {
  question: string;
  focus: string[];
  windowStart: string;
}

const TOPIC_PATTERNS: Array<[string, RegExp]> = [
  ["资本开支", /资本开支|资本支出|capex/i],
  ["产能", /扩产|产能|投产|良率/],
  ["价格", /价格|涨价|跌价|合约价|\bprice\b/i],
  ["盈利", /盈利|利润|\bearnings\b|\beps\b/i],
  ["估值", /估值|目标价|重定价|\bvaluation\b/i],
  ["供需", /供需|供给|需求|库存|\bsupply\b|\bdemand\b/i],
  ["指引", /指引|\bguidance\b/i],
  ["周期", /周期|见顶/],
];

const SUBJECTS = ["DRAM", "NAND", "HBM", "存储", "长鑫", "美光", "三星", "海力士", "英伟达", "NVIDIA", "微软", "谷歌", "亚马逊", "Meta", "苹果", "台积电", "特斯拉"];
const CHANGE = /上修|下修|上调|下调|扩产|推迟|提前|放缓|见顶|重定价|转弱|转强|不及预期|超预期|downgrade|upgrade|\braise\b|\bcut\b/i;
const BEAR = /下修|下调|转弱|不及预期|见顶|过剩|下滑|放缓|推迟|看空|downgrade|\bcut\b|\bweak\b|\bmiss\b/i;
const BULL = /上修|上调|转强|超预期|紧缺|短缺|提前|看多|upgrade|\braise\b|\btight\b|\bbeat\b/i;
const REVISION = /上修|下修|上调|下调|不及预期|超预期|指引|预测|预期|forecast|guidance|downgrade|upgrade|目标价/i;

const FAMILIES = [
  ["黄金", "金价", "gold", "bullion"],
  ["存储", "dram", "nand", "hbm", "美光", "海力士", "三星", "长鑫", "micron"],
  ["英伟达", "nvidia", "微软", "microsoft", "谷歌", "google", "亚马逊", "amazon", "meta"],
];

export function isSystemNarrative(narrative: string): boolean {
  return /尚未形成|已把最近|最近 24|等待第一次|还没有从证据里形成市场叙事/.test(narrative);
}

export function establishBaseline(state: WatchState, items: EvidenceItem[], now: Date, lens: WatchLens): Judgment {
  const related = items.filter((item) => relates(item, lens));
  const recent = related.filter((item) => recentEnough(item, now));
  const dated = recent.filter((item) => publishedStamp(item) !== null);
  const read = recent.length === 0
    ? { narrative: "还没有与观察问题相关的公开资料。", expectation: "预期未知。", expectationKnown: false, uncertainties: [] as string[] }
    : marketRead(dated);
  const next = remember(state, recent);
  next.baselined = true;
  next.baselineSources = recent.slice(0, 12).map(sourceOf);
  next.currentNarrative = read.narrative;
  next.marketExpectation = read.expectation;
  next.expectationKnown = read.expectationKnown;
  next.uncertainties = read.uncertainties;
  const summary = recent.length > 0
    ? `第一次检查建立了市场状态，不把已有公开信息写成变化。检索到 ${items.length} 条，其中 ${recent.length} 条与观察问题相关。`
    : `第一次检查没有找到与观察问题相关的公开资料。检索到 ${items.length} 条，没有写成变化。`;
  return { baseline: true, signals: [], state: next, summary };
}

export function judgeIncremental(state: WatchState, items: EvidenceItem[], priorTexts: string[], now: Date, lens: WatchLens): Judgment {
  const related = items.filter((item) => relates(item, lens));
  const fresh = related.filter((item) => !isKnown(item, state, priorTexts));
  const current = fresh.filter((item) => withinWindow(item, lens.windowStart, now));
  const heldBack = fresh.length - current.length;
  const actionable = current.filter((item) => isActionable(blob(item)));
  const used = new Set<EvidenceItem>();
  const signals: ProposedSignal[] = [];

  for (const group of broadGroups(actionable)) {
    for (const item of group) used.add(item);
    const signal = buildSignal(group, "narrative_shift", state, now);
    if (signal) signals.push(signal);
  }

  const singles = actionable.filter((item) => !used.has(item));
  for (const group of groupByClaim(singles)) {
    const text = group.map(blob).join("\n");
    const type: SignalType = REVISION.test(text) || directionOf(text) !== "neutral" ? "expectation_revision" : "new_evidence";
    const signal = buildSignal(group, type, state, now);
    if (signal) signals.push(signal);
  }

  const next = remember(state, fresh);
  const shift = signals.find((signal) => signal.type === "narrative_shift");
  if (shift) {
    next.currentNarrative = clip(`${shift.summary}。${shift.newEvidence}`, 180);
    next.marketExpectation = clip(shift.newEvidence, 160);
    next.expectationKnown = true;
  }
  if (signals.some((signal) => signal.direction === "mixed") && !next.uncertainties.includes("来源方向不一致")) {
    next.uncertainties = [...next.uncertainties, "来源方向不一致"].slice(0, 6);
  }

  const summary = signals.length > 0
    ? `记录 ${signals.length} 条变化。${signals[0]?.summary ?? ""}`
    : observationSummary(items.length, related.length, heldBack);

  return { baseline: false, signals, state: next, summary };
}

export function isSameClaim(left: string, right: string): boolean {
  if (!numbersCompatible(left, right)) return false;
  if (claimsMatch(left, right)) return true;
  const leftCore = left.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "");
  const rightCore = right.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "");
  if (leftCore.length < 6 || rightCore.length < 6) return false;
  return leftCore.includes(rightCore) || rightCore.includes(leftCore);
}

export function claimsMatch(left: string, right: string): boolean {
  const leftGrams = claimGrams(left);
  const rightGrams = claimGrams(right);
  if (leftGrams.size < 4 || rightGrams.size < 4) return false;
  let shared = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) shared += 1;
  const union = leftGrams.size + rightGrams.size - shared;
  return union > 0 && shared / union >= 0.55;
}

function isKnown(item: EvidenceItem, state: WatchState, priorTexts: string[]): boolean {
  const text = blob(item);
  if (state.knownEvidence.some((evidence) => evidence.url === item.url)) return true;
  if (state.knownEvidence.some((evidence) => isSameClaim(text, evidence.title))) return true;
  return priorTexts.some((prior) => isSameClaim(text, prior));
}

function isActionable(text: string): boolean {
  return CHANGE.test(text) && topicsOf(text).length > 0;
}

function broadGroups(items: EvidenceItem[]): EvidenceItem[][] {
  const groups: EvidenceItem[][] = [];
  const used = new Set<EvidenceItem>();
  for (const direction of ["bearish", "bullish"] as const) {
    for (const [topic] of TOPIC_PATTERNS) {
      const matched = items.filter((item) => {
        if (used.has(item)) return false;
        const text = blob(item);
        return directionOf(text) === direction && topicsOf(text).includes(topic);
      });
      const publishers = new Set(matched.map((item) => item.publisher));
      if (publishers.size < 2) continue;
      for (const item of matched) used.add(item);
      groups.push(matched);
    }
  }
  return groups;
}

function groupByClaim(items: EvidenceItem[]): EvidenceItem[][] {
  const groups: EvidenceItem[][] = [];
  for (const item of items) {
    const found = groups.find((group) => group.some((existing) => isSameClaim(blob(existing), blob(item))));
    if (found) found.push(item);
    else groups.push([item]);
  }
  return groups;
}

function buildSignal(items: EvidenceItem[], type: SignalType, state: WatchState, now: Date): ProposedSignal | null {
  const source = items[0];
  if (!source) return null;
  const text = items.map(blob).join("\n");
  const direction = directionOf(text);
  const publishers = new Set(items.map((item) => item.publisher));
  const importance: SignalImportance = type === "narrative_shift" ? "important" : "notable";
  const topic = topicsOf(text)[0] ?? "其他";
  const subjects = intersection(items.map((item) => subjectsOf(blob(item))));
  const material = type === "narrative_shift"
    ? `broad|${direction}|${topic}|${subjects.join("+")}`
    : `single|${claimSignature(text)}|${salientNumbers(text).join(",")}`;
  const confidence: SignalConfidence = type === "narrative_shift"
    ? (publishers.size >= 3 ? "high" : "medium")
    : (REVISION.test(text) ? "medium" : "low");
  return {
    type,
    direction,
    importance,
    summary: signalSummary(type, direction, items),
    previousState: previousState(state),
    newEvidence: clip(items.map((item) => item.summary.trim()).filter(Boolean).slice(0, 2).join(" "), 160),
    impact: impactOf(direction),
    confidence,
    sources: items,
    dedupeKey: hashKey(material),
    detectedAt: detectedAt(items, now),
  };
}

function signalSummary(type: SignalType, direction: SignalDirection, items: EvidenceItem[]): string {
  const title = clip(shortestTitle(items), 36);
  if (type === "narrative_shift") {
    const word = direction === "bearish" ? "转弱" : direction === "bullish" ? "转强" : "转向";
    return `多家来源同步${word}：${title}`;
  }
  if (type === "expectation_revision") return `单一来源修正了预测：${title}`;
  return `新的证据：${title}`;
}

function previousState(state: WatchState): string {
  if (state.expectationKnown) return state.marketExpectation;
  if (!isSystemNarrative(state.currentNarrative)) return state.currentNarrative;
  return "预期未知。";
}

function sourceOf(item: EvidenceItem): WatchState["baselineSources"][number] {
  return {
    title: item.title.trim(),
    url: item.url,
    summary: clip(item.summary.trim(), 180),
    publishedAt: item.publishedAt,
    publisher: item.publisher,
  };
}

function relates(item: EvidenceItem, lens: WatchLens): boolean {
  const text = blob(item).toLowerCase();
  const haystack = `${lens.question} ${lens.focus.join(" ")}`.toLowerCase();
  const families = FAMILIES.filter((family) => family.some((token) => haystack.includes(token.toLowerCase())));
  const accepted = new Set<string>();
  if (families.length > 0) {
    for (const family of families) for (const token of family) accepted.add(token.toLowerCase());
  } else {
    for (const token of lens.focus) {
      const clean = token.trim().toLowerCase();
      if (clean.length >= 2) accepted.add(clean);
    }
    for (const word of haystack.match(/[a-z][a-z0-9]{2,}/g) ?? []) accepted.add(word);
  }
  if (accepted.size === 0) return true;
  for (const token of accepted) if (text.includes(token)) return true;
  return false;
}

function marketRead(dated: EvidenceItem[]): { narrative: string; expectation: string; expectationKnown: boolean; uncertainties: string[] } {
  const uncertainties: string[] = [];
  const figures = dated.flatMap((item) => priceFigures(blob(item)));
  if (figures.length >= 2) {
    const sorted = [...figures].sort((left, right) => left - right);
    const low = sorted[0] ?? 0;
    const high = sorted[sorted.length - 1] ?? 0;
    if (low > 0 && high / low > 1.1) uncertainties.push("不同来源的价格口径差得比较大，不能并成一个判断。");
  }
  const revisions = dated.filter((item) => REVISION.test(blob(item)) && directionOf(blob(item)) !== "neutral");
  const revisionPublishers = new Set(revisions.map((item) => item.publisher));
  if (revisionPublishers.size === 1) uncertainties.push("只有单一来源调整了预测，还不能当成市场预期。");
  if (dated.length === 0) {
    return { narrative: "相关来源没有可核对的发布日期，还不能概括市场叙事。", expectation: "预期未知。", expectationKnown: false, uncertainties };
  }
  if (dated.length === 1) {
    return { narrative: "只看到一条带日期的相关报道，还不能概括市场叙事。", expectation: "预期未知。", expectationKnown: false, uncertainties };
  }
  const sharedTopics = topicsSharedBy(dated, 2);
  let narrative = sharedTopics.length > 0
    ? `近期相关报道集中在${sharedTopics.slice(0, 3).join("、")}。`
    : "看到多条相关报道，但它们没有集中在同一个问题上，还不能概括市场叙事。";
  const direction = sharedDirection(dated);
  if (direction === "bearish" || direction === "bullish") {
    narrative += direction === "bearish" ? "这些来源偏弱，还不是已经核实的一致预期。" : "这些来源偏强，还不是已经核实的一致预期。";
  }
  const agreed = revisions.filter((item) => directionOf(blob(item)) === directionOf(blob(revisions[0] ?? item)));
  const agreedPublishers = new Set(agreed.map((item) => item.publisher));
  const compatible = agreed.every((item, index) => index === 0 || numbersCompatible(blob(agreed[0] ?? item), blob(item)));
  if (agreedPublishers.size >= 2 && compatible && agreed[0]) {
    return { narrative, expectation: clip(agreed[0].summary, 160), expectationKnown: true, uncertainties };
  }
  return { narrative: clip(narrative, 180), expectation: "预期未知。", expectationKnown: false, uncertainties };
}

function topicsSharedBy(items: EvidenceItem[], minimum: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const topic of new Set(topicsOf(blob(item)))) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= minimum).sort((left, right) => right[1] - left[1]).map(([topic]) => topic);
}

function sharedDirection(items: EvidenceItem[]): SignalDirection {
  const directions = items.map((item) => directionOf(blob(item))).filter((direction) => direction === "bearish" || direction === "bullish");
  const publishers = new Set(items.map((item) => item.publisher));
  if (publishers.size < 2 || directions.length < 2) return "neutral";
  if (directions.every((direction) => direction === "bearish")) return "bearish";
  if (directions.every((direction) => direction === "bullish")) return "bullish";
  return "neutral";
}

function observationSummary(retrieved: number, related: number, heldBack: number): string {
  if (related === 0) return `检查了 ${retrieved} 条信息，没有与观察问题相关的新资料。`;
  const held = heldBack > 0 ? `另有 ${heldBack} 条日期过早或日期不明，未当作新变化。` : "";
  return `检查了 ${retrieved} 条信息，其中 ${related} 条与观察问题相关。${held}暂未发现足以改变当前判断的新证据。`;
}

function publishedStamp(item: EvidenceItem): number | null {
  if (!item.publishedAt) return null;
  const stamp = Date.parse(item.publishedAt);
  return Number.isFinite(stamp) ? stamp : null;
}

function recentEnough(item: EvidenceItem, now: Date): boolean {
  const stamp = publishedStamp(item);
  if (stamp === null) return true;
  return stamp <= now.getTime() + 60_000 && stamp >= now.getTime() - 7 * 86_400_000;
}

function withinWindow(item: EvidenceItem, windowStart: string, now: Date): boolean {
  const stamp = publishedStamp(item);
  if (stamp === null) return false;
  const start = Date.parse(windowStart);
  if (!Number.isFinite(start)) return false;
  return stamp >= start && stamp <= now.getTime() + 60_000;
}

function priceFigures(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/\$\s?(\d{1,2}(?:,\d{3})+|\d{3,5})(?:\.\d+)?/g)) addFigure(found, match[1]);
  for (const match of text.matchAll(/(\d{1,2}(?:,\d{3})+|\d{3,5})(?:\.\d+)?\s*美元/g)) addFigure(found, match[1]);
  return [...found];
}

function addFigure(found: Set<number>, raw: string | undefined): void {
  if (!raw) return;
  const value = Number(raw.replace(/,/g, ""));
  if (Number.isFinite(value) && value >= 100) found.add(value);
}

function remember(state: WatchState, items: EvidenceItem[]): WatchState {
  const known = [...state.knownEvidence];
  for (const item of items) {
    if (known.some((evidence) => evidence.url === item.url)) continue;
    known.push({
      title: item.title.trim(),
      url: item.url,
      publishedAt: item.publishedAt,
      signature: claimSignature(blob(item)),
    });
  }
  return { ...state, knownEvidence: known.slice(-120), uncertainties: [...state.uncertainties] };
}

function blob(item: EvidenceItem): string {
  return `${item.title}\n${item.summary}`;
}

function directionOf(text: string): SignalDirection {
  const bear = BEAR.test(text);
  const bull = BULL.test(text);
  if (bear && bull) return "mixed";
  if (bear) return "bearish";
  if (bull) return "bullish";
  return "neutral";
}

function impactOf(direction: SignalDirection): "supports_thesis" | "weakens_thesis" | "inconclusive" {
  if (direction === "bearish") return "weakens_thesis";
  if (direction === "bullish") return "supports_thesis";
  return "inconclusive";
}

function topicsOf(text: string): string[] {
  return TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
}

function subjectsOf(text: string): string[] {
  const lower = text.toLowerCase();
  return SUBJECTS.filter((subject) => lower.includes(subject.toLowerCase()));
}

function intersection(sets: string[][]): string[] {
  const first = sets[0];
  if (!first) return [];
  return first.filter((value) => sets.every((set) => set.includes(value))).sort();
}

function claimSignature(text: string): string {
  const topic = topicsOf(text)[0] ?? "其他";
  return `${directionOf(text)}|${topic}|${subjectsOf(text).sort().join("+")}`;
}

function salientNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(%|美元|元|倍|个百分点)/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

function numbersCompatible(left: string, right: string): boolean {
  const leftNumbers = salientNumbers(left);
  const rightNumbers = salientNumbers(right);
  if (!leftNumbers.length || !rightNumbers.length) return true;
  return leftNumbers.join() === rightNumbers.join();
}

function claimGrams(text: string): Set<string> {
  const lower = text.normalize("NFKC").toLowerCase();
  const grams = new Set<string>();
  for (const word of lower.match(/[a-z][a-z0-9]{2,}/g) ?? []) grams.add(word);
  const cjk = lower.replace(/[^\u3400-\u9fff]/g, "");
  for (let index = 0; index < cjk.length - 1; index += 1) grams.add(cjk.slice(index, index + 2));
  return grams;
}

function shortestTitle(items: EvidenceItem[]): string {
  return [...items].sort((left, right) => left.title.length - right.title.length)[0]?.title.trim() || "新的证据";
}

function detectedAt(items: EvidenceItem[], now: Date): string {
  const stamps = items
    .map((item) => Date.parse(item.publishedAt ?? ""))
    .filter((stamp) => Number.isFinite(stamp) && stamp <= now.getTime() && stamp >= now.getTime() - 7 * 86_400_000);
  if (!stamps.length) return now.toISOString();
  return new Date(Math.max(...stamps)).toISOString();
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function knownFrom(items: EvidenceItem[]): KnownEvidence[] {
  return items.map((item) => ({
    title: item.title.trim(),
    url: item.url,
    publishedAt: item.publishedAt,
    signature: claimSignature(blob(item)),
  }));
}
