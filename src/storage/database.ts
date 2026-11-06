import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BriefingTask, SourceItem } from "../briefings/types.js";

export type RunStatus = "running" | "succeeded" | "failed" | "skipped";
export type BuiltinTaskName = BriefingTask | "portfolio-risk-check";
export type CustomTaskName = `custom-${string}`;
export type TaskName = BuiltinTaskName | CustomTaskName;
export interface CustomTask { id: CustomTaskName; title: string; createdAt: string; deletedAt: string | null }
export interface ChatRecord { id: string; title: string; createdAt: string; updatedAt: string; status: string; error: string | null }

export interface NotificationDelivery {
  channel: string;
  status: string;
  errorMessage: string | null;
  attemptedAt: string;
}

export interface AlertRecord {
  id: string;
  runId: string | null;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  deliveries: NotificationDelivery[];
}

export interface StartRunInput {
  task: TaskName;
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
  costCurrency: string;
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
  costCurrency: string;
}

export interface RunEvaluation {
  evaluator: string;
  score: number;
  label: string;
  explanation: string;
}

export interface PortfolioPositionInput {
  symbol: string;
  quantity: number;
  purchasedAt: string;
  costBasis: number;
}

export interface PortfolioPosition extends PortfolioPositionInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  latestName: string | null;
  latestPrice: number | null;
  pnlPct: number | null;
  dayChangePct: number | null;
  severity: "normal" | "warning" | "critical" | null;
  riskSummary: string | null;
  lastCheckedAt: string | null;
}

export interface PositionRiskCheckInput {
  runId: string;
  positionId: string;
  checkedAt: string;
  name?: string;
  currentPrice?: number;
  pnlPct?: number;
  dayChangePct?: number;
  mainNetInflow?: number;
  severity: "normal" | "warning" | "critical";
  signals: string[];
  rawData: unknown;
}

export interface FeishuConversation {
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  subscribedReports: boolean;
  createdAt: string;
  lastMessageAt: string;
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
        cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?, cost = ?, cost_currency = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(), new Date().toISOString(), input.reportPath, input.sourceCount,
      input.warningCount, input.usage.inputTokens, input.usage.outputTokens,
      input.usage.cacheReadTokens, input.usage.cacheWriteTokens, input.usage.reasoningTokens,
      input.usage.cost, input.usage.costCurrency, input.runId,
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

  acquireTaskLock(task: TaskName, owner: string, ttlMs = 30 * 60_000): boolean {
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

  releaseTaskLock(task: TaskName, owner: string): void {
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

  listAlerts(limit = 30): AlertRecord[] {
    return this.db.prepare("SELECT * FROM alerts ORDER BY created_at DESC, rowid DESC LIMIT ?").all(Math.max(1, Math.min(100, limit))).map((row) => this.mapAlert(row));
  }

  getAlert(id: string): AlertRecord | undefined {
    const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id);
    return row ? this.mapAlert(row) : undefined;
  }

  acknowledgeAlert(id: string): boolean {
    return Number(this.db.prepare("UPDATE alerts SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?").run(new Date().toISOString(), id).changes) > 0;
  }

  unreadAlertCount(): number {
    return Number(this.db.prepare("SELECT count(*) AS count FROM alerts WHERE acknowledged_at IS NULL").get()!.count);
  }

  private mapAlert(row: unknown): AlertRecord {
    const value = row as Record<string, string | null>;
    return {
      id: value.id!, runId: value.run_id ?? null, severity: value.severity as AlertRecord["severity"],
      title: value.title!, body: value.body!, createdAt: value.created_at!, readAt: value.acknowledged_at ?? null,
      deliveries: this.db.prepare("SELECT * FROM notification_deliveries WHERE alert_id = ? ORDER BY attempted_at").all(value.id!).map((item) => ({
        channel: String(item.channel), status: String(item.status), errorMessage: item.error_message === null ? null : String(item.error_message), attemptedAt: String(item.attempted_at),
      })),
    };
  }

  getTaskConfiguration(task: TaskName): { value: unknown; revision: number; updatedAt: string } | undefined {
    const row = this.db.prepare("SELECT * FROM task_configurations WHERE task = ?").get(task);
    return row ? { value: JSON.parse(String(row.config_json)), revision: Number(row.revision), updatedAt: String(row.updated_at) } : undefined;
  }

  saveTaskConfiguration(task: TaskName, value: unknown, expectedRevision: number): boolean {
    const result = this.db.prepare(`
      INSERT INTO task_configurations (task, config_json, revision, updated_at) SELECT ?, ?, 1, ? WHERE ? = 0
      ON CONFLICT(task) DO UPDATE SET config_json = excluded.config_json, revision = task_configurations.revision + 1, updated_at = excluded.updated_at
      WHERE task_configurations.revision = ?
    `);
    const now = new Date().toISOString();
    // UPDATE separately: an INSERT ... WHERE false cannot reach ON CONFLICT.
    if (expectedRevision > 0) return Number(this.db.prepare("UPDATE task_configurations SET config_json = ?, revision = revision + 1, updated_at = ? WHERE task = ? AND revision = ?").run(JSON.stringify(value), now, task, expectedRevision).changes) === 1;
    return Number(result.run(task, JSON.stringify(value), now, expectedRevision, expectedRevision).changes) === 1;
  }

  claimScheduledTask(task: TaskName, slot: string): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO task_schedule_dispatches (task, slot, dispatched_at) VALUES (?, ?, ?)").run(task, slot, new Date().toISOString()).changes) === 1;
  }

  releaseScheduledTask(task: TaskName, slot: string): void {
    this.db.prepare("DELETE FROM task_schedule_dispatches WHERE task = ? AND slot = ?").run(task, slot);
  }

  listCustomTasks(): CustomTask[] {
    return this.db.prepare("SELECT * FROM custom_tasks WHERE deleted_at IS NULL ORDER BY created_at, id").all().map((row) => ({ id: String(row.id) as CustomTaskName, title: String(row.title), createdAt: String(row.created_at), deletedAt: null }));
  }

  getCustomTask(id: string): CustomTask | undefined { return this.listCustomTasks().find((item) => item.id === id); }

  createCustomTask(id: CustomTaskName, title: string, settings: unknown): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO custom_tasks (id, title, created_at) VALUES (?, ?, ?)").run(id, title, new Date().toISOString());
      if (!this.saveTaskConfiguration(id, settings, 0)) throw new Error("Task already exists.");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  updateCustomTask(id: CustomTaskName, title: string, settings: unknown, revision: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getCustomTask(id) || !this.saveTaskConfiguration(id, settings, revision)) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("UPDATE custom_tasks SET title = ? WHERE id = ?").run(title, id);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  deleteCustomTask(id: CustomTaskName): boolean {
    return Number(this.db.prepare("UPDATE custom_tasks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(new Date().toISOString(), id).changes) > 0;
  }

  createChat(id = randomUUID()): ChatRecord {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, '新对话', ?, ?)").run(id, now, now);
    return this.getChat(id)!;
  }

  listChats(limit = 100, offset = 0): ChatRecord[] {
    return this.db.prepare("SELECT id, title, created_at, updated_at, status, error FROM chat_sessions ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?").all(Math.max(1, Math.min(100, limit)), Math.max(0, offset)).map(mapChat);
  }

  getChat(id: string): (ChatRecord & { messages: unknown[] }) | undefined {
    const row = this.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id);
    return row ? { ...mapChat(row), messages: JSON.parse(String(row.transcript_json)) as unknown[] } : undefined;
  }

  saveChat(id: string, messages: readonly unknown[], status: string, error: string | null = null): void {
    const first = messages.find((item) => !!item && typeof item === "object" && (item as { role?: unknown }).role === "user") as { content?: unknown } | undefined;
    const title = typeof first?.content === "string" ? first.content : Array.isArray(first?.content) ? first.content.filter((item) => item.type === "text").map((item) => item.text).join("") : "";
    this.db.prepare("UPDATE chat_sessions SET transcript_json = ?, title = CASE WHEN ? != '' THEN ? ELSE title END, status = ?, error = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(messages), title, title.replace(/\s+/g, " ").slice(0, 60), status, error, new Date().toISOString(), id);
  }

  deleteChat(id: string): boolean { return Number(this.db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id).changes) > 0; }

  recoverInterruptedChats(): void { this.db.prepare("UPDATE chat_sessions SET status = 'interrupted', error = '上次回答因服务退出而中断，可继续提问。' WHERE status = 'running'").run(); }

  upsertFeishuConversation(input: {
    chatId: string;
    chatType: "p2p" | "group";
    senderId: string;
    seenAt: string;
  }): FeishuConversation {
    this.db.prepare(`
      INSERT INTO feishu_conversations (
        chat_id, chat_type, sender_id, subscribed_reports, created_at, last_message_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        chat_type = excluded.chat_type,
        sender_id = excluded.sender_id,
        last_message_at = excluded.last_message_at
    `).run(
      input.chatId,
      input.chatType,
      input.senderId,
      input.chatType === "p2p" ? 1 : 0,
      input.seenAt,
      input.seenAt,
    );
    return this.getFeishuConversation(input.chatId)!;
  }

  getFeishuConversation(chatId: string): FeishuConversation | undefined {
    const row = this.db.prepare("SELECT * FROM feishu_conversations WHERE chat_id = ?").get(chatId);
    return row ? mapFeishuConversation(row) : undefined;
  }

  setFeishuReportSubscription(chatId: string, subscribed: boolean): boolean {
    const result = this.db.prepare(`
      UPDATE feishu_conversations SET subscribed_reports = ? WHERE chat_id = ?
    `).run(subscribed ? 1 : 0, chatId);
    return Number(result.changes) > 0;
  }

  listFeishuReportRecipients(): FeishuConversation[] {
    return (this.db.prepare(`
      SELECT * FROM feishu_conversations
      WHERE subscribed_reports = 1
      ORDER BY created_at
    `).all() as unknown[]).map(mapFeishuConversation);
  }

  claimFeishuMessage(input: {
    messageId: string;
    chatId: string;
    receivedAt: string;
  }): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO feishu_messages (message_id, chat_id, received_at)
      VALUES (?, ?, ?)
    `).run(input.messageId, input.chatId, input.receivedAt);
    return Number(result.changes) > 0;
  }

  createPosition(input: PortfolioPositionInput): PortfolioPosition {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO portfolio_positions (id, symbol, quantity, purchased_at, cost_basis, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, normalizeSymbol(input.symbol), input.quantity, input.purchasedAt, input.costBasis, now, now);
    return this.getPosition(id)!;
  }

  updatePosition(id: string, input: PortfolioPositionInput): PortfolioPosition | undefined {
    const result = this.db.prepare(`
      UPDATE portfolio_positions
      SET symbol = ?, quantity = ?, purchased_at = ?, cost_basis = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizeSymbol(input.symbol), input.quantity, input.purchasedAt, input.costBasis, new Date().toISOString(), id);
    return Number(result.changes) > 0 ? this.getPosition(id) : undefined;
  }

  deletePosition(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM portfolio_positions WHERE id = ?").run(id).changes) > 0;
  }

  listPositions(): PortfolioPosition[] {
    return this.db.prepare(`
      SELECT p.*,
        c.name AS latest_name, c.current_price AS latest_price, c.pnl_pct, c.day_change_pct,
        c.severity, c.risk_summary, c.checked_at AS last_checked_at
      FROM portfolio_positions p
      LEFT JOIN position_risk_checks c ON c.id = (
        SELECT latest.id FROM position_risk_checks latest
        WHERE latest.position_id = p.id ORDER BY latest.checked_at DESC LIMIT 1
      )
      ORDER BY p.created_at, p.symbol
    `).all().map(mapPortfolioPosition);
  }

  getPosition(id: string): PortfolioPosition | undefined {
    const row = this.db.prepare(`
      SELECT p.*,
        c.name AS latest_name, c.current_price AS latest_price, c.pnl_pct, c.day_change_pct,
        c.severity, c.risk_summary, c.checked_at AS last_checked_at
      FROM portfolio_positions p
      LEFT JOIN position_risk_checks c ON c.id = (
        SELECT latest.id FROM position_risk_checks latest
        WHERE latest.position_id = p.id ORDER BY latest.checked_at DESC LIMIT 1
      )
      WHERE p.id = ?
    `).get(id);
    return row ? mapPortfolioPosition(row) : undefined;
  }

  savePositionRiskCheck(input: PositionRiskCheckInput): {
    id: string;
    previousSeverity: "normal" | "warning" | "critical" | null;
    lastAlertedAt: string | null;
  } {
    const previous = this.db.prepare(`
      SELECT severity, alerted_at FROM position_risk_checks
      WHERE position_id = ? ORDER BY checked_at DESC LIMIT 1
    `).get(input.positionId) as { severity: "normal" | "warning" | "critical"; alerted_at: string | null } | undefined;
    const lastAlert = this.db.prepare(`
      SELECT alerted_at FROM position_risk_checks
      WHERE position_id = ? AND alerted_at IS NOT NULL ORDER BY alerted_at DESC LIMIT 1
    `).get(input.positionId) as { alerted_at: string } | undefined;
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO position_risk_checks (
        id, run_id, position_id, checked_at, name, current_price, pnl_pct, day_change_pct,
        main_net_inflow, severity, risk_summary, signals_json, raw_data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.runId, input.positionId, input.checkedAt, input.name ?? null,
      input.currentPrice ?? null, input.pnlPct ?? null, input.dayChangePct ?? null,
      input.mainNetInflow ?? null, input.severity, input.signals.join("；"),
      JSON.stringify(input.signals), JSON.stringify(input.rawData).slice(0, 100_000),
    );
    return {
      id,
      previousSeverity: previous?.severity ?? null,
      lastAlertedAt: lastAlert?.alerted_at ?? null,
    };
  }

  markPositionRiskAlerted(ids: string[], alertedAt = new Date().toISOString()): void {
    const statement = this.db.prepare("UPDATE position_risk_checks SET alerted_at = ? WHERE id = ?");
    for (const id of ids) statement.run(alertedAt, id);
  }

  listRuns(limit = 20, task?: TaskName): RunRecord[] {
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
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
        cost_currency TEXT NOT NULL DEFAULT 'USD'
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_started ON task_runs(task, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_runs_key_status ON task_runs(idempotency_key, status);
      CREATE TABLE IF NOT EXISTS task_configurations (
        task TEXT PRIMARY KEY, config_json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        transcript_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'idle', error TEXT
      );
      CREATE TABLE IF NOT EXISTS task_schedule_dispatches (
        task TEXT NOT NULL, slot TEXT NOT NULL, dispatched_at TEXT NOT NULL, PRIMARY KEY(task, slot)
      );
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
      CREATE TABLE IF NOT EXISTS feishu_conversations (
        chat_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL, sender_id TEXT NOT NULL,
        subscribed_reports INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, last_message_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feishu_messages (
        message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feishu_conversations_subscribed
        ON feishu_conversations(subscribed_reports, created_at);
      CREATE TABLE IF NOT EXISTS portfolio_positions (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity > 0),
        purchased_at TEXT NOT NULL, cost_basis REAL NOT NULL CHECK(cost_basis > 0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_portfolio_positions_symbol ON portfolio_positions(symbol);
      CREATE TABLE IF NOT EXISTS position_risk_checks (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        position_id TEXT NOT NULL REFERENCES portfolio_positions(id) ON DELETE CASCADE,
        checked_at TEXT NOT NULL, name TEXT, current_price REAL, pnl_pct REAL, day_change_pct REAL,
        main_net_inflow REAL, severity TEXT NOT NULL, risk_summary TEXT NOT NULL,
        signals_json TEXT NOT NULL, raw_data_json TEXT NOT NULL, alerted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_position_risk_latest
        ON position_risk_checks(position_id, checked_at DESC);
    `);
    const runColumns = this.db.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "cost_currency")) {
      this.db.exec("ALTER TABLE task_runs ADD COLUMN cost_currency TEXT NOT NULL DEFAULT 'USD'");
    }
  }
}

function mapChat(row: unknown): ChatRecord {
  const item = row as Record<string, unknown>;
  return { id: String(item.id), title: String(item.title), createdAt: String(item.created_at), updatedAt: String(item.updated_at), status: String(item.status), error: item.error == null ? null : String(item.error) };
}

function mapPortfolioPosition(row: unknown): PortfolioPosition {
  const value = row as Record<string, string | number | null>;
  return {
    id: String(value.id),
    symbol: String(value.symbol),
    quantity: Number(value.quantity),
    purchasedAt: String(value.purchased_at),
    costBasis: Number(value.cost_basis),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
    latestName: value.latest_name === null ? null : String(value.latest_name),
    latestPrice: nullableNumber(value.latest_price),
    pnlPct: nullableNumber(value.pnl_pct),
    dayChangePct: nullableNumber(value.day_change_pct),
    severity: value.severity === null ? null : value.severity as PortfolioPosition["severity"],
    riskSummary: value.risk_summary === null ? null : String(value.risk_summary),
    lastCheckedAt: value.last_checked_at === null ? null : String(value.last_checked_at),
  };
}

function mapFeishuConversation(row: unknown): FeishuConversation {
  const value = row as Record<string, string | number>;
  return {
    chatId: String(value.chat_id),
    chatType: String(value.chat_type) as FeishuConversation["chatType"],
    senderId: String(value.sender_id),
    subscribedReports: Number(value.subscribed_reports) === 1,
    createdAt: String(value.created_at),
    lastMessageAt: String(value.last_message_at),
  };
}

function nullableNumber(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
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
    costCurrency: value.cost_currency === null || value.cost_currency === undefined
      ? "USD"
      : String(value.cost_currency),
  };
}
