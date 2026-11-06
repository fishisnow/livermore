import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { MessageCenter } from "../src/notifications/message-center.js";
import { InvestmentDatabase } from "../src/storage/database.js";
import { notificationPreview } from "../src/notifications/macos-channel.js";

describe("message center", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("previews the research content instead of technical delivery metadata", () => {
    const preview = notificationPreview("运行 ID：test\nTrace ID：test\n评估：\ncitation-validity: pass\n\n## 研究结论\n\n风险需要关注。 [来源](https://example.com)");
    expect(preview).toContain("研究结论 风险需要关注");
    expect(preview).not.toContain("citation-validity");
    expect(preview).not.toContain("运行 ID");
  });

  it("delivers platform-specific payloads to Feishu and WeCom", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const database = new InvestmentDatabase(":memory:");
    const center = new MessageCenter(loadConfig({
      MACOS_NOTIFICATIONS_ENABLED: "false",
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
      MACOS_NOTIFICATIONS_ENABLED: "false",
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

  it("keeps a local inbox and records native delivery without Feishu configuration", async () => {
    const database = new InvestmentDatabase(":memory:");
    const send = vi.fn(async () => {});
    const center = new MessageCenter(loadConfig({ MACOS_NOTIFICATIONS_ENABLED: "true" }), database, { macosSend: send });
    const id = await center.publish({ runId: null, severity: "warning", title: "风险汇总", body: "## 简明总结\n\n行情变化。" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id, title: "风险汇总" }));
    expect(database.listAlerts()).toMatchObject([{ id, readAt: null, deliveries: [{ channel: "macos", status: "sent" }] }]);
    expect(database.unreadAlertCount()).toBe(1);
    expect(database.acknowledgeAlert(id)).toBe(true);
    expect(database.unreadAlertCount()).toBe(0);
    expect(database.getAlert(id)?.body).toContain("简明总结");
    database.close();
  });

  it("does not block Feishu or lose the inbox message when Mac permission is denied", async () => {
    const database = new InvestmentDatabase(":memory:");
    const fetchMock = vi.fn(async () => new Response('{"code":0}'));
    vi.stubGlobal("fetch", fetchMock);
    const center = new MessageCenter(loadConfig({ MACOS_NOTIFICATIONS_ENABLED: "true", FEISHU_WEBHOOK_URL: "https://example.com/feishu" }), database, { macosSend: async () => { throw new Error("permission denied"); } });
    const id = await center.publish({ runId: null, severity: "critical", title: "风险", body: "本地保留正文" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(database.getAlert(id)?.deliveries).toMatchObject([{ channel: "macos", status: "failed" }, { channel: "feishu", status: "sent" }]);
    database.close();
  });
});
