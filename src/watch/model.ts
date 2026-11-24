import type { AppConfig } from "../config.js";
import { applyIdeaEnrichment, draftFromHoldings, draftFromIdea, type HoldingRef } from "./draft.js";
import type { CandidateDraft } from "./types.js";

export interface IdeaEnrichment {
  rationale: string;
  focus: string[];
  symbols: string[];
  sectors: string[];
}

export function modelConfigured(config: AppConfig): boolean {
  if (process.env.VITEST) return false;
  return config.provider !== "cursor" && Boolean(apiKey() && baseUrl(config));
}

export async function draftHoldingsWithModel(config: AppConfig, holdings: HoldingRef[]): Promise<CandidateDraft[] | null> {
  if (!modelConfigured(config) || holdings.length === 0) return null;
  const payload = await completeJson(config, "你是投资观察编辑。只输出 JSON，不要写文章。", holdingsPrompt(holdings));
  return payload ? draftsFromPayload(payload, holdings) : null;
}

export async function enrichUserIdeaWithModel(config: AppConfig, text: string): Promise<IdeaEnrichment | null> {
  if (!modelConfigured(config)) return null;
  const payload = await completeJson(config, "你是投资观察编辑。只输出 JSON，不要写文章。", ideaScopePrompt(text));
  return parseIdeaScope(payload);
}

export async function buildUserIdeaDraft(config: AppConfig, text: string): Promise<CandidateDraft> {
  let draft = draftFromIdea(text);
  const enrichment = await enrichUserIdeaWithModel(config, text);
  if (enrichment) draft = applyIdeaEnrichment(draft, enrichment);
  return draft;
}

/** @deprecated 使用 buildUserIdeaDraft；保留问句原话并只用模型补 scope。 */
export async function draftIdeaWithModel(config: AppConfig, text: string): Promise<CandidateDraft | null> {
  if (!modelConfigured(config)) return null;
  return buildUserIdeaDraft(config, text);
}

export async function completeJson(config: AppConfig, system: string, user: string): Promise<unknown | null> {
  const key = apiKey();
  const root = baseUrl(config);
  if (!key || !root) return null;
  try {
    const response = await fetch(completionsUrl(root), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim());
  } catch {
    return null;
  }
}

const THEME_RULES = `一条观察只写成一个调研主题：某个已经形成的市场预期，是否正在变化。
问句点明对象和正在检验的机制，让以后能用公开信息对照。不要写成研究计划、观察清单或点位判断。
不好：「黄金价格是否已接近底部，后续应观察哪些宏观、供需与资金流信号来验证？」
它把「价格是否见底」和「该看哪些信号」粘在一起。
更好：「黄金市场是否正在形成阶段性底部？」
实际利率、美元指数、ETF 资金流、央行购金放进 focus，不要写进问句。
不要写买卖建议、阈值、日期，也不要写「应观察哪些」「如何验证」「接近底部」。
question 用中文，以一个问号结尾，40 字以内。rationale 用一句话说明在验证哪一个预期，30 字以内。focus 是判断这个预期有没有变的变量，2 到 4 个短词。`;

function holdingsPrompt(holdings: HoldingRef[]): string {
  const lines = holdings.map((holding) => `- ${holding.name?.trim() || holding.symbol}（${holding.symbol}）`).join("\n");
  return `根据这些持仓，提出 3 到 5 个调研主题。
${THEME_RULES}
持仓：
${lines}

JSON 格式：{"watches":[{"question":"","rationale":"","focus":[""],"symbols":[""],"sectors":[""]}]}
symbols 只能来自上面的持仓。`;
}

function ideaScopePrompt(text: string): string {
  return `用户写下了一段想持续跟踪的投资观察原话。不要改写、不要输出新问句；只理解他在验证什么预期，并抽出后续每天对照的监测维度。

focus：判断该预期有没有变的公开变量，必须 2 到 4 个中文短词（例如实际利率、美元指数、ETF 资金流、央行购金），不要写成长句，也不要把整句观察拆进问句里。
rationale：一句话说明在验证哪一个市场预期，30 字以内。
symbols：相关上市公司或标的简称，最多 8 个；没有把握可输出空数组。
sectors：相关行业标签，最多 3 个。

原话：
${text}

JSON 格式：{"rationale":"","focus":[""],"symbols":[""],"sectors":[""]}`;
}

function parseIdeaScope(payload: unknown): IdeaEnrichment | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const focus = shortList(row.focus, 4, 16);
  if (focus.length < 2) return null;
  const rationale = clip(typeof row.rationale === "string" ? row.rationale.trim() : "你写下的跟踪主题。确认后每天比较新证据与上次状态。", 80);
  return {
    rationale,
    focus,
    symbols: shortList(row.symbols, 8, 24),
    sectors: shortList(row.sectors, 3, 16),
  };
}

export function isResearchTheme(question: string): boolean {
  const text = question.trim();
  if (text.length < 8 || text.length > 80) return false;
  if (!/[？?]$/.test(text) || (text.match(/[？?]/g) ?? []).length !== 1) return false;
  return !/接近底部|抄底|是否见底|已经见底|应观察|如何验证|哪些信号|后续应|用来验证|买入|卖出|减仓|止损|阈值/.test(text);
}

function draftsFromPayload(payload: unknown, holdings: HoldingRef[]): CandidateDraft[] | null {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { watches?: unknown }).watches)) return null;
  const watches = (payload as { watches: unknown[] }).watches;
  if (watches.length < 1 || watches.length > 5) return null;
  const allowed = new Set(holdings.flatMap((holding) => [holding.symbol, holding.name ?? ""].filter(Boolean)));
  const drafts: CandidateDraft[] = [];
  for (const item of watches) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (typeof row.question !== "string") return null;
    const question = clip(row.question.trim(), 80);
    if (!isResearchTheme(question.endsWith("？") || question.endsWith("?") ? question : `${question}？`)) continue;
    const rationale = clip(typeof row.rationale === "string" ? row.rationale.trim() : "确认后持续比较新证据和上次状态。", 80);
    const focus = shortList(row.focus, 4, 16);
    const sectors = shortList(row.sectors, 3, 16);
    const symbols = shortList(row.symbols, 8, 24);
    const safeSymbols = holdings.length === 0 ? symbols : symbols.filter((symbol) => allowed.has(symbol) || question.includes(symbol));
    drafts.push({
      title: question.replace(/[？?]$/, "").slice(0, 28),
      question: question.endsWith("？") || question.endsWith("?") ? question.replace(/\?$/, "？") : `${question}？`,
      rationale,
      origin: "ai",
      scope: {
        focus: focus.length > 0 ? focus : ["公开信息"],
        symbols: safeSymbols,
        sectors,
        queries: [],
      },
    });
  }
  if (drafts.length === 0) return null;
  return drafts.map((draft) => ({
    ...draft,
    scope: { ...draft.scope, queries: queriesFor(draft) },
  }));
}

function queriesFor(draft: CandidateDraft): string[] {
  const subject = draft.scope.symbols.slice(0, 3).join(" ");
  const focus = draft.scope.focus.slice(0, 3).join(" ");
  return [...new Set([draft.question.replace(/[？?]/g, ""), [subject, focus].filter(Boolean).join(" ")].map((query) => query.trim()).filter((query) => query.length >= 4))].slice(0, 3);
}

function shortList(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, max)
    .map((item) => clip(item.trim(), itemMax));
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function fallbackDrafts(holdings: HoldingRef[]): CandidateDraft[] {
  return draftFromHoldings(holdings);
}

function apiKey(): string | null {
  const provider = process.env.PI_PROVIDER?.trim() || "deepseek";
  const names = ["PI_API_KEY", `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`, "OPENAI_API_KEY", "DEEPSEEK_API_KEY"];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function baseUrl(config: AppConfig): string | null {
  if (config.apiBaseUrl) return config.apiBaseUrl.replace(/\/+$/, "");
  if (config.provider === "deepseek") return "https://api.deepseek.com";
  if (config.provider === "openai") return "https://api.openai.com/v1";
  return null;
}

function completionsUrl(root: string): string {
  return root.endsWith("/chat/completions") ? root : `${root}/chat/completions`;
}
