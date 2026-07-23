import { execFileSync, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { phoenixExecutable, projectRoot, projectSkillsDirectory } from "./project-paths.js";
import { listSkillDescriptors } from "./tools/runtime-tools.js";

const command = process.argv[2] ?? "open";
const args = process.argv.slice(3);

try {
  if (command === "open") {
    await ensureServices();
    await Promise.all([waitForAgentWeb(), waitForPhoenix()]);
    openUi();
  } else if (command === "install") {
    await ensurePhoenix();
    runProjectCli("scheduler-cli.ts", ["install"]);
    await Promise.all([waitForAgentWeb(), waitForPhoenix()]);
    openUi();
    console.log("Livermore 已安装并启动。以后直接输入 livermore 即可。");
  } else if (command === "start") {
    await ensureServices();
    await Promise.all([waitForAgentWeb(), waitForPhoenix()]);
    console.log(`Livermore 正在运行：${loadConfig().webUiUrl}`);
  } else if (command === "restart") {
    await ensurePhoenix();
    runProjectCli("scheduler-cli.ts", ["install"]);
    await Promise.all([waitForAgentWeb(), waitForPhoenix()]);
    openUi();
  } else if (command === "status") {
    await printStatus();
  } else if (command === "run") {
    const task = normalizeTask(args[0]);
    runProjectCli("briefing-cli.ts", ["--task", task, ...args.slice(1)]);
  } else if (command === "runs") {
    runProjectCli("runs-cli.ts", args);
  } else if (command === "skills") {
    await printSkills();
  } else if (command === "skill" && args[0] === "install") {
    await installSkill(args[1]);
  } else if (command === "ui" || command === "traces") {
    await ensureServices();
    if (command === "traces") {
      await waitForPhoenix();
      openUrl(loadConfig().phoenixUiUrl, "Trace 观测台");
    } else {
      await waitForAgentWeb();
      openUi();
    }
  } else if (command === "uninstall-services") {
    runProjectCli("scheduler-cli.ts", ["uninstall"]);
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else {
    throw new Error(`未知命令：${command}\n\n${helpText()}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function ensureServices(): Promise<void> {
  await ensurePhoenix();
  if (!serviceLoaded() || !(await schedulesInstalled())) {
    runProjectCli("scheduler-cli.ts", ["install"]);
  }
}

async function ensurePhoenix(): Promise<void> {
  try {
    await access(phoenixExecutable);
  } catch {
    console.log("首次运行，正在安装项目本地 Python 3.12 与 Phoenix…");
    runProjectCli("phoenix-cli.ts", ["install"]);
  }
}

async function schedulesInstalled(): Promise<boolean> {
  const labels = [
    "com.livermore.phoenix",
    "com.livermore.web",
    "com.livermore.market-pre",
    "com.livermore.ai-pre",
    "com.livermore.market-intraday",
    "com.livermore.market-close",
    "com.livermore.ai-close",
  ];
  try {
    await Promise.all(labels.map((label) => access(path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`))));
    return true;
  } catch {
    return false;
  }
}

function serviceLoaded(): boolean {
  const result = spawnSync("launchctl", ["print", `${launchDomain()}/com.livermore.phoenix`], { stdio: "ignore" });
  return result.status === 0;
}

async function waitForPhoenix(): Promise<void> {
  await waitForUrl(loadConfig().phoenixUiUrl, "Phoenix", "data/runtime/phoenix.error.log");
}

async function waitForAgentWeb(): Promise<void> {
  await waitForUrl(loadConfig().webUiUrl, "Agent Web", "data/runtime/web.error.log");
}

async function waitForUrl(url: string, label: string, logPath: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* Service is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} 未能在 20 秒内启动，请查看 ${logPath}。`);
}

async function printStatus(): Promise<void> {
  const installed = await access(phoenixExecutable).then(() => true).catch(() => false);
  console.log(`Phoenix 安装：${installed ? "是" : "否"}`);
  console.log(`Phoenix 服务：${serviceLoaded() ? "已加载" : "未加载"}`);
  if (installed) {
    try {
      const response = await fetch(loadConfig().phoenixUiUrl, { signal: AbortSignal.timeout(2_000) });
      console.log(`Phoenix Trace：${response.ok ? "可访问" : `HTTP ${response.status}`}`);
    } catch {
      console.log("Phoenix Trace：不可访问");
    }
  }
  try {
    const response = await fetch(loadConfig().webUiUrl, { signal: AbortSignal.timeout(2_000) });
    console.log(`Agent Web：${response.ok ? "可访问" : `HTTP ${response.status}`}`);
  } catch {
    console.log("Agent Web：不可访问");
  }
  runProjectCli("runs-cli.ts", ["--limit", "5"]);
}

function openUi(): void {
  openUrl(loadConfig().webUiUrl, "Livermore Agent 界面");
}

function openUrl(url: string, label: string): void {
  execFileSync("/usr/bin/open", [url], { stdio: "ignore" });
  console.log(`已打开 ${label}：${url}`);
}

function runProjectCli(filename: string, cliArgs: string[]): void {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    path.join(projectRoot, "src", filename),
    ...cliArgs,
  ], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${filename} 执行失败。`);
}

function normalizeTask(value: string | undefined): "market-briefing" | "ai-industry-chain" {
  if (value === "market" || value === "market-briefing") return "market-briefing";
  if (value === "ai" || value === "ai-industry-chain") return "ai-industry-chain";
  throw new Error("Usage: livermore run <market|ai> [--force]");
}

async function printSkills(): Promise<void> {
  const skills = await listSkillDescriptors(true);
  if (skills.length === 0) {
    console.log("Livermore 尚未安装项目 Skill。使用：livermore skill install <skill-name>");
    return;
  }
  console.table(skills.map(({ name, description, location }) => ({
    name,
    description,
    location,
    loading: "按需读取",
  })));
}

async function installSkill(slug: string | undefined): Promise<void> {
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) {
    throw new Error("Usage: livermore skill install <skill-name>");
  }
  const executable = path.join(homedir(), ".local", "bin", "iwencai-skillhub-cli");
  try {
    await access(executable);
  } catch {
    throw new Error("Iwencai SkillHub CLI 尚未安装。");
  }
  const isolatedPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && !existsSync(path.join(entry, "openclaw")))
    .join(path.delimiter);
  const result = spawnSync(executable, ["--dir", projectSkillsDirectory, "install", slug, "--force"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: isolatedPath,
      SKILLHUB_SKIP_WORKSPACE_SKILLS: "1",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Skill 安装失败：${slug}`);
  try {
    await access(path.join(projectSkillsDirectory, slug, "SKILL.md"));
  } catch {
    throw new Error(`SkillHub 未把 ${slug} 安装到 Livermore 的 skills/ 目录。`);
  }
  console.log(`Skill 已安装到 skills/${slug}，重启 Livermore 后即可使用。`);
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function printHelp(): void {
  console.log(helpText());
}

function helpText(): string {
  return `Livermore 本地投资 Agent

用法：
  livermore                  启动服务并打开 Agent Web 界面
  livermore install          安装 Phoenix、后台服务和定时任务
  livermore start            启动服务但不打开浏览器
  livermore restart          重启服务并打开 Agent Web 界面
  livermore status           查看服务状态和最近运行
  livermore run market       立即运行市场简报
  livermore run ai           立即运行 AI 产业链日报
  livermore runs             查询任务运行记录
  livermore skills           列出 Livermore 项目 Skills
  livermore skill install <name>  安装一个 Iwencai SkillHub Skill
  livermore ui               打开 Agent 对话界面
  livermore traces           打开 Phoenix Trace 界面
  livermore uninstall-services  移除后台服务和定时任务`;
}
