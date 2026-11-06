import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import type { AppConfig } from "../config.js";
import { observeAgent, Telemetry } from "../observability/telemetry.js";
import { cursorProvider, CursorRuntime } from "./cursor-provider.js";

/** A live diagnostic with synthetic data only: no portfolio, files, or messages. */
export async function verifyCursorToolCalls(config: AppConfig, runtime = new CursorRuntime()) {
  const modelId = config.provider === "cursor" ? config.model : "auto";
  const telemetry = Telemetry.create(config);
  let agent: Agent | undefined;
  try {
    const models = createModels();
    models.setProvider(await cursorProvider(modelId, runtime));
    let calls = 0;
    let turns = 0;
    let proof: string | undefined;
    agent = new Agent({
      initialState: {
        model: models.getModel("cursor", modelId)!, thinkingLevel: "off",
        systemPrompt: "You are verifying a Pi tool integration. Call livermore_probe exactly once with purpose tool-call-check. Then reply with the exact proof returned by that tool. Do not use any other tools or invent a proof. Keep the reply short.",
        tools: [{
          name: "livermore_probe", label: "Livermore tool probe",
          description: "Return a fresh, unpredictable proof that a Livermore Pi tool executed.",
          parameters: obj({ purpose: str() }),
          execute: async (_id, args) => {
            if (args.purpose !== "tool-call-check") throw new Error("Invalid probe purpose");
            calls += 1;
            proof = `livermore-${randomUUID()}`;
            return { content: [{ type: "text", text: JSON.stringify({ proof }) }], details: {} };
          },
        }],
      },
      streamFn: models.streamSimple.bind(models), sessionId: randomUUID(),
    });
    const timer = setTimeout(() => agent!.abort(), 120_000);
    const unsubscribe = agent.subscribe((event) => { if (event.type === "turn_end" && ++turns >= 4) agent!.abort(); });
    try {
      return await telemetry.withSpan("cursor.provider.verify", { "openinference.span.kind": "AGENT", "livermore.diagnostic": true }, async (span, parentContext) => {
        const observation = observeAgent(agent!, telemetry, parentContext);
        try {
          await agent!.prompt("Verify the native Pi tool-call round trip now.");
          if (agent!.state.errorMessage) throw new Error(agent!.state.errorMessage);
          const final = agent!.state.messages.at(-1);
          const text = final?.role === "assistant" ? final.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
          if (calls !== 1 || turns < 2 || !proof || !text.includes(proof)) throw new Error(`Cursor 工具闭环验证失败（工具执行 ${calls} 次，模型轮次 ${turns}）。`);
          span.setAttribute("livermore.verify.tool_calls", calls);
          span.setAttribute("livermore.verify.model_turns", turns);
          return { ok: true, provider: "cursor-native", model: modelId, toolCalls: calls, modelTurns: turns, traceId: telemetry.enabled ? span.spanContext().traceId : null, usage: observation.usage };
        } finally { observation.unsubscribe(); }
      });
    } finally { clearTimeout(timer); unsubscribe(); }
  } finally { agent?.abort(); runtime.close(); await telemetry.shutdown(); }
}
