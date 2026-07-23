import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { projectRoot } from "./project-paths.js";

const launcher = path.join(projectRoot, "bin", "livermore.mjs");
const commandDirectory = path.join(homedir(), ".local", "bin");
const commandPath = path.join(commandDirectory, "livermore");

try {
  await mkdir(commandDirectory, { recursive: true });
  await chmod(launcher, 0o755);
  await installLink();
  console.log(`系统命令已安装：${commandPath}`);

  const result = spawnSync(process.execPath, [launcher, "install"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function installLink(): Promise<void> {
  try {
    const stat = await lstat(commandPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${commandPath} 已存在且不是符号链接，未覆盖该文件。`);
    }
    const existing = await readlink(commandPath);
    const resolved = path.resolve(path.dirname(commandPath), existing);
    if (resolved !== launcher) {
      throw new Error(`${commandPath} 已指向其他程序：${resolved}`);
    }
    return;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
  await symlink(launcher, commandPath);
}
