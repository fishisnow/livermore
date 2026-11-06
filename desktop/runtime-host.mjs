import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { exists, prepareWorkspace, importWorkspace, workspaceId } from './workspace.mjs';

const [command, workspace, resources, ...args] = process.argv.slice(2);
if (!command || !workspace || !resources) throw new Error('Missing desktop runtime arguments.');
await prepareWorkspace(workspace, resources);
const port = 4311;
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  LIVERMORE_WORKSPACE: workspace,
  LIVERMORE_RESOURCE_ROOT: resources,
  LIVERMORE_DESKTOP: '1',
  LIVERMORE_WEB_PORT: String(port),
  LIVERMORE_WEB_UI_URL: origin,
  PATH: [path.join(resources, 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
};
const children = new Set();
const statusFile = path.join(workspace, 'data', 'runtime', 'desktop-status.json');
const logFile = path.join(workspace, 'data', 'runtime', 'desktop.log');
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const waits = [...children].map((process_) => new Promise((resolve) => {
    process_.once('exit', resolve);
    process_.kill('SIGTERM');
  }));
  const timeout = setTimeout(() => {
    for (const process_ of children) process_.kill('SIGKILL');
    process.exit(code);
  }, 5_000);
  await Promise.all(waits);
  clearTimeout(timeout);
  process.exit(code);
}
// Register before launching anything so quitting during startup cannot leave orphans.
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());

function child(filename, arguments_ = []) {
  const log = openSync(logFile, 'a', 0o600);
  const process_ = spawn(process.execPath, [path.join(resources, 'src', filename), ...arguments_], {
    cwd: workspace, env, stdio: ['ignore', log, log],
  });
  closeSync(log);
  children.add(process_);
  process_.on('exit', () => children.delete(process_));
  process_.on('error', (error) => { children.delete(process_); console.error(error.message); });
  return process_;
}

async function healthy() {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(800) });
    const value = await response.json();
    if (value.service === 'livermore-agent-web' && value.workspaceId === workspaceId(workspace)) return true;
    throw new Error('桌面端口 4311 已被其他服务占用，请先退出另一个 Livermore 实例。');
  } catch (error) {
    if (error.message.includes('4311')) throw error;
    return false;
  }
}

async function runCli(filename, arguments_ = []) {
  const process_ = child(filename, arguments_);
  await new Promise((resolve, reject) => {
    process_.on('error', reject);
    process_.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`操作失败，请查看 ${logFile}`)));
  });
}

async function importWhileServicesPaused(source, options) {
  const paused = [];
  const domain = `gui/${process.getuid()}`;
  const databasePath = path.join(workspace, 'data', 'livermore.db');
  if (await exists(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const locks = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_locks'").get();
      if (locks && database.prepare('SELECT 1 FROM task_locks WHERE expires_at > ? LIMIT 1').get(new Date().toISOString())) {
        throw new Error('桌面版仍有研究任务运行，请等待任务完成后再导入。');
      }
    } finally { database.close(); }
  }
  try {
    for (const label of ['com.livermore.web', 'com.livermore.feishu']) {
      const plist = path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      if (!await exists(plist)) continue;
      const directory = spawnSync('/usr/bin/plutil', ['-extract', 'WorkingDirectory', 'raw', '-o', '-', plist], { encoding: 'utf8' });
      if (directory.status !== 0 || directory.stdout.trim() !== workspace) continue;
      if (spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }).status !== 0) continue;
      execFileSync('/bin/launchctl', ['bootout', domain, plist], { stdio: 'ignore' });
      paused.push(plist);
    }
    await importWorkspace(source, workspace, resources, options);
  } finally {
    for (const plist of paused) execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' });
  }
}

try {
  if (command === 'import') {
    await importWhileServicesPaused(args[0], { replaceExisting: args.includes('--replace-existing') });
  } else if (command === 'cursor') {
    if (!['login', 'status', 'models', 'logout', 'verify'].includes(args[0])) throw new Error('未知 Cursor 操作。');
    await runCli('cursor-cli.js', args);
  } else if (command === 'enable-background' || command === 'disable-background') {
    await runCli('scheduler-cli.js', [command === 'enable-background' ? 'install' : 'uninstall']);
  } else if (command === 'setup') {
    const uv = path.join(resources, 'bin', 'uv');
    const executable = await exists(uv) ? uv : 'uv';
    const setupEnvironment = {
      ...env,
      UV_CACHE_DIR: path.join(workspace, 'data', 'runtime', 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: path.join(workspace, '.python'),
    };
    const log = openSync(logFile, 'a', 0o600);
    try {
      for (const [directory, packages] of [['.venv-phoenix', ['arize-phoenix']], ['.venv-futu', ['futu-api']]]) {
        const venv = path.join(workspace, directory);
        execFileSync(executable, ['venv', '--python', '3.12', venv], { env: setupEnvironment, stdio: ['ignore', log, log] });
        execFileSync(executable, ['pip', 'install', '--python', path.join(venv, 'bin', 'python'), ...packages], {
          env: setupEnvironment, stdio: ['ignore', log, log],
        });
      }
      // Existing .env settings keep precedence. New installs use the dedicated SDK env.
      const { readFile } = await import('node:fs/promises');
      const filename = path.join(workspace, '.env');
      const content = await readFile(filename, 'utf8');
      const setting = `FUTU_PYTHON=${JSON.stringify(path.join(workspace, '.venv-futu', 'bin', 'python'))}`;
      await writeFile(filename, /^FUTU_PYTHON\s*=/m.test(content)
        ? content.replace(/^FUTU_PYTHON\s*=.*$/m, setting)
        : `${content.trimEnd()}\n${setting}\n`, { mode: 0o600 });
    } finally { closeSync(log); }
  } else if (command === 'start') {
    // One-time migration only touches legacy jobs that belong to this workspace.
    await runCli('scheduler-cli.js', ['migrate-tasks']);
    child('task-scheduler-cli.js', ['--watch']);
    const parent = process.ppid;
    setInterval(() => { if (process.ppid !== parent) shutdown(); }, 10_000);
    await writeFile(statusFile, JSON.stringify({ ready: false }));
    let backend;
    if (!await healthy()) {
      backend = child('web-server.js');
      // Optional services must not prevent the chat interface from opening.
      const phoenix = path.join(workspace, '.venv-phoenix', 'bin', 'phoenix');
      const traceRunning = await fetch('http://127.0.0.1:6006/', { signal: AbortSignal.timeout(800) }).then(() => true, () => false);
      if (!traceRunning && await exists(phoenix)) child('phoenix-cli.js', ['start']);
      Object.assign(process.env, env);
      const { loadConfig } = await import(path.join(resources, 'src', 'config.js'));
      const config = loadConfig();
      const existingFeishu = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/com.livermore.feishu`], { stdio: 'ignore' }).status === 0;
      if (!existingFeishu && config.feishuAppId && config.feishuAppSecret) child('feishu-bot-cli.js');
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await healthy()) {
        await writeFile(statusFile, JSON.stringify({ ready: true, url: origin }));
        break;
      }
      if (backend?.exitCode !== null && backend?.exitCode !== undefined) throw new Error(`本地服务启动失败，请查看 ${logFile}`);
      if (attempt === 119) throw new Error(`本地服务启动超时，请查看 ${logFile}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => {
      backend?.once('exit', async () => {
        await writeFile(statusFile, JSON.stringify({ ready: false, error: '本地服务已退出，可从菜单重新连接。' }));
        if (!stopping) shutdown(1);
      });
    });
  } else {
    throw new Error(`Unknown desktop command: ${command}`);
  }
} catch (error) {
  for (const process_ of children) process_.kill('SIGTERM');
  await writeFile(statusFile, JSON.stringify({ ready: false, error: error.message }));
  console.error(error.message);
  process.exitCode = 1;
}
