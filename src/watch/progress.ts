export type WatchProgressEvent =
  | { type: "log"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_start"; name: string; label: string }
  | { type: "tool_end"; name: string; label: string; error: boolean };

const TOOL_LABELS: Record<string, string> = {
  tavily_search: "网页搜索",
  "tavily-search": "网页搜索",
  query_futu_news: "富途资讯",
  query_futu_market: "行情快照",
  read_market_indices: "指数环境",
  register_evidence: "登记证据",
  complete_watch_check: "提交检查结论",
};

export function toolProgressLabel(name: string): string {
  const base = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return TOOL_LABELS[base] ?? TOOL_LABELS[name] ?? base;
}