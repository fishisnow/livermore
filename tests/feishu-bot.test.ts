import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseFeishuCommand } from "../src/feishu/feishu-bot-service.js";
import { feishuMarkdownCard, splitMessage } from "../src/notifications/feishu-app-client.js";
import { MessageCenter } from "../src/notifications/message-center.js";
import { InvestmentDatabase } from "../src/storage/database.js";

describe("Feishu bot integration", () => {
  it("recognizes report subscription commands", () => {
    expect(parseFeishuCommand("订阅日报")).toBe("subscribe");
    expect(parseFeishuCommand(" 取消订阅 ")).toBe("unsubscribe");
    expect(parseFeishuCommand("/subscription")).toBe("subscription-status");
    expect(parseFeishuCommand("帮助")).toBe("help");
    expect(parseFeishuCommand("分析我的持仓")).toBeUndefined();
  });

  it("splits long scheduled reports without losing content", () => {
    const original = `${"A".repeat(30)}\n\n${"B".repeat(30)}`;
    const chunks = splitMessage(original, 40);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(original.replace("\n\n", ""));
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
  });

  it("splits visually tall reports even when their character count is small", () => {
    const original = [
      "## 一、摘要",
      ...Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 行`),
      "## 二、逐只建议",
      ...Array.from({ length: 8 }, (_, index) => `建议 ${index + 1}`),
    ].join("\n");
    const chunks = splitMessage(original, 10_000, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.split("\n").length <= 10)).toBe(true);
    expect(chunks.join("\n")).toContain("## 二、逐只建议");
  });

  it("keeps a position heading with its Markdown table", () => {
    const original = [
      "## 摘要",
      ...Array.from({ length: 8 }, (_, index) => `摘要 ${index + 1}`),
      "",
      "### 600487 亨通光电",
      "",
      "| 维度 | 数据 |",
      "|---|---|",
      "| 操作建议 | 卖出 |",
    ].join("\n");
    const chunks = splitMessage(original, 10_000, 10);
    const recommendation = chunks.find((chunk) => chunk.includes("### 600487"));
    expect(recommendation).toContain("| 维度 | 数据 |");
    expect(recommendation).toContain("| 操作建议 | 卖出 |");
  });

  it("renders scheduled reports with Feishu's native Markdown card component", () => {
    expect(feishuMarkdownCard("## 标题\n- 条目\n**加粗**")).toMatchObject({
      schema: "2.0",
      body: {
        elements: [{
          tag: "markdown",
          content: "## 标题\n- 条目\n**加粗**",
        }],
      },
    });
  });

  it("activates the app notification channel after a Feishu chat is bound", () => {
    const database = new InvestmentDatabase(":memory:");
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
    });
    expect(new MessageCenter(config, database).hasChannels()).toBe(false);
    database.upsertFeishuConversation({
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_user",
      seenAt: "2026-07-28T01:00:00.000Z",
    });
    expect(new MessageCenter(config, database).hasChannels()).toBe(true);
    database.close();
  });
});
