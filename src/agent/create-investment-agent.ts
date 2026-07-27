import { readFile } from "node:fs/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../config.js";
import { systemPromptPath } from "../project-paths.js";
import { createReportTool } from "../tools/report-tool.js";

export interface InvestmentAgentOptions {
  tools?: AgentTool<any>[];
  systemPromptAppend?: string;
  includeReportTool?: boolean;
}

export async function createInvestmentAgent(config: AppConfig, options: InvestmentAgentOptions = {}): Promise<Agent> {
  const models = builtinModels();
  const model = models.getModel(config.provider, config.model);
  if (!model) {
    const examples = models.getModels(config.provider).slice(0, 8).map((item) => item.id);
    const hint = examples.length > 0 ? ` Known ${config.provider} models include: ${examples.join(", ")}.` : "";
    throw new Error(`Unknown Pi model: ${config.provider}/${config.model}.${hint}`);
  }

  const systemPrompt = [
    await readFile(systemPromptPath, "utf8"),
    options.systemPromptAppend?.trim(),
  ].filter(Boolean).join("\n\n");
  const tools = [
    ...(options.includeReportTool === false ? [] : [createReportTool()]),
    ...(options.tools ?? []),
  ];
  const allowed = new Set(tools.map((tool) => tool.name));
  return new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: "medium",
      tools,
    },
    streamFn: models.streamSimple.bind(models),
    toolExecution: "parallel",
    beforeToolCall: async ({ toolCall }) => {
      if (!allowed.has(toolCall.name)) {
        return { block: true, reason: `Tool ${toolCall.name} is not allowed by the research-only policy.` };
      }
      return undefined;
    },
  });
}
