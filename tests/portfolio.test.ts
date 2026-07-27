import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Telemetry } from "../src/observability/telemetry.js";
import {
  buildAgentPrompt,
  evaluateRisk,
  extractFeishuRiskSummary,
  runPortfolioRiskCheck,
} from "../src/portfolio/risk-check.js";
import { InvestmentDatabase } from "../src/storage/database.js";

describe("portfolio ledger", () => {
  it("creates, updates and removes manually maintained positions", () => {
    const database = new InvestmentDatabase(":memory:");
    const created = database.createPosition({
      symbol: "600519.sh",
      quantity: 100,
      purchasedAt: "2026-07-01T01:30:00.000Z",
      costBasis: 1_420.5,
    });

    expect(created).toMatchObject({
      symbol: "600519.SH",
      quantity: 100,
      costBasis: 1_420.5,
      severity: null,
    });

    const updated = database.updatePosition(created.id, {
      symbol: "600519.SH",
      quantity: 200,
      purchasedAt: "2026-07-01T01:30:00.000Z",
      costBasis: 1_400,
    });
    expect(updated).toMatchObject({ quantity: 200, costBasis: 1_400 });
    expect(database.listPositions()).toHaveLength(1);
    expect(database.deletePosition(created.id)).toBe(true);
    expect(database.listPositions()).toEqual([]);
    database.close();
  });

  it("joins the latest risk snapshot into a position", () => {
    const database = new InvestmentDatabase(":memory:");
    const position = database.createPosition({
      symbol: "000001.SZ",
      quantity: 1_000,
      purchasedAt: "2026-07-01T01:30:00.000Z",
      costBasis: 12,
    });
    const runId = database.startRun({
      task: "portfolio-risk-check",
      mode: "hourly",
      scheduledAt: "2026-07-23T02:30:00.000Z",
      idempotencyKey: "portfolio-risk-check:2026-07-23:1000",
    });
    database.savePositionRiskCheck({
      runId,
      positionId: position.id,
      checkedAt: "2026-07-23T02:30:00.000Z",
      name: "平安银行",
      currentPrice: 10.8,
      pnlPct: -10,
      dayChangePct: -3,
      mainNetInflow: -100_000,
      severity: "critical",
      signals: ["持仓亏损达到风险线"],
      rawData: { source: "iwencai" },
    });

    expect(database.getPosition(position.id)).toMatchObject({
      latestName: "平安银行",
      latestPrice: 10.8,
      pnlPct: -10,
      severity: "critical",
      riskSummary: "持仓亏损达到风险线",
      lastCheckedAt: "2026-07-23T02:30:00.000Z",
    });
    database.close();
  });
});

describe("Feishu conversation ledger", () => {
  it("auto-subscribes direct chats and deduplicates inbound messages", () => {
    const database = new InvestmentDatabase(":memory:");
    const conversation = database.upsertFeishuConversation({
      chatId: "oc_direct",
      chatType: "p2p",
      senderId: "ou_user",
      seenAt: "2026-07-28T01:00:00.000Z",
    });
    expect(conversation.subscribedReports).toBe(true);
    expect(database.listFeishuReportRecipients()).toHaveLength(1);
    expect(database.claimFeishuMessage({
      messageId: "om_message",
      chatId: "oc_direct",
      receivedAt: "2026-07-28T01:00:00.000Z",
    })).toBe(true);
    expect(database.claimFeishuMessage({
      messageId: "om_message",
      chatId: "oc_direct",
      receivedAt: "2026-07-28T01:00:01.000Z",
    })).toBe(false);
    expect(database.setFeishuReportSubscription("oc_direct", false)).toBe(true);
    expect(database.listFeishuReportRecipients()).toEqual([]);
    database.close();
  });

  it("does not subscribe a group until explicitly enabled", () => {
    const database = new InvestmentDatabase(":memory:");
    database.upsertFeishuConversation({
      chatId: "oc_group",
      chatType: "group",
      senderId: "ou_user",
      seenAt: "2026-07-28T01:00:00.000Z",
    });
    expect(database.listFeishuReportRecipients()).toEqual([]);
    database.setFeishuReportSubscription("oc_group", true);
    expect(database.listFeishuReportRecipients()[0]).toMatchObject({
      chatId: "oc_group",
      subscribedReports: true,
    });
    database.close();
  });
});

describe("portfolio risk policy", () => {
  it("tells the Agent that costs are adjusted and requires one concrete action per position", () => {
    const prompt = buildAgentPrompt([{
      id: "position-1",
      symbol: "600487.SH",
      quantity: 400,
      purchasedAt: "2026-07-01T01:30:00.000Z",
      costBasis: 102,
      createdAt: "2026-07-01T01:30:00.000Z",
      updatedAt: "2026-07-01T01:30:00.000Z",
      latestName: null,
      latestPrice: null,
      pnlPct: null,
      dayChangePct: null,
      severity: null,
      riskSummary: null,
      lastCheckedAt: null,
    }], "2026-07-28", "1000", "Asia/Shanghai");

    expect(prompt).toContain("复权后单位成本");
    expect(prompt).toContain("\"costBasisAdjusted\": true");
    expect(prompt).toContain("买入 / 持有 / 卖出");
    expect(prompt).toContain("不得再询问或推测成本价是否复权");
    expect(prompt).toContain("港股不适用“主力净流入”指标");
    expect(prompt).toContain("query_futu_news");
  });

  it("extracts only the compact Feishu risk summary from a full Agent report", () => {
    const report = `## 飞书风险摘要
### 简明总结
腾讯发布最新业务更新（2026-07-28，Futu 资讯），对持仓影响偏正面。

### 风险优先级
| 优先级 | 代码 | 标的 | 操作建议 | 核心风险 |
|---|---|---|---|---|
| P0 | 600487 | 亨通光电 | 卖出 | 深度浮亏 |

## 完整分析
这里是不会推送到飞书的长篇分析。`;
    const summary = extractFeishuRiskSummary(report);
    expect(summary).toContain("腾讯发布最新业务更新");
    expect(summary).toContain("| P0 | 600487");
    expect(summary).not.toContain("完整分析");
  });

  it("classifies loss and intraday drawdown thresholds deterministically", () => {
    expect(evaluateRisk({ currentPrice: 10, pnlPct: -4.9, dayChangePct: -1 }).severity).toBe("normal");
    expect(evaluateRisk({ currentPrice: 10, pnlPct: -5, dayChangePct: -1 }).severity).toBe("warning");
    expect(evaluateRisk({ currentPrice: 10, pnlPct: -10, dayChangePct: -1 }).severity).toBe("critical");
    expect(evaluateRisk({ currentPrice: 10, pnlPct: 2, dayChangePct: -7 }).severity).toBe("critical");
  });

  it("warns on missing prices, falling outflows and overheated RSI", () => {
    expect(evaluateRisk({}).signals).toContain("缺少最新价，无法计算持仓盈亏");
    expect(evaluateRisk({
      currentPrice: 10,
      pnlPct: 1,
      dayChangePct: -1,
      mainNetInflow: -1,
    }).signals).toContain("股价下跌且主力资金净流出");
    expect(evaluateRisk({ currentPrice: 10, pnlPct: 1, dayChangePct: 1, rsi: 80 }).severity).toBe("warning");
  });

  it("uses Futu quotes and only Iwencai fund flow while code retains final risk policy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "livermore-portfolio-"));
    const database = new InvestmentDatabase(":memory:");
    database.createPosition({
      symbol: "000001.SZ",
      quantity: 1_000,
      purchasedAt: "2026-07-01T01:30:00.000Z",
      costBasis: 12,
    });
    const config = loadConfig({ TRACING_ENABLED: "false" });
    const telemetry = Telemetry.create(config);
    try {
      const result = await runPortfolioRiskCheck({
        config,
        database,
        telemetry,
        reportDirectory: directory,
        now: new Date("2026-07-24T02:30:00.000Z"),
        runAgent: async () => ({
          analysis: "平安银行价格走弱，需人工复核资金面。行情与技术指标来自 Futu，主力资金来自同花顺问财。",
          futuResults: [{
            source: "futuapi",
            rows: [{
              requestedSymbol: "000001.SZ",
              symbol: "000001.SZ",
              futuCode: "SZ.000001",
              name: "平安银行",
              currentPrice: 10.8,
              dayChangePct: -4.5,
              rsi: 35,
              macd: -0.12,
              raw: { klineCount: 80 },
            }],
          }],
          iwencaiFundResults: [{
            datas: [{
              股票代码: "000001.SZ",
              股票简称: "平安银行",
              "收盘价:不复权[20260724]": "99.99",
              "涨跌幅:前复权[20260724]": "9.99%",
              "主力资金流向[20260724]": "-100000",
            }],
          }],
          usage: {
            inputTokens: 120,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 5,
            cost: 0.002,
            costCurrency: "CNY",
          },
          skillReadCount: 2,
          futuQueryCount: 1,
          newsQueryCount: 1,
          fundFlowQueryCount: 1,
        }),
      });

      expect(result).toMatchObject({ checked: 1, warningCount: 0, criticalCount: 1 });
      expect(database.getRun(result.runId)).toMatchObject({
        inputTokens: 120,
        outputTokens: 40,
        cost: 0.002,
        costCurrency: "CNY",
      });
      expect(database.listPositions()[0]).toMatchObject({
        latestName: "平安银行",
        latestPrice: 10.8,
        severity: "critical",
      });
      const report = await readFile(result.reportPath, "utf8");
      expect(report).toContain("Agent 辅助研判");
      expect(report).not.toContain("99.99");
    } finally {
      await telemetry.shutdown();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues the deterministic review when Iwencai fund-flow quota is exhausted", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "livermore-portfolio-quota-"));
    const database = new InvestmentDatabase(":memory:");
    database.createPosition({
      symbol: "000001.SZ",
      quantity: 100,
      purchasedAt: "2026-07-01T01:30:00.000Z",
      costBasis: 10,
    });
    const config = loadConfig({ TRACING_ENABLED: "false" });
    const telemetry = Telemetry.create(config);
    try {
      const result = await runPortfolioRiskCheck({
        config,
        database,
        telemetry,
        reportDirectory: directory,
        now: new Date("2026-07-24T03:30:00.000Z"),
        runAgent: async () => ({
          analysis: "Futu 行情正常；同花顺问财额度已用完，主力资金暂缺。",
          futuResults: [{
            source: "futuapi",
            rows: [{
              requestedSymbol: "000001.SZ",
              symbol: "000001.SZ",
              name: "平安银行",
              currentPrice: 10.2,
              dayChangePct: 1,
              rsi: 50,
              macd: 0.1,
              raw: { klineCount: 80, indicatorEngine: "Futu OpenD" },
            }],
          }],
          iwencaiFundResults: [{
            success: false,
            query: "000001.SZ 今日主力资金净流入",
            unavailable: true,
            unavailable_reason: "quota_exceeded",
            message: "今天的次数已用完",
            datas: [],
          }],
          usage: {
            inputTokens: 100,
            outputTokens: 30,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            cost: 0,
            costCurrency: "CNY",
          },
          skillReadCount: 2,
          futuQueryCount: 1,
          newsQueryCount: 1,
          fundFlowQueryCount: 1,
        }),
      });

      expect(result).toMatchObject({ checked: 1, warningCount: 0, criticalCount: 0 });
      const report = await readFile(result.reportPath, "utf8");
      expect(report).toContain("本次额度已用完，主力资金字段暂缺");
      expect(database.listPositions()[0]).toMatchObject({
        latestPrice: 10.2,
        severity: "normal",
      });
    } finally {
      await telemetry.shutdown();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
