import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cursorAuthDirectory, cursorCommand } from "./agent/cursor-provider.js";
import { loadConfig, loadLocalEnv } from "./config.js";
import { verifyCursorToolCalls } from "./agent/cursor-verification.js";
import { runtimeDirectory } from "./project-paths.js";

loadLocalEnv();
const command = process.argv[2] ?? "status";
try {
  if (command === "verify") {
    console.log(JSON.stringify(await verifyCursorToolCalls(loadConfig()), null, 2));
  } else {
    if (!["login", "status", "models", "logout"].includes(command)) throw new Error("用法：livermore cursor <login|status|models|logout|verify>");
    const output = await cursorCommand(command as "login" | "status" | "models" | "logout");
    if (command === "status" || command === "models") {
      await mkdir(runtimeDirectory, { recursive: true });
      await writeFile(path.join(runtimeDirectory, `cursor-${command}.json`), JSON.stringify({
        installed: true, provider: "cursor-native", authDirectory: cursorAuthDirectory, output, checkedAt: new Date().toISOString(),
      }), { mode: 0o600 });
    }
    console.log(output);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (command === "status" || command === "models") {
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(path.join(runtimeDirectory, `cursor-${command}.json`), JSON.stringify({ error: message }), { mode: 0o600 });
  }
  console.error(message);
  process.exitCode = 1;
}
