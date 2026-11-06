import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Agent } from "@earendil-works/pi-agent-core";
import { InvestmentDatabase } from "../src/storage/database.js";
import { PersistentChatSessions, visibleChatMessages } from "../src/chat/persistent-sessions.js";

describe("durable chat history", () => {
  it("keeps previous conversations and tool context across database and agent restarts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "livermore-history-"));
    const filename = path.join(directory, "test.db");
    const transcript = [{ role: "user", content: "记住：测试代号 alpha", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "已记住" }, { type: "toolCall", id: "1", name: "read", arguments: {} }], timestamp: 2 }, { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "工具上下文" }] }];
    let db = new InvestmentDatabase(filename);
    const chat = db.createChat(); db.saveChat(chat.id, transcript, "idle");
    const next = db.createChat(); expect(next.id).not.toBe(chat.id);
    db.close(); db = new InvestmentDatabase(filename);
    try {
      expect(db.listChats()).toHaveLength(2);
      const fake = { state: { messages: [] }, abort: vi.fn(), waitForIdle: async () => {} } as unknown as Agent;
      const manager = new PersistentChatSessions(db, async () => fake);
      const restored = await manager.acquire(chat.id);
      expect(restored.state.messages).toEqual(transcript);
      expect(restored.sessionId).toBe(chat.id);
      expect(visibleChatMessages(transcript)).toEqual([{ role: "user", text: "记住：测试代号 alpha", error: null }, { role: "assistant", text: "已记住", error: null }]);
      expect(() => manager.delete(chat.id)).toThrow("等待");
      manager.release(chat.id); expect(manager.delete(chat.id)).toBe(true);
      expect(db.getChat(chat.id)).toBeUndefined(); expect(db.getChat(next.id)).toBeDefined();
      await expect(manager.acquire(chat.id)).rejects.toThrow("不存在");
    } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("reserves a session before async provider creation and recovers interrupted runs", async () => {
    const db = new InvestmentDatabase(":memory:"); const record = db.createChat();
    const factory = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { state: { messages: [] } } as unknown as Agent; });
    const manager = new PersistentChatSessions(db, factory);
    const first = manager.acquire(record.id);
    await expect(manager.acquire(record.id)).rejects.toMatchObject({ statusCode: 409 });
    await first; manager.release(record.id); await manager.acquire(record.id);
    expect(factory).toHaveBeenCalledTimes(1);
    db.saveChat(record.id, [{ role: "user", content: "未完成的问题" }], "running"); db.recoverInterruptedChats();
    expect(db.getChat(record.id)).toMatchObject({ status: "interrupted", title: "未完成的问题" });
    db.close();
  });
});
