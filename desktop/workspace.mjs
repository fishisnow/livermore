import { createHash } from 'node:crypto';
import { cp, mkdir, access, readFile, writeFile, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export function workspaceId(workspace) {
  return createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16);
}

export async function exists(filename) {
  return access(filename).then(() => true, () => false);
}

export async function prepareWorkspace(workspace, resources) {
  await mkdir(path.join(workspace, 'data', 'runtime'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(workspace, 'data', 'reports'), { recursive: true });
  if (!await exists(path.join(workspace, '.env'))) {
    await cp(path.join(resources, '.env.example'), path.join(workspace, '.env'));
    const { chmod } = await import('node:fs/promises');
    await chmod(path.join(workspace, '.env'), 0o600);
  }
  // Copy shipped skills only once; user-installed/edited skills survive updates.
  if (!await exists(path.join(workspace, 'skills'))) {
    await cp(path.join(resources, 'skills'), path.join(workspace, 'skills'), { recursive: true });
  }
}

export async function workspaceHasData(workspace) {
  const filename = path.join(workspace, 'data', 'livermore.db');
  if (!await exists(filename)) return false;
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (database.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get()) return true;
    }
    return false;
  } finally { database.close(); }
}

export async function importWorkspace(source, workspace, resources, options = {}) {
  source = path.resolve(source);
  workspace = path.resolve(workspace);
  if (source === workspace) throw new Error('请选择原 Livermore 项目目录。');
  if (await workspaceHasData(workspace) && !options.replaceExisting) {
    throw new Error('桌面版已有数据，无法覆盖导入。请在应用中选择“备份并导入”。');
  }
  if (!await exists(path.join(source, '.env')) || !await exists(path.join(source, 'data', 'livermore.db'))) {
    throw new Error('所选目录没有 .env 和 data/livermore.db，请选择 Livermore 项目根目录。');
  }
  const parent = path.dirname(workspace);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.livermore-import-'));
  try {
  const destination = path.join(staging, 'data', 'livermore.db');
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path.join(source, 'data', 'livermore.db'), { readOnly: true });
  try {
    // Online backup includes committed WAL pages, even while old services are running.
    await backup(database, destination);
  } finally {
    database.close();
  }
  const migrated = new DatabaseSync(destination);
  try {
    const oldPrefix = `${path.join(source, 'data', 'reports')}${path.sep}`;
    const newPrefix = `${path.join(workspace, 'data', 'reports')}${path.sep}`;
    for (const [table, column] of [['task_runs', 'report_path'], ['reports', 'path']]) {
      migrated.prepare(`UPDATE ${table} SET ${column} = ? || substr(${column}, ?) WHERE substr(${column}, 1, ?) = ?`)
        .run(newPrefix, oldPrefix.length + 1, oldPrefix.length, oldPrefix);
    }
    // The old process cannot own running tasks/locks in the new workspace.
    migrated.prepare("UPDATE task_runs SET status = 'failed', finished_at = ?, error_message = '导入桌面版时原任务尚未完成' WHERE status = 'running'")
      .run(new Date().toISOString());
    migrated.exec('DELETE FROM task_locks');
  } finally {
    migrated.close();
  }
  for (const relative of ['.env', 'data/reports', 'skills']) {
    if (await exists(path.join(source, relative))) {
      await cp(path.join(source, relative), path.join(staging, relative), { recursive: true });
    }
  }
  const { chmod } = await import('node:fs/promises');
  await chmod(path.join(staging, '.env'), 0o600);
  // Reuse existing local Python installs without copying non-relocatable virtualenvs.
  const environment = await readFile(path.join(staging, '.env'), 'utf8');
  const python = path.join(source, '.venv-futu', 'bin', 'python');
  if (!/^FUTU_PYTHON\s*=/m.test(environment) && await exists(python)) {
    await writeFile(path.join(staging, '.env'), `${environment.trimEnd()}\nFUTU_PYTHON=${JSON.stringify(python)}\n`, { mode: 0o600 });
  }
  await prepareWorkspace(staging, resources);
  await writeFile(path.join(staging, '.desktop-initialized'), '');
  let backupPath;
  if (await exists(workspace)) {
    const backupRoot = path.join(parent, `${path.basename(workspace)} Backups`);
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    backupPath = path.join(backupRoot, `${new Date().toISOString().replaceAll(':', '-')}-${randomSuffix()}`);
    await rename(workspace, backupPath);
  }
  try {
    await rename(staging, workspace);
  } catch (error) {
    if (backupPath) await rename(backupPath, workspace);
    throw error;
  }
  await writeFile(path.join(workspace, '.import-manifest.json'), JSON.stringify({
    source, importedAt: new Date().toISOString(), backupPath: backupPath ?? null,
  }), { mode: 0o600 });
  return { backupPath };
  } finally {
    // Only this operation's staging directory is removed; user data was renamed, not deleted.
    await rm(staging, { recursive: true, force: true });
  }
}

function randomSuffix() { return createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 6); }
