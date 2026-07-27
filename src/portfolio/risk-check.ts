import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@opentelemetry/api";
import { createInvestmentAgent } from "../agent/create-investment-agent.js";
import type { AppConfig } from "../config.js";
import type { IwencaiQueryResult } from "../market/iwencai-client.js";
import {
  findNormalizedQuote,
  normalizeIwencaiResults,
  type NormalizedMarketQuote,
} from "../market/iwencai-normalizer.js";
import { MessageCenter } from "../notifications/message-center.js";
import { observeAgent, Telemetry } from "../observability/telemetry.js";
import { databasePath, reportsDirectory } from "../project-paths.js";
import {
  InvestmentDatabase,
  type PortfolioPosition,
  type PositionRiskCheckInput,
  type RunUsage,
} from "../storage/database.js";
import { createRuntimeTools } from "../tools/runtime-tools.js";

type Severity = "normal" | "warning" | "critical";

export interface PortfolioRiskResult {
  runId: string;
  traceId: string | undefined;
  reportPath: string;
  checked: number;
  warningCount: number;
  criticalCount: number;
  alertCount: number;
}

export interface PortfolioRiskOptions {
  config: AppConfig;
  now?: Date;
  force?: boolean;
  database?: InvestmentDatabase;
  telemetry?: Telemetry;
  reportDirectory?: string;
  runAgent?: (input: PortfolioAgentInput) => Promise<PortfolioAgentResult>;
}

export interface PortfolioAgentInput {
  config: AppConfig;
  database: InvestmentDatabase;
  telemetry: Telemetry;
  parentContext: Context;
  positions: PortfolioPosition[];
  localDate: string;
  localTime: string;
}

export interface PortfolioAgentResult {
  analysis: string;
  marketResults: IwencaiQueryResult[];
  usage: RunUsage;
  skillReadCount: number;
  marketQueryCount: number;
}

interface AssessedPosition {
  position: PortfolioPosition;
  name: string;
  currentPrice?: number;
  pnlPct?: number;
  dayChangePct?: number;
  mainNetInflow?: number;
  severity: Severity;
  signals: string[];
  rawData: unknown;
  checkId: string;
  shouldAlert: boolean;
}

const zeroUsage = (costCurrency: string): RunUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, cost: 0, costCurrency,
});

export async function runPortfolioRiskCheck(options: PortfolioRiskOptions): Promise<PortfolioRiskResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid portfolio risk-check time.");
  const database = options.database ?? new InvestmentDatabase(databasePath);
  const ownsDatabase = !options.database;
  const telemetry = options.telemetry ?? Telemetry.create(options.config);
  const ownsTelemetry = !options.telemetry;
  const messageCenter = new MessageCenter(options.config, database);
  const localDate = localPart(now, options.config.timezone, "date");
  const localTime = localPart(now, options.config.timezone, "time");
  const slot = `${localTime.slice(0, 2)}00`;
  const runId = database.startRun({
    task: "portfolio-risk-check",
    mode: "hourly",
    scheduledAt: now.toISOString(),
    idempotencyKey: `portfolio-risk-check:${localDate}:${slot}`,
    ...(options.force === undefined ? {} : { force: options.force }),
  });
  let locked = false;

  try {
    locked = database.acquireTaskLock("portfolio-risk-check", runId, 20 * 60_000);
    if (!locked) throw new Error("Portfolio risk check is already running.");
    return await telemetry.withSpan("portfolio.risk_check", {
      "openinference.span.kind": "CHAIN",
      "livermore.run.id": runId,
      "livermore.task": "portfolio-risk-check",
    }, async (rootSpan) => {
      const spanContext = rootSpan.spanContext();
      const traceId = spanContext.traceId !== "00000000000000000000000000000000"
        ? spanContext.traceId
        : undefined;
      if (traceId) database.setTraceId(runId, traceId);

      const positions = database.listPositions();
      rootSpan.setAttribute("livermore.portfolio.position_count", positions.length);
      const agentResult = positions.length === 0
        ? {
          analysis: "当前没有持仓，本轮未调用行情 Skill 或模型。",
          marketResults: [],
          usage: zeroUsage(options.config.modelCostCurrency),
          skillReadCount: 0,
          marketQueryCount: 0,
        }
        : await telemetry.withSpan("agent.run", {
          "openinference.span.kind": "AGENT",
          "livermore.task": "portfolio-risk-check",
          "livermore.portfolio.position_count": positions.length,
        }, async (span, parentContext) => {
          const result = await (options.runAgent ?? runPortfolioAgent)({
            config: options.config,
            database,
            telemetry,
            parentContext,
            positions,
            localDate,
            localTime,
          });
          span.setAttributes({
            "livermore.skill.read_count": result.skillReadCount,
            "livermore.market.query_count": result.marketQueryCount,
            "gen_ai.usage.input_tokens": result.usage.inputTokens,
            "gen_ai.usage.output_tokens": result.usage.outputTokens,
            ...(result.usage.costCurrency === "USD"
              ? { "gen_ai.usage.cost": result.usage.cost }
              : {}),
            "livermore.cost.amount": result.usage.cost,
            "livermore.cost.currency": result.usage.costCurrency,
            ...(telemetry.captureContent ? {
              "output.value": truncateTraceContent(result.analysis),
              "output.mime_type": "text/plain",
            } : {}),
          });
          return result;
        });
      const rawMarketRowCount = agentResult.marketResults
        .reduce((count, result) => count + (result.datas?.length ?? 0), 0);
      const marketQuotes = await telemetry.withSpan("market.normalize", {
        "openinference.span.kind": "CHAIN",
        "livermore.market.raw_row_count": rawMarketRowCount,
      }, async (span) => {
        const normalized = normalizeIwencaiResults(agentResult.marketResults);
        span.setAttribute("livermore.market.normalized_quote_count", normalized.length);
        return normalized;
      });
      rootSpan.setAttribute("livermore.market.normalized_quote_count", marketQuotes.length);
      const assessed: AssessedPosition[] = [];
      for (const position of positions) {
        assessed.push(await telemetry.withSpan("portfolio.position_check", {
          "openinference.span.kind": "CHAIN",
          "livermore.position.id": position.id,
          "livermore.position.symbol": position.symbol,
        }, async (span) => {
          const value = assessPosition(position, marketQuotes);
          span.setAttributes({
            "livermore.risk.severity": value.severity,
            "livermore.risk.signal_count": value.signals.length,
            ...(value.pnlPct === undefined ? {} : { "livermore.position.pnl_pct": value.pnlPct }),
            ...(value.dayChangePct === undefined ? {} : { "livermore.position.day_change_pct": value.dayChangePct }),
          });
          const saved = database.savePositionRiskCheck({
            runId,
            positionId: position.id,
            checkedAt: now.toISOString(),
            name: value.name,
            ...(value.currentPrice === undefined ? {} : { currentPrice: value.currentPrice }),
            ...(value.pnlPct === undefined ? {} : { pnlPct: value.pnlPct }),
            ...(value.dayChangePct === undefined ? {} : { dayChangePct: value.dayChangePct }),
            ...(value.mainNetInflow === undefined ? {} : { mainNetInflow: value.mainNetInflow }),
            severity: value.severity,
            signals: value.signals,
            rawData: value.rawData,
          });
          return {
            ...value,
            position,
            checkId: saved.id,
            shouldAlert: shouldSendAlert(value.severity, saved.previousSeverity, saved.lastAlertedAt, now),
          };
        }));
      }

      const report = buildReport(localDate, localTime, assessed, agentResult.analysis);
      const reportPath = await persistReport(
        runId,
        localDate,
        localTime,
        report,
        database,
        options.reportDirectory ?? reportsDirectory,
      );
      const warningCount = assessed.filter((item) => item.severity === "warning").length;
      const criticalCount = assessed.filter((item) => item.severity === "critical").length;
      const alerts = assessed.filter((item) => item.shouldAlert);

      if (alerts.length > 0) {
        await telemetry.withSpan("portfolio.alert", {
          "openinference.span.kind": "TOOL",
          "livermore.alert.position_count": alerts.length,
        }, async () => {
          await messageCenter.publish({
            runId,
            severity: criticalCount > 0 ? "critical" : "warning",
            title: `Livermore 持仓风险提醒：${alerts.length} 项`,
            body: buildAlertBody(alerts, now, options.config.timezone, agentResult.analysis),
          });
          database.markPositionRiskAlerted(alerts.map((item) => item.checkId), now.toISOString());
        });
      }

      database.succeedRun({
        runId,
        reportPath,
        sourceCount: positions.length,
        warningCount: warningCount + criticalCount,
        usage: agentResult.usage,
      });
      return {
        runId,
        traceId,
        reportPath,
        checked: positions.length,
        warningCount,
        criticalCount,
        alertCount: alerts.length,
      };
    });
  } catch (error) {
    database.failRun(runId, error);
    await messageCenter.publish({
      runId,
      severity: "critical",
      title: "Livermore 持仓巡检失败",
      body: `运行 ID：${runId}\n错误：${error instanceof Error ? error.message : String(error)}`,
    }).catch(() => undefined);
    throw error;
  } finally {
    if (locked) database.releaseTaskLock("portfolio-risk-check", runId);
    await telemetry.forceFlush();
    if (ownsTelemetry) await telemetry.shutdown();
    if (ownsDatabase) database.close();
  }
}

function assessPosition(
  position: PortfolioPosition,
  quotes: NormalizedMarketQuote[],
): Omit<AssessedPosition, "position" | "checkId" | "shouldAlert"> {
  const quote = findNormalizedQuote(quotes, position.symbol);
  if (!quote) {
    return {
      name: position.symbol,
      severity: "warning",
      signals: ["Agent 已调用同花顺问财，但未返回该持仓的行情数据"],
      rawData: {
        requestedSymbol: position.symbol,
        normalizedQuotes: quotes.map((item) => item.symbol),
      },
    };
  }
  const { currentPrice, dayChangePct, mainNetInflow, rsi } = quote;
  const name = quote.name ?? position.symbol;
  const pnlPct = currentPrice === undefined
    ? undefined
    : roundPercentage(((currentPrice - position.costBasis) / position.costBasis) * 100);
  const risk = evaluateRisk({
    ...(currentPrice === undefined ? {} : { currentPrice }),
    ...(pnlPct === undefined ? {} : { pnlPct }),
    ...(dayChangePct === undefined ? {} : { dayChangePct }),
    ...(mainNetInflow === undefined ? {} : { mainNetInflow }),
    ...(rsi === undefined ? {} : { rsi }),
  });
  return {
    name,
    ...(currentPrice === undefined ? {} : { currentPrice }),
    ...(pnlPct === undefined ? {} : { pnlPct }),
    ...(dayChangePct === undefined ? {} : { dayChangePct }),
    ...(mainNetInflow === undefined ? {} : { mainNetInflow }),
    severity: risk.severity,
    signals: risk.signals,
    rawData: quote,
  };
}

async function runPortfolioAgent(input: PortfolioAgentInput): Promise<PortfolioAgentResult> {
  const marketResults: IwencaiQueryResult[] = [];
  let skillReadCount = 0;
  let marketQueryCount = 0;
  const tools = createRuntimeTools(input.config, input.database, {
    onSkillRead(name) {
      if (name === "hithink-market-query") skillReadCount += 1;
    },
    onIwencaiResult(_query, result) {
      marketQueryCount += 1;
      marketResults.push(result as IwencaiQueryResult);
    },
  }).filter((tool) => tool.name === "read_skill" || tool.name === "query_iwencai_market");
  if (!tools.some((tool) => tool.name === "read_skill")) {
    throw new Error("Livermore read_skill tool is unavailable.");
  }
  if (!tools.some((tool) => tool.name === "query_iwencai_market")) {
    throw new Error("hithink-market-query is not installed or its runtime tool is unavailable.");
  }

  const agent = await createInvestmentAgent(input.config, {
    tools,
    includeReportTool: false,
    systemPromptAppend: `你是 Livermore 的持仓风险巡检 Agent。这个任务必须由你驱动已安装 Skill 完成。

必须遵循：
1. 首先调用 read_skill，name 必须是 hithink-market-query。
2. 阅读 Skill 返回内容后，调用 query_iwencai_market 查询本次全部持仓。查询必须包含每个股票代码、最新价、涨跌幅、主力净流入、RSI 和 MACD；如一次查询不能覆盖，拆分调用。
3. 不得用网页搜索替代结构化行情 Skill，不得编造缺失数据。
4. 最终用简洁 Markdown 给出整体风险解释，逐只区分事实、推断和待验证项，并明确“数据来源：同花顺问财”。
5. 你只提供辅助研判，不决定报警等级，不执行交易。最终风险阈值由确定性代码复核。`,
  });
  const prompt = buildAgentPrompt(input.positions, input.localDate, input.localTime, input.config.timezone);
  const observation = observeAgent(agent, input.telemetry, input.parentContext);
  try {
    await agent.prompt(prompt);
  } finally {
    observation.unsubscribe();
  }
  const analysis = finalAssistantText(agent.state.messages);
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  if (skillReadCount === 0) throw new Error("Portfolio Agent did not read hithink-market-query before analysis.");
  if (marketQueryCount === 0) throw new Error("Portfolio Agent did not call query_iwencai_market.");
  if (marketResults.flatMap((result) => result.datas ?? []).length === 0) {
    throw new Error("Iwencai Skill returned no portfolio market rows.");
  }
  if (!analysis.trim()) throw new Error("Portfolio Agent returned an empty risk analysis.");
  return {
    analysis: analysis.trim(),
    marketResults,
    usage: observation.usage,
    skillReadCount,
    marketQueryCount,
  };
}

function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    return content.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join("\n").trim();
  }
  return "";
}

function buildAgentPrompt(
  positions: PortfolioPosition[],
  date: string,
  time: string,
  timezone: string,
): string {
  return `执行 Livermore 持仓风险巡检。

检查时间：${date} ${time.slice(0, 2)}:${time.slice(2)}
时区：${timezone}

本地持仓：
${JSON.stringify(positions.map((position) => ({
    symbol: position.symbol,
    quantity: position.quantity,
    purchasedAt: position.purchasedAt,
    costBasis: position.costBasis,
  })), null, 2)}

必须先读取 hithink-market-query Skill，再通过 query_iwencai_market 获取这些标的的当前结构化行情。最终输出只基于工具结果，不构成投资建议。`;
}

export function evaluateRisk(input: {
  currentPrice?: number;
  pnlPct?: number;
  dayChangePct?: number;
  mainNetInflow?: number;
  rsi?: number;
}): { severity: Severity; signals: string[] } {
  const signals: string[] = [];
  let severity: Severity = "normal";
  const raise = (next: Severity, message: string) => {
    signals.push(message);
    if (severityRank(next) > severityRank(severity)) severity = next;
  };
  if (input.currentPrice === undefined) raise("warning", "缺少最新价，无法计算持仓盈亏");
  if (input.pnlPct !== undefined && input.pnlPct <= -10) raise("critical", `持仓亏损 ${formatPct(input.pnlPct)}，达到 10% 风险线`);
  else if (input.pnlPct !== undefined && input.pnlPct <= -5) raise("warning", `持仓亏损 ${formatPct(input.pnlPct)}，达到 5% 观察线`);
  if (input.dayChangePct !== undefined && input.dayChangePct <= -7) raise("critical", `当日下跌 ${formatPct(input.dayChangePct)}，接近极端波动`);
  else if (input.dayChangePct !== undefined && input.dayChangePct <= -4) raise("warning", `当日下跌 ${formatPct(input.dayChangePct)}，波动显著`);
  if (input.mainNetInflow !== undefined && input.mainNetInflow < 0 && (input.dayChangePct ?? 0) < 0) {
    raise("warning", "股价下跌且主力资金净流出");
  }
  if (input.rsi !== undefined && input.rsi >= 80) raise("warning", `RSI ${input.rsi.toFixed(1)}，存在短期过热风险`);
  if (signals.length === 0) signals.push("未触发预设价格、盈亏、资金或技术风险线");
  return { severity, signals };
}

function shouldSendAlert(
  current: Severity,
  previous: Severity | null,
  lastAlertedAt: string | null,
  now: Date,
): boolean {
  if (current === "normal") return false;
  if (!previous || severityRank(current) > severityRank(previous)) return true;
  if (!lastAlertedAt) return true;
  return now.getTime() - new Date(lastAlertedAt).getTime() >= 4 * 60 * 60_000;
}

function severityRank(value: Severity): number {
  return ({ normal: 0, warning: 1, critical: 2 })[value];
}

async function persistReport(
  runId: string,
  date: string,
  time: string,
  report: string,
  database: InvestmentDatabase,
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${date}-${time}-portfolio-risk-check-${runId.slice(0, 8)}.md`);
  await writeFile(target, `${report.trim()}\n`, "utf8");
  database.saveReport(runId, target, createHash("sha256").update(report).digest("hex"));
  return target;
}

function buildReport(date: string, time: string, items: AssessedPosition[], agentAnalysis: string): string {
  const rows = items.map((item) => [
    item.position.symbol,
    item.name,
    formatNumber(item.position.quantity),
    formatMoney(item.position.costBasis),
    item.currentPrice === undefined ? "—" : formatMoney(item.currentPrice),
    item.pnlPct === undefined ? "—" : formatPct(item.pnlPct),
    item.dayChangePct === undefined ? "—" : formatPct(item.dayChangePct),
    severityLabel(item.severity),
    item.signals.join("；"),
  ].map(escapeCell).join(" | "));
  return `# Livermore 持仓风险巡检

检查时间：${date} ${time.slice(0, 2)}:${time.slice(2)}

数据来源：同花顺问财。行情可能存在延迟，请以交易所及券商数据为准。

## Agent 辅助研判

${agentAnalysis}

## 确定性风险复核

| 股票代码 | 名称 | 持仓数量 | 成本 | 最新价 | 持仓盈亏 | 当日涨跌 | 风险 | 信号 |
|---|---|---:|---:|---:|---:|---:|---|---|
${rows.length > 0 ? rows.map((row) => `| ${row} |`).join("\n") : "| — | — | — | — | — | — | — | 正常 | 当前没有持仓 |"}

以上内容仅供研究参考，不构成投资建议。`;
}

function buildAlertBody(
  items: AssessedPosition[],
  now: Date,
  timezone: string,
  agentAnalysis: string,
): string {
  const checkedAt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(now);
  return [
    `检查时间：${checkedAt}`,
    "数据来源：同花顺问财",
    "",
    ...items.map((item) => [
      `${severityIcon(item.severity)} ${item.name}（${item.position.symbol}）`,
      `最新价：${item.currentPrice === undefined ? "暂无" : formatMoney(item.currentPrice)}；成本：${formatMoney(item.position.costBasis)}；持仓盈亏：${item.pnlPct === undefined ? "暂无" : formatPct(item.pnlPct)}`,
      `风险：${item.signals.join("；")}`,
    ].join("\n")),
    "",
    "Agent 辅助研判：",
    truncateAlertAnalysis(agentAnalysis),
    "",
    "以上内容仅供研究参考，不构成投资建议。",
  ].join("\n");
}

function truncateAlertAnalysis(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 1_500 ? normalized : `${normalized.slice(0, 1_500)}…`;
}

function truncateTraceContent(value: string): string {
  return value.length <= 100_000 ? value : `${value.slice(0, 100_000)}…[truncated]`;
}

function localPart(date: Date, timezone: string, kind: "date" | "time"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: kind === "date" ? "numeric" : undefined,
    month: kind === "date" ? "2-digit" : undefined,
    day: kind === "date" ? "2-digit" : undefined,
    hour: kind === "time" ? "2-digit" : undefined,
    minute: kind === "time" ? "2-digit" : undefined,
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return kind === "date"
    ? `${get("year")}-${get("month")}-${get("day")}`
    : `${get("hour") === "24" ? "00" : get("hour")}${get("minute")}`;
}

function formatPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function roundPercentage(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function severityLabel(value: Severity): string {
  return ({ normal: "正常", warning: "警告", critical: "严重" })[value];
}

function severityIcon(value: Severity): string {
  return ({ normal: "🟢", warning: "⚠️", critical: "🔴" })[value];
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
