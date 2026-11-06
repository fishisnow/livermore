import { fileURLToPath } from "node:url";
import path from "node:path";

const srcDirectory = path.dirname(fileURLToPath(import.meta.url));

// Application resources are read-only inside a macOS .app; user data lives outside it.
export const resourceRoot = path.resolve(process.env.LIVERMORE_RESOURCE_ROOT || path.join(srcDirectory, ".."));
export const projectRoot = path.resolve(process.env.LIVERMORE_WORKSPACE || resourceRoot);
export const projectEnvPath = path.join(projectRoot, ".env");
export const systemPromptPath = path.join(resourceRoot, "prompts", "SYSTEM.md");
export const reportsDirectory = path.join(projectRoot, "data", "reports");
export const runtimeDirectory = path.join(projectRoot, "data", "runtime");
export const databasePath = path.join(projectRoot, "data", "livermore.db");
export const phoenixVenvDirectory = path.join(projectRoot, ".venv-phoenix");
export const phoenixExecutable = path.join(phoenixVenvDirectory, "bin", "phoenix");
export const phoenixPythonExecutable = path.join(phoenixVenvDirectory, "bin", "python");
export const phoenixDataDirectory = path.join(projectRoot, "data", "phoenix");
export const webDirectory = path.join(resourceRoot, "web");
export const projectSkillsDirectory = path.join(projectRoot, "skills");

export function nodeEntrypointArguments(filename: string): string[] {
  if (import.meta.url.endsWith(".js")) {
    return [path.join(resourceRoot, "src", filename.replace(/\.ts$/, ".js"))];
  }
  return ["--import", "tsx", path.join(resourceRoot, "src", filename)];
}
