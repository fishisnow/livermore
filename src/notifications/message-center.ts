import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { InvestmentDatabase } from "../storage/database.js";
import { FeishuAppClient, feishuMarkdownCard, splitMessage } from "./feishu-app-client.js";

export interface MessageInput {
  runId: string | null;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
}

interface Channel {
  name: string;
  send(title: string, body: string): Promise<void>;
}

export class MessageCenter {
  private readonly channels: Channel[];

  constructor(private readonly config: AppConfig, private readonly database: InvestmentDatabase) {
    const feishuAppClient = config.feishuAppId && config.feishuAppSecret
      ? new FeishuAppClient(config)
      : undefined;
    this.channels = [
      ...(feishuAppClient ? database.listFeishuReportRecipients().map((conversation) => ({
        name: `feishu-app:${shortId(conversation.chatId)}`,
        async send(title: string, body: string) {
          await feishuAppClient.sendMarkdown(conversation.chatId, `## ${title}\n\n${body}`);
        },
      })) : []),
      ...(config.feishuWebhookUrl ? [feishuWebhookChannel(config.feishuWebhookUrl)] : []),
      ...(config.wechatWebhookUrl ? [webhookChannel("wechat-work", config.wechatWebhookUrl, (text) => ({ msgtype: "text", text: { content: text } }))] : []),
    ];
  }

  hasChannels(): boolean {
    return this.channels.length > 0;
  }

  async publish(input: MessageInput): Promise<string> {
    const alertId = this.database.saveAlert(input.runId, input.severity, input.title, input.body);
    for (const channel of this.channels) {
      try {
        await channel.send(input.title, input.body);
        this.database.recordNotification(alertId, channel.name, "sent");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.database.recordNotification(alertId, channel.name, "failed", message);
        console.warn(`${channel.name} notification failed: ${message}`);
      }
    }
    return alertId;
  }
}

function shortId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function feishuWebhookChannel(url: string): Channel {
  return {
    name: "feishu",
    async send(title, body) {
      const chunks = splitMessage(`${title}\n\n${body}`, 3_500, 45);
      for (const [index, chunk] of chunks.entries()) {
        const content = chunks.length > 1
          ? `> Livermore 报告 · 第 ${index + 1}/${chunks.length} 部分\n\n${chunk}`
          : chunk;
        await postWebhook(url, {
          msg_type: "interactive",
          card: feishuMarkdownCard(content),
        });
      }
    },
  };
}

function webhookChannel(name: string, url: string, payload: (text: string) => unknown): Channel {
  return {
    name,
    async send(title, body) {
      await postWebhook(url, payload(`${title}\n\n${body}`));
    },
  };
}

async function postWebhook(url: string, payload: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  const code = result.code ?? result.StatusCode ?? result.errcode;
  if (code !== undefined && code !== 0 && code !== "0") {
    throw new Error(`Webhook rejected the message: ${JSON.stringify(result).slice(0, 500)}`);
  }
}
