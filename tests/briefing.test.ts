import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DedupeStore } from "../src/briefings/dedupe-store.js";
import { stableSourceId } from "../src/briefings/source-provider.js";
import { resolveAiMode, resolveMarketMode } from "../src/briefings/task-definitions.js";
import type { SourceItem } from "../src/briefings/types.js";

describe("briefing modes", () => {
  it("uses Beijing local time for market sessions", () => {
    expect(resolveMarketMode(new Date("2026-07-16T01:00:00Z"), "Asia/Shanghai")).toBe("pre-market");
    expect(resolveMarketMode(new Date("2026-07-16T04:00:00Z"), "Asia/Shanghai")).toBe("intraday");
    expect(resolveMarketMode(new Date("2026-07-16T08:00:00Z"), "Asia/Shanghai")).toBe("close");
  });

  it("supports AI pre-market and close modes", () => {
    expect(resolveAiMode(new Date("2026-07-16T00:30:00Z"), "Asia/Shanghai")).toBe("pre-market");
    expect(resolveAiMode(new Date("2026-07-16T08:00:00Z"), "Asia/Shanghai")).toBe("close");
  });
});

describe("source identity and deduplication", () => {
  it("ignores fragments and tracking parameters in stable IDs", () => {
    expect(stableSourceId("https://example.com/news?id=7&utm_source=x#top"))
      .toBe(stableSourceId("https://example.com/news?id=7"));
  });

  it("commits IDs only when explicitly requested", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "xuanyi-dedupe-"));
    const store = new DedupeStore(directory);
    const source: SourceItem = {
      id: "source-1",
      category: "A股",
      title: "示例",
      url: "https://example.com/1",
      summary: "示例摘要",
      retrievedAt: "2026-07-16T01:00:00.000Z",
    };

    expect(await store.unseen("market-briefing", "2026-07-16", [source])).toEqual([source]);
    await store.commit("market-briefing", "2026-07-16", [source], new Date("2026-07-16T01:00:00Z"));
    expect(await store.unseen("market-briefing", "2026-07-16", [source])).toEqual([]);

    const state = JSON.parse(await readFile(path.join(directory, "2026-07-16-market-briefing.json"), "utf8"));
    expect(state.sourceIds).toEqual(["source-1"]);
  });
});
