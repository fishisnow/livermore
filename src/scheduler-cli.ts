import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { nodeEntrypointArguments, phoenixDataDirectory, phoenixExecutable, projectRoot, resourceRoot } from "./project-paths.js";

interface Schedule {
  label: string;
  entrypoint: string;
  args: string[];
  times: Array<{ hour: number; minute: number }>;
  description: string;
}

const schedules: Schedule[] = [
  { label: "tasks", entrypoint: "task-scheduler-cli.ts", args: [], times: [], description: "每分钟读取本地任务配置，按时区和定时计划派发" },
];

const command = process.argv[2];
if (command === "migrate-tasks") {
  const directory = path.join(homedir(), "Library", "LaunchAgents");
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const sourceIndex = process.argv.indexOf("--from-workspace");
  const legacyWorkspace = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : projectRoot;
  if (!legacyWorkspace) throw new Error("--from-workspace requires a workspace path.");
  if (await migrateLegacySchedules(directory, domain, path.resolve(legacyWorkspace))) {
    const schedule = schedules[0]!;
    const label = "com.livermore.tasks";
    const filename = path.join(directory, `${label}.plist`);
    try { execFileSync("launchctl", ["bootout", domain, filename], { stdio: "ignore" }); } catch {}
    await writeFile(filename, plist(label, schedule), "utf8");
    execFileSync("launchctl", ["bootstrap", domain, filename], { stdio: "inherit" });
    console.log("已将本工作区的旧定时任务迁移为可配置调度。");
  }
} else if (command !== "install" && command !== "uninstall") {
  console.error("Usage: npm run scheduler -- <install|uninstall>");
  process.exitCode = 1;
} else {
  const directory = path.join(homedir(), "Library", "LaunchAgents");
  const domain = `gui/${process.getuid?.() ?? 501}`;
  if (command === "install" && process.env.LIVERMORE_DESKTOP !== "1") {
    try {
      await access(phoenixExecutable);
    } catch {
      throw new Error("Phoenix 尚未安装，请先运行：npm run phoenix -- install");
    }
  }
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(projectRoot, "data", "runtime"), { recursive: true });
  await migrateLegacySchedules(directory, domain);
  if (command === "uninstall" || process.env.LIVERMORE_DESKTOP !== "1" || await access(phoenixExecutable).then(() => true, () => false)) {
    await installPhoenixService(command, directory, domain);
  }
  await installWebService(command, directory, domain);
  await installFeishuService(command, directory, domain);
  for (const schedule of schedules) {
    const label = `com.livermore.${schedule.label}`;
    const filename = path.join(directory, `${label}.plist`);
    try {
      execFileSync("launchctl", ["bootout", domain, filename], { stdio: "ignore" });
    } catch { /* The job may not be loaded yet. */ }
    if (command === "uninstall") {
      await unlink(filename).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      console.log(`已移除 ${label}`);
      continue;
    }
    await writeFile(filename, plist(label, schedule), "utf8");
    execFileSync("launchctl", ["bootstrap", domain, filename], { stdio: "inherit" });
    console.log(`已安装 ${label}：${schedule.description}`);
  }
}

async function installFeishuService(command: "install" | "uninstall", directory: string, domain: string): Promise<void> {
  const label = "com.livermore.feishu";
  const filename = path.join(directory, `${label}.plist`);
  try {
    execFileSync("launchctl", ["bootout", domain, filename], { stdio: "ignore" });
  } catch { /* The service may not be loaded yet. */ }
  const config = loadConfig();
  if (command === "uninstall" || !config.feishuAppId || !config.feishuAppSecret) {
    await unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (command === "uninstall") console.log(`已移除 ${label}`);
    else console.log("未配置飞书应用凭据，跳过飞书长连接服务");
    return;
  }
  await writeFile(filename, feishuPlist(label), "utf8");
  execFileSync("launchctl", ["bootstrap", domain, filename], { stdio: "inherit" });
  console.log(`已安装 ${label}：飞书 Agent 长连接登录后自动启动并保持运行`);
}

function feishuPlist(label: string): string {
  const logs = path.join(projectRoot, "data", "runtime");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    ${nodeArgumentsXml("feishu-bot-cli.ts")}
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  ${runtimeEnvironmentXml()}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logs, "feishu.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, "feishu.error.log"))}</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

async function installWebService(command: "install" | "uninstall", directory: string, domain: string): Promise<void> {
  const label = "com.livermore.web";
  const filename = path.join(directory, `${label}.plist`);
  try {
    execFileSync("launchctl", ["bootout", domain, filename], { stdio: "ignore" });
  } catch { /* The service may not be loaded yet. */ }
  if (command === "uninstall") {
    await unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    console.log(`已移除 ${label}`);
    return;
  }
  await writeFile(filename, webPlist(label), "utf8");
  execFileSync("launchctl", ["bootstrap", domain, filename], { stdio: "inherit" });
  console.log(`已安装 ${label}：Agent Web 登录后自动启动并保持运行`);
}

function webPlist(label: string): string {
  const logs = path.join(projectRoot, "data", "runtime");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    ${nodeArgumentsXml("web-server.ts")}
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  ${runtimeEnvironmentXml()}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logs, "web.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, "web.error.log"))}</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

async function installPhoenixService(command: "install" | "uninstall", directory: string, domain: string): Promise<void> {
  const label = "com.livermore.phoenix";
  const filename = path.join(directory, `${label}.plist`);
  try {
    execFileSync("launchctl", ["bootout", domain, filename], { stdio: "ignore" });
  } catch { /* The service may not be loaded yet. */ }
  if (command === "uninstall") {
    await unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    console.log(`已移除 ${label}`);
    return;
  }
  await mkdir(phoenixDataDirectory, { recursive: true });
  await writeFile(filename, phoenixPlist(label), "utf8");
  execFileSync("launchctl", ["bootstrap", domain, filename], { stdio: "inherit" });
  console.log(`已安装 ${label}：登录后自动启动并保持运行`);
}

function phoenixPlist(label: string): string {
  const logs = path.join(projectRoot, "data", "runtime");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(phoenixExecutable)}</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PHOENIX_HOST</key><string>127.0.0.1</string>
    <key>PHOENIX_WORKING_DIR</key><string>${xml(phoenixDataDirectory)}</string>
    <key>PHOENIX_ALLOW_EXTERNAL_RESOURCES</key><string>false</string>
    <key>PHOENIX_TELEMETRY_ENABLED</key><string>false</string>
    <key>PHOENIX_DEFAULT_RETENTION_POLICY_DAYS</key><string>90</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logs, "phoenix.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, "phoenix.error.log"))}</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

function plist(label: string, schedule: Schedule): string {
  const logs = path.join(projectRoot, "data", "runtime");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    ${nodeArgumentsXml(schedule.entrypoint)}${schedule.args.map((argument) => `<string>${xml(argument)}</string>`).join("")}
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  ${runtimeEnvironmentXml()}
  ${schedule.times.length ? `<key>StartCalendarInterval</key><array>
    ${schedule.times.flatMap((time) => [1, 2, 3, 4, 5].map((weekday) => `<dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>${time.hour}</integer><key>Minute</key><integer>${time.minute}</integer></dict>`)).join("\n    ")}
  </array>` : "<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>"}
  <key>StandardOutPath</key><string>${xml(path.join(logs, `${schedule.label}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, `${schedule.label}.error.log`))}</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

function briefingSchedule(
  label: string,
  task: "market-briefing" | "ai-industry-chain",
  hour: number,
  minute: number,
): Schedule {
  return {
    label,
    entrypoint: "briefing-cli.ts",
    args: ["--task", task],
    times: [{ hour, minute }],
    description: `工作日 ${pad(hour)}:${pad(minute)}`,
  };
}

function nodeArgumentsXml(filename: string): string {
  return [process.execPath, ...nodeEntrypointArguments(filename)]
    .map((argument) => `<string>${xml(argument)}</string>`).join("");
}

function runtimeEnvironmentXml(): string {
  const environment: Record<string, string> = {
    LIVERMORE_WORKSPACE: projectRoot,
    LIVERMORE_RESOURCE_ROOT: resourceRoot,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of ["LIVERMORE_DESKTOP", "LIVERMORE_WEB_PORT", "LIVERMORE_WEB_UI_URL"]) {
    if (process.env[key]) environment[key] = process.env[key]!;
  }
  return `<key>EnvironmentVariables</key><dict>${Object.entries(environment)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

async function migrateLegacySchedules(directory: string, domain: string, legacyWorkspace = projectRoot): Promise<boolean> {
  let migrated = false;
  for (const label of ["market-pre", "ai-pre", "market-intraday", "market-close", "ai-close", "portfolio-risk"]) {
    const filename = path.join(directory, `com.livermore.${label}.plist`);
    const content = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!content) continue;
    const owner = execFileSync("/usr/bin/plutil", ["-extract", "WorkingDirectory", "raw", "-o", "-", filename], { encoding: "utf8" }).trim();
    if (owner !== legacyWorkspace) continue;
    try { execFileSync("launchctl", ["bootout", domain, filename], { stdio: "ignore" }); } catch {}
    const backup = path.join(projectRoot, "data", "runtime", "legacy-schedules");
    await mkdir(backup, { recursive: true });
    await rename(filename, path.join(backup, `${Date.now()}-${path.basename(filename)}`));
    migrated = true;
  }
  return migrated;
}
