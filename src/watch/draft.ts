import type { CandidateDraft, WatchScope } from "./types.js";

export interface HoldingRef {
  symbol: string;
  name: string | null;
}

const MEMORY = /DRAM|NAND|HBM|存储|长鑫|海力士|美光|三星电子|兆易|江波龙|佰维/i;
const AI_CAPEX = /英伟达|NVIDIA|微软|Microsoft|谷歌|Google|亚马逊|Amazon|Meta|博通|台积电|算力|光模块/i;
const FOCUS_WORDS = ["资本开支", "增速", "价格", "供需", "估值", "盈利", "扩产", "产能", "良率", "订单", "库存", "需求", "指引", "政策"];
const NAMES = ["英伟达", "微软", "谷歌", "亚马逊", "Meta", "苹果", "台积电", "美光", "三星", "海力士", "长鑫", "特斯拉", "茅台"];

export function draftFromHoldings(holdings: HoldingRef[]): CandidateDraft[] {
  const named = holdings
    .map((holding) => ({ symbol: holding.symbol.trim(), label: holding.name?.trim() || holding.symbol.trim() }))
    .filter((holding) => holding.symbol);
  const memory = named.filter((holding) => MEMORY.test(`${holding.label} ${holding.symbol}`));
  if (memory.length > 0 && named.every((holding) => MEMORY.test(`${holding.label} ${holding.symbol}`))) {
    return memoryDrafts(memory.map((holding) => holding.label), memory.map((holding) => holding.symbol));
  }
  const drafts: CandidateDraft[] = [];
  if (memory.length > 0) {
    drafts.push(...memoryDrafts(memory.map((holding) => holding.label), memory.map((holding) => holding.symbol)));
  }
  if (named.length === 1 && memory.length === 0) {
    const holding = named[0];
    if (holding) return threeFor(holding.label, holding.symbol);
  }
  for (const holding of named) {
    if (drafts.length >= 5) break;
    if (MEMORY.test(`${holding.label} ${holding.symbol}`)) continue;
    drafts.push(genericDraft(holding.label, holding.symbol));
  }
  if (drafts.length === 0) drafts.push(starterDraft());
  return drafts.slice(0, 5);
}

export function draftFromIdea(text: string): CandidateDraft {
  const stripped = text.trim().replace(/^(请)?(帮我)?(我想)?(持续)?(跟踪|关注|观察)/, "").replace(/^[：:，,\s]+/, "").trim();
  const question = formatWatchQuestion(stripped.length >= 8 ? stripped : text.trim());
  const foundFocus = FOCUS_WORDS.filter((word) => question.includes(word));
  const foundNames = NAMES.filter((name) => question.toLowerCase().includes(name.toLowerCase()));
  const aiCapex = /AI|人工智能|巨头|算力/.test(question) && /资本开支|capex|增速/i.test(question);
  const symbols = aiCapex ? unique([...foundNames, "英伟达", "微软", "谷歌", "亚马逊", "Meta"]) : foundNames;
  const focus = unique(aiCapex ? ["资本开支", "增速", ...foundFocus] : foundFocus);
  const sectors = [
    ...(/存储|DRAM|NAND|HBM/i.test(question) ? ["存储"] : []),
    ...(aiCapex ? ["AI 基础设施"] : []),
  ];
  return draft({
    question,
    rationale: "从你写下的问题整理出观察范围。确认后才开始每天比较新证据。",
    origin: "user",
    focus: focus.length > 0 ? focus.slice(0, 6) : ["公开信息"],
    symbols: symbols.slice(0, 8),
    sectors,
  });
}

function memoryDrafts(labels: string[], symbols: string[]): CandidateDraft[] {
  const name = labels[0] ?? "存储持仓";
  const shared = { symbols, sectors: ["存储"] };
  return [
    draft({
      question: "DRAM 存储周期是否正在见顶？",
      rationale: `持有${name}时，行业价格和供需变化可能改变盈利预期。`,
      origin: "ai",
      focus: ["价格趋势", "供需预测", "原厂扩产", "机构观点"],
      queries: ["DRAM NAND 存储周期 价格 供需", "DRAM 合约价格 机构预测 扩产"],
      ...shared,
    }),
    draft({
      question: "HBM 扩产是否挤压传统 DRAM 供给？",
      rationale: "产能分配可能改变传统存储的价格走势。",
      origin: "ai",
      focus: ["产能分配", "资本开支", "良率", "订单"],
      queries: ["HBM 扩产 资本开支 DRAM 供给", "存储 原厂 产能分配 良率"],
      ...shared,
    }),
    draft({
      question: "全球存储行业是否正在发生估值重定价？",
      rationale: "海外可比公司的估值与盈利预期变化可能影响市场定价。",
      origin: "ai",
      focus: ["估值", "盈利预测", "龙头相对表现"],
      queries: ["存储芯片 估值 盈利预测", "美光 三星 海力士 目标价"],
      ...shared,
    }),
  ];
}

function threeFor(label: string, symbol: string): CandidateDraft[] {
  const ai = AI_CAPEX.test(label);
  return [
    genericDraft(label, symbol, ai
      ? `${label}相关的资本开支增速是否开始放缓？`
      : `${label}的盈利预期是否正在被下修？`, ai ? ["资本开支", "增速", "指引"] : ["盈利预测", "订单", "指引"]),
    genericDraft(label, symbol, `${label}所在行业的价格与供需是否改变后续预期？`, ["价格", "供需", "资本开支"]),
    genericDraft(label, symbol, `市场对${label}的估值是否正在重定价？`, ["估值", "盈利预测", "相对表现"]),
  ];
}

function genericDraft(label: string, symbol: string, question?: string, focus?: string[]): CandidateDraft {
  const themed = questionFor(label);
  const chosenFocus = focus ?? themed.focus;
  return draft({
    question: question ?? themed.question,
    rationale: `围绕${label}，只跟踪会改变预期的公开信息。`,
    origin: "ai",
    focus: chosenFocus,
    symbols: [symbol],
    sectors: themed.sectors,
  });
}

function questionFor(label: string): { question: string; focus: string[]; sectors: string[] } {
  if (AI_CAPEX.test(label)) {
    return { question: `${label}相关的资本开支增速是否开始放缓？`, focus: ["资本开支", "增速", "指引"], sectors: ["AI 基础设施"] };
  }
  if (/ETF|基金/.test(label)) {
    return { question: `${label}跟踪的行业估值是否正在重定价？`, focus: ["估值", "相对表现", "资金流"], sectors: ["ETF"] };
  }
  if (/半导体|芯片|设备|光模块|光电|光纤/.test(label)) {
    return { question: `${label}所在环节的资本开支与订单是否改变后续预期？`, focus: ["资本开支", "订单", "产能"], sectors: ["半导体"] };
  }
  return { question: `${label}的盈利预期是否正在被下修？`, focus: ["盈利预测", "订单", "指引"], sectors: [] };
}

function starterDraft(): CandidateDraft {
  return draft({
    question: "AI 基础设施资本开支增速是否开始放缓？",
    rationale: "还没有持仓。可以先跟踪这个产业问题，确认后每天只记录预期变化。",
    origin: "ai",
    focus: ["资本开支", "增速", "指引"],
    symbols: ["英伟达", "微软", "谷歌", "亚马逊", "Meta"],
    sectors: ["AI 基础设施"],
  });
}

function draft(input: {
  question: string;
  rationale: string;
  origin: CandidateDraft["origin"];
  focus: string[];
  symbols: string[];
  sectors: string[];
  queries?: string[];
}): CandidateDraft {
  const question = formatWatchQuestion(input.question);
  const scope: WatchScope = {
    focus: unique(input.focus).slice(0, 6),
    symbols: unique(input.symbols).slice(0, 8),
    sectors: unique(input.sectors).slice(0, 4),
    queries: unique(input.queries ?? buildQueries(question, input.focus, input.symbols)).slice(0, 3),
  };
  return {
    title: clip(question.replace(/[？?]$/, ""), 28),
    question,
    rationale: clip(input.rationale, 80),
    origin: input.origin,
    scope,
  };
}

export function buildQueries(question: string, focus: string[], symbols: string[]): string[] {
  const subject = symbols.slice(0, 3).join(" ");
  const focusText = focus.slice(0, 3).join(" ");
  const queries = [question.replace(/[？?]/g, ""), [subject, focusText].filter(Boolean).join(" "), [subject, question.replace(/[？?]/g, "")].filter(Boolean).join(" ")];
  return unique(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter((query) => query.length >= 4)).slice(0, 3);
}

export function normalizeQuestion(value: string): string {
  return value.replace(/[？?\s]/g, "").toLowerCase();
}

export function formatWatchQuestion(text: string): string {
  const core = text.replace(/[。.\s]+$/g, "").trim();
  if (/[？?]$/.test(core)) return core.replace(/\?$/, "？");
  return `${core}？`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
