import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { migrationInventoryPath, projectRoot } from "../project-paths.js";
import path from "node:path";

const readableAssets = {
  system_prompt: "prompts/SYSTEM.md",
  market_briefing_migration: "prompts/tasks/market-briefing.legacy.md",
  ai_industry_chain_migration: "prompts/tasks/ai-industry-chain.legacy.md",
} as const;

const emptyParameters = Type.Object({});
const readAssetParameters = Type.Object({
  asset: Type.Union(Object.keys(readableAssets).map((name) => Type.Literal(name))),
});

export function createMigrationTools(): AgentTool[] {
  const listAssets: AgentTool<typeof emptyParameters> = {
    name: "list_migration_assets",
    label: "List migration assets",
    description: "List the reviewed OpenClaw assets and their current migration status.",
    parameters: emptyParameters,
    async execute() {
      const inventory = await readFile(migrationInventoryPath, "utf8");
      return { content: [{ type: "text", text: inventory }], details: {} };
    },
  };

  const readAsset: AgentTool<typeof readAssetParameters> = {
    name: "read_migration_asset",
    label: "Read migration asset",
    description: "Read one reviewed, repository-local migration asset. This cannot access arbitrary files.",
    parameters: readAssetParameters,
    async execute(_toolCallId, params) {
      const asset = params.asset as keyof typeof readableAssets;
      const relativePath = readableAssets[asset];
      const content = await readFile(path.join(projectRoot, relativePath), "utf8");
      return { content: [{ type: "text", text: content }], details: { asset, relativePath } };
    },
  };

  return [listAssets, readAsset];
}
