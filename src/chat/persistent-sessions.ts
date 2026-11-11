import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { InvestmentDatabase } from "../storage/database.js";

export class ChatSessionError extends Error { constructor(message: string, readonly statusCode: number) { super(message); } }
interface LoadedSession { agent?: Agent; busy: boolean; lastUsedAt: number }
export class PersistentChatSessions {
  private readonly loaded = new Map<string, LoadedSession>();
  constructor(private readonly database: InvestmentDatabase, private readonly createAgent: () => Promise<Agent>) {}
  async acquire(id: string): Promise<Agent> {
    const stored = this.database.getChat(id);
    if (!stored) throw new ChatSessionError("会话不存在或已删除。", 404);
    let session = this.loaded.get(id);
    if (session?.busy) throw new ChatSessionError("当前会话仍在生成回答，请稍后再试。", 409);
    if (!session) { session = { busy: false, lastUsedAt: Date.now() }; this.loaded.set(id, session); }
    // Reserve before awaiting provider initialization, so concurrent requests cannot
    // create independent agents for the same conversation.
    session.busy = true;
    try {
      if (!session.agent) {
        const agent = await this.createAgent();
        agent.sessionId = id;
        agent.state.messages = stored.messages as AgentMessage[];
        session.agent = agent;
      }
      session.lastUsedAt = Date.now();
      return session.agent;
    } catch (error) { session.busy = false; throw error; }
  }
  release(id: string) { const session = this.loaded.get(id); if (session) { session.busy = false; session.lastUsedAt = Date.now(); } }
  isBusy(id: string): boolean { return this.loaded.get(id)?.busy ?? false; }
  delete(id: string): boolean {
    if (this.isBusy(id)) throw new ChatSessionError("请等待当前回答完成后再删除会话。", 409);
    const removed = this.database.deleteChat(id); this.loaded.delete(id); return removed;
  }
  dropIdleAgents(): void {
    for (const session of this.loaded.values()) if (!session.busy) delete session.agent;
  }
  cleanup() { for (const [id, session] of this.loaded) if (!session.busy && session.lastUsedAt < Date.now() - 12 * 60 * 60_000) this.loaded.delete(id); }
  async shutdown() {
    const agents = [...this.loaded.values()].flatMap((session) => session.agent ? [session.agent] : []);
    for (const agent of agents) agent.abort();
    await Promise.all(agents.map((agent) => agent.waitForIdle()));
  }
}

export function visibleChatMessages(messages: readonly unknown[]) {
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const value = message as Record<string, unknown>;
    if (value.role !== "user" && value.role !== "assistant") return [];
    const text = typeof value.content === "string" ? value.content : Array.isArray(value.content) ? value.content.filter((part) => part?.type === "text").map((part) => part.text).join("") : "";
    return text || value.errorMessage ? [{ role: value.role, text, error: typeof value.errorMessage === "string" ? value.errorMessage : null }] : [];
  });
}
