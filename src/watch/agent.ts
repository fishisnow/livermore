import { ROOT_CONTEXT, type Context } from "@opentelemetry/api";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../config.js";
import { observeAgent, Telemetry } from "../observability/telemetry.js";
import type { RunUsage } from "../storage/database.js";
import { createInvestmentAgent } from "../agent/create-investment-agent.js";
import { finalAssistantText } from "../chat/livermore-chat-agent.js";
import { createMcpAgentTools } from "../mcp/agent-tools.js";
import { loadMarketIndices } from "../market/portfolio-trend.js";
import { createRuntimeTools } from "../tools/runtime-tools.js";
import type { InvestmentDatabase } from "../storage/database.js";
import { dedupeEvidence, evidenceFromResults, unavailableSearchMessage } from "./search.js";
import { resolveBriefingMcp } from "../mcp/registry.js";
import type { WatchProgressEvent } from "./progress.js";
import { toolProgressLabel } from "./progress.js";
import type { EvidenceItem, WatchRecord, WatchSignal } from "./types.js";

export interface WatchAgentInput {
  config: AppConfig;
  database: InvestmentDatabase;
  watch: WatchRecord;
  windowStart: string;
  windowEnd: string;
  priorSignals: WatchSignal[];
  telemetry?: Telemetry;
  parentContext?: Context;
  onProgress?: (event: WatchProgressEvent) => void;
}

export interface WatchNarrativePatch {
  currentNarrative: string;
  marketExpectation: string;
  expectationKnown: boolean;
  uncertainties: string[];
}

export interface WatchAgentResult {
  ok: boolean;
  message: string;
  evidence: EvidenceItem[];
  queries: string[];
  summary: string;
  agentNote: string;
  narrativePatch: WatchNarrativePatch | null;
  turnCount: number;
  searchUsed: boolean;
  usage: RunUsage;
}

interface CompletionPayload {
  summary: string;
  agentNote?: string | undefined;
  queriesUsed?: string[] | undefined;
  narrative?: {
    currentNarrative?: string | undefined;
    marketExpectation?: string | undefined;
    expectationKnown?: boolean | undefined;
    uncertainties?: string[] | undefined;
  } | undefined;
}

const evidenceParameters = Type.Object({
  title: Type.String({ minLength: 2, maxLength: 240 }),
  url: Type.String({ minLength: 8, maxLength: 600 }),
  summary: Type.String({ minLength: 8, maxLength: 1200 }),
  publishedAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
  publisher: Type.Optional(Type.String({ maxLength: 120 })),
});

const completeParameters = Type.Object({
  summary: Type.String({ minLength: 8, maxLength: 400 }),
  agentNote: Type.Optional(Type.String({ maxLength: 600 })),
  queriesUsed: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 160 }), { maxItems: 8 })),
  narrative: Type.Optional(Type.Object({
    currentNarrative: Type.Optional(Type.String({ maxLength: 240 })),
    marketExpectation: Type.Optional(Type.String({ maxLength: 200 })),
    expectationKnown: Type.Optional(Type.Boolean()),
    uncertainties: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 6 })),
  })),
});

export async function runWatchCheckAgent(input: WatchAgentInput): Promise<WatchAgentResult> {
  const empty = (message: string): WatchAgentResult => ({
    ok: false,
    message,
    evidence: [],
    queries: input.watch.scope.queries,
    summary: "",
    agentNote: message,
    narrativePatch: null,
    turnCount: 0,
    searchUsed: false,
    usage: emptyUsage(input.config.modelCostCurrency),
  });

  const mcp = resolveBriefingMcp(input.database.listMcpServers());
  if (mcp.state !== "ready" && !input.watch.scope.symbols.length) {
    return empty(unavailableSearchMessage(mcp.state));
  }

  const collected: EvidenceItem[] = [];
  const queriesUsed = new Set<string>(input.watch.scope.queries.slice(0, 3));
  let searchUsed = false;
  let completion: CompletionPayload | undefined;

  const maxEvidence = 24;
  const registerTools = createWatchAgentTools(input, {
    onSearchUsed() { searchUsed = true; },
    onQuery(query: string) { if (query.trim()) queriesUsed.add(query.trim()); },
    registerEvidence(item: EvidenceItem) {
      if (collected.length >= maxEvidence) return "已达证据上限，请整理结论并 complete_watch_check。";
      if (!item.url.startsWith("http://") && !item.url.startsWith("https://")) return "URL 必须以 http:// 或 https:// 开头。";
      collected.push(item);
      return `已登记 ${collected.length} 条证据。`;
    },
    complete(payload: CompletionPayload) {
      completion = payload;
      return { terminate: true as const, message: "检查结论已提交。" };
    },
  });

  const agent = await createInvestmentAgent(input.config, {
    tools: registerTools,
    includeReportTool: false,
    maxTurns: input.config.watchAgentMaxTurns,
    systemPromptAppend: watchAgentSystemPrompt(input.config.watchAgentMaxTurns),
  });

  const parentContext = input.parentContext ?? ROOT_CONTEXT;
  const telemetry = input.telemetry ?? Telemetry.create(input.config);
  const observation = observeAgent(agent, telemetry, parentContext);
  let turn = 0;
  const unsubscribeProgress = input.onProgress
    ? agent.subscribe((event) => {
        if (event.type === "agent_start") input.onProgress?.({ type: "log", text: "Agent 开始思考…" });
        if (event.type === "turn_start") input.onProgress?.({ type: "log", text: `第 ${++turn} 轮` });
        if (event.type === "tool_execution_start") {
          const label = toolProgressLabel(event.toolName);
          input.onProgress?.({ type: "tool_start", name: event.toolName, label });
          input.onProgress?.({ type: "log", text: `→ ${label}` });
        }
        if (event.type === "tool_execution_end") {
          const label = toolProgressLabel(event.toolName);
          input.onProgress?.({
            type: "tool_end",
            name: event.toolName,
            label,
            error: event.isError === true,
          });
          if (event.isError) input.onProgress?.({ type: "log", text: `✗ ${label}` });
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const text = event.assistantMessageEvent.delta;
          if (text) input.onProgress?.({ type: "delta", text });
        }
      })
    : () => {};
  try {
    await agent.prompt(buildWatchAgentUserPrompt(input));
  } finally {
    unsubscribeProgress();
    observation.unsubscribe();
  }

  const turnCount = agent.state.messages.filter((message) => message.role === "assistant").length;
  const usage = observation.usage;
  const error = agent.state.errorMessage;
  if (error) return { ...empty(error), turnCount, searchUsed, usage };

  if (completion == null) {
    const tail = finalAssistantText(agent.state.messages);
    return {
      ...empty("监测 Agent 未调用 complete_watch_check 就结束；请检查模型或提高 WATCH_AGENT_MAX_TURNS。"),
      turnCount,
      searchUsed,
      agentNote: tail.slice(0, 600),
      usage,
    };
  }

  const evidence = dedupeEvidence(collected);
  const queries = [...queriesUsed].slice(0, 8);
  const summary = completion.summary.trim();
  const agentNote = (completion.agentNote ?? "").trim() || summary;
  const narrativePatch = narrativeFromPayload(completion.narrative);

  return {
    ok: true,
    message: "",
    evidence,
    queries,
    summary,
    agentNote,
    narrativePatch,
    turnCount,
    searchUsed,
    usage,
  };
}

function emptyUsage(currency: string): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    costCurrency: currency,
  };
}

function createWatchAgentTools(
  input: WatchAgentInput,
  hooks: {
    onSearchUsed(): void;
    onQuery(query: string): void;
    registerEvidence(item: EvidenceItem): string;
    complete(payload: CompletionPayload): { terminate: true; message: string };
  },
): AgentTool<any>[] {
  const runtime = createRuntimeTools(input.config, input.database, {
    onFutuNewsResult(keywords) {
      hooks.onSearchUsed();
      for (const keyword of keywords) hooks.onQuery(keyword);
    },
  }).filter((tool) => ["query_futu_news", "query_futu_market"].includes(tool.name));

  const mcpTools = createMcpAgentTools(input.database.listMcpServers()).map((tool) => ({
    ...tool,
    async execute(id: string, params: unknown) {
      hooks.onSearchUsed();
      const query = typeof params === "object" && params && "query" in params && typeof (params as { query?: unknown }).query === "string"
        ? (params as { query: string }).query
        : tool.name;
      hooks.onQuery(query);
      return tool.execute(id, params);
    },
  }));

  const custom: AgentTool<any>[] = [
    {
      name: "read_market_indices",
      label: "Read market indices",
      description: "读取富途本地指数快照（点位、日涨跌），用于交叉参考宏观环境；不能替代新闻与研报证据。",
      parameters: Type.Object({}),
      async execute() {
        try {
          const indices = await loadMarketIndices(input.config);
          return toolText(JSON.stringify(indices.slice(0, 12), null, 2).slice(0, 18_000));
        } catch (error) {
          return toolText(error instanceof Error ? error.message : String(error), true);
        }
      },
    },
    {
      name: "register_evidence",
      label: "Register evidence",
      description: "把一条真实检索结果登记为证据；只能从工具返回中摘录，不要编造。每条需含可访问 URL。",
      parameters: evidenceParameters,
      async execute(_id, raw) {
        const row = raw as {
          title: string;
          url: string;
          summary: string;
          publishedAt?: string | null;
          publisher?: string;
        };
        const note = hooks.registerEvidence({
          title: row.title.trim(),
          url: row.url.trim(),
          summary: row.summary.trim(),
          publishedAt: row.publishedAt?.trim() || null,
          publisher: row.publisher?.trim() || publisherFromUrl(row.url),
        });
        return toolText(note, note.includes("上限") || note.startsWith("URL"));
      },
    },
    {
      name: "complete_watch_check",
      label: "Complete watch check",
      description: "提交本轮检查结论并结束。summary 用一句话说明是否相对上次状态有变化；无新证据时也要说明。",
      parameters: completeParameters,
      async execute(_id, raw) {
        const row = raw as CompletionPayload;
        if (!row.summary?.trim()) return { ...toolText("summary 不能为空。", true), terminate: true };
        const payload: CompletionPayload = { summary: row.summary.trim() };
        const agentNote = row.agentNote?.trim();
        if (agentNote) payload.agentNote = agentNote;
        if (row.queriesUsed) payload.queriesUsed = row.queriesUsed;
        if (row.narrative) payload.narrative = row.narrative;
        const result = hooks.complete(payload);
        return { content: [{ type: "text" as const, text: result.message }], details: {}, terminate: true };
      },
    },
  ];

  return [...runtime, ...mcpTools, ...custom];
}

function watchAgentSystemPrompt(maxTurns: number): string {
  return `你是 Livermore 雷达上的投资观察监测 Agent，代替用户做「今天相对昨天，这个调研主题有没有变」的思考。

你的职责像研究员维护跟踪台账：自己决定要搜什么、读什么、何时足够下结论，而不是被动读一份固定检索结果。
可用工具包括网页搜索（MCP / Tavily）、富途资讯与行情、指数快照，以及 register_evidence、complete_watch_check。

工作方式（ReAct）：
1. 先读用户给出的上次状态与已知证据，形成待验证假设。
2. 按需调用搜索与新闻工具；只有工具返回里出现的内容才能 register_evidence。
3. 对比上次叙事与市场预期，区分「转载」「价格涨跌传闻」与「共识/指引修订」。
4. 无足够新证据时，summary 明确写「暂未发现足以改变当前判断的新证据」。
5. 证据充分或已穷尽合理检索后，调用 complete_watch_check 结束。

约束：
- 不写买卖建议；不编造 URL、机构或数字。
- 登记证据时保留一手来源 URL；同一事实多篇转载只登记最有信息量的一篇。
- 最多 ${maxTurns} 个模型轮次；接近上限时优先收口并 complete_watch_check。
- 若搜索工具不可用，仍可用行情/新闻接口尝试，并在 summary 里说明缺口。`;
}

export function buildWatchAgentUserPrompt(input: WatchAgentInput): string {
  const { watch, windowStart, windowEnd, priorSignals } = input;
  const known = watch.state.knownEvidence.slice(-8).map((item) => `- ${item.title} ${item.url}`).join("\n") || "（无）";
  const baseline = watch.state.baselineSources.slice(0, 8).map((item) => `- [${item.publishedAt?.slice(0, 10) ?? "日期不明"}] ${item.title}\n  ${item.summary.slice(0, 160)}`).join("\n")
    || "（尚无。基线材料见最近一次「基线建立」检查记录。）";
  const signals = priorSignals.slice(0, 5).map((signal) => `- ${signal.detectedAt.slice(0, 10)} · ${signal.summary}`).join("\n") || "（无历史 Signal）";

  return `## 观察
问题：${watch.question}
理由：${watch.rationale || "无"}
重点：${watch.scope.focus.join("、") || "公开信息"}
相关标的：${watch.scope.symbols.join("、") || "未指定"}
建议检索方向：${watch.scope.queries.join("；") || watch.question}

## 时间窗
从 ${windowStart.slice(0, 19)} 到 ${windowEnd.slice(0, 19)}（ISO）。优先选用该窗内发布的材料；缺失发布日时要谨慎。

## 当前状态（上次检查留下）
- 已形成基线：${watch.state.baselined ? "是" : "否"}
- 市场叙事：${watch.state.currentNarrative}
- 市场预期：${watch.state.marketExpectation}
- 预期是否清晰：${watch.state.expectationKnown ? "是" : "否"}
- 分歧/不确定：${watch.state.uncertainties.join("；") || "无"}

## 建立依据（上次基线检查登记的引用，不是本轮新证据）
${baseline}

## 已知证据签名（避免重复登记转载）
${known}

## 近期 Signal
${signals}

请开始自主调查：思考 → 工具 → register_evidence → 对比状态 → complete_watch_check。`;
}

function narrativeFromPayload(raw: CompletionPayload["narrative"]): WatchNarrativePatch | null {
  if (!raw) return null;
  const currentNarrative = raw.currentNarrative?.trim() ?? "";
  const marketExpectation = raw.marketExpectation?.trim() ?? "";
  if (currentNarrative.length < 12 && marketExpectation.length < 6) return null;
  const uncertainties = Array.isArray(raw.uncertainties)
    ? raw.uncertainties.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 6)
    : [];
  return {
    currentNarrative: currentNarrative || "预期未知。",
    marketExpectation: marketExpectation || "预期未知。",
    expectationKnown: raw.expectationKnown === true,
    uncertainties,
  };
}

function publisherFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "unknown"; }
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

/** Parse Tavily JSON tool output into evidence items (for tests). */
export function evidenceFromSearchToolText(text: string): EvidenceItem[] {
  try {
    const payload = JSON.parse(text) as { results?: unknown[] };
    if (!Array.isArray(payload.results)) return [];
    return evidenceFromResults(payload.results as Array<{ title?: string; url?: string; content?: string; published_date?: string }>);
  } catch {
    return [];
  }
}