import { readFile } from "node:fs/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
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
  const models = resolveModels(config);
  const model = models.getModel(config.provider, config.model);
  if (!model) {
    const examples = models.getModels(config.provider).slice(0, 8).map((item) => item.id);
    const hint = examples.length > 0 ? ` Known ${config.provider} models include: ${examples.join(", ")}.` : "";
    const customHint = config.apiBaseUrl
      ? ""
      : " For OpenAI-compatible gateways (Aliyun MaaS, Ollama, etc.), set PI_BASE_URL and PI_API_KEY.";
    throw new Error(`Unknown Pi model: ${config.provider}/${config.model}.${hint}${customHint}`);
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

function resolveModels(config: AppConfig) {
  const models = builtinModels();
  if (!config.apiBaseUrl) return models;

  const baseUrl = normalizeOpenAiBaseUrl(config.apiBaseUrl);
  const customModel = createOpenAiCompatibleModel(config, baseUrl);
  models.setProvider(createProvider({
    id: config.provider,
    name: config.provider,
    baseUrl,
    auth: {
      apiKey: envApiKeyAuth("Pi API key", [
        "PI_API_KEY",
        `${config.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`,
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
      ]),
    },
    models: [customModel],
    api: openAICompletionsApi(),
  }));
  return models;
}

function createOpenAiCompatibleModel(config: AppConfig, baseUrl: string): Model<"openai-completions"> {
  const isQwen = /qwen/i.test(config.provider) || /qwen/i.test(config.model);
  const inputPerMillion = config.modelCostInputPerMillion ?? 0;
  const outputPerMillion = config.modelCostOutputPerMillion ?? 0;
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl,
    reasoning: isQwen,
    input: ["text"],
    cost: {
      input: inputPerMillion,
      output: outputPerMillion,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 16384,
    ...(isQwen
      ? {
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            thinkingFormat: "qwen" as const,
          },
        }
      : {
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
          },
        }),
  };
}

function normalizeOpenAiBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
