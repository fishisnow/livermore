import { fileURLToPath } from "node:url";
import path from "node:path";

const srcDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(srcDirectory, "..");
export const projectEnvPath = path.join(projectRoot, ".env");
export const systemPromptPath = path.join(projectRoot, "prompts", "SYSTEM.md");
export const migrationInventoryPath = path.join(projectRoot, "migration", "openclaw", "inventory.json");
export const reportsDirectory = path.join(projectRoot, "data", "reports");
export const runtimeDirectory = path.join(projectRoot, "data", "runtime");
