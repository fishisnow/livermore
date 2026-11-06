import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, mkdtemp, rename, symlink, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('macOS 安装包需要在 Mac 上构建。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const package_ = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const arch = process.arch;
const stagingRoot = path.join(root, 'build', 'macos.noindex');
await mkdir(stagingRoot, { recursive: true });
const staging = await mkdtemp(path.join(stagingRoot, 'package-'));
const app = path.join(staging, 'Livermore.app');
const contents = path.join(app, 'Contents');
const resources = path.join(contents, 'Resources');
const runtime = path.join(resources, 'runtime');
await mkdir(path.join(contents, 'MacOS'), { recursive: true });
await mkdir(path.join(runtime, 'bin'), { recursive: true });
await mkdir(path.join(runtime, 'desktop'), { recursive: true });

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} 执行失败 (${result.status})`);
}

console.log('正在编译 Livermore 后台…');
run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.desktop.json', '--outDir', path.join(runtime, 'src')]);
console.log('正在准备独立 Node 运行环境和依赖…');
await cp(process.execPath, path.join(runtime, 'bin', 'node'));
await chmod(path.join(runtime, 'bin', 'node'), 0o755);
const uv = spawnSync('/usr/bin/which', ['uv'], { encoding: 'utf8' });
if (uv.status === 0 && uv.stdout.trim()) {
  await cp(uv.stdout.trim(), path.join(runtime, 'bin', 'uv'), { dereference: true });
  await chmod(path.join(runtime, 'bin', 'uv'), 0o755);
}
for (const relative of ['package.json', 'package-lock.json', 'web', 'prompts', '.env.example', 'skills', 'node_modules']) {
  await cp(path.join(root, relative), path.join(runtime, relative), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !['.DS_Store', '__pycache__', '.cache'].includes(path.basename(source)) && !source.endsWith('.pyc'),
  });
}
for (const filename of ['runtime-host.mjs', 'workspace.mjs']) {
  await cp(path.join(root, 'desktop', filename), path.join(runtime, 'desktop', filename));
}
// Prune only the isolated app copy. No credentials, databases or Python envs are included.
run('npm', ['prune', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], runtime);

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Livermore</string>
<key>CFBundleDisplayName</key><string>Livermore</string>
<key>CFBundleIdentifier</key><string>com.livermore.desktop</string>
<key>CFBundleExecutable</key><string>Livermore</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${package_.version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>Livermore.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>Livermore · 本地投资研究 Agent</string>
</dict></plist>`;
await writeFile(path.join(contents, 'Info.plist'), plist);
const moduleCache = path.join(stagingRoot, 'swift-module-cache');
console.log('正在编译原生 macOS 窗口…');
run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-swift-version', '5', '-module-cache-path', moduleCache,
  '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
  path.join(root, 'desktop', 'Livermore.swift'), path.join(root, 'desktop', 'Notifications.swift'), '-o', path.join(contents, 'MacOS', 'Livermore')]);
const iconset = path.join(staging, 'Livermore.iconset');
await mkdir(iconset);
run('/usr/bin/xcrun', ['swift', '-module-cache-path', moduleCache, path.join(root, 'desktop', 'make-icon.swift'), iconset]);
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'Livermore.icns')]);
run('/usr/bin/plutil', ['-lint', path.join(contents, 'Info.plist')]);
run('/usr/bin/codesign', ['--force', '--sign', '-', path.join(runtime, 'bin', 'node')]);
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);

const release = path.join(root, 'release');
await mkdir(release, { recursive: true });
const appDirectory = path.join(release, 'macos.noindex');
await mkdir(appDirectory, { recursive: true });
const outputApp = path.join(appDirectory, 'Livermore.app');
try {
  await rename(outputApp, path.join(appDirectory, `Livermore-previous-${Date.now()}.app`));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await rename(app, outputApp);
if (!process.argv.includes('--app-only')) {
  const imageRoot = path.join(staging, 'image');
  await mkdir(imageRoot);
  await cp(outputApp, path.join(imageRoot, 'Livermore.app'), { recursive: true, verbatimSymlinks: true });
  await symlink('/Applications', path.join(imageRoot, 'Applications'));
  run('/usr/bin/hdiutil', ['create', '-volname', 'Livermore', '-srcfolder', imageRoot, '-ov', '-format', 'UDZO',
    path.join(release, `Livermore-${package_.version}-${arch}.dmg`)]);
}
console.log(`已生成 ${outputApp}`);
console.log('安装方式：打开 DMG，把 Livermore 拖入 Applications。');
// Keep generated app bundles out of Spotlight/LaunchServices after packaging.
await rm(staging, { recursive: true, force: true });
