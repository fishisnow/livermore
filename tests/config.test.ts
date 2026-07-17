import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses stable project defaults", () => {
    expect(loadConfig({})).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      timezone: "Asia/Shanghai",
      tavilyApiKey: undefined,
      searchMaxResults: 5,
      briefingReportApiUrl: undefined,
      briefingReportApiKey: undefined,
      briefingPublisher: "玄弈",
    });
  });

  it("accepts an explicit Pi model", () => {
    expect(loadConfig({ PI_PROVIDER: "openai", PI_MODEL: "gpt-5-mini" })).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      timezone: "Asia/Shanghai",
      tavilyApiKey: undefined,
      searchMaxResults: 5,
      briefingReportApiUrl: undefined,
      briefingReportApiKey: undefined,
      briefingPublisher: "玄弈",
    });
  });

  it("validates the search result limit", () => {
    expect(() => loadConfig({ SEARCH_MAX_RESULTS: "0" })).toThrow("between 1 and 20");
  });
});
