import { execFileSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  phoenixDataDirectory,
  phoenixExecutable,
  phoenixPythonExecutable,
  phoenixVenvDirectory,
  projectRoot,
} from "./project-paths.js";

const command = process.argv[2];

try {
  if (command === "install") {
    const uvEnvironment = {
      ...process.env,
      UV_CACHE_DIR: path.join(projectRoot, "data", "runtime", "uv-cache"),
      UV_PYTHON_INSTALL_DIR: path.join(projectRoot, ".python"),
    };
    execFileSync("uv", ["venv", "--python", "3.12", phoenixVenvDirectory], { stdio: "inherit", env: uvEnvironment });
    execFileSync("uv", ["pip", "install", "--python", phoenixPythonExecutable, "arize-phoenix"], { stdio: "inherit", env: uvEnvironment });
    printPhoenixVersion();
    console.log(`Phoenix 已安装到 ${phoenixVenvDirectory}`);
  } else if (command === "start") {
    await requireInstallation();
    await mkdir(phoenixDataDirectory, { recursive: true });
    execFileSync(phoenixExecutable, ["serve"], { stdio: "inherit", env: phoenixEnvironment() });
  } else if (command === "status") {
    await requireInstallation();
    printPhoenixVersion();
    try {
      const response = await fetch("http://127.0.0.1:6006/", { signal: AbortSignal.timeout(2_000) });
      console.log(response.ok ? "Phoenix 正在 http://127.0.0.1:6006 运行。" : `Phoenix 返回 HTTP ${response.status}。`);
    } catch {
      console.log("Phoenix 已安装，但当前没有运行。");
    }
  } else {
    throw new Error("Usage: npm run phoenix -- <install|start|status>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function printPhoenixVersion(): void {
  execFileSync(phoenixPythonExecutable, [
    "-c",
    "from importlib.metadata import version; print('Phoenix ' + version('arize-phoenix'))",
  ], { stdio: "inherit" });
}

export function phoenixEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PHOENIX_HOST: "127.0.0.1",
    PHOENIX_WORKING_DIR: phoenixDataDirectory,
    PHOENIX_ALLOW_EXTERNAL_RESOURCES: "false",
    PHOENIX_TELEMETRY_ENABLED: "false",
    PHOENIX_DEFAULT_RETENTION_POLICY_DAYS: "90",
  };
}

async function requireInstallation(): Promise<void> {
  try {
    await access(phoenixExecutable);
  } catch {
    throw new Error("Phoenix 尚未安装，请先运行：npm run phoenix -- install");
  }
}
