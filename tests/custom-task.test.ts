import { describe, it, expect } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { InvestmentDatabase } from "../src/storage/database.js";
import { createCustomResearchTask, defaultTaskSettings } from "../src/tasks/task-settings.js";
import { runCustomTask } from "../src/tasks/run-custom-task.js";

it("runs a new research task through Pi, persists a report and posts to the local inbox", async () => {
  const db = new InvestmentDatabase(":memory:");
  const task = createCustomResearchTask(db, { ...defaultTaskSettings("custom-draft"), title: "测试研究", prompt: "请执行测试研究，检查当前时间 {{localNow}} 并输出简短研究报告。" });
  const directory = await mkdtemp(path.join(tmpdir(), "livermore-custom-run-"));
  const model = { id: "test", provider: "test", api: "test", baseUrl: "", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
  let received = "";
  const agent = new Agent({ initialState: { model }, streamFn: (_model, context) => {
    received = JSON.stringify(context);
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "## 研究总结\n\n本地测试报告，不是真实行情。" }], api: "test", provider: "test", model: "test", timestamp: Date.now(), stopReason: "stop", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
  } });
  try {
    const result = await runCustomTask({ task: task.task as `custom-${string}`, config: loadConfig({ TRACING_ENABLED: "false", MACOS_NOTIFICATIONS_ENABLED: "false" }), database: db, reportDirectory: directory, createAgent: async () => agent });
    expect(received).not.toContain("{{localNow}}");
    expect(db.getRun(result.runId!)?.status).toBe("succeeded");
    expect(await readFile(result.reportPath, "utf8")).toContain("研究总结");
    expect(db.listAlerts()[0]).toMatchObject({ title: "Livermore 研究完成：测试研究", runId: result.runId });
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
