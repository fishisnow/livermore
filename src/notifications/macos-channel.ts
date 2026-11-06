import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resourceRoot } from "../project-paths.js";

export interface MacosNotification { id: string; title: string; body: string; severity: string; runId: string | null }
export function notificationPreview(body: string, limit = 360): string {
  const heading = body.search(/^#{1,6}\s+\S/m);
  const content = heading >= 0 ? body.slice(heading) : body;
  return content.split("\n").filter((line) => !/^(?:运行 ID|Trace ID|模式|新增来源|评估|source-coverage|source-citations|disclaimer|structure-coverage)[:：]/i.test(line)).join("\n").replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^[#>\s|*-]+/gm, "").replace(/[|`*_]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export async function sendMacosNotification(input: MacosNotification): Promise<void> {
  const executable = [path.resolve(resourceRoot, "../../MacOS/Livermore"), "/Applications/Livermore.app/Contents/MacOS/Livermore"].find((candidate) => existsSync(candidate));
  if (process.platform !== "darwin" || !executable) throw new Error("安装 Livermore macOS 应用后可启用系统通知；消息已保存在本地。");
  await new Promise<void>((resolve, reject) => {
    // Payload goes over stdin, not command-line arguments or a shell script.
    const child = spawn(executable, ["--notification-stdin"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let error = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("macOS 通知投递超时。")); }, 12_000);
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(0, 4000); });
    child.stderr.on("data", (chunk) => { error = (error + chunk).slice(0, 1000); });
    child.on("error", (value) => { clearTimeout(timer); reject(value); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output) as { ok: boolean; error?: string };
        if (code !== 0 || !result.ok) throw new Error(result.error || "macOS 通知投递失败。");
        resolve();
      } catch (value) { reject(value instanceof SyntaxError ? new Error(error || "macOS 通知服务返回异常。") : value); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...input, body: notificationPreview(input.body) }));
  });
}
