import * as Lark from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../config.js";

export class FeishuAppClient {
  private readonly client: Lark.Client;

  constructor(config: AppConfig) {
    if (!config.feishuAppId || !config.feishuAppSecret) {
      throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are not configured.");
    }
    this.client = new Lark.Client({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
    });
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    const chunks = splitMessage(markdown, 3_500, 45);
    for (const [index, chunk] of chunks.entries()) {
      const content = chunks.length > 1
        ? `> Livermore 报告 · 第 ${index + 1}/${chunks.length} 部分\n\n${chunk}`
        : chunk;
      const response = await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(feishuMarkdownCard(content)),
        },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`Feishu message rejected (${response.code}): ${response.msg ?? "unknown error"}`);
      }
    }
  }
}

export function feishuMarkdownCard(markdown: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [{
        tag: "markdown",
        content: markdown,
      }],
    },
  };
}

export function splitMessage(value: string, limit: number, maxLines = Number.POSITIVE_INFINITY): string[] {
  const normalized = value.trim();
  if (!normalized) return [""];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const block of groupHeadingsWithContent(normalized.split(/\n{2,}/))) {
    const startsSection = /^##\s/.test(block);
    const preferSectionBreak = current
      && startsSection
      && (current.length >= limit * 0.35 || countLines(current) >= maxLines * 0.35);
    const candidate = current ? `${current}\n\n${block}` : block;
    if (preferSectionBreak || !fits(candidate, limit, maxLines)) {
      flush();
    }
    if (fits(block, limit, maxLines)) {
      current = current ? `${current}\n\n${block}` : block;
      continue;
    }
    const pieces = splitOversizedBlock(block, limit, maxLines);
    chunks.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? "";
  }
  flush();
  return chunks;
}

function groupHeadingsWithContent(blocks: string[]): string[] {
  const grouped: string[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] ?? "";
    if (!/^#{2,6}\s/.test(block)) {
      grouped.push(block);
      continue;
    }
    const parts = [block];
    while (index + 1 < blocks.length && /^#{2,6}\s/.test(blocks[index + 1] ?? "")) {
      parts.push(blocks[index + 1] ?? "");
      index += 1;
    }
    if (index + 1 < blocks.length) {
      parts.push(blocks[index + 1] ?? "");
      index += 1;
    }
    grouped.push(parts.join("\n\n"));
  }
  return grouped;
}

function countLines(value: string): number {
  return value.split("\n").length;
}

function fits(value: string, limit: number, maxLines: number): boolean {
  return value.length <= limit && countLines(value) <= maxLines;
}

function splitOversizedBlock(block: string, limit: number, maxLines: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const line of block.split("\n")) {
    if (line.length > limit) {
      if (current) pieces.push(current);
      for (let index = 0; index < line.length; index += limit) {
        pieces.push(line.slice(index, index + limit));
      }
      current = "";
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (!fits(candidate, limit, maxLines)) {
      if (current) pieces.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
