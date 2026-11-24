import type { Context, Span } from "@opentelemetry/api";
import type { AppConfig } from "../config.js";
import { Telemetry } from "../observability/telemetry.js";
import type { InvestmentDatabase, RunUsage } from "../storage/database.js";
import { buildQueries, draftFromHoldings, draftFromIdea, formatWatchQuestion, normalizeFocusList, normalizeQuestion, type HoldingRef } from "./draft.js";
import { establishAgentBaseline, establishBaseline, isSystemNarrative, judgeIncremental } from "./judge.js";
import { runWatchCheckAgent, type WatchAgentResult } from "./agent.js";
import type { WatchProgressEvent } from "./progress.js";
import { enrichBaselineState } from "./monitor.js";
import { buildUserIdeaDraft, draftHoldingsWithModel, enrichUserIdeaWithModel, fallbackDrafts, modelConfigured } from "./model.js";
import type { EvidenceItem, QueryScope, RunCoverage, SearchOutcome, WatchRecord, WatchRun, WatchSignal, WatchState } from "./types.js";
import type { WatchNarrativePatch } from "./agent.js";
import { DAILY_CHECK_MINUTE, localDate, localMinutes, shiftDate } from "./time.js";

export class WatchError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export interface SignalNotice {
  question: string;
  summary: string;
  previousState: string;
  newEvidence: string;
  sources: Array<{ title: string; url: string; publishedAt: string | null }>;
}

export interface WatchCheckOptions {
  now?: Date;
  config?: AppConfig;
  database?: InvestmentDatabase;
  telemetry?: Telemetry;
  /** 显式注入时走固定检索 + 规则（测试用）；生产默认由 ReAct Agent 自主调用搜索工具。 */
  search?: (watch: WatchRecord) => Promise<SearchOutcome>;
  runAgent?: (input: {
    config: AppConfig;
    database: InvestmentDatabase;
    watch: WatchRecord;
    windowStart: string;
    windowEnd: string;
    priorSignals: WatchSignal[];
    telemetry?: Telemetry;
    parentContext?: Context;
    onProgress?: (event: WatchProgressEvent) => void;
  }) => Promise<WatchAgentResult>;
  onProgress?: (event: WatchProgressEvent) => void;
  notify?: (notice: SignalNotice) => Promise<void>;
}

type ListedRun = Pick<WatchRun, "id" | "status" | "summary" | "error" | "finishedAt" | "coverage">;

export interface WatchListItem {
  id: string;
  title: string;
  question: string;
  status: WatchRecord["status"];
  origin: WatchRecord["origin"];
  rationale: string;
  scope: WatchRecord["scope"];
  state: WatchState;
  lastCheckedAt: string | null;
  attention: string;
  checkedLabel: string;
  latestRun: ListedRun | null;
  latestSignal: Pick<WatchSignal, "summary" | "detectedAt" | "importance" | "direction" | "type"> | null;
  signalCount: number;
}

export interface RadarList {
  tracking: WatchListItem[];
  ended: WatchListItem[];
  candidates: WatchListItem[];
  modelAvailable: boolean;
}

export interface WatchDetail {
  watch: WatchListItem;
  signals: WatchSignal[];
  runs: WatchRun[];
}

export function listRadar(database: InvestmentDatabase, config: AppConfig, now = new Date()): RadarList {
  ensureCandidates(database);
  const tracking = database.watches.listByStatus(["active", "paused"]).map((watch) => presentWatch(database, watch, now, config.timezone));
  const ended = database.watches.listByStatus(["ended"]).map((watch) => presentWatch(database, watch, now, config.timezone));
  const candidates = database.watches.listByStatus(["candidate"])
    .sort((left, right) => Number(right.origin === "user") - Number(left.origin === "user") || right.createdAt.localeCompare(left.createdAt))
    .map((watch) => presentWatch(database, watch, now, config.timezone));
  return { tracking, ended, candidates, modelAvailable: modelConfigured(config) };
}

export async function refreshCandidates(database: InvestmentDatabase, config: AppConfig, now = new Date()): Promise<RadarList> {
  const holdings = holdingsOf(database);
  const modeled = await draftHoldingsWithModel(config, holdings);
  database.watches.replaceAiCandidates(modeled ?? fallbackDrafts(holdings));
  database.watches.setMeta("watch_candidates_seeded", "1");
  return listRadar(database, config, now);
}

export async function proposeIdea(database: InvestmentDatabase, config: AppConfig, text: string, now = new Date()): Promise<RadarList> {
  const clean = text.trim();
  if (clean.length < 8 || clean.length > 200) throw new WatchError("用一句话写下要跟踪的问题，8 到 200 字。");
  const draft = await buildUserIdeaDraft(config, clean);
  assertNotTracking(database, draft.question);
  const existing = database.watches.listByStatus(["candidate"]).find((watch) => normalizeQuestion(watch.question) === normalizeQuestion(draft.question));
  if (!existing) database.watches.insertWatch(draft, "candidate");
  return listRadar(database, config, now);
}

export function startTracking(database: InvestmentDatabase, id: string, now = new Date()): WatchRecord {
  const candidate = requireWatch(database, id);
  if (candidate.status !== "candidate") throw new WatchError("这个观察已经处理过了。");
  assertNotTracking(database, candidate.question);
  const saved = database.watches.activate(id, now.toISOString());
  if (!saved) throw new WatchError("没有找到这个观察。", 404);
  return saved;
}

export function updateWatchStatus(database: InvestmentDatabase, id: string, status: "active" | "paused" | "ended", now = new Date()): WatchRecord {
  const current = requireWatch(database, id);
  if (current.status === "candidate") throw new WatchError("先开始跟踪，再调整状态。");
  if (current.status === "ended") throw new WatchError("已结束的观察不能恢复。");
  if (status === "active" && current.status === "active") return current;
  if (status === "paused" && current.status !== "active") throw new WatchError("只有正在跟踪的观察可以暂停。");
  const saved = database.watches.setStatus(id, status, now.toISOString());
  if (!saved) throw new WatchError("没有找到这个观察。", 404);
  return saved;
}

export function dismissCandidate(database: InvestmentDatabase, id: string): void {
  if (!database.watches.deleteCandidate(id)) throw new WatchError("只能忽略还没开始跟踪的观察。", 404);
}

export function deleteTrackingWatch(database: InvestmentDatabase, id: string): void {
  const watch = requireWatch(database, id);
  if (watch.status === "candidate") throw new WatchError("候选观察请用忽略。", 400);
  if (!database.watches.deleteWatch(id)) throw new WatchError("没有找到这个观察。", 404);
}

export function updateWatchFocus(database: InvestmentDatabase, config: AppConfig, id: string, focus: string[], now = new Date()): WatchDetail {
  const watch = requireWatch(database, id);
  if (watch.status === "candidate") throw new WatchError("开始跟踪后才能编辑重点监测。");
  const normalized = normalizeFocusList(focus);
  if (normalized.length < 1) throw new WatchError("至少保留一个监测维度，2 到 16 个字。");
  const scope = {
    ...watch.scope,
    focus: normalized,
    queries: buildQueries(watch.question, normalized, watch.scope.symbols),
  };
  const saved = database.watches.updateScope(id, scope, now.toISOString());
  if (!saved) throw new WatchError("没有找到这个观察。", 404);
  return watchDetail(database, config, id, now);
}

export async function regenerateWatchFocus(database: InvestmentDatabase, config: AppConfig, id: string, now = new Date()): Promise<WatchDetail> {
  const watch = requireWatch(database, id);
  if (watch.status === "candidate") throw new WatchError("开始跟踪后才能重新生成重点监测。");
  if (!modelConfigured(config)) throw new WatchError("当前没有可用的模型，无法重新生成。", 503);
  const enrichment = await enrichUserIdeaWithModel(config, watch.question);
  if (!enrichment) throw new WatchError("模型没有返回可用的监测维度，请稍后再试。", 502);
  const symbols = enrichment.symbols.length > 0 ? enrichment.symbols : watch.scope.symbols;
  const sectors = enrichment.sectors.length > 0 ? enrichment.sectors : watch.scope.sectors;
  const scope = {
    ...watch.scope,
    focus: enrichment.focus,
    symbols,
    sectors,
    queries: buildQueries(watch.question, enrichment.focus, symbols),
  };
  const saved = database.watches.updateScope(id, scope, now.toISOString(), enrichment.rationale);
  if (!saved) throw new WatchError("没有找到这个观察。", 404);
  return watchDetail(database, config, id, now);
}

export function updateWatchTheme(database: InvestmentDatabase, config: AppConfig, id: string, text: string, now = new Date()): WatchDetail {
  const watch = requireWatch(database, id);
  const clean = text.trim();
  if (clean.length < 8 || clean.length > 120) throw new WatchError("主题写 8 到 120 字，以一个可对照的问题结尾。");
  const question = formatWatchQuestion(clean);
  const norm = normalizeQuestion(question);
  const duplicate = database.watches.listByStatus(["active", "paused"]).find((item) => item.id !== id && normalizeQuestion(item.question) === norm);
  if (duplicate) throw new WatchError("另一个观察已经在跟踪这个问题。", 409);
  const scope = { ...watch.scope, queries: buildQueries(question, watch.scope.focus, watch.scope.symbols) };
  const title = question.replace(/[？?]$/, "").slice(0, 40);
  const saved = database.watches.updateQuestion(id, question, title, scope, now.toISOString());
  if (!saved) throw new WatchError("没有找到这个观察。", 404);
  return watchDetail(database, config, id, now);
}

export function watchDetail(
  database: InvestmentDatabase,
  config: AppConfig,
  id: string,
  now = new Date(),
  limits: { runs?: number; signals?: number } = {},
): WatchDetail {
  const watch = requireWatch(database, id);
  return {
    watch: presentWatch(database, watch, now, config.timezone),
    signals: database.watches.listSignals(id, limits.signals ?? 50),
    runs: database.watches.listRuns(id, limits.runs ?? 50),
  };
}

export async function checkWatch(database: InvestmentDatabase, watchId: string, options: WatchCheckOptions): Promise<WatchRun> {
  const watch = requireWatch(database, watchId);
  if (watch.status !== "active") throw new WatchError("只有正在跟踪的问题才会检查。");
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const windowEnd = now.toISOString();
  const queryScope: QueryScope = { question: watch.question, queries: watch.scope.queries, windowStart, windowEnd };
  const started = database.watches.beginRun(watchId, queryScope, emptyCoverage(queryScope, "skipped", ""));
  if ("busy" in started) throw new WatchError("这次检查还在进行。", 409);
  try {
    const mode = resolveCheckMode(options);
    const prior = database.watches.listSignals(watchId);
    const priorTexts = prior.flatMap((signal) => [signal.summary, signal.newEvidence, ...signal.sources.map((source) => `${source.title}\n${source.summary}`)]);
    const lens = { question: watch.question, focus: watch.scope.focus, windowStart };

    let scope = queryScope;
    let items: EvidenceItem[] = [];
    let judgmentNote = "";
    let searchStatus: RunCoverage["search"] = "ok";
    let narrativePatch: WatchNarrativePatch | null = null;
    let agentTurns = 0;

    if (mode === "search") {
      options.onProgress?.({ type: "log", text: "正在检索公开信息…" });
    }

    if (mode === "agent") {
      if (!options.database) throw new WatchError("雷达 Agent 检查需要数据库上下文。", 500);
      const config = options.config!;
      const runner = options.runAgent ?? runWatchCheckAgent;
      const ownsTelemetry = !options.telemetry;
      const telemetry = options.telemetry ?? Telemetry.create(config);
      const agentResult = await telemetry.withSpan("watch.check", {
        "openinference.span.kind": "CHAIN",
        "livermore.watch.id": watchId,
        "livermore.watch.question": watch.question,
        "livermore.watch.run.id": started.runId,
      }, async (rootSpan, rootContext) => telemetry.withSpan("watch.agent", {
        "openinference.span.kind": "AGENT",
        "livermore.watch.id": watchId,
        "livermore.watch.max_turns": config.watchAgentMaxTurns,
      }, async (span, parentContext) => {
        const traceId = rootSpan.spanContext().traceId;
        if (traceId !== "00000000000000000000000000000000") {
          rootSpan.setAttribute("livermore.trace.id", traceId);
        }
        const result = await runner({
          config,
          database,
          watch,
          windowStart,
          windowEnd,
          priorSignals: prior,
          telemetry,
          parentContext: parentContext ?? rootContext,
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
        applyWatchAgentUsage(span, result.usage);
        span.setAttributes({
          "livermore.watch.agent.ok": result.ok,
          "livermore.watch.agent.turn_count": result.turnCount,
          "livermore.watch.evidence.count": result.evidence.length,
          "livermore.watch.search.used": result.searchUsed,
        });
        return result;
      }));
      if (ownsTelemetry) await telemetry.forceFlush();
      scope = { ...queryScope, queries: agentResult.queries.length > 0 ? agentResult.queries : watch.scope.queries };
      if (!agentResult.ok) {
        const coverage = emptyCoverage(scope, "skipped", agentResult.message);
        coverage.search = agentResult.searchUsed ? "error" : "unavailable";
        coverage.judgment = "agent";
        database.watches.completeRun({
          runId: started.runId,
          watchId,
          status: "failed",
          summary: null,
          error: agentResult.message,
          queryScope: scope,
          coverage,
          state: null,
          lastCheckedAt: null,
          signals: [],
        });
        return requireRun(database, watchId);
      }
      items = agentResult.evidence;
      judgmentNote = agentResult.agentNote;
      narrativePatch = agentResult.narrativePatch;
      agentTurns = agentResult.turnCount;
      searchStatus = agentResult.searchUsed ? "ok" : (items.length > 0 ? "ok" : "unavailable");
    } else {
      const outcome = await options.search!(watch);
      scope = { ...queryScope, queries: outcome.queries };
      if (!outcome.ok) {
        const coverage = emptyCoverage(scope, "skipped", outcome.message);
        coverage.search = outcome.reason === "unavailable" ? "unavailable" : "error";
        database.watches.completeRun({
          runId: started.runId,
          watchId,
          status: "failed",
          summary: null,
          error: outcome.message,
          queryScope: scope,
          coverage,
          state: null,
          lastCheckedAt: null,
          signals: [],
        });
        return requireRun(database, watchId);
      }
      items = outcome.items;
      judgmentNote = "";
      searchStatus = "ok";
    }

    let judgment = mode === "agent"
      ? (watch.state.baselined && !isSystemNarrative(watch.state.currentNarrative)
        ? judgeIncremental(watch.state, items, priorTexts, now, lens)
        : establishAgentBaseline(watch.state, items))
      : (watch.state.baselined && !isSystemNarrative(watch.state.currentNarrative)
        ? judgeIncremental(watch.state, items, priorTexts, now, lens)
        : establishBaseline(watch.state, items, now, lens));

    if (mode === "agent") {
      const agentSummary = judgmentNote.trim();
      if (agentSummary) judgment = { ...judgment, summary: agentSummary };
    } else if (judgment.baseline && options.config) {
      const evidence = judgment.state.baselineSources.map((source) => ({
        title: source.title,
        url: source.url,
        summary: source.summary,
        publishedAt: source.publishedAt,
        publisher: source.publisher,
      }));
      judgment = {
        ...judgment,
        state: await enrichBaselineState(options.config, { watch, evidence, state: judgment.state }),
        summary: judgment.summary.endsWith("。")
          ? `${judgment.summary.slice(0, -1)}，并由监测 Agent 结合证据与市场环境整理了基线。`
          : `${judgment.summary} 监测 Agent 已结合证据与市场环境整理基线。`,
      };
    }

    if (mode === "agent" && judgment.baseline && narrativePatch) {
      judgment = {
        ...judgment,
        state: {
          ...judgment.state,
          currentNarrative: narrativePatch.currentNarrative,
          marketExpectation: narrativePatch.marketExpectation,
          expectationKnown: narrativePatch.expectationKnown,
          uncertainties: narrativePatch.uncertainties.length > 0 ? narrativePatch.uncertainties : judgment.state.uncertainties,
        },
      };
    }

    const knownUrls = new Set(watch.state.knownEvidence.map((evidence) => evidence.url));
    const coverageJudgment: RunCoverage["judgment"] = mode === "agent"
      ? "agent"
      : (judgment.baseline ? "baseline" : "rules");
  const coverage: RunCoverage = {
      ...emptyCoverage(scope, coverageJudgment, judgment.summary),
      search: searchStatus,
      resultCount: items.length,
      newCount: items.filter((item) => !knownUrls.has(item.url)).length,
      judgment: coverageJudgment,
      note: mode === "agent" ? `${judgment.summary}（Agent ${agentTurns}/${options.config?.watchAgentMaxTurns ?? 32} 轮）` : judgment.summary,
      ...(items.length > 0 ? { evidence: items.slice(0, 20) } : {}),
    };

    const inserted = database.watches.completeRun({
      runId: started.runId,
      watchId,
      status: judgment.signals.length > 0 ? "changed" : "no_change",
      summary: judgment.summary,
      error: null,
      queryScope: scope,
      coverage,
      state: judgment.state,
      lastCheckedAt: windowEnd,
      signals: judgment.signals,
    });
    for (const signal of inserted) {
      if (signal.importance !== "important" || !options.notify) continue;
      try {
        await options.notify({
          question: watch.question,
          summary: signal.summary,
          previousState: signal.previousState,
          newEvidence: signal.newEvidence,
          sources: signal.sources.map((source) => ({ title: source.title, url: source.url, publishedAt: source.publishedAt })),
        });
      } catch (error) {
        console.warn(`雷达通知失败：${error instanceof Error ? error.message : error}`);
      }
    }
    return requireRun(database, watchId);
  } catch (error) {
    if (error instanceof WatchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    database.watches.failRun(started.runId, message, queryScope, emptyCoverage(queryScope, "skipped", message));
    return requireRun(database, watchId);
  }
}

export function isWatchDue(input: {
  status: WatchRecord["status"];
  lastCheckedAt: string | null;
  latestFinishedAt: string | null;
  now: Date;
  timeZone: string;
}): boolean {
  if (input.status !== "active") return false;
  if (localMinutes(input.now, input.timeZone) < DAILY_CHECK_MINUTE) return false;
  if (input.lastCheckedAt && localDate(new Date(input.lastCheckedAt), input.timeZone) === localDate(input.now, input.timeZone)) return false;
  if (input.latestFinishedAt && input.now.getTime() - Date.parse(input.latestFinishedAt) < 30 * 60_000) return false;
  return true;
}

function ensureCandidates(database: InvestmentDatabase): void {
  if (database.watches.getMeta("watch_candidates_seeded") === "1") return;
  database.watches.replaceAiCandidates(draftFromHoldings(holdingsOf(database)));
  database.watches.setMeta("watch_candidates_seeded", "1");
}

function holdingsOf(database: InvestmentDatabase): HoldingRef[] {
  return database.listPositions().map((position) => ({ symbol: position.symbol, name: position.latestName }));
}

function assertNotTracking(database: InvestmentDatabase, question: string): void {
  const norm = normalizeQuestion(question);
  const existing = database.watches.listByStatus(["active", "paused"]).find((watch) => normalizeQuestion(watch.question) === norm);
  if (existing) throw new WatchError("这个问题已经在跟踪。", 409);
}

function requireWatch(database: InvestmentDatabase, id: string): WatchRecord {
  const watch = database.watches.getWatch(id);
  if (!watch) throw new WatchError("没有找到这个观察。", 404);
  return watch;
}

function requireRun(database: InvestmentDatabase, watchId: string): WatchRun {
  const run = database.watches.latestRun(watchId);
  if (!run) throw new Error("检查记录没有写入。");
  return run;
}

function presentWatch(database: InvestmentDatabase, watch: WatchRecord, now: Date, timeZone: string): WatchListItem {
  const latest = database.watches.latestRun(watch.id);
  const signal = database.watches.listSignals(watch.id, 1)[0] ?? null;
  return {
    id: watch.id,
    title: watch.title,
    question: watch.question,
    status: watch.status,
    origin: watch.origin,
    rationale: watch.rationale,
    scope: watch.scope,
    state: watch.state,
    lastCheckedAt: watch.lastCheckedAt,
    attention: attentionLabel(watch, latest, signal, now),
    checkedLabel: checkedLabel(watch.lastCheckedAt, now, timeZone),
    latestRun: latest ? {
      id: latest.id,
      status: latest.status,
      summary: latest.summary,
      error: latest.error,
      finishedAt: latest.finishedAt,
      coverage: latest.coverage,
    } : null,
    latestSignal: signal ? {
      summary: signal.summary,
      detectedAt: signal.detectedAt,
      importance: signal.importance,
      direction: signal.direction,
      type: signal.type,
    } : null,
    signalCount: database.watches.countSignals(watch.id),
  };
}

function attentionLabel(watch: WatchRecord, latest: WatchRun | undefined, signal: WatchSignal | null, now: Date): string {
  const failedAfter = latest?.status === "failed" && latest.finishedAt && (!watch.lastCheckedAt || latest.finishedAt > watch.lastCheckedAt);
  if (latest?.status === "failed" && (!watch.lastCheckedAt || failedAfter)) return "检查失败";
  if (signal && now.getTime() - Date.parse(signal.detectedAt) <= 7 * 86_400_000) return "近期有新变化";
  if (watch.status === "paused") return "已暂停";
  if (watch.status === "ended") return "已结束";
  if (!signal && watch.state.baselined && (latest?.coverage.judgment === "baseline" || latest?.coverage.judgment === "agent")) return "已建立基线";
  if (watch.lastCheckedAt) return "暂无实质变化";
  return "持续监测";
}

function checkedLabel(lastCheckedAt: string | null, now: Date, timeZone: string): string {
  if (!lastCheckedAt) return "尚未完成检查";
  const day = localDate(new Date(lastCheckedAt), timeZone);
  const today = localDate(now, timeZone);
  if (day === today) return "今日已检查";
  if (day === shiftDate(today, -1)) return "昨日已检查";
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日已检查`;
}

function applyWatchAgentUsage(span: Span, usage: RunUsage): void {
  span.setAttributes({
    "gen_ai.usage.input_tokens": usage.inputTokens,
    "gen_ai.usage.output_tokens": usage.outputTokens,
    "gen_ai.usage.cache_read_input_tokens": usage.cacheReadTokens,
    "gen_ai.usage.cache_write_input_tokens": usage.cacheWriteTokens,
    "livermore.cost.amount": usage.cost,
    "livermore.cost.currency": usage.costCurrency,
  });
}

function resolveCheckMode(options: WatchCheckOptions): "agent" | "search" {
  if (options.search) return "search";
  if (options.runAgent || (options.config && modelConfigured(options.config))) return "agent";
  throw new WatchError("雷达立即检查需要已配置的研究模型（PI_API_KEY 与 PI_PROVIDER）。", 503);
}

function emptyCoverage(scope: QueryScope, judgment: RunCoverage["judgment"], note: string): RunCoverage {
  return {
    windowStart: scope.windowStart,
    windowEnd: scope.windowEnd,
    queries: scope.queries,
    resultCount: 0,
    newCount: 0,
    search: "error",
    judgment,
    note,
  };
}
