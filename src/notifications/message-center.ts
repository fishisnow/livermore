import type { AppConfig } from "../config.js";
import type { InvestmentDatabase } from "../storage/database.js";

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
    this.channels = [
      ...(config.feishuWebhookUrl ? [webhookChannel("feishu", config.feishuWebhookUrl, (text) => ({ msg_type: "text", content: { text } }))] : []),
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

function webhookChannel(name: string, url: string, payload: (text: string) => unknown): Channel {
  return {
    name,
    async send(title, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(`${title}\n\n${body}`)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      const code = result.code ?? result.StatusCode ?? result.errcode;
      if (code !== undefined && code !== 0 && code !== "0") {
        throw new Error(`Webhook rejected the message: ${JSON.stringify(result).slice(0, 500)}`);
      }
    },
  };
}
