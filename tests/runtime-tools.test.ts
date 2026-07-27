import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { InvestmentDatabase } from "../src/storage/database.js";
import { createRuntimeTools, listSkillDescriptors } from "../src/tools/runtime-tools.js";

describe("interactive Agent runtime tools", () => {
  it("exposes local task runs to the Pi conversation", async () => {
    const database = new InvestmentDatabase(":memory:");
    const runId = database.startRun({
      task: "market-briefing",
      mode: "pre-market",
      scheduledAt: "2026-07-23T00:30:00.000Z",
      idempotencyKey: "market:2026-07-23:pre-market",
    });
    database.succeedRun({
      runId,
      reportPath: "/tmp/report.md",
      sourceCount: 4,
      warningCount: 0,
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 10,
        cost: 0.002,
        costCurrency: "CNY",
      },
    });

    const tool = createRuntimeTools(loadConfig({ TAVILY_MCP_ENABLED: "false" }), database)
      .find((item) => item.name === "list_task_runs");
    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call", { limit: 5 });
    const text = result.content.find((item) => item.type === "text")?.text;
    expect(text).toContain(runId);
    expect(text).toContain('"sourceCount": 4');
    database.close();
  });

  it("discovers only skills from the explicit Livermore skill root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "livermore-skills-"));
    try {
      const skillDirectory = path.join(root, "market-query");
      await mkdir(skillDirectory);
      await writeFile(path.join(skillDirectory, "SKILL.md"), [
        "---",
        "name: hithink-market-query",
        "description: Query structured market data.",
        "---",
        "",
        "# Market query",
      ].join("\n"));
      const skills = await listSkillDescriptors(true, root);
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        name: "hithink-market-query",
        description: "Query structured market data.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the installed Iwencai skill as a constrained market-data tool", async () => {
    const database = new InvestmentDatabase(":memory:");
    const tool = createRuntimeTools(loadConfig({ IWENCAI_API_KEY: "" }), database)
      .find((item) => item.name === "query_iwencai_market");
    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call", { query: "上证指数行情" });
    expect("isError" in result && result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("IWENCAI_API_KEY"),
    });
    database.close();
  });

  it("separates Futu quotes from A-share-only Iwencai fund flow", async () => {
    const database = new InvestmentDatabase(":memory:");
    const tools = createRuntimeTools(loadConfig({}), database);
    expect(tools.find((item) => item.name === "query_futu_market")).toBeDefined();
    expect(tools.find((item) => item.name === "query_futu_news")).toBeDefined();
    const fundFlowTool = tools.find((item) => item.name === "query_a_share_main_fund_flow");
    expect(fundFlowTool).toBeDefined();
    const result = await fundFlowTool!.execute("tool-call", { symbols: ["HK00700"] });
    expect("isError" in result && result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Only mainland"),
    });
    database.close();
  });
});
