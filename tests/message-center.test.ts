import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { MessageCenter } from "../src/notifications/message-center.js";
import { InvestmentDatabase } from "../src/storage/database.js";

describe("message center", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("delivers platform-specific payloads to Feishu and WeCom", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const database = new InvestmentDatabase(":memory:");
    const center = new MessageCenter(loadConfig({
      FEISHU_WEBHOOK_URL: "https://example.com/feishu",
      WECHAT_WEBHOOK_URL: "https://example.com/wechat",
    }), database);

    await center.publish({ runId: null, severity: "info", title: "任务完成", body: "日报正文" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      msg_type: "interactive",
      card: {
        body: {
          elements: [expect.objectContaining({ tag: "markdown" })],
        },
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ msgtype: "text" });
    database.close();
  });

  it("splits a tall Feishu report into numbered Markdown cards", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const database = new InvestmentDatabase(":memory:");
    const center = new MessageCenter(loadConfig({
      FEISHU_WEBHOOK_URL: "https://example.com/feishu",
    }), database);
    const body = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 行巡检结果`).join("\n");

    await center.publish({ runId: null, severity: "info", title: "完整报告", body });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const firstCard = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      card: { body: { elements: Array<{ content: string }> } };
    };
    expect(firstCard.card.body.elements[0]?.content).toContain("第 1/");
    database.close();
  });
});
