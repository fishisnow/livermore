import * as Lark from "@larksuiteoapi/node-sdk";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createLivermoreChatAgent, finalAssistantText } from "../chat/livermore-chat-agent.js";
import type { AppConfig } from "../config.js";
import { observeAgent, type Telemetry } from "../observability/telemetry.js";
import type { InvestmentDatabase } from "../storage/database.js";

interface FeishuSession {
  agent: Agent;
  busy: boolean;
  lastUsedAt: number;
}

type FeishuCommand = "subscribe" | "unsubscribe" | "subscription-status" | "help";

export interface FeishuBotService {
  channel: Lark.LarkChannel;
  close(): Promise<void>;
}

export async function startFeishuBotService(
  config: AppConfig,
  database: InvestmentDatabase,
  telemetry: Telemetry,
): Promise<FeishuBotService> {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are not configured.");
  }
  const sessions = new Map<string, FeishuSession>();
  const channel = Lark.createLarkChannel({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
    source: "livermore",
    handshakeTimeoutMs: 15_000,
    policy: {
      dmMode: "open",
      requireMention: true,
      respondToMentionAll: false,
    },
    safety: {
      dedup: { ttl: 10 * 60_000, maxEntries: 10_000 },
      staleMessageWindowMs: 10 * 60_000,
    },
    outbound: {
      textChunkLimit: 12_000,
      retry: { maxAttempts: 3, baseDelayMs: 500 },
    },
  });

  channel.on("message", (message) => {
    // Return immediately so the long-connection event is acknowledged within
    // Feishu's three-second deadline; SQLite and the SDK both deduplicate.
    void handleMessage(channel, message, config, database, telemetry, sessions)
      .catch((error) => console.error(`Feishu message handling failed: ${errorMessage(error)}`));
  });
  channel.on("error", (error) => {
    console.error(`Feishu channel error [${error.code}]: ${error.message}`);
  });
  channel.on("reconnecting", () => console.warn("Feishu channel reconnecting…"));
  channel.on("reconnected", () => console.log("Feishu channel reconnected."));

  await channel.connect();
  console.log(`Livermore Feishu bot connected: ${channel.botIdentity?.name ?? "unknown bot"}`);

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - 12 * 60 * 60_000;
    for (const [chatId, session] of sessions) {
      if (!session.busy && session.lastUsedAt < cutoff) sessions.delete(chatId);
    }
  }, 30 * 60_000);
  cleanup.unref();

  return {
    channel,
    async close() {
      clearInterval(cleanup);
      for (const session of sessions.values()) session.agent.abort();
      await channel.disconnect();
    },
  };
}

async function handleMessage(
  channel: Lark.LarkChannel,
  message: Lark.NormalizedMessage,
  config: AppConfig,
  database: InvestmentDatabase,
  telemetry: Telemetry,
  sessions: Map<string, FeishuSession>,
): Promise<void> {
  const receivedAt = new Date(
    Number.isFinite(message.createTime) && message.createTime > 0 ? message.createTime : Date.now(),
  ).toISOString();
  if (!database.claimFeishuMessage({
    messageId: message.messageId,
    chatId: message.chatId,
    receivedAt,
  })) return;
  const conversation = database.upsertFeishuConversation({
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
    seenAt: receivedAt,
  });
  const command = parseFeishuCommand(message.content);
  if (command) {
    await handleCommand(channel, message, command, database);
    return;
  }
  const content = message.content.trim();
  if (!content || content.length > 20_000) {
    await channel.send(message.chatId, {
      text: content ? "消息过长，请控制在 20,000 字以内。" : "暂时无法识别这条消息，请发送文本问题。",
    }, { replyTo: message.messageId });
    return;
  }

  let session = sessions.get(message.chatId);
  if (!session) {
    session = {
      agent: await createLivermoreChatAgent(config, database, "飞书"),
      busy: false,
      lastUsedAt: Date.now(),
    };
    sessions.set(message.chatId, session);
  }
  if (session.busy) {
    await channel.send(message.chatId, {
      text: "上一条问题仍在处理中，请稍后再发。",
    }, { replyTo: message.messageId });
    return;
  }
  session.busy = true;
  session.lastUsedAt = Date.now();
  try {
    await channel.send(message.chatId, {
      text: conversation.subscribedReports
        ? "收到，Livermore 正在分析…"
        : "收到，Livermore 正在分析…\n当前群聊尚未订阅定时报告，可发送“订阅日报”启用。",
    }, { replyTo: message.messageId });
    await telemetry.withSpan("agent.feishu_chat", {
      "openinference.span.kind": "AGENT",
      "livermore.chat.surface": "feishu",
      "livermore.chat.chat_type": message.chatType,
      "livermore.chat.message_length": content.length,
    }, async (_span, activeContext) => {
      const observation = observeAgent(session!.agent, telemetry, activeContext);
      try {
        await session!.agent.prompt(content);
        if (session!.agent.state.errorMessage) throw new Error(session!.agent.state.errorMessage);
        const answer = finalAssistantText(session!.agent.state.messages);
        if (!answer) throw new Error("Livermore Agent returned an empty response.");
        await channel.send(message.chatId, { markdown: answer }, { replyTo: message.messageId });
      } finally {
        observation.unsubscribe();
      }
    });
  } catch (error) {
    sessions.delete(message.chatId);
    await channel.send(message.chatId, {
      text: `本次处理失败：${safeUserError(error)}`,
    }, { replyTo: message.messageId }).catch(() => undefined);
    throw error;
  } finally {
    session.busy = false;
    session.lastUsedAt = Date.now();
    await telemetry.forceFlush();
  }
}

async function handleCommand(
  channel: Lark.LarkChannel,
  message: Lark.NormalizedMessage,
  command: FeishuCommand,
  database: InvestmentDatabase,
): Promise<void> {
  if (command === "subscribe") {
    database.setFeishuReportSubscription(message.chatId, true);
    await channel.send(message.chatId, {
      text: "已订阅 Livermore 定时研究报告和持仓风险提醒。",
    }, { replyTo: message.messageId });
  } else if (command === "unsubscribe") {
    database.setFeishuReportSubscription(message.chatId, false);
    await channel.send(message.chatId, {
      text: "已停止向当前会话推送定时报告。你仍可继续与 Livermore 对话。",
    }, { replyTo: message.messageId });
  } else if (command === "subscription-status") {
    const subscribed = database.getFeishuConversation(message.chatId)?.subscribedReports ?? false;
    await channel.send(message.chatId, {
      text: subscribed ? "当前会话已订阅定时报告。" : "当前会话未订阅定时报告。",
    }, { replyTo: message.messageId });
  } else {
    await channel.send(message.chatId, { text: helpText() }, { replyTo: message.messageId });
  }
}

export function parseFeishuCommand(value: string): FeishuCommand | undefined {
  const normalized = value.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (["订阅日报", "订阅报告", "/subscribe", "subscribe"].includes(normalized)) return "subscribe";
  if (["取消订阅", "取消日报", "/unsubscribe", "unsubscribe"].includes(normalized)) return "unsubscribe";
  if (["订阅状态", "/subscription", "subscription"].includes(normalized)) return "subscription-status";
  if (["帮助", "/help", "help", "使用说明"].includes(normalized)) return "help";
  return undefined;
}

function helpText(): string {
  return [
    "Livermore 飞书 Agent",
    "",
    "直接发送问题：查询定时任务结果、持仓风险、行情或投资研究信息。",
    "订阅日报：向当前会话推送定时研究报告和持仓提醒。",
    "取消订阅：停止当前会话的定时推送。",
    "订阅状态：查看当前会话是否已订阅。",
    "",
    "群聊中请先 @Livermore。以上内容仅供研究参考，不构成投资建议。",
  ].join("\n");
}

function safeUserError(error: unknown): string {
  const message = errorMessage(error);
  if (/secret|token|key/i.test(message)) return "机器人配置或权限异常，请查看 Livermore 本地日志。";
  return message.slice(0, 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
