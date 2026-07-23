import { fileURLToPath } from "node:url";
import path from "node:path";

const srcDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(srcDirectory, "..");
export const projectEnvPath = path.join(projectRoot, ".env");
export const systemPromptPath = path.join(projectRoot, "prompts", "SYSTEM.md");
export const reportsDirectory = path.join(projectRoot, "data", "reports");
export const runtimeDirectory = path.join(projectRoot, "data", "runtime");
export const databasePath = path.join(projectRoot, "data", "livermore.db");
export const phoenixVenvDirectory = path.join(projectRoot, ".venv-phoenix");
export const phoenixExecutable = path.join(phoenixVenvDirectory, "bin", "phoenix");
export const phoenixPythonExecutable = path.join(phoenixVenvDirectory, "bin", "python");
export const phoenixDataDirectory = path.join(projectRoot, "data", "phoenix");
export const webDirectory = path.join(projectRoot, "web");
export const projectSkillsDirectory = path.join(projectRoot, "skills");
