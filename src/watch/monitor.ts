import type { AppConfig } from "../config.js";
import { loadMarketIndices } from "../market/portfolio-trend.js";
import { completeJson, modelConfigured } from "./model.js";
import type { EvidenceItem, WatchRecord, WatchState } from "./types.js";

export interface BaselineSynthesisInput {
  watch: WatchRecord;
  evidence: EvidenceItem[];
  state: WatchState;
}

export async function enrichBaselineState(config: AppConfig, input: BaselineSynthesisInput): Promise<WatchState> {
  if (!modelConfigured(config) || input.evidence.length === 0) return input.state;
  const marketContext = await marketContextBrief(config);
  const synthesized = await synthesizeBaselineState(config, input, marketContext);
  if (!synthesized) return input.state;
  return {
    ...input.state,
    currentNarrative: synthesized.currentNarrative,
    marketExpectation: synthesized.marketExpectation,
    expectationKnown: synthesized.expectationKnown,
    uncertainties: uniqueStrings([...input.state.uncertainties, ...synthesized.uncertainties]),
  };
}

async function synthesizeBaselineState(
  config: AppConfig,
  input: BaselineSynthesisInput,
  marketContext: string,
): Promise<Pick<WatchState, "currentNarrative" | "marketExpectation" | "expectationKnown" | "uncertainties"> | null> {
  const lines = input.evidence.slice(0, 12).map((item, index) => {
    const when = item.publishedAt ? item.publishedAt.slice(0, 10) : "日期不明";
    return `${index + 1}. [${when} · ${item.publisher}] ${item.title}\n   ${clip(item.summary, 220)}`;
  }).join("\n");
  const payload = await completeJson(
    config,
    "你是投资观察监测助手。只根据给出的证据写 JSON，不编造未出现的机构、数字或结论。证据不足时明确写未知。",
    `为这条观察建立可对照的基线状态。

观察问题：${input.watch.question}
观察理由：${input.watch.rationale || "无"}
重点监测：${input.watch.scope.focus.join("、") || "公开信息"}
规则层初读：
- 当前叙事：${input.state.currentNarrative}
- 市场预期：${input.state.marketExpectation}
- 已知分歧：${input.state.uncertainties.join("、") || "无"}

${marketContext ? `本地市场环境快照（富途指数，供交叉参考，不能替代证据）：\n${marketContext}\n` : ""}
证据（仅此列表，不要外推）：
${lines}

输出 JSON：
{
  "currentNarrative": "用一两句话概括当前市场围绕这个问题的讨论焦点，必须能追溯到证据。",
  "marketExpectation": "若多来源一致才写可核对预期；否则写 预期未知。",
  "expectationKnown": false,
  "uncertainties": ["1到3个仍待验证的分歧或口径问题"]
}
字数：currentNarrative 80 字内，marketExpectation 60 字内。不要写买卖建议。`,
  );
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const currentNarrative = typeof body.currentNarrative === "string" ? clip(body.currentNarrative.trim(), 180) : "";
  const marketExpectation = typeof body.marketExpectation === "string" ? clip(body.marketExpectation.trim(), 160) : "预期未知。";
  if (currentNarrative.length < 12) return null;
  const expectationKnown = body.expectationKnown === true && marketExpectation !== "预期未知。" && !/^未知|尚无/.test(marketExpectation);
  const uncertainties = shortList(body.uncertainties, 4, 80);
  return { currentNarrative, marketExpectation, expectationKnown, uncertainties };
}

async function marketContextBrief(config: AppConfig): Promise<string> {
  try {
    const indices = await loadMarketIndices(config);
    return indices
      .filter((item): item is Extract<typeof item, { latest: number }> => "latest" in item && typeof item.latest === "number")
      .slice(0, 6)
      .map((item) => {
        const pct = item.dayChangePct == null ? "—" : `${item.dayChangePct >= 0 ? "+" : ""}${item.dayChangePct.toFixed(2)}%`;
        return `- ${item.name} ${item.latest.toFixed(2)}（日 ${pct}）`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

function shortList(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, max)
    .map((item) => clip(item.trim(), itemMax));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 6);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}