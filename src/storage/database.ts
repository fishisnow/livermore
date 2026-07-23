import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BriefingTask, SourceItem } from "../briefings/types.js";

export type RunStatus = "running" | "succeeded" | "failed" | "skipped";

export interface StartRunInput {
  task: BriefingTask;
  mode: string;
  scheduledAt: string;
  idempotencyKey: string;
  force?: boolean;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
}

export interface RunRecord {
  id: string;
  task: string;
  mode: string;
  status: RunStatus;
  scheduledAt: string;
  startedAt: string;
  finishedAt: string | null;
  traceId: string | null;
  reportPath: string | null;
  sourceCount: number;
  warningCount: number;
  durationMs: number | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
}

export interface RunEvaluation {
  evaluator: string;
  score: number;
  label: string;
  explanation: string;
}

export class InvestmentDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  startRun(input: StartRunInput): string {
    if (!input.force) {
      const existing = this.db.prepare(`
        SELECT id FROM task_runs
        WHERE idempotency_key = ? AND status IN ('running', 'succeeded')
        ORDER BY started_at DESC LIMIT 1
      `).get(input.idempotencyKey) as { id: string } | undefined;
      if (existing) throw new Error(`Task run already exists for this schedule: ${existing.id}`);
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO task_runs (id, task, mode, status, scheduled_at, started_at, idempotency_key)
      VALUES (?, ?, ?, 'running', ?, ?, ?)
    `).run(id, input.task, input.mode, input.scheduledAt, new Date().toISOString(), input.idempotencyKey);
    return id;
  }

  setTraceId(runId: string, traceId: string): void {
    this.db.prepare("UPDATE task_runs SET trace_id = ? WHERE id = ?").run(traceId, runId);
  }

  succeedRun(input: {
    runId: string;
    reportPath: string;
    sourceCount: number;
    warningCount: number;
    usage: RunUsage;
  }): void {
    this.db.prepare(`
      UPDATE task_runs SET status = 'succeeded', finished_at = ?,
        duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER),
        report_path = ?, source_count = ?, warning_count = ?, input_tokens = ?, output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?, cost = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(), new Date().toISOString(), input.reportPath, input.sourceCount,
      input.warningCount, input.usage.inputTokens, input.usage.outputTokens,
      input.usage.cacheReadTokens, input.usage.cacheWriteTokens, input.usage.reasoningTokens,
      input.usage.cost, input.runId,
    );
  }

  failRun(runId: string, error: unknown): void {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.db.prepare(`
      UPDATE task_runs SET status = 'failed', finished_at = ?,
        duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER), error_message = ?
      WHERE id = ?
    `).run(finishedAt, finishedAt, message.slice(0, 4000), runId);
  }

  acquireTaskLock(task: BriefingTask, owner: string, ttlMs = 30 * 60_000): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM task_locks WHERE expires_at <= ?").run(now.toISOString());
      this.db.prepare("INSERT INTO task_locks (task, owner, expires_at) VALUES (?, ?, ?)").run(task, owner, expiresAt);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof Error && error.message.includes("UNIQUE constraint")) return false;
      throw error;
    }
  }

  releaseTaskLock(task: BriefingTask, owner: string): void {
    this.db.prepare("DELETE FROM task_locks WHERE task = ? AND owner = ?").run(task, owner);
  }

  unseenSources(task: BriefingTask, localDate: string, sources: SourceItem[]): SourceItem[] {
    const statement = this.db.prepare("SELECT 1 FROM reported_sources WHERE task = ? AND local_date = ? AND source_id = ?");
    return sources.filter((source) => !statement.get(task, localDate, source.id));
  }

  commitSources(task: BriefingTask, localDate: string, sources: SourceItem[], runId: string): void {
    const insertSource = this.db.prepare(`
      INSERT INTO sources (id, url, title, published_at, retrieved_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title,
        published_at = excluded.published_at, retrieved_at = excluded.retrieved_at,
        content_hash = excluded.content_hash
    `);
    const link = this.db.prepare("INSERT OR IGNORE INTO run_sources (run_id, source_id, category) VALUES (?, ?, ?)");
    const report = this.db.prepare("INSERT OR IGNORE INTO reported_sources (task, local_date, source_id, run_id, reported_at) VALUES (?, ?, ?, ?, ?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const source of sources) {
        insertSource.run(
          source.id, source.url, source.title, source.publishedAt ?? null, source.retrievedAt,
          createHash("sha256").update(source.summary).digest("hex"),
        );
        link.run(runId, source.id, source.category);
        report.run(task, localDate, source.id, runId, new Date().toISOString());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveReport(runId: string, reportPath: string, contentHash: string): void {
    this.db.prepare("INSERT INTO reports (id, run_id, path, content_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), runId, reportPath, contentHash, new Date().toISOString());
  }

  saveEvaluation(runId: string, evaluator: string, score: number, label: string, explanation: string): void {
    this.db.prepare(`
      INSERT INTO evaluations (id, run_id, evaluator, score, label, explanation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), runId, evaluator, score, label, explanation, new Date().toISOString());
  }

  saveAlert(runId: string | null, severity: "info" | "warning" | "critical", title: string, body: string): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO alerts (id, run_id, severity, title, body, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'created', ?)
    `).run(id, runId, severity, title, body, new Date().toISOString());
    return id;
  }

  recordNotification(alertId: string, channel: string, status: "sent" | "failed", error?: string): void {
    this.db.prepare(`
      INSERT INTO notification_deliveries (id, alert_id, channel, status, error_message, attempted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), alertId, channel, status, error ?? null, new Date().toISOString());
    if (status === "sent") this.db.prepare("UPDATE alerts SET status = 'sent' WHERE id = ?").run(alertId);
  }

  listRuns(limit = 20, task?: BriefingTask): RunRecord[] {
    const rows = task
      ? this.db.prepare("SELECT * FROM task_runs WHERE task = ? ORDER BY started_at DESC LIMIT ?").all(task, limit)
      : this.db.prepare("SELECT * FROM task_runs ORDER BY started_at DESC LIMIT ?").all(limit);
    return rows.map(mapRunRecord);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(id);
    return row ? mapRunRecord(row) : undefined;
  }

  getRunEvaluations(id: string): RunEvaluation[] {
    return this.db.prepare(`
      SELECT evaluator, score, label, explanation
      FROM evaluations WHERE run_id = ? ORDER BY created_at
    `).all(id).map((row) => {
      const value = row as Record<string, string | number>;
      return {
        evaluator: String(value.evaluator),
        score: Number(value.score),
        label: String(value.label),
        explanation: String(value.explanation),
      };
    });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, task TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
        scheduled_at TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, idempotency_key TEXT NOT NULL,
        trace_id TEXT, report_path TEXT, source_count INTEGER NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER, error_message TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_started ON task_runs(task, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_runs_key_status ON task_runs(idempotency_key, status);
      CREATE TABLE IF NOT EXISTS task_locks (task TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, published_at TEXT,
        retrieved_at TEXT NOT NULL, content_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_sources (
        run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id), category TEXT NOT NULL,
        PRIMARY KEY(run_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS reported_sources (
        task TEXT NOT NULL, local_date TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
        run_id TEXT NOT NULL REFERENCES task_runs(id), reported_at TEXT NOT NULL,
        PRIMARY KEY(task, local_date, source_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id), path TEXT NOT NULL,
        content_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id), evaluator TEXT NOT NULL,
        score REAL NOT NULL, label TEXT NOT NULL, explanation TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY, run_id TEXT REFERENCES task_runs(id), severity TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES alerts(id), channel TEXT NOT NULL,
        status TEXT NOT NULL, error_message TEXT, attempted_at TEXT NOT NULL
      );
    `);
  }
}

function mapRunRecord(row: unknown): RunRecord {
  const value = row as Record<string, string | number | null>;
  return {
    id: String(value.id), task: String(value.task), mode: String(value.mode), status: String(value.status) as RunStatus,
    scheduledAt: String(value.scheduled_at), startedAt: String(value.started_at),
    finishedAt: value.finished_at === null ? null : String(value.finished_at),
    traceId: value.trace_id === null ? null : String(value.trace_id),
    reportPath: value.report_path === null ? null : String(value.report_path),
    sourceCount: Number(value.source_count), warningCount: Number(value.warning_count),
    durationMs: value.duration_ms === null ? null : Number(value.duration_ms),
    errorMessage: value.error_message === null ? null : String(value.error_message),
    inputTokens: Number(value.input_tokens), outputTokens: Number(value.output_tokens),
    cacheReadTokens: Number(value.cache_read_tokens), cacheWriteTokens: Number(value.cache_write_tokens),
    reasoningTokens: Number(value.reasoning_tokens), cost: Number(value.cost),
  };
}
