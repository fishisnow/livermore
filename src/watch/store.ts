import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  CandidateDraft,
  EvidenceItem,
  QueryScope,
  RunCoverage,
  WatchRecord,
  WatchRun,
  WatchScope,
  WatchSignal,
  WatchState,
  WatchStatus,
} from "./types.js";
import { initialWatchState } from "./types.js";

export interface CheckTarget {
  id: string;
  status: WatchStatus;
  lastCheckedAt: string | null;
  latestFinishedAt: string | null;
}

export interface CompleteRunInput {
  runId: string;
  watchId: string;
  status: "no_change" | "changed" | "failed";
  summary: string | null;
  error: string | null;
  queryScope: QueryScope;
  coverage: RunCoverage;
  state: WatchState | null;
  lastCheckedAt: string | null;
  signals: Array<Omit<WatchSignal, "id" | "watchId" | "runId">>;
}

const STATUSES = new Set<WatchStatus>(["candidate", "active", "paused", "ended"]);

export class WatchStore {
  constructor(private readonly db: DatabaseSync) {}

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  insertWatch(draft: CandidateDraft, status: WatchStatus = "candidate"): WatchRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO watches (
        id, user_id, title, question, scope_json, status, origin, rationale, current_state_json,
        created_at, updated_at, tracking_started_at, last_checked_at, ended_at
      ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(id, draft.title, draft.question, JSON.stringify(draft.scope), status, draft.origin, draft.rationale, JSON.stringify(initialWatchState()), now, now);
    const saved = this.getWatch(id);
    if (!saved) throw new Error("观察没有写入。");
    return saved;
  }

  replaceAiCandidates(drafts: CandidateDraft[]): WatchRecord[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM watches WHERE status = 'candidate' AND origin = 'ai'").run();
      const saved = drafts.map((draft) => this.insertWatch(draft, "candidate"));
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteCandidate(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM watches WHERE id = ? AND status = 'candidate'").run(id).changes) > 0;
  }

  getWatch(id: string): WatchRecord | undefined {
    const row = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id);
    return row ? mapWatch(row) : undefined;
  }

  listByStatus(statuses: WatchStatus[]): WatchRecord[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    return this.db.prepare(`SELECT * FROM watches WHERE status IN (${marks}) ORDER BY updated_at DESC, id`).all(...statuses).map(mapWatch);
  }

  listCheckTargets(): CheckTarget[] {
    return this.db.prepare(`
      SELECT id, status, last_checked_at,
        (SELECT finished_at FROM watch_runs WHERE watch_id = watches.id ORDER BY started_at DESC, rowid DESC LIMIT 1) AS latest_finished_at
      FROM watches WHERE status = 'active'
    `).all().map((row) => {
      const value = row as Record<string, string | null>;
      return {
        id: String(value.id),
        status: "active" as const,
        lastCheckedAt: value.last_checked_at ?? null,
        latestFinishedAt: value.latest_finished_at ?? null,
      };
    });
  }

  activate(id: string, at: string): WatchRecord | undefined {
    const current = this.getWatch(id);
    if (!current || current.status !== "candidate") return undefined;
    this.db.prepare(`
      UPDATE watches
      SET status = 'active', tracking_started_at = ?, updated_at = ?, ended_at = NULL
      WHERE id = ? AND status = 'candidate'
    `).run(at, at, id);
    return this.getWatch(id);
  }

  setStatus(id: string, status: "active" | "paused" | "ended", at: string): WatchRecord | undefined {
    const current = this.getWatch(id);
    if (!current || current.status === "candidate") return undefined;
    if (current.status === "ended") return undefined;
    this.db.prepare("UPDATE watches SET status = ?, updated_at = ?, ended_at = ? WHERE id = ?").run(status, at, status === "ended" ? at : null, id);
    return this.getWatch(id);
  }

  updateQuestion(id: string, question: string, title: string, scope: WatchScope, at: string): WatchRecord | undefined {
    if (!this.getWatch(id)) return undefined;
    this.db.prepare("UPDATE watches SET question = ?, title = ?, scope_json = ?, updated_at = ? WHERE id = ?")
      .run(question, title, JSON.stringify(scope), at, id);
    return this.getWatch(id);
  }

  beginRun(watchId: string, queryScope: QueryScope, coverage: RunCoverage): { runId: string } | { busy: true } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.latestRun(watchId);
      if (latest?.status === "running") {
        const age = Date.now() - Date.parse(latest.startedAt);
        if (age < 15 * 60_000) {
          this.db.exec("ROLLBACK");
          return { busy: true };
        }
        this.db.prepare("UPDATE watch_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
          .run(new Date().toISOString(), "检查中断。", latest.id);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO watch_runs (id, watch_id, started_at, finished_at, status, query_scope_json, coverage_json, summary, error)
        VALUES (?, ?, ?, NULL, 'running', ?, ?, NULL, NULL)
      `).run(id, watchId, now, JSON.stringify(queryScope), JSON.stringify(coverage));
      this.db.exec("COMMIT");
      return { runId: id };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeRun(input: CompleteRunInput): WatchSignal[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE watch_runs
        SET finished_at = ?, status = ?, query_scope_json = ?, coverage_json = ?, summary = ?, error = ?
        WHERE id = ?
      `).run(now, input.status, JSON.stringify(input.queryScope), JSON.stringify(input.coverage), input.summary, input.error, input.runId);
      if ((input.status === "no_change" || input.status === "changed") && input.state && input.lastCheckedAt) {
        this.db.prepare("UPDATE watches SET current_state_json = ?, last_checked_at = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(input.state), input.lastCheckedAt, now, input.watchId);
      }
      const inserted: WatchSignal[] = [];
      for (const signal of input.signals) {
        if (signal.sources.length === 0) continue;
        const id = randomUUID();
        const result = this.db.prepare(`
          INSERT OR IGNORE INTO watch_signals (
            id, watch_id, run_id, type, direction, importance, summary, previous_state, new_evidence,
            impact, confidence, sources_json, dedupe_key, detected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, input.watchId, input.runId, signal.type, signal.direction, signal.importance, signal.summary,
          signal.previousState, signal.newEvidence, signal.impact, signal.confidence, JSON.stringify(signal.sources),
          signal.dedupeKey, signal.detectedAt,
        );
        if (Number(result.changes) > 0) inserted.push({ ...signal, id, watchId: input.watchId, runId: input.runId });
      }
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  failRun(runId: string, error: string, queryScope: QueryScope, coverage: RunCoverage): void {
    this.db.prepare(`
      UPDATE watch_runs
      SET finished_at = ?, status = 'failed', query_scope_json = ?, coverage_json = ?, error = ?
      WHERE id = ? AND status = 'running'
    `).run(new Date().toISOString(), JSON.stringify(queryScope), JSON.stringify(coverage), error, runId);
  }

  latestRun(watchId: string): WatchRun | undefined {
    const row = this.db.prepare("SELECT * FROM watch_runs WHERE watch_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(watchId);
    return row ? mapRun(row) : undefined;
  }

  listRuns(watchId: string, limit = 14): WatchRun[] {
    return this.db.prepare("SELECT * FROM watch_runs WHERE watch_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(watchId, limit).map(mapRun);
  }

  listSignals(watchId: string, limit = 50): WatchSignal[] {
    return this.db.prepare("SELECT * FROM watch_signals WHERE watch_id = ? ORDER BY detected_at DESC, rowid DESC LIMIT ?").all(watchId, limit).map(mapSignal);
  }

  countSignals(watchId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM watch_signals WHERE watch_id = ?").get(watchId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }
}

function mapWatch(row: unknown): WatchRecord {
  const value = row as Record<string, string | null>;
  const status = String(value.status);
  return {
    id: String(value.id),
    userId: String(value.user_id),
    title: String(value.title),
    question: String(value.question),
    scope: readScope(value.scope_json ?? null),
    status: STATUSES.has(status as WatchStatus) ? status as WatchStatus : "ended",
    origin: value.origin === "user" ? "user" : "ai",
    rationale: String(value.rationale ?? ""),
    state: readState(value.current_state_json ?? null),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
    trackingStartedAt: value.tracking_started_at ?? null,
    lastCheckedAt: value.last_checked_at ?? null,
    endedAt: value.ended_at ?? null,
  };
}

function mapRun(row: unknown): WatchRun {
  const value = row as Record<string, string | null>;
  const status = String(value.status);
  return {
    id: String(value.id),
    watchId: String(value.watch_id),
    startedAt: String(value.started_at),
    finishedAt: value.finished_at ?? null,
    status: status === "running" || status === "no_change" || status === "changed" || status === "failed" ? status : "failed",
    queryScope: readQueryScope(value.query_scope_json ?? null),
    coverage: readCoverage(value.coverage_json ?? null),
    summary: value.summary ?? null,
    error: value.error ?? null,
  };
}

function mapSignal(row: unknown): WatchSignal {
  const value = row as Record<string, string | null>;
  return {
    id: String(value.id),
    watchId: String(value.watch_id),
    runId: String(value.run_id),
    type: readEnum(value.type ?? null, ["new_evidence", "expectation_revision", "narrative_shift"] as const, "new_evidence"),
    direction: readEnum(value.direction ?? null, ["bearish", "bullish", "mixed", "neutral"] as const, "neutral"),
    importance: value.importance === "important" ? "important" : "notable",
    summary: String(value.summary),
    previousState: String(value.previous_state),
    newEvidence: String(value.new_evidence),
    impact: readEnum(value.impact ?? null, ["supports_thesis", "weakens_thesis", "inconclusive"] as const, "inconclusive"),
    confidence: readEnum(value.confidence ?? null, ["low", "medium", "high"] as const, "low"),
    sources: readSources(value.sources_json ?? null),
    dedupeKey: String(value.dedupe_key),
    detectedAt: String(value.detected_at),
  };
}

function readEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function readScope(value: string | null): WatchScope {
  const parsed = readJson<Partial<WatchScope>>(value, {});
  return {
    focus: strings(parsed.focus),
    symbols: strings(parsed.symbols),
    sectors: strings(parsed.sectors),
    queries: strings(parsed.queries),
  };
}

function readBaselineSources(value: unknown): WatchState["baselineSources"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<WatchState["baselineSources"][number]>;
    if (typeof source.title !== "string" || typeof source.url !== "string") return [];
    return [{
      title: source.title,
      url: source.url,
      summary: typeof source.summary === "string" ? source.summary : "",
      publishedAt: typeof source.publishedAt === "string" ? source.publishedAt : null,
      publisher: typeof source.publisher === "string" ? source.publisher : "",
    }];
  });
}

function readState(value: string | null): WatchState {
  const parsed = readJson<Partial<WatchState>>(value, {});
  const fallback = initialWatchState();
  return {
    currentNarrative: typeof parsed.currentNarrative === "string" ? parsed.currentNarrative : fallback.currentNarrative,
    marketExpectation: typeof parsed.marketExpectation === "string" ? parsed.marketExpectation : fallback.marketExpectation,
    expectationKnown: typeof parsed.expectationKnown === "boolean"
      ? parsed.expectationKnown
      : !(typeof parsed.marketExpectation === "string" && /^(尚无|预期未知|未知)/.test(parsed.marketExpectation)),
    uncertainties: strings(parsed.uncertainties),
    knownEvidence: Array.isArray(parsed.knownEvidence) ? parsed.knownEvidence.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const evidence = item as Partial<WatchState["knownEvidence"][number]>;
      if (typeof evidence.title !== "string" || typeof evidence.url !== "string" || typeof evidence.signature !== "string") return [];
      return [{
        title: evidence.title,
        url: evidence.url,
        publishedAt: typeof evidence.publishedAt === "string" ? evidence.publishedAt : null,
        signature: evidence.signature,
      }];
    }) : [],
    baselineSources: readBaselineSources(parsed.baselineSources),
    baselined: parsed.baselined === true,
  };
}

function readQueryScope(value: string | null): QueryScope {
  const parsed = readJson<Partial<QueryScope>>(value, {});
  return {
    question: typeof parsed.question === "string" ? parsed.question : "",
    queries: strings(parsed.queries),
    windowStart: typeof parsed.windowStart === "string" ? parsed.windowStart : "",
    windowEnd: typeof parsed.windowEnd === "string" ? parsed.windowEnd : "",
  };
}

function readCoverage(value: string | null): RunCoverage {
  const parsed = readJson<Partial<RunCoverage>>(value, {});
  return {
    windowStart: typeof parsed.windowStart === "string" ? parsed.windowStart : "",
    windowEnd: typeof parsed.windowEnd === "string" ? parsed.windowEnd : "",
    queries: strings(parsed.queries),
    resultCount: numberValue(parsed.resultCount),
    newCount: numberValue(parsed.newCount),
    search: parsed.search === "ok" || parsed.search === "unavailable" || parsed.search === "error" ? parsed.search : "error",
    judgment: parsed.judgment === "baseline" || parsed.judgment === "rules" || parsed.judgment === "skipped" ? parsed.judgment : "skipped",
    note: typeof parsed.note === "string" ? parsed.note : "",
  };
}

function readSources(value: string | null): EvidenceItem[] {
  const parsed = readJson<unknown[]>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<EvidenceItem>;
    if (typeof source.title !== "string" || typeof source.url !== "string") return [];
    return [{
      title: source.title,
      url: source.url,
      summary: typeof source.summary === "string" ? source.summary : "",
      publishedAt: typeof source.publishedAt === "string" ? source.publishedAt : null,
      publisher: typeof source.publisher === "string" ? source.publisher : publisherOf(source.url),
    }];
  });
}

function publisherOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "unknown"; }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; }
  catch { return fallback; }
}
