import { describe, expect, it } from "vitest";
import { evaluateBriefing } from "../src/briefings/evaluation.js";
import { InvestmentDatabase } from "../src/storage/database.js";

describe("task run ledger", () => {
  it("persists run status, usage and trace linkage", () => {
    const database = new InvestmentDatabase(":memory:");
    const runId = database.startRun({
      task: "ai-industry-chain",
      mode: "close",
      scheduledAt: "2026-07-20T09:00:00.000Z",
      idempotencyKey: "ai:2026-07-20:close",
    });
    database.setTraceId(runId, "0123456789abcdef0123456789abcdef");
    database.succeedRun({
      runId,
      reportPath: "/tmp/report.md",
      sourceCount: 7,
      warningCount: 1,
      usage: {
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 20,
        cacheWriteTokens: 0, reasoningTokens: 5, cost: 0.0012, costCurrency: "CNY",
      },
    });

    expect(database.getRun(runId)).toMatchObject({
      status: "succeeded",
      traceId: "0123456789abcdef0123456789abcdef",
      sourceCount: 7,
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.0012,
      costCurrency: "CNY",
    });
    database.close();
  });

  it("blocks a duplicate successful schedule unless forced", () => {
    const database = new InvestmentDatabase(":memory:");
    const input = {
      task: "market-briefing" as const,
      mode: "pre-market",
      scheduledAt: "2026-07-20T00:30:00.000Z",
      idempotencyKey: "market:2026-07-20:pre-market",
    };
    const runId = database.startRun(input);
    database.succeedRun({
      runId, reportPath: "/tmp/report.md", sourceCount: 0, warningCount: 0,
      usage: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        reasoningTokens: 0, cost: 0, costCurrency: "USD",
      },
    });
    expect(() => database.startRun(input)).toThrow("already exists");
    expect(database.startRun({ ...input, force: true })).toBeTypeOf("string");
    database.close();
  });
});

describe("briefing evaluation", () => {
  it("detects invalid citations and missing research boundary", () => {
    const results = evaluateBriefing("market-briefing", "A股 港股 美股 政策 地缘 风险 [S2]", [{
      id: "one", category: "A股", title: "One", url: "https://example.com/one",
      summary: "summary", retrievedAt: "2026-07-20T00:00:00.000Z",
    }]);
    expect(results.find((item) => item.evaluator === "citation-validity")?.label).toBe("fail");
    expect(results.find((item) => item.evaluator === "section-coverage")?.label).toBe("pass");
    expect(results.find((item) => item.evaluator === "research-boundary")?.label).toBe("fail");
  });

  it("scores whether a market report is ready for next-session decisions", () => {
    const content = [
      "A股 港股 美股 政策 地缘 风险",
      "成交额 2 万亿元，上涨家数 3000。",
      "原油、美元和美债共同反映风险偏好。",
      "观察方向包含催化、验证信号、失效条件、风险和时间尺度。",
      "信息新鲜度：美股仍为盘中数据，非收盘价。",
      "以上内容仅供研究参考，不构成投资建议。",
    ].join("\n");
    const results = evaluateBriefing("market-briefing", content, []);
    expect(results.find((item) => item.evaluator === "decision-readiness")?.label).toBe("pass");
    expect(results.find((item) => item.evaluator === "time-discipline")?.label).toBe("pass");
  });
});
