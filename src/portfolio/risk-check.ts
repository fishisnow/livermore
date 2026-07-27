import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@opentelemetry/api";
import { createInvestmentAgent } from "../agent/create-investment-agent.js";
import type { AppConfig } from "../config.js";
import type { FutuMarketResult } from "../market/futu-client.js";
import type { IwencaiQueryResult } from "../market/iwencai-client.js";
import {
  findNormalizedQuote,
  isMainlandSecurity,
  type NormalizedMarketQuote,
} from "../market/iwencai-normalizer.js";
import { normalizePortfolioMarketData } from "../market/portfolio-market-normalizer.js";
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
  futuResults: FutuMarketResult[];
  iwencaiFundResults: IwencaiQueryResult[];
  usage: RunUsage;
  skillReadCount: number;
  futuQueryCount: number;
  newsQueryCount: number;
  fundFlowQueryCount: number;
}

interface AssessedPosition {
  position: PortfolioPosition;
  name: string;
  currentPrice?: number;
  pnlPct?: number;
  dayChangePct?: number;
  mainNetInflow?: number;
  rsi?: number;
  macd?: number;
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
          futuResults: [],
          iwencaiFundResults: [],
          usage: zeroUsage(options.config.modelCostCurrency),
          skillReadCount: 0,
          futuQueryCount: 0,
          newsQueryCount: 0,
          fundFlowQueryCount: 0,
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
            "livermore.futu.query_count": result.futuQueryCount,
            "livermore.futu.news_query_count": result.newsQueryCount,
            "livermore.iwencai.fund_flow_query_count": result.fundFlowQueryCount,
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
      const rawFutuRowCount = agentResult.futuResults
        .reduce((count, result) => count + result.rows.length, 0);
      const rawIwencaiRowCount = agentResult.iwencaiFundResults
        .reduce((count, result) => count + (result.datas?.length ?? 0), 0);
      const marketQuotes = await telemetry.withSpan("market.normalize", {
        "openinference.span.kind": "CHAIN",
        "livermore.futu.raw_row_count": rawFutuRowCount,
        "livermore.iwencai.fund_flow_raw_row_count": rawIwencaiRowCount,
      }, async (span) => {
        const normalized = normalizePortfolioMarketData(
          agentResult.futuResults,
          agentResult.iwencaiFundResults,
        );
        span.setAttribute("livermore.market.normalized_quote_count", normalized.length);
        return normalized;
      });
      rootSpan.setAttribute("livermore.market.normalized_quote_count", marketQuotes.length);
      const iwencaiQuotaExceeded = agentResult.iwencaiFundResults.some(
        (result) => result.unavailable_reason === "quota_exceeded",
      );
      rootSpan.setAttribute("livermore.iwencai.quota_exceeded", iwencaiQuotaExceeded);
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

      const report = buildReport(
        localDate,
        localTime,
        assessed,
        agentResult.analysis,
        iwencaiQuotaExceeded,
      );
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

      if (positions.length > 0) {
        await telemetry.withSpan("portfolio.summary_delivery", {
          "openinference.span.kind": "TOOL",
          "livermore.portfolio.position_count": positions.length,
          "livermore.portfolio.critical_count": criticalCount,
          "livermore.portfolio.warning_count": warningCount,
        }, async () => {
          await messageCenter.publish({
            runId,
            severity: criticalCount > 0 ? "critical" : warningCount > 0 ? "warning" : "info",
            title: `Livermore 持仓巡检：严重 ${criticalCount} 项 / 警告 ${warningCount} 项`,
            body: buildAlertBody(
              assessed,
              now,
              options.config.timezone,
              agentResult.analysis,
              iwencaiQuotaExceeded,
            ),
          });
        });
      }

      if (alerts.length > 0) {
        await telemetry.withSpan("portfolio.alert", {
          "openinference.span.kind": "TOOL",
          "livermore.alert.position_count": alerts.length,
        }, async () => {
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
      signals: ["Agent 已调用 futuapi，但未返回该持仓的行情数据"],
      rawData: {
        requestedSymbol: position.symbol,
        normalizedQuotes: quotes.map((item) => item.symbol),
      },
    };
  }
  const { currentPrice, dayChangePct, mainNetInflow, rsi, macd } = quote;
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
    ...(rsi === undefined ? {} : { rsi }),
    ...(macd === undefined ? {} : { macd }),
    severity: risk.severity,
    signals: risk.signals,
    rawData: quote,
  };
}

async function runPortfolioAgent(input: PortfolioAgentInput): Promise<PortfolioAgentResult> {
  const futuResults: FutuMarketResult[] = [];
  const iwencaiFundResults: IwencaiQueryResult[] = [];
  const skillsRead = new Set<string>();
  let futuQueryCount = 0;
  let newsQueryCount = 0;
  let fundFlowQueryCount = 0;
  const mainlandSymbols = input.positions
    .map((position) => position.symbol)
    .filter(isMainlandSecurity);
  const tools = createRuntimeTools(input.config, input.database, {
    onSkillRead(name) {
      if (name === "futuapi" || name === "hithink-market-query") skillsRead.add(name);
    },
    onIwencaiResult(_query, result) {
      fundFlowQueryCount += 1;
      iwencaiFundResults.push(result as IwencaiQueryResult);
    },
    onFutuResult(_symbols, result) {
      futuQueryCount += 1;
      futuResults.push(result as FutuMarketResult);
    },
    onFutuNewsResult() {
      newsQueryCount += 1;
    },
  }).filter((tool) => [
    "read_skill",
    "query_futu_market",
    "query_futu_news",
    "query_a_share_main_fund_flow",
  ].includes(tool.name));
  if (!tools.some((tool) => tool.name === "read_skill")) {
    throw new Error("Livermore read_skill tool is unavailable.");
  }
  if (!tools.some((tool) => tool.name === "query_futu_market")) {
    throw new Error("futuapi is not installed or its runtime tool is unavailable.");
  }
  if (!tools.some((tool) => tool.name === "query_futu_news")) {
    throw new Error("futuapi news search is unavailable.");
  }

  const agent = await createInvestmentAgent(input.config, {
    tools,
    includeReportTool: false,
    systemPromptAppend: `你是 Livermore 的持仓风险巡检 Agent。这个任务必须由你驱动已安装 Skill 完成。

必须遵循：
1. 首先调用 read_skill 阅读 futuapi，然后调用 query_futu_market 查询本次全部持仓的最新价、当日涨跌、RSI 和 MACD。
2. 获得行情中的证券简称后，调用 query_futu_news 查询持仓标的的最新新闻、公告或评级。每个标的最多保留 3 条，优先使用发布时间最近且与持仓直接相关的消息；没有结果时明确写“未检索到近期消息”，不得编造。
3. 只有存在沪深京持仓时，才读取 hithink-market-query，并调用 query_a_share_main_fund_flow。该工具只能查询 A 股主力净流入，禁止用它查询价格、涨跌、RSI 或 MACD。
4. 港股不存在本任务定义的“主力净流入”技术指标。禁止把任何港股代码传给 query_a_share_main_fund_flow，禁止在港股分析或表格中要求、展示或推断主力净流入。
5. 如果问财返回 unavailable_reason=quota_exceeded，A 股主力净流入标记为暂不可用并继续完成巡检；不得重试、不得用网页或其他字段替代。
6. 不得用网页搜索替代结构化行情与资讯 Skill，不得编造或跨数据源填补缺失值。
7. 本地持仓的 costBasis 全部是用户维护的复权后单位成本，可直接与 Futu 最新价比较。不得质疑成本是否复权，不得要求用户确认除权、送转、拆股或重新计算复权成本。
8. 最终报告开头必须先输出“## 飞书风险摘要”章节，且该章节不超过 1,200 个中文字符。章节内依次包含：
   - “### 简明总结”：用 2-4 句话概括组合风险，并纳入最多 3 条对持仓最重要的最新消息，注明标的、发布时间和来源；明确区分消息事实与影响推断。
   - “### 风险优先级”：使用 Markdown 表格，列固定为“优先级｜代码｜标的｜操作建议｜核心风险”。覆盖全部持仓并按 P0、P1、P2 排序；操作建议只能是买入、持有或卖出。
9. 在飞书摘要之后输出完整分析，逐只区分事实、推断和待验证项。每只持仓必须给出且只能给出一个明确操作建议：“买入”“持有”或“卖出”；其中买入表示新建或加仓，持有表示维持当前仓位，卖出表示减仓或退出。不得用“观望”“关注”“等待确认”等词替代三选一结论。
10. 每项操作建议必须同时说明：核心理由、执行条件或参考区间、建议失效条件。数据不足时仍需基于已有持仓风险给出最保守的三选一建议，并明确数据缺口。
11. 注明“行情、技术指标与标的资讯：Futu OpenAPI；A股主力资金：同花顺问财（额度不足时暂缺）；港股不适用主力净流入”。
12. 你只提供辅助研判，不决定报警等级，不执行交易。最终风险阈值由确定性代码复核，用户自行决定是否采纳建议。`,
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
  if (!skillsRead.has("futuapi")) throw new Error("Portfolio Agent did not read futuapi before analysis.");
  if (futuQueryCount === 0) throw new Error("Portfolio Agent did not call query_futu_market.");
  if (newsQueryCount === 0) throw new Error("Portfolio Agent did not call query_futu_news.");
  if (mainlandSymbols.length > 0 && (!skillsRead.has("hithink-market-query") || fundFlowQueryCount === 0)) {
    console.warn("A-share main fund-flow query was skipped; continuing the risk check without this optional field.");
  }
  if (!analysis.trim()) throw new Error("Portfolio Agent returned an empty risk analysis.");
  return {
    analysis: analysis.trim(),
    futuResults,
    iwencaiFundResults,
    usage: observation.usage,
    skillReadCount: skillsRead.size,
    futuQueryCount,
    newsQueryCount,
    fundFlowQueryCount,
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

export function buildAgentPrompt(
  positions: PortfolioPosition[],
  date: string,
  time: string,
  timezone: string,
): string {
  const mainlandSymbols = positions
    .map((position) => position.symbol)
    .filter(isMainlandSecurity);
  return `执行 Livermore 持仓风险巡检。

检查时间：${date} ${time.slice(0, 2)}:${time.slice(2)}
时区：${timezone}

本地持仓：
${JSON.stringify(positions.map((position) => ({
    symbol: position.symbol,
    quantity: position.quantity,
    purchasedAt: position.purchasedAt,
    costBasis: position.costBasis,
    costBasisAdjusted: true,
  })), null, 2)}

重要口径：上述 costBasis 均为用户维护的复权后单位成本，可直接与最新价比较；不得再询问或推测成本价是否复权。

必须先读取 futuapi Skill，再通过 query_futu_market 获取全部标的的行情和技术指标。
取得证券简称后，必须调用 query_futu_news 查询全部持仓的最新新闻、公告或评级，并将最重要的消息纳入飞书风险摘要。
${mainlandSymbols.length > 0
    ? `A 股持仓：${mainlandSymbols.join("、")}。仅针对这些代码读取 hithink-market-query，并调用 query_a_share_main_fund_flow 获取主力净流入。`
    : "本次没有 A 股持仓，不得读取或调用同花顺问财。"}
港股不适用“主力净流入”指标：不得查询、展示或推断港股主力净流入。

输出要求：
1. 第一部分必须是“## 飞书风险摘要”，包含 2-4 句简明总结和覆盖全部持仓的风险优先级表格；总结必须包含与持仓直接相关的最新消息。
2. 风险表格列固定为“优先级｜代码｜标的｜操作建议｜核心风险”，按 P0、P1、P2 排序。
3. 摘要后再给出组合整体风险判断和逐只完整分析。
4. 逐只持仓输出：事实、推断、操作建议、执行条件或参考区间、建议失效条件。
5. “操作建议”必须严格从“买入 / 持有 / 卖出”中选择一个，不得使用其他模糊结论。
6. 买入表示新建或加仓，持有表示维持当前仓位，卖出表示减仓或退出。
7. 最终输出只基于工具结果，不构成投资建议。`;
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

function buildReport(
  date: string,
  time: string,
  items: AssessedPosition[],
  agentAnalysis: string,
  iwencaiQuotaExceeded: boolean,
): string {
  const rows = items.map((item) => [
    item.position.symbol,
    item.name,
    formatNumber(item.position.quantity),
    formatMoney(item.position.costBasis),
    item.currentPrice === undefined ? "—" : formatMoney(item.currentPrice),
    item.pnlPct === undefined ? "—" : formatPct(item.pnlPct),
    item.dayChangePct === undefined ? "—" : formatPct(item.dayChangePct),
    item.rsi === undefined ? "—" : item.rsi.toFixed(2),
    item.macd === undefined ? "—" : item.macd.toFixed(4),
    item.mainNetInflow === undefined ? "—" : formatCapital(item.mainNetInflow),
    severityLabel(item.severity),
    item.signals.join("；"),
  ].map(escapeCell).join(" | "));
  return `# Livermore 持仓风险巡检

检查时间：${date} ${time.slice(0, 2)}:${time.slice(2)}

数据来源：最新价、当日涨跌、RSI、MACD 来自 Futu OpenAPI；A 股主力净流入来自同花顺问财${iwencaiQuotaExceeded ? "（本次额度已用完，主力资金字段暂缺）" : ""}。行情可能存在延迟，请以交易所及券商数据为准。

## Agent 辅助研判

${agentAnalysis}

## 确定性风险复核

| 股票代码 | 名称 | 持仓数量 | 成本 | 最新价 | 持仓盈亏 | 当日涨跌 | RSI | MACD | A股主力净流入 | 风险 | 信号 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
${rows.length > 0 ? rows.map((row) => `| ${row} |`).join("\n") : "| — | — | — | — | — | — | — | — | — | — | 正常 | 当前没有持仓 |"}

以上内容仅供研究参考，不构成投资建议。`;
}

function buildAlertBody(
  items: AssessedPosition[],
  now: Date,
  timezone: string,
  agentAnalysis: string,
  iwencaiQuotaExceeded: boolean,
): string {
  const checkedAt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(now);
  const summary = extractFeishuRiskSummary(agentAnalysis) ?? fallbackRiskSummary(items);
  return [
    `检查时间：${checkedAt}`,
    summary,
    `数据：行情/技术指标/资讯来自 Futu OpenAPI；A股主力资金来自同花顺问财${iwencaiQuotaExceeded ? "（本次额度已用完，暂缺）" : ""}；港股不适用主力净流入。`,
    "以上内容仅供研究参考，不构成投资建议。",
  ].join("\n");
}

export function extractFeishuRiskSummary(value: string): string | undefined {
  const heading = value.match(/(?:^|\r?\n)## 飞书风险摘要[^\S\r\n]*\r?\n/);
  if (!heading || heading.index === undefined) return undefined;
  const remainder = value.slice(heading.index + heading[0].length);
  const nextSection = remainder.search(/\r?\n##(?!#)\s/);
  const summary = (nextSection < 0 ? remainder : remainder.slice(0, nextSection)).trim();
  if (!summary) return undefined;
  return summary.length <= 2_500 ? summary : `${summary.slice(0, 2_500).trimEnd()}…`;
}

function fallbackRiskSummary(items: AssessedPosition[]): string {
  const rows = [...items]
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .map((item) => [
      item.severity === "critical" ? "P0" : "P1",
      item.position.symbol,
      item.name,
      item.signals.join("；"),
    ].map(escapeCell).join(" | "));
  return [
    "### 简明总结",
    "本轮已发现需要优先处理的持仓风险；Agent 未返回可提取的精简资讯摘要，请查看本地完整报告。",
    "",
    "### 风险优先级",
    "| 优先级 | 代码 | 标的 | 核心风险 |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
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

function formatCapital(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (absolute >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return value.toFixed(2);
}

function severityLabel(value: Severity): string {
  return ({ normal: "正常", warning: "警告", critical: "严重" })[value];
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
