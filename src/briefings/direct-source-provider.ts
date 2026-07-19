import { createHash } from "node:crypto";
import { Defuddle } from "defuddle/node";
import type { BriefingTask, SourceItem } from "./types.js";
import { normalizeSource } from "./source-provider.js";

interface DirectSourceSpec {
  category: string;
  label: string;
  url: string;
}

interface ExtractedPage {
  title: string;
  content: string;
  published?: string;
}

interface DirectSourceOptions {
  fetchFn?: typeof fetch;
  extract?: (html: string, url: string) => Promise<ExtractedPage>;
}

const sourcesByTask: Record<BriefingTask, DirectSourceSpec[]> = {
  "market-briefing": [
    { category: "市场快讯", label: "财联社电报", url: "https://www.cls.cn/telegraph" },
    { category: "宏观快讯", label: "金十数据", url: "https://www.jin10.com/" },
    { category: "美股", label: "Yahoo Finance", url: "https://finance.yahoo.com/" },
    { category: "A股", label: "新浪财经", url: "https://finance.sina.com.cn/" },
    { category: "港股", label: "恒生指数行情与新闻", url: "https://finance.yahoo.com/quote/%5EHSI/" },
    { category: "A股", label: "东方财富", url: "https://www.eastmoney.com/" },
    { category: "市场资讯", label: "东方财富证券聚焦", url: "https://finance.eastmoney.com/a/czqyw.html" },
  ],
  "ai-industry-chain": [
    { category: "AI 综合", label: "Yahoo Finance AI", url: "https://finance.yahoo.com/topic/artificial-intelligence/" },
    { category: "上游", label: "NVIDIA 行情与新闻", url: "https://finance.yahoo.com/quote/NVDA/" },
    { category: "上游", label: "AMD 行情与新闻", url: "https://finance.yahoo.com/quote/AMD/" },
    { category: "上游", label: "Broadcom 行情与新闻", url: "https://finance.yahoo.com/quote/AVGO/" },
    { category: "上游", label: "Super Micro 行情与新闻", url: "https://finance.yahoo.com/quote/SMCI/" },
    { category: "下游", label: "CNBC Technology", url: "https://www.cnbc.com/technology/" },
    { category: "中国 AI", label: "财联社电报", url: "https://www.cls.cn/telegraph" },
    { category: "中国 AI", label: "东方财富", url: "https://www.eastmoney.com/" },
  ],
};

export async function collectDirectSources(
  task: BriefingTask,
  now: Date,
  options: DirectSourceOptions = {},
): Promise<{ sources: SourceItem[]; failures: string[] }> {
  const fetchFn = options.fetchFn ?? fetch;
  const extract = options.extract ?? extractWithDefuddle;
  const outcomes = await Promise.allSettled(sourcesByTask[task].map(async (spec) => {
    const response = await fetchFn(spec.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await readLimitedBody(response, 2_000_000);
    const finalUrl = response.url || spec.url;
    const page = await extract(html, finalUrl);
    const summary = page.content.replace(/\n{3,}/g, "\n\n").trim().slice(0, 8_000);
    if (summary.length < 80) throw new Error("extracted content is empty");
    return normalizeSource({
      id: contentSourceId(finalUrl, summary),
      category: spec.category,
      title: page.title.trim() || spec.label,
      url: finalUrl,
      summary,
      retrievedAt: now.toISOString(),
      ...(page.published?.trim() ? { publishedAt: page.published.trim() } : {}),
    });
  }));

  const sources: SourceItem[] = [];
  const failures: string[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") sources.push(outcome.value);
    else failures.push(`${sourcesByTask[task][index]!.label}: ${errorMessage(outcome.reason)}`);
  });
  return { sources, failures };
}

export function contentSourceId(url: string, content: string): string {
  return createHash("sha256").update(`${url}\n${content}`).digest("hex").slice(0, 24);
}

async function extractWithDefuddle(html: string, url: string): Promise<ExtractedPage> {
  const result = await Defuddle(html, url, { markdown: true, removeImages: true, useAsync: false });
  return {
    title: result.title,
    content: result.contentMarkdown ?? result.content,
    ...(result.published ? { published: result.published } : {}),
  };
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    total += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (chunk.byteLength < value.byteLength) break;
  }
  await reader.cancel().catch(() => undefined);
  return text + decoder.decode();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
