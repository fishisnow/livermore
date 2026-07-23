import { execFileSync } from "node:child_process";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { phoenixDataDirectory, phoenixExecutable, projectRoot } from "./project-paths.js";

interface Schedule {
  label: string;
  task: "market-briefing" | "ai-industry-chain";
  hour: number;
  minute: number;
}

const schedules: Schedule[] = [
  { label: "market-pre", task: "market-briefing", hour: 8, minute: 30 },
  { label: "ai-pre", task: "ai-industry-chain", hour: 8, minute: 45 },
  { label: "market-intraday", task: "market-briefing", hour: 12, minute: 0 },
  { label: "market-close", task: "market-briefing", hour: 16, minute: 10 },
  { label: "ai-close", task: "ai-industry-chain", hour: 17, minute: 0 },
];

const command = process.argv[2];
if (command !== "install" && command !== "uninstall") {
  console.error("Usage: npm run scheduler -- <install|uninstall>");
  process.exitCode = 1;
} else {
  const directory = path.join(homedir(), "Library", "LaunchAgents");
  const domain = `gui/${process.getuid?.() ?? 501}`;
  if (command === "install") {
    try {
      await access(phoenixExecutable);
    } catch {
      throw new Error("Phoenix 尚未安装，请先运行：npm run phoenix -- install");
    }
  }
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(projectRoot, "data", "runtime"), { recursive: true });
  await installPhoenixService(command, directory, domain);
  await installWebService(command, directory, domain);
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
    console.log(`已安装 ${label}：工作日 ${pad(schedule.hour)}:${pad(schedule.minute)}`);
  }
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
  const server = path.join(projectRoot, "src", "web-server.ts");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string><string>--import</string><string>tsx</string><string>${xml(server)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
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
  const cliPath = path.join(projectRoot, "src", "briefing-cli.ts");
  const logs = path.join(projectRoot, "data", "runtime");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string><string>--import</string><string>tsx</string>
    <string>${xml(cliPath)}</string><string>--task</string><string>${schedule.task}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>StartCalendarInterval</key><array>
    ${[1, 2, 3, 4, 5].map((weekday) => `<dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>${schedule.hour}</integer><key>Minute</key><integer>${schedule.minute}</integer></dict>`).join("\n    ")}
  </array>
  <key>StandardOutPath</key><string>${xml(path.join(logs, `${schedule.label}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, `${schedule.label}.error.log`))}</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
