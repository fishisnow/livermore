import { describe, expect, it, vi } from "vitest";
import { InvestmentDatabase } from "../src/storage/database.js";
import { defaultTaskSettings, getTaskSettings, renderBriefingPrompt, saveTaskSettings, validateTaskSettings } from "../src/tasks/task-settings.js";
import { taskDefinitions } from "../src/briefings/task-definitions.js";
import { dispatchDueTasks } from "../src/tasks/scheduler.js";
import { createCustomResearchTask, listTaskNames } from "../src/tasks/task-settings.js";

describe("configurable research tasks", () => {
  it("creates, edits and schedules custom tasks; deletion retains run history", async () => {
    const db = new InvestmentDatabase(":memory:");
    const created = createCustomResearchTask(db, { ...defaultTaskSettings("custom-draft"), title: "半导体研究" });
    expect(created.enabled).toBe(false); expect(listTaskNames(db)).toHaveLength(4);
    const enabled = saveTaskSettings(db, created.task, { ...created, enabled: true, title: "每周产业研究", times: [{ time: "10:20", mode: "research" }] });
    expect(db.getCustomTask(created.task)?.title).toBe("每周产业研究");
    const launch = vi.fn(async () => {});
    await dispatchDueTasks(db, { now: new Date("2026-11-06T02:20:00Z"), launch });
    expect(launch).toHaveBeenCalledExactlyOnceWith({ task: created.task, mode: "research", slot: `${created.task}:2026-11-06:10:20` });
    const id = db.startRun({ task: created.task, mode: "research", scheduledAt: new Date().toISOString(), idempotencyKey: "custom-test" });
    expect(db.deleteCustomTask(created.task as `custom-${string}`)).toBe(true);
    expect(listTaskNames(db)).toHaveLength(3); expect(db.getRun(id)).toBeDefined();
    await dispatchDueTasks(db, { now: new Date("2026-11-09T02:20:00Z"), launch });
    expect(launch).toHaveBeenCalledTimes(1); expect(enabled.revision).toBe(2);
    db.close();
  });
  it("preserves existing prompts and schedules as defaults", () => {
    const db = new InvestmentDatabase(":memory:");
    const input = { mode: "close" as const, nowIso: "2026-11-06T08:00:00Z", localNow: "2026-11-06 16:00", timezone: "Asia/Shanghai", sources: [{ id: "1", category: "市场", title: "最新消息 {{mode}}", summary: "真实来源", url: "https://example.com", retrievedAt: "2026-11-06T08:00:00Z" }] };
    for (const task of ["market-briefing", "ai-industry-chain"] as const) expect(renderBriefingPrompt(getTaskSettings(db, task), input)).toBe(taskDefinitions[task].buildPrompt(input));
    expect(getTaskSettings(db, "portfolio-risk-check").times.map((item) => item.time)).toEqual(["11:00", "14:30"]);
    db.close();
  });

  it("persists edits, supports pause, and rejects stale revisions", () => {
    const db = new InvestmentDatabase(":memory:");
    const original = getTaskSettings(db, "market-briefing");
    const saved = saveTaskSettings(db, "market-briefing", { ...original, enabled: false, prompt: `${original.prompt}\n只保留关键信息。`, times: [{ time: "10:15", mode: "pre-market" }] });
    expect(saved).toMatchObject({ enabled: false, revision: 1, times: [{ time: "10:15", mode: "pre-market" }] });
    expect(() => saveTaskSettings(db, "market-briefing", original)).toThrow("其他窗口");
    expect(saveTaskSettings(db, "market-briefing", { ...saved, enabled: true }).revision).toBe(2);
    db.close();
  });

  it.each([
    { timezone: "No/SuchTimezone" }, { weekdays: [] }, { weekdays: [0] },
    { times: [{ time: "24:10", mode: "close" }] }, { times: [{ time: "12:00", mode: "unknown" }] },
    { times: [{ time: "12:00", mode: "close" }, { time: "12:00", mode: "intraday" }] },
    { prompt: "缺少来源变量的错误 Prompt。不能应用到研究任务中。" },
  ])("rejects invalid task settings: %j", (invalid) => {
    expect(() => validateTaskSettings("market-briefing", { ...defaultTaskSettings("market-briefing"), ...invalid })).toThrow();
  });

  it("dispatches the configured mode once across concurrent schedulers, with local timezone", async () => {
    const db = new InvestmentDatabase(":memory:");
    const settings = defaultTaskSettings("ai-industry-chain", "America/New_York");
    saveTaskSettings(db, settings.task, { ...settings, times: [{ time: "09:15", mode: "close" }] });
    const launch = vi.fn(async () => {});
    const options = { now: new Date("2026-11-06T14:15:30Z"), launch };
    await Promise.all([dispatchDueTasks(db, options), dispatchDueTasks(db, options)]);
    expect(launch).toHaveBeenCalledExactlyOnceWith({ task: "ai-industry-chain", mode: "close", slot: "ai-industry-chain:2026-11-06:09:15" });
    db.close();
  });

  it("skips paused tasks, weekends and stale slots; retries a failed process launch", async () => {
    const db = new InvestmentDatabase(":memory:");
    const settings = defaultTaskSettings("portfolio-risk-check");
    saveTaskSettings(db, settings.task, { ...settings, enabled: false });
    const launch = vi.fn(async () => {});
    await dispatchDueTasks(db, { now: new Date("2026-11-06T03:00:00Z"), launch });
    expect(launch).not.toHaveBeenCalled();
    saveTaskSettings(db, settings.task, { ...getTaskSettings(db, settings.task), enabled: true });
    await dispatchDueTasks(db, { now: new Date("2026-11-07T03:00:00Z"), launch });
    await dispatchDueTasks(db, { now: new Date("2026-11-06T03:10:00Z"), launch });
    expect(launch).not.toHaveBeenCalled();
    await expect(dispatchDueTasks(db, { now: new Date("2026-11-06T03:01:00Z"), launch: async () => { throw new Error("spawn failed"); } })).rejects.toThrow("spawn failed");
    await dispatchDueTasks(db, { now: new Date("2026-11-06T03:02:00Z"), launch });
    expect(launch).toHaveBeenCalledTimes(1);
    db.close();
  });
});
