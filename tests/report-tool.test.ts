import { describe, expect, it } from "vitest";
import { normalizeReportName } from "../src/tools/report-tool.js";

describe("normalizeReportName", () => {
  it("turns a title into a repository-local markdown filename", () => {
    expect(normalizeReportName("康方生物 复盘 / 2026-07-16")).toBe("康方生物-复盘-2026-07-16.md");
  });

  it("rejects path-only input", () => {
    expect(() => normalizeReportName("../../")).toThrow();
  });
});
