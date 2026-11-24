export type WatchStatus = "candidate" | "active" | "paused" | "ended";
export type WatchOrigin = "ai" | "user";
export type RunStatus = "running" | "no_change" | "changed" | "failed";
export type SignalType = "new_evidence" | "expectation_revision" | "narrative_shift";
export type SignalDirection = "bearish" | "bullish" | "mixed" | "neutral";
export type SignalImpact = "supports_thesis" | "weakens_thesis" | "inconclusive";
export type SignalConfidence = "low" | "medium" | "high";
export type SignalImportance = "notable" | "important";

export interface WatchScope {
  focus: string[];
  symbols: string[];
  sectors: string[];
  queries: string[];
}

export interface KnownEvidence {
  title: string;
  url: string;
  publishedAt: string | null;
  signature: string;
}

export interface BaselineSource {
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
  publisher: string;
}

export interface WatchState {
  currentNarrative: string;
  marketExpectation: string;
  expectationKnown: boolean;
  uncertainties: string[];
  knownEvidence: KnownEvidence[];
  baselineSources: BaselineSource[];
  baselined: boolean;
}

export interface EvidenceItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
  publisher: string;
}

export interface WatchSignal {
  id: string;
  watchId: string;
  runId: string;
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

export interface QueryScope {
  question: string;
  queries: string[];
  windowStart: string;
  windowEnd: string;
}

export interface RunCoverage {
  windowStart: string;
  windowEnd: string;
  queries: string[];
  resultCount: number;
  newCount: number;
  search: "ok" | "unavailable" | "error";
  judgment: "baseline" | "rules" | "skipped";
  note: string;
}

export interface WatchRun {
  id: string;
  watchId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  queryScope: QueryScope;
  coverage: RunCoverage;
  summary: string | null;
  error: string | null;
}

export interface WatchRecord {
  id: string;
  userId: string;
  title: string;
  question: string;
  scope: WatchScope;
  status: WatchStatus;
  origin: WatchOrigin;
  rationale: string;
  state: WatchState;
  createdAt: string;
  updatedAt: string;
  trackingStartedAt: string | null;
  lastCheckedAt: string | null;
  endedAt: string | null;
}

export interface CandidateDraft {
  title: string;
  question: string;
  rationale: string;
  origin: WatchOrigin;
  scope: WatchScope;
}

export type SearchOutcome =
  | { ok: true; items: EvidenceItem[]; queries: string[] }
  | { ok: false; reason: "unavailable" | "error"; message: string; queries: string[] };

export function initialWatchState(): WatchState {
  return {
    currentNarrative: "还没有从证据里形成市场叙事。",
    marketExpectation: "预期未知。",
    expectationKnown: false,
    uncertainties: [],
    knownEvidence: [],
    baselineSources: [],
    baselined: false,
  };
}

export function emptyScope(): WatchScope {
  return { focus: [], symbols: [], sectors: [], queries: [] };
}
