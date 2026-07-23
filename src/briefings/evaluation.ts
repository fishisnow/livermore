import type { BriefingTask, SourceItem } from "./types.js";

export interface EvaluationResult {
  evaluator: string;
  score: number;
  label: "pass" | "warning" | "fail";
  explanation: string;
}

export function evaluateBriefing(task: BriefingTask, content: string, sources: SourceItem[]): EvaluationResult[] {
  const results: EvaluationResult[] = [];
  const sourceReferences = [...content.matchAll(/\[S(\d+)\]/g)].map((match) => Number(match[1]));
  const invalidReferences = sourceReferences.filter((index) => index < 1 || index > sources.length);
  results.push({
    evaluator: "citation-validity",
    score: invalidReferences.length === 0 ? 1 : 0,
    label: invalidReferences.length === 0 ? "pass" : "fail",
    explanation: invalidReferences.length === 0 ? "所有来源编号均有效。" : `存在无效来源编号：${[...new Set(invalidReferences)].join(", ")}`,
  });

  const requiredSections = task === "ai-industry-chain"
    ? ["上游", "中游", "下游", "政策", "综合研判"]
    : ["A股", "港股", "美股", "政策", "地缘", "风险"];
  const covered = requiredSections.filter((section) => content.includes(section));
  const coverage = covered.length / requiredSections.length;
  results.push({
    evaluator: "section-coverage",
    score: coverage,
    label: coverage === 1 ? "pass" : coverage >= 0.6 ? "warning" : "fail",
    explanation: `覆盖 ${covered.length}/${requiredSections.length} 个核心主题。`,
  });

  const disclaimer = content.includes("以上内容仅供研究参考，不构成投资建议。");
  results.push({
    evaluator: "research-boundary",
    score: disclaimer ? 1 : 0,
    label: disclaimer ? "pass" : "fail",
    explanation: disclaimer ? "包含研究免责声明。" : "缺少研究免责声明。",
  });

  if (task === "market-briefing") {
    const decisionSignals = [
      {
        name: "市场宽度与量价",
        matched: /(成交额|成交量)/.test(content) && /(涨跌家数|上涨家数|下跌家数|涨停)/.test(content),
      },
      {
        name: "跨资产变量",
        matched: ["原油", "黄金", "美元", "美债"].filter((term) => content.includes(term)).length >= 2,
      },
      {
        name: "可验证观察框架",
        matched: ["催化", "验证信号", "失效条件", "风险", "时间尺度"]
          .filter((term) => content.includes(term)).length >= 4,
      },
    ];
    const matchedSignals = decisionSignals.filter((signal) => signal.matched);
    const decisionScore = matchedSignals.length / decisionSignals.length;
    const missing = decisionSignals.filter((signal) => !signal.matched).map((signal) => signal.name);
    results.push({
      evaluator: "decision-readiness",
      score: decisionScore,
      label: decisionScore === 1 ? "pass" : decisionScore >= 2 / 3 ? "warning" : "fail",
      explanation: missing.length === 0
        ? "包含量价宽度、跨资产变量和可验证的下一交易日观察框架。"
        : `仍缺少：${missing.join("、")}。`,
    });

    const freshnessSignals = ["信息新鲜度", "数据时点", "检索时间", "发布时间"]
      .filter((term) => content.includes(term));
    const distinguishesUsSession = /(上一交易日|昨夜).*(收盘)/s.test(content)
      || /(盘中|非收盘价|仍在变动)/.test(content);
    const freshnessScore = Number(freshnessSignals.length > 0) / 2 + Number(distinguishesUsSession) / 2;
    results.push({
      evaluator: "time-discipline",
      score: freshnessScore,
      label: freshnessScore === 1 ? "pass" : freshnessScore >= 0.5 ? "warning" : "fail",
      explanation: freshnessScore === 1
        ? "说明了数据新鲜度，并区分美股收盘与盘中状态。"
        : "需要同时说明数据新鲜度，并明确区分美股上一交易日收盘与当前盘中状态。",
    });
  }
  return results;
}
