import { describe, expect, it } from "vitest";
import {
  isIwencaiQuotaExceeded,
  iwencaiQuotaExceededResult,
} from "../src/market/iwencai-client.js";

describe("Iwencai availability handling", () => {
  it("recognizes SkillHub quota exhaustion messages", () => {
    const error = new Error([
      "您今天的次数已用完，建议您",
      "[升级权益](https://www.iwencai.com/skillhub)获取更多额度。",
    ].join(""));
    expect(isIwencaiQuotaExceeded(error)).toBe(true);
    expect(isIwencaiQuotaExceeded(new Error("IWENCAI_API_KEY is invalid"))).toBe(false);
  });

  it("turns quota exhaustion into an auditable empty result", () => {
    const result = iwencaiQuotaExceededResult(
      "600519.SH 今日主力资金净流入",
      new Error("今天的次数已用完"),
    );
    expect(result).toMatchObject({
      success: false,
      unavailable: true,
      unavailable_reason: "quota_exceeded",
      datas: [],
    });
  });
});
