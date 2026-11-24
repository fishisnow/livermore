import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { InvestmentDatabase } from "../src/storage/database.js";
import { applyIdeaEnrichment, draftFromHoldings, draftFromIdea } from "../src/watch/draft.js";
import { isResearchTheme } from "../src/watch/model.js";
import { claimsMatch } from "../src/watch/judge.js";
import { evidenceFromResults } from "../src/watch/search.js";
import { dispatchDueWatches } from "../src/watch/schedule.js";
import { checkWatch, deleteTrackingWatch, isWatchDue, listRadar, proposeIdea, startTracking, updateWatchFocus, updateWatchTheme, type SignalNotice } from "../src/watch/service.js";
import type { EvidenceItem } from "../src/watch/types.js";

const config = { provider: "deepseek", model: "test", timezone: "Asia/Shanghai", searchMaxResults: 5, watchAgentMaxTurns: 32 } as AppConfig;
const now = new Date("2026-11-20T01:00:00.000Z");

function article(patch: Partial<EvidenceItem> & Pick<EvidenceItem, "title" | "url" | "publisher">): EvidenceItem {
  return {
    summary: patch.summary ?? patch.title,
    publishedAt: "2026-11-20T00:00:00.000Z",
    ...patch,
  };
}

function found(items: EvidenceItem[]) {
  return async () => ({ ok: true as const, items, queries: ["DRAM 价格"] });
}

describe("投资观察候选", () => {
  it("从存储持仓提出周期、供给和估值三个问题", () => {
    const drafts = draftFromHoldings([{ symbol: "SH.688981", name: "长鑫科技" }]);
    expect(drafts.map((draft) => draft.question)).toEqual([
      "DRAM 存储周期是否正在见顶？",
      "HBM 扩产是否挤压传统 DRAM 供给？",
      "全球存储行业是否正在发生估值重定价？",
    ]);
    expect(drafts[0]?.scope.focus).toEqual(["价格趋势", "供需预测", "原厂扩产", "机构观点"]);
    expect(drafts.every((draft) => draft.scope.queries.length > 0)).toBe(true);
    const mixed = draftFromHoldings([
      { symbol: "600309", name: "万华化学" },
      { symbol: "159516", name: "半导体设备ETF易方达" },
    ]);
    expect(mixed.map((draft) => draft.question)).toEqual([
      "万华化学的盈利预期是否正在被下修？",
      "半导体设备ETF易方达跟踪的行业估值是否正在重定价？",
    ]);
  });

  it("把一句话变成带观察范围的候选", () => {
    const draft = draftFromIdea("我想跟踪 AI 巨头的资本开支增速是否开始放缓。");
    expect(draft.question).toBe("我想跟踪 AI 巨头的资本开支增速是否开始放缓。");
    expect(draft.scope.focus).toEqual(expect.arrayContaining(["资本开支", "增速"]));
    expect(draft.scope.symbols).toEqual(expect.arrayContaining(["英伟达", "微软"]));
    expect(draft.origin).toBe("user");
  });

  it("模型 enrichment 补全 focus 时不改写用户问句", () => {
    const base = draftFromIdea("黄金市场是否正在形成阶段性底部？");
    expect(base.scope.focus).toEqual(["公开信息"]);
    const merged = applyIdeaEnrichment(base, {
      rationale: "验证黄金市场是否在形成阶段性底部。",
      focus: ["实际利率", "美元指数", "ETF 资金流", "央行购金"],
      symbols: [],
      sectors: ["贵金属"],
    });
    expect(merged.question).toBe("黄金市场是否正在形成阶段性底部？");
    expect(merged.scope.focus).toEqual(["实际利率", "美元指数", "ETF 资金流", "央行购金"]);
    expect(merged.scope.sectors).toEqual(["贵金属"]);
    expect(merged.scope.queries.length).toBeGreaterThan(0);
  });

  it("调研主题是一个可对照的预期，不是观察清单", () => {
    expect(isResearchTheme("黄金价格是否已接近底部，后续应观察哪些宏观、供需与资金流信号来验证？")).toBe(false);
    expect(isResearchTheme("黄金的中期定价是否仍由实际利率主导，还是已转向央行购金与供给约束？")).toBe(true);
    expect(isResearchTheme("黄金市场是否正在形成阶段性底部？")).toBe(true);
    expect(isResearchTheme("DRAM 存储周期是否正在见顶？")).toBe(true);
  });
});

describe("每日增量判断", () => {
  it("搜索失败不会写成没有变化，转载不重复发信号，共识转向才标成重要", async () => {
    const database = new InvestmentDatabase(":memory:");
    const notices: SignalNotice[] = [];
    const listed = await proposeIdea(database, config, "我想跟踪 DRAM 存储周期是否正在见顶。", now);
    const candidate = listed.candidates.find((item) => item.origin === "user");
    expect(candidate).toBeTruthy();
    await expect(checkWatch(database, candidate!.id, { now, search: found([]), notify: async (notice) => { notices.push(notice); } }))
      .rejects.toThrow("只有正在跟踪的问题才会检查");

    const watch = startTracking(database, candidate!.id, now);
    const failed = await checkWatch(database, watch.id, {
      now,
      search: async () => ({ ok: false, reason: "unavailable", message: "还没有可用的搜索配置，这次检查没有完成。", queries: ["DRAM"] }),
    });
    expect(failed).toMatchObject({ status: "failed", error: "还没有可用的搜索配置，这次检查没有完成。" });
    expect(failed.coverage).toMatchObject({ search: "unavailable", judgment: "skipped" });
    expect(failed.queryScope.queries).toEqual(["DRAM"]);
    expect(database.watches.getWatch(watch.id)?.lastCheckedAt).toBeNull();

    const baseline = await checkWatch(database, watch.id, {
      now,
      search: found([article({
        title: "美光维持既有扩产计划",
        url: "https://news.example.com/plan",
        publisher: "news.example.com",
        summary: "美光维持既有扩产计划，没有更新投产时间。",
      })]),
    });
    expect(baseline.status).toBe("no_change");
    expect(baseline.coverage.judgment).toBe("baseline");
    expect(database.watches.listSignals(watch.id)).toHaveLength(0);
    expect(database.watches.getWatch(watch.id)?.state.baselined).toBe(true);
    expect(database.watches.getWatch(watch.id)?.state.baselineSources).toEqual([
      expect.objectContaining({
        title: "美光维持既有扩产计划",
        url: "https://news.example.com/plan",
        summary: "美光维持既有扩产计划，没有更新投产时间。",
      }),
    ]);
    expect(database.watches.getWatch(watch.id)?.lastCheckedAt).toBe(now.toISOString());

    const reprint = await checkWatch(database, watch.id, {
      now: new Date("2026-11-21T01:00:00.000Z"),
      search: found([
        article({ title: "财联社：美光维持既有扩产计划", url: "https://news.example.com/reprint-a", publisher: "news.example.com", summary: "多家媒体重复报道美光维持既有扩产计划。", publishedAt: "2026-11-21T00:00:00.000Z" }),
        article({ title: "新浪财经：美光维持既有扩产计划", url: "https://finance.example.cn/reprint-b", publisher: "finance.example.cn", summary: "美光维持既有扩产计划。", publishedAt: "2026-11-21T00:00:00.000Z" }),
      ]),
    });
    expect(reprint.status).toBe("no_change");
    expect(database.watches.listSignals(watch.id)).toHaveLength(0);

    const changed = await checkWatch(database, watch.id, {
      now: new Date("2026-11-22T01:00:00.000Z"),
      search: found([
        article({
          title: "高盛下修NAND未来合约价格预期",
          url: "https://research.example.com/gs",
          publisher: "research.example.com",
          summary: "高盛下修 NAND 未来合约价格，认为价格可能转弱。",
          publishedAt: "2026-11-22T00:00:00.000Z",
        }),
        article({
          title: "摩根士丹利下调NAND价格预测",
          url: "https://notes.example.org/ms",
          publisher: "notes.example.org",
          summary: "摩根士丹利下调 NAND 价格预测，并下修盈利预期。",
          publishedAt: "2026-11-22T00:00:00.000Z",
        }),
      ]),
      notify: async (notice) => { notices.push(notice); },
    });
    const signals = database.watches.listSignals(watch.id);
    expect(changed.status).toBe("changed");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: "narrative_shift",
      direction: "bearish",
      importance: "important",
      impact: "weakens_thesis",
    });
    expect(signals[0]?.sources.map((source) => source.url)).toEqual([
      "https://research.example.com/gs",
      "https://notes.example.org/ms",
    ]);
    expect(notices).toHaveLength(1);

    const again = await checkWatch(database, watch.id, {
      now: new Date("2026-11-23T01:00:00.000Z"),
      search: found([
        article({
          title: "高盛下修NAND未来合约价格预期",
          url: "https://wire.example.net/gs-copy",
          publisher: "wire.example.net",
          summary: "高盛下修 NAND 未来合约价格，认为价格可能转弱。",
          publishedAt: "2026-11-23T00:00:00.000Z",
        }),
      ]),
      notify: async (notice) => { notices.push(notice); },
    });
    expect(again.status).toBe("no_change");
    expect(database.watches.listSignals(watch.id)).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(database.watches.getWatch(watch.id)?.state.baselineSources.map((source) => source.url)).toEqual(["https://news.example.com/plan"]);
    database.close();
  });

  it("单份看空报告和没有改变判断的新信息都不标成叙事转向", async () => {
    const database = new InvestmentDatabase(":memory:");
    const watch = startTracking(database, (await proposeIdea(database, config, "跟踪存储行业的价格与资本开支。", now)).candidates.find((item) => item.origin === "user")!.id, now);
    await checkWatch(database, watch.id, { now, search: found([]) });
    const single = await checkWatch(database, watch.id, {
      now: new Date("2026-11-21T01:00:00.000Z"),
      search: found([
        article({
          title: "一份研报看空存储周期并认为价格见顶",
          url: "https://broker.example.com/note",
          publisher: "broker.example.com",
          summary: "该研报认为 DRAM 价格见顶，周期将转弱。",
          publishedAt: "2026-11-21T00:00:00.000Z",
        }),
        article({
          title: "存储厂商发布品牌宣传片",
          url: "https://brand.example.com/video",
          publisher: "brand.example.com",
          summary: "官方账号更新了品牌故事。",
        }),
      ]),
    });
    const signals = database.watches.listSignals(watch.id);
    expect(single.status).toBe("changed");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.type).not.toBe("narrative_shift");
    expect(signals[0]?.importance).toBe("notable");
    expect(signals[0]?.sources).toHaveLength(1);

    const capex = await checkWatch(database, watch.id, {
      now: new Date("2026-11-22T01:00:00.000Z"),
      search: found([article({
        title: "美光上修资本开支并提前投产",
        url: "https://news.example.com/capex",
        publisher: "news.example.com",
        summary: "美光上修下一财年资本开支，传统 DRAM 投产时间提前。",
        publishedAt: "2026-11-22T00:00:00.000Z",
      })]),
    });
    expect(capex.status).toBe("changed");
    const capexSignal = database.watches.listSignals(watch.id).find((signal) => signal.summary.includes("资本开支"));
    expect(capexSignal?.importance).toBe("notable");
    expect(capexSignal?.direction).toBe("bullish");
    expect(capexSignal?.type).not.toBe("narrative_shift");
    database.close();
  });

  it("连续七天只留下单一修正和多来源转向，重复与普通涨跌不产生信号", async () => {
    const database = new InvestmentDatabase(":memory:");
    const notices: SignalNotice[] = [];
    const listed = await proposeIdea(database, config, "跟踪黄金市场是否正在形成阶段性底部。", now);
    const watch = startTracking(database, listed.candidates.find((item) => item.origin === "user")!.id, now);
    const day = (offset: number) => new Date(Date.parse("2026-11-16T01:00:00.000Z") + offset * 86_400_000);
    const on = (offset: number) => day(offset).toISOString();

    const baseline = await checkWatch(database, watch.id, {
      now: day(0),
      search: found([
        article({ title: "现货黄金回落至 4000 美元附近", url: "https://news.example.com/gold-a", publisher: "news.example.com", summary: "黄金价格回落，美元走强。", publishedAt: on(0) }),
        article({ title: "金价报 3538 美元", url: "https://mkt.example.com/gold-b", publisher: "mkt.example.com", summary: "另一则报道称黄金价格为 3538 美元。", publishedAt: on(0) }),
        article({ title: "库库AI", url: "https://kuku.example.com/landing", publisher: "kuku.example.com", summary: "一份文档落地页。", publishedAt: on(0) }),
      ]),
    });
    const opened = database.watches.getWatch(watch.id);
    expect(baseline.status).toBe("no_change");
    expect(baseline.summary).toContain("不把已有公开信息写成变化");
    expect(opened?.state.expectationKnown).toBe(false);
    expect(opened?.state.marketExpectation).toBe("预期未知。");
    expect(opened?.state.currentNarrative).toContain("价格");
    expect(opened?.state.uncertainties).toContain("不同来源的价格口径差得比较大，不能并成一个判断。");
    expect(opened?.state.baselineSources.map((source) => source.url)).toEqual([
      "https://news.example.com/gold-a",
      "https://mkt.example.com/gold-b",
    ]);

    for (let offset = 1; offset <= 5; offset += 1) {
      const items = [
        article({ title: "现货黄金回落至 4000 美元附近", url: `https://wire.example.com/gold-reprint-${offset}`, publisher: "wire.example.com", summary: "黄金价格回落，美元走强。", publishedAt: on(offset) }),
        article({ title: "黄金价格今日上涨 1%", url: `https://mkt.example.com/gold-up-${offset}`, publisher: "mkt.example.com", summary: "黄金价格今日上涨 1%，没有改变利率或需求判断。", publishedAt: on(offset) }),
      ];
      if (offset === 2) {
        items.push(article({ title: "高盛去年下修黄金目标价", url: "https://old.example.com/gold-old", publisher: "old.example.com", summary: "高盛下修黄金目标价至 3000 美元。", publishedAt: "2026-10-01T00:00:00.000Z" }));
      }
      const run = await checkWatch(database, watch.id, {
        now: day(offset),
        search: found(items),
        notify: async (notice) => { notices.push(notice); },
      });
      expect(run.status).toBe("no_change");
      expect(run.summary).toContain("暂未发现足以改变当前判断的新证据");
      expect(database.watches.listSignals(watch.id)).toHaveLength(0);
    }

    const revision = await checkWatch(database, watch.id, {
      now: day(6),
      search: found([article({
        title: "高盛下修黄金目标价至 3600 美元",
        url: "https://research.example.com/gs-gold",
        publisher: "research.example.com",
        summary: "高盛将未来 12 个月黄金目标价从 4000 美元下修至 3600 美元，并下调实际利率预测。",
        publishedAt: on(6),
      })]),
      notify: async (notice) => { notices.push(notice); },
    });
    expect(revision.status).toBe("changed");
    expect(database.watches.listSignals(watch.id)).toHaveLength(1);
    expect(database.watches.listSignals(watch.id)[0]).toMatchObject({ type: "expectation_revision", importance: "notable" });
    expect(database.watches.getWatch(watch.id)?.state.expectationKnown).toBe(false);
    expect(database.watches.getWatch(watch.id)?.state.currentNarrative).toBe(opened?.state.currentNarrative);
    expect(notices).toHaveLength(0);

    const shift = await checkWatch(database, watch.id, {
      now: day(7),
      search: found([
        article({ title: "景顺下调黄金价格预测", url: "https://funds.example.com/ivz", publisher: "funds.example.com", summary: "景顺下调黄金价格预测，认为价格转弱。", publishedAt: on(7) }),
        article({ title: "法兴下修黄金目标价", url: "https://bank.example.com/socgen", publisher: "bank.example.com", summary: "法兴下修黄金未来价格，并下调盈利预期。", publishedAt: on(7) }),
        article({ title: "瑞银下调黄金价格预测", url: "https://bank.example.org/ubs", publisher: "bank.example.org", summary: "瑞银下调黄金价格预测，价格转弱。", publishedAt: on(7) }),
      ]),
      notify: async (notice) => { notices.push(notice); },
    });
    const signals = database.watches.listSignals(watch.id);
    expect(shift.status).toBe("changed");
    expect(signals).toHaveLength(2);
    expect(signals.find((signal) => signal.type === "narrative_shift")).toMatchObject({ importance: "important", direction: "bearish" });
    expect(database.watches.getWatch(watch.id)?.state.expectationKnown).toBe(true);
    expect(notices).toHaveLength(1);
    database.close();
  });
});

describe("删除跟踪", () => {
  it("删除主题会级联移除 runs 与 signals", async () => {
    const database = new InvestmentDatabase(":memory:");
    const listed = await proposeIdea(database, config, "跟踪 DRAM 存储周期是否正在见顶。", now);
    const watch = startTracking(database, listed.candidates.find((item) => item.origin === "user")!.id, now);
    await checkWatch(database, watch.id, {
      now,
      search: found([article({
        title: "美光维持既有扩产计划",
        url: "https://news.example.com/plan",
        publisher: "news.example.com",
        summary: "美光维持既有扩产计划。",
      })]),
    });
    expect(database.watches.listRuns(watch.id).length).toBeGreaterThan(0);
    deleteTrackingWatch(database, watch.id);
    expect(database.watches.getWatch(watch.id)).toBeUndefined();
    expect(database.watches.listRuns(watch.id)).toEqual([]);
    expect(database.watches.listSignals(watch.id)).toEqual([]);
    database.close();
  });
});

describe("观察主题", () => {
  it("可以手动修改问题并刷新检索词", async () => {
    const database = new InvestmentDatabase(":memory:");
    const listed = await proposeIdea(database, config, "跟踪 DRAM 存储周期是否正在见顶。", now);
    const watch = startTracking(database, listed.candidates.find((item) => item.origin === "user")!.id, now);
    const updated = updateWatchTheme(database, config, watch.id, "DRAM 合约价格预期是否正在转弱？", now);
    expect(updated.watch.question).toBe("DRAM 合约价格预期是否正在转弱？");
    expect(updated.watch.scope.queries[0]).toContain("DRAM");
    database.close();
  });

  it("可以补充重点监测并同步检索词", async () => {
    const database = new InvestmentDatabase(":memory:");
    const listed = await proposeIdea(database, config, "跟踪 DRAM 存储周期是否正在见顶。", now);
    const watch = startTracking(database, listed.candidates.find((item) => item.origin === "user")!.id, now);
    const baseFocus = database.watches.getWatch(watch.id)!.scope.focus;
    const updated = updateWatchFocus(database, config, watch.id, [...baseFocus, "合约价格"], now);
    expect(updated.watch.scope.focus).toEqual(expect.arrayContaining(["合约价格"]));
    expect(updated.watch.scope.queries.some((query) => query.includes("合约价格") || query.includes(baseFocus[0] ?? ""))).toBe(true);
    database.close();
  });
});

describe("雷达调度", () => {
  it("每个本地日 07:50 之后检查一次，失败半小时后才重试", async () => {
    const morning = new Date("2026-11-22T23:00:00.000Z");
    const open = new Date("2026-11-23T02:30:00.000Z");
    expect(isWatchDue({ status: "active", lastCheckedAt: null, latestFinishedAt: null, now: morning, timeZone: "Asia/Shanghai" })).toBe(false);
    expect(isWatchDue({ status: "active", lastCheckedAt: null, latestFinishedAt: null, now: open, timeZone: "Asia/Shanghai" })).toBe(true);
    expect(isWatchDue({ status: "paused", lastCheckedAt: null, latestFinishedAt: null, now: open, timeZone: "Asia/Shanghai" })).toBe(false);
    expect(isWatchDue({
      status: "active",
      lastCheckedAt: "2026-11-23T01:00:00.000Z",
      latestFinishedAt: "2026-11-23T01:00:00.000Z",
      now: open,
      timeZone: "Asia/Shanghai",
    })).toBe(false);
    expect(isWatchDue({
      status: "active",
      lastCheckedAt: null,
      latestFinishedAt: new Date(open.getTime() - 10 * 60_000).toISOString(),
      now: open,
      timeZone: "Asia/Shanghai",
    })).toBe(false);

    const database = new InvestmentDatabase(":memory:");
    const candidate = database.watches.insertWatch(draftFromIdea("跟踪存储价格是否转弱。"));
    database.watches.activate(candidate.id, "2026-11-22T00:00:00.000Z");
    let launches = 0;
    await expect(dispatchDueWatches(database, { now: morning, timeZone: "Asia/Shanghai", enabled: true, launch: async () => { launches += 1; } })).resolves.toBe(false);
    await expect(dispatchDueWatches(database, { now: open, timeZone: "Asia/Shanghai", enabled: true, launch: async () => { launches += 1; } })).resolves.toBe(true);
    await expect(dispatchDueWatches(database, { now: open, timeZone: "Asia/Shanghai", enabled: true, launch: async () => { launches += 1; } })).resolves.toBe(false);
    expect(launches).toBe(1);
    expect(listRadar(database, config, open).tracking).toHaveLength(1);
    database.close();
  });
});

describe("Agent 立即检查", () => {
  it("默认走 ReAct Agent 路径并由规则引擎发 Signal", async () => {
    const database = new InvestmentDatabase(":memory:");
    const listed = await proposeIdea(database, config, "跟踪 DRAM 存储周期是否正在见顶。", now);
    const watch = startTracking(database, listed.candidates.find((item) => item.origin === "user")!.id, now);
    const agentConfig = { ...config, watchAgentMaxTurns: 8 } as AppConfig;
    const run = await checkWatch(database, watch.id, {
      now,
      config: agentConfig,
      database,
      runAgent: async () => ({
        ok: true,
        message: "",
        evidence: [
          article({
            title: "美光维持既有扩产计划",
            url: "https://news.example.com/plan",
            publisher: "news.example.com",
            summary: "美光维持既有扩产计划，没有更新投产时间。",
          }),
        ],
        queries: ["DRAM 价格 供给"],
        summary: "已建立基线：本轮登记 1 条证据。",
        agentNote: "Agent 自主检索后登记证据。",
        narrativePatch: {
          currentNarrative: "市场关注 DRAM 供给是否继续扩张。",
          marketExpectation: "预期未知。",
          expectationKnown: false,
          uncertainties: ["扩产节奏口径不一"],
        },
        turnCount: 3,
        searchUsed: true,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0, costCurrency: "USD" },
      }),
    });
    expect(run.coverage.judgment).toBe("agent");
    expect(run.coverage.evidence).toHaveLength(1);
    expect(run.coverage.note).toContain("3/8");
    expect(database.watches.getWatch(watch.id)?.state.baselineSources).toHaveLength(1);
    expect(database.watches.getWatch(watch.id)?.state.currentNarrative).toContain("DRAM");
    database.close();
  });
});

describe("证据整理", () => {
  it("丢掉没有链接的结果，并认出同一篇转载", () => {
    const items = evidenceFromResults([
      { title: "有链接", url: "https://example.com/a?utm_source=x", content: "正文" },
      { title: "没有链接", content: "正文" },
    ]);
    expect(items).toHaveLength(1);
    expect(claimsMatch("美光维持既有扩产计划", "财联社：美光维持既有扩产计划")).toBe(true);
    expect(claimsMatch("高盛下修NAND价格预期", "美光上修资本开支并提前投产")).toBe(false);
  });
});
