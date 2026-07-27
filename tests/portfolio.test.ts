import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Telemetry } from "../src/observability/telemetry.js";
import { evaluateRisk, runPortfolioRiskCheck } from "../src/portfolio/risk-check.js";
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

describe("portfolio risk policy", () => {
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

  it("uses Agent-sourced market rows while code retains final risk policy", async () => {
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
          analysis: "平安银行价格走弱，需人工复核资金面。数据来源：同花顺问财。",
          marketResults: [{
            datas: [{
              股票代码: "000001.SZ",
              股票简称: "平安银行",
              "收盘价:不复权[20260724]": "10.80",
              "涨跌幅:前复权[20260724]": "-4.50%",
              "主力资金流向[20260724]": "-100000",
            }],
          }, {
            datas: [{
              股票代码: "000001.SZ",
              "rsi[20260724]": "35",
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
          skillReadCount: 1,
          marketQueryCount: 1,
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
      expect(await readFile(result.reportPath, "utf8")).toContain("Agent 辅助研判");
    } finally {
      await telemetry.shutdown();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
