import { spawnSync } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("本地更新只支持 macOS。");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtApp = path.join(root, "release", "macos.noindex", "Livermore.app");
const installedApp = "/Applications/Livermore.app";
const withDmg = process.argv.includes("--dmg");
const skipOpen = process.argv.includes("--no-open");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} 执行失败 (${result.status})`);
}

function runningLivermore() {
  return spawnSync("/usr/bin/pgrep", ["-f", "/Applications/Livermore.app"]).status === 0;
}

console.log("正在退出 Livermore…");
spawnSync("/usr/bin/osascript", ["-e", 'tell application "Livermore" to quit']);
for (let attempt = 0; attempt < 20 && runningLivermore(); attempt += 1) await delay(250);
if (runningLivermore()) {
  spawnSync("/usr/bin/pkill", ["-f", "/Applications/Livermore.app"]);
  await delay(500);
}

console.log(withDmg ? "正在打包 Livermore.app 与 DMG…" : "正在打包 Livermore.app…");
run(process.execPath, [
  path.join(root, "desktop", "build-macos.mjs"),
  ...(withDmg ? [] : ["--app-only"]),
]);

await access(builtApp);
console.log("正在安装到 /Applications/Livermore.app…");
await rm(installedApp, { recursive: true, force: true });
run("/usr/bin/ditto", [builtApp, installedApp]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", installedApp]);

if (!skipOpen) {
  console.log("正在打开 Livermore…");
  run("/usr/bin/open", [installedApp]);
}

console.log("本地应用已更新：/Applications/Livermore.app");
if (withDmg) console.log("DMG 已生成到 release/ 目录。");
