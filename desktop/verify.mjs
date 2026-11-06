import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { importWorkspace, workspaceId, workspaceHasData } from './workspace.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'release', 'macos.noindex', 'Livermore.app', 'Contents', 'Resources', 'runtime');
await access(path.join(resources, 'src', 'web-server.js'));
const temporary = await mkdtemp(path.join(tmpdir(), 'livermore-desktop-check-'));
const source = path.join(temporary, 'source');
const workspace = path.join(temporary, 'workspace with spaces');
await mkdir(path.join(source, 'data', 'reports'), { recursive: true });
await writeFile(path.join(source, '.env'), 'TRACING_ENABLED=false\nTAVILY_MCP_ENABLED=false\n');
await writeFile(path.join(source, 'data', 'reports', 'example.md'), '# Historical report\n');
const database = new DatabaseSync(path.join(source, 'data', 'livermore.db'));
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE task_runs (id TEXT, status TEXT, finished_at TEXT, error_message TEXT, report_path TEXT);
  CREATE TABLE reports (path TEXT);
  CREATE TABLE task_locks (task TEXT);
`);
const reportPath = path.join(source, 'data', 'reports', 'example.md');
database.prepare('INSERT INTO task_runs VALUES (?, ?, NULL, NULL, ?)').run('old-run', 'running', reportPath);
database.prepare('INSERT INTO reports VALUES (?)').run(reportPath);
database.exec("INSERT INTO task_locks VALUES ('portfolio-risk-check')");
// Keep WAL connection open during import, matching a live CLI installation.
await importWorkspace(source, workspace, resources);
const imported = new DatabaseSync(path.join(workspace, 'data', 'livermore.db'), { readOnly: true });
assert.equal(imported.prepare('SELECT status FROM task_runs').get().status, 'failed');
assert.equal(imported.prepare('SELECT count(*) AS count FROM task_locks').get().count, 0);
assert.equal(imported.prepare('SELECT path FROM reports').get().path, path.join(workspace, 'data', 'reports', 'example.md'));
assert.equal(database.prepare('SELECT status FROM task_runs').get().status, 'running');
assert.match(await readFile(path.join(workspace, 'data', 'reports', 'example.md'), 'utf8'), /Historical report/);
await assert.rejects(importWorkspace(source, workspace, resources), /无法覆盖导入/);
database.close(); imported.close();
const emptyWorkspace = path.join(temporary, 'empty-desktop');
await mkdir(path.join(emptyWorkspace, 'data'), { recursive: true });
const empty = new DatabaseSync(path.join(emptyWorkspace, 'data', 'livermore.db'));
empty.exec('CREATE TABLE portfolio_positions (symbol TEXT)'); empty.close();
await writeFile(path.join(emptyWorkspace, '.env'), 'PI_PROVIDER=cursor\n');
assert.equal(await workspaceHasData(emptyWorkspace), false);
const importedEmpty = await importWorkspace(source, emptyWorkspace, resources);
assert.ok(importedEmpty.backupPath);
assert.equal(await readFile(path.join(importedEmpty.backupPath, '.env'), 'utf8'), 'PI_PROVIDER=cursor\n');
assert.equal(await workspaceHasData(emptyWorkspace), true);
const replaced = await importWorkspace(source, emptyWorkspace, resources, { replaceExisting: true });
assert.ok(replaced.backupPath);
assert.equal(await workspaceHasData(replaced.backupPath), true);
console.log('通过：在线 SQLite/WAL 导入、空库导入、报告路径迁移、锁清理、非空库保护及备份后替换。');

// Start the shipped runtime in a completely new workspace, outside the repository.
const cleanWorkspace = path.join(temporary, 'clean');
await mkdir(cleanWorkspace);
await writeFile(path.join(cleanWorkspace, '.env'), 'TRACING_ENABLED=false\nTAVILY_MCP_ENABLED=false\nMACOS_NOTIFICATIONS_ENABLED=false\nTASK_SCHEDULER_ENABLED=false\n');
const node = path.join(resources, 'bin', 'node');
// Exercise the shipped Pi extension loader and IPC host without global auth or tsx.
const cursorStatus = execFileSync(node, [path.join(resources, 'src', 'cursor-cli.js'), 'status'], {
  cwd: cleanWorkspace,
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LIVERMORE_WORKSPACE: cleanWorkspace, LIVERMORE_RESOURCE_ROOT: resources },
  encoding: 'utf8', timeout: 30_000,
});
assert.match(cursorStatus, /尚未登录/);
for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-schema']) {
  assert.equal(JSON.parse(await readFile(path.join(resources, 'node_modules', '@earendil-works', name, 'package.json'), 'utf8')).version, '1.5.0');
}
console.log('通过：打包 Pi 1.5.0、原生 Cursor 扩展加载和独立空授权状态。');
const host = spawn(node, [path.join(resources, 'desktop', 'runtime-host.mjs'), 'start', cleanWorkspace, resources], {
  cwd: cleanWorkspace,
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LIVERMORE_WORKSPACE: cleanWorkspace, LIVERMORE_RESOURCE_ROOT: resources },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
host.stdout.on('data', (chunk) => { output += chunk; });
host.stderr.on('data', (chunk) => { output += chunk; });
try {
  let ready = false;
  for (let index = 0; index < 60; index += 1) {
    try {
      const status = JSON.parse(await readFile(path.join(cleanWorkspace, 'data', 'runtime', 'desktop-status.json'), 'utf8'));
      if (status.error) throw new Error(status.error);
      if (status.ready) { ready = true; break; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (host.exitCode !== null) throw new Error(`Runtime exited: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(ready, `Runtime did not become ready: ${output}`);
  const health = await fetch('http://127.0.0.1:4311/api/health').then((response) => response.json());
  assert.equal(health.workspaceId, workspaceId(cleanWorkspace));
  const dashboard = await fetch('http://127.0.0.1:4311/api/dashboard').then((response) => response.json());
  assert.equal(dashboard.tasks.length, 3);
  const page = await fetch('http://127.0.0.1:4311/').then((response) => response.text());
  assert.match(page, /id="composer"/);
  const position = await fetch('http://127.0.0.1:4311/api/portfolio', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: '600519', quantity: 100, purchasedAt: '2026-11-06', costBasis: 1400 }),
  }).then((response) => response.json());
  assert.equal(position.symbol, '600519');
  assert.equal(position.quantity, 100);
  const taskUrl = 'http://127.0.0.1:4311/api/tasks/market-briefing/config';
  const task = await fetch(taskUrl).then((response) => response.json());
  assert.match(task.prompt, /\{\{sources\}\}/);
  const edited = { ...task, enabled: false, times: [{ time: '10:25', mode: 'intraday' }], prompt: task.prompt + '\n界面配置测试：重点观察风险。' };
  const savedResponse = await fetch(taskUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edited) });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.revision, 1); assert.equal(saved.enabled, false);
  assert.equal((await fetch(taskUrl).then((response) => response.json())).times[0].time, '10:25');
  const stale = await fetch(taskUrl, { method: 'PUT', body: JSON.stringify(edited) });
  assert.equal(stale.status, 409);
  const invalid = await fetch(taskUrl, { method: 'PUT', body: JSON.stringify({ ...saved, times: [{ time: '25:00', mode: 'close' }] }) });
  assert.equal(invalid.status, 400);
  const crossSite = await fetch(taskUrl, { method: 'PUT', headers: { Origin: 'https://example.com' }, body: JSON.stringify(saved) });
  assert.equal(crossSite.status, 403);
  const testDb = new DatabaseSync(path.join(cleanWorkspace, 'data', 'livermore.db'));
  testDb.prepare("INSERT INTO alerts (id, severity, title, body, status, created_at) VALUES (?, 'warning', '测试消息', '## 风险汇总\n\n仅测试本地消息中心。', 'pending', ?)").run('test-alert', new Date().toISOString());
  testDb.close();
  const inbox = await fetch('http://127.0.0.1:4311/api/notifications').then((response) => response.json());
  assert.equal(inbox.unreadCount, 1); assert.equal(inbox.messages[0].id, 'test-alert');
  const detail = await fetch('http://127.0.0.1:4311/api/notifications/test-alert').then((response) => response.json());
  assert.match(detail.body, /风险汇总/);
  assert.equal((await fetch('http://127.0.0.1:4311/api/notifications/test-alert/read', { method: 'POST' })).status, 200);
  assert.equal((await fetch('http://127.0.0.1:4311/api/notifications').then((response) => response.json())).unreadCount, 0);
  const template = await fetch('http://127.0.0.1:4311/api/tasks/template').then((response) => response.json());
  const createdResponse = await fetch('http://127.0.0.1:4311/api/tasks', { method: 'POST', body: JSON.stringify({ ...template, title: '独立研究测试' }) });
  assert.equal(createdResponse.status, 201);
  const custom = await createdResponse.json(); assert.equal(custom.enabled, false);
  assert.equal((await fetch('http://127.0.0.1:4311/api/dashboard').then((response) => response.json())).tasks.length, 4);
  assert.equal((await fetch(`http://127.0.0.1:4311/api/tasks/${custom.task}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:4311/api/tasks/${custom.task}/config`)).status, 404);
  const chat = await fetch('http://127.0.0.1:4311/api/chat/sessions', { method: 'POST' }).then((response) => response.json());
  const chatDb = new DatabaseSync(path.join(cleanWorkspace, 'data', 'livermore.db'));
  chatDb.prepare('UPDATE chat_sessions SET transcript_json = ?, title = ? WHERE id = ?').run(JSON.stringify([{ role: 'user', content: '历史会话测试' }, { role: 'assistant', content: [{ type: 'text', text: '历史回答保留' }] }, { role: 'toolResult', content: [{ type: 'text', text: '内部工具结果' }] }]), '历史会话测试', chat.id);
  chatDb.close();
  const nextChat = await fetch('http://127.0.0.1:4311/api/chat/sessions', { method: 'POST' }).then((response) => response.json());
  assert.notEqual(chat.id, nextChat.id);
  const history = await fetch('http://127.0.0.1:4311/api/chat/sessions').then((response) => response.json());
  assert.equal(history.sessions.length, 2);
  const restored = await fetch(`http://127.0.0.1:4311/api/chat/sessions/${chat.id}`).then((response) => response.json());
  assert.equal(restored.messages.length, 2); assert.match(restored.messages[1].text, /历史回答/);
  assert.equal((await fetch(`http://127.0.0.1:4311/api/chat/sessions/${chat.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:4311/api/chat/sessions/${chat.id}`)).status, 404);
  console.log('通过：新增/删除自定义研究任务、历史会话创建、恢复、工具上下文隐藏及显式删除。');
  console.log('通过：任务 Prompt/时间配置持久化、版本冲突、输入校验、跨站保护、消息详情与已读状态。');
  await assert.rejects(access(path.join(resources, '.env')));
  await assert.rejects(access(path.join(resources, 'data', 'livermore.db')));
  console.log('通过：安装包内置 Node、独立目录启动、三个任务、聊天页面、持仓写入、包内无用户数据。');
} finally {
  host.kill('SIGTERM');
  await new Promise((resolve) => { if (host.exitCode !== null) resolve(); else host.once('exit', resolve); });
}
console.log(`验证数据保留在 ${temporary}`);
